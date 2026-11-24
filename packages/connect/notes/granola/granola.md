# Granola: `granola:<email>:cloud`

A person's Granola meetings: each meeting's note (its summary, the person's own notes, who was
there, when) and, by the API route, its transcript. Two routes feed the one source, and the
person's plan decides which they take:

| Route | Acquirer | What it takes | What it reads |
|---|---|---|---|
| Granola's API, `https://public-api.granola.ai` | `granola-api` | a key (`grn_…`), sealed as `granola.<n>` (the `key` field's name and a generation, which the block names), made in the desktop app under Settings, then Connectors, then API keys, with Personal notes only; a Business or Enterprise plan | every note and its transcript |
| Granola's MCP server, `https://mcp.granola.ai/mcp` | `granola-mcp` | a sign-in with a code shown on screen (OAuth's device grant against `https://mcp-auth.granola.ai`), its JSON sealed as `granola.signin.<n>` | every plan; a free plan's last 30 days, no transcripts |

Both are the declaration's routes (`signin`, connector.ts): the person signs in by one, and only
that one runs; the other is never built, never polls and holds no need, its cursor kept for a
switch back. The MCP route's authorization server, scope and server are its route's `issuer`,
`scope` and `resource`, which `mcp.ts` is handed, never a constant of its own. The account is the
email typed in `account` (the API names none: a note's `owner` is its creator, someone else for a
note shared with the person) or the one the MCP sign-in states, written to `account` by the
sign-in. The API route's `before` says where its key is made; its acquirer alone pages history (`page`),
so Pace and the backfill's status are drawn only while it runs.

## What it reads

**`granola`** reads a delivery of either feeder by its `pull.json`'s `format`. The pull's
`account` must be the source's, and every file of the delivery one the pull names, before the
first row. A delivery with no file states nothing: the last page of the history walk, which found
no note, is sealed so, to state what is left; one with files and no `pull.json` is refused. Each file's hash and size are checked where it is read, so a spoiled file costs its own
note or answer.

- **`org.lifestreamprotocol.granola-api-pull/0.1`** (`granola-api`): one entry per note: its
  answer `notes/<id>.json` (`GET /v1/notes/<id>?include=transcript`, or without the transcript
  for a 413), its transcript's pages `notes/<id>/transcript-NNNN.json` (`/transcript`, 100 lines a
  page, a 413's only), and each attachment's bytes `notes/<id>/attachments/<attachment id>`, each
  with its sha256 and size; `stopped` when a stop cut the call short.
- **`org.lifestreamprotocol.granola-mcp-pull/0.1`** (`granola-mcp`): one entry per tool call:
  its answer `answer-NNNNN.json` or `.sse`, the body as Granola sent it (a JSON-RPC message, or an
  event stream whose `data:` lines hold it), its `media`, the request's JSON-RPC id (`rpc`), the
  tool and its arguments. Only `get_meetings` answers hold records. A list's meetings are what to
  read; a tool error holds none.

## Kinds and keys

| Kind | Key | Content | Time |
|---|---|---|---|
| `note` | the meeting's UUID: MCP's meeting `id`, the API's `web_url` path (`https://notes.granola.ai/d/<uuid>`), else the API's `id` (`not_…`) | API: `{type: "granola.note", note}`, every field the note states but `transcript`, each attachment without its `url` and with `hash`. MCP: `{type: "granola.mcp-note", meeting, …}`, the meeting element's attributes as `meeting`, and each child element by its name as its attributes and its `text` (`known_participants`, `private_notes`, `summary`, `folders`) | the transcript's first line's start to its last line's end; else `calendar_event`'s scheduled span; else `created_at`. MCP: `meeting_at` |
| `transcript` | the same UUID | `{type: "granola.transcript", note, transcript}`: the API's note id and every line as stated (`speaker` with `source`, `attribution`, `diarization_label`, `name` as given; `text`, `start_time`, `end_time`) | its first line's start to its last line's end |

## Rules

- **One record a meeting, whichever route.** Both routes key a meeting by its UUID, so a person
  who moves between them keeps one record: the copy read last is its head.
- **Attachments.** An attachment's `url` is a signed link renewed on every read, so it is left
  out; the bytes fetched from it are sealed with the note, and `hash` (`sha256:<hex>`, as iMessage
  names an attachment's) is in the content and in the row's `blobs`. A version's id covers its
  content alone, so new bytes make a new version and a renewed link makes none. No measured note
  held one: the fetch follows Granola's docs until one is.
- **Gone** only for a note whose `deleted_at` is set, and its transcript with it (a workspace key
  sees those; a personal key never does). A note missing from a list stays.
- **The MCP answer.** Granola's tools answer XML-shaped text written for a model. An element is
  read by its tag and its `name="value"` attributes; XML's five entities and character references
  are read as XML reads them, everything else kept as written. The text around the elements (a
  requested range, an access notice, instructions to the model) is no meeting's and is not copied.
  An attribute's value is text, as Granola writes it (`captured_by_me="true"`).
- **Refused alone.** A note whose answer does not read, whose time does not read, or whose file
  is not the one the pull states is refused by its file; a meeting element that does not read, or
  states no `id` or `meeting_at`, by its answer and index (`answer-00001.json[2]`). The rest lands.
- **Content's own members.** A meeting's child element named `type` or `meeting`, one stated
  twice, or one with an attribute named `text` refuses that meeting.

## The polls

**`granola-api`**, on its connector's `refresh`, and its backfill at its `pace`:

- `fetch`: the notes updated after the cursor (`updated_after`, asked from 1 ms before it) and
  created from the stream's start (`lent.start_ms`) on (`created_after`, 1 ms before it), since
  history dates a note by its creation: a note created before the start and edited since stays
  out. One listing walked by Granola's own cursor, 30 a page, newest created first, each note read whole.
  When the listing ends the cursor moves to the earlier of the newest `updated_at` sealed and 10
  minutes before the walk began: the list is in creation order, so a note edited on a page already
  read while later pages were read is updated after that, and the next walk reads it again. A walk
  that sealed nothing keeps the cursor, and the cursor never moves back. The first cursor is the
  first call's instant. A note read again whose `updated_at` is the one sealed (the poll's memory,
  `sealed`, each note's id) is passed over, so a walk that finds nothing new seals nothing.
- `page`: one page of the notes created from the stream's start (`lent.start_ms`) on and before the
  first call's instant, each read whole; `left` null, since Granola states no count, and 0 when the
  listing ends. Once it ended, a start earlier than the one the cursor was left under
  (`lent.from_ms`) lists again, created before that start and from the new one on, whichever call
  sees it first. A cursor Granola refuses (400) starts the listing again from 1 ms after the oldest
  creation sealed, so notes sharing that instant are read again: the next request asks that range
  with no cursor, its query built from the listing as it then stands.
- A note answering 404 is not summarised yet: it is skipped and named in the facts' `skipped`. Its
  summary moves its `updated_at`, so a later `fetch` reads it.
- A call begins no list page and no note once it has made `per_poll` requests (200), and Granola
  has at most 4 a second. The bound is checked between notes, never inside one: a note begun
  finishes in its call, its transcript's pages and attachments however many, so a note of any size
  lands. A stop at the bound keeps the listing's cursor and the notes of its page already sealed,
  and goes on (`more`). A note is sealed only whole. Both routes' requests go through the request loop
  (shared/http.ts). A 429 stops the call: what finished is sealed and neither call runs before its
  `Retry-After`, a minute where it names none (`backoff_ms`); with nothing finished, `NotYet`
  `provider-limit` holds both that long. Granola states no reset (no measured answer carried a
  rate-limit header). A 401 is `NeedsYou`
  `signed-out`, as is no key sealed.

**`granola-mcp`**, on its connector's `refresh`; no `page`, no pace:

- The credential's access token lasts 6 hours; a call refreshes it only within 5 minutes of its
  end, and the rotated JSON is in the vault before the call goes on (`shared/oauth.ts`). A refused
  refresh, a 401, or no sign-in sealed is `NeedsYou` `signed-out`. Whose sign-in it is was asked
  once, at the sign-in (`get_account_info`); a poll never asks.
- `fetch`: `list_meetings` over the last 30 days by meeting date, from the stream's start at the
  earliest (`lent.start_ms`: a meeting dated before it and edited since stays out), every page, with `updated_after`
  at the epoch, which narrows nothing: Granola's list states a meeting's `updated_at` only when
  `updated_after` is asked (its description names the free plan's range for it, so one tool serves
  every plan). Each meeting whose listed
  `updated_at` differs from the one the poll's memory holds (part `seen`), and each listed with none (whether it moved is
  unknown), is read with `get_meetings`, 10 a call; the `updated_at` kept is the one listed, else
  the one `get_meetings` states, and only for a meeting `get_meetings` answered (one it left out is
  queued again while it is listed). The memory holds them for the meetings of the last window's
  listing. A call makes at most `per_poll` tool calls (40); stopped, it keeps the listing's cursor
  and the meetings still to read (part `queue`, by place, read ten at a time in the order they were
  listed, with part `queued` naming each one's place by its id; the meetings the listing has listed
  so far are part `listed`, cleared when it ends), and goes on (`more`). The cursor holds the
  listing's range and page, and the place the next meeting queued takes. A batch `get_meetings`
  answers an error for is named in `skipped` and keeps its place at the queue's head, read first at
  the next call whatever the
  listings after it cover (a meeting older than 30 days, failed during the first listing, among
  them); a listed meeting whose element does not read is passed over and counted in `unread`. An
  answer with no `<meetings_data>`, or a listing whose meetings none read, refuses the call
  (Granola's shape moved): the stream shows the trouble instead of reading nothing.
- The first `fetch` lists from the stream's start instead (until the cursor says `reached`; a cursor
  that says `listed` was ended by the reader before 28 October 2026, which read nothing, and lists
  from the start again). A start moved from the one the cursor was left under (`lent.from_ms`) ends
  a listing under way, and a start moved earlier lists from it again whole. A free plan answers its 30 days and says
  so in an `<access_notice>`, which the facts' `notices` name. A cursor Granola refuses (a tool
  error) starts the listing again, and meetings already read are passed over by their
  `updated_at`.
- Its history is one forward listing from the start. A meeting older than 30 days
  edited later is not read again on this route. No transcripts: a free plan has none, and a paid
  plan's come by the API route.
- The tools' argument names (`from_date`, `to_date`, `updated_after`, `cursor`, `meeting_ids`), as Granola's
  `tools/list` names them, are spelled once, in `mcp.ts` `TOOL_ARGUMENTS`.

## The checks

Each route's check runs in the home before it seals anything (`account-connect`, `device-poll`). The API route's is declared, `check: { url:
"https://public-api.granola.ai/v1/notes?page_size=1" }`, which the home runs: one note listed with
the key in hand, naming no account. MCP's is code, exported by `index.ts` in `signins`
(`granolaMcpSignedIn`, seams.ts `SignedIn`): it refreshes the sign-in where it must and asks
`get_account_info`, whose `email` is the account; a tool's error is refused in its own words, never
Granola's text. Every request a check makes
carries the sign-in request's one deadline (the home's 20 seconds); a poll's request waits at most
60 seconds. The account is the field `account` declares (`account: true`): the API route types
it, the MCP route writes it.

## Its adapter

`adapter.ts` gives the notes family its notes adapter (`packages/core/inputs/notes.ts`): a
`note` record read into a `Meeting`, whichever route stated it. It reads `granola.note`'s
`title`, each of `attendees`' `name` and `email`, `summary_markdown` (else `summary_text`) and
`private_notes_markdown` (else `private_notes_text`); `granola.mcp-note`'s `meeting.title`,
`known_participants.text` (`Name (role) (email), …`, read as each name with its parenthesised
parts set aside, the part holding an `@` its email), `summary.text` and `private_notes.text`. The
people there are each by name, else email, without the source's account. A `transcript` is read
by no family yet.

## The day

The notes family reads `note` from `granola`: one line a meeting, at its time, with its title,
the people there and its length ([notes](../../../families/notes/)). `transcript` has no
family yet.
