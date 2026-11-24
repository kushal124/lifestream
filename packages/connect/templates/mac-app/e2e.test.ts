import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { artifact, deliver, openTestHome, temp, type TestHome } from "../../test/drive.js";
import { exampleMacApp } from "./reader.js";
import { createStore, NOTES, SOURCE, T0, type StoredNote } from "./test/fixture.js";

function store(home: TestHome, notes: readonly StoredNote[], options: Parameters<typeof createStore>[2] = {}) {
  const path = join(temp(), "example.sqlite");
  createStore(path, notes, options);
  return deliver(home, SOURCE, { "example.sqlite": readFileSync(path) }, { snapshot_taken_at: "2026-09-10T12:00:00.000Z", kind: "snapshot" });
}

describe("example mac app: each of these is impossible", () => {
  it("a store lands other heads than its rows, or a note is timed by when it arrived", async () => {
    const home = openTestHome();
    const landed = await home.land(exampleMacApp, store(home, NOTES()));
    expect(landed).toMatchObject({ new: 2, refused: 0 });
    const heads = home.heads(SOURCE);
    expect(heads.map((head) => [head.key, head.start_ms, head.end_ms])).toEqual([
      ["N-0001", T0 * 1000, (T0 + 3600) * 1000],
      ["N-0002", (T0 + 86_400) * 1000, null],
    ]);
    expect(Object.keys((heads[0]!.content as { notes: object }).notes).sort()).toEqual(["body", "created", "id", "modified", "title"]);
    artifact(home.dir, "heads.json", heads);
  });

  it("a column the app adds makes a new version, an edit moves no head, or a row a later delivery leaves out goes", async () => {
    const home = openTestHome();
    await home.land(exampleMacApp, store(home, NOTES()));
    expect(await home.land(exampleMacApp, store(home, NOTES(), { extra: "color" }))).toMatchObject({ new: 0, changed: 0 });
    const [one] = NOTES();
    const edited = await home.land(exampleMacApp, store(home, [{ ...one!, body: "Synthetic body one, edited.", modified: T0 + 7200 }]));
    expect(edited).toMatchObject({ new: 0, changed: 1, gone: 0 });
    expect(home.heads(SOURCE).map((head) => [head.key, head.gone, head.end_ms])).toEqual([["N-0001", false, (T0 + 7200) * 1000], ["N-0002", false, null]]);
  });

  it("a store without a column the reader names lands a row, or a row whose time does not read costs another", async () => {
    const home = openTestHome();
    await expect(home.land(exampleMacApp, store(home, NOTES(), { without: "body" }))).rejects.toThrow(/lacks columns this connector reads: body/u);
    const unread = await home.land(exampleMacApp, store(home, [{ ...NOTES()[0]!, created: null }, NOTES()[1]!]));
    expect(unread).toMatchObject({ new: 1, refused: 1 });
    expect(home.heads(SOURCE).map((head) => head.key)).toEqual(["N-0002"]);
  });
});
