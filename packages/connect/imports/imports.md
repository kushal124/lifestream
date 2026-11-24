# Import kinds

An import kind is what one import window takes and what the road checks a handed-over file against:
a Google Takeout, a Spotify export. This folder makes every kind one shape (`ImportKind`, made by
`importKinds(connectors, readers)` in `index.ts`), derives the rows that route a file's members to
readers (`reads.ts`), and lists a file (`listImport`). The road the files take, and what the home
keeps of them, is `packages/home/imports.ts`'s; what a person sees is
[docs/user/imports.md](../../../docs/user/imports.md).

## Where a kind is declared

A kind is declared in one of two places, never both:

- **A connector's own export** (Spotify, ChatGPT, Claude, Google Maps Timeline, a home connector's):
  the connector's `export` block, `{ recognise, guide, name?, takes?, wait?, file?, leaves? }`. The
  kind's id is the connector's; its name `export.name`, else the connector's name when the export
  is its only road, else "<connector name> export"; its row's line `takes`, else "<connector name>
  sends a download you ask for"; the provider's wait `wait`; the word for the dropped file `file`,
  else "zip"; what it reads, the connector's `gives`, else its `records`. Each guide step may carry
  a `title`. Its one
  product feeds the connector's source on the `upload` road. Its account is its reader's `account`
  rule, its time its reader's `states`. It has no stamp. A home connector's kind rides the same road
  with nothing built for it on the Mac ([SKILL.md](../SKILL.md), the `export` template).
- **A kind several connectors read** (Google Takeout, the iPhone backup): an `Import` in
  `<kind>/import.ts`, holding the kind's words, guide, whose (`named`), stamp and time. A connector
  is of the kind when the kind's `of` says so: for a kind with a `root` (`Takeout/`), its
  `export.recognise` patterns lie under it; for one with none (the backup), it names the kind in
  its `export.kind`. Its `export.product` names its product. A reader shipped later brings its
  product with it: the products are derived, never listed.

A connector that declares no `recognise` (Instagram, Facebook, X) makes no kind and no row.

## Patterns and rows

A member pattern (`shared/patterns.ts`) is the one grammar by which a kind knows its files: `*` within
a folder, `**` across folders, matched against a member's path under any leading folders. A file is of
a kind when a member matches one of its `recognise` patterns. A file none of whose members match,
and one of which matches what the kind `leaves` (Claude's `users.json` alone), holds nothing
Lifestream reads yet: a Mac does not send it, and the home refuses it whole in the same words. A
file handed in with no kind named (shared from the phone, dropped in the Mac's drop folder) is the
kind whose patterns that name a file claim the most of its members, the first such in `importKinds`'
order on a tie (`recognisedKind`). A pattern that names only a type (Timeline's `*.json`) is asked
only for a single loose file that none of those claims and no kind `leaves`, so a Spotify or ChatGPT
export's other JSON files, or a zip of JSON nothing names, never make a Timeline; a file nothing claims
is no kind. The
Mac's matcher and this one read one shared table of cases, `test/patterns.json`, and agree on every
row.

Each pattern is one row: the members it claims, the product they are of, and the source they feed
(`<product>:<account>:<copy>`), read by the feeder of the source no acquirer names. A row of a
device's store (the backup's: its copy `<unit>`) feeds the copy of the device the import is of,
which the home matches by what the file states of it (`ImportKind.device`); `sourceOf` takes that
unit. Rows are derived from the declarations, never written. Their hash, kept by the home, tells a release that
reads more to list every kept file again.

## What a reader says of its export

Two members of `Reader` (`seams.ts`), read at the home's look, before any row:

- **`account`**: where the export names its account (`shared/import-account.ts`): a value in a JSON
  member, at a path in one, in a CSV's rows, or in a text member. None stated, or the member absent:
  the home asks. A rule may refuse in the person's words: the import ends refused, and nothing is
  asked.
- **`states(members, anchor)`**, optional: the export's time, from the provider's own evidence,
  and its anchor where its source keeps one. Handed the anchor its source keeps, it refuses an
  export that does not restate it. A reader with none has the time the home took the file in.

A reader still refuses, as it reads, a file whose own account is another's. It finds its members by
name under any leading folder, never by a delivery file's path or extension, so a zip, a `.tgz` and
the folder it unzips to read alike.

## Each kind

| Kind | Known by a member matching | Whose | Its time | Feeds |
|---|---|---|---|---|
| Google Takeout | its connectors' patterns under `Takeout/` | `Profile/Profile.json`, a calendar's or Google Account file's name; else asked, once for its stamp | its stamp | `<product>:<account>:export`; Mail `gmail:<account>:cloud` |
| Spotify | `**/Streaming_History_*.json` | `Userdata.json`'s `username`; else asked | its newest play's end; anchor its first play | `spotify:<account>:export` |
| ChatGPT export | `**/user.json`, `**/chat.html` | `user.json`'s `id` | its newest conversation's update | `chatgpt:<account>:export` |
| Claude export | `**/conversations.json` | `users.json`'s `uuid`, else the first conversation's account | the manifest's `created_at` where held, else its newest conversation's update | `claude:<account>:cloud` |
| Google Maps Timeline | `*.json` (a single file: the reader is the judge) | asked | its newest segment's end | `google-timeline:<account>:export` |
| iPhone backup | `**/imessage/messages.db`, `**/imessage/attachments.json`, `**/whatsapp/chats.sqlite`, `**/whatsapp/calls.sqlite`, `**/whatsapp/media.json`, `**/apple-calls/callhistory.sqlite` | `backup.json`'s accounts of its store: Apple IDs, or WhatsApp's JID as its digits; else the phone's, else asked | `last_backup` | `imessage:<apple id>:<unit>`, `whatsapp:<number>:<unit>`, `apple-calls:<apple id>:<unit>`, the unit the phone's |

**Google Takeout** reads Calendar, Contacts, Google Photos, Mail and My Activity. Its stamp is the
`<made>` a file's name carries (`takeout-<made>-…`), else the one `archive_browser.html` names: every
file of one account and stamp is one import, however many days apart its parts come. A Takeout's
parts that name no account (a Photos-only part) are one question together, the account that
already holds an import of that stamp offered first. My Activity is read from JSON, and from HTML as
far as it goes.

**The iPhone backup** (`iphone-backup/import.ts`) is the stores of a phone's encrypted Finder backup
the home reads, which the Mac pulls out of it into a folder a store and hands over as three files:
`imessage/`, `whatsapp/`, `apple-calls/`. Each holds exactly what its reader reads from a Mac, and
`backup.json`, the same in all three but for `store`, keys sorted and no time of the pull-out, so
one backup is always the same bytes; the media its store names travel beside it as carried blobs.
Its rows are its readers' own: iMessage, WhatsApp and Calls each name the kind in `export.kind`. A
folder names the accounts of its store's domain (`apple` or `whatsapp`; a JID is made the number the
WhatsApp source is named by, here and never on the Mac); none or several are answered by the phone
the backup is of. Its stamp is `<device>:<last_backup>:<apple|whatsapp>`: the iMessage and calls
folders of one backup are one import, its WhatsApp another, so an answer for one domain never
names the other's; a later backup is a new import. Its time is `last_backup`, so a backup read late
never outranks a newer statement: a record it states unchanged lands `restated`, one it states more
of (an attachment's hash) a new version when the backup is newer than the statement that stands and
`late` when it is older. Every source is under the unit of the phone the backup is of
(`device`, which carries every account the backup states, of both domains, so any folder places
the phone, whichever lands first): one phone is one identity, whatever brought its records. A folder with no
`backup.json`, or one `iphone-backup/test/backup-json.json` refuses (a table the Mac's writer reads
too), is refused whole: "This isn't a folder Lifestream made from an iPhone backup." The question
offers each product's company: "Whose Apple ID is on this iPhone?" the home's `apple` sources,
"Whose WhatsApp is on this iPhone?" its `meta` ones (`ImportKind.whose`).
