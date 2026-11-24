# cameras

The cameras labeler and the connector that reads what it delivers. For every photo the home
holds, it says which camera took it and where, when its EXIF states a GPS position, and for every
camera how many photos it took and when: the
home's list of the owner's devices as the photos know them. The labels family joins each camera's
count with the owner's word on it ([devices](../../devices/devices.md)) into whether the camera is
the owner's, so that only the owner's own photos say where the owner was.

## Source

`cameras:local:<home>`, where `<home>` is the home machine's unit (the `unit` setting), as the
faces labeler's is. The labeler writes its deliveries; nothing else ships to this source. Its
facts name the source and its connector (`sources`), so the home makes the source with the first
delivery: a new home needs nothing set.

## What the labeler reads

The records of every photo source: the sources of each product a photos adapter is registered for,
of the kinds those adapters read, the adapters the home hands the labeler in its settings (`photos`).
A record's image is the one its adapter's `image` says it shows
([shared/photo-image.ts](../../shared/photo-image.ts) `photoImage`, the rule the faces labeler reads by), and
the image is held when the blob store has it. A paired phone's own photo (its library's, by its
local identifier however many snapshots and availabilities state it; its in-app camera's, by its
record) is known by `phonePhoto` in the same module, with the time it was taken: an availability
is timed when the phone fetched the bytes, so its photo's time is its asset's. Only the phone's own
pass makes a photo the phone's: a record of a source its adapter's `paired` says a paired device's
own pass delivered (the phone's library's and in-app camera's), never one of the product
`apple-photos` alone, so a Mac's library, whose rows state no device, counts under no camera until
its file names one.

## A camera

A camera's id is its EXIF make and model ([shared/exif.ts](../../shared/exif.ts) `cameraId`, the
one rule): each lower-cased, each run of any character but a letter or a digit one dash, with no
dash at either end, joined by `/`. `Apple`, `iPhone 17 Pro` is `apple/iphone-17-pro`;
`iPhone SE (3rd generation)` is `iphone-se-3rd-generation`; `SONY` and ` Sony\0` are one make. An
image whose EXIF names no make or no model has no camera.

- **Held images.** Each image's EXIF is read once, when a record naming it first moves, from its
  first 256 KiB, extending only as far as its offsets require, through the blob store's
  `prefix` and [core/exif.ts](../../../core/exif.ts): a JPEG's APP1 segment, a HEIF's (HEIC's)
  `Exif` item (its extents joined), or a bare TIFF. No pixels are decoded.
  - The camera is the EXIF's make and model, whichever route sent the file: the same bytes, the
    same camera.
  - The GPS is the EXIF's latitude and longitude, degrees, minutes and seconds summed, south and
    west negative, as the camera wrote them; none when either or its hemisphere is missing, or the
    receiver marked it void (`GPSStatus` `V`).
- **A paired phone's photo with no image held** (its library photo whose original the phone has
  not sent, or its in-app camera's whose bytes have not arrived) has the camera
  `phone/<unit>`, the phone whose source states it (`apple-photos:<account>:<unit>` read by
  `photos-ios-bundle`, `camera:local:<unit>`). When the original arrives (an availability, a blob arriving), the photo
  is counted under the camera its EXIF names instead.

The same camera is the same id whichever source or phone delivers it: a phone reinstalled under a
new unit, a Takeout of its photos and its own library all count under `apple/iphone-17-pro`. Two
people's cameras of one make and model are one camera; the owner's dated word is the tool for that.

## One run

The home runs the labeler after an import of its inputs moves a photo record (statements of those
sources, a record read again when a blob it wanted arrives, an erasure), when its own delivery
lands or an undo or a repair restates its own records, and once at start; never while a delivery
of its own waits to land.

1. **What moved.** The photo records stated since its cursor (`label:cameras`), those read again
   since, and whether an erasure was made. Nothing moved (its own delivery landing, the home's
   start): the run reads nothing more and delivers nothing; its own delivery's statements are of
   origin `source`, so their landing never makes it read an image. Its first run (cursor 0) takes every
   record as moved, and reads every held image again, its own records notwithstanding; so does a
   run after an undo or a repair restated one of its own records since its cursor (a statement of
   origin `repair`, read up to the first): a record undone is stated again.
2. **The census.** Every live photo record is read once: the held image each names, the earliest
   time a record naming it says it was taken, and the paired phones whose own photo it is; and each paired phone's photos none of whose records
   names a held image. This is the run's
   one read that grows with the home: on the first home, about 46,000 records (45,227 Google
   Photos, 745 of the phone's library).
3. **Read the images owed.** Each held image a moved record names that has no `photo` record yet (on a first run, every held image).
   Its bytes never change, so an image with a record is never read again. The view's read
   transaction ends before the first image is read.
4. **State** a `photo` for each image read whose EXIF names a camera (when it differs from its
   head, the GPS included), `gone` for each `photo` whose image no live record names any more, or that a reading
   finds names no camera, and each `camera` counted again from the photos as
   they stand: stated when it differs from its head (by version id), `gone` for a camera with no
   photo left. A camera keeps the make and model it was first named by; a new one takes the
   spelling of its lowest-hashed image read in the run.

A photo deleted, stated with another time or erased moves the counts in the run it wakes, as
surely as a new one: they are made again each run, never added to.

## Kinds and keys

`photo`, keyed by the image's SHA-256 in 64 lowercase hex: the camera that took it, and `gps`
when its EXIF states a position (absent otherwise). An image whose EXIF states a position and no
camera has no record: an unknown camera places no one.

```json
{ "type": "cameras.photo", "camera": "apple/iphone-17-pro", "gps": { "latitude": 48.853, "longitude": 2.3499 } }
```

`camera`, keyed by the camera's id: how many photos it took, the first and last of their times
(null when none states one), and one photo's blob to show it by: its newest held image, ties to
the lower hash (null when the home holds none, as for `phone/<unit>` while its originals wait).
`make` and `model` are as the EXIF first spelled them, trimmed; null for `phone/<unit>`.
`phones`, sorted, are the paired phones this camera is: each phone whose own photos
(`phonePhoto`: its library's, its in-app camera's) that name a camera this camera took the most
of, the lower id on a tie. Nothing is read from the phone's unit, which may be its model's name
(`iphone-17-pro-0042`) or its machine id (`iphone17-1-aa01`). A screenshot or a saved image names
no camera, so a phone's own camera is its phone from its first photo; a friend's photo saved into
the library is one among the phone's own, and makes its camera nobody's phone; a Takeout's photo
is no phone's own photo, and adds no phone. A camera that is a paired phone is the owner's from
its first such photo ([labels](../../../families/labels/)), and stays so while it took
the most of the phone's photos.

```json
{ "type": "cameras.camera", "make": "Apple", "model": "iPhone 17 Pro", "photos": 812,
  "first_ms": 1756684800000, "last_ms": 1791016200000, "sample": "sha256:<64 hex>", "phones": ["iphone-17-pro-0042"] }
```

Neither states a time. A `camera` record names its sample in its content only: it links no blob.

## Erasures

The photos family's erasure of a photo (and the messages family's of a message showing an image)
takes the image's `photo` record with the faces labeler's records of it, when no other live record
names the image ([families/shared/labelers.ts](../../../families/shared/labelers.ts)). An erasure
leaves a reread of the unit it emptied, so the run it wakes counts the camera again without the
photo; the erased record is refused forever, never stated again.

## The delivery

`cameras.ndjson`, one line per record: `{"content":…,"key":…,"kind":…}`, or
`{"gone":true,"key":…,"kind":…}`. The connector reads and checks every line before it gives the
first row, and refuses the whole delivery when one line is malformed or fails its kind's guard
(exact members, a key of its kind's shape, a camera id by `isCameraId`, a `gps` of exactly a
latitude within 90 and a longitude within 180, at least one photo, first
not after last, a make and a model both text or both null, phones sorted units). The facts are `whole` (a first run),
`read` (images whose EXIF it read), `photos` and `cameras` (the lines of each), and `sources`.

## Who reads it

- The photos family ([photos](../../../families/photos/)) reads each image's `photo`
  record for whether its photo is a photograph (`cameraOf`), and so captioned: a change of one
  touches the bursts its photos are in.
- The physical family ([physical](../../../families/physical/), "Photos") reads each
  image's `photo` record for its photo's camera (`cameraOf`, the same rule), and its `gps` as the
  photo's position when its record states none (`where` then groups the owner's photos into
  sightings): a change of one touches the days its photos are on.
- The labels family ([labels](../../../families/labels/)) reads the `camera` records
  beside the owner's word into one `camera:<id>` unit per camera, which holds no count: a run that
  moves a count changes no unit a day reads.
- The faces labeler ([faces](../faces/faces.md)) reads the `photo` keys: a seed face starts a
  group only on an image a camera took, and a `photo` stated makes it group again.
- The door's `GET /v1/devices` (door.md) lists the cameras
  with these counts and the labels' verdict.

## A change to what a reading states

It reads its photo records through the photos adapters the home lends it, and says so
(`Labeler.reading`, `borrows: ["photos"]`). Its cursor carries what it was read under (due.ts
`labelerFingerprint`): a start that finds the reading's `code` or a photos adapter changed (a
connector installed or removed, a home connector's folder edited, an adapter's `version` bumped)
starts the cursor over, and the next run is a first run, so an adapter that now finds an image in
an old record is read. A release that changes `cameraId`, or what a `photo` record states (the GPS
joined it), bumps the reading's `code`: the next start restates each `photo` the old rule stated
otherwise.
