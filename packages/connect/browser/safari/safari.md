# Safari on a Mac: `safari:<apple id>:<unit>`

**Reads** `history.sqlite`, what changed in the Mac's Safari `History.db`, and
`cloudtabs.sqlite`, what changed in Safari's `CloudTabs.db` when the Mac has one, each when it
changed (`kind: "changes"`). Every visit, tombstone and tab the files hold is stated. A delivery from an older Mac (a `VACUUM INTO` copy, or a delta stating `after` and `through`, with the tabs whole) holds whole rows too and is read the same way, for one release more. The
history holds this Mac's visits and those synced from the account's other devices (`origin` 1).
It is the default Safari profile's history.

| Kind | Key | Content | Time |
|---|---|---|---|
| `page-visit` | `<history_visits.id>:<visit_time>` (`5:811584000.25`) | `safari.visit`: visit (every `history_visits` column), item (the page: `id`, `url`, `domain_expansion`), null when the history holds no item | `visit_time` (Core Data seconds); zero or `NULL`, no time |
| `tombstone` | `<history_tombstones.id>:<start_time>` (`1:-63114076800`) | `safari.tombstone`: tombstone (every `history_tombstones` column; an encrypted `url` as `$bytes64`) | `start_time` to `end_time` (Core Data seconds); an edge of zero or outside the years 1000 to 9999 (Safari's "from the beginning" is year 1), no time |
| `tab` | `cloud_tabs.tab_uuid` | `safari.tab`: tab (every `cloud_tabs` column, BLOBs as `$bytes64`), device (its `cloud_tab_devices` row or null), close_requests (the `cloud_tab_close_requests` naming it, in canonical order) | `last_viewed_time`; zero or `NULL`, no time |

- **Deletions.** A tombstone (`history_tombstones`) states that the visits of its URL, or of
  every URL when it states none, inside `start_time` to `end_time` were removed. Every visit the
  home holds live that a tombstone names, and the history no longer holds, lands `gone`. The
  home's view is required to find them; a history with a tombstone and no view is refused. A
  visit merely missing, and a tab no longer listed, are never `gone`.
- **A deletion is never lost.** Each tombstone is a `tombstone` record, so a deletion holds
  whatever the home held when it was read: a history read after a later delivery (an older one
  read again by a later code, or a failed import retried) yields `gone` every visit a tombstone
  that a later delivery stated, and this history does not hold, names, where it would land it
  live. A delivery read in order finds none and reads as before.
- A tombstone whose URL Safari keeps encrypted (bytes, not text) lands as a record and names no
  visit: the visits it removed stay as they are.
- A tombstone travels with every visit the history still holds inside its span, so a visit it
  names that the file does not hold is one Safari removed.
- **Keys.** A visit's id is this file's own, and a history made again hands it out again: a
  visit is named by its id and its time as Safari states it, which never changes.
- A visit copies its own fields and the identity of the page it names, not the page's counters
  and scores, which change with every later visit of it.
- A file without the tables or columns this page names is refused, naming them. Each store is its
  own file, a part: one that does not open, lacks a table or column, or breaks part way through
  its pages (one in WAL mode, copied without its log, would) is that file's refusal, the rows it
  gave before keeping, and the other is read. A delivery holding neither file yields no rows.

**Adapter** `safariWeb` (adapter.ts) reads the web family's `page-visit` and `tab` for it
([web](../../../families/web/)): a visit is its page's
`url` and the visit's `title`, synced when `origin` is 1; a visit that redirected onward
(`redirect_destination` set) is no page the person was shown and reads as nothing. A tab is its
last view, `title`, `url`, and its device's `device_name` (synced, naming no device, when it has none). A tombstone is no input of the family.

## Ledger

How the Mac keeps custody of this source: a memory of each store, per pass, holding every row sent by table, key, fingerprint and seal. `DatabaseDomainTests` in the macOS app hold each answer.

1. **Order.** None is needed: a read sends every row whose fingerprint the memory does not hold. Visits of the last 7 days (`visit_time`) go live; older ones in history pages, newest first; tombstones and tabs live.
2. **Reuse.** A key that comes back with other values has another fingerprint, and ships.
3. **Rebuilds.** Clearing history, or a new profile, can make `History.db` again: a new file, so the memory starts again and the whole history ships.
4. **Late arrivals.** A visit from another device gets its own id when it arrives and ships as any new row.
5. **Edits.** A tombstone, a tab, its device or its close requests changed ship; a visit's item (title, counters) is read by lookup and restates no visit: a visit keeps its page as it stood when the visit shipped.
6. **Lost.** Safari expires old visits: the ids between the memory's highest visit and the store's lowest are stated lost, once.
