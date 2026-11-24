# Meta's downloads: what Instagram and Facebook share

Meta's "Download your information", in JSON format, read by two connectors:
[instagram](../instagram/instagram.md) (`instagram-export`) and
[facebook](../facebook/facebook.md) (`facebook-export`). Each names the files it reads; what
both do is `shared/meta-export.ts`, and is this page.

## What a delivery holds

A download arrives on the upload lane as its ZIP, or as its members extracted at their paths in
the archive (the drop folder's `files/<folder>/…`). The export's **root** is the folder that holds
its activity folder (`your_instagram_activity/`, `your_facebook_activity/`); every path below is
under it. A ZIP is read when it holds the activity folder. One delivery is one profile's export.

- A delivery holding no activity folder holds no export of that product and yields no row.
- The same path held twice (a ZIP and its extraction, two copies) refuses the delivery.
- Two roots in the delivery's files, or in one ZIP, are two exports: refused.

## The account

The source is `<product>:<account>:export`, and the account must be one the export's profile
file names (each provider's page says which). A delivery whose profile file names another
account is refused whole, naming both, so nothing is filed under the wrong person. An export
without its profile file is refused: its account cannot be checked.

## Meta's text

Meta writes text as its UTF-8 bytes, each spelled as the Latin-1 character of that byte
(`Ã©` for `é`). Every string of an item, member names too, is repaired where the repair check
passes: no character is past U+00FF and the bytes are valid UTF-8. Any other string is kept as
stated. The delivery keeps Meta's bytes either way.

## Content, keys and time

- Each item is one row, every member copied: `{type: "<product>.<kind>", ...the item, blobs?}`.
- An item's key is its own name where the provider's page gives one (Meta's id, the link of what
  was liked, the account followed); an item with none, or missing it, takes the fingerprint of
  every member it states (`shared/fingerprint.ts`, on the repaired item). Meta writes some items
  twice, whole: one record stated twice.
- Time is the item's own, read through `instant`: Unix seconds (`unix-s`) for an item, Unix
  milliseconds (`unix-ms`) for a message. A time that is not a positive integer (none, Meta's
  `0`) states none; the content keeps it.
- Nothing is ever `gone`: an item a later download lacks stays.

## Message threads

Each thread is a folder `<activity>/messages/<folder>/<thread>/` of parts `message_<n>.json`,
whatever the folder (`inbox`, `message_requests`, `archived_threads`, `filtered_threads`,
`e2ee_cutover`). Each part is read whole.

| Kind | Key | Content | Time |
|---|---|---|---|
| `chat` | the thread's number: the digits its `thread_path` ends in (`inbox/person_1234567890` is `1234567890`), the whole `thread_path` when it ends in none | every member of the first part but `messages` | none |
| `msg` | `fingerprint({thread, sender, time_ms, text})`: the thread's number, `sender_name`, `timestamp_ms`, `content`, each left out when the message states none | `{thread_path, ...every member of the message}` | `timestamp_ms` |

A thread keeps its keys when Meta moves it to another folder (a request accepted, a thread
archived); its `thread_path` is a new version of its chat and of each message.

## Media

Every `uri` an item states, at any depth, that names a member of the export is a file of the
record: `blobs` lists each once, as `{hash, bytes, media_type, role: "attachment", file}`, `file`
the `uri`. A ZIP member is stored, never read whole (`shared/members.ts` `stored`): hashed in
chunks as it is read, its `hash` the SHA-256 of its bytes, and handed to the home by stream with
the row (`ReaderOutput.streamed`), of any size; an extracted member is the delivery's own file. A `uri` the export does not hold (a web
address, an empty one, a file Meta left out) stays a name.

## Refused

Each part alone, named in the run's refusals (a row of kind `file`), while the rest lands. A file
that is not UTF-8 JSON, or that lists its items under a member naming another or holds a second
one, by its path; a list that is not closed keeps the items before the break. An item that is not
an object, states a `type` or `blobs` member, states a time past the years `instant` reads, or
names a ZIP member whose bytes cannot be read, by its place (`<file>[<index>]`). A thread's part that states no
`thread_path` or `messages` list, by its path; a message that is not an object or states a `type`,
`blobs` or `thread_path` member, by its place (`<part> messages[<index>]`). A ZIP that cannot be
read, or a file named `.zip` that is no zip, by its path. The delivery, whole, only for what is above: a path held twice, two exports,
another account's profile, no profile file. A row alone, counted, when its content breaks the guard: an item stating nothing; a
message whose `timestamp_ms` is not an integer, or whose `sender_name` or `content` is not text;
a chat whose `participants` is not a list of objects.

A file is read one item at a time, whatever its size (a top-level list, or the list one member
holds); a message thread's part, a profile, and a file that is one item are read whole, up to
64 MiB.
