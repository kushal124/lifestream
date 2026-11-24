# Apple Reminders: `apple-reminders:<apple id>:<unit>`

**Reads** every `Data-<id>.sqlite` of a delivery: the Mac's Reminders stores
(`~/Library/Group Containers/group.com.apple.reminders/Container_v1/Stores/`), one per account
(iCloud, the Mac's local account, Siri's found-in-apps list, any other), each under its own
name when it changed (`kind: "changes"`): the reminders that changed, with the reminders they are
subtasks of, and the store's lists and objects whole. A delivery from an older Mac (every store whole) holds whole rows too and is read the same way, for one release more. Entities are found by name in
each store's `Z_PRIMARYKEY`. Other files are not read.

| Kind | Key | Content | Time |
|---|---|---|---|
| `reminder` | `<name>:<account>`. The name is `ZIDENTIFIER` as an upper-case UUID (the spelling of its CloudKit record name and of the calendar store's `x-apple-reminderkit://REMCDReminder/<UUID>`); without one, `ZCKIDENTIFIER`; without either, the fingerprint of `ZTITLE` and `ZCREATIONDATE`. The account is its `ZACCOUNT` row's `ZCKUSERRECORDNAME`, else that row's `ZIDENTIFIER` as an upper-case UUID, else empty, with `%` written `%25` and `:` written `%3A` | `apple.reminder`: `reminder` (the `ZREMCDREMINDER` row), `list` (with its `entity` and its parent list's name) and `account` (with its `entity`) or null, `parent` (the parent reminder's name) or null, `objects` (every `ZREMCDOBJECT` row naming it by row or by identifier, each with its `entity`, an alarm's `trigger`, a hashtag's `label`), `alerts` (its `ZREMCDDUEDATEDELTAALERT` rows), lists in canonical order | `ZDUEDATE`: a date when `ZALLDAY`, else the instant when `ZTIMEZONE` names a zone; a floating time or no due date: none |

- A row is copied column for column as `rowJson` spells it (identifiers and documents as
  `$bytes64`), except a NULL, which states nothing; Core Data's own columns (`Z_PK`, `Z_ENT`,
  `Z_OPT`, `Z_FOK_*`, `Z<n>…`); the row pointers the content resolves (`ZLIST`, `ZACCOUNT`,
  `ZPARENTREMINDER`, `ZREMINDER…`, `ZALARM`, `ZTRIGGER`, `ZHASHTAGLABEL`, …); and the replica's
  sync bookkeeping, which moves with every sync of an unchanged reminder: `ZCKSERVERRECORDDATA`,
  `ZCKSERVERSHAREDATA`, `ZCKCLOUDSTATE`, `ZCKDIRTYFLAGS`, `ZCKNEEDS…`, the `ZRESOLUTIONTOKENMAP…`
  merge clocks, `ZDUEDATERESOLUTIONTOKENASNONCE`, `ZSPOTLIGHTINDEXCOUNT`,
  `ZLASTBANNERPRESENTATIONDATE`, `ZDAPUSHKEY`, `ZDASYNCTOKEN` and the app-version floors.
- `list` keeps the columns that name it and state its kind, colour and sharing, never its
  ordering of reminders; `account` keeps `ZIDENTIFIER`, `ZCKIDENTIFIER`, `ZCKUSERRECORDNAME`,
  `ZEXTERNALIDENTIFIER`, `ZNAME`, `ZTYPE`, `ZINACTIVE`, `ZPERSONID`.
- The account part is the name CloudKit gives the Apple account's user (`ZCKUSERRECORDNAME`), the
  same on every Mac of that account and in every rebuild of its store. An account that states
  none (the Mac's local account, Siri's found-in-apps, a CalDAV or Exchange account) is named by
  its own `ZIDENTIFIER`. Example: `11111111-2222-4333-8444-000000000003:_synthetic-user-0001` in
  the iCloud store and `11111111-2222-4333-8444-000000000003:BBBBBBBB-0000-4000-8000-0000000000AC`
  in the local account's.
- One reminder in two accounts' stores is two records, one per account. No key reads a row id, a
  store's file name or the order stores and rows sit in: deleting one copy, renumbered rows or
  stores shipped in another order leave the other's key as it was.
- Two rows with one key (one reminder twice in one account) are one record stated twice: they are
  read one after the other in the canonical order of their content, so the one that lands (the last) is
  the same whatever order the stores hold them in, and the run counts the other `duplicated`.
- The family finds a reminder by its name, the key without its last `:` part, in this store and
  in the calendar store (`<name>:<calendar>`) alike.
- **No `gone`.** A deleted reminder first states `ZMARKEDFORDELETION` 1, which is copied; a
  purged one is missing, and missing is never gone.
- A reminder with neither identifier nor title nor creation date is refused alone by its guard.
- Each account's store is its own file: one that does not open as SQLite is that file's refusal,
  and the other stores are read.
- Refused whole: a store without `ZREMCDREMINDER`, `ZREMCDBASELIST`, `ZREMCDOBJECT`,
  `Z_PRIMARYKEY` and the columns the key and time read.

## Its adapter

`adapter.ts` gives the calendar family its calendar adapter (`packages/core/inputs/calendar.ts`):
`authority: "own"` (its reminders are the account's own: the calendar store's copy of one is a
copy of its unit), `keys: "held"` (a key is `<name>:<account>`), `units: "product"`
(`apple-reminders:<apple id>/<name>`). A `reminder` record is read from `reminder`: `ZTITLE`,
`ZCOMPLETED`, `ZCOMPLETIONDATE`, `ZFLAGGED`, `ZMARKEDFORDELETION` (deleted: it prints nothing),
`ZLASTMODIFIEDDATE`; the `list`'s `ZNAME`. Its due time is the record's. Its words are the
title and `ZNOTES`.

## Ledger

How the Mac keeps custody of this source: a memory of each store, per pass, holding every row sent by table, key, fingerprint and seal. `DatabaseDomainTests` in the macOS app hold each answer.

1. **Order.** None is needed: a read sends every reminder whose fingerprint the memory does not hold. Reminders have no pages: a store holds hundreds.
2. **Reuse.** A key that comes back with other values has another fingerprint, and ships.
3. **Rebuilds.** Each store's identity is its `Z_METADATA.Z_UUID`: a rebuilt store starts its memory again and ships whole. A store that went ships nothing; one that came ships whole.
4. **Late arrivals.** A reminder synced late is a changed row, and ships.
5. **Edits.** Caught: a reminder changed in place changes its fingerprint; a list, alarm, trigger, label or account changed restates every reminder of its store.
6. **Lost.** Nothing: every reminder a store holds ships once it changed.
