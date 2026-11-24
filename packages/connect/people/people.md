# People: `people:local:<home>`

The owner's own statements about people: who they are, who each face in their photos is, the
photo each is shown by, and their work, birthday and profiles.

## What it reads

One source, read by the `people-home` connector: the owner's statements. It is no row on Streams:
it is never connected or turned off, and holds nothing to set.

**A people file delivery** a home holds: `people.json` (`{format: "org.lifestreamprotocol.people/1",
people}`), read as the statements are, so every record it landed stands. Nothing seals a new one.
The newest statement of a record wins, whichever file it came in. Each delivery holds exactly one of
the two files.

**The owner's statements**, an owner source's acquisition, sealed by the home itself: its owner
writer (`packages/home/owner-act.ts`, People's drafter `people-draft.ts`) turns each action a device sends
to `POST /v1/owner/act` with `of: "people"` (the dashboard's pass, a phone's, each with `deliver` on the source) into
one delivery `people:local:<home>/<made-at>.<12 hex>`, landed before the act is answered, and no pass ships one through the door.
Read by the one statements reader as the owner's places are
([places](../places/places.md)): `statements.ndjson`, one statement a line:

```
{"kind":"person","key":"<slug>","content":{type,slug,name,full_name,show,entity,relationship,hidden,me,anchor,handles,excluded,dismissed,also_called,merged_into}}
{"kind":"face","key":"<face key>","content":{"is":"<slug>"}}
{"kind":"face","key":"<face key>","content":{"is_not":["<slug>",…]}}
{"kind":"face","key":"<face key>","content":{"ignore":true}}
{"kind":"face","key":"<face key>","gone":true}
{"kind":"photo","key":"<person id>","content":{"type":"people.photo","image":"sha256:<hex>"}}
{"kind":"photo","key":"<person id>","content":{"type":"people.photo","image":"sha256:<hex>","face":"<face key>"}}
{"kind":"photo","key":"<person id>","gone":true}
{"kind":"details","key":"<person id>","content":{"type":"people.details","work":"<words>"|null,"birthday":{"month","day","year"}|null,"profiles":[{"network","value"},…],"cleared":["birthday"|"profiles"|"work",…]}}
{"kind":"details","key":"<person id>","gone":true}
{"kind":"group","key":"<chat key>","content":{"quiet":true|false}}
{"kind":"group","key":"<chat key>","gone":true}
```

An upload's picture, the square its `image` names, is carried in the same delivery as the lane's
`blobs/<hex>`, counted by `facts.blobs_carried`; its row names the blob (`image/jpeg`), so the
import stores it before the row and `/v1/blobs` serves it. A face picked carries none and its row
names none: its `image` is the crop the faces labeler's records name, and goes with them. A photo
stated gone is withdrawn (an undo): the person is shown by the next rung. Details are whole
each time: a statement says all three as the owner left them, and `{work: null, birthday: null,
profiles: []}` says there is nothing; stated gone (an undo), none stands under the key. `cleared`,
when present, names the fields the owner emptied over a person joined in: each is empty in the
statement, and wins over every record of the group (families' `shared/people.ts` `detailsOf`). A
detail is
its own statement, never a member of the person record, so it never undoes a name. A `group`
is the owner's word on a group chat:
`quiet` true Always quiet, false Never quiet; stated gone, Follow the rule.

Every line is read and checked before any lands, by the writer before it seals the delivery too:
one that does not read refuses the whole delivery. The writer checks each photo's picture too
(`picture`, the kind's rule): an upload's is carried, at most 1 MiB, a JPEG (it starts `FF D8 FF`)
whose frame header states a square of 1 to 1,024 pixels; a face picked's `image` is held by the
home (a version names it and the store has it); and every blob the delivery carries is an upload's
picture. The header is read, never the pixels. A person is never stated gone (a merge
retires one). The statements are stated at the delivery's `fetched_at`, the home's one clock at
the act, so two edits are in the order the home took them and no device's clock makes one `late`; a
delivery whose facts state a time of the source's own (`exported_at` and the like) is refused. Each
action of the owner is one delivery, so one run, so `undo <run>` undoes it.

`/v1/people` reads these records' heads on every read and joins them with what People's run
counted, so an act is read in the tick it is answered; a person whose counted parts are not yet
theirs (a new person, one split off or joined) reads `counting` until that run
(door.md, the read routes).

A file row's device is the home's unit; a statement's is the unit of the pass that acted (or,
before the writer, sealed it), which the writer writes into the facts (`device`, beside `action`
and `request`). A statements delivery sealed before the door wrote it is
the home's own, and its rows' device the home's unit, so `undo <run>` or a re-run of it lands
as it did. The other label source the families name people by is vCard contacts:
[contacts/vcard](../contacts/vcard/vcard.md).

## Kinds and keys

| Kind | Key | Content | Time |
|---|---|---|---|
| `person` | slug | the person record, the shape before it or the older shape, as written | none |
| `face` | face key `<photo hex>:<x1>,<y1>,<x2>,<y2>` | `{is: <slug>}`, `{is_not: [<slug>, …]}` (sorted, no repeats) or `{ignore: true}` | none |
| `photo` | the person's id as the door names them when it is stated: `person:<slug>`, a handle id in core's spelling (`phone:+15550000001`, `email:person-a@example.com`, `jid:<lid>`: its value what core's `handleOf` gives back for it), or `contact:<16 hex>` | an upload, exactly `{type: "people.photo", image}`, `image` `sha256:` and 64 lowercase hex, its square's hash; a face picked, `{type, image, face}`, `image` its crop's hash and `face` its face key | none |
| `details` | the person's id, as `photo` | exactly `{type: "people.details", work, birthday, profiles}`, and `cleared` if any: `cleared` one to three of `birthday`, `profiles` and `work`, sorted, each once, each empty in the statement (null; `[]` for profiles), absent when the owner emptied none (a statement made before it has none); `work` 1 to 120 characters once trimmed, or null; `birthday` `{month, day, year}`, a day its month holds (29 February when `year` is a leap year or null), `year` 1900 to this year or null, or null; `profiles` at most 12, distinct, each `{network, value}` as core's `profileFault` holds it (the one rule, which People's card reader offers by): `network` one of `instagram`, `x`, `linkedin`, `facebook`, `github`, `site`, `value` 1 to 200 characters, no space, query or fragment, the handle as the network spells it (lower case on instagram, x and github; no slash), for `site` an https page's host, lower case, and its path as written (no scheme or port) | none |
| `group` | the chat key as People serves it: `whatsapp:<group JID>` or `imessage:<handles>`, the group's handles in core's spelling, sorted and joined by commas | exactly `{quiet: true}` (Always quiet) or `{quiet: false}` (Never quiet), the owner's word; gone, Follow the rule | none |

A person is guarded and read by core's one reader of the record (`packages/core/people-record.ts`):

- **The record**, the shape writers emit: exactly `{type: "people.person", slug, name, full_name,
  show, entity, relationship, hidden, me, anchor, handles, excluded, dismissed, also_called,
  merged_into}`, `also_called` optional on read: a record stated before it has none, and reads with
  an empty list. A
  handle is `{kind, value}`, its kind `phone`, `email` or `jid` and its value in core's canonical
  spelling (`packages/core/handles.ts`; a phone JID is no `jid`: it is its phone); `handles` and
  `excluded` in core's order (`compareHandles`: phones, then addresses, then WhatsApp ids, each by
  value), without repeats, none of them both; `dismissed` the sorted ids of declined suggestions;
  a name, a full name or a handle, the anchor counting (a record with none names no one); `show`
  `name` or `full_name`; `entity` `person`, `ai`, `business` or `bot`; `also_called` the names the
  owner added (Also called), at most 12, each as core's `calledName` makes it (one space between
  words, none around them, 1 to 60 characters, no control character), sorted by `foldName`, then
  text, no two folding alike (a name taken off is a decline in `dismissed`). A person's photo is its
  own statement, `photo`.
- **The shape before**, the record with `photo` (null or a face key, core's `isFaceKey`) and no
  `also_called`, so a delivery sealed while the record held a photo still lands. It reads as the
  record with no other names: its `photo` says nothing.
- **The older shape**, `{type, slug, name, handles, excluded, merged_into}` with each handle
  `{kind, value, by, since}` (kind `name`, `phone`, `email`, `jid` or `contact`; the name among
  them, sorted by kind, then value, as those deliveries were sealed), so a delivery sealed before
  the record changed still lands. It reads as the record: its
  phones, addresses and WhatsApp ids canonical, its anchor the lowest of them (none, a person of
  their name alone), a `name` or `contact` handle naming nothing, with no other names.

A person states no time: the owner's word is no event of a life. A person holds no face handle:
who a face is lives on the face ([faces](../labelers/faces/faces.md)).
