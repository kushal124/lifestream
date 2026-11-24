import type { Guard } from "@lifestreamprotocol/connect/sdk";
import { exact, isCalendarDate, ownerConnector, type StatementKind } from "../shared/statements.js";
import { isCameraId } from "../shared/exif.js";

const camera: Guard = (content) => {
  if (!exact(content, ["type", "mine"], ["from", "to"]) || content.type !== "devices.camera") {
    return ["content must hold type devices.camera and mine, and may hold from and to"];
  }
  const out: string[] = [];
  if (typeof content.mine !== "boolean") out.push("mine must be true or false");
  for (const bound of ["from", "to"] as const) if (Object.hasOwn(content, bound) && !isCalendarDate(content[bound])) out.push(`${bound} must be a calendar date, YYYY-MM-DD`);
  if (isCalendarDate(content.from) && isCalendarDate(content.to) && (content.from as string) > (content.to as string)) out.push("from must not be after to");
  return out;
};

const CAMERAS: Readonly<Record<string, StatementKind>> = {
  camera: { guard: camera, key: (key) => (isCameraId(key) ? undefined : `${JSON.stringify(key)} is not a camera's id: <make>/<model> or phone/<unit>`) },
};

export const devicesHome = ownerConnector("devices-home", CAMERAS);
