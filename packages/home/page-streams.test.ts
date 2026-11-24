import { describe, expect, it } from "vitest";
import { kindOf, lineOf, lineText, shownNeeds } from "./connectors.js";
import { PAGES } from "./pages.js";
import { NB } from "./stream-words.js";
import { calloutOf, needOf, rowsOf, streamsAnswer, streamsPage, taken } from "./page-streams.js";
import { servePages } from "./page-serve.js";
import type { Ask } from "./reads.js";
import type { Health, State } from "./health.js";
import type { Act, ConnectorReport, Need, StreamsReport } from "./streams-report.js";

const PHONE = { device: "phone", unit: "iphone-0001" } as const;
const MAC = { device: "mac", unit: "macbook-pro-0001" } as const;
const BROWSER = { device: null, unit: null } as const;

const health = (state: State, words: string, acts: Act[] = []): Health<Act> =>
  ({ state, reason: state === "broken" ? "failing" : null, words, since_ms: null, next_ms: null, acts, detail: null });

const stream = (id: string, state: State, more: Partial<ConnectorReport> = {}): ConnectorReport => ({
  id, name: `Stream ${id}`, icon: "voice-note", gives: `What ${id} gives.`, shown: "stream", joins: null, type: { key: "voice", name: "Voice", icon: "voice-note" },
  health: health(state, state === "ok" ? "Running" : `Words of ${id}`), lead: null, line: `Line of ${id}`, line_parts: { words: `Line of ${id}`, time: null, more: [] },
  set_up: state !== "setup" && state !== "off",
  figure: null, routes: [], members: [], pauses: [], sensor: false, roads: ["poll"], ...more,
} as unknown as ConnectorReport);

const JOINS = { name: "Dictation", gives: "What you dictate.", icon: "voice-note", apps: ["Stream a", "Stream b"] };

const need = (id: string, more: Partial<Need> = {}): Need => ({
  ...health("broken", `Need ${id}`), id, state: "broken", connector: null, copy: null, unit: null, at: null,
  weight: "stopped", banner: false, dismissed: false, kind: "notice", about: null, ...more,
});

describe("a joined stream row", () => {
  const broken = stream("b", "broken", {
    joins: JOINS, line: "Couldn’t read it", line_parts: { words: "Couldn’t read it", time: null, more: [] }, figure: { last_ms: 2_000 } as ConnectorReport["figure"],
    health: health("broken", "Couldn’t read Stream b", [{ do: "try", label: "Try now", need: "poll:b" }]),
  });
  const fine = stream("a", "ok", { joins: JOINS, figure: { last_ms: 5_000 } as ConnectorReport["figure"] });

  it("answers broken when one member is broken, with that member's line and act, and the newest of its members' times as a When", () => {
    const [row] = rowsOf([fine, broken], PHONE);
    expect(row).toMatchObject({
      ids: ["a", "b"], joined: true, name: "Dictation", icon: "voice-note", line: "Couldn’t read it", last: { kind: "at", at_ms: 5_000 },
      act: { do: "try", label: "Try now", need: "poll:b" },
    });
    expect(row!.health.state).toBe("broken");
    expect(row!.find).toEqual(expect.arrayContaining(["Dictation", "Stream a", "Stream b", "Voice", "What you dictate."]));
  });

  it("keeps the page's order and one row per joined name", () => {
    const rows = rowsOf([stream("x", "ok"), fine, stream("y", "setup"), broken], MAC);
    expect(rows.map((row) => row.ids)).toEqual([["x"], ["a", "b"], ["y"]]);
    expect(rows[2]).toMatchObject({ line: "What y gives.", act: null });
  });
});

describe("the one tap, by the asking device's kind", () => {
  const vault: Act = { do: "vault", label: "Open your passwords" };
  const mac = stream("m", "needs-you", { health: health("needs-you", "Needs the Mac", [vault]) });

  it("offers a Mac-only act on the Mac and never on the phone or in a browser", () => {
    expect(rowsOf([mac], MAC)[0]!.act).toEqual(vault);
    expect(rowsOf([mac], PHONE)[0]!.act).toBeNull();
    expect(rowsOf([mac], BROWSER)[0]!.act).toBeNull();
  });

  it("offers a grant only to the device it names, and on the phone never an act that opens a page", () => {
    const grant: Act = { do: "grant", label: "Allow", unit: PHONE.unit, grant: "photos" };
    expect([taken(grant, mac, PHONE), taken(grant, mac, { ...PHONE, unit: "iphone-0002" }), taken(grant, mac, MAC)]).toEqual([true, false, false]);
    const signin = stream("s", "needs-you", { health: health("needs-you", "Sign in", [{ do: "signin", label: "Sign in", of: "route-a" }]) });
    expect(rowsOf([signin], PHONE)[0]!.act).toBeNull();
  });

  it("offers Resume on a stream paused whole, over the stream's own act, to the Mac and the phone, and a stream only the Mac runs to the Mac alone", () => {
    const whole = { scope: "all", by: "you", reason: "", at_ms: 1 } as const;
    const tried: Act = { do: "try", label: "Try now", need: "n" };
    const paused = stream("p", "paused", { pauses: [whole], health: health("paused", "Paused", [tried]) });
    expect(rowsOf([paused], MAC)[0]!.act).toEqual({ do: "resume", label: "Resume", of: "p" });
    expect(rowsOf([{ ...paused, sensor: true }], MAC)[0]!.act).toEqual({ do: "resume", label: "Resume reading", of: "p" });
    expect([rowsOf([paused], PHONE)[0]!.act, rowsOf([paused], BROWSER)[0]!.act]).toEqual([{ do: "resume", label: "Resume", of: "p" }, tried]);
    const sensed = { ...paused, roads: ["mac"], sensor: true } as unknown as ConnectorReport;
    expect([rowsOf([sensed], MAC)[0]!.act, rowsOf([sensed], PHONE)[0]!.act, rowsOf([sensed], BROWSER)[0]!.act]).toEqual([{ do: "resume", label: "Resume reading", of: "p" }, tried, tried]);
    const both = { ...paused, roads: ["mac", "poll"] } as unknown as ConnectorReport;
    expect(rowsOf([both], PHONE)[0]!.act).toEqual({ do: "resume", label: "Resume", of: "p" });
    expect(rowsOf([stream("h", "ok", { pauses: [{ ...whole, scope: "history" }] })], MAC)[0]!.act).toBeNull();
    expect(rowsOf([stream("u", "setup", { pauses: [whole] })], MAC)[0]!.act).toBeNull();
  });

  it("never takes Report a problem as the one tap: a broken stream's Try now stays its tap on the Mac and the phone, and the card still holds both", () => {
    const tried: Act = { do: "try", label: "Try now", need: "n" };
    const report: Act = { do: "report", label: "Report a problem", of: "r" };
    const broken = stream("r", "broken", { health: health("broken", "Couldn’t read it", [tried, report]) });
    for (const asking of [MAC, PHONE, BROWSER]) expect(rowsOf([broken], asking)[0]!.act, String(asking.device)).toEqual(tried);
    expect([taken(report, broken, MAC), taken(report, broken, PHONE), taken(report, broken, BROWSER)]).toEqual([true, true, false]);
    expect(rowsOf([broken], MAC)[0]!.health.acts).toEqual([tried, report]);
    expect(rowsOf([stream("o", "broken", { health: health("broken", "Only a report", [report]) })], MAC)[0]!.act).toBeNull();
  });

  it("offers nothing when more than one act is taken", () => {
    const two = stream("t", "broken", { health: health("broken", "Two", [{ do: "try", label: "Try now", need: "n" }, { do: "skip", label: "Skip", need: "n" }]) });
    expect(rowsOf([two], PHONE)[0]!.act).toBeNull();
  });
});

describe("a need's kind and the list every device shows", () => {
  it("is a password with a set act on a stream, connect with a browser act, else a notice, each with its words", () => {
    expect(kindOf({ connector: "c", acts: [{ do: "set", label: "Enter it", member: "password" }] })).toEqual({ kind: "password", about: "Lifestream keeps it locked with your other passwords." });
    expect(kindOf({ connector: null, acts: [{ do: "set", label: "Enter it", member: "password" }] }).kind).toBe("notice");
    expect(kindOf({ connector: null, acts: [{ do: "browser", label: "Connect", of: "chrome" }] })).toEqual({ kind: "connect", about: "Connect it if you just added the extension" });
    expect(kindOf({ connector: "c", acts: [] })).toEqual({ kind: "notice", about: null });
  });

  it("leaves out a need the person dismissed", () => {
    expect(shownNeeds([need("a"), need("b", { weight: "advice", dismissed: true })]).map((each) => each.id)).toEqual(["a"]);
  });

  it("holds on a stream's sheet the needs held on it, but not the one its own state already says", () => {
    const own = stream("c", "broken", { health: health("broken", "Need same", [{ do: "try", label: "Try now", need: "n" }]) });
    const needs = [
      need("same", { connector: "c", words: "Need same", acts: [{ do: "try", label: "Try now", need: "n" }] }),
      need("other", { connector: "c" }), need("streams", { streams: ["c", "d"] }), need("elsewhere", { connector: "d" }),
    ].map(needOf);
    expect(calloutOf(own, needs).map((each) => each.id)).toEqual(["other", "streams"]);
    const reportable = { ...own, health: { ...own.health, acts: [...own.health.acts, { do: "report", label: "Report a problem", of: "c" } as const] } };
    expect(calloutOf(reportable, needs).map((each) => each.id), "the card's Report a problem does not make its own need a callout").toEqual(["other", "streams"]);
  });
});

describe("the answer", () => {
  it("passes the page's shape, counts the needs the badge shows and leaves the banner apart", () => {
    const report = {
      at_ms: 1, day: "2026-11-21", products: "sha256:p", needs: [need("a"), need("banner", { banner: true })], disk: { free_bytes: 1, max_bundle_bytes: 2 },
      paused: [], home: {}, devices: [], extension: {}, connectors: [stream("a", "ok")], setup: null, off: [], imports: [], adding: { prompt: "", blank: "" },
    } as unknown as StreamsReport;
    const body = streamsAnswer(report, 2, PHONE);
    expect(body.badge).toEqual({ needs: 1, asks: 2 });
    expect(() => PAGES.connectors.shape.parse({ position: "1:1", today: "2026-11-21", ...body })).not.toThrow();
    expect((body.connectors as { callout: unknown[] }[])[0]!.callout).toEqual([]);
  });
});

describe("the page's ETag", () => {
  it("moves with the free bytes the answer shows, and never with the moment the report was read", async () => {
    const report = (at_ms: number, free_bytes: number) => ({
      at_ms, day: "2026-11-21", products: "sha256:p", needs: [need("a")], disk: { free_bytes, max_bundle_bytes: 2 },
      paused: [], home: {}, devices: [], extension: {}, connectors: [stream("a", "ok")], setup: null, off: [], imports: [], adding: { prompt: "", blank: "" },
    } as unknown as StreamsReport);
    let read = report(1, 1_000);
    const route = servePages({ connectors: streamsPage({ read: () => ({ position: "1:1", report: read, asks: 0 }) }) }, () => ({ zone: "UTC", day_start_hour: 0 }))
      .get(PAGES.connectors.route)!;
    const asked = (etag?: string) => ({ url: "/v1/connectors", now_ms: Date.parse("2026-11-21T10:00:00Z"), held: { machine: "machine-0001" }, ...(etag === undefined ? {} : { if_none_match: etag }) }) as unknown as Ask;
    const first = await route(asked());
    read = report(2, 1_000);
    const later = await route(asked(first.headers.etag));
    read = report(2, 2_000);
    const freed = await route(asked(first.headers.etag));
    expect([first.status, later.status, freed.status, JSON.parse(freed.body as string).disk.free_bytes]).toEqual([200, 304, 200, 2_000]);
    expect(freed.headers.etag).not.toBe(first.headers.etag);
  });
});

describe("a stream's line", () => {
  const DAY = { zone: "UTC", day_start_hour: 0 };
  const NOW_MS = Date.parse("2026-11-16T15:00:00Z");
  const base = {
    today: null, newest: null, oldest: null, dated: false, held: null, nouns: ["message", "messages"] as const, sensor: false, recording: null, owed: null,
    now_ms: NOW_MS, day: DAY, pause: null, nameOf: (unit: string) => unit, waiting: 0, trouble: null,
  };
  const TIME_WORD = /\b(?:today|yesterday|tomorrow|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{4})\b|\d{1,2}:\d{2}/u;
  const cases = [
    { line: lineOf("ok", "", { ...base, today: 3 }), time: { kind: "day", day: "2026-11-16" }, text: `3${NB}messages today` },
    { line: lineOf("ok", "", { ...base, newest: Date.parse("2026-11-15T09:00:00Z"), dated: true }), time: { kind: "day", day: "2026-11-15" }, text: "Last message yesterday" },
    { line: lineOf("ok", "", { ...base, newest: Date.parse("2026-11-16T14:10:00Z") }), time: { kind: "at", at_ms: Date.parse("2026-11-16T14:10:00Z") }, text: "Last message 14:10" },
    { line: lineOf("syncing", "", { ...base, oldest: Date.parse("2026-03-04T00:00:00Z") }), time: { kind: "month", month: "2026-03" }, text: "back to Mar 2026" },
    {
      line: lineOf("paused", "", { ...base, pause: { scope: "all", by: "you", reason: "", at_ms: Date.parse("2026-11-15T21:27:00Z") }, waiting: 2 }),
      time: { kind: "at", at_ms: Date.parse("2026-11-15T21:27:00Z") }, text: `Paused since yesterday 21:27 · 2${NB}waiting`,
    },
  ] as const;

  it("holds its time as a When, never in its words, and reads as it did when worded by the home", () => {
    for (const each of cases) {
      expect(each.line.time, each.text).toEqual(each.time);
      expect([each.line.words, ...each.line.more].join(" · "), each.text).not.toMatch(TIME_WORD);
      expect(lineText(each.line, NOW_MS, DAY)).toBe(each.text);
    }
  });

  it("gives the row its words, its time and the rest, with the lead before the words", () => {
    const [row] = rowsOf([stream("p", "syncing", { lead: "Catching up", line_parts: cases[3].line })], PHONE);
    expect(row).toMatchObject({ line: "Catching up · back to", time: { kind: "month", month: "2026-03" }, more: [] });
  });
});
