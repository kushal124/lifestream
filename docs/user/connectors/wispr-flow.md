# Wispr Flow

The Wispr Flow connector brings in what you dictate with Wispr Flow on your Mac. The Mac app reads
Wispr Flow's history every 5 minutes and sends each new or changed dictation to Lifestream.

## What it brings in

Everything Wispr Flow keeps about each dictation:

- Its words in each form Wispr Flow saved: as heard, as formatted, as pasted, and as you edited
  them after.
- The app you dictated into, and the address of the page you were on, when Wispr Flow saved one.
- Its time.
- The sound of the dictation, and the screenshot Wispr Flow took with it, when it took one.
- The other context Wispr Flow saved, such as what was already in the text box.

It does not bring in Wispr Flow's meetings, notes or dictionary.

Your past comes in newest first: first the last 7 days, then older dictations. If you edit a
dictation in Wispr Flow later, the change comes in too. If you delete one there, Lifestream keeps
it.

## Before you start

- Lifestream on your Mac.
- Wispr Flow on the same Mac, signed in. Lifestream knows the account by its email address.

## Add Wispr Flow

Lifestream looks for Wispr Flow on your Mac by itself, and needs no permission to read it. When it
finds it, Wispr Flow is connected on **Connectors**, and your dictations start to arrive
within 5 minutes. If it is still not connected, click it: its window says what is missing.

## Where it shows up

- **Timeline** shows each dictation at its time, as "Dictated into", the app as Wispr Flow names
  it, and your last version of the words. For a page, it adds the page's site and path, never the
  rest of its address. Dictations into one app and page within 5 minutes of each other are one
  block. A dictation longer than 1,000 characters is cut there, and Timeline says how many
  characters it had.
- **Search** finds a dictation by its words.
- **Chat** reads your dictations when a question needs them.

## What a model reads

No AI model reads Wispr Flow, so its window has no **AI** section. The words are already text, and
Lifestream sends the sound and the screenshots to no model.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Wispr Flow has the [settings every connector has](./README.md#settings-every-connector-has) that fit
it. By default, it checks for new dictations **Every 5 minutes**, and brings in your past from Lifestream's
start.

## Problems and fixes

These are the messages only Wispr Flow shows. For the ones every connector can show, see
[Connectors](./README.md#messages-every-connector-can-show).

**Install Wispr Flow on** *your Mac's name*\
Lifestream did not find Wispr Flow on this Mac. Install it, and sign in.
