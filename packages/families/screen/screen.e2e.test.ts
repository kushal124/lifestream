import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { brotliCompressSync, constants } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountOf, digest, openHome, openHomeFolder, piecesText, type Ask, type BlobReader, type BlobStore, type DaySettings, type EnrichmentRow, type ExtractRow, type HomeDb, type Json, type JsonObject, type ReaderOutput, type Reply, type Version } from "@lifestreamprotocol/core";
import { checkDayFile, DayReadError, renderDay, type DayDocument, type DayReader, tableUnits } from "../days.js";
import type { Change, Family, ReadThroughMove } from "../family.js";
import { buildLabels } from "../shared/labels.js";
import { SYNTHETIC_VENDOR, readReply, worked } from "../test/drive.js";
import { ACCOUNT, COMPOSE_PROMPT, PART_PROMPT, SITTING_PROMPT, type Account } from "./account.js";
import { FED } from "../test/fed.js";
import { pin } from "../test/pin.js";
import { screenFamily, SCREEN_CUTOVER_MS, SCREEN_PROMPTS, type ClosedSitting, type SittingContent } from "./family.js";
import { blocksOf, clockOf, evidenceOf, partEvidence } from "./evidence.js";
import { ScreenFrameReader, screenFrames, segmentsSpanning, WALK_SEGMENTS, type FrameRow, type InputEvent, type MachineEvent } from "./frames.js";
import { Roles } from "./sittings.js";
import { conforming } from "../test/units.js";

const parsed = vi.hoisted(() => [] as string[]);
vi.mock("@lifestreamprotocol/core", async (original) => {
  const core = await original<typeof import("@lifestreamprotocol/core")>();
  return {
    ...core,
    parse: (source: string) => {
      const member = source.startsWith('[{"text":') ? "ocr" : source.startsWith('[{"role":') ? "nodes" : null;
      if (member !== null) parsed.push(member);
      return core.parse(source);
    },
  };
});

const GOLDEN = new URL("./test/screen.golden.json", import.meta.url);
const UPDATE = process.env.LIFESTREAM_UPDATE_GOLDEN === "1";
const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const LABELS = buildLabels({ people: [], contacts: [], places: [] });
const MACHINE = "macbook-pro-0001";
const COAST = `coast:local:${MACHINE}`;
const RECORDER = `screen:local:${MACHINE}`;
const INPUT = `input:local:${MACHINE}`;
const MACHINE_LOG = `machine:local:${MACHINE}`;
const S = 1_000;
const MIN = 60 * S;
const at = (iso: string) => Date.parse(iso);
const accept = () => [];
const GUARDS = { frame: accept, session: accept, ax: accept, recorder: accept, input: accept, "machine-event": accept };
const callsFor = (content: ClosedSitting) => {
  const blocks = content.blocks.map((block) => block.parts.length === 1 ? 1 : block.parts.length + 1).reduce((sum, n) => sum + n, 0);
  return blocks + (content.blocks.length > 1 ? 1 : 0);
};
const partsOf = (content: ClosedSitting) => content.blocks.flatMap((block) => block.parts).map((part) => ({ ...part, evidence: piecesText(part.evidence) }));


interface Shown {
  app: string;
  title: string;
  lines: string[];
}

function shown(app: string, title: string, lines = [`${title}: synthetic line one`, `${title}: synthetic line two`]): Shown {
  return { app, title, lines };
}

function basic(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/gu, "").replace(".000", "");
}

function recorderFrames(blobs: BlobStore, from: number, to: number, every: number, show: (t: number) => Shown, tick: JsonObject = {}): ReaderOutput[] {
  const times: number[] = [];
  for (let t = from; t < to; t += every) times.push(t);
  const arrays: string[] = [];
  const index = (value: Json) => {
    const text = JSON.stringify(value);
    const found = arrays.indexOf(text);
    if (found !== -1) return found;
    arrays.push(text);
    return arrays.length - 1;
  };
  const frames = times.map((t) => {
    const view = show(t);
    const windows = [{ windowID: 7, title: view.title, application: { bundleID: bundleOf(view.app), name: view.app, pid: 42 }, bounds: { x: 0, y: 0, width: 800, height: 600 } }];
    const nodes = [{ role: "AXWindow", depth: 0, title: view.title }, ...view.lines.map((line) => ({ role: "AXStaticText", depth: 1, value: line })),
      { role: "AXToolbar", depth: 1 }, { role: "AXButton", depth: 2, title: "furniture never read" }];
    const ocr = view.lines.map((line) => ({ text: line, confidence: 1, bounds: { x: 0, y: 0, width: 1, height: 1 } }));
    return { splices: [
      { at: 10, before: ',"windows":', array: index(windows), after: "" },
      { at: 20, before: ',"ocr":', array: index(ocr), after: "" },
      { at: 30, before: ',"nodes":', array: index(nodes), after: "" },
    ] };
  });
  let region = "";
  const offsets = arrays.map((text) => {
    const offset = Buffer.byteLength(region);
    region += text;
    return [offset, Buffer.byteLength(text)];
  });
  const header = { format: "org.lifestreamprotocol.screen-text/1", window: [from * 1000, to * 1000],
    arrays: offsets, frames: frames.map((frame, ordinal) => ({ bundle: `b-${ordinal}`, displayID: 1, observationSHA256: "0".repeat(64), splices: frame.splices })) };
  const bytes = brotliCompressSync(Buffer.from(`${JSON.stringify(header)}\n${region}`), { params: { [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MIN_QUALITY } });
  const hash = blobs.put(bytes, { mediaType: "application/vnd.lifestreamprotocol.screen-text" });
  const segmentSHA256 = Buffer.from(hash.slice(7), "hex").toString("base64");
  return times.map((t, ordinal): ReaderOutput => {
    const view = show(t);
    return {
      kind: "frame", key: basic(t), time: { start_ms: t, precision: "ms" },
      content: {
        type: "screen.lifestream.frame", capturedAt: t + 0.25, displayID: 1, width: 1440, height: 900, status: "captured", ocrStatus: "ok",
        application: { bundleID: bundleOf(view.app), name: view.app, pid: 42 }, frontWindow: { windowID: 7 }, inputIdleSeconds: 0.5,
        accessibility: { capturedAt: t + 0.1, status: "ok" }, timings: { capture_ms: 12 }, image: { archive: { segmentSHA256: "AA==", ordinal } },
        text: { segment: "00000000-0000-0000-0000-000000000001.lstext", segmentSHA256, segmentBytes: bytes.length, ordinal, observationSHA256: "0".repeat(64) },
        blobs: [{ hash, type: "application/vnd.lifestreamprotocol.screen-text", bytes: bytes.length, role: "screen-recorder-text" }],
        ...tick,
      },
    };
  });
}

function recorderGap(from: number, to: number, status: "gap" | "excluded", reason: string): ReaderOutput {
  return {
    kind: "recorder", key: basic(from), time: { start_ms: from, end_ms: to, precision: "ms" },
    content: { type: "screen.lifestream.gap", capturedAt: from, displayID: 1, width: 1440, height: 900, windows: [], ocr: [], status, ocrStatus: "none", reason },
  };
}

function coastFrames(from: number, to: number, every: number, show: (t: number) => Shown, tick: JsonObject = {}): ReaderOutput[] {
  const rows: ReaderOutput[] = [];
  let session: { key: string; app: string; frames: string[] } | null = null;
  const sessions: { key: string; app: string; frames: string[] }[] = [];
  for (let t = from; t < to; t += every) {
    const view = show(t);
    const key = String(t);
    if (session === null || session.app !== view.app) {
      session = { key, app: view.app, frames: [] };
      sessions.push(session);
    }
    session.frames.push(key);
    rows.push({
      kind: "frame", key, time: { start_ms: t, precision: "ms" },
      content: {
        type: "screen.frame", frame_id: t / 1000, timestamp_ms: t, width: 1440, height: 900, is_inactive: 0, image_path: `v/${t}`,
        foreground: view.lines.join(". "), background: "", title: view.title, capture_display: { id: 1 }, video: { hash: "f".repeat(64), index: 0 },
        session_start_frame_identity: session.key, windows: [], ...tick,
      },
    });
    rows.push({
      kind: "ax", key, time: { start_ms: t, precision: "ms" },
      content: {
        type: "screen.ax", frame_identity: key, root_hash: "a".repeat(64), timestamp_ms: t, application_name: view.app, bundle_id: bundleOf(view.app),
        process_identifier: 42, extraction_mode: "full", is_partial_tree: 0,
        tree: { hash: "a".repeat(64), node: { role: "AXWindow", title: view.title }, children: view.lines.map((line) => ({ hash: "b".repeat(64), node: { role: "AXStaticText", value: line }, children: [] })) },
      },
    });
  }
  for (const each of sessions) {
    rows.push({
      kind: "session", key: each.key,
      content: { type: "screen.session", start_frame_identity: each.key, application: { bundle_id: bundleOf(each.app), version: "1", display_name: each.app }, frames: each.frames },
    });
  }
  return rows;
}

function inputChunk(t: number, app: string, word = "hello", tick: JsonObject = {}): ReaderOutput {
  const keys = [...word].map((key, index) => ({ t: 1_000 + index * 100, e: "key_down", key, app: 0 }));
  return {
    kind: "input", key: basic(t), time: { start_ms: t, end_ms: t + MIN, precision: "ms" },
    content: {
      type: "input.chunk", until: new Date(t + MIN).toISOString(), layout: "com.apple.keylayout.US", apps: [bundleOf(app)],
      events: [...keys, { t: 1_000 + word.length * 100, e: "key_down", name: "return", app: 0 }, { t: 5_000, e: "down", clicks: 1, app: 0, el: { role: "AXButton", title: "Send" } }],
      ...tick,
    },
  };
}

function machineEvent(t: number, event: string, detail: JsonObject = {}): ReaderOutput {
  return {
    kind: "machine-event", key: `${basic(t)}:${event}`, time: { start_ms: t, precision: "ms" },
    content: { type: "machine.event", event, detail },
  };
}

function bundleOf(app: string): string {
  return `com.example.${app.toLowerCase().replace(/[^a-z]/gu, "")}`;
}


type TextAsk = Omit<Ask, "input"> & { input: string };
type Model = (ask: TextAsk, attempt: number) => string | null;

const goodModel: Model = (ask) => {
  if (ask.prompt === SITTING_PROMPT) {
    const labels = [...new Set([...ask.input.matchAll(/"tasks":\{([^}]*)\}/gu)].flatMap((match) => [...match[1]!.matchAll(/"([^"]+)":/gu)].map((label) => label[1]!)))];
    return JSON.stringify({ summary: "One sitting, merged.", tasks: Object.fromEntries(labels.map((label) => [label, `${label}, whole sitting`])), people: [], projects: ["synthetic project"], other: [] });
  }
  const stretch = ask.prompt === PART_PROMPT
    ? /This call covers (\d\d:\d\d:\d\d)–(\d\d:\d\d:\d\d)/u.exec(ask.input)
    : /^STRETCH: (\d\d:\d\d:\d\d) to (\d\d:\d\d:\d\d)/mu.exec(ask.input);
  if (stretch === null) return "no stretch";
  const app = /^\d\d:\d\d:\d\d–\d\d:\d\d:\d\d \([^)]*\) ([^·\n]+) · “([^”]*)”/mu.exec(ask.input);
  const part = ask.prompt === COMPOSE_PROMPT ? /"doing":"([^"]*)"/u.exec(ask.input) : null;
  const doing = part !== null ? part[1]! : app === null ? "Was at the Mac" : `Worked in ${app[1]!.trim()} on ${app[2]}`;
  const parts = (ask.input.match(/^--- part /gmu) ?? []).length;
  return JSON.stringify({
    summary: ask.prompt === COMPOSE_PROMPT ? `${doing}, over ${parts} parts.` : `${doing}.`,
    timeline: [{ start: stretch[1], end: stretch[2], present: "yes", present_why: "typing", doing, task: "synthetic task", where: app?.[1]?.trim() ?? "" }],
    actions: [{ at: stretch[1], what: "Sent a synthetic message" }],
    life: { people: [], projects: ["synthetic project"], other: [] },
  });
};

interface LedgerFile {
  replies: Record<string, string>;
  calls: Record<string, number>;
}


class Harness {
  readonly db: HomeDb;
  readonly blobs: BlobStore;
  readonly family: Family;
  readonly ledger: LedgerFile;
  writes = 0;
  model: Model;

  constructor(readonly dir: string, options: { cutover_ms?: number; model?: Model; zone?: string; machineLog?: "machine-events" | "machine-ios-bundle" } = {}) {
    this.db = openHome(openHomeFolder(dir), "migrate");
    this.blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
    this.family = screenFamily({ zone: options.zone ?? SETTINGS.zone, ...(options.cutover_ms === undefined ? {} : { cutover_ms: options.cutover_ms }) })(FED.screen);
    this.model = options.model ?? goodModel;
    const path = join(dir, "ledger.json");
    this.ledger = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as LedgerFile : { replies: {}, calls: {} };
    this.db.commit((tx) => {
      for (const id of [COAST, RECORDER, INPUT]) {
        if (tx.tables.sources.get(id) === undefined) tx.tables.sources.add({ id, vendor: SYNTHETIC_VENDOR, connector: id.split(":")[0]!, added_ms: 0 });
      }
      if (options.machineLog !== undefined && tx.tables.sources.get(MACHINE_LOG) === undefined) tx.tables.sources.add({ id: MACHINE_LOG, vendor: SYNTHETIC_VENDOR, connector: options.machineLog, added_ms: 0 });
    });
  }

  close(): void {
    writeFileSync(join(this.dir, "ledger.json"), `${JSON.stringify(this.ledger)}\n`);
    this.db.close();
  }

  land(source: string, stated_ms: number, rows: ReaderOutput[], read_ms = stated_ms): void {
    const before = this.db.view();
    const heads = new Map(rows.map((row) => [`${row.kind}\0${row.key}`, before.head({ source, kind: row.kind, key: row.key })]));
    const rt = before.tables.sources.get(source)?.read_through_ms ?? null;
    before.close();
    this.db.commit((tx) => {
      const run = tx.tables.runs.start({ kind: "import", subject: source, started_ms: stated_ms });
      const landed = tx.records.land(run, { id: `${source}@${stated_ms}`, source, stated_ms }, rows, GUARDS, { has: () => true });
      expect(landed.refusals).toEqual([]);
      tx.tables.sources.advance(source, read_ms);
      tx.tables.runs.end(run, { ended_ms: stated_ms, outcome: "ok" });
    });
    const view = this.db.view();
    const changes: Change[] = [];
    const versionOf = (id: string | undefined): Version | undefined => id === undefined || id === "gone" ? undefined : view.version(id);
    for (const [record, old] of heads) {
      const [kind, key] = record.split("\0") as [string, string];
      const now = view.head({ source, kind, key });
      if (now?.version === old?.version) continue;
      const change: Change = { record: { source, kind, key } };
      const beforeVersion = versionOf(old?.version);
      const afterVersion = versionOf(now?.version);
      if (beforeVersion !== undefined) change.before = beforeVersion;
      if (afterVersion !== undefined) change.after = afterVersion;
      changes.push(change);
    }
    const after = view.tables.sources.get(source)!.read_through_ms!;
    view.close();
    this.derive(changes, after === rt ? [] : [{ source, before_ms: rt, after_ms: after }]);
  }

  stateThrough(source: string, read_ms: number): void {
    const view = this.db.view();
    const rt = view.tables.sources.get(source)?.read_through_ms ?? null;
    view.close();
    this.db.commit((tx) => tx.tables.sources.advance(source, read_ms));
    this.derive([], rt !== null && rt >= read_ms ? [] : [{ source, before_ms: rt, after_ms: read_ms }]);
  }

  derive(changes: readonly Change[], moves: readonly ReadThroughMove[]): void {
    const view = this.db.view();
    const units = new Set<string>();
    const previous = new Set<string>();
    for (const touched of changes.length === 0 ? [] : this.family.touched(changes, view)) {
      units.add(touched.unit);
      if (touched.previous !== undefined) previous.add(touched.previous);
    }
    for (const move of moves) for (const unit of this.family.readThrough!(move, view)) units.add(unit);
    const built = [...units].sort().map((unit) => ({ unit, extracted: this.family.extract(unit, view, this.blobs) }));
    const through = view.through;
    view.close();
    const written: string[] = [];
    this.db.commit((tx) => {
      for (const unit of previous) if (!units.has(unit)) this.remove(tx, unit);
      for (const { unit, extracted } of built) {
        if (extracted === null) {
          this.remove(tx, unit);
          continue;
        }
        const row: ExtractRow = { family: "screen", unit, code: this.family.code, seq: through, days: [], ...extracted };
        row.days = this.family.days(row, SETTINGS);
        if (tx.derived.extracts.put(row)) {
          this.writes++;
          written.push(unit);
        }
      }
    });
    for (const unit of written) this.plan(unit);
  }

  private remove(tx: Parameters<Parameters<HomeDb["commit"]>[0]>[0], unit: string): void {
    tx.derived.extracts.delete("screen", unit);
    tx.derived.enrichments.delete("screen", unit);
  }

  plan(unit: string): void {
    const view = this.db.view();
    const row = view.extract("screen", unit);
    view.close();
    if (row === undefined) return;
    const answered = new Map<string, Reply>();
    const tries = new Map<string, number>();
    const asked = new Map<string, TextAsk>();
    for (;;) {
      const plan = this.family.plan!(row, answered);
      const answer = plan.answers?.find((each) => each.item === unit);
      if (answer !== undefined) return this.enrich(row, "done", answer.content);
      let progressed = false;
      for (const { item, reason } of plan.refusals ?? []) {
        const ask = asked.get(item)!;
        const count = (tries.get(item) ?? 1) + 1;
        tries.set(item, count);
        if (count > 3) return this.enrich(row, "given-up", null);
        const retry: TextAsk = { ...ask, input: `${ask.input}\n\nYour previous answer was refused:\n${answered.get(item)!.text}\n\nWhy:\n${reason}` };
        const replied = this.reply(retry, count);
        if (replied === undefined) continue;
        tries.set(item, replied.attempt);
        answered.set(item, replied.reply);
        progressed = true;
      }
      for (const ask of plan.asks.map((each): TextAsk => ({ ...worked(this.family, each), input: piecesText(each.input) }))) {
        asked.set(ask.item, ask);
        const replied = this.reply(ask, 1);
        if (replied !== undefined) {
          tries.set(ask.item, replied.attempt);
          answered.set(ask.item, replied.reply);
          progressed = true;
        }
      }
      if (!progressed) {
        if (plan.asks.length > 0 || (plan.refusals ?? []).length > 0) this.db.commit((tx) => tx.derived.enrichments.delete("screen", row.unit));
        return;
      }
    }
  }

  private reply(ask: TextAsk, attempt: number): { reply: Reply; attempt: number } | undefined {
    const key = `${ask.prompt}\0${digest(ask.input)}`;
    let text = this.ledger.replies[key];
    if (text === undefined) {
      const answer = this.model(ask, attempt);
      if (answer === null) return undefined;
      this.ledger.calls[key] = (this.ledger.calls[key] ?? 0) + 1;
      this.ledger.replies[key] = text = answer;
    }
    const prompt = SCREEN_PROMPTS[ask.prompt]!;
    const read = readReply(prompt, text);
    if ("value" in read) return { reply: { key: digest(key), model: "synthetic-model", text, value: read.value, version: prompt.version, at_ms: 0 }, attempt };
    if (attempt >= 3) return undefined;
    return this.reply({ ...ask, input: `${ask.input}\n\nYour previous answer was refused:\n${text}\n\nWhy:\n${read.violations.join("\n")}` }, attempt + 1);
  }

  private enrich(row: ExtractRow, state: EnrichmentRow["state"], content: Json): void {
    this.db.commit((tx) => tx.derived.enrichments.put({
      family: "screen", item: row.unit, prompt: ACCOUNT, input_hash: row.reading, reply_key: null, reused_from: null,
      content, state,
    }));
  }

  recover(): void {
    const view = this.db.view();
    const units = [...view.extracts("screen")].filter((row) => view.enrichment("screen", row.unit, ACCOUNT)?.state !== "done").map((row) => row.unit);
    view.close();
    for (const unit of units) this.plan(unit);
  }

  extracts(): ExtractRow[] {
    const view = this.db.view();
    const rows = [...view.extracts("screen")];
    view.close();
    return rows;
  }

  enrichment(unit: string): EnrichmentRow | undefined {
    const view = this.db.view();
    const row = view.enrichment("screen", unit, ACCOUNT);
    view.close();
    return row;
  }

  calls(): number {
    return Object.values(this.ledger.calls).reduce((sum, n) => sum + n, 0);
  }

  render(day: string): ReturnType<typeof renderDay> {
    const view = this.db.view();
    try {
      const reader: DayReader = {
        extractsOn: (family, on) => [...view.extracts(family)].filter((row) => row.days.includes(on)),
        enrichment: (family, item, prompt) => view.enrichment(family, item, prompt),
        sources: () => view.sources(),
        since: (source, kinds) => view.since(source, kinds),
      };
      return conforming(renderDay(day, [this.family], reader, SETTINGS, tableUnits(LABELS)));
    } finally {
      view.close();
    }
  }
}

const contentOf = (row: ExtractRow) => row.content as unknown as SittingContent;
const closedOf = (row: ExtractRow): ClosedSitting => {
  const content = contentOf(row);
  if (!content.closed) throw new Error(`${row.unit} is still open`);
  return content;
};

function nextMinute(minute: string): string {
  const total = Number(minute.slice(0, 2)) * 60 + Number(minute.slice(3)) + 1;
  return `${String(Math.floor(total / 60) % 24).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}


const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    if (process.env.LIFESTREAM_KEEP_ARTIFACTS === "1") console.log(`screen artifact kept: ${dir}`);
    else rmSync(dir, { recursive: true, force: true });
  }
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "families-screen-"));
  temps.push(dir);
  return dir;
}

function artifact(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

const editor = (t: number) => shown("Editor", `notes-${Math.floor(t / (10 * MIN)) % 3}.txt`);
const browser = () => shown("Browser", "Example page");
const switching = (t: number) => shown("Editor", `doc-${Math.floor(t / (30 * S)) % 7}.txt`);

function busy(home: Harness, from: number, to: number, read_ms: number, show: (t: number) => Shown = editor, every = 5 * MIN): void {
  home.land(RECORDER, read_ms, recorderFrames(home.blobs, from, to, 2 * S, show), read_ms);
  const chunks: ReaderOutput[] = [];
  for (let t = from; t < to; t += every) chunks.push(inputChunk(t, show(t).app));
  home.land(INPUT, read_ms, chunks, read_ms);
}

function busyMany(home: Harness, from: number, to: number, read_ms: number): void {
  busy(home, from, to, read_ms, switching, MIN);
}

function section(evidence: string, name: string): string[] {
  const found = evidence.split("\n\n## ").find((each) => /^\d\. /u.test(each) && each.slice(3).startsWith(name));
  return found === undefined ? [] : found.split("\n").slice(1);
}


describe("screen: what must be impossible", () => {
  it("an extract is written when only an unread field ticked", () => {
    const dir = temp();
    const home = new Harness(dir);
    const coastFrom = SCREEN_CUTOVER_MS - 3 * 60 * MIN;
    home.land(COAST, coastFrom + 30 * MIN, coastFrames(coastFrom, coastFrom + 20 * MIN, 20 * S, editor), SCREEN_CUTOVER_MS);
    const from = at("2026-10-01T14:00:00Z");
    busy(home, from, from + 40 * MIN, from + 50 * MIN);
    const before = home.extracts();
    expect(before.map((row) => contentOf(row).closed)).toEqual([true, true]);
    const needs = { effort: "medium", timeout_ms: 600_000 };
    expect(before.map((row) => home.family.plan!(row, new Map()).asks.map((ask) => [ask.work, ask.source, ask.needs]))).toEqual([
      [["screen", COAST, needs]], [["screen", RECORDER, needs]],
    ]);
    const writes = home.writes;
    const calls = home.calls();

    home.land(COAST, coastFrom + 40 * MIN, coastFrames(coastFrom, coastFrom + 20 * MIN, 20 * S, editor,
      { frame_id: 9, video: { hash: "e".repeat(64), index: 3 }, image_path: "elsewhere", background: "ticked", windows: [{ z_order: 1 }] }), SCREEN_CUTOVER_MS);
    home.land(RECORDER, from + 60 * MIN, recorderFrames(home.blobs, from, from + 40 * MIN, 10 * S, editor,
      { timings: { capture_ms: 99 }, inputIdleSeconds: 30.5, image: { pending: { file: "x", sha256: "0".repeat(64), bytes: 1 } }, acquisition: { mode: "ticked" } }), from + 60 * MIN);
    const ticked: ReaderOutput[] = [];
    for (let t = from; t < from + 40 * MIN; t += 5 * MIN) ticked.push(inputChunk(t, "Editor", "hello", { layout: "com.apple.keylayout.Dvorak", lost: 2 }));
    home.land(INPUT, from + 60 * MIN, ticked, from + 60 * MIN);
    const after = home.extracts();
    expect(home.writes).toBe(writes);
    expect(after).toEqual(before);
    expect(home.calls()).toBe(calls);

    home.land(RECORDER, from + 70 * MIN, recorderFrames(home.blobs, from + 10 * MIN, from + 11 * MIN, 10 * S, () => shown("Editor", "renamed.txt")), from + 70 * MIN);
    expect(home.writes).toBe(writes + 1);
    artifact(dir, "unread-tick", { writes: home.writes, units: after.map((row) => ({ unit: row.unit, reading: row.reading, seq: row.seq })) });
    home.close();
  });

  it("a sitting stays open after a stated read-through passes its gap", () => {
    const dir = temp();
    const home = new Harness(dir);
    const from = at("2026-10-01T15:00:00Z");
    const last = at("2026-10-01T15:31:00Z");
    busy(home, from, last + S, last + 30 * S);
    const [row] = home.extracts();
    expect(contentOf(row!).closed).toBe(false);
    home.stateThrough(RECORDER, at("2026-10-01T15:36:30Z"));
    expect(contentOf(home.extracts()[0]!).closed).toBe(false);
    expect(home.calls()).toBe(0);
    home.stateThrough(INPUT, at("2026-10-01T15:36:30Z"));
    const closed = home.extracts()[0]!;
    expect(contentOf(closed).closed).toBe(true);
    const enrichment = home.enrichment(closed.unit)!;
    expect(enrichment.state).toBe("done");
    expect(home.calls()).toBe(callsFor(closedOf(closed)));
    artifact(dir, "stated-through", { unit: closed.unit, enrichment });
    home.close();
  });

  it("Coast's last stated read-through, at the cutover, leaves the sitting that ends just before it open", () => {
    const dir = temp();
    const home = new Harness(dir);
    const cut = SCREEN_CUTOVER_MS;
    home.land(COAST, cut - MIN, coastFrames(cut - 20 * MIN, cut - MIN, 10 * S, () => shown("Coast Editor", "coast window")), cut - MIN);
    home.stateThrough(INPUT, cut + 30 * MIN);
    expect(contentOf(home.extracts()[0]!).closed).toBe(false);
    home.stateThrough(COAST, cut);
    const row = home.extracts()[0]!;
    expect(contentOf(row).closed).toBe(true);
    expect(home.enrichment(row.unit)?.state).toBe("done");
    artifact(dir, "coast-final", { unit: row.unit });
    home.close();
  });

  it("a sitting longer than a day stays open after its closing read-through", () => {
    const dir = temp();
    const home = new Harness(dir);
    const from = at("2026-10-01T06:00:00Z");
    const to = from + 25 * 60 * MIN;
    home.land(RECORDER, to, recorderFrames(home.blobs, from, to, 5 * MIN, editor), to);
    home.stateThrough(INPUT, to + 10 * MIN);
    expect(contentOf(home.extracts()[0]!).closed).toBe(false);
    home.stateThrough(RECORDER, to + 10 * MIN);
    const row = home.extracts()[0]!;
    expect(row.end_ms! - row.start_ms!).toBeGreaterThan(24 * 60 * MIN);
    expect(contentOf(row).closed).toBe(true);
    artifact(dir, "long-sitting", { unit: row.unit, hours: (row.end_ms! - row.start_ms!) / (60 * MIN) });
    home.close();
  });

  it("a sitting is asked before it closes", () => {
    const dir = temp();
    const home = new Harness(dir);
    const from = at("2026-10-01T09:00:00Z");
    const seen: { t: string; closed: boolean; calls: number }[] = [];
    for (let t = from; t < from + 60 * MIN; t += 5 * MIN) {
      busy(home, t, t + 5 * MIN, t + 5 * MIN);
      const row = home.extracts().at(-1)!;
      seen.push({ t: new Date(t).toISOString(), closed: contentOf(row).closed, calls: home.calls() });
      expect(home.extracts()).toHaveLength(1);
      expect(contentOf(row)).toEqual({ machine: "macbook-pro-0001", start_ms: row.start_ms, end_ms: row.end_ms, closed: false });
      expect(home.calls()).toBe(0);
      expect(home.enrichment(row.unit)).toBeUndefined();
    }
    const open = home.render("2026-10-01").txt;
    expect(open).toMatch(/Screen · 60 min at the Mac \(so far\)/u);
    home.stateThrough(RECORDER, from + 70 * MIN);
    home.stateThrough(INPUT, from + 70 * MIN);
    const row = home.extracts()[0]!;
    expect(home.calls()).toBe(callsFor(closedOf(row)));
    artifact(dir, "asked-closed", { seen, parts: partsOf(closedOf(row)).map((part) => [part.start_ms, part.end_ms]) });
    home.close();
  });

  it("a delivery into an open sitting reads the sitting's frames, text or events, so it costs more the longer the sitting", () => {
    const dir = temp();
    const home = new Harness(dir);
    const from = at("2026-10-01T09:00:00Z");
    busy(home, from, from + 30 * MIN, from + 30 * MIN);
    const row = home.extracts()[0]!;
    expect(contentOf(row).closed).toBe(false);
    const asked: string[] = [];
    const spied = home.db.view();
    try {
      const view = new Proxy(spied, {
        get: (target, property, receiver) => {
          const value = Reflect.get(target, property, receiver) as unknown;
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (property === "records" || property === "version") asked.push(`${String(property)} ${String(args[0])} ${String(args[1] ?? "")}`);
            return (value as (...args: unknown[]) => unknown).apply(target, args);
          };
        },
      });
      const blobs = { has: () => { asked.push("blob"); return false; }, bytes: () => { asked.push("blob"); throw new Error("read"); } } as unknown as BlobStore;
      const built = home.family.extract(row.unit, view, blobs);
      expect(built?.reading).toBe(row.reading);
    } finally {
      spied.close();
    }
    expect(asked.filter((call) => / (frame|input|machine-event)$/u.test(call) || call === "blob" || call.startsWith("version"))).toEqual([]);
    home.close();
  });

  it("a sitting's read holds every frame's text to its end, or reads a segment more often than its frames are passed in time order", () => {
    const dir = temp();
    const home = new Harness(dir);
    const from = at("2026-10-03T09:00:00Z");
    const segments = 12;
    for (let i = 0; i < segments; i++) busy(home, from + i * 5 * MIN, from + (i + 1) * 5 * MIN, from + (i + 1) * 5 * MIN);
    home.stateThrough(RECORDER, from + 120 * MIN);
    home.stateThrough(INPUT, from + 120 * MIN);
    const row = home.extracts()[0]!;
    expect(contentOf(row).closed).toBe(true);
    const decoded: string[] = [];
    const blobs = {
      has: (hash: string) => home.blobs.has(hash),
      bytes: (hash: string) => {
        decoded.push(hash);
        return home.blobs.bytes(hash);
      },
    } as unknown as BlobStore;
    const view = home.db.view();
    try {
      expect(home.family.extract(row.unit, view, blobs)?.reading).toBe(row.reading);
    } finally {
      view.close();
    }
    const each = [...new Set(decoded)];
    const passes = decoded.length / segments;
    expect({ segments: each.length, passes: Number.isInteger(passes) && passes >= 2 }).toEqual({ segments, passes: true });
    expect(decoded).toEqual(Array.from({ length: passes }, () => each).flat());
    const late = each[0]!;
    const build = (has: (hash: string) => boolean) => {
      const reading = home.db.view();
      try {
        return home.family.extract(row.unit, reading, { has, bytes: (hash: string) => home.blobs.bytes(hash) } as unknown as BlobStore);
      } finally {
        reading.close();
      }
    };
    let asked = false;
    const landing = build((hash) => (hash === late && !asked ? ((asked = true), false) : home.blobs.has(hash)));
    const never = build((hash) => hash !== late && home.blobs.has(hash));
    expect(landing?.reading).toBe(never?.reading);
    artifact(dir, "segments", { decoded: decoded.length, segments });
    home.close();
  });

  it("frames arriving out of order give different units than in order", () => {
    const from = at("2026-10-02T10:00:00Z");
    const deliveries: [number, number][] = [[0, 20], [20, 40], [41, 46], [52, 70], [46, 48], [-3, 0], [120, 140]];
    const run = (order: number[]) => {
      const dir = temp();
      const home = new Harness(dir);
      order.forEach((index, step) => {
        const [a, b] = deliveries[index]!;
        home.land(RECORDER, from + 200 * MIN + step * MIN, recorderFrames(home.blobs, from + a * MIN, from + b * MIN, 30 * S, editor), from + b * MIN);
      });
      home.stateThrough(RECORDER, from + 300 * MIN);
      home.stateThrough(INPUT, from + 300 * MIN);
      const units = home.extracts().map((row) => ({ unit: row.unit, reading: row.reading, start_ms: row.start_ms, end_ms: row.end_ms, days: row.days }));
      const accounts = units.map(({ unit }) => home.enrichment(unit)?.content ?? null);
      home.close();
      return { dir, units, accounts };
    };
    const inOrder = run([5, 0, 1, 2, 4, 3, 6]);
    const shuffled = run([6, 3, 1, 4, 0, 2, 5]);
    expect(shuffled.units).toEqual(inOrder.units);
    expect(shuffled.accounts).toEqual(inOrder.accounts);
    expect(inOrder.units.map((row) => row.unit)).toEqual([`${MACHINE}/${from - 3 * MIN}`, `${MACHINE}/${from + 120 * MIN}`]);
    artifact(inOrder.dir, "order", { inOrder: inOrder.units, shuffled: shuffled.units });
  });

  it("a sitting straddling the cutover reads both sources for one minute", () => {
    const dir = temp();
    const home = new Harness(dir, { zone: "UTC" });
    const cut = SCREEN_CUTOVER_MS;
    home.land(COAST, cut + 30 * MIN, coastFrames(cut - 20 * MIN, cut + 10 * MIN, 10 * S, () => shown("Coast Editor", "coast window")), cut + 10 * MIN);
    home.land(RECORDER, cut + 30 * MIN, recorderFrames(home.blobs, cut - 10 * MIN, cut + 20 * MIN, 10 * S, () => shown("Recorder Editor", "recorder window")), cut + 30 * MIN);
    home.stateThrough(INPUT, cut + 30 * MIN);
    const rows = home.extracts();
    expect(rows).toHaveLength(1);
    const content = closedOf(rows[0]!);
    expect([content.start_ms, content.end_ms]).toEqual([cut - 20 * MIN, cut + 20 * MIN - 10 * S]);
    expect(content.closed).toBe(true);
    const runs = partsOf(content).flatMap((part) => part.evidence.split("\n"))
      .map((line) => /^(\d\d:\d\d:\d\d)–(\d\d:\d\d:\d\d) \(.*?\) (Coast Editor|Recorder Editor) /u.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map(([, start, end, app]) => ({ start: start!, end: end!, app: app! }));
    const cutClock = new Date(cut).toISOString().slice(11, 19);
    expect(new Set(runs.map((run) => run.app))).toEqual(new Set(["Coast Editor", "Recorder Editor"]));
    const minutes = new Map<string, Set<string>>();
    for (const run of runs) {
      if (run.app === "Coast Editor") expect(run.end <= cutClock).toBe(true);
      else expect(run.start >= cutClock).toBe(true);
      for (let minute = run.start.slice(0, 5); minute <= run.end.slice(0, 5); minute = nextMinute(minute)) {
        minutes.set(minute, (minutes.get(minute) ?? new Set()).add(run.app));
      }
    }
    expect([...minutes].filter(([, apps]) => apps.size > 1)).toEqual([]);
    artifact(dir, "cutover", { unit: rows[0]!.unit, runs, minutes: Object.fromEntries([...minutes].map(([minute, apps]) => [minute, [...apps]])) });
    home.close();
  });

  it("a sitting across the cutover states one of its screen sources' accounts and not the other's", () => {
    const home = new Harness(temp(), { zone: "UTC" });
    const cut = SCREEN_CUTOVER_MS;
    home.land(COAST, cut + 30 * MIN, coastFrames(cut - 20 * MIN, cut + 10 * MIN, 10 * S, () => shown("Coast Editor", "coast window")), cut + 10 * MIN);
    home.land(RECORDER, cut + 30 * MIN, recorderFrames(home.blobs, cut - 10 * MIN, cut + 20 * MIN, 10 * S, () => shown("Recorder Editor", "recorder window")), cut + 30 * MIN);
    home.land(INPUT, cut + 30 * MIN, [inputChunk(cut - 15 * MIN, "Coast Editor")], cut + 30 * MIN);
    expect(home.extracts()).toHaveLength(1);
    const day = JSON.parse(home.render("2026-09-21").json) as DayDocument;
    const stated = [...day.atoms.map((atom) => atom.accounts), ...day.facts.map((fact) => fact.from.accounts)];
    expect(stated.length).toBeGreaterThan(0);
    expect(new Set(stated.map((accounts) => JSON.stringify(accounts)))).toEqual(new Set([JSON.stringify([COAST, INPUT, RECORDER].map(accountOf).sort())]));
    home.close();
  });

  it("an answered part is asked again after a restart", () => {
    const dir = temp();
    const from = at("2026-10-03T12:10:00Z");
    let budget = 1;
    const first = new Harness(dir, { model: (ask, attempt) => budget-- > 0 ? goodModel(ask, attempt) : null });
    busyMany(first, from, from + 50 * MIN, from + 60 * MIN);
    const unit = first.extracts()[0]!.unit;
    const content = closedOf(first.extracts()[0]!);
    expect(content.blocks).toHaveLength(1);
    const parts = content.blocks[0]!.parts.length;
    expect(parts).toBeGreaterThan(1);
    expect(first.calls()).toBe(1);
    expect(first.enrichment(unit)).toBeUndefined();
    first.close();
    const second = new Harness(dir);
    second.recover();
    expect(second.enrichment(unit)?.state).toBe("done");
    expect(Object.values(second.ledger.calls)).toEqual(new Array(parts + 1).fill(1));
    artifact(dir, "restart", { unit, calls: second.ledger.calls });
    second.close();
  });

  it("a late frame bridging two sittings leaves an orphan unit", () => {
    const dir = temp();
    const home = new Harness(dir);
    const from = at("2026-10-04T10:00:00Z");
    busy(home, from, from + 10 * MIN, from + 40 * MIN);
    busy(home, from + 16 * MIN, from + 30 * MIN, from + 40 * MIN);
    const two = home.extracts().map((row) => row.unit);
    expect(two).toHaveLength(2);
    expect(two.every((unit) => home.enrichment(unit)?.state === "done")).toBe(true);
    home.land(RECORDER, from + 50 * MIN, recorderFrames(home.blobs, from + 13 * MIN, from + 13 * MIN + 1, 10 * S, browser), from + 40 * MIN);
    const rows = home.extracts();
    expect(rows.map((row) => row.unit)).toEqual([two[0]]);
    expect([rows[0]!.start_ms, rows[0]!.end_ms]).toEqual([from, from + 30 * MIN - 2 * S]);
    expect(home.enrichment(two[1]!)).toBeUndefined();
    expect(home.enrichment(two[0]!)?.state).toBe("done");
    artifact(dir, "bridge", { before: two, after: rows.map((row) => row.unit) });
    home.close();
  });

  it("a late frame before a sitting's first frame leaves the old account standing", () => {
    const dir = temp();
    const home = new Harness(dir);
    const from = at("2026-10-05T10:02:00Z");
    busyMany(home, from, from + 50 * MIN, from + 60 * MIN);
    const [old] = home.extracts();
    expect(home.enrichment(old!.unit)?.state).toBe("done");
    home.land(RECORDER, from + 100 * MIN, recorderFrames(home.blobs, from - 4 * MIN, from - 4 * MIN + 1, 10 * S, browser), from + 60 * MIN);
    const [now] = home.extracts();
    expect(now!.unit).toBe(`${MACHINE}/${from - 4 * MIN}`);
    expect(home.extracts()).toHaveLength(1);
    expect(home.enrichment(old!.unit)).toBeUndefined();
    const account = home.enrichment(now!.unit)!;
    expect(account.state).toBe("done");
    expect((account.content as unknown as Account).timeline[0]!.start_ms).toBe(from - 4 * MIN);
    artifact(dir, "late-first", { old: old!.unit, now: now!.unit, calls: home.ledger.calls });
    home.close();
  });

  it("a refused reply becomes the account", () => {
    const dir = temp();
    const refusals: string[] = [];
    const home = new Harness(dir, {
      model: (ask, attempt) => {
        if (attempt > 1) refusals.push(ask.input.slice(ask.input.lastIndexOf("Why:")));
        if (attempt === 1) return "I am not able to describe this.";
        if (attempt === 2) {
          return JSON.stringify({ summary: "The frames show typing.", timeline: [{ start: "00:00:00", end: "00:00:01", present: "yes", present_why: "frames show typing", doing: "x", task: "x", where: "" }], actions: [], life: { people: [], projects: [], other: [] } });
        }
        return goodModel(ask, attempt);
      },
    });
    const from = at("2026-10-06T08:00:00Z");
    busy(home, from, from + 20 * MIN, from + 30 * MIN);
    const [row] = home.extracts();
    const enrichment = home.enrichment(row!.unit)!;
    expect(enrichment.state).toBe("done");
    const account = enrichment.content as { summary: string; timeline: { start_ms: number; end_ms: number }[] };
    expect(account.summary).toMatch(/^Worked in Editor/u);
    expect(JSON.stringify(account)).not.toMatch(/not able|frames show/u);
    expect(refusals[0]).toMatch(/no JSON object/u);
    expect(refusals[1]).toMatch(/never how the evidence was collected/u);
    expect(account.timeline[0]!.start_ms).toBe(from);
    artifact(dir, "refused", { refusals, enrichment });
    home.close();
  });

  it("a cut across an emoji leaves half of it, which no extract can hold, or a cut that split nothing moves", () => {
    const dir = temp();
    const home = new Harness(dir);
    const from = at("2026-10-08T14:00:00Z");
    const flag = "\u{1F3F4}";
    const click = (t: number, el: JsonObject) => ({ t, e: "down", clicks: 1, app: 0, el });
    home.land(INPUT, from + 40 * MIN, [inputChunk(from + MIN, "Editor", "hello", { events: [
      click(1_000, { role: "AXButton", title: `${"a".repeat(79)}${flag} tail` }),
      click(2_000, { role: "AXButton", value: `${"b".repeat(79)}${flag} tail` }),
      click(3_000, { role: "AXLink", url: `${"c".repeat(79)}${flag} tail` }),
      click(4_000, { role: "AXButton", title: `${"d".repeat(78)}${flag} tail` }),
      click(5_000, { role: "AXButton", title: "e".repeat(100) }),
    ] })], from + 40 * MIN);
    busy(home, from, from + 20 * MIN, from + 40 * MIN);
    const [row] = home.extracts();
    const actions = partsOf(closedOf(row!)).flatMap((part) => section(part.evidence, "ACTIONS"));
    const on = (letter: string) => actions.find((line) => line.includes(letter.repeat(70)));
    expect(on("a")).toContain(`“${"a".repeat(79)}”`);
    expect(on("b")).toContain(`“${"b".repeat(79)}”`);
    expect(on("c")).toContain(`<${"c".repeat(79)}>`);
    expect(on("d")).toContain(`“${"d".repeat(78)}${flag}”`);
    expect(on("e")).toContain(`“${"e".repeat(80)}”`);
    artifact(dir, "cut-emoji", { unit: row!.unit, actions });
    home.close();
  });

  it("a part leaves out the machine's events, or the last part leaves out how the sitting ended", () => {
    const dir = temp();
    const home = new Harness(dir, { machineLog: "machine-events" });
    const from = at("2026-10-08T14:00:00Z");
    const end = from + 20 * MIN - 2 * S;
    home.land(MACHINE_LOG, from + 40 * MIN, [
      machineEvent(from - 2 * MIN, "wake"),
      machineEvent(from + 5 * MIN, "mic_start", { app: "com.example.call", device: "BuiltInMicrophoneDevice" }),
      machineEvent(from + 6 * MIN, "shipper_run", { shipped: 3 }),
      machineEvent(end + 30 * S, "lock"),
      machineEvent(end + 60 * S, "display_sleep"),
      machineEvent(end + 10 * MIN, "wake"),
    ], from + 40 * MIN);
    busy(home, from, from + 20 * MIN, from + 40 * MIN);
    const [row] = home.extracts();
    const content = closedOf(row!);
    expect(content.closed).toBe(true);
    const parts = partsOf(content);
    expect(parts).toHaveLength(1);
    const events = section(parts[0]!.evidence, "MACHINE EVENTS");
    expect(events).toEqual([
      '10:05:00 mic_start {"app":"com.example.call","device":"BuiltInMicrophoneDevice"}',
      "10:20:28 lock (after this stretch ended)",
      "10:20:58 display_sleep (after this stretch ended)",
    ]);
    expect(parts[0]!.evidence).toContain("## 2. MACHINE EVENTS (and the first minutes after the person left the Mac)");
    expect(home.enrichment(row!.unit)?.state).toBe("done");
    artifact(dir, "machine-events", { unit: row!.unit, events, evidence: parts[0]!.evidence });
    home.close();
  });

  it("a part reads the whole sitting's frames, events and machine events, so a sitting's build grows with the square of its length", () => {
    const readsPerItem = (hours: number): number => {
      const from = at("2026-10-03T09:00:00Z");
      const end = from + hours * 60 * MIN;
      let reads = 0;
      const counted = <T extends object>(value: T): T => new Proxy(value, { get: (target, key, receiver) => (reads++, Reflect.get(target, key, receiver)) });
      const rows: FrameRow[] = [];
      for (let t = from; t < end; t += 2 * S) {
        const title = `doc-${Math.floor((t - from) / (30 * S)) % 7}.txt`;
        rows.push(counted({ t, app: "Editor", bundle: bundleOf("Editor"), title, site: null, inactive: false, text: () => [`${title}: synthetic line`] }));
      }
      const events: InputEvent[] = [];
      for (let t = from, n = 0; t < end; t += 3 * S, n++) {
        const raw: JsonObject = n % 20 === 19 ? { e: "key_down", name: "return" } : n % 20 === 7 ? { e: "key_down", key: "s", mods: ["cmd"] }
          : n % 2 === 0 ? { e: "key_down", key: "a" } : { e: "move" };
        events.push(counted({ t, e: String(raw.e), app: "Editor", raw }));
      }
      const machine: MachineEvent[] = [];
      for (let t = from; t < end; t += 5 * MIN) machine.push(counted({ t, event: "wifi_change", detail: {} }));
      const evidence = evidenceOf({ rows, gaps: [], events, machine, hasInput: true, textMissing: 0 }, clockOf("UTC"));
      reads = 0;
      let parts = 0;
      for (const block of blocksOf(evidence, from, end)) {
        for (const part of block.parts) {
          parts++;
          partEvidence(evidence, part.start_ms, part.end_ms, end);
        }
      }
      expect(parts).toBeGreaterThan(hours * 8);
      return reads / (rows.length + events.length + machine.length);
    };
    expect(readsPerItem(6)).toBeLessThan(readsPerItem(1) * 1.5);
  });

  it("a sitting closes before the machine's events are read past it", () => {
    const dir = temp();
    const home = new Harness(dir, { machineLog: "machine-events" });
    const from = at("2026-10-08T16:00:00Z");
    const last = from + 20 * MIN - 2 * S;
    busy(home, from, from + 20 * MIN, from + 40 * MIN);
    expect(contentOf(home.extracts()[0]!).closed).toBe(false);
    home.land(MACHINE_LOG, last + 2 * MIN, [machineEvent(from + MIN, "mic_stop")], last + 2 * MIN);
    expect(contentOf(home.extracts()[0]!).closed).toBe(false);
    expect(home.calls()).toBe(0);
    home.stateThrough(MACHINE_LOG, last + 6 * MIN);
    const row = home.extracts()[0]!;
    expect(contentOf(row).closed).toBe(true);
    expect(home.enrichment(row.unit)?.state).toBe("done");
    artifact(dir, "machine-closes", { unit: row.unit });
    home.close();
  });

  it("the Mac app's own shipping rewrites a sitting", () => {
    const dir = temp();
    const home = new Harness(dir, { machineLog: "machine-events" });
    const from = at("2026-10-08T18:00:00Z");
    home.stateThrough(MACHINE_LOG, from + 40 * MIN);
    busy(home, from, from + 20 * MIN, from + 40 * MIN);
    const writes = home.writes;
    const calls = home.calls();
    const view = home.db.view();
    const runs = [machineEvent(from + 2 * MIN, "shipper_run", { shipped: 1 }), machineEvent(from + 7 * MIN, "shipper_run", { shipped: 2 })];
    expect(home.family.touched(runs.map((each) => ({ record: { source: MACHINE_LOG, kind: each.kind, key: each.key }, after: { kind: each.kind, key: each.key, content: each.content, ...(each.time === undefined ? {} : { time: each.time }) } as unknown as Version })), view)).toEqual([]);
    view.close();
    home.land(MACHINE_LOG, from + 50 * MIN, runs, from + 50 * MIN);
    expect(home.writes).toBe(writes);
    expect(home.calls()).toBe(calls);
    home.land(MACHINE_LOG, from + 60 * MIN, [machineEvent(from + 9 * MIN, "lock")], from + 60 * MIN);
    expect(home.writes).toBe(writes + 1);
    artifact(dir, "shipper-runs", { writes: home.writes });
    home.close();
  });

  it("a recorder gap that lands after its sitting closed rewrites the sitting or asks the model", () => {
    const dir = temp();
    const home = new Harness(dir);
    const from = at("2026-10-08T20:00:00Z");
    const to = from + 20 * MIN;
    const hole = from + 5 * MIN;
    home.land(RECORDER, to + 10 * MIN, [
      ...recorderFrames(home.blobs, from, hole, 2 * S, editor), ...recorderFrames(home.blobs, hole + 30 * S, to, 2 * S, editor),
      recorderGap(to, to, "gap", "input-inactive-capture-paused"),
    ], to + 10 * MIN);
    const chunks: ReaderOutput[] = [];
    for (let t = from; t < to; t += 5 * MIN) chunks.push(inputChunk(t, "Editor"));
    home.land(INPUT, to + 10 * MIN, chunks, to + 10 * MIN);
    const [row] = home.extracts();
    expect(contentOf(row!).closed).toBe(true);
    expect(home.enrichment(row!.unit)?.state).toBe("done");
    const writes = home.writes;
    const calls = home.calls();
    const day = home.render("2026-10-08").txt;

    const late = [
      recorderGap(to + 2 * S, to + 40 * MIN, "gap", "input-inactive-capture-paused"),
      recorderGap(to + 40 * MIN, to + 70 * MIN, "gap", "storage_backpressure"),
      recorderGap(to + 70 * MIN + 2 * S, to + 90 * MIN, "gap", "storage-failed"),
      recorderGap(to + 90 * MIN + 2 * S, to + 150 * MIN, "gap", "recorder-not-running"),
    ];
    for (const [index, gap] of late.entries()) {
      home.land(RECORDER, to + 160 * MIN + index * MIN, [gap], to + 160 * MIN + index * MIN);
      expect(home.writes).toBe(writes);
      expect(home.calls()).toBe(calls);
    }
    expect(home.extracts()).toEqual([row]);
    expect(home.enrichment(row!.unit)?.state).toBe("done");
    expect(home.render("2026-10-08").txt).toBe(day);

    home.land(RECORDER, to + 170 * MIN, [recorderGap(hole, hole + 30 * S, "gap", "display_asleep")], to + 170 * MIN);
    expect(home.writes).toBe(writes + 1);
    expect(home.calls()).toBeGreaterThan(calls);
    artifact(dir, "late-gaps", { unit: row!.unit, writes: home.writes, calls: home.calls() });
    home.close();
  });

  it("a phone's diary is read as a sitting's machine events, or touches a sitting", () => {
    const dir = temp();
    const home = new Harness(dir, { machineLog: "machine-ios-bundle" });
    const from = at("2026-10-08T20:00:00Z");
    home.land(MACHINE_LOG, from + 40 * MIN, [machineEvent(from + 5 * MIN, "lock"), machineEvent(from + 20 * MIN + 30 * S, "display_sleep")], from + 40 * MIN);
    busy(home, from, from + 20 * MIN, from + 40 * MIN);
    const [row] = home.extracts();
    const content = closedOf(row!);
    expect(content.closed).toBe(true);
    expect(partsOf(content).map((part) => section(part.evidence, "MACHINE EVENTS"))).toEqual(partsOf(content).map(() => ["(none)"]));
    const writes = home.writes;
    const calls = home.calls();
    const unlock = machineEvent(from + 9 * MIN, "unlock");
    const view = home.db.view();
    expect(home.family.touched([{ record: { source: MACHINE_LOG, kind: unlock.kind, key: unlock.key }, after: { kind: unlock.kind, key: unlock.key, content: unlock.content, time: unlock.time } as unknown as Version }], view)).toEqual([]);
    expect(home.family.readThrough!({ source: MACHINE_LOG, before_ms: from + 40 * MIN, after_ms: from + 60 * MIN }, view)).toEqual([]);
    view.close();
    home.land(MACHINE_LOG, from + 60 * MIN, [unlock], from + 60 * MIN);
    expect([home.writes, home.calls()]).toEqual([writes, calls]);
    artifact(dir, "phone-diary", { unit: row!.unit, evidence: partsOf(content).map((part) => part.evidence) });
    home.close();
  });

  it("a part is asked before the part before it is answered, or without its answer", () => {
    const dir = temp();
    const asked: string[] = [];
    const inputs = new Map<string, string>();
    let answering = false;
    const home = new Harness(dir, { model: (ask, attempt) => {
      asked.push(ask.item);
      inputs.set(ask.item, ask.input);
      return answering ? goodModel(ask, attempt) : null;
    } });
    const from = at("2026-10-09T09:00:00Z");
    busyMany(home, from, from + 50 * MIN, from + 60 * MIN);
    const [row] = home.extracts();
    const content = closedOf(row!);
    const parts = content.blocks[0]!.parts;
    expect(parts.length).toBeGreaterThan(1);
    expect([...new Set(asked)]).toEqual([`${row!.unit}/part/${parts[0]!.start_ms}`]);
    answering = true;
    home.recover();
    expect(home.enrichment(row!.unit)?.state).toBe("done");
    const order = [...new Set(asked)];
    expect(order).toEqual([...parts.map((part) => `${row!.unit}/part/${part.start_ms}`), `${row!.unit}/compose/${content.blocks[0]!.start_ms}`]);
    const previous = "The JSON you returned for the previous part, for continuity";
    parts.forEach((part, index) => {
      const input = inputs.get(`${row!.unit}/part/${part.start_ms}`)!;
      if (index === 0) expect(input).not.toContain(previous);
      else expect(input).toContain(`${previous} (reuse its task labels when the same work continues):\n{"summary":"Worked in Editor`);
    });
    artifact(dir, "in-order", { order, parts: parts.map((part) => [part.start_ms, part.end_ms]) });
    home.close();
  });

  it("clocks are written in UTC when the home's zone is not", () => {
    const from = at("2026-10-09T14:00:00Z");
    const seen: Record<string, unknown> = {};
    for (const [zone, wall, until] of [["America/New_York", "10:00:00", "10:19:58"], ["Asia/Kolkata", "19:30:00", "19:49:58"]] as const) {
      const dir = temp();
      const inputs: string[] = [];
      const home = new Harness(dir, { zone, model: (ask, attempt) => {
        inputs.push(ask.input);
        return goodModel(ask, attempt);
      } });
      busy(home, from, from + 20 * MIN, from + 40 * MIN);
      const [row] = home.extracts();
      const evidence = partsOf(closedOf(row!))[0]!.evidence;
      expect(evidence.split("\n")[0]).toBe(`STRETCH: ${wall} to ${until} ${zone}, 2026-10-09`);
      expect(inputs[0]).toContain(`This call covers ${wall}–${until} ${zone} only`);
      const account = home.enrichment(row!.unit)!.content as unknown as Account;
      expect(account.timeline[0]!.start_ms).toBe(from);
      expect(account.timeline.at(-1)!.end_ms).toBe(from + 20 * MIN - 2 * S);
      expect(account.actions[0]!.at_ms).toBe(from);
      seen[zone] = { stretch: evidence.split("\n")[0], timeline: account.timeline };
      home.close();
      artifact(dir, "zone", seen);
    }
  });

  it("a sitting of several blocks ends as one account without the sitting pass", () => {
    const dir = temp();
    const home = new Harness(dir);
    const from = at("2026-10-10T08:00:00Z");
    busy(home, from, from + 90 * MIN, from + 100 * MIN);
    const [row] = home.extracts();
    const content = closedOf(row!);
    expect(content.blocks.length).toBeGreaterThan(1);
    expect(content.blocks[0]!.start_ms).toBe(from);
    content.blocks.slice(1).forEach((block, index) => expect(block.start_ms).toBe(content.blocks[index]!.end_ms));
    expect(home.calls()).toBe(callsFor(content));
    const account = home.enrichment(row!.unit)!.content as unknown as Account;
    expect(account.summary).toBe("One sitting, merged.");
    expect(new Set(account.timeline.map((entry) => entry.task))).toEqual(new Set(["synthetic task, whole sitting"]));
    expect(account.timeline[0]!.start_ms).toBe(from);
    account.timeline.slice(1).forEach((entry, index) => expect(entry.start_ms).toBe(account.timeline[index]!.end_ms));
    artifact(dir, "sitting-pass", { blocks: content.blocks.map((block) => [block.start_ms, block.end_ms, block.parts.length]), account });
    home.close();
  });

  it("the sitting pass's answer holding a fence inside a string, bare or fenced, is refused", () => {
    const summary = "Fixed ```py\nx = 1\n``` in a synthetic file.";
    const run = (wrap: (answer: string) => string) => {
      const dir = temp();
      const refusals: string[] = [];
      const home = new Harness(dir, { model: (ask, attempt) => {
        if (attempt > 1) refusals.push(ask.input.slice(ask.input.lastIndexOf("Why")));
        const good = goodModel(ask, attempt)!;
        return ask.prompt === SITTING_PROMPT ? wrap(JSON.stringify({ ...JSON.parse(good) as object, summary })) : good;
      } });
      const from = at("2026-10-10T08:00:00Z");
      busy(home, from, from + 90 * MIN, from + 100 * MIN);
      const account = home.enrichment(home.extracts()[0]!.unit)!.content as unknown as Account;
      home.close();
      return { refusals, summary: account.summary };
    };
    expect(run((answer) => answer)).toEqual({ refusals: [], summary });
    expect(run((answer) => `\`\`\`json\n${answer}\n\`\`\``)).toEqual({ refusals: [], summary });
  });

  it("a part's or compose's type leaves an object open or a member optional, or is not the shape its text shows; the sitting pass's is not text", () => {
    const type = SCREEN_PROMPTS[PART_PROMPT]!.type as Record<string, unknown>;
    expect(SCREEN_PROMPTS[COMPOSE_PROMPT]!.type).toEqual(type);
    expect(SCREEN_PROMPTS[SITTING_PROMPT]!.type).toBe("text");
    expect(Object.values(SCREEN_PROMPTS).map((prompt) => [prompt.version, prompt.keeps])).toEqual([[2, []], [2, []], [2, []]]);
    const loose: string[] = [];
    const walk = (node: Record<string, unknown>, path: string) => {
      if (Array.isArray(node.enum) && node.type === undefined) loose.push(`${path}: an enum with no type`);
      const properties = node.properties as Record<string, Record<string, unknown>> | undefined;
      if (properties !== undefined) {
        if (node.additionalProperties !== false) loose.push(`${path}: open`);
        if (JSON.stringify([...(node.required as string[])].sort()) !== JSON.stringify(Object.keys(properties).sort())) loose.push(`${path}: a member optional`);
        for (const [name, member] of Object.entries(properties)) walk(member, `${path}.${name}`);
      }
      if (node.items !== undefined) walk(node.items as Record<string, unknown>, `${path}[]`);
    };
    walk(type, "account");
    expect(loose).toEqual([]);
    const written = readFileSync(new URL("./prompts/parts/schema.json", import.meta.url), "utf8");
    for (const prompt of [PART_PROMPT, COMPOSE_PROMPT]) expect(SCREEN_PROMPTS[prompt]!.text).toContain(written.trim());
    const strict = (node: Record<string, unknown>): Record<string, unknown> => {
      const { pattern: _pattern, description: _description, ...out } = node;
      if (Array.isArray(node.enum) && node.type === undefined) out.type = "string";
      const properties = node.properties as Record<string, Record<string, unknown>> | undefined;
      if (properties !== undefined) {
        out.properties = Object.fromEntries(Object.entries(properties).map(([name, member]) => [name, strict(member)]));
        out.required = Object.keys(properties);
        out.additionalProperties = false;
      }
      if (node.items !== undefined) out.items = strict(node.items as Record<string, unknown>);
      return out;
    };
    expect(strict(type)).toEqual(strict(JSON.parse(written) as Record<string, unknown>));
    artifact(temp(), "type", type);
  });

  it("an answer naming the evidence only in present_why, followed by more text, holding braces in its strings, or timing an action as a range is refused; one naming the collection in what the person did is accepted", () => {
    const run = (change: (good: string) => string) => {
      const dir = temp();
      const refusals: string[] = [];
      const home = new Harness(dir, { model: (ask, attempt) => {
        if (attempt > 1) refusals.push(ask.input.slice(ask.input.lastIndexOf("Why")));
        const good = goodModel(ask, attempt)!;
        return attempt === 1 && ask.prompt === PART_PROMPT ? change(good) : good;
      } });
      const from = at("2026-10-06T08:00:00Z");
      busy(home, from, from + 20 * MIN, from + 30 * MIN);
      const account = home.enrichment(home.extracts()[0]!.unit)!.content as unknown as Account;
      home.close();
      return { refusals, account };
    };
    const edit = (good: string, apply: (answer: { timeline: Record<string, string>[]; actions: Record<string, string>[] }) => void) => {
      const answer = JSON.parse(good) as { timeline: Record<string, string>[]; actions: Record<string, string>[] };
      apply(answer);
      return JSON.stringify(answer);
    };
    const plain = run((good) => good);
    const cases = {
      why: run((good) => edit(good, (answer) => { answer.timeline[0]!.present_why = "the NO CAPTURE line says the person was at the Mac"; })),
      doing: run((good) => edit(good, (answer) => { answer.timeline[0]!.doing = "No capture; the person was at the Mac"; })),
      trailing: run((good) => `${good}\n\n{"note": "a second object"}\nand a closing remark`),
      braces: run((good) => `${edit(good, (answer) => { answer.timeline[0]!.doing = 'Edited {config} and a "quoted}" name'; })} trailing words`),
      range: run((good) => edit(good, (answer) => { answer.actions[0]!.at = `${answer.actions[0]!.at}–23:59:59`; })),
    };
    expect(plain.refusals).toEqual([]);
    expect(cases.why.refusals).toEqual([]);
    expect(cases.why.account.timeline[0]!.present_why).toBe("the NO CAPTURE line says the person was at the Mac");
    expect(cases.doing.refusals).toHaveLength(1);
    expect(cases.doing.refusals[0]).toMatch(/never how the evidence was collected/u);
    expect(cases.trailing.refusals).toEqual([]);
    expect(cases.trailing.account).toEqual(plain.account);
    expect(cases.braces.refusals).toEqual([]);
    expect(cases.braces.account.timeline[0]!.doing).toBe('Edited {config} and a "quoted}" name');
    expect(cases.range.refusals).toEqual([]);
    expect(cases.range.account.actions).toEqual(plain.account.actions);
    artifact(temp(), "reading-answers", Object.fromEntries(Object.entries(cases).map(([name, result]) => [name, result.refusals])));
  });

  it("the account names the recorder when the evidence never shows the word", () => {
    const named = (doing: string): Model => (ask, attempt) => {
      const good = JSON.parse(goodModel(ask, attempt)!) as { timeline: { doing: string }[] };
      if (attempt === 1) good.timeline[0]!.doing = doing;
      return JSON.stringify(good);
    };
    const run = (show: (t: number) => Shown) => {
      const dir = temp();
      const refusals: string[] = [];
      const model = named("Checked the recorder settings");
      const home = new Harness(dir, { model: (ask, attempt) => {
        if (attempt > 1) refusals.push(ask.input.slice(ask.input.lastIndexOf("Why:")));
        return model(ask, attempt);
      } });
      const from = at("2026-10-10T12:00:00Z");
      busy(home, from, from + 20 * MIN, from + 30 * MIN, show);
      const [row] = home.extracts();
      const account = home.enrichment(row!.unit)!.content as unknown as Account;
      home.close();
      artifact(dir, "recorder-word", { refusals, account });
      return { refusals, doing: account.timeline[0]!.doing };
    };
    const unseen = run(editor);
    expect(unseen.refusals).toHaveLength(1);
    expect(unseen.refusals[0]).toMatch(/never how the evidence was collected/u);
    expect(unseen.doing).toMatch(/^Worked in Editor/u);
    const seen = run(() => shown("Editor", "recorder settings"));
    expect(seen.refusals).toEqual([]);
    expect(seen.doing).toBe("Checked the recorder settings");
  });

  it("an ask's input moves from what the release before sent, byte for byte", () => {
    const sent: Record<string, string> = {};
    const texts: string[] = [];
    const run = (name: string, drive: (home: Harness) => void, options: { machineLog?: "machine-events" } = {}) => {
      const home = new Harness(temp(), { ...options, model: (ask, attempt) => {
        if (attempt === 1) sent[`${name} ${ask.item.slice(ask.item.indexOf("/") + 1)}`] = digest(ask.input);
        if (attempt === 1) texts.push(ask.input);
        return goodModel(ask, attempt);
      } });
      drive(home);
      expect(home.enrichment(home.extracts()[0]!.unit)?.state).toBe("done");
      home.close();
    };
    run("day-start", (home) => {
      const from = at("2026-10-07T07:40:00Z");
      busy(home, from, from + 45 * MIN, from + 60 * MIN, (t) => t < from + 20 * MIN ? editor(t) : browser());
    });
    run("parts", (home) => {
      const from = at("2026-10-09T09:00:00Z");
      busyMany(home, from, from + 50 * MIN, from + 60 * MIN);
    });
    run("blocks", (home) => {
      const from = at("2026-10-10T08:00:00Z");
      busy(home, from, from + 90 * MIN, from + 100 * MIN);
    });
    run("machine", (home) => {
      const from = at("2026-10-08T14:00:00Z");
      const end = from + 40 * MIN - 2 * S;
      home.land(MACHINE_LOG, from + 50 * MIN, [
        machineEvent(from + 5 * MIN, "mic_start", { app: "com.example.call", device: "BuiltInMicrophoneDevice" }),
        machineEvent(end + 30 * S, "lock"),
      ], from + 50 * MIN);
      const click = (t: number, el: JsonObject) => ({ t, e: "down", clicks: 1, app: 0, el });
      home.land(INPUT, from + 50 * MIN, [inputChunk(from + MIN, "Editor", "hello", { events: [
        click(1_000, { role: "AXButton", title: `${"a".repeat(79)}\u{1F3F4} tail` }),
        click(2_000, { role: "AXLink", url: "https://example.com/reset/8f3k2q9xw7v1/confirm?u=4417" }),
      ] })], from + 50 * MIN);
      const call = (t: number) => shown("Meet", `Meet – doc-${Math.floor(t / (30 * S)) % 7} 🔊`);
      busy(home, from, from + 25 * MIN, from + 50 * MIN, call, MIN);
      busy(home, from + 26 * MIN, from + 40 * MIN, from + 50 * MIN, (t) => t < from + 30 * MIN ? editor(t) : browser());
    }, { machineLog: "machine-events" });
    const path = new URL("./test/inputs.golden.json", import.meta.url).pathname;
    const text = `${JSON.stringify(sent, null, 2)}\n`;
    for (const words of ["A call window (“Meet – doc-", "Sound was playing just before this part.", "NO CAPTURE: ", '10:05:00 mic_start {"app"', "The JSON you returned for the previous part", "--- part 2 of ", "HOURS\n--- "]) {
      expect(texts.some((text) => text.includes(words)), words).toBe(true);
    }
    expect(text).toBe(readFileSync(path, "utf8"));
  });

  it("renderDay reads outside days()", () => {
    const dir = temp();
    const home = new Harness(dir);
    const from = at("2026-10-07T07:40:00Z");
    busy(home, from, from + 45 * MIN, from + 60 * MIN, (t) => t < from + 20 * MIN ? editor(t) : browser());
    const [row] = home.extracts();
    expect(row!.days).toEqual(["2026-10-06", "2026-10-07"]);
    expect(home.family.days(row!, SETTINGS)).toEqual(row!.days);
    const rendered = Object.fromEntries(["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"].map((day) => [day, home.render(day)]));
    for (const day of ["2026-10-06", "2026-10-07"]) expect(rendered[day]!.txt).toMatch(/Screen: Browser \d+ min, Editor \d+ min/u);
    for (const day of ["2026-10-05", "2026-10-08"]) expect(rendered[day]!.txt).not.toContain("Screen");
    for (const day of Object.values(rendered)) expect(checkDayFile(JSON.parse(day.json))).toEqual([]);
    const view = home.db.view();
    expect(() => renderDay("2026-10-08", [home.family], {
      extractsOn: () => [...view.extracts("screen")], enrichment: () => undefined, sources: () => view.sources(), since: (source, kinds) => view.since(source, kinds),
    }, SETTINGS, tableUnits(LABELS))).toThrow(DayReadError);
    view.close();
    const content = closedOf(row!);
    const golden = {
      extract: { unit: row!.unit, start_ms: row!.start_ms, end_ms: row!.end_ms, days: row!.days, closed: content.closed, apps: content.apps, blocks: content.blocks },
      account: home.enrichment(row!.unit)!.content,
      days: { "2026-10-06": rendered["2026-10-06"]!.txt, "2026-10-07": rendered["2026-10-07"]!.txt },
    };
    artifact(dir, "days", golden);
    const text = `${JSON.stringify(golden, null, 2)}\n`;
    const path = GOLDEN.pathname;
    if (UPDATE) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
    }
    expect(existsSync(path), `${path} is missing; run with LIFESTREAM_UPDATE_GOLDEN=1`).toBe(true);
    expect(text).toBe(readFileSync(path, "utf8"));
    pin(home.family, { screen: FED.screen }, home.extracts());
    home.close();
  });
});

describe("screen: a reader's frames", () => {
  const STRETCH = segmentsSpanning(30 * MIN);
  const from = at("2026-10-01T14:00:00Z");
  const mixed = (t: number) => (t - from) % (30 * S) === 0 ? shown("Editor", "notes.txt") : shown("Browser", "Example page");
  const landed = (minutes: number) => {
    const home = new Harness(temp());
    home.land(RECORDER, from + 20 * MIN, Array.from({ length: minutes }, (_, m) => recorderFrames(home.blobs, from + m * MIN, from + (m + 1) * MIN, 10 * S, mixed)).flat(), from + 20 * MIN);
    const decoded: string[] = [];
    const blobs: BlobReader = {
      has: (hash) => home.blobs.has(hash),
      bytes: (hash) => {
        decoded.push(hash);
        return home.blobs.bytes(hash);
      },
      text: (hash) => home.blobs.text(hash),
      prefix: (hash, bytes) => home.blobs.prefix(hash, bytes),
      materialise: (hash) => home.blobs.materialise(hash),
    };
    const view = home.db.view();
    const roles = new Roles(FED.screen);
    const done = () => {
      view.close();
      home.close();
    };
    return { home, view, roles, blobs, decoded, done };
  };

  it("decode each segment once across a reader's calls, read a frame's text once, and answer as the eager read does", () => {
    const { home, view, roles, blobs, decoded, done } = landed(10);
    const reader = new ScreenFrameReader(view, roles, blobs, SCREEN_CUTOVER_MS, STRETCH);
    const frames = reader.frames(MACHINE, from, from + 2 * MIN);
    expect(frames.map((frame) => frame.app)).toEqual(Array.from({ length: 12 }, (_, i) => i % 3 === 0 ? "Editor" : "Browser"));
    expect(decoded.length).toBe(2);
    expect(reader.frames(MACHINE, from + 30 * S, from + 90 * S)).toHaveLength(6);
    expect(decoded.length).toBe(2);
    const editor = frames.find((frame) => frame.app === "Editor")!;
    expect(editor.text()).toBe(editor.text());
    expect(editor.text()).toEqual({ lines: ["notes.txt: synthetic line one", "notes.txt: synthetic line two"], ocr: ["notes.txt: synthetic line one", "notes.txt: synthetic line two"] });
    expect(frames.map((frame) => ({ t: frame.t, app: frame.app, title: frame.title, site: frame.site, display: frame.display, read: frame.read, ...frame.text() })))
      .toEqual(screenFrames(view, roles, home.blobs, MACHINE, SCREEN_CUTOVER_MS, from, from + 2 * MIN));
    expect(decoded.length).toBe(2);
    done();
  });

  it("parse no frame's OCR or accessibility text while finding frames, and then only the text of the frames asked: a window's four Editor frames, never the eight Browser frames beside them", () => {
    const { view, roles, blobs, done } = landed(2);
    const reader = new ScreenFrameReader(view, roles, blobs, SCREEN_CUTOVER_MS, STRETCH);
    parsed.length = 0;
    const frames = reader.frames(MACHINE, from, from + 2 * MIN);
    expect(frames).toHaveLength(12);
    expect(parsed).toEqual([]);
    for (const frame of frames) if (frame.app === "Editor") frame.text();
    expect(parsed.filter((member) => member === "ocr")).toHaveLength(4);
    expect(parsed.filter((member) => member === "nodes")).toHaveLength(4);
    expect(parsed).toHaveLength(8);
    done();
  });

  it("hold every segment a 30-minute stretch spans: seven one-minute segments' frames found, then every frame's text read, decode seven times", () => {
    const { view, roles, blobs, decoded, done } = landed(7);
    expect(STRETCH).toBe(7);
    const reader = new ScreenFrameReader(view, roles, blobs, SCREEN_CUTOVER_MS, STRETCH);
    const frames = reader.frames(MACHINE, from, from + 7 * MIN);
    expect(frames).toHaveLength(42);
    expect(decoded.length).toBe(7);
    for (const frame of frames) frame.text();
    expect(decoded.length).toBe(7);
    done();
  });

  it("an eager walk holds one segment and reads each frame's text as it finds it: a second segment pushes out the first, and ten segments decode ten times", () => {
    const { view, roles, blobs, decoded, done } = landed(10);
    const walk = new ScreenFrameReader(view, roles, blobs, SCREEN_CUTOVER_MS, WALK_SEGMENTS);
    const frames = walk.frames(MACHINE, from, from + 2 * MIN);
    expect(decoded.length).toBe(2);
    frames[0]!.text();
    expect(decoded.length).toBe(3);
    decoded.length = 0;
    expect(screenFrames(view, roles, blobs, MACHINE, SCREEN_CUTOVER_MS, from, from + 10 * MIN)).toHaveLength(60);
    expect(decoded.length).toBe(10);
    expect(new Set(decoded).size).toBe(10);
    done();
  });
});
