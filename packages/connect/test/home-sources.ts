import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "@lifestreamprotocol/core";
import type { Fixture } from "./drive.js";
import { CAMERAS_FILE, camerasLine } from "../labelers/cameras/reader.js";
import { FACES_FILE, facesLine } from "../labelers/faces/reader.js";
import { answerKey, answerLine, ANSWERS_FILE } from "../labelers/google-places/reader.js";
import { GROUPS_FILE, groupsLine } from "../labelers/groups/reader.js";
import { STATEMENTS_FILE } from "../shared/statements.js";
import { tabClaim } from "../stations/reader.js";

function statements(source: string, device: string, lines: { kind: string; key: string; content: JsonObject }[], fetched_at = "2026-10-14T08:00:00.000Z"): Fixture {
  return (folder) => {
    const texts = lines.map((line) => `${JSON.stringify(line)}\n`);
    const bytes = Buffer.from(texts.join(""));
    writeFileSync(join(folder, STATEMENTS_FILE), bytes);
    const half = Math.floor(bytes.length / 2);
    let end = 0;
    const whole = texts.map((text) => (end += Buffer.byteLength(text)) - 1 <= half);
    const heads = lines.map((line) => `${line.kind} ${line.key}`);
    return {
      source, facts: { fetched_at, device },
      files: { [STATEMENTS_FILE]: { alone: heads, prefix: heads.filter((_, index) => whole[index]) } },
    };
  };
}

const T0 = Date.UTC(2026, 9, 14, 8);
const CHAT = `${T0}-3fa9c2`;
const message = (n: number, role: "user" | "assistant", text: string) => ({
  kind: "msg", key: `${CHAT}:${String(n).padStart(4, "0")}`, content: { type: "ask.msg", chat: CHAT, n, at_ms: T0 + n * 1_000, role, text },
});

export const askFixture = statements("ask:local:macbook-pro-0001", "ask", [
  { kind: "chat", key: CHAT, content: { type: "ask.chat", title: "Synthetic lunch", at_ms: T0 } },
  message(1, "user", "What did I eat on the synthetic Sunday?"),
  message(2, "assistant", "Synthetic soup."),
], new Date(T0 + 60_000).toISOString());

export const devicesFixture = statements("devices:local:macbook-pro-0001", "dashboard-macbook-pro-0001", [
  { kind: "camera", key: "synthetic-make/synthetic-camera", content: { type: "devices.camera", mine: true, from: "2026-01-01" } },
  { kind: "camera", key: "synthetic-make/other-camera", content: { type: "devices.camera", mine: false } },
]);

export const stationsFixture = statements("stations:local:macbook-pro-0001", "stations", [
  tabClaim({ station: "chrome-5550aa01", tab: 1001, errand: "e-0000aa01", from_ms: 1_791_000_000_000, until_ms: 1_791_000_660_000 }),
  tabClaim({ station: "chrome-5550aa01", tab: 1002, errand: "e-0000aa01", from_ms: 1_791_000_030_000, until_ms: 1_791_000_660_000 }),
]);

const place = (name: string) => ({ type: "places.place", name, centre: { latitude: 0.5, longitude: -0.25 }, radius_m: 150, ids: [], home: false });

export const placesFixture = statements("places:local:macbook-pro-0001", "iphone-17-pro-aa01", [
  { kind: "place", key: "synthetic-gym-3f9a2c", content: place("Synthetic Gym") },
  { kind: "place", key: "synthetic-park-0b1d4e", content: place("Synthetic Park") },
]);

export const placeNamesFixture = statements("google-maps:person-a@example.com:lookup", "iphone-17-pro-aa01", [
  { kind: "place", key: "google:synthetic-place-c", content: { type: "google.place", id: "synthetic-place-c", name: "Synthetic Cafe", centre: { latitude: 1, longitude: 1 } } },
  { kind: "place", key: "google:synthetic-place-d", content: { type: "google.place", id: "synthetic-place-d", name: "Synthetic Deli", centre: { latitude: 1.5, longitude: 1 } } },
]);

function labeled(source: string, file: string, lines: string[], heads: string[]): Fixture {
  return (folder) => {
    writeFileSync(join(folder, file), lines.map((line) => `${line}\n`).join(""));
    return { source, facts: {}, files: { [file]: "trust" }, heads };
  };
}

const HOME = "macbook-pro-0001";
const IMAGE = "a".repeat(64);

export const camerasFixture = labeled(`cameras:local:${HOME}`, CAMERAS_FILE, [
  camerasLine("photo", IMAGE, { type: "cameras.photo", camera: "synthetic-make/synthetic-camera" }),
  camerasLine("camera", "synthetic-make/synthetic-camera", {
    type: "cameras.camera", make: "Synthetic Make", model: "Synthetic Camera", photos: 1, first_ms: T0, last_ms: T0, sample: `sha256:${IMAGE}`, phones: [],
  }),
], [`photo ${IMAGE}`, "camera synthetic-make/synthetic-camera"]);

export const facesFixture = labeled(`faces:local:${HOME}`, FACES_FILE, [
  facesLine("image", IMAGE, { at_ms: T0, chat: false, labels: [], library: true, senders: [] }),
  facesLine("image", "b".repeat(64), { at_ms: null, chat: true, labels: [], library: false, senders: [] }),
], [`image ${IMAGE}`, `image ${"b".repeat(64)}`]);

export const googlePlacesFixture = labeled(`google-places:${HOME}:nearby`, ANSWERS_FILE, [
  answerLine(answerKey("nearby", 0.5, -0.25, 150), T0, { places: [{ id: "synthetic-place-c", displayName: { text: "Synthetic Cafe" } }] }),
], [`answer ${answerKey("nearby", 0.5, -0.25, 150)}`]);

export const groupsFixture = labeled(`groups:local:${HOME}`, GROUPS_FILE, [
  groupsLine("whatsapp:120363000000000001@g.us:2026-09", { yours: [["2026-09-01", "2026-09-30"]] }),
  groupsLine("whatsapp:120363000000000001@g.us:2026-10", { yours: [] }),
], ["month whatsapp:120363000000000001@g.us:2026-09", "month whatsapp:120363000000000001@g.us:2026-10"]);
