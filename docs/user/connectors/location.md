# Location

The Location connector records where you go, point by point, on your iPhone. Lifestream on your
iPhone records it and sends it to Lifestream, which turns the points into the places you stayed
and the trips between them.

## What it brings in

- Each point your iPhone records: where it was and how accurate that is, with the altitude,
  speed, direction and floor when iOS knows them.
- Each gap: a time when your iPhone recorded nothing, such as when it was off or iOS stopped
  Lifestream.

Location has no past to bring in. It starts when you allow it.

Your iPhone records all the time, and sends what it recorded when iOS wakes Lifestream. Your
iPhone decides when that is.

## Before you start

- Lifestream on your iPhone, [paired with your Mac](../pair-your-iphone.md).
- Location set to **Always** for Lifestream, so it records while Lifestream is closed.

## Add Location

Your iPhone asks for **Location, Always** during its setup. If you skipped it:

1. On your iPhone, open **Connectors**, tap **Location**, then tap **Allow**.
2. iOS asks twice. Choose **Allow While Using**, then **Change to Always Allow**.

If iOS does not ask the second time, tap **Open Settings** on Location's page, and set Location
to **Always**.

On your Mac, Location is on **Connectors** too, with your iPhone's icon after its name.

## Where it shows up

- **Timeline** shows each day as the places you stayed and the moves between them, with how you
  travelled, such as a walk or a drive. A stay is at least 5 minutes within about 80 metres of one
  point.
- **Places** shows the places you go, the cities you were in and your trips. A spot you return to
  is offered for you to name. [Name your places](../name-your-places.md) says how.
- **Chat** reads where you were when a question needs it.

## What a model reads

No AI model reads Location, so its window has no **AI** section.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Location has none of the [settings every connector has](./README.md#settings-every-connector-has):
your iPhone decides when to send, and there is no past to bring in.

It has one setting of its own, in its window on your Mac and on its page on your iPhone.
**Precision** says how closely your iPhone records:

- **Precise**, the default, records the way you go, point by point.
- **Battery saving** records where you stay and each move of a few hundred metres, not every
  street. It uses less battery.

## Limits

- With **While Using only**, Lifestream records only while it is open, and your days miss the way
  between places.
- If Precise Location is off for Lifestream in iOS Settings, every point is approximate.
- A point less accurate than 100 metres is not used to find your stays and trips.
- When your iPhone is off, or iOS stops Lifestream, nothing is recorded. Lifestream does not guess
  where you were in that time.

## Problems and fixes

These are the messages only Location shows, or shows for a reason of its own. For the ones every
connector can show, see [Connectors](./README.md#messages-every-connector-can-show).

**Allow Location**\
Location is off for Lifestream on the iPhone named under it. On that iPhone, open **Connectors**, tap
**Location**, then tap **Allow** or **Open Settings**, and set Location to **Always**.

**Location is limited**\
The iPhone named under it allows Location only while Lifestream is open. On that iPhone, tap
**Allow** or **Open Settings** on Location's page, and set Location to **Always**.

**Nothing new since** *a time*\
Lifestream has had no point from your iPhone since then. Location expects new points every
day. Open Lifestream on your iPhone, and check that it is paired and that Location is **Always**.

## Remove Lifestream's access

[Pause or disconnect](./README.md#pause-or-disconnect-a-connector) Location as you would any
connector. To also stop your iPhone recording, set Location to **Never** for Lifestream in iOS
Settings.
