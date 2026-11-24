import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { digest, piecesText, type Ask, type DaySettings, type Json, type Reply, type ReaderOutput } from "@lifestreamprotocol/core";
import { checkDayFile, type DayDocument } from "../days.js";
import type { Family } from "../family.js";
import { buildLabels } from "../shared/labels.js";
import { COMPOSE_PROMPT, PART_PROMPT, SITTING_PROMPT } from "../screen/account.js";
import { screenFamily, SCREEN_PROMPTS } from "../screen/family.js";
import { FED } from "../test/fed.js";
import { pin } from "../test/pin.js";
import { FakeLedger, replyOf, ROUTE, TestHome } from "../test/drive.js";
import { phoneFamily } from "../phone/family.js";
import { SEEN_MS, webFamily, type WebHour, type WebItem } from "./family.js";

const GOLDEN = new URL("./test/web.golden.json", import.meta.url);
const UPDATE = process.env.LIFESTREAM_UPDATE_GOLDEN === "1";
const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const LABELS = buildLabels({ people: [], contacts: [], places: [] });
const MACHINE = "macbook-pro-0001";
const RECORDER = `screen:local:${MACHINE}`;
const OTHER_MAC = "mac-mini-bb01";
const CHROME = `chrome:profile-2:${MACHINE}`;
const SAFARI = `safari:person-a@example.com:${MACHINE}`;
const LOG = `screen-time:person-a@example.com:${MACHINE}`;
const DAY = "2026-10-06";
const S = 1_000;
const MIN = 60 * S;
const at = (iso: string) => Date.parse(iso);
const SITTING_1 = at("2026-10-06T13:00:00Z");
const SITTING_2 = at("2026-10-06T19:00:00Z");


function basic(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/gu, "").replace(".000", "");
}

function frames(from: number, to: number, every: number, app: string, title: string, site: string | null): ReaderOutput[] {
  const rows: ReaderOutput[] = [];
  for (let t = from; t < to; t += every) {
    rows.push({
      kind: "frame", key: basic(t), time: { start_ms: t, precision: "ms" },
      content: {
        type: "screen.lifestream.frame", status: "captured", ocrStatus: "ok", displayID: 1,
        application: { bundleID: `com.example.${app.toLowerCase()}`, name: app, pid: 42 }, frontWindow: { windowID: 7 },
        windows: [{ windowID: 7, title }], ocr: [{ text: `${title}: synthetic line` }], ...(site === null ? {} : { site }),
      },
    });
  }
  return rows;
}

function dayFrames(): ReaderOutput[] {
  return [
    ...frames(SITTING_1, SITTING_1 + 40 * MIN, 10 * S, "Browser", "Code review", "code.example"),
    ...frames(SITTING_1 + 40 * MIN, SITTING_1 + 90 * MIN, 10 * S, "Editor", "notes.txt", null),
    ...frames(SITTING_2, SITTING_2 + 20 * MIN, 10 * S, "Browser", "Headlines", "www.news.example"),
  ];
}

function chromeTime(ms: number): string {
  return String(BigInt(ms) * 1000n + 11_644_473_600_000_000n);
}

let visitId = 0;
function chromeVisit(t: number, url: string, title: string, options: { transition?: number; synced?: boolean; hidden?: boolean; tab?: number; foreground?: number; from?: number; page?: number } = {}): ReaderOutput {
  const id = ++visitId;
  const page = options.page ?? id;
  const context = options.tab === undefined ? null : { visit_id: id, context_annotation_flags: 0, duration_since_last_visit: 0, page_end_reason: 1, total_foreground_duration: options.foreground ?? 0, browser_type: 1, window_id: 9, tab_id: options.tab, task_id: 0, root_task_id: 0, parent_task_id: 0, response_code: 200 };
  return {
    kind: "page-visit", key: `${id}:${chromeTime(t)}`, time: { start_ms: t, precision: "ms" },
    content: {
      type: "chrome.visit",
      visit: {
        id, url: page, visit_time: chromeTime(t), from_visit: options.from ?? 0, external_referrer_url: "", transition: options.transition ?? 0x30000000,
        segment_id: 0, visit_duration: 0, incremented_omnibox_typed_score: 0, opener_visit: 0, originator_cache_guid: "",
        originator_visit_id: 0, originator_from_visit: 0, originator_opener_visit: 0, is_known_to_sync: 0,
        consider_for_ntp_most_visited: 1, visited_link_id: 0, app_id: null,
      },
      url: { id: page, url, title, hidden: options.hidden === true ? 1 : 0 },
      visit_source: options.synced === true ? { id, source: 0 } : null, context_annotations: context, content_annotations: null,
    },
  };
}

function chromeSearch(t: number, url: string, term: string): ReaderOutput {
  return {
    kind: "search", key: `search-${digest([term, url]).slice(7, 19)}`, time: { start_ms: t, precision: "ms" },
    content: {
      type: "chrome.search", term: { keyword_id: 7, url_id: 900, term, normalized_term: term },
      url: { id: 900, url, title: `${term} - Search`, visit_count: 2, typed_count: 0, last_visit_time: chromeTime(t), hidden: 0 },
    },
  };
}

function chromeDownload(t: number, file: string, url: string, by_ext_name = "", id = "DOWNLOAD0001"): ReaderOutput {
  return {
    kind: "download", key: `SYNTH-0000-0000-0000-${id}`, time: { start_ms: t, end_ms: t + 2 * S, precision: "ms" },
    content: {
      type: "chrome.download",
      download: { id: 1, guid: `SYNTH-0000-0000-0000-${id}`, by_ext_name, target_path: `/tmp/synthetic/${file}`, current_path: `/tmp/synthetic/${file}`, start_time: chromeTime(t), end_time: chromeTime(t + 2 * S), state: 1, received_bytes: 1024, total_bytes: 1024 },
      url_chain: [{ id: 1, chain_index: 0, url }], slices: [],
    },
  };
}

function coreData(ms: number): number {
  return ms / 1000 - 978_307_200;
}

function safariVisit(t: number, url: string, title: string, options: { origin?: number; redirectsTo?: number } = {}): ReaderOutput {
  const id = ++visitId;
  return {
    kind: "page-visit", key: `${id}:${coreData(t)}`, time: { start_ms: t, precision: "ms" },
    content: {
      type: "safari.visit",
      visit: { id, history_item: id, visit_time: coreData(t), title, load_successful: 1, http_non_get: 0, synthesized: 0, redirect_source: null, redirect_destination: options.redirectsTo ?? null, origin: options.origin ?? 0, generation: 1, attributes: 0, score: 10 },
      item: { id, url, domain_expansion: null },
    },
  };
}

function safariTab(t: number, title: string, url: string): ReaderOutput {
  return {
    kind: "tab", key: "SYNTH-TAB-0001", time: { start_ms: t, precision: "ms" },
    content: {
      type: "safari.tab",
      tab: { tab_uuid: "SYNTH-TAB-0001", system_fields: { $bytes64: "Ag==" }, device_uuid: "SYNTH-DEVICE-0001", position: { $bytes64: "Aw==" }, title, url, is_showing_reader: 0, is_pinned: 0, reader_scroll_position_page_index: null, scene_id: "scene-1", last_viewed_time: coreData(t) },
      device: { device_uuid: "SYNTH-DEVICE-0001", system_fields: { $bytes64: "AQ==" }, device_name: "Synthetic Phone", device_type_identifier: "com.example.phone", has_duplicate_device_name: 0, is_ephemeral_device: 0, last_modified: coreData(t) },
      close_requests: [],
    },
  };
}

function chromeDay(): ReaderOutput[] {
  visitId = 0;
  const rows: ReaderOutput[] = [];
  for (let i = 0; i < 120; i++) rows.push(chromeVisit(SITTING_1 + 5 * S + i * 20 * S, `https://code.example/change/${i}`, `Change ${i % 30}`));
  for (let i = 0; i < 50; i++) rows.push(chromeVisit(SITTING_1 + 41 * MIN + i * 50 * S, `https://www.docs.example/ref/${i}`, "Reference"));
  for (let i = 0; i < 28; i++) rows.push(chromeVisit(SITTING_1 + 10 * MIN + i * 61 * S, `https://mail.example/inbox/${i}`, `Inbox (${i})`));
  const search = "https://search.example/?q=synthetic+query";
  rows.push(chromeVisit(SITTING_1 + 20 * MIN + 30 * S, search, "synthetic query - Search", { transition: 0x30000001 }));
  rows.push(chromeVisit(SITTING_1 + 50 * MIN, search, "synthetic query - Search", { transition: 0x30000008 }));
  rows.push(chromeSearch(SITTING_1 + 50 * MIN, search, "synthetic query"));
  for (let i = 0; i < 5; i++) rows.push(chromeVisit(SITTING_1 + 12 * MIN + i * S, `https://ads.example/frame/${i}`, "Ad", { transition: 3 }));
  for (let i = 0; i < 3; i++) rows.push(chromeVisit(SITTING_1 + 14 * MIN + i * S, `https://redirect.example/${i}`, "Redirecting", { transition: 0x10000000 }));
  rows.push(chromeVisit(SITTING_1 + 16 * MIN, "https://code.example/hidden", "Hidden", { hidden: true }));
  rows.push(chromeDownload(SITTING_1 + 30 * MIN, "report.pdf", "https://files.example/report.pdf"));
  rows.push(chromeVisit(SITTING_1 + 15 * MIN, "https://phone-news.example/story", "A story", { synced: true }));
  rows.push(chromeVisit(at("2026-10-06T16:00:00Z"), "https://feed.example/refresh", "Feed"));
  return rows;
}

function safariDay(): ReaderOutput[] {
  return [
    safariVisit(SITTING_1 + 16 * MIN, "https://recipes.example/soup", "Soup", { origin: 1 }),
    safariVisit(SITTING_2 + 5 * MIN - S, "https://news.example/", "Redirecting", { redirectsTo: 999 }),
    safariVisit(SITTING_2 + 5 * MIN, "https://www.news.example/today", "Headlines"),
    safariTab(at("2026-10-06T11:30:00Z"), "Tab One", "https://example.com/one"),
  ];
}

function phoneFocus(): ReaderOutput[] {
  const device = "0000BBBB-0000-4000-8000-000000000002";
  return [[SITTING_1 + 30 * MIN, 1], [SITTING_1 + 35 * MIN, 0]].map(([t, coming], index): ReaderOutput => ({
    kind: "app-focus", key: `${device}:${basic(t!)}:com.example.chat:${coming === 1 ? "in" : "out"}`, time: { start_ms: t!, precision: "ms" },
    content: { type: "biome.app-in-focus", format: 10, written: t! / 1000 - 978_307_200, fields: { "3": coming!, "4": t! / 1000 - 978_307_200, "6": "com.example.chat" } },
    locator: `remote/${device}/810000000000000.segb:entry ${index + 1}`,
  }));
}


function fakeModel(ask: Ask): string {
  const input = piecesText(ask.input);
  if (ask.prompt === SITTING_PROMPT) {
    const labels = [...new Set([...input.matchAll(/"tasks":\{([^}]*)\}/gu)].flatMap((match) => [...match[1]!.matchAll(/"([^"]+)":/gu)].map((label) => label[1]!)))];
    return JSON.stringify({ summary: "One sitting, merged.", tasks: Object.fromEntries(labels.map((label) => [label, `${label}, whole sitting`])), people: [], projects: ["synthetic project"], other: [] });
  }
  const stretch = ask.prompt === PART_PROMPT
    ? /This call covers (\d\d:\d\d:\d\d)–(\d\d:\d\d:\d\d)/u.exec(input)
    : /^STRETCH: (\d\d:\d\d:\d\d) to (\d\d:\d\d:\d\d)/mu.exec(input);
  if (stretch === null) return "no stretch";
  const part = ask.prompt === COMPOSE_PROMPT ? /"doing":"([^"]*)"/u.exec(input) : null;
  const doing = part !== null ? part[1]! : "Worked at the Mac";
  return JSON.stringify({
    summary: `${doing}.`,
    timeline: [{ start: stretch[1], end: stretch[2], present: "yes", present_why: "typing", doing, task: "synthetic task", where: "" }],
    actions: [],
    life: { people: [], projects: ["synthetic project"], other: [] },
  });
}

const SCREEN_ROUTE = { ...ROUTE, model: "gpt-6-luna" };

function screenRequests(home: TestHome, screen: Family): { sent: string[]; extracts: string[] } {
  const ledger = new FakeLedger(SCREEN_ROUTE);
  for (const extract of home.extracts("screen")) {
    const answered = new Map<string, Reply>();
    for (let round = 0; round < 20; round++) {
      const plan = screen.plan!(extract, answered);
      if (plan.asks.length === 0) break;
      for (const ask of plan.asks) {
        const key = ledger.key(screen, ask);
        ledger.sent.push(`${ask.prompt} ${ask.item} ${key}`);
        answered.set(ask.item, replyOf(SCREEN_PROMPTS[ask.prompt]!, key, ledger.route.model, fakeModel(ask))!);
      }
    }
    expect(screen.plan!(extract, answered).answers?.map((answer) => answer.item)).toEqual([extract.unit]);
  }
  return { sent: ledger.sent, extracts: home.extracts("screen").map((row) => `${row.unit} ${row.reading} ${digest(row.content)}`) };
}


const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.close();
});

function open(prefix: string): { home: TestHome; screen: Family; web: Family } {
  const screen = screenFamily({ zone: SETTINGS.zone })(FED.screen);
  const web = webFamily({ screen: FED.screen })(FED.web);
  const home = new TestHome(`families-web-${prefix}-`, { families: [screen, web], settings: SETTINGS });
  homes.push(home);
  return { home, screen, web };
}

function landDay(home: TestHome, order: "screen-first" | "browsers-first" = "screen-first"): void {
  const screen = () => home.deliver(RECORDER, at("2026-10-06T21:00:00Z"), dayFrames());
  const browsers = () => {
    home.deliver(CHROME, at("2026-10-06T21:05:00Z"), chromeDay());
    home.deliver(SAFARI, at("2026-10-06T21:05:00Z"), safariDay());
  };
  if (order === "screen-first") {
    screen();
    browsers();
  } else {
    browsers();
    screen();
  }
}

function webDay(home: TestHome): { items: WebItem[] } {
  const rows = home.extracts("web");
  for (const row of rows) expect(row.unit).toMatch(new RegExp(`^${MACHINE}/${DAY}T\\d{2}$`, "u"));
  return { items: rows.flatMap((row) => (row.content as unknown as WebHour).items) };
}

function block(txt: string, title: RegExp): string[] {
  const lines = txt.split("\n");
  const start = lines.findIndex((line) => title.test(line));
  if (start < 0) return [];
  const out = [lines[start]!];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("  ")) break;
    out.push(line);
  }
  return out;
}


describe("web: what must be impossible", () => {
  it("a browser or phone record moves one of the screen's paid asks or rewrites a screen extract", () => {
    const screen = screenFamily({ zone: SETTINGS.zone })(FED.screen);
    const before = new TestHome("families-web-before-", { families: [screen], settings: SETTINGS });
    homes.push(before);
    before.deliver(RECORDER, at("2026-10-06T21:00:00Z"), dayFrames());
    const asked = screenRequests(before, screen);
    expect(asked.sent).toHaveLength(4);

    const after = new TestHome("families-web-after-", { families: [screen, webFamily({ screen: FED.screen })(FED.web), phoneFamily()(FED.phone)], settings: SETTINGS });
    homes.push(after);
    after.deliver(RECORDER, at("2026-10-06T21:00:00Z"), dayFrames());
    const landed = [
      after.deliver(CHROME, at("2026-10-06T21:05:00Z"), chromeDay()),
      after.deliver(SAFARI, at("2026-10-06T21:05:00Z"), safariDay()),
      after.deliver(LOG, at("2026-10-06T21:05:00Z"), phoneFocus()),
    ];
    for (const delivered of landed) {
      expect(delivered.touched.filter((unit) => unit.startsWith("screen "))).toEqual([]);
      expect(delivered.written.filter((unit) => unit.startsWith("screen "))).toEqual([]);
    }
    expect(landed.map((delivered) => delivered.written.length > 0)).toEqual([true, true, true]);
    expect(screenRequests(after, screen)).toEqual(asked);
    after.artifact("screen-requests", asked);
    checkGolden("screen_requests", asked.sent);
  });

  it("a visit made in a sitting prints outside its block, or a sitting of 200 visits prints 200 lines", () => {
    const { home, screen, web } = open("sitting");
    landDay(home);
    const content = webDay(home);
    const inFirst = content.items.filter((item) => item.sitting === SITTING_1);
    expect(inFirst.filter((item) => item.what === "visit")).toHaveLength(198);
    expect(inFirst.filter((item) => item.what === "search")).toHaveLength(2);
    expect(content.items.filter((item) => /ads|redirect|Hidden|Redirecting/u.test(`${item.site} ${item.title}`))).toEqual([]);

    const day = home.render(DAY, LABELS, undefined, [screen, web]);
    const sitting = block(day.txt, /^09:00–10:29 Screen: /u);
    expect(sitting).toEqual([
      "09:00–10:29 Screen: Editor 50 min, Browser 40 min (3)",
      "  09:00–10:29 89.8 min at the Mac (account pending)",
      "  09:00–09:39 Chrome: visited code.example 120 times: \"Change 0\", \"Change 1\", \"Change 2\" and 27 other titles (on screen)",
      "  09:10–09:37 Chrome: visited mail.example 28 times: \"Inbox (0)\", \"Inbox (1)\", \"Inbox (2)\" and 25 other titles",
    ]);
    expect(block(day.txt, /^09:20–10:21 Web in the 09:00 sitting/u)).toEqual([
      "09:20–10:21 Web in the 09:00 sitting (3)",
      "  09:20–09:50 Chrome: searched \"synthetic query\" (2 times)",
      "  09:30 Chrome: downloaded report.pdf from files.example",
      "  09:41–10:21 Chrome: visited docs.example 50 times: \"Reference\"",
    ]);
    expect(checkDayFile(JSON.parse(day.json))).toEqual([]);
    home.artifact("sitting-block", { sitting });
  });

  it("a synced visit prints in a Mac sitting, or a visit outside every sitting is lost or prints without its device", () => {
    const { home, screen, web } = open("outside");
    landDay(home);
    const content = webDay(home);
    for (const item of content.items.filter((each) => each.device !== null)) expect(item.sitting).toBeNull();
    const day = home.render(DAY, LABELS, undefined, [screen, web]);
    const txt = day.txt.split("\n");
    expect(txt).toContain("07:30 Safari on Synthetic Phone · tab open: \"Tab One\" (example.com)");
    expect(txt).toContain("09:15 Chrome, synced from another device · visited phone-news.example: \"A story\"");
    expect(txt).toContain("09:16 Safari, synced from another device · visited recipes.example: \"Soup\"");
    expect(txt).toContain("12:00 Chrome · visited feed.example: \"Feed\"");
    const atoms = (JSON.parse(day.json) as { atoms: { family: string; record?: { key: string } }[] }).atoms.filter((atom) => atom.family === "web");
    expect(atoms.length).toBeGreaterThan(0);
    home.artifact("outside", { txt: day.txt });
  });

  it("a line over two Chrome profiles states one profile's account and not the other's", () => {
    const { home, screen, web } = open("profiles");
    home.deliver(CHROME, at("2026-10-06T21:05:00Z"), [chromeVisit(at("2026-10-06T16:30:00Z"), "https://shared.example/a", "Work page"), chromeVisit(at("2026-10-06T18:00:00Z"), "https://alone.example/", "Alone")]);
    home.deliver(`chrome:default:${MACHINE}`, at("2026-10-06T21:05:00Z"), [chromeVisit(at("2026-10-06T16:31:00Z"), "https://shared.example/b", "Own page")]);
    const atoms = (JSON.parse(home.render(DAY, LABELS, undefined, [screen, web]).json) as DayDocument).atoms.filter((atom) => atom.family === "web");
    expect(atoms.map((atom) => [atom.text, atom.accounts])).toEqual([
      ['visited shared.example 2 times: "Work page", "Own page"', ["chrome:default", "chrome:profile-2"]],
      ['visited alone.example: "Alone"', undefined],
    ]);
  });

  it("a title cut to its length splits a character in two, so the day file holds half of one", () => {
    const { home, screen, web } = open("emoji");
    home.deliver(CHROME, at("2026-10-06T21:05:00Z"), [chromeVisit(at("2026-10-06T17:00:00Z"), "https://long.example/", `${"a".repeat(78)}\u{1F389} and the rest`)]);
    const day = home.render(DAY, LABELS, undefined, [screen, web]);
    expect(day.txt.split("\n")).toContain(`13:00 Chrome · visited long.example: "${"a".repeat(78)}…"`);
    expect(day.json.match(/\\u[dD][89abAB][0-9a-fA-F]{2}/gu)).toBeNull();
    expect(checkDayFile(JSON.parse(day.json))).toEqual([]);
    for (const atom of (JSON.parse(day.json) as { atoms: { text: string }[] }).atoms) expect(atom.text.isWellFormed()).toBe(true);
  });

  it("a day of one Mac names it, or a day of two names a Mac by its unit or by nothing", () => {
    const { home, screen, web } = open("macs");
    landDay(home);
    const names = new Map([[MACHINE, "Test Mac"], [OTHER_MAC, "Mac mini"]]);
    const lines = (txt: string) => txt.slice(0, txt.indexOf("\nCoverage\n"));
    const one = lines(home.render(DAY, LABELS, undefined, [screen, web], undefined, (unit) => names.get(unit)).txt);
    expect(one).not.toContain(MACHINE);
    expect(one).not.toContain("Test Mac");
    home.deliver(`chrome:default:${OTHER_MAC}`, at("2026-10-06T21:05:00Z"), [chromeVisit(at("2026-10-06T17:30:00Z"), "https://other.example/", "Other")]);
    const two = home.render(DAY, LABELS, undefined, [screen, web], undefined, (unit) => names.get(unit));
    const txt = two.txt.split("\n");
    expect(txt).toContain("12:00 Chrome on Test Mac · visited feed.example: \"Feed\"");
    expect(txt).toContain("13:30 Chrome on Mac mini · visited other.example: \"Other\"");
    expect(txt).toContain("09:20–10:21 Web in the 09:00 sitting on Test Mac (3)");
    expect(lines(two.txt)).not.toContain(MACHINE);
    expect(lines(two.txt)).not.toContain(OTHER_MAC);
    const renamed = home.render(DAY, LABELS, undefined, [screen, web], undefined, (unit) => unit === MACHINE ? "Work Mac" : names.get(unit));
    expect(renamed.inputs).not.toBe(two.inputs);
    expect(renamed.txt).toContain("12:00 Chrome on Work Mac · visited feed.example: \"Feed\"");
    home.artifact("macs", { one, two: two.txt });
  });

  it("a page seen on a frame and in history prints twice, or without the frame's word", () => {
    const { home, screen, web } = open("seen");
    landDay(home);
    const content = webDay(home);
    const news = content.items.filter((item) => item.site === "news.example");
    expect(news.map((item) => [item.sitting, item.seen])).toEqual([[SITTING_2, true]]);
    const day = home.render(DAY, LABELS, undefined, [screen, web]);
    expect(block(day.txt, /^15:00–15:19 Screen/u)).toEqual([
      "15:00–15:19 Screen: Browser 20 min (2)",
      "  15:00–15:19 19.8 min at the Mac (account pending)",
      "  15:05 Safari: visited news.example: \"Headlines\" (on screen)",
    ]);
    expect(content.items.filter((item) => item.site === "docs.example").every((item) => item.seen === false)).toBe(true);
    const atoms = (JSON.parse(day.json) as DayDocument).atoms.filter((atom) => atom.family === "web");
    expect(atoms.filter((atom) => atom.text.includes(" news.example")).map((atom) => [atom.text, atom.accounts])).toEqual([
      ['Safari: visited news.example: "Headlines" (on screen)', ["safari:person-a@example.com", "screen:local"]],
    ]);
    const unseen = atoms.filter((atom) => atom.text.includes("docs.example"));
    expect(unseen.length).toBeGreaterThan(0);
    expect(unseen.filter((atom) => atom.accounts?.includes("screen:local") === true)).toEqual([]);
  });

  it("frames landing after the visits leave them outside, or the order deliveries land in changes an extract", () => {
    const first = open("first").home;
    landDay(first);
    const second = open("second").home;
    landDay(second, "browsers-first");
    const rows = (home: TestHome) => home.extracts("web").map((row) => ({ unit: row.unit, reading: row.reading, days: row.days }));
    expect(rows(second)).toEqual(rows(first));
    expect(webDay(second).items.filter((item) => item.sitting === SITTING_1)).toHaveLength(201);
    second.artifact("order", { first: rows(first), second: rows(second) });
  });

  it("a frame that moves nothing re-reads the day, or a late frame leaves visits under the old block", () => {
    const { home, screen, web } = open("frames");
    landDay(home);
    const before = home.extracts("web").map((row) => row.seq);
    const quiet = home.deliver(RECORDER, at("2026-10-06T21:10:00Z"), frames(SITTING_2 + 15 * MIN + 5 * S, SITTING_2 + 15 * MIN + 6 * S, S, "Browser", "Headlines", "www.news.example"));
    expect(quiet.touched.filter((unit) => unit.startsWith("web "))).toEqual([]);
    expect(home.extracts("web").map((row) => row.seq)).toEqual(before);

    const early = SITTING_1 - 3 * MIN;
    const late = home.deliver(RECORDER, at("2026-10-06T21:20:00Z"), frames(early, early + S, S, "Browser", "Code review", "code.example"));
    expect(late.written).toContain(`web ${MACHINE}/${DAY}T13`);
    const content = webDay(home);
    expect(content.items.filter((item) => item.sitting === SITTING_1)).toEqual([]);
    expect(content.items.filter((item) => item.sitting === early)).toHaveLength(201);
    const day = home.render(DAY, LABELS, undefined, [screen, web]);
    expect(block(day.txt, /^08:57–10:29 Screen/u)).toHaveLength(4);
    expect(day.txt).toContain("09:20–10:21 Web in the 08:57 sitting (3)");
    home.artifact("frames", { quiet: quiet.touched, late: late.written });
  });

  it("old day units do not duplicate visits while only one hour has rebuilt", () => {
    const { home } = open("upgrade");
    home.deliver(CHROME, at("2026-10-07T00:00:00Z"), [chromeVisit(SITTING_1, "https://upgrade.example/", "Synthetic upgrade")]);
    const hour = home.extracts("web")[0]!;
    const content = hour.content as unknown as WebHour;
    home.db.commit((tx) => tx.derived.extracts.put({ ...hour, code: "2", unit: `${MACHINE}/${DAY}`, content: { machine: MACHINE, day: DAY, items: content.items } as unknown as Json }));
    const partial = home.render(DAY, LABELS);
    expect(partial.txt).not.toContain("2 times");
    expect(partial.units.filter((unit) => unit.family === "web").map((unit) => unit.unit)).toEqual([hour.unit]);
    home.artifact("upgrade", { stored: home.extracts("web"), day: partial.txt });
  });

  it("each hour beside a long sitting reads the whole sitting again, or an hour reads frames outside it", () => {
    const { home, web } = open("long-sitting");
    const from = at("2026-10-06T08:00:30Z");
    const sitting = frames(from, from + 6 * 60 * MIN, 10 * S, "Browser", "Code review", "code.example");
    home.deliver(RECORDER, at("2026-10-06T21:00:00Z"), sitting);
    visitId = 0;
    home.deliver(CHROME, at("2026-10-06T21:05:00Z"), Array.from({ length: 72 }, (_, i) => chromeVisit(from + 5 * S + i * 5 * MIN, `https://code.example/change/${i}`, `Change ${i}`)));
    const stored = home.extracts("web");
    const units = stored.map((row) => row.unit);
    expect(units).toHaveLength(6);
    const read = home.read((view) => {
      const heads: number[] = [];
      const outside: string[] = [];
      const readings: (string | undefined)[] = [];
      let hour: [number, number] = [0, 0];
      const counting = new Proxy(view, {
        get(target, name) {
          if (name === "heads") {
            return (...args: Parameters<typeof view.heads>) => [...target.heads(...args)].map((head) => (head.kind === "frame" && heads.push(head.start_ms!), head));
          }
          if (name === "records") {
            return (...args: Parameters<typeof view.records>) => [...target.records(...args)].map((each) => {
              const t = each.head.start_ms!;
              if (each.head.kind === "frame" && (t < hour[0] || t > hour[1])) outside.push(`${new Date(hour[0]).toISOString()} ${new Date(t).toISOString()}`);
              return each;
            });
          }
          const value = Reflect.get(target, name, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      for (const unit of units) {
        const start = Date.parse(`${unit.slice(-13)}:00:00Z`);
        hour = [start, start + 60 * MIN + SEEN_MS];
        readings.push(web.extract(unit, counting, home.blobs)?.reading);
      }
      return { heads: heads.length, once: new Set(heads).size, outside, readings };
    });
    expect(read).toEqual({ heads: sitting.length, once: sitting.length, outside: [], readings: stored.map((row) => row.reading) });
  });

  it("a visit that lands touches another hour's unit", () => {
    const { home } = open("hour");
    landDay(home);
    const before = new Map(home.extracts("web").map((row) => [row.unit, row.seq]));
    const later = home.deliver(CHROME, at("2026-10-06T21:30:00Z"), [chromeVisit(SITTING_2 + 10 * MIN, "https://www.news.example/later", "Later")]);
    expect(later.touched.filter((unit) => unit.startsWith("web "))).toEqual([`web ${MACHINE}/${DAY}T19`]);
    for (const row of home.extracts("web")) if (row.unit !== `${MACHINE}/${DAY}T19`) expect(row.seq).toBe(before.get(row.unit));
  });

  it("a page's or search's search text misses its title, URL or words, or a page never shown has one, or a download, a tab or a frame is read for one", () => {
    const { home, web } = open("texts");
    landDay(home);
    const texts = home.texts(web);
    const worded = texts.flatMap(({ record, text }) => text === null ? [] : [{ kind: record.split(" ")[1], ...text }]);
    expect(worded.length).toBe(120 + 50 + 28 + 2 + 1 + 1 + 1 + 2);
    const page = (url: string) => worded.filter((text) => text.link === url);
    expect(page("https://code.example/change/31")).toEqual([{ kind: "page-visit", title: "Change 1", text: "https://code.example/change/31", link: "https://code.example/change/31" }]);
    expect(page("https://search.example/?q=synthetic+query")).toEqual([
      { kind: "page-visit", title: "synthetic query - Search", text: "https://search.example/?q=synthetic+query", link: "https://search.example/?q=synthetic+query" },
      { kind: "page-visit", title: "synthetic query - Search", text: "https://search.example/?q=synthetic+query", link: "https://search.example/?q=synthetic+query" },
      { kind: "search", text: "synthetic query", link: "https://search.example/?q=synthetic+query" },
    ]);
    expect(page("https://phone-news.example/story")).toEqual([{ kind: "page-visit", title: "A story", text: "https://phone-news.example/story", link: "https://phone-news.example/story" }]);
    expect(page("https://www.news.example/today")).toEqual([{ kind: "page-visit", title: "Headlines", text: "https://www.news.example/today", link: "https://www.news.example/today" }]);
    for (const url of ["https://ads.example/frame/0", "https://redirect.example/0", "https://code.example/hidden", "https://news.example/"]) expect(page(url)).toEqual([]);
    expect([...new Set(texts.map(({ record }) => record.split(" ").slice(0, 2).join(" ")))].sort()).toEqual([
      `${CHROME} page-visit`, `${CHROME} search`, `${SAFARI} page-visit`,
    ]);
    home.artifact("texts.json", worded);
  });

  it("a search and its page's visit an hour apart, landed apart in either order, print otherwise than landed together", () => {
    const url = "https://search.example/?q=hour+apart";
    const visit = () => chromeVisit(at("2026-10-06T09:10:00Z"), url, "hour apart - Search", { transition: 0x30000001 });
    const search = () => chromeSearch(at("2026-10-06T10:10:00Z"), url, "hour apart");
    const state = (home: TestHome, web: Family) => ({
      extracts: home.extracts("web").map(({ unit, reading, content, days }) => ({ unit, reading, content, days })),
      day: home.render(DAY, LABELS, undefined, [web]).txt,
    });
    const together = open("together");
    visitId = 0;
    together.home.deliver(CHROME, at("2026-10-06T11:05:00Z"), [visit(), search()]);
    const expected = state(together.home, together.web);
    expect(expected.day.split("hour apart").length - 1).toBeGreaterThan(0);
    for (const order of ["visit-first", "search-first"] as const) {
      const apart = open(order);
      visitId = 0;
      const rows = { visit: visit(), search: search() };
      const first = order === "visit-first" ? rows.visit : rows.search;
      const second = order === "visit-first" ? rows.search : rows.visit;
      apart.home.deliver(CHROME, at("2026-10-06T11:00:00Z"), [first]);
      apart.home.deliver(CHROME, at("2026-10-06T11:05:00Z"), [second]);
      expect(state(apart.home, apart.web), order).toEqual(expected);
    }
  });

  describe("errand tabs", () => {
    const ERRAND_AT = SITTING_1 + 5 * MIN;
    const OPENED = ERRAND_AT - 2 * MIN;
    const DEADLINE = ERRAND_AT + 10 * MIN;
    const OTHER_CHROME = `chrome:profile-3:${MACHINE}`;
    const OTHER_MAC_CHROME = `chrome:profile-2:${OTHER_MAC}`;
    const claim = (tab: number, from_ms = OPENED, until_ms = DEADLINE): ReaderOutput => ({
      kind: "tab", key: `chrome-5550aa01:${tab}:${from_ms}`, time: { start_ms: from_ms, end_ms: until_ms, precision: "ms" },
      content: { type: "stations.tab", station: "chrome-5550aa01", tab, errand: "e-0000aa01", from_ms, until_ms },
    });
    const CLAIMS = "stations:local:macbook-pro-0001";
    const errandHome = (name: string): ReturnType<typeof open> => {
      const opened = open(name);
      opened.home.addSource(CLAIMS);
      opened.home.addSource(OTHER_CHROME);
      opened.home.addSource(OTHER_MAC_CHROME);
      return opened;
    };
    const life = (): ReaderOutput[] => {
      visitId = 500;
      return [
        chromeVisit(ERRAND_AT, "https://app.errand.example/one", "Errand page", { tab: 11 }),
        chromeVisit(ERRAND_AT + S, "https://app.errand.example/two", "Errand page", { tab: 11, foreground: -1_000_000 }),
        chromeVisit(ERRAND_AT + 2 * S, "https://app.errand.example/own", "My own page", { tab: 12, foreground: 4_000_000 }),
        chromeVisit(ERRAND_AT + 3 * S, "https://app.errand.example/shown", "Shown to me", { tab: 11, foreground: 2_000_000 }),
        chromeVisit(ERRAND_AT + 4 * S, "https://app.errand.example/background", "My background tab", { tab: 13 }),
        chromeVisit(DEADLINE + 5 * MIN, "https://app.errand.example/repeat", "A repeated id", { tab: 11 }),
        chromeVisit(ERRAND_AT + 5 * S, "https://app.errand.example/unannotated", "No annotation"),
        chromeVisit(ERRAND_AT + 6 * S, "https://app.errand.example/synced", "Synced", { synced: true }),
        chromeVisit(ERRAND_AT + 7 * S, "chrome-extension://aaaabbbbccccddddeeeeffffgggghhhh/blank.html", "Blank"),
        chromeDownload(ERRAND_AT + 8 * S, "errand-export.zip", "https://app.errand.example/export", "Lifestream", "DOWNLOAD0002"),
        chromeDownload(ERRAND_AT + 9 * S, "mine.pdf", "https://app.errand.example/mine.pdf"),
      ];
    };
    const urls = (home: TestHome) => home.extracts("web").flatMap((row) => (row.content as unknown as WebHour).items.map((item) => item.file ?? item.title));
    const state = (home: TestHome, web: Family) => ({
      extracts: home.extracts("web").map(({ unit, reading, content, days }) => ({ unit, reading, content, days })),
      day: home.render(DAY, LABELS, undefined, [web]).txt,
    });
    const STAYS = ["My own page", "Shown to me", "My background tab", "A repeated id", "No annotation", "Synced", "mine.pdf"];

    it("an errand's visit prints or is found, with a sitting and without, and the person's own visit to the same site goes with it", () => {
      const artifacts: Record<string, unknown> = {};
      for (const screen of [false, true]) {
        const { home, screen: sittings, web } = errandHome(`errand-${screen}`);
        if (screen) home.deliver(RECORDER, SITTING_1 + 91 * MIN, frames(SITTING_1, SITTING_1 + 30 * MIN, 10 * S, "Browser", "App", "app.errand.example"));
        home.deliver(CLAIMS, OPENED, [claim(11)]);
        home.deliver(CHROME, SITTING_1 + 31 * MIN, life());
        home.deliver(SAFARI, SITTING_1 + 31 * MIN, [safariVisit(ERRAND_AT, "https://app.errand.example/safari", "On Safari")]);
        expect([...urls(home)].sort(), `screen ${screen}`).toEqual([...STAYS, "On Safari"].sort());
        const day = home.render(DAY, LABELS, undefined, [sittings, web]).txt;
        expect(day).toContain("My own page");
        expect(day).not.toContain("Errand page");
        expect(day).not.toContain("errand-export.zip");
        expect(day).not.toContain("chrome-extension");
        const found = home.texts(web).filter(({ text }) => text !== null).map(({ text }) => text!.title);
        expect([...found].sort(), `screen ${screen}`).toEqual([...STAYS.filter((title) => title !== "mine.pdf"), "On Safari"].sort());
        artifacts[screen ? "with a screen" : "with no screen"] = { day, found };
      }
      open("errand-artifact").home.artifact("errand-tabs.json", artifacts);
    });

    it("claim before visit, visit before claim and both together make other units, or the claim moves an hour with no visit of its tab", () => {
      const together = errandHome("together");
      together.home.land(CLAIMS, OPENED, [claim(11)]);
      together.home.deliver(CHROME, SITTING_1 + 31 * MIN, life());
      const expected = state(together.home, together.web);
      expect(expected.day).not.toContain("Errand page");
      const claimFirst = errandHome("claim-first");
      expect(claimFirst.home.deliver(CLAIMS, OPENED, [claim(11)]).touched).toEqual([]);
      claimFirst.home.deliver(CHROME, SITTING_1 + 31 * MIN, life());
      expect(state(claimFirst.home, claimFirst.web)).toEqual(expected);
      const visitFirst = errandHome("visit-first");
      visitFirst.home.deliver(CHROME, SITTING_1 + 31 * MIN, life());
      expect(visitFirst.home.render(DAY, LABELS, undefined, [visitFirst.web]).txt).toContain("Errand page");
      const landed = visitFirst.home.deliver(CLAIMS, SITTING_1 + 32 * MIN, [claim(11)]);
      expect(landed.touched).toEqual([`web ${MACHINE}/2026-10-06T13`]);
      expect(state(visitFirst.home, visitFirst.web)).toEqual(expected);
    });

    it("a visit of a tab shown and open stays out once its edited row says the person saw it, and a span over an hour's edge misses its second hour", () => {
      const { home, web } = errandHome("edited");
      const over = at("2026-10-06T13:58:00Z");
      home.deliver(CLAIMS, over, [claim(21, over, over + 10 * MIN)]);
      visitId = 700;
      const standing = chromeVisit(over + 5 * MIN, "https://app.errand.example/need", "A need, open", { tab: 21, foreground: -1_000_000 });
      const before = chromeVisit(over + MIN, "https://app.errand.example/before", "Before the hour", { tab: 21 });
      home.deliver(CHROME, over + 6 * MIN, [before, standing]);
      expect(urls(home)).toEqual([]);
      const seen = { ...standing, content: { ...(standing.content as Record<string, unknown>), context_annotations: { ...(standing.content as { context_annotations: Record<string, unknown> }).context_annotations, total_foreground_duration: 30_000_000 } } } as ReaderOutput;
      home.deliver(CHROME, over + 20 * MIN, [seen]);
      expect(urls(home)).toEqual(["A need, open"]);
      expect(home.texts(web).filter(({ text }) => text !== null).map(({ text }) => text!.title)).toEqual(["A need, open"]);
    });

    it("an errand in a second profile or on a second Mac is missed, or a claim reaches another tab there", () => {
      const { home } = errandHome("two");
      home.deliver(CLAIMS, OPENED, [claim(11), claim(31)]);
      visitId = 800;
      home.deliver(CHROME, SITTING_1 + 31 * MIN, [chromeVisit(ERRAND_AT, "https://mine.example/a", "Profile one", { tab: 12 })]);
      home.deliver(OTHER_CHROME, SITTING_1 + 31 * MIN, [
        chromeVisit(ERRAND_AT, "https://app.errand.example/a", "Errand in profile two", { tab: 11 }),
        chromeVisit(ERRAND_AT, "https://mine.example/b", "Profile two", { tab: 14 }),
      ]);
      home.deliver(OTHER_MAC_CHROME, SITTING_1 + 31 * MIN, [
        chromeVisit(ERRAND_AT, "https://app.errand.example/b", "Errand on the second Mac", { tab: 31 }),
        chromeVisit(ERRAND_AT, "https://mine.example/c", "Second Mac", { tab: 15 }),
      ]);
      expect([...urls(home)].sort()).toEqual(["Profile one", "Profile two", "Second Mac"]);
    });

    it("the rule moves the family's code, or a home with no claim reads otherwise", () => {
      expect(webFamily({ cutover_ms: 0 })(FED.web).code).toBe("4:0");
      const { home, web } = open("no-claims");
      visitId = 900;
      home.deliver(CHROME, SITTING_1 + 31 * MIN, [chromeVisit(ERRAND_AT, "https://app.errand.example/one", "Any page", { tab: 11 })]);
      expect(urls(home)).toEqual(["Any page"]);
      expect(home.texts(web).map(({ text }) => text?.title)).toEqual(["Any page"]);
    });
  });

  describe("a page's repeat of itself", () => {
    const LINK = 0x30000000;
    const SELF = 0x60000000;
    const RELOAD = 0x30000008;
    const SHOP = "https://www.shop.example/frames";
    const ORIGINAL = at("2026-10-06T12:43:00Z");
    const PAGE = 4_000;
    const tabLeftOpen = (first = ORIGINAL): ReaderOutput[] => {
      visitId = 400;
      return [
        chromeVisit(first, SHOP, "Frames", { tab: 41, foreground: 3_000_000, page: PAGE }),
        chromeVisit(first + 8 * 60 * MIN, SHOP, "Frames", { transition: SELF, tab: 41, foreground: 0, from: 401, page: PAGE }),
        chromeVisit(first + 16 * 60 * MIN, SHOP, "Frames", { transition: SELF, tab: 41, foreground: -1_000_000, from: 402, page: PAGE }),
      ];
    };
    const shopLines = (txt: string) => txt.split("\n").filter((line) => line.includes("shop.example"));
    const state = (home: TestHome, web: Family) => ({
      extracts: home.extracts("web").map(({ unit, reading, content, days }) => ({ unit, reading, content, days })),
      day: home.render(DAY, LABELS, undefined, [web]).txt,
    });

    it("a tab left open that reloads itself prints a line every 8 hours, or is found by search", () => {
      const { home, web } = open("self-hours");
      home.deliver(CHROME, at("2026-10-07T05:00:00Z"), tabLeftOpen());
      const day = home.render(DAY, LABELS, undefined, [web]).txt;
      expect(shopLines(day)).toHaveLength(1);
      expect(shopLines(day)[0]).toContain("visited shop.example: \"Frames\"");
      expect(home.extracts("web").map((row) => row.unit)).toEqual([`${MACHINE}/${DAY}T12`]);
      expect(home.texts(web).filter(({ text }) => text !== null)).toHaveLength(1);
      home.artifact("self-hours.txt", day);
    });

    it("a page that reloads itself in the same hour counts as two visits", () => {
      const { home, web } = open("self-hour");
      visitId = 400;
      home.deliver(CHROME, ORIGINAL + 30 * MIN, [
        chromeVisit(ORIGINAL, SHOP, "Frames", { tab: 41, foreground: 3_000_000, page: PAGE }),
        chromeVisit(ORIGINAL + 10 * MIN, SHOP, "Frames", { transition: SELF, tab: 41, from: 401, page: PAGE }),
      ]);
      const day = home.render(DAY, LABELS, undefined, [web]).txt;
      expect(shopLines(day)).toHaveLength(1);
      expect(day).not.toContain("2 times");
    });

    it("a page that moved itself to another URL, or a reload the person made, goes", () => {
      const { home, web } = open("self-other");
      visitId = 400;
      home.deliver(CHROME, ORIGINAL + 30 * MIN, [
        chromeVisit(ORIGINAL, SHOP, "Frames", { tab: 41, foreground: 3_000_000, page: PAGE }),
        chromeVisit(ORIGINAL + 2 * S, "https://www.shop.example/frames/round", "Round frames", { transition: SELF, tab: 41, from: 401, page: PAGE + 1 }),
        chromeVisit(ORIGINAL + 4 * MIN, SHOP, "Frames", { transition: RELOAD, tab: 41, from: 401, page: PAGE }),
      ]);
      const day = home.render(DAY, LABELS, undefined, [web]).txt;
      expect(shopLines(day)).toEqual([expect.stringContaining("visited shop.example 3 times: \"Frames\", \"Round frames\"")]);
      expect(home.texts(web).filter(({ text }) => text !== null)).toHaveLength(3);
    });

    it("a repeat of a visit the home does not hold goes", () => {
      const { home, web } = open("self-unheld");
      visitId = 400;
      home.deliver(CHROME, ORIGINAL + 30 * MIN, [chromeVisit(ORIGINAL, SHOP, "Frames", { transition: SELF, tab: 41, from: 17, page: PAGE })]);
      expect(shopLines(home.render(DAY, LABELS, undefined, [web]).txt)).toHaveLength(1);
    });

    it("a repeat of the day before's visit prints on its own day", () => {
      const { home, web } = open("self-yesterday");
      home.deliver(CHROME, at("2026-10-07T05:00:00Z"), tabLeftOpen(at("2026-10-06T02:43:00Z")));
      expect(shopLines(home.render(DAY, LABELS, undefined, [web]).txt)).toEqual([]);
      expect(shopLines(home.render("2026-10-05", LABELS, undefined, [web]).txt)).toHaveLength(1);
    });

    it("a repeat that lands before the visit it repeats prints once that visit lands, or the order they land in changes a unit", () => {
      const together = open("self-together");
      together.home.deliver(CHROME, at("2026-10-07T05:00:00Z"), tabLeftOpen());
      const expected = state(together.home, together.web);
      const apart = open("self-apart");
      const [first, ...repeats] = tabLeftOpen();
      apart.home.deliver(CHROME, at("2026-10-07T05:00:00Z"), repeats);
      expect(shopLines(apart.home.render(DAY, LABELS, undefined, [apart.web]).txt)).toHaveLength(1);
      const landed = apart.home.deliver(CHROME, at("2026-10-07T05:05:00Z"), [first!]);
      expect(landed.touched.filter((unit) => unit.startsWith("web ")).sort()).toEqual([`web ${MACHINE}/${DAY}T12`, `web ${MACHINE}/${DAY}T20`]);
      expect(state(apart.home, apart.web)).toEqual(expected);
      const follow = apart.web.text!.follows!.find((each) => each.kinds.includes("page-visit"))!;
      const named = apart.home.read((view) => {
        const record = { source: CHROME, kind: "page-visit", key: first!.key };
        const version = view.version(view.head(record)!.version);
        const untabbed = { ...version, content: { ...(version.content as object), context_annotations: null } } as typeof version;
        return [[{ record, after: version }], [{ record, before: version }], [{ record, before: version, after: untabbed }]]
          .map((changes) => follow.moved(changes, view).map((each) => each.key));
      });
      expect(named).toEqual([[repeats[0]!.key], [repeats[0]!.key], [repeats[0]!.key]]);
      expect(apart.home.texts(apart.web).filter(({ text }) => text !== null)).toHaveLength(1);
    });

    it("the search index's follow of a slice of visits in time order reads each visit once, not a day of visits for each", () => {
      const { home, web } = open("self-slice");
      visitId = 400;
      const rows = Array.from({ length: 300 }, (_, at) => chromeVisit(ORIGINAL + at * 5 * MIN, SHOP, "Frames", at % 2 === 0
        ? { tab: 41, foreground: 3_000_000, page: PAGE }
        : { transition: SELF, tab: 41, from: 400 + at, page: PAGE }));
      home.deliver(CHROME, ORIGINAL + 30 * 60 * MIN, rows);
      const follow = web.text!.follows!.find((each) => each.kinds.includes("page-visit"))!;
      const counted = home.read((view) => {
        const reads = { scans: 0, visits: 0 };
        const counting = new Proxy(view, {
          get(target, name) {
            if (name === "records") {
              return (...args: Parameters<typeof view.records>) => {
                reads.scans++;
                return [...target.records(...args)].map((each) => (reads.visits++, each));
              };
            }
            const value = Reflect.get(target, name, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const changes = rows.map((row) => {
          const record = { source: CHROME, kind: "page-visit", key: row.key };
          return { record, after: view.version(view.head(record)!.version) };
        });
        const moved = follow.moved(changes, counting).map((each) => each.key).sort();
        return { ...reads, moved };
      });
      expect(counted).toEqual({ scans: 1, visits: 300, moved: rows.filter((_, at) => at % 2 === 1).map((row) => row.key).sort() });
    });

    it("a repeat of a visit whose id Chrome gave again after its history was cleared, in another tab, later than it or in no tab, goes", () => {
      const { home, web } = open("self-reused");
      visitId = 400;
      const old = chromeVisit(ORIGINAL - 7 * 24 * 60 * MIN, SHOP, "Frames", { tab: 7, foreground: 3_000_000, page: PAGE });
      visitId = 401;
      const repeat = chromeVisit(ORIGINAL + 10 * MIN, SHOP, "Frames", { transition: SELF, tab: 41, from: 401, page: PAGE });
      const early = chromeVisit(ORIGINAL + 2 * 60 * MIN, SHOP, "Frames", { transition: SELF, tab: 41, from: 404, page: PAGE });
      const later = chromeVisit(ORIGINAL + 3 * 60 * MIN, SHOP, "Frames", { tab: 41, foreground: 3_000_000, page: PAGE });
      const untabbed = chromeVisit(ORIGINAL + 5 * 60 * MIN, SHOP, "Frames", { page: PAGE });
      const fromUntabbed = chromeVisit(ORIGINAL + 6 * 60 * MIN, SHOP, "Frames", { transition: SELF, from: 405, page: PAGE });
      home.deliver(CHROME, at("2026-10-07T05:00:00Z"), [old, repeat, early, later, untabbed, fromUntabbed]);
      const read = home.extracts("web").flatMap((row) => (row.content as unknown as WebHour).items.map((item) => item.at_ms)).filter((ms) => ms >= ORIGINAL);
      expect(read).toEqual([repeat, early, later, untabbed, fromUntabbed].map((row) => row.time!.start_ms));
      expect(home.texts(web).filter(({ text }) => text !== null)).toHaveLength(6);
    });

    it("a repeat of a visit that is a redirect's hop or hidden is a repeat", () => {
      const { home, web } = open("self-unshown");
      visitId = 400;
      const hop = chromeVisit(ORIGINAL, SHOP, "Frames", { transition: 0x10000000 | 0x80000000, tab: 41, page: PAGE });
      const fromHop = chromeVisit(ORIGINAL + 8 * 60 * MIN, SHOP, "Frames", { transition: SELF, tab: 41, from: 401, page: PAGE });
      const hidden = chromeVisit(ORIGINAL + 9 * 60 * MIN, SHOP, "Frames", { tab: 42, hidden: true, page: PAGE });
      home.deliver(CHROME, at("2026-10-07T05:00:00Z"), [hop, fromHop, hidden]);
      visitId = 403;
      const fromHidden = chromeVisit(ORIGINAL + 10 * 60 * MIN, SHOP, "Frames", { transition: SELF, tab: 42, from: 403, page: PAGE });
      home.deliver(CHROME, at("2026-10-07T05:05:00Z"), [fromHidden]);
      expect(shopLines(home.render(DAY, LABELS, undefined, [web]).txt)).toEqual([]);
      expect(home.texts(web).filter(({ text }) => text !== null)).toEqual([]);
    });
  });

  it("the golden day: the screen's sittings with the web beside them", () => {
    const { home, screen, web } = open("golden");
    landDay(home);
    const day = home.render(DAY, LABELS, undefined, [screen, web]);
    expect(checkDayFile(JSON.parse(day.json))).toEqual([]);
    checkGolden("extract", home.extracts("web").map((row) => ({ unit: row.unit, content: row.content })) as unknown as Json);
    checkGolden("day", day.txt);
    pin(web, { web: FED.web, screen: FED.screen }, home.extracts("web"));
  });
});


function checkGolden(member: string, value: unknown): void {
  const golden = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, Json> : {};
  if (UPDATE) {
    golden[member] = value as Json;
    mkdirSync(dirname(GOLDEN.pathname), { recursive: true });
    writeFileSync(GOLDEN, `${JSON.stringify(golden, null, 2)}\n`);
    return;
  }
  expect(golden[member], `${GOLDEN.pathname} has no ${member}; run with LIFESTREAM_UPDATE_GOLDEN=1`).toBeDefined();
  expect(value).toEqual(golden[member]);
}
