# Spotify

The Spotify connector brings in every song, episode and audiobook chapter you have played on Spotify,
since your account began. It comes from the export Spotify makes when you ask for your data, which
you hand to Lifestream on your Mac.

## What it brings in

- Every play, with when it ended and how long it played.
- The track and its artist and album, the episode and its show, or the audiobook and its chapter.
- Music videos and video podcasts, as well as audio.

It does not bring in plays of music files stored on your own devices.

Each export holds every play since your account began, so the first one brings in your whole past.
A later export adds only the plays since the last one: a play both hold is kept once.

## Before you start

- Lifestream on your Mac.
- The Spotify account whose plays you want, to ask Spotify for your data.

## Add Spotify

1. Open **Connectors**, then **Spotify export** under **Imports**.
2. Follow the window's steps: ask Spotify for your extended streaming history, and download the zip
   from its email.
3. Drop the zip on the window, or click **Choose…** and choose it.

[Bring in your past from an export](../imports.md) says each step, and what the window says as the
export comes in. Spotify is then connected, and its window has a **Spotify export** row
under **Comes from**.

## Where it shows up

- **Timeline** shows each time you listened as one line: when, the device type, and up to three
  tracks by name, such as "Song One by Artist A". An episode or audiobook you heard for 15 minutes
  or more shows its minutes.
- **Search** finds a track, episode or audiobook by its title, its artist or its album.
- **Chat** reads what you listened to when a question needs it.

If you also added [Now playing](./now-playing.md), a play that both connectors hold shows once.

## What a model reads

No AI model reads Spotify, so its window has no **AI** section.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Spotify has the [settings every connector has](./README.md#settings-every-connector-has).

## Limits

- New plays arrive only with a new export. Spotify takes up to 30 days to make one, so your newest
  plays reach Lifestream weeks after you hear them.
- Spotify times a play you made offline by when it logged the play, often days later. Timeline
  shows such a play at that time, and adds "offline, timed when logged".
- An export must hold the plays your first Spotify export began with. Lifestream refuses an export of
  another account, and asks again whose it is.

## Problems and fixes

Spotify shows no messages of its own. For the ones every connector can show, see
[Connectors](./README.md#messages-every-connector-can-show). For the ones an import can show, see
[Bring in your past from an export](../imports.md#problems-and-fixes).
