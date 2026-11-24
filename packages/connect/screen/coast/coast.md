# Screen: Coast

One of two screen sources. The screen family reads Coast before the recorder's first frame and
the recorder ([macos-app/screen](../../macos-app/screen/screen.md)) from then on.

## `coast:local:<unit>`

**Reads** `coast.sqlite`, a window of Coast's `rem.db` in Coast's own schema, with the videos its
frames point at as `videos/<video.path>` and, for videos an earlier delivery carried,
`videos.json` (blob index: `video.path` to blob). The facts `kind: "delta"`, `after`, `through`
name the window's frames by `frame.id`; the file's other frames are context. A delivery without
them (a whole store) states every frame. A delivery with no file states no row.

**Schema shapes.** `hash` (AX nodes keyed by payload hash: `ax_node.hash`,
`ax_snapshot.root_hash`) and `id` (after Coast's `ax_id_schema_switch`: `ax_node.id`,
`ax_snapshot.root_id`, `ax_node_hash(hash, node_id)`). Any other shape refuses the delivery with
`CoastShapeUnknown`, naming the shape. Within a known shape a row is the
unit: a frame, a session or an AX snapshot that cannot be stated is refused alone, among them a
snapshot whose tree names a node the store lacks or holds a node of an AXN2 version this connector
does not read.

| Kind | Key | Content | Time |
|---|---|---|---|
| `frame` | frame identity: `timestamp` digits, `:<rank>` for the 2nd, 3rd frame of a millisecond by `frame.id` | `screen.frame`: frame_id, timestamp_ms, width, height, is_inactive, image_path, foreground, background, title, capture_display, video `{hash: video.path, index}`, session_start_frame_identity, windows (each with its application), in canonical order | `timestamp`, ms |
| `session` | its first frame's identity | `screen.session`: start_frame_identity, application, domain?, url?, frames (identities in time order) | first to last frame |
| `ax` | its frame's identity | `screen.ax`: frame_identity, root_hash, timestamp_ms, application_name, bundle_id, process_identifier, extraction_mode, is_partial_tree, tree (`{hash, node, children}`, AXN2 v2 decoded; non-finite geometry left out) | `timestamp_ms`, ms |

A frame names its video's blob when the delivery carries or lists it; a later delivery of the same
frame that carries a video an earlier one lacked links it to the stored version.

**Acquirer** `coast`: polls the live `rem.db` read-only, copies the frames after its cursor that
have settled (`settle_ms`, default 2 min) and at most `max_frames` (default 20,000), with their
sessions' earlier frames and same-millisecond frames as context, the AX nodes their trees reach
(a snapshot naming a node the store lacks is left out and counted), and `VACUUM INTO` the file.
Cursor: the newest sealed frame's id and timestamp; when that frame no longer holds that
timestamp, the window starts after the timestamp. The videos the last window named, by path with
their blobs, are the poll's memory (part `video`), replaced by each window's, so the next window
lists a video it shares by blob instead of carrying it. Statement time: the settle line, or the last
frame's time when the cap stopped the poll, which then says so (`more`) and the home polls again
at once. Nothing new seals nothing: the fetch states the settle line as the source's read-through
(`read_through`), which the home applies as a value. Its history is that one forward walk from the stream's
start (`lent.start_ms`), with no page of its own, so it declares no pace; a paced history, frames below the first sealed, is deferred.
A start moved later than the cursor's frame seats the walk at it; one moved earlier than the start the cursor was left
under (`lent.from_ms`) opens a gap in the cursor (`gap: {after, through}`, frame ids from the new start to the first
frame of the old), walked first, window by window (`window: "gap"`, `more` until it ends), the walk's own place kept.
Every call moves the gap's `after` up to the first frame at or after the start it is lent, so a start moved later
mid-gap reads nothing before it, and a gap with nothing left at or after the start is dropped.

## Its adapter

`adapter.ts`, the screen family's: role `prior`, the screen read
before the cutover, its kinds `frame`, `session`, `ax`. The family reads the records whole.
