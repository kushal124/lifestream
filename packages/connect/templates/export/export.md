# Example (export template)

The `export` kind's template (packages/connect/SKILL.md, "export"): a download the person asks a provider for and hands
in, a zip, a folder or one file, read once each time it is handed in. Here a synthetic one, Example's notes.
`lifestream connectors new export <id>` copies this folder; every name here is the copy's to change. As copied, it
passes every case of `lifestream connectors test`.

Source: `example:<account>:export`, the account the download's own `account.json` names. Reader: `example-export`.
The person asks Example for the download (the guide's first step opens the page) and hands it in: dropped on the
"Example export" window on the Mac, or `lifestream import example-export <path>`. Either is read once: the same file
handed in again is "Already imported".

The notes family reads each note (`adapter.ts`): its title, and its text under it.
It prints the note's line on its day and gives search its words. A copy whose records are no notes gives its own
type's family's adapter, by that family's contract (`packages/core/inputs/<family>.ts`), or a plain line (below).

| Kind | Key | Content | Time |
|---|---|---|---|
| `note` | Example's `id` | `type: "example.note"` and every member the element states | `created_at`, RFC 3339 |

## The export

`connector.ts` declares `export: { recognise, guide }`, and nothing runs for it on a clock: there is no `acquirer.ts`.

- **`recognise`**: the member patterns a file of this export holds, `**/notes*.json` as copied. A pattern is a path in
  `/`-separated parts, `*` any run of a part's characters, `**` any number of whole parts, any case, matched under any
  leading folders: a file is this export when one pattern matches one of its members, a zip's, a folder's or a single
  file's own name. The Mac checks a file against them before it sends it; one that matches none is "not this export".
- **`guide`**: the window's steps, in order, each `{ title?, words, open?: { label, url } }`; at most one step has the
  button.
- Optional: `name` (the window's, "Example" where absent, the connector's name: the export is its only road), `takes`
  (its line while nothing is in, "Example sends a download you ask for"), `wait` (how long the provider takes, as a
  chip), `file` (the word for what is dropped, "zip" where absent), and `leaves`, member patterns the reader passes over knowingly (a read-me PDF): those hold no
  file back from being let go once read.

**The account's shape** is where the export names it: the reader's `account`, which the home reads off the file's
members before any row. Its `file` is a pattern too; its reading answers the account, or nothing (`undefined`), or
`refuse`s in the person's words, which refuses the whole file as not this export.

- a JSON member (as copied): `account: { file: "account.json", json: (json) => … }`, handed it parsed; in a member of
  any size, only the values at a path (`jsonAt`'s), streamed and the rest never read: `account: { file: "result.json",
  at: "personal_information", json: (info) => … }` (Telegram's 500 MB `result.json`);
- a CSV member: `account: { file: "profile.csv", row: (fields) => fields.Username }`, handed each row after the header
  by the header's names, until one answers;
- any other text (XML, HTML, a plain line): `account: { file: "account.xml", text: (text) => … }`, handed it whole.

An export that names no account (a single chat's export, a bank statement that states none) declares no `account`: the
home asks whose it is once the file is in ("Whose Example is this?"), offering the accounts of the company it knows, and
`lifestream import <id> <path> --account <account>` answers it before it is asked. Two members naming two accounts are
asked too. An answer is spelled once (trimmed, an email lowercased); one holding a colon, slash, backslash or space
cannot name a source.

**The export's time** is when the home took it in, unless the reader states it from the provider's own evidence:
`states(members, anchor)`, returning `{ time_ms }` (the newest item's time the export holds) and, where its source keeps
one, `anchor`, what a later export of the same account must restate (Spotify's first play): handed the anchor the
source keeps, it `refuse`s an export that does not restate it. A file's modification time is never a time of anything.

## The reader

- The download arrives as the person handed it: its zip, or its folder's files under the folder's name. The reader
  reads its members by their names under any folder (`archive`), never the zip's name.
- `account.json` must name the source's account: another account's download, two downloads in one delivery, or a
  delivery with none, is refused whole.
- A notes file, and each note in it, is a part (`each`): one that does not read is refused alone.
- **A CSV export** reads with `csvRows(member.chunks(), member.where)`: rows one at a time, fields by header name, a
  bad row refused alone under its spreadsheet row number. **An iCalendar export** (`.ics`) reads with
  `ics.parseCalendar(member.bytes(), member.where)`: its components with folded lines undone and its own `VTIMEZONE`s,
  each time read by `ics.timeValue` in its own zone, text by `ics.unescapeText`.

## The proof's fakes

`test/fixture.ts` exports what `lifestream connectors test` runs the folder against, importing the SDK alone: `files`
(`(scenario) => Files`, the download by its paths, which the proof hands in as one file, zipped, or as a folder), `item` (which item of the scenario a record is, by its kind and key: `note-007` is item 6)
and `fixtures` (the reader's delivery, for the ruined proof). `files` writes the scenario's items as the provider's
download holds them, each `edited` one changed and each `removed` one left out, as a newer download would: the proof
hands in the download, the same one again (nothing new lands), one with an item edited (that item alone lands a new
version) and one with an item gone (nothing else changes; a download that states its deletions, as a `deleted/`
folder, states it `gone`), printing what each changed of the day and search. An export that names no account
exports `settings`, `{ account: "<a fake account>" }`: the proof's answer to whose it is. A copy changes `download`, `files` and `item` to its own
provider's shape. A record its adapter reads as nothing on purpose (a browser's hidden redirect hop) is named in `export const
skipped = ["<kind> <key>"]`, as `test`'s search lines name it: `test` holds it to being read as nothing, and faults every
other record read as nothing, which a person would lose. It names some records of a connector's kind, never all of them: a
connector's kind the run landed only skipped records of faults, none of it reaching its family.

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

and in `index.ts`, `adapters: { "example-export": { line } }`. A line may carry `title`, which the day prints before
`text` (`<title>: <text>`), `who` (the people it names) and `link` (its page at the provider). A record's kind
is `record.version.kind`, beside its `content`.
