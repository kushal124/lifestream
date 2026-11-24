# Google Photos Takeout: `google-photos:<account>:export`

## What it reads

The Photos folder of an account's Takeout, `Takeout/Google Photos/<album>/…`, read in place in
each file of the import (a zip, a gzipped tar, or a folder handed in) through
`shared/members.ts`. The connector declares `export: { recognise: ["Takeout/Google Photos/**"] }`:
the Takeout listing routes a file holding that folder to this source
(`imports/reads.ts`, [imports.md](../../imports/imports.md)). A delivery
whose facts name another `account` reads nothing.

- **A photo or video** is a member whose first bytes are a photo's or video's, as core's one sniff
  names them (core/media-type.ts `mediaTypeOf`: JPEG, PNG, GIF, WebP, BMP, HEIF, AVIF, TIFF, an ISO
  video, a QuickTime movie with no `ftyp`, Matroska, AVI, ASF, an MPEG program or transport stream);
  any other member that is no JSON is refused by its path. Each is one `img`, its sidecar the member named
  `<name>.supplemental-metadata.json`, the suffix cut short as Takeout cuts it to fit the name's
  51 characters (`.supplemental-meta.json`, `.supplement.json`, `.s.json`, …).
- **A copy** of one name, `IMG_0003(1).jpg`, is paired with its sidecar by the sidecar's own
  `title` and the `(n)` in the sidecar's name (`IMG_0003.jpg.supplemental-metadata(1).json`).
- **A Live Photo's video** (`IMG_0005.MOV` beside `IMG_0005.HEIC`) and a **motion photo's `.MP`**
  are records of their own; with no sidecar of their own name they read the still's. An **edited
  copy** (`IMG_0003-edited.jpg`), a file of other bytes, is a record of its own and reads its
  original's sidecar. Each of these keeps its own name as its `title`: the sidecar's names
  another file. The records stay apart; the adapter reads a still and its video as one photo
  (below). The names Takeout gives (a copy's `(n)`, `-edited`, the `.MOV`/`.MP` that read a
  still's sidecar) are read in one module, `names.ts`, which the reader and the adapter share.
- **The sidecar's fields** are the record's content as stated (`title`, `description`,
  `photoTakenTime`, `creationTime`, `geoData`, `geoDataExif`, `people`, `url`, …), beside
  `type` and `blobs`, which are the content's own: a sidecar stating either is refused. The
  album a photo lies in and the file of the archive it came in are never stated; a photo in two
  albums is one record.
- **Albums** are no record: an album's `metadata.json`, `shared_album_comments.json` and every
  other JSON that is no sidecar are kept text the reader leaves (the sweep copies them out).

A row states no device: a photo's camera is its file's EXIF, which the cameras labeler reads
([cameras](../../labelers/cameras/cameras.md)). A stored delivery whose facts name a
`device_map` reads the same: the fact is ignored.

## Kinds and keys

| Kind | Key | Content | Time |
|---|---|---|---|
| `img` | the SHA-256 of the photo's or video's bytes, 64 hex | `{type: "photos.asset", …the sidecar's fields, blobs: [{hash, bytes, media_type, role: "original"}]}` | the sidecar's `photoTakenTime`, else its `creationTime`, Unix seconds (zero is unset), UTC |

## Rules

- **A photo and its sidecar in two files.** Takeout splits an archive into files by size, and a
  photo may lie in one file and its sidecar in the next. The home hands the reader the archive's
  other sealed files that feed this source, as the delivery's `beside` fact
  ([import.ts](../../../home/import.ts)). A read states every photo and video of its own files,
  its sidecar read from any of them; a sidecar of its own files whose photo lies beside is the
  photo's file's to state.
- **Waiting.** A photo whose sidecar no held file has is refused by its path, "waiting for its
  sidecar"; a sidecar whose photo no held file has, "waiting for its photo". The delivery stays
  unread; when another file of the archive lands, the home clears the read of the source's
  refused deliveries of that archive (`indexArchive`) and reads them again, and the sweep keeps
  the new file until they have.
- **A photo with no time** (its sidecar states neither `photoTakenTime` nor `creationTime`) and
  a **sidecar that does not read** are refused by the photo's path.
- **Consumed.** A read that refused nothing states each of its files consumed (`consuming`):
  every photo and video is a record's blob, every sidecar's fields are in a record. The sweep
  then lets the file go.
- **Size.** A photo or video of a zip is handed to the home as a stream (`shared/members.ts`
  `stored`, the path every reader stores a member by: the row's `streamed`, core's
  `BlobStore.putChunks`): its bytes are hashed in chunks as the reader reads them, and
  read again in chunks as the home stores them, so a video of any size holds one chunk in memory.
  A photo the home already holds is not read again.
- **Once per archive.** A photo in two files of one archive (Takeout repeats a photo in each
  album it lies in, and the albums may fall in two files) is stated by the first file, by its
  `files/<name>`: a later file's photo of the same name and size whose bytes hash the same is
  skipped. Its sidecars are indexed by name, and a sidecar's fields read again when its photo
  needs them, so a read holds names, never every sidecar's fields.
- **A later export** restates what it holds; a photo it lacks is never stated gone.

## The records before

A home that landed Google Photos through the index route before this reader holds `img`
records under the same key whose content names the photo's places (`takeout_sources`) and keeps
each sidecar as a blob (`raw_sidecar:<member path>`). `photos-repair.ts` states each again as
this reader states the same photo: its sidecar the one whose `title` or own name names the photo,
else the first by member path, its fields with the original alone, the original's media type from
its first bytes, timed by the sidecar. Every key stays, so items, people, places and faces keep
the record; every original stays a blob. It imports the SDK alone, which the repair resolves
to the running release's (the reader imports its content, time and naming from it), proven
by packages/home/repair.e2e.test.ts, and run once per source on the owner's home
(repair.md):

```
lifestream repair --source google-photos:<account>:export --kinds img --reason "a Google photo is its sidecar's fields" --fix packages/connect/photos/google/photos-repair.ts --apply
```

## Its adapter

`adapter.ts`, the photos family's: keyed by each original's hash
(`keyed`), a record's file its key, its name the sidecar's `title` whole (a `(1)` in a still's
name is the person's own: `download (1).jpg`), a video when its file's media type is `video/`, its
place the sidecar's `geoDataExif` (zero, zero is unset); it ranks 2, after every library. The image
a record shows (`image`) is its key, when its first blob is that file and states a media type that
is no video's: the labelers read no video as a picture.

**A copy is one record, or a still and its companion** (`companionOf`): the video of a Live Photo
or of a motion photo is part of its still's photo, one line, one tile. A video V and an image S of
the source at one instant (V is timed by S's sidecar) are a pair when, both names less a copy's
mark, V's ends `.MOV` or `.MP` (any case) and S's name less its extension is V's less its own
(`IMG_0001.HEIC`, a Live Photo) or V's whole name (`PXL_….MP.jpg`, a motion photo); S is an original
still (an edited copy, `IMG_0001-edited.jpg`, is never a companion, so its video stays its own
photo); and S is the only such still V meets, V the only such video S meets: two stills meeting one
video, or one still two videos, make no pair, nothing guessed. One read of the source's heads at
the record's instant answers it, the same from either record. A pair's copy is the still's (`id`
its key) for either record: its records both, its names the still's and the video's, not a video,
its original the still, its motion the video, its files both, its resources the still
(`original`) and the video (`motion`), each its name and bytes, its time the still's; the video's
name less a copy's `(n)` before its first dot (`IMG_0001(1).MOV`, `IMG_0001.MOV`), as its camera
named it. A record in
no pair is its own copy. Takeout states no video's length.
