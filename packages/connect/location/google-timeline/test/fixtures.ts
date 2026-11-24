import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isObject, type JsonObject } from "@lifestreamprotocol/core";
import type { Fixture } from "../../../test/drive.js";
import { temp, writeZip } from "../../../test/drive.js";
import { basicInstant } from "../../../shared/lanes.js";

export const ACCOUNT = "person-a@example.com";
export const SOURCE = `google-timeline:${ACCOUNT}:export`;
export const FACTS: JsonObject = { exported_at: "2026-09-07T03:00:00Z", fetched_at: "2026-09-07T04:00:00Z", device: "pixel-0001" };

export const SEGMENTS: JsonObject[] = [
  {
    startTime: "2026-09-05T08:00:00.000+05:30",
    endTime: "2026-09-05T09:15:00.000+05:30",
    startTimeTimezoneUtcOffsetMinutes: 330,
    endTimeTimezoneUtcOffsetMinutes: 330,
    visit: { hierarchyLevel: 0, probability: 0.85, topCandidate: { placeID: "ChIJ-synthetic-place-0001", semanticType: "HOME", probability: 0.75, placeLocation: { latLng: "10.0000000°, 20.0000000°" } } },
  },
  {
    startTime: "2026-09-05T09:15:00.000+05:30",
    endTime: "2026-09-05T09:40:30.500+05:30",
    activity: { start: { latLng: "10.0000000°, 20.0000000°" }, end: { latLng: "10.0100000°, 20.0200000°" }, distanceMeters: 2345.5, probability: 0.5, topCandidate: { type: "IN_PASSENGER_VEHICLE", probability: 0.25 } },
  },
  {
    startTime: "2026-09-05T09:15:00.000+05:30",
    endTime: "2026-09-05T10:00:00.000+05:30",
    timelinePath: [
      { point: "10.0000000°, 20.0000000°", time: "2026-09-05T09:16:00.000+05:30" },
      { point: "10.0100000°, 20.0200000°", time: "2026-09-05T09:39:00.000+05:30" },
    ],
  },
  {
    startTime: "2026-09-05T04:10:30.750Z",
    endTime: "2026-09-05T06:00:00.000Z",
    visit: { hierarchyLevel: 1, probability: 0.5, isTimelessVisit: false },
  },
];

export function exportFile(segments: JsonObject[] = SEGMENTS, form: "object" | "array" = "object"): Buffer {
  if (form === "array") return Buffer.from(JSON.stringify(segments, null, 2));
  return Buffer.from(JSON.stringify({ semanticSegments: segments, rawSignals: [{ position: { LatLng: "10.0°, 20.0°", timestamp: "2026-09-05T08:00:00.000+05:30" } }], userLocationProfile: { frequentPlaces: [] } }, null, 2));
}

export function timelineHanded(form: "file" | "zip" | "folder" = "file", bytes: Buffer = exportFile()): Record<string, Buffer> {
  if (form === "file") return { "location-history.json": bytes };
  if (form === "folder") return { "Timeline/location-history.json": bytes };
  const path = join(temp("google-timeline-zip-"), "Timeline.zip");
  writeZip(path, [{ name: "location-history.json", bytes, method: "deflate" }]);
  return { "Timeline.zip": readFileSync(path) };
}

export const timelineFixture: Fixture = (folder) => {
  writeFileSync(join(folder, "location-history.json"), exportFile());
  const kinds: Record<string, string> = { visit: "place-visit", activity: "trip", timelinePath: "path" };
  const heads = SEGMENTS.map((segment) => {
    const family = Object.keys(kinds).find((name) => Object.hasOwn(segment, name))!;
    const second = basicInstant(Math.floor(Date.parse(segment.startTime as string) / 1000) * 1000);
    const top = isObject(segment.visit) && isObject(segment.visit.topCandidate) ? segment.visit.topCandidate.placeID : undefined;
    return `${kinds[family]} ${typeof top === "string" ? `${second}:${top}` : second}`;
  });
  return { source: SOURCE, facts: FACTS, files: { "location-history.json": { alone: heads } } };
};
