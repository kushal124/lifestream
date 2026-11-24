# Example Log (a proof connector)

A home connector of the proof: a log no family reads, which reaches the day as a
plain line its folder declares. Synthetic: no program of this name exists, and no release holds this folder.

Source: `example-log:local:<home>`. Acquirer and reader: `example-log`, a poll of the log file on the home's Mac
(`file`), at most `lines` entries a fetch, from where the last fetch ended.

| Kind | Key | Content | Time |
|---|---|---|---|
| `entry` | its `id` | `{ type: "example-log.entry", id, at, text, title?, level? }` | `at`, an instant |

Its line (index.ts) is the entry's text, under its title where it has one; the day places it at the entry's own time.
