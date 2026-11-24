import { describe, expect, it } from "vitest";
import { civilDay, openHomeFolder } from "@lifestreamprotocol/core";
import { LANE } from "./jobs.js";
import { mintPrincipal } from "./principals.js";
import { askHome } from "./socket.js";
import { startHome } from "./home.js";
import { count, DAY, dayText, MINUTE, note, SOURCE, UTC4 } from "./test/derived.js";
import { artifact, FAKES, freeSpace, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { openDoor } from "./test/harness-door.js";
import { statusOf } from "./test/harness-status.js";
import { acquisitionBundle, DEVICE } from "./test/support.js";
import { effective } from "./settings.js";
import { testSocket } from "./test/folder.js";

const MAC = "macbook-pro-0001";
const ARCHIVE = "apple-notes:local:archive";

describe("a home whose disk fills and empties", () => {
  it("lands history at 6 GB; at 4 GB holds it, lands and prints new notes, a rebuild among them, and refuses a later upload; at 0.5 GB refuses every upload and starts no job, live or rebuild; at 6 GB again goes on by itself", async () => {
    const free = freeSpace(6e9);
    const root = makeRoot("lifestream-space-", { sources: { [SOURCE]: "fake-rows", [ARCHIVE]: "fake-rows" }, helpers: 3 });
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    const sock = testSocket(root);
    const read = async (what: string) => {
      const at = home.stats().ticks.count;
      await until(what, () => home.stats().ticks.count >= at + 2);
    };
    try {
      const { token } = mintPrincipal(openHomeFolder(root), { unit: MAC, kind: "mac", scopes: ["deliver"], sources: [SOURCE], now_ms: Date.now() });
      const { url } = await openDoor(root, { floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" } });
      const headers = { authorization: `Bearer ${token}`, ...DEVICE.mac };
      const state = (id: string) => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) as string | undefined;
      const job = (kind: string, key: string) => readHome(root, (db) => db.prepare("SELECT state, lane FROM jobs WHERE kind = ? AND key = ?").get(kind, key)) as { state: string; lane: number } | undefined;
      const needs = () => statusOf(root, { now_ms: Date.now(), settings: effective(root).settings }).needs
        .filter((need) => need.id.startsWith("disk")).map(({ id, words, line }) => ({ id, words, line }));
      const history = async () => {
        const answer = await (await fetch(`${url}/v1/exchange`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" })).json() as
          { sources: Record<string, { history: boolean }> };
        return answer.sources[SOURCE]!.history;
      };
      let seal = 0;
      const upload = async (key: string, at: number, kind?: "new" | "later") => {
        const bundle = acquisitionBundle({
          source: SOURCE, feeder: "fake-rows", fetched_ms: at, files: [["rows.ndjson", Buffer.from(`${JSON.stringify(note(key, `a note ${key} from the Mac`, at))}\n`)]],
          custody: { [SOURCE]: { seal: seal + 1 } },
        });
        const response = await fetch(`${url}${bundle.path}`, { method: "PUT", headers: { ...headers, ...(kind === undefined ? {} : { "lifestream-kind": kind }) }, body: bundle.bytes });
        if (response.status === 201) seal++;
        return { status: response.status, code: (await response.json() as { code?: string }).code ?? null, retry: response.headers.get("retry-after"), id: bundle.id };
      };
      const today = civilDay(Date.now(), UTC4);
      const old = Date.now() - 30 * DAY;
      const shipNote = (source: string, key: string, at: number, facts = {}) => ship(root, { source, fetched_ms: at, rows: [note(key, `a note ${key}`, at)], facts });

      expect((await upload("mac-first", Date.now() - 3 * MINUTE)).status).toBe(201);
      const first = await shipNote(ARCHIVE, "past-1", old, { history: true });
      await until("the first history page imported", () => state(first) === "imported");
      const roomy = { history: await history(), needs: needs() };
      expect(roomy).toEqual({ history: true, needs: [] });

      free.set(4e9);
      await read("the home read its disk low");
      const waiting = await shipNote(ARCHIVE, "past-2", old + DAY, { history: true });
      const live = await shipNote(SOURCE, "live-1", Date.now() - 2 * MINUTE);
      await until("the live note printed today", () => dayText(root, today).includes("a note live-1"));
      expect([state(waiting), job("import", ARCHIVE)]).toEqual(["sealed", { state: "queued", lane: LANE.history }]);
      const told = await history();
      const ignored = await upload("from-the-past", old + 2 * DAY);
      const stated = await upload("from-the-past", old + 2 * DAY, "later");
      expect([told, ignored, stated].map((each) => typeof each === "boolean" ? each : [each.status, each.code, each.retry]))
        .toEqual([false, [503, "DISK_LOW", "300"], [503, "DISK_LOW", "300"]]);
      expect(state(ignored.id)).toBeUndefined();
      const fresh = await upload("mac-new", Date.now() - MINUTE, "new");
      expect(fresh.status).toBe(201);
      await until("the Mac's new note printed today", () => dayText(root, today).includes("a note mac-new from the Mac"));
      await askHome(sock, "rebuild", ["extracts", "--family", "notes"]);
      await shipNote(SOURCE, "live-2", Date.now() - MINUTE / 2);
      await until("the note that came during the rebuild printed today", () => dayText(root, today).includes("a note live-2") && job("walk", "notes")?.state === "done");
      const low = { told, ignored, fresh, needs: needs(), waiting: state(waiting) };
      expect(low.needs).toEqual([{ id: "disk:low", words: "Lifestream's disk is almost full", line: "History, photos and imports wait for 5 GB free" }]);
      expect(state(waiting)).toBe("sealed");

      free.set(0.5e9);
      const refused = await upload("mac-full", Date.now(), "new");
      expect([refused.status, refused.code]).toEqual([503, "DISK_LOW"]);
      await read("the home read its disk full");
      const held = await shipNote(SOURCE, "live-full", Date.now() - MINUTE / 4);
      await askHome(sock, "rebuild", ["extracts", "--family", "notes"]);
      await read("two ticks with the note and the rebuild asked for");
      await read("two more");
      expect([state(held), job("import", SOURCE)?.state, job("walk", "notes")]).toEqual(["sealed", "queued", { state: "queued", lane: LANE.backfill }]);
      const full = { refused, needs: needs(), live: state(held), walk: job("walk", "notes") };
      expect(full.needs).toEqual([{ id: "disk:full", words: "Lifestream's disk is full", line: "Nothing new is saved" }]);

      free.set(6e9);
      await until("the note sealed while full printed today", () => dayText(root, today).includes("a note live-full"));
      await until("the waiting history imported", () => state(waiting) === "imported");
      await until("the rebuild ran", () => job("walk", "notes")?.state === "done" && count(root, "SELECT coalesce(max(seq), 0) FROM cursors WHERE name = 'rebuild:notes'") === 0);
      expect([await history(), needs()]).toEqual([true, []]);
      artifact(root, "space", { roomy, low, full, live, again: { waiting: state(waiting) } });
    } finally {
      await home.stop();
      removeRoot(root);
    }
  });

  it("counts an import whose file its disk has no room for toward its death, fails its delivery, tries it again before its wait, or never lands it once there is room", async () => {
    const free = freeSpace(1e9 + 1_000);
    const skew = { ms: 0 };
    const root = makeRoot("lifestream-space-wait-", { sources: { [SOURCE]: "fake-rows" } });
    const logs: string[] = [];
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: (line) => logs.push(line), tickMs: TICK_MS, clock: () => Date.now() + skew.ms });
    const waits = () => logs.filter((line) => line.includes('"waits":"room"')).length;
    const of = () => readHome(root, (db) => ({
      job: db.prepare("SELECT state, attempts FROM jobs WHERE kind = 'import' AND key = ?").get(SOURCE),
      delivery: db.prepare("SELECT state FROM deliveries WHERE source = ?").pluck().get(SOURCE),
      failed: db.prepare("SELECT count(*) FROM events WHERE kind = 'import-failed'").pluck().get(),
    }));
    try {
      const at = Date.now() - MINUTE;
      await ship(root, { source: SOURCE, fetched_ms: at, rows: [{ ...note("attached", "a note with its file", at), stores: "a synthetic attachment ".repeat(100) } as never] });
      await until("the import waits for room", () => waits() === 1);
      const waiting = of();
      expect(waiting).toEqual({ job: { state: "queued", attempts: 0 }, delivery: "importing", failed: 0 });
      const ticks = home.stats().ticks.count;
      await until("two ticks on", () => home.stats().ticks.count >= ticks + 2);
      expect(waits()).toBe(1);
      free.set(6e9);
      skew.ms = 2 * MINUTE;
      await until("the import landed once there is room", () => of().delivery === "imported");
      expect(of()).toEqual({ job: { state: "done", attempts: 0 }, delivery: "imported", failed: 0 });
      expect(count(root, "SELECT count(*) FROM version_blobs")).toBe(1);
      artifact(root, "room-wait", { waiting, landed: of(), waits: logs.filter((line) => line.includes('"waits":"room"')) });
    } finally {
      await home.stop();
      removeRoot(root);
    }
  });
});
