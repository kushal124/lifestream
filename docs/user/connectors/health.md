# Health

The Health connector brings what Apple Health on your iPhone holds into Lifestream: your sleep, steps,
heart, workouts and anything else you allow. The iPhone app reads Health and sends it to Lifestream.

## What it brings in

- Every sample of every kind you allow. A sample is one reading Health keeps, such as your heart
  rate at one moment or one night's stage of sleep. Each sample keeps the app or device that
  recorded it, such as an Apple Watch.
- Workouts, with their length and distance.
- Your ECGs and heartbeat readings, whole.
- State of Mind: the moods and feelings you log in Health.
- Your date of birth, sex, blood type, skin type and wheelchair use, as Health holds them.

When you delete a sample in Health, the iPhone app tells Lifestream, and it leaves your Timeline.

Your past comes in with the first read: everything Health holds of each kind you allow, from the
connector's start on.

## Before you start

- The iPhone app, [paired with your Mac](../pair-your-iphone.md).
- Your Apple ID added to the iPhone app. Health waits for it. If you skipped it when you paired,
  open **Connectors** on your iPhone, tap **Lifestream**, type your **Apple ID**, then tap **Add**.

## Add Health

The iPhone app asks for Health during its setup. If you allowed it then, there is nothing to do.

1. On your iPhone, open Lifestream, then **Connectors**, then **Health**.
2. Tap **Allow**. iOS shows Health's own sheet.
3. Choose the kinds of data Lifestream may read, and allow them.

iOS does not tell apps what you allowed in Health. Samples start to arrive in Lifestream once the
iPhone app has read and sent them.

## Where it shows up

- **Timeline** shows your steps among each day's figures, such as "8,412 steps", or "steps so far"
  on today. Each workout is a row named by its activity, such as "Running".
- **Chat** reads your health data when a question needs it.

## What a model reads

No AI model reads Health, so its window has no **AI** section. Every figure Timeline shows from it
is counted from your samples.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Health has none of the [settings every connector has](./README.md#settings-every-connector-has). It
has no **Check every**, because the iPhone app reads Health each time iOS has new data for it. It
has its **History**, whose **Starts from** sets the day before which it reads nothing, but no
**Catch up every**: your past comes in with the first read.

To change which kinds of data Lifestream reads, open the Health app on your iPhone, under
**Sharing**, **Apps**.

## Limits

- iOS hides what you did not allow. A kind you turned off in Health reads as empty, so Lifestream
  cannot tell it from a kind with no data.
- Lifestream does not read your medications, your doses or your vision prescriptions. iOS asks for
  each of those in a sheet of its own.
- Workout routes are not kept.
- State of Mind and your date of birth and other details are kept in Lifestream, but Timeline does
  not show them.

## Problems and fixes

These are the messages only Health shows. For the ones every connector can show, see
[Connectors](./README.md#messages-every-connector-can-show).

**Allow new Health data**\
A newer iPhone app reads kinds of data that Health has not asked you about yet. Everything else
still comes in. On your iPhone, open **Connectors**, then **Health**, and tap **Allow**. iOS asks
only about the new kinds.

**Health, Photos and Contacts start once you add your Apple ID.**\
The iPhone app shows this under the Apple ID field. Type your Apple ID, then tap **Add**.

## Remove Lifestream's access

[Pause or disconnect](./README.md#pause-or-disconnect-a-connector) Health as you would any
connector. To also stop iOS letting Lifestream read Health, turn it off in the Health app on your
iPhone, under **Sharing**, **Apps**.
