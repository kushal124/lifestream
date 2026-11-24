# Apple Notes: `apple-notes:<apple id>:<unit>`

**Reads** `notes.sqlite`, what changed in the Mac's `NoteStore.sqlite` (`kind: "changes"`: the
note rows that changed or whose body, attachment, media or folder did, their bodies, and every row
of every other entity), and `media.json`, the blob index of every media file the Mac could read.
Every note row the file holds is stated. A delivery from an older Mac (a `VACUUM INTO` copy, or a delta stating `after` and `through`) holds whole rows too and is read the same way, for one release more. Entities are found by
name in `Z_PRIMARYKEY`.

| Kind | Key | Content | Time |
|---|---|---|---|
| `note` | `ZIDENTIFIER` | `apple.note`: note (its stated columns), body (the `ZICNOTEDATA` row as Notes stores it, BLOBs as `$bytes64`), folder with its parent's identifier, attachments in canonical order, each with its media and the file's hash and bytes or nulls | creation to last edit (Core Data seconds); one date, that instant; none, no time. A date of zero or `NULL` is unset |

A note names the blobs of its media files. A purged note states nothing.

## Its adapter

`adapter.ts` gives the notes family its notes adapter (`packages/core/inputs/notes.ts`): a
`note` record read into a `Note`, `copies: "edited-last"` (every Mac of an account holds a note
under the same `ZIDENTIFIER`; the copy edited last decides). It reads the record's `ZTITLE1`,
`ZSNIPPET`, `ZISPASSWORDPROTECTED`, `ZMARKEDFORDELETION`, the body's `ZDATA` and `ZCRYPTOTAG`,
the folder's `ZFOLDERTYPE` (1 is Recently Deleted) and each attachment's `ZIDENTIFIER`,
`ZTYPEUTI`, `ZURLSTRING` and `ZTITLE`; every other column is not read. The title is `ZTITLE1`.

### The body

`ZDATA` is a gzip of a protobuf (`body.ts`). The note (field 3 of the document, field 2
of the whole) holds its text (field 2) and its attribute runs (field 5), each run's length counted
in UTF-16 units. The text is read paragraph by paragraph, each marked by the style of the run its
first unit lies in:

| Style | Prints |
|---|---|
| 103, checklist | `[x] ` when its checklist states done 1, else `[ ] ` |
| 100, 101, bulleted and dashed lists | `- ` |
| 102, numbered list | `1. `, `2. `, …, counted per indent; a deeper item keeps a shallower count going |
| any other (title, heading, body, monospaced) | nothing |

A list item is indented two spaces a level. Each U+FFFC is its attachment as words: `[image]`,
`[drawing]`, `[scan]`, `[video]`, `[audio]`, `[table]`, `[PDF]`, `[tag]`, `[mention]`,
`[attachment]`, with its title when the attachment row states one (`[PDF: <title>]`), and a link
as `[link: <address>]`. The type is the attachment row's `ZTYPEUTI`, else the run's own. An
identifier never prints.

Example: a note whose text is `Groceries\n😀 list\nmilk\neggs`, its last two paragraphs a
checklist with milk done, reads `Groceries\n😀 list\n[x] milk\n[ ] eggs`. The emoji is two
UTF-16 units, so a reader counting code points would style the wrong paragraph. A leading
U+FEFF is the note's own character and one unit of the runs: it is kept, never dropped as a
byte-order mark.

A body is refused, never guessed, when it has no gzip magic, does not inflate, inflates past
4 MiB, is no protobuf, holds no text, or its text is not UTF-8. A refused body leaves Notes' own
preview, `ZSNIPPET`, as the note's text. A locked note (`ZISPASSWORDPROTECTED` 1, or a body with
a `ZCRYPTOTAG`) is never read: it is ciphertext, and its title is its only words. Tables are
stored in the attachment's own rows, which the connector does not keep, so a table prints as
`[table]`; a hashtag or a mention prints as `[tag]` or `[mention]` for the same reason.

## Ledger

How the Mac keeps custody of this source: a memory of the store, per pass, holding every row sent by table, key, fingerprint and seal. `DatabaseDomainTests` in the macOS app hold each answer.

1. **Order.** None is needed: a read sends every note whose fingerprint, or its body's, attachments', media's or folder's, the memory does not hold. Notes have no pages: a store holds thousands at most. A change that touched no note seals nothing.
2. **Reuse.** A key that comes back with other values has another fingerprint, and ships.
3. **Rebuilds.** `Z_METADATA.Z_UUID`: a reset store renumbers; the memory starts again and every note ships.
4. **Late arrivals.** A note synced from another device is a changed row, and ships.
5. **Edits.** Caught: an edited note, its body or an attachment changes a fingerprint. A note purged for good ships nothing.
6. **Lost.** Nothing: every note the store holds ships once it changed, whatever its age.
