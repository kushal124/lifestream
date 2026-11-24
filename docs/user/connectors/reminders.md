# Reminders

The Reminders connector brings the reminders in Apple Reminders on your Mac into Lifestream. Your Mac
reads Reminders' own store every 5 minutes, so every account you added to Reminders comes in
together.

## What it brings in

- Every reminder in every list that Reminders on this Mac holds: iCloud, the reminders kept only
  on this Mac, and any other account you added to Reminders.
- For each reminder: its title, its notes, its list, its due date, its alerts, its tags, its
  subtasks, whether it is flagged, and when you completed it.

Your past comes in with the first read: every reminder Reminders holds from the connector's start on. After that,
only what changed comes in.

## Before you start

- Lifestream on your Mac, allowed to use Full Disk Access. The steps below allow it.

## Add Reminders

Reminders needs [Full Disk Access](./README.md#full-disk-access). If you allowed it on **Mac
Sources** when you set up Lifestream, and kept Reminders ticked there, it is already connected.
Otherwise:

1. Open **Connectors**, then **Reminders**.
2. Under **To connect**, click **Allow** beside **Allow Full Disk Access on** *your Mac's name*.
   System Settings opens.
3. Find **Lifestream** in the list, and turn its switch on.
4. If macOS offers to quit Lifestream, choose **Later**.

Reminders is then connected, and your reminders start to arrive.

## Where it shows up

- **Timeline** shows a reminder by its title on the day it is due, and again on the day you
  completed it. A reminder due on a day, with no time, sits at the top of that day.
- **Search** finds a reminder by its title or its notes.
- **Chat** reads your reminders when a question needs them.

## What a model reads

No AI model reads Reminders, so its window has no **AI** section. Every word Timeline shows for a
reminder comes from Reminders itself.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Reminders has the [settings every connector has](./README.md#settings-every-connector-has). By
default, it checks for new reminders **Every 5 minutes**, and brings in your past from Lifestream's start.
It has no **Catch up every**, because your whole past comes in with the first read.

## Limits

- Lifestream reads only what Reminders on this Mac holds. An account that is not in Reminders on
  this Mac does not come in.
- A reminder with no due date shows on Timeline only on the day you complete it. Until then, it
  is in Lifestream and in Search, but not on Timeline.
- A due time with no time zone counts as no due date.
- A reminder you delete leaves Timeline and Search. It stays in Lifestream.

## Remove Lifestream's access

[Pause or disconnect](./README.md#pause-or-disconnect-a-connector) Reminders as you would any
connector. Taking back [Full Disk Access](./README.md#full-disk-access) in System Settings stops
Reminders too, with every other connector that needs it.
