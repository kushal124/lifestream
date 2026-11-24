# Example (mac-app template)

The `mac-app` kind's template (packages/connect/SKILL.md, "mac-app"): a Mac app's own store, its SQLite files, which
the Mac app ships from each Mac the person allows it on. Here a synthetic app, Example, and its notes.
`lifestream connectors new mac-app <id>` copies this folder; every name here is the copy's to change. As copied, it
passes every case of `lifestream connectors test`.

Source: `example:<account>:<unit>`, the app's account on one Mac, the address its `account.json` states. Reader:
`example-mac-app`. No acquirer: the Mac's one store shipper reads the store this folder declares (`store.ts`, the
connector's `mac.store`) as data: which files the Mac reads, whose account they
are, and which tables it ships. The declaration states no `refresh`, and its `backfill` says what it collects
(`about`): the Mac reads the store from the stream's start, its rows dated before it left out.

The notes family reads each note (`adapter.ts`): the row's title, and its body
under it. It prints the note's line on its day and gives search its words. A copy whose records are no notes gives its
own type's family's adapter, by that family's contract (`packages/core/inputs/<family>.ts`), or a plain line (below).

| Kind | Key | Content | Time |
|---|---|---|---|
| `note` | the row's `id` | `type: "example.note"`, `notes`: the columns the reader names (`id`, `title`, `body`, `created`, `modified`) | `created` to `modified`, Unix seconds (an instant when not edited) |

## The person allows it, on each Mac

- **Nothing of the store is read until the person allows it.** A store the release was not built with is held on each
  Mac until the person answers the Mac app's own sheet, which names the stream and every path it reads. Set up in the
  home's page asks for it (`store:<id>`); the sheet shows on the Mac, and the answer is kept on that Mac alone. The home
  cannot allow a store, and no answer of the home's carries one. A second Mac asks again.
- **A store's paths are fixed.** `held`, `account.json` and every `path` are the places the app itself keeps its files,
  under `~`: never a field the person sets. An `<account>` in a path is the one thing filled in, from the store's own
  account rule. A folder the person picks is the `folder` kind's.
- **A changed declaration asks again.** The answer is kept under the declaration's digest: one character changed in
  `store.ts` (a path, a table, a column) is another store, held until the person allows it once more, and the sheet
  shows the paths that are new. Once allowed again, the file ships whole under the new declaration.
- **Only the declared tables ship.** The member holds the tables `store.ts` names and nothing else of the file: a table,
  index or view it does not name is left out, so a store of many tables ships the size of its declared rows. So the
  reader reads only the tables `store.ts` declares: one it names that is not declared meets "no such table".

## The reader

- The delivery is `example.sqlite`: the rows that changed, or every row. A row missing from a delivery is never gone.
- Only the columns named in `columns` are copied: `sync_token`, the app's bookkeeping, is left out, and a column a later
  version of the app adds changes no version until a release names it.
- A store without a named column is refused whole; a row whose `created` does not read is refused alone.

## The proof's fixture

`test/fixture.ts` imports the SDK alone and exports `fixtures`, the reader's delivery (the store whole, as the Mac
ships it), for the conformance run. No acquirer runs, so no fake: the Mac's shipper is the release's, proven by its
own tests. A record its adapter reads as nothing on purpose (a browser's hidden redirect hop) is named in `export const
skipped = ["<kind> <key>"]`, as `test`'s search lines name it: `test` holds it to being read as nothing, and faults every
other record read as nothing, which a person would lose. It names some records of a connector's kind, never all of them: a
connector's kind the run landed only skipped records of faults, none of it reaching its family. A browser's stream counts its records unless
its connector says `counted_by: "web"` (the web family's pages, as Chrome's): a skipped hop's search line says when the
stream counts it too.

## No family fits: state a line

Where no family reads the copy's records, its adapter states a plain line and the plain family prints it on the day,
at the record's own time and precision. In `adapter.ts`, in place of `notes`:

```ts
import { isObject, type InputRecord, type Line, type LineAdapter } from "@lifestreamprotocol/connect/sdk";
import { NOTE } from "./reader.js";

/** A record as the day says it: its words, and what a search finds it by. Bump `version` when the line changes. */
export const line: LineAdapter = {
  version: "1", kinds: [NOTE],
  line: (record: InputRecord): Line | null => {
    const content = record.version.content;
    const row = isObject(content) ? content.notes : undefined;
    return isObject(row) && typeof row.title === "string" && row.title !== "" ? { text: row.title } : null;
  },
};
```

and in `index.ts`, `adapters: { "example-mac-app": { line } }`. A line may carry `title`, which the day prints before
`text` (`<title>: <text>`), `who` (the people it names) and `link` (its page at the provider). A record's kind
is `record.version.kind`, beside its `content`.
