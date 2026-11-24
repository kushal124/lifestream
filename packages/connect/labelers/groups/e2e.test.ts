import { describe, expect, it } from "vitest";
import type { LabelOutput } from "../../labeler.js";
import { Refused } from "../../shared/index.js";
import { artifact, collect, deliver, fetchedBytes, openTestHome, type TestHome } from "../../test/drive.js";
import { GROUPS_FILE, groupsConnector, groupsLine } from "./reader.js";
import { groupsLabeler, type GroupRow, type PreparedGroups } from "./labeler.js";

const UNIT = "macbook-pro-0001";
const SOURCE = `groups:local:${UNIT}`;
const NOW = Date.parse("2026-10-20T12:00:00Z");
const FRIENDS = "whatsapp:120363000000000011@g.us";
const SHOP = "whatsapp:120363000000000012@g.us";
const FAMILY = "imessage:+15550000004,person-e@example.com";
const record: Record<string, string[][]> = {};

let sealed = 0;
function bench(name: string, perRun?: number) {
  const home = openTestHome("groups-");
  const prepared: { now: PreparedGroups | undefined } = { now: undefined };
  const labeler = groupsLabeler({ unit: UNIT, rows: () => prepared.now, ...(perRun === undefined ? {} : { perRun }) });
  const runs: string[][] = (record[name] = []);
  const since = { seq: 0, reread: 0 };
  return {
    home,
    people(changed: string, groups: Record<string, GroupRow>) {
      prepared.now = { changed, groups: new Map(Object.entries(groups)) };
    },
    async run(): Promise<LabelOutput | null> {
      const view = home.db.view();
      let pending: Promise<LabelOutput | null>;
      let through: number;
      try {
        through = view.through;
        pending = labeler.label(view, home.blobs, { ...since });
      } finally {
        view.close();
      }
      since.seq = through;
      const output = await pending;
      if (output === null) return null;
      const [file] = output.files;
      runs.push(fetchedBytes(file!).toString("utf8").trimEnd().split("\n"));
      expect(output.facts.sources).toEqual([{ id: SOURCE, connector: "groups" }]);
      await home.land(groupsConnector, deliver(home, SOURCE, { [GROUPS_FILE]: fetchedBytes(file!) }, output.facts, NOW + ++sealed));
      return output;
    },
    months(home_ = home): Record<string, unknown> {
      return Object.fromEntries(home_.heads(SOURCE, ["month"]).filter((head) => !head.gone).map((head) => [head.key, head.content]));
    },
  };
}

const friends: GroupRow = { yours: [["2026-08-20", "2026-11-17"]], first_day: "2026-08-03", last_day: "2026-10-19" };
const shop: GroupRow = { yours: [], first_day: "2026-09-30", last_day: "2026-10-02" };
const family: GroupRow = { yours: [["0000-01-01", "9999-12-31"]], first_day: "2026-10-01", last_day: "2026-10-01" };

describe("the groups labeler", () => {
  it("M1, M2: it states nothing before People, then every group's every month cut to it, restates only what changed, and puts back a month stated behind its back", async () => {
    const b = bench("months");
    expect(await b.run()).toBeNull();
    b.people("10", { [FRIENDS]: friends, [SHOP]: shop, [FAMILY]: family });
    const first = await b.run();
    expect(first!.facts).toMatchObject({ months: 6, owed: 0 });
    expect(b.months()).toEqual({
      [`${FAMILY}:2026-10`]: { yours: [["2026-10-01", "2026-10-31"]] },
      [`${FRIENDS}:2026-08`]: { yours: [["2026-08-20", "2026-08-31"]] },
      [`${FRIENDS}:2026-09`]: { yours: [["2026-09-01", "2026-09-30"]] },
      [`${FRIENDS}:2026-10`]: { yours: [["2026-10-01", "2026-10-31"]] },
      [`${SHOP}:2026-09`]: { yours: [] },
      [`${SHOP}:2026-10`]: { yours: [] },
    });
    expect(await b.run()).toBeNull();
    expect(await b.run()).toBeNull();
    b.people("11", { [FRIENDS]: { yours: [["2026-08-20", "2027-01-16"]], first_day: "2026-08-03", last_day: "2026-11-02" }, [SHOP]: shop, [FAMILY]: family });
    const second = await b.run();
    expect(second!.facts).toMatchObject({ months: 1, owed: 0 });
    expect(record.months!.at(-1)).toEqual([groupsLine(`${FRIENDS}:2026-11`, { yours: [["2026-11-01", "2026-11-30"]] })]);
    expect(await b.run()).toBeNull();
    expect(await b.run()).toBeNull();
    await b.home.land(groupsConnector, deliver(b.home, SOURCE, { [GROUPS_FILE]: Buffer.from(`${groupsLine(`${SHOP}:2026-10`, { yours: [["2026-10-01", "2026-10-31"]] })}\n`) }, {}, NOW + ++sealed));
    const third = await b.run();
    expect(third!.facts).toMatchObject({ months: 1, owed: 0 });
    expect(record.months!.at(-1)).toEqual([groupsLine(`${SHOP}:2026-10`, { yours: [] })]);
    expect(b.months()[`${SHOP}:2026-10`]).toEqual({ yours: [] });
    expect(await b.run()).toBeNull();
  });

  it("M3: a month a group no longer has, or a group gone, keeps its head", async () => {
    const b = bench("gone");
    b.people("10", { [FRIENDS]: friends, [SHOP]: shop });
    await b.run();
    b.people("11", { [FRIENDS]: { ...friends, first_day: "2026-09-02", yours: [["2026-09-02", "2026-11-17"]] } });
    const output = await b.run();
    expect(output!.facts).toMatchObject({ months: 4, owed: 0 });
    expect(record.gone!.at(-1)).toEqual([
      groupsLine(`${FRIENDS}:2026-09`, { yours: [["2026-09-02", "2026-09-30"]] }),
      groupsLine(`${FRIENDS}:2026-08`, "gone"), groupsLine(`${SHOP}:2026-09`, "gone"), groupsLine(`${SHOP}:2026-10`, "gone"),
    ]);
    expect(Object.keys(b.months()).sort()).toEqual([`${FRIENDS}:2026-09`, `${FRIENDS}:2026-10`]);
  });

  it("M4: a run stopped at its bound, or a home stopped before the run, loses a month: the next run states it", async () => {
    const b = bench("bound", 2);
    b.people("10", { [FRIENDS]: friends, [SHOP]: shop, [FAMILY]: family });
    const runs: unknown[] = [];
    for (let output = await b.run(); output !== null; output = await b.run()) runs.push(output.facts.owed);
    expect(runs).toEqual([4, 2, 0]);
    expect(Object.keys(b.months())).toHaveLength(6);
    const fresh = groupsLabeler({ unit: UNIT, rows: () => ({ changed: "12", groups: new Map(Object.entries({ [FRIENDS]: friends, [SHOP]: { ...shop, yours: [["2026-10-02", "2026-12-30"]] }, [FAMILY]: family })) }) });
    const view = b.home.db.view();
    let pending: Promise<LabelOutput | null>;
    try {
      pending = fresh.label(view, b.home.blobs, { seq: 0, reread: 0 });
    } finally {
      view.close();
    }
    const output = await pending;
    expect(fetchedBytes(output!.files[0]!).toString("utf8")).toBe(`${groupsLine(`${SHOP}:2026-10`, { yours: [["2026-10-02", "2026-10-31"]] })}\n`);
  });

  it("M5: the connector lands part of a delivery with a bad line, a month outside its key, or spans that overlap", async () => {
    const home: TestHome = openTestHome("groups-bad-");
    const good = groupsLine(`${FRIENDS}:2026-10`, { yours: [["2026-10-01", "2026-10-31"]] });
    const bad = [
      groupsLine(`${FRIENDS}:2026-10`, { yours: [["2026-09-30", "2026-10-31"]] }),
      groupsLine(`${FRIENDS}:2026-10`, { yours: [["2026-10-01", "2026-10-10"], ["2026-10-10", "2026-10-12"]] }),
      groupsLine(`${FRIENDS}:2026-13`, { yours: [] }),
      groupsLine(`Network A:somewhere:2026-10`, { yours: [] }),
      JSON.stringify({ kind: "month", key: `${FRIENDS}:2026-10`, content: { yours: [], more: 1 } }),
      "{not json",
    ];
    for (const [index, line] of bad.entries()) {
      const delivery = deliver(home, SOURCE, { [GROUPS_FILE]: Buffer.from(`${good}\n${line}\n`) }, {}, NOW + index);
      await expect(collect(groupsConnector.read(delivery, home.blobs)), line).rejects.toBeInstanceOf(Refused);
    }
    const rows = await collect(groupsConnector.read(deliver(home, SOURCE, { [GROUPS_FILE]: Buffer.from(`${good}\n${groupsLine(`${SHOP}:2026-10`, "gone")}\n${groupsLine("network-a:group-a:2026-10", { yours: [] })}\n`) }, {}, NOW + 10), home.blobs));
    expect(rows).toEqual([
      { kind: "month", key: `${FRIENDS}:2026-10`, content: { yours: [["2026-10-01", "2026-10-31"]] } },
      { kind: "month", key: `${SHOP}:2026-10`, content: null, gone: true },
      { kind: "month", key: "network-a:group-a:2026-10", content: { yours: [] } },
    ]);
    artifact(home.dir, "deliveries.json", record);
  });
});
