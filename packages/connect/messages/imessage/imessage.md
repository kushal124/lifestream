# iMessage

Reader `imessage-db`. Source `imessage:<account>:<unit>`: one replica of one Apple account's
Messages database on one device. The account is the owner's own id (the adapter's `self`): a
phone, its digits alone an international number spelled with its `+`, or an address. The Mac's
`chat.db` and an iPhone backup's `sms.db` are two sources: the replicas state the same message differently (dates, sender handles, re-serialised
bodies), so each keeps exactly what its device states and one guid in both is two records.

## What it reads

A delivery holds:

- `messages.db`: the replica's database, whole (a phone backup's `sms.db`, its WAL folded in) or
  what changed in it (the Mac, `kind: "changes"`).
- `attachments.json` (optional): the blob index the device wrote, each attachment's
  `Attachments/…` filename tail to its blob hash and size. The bytes travel as the source's
  blobs.

A delivery states every message the file holds, then every chat with this device's state of
it, table by table: a chat with no message in the file too. A message's handles, chats and
attachments are read by lookup. It states nothing about a row the file does not hold. A delivery
from an older Mac (a nightly snapshot, or a delta stating `after` and `through`) holds whole rows
too and is read the same way, for one release more.

A phone backup comes on the import road (imports/imports.md, "Each kind": the iPhone backup): the
Mac pulls `messages.db` and `attachments.json` out into an `imessage/` folder, its rows
`**/imessage/messages.db` and `**/imessage/attachments.json` (this connector's `export`), for
`imessage:<apple id>:<unit>` on the `upload` road, the unit the phone's. The attachments' bytes are
the folder's carried blobs.

The file must state exactly one `_SqliteDatabaseProperties._ClientVersion`, and every date is
signed nanoseconds since 2001 (`apple-ns`). A date of zero or `NULL` is Apple's "no date": the
record states no time, and its `date` as stated. A date above zero and below 10^15 is a seconds-era file's: that message is refused, by
name.

It reads the columns it names, and states every column of macOS 26's `chat.db` as known
(`columns`): a column a later macOS adds changes no version, and `lifestream report` lists it until a
release names it. An older macOS lacks some flags; a record holds the ones its file has.

## Kinds and keys

| Kind | Key | Content | Time |
|---|---|---|---|
| `msg` | `message.guid` | `imessage.msg`: guid; sender (none when sent from this device or its handle is not in the file); recipients (every handle of the message's chats but the sender); text; `attributedBody`; `date` verbatim; service; flags (the flag columns it names, each the file holds: not the device's reading state `is_read`, `is_played`, `is_finished`, nor `is_time_sensitive`, a notification's state Messages clears later); the tapback, edit and unsend columns; and per attachment its `hash` and `bytes` (null when the index does not name it), `mime_type` and `transfer_name` | `date` |
| `chat` | `chat.guid` | `imessage.chat`: guid, style, service, participants | the newest message the delivery states in it; none when it states none |
| `chat-state` | `<unit>:<chat.guid>` | `imessage.chat-state`: the chat's state columns it names, each the file holds, verbatim (read position, properties, account, …): not `ROWID` or `last_addressed_handle`, which name nothing outside the file, nor iCloud's `ck_sync_state` | none |

A group `chat` (two participants or more) is named by a `chat-state`'s `display_name` for it on
the same source: its adapter's `label` says a group `chat` stands for its participants' chat
(`chat`) and a `chat-state` names the chat of its `chat_guid` (`named`), and the labels read it, as
WhatsApp's group names
([labels](../../../families/labels/)).
Messages on the Mac never sets `is_archived`, so iMessage has no archived groups.

**Fields.** Under a Groups heading, the home's own (`home`, handed to no device), which People
folds the groups by:
`groups_quiet_after` (the silence after which a group is quiet: 30 days, 90 by default, 6 months, a
year, never) and `groups_talk` (whose group messages count toward them: on days the owner wrote
there, by default; every group; none).

A handle is `{raw, canonical, kind}`, spelled by core (`packages/core/handles.ts`): a phone (`+`
and 7 to 15 international digits, no leading zero; a bare spelling is digits only, `00` the
international prefix), an email address (lower case, NFC, no `mailto:`), or anything else (a
sender name, a short code) as `raw`, verbatim. Handles and
attachments are in canonical order (`connect/shared/order.ts`), each handle listed once.

An integer past 2^53 (dates in nanoseconds, a read position) is stated as its decimal text; a
BLOB as `{"$bytes64": …}`. Every row carries the replica's unit as `device` and its table row
as `locator`.

## Its adapter

`adapter-messages.ts` (`imessageMessages`, version 1) reads a `msg` record for the messages family
(`packages/core/inputs/messages.ts`): `sender`, `recipients`, `text` (else the text of
`attributedBody`, which `typedstream.ts` reads), `flags.is_from_me`, `associated_message_type` and
`_guid` (tapbacks), whether `date_edited` and `date_retracted` are non-zero, and each attachment's
hash, MIME type and name. Every other field is never read. A chat is the sorted set of the other
participants' handles (phones and addresses made comparable, `(smsft)`-style suffixes dropped): a
group when it names two handles or more, its members those handles. `images`, what the faces
labeler reads: each attachment whose MIME type is `image/…`, or that states none and whose name
ends in an image's extension (`jpg`, `jpeg`, `png`, `heic`, `heif`, `gif`, `webp`, `tiff`), and its
sender as a `phone` or an `email` when the owner did not send it and the sender and the recipients
are one handle.

## Ledger

How the Mac keeps custody of this source: a memory of
the store, per pass, holding every row sent by table, key, fingerprint and seal, and the
attachments sent. `DatabaseDomainTests` and `CustodyTests` in the macOS app hold each answer.

1. **Order.** None is needed: a read sends every row whose fingerprint the memory does not hold.
   Messages of the last 7 days (`date`) go live; older ones in history pages, newest first.
2. **Reuse.** A key that comes back with other values has another fingerprint, and ships.
3. **Rebuilds.** `chat.db` states no id of its own, so its identity is the main file's device,
   inode and birth time. Messages in iCloud turned off and on, or reset, makes a new file whose ids
   start again at 1: the memory starts again, the whole store ships, and nothing is stated lost.
4. **Late arrivals.** iCloud delivers old messages late, each with a new `ROWID`: they ship as any
   new row, into a page when older than the live span. Statement time never decides custody.
5. **Edits.** An edit (`date_edited`), an unsend (`date_retracted`), read and delivery state, an
   attachment downloaded and a chat renamed each change a row's fingerprint, and the row ships with
   what it pulls: a message with its joins and attachments; a chat with its handle joins.
6. **Lost.** Rows the app pruned before this Mac carried them (the ids between the memory's
   highest message and the store's lowest) are stated `message rows with ids <a> to <b> left the
   app before this Mac carried them`, once. A row the app deletes ships nothing. After a restore,
   what the rolled-back seals sent ships again, their attachments too.
