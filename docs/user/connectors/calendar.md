# Calendar

The Calendar connector brings the events in Apple Calendar on your Mac into Lifestream. Your Mac reads
Calendar's own store every 5 minutes, so every account you added to Calendar comes in together.

## What it brings in

- Every event in every calendar that Calendar on this Mac holds: iCloud, Google, Exchange and
  other accounts you added to Calendar, the calendars you subscribe to, and the calendars kept only
  on this Mac.
- For each event: its title, its time and time zone, its place, its notes, its organiser, the
  people invited and their replies, how it repeats, and its alerts.

Your past comes in with the first read: every event Calendar holds from the connector's start on. After that, only
what changed comes in.

## Before you start

- Lifestream on your Mac, allowed to use Full Disk Access. The steps below allow it.

## Add Calendar

Calendar needs [Full Disk Access](./README.md#full-disk-access). If you allowed it on **Mac
Sources** when you set up Lifestream, and kept Calendar ticked there, it is already connected.
Otherwise:

1. Open **Connectors**, then **Calendar**.
2. Under **To connect**, click **Allow** beside **Allow Full Disk Access on** *your Mac's name*.
   System Settings opens.
3. Find **Lifestream** in the list, and turn its switch on.
4. If macOS offers to quit Lifestream, choose **Later**.

Calendar is then connected, and your events start to arrive.

## Where it shows up

- **Timeline** shows each event at its time, by its title, with its calendar and its details,
  such as "Calendar · organised by Person B · 3 attendees · accepted". All-day events sit at the
  top of their day.
- **Search** finds an event by its title, its place, its notes, or the address of its organiser
  or anyone invited.
- **People** gives the organiser their name on Timeline, when People knows them.
- **Chat** reads your events when a question needs them.

## What a model reads

No AI model reads Calendar, so its window has no **AI** section. Every word Timeline shows for an
event comes from Calendar itself.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Calendar has the [settings every connector has](./README.md#settings-every-connector-has). By
default, it checks for new events **Every 5 minutes**, and brings in your past from Lifestream's start. It
has no **Catch up every**, because your whole past comes in with the first read.

## Limits

- Lifestream reads only what Calendar on this Mac holds. An account that is not in Calendar on
  this Mac does not come in.
- An event you delete in Calendar stays in Lifestream and on Timeline. Calendar does not keep a
  record of what you deleted, so Lifestream cannot see it go. An event that was cancelled stays
  too, and Timeline marks it "cancelled".
- A repeating event shows once, on its first day, with how it repeats, such as "repeats weekly".
  A single time that you moved or changed shows on its own day.
- An event set to a floating time, with no time zone, does not show on Timeline.
- If you also add [Google Calendar](./google-calendar.md), its page says how the two meet.

## Remove Lifestream's access

[Pause or disconnect](./README.md#pause-or-disconnect-a-connector) Calendar as you would any
connector. Taking back [Full Disk Access](./README.md#full-disk-access) in System Settings stops
Calendar too, with every other connector that needs it.
