# Google Calendar: `google-calendar:<account>:cloud` and `google-calendar:<account>:export`

One account's calendars through two channels, each its own source: Google renders one event
differently through each, and the API withholds what Gmail-made events say.

## What it reads

- **`gcal-api`**: a delivery the `gcal-api` acquirer sealed. `pull.json`
  (`org.lifestreamprotocol.google-calendar-api-pull/0.1`: account, fetched_at, time_min when
  a calendar was listed in full, pages with their calendar, next sync tokens, the UID of each
  event id a cancellation names, warnings) and each response page as Google sent it. Each
  item becomes one VEVENT text by one fixed projection (times, recurrence, summary, status,
  transparency, organizer, attendees, description, location, created, updated, sequence;
  folded at 75 octets). A cancelled item with no times is a deletion, `gone` under its
  iCalendar UID: its own, else the one the manifest states for its event id (for one
  occurrence of a series, its series' id). A deletion of an event the acquirer never listed
  names no record and lands nothing.
- **`gcal-export`**: every `.ics` file of the delivery, or, with none, every `.ics` member of
  its ZIPs. Each VEVENT is kept as the file holds it, its line breaks included. A content line
  ends at the line break the file's first line, `BEGIN:VCALENDAR`, ends with: CRLF, as RFC 5545
  and Google write, or a bare LF, which a file another program saved may hold; the file's last
  line may end at the end of the file instead, as Google's Takeout writes every `.ics`, with no
  break after `END:VCALENDAR`. A break of the other kind is a character of its line. A local time
  is placed only by the VTIMEZONE the same file states. Each file, and each VEVENT, is a part: a
  file is framed first (its components' BEGIN and END lines, its VTIMEZONEs, every byte inside its
  one VCALENDAR), and one whose frame does not read is refused, so a file cut short is refused
  whole; an event one of whose own lines does not read (no colon), whose time is before 2007, in
  a gap or in a fold, or that states DTSTART and no DTEND, is refused alone, and the rest lands. A
  file named `.zip` that is no zip is refused by its path.
  Each calendar is read alone: one whose filename ends in another account than the source's (the
  address its stem ends in; `<account>.ics` and the secondary `<Calendar>_<account>.ics` are the
  source's) is refused by its place, and the rest are read. A Takeout's delivery (an import:
  [imports.md](../../imports/imports.md)) is read only in the files its
  listing gives the source, and in them only the `.ics` members under `Takeout/Calendar/`, at any
  depth, a ZIP's or a gzipped tar's; once every row of such a file is landed and none refused, the
  reader states it consumed, and the home lets it go.

The `gcal-api` acquirer polls every 5 minutes (its connector's `refresh`). Its cursor holds the poll's
clock and a listing a stop cut short; the start it was left under is the home's (`lent.from_ms`). What it keeps of
each calendar is the poll's memory: part `calendar`, each calendar's sync token (written only
when Google moves it, an empty answer's move included); part `uid:<calendar>`, each event id with the UID it named, an id dropped when its own
deletion is listed; part `unresolved`, the series a cut listing sealed a cancelled occurrence of
before their UID was known, cleared when that listing ends. A calendar that leaves the list keeps
its token and its ids: one that comes back states deletions by those ids. A calendar
with no token or a refused token (HTTP 410) is listed in full from the
stream's start (`lent.start_ms`; for `all`, from the beginning), deleted events included, and so is
every calendar when the start moved, earlier or later, from the one the cursor was left under
(`lent.from_ms`), its token and any cut listing set aside. Google filters `timeMin` by an event's
end, and a sync answer lists every change: an event in a page that ends at or before the start,
not cancelled and not a series, is left out of the page kept. The
sign-in is one credential, sealed under the secret the connector's `signin` field names; the calendars
read are its `calendars`, each by its id; none named, the default, every calendar of the account
is read: Google's calendar list, asked each poll with hidden calendars, so a calendar made since is
read by the next, one shared as free/busy alone left out (Google lists none of its events), and a
list Google fails to answer refuses the poll. Every request goes through the request loop
(shared/http.ts) with the credential as its bearer: refreshed first when its access token is about
to expire, and once past a 401, from the credential alone (shared/oauth.ts `clientRefresher`: the
person's own client's id and secret and Google's token endpoint are in it), the whole credential
written to the secret store before anything else, a refresh token Google rotates among it. A
refresh Google refuses (`invalid_grant`) or a request it answers 401 after one refresh is
`NeedsYou` `signed-out`: the person signs in again. A 429 is a wait until its `Retry-After`.

**Signing in**: one `client` route, `gcal-api`, "Sign in with
Google", with the person's own Google client (`client.ts`, exported as the folder's `clients`; the
home keeps it once as `client.google.<n>`, named by the setting `clients.google`, for every route
that names it, Gmail's OAuth route the next). The scope is `calendar.readonly`; the check is a GET of
`calendars/primary`, whose `id` is the account's address. The client's `before` steps make a
project, publish its consent screen (a project left in Testing ends refresh tokens after seven
days) and make a client of type Desktop app; the route's own step (`steps`) turns on the Calendar API.
A poll whose every calendar answered its sync token with no change, none listed in full, no
warning and no stop, seals nothing: its cursor and its memory move alone. A stop part way through
a calendar (Google's limit, the sign-in refused) seals the pages read, and
the cursor keeps the listing at the page it reached, for the next poll to go on with first; a
listing that went on past a stop to a series a cancellation sealed before the stop named lists the
calendar in full again, so that deletion is keyed by its UID. A calendar's history is its full
listing, which polls carry on from page to page: the connector declares no pace.

## Its adapter

`adapter.ts` gives the calendar family its calendar adapter (`packages/core/inputs/calendar.ts`):
`authority: "own"` (the account's own calendar decides an event it holds, and the API's
cancellation is the record gone), `keys: "name"` (a key is the UID, or UID and occurrence),
`units: "account"` (`<account>/<key>`). An `event` record's VEVENT text is read by core's
iCalendar reader (`packages/core/ics.ts`, the SDK's `ics`), which the reader parses the export
with too, for its title, the zone DTSTART states, status, organiser, attendees and the account's own
response (the attendee whose address is the source's account), the video link (a
`X-GOOGLE-CONFERENCE`, or a Meet link in the description), the location and the repetition
rule; LAST-MODIFIED ranks a copy, and of two that print the same the export's is shown (rank 0,
the API's 1): it keeps descriptions the API replaces. Its words are the summary, the location
and description, and the organiser's and attendees' addresses.

## Kinds and keys

| Kind | Key | Content | Time |
|---|---|---|---|
| `event` | the iCalendar UID; for a changed instance of a series, `<UID>:<occurrence>` with the occurrence as `YYYYMMDD` or its whole UTC second `YYYYMMDDTHHMMSSZ` | `{type: "calendar.event", content: VEVENT text}`: the API's in CRLF lines, an export's in its file's breaks | the event's start and end with their stated offsets; an all-day event as days, its end the day after its last |
