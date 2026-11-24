import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { civilDay } from "@lifestreamprotocol/core";
import { startHome } from "./home.js";
import { LANE } from "./jobs.js";
import { askHome } from "./socket.js";
import { artifact, FAKE_ROUTE, FAKES, hex, makeRoot, readHome, readLedger, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { count, DAY, dayText, derivedHomes, HOUR, MINUTE, note, quiet, SOURCE, unitOf, UTC4 } from "./test/derived.js";
import { testSocket } from "./test/folder.js";


describe("derived work: what a commit made due is found from what it moved, never requested by a writer", () => {
  const { roots, open } = derivedHomes();

  it("a reply shared by two extracts updates one day", async () => {
    const { root, home } = await open("lifestream-derived-shared-");
    try {
      const first = Date.now() - 3 * DAY;
      const second = Date.now() - DAY;
      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [note("n1", "the photo once", first, { photo: "shared-1" }), note("n2", "the photo again", second, { photo: "shared-1" })] });
      const days = [civilDay(first, UTC4), civilDay(second, UTC4)];
      await until("the caption on both days", () => days.every((day) => /the photo (once|again) \[fake reply/u.test(dayText(root, day))) && quiet(root));
      expect(readLedger(root, (db) => db.prepare("SELECT count(*) FROM requests WHERE unit = 'photo:shared-1'").pluck().get())).toBe(1);
      artifact(root, "shared-reply-days", Object.fromEntries(days.map((day) => [day, dayText(root, day)])));
    } finally {
      await home.stop();
    }
  });

  it("a recent unit, and one a reply woke, wait behind another family's backfill planning run", async () => {
    const { root, home } = await open("lifestream-derived-plan-live-", { helpers: 3 });
    try {
      const hold = join(root, "plan-hold");
      writeFileSync(hold, "");
      const plan = (family: string) => readHome(root, (db) => db.prepare("SELECT lane, state FROM jobs WHERE kind = 'plan' AND key = ?").get(family)) as { lane: number; state: string } | undefined;
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 2 * HOUR, rows: [note("old", "a month-old note", Date.now() - 30 * DAY, { plan_hold: hold })] });
      await until("the old unit's plan running in backfill", () => plan("notes")?.state === "running");
      expect(plan("notes")).toEqual({ lane: LANE.backfill, state: "running" });
      const t0 = Date.now() - 20 * MINUTE;
      await ship(root, { source: "screen:local:mac-0001", fetched_ms: t0 + 1_000, rows: [{ kind: "frame", key: "f1", content: { at: t0 }, at: t0 }] });
      await ship(root, { source: "screen:local:mac-0001", fetched_ms: t0 + 301_000, rows: [] });
      await until("the sitting's account landed", () => count(root, "SELECT count(*) FROM enrichments WHERE family = 'screen' AND state = 'done'") === 1);
      expect(plan("notes")).toEqual({ lane: LANE.backfill, state: "running" });
      await until("the screen plan done", () => plan("screen")?.state === "done");
      expect(plan("screen")).toEqual({ lane: LANE.live, state: "done" });
      const screenRuns = readHome(root, (db) => db.prepare("SELECT count(*) FROM runs WHERE kind = 'plan' AND subject = 'screen'").pluck().get()) as number;
      expect(screenRuns).toBeGreaterThanOrEqual(2);
      rmSync(hold);
      await until("the held plan done", () => quiet(root));
      expect(count(root, "SELECT count(*) FROM runs WHERE kind = 'plan' AND subject = 'notes'")).toBe(1);
      artifact(root, "plan-live-beside-backfill", { notes: plan("notes"), screen: plan("screen"), screen_runs: screenRuns, day: dayText(root, civilDay(t0, UTC4)) });
    } finally {
      await home.stop();
    }
  });

  it("a plan held while its unit goes and comes back with other content writes nothing, its new mark kept; come back the same, it lands", async () => {
    const { root, home } = await open("lifestream-derived-plan-aba-", { helpers: 3 }, false);
    try {
      const runs = () => readHome(root, (db) => (db.prepare("SELECT counts FROM runs WHERE kind = 'plan' AND subject = 'notes' ORDER BY id").pluck().all() as string[])
        .map((counts) => JSON.parse(counts) as { planned: number; rows: number }));
      const marks = (unit: string) => readHome(root, (db) => db.prepare("SELECT marks FROM dirty_units WHERE family = 'notes' AND unit = ?").pluck().get(unit)) as number | undefined;
      const served = (unit: string) => readHome(root, (db) => db.prepare("SELECT reading FROM extracts WHERE family = 'notes' AND unit = ?").pluck().get(unit)) as string | undefined;
      const asked = (item: string) => count(root, "SELECT count(*) FROM asks WHERE family = 'notes' AND item = ?", item);
      const held = async (key: string, at: number, again: ReturnType<typeof note>) => {
        const hold = join(root, `plan-hold-${key}`);
        writeFileSync(hold, "");
        const unit = unitOf(at);
        await ship(root, { source: SOURCE, fetched_ms: Date.now() - 3 * HOUR, rows: [note(key, `the note ${key}`, at, { photo: true, plan_hold: hold })] });
        await until(`${key}'s plan held`, () => existsSync(`${hold}.held`));
        const first = served(unit);
        await ship(root, { source: SOURCE, fetched_ms: Date.now() - 2 * HOUR, rows: [{ kind: "note", key, content: null, gone: true }] });
        await until(`${key}'s unit gone`, () => served(unit) === undefined && marks(unit) === undefined);
        await ship(root, { source: SOURCE, fetched_ms: Date.now() - HOUR, rows: [again] });
        await until(`${key}'s unit made again, marked once`, () => served(unit) !== undefined && marks(unit) === 1);
        const second = served(unit);
        rmSync(hold);
        await until(`${key}'s plans done`, () => quiet(root));
        return { unit, first, second };
      };
      const before = runs().length;
      const at = Date.now() - 30 * DAY;
      const other = await held("a", at, note("b", "another note", at));
      expect(other.second).not.toBe(other.first);
      expect(runs()[before]).toMatchObject({ planned: 0, rows: 0 });
      expect([asked("photo:a"), marks(other.unit)]).toEqual([0, undefined]);
      const later = at + 2 * DAY;
      const same = await held("c", later, note("c", "the note c", later, { photo: true, plan_hold: join(root, "plan-hold-c") }));
      expect(same.second).toBe(same.first);
      expect(runs().at(-1)).toMatchObject({ planned: 1 });
      expect([asked("photo:c"), marks(same.unit)]).toEqual([1, undefined]);
      artifact(root, "plan-aba", { other, same, runs: runs() });
    } finally {
      await home.stop();
    }
  });

  it("a plan that skipped a unit gone under it lands that unit's mark once the unit is made again", async () => {
    const { root, home } = await open("lifestream-derived-plan-skipped-", { helpers: 3 }, false);
    try {
      const marks = (unit: string) => readHome(root, (db) => db.prepare("SELECT marks FROM dirty_units WHERE family = 'notes' AND unit = ?").pluck().get(unit)) as number | undefined;
      const served = (unit: string) => readHome(root, (db) => db.prepare("SELECT reading FROM extracts WHERE family = 'notes' AND unit = ?").pluck().get(unit)) as string | undefined;
      const asked = (item: string) => count(root, "SELECT count(*) FROM asks WHERE family = 'notes' AND item = ?", item);
      const [first, last] = [join(root, "plan-hold-first"), join(root, "plan-hold-last")];
      writeFileSync(first, "");
      writeFileSync(last, "");
      const at = Date.now() - 40 * DAY;
      const [latest, middle] = [at + 4 * DAY, at + 2 * DAY];
      const unit = unitOf(middle);
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 3 * HOUR, rows: [
        note("v", "the latest note", latest, { plan_hold: first }), note("u", "the middle note", middle, { photo: true }), note("w", "the oldest note", at, { plan_hold: last }),
      ] });
      await until("the run held at the latest day", () => existsSync(`${first}.held`));
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 2 * HOUR, rows: [{ kind: "note", key: "u", content: null, gone: true }] });
      await until("the middle unit gone", () => served(unit) === undefined && marks(unit) === undefined);
      rmSync(first);
      await until("the run held at the oldest day", () => existsSync(`${last}.held`));
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - HOUR, rows: [note("u2", "another middle note", middle, { photo: true })] });
      await until("the middle unit made again, marked once", () => served(unit) !== undefined && marks(unit) === 1);
      rmSync(last);
      await until("the plans done", () => quiet(root));
      expect([asked("photo:u2"), marks(unit)]).toEqual([1, undefined]);
      artifact(root, "plan-skipped", { asked: asked("photo:u2") });
    } finally {
      await home.stop();
    }
  });

  it("a sitting a late frame reopens keeps printing its old account", async () => {
    const { root, home } = await open("lifestream-derived-stale-account-");
    try {
      const screenText = (day: string) => dayText(root, day).split("\n").filter((line) => line.includes("frames")).join("\n");
      const t0 = Math.floor((Date.now() - 30 * MINUTE) / HOUR) * HOUR + 5 * MINUTE;
      const day = civilDay(t0, UTC4);
      await ship(root, { source: "screen:local:mac-0001", fetched_ms: t0 + 1_000, rows: [{ kind: "frame", key: "f1", content: { at: t0 }, at: t0 }] });
      await ship(root, { source: "screen:local:mac-0001", fetched_ms: t0 + 301_000, rows: [] });
      await until("the sitting's account", () => /1 frames: fake reply/u.test(screenText(day)) && quiet(root));
      const first = screenText(day);
      await ship(root, { source: "screen:local:mac-0001", fetched_ms: t0 + 250_000, rows: [{ kind: "frame", key: "f2", content: { at: t0 + 200_000 }, at: t0 + 200_000 }] });
      await until("the reopened sitting", () => screenText(day).includes("2 frames") && quiet(root));
      const reopened = screenText(day);
      expect(reopened).toMatch(/ 2 frames \(open\)$/u);
      expect(count(root, "SELECT count(*) FROM enrichments WHERE family = 'screen' AND state = 'done'")).toBe(0);
      await ship(root, { source: "screen:local:mac-0001", fetched_ms: t0 + 600_000, rows: [], facts: { read_through: new Date(t0 + 520_000).toISOString() } });
      await until("the new account", () => / 2 frames: fake reply/u.test(screenText(day)) && quiet(root));
      const asked = screenText(day);
      expect(asked.slice(asked.indexOf("fake reply"))).not.toBe(first.slice(first.indexOf("fake reply")));
      artifact(root, "stale-account", { day, first, reopened, asked });
    } finally {
      await home.stop();
    }
  });

  it("an account no route sends is written to the ledger, or one a late frame made obsolete is sent once a route comes", async () => {
    const root = makeRoot("lifestream-derived-obsolete-ask-", { sources: { "screen:local:mac-0001": "fake-rows" }, defaults: false });
    roots.push(root);
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    try {
      const t0 = Date.now() - 30 * MINUTE;
      const requests = () => readLedger(root, (db) => db.prepare("SELECT count(*) FROM requests").pluck().get() as number) ?? 0;
      await ship(root, { source: "screen:local:mac-0001", fetched_ms: t0 + 1_000, rows: [{ kind: "frame", key: "f1", content: { at: t0 }, at: t0 }] });
      await ship(root, { source: "screen:local:mac-0001", fetched_ms: t0 + 301_000, rows: [] });
      await until("the account, owed", () => count(root, "SELECT count(*) FROM asks WHERE family = 'screen' AND state = 'pending'") === 1 && quiet(root));
      expect(requests()).toBe(0);
      await ship(root, { source: "screen:local:mac-0001", fetched_ms: t0 + 250_000, rows: [{ kind: "frame", key: "f2", content: { at: t0 + 200_000 }, at: t0 + 200_000 }] });
      await until("the reopened sitting, owing nothing", () => count(root, "SELECT (SELECT count(*) FROM enrichments WHERE family = 'screen') + (SELECT count(*) FROM asks WHERE family = 'screen')") === 0 &&
        count(root, "SELECT count(*) FROM extracts WHERE family = 'screen' AND instr(content, 'f2') > 0") === 1 && quiet(root));
      await askHome(testSocket(root), "models", ["default", "text", FAKE_ROUTE]);
      const ticks = home.stats().ticks.count;
      await until("a tick after the route, and nothing left to run", () => home.stats().ticks.count > ticks && quiet(root));
      const attempts = readLedger(root, (db) => db.prepare("SELECT count(*) FROM attempts").pluck().get() as number);
      expect(home.stats().calls).toBe(0);
      expect(attempts).toBe(0);
      expect(requests()).toBe(0);
      artifact(root, "obsolete-ask", { requests: requests(), attempts, calls: home.stats().calls });
    } finally {
      await home.stop();
    }
  });

  it("a message naming a photo whose bytes have not arrived stops its family's captions, and its own is never asked once they land", async () => {
    const WA = "whatsapp:15550000000:macbook-pro-0001";
    const root = makeRoot("lifestream-derived-absent-photo-", {
      sources: { [WA]: "fake-rows" },
      settings: { "families.messages": {}, "model.transports.fake": { delay_ms: 10 } },
    });
    roots.push(root);
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    try {
      const bytes = { absent: Buffer.from("synthetic photo a"), beside: Buffer.from("synthetic photo b"), other: Buffer.from("synthetic photo c") };
      const blob = (name: keyof typeof bytes) => `sha256:${hex(bytes[name])}`;
      const at = Date.now() - 2 * HOUR;
      const photo = (chat: string, stanza: string, ms: number, file: string) => ({
        kind: "msg", key: `${chat}:${stanza}`, at: ms, blobs: [file],
        content: {
          type: "whatsapp.msg", session_jid: chat, message: { ZMESSAGETYPE: 1, ZISFROMME: 0, ZFROMJID: chat, ZTEXT: null },
          blobs: [{ hash: file, bytes: 17, role: "ZWAMEDIAITEM.ZMEDIALOCALPATH" }],
        },
      });
      const chatA = "15550000001@s.whatsapp.net";
      const chatB = "15550000002@s.whatsapp.net";
      const captions = () => readHome(root, (db) => db.prepare("SELECT item, state FROM enrichments WHERE family = 'messages' ORDER BY item").all()) as { item: string; state: string }[];
      const plan = () => readHome(root, (db) => db.prepare("SELECT state, attempts, error FROM jobs WHERE kind = 'plan' AND key = 'messages'").get()) as { state: string; attempts: number; error: string | null } | undefined;
      const done = (...names: (keyof typeof bytes)[]) => names.map((name) => ({ item: blob(name), state: "done" })).sort((left, right) => left.item < right.item ? -1 : 1);
      await ship(root, { source: WA, fetched_ms: at + MINUTE, rows: [
        photo(chatA, "s1", at, blob("absent")), photo(chatA, "s2", at + 1_000, blob("beside")), photo(chatB, "s3", at + 2_000, blob("other")),
      ], carried: { [hex(bytes.beside)]: bytes.beside, [hex(bytes.other)]: bytes.other } });
      await until("the photos with bytes captioned, or the family's planning failed", () =>
        (quiet(root) && captions().filter((row) => row.state === "done").length === 2) || (plan()?.attempts ?? 0) > 0);
      const before = { captions: captions(), plan: plan(), day: dayText(root, civilDay(at, UTC4)) };
      expect(before.plan).toMatchObject({ attempts: 0, error: null });
      expect(before.captions).toEqual(done("beside", "other"));
      expect(count(root, "SELECT count(*) FROM dirty_units WHERE family = 'messages'")).toBe(0);
      expect(before.day.match(/\[photo(?::[^\]]*)?\]/gu)).toEqual(["[photo]", expect.stringMatching(/^\[photo: fake reply [0-9a-f]{12}\]$/u), expect.stringMatching(/^\[photo: fake reply [0-9a-f]{12}\]$/u)]);
      await ship(root, { source: WA, fetched_ms: at + 10 * MINUTE, rows: [], carried: { [hex(bytes.absent)]: bytes.absent } });
      await until("the late photo captioned", () => quiet(root) && captions().filter((row) => row.state === "done").length === 3);
      expect(captions()).toEqual(done("absent", "beside", "other"));
      await until("the day rendered with every caption", () => !dayText(root, civilDay(at, UTC4)).includes("[photo]"));
      expect(plan()).toMatchObject({ attempts: 0, error: null });
      artifact(root, "absent-photo", { before, after: { captions: captions(), plan: plan(), day: dayText(root, civilDay(at, UTC4)) } });
    } finally {
      await home.stop();
    }
  });

  it("an ask whose attachment the home does not hold fails its family's plan job", async () => {
    const { root, home } = await open("lifestream-derived-absent-attachment-");
    try {
      const base = Date.UTC(2026, 5, 1, 12, 0);
      const absent = `sha256:${hex(Buffer.from("never shipped"))}`;
      const plan = () => readHome(root, (db) => db.prepare("SELECT state, attempts, error FROM jobs WHERE kind = 'plan' AND key = 'notes'").get()) as { state: string; attempts: number; error: string | null };
      const dirty = () => readHome(root, (db) => db.prepare("SELECT unit, error FROM dirty_units ORDER BY unit").all()) as { unit: string; error: string | null }[];
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - HOUR, rows: [
        note("a", "a photo never shipped", base, { photo: true, images: [absent] }), note("b", "a photo of the next day", base + DAY, { photo: true }),
      ] });
      await until("the absent file's unit set aside", () => dirty().some((row) => row.error !== null) || plan().attempts > 0);
      expect(plan()).toMatchObject({ attempts: 0, error: null });
      expect(dirty()).toEqual([{ unit: unitOf(base), error: `blob ${absent} is not stored` }]);
      await until("the next day's caption answered", () => count(root, "SELECT count(*) FROM enrichments WHERE family = 'notes' AND item = 'photo:b' AND state = 'done'") === 1);
      artifact(root, "absent-attachment", { plan: plan(), dirty: dirty() });
    } finally {
      await home.stop();
    }
  });
});
