import { createHash } from "node:crypto";
import { chmodSync, constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { openHome, openHomeFolder, type ReaderOutput } from "@lifestreamprotocol/core";
import { faces, people } from "@lifestreamprotocol/connect";
import { CAPTION_PROMPT, MESSAGES_FAMILY, TRANSCRIPT_PROMPT } from "@lifestreamprotocol/families";
import { serveDoor, type Door } from "../door.js";
import type { Maker } from "../pictures.js";
import { startHome, type Home } from "../home.js";
import { mintPrincipal } from "../principals.js";
import { askHome } from "../socket.js";
import { testSocket } from "./folder.js";
import { LOOK_MS, makeRoot, readHome, removeRoot, settled, TICK_MS, until } from "./harness-root.js";
import { ship, shipFiles, type Planned } from "./harness-deliveries.js";
import { complete, fillPart, recount, upgrade } from "./stored.js";
import { effective } from "../settings.js";
import { deliveriesOf, deliveryDirectory, lanes, manifestOf } from "../inbox.js";

const REGISTRY = fileURLToPath(new URL("./dashboard-registry.ts", import.meta.url));
const DAY = "2026-09-28";
const at = (clock: string) => Date.parse(`${DAY}T${clock}Z`);
const APPLE_EPOCH_S = 978_307_200;
const UNIT = "iphone-aa01";
const WHATSAPP = `whatsapp:+15550000009:${UNIT}`;
const CONTACTS = `apple-contacts:local:${UNIT}`;
const HOME_UNIT = "macbook-pro-0001";
const PEOPLE = `people:local:${HOME_UNIT}`;
const PLACES = `places:local:${HOME_UNIT}`;
const GOOGLE = "google-maps:person-a@example.com:lookup";
const LOCATION = `location:local:${UNIT}`;
const MAIL = "gmail:person-a@example.com:cloud";
const PHOTOS = "google-photos:person-a@example.com:export";
const CAMERAS = `cameras:local:${HOME_UNIT}`;
const DEVICES = `devices:local:${HOME_UNIT}`;
const OWN_CAMERA = "synthetic-make/own-camera";
const STRANGER_CAMERA = "synthetic-make/stranger-camera";
const LISBON = { latitude: 38.7223, longitude: -9.1393 };
const A = "15550000001@s.whatsapp.net";
const B = "15550000002@s.whatsapp.net";
const C = "15550000003@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const TOKENS = { reader: "synthetic-dashboard-reader".padEnd(43, "r"), device: "synthetic-dashboard-device".padEnd(43, "d") };
const INSTALL = "11111111-1111-4111-8111-111111111111";

function wa(stanza: string, chat: string, when: number, text: string, from: { me?: true; member?: string } = {}) {
  const date = when / 1000 - APPLE_EPOCH_S;
  const message = {
    ZSTANZAID: stanza, ZTEXT: text, ZFROMJID: from.me === true ? null : chat, ZTOJID: null, ZPUSHNAME: null, ZMESSAGEDATE: date, ZSENTDATE: date,
    ZMESSAGETYPE: 0, ZGROUPEVENTTYPE: null, ZFLAGS: 0, ZMESSAGESTATUS: 1, ZMESSAGEERRORSTATUS: 0, ZISFROMME: from.me === true ? 1 : 0, ZSTARRED: 0,
  };
  return {
    kind: "msg", key: `${chat}:${stanza}`, at: when,
    content: { type: "whatsapp.msg", message, session_jid: chat, parent_stanza_id: null, media_item: null, group_member_jid: from.member ?? null, blobs: [] },
  };
}

const groupShell = { kind: "chat", key: GROUP, content: { type: "whatsapp.chat", group_info: null,
  chat: { ZCONTACTJID: GROUP, ZCONTACTIDENTIFIER: null, ZPARTNERNAME: "Group Alpha", ZSESSIONTYPE: 1 } } };

let sequence = 0;
function fix(when: number, latitude: number, longitude: number, speed: number) {
  const iso = new Date(when).toISOString();
  const payload = { location: { timestamp_rfc3339_utc: iso, timestamp_unix_seconds: when / 1000, latitude, longitude, horizontal_accuracy: 5,
    vertical_accuracy: 3, altitude: 12, speed, course: 90 }, capture_context: { engine: "app_owned", authorization: "always" } };
  const n = ++sequence;
  return { kind: "fix", key: `${INSTALL}:${n}`, at: when + 1_500, content: { type: "location.fix", content: {
    schema_version: 1, domain: "location", kind: "fix", sequence: n, payload,
    captured: { wall_rfc3339: iso, wall_unix_seconds: when / 1000, elapsed_seconds: n * 7.5 }, process_instance_id: INSTALL,
  } } };
}

function track(plan: (stay: (from: string, to: string, latitude: number, longitude: number) => void,
  move: (from: string, to: string, a: [number, number], b: [number, number]) => void) => void) {
  const rows: ReturnType<typeof fix>[] = [];
  plan((from, to, latitude, longitude) => {
    for (let t = at(from); t < at(to); t += 120_000) rows.push(fix(t, latitude, longitude, 0));
  }, (from, to, a, b) => {
    const steps = Math.round((at(to) - at(from)) / 20_000);
    for (let step = 0; step < steps; step++) {
      const share = step / steps;
      rows.push(fix(at(from) + step * 20_000, a[0] + (b[0] - a[0]) * share, a[1] + (b[1] - a[1]) * share, 9));
    }
  });
  return rows;
}

const fixes = () => track((stay, move) => {
  stay("06:00:00", "09:00:00", 0, 0);
  move("09:00:00", "09:10:00", [0, 0], [0, 0.0135]);
  stay("09:10:00", "12:00:00", 0, 0.0135);
  move("12:00:00", "12:10:00", [0, 0.0135], [0, 0]);
  stay("12:10:00", "14:00:00", 0, 0);
});

const unnamedFixes = () => track((stay, move) => {
  move("14:10:00", "14:20:00", [0, 0], [0, 0.03]);
  stay("14:20:00", "15:40:00", 0, 0.03);
  move("15:40:00", "15:50:00", [0, 0.03], [0.02, 0.03]);
  stay("15:50:00", "16:10:00", 0.02, 0.03);
  move("16:10:00", "16:20:00", [0.02, 0.03], [0, 0]);
  stay("16:20:00", "17:00:00", 0, 0);
});

function mailRow(key: string, when: number, folder: string, from: string, to: string, subject: string, body = "A synthetic body.") {
  const bytes = Buffer.from([`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Date: ${new Date(when).toUTCString()}`,
    `Message-ID: <${key}@example.com>`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "", body, ""].join("\r\n"));
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return {
    row: { kind: "mailmsg", key, at: when, blobs: [hash],
      content: { content: { gm_msgid: key, folder, labels: [] }, blobs: [{ hash, role: "original", media_type: "message/rfc822" }] } },
    carried: [hash.slice(7), bytes] as const,
  };
}

function photoRow(when: number, bytes: Buffer, mediaType: string) {
  const hex = createHash("sha256").update(bytes).digest("hex");
  return {
    row: { kind: "img", key: hex, at: when, blobs: [`sha256:${hex}`], content: { type: "photos.asset", blobs: [{ hash: `sha256:${hex}`, media_type: mediaType }] } },
    carried: [hex, bytes] as const,
  };
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);
const jpeg = photoRow(at("13:00:00"), JPEG, "image/jpeg");
const svg = photoRow(at("13:00:30"), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/svg+xml");

function locatedRow(when: number, name: string, point: { latitude: number; longitude: number }) {
  const original = Buffer.from(`synthetic located photo ${name}`);
  const hex = createHash("sha256").update(original).digest("hex");
  return {
    row: { kind: "img", key: hex, at: when, blobs: [`sha256:${hex}`], content: { type: "photos.asset",
      title: `${name}.JPG`, photoTakenTime: { timestamp: String(Math.floor(when / 1000)) }, geoDataExif: { ...point, altitude: 10, latitudeSpan: 0, longitudeSpan: 0 },
      blobs: [{ hash: `sha256:${hex}`, bytes: original.length, media_type: "image/jpeg", role: "original" }] } },
    carried: [[hex, original]] as const,
    camera: { kind: "photo", key: hex, content: { type: "cameras.photo", camera: OWN_CAMERA } },
  };
}
const located = [locatedRow(Date.parse("2026-09-26T12:00:00Z"), "lisbon-1", LISBON), locatedRow(Date.parse("2026-09-27T12:00:00Z"), "lisbon-2", LISBON)];
const cameraCounts = [
  { kind: "camera", key: OWN_CAMERA, content: { type: "cameras.camera", make: "Synthetic Make", model: "Own Camera", photos: 60,
    first_ms: Date.parse("2019-05-01T12:00:00Z"), last_ms: Date.parse("2026-09-27T12:00:00Z"), sample: `sha256:${jpeg.carried[0]}`, phones: [] } },
  { kind: "camera", key: STRANGER_CAMERA, content: { type: "cameras.camera", make: "Synthetic Make", model: "Stranger Camera", photos: 3,
    first_ms: Date.parse("2026-09-01T12:00:00Z"), last_ms: Date.parse("2026-09-01T12:05:00Z"), sample: null, phones: [] } },
];

const card = (name: string, phone: string, photo?: Buffer, lines: readonly string[] = []) => ({ kind: "contact", key: "c1", content: {
  card: `BEGIN:VCARD\r\nFN:${name}\r\nTEL:${phone}\r\n${lines.map((line) => `${line}\r\n`).join("")}${photo === undefined ? "" : `PHOTO;ENCODING=b;TYPE=JPEG:${photo.toString("base64")}\r\n`}END:VCARD\r\n` } });
const person = { kind: "person", key: "person-b", content: { type: "people.person", slug: "person-b", name: "Person B", merged_into: null, excluded: [],
  handles: [{ kind: "name", value: "Person B", by: "subject", since: "2026-10-01T00:00:00Z" }, { kind: "phone", value: "+15550000002", by: "subject", since: "2026-10-01T00:00:00Z" }] } };
const ownerPlaces = [
  { kind: "place", key: "home", content: { type: "places.place", name: "Synthetic Home", centre: { latitude: 0, longitude: 0 }, radius_m: 120, ids: [] } },
  { kind: "place", key: "office", content: { type: "places.place", name: "Synthetic Office", centre: { latitude: 0, longitude: 0.0135 }, radius_m: 120, ids: [] } },
];
const googleNames = [{ kind: "place", key: "google:synthetic-place-c", content: { type: "google.place", id: "synthetic-place-c", name: "Synthetic Cafe", centre: { latitude: 1, longitude: 1 } } }];

const statements = (lines: unknown[]) => ({ "statements.ndjson": Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join("")) });
const OWNER_FACTS = { device: HOME_UNIT };


const FACES = `faces:local:${HOME_UNIT}`;
const FACES_TOKEN = "synthetic-dashboard-both".padEnd(43, "b");
const FAKE_ENGINE = fileURLToPath(new URL("../../connect/labelers/faces/test/fake-engine.mjs", import.meta.url));
const LEFT = [100, 100, 300, 300];
const RIGHT = [500, 100, 700, 300];
const FACES_GROUP = "120363000000000002@g.us";
const D = "15550000004@s.whatsapp.net";
const OWN_MAIL = "gmail:person-zero@example.com:cloud";

interface Pictured {
  faces: { box: number[]; tag: number; typical?: number; likeness?: number }[];
  at: string;
  via: "library" | "a" | "group";
  sidecar?: string[];
}

const PICTURED: Record<string, Pictured> = {
  ...Object.fromEntries([2019, 2020, 2021, 2022, 2023, 2024, 2025].map((year, index) => [`o${index + 1}`, { faces: [{ box: LEFT, tag: 1 }], at: `${year}-06-01T10:00:00Z`, via: "library" }])),
  g1: { faces: [{ box: LEFT, tag: 1 }, { box: RIGHT, tag: 2 }], at: "2024-08-01T10:00:00Z", via: "library" },
  a1: { faces: [{ box: LEFT, tag: 2 }], at: "2025-01-02T10:00:00Z", via: "a" },
  a2: { faces: [{ box: LEFT, tag: 2 }], at: "2025-01-03T10:00:00Z", via: "a" },
  a3: { faces: [{ box: LEFT, tag: 2 }], at: "2025-01-04T10:00:00Z", via: "a" },
  a4: { faces: [{ box: LEFT, tag: 2 }], at: "2023-05-01T10:00:00Z", via: "library" },
  a5: { faces: [{ box: LEFT, tag: 2, typical: 0.5 }], at: "2022-05-01T10:00:00Z", via: "library" },
  g2: { faces: [{ box: LEFT, tag: 2 }, { box: RIGHT, tag: 7 }], at: "2024-09-01T10:00:00Z", via: "library" },
  b1: { faces: [{ box: LEFT, tag: 3 }], at: "2021-03-01T10:00:00Z", via: "library", sidecar: ["Person B"] },
  b2: { faces: [{ box: LEFT, tag: 3 }], at: "2021-04-01T10:00:00Z", via: "library", sidecar: ["Person B"] },
  b3: { faces: [{ box: LEFT, tag: 3 }], at: "2022-03-01T10:00:00Z", via: "library" },
  b4: { faces: [{ box: LEFT, tag: 3 }], at: "2023-03-01T10:00:00Z", via: "library" },
  s1: { faces: [{ box: LEFT, tag: 4 }], at: "2020-07-01T10:00:00Z", via: "library", sidecar: ["Person E"] },
  s2: { faces: [{ box: LEFT, tag: 4 }], at: "2020-07-02T10:00:00Z", via: "library", sidecar: ["Person E"] },
  s3: { faces: [{ box: LEFT, tag: 4 }], at: "2020-07-03T10:00:00Z", via: "library" },
  c1: { faces: [{ box: LEFT, tag: 5 }], at: "2025-02-01T10:00:00Z", via: "group" },
  c2: { faces: [{ box: LEFT, tag: 5 }], at: "2025-02-02T10:00:00Z", via: "group" },
  c3: { faces: [{ box: LEFT, tag: 5 }], at: "2025-02-03T10:00:00Z", via: "group" },
  x1: { faces: [{ box: LEFT, tag: 6 }], at: "2023-08-01T10:00:00Z", via: "library" },
  x2: { faces: [{ box: LEFT, tag: 6 }], at: "2023-08-02T10:00:00Z", via: "library" },
  x3: { faces: [{ box: LEFT, tag: 6 }], at: "2023-08-03T10:00:00Z", via: "library" },
  y1: { faces: [{ box: LEFT, tag: 7 }], at: "2022-09-01T10:00:00Z", via: "library", sidecar: ["Person Zero"] },
  y2: { faces: [{ box: LEFT, tag: 7 }], at: "2022-09-02T10:00:00Z", via: "library" },
  m1: { faces: [{ box: LEFT, tag: 2, likeness: 0.5 }], at: "2021-09-01T10:00:00Z", via: "library" },
  z1: { faces: [{ box: LEFT, tag: 8 }], at: "2018-06-01T10:00:00Z", via: "library" },
  z2: { faces: [{ box: LEFT, tag: 8 }], at: "2018-07-01T10:00:00Z", via: "library" },
};
const photoBytes = (name: string) => Buffer.from(`synthetic faces photo ${name}`);
const photoHex = (name: string) => createHash("sha256").update(photoBytes(name)).digest("hex");
const FACES_LIBRARY = {
  photos: Object.fromEntries(Object.keys(PICTURED).map((name) => [name, photoHex(name)])),
  faces: Object.fromEntries(Object.entries(PICTURED).map(([name, { faces }]) => [name, faces.map(({ box, tag, likeness }) => ({ tag, face: `${photoHex(name)}:${box.join(",")}`, ...(likeness === undefined ? {} : { maybe: true }) }))])),
  unit: HOME_UNIT, faces_source: FACES, people_source: PEOPLE, own: "+15550000009",
};

function facesRoot(): string {
  const made = makeRoot("dashboard-faces-", {
    sources: { ...Object.fromEntries([WHATSAPP, OWN_MAIL, CONTACTS, PHOTOS, CAMERAS].map((id) => [id, "dashboard-rows"])), [PEOPLE]: "people-home", [FACES]: "faces" },
    settings: { unit: HOME_UNIT },
  });
  const engine = join(made, "engine");
  mkdirSync(engine, { recursive: true });
  writeFileSync(join(engine, "face-engine"), `#!/bin/sh\nFAKE_ENGINE_DIR="$(cd "$(dirname "$0")" && pwd)" exec '${process.execPath}' '${FAKE_ENGINE}' "$@"\n`);
  chmodSync(join(engine, "face-engine"), 0o755);
  const models = join(made, "tools", "faces", "models", "buffalo_l");
  mkdirSync(models, { recursive: true });
  for (const file of ["det_10g.onnx", "w600k_r50.onnx"]) writeFileSync(join(models, file), `synthetic ${file}`);
  const faces = Object.fromEntries(Object.entries(PICTURED).map(([name, pictured]) => [photoHex(name), pictured.faces.map((face) => ({ ...face, tier: "seed" }))]));
  writeFileSync(join(engine, "engine.json"), JSON.stringify({
    pipeline: { version: 1, detector: "fake-detector", recognizer: "fake-recognizer", detect_size: 1280, detect_threshold: 0.45, overlap_threshold: 0.4, tiers: [] },
    faces, suggested: { 6: [{ person: "person-a", score: 0.61 }], 7: [{ person: "person-a", score: 0.58 }] },
  }));
  for (const [unit, scopes, sources, token] of [["reader", ["read"], [], TOKENS.reader], ["dashboard-macbook-pro-0001", ["read", "deliver"], [PEOPLE], FACES_TOKEN]] as const) {
    mintPrincipal(openHomeFolder(made), { unit, scopes: [...scopes], sources: [...sources], token, now_ms: 0 });
  }
  return made;
}

const OGG = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(60, 7)]);

function waFile(stanza: string, when: number, type: 1 | 3, bytes: Buffer, more: { seconds?: number; parent?: string; me?: true } = {}) {
  const hex = createHash("sha256").update(bytes).digest("hex");
  const row = wa(stanza, A, when, "", more.me === true ? { me: true } : {});
  const message = { ...row.content.message, ZTEXT: null, ZMESSAGETYPE: type };
  return {
    row: { ...row, blobs: [`sha256:${hex}`], content: { ...row.content, message, parent_stanza_id: more.parent ?? null,
      media_item: more.seconds === undefined ? null : { ZMOVIEDURATION: more.seconds },
      blobs: [{ hash: `sha256:${hex}`, bytes: bytes.length, role: "ZWAMEDIAITEM.ZMEDIALOCALPATH" }] } },
    carried: [hex, bytes] as const,
  };
}

function waPhoto(stanza: string, chat: string, when: number, hex: string, from: { member?: string } = {}) {
  const row = wa(stanza, chat, when, "", from);
  const message = { ...row.content.message, ZTEXT: null, ZMESSAGETYPE: 1 };
  return { ...row, blobs: [`sha256:${hex}`], content: { ...row.content, message, blobs: [{ hash: `sha256:${hex}`, bytes: 30, role: "ZWAMEDIAITEM.ZMEDIALOCALPATH" }] } };
}

const PERSON_A_CARD = ["N:A;Person;;;", "ORG:Synthetic Studio", "TITLE:Designer", "URL:https://instagram.com/person.a.example"];

async function shipFacesInto(target: string): Promise<void> {
  const sendInto = async (planned: Planned): Promise<void> => {
    await ship(target, planned);
    if (target === root) shipped++;
    await settles("the home settled", () => calm(target), target);
  };
  const now = Date.now();
  const since = "2026-10-01T00:00:00.000Z";
  const personB = { type: "people.person", slug: "person-b", name: "Person B", excluded: [], merged_into: null,
    handles: [{ kind: "name", value: "Person B", by: "subject", since }, { kind: "phone", value: "+15550000002", by: "subject", since }] };
  await shipFiles(target, PEOPLE, now, statements([{ kind: "person", key: "person-b", content: personB }]), OWNER_FACTS);
  if (target === root) shipped++;
  await settles("the home settled", () => calm(target), target);
  await sendInto({ source: CONTACTS, fetched_ms: now + 1, rows: [card("Person A", "+15550000001", undefined, PERSON_A_CARD)] });
  const day = (iso: string) => Date.parse(iso);
  const library = Object.entries(PICTURED).filter(([, pictured]) => pictured.via === "library").map(([name, pictured]) => {
    const hex = photoHex(name);
    return {
      kind: "img", key: hex, at: day(pictured.at), blobs: [`sha256:${hex}`],
      content: { type: "photos.asset", title: `${name}.jpg`, ...(pictured.sidecar === undefined ? {} : { people: pictured.sidecar.map((each) => ({ name: each })) }),
        blobs: [{ hash: `sha256:${hex}`, media_type: "image/jpeg" }] },
    };
  });
  const carried = Object.fromEntries(Object.keys(PICTURED).map((name) => [photoHex(name), photoBytes(name)]));
  await sendInto({ source: PHOTOS, fetched_ms: now + 2, rows: library, carried: { ...Object.fromEntries(Object.entries(carried).filter(([hex]) => library.some((row) => row.key === hex))) } });
  await sendInto({ source: CAMERAS, fetched_ms: now + 2, rows: library.map((row) => ({ kind: "photo", key: row.key, content: { type: "cameras.photo", camera: OWN_CAMERA } })) });
  await sendInto({ source: WHATSAPP, fetched_ms: now + 3, rows: [
    ...["2025-01-01", "2025-01-02", "2025-01-03", "2025-01-04", "2025-01-05"].flatMap((date, index) => [
      wa(`FA${index}`, A, day(`${date}T09:00:00Z`), `synthetic words from person a ${index}`), wa(`FM${index}`, A, day(`${date}T09:05:00Z`), `synthetic reply ${index}`, { me: true })]),
    ...["a1", "a2", "a3"].map((name, index) => waPhoto(`FP${index}`, A, day(PICTURED[name]!.at), photoHex(name))),
    ...["2024-03-14", "2025-03-14"].map((date, index) => wa(`FW${index}`, A, day(`${date}T09:00:00Z`), "happy birthday, synthetic friend", { me: true })),
    ...["2021-03-01", "2021-04-01"].map((date, index) => wa(`FB${index}`, B, day(`${date}T12:00:00Z`), `synthetic words from person b ${index}`)),
    { kind: "chat", key: FACES_GROUP, content: { type: "whatsapp.chat", group_info: null, chat: { ZCONTACTJID: FACES_GROUP, ZCONTACTIDENTIFIER: null, ZPARTNERNAME: "Group Beta", ZSESSIONTYPE: 1 } } },
    ...["c1", "c2", "c3"].map((name, index) => waPhoto(`FC${index}`, FACES_GROUP, day(PICTURED[name]!.at), photoHex(name), { member: C })),
    wa("FD0", FACES_GROUP, day("2025-02-01T11:00:00Z"), "synthetic words from person d", { member: D }),
  ], carried: Object.fromEntries(["a1", "a2", "a3", "c1", "c2", "c3"].map((name) => [photoHex(name), photoBytes(name)])) });
  await settles("the faces labeled", () => calm(target) && readHome(target, (db) => db.prepare("SELECT count(*) FROM heads WHERE source = ? AND kind = 'cluster' AND version <> 'gone'")
    .pluck().get(FACES) as number) > 0, target);
}

async function shipFacesPeople(): Promise<void> {
  const now = Date.now();
  const cards = [["zero", "Person Zero", "+15550000009"], ["c", "Person C", "+15550000003"], ["e1", "Person E", "+15550000005"], ["e2", "Person E", "+15550000006"]];
  await send({ source: CONTACTS, fetched_ms: now, rows: cards.map(([key, name, phone]) => ({ ...card(name!, phone!), key: `c-${key}` })) });
  await send({ source: WHATSAPP, fetched_ms: now + 1, rows: Array.from({ length: 20 }, (_, index) =>
    wa(`FE${index}`, FACES_GROUP, Date.parse("2025-02-04T09:00:00Z") + index * 60_000, `synthetic group words from person c ${index}`, { member: C })) });
  const zero = { type: "people.person", slug: "person-zero", name: "Person Zero", full_name: null, show: "name", entity: "person", relationship: null,
    hidden: false, me: false, anchor: null, handles: [], excluded: [], dismissed: [], merged_into: null };
  const named = ["z1", "z2"].map((photo) => ({ kind: "face", key: FACES_LIBRARY.faces[photo]![0]!.face, content: { is: "person-zero" } }));
  await shipFiles(root, PEOPLE, now + 2, statements([{ kind: "person", key: "person-zero", content: zero }, ...named]), OWNER_FACTS);
  shipped++;
  await settles("the people landed and the faces labeled", calm);
}


const DAY_MS = 86_400_000;
const STORAGE: Readonly<Record<string, string>> = { whatsapp: WHATSAPP, gmail: MAIL, "google-photos": PHOTOS };

function noise(seed: string, bytes: number): Buffer {
  const blocks: Buffer[] = [];
  for (let at = 0; at * 32 < bytes; at++) blocks.push(createHash("sha256").update(`${seed} ${at}`).digest());
  return Buffer.concat(blocks).subarray(0, bytes);
}

function storageDay(day: number, when: number): Planned[] {
  const grow = 1 + day / 2;
  const chat = Array.from({ length: 4 }, (_, n) => waFile(`S${day}${n}`, when + n * 60_000, 1, noise(`storage whatsapp ${day} ${n}`, Math.round(20_000 * grow))));
  const mails = Array.from({ length: 2 }, (_, n) => mailRow(`s${day}${n}`, when + n * 60_000, "INBOX", "Person A <person-a@example.com>", "Person C <person-c@example.com>",
    `Synthetic storage ${day} ${n}`, noise(`storage mail ${day} ${n}`, Math.round(45_000 * grow)).toString("base64")));
  const photos = Array.from({ length: 3 }, (_, n) => photoRow(when + n * 60_000, Buffer.concat([JPEG, noise(`storage photo ${day} ${n}`, Math.round(200_000 * grow))]), "image/jpeg"));
  return [
    { source: WHATSAPP, fetched_ms: when, rows: chat.map((each) => each.row), carried: Object.fromEntries(chat.map((each) => each.carried)) },
    { source: MAIL, fetched_ms: when, rows: mails.map((each) => each.row), carried: Object.fromEntries(mails.map((each) => each.carried)) },
    { source: PHOTOS, fetched_ms: when, rows: photos.map((each) => each.row), carried: Object.fromEntries(photos.map((each) => each.carried)) },
  ];
}

const blobPath = (at: string, hex: string) => join(at, "blobs", hex.slice(0, 2), hex.slice(2, 4), hex);

async function storageRoot(): Promise<string> {
  const made = makeRoot("dashboard-storage-", { sources: Object.fromEntries(Object.values(STORAGE).map((id) => [id, "dashboard-rows"])), settings: { unit: HOME_UNIT } });
  mintPrincipal(openHomeFolder(made), { unit: "reader", scopes: ["read"], sources: [], token: TOKENS.reader, now_ms: 0 });
  let back = 2 * DAY_MS;
  const earlier = await startHome(made, { registry: REGISTRY, log: () => undefined, clock: () => Date.now() - back });
  const dated: [string, number][] = [];
  try {
    for (const day of [0, 1]) {
      back = (2 - day) * DAY_MS;
      const when = Date.now() - back - 3_600_000;
      for (const planned of storageDay(day, when)) {
        await ship(made, planned);
        for (const hex of Object.keys(planned.carried!)) dated.push([hex, when]);
      }
      await until(`the storage home's day ${day + 1} imported`, () => calm(made));
    }
  } finally {
    await earlier.stop();
  }
  for (const [hex, when] of dated) utimesSync(blobPath(made, hex), when / 1000, when / 1000);
  upgrade(made);
  fillPart(made, 0.5);
  const db = openHome(openHomeFolder(made), "migrate");
  try {
    db.commit((tx) => tx.tables.controls.set({ target: "kind:stored", reason: "the storage home counts when asked (count)", at_ms: Date.now(), by: "terminal" }));
  } finally {
    db.close();
  }
  return made;
}

async function shipStorageInto(target: string): Promise<void> {
  for (const planned of storageDay(2, Date.now() - 3_600_000)) {
    await ship(target, planned);
    if (target === root) shipped++;
    await settles("the home settled", () => calm(target), target);
  }
}


const SCALE = Object.fromEntries(Object.entries({ image: 94_816, scan: 28_000, faced: 11_254, cluster: 274, face: 14_754, person: 55 })
  .map(([kind, live]) => [kind, Number(process.env[`LIFESTREAM_SCALE_${kind.toUpperCase()}`] ?? live)])) as Record<string, number>;
const scaleHex = (what: string) => createHash("sha256").update(what).digest("hex");
const scalePhoto = (index: number) => scaleHex(`synthetic scale photo ${index}`);
const scaleCluster = (index: number) => scaleHex(`synthetic scale cluster ${index}`).slice(0, 16);
const T2010 = Date.UTC(2010, 0, 1);
const scaleAt = (index: number) => T2010 + index * 4_000_000;
function scaleFaces(index: number, round = 0): { face: string; at_ms: number; person: string; cluster: string }[] {
  const hex = scalePhoto(index);
  return (index % 3 === 0 ? [LEFT, RIGHT] : [LEFT]).map((box, at) => {
    const n = index * 2 + at;
    return { face: `${hex}:${box.join(",")}`, at_ms: scaleAt(index), person: n % 3 === 0 ? `person-${n % SCALE.person!}` : "", cluster: n % 3 === 0 ? "" : scaleCluster((n + round) % SCALE.cluster!) };
  });
}

function scaleConclusions(round: number): ReaderOutput[] {
  const named = new Map<string, { face: string; at_ms: number }[]>();
  const members = new Map<string, { face: string; at_ms: number }[]>();
  for (let index = 0; index < SCALE.faced!; index++) {
    for (const face of scaleFaces(index, index < 800 ? round : 0)) {
      const into = face.person !== "" ? named : members;
      const key = face.person !== "" ? face.person : face.cluster;
      into.set(key, [...into.get(key) ?? [], { face: face.face, at_ms: face.at_ms }]);
    }
  }
  const byKey = (left: { face: string }, right: { face: string }) => (left.face < right.face ? -1 : left.face > right.face ? 1 : 0);
  return [
    ...[...named].map(([slug, theirs]) => ({
      kind: "named", key: slug,
      content: { photos: theirs.sort((left, right) => right.at_ms - left.at_ms || byKey(left, right)).map((face) => ({ ...face, camera: true, crop: null, tier: "observe", size: 200 })), labels: [] },
    })),
    ...[...members].map(([id, held]) => ({
      kind: "cluster", key: id,
      content: {
        size: held.length, photos: new Set(held.map((face) => face.face.split(":")[0])).size, years: [2010, 2025], year_count: 10,
        faces: held.sort(byKey).map((face) => ({ ...face, crop: null })), outliers: [], chat_share: 0, suggested: [], evidence: { senders: [], labels: [] },
        rule: faces.GROUP_RULE,
      },
    })),
  ];
}

function scaleRoot(): string {
  const made = makeRoot("dashboard-scale-", {
    sources: { [WHATSAPP]: "dashboard-rows", [PEOPLE]: "people-home", [FACES]: "faces" },
    settings: { unit: HOME_UNIT },
  });
  mintPrincipal(openHomeFolder(made), { unit: "dashboard-macbook-pro-0001", scopes: ["read", "deliver"], sources: [PEOPLE], token: FACES_TOKEN, now_ms: 0 });
  const db = openHome(openHomeFolder(made), "migrate");
  const guards = { ...faces.facesConnector.kinds, ...people.peopleHome.kinds };
  const at = Date.now() - 86_400_000;
  const land = (source: string, rows: ReaderOutput[]) => {
    for (let from = 0; from < rows.length; from += 5_000) {
      db.commit((tx) => tx.records.land(tx.tables.runs.start({ kind: "import", subject: source, started_ms: at }), { id: `scale-${source}-${from}`, source, stated_ms: at }, rows.slice(from, from + 5_000), guards, { has: () => true }));
    }
  };
  land(FACES, Array.from({ length: SCALE.image! }, (_, index) => ({
    kind: "image", key: scalePhoto(index), content: { library: index % 5 !== 0, chat: index % 5 === 0 || index % 7 === 0, at_ms: scaleAt(index), senders: [], labels: [] },
  })));
  land(FACES, Array.from({ length: SCALE.scan! }, (_, index) => ({
    kind: "scan", key: scalePhoto(index), content: { pipeline: "0".repeat(64), status: "unreadable", width: null, height: null, faces: null, vectors: null },
  })));
  land(FACES, scaleConclusions(0));
  const since = "2026-10-01T00:00:00.000Z";
  land(PEOPLE, Array.from({ length: SCALE.person! }, (_, index) => ({
    kind: "person", key: `person-${index}`,
    content: { type: "people.person", slug: `person-${index}`, name: `Person ${index}`, handles: [{ kind: "name", value: `Person ${index}`, by: "subject", since }], excluded: [], merged_into: null },
  })));
  const faceKeys = Array.from({ length: SCALE.faced! }, (_, index) => scaleFaces(index)).flat();
  land(PEOPLE, faceKeys.slice(0, SCALE.face!).map((face, index) => ({
    kind: "face", key: face.face, content: face.person !== "" ? { is: face.person } : { is_not: [`person-${index % SCALE.person!}`] },
  })));
  db.close();
  return made;
}

async function scaleDelivery(round: number): Promise<number> {
  const lines: string[] = [];
  const first = SCALE.scan! + (round - 1) * 2_000;
  for (let index = first; index < first + 2_000 && index < SCALE.image!; index++) {
    lines.push(JSON.stringify({ content: { faces: null, height: null, pipeline: "0".repeat(64), status: "unreadable", vectors: null, width: null }, key: scalePhoto(index), kind: "scan" }));
  }
  for (const row of scaleConclusions(round)) lines.push(JSON.stringify({ content: row.content, key: row.key, kind: row.kind }));
  await shipFiles(root, FACES, Date.now(), { "faces.ndjson": Buffer.from(`${lines.join("\n")}\n`) });
  return lines.length;
}

const MODE = process.argv[2] === "faces" ? "faces" : process.argv[2] === "scale" ? "scale" : process.argv[2] === "storage" ? "storage" : "base";
const tokens = MODE === "base" ? TOKENS : { ...TOKENS, dashboard: FACES_TOKEN };

let shipped = 0;
let snapCloned = false;
const DERIVED = ["search", "people", "places", "privacy", "faces", "pictures", "stored"] as const;
const HOME_OPTIONS = { registry: REGISTRY, log: () => undefined, tickMs: TICK_MS, lookMs: LOOK_MS };

function pidLive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function withSnapLock<T>(lock: string, work: () => Promise<T>): Promise<T> {
  const pidFile = join(lock, "pid");
  for (;;) {
    try {
      mkdirSync(lock);
      writeFileSync(pidFile, String(process.pid));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const holder = Number(readFileSync(pidFile, "utf8").trim());
        if (holder > 0 && !pidLive(holder)) rmSync(lock, { recursive: true, force: true });
      } catch {
      }
      await new Promise((done) => setTimeout(done, 40));
    }
  }
  try {
    return await work();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

async function openSnap(name: string, prefix: string, makeFn: () => string | Promise<string>, seedFn: (target: string) => Promise<void>): Promise<{ root: string; home: Home }> {
  const dist = process.env.LIFESTREAM_TEST_DIST;
  const machineDir = process.env.LIFESTREAM_MACHINE_DIR!;
  if (dist !== undefined) {
    const snap = join(dist, `dashboard-${name}-snapshot-v3`);
    if (!existsSync(snap)) {
      await withSnapLock(`${snap}.lock`, async () => {
        if (existsSync(snap)) return;
        const built = await makeFn();
        const seeded = await startHome(built, HOME_OPTIONS);
        try {
          await seedFn(built);
        } finally {
          await seeded.stop();
        }
        for (const extra of ["home.lock", "door", "run"]) rmSync(join(built, extra), { recursive: true, force: true });
        const staged = mkdtempSync(join(dist, ".dashboard-snap-"));
        try {
          cpSync(built, join(staged, "root"), { recursive: true, mode: constants.COPYFILE_FICLONE });
          mkdirSync(join(staged, "machine"), { recursive: true });
          for (const sub of DERIVED) {
            const from = join(machineDir, sub);
            if (existsSync(from)) cpSync(from, join(staged, "machine", sub), { recursive: true, mode: constants.COPYFILE_FICLONE });
          }
          renameSync(staged, snap);
        } catch {
          rmSync(staged, { recursive: true, force: true });
        }
        rmSync(built, { recursive: true, force: true });
      });
    }
    if (existsSync(snap)) {
      const cloned = mkdtempSync(join(tmpdir(), prefix));
      cpSync(join(snap, "root"), cloned, { recursive: true, mode: constants.COPYFILE_FICLONE });
      for (const sub of DERIVED) {
        const dest = join(machineDir, sub);
        rmSync(dest, { recursive: true, force: true });
        const from = join(snap, "machine", sub);
        if (existsSync(from)) cpSync(from, dest, { recursive: true, mode: constants.COPYFILE_FICLONE });
      }
      snapCloned = true;
      shipped = readHome(cloned, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get() as number);
      const started = await startHome(cloned, HOME_OPTIONS);
      return { root: cloned, home: started };
    }
  }
  const built = await makeFn();
  const started = await startHome(built, HOME_OPTIONS);
  return { root: built, home: started };
}

const openedSnap = MODE === "base" ? await openSnap("base", "dashboard-door-", baseRoot, shipBaseInto)
  : MODE === "faces" ? await openSnap("faces", "dashboard-faces-", facesRoot, shipFacesInto)
  : MODE === "storage" ? await openSnap("storage", "dashboard-storage-", storageRoot, shipStorageInto) : null;
const root = openedSnap !== null ? openedSnap.root : scaleRoot();
const home: Home = openedSnap !== null ? openedSnap.home : await startHome(root, HOME_OPTIONS);
const send = async (planned: Planned): Promise<void> => {
  await ship(root, planned);
  shipped++;
  await settles("the home settled", () => (MODE === "base" ? settled(root, shipped) : calm()));
};
function busy(at = root): number {
  return readHome(at, (db) => db.prepare(`SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')
    AND NOT (kind = 'stored' AND EXISTS (SELECT 1 FROM controls WHERE target = 'kind:stored'))`).pluck().get() as number);
}
async function settles(what: string, ready: () => boolean, at = root): Promise<void> {
  let failed: { kind: string; key: string; error: string } | undefined;
  await until(what, () => {
    failed = readHome(at, (db) => db.prepare("SELECT kind, key, error FROM jobs WHERE state = 'queued' AND error IS NOT NULL AND not_before_ms > ?")
      .get(Date.now())) as typeof failed;
    return failed !== undefined || ready();
  });
  if (failed !== undefined) throw new Error(`never: ${what}, the ${failed.kind} job of ${failed.key} failed and waits its back-off: ${failed.error}`);
}
function calm(at = root): boolean {
  const folder = openHomeFolder(at);
  let sealed = 0;
  for (const source of lanes(folder)) {
    for (const name of deliveriesOf(folder, source)) if (manifestOf(folder, deliveryDirectory(folder, source, name)).exists()) sealed++;
  }
  return busy(at) === 0 && readHome(at, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get() as number) === sealed;
}

if (MODE === "faces") {
  if (snapCloned) await settles("the faces home settled", calm);
  else await shipFacesInto(root);
} else if (MODE === "base") {
  if (snapCloned) await settles("the base home settled", calm);
  else await shipBaseInto(root);
} else if (MODE === "storage") {
  if (snapCloned) await settles("the storage home settled", calm);
  else await shipStorageInto(root);
}
else await settles("the scale home started", calm);

function baseRoot(): string {
  const made = makeRoot("dashboard-door-", {
    sources: { ...Object.fromEntries([WHATSAPP, CONTACTS, PEOPLE, LOCATION, MAIL, PHOTOS, CAMERAS].map((id) => [id, "dashboard-rows"])), [PLACES]: "places-home", [GOOGLE]: "google-place-names" },
    settings: { unit: HOME_UNIT },
  });
  for (const [unit, scopes, sources] of [["reader", ["read", "deliver"], [PEOPLE, PLACES, DEVICES]], ["device", ["deliver"], [WHATSAPP]]] as const) {
    mintPrincipal(openHomeFolder(made), { unit, kind: unit === "device" ? "mac" : null, scopes: [...scopes], sources: [...sources], token: TOKENS[unit], now_ms: 0 });
  }
  return made;
}

async function shipBaseInto(target: string): Promise<void> {
  const sent = mailRow("m1", at("11:00:00"), "[Gmail]/Trash", "Person A <person-a@example.com>", "Person C <person-c@example.com>", "Synthetic subject one");
  const received = mailRow("m2", at("11:30:00"), "[Gmail]/Spam", "Person C <person-c@example.com>", "Person A <person-a@example.com>", "Synthetic subject two");
  const now = Date.now();
  await ship(target, { source: CONTACTS, fetched_ms: now, rows: [card("Person A", "+15550000001", JPEG)] });
  await ship(target, { source: PEOPLE, fetched_ms: now, rows: [person] });
  await shipFiles(target, PLACES, now, statements(ownerPlaces), OWNER_FACTS);
  await shipFiles(target, GOOGLE, now, statements(googleNames), OWNER_FACTS);
  await ship(target, { source: WHATSAPP, fetched_ms: now, rows: [
    groupShell,
    wa("A1", A, at("08:00:00"), "synthetic hello one"), wa("A2", A, at("08:05:00"), "synthetic reply two", { me: true }),
    wa("G1", GROUP, at("10:00:00"), "synthetic group line one", { member: B }), wa("G2", GROUP, at("10:02:00"), "synthetic group line two", { member: C }),
    wa("G3", GROUP, at("10:03:00"), "synthetic group line three", { me: true }),
  ] });
  await ship(target, { source: LOCATION, fetched_ms: now, rows: fixes() });
  await ship(target, { source: MAIL, fetched_ms: now, rows: [sent.row, received.row], carried: Object.fromEntries([sent.carried, received.carried]) });
  await ship(target, { source: PHOTOS, fetched_ms: now, rows: [jpeg.row, svg.row], carried: Object.fromEntries([jpeg.carried, svg.carried]) });
  await ship(target, { source: PHOTOS, fetched_ms: now + 1, rows: located.map((each) => each.row), carried: Object.fromEntries(located.flatMap((each) => each.carried)) });
  await ship(target, { source: CAMERAS, fetched_ms: now, rows: [...cameraCounts, ...located.map((each) => each.camera)] });
  const count = 10;
  if (target === root) shipped += count;
  await until("the day rendered", () => settled(target, count) && readdirSync(join(target, "days")).includes(`${DAY}.day.json`) && busy(target) === 0);
  await askHome(testSocket(target), "pause", ["kind:repair", "--reason", "held for /private/tmp/dashboard-door-held/repair"]);
}

const standInMaker: Maker = async ({ from, to, type }) => {
  if (type.startsWith("video/")) return { cannot: "the stand-in makes no poster" };
  copyFileSync(from, to);
  return { made: type === "image/png" ? "png" : "jpeg" };
};

const door: Door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: REGISTRY, maker: standInMaker, lookMs: LOOK_MS });
const say = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
say({ ready: true, url: `http://127.0.0.1:${door.port}`, tokens, root, day: DAY, pid: process.pid,
  jpeg: JPEG.toString("base64"), ...(MODE === "faces" ? { faces: FACES_LIBRARY } : {}),
  ...(MODE === "storage" ? { storage: ((truth) => Object.fromEntries(Object.entries(STORAGE).map(([connector, source]) =>
    [connector, { source, text: truth.text[source] ?? 0, files: truth.files[source] ?? 0 }])))(recount(root, effective(root).settings.day)) } : {}) });

const commands: Record<string, (command: Record<string, unknown>) => Promise<unknown>> = {
  async ["faces-delivery"](command) {
    const lines = await scaleDelivery(Number(command.round ?? 1));
    await settles("the delivery imported", calm);
    return { lines };
  },
  async ["faces-people"]() {
    await shipFacesPeople();
    return { shipped };
  },
  async settle() {
    await settles("the home settled", calm);
    return { calm: true };
  },
  async pause(command) {
    return askHome(testSocket(root), "pause", [String(command.target), "--reason", "a test"]);
  },
  async resume(command) {
    return askHome(testSocket(root), "resume", [String(command.target)]);
  },
  async count() {
    await askHome(testSocket(root), "resume", ["kind:stored"]);
    await settles("the storage home counted", () => complete(root) && calm());
    return { counted: true };
  },
  async unnamed() {
    await send({ source: LOCATION, fetched_ms: Date.now(), rows: unnamedFixes() });
    await settles("the day rendered again and Places prepared", calm);
    return { shipped };
  },
  async message(command) {
    await send({ source: WHATSAPP, fetched_ms: Date.now(), rows: [wa(String(command.key), A, Number(command.at), String(command.text))] });
    await settles("the day rendered again", () => busy() === 0);
    return { shipped };
  },
  async media(command) {
    const when = Number(command.at);
    const photo = waFile("M1", when, 1, typeof command.jpeg === "string" ? Buffer.from(command.jpeg, "base64") : JPEG);
    const voice = waFile("M2", when + 60_000, 3, OGG, { seconds: 14, parent: "A1", me: true });
    await ship(root, { source: WHATSAPP, fetched_ms: Date.now(), rows: [photo.row, voice.row], carried: Object.fromEntries([photo.carried, voice.carried]) });
    shipped++;
    const [photoHash, voiceHash] = [`sha256:${photo.carried[0]}`, `sha256:${voice.carried[0]}`];
    const made = (item: string, prompt: string) => readHome(root, (db) => db.prepare("SELECT content FROM enrichments WHERE family = ? AND item = ? AND prompt = ? AND state = 'done'")
      .pluck().get(MESSAGES_FAMILY, item, prompt)) as string | undefined;
    const owed = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM dirty_days").pluck().get()) as number;
    await settles("the photo captioned, the voice note transcribed, and the day rendered again after them",
      () => made(photoHash, CAPTION_PROMPT) !== undefined && made(voiceHash, TRANSCRIPT_PROMPT) !== undefined && owed() === 0 && calm());
    const { caption } = JSON.parse(made(photoHash, CAPTION_PROMPT)!) as { caption: string };
    const { transcript } = JSON.parse(made(voiceHash, TRANSCRIPT_PROMPT)!) as { transcript: string };
    return { photo: photoHash, voice: voiceHash, ogg: OGG.toString("base64"), caption, transcript };
  },
  async contact(command) {
    await send({ source: CONTACTS, fetched_ms: Date.now(), rows: [{ ...card(String(command.name), String(command.phone)), key: String(command.key) }] });
    await settles("the labels stored and the days rendered", () => busy() === 0);
    return { shipped };
  },
  async stop() {
    await door.close();
    await home.stop();
    removeRoot(root);
    return { stopped: true };
  },
};

for await (const line of createInterface({ input: process.stdin })) {
  if (line.trim() === "") continue;
  const command = JSON.parse(line) as Record<string, unknown>;
  try {
    say({ cmd: command.cmd, ok: true, value: await commands[String(command.cmd)]!(command) });
  } catch (error) {
    say({ cmd: command.cmd, ok: false, error: (error as Error).message });
  }
  if (command.cmd === "stop") process.exit(0);
}
