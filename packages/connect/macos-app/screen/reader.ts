import { basicInstant, deliveredLines, each, instantOf, isObject, lineText, parseLine, refuse, span, unitOf, type Guard, type Instant, type Json, type JsonObject, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";
import { Ranks } from "../../shared/lanes.js";
import { memberValueSpan, readTextSegment, splicedSha256, type TextSegment } from "./text.js";

export const FRAME = "frame";
export const GAP = "recorder";
export const OBSERVATIONS_FILE = "observations.jsonl";
export const TEXT_MEDIA_TYPE = "application/vnd.lifestreamprotocol.screen-text";
export const TEXT_ROLE = "screen-recorder-text";

const FRAME_STATUSES = ["captured", "activity_only"];
const GAP_STATUSES = ["gap", "excluded"];
const OBSERVATION_REQUIRED = ["capturedAt", "displayID", "width", "height", "windows", "ocr", "status", "ocrStatus"];
const OBSERVATION_OPTIONAL = [
  "application", "reason", "capturedUntil", "displayBounds", "displaySelection", "inputIdleSeconds",
  "acquisition", "ocrScope", "scaling", "site", "pageCause", "pageStale", "timings", "frontWindow",
];
const REDUCED_REQUIRED = OBSERVATION_REQUIRED.filter((member) => member !== "ocr" && member !== "windows");
const AX_REQUIRED = ["capturedAt", "status", "nodes"];
const AX_OPTIONAL = [
  "capturedUntil", "targetWindowID", "targetWindowBounds", "windowCorrelation", "limitReasons",
  "visitedElements", "candidateWindowBounds", "candidateWindowCount", "scopedMatchingWindowCount",
];
const FOLDER = /^\d{4}-\d{2}-\d{2}\/(\d{20})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SEGMENT_NAME = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\.lstext$/u;
const BASE64_SHA256 = /^[A-Za-z0-9+/]{43}=$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const NUMBER_TOKEN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;
const HOUR_US = 3_600_000_000;

export function digestHex(spelling: unknown): string | null {
  if (typeof spelling !== "string" || !BASE64_SHA256.test(spelling)) return null;
  const digest = Buffer.from(spelling, "base64");
  return digest.length === 32 && digest.toString("base64") === spelling ? digest.toString("hex") : null;
}

export function recorderFrameBlobs(content: Json): string[] {
  if (!isObject(content)) return [];
  const blobs: string[] = [];
  const image = isObject(content.image) ? content.image : undefined;
  const archive = isObject(image?.archive) ? digestHex(image.archive.segmentSHA256) : null;
  const pending = isObject(image?.pending) ? image.pending.sha256 : undefined;
  if (archive !== null) blobs.push(`sha256:${archive}`);
  else if (typeof pending === "string" && SHA256.test(pending)) blobs.push(`sha256:${pending}`);
  const text = isObject(content.text) ? digestHex(content.text.segmentSHA256) : null;
  if (text !== null) blobs.push(`sha256:${text}`);
  return blobs;
}

const frameGuard: Guard = (content) => {
  if (!isObject(content)) return ["content must be an object"];
  const packed = content.text !== undefined;
  const problems = members(content, ["type", ...(packed ? REDUCED_REQUIRED : OBSERVATION_REQUIRED)],
    [...OBSERVATION_OPTIONAL, "accessibility", "image", ...(packed ? ["text", "blobs"] : [])]);
  if (content.type !== "screen.lifestream.frame") problems.push("type must be screen.lifestream.frame");
  problems.push(...observationProblems(content, FRAME_STATUSES, packed));
  if (content.accessibility !== undefined) problems.push(...accessibilityProblems(content.accessibility, packed));
  problems.push(...imageProblems(content.image));
  if (packed) {
    if (content.status !== "captured") problems.push("only a captured frame has a text reference");
    const text = content.text;
    const problem = textProblem(text);
    if (problem !== null) problems.push(problem);
    else {
      const reference = text as JsonObject;
      const blobs = content.blobs;
      const expected = { hash: `sha256:${digestHex(reference.segmentSHA256)}`, type: TEXT_MEDIA_TYPE, bytes: reference.segmentBytes ?? null, role: TEXT_ROLE };
      if (!Array.isArray(blobs) || blobs.length !== 1 || JSON.stringify(sorted(blobs[0]!)) !== JSON.stringify(sorted(expected))) {
        problems.push("blobs must list the one text segment by its hash, type, bytes and role");
      }
    }
  }
  return problems;
};

const gapGuard: Guard = (content) => {
  if (!isObject(content)) return ["content must be an object"];
  const problems = members(content, ["type", ...OBSERVATION_REQUIRED], [...OBSERVATION_OPTIONAL, "run"]);
  if (content.type !== "screen.lifestream.gap") problems.push("type must be screen.lifestream.gap");
  problems.push(...observationProblems(content, GAP_STATUSES, false));
  if (content.run !== undefined) {
    const problem = runProblem(content.run, content);
    if (problem !== null) problems.push(problem);
  }
  return problems;
};

export const screenRecorder: Reader = {
  name: "screen-recorder",
  kinds: { [FRAME]: frameGuard, [GAP]: gapGuard },
  async *read(delivery, files) {
    const file = delivery.files.find((entry) => entry.path === OBSERVATIONS_FILE);
    if (file === undefined) refuse(`the delivery carries no ${OBSERVATIONS_FILE}`);
    const device = unitOf(delivery.source);
    const ranks = { [FRAME]: new Ranks(), [GAP]: new Ranks() };
    let previous = "";
    let current: { hash: string; size: number; segment: TextSegment } | undefined;
    yield* each(deliveredLines(files, file), (part) => part.where, function* ({ bytes, line, where: lineAt }) {
      const text = lineText(bytes, lineAt);
      const where = `${OBSERVATIONS_FILE}:line ${line}`;
      const value = parseLine(text, where);
      const observation = value.observation;
      if (!isObject(observation)) refuse(`${where} states no observation`);
      const gap = typeof observation.status === "string" && GAP_STATUSES.includes(observation.status);
      const at = observation.capturedAt;
      if (typeof at !== "number" || !(at > 0)) refuse(`${where} capturedAt must be epoch milliseconds`);
      const start = unixMs(at, `${where} capturedAt`);
      const kind = gap ? GAP : FRAME;
      const key = ranks[kind].key(basicInstant(start.start_ms));
      const shape = gap ? ["bundle", "observation", "run"] : ["bundle", "observation", "archive", "pending", "text"];
      if (Object.keys(value).sort().join() !== [...shape].sort().join()) refuse(`${where} members of a ${gap ? "gap" : "frame"} line must be ${shape.join(", ")}`);
      const bundle = value.bundle;
      if (typeof bundle !== "string" || !FOLDER.test(bundle)) refuse(`${where} bundle must be a capture folder <day>/<bundle>`);
      if (bundle <= previous) refuse(`${where} bundle ${bundle} does not follow ${previous}`);
      const row: ReaderOutput = { kind, key, content: null, device, locator: bundle };
      if (gap) {
        const run = value.run ?? null;
        if (run !== null) checkFirstAttempt(run, bundle, observation, where);
        row.content = { type: "screen.lifestream.gap", ...observation, ...(run === null ? {} : { run }) };
        row.time = lasting(start, lastEnd(run, observation), where);
        previous = bundle;
        yield row;
        return;
      }
      const { imageFile: _spoolPath, ...rest } = observation;
      let image: JsonObject | undefined;
      if (value.archive !== null) {
        const reference = isObject(value.archive) ? value.archive.reference : undefined;
        if (!isObject(reference)) refuse(`${where} archive must be null or a sidecar with a reference`);
        image = { archive: reference };
      } else if (value.pending !== null) {
        image = { pending: value.pending ?? null };
      }
      let packed: JsonObject = {};
      if (value.text !== null) {
        const reference = value.text;
        const problem = textProblem(reference);
        if (problem !== null) refuse(`${where} ${problem}`);
        const ref = reference as JsonObject;
        const hash = `sha256:${digestHex(ref.segmentSHA256)}`;
        packed = { text: ref, blobs: [{ hash, type: TEXT_MEDIA_TYPE, bytes: ref.segmentBytes ?? null, role: TEXT_ROLE }] };
        if (files.has(hash)) {
          if (current?.hash !== hash) {
            const bytes = files.bytes(hash);
            current = { hash, size: bytes.length, segment: readTextSegment(bytes, `text segment ${hash}`) };
          }
          prove(Buffer.from(text, "utf8"), ref, bundle, current, where);
        }
      }
      row.content = { type: "screen.lifestream.frame", ...rest, ...(image === undefined ? {} : { image }), ...packed };
      row.time = lasting(start, typeof observation.capturedUntil === "number" ? observation.capturedUntil : undefined, where);
      const blobs = recorderFrameBlobs(row.content);
      if (blobs.length > 0) row.blobs = blobs;
      if (packed.blobs !== undefined) row.media = { [(packed.blobs as { hash: string }[])[0]!.hash]: TEXT_MEDIA_TYPE };
      previous = bundle;
      yield row;
    });
  },
};

function prove(line: Buffer, ref: JsonObject, bundle: string, current: { hash: string; size: number; segment: TextSegment }, where: string): void {
  if (current.size !== ref.segmentBytes) refuse(`${where} text segment ${current.hash} holds ${current.size} bytes, not the segmentBytes the reference states`);
  const ordinal = ref.ordinal as number;
  const frame = current.segment.frames[ordinal];
  if (frame === undefined) refuse(`${where} text segment ${current.hash} holds no frame at ordinal ${ordinal}`);
  if (frame.bundle !== bundle) refuse(`${where} text segment ${current.hash} names ${frame.bundle} at ordinal ${ordinal}, not this bundle`);
  if (frame.observationSHA256 !== ref.observationSHA256) refuse(`${where} text segment ${current.hash} states another observationSHA256 at ordinal ${ordinal}`);
  const [start, end] = memberValueSpan(line, "observation", where);
  if (splicedSha256(line.subarray(start, end), current.segment, ordinal) !== ref.observationSHA256) {
    refuse(`${where} spliced with text segment ${current.hash} is not the observation the recorder wrote`);
  }
}

function checkFirstAttempt(run: Json, bundle: string, observation: JsonObject, where: string): void {
  const problem = runProblem(run, observation);
  if (problem !== null) refuse(`${where} ${problem}`);
  const [first] = (run as { attempts: Json[][] }).attempts[0]!;
  if (first !== bundle) refuse(`${where} run.attempts[0] must be this gap's bundle`);
}

function lastEnd(run: Json, observation: JsonObject): string | number | undefined {
  if (isObject(run) && Array.isArray(run.attempts)) {
    const last = run.attempts[run.attempts.length - 1] as Json[];
    return (last[2] ?? last[1]) as string;
  }
  return typeof observation.capturedUntil === "number" ? observation.capturedUntil : undefined;
}

function lasting(start: Instant, end: string | number | undefined, where: string): Instant {
  if (end === undefined) return start;
  const until = unixMs(end, `${where} end`);
  return until.start_ms > start.start_ms ? span(start, until) : start;
}

function unixMs(value: string | number, where: string): Instant {
  return instantOf(value, "unix-ms", where);
}

function members(value: JsonObject, required: string[], optional: string[]): string[] {
  const problems: string[] = [];
  for (const member of required) if (!(member in value)) problems.push(`${member} is missing`);
  for (const member of Object.keys(value)) if (!required.includes(member) && !optional.includes(member)) problems.push(`${member} is not admitted`);
  return problems;
}

function observationProblems(body: JsonObject, statuses: string[], packed: boolean): string[] {
  const problems: string[] = [];
  if (!epochMs(body.capturedAt)) problems.push("capturedAt must be epoch milliseconds");
  if (body.capturedUntil !== undefined && !epochMs(body.capturedUntil)) problems.push("capturedUntil must be epoch milliseconds");
  if (typeof body.status !== "string" || !statuses.includes(body.status)) problems.push(`status ${JSON.stringify(body.status ?? null)} is not ${statuses.join(" or ")}`);
  if (typeof body.ocrStatus !== "string") problems.push("ocrStatus must be a string");
  if (packed) {
    if (body.windows !== undefined || body.ocr !== undefined) problems.push("a frame with a text reference states no windows and no ocr");
  } else {
    if (!Array.isArray(body.windows)) problems.push("windows must be an array");
    if (!Array.isArray(body.ocr)) problems.push("ocr must be an array");
  }
  for (const member of ["reason", "site", "pageCause"]) if (body[member] !== undefined && typeof body[member] !== "string") problems.push(`${member} must be a string`);
  for (const member of ["application", "displayBounds", "displaySelection", "acquisition", "ocrScope", "scaling", "pageStale", "timings"]) {
    if (body[member] !== undefined && !isObject(body[member])) problems.push(`${member} must be an object`);
  }
  const front = body.frontWindow;
  if (front !== undefined && !(isObject(front) && ((Object.keys(front).join() === "windowID" && whole(front.windowID)) ||
    (Object.keys(front).join() === "cause" && typeof front.cause === "string")))) {
    problems.push("frontWindow must be { windowID } with a whole number or { cause } with a string");
  }
  return problems;
}

function accessibilityProblems(body: Json, packed: boolean): string[] {
  if (!isObject(body)) return ["accessibility must be an object"];
  const problems = members(body, packed ? AX_REQUIRED.filter((member) => member !== "nodes") : AX_REQUIRED, AX_OPTIONAL).map((problem) => `accessibility ${problem}`);
  if (!epochMs(body.capturedAt)) problems.push("accessibility capturedAt must be epoch milliseconds");
  if (body.capturedUntil !== undefined && !epochMs(body.capturedUntil)) problems.push("accessibility capturedUntil must be epoch milliseconds");
  if (typeof body.status !== "string") problems.push("accessibility status must be a string");
  if (!packed) {
    if (!Array.isArray(body.nodes)) problems.push("accessibility nodes must be an array");
    else if (!body.nodes.every((node) => isObject(node) && typeof node.role === "string" && whole(node.depth))) {
      problems.push("accessibility nodes must each state a role and a whole-number depth");
    }
  }
  return problems;
}

function imageProblems(image: Json | undefined): string[] {
  if (image === undefined) return [];
  if (!isObject(image)) return ["image must be an object"];
  const keys = Object.keys(image).join();
  if (keys === "archive") {
    const reference = image.archive;
    if (!isObject(reference) || digestHex(reference.segmentSHA256) === null) return ["image.archive must state its segmentSHA256 in base64"];
    return whole(reference.ordinal) ? [] : ["image.archive.ordinal must be a whole number"];
  }
  if (keys === "pending") {
    const pending = image.pending;
    const ok = isObject(pending) && Object.keys(pending).sort().join() === "bytes,file,sha256" && typeof pending.file === "string" &&
      typeof pending.sha256 === "string" && SHA256.test(pending.sha256) && whole(pending.bytes);
    return ok ? [] : ["image.pending must state file, sha256 and bytes"];
  }
  return ["image must state archive or pending"];
}

function textProblem(text: Json | undefined): string | null {
  if (!isObject(text) || Object.keys(text).sort().join() !== "observationSHA256,ordinal,segment,segmentBytes,segmentSHA256") {
    return "text must state segment, segmentSHA256, segmentBytes, ordinal and observationSHA256";
  }
  if (typeof text.segment !== "string" || !SEGMENT_NAME.test(text.segment)) return "text.segment must be <uuid>.lstext";
  if (digestHex(text.segmentSHA256) === null) return "text.segmentSHA256 must be base64 of 32 bytes";
  if (!whole(text.segmentBytes)) return "text.segmentBytes must be a whole number";
  if (!whole(text.ordinal)) return "text.ordinal must be a whole number";
  if (typeof text.observationSHA256 !== "string" || !SHA256.test(text.observationSHA256)) return "text.observationSHA256 must be 64 lowercase hex digits";
  return null;
}

function runProblem(run: Json, gap: JsonObject): string | null {
  if (!isObject(run) || Object.keys(run).join() !== "attempts" || !Array.isArray(run.attempts)) return "run must be { attempts: [...] }";
  const attempts = run.attempts;
  if (attempts.length < 2) return "a run holds two attempts or more; a single gap states run null";
  let previous: string | undefined;
  let hour: number | undefined;
  for (const [index, attempt] of attempts.entries()) {
    const where = `run.attempts[${index}]`;
    if (!Array.isArray(attempt) || attempt.length !== 4) return `${where} must be [bundle, capturedAt, capturedUntil, inputIdleSeconds]`;
    const [bundle, at, until, idle] = attempt;
    const micros = typeof bundle === "string" ? FOLDER.exec(bundle)?.[1] : undefined;
    if (micros === undefined) return `${where} bundle must be a capture folder`;
    if (!token(at) || !(Number(at) >= 0)) return `${where} capturedAt must be an epoch-milliseconds token`;
    if (until !== null && (!token(until) || !(Number(until) >= 0))) return `${where} capturedUntil must be null or an epoch-milliseconds token`;
    if (idle !== null && !token(idle)) return `${where} inputIdleSeconds must be null or a number token`;
    if ((until === null) !== (gap.capturedUntil === undefined) || (idle === null) !== (gap.inputIdleSeconds === undefined)) {
      return `${where} states capturedUntil and inputIdleSeconds exactly when the gap does`;
    }
    if (previous !== undefined && (bundle as string) <= previous) return `${where} bundle must follow the attempt before it`;
    const attemptHour = Math.floor(Number(micros) / HOUR_US);
    if (hour !== undefined && attemptHour !== hour) return `${where} bundle must fall in the run's UTC hour`;
    previous = bundle as string;
    hour = attemptHour;
  }
  const [, at, until, idle] = attempts[0] as [string, string, string | null, string | null];
  if (Number(at) !== gap.capturedAt || (until !== null && Number(until) !== gap.capturedUntil) || (idle !== null && Number(idle) !== gap.inputIdleSeconds)) {
    return "run.attempts[0] must state the gap's own capturedAt, capturedUntil and inputIdleSeconds";
  }
  return null;
}

function token(value: Json | undefined): value is string {
  return typeof value === "string" && NUMBER_TOKEN.test(value);
}

function epochMs(value: Json | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function whole(value: Json | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function sorted(value: Json): Json {
  return isObject(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]!])) : value;
}

