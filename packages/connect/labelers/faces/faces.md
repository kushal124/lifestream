# faces

The faces labeler and the connector that reads what it delivers. For every photo the home holds,
it finds where the faces are and who each one is: the day file says who was in a photo, a
person's page shows every photo of them, and the dashboard's naming view asks the owner to name
the people who matter. The engine it runs, its commands and their rules:
[faces/README.md](../../../../faces/).

## The rules faces keep

- **A face is a fact about a photo.** Its key is the photo's SHA-256 and its box in the upright
  photo, so nothing about it depends on a folder, a file name or when it was scanned, and one
  photo sent into ten chats is one set of faces.
- **Face-level facts are the engine's output; person-level facts are the owner's statements.** A
  name, a merge and which handles are one person are statements of `people:local:<unit>`
  ([people](../../people/people.md)); the faces, their vectors, crops and clusters are this
  labeler's records. Nothing is stored twice, and a person holds no cluster id.
- **A conclusion is stored the way it is read.** A photo's faces are its `scan`; who a face is,
  is stated once, in its person's `named` record (or its group's `cluster`), so a person's photos
  are one record, never a walk of every photo.
- **Names live on faces, never on clusters.** Who a face is, is the owner's statement in
  `home.db`: newest wins, `undo <run>` or a newer statement undoes it, and an erasure takes it.
  Clusters are computed again by every `group` and are disposable; a cluster id is only a handle
  for showing it, so grouping again never loses a name.
- **A name survives a new pipeline.** `group` finds the face a statement is about by its photo
  and box: the face on that photo whose box overlaps the stated box most, by at least half.
  Under one pipeline the boxes are equal; under a new one they move a little, and every statement
  still finds its face.
- **The owner's word enters through the door.** The dashboard, the one place the owner names faces,
  reads through the door's read routes and ships each action as one delivery of
  `people:local:<unit>`, so one run. Naming a cluster states `{is: <slug>}` on every face it held
  when named; moving one wrong face out states `{is_not: [<slug>]}` on it; "I don't know them"
  states `{ignore: true}`; a merge is the person record's `merged_into`, a rename its `name`.
- **Deleting a photo deletes its faces**, with their vectors, crops and model image (Erasures, below).
- **A model image is the faces to draw, never an image.** It holds the box of every face the
  scan found and, apart, `names`: per face, none or the person it is now (`who`, `person:<slug>`,
  and the name People shows, `shown`). The image a caption ask shows the model
  is drawn from the photo when the ask's request is written (The engine, below), and kept only in
  the model ledger, so `blobs/` holds no drawing and a photo never asked costs nothing.

## Source

`faces:local:<unit>`, where `<unit>` is the home machine. The labeler writes its deliveries; nothing
else ships to this source. Its first delivery's facts name it (`sources`), so the home makes the
source as it lands, as the cameras labeler's is made: a new home needs no `lifestream source add`.

## Its health

Faces is a labeler's connector like any other. Its declaration's
`label.install`, "Get the face models", is its `install` requirement: unmet while the models are not installed
(`modelsInstalled`: both model files there, and no install begun since the last whose self-check passed: `install`
marks the folder `<models>.unchecked` as it begins and removes the mark once the check passes, so a failed or stopped
install leaves them uninstalled and the next checks them again), when a run ends `not-installed`. The install is this
labeler's `install` (the fetch unless the files are there, then the self-check). Waiting for mains power is `waiting
power`; the photos it owes are its history line; Scan now (One run, below) is an act on its health; Pause and Resume are
any connector's; settings `sources.off` turns it off. The photos family captions a photo with no model image only while
faces is not on, with nothing drawn ([photos](../../../families/photos/) "Asks").

## What the labeler reads

- The records of every photo source: the sources of each product a photos adapter is registered
  for (`apple-photos`, `google-photos`, `camera` in a release), of the kinds those adapters read
  (`img`, `img-file`). The home hands the labeler those adapters in its settings (`photos`), and a
  record's image is the one its adapter's `image` says it shows (core/inputs/photos.ts, read through
  [shared/photo-image.ts](../../shared/photo-image.ts) `photoImage`): a Google Photos record's
  original (its first blob, whose hash is the record's key), whatever media type it states; the
  camera's payload blob; a phone-library asset's render of its current edit when held, else its
  original, and an availability's as its asset then shows. A video or a second resource is never
  one, and no byte is sniffed.
- The `msg` records of every chat source whose messages adapter says what images a message
  carries (its `images`, core/inputs/messages.ts; the home hands the labeler the messages adapters
  in its settings, `messages`): in a release, a WhatsApp photo or sticker (`ZMESSAGETYPE` 1, 20 or
  15) by its `ZWAMEDIAITEM.ZMEDIALOCALPATH` blob ([whatsapp](../../messages/whatsapp/whatsapp.md));
  an iMessage attachment whose MIME type is `image/…`, or that names none and is called by an
  image's extension ([imessage](../../messages/imessage/imessage.md)). This input reads only the
  messages whose version links a file (`linked: true` on the seam): a delta of text-only messages
  does not make the labeler due.
- The `person` and `face` records of `people:local:<unit>`: the owner's people and their
  statements about faces ([people](../../people/people.md)). A person is read loosely, every member
  optional: its `name`, `full_name`, `show` and `merged_into`. The name it shows is `full_name` when `show` says so and it is set, else `name`;
  a person with neither shows none.
- The `photo` records of `cameras:local:<unit>`, by key alone: the images a camera took (the
  cameras labeler's rule, [cameras](../cameras/cameras.md)). A run that reads its records reads
  their keys in one range.

Only images the home holds are scanned. One image named by a photo record and by a message is
one image, scanned once.

## The engine

`face-engine` ([faces/README.md](../../../../faces/) "What it is"), the Swift
executable a release carries at `faces/.build/release/face-engine` (built once per hash of its
sources), runs on the model files the `install faces` job
(`lifestream faces on`) fetches into `<root>/tools/faces/models/buffalo_l/`. Each command reads
one request file and writes one result file in the run's folder, `<root>/tools/faces-work/run/`,
and has an hour. The labeler runs `scan` and `group`, of the library in a run and of one picture in
`matchOne` (One picture).

| Outcome | The labeler |
|---|---|
| the engine or a model file missing | `not-installed` (its words name `lifestream faces on` or the build) |
| exit 1 | `crashed`, with the engine's words |
| exit 2 (it could not read the request), or a result this module cannot read | `unreadable` |
| past the hour | stopped (SIGKILL), `timeout` |

Any of them ends the run with nothing delivered, and the home rests the labeler. The engine
keeps nothing and the cursor does not move, so the next run reads the same moves again. Waiting
for power (step 3 of One run) is another rest: it holds the scan alone, and its run delivers what
it grouped and drew.

`draw` is the labeler's `draw(photo, faces)`, which the home's asker runs when it writes a
caption's request ([photos](../../../families/photos/) "Asks"): one photo, read raw from
the blob store, with each face its `model-image` states framed or covered under its placeholder's
tag, in a `draw-*` folder of its own
under `<root>/tools/faces-work/` that it removes after, and that a run never removes. It answers
the JPEG's bytes, which the ledger keeps. Any of the outcomes above, or a photo the engine cannot
decode, throws: that request is not written, as for a blob the home cannot read, and the next
request of the ask draws again.

## One run

The labeler's own records are its memory, like every derived thing in the home: what it owes is
computed from its `image` records and from what moved since its last run (the home's
`label:faces` cursor: a statement seq and a rereads seq), never from a read of every input.

**When it reads its records.** A run reads its own records only when they can owe work: its first
run, an `image` record moved (step 1), an erasure was made since its last run, a `person` or `face`
of `people:local:<unit>` or a camera's `photo` was stated since its last run, Scan now stands, its
last run stopped at its 2,000 (it stated 2,000 `scan` records) or rested (the home says so: the
power may be back), an undo or a
repair restated one of its records since its last run (a statement of origin `repair`: what it
lost is stated again, never taken for its own delivery's landing), or nothing it reads was stated
since its last run (it was woken by the home's start, which may bring a new
pipeline or image shape). Any other run returns nothing having read no record's contents and run
no engine command: the run its own delivery's landing starts after a run that owed nothing more,
or a chat delta whose files are no image (a voice note). A run that reads its records reads their
heads by range and each version only through the memo (The memo, below): a version is read once,
whatever the number of runs.

**When it groups.** The group's key is the digest of its inputs and of its last outputs: the
group rule (`GROUP_RULE`); each current scan with a face (its photo and version id) and whether a
camera took its photo; each `face` statement (key and version id) and each person's
`merged_into`; and the version ids of the labeler's own `named`, `cluster` and `maybe` heads. A
run groups when the memo does not hold the key, and either no scan is owed after this run's scan,
the owner's word (a `face` statement or a merge) moved since its last run, or the run migrates. A
run that grouped keeps the key of the heads its lines leave, so a delivery that never lands leaves
the heads at another key and the next run groups again; a group that throws keeps nothing, so it
stays owed. Everything that owes a group moves the key: a face statement, a merge, a rule change, a
fresh scan with a face, a camera's photos, the first run, an erasure (its scans leave the current
ones), a new pipeline (the scans' versions change), and an output lost or undone (an own head at
another version). A rename alone never groups. The group is deterministic, so a needless one costs
its seconds and states nothing: a run that restates `named` or `cluster` without grouping (a
photo's time moved) makes the next run group once.

**Model images** are stated once a photo's scan stands, before any grouping: a run states one for
every photo it scanned afresh, and every model image again in a run that grouped or left no scan
owed, and on a person edit (a rename). A face still to group is in its model image with no name,
so its photo is captioned with the face as a placeholder, and the caption reads the name once the
face is grouped and named. Example: a new Takeout of 5,000 photos is scanned in three runs; each
states the model images of the photos it scanned, and the third groups once and restates the
names of every model image whose faces it grouped.

1. **Images.** The input records that moved since the cursor name the images that moved: for
   each `img` or `msg` record stated since, the version each statement states and the version it
   replaced; for each one read again since with no statement (a blob it wanted arrived, or its
   version gained a link), its head. Each image blob those versions link is read again from every
   version that names it (`naming`), kept where a live head of an input states it: its `image`
   record is stated when it differs from its head (by version id), and `gone` when no live record
   names the image any more. Every other image stands as its record states it. A run with nothing moved reads no input record, however many
   messages the home holds.
2. **The pipeline.** A `scan` of no photo states the engine's pipeline; its id is the
   `digest` of that description.
3. **Scan.** Every `image` (as this run leaves it) whose `scan` does not state that id, or whose
   vectors the home does not hold, is owed. More owed than `faces.battery_backlog` (default 500),
   the run scans only while the Mac draws mains power (`pmset -g ps`; a desktop always does), or
   while Scan now stands (the `meta` row `faces:now`, which `lifestream faces now` writes and the home
   deletes once a run leaves nothing owed); else it scans none, goes on to group and draw as the
   rule says (the owner's word is never held for power), and ends `waiting-for-power`, carrying
   what it delivers: the home lands that, rests the labeler and tells its next run it rested, which
   then reads its records whatever moved. The first 2,000 by
   `at_ms`, newest first (untimed last, ties by hash), are scanned, each read raw at
   `<root>/blobs/<hex[0:2]>/<hex[2:4]>/<hex>`. The facts state how many are left (`owed`). The
   scan of an image no record names any more stands (the image may come back), and takes no part
   in a group.
4. **Group**, by the rule above. It runs over every
   `scan` of the current pipeline with a face of an image a record names (vectors read from the
   blob store, or the run's folder for a fresh scan), every `face` statement (photo and box from
   its key) and every person's `merged_into`. A `seed` face of an image no camera took (no
   `photo` of `cameras:local:<unit>` keys it) is sent as `assign`: it joins a person or a cluster
   under the same bars and never starts a cluster, so a chat image or a screenshot seen thirty
   times makes no group. Its `scan` keeps its tier. The group's Maybe faces become the `maybe`
   records, stated when they differ and `gone` for a person with none. A run that does not group
   drops from them the faces of photos no record names any more (an erasure), as `named` does.
5. **Named and clusters.** Each person's `named` record and each `cluster` is computed again
   every run that reads its records: who each face is from the group, else from the `named`
   records as they stand; a cluster's faces from the group, else from its record (those on a
   photo of the current pipeline); each face's time from its photo's `image`, its crop, tier and
   size from its scan. So a photo a library names after a chat did moves its cluster's
   `chat_share` and its faces' times without a group. A face of a photo no record names any more
   leaves its person's `named`.
6. **Model images**, by the rule above: the `model-image` of each library image with a readable
   current scan, stated when it differs from its head (by version id: a head of an older shape always
   does, so a run that reads its records restates it as boxes and names). `faces` is every face's
   box in face order; `names` is, per face, its person with a person record that shows a name
   (merges followed by the group), `{who: "person:<slug>", shown}`, or null. A chat-only image gets
   no model image.
7. **Deliver** what differs from its head (by version id), every record a fresh scan made,
   `gone` for an `image`, `named`, `cluster` or `maybe` record that no longer stands, and `gone`
   for every `faces` record standing. Nothing differing, nothing is delivered.

**The first run** of a labeler (its cursor at statement 0) reads every input once
instead of step 1: every photo record, and every message that links a file (`linked`). This is
the one whole read a home ever pays: on a home with 2.7 million WhatsApp messages it is minutes
on a cold disk. It is one read transaction: a labeler is handed one view and reads it before its
first await, so the read cannot be paged across transactions. The owner's statements made before
it are no move: it groups when it leaves no scan owed.

The home never starts a run while a delivery of `faces:local:<unit>` waits to land, and the landing
of one makes the labeler due: every run reads what the last stated, and a run that stopped at
its 2,000 goes on with the rest without new input.

It finds a photo's and a chat's images through the photos and messages adapters the home lends it,
and says so (`Labeler.reading`, `borrows: ["photos", "messages"]`). Its cursor carries what it was
read under (home due.ts `labelerFingerprint`): a start that finds the reading's `code` or one of
those adapters changed (a connector installed or removed, a home connector's folder edited, an
adapter's `version` bumped) starts the cursor over, and the next run is a first run, so an adapter
that now finds an image in an old record is read.

An erasure states nothing, but leaves a reread of each extract unit it emptied (the photos family's
burst of an erased photo, the messages family's unit of an erased message): a reread of a unit
past the cursor is how the labeler knows an erasure was made. A release states nothing at all: the
run the home's start wakes reads the records, unless a statement it reads landed first (a chat
image, the landing of its own delivery); then the new pipeline or image shape waits for the next
run that reads its records.

A photo still owed a scan under a new pipeline keeps its faces in `named` and its model image
until it is scanned; its old scan takes no part in a group, and its faces leave their cluster
until then. A face its new scan no longer finds keeps what its record held until the next group.

## One picture

A photo sent to Chat is placed before its question lands, outside the record:
`matchOne(path, anchors)` scans the picture at `path` and names each of
its faces the person the labeler's own group would name it on the people's evidence, else no
one. `faceAnchors(view, unit)` reads what it is placed by, on whatever thread holds a view: each
photo holding a face the owner said is someone (a `face` statement of `people:local:<unit>` with
`is`), with the labeler's `scan` of it as it stands and those statements, and each person's merge.
`matchOne` then runs, in a `match-*` folder of its own under `<root>/tools/faces-work/` that it
removes after:

1. `scan` of the picture alone, under the key `asked`.
2. `group` of the picture and the named photos scanned by the same pipeline, and nothing else:
   every face of a named photo `observe` (the named ones anchor, the rest are no candidates), the
   picture's `seed` faces sent as `assign`. With no cluster to join and none to start, a face is
   placed by step 2 of the engine's group alone: the mean of its two nearest named faces among its
   20 nearest, past the assign bar and the runner-up by the margin, one person per picture.
3. The answer: the pipeline, the picture's size and each face's box with `who`, `person:<slug>`
   (merges followed) or null. A picture the engine cannot decode is `unreadable`, faces none.

It states nothing and moves nothing of a run: no record, no memo, no cursor, and the run's group
key stands. A picture with no face, or with no named photo under its pipeline (a new pipeline the
labeler has not scanned the library by yet), groups nothing and names no one. Unlike a run's group
it reads no cluster, so a face a look-alike's unnamed cluster would have taken may be named the
person it resembles. The models missing and the engine's failures throw as a run's do.

## The memo

Every version of its own records a run reads, and of the owner's `face` statements, it reads
through its memo,
`<machine>/faces/<home id>/memo.db` (core's `openMemo`, opened by the home: the labeler is handed
`memo(version)`, which opens it through the home's folder at registry-home.ts `facesMemo`), on the machine beside the search index, never on the home's
disk. One space per kind (`image`, `scan`, `cluster`, `named`, `maybe`, and `face` for the statements),
keyed by version id, each value
the compact form the run uses: an image's record, a scan's status,
pipeline, vectors and each face's box, tier, size and crop, a cluster's faces, least typical faces
and suggestions, a person's `named` or `maybe` record, what a statement says (`is`, `is_not` or `ignore`: its
content alone, so no history). A version id is the digest of its content, so a value
is never stale. Space `group` holds the key of the last group. The memo's version is the
labeler's code version (`MEMO_VERSION`, the words of what its values hold): a memo of another
version starts empty. It is a pure optimisation: delete it and every run states the same, its
first one slower. A run that reads its records on a warm memo reads only the versions stated
since its last run. The owner's `person` records are read from `home.db` every run that reads its
records: a merge is read from a person's history, and they are few.

## Kinds and keys

`image`, `scan` and `model-image` are keyed by the photo's SHA-256 in 64 lowercase hex,
`cluster` by the engine's cluster id (16 lowercase hex: the SHA-256 of its lowest face key),
`named` and `maybe` by the person's slug. None states a time. A face key is `<photo hex>:<x1>,<y1>,<x2>,<y2>`, its box rounded to whole
pixels in the upright photo, read by core's one reader of it (`parseFaceKey`, `packages/core/people-record.ts`).

`image`, which records name an image the home holds, when, who sent it, and the names its
Google Photos sidecar gives:

```json
{ "library": true, "chat": true, "at_ms": 1791016200000,
  "senders": [{ "kind": "jid", "value": "15550000002@s.whatsapp.net" }], "labels": ["Person B"] }
```

- `library`: a photo record names it; `chat`: a chat message names it. At least one is true.
- `at_ms`: the earliest time a photo record naming it states, else the earliest message's; null
  when none states one.
- `senders`: who sent it, as its messages adapter's `images` says, for each live message naming
  it that is a line of a one-to-one chat the owner did not write: WhatsApp's `ZFROMJID` (unless it names a
  group), else the chat, as a `jid`; iMessage's sender as a `phone` or an `email`, when the sender
  and the recipients are one handle; another network's partner its adapter states by the network's own
  id as a `network`, kept as that handle's id, `<product>:<id>` (a phone, an address or a WhatsApp id it
  spells, as that kind). A group's member, the owner, a status or broadcast session
  and a handle of no person's kind (a short code) name none. Each value is spelled by core
  (`packages/core/handles.ts`), as the labels and People spell that kind: `15550000002@s.whatsapp.net`,
  a LID `…@lid`, `+15550000002`, `person-b@example.com` (`00` before a number reads as its
  international prefix), `example-chat:12345`, so `/v1/labels?id=<value>` names it.
  Sorted by kind then value, each once; only a chat image has any.
- `labels`: the people names the Google Photos records naming it list: each record's
  `people[].name`, its Takeout sidecar's field as the record states it
  ([google](../../photos/google/google.md)), read when its record is read. A record that lists no
  one names nobody. Sorted, each once; only a library image has any.

`scan`, what one pipeline found on one photo:

```json
{ "pipeline": "<64 hex>", "status": "ok", "width": 4000, "height": 3000,
  "faces": [ { "box": [100.5, 120.25, 300.75, 380], "landmarks": [[…], …], "score": 0.91,
               "size": 200.25, "tier": "seed", "crop": "sha256:<jpeg hex>" } ],
  "vectors": "sha256:<f32 hex>" }
```

- An unreadable photo is `{pipeline, status: "unreadable", width: null, height: null, faces: null, vectors: null}`.
- `vectors` is the `n × 512` little-endian float32 file, one row per face in face order; null
  when no face was found.
- `crop` is the face's 160-px JPEG for a `seed` or `assign` face, null for an `observe` face.

`named`, keyed by a person's slug (merges followed): every face the group names this person.

```json
{ "photos": [ { "face": "<hex>:101,120,301,380", "at_ms": 1791016200000, "camera": true,
                "crop": "sha256:<hex>", "tier": "seed", "size": 200.25 } ],
  "labels": ["Person A"] }
```

- Newest first, untimed last, ties by face key. The photo and box are in the face key
  (`parseFaceKey`).
- `at_ms` is its photo's `image` time; `camera` whether a cameras `photo` keys its photo; `crop`,
  `tier` and `size` its scan's (`crop` null for an `observe` face).
- `labels`: the Google Photos names on the photos where this person's face is the only face,
  each once, sorted.
- Stated in every run that reads its records, when it differs from its head; `gone` for a slug
  with no faces. A heavy person's record is about 200 B a face, restated only when their own
  faces move.

`faces`, a per-photo record of who each face was: a delivery states one only `gone`.

`cluster`:

```json
{ "size": 41, "photos": 39, "years": [2009, 2026], "year_count": 11,
  "faces": [{ "face": "<face key>", "at_ms": 1791016200000, "crop": "sha256:<hex>" }, …],
  "outliers": ["<face key>", …], "chat_share": 0.12,
  "suggested": [{ "person": "person-b", "score": 0.61 }],
  "evidence": { "senders": [{ "faces": 23, "kind": "jid", "value": "15550000002@s.whatsapp.net" }],
                "labels": [{ "faces": 9, "name": "Person B" }] },
  "rule": "<64 hex>" }
```

- `size` its faces, `photos` its distinct photos.
- `years` the first and last calendar year of its photos in the home's day zone: a photo's time
  is its library records' earliest, else its messages'. Null when none states a time.
- `faces`: every face of the group, by face key, each with its photo's time and its scan's crop.
  A reader spreads its own sample across them.
- `outliers`: up to 6 of its faces whose `typical` (the engine's cosine to the cluster's
  centre) is below the group's edge bar, the least typical first.
- `chat_share`: the share of its faces on images only messages name, to 2 places.
- `year_count`: how many distinct calendar years its photos span (in the same zone); 0 when none
  states a time. The first run orders clusters by `photos` × `year_count`.
- `suggested`: the engine's suggestions, up to three people with their scores (0 to 1, to 4
  places), best first; never a person any of its faces says it is not, so a group declined for a
  person is never suggested for them again, whatever faces it gains.
- `rule`: the digest of the group rule it was grouped under (`GROUP_RULE` in labeler.ts, the
  words of what the labeler asks the engine): a cluster of another rule makes the next run group.
- `evidence`: the senders and labels of its faces' images, each with how many of its faces it
  touches: the five touching most of each, then by value (a sender's, then its kind) or name.

`model-image`, the faces a caption ask draws on the photo it shows the model:

```json
{ "drawn": [ { "name": "Person A", "box": [600, 300, 900, 700] } ] }
```

- `drawn`: each face whose person shows a name, that name and its box in the upright photo, in
  the scan's order; empty when no face is named. It names no blob.

`maybe`, a person's Maybe faces: faces no person or cluster took whose best person is this one,
at least the engine's `maybe` bar (0.48), and whose `is_not` does not name them:

```json
{ "faces": [ { "face": "<face key>", "score": 0.52, "crop": "sha256:<hex>" } ] }
```

- Best first (ties by key), at most 200, each with its scan's crop. Kept apart from `named`
  because it moves with every group. Stated by a run that groups when it differs from its
  head; `gone` when the person has none. The Faces page's check cards offer them: yes states `{is: slug}`, no `{is_not: [slug]}`, and
  the next group takes the face out.

## Restating the image records

A release that changes what an `image` record holds restates every one: the labeler's next run
finds each record its guard refuses and reads that image again from the versions that name it
(`view.naming`, a seek on `version_blobs_blob` per image), a Google Photos record's people read
from its own content. On the live home's 94,793 images that is about 95,000 seeks, in one read
transaction of the labeler's helper, then one delivery of about 95,000 `image` lines (about
20 MB), never the first run's whole read of every message.
Cluster records follow in the same run, since they are computed every run from the images.

A `model-image` that states the JPEG drawn and its size is restated as its names alone by the next
run that states model images (step 6), one line each from the labeler's own records, no input
read: on 45,787 model images, one delivery of under 10 MB. Until then the photos family reads
its `drawn` as it reads the names alone, and the JPEGs it named are named by no head after.

## The delivery

`faces.ndjson`, one line per record: `{"content":…,"key":…,"kind":…}`, or
`{"gone":true,"key":…,"kind":…}` for `image`, `named`, `cluster`, `maybe` and `faces`. Beside it, every file a line names,
called by its own SHA-256: `<hex>.f32` (vectors) and `<hex>.jpg` (crops). Each
`scan` row lists the blobs its content names; the crops a `named`, `cluster` or `maybe` record
names are its scans', and its row lists none.

The connector reads and checks every line before it gives the first row, and refuses the whole
delivery when:

- a line is malformed, or fails its kind's guard (exact members, a box inside the image, a
  `named` record's faces newest first, a cluster's faces by key, and so on), or states a `faces`
  record's content;
- a file a line names is not one of the delivery's;
- the delivery holds a file other than these, or one not called by its hash.

The facts are `whole` (the run read every input), `images` (the `image` records it states),
`photos` (every image it holds), `pipeline`, `scanned`, `unreadable`, `owed`, `sources` (its own
source, which the home makes), `grouped`, and when it grouped `faces`, `maybe` (the people with
Maybe faces) and `unmatched` (statements that found no face), then `clusters`. The report reads
`owed` as the photos left (its history line).

## Erasures

The photos family's erasure of a photo and the messages family's erasure of a message take the
image's `image`, `scan` and `model-image` records, its `faces` record (its history names the
photo's faces) and the owner's `face` statements
about it, with their blobs (vectors, crops), unless another record still names
the image ([families/shared/labelers.ts](../../../families/shared/labelers.ts)).
An erasure makes the labeler due though it states nothing; the run it wakes reads the labeler's
records (it knows of the erasure by the reread the erasure leaves), groups (its scans left the
current ones, so the key moved) and restates the `named` and `cluster` records that lost a face.

An erasure that leaves the image named (one of two records) states nothing the labeler reads, so
the image's `image` record keeps its flags and time until a record naming the image moves
again: until then its cluster's `chat_share` and `years` may count the erased record.

A `named`, a `cluster` and a `maybe` name faces of many images, so no erasure takes one: the group
the erasure's run makes drops the erased face from them.

## Delete all face data

`lifestream faces forget` (packages/home/verbs/faces.ts) turns faces off and removes, in one run and
without refusing anything again, every record of `faces:local:<unit>` but its `model-image`
records, and every `face` statement of `people:local:<unit>`, with the blobs only they named, this
source's deliveries in the inbox, the `label:faces` cursor, this labeler's work folder and its
memo (`named` goes with the rest). A model
image holds only the names on its photo's boxes, which the caption holds already: removing it
would build every photo's unit again with nothing drawn, and once faces is on again keep every
caption off the day until its photo is scanned again. On again,
the next run is a first run, and states again only the model images whose names changed.