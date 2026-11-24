# Bring in your past from an export

Bring an export or an iPhone backup into Lifestream, so it holds your years from before you
installed it. An export is a file a company makes of your data when you ask for it, such as a
Google Takeout. An iPhone backup that Finder makes on your Mac comes in the same way.

## Before you start

- The Mac app on the Mac that runs Lifestream, or the iPhone app. On another Mac, an import's
  window shows what is in, and its drop zone says **On your Mac**.

## What you can bring in

Each export has a row on **Connectors**, under **Imports**, the last group:

| Row | What it brings | Where it goes |
|---|---|---|
| **Google Takeout** | Gmail, Google Calendar, Contacts, Google Photos and Google activity | Google Calendar, People, Google Photos, Gmail and Google activity |
| **Spotify** | every play since your account began | Spotify |
| **ChatGPT export** | your conversations | ChatGPT |
| **Claude export** | your conversations | Claude |
| **Google Maps Timeline** | the places and trips your phone's Google Maps saved | [Google Maps Timeline](./connectors/google-timeline.md) |
| **iPhone backup** | your WhatsApp, your iMessage and SMS texts with their attachments, and your phone's call history | WhatsApp, iMessage and Calls, as connectors of that iPhone |

The row stays under **Imports** after an import, because you can bring in a newer export at any
time. The connectors an export fed are connected, like any other connector. In a connector's
window, the export is a row under **Comes from**: click **Show** to open the export's window.

## Get the export

Click the row's **+** to open its window. Under **How to get it**, the window lists the steps, and
one button opens the company's page. In short:

| Export | Ask for it | Wait |
|---|---|---|
| **Google Takeout** | On Google Takeout, click **Deselect all**, then tick **Mail**, **Calendar**, **Contacts**, **Google Photos** and **My Activity**. Under **My Activity**, click **Multiple formats** and choose **JSON**. Keep **.zip**, choose **10 GB** files, and click **Create export**. | Minutes, or hours with photos. Download every file from Google's email. |
| **Spotify** | On Spotify's Privacy page, tick **Extended streaming history**, then click **Request data**. | Up to 30 days. Download the zip from Spotify's email. |
| **ChatGPT export** | In ChatGPT, open **Settings** › **Data controls** and click **Export data**. | A few minutes. Download the zip within 24 hours. |
| **Claude export** | In Claude, open **Settings** › **Privacy** and click **Export data**. | A few minutes. Download every file Claude's email offers. |
| **Google Maps Timeline** | On your phone, open Google Maps › **Settings** › **Personal content** › **Export Timeline data**. | None. Save the file to Files. |

To make an iPhone backup:

1. Plug your iPhone into this Mac. In Finder, choose it in the sidebar.
2. Under **Backups**, choose **Back up all of the data on your iPhone to this Mac**.
3. Tick **Encrypt local backup**, and set a password. Your calls are in the backup only when it is
   encrypted.
4. Click **Back Up Now**. It takes an hour or more, and you can use your iPhone meanwhile.

## Hand the files to Lifestream

On your Mac, drag the files onto the window, where it says **Drop the zip here**, or click
**Choose file…** and choose them. On your iPhone, open the import under **Connectors** and tap
**Choose from Files**. You can hand over several files at once, a zip as you downloaded it, or the
folder you get when you open the zip. There is nothing else to click.

Lifestream reads a copy, and your file stays where it is. Lifestream never moves, renames or
deletes it.

### An iPhone backup

An iPhone backup is not a file you drop. On the Mac that holds Lifestream, the window lists your
backups under **Backups on this Mac**, newest first, each by your iPhone's name as Finder lists it
and the day it was made, such as **Work iPhone · 28 Aug 2026**. Click **Read it** on the backup
you want.

If Finder saved the backup's password in your keychain, macOS asks if Lifestream may use it. Click
**Allow**. Otherwise Lifestream asks for the password you set in Finder. Lifestream uses the
password to read the backup and does not keep it. Your Mac never sends it to Lifestream.

The backup's row then says how far your Mac has read it: **Opening…**, then **Reading your backup ·
iMessage**, **· WhatsApp · 41,000 of 96,000 photos and files** and **· Calls**. Your Mac sends only
the photos and files Lifestream does not have yet. While your Mac sends the backup, its row says
**Sending to Lifestream**, and **Your imports** lists **iMessage**, **WhatsApp** and **Calls** as
they wait and send. When Lifestream has them, the row says **Brought in 16 Nov**, and the backup's
imports come in under **Your imports** like any other.

If a backup shows another row, such as **Not encrypted: your calls aren't in it.**,
[Problems and fixes](./problems.md#an-iphone-backup) says what it means.

Lifestream lists the backups where Finder makes them. On your iPhone or on another Mac, the
window says **On your Mac** in place of the list. Lifestream only reads a backup. It never
changes or deletes it.

## Watch it come in

Under **Your imports**, the window lists each file your Mac is sending, then each import, newest
first. A file's line says how far it has gone:

- **Checking…**: your Mac is looking at what the file holds.
- **Waiting its turn**: your Mac sends one file at a time, after your connectors' newest data.
- **Sending · 12 MB of 41 MB**: your Mac is sending the file to Lifestream.
- **Imported**: Lifestream has the file and reads it.

Each import is one row, named by the day the export was made and whose it is, such as
**1 Nov 2026 · person-a@example.com**. Its line says **Importing** while Lifestream reads it, and
then **Imported** with the years it covers, such as **Imported · 2014–2026 · 48,112 plays**. Click
**Open a day** to see a day from that past. Your Mac also shows a notification once, such as
**Spotify imported**.

### When you may delete what you downloaded

When an import is in, its row says **You can delete the file you downloaded.** Lifestream keeps
what it read. Until then, keep the file: if it does not reach Lifestream, you hand it over again.

An iPhone backup's imports do not say this: you keep the backup for your phone.

## When Lifestream asks whose it is

Most exports name the account they are from, and Lifestream reads it from the files. When the
files name none, such as a Google Maps Timeline export or a Takeout of Google Photos alone,
Lifestream asks **Whose Spotify is this?**, or **Whose Google account is this Takeout from 14 Nov?**.
Nothing of the import comes in before you answer.

Choose an account from the list, or type it under **Another account** and click **Choose**. For a
Takeout, the account that already holds another part of the same Takeout is first. You can answer
on your Mac or your iPhone.

If the export turns out to be of another account than the one you chose, Lifestream says so and
asks again. For example, a Spotify export must hold the plays your first Spotify export began with.

Your iPhone backup's imports are named by the iPhone it is of and the day it was made: one read of a
backup brings in two imports, both **Work iPhone · backup of 28 Aug**, one holding **iMessage** and
**Calls**, the other **WhatsApp**, side by side. Its row under **Backups on this Mac** takes the
same name. What they hold goes to the connectors of the iPhone the backup is of. If Lifestream
can't tell which iPhone that is, it asks **Which iPhone is this backup from?** once, above the
backup's imports. Choose the iPhone, or **An iPhone not set up with Lifestream**.

## More than one import

- **The same file again**, from any Mac: its line says **Already imported · 1 Nov**, and
  nothing is sent.
- **A newer export of the same account** is a new import. What both exports hold is kept once.
- **An older export after a newer one** brings in what the newer one lacked. It never replaces
  what the newer one said.
- **An export of a second account** is its own import. The two accounts never mix.
- **A part of a Takeout that comes days later** joins its import, which reads **Importing**
  again.

## When a file could not be read

Lifestream keeps a copy of a file until it has read everything in it, then lets the copy go. It
keeps the copy when the file holds something it could not read, or does not read yet, and the
file's line says why, such as **Kept · 2 files couldn't be read**. Click **Remove file** to remove
Lifestream's copy. What Lifestream read from the file stays.

When files of an import could not be read, the import says so, such as **Imported · 2009–2026 · 7
files couldn’t be read**. Click **Skip it** to stop the message and let go of those files.

## Problems and fixes

When a file or an import shows a line this page does not explain, such as **Couldn’t open it**,
[Problems and fixes](./problems.md#imports) says what it means and what to do.

## Bring in an export from the command line

On the Mac that holds Lifestream, you or an agent can hand over a file in Terminal, such as:

```sh
lifestream import spotify ~/Downloads/my_spotify_data.zip
```

The first word names the export: `google-takeout`, `spotify`, `chatgpt`, `claude` or
`google-timeline`. Add `--account <account>` to say whose the export is. The command does not take
an iPhone backup. The import then shows in the window like any other.

## Next

- [Gmail](./connectors/gmail.md), to bring in new mail as it arrives.
- [Chat with your life](./chat.md), to ask about your past.
