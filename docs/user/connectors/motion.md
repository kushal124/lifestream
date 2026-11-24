# Motion

The Motion connector records how you move: when you walk, run, cycle, drive or stay still, and your
steps each day. Lifestream on your iPhone reads it from iOS and sends it to Lifestream.

## What it brings in

- Each change in what iOS senses you doing: still, walking, running, cycling or in a vehicle, and
  how sure iOS is of it.
- Your steps each day, with the distance and the floors you went up and down, as iOS counts them.

When you allow Motion, the iPhone app also reads the 7 days before, or from the connector's start
if that is later. Your iPhone decides when to
send what it recorded, as it does for [Location](./location.md).

## Before you start

- Lifestream on your iPhone, [paired with your Mac](../pair-your-iphone.md).

## Add Motion

Your iPhone asks for **Motion & Fitness** during its setup. If you skipped it:

1. On your iPhone, open **Connectors**, tap **Motion**, then tap **Allow**.
2. Allow Motion & Fitness when iOS asks.

If iOS does not ask, tap **Open Settings** on Motion's page, and turn on Motion & Fitness.

## Where it shows up

- **Timeline** uses Motion with your [Location](./location.md) to show how you travelled between
  places, such as a walk or a drive, and when you left a place. Without Location, Timeline shows
  nothing from Motion.
- **Chat** reads how you moved when a question needs it.

## What a model reads

No AI model reads Motion, so its window has no **AI** section.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Motion has none of the [settings every connector has](./README.md#settings-every-connector-has): your
iPhone decides when to send, and it has no settings of its own.

## Limits

- Timeline uses only what the iPhone app records as it happens. The 7 days it reads back are kept
  in Lifestream, but they do not change your Timeline.
- Timeline counts your steps from the [Health connector](./health.md), not from Motion. Your steps
  from Motion are kept in Lifestream.

## Problems and fixes

This is the message Motion shows for a reason of its own. For the ones every connector can show,
see [Connectors](./README.md#messages-every-connector-can-show).

**Nothing new since** *a time*\
Lifestream has had no activity from your iPhone since then. Motion expects something new every
day. Open Lifestream on your iPhone, and check that it is paired and that Motion & Fitness is on.

## Remove Lifestream's access

[Pause or disconnect](./README.md#pause-or-disconnect-a-connector) Motion as you would any
connector. To also stop your iPhone recording, turn off Motion & Fitness for Lifestream in iOS
Settings.
