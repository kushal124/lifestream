# Apple Calendar: `apple-calendar:<apple id>:<unit>`

**Reads** `calendar.sqlite`, the Mac's `Calendar.sqlitedb`
(`~/Library/Group Containers/group.com.apple.calendar/`): the one store every account in
Calendar syncs into (iCloud, Google and other CalDAV accounts, Exchange, subscriptions, the
Mac's own calendars). A delivery holds what changed (`kind: "changes"`): the items that changed,
or whose calendar, account, owned rows (participants, recurrences, alarms…), pointed rows
(locations, organizer…) or what those name did, with all of those and the series an occurrence
belongs to; the caches Calendar derives (`OccurrenceCache`, `OccurrenceCacheDays`, `AlarmCache`,
`ScheduledTaskCache`) hold no row. Every item the file holds is stated. A delivery from an older Mac (the whole store) holds whole rows too and is read the same way, for one release more.

| Kind | Key | Content | Time |
|---|---|---|---|
| `event` (`reminder` for a row of `entity_type` 3) | `<name>:<calendar>`. The name is the item's `unique_identifier`, its iCalendar UID; for a changed occurrence (`orig_item_id` names its series) the series' UID and `orig_date`: `<UID>:YYYYMMDD` for an all-day series, `<UID>:YYYYMMDDTHHMMSSZ` (its whole UTC second) otherwise; a row with no UID, the fingerprint of its summary, start, end and all-day flag. The calendar is its calendar's `external_id`, else its `UUID`, else empty, with `%` written `%25` and `:` written `%3A` | `apple.calendar-item`: `item` (the `CalendarItem` row), `calendar` and `store` (the calendar and the account it belongs to), the rows the item points at (`location`, `start_location`, `end_location`, `client_location`, `organizer`, `self_attendee`, `suggestion`, `error`, `image`, `color`) or null, and the rows that name it (`participants` each with its `identity`, `recurrences`, `exception_dates`, `alarms` with their `location`, `attachments` with their `file`, `conferences`, `categories` with their `category`, `actions`, `contacts`), each list in canonical order | all-day: the dates its start and end state; timed with a zone: start to end; a floating time or no start: none |

- A row is copied column for column as `rowJson` spells it, except a NULL, which states
  nothing, and the row ids and pointers the content resolves (`ROWID`, `calendar_id`,
  `orig_item_id`, `location_id` and the other pointers above; a child's `owner_id`). A column a
  later macOS adds lands in every record once it states a value.
- `calendar` keeps the columns that name a calendar and state its kind, colour, owner, sharing
  and subscription (`UUID`, `external_id`, `title`, `type`, `color`, `subcal_url`, …); `store`
  keeps `name`, `type`, `external_id`, `persistent_id`, `owner_name`, `constraint_path`,
  `creator_bundle_id`, `delegated_account_owner_store_id`, `app_group_id`. Their sync state
  (tokens, digests, last sync times, display order) moves with every sync and is not copied.
- The name is `calendar/google/`'s key, so one meeting a Google calendar and this store both
  hold is found by it: the key without its last `:` part. Example: Google's
  `SYNTH-UID-0002@google.com:20260928T083000Z` is this store's
  `SYNTH-UID-0002@google.com:20260928T083000Z:/person-a@example.com/events/`.
- One UID in two calendars (one invitation in two accounts) is two records, one per calendar:
  `SYNTH-UID-0001:/1/calendars/home/` and `SYNTH-UID-0001:/person-a@example.com/events/`. No key
  reads a row id or the order rows sit in: deleting one copy, or a store rebuilt in another order,
  leaves the other's key as it was.
- Two rows with one key (one UID twice in one calendar) are one record stated twice: they are
  read one after the other in the canonical order of their content, so the one that lands (the last) is
  the same whatever order the store holds them in, and the run counts the other `duplicated`.
- All-day times: the store writes a floating date as that date's midnight in UTC and the end as
  the last second of its last day; an end at a midnight is exclusive and ends the day before.
  Timed values are instants in UTC; `start_tz` and `end_tz` stay in `item`.
- **No `gone`.** The store states a deletion only in `CalendarItemChanges`, which it empties as
  soon as Calendar's own clients have read it; an event missing from a delivery is never gone.
  A cancelled event stays a row, and its `status` says so.
- Refused whole: no `calendar.sqlite`; a store without `CalendarItem`, `Calendar`, `Store` or
  `_SqliteDatabaseProperties` and the columns the key and time read; a child table without the
  column naming its item.

## Its adapter

`adapter.ts` gives the calendar family its calendar adapter (`packages/core/inputs/calendar.ts`):
`authority: "mirror"` (the store mirrors the account's calendars: an event an own calendar
holds prints the own calendar's, and the store never states a deletion), `keys: "held"` (a key
is `<name>:<calendar>`), `units: "product"` (`apple-calendar:<apple id>/<name>`). It reads
`event` and `reminder`:

| Kind | Read |
|---|---|
| `event` | from `item`: `summary`, `start_tz`, `status`, `conference_url`, `last_modified`; `organizer`, `self_attendee` and `participants` (each one's `email`, `identity`, `status`, `is_self`, `UUID`); `location` (`title`, else `address`); `recurrences` (the first one's `frequency`); whether `conferences` is empty |
| `reminder` | from `item`: `summary`, `due_date`, `due_all_day`, `due_tz`, `completion_date`, `last_modified`; the `calendar`'s `title` as its list |

The store states codes: a participant's `status` 1 not replied, 2 accepted, 3 declined, 4 maybe;
an item's `status` 1 confirmed, 2 tentative, 3 cancelled; a recurrence's `frequency` 1 daily, 2
weekly, 3 monthly, 4 yearly (another prints as `repeats`). The attendee count leaves the
organiser out. The store's record time is a row's start, so a reminder here is due by
`due_date`, read by the Reminders store's rule (all-day: the date; a zone stated: the instant;
floating: none); its copy is a copy of the reminder the Reminders store names. Its words are the
title, the location's title and address and `description`, and the parties' addresses.

## Ledger

How the Mac keeps custody of this source: a memory of the store, per pass, holding every row sent by table, key, fingerprint and seal. `DatabaseDomainTests` in the macOS app hold each answer.

1. **Order.** None is needed: a read sends every item whose fingerprint, or a row's read into it, the memory does not hold. Items have no pages: a store holds thousands.
2. **Reuse.** A key that comes back with other values has another fingerprint, and ships.
3. **Rebuilds.** Calendar can rebuild its store: a new `_UniqueIdentifier` starts the memory again, and every item ships.
4. **Late arrivals.** An item synced late is a changed row, and ships.
5. **Edits.** Caught: an item, or any row read into it, changed in place changes a fingerprint. A calendar's sync state moving restates its items.
6. **Lost.** Nothing: every item the store holds ships once it changed.
