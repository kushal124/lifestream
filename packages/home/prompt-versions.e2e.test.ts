import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { civilDay, openHome, openHomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import { startHome } from "./home.js";
import { HELD_META } from "./prompts.js";
import { askHome } from "./socket.js";
import { readOpsSettings } from "./verbs/context.js";
import { artifact, FAKES, readHome, readLedger, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { statusOf } from "./test/harness-status.js";
import { editSettings, testSocket } from "./test/folder.js";
import { count, DAY, dayText, derivedHomes, HOUR, MINUTE, note, quiet, SOURCE, UTC4 } from "./test/derived.js";

const SCREEN = "screen:local:mac-0001";

const meta = (root: string, key: string): string | undefined => readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(key)) as string | undefined;
const asks = (root: string, family: string) => readHome(root, (db) =>
  db.prepare("SELECT item, prompt, prompt_version AS version, state FROM asks WHERE family = ? ORDER BY item").all(family)) as { item: string; prompt: string; version: number; state: string }[];
const requests = (root: string): number => readLedger(root, (db) => db.prepare("SELECT count(*) FROM requests").pluck().get() as number) ?? 0;
const plans = (root: string, family: string): number => count(root, "SELECT count(*) FROM runs WHERE kind = 'plan' AND subject = ?", family);
const restart = (root: string) => startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });

async function twoNotes(root: string): Promise<string[]> {
  const first = Date.now() - 3 * DAY;
  const second = Date.now() - DAY;
  await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [note("n1", "a first photo", first, { photo: true }), note("n2", "a second photo", second, { photo: true })] });
  const days = [civilDay(first, UTC4), civilDay(second, UTC4)];
  await until("both captions on their days", () => days.every((day) => /photo \[fake reply/u.test(dayText(root, day))) && quiet(root));
  return days;
}

async function sitting(root: string): Promise<string> {
  const t0 = Math.floor(Date.now() / DAY) * DAY - DAY + 12 * HOUR + 5 * MINUTE;
  await ship(root, { source: SCREEN, fetched_ms: t0 + 1_000, rows: [{ kind: "frame", key: "f1", content: { at: t0 }, at: t0 }] });
  await ship(root, { source: SCREEN, fetched_ms: t0 + 330_000, rows: [], facts: { read_through: new Date(t0 + 301_000).toISOString() } });
  return civilDay(t0, UTC4);
}

describe("prompt versions: a release moves a version, and the home asks again while the day keeps its answers", () => {
  const { open } = derivedHomes();

  it("a fresh home keeps each version and holds nothing (17)", async () => {
    const { root, home } = await open("lifestream-pv-fresh-");
    try {
      await twoNotes(root);
      expect(meta(root, "prompt:fake-caption")).toBe("1");
      expect(meta(root, "prompt:fake-sitting")).toBe("1");
      expect(meta(root, HELD_META)).toBeUndefined();
      expect(asks(root, "notes")).toEqual([
        { item: "photo:n1", prompt: "fake-caption", version: 1, state: "done" },
        { item: "photo:n2", prompt: "fake-caption", version: 1, state: "done" },
      ]);
      artifact(root, "fresh", { asks: asks(root, "notes"), version: meta(root, "prompt:fake-caption") });
    } finally {
      await home.stop();
    }
    const before = { plans: plans(root, "notes"), requests: requests(root) };
    const again = await restart(root);
    try {
      const ticks = again.stats().ticks.count;
      await until("a tick after the start, and nothing left to run", () => again.stats().ticks.count > ticks && quiet(root));
      expect({ plans: plans(root, "notes"), requests: requests(root) }).toEqual(before);
    } finally {
      await again.stop();
    }
  });

  it("a bump with keeps [] marks every unit and makes every item pending, and the day keeps each caption until its new one lands (6)", async () => {
    const { root, home } = await open("lifestream-pv-bump-");
    let days: string[];
    try {
      days = await twoNotes(root);
      await askHome(testSocket(root), "pause", ["send:notes", "--reason", "the test reads what the bump owes"]);
    } finally {
      await home.stop();
    }
    const before = { days: days.map((day) => dayText(root, day)), plans: plans(root, "notes"), requests: requests(root) };
    editSettings(root, { "families.notes": { caption: { version: 2, keeps: [], text: "Describe the photo in a new way." } } });
    const again = await restart(root);
    try {
      expect(meta(root, "prompt:fake-caption")).toBe("2");
      await until("every item pending under version 2", () => asks(root, "notes").every((row) => row.version === 2 && row.state === "pending") && quiet(root));
      expect(asks(root, "notes").map((row) => row.item)).toEqual(["photo:n1", "photo:n2"]);
      expect(plans(root, "notes")).toBeGreaterThanOrEqual(before.plans + 2);
      expect(requests(root)).toBe(before.requests);
      const held = days.map((day) => dayText(root, day));
      expect(held).toEqual(before.days);
      await askHome(testSocket(root), "resume", ["send:notes"]);
      await until("each new caption on its day", () => days.every((day, at) => /photo \[fake reply/u.test(dayText(root, day)) && dayText(root, day) !== before.days[at]) && quiet(root));
      expect(asks(root, "notes").map((row) => [row.item, row.version, row.state])).toEqual([["photo:n1", 2, "done"], ["photo:n2", 2, "done"]]);
      expect(requests(root)).toBe(before.requests + 2);
      artifact(root, "bump", { before: before.days, held, after: days.map((day) => dayText(root, day)) });
    } finally {
      await again.stop();
    }
  });

  it("a chain's redo keeps the sitting's account until the redone chain ends in a new one (7)", async () => {
    const { root, home } = await open("lifestream-pv-chain-", { "families.screen": { chain: true } });
    const account = (day: string) => dayText(root, day).split("\n").filter((line) => line.includes("frames")).join("\n");
    let day: string;
    try {
      day = await sitting(root);
      await until("the sitting's account", () => /1 frames: fake reply/u.test(account(day)) && quiet(root));
      await askHome(testSocket(root), "pause", ["send:screen", "--reason", "the test reads the day while the chain is owed"]);
    } finally {
      await home.stop();
    }
    const first = account(day);
    const requested = requests(root);
    editSettings(root, { "families.screen": { chain: true, part: { version: 2, keeps: [], text: "Say anew what the part of the sitting shows." } } });
    const again = await restart(root);
    try {
      await until("the part pending under version 2", () => asks(root, "screen").some((row) => row.prompt === "fake-part" && row.version === 2 && row.state === "pending") && quiet(root));
      const owed = asks(root, "screen");
      expect(owed.map((row) => [row.prompt, row.version, row.state])).toEqual([["fake-part", 2, "pending"]]);
      expect(account(day)).toBe(first);
      expect(requests(root)).toBe(requested);
      await askHome(testSocket(root), "resume", ["send:screen"]);
      await until("the redone chain's account", () => /1 frames: fake reply/u.test(account(day)) && account(day) !== first && quiet(root));
      expect(requests(root)).toBe(requested + 2);
      artifact(root, "chain", { first, owed, after: account(day) });
    } finally {
      await again.stop();
    }
  });

  it("a chain's account leaves the day when the plan refuses a reply of the chain, though its input is the same", async () => {
    const { root, home } = await open("lifestream-pv-chain-refused-", { "families.screen": { chain: true } });
    const account = (day: string) => dayText(root, day).split("\n").filter((line) => line.includes("frames")).join("\n");
    let day: string;
    try {
      day = await sitting(root);
      await until("the sitting's account", () => /1 frames: fake reply/u.test(account(day)) && quiet(root));
      await askHome(testSocket(root), "pause", ["send:screen", "--reason", "the test reads the day after a refusal"]);
    } finally {
      await home.stop();
    }
    const first = account(day);
    const unit = readHome(root, (db) => db.prepare("SELECT unit FROM extracts WHERE family = 'screen'").pluck().get()) as string;
    const write = openHome(openHomeFolder(root), "migrate");
    write.commit((tx) => tx.tables.dirty.units("screen", [unit]));
    write.close();
    editSettings(root, { "families.screen": { chain: true, refuse: true } });
    const planned = plans(root, "screen");
    const again = await restart(root);
    try {
      await until("the unit planned again", () => plans(root, "screen") > planned && count(root, "SELECT count(*) FROM dirty_units") === 0 && count(root, "SELECT count(*) FROM dirty_days") === 0 &&
        count(root, "SELECT count(*) FROM jobs WHERE state = 'running' OR (state = 'queued' AND kind <> 'send')") === 0);
      expect(readHome(root, (db) => db.prepare("SELECT count(*) FROM enrichments WHERE family = 'screen'").pluck().get())).toBe(0);
      expect(account(day)).toMatch(/^\S+ 1 frames$/u);
      artifact(root, "chain-refused", { first, after: account(day) });
    } finally {
      await again.stop();
    }
  });

  it("a type the ledger recorded otherwise holds the prompt: Status names it, nothing is planned or sent, the day keeps its captions (10)", async () => {
    const { root, home } = await open("lifestream-pv-held-");
    let days: string[];
    try {
      days = await twoNotes(root);
    } finally {
      await home.stop();
    }
    const before = { days: days.map((day) => dayText(root, day)), plans: plans(root, "notes"), requests: requests(root) };
    const gist: JsonObject = { type: "object", properties: { gist: { type: "string" } }, required: ["gist"], additionalProperties: false };
    editSettings(root, { "families.notes": { caption: { type: gist, text: "Describe the photo as JSON." } } });
    const again = await restart(root);
    try {
      expect(JSON.parse(meta(root, HELD_META) ?? "{}")).toEqual({ "fake-caption": { family: "notes", faults: [expect.stringMatching(/^version 1's answer type changed: give it a new version/u)] } });
      const third = Date.now() - 2 * DAY;
      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [note("n3", "a third photo", third, { photo: true })] });
      await until("the new note on its day", () => dayText(root, civilDay(third, UTC4)).includes("a third photo") && count(root, "SELECT count(*) FROM jobs WHERE state = 'running'") === 0 &&
        count(root, "SELECT count(*) FROM dirty_days") === 0);
      expect(dayText(root, civilDay(third, UTC4))).toMatch(/a third photo \[photo\]/u);
      expect(days.map((day) => dayText(root, day))).toEqual(before.days);
      expect(plans(root, "notes")).toBe(before.plans);
      expect(requests(root)).toBe(before.requests);
      expect(again.stats().calls).toBe(0);
      const notice = statusOf(root, { now_ms: Date.now(), settings: readOpsSettings(root) }).notices.find((each) => each.id === "prompt:fake-caption");
      expect(notice?.what).toMatch(/^fake-caption version 1's answer type changed: give it a new version .*; notes plans and sends nothing until a release fixes it$/u);
      artifact(root, "held", { notice, days: days.map((day) => dayText(root, day)) });
    } finally {
      await again.stop();
    }
  });
});
