# Google Maps Timeline: `google-timeline:<account>:export`

## How it arrives

The phone exports it: Google Maps › Settings › Personal content › Export Timeline data saves
`location-history.json` (Google's page: https://support.google.com/maps/answer/6258979). The person
saves it to Files, iCloud Drive or the home's Mac, and chooses it in the Google Maps Timeline
import's window ([imports.md](../../imports/imports.md)), or hands it in with
`lifestream import google-timeline <path>`. Any JSON file is offered (`export.recognise` is
`*.json`): the reader is the judge. The export names no account, so the home asks whose it is, of
its Google accounts; the answer names the source `google-timeline:<account>:export`. A file the
home took in before is "Already imported"; a new export is a new import, and the records it restates
stand. Its time is its newest segment's end (the reader's `states`), so an older export brought in
late never outranks a newer one.

A file shared to the phone app ("Send to Lifestream") lands as the phone's upload
(`upload:local:<phone>`, [upload](../../upload/upload.md)), a `file` record no family reads: it
reaches this source only as a Google Maps Timeline import.

## What it reads

Every `.json` member of what was handed in, found by name under any leading folders: the file
alone, or a zip or folder holding it. The phone's location-history export is an object with
`semanticSegments` or a bare array of segments. Each segment is kept whole. Raw signals and
the location profile are not read. Each file, and each segment, is a part: a segment that is
none or more than one of the families below (a family Google adds later) is refused alone, and a
file that cannot be read alone. A number whose text no 64-bit float carries is stated as
that text. An optional `device` fact names the phone. A file read whole is let go by the home's
sweep.

## Kinds and keys

| Kind | Segment | Key | Content | Time |
|---|---|---|---|---|
| `place-visit` | `visit` | start as `YYYYMMDDTHHMMSSZ` (whole UTC second), then `:<placeID>` when the top candidate states one | `{type: "timeline.visit", content: segment}` | startTime to endTime, offsets as stated |
| `trip` | `activity` | start | `{type: "timeline.trip", content: segment}` | as above |
| `path` | `timelinePath` | start | `{type: "timeline.path", content: segment}` | as above |

## What the physical family reads

**Adapter** `timelinePhysical` (adapter.ts; [physical](../../../families/physical/)): a
stated witness, `Timeline`, rank 40 (30 is kept for its path points, which nothing reads yet).

| Kind | Read |
|---|---|
| `place-visit` | a top-level visit (`hierarchyLevel` "0"; a visit nested in another is none): its interval, its top candidate's `placeLocation`, and its `placeID` as `google:<placeID>`, the id the places' labels hold |
| `trip` | an activity: its interval, its top candidate's type (`walking`, `cycling`, `flying`; any other type a road vehicle), `distanceMeters`, and its `start` and `end` points |

Probabilities, semantic types and the other candidates are not read.
