# Uploads: `upload:local:<unit>`

The files a person hands the home: whatever they place in the Mac's drop folder
(`~/Lifestream Drop`, subfolders included), and whatever they share to the phone app with
"Send to Lifestream". One source per device. Reader `upload`.

A **drop-folder delivery** (feeder `upload-folder`, sealed by `UploadDomain.swift`) holds
`upload.json` and each file at `files/<its path in the folder>`. The index is
`{format: "org.lifestreamprotocol.upload/1", files: [{path, media_type?, created_at?, modified_at?}]}`,
one entry per file; a file's hash and size are the manifest's. Its facts count what stayed on
the Mac this run: `unsettled`, `waiting`, `unnamed`, `unreadable`, `no_room`.

A **phone shipment** carries `upload.jsonl` in its bundle: one `file` entry per file shared,
its payload `{name, blob: {hash, bytes, type, role: "original"}}`, its `observed_at` the moment
it was shared, and the file as a carried blob. The phone's source names the phone's lane:
`lifestream source add upload:local:<phone> --connector upload --options '{"lane":"phone:<phone>"}'`.

| Kind | Key | Content | Time |
|---|---|---|---|
| `file` | the 64 hex digits of the file's SHA-256 | `{ type: "upload.file", path, name, bytes, media_type?, created_at?, modified_at?, shared_at?, blobs: [{ hash, bytes, role: "original" }] }` | `modified_at` when stated, else `shared_at`, else none |

- `path` is the file's path in the drop folder, `/`-separated; a shared file's is the name it
  was shared under. `name` is its last part. `media_type` is the device's: the Mac's from the
  extension, the phone's from the type the sharing app stated.
- The same bytes are one record, whatever their path: the Mac ships them once, and a file the
  phone shares twice is restated, the later share standing.
- A file changed in place is new bytes: a new record. The earlier one stays live; nothing is
  ever `gone`, since a file leaving the folder states no deletion.
- The phone recorder's own fields (install, sequence, process, captured clock) are not the
  file's and are left out.
- A delivery whose index and files disagree (a file the index does not name, an entry with no
  file, a path named twice, a member the index does not know) is refused whole, naming it.
- A phone line that does not read (not one JSON object, another kind) is refused alone, named
  `upload.jsonl line <n>`, and the next line is read. `uploadedFiles`, the read a download
  takes, still throws on it.
- A phone line naming a blob the home lacks (a file the phone stated lost, which the door took
  for it) lands: the record names its blob and wants it, and is read again when the blob arrives.
- A delivery that holds no upload (another source's on the lane, a shipment with no
  `upload.jsonl`) yields no row.

No byte of a file is read: each is a blob the home stored before the connector ran, of any
size, or one its record wants. No family reads `file` yet; the records land and wait. A file whose
members an import kind recognises becomes that kind's import besides: the home's job `handed files`
seals its blob as [an import's delivery](#an-imports-delivery), under the name it was shared with,
once the home holds the blob.

## An import's delivery

A file the person hands their home through an import kind's window (a Takeout's part, a Spotify,
ChatGPT, Claude or Google Maps Timeline export)
arrives on the same lane as a drop-folder delivery, `upload.json` and the file at `files/<name>`
(a folder's at `files/<folder>/<path>`), its facts stating `import: {kind}` and `history: true`.
This reader states nothing for it: an import makes no `file` records. The home lists it
(`connect/imports/` `listImport`: the file's members against the kind's rows) and routes it to the
sources its members feed, made on the lane and marked `import` in their options so no lane-wide
read reaches them; each reader is handed the file's members, never the index or the `files/`
prefix, with the fact `import: {kind, id}`, and states the file consumed once all of it landed
(`consuming`).

## A download is an upload

A Meta download or an Apple data copy arrives as an upload: dropped on the Mac, or
shared to the phone. Its products are sources that name the upload lane, so each is fed every
upload delivery that states no import:

```
lifestream source add instagram:<username>:export --connector instagram --options '{"lane":"upload:local:<mac>"}'
```

Its connector reads the delivery's files with `uploadedFiles(delivery, files)` (exported
here), keeps only the ones it recognises by name and structure, and streams each from its
blob (`blobChunks`, or `archive` for a ZIP). Every other file, and every delivery
holding none of its files, yields nothing. A source added after a download arrived is fed
every delivery its lane holds. `e2e.test.ts` shows it with a toy recogniser, and
`packages/home/upload.e2e.test.ts` carries a 1.25 GiB file through the door, the inbox and the
import to both sources in a process whose resident size grows by less than half the file.

## Ledger

How the Mac keeps custody of this source: each seal's ledger entry holds the hash of every file it carried. `UploadDomainTests` hold each answer.

1. **Order.** None: the names are the person's, in any order. A file ships when its bytes are not a hash a seal up to `received` carried.
2. **Reuse.** Names are reused freely; a changed file at the same path ships as new bytes, and the same bytes at a second path never ship twice.
3. **Rebuilds.** Not applicable.
4. **Late arrivals.** Every file is late to a name order; the hashes decide.
5. **Edits.** New bytes ship; a file deleted from the folder is never reported.
6. **Lost.** This Mac never deletes a file in the folder: a restore ships again exactly the files the rolled-back seals carried. A file the person deleted cannot be named.
