# Example (browser template)

The `browser` kind's template (packages/connect/SKILL.md, "browser"): a site the home reads through the person's
signed-in Chrome, no key and no export. Here a synthetic site, Example, and its notes. `lifestream connectors new
browser <id>` copies this folder; every name here is the copy's to change. As copied, it passes every case of
`lifestream connectors test`.

Source: `example:<account>:browser`, the account the probe (`GET /api/me`, its `id` and `email`) names. Acquirer and
reader: `example-browser`. The lane is shared/browser.ts's, over shared/site-lane.ts: this folder holds only the site's
recipe (who is signed in, the list, each note's read).

The notes family reads each note (`adapter.ts`): its title, and its text under it.
It prints the note's line on its day and gives search its words. A copy whose records are no notes gives its own
type's family's adapter, by that family's contract (`packages/core/inputs/<family>.ts`), or a plain line (below).

| Kind | Key | Content | Time |
|---|---|---|---|
| `note` | the site's `id` | `type: "example.note"` and every member the site states | `created_at`, RFC 3339 |

- **The site is asked of Chrome at Set up.** The home's sites come from `chrome.origin`: at Set up the person allows
  the site's host in Chrome, one Allow, and the extension needs no new build and no manifest change. Until it is
  given the stream says "Allow Lifestream on Example in Chrome" and its lane is tried again at the 5-minute retry,
  read within seconds once the extension reports the grant. `remove` and `install` leave Turn on as it is.
- **Signed out**, or asked for a password, the lane waits for its refresh clock rather than the retry, and is read
  again the moment the person's page on the site loads signed in.
- **Who is signed in.** `chrome.probe` names the request whose answer says who: `has` the member that is there only
  when signed in, `who` the members of the account's `id` and its `email`. The recipe's `begin` reads it (`whoIs`)
  and keeps the answer as `account.json`.
- **A site with no JSON sign-in** declares `probe: null`, and its `begin` says who itself: it reads the pages it needs
  through `pull` and returns the account, `{ id, email }` where the site shows an email, else `{ id, name }`, the name
  it greets the person by. Set up reads the same `begin` alone, so the person sees "Signed in to Example as …" before
  the first poll, and the stream's items and its poll are not touched. The home names the account by its email, else
  its name.
- **The factory** takes `AcquirerSettings` (the home's `work` above all) and `Dependencies`: the home builds it with its
  settings alone, a proof hands its own clock. Every request is the station's, through `pull`.
- The list (`/api/notes`, newest edit first, 50 a page) ends at the stream's start (`lent.start_ms`); each note is
  read from `/api/notes/<id>`. A start moved earlier than the one the lane's cursor was left under (`lent.from_ms`) lists
  the whole history again, so the notes the old start left out are read.
- The lane keeps where it stands with each account and what it read of each note in the poll's memory (`lent.memory`,
  shared/browser.ts), never in the cursor, which a recipe never sees: the list asks `known(id)` of a note when it would end
  at what the lane holds unchanged, and is never handed the history.
- `account.json` must name the source's account: the whole delivery rests on it. A note file is a part: one that does
  not read, or holds another note, is refused alone.

## The proof's fakes

`test/fixture.ts` exports what `lifestream connectors test` runs the lane against, importing the SDK alone: `settings`
and `secrets` (none: Chrome is the sign-in), `site(scenario)` (the SDK's `Site`, which the in-memory station answers
every request of the page from), `item` (`ItemOf`: which note of the scenario a record the recipe landed is, by its kind
and key, which `test` reads each walk by) and `fixtures` (the reader's delivery, for the conformance run). A `Scenario` says how
many items the site holds, how many it held before the run (`old`, which come only through history), which were edited
and which removed, and when the run starts (`start_ms`). The proof's first fetch meets the old items alone, then the
rest are added: an item is old or new by that, never by the time its record states, so an order dated by its day passes
as any other. A copy changes `site` to answer its own site's requests and, where its recipe reads pages, its pages
(`page(url)`), for any scenario, and `item` to read its own keys: a string body is sent as its text (a page's HTML), any other value as its JSON. A fake
site is a class with its fields declared, as every file of a folder is TypeScript a home runs with its types erased.

## No family fits: state a line

Where no family reads the copy's records, its adapter states a plain line and the plain family prints it on the day,
at the record's own time and precision. In `adapter.ts`, in place of `notes`:

```ts
import type { InputRecord, Line, LineAdapter } from "@lifestreamprotocol/connect/sdk";
import { NOTE } from "./reader.js";

/** A record as the day says it: its words, and what a search finds it by. Bump `version` when the line changes. */
export const line: LineAdapter = {
  version: "1", kinds: [NOTE],
  line: (record: InputRecord): Line | null => {
    const content = record.version.content as { title?: unknown };
    return typeof content.title === "string" && content.title !== "" ? { text: content.title } : null;
  },
};
```

and in `index.ts`, `adapters: { "example-browser": { line } }`. A line may carry `title`, which the day prints before
`text` (`<title>: <text>`), `who` (the people it names) and `link` (its page at the site). A record's kind
is `record.version.kind`, beside its `content`.
