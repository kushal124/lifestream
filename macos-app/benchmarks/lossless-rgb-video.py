#!/usr/bin/env python3
"""Manual offline RGB codec diagnostic; standard library plus installed FFmpeg.
Usage: python3 lossless-rgb-video.py /external/inputs.json /external/output-directory
Creates private temporary RGB/video artifacts in output directory; never repository.
No capture or source mutation. Execute only outside coordinated live benchmarks.
"""
import argparse
import json
import os
import resource
import subprocess
import time
from pathlib import Path

FFMPEG = "/opt/homebrew/bin/ffmpeg"
FFPROBE = "/opt/homebrew/bin/ffprobe"

def stamp():
    own = resource.getrusage(resource.RUSAGE_SELF)
    child = resource.getrusage(resource.RUSAGE_CHILDREN)
    return time.monotonic(), own.ru_utime + own.ru_stime, child.ru_utime + child.ru_stime

def elapsed(start):
    end = stamp()
    return dict(wallMilliseconds=(end[0]-start[0])*1000,
                parentCPUMilliseconds=(end[1]-start[1])*1000,
                childCPUMilliseconds=(end[2]-start[2])*1000,
                totalCPUMilliseconds=((end[1]-start[1])+(end[2]-start[2]))*1000)

def run(args, output=None):
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=output or subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=180)
    if result.returncode:
        raise RuntimeError("external-codec-failure")
    return result.stdout

def same_bytes(a, b):
    if a.stat().st_size != b.stat().st_size:
        return False
    with a.open("rb") as x, b.open("rb") as y:
        while True:
            left, right = x.read(1024*1024), y.read(1024*1024)
            if left != right:
                return False
            if not left:
                return True

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs")
    parser.add_argument("output")
    args = parser.parse_args()
    inputs = json.loads(Path(args.inputs).read_text())
    if not isinstance(inputs, list) or not 1 <= len(inputs) <= 20:
        raise RuntimeError("invalid-input-count")
    destination = Path(args.output).resolve()
    repository = Path(__file__).resolve().parents[2]
    if destination == repository or repository in destination.parents:
        raise RuntimeError("private-output-must-be-outside-repository")
    destination.mkdir(parents=True, exist_ok=False, mode=0o700)
    raw = destination / "source.rgb"
    start = stamp()
    geometry = None
    png_bytes = 0
    source_formats = set()
    with raw.open("xb") as stream:
        for item in inputs:
            path = Path(item["path"])
            if path.suffix.lower() != ".png":
                raise RuntimeError("input-not-png")
            info = json.loads(run([FFPROBE, "-v", "error", "-select_streams", "v:0",
                                   "-show_entries", "stream=width,height,pix_fmt", "-of", "json", str(path)]))
            video = info["streams"][0]
            if video["pix_fmt"] not in ["rgb24", "rgba", "bgra", "bgr24", "rgb0", "bgr0"]:
                raise RuntimeError("unsupported-source-pixel-format")
            size = video["width"], video["height"]
            if not all(isinstance(x, int) and x > 0 for x in size) or size[0]*size[1]*4 > 256*1024*1024:
                raise RuntimeError("invalid-image-dimensions")
            if geometry is not None and size != geometry:
                raise RuntimeError("mixed-dimensions")
            geometry = size
            source_formats.add(video["pix_fmt"])
            png_bytes += path.stat().st_size
            run([FFMPEG, "-v", "error", "-nostdin", "-i", str(path), "-frames:v", "1",
                 "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"], output=stream)
    preparation = elapsed(start)
    width, height = geometry
    if raw.stat().st_size != width*height*3*len(inputs):
        raise RuntimeError("unexpected-prepared-length")
    results = []
    for preset in ["ultrafast", "superfast", "veryfast"]:
        video = destination / (preset + ".mkv")
        decoded = destination / (preset + ".rgb")
        start = stamp()
        run([FFMPEG, "-v", "error", "-nostdin", "-f", "rawvideo", "-pixel_format", "rgb24",
             "-video_size", f"{width}x{height}", "-framerate", "1/2", "-i", str(raw),
             "-frames:v", str(len(inputs)), "-an", "-c:v", "libx264rgb", "-pix_fmt", "rgb24",
             "-preset", preset, "-tune", "zerolatency", "-qp", "0", "-threads", "1", "-g", "30", "-bf", "0",
             "-x264-params", "scenecut=0", "-f", "matroska", str(video)])
        encoding = elapsed(start)
        start = stamp()
        run([FFMPEG, "-v", "error", "-nostdin", "-threads", "1", "-i", str(video),
             "-map", "0:v:0", "-vsync", "0", "-pix_fmt", "rgb24", "-f", "rawvideo", str(decoded)])
        decoding = elapsed(start)
        start = stamp()
        exact = same_bytes(raw, decoded)
        verification = elapsed(start)
        if not exact:
            raise RuntimeError("rgb-reconstruction-mismatch")
        results.append(dict(preset=preset, bytes=video.stat().st_size, encode=encoding,
                            decode=decoding, exactRGBFrames=len(inputs), verification=verification))
        decoded.unlink()
    report = dict(frames=len(inputs), width=width, height=height, sourcePixelFormats=sorted(source_formats),
                  pngBytes=png_bytes, rawRGBBytes=raw.stat().st_size, preparation=preparation, results=results,
                  scope="Exact equality of FFmpeg-decoded RGB24 input and decoded libx264rgb output, original dimensions, no YUV conversion requested. Does not preserve or verify original alpha, row padding, provider layout, ICC/profile metadata or source PNG bytes. RGB value equality alone does not establish complete color-managed screenshot equivalence. Encode/decode include child process startup, file IO and mux/demux; CPU includes parent+children; original PNG decoding reported separately. One thread, key interval30, zerolatency tune, no B frames or scene-cut keyframes requested. Container checksums/integrity equivalent to FrameCodec are NOT included. No direct sparse-XOR cost equivalence claimed.")
    (destination / "report.json").write_text(json.dumps(report, indent=2, sort_keys=True)+"\n")
    print(json.dumps(report, indent=2, sort_keys=True))

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        message = str(error) if type(error) is RuntimeError else type(error).__name__
        print(json.dumps({"error": message}))
        raise SystemExit(1)
