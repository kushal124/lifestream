# Agent access

An access says what one model reader may read of the home: which accounts, from when, and how much
is hidden. This page owns its rules: the shape of an access, how the door judges one thing under
it, where the door enforces it, and how every call and change is kept. The person's side is
[Choose what an agent reads](../user/choose-what-an-agent-reads.md).

A **reader** here is who a read is for when it is not the person: Ask (the code's name for Chat,
reader `ask`) or one agent (its pass id, `p-` and eight hex digits). The person reads by `GET` with
a device's or a reader's pass and passes no gate.

## The rules

1. **One model.** Every read that is not the person's own passes one gate with one access, an
   agent's and Ask's alike. No route, tool or screen decides access itself.
2. **Nothing by default.** A reader reads only what a line of its access allows. A reader with no
   access reads nothing.
3. **Enforced in the door, before ranking and paging.** Totals, counts, pages and `next` cursors
   are made from allowed things only: every number of `count`, `search_people`'s counts, `held`,
   an extreme and a group too. A cursor is a position, never a permission: each page is judged
   when it is read, under the access and the clock of that read. The MCP server filters nothing.
4. **What cannot be judged is withheld.** A thing that does not state the accounts it rests on is
   read only under an access that allows everything. An access the door cannot parse serves
   nothing.
5. **A derived thing needs every account it rests on.** A day line, a fact, a piece of where the
   person was or a screen window is served or counted only when the access allows each account it
   rests on, at the thing's own start. A name is not something a thing rests on.
6. **Only the person's tap widens.** A tap on their own Mac or iPhone, on a screen the app draws.
   Never words in a chat, never a model, never a page reached on a reader's pass. A narrowing
   applies at once, from anywhere: by the person, by Ask, or by the agent for itself.
7. **An agent sees and changes only itself.** No agent reads or changes another reader's access.
8. **The reader is told the truth it may know.** It reads its own lines when it connects and in
   the `access` tool. An answer from which something it matched was withheld says so in one fixed
   line. It is never told how much, where, or by which line.
9. **Every call is a row before its answer leaves,** written with the answer's outbound row, and
   every change of an access is a row in the transaction that makes it.

## An access

An access is one JSON value with seven members, every one always present (`packages/privacy/access.ts`,
`Access`). `parseAccess` refuses, by name, a member that breaks the shape or that it does not know.

| Member | What it holds |
|---|---|
| `allow` | the allows: each a reach, its own time limit (`window`) and an end (`until_ms`) |
| `window` | the time limit on everything: `null` (all time), `{since_ms}` or `{past_ms}` |
| `hide` | the reader's level, core's `Level`: `all`, `names`, `none`, or a list of detail types |
| `items`, `not`, `only`, `shown` | always empty: the parser refuses anything in them |

A reach is one of three:

- `{all: true, but: [<category>…]}`: every account but the categories named. It is open: it
  reaches accounts connected later too.
- `{type: <category>, but: [<account>…]}`: every account of one category but the accounts named.
  Open too.
- `{account: "<product>:<account>", but: []}`: one account. Closed.

A category is a connector's type, one of core's `TYPES`, printed by its name there ("Screen" for
`device-activity`, "Calendar" for `plans`). An allow with `until_ms` is a one-off. It has ended
when the read's clock is at or past it, and the door then reads it as not there.

Whatever is switched off, a whole category or an account inside one that is on, is left out by
its allow's `but`, and the reader may ask for it.

An account is offered, listed and reached only when a family reads one of its sources as
evidence. An account read only as a label (People, Places, Devices, Stations, the labelers) or by
nothing has no line and is never listed as outside an access. Its category is that of its
evidence sources, the first in `TYPES` when they declare two (`packages/home/access-routes.ts`,
`offeredOf`).

### The accesses the home writes

- **A new agent** gets `allow: [{all, but: ["health", "money"]}]`, all time, `hide: "names"`
  (`packages/home/access.ts`, `defaultAccess`), unless the person changed it on the sign-in. A
  copied pass (`lifestream agents add`) gets the same.
- **Chat** (`ask`) has a full access and `hide: "none"`, which nothing reads: each conversation
  keeps its own level, picked on its composer, and a new one starts at `privacy.chat`.
- **The move.** At each start the home settles access (`packages/home/access-move.ts`,
  `settleAccess`). The first start that finds no mark writes, in one ledger transaction, a full
  access for each live agent of `config/principals.json`, its `hide` the agent's old level
  (`names` where it had none), a full access for `ask`, and the mark (`access_moved`). Only the
  agents the passes file held then get a full access: after the mark a grant with no access row
  reads nothing. Then the home removes the old `level` member from every agent in the passes file.
  Until the mark stands, a model read answers 503 `NOT_NOW` ("Your home is starting") and a
  person's access write is refused `ACCESS_NOT_STARTED`.

### Stored once, in the ledger

An access is a row of the model ledger (`replies/replies.db`, `packages/model/access-log.ts`), the
file that is never rebuilt. Its tables, its history's tables and the erasure's part are on
[packages/model/README.md](../../packages/model/). The rules they hold:

- **Versions.** `version` counts a reader's changes from 1; 0 is no access. A reader's versions
  only grow. Every write names the version it was made from, and against another it throws
  `ACCESS_CHANGED` and writes nothing.
- **One transaction a change:** the new `access` row, its `access_changes` row, and the request it
  moves. The door's one writer thread writes them.
- **Two writes are the home's,** because each spans the passes file and the ledger. Each order
  fails closed:
  - A grant is minted access first: the home picks the pass's id, writes the access and its
    `granted` row, and only then writes the pass. A crash between leaves an access no pass can use.
  - A grant is revoked pass first: the home revokes the pass, and only then removes the access
    with its `removed` row. A crash between leaves a dead pass with an access.
  - At each start the home removes every access whose reader is neither `ask` nor a live pass.
- **The door reads a reader's access on every request,** so a change applies at the next read.
- The passes file keeps who an agent is and whether its pass is good. The ledger keeps what it may
  read.

## How one thing is judged

Pure functions in `packages/privacy/access.ts` are the whole rule. No route, tool or screen holds a
case of its own.

**Lines** are numbered from 1 in one order (`numbered`), the order every caller prints and counts
by: each allow, then the overall time limit when one is set, then the hiding.

**A gate** is an access compiled for one request (`compile(access, now_ms, category)`): every
ended allow left out, each time limit placed on the request's clock (`{past_ms}` counts back from
it). `category` gives an account's category, or null. A full access compiles to no gate. An
access is full when it is one open allow and no overall time limit; an open allow is
`{all: true, but: []}` with all time and no end. Under a full access the engine runs statement for
statement as it runs for the person.

**A thing** states two facts: every account it rests on, and when it happened (`Thing`:
`accounts`, `start_ms`). `decide(gate, thing)` judges it, in this order:

1. **Unresolved.** A thing that states no accounts is allowed only by an open allow in an access
   with no overall time limit. Else it is withheld: `unresolved`.
2. **Time.** Its start outside the overall time limit: withheld, `window`.
3. **Allowed** when each of its accounts is reached by a live allow whose own time limit holds its
   start. Two accounts may be reached by two allows.
4. Else withheld: `no-line`.

It answers `{allowed, line, why}`: the line that allowed it (an allow that reaches every account of
the thing, else null) or withheld it, and one of `allowed`, `unresolved`, `window`, `no-line`. A
thing withheld for several reasons answers the first. No line changes how another judges, so
removing a line can only withhold more.

A reach covers an account when it is `all` and the account's category is not in `but`; `type`, of
that category, and the account not in `but`; or `account`, that account. An account with no
category is reached by `all` with an empty `but` and by its own `account` allow, never by `all`
with a `but` or by `type`.

**Time.** A thing is inside a time limit when its start is at or after the limit's start. A
limit of `null` holds everything, a thing with no time too; any other limit never holds a thing
with no time. A thing is judged at its own start: a record at its head's `start_ms`, a day line and
a fact at their start (a date with no clock at its civil day's start), a screen window at its
minute. So a night that began at 23:00 is outside "past 6 hours" at 08:00, whole. The overall
limit applies first, and an allow's own limit can only tighten it.

`earliest(gate, accounts)` answers the first instant from which the gate allows a thing of those
accounts: null for all time, `undefined` for never. The screen walk reads it as each Mac's floor;
a search whose every Mac is `undefined` (`screenOutside`) answers no screen part at all, so an
agent without Screen hears nothing of it.
`opensAt(gate)` answers the first instant any allow reaches.

### Wider or narrower

`widens(before, after, accounts)` is set inclusion: a change narrows when every allow after it sits
inside an allow before it (by reach, time limit and end, an account allow placed inside an open or
a category allow by the home's accounts), the overall time limit is no longer, and everything
hidden before is still hidden. Any other change widens, and so does any value the parser refuses.
The door refuses a widening that is not the person's tap.

### What a thing states

A thing is judged by what its own row states, in the store it is served from. Nothing is judged
in one store and served from another, so no version is compared. Until the index has read a
record's new version, a hit serves the old row under the old row's facts, as it does for the
person.

| A thing | Its accounts | Its start |
|---|---|---|
| a search entry | its `entry_states` row in the index's facts layer | its slot's time |
| a record read whole | its source's (core's `accountOf`) | the head's `start_ms` |
| a day line, a fact | its `accounts`, else its one record's | its own start |
| a screen window | the screen sources of its Mac | its minute |
| a piece of where the person was | the accounts of the stays it was laid from | its start |

A line or a fact rests on its record alone only when it names that record, rests on one unit and
states no `accounts` (`packages/families/family.ts`, `restsAlone`). Every other line and fact
states the account of every record its units read as evidence, never a labeler's. The day file's
page says which line states what ([the day file](../user/day-file.md)). A name, a
chat's title and a place's name are labels: they are served with a thing the reader may read,
under its hiding, and need no line of their own. Who a person is, and what the record holds of
them, is not a label: `search_people` lists a person, their handles, chats and counts only as
allowed things hold them.

## Where it is enforced

**The reader of a request** (`packages/home/access.ts`, `readerOf`): a pass of kind `agent` is that
agent; a turn's pass, or the person's own pass naming a conversation (`Lifestream-Chat`), is
`ask`; any other pass is the person. The door's allow list (`MODEL_REACHES`,
door.md) is the one statement of the routes a model reader's pass reaches.
An agent's pass and a turn's are refused on every route that widens or answers (403
`PERSON_ONLY`).

**One seat.** `hiding.ts` `read(reader, path, body)` is the one path of every model read. It reads
the reader's access as the call's row is begun. An agent's level is its access's `hide`; a turn's
level stays its conversation's. The access goes on the step the path hands the engine
(`reads.ts`, `Step.access`) as data. The reader thread compiles the gate once, on the request's
clock (`call.ts`, `Call`), and each walk asks `decide` of every candidate before it is kept,
counted, ranked or paged. So three conditions stand in a fixed order, none reading another: the
gate decides what the reader may be served, hiding's row face decides which of those stand for
what the reader typed, and the out face hides what leaves.

- The gate is not a question of the row face. The row face judges a page at a time after the
  engine has ranked and cut, and does not run at a level that hides nothing.
- A continuation, a handle and a count row's handle are read under the gate of the request that
  reads them.
- A walk reads a prepared total under a gate only when the gate allows everything the total
  covers; else it walks the facts.
- One clock a request: a one-off that ends while a request runs is ended from the next request.

What each route answers under a gate is on [packages/home/README.md](../../packages/home/),
"The record's index". In short: every list, number and page is of allowed things; a ref outside
the access answers 403 `OUTSIDE_ACCESS`, "Outside your access.", and nothing of what it is
(`gone` among several refs); a chat with no allowed message answers `OUTSIDE_ACCESS` too, a typed key judged as a chat even when it is also a handle; a record's
older versions are read only under a full access.

**What was kept out.** An answer of a model reader states `outside: true` when its walk passed over
something the ask matched that the gate withheld, on the first page of a list only. The terms a
walk matches are the terms hiding's in face admitted, so a word the reader may not search sets
nothing. The MCP server turns it into one line, `NOTICE` in `mcp/lib/shape.mjs`: "More matched
outside your access. Ask for more with `access`." The walk also counts what it passed over by
reason, and says when it stopped at its cap. The counts never enter the answer: they go to the
call's row.

**The order of a search** can still lean on withheld records. The index ranks with SQLite's BM25,
whose weights are read from every entry it holds, and whether a rare word is widened by near
spellings is read from the whole index too. No answer carries a score or a rank, and a cursor
reaches a model only as a handle.

**A guard in tests.** Under `LIFESTREAM_TEST_WALKS=1` the out face judges every ref it is about to
send once more, under the request's gate, and throws when one is withheld. A deployed home does
not run it.

**The tools** are the four read tools, `feedback` and `access`. Each posts its arguments once and
prints what the door answers, so no tool has one path for a full access and another for a limited
one. What the `access` tool sends and answers is on [mcp/README.md](../../mcp/); Chat's
`agents` tool, which reads every reader's access and proposes a change, is there too.

## Requests

An agent asks for more with the `access` tool (`POST /v1/access/request`). A request names one
want: everything, a category, a product or an account, with an optional time limit, a duration
(`for`, 5 minutes to 7 days or `always`; 1 hour when unstated) and the agent's reason (one line, at
most 300 characters). The reason is untrusted: kept as written, shown quoted, never read as an
instruction.

- **A product is its accounts of that day.** Allowing a product writes one allow per account of it
  connected then. Only an open allow takes accounts connected later.
- **One open request by the agent, and one open proposal by Chat, per agent.** A new one replaces
  only its own maker's.
- **A request lapses** after 24 hours (`LAPSE_MS`). Lapsed is read, not written by a clock: the
  row is written `lapsed` the next time a write touches it.
- **After a No,** the same want (`want_key`, the want's digest without its reason and duration)
  cannot be sent again for 24 hours. A second No ends it until the person changes that agent's
  access. A No leaves the access as it was.
- **The agent learns the answer** from `access` with no arguments, which states the answer to its
  last request until the next one.
- **An answer names the version** its proposal was made from, and the ledger refuses another (409
  `ACCESS_CHANGED`), so an approval never writes over a narrowing made since the card was drawn.
  Each answer reads again, in its transaction, that the request is open, so two devices never both
  change an access. An answer to an ended request writes nothing and answers its real state.
- **Chat's change** (`POST /v1/agents/<id>/propose`) is judged by `widens`: a narrowing applies at
  once, and the turn shows the home's line with Undo; a widening is stored as a request `by: chat`
  and shown as a card the app draws from the waiting list, never from the model's words.
- **The editor's edit** (`POST /v1/agents/edit`) takes the same road (`narrowIn`): an edit that
  only narrows the saved access is saved at once, under the version it was drawn from, and answers
  its line and its Undo, the saved access and the new version, which a save puts back; an edit
  that widens stays a draft until the person's Allow. A tap whose draft no longer widens the saved
  access saves that whole draft, whatever the draft held before, so what is saved is what the
  screen shows. A tap whose draft still widens is split: the tap applied to the saved access, when
  that narrows it, is saved at once as a change of its own (its line, its Undo, `saved` the access
  saved now and its view), and the draft stays a draft over it, its widening words drawn against
  the new saved access. Cancel drops the widening alone, Allow saves it alone; a plain browser,
  which has no Allow, still narrows. A narrowing's Undo stays while the saved version is the one
  it made: a later tap that saves nothing, and Cancel, keep it. The same edit sent again (a reply lost) answers as the first did and
  writes nothing: when the access stands at the version after the one sent, made by a narrowing
  of the same maker and pass (`againIn`), and the edit judged against the access before gives the
  access saved, the home answers that draft; any other edit from the old version is 409
  `ACCESS_CHANGED`.
- **Everything but, Only these** is one field of the editor's view (`mode`), read from the access:
  `but` while a live open allow (`{all, but}`) stands, else `only`. Switching keeps every kind's row
  as it was. To Only these, each open allow becomes one open category allow per kind it reads that
  has accounts, its time limit and end kept: new accounts of those kinds are still read, a new kind
  is not, and it narrows, so it saves at once with Undo. To Everything but, the kinds read whole
  under one time limit fold into one open allow whose `but` names every other kind connected; a
  new kind is read, so it widens and waits for Allow.

The routes, their shapes and who may call each are on door.md. The editor's
logic is the home's alone (`packages/home/access-edit.ts`, `applyEdit`, `viewOf`): a device draws
the view the home answers and sends one edit per tap. Every sentence a person or an agent reads is
written by `packages/home/access-words.ts`.

## History

**A call** is one request of a model reader to one of the four read routes, `feedback` or
`access`. The door writes its row inside the one path, so no route begins or ends a call and the
MCP server sends nothing for it.

1. **Arrival.** The row is begun `running`: the reader, its session, the access's version, the
   ledger's epoch, the tool, and `sent`, the arguments as the model wrote them. A `joined` change
   that is due is written in the same transaction.
2. **The in face.** `read` is the arguments as hiding's in face put them back.
3. **The save.** The path saves the reader's table and the outbound row in one transaction before
   the answer leaves, and the call's end in it: `answered`, or `refused` with the refusal's code and words;
   the time taken; and the withheld counts, one row a reason.
4. **A request that throws** ends `failed`, in a write of its own, with a refusal's code when it threw one.

- The answer's text is never kept. What it carried is kept by kind and count (`came`, the tally of `itemsOf`):
  each item the answer delivered once (an object's own `ref`, or the ref ending a count's row; never
  a conversation, person or place named beside a hit, nor the ref a line read echoes), a record
  under its account's category, a day's line under its family's kind (`line` when the family is no
  kind), a screen window as the Screen, a picture as Photos, a place as Places, a person as
  `person` (the only kind `search_people` counts). It is a few words and numbers a call, tens of
  bytes in `call_came` beside the call, and names nothing an erasure would need to take. Each item
  is kept too, in `call_items`: its ref and kind, a record's source, kind and key, a line's or a
  window's day, ids and never content, at most 1,024 a call in answer order, written in the
  transaction of the call's end. An erasure takes the items naming its records and days. A call
  from before it carries none. A `count` that answered with numbers alone carried no item: its
  line says "Numbers only", never "Nothing found"; the catalog of what can be counted says
  nothing.
- **A read** is a call answered by a reading tool: never one refused, failed or unfinished, never
  `access` or `feedback` (`isRead`). The list's and the agent's counts are reads: `reader_reads`
  keeps each reader's total, first and last as a call ends, a day's reads (a calendar day in the
  home's zone, as every date a person reads) are a range count on
  `calls_read` (an index of reads by reader and time), and each kind's reads in 30 days sum the
  `came` of that window's reads. No count walks a reader's whole history; the editor's taps ask
  none of them. An agent's last reads are its newest reads by the same predicate (`reads`, on
  `calls_read`), so "Last reads" and "See all N reads" count the same calls. `reader_kinds` keeps
  each kind a reader's reads brought back, one count a read, written as the call ends: the
  history's kind filter is that list, served with its first page (`kinds`).
- A row left `running` reads "did not finish": the door stopped mid-request.
- A call that ends after an erasure ran (its epoch is not the ledger's now) keeps its result and
  its time, and no words.
- Each call names its access's version, so "withheld by line 3" stays true after an edit.

**A session** is a number per reader. A call joins the reader's last session when it began under
30 minutes after that session's last call (`SESSION_GAP_MS`); else it starts the next. An MCP
`initialize` starts the next too: the MCP server says so in a header of its next request (its read
of the agent's access for its instructions). `/mcp` keeps no connection, so `initialize` is the one
mark of a new one. That read starts the session but is no line of History: `call_opened` keeps it
apart, and `calls` leaves it out. An `access` the agent asks for itself is a line.

**A change** is an `access_changes` row with the access after it:

| `what` | Written when | `by` |
|---|---|---|
| `granted` | a sign-in is approved, a pass is added, the move writes a reader's first access | `person`, `home` |
| `widened`, `narrowed` | Settings, a card's Change, Chat, the agent's own drop | `person`, `chat`, `agent` |
| `requested`, `allowed`, `declined`, `replaced`, `dropped` | a request moves | `agent`, `person`, `chat` |
| `lapsed` | an open request a day old, written when a write next touches it | `home` |
| `joined` | a newly connected account falls inside the access | `home` |
| `erased` | an erasure took an account a line named | `person` |
| `removed` | the grant is revoked | `person`, `home` |

A request's rows (`requested`, `declined`, `replaced`, `dropped`, `lapsed`) leave the access as it
was; every other row moves its version on by one, and closes Chat's open proposal for that reader
(`replaced`, no row of its own): it was drawn from the version before, so its Allow could never land.
A one-off's end is read from the row that granted it, never written. `joined`: as a reader's request arrives, the door compares the accounts its
access reaches now with `covers`, and writes one row for each new one before the first read of it.

**A history page** (`pageOf`) draws each call in the agent's terms: what it did (`act`:
Searched, Read the day, Looked up people, Read a conversation, Counted), the text it typed for it
(`asked`: its query, the day, the name; the agent's own words, untrusted, shown as written and cut
at 60 characters), what came back by kind and count, the details hidden by count (the outbound rows'
counts), and what matched but was kept out. A session with more than 8 calls (on the page, or
counted whole across pages) shows its first 5, then folds each run of calls between two changes
into one line the home words ("9 more · Searched 5 · Read the day 4"), its calls inside it; a
change is never folded. A session folds once: the page it starts on draws its head and opens its
last run's fold, the cursor carries how many of the head were shown and the open run's tally, and
the next page's first run continues that fold (`continues`), its count and words the whole run's
so far, its lines that page's; a device joins the two folds into one. A fold tallies each call by
its kind, one of a fixed list (`FOLDS`, access-words.ts), so the tally the cursor carries is a
count per kind, as short for any session; a line says how many records a read asked for ("Read 3
records"), the fold counts those reads as one kind ("Read records 3"). Each act is one line:
an `access` call that changed something (asked, asked again, took back its request, gave up a line)
is drawn by its change alone, and an ask that replaced the open one is one line ("Asked again for
…"); an ask the home held after a no says so ("Asked again for …: held, you said no"). A call
refused for what the home could not answer yet (a 503 refusal: building, busy; `NOT_YET`, by the
code the call's end keeps) reads "Lifestream wasn’t ready", never Refused, which is the access's.

**Kept for ever**, in the ledger. The history is not a stream: it lands no record and no day
prints it. A disconnected agent's history stays, under the name its grant had.

**Disconnect** revokes the agent's pass and removes its access, as a removal always has. The
agent stays listed, Disconnected, with its history, until the person's Remove from the list
writes an `unlisted` row (one the home removed itself, a sign-in it refused, is never listed); that hides the row and deletes nothing. The agent's read carries the
words of both: `disconnect` (Stops and Stays) while it is connected, `unlist` (the question and its
line) once it is not. Signing in again makes a new
agent: a sign-in proves only the name the agent gives and the host it sends to, so nothing ties
it to the one disconnected, and its access is the person's answer to that sign-in. The person's passes read
it (`GET /v1/agents/<id>/history`), and so does Ask's `agents` tool; an agent's pass never does.

**An erasure removes the record, not the history.** What names an erased record or account by its
identity loses that name; nothing an agent typed is touched. An access names no record and no
chat, but it can name an account, so the erasure of a whole account scrubs it from every access,
snapshot, want and call's `read`. The scrub is privacy's (`scrub`), handed to the ledger's
`forget`, which runs it first in the erasure's transaction and rolls the whole erasure back if its
output still names an erased identity. The scrub never widens: an `account` allow naming the erased
account goes, and a category allow whose `but` names it goes whole, since taking it out of the
`but` would let the allow reach it. The `erased` row names the lines that went.

## Known limits

- **What an agent has read, it keeps.** A one-off ends what the home answers next, not what the
  agent remembers.
- **A derived thing with one account outside the access is withheld whole.** The door does not cut
  a stay, a line or a fact.
- **The notice is one bit a query.** An agent can spend queries to map what it may not read, and a
  word hiding hid inside a withheld text can set it.
- **What an agent typed outlives an erasure.** A query or a reason can quote a record the person
  later erases.
- **The same message in two accounts is two hits.**
- **A process running as the person on the home's Mac can widen an access,** as it can answer a
  sign-in and read `home.db`.
- **The screen is close to everything.** An agent allowed the screen reads what stood on it,
  Health and Money apps included. When a change turns the screen on, the editor and the card say
  so first.
- **A Chat narrowing needs no tap.** Chat reads the record, and the record holds text other people
  wrote, so a mail can lead Chat to narrow an agent. Nothing private leaves that way, and the
  line Chat shows carries Undo, and the history names Chat.
