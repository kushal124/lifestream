# Example (folder template)

The `folder` kind's template (packages/connect/SKILL.md, "folder"): files in a folder the person picks on the home's
Mac, which the home polls as they change. Here a synthetic app, Example, and its notes folder. `lifestream
connectors new folder <id>` copies this folder; every name here is the copy's to change. As copied, it passes
`lifestream connectors test`, which lands its fixture to a day and runs the poll over its `files(scenario)` written in
a scratch folder: every file lands, nothing seals again (nor with every file touched), an edit lands one new version, a
deleted file goes gone, and the cursor stays one size as the folder grows. `lifestream connectors preview example-folder
--set folder=<full path>` runs it once over a real folder, into a scratch home, before install.

Source: `example-folder:local:<unit>`, the home's own Mac. Acquirer and reader: `example-folder`. The person picks
the folder in the connector's settings (the Mac's folder panel), or `lifestream connectors set example-folder folder <full
path>`; the stream polls it every 5 minutes.

The notes family reads each note (`adapter.ts`): its title, the file's name, and
its text under it. It prints the note's line on the day it was written, or a created line and an edited line on their
days, and gives search its words. A copy whose files are no notes gives its own type's family's adapter, by that
family's contract (`packages/core/inputs/<family>.ts`), or a plain line (below).

| Kind | Key | Content | Time |
|---|---|---|---|
| `note` | the file's path in the folder | `type: "example.note"`, `path`, `text` (the file, as UTF-8) | from when the file was made to when it was last written |

## The folder is on the home's Mac

The poll runs in the home's process, on the Mac that keeps the home: a folder on another Mac or a phone is out of its
reach (that is a `mac-app` store, which the Mac app ships from each Mac). An external drive or a network volume serves
while it is connected. A file is stated gone only from a whole walk: a poll that finds no folder, that cannot list a
folder in it or read a file it listed (a drive unplugged part way), or that finds the folder holding no note while it
held some (a stale mount point, a sync client signed out) fails, named, and states no file gone. A folder emptied for
real has its notes stated gone once it holds a note again.

The home may read a folder macOS protects, under `~/Documents`, `~/Desktop` or iCloud Drive: the home runs as a job of
the Lifestream app, and the app holds Full Disk Access. With that grant taken back, the poll fails, saying where to
allow it again. A file iCloud took off the Mac (its `.<name>.icloud` in its place) is still there: neither read nor
gone, until it is downloaded again.

## The poll

`acquirer.ts` walks the folder whole at each poll. Names beginning with `.` (an app's own folder, `.trash`) and links
are passed over, and so is every file but those the reader reads (`NOTES`, `.md` here: a copy names its own).

- **What changed** is held in the poll's memory, never the cursor (part `file`, by path: size, write time, SHA-256). A
  file whose size and write time are as remembered is not read; one touched with the same bytes is remembered anew and
  sealed nothing. The cursor is `{}`: it is the same at ten files and ten thousand.
- **A delivery** is `folder.json` and each changed file as itself at `files/<n>`, which the home copies in, streamed.
  The manifest names each file's path and when it was made and last written (`created`, `modified`), and the paths
  `gone` since the last poll. A path never names a delivery's file, so any name the Mac allows reads.
- **The bound** is 500 files or 64 MiB a call, then `more`: the home calls again at once, and the walk passes over
  what was sealed. A first poll of a large folder is a few deliveries in a row.
- **A deleted file** is a path the memory holds that the walk no longer finds: stated gone, and forgotten. A renamed
  file is its old path gone and its new path new; a moved folder keeps its notes' keys, which are paths inside it. A
  folder deleted inside the picked one takes its notes with it, through the next whole listing of the folder that held
  it.
- **The start** (`lent.start_ms`) is the stream's: files last written before it wait until the person moves it
  earlier, when the next walk reads them, or until they are written again. Unset, it is the home's start.

## The reader

- `folder.json` is what the delivery rests on: a delivery without one, or one that names a file it does not hold, is
  refused.
- Each file is a part (`each`): one that does not read as UTF-8 is refused alone, its path named.
- The time is the file's own: made to last written, or one instant where they are the same. A copy whose files state
  their own time (a front matter `date`, a file named by its day) reads it from the text instead.
- **A CSV file** reads with `csvRows(chunks, where)`: rows one at a time, fields by header name. **An iCalendar file**
  reads with `ics.parseCalendar(bytes, where)`. Each is a part too.

## The proof's fakes

`test/fixture.ts` exports, importing the SDK alone: `files` (`(scenario) => Files`, the folder by its paths for a
scenario: each item a note, an edited one changed, a removed one absent), `item` (`ItemOf`: which note of the scenario a
record the poll landed is, here by its path, which `test` reads each walk by) and `fixtures` (a delivery as the poll
seals one, for the reader's proof). A copy changes all three to its own files' shape. The poll dates a note by when its file was
last written, so each file is `{ bytes, modified_ms }`: the scenario's first `old` before `scenario.start_ms`, four hours
apart, so the start `test` lends falls among them, the rest from it, an edited one later than before (`noteWritten`), which
puts each on the day a person's would fall on. A file with no `modified_ms` (its text, its bytes, or `{ bytes }`) is
written when `test` writes it, after every start, so a copy whose files state none runs no case of the start. The proof tells old from new
by which files the folder held at its first fetch (the scenario's first `old`), never by their times; `lands new` says
how many files `files` wrote where they are more than its items (an app's own files the poll passes over).

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
    const content = record.version.content as { path?: unknown };
    return typeof content.path === "string" ? { text: content.path.replace(/\.md$/iu, "") } : null;
  },
};
```

and in `index.ts`, `adapters: { "example-folder": { line } }`. A line may carry `title`, which the day prints before
`text` (`<title>: <text>`), `who` (the people it names) and `link` (its page at the provider). A record's kind
is `record.version.kind`, beside its `content`.
