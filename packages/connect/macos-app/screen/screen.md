# Screen: the Mac app's recorder

One of two screen sources. The screen family reads Coast ([screen/coast](../../screen/coast/coast.md))
before the recorder's first frame and the recorder from then on.

## `screen:local:<unit>` (storage v2)

**Reads** `observations.jsonl`, one line per frame or gap run in capture-folder order; text
segments and video segments are the lane's blobs, named by SHA-256. Shipped as deltas. The Mac
sends no pending image and no `frames_pending` fact: the reader still reads a frame's `{pending}`
image for the deliveries a home already holds, and a frame's `pending` member is always null. A line that does not read (not one JSON object, out of folder order, an
instant core cannot read, a proof that fails) is refused alone, named `observations.jsonl:<line>`,
and the next line is read. A line whose `capturedAt` reads takes its rank before any later check,
so a code that reads more of a line never moves another line's key; folder order is held against
the last line whose row was read.

| Kind | Key | Content | Time |
|---|---|---|---|
| `frame` | `capturedAt` floored to the ms, basic form (`20261001T094919.403Z`), `:<rank>` by capture folder | `screen.lifestream.frame`: the observation as it arrived without `imageFile`, plus `image` (`{archive}` or `{pending}`) and, when packed, `text` and `blobs` (the text segment) | `capturedAt` to `capturedUntil` |
| `recorder` | the gap's `capturedAt`, the same spelling and ranking | `screen.lifestream.gap`: the first gap verbatim, plus `run` | first attempt to the last attempt's end |

A frame names its video segment and text segment blobs; one shipped with no image names neither
picture (`archive` and `pending` null).

**Gaps.** A gap's `reason` is a free string, stated as written. A lasting state is two gaps: an
opening gap when it began, then a span gap (`capturedUntil` set) when it ended, from one interval
after the opening to the end. The display asleep, the person idle (`input-inactive-capture-paused`)
and the full disk (`storage_backpressure`) are stated so; an idle or full-disk span may arrive in a
later delivery than its opening gap, after its sitting closed, and changes no extract (a sitting
reads gaps only inside its own span, `packages/families/screen/frames.ts`). Two reasons are a
single span gap:

- `storage-failed`: the spool could not be written for a cause other than a full disk, from one
  interval after the last saved observation to the store's next opening.
- `recorder-not-running`: the recorder ended without its cleanup (a crash, a forced quit, a hung
  Mac), from one interval after the newest observation it had saved to its next opening. What the
  Mac did meanwhile is unknown; the machine stream's sleep and wake lines stand beside it.

A frame's `pageStale` member stops appearing: the Mac no longer recalls a browser page. The reader
admits it in the observations a home already holds.

## The bundle

**The bytes are the evidence.** The recorder's metadata packet holds the observation as its JSON
encoder wrote it (sorted keys, millisecond dates, `/` as `\/`, shortest number spellings).
Nothing on either side decodes an observation and encodes it again, because re-encoding can move
a number by a unit in the last place unseen: everything moves by byte spans of the packet JSON,
and every proof is SHA-256 over it. The top-level `capturedAt` is the frame's instant; the
accessibility snapshot's own `capturedAt` sorts first in the bytes, so nothing takes "the first
`capturedAt`".

`observations.jsonl`, one line per frame or gap run, in capture-folder order:

- **A frame with a text segment:** `{"bundle","observation","archive","pending","text"}`.
  `observation` is the reduced observation: the packet JSON with `accessibility.nodes`, `ocr` and
  `windows` cut out, each as `"name":<value>` with the comma before it, or after it when the
  member is first in its object; it is valid JSON and keeps every other member. `text` is
  `{"segment":"<uuid>.lstext","segmentSHA256":<base64>,"ordinal":n,"observationSHA256":<hex>,"segmentBytes":n}`;
  `segmentBytes` lets the home list the blob before it arrives.
- **A frame inline:** the same line with the packet JSON whole and `text` null. Inline is always
  legal.
- **A gap or gap run:** `{"bundle","observation","run"}`. `observation` is the first gap's packet
  JSON verbatim; `run` is null for a single gap, else
  `{"attempts":[[<bundle>,<capturedAt>,<capturedUntil>|null,<inputIdleSeconds>|null],…]}`, every
  attempt in order, the first included, each value the encoder's exact token as a JSON string,
  null when absent. Two gaps are one run when their packet JSON is byte-identical with those three
  values blanked, each member present in both or absent in both; a run is consecutive across all
  observations (a frame or a different gap ends it) and never crosses a UTC hour. The tokens put
  back into the first gap rebuild every gap byte for byte.

**A text segment** packs the three arrays of every captured frame in one five-minute UTC window,
across all displays, each distinct array once. The file is Brotli of one body: a header line of
JSON ending in `\n`,
`{"format":"org.lifestreamprotocol.screen-text/1","window":[<start µs>,<end µs>],"arrays":[[<offset>,<length>],…],"frames":[{"bundle","displayID","observationSHA256","splices":[…]},…]}`,
then the arrays region, each array's raw bytes at its offset. A splice is
`{"at","before","array","after"}`: the byte offset in the reduced observation where the array goes
back, the exact bytes around it (`,"ocr":` and `""`), and the array's index; splices apply in
descending `at`. The header names everything a frame needs, so a segment proves itself without
the Mac. It travels as a blob named by the hex SHA-256 of its bytes, beside the frame's video
segment or pending image.

**The proof.** For every frame with a text reference, once the home holds its segment,
SHA-256 of the reduced observation spliced with the segment equals the reference's and the
header's `observationSHA256`, and the header's frame at `ordinal` names this `bundle`
(`text.ts`). A mismatch refuses that frame's line; a segment not yet held leaves the frame naming it.
Readers take a frame's text from its segment (`packages/families/screen/frames.ts`), one
decompression per segment for a stretch of frames.

**Deleting.** A segment is one blob for up to five minutes of text, so removing one frame's text
means a new segment and new records for every frame in its window.

## Ledger

How the Mac keeps custody of this source: each seal's ledger entry holds the runs of observation folders it carried per day, the segments its frames named, the blobs it sent, and how many observations of its days this Mac has since deleted. `ScreenSpoolDomainTests` and `ScreenTextShippingTests` hold each answer.

1. **Order.** `<day>/<bundle>`, a UTC day and a 20-digit microsecond instant with a UUID: a label, never the order. A seal reads the names after the newest carried, and on a day whose folders are not exactly the runs carried, the late names too. A backlog that does not fit one bundle ships the names from the start of the previous UTC hour at once, and the older ones in history pages (`history: true`), oldest first, one while the home has imported all it received.
2. **Reuse.** No: each name holds a fresh UUID.
3. **Rebuilds.** Deleting the spool loses nothing the home holds.
4. **Late arrivals.** A clock that stepped back, or a bundle held for `CLOCK_AHEAD` while the clock was wrong, names an observation behind the newest carried: it ships with the next seal. (Measured over three days: none appeared after a higher name.)
5. **Edits.** None once settled: a frame waits for its segment and its text first.
6. **Lost.** A day leaves once every seal that carried it is imported, it ended more than seven days ago, and its folders are exactly the ones carried. After a restore below, the next bundle states `<n>` `screen observations, up to that many: this Mac deleted them after an earlier import`, and the same seal sealed again states it again.

## Its adapter

`adapter.ts`, the screen family's: role `frames`, a sitting's
frames from the cutover on, its kinds `frame`, `recorder`. The family reads the records whole.
