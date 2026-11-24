# iMessage

The iMessage connector brings the messages in Messages on your Mac into Lifestream. Lifestream reads
Messages on your Mac every 5 minutes, and brings in your past, newest first.

## What it brings in

- Every message in Messages on your Mac, with who sent it and who received it.
- The attachments of each message: photos, videos, voice notes and other files.
- Every chat, with the people in it, and the name of each group.
- Tapbacks, the reactions you and others add to a message.
- Edits, and messages that were unsent.

It does not bring in whether you have read a message or played a voice note.

An attachment comes in once its file is on your Mac. If Messages keeps a file in iCloud, the file
comes in when Messages downloads it.

Messages from the last 7 days come in first. Older messages follow, newest first, back to the
oldest message on your Mac.

## Before you start

- Lifestream on your Mac, allowed to use Full Disk Access. The steps below allow it.
- Messages in iCloud turned on, on your iPhone and on your Mac, so your Mac holds every message.

## Add iMessage

iMessage needs [Full Disk Access](./README.md#full-disk-access). If you allowed it on **Mac
Sources** when you set up Lifestream, and kept iMessage ticked there, it is already connected.
Otherwise:

1. Open **Connectors**, then **iMessage**.
2. Under **To connect**, click **Allow** beside **Allow Full Disk Access on** *your Mac's name*.
   System Settings opens.
3. Find **Lifestream** in the list, and turn its switch on.
4. If macOS offers to quit Lifestream, choose **Later**.

iMessage is then connected, and your messages start to arrive.

## Where it shows up

- **Timeline** shows each chat as a conversation, with the messages you sent quoted. Open a
  conversation to read all of it, with its photos, voice notes and tapbacks.
- **Search** finds a message by its words, or by who sent or received it, such as
  `+15550000001`. It also finds a photo by its description and a voice note by its words.
- **People** joins the people you message with the same people in your other chats, emails and
  contacts.
- **Chat** reads your messages when a question needs them.

A one-to-one conversation on Timeline has **Open in Messages**, which opens the chat on your Mac.

## What a model reads

A model writes **Photo descriptions** of the photos in your chats, so they read as text on Timeline
and in Search. A model also writes **Voice note transcripts**: what is said in your voice notes.

- **Sends:** only the photo or the voice note. Each file goes once, even when it is in several
  chats.
- **Never sends:** the chat, its other messages, or who sent the file.
- **Hidden first:** the personal details in a photo. A voice note can't be hidden, so it goes to a
  model off your Mac only when you allow it, as
  [What leaves your Mac](../what-leaves-your-mac.md#what-is-hidden-before-sending) says.
- **By default:** the **Default** model for both, for your messages from 30 days before you added
  iMessage. If the model for photos is your ChatGPT or Claude plan, your photos go to OpenAI or
  Anthropic. Neither plan transcribes voice notes.
- **To stop it:** set **Photo descriptions** or **Voice note transcripts** to **Off**.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

iMessage has the [settings every connector has](./README.md#settings-every-connector-has). By
default, it checks for new messages **Every 5 minutes**, and brings in your past from Lifestream's start.

It has two settings of its own, under **Settings**. A group you are quiet in is one line at the end
of each day on Timeline, with its name and how many messages it had, instead of all its messages.
Search still finds them.

- **Quiet after**: how long you can go without writing in a group before you are quiet in it: **30
  days**, **90 days**, **6 months**, **1 year** or **Never**. The default is **90 days**.
- **Count group messages**: which group messages count toward the people you talk to on People:
  **Groups, on days you write there**, **Every group** or **No groups**. The default is **Groups, on
  days you write there**.

The row **Quiet groups** under them, with how many groups you are quiet in, opens the groups on
People. There you can set one group to **Always quiet** or **Never quiet**.

## Limits

- Lifestream reads only what Messages on your Mac holds, not your iPhone.
- If you delete a message on your Mac, Lifestream keeps the copy it already brought in. A message
  deleted before Lifestream read it is not in Lifestream.
- If a message is unsent, Timeline shows that it was deleted, and not its words.
- If you turn Messages in iCloud off and on again, Lifestream reads all of Messages again. The
  messages it already holds are not doubled.

## Remove Lifestream's access

[Pause or disconnect](./README.md#pause-or-disconnect-a-connector) iMessage as you would any
connector. Taking back [Full Disk Access](./README.md#full-disk-access) in System Settings stops
iMessage too, with every other connector that needs it.
