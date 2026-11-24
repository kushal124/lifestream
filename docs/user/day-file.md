# The day file

The day file is the text Lifestream writes for a day of your life: one short line for each thing
that happened, in time order. This page says where the file is and how to read it line by line.
Agents read it with the `read` tool, described in [The tools an agent gets](./agent-tools.md).

## Where it is

A day's file is in the `days` folder of Lifestream, named by its date:

```
~/Lifestream/days/2026-11-10.day.txt
```

Lifestream is in `~/Lifestream` unless you chose another place during setup.
[Lifestream's folder and its disk](./your-home.md#where-the-folder-lives) says how to find it.

A day starts at 4:00 in the morning and ends at 4:00 the next morning, in Lifestream's time zone.
Lifestream writes a day's file again whenever what it prints changes, such as when your past
arrives for that day.

Beside it are two JSON files, `2026-11-10.day.json` and `2026-11-10.day.lines.json`, with the same
day for programs to read.

If Lifestream is encrypted, these files are encrypted too, and no editor can open them. See the day
on **Timeline** instead, or ask an agent, which reads the day file through Lifestream.

## An example

This day is made up. It shows five of its coverage lines; a real file has one for every name on its
second line.

```
Day 2026-11-10 (Tuesday) in America/New_York, 04:00 to 2026-11-11 04:00 (24 h)
10 atoms: ai 0, calendar 1, calls 0, health 1, listening 0, mail 1, messages 5, money 0, notes 0, phone 0, photos 0, physical 2, screen 0, voice 0, web 0
Sleep 23:40–07:05, wake at 07:05: in bed 7:25, deep 1:20, REM 1:50, awake 0:35

04:00–08:40 At Home (continues from 9 Nov)
08:10–08:14 Person A (3)
  08:10 Person A: Are we still on for lunch?
  08:12 the user: Yes, 12:30
  08:14 Person A: See you there
09:30–10:00 Event “Weekly review”, organised by Person B, 2 attendees, you accepted, video call
11:00 Mail from Person C to the user: “Your order has shipped” — Your order is on its way.
12:25–13:40 At Example Café
2026-11-11 01:15 Group Alpha · Person B: Good night, all

No time stated
You were quiet in
  Group Beta · 14 messages

Coverage
ai: no sources
calendar: google-calendar:person-a@example.com:cloud read through the day
mail: gmail:person-a@example.com:cloud read into the day
messages: whatsapp:+15550000009:iphone-aa01 read through the day; whatsapp:+15550000009:macbook-pro-0001 read through the day
physical: location:local:iphone-aa01 read into the day
```

## How to read it, line by line

**Line 1** names the day: its date, its weekday, Lifestream's time zone, when it starts and ends,
and how many hours it has. A day has 23 or 25 hours when the clocks change.

**Line 2** says how many items the day prints, then how many came from each group of lines.
`atoms` is the file's word for these items. Each group gathers one part of your life: `messages`
holds your chats, `physical` the places you went, `health` your body. The tools call these groups
families.

**The lines after it, before the first blank line,** are about the whole day, such as your sleep.

**The timed lines** come next, in time order. Each starts with its time, or with a span such as
`09:30–10:00`. A time after midnight prints its date, because it still belongs to this day. A line
that started the day before ends `(continues from 9 Nov)`, and one that goes on into the next day
ends `(continues into 11 Nov)`.

Messages in one chat that come one after another print the chat's name once, with a span and a
count, such as `Person A (3)`. Each message follows, indented, with its sender. A time is left out
when it is the same as the line above. `the user` is you. A single message prints the chat's name
and then the message, with a `·` between them.

**On** *date*, **time unknown** lists items that have a date but no time.

**No time stated** lists items with no time at all. Under it, `You were quiet in` lists each group
chat you were quiet in that day, with how many of its messages fell in the day. Their messages are
not printed. The [WhatsApp](./connectors/whatsapp.md#settings) and
[iMessage](./connectors/imessage.md) pages say when you are quiet in a group.

**Coverage** has one line for each group of lines. It names the place each one reads from, such as
one account or one device's copy of a connector, and how far Lifestream had read it:

- `read through the day`: the whole day is in.
- `read into the day`: Lifestream had read part of the day. Later items may still arrive. The line
  gives no time: the now row on Timeline says how far it is read, as of the moment you look.
- `not read into the day`: nothing from this day is in yet.
- `no sources`: nothing feeds this group.

A missing line is not proof that nothing happened. Check **Coverage** before you trust a gap.

Each item prints on one line. Line breaks in a message print as spaces.

## Line numbers and citations

Line 1 is the first line of the file, and the file does not print the numbers. The `read` tool
gives an agent a day's lines without these numbers: it puts a handle such as `[r12]` before each
line, and opens the line and the item behind it from that handle. A line's number can change when
its day is written again, so `read` finds the line again by the item it shows.

## Next

- [The tools an agent gets](./agent-tools.md)
- [Connect an agent](./connect-an-agent.md)
