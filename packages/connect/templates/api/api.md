# Example (api template)

The `api` kind's template (packages/connect/SKILL.md, "api"): a provider's API, which the home polls with a key the
person makes. Here a synthetic provider, Example, and its notes. `lifestream connectors new api <id>` copies this
folder; every name here is the copy's to change. As copied, it passes every case of `lifestream connectors test`.

Source: `example:<account>:cloud`, the account the sign-in's check states (`GET /v1/me`, its `email`). Acquirer and
reader: `example-api`.

The check is one GET (`check: { url, account }` in `connector.ts`), the key sent as `Authorization: Bearer`. For a link
that is its own credential (a published calendar's secret address), `url: "{credential}"`, the whole url: the check
asks the link as typed, an https address, with no header and no redirect followed. `{credential}` stands nowhere else in
a `url`; a provider that takes its key in a part of the address checks in code (the module's `signins`). Where the
answer is no JSON (a calendar's text), leave out `account`: the account is the field the person types beside it.

The notes family reads each note (`adapter.ts`): its title, and its text under it.
It prints the note's line on its day and gives search its words. A copy whose records are no notes gives its own
type's family's adapter, by that family's contract (`packages/core/inputs/<family>.ts`), or a plain line (below).

| Kind | Key | Content | Time |
|---|---|---|---|
| `note` | Example's `id` | `type: "example.note"` and every member Example states | `created_at` to `updated_at` (an instant when not edited) |

- **The factory** takes `AcquirerSettings<ExampleApiFields>` (the connector's fields as they run, and the home's
  `work`, `zone` and `unit`) and `Dependencies` (`fetch`, `now`, `sleep`). The home builds it with its settings alone,
  so each dependency is the real one where absent; a proof hands the fake's `fetch` and its own clock. Every request
  goes through the SDK's `request` with that `fetch`, never a `fetch` of its own: the proof answers no other.
- **What is new** is the listing `GET /v1/notes?updated_since=<ms>`, inclusive, walked by its page token. The cursor
  keeps the instant; the poll's memory keeps the ids sealed at it (part `at-instant`), and a walk under way the ids at
  the newest instant it sealed (part `at-newest`, the instant in the cursor): how many notes share one instant is
  Example's to say, so a cursor stays one size however many there are, a walk cut short forgets nothing it sealed, and
  nothing new seals nothing.
- **History** is one page a call of `updated_before=<first call>`, at or after the stream's start (`lent.start_ms`);
  `left` is Example's `remaining`. The cursor keeps no start: a start moved earlier than the one the cursor was left
  under (`lent.from_ms`) walks again from the top, or, once the walk ended, reads `updated_before=<from_ms>`, the gap
  alone; a start moved under a walk begins its pages again; whichever call, fetch or page, sees the move first does it
  (`historyUnder`).
- **Stops** come from the request loop (shared/http.ts): a 429 is `provider-limit`, a 401 `signed-out`, the call's
  budget `more`; what finished is sealed first.
- **Its fields** are the person's, set once installed in the Lifestream app's Streams, or by `lifestream connectors set
  example-api account <email> key <its secret's name>`: fields that change together go in one `set`; each call polls
  at once.
- **Removals:** Example's listing states none, so the copy states none; a provider that answers its whole set each time
  states a deletion by leaving an item out, diffed against the poll's memory.
- A note file is a part: one that does not read, or holds another note, is refused alone.

## The proof's fakes

`test/fixture.ts` exports what `lifestream connectors test` runs the acquirer against, importing the SDK alone:
`settings` (the fields it is built with), `secrets` (what each secret holds), `provider(scenario)` (a fetch handler,
`(request: Request) => Response`, answering Example's addresses over a scenario's notes), `item` (`ItemOf`: which note
of the scenario a record the acquirer landed is, by its kind and key, null for one no item makes) and `fixtures` (the
reader's delivery, for the conformance run). A `Scenario` says how many items the source holds, how many it held before the run
(`old`, which come only through history), which were edited and which removed, and when the run starts (`start_ms`).
The proof's first fetch meets the old items alone, then the rest are added: an item is old or new by that, never by the
time its record states, so a record dated by its day or by when it is due passes as any other. Each walk is read by
which items it landed, as `item` names them, never by how many: a fetch that lands the old items where the new were owed
fails. A copy changes `provider` to answer its own provider's addresses and shapes, for any scenario, and `item` to read
its own keys.

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

and in `index.ts`, `adapters: { "example-api": { line } }`. A line may carry `title`, which the day prints before
`text` (`<title>: <text>`), `who` (the people it names) and `link` (its page at the provider). A record's kind
is `record.version.kind`, beside its `content`.
