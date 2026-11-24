import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Home } from "./home.js";
import { basicInstant, openSealing } from "./inbox.js";
import { settingsPath } from "./settings.js";
import { askHome } from "./socket.js";
import type { StreamsReport } from "./streams-report.js";
import { ranOf, SCRIPT, type Answer } from "./test/clock-fakes.js";
import { artifact, freeSpace, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { homeWithDoor } from "./test/harness-home.js";
import { testSocket } from "./test/folder.js";
import { openHomeFolder } from "@lifestreamprotocol/core";

const REGISTRY = fileURLToPath(new URL("./test/clock-fakes.ts", import.meta.url));
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function saidOf(root: string, call: "fetch" | "page"): string | undefined {
  const row = readHome(root, (db) => db.prepare("SELECT outcome, detail FROM attempts WHERE target = ? ORDER BY at_ms DESC LIMIT 1").get(`${call}:fake-clock`)) as { outcome: string; detail: string | null } | undefined;
  return row === undefined ? undefined : row.detail === null ? row.outcome : `${row.outcome}: ${row.detail}`;
}

describe("a connector's clock: its refresh, its backfill's pace, fairness and the back-off either call said", () => {
  it("a call runs before its turn or after it, the fetch starves the page or waits for it, a paused, low or finished backfill pages, a member changed waits, a bad value is written, or a connector turned off polls", async () => {
    const root = makeRoot("lifestream-refresh-", {
      clocks: true,
      sources: { "apple-notes:local:clock": "fake-rows", "apple-notes:local:hand": "fake-hand" },
      settings: { "connectors.fake-clock": { refresh: "10m" } },
    });
    const script: Record<"fetch" | "page", Answer[]> = {
      fetch: [{ more: true }, {}, {}, {}, { backoff_ms: T0 + 2 * HOUR }, ...Array.from({ length: 14 }, () => ({})), { facts: { history: true, left: 0 } }],
      page: [
        { left: 20 }, { left: 19 }, { left: 18 }, { left: 17 }, { left: 16 }, { left: 15 }, { left: 14 }, { left: 13 }, { left: 12, backoff_ms: T0 + HOUR },
        { left: 11 }, { left: 10 }, { fail: "the provider broke" }, { wait: "offline" }, { left: 9 }, { left: 8 }, { left: 7 }, { left: 6 }, { left: 0 }, { left: 3 },
      ],
    };
    writeFileSync(join(root, SCRIPT), JSON.stringify(script));
    let now = T0;
    const clock = () => now + ranOf(root).length;
    const logged: string[] = [];
    let home: Home | undefined = await homeWithDoor(root, { registry: REGISTRY, clock, log: (line) => logged.push(line), tickMs: TICK_MS });
    const sock = testSocket(root);
    const ran = () => ranOf(root).filter((each) => each.name === "fake-clock");
    const last = (count: number) => ran().slice(-count).map(({ call, n }) => `${call} ${n}`);
    type PollRow = { next_ms: number; paged_ms: number | null; held_ms: number | null };
    const row = () => readHome(root, (db) => db.prepare("SELECT next_ms, paged_ms, held_ms FROM polls WHERE acquirer = 'fake-clock'").get()) as PollRow;
    const callSaid = (call: "fetch" | "page") => saidOf(root, call);
    type BackfillRow = { left: number | null; start_ms: number | null; recent: string; last: string | null };
    const backfill = () => readHome(root, (db) => db.prepare("SELECT left, start_ms, recent, last FROM backfills WHERE source = 'apple-notes:local:clock'").get()) as BackfillRow | undefined;
    const delivered = () => readHome(root, (db) => db.prepare("SELECT id, facts FROM deliveries WHERE source = 'apple-notes:local:clock' ORDER BY sealed_ms, id").all()) as { id: string; facts: string }[];
    const pending = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE kind = 'poll' AND key = 'fake-clock' AND state <> 'done'").pluck().get()) as number;
    const jobs = () => readHome(root, (db) => db.prepare("SELECT kind, key, state, attempts FROM jobs WHERE kind = 'poll'").all());
    const settled = async (count: number, what: string) => {
      try {
        await until(what, () => ran().length >= count && pending() === 0);
      } catch (error) {
        throw new Error(`${(error as Error).message}; ran ${JSON.stringify(last(4))}; its row ${JSON.stringify(row())}; the poll jobs ${JSON.stringify(jobs())}; the log's end ${logged.slice(-15).join("\n")}`);
      }
      expect(ran().length, what).toBe(count);
    };
    const ticks = async (count: number) => {
      const at = home!.stats().ticks.count;
      await until(`${count} ticks`, () => home!.stats().ticks.count >= at + count);
    };
    const near = (at: number | null, from: number, span: number) => {
      expect(at).not.toBeNull();
      expect(Math.abs(at! - from - span)).toBeLessThan(1_000);
    };
    const turns: { at: number; ran: string[]; row: PollRow }[] = [];
    const mark = (count: number) => turns.push({ at: now - T0, ran: last(count), row: row() });
    try {
      await settled(3, "two fetches, then the first page");
      expect(last(3)).toEqual(["fetch 1", "fetch 2", "page 1"]);
      near(row().next_ms, T0, 10 * MINUTE);
      near(row().paged_ms, T0, 0);
      expect(backfill()).toMatchObject({ left: 20, start_ms: null, last: null });
      expect(delivered().map(({ facts }) => JSON.parse(facts) as Record<string, unknown>).map(({ history, left, start_ms }) => ({ history, left, start_ms }))).toEqual([
        { history: undefined, left: undefined, start_ms: undefined }, { history: undefined, left: undefined, start_ms: undefined }, { history: true, left: 20, start_ms: null },
      ]);
      mark(3);

      await ticks(3);
      expect(ran().length).toBe(3);
      now = T0 + 2 * MINUTE;
      await settled(4, "the second page, a pace on");
      expect(last(1)).toEqual(["page 2"]);
      mark(1);

      now = T0 + 10 * MINUTE;
      await settled(6, "the overdue page, then the fetch");
      expect(last(2)).toEqual(["page 3", "fetch 3"]);
      mark(2);
      for (const [step, count] of [[12, 7], [14, 8], [16, 9], [18, 10]] as const) {
        now = T0 + step * MINUTE;
        await settled(count, `the page at ${step} min`);
      }
      now = T0 + 20 * MINUTE;
      await settled(12, "the fetch, then the page due and not overdue");
      expect(last(2)).toEqual(["fetch 4", "page 8"]);
      mark(2);

      now = T0 + 22 * MINUTE;
      await settled(13, "the page that said an hour");
      near(row().held_ms, T0 + HOUR, 0);
      now = T0 + 31 * MINUTE;
      await ticks(3);
      expect(ran().length, "no fetch on its refresh while the page's back-off holds it").toBe(13);
      now = T0 + HOUR;
      await settled(15, "both, the hour past");
      expect(last(2)).toEqual(["page 10", "fetch 5"]);
      now = T0 + HOUR + 3 * MINUTE;
      await ticks(3);
      expect(ran().length, "no page on its pace while the fetch's back-off holds it").toBe(15);
      now = T0 + 2 * HOUR;
      await settled(17, "both, two hours past");
      mark(2);

      await askHome(sock, "connectors", ["set", "fake-clock", "pace", "30m"]);
      await settled(18, "the fetch on the pace's change");
      expect(last(1)).toEqual(["fetch 7"]);
      now = T0 + 2 * HOUR + 30 * MINUTE;
      await settled(20, "the fetch, then the page that fails");
      expect(last(2)).toEqual(["fetch 8", "page 12"]);
      near(row().paged_ms, now, 0);
      expect(callSaid("page")).toMatch(/^fail: .*the provider broke/u);
      expect(callSaid("fetch"), "a page's failure is the page's: the fetch's row stands").toBe("ok");
      now += 4 * MINUTE;
      await ticks(3);
      expect(ran().length, "no failed page again before RETRY_MS").toBe(20);
      now += MINUTE;
      await settled(21, "the page again, RETRY_MS on, that waits");
      expect([last(1), callSaid("page")]).toEqual([["page 13"], "wait: offline"]);
      now += 5 * MINUTE;
      await settled(23, "the fetch, then the page that reads");
      expect([last(2), callSaid("page")]).toEqual([["fetch 9", "page 14"], "ok"]);
      await askHome(sock, "connectors", ["set", "fake-clock", "pace", "2m"]);
      await settled(24, "the fetch on the pace's change");
      now += 2 * MINUTE;
      await settled(25, "the page on the lowered pace");
      expect(last(1)).toEqual(["page 15"]);
      mark(2);

      expect(await askHome(sock, "connectors", ["backfill", "fake-clock", "pause", "--reason", "a test"])).toEqual({ paused: "pause:fake-clock:history", by: "terminal" });
      now = T0 + 3 * HOUR;
      await settled(26, "the fetch while the backfill is paused");
      await ticks(3);
      expect([ran().length, last(1)]).toEqual([26, ["fetch 11"]]);
      await askHome(sock, "connectors", ["backfill", "fake-clock", "resume"]);
      await settled(27, "the page, resumed");
      expect(last(1)).toEqual(["page 16"]);
      expect(await askHome(sock, "connectors", ["backfill", "fake-clock", "now"])).toEqual({ queued: ["fake-clock"] });
      await settled(28, "the page at once");
      expect(last(1)).toEqual(["page 17"]);
      expect((JSON.parse(backfill()!.recent) as unknown[]).length).toBe(1);

      now += 2 * MINUTE;
      await settled(29, "the last page");
      expect(backfill()).toMatchObject({ left: 0, start_ms: null, last: delivered().at(-1)!.id });
      now += 10 * MINUTE;
      await settled(30, "the fetch, and no page after the end");
      await ticks(3);
      expect([ran().length, last(1)]).toEqual([30, ["fetch 12"]]);
      await askHome(sock, "connectors", ["set", "fake-clock", "start", "2026-07-01"]);
      await settled(32, "the fetch on the change, then the page at the new start");
      expect(last(2)).toEqual(["fetch 13", "page 19"]);
      expect(ran().at(-1)!.start_ms).toBe(Date.UTC(2026, 6, 1));
      expect(backfill()).toMatchObject({ left: 3, start_ms: Date.UTC(2026, 6, 1) });
      expect((JSON.parse(backfill()!.recent) as unknown[]).length).toBe(1);
      mark(2);

      await askHome(sock, "connectors", ["set", "fake-clock", "label", "second"]);
      await settled(33, "the fetch on the label's change");
      expect(ran().at(-1)).toMatchObject({ call: "fetch", n: 14, label: "second" });
      const set = await askHome(sock, "connectors", ["set", "fake-clock", "refresh", "30m"]) as { changed: { value: string; from: string }[] };
      expect(set.changed).toHaveLength(1);
      expect(set.changed[0]).toMatchObject({ member: "refresh", value: "30m", from: "person", default: "1h", min: "1m", max: "1d" });
      await settled(34, "the fetch on the refresh's change");
      near(row().next_ms, clock(), 30 * MINUTE);

      const before = readFileSync(settingsPath(root), "utf8");
      await expect(askHome(sock, "connectors", ["set", "fake-clock", "refresh", "5s"])).rejects.toThrow(/connectors\.fake-clock\.refresh runs from 1m to 1d/u);
      await expect(askHome(sock, "connectors", ["set", "fake-clock", "refresh", "soon"])).rejects.toThrow(/connectors\.fake-clock\.refresh is a duration/u);
      await expect(askHome(sock, "connectors", ["set", "fake-clock", "start", "lately"])).rejects.toThrow(/connectors\.fake-clock\.start is all or a day/u);
      await expect(askHome(sock, "connectors", ["set", "fake-clock", "pace", "10s"])).rejects.toThrow(/connectors\.fake-clock\.pace runs from 1m to 1h/u);
      await expect(askHome(sock, "connectors", ["set", "fake-clock", "every_ms", "600000"])).rejects.toThrow(/connectors\.fake-clock\.every_ms is not a member of fake-clock: it holds refresh, start, pace, label/u);
      await expect(askHome(sock, "connectors", ["set", "fake-hand", "refresh", "1h"])).rejects.toThrow(/connectors\.fake-hand\.refresh is not a member of fake-hand/u);
      await expect(askHome(sock, "connectors", ["backfill", "fake-hand", "now"])).rejects.toThrow(/fake-hand has no backfill/u);
      await expect(askHome(sock, "connectors", ["set", "fake-gone", "refresh", "1h"])).rejects.toThrow(/no connector fake-gone; the home runs .*\bfake-clock, fake-hand\b/u);
      expect(readFileSync(settingsPath(root), "utf8")).toBe(before);

      const shown = await askHome(sock, "connectors", ["show", "fake-clock"]) as { members: { member: string; value: unknown; from: string }[] };
      expect(shown.members.map(({ member, value, from }) => [member, value, from])).toEqual([["refresh", "30m", "person"], ["start", "2026-07-01", "person"], ["pace", "2m", "person"], ["label", "second", "person"]]);
      const reset = await askHome(sock, "connectors", ["reset", "fake-clock", "refresh"]) as { changed: { value: string; from: string }[] };
      expect(reset.changed).toHaveLength(1);
      expect(reset.changed[0]).toMatchObject({ value: "1h", from: "declaration" });
      expect(JSON.parse(readFileSync(settingsPath(root), "utf8"))["connectors.fake-clock"]).toEqual({ start: "2026-07-01", pace: "2m", label: "second" });
      await settled(35, "the fetch on the refresh's reset");
      near(row().next_ms, clock(), HOUR);

      await askHome(sock, "connectors", ["off", "fake-clock"]);
      now += 2 * HOUR;
      await ticks(3);
      expect(ran().length).toBe(35);
      await askHome(sock, "connectors", ["on", "fake-clock"]);
      await settled(37, "both, turned on, their turns past");
      expect(last(2)).toEqual(["page 20", "fetch 17"]);

      now += 2 * HOUR;
      await settled(39, "both, two hours on");

      await home.stop();
      home = undefined;
      const free = freeSpace(4e9);
      home = await homeWithDoor(root, { registry: REGISTRY, clock, log: (line) => logged.push(line), tickMs: TICK_MS });
      now += 2 * HOUR;
      await settled(40, "the fetch while the disk is low");
      await ticks(3);
      expect([ran().length, last(1)]).toEqual([40, ["fetch 19"]]);
      expect(await askHome(sock, "connectors", ["backfill", "fake-clock", "now"])).toEqual({ queued: ["fake-clock"] });
      await settled(40, "the page queued on a low disk, run as nothing");
      await ticks(3);
      expect(ran().length, "no fetch off its turn from a run queued for the page").toBe(40);
      free.set(0.5e9);
      await ticks(2);
      now += 2 * HOUR;
      await ticks(3);
      expect([ran().length, pending()], "no fetch on a full disk").toEqual([40, 0]);
      free.set(4e9);
      const deliveries = delivered().length;
      now += 2 * HOUR;
      await settled(41, "the fetch whose facts state history");
      expect(callSaid("fetch")).toMatch(/^fail: .*acquirer fake-clock's facts state history, left, which only the home states of a page/u);
      expect(delivered().length).toBe(deliveries);
      await home.stop();
      home = undefined;

      writeFileSync(settingsPath(root), JSON.stringify({ ...JSON.parse(readFileSync(settingsPath(root), "utf8")), "connectors.fake-clock": { refresh: "2d", label: "second" } }, null, 2));
      const said: string[] = [];
      home = await homeWithDoor(root, { registry: REGISTRY, clock, log: (line) => said.push(line), tickMs: TICK_MS });
      expect(said.map((line) => JSON.parse(line) as { settings?: string; what?: string }).filter((line) => line.settings !== undefined))
        .toEqual([expect.objectContaining({ settings: "connectors.fake-clock.refresh", what: expect.stringMatching(/is 2d, past its bound: it runs at 1d/u) })]);
      await home.stop();
      home = undefined;
      writeFileSync(settingsPath(root), JSON.stringify({ ...JSON.parse(readFileSync(settingsPath(root), "utf8")), "connectors.fake-clock": { refresh: 600_000 } }, null, 2));
      said.length = 0;
      home = await homeWithDoor(root, { registry: REGISTRY, clock, log: (line) => said.push(line), tickMs: TICK_MS });
      expect(said.map((line) => JSON.parse(line) as { settings?: string; what?: string }).filter((line) => line.settings !== undefined))
        .toEqual([expect.objectContaining({ settings: "connectors.fake-clock.refresh", what: expect.stringMatching(/as 600000, and it is a duration.*: it is kept and ignored, and runs at its default/u) })]);
      await home.stop();
      home = undefined;

      artifact(root, "refresh", { turns, ran: ranOf(root), settings: JSON.parse(readFileSync(settingsPath(root), "utf8")) });
    } finally {
      await home?.stop();
      removeRoot(root);
    }
  });

  it("a page's own wait is dropped or holds the fetch, a back-off is beaten by a run queued inside it, or `backfill now` after the end fetches", async () => {
    const root = makeRoot("lifestream-refresh-holds-", { clocks: true, sources: { "apple-notes:local:clock": "fake-rows" } });
    const script: Record<"fetch" | "page", Answer[]> = {
      fetch: [{}, {}, {}],
      page: [
        { left: 5 }, { wait: "the day's bytes are spent", wait_ms: T0 + 30 * MINUTE }, { left: 4 }, { wait: "the provider throttles", backoff_ms: T0 + 3 * HOUR },
        { left: 0 }, { left: 0 },
      ],
    };
    writeFileSync(join(root, SCRIPT), JSON.stringify(script));
    let now = T0;
    const clock = () => now + ranOf(root).length;
    let home: Home | undefined = await homeWithDoor(root, { registry: REGISTRY, clock, tickMs: TICK_MS });
    const sock = testSocket(root);
    const ran = () => ranOf(root).filter((each) => each.name === "fake-clock");
    const last = (count: number) => ran().slice(-count).map(({ call, n }) => `${call} ${n}`);
    type PollRow = { next_ms: number; paged_ms: number | null; page_next_ms: number | null; held_ms: number | null };
    const row = () => readHome(root, (db) => db.prepare("SELECT next_ms, paged_ms, page_next_ms, held_ms FROM polls WHERE acquirer = 'fake-clock'").get()) as PollRow;
    const callSaid = (call: "fetch" | "page") => saidOf(root, call);
    const pending = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE kind = 'poll' AND key = 'fake-clock' AND state <> 'done'").pluck().get()) as number;
    const backfill = () => readHome(root, (db) => db.prepare("SELECT left, last FROM backfills WHERE source = 'apple-notes:local:clock'").get()) as { left: number | null; last: string | null } | undefined;
    const settled = async (count: number, what: string) => {
      await until(what, () => ran().length >= count && pending() === 0);
      expect(ran().length, what).toBe(count);
    };
    const ticks = async (count: number) => {
      const at = home!.stats().ticks.count;
      await until(`${count} ticks`, () => home!.stats().ticks.count >= at + count);
    };
    const near = (at: number | null, to: number) => {
      expect(at).not.toBeNull();
      expect(Math.abs(at! - to)).toBeLessThan(1_000);
    };
    const report = async () => ((await askHome(sock, "connectors")) as StreamsReport).connectors.find((each) => each.id === "fake-clock")!;
    const turns: { at: number; ran: string[]; row: PollRow }[] = [];
    const mark = (count: number) => turns.push({ at: now - T0, ran: last(count), row: row() });
    try {
      await settled(2, "the fetch, then the first page");
      expect(last(2)).toEqual(["fetch 1", "page 1"]);

      now = T0 + 2 * MINUTE;
      await settled(3, "the page that waits half an hour");
      expect([callSaid("page"), row().held_ms, callSaid("fetch")]).toEqual(["wait: the day's bytes are spent", null, "ok"]);
      near(row().page_next_ms, T0 + 30 * MINUTE);
      near(row().next_ms, T0 + HOUR);
      now = T0 + 10 * MINUTE;
      await ticks(3);
      expect(ran().length, "no page before its own wait ends, however many retries pass").toBe(3);
      mark(3);
      await askHome(sock, "connectors", ["set", "fake-clock", "label", "second"]);
      await settled(4, "the fetch while the page waits");
      expect(last(1)).toEqual(["fetch 2"]);
      const waiting = await report();
      expect([waiting.health.state, waiting.line.includes("bytes"), callSaid("page")]).toEqual(["waiting", false, "wait: the day's bytes are spent"]);
      now = T0 + 30 * MINUTE;
      await settled(5, "the page once its own wait ends");
      expect([last(1), callSaid("page"), row().page_next_ms]).toEqual([["page 3"], "ok", null]);

      now = T0 + HOUR;
      await settled(6, "the page the provider throttles");
      near(row().held_ms, T0 + 3 * HOUR);
      now = T0 + 80 * MINUTE;
      await ticks(3);
      expect(ran().length, "no fetch on its own turn while the page's back-off holds it").toBe(6);
      expect(await askHome(sock, "connectors", ["backfill", "fake-clock", "now"])).toEqual({ queued: [] });
      await askHome(sock, "connectors", ["set", "fake-clock", "label", "third"]);
      await ticks(3);
      expect([ran().length, pending()], "no call queued inside the back-off").toEqual([6, 0]);
      expect(row().next_ms).toBeLessThanOrEqual(clock());
      near(row().held_ms, T0 + 3 * HOUR);
      mark(1);

      now = T0 + 3 * HOUR;
      await settled(8, "both, the back-off over");
      expect(last(2)).toEqual(["fetch 3", "page 5"]);
      expect(ran().at(-2)!.label).toBe("third");
      await until("the last page landed", () => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(backfill()?.last ?? "")) === "imported");
      now += 10 * MINUTE;
      await ticks(3);
      expect(ran().length, "no page once the backfill is done").toBe(8);
      expect(await askHome(sock, "connectors", ["backfill", "fake-clock", "now"])).toEqual({ queued: ["fake-clock"] });
      await settled(9, "the page asked for after the end");
      expect(last(1)).toEqual(["page 6"]);
      expect(backfill()!.left).toBe(0);
      mark(4);
      artifact(root, "refresh-holds", { turns, ran: ranOf(root) });
    } finally {
      await home?.stop();
      home = undefined;
      removeRoot(root);
    }
  });

  it("one account's delivery feeds another account, its page writes another's progress, a done account's lane pages on while another account is not signed in, a call that named no account holds the page, or a done account's later page undoes it", async () => {
    const A = "apple-notes:person-a@example.com:browser";
    const B = "apple-notes:person-b@example.com:browser";
    const stating = (...ids: string[]) => ({ sources: ids.map((id) => ({ id, connector: "fake-rows" })) });
    const root = makeRoot("lifestream-refresh-accounts-", { clocks: true, sources: { "apple-notes:local:clock": "fake-rows" } });
    const script: Record<"fetch" | "page", Answer[]> = {
      fetch: [{ facts: stating(A, B) }, { fail: "the list broke" }, { facts: stating(B) }],
      page: [{ left: 3, facts: stating(A) }, { left: 0, facts: stating(A) }, { left: null, facts: stating(A) }, { left: 2, facts: stating(B) }],
    };
    writeFileSync(join(root, SCRIPT), JSON.stringify(script));
    let now = T0;
    const clock = () => now + ranOf(root).length;
    const home = await homeWithDoor(root, { registry: REGISTRY, clock, tickMs: TICK_MS });
    const ran = () => ranOf(root).filter((each) => each.name === "fake-clock");
    const last = (count: number) => ran().slice(-count).map(({ call, n }) => `${call} ${n}`);
    const pending = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE kind = 'poll' AND key = 'fake-clock' AND state <> 'done'").pluck().get()) as number;
    const settled = async (count: number, what: string) => {
      await until(what, () => ran().length >= count && pending() === 0);
      expect(ran().length, what).toBe(count);
    };
    const ticks = async (count: number) => {
      const at = home.stats().ticks.count;
      await until(`${count} ticks`, () => home.stats().ticks.count >= at + count);
    };
    type Row = { source: string; left: number | null; recent: string; last: string | null };
    const rows = () => (readHome(root, (db) => db.prepare("SELECT source, left, recent, last FROM backfills ORDER BY source").all()) as Row[])
      .map(({ recent, ...each }) => ({ ...each, points: (JSON.parse(recent) as unknown[]).length }));
    const pages = () => readHome(root, (db) => db.prepare("SELECT DISTINCT id FROM deliveries WHERE json_extract(facts, '$.history') = 1 ORDER BY sealed_ms, id").pluck().all()) as string[];
    const fed = () => (readHome(root, (db) => db.prepare("SELECT id, group_concat(source) AS sources FROM (SELECT id, source, sealed_ms FROM deliveries ORDER BY source) GROUP BY id ORDER BY min(sealed_ms), id").all()) as { sources: string }[]).map((each) => each.sources);
    const imported = (id: string) => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE id = ? AND state <> 'imported'").pluck().get(id)) === 0;
    try {
      await settled(2, "the fetch naming both accounts, then A's first page");
      expect(last(2)).toEqual(["fetch 1", "page 1"]);
      expect(rows()).toEqual([{ source: A, left: 3, last: null, points: 1 }]);
      now += 2 * MINUTE;
      await settled(3, "A's last page");
      const done = pages()[1]!;
      expect(rows()).toEqual([{ source: A, left: 0, last: done, points: 2 }]);
      await until("A's last page landed", () => imported(done));
      expect(readHome(root, (db) => db.prepare("SELECT lane FROM jobs WHERE kind = 'import' AND key = ?").pluck().get(A))).toBe(3);
      now += 2 * MINUTE;
      await ticks(3);
      now += 2 * MINUTE;
      await ticks(3);
      expect(ran().length).toBe(3);
      now += HOUR;
      await settled(5, "the fetch that failed, then a page");
      expect(last(2)).toEqual(["fetch 2", "page 3"]);
      expect(rows()).toEqual([{ source: A, left: 0, last: done, points: 2 }]);
      now += 2 * MINUTE;
      await ticks(3);
      expect(ran().length).toBe(5);
      now += HOUR;
      await settled(7, "the fetch of B, then B's first page");
      expect(last(2)).toEqual(["fetch 3", "page 4"]);
      expect(rows()).toEqual([{ source: A, left: 0, last: done, points: 2 }, { source: B, left: 2, last: null, points: 1 }]);
      expect(fed()).toEqual([`${A},${B}`, A, A, A, B, B]);
      artifact(root, "refresh-accounts", { backfills: rows(), pages: pages() });
    } finally {
      await home.stop();
      removeRoot(root);
    }
  });

  it("loses a page sealed before its commit: the start indexes it, and its backfill's row is written from its facts", async () => {
    const root = makeRoot("lifestream-refresh-sealed-", { sources: { "apple-notes:local:clock": "fake-rows" } });
    const fetched_at = new Date(T0).toISOString();
    const sealing = openSealing(openHomeFolder(root), { source: "apple-notes:local:clock", name: basicInstant(fetched_at), feeder: "fake-clock", fetched_at });
    const row = { kind: "note", key: "fake-clock-page-1", content: { text: "synthetic page", at: T0 - HOUR }, at: T0 - HOUR };
    await sealing.write("rows.ndjson", (async function* () { yield Buffer.from(`${JSON.stringify(row)}\n`); })());
    sealing.seal({ history: true, left: 7, start_ms: null });
    const home = await homeWithDoor(root, { registry: REGISTRY, clock: () => T0 + MINUTE, tickMs: TICK_MS });
    try {
      await until("the sealed page indexed and imported", () =>
        readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE source = 'apple-notes:local:clock' AND state = 'imported'").pluck().get()) === 1);
      const backfill = readHome(root, (db) => db.prepare("SELECT acquirer, left, unit, start_ms, recent, last FROM backfills").all()) as { recent: string }[];
      expect(backfill.map((each) => ({ ...each, recent: (JSON.parse(each.recent) as { left: number }[]).map(({ left }) => left) }))).toEqual([
        { acquirer: "fake-clock", left: 7, unit: '["note","notes"]', start_ms: null, recent: [7], last: null }]);
    } finally {
      await home.stop();
      removeRoot(root);
    }
  });
});
