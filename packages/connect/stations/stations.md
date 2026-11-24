# Stations: `stations:local:<home>`

The tabs the home's own errands opened, each claimed by the door as a station answers `open`, or
as a station names a tab of its own that no `open` named (`StationInfo.tabs`: a tab an errand's page
opened, a tab Chrome's session restore brought back). The station's errands load pages
in the person's own Chrome profile, so Chrome keeps each load in that profile's history; a claim
is how the home knows such a visit is no page the person was shown. An owner source, shown
nowhere: the home keeps it under no device and nothing a person sets up. `<home>` is the home's
unit, the `unit` setting; the home makes the source itself at every start.

## What it reads

Each claim is one owner-statements delivery, read by the one statements reader
(`shared/statements.ts`), sealed by the door itself as a station answers `open`, before the door
answers the driver, or as an exchange names a station's tabs, before the door answers the station
(`home/door.ts`, `home/stations.ts` `claimed`), under the door's own pass,
`<machine>/stations/door-token`, which the home's start keeps with `deliver` on this source and
nothing else (`home/lifecycle.ts` `passStations`). A seal that fails is logged and never fails the
errand: a read matters more than a label. Every row's device is that pass's unit, `stations`.

```
{"kind":"tab","key":"chrome-5550aa01:1001:1791000000000","content":{"type":"stations.tab","station":"chrome-5550aa01","tab":1001,"errand":"e-0000aa01","from_ms":1791000000000,"until_ms":1791000660000}}
```

## Kinds and keys

| Source | Connector | Kind | Key | Content | Time |
|---|---|---|---|---|---|
| `stations:local:<home>` | `stations-home` | `tab` | `<station>:<tab>:<from_ms>` | `{type: "stations.tab", station, tab, errand, from_ms, until_ms}` | `from_ms` to `until_ms` |

- **`station`**: the unit of the station that opened the tab, `chrome-` and eight hex digits.
- **`tab`**: the id Chrome gave the tab, which is `context_annotations.tab_id` on its visits.
- **`errand`**: the errand's id, `e-` and eight hex digits: the one whose `open`, or whose page,
  made the tab. Null for a tab Chrome restored, whose errand was a past browser session's.
- **`from_ms`, `until_ms`**: the moment the door sent the `open`, and the errand's deadline; for a
  tab the station named, the span it states (`StationTab`: from the tab made to its errand's
  deadline, or from the browser's start to the tab closed). Each is widened by 60 s for a station on
  another machine's clock. The span is what makes an id safe: an
  id Chrome repeats after a kill claims nothing outside it.

No URL, title or page word. Every member not named here is refused.

What a claim decides, and only that, is the web family's ([web](../../families/web/)). A
claim names no Mac and no Chrome profile: the door knows a station by its unit alone, so the rule
reads every Chrome source's visits by tab id and span.
