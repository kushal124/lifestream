# Notes

The Notes connector brings the notes in Apple's Notes app on your Mac into Lifestream. Lifestream
reads Notes every 5 minutes, and brings in every note you already keep.

The notes you write in Lifestream on your iPhone are a connector of their own:
see [Lifestream notes](./iphone-notes.md).

## What it brings in

- Every note in Notes on your Mac: its title, its text, its formatting and the folder it is in.
- The attachments of each note, such as photos, drawings, scans and PDFs.
- Each edit you make later, and the notes you move to Recently Deleted.

An attachment comes in once its file is on your Mac. If Notes keeps a file in iCloud, the file
comes in when Notes downloads it.

Notes on your Mac brings in your notes from iCloud only while it is open. So before each read,
Lifestream opens Notes if it is closed, hidden and without bringing it to the front.

## Before you start

- Lifestream on your Mac, allowed to use Full Disk Access. The steps below allow it.
- To bring in the notes from Apple's Notes app on your iPhone too, iCloud turned on for Notes, on
  your iPhone and on your Mac.

## Add Notes

Notes needs [Full Disk Access](./README.md#full-disk-access). If you allowed it on **Mac Sources**
when you set up Lifestream, and kept Notes ticked there, it is already connected. Otherwise:

1. Open **Connectors**, then **Notes**.
2. Under **To connect**, click **Allow** beside **Allow Full Disk Access on** *your Mac's name*.
   System Settings opens.
3. Find **Lifestream** in the list, and turn its switch on.
4. If macOS offers to quit Lifestream, choose **Later**.

Notes is then connected, and your notes start to arrive.

## Where it shows up

- **Timeline** shows a note on the day you created it and on the day you last edited it, under
  its title. Open it to read the note's words.
- **Search** finds a note by its title or by any of its words.
- **Chat** reads your notes when a question needs them.

## What a model reads

No AI model reads Notes, so its window has no **AI** section.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Notes has the [settings every connector has](./README.md#settings-every-connector-has). By default,
it checks for new notes **Every 5 minutes**, and brings in your past from Lifestream's start.

## Limits

- Lifestream cannot read a locked note. Timeline and Search show only its title.
- Lifestream does not read what is inside a table, a tag or a mention. Timeline shows `[table]`,
  `[tag]` or `[mention]` in its place.
- Timeline shows only the day you created a note and the day you last edited it. Lifestream keeps
  the edits in between, but Timeline does not show them.
- Lifestream reads only what Notes on your Mac holds. A note that has not synced to your Mac yet
  comes in after it syncs.

## Remove Lifestream's access

[Pause or disconnect](./README.md#pause-or-disconnect-a-connector) Notes as you would any connector.
Taking back [Full Disk Access](./README.md#full-disk-access) in System Settings stops Notes too,
with every other connector that needs it.
