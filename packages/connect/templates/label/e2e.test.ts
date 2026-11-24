import { describe, expect, it } from "vitest";
import type { LabelOutput } from "../../labeler.js";
import type { Reader } from "../../seams.js";
import { artifact, deliver, fetchedBytes, openTestHome, type TestHome } from "../../test/drive.js";
import { exampleLabelLabeler } from "./labeler.js";
import { exampleLabel } from "./reader.js";
import { SOURCE, UNIT } from "./test/fixture.js";

const NOTES = "notes-test";
const held: Reader = { name: NOTES, kinds: { note: () => [] }, read: async function* () {} };
const note = (key: string, at: string) => ({ kind: "note", key, content: { text: `synthetic ${key}` }, time: { start_ms: Date.parse(at), precision: "ms" as const } });

async function run(home: TestHome): Promise<LabelOutput | null> {
  const labeler = exampleLabelLabeler({ unit: UNIT });
  const view = home.db.view();
  let output: LabelOutput | null;
  try {
    output = await labeler.label(view, home.blobs, { seq: 0, reread: 0 });
  } finally {
    view.close();
  }
  if (output !== null) {
    const files = Object.fromEntries(output.files.map((file) => [file.path, fetchedBytes(file)]));
    await home.land(exampleLabel, deliver(home, SOURCE, files, output.facts, Date.parse("2026-10-01T00:00:00.000Z")));
  }
  return output;
}

describe("example label: each of these is impossible", () => {
  it("a month counts notes of another month or of its own source, a run with nothing new states anything, or a month left unheld stays", async () => {
    const home = openTestHome();
    const [a, b] = ["example:person-a@example.com:cloud", "example:person-a@example.com:export"];
    const at = Date.parse("2026-09-15T00:00:00.000Z");
    await home.land(held, deliver(home, a, {}, {}, at), [note("n1", "2026-08-03T10:00:00Z"), note("n2", "2026-09-01T10:00:00Z")]);
    await home.land(held, deliver(home, b, {}, {}, at), [note("n3", "2026-08-20T10:00:00Z")]);
    expect(await run(home)).not.toBeNull();
    const heads = home.heads(SOURCE);
    expect(heads.map((head) => [head.key, head.content, head.start_ms])).toEqual([
      ["2026-08", { notes: 2 }, Date.parse("2026-08-01T00:00:00.000Z")], ["2026-09", { notes: 1 }, Date.parse("2026-09-01T00:00:00.000Z")],
    ]);
    expect(await run(home)).toBeNull();
    await home.land(held, deliver(home, a, {}, {}, at + 1), [{ kind: "note", key: "n2", content: null, gone: true }]);
    await run(home);
    expect(home.heads(SOURCE).map((head) => [head.key, head.gone])).toEqual([["2026-08", false], ["2026-09", true]]);
    artifact(home.dir, "heads.json", home.heads(SOURCE));
  });
});
