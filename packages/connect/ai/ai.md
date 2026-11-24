# AI conversations: `chatgpt:<account>:export` and `claude:<account>:cloud`

Each account has two sources: its data exports (`chatgpt:<account>:export`,
`claude:<account>:cloud`), and what the person's signed-in Chrome reads,
`<provider>:<account>:browser`. Both state the same kinds, keys and
contents, so a message the two hold is two records of one key, and the ai family shows one
(families/ai/ai.md).

## Their adapters

Each product's `adapter.ts` gives the ai family its ai adapter (`packages/core/inputs/ai.ts`):
`copy` (`export` for ChatGPT, `cloud` for Claude: that copy's source names an account's units,
the browser's copy shares them and the named copy wins a tie) and `gist` (a long reply is asked
for one). Nothing else is read: model slugs, `update_time`, `current_node`, `children`,
`updated_at`, thinking blocks and their signatures, nested block ids, and the members only the
browser states (`index`, `stop_reason`, `sync_sources`) tick between deliveries and change
nothing.

| Product | Kind | Read |
|---|---|---|
| ChatGPT | `msg` | `turn`: the author's role, the content type, the parts (text, audio, images), the attached files' names, whether the message is hidden; a tool or code node only the browser holds is no turn |
| ChatGPT | `chat` | `title`: `title` |
| Claude | `msg` | `turn`: the sender, the text blocks (else `text`), voice notes, tool names, the titles of documents the assistant made, each attachment's name, type and extracted text, each file's name |
| Claude | `chat` | `title`: `name` |

A conversation missing from a later ChatGPT export (its `{}` entries) states nothing; a Claude
export's empty placeholder lands, and the family shows the newest earlier version that stated
something.

## ChatGPT (`chatgpt-export`)

One ChatGPT account; `<account>` is `user.json`'s `user-…` id (the reader's `account`). It comes as
a ChatGPT export the person hands their home ([imports.md](../imports/imports.md)):
the zip ChatGPT mails a link to, or the folder it unzips to, read alike. The export's root is the
folder its one `user.json` lies in (two `user.json` are two exports, refused); at its root lie the
`conversations-NNN.json` shards and the media files (`file-<id>…` uploads, `file_<hex>.dat`).
`chat.html`, the export's own page of what the shards state, is passed over knowingly (the
connector's `export.leaves`); other files are not read. Shards are read one conversation at a
time, each a part: a conversation that cannot be read is refused alone, and a shard that breaks
part way keeps the conversations before the break. The export's time is its newest
conversation's update (the reader's `states`), so an older export brought in late moves no head.
A zip's media are its members, stored by their bytes; a file holding media no conversation names
is kept, never let go as read whole.

| Kind | Key | Content | Time |
|---|---|---|---|
| `msg` | `<conversation id>:<node id>` | `{ type: "chatgpt.msg", conversation_id, node }`, the node as exported | the message's `create_time` (Unix seconds) |
| `chat` | `<conversation id>` | `{ type: "chatgpt.shell", conversation_id, title?, update_time?, current_node? }` | `update_time`, never before `create_time` |

Every message-bearing node is a record, reasoning nodes included; a message-less root is the
tree's structure and names none. A message's blobs are the media it points to that the export
carries: a part's asset pointer names its file after `://` (or after the `#` of
`sediment://<id>#file_<hex>`), an attachment by its `id`. An export is a sample: a conversation
can come out as `{}`, which names nothing and states nothing, and absence never means gone.

## ChatGPT through the browser (`chatgpt-browser`)

The source is `chatgpt:<account>:browser`. A delivery holds `me.json` (`/backend-api/me`, whose
`id` must be the source's account), `conversations/<id>.json` (`/backend-api/conversation/<id>`
as the browser got it) for each conversation fetched, and the media those name, each
`<file id>.dat` at the top level (`file_<hex>.dat`, `file-<id>.dat`), the export's bytes. Kinds,
keys and contents are the export's.

The browser's conversation is the export's and more. It names the conversation by
`conversation_id` alone. Its mapping holds the tool, code, browsing and intermediate nodes the
export strips and re-parents around: each message-bearing one is a record like any other. Two
things only the browser holds: a message-less node that is not a root names no record, and a
message whose `create_time` is null sits at its nearest ancestor's time, else the
conversation's creation, since it was written after them. A conversation not fetched states
nothing; one that cannot be read is refused alone.

## Claude (`claude-export`)

One Claude account; `<account>` is `users.json`'s UUID, else the first conversation's account (the
reader's `account`, its two rules in order), and every `users.json` and every conversation the
export holds must state it. It comes as a Claude export the person hands their home
([imports.md](../imports/imports.md)): each zip Claude offers, or the folder
one unzips to, read alike; an earlier road's delivery, the provider's `manifest-*.json` and the
archives it names, reads the same way. A file is of the export by its `conversations.json`; one
holding only what the connector's `export.leaves` names (`users.json`, `login_history.json`,
`memories.json`, `projects.json`, `projects/`, `design_chats/`), as Claude's light zip of `users.json` and `login_history.json` does, holds
nothing Lifestream reads yet and is never sent. The connector reads every `conversations.json` the export
holds, by name under any leading folders (`archive`, shared/members.ts), each and each
conversation in it a part refused alone; a conversation in two of them is refused in the second.
An export is a sample: a zip of it missing states nothing. Its time is the manifest's
`created_at` where the export holds one, else its newest conversation's update (the reader's
`states`), so an older export brought in late moves no head.

| Kind | Key | Content | Time |
|---|---|---|---|
| `msg` | `<conversation uuid>:<message uuid>` | `{ type: "claude.msg", conversation_uuid, message }`, the message as exported without the uuids of blocks nested in a tool result | `created_at` |
| `chat` | `<conversation uuid>` | `{ type: "claude.shell", conversation_uuid, name, summary, created_at, updated_at }` | `updated_at`, never before `created_at` |

The export mints the nested block uuids anew on every delivery. An empty placeholder states its
empty shell; the messages it no longer lists are not gone.

## Claude through the browser (`claude-browser`)

The source is `claude:<account>:browser`. A delivery holds `account.json` (`/api/account`, whose
`uuid` is the export's users.json UUID and must be the source's account) and, for each
conversation fetched, two reads of `/api/organizations/<org>/chat_conversations/<uuid>`:
`conversations/<uuid>.messages.json` (`?tree=True&rendering_mode=messages&render_all_tools=true`:
`content` blocks, an empty `text`) and `conversations/<uuid>.text.json` (`?tree=True`: `text`,
no `content`). Kinds, keys and contents are the export's.

A message is the first read's, with the second's `text`, matched by uuid; a
`parent_message_uuid` the API leaves out (it omits a null member) is null, as the export states
it. The provider's other members are kept as it sent them, those the export lacks included
(`index`, `stop_reason`, `input_mode`, `truncated`, `sync_sources`). The plain read's list is the
conversation's: a message only it holds (met live, 8 October 2026: a one-character message the
rendered read left out, with a reply under it) is kept as the plain read states it, its `content`
null, which the ai family reads by its `text`. A message only the rendered read holds, or a
conversation missing one of its reads, is refused alone. The conversation states no
account; `account.json` does.

## The browser polls (`claude-browser`, `chatgpt-browser`)

One call is one errand in the person's own Chrome through a station (`extension/`):
origin `https://claude.ai` or `https://chatgpt.com`, the API the page uses, with its cookies;
ChatGPT's access token is held in the browser and never reaches the home. The lane reaches back
to the stream's start (`lent.start_ms`: the home's start, or the connector's own) and then keeps
up: a conversation last updated before the start is never fetched, and a start moved later lets
go at once what is owed below it. What is new is what was updated since the account's first call
(`first_ms`); the rest is history, the page's.

The acquirer answers two calls, which share
the account's place and memory (below):

- **`fetch`, what is new**: conversations updated since the first call. It lists (in its own
  `listing`), the list ending where it reaches what the lane holds unchanged, a conversation
  owed among it, and fetches what changed, newest first, a piece at a
  time: it starts no conversation once `piece_ms` (30 s) have passed since the call began (the
  waits that confirm each list's end, 17 s a list, among them) and it has tried one, nor
  past `max_conversations` tried or four fifths of the errand's deadline (30 minutes). A fetch that
  stopped with more says so (`more`), and the home seals its piece and asks again at once. What
  changed but was last updated before the first call is history: it is `owed` unfetched. What new a
  fetch did not reach is owed too, and the next fetch works through it without listing again.
- **`page`, one batch of history**: 10 conversations owed older than the first call, those
  never tried before those tried, newest first, tried the provider's pace apart, with no piece; whenever the home's backfill pace says
  (`2m` by default, `30s` to `1h`). It answers `left`, in conversations: the history owed once
  every list has ended (the fetch's and the whole walk's), unknown (null) while one is open or
  before any has been read. A list the page cannot finish in its errand is no batch: nothing
  sealed, `left` unknown, its place kept, read on at the next page. Moving the stream's start
  earlier is the one way to reach further, a backfill the person asks for: the call, fetch or
  page, that is lent a start (`lent.start_ms`) earlier than the one the poll's cursor was left
  under (`lent.from_ms`) sets `whole`: the page,
  once the history owed is fetched, walks the whole list down to the new start once (its list
  `history_listing`, kept across pages until it is read to its end), past the pages the lane
  holds unchanged at which a list otherwise ends, and owes what the lane lacks.

A conversation tried ends one of three ways: read, owed no more, so none is fetched twice;
gone (a 404, a body over the page's limit, an answer its connector would refuse), left out for
good; or to try later (no answer, a 5xx, a 401 or 403 as a session lapses), owed still: it stays
owed, its tries counted, for a later call of its kind (history for a page,
what is new for a fetch, which a list ending above it would never find again). A call tries what
it never tried before what it did, and a conversation tried by three calls is let go as gone
(counted `skipped`, as a 404 is), so one the provider keeps failing never holds older history nor
keeps `left` above 0. A fetch lists again once nothing new it owes is untried, and tries again what
is new and owed after it lists, so a retry never keeps it from listing; a conversation the list
finds changed since is owed anew, its tries forgotten. A
conversation's media are asked for together, links then files, and pulled from the door together.
A list is read a page at a time and goes on where it stopped: a call whose time ran out mid-list
keeps the pages it read and where the next begins, and a fetch is due again at once; one the
provider kept limiting keeps them too and waits for its hold (below). Changed means listed later than the lane holds, whatever the
spelling. A call that read no conversation (all history, a list stopped for time, nothing changed)
carries no file: its place is kept and the home counts it an answer. A fetch seals nothing; a page seals
its count alone, which the reader reads as nothing. Each delivery feeds the one account its facts state. A lane's `seed` names unpacked exports of the account (ChatGPT's `conversations*.json`,
Claude's `conversations.json`): its first call takes their conversations and update times as read,
so the pages fetch only what they lack or hold older from the start on (measured 8
October 2026, before the floor: 87 conversations in 21 minutes instead of about 4,000 in six
hours).

- **Lists.** Claude: `chat_conversations?limit=100&offset=` to its end, since nothing measured
  says it is ordered by update time; what is below the floor is listed and not fetched. ChatGPT:
  `conversations?offset=&limit=28&order=updated`, then the same with `&is_archived=true`, then
  every project's `gizmos/<id>/conversations` (projects paged from `gizmos/snorlax/sidebar`). A
  ChatGPT page comes back empty at random and its list has no total to trust (`total` is never
  read), so an end is confirmed before the walk stops: an empty page is asked again after 2 s, 5 s
  and 10 s, then the page after it once, and only both empty end the list. A page after it that
  holds conversations fails the poll (the empty one was a bad moment), its place as it was, and the
  refresh lists again; so does an answer that is not the list's shape (not a 200, no `items` list),
  never read as an end. The main and archived lists are ordered by update
  time (a page takes about 20 s under the provider's limit): each ends at the first page that
  reaches the floor and, once the lane holds conversations, after two whole pages it holds
  unchanged. A project's list, whose order is not known, is read whole. ChatGPT's list misses old
  conversations, so a backfill through it may miss some; the export holds them.
- **Media** (ChatGPT): each id a fetched conversation names (`chatgptMediaIds`) and no earlier
  poll fetched: `files/download/<id>?conversation_id=&inline=false` names a same-origin
  `download_url`, whose bytes are kept. One the provider no longer serves (404), refuses (401,
  403: a media file of another account answers its link 403 `user_mismatch`, and chatgpt.com
  itself shows it as Failed), or whose bytes are over what a page may hand back (32 MiB), is left
  out, the conversation kept, and asked again when its conversation changes.
- **Limits.** A 429 is asked again after 5, 10, 20, 40 and 80 s; still limited, the provider
  holds both calls 30 minutes: a call that read conversations seals them and says so (`backoff_ms`),
  one that read none (signing in, listing or fetching) is a wait saying so (`NotYet` `backoff_ms`),
  its place in a list kept. Every wait and need once the page has named the account carries the
  account's source in its facts, so one account's outcome is that copy's alone. A 5xx, or a request whose page fetch got no answer, is asked twice
  more. A conversation that answers anything else, or that its connector would refuse (a delivery
  refused would stop the source's imports), is left out and counted (`skipped`), gone or to try
  later (above). ChatGPT is paced at one conversation per 5 s, Claude not at all (the recipe's own
  pace, in code).
- **Needs you.** A page showing a CAPTCHA, a one-time code or a verification (`confirm`), a password
  (`password`), the browser signed out (`signed-out`), an account offered (`other-account`, below),
  or an extension refusal only its options can lift (`extension`) fails the poll as `NeedsYou`
  (`seams.ts`). Signed out is read once, at the poll's start, from the request the connector
  declares as its probe (a 200 without its value, a 401, a 403), never from a later answer: a
  session that lapses mid-poll leaves the rest of that poll out, and the next poll names it. Its
  message is the operator's; the person's words are the home's, from the reason, and the next poll
  resumes once the person has acted.

- **The account** is the one the signed-in page names, by the connector's probe (shared/setup.ts
  `whoIs`): Claude's `/api/account` `uuid` and `email_address`, read plainly; ChatGPT's
  `/backend-api/me` `id` (`user-…`) and `email`, asked with the session's token, which the probe
  holds in the browser and never hands the home. Each account is its own source, and the home lends
  the lane its accounts (`Lent.accounts`: each source on its lane, on or off): an account on is read with its own place and memory; one off reads
  nothing, the poll a wait (`NotYet` `chrome`, the account's email in its facts); one with no
  source is offered (`NeedsYou` `other-account`, carrying its id and email), never read until the person
  answers, but the stream's first account (no source on the lane yet), which is read at once. Only
  the account's id and email are read of an account offered.

The cursor is `{polled_ms}`, when the lane last called: it holds nothing per account or per
conversation, so it never grows. What the lane remembers is the poll's memory
(`Lent.memory`, shared/site-lane.ts), each part but `account` the account's own (`<part>:<account>`):
`account`, each account's place by its id (`{first_ms, listing?: {next?},
history_listing?: {next?}, whole?}`); `seen`, each conversation read with its update time as
listed; `media` (ChatGPT), each media id fetched; `owed`, each conversation listed changed and not
read yet, `{at, tries?}` (its listed time, and the calls that tried it since it last changed); and
`listed` and `walked`, what an open list (the fetch's, the whole walk's) read so far, cleared as it
ends. A call asks for what it needs by id and reads whole only what it drains (`owed`, an open
list's), and writes only what changed: a call that found nothing new leaves the memory as it was. A
conversation is marked read, and its media fetched, only by the call that seals it; a wait carries a
list's place and what is owed, never a mark. The seed is the stream's first account's alone: an export names no
account. The facts are `{fetched_at, account, sources, listed, conversations, skipped, more?,
media?}` (`more` the fetch's; a page's `history`, `left` and `reach` are the home's), `sources`
naming the account's source (`<provider>:<account>:browser`) and its email, which the home makes
and writes on its row (`options.email`); the delivery is sealed in the acquirer's own lane. The
statement time is the call's.

Lane `claude-browser` or `chatgpt-browser`: no block is needed, since choosing the site in the
station's popup runs it: at once when the site is chosen or its Chrome profile comes back and the
lane is due, and every 30 minutes (its connector's `refresh`). Its connector's block
(`connectors.claude`, `connectors.chatgpt`) may set `refresh`, `reach` (widened, the page walks the
whole history down to the new floor once; narrowed, nothing changes) and `pace`. A fetch's most
conversations (150), its piece (30 s), a page's 10, the provider's own pace and the errand's
deadline (30 minutes) are mechanics, in code.
