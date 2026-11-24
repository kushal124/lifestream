import { checks, each, instantMs, isObject, refuse, type Json, type JsonObject, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";
import * as phoneShipment from "../shared/phone-shipment.js";

const { exact, finite, guard, lineEnvelope, oneOf, positive, rfc3339, text, utc, UUID } = checks;
const { at, capture, readShipment } = phoneShipment;

const KINDS = ["report", "vigilance", "prompt"] as const;
const FORMS = ["moment", "day", "week", "prework", "block_before", "block_after", "block_rework"];
const TRIGGERS = ["random", "bedtime", "weekly", "prework", "calibration", "manual"];

export const checkin: Reader = {
  name: "checkin-ios-bundle",
  kinds: Object.fromEntries(KINDS.map((kind) => [kind, guard((content) => checkinGuard(content, kind))])),
  read: (delivery, files) =>
    readShipment(delivery, files, (shipment) =>
      each(shipment.entries("checkin"), (part) => part.where, ({ where, read }): ReaderOutput[] => {
        const { line, sequence, entry } = read();
        if (entry.kind === "access") return [];
        if (!KINDS.includes(entry.kind as (typeof KINDS)[number])) refuse(`${where} is a checkin entry kind this connector does not know: ${JSON.stringify(entry.kind)}`);
        const kind = entry.kind as string;
        return [{ kind, key: `${shipment.install}:${sequence}`, content: { type: `checkin.${kind}`, content: entry }, time: at(entry.observed_at, `${where}.observed_at`), ...capture(shipment, "checkin", line) }];
      }),
    ),
};

const number = (value: Json | undefined): number => (typeof value === "number" ? value : Number.NaN);
const nonnegative = (value: Json | undefined): boolean => Number.isFinite(number(value)) && number(value) >= 0;
const integer = (value: Json | undefined): boolean => nonnegative(value) && Number.isSafeInteger(number(value));
const uuid = (value: Json | undefined): boolean => typeof value === "string" && UUID.test(value);
const nullableUuid = (value: Json | undefined): boolean => value === null || uuid(value);
const wake = (p: JsonObject): boolean => (p.awake_for_s === null || finite(p.awake_for_s)) && (p.wake_source === null || oneOf(p.wake_source, ["healthkit", "default"]));

function checkinGuard(content: Json, kind: string): string | undefined {
  if (!exact(content, ["type", "content"]) || content.type !== `checkin.${kind}`) return `content must be {type: checkin.${kind}, content}`;
  const e = content.content;
  if (!lineEnvelope(e)) return "content.content must be the app's checkin line, every member";
  if (e.schema_version !== 1 || e.domain !== "checkin" || e.kind !== kind || !positive(e.sequence) || !utc(e.observed_at) || !uuid(e.process_instance_id)) {
    return "content.content's envelope: schema 1, domain checkin, its kind, a sequence, a UTC observed_at, a process UUID";
  }
  if (e.capture_replay_key !== undefined && !text(e.capture_replay_key)) return "content.content.capture_replay_key must be non-empty";
  const c = e.captured;
  if (
    !isObject(c) || !rfc3339(c.wall_rfc3339) || !nonnegative(c.elapsed_seconds ?? c.monotonic_seconds) || !finite(c.wall_unix_seconds) ||
    Math.abs(instantMs(c.wall_rfc3339)! / 1000 - c.wall_unix_seconds) > 0.001
  ) {
    return "content.content.captured must state an agreeing wall clock and a nonnegative clock";
  }
  const p = e.payload;
  if (!isObject(p)) return "content.content.payload must be an object";
  const ok =
    kind === "report" ? report(p, e) : kind === "vigilance" ? vigilance(p, e) : prompt(p);
  return ok ? undefined : `content.content.payload is not a ${kind} as the app writes it`;
}

function report(p: JsonObject, e: JsonObject): boolean {
  return (
    exact(p, ["form", "form_version", "prompt_id", "trigger", "opened_at", "answered_at", "local_zone", "response_ms", "changes", "awake_for_s", "wake_source", "block_id", "items", "note"], ["ended_by"]) &&
    oneOf(p.form, FORMS) && p.form_version === 1 && nullableUuid(p.prompt_id) && oneOf(p.trigger, TRIGGERS) &&
    utc(p.opened_at) && utc(p.answered_at) && e.observed_at === p.answered_at &&
    text(p.local_zone) && nonnegative(p.response_ms) && integer(p.changes) && wake(p) && nullableUuid(p.block_id) &&
    Array.isArray(p.items) && p.items.every(item) && (p.note === null || typeof p.note === "string") &&
    (p.ended_by === undefined || (p.form === "block_after" && p.ended_by === "timeout"))
  );
}

function item(value: Json): boolean {
  if (!exact(value, ["id", "question", "scale", "anchors", "value"]) || !text(value.id) || !text(value.question) || !integer(value.scale)) return false;
  if (!Array.isArray(value.anchors) || !value.anchors.every((anchor) => typeof anchor === "string")) return false;
  const scale = number(value.scale);
  if (typeof value.value === "string") return value.value.trim().length > 0 && (scale === 0 ? value.anchors.length === 0 : value.anchors.length === 2);
  if (typeof value.value === "boolean") return scale === 2 && value.anchors.length === 2;
  return integer(value.value) && scale > 0 && value.anchors.length === 2 && number(value.value) >= (value.id === "satisfaction" ? 0 : 1) && number(value.value) <= scale;
}

function vigilance(p: JsonObject, e: JsonObject): boolean {
  const device = p.device;
  return (
    exact(p, ["protocol", "duration_ms", "isi_ms", "lapse_threshold_ms", "false_start_under_ms", "timeout_ms", "prompt_id", "trigger", "started_at", "ended_at", "completed", "session_number", "awake_for_s", "wake_source", "device", "trials", "interruptions"]) &&
    p.protocol === "pvt-b-3min-v1" && p.duration_ms === 180000 &&
    Array.isArray(p.isi_ms) && p.isi_ms.length === 2 && p.isi_ms[0] === 2000 && p.isi_ms[1] === 10000 &&
    p.lapse_threshold_ms === 500 && p.false_start_under_ms === 100 && p.timeout_ms === 30000 &&
    nullableUuid(p.prompt_id) && oneOf(p.trigger, ["prework", "calibration", "manual"]) && utc(p.started_at) && utc(p.ended_at) &&
    e.observed_at === p.started_at && typeof p.completed === "boolean" && integer(p.session_number) && wake(p) &&
    exact(device, ["model", "os", "refresh_hz", "low_power"]) && typeof device.model === "string" && typeof device.os === "string" &&
    finite(device.refresh_hz) && device.refresh_hz > 0 && typeof device.low_power === "boolean" &&
    Array.isArray(p.trials) && p.trials.every(trial) &&
    Array.isArray(p.interruptions) && p.interruptions.every((i) => exact(i, ["at_ms", "reason"]) && nonnegative(i.at_ms) && oneOf(i.reason, ["background", "call", "frame_drop"]))
  );
}

function trial(t: Json): boolean {
  return (
    exact(t, ["n", "isi_ms", "stimulus_ms", "response_ms", "rt_ms", "class"]) && positive(t.n) &&
    number(t.isi_ms) >= 2000 && number(t.isi_ms) <= 10000 &&
    [t.stimulus_ms, t.response_ms, t.rt_ms].every((v) => v === null || finite(v)) &&
    (t.class === null ? t.response_ms === null : oneOf(t.class, ["response", "false_start", "timeout"]))
  );
}

function prompt(p: JsonObject): boolean {
  return (
    exact(p, ["prompt_id", "form", "trigger", "scheduled_for", "window_start", "window_end", "event"]) &&
    uuid(p.prompt_id) && text(p.form) && oneOf(p.trigger, TRIGGERS) && utc(p.scheduled_for) && utc(p.window_start) && utc(p.window_end) &&
    oneOf(p.event, ["scheduled", "delivered", "opened", "answered", "expired", "dismissed"])
  );
}
