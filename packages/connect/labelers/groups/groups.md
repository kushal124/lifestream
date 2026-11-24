# groups

The groups labeler and the connector that reads what it delivers. It states, a month at a time,
which civil days of each group chat are the owner's: the days a day prints that group's messages
on. A day reads its group's month through the labels family and asks no other question of it.

## Source

`groups:local:<home>`, where `<home>` is the home machine's unit (the `unit` setting), as the
cameras labeler's is. The labeler writes its deliveries; nothing else ships to this source. Its
facts name the source and its connector (`sources`), so the home makes the source with the first
delivery. Product `groups` (Groups). Shown nowhere: no stream row, no switch.

| Kind | Key | Content | Time |
|---|---|---|---|
| `month` | `<chat key>:<YYYY-MM>`: the chat key as People serves it, `<network>:<chat>`, the network any product a messages adapter is registered for (`whatsapp:<group JID>`, `imessage:<handles>`) and the month (`whatsapp:120363000000000001@g.us:2026-10`) | `{yours: [[first, last], …]}`: the closed spans of the month's civil days that are the owner's, each inside the month, ascending, apart; none, quiet the whole month | none |

A month a group no longer has (its first message gone, the group gone) is stated `gone`. The
delivery is one `groups.ndjson`, a line a record, every line read and checked before any lands:
one that does not read, a key that is not `<network>:<chat>:<YYYY-MM>` (a network spelled as a product is), or a span outside
its month or touching the one before refuses the whole delivery.

## What the labeler reads

No record and no extract: the groups People's job folded, the `groups` rows of this machine's
People file ([home/people.ts](../../../home/people.ts)), each a group's spans of days that are the
owner's and its first and last civil days with a message, handed to it by the home's registry as
the google-places labeler is handed what Places owes: connect does not import the families, and
the one rule (`families/messages/groups.ts`) is folded once, by People. None before People's first
run: it states nothing until then. The `people` event, which every People run appends, makes it due
(`Labeler.events`); so do its own delivery's landing and the home's start.

## What it states

For each group and each month from the month of its first day to the month of its last, the
group's spans cut to the month, only where that differs from its own head: a run compares every
head with the rows, so a run that stopped at its bound (`PER_RUN`, 5,000 records), or a home that
stopped between People's commit and its run, is caught by the next. A group's spans run past a
month's end when the owner writes every few days, so writing today moves the months it reaches and
no other, and no past day renders again. A run that finds the rows where the last run that stated
nothing found them, and no statement of its own months since the last run read (an Undo or a
repair of them states some, as its own delivery does), reads nothing more.

## Settings

None of its own. The rule's settings are each messages stream's `groups_*` fields (WhatsApp's and iMessage's)
([whatsapp](../../messages/whatsapp/whatsapp.md), [imessage](../../messages/imessage/imessage.md)):
a change queues People, whose run folds the groups again, and the months that moved are stated.

## Tests

`e2e.test.ts`: the months stated from People's rows, only changed ones restated, a month gone, a
run stopped at its bound or a home stopped before it caught by the next, and a bad delivery
refused whole. The rows through a real home: `packages/home/people.e2e.test.ts`, "Groups through
the door".
