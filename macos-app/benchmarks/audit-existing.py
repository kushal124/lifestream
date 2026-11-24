#!/usr/bin/env python3
"""Read-only retrospective audit. Captured text stays in process memory.

Run with python -i to inspect aligned samples without writing private captures.
The packet reader validates checksums; it is diagnostic, not a production reader.
"""
import argparse
import bisect
import collections
import ctypes
import datetime as dt
import hashlib
import json
import math
from pathlib import Path
import re
import sqlite3
import statistics
import struct
import subprocess
import unicodedata

def instant(value):
    return value / 1000 if isinstance(value, (float, int)) else dt.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()

def summary(values):
    a = sorted(values)
    return {} if not a else dict(n=len(a), min=a[0], median=statistics.median(a), p95=a[math.ceil(len(a)*.95)-1], max=a[-1], mean=statistics.mean(a))

def words(text):
    return set(re.findall(r'\w+', unicodedata.normalize('NFKC', text).casefold()))

lib = ctypes.CDLL('/usr/lib/libcompression.dylib')
lib.compression_decode_buffer.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.c_int]
lib.compression_decode_buffer.restype = ctypes.c_size_t

def decode(path):
    b = path.read_bytes()
    if path.suffix == '.json': return json.loads(b)
    assert b[:8] == b'LSMETA01' and len(b) >= 50
    assert hashlib.sha256(b[:-32]).digest() == b[-32:]
    raw, packed = struct.unpack_from('<II', b, 9)
    assert 0 < raw <= 16*1024*1024 and len(b) == packed + 49
    payload = b[17:-32]
    if b[8] == 0:
        assert len(payload) == raw
        return json.loads(payload)
    assert b[8] == 1
    out = ctypes.create_string_buffer(raw + 1)
    n = lib.compression_decode_buffer(out, raw+1, payload, len(payload), None, 0x801)
    assert n == raw
    return json.loads(out.raw[:raw])

def nearest(rows, times, t):
    i = bisect.bisect_left(times, t)
    candidates = [k for k in (i-1, i) if 0 <= k < len(rows)]
    return min(candidates, key=lambda k: abs(times[k]-t)) if candidates else None

def read_coast(path, start, end):
    db = sqlite3.connect(path.as_uri()+'?mode=ro', uri=True, timeout=10)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA query_only=ON')
    rows = [dict(r) for r in db.execute('''SELECT f.id, f.timestamp, f.width, f.height,
      f.is_inactive, f.video, f.image_path, f.segment,
      a.bundle_id AS app, ax.is_partial_tree, ax.root_hash,
      length(f.foreground) AS foreground_chars, length(f.background) AS background_chars
      FROM frame f LEFT JOIN segment s ON s.id=f.segment
      LEFT JOIN application a ON a.id=s.application
      LEFT JOIN ax_snapshot ax ON ax.frame_id=f.id
      WHERE f.timestamp>=? AND f.timestamp<? ORDER BY f.timestamp, f.id''', (start*1000,end*1000))]
    db.close()
    for r in rows: r['t'] = r['timestamp']/1000; r['app'] = (r['app'] or '').lower()
    return rows

def content_audit(args, pairs):
    unique={}
    for c,o in pairs:
        if c['is_inactive'] or c['app']!=o['app']: continue
        previous=unique.get(o['path'])
        if previous is None or abs(c['t']-o['t'])<abs(previous[0]['t']-o['t']): unique[o['path']]=(c,o)
    groups=collections.defaultdict(list)
    for c,o in unique.values(): groups[c['app']].append((c,o))
    db=sqlite3.connect(args.coast_db.as_uri()+'?mode=ro',uri=True,timeout=10)
    db.execute('PRAGMA query_only=ON')
    scores=[]; samples=[]
    for app,group in sorted(groups.items(), key=lambda kv:-len(kv[1])):
        group.sort(key=lambda pair:pair[0]['t'])
        sample_count=min(100 if len(group)>1000 else 20,len(group))
        selection=set(round(i*(len(group)-1)/(sample_count-1)) for i in range(sample_count)) if sample_count>1 else {0}
        for i,(c,o) in enumerate(group):
            r=decode(o['path']); ax=r.get('accessibility') or {}
            native='\n'.join(x['text'] for x in r.get('ocr',[])); own=words(native)
            fg,bg=db.execute('SELECT foreground,background FROM frame WHERE id=?',(c['id'],)).fetchone()
            ct=words('\n'.join(x for x in (fg,bg) if x)); common=len(ct&own)
            score=dict(id=c['id'],path=o['path'],t=c['t'],app=app,offset=abs(c['t']-o['t']),coast_words=len(ct),own_words=len(own),
                forward=common/len(ct) if ct else None,reverse=common/len(own) if own else None,
                own_ax=o['ax'],idle=o['idle'],own_ocr=o['ocr'])
            scores.append(score)
            if i in selection:
                samples.append(dict(id=c['id'],app=app,ocr=native,ax='\n'.join(n.get('text','') or '' for n in ax.get('nodes',[])),status=o['ax']))
        print(json.dumps({'ocr_compared_app':app,'pairs':len(group)}),flush=True)
    db.close()
    byapp={}
    for app in groups:
        eligible=[s for s in scores if s['app']==app and s['coast_words']>=20 and s['own_words']>=20]
        byapp[app]=dict(pairs=len(groups[app]),eligible=len(eligible),coast_words_in_own=summary([s['forward'] for s in eligible]),
            own_words_in_coast=summary([s['reverse'] for s in eligible]),
            empty_own_with_nonempty_coast=sum(s['app']==app and s['coast_words']>0 and s['own_words']==0 for s in scores))
    print(json.dumps({'ocr_comparison':byapp},indent=2),flush=True)
    response=subprocess.check_output(['npx','tsx',str(Path(__file__).with_name('audit-existing-ax.ts'))],
        input=json.dumps({'database':str(args.coast_db),'samples':samples}).encode())
    ax_scores=json.loads(response)
    ax_report={}
    for app in groups:
        a=[s for s in ax_scores if s['app']==app]
        ax_report[app]={'samples':len(a),'errors':sum('error' in s for s in a),
            **{key:summary([s[key] for s in a if key in s and s[key] is not None]) for key in [
                'coast_nodes','coast_hidden','coast_ax_in_own_ax','coast_ax_in_own_union','coast_union_in_own_union','coast_ocr_in_own_union','own_ocr_in_coast_union']}}
    print(json.dumps({'ax_comparison':ax_report},indent=2),flush=True)
    return scores,ax_scores,byapp,ax_report

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--own-store',type=Path,required=True)
    p.add_argument('--coast-db',type=Path,required=True)
    p.add_argument('--since',required=True)
    p.add_argument('--until',required=True)
    p.add_argument('--executable',type=Path,required=True)
    args=p.parse_args()
    start,end=instant(args.since),instant(args.until)
    rows=[]; errors=collections.Counter(); day_counts=collections.Counter()
    verified=False
    for day in sorted(args.own_store.iterdir()):
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}',day.name): continue
        if not args.since[:10] <= day.name <= args.until[:10]: continue
        for bundle in day.iterdir():
            if bundle.name.startswith('.'): errors['incomplete_directory']+=1; continue
            paths=[f for f in (bundle/'observation.lsm',bundle/'observation.json') if f.exists()]
            if len(paths)!=1: errors['metadata_file_count']+=1; continue
            path=paths[0]
            try:
                r=decode(path)
                t=instant(r['capturedAt'])
                if not start<=t<end: continue
                if not verified and path.suffix=='.lsm':
                    native=json.loads(subprocess.check_output([str(args.executable),'decode-metadata','--input',str(path)]))
                    assert native==r
                    verified=True
                ax=r.get('accessibility') or {}; acq=r.get('acquisition') or {}; nodes=ax.get('nodes',[])
                side=bundle/'image.archive'; ref=None
                if side.exists():
                    entry=json.loads(side.read_text()); ref=entry['reference']
                    import base64
                    assert base64.b64decode(entry['metadataSHA256'])==hashlib.sha256(path.read_bytes()).digest()
                image=r.get('imageFile'); img=args.own_store/image if image else None
                missing=bool(image and not (img.exists() or (ref and (args.own_store/ref['segment']).exists())))
                item=dict(t=t,path=path,status=r['status'],reason=r.get('reason'),app=(r.get('application') or {}).get('bundleID','').lower(),
                    dims=(r['width'],r['height']),ocr=r.get('ocrStatus'),ocr_n=len(r.get('ocr',[])),
                    ax=ax.get('status'),ax_n=len(nodes),limits=ax.get('limitReasons',[]),
                    idle=r.get('inputIdleSeconds'),backend=acq.get('backend'),freshness=acq.get('freshness'),
                    source_age=acq.get('sourceDisplayAgeSeconds'),
                    duration=instant(r['capturedUntil'])-t if r.get('capturedUntil') else None,
                    ax_delay=instant(ax['capturedAt'])-t if ax.get('capturedAt') else None,
                    ax_duration=instant(ax['capturedUntil'])-instant(ax['capturedAt']) if ax.get('capturedUntil') else None,
                    structured=sum(any(k in n for k in ['title','value','enabled','visible']) for n in nodes),
                    metadata_bytes=path.stat().st_size,archive=ref,missing=missing)
                rows.append(item); day_counts[day.name]+=1
            except Exception as e: errors[type(e).__name__]+=1
        print(json.dumps({'loaded_day':day.name,'observations':day_counts[day.name],'errors':dict(errors)}),flush=True)
    rows.sort(key=lambda r:r['t']); images=[r for r in rows if r['status'] in ('captured','unchanged','cached-idle')]
    times=[r['t'] for r in images]; all_times=[r['t'] for r in rows]
    coast=read_coast(args.coast_db,start,end)
    pairs=[]; missing=[]
    by_dimensions=collections.defaultdict(list)
    for o in images: by_dimensions[o['dims']].append(o)
    dimension_times={key:[o['t'] for o in group] for key,group in by_dimensions.items()}
    for c in coast:
        key=(c['width'],c['height']); group=by_dimensions.get(key,[])
        i=nearest(group,dimension_times.get(key,[]),c['t']); o=group[i] if i is not None else None
        if o is not None and abs(o['t']-c['t'])<=1.5: pairs.append((c,o))
        else: missing.append(c)
    active=[c for c in coast if not c['is_inactive']]
    active_pairs=[(c,o) for c,o in pairs if not c['is_inactive']]
    missing_reasons=collections.Counter()
    for c in missing:
        if c['is_inactive']: continue
        i=nearest(rows,all_times,c['t']); r=rows[i] if i is not None else None
        missing_reasons[r['reason'] or r['status'] if r and abs(r['t']-c['t'])<=3 else 'no-near-observation']+=1
    movie_paths=set(r['archive']['segment'] for r in rows if r['archive'])
    report=dict(window=dict(since=args.since,until=args.until),decoder_crosscheck=verified,errors=dict(errors),
        observations=len(rows),images=len(images),statuses=dict(collections.Counter(r['status'] for r in rows)),
        gaps=dict(collections.Counter(r['reason'] for r in rows if r['status']=='gap')),
        backends=dict(collections.Counter(r['backend'] for r in images)),freshness=dict(collections.Counter(r['freshness'] for r in images)),
        ocr=dict(collections.Counter(r['ocr'] for r in images)),ax=dict(collections.Counter(r['ax'] for r in images)),
        ax_limits=dict(collections.Counter(x for r in images for x in r['limits'])),
        ax_nodes=summary([r['ax_n'] for r in images]),structured_node_frames=sum(r['structured']>0 for r in images),
        durations={key:summary([r[key] for r in images if r[key] is not None]) for key in ['duration','ax_delay','ax_duration','source_age']},
        missing_images=sum(r['missing'] for r in rows),archived_images=sum(bool(r['archive']) for r in rows),movies=len(movie_paths),
        movie_bytes=sum((args.own_store/f).stat().st_size for f in movie_paths),metadata_bytes=sum(r['metadata_bytes'] for r in rows),
        coast_frames=len(coast),coast_active=len(active),coast_active_ax=sum(bool(c['root_hash']) for c in active),
        matched_active=len(active_pairs),same_app_active=sum(c['app']==o['app'] for c,o in active_pairs),
        active_unmatched_reasons=dict(missing_reasons),
        per_day={day:dict(own=sum(dt.datetime.fromtimestamp(r['t'],dt.timezone.utc).date().isoformat()==day for r in images),coast_active=sum(dt.datetime.fromtimestamp(c['t'],dt.timezone.utc).date().isoformat()==day for c in active)) for day in day_counts})
    print(json.dumps(report,indent=2),flush=True)
    scores,ax_scores,ocr_report,ax_report=content_audit(args,pairs)
    return locals()

if __name__=='__main__': globals().update(main())
