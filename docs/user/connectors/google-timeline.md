# Google Maps Timeline

The Google Maps Timeline connector brings in the places you stayed and the trips you made, as Google
Maps saved them on your phone. It comes from the file Google Maps exports on your phone, which you
hand to Lifestream on your Mac or your iPhone.

## What it brings in

- Each visit: when you stayed at a place, where it is, and Google's id for it.
- Each trip between places: when, how far, and how you moved, such as walking, cycling, flying or
  in a car.
- The path of points Google Maps recorded along the way.

Google Maps keeps your Timeline on your phone, so the export holds every visit and trip your phone
kept. The first export brings in your whole past. A later export adds only what is new: a visit both
hold is kept once.

## Before you start

- Google Maps on your phone, with Timeline on.
- The Lifestream app on your Mac or your iPhone.

## Add Google Maps Timeline

1. On your phone, open Google Maps › **Settings** › **Personal content** › **Export Timeline
   data**. Google Maps exports it at once.
2. Save the file to Files.
3. Open **Connectors**, then **Google Maps Timeline** under **Imports**. On your Mac, drop the file
   on the window. On your iPhone, tap **Choose from Files** and choose it.
4. The export names no account, so Lifestream asks whose it is. Choose one of your Google accounts.

[Bring in your past from an export](../imports.md) says what the window shows as the file comes in.
Google Maps Timeline is then connected, and its window has the export as a row under **Comes from**.

## Where it shows up

- **Timeline** shows each visit as a stay at a place, and each trip as a move between places, such
  as a walk or a drive.
- **Places** shows the places you went and the cities you were in, and offers a spot you return to
  for you to name. [Name your places](../name-your-places.md) says how.
- **Chat** reads where you were when a question needs it.

Where your iPhone's [Location](./location.md) or your photos also say where you were at the same
time, Timeline follows them first.

## What a model reads

No AI model reads Google Maps Timeline, so its window has no **AI** section.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Google Maps Timeline has the [settings every connector has](./README.md#settings-every-connector-has).

## Limits

- New visits arrive only with a new export from your phone.
- Lifestream does not read how sure Google was of a place, or the other places it guessed.
- A file you share to Lifestream from another app does not come in as Google Maps Timeline. Choose
  it in the import's window.

## Problems and fixes

Google Maps Timeline shows no messages of its own. For the ones every connector can show, see
[Connectors](./README.md#messages-every-connector-can-show). For the ones an import can show, see
[Bring in your past from an export](../imports.md#problems-and-fixes).
