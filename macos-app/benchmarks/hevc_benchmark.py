#!/usr/bin/env python3
"""Manual hardware HEVC diagnostic. All working artifacts must remain outside the repo.
Build helper against the release CaptureCore and CaptureStorage modules;
  see benchmarks/README.md. Output: /private/tmp/hevc-quality-helper
Run: python3 hevc_benchmark.py --window /external/window.json --output /external/results
"""
import argparse
import json
from pathlib import Path
import resource
import subprocess
import tempfile
import time


def run(command, timeout=300):
    before = resource.getrusage(resource.RUSAGE_CHILDREN); start = time.monotonic()
    result = subprocess.run(command, capture_output=True, timeout=timeout)
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    if result.returncode:
        raise RuntimeError('subprocess-failed')
    return result.stdout, {'wallSeconds': time.monotonic()-start,
        'childCPUSeconds': after.ru_utime+after.ru_stime-before.ru_utime-before.ru_stime}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--window',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--store',type=Path,default=Path.home()/'Library/Application Support/Lifestream Screen')
    parser.add_argument('--helper',type=Path,default=Path('/private/tmp/hevc-quality-helper'))
    parser.add_argument('--frames',type=int,default=60)
    args=parser.parse_args()
    repo=Path(__file__).resolve().parents[2]
    if args.output.resolve().is_relative_to(repo) or not 20<=args.frames<=60:
        raise ValueError('external-output-and-20-to-60-frames-required')
    window=json.loads(args.window.read_text())
    if time.time()<window['end']: raise ValueError('window-not-finished')
    args.output.mkdir(parents=True,exist_ok=True)
    ffmpeg='/opt/homebrew/bin/ffmpeg'; ffprobe='/opt/homebrew/bin/ffprobe'
    report={'lossy':True,'qualities':[50,75,95], 'encoder':'hevc_videotoolbox', 'softwareFallbackAllowed':False,
        'limitations':['Encoding timings include child process startup and raw input/file IO, exclude preparation, Vision scoring and fsync durability.',
        'Hardware engine energy is not represented by child CPU seconds; this is not total recorder cost.',
        'Native dimensions retained, but sRGB conversion, alpha flattening, YUV subsampling and HEVC quantization are lossy.',
        'Sampled chronological subset is encoded at 0.5fps, not original wall-time spacing.',
        'Selected source artifact bytes exclude reference ancestors; they are not a standalone lossless baseline.',
        'OCR agreement uses full original-image Vision as a reference, not ground truth.'], 'candidates':[]}
    baseline, timing = run([str(args.helper), 'baseline', str(args.store), str(args.window), str(args.frames)], timeout=600)
    report['losslessBaseline'] = json.loads(baseline)
    report['baselineIncludingSourceReadCost'] = timing
    with tempfile.TemporaryDirectory(prefix='working-',dir=args.output) as temporary:
        working=Path(temporary)
        preparation,timing=run([str(args.helper),'prepare',str(args.store),str(args.window),temporary,str(args.frames)],timeout=600)
        report['preparation']=json.loads(preparation);report['preparationCost']=timing
        w,h=report['preparation']['width'],report['preparation']['height']
        selected=report['preparation']['selectedIndexes']
        for quality in report['qualities']:
            video=args.output/f'hevc-q{quality}.mov'
            candidate={'quality':quality}
            report['candidates'].append(candidate)
            try:
                _,timing=run([ffmpeg,'-hide_banner','-loglevel','error','-y','-f','rawvideo','-pixel_format','bgra',
                    '-video_size',f'{w}x{h}','-framerate','1/2','-i',str(working/'source.bgra'),'-an',
                    '-c:v','hevc_videotoolbox','-allow_sw','0','-realtime','0','-q:v',str(quality),
                    '-g','30','-bf','0','-tag:v','hvc1','-pix_fmt','yuv420p',str(video)])
                candidate['encode']=timing;candidate['bytes']=video.stat().st_size
                probe,_=run([ffprobe,'-v','error','-show_entries','stream=width,height,pix_fmt,codec_name,nb_frames,color_space,color_transfer,color_primaries',
                    '-of','json',str(video)])
                streams=json.loads(probe)['streams'];candidate['streams']=streams
                if len(streams)!=1 or streams[0]['width']!=w or streams[0]['height']!=h:
                    raise RuntimeError('decoded-dimensions-mismatch')
                if int(streams[0].get('nb_frames',-1))!=report['preparation']['frames']:
                    raise RuntimeError('encoded-frame-count-mismatch')
                decoded=working/'decoded.bgra'
                select='+'.join(f'eq(n\\,{index})' for index in selected)
                _,timing=run([ffmpeg,'-hide_banner','-loglevel','error','-y','-i',str(video),'-vf','select='+select,
                    '-fps_mode','vfr','-f','rawvideo','-pix_fmt','bgra',str(decoded)])
                candidate['decodeSelectedFrames']=timing
                scores,timing=run([str(args.helper),'score',temporary,str(decoded)],timeout=600)
                candidate['ocr']=json.loads(scores);candidate['ocrScoringCost']=timing
                candidate['status']='measured'
                decoded.unlink()
            except (RuntimeError,OSError,ValueError,subprocess.SubprocessError):
                candidate['status']='failed'
            (args.output/'report.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps({'completedCandidates':sum(c['status']=='measured' for c in report['candidates']),
                      'failedCandidates':sum(c['status']=='failed' for c in report['candidates'])}))


if __name__=='__main__':
    try: main()
    except (RuntimeError,OSError,ValueError,KeyError,subprocess.SubprocessError):
        raise SystemExit('HEVC benchmark failed; check external paths and available helper/codec tools.')
