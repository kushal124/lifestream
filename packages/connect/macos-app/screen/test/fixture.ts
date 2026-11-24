import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Fixture } from "../../../test/drive.js";
import { openZip } from "../../../shared/index.js";

export const RECORDER_UNIT = "synthetic-mac-0001";
export const RECORDER_SOURCE = `screen:local:${RECORDER_UNIT}`;
const BUNDLE = fileURLToPath(new URL("./recorder-bundle.zip", import.meta.url));
const OBSERVATIONS = new URL("./recorder-observations.jsonl", import.meta.url);

export interface RecorderDelivery {
  files: Record<string, Buffer>;
  blobs: Record<string, Buffer>;
  facts: { snapshot_taken_at: string };
}

export function swiftBundle(): RecorderDelivery {
  const zip = openZip(BUNDLE);
  try {
    const blobs: Record<string, Buffer> = {};
    let observations: Buffer | undefined;
    let facts: { snapshot_taken_at: string } | undefined;
    for (const entry of zip.entries()) {
      if (entry.name === "observations.jsonl") observations = entry.bytes();
      else if (entry.name.startsWith("blobs/")) blobs[entry.name.slice("blobs/".length)] = entry.bytes();
      else if (entry.name === "manifest.json") facts = { snapshot_taken_at: (JSON.parse(entry.bytes().toString("utf8")) as { facts: { snapshot_taken_at: string } }).facts.snapshot_taken_at };
    }
    return { files: { "observations.jsonl": observations! }, blobs, facts: facts! };
  } finally {
    zip.close();
  }
}

export const observation = (at: number, extra = ""): string =>
  `{"capturedAt":${at},"displayID":1,"height":48,"ocr":[],"ocrStatus":"not-run",${extra}"status":"captured","width":64,"windows":[]}`;

export function folderAt(epochMs: number, index: number): string {
  const day = new Date(Math.floor(epochMs)).toISOString().slice(0, 10);
  return `${day}/${String(Math.floor(epochMs * 1000)).padStart(20, "0")}-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

export function frameLine(folder: string, observation: string): string {
  return `{"bundle":"${folder.replaceAll("/", "\\/")}","observation":${observation},"archive":null,"pending":null,"text":null}`;
}

export function gapLine(folder: string, observation: string, run = "null"): string {
  return `{"bundle":"${folder.replaceAll("/", "\\/")}","observation":${observation},"run":${run}}`;
}

export function inlineDelivery(): RecorderDelivery {
  const spellings = readFileSync(OBSERVATIONS, "utf8").split("\n").filter((line) => line.length > 0);
  const lines = spellings.map((spelling, index) => {
    const folder = folderAt((JSON.parse(spelling) as { capturedAt: number }).capturedAt, index + 1);
    return spelling.includes('"status":"gap"') ? gapLine(folder, spelling) : frameLine(folder, spelling);
  });
  return { files: { "observations.jsonl": Buffer.from(lines.map((line) => `${line}\n`).join("")) }, blobs: {}, facts: { snapshot_taken_at: "2026-10-01T09:00:00.000Z" } };
}

export const fixture: Fixture = (folder) => {
  const { files, facts } = inlineDelivery();
  writeFileSync(join(folder, "observations.jsonl"), files["observations.jsonl"]!);
  return {
    source: RECORDER_SOURCE,
    facts,
    files: {
      "observations.jsonl": { alone: ["recorder 20261001T094917.303Z", "frame 20261001T094919.403Z", "frame 20261001T094919.403Z:1"], prefix: ["recorder 20261001T094917.303Z"] },
    },
  };
};

export const fixtures: Readonly<Record<string, Fixture>> = {
  "screen-recorder": fixture,
};
