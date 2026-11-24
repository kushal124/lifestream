import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openHome, openHomeFolder } from "@lifestreamprotocol/core";
import { readConnectors } from "./connectors.js";
import { BACKUP_PHONE, nameKey } from "./devices.js";
import { HELD, IMPORT_OF, type HeldImport } from "./imports.js";
import { mintPrincipal } from "./principals.js";
import { effective } from "./settings.js";
import { askHome } from "./socket.js";
import { artifact, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { doorHere } from "./test/harness-door.js";
import { startHere } from "./test/harness-home.js";
import { acquisitionBundle, DEVICE, phoneBundle, sha256 } from "./test/support.js";
import importsRegistry from "./test/imports-registry.js";
import { testSocket } from "./test/folder.js";
import { photosComing, photosStart } from "./status.js";

type BackupChange = import("../connect/imports/iphone-backup/test/fixture.js").BackupChange;
type BackupStore = import("../connect/imports/iphone-backup/import.js").BackupStore;
const { BACKUP, writeBackupFolders } = (await import(new URL("../connect/imports/iphone-backup/test/fixture.ts", import.meta.url).href)) as typeof import("../connect/imports/iphone-backup/test/fixture.js");

const REGISTRY = new URL("./test/imports-registry.ts", import.meta.url);
const MAC = "macbook-pro-0001";
const UPLOAD = `upload:local:${MAC}`;
const APPLE = BACKUP.accounts.apple[0]!;
const NUMBER = BACKUP.accounts.whatsapp[0]!.split("@")[0]!;
const PHONE = "iphone-17-pro-a1b2";
const OTHER = "iphone-15-b2c3";
const TWIN = "iphone-17-pro-c3d4";
const NEW_UNIT = `iphone-17-pro-${BACKUP.serial4}`;
const T0 = Date.parse("2026-10-27T08:00:00Z");
const STORES: readonly BackupStore[] = ["imessage", "whatsapp", "apple-calls"];

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) removeRoot(root);
});

interface Phone {
  unit: string;
  model: string;
  name?: string;
  account?: string;
  retired?: true;
  passless?: true;
  sent?: true;
}

async function backupHome(prefix: string, phones: readonly Phone[], sources: Record<string, string> = {}) {
  const root = makeRoot(prefix, { sources: { [UPLOAD]: "upload", ...sources } });
  roots.push(root);
  const principals = openHomeFolder(root);
  const { token } = mintPrincipal(principals, { unit: MAC, kind: "mac", scopes: ["deliver"], sources: [UPLOAD], now_ms: T0 });
  const phoneTokens = new Map<string, string>();
  for (const phone of phones) {
    if (phone.passless !== true) {
      phoneTokens.set(phone.unit, mintPrincipal(principals, { unit: phone.unit, kind: "phone", scopes: ["deliver", "read"], sources: [`phone:${phone.unit}`, `location:local:${phone.unit}`], account: phone.account ?? null, now_ms: T0 }).token);
    }
  }
  const db = openHome(openHomeFolder(root), "migrate");
  db.commit((tx) => {
    for (const phone of phones) {
      tx.tables.devices.add({ unit: phone.unit, model: phone.model, added_ms: T0 });
      if (phone.name !== undefined) tx.tables.meta.set(nameKey(phone.unit), phone.name);
      if (phone.retired === true) tx.tables.devices.retire(phone.unit, T0 + 1);
    }
  });
  db.close();
  const door = await doorHere(root);
  for (const phone of phones.filter((each) => each.sent === true)) {
    const bundle = phoneBundle({ domains: { "location.jsonl": [1] }, custody: { [`location:local:${phone.unit}`]: { seal: 1 } } });
    const response = await fetch(`${door.url}/v1/bundles/${bundle.id}`, { method: "PUT", headers: { authorization: `Bearer ${phoneTokens.get(phone.unit)}`, ...DEVICE.phone }, body: bundle.bytes });
    expect(response.status, await response.clone().text()).toBe(201);
  }
  const home = await startHere(root, { registry: REGISTRY, tickMs: TICK_MS, slot: null, log: () => undefined });
  let seal = 0;
  const headers = { authorization: `Bearer ${token}`, ...DEVICE.mac };
  return {
    root, sock: testSocket(root),
    url: door.url,
    async ship(folders: ReturnType<typeof writeBackupFolders>, store: BackupStore, blobs: readonly Buffer[] = []): Promise<string> {
      seal += 1;
      const files = Object.entries(folders.members[store]).sort(([a], [b]) => a.localeCompare(b))
        .map(([name, path]) => [`${store}/${name}`, readFileSync(path)] as [string, Buffer]);
      const index = Buffer.from(`${JSON.stringify({ format: "org.lifestreamprotocol.upload/1", files: files.map(([path]) => ({ path })) })}\n`);
      const bundle = acquisitionBundle({
        source: UPLOAD, feeder: "import-mac", fetched_ms: T0 + seal * 60_000,
        files: [["upload.json", index], ...files.map(([path, bytes]) => [`files/${path}`, bytes] as [string, Buffer])],
        facts: { import: { kind: "iphone-backup" }, history: true } as never,
        custody: { [UPLOAD]: { seal } }, blobs,
        manifest: (manifest) => ({ ...manifest, facts: Object.fromEntries(Object.entries(manifest.facts as Record<string, unknown>).filter(([key]) => key !== "snapshot_taken_at")) }),
      });
      const response = await fetch(`${door.url}${bundle.path}`, { method: "PUT", headers, body: bundle.bytes });
      expect(response.status, await response.clone().text()).toBe(201);
      return bundle.id;
    },
    async stop() {
      await home.stop();
      await door.stop();
    },
  };
}

const backup = (change: BackupChange = {}) => writeBackupFolders(mkdtempSync(join(tmpdir(), "lifestream-backup-folders-")), change);

const meta = (root: string, key: string): string | undefined => readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(key)) as string | undefined;
const held = (root: string): HeldImport[] => Object.values(JSON.parse(meta(root, HELD) ?? "{}") as Record<string, HeldImport>);
const sources = (root: string): string[] => readHome(root, (db) => db.prepare("SELECT id FROM sources ORDER BY id").pluck().all()) as string[];
const devices = (root: string): { unit: string; model: string }[] => readHome(root, (db) => db.prepare("SELECT unit, model FROM devices ORDER BY unit").all()) as { unit: string; model: string }[];
const admitted = (root: string, delivery: string): boolean => meta(root, `${IMPORT_OF}${delivery}`) !== undefined || meta(root, `import-void:${delivery}`) !== undefined;
const phoneOf = (root: string, device = BACKUP.device): string | undefined => meta(root, `${BACKUP_PHONE}${device}`);
const backupSources = (root: string): string[] => sources(root).filter((id) => /^(imessage|whatsapp|apple-calls):/u.test(id));

const importsReport = (root: string) => readHome(root, (db) => readConnectors(db, {
  folder: openHomeFolder(root), now_ms: Date.now(), settings: effective(root).settings, registry: importsRegistry(), machine: process.env.LIFESTREAM_MACHINE_DIR!, sites: null, present: [], needs: [],
  free_bytes: Number.MAX_SAFE_INTEGER, stated: null, photos: photosComing(db, photosStart(effective(root).settings, importsRegistry().connectors, Date.now())),
})).imports;

const streams = (root: string, now_ms = Date.now()) => readHome(root, (db) => readConnectors(db, {
  folder: openHomeFolder(root), now_ms, settings: effective(root).settings, registry: importsRegistry(), machine: process.env.LIFESTREAM_MACHINE_DIR!, sites: null, present: [], needs: [],
  free_bytes: Number.MAX_SAFE_INTEGER, stated: null, photos: photosComing(db, photosStart(effective(root).settings, importsRegistry().connectors, now_ms)),
}));

const mediaOf = (folders: ReturnType<typeof backup>): Record<string, { sha256: string; bytes: number }> =>
  (JSON.parse(readFileSync(folders.members.whatsapp["media.json"]!, "utf8")) as { entries: Record<string, { sha256: string; bytes: number }> }).entries;
const carried = (folders: ReturnType<typeof backup>): Buffer[] => Object.keys(mediaOf(folders)).map((pointer) => readFileSync(join(folders.media.whatsapp, pointer)));
function without(folders: ReturnType<typeof backup>, under: string): ReturnType<typeof backup> {
  const entries = Object.fromEntries(Object.entries(mediaOf(folders)).filter(([pointer]) => !pointer.startsWith(under)));
  writeFileSync(folders.members.whatsapp["media.json"]!, `${JSON.stringify({ format: "org.lifestreamprotocol.blob-index/1", entries })}\n`);
  return folders;
}
const countsOf = (root: string, delivery: string): Record<string, number> | undefined => readHome(root, (db) => {
  const counts = db.prepare("SELECT r.counts FROM deliveries d JOIN runs r ON r.id = d.run WHERE d.id = ? AND d.state = 'imported' AND d.source NOT LIKE 'upload:%'").pluck().get(delivery) as string | undefined;
  return counts === undefined ? undefined : JSON.parse(counts) as Record<string, number>;
});
const readWhole = (root: string, deliveries: readonly string[]): boolean => readHome(root, (db) => deliveries.every((id) => {
  const states = db.prepare("SELECT state FROM deliveries WHERE id = ? AND source NOT LIKE 'upload:%'").pluck().all(id) as string[];
  return states.length > 0 && states.every((state) => state === "imported");
}));
const headOf = (root: string, source: string, stanza: string): { id: string; text: string } | undefined => readHome(root, (db) =>
  db.prepare("SELECT v.id, v.text FROM heads h JOIN versions v ON v.id = h.version WHERE h.source = ? AND h.key LIKE ?").get(source, `%:${stanza}`)) as { id: string; text: string } | undefined;
const heldOf = (root: string, source: string): number => readHome(root, (db) => db.prepare("SELECT count(*) FROM heads WHERE source = ? AND version <> 'gone'").pluck().get(source)) as number;

function record(root: string): void {
  artifact(root, "iphone-backup.json", { imports: held(root), sources: sources(root), devices: devices(root), phones: Object.fromEntries(readHome(root, (db) =>
    db.prepare("SELECT key, value FROM meta WHERE key LIKE 'backup-phone:%'").all() as { key: string; value: string }[]).map((row) => [row.key, row.value])) });
}

describe("the iPhone backup at the home", () => {
  it("lands a backup of a phone whose stores the home holds on that phone's unit, unasked, as two imports and no new device, and voids the same folders again", async () => {
    const home = await backupHome("lifestream-backup-held-", [{ unit: PHONE, model: "iPhone 17 Pro", name: "Work iPhone", account: APPLE }, { unit: OTHER, model: "iPhone 15" }], {
      [`whatsapp:${NUMBER}:${PHONE}`]: "whatsapp-db",
    });
    try {
      const before = devices(home.root);
      const folders = backup();
      const first = await home.ship(folders, "imessage");
      await until("the iMessage folder admitted", () => admitted(home.root, first));
      expect(phoneOf(home.root)).toBe(PHONE);
      const shipped = [first, await home.ship(folders, "apple-calls"), await home.ship(folders, "whatsapp")];
      await until("the three folders admitted", () => shipped.every((id) => admitted(home.root, id)));
      await until("the three folders read", () => readWhole(home.root, shipped));
      expect(phoneOf(home.root)).toBe(PHONE);
      expect(importsReport(home.root).find((each) => each.kind === "iphone-backup")!.which).toEqual([]);
      expect(backupSources(home.root)).toEqual([`apple-calls:${APPLE}:${PHONE}`, `imessage:${APPLE}:${PHONE}`, `whatsapp:${NUMBER}:${PHONE}`]);
      expect(devices(home.root)).toEqual(before);
      const imports = held(home.root).filter((each) => each.kind === "iphone-backup");
      expect(imports.map((each) => ({ account: each.account, stamp: each.stamp, unit: each.unit, files: each.deliveries.length })).sort((a, b) => a.stamp!.localeCompare(b.stamp!))).toEqual([
        { account: APPLE, stamp: `${BACKUP.device}:${BACKUP.last_backup}:apple`, unit: PHONE, files: 2 },
        { account: NUMBER, stamp: `${BACKUP.device}:${BACKUP.last_backup}:whatsapp`, unit: PHONE, files: 1 },
      ]);
      const again = await home.ship(folders, "whatsapp");
      await until("the same folder admitted again", () => admitted(home.root, again));
      expect(meta(home.root, `import-void:${again}`)).toBeDefined();
      expect(backupSources(home.root)).toHaveLength(3);
      const kinds = importsReport(home.root);
      expect(kinds.map((each) => [each.kind, each.lists ?? null])).toEqual(kinds.map((each) => [each.kind, each.kind === "iphone-backup" ? "backups" : null]));
      const report = kinds.find((each) => each.kind === "iphone-backup")!;
      expect(report.held.map((each) => each.downloaded)).toEqual([null, null]);
      expect(report.held.map((each) => each.name)).toEqual([0, 1].map(() => expect.stringMatching(/^Work iPhone · backup of 28 Aug(?: 2026)?$/u)));
      expect(report.line).toMatch(/^Imported \d{1,2} [A-Z][a-z]{2}(?: \d{4})? · Calls, iMessage, 1 more$/u);
      expect([report.reads, report.products.map((each) => each.name)]).toEqual([null, ["Calls", "iMessage", "WhatsApp"]]);
      const whatsapp = report.held.find((each) => each.products.map((product) => product.id).join() === "whatsapp")!;
      expect(whatsapp.line.split(" · ").at(-1)).toBe(whatsapp.products[0]!.line.split(" · ").at(-1));
      record(home.root);
    } finally {
      await home.stop();
    }
  });

  it("never takes the Mac's own source for the phone: three phones, two of one model, one retired, nothing matching asks which, each phone told apart by when the home last heard from it, feeds nothing until answered, then never asks that device again", async () => {
    const home = await backupHome("lifestream-backup-asked-", [{ unit: PHONE, model: "iPhone 17 Pro", account: APPLE, sent: true }, { unit: TWIN, model: "iPhone 17 Pro" },
      { unit: OTHER, model: "iPhone 15", retired: true }], {
      [`whatsapp:${NUMBER}:${MAC}`]: "whatsapp-db",
    });
    try {
      const folders = backup();
      const whatsapp = await home.ship(folders, "whatsapp");
      await until("the WhatsApp folder admitted", () => admitted(home.root, whatsapp));
      const [id, asked] = Object.entries(JSON.parse(meta(home.root, HELD)!) as Record<string, HeldImport>).find(([, each]) => each.kind === "iphone-backup")!;
      expect(asked).toMatchObject({ account: NUMBER, unit: null, device: { device: BACKUP.device, model_name: BACKUP.model_name } });
      expect(phoneOf(home.root)).toBeUndefined();
      expect(backupSources(home.root)).toEqual([`whatsapp:${NUMBER}:${MAC}`]);
      await expect(askHome(home.sock, "act", [`import:${id}:whose`, "choose", "15550000009"])).rejects.toMatchObject({ status: 409, code: "NOT_OFFERED" });
      const imessage = await home.ship(folders, "imessage");
      await until("the iMessage folder admitted", () => admitted(home.root, imessage));
      const appleId = Object.entries(JSON.parse(meta(home.root, HELD)!) as Record<string, HeldImport>).find(([, each]) => each.kind === "iphone-backup" && each.account === APPLE)![0];
      const kind = importsReport(home.root).find((each) => each.kind === "iphone-backup")!;
      const which = kind.which!;
      expect(which).toHaveLength(1);
      expect(which[0]!.imports.sort()).toEqual([id, appleId].sort());
      expect({ ...which[0]!, imports: [] }).toEqual({
        need: `import:${which[0]!.imports[0]}:which`, words: "Which iPhone is this backup from?", line: expect.stringMatching(/^iPhone 17 Pro · 28 Aug 2026$/u), imports: [],
        choices: [
          { unit: PHONE, words: "iPhone 17 Pro", line: expect.stringMatching(/^last heard from \d{1,2} [A-Z][a-z]{2}$/u) },
          { unit: TWIN, words: "iPhone 17 Pro", line: "nothing sent yet" },
          { unit: OTHER, words: "iPhone 15", line: "removed" },
          { unit: "new", words: "An iPhone not set up with Lifestream", line: "" },
        ],
        choose: "Choose",
      });
      expect(kind.held.map((each) => [each.ask, each.line, each.health.state])).toEqual([[null, which[0]!.words, "needs-you"], [null, which[0]!.words, "needs-you"]]);
      expect(kind.held.flatMap((each) => each.files.map((file) => [file.name, file.acts.map((act) => act.label)])).sort()).toEqual([["WhatsApp", ["Remove file"]], ["iMessage", ["Remove file"]]]);
      expect(kind.held.map((each) => each.name)).toEqual([0, 1].map(() => expect.stringMatching(/^iPhone 17 Pro · backup of 28 Aug(?: 2026)?$/u)));
      expect(streams(home.root).needs.filter((need) => need.id.endsWith(":which")).map((need) => need.id)).toEqual([which[0]!.need]);
      await expect(askHome(home.sock, "act", [`import:${id}:which`, "choose", MAC])).rejects.toMatchObject({ status: 422, code: "BAD_REQUEST" });
      await askHome(home.sock, "act", [which[0]!.need, "choose", OTHER]);
      await until("the answered imports fed", () => [`whatsapp:${NUMBER}:${OTHER}`, `imessage:${APPLE}:${OTHER}`].every((source) => backupSources(home.root).includes(source)));
      expect(phoneOf(home.root)).toBe(OTHER);
      const answered = importsReport(home.root).find((each) => each.kind === "iphone-backup")!;
      expect(answered.which).toEqual([]);
      expect(answered.held.map((each) => each.name)).toEqual([0, 1].map(() => expect.stringMatching(/^iPhone 15 · backup of 28 Aug(?: 2026)?$/u)));
      const apple = [imessage, await home.ship(folders, "apple-calls")];
      const later = backup({ last_backup: "2026-09-28T09:12:44Z" });
      const next = await home.ship(later, "whatsapp");
      await until("the rest admitted", () => [...apple, next].every((each) => admitted(home.root, each)));
      expect(held(home.root).filter((each) => each.kind === "iphone-backup").every((each) => each.unit === OTHER)).toBe(true);
      expect(backupSources(home.root)).toEqual([`apple-calls:${APPLE}:${OTHER}`, `imessage:${APPLE}:${OTHER}`, `whatsapp:${NUMBER}:${OTHER}`, `whatsapp:${NUMBER}:${MAC}`]);
      record(home.root);
    } finally {
      await home.stop();
    }
  });

  it("makes a new phone's unit unasked on a home with no phone, taking a unit of that id the home holds already", async () => {
    const home = await backupHome("lifestream-backup-new-", [{ unit: NEW_UNIT, model: "iPhone 17 Pro", passless: true }]);
    try {
      const folders = backup();
      const shipped: string[] = [];
      for (const store of STORES) shipped.push(await home.ship(folders, store));
      await until("the three folders admitted", () => shipped.every((id) => admitted(home.root, id)));
      expect(phoneOf(home.root)).toBe(NEW_UNIT);
      expect(devices(home.root)).toEqual([{ unit: NEW_UNIT, model: "iPhone 17 Pro" }]);
      expect(backupSources(home.root)).toEqual([`apple-calls:${APPLE}:${NEW_UNIT}`, `imessage:${APPLE}:${NEW_UNIT}`, `whatsapp:${NUMBER}:${NEW_UNIT}`]);
      await until("the backup read", () => readWhole(home.root, shipped));
      const later = streams(home.root, Date.now() + 30 * 24 * 3_600_000);
      expect(later.devices.map((device) => device.unit)).not.toContain(NEW_UNIT);
      const copies = later.connectors.flatMap((connector) => connector.copies).filter((copy) => copy.id.endsWith(`:${NEW_UNIT}`));
      expect(copies.map((copy) => copy.id).sort()).toEqual(backupSources(home.root));
      expect(copies.filter((copy) => copy.health.state === "quiet" && copy.health.reason === "device")).toEqual([]);
      const other = backup({ device: "0123456789abcdef", accounts: { apple: [], whatsapp: ["15550000002@s.whatsapp.net"] }, serial4: "beef" });
      const asked = await home.ship(other, "whatsapp");
      await until("the other phone's folder admitted", () => admitted(home.root, asked));
      expect(held(home.root).find((each) => each.device?.device === "0123456789abcdef")).toMatchObject({ unit: null });
      const pair = async (body: Record<string, unknown>) => {
        const { code } = await askHome(home.sock, "pair", []) as { code: string };
        const response = await fetch(`${home.url}/v1/pair`, { method: "POST", headers: { ...DEVICE.phone, "content-type": "application/json" },
          body: JSON.stringify({ kind: "phone", model: "iPhone 17 Pro", pass: randomBytes(32).toString("base64url"), code, ...body }) });
        return { status: response.status, body: await response.json() as Record<string, unknown> };
      };
      const which = await pair({});
      expect([which.status, which.body.code, which.body.phones]).toEqual([409, "PAIR_WHICH_PHONE", [{ unit: NEW_UNIT, model: "iPhone 17 Pro", account: null, last_ms: null }]]);
      const continued = await pair({ unit: NEW_UNIT });
      expect([continued.status, continued.body.unit]).toEqual([200, NEW_UNIT]);
      expect(streams(home.root).devices.map((device) => device.unit)).toContain(NEW_UNIT);
      record(home.root);
    } finally {
      await home.stop();
    }
  });

  it("lands a newer backup's richer record as a new version and head and the rest restated, an older backup's late under the head, and the media a bundle carries", async () => {
    const home = await backupHome("lifestream-backup-again-", []);
    const source = `whatsapp:${NUMBER}:${NEW_UNIT}`;
    const photo = "Media/15550000002/a.";
    try {
      const august = without(backup(), photo);
      const first = await home.ship(august, "whatsapp", carried(august));
      await until("August's backup read", () => readWhole(home.root, [first]));
      const records = heldOf(home.root, source);
      const before = headOf(home.root, source, "SYNTH-1")!;
      const media = mediaOf(backup());
      const hash = Object.entries(media).find(([pointer]) => pointer === `${photo}jpg`)![1].sha256;
      expect(before.text).not.toContain(hash);
      const blobs = openHomeFolder(home.root).blobs(join(home.root, "blobs"), { reading: true });
      for (const entry of Object.values(mediaOf(august))) expect(blobs.has(`sha256:${entry.sha256}`)).toBe(true);
      expect(blobs.has(`sha256:${hash}`)).toBe(false);

      const september = backup({ last_backup: "2026-09-28T09:12:44Z" });
      const lacking = carried(september).filter((bytes) => !blobs.has(`sha256:${sha256(bytes)}`));
      expect(lacking.length).toBeGreaterThan(0);
      const second = await home.ship(september, "whatsapp", lacking);
      await until("September's backup read", () => readWhole(home.root, [second]));
      const newer = countsOf(home.root, second)!;
      expect([newer.new ?? 0, newer.changed, newer.late ?? 0]).toEqual([0, 1, 0]);
      expect(newer.restated).toBeGreaterThan(0);
      expect(heldOf(home.root, source)).toBe(records);
      const after = headOf(home.root, source, "SYNTH-1")!;
      expect(after.id).not.toBe(before.id);
      expect(after.text).toContain(hash);
      expect(blobs.has(`sha256:${hash}`)).toBe(true);

      const july = without(backup({ last_backup: "2026-07-28T09:12:44Z" }), photo);
      const third = await home.ship(july, "whatsapp");
      await until("July's backup read", () => readWhole(home.root, [third]));
      const older = countsOf(home.root, third)!;
      expect([older.new ?? 0, older.changed ?? 0, older.late]).toEqual([0, 0, 1]);
      expect(headOf(home.root, source, "SYNTH-1")).toEqual(after);
      expect(heldOf(home.root, source)).toBe(records);
      record(home.root);
    } finally {
      await home.stop();
    }
  });

  it("asks whose WhatsApp a backup naming none is, offering the home's WhatsApp accounts, and whose Apple ID, offering its Apple ones", async () => {
    const OTHER_NUMBER = "15550000003";
    const OTHER_APPLE = "person-z@example.com";
    const home = await backupHome("lifestream-backup-whose-", [], { [`whatsapp:${OTHER_NUMBER}:${MAC}`]: "whatsapp-db", [`imessage:${OTHER_APPLE}:${MAC}`]: "imessage-db" });
    try {
      const folders = backup({ accounts: { apple: [], whatsapp: [] } });
      const shipped = [await home.ship(folders, "whatsapp"), await home.ship(folders, "imessage")];
      await until("both folders admitted", () => shipped.every((id) => admitted(home.root, id)));
      expect(phoneOf(home.root)).toBe(NEW_UNIT);
      const kind = importsReport(home.root).find((each) => each.kind === "iphone-backup")!;
      expect(kind.which).toEqual([]);
      expect(kind.held.map((each) => [each.ask?.words, each.ask?.choices]).sort()).toEqual([
        ["Whose Apple ID is on this iPhone?", [OTHER_APPLE]],
        ["Whose WhatsApp is on this iPhone?", [OTHER_NUMBER]],
      ]);
      record(home.root);
    } finally {
      await home.stop();
    }
  });

  it("answers whose Apple ID a Messages-in-iCloud backup is by its phone's pass, its calls placed by the WhatsApp number the backup states though they land first", async () => {
    const home = await backupHome("lifestream-backup-icloud-", [{ unit: PHONE, model: "iPhone 17 Pro", account: APPLE }, { unit: OTHER, model: "iPhone 15" }], {
      [`whatsapp:${NUMBER}:${PHONE}`]: "whatsapp-db",
    });
    try {
      const folders = backup({ accounts: { apple: [], whatsapp: BACKUP.accounts.whatsapp } });
      const calls = await home.ship(folders, "apple-calls");
      await until("the calls fed under the phone, by its pass's Apple ID", () => backupSources(home.root).includes(`apple-calls:${APPLE}:${PHONE}`));
      expect(phoneOf(home.root)).toBe(PHONE);
      expect(admitted(home.root, calls)).toBe(true);
      const whatsapp = await home.ship(folders, "whatsapp");
      await until("the WhatsApp folder admitted", () => admitted(home.root, whatsapp));
      expect(held(home.root).filter((each) => each.kind === "iphone-backup").map((each) => [each.account, each.unit, each.answered ?? false]).sort()).toEqual([
        [NUMBER, PHONE, false], [APPLE, PHONE, false],
      ]);
      record(home.root);
    } finally {
      await home.stop();
    }
  });
});
