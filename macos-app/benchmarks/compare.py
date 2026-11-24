#!/usr/bin/env python3
"""Read-only paired aggregate measurements. Never emits captured text or titles."""
import argparse
import base64
import hashlib
import collections
import datetime as dt
import json
import math
import pathlib
import re
import sqlite3
import statistics
import subprocess
import time

ROOT = pathlib.Path(__file__).resolve().parent
COAST = pathlib.Path.home() / 'Library/Application Support/inc.attention.rem'


def summary(values):
    values = sorted(values)
    if not values:
        return {'n': 0}
    return {'n': len(values), 'min': values[0], 'median': statistics.median(values),
            'p95': values[min(len(values)-1, math.ceil(.95*len(values))-1)],
            'max': values[-1], 'mean': statistics.mean(values)}


def tokens(text):
    return set(re.findall(r'\w+', text.casefold()))


def file_size(path):
    try:
        return path.stat().st_size
    except (FileNotFoundError, PermissionError):
        return None



def read_metadata(bundle, executable):
    paths = [p for p in (bundle/'observation.json', bundle/'observation.lsm') if p.exists()]
    if len(paths) != 1:
        raise ValueError('metadata-file-count')
    path = paths[0]
    if path.suffix == '.lsm':
        decoded = subprocess.check_output([str(executable), 'decode-metadata', '--input', str(path)], timeout=20)
        return path, json.loads(decoded)
    return path, json.loads(path.read_text())


def retained_images(store, selected, executable):
    """Logical asset bytes, with shared segments and lossless ancestors counted once.

    This checks reference accounting, not image decodability or video checksums.
    Proportional bytes allocate a segment evenly over its distinct referenced ordinals;
    pending lossless dependencies are retained in full, never charged as new captures.
    """
    root = store.resolve()
    metadata = {path.parent: (path, record) for path, record in selected}
    selected_paths = {r['imageFile'] for _, r in selected if r.get('imageFile')}
    pending, references, dependency_metadata, cleanup = {}, {}, {}, {}
    videos = {}
    resolved = set()
    missing = 0
    errors = collections.Counter()

    def within(relative):
        if not isinstance(relative, str) or not relative or pathlib.Path(relative).is_absolute():
            raise ValueError('invalid-relative-path')
        path = root/relative
        if '..' in pathlib.Path(relative).parts or not path.resolve().is_relative_to(root):
            raise ValueError('invalid-relative-path')
        return path

    def inspect(relative, ancestors):
        if relative in ancestors or len(ancestors) > 30:
            raise ValueError('dependency-cycle-or-depth')
        if relative in resolved:
            return
        image = within(relative)
        bundle = image.parent
        if bundle not in metadata:
            metadata[bundle] = read_metadata(bundle, executable)
        meta_path, record = metadata[bundle]
        if record.get('imageFile') != relative:
            raise ValueError('metadata-image-mismatch')
        if relative not in selected_paths:
            dependency_metadata[meta_path] = meta_path.stat().st_size
        sidecar = bundle/'image.archive'
        reference = None
        if sidecar.exists():
            if sidecar.stat().st_size > 32 * 1024:
                raise ValueError('oversized-archive-reference')
            entry = json.loads(sidecar.read_text())
            if not isinstance(entry, dict):
                raise ValueError('invalid-archive-reference')
            if (entry.get('imagePath') != relative or record.get('imageReference') or
                base64.b64decode(entry['metadataSHA256'], validate=True) != hashlib.sha256(meta_path.read_bytes()).digest()):
                raise ValueError('archive-metadata-mismatch')
            reference = entry['reference']
            references[sidecar] = sidecar.stat().st_size
            if image.exists():
                cleanup[image] = image.stat().st_size
        elif image.name == 'image.video':
            if image.stat().st_size > 16 * 1024:
                raise ValueError('oversized-archive-reference')
            reference = json.loads(image.read_text())
            references[image] = image.stat().st_size
        if reference is not None:
            segment = within(reference['segment'])
            count, ordinal = reference['frameCount'], reference['ordinal']
            if type(count) is not int or count <= 0 or type(ordinal) is not int or not 0 <= ordinal < count:
                raise ValueError('invalid-video-allocation')
            size = segment.stat().st_size
            previous = videos.setdefault(segment, {'bytes': size, 'count': count, 'ordinals': set()})
            if previous['count'] != count or previous['bytes'] != size:
                raise ValueError('inconsistent-video-allocation')
            previous['ordinals'].add(ordinal)
        else:
            pending[relative] = image.stat().st_size
            if record.get('imageReference'):
                inspect(record['imageReference'], ancestors | {relative})
        resolved.add(relative)

    for relative in sorted(selected_paths):
        try:
            inspect(relative, set())
        except FileNotFoundError:
            missing += 1; errors['missing-file'] += 1
        except PermissionError:
            missing += 1; errors['unreadable-file'] += 1
        except (ValueError, KeyError, TypeError, subprocess.SubprocessError):
            missing += 1; errors['invalid-reference-or-metadata'] += 1
    pending_selected = sum(size for path, size in pending.items() if path in selected_paths)
    pending_ancestors = sum(size for path, size in pending.items() if path not in selected_paths)
    referenced_video = sum(v['bytes'] for v in videos.values())
    proportional_video = sum(v['bytes'] * len(v['ordinals']) / v['count'] for v in videos.values())
    return {'pending_image_bytes': pending_selected,
            'pending_image_dependency_bytes': pending_ancestors,
            'pending_image_dependency_closure_bytes': pending_selected + pending_ancestors,
            'dependency_metadata_bytes': sum(dependency_metadata.values()),
            'archive_reference_bytes': sum(references.values()),
            'superseded_pending_image_bytes': sum(cleanup.values()),
            'referenced_video_bytes': referenced_video,
            'proportional_video_bytes': proportional_video,
            'referenced_video_segments': len(videos),
            'referenced_video_frames': sum(len(v['ordinals']) for v in videos.values()),
            'referenced_image_bytes': referenced_video + pending_selected + pending_ancestors,
            'proportional_image_bytes': proportional_video + pending_selected + pending_ancestors,
            'missing_asset_references_at_measurement': missing,
            'asset_accounting_errors': dict(errors)}


def tree_bytes(root):
    logical = allocated = count = 0
    inodes = set()
    if root.exists():
        for path in root.rglob('*'):
            if path.is_file() and not path.is_symlink():
                try:
                    stat = path.stat()
                except FileNotFoundError:
                    continue
                logical += stat.st_size
                key = (stat.st_dev, stat.st_ino)
                if key not in inodes:
                    allocated += stat.st_blocks * 512
                    inodes.add(key)
                count += 1
    return {'files': count, 'unique_inodes': len(inodes), 'logical_bytes': logical, 'allocated_bytes': allocated}


def disk_totals(own):
    return {'coast_frames': tree_bytes(COAST/'frames'),
            'coast_videos': tree_bytes(COAST/'videos'),
            'coast_db': {n: file_size(COAST/n) for n in ('rem.db', 'rem.db-wal', 'rem.db-shm')},
            'own_store': tree_bytes(own)}


def cadence(rows, start, end):
    ts = sorted(set(r['t'] for r in rows))
    return {'distinct_capture_instants': len(ts),
            'inter_capture_seconds': summary([b-a for a,b in zip(ts,ts[1:])]),
            'intervals_above_3_seconds': sum(b-a > 3 for a,b in zip(ts,ts[1:])),
            'first_offset_seconds': ts[0]-start if ts else None,
            'last_to_window_end_seconds': end-ts[-1] if ts else None}


def seconds(value):
    return value/1000 if isinstance(value,(float,int)) else dt.datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()


def acquisition_durations(records, key=None):
    values=[]
    for record in records:
        item=record.get(key) if key else record
        if item and item.get('capturedAt') is not None and item.get('capturedUntil') is not None:
            values.append(seconds(item['capturedUntil'])-seconds(item['capturedAt']))
    return summary(values)


def main():
    global COAST, ROOT
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=pathlib.Path, required=True)
    parser.add_argument('--coast-store', type=pathlib.Path, default=COAST)
    parser.add_argument('--own-store', type=pathlib.Path,
                        default=pathlib.Path.home()/'Library/Application Support/Lifestream Screen')
    parser.add_argument('--own-executable', type=pathlib.Path, default=pathlib.Path.home()/'Applications/Lifestream.app/Contents/MacOS/Lifestream')
    parser.add_argument('--baseline', action='store_true')
    parser.add_argument('--allow-partial', action='store_true')
    parser.add_argument('--output', type=pathlib.Path)
    args = parser.parse_args()
    COAST = args.coast_store
    ROOT = args.directory
    window = json.loads((ROOT/'window.json').read_text())
    start,end = window['start'],window['end']
    if args.baseline:
        result = {'measured_at': time.time(), 'window': window, 'sizes': disk_totals(args.own_store)}
        path = args.output or ROOT/'storage-baseline.json'
        path.write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps({'baseline_saved': str(path), 'measured_at': result['measured_at']}))
        return
    if time.time() < end and not args.allow_partial:
        raise SystemExit('Window not complete; run after its end or use --allow-partial.')
    c = sqlite3.connect((COAST/'rem.db').as_uri()+'?mode=ro',uri=True,timeout=5)
    c.row_factory=sqlite3.Row
    c.execute('PRAGMA query_only=ON')
    c.execute('BEGIN')
    raw = c.execute('''SELECT f.id,f.timestamp,f.foreground,f.background,f.is_inactive,
        f.video,f.image_path,f.width,f.height,f.ax_root_hash,f.segment,
        a.bundle_id,ax.frame_id AS snapshot_id,ax.is_partial_tree,ax.extraction_mode,
        v.path AS video_path,v.num_frames,
        (SELECT count(*) FROM window_bound w WHERE w.frame=f.id) AS windows
        FROM frame f LEFT JOIN segment s ON s.id=f.segment
        LEFT JOIN application a ON a.id=s.application
        LEFT JOIN ax_snapshot ax ON ax.frame_id=f.id
        LEFT JOIN video v ON v.id=f.video
        WHERE f.timestamp>=? AND f.timestamp<? ORDER BY f.timestamp,f.id''',
        (start*1000,end*1000)).fetchall()
    coast=[]
    videos=collections.Counter()
    image_bytes=[]
    pending_assets={}
    missing_assets=0
    for r in raw:
        text='\n'.join(x for x in (r['foreground'],r['background']) if x)
        coast.append({'t':r['timestamp']/1000,'app':r['bundle_id'],'tokens':tokens(text),
                      'text_chars':len(text)})
        if r['video'] is not None:
            videos[r['video']]+=1
        elif r['image_path']:
            p=pathlib.Path(r['image_path'])
            p=p if p.is_absolute() else COAST/'frames'/p
            size=file_size(p)
            if size is None: missing_assets+=1
            else:
                image_bytes.append(size)
                pending_assets[p] = size
        else: missing_assets+=1
    video_bytes=0
    proportional_video_bytes=0
    for vid,count in videos.items():
        r=next(x for x in raw if x['video']==vid)
        p=pathlib.Path(r['video_path'])
        p=p if p.is_absolute() else COAST/'videos'/p
        size=file_size(p)
        if size is None: missing_assets+=count
        else:
            video_bytes+=size
            if r['num_frames']>0: proportional_video_bytes+=size*count/r['num_frames']
    ax_storage=c.execute('''SELECT count(*),coalesce(sum(length(n.payload)),0)
        FROM ax_node n JOIN frame f ON f.id=n.first_seen_frame_id
        WHERE f.timestamp>=? AND f.timestamp<?''',(start*1000,end*1000)).fetchone()
    c.rollback()
    c.close()
    own=[]
    all_own=[]
    selected_metadata=[]
    own_bytes=own_image_bytes=0
    incomplete=0
    days={dt.datetime.fromtimestamp(x,dt.timezone.utc).date().isoformat() for x in (start,end)}
    for day in days:
        for bundle in (args.own_store/day).glob('*'):
            if not bundle.is_dir(): continue
            paths = [p for p in (bundle/'observation.json', bundle/'observation.lsm') if p.exists()]
            if len(paths) != 1:
                if bundle.name.startswith('.'): incomplete+=1; continue
                raise ValueError('Expected exactly one metadata file per committed bundle')
            path = paths[0]
            if path.parent.name.startswith('.'):
                incomplete+=1
                continue
            path, record = read_metadata(bundle, args.own_executable)
            stamp=record['capturedAt']
            stamp=stamp/1000 if isinstance(stamp,(float,int)) else dt.datetime.fromisoformat(stamp.replace('Z','+00:00')).timestamp()
            if not start<=stamp<end: continue
            all_own.append(record)
            selected_metadata.append((path, record))
            own_bytes+=path.stat().st_size
            if record.get('imageFile'):
                image=args.own_store/record['imageFile']
                size=file_size(image)
                if size is not None:
                    own_image_bytes+=size
                    own_bytes+=size
            if record['status'] not in ('captured','unchanged','cached-idle'): continue
            text='\n'.join(o['text'] for o in record.get('ocr',[]))
            own.append({'t':stamp,'app':(record.get('application') or {}).get('bundleID'),
                        'tokens':tokens(text),'text_chars':len(text), 'display':record['displayID']})
    image_storage = retained_images(args.own_store, selected_metadata, args.own_executable)
    own.sort(key=lambda x:x['t'])
    available=set(range(len(own)))
    pairs=[]
    for a in coast:
        nearby=[i for i in available if abs(own[i]['t']-a['t'])<=1.1]
        if not nearby: continue
        index=min(nearby,key=lambda i:abs(own[i]['t']-a['t']))
        available.remove(index)
        pairs.append((a,own[index]))
    same=[(a,b) for a,b in pairs if a['app'] and b['app'] and a['app'].casefold()==b['app'].casefold()]
    scored=[(a,b) for a,b in same if a['tokens'] and b['tokens']]
    jaccard=[len(a['tokens']&b['tokens'])/len(a['tokens']|b['tokens']) for a,b in scored]
    coverage=[len(a['tokens']&b['tokens'])/len(a['tokens']) for a,b in scored]
    reverse=[len(a['tokens']&b['tokens'])/len(b['tokens']) for a,b in scored]
    result={'window':window,'measured_at':time.time(),
        'coast':{'frames':len(raw),**cadence(coast,start,end),
            'ocr_nonempty_frames':sum(bool(x['tokens']) for x in coast),
            'ocr_characters':summary([x['text_chars'] for x in coast]),
            'ax_snapshot_frames':sum(r['snapshot_id'] is not None for r in raw),
            'ax_partial_frames':sum(bool(r['is_partial_tree']) for r in raw),
            'ax_modes':dict(collections.Counter(r['extraction_mode'] for r in raw if r['snapshot_id'] is not None)),
            'focus_known_frames':sum(bool(r['bundle_id']) for r in raw),
            'distinct_focus_apps':len(set(r['bundle_id'] for r in raw if r['bundle_id'])),
            'inactive_frames':sum(bool(r['is_inactive']) for r in raw),
            'window_count':summary([r['windows'] for r in raw]),
            'unfinalized_still_frames':sum(r['video'] is None for r in raw),
            'stored_dimensions':dict(collections.Counter(str(r['width'])+'x'+str(r['height']) for r in raw)),
            'pending_image_bytes':sum(image_bytes),'referenced_video_bytes':video_bytes,
            'proportional_video_bytes':proportional_video_bytes,
            'referenced_image_bytes':sum(pending_assets.values())+video_bytes,
            'proportional_image_bytes':sum(pending_assets.values())+proportional_video_bytes,
            'missing_asset_references_at_measurement':missing_assets,
            'ocr_logical_utf8_bytes':sum(len((r[column] or '').encode('utf-8')) for r in raw for column in ('foreground','background')),
            'new_ax_nodes':ax_storage[0],'new_ax_payload_bytes':ax_storage[1]},
        'own':{'observations':len(all_own),'frames':len(own),**cadence(own,start,end),
            'status_counts':dict(collections.Counter(r['status'] for r in all_own)),
            'new_complete_observations':sum(r['status']=='captured' for r in all_own),
            'unchanged_image_observations':sum(r['status']=='unchanged' for r in all_own),
            'cached_idle_image_observations':sum(r['status']=='cached-idle' for r in all_own),
            'gap_reasons':dict(collections.Counter(r.get('reason','unspecified') for r in all_own if r['status'] not in ('captured','unchanged','cached-idle'))),
            'ocr_status_counts':dict(collections.Counter(r.get('ocrStatus','unknown') for r in all_own)),
            'ocr_nonempty_frames':sum(bool(x['tokens']) for x in own),
            'ocr_characters':summary([x['text_chars'] for x in own]),
            'ax_status_counts':dict(collections.Counter((r.get('accessibility') or {}).get('status','absent') for r in all_own)),
            'ax_nonempty_frames':sum(bool((r.get('accessibility') or {}).get('nodes')) for r in all_own),
            'ax_nodes_per_frame':summary([len((r.get('accessibility') or {}).get('nodes',[])) for r in all_own if r['status'] in ('captured','unchanged','cached-idle')]),
            'ax_duration_seconds':summary([(r['accessibility']['capturedUntil']-r['accessibility']['capturedAt'])/1000 for r in all_own
                if r.get('accessibility') and isinstance(r['accessibility'].get('capturedUntil'),(int,float))]),
            'focus_known_frames':sum(bool(x['app']) for x in own),
            'distinct_displays':len(set(x['display'] for x in own)),
            'stored_dimensions':dict(collections.Counter(str(r['width'])+'x'+str(r['height']) for r in all_own if r['status'] in ('captured','unchanged','cached-idle'))),
            'acquisition_duration_seconds':acquisition_durations(all_own),
            'ax_acquisition_duration_seconds':acquisition_durations(all_own,'accessibility'),
            'ax_start_after_image_seconds':summary([(r['accessibility']['capturedAt']-r['capturedUntil'])/1000 for r in all_own
                if r.get('accessibility') and isinstance(r['accessibility'].get('capturedAt'),(int,float))
                and isinstance(r.get('capturedUntil'),(int,float))]),
            'committed_bundle_bytes':own_bytes,
            'committed_bundle_bytes_basis':'legacy selected metadata and original image files still present; excludes archive assets and dependencies',
            'selected_original_image_file_bytes':own_image_bytes,
            'image_bytes':image_storage['referenced_image_bytes'],
            'image_bytes_basis':'alias of referenced_image_bytes: unique full video segments plus pending lossless dependency closure; not window allocation',
            **image_storage},
        'paired':{'max_time_difference_seconds':1.1,'temporal_pairs':len(pairs),'same_known_focus_app_pairs':len(same),
            'different_known_focus_app_pairs':sum(bool(a['app']) and bool(b['app']) and a['app']!=b['app'] for a,b in pairs),
            'unknown_focus_app_pairs':sum(not a['app'] or not b['app'] for a,b in pairs),
            'focus_pair_matrix':[{'coast_bundle_id':a,'own_bundle_id':b,'pairs':n} for (a,b),n in collections.Counter((a['app'],b['app']) for a,b in pairs).items()],'app_match_policy':'case-insensitive provider comparison; stored identifiers unchanged',
            'exact_case_focus_app_pairs':sum(bool(a['app']) and a['app']==b['app'] for a,b in pairs),
            'different_known_focus_app_pairs':sum(bool(a['app']) and bool(b['app']) and a['app'].casefold()!=b['app'].casefold() for a,b in pairs),
            'unknown_focus_app_pairs':sum(not a['app'] or not b['app'] for a,b in pairs),
            'focus_pair_counts':dict(collections.Counter((a['app'] or 'unknown')+' -> '+(b['app'] or 'unknown') for a,b in pairs)),
            'nonempty_ocr_same_app_pairs':len(scored),'time_difference_seconds':summary([abs(a['t']-b['t']) for a,b in pairs]),
            'ocr_token_jaccard_agreement':summary(jaccard),'coast_tokens_present_in_own':summary(coverage),
            'own_tokens_present_in_coast':summary(reverse)},
        'limitations':['Agreement is not accuracy; neither recorder is ground truth.',
            'Coast foreground/background text scope and our full-display OCR can differ.',
            'Near-time same-app pairs do not establish identical display or window content.',
            'Focus disagreement is not evidence that either recorder is correct; session attribution lag and capture timing can differ.',
            'Acquisition duration is capturedUntil minus capturedAt; it is not durable-write latency or isolated OCR time.',
            'Pending images can be compacted concurrently; filesystem and SQLite snapshots are not atomic together.',
            'Both providers expose referenced_image_bytes (whole referenced assets) and proportional_image_bytes (video apportioned by frame count). Compare like-named fields, never referenced totals with proportional allocation.',
            'Proportional video bytes are allocated by frame count, not measured per-frame encoded size. Own allocation deduplicates segment ordinals.',
            'Own pending lossless images include their dependency closure even outside the window; these necessary ancestors are retained in full, not proportionally assigned. Metadata, archive references and superseded pending files are reported separately.',
            'Own image_bytes now aliases archive-aware referenced_image_bytes; selected_original_image_file_bytes preserves the old image_bytes meaning. committed_bundle_bytes remains the legacy selected-file measure.',
            'Asset accounting checks reference binding, existence and allocation denominators; it does not decode images or validate video content checksums.',
            'Own frames includes captured, unchanged and cached-idle image-backed observations; separate counts distinguish them. Cached-idle has no new callback for that request, so image-backed cadence is not fresh acquisition coverage.',
            'Coast OCR logical UTF-8 bytes count foreground/background column values once per selected row; not SQLite physical allocation, indexes, compression or incremental disk growth. Do not add to physical database deltas.',
            'Disk totals may include compaction and unrelated frames outside this observation window.']}
    result['sizes_at_measurement']=disk_totals(args.own_store)
    baseline=ROOT/'storage-baseline.json'
    if baseline.exists():
        base=json.loads(baseline.read_text())
        result['storage_baseline_measured_at']=base['measured_at']
        result['storage_baseline_sizes']=base['sizes']
    path=args.output or ROOT/'comparison.json'
    path.write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps({'comparison_saved': str(path)}))

if __name__=='__main__': main()
