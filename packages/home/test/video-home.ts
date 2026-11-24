import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { openHomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import { serveDoor, type Door } from "../door.js";
import { startHome, type Home } from "../home.js";
import { engineMaker } from "../pictures.js";
import { mintPrincipal } from "../principals.js";
import { askHome } from "../socket.js";
import { testSocket } from "./folder.js";
import { shipFiles } from "./harness-deliveries.js";
import { makeRoot, readHome, removeRoot, REPO, until } from "./harness-root.js";
import { DEVICE, phoneBundle } from "./support.js";
import { buildEngine, samplesTool, type Facts } from "./faces-programs.js";

const REGISTRY = new URL("./photos-registry.ts", import.meta.url);
const ACCOUNT = "person-a@example.com";
const HOME_UNIT = "macbook-pro-0001";
const GOOGLE = `google-photos:${ACCOUNT}:export`;
const READER = "synthetic-token-video-reader".padEnd(43, "x");
export const DAY = "2026-10-01";
const at = (clock: string) => Date.parse(`${DAY}T${clock}Z`);
export const AT = { live: at("10:00:00"), video: at("10:01:00"), pair: at("10:02:00"), mp4: at("10:03:00") } as const;
export const VIDEO_SECONDS = 1 / 3;

const hexOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export interface Film { readonly name: string; readonly image: Buffer; readonly motion: Buffer | null }

async function films(dir: string): Promise<Record<keyof typeof AT, Film> & { facts: (file: string) => Promise<Facts> }> {
  const tools = await samplesTool(dir);
  const fixture = (name: string) => readFileSync(join(REPO, "dashboard", "test", "fixtures", name));
  return {
    live: { name: "IMG_0001", image: await tools.sample("live.jpg", "marked", "800", "1200", "jpeg", "6"), motion: fixture("motion.mov") },
    video: { name: "IMG_0002", image: await tools.sample("video.mov", "movie", "480", "640"), motion: null },
    pair: { name: "IMG_0003", image: await tools.sample("pair.heic", "marked", "1200", "800", "heic", "8"), motion: await tools.sample("pair.mov", "movie", "640", "480") },
    mp4: { name: "VID_0004", image: fixture("video.mp4"), motion: null },
    facts: tools.facts,
  };
}

export interface VideoHome {
  readonly root: string;
  readonly url: string;
  readonly token: string;
  readonly home: Home;
  readonly door: Door;
  readonly films: Awaited<ReturnType<typeof films>>;
  readonly hashes: Record<keyof typeof AT, { image: string; motion: string | null }>;
  readonly phone: { readonly source: string; readonly pass: string };
  get(path: string, headers?: Record<string, string>): Promise<Response>;
  stop(): Promise<void>;
}

export async function videoHome(dir: string = mkdtempSync(join(tmpdir(), "lifestream-video-"))): Promise<VideoHome> {
  const made = await films(dir);
  const engine = await buildEngine();
  const root = makeRoot("lifestream-video-", { sources: { [GOOGLE]: "google-photos-takeout" }, settings: { unit: HOME_UNIT, "day.zone": "UTC" } });
  mintPrincipal(openHomeFolder(root), { unit: "reader-0001", scopes: ["read"], token: READER, now_ms: Date.now() });
  const home = await startHome(root, { registry: REGISTRY, log: () => undefined });
  const door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 },
    { registry: REGISTRY, log: () => undefined, maker: engineMaker(engine), floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" } });
  const url = `http://127.0.0.1:${door.port}`;
  const stop = async () => {
    await door.close();
    await home.stop();
    removeRoot(root);
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const pass = randomBytes(32).toString("base64url");
    const code = ((await askHome(testSocket(root), "pair", [])) as { code: string }).code;
    const paired = await (await fetch(`${url}/v1/pair`, { method: "POST", headers: { ...DEVICE.phone, "content-type": "application/json" },
      body: JSON.stringify({ code, pass, kind: "phone", model: "iPhone 17 Pro", account: ACCOUNT, new: true }) })).json() as JsonObject;
    const phone = `apple-photos:${ACCOUNT}:${paired.unit as string}`;

    const file = (type: "photo" | "video" | "pairedVideo", name: string, bytes: Buffer, mediaType: string) => ({
      type, type_raw: { photo: 1, video: 2, pairedVideo: 9 }[type], uti: type === "photo" ? "public.jpeg" : "com.apple.quicktime-movie",
      original_filename: name, size: bytes.length, blob: { hash: `sha256:${hexOf(bytes)}`, bytes: bytes.length, type: mediaType, role: type },
    });
    const asset = (local: string, at_ms: number, media: "image" | "video", subtypes: number, duration: number, resources: JsonObject[]): JsonObject => ({
      local_identifier: local, cloud_identifier: `CLOUD-${local.slice(0, 4)}`, modification_date: null, creation_date: new Date(at_ms).toISOString(),
      media_type: media, media_subtypes: subtypes, duration, pixel_width: media === "video" ? 480 : 800, pixel_height: media === "video" ? 640 : 1200,
      location: null, favorite: false, hidden: false, resources,
    });
    const { live, video, pair, mp4 } = made;
    const lines = [
      asset("LIVE/L0/001", AT.live, "image", 8, 0, [file("photo", `${live.name}.JPG`, live.image, "image/jpeg"), file("pairedVideo", `${live.name}.MOV`, live.motion!, "video/quicktime")]),
      asset("VIDE/L0/001", AT.video, "video", 0, VIDEO_SECONDS, [file("video", `${video.name}.MOV`, video.image, "video/quicktime")]),
    ].map((payload, n) => ({ domain: "photos", kind: "asset", sequence: n + 1, captured: { wall_rfc3339: new Date(AT.mp4 + 60_000 + n * 1000).toISOString() }, payload }));
    const bundle = phoneBundle({
      entries: { "photos.jsonl": lines }, blobs: [live.image, live.motion!, video.image], second: 1,
      range: { start: lines[0]!.captured.wall_rfc3339, end: lines.at(-1)!.captured.wall_rfc3339 }, custody: { [phone]: { seal: 1 } },
    });
    const sent = await fetch(`${url}/v1/bundles/${bundle.id}`, { method: "PUT", headers: { authorization: `Bearer ${pass}`, ...DEVICE.phone, "lifestream-kind": "new" }, body: bundle.bytes });
    if (sent.status !== 201) throw new Error(`the phone's bundle was answered ${sent.status}: ${await sent.text()}`);

    const folder = "Takeout/Google Photos/Photos from 2026";
    const sidecar = (title: string, at_ms: number) => Buffer.from(JSON.stringify({ title, photoTakenTime: { timestamp: String(at_ms / 1000), formatted: "synthetic" } }));
    await shipFiles(root, GOOGLE, Date.now(), {
      [`${folder}/${live.name}.JPG`]: live.image, [`${folder}/${live.name}.JPG.supplemental-metadata.json`]: sidecar(`${live.name}.JPG`, AT.live),
      [`${folder}/${live.name}.MOV`]: live.motion!,
      [`${folder}/${pair.name}.HEIC`]: pair.image, [`${folder}/${pair.name}.HEIC.supplemental-metadata.json`]: sidecar(`${pair.name}.HEIC`, AT.pair),
      [`${folder}/${pair.name}.MOV`]: pair.motion!,
      [`${folder}/${mp4.name}.MP4`]: mp4.image, [`${folder}/${mp4.name}.MP4.supplemental-metadata.json`]: sidecar(`${mp4.name}.MP4`, AT.mp4),
    }, { exported_at: "2026-10-02T00:00:00Z" });

    const count = (sql: string, ...values: unknown[]) => readHome(root, (db) => db.prepare(sql).pluck().get(...values) as number);
    let failed: string | undefined;
    await until("both deliveries imported, every job done and the day rendered", () => {
      failed = readHome(root, (db) => db.prepare("SELECT source || ': ' || coalesce(error, state) FROM deliveries WHERE state IN ('failed', 'dead')").pluck().get() as string | undefined);
      return failed !== undefined || (count("SELECT count(*) FROM deliveries WHERE state = 'imported' AND source IN (?, ?)", phone, GOOGLE) === 2 &&
        count("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')") === 0 && existsSync(join(root, "days", `${DAY}.day.json`)));
    });
    if (failed !== undefined) throw new Error(`a delivery did not import: ${failed}`);

    const hash = (bytes: Buffer | null) => (bytes === null ? null : `sha256:${hexOf(bytes)}`);
    const hashes = Object.fromEntries((["live", "video", "pair", "mp4"] as const).map((key) => [key, { image: hash(made[key].image)!, motion: hash(made[key].motion) }])) as VideoHome["hashes"];
    return {
      root, url, token: READER, home, door, films: made, hashes, phone: { source: phone, pass }, stop,
      get: (path, headers = {}) => fetch(`${url}${path}`, { headers: { authorization: `Bearer ${READER}`, ...headers } }),
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const say = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const running = await videoHome();
  say({ ready: true, url: running.url, tokens: { reader: running.token }, root: running.root, day: DAY,
    photos: Object.fromEntries(Object.entries(running.hashes).map(([key, value]) => [key, { at_ms: AT[key as keyof typeof AT], ...value }])) });
  for await (const line of createInterface({ input: process.stdin })) {
    if (line.trim() === "") continue;
    const command = JSON.parse(line) as { cmd?: string };
    if (command.cmd === "stop") {
      await running.stop();
      say({ cmd: "stop", ok: true, value: { stopped: true } });
      process.exit(0);
    }
    say({ cmd: command.cmd, ok: false, error: "the video home takes stop alone" });
  }
}
