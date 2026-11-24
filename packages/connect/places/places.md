# Places: `places:local:<home>` and `google-maps:<account>:lookup`

The owner's places, and Google's names for places. Both are owner sources: the home keeps them
under no device, and a device only reads them and writes the owner's edits to them. `<home>` is the home's unit,
the `unit` setting.

## What it reads

Each edit of `places:local:<home>` is an act: `POST /v1/owner/act` with `of: "places"`, by a pass
with `deliver` on the source (the phone's, the dashboard's). The home's owner writer
(`packages/home/owner-act.ts`, the drafter `packages/home/places-draft.ts`) drafts it against the
heads, seals it as one owner-statements delivery and lands it before it answers. The home mints a new place's id,
the name's slug and three random bytes in hex, and a hidden spot's, `hidden-<hex>`. Google's names
(`google-maps:<account>:lookup`) arrive as bundles: `PUT /v1/acquisitions/<source>/<made-at>.<12 hex>`,
a stored ZIP of `statements.ndjson` and `manifest.json` (feeder `owner-statements`, `complete`,
`fetched_at` the instant it was made, facts `{statements: <n>, blobs_carried: 0}`), the hex the
first 12 of the SHA-256 of `statements.ndjson`, so a retry is the same delivery. Both are read by
the one statements reader (`shared/statements.ts`), one statement a line:

```
{"kind":"place","key":"<id>","content":{type,name,centre,radius_m,ids,home?,also?}}
{"kind":"place","key":"<id>","gone":true}
{"kind":"hidden","key":"<id>","content":{type,centre,radius_m}}
{"kind":"visit","key":"stay/<source>/<key>","content":{type,place}}
```

Each road reads the statements with the source's connector before it seals them: one line that
does not read is 422 `STATEMENTS_BAD`, naming the line, and nothing is sealed, so a sealed edit
always lands. It is sealed outside custody, with the unit of the pass that sent it in its facts
(`device`), which is every row's device: who made an edit is read from `statements.device`, never
from the source. An act is stated at the home's one clock, so two edits are in the order the home
took them and no device's clock makes one `late`; a bundle is stated at its manifest's `fetched_at`
(facts that state a source's own time are refused). Only a `gone: true` line states no content:
`content: null` is refused.
Each edit is one delivery, so one run, so `undo <run>` undoes it alone.

## Kinds and keys

| Source | Connector | Kind | Key | Content | Time |
|---|---|---|---|---|---|
| `places:local:<home>` | `places-home` | `place` | the place's id | `{type: "places.place", name, centre: {latitude, longitude}, radius_m, ids, home?, also?: [{centre, radius_m}]}` | none |
| `places:local:<home>` | `places-home` | `hidden` | an id minted as a place's is | `{type: "places.hidden", centre: {latitude, longitude}, radius_m: 80}` | none |
| `places:local:<home>` | `places-home` | `visit` | a stay's extract unit, `stay/<source>/<key>` | `{type: "places.visit", place: <id> \| null}` | none |
| `google-maps:<account>:lookup` | `google-place-names` | `place` | `google:<place ID>` | `{type: "google.place", id, name, centre: {latitude, longitude}}` | none |

- **A place's id** is minted once by the home as its `create` is drafted (the name as a slug, a
  dash, six random hex digits: `krux-gym-3f9a2c`, drawn again while a place holds it; a place from
  before keeps its slug), matches
  `^[a-z0-9][a-z0-9-]{0,63}$`, and never changes, a rename included. Nothing derives anything
  from it or compares it with a name.
- **A place:** `name` trimmed, 1 to 200 characters; `centre` in range; `radius_m` 20 to 2,000;
  `ids` the provider IDs the owner says are this place (`google:<place ID>`), sorted, no
  repeats, possibly empty; `home`, a boolean, the owner's answer to "Is this home?", absent while never answered. Answering
  restates the place's whole content with `home: true` or `home: false`, through the same edit
  as any change to it. `also`, a place's other circles, present only on a place a
  spot was added to: 1 to 19 `{centre, radius_m}`, each centre in range and each radius 20 to
  2,000 as the first; empty, more, or one of another shape is refused. Adding a spot to a place
  restates it whole with the circle appended; every statement of a place restates its `also`. A removal
  states the place gone; its history stays.
- **A hidden spot**: a spot the owner said never to
  ask about, hidden while its centre lies within the circle; `centre` in range, `radius_m` exactly
  80, a place's reach, which every device tests a stay by: any other radius is refused. It is out
  of the spots, To name, the asking order and the invitation's count, a day tells a point inside it
  as "a hidden place", and Google is never asked about it (`/v1/places` lists it under `hidden`).
  Unhide states it gone.
- **One visit at another place**: the one stay its key names (as the physical
  family names a stay's extract) was at the owner place `place`, or, `null`, at nowhere the owner
  would name. The guard holds it; `placeOf` reading it is owed.
- **A Google name:** Google's name and point for one of its place IDs, `id` the ID itself and
  the key `google:<id>`. It has no circle: it names only a Timeline visit stating its ID.
  `<account>` is the Google account whose Timeline the IDs came from. The google-places labeler
  states the names of the Timeline's IDs no name holds yet
  ([google-places](../labelers/google-places/google-places.md)).

What a day names a point by, and what a spot is, is the families' one module of place rules
(`families/shared/places.ts`; [labels](../../families/labels/)). `/v1/places` reads a
place's and a hidden spot's definition from these records on every read, so an act is read in the
tick it is answered, and joins what the places job counted of it (visits, photos, rhythm), marking a
place `counting` until that job has counted its definition (door.md). The old phones'
`places:local:<unit>` sources are history, read by nothing ([ios-app](../ios-app/ios-app.md)).
