# Example OAuth (a proof connector)

A home connector of the proof, the `oauth` template's folder: a synthetic
provider, Example, whose notes the home polls through its API, signed in to with an OAuth client the person makes at
Example (the `client` way). No provider of this name exists, and no release holds this folder.

Source: `example-oauth:<account>:cloud`, the account the sign-in's check states (`GET /v1/me`, its `email`). Acquirer and
reader: `example-oauth`. The notes family reads each note (adapter.ts): its title, and its text under it.

| Kind | Key | Content | Time |
|---|---|---|---|
| `note` | Example's `id` | `type: "example.note"` and every member Example states | `created_at` to `updated_at` (an instant when not edited) |

- **Every request** goes through the SDK's `request` with the `fetch` the factory was handed and
  `refresher: clientRefresher("Example")`: the credential sealed under the `token` field's secret is sent, refreshed at
  the client's token endpoint when it is about to expire or once past a 401, and sealed again at once, a rotated refresh
  token included. A refresh Example refuses is signed out.
- **What is new** is the listing `GET /v1/notes?updated_since=<ms>`, inclusive, walked by its page token; the cursor
  keeps the instant, the poll's memory the ids sealed at it (`at-instant`) and those a walk under way sealed at its
  newest (`at-newest`), so a cursor stays one size and nothing new seals nothing.
- **History** is one page a call of `updated_before=<first call>`, at or after the stream's start (`lent.start_ms`);
  `left` is Example's `remaining`. The cursor keeps no start: a start moved earlier than the one the cursor was left
  under (`lent.from_ms`) walks again from the top, or, once the walk ended, reads `updated_before=<from_ms>`, the gap
  alone; a start moved under a walk begins its pages again; whichever call, fetch or page, sees the move first does it
  (`historyUnder`).
- **Stops** come from the request loop (shared/http.ts): a 429 is `provider-limit`, a 401 past the refresh
  `signed-out`, the call's budget `more`; what finished is sealed first.
- `test/fixture.ts` holds the proof's fakes, as the template's do: `settings`, `secrets` (a sealed sign-in) and
  `provider(scenario)`, which answers the API and the client's token endpoint.
- A note file is a part: one that does not read, or holds another note, is refused alone.
