# Machine events: `machine:local:<unit>`

Each device's own diary, one source per device, its unit's: a Mac's logs (reader
`machine-events`, the `mac` road) and a phone's `machine` domain (reader `machine-ios-bundle`, the
`phone` road). Each detail is copied as the device stated it; an event name outside the one closed
list both readers hold refuses its line. A line that does not read (a Mac's that is not UTF-8, not
one JSON object or states no instant; a phone's of another kind, or with an instant core cannot
read) is refused alone, and the next line is read.

**A Mac's logs.** The sealed log files `<opened at>.jsonl` the Mac app ships (never
`current.jsonl`), one event per line: sleep, lock, power, lid, Wi-Fi, recorder, microphone, camera
and output events, and the peripherals: displays attached, detached and rearranged, Bluetooth
devices connecting and disconnecting, and the ambient light when it changes by a factor of two and
holds.

**A phone's diary.** Its bundle's `machine.jsonl` ([ios-app](../../ios-app/ios-app.md)), shipped
once its pass names the source; each line of kind `machine-event` holds the event and its detail
as its `payload`.

**What a device allows**,
on both: `state` holds each grant the device states as a flat member, `access_<grant>: <state>`
(a Mac's in each log's first line; a phone's once, at the first launch of an install with none);
`access`, `{grant, state}`, is written for each grant whose state differs from what the diary last
held, never `asking`. The diary is history only: what the device allows now is what it states on
its exchanges, which the door keeps.

| Reader | Kind | Key | Content | Time |
|---|---|---|---|---|
| `machine-events` | `machine-event` | `<at in basic form>:<event>` (`20260906T231000.25Z:wifi_join`), `:<rank>` by file then line | `machine.event`: event, detail (flat strings, numbers, booleans) | `at` |
| `machine-ios-bundle` | `machine-event` | the recorder key, `<install id>:<sequence>` | the same | the line's `observed_at` |

The screen family reads a Mac's diary as evidence of sittings, never a phone's.

## Ledger

How the Mac keeps custody of its source: each seal's ledger entry holds the batches it carried, by their spool names. `MachineEventsDomainTests` hold each answer.
A phone's diary is kept as every domain of its bundle is ([ios-app](../../ios-app/ios-app.md)).

1. **Order.** A batch name is the instant it opened: a label, never the order. A seal takes every sealed batch no seal up to `received` carried, so a batch named behind one already shipped (a clock that stepped back, `<instant>-2.jsonl` beside `<instant>.jsonl`) still ships.
2. **Reuse.** No: a name is never given twice.
3. **Rebuilds.** Deleting the spool loses nothing the home holds; new batches have new names.
4. **Late arrivals.** A batch the last run left open is sealed at the next launch, and ships.
5. **Edits.** None: a sealed batch is never written again.
6. **Lost.** A batch leaves once a seal up to `imported` carried it and it opened more than 30 days ago; one no imported seal carried stays however old. After a restore below the seal that carried deleted batches, the next bundle states `<n>` `machine event batches, up to that many: this Mac deleted them after an earlier import`, and the same seal sealed again states it again.

## Its adapter

`adapter.ts`, the screen family's: role `machine`, its kind
`machine-event`, which says how a sitting ended. Only the Mac's diary plays it (`plays`: reader
`machine-events`); a phone's says nothing of a sitting.
