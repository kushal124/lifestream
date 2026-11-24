import { basicInstant, deliveredLines, each, instantOf, isObject, lineText, parseLine, refuse, unitOf, type Guard, type JsonObject, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";
import { Ranks } from "../../shared/lanes.js";
import * as phoneShipment from "../../shared/phone-shipment.js";

const { at, capture, member, readShipment } = phoneShipment;

export const MACHINE_EVENT = "machine-event";

export const MACHINE_EVENT_NAMES: ReadonlySet<string> = new Set([
  "state", "access", "sleep", "wake", "display_sleep", "display_wake", "lock", "unlock", "session_active", "session_inactive",
  "power_ac", "power_battery", "lid_close", "lid_open", "wifi_join", "wifi_leave", "recorder_start", "recorder_stop",
  "shipper_run", "mic_start", "mic_stop", "sound_start", "sound_stop", "camera_start", "camera_stop", "output_device",
  "output_volume", "display_attach", "display_detach", "display_change", "bluetooth_connect", "bluetooth_disconnect",
  "ambient_light",
]);

const LOG_FILE = /\.jsonl$/u;
const OPEN_LOG = "current.jsonl";
const UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

const machineEvent: Guard = (content) => {
  const problems: string[] = [];
  const body = content as JsonObject;
  if (!isObject(content) || Object.keys(body).sort().join() !== "detail,event,type") return ["members must be exactly type, event, detail"];
  if (body.type !== "machine.event") problems.push("type must be machine.event");
  if (typeof body.event !== "string" || !MACHINE_EVENT_NAMES.has(body.event)) problems.push(`event ${JSON.stringify(body.event)} is outside the closed list`);
  if (!isObject(body.detail)) problems.push("detail must be an object");
  else {
    for (const [member, value] of Object.entries(body.detail)) {
      if (typeof value !== "string" && typeof value !== "boolean" && typeof value !== "number") {
        problems.push(`detail ${member} must be a string, a finite number or a boolean`);
      }
    }
  }
  return problems;
};

export const machineEvents: Reader = {
  name: "machine-events",
  kinds: { [MACHINE_EVENT]: machineEvent },
  async *read(delivery, files) {
    const device = unitOf(delivery.source);
    const ranks = new Ranks();
    const logs = delivery.files.filter((file) => LOG_FILE.test(file.path) && file.path !== OPEN_LOG);
    logs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const log of logs) {
      yield* each(deliveredLines(files, log), (part) => part.where, ({ bytes, line, where }) => [event(lineText(bytes, where), `${log.path}:line ${line}`, device, ranks)]);
    }
  },
};

export const machineIosBundle: Reader = {
  name: "machine-ios-bundle",
  kinds: { [MACHINE_EVENT]: machineEvent },
  read: (delivery, files) =>
    readShipment(delivery, files, (shipment) =>
      each(shipment.entries("machine"), (part) => part.where, ({ where, read }): ReaderOutput[] => {
        const { line, sequence, entry } = read();
        if (entry.kind !== MACHINE_EVENT) refuse(`${where} is a machine entry kind this connector does not know: ${JSON.stringify(entry.kind)}`);
        return [{
          kind: MACHINE_EVENT, key: `${shipment.install}:${sequence}`, content: { type: "machine.event", ...member(entry, "payload", where) },
          time: at(entry.observed_at, `${where}.observed_at`), ...capture(shipment, "machine", line),
        }];
      }),
    ),
};

function event(text: string, locator: string, device: string, ranks: Ranks): ReaderOutput {
  const value = parseLine(text, locator);
  const at = value.at;
  if (typeof at !== "string" || !UTC_MS.test(at)) refuse(`${locator} at must be an RFC 3339 UTC instant with at most milliseconds`);
  if (typeof value.event !== "string") refuse(`${locator} states no event name`);
  const time = instantOf(at, "rfc3339", locator);
  const { at: _at, ...rest } = value;
  return {
    kind: MACHINE_EVENT,
    key: ranks.key(`${basicInstant(time.start_ms)}:${value.event}`),
    content: { type: "machine.event", ...rest },
    time,
    device,
    locator,
  };
}
