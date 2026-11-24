# Granola

The Granola connector brings your Granola meetings into Lifestream: each meeting's summary, your own
notes and who was there. Lifestream signs in to Granola, checks for new meetings every 5 minutes,
and brings in your past.

## What it brings in

- Each meeting's title and time.
- Granola's summary of the meeting, and the notes you wrote in it.
- The names and email addresses of the people who were there.

The rest depends on how you connect:

| Way to connect | Your Granola plan | What comes in |
|---|---|---|
| **Sign in with Granola** | Any plan | Every meeting, without its transcript. A free plan gives only the last 30 days. |
| **Use an API key** | A Business or Enterprise plan | Every meeting, with its transcript. |

With **Sign in with Granola**, your past comes in right after you connect. With an API key, it
comes in batches of up to 30 meetings, one batch a minute, newest first, and a meeting comes in once
Granola has written its summary.

## Before you start

- Lifestream on your Mac. Granola is added from the Mac app.
- A Granola account.
- For an API key, a key made in Granola: open **Settings**, then **Connectors**, then **API
  keys**, and create a key with **Personal notes** only.

## Add Granola

1. Open **Connectors**, then **Granola**.
2. Click **Sign in**. If you have not made your vault yet, Lifestream asks you to make it first and
   gives you a recovery key. Save the key somewhere safe.
3. If Lifestream shows the two ways to connect, click **Connect** beside the one you want.

To sign in with Granola:

1. Click **Open Granola**. Your browser opens Granola.
2. Sign in to Granola, enter the code Lifestream shows if Granola asks for it, then allow
   Lifestream.

To use an API key, type your **Granola email** and your **API key**, and click **Connect Granola**.
Lifestream tests the key with Granola before it saves it.

Granola is then connected, and your meetings start to arrive.

If **Sign in** shows a code and you want to use an API key, sign in with Granola first. Then click
**Change** beside your Granola account under **Comes from**, and click **Connect** beside **Use an
API key**. Only the way you connected with last runs. Each meeting is kept once, whichever way
brought it in.

## Where it shows up

- **Timeline** shows each meeting at its time, under its title. Open it to read the summary and
  your notes.
- **Search** finds a meeting by its title, its summary, your notes, or the email address of anyone
  who was there, such as `person-a@example.com`.
- **Chat** reads your meetings when a question needs them.

Timeline and Search do not show a meeting's transcript.

## What a model reads

No AI model reads Granola, so its window has no **AI** section.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Granola has the [settings every connector has](./README.md#settings-every-connector-has). By
default, it checks for new meetings **Every 5 minutes**, and brings in your past from Lifestream's start.
**Catch up every** applies only to an API key, and is **Every minute**.

## Limits

- With **Sign in with Granola**, Lifestream checks only the last 30 days of meetings for changes.
  A change to an older meeting does not come in.

## Problems and fixes

These are the messages only Granola shows. For the ones every connector can show, see
[Connectors](./README.md#messages-every-connector-can-show).

**Granola did not accept this API key.**\
Lifestream shows this while you connect. Check the key, or make a new one with **Personal notes**
only, and try again.

**Granola did not answer. Try again in a moment.**\
Your Mac could not reach Granola while you connected. Nothing was saved. Check your internet, then
try again.

**Granola said no.** or **This code ran out.**\
You did not allow Lifestream in Granola in time. Click **New code**, then **Open Granola**, and
allow Lifestream.

**Sign in to Granola again**\
Granola no longer accepts Lifestream's sign-in, or the API key was deleted. Click **Sign in**, and
connect again.

**Granola allows more at** *a time*\
Granola asked Lifestream to slow down. It goes on by itself at the time shown.

## Remove Lifestream's access

[Pause or disconnect](./README.md#pause-or-disconnect-a-connector) Granola as you would any
connector. If you used an API key, also delete it in Granola, under **Settings**, then
**Connectors**, then **API keys**.
