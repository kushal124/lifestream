# WHOOP: `whoop:<user id>:cloud`

One WHOOP account, read in the person's own signed-in Chrome the way WHOOP's website reads it: a site the extension holds from its
install, set up in its stream dialog (its email and password typed there, the password sealed in
the vault), never in the popup; its one lane `whoop`, run only while the site is chosen. `<user id>` is WHOOP's numeric user id, as the
page's own session names it; every `user_id` or `userId` a capture states must equal it. The copy is
the account's own (`cloud`), whatever road brings it, so a home that read WHOOP before keeps every
record under the same source.

## The session

WHOOP's page keeps its session in a cookie page script can read, `whoop-auth-token` on
`app.whoop.com`; WHOOP's API (`https://api.prod.whoop.com`) wants it as `Authorization: Bearer`.
Every read the lane makes is a request from WHOOP's own page, its `Authorization` read from that
cookie by the page as it sends it (shared/station.ts `Cookie`): the session never leaves the page,
an answer that repeats it is refused there, and the home keeps no WHOOP token and makes no call of
WHOOP's sign-in service.

Whose account the page is signed in to is the connector's probe: `who.url`, WHOOP's
`/users-service/v2/bootstrap/?accountType=users&apiVersion=7`, read with the cookie, names it by
`user.id` (the numeric user id every cycle states) and `account.email`; `account.id` is another
number, never the user id. A 401 there after the page loaded is the session lapsed: a wait,
`retrying`, the next call signing in again. What the lane does with the account is the
home's verdict on it, as every browser lane's: an account read is read
into its own source, its place its own entry of the poll's memory (part `account`, by the user
id; the cursor holds only when the lane last called), one turned off is not
(the wait `chrome`), one the stream holds no source of is offered (`other-account`), never read
unasked, but the stream's first. Each delivery's facts name the source and the account's email.

## Signing in

A web sign-in lasts one day: at the token's end WHOOP's page drops its cookies and `app.whoop.com/`
sends the tab to WHOOP's sign-in page on `id.whoop.com`. The site declares that origin and the
recipe that signs in there (`chrome.signin`, recipe `whoop-sign-in` in
[recipe.ts](recipe.ts)): the block's `email` typed into Email, the password
kept in the vault under the secret the block's `password` names (`lifestream-whoop-password` by
default; the recipe's parameter `password`) filled into Password, Sign In, then WHOOP's app.
The lane runs it in its own tab whenever the page landed there, and only there (shared/recipe.ts
`signInAgain`); WHOOP's page makes its own fingerprint, as it does for the person. The password is
filled only into WHOOP's own page, never sent anywhere else nor kept in a message.

What the page asks of the person stays theirs, the tab kept for them: a code or a check after Sign
In is `confirm`; a password WHOOP refuses (the page stays on its sign-in once Sign In was pressed) is
`password`, typed again where the home asks it; a password not kept is the vault's need for it, in a
sign-in's words. A page that is not what a step expects is the recipe broken, its password field
still showing before Sign In included. A block naming no `email` refuses each call. A probe answered 401 after a page that stayed
on the app (a session that lapsed between load and read) is a wait, `retrying`, never a need: the
next call's page lands on the sign-in and the recipe signs in again.

## What it reads

One call is one errand on WHOOP's page, as every site lane's is (shared/site-lane.ts: its origins
`app.whoop.com`, `id.whoop.com` and `api.prod.whoop.com` and the password its one secret come from
the declaration, ten minutes), and seals one delivery, its files kept under the block's `work` and
handed over by path:

- `app/`: `cycles-NNNNN.json`, the app's cycle answers as WHOOP sent them
  (`/core-details-bff/v0/cycles/details`, asked in 30-day slices: it answers newest-first and its
  `limit` did not bound the answer — 62 cycles came back for `limit=32` — so no page size is
  trusted). WHOOP answers every cycle overlapping the window asked but keeps in each only the
  children that overlap it, at either edge (measured 29 October 2026). Each slice asks from a
  midnight in the band's zone through the midnight after its last day, the bounds in the URL as
  instants in UTC; every cycle an answer's window does not cover whole (one begun before it, one
  running past it) is asked again over exactly its own span, once in a call, and that answer must
  state it covered or the call refuses. Each entry's `request_url` is the ask as sent and `records`
  the cycles its file holds. The connector states a cycle only from a file whose own window (its
  `startTime` and `endTime`) covers the cycle's whole span, an open cycle reaching the capture's
  `started_at`, and skips the rest of a file without refusing it; `sleep-events-<uuid>.json`, one per sleep those answers state
  (`/sleep-service/v1/sleep-events`); `heart-rate-….json`, the metrics heart-rate series at
  the chosen step, one file per civil day in the band's zone: each day its own ask, from its
  midnight through the millisecond before the next (23 or 25 hours across a change of offset, well
  inside the 192 hours WHOOP allows), whichever window reached it, the open day's included. The
  instants WHOOP answers follow the `start` of the ask, not a fixed grid, as a home's readings
  showed in November 2026 (a minute held two readings, at `:08` and `:51`, about 3.5 bpm apart,
  and a read from another start landed a new set; WHOOP's raw answers were not compared). A
  sample's key is its instant, so a day asked from another start lands a second set: a day is
  only ever asked one way. The days go to the page twelve to a call, a call being given 90 s;
  `stress-<day>.json`, the per-day stress answer (a day WHOOP fails, a 5xx after the retries, is
  left out and named in the manifest's `stress_failed` with its status: it never holds back the
  rest. It is owed in the account's memory, part `stress:<user id>`, the day and when it was last
  asked, until WHOOP answers it, read again with its window if that comes first, else asked at
  the civil day's first read, at most 36 of them, those asked longest ago first; no day is given
  up); and `manifest.json`
  (format `org.lifestreamprotocol.whoop-app-snapshot/0.1`) naming the `date_range`, the step,
  and each file with its size, SHA-256, request URL and count — plus, for a sleep-events
  file, its sleep's `timezone_offset`, which the events themselves do not state.
- `official/` and `private/`: WHOOP's developer API's pages, and the app's daily graph
  (`tilt-view`) and stress. No acquirer seals either; the connector reads both whenever a
  capture holds them. A daily graph's `hr:` samples are their own keys: metrics heart rate
  supersedes none of them.

A fetch whose window answered as it did when it last sealed seals nothing: the window, each
answer's SHA-256 and the days that failed are one digest in the account's memory (part `sealed`),
compared before the seal. An answer that differs at every ask seals every fetch.

A step's reads go together from the page (shared/station.ts `PageReads`: a 429, a 5xx or no answer
asked again). A 401 is the session lapsed since the page loaded: it ends the step's retries at once,
whatever answered beside it, and is the wait `retrying`, nothing sealed, the cursor and the memory as they were. Still limited after the page's retries, WHOOP holds both calls for the connector's refresh, an hour
(`provider-limit`): a page's fetch hands the station no headers, so no `Retry-After` is read. Any
other answer refuses the call by its path and status alone (a body states the band's measurements),
and the refresh tries again. A cycles answer naming another user than the page's anywhere in it (the
reader's `everyUserId`: a cycle's, a recovery's inside it) refuses the call before anything is sealed: the reader would refuse the delivery, which stops every later import of
the source.

A capture whose files differ from its manifest, or any of whose files states another user (a
`user_id` or `userId` member, a stress answer's feedback link), is refused whole: it cannot be
trusted: that check runs before the first row, each file parsed and let go. An `app/` file whose
content the connector cannot read (its JSON, a shape, a time, a stress axis) is refused alone, read
whole through `each`: none of its rows land, the run names it, and the rest of the capture lands.
The rows come a file at a time. Its bytes stay in the delivery, and the next connect code reads
it again. The
`official/` and `private/` halves are refused whole on any file.

The lane's `fetch` reads the window, in the band's zone: the open day at each refresh; the civil
day's first read reaches 7 days further back, never behind the 7 days before today,
the days WHOOP may still re-score; it always
reaches back to the day the last read reached, so today always lands first; no fetch reads a day
before the stream's start (below), and one whose last read reached behind the start reads from the
start. It reads at most 36
days past that day in one call: after a long absence a fetch that stopped short of today says so
(`more`) and the home asks again at once, so no call outlasts its errand. Its `page` reads one step
of 36 days just behind the earliest day read so far, whenever the home's backfill pace says (`1m` by
default, `30s` to `1h`): two separate ranges, never the days between again. The walk's floor is the
stream's start (`lent.start_ms`, as a day in the band's zone), never before 1 January 2015
(`FIRST_DAY`: WHOOP's first band reached customers in the fall of 2015, by whoop.com's own
history). The cursor keeps only the earliest day read (`reached_day`), no start: a start moved
earlier leaves that day above the new floor, so a walk that was done goes on to it; one moved
later is already at or below it, so the walk is done. The walk ends at its floor alone: a step WHOOP answers no
cycle for (covered or not) is a break in wearing the band, and the walk goes on behind it. Such a
step asks no sleep, heart rate or stress. This rests on an assumption, not a measured fact: that
WHOOP records no heart rate or stress on a day with no cycle. Asking them of every step would make
each empty step 74 asks instead of its two cycles slices (36 days of heart rate and 36 of stress),
for every year before the account existed. Walking from today to 2015 is about 120 pages of 36 days, two cycles asks each where the
band was not worn. Each page answers `left`, in days: 0 once the walk is done, else the days
between the floor and the earliest day read. The block's fields are `email` and the
`password` secret (for signing in again), `timezone` (the band's zone, else the home's day zone:
it shapes only the windows and the days) and `heart_rate_step`, `6s`, `1m` or `10m` (`1m` by
default); the days re-read (7) and the day's start hour (4) are mechanics, in code.

## Kinds and keys

| Kind | Key | Content | Time |
|---|---|---|---|
| `cycle` | the cycle's numeric `id` | `{ type: "whoop.cycle-details", content: <one cycle answer, verbatim: cycle, recovery, sleeps, workouts, v2_activities> }` | the cycle's `during` range with its `timezone_offset` (spelled `+HHMM`); an open range is its start |
| `sleep-stages` | the sleep's UUID | `{ type: "whoop.sleep-events", content: <the events array, verbatim> }` | the earliest event start to the latest event end, with the sleep's own offset (spelled `+HH:MM`) as the manifest states it; an empty array states no record |
| `sample` | `hr<step>:<instant>` (`hr6:`, `hr60:`, `hr600:`), the instant in UTC basic form | `{ type: "whoop.heart-rate", content: { bpm } }` | the reading's instant, milliseconds, with the band zone's offset then |
| `sample` | `stress:<instant>` | as the private half states it | the point's instant |
| `physio-day`, `recovery`, `sleep`, `workout`, `sample` `hr:` | the object's `id` (a recovery's `cycle_id`); `hr:<instant>` | the developer objects and the daily graph's samples, verbatim, from the `official/` and `private/` halves | the object's span with its offset (a recovery's update, bounded by its creation); the sample's instant |

Spans on the app path are stated as `['<instant>','<instant>')` ranges; an open span (the
current cycle) spells `['<instant>',)`. The connector parses exactly those spellings and
refuses any other, an empty quoted end (`['<instant>','')`) among them. A cycle spells its
`timezone_offset` `+HHMM`, its nested sleeps and workouts `+HH:MM`; both are read. Sleep
events arrive grouped by type, not in time order, and wake and disturbances overlap the
stages, so their order is not checked. A sleep's offset is not checked against the block's
zone: a sleep slept elsewhere keeps its own offset. Cycle `data_state` reads `pending` while open and `complete` once
closed; a scored sleep and recovery state `complete`. Metrics heart rate is a different series from the daily graph's points —
measured, none of a day's graph points lands on a 6-second reading — hence its own keys:
changing the step never supersedes a reading of another step, and the health family counts
one series per 15-minute span (the finest present). Two different readings at one
(step, instant) in one delivery refuse the later file, the same reading is stated once; a re-score in a later delivery lands changed.
A cycle two pages cover is stated once, by the later page. A day whose stress answer
holds no stress plot, or no stress graph at all, states no stress. A stress graph runs sleep
to sleep, any length: a day the band finds no sleep in makes one graph of two days or more. Its
axis labels state clocks with no date (`12:45 AM` from the app; `12:45 am`, and `00:45` on a graph, from the website), so the label nearest the right edge is tried at its
latest clock at or before the edge and then each day earlier, up to 31 days, and the first
try that puts every other label on its own clock, the shortest span, is read; none refuses the
file. One offset serves the whole graph, so a DST change inside it refuses the file.

Fields that tick on a re-fetch: anything WHOOP re-scores inside a cycle answer (recovery
and sleep scores, a cycle closing), and a sample's `segment_styles`. Nothing
is ever stated `gone` from absence.

## What the health family reads

**Adapter** `whoopHealth` (adapter.ts; [health](../../../families/health/)) declares the
name the WHOOP app writes its own data into Apple Health under (`instrument: ["WHOOP"]`): the
family lets this connector's data win over that copy, and prints the name as this connector's.

| Kind | Read |
|---|---|
| `sample` | `whoop.heart-rate` `bpm` under an `hr6:`, `hr60:` or `hr600:` key (series 0, 1, 2; any other `hr…:` prefix is not read); `whoop.hr` `bpm` (series 3, the retired daily graph's points); `whoop.stress` `display` (the 0–3 score). A span counts the finest series present. Stress points come only from `extended24_hour_graph`; the connector states no other graph |
| `cycle` | the nested sleeps, workouts and recovery, each timed, and the closed cycle's strain totals: sleep durations already milliseconds, `score` the performance percentage, `in_sleep_efficiency` a 0–1 fraction, recovery `hrv_rmssd` a thousandth of the milli value, `scaled_strain` the day strain of a closed cycle, a workout's `score` its strain, its `average_heart_rate`, `max_heart_rate` and `kilojoules`, and its `sport_id` in words by WHOOP's sports table (`0` is `running`; an id the table does not name is no sport); it states no sport name and no distance |
| `sleep`, `workout` | start and end, `nap`, `sport_name` (else `sport_id` by the same table), and the score once `score_state` is `SCORED`: a workout's strain, average and max heart rate, `kilojoule` and `distance_meter`; a sleep's cycle |
| `recovery` | the score, HRV, resting heart rate; its sleep (`sleep_id`) for the wake |
| `physio-day` | start, end and strain totals, read only once the day has closed (`end` stated) |

Nothing else is read: `segment_styles`, plot positions, `updated_at`, `created_at`,
`timezone_offset`, the precise stress `value`, a running day's totals. `sleep-stages` records are
stored but no family reads them yet.
