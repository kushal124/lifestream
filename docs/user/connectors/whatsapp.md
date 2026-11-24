# WhatsApp

The WhatsApp connector brings your WhatsApp chats and calls into Lifestream. Lifestream reads WhatsApp
for Mac every 5 minutes, and brings in your past, newest first.

## What it brings in

- Every chat and group, with its messages and who sent each one.
- The media of each message: photos, videos, voice notes, stickers and documents.
- Shared contacts and shared locations.
- Replies, edits, reactions, and messages deleted for everyone.
- Your WhatsApp calls: who, when, how long, voice or video, and whether it was missed.
- The name each person sets in their WhatsApp profile, and each group's name.

A photo or other file comes in once it is on your Mac. If WhatsApp for Mac has not downloaded it,
the message comes in without it, and the file follows when WhatsApp downloads it.

Messages from the last 7 days come in first. Older messages follow, newest first, back to the
oldest chat WhatsApp for Mac holds, including the history it copied from your phone.

## Before you start

- Lifestream on your Mac, allowed to use Full Disk Access. The steps below allow it.
- WhatsApp for Mac, installed and linked to your phone.

## Add WhatsApp

WhatsApp needs [Full Disk Access](./README.md#full-disk-access). If you allowed it on **Mac
Sources** when you set up Lifestream, and kept WhatsApp ticked there, it is already connected.
Otherwise:

1. Open **Connectors**, then **WhatsApp**.
2. Under **To connect**, click **Allow** beside **Allow Full Disk Access on** *your Mac's name*.
   System Settings opens.
3. Find **Lifestream** in the list, and turn its switch on.
4. If macOS offers to quit Lifestream, choose **Later**.

WhatsApp is then connected, and your chats start to arrive.

## Where it shows up

- **Timeline** shows each chat as a conversation, with the messages you sent quoted. Open a
  conversation to read all of it, with its photos, voice notes and shared places. Each call is a
  line of its own, such as "Missed call" or "You called".
- **Search** finds a message by its words, or by who sent it. It also finds a photo by its
  description and a voice note by its words.
- **People** joins the people you message with the same people in your other chats, emails and
  contacts. It also shows the name each person sets in their WhatsApp profile.
- **Chat** reads your chats when a question needs them.

## What a model reads

A model writes **Photo descriptions** of the photos in your chats, so they read as text on Timeline
and in Search. A model also writes **Voice note transcripts**: what is said in your voice notes.

- **Sends:** only the photo or the voice note. Each file goes once, even when it is in several
  chats.
- **Never sends:** the chat, its other messages, or who sent the file.
- **Hidden first:** the personal details in a photo. A voice note can't be hidden, so it goes to a
  model off your Mac only when you allow it, as
  [What leaves your Mac](../what-leaves-your-mac.md#what-is-hidden-before-sending) says.
- **By default:** the **Default** model for both, for your chats from 30 days before you added
  WhatsApp. If the model for photos is your ChatGPT or Claude plan, your photos go to OpenAI or
  Anthropic. Neither plan transcribes voice notes.
- **To stop it:** set **Photo descriptions** or **Voice note transcripts** to **Off**.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

WhatsApp has the [settings every connector has](./README.md#settings-every-connector-has). By
default, it checks for new messages **Every 5 minutes**, and brings in your past from Lifestream's start.

It has three settings of its own, under **Settings**. A group you are quiet in is one line at the end
of each day on Timeline, with its name and how many messages it had, instead of all its messages.
Search still finds them.

- **Archived groups are quiet**: **Yes** makes you quiet in every group you archived in WhatsApp.
  The default is **Yes**.
- **Quiet after**: how long you can go without writing in a group before you are quiet in it: **30
  days**, **90 days**, **6 months**, **1 year** or **Never**. The default is **90 days**.
- **Count group messages**: which group messages count toward the people you talk to on People:
  **Groups, on days you write there**, **Every group** or **No groups**. The default is **Groups, on
  days you write there**.

The row **Quiet groups** under them, with how many groups you are quiet in, opens the groups on
People. There you can set one group to **Always quiet** or **Never quiet**.

## Limits

- Lifestream reads WhatsApp for Mac, not WhatsApp on your phone. A chat that WhatsApp for Mac does
  not hold is not in Lifestream.
- If you delete a message or a chat, Lifestream keeps the copy it already brought in. A
  disappearing message is in Lifestream only if Lifestream read it before it disappeared.
- If a message is deleted for everyone, Timeline shows that it was deleted, and not its words.
- Timeline does not show reactions, or whether a message was edited. Lifestream keeps them.
- Timeline does not show status updates or broadcast lists.
- If you link WhatsApp for Mac again, Lifestream reads all of it again. The messages it already
  holds are not doubled.

## Problems and fixes

These are the messages only WhatsApp shows, or shows for a reason of its own. For the ones every
connector can show, see [Connectors](./README.md#messages-every-connector-can-show).

**Install WhatsApp on** *your Mac's name*\
Lifestream cannot find WhatsApp for Mac. Install it, and link it to your phone.

## Remove Lifestream's access

[Pause or disconnect](./README.md#pause-or-disconnect-a-connector) WhatsApp as you would any
connector. Taking back [Full Disk Access](./README.md#full-disk-access) in System Settings stops
WhatsApp too, with every other connector that needs it.
