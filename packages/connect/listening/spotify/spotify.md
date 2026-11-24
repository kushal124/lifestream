# Spotify listening: `spotify:<user>:export`

One Spotify account's extended streaming history; `<user>` is the account's username. It comes
as the Spotify export the person hands their home ([imports.md](../../imports/imports.md)):
the download as Spotify hands it over, `my_spotify_data.zip`, or the folder it unzips to, read
alike (`spotify-export`). Its members, found by name under any leading folders, are
`Spotify Extended Streaming History/Streaming_History_Audio_<years>.json` and
`Streaming_History_Video_<years>.json`, each a JSON array of plays, and a `ReadMeFirst` PDF,
which is passed over knowingly (the connector's `export.leaves`). Plays are read one at a time,
each a part: a member that cannot be read is refused alone, and one whose array breaks keeps the
plays before the break.

| Kind | Key | Content | Time |
|---|---|---|---|
| `play` | `<end, UTC basic form>:<URI>`, the URI the play's track, episode or audiobook chapter | `{ type: "spotify.play", history: "audio" \| "video", play }`, the play as listed, every member | `ts`, the whole second |

A play states exactly one of `spotify_track_uri`, `spotify_episode_uri` and
`audiobook_chapter_uri`; the other item members are null (an episode's track name, artist and
album are null too). A play naming none or two (a local file names none) is refused alone. `history` is the member it
is listed in: an audio play, or a video (a music video, a video podcast).

## An export is the whole history

Each export restates every play since the account began. The same export twice lands
nothing new (every play `restated`); a later one lands only the plays since the last.

**Plays that share a key.** Spotify writes `ts` at the second, and an offline play's `ts` is
when it was logged, often days after `offline_timestamp`, so a batch synced at once can list one
track twice in one second: in one real history, about 800 keys over 1,800 rows, mostly offline
plays. Rows that differ are distinct plays (another `ms_played`, `offline_timestamp` or reason).
They are ranked by the SHA-256 of their canonical content, never by the download's order: the
first keeps the key, the next is `<key>:1`, then `:2`. A row listed twice byte for byte (about
70 in that history) is one play logged twice and states one record (the home counts the second
`duplicated`). A later download that lists the same plays in another order lands the same
records; one that adds a play to a shared key can move a rank (`changed`), never mint a second
record of a play already held. The connector reads the delivery twice, once to find the shared
keys; its memory is one entry per play.

## The account

The history names no account (`username` is absent from every play). The account is the
`username` a `Userdata.json` among its members names (Spotify's account data, when the person
asked for it beside the history: the reader's `account`); an export that holds none is asked
whose it is. The source names it. Two guards keep another account's plays out:

- Every `Userdata.json` the export holds must state the source's `username`; another refuses
  the delivery.
- The source keeps an anchor, the earliest play of the first export it was fed. The history is
  cumulative, so every later export of the account restates it; one that does not is another
  account's (or lost plays) and is refused before anything lands, in the person's words, and the
  question whose it is asked again (the reader's `states`, read whole before any row).

## Time and the address

A play's time is `ts`, the instant Spotify states it ended, as a point. Its start is not stated:
`ts` minus `ms_played` is the start only for a play heard through without a pause, and an
offline play's `ts` is its logging. The [listening family](../../../families/listening/)
reads `play`: it starts a play `ms_played` before `ts` and says an offline play's clock is its
logging. `offline_timestamp` (Unix seconds in older plays, milliseconds in newer) is kept.

Every play keeps `ip_addr` and `conn_country`, as listed: they are the person's own record of
where they listened, kept as a mail's `Received` headers are.

## Asked for by the person

Spotify has no export API. The person asks at spotify.com/account/privacy, ticking **Extended
streaming history** (and **Account data**, which carries `Userdata.json`), and confirms the ask
by the link Spotify mails. Spotify says up to 30 days; the mail "Your extended streaming
history is ready to download" comes from noreply@spotify.com with a link that downloads
`my_spotify_data.zip` in the signed-in browser. The person drops it on the Spotify import's
window (the connector's `export.guide` says the two steps).

What the export states of itself (`states`) is read whole before any row: every play must be
named and timed (a play it refuses is the read's to refuse again, never the export's), and it
must restate the anchor its source keeps. Its time is its newest play's end, which orders it
against another export of the account: an older export brought in late never outranks a newer
statement of a play. A file read whole, its read-me beside it, is let go by the home's sweep.

## What the listening family reads

**Adapter** `spotifyListening` (adapter.ts; [listening](../../../families/listening/)):
a `play` record is one play heard, ending at `ts` (the record's time) after its `ms_played`, on the
`platform` it lists, `offline` as stated. The item is named by the one URI it lists: a track
(`spotify_track_uri`) is `master_metadata_track_name` by `master_metadata_album_artist_name` on
`master_metadata_album_album_name`; an episode (`spotify_episode_uri`) is `episode_name` by
`episode_show_name`; an audiobook chapter (`audiobook_chapter_uri`) is `audiobook_title`, the
chapter (`audiobook_chapter_title`) as its album. `reason_start`, `reason_end`, `shuffle`,
`skipped`, `incognito_mode`, `offline_timestamp`, the URIs themselves, `conn_country` and `ip_addr`
are not read. A play states no app: the history is the player, named by the connector's name.
