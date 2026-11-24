# Now playing

The Now playing connector brings in what you listen to: each time a song, podcast or other audio
starts, pauses or changes. It reads the log that macOS keeps of what is playing on your Mac, and on
your other devices that sync to it.

## What it brings in

- Each play, pause and change of track, in any app that tells macOS what is playing, such as Music,
  Podcasts or Spotify.
- The title, the artist or the podcast's author, the album and the length of each track or
  episode.
- The app that played it.
- The same from your other devices, once macOS syncs their log to your Mac.

macOS keeps this log for about four weeks, so your past goes back about that far. Your Mac sends
what is new to Lifestream at most once an hour. A play on another device reaches your Mac when that
device syncs, which can take hours or days.

## Before you start

- Lifestream on your Mac, allowed to use Full Disk Access. The steps below allow it.

## Add Now playing

Now playing needs [Full Disk Access](./README.md#full-disk-access). If you allowed it on **Mac
Sources** when you set up Lifestream, and kept Now playing ticked there, it is already connected.
Otherwise:

1. Open **Connectors**, then **Now playing**.
2. Under **To connect**, click **Allow** beside **Allow Full Disk Access on** *your Mac's name*.
   System Settings opens.
3. Find **Lifestream** in the list, and turn its switch on.
4. If macOS offers to quit Lifestream, choose **Later**.

Now playing is then connected, and your plays start to arrive.

## Where it shows up

- **Timeline** shows each time you listened as one line: when it started and ended, the device,
  and up to three tracks by name, such as "Song One by Artist A", with the app. An episode you
  heard for 15 minutes or more shows its minutes.
- **Search** finds a track or episode by its title, its artist or its album.
- **Chat** reads what you listened to when a question needs it.

A listening session ends when nothing plays for more than 15 minutes. A pause is not counted as
time you listened. If you also added [Spotify](./spotify.md), a play that both connectors hold shows
once.

## What a model reads

No AI model reads Now playing, so its window has no **AI** section.

When Chat or an agent answers a question, it can read this connector's data too. [What leaves
your Mac](../what-leaves-your-mac.md) says what leaves your Mac then, and to whom.

## Settings

Now playing has the [settings every connector has](./README.md#settings-every-connector-has). By
default, it checks for new plays **Every 5 minutes**, and brings in your past from Lifestream's start.
Whatever **Check every** says, your Mac sends new plays at most once an hour.

## Limits

- Lifestream knows a play has ended only when the log says so. If the log says nothing more soon
  after the track should have ended, Timeline says that no end was stated, and does not guess.

## Remove Lifestream's access

[Pause or disconnect](./README.md#pause-or-disconnect-a-connector) Now playing as you would any
connector. Taking back [Full Disk Access](./README.md#full-disk-access) in System Settings stops Now
playing too, with every other connector that needs it.
