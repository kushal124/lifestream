#!/usr/bin/env python3
"""Read-only literal evidence score for a completed 300-second synthetic fixture.

Question schema: {"questions":[{"id":"...","question":"...","evidence":
[{"phase":"before","answers":["literal synthetic answer"]}, ...]}]}.
All answers in one requirement must occur in one eligible sample; separate requirements
must each succeed in their declared phase. Nothing is inferred by a model.
"""
from __future__ import annotations
import argparse
import collections
import datetime as dt
import json
import math
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
from fixture_score import seconds


def normalize(value):
    return " ".join(value.split())


def contains(text, answer):
    return re.search(r"(?<!\w)" + re.escape(normalize(answer)) + r"(?!\w)", normalize(text)) is not None


def own_image_reference(record):
    return isinstance(record.get("imageFile"), str) and bool(record["imageFile"].strip())


def coast_image_reference(image_path, video, video_index):
    still = isinstance(image_path, str) and bool(image_path.strip())
    movie = isinstance(video, str) and bool(video.strip()) and isinstance(video_index, int) and not isinstance(video_index, bool) and video_index >= 0
    return still or movie


def score_channel(rows, questions, events, start, end, field):
    result = []
    for question in questions:
        requirements = []
        for requirement in question["evidence"]:
            phase = requirement["phase"]
            intervals = []
            for index, event in enumerate(events):
                if event["phase"] != phase:
                    continue
                stop = events[index+1]["at"] if index+1 < len(events) else end
                lower, upper = max(start, event["at"]+2), min(end, stop-2)
                eligible = [row for row in rows if lower < row["at"] < upper and not row.get("gap") and row.get("imageReferencePresent", False)]
                matches = [row for row in eligible if all(contains(row.get(field, ""), answer) for answer in requirement["answers"])]
                intervals.append({"eventIndex": index, "eligibleSeconds": max(0, upper-lower),
                    "eligibleSamples": len(eligible), "matchingSamples": len(matches),
                    "cachedIdleSamples": sum(r.get("status") == "cached-idle" for r in eligible),
                    "cachedIdleMatches": sum(r.get("status") == "cached-idle" for r in matches),
                    "imageStatusCounts": dict(collections.Counter(r.get("status", "provider-not-reported") for r in eligible)),
                    "firstDelaySeconds": min((r["at"]-event["at"] for r in matches), default=None)})
            requirements.append({"phase": phase, "expectedAnswers": requirement["answers"],
                "eventPresent": bool(intervals), "literalEvidenceFound": any(i["matchingSamples"] for i in intervals),
                "eligibleSamples": sum(i["eligibleSamples"] for i in intervals),
                "matchingSamples": sum(i["matchingSamples"] for i in intervals), "events": intervals})
        result.append({"id": question["id"], "allRequiredPhaseEvidenceFound": all(r["literalEvidenceFound"] for r in requirements),
            "requirements": requirements})
    return {"available": True, "questions": result,
        "questionsWithAllRequiredEvidence": sum(q["allRequiredPhaseEvidenceFound"] for q in result), "questionCount": len(result)}


def validate_questions(document):
    questions = document["questions"]
    if not questions or len({q["id"] for q in questions}) != len(questions):
        raise ValueError("invalid-questions")
    for question in questions:
        if not question["evidence"]:
            raise ValueError("empty-requirements")
        for requirement in question["evidence"]:
            if not isinstance(requirement["phase"], str) or not requirement["answers"] or any(not isinstance(a,str) or not normalize(a) for a in requirement["answers"]):
                raise ValueError("invalid-answer")
    return questions


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--questions", type=Path, default=Path(__file__).parent/"fixture/practical-questions.json")
    parser.add_argument("--events", type=Path)
    parser.add_argument("--coast-db", type=Path, default=Path.home()/"Library/Application Support/inc.attention.rem/rem.db")
    parser.add_argument("--own-store", type=Path, default=Path.home()/"Library/Application Support/Lifestream Screen")
    parser.add_argument("--own-executable", type=Path, default=Path.home()/"Applications/Lifestream.app/Contents/MacOS/Lifestream")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.self_test:
        self_test(); print("Synthetic practical recall checks passed."); return
    if args.directory is None: raise ValueError("directory-required")
    window = json.loads((args.directory/"window.json").read_text())
    start,end = float(window["start"]),float(window["end"])
    if not math.isfinite(start+end) or abs(end-start-300)>0.01 or time.time()<end:
        raise ValueError("completed-300-second-window-required")
    questions = validate_questions(json.loads(args.questions.read_text()))
    events = sorted(json.loads((args.events or args.directory/"fixture-events.json").read_text()), key=lambda e:e["at"])
    if not events or len({e["at"] for e in events}) != len(events) or any(not math.isfinite(e["at"]) or not isinstance(e["phase"],str) for e in events):
        raise ValueError("invalid-events")
    events = [e for e in events if e["at"] < end]
    connection = sqlite3.connect(args.coast_db.resolve().as_uri()+"?mode=ro", uri=True, timeout=5)
    try:
        connection.execute("PRAGMA query_only=ON"); connection.execute("BEGIN")
        coast = [{"at": at/1000, "ocr":"\n".join(p for p in (foreground,background) if p),
            "imageReferencePresent": coast_image_reference(image_path, video, video_index)}
            for at,foreground,background,image_path,video,video_index in connection.execute(
                "SELECT timestamp,foreground,background,image_path,video,video_index FROM frame WHERE timestamp>=? AND timestamp<? ORDER BY timestamp,id", (start*1000,end*1000))]
        connection.rollback()
    finally: connection.close()
    since = dt.datetime.fromtimestamp(start,dt.timezone.utc).isoformat()
    query = subprocess.run([str(args.own_executable),"query","--store",str(args.own_store),"--since",since,"--limit","10000"], capture_output=True, timeout=60)
    if query.returncode: raise ValueError("own-query-failed")
    records = [json.loads(line) for line in query.stdout.splitlines() if line.strip()]
    if len(records)>=10000: raise ValueError("own-query-limit")
    own=[]
    for record in records:
        at=seconds(record["capturedAt"])
        if start<=at<end:
            own.append({"at":at,"ocr":"\n".join(t["text"] for t in record.get("ocr",[])),
                "ax":"\n".join(n.get("text") or "" for n in (record.get("accessibility") or {}).get("nodes",[])),
                "imageReferencePresent":own_image_reference(record),
                "status":record.get("status"),"gap":record.get("status") not in ("captured","unchanged","cached-idle")})
    report={"window":{"start":start,"end":end},"transitionMarginSeconds":2,
        "excludedMissingImageReference": {"own":sum(not r["imageReferencePresent"] for r in own), "coast":sum(not r["imageReferencePresent"] for r in coast)},
        "ownOCR":score_channel(own,questions,events,start,end,"ocr"),
        "ownAX":score_channel(own,questions,events,start,end,"ax"),
        "coastOCR":score_channel(coast,questions,events,start,end,"ocr"),
        "coastAX":{"available":False,"reason":"not-retrieved-by-this-read-only-scorer"},
        "limitations":["Literal case-sensitive, whitespace-normalized answer-evidence recall only; no model answering or reasoning was evaluated.",
            "All answers within a requirement must occur in one sample from its declared phase; separate before/after requirements cannot borrow evidence from another phase.",
            "Two-second transition margins are excluded. First delay is relative to the phase event, not end-to-end availability latency.",
            "Own captured/unchanged/cached-idle rows require a nonempty imageFile reference; Coast requires image_path or video+index. Reference presence does not verify file availability or pixel decodability. Statuses are reported separately. Cached idle retains older evidence, not fresh pixels.",
            "AX can include hidden text. Coast OCR combines foreground/background fields; Coast AX is unavailable here.",
            "Fixture event times must represent actual displayed phases. Missing events remain missing evidence."]}
    encoded=json.dumps(report,indent=2,sort_keys=True)+"\n"
    if args.output: args.output.write_text(encoded)
    else: print(encoded,end="")


def self_test():
    assert not own_image_reference({"status":"captured"})
    assert own_image_reference({"imageFile":"synthetic/image.png"})
    assert not coast_image_reference(None,None,None)
    assert coast_image_reference(None,"synthetic.mov",0)
    assert not coast_image_reference(None,"synthetic.mov",None)
    assert contains("ORDER 000\n  confirmed", "ORDER 000 confirmed")
    assert not contains("ORDER OOO", "order 000")
    assert not contains("ORDER 0001", "ORDER 000")
    questions=validate_questions({"questions":[{"id":"changed","evidence":[
        {"phase":"before","answers":["VALUE 100"]},{"phase":"after","answers":["VALUE 200"]}]}]})
    events=[{"at":0,"phase":"before"},{"at":10,"phase":"after"}]
    wrong=[{"at":5,"ocr":"VALUE 100 VALUE 200","imageReferencePresent":True}]
    assert not score_channel(wrong,questions,events,0,20,"ocr")["questions"][0]["allRequiredPhaseEvidenceFound"]
    correct=wrong+[{"at":15,"ocr":"VALUE 200","status":"cached-idle","imageReferencePresent":True}]
    scored=score_channel(correct,questions,events,0,20,"ocr")
    assert scored["questions"][0]["allRequiredPhaseEvidenceFound"]
    missing_image=[dict(row,imageReferencePresent=False) for row in correct]
    assert not score_channel(missing_image,questions,events,0,20,"ocr")["questions"][0]["allRequiredPhaseEvidenceFound"]
    assert scored["questions"][0]["requirements"][1]["events"][0]["cachedIdleMatches"]==1
    assert not score_channel(correct,questions,events[:1],0,20,"ocr")["questions"][0]["allRequiredPhaseEvidenceFound"]
    assert not score_channel([],questions,events,0,20,"ocr")["questions"][0]["allRequiredPhaseEvidenceFound"]
    assert not score_channel([{"at":11,"ocr":"VALUE 200"}],questions,events,0,20,"ocr")["questions"][0]["requirements"][1]["literalEvidenceFound"]

if __name__=="__main__":
    try: main()
    except (OSError,ValueError,KeyError,TypeError,sqlite3.Error,subprocess.SubprocessError):
        print("Practical recall scoring failed: check completed window, fixed questions, events, and read-only sources.",file=sys.stderr)
        sys.exit(1)
