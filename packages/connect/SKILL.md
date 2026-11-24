---
name: connector
description: "Add a connector to a Lifestream home end to end, from its kind's template: an API polled with a key or an OAuth sign-in, a site read in the person's Chrome, a Mac app's store, a folder the person picks, or an export the person hands in. Use when asked to add a source, provider, app, folder or download to Lifestream."
---

# Adding a connector

A connector is one folder. A **home folder** sits in a person's home, in `<root>/connectors/`, and the released home
loads it at its start: this is what a person's coding agent writes, and this page is for it first. A **release
folder** sits in this repository under `packages/connect/` and ships in every release; it takes the same steps and the
few more of "A release folder", at the end. A folder moves between the two unchanged.

Each member's rule is its type in `declaration.ts`, which the SDK carries to an editor, and its refusal in `admit.ts`.

## A home folder

**The command is `lifestream`, at `~/.local/bin/lifestream`.** Where a bare `lifestream` is not found (an agent's shell
that reads no shell file), type every command this page names as `~/.local/bin/lifestream` (`~/.local/bin/lifestream
connectors test <id>`), as the person's prompt asks; where that link is not there,
`"$HOME/Library/Application Support/Lifestream/current/bin/lifestream"`. In a checkout it is `bin/lifestream`.
`lifestream help connectors` prints the verbs below, the kinds a home folder can be, which kinds `preview` reads, and
this page's path in the running release; the home's own `<root>/connectors/README.md` names the same.

Nothing before `install` touches the live home, and no step needs vitest, tsx or a runner of your own: `test` and
`preview` run the folder as the home runs it, in a scratch home. A verb that meets the home starting (after an install,
a deploy) prints the home's own words once, "asking again", and waits: it is no fault.

1. **Learn the shape** from the real thing, **read-only**: schema, keys, fields, types, time spellings, what repeats.
   A SQLite store in use opens `?mode=ro` beside its `-wal` and `-shm`; one its app holds locked ("database is locked",
   as Firefox holds `places.sqlite`) is copied with its `-wal` and the copy opened. Core Data entities are read by name
   in `Z_PRIMARYKEY`. Credentials are off-limits: an API's shapes come from its docs. Report what you measured; never
   write a real value to a file. To try an SDK reader on a real file before the folder exists, run a
   script outside the home with the release's own node, importing the SDK by its path:

   ```ts
   // probe.ts, run as "$HOME/Library/Application Support/Lifestream/current/node" probe.ts <file>
   import { pathToFileURL } from "node:url";
   const sdk = await import(pathToFileURL(`${process.env.HOME}/Library/Application Support/Lifestream/current/dist/sdk.mjs`).href);
   ```

2. **Draft it:** `lifestream connectors new <kind> <id>`, the kind from the table below (with no kind, `new` prints
   them). The id is the product's own words (`google-tasks`), and its sources', settings' and sign-in's for good once
   installed: choose it before `new`. The template is copied into `<root>/connectors/.drafts/<id>/`, which no start
   loads, and renamed (its id, its product, its `Example` the id's words), with a `tsconfig.json` that type-checks it
   against the running release's SDK. The draft is your working copy for every verb after; each takes the id.
3. **Write it:** the steps of "Every kind", then the kind's own section. The template's page (`<id>.md`) says what each
   of its files does and where a copy changes it.
4. **Test it:** `lifestream connectors test <id>`, offline. It type-checks the folder where you edit it
   (each fault `<file>:<line>:<column>`), admits it as the home's start would, lands its fixtures through the home's
   importer, and prints each day line as the day file prints it (in this home's zone and day start, named on its first
   line), each record's search words (its own text's, else its day lines') and its Open in link, or, once per kind with
   none, why, and the `open.record` that gives it one: what the person will see. Each fixture is then landed alone, whole
   and with each file spoiled (step 5 of "Every kind"), as the release's own readers are. A record of any family opens by its
   connector's `open.record`, never by its adapter. Then it calls every acquirer through the cases its inputs have,
   against the fixture's fakes (step 5 of "Every kind"), ending in reaches the day: what the cases landed read to the
   day and search as the fixtures are, so an adapter that reads it as nothing fails. Each value an adapter returns is
   held to the rules its family reads it by (`packages/families/<family>/faults.ts`), each fault in the rule's words. Edits and removals print what they
   changed of the day and search (`- `/`+ `), reaches the day its first day's lines. An export is handed its download
   through the import seam, the same again, then one with an item edited and one with an item gone. It prints each case as `run` or
   `not run` with why: a case not run is never proven. A page still the template's words is named before the pass
   line, owed before install. All of it but the type check runs in one child that refuses every connection and is
   timed (15 s each for the folder, the fixtures, each fixture alone and each case; 2 minutes the run): a part that hangs is killed and
   named, the rest printed as not run. Every fault is `<member>: <what is wrong>`, most with the fix. It exits 1 on any
   fault.
5. **Preview it:** `lifestream connectors preview <id> <path>` over an export's file; `--set <field>=<value>` over a picked folder,
   an address, or a key or a link that is its own credential given as `--set <field>=-`: read from standard input,
   never typed after `=`, held in the preview's memory alone, and in nothing it prints. On a Mac with the Lifestream
   app, terminal input is refused because the recorder would keep the keys. Pipe it in:
   `printf '%s' "$KEY" | lifestream connectors preview <id> --set key=-`.
   It prints the records by kind and the days they span, the refusals, and the first and last day's lines; nothing is
   kept. For OAuth sign-ins, Chrome sites and Mac app stores, it names `test` instead: that runs the folder's own
   scenario and prints what lands as the day and search show it. Their real input waits for install and setup.
6. **Install it:** `lifestream connectors install <id>` tests it again beside the home's other folders, refuses a clash
   (an id or a product another folder holds) naming the holder before anything moves, copies the draft to
   `connectors/<id>`, restarts the home and answers once the home runs it and its door serves the restarted home (past
   30 s it answers all the same and says the door lags, or is not answering yet). A change the verb is loading itself
   raises no "Restart Lifestream" need. The person then sets it up in the stream's own dialog (each kind's section says
   how), or you set its fields with `lifestream connectors set <id> <field> <value> [<field> <value>…]`: fields that
   change together go in one `set`, and each call polls at once. With no home running, the read or fetch is queued for the start, and the line says so; setting the same file
   again queues nothing and prints the read's state. An `account` field names the source: set to another, it is
   another source, read from the start, and the old one's records stay.
7. **See it:** `lifestream connectors show <id>` prints its settings, what each poll is doing (`running since <when>:
   a fetch`, `queued: …`, `not run yet`), and each source's last poll (when, its outcome, the
   provider's words). Where no call's line says it read, it adds "last read <when> (a fetch)"; `--json` carries each
   poll's `read`. "not run yet" means no read, no call, nothing running or queued. A poll has no deadline. A home's stop
   or kill cuts a run short; the next start says "Stopped when Lifestream quit · running again" and calls again.
   Every cut is a wait; `show` counts "N times in a row". The day is `<root>/days/<date>.day.txt` and Days; search and
   Chat find its words. `lifestream agents call` lists the tools
   Chat's model reads with and their arguments; `lifestream agents call <tool> '<json arguments>'` prints a tool's
   answer as the model reads it.
8. **Change it:** edit the draft, `test`, `install <id>` again: the installed folder is replaced in place, its records,
   settings and poll kept, nothing read twice. Where the change is to how it reads, `lifestream connectors reread <id>`
   reads its source again from the start, its records kept (an unchanged item lands no new version). A release that
   no longer admits the folder (a new contract, a new check) still updates the home: the folder waits, its connector
   shows "<name> didn't load", its detail the refusal's words and the `install` command to run once it is fixed, its
   poll is parked and its deliveries stay unread until the fixed folder is installed, then they are read.
9. **Remove it:** `lifestream connectors remove <id>` moves it to `connectors/.removed/` and turns its sources off,
   answering as install does. Its records stay in the home and leave the days and search once the rebuild ends;
   `lifestream connectors install <kept path>` brings it back with them, its poll where it was (`show` says when it last
   read). The draft `.drafts/<id>` stays its working copy, so `install <id>` installs your edits. Neither verb touches
   a Chrome site's Turn on: a reinstall needs no second one. Nothing is deleted.

Every verb's answer is its lines; `--json` prints the answer alone, as JSON, for a program, never both: `lifestream
help` says it too. A line said while a verb goes (a wait, a warning) is on standard error, so standard output holds the
answer alone.

| Kind | When | Template | A real one |
|---|---|---|---|
| `api` | the provider has an API the home calls with a key, a token or a link the person makes | [templates/api](templates/api/api.md) | `code/github/`, `notes/granola/` |
| `oauth` | the provider's API takes the person's sign-in, through an OAuth client they make | [templates/oauth](templates/oauth/oauth.md) | `calendar/google/` |
| `browser` | the provider shows it to the person's signed-in Chrome, with no key and no export | [templates/browser](templates/browser/browser.md) | `ai/claude/`, `health/whoop/` |
| `mac-app` | it is an app's own store on the Mac, its SQLite files | [templates/mac-app](templates/mac-app/mac-app.md) | `notes/apple/`, `messages/whatsapp/` |
| `folder` | it is files at a place the person picks on the home's Mac | [templates/folder](templates/folder/folder.md) | `screen/coast/` |
| `export` | the person asks the provider for a download and hands it in | [templates/export](templates/export/export.md) | `location/google-timeline/`, `listening/spotify/` |

"No family fits" is no kind: any kind's adapter may state a plain line (each template page's last section).

**What a home folder cannot be**: an iPhone stream, a labeler, a Mac sensor or recorder; a new
type, family, field kind, icon, grant, or a kind several connectors read (a Takeout's). Each needs code an app or the release compiles. It picks its
type and its icon from the release's lists, and a kind of record no reader states yet is its own to name, said on its
page.

**Its code** is erasable TypeScript in every file, its fixture's too: no `enum`, no `namespace`, no constructor
parameter properties (`private readonly x` in a constructor's parameters); a release's node strips its types and
compiles nothing, and the trial refuses a file it cannot strip. `test` says so beside the type fault, and what to
write instead. It imports `@lifestreamprotocol/connect/sdk`, Node's
built-in modules, its own files, and npm packages from a `node_modules` of its own (the home never runs npm). The home
runs it as itself, with no sandbox: installing a folder is installing software.

## Every kind

What each member of a declaration means is on its type: hover it in `declaration.ts` and the SDK's other modules
(`@lifestreamprotocol/connect/sdk`), and a wrong value is refused by `admit.ts` and `test` in words that say the rule.

1. **Name** it. A source is `<product>:<account>:<copy>`: the product lowercase and hyphen-joined (`google-photos`),
   the account whose it is there (`local` when none), the copy a device unit, `cloud` or `export`. A kind names the
   thing, never the product (`msg`), reuses another product's kind for the same thing (the table at the end), never means two. What a
   kind means is in the kinds table of a page that states it (``grep -rl '| `watch` |' --include='*.md'`` over the
   release's `packages/connect/`): read it before you reuse one. A key is the item's own stable id, else `fingerprint`
   (`shared/fingerprint.ts`) of the fields that make it, never of when it was seen; a local row id only beside a field
   that never changes; an id the same on every device kept, so copies share a key.
2. **Declare** it in `connector.ts`: data only. Its code imports nothing of ours but
   `@lifestreamprotocol/connect/sdk`, and no code outside the folder writes its id or product; its words follow
   these rules: `records` one line of at most 64 characters, `gives` the line its row shows
   before it is connected. A connector that does one job beside others, as dictation apps do, declares the same
   `joins: { name, gives, icon? }` as they do, and the page shows them as one row by that name, naming the apps found
   (Dictation). `starter: true` is the release's alone: the few connectors a new home's page offers first,
   under "Start with these" (iMessage, Photos, Location, Health, Screen, Calendar). Durations are bounded (`30s` … `2d`) with
   a default; a road's defaults hold where it says nothing. A work a model does to its items goes in `processing`
   (the shared ones in the SDK's `works`: a messages folder's photos and voice notes are `works.CHAT_PHOTOS` and
   `works.CHAT_VOICE`). A field is a knob a person turns; page sizes, timeouts and retries stay in code. An `icon` is
   a key of `design/icons.json` (in the release, `~/Library/Application Support/Lifestream/current/design/icons.json`);
   each draws the Phosphor icon its `phosphor` names (`send` is `arrow-up`, `message` is `chat-circle`); leave it out
   for the type's. A wrong one's fault names the closest.
3. **Read** it in `reader.ts` ([Traps](#traps)):
   a replica's bookkeeping (sync tokens, display order) left out and named on the page; from an app's store only the
   columns it names (`requireColumns`); each item timed by when it happened through `instantOf`/`spanOf`/`tryInstant`,
   never core's `instant` alone, none where the source gives none, and a date with no time a date, never a midnight; a
   spelling no rule names by its pattern, `instantOf(value, { pattern: "MMM d, yyyy, h:mm:ss a" }, where, { zone })`
   (the letters of Unicode TR35, as date-fns, ICU and Java write them).
   `gone` where the source states a deletion, and where it answers its whole set each time, an item it leaves out,
   diffed against the poll's memory. A member named `type` or `blobs` refuses its row; a number past a float's
   precision is a string (`readJson`); bytes inside a file are `ReaderOutput.bytes`, a zip is read through `archive`.
   A record's content and a cursor are JSON: return `asJson(content)` / `asJson(cursor)`, never a cast through
   `unknown`. An interface or a readonly array is fine; a Date, Map, function or `undefined` member faults where you
   wrote it. A CSV file reads with `csvRows` (rows by header name, one at a time) and an iCalendar file with `ics`
   (`ics.parseCalendar`, its own `VTIMEZONE`s, their onset rules as Exchange, Google and Apple write them: `INTERVAL=1`,
   a UTC `UNTIL`, `WKST`, `BYMONTH`, `BYDAY`, `BYMONTHDAY`; `COUNT`, `BYSETPOS` and longer intervals refused by name),
   both the SDK's. A JSON file too large to read whole (one object of hundreds of MB) reads with
   `jsonAt(member.chunks(), member.where, ["chats.list[*].messages[*]", …])`, a value at a time, each a part `{ where,
   path, at, read() }`; a top-level array's elements with `jsonElements`, `jsonAt` at `[*]`.
4. **Feed its family** in `adapter.ts`: the adapter of its type's family, by the contract in
   `packages/core/inputs/<family>.ts`, whose type the SDK exports (the templates carry the notes one), or a plain line
   where no family reads its kinds: `{ text }`, placed at its record's own time and precision (the template page's
   last section; [code/github/adapter.ts](code/github/adapter.ts) is the release's). Exported as `adapters` in `index.ts`, by connector id. Each item of a contract fits one kind of source: take the one whose
   fields the source states (health's `workout` is a tracker's own, with its strain; `instrument-workout` an activity a
   provider of many holds, with its distance), and read a real one's `adapter.ts` (the kinds table, at the end).
   - A calendar adapter states each event's `zone` as an IANA name, and a reminder's word (`reminderWord`, "Task")
     where its source calls it otherwise.
   - A messages adapter states each party as its network spells it, with its kind: a user id bare (`12345`, kind
     `network`), never prefixed or respelled; the home makes `<product>:<id>` for People, search and Chat. Its types
     come from the SDK (`MessageFact`, `MessageParty`, `MessagePart`, `PartyKind`, `MessageLabel`, `MessageImages`);
     it declares `owner: "account"` when the source's account is the owner's own id. Where the shared reading would
     misread that account (a phone of digits alone read as a network id), `self(account)` spells it: WhatsApp's phone
     JID, iMessage's phone with its `+` or address. The names a day, People and search give its ids come from its own
     label records (`labels.kinds`, `label`, `labelText`): one record a chat, of kind `chat` as WhatsApp's, naming the
     chat and each sender.
   - A web adapter reads as nothing what the person was not shown (`families/web/web.md`: a frame inside a page, a
     redirect's hop, a URL the browser hides), by what the store states: a redirect the browser does not mark is a
     visit, and a browser's own visit codes are its maker's to learn.
   - Where an adapter reads some records as nothing on purpose (a browser's redirect hop), step 5's `skipped` names
     them, and a web stream that counts by records says `counted_by: "web"`, so its today and week count what the web
     family keeps; `test`'s search line for a skipped hop says when the stream counts it.

   Admission refuses an adapter missing a call its family requires, by the call's name; a folder whose fixtures land
   kinds with no adapter at all fails `test`: its records would reach no day and no search. A change to what an adapter
   gives bumps its `version`, which rebuilds its family's extracts on every home.
5. **Prove** it in `test/fixture.ts`, importing the SDK alone: `fixtures`, each reader's small valid delivery by reader
   name, which `test` lands to a day and spoils file by file (each cut to its first `Math.floor(bytes / 2)` bytes, then
   bytes that are no file): where one file holds many records read value by value (`jsonAt`, `csvRows`), its `prefix`
   names the heads whose values lie whole in that first half, computed in the fixture from the same bytes. Then
   `settings`, the fields its acquirers are built with; `secrets`, what each secret field holds in the fake; and one
   fake for each input an acquirer meets, each a function of a `Scenario` (`items`, how many the source holds; `old`,
   how many it holds before the run, dated before `start_ms` as the provider would date them: the proof's first fetch
   meets them alone, then the rest are added, so old and new are the scenario's, never a record's time; `edited` and
   `removed`): `provider(scenario)` for an acquirer that requests over HTTP, `site(scenario)` for a Chrome recipe,
   `files(scenario)` for a folder poll and an export; and `export const item: ItemOf`, which item of the scenario a
   record it landed is, by its kind and key (the number the fake gave it, null for a record no item makes): each case
   reads every walk by the items it landed, never by how many. A provider, a site and an acquirer with `page` also
   export `dated(scenario, n)`, when the fake dates item n in ms by the time its road pages its history by (an edited
   item at its edit where that is its update, at its creation where that is its creation), at `scenario.stamped[n]`
   where the scenario stamps it: each run is lent a start (`lent.start_ms`), the UTC midnight of a day among the old
   items' or of the earliest's: its page lands nothing dated before it, nor does its fetch, an item new to the source
   but dated before the start and an old one edited since among them; a start moved earlier reads what the old one left out, whichever call, fetch
   or page, runs first after the move; one moved later lands nothing older and ends its walk at `left: 0`; and one moved
   later and then back reads the gap (`lent.from_ms`, the start the cursor was left under). An item stamped at the
   newest sealed item's time still lands. A source whose items never change
   once captured exports `immutable = true`, and an edit then lands nothing. An acquirer with no fake for its input fails `test`,
   naming the export it lacks, and so does an export without `item`, whose edits and removals then print not
   run. A record its adapter reads as nothing on purpose is named in `export const skipped = ["<kind> <key>"]`, as
   `test`'s search lines name it: some records of a connector's kind, never all of them.
6. **Write its page**, `<id>.md`, as the template's: what it records, its kinds, keys, content and time, its reader's
   rules, and a kind it names that no release reader states.

## Traps

- A reader copies what the source states, every field; it may leave fields out, never alter
  what it keeps (`health/apple/samples.ts` the one exception).
- A reader reads part by part through `each` (`shared/refused.ts`): a part that throws `Refused`
  is that part's refusal and the rest lands. It throws before its first row only when nothing
  of the delivery is its; it never skips a reference it cannot resolve, it refuses it.
- An acquirer's facts never state `history`, `left`, `start_ms` or `months` (`HOME_FACTS`): the seal refuses
  them; the home states them on a page, `left` and `months` from what the page answered.
- Nothing new is an empty fetch (`files: []`), not a `NotYet`; a network failure is the wait
  `offline` (`shared/offline.ts`), not an error.
- A member a reader only stores (a photo, a video, an attachment) takes `members.ts`'s `stored`, hashed and handed to
  the home in chunks, never read whole; `readStoring` (`test/drive.ts`) proves it on a member past a whole read.
- A bounded-memory proof is `boundedRead`: its input is once the heap cap, so a read that held
  it dies.
- A parity golden (`test/parity.golden.json`, `golden*.json`) is never rewritten by a flag;
  `LIFESTREAM_UPDATE_GOLDEN=1` rewrites only `labelers/faces/test/flow.golden.json`.
- A connector's kinds, keys and source ids are identity: changing one needs the maintainers' agreement, asked in an issue.

## api

1. `connector.ts`: `signin` checks whose a credential is with one GET (`check: { url, account }`), else in code
   (`signins` in `index.ts`); an expiring token goes through the SDK's `tokenRefresher` or `oauthRefresher`. A check's
   `url` is `{credential}`, whole, for a link that is its own credential (an ICS link: https, or http on loopback,
   no name or password, asked with no header); `{credential}` stands nowhere else in a url, so a key taken in part of an
   address is checked in code. The check follows no redirect: a 3xx is refused.
2. `acquirer.ts`: the factory takes `AcquirerSettings<Fields>` (its fields as they run, and the home's `work`, `zone`,
   `unit`) and `Dependencies` (`fetch`, `now`, `sleep`, `imap`): the home builds it with its settings and lends it its
   IMAP connection alone, `test` hands the fake's `fetch` and its own clock. Every request goes through the SDK's `request` with that `fetch` and the call's
   budget, a stop through `afterStop`, never a `fetch` of its own: `test` names a direct call a fault, and refuses every
   connection the run does not answer. Settings are read in each call, never at build. An acquirer named otherwise than
   its reader is in its source's `feeders`; facts carry `...feeds(source, reader)`.
   A provider read over IMAP asks for `dependencies.imap` (host, port, account, password in; a session out) for every
   session, never a client of its own, and its `test/fixture.ts` exports `mailbox(scenario)` in place of `provider`.
3. The cursor (`Fetched.state`) holds only fields whose count the code fixes: clocks, a watermark, a page token, at
   most 16 KiB. Anything per item (each id seen, owed or sealed at an instant) is the poll's memory, `lent.memory`, by
   part and key: the template's `at-instant`. A `NotYet` or `NeedsYou` that carries a cursor commits every change of
   memory the call made, as a call that returns does: so a mark that an item was fetched is put only by a call that
   seals the item, never before such a throw. Seal one file per feed or per page, never one per item: each file is
   flushed at the seal and again into the home's blobs (about 6 ms each on a Mac, more on a VM), so 3,000 files take
   40 s or more. A page that waited on the home, the network or Chrome is asked again within a minute, never at its
   pace. The cursor holds no start: `lent.start_ms` is the UTC midnight before which the call reads nothing (null for
   all), and `lent.from_ms` the start the cursor was left under (null for all, undefined before any cursor). The home
   leaves the call's start with every cursor a call leaves, fetch or page, so the call that first sees `start_ms`
   earlier than `from_ms` (the SDK's `movedEarlier(lent)`, which then answers `from_ms`) changes the cursor to read the
   gap `[start_ms, from_ms)` (the template's `historyUnder`); a start moved later lands nothing older, and the walk ends
   at it with `left: 0`. A fetch lands nothing dated before the start either, by the time the history pages by: a
   listing by update time leaves out an item created before the start where the history dates by creation.
4. `test/fixture.ts`: `provider(scenario)` answers the provider's own addresses and shapes for any scenario, and
   `secrets` what the key field holds, and `item` reads its records' keys back to the fake's items. `test` runs lands
   new, lands history (with `page`), keeps to its start (with `page`), a fetch keeps to its start, and the start moved
   earlier, later, and later then back (with `dated`), replays, edits, removals, cursor stays bounded (the cursors at 4N items the size of those at N), waits out
   a limit (a 429 in each walk) and signs out (every request a 401), each line saying what it held.
5. A `page` answers `months` (`FetchedPage.months`) only where its provider counts the whole source in a request or
   two, never by walking it (Gmail: one `UID FETCH (UID RFC822.SIZE INTERNALDATE)` a mailbox). The first page of each
   walk answers it, and any page while its cursor holds no mark that it counted (the home asks one of a source with no
   count, a walk already done included: that page counts and downloads nothing), no other page: every item of the connector's `counts` kinds above and below the start, by the UTC
   month the page dates it by (`YYYY-MM`, `UNDATED` for an item with no time), `[items, bytes]`, the bytes those of the
   files the items bring. The acquirer says `months: true`; the home prices a start from that count and waits for it,
   so one that says it and answers none holds the start slider at "and more". `test` runs counts its months: the
   first page's months hold, month by month, the items the walks land.

## oauth

1. `connector.ts`: a `secret` field the sign-in fills, and `signin: { way: "client", client, scope, field, check }`.
   Where the API states no account, `check` asks the provider's own account address with its scope added (Google's
   `https://www.googleapis.com/oauth2/v3/userinfo`, `account: "email"`, scope `…/userinfo.email`). Scopes are
   space-separated in `scope`. `lifestream connectors show <id>` prints the route as "opens <authorize endpoint>, asking
   <scope>, with <the client's params>".
2. `client` names the client by id. Google's is the release's, `client: "google"`: the person's one Google client
   serves every Google route and is asked once, and the folder exports no `clients`; its route's own step (`steps`)
   turns on the provider's API in that project. Any other provider's `index.ts` exports its sign-in in `clients` (its
   authorize and token addresses, the steps the person takes before the first sign-in). On a new home the first Sign
   in asks the person to create the vault (its recovery key) first, then shows the client's steps and the route's
   `steps`. A route's `steps` are titled as an export's guide is (`title`, `words`, at most one `open` link), two at
   most, and its `note` is the one line under its sheet (Gmail's "Signs in with an app password, never your Google
   password.").
3. `acquirer.ts` as `api`'s, every request through `request` with `refresher: clientRefresher("<Provider>")`: the
   credential is sealed whole under the field, and the loop sends its access token, refreshes it and keeps a rotated
   refresh token. The acquirer never reads a token itself.
4. `test/fixture.ts` as `api`'s, `provider` answering the token endpoint too, and `secrets` the sign-in as the `client`
   route seals it (`credentialText`). `test` adds refreshes: an expired credential refreshed, the rotated refresh token
   kept, an `invalid_grant` signed out.

## browser

1. `connector.ts`: `chrome`, its `origin` and `probe`; `chrome.signin` where it applies, with a recipe in the folder's `recipe.ts` (exported as `recipes`) to sign in by itself. A
   site with no JSON sign-in declares `probe: null`, and its recipe's `begin` says who: `{ id, email }` where the site
   shows an email, else `{ id, name }` (the name it greets the person by); `id` is the site's own account id, which
   names the source. A source added by hand (`lifestream source add <product>:<account>:browser`) takes its account's
   words, `--options '{"name":"…"}'` or `email`; one with neither is refused.
2. At Set up the person turns the site on in Chrome: the extension's page asks first, then Chrome itself ("Read and
   change your data on <host>"), an Allow each; the extension needs no new build. Until both, the stream says "Allow
   Lifestream on <name> in Chrome", and its lane is tried again at the 5-minute retry; it reads within seconds once the
   extension reports the grant. From a terminal, `lifestream connect` holds the wait for a browser 2 minutes and lists
   each browser's request; `lifestream connect answer <id> allow` answers one while it waits. `lifestream connectors
   check` names the browsers it asks; `lifestream connectors` shows each one's finding. A signed-out stream, or one
   asked for a password, waits for its refresh clock, not the retry, and is read again the moment the person's page
   loads signed in.
3. `acquirer.ts`: a `Recipe` over the SDK's `browserAcquirer` (`begin`, `list`, and `conversation`, an item's read); a
   lane of another shape writes its calls inside `onSite` (`shared/site-lane.ts`: what every lane
   shares). The factory takes `AcquirerSettings` and `Dependencies`; every request is the station's, through `pull`.
   Its cursor and memory as `api`'s step 3: each account's place and marks are memory, its own by `SiteVisit.memory`.
4. `test/fixture.ts`: `site(scenario)`, the SDK's `Site`, which the in-memory station answers the page's requests from
   (its pages, `page(url)`, where the recipe reads them): an answer's body a string for HTML, any other value for JSON;
   and `item`, as `api`'s. `test` runs the recipe's cases over it: lands new, lands history, replays, edits, removals,
   cursor stays bounded, signs out.
   Measure `origin` and `probe` in a signed-in Chrome before the first real run. With no account to look at, a page's
   shape comes from the site's public pages or an open reader of them; `show` reads each guess at the first real run.

## mac-app

1. `connector.ts`: `mac: { app, grants, store }`, no `refresh`, `backfill: { about }`; a source on the
   `mac` road, `<product>:<account>:<unit>`.
2. `store.ts`: the store as data: its `held` path, its account rule, its engine (`sqlite`,
   `file`, `logs` or `biome`) and what it reads. No Swift: the Mac's one store shipper reads it, under the safety rule.
   Its paths are fixed, the app's own places under `~`, never a field: a folder the person picks is the
   `folder` kind's. A store in profile folders (a browser's) takes the `folders` account rule with `spelled: false`, as
   `browser/chrome/store.ts`; a `match` pattern finds a name anywhere unless it anchors with `^…$`. The shipper reads a store in place while its
   `-wal` and `-shm` stand beside it, else from a held copy: a store its app holds locked ships too.
3. `preview` names `test`, which reads the fixture's store (step 6) as the day and search show it. The Mac app reads
   the real store after install and Allow.
4. The person allows the store on each Mac, in the Mac app's sheet that names every path it reads; a changed
   declaration asks again, and once allowed again that file ships whole under the new declaration. The stream's own row
   in Streams, and its To connect, say "Allow <name> on <Mac>" with Allow once the Mac holds the store; before, "Not
   looked for on <Mac> yet". `lifestream connectors refresh <id>` asks your Mac to read it now, as its stream's Refresh
   does.
5. `reader.ts`: its `columns` from the store the Mac ships (`openDeliveredSqlite`). The Mac's file holds the tables
   `store.ts` declares and nothing else, so a reader reads only declared tables: one it names that is not declared meets
   "no such table".
6. `test/fixture.ts`: `fixtures`, the store whole as the Mac ships it. No acquirer runs: the Mac's shipper is the
   release's.

## folder

1. `connector.ts`: a source on the `poll` road, `<product>:local:<unit>`, the home's own Mac; a `path` field with
   `folder: true`, its label the first setup step's words ("Choose Vault folder"): name it as the person knows the
   folder; a declared `backfill`, so the folder follows the stream's start: a file modified before `lent.start_ms` is
   passed over, and read at the next walk once the start moves before it.
2. `acquirer.ts`: the folder walked whole at each poll, what changed held in the poll's memory (size, write time,
   SHA-256 by path), never the cursor; a manifest of each changed file's path and times and the paths gone, each changed
   file handed by path. Dot folders, links and files the reader does not read are passed over. A file is stated gone
   only from a whole walk: a read error anywhere fails the poll, and so does a folder that holds no file while the
   memory holds some (a stale mount, a sync client signed out), stating nothing gone.
3. `reader.ts` over the manifest: one record a file, keyed by its path, timed from when it was made to when it was last
   written; each gone path stated gone.
4. `test/fixture.ts`: `files(scenario)`, the folder by its paths, each file its text, or `{ bytes, modified_ms? }`
   (dated so each lands on its day; the proof tells old from new by which files the folder held at its first fetch),
   and `item`, which note a record is by its path. `test` writes them into a scratch folder, sets the path field to it,
   and runs the poll's cases: lands new, replays (every file touched, its bytes the same: nothing seals), edits,
   removals (every record of a deleted file stated gone) and cursor stays bounded; history, a limit and a sign-out print not run.
   `lifestream connectors preview <id> --set <field>=<full path>` is the poll's first run over the person's own folder.

## export

An export rides the one road every import takes ([imports/imports.md](./imports/imports.md)): the person drops the file on its window on
the Mac, or runs `lifestream import <id> <path> [--account <account>]` on the home's machine; the home keeps it once,
reads whose it is and its time off its members before any row, and feeds the connector's source. Installed, its row
stands in IMPORTS with nothing built for it on the Mac. No `acquirer.ts`.

1. `connector.ts`: a source on the `upload` road (`<product>:<account>:export`), and `export: { recognise, guide }`,
   with `name`, `takes`, `wait`, `file` and `leaves` where their defaults do not fit. A member pattern (`**/notes*.json`)
   takes `*` for any run of a part's characters and `**` for any number of whole parts, in any case, under any leading
   folders. A Takeout product's `export: { recognise, product }` is a release folder's.
2. `reader.ts`: `account`, where the export names its account, the one member at `file` (a pattern) read as what it is:
   a JSON (`{ file, json }`; in a member of any size the values at a path, streamed, `{ file, at, json }`), a CSV's row
   (`{ file, row: (fields) => fields.Username }`) or any text (`{ file, text }`), each answering the account or
   `undefined`. With none, or the member absent, the home asks the person whose it is, after the file is in. A rule that
   `refuse`s in words (the file is not this export at all) refuses the whole file, and nothing is asked. Optional:
   `states(members, anchor)`, the export's time from the provider's own evidence (its newest item's), which orders it
   against another export of the account, and its `anchor`, what a later export of the account must restate; without
   it, the export's time is when the home took it in. Then `read`, over the export's members, zip or folder alike, under
   any prefix (`archive`): it still refuses a delivery whose own account is another's. What it cannot read is thrown as
   `Refused` in words for the person: they stand under "Couldn't read what <name> sent".
3. `test/fixture.ts`: `files(scenario)`, the export by its paths, which `test` hands in as one file, zipped, or as a
   folder: one import, naming its source; and `item`, so `test` proves edits and removals: `files` writes `edited` items
   changed and leaves `removed` ones out. `lifestream connectors preview <id> <path>` reads the person's own export.

## A release folder

The same folder under `packages/connect/<category>/<provider>/`, made with `lifestream connectors new <kind> <id> --into
packages/connect/<category>/<provider>`. Every name the SDK exports comes from the SDK; a helper only a release folder
can use (the phone's shipment, a labeler's seams, the statements reader, the handle spellings, `versionId`) comes from
its own module, `../../shared/<module>.js`, `../../seams.js` or `@lifestreamprotocol/core` (`tools/check-layers.ts`
holds both). The steps above, then:

1. **Its own test**, `e2e.test.ts` (the template's, each test a failure that must be impossible, through
   `test/drive.ts`, which `new` copies only into the repository), over its fixtures and fakes; a large source's memory
   proof in `memory-full.e2e.test.ts`.
2. **Its lists:** `npx tsx tools/connectors.ts` lists it in `folders.ts` and writes every generated block: its page in
   [Every connector's page](#every-connectors-page), the kinds below, and a store's digest and fixture for the Mac.
   Nothing of it is written by hand; `--check` says what is stale.
3. **A Chrome site** is asked of Chrome at its Set up, as a home's is: the extension's `host_permissions` never grow
   (an update that grows them turns the installed extension off), and `extension/e2e.test.ts` holds them to their fixed
   list.
4. **A new kind** of record no reader states yet stops you for the founder's ruling.
5. **A family's pin** ([the families' README](../families/)) fails a change its fixture reaches with no
   `version` bump, and after a bump asks to be written again (`LIFESTREAM_UPDATE_GOLDEN=1` on the family's test).
6. **Print it:** `test` refuses a release folder (its ids are the release's own), so
   `npx tsx packages/home/test/release-walk.ts <category>/<provider> <acquirer>` walks one acquirer through `test`'s
   cases over its fixture's fakes and prints its faults and lines as JSON, "reaches the day" among them; no tool prints
   its `fixtures`' own day.
7. **Hold it:** its `e2e.test.ts` green, then `LIFESTREAM_FIXTURES=write npx vitest run
   packages/home/connectors.e2e.test.ts` (it writes the kinds table below), then the same run bare.

Two kinds are a release folder's alone, each needing code an app compiles:

| Kind | When | Template | A real one |
|---|---|---|---|
| `phone` | the iPhone app records it from an iPhone API | [templates/phone](templates/phone/phone.md) | `ios-app/` |
| `label` | the home computes it from records it holds | [templates/label](templates/label/label.md) | `labelers/cameras/`, `labelers/groups/` |

## phone

1. `connector.ts`: its `phone` block.
2. `reader.ts` over the shipment (`readShipment`, `packages/connect/shared/phone-shipment.ts`).
3. The Swift recorder: `ios-app/LifestreamCapture/<Domain>/`, its `CaptureDomain` case
   (`ios-app/Sources/LifestreamCaptureCore/Models.swift`), the pinned domains of
   `ios-app/Tests/LifestreamCaptureCoreTests/CaptureStoreTests.swift`, then `xcodegen`. A new grant's words go in
   `packages/home/stream-words.ts` `grantWord` and `PHONE_SCREENS`; a grant with a first-run screen declares `misses`
   and `why`.
4. `npx tsx tools/phone-words.ts` writes `ios-app/LifestreamCapture/Connectors/Declared.swift` again.
5. `e2e.test.ts` over a synthetic shipment, its blobs carried as the door puts them.

## label

1. `connector.ts`: no `type`, and its `label` block; a labeler that needs something installed throws
   `LabelerUnavailable("not-installed")` until then.
2. `labeler.ts`: its `inputs`, and `label`, reading the view before its first await, delivering only what changed
   (`null` when nothing did), facts with `...feeds(source, labeler)`; `index.ts` exports its factory in `labelers`.
3. `reader.ts` over what it delivers.
4. `e2e.test.ts` over a scratch home: a run, a run that finds nothing new, an item gone.


## Every connector's page

Each folder's page says what it reads, its kinds and its keys: the release's, as examples to copy from.

<!-- The connectors' pages: written by tools/connectors.ts, never by hand. -->
- Connectors, by folder: [ai](ai/ai.md), [ai/ask](ai/ask/ask.md), [ai/claude-code](ai/claude-code/claude-code.md),
  [ai/codex](ai/codex/codex.md), [biome](biome/biome.md), [browser/chrome](browser/chrome/chrome.md),
  [browser/safari](browser/safari/safari.md), [calendar/apple](calendar/apple/apple.md),
  [calendar/apple-reminders](calendar/apple-reminders/apple-reminders.md), [calendar/google](calendar/google/google.md),
  [calls/apple](calls/apple/apple.md), [code/github](code/github/github.md), [contacts/vcard](contacts/vcard/vcard.md),
  [devices](devices/devices.md), [google/my-activity](google/my-activity/my-activity.md),
  [health/apple](health/apple/apple.md), [health/whoop](health/whoop/whoop.md), [ios-app](ios-app/ios-app.md),
  [labelers/cameras](labelers/cameras/cameras.md), [labelers/faces](labelers/faces/faces.md),
  [labelers/google-places](labelers/google-places/google-places.md), [labelers/groups](labelers/groups/groups.md),
  [listening/spotify](listening/spotify/spotify.md),
  [location/google-timeline](location/google-timeline/google-timeline.md), [macos-app/audio](macos-app/audio/audio.md),
  [macos-app/input](macos-app/input/input.md), [macos-app/machine](macos-app/machine/machine.md),
  [macos-app/screen](macos-app/screen/screen.md), [mail/gmail](mail/gmail/gmail.md),
  [messages/imessage](messages/imessage/imessage.md), [messages/whatsapp](messages/whatsapp/whatsapp.md),
  [notes/apple](notes/apple/apple.md), [notes/granola](notes/granola/granola.md), [people](people/people.md),
  [photos/apple](photos/apple/apple.md), [photos/google](photos/google/google.md), [places](places/places.md),
  [screen/coast](screen/coast/coast.md), [social/facebook](social/facebook/facebook.md),
  [social/instagram](social/instagram/instagram.md), [social/x](social/x/x.md), [stations](stations/stations.md),
  [upload](upload/upload.md), [voice/aqua-voice](voice/aqua-voice/aqua-voice.md),
  [voice/wispr-flow](voice/wispr-flow/wispr-flow.md).
<!-- /The connectors' pages -->

## The kinds

Every kind a reader states, with the connectors that state it. A family selects by product as well as kind.

<!-- The kinds: written by tools/connectors.ts, never by hand. -->
| Kind | Stated by |
|---|---|
| `activity` | google |
| `agent-turn` | claude-code, codex |
| `answer` | google-places |
| `app-focus` | screen-time |
| `ax` | coast |
| `business` | whatsapp |
| `call` | apple-calls, whatsapp |
| `camera` | cameras, devices |
| `catalog` | screen-time |
| `characteristic` | apple-health |
| `chat` | ask, chatgpt, claude, facebook, gmail, imessage, instagram, whatsapp |
| `chat-state` | imessage |
| `cluster` | faces |
| `comment` | facebook, github, instagram |
| `commit` | github |
| `contact` | apple-contacts |
| `cycle` | whoop |
| `day-summary` | apple-health |
| `details` | people |
| `dictation` | aqua-voice, wispr-flow |
| `directions` | google |
| `dose` | apple-health |
| `download` | chrome |
| `energy` | energy |
| `event` | apple-calendar, google-calendar |
| `face` | people |
| `faces` | faces |
| `file` | upload |
| `fix` | location |
| `folder` | notes |
| `follow` | facebook, google, instagram |
| `frame` | coast, screen |
| `gap` | location |
| `group` | people |
| `hidden` | places |
| `image` | faces |
| `img` | apple-photos, camera, google-photos |
| `img-file` | apple-photos |
| `input` | input |
| `issue` | github |
| `like` | facebook, google, instagram, x |
| `machine-event` | machine |
| `mailmsg` | gmail |
| `maybe` | faces |
| `medication` | apple-health |
| `mic-recording` | audio |
| `model-image` | faces |
| `month` | groups |
| `motion` | motion |
| `msg` | ask, chatgpt, claude, facebook, google, imessage, instagram, whatsapp, x |
| `named` | faces |
| `note` | apple-notes, granola, notes |
| `now-playing` | now-playing |
| `page-visit` | chrome, google, safari |
| `path` | google-timeline |
| `person` | people |
| `photo` | cameras, people |
| `physio-day` | whoop |
| `place` | places |
| `place-view` | google |
| `place-visit` | google-timeline |
| `play` | spotify |
| `post` | facebook, instagram, x |
| `pr` | github |
| `prompt` | checkin |
| `pushname` | whatsapp |
| `recorder` | apple-health, apple-photos, location, motion, screen, screen-time |
| `recovery` | whoop |
| `reminder` | apple-calendar, apple-reminders |
| `report` | checkin |
| `review` | github |
| `sample` | apple-health, motion, whoop |
| `sample-uuid` | apple-health |
| `scan` | faces |
| `search` | chrome, google |
| `session` | coast |
| `sleep` | whoop |
| `sleep-stages` | whoop |
| `sound-recording` | audio |
| `state-of-mind` | apple-health |
| `story` | facebook, instagram |
| `tab` | safari, stations |
| `tombstone` | safari |
| `transcript` | granola |
| `trip` | google-timeline |
| `usage` | screen-time |
| `usage-event` | screen-time |
| `vigilance` | checkin |
| `visit` | places |
| `voice` | voice-notes |
| `watch` | google |
| `workout` | apple-health, whoop |
<!-- /The kinds -->

## The report

End your report with **Skill feedback**: what this page lacked, got wrong, or made slow, each with the line it should
change.
