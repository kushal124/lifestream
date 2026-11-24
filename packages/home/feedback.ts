import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { emptyTable, type Counts, type FileKind, type HomeFolder, type Json, type JsonObject, type Piece, type PlaceholderTable } from "@lifestreamprotocol/core";
import type { HideAnswer, Hider } from "@lifestreamprotocol/privacy";
import { failpoint } from "./failpoint.js";
import { answerText, appText, connectorText, titleOf, type AppFacts, type AskAnswer, type AskQuestion, type ConnectorFacts, type TextKind } from "./feedback-text.js";

export const FEEDBACK_URL: string | null = null;

export const FEEDBACK_KINDS = ["answer", "connector", "app", "screenshot"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export const TEXT_MAX = 5_000;
export const EMAIL_MAX = 254;
export const ATTACHMENT_BYTES = 64 * 1024;
export const SHOT_BYTES = 4 * 1024 ** 2;
export const BODY_BYTES = 5 * 1024 ** 2;
export const SHOT_SIDE = 2_880;
export const DRAFT_MS = 3_600_000;
export const DRAFTS = 32;
export const DRAFT_BOUND_MS = 2_000;
export const TRY_MS = 30_000;
export const FIRST_WAIT_MS = 60_000;
export const LAST_WAIT_MS = 6 * 3_600_000;
export const EXPIRE_MS = 30 * 24 * 3_600_000;
export const RECEIVER = "lifestream";
export const SENT_BY = { "x-lifestream-report": "1" } as const;

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHOT_HASH = /^sha256:[0-9a-f]{64}$/u;

export const REPORT_FILE: FileKind = { role: "feedback-report" };
export const SHOT_FILE: FileKind = { role: "feedback-screenshot" };

export type About = { kind: "menu" } | { kind: "chat"; chat: string; n: number } | { kind: "connector"; connector: string };

export interface RecordRef {
  source: string;
  kind: string;
  key: string;
}

export interface Attachment {
  kind: TextKind;
  title: string;
  text: string;
  counts: Counts;
}

export interface FeedbackDraft {
  attachments: Attachment[];
  email: string | null;
}

export interface Shot {
  hash: string;
  width: number;
  height: number;
}

export interface Said {
  text: string;
  email: string | null;
  keep: readonly FeedbackKind[];
}

export type ReportState = "queued" | "sent" | "refused" | "expired";

export interface Report {
  id: string;
  at_ms: number;
  by: string;
  device: AppFacts["device"];
  about: About;
  refs: RecordRef[];
  text: string;
  email: string | null;
  attachments: Attachment[];
  screenshot: Shot | null;
  state: ReportState;
  tries: number;
  next_ms: number | null;
  sent_ms: number | null;
  why: string | null;
  sent_before_erasure: boolean;
}

export interface DeviceSaid {
  kind: "mac" | "phone" | null;
  version: string | null;
}

const UNSAID: DeviceSaid = { kind: null, version: null };

export interface ChatTurn {
  refs: RecordRef[];
  question: AskQuestion | null;
  answer: AskAnswer;
}

export interface FeedbackOutbound {
  at_ms: number;
  receiver: typeof RECEIVER;
  route: null;
  by: string;
  what: "feedback";
  tool: null;
  level: "all";
  counts: Counts;
  chars: number;
  pictures: number;
  key: string;
  attempt: null;
  refs: RecordRef[];
}

export interface FeedbackInputs {
  folder: HomeFolder;
  hider: Hider;
  records: { turn(chat: string, n: number): ChatTurn | null | Promise<ChatTurn | null> };
  health: { connector(id: string): ConnectorFacts | null | Promise<ConnectorFacts | null> };
  devices: { app(by: string, said: DeviceSaid): AppFacts | Promise<AppFacts> };
  ledger: { once(row: FeedbackOutbound): void };
  stage: FeedbackStage;
  erasing: () => boolean;
  url: string | null;
  fetch: typeof fetch;
  clock: () => number;
  log: (line: JsonObject) => void;
}

export interface FeedbackStage {
  staged(hash: string): { bytes(): Buffer } | undefined;
  drop(hash: string): void;
}

export type SendAnswer = { id: string } | { gone: string } | { refused: string };

export interface Feedback {
  readonly open: boolean;
  draft(id: string, about: About, by: string, said?: DeviceSaid): Promise<FeedbackDraft | { refused: string }>;
  held(id: string): boolean;
  screenshot(id: string, shot: Shot): boolean;
  send(id: string, said: Said, by: string): SendAnswer;
  due(now: number): Promise<void>;
  forget(refs: readonly RecordRef[]): Promise<void>;
  report(id: string): Report | undefined;
  idle(): Promise<void>;
}

interface Draft {
  id: string;
  used_ms: number;
  by: string;
  device: AppFacts["device"];
  about: About;
  attachments: Attachment[];
  screenshot: Shot | null;
  refs: RecordRef[];
}

type Placed = Extract<HideAnswer, { texts: unknown }>["spans"][number][number];

export const characters = (text: string): number => [...text].length;

export function saidRefusal(said: Said): string | null {
  if (!/\S/u.test(said.text)) return "the text is empty";
  if (characters(said.text) > TEXT_MAX) return `the text is at most ${TEXT_MAX} characters`;
  if (said.email !== null && (characters(said.email) > EMAIL_MAX || said.email.split("@").length !== 2)) return `the email is at most ${EMAIL_MAX} characters, with one @`;
  if (said.keep.some((kind) => !(FEEDBACK_KINDS as readonly string[]).includes(kind))) return `keep names only ${FEEDBACK_KINDS.join(", ")}`;
  return null;
}

const CHAT_ID = /^[A-Za-z0-9-]{1,64}$/u;
const CONNECTOR_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export function aboutOf(value: unknown): About | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const said = value as Record<string, unknown>;
  const only = (...keys: string[]) => Object.keys(said).every((key) => keys.includes(key));
  if (said.kind === "menu" && only("kind")) return { kind: "menu" };
  if (said.kind === "chat" && only("kind", "chat", "n") && typeof said.chat === "string" && CHAT_ID.test(said.chat) && Number.isSafeInteger(said.n) && (said.n as number) > 0) {
    return { kind: "chat", chat: said.chat, n: said.n as number };
  }
  if (said.kind === "connector" && only("kind", "connector") && typeof said.connector === "string" && CONNECTOR_ID.test(said.connector)) return { kind: "connector", connector: said.connector };
  return null;
}

export function isShot(head: Buffer): boolean {
  return head.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) || (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff);
}

export function shotSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    if (bytes.length < 24 || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
    const size = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    return size.width > 0 && size.height > 0 ? size : null;
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  for (let at = 2; at + 4 <= bytes.length;) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    if (JPEG_FRAMES.has(marker)) {
      if (at + 9 > bytes.length) return null;
      const size = { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
      return size.width > 0 && size.height > 0 ? size : null;
    }
    at += 2 + bytes.readUInt16BE(at + 2);
  }
  return null;
}

export function waitAfter(tries: number): number {
  return Math.min(FIRST_WAIT_MS * 2 ** Math.max(0, tries - 1), LAST_WAIT_MS);
}

export function retryAfterMs(header: string | null, now: number): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (/^\d+$/u.test(trimmed)) return Number(trimmed) * 1_000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

function countsOf(spans: readonly Placed[], table: PlaceholderTable): Counts {
  const types = new Map(table.entries.map((entry) => [entry.placeholder, entry.type]));
  const counts: Counts = {};
  for (const placeholder of new Set(spans.map((span) => span.placeholder))) {
    const type = types.get(placeholder);
    if (type !== undefined) counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

function inHidden(spans: readonly Placed[]): Placed[] {
  let shift = 0;
  return [...spans].sort((a, b) => a.start - b.start).map((span) => {
    const start = span.start + shift;
    shift += span.placeholder.length - (span.end - span.start);
    return { start, end: start + span.placeholder.length, placeholder: span.placeholder };
  });
}

export function fittingEnd(text: string, spans: readonly Pick<Placed, "start" | "end">[], most: number): number {
  if (Buffer.byteLength(text) <= most) return text.length;
  let bytes = 0;
  let end = 0;
  for (const each of text) {
    bytes += Buffer.byteLength(each);
    if (bytes > most) break;
    end += each.length;
  }
  return spans.find((span) => span.start < end && span.end > end)?.start ?? end;
}

function summed(attachments: readonly Attachment[]): Counts {
  const counts: Counts = {};
  for (const attachment of attachments) for (const [type, n] of Object.entries(attachment.counts) as [keyof Counts, number][]) counts[type] = (counts[type] ?? 0) + n;
  return counts;
}

function sameRef(a: RecordRef, b: RecordRef): boolean {
  return a.source === b.source && a.kind === b.kind && a.key === b.key;
}

function errorOf(body: string, status: number): string {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    value = null;
  }
  return typeof value === "object" && value !== null && "error" in value && typeof value.error === "string" ? value.error : `HTTP ${status}`;
}

export function multipart(report: Report, shot: Buffer | null, boundary: string): Buffer {
  const parts: Buffer[] = [];
  const part = (headers: string, body: Buffer) => parts.push(Buffer.from(`--${boundary}\r\n${headers}\r\n\r\n`), body, Buffer.from("\r\n"));
  const said = { v: 1, id: report.id, text: report.text, email: report.email, about: report.about.kind, device: report.device };
  part('Content-Disposition: form-data; name="report"\r\nContent-Type: application/json', Buffer.from(JSON.stringify(said)));
  for (const attachment of report.attachments) part(`Content-Disposition: form-data; name="${attachment.kind}"\r\nContent-Type: text/plain; charset=utf-8`, Buffer.from(attachment.text));
  if (shot !== null) {
    const png = shot.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
    part(`Content-Disposition: form-data; name="screenshot"; filename="screenshot.${png ? "png" : "jpg"}"\r\nContent-Type: ${png ? "image/png" : "image/jpeg"}`, shot);
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

const reportsAt = (folder: HomeFolder): string => join(folder.root, "feedback");
const reportFile = (folder: HomeFolder, id: string) => folder.file(REPORT_FILE, join(reportsAt(folder), id, "report.json"));
const shotFileOf = (folder: HomeFolder, id: string) => folder.file(SHOT_FILE, join(reportsAt(folder), id, "screenshot.jpg"));

export function readReport(folder: HomeFolder, id: string): Report | undefined {
  const bytes = reportFile(folder, id).read();
  return bytes === undefined ? undefined : JSON.parse(bytes.toString("utf8")) as Report;
}

function writeReport(folder: HomeFolder, report: Report): void {
  reportFile(folder, report.id).write(Buffer.from(JSON.stringify(report)));
}

function readReports(folder: HomeFolder, log: (line: JsonObject) => void): Map<string, Report> {
  const reports = new Map<string, Report>();
  for (const id of folder.names(reportsAt(folder))) {
    if (!UUID_V4.test(id)) continue;
    try {
      const report = readReport(folder, id);
      if (report !== undefined) reports.set(id, report);
    } catch (error) {
      log({ feedback: "unread", id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return reports;
}

interface Answered {
  attachments: Attachment[];
  refs: RecordRef[];
  screenshot: Shot | null;
}

function names(held: Answered, refs: readonly RecordRef[]): boolean {
  return held.refs.some((each) => refs.some((ref) => sameRef(each, ref)));
}

function withoutAnswer(held: Answered, drop: (hash: string) => void): void {
  held.attachments = held.attachments.filter((attachment) => attachment.kind !== "answer");
  held.refs = [];
  if (held.screenshot !== null) drop(held.screenshot.hash);
  held.screenshot = null;
}

function reportForgotten(folder: HomeFolder, stage: Pick<FeedbackStage, "drop">, report: Report, refs: readonly RecordRef[]): boolean {
  if (!names(report, refs)) return false;
  if (report.state === "sent") report.sent_before_erasure = true;
  withoutAnswer(report, (hash) => {
    shotFileOf(folder, report.id).remove();
    stage.drop(hash);
  });
  return true;
}

export function reportsOnDisk(folder: HomeFolder, stage: Pick<FeedbackStage, "drop">, log: (line: JsonObject) => void): Pick<Feedback, "forget"> {
  return {
    async forget(refs) {
      for (const report of readReports(folder, log).values()) if (reportForgotten(folder, stage, report, refs)) writeReport(folder, report);
    },
  };
}

export const REPORT_KEY = "feedback:";

export function reportOfRow(folder: HomeFolder, key: string | null): Report | undefined {
  if (key === null || !key.startsWith(REPORT_KEY)) return undefined;
  const id = key.slice(REPORT_KEY.length);
  return UUID_V4.test(id) ? readReport(folder, id) : undefined;
}

export function sentOf(report: Report): { body: string; pictures: Json[] } {
  const said = { text: report.text, email: report.email, attachments: report.attachments.map(({ kind, title, text }) => ({ kind, title, text })) };
  return { body: JSON.stringify(said), pictures: report.screenshot === null ? [] : [{ hash: report.screenshot.hash, width: report.screenshot.width, height: report.screenshot.height }] };
}

export function openFeedback(inputs: FeedbackInputs): Feedback {
  const { folder, hider, clock, log } = inputs;
  const shotFile = (id: string) => shotFileOf(folder, id);
  const drafts = new Map<string, Draft>();
  const making = new Map<string, Promise<Draft>>();
  const forgottenWhileMaking = new Map<string, RecordRef[]>();
  const reports = readReports(folder, log);
  const trying = new Map<string, Promise<void>>();

  const keep = (report: Report) => {
    writeReport(folder, report);
    reports.set(report.id, report);
  };

  const prune = (now: number) => {
    for (const [id, draft] of drafts) if (now - draft.used_ms >= DRAFT_MS) drafts.delete(id);
    for (const id of drafts.keys()) {
      if (drafts.size <= DRAFTS) break;
      drafts.delete(id);
    }
  };

  const held = (id: string): Draft | undefined => {
    const now = clock();
    prune(now);
    const draft = drafts.get(id);
    if (draft === undefined) return undefined;
    drafts.delete(id);
    draft.used_ms = now;
    drafts.set(id, draft);
    return draft;
  };

  const newestEmail = (): string | null => {
    let newest: Report | undefined;
    for (const report of reports.values()) if (newest === undefined || report.at_ms > newest.at_ms) newest = report;
    return newest?.email ?? null;
  };

  const outboundOf = (report: Report): FeedbackOutbound => ({
    at_ms: report.at_ms, receiver: RECEIVER, route: null, by: report.by, what: "feedback", tool: null, level: "all", counts: summed(report.attachments),
    chars: characters(report.text) + characters(report.email ?? "") + report.attachments.reduce((sum, attachment) => sum + characters(attachment.text), 0),
    pictures: report.screenshot === null ? 0 : 1, key: `${REPORT_KEY}${report.id}`, attempt: null, refs: report.refs,
  });

  async function make(id: string, about: About, by: string, said: DeviceSaid): Promise<Draft> {
    const forgotten: RecordRef[] = [];
    forgottenWhileMaking.set(id, forgotten);
    try {
      const draft = await assembled(id, about, by, said);
      if (names(draft, forgotten)) withoutAnswer(draft, inputs.stage.drop);
      drafts.set(id, draft);
      prune(clock());
      return draft;
    } finally {
      forgottenWhileMaking.delete(id);
    }
  }

  async function assembled(id: string, about: About, by: string, said: DeviceSaid): Promise<Draft> {
    const made: { kind: TextKind; title: string; pieces: Piece[] }[] = [];
    let refs: RecordRef[] = [];
    if (about.kind === "chat") {
      const turn = await inputs.records.turn(about.chat, about.n);
      if (turn !== null) {
        made.push({ kind: "answer", title: titleOf("answer"), pieces: answerText(turn.question, turn.answer) });
        refs = turn.refs;
      }
    }
    if (about.kind === "connector") {
      const facts = await inputs.health.connector(about.connector);
      if (facts !== null) made.push({ kind: "connector", title: titleOf("connector", facts.name), pieces: connectorText(facts) });
    }
    const app = await inputs.devices.app(by, said);
    made.push({ kind: "app", title: titleOf("app"), pieces: appText(app) });
    let hidden: HideAnswer;
    try {
      hidden = await hider.hide(made.map((each) => each.pieces), "all", emptyTable(`feedback:${id}`), DRAFT_BOUND_MS);
    } catch (error) {
      hidden = { wait: error instanceof Error ? error.message : String(error) };
    }
    if ("wait" in hidden) log({ feedback: "draft-bare", id, wait: hidden.wait });
    const attachments = "wait" in hidden ? [] : made.flatMap((each, index): Attachment[] => {
      const text = hidden.texts[index];
      if (typeof text !== "string") return [];
      const spans = inHidden(hidden.spans[index] ?? []);
      const end = fittingEnd(text, spans, ATTACHMENT_BYTES);
      return [{ kind: each.kind, title: each.title, text: text.slice(0, end), counts: countsOf(spans.filter((span) => span.end <= end), hidden.table) }];
    });
    return { id, used_ms: clock(), by, device: app.device, about, attachments, screenshot: null, refs: attachments.some((each) => each.kind === "answer") ? refs : [] };
  }

  async function attempt(id: string): Promise<void> {
    const url = inputs.url;
    const before = reports.get(id);
    if (url === null || before === undefined || before.state !== "queued") return;
    inputs.ledger.once(outboundOf(before));
    const boundary = `lifestream-${randomBytes(12).toString("hex")}`;
    const body = multipart(before, before.screenshot === null ? null : shotFile(id).read() ?? null, boundary);
    let status: number | null = null;
    let retryAfter: string | null = null;
    let answered = "";
    try {
      const response = await inputs.fetch(url, {
        method: "POST",
        headers: { ...SENT_BY, "content-type": `multipart/form-data; boundary=${boundary}` },
        body,
        signal: AbortSignal.timeout(TRY_MS),
      });
      status = response.status;
      retryAfter = response.headers.get("retry-after");
      answered = await response.text();
    } catch (error) {
      log({ feedback: "unreached", id, error: error instanceof Error ? error.message : String(error) });
    }
    const now = clock();
    const report = reports.get(id);
    if (report === undefined || report.state !== "queued") return;
    report.tries += 1;
    if (status !== null && status >= 200 && status < 300) {
      failpoint("feedback-filed");
      Object.assign(report, { state: "sent", sent_ms: now, next_ms: null, why: null });
    } else if (status === null || status === 429 || status >= 500) {
      const asked = retryAfterMs(retryAfter, now);
      report.next_ms = now + Math.min(asked ?? waitAfter(report.tries), LAST_WAIT_MS);
    } else {
      Object.assign(report, { state: "refused", next_ms: null, why: errorOf(answered, status) });
    }
    keep(report);
    log({ feedback: report.state, id, tries: report.tries, ...(status === null ? {} : { status }) });
  }

  function start(id: string): Promise<void> {
    const running = trying.get(id);
    if (running !== undefined) return running;
    const run = attempt(id)
      .catch((error: unknown) => log({ feedback: "try-failed", id, error: error instanceof Error ? error.message : String(error) }))
      .finally(() => trying.delete(id));
    trying.set(id, run);
    return run;
  }

  return {
    get open() {
      return inputs.url !== null;
    },

    async draft(id, about, by, said = UNSAID) {
      if (!UUID_V4.test(id)) return { refused: "the id is a UUID v4" };
      const answer = (draft: Draft): FeedbackDraft => ({ attachments: draft.attachments, email: newestEmail() });
      const kept = held(id);
      if (kept !== undefined) return answer(kept);
      let pending = making.get(id);
      if (pending === undefined) {
        pending = make(id, about, by, said).finally(() => making.delete(id));
        making.set(id, pending);
      }
      return answer(await pending);
    },

    held(id) {
      return held(id) !== undefined || making.has(id);
    },

    screenshot(id, shot) {
      if (!SHOT_HASH.test(shot.hash)) return false;
      const draft = held(id);
      if (draft === undefined) return false;
      draft.screenshot = { hash: shot.hash, width: shot.width, height: shot.height };
      return true;
    },

    send(id, said, by) {
      if (!UUID_V4.test(id)) return { refused: "the id is a UUID v4" };
      if (reports.has(id)) return { id };
      const draft = held(id);
      if (draft === undefined) return { gone: "no draft is held under this id: draft again" };
      const wrong = saidRefusal(said);
      if (wrong !== null) return { refused: wrong };
      for (const kind of said.keep) {
        const holds = kind === "screenshot" ? draft.screenshot !== null : draft.attachments.some((attachment) => attachment.kind === kind);
        if (!holds) return { refused: `the draft holds no ${kind}` };
      }
      let shot: Shot | null = null;
      if (said.keep.includes("screenshot")) {
        const bytes = inputs.stage.staged(draft.screenshot!.hash)?.bytes();
        if (bytes === undefined) return { refused: "the screenshot is no longer held: add it again" };
        shotFile(id).write(bytes);
        shot = draft.screenshot;
      }
      const at_ms = clock();
      const report: Report = {
        id, at_ms, by, device: draft.device, about: draft.about, refs: draft.refs, text: said.text, email: said.email,
        attachments: draft.attachments.filter((attachment) => said.keep.includes(attachment.kind)), screenshot: shot,
        state: "queued", tries: 0, next_ms: at_ms, sent_ms: null, why: null, sent_before_erasure: false,
      };
      if (!report.attachments.some((attachment) => attachment.kind === "answer")) report.refs = [];
      keep(report);
      failpoint("feedback-kept");
      inputs.ledger.once(outboundOf(report));
      drafts.delete(id);
      if (!inputs.erasing()) void start(id);
      return { id };
    },

    async due(now) {
      const ready: string[] = [];
      for (const report of reports.values()) {
        if (report.state !== "queued") continue;
        if (now - report.at_ms >= EXPIRE_MS) {
          if (trying.has(report.id)) continue;
          Object.assign(report, { state: "expired", next_ms: null });
          keep(report);
          continue;
        }
        if (inputs.url !== null && (report.next_ms ?? 0) <= now && !trying.has(report.id)) ready.push(report.id);
      }
      if (ready.length === 0 || inputs.erasing()) return;
      await Promise.all(ready.map(start));
    },

    async forget(refs) {
      for (const draft of drafts.values()) if (names(draft, refs)) withoutAnswer(draft, inputs.stage.drop);
      for (const forgotten of forgottenWhileMaking.values()) forgotten.push(...refs);
      for (const id of [...reports.keys()]) {
        if (!names(reports.get(id)!, refs)) continue;
        for (let running = trying.get(id); running !== undefined; running = trying.get(id)) await running;
        const report = reports.get(id)!;
        if (reportForgotten(folder, inputs.stage, report, refs)) keep(report);
      }
    },

    report(id) {
      return reports.get(id);
    },

    async idle() {
      while (trying.size > 0) await Promise.all([...trying.values()]);
    },
  };
}
