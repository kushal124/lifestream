import { describe, expect, it } from "vitest";
import { STATEMENTS_FILE } from "../shared/statements.js";
import { artifact, collect, deliver, openTestHome } from "../test/drive.js";
import { stationsHome, tabClaim } from "./reader.js";

const CLAIMS = "stations:local:macbook-pro-0001";
const FROM = 1_791_000_000_000;
const UNTIL = FROM + 11 * 60_000;
const claim = { station: "chrome-5550aa01", tab: 1001, errand: "e-0000aa01", from_ms: FROM, until_ms: UNTIL };
const good = tabClaim(claim);
const statements = (lines: unknown[]) => Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
const facts = { fetched_at: "2026-10-14T08:00:00.123Z", device: "stations" };

describe("the tabs the home's errands opened: each of these is impossible", () => {
  it("T1: a claim of another shape lands, refuses its neighbours, or is not named by its line", async () => {
    const home = openTestHome();
    const bad: [string, unknown][] = [
      ["a key of another tab", { ...good, key: `chrome-5550aa01:1002:${FROM}` }],
      ["a key of no shape", { ...good, key: "1001" }],
      ["a tab that is no id", tabClaim({ ...claim, tab: -1 })],
      ["no station's unit", tabClaim({ ...claim, station: "firefox-1" })],
      ["no errand's id", tabClaim({ ...claim, errand: "errand" })],
      ["a span backwards", tabClaim({ ...claim, until_ms: FROM - 1 })],
      ["a URL beside it", { ...good, content: { ...good.content, url: "https://app.errand.example/" } }],
      ["another type", { ...good, content: { ...good.content, type: "stations.window" } }],
      ["another kind", { ...good, kind: "window" }],
      ["content null", { ...good, content: null }],
    ];
    const refusals: Record<string, string> = {};
    for (const [name, line] of bad) {
      const delivery = deliver(home, CLAIMS, { [STATEMENTS_FILE]: statements([good, line]) }, facts);
      const rows = await collect(stationsHome.read(delivery, home.blobs));
      expect(rows.map((row) => row.refused === undefined), name).toEqual([true, false]);
      expect(rows[1]!.refused, name).toContain(`${STATEMENTS_FILE} line 2`);
      refusals[name] = rows[1]!.refused!;
    }
    artifact(home.dir, "refusals.json", refusals);
  });

  it("T2 T3: the door's line does not land, or lands without its whole span", async () => {
    const home = openTestHome();
    const restored = tabClaim({ ...claim, tab: 1002, errand: null });
    expect(await home.land(stationsHome, deliver(home, CLAIMS, { [STATEMENTS_FILE]: statements([good, restored]) }, facts))).toMatchObject({ new: 2, refused: 0 });
    const [head, other] = home.heads(CLAIMS);
    expect(head).toMatchObject({ key: `chrome-5550aa01:1001:${FROM}`, content: good.content, time: { start_ms: FROM, end_ms: UNTIL, precision: "ms" } });
    expect(other).toMatchObject({ key: `chrome-5550aa01:1002:${FROM}`, content: { errand: null } });
    artifact(home.dir, "claim.json", [head, other]);
  });
});
