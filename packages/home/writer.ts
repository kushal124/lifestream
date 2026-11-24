import { parentPort } from "node:worker_threads";
import { isSqliteError, openHandedFolder, trySharedLock, type DaySettings, type HandedFolder, type HomeFolder, type LevelName, type PlaceholderTable, type Wanted } from "@lifestreamprotocol/core";
import { callsLock, ledgerFileOf, openLedger, type Ledger, type NewOutbound, type TablePart } from "@lifestreamprotocol/model";
import { beginIn, endIn, personIn, writes, type CallBegin, type CallEnd, type PersonWriting } from "./access-ledger.js";
import { errorText } from "./job-error.js";
import { notNow, notNowRefusal, Refusal, RETRY_S, UNWRITABLE } from "./refusal.js";

export interface WriterInit {
  root: string;
  machine: string;
  handed: HandedFolder;
  quiet: string;
}

export type Writing =
  | { epoch: true }
  | { level: { scope: string; start: LevelName | null; pick?: LevelName } }
  | { person: PersonWriting }
  | { part: { scope: string; wanted: Wanted } }
  | { save: { read: TablePart; answered: PlaceholderTable; outbound?: NewOutbound; end?: CallEnd } }
  | { begin: CallBegin }
  | { end: CallEnd }
  | { outbound: NewOutbound }
  | { list: { from: string; to: string; receiver?: string; before?: number; day: DaySettings } }
  | { carried: { record: { source: string; kind: string; key: string }; day: DaySettings } }
  | { asked: { item: { family: string; item: string }; day: DaySettings } }
  | { row: { seq: number; day: DaySettings } };

export type ToWriter = { attach: WriterInit } | { detach: true } | { id: number; writing: Writing };
export type FromWriter = { id: number } & (
  | { value: unknown }
  | { refusal: { status: number; code: string; message: string; retryAfter?: number }; cause?: string }
  | { error: string }
);

const port = parentPort!;
let folder: HomeFolder | null = null;
let path = "";
let quiet = "";
let ledger: Ledger | null = null;

function opened(): Ledger {
  ledger ??= openLedger(folder!, { mode: "write" });
  return ledger;
}

function writing<T>(work: (ledger: Ledger) => T): T {
  const lock = trySharedLock(callsLock(path)) ?? notNow("busy", quiet);
  try {
    return work(opened());
  } finally {
    lock.release();
  }
}

function run(asked: Writing): unknown {
  if ("epoch" in asked) return opened().placeholders.epoch();
  if ("level" in asked) {
    const { scope, start, pick } = asked.level;
    const kept = opened().placeholders.keptLevel(scope);
    if (pick === undefined ? kept !== null || start === null : pick === kept) return kept;
    return writing((ledger) => ledger.placeholders.keepLevel(scope, pick ?? start!, pick === undefined));
  }
  if ("person" in asked) {
    return writes(asked.person) ? writing((ledger) => personIn(ledger, asked.person)) : personIn(opened(), asked.person);
  }
  if ("part" in asked) return opened().placeholders.part(asked.part.scope, asked.part.wanted);
  if ("save" in asked) {
    const { read, answered, outbound, end } = asked.save;
    return writing((ledger) => ledger.together(() => {
      const saved = ledger.placeholders.save(read, answered, outbound);
      if ("saved" in saved && end !== undefined) endIn(ledger, end);
      return saved;
    }));
  }
  if ("begin" in asked) return writing((ledger) => beginIn(ledger, asked.begin));
  if ("end" in asked) return writing((ledger) => endIn(ledger, asked.end));
  if ("outbound" in asked) return writing((ledger) => ledger.outbound.write(asked.outbound));
  if ("list" in asked) return opened().outbound.list(asked.list);
  if ("carried" in asked) return opened().outbound.carried(asked.carried.record, asked.carried.day);
  if ("asked" in asked) return opened().outbound.asked(asked.asked.item, asked.asked.day);
  return opened().outbound.row(asked.row.seq, asked.row.day) ?? null;
}

port.on("message", (message: ToWriter) => {
  if ("attach" in message) {
    try { ledger?.close(); } catch {}
    ledger = null;
    folder = openHandedFolder(message.attach.handed);
    path = ledgerFileOf(message.attach.root);
    quiet = message.attach.quiet;
    port.postMessage({ up: true });
    return;
  }
  if ("detach" in message) {
    try { ledger?.close(); } catch {}
    ledger = null;
    folder = null;
    path = "";
    quiet = "";
    port.postMessage({ detached: true });
    return;
  }
  const { id, writing: asked } = message;
  let answer: FromWriter;
  try {
    answer = { id, value: run(asked) };
  } catch (error) {
    let refusal: Refusal | null = error instanceof Refusal ? error : null;
    let cause: string | undefined;
    if (refusal === null && error instanceof RangeError) refusal = new Refusal(422, "BAD_REQUEST", error.message);
    if (refusal === null && (isSqliteError(error) || ledger === null || typeof (error as { code?: unknown }).code === "string")) {
      try { ledger?.close(); } catch {}
      ledger = null;
      refusal = notNowRefusal("busy", UNWRITABLE, RETRY_S);
      cause = errorText(error);
    }
    answer = refusal === null
      ? { id, error: errorText(error) }
      : { id, refusal: { status: refusal.status, code: refusal.code, message: refusal.words, ...(refusal.retryAfter === undefined ? {} : { retryAfter: refusal.retryAfter }) }, ...(cause === undefined ? {} : { cause }) };
  }
  port.postMessage(answer);
});
