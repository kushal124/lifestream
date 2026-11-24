# Input events: `input:local:<unit>`

**Reads** the sealed log files `<opened at>.jsonl` the Mac app ships (never `current.jsonl`), one
chunk per wall-clock minute per line. A line that does not read (not UTF-8, not one JSON object,
an `at` that is not a millisecond UTC instant) is refused alone, named `<file>:<line>`, and the
next line is read. A line whose `at` reads takes its rank before any later check, so a code that
reads more of a line never moves another line's key.

| Kind | Key | Content | Time |
|---|---|---|---|
| `input` | the chunk's `at` in basic form (`20260906T230100Z`), `:<rank>` by file then line | `input.chunk`: the line without `at` (until, layout, apps, sites?, events, activity?, lost?, recovered?) | `at` to `until` |

A minute the Mac could not write for space (or whose line failed) arrives as its loss-only line, in
its own minute: the same `at`, `until` and `layout`, `apps: []`, `events: []`, and `lost` counting
every event the minute held. Only a minute whose loss-only line failed too is lost unstated.

## Ledger

How the Mac keeps custody of this source: each seal's ledger entry holds the batches it carried, by their spool names, and how many of them this Mac has since deleted. `InputEventsDomainTests`, `InputEventLogTests` and `CustodyTests` hold each answer.

1. **Order.** A batch name is the instant it opened: a label, never the order. A seal takes every sealed batch no seal up to `received` carried. The newest chunk's `until` is read back from the spool at launch, so a relaunch within the minute, or on a clock that reads the same instant again, never gives two chunks the same `at`.
2. **Reuse.** No.
3. **Rebuilds.** Deleting the spool loses nothing the home holds; new batches have new names.
4. **Late arrivals.** Measured once: a batch named 09:25:54 appeared 655 s after the one named 10:14:52. It ships with the next seal.
5. **Edits.** None.
6. **Lost.** A batch leaves once a seal up to `imported` carried it and it opened more than 30 days ago; one no imported seal carried stays however old. After a restore below the seal that carried deleted batches, the next bundle states `<n>` `input batches, up to that many: this Mac deleted them after an earlier import`, and the same seal sealed again states it again.

## Its adapter

`adapter.ts`, the screen family's: role `input`, its kind
`input`, read beside a sitting's frames.
