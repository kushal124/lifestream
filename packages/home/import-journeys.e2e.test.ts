import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openHome, openHomeFolder } from "@lifestreamprotocol/core";
import { readConnectors } from "./connectors.js";
import { ANCHOR, FILES, HELD, type AdmittedFile, type HeldImport } from "./imports.js";
import { filesAt, IMPORT_LANE } from "./import-file.js";
import { HANDED } from "./handed.js";
import type { ImportAnswer } from "./verbs/import.js";
import { mintPrincipal } from "./principals.js";
import { effective } from "./settings.js";
import { askHome } from "./socket.js";
import { artifact, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { doorHere } from "./test/harness-door.js";
import { startHere } from "./test/harness-home.js";
import { acquisitionBundle, DEVICE, phoneBundle, sha256, zip } from "./test/support.js";
import importsRegistry from "./test/imports-registry.js";
import { testSocket } from "./test/folder.js";
import { photosComing, photosStart } from "./status.js";

const ai = (await import(new URL("../connect/ai/test/fixtures.ts", import.meta.url).href)) as typeof import("../connect/ai/test/fixtures.js");
const spotify = (await import(new URL("../connect/listening/spotify/test/fixtures.ts", import.meta.url).href)) as typeof import("../connect/listening/spotify/test/fixtures.js");
const timeline = (await import(new URL("../connect/location/google-timeline/test/fixtures.ts", import.meta.url).href)) as typeof import("../connect/location/google-timeline/test/fixtures.js");

const REGISTRY = new URL("./test/imports-registry.ts", import.meta.url);
const MAC = "macbook-pro-0001";
const UPLOAD = `upload:local:${MAC}`;
const T0 = Date.parse("2026-10-27T08:00:00Z");
const A = "person-a@example.com";
const SEARCH = `google-search:${A}:export`;
const STAMP = "20260814T091500Z";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) removeRoot(root);
});

async function home(prefix: string) {
  const root = makeRoot(prefix, { sources: { [UPLOAD]: "upload" } });
  roots.push(root);
  const { token } = mintPrincipal(openHomeFolder(root), { unit: MAC, kind: "mac", scopes: ["deliver"], sources: [UPLOAD], now_ms: T0 });
  const door = await doorHere(root);
  await startHere(root, { registry: REGISTRY, tickMs: TICK_MS, slot: null, log: () => undefined });
  const downloads = mkdtempSync(join(tmpdir(), "lifestream-downloads-"));
  roots.push(downloads);
  const sock = testSocket(root);
  const answers: unknown[] = [];
  return {
    root, door, token, sock, downloads, answers,
    put(files: Readonly<Record<string, Buffer>>): string {
      for (const [path, bytes] of Object.entries(files)) {
        mkdirSync(dirname(join(downloads, path)), { recursive: true });
        writeFileSync(join(downloads, path), bytes);
      }
      return join(downloads, Object.keys(files)[0]!.split("/")[0]!);
    },
    async import(kind: string, path: string, account?: string): Promise<ImportAnswer> {
      const answer = await askHome(sock, "import", [kind, path, ...(account === undefined ? [] : ["--account", account])]) as ImportAnswer;
      answers.push(answer);
      return answer;
    },
  };
}

const meta = (root: string, key: string): string | undefined => readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(key)) as string | undefined;
const held = (root: string): Record<string, HeldImport> => JSON.parse(meta(root, HELD) ?? "{}") as Record<string, HeldImport>;
const admitted = (root: string): Record<string, AdmittedFile> => JSON.parse(meta(root, FILES) ?? "{}") as Record<string, AdmittedFile>;
const rows = (root: string, delivery: string) => readHome(root, (db) => db.prepare("SELECT source, state, refused FROM deliveries WHERE id = ? ORDER BY source").all(delivery)) as { source: string; state: string; refused: number }[];
const heads = (root: string, source: string): string[] => readHome(root, (db) => db.prepare("SELECT kind || ' ' || key FROM heads WHERE source = ? AND version <> 'gone' ORDER BY 1").pluck().all(source)) as string[];
const versions = (root: string, source: string): number => readHome(root, (db) => db.prepare("SELECT count(*) FROM statements WHERE source = ?").pluck().get(source)) as number;
const read = (root: string, delivery: string): boolean => rows(root, delivery).length > 0 && rows(root, delivery).every((row) => row.state === "imported");
const reportOf = (root: string) => readHome(root, (db) => readConnectors(db, {
  folder: openHomeFolder(root), now_ms: Date.now(), settings: effective(root).settings, registry: importsRegistry(), machine: process.env.LIFESTREAM_MACHINE_DIR!,
  sites: null, present: [], needs: [], free_bytes: Number.MAX_SAFE_INTEGER, stated: null, photos: photosComing(db, photosStart(effective(root).settings, importsRegistry().connectors, Date.now())),
}));
const importsOf = (root: string) => reportOf(root).imports;
const heldOf = (root: string, kind: string) => importsOf(root).find((each) => each.kind === kind)!.held;
const needsOf = (root: string, kind: string): string[] => reportOf(root).needs.filter((need) => need.connector === kind).map((need) => need.id);
async function lookedAt(at: { door: { url: string }; token: string }, files: object[]): Promise<[number, unknown]> {
  const asked = await fetch(`${at.door.url}/v1/imports/held`, { method: "POST", headers: { authorization: `Bearer ${at.token}`, ...DEVICE.mac, "content-type": "application/json" }, body: JSON.stringify({ files }) });
  return [asked.status, await asked.json()];
}
const inInbox = (root: string, delivery: string): boolean => existsSync(join(root, "inbox", ...delivery.split("/")));

describe("an export brought in by lifestream import", () => {
  it("Spotify: answered whose by --account, read once, the same file again in already, another account's history asked again and landing nothing; the person's file untouched", async () => {
    const at = await home("lifestream-import-spotify-");
    const zipped = at.put(spotify.spotifyHanded(spotify.spotifyDownload("first")));
    const bytes = readFileSync(zipped);
    const first = await at.import("spotify", zipped, spotify.SPOTIFY_ACCOUNT);
    expect(first.import).toMatch(/^[0-9a-f]{16}$/u);
    await until("the export read", () => read(at.root, first.delivery));
    expect(rows(at.root, first.delivery).map((row) => [row.source, row.refused])).toEqual([[spotify.SPOTIFY_SOURCE, 0]]);
    expect(heads(at.root, spotify.SPOTIFY_SOURCE).length).toBeGreaterThan(0);
    expect(held(at.root)[first.import!]).toMatchObject({ kind: "spotify", account: spotify.SPOTIFY_ACCOUNT, answered: true });
    expect(meta(at.root, `${ANCHOR}${spotify.SPOTIFY_SOURCE}`)).toEqual(expect.any(String));
    await until("the import in", () => heldOf(at.root, "spotify").find((each) => each.id === first.import)?.notice !== null);
    const done = heldOf(at.root, "spotify").find((each) => each.id === first.import)!;
    expect(done.notice).toEqual({ title: "Spotify imported", body: done.line.slice("Imported · ".length) });
    expect([heads(at.root, spotify.SPOTIFY_SOURCE).length, done.line]).toEqual([6, "Imported · 2025–2026 · 6\u00a0plays"]);
    const landed = versions(at.root, spotify.SPOTIFY_SOURCE);

    const again = await at.import("spotify", zipped);
    expect([again.import, again.line, rows(at.root, again.delivery)]).toEqual([null, "Already imported", []]);

    const other = at.put({ "other/my_spotify_data.zip": spotify.spotifyHanded(spotify.otherHistory())[spotify.SPOTIFY_ZIP]! });
    const theirs = await at.import("spotify", join(other, "my_spotify_data.zip"), spotify.SPOTIFY_ACCOUNT);
    expect(held(at.root)[theirs.import!]).toMatchObject({ account: null, refused: expect.stringContaining("isn't the same account's history") });
    expect([rows(at.root, theirs.delivery), versions(at.root, spotify.SPOTIFY_SOURCE)]).toEqual([[], landed]);
    expect(theirs.line).toContain("isn't the same account's history");
    expect(heldOf(at.root, "spotify").find((each) => each.id === theirs.import)!.notice).toBeNull();

    expect(readFileSync(zipped).equals(bytes)).toBe(true);
    artifact(at.root, "import-journeys", { answers: at.answers, imports: importsOf(at.root) });
  });

  it("ChatGPT: a zip handed to Timeline refused whole and never admitted, Skip it taking the import, its need and its file; then read at ChatGPT's own window", async () => {
    const at = await home("lifestream-import-chatgpt-");
    const zipped = at.put(ai.chatgptHanded("first", "zip"));
    const wrong = await at.import("google-timeline", zipped);
    expect(held(at.root)[wrong.import!]).toMatchObject({ kind: "google-timeline", ended: true });
    expect(Object.keys(admitted(at.root))).toEqual([]);
    expect(needsOf(at.root, "google-timeline")).toEqual([`import:${wrong.import!}:refused`]);
    expect(await askHome(at.sock, "act", [`import:${wrong.import!}:refused`, "skip"])).toEqual({ acted: "skipped" });
    expect([held(at.root)[wrong.import!], heldOf(at.root, "google-timeline"), needsOf(at.root, "google-timeline")]).toEqual([undefined, [], []]);
    await until("the refused file swept", () => !inInbox(at.root, wrong.delivery));
    const right = await at.import("chatgpt", zipped);
    await until("the export read", () => read(at.root, right.delivery));
    expect(rows(at.root, right.delivery).map((row) => [row.source, row.refused])).toEqual([[ai.CHATGPT_SOURCE, 0]]);
    expect(heads(at.root, ai.CHATGPT_SOURCE).length).toBeGreaterThan(0);
    expect(Object.keys(admitted(at.root))).toEqual([expect.stringMatching(/^chatgpt\/[0-9a-f]{64}$/u)]);
    artifact(at.root, "import-journeys", { answers: at.answers, imports: importsOf(at.root) });
  });

  it("Claude: its zip, then the folder it unzips to, one source, nothing landed twice", async () => {
    const at = await home("lifestream-import-claude-");
    const zipped = at.put(ai.claudeHanded("first", "zip"));
    const first = await at.import("claude", zipped);
    await until("the zip read", () => read(at.root, first.delivery));
    const source = rows(at.root, first.delivery)[0]!.source;
    expect(source).toMatch(new RegExp(`^claude:${ai.CLAUDE_ACCOUNT}:`, "u"));
    const landed = { heads: heads(at.root, source), versions: versions(at.root, source) };
    expect(landed.heads.length).toBeGreaterThan(0);
    const folder = at.put(ai.claudeHanded("first", "folder"));
    const second = await at.import("claude", folder);
    await until("the folder read", () => read(at.root, second.delivery));
    expect([rows(at.root, second.delivery).map((row) => row.source), { heads: heads(at.root, source), versions: versions(at.root, source) }]).toEqual([[source], landed]);
    artifact(at.root, "import-journeys", { answers: at.answers, imports: importsOf(at.root) });
  });

  it("Claude: its export in three zips, the batch and the conversations read, the light zip of what it leaves refused whole as nothing Lifestream reads, never admitted", async () => {
    const at = await home("lifestream-import-claude-parts-");
    const parts = ai.claudeParts("first");
    const light = await at.import("claude", at.put(parts.light));
    expect([light.line, held(at.root)[light.import!]?.ended, held(at.root)[light.import!]?.refused, rows(at.root, light.delivery), admitted(at.root)]).toEqual([
      "Nothing Lifestream reads yet", true, "Nothing Lifestream reads yet", [], {}]);
    expect(needsOf(at.root, "claude")).toEqual([`import:${light.import!}:refused`]);
    const batch = await at.import("claude", at.put(parts.batch));
    const conversations = await at.import("claude", at.put(parts.conversations));
    await until("both read", () => read(at.root, batch.delivery) && read(at.root, conversations.delivery));
    const source = `claude:${ai.CLAUDE_ACCOUNT}:cloud`;
    expect([rows(at.root, batch.delivery), rows(at.root, conversations.delivery)].map((each) => each.map((row) => [row.source, row.refused]))).toEqual([[[source, 0]], [[source, 0]]]);
    expect(heads(at.root, source).length).toBeGreaterThan(0);
    const kind = importsOf(at.root).find((each) => each.kind === "claude")!;
    expect([kind.recognise, kind.leaves.includes("**/login_history.json")]).toEqual([["**/conversations.json"], true]);
    artifact(at.root, "import-journeys", { answers: at.answers, imports: importsOf(at.root) });
  });

  it("Timeline: a file asked whose let go, the import, its need and its file gone with it; the same file again asked anew", async () => {
    const at = await home("lifestream-import-timeline-let-go-");
    const file = at.put(timeline.timelineHanded("file"));
    const asked = await at.import("google-timeline", file);
    const [only] = heldOf(at.root, "google-timeline").find((each) => each.id === asked.import)!.files;
    expect([only!.state, only!.acts.map((act) => act.do), needsOf(at.root, "google-timeline")]).toEqual(["held", ["let-go"], [`import:${asked.import!}:whose`]]);
    const digest = Object.keys(admitted(at.root))[0]!.slice("google-timeline/".length);
    expect(await askHome(at.sock, "act", [`import:${asked.import!}:file:${only!.id}`, "let-go"])).toEqual({ acted: "let-go" });
    expect([held(at.root)[asked.import!], heldOf(at.root, "google-timeline"), needsOf(at.root, "google-timeline"), admitted(at.root)]).toEqual([undefined, [], [], {}]);
    expect(await lookedAt(at, [{ kind: "google-timeline", digest }])).toEqual([200, { held: [{ kind: "google-timeline", digest, state: "let-go" }] }]);
    await until("the let-go file swept", () => !inInbox(at.root, asked.delivery));
    const again = await at.import("google-timeline", file);
    expect([again.import, again.line, needsOf(at.root, "google-timeline")]).toEqual([asked.import, "Whose Google Maps Timeline is this?", [`import:${asked.import!}:whose`]]);
    expect(await lookedAt(at, [{ kind: "google-timeline", digest }])).toEqual([200, { held: [{ kind: "google-timeline", digest, state: "in" }] }]);
  });

  it("Takeout: a file holding nothing a reader reads, or one that does not open, refused whole in the Mac's words, never admitted or asked", async () => {
    const at = await home("lifestream-import-takeout-none-");
    const unread = await at.import("google-takeout", at.put({ [`takeout-${STAMP}-1-001.zip`]: zip([["Takeout/Drive/notes.txt", Buffer.from("synthetic note")]]) }));
    const broken = await at.import("google-takeout", at.put({ [`takeout-${STAMP}-2-001.zip`]: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("synthetic bytes, no zip")]) }));
    expect([unread.line, broken.line, held(at.root)[unread.import!]?.ended, held(at.root)[broken.import!]?.ended, admitted(at.root)]).toEqual([
      "Nothing Lifestream reads yet", "Didn't open · Download it again", true, true, {}]);
    expect(needsOf(at.root, "google-takeout").sort()).toEqual([`import:${unread.import!}:refused`, `import:${broken.import!}:refused`].sort());
  });

  it("Takeout: My Activity alone, whose records print no day line, is in with its span and no day to open", async () => {
    const at = await home("lifestream-import-takeout-activity-");
    const activity = Buffer.from(JSON.stringify([
      { header: "Search", title: "Searched for a synthetic query", time: "2011-05-18T10:00:00.000Z", products: ["Search"] },
      { header: "Search", title: "Searched for another synthetic query", time: "2026-08-01T10:00:00.000Z", products: ["Search"] },
    ]));
    const answer = await at.import("google-takeout", at.put({ [`takeout-${STAMP}-1-001.zip`]: zip([["Takeout/My Activity/Search/MyActivity.json", activity]]) }), A);
    await until("the import in", () => (heldOf(at.root, "google-takeout").find((each) => each.id === answer.import)?.notice ?? null) !== null);
    const done = heldOf(at.root, "google-takeout").find((each) => each.id === answer.import)!;
    expect([heads(at.root, SEARCH).length, done.span, done.open_day, done.open]).toEqual([2, { from: "2011-05-18", to: "2026-08-01" }, null, null]);
  });

  it("a folder handed in leaves its hidden files out, as a Mac's walk does", () => {
    const dir = mkdtempSync(join(tmpdir(), "lifestream-import-hidden-"));
    roots.push(dir);
    for (const path of ["export/a.json", "export/.DS_Store", "export/.cache/b.json", "export/inner/c.json"]) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), "{}");
    }
    expect(filesAt(join(dir, "export")).map((each) => each.path)).toEqual(["files/export/a.json", "files/export/inner/c.json"]);
  });

  it("Timeline: a file naming no account asked, feeding nothing, until --account answers it", async () => {
    const at = await home("lifestream-import-timeline-");
    const file = at.put(timeline.timelineHanded("file"));
    const asked = await at.import("google-timeline", file);
    expect([held(at.root)[asked.import!]?.account, rows(at.root, asked.delivery)]).toEqual([null, []]);
    const answered = await at.import("google-timeline", join(at.put({ "again/location-history.json": readFileSync(file) }), "location-history.json"), timeline.ACCOUNT);
    expect(answered.import).toBeNull();
    await askHome(at.sock, "act", [`import:${asked.import!}:whose`, "choose", timeline.ACCOUNT]);
    await until("the export read", () => read(at.root, asked.delivery));
    expect(rows(at.root, asked.delivery).map((row) => row.source)).toEqual([timeline.SOURCE]);
    expect(heads(at.root, timeline.SOURCE).length).toBeGreaterThan(0);
    const later = await at.import("google-timeline", at.put(timeline.timelineHanded("zip")), timeline.ACCOUNT);
    await until("the zip read", () => read(at.root, later.delivery));
    expect(rows(at.root, later.delivery).map((row) => row.source)).toEqual([timeline.SOURCE]);
    artifact(at.root, "import-journeys", { answers: at.answers, imports: importsOf(at.root) });
  });
});

async function phoneOf(at: Awaited<ReturnType<typeof home>>) {
  const pass = randomBytes(32).toString("base64url");
  const { code } = (await askHome(at.sock, "pair", [])) as { code: string };
  const paired = await fetch(`${at.door.url}/v1/pair`, {
    method: "POST", headers: { ...DEVICE.phone, "content-type": "application/json" },
    body: JSON.stringify({ code, pass, kind: "phone", model: "iPhone 17 Pro", account: A, new: true }),
  });
  expect(paired.status).toBe(200);
  const unit = ((await paired.json()) as { unit: string }).unit;
  const shared = `upload:local:${unit}`;
  let seal = 0;
  const newest = (): number => readHome(at.root, (db) => db.prepare("SELECT coalesce(max(seq), 0) FROM statements WHERE source = ?").pluck().get(shared)) as number;
  const looked = (): number => readHome(at.root, (db) => db.prepare("SELECT coalesce(max(seq), 0) FROM cursors WHERE name = ?").pluck().get(HANDED)) as number;
  return {
    shared,
    async send(name: string, bytes: Buffer, type: string, options: { carried?: readonly Buffer[]; lost?: number } = {}): Promise<string> {
      seal++;
      const observed = new Date(T0 + seal * 60_000).toISOString();
      const line = {
        schema_version: 1, domain: "upload", kind: "file", sequence: seal, observed_at: observed,
        captured: { wall_rfc3339: observed, wall_unix_seconds: Date.parse(observed) / 1000, elapsed_seconds: 10.5 },
        process_instance_id: "00000000-0000-4000-8000-0000000000aa",
        payload: { name, blob: { hash: `sha256:${sha256(bytes)}`, bytes: bytes.length, type, role: "original" } },
      };
      const lost = options.lost === undefined ? {} : { lost: [{ items: options.lost, what: "files shared" }] };
      const bundle = phoneBundle({ entries: { "upload.jsonl": [line] }, blobs: options.carried ?? [bytes], second: seal, custody: { [shared]: { seal, ...lost } } });
      const put = await fetch(`${at.door.url}/v1/bundles/${bundle.id}`, { method: "PUT", headers: { authorization: `Bearer ${pass}`, ...DEVICE.phone }, body: bundle.bytes });
      expect(put.status, await put.clone().text()).toBe(201);
      return sha256(bytes);
    },
    statements: (hex: string): number => readHome(at.root, (db) => db.prepare("SELECT count(*) FROM statements WHERE source = ? AND kind = 'file' AND key = ?").pluck().get(shared, hex)) as number,
    async lookedAtAll(what: string): Promise<void> {
      await until(`the handed files looked at past ${what}`, () => looked() >= newest());
    },
  };
}

const sealedImports = (root: string): string[] =>
  existsSync(join(root, "inbox", IMPORT_LANE)) ? readdirSync(join(root, "inbox", IMPORT_LANE)).filter((name) => name !== "blobs").sort() : [];

describe("an export sent from the iPhone", () => {
  it("Spotify: a zip shared on the phone lands as a file and as a Spotify import read once; shared again, never a second import; a file of no kind stays a file", async () => {
    const at = await home("lifestream-import-phone-");
    const phone = await phoneOf(at);
    const zipped = spotify.spotifyHanded({ ...spotify.spotifyDownload("first"), "Spotify Account Data/Userdata.json": spotify.userdata(spotify.SPOTIFY_ACCOUNT) })[spotify.SPOTIFY_ZIP]!;
    const hex = await phone.send(spotify.SPOTIFY_ZIP, zipped, "application/zip");
    await until("the shared file landed", () => heads(at.root, phone.shared).includes(`file ${hex}`));
    await until("the shared zip admitted as a Spotify import", () => admitted(at.root)[`spotify/${hex}`] !== undefined);
    const { import: id, delivery } = admitted(at.root)[`spotify/${hex}`]!;
    expect(delivery.startsWith(`${IMPORT_LANE}/`)).toBe(true);
    await until("the export read", () => read(at.root, delivery));
    expect(rows(at.root, delivery).map((row) => [row.source, row.refused])).toEqual([[spotify.SPOTIFY_SOURCE, 0]]);
    expect(held(at.root)[id]).toMatchObject({ kind: "spotify", account: spotify.SPOTIFY_ACCOUNT });
    await until("the import in", () => heldOf(at.root, "spotify").find((each) => each.id === id)?.notice !== null);
    const done = heldOf(at.root, "spotify").find((each) => each.id === id)!;
    expect([heads(at.root, spotify.SPOTIFY_SOURCE).length, done.line, heads(at.root, phone.shared)]).toEqual([6, "Imported · 2025–2026 · 6\u00a0plays", [`file ${hex}`]]);
    const landed = versions(at.root, spotify.SPOTIFY_SOURCE);
    const first = sealedImports(at.root);
    expect(first).toEqual([delivery.slice(`${IMPORT_LANE}/`.length)]);

    await phone.send(spotify.SPOTIFY_ZIP, zipped, "application/zip");
    await until("the second share stated", () => phone.statements(hex) === 2);
    await phone.lookedAtAll("the second share");
    expect([Object.keys(admitted(at.root)), sealedImports(at.root), versions(at.root, spotify.SPOTIFY_SOURCE)]).toEqual([[`spotify/${hex}`], first, landed]);

    const notes = await phone.send("notes.txt", Buffer.from("a synthetic note, of no import kind\n"), "text/plain");
    await until("the note landed", () => heads(at.root, phone.shared).includes(`file ${notes}`));
    await phone.lookedAtAll("the note");
    expect([Object.keys(admitted(at.root)), sealedImports(at.root), heads(at.root, phone.shared)]).toEqual([[`spotify/${hex}`], first, [`file ${hex}`, `file ${notes}`].sort()]);
    artifact(at.root, "import-from-phone", { imports: importsOf(at.root), sealed: sealedImports(at.root) });
  });

  it("ChatGPT: a shared zip whose bytes come in a later bundle is looked at only once they are held, and then without being shared again", async () => {
    const at = await home("lifestream-import-phone-later-");
    const phone = await phoneOf(at);
    const zipped = ai.chatgptHanded("first", "zip")["chatgpt-export.zip"]!;
    const hex = await phone.send("chatgpt-export.zip", zipped, "application/zip", { carried: [], lost: 1 });
    await until("the shared file landed, wanting its bytes", () => heads(at.root, phone.shared).includes(`file ${hex}`));
    await phone.lookedAtAll("the file without its bytes");
    expect([Object.keys(admitted(at.root)), sealedImports(at.root)]).toEqual([[], []]);

    const note = Buffer.from("a synthetic note sent beside the zip's bytes\n");
    await phone.send("note.txt", note, "text/plain", { carried: [note, zipped] });
    await until("the zip admitted as a ChatGPT import", () => admitted(at.root)[`chatgpt/${hex}`] !== undefined);
    expect([phone.statements(hex), Object.keys(admitted(at.root)), sealedImports(at.root).length]).toEqual([1, [`chatgpt/${hex}`], 1]);
  });
});

describe("the door's half of the road", () => {
  it("refuses an older Mac app's archive bundle without moving received, and answers which files the home looked at: in, or refused whole", async () => {
    const at = await home("lifestream-import-door-");
    const headers = { authorization: `Bearer ${at.token}`, ...DEVICE.mac };
    const exchange = async () => ((await (await fetch(`${at.door.url}/v1/exchange`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" })).json()) as { sources: Record<string, { received: number }> }).sources[UPLOAD]?.received ?? 0;
    const bundle = (seal: number, facts: object, files: [string, Buffer][]) => acquisitionBundle({
      source: UPLOAD, feeder: "import-mac", fetched_ms: T0 + seal * 1_000, files, facts: facts as never, custody: { [UPLOAD]: { seal } },
    });
    const takeout = zip([[`Takeout/My Activity/Search/MyActivity.json`, Buffer.from("[]")]]);
    const old = bundle(1, { archive: { kind: "google-takeout", id: STAMP } }, [[`files/takeout-${STAMP}-1-001.zip`, takeout]]);
    const refused = await fetch(`${at.door.url}${old.path}`, { method: "PUT", headers, body: old.bytes });
    expect([refused.status, await refused.json()]).toMatchObject([422, { message: "Update Lifestream on this Mac to go on" }]);
    expect(await exchange()).toBe(0);

    const file = at.put(ai.chatgptHanded("first", "zip"));
    const answer = await at.import("chatgpt", file);
    const [key] = Object.keys(admitted(at.root));
    const digest = key!.slice("chatgpt/".length);
    const other = "0".repeat(64);
    const wrong = await at.import("google-timeline", file);
    const ended = held(at.root)[wrong.import!]?.ended;
    const wrongDigest = digest;
    const ask = (files: object[]) => lookedAt(at, files);
    const files = [{ kind: "chatgpt", digest }, { kind: "chatgpt", digest: other }, { kind: "claude", digest }, { kind: "google-timeline", digest: wrongDigest }];
    expect([await ask(files), answer.import, ended]).toEqual([
      [200, { held: [{ kind: "chatgpt", digest, state: "in" }, { kind: "google-timeline", digest: wrongDigest, state: "refused" }] }], expect.any(String), true]);
    expect(await askHome(at.sock, "act", [`import:${wrong.import!}:refused`, "skip"])).toEqual({ acted: "skipped" });
    expect(await ask(files)).toEqual([200, { held: [{ kind: "chatgpt", digest, state: "in" }, { kind: "google-timeline", digest: wrongDigest, state: "let-go" }] }]);
  });
});

describe("what the roads before imports left, moved at the start", () => {
  it("no source keeps an archive option, and Spotify's cursor becomes its anchor", async () => {
    const root = makeRoot("lifestream-import-upgrade-", { sources: { [UPLOAD]: "upload" } });
    roots.push(root);
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => {
      tx.tables.sources.add({ id: SEARCH, vendor: "google", connector: "google-my-activity", options: { lane: UPLOAD, archive: "google-takeout" }, added_ms: T0 });
      tx.tables.polls.leave("spotify-export", { source: spotify.SPOTIFY_SOURCE, state: JSON.stringify({ first: "synthetic-first-play", through_ms: T0 }), start_ms: null, changes: { cleared: [], entries: [] } });
    });
    db.close();
    await startHere(root, { registry: REGISTRY, tickMs: TICK_MS, slot: null, log: () => undefined });
    expect(readHome(root, (db) => db.prepare("SELECT options FROM sources WHERE id = ?").pluck().get(SEARCH))).toBe(JSON.stringify({ import: "google-takeout", lane: UPLOAD }));
    expect(meta(root, `${ANCHOR}${spotify.SPOTIFY_SOURCE}`)).toBe("synthetic-first-play");
  });
});
