# Apple Photos on a Mac: `apple-photos:<apple id>:<mac unit>`

**Reads** `photos.jsonl`, the Mac app's delivery of the library macOS calls the system library
(with iCloud Photos on, the person's iCloud library), read through PhotoKit by the PhotoLibrary
package the phone's app shares, whose photo
pass, the phone's own, writes it. One entry a line, `{"kind": "asset" | "resource_availability" |
"gone", "observed_at": <RFC 3339>, "payload": <the phone's payload for that kind>}`, each payload
byte for byte as the package wrote it; each resource's bytes are a blob the delivery carries, as a
Mac bundle carries any file a row names. A delivery with no `photos.jsonl` lands nothing.
`test/mac-bundle.zip` is a bundle the Mac app sealed (`macos-app`'s `PhotosDomainTests` writes
it), which `e2e.test.ts` reads.

One entry reader (`entries.ts`) reads the phone's library (`photos-ios-bundle`,
[ios-app](../../ios-app/ios-app.md)) and this one, so a photo is keyed, timed and stated the same
whichever library states it:

| Kind | Key | Content | Time |
|---|---|---|---|
| `img` ← asset | `<local identifier>:<modification>`, the modification instant in UTC basic form with every significant fraction digit the library wrote (`20261003T031105.123451Z`), or `null` | `{type: photos.apple.asset, content: <the payload>}`, every member as stated, `cloud_identifier` among them | its `creation_date`; none when null |
| `img-file` ← resource_availability | `<asset key>:<digest>`, the digest `sha256:<hex>` of the sorted, distinct `[type_raw, uti, original_filename, blob hash]` of each resource it names a blob for | `{type: photos.apple.availability, content: <the payload>}` | `observed_at` |
| `img` or `img-file` ← gone | the key of the entry it ends, worked out from `payload.payload` as that entry's kind (`payload.of`: `asset` or `resource_availability`) is kinded and keyed | none: the record is stated gone | none |

- An asset is a snapshot of one image or video; an edit is a new modification, so a new record.
  An availability states the files the Mac holds of a snapshot, fetched or rendered after it
  stated the snapshot; a resource it could not fetch is `blob: null, not_local: true` with its
  `not_local_reason`. `not_found` and `download_failed` are the library saying it cannot send the
  photo, which the home passes over for it; any other reason is for later ([photos family](../../../families/photos/)).
  An availability is its own kind, `img-file`, never `img`: it is timed when the device fetched the files, so a count of
  photos (the connector's `counts: ["img"]`) counts what was taken, never what arrived. Every reader of a photo's files
  (the photos family, the cameras and faces labelers) reads both kinds.
- No row states a device: the Mac took none of these photos. A Mac's photo counts under no
  camera until its file names one (the cameras labeler), and never places the owner by itself.
- A row lists every blob its resources name; one the delivery does not carry and the home does
  not hold lands wanting it.
- Refused alone, by the `img` and `img-file` guards: an asset that is neither an image nor a video, a resource
  without its type, `type_raw`, `uti`, `original_filename` and a blob or `not_local`, a
  `cloud_identifier` that is not text or null. Refused alone, its line (`photos.jsonl:<n>`), and
  the next line read: a line that is not JSON, one without `observed_at` or a payload, an entry
  kind neither app writes, a local identifier that is empty or holds a colon, a `gone` that does
  not name the entry it ends.
- **A deletion is a `gone` per entry the library stated of the photo**: the record it ends is
  stated gone, and its statements and files stay. The photo leaves its burst, the days and the
  wanted list once no route states it live. A photo missing from a delivery is never gone.
- Which files the Mac sends is the home's to say: it asks `GET /v1/photos/wanted`
  (door.md).

## Ledger

How the Mac keeps custody of this source (the PhotoLibrary package):

1. **Order.** The spool's entries, in the order the pass wrote them: the first read is the whole
   library, newest first, 5,000 photos a page, each once the home imported everything the Mac sent;
   then what the change history says was added, edited or deleted since the last token, without
   files; files only for the wanted list. A seal carries the entries after the last one a seal up
   to `received` carried, at most 20,000 and 256 MB, the rest the next run.
2. **Reuse.** None: a local identifier names one photo, and an edit is a new key.
3. **Rebuilds.** A pruned token or a replaced library is read whole again: every snapshot
   restates, nothing is added.
4. **Late arrivals.** A photo synced late into the library is in the change history, and ships.
5. **Edits.** A new modification, a new snapshot; its files ship only when the home wants them.
6. **Lost.** Nothing: the Mac deletes a fetched file once a seal the home imported carried every
   entry that names it, and fetches it from the library again if the home asks for it again.

## Its adapter

`adapter.ts`, the photos family's: a library (`library`), whose
copy is every record of one local identifier read through its newest snapshot (`copy`), its
availabilities timed by their snapshot (`placedBy`), its place the snapshot's `location`
(`position`). The phone's library (reader `photos-ios-bundle`) ranks 0 and holds the paired phone's
own photos (`paired`); a Mac's ranks 1. The image a record shows (`image`, what the faces and cameras
labelers read): a snapshot's render of its current edit (`fullSizePhoto`) where it holds one, else its
original (`photo`), none where two of the one type differ or for a video; an availability's, its
snapshot's as the source holds it now, with the availability's files.
