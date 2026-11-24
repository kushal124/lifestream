import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { crc32, gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { imports as declared } from "@lifestreamprotocol/connect";
import { openHome, openHomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import type { ImportReport } from "./imports-report.js";
import { readConnectors } from "./connectors.js";
import { startHome } from "./home.js";
import { selfCheckHere } from "./release.js";
import { dayWords } from "./stream-words.js";
import { homeRegistryModule } from "./programs.js";
import { mintPrincipal } from "./principals.js";
import { effective } from "./settings.js";
import { ask, askHome, type HomeSocket } from "./socket.js";
import type { Receipt } from "./sweep.js";
import {
  artifact,
  ChildHome,
  FAKE_ROUTE,
  FAKES,
  hex,
  makeRoot,
  OWN_SOURCES,
  readHome,
  readLedger,
  removeRoot,
  TICK_MS,
  until,
} from "./test/harness-root.js";
import { ship, shipFiles } from "./test/harness-deliveries.js";
import { doorHere } from "./test/harness-door.js";
import { startHere } from "./test/harness-home.js";
import { statusOf, streamsOf } from "./test/harness-status.js";
import { editSettings, testSocket } from "./test/folder.js";
import { filesUnder } from "./test/erasures.js";
import { acquisitionBundle, DEVICE, TEST_CODE, zip } from "./test/support.js";
import { basicInstant } from "./inbox.js";
import { DAYS, HELD, LISTING, type HeldImport, type KeptListing, type Tally } from "./imports.js";
import type { Stated } from "./stated.js";
import importsRegistry from "./test/imports-registry.js";
import { photosComing, photosStart } from "./status.js";

const REGISTRY = new URL("./test/imports-registry.ts", import.meta.url);
const MAC = "macbook-pro-0001";
const UPLOAD = `upload:local:${MAC}`;
const A = "person-a@example.com";
const B = "person-b@example.com";
const C = "person-c@example.com";
const SEARCH = `google-search:${A}:export`;
const YOUTUBE = `youtube:${A}:export`;
const GMAIL = `gmail:${A}:cloud`;
const CALENDAR = `google-calendar:${A}:export`;
const CONTACTS = `google-contacts:${A}:export`;
const PHOTOS = `google-photos:${A}:export`;
const STAMP = "20260814T091500Z";
const HOUR_MS = 3_600_000;
const STAMP_C = "20260901T080000Z";
const NEWER = "20260920T100000Z";
const BACKUP = "00008140001A2B3C4D5E6F701:2026-08-28T12:04:00Z";
const T0 = Date.parse("2026-10-27T08:00:00Z");
const DAY_MS = 24 * 60 * 60_000;
const GIB = 1024 ** 3;

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) removeRoot(root);
});

const crlf = (lines: readonly string[]): Buffer => Buffer.from(`${lines.join("\r\n")}\r\n`);
const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, null, 2));
const instant = (stamp: string): string => `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`;

const activity = (header: string, entries: readonly { title: string; time: string }[]): Buffer =>
  json(entries.map((entry) => ({ header, title: entry.title, time: entry.time, products: [header] })));
const MBOX = crlf([
  "From 1790000000000000201@xxx Sun Feb 01 08:00:00 +0000 2016",
  "X-GM-THRID: 1790000000000000201",
  "X-Gmail-Labels: Inbox",
  `From: Person B <${B}>`,
  `To: ${A}`,
  "Subject: a synthetic message",
  "Date: Mon, 1 Feb 2016 08:00:00 +0000",
  "",
  "A synthetic body.",
  "",
  "From 1790000000000000202@xxx Mon Feb 01 09:00:00 +0000 2016",
  "X-GM-THRID: 1790000000000000201",
  "X-Gmail-Labels: Sent",
  `From: ${A}`,
  "Subject: Re: a synthetic message",
  "Date: Mon, 1 Feb 2016 09:00:00 +0000",
  "",
  "A synthetic reply.",
]);
const vevent = (uid: string, day: string, description?: string): string[] => [
  "BEGIN:VEVENT", `DTSTART:${day}T090000Z`, `DTEND:${day}T100000Z`, "DTSTAMP:20260801T000000Z", `UID:${uid}@google.com`, "SUMMARY:A synthetic event",
  ...(description === undefined ? [] : [`DESCRIPTION:${description}`]), "END:VEVENT",
];
const ics = (account: string, events: readonly string[][]): Buffer => crlf([
  "BEGIN:VCALENDAR", "PRODID:-//Google Inc//Google Calendar 70.9054//EN", "VERSION:2.0", `X-WR-CALNAME:${account}`, ...events.flat(), "END:VCALENDAR",
]);
const VCARD = crlf(["BEGIN:VCARD", "VERSION:3.0", "FN:Person D", "TEL:+15550000004", "END:VCARD"]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);
const sidecar = (title: string): Buffer => json({ title, photoTakenTime: { timestamp: "1465545600" } });
const photo = (name: string): Buffer => Buffer.concat([JPEG, Buffer.from(name)]);
const PROFILE = json({ displayName: "Person A", emails: [{ value: A }] });
const YOUTUBE_JSON = activity("YouTube", [{ title: "Watched a synthetic video", time: "2026-08-01T20:00:00.000Z" }]);
const EVENTS_C = 6_000;
const CALENDAR_C = ics(C, Array.from({ length: EVENTS_C }, (_, index) => vevent(`event-c-${index}`, "20260901", randomBytes(54).toString("base64"))));

const ZIP1: [string, Buffer][] = [
  ["Takeout/archive_browser.html", Buffer.from("<html><body>A synthetic archive browser</body></html>")],
  ["Takeout/My Activity/Search/MyActivity.json", activity("Search", [{ title: "Searched for a synthetic query", time: "2017-03-05T10:00:00.000Z" }, { title: "Visited a synthetic page", time: "2017-03-05T11:00:00.000Z" }])],
  ["Takeout/Mail/All mail Including Spam and Trash.mbox", MBOX],
  ["Takeout/Mail/User Settings/Labels.json", json([{ name: "Synthetic" }])],
  [`Takeout/Calendar/${A}.ics`, ics(A, [vevent("event-0001", "20180501")])],
  ["Takeout/Contacts/My Contacts/My Contacts.vcf", VCARD],
];
const ZIP2: [string, Buffer][] = [
  ["Takeout/Profile/Profile.json", PROFILE],
  ["Takeout/Keep/A synthetic note.json", json({ title: "A synthetic note", textContent: "synthetic" })],
  ["Takeout/Google Photos/Photos from 2016/IMG_0001.jpg", photo("IMG_0001.jpg")],
  ["Takeout/Google Photos/Photos from 2016/IMG_0002.jpg.supplemental-metadata.json", sidecar("IMG_0002.jpg")],
];
const ZIP3: [string, Buffer][] = [
  ["Takeout/Google Photos/Photos from 2016/IMG_0002.jpg", photo("IMG_0002.jpg")],
  ["Takeout/Google Photos/Photos from 2016/IMG_0001.jpg.supplemental-metadata.json", sidecar("IMG_0001.jpg")],
  ["Takeout/My Activity/YouTube/MyActivity.json", YOUTUBE_JSON],
  ["Takeout/Calendar/photo.jpg", JPEG],
];
const ZIP4: [string, Buffer][] = [
  ["Takeout/My Activity/YouTube/MyActivity.html", Buffer.from('<html><head><meta charset="UTF-8"><title>My Activity</title></head><body><div class="mdl-grid">' +
    '<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">' +
    '<div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">YouTube<br></p></div>' +
    '<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Watched another synthetic video<br>Aug 1, 2026, 9:00:00\u202fPM UTC</div>' +
    '<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1 mdl-typography--text-right"></div>' +
    '<div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption"><b>Products:</b><br>&emsp;YouTube<br></div>' +
    '<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">' +
    '<div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">YouTube<br></p></div>' +
    '<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">Watched a synthetic video elsewhere<br>Aug 1, 2026, 1:00:00\u202fPM PDT</div>' +
    "</div></div></div></body></html>")],
];
const NEWER_ZIP: [string, Buffer][] = [["Takeout/My Activity/YouTube/MyActivity.json", YOUTUBE_JSON]];
const FOLDER: [string, Buffer][] = [
  ["Takeout/Profile/Profile.json", PROFILE],
  ["Takeout/Keep/A synthetic note.json", json({ title: "A synthetic note", textContent: "synthetic" })],
];

function tgz(members: readonly [string, Buffer][]): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, bytes] of members) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write(`${Math.floor(T0 / 1000).toString(8).padStart(11, "0")}\0`, 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

function importBundle(seal: number, fetched_ms: number, kind: string, files: readonly [string, Buffer][], lost?: { items: number; what: string }[]) {
  const index = Buffer.from(`${JSON.stringify({ format: "org.lifestreamprotocol.upload/1", files: files.map(([path]) => ({ path })) })}\n`);
  return acquisitionBundle({
    source: UPLOAD, feeder: "import-mac", fetched_ms,
    files: [["upload.json", index], ...files.map(([path, bytes]) => [`files/${path}`, bytes] as [string, Buffer])],
    facts: { import: { kind }, history: true } as never,
    custody: { [UPLOAD]: { seal, ...(lost === undefined ? {} : { lost }) } },
    manifest: (manifest) => ({ ...manifest, facts: Object.fromEntries(Object.entries(manifest.facts as Record<string, unknown>).filter(([key]) => key !== "snapshot_taken_at")) }),
  });
}

interface Running {
  root: string;
  url: string;
  sock: HomeSocket;
  ahead(ms: number): void;
  ship(bundle: ReturnType<typeof importBundle>): Promise<void>;
  exchange(): Promise<Record<string, { received: number; imported: number }>>;
  stop(): Promise<void>;
}

function folderWithPass(prefix: string, sources: Record<string, string> = {}): { root: string; token: string } {
  const root = makeRoot(prefix, { sources: { [UPLOAD]: "upload", ...sources } });
  roots.push(root);
  const { token } = mintPrincipal(openHomeFolder(root), { unit: MAC, kind: "mac", scopes: ["deliver"], sources: [UPLOAD], now_ms: T0 });
  return { root, token };
}

async function running(prefix: string, sources: Record<string, string> = {}): Promise<Running & { token: string }> {
  const { root, token } = folderWithPass(prefix, sources);
  return { ...(await opened(root, token)), token };
}

function mac(url: string, token: string) {
  const headers = { authorization: `Bearer ${token}`, ...DEVICE.mac };
  return {
    async ship(bundle: ReturnType<typeof importBundle>) {
      const response = await fetch(`${url}${bundle.path}`, { method: "PUT", headers, body: bundle.bytes });
      expect(response.status, await response.clone().text()).toBe(201);
    },
    async exchange() {
      const response = await fetch(`${url}/v1/exchange`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" });
      return ((await response.json()) as { sources: Record<string, { received: number; imported: number }> }).sources;
    },
  };
}

async function opened(root: string, token: string): Promise<Running> {
  const door = await doorHere(root);
  let offset = 0;
  const home = await startHere(root, { registry: REGISTRY, tickMs: TICK_MS, slot: null, log: () => undefined, clock: () => Date.now() + offset });
  return {
    root, url: door.url, sock: testSocket(root), ...mac(door.url, token),
    ahead: (ms) => void (offset = ms),
    async stop() {
      await home.stop();
      await door.stop();
    },
  };
}

type DeliveryState = { id: string; source: string; state: string; refused: number; error: string | null; read_by: string | null };
const deliveriesOf = (root: string): DeliveryState[] =>
  readHome(root, (db) => db.prepare("SELECT id, source, state, refused, error, read_by FROM deliveries ORDER BY id, source").all()) as DeliveryState[];
const rowsOf = (root: string, id: string): string[] => deliveriesOf(root).filter((row) => row.id === id).map((row) => row.source);
const settled = (root: string, count: number) => {
  const rows = deliveriesOf(root);
  return new Set(rows.map((row) => row.id)).size >= count && rows.every((row) => row.state === "imported");
};
const heads = (root: string, source: string): { kind: string; key: string }[] =>
  readHome(root, (db) => db.prepare("SELECT kind, key FROM heads WHERE source = ? AND version <> 'gone' ORDER BY kind, key").all(source)) as { kind: string; key: string }[];
const meta = (root: string, key: string): string | undefined => readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(key)) as string | undefined;
const listing = (root: string, id: string): KeptListing => JSON.parse(meta(root, `${LISTING}${id}`)!) as KeptListing;
const receiptOf = (root: string, id: string): Receipt | null => {
  const path = join(root, "inbox", ...id.split("/"), "swept.json");
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Receipt) : null;
};
const inInbox = (root: string, id: string, file: string): boolean => existsSync(join(root, "inbox", ...id.split("/"), "files", file));
const runsOf = (root: string, subject: string): number => readHome(root, (db) => db.prepare("SELECT count(*) FROM runs WHERE kind = 'import' AND subject = ?").pluck().get(subject)) as number;
const readsOf = (root: string, subject: string): number => readHome(root, (db) => db.prepare("SELECT count(*) FROM runs WHERE kind = 'import' AND subject = ? AND outcome = 'ok'").pluck().get(subject)) as number;
const sweeps = (root: string): number => readHome(root, (db) => db.prepare("SELECT count(*) FROM events WHERE kind = 'sweep'").pluck().get()) as number;
async function sweep(root: string, sock: HomeSocket): Promise<void> {
  const before = sweeps(root);
  await askHome(sock, "sweep", []);
  await until("the sweep ran", () => sweeps(root) > before);
}
const reportOf = (root: string, room: { free_bytes?: number; stated?: Stated } = {}) => readHome(root, (db) => {
  const { settings } = effective(root);
  const report = readConnectors(db, {
    folder: openHomeFolder(root), now_ms: Date.now(), settings,
    registry: importsRegistry(), machine: process.env.LIFESTREAM_MACHINE_DIR!, sites: null, present: [], needs: [],
    free_bytes: room.free_bytes ?? Number.MAX_SAFE_INTEGER, stated: room.stated ?? null, photos: photosComing(db, photosStart(settings, importsRegistry().connectors, Date.now())),
  });
  return { imports: report.imports, disk: report.disk, needs: report.needs, connectors: report.connectors };
});
const importsOf = (root: string, room?: { free_bytes?: number }): ImportReport[] => reportOf(root, room).imports;
const heldOf = (root: string, kind = "google-takeout", room?: { free_bytes?: number }): ImportReport["held"] => importsOf(root, room).find((each) => each.kind === kind)!.held;
const importNeeds = (root: string): string[] => reportOf(root).needs.map((need) => need.id).filter((id) => id.startsWith("import:"));
const products = (held: ImportReport["held"][number]) => Object.fromEntries(held.products.map((product) => [product.id, [product.state, product.line]]));
const takeoutKind = () => declared.importKinds(importsRegistry().connectors, importsRegistry().readers).find((each) => each.id === "google-takeout")!;
const held = (root: string): Record<string, HeldImport> => JSON.parse(meta(root, HELD) ?? "{}") as Record<string, HeldImport>;
const idOf = (root: string, stamp: string, account: string | null = A): string | undefined =>
  Object.entries(held(root)).find(([, each]) => each.stamp === stamp && each.account === account)?.[0];
const importOf = (root: string, stamp: string, room?: { free_bytes?: number; stated?: Stated }, account: string | null = A): ImportReport["held"][number] => {
  const id = idOf(root, stamp, account);
  return reportOf(root, room).imports.find((each) => each.kind === "google-takeout")!.held.find((each) => each.id === id)!;
};
async function answer(root: string, sock: HomeSocket, stamp: string, account: string): Promise<void> {
  await until("the stamp asked whose", () => idOf(root, stamp, null) !== undefined);
  await askHome(sock, "act", [`import:${idOf(root, stamp, null)!}:whose`, "choose", account]);
}

const NOTES = "apple-notes:local:device-a";
const NO_ROWS = "no-rows";
async function partWay(prefix: string) {
  const root = makeRoot(prefix, { sources: { [NOTES]: "fake-rows" } });
  roots.push(root);
  const id = `${NOTES}/${basicInstant(new Date(T0).toISOString())}`;
  const IMPORT = "b000000000000001";
  const db = openHome(openHomeFolder(root), "migrate");
  db.commit((tx) => {
    tx.tables.meta.set(HELD, JSON.stringify({ [IMPORT]: { kind: NO_ROWS, account: "local", stamp: null, time_ms: Date.parse(instant(STAMP)), at_ms: T0, answered: true, deliveries: [id] } satisfies HeldImport }));
    tx.tables.meta.set(`import-of:${id}`, IMPORT);
    tx.tables.meta.set(`${LISTING}${id}`, JSON.stringify({ kind: NO_ROWS, hash: "synthetic", files: [{ path: "rows.ndjson", bytes: 1 }], products: [],
      routes: [{ of: "apple-notes", members: "rows.ndjson", product: "apple-notes", copy: "device-a", connector: "fake-rows", files: ["rows.ndjson"] }] } satisfies KeptListing));
  });
  db.close();
  const home = await startHere(root, { tickMs: TICK_MS, log: () => undefined });
  const span = () => JSON.parse(meta(root, `import:${IMPORT}:span`) ?? "null") as { from: string; to: string } | null;
  return { root, id, sock: testSocket(root), home, hold: join(root, "hold"), span };
}

describe("imports at the home", () => {
  it("routes each file by its listing, reads it in place, asks once whose the parts naming no account are, voids a file in already, lets a file go once read whole or let go, and reports it all", async () => {
    const home = await running("lifestream-imports-", { [SEARCH]: "google-my-activity" });
    const { root } = home;
    const ofStamp = (stamp: string, account: string | null) => Object.entries(held(root)).find(([, each]) => each.stamp === stamp && each.account === account)?.[0];
    await askHome(home.sock, "pause", [`import:${SEARCH}`, "--reason", "held by the test"]);
    const zip1 = importBundle(1, T0, "google-takeout", [[`takeout-${STAMP}-1-001.zip`, zip(ZIP1)]]);
    await home.ship(zip1);
    await until("the first zip's other sources imported", () => deliveriesOf(root).filter((row) => row.id === zip1.id && row.source !== SEARCH).every((row) => row.state === "imported") && rowsOf(root, zip1.id).length === 5);
    const paused = await home.exchange();
    await askHome(home.sock, "resume", [`import:${SEARCH}`]);
    await until("the first zip imported", () => settled(root, 1));
    const after = await home.exchange();
    expect({ held: paused[UPLOAD], after: after[UPLOAD] }).toMatchObject({ held: { received: 1 }, after: { received: 1, imported: 1 } });

    const IMPORT = ofStamp(STAMP, A)!;
    expect(held(root)[IMPORT]).toMatchObject({ kind: "google-takeout", account: A, stamp: STAMP, time_ms: Date.parse(instant(STAMP)), deliveries: [zip1.id] });
    expect(rowsOf(root, zip1.id)).toEqual([CONTACTS, GMAIL, CALENDAR, SEARCH, UPLOAD].sort());
    expect(listing(root, zip1.id)).toMatchObject({ kind: "google-takeout", hash: declared.listingHash(takeoutKind()) });
    expect(heads(root, SEARCH)).toHaveLength(2);
    expect(heads(root, GMAIL).map((head) => head.kind)).toEqual(["chat", "mailmsg", "mailmsg"]);
    expect(heads(root, CALENDAR)).toHaveLength(1);
    expect(heads(root, CONTACTS)).toHaveLength(1);
    expect(heads(root, UPLOAD)).toEqual([]);
    const zipHash = createHash("sha256").update(zip(ZIP1)).digest("hex");
    expect(existsSync(join(root, "blobs", zipHash.slice(0, 2), zipHash.slice(2, 4), zipHash))).toBe(false);
    expect(listing(root, zip1.id).files).toEqual([{ path: `takeout-${STAMP}-1-001.zip`, bytes: zip(ZIP1).length }]);

    const again = importBundle(2, T0 + 30_000, "google-takeout", [[`takeout-${STAMP}-1-001.zip`, zip(ZIP1)]]);
    await home.ship(again);
    await until("the file sent again voided", () => meta(root, `import-void:${again.id}`) !== undefined && rowsOf(root, again.id).every((source) => source === UPLOAD));
    expect([rowsOf(root, again.id), held(root)[IMPORT]!.deliveries]).toEqual([[UPLOAD], [zip1.id]]);

    const zip2 = importBundle(3, T0 + 60_000, "google-takeout", [[`takeout-${STAMP}-2-001.zip`, zip(ZIP2)]]);
    await home.ship(zip2);
    await until("the second zip imported", () => settled(root, 3));
    expect(rowsOf(root, zip2.id)).toEqual([PHOTOS, UPLOAD]);
    expect(deliveriesOf(root).find((row) => row.id === zip2.id && row.source === PHOTOS)?.refused).toBe(2);
    expect(held(root)[IMPORT]!.deliveries).toEqual([zip1.id, zip2.id]);

    const zip4 = importBundle(4, T0 + 120_000, "google-takeout", [[`takeout-${STAMP}-4-001.zip`, zip(ZIP4)]]);
    await home.ship(zip4);
    const whose = () => importNeeds(root).filter((need) => need.endsWith(":whose"));
    await until("the fourth zip asked whose", () => ofStamp(STAMP, null) !== undefined && whose().length === 1);
    const ASKED = ofStamp(STAMP, null)!;
    expect([whose(), rowsOf(root, zip4.id)]).toEqual([[`import:${ASKED}:whose`], [UPLOAD]]);
    const asked = heldOf(root).find((each) => each.id === ASKED)!;
    expect([asked.ask?.words, asked.ask?.choices, asked.products.map((product) => product.state)]).toEqual([
      `Whose Google account is this Takeout from ${dayWords(Date.parse(instant(STAMP)), Date.now(), effective(root).settings.day)}?`, [A], ["asked"]]);
    await askHome(home.sock, "act", [`import:${ASKED}:whose`, "choose", A]);
    await until("the fourth zip imported", () => rowsOf(root, zip4.id).includes(YOUTUBE) && settled(root, 4));
    expect([held(root)[ASKED], held(root)[IMPORT]!.deliveries, held(root)[IMPORT]!.answered]).toEqual([undefined, [zip1.id, zip2.id, zip4.id], true]);
    expect(deliveriesOf(root).find((row) => row.id === zip4.id && row.source === YOUTUBE)?.refused).toBe(1);
    expect(heads(root, YOUTUBE)).toHaveLength(1);
    const zip3 = importBundle(5, T0 + 180_000, "google-takeout", [[`takeout-${STAMP}-3-001.zip`, zip(ZIP3)]]);
    await home.ship(zip3);
    await until("the fourth zip's YouTube and the second's Photos read again", () => runsOf(root, `${YOUTUBE} ${zip4.id}`) === 2 && readsOf(root, `${PHOTOS} ${zip2.id}`) === 2 && settled(root, 5));
    expect([importNeeds(root).filter((need) => need.endsWith(":whose")), held(root)[IMPORT]!.deliveries.at(-1)]).toEqual([[], zip3.id]);
    expect(heads(root, YOUTUBE)).toHaveLength(2);
    expect([heads(root, PHOTOS).length, deliveriesOf(root).find((row) => row.id === zip2.id && row.source === PHOTOS)?.refused]).toEqual([2, 0]);
    const kept = (JSON.parse(meta(root, `${DAYS}${zip4.id}|${YOUTUBE}`)!) as Tally).refused;
    expect(kept).toEqual({ count: 1, members: { [`takeout-${STAMP}-4-001.zip/${ZIP4[0]![0]}`]: 1 } });
    expect((JSON.parse(meta(root, `${DAYS}${zip2.id}|${PHOTOS}`)!) as Tally).refused).toBeUndefined();
    expect(listing(root, zip3.id).files).toEqual([{ path: `takeout-${STAMP}-3-001.zip`, bytes: zip(ZIP3).length, unclaimed: 1 }]);
    expect([zip4, zip3].map((each) => listing(root, each.id).products.find((product) => product.id === "my-activity")?.activity)).toEqual(["html", "json"]);
    const reading = heldOf(root).find((each) => each.id === IMPORT)!;
    expect([reading.health.state, reading.health.reason, reading.line, products(reading)["my-activity"]]).toEqual(
      ["needs-you", "import", "Imported · 2016–2026 · 1\u00a0file couldn’t be read", ["partly", "Google activity · 4\u00a0entries · 1\u00a0file couldn’t be read"]]);
    expect(importNeeds(root)).toEqual([`import:${IMPORT}:refused`]);
    const low = heldOf(root, "google-takeout", { free_bytes: 3e9 }).find((each) => each.id === IMPORT)!;
    expect([low.health.state, low.line]).toEqual(["needs-you", reading.line]);

    const tarBytes = tgz([[`Takeout/Calendar/${C}.ics`, CALENDAR_C]]);
    expect(tarBytes.length).toBeGreaterThan(3 * 64 * 1024);
    const tar = importBundle(6, T0 + 240_000, "google-takeout", [[`takeout-${STAMP_C}-1-001.tgz`, tarBytes]]);
    await home.ship(tar);
    await until("the tar imported", () => settled(root, 6));
    expect(rowsOf(root, tar.id)).toEqual([`google-calendar:${C}:export`, UPLOAD].sort());
    expect(heads(root, `google-calendar:${C}:export`)).toHaveLength(EVENTS_C);

    const newerZip = importBundle(7, T0 + 360_000, "google-takeout", [[`takeout-${NEWER}-1-001.zip`, zip(NEWER_ZIP)]]);
    const folder = importBundle(8, T0 + 420_000, "google-takeout", FOLDER.map(([path, bytes]) => [`takeout-${NEWER}-2-001/${path}`, bytes] as [string, Buffer]));
    await home.ship(newerZip);
    await home.ship(folder);
    const refusedOf = () => Object.entries(held(root)).find(([, each]) => each.ended === true && each.deliveries.includes(folder.id))?.[0];
    await until("the newer zip asked whose, the folder refused whole", () => held(root)[ofStamp(NEWER, null) ?? ""]?.deliveries.length === 1 && refusedOf() !== undefined);
    expect([held(root)[refusedOf()!]!.refused, importNeeds(root).filter((need) => need.endsWith(":refused") && need.includes(refusedOf()!))]).toEqual(["Nothing Lifestream reads yet", [`import:${refusedOf()!}:refused`]]);
    expect(await askHome(home.sock, "act", [`import:${refusedOf()!}:refused`, "skip"])).toEqual({ acted: "skipped" });
    expect(refusedOf()).toBeUndefined();
    await answer(root, home.sock, NEWER, A);
    await until("the newer zip imported", () => rowsOf(root, newerZip.id).includes(YOUTUBE) && settled(root, 8));
    expect(rowsOf(root, folder.id)).toEqual([UPLOAD]);

    await sweep(root, home.sock);
    const first = { zip1: receiptOf(root, zip1.id), again: receiptOf(root, again.id), zip2: receiptOf(root, zip2.id), zip3: receiptOf(root, zip3.id), zip4: receiptOf(root, zip4.id), tar: receiptOf(root, tar.id), newerZip: receiptOf(root, newerZip.id), folder: receiptOf(root, folder.id) };
    expect(first.zip1).toMatchObject({ done: true, removed: [`files/takeout-${STAMP}-1-001.zip`], kept: ["upload.json"] });
    expect(first.zip1!.copied).toEqual(ZIP1.map(([name]) => `members/files/takeout-${STAMP}-1-001.zip/${name}`).sort());
    expect(readFileSync(join(root, "inbox", ...zip1.id.split("/"), "members", "files", `takeout-${STAMP}-1-001.zip`, "Takeout", "Mail", "All mail Including Spam and Trash.mbox"))).toEqual(MBOX);
    expect([first.zip2, first.zip3, first.zip4, first.folder]).toEqual([null, null, null, null]);
    expect(first.tar).toMatchObject({ done: true, removed: [`files/takeout-${STAMP_C}-1-001.tgz`] });
    expect(first.newerZip).toMatchObject({ done: true, removed: [`files/takeout-${NEWER}-1-001.zip`] });
    expect([existsSync(join(root, "inbox", ...again.id.split("/"))), existsSync(join(root, "inbox", ...folder.id.split("/")))]).toEqual([false, false]);

    const html = heldOf(root).find((each) => each.id === IMPORT)!.files.find((file) => file.name === `takeout-${STAMP}-4-001.zip`)!;
    expect([html.state, html.words, html.acts.map((act) => act.do)]).toEqual(["kept", "Kept", ["let-go"]]);
    await askHome(home.sock, "act", [`import:${IMPORT}:file:${html.id}`, "let-go"]);
    const letGo = heldOf(root).find((each) => each.id === IMPORT)!;
    expect([products(letGo)["my-activity"], letGo.health.state, letGo.line, importNeeds(root)]).toEqual([
      ["skipped", "Google activity · 4\u00a0entries · 1\u00a0file skipped"], "ok", "Imported · 2016–2026", []]);
    await sweep(root, home.sock);
    expect(receiptOf(root, zip4.id)).toMatchObject({ done: true, removed: [`files/takeout-${STAMP}-4-001.zip`] });
    expect([inInbox(root, zip2.id, `takeout-${STAMP}-2-001.zip`), inInbox(root, zip3.id, `takeout-${STAMP}-3-001.zip`)]).toEqual([true, true]);

    const { imports, disk } = reportOf(root);
    expect(disk).toEqual({ free_bytes: Number.MAX_SAFE_INTEGER, max_bundle_bytes: 64 * GIB });
    const google = imports.find((each) => each.kind === "google-takeout")!;
    expect(Object.keys(google).sort()).toEqual(["coming", "drop", "file", "guide", "health", "held", "icon", "kind", "leaves", "line", "name", "products", "reads", "recognise", "root", "takes", "titles", "wait"]);
    expect(google).toMatchObject({
      name: "Google Takeout", icon: "archive", takes: "Google takes minutes, or hours with photos", wait: "Minutes, or hours with photos", file: "zip", reads: null, root: "Takeout/", leaves: [],
      products: [{ id: "contacts", name: "Contacts" }, { id: "mail", name: "Gmail" }, { id: "my-activity", name: "Google activity" }, { id: "calendar", name: "Google Calendar" }, { id: "google-photos", name: "Google Photos" }],
    });
    expect(google.guide.filter((step) => step.open !== undefined).map((step) => step.open)).toEqual([{ label: "Open Google Takeout", url: "https://takeout.google.com/" }]);
    const NEWER_IMPORT = ofStamp(NEWER, A)!;
    const C_IMPORT = ofStamp(STAMP_C, C)!;
    const brought = (id: string) => `Imported ${dayWords(held(root)[id]!.at_ms, Date.now(), effective(root).settings.day)}`;
    expect([google.line, google.health.state]).toEqual([`${brought(NEWER_IMPORT)} · Google activity`, "ok"]);
    const exports = Object.fromEntries(reportOf(root).connectors.filter((each) => each.export?.import === "google-takeout").map((each) => [each.id, each.export]));
    const takeoutRow = { import: "google-takeout", name: "Google Takeout", icon: "archive", opens: false };
    expect(exports).toEqual({
      google: { ...takeoutRow, line: brought(NEWER_IMPORT) }, gmail: { ...takeoutRow, line: brought(IMPORT) },
      "google-calendar": { ...takeoutRow, line: brought(C_IMPORT) }, "google-photos": { ...takeoutRow, line: brought(IMPORT) },
      "apple-contacts": { ...takeoutRow, line: brought(IMPORT) },
    });
    expect(google.held.map((each) => [each.id, each.name, each.account])).toEqual([
      [NEWER_IMPORT, `20 Sep 2026 · ${A}`, A], [C_IMPORT, `1 Sep 2026 · ${C}`, C], [IMPORT, `14 Aug 2026 · ${A}`, A]]);
    const takeoutHeld = google.held.find((each) => each.id === IMPORT)!;
    expect(takeoutHeld).toMatchObject({ made_at: new Date(Date.parse(instant(STAMP))).toISOString(), span: { from: "2016-02-01", to: "2026-08-01" }, open_day: "2018-05-01" });
    expect(takeoutHeld.files.map((file) => [file.name, file.state])).toEqual([[`takeout-${STAMP}-2-001.zip`, "kept"], [`takeout-${STAMP}-3-001.zip`, "kept"]]);
    expect(products(takeoutHeld)).toEqual({
      calendar: ["read", "Google Calendar · 1\u00a0event"], contacts: ["read", "Contacts · 1\u00a0contact"], "google-photos": ["read", "Google Photos · 2\u00a0photos"], keep: ["not-read", "Keep · not read yet"],
      mail: ["read", "Gmail · 2\u00a0emails"], "my-activity": ["skipped", "Google activity · 4\u00a0entries · 1\u00a0file skipped"], profile: ["not-read", "Profile · not read yet"],
    });
    expect(takeoutHeld.notice).toEqual({ title: "Google Takeout imported", body: "2016–2026" });
    const status = statusOf(root, { now_ms: Date.now(), settings: effective(root).settings as never, door: null, stated: null });
    expect(status.imports).toContainEqual({ kind: "google-takeout", id: IMPORT, state: "ok", line: "Imported · 2016–2026" });
    artifact(root, "imports-home", {
      routes: Object.fromEntries([zip1, again, zip2, zip3, zip4, tar, newerZip, folder].map((each) => [each.id, rowsOf(root, each.id)])),
      listings: Object.fromEntries([zip1, zip2, zip3, zip4, tar, newerZip].map((each) => [each.id, listing(root, each.id)])),
      custody: { held: paused[UPLOAD], after: after[UPLOAD] }, receipts: first, held: held(root), imports, status: status.imports,
    });
    await home.stop();
  });

  it("reads a photo whose sidecar lands in the import's next file once it lands, Photos so far meanwhile, then consumed and swept; keeps a file a waiting read of its import needs; hands a later file the sidecars the sweep copied out", async () => {
    const home = await running("lifestream-imports-photos-");
    const { root } = home;
    const album = "Takeout/Google Photos/Photos from 2016";
    const [first, second] = [`takeout-${STAMP}-1-001.zip`, `takeout-${STAMP}-1-002.zip`];
    const zipA = importBundle(1, T0, "google-takeout", [[first, zip([
      [`${album}/IMG_0011.jpg`, photo("IMG_0011.jpg")], [`${album}/IMG_0011.jpg.supplemental-metadata.json`, sidecar("IMG_0011.jpg")], [`${album}/IMG_0012.jpg`, photo("IMG_0012.jpg")],
    ])]]);
    await home.ship(zipA);
    await answer(root, home.sock, STAMP, A);
    await until("the first file read", () => settled(root, 1) && rowsOf(root, zipA.id).includes(PHOTOS));
    expect(deliveriesOf(root).find((row) => row.id === zipA.id && row.source === PHOTOS)).toMatchObject({ state: "imported", refused: 1 });
    const sending: Stated = { [MAC]: {
      pass: "synthetic", grants: null, found: null, settings: null, sending: {}, room: null, network: null, recorder: null, stores: null, heard_ms: T0, waiting_since_ms: null,
      imports: [{ kind: "google-takeout", files: [{ id: "file-02", name: second, bytes: 1_000, state: "sending", why: null, sha256: null, seal: null, pass: null, sent_bytes: 500 }] }],
    } };
    const coming = reportOf(root, { stated: sending });
    const meanwhile = importOf(root, STAMP, { stated: sending });
    expect([products(meanwhile)["google-photos"], meanwhile.health.state, meanwhile.line, coming.imports[0]!.line, coming.needs.filter((need) => need.id.startsWith("import:")).map((need) => need.id)]).toEqual(
      [["partly", "Google Photos · 1\u00a0photo · 1\u00a0file couldn’t be read"], "needs-you", "Imported · 2016 · 1\u00a0file couldn’t be read", "Sending · 0 of 1\u00a0file",
        [`import:${idOf(root, STAMP)!}:refused`]]);

    const zipB = importBundle(2, T0 + 60_000, "google-takeout", [[second, zip([[`${album}/IMG_0012.jpg.supplemental-metadata.json`, sidecar("IMG_0012.jpg")]])]]);
    await home.ship(zipB);
    await until("the first file read again", () => readsOf(root, `${PHOTOS} ${zipA.id}`) === 2 && settled(root, 2));
    expect(deliveriesOf(root).filter((row) => row.source === PHOTOS).map((row) => [row.id, row.refused])).toEqual([[zipA.id, 0], [zipB.id, 0]]);
    expect(heads(root, PHOTOS)).toHaveLength(2);
    const read = importOf(root, STAMP);
    expect([products(read)["google-photos"], read.health.state, read.line]).toEqual([["read", "Google Photos · 2\u00a0photos"], "ok", "Imported · 2016"]);

    await askHome(home.sock, "pause", [`import:${PHOTOS}`, "--reason", "held by the test"]);
    await home.stop();
    const write = openHome(openHomeFolder(root), "migrate");
    write.commit((tx) => {
      tx.tables.deliveries.move(zipA.id, PHOTOS, { move: "reread", code: TEST_CODE, refused: 1 });
      tx.tables.deliveries.move(zipA.id, PHOTOS, { move: "unread" });
    });
    write.close();
    const again = await opened(root, home.token);
    await sweep(root, again.sock);
    const held = { first: receiptOf(root, zipA.id), second: receiptOf(root, zipB.id) };
    expect([held.first, held.second, inInbox(root, zipB.id, second)]).toEqual([null, null, true]);
    await askHome(again.sock, "resume", [`import:${PHOTOS}`]);
    await until("the waiting read ran", () => readsOf(root, `${PHOTOS} ${zipA.id}`) === 3 && deliveriesOf(root).find((row) => row.id === zipA.id && row.source === PHOTOS)?.refused === 0);
    await sweep(root, again.sock);
    const swept = { first: receiptOf(root, zipA.id), second: receiptOf(root, zipB.id) };
    expect(swept.first).toMatchObject({ done: true, removed: [`files/${first}`] });
    expect(swept.second).toMatchObject({ done: true, removed: [`files/${second}`], copied: [`members/files/${second}/${album}/IMG_0012.jpg.supplemental-metadata.json`] });

    const video = Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypqt  "), Buffer.from("a synthetic video IMG_0011.MOV")]);
    const zipC = importBundle(3, T0 + 120_000, "google-takeout", [[`takeout-${STAMP}-1-003.zip`, zip([[`${album}/IMG_0011.MOV`, video]])]]);
    await again.ship(zipC);
    await until("the third file read", () => deliveriesOf(root).find((row) => row.id === zipC.id && row.source === PHOTOS)?.state === "imported");
    expect(deliveriesOf(root).find((row) => row.id === zipC.id && row.source === PHOTOS)?.refused).toBe(0);
    const moved = readHome(root, (db) => db.prepare(`SELECT json_extract(v.text, '$.content.title') AS title, h.start_ms FROM heads h JOIN versions v ON v.id = h.version
      WHERE h.source = ? AND h.key = ?`).get(PHOTOS, createHash("sha256").update(video).digest("hex"))) as { title: string; start_ms: number } | undefined;
    expect(moved).toEqual({ title: "IMG_0011.MOV", start_ms: 1_465_545_600_000 });
    artifact(root, "imports-photos", { meanwhile, read, held, swept, video: moved, deliveries: deliveriesOf(root), heads: heads(root, PHOTOS) });
    await again.stop();
  });

  it("fails the import of an import's file gone that no receipt names, and waits for space while the home's disk is low", async () => {
    const home = await running("lifestream-imports-lost-", { [SEARCH]: "google-my-activity" });
    const { root } = home;
    await askHome(home.sock, "pause", [`import:${SEARCH}`, "--reason", "held by the test"]);
    const bundle = importBundle(1, T0, "google-takeout", [[`takeout-${STAMP}-1-001.zip`, zip(ZIP1)]]);
    await home.ship(bundle);
    await until("the zip's other sources imported", () => rowsOf(root, bundle.id).length === 5 && deliveriesOf(root).filter((row) => row.id === bundle.id && row.source !== SEARCH).every((row) => row.state === "imported"));
    rmSync(join(root, "inbox", ...bundle.id.split("/"), "files", `takeout-${STAMP}-1-001.zip`));
    await askHome(home.sock, "resume", [`import:${SEARCH}`]);
    await until("Search's import failed", () => deliveriesOf(root).find((row) => row.id === bundle.id && row.source === SEARCH)?.state === "failed");
    const failed = deliveriesOf(root).find((row) => row.id === bundle.id && row.source === SEARCH)!;
    expect(failed.error).toMatch(/BLOB_NOT_FOUND|no receipt of the sweep's names it removed/u);
    expect(heads(root, SEARCH)).toEqual([]);
    const failing = importOf(root, STAMP);
    expect([failing.health.state, importNeeds(root)]).toEqual(["syncing", []]);
    const low = importOf(root, STAMP, { free_bytes: 3e9 });
    expect([low.health.state, low.health.reason, low.line]).toEqual(["waiting", "disk", "Waiting for disk space on your Mac · 2 GB free to go on · your files are kept"]);

    artifact(root, "imports-lost", { failed, failing, low, deliveries: deliveriesOf(root) });
    await home.stop();
  });

  it("says what came and what did not once every read ended refusing, never Bringing in: each product its own members, one count, its file's the same, one need for the import; a Mac's wait as its file's", async () => {
    const home = await running("lifestream-imports-refused-");
    const { root } = home;
    const NB = " ";
    const card = (name: string, phone: string) => ["BEGIN:VCARD", "VERSION:3.0", `FN:${name}`, `TEL:${phone}`, "END:VCARD"];
    const message = (id: number, thread: boolean) => [
      `From 17900000000000003${String(id).padStart(2, "0")}@xxx Sun Mar 05 09:00:00 +0000 2017`, ...thread ? ["X-GM-THRID: 1790000000000000300"] : [], "X-Gmail-Labels: Inbox",
      `From: Person B <${B}>`, `To: ${A}`, `Subject: a synthetic message ${id}`, "Date: Sun, 5 Mar 2017 09:00:00 +0000", "", "A synthetic body.", "",
    ];
    const youtube = json([
      { header: "YouTube", title: "Watched a synthetic video", time: "2017-03-05T12:00:00.000Z", products: ["YouTube"] },
      { header: "YouTube", title: "Watched a synthetic video with no time", products: ["YouTube"] },
      { header: "YouTube", title: "Watched another synthetic video with no time", products: ["YouTube"] },
    ]);
    const parts: [string, Buffer][] = [
      ["Takeout/Mail/All mail Including Spam and Trash.mbox", crlf([...message(0, true), ...Array.from({ length: 12 }, (_, index) => message(index + 1, false)).flat()])],
      ["Takeout/My Activity/YouTube/MyActivity.json", youtube],
      ["Takeout/My Activity/AI Mode/MyActivity.json", json([{ header: "Search", title: "Searched for a synthetic question with no time", products: ["AI Mode"] }])],
      ["Takeout/Profile/Profile.json", PROFILE],
      ZIP1[1]!,
      ["Takeout/Contacts/My Contacts/My Contacts.vcf", crlf([...card("Person D", "+15550000004"), ...card("Person E", "+15550000005")])],
      ["Takeout/Contacts/Label One/Label One.vcf", Buffer.from([0x42, 0x45, 0xff, 0xfe, 0x0d, 0x0a])],
      ["Takeout/Contacts/Label Two/Label Two.vcf", crlf(["BEGIN:VCARD", "VERSION:3.0", "FN:Person F"])],
      [`Takeout/Calendar/${B}.ics`, ics(B, [vevent("event-b-1", "20180502")])],
      [`Takeout/Calendar/${C}.ics`, ics(C, [vevent("event-c-1", "20180503")])],
    ];
    const bundle = importBundle(1, T0, "google-takeout", [[`takeout-${STAMP}-1-001.zip`, zip(parts)]]);
    await home.ship(bundle);
    await until("asked naming three", () => idOf(root, STAMP, null) !== undefined);
    expect(held(root)[idOf(root, STAMP, null)!]!.named).toEqual([A, B, C]);
    await answer(root, home.sock, STAMP, A);
    await until("the zip imported", () => settled(root, 1) && rowsOf(root, bundle.id).length === 6);
    expect(rowsOf(root, bundle.id)).toEqual([CONTACTS, GMAIL, CALENDAR, SEARCH, UPLOAD, YOUTUBE].sort());
    expect(Object.fromEntries(deliveriesOf(root).map((row) => [row.source, row.refused]))).toEqual({ [CALENDAR]: 2, [CONTACTS]: 2, [GMAIL]: 12, [SEARCH]: 1, [UPLOAD]: 0, [YOUTUBE]: 2 });
    const file = `takeout-${STAMP}-1-001.zip`;
    expect([GMAIL, YOUTUBE].map((source) => (JSON.parse(meta(root, `${DAYS}${bundle.id}|${source}`)!) as Tally).refused)).toEqual([
      { count: 12, members: { [`${file}/Takeout/Mail/All mail Including Spam and Trash.mbox`]: 12 } },
      { count: 2, members: { [`${file}/Takeout/My Activity/YouTube/MyActivity.json`]: 2 } },
    ]);

    const takeout = importsOf(root).find((each) => each.kind === "google-takeout")!;
    const IMPORT = idOf(root, STAMP)!;
    const one = takeout.held[0]!;
    const line = `Imported · 2017 · 7${NB}files couldn’t be read`;
    expect([one.health.state, one.health.reason, one.health.words, one.health.acts, one.line, one.span, one.open_day]).toEqual([
      "needs-you", "import", `Couldn't read 7${NB}files`, [{ do: "skip", label: "Skip it", need: `import:${IMPORT}:refused` }],
      line, { from: "2017-03-05", to: "2017-03-05" }, "2017-03-05"]);
    expect([takeout.health.state, takeout.line]).toEqual(["needs-you", `Imported ${dayWords(held(root)[IMPORT]!.at_ms, Date.now(), effective(root).settings.day)} · 7${NB}files couldn’t be read`]);
    expect(products(one)).toEqual({
      calendar: ["partly", `Google Calendar · 2${NB}files couldn’t be read`], contacts: ["partly", `Contacts · 2${NB}contacts · 2${NB}files couldn’t be read`],
      mail: ["partly", `Gmail · 1${NB}email · 1${NB}file couldn’t be read`], "my-activity": ["partly", `Google activity · 3${NB}entries · 2${NB}files couldn’t be read`],
      profile: ["not-read", "Profile · not read yet"],
    });
    expect(one.files.map((each) => [each.name, each.words, each.line])).toEqual([[file, "Kept", `7${NB}files couldn't be read`]]);
    expect(importNeeds(root)).toEqual([`import:${IMPORT}:refused`]);
    const status = statusOf(root, { now_ms: Date.now(), settings: effective(root).settings as never, door: null, stated: null });
    expect(status.imports).toEqual([{ kind: "google-takeout", id: IMPORT, state: "needs-you", line }]);

    const waitingFile = (id: string, name: string, bytes: number) => ({ id, name, bytes, state: "waiting" as const, why: "home-room" as const, sha256: null, seal: null, pass: null, sent_bytes: null });
    const stated: Stated = { [MAC]: {
      pass: "synthetic", grants: null, found: null, settings: null, sending: {}, room: null, network: null, recorder: null, stores: null, heard_ms: T0, waiting_since_ms: null,
      imports: [{ kind: "google-takeout", files: [waitingFile("file-01", `takeout-${NEWER}-1-001.zip`, 10_000_000_000), waitingFile("file-02", `takeout-${NEWER}-2-001.zip`, 3_000_000_000)] }],
    } };
    const waiting = reportOf(root, { stated });
    const coming = waiting.imports.find((each) => each.kind === "google-takeout")!;
    expect([coming.coming.map((each) => [each.words, each.line]), coming.line]).toEqual([
      [["Waiting", `Lifestream needs 25${NB}GB free`], ["Waiting", `Lifestream needs 11${NB}GB free`]], `Sending · 0 of 2${NB}files`]);
    expect(waiting.needs.filter((need) => need.words.includes("free"))).toEqual([]);

    const google = waiting.connectors.find((each) => each.id === "google")!;
    expect([google.name, google.health.reason]).toEqual(["Google activity", null]);
    artifact(root, "imports-refused", { deliveries: deliveriesOf(root), held: one, waiting: coming, google: google.health });
  });

  it("is in, with its span and its day, once every read is read or given up: a refusal asked once every read ended and given up, or the last read to settle given up", async () => {
    const home = await running("lifestream-imports-given-up-", { [SEARCH]: "google-my-activity" });
    const { root } = home;
    await askHome(home.sock, "pause", [`import:${SEARCH}`, "--reason", "held by the test"]);
    const refusing = importBundle(1, T0, "google-takeout", [[`takeout-${STAMP}-1-001.zip`, zip([["Takeout/Profile/Profile.json", PROFILE], [`Takeout/Calendar/${B}.ics`, ics(B, [vevent("event-g-1", "20180502")])]])]]);
    const searching = importBundle(2, T0 + 60_000, "google-takeout", [[`takeout-${STAMP}-2-001.zip`, zip([ZIP1[1]!])]]);
    await home.ship(refusing);
    await home.ship(searching);
    await answer(root, home.sock, STAMP, A);
    await until("the calendar's read refused, Search held", () => deliveriesOf(root).find((row) => row.id === refusing.id && row.source === CALENDAR)?.refused === 1
      && deliveriesOf(root).some((row) => row.id === searching.id && row.source === SEARCH));
    const IMPORT = idOf(root, STAMP)!;
    expect(importNeeds(root)).toEqual([]);
    await askHome(home.sock, "resume", [`import:${SEARCH}`]);
    await until("Search read", () => deliveriesOf(root).find((row) => row.id === searching.id && row.source === SEARCH)?.state === "imported");
    await until("the refusal asked", () => importNeeds(root).length === 1);
    expect(importNeeds(root)).toEqual([`import:${IMPORT}:refused`]);
    expect(await askHome(home.sock, "act", [`import:${IMPORT}:refused`, "skip"])).toEqual({ acted: "skipped" });
    await until("the refusal given up", () => importNeeds(root).length === 0);
    const given = importOf(root, STAMP);
    expect([given.health.state, given.line, given.span, given.open_day, importNeeds(root)]).toEqual(
      ["ok", "Imported · 2017", { from: "2017-03-05", to: "2017-03-05" }, null, []]);
    expect(products(given).calendar).toEqual(["skipped", "Google Calendar · 1\u00a0file skipped"]);

    await askHome(home.sock, "pause", [`import:${SEARCH}`, "--reason", "held by the test"]);
    const last = importBundle(3, T0 + 120_000, "google-takeout", [[`takeout-${NEWER}-1-001.zip`, zip([[`Takeout/Calendar/${A}.ics`, ics(A, [vevent("event-g-2", "20180501")])], ZIP1[1]!])]]);
    await home.ship(last);
    await until("the calendar and the upload read, Search held", () => deliveriesOf(root).find((row) => row.id === last.id && row.source === CALENDAR)?.state === "imported"
      && deliveriesOf(root).find((row) => row.id === last.id && row.source === UPLOAD)?.state === "imported"
      && deliveriesOf(root).some((row) => row.id === last.id && row.source === SEARCH));
    expect(importOf(root, NEWER).span).toBeNull();
    await until("Search's import queued", () => readHome(root, (db) => db.prepare("SELECT state FROM jobs WHERE kind = 'import' AND key = ?").pluck().get(SEARCH)) === "queued");
    expect(await askHome(home.sock, "drop", ["job", "import", SEARCH])).toMatchObject({ dropped: `import ${SEARCH}`, delivery: last.id });
    const dropped = importOf(root, NEWER);
    expect([dropped.health.state, dropped.line, dropped.span, dropped.open_day]).toEqual(["ok", "Imported · 2018", { from: "2018-05-01", to: "2018-05-01" }, "2018-05-01"]);
    expect(dropped.products.filter((product) => product.state === "reading")).toEqual([]);
    expect(products(dropped)["my-activity"]).toEqual(["skipped", "Google activity · 1\u00a0file skipped"]);
    expect(deliveriesOf(root).find((row) => row.id === last.id && row.source === SEARCH)?.read_by).not.toBeNull();
    artifact(root, "imports-given-up", { given, dropped, deliveries: deliveriesOf(root) });
    await home.stop();
  });

  it("is in with what a read given up part way landed: an import stopped after its first slices commit, resumed and read again from its first row, then dropped, keeps their days and its refusal once", async () => {
    const { root, id, sock, home, hold, span } = await partWay("lifestream-imports-dropped-");
    try {
      writeFileSync(hold, "");
      const from = Date.parse("2015-03-01T12:00:00Z");
      const rows: Record<string, unknown>[] = Array.from({ length: 5_000 }, (_, index) => ({ kind: "note", key: `n${index}`, content: { text: `note ${index}`, at: from + index * HOUR_MS }, at: from + index * HOUR_MS }));
      rows.splice(2_500, 0, { hold });
      rows.unshift({ kind: "nonesuch", key: "x1", content: {} });
      expect(await ship(root, { source: NOTES, fetched_ms: T0, rows: rows as never, facts: { import: { kind: NO_ROWS } } })).toBe(id);
      type Progress = { counts: { refused: number; duplicated: number; replayed: number }; tally: Tally };
      const now = () => readHome(root, (db) => [
        JSON.parse(db.prepare("SELECT progress FROM jobs WHERE kind = 'import' AND key = ?").pluck().get(NOTES) as string) as Progress,
        db.prepare("SELECT count(*) FROM heads WHERE source = ?").pluck().get(NOTES) as number,
      ] as const);
      await until("the import holds mid-delivery", () => existsSync(`${hold}.held`));
      await until("part of the delivery committed", () => now()[1] > 0);
      await askHome(sock, "pause", [`import:${NOTES}`, "--reason", "held by the test"]);
      rmSync(`${hold}.held`);
      await askHome(sock, "resume", [`import:${NOTES}`]);
      await until("the resumed read holds again", () => existsSync(`${hold}.held`));
      await until("the resumed read's first slice committed", () => now()[0].counts.duplicated + now()[0].counts.replayed > 0);
      await askHome(sock, "pause", [`import:${NOTES}`, "--reason", "held by the test"]);
      const [progress, landed] = now();
      const kept = Object.values(progress.tally.days).reduce((sum, count) => sum + count, 0);
      expect([kept, landed < 5_000, progress.counts.refused, meta(root, `${DAYS}${id}|${NOTES}`), span()]).toEqual([landed, true, 1, undefined, null]);
      await askHome(sock, "drop", ["job", "import", NOTES]);
      const days = Object.keys(progress.tally.days).sort();
      const dropped = deliveriesOf(root).find((row) => row.id === id)!;
      expect([dropped.state, dropped.refused, JSON.parse(meta(root, `${DAYS}${id}|${NOTES}`)!), span()]).toEqual(
        ["dead", 1, { days: progress.tally.days, kinds: progress.tally.kinds, lines: progress.tally.lines, refused: { count: 1, members: {} } }, { from: days[0], to: days.at(-1) }]);
      artifact(root, "imports-dropped", { landed, progress, span: span() });
    } finally {
      await home.stop();
      rmSync(hold, { force: true });
    }
  });

  it("is in with what a re-read given up part way landed: a re-read that lands records its delivery's last read did not, dropped, widens the import's span", async () => {
    const { root, id, sock, home, hold, span } = await partWay("lifestream-imports-reread-dropped-");
    const newer = join(root, "newer");
    try {
      const day = (at: string, index: number) => Date.parse(at) + index * HOUR_MS;
      const rows: Record<string, unknown>[] = [
        { kind: "nonesuch", key: "x1", content: {} },
        ...Array.from({ length: 30 }, (_, index) => ({ kind: "note", key: `old${index}`, content: { text: `old ${index}`, at: Date.parse("2018-06-01T12:00:00Z") + index * 60_000 }, at: Date.parse("2018-06-01T12:00:00Z") + index * 60_000 })),
        ...Array.from({ length: 3_000 }, (_, index) => ({ kind: "note", key: `new${index}`, content: { text: `new ${index}`, at: day("2019-01-01T12:00:00Z", index) }, at: day("2019-01-01T12:00:00Z", index), read_if: newer })),
        { hold },
        ...Array.from({ length: 10 }, (_, index) => ({ kind: "note", key: `last${index}`, content: { text: `last ${index}`, at: day("2020-01-01T12:00:00Z", index) }, at: day("2020-01-01T12:00:00Z", index), read_if: newer })),
      ];
      expect(await ship(root, { source: NOTES, fetched_ms: T0, rows: rows as never, facts: { import: { kind: NO_ROWS } } })).toBe(id);
      await until("the first read imported", () => deliveriesOf(root).find((row) => row.id === id)?.state === "imported");
      expect(span()).toEqual({ from: "2018-06-01", to: "2018-06-01" });
      writeFileSync(newer, "");
      writeFileSync(hold, "");
      await askHome(sock, "run", ["import", NOTES]);
      await until("the re-read holds", () => existsSync(`${hold}.held`));
      const landed2019 = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM heads WHERE source = ? AND key LIKE 'new%'").pluck().get(NOTES) as number);
      await until("the re-read committed 2019's first records", () => landed2019() > 0);
      await askHome(sock, "pause", [`import:${NOTES}`, "--reason", "held by the test"]);
      const progress = readHome(root, (db) => JSON.parse(db.prepare("SELECT progress FROM jobs WHERE kind = 'import' AND key = ?").pluck().get(NOTES) as string)) as { delivery: string; tally: Tally };
      await askHome(sock, "drop", ["job", "import", NOTES]);
      const days = Object.keys(progress.tally.days).sort();
      const after = deliveriesOf(root).find((row) => row.id === id)!;
      const tally = JSON.parse(meta(root, `${DAYS}${id}|${NOTES}`)!) as Tally;
      expect([progress.delivery, after.state, after.refused, tally.refused, days.at(-1)! >= "2019-01-01", span()]).toEqual([id, "imported", 1, { count: 1, members: {} }, true, { from: "2018-06-01", to: days.at(-1) }]);
      expect(after.read_by).not.toBeNull();
      artifact(root, "imports-reread-dropped", { progress, tally, span: span() });
    } finally {
      await home.stop();
      rmSync(hold, { force: true });
    }
  });

  it("names in a receipt only the files the sweep removed: a file gone that none names read as empty, or kept unread by its re-read, though another file of its delivery was swept", async () => {
    const home = await running("lifestream-imports-receipt-");
    const { root } = home;
    const [swept, vanished] = [`takeout-${STAMP}-1-001.zip`, `takeout-${STAMP}-2-001.zip`];
    const both = importBundle(1, T0, "google-takeout", [
      [swept, zip([ZIP1[1]!])],
      [vanished, zip([[`Takeout/Calendar/${A}.ics`, ics(A, [vevent("event-r-1", "20180501")])], [`Takeout/Calendar/${B}.ics`, ics(B, [vevent("event-r-2", "20180502")])]])],
    ]);
    await home.ship(both);
    await until("asked naming both", () => idOf(root, STAMP, null) !== undefined);
    expect(held(root)[idOf(root, STAMP, null)!]!.named).toEqual([A, B]);
    await answer(root, home.sock, STAMP, A);
    await until("the delivery imported", () => rowsOf(root, both.id).length === 3 && settled(root, 1));
    expect(deliveriesOf(root).find((row) => row.id === both.id && row.source === CALENDAR)?.refused).toBe(1);
    rmSync(join(root, "inbox", ...both.id.split("/"), "files", vanished));
    await sweep(root, home.sock);
    const receipt = receiptOf(root, both.id);
    expect(receipt).toMatchObject({ done: true, removed: [`files/${swept}`] });
    expect(receipt!.kept).toEqual(expect.arrayContaining([`files/${vanished}`, "upload.json"]));
    const later = importBundle(2, T0 + 60_000, "google-takeout", [[`takeout-${STAMP}-3-001.zip`, zip([[`Takeout/Calendar/${A}.ics`, ics(A, [vevent("event-r-3", "20180503")])]])]]);
    await home.ship(later);
    const calendarOf = () => deliveriesOf(root).find((row) => row.id === both.id && row.source === CALENDAR)!;
    await until("the calendars' read again ended, the later file read", () => /no receipt of the sweep's names it removed/u.test(calendarOf().error ?? "") && settled(root, 2));
    const failed = calendarOf();
    expect([failed.state, failed.refused]).toEqual(["imported", 0]);
    expect(readHome(root, (db) => db.prepare("SELECT key, json_extract(detail, '$.source') AS source FROM events WHERE kind = 'input-gone'").all())).toEqual([{ key: both.id, source: CALENDAR }]);
    expect(failed.error).toContain(`files/${vanished} is not in the inbox`);
    expect(heads(root, CALENDAR)).toHaveLength(2);
    expect(receiptOf(root, both.id)).toMatchObject({ removed: [`files/${swept}`] });
    artifact(root, "imports-receipt", { receipt, failed, deliveries: deliveriesOf(root) });
    await home.stop();
  });

  it("finishes after a crash at an import's listing, at the sweep's receipt, or at its files, losing and repeating nothing", async () => {
    const { root, token } = folderWithPass("lifestream-imports-crash-");
    const door = await doorHere(root);
    onTestFinished(() => door.stop());
    const device = mac(door.url, token);
    const env = { LIFESTREAM_TEST_REGISTRY: REGISTRY.href };
    const child = new ChildHome(root);
    onTestFinished(async () => { await child.stop(); });
    const sock = testSocket(root);
    const killedAt = async (failpoint: string, act: () => Promise<void>) => {
      child.start(failpoint, { env });
      await child.ready();
      await act();
      expect((await child.exited()).signal).toBe("SIGKILL");
    };
    const bundle = importBundle(1, T0, "google-takeout", [[`takeout-${STAMP}-1-001.zip`, zip(ZIP1)]]);
    await killedAt("import.listed", () => device.ship(bundle));
    expect([meta(root, `${LISTING}${bundle.id}`), rowsOf(root, bundle.id).filter((source) => source !== UPLOAD)]).toEqual([undefined, []]);
    await killedAt("sweep.receipt", async () => {
      await until("the zip imported", () => settled(root, 1) && rowsOf(root, bundle.id).length === 5);
      await askHome(sock, "sweep", []).catch(() => undefined);
    });
    const runs = Object.fromEntries([SEARCH, GMAIL, CALENDAR, CONTACTS].map((source) => [source, runsOf(root, `${source} ${bundle.id}`)]));
    expect(Object.values(runs)).toEqual([1, 1, 1, 1]);
    const atReceipt = receiptOf(root, bundle.id);
    expect([atReceipt?.done, atReceipt?.removed, inInbox(root, bundle.id, `takeout-${STAMP}-1-001.zip`)]).toEqual([false, [`files/takeout-${STAMP}-1-001.zip`], true]);
    await killedAt("sweep.removed", () => askHome(sock, "sweep", []).then(() => undefined, () => undefined));
    expect([receiptOf(root, bundle.id)?.done, inInbox(root, bundle.id, `takeout-${STAMP}-1-001.zip`)]).toEqual([false, false]);
    child.start(undefined, { env });
    await child.ready();
    const before = sweeps(root);
    await askHome(sock, "sweep", []);
    await until("the sweep finished the receipt", () => sweeps(root) > before);
    const finished = receiptOf(root, bundle.id);
    expect(finished).toMatchObject({ done: true, removed: [`files/takeout-${STAMP}-1-001.zip`], kept: ["upload.json"] });
    expect(Object.fromEntries([SEARCH, GMAIL, CALENDAR, CONTACTS].map((source) => [source, runsOf(root, `${source} ${bundle.id}`)]))).toEqual(runs);
    expect((await device.exchange())[UPLOAD]).toMatchObject({ received: 1, imported: 1 });
    artifact(root, "imports-crash", { exits: child.exits, atReceipt, finished, runs });
  });

  it("lists every kept file of an import again when the folder tables change, and reads only what a reader newly reads", async () => {
    const home = await running("lifestream-imports-relist-");
    const { root } = home;
    const bundle = importBundle(1, T0, "google-takeout", [[`takeout-${STAMP}-1-001.zip`, zip(ZIP1)]]);
    await home.ship(bundle);
    await until("the zip imported", () => settled(root, 1));
    await home.stop();
    const db = new Database(join(root, "home.db"));
    const kept = listing(root, bundle.id);
    db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify({ ...kept, hash: "an-older-release", routes: kept.routes.filter((route) => route.product !== "google-contacts") }), `${LISTING}${bundle.id}`);
    db.prepare("DELETE FROM deliveries WHERE id = ? AND source = ?").run(bundle.id, CONTACTS);
    db.close();
    const runsBefore = Object.fromEntries([SEARCH, GMAIL, CALENDAR].map((source) => [source, runsOf(root, `${source} ${bundle.id}`)]));
    const again = await opened(root, home.token);
    await until("the Contacts source fed again", () => rowsOf(root, bundle.id).includes(CONTACTS) && settled(root, 1));
    expect(listing(root, bundle.id).hash).toBe(declared.listingHash(takeoutKind()));
    expect(Object.fromEntries([SEARCH, GMAIL, CALENDAR].map((source) => [source, runsOf(root, `${source} ${bundle.id}`)]))).toEqual(runsBefore);
    expect(runsOf(root, `${CONTACTS} ${bundle.id}`)).toBe(2);
    artifact(root, "imports-relist", { runs: runsBefore, rows: rowsOf(root, bundle.id), listing: listing(root, bundle.id) });
    await again.stop();
  });

  it("reads a file again whose rows now claim more of it for the source that read it whole: a run of its own, the first run's history kept, every record it reads counted", async () => {
    const home = await running("lifestream-imports-relist-reread-");
    const { root } = home;
    const bundle = importBundle(1, T0, "google-takeout", [[`takeout-${STAMP}-1-001.zip`, zip(ZIP1)]]);
    await home.ship(bundle);
    await until("the zip imported", () => settled(root, 1));
    await home.stop();
    const subject = `${SEARCH} ${bundle.id}`;
    const runs = () => readHome(root, (db) => db.prepare("SELECT id, outcome, counts FROM runs WHERE kind = 'import' AND subject = ? ORDER BY id").all(subject)) as { id: number; outcome: string; counts: string }[];
    const [first] = runs();
    const db = new Database(join(root, "home.db"));
    const kept = listing(root, bundle.id);
    const narrower = kept.routes.map((route) => (declared.sourceOf(route, A) === SEARCH ? { ...route, members: "Takeout/My Activity/Search/none.json" } : route));
    db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify({ ...kept, hash: "an-older-release", routes: narrower }), `${LISTING}${bundle.id}`);
    db.close();
    const again = await opened(root, home.token);
    try {
      await until("Search read the file again", () => readsOf(root, subject) === 2 && settled(root, 1));
      const [was, reread] = runs();
      expect(was).toEqual(first);
      expect([reread!.id > first!.id, reread!.outcome, JSON.parse(reread!.counts)]).toEqual([true, "ok", expect.objectContaining({ new: 0, changed: 0, duplicated: 2 })]);
      const tally = JSON.parse(meta(root, `${DAYS}${bundle.id}|${SEARCH}`)!) as Tally;
      expect([Object.values(tally.kinds).reduce((sum, count) => sum + count, 0), heads(root, SEARCH).length]).toEqual([2, 2]);
    } finally {
      await again.stop();
    }
  });

  it("lists a 2 GiB zip by its central directory, never its bytes", async () => {
    const dir = makeRoot("lifestream-imports-memory-", { sources: {} });
    roots.push(dir);
    const path = join(dir, "takeout-large.zip");
    const small = ZIP1[1]!;
    writeSparseZip(path, small, 2 * 1024 ** 3);
    const before = process.resourceUsage().maxRSS * 1024;
    const files = { prefix: (_blob: string, bytes: number) => readPrefixOf(path, bytes), materialise: async () => ({ path, dispose: () => undefined }), has: () => true, bytes: () => { throw new Error("read whole"); }, text: () => { throw new Error("read whole"); } };
    const { listing: listed } = await declared.listImport(takeoutKind(), { id: "upload/1", source: UPLOAD, stated_ms: T0, files: [{ path: "takeout-large.zip", blob: `sha256:${"0".repeat(64)}`, size: 2 * 1024 ** 3 + 1024 }], facts: { import: { kind: "google-takeout" } } } as never, files as never);
    const grown = process.resourceUsage().maxRSS * 1024 - before;
    expect(listed.products.map((product) => product.id)).toEqual(["google-photos", "my-activity"]);
    expect(listed.routes.map((route) => declared.sourceOf(route, A)).sort()).toEqual([PHOTOS, SEARCH]);
    expect(grown).toBeLessThan(256 * 1024 ** 2);
    artifact(dir, "imports-memory", { zip_bytes: 2 * 1024 ** 3, rss_grown_bytes: grown, budget_bytes: 256 * 1024 ** 2, listed });
  });
});

const MAILBOX = GMAIL;
const ACCOUNT = A;
const count = (root: string, sql: string, ...params: unknown[]): number => readHome(root, (db) => db.prepare(sql).pluck().get(...params) as number);
const mailLines = (lines: string[]): Buffer => Buffer.from(lines.map((line) => `${line}\r\n`).join(""));
const MSGID = "1790000000000000301";
const PULLED = "2026-09-07T04:00:00.000Z";
const EXPORTED = "2026-09-08T00:00:00.000Z";
const EML = mailLines(["From: person-b@example.com", `To: ${ACCOUNT}`, "Subject: one message, two routes", "Date: Sun, 6 Sep 2026 17:31:00 +0530", "", "A synthetic body."]);
const mboxMessage = (id: string, eml: Buffer): Buffer => Buffer.concat([
  mailLines([`X-GM-THRID: ${id}`, "X-Gmail-Labels: Inbox"]), Buffer.from(eml.toString("latin1").replace(/^(>*From )/gmu, ">$1"), "latin1"), mailLines([""]),
]);
const MBOX_MESSAGE = mboxMessage(MSGID, EML);
const feeds = (feeder: string) => [{ id: MAILBOX, connector: feeder }];

interface Message { id: string; eml: Buffer; internaldate: string; labels?: string[] }

const pull = (root: string, messages: Message[], at: string) => shipFiles(root, MAILBOX, Date.parse(at), {
  ...Object.fromEntries(messages.map((message) => [`msg-${message.id}.eml`, message.eml])),
  "pull.json": Buffer.from(JSON.stringify({
    format: "org.lifestreamprotocol.gmail-imap-pull/0.2", complete: true, account: ACCOUNT, fetched_at: at,
    folders: [{ folder: "[Gmail]/All Mail", uidvalidity: "7", uidnext: "102" }],
    messages: messages.map((message) => ({
      file: `msg-${message.id}.eml`, folder: "[Gmail]/All Mail", gm_msgid: message.id, gm_thrid: message.id, labels: message.labels ?? ["\\Inbox"],
      internaldate: message.internaldate, sha256: hex(message.eml), bytes: message.eml.length,
    })),
  })),
}, { account: ACCOUNT, messages: messages.length, sources: feeds("gmail-imap") });

const takeout = (root: string, messages: Message[], exported: string) => {
  const folder = `takeout-${exported.replace(/[-:]|\.\d+/gu, "")}-1-001`;
  return shipFiles(root, UPLOAD, Date.parse(exported) + HOUR_MS, {
    [`files/${folder}/Takeout/Mail/All mail Including Spam and Trash.mbox`]: Buffer.concat(messages.map((message) =>
      Buffer.concat([mailLines([`From ${message.id}@xxx Sun Sep 06 12:01:00 +0000 2026`]), mboxMessage(message.id, message.eml)]))),
    [`files/${folder}/Takeout/Profile/Profile.json`]: PROFILE,
  }, { import: { kind: "google-takeout" }, history: true });
};

const ONE: Message = { id: MSGID, eml: EML, internaldate: "2026-09-06T12:01:00.000Z" };
const shipPull = (root: string) => pull(root, [ONE], PULLED);
const shipTakeout = (root: string) => takeout(root, [ONE], EXPORTED);
const tag = (gist: string) => JSON.stringify({ from: "machine", kind: "notice", topic: "synthetic notice", provider: null, amount: null, reference: null, gist });
const mailMessage = (n: number, body: string[]): Message => ({
  id: `179000000000000040${n}`, internaldate: `2026-09-06T1${n}:00:00.000Z`,
  eml: mailLines([`From: Machine ${n} <notices-${n}@example.com>`, `To: ${ACCOUNT}`, `Subject: synthetic notice ${n}`, `Date: Sun, 6 Sep 2026 1${n}:00:00 +0000`, "", ...body]),
});
const mailItem = (each: Message) => `${MAILBOX}/${each.id}`;
const mailSettings = (family: JsonObject): JsonObject => ({ "families.mail": family });

describe("a Takeout's mailbox beside Gmail's IMAP poll, in a running home", () => {
  it("lands one message Gmail's IMAP poll and a Takeout both bring as one record of one source, whichever comes first or names the source", async () => {
    interface Seen {
      sources: { id: string; connector: string; options: string }[];
      heads: { kind: string; key: string; version: string; text: string }[];
      statements: { version: string; stated_ms: number; late: number }[];
      problems: string[];
      listed: Record<string, string[]>;
    }
    const seen: Record<string, Seen> = {};
    const cases = [
      { name: "pull first", made: {}, order: [shipPull, shipTakeout] },
      { name: "takeout first", made: {}, order: [shipTakeout, shipPull] },
      { name: "made by gmail-imap", made: { [MAILBOX]: "gmail-imap" }, order: [shipTakeout, shipPull] },
      { name: "made by gmail-takeout", made: { [MAILBOX]: "gmail-takeout" }, order: [shipPull, shipTakeout] },
    ];
    for (const { name, made, order: [first, second] } of cases) {
      const root = makeRoot("lifestream-imports-gmail-", { sources: made });
      roots.push(root);
      const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
      try {
        for (const [index, deliver] of [first!, second!].entries()) {
          await deliver(root);
          await until(`delivery ${index + 1} ended`, () => count(root, "SELECT count(*) FROM deliveries WHERE state IN ('imported', 'failed', 'dead')") === index + 1);
        }
        expect(count(root, "SELECT count(*) FROM deliveries WHERE source = ? AND state = 'imported'", MAILBOX)).toBe(2);
        const blobs = openHomeFolder(root).blobs(join(root, "blobs"), { reading: true });
        expect([EML, MBOX_MESSAGE].map((bytes) => blobs.has(`sha256:${hex(bytes)}`))).toEqual([true, true]);
        const report = streamsOf(root);
        seen[name] = {
          ...readHome(root, (db) => ({
            sources: (db.prepare("SELECT id, connector, options FROM sources ORDER BY id").all() as Seen["sources"]).filter((row) => !OWN_SOURCES.includes(row.id)),
            heads: db.prepare("SELECT h.kind, h.key, h.version, v.text FROM heads h JOIN versions v ON v.id = h.version WHERE h.source = ? ORDER BY h.kind, h.key").all(MAILBOX) as Seen["heads"],
            statements: db.prepare("SELECT version, stated_ms, late FROM statements WHERE source = ? AND kind = 'mailmsg' AND key = ? ORDER BY seq").all(MAILBOX, MSGID) as Seen["statements"],
          })),
          problems: (await selfCheckHere(root)).problems,
          listed: Object.fromEntries(["gmail", "google"].map((id) => [id, report.connectors.find((each) => each.id === id)!.copies.map((copy) => copy.id)])),
        };
      } finally {
        await home.stop();
      }
    }
    const [pullFirst, takeoutFirst] = [seen["pull first"]!, seen["takeout first"]!];
    const feeder = { "pull first": "gmail-imap", "takeout first": "gmail-takeout" } as Record<string, string>;
    for (const { name, made } of cases) {
      const each = seen[name]!;
      expect(each.sources).toEqual([{ id: MAILBOX, connector: made[MAILBOX] ?? feeder[name], options: "{}" }]);
      expect(each.heads.map((head) => `${head.kind}:${head.key}`)).toEqual([`chat:${MSGID}`, `mailmsg:${MSGID}`]);
      expect(each.heads).toEqual(pullFirst.heads);
      expect(each.problems).toEqual([]);
      expect(each.listed).toEqual({ gmail: [MAILBOX], google: [] });
    }
    const head = JSON.parse(pullFirst.heads[1]!.text) as { content: { content: JsonObject; blobs: { hash: string }[] } };
    expect(head.content.content).toEqual({ from_line: `From ${MSGID}@xxx Sun Sep 06 12:01:00 +0000 2026` });
    expect(head.content.blobs.map((blob) => blob.hash)).toEqual([`sha256:${hex(MBOX_MESSAGE)}`]);
    const [pulled, exported] = [Date.parse(PULLED), Date.parse(EXPORTED)];
    const takeoutVersion = pullFirst.heads[1]!.version;
    expect(pullFirst.statements.map((row) => [row.stated_ms, row.late, row.version === takeoutVersion])).toEqual([[pulled, 0, false], [exported, 0, true]]);
    expect(takeoutFirst.statements.map((row) => [row.stated_ms, row.late, row.version === takeoutVersion])).toEqual([[exported, 0, true], [pulled, 1, false]]);
    expect(takeoutFirst.statements[1]!.version).toBe(pullFirst.statements[0]!.version);
    expect(seen["made by gmail-imap"]!.statements).toEqual(takeoutFirst.statements);
    expect(seen["made by gmail-takeout"]!.statements).toEqual(pullFirst.statements);
    artifact(roots.at(-1)!, "imports-gmail", seen);
  });

  it("an erasure of an email both routes brought, or of its mailbox, leaves a copy of it, its tag or its line, takes another email, or lets a later pull or Takeout bring it back", async () => {
    const stays = mailMessage(8, ["A synthetic notice that stays."]);
    const goes = mailMessage(9, ["A synthetic notice the owner erases."]);
    const root = makeRoot("lifestream-imports-mail-erase-", { sources: { [MAILBOX]: "gmail-imap" }, defaults: false, fake: { reply: tag("Asked of the model.") }, settings: mailSettings({}) });
    roots.push(root);
    editSettings(root, { "model.defaults.text": FAKE_ROUTE });
    const sock = testSocket(root);
    const quiet = () => count(root, "SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')") === 0;
    const ledgerCount = (sql: string, ...params: unknown[]) => readLedger(root, (db) => db.prepare(sql).pluck().get(...params) as number) ?? 0;
    const imported = () => count(root, "SELECT count(*) FROM deliveries WHERE source = ? AND state IN ('imported', 'failed', 'dead')", MAILBOX);
    const tagged = () => readHome(root, (db) => db.prepare("SELECT item FROM enrichments WHERE family = 'mail' AND state = 'done' ORDER BY item").pluck().all()) as string[];
    const days = () => filesUnder(join(root, "days")).filter((file) => file.endsWith(".day.txt") && !file.startsWith("."))
      .map((file) => readFileSync(join(root, "days", file), "utf8")).join("\n");
    const subject = (each: Message) => `synthetic notice ${each.id.at(-1)}`;
    const blobs = (each: Message) => {
      const store = openHomeFolder(root).blobs(join(root, "blobs"), { reading: true });
      return [each.eml, mboxMessage(each.id, each.eml)].map((bytes) => store.has(`sha256:${hex(bytes)}`));
    };
    const left = (each: Message) => ({
      heads: count(root, "SELECT count(*) FROM heads WHERE source = ? AND kind = 'mailmsg' AND key = ?", MAILBOX, each.id),
      statements: count(root, "SELECT count(*) FROM statements WHERE source = ? AND kind = 'mailmsg' AND key = ?", MAILBOX, each.id),
      erasures: count(root, "SELECT count(*) FROM erasures WHERE kind = 'mailmsg' AND key = ?", each.id),
      enrichments: count(root, "SELECT count(*) FROM enrichments WHERE family = 'mail' AND item = ?", mailItem(each)),
      requests: ledgerCount("SELECT count(*) FROM requests WHERE unit = ?", mailItem(each)),
      replies: ledgerCount("SELECT count(*) FROM replies WHERE unit = ?", mailItem(each)),
      inbox: filesUnder(join(root, "inbox")).filter((file) => file.endsWith(`msg-${each.id}.eml`) || file.endsWith(hex(each.eml))).length,
    });
    const held = { heads: 1, statements: 2, erasures: 0, enrichments: 1, requests: 1, replies: 1, inbox: 1 };
    const none = { heads: 0, statements: 0, erasures: 1, enrichments: 0, requests: 0, replies: 0, inbox: 0 };
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    try {
      await pull(root, [stays, goes], PULLED);
      await takeout(root, [stays, goes], EXPORTED);
      await until("both tagged and printed", () => imported() === 2 && quiet() && tagged().length === 2 && days().includes(subject(goes)) && days().includes(subject(stays)));
      expect([left(stays), left(goes)]).toEqual([held, held]);

      const named = await askHome(sock, "erase", ["mail", mailItem(goes)]) as { applied: boolean; records: unknown[]; items: string[] };
      expect(named).toMatchObject({ applied: false, records: [{ source: MAILBOX, kind: "mailmsg", key: goes.id }], items: [mailItem(goes)] });
      expect(left(goes)).toEqual(held);
      const one = await askHome(sock, "erase", ["mail", mailItem(goes), "--apply"]) as { records: number; blobs: number };
      expect(one).toMatchObject({ records: 1, blobs: 2 });
      await until("the day rendered again", () => quiet() && days().includes(subject(stays)) && !days().includes(subject(goes)));
      expect([left(stays), left(goes)]).toEqual([held, none]);
      expect([blobs(stays), blobs(goes)]).toEqual([[true, true], [false, false]]);
      expect(tagged()).toEqual([mailItem(stays)]);
      expect(count(root, "SELECT count(*) FROM heads WHERE source = ? AND kind = 'chat' AND key = ?", MAILBOX, goes.id)).toBe(1);

      await pull(root, [goes], "2026-09-09T04:00:00.000Z");
      await takeout(root, [stays, goes], "2026-09-10T00:00:00.000Z");
      await until("both imported again", () => imported() === 4 && quiet());
      expect(left(goes)).toEqual({ ...none, inbox: left(goes).inbox });
      expect(days()).not.toContain(subject(goes));
      expect(tagged()).toEqual([mailItem(stays)]);

      const mailbox = await askHome(sock, "erase", ["mail", MAILBOX, "--apply"]) as { records: number };
      expect(mailbox.records).toBe(3);
      await until("the mailbox's days rendered again", () => quiet() && !days().includes(subject(stays)));
      expect(count(root, "SELECT count(*) FROM heads WHERE source = ?", MAILBOX)).toBe(0);
      expect(left(stays)).toMatchObject({ heads: 0, statements: 0, erasures: 1, enrichments: 0, requests: 0, replies: 0 });
      expect(ledgerCount("SELECT count(*) FROM requests")).toBe(0);
      expect(blobs(stays)).toEqual([false, false]);
      await pull(root, [stays], "2026-09-11T04:00:00.000Z");
      await until("the pull imported", () => imported() === 5 && quiet());
      expect(count(root, "SELECT count(*) FROM heads WHERE source = ?", MAILBOX)).toBe(0);
      artifact(root, "imports-mail-erase", { one, mailbox, stays: left(stays), goes: left(goes) });
    } finally {
      await home.stop();
    }
  });
});

function readPrefixOf(path: string, bytes: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    return buffer.subarray(0, readSync(fd, buffer, 0, bytes, 0));
  } finally {
    closeSync(fd);
  }
}

function writeSparseZip(path: string, small: [string, Buffer], size: number): void {
  const fd = openSync(path, "w");
  let offset = 0;
  const central: Buffer[] = [];
  const add = (name: string, length: number, crc: number, bytes: Buffer | null) => {
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(length, 18);
    local.writeUInt32LE(length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const at = offset;
    writeSync(fd, local, 0, local.length, offset);
    offset += local.length;
    writeSync(fd, nameBytes, 0, nameBytes.length, offset);
    offset += nameBytes.length;
    if (bytes !== null) writeSync(fd, bytes, 0, bytes.length, offset);
    offset += length;
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(crc >>> 0, 16);
    record.writeUInt32LE(length, 20);
    record.writeUInt32LE(length, 24);
    record.writeUInt16LE(nameBytes.length, 28);
    record.writeUInt32LE(at, 42);
    central.push(record, nameBytes);
  };
  add(small[0], small[1].length, crc32(small[1]), small[1]);
  const zero = Buffer.alloc(64 * 1024 ** 2);
  let crc = 0;
  for (let left = size; left > 0; left -= zero.length) crc = crc32(zero.subarray(0, Math.min(zero.length, left)), crc);
  add("Takeout/Google Photos/Photos from 2016/VID_0001.mp4", size, crc, null);
  const directory = Buffer.concat(central);
  writeSync(fd, directory, 0, directory.length, offset);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(2, 8);
  end.writeUInt16LE(2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  writeSync(fd, end, 0, end.length, offset + directory.length);
  closeSync(fd);
}
