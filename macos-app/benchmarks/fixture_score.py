#!/usr/bin/env python3
"""Read-only synthetic fixture score; emits aggregates, never captured text or paths.

python3 fixture_score.py --directory /external/round --output /external/score.json
The directory contains window.json and fixture-events.json ([{at: epoch, phase: key}]).
"""
from __future__ import annotations
import argparse
import bisect
import collections
import datetime as dt
import json
import math
from pathlib import Path
import re
import sqlite3
import statistics
import subprocess
import sys
import time


def tokens(text):
    return set(re.findall(r"[^\W_]+", text.lower()))


def seconds(value):
    if isinstance(value, (int, float)):
        return value / 1000
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def summary(values):
    values = sorted(values)
    if not values:
        return {"n": 0}
    return {"n": len(values), "min": values[0], "median": statistics.median(values),
            "mean": statistics.mean(values), "p95": values[math.ceil(.95 * len(values)) - 1],
            "max": values[-1]}


def classify(timestamp, observed, phases, events, margin):
    markers = [key for key, phase in phases.items() if phase["marker"].lower() in observed]
    if events is not None:
        if any(abs(timestamp - event["at"]) <= margin for event in events):
            return None, "transition", markers
        index = bisect.bisect_right([event["at"] for event in events], timestamp) - 1
        if index < 0:
            return None, "unknown-event-phase", markers
        return events[index]["phase"], "timed-event", markers
    if len(markers) == 1:
        return markers[0], "marker-only", markers
    return None, "unknown-marker-phase", markers


def detailed_recall(text, expected):
    words = re.findall(r"[^\W_]+", text)
    expected_words = expected.get("expectedTokenOccurrences", [])
    required = expected.get("requiredNumericIdentifierOccurrences", [])
    phrases = expected.get("expectedPhrases", expected.get("visibleLines", []))
    normalized = " ".join(text.split())
    result = {}
    missing = {}
    for label, wanted in [("tokenMultiset", expected_words), ("requiredNumericIdentifierMultiset", required)]:
        for case_sensitive in [False, True]:
            suffix = "CaseSensitive" if case_sensitive else "CaseInsensitive"
            transform = (lambda word: word) if case_sensitive else str.lower
            reference = collections.Counter(map(transform, wanted))
            observed = collections.Counter(map(transform, words))
            count = sum(reference.values())
            result[label + suffix + "Recall"] = sum((reference & observed).values()) / count if count else None
            missing[label + suffix] = dict(reference - observed)
    for case_sensitive in [False, True]:
        suffix = "CaseSensitive" if case_sensitive else "CaseInsensitive"
        haystack = normalized if case_sensitive else normalized.lower()
        absent = [phrase for phrase in phrases if (" ".join(phrase.split()) if case_sensitive else " ".join(phrase.split()).lower()) not in haystack]
        result["phraseContainment" + suffix + "Recall"] = 1 - len(absent) / len(phrases) if phrases else None
        missing["phrases" + suffix] = absent
    return result, missing


def score(rows, phases, events, margin, own):
    counters = collections.Counter()
    by_phase = {key: {"frames": 0, "imageStatusCounts": collections.Counter(), "gaps": 0, "missingExpectedOCRMarker": 0,
                      "wrongOCRPhaseMarker": 0, "multipleOCRPhaseMarkers": 0,
                      "ocrEmptyFrames": 0, "ocrStatusCounts": collections.Counter(),
                      "forbiddenSyntheticOCRFrames": 0, "forbiddenSyntheticOCRCounts": collections.Counter(),
                      "gapReasons": collections.Counter(), "ocrRecall": [], "axRecall": [],
                      "times": [], "detailedRecall": collections.defaultdict(list),
                      "missingSyntheticCounts": collections.defaultdict(collections.Counter)} for key in phases}
    for row in rows:
        observed = tokens(row["text"])
        phase, reason, markers = classify(row["at"], observed, phases, events, margin)
        counters[reason] += 1
        if phase is None:
            continue
        bucket = by_phase[phase]
        if row.get("gap"):
            bucket["gaps"] += 1
            bucket["gapReasons"][row.get("reason") or "unspecified"] += 1
            continue
        bucket["frames"] += 1
        bucket["imageStatusCounts"][row.get("status", "provider-not-reported")] += 1
        bucket["times"].append(row["at"])
        bucket["missingExpectedOCRMarker"] += phase not in markers
        bucket["wrongOCRPhaseMarker"] += any(marker != phase for marker in markers)
        bucket["multipleOCRPhaseMarkers"] += len(markers) > 1
        bucket["ocrEmptyFrames"] += not observed
        bucket["ocrStatusCounts"][row.get("ocrStatus", "provider-not-reported")] += 1
        forbidden = [value for value in phases[phase].get("forbiddenOCRTokens", []) if value.casefold() in observed]
        bucket["forbiddenSyntheticOCRFrames"] += bool(forbidden)
        bucket["forbiddenSyntheticOCRCounts"].update(forbidden)
        expected = set(phases[phase]["scenarioContentTokens"])
        bucket["ocrRecall"].append(len(expected & observed) / len(expected))
        detailed, missing = detailed_recall(row["text"], phases[phase])
        for metric, value in detailed.items():
            if value is not None: bucket["detailedRecall"][metric].append(value)
        for metric, values in missing.items():
            bucket["missingSyntheticCounts"][metric].update(values)
        if own:
            ax = tokens(row.get("ax", ""))
            bucket["axRecall"].append(len(expected & ax) / len(expected))
    output = {}
    for phase, bucket in by_phase.items():
        times = sorted(bucket.pop("times"))
        bucket["ocrRecall"] = summary(bucket["ocrRecall"])
        bucket["axRecall"] = summary(bucket["axRecall"]) if own else None
        bucket["detailedRecall"] = {key: summary(values) for key, values in bucket["detailedRecall"].items()}
        bucket["interCaptureSeconds"] = summary([b-a for a,b in zip(times,times[1:])])
        output[phase] = bucket
    return {"observationsInWindow": len(rows), "classificationCounts": dict(counters),
            "phaseUnknownObservations": sum(v for k,v in counters.items() if k.startswith("unknown")),
            "transitionExcludedObservations": counters["transition"], "phases": output}


def event_coverage(rows, phases, events, margin, end):
    """Include zero-frame intervals; short events remain explicitly unscorable."""
    if events is None:
        return None
    result = []
    for index, event in enumerate(events):
        stop = events[index + 1]["at"] if index + 1 < len(events) else end
        lower, upper = event["at"] + margin, stop - margin
        eligible = [row for row in rows if lower < row["at"] < upper and not row.get("gap")]
        marker = phases[event["phase"]]["marker"].lower()
        matching = [row for row in eligible if marker in tokens(row["text"])]
        result.append({"phase": event["phase"], "durationSeconds": max(0, stop-event["at"]),
                       "eligibleDurationSeconds": max(0, upper-lower),
                       "tooShortForTransitionMargin": upper <= lower,
                       "capturedFrames": len(eligible), "cachedIdleImageObservations": sum(row.get("status") == "cached-idle" for row in eligible), "imageStatusCounts": dict(collections.Counter(row.get("status", "provider-not-reported") for row in eligible)), "markerDetectedFrames": len(matching),
                       "missedEntireEligibleEvent": upper > lower and not matching,
                       "firstMarkerDelaySeconds": min((row["at"]-event["at"] for row in matching), default=None)})
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--manifest", type=Path, default=Path(__file__).parent / "fixture/manifest.json")
    parser.add_argument("--events", type=Path)
    parser.add_argument("--marker-only", action="store_true",
                        help="Diagnostic fallback; missing markers remain explicitly unclassified")
    parser.add_argument("--transition-margin", type=float, default=2)
    parser.add_argument("--coast-db", type=Path,
                        default=Path.home()/"Library/Application Support/inc.attention.rem/rem.db")
    parser.add_argument("--own-store", type=Path,
                        default=Path.home()/"Library/Application Support/Lifestream Screen")
    parser.add_argument("--own-executable", type=Path,
                        default=Path.home()/"Applications/Lifestream.app/Contents/MacOS/Lifestream")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.self_test:
        self_test()
        print("Synthetic fixture scoring checks passed.")
        return
    if args.directory is None: raise ValueError("directory-required")
    window = json.loads((args.directory/"window.json").read_text())
    start, end = float(window["start"]), float(window["end"])
    if not math.isfinite(start + end) or start >= end or time.time() < end:
        raise ValueError("window-must-be-complete-and-valid")
    if not math.isfinite(args.transition_margin) or args.transition_margin < 0:
        raise ValueError("invalid-transition-margin")
    phases = json.loads(args.manifest.read_text())["scenarios"]
    if any(not p["scenarioContentTokens"] for p in phases.values()):
        raise ValueError("empty-ground-truth")
    events = None
    if not args.marker_only:
        events = json.loads((args.events or args.directory/"fixture-events.json").read_text())
        if not isinstance(events, list) or not events:
            raise ValueError("events-required")
        events = sorted(events, key=lambda event: event["at"])
        if any(not math.isfinite(event["at"]) or event["phase"] not in phases for event in events):
            raise ValueError("invalid-event")
        if len({event["at"] for event in events}) != len(events):
            raise ValueError("duplicate-event-times")
    connection = sqlite3.connect(args.coast_db.resolve().as_uri()+"?mode=ro", uri=True, timeout=5)
    try:
        connection.execute("PRAGMA query_only=ON")
        connection.execute("BEGIN")
        coast = [{"at": timestamp/1000, "text": "\n".join(part for part in (foreground, background) if part)}
                 for timestamp, foreground, background in connection.execute(
                     "SELECT timestamp,foreground,background FROM frame WHERE timestamp>=? AND timestamp<? ORDER BY timestamp,id",
                     (start*1000, end*1000))]
        connection.rollback()
    finally:
        connection.close()
    since = dt.datetime.fromtimestamp(start, dt.timezone.utc).isoformat()
    result = subprocess.run([str(args.own_executable), "query", "--store", str(args.own_store),
                             "--since", since, "--limit", "10000"], capture_output=True, timeout=60)
    if result.returncode:
        raise ValueError("own-query-failed")
    observations = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
    if len(observations) >= 10000:
        raise ValueError("own-query-limit-reached")
    own = []
    for record in observations:
        at = seconds(record["capturedAt"])
        if start <= at < end:
            own.append({"at": at, "text": "\n".join(t["text"] for t in record.get("ocr", [])),
                        "ax": "\n".join(n.get("text") or "" for n in (record.get("accessibility") or {}).get("nodes", [])),
                        "status": record.get("status"), "gap": record.get("status") not in ("captured", "unchanged", "cached-idle"), "reason": record.get("reason"),
                        "ocrStatus": record.get("ocrStatus", "unknown")})
    report = {"window": {"start": start, "end": end},
              "classification": "marker-only" if events is None else "independent-event-time-first",
              "transitionMarginSeconds": args.transition_margin,
              "coast": score(coast, phases, events, args.transition_margin, False),
              "own": score(own, phases, events, args.transition_margin, True),
              "limitations": [
                  "Expected visible synthetic content is ground truth only while fixture is foreground, fully visible and correctly sized.",
                  "Event timestamps identify requested phases; marker mismatches remain failures and are not silently reassigned.",
                  "Transition observations are counted but excluded from per-phase quality metrics.",
                  "Frame counts include captured, unchanged and cached-idle image-backed observations; imageStatusCounts separates statuses. Cached-idle retains earlier callback evidence and is not fresh capture coverage.",
                  "Empty OCR contributes zero recall in timed phases; missing captured frames are not invented.",
                  "Token-set recall does not score order, repetitions, punctuation, pixel fidelity, or retrieval latency.",
                  "AX may include hidden text; AX recall alone does not establish visible-text coverage.",
                  "Marker-only mode can exclude missing-marker failures; do not use it to claim recall parity."]}
    report["eventCoverage"] = {
        "own": event_coverage(own, phases, events, args.transition_margin, end),
        "coast": event_coverage(coast, phases, events, args.transition_margin, end)}
    report["limitations"].append("Event coverage includes zero-frame phases; first-marker delay excludes transition margins and is not end-to-end OCR availability latency.")
    timing_note = args.directory / "fixture-timing-note.json"
    if timing_note.exists():
        report["fixtureTimingNote"] = json.loads(timing_note.read_text())
        report["timingQualification"] = "Review fixtureTimingNote before attributing phase mismatches to recorder errors."
    report["limitations"] += [
        "Phrase containment preserves punctuation within each phrase but normalizes whitespace; it does not validate full-page reading order or inter-phrase placement.",
        "Multiset recalls preserve repetitions and report case-sensitive and insensitive results separately; incidental matching words elsewhere may satisfy counts.",
        "Missing outputs contain only expected synthetic tokens and phrases. Counts sum missing token occurrences or missing-phrase frames across eligible captures."]
    encoded = json.dumps(report, indent=2, sort_keys=True)+"\n"
    if args.output:
        args.output.write_text(encoded)
    else:
        print(encoded, end="")


def self_test():
    temporal_phases = {"a": {"marker": "ALPHA101"}, "b": {"marker": "BETA202"}}
    temporal_events = [{"at": 0, "phase": "a"}, {"at": 6, "phase": "b"}]
    temporal = event_coverage([], temporal_phases, temporal_events, 2, 9)
    assert temporal[0]["missedEntireEligibleEvent"]
    assert temporal[1]["tooShortForTransitionMargin"]
    temporal = event_coverage([{"at": 3, "text": "unrelated"}], temporal_phases, temporal_events, 2, 9)
    assert temporal[0]["capturedFrames"] == 1 and temporal[0]["markerDetectedFrames"] == 0

    phase = {"marker": "MARKER1", "scenarioContentTokens": ["marker1", "codea", "7", "repeat"],
             "expectedTokenOccurrences": ["MARKER1", "codeA", "7", "7", "repeat", "repeat"],
             "requiredNumericIdentifierOccurrences": ["MARKER1", "codeA", "7", "7"],
             "expectedPhrases": ["codeA 7 7", "repeat repeat"]}
    values, missing = detailed_recall("MARKER1 codea 7 repeat PRIVATE_EXTRA", phase)
    assert tokens("MARKER1 codea 7 repeat") == set(phase["scenarioContentTokens"])
    assert values["tokenMultisetCaseInsensitiveRecall"] == 4/6
    assert values["requiredNumericIdentifierMultisetCaseInsensitiveRecall"] == 3/4
    assert values["requiredNumericIdentifierMultisetCaseSensitiveRecall"] == 2/4
    assert values["phraseContainmentCaseInsensitiveRecall"] == 0
    assert "PRIVATE_EXTRA" not in json.dumps(missing)
    values, _ = detailed_recall("repeat\nrepeat codeA   7\n7 MARKER1", phase)
    assert values["phraseContainmentCaseSensitiveRecall"] == 1
    phases = {"a": phase}
    scored = score([{"at": 105, "text": "", "ax": ""}, {"at": 100, "text": "MARKER1"}],
                   phases, [{"at": 100, "phase": "a"}], 2, True)
    cached = score([{"at": 105, "text": "MARKER1", "ax": "", "status": "cached-idle", "gap": False}],
                   phases, [{"at": 100, "phase": "a"}], 2, True)
    assert cached["phases"]["a"]["frames"] == 1
    assert cached["phases"]["a"]["gaps"] == 0
    assert cached["phases"]["a"]["imageStatusCounts"] == {"cached-idle": 1}
    assert scored["transitionExcludedObservations"] == 1
    assert scored["phases"]["a"]["missingExpectedOCRMarker"] == 1
    assert scored["phases"]["a"]["ocrRecall"]["mean"] == 0
    assert scored["phases"]["a"]["detailedRecall"]["tokenMultisetCaseInsensitiveRecall"]["mean"] == 0


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error, subprocess.SubprocessError):
        print("Fixture scoring failed: check completed window, fixture events, manifest, read-only database and recorder CLI.", file=sys.stderr)
        sys.exit(1)
