# Devices: `devices:local:<home>`

The owner's word on the cameras that took the home's photos: whether a camera is theirs. It is an
owner source, as the owner's places are ([places](../places/places.md)): the home keeps it under no
device, and a device only reads the list and writes the owner's edits to it. `<home>` is the home's
unit, the `unit` setting; the home makes the source itself at every start, a phone paired or none.

A camera is the owner's when it took 50 photos or more, or is a paired phone's own camera
([cameras](../labelers/cameras/cameras.md)), unless the owner says otherwise here. The word wins
for the dates it covers; outside them the count decides again.

## What it reads

Each edit is an act: `POST /v1/owner/act` with `of: "devices"` (`camera {camera, mine, from?, to?}`,
`forget {camera}`) by a pass with `deliver` on the source (the phone's; the dashboard's), which the
home's owner writer (`packages/home/owner-act.ts`, the drafter `packages/home/devices-draft.ts`)
drafts against the heads, seals as one owner-statements delivery and lands before it answers; no pass ships a bundle of it.
Each row's device is the unit of the pass that sent it. The statements are read with this
connector before they are sealed, so a line it would refuse is 422 `STATEMENTS_BAD` and nothing is
sealed. A pass that delivers it reads the list back at `GET /v1/devices`, without `read`, and
reads the word there as soon as the act is answered.

```
{"kind":"camera","key":"<camera id>","content":{"type":"devices.camera","mine":false}}
{"kind":"camera","key":"<camera id>","content":{"type":"devices.camera","mine":false,"from":"2026-03-01"}}
{"kind":"camera","key":"<camera id>","gone":true}
```

## Kinds and keys

| Source | Connector | Kind | Key | Content | Time |
|---|---|---|---|---|---|
| `devices:local:<home>` | `devices-home` | `camera` | the camera's id | `{type: "devices.camera", mine, from?, to?}` | none |

- **The key** is a camera's id as the cameras labeler names it: `<make>/<model>`
  (`apple/iphone-17-pro`, `shared/exif.ts` `cameraId`) or `phone/<unit>`.
- **`mine`**: true or false.
- **`from`, `to`**: calendar dates, `YYYY-MM-DD`, each optional, `from` not after `to`. They are
  civil dates in the home's day (a day runs from the home's `day_start_hour` in its zone), both
  inclusive: "not mine from 2026-03-01" is the day a phone was handed to someone else. With
  neither, the word holds always.
- **One word a camera.** A new word replaces the old one, dates and all; stating the camera gone
  takes the word back, and the count decides again. Its history stays.

What the word decides, and only that, is the labels family's: each camera's unit `camera:<id>`
holds `mine_by_count` and this word, and `Labels.mine(camera, at_ms)` answers from it
([labels](../../families/labels/)).
