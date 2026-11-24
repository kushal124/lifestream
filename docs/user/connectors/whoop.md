# WHOOP

The WHOOP connector brings what your WHOOP band measures into Lifestream: your sleep, recovery,
strain, workouts, stress and heart rate. The Chrome extension reads it from WHOOP's website in
your own Chrome, checks for new data every hour, and brings in your past, newest first.

## What it brings in

- Each day as WHOOP scores it: your strain, your recovery, and your sleeps and workouts.
- The stages of each sleep.
- Your heart rate, at the resolution you choose.
- Your stress through the day.

Your past comes in batches of 36 days, one batch a minute. When WHOOP has nothing for 72 days in a
row, Lifestream takes that as the start of your account and stops. WHOOP can change a score for a
few days after it gives one, so once a day Lifestream reads the last 7 days again.

## Before you start

- The [Chrome extension](../chrome-extension.md), added and connected to Lifestream.
- The email and password you sign in to WHOOP with.

## Add WHOOP

1. Open **Connectors**, then **WHOOP**.
2. Click **Set up**. If you have not made your vault yet, Lifestream asks you to make it first and
   gives you a recovery key. Save the key somewhere safe.
3. Type your **WHOOP email** and your **WHOOP password**, and click **Connect WHOOP**. This also
   turns WHOOP on in the Chrome extension.

Your WHOOP data then starts to arrive, and your past follows.

## Where it shows up

- **Timeline** shows your time asleep and your recovery among each day's figures, such as
  "7h 12m asleep" and "64 recovery". Each night is a "Woke" row with your sleep and recovery. Naps,
  workouts and the day's strain have rows of their own: "Nap", "Workout" and "Strain".
- **Chat** reads your WHOOP data, your heart rate and stress included, when a question needs it.

If the WHOOP app also writes to Apple Health, and the [Health connector](./health.md) is on, the same
night, workout and heart rate reach Lifestream twice. Timeline shows each once, from the WHOOP
connector.

## What a model reads

No AI model reads WHOOP, so its window has no **AI** section.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

WHOOP has the [settings every connector has](./README.md#settings-every-connector-has). By default,
it checks for new data **Every hour**, and brings in your past from Lifestream's start, a batch **Every
minute**.

It has two settings of its own:

- **Heart rate resolution**: how often a heart rate reading is kept. Choose **Every 6 seconds**,
  **Every minute** or **Every 10 minutes**. The default is **Every minute**. A change applies to
  the days read after it. Readings already in Lifestream stay as they are.
- **Time zone**: the time zone that Lifestream splits your WHOOP data into days by.
  The default is **Lifestream's time zone**.

## Limits

- Lifestream reads WHOOP only while Chrome is open.
- WHOOP's website keeps you signed in for one day. Lifestream then signs in again in Chrome, with
  the email and password you set up.
- Timeline does not show your sleep stages. They are kept in Lifestream.
- If WHOOP asks Lifestream to slow down, Lifestream waits an hour before it reads again.

## Problems and fixes

These are the messages only WHOOP shows. For the ones every connector can show, see
[Connectors](./README.md#messages-every-connector-can-show). For the ones every site the Chrome
extension reads can show, see [Add the Chrome extension](../chrome-extension.md#when-it-stops).

**Type your WHOOP password**\
WHOOP refused the password Lifestream signed in with. Click **Set**, and type your WHOOP password
again.

**Confirm it's you**\
WHOOP asked for a code or a check after Lifestream signed in. Click **Open**, and finish it on
WHOOP's page.

**WHOOP allows more at** *a time*\
WHOOP asked Lifestream to slow down. It goes on by itself at the time shown.

## Remove Lifestream's access

Your WHOOP password is locked in your vault. Lifestream types it only into WHOOP's own sign-in
page.

[Pause or disconnect](./README.md#pause-or-disconnect-a-connector) WHOOP as you would any connector.
To also stop the Chrome extension reading WHOOP, turn WHOOP's switch off under **Accounts** in the
extension's popup in Chrome.
