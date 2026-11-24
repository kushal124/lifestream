# Example (oauth template)

The `oauth` kind's template (packages/connect/SKILL.md, "oauth"): a provider's API, which the home polls signed in with
an OAuth client the person makes at the provider. Here a synthetic provider, Example, and its notes. `lifestream connectors new oauth <id>` copies this folder; every name here is the copy's to change. As
copied, it passes every case of `lifestream connectors test`.

Source: `example-oauth:<account>:cloud`, the account the sign-in's check states (`GET /v1/me`, its `email`). Acquirer and
reader: `example-oauth`.

The notes family reads each note (`adapter.ts`): its title, and its text under it.
It prints the note's line on its day and gives search its words. A copy whose records are no notes gives its own
type's family's adapter, by that family's contract (`packages/core/inputs/<family>.ts`), or a plain line (below).

| Kind | Key | Content | Time |
|---|---|---|---|
| `note` | Example's `id` | `type: "example.note"` and every member Example states | `created_at` to `updated_at` (an instant when not edited) |

- **Open in Example:** a note's page, `open.record` in `connector.ts`, filled from its key (and `{account}`, the source's
  account, or `{content.<path>}`, a value its content states) by the home; `test` prints each record's. A record of any family, an event or a task as much as a note,
  opens by its connector's template; an adapter states no link that opens it.
- **The sign-in** is the person's own client (`clients` in `index.ts`: Example's authorize and token addresses, and the
  steps the person takes before the first sign-in). Its credential is sealed whole under the `signin` field's secret:
  the client, the token endpoint, the refresh and access tokens, when the access token expires.
- **Every request** goes through the SDK's `request` with the `fetch` the factory was handed and
  `refresher: clientRefresher("Example")`: the loop sends the access token, refreshes it when it is about to expire or
  once past a 401, and seals the answer at once, a rotated refresh token included. A refresh Example refuses
  (`invalid_grant`) is signed out: the person signs in again. The acquirer never reads a token itself.
- **The factory** takes `AcquirerSettings<ExampleOauthFields>` and `Dependencies` (`fetch`, `now`, `sleep`), as `api`'s
  does: the home builds it with its settings alone, a proof hands the fake's `fetch` and its own clock.
- **What is new** is the listing `GET /v1/notes?updated_since=<ms>`, inclusive, walked by its page token. The cursor
  keeps the instant; the poll's memory keeps the ids sealed at it (part `at-instant`), and a walk under way the ids at
  the newest instant it sealed (part `at-newest`, the instant in the cursor), so a cursor stays one size, a walk cut
  short forgets nothing it sealed, and nothing new seals nothing.
- **History** is one page a call of `updated_before=<first call>`, at or after the stream's start (`lent.start_ms`);
  `left` is Example's `remaining`. The cursor keeps no start: a start moved earlier than the one the cursor was left
  under (`lent.from_ms`) walks again from the top, or, once the walk ended, reads `updated_before=<from_ms>`, the gap
  alone; a start moved under a walk begins its pages again; whichever call, fetch or page, sees the move first does it
  (`historyUnder`).
- **Stops** come from the request loop (shared/http.ts): a 429 is `provider-limit`, a 401 past the refresh
  `signed-out`, the call's budget `more`; what finished is sealed first.
- **Removals:** Example's listing states none, so the copy states none; a provider that answers its whole set each time
  states a deletion by leaving an item out, diffed against the poll's memory.
- A note file is a part: one that does not read, or holds another note, is refused alone.

## The proof's fakes

`test/fixture.ts` exports what `lifestream connectors test` runs the acquirer against, importing the SDK alone:
`settings`, `secrets` (the sign-in sealed as the `client` route seals it, `credentialText`), `provider(scenario)` (a
fetch handler answering Example's API over a scenario's notes and the client's token endpoint, which rotates the refresh
token at every refresh), `item` (`ItemOf`: which note of the scenario a record the acquirer landed is, by its kind and
key, which `test` reads each walk by) and `fixtures` (the reader's delivery, for the conformance run). A copy changes
`provider` to answer its own provider's addresses and shapes, for any scenario, its token endpoint included, and `item`
to read its own keys.

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

and in `index.ts`, `adapters: { "example-oauth": { line } }`. A line may carry `title`, which the day prints before
`text` (`<title>: <text>`), `who` (the people it names) and `link` (its page at the provider). A record's kind
is `record.version.kind`, beside its `content`.
