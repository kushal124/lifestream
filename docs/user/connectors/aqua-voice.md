# Aqua Voice

The Aqua Voice connector brings in what you dictate with Aqua Voice on your Mac. The Mac app reads
Aqua Voice's history every 5 minutes and sends it to Lifestream.

## What it brings in

- Each dictation's words twice: as Aqua Voice heard them, and as it wrote them.
- Its time, and how long you spoke.
- The sound of the dictation, when Aqua Voice kept it.

Aqua Voice keeps only your last 100 dictations, so your past is those 100. Lifestream keeps every
dictation it brings in, also after Aqua Voice drops it. Aqua Voice does not say which app you
dictated into, so Lifestream does not know it.

If several people use Aqua Voice on your Mac, Lifestream keeps each account's dictations apart.

## Before you start

- Lifestream on your Mac.
- Aqua Voice on the same Mac, with at least one dictation.

## Add Aqua Voice

Lifestream looks for Aqua Voice on your Mac by itself, and needs no permission to read it. When it
finds it, Aqua Voice is connected on **Connectors**, and your dictations arrive within 5
minutes. If it is still not connected, click it: its window says what is missing.

## Where it shows up

- **Timeline** shows each dictation at its time, with the words as written, such as
  `Dictated with Aqua Voice: "Send the draft by Friday."` Dictations within 5 minutes of each
  other are one block. A dictation longer than 1,000 characters is cut there, and Timeline says
  how many characters it had.
- **Search** finds a dictation by its words.
- **Chat** reads your dictations when a question needs them.

## What a model reads

No AI model reads Aqua Voice, so its window has no **AI** section. The words are already text, and
Lifestream sends the sound to no model.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Aqua Voice has the [settings every connector has](./README.md#settings-every-connector-has) that fit
it. By default, it checks for new dictations **Every 5 minutes**. It always brings in every
dictation Aqua Voice still keeps, and you cannot narrow that.

## Problems and fixes

These are the messages only Aqua Voice shows. For the ones every connector can show, see
[Connectors](./README.md#messages-every-connector-can-show).

**Install Aqua Voice on** *your Mac's name*\
Lifestream did not find Aqua Voice on this Mac. Install it, and dictate once.
