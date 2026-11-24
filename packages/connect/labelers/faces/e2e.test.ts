import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openHomeFolder, sourceName, type Delivery, type Json, type JsonObject, type Landed, type MessagesAdapter, type OpenView, type ReaderOutput, type Registered } from "@lifestreamprotocol/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { peopleHome } from "../../people/reader.js";
import { LabelerUnavailable, type LabelOutput, type LabelSince } from "../../labeler.js";
import type { FetchedFile } from "../../seams.js";
import { Refused } from "../../shared/index.js";
import { artifact, collect, fetchedBytes, openTestHome, type TestHome } from "../../test/drive.js";
import { camerasConnector, camerasLine } from "../cameras/reader.js";
import { notASlug, openMemo } from "@lifestreamprotocol/core";
import { clusterGuard, facesConnector, faceKey, namedBlobs, type Box, type ClusterFace, type Named } from "./reader.js";
import { CBOR_PIPELINE, faceAnchors, facesLabeler, GROUP_RULE, modelsInstalled, SCAN_BOUND, SCAN_NOW, type FacesSettings } from "./labeler.js";
import { declarations } from "../../index.js";
import { vendorOf } from "../../products.js";
import { registered } from "../../test/registered.js";
import { runFakeEngine } from "./test/fake-engine.mjs";

const GOLDEN = new URL("./test/flow.golden.json", import.meta.url);
const FAKE = fileURLToPath(new URL("./test/fake-engine.mjs", import.meta.url));
const UNIT = "macbook-pro-0001";
const GOOGLE = "google-photos:person-a@example.com:export";
const WHATSAPP = "whatsapp:+15550000001:iphone-aa01";
const IMESSAGE = "imessage:+15550000001:macbook-pro-0001";
const PEOPLE = `people:local:${UNIT}`;
const NETWORK = "example-chat:owner-1:iphone-aa01";
const OTHER_VENDORS: Readonly<Record<string, string>> = { "example-chat": "example" };
const FACES = `faces:local:${UNIT}`;
const CAMERAS = `cameras:local:${UNIT}`;
const ZONE = "Asia/Kolkata";
const PIPELINE = { version: 1, detector: "fake-detector", recognizer: "fake-recognizer", detect_size: 1280, detect_threshold: 0.45, overlap_threshold: 0.4, tiers: [] };
const T0 = Date.UTC(2026, 9, 1);

interface FakeFace {
  box: Box;
  tier: "seed" | "assign" | "observe";
  tag: number;
  typical?: number;
  likeness?: number;
}

interface EngineConfig {
  pipeline?: JsonObject;
  faces?: Record<string, FakeFace[]>;
  suggested?: Record<string, { person: string; score: number }[]>;
  fail?: Record<string, 1 | 2>;
  hang?: string;
  selfCheck?: boolean;
}

interface Labelled {
  landed: Landed;
  facts: JsonObject;
  lines: { kind: string; key: string; content?: JsonObject; gone?: true }[];
  files: FetchedFile[];
}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

let ENGINE = "";
beforeAll(() => {
  ENGINE = join(mkdtempSync(join(tmpdir(), "connect-faces-engine-")), "face-engine");
  writeFileSync(ENGINE, `#!/bin/sh\nNODE_OPTIONS="" FAKE_ENGINE_DIR="\${0%/*}" exec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o755 });
});
afterAll(() => rmSync(dirname(ENGINE), { recursive: true, force: true }));

function bench(options: { timeoutMs?: number; engine?: string; models?: boolean; scanBound?: number; battery_backlog?: number; messages?: Registered<MessagesAdapter>[]; spawn?: boolean } = {}) {
  const home: TestHome = openTestHome("connect-faces-");
  const { dir, blobs, db } = home;
  const engineDir = join(dir, "engine");
  mkdirSync(engineDir, { recursive: true });
  const wrapper = join(engineDir, "face-engine");
  symlinkSync(ENGINE, wrapper);
  mkdirSync(join(dir, "tools"), { recursive: true });
  const models = join(dir, "tools", "faces", "models", "buffalo_l");
  if (options.models !== false) {
    mkdirSync(models, { recursive: true });
    for (const file of ["det_10g.onnx", "w600k_r50.onnx"]) writeFileSync(join(models, file), `synthetic ${file}`);
  }
  const power = { mains: true };
  const settings: FacesSettings = {
    unit: UNIT, zone: ZONE, photos: registered("photos"), messages: [...registered("messages"), ...options.messages ?? []], engine: options.engine ?? wrapper, models, blobs: join(dir, "blobs"), work: join(dir, "tools", "faces-work"), memo: (version) => openMemo(openHomeFolder(dir), join(dir, "machine", "faces", "memo.db"), version),
    fetch: join(dir, "fetch-models.sh"), reference: join(dir, "reference"), onMains: () => power.mains,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.scanBound === undefined ? {} : { scanBound: options.scanBound }),
    ...(options.battery_backlog === undefined ? {} : { battery_backlog: options.battery_backlog }),
    ...(options.engine === undefined && options.timeoutMs === undefined && options.spawn !== true ? { invoke: (command, requestPath, resultPath) => runFakeEngine(engineDir, command, requestPath, resultPath) } : {}),
  };
  const labeler = facesLabeler(settings);
  const config: EngineConfig = { pipeline: PIPELINE, faces: {} };
  const configure = () => writeFileSync(join(engineDir, "engine.json"), JSON.stringify(config));
  configure();
  let run = 0;
  let clock = T0;
  let since: LabelSince = { seq: 0, reread: 0 };
  let reads: Read[] = [];
  const land = (source: string, rows: ReaderOutput[], connector = "synthetic", guards = source === FACES ? facesConnector.kinds : GUARDS): Landed => db.commit((tx) => {
    if (tx.tables.sources.get(source) === undefined) tx.tables.sources.add({ id: source, vendor: OTHER_VENDORS[sourceName(source).product] ?? vendorOf(declarations(), source), connector, added_ms: T0 });
    return tx.records.land(++run, { id: `d${run}`, source, stated_ms: (clock += 1000) }, rows, guards, blobs);
  });
  return {
    dir, home, blobs, settings, labeler, config, power,
    configure,
    cameraTook(hexes: string[], gone = false): Landed {
      const rows = hexes.map((hex) => JSON.parse(camerasLine("photo", hex, gone ? "gone" : { type: "cameras.photo", camera: "synthetic/camera-one" })) as JsonObject);
      return land(CAMERAS, rows.map((row) => (row.gone === true ? { kind: "photo", key: row.key as string, content: null, gone: true } : { kind: "photo", key: row.key as string, content: row.content as Json })), "cameras", camerasConnector.kinds);
    },
    passed(): void {
      const view = db.view();
      since = { seq: view.through, reread: view.newestReread() };
      view.close();
    },
    photo(name: string, faces: FakeFace[] = [], bytes = Buffer.from(`synthetic photo ${name}`)): string {
      const hex = blobs.put(bytes).slice("sha256:".length);
      config.faces![hex] = faces;
      configure();
      return hex;
    },
    land,
    async label(options: { lost?: true } = {}): Promise<Labelled | null> {
      const view = db.view();
      const through = { seq: view.through, reread: view.newestReread() };
      reads = [];
      let labelling;
      try {
        labelling = labeler.label(observed(view, reads), blobs, since);
      } finally {
        view.close();
      }
      let output;
      try {
        output = await labelling;
      } catch (error) {
        if (!(error instanceof LabelerUnavailable)) throw error;
        if (error.output !== null) await this.landOutput(error.output);
        since = { ...(error.output === null ? since : through), resting: error.reason };
        throw error;
      }
      if (options.lost === true) return null;
      since = through;
      return output === null ? null : await this.landOutput(output);
    },
    async landOutput(output: LabelOutput): Promise<Labelled> {
      const files = output.files.map((file) => {
        const bytes = fetchedBytes(file);
        return { path: file.path, blob: blobs.put(bytes), size: bytes.length };
      });
      const stated_ms = (clock += 1000);
      const delivery: Delivery = { id: `faces-${run + 1}`, source: FACES, sealed_ms: stated_ms, stated_ms, facts: output.facts, files };
      const listing = fetchedBytes(output.files.find((file) => file.path === "faces.ndjson")!).toString("utf8");
      const lines = listing.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as Labelled["lines"][number]);
      const rows = await collect(facesConnector.read(delivery, blobs));
      return { landed: land(FACES, rows, "faces"), facts: output.facts, lines, files: output.files };
    },
    inputReads(): Read[] {
      return reads.filter((read) => read.method === "naming" || (read.source !== FACES && read.source !== PEOPLE && read.source !== CAMERAS && read.source !== undefined) || read.kind === "img" || read.kind === "msg");
    },
    contentReads(): Read[] {
      return reads.filter((read) => read.method === "records" || read.method === "version" || read.method === "naming");
    },
    ownVersions(): string[] {
      return reads.flatMap((read) => (read.version !== undefined && (OWN_KINDS.has(read.kind ?? "") || read.kind === "face") ? [read.version] : []));
    },
    ownHeads(): Set<string> {
      return new Set([...OWN_KINDS].flatMap((kind) => this.heads(kind).map((head) => head.version)));
    },
    who(face: string): string {
      return this.heads("named").find((head) => (head.content as unknown as Named).photos.some((photo) => photo.face === face))?.key ?? "";
    },
    crop(hex: string, index = 0): string | null {
      return this.content<{ faces: { crop: string | null }[] }>("scan", hex)!.faces[index]!.crop;
    },
    heads(kind: string): { key: string; version: string; content: Json }[] {
      return home.heads(FACES, [kind]).filter((head) => !head.gone).map(({ key, version, content }) => ({ key, version, content: content! }));
    },
    content<T>(kind: string, key: string): T | undefined {
      return this.heads(kind).find((head) => head.key === key)?.content as T | undefined;
    },
    calls(): { command: string; request: JsonObject }[] {
      const log = join(engineDir, "calls.log");
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8").trim().split("\n").map((line) => {
        const space = line.indexOf(" ");
        return { command: line.slice(0, space), request: JSON.parse(line.slice(space + 1)) as JsonObject };
      });
    },
    groupResult(): JsonObject {
      return JSON.parse(readFileSync(join(settings.work, "run", "group-result.json"), "utf8")) as JsonObject;
    },
  };
}

const GUARDS: Record<string, (content: Json) => string[]> = { img: () => [], msg: () => [], ...peopleHome.kinds };
const ANY_PERSON = { ...GUARDS, person: () => [] };

interface Read {
  method: string;
  source?: string | undefined;
  kind?: string | undefined;
  version?: string | undefined;
}

const OWN_KINDS = new Set(["image", "scan", "faces", "named", "cluster", "maybe", "model-image"]);

const RECORD_READS = new Set(["head", "heads", "records", "linked", "history", "keyedUnder"]);

function observed(view: OpenView, reads: Read[]): OpenView {
  const read = (version: { id: string; kind: string }) => reads.push({ method: "version", kind: version.kind, version: version.id });
  return new Proxy(view, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver) as unknown;
      if (typeof value !== "function") return value;
      const method = String(name);
      return (...args: unknown[]) => {
        const result = (value as (...each: unknown[]) => unknown).apply(target, args);
        if (RECORD_READS.has(method)) {
          const ref = typeof args[0] === "object" && args[0] !== null ? (args[0] as { source: string; kind: string }) : { source: args[0] as string, kind: args[1] as string };
          reads.push({ method, source: ref.source, kind: ref.kind });
          if (method === "records") {
            return (function* () {
              for (const item of result as Iterable<{ version: { id: string; kind: string } }>) {
                read(item.version);
                yield item;
              }
            })();
          }
        } else if (method === "version") read(result as { id: string; kind: string });
        else if (method === "naming") {
          reads.push({ method });
          for (const version of result as { id: string; kind: string }[]) read(version);
        }
        return result;
      };
    },
  });
}

const at = (iso: string) => ({ start_ms: Date.parse(iso), precision: "ms" as const });

function googlePhoto(hex: string, time: string, fields: JsonObject = {}): ReaderOutput {
  return {
    kind: "img", key: hex, time: at(time),
    content: {
      type: "photos.asset", title: "IMG_0001.JPG", photoTakenTime: { timestamp: String(Date.parse(time) / 1000) }, ...fields,
      blobs: [{ hash: `sha256:${hex}`, bytes: 24, media_type: "image/jpeg", role: "original" }],
    },
    blobs: [`sha256:${hex}`],
  };
}

const people = (...names: string[]): JsonObject => ({ people: names.map((name) => ({ name })) });

function whatsappPhoto(stanza: string, hex: string | null, time: string, type = 1, by: { chat?: string; me?: true; from?: string; member?: string } = {}): ReaderOutput {
  const chat = by.chat ?? "15550000002@s.whatsapp.net";
  return {
    kind: "msg", key: `${chat}:${stanza}`, time: { start_ms: Date.parse(time), precision: "ms" as const },
    content: {
      type: "whatsapp.msg", session_jid: chat, group_member_jid: by.member ?? null,
      message: { ZMESSAGETYPE: type, ZISFROMME: by.me === true ? 1 : 0, ZFROMJID: by.me === true ? null : by.from ?? (by.member === undefined ? null : chat), ZTEXT: hex === null ? "synthetic words" : null },
      blobs: hex === null ? [] : [{ hash: `sha256:${hex}`, bytes: 24, role: "ZWAMEDIAITEM.ZMEDIALOCALPATH" }],
    },
    ...(hex === null ? {} : { blobs: [`sha256:${hex}`] }),
  };
}

const handle = (raw: string, canonical: string, kind: "phone" | "email" | "raw") => ({ raw, canonical, kind });
const PARTNER = handle("+1 (555) 000-0002", "+15550000002", "phone");

function imessagePhoto(guid: string, hex: string, time: string, mime: string | null = "image/heic",
  from: { me?: true; sender?: ReturnType<typeof handle>; recipients?: ReturnType<typeof handle>[] } = {}): ReaderOutput {
  return {
    kind: "msg", key: guid, time: at(time),
    content: {
      type: "imessage.msg", guid, sender: from.me === true ? null : from.sender ?? PARTNER, recipients: from.recipients ?? (from.me === true ? [PARTNER] : []),
      flags: { is_from_me: from.me === true ? 1 : 0 }, text: null,
      attachments: [{ hash: `sha256:${hex}`, bytes: 24, mime_type: mime, transfer_name: "IMG_0001.HEIC" }],
    },
    blobs: [`sha256:${hex}`],
  };
}

function person(slug: string, name: string, merged_into: string | null = null): ReaderOutput {
  return {
    kind: "person", key: slug,
    content: {
      type: "people.person", slug, name, handles: [{ kind: "name", value: name, by: "subject", since: "2026-10-01T00:00:00.000Z" }], excluded: [], merged_into,
    },
  };
}

const faceStatement = (hex: string, box: Box, content: JsonObject): ReaderOutput => ({ kind: "face", key: faceKey(hex, box), content });

const counts = (landed: Landed) => ({ new: landed.new, changed: landed.changed, gone: landed.gone, restated: landed.restated, refused: landed.refused, erased: landed.erased });
const keysOf = (labelled: Labelled | null, kind: string) => (labelled?.lines ?? []).filter((line) => line.kind === kind).map((line) => line.key).sort();
const sorted = (keys: string[]) => [...keys].sort();

const EXAMPLE_CHAT: MessagesAdapter = {
  version: "1", kinds: ["msg"], message: () => null, group: () => false, members: (chat) => [{ id: chat, kind: "network" }],
  images: ({ version }) => {
    const content = version.content as { blob?: string; from?: string };
    return content.blob === undefined ? null : { blobs: [content.blob], sender: content.from === undefined ? null : { kind: "network", value: content.from } };
  },
};

const examplePhoto = (key: string, hex: string, time: string, from: string): ReaderOutput => ({
  kind: "msg", key, time: { start_ms: Date.parse(time), precision: "ms" as const }, content: { type: "example-chat.msg", blob: `sha256:${hex}`, from }, blobs: [`sha256:${hex}`],
});

const BY_B = [{ kind: "jid", value: "15550000002@s.whatsapp.net" }];

const LEFT: Box = [100, 100, 300, 300];
const RIGHT: Box = [500, 100, 700, 300];

function modelImage(...faces: [Box, string | null, string?][]): JsonObject {
  return {
    faces: faces.map(([box]) => ({ box })),
    names: faces.map(([, shown, slug]) => (shown === null ? null : { shown, who: `person:${slug ?? shown.toLowerCase().replace(/ /gu, "-")}` })),
  };
}

function expectGolden(value: unknown): void {
  if (process.env.LIFESTREAM_UPDATE_GOLDEN === "1") writeFileSync(GOLDEN, `${JSON.stringify(value, null, 2)}\n`);
  expect(value).toEqual(JSON.parse(readFileSync(GOLDEN, "utf8")));
}

async function flow() {
  const b = bench();
  b.config.suggested = { 2: [{ person: "person-b", score: 0.61 }] };
  const p1 = b.photo("p1", [{ box: LEFT, tier: "seed", tag: 1 }, { box: RIGHT, tier: "seed", tag: 2 }]);
  const p2 = b.photo("p2", [{ box: LEFT, tier: "assign", tag: 1 }]);
  const p3 = b.photo("p3");
  const p4 = b.photo("p4", [{ box: LEFT, tier: "seed", tag: 2 }]);
  const p5 = b.photo("p5", [{ box: RIGHT, tier: "seed", tag: 2, typical: 0.5 }]);
  const c1 = b.photo("c1", [{ box: LEFT, tier: "seed", tag: 2 }]);
  const s1 = b.photo("s1", [{ box: LEFT, tier: "observe", tag: 3 }]);
  const u = b.photo("u", [], Buffer.from("not an image: synthetic bytes"));
  b.land(GOOGLE, [
    googlePhoto(p1, "2019-12-31T19:00:00Z"),
    googlePhoto(p2, "2019-06-01T10:00:00Z"),
    googlePhoto(p3, "2020-06-01T10:00:00Z"),
    googlePhoto(p4, "2021-06-01T10:00:00Z"),
    googlePhoto(p5, "2023-06-01T10:00:00Z"),
    googlePhoto(s1, "2022-06-01T10:00:00Z"),
    googlePhoto(u, "2022-07-01T10:00:00Z"),
    googlePhoto("d".repeat(64), "2022-08-01T10:00:00Z"),
  ]);
  b.land(WHATSAPP, [whatsappPhoto("3EB0A1", c1, "2024-06-01T10:00:00Z"), whatsappPhoto("3EB0A2", null, "2024-06-01T10:01:00Z")]);
  b.land(IMESSAGE, [imessagePhoto("guid-s1", s1, "2022-06-02T10:00:00Z")]);
  b.land(PEOPLE, [person("person-a", "Person A"), faceStatement(p1, LEFT, { is: "person-a" })]);
  b.cameraTook([p1, p2, p3, p4, p5, s1, u]);
  return { b, p1, p2, p3, p4, p5, c1, s1, u };
}

describe("faces labeler", () => {
  it("L14 L4 L10 L11 L12: a run lands other records than the engine's results, or a run with nothing owed does anything", async () => {
    const { b, p1, p2, p3, p4, p5, c1, s1, u } = await flow();
    const first = (await b.label())!;

    const calls = b.calls();
    expect(calls.map((call) => call.command)).toEqual(["scan", "scan", "group"]);
    const scanned = (calls[1]!.request.photos as { key: string; path: string }[]);
    expect(scanned.map((photo) => photo.key)).toEqual([c1, p5, u, s1, p4, p3, p1, p2]);
    expect(scanned[0]!.path).toBe(join(b.settings.blobs, scanned[0]!.key.slice(0, 2), scanned[0]!.key.slice(2, 4), scanned[0]!.key));
    const group = calls[2]!.request as { photos: { key: string; vectors: string; faces: { tier: string }[] }[]; statements: unknown[]; people: unknown };
    expect(group.photos.map((photo) => photo.key)).toEqual(sorted([p1, p2, p4, p5, c1, s1]));
    expect(Object.fromEntries(group.photos.map((photo) => [photo.key, photo.faces.map((face) => face.tier)]))).toEqual({
      [p1]: ["seed", "seed"], [p2]: ["assign"], [p4]: ["seed"], [p5]: ["seed"], [c1]: ["assign"], [s1]: ["observe"],
    });
    expect(b.content<{ faces: { tier: string }[] }>("scan", c1)!.faces[0]!.tier).toBe("seed");
    expect(group.statements).toEqual([{ photo: p1, box: LEFT, is: "person-a" }]);
    expect(group.people).toEqual({});

    expect(counts(first.landed)).toMatchObject({ refused: 0, gone: 0, changed: 0 });
    expect(first.facts).toEqual({
      whole: true, images: 8, photos: 8, pipeline: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u), restated: 0, scanned: 8, unreadable: 1, owed: 0,
      sources: [{ id: FACES, connector: "faces" }], grouped: true, faces: 7, maybe: 0, clusters: 1, unmatched: 0,
    });
    expect(keysOf(first, "scan")).toEqual(sorted([p1, p2, p3, p4, p5, c1, s1, u]));
    expect(b.content<JsonObject>("scan", u)).toEqual({ pipeline: first.facts.pipeline, status: "unreadable", width: null, height: null, faces: null, vectors: null });
    expect(b.content<JsonObject>("scan", p3)).toMatchObject({ status: "ok", faces: [], vectors: null });
    expect(keysOf(first, "named")).toEqual(["person-a"]);
    expect(keysOf(first, "faces")).toEqual([]);
    expect(keysOf(first, "model-image")).toEqual(sorted([p1, p2, p3, p4, p5, s1]));
    const cluster = b.heads("cluster");
    expect(cluster).toHaveLength(1);
    expect(b.content<Named>("named", "person-a")).toEqual({
      photos: [
        { face: faceKey(p1, LEFT), at_ms: Date.parse("2019-12-31T19:00:00Z"), camera: true, crop: b.crop(p1, 0), tier: "seed", size: 200 },
        { face: faceKey(p2, LEFT), at_ms: Date.parse("2019-06-01T10:00:00Z"), camera: true, crop: b.crop(p2), tier: "assign", size: 200 },
      ],
      labels: [],
    });
    expect([b.who(faceKey(p1, RIGHT)), b.who(faceKey(s1, LEFT))]).toEqual(["", ""]);
    const face = (hex: string, box: Box, index: number, time: string): ClusterFace => ({ face: faceKey(hex, box), at_ms: Date.parse(time), crop: b.crop(hex, index) });
    expect(cluster[0]!.content).toEqual({
      size: 4, photos: 4, years: [2020, 2024],
      faces: [face(p1, RIGHT, 1, "2019-12-31T19:00:00Z"), face(p4, LEFT, 0, "2021-06-01T10:00:00Z"), face(p5, RIGHT, 0, "2023-06-01T10:00:00Z"), face(c1, LEFT, 0, "2024-06-01T10:00:00Z")]
        .sort((left, right) => (left.face < right.face ? -1 : 1)),
      outliers: [faceKey(p5, RIGHT)], chat_share: 0.25, suggested: [{ person: "person-b", score: 0.61 }], year_count: 4,
      evidence: { senders: [{ faces: 1, ...BY_B[0] }], labels: [] }, rule: GROUP_RULE,
    });
    expect(b.content<JsonObject>("model-image", p1)).toEqual(modelImage([LEFT, "Person A"], [RIGHT, null]));
    expect(b.content<JsonObject>("model-image", p2)).toEqual(modelImage([LEFT, "Person A"]));
    expect(b.content<JsonObject>("model-image", p3)).toEqual(modelImage());
    for (const file of first.files.filter((each) => each.path !== "faces.ndjson")) expect(sha256(fetchedBytes(file))).toBe(file.path.split(".")[0]);
    const crops = b.heads("scan").flatMap((head) => ((head.content as { faces: { crop: string | null }[] | null }).faces ?? []).flatMap((face) => (face.crop === null ? [] : [`${face.crop.slice(7)}.jpg`])));
    expect(first.files.filter((file) => file.path.endsWith(".jpg")).map((file) => file.path).sort()).toEqual([...new Set(crops)].sort());
    const heads = Object.fromEntries(["image", "scan", "named", "cluster", "maybe", "model-image"].map((kind) => [kind, b.heads(kind)]));
    artifact(b.dir, "flow.json", { facts: first.facts, landed: counts(first.landed), heads });
    expectGolden(heads);

    expect(await b.label()).toBeNull();
    expect(b.calls().slice(3)).toEqual([]);
  });

  it("L8 L5: a rename scans or groups anew, a model image draws another name than the person shows, or a statement whose box finds no face names one", async () => {
    const { b, p1, p2, p3 } = await flow();
    await b.label();
    const before = Object.fromEntries(["scan", "named", "cluster"].map((kind) => [kind, b.heads(kind)]));
    const calls = b.calls().length;
    b.land(PEOPLE, [{
      kind: "person", key: "person-a",
      content: {
        type: "people.person", slug: "person-a", name: "Person A", full_name: "Person A Fullname", show: "full_name", entity: "person", relationship: null,
        hidden: false, me: false, anchor: { kind: "phone", value: "+15550000001" }, handles: [], excluded: [], dismissed: [], merged_into: null,
      },
    }], "synthetic", ANY_PERSON);
    const renamed = (await b.label())!;
    expect(b.calls().slice(calls).map((call) => call.command)).toEqual(["scan"]);
    expect(renamed.lines.map((line) => [line.kind, line.key])).toEqual(sorted([p1, p2]).map((hex) => ["model-image", hex]));
    expect(b.content<JsonObject>("model-image", p1)).toEqual(modelImage([LEFT, "Person A Fullname", "person-a"], [RIGHT, null]));
    expect(renamed.facts).toMatchObject({ grouped: false, scanned: 0 });
    expect(Object.fromEntries(["scan", "named", "cluster"].map((kind) => [kind, b.heads(kind)]))).toEqual(before);
    b.land(PEOPLE, [{ kind: "person", key: "person-a", content: { ...(person("person-a", "Person A").content as JsonObject), name: null } }], "synthetic", ANY_PERSON);
    const unnamed = (await b.label())!;
    expect(unnamed.facts).toMatchObject({ grouped: false });
    expect(b.content<JsonObject>("model-image", p1)).toEqual(modelImage([LEFT, null], [RIGHT, null]));
    b.land(PEOPLE, [faceStatement(p3, LEFT, { is: "person-a" })]);
    expect(await b.label()).toBeNull();
    expect(b.calls().at(-1)!.command).toBe("group");
    expect(b.groupResult().unmatched).toEqual([{ photo: p3, box: LEFT }]);
    artifact(b.dir, "rename.json", { renamed: renamed.lines, unnamed: unnamed.lines });
  });

  it("L6: a merge chain is not followed to its end, in the faces or in the names a model image draws", async () => {
    const b = bench();
    const m1 = b.photo("m1", [{ box: LEFT, tier: "seed", tag: 5 }]);
    const m2 = b.photo("m2", [{ box: LEFT, tier: "seed", tag: 5 }]);
    b.land(GOOGLE, [googlePhoto(m1, "2025-01-01T10:00:00Z"), googlePhoto(m2, "2025-01-02T10:00:00Z")]);
    b.land(PEOPLE, [
      person("person-b", "Person B", "person-c"), person("person-c", "Person C", "person-d"), person("person-d", "Person D"),
      faceStatement(m1, LEFT, { is: "person-b" }),
    ]);
    await b.label();
    expect(b.calls().find((call) => call.command === "group")!.request.people).toEqual({ "person-b": "person-c", "person-c": "person-d" });
    for (const hex of [m1, m2]) {
      expect(b.who(faceKey(hex, LEFT))).toBe("person-d");
      expect(b.content<JsonObject>("model-image", hex)).toEqual(modelImage([LEFT, "Person D"]));
    }
    const calls = b.calls().length;
    b.land(PEOPLE, [person("person-d", "Person D", "person-e"), person("person-e", "Person E")]);
    expect((await b.label())!.facts).toMatchObject({ grouped: true });
    expect(b.calls().slice(calls).map((call) => call.command)).toEqual(["scan", "group"]);
    for (const hex of [m1, m2]) {
      expect(b.who(faceKey(hex, LEFT))).toBe("person-e");
      expect(b.content<JsonObject>("model-image", hex)).toEqual(modelImage([LEFT, "Person E"]));
    }
    expect(b.heads("named").map((head) => head.key)).toEqual(["person-e"]);
    b.land(PEOPLE, [faceStatement(m2, LEFT, { is_not: ["person-d"] }), faceStatement(m1, LEFT, { ignore: true })]);
    await b.label();
    expect([b.who(faceKey(m1, LEFT)), b.who(faceKey(m2, LEFT))]).toEqual(["", ""]);
    expect(b.heads("named")).toEqual([]);
    expect(b.content<JsonObject>("model-image", m1)).toEqual(modelImage([LEFT, null]));
    artifact(b.dir, "merges.json", { images: b.heads("model-image") });
  });

  it("L7 L35: an erased photo stays in its cluster or in its person's named faces, or is scanned again", async () => {
    const { b, p1, p2, p4, p5, c1 } = await flow();
    const p6 = b.photo("p6", [{ box: LEFT, tier: "seed", tag: 2 }]);
    b.land(GOOGLE, [googlePhoto(p6, "2025-01-01T10:00:00Z")]);
    b.cameraTook([p6]);
    await b.label();
    const [before] = b.heads("cluster");
    expect(b.who(faceKey(p2, LEFT))).toBe("person-a");
    const erased = b.home.db.commit((tx) => tx.records.erase({
      records: [p4, p2].flatMap((hex) => [{ source: GOOGLE, kind: "img", key: hex }, ...["image", "scan", "model-image"].map((kind) => ({ source: FACES, kind, key: hex }))]),
      units: [{ family: "photos", unit: `unknown/${Date.parse("2021-06-01T10:00:00Z")}/${p4}` }],
      reason: "a synthetic erasure", at_ms: T0,
    }));
    expect(erased.blobs).toEqual(expect.arrayContaining([`sha256:${p4}`, `sha256:${p2}`]));
    for (const blob of erased.blobs) b.blobs.remove(blob);
    const after = (await b.label())!;
    expect(after.facts).toMatchObject({ scanned: 0, grouped: true });
    expect(b.calls().filter((call) => call.command === "scan").at(-1)!.request.photos).toEqual([]);
    const clusters = b.heads("cluster");
    expect(clusters).toHaveLength(1);
    expect((clusters[0]!.content as unknown as { faces: ClusterFace[] }).faces.map((face) => face.face)).toEqual(sorted([faceKey(p1, RIGHT), faceKey(p5, RIGHT), faceKey(c1, LEFT), faceKey(p6, LEFT)]));
    expect(clusters[0]!.content).toMatchObject({ size: 4, photos: 4 });
    expect(clusters[0]!.content).not.toEqual(before!.content);
    expect(b.content<Named>("named", "person-a")!.photos.map((photo) => photo.face)).toEqual([faceKey(p1, LEFT)]);
    artifact(b.dir, "erase.json", { lines: after.lines, clusters, named: b.heads("named") });
  });

  it("L11 L10 L18: an image a chat names first gets no model image when a library photo names it too, counts as a chat image, or keeps the chat's flags", async () => {
    const b = bench();
    const photographed = ["l1", "l2", "l3"].map((name) => b.photo(name, [{ box: LEFT, tier: "seed", tag: 7 }]));
    b.land(GOOGLE, photographed.map((hex, index) => googlePhoto(hex, `2025-02-0${index + 1}T10:00:00Z`)));
    b.cameraTook(photographed);
    const shared = b.photo("shared", [{ box: LEFT, tier: "seed", tag: 7 }]);
    const other = b.photo("o1", [{ box: LEFT, tier: "seed", tag: 7 }]);
    b.land(WHATSAPP, [whatsappPhoto("3EB0B1", shared, "2025-03-01T10:00:00Z")]);
    b.land(IMESSAGE, [imessagePhoto("guid-o1", other, "2025-03-02T10:00:00Z", null)]);
    const chats = (await b.label())!;
    expect(keysOf(chats, "scan")).toEqual(sorted([...photographed, shared, other]));
    expect(keysOf(chats, "model-image")).toEqual(sorted(photographed));
    expect(b.heads("cluster")[0]!.content).toMatchObject({ size: 5, chat_share: 0.4 });
    expect(b.content<JsonObject>("image", shared)).toEqual({ library: false, chat: true, at_ms: Date.parse("2025-03-01T10:00:00Z"), senders: BY_B, labels: [] });

    b.land(GOOGLE, [googlePhoto(shared, "2025-03-01T09:00:00Z")]);
    const library = (await b.label())!;
    expect(library.facts).toMatchObject({ whole: false, images: 1 });
    expect(keysOf(library, "image")).toEqual([shared]);
    expect(b.content<JsonObject>("image", shared)).toEqual({ library: true, chat: true, at_ms: Date.parse("2025-03-01T09:00:00Z"), senders: BY_B, labels: [] });
    expect(library.facts).toMatchObject({ scanned: 0 });
    expect(keysOf(library, "model-image")).toEqual([shared]);
    expect(b.heads("cluster")[0]!.content).toMatchObject({ size: 5, chat_share: 0.2 });
    artifact(b.dir, "shared.json", { chats: chats.lines, library: library.lines });
  });

  it("L17: a Google Photos record is not inventoried, or a restatement of its sidecar's fields moves its image", async () => {
    const b = bench();
    const photo = b.photo("takeout", [{ box: LEFT, tier: "seed", tag: 1 }]);
    b.land(GOOGLE, [googlePhoto(photo, "2025-04-01T10:00:00Z", { description: "synthetic" })]);
    const run = (await b.label())!;
    expect(keysOf(run, "image")).toEqual([photo]);
    expect(keysOf(run, "scan")).toEqual([photo]);
    expect(keysOf(run, "model-image")).toEqual([photo]);
    expect(b.content<JsonObject>("image", photo)).toEqual({ library: true, chat: false, at_ms: Date.parse("2025-04-01T10:00:00Z"), senders: [], labels: [] });
    b.land(GOOGLE, [googlePhoto(photo, "2025-04-01T10:00:00Z", { description: "synthetic, edited" })]);
    expect(await b.label()).toBeNull();
    artifact(b.dir, "takeout.json", { lines: run.lines, facts: run.facts });
  });

  it("L19 L23: a message edited to drop its image keeps the image's record, or a chat photo whose bytes arrive late is never inventoried", async () => {
    const b = bench();
    const kept = b.photo("kept", [{ box: LEFT, tier: "seed", tag: 1 }]);
    const late = Buffer.from("synthetic photo late");
    const lateHex = sha256(late);
    b.config.faces![lateHex] = [{ box: LEFT, tier: "seed", tag: 1 }];
    b.configure();
    b.land(WHATSAPP, [whatsappPhoto("3EB0C1", kept, "2025-05-01T10:00:00Z"), whatsappPhoto("3EB0C2", lateHex, "2025-05-01T10:05:00Z")]);
    const first = (await b.label())!;
    expect(keysOf(first, "image")).toEqual([kept]);

    const hash = b.blobs.put(late);
    expect(b.home.db.commit((tx) => tx.records.blobsArrived([hash], {}))).toBe(1);
    const arrived = (await b.label())!;
    expect(arrived.facts).toMatchObject({ whole: false, images: 1, scanned: 1 });
    expect(b.content<JsonObject>("image", lateHex)).toEqual({ library: false, chat: true, at_ms: Date.parse("2025-05-01T10:05:00Z"), senders: BY_B, labels: [] });

    b.land(WHATSAPP, [whatsappPhoto("3EB0C1", null, "2025-05-01T10:00:00Z")]);
    const edited = (await b.label())!;
    expect(edited.lines.filter((line) => line.kind === "image")).toEqual([{ gone: true, key: kept, kind: "image" }]);
    expect(b.content("image", kept)).toBeUndefined();
    expect(b.content("scan", kept)).toBeDefined();
    artifact(b.dir, "moved.json", { first: first.lines, arrived: arrived.lines, edited: edited.lines });
  });

  it("L24 L25 L26: a group's or the owner's image names a sender, a one-to-one image names none or another spelling, or a sidecar's people are missed or doubled", async () => {
    const b = bench();
    const LID = "123456789012345@lid";
    const [group, own, partner, lidChat, phone, imGroup, imOwn, address, named, unnamed, both, shortCode] =
      ["group", "own", "partner", "lid", "phone", "im-group", "im-own", "address", "named", "unnamed", "both", "short-code"].map((name) => b.photo(name)) as string[];
    b.land(WHATSAPP, [
      whatsappPhoto("3EB0F1", group!, "2025-08-01T10:00:00Z", 1, { chat: "120363000000000001@g.us", member: "15550000005@s.whatsapp.net" }),
      whatsappPhoto("3EB0F2", own!, "2025-08-01T10:01:00Z", 1, { me: true }),
      whatsappPhoto("3EB0F3", partner!, "2025-08-01T10:02:00Z"),
      whatsappPhoto("3EB0F4", lidChat!, "2025-08-01T10:03:00Z", 1, { chat: LID, from: "15550000003@S.WHATSAPP.NET" }),
      whatsappPhoto("3EB0F5", both!, "2025-08-01T10:04:00Z"),
    ]);
    b.land(IMESSAGE, [
      imessagePhoto("guid-f1", phone!, "2025-08-01T11:00:00Z", "image/jpeg", { sender: handle("+1 (555) 000-0004", "+15550000004", "phone") }),
      imessagePhoto("guid-f2", imGroup!, "2025-08-01T11:01:00Z", "image/jpeg", { recipients: [handle("person-e@example.com", "person-e@example.com", "email")] }),
      imessagePhoto("guid-f3", imOwn!, "2025-08-01T11:02:00Z", "image/jpeg", { me: true }),
      imessagePhoto("guid-f4", address!, "2025-08-01T11:03:00Z", "image/jpeg", { sender: handle("Person-E@Example.com", "person-e@example.com", "email") }),
      imessagePhoto("guid-f5", shortCode!, "2025-08-01T11:04:00Z", "image/jpeg", { sender: handle("12345", "12345", "raw") }),
    ]);
    b.land(GOOGLE, [
      googlePhoto(named!, "2025-08-02T10:00:00Z", people("Person F", "Person G", "Person F")),
      googlePhoto(unnamed!, "2025-08-02T11:00:00Z", { people: [{ name: " " }, {}] }),
      googlePhoto(both!, "2025-08-02T12:00:00Z", people("Person H")),
    ]);
    const run = (await b.label())!;
    const images = Object.fromEntries(b.heads("image").map(({ key, content }) => [key, content]));
    const jid = (value: string) => ({ kind: "jid", value });
    const of = (hex: string) => images[hex] as { senders: unknown[]; labels: string[]; library: boolean; chat: boolean };
    for (const hex of [group!, own!, imGroup!, imOwn!, shortCode!, unnamed!]) expect([of(hex).senders, of(hex).labels]).toEqual([[], []]);
    expect(of(partner!).senders).toEqual([jid("15550000002@s.whatsapp.net")]);
    expect(of(lidChat!).senders).toEqual([jid("15550000003@s.whatsapp.net")]);
    expect(of(phone!).senders).toEqual([{ kind: "phone", value: "+15550000004" }]);
    expect(of(address!).senders).toEqual([{ kind: "email", value: "person-e@example.com" }]);
    expect(of(named!).labels).toEqual(["Person F", "Person G"]);
    expect(of(both!)).toEqual({ library: true, chat: true, at_ms: Date.parse("2025-08-02T12:00:00Z"), senders: [jid("15550000002@s.whatsapp.net")], labels: ["Person H"] });
    b.land(GOOGLE, [googlePhoto(unnamed!, "2025-08-02T11:00:00Z", { people: [{ name: " " }, {}, { name: "Person I" }] })]);
    const relabelled = (await b.label())!;
    expect(relabelled.lines.filter((line) => line.kind === "image")).toEqual([
      { kind: "image", key: unnamed, content: { library: true, chat: false, at_ms: Date.parse("2025-08-02T11:00:00Z"), senders: [], labels: ["Person I"] } },
    ]);
    artifact(b.dir, "senders.json", { images, facts: run.facts, relabelled: relabelled.lines });
  });

  it("L28: a network the release does not know names its sender by its handle's id, never a phone, never none", async () => {
    const b = bench({ messages: [{ product: "example-chat", adapter: EXAMPLE_CHAT }] });
    const [numeric, worded] = ["numeric", "worded"].map((name) => b.photo(name)) as string[];
    b.land(NETWORK, [examplePhoto("m1", numeric!, "2025-09-01T10:00:00Z", "123456789"), examplePhoto("m2", worded!, "2025-09-01T10:01:00Z", "user-a1")]);
    await b.label();
    const images = Object.fromEntries(b.heads("image").map(({ key, content }) => [key, content as { senders: unknown[] }]));
    expect([images[numeric!]?.senders, images[worded!]?.senders]).toEqual([
      [{ kind: "network", value: "example-chat:123456789" }], [{ kind: "network", value: "example-chat:user-a1" }],
    ]);
    artifact(b.dir, "network-senders.json", { images });
  });

  it("L27: a cluster's evidence miscounts the faces a sender or a label touches, keeps more than five, or its year_count is not its distinct years", async () => {
    const b = bench();
    const face = [{ box: LEFT, tier: "seed" as const, tag: 4 }];
    const hexes = Array.from({ length: 6 }, (_, index) => b.photo(`evidence-${index}`, face));
    b.land(WHATSAPP, hexes.slice(0, 4).map((hex, index) => whatsappPhoto(`3EB1${index}`, hex, `${2019 + (index % 2)}-03-01T10:00:00Z`)));
    b.land(IMESSAGE, [imessagePhoto("guid-e1", hexes[4]!, "2024-03-01T10:00:00Z", "image/jpeg", { sender: handle("person-e@example.com", "person-e@example.com", "email") })]);
    b.land(GOOGLE, [
      googlePhoto(hexes[0]!, "2019-03-01T09:00:00Z", people("Person K", "Person J", "Person N")),
      googlePhoto(hexes[1]!, "2020-03-01T09:00:00Z", people("Person K", "Person J", "Person M")),
      googlePhoto(hexes[5]!, "2021-03-01T09:00:00Z", people("Person K", "Person L", "Person O", "Person P")),
    ]);
    b.cameraTook([hexes[0]!, hexes[1]!, hexes[5]!]);
    await b.label();
    const [cluster] = b.heads("cluster");
    expect(cluster!.content).toMatchObject({
      size: 6, photos: 6, years: [2019, 2024], year_count: 4,
      evidence: {
        senders: [{ faces: 4, kind: "jid", value: "15550000002@s.whatsapp.net" }, { faces: 1, kind: "email", value: "person-e@example.com" }],
        labels: [{ faces: 3, name: "Person K" }, { faces: 2, name: "Person J" }, { faces: 1, name: "Person L" }, { faces: 1, name: "Person M" }, { faces: 1, name: "Person N" }],
      },
    });
    const content = cluster!.content as JsonObject;
    const evidence = content.evidence as { senders: JsonObject[]; labels: JsonObject[] };
    const refusals = [
      { ...content, evidence: { ...evidence, senders: [...evidence.senders].reverse() } },
      { ...content, evidence: { ...evidence, labels: [...evidence.labels, { faces: 1, name: "Person Z" }] } },
      { ...content, evidence: { ...evidence, senders: [{ ...evidence.senders[0]!, faces: 7 }] } },
      { ...content, year_count: 7 },
      { ...content, years: null },
    ].map((bad) => clusterGuard(bad as unknown as Json));
    expect(refusals.every((violations) => violations.length > 0)).toBe(true);
    artifact(b.dir, "evidence.json", { cluster: cluster!.content, refusals });
  });

  it("L20: an erasure of the image's last record leaves its image record, or an erasure of one of two records takes it", async () => {
    const b = bench();
    const alone = b.photo("alone", [{ box: LEFT, tier: "seed", tag: 1 }]);
    const shared = b.photo("shared", [{ box: LEFT, tier: "seed", tag: 1 }]);
    b.land(GOOGLE, [googlePhoto(alone, "2025-06-01T10:00:00Z"), googlePhoto(shared, "2025-06-02T10:00:00Z")]);
    b.land(WHATSAPP, [whatsappPhoto("3EB0D1", shared, "2025-06-03T10:00:00Z")]);
    await b.label();
    expect(b.content<JsonObject>("image", shared)).toEqual({ library: true, chat: true, at_ms: Date.parse("2025-06-02T10:00:00Z"), senders: BY_B, labels: [] });
    b.home.db.commit((tx) => tx.records.erase({
      records: [{ source: GOOGLE, kind: "img", key: alone }, ...["image", "scan", "model-image"].map((kind) => ({ source: FACES, kind, key: alone }))],
      reason: "a synthetic erasure", at_ms: T0,
    }));
    b.home.db.commit((tx) => tx.records.erase({ records: [{ source: WHATSAPP, kind: "msg", key: "15550000002@s.whatsapp.net:3EB0D1" }], reason: "a synthetic erasure", at_ms: T0 }));
    const after = await b.label();
    expect(keysOf(after, "image")).toEqual([]);
    expect(b.content("image", alone)).toBeUndefined();
    expect(b.content("scan", alone)).toBeUndefined();
    expect(b.content<JsonObject>("image", shared)).toMatchObject({ library: true, chat: true });
    b.land(GOOGLE, [googlePhoto(shared, "2025-06-02T10:00:00Z", { description: "synthetic" })]);
    const touched = (await b.label())!;
    expect(keysOf(touched, "image")).toEqual([shared]);
    expect(b.content<JsonObject>("image", shared)).toEqual({ library: true, chat: false, at_ms: Date.parse("2025-06-02T10:00:00Z"), senders: [], labels: [] });
    artifact(b.dir, "erasures.json", { after: after?.lines ?? null, touched: touched.lines });
  });

  it("L21: the first run on a home with images landed misses one", async () => {
    const b = bench();
    const library = b.photo("library", [{ box: LEFT, tier: "seed", tag: 1 }]);
    const chat = b.photo("chat", [{ box: LEFT, tier: "seed", tag: 1 }]);
    const both = b.photo("both", [{ box: LEFT, tier: "seed", tag: 1 }]);
    b.land(GOOGLE, [googlePhoto(library, "2025-07-01T10:00:00Z"), googlePhoto(both, "2025-07-03T10:00:00Z")]);
    b.land(WHATSAPP, [whatsappPhoto("3EB0E1", chat, "2025-07-02T10:00:00Z"), whatsappPhoto("3EB0E2", both, "2025-07-02T11:00:00Z")]);
    const whole = (await b.label())!;
    expect(whole.facts).toMatchObject({ whole: true, images: 3, scanned: 3 });
    expect(Object.fromEntries(b.heads("image").map(({ key, content }) => [key, content]))).toEqual({
      [library]: { library: true, chat: false, at_ms: Date.parse("2025-07-01T10:00:00Z"), senders: [], labels: [] },
      [chat]: { library: false, chat: true, at_ms: Date.parse("2025-07-02T10:00:00Z"), senders: BY_B, labels: [] },
      [both]: { library: true, chat: true, at_ms: Date.parse("2025-07-03T10:00:00Z"), senders: BY_B, labels: [] },
    });
    expect(await b.label()).toBeNull();
    expect(b.inputReads()).toEqual([]);
    artifact(b.dir, "first-run.json", { facts: whole.facts, images: b.heads("image") });
  });

  it("L22: a run with nothing moved reads an input record, or grows with the number of messages", async () => {
    const { b } = await flow();
    await b.label();
    expect(await b.label()).toBeNull();
    expect(b.inputReads()).toEqual([]);
    const texts = Array.from({ length: 20_000 }, (_, index) => whatsappPhoto(`T${index}`, null, new Date(Date.UTC(2025, 7, 1) + index * 1000).toISOString()));
    b.land(WHATSAPP, texts);
    expect(await b.label()).toBeNull();
    expect(b.inputReads().length).toBeGreaterThan(0);
    expect(await b.label()).toBeNull();
    expect(b.inputReads()).toEqual([]);
    artifact(b.dir, "quiet.json", { reads: b.inputReads() });
  });

  it("L9: more than 2,000 owed photos are scanned in one run, the newest first, or the next run does not go on with the rest", async () => {
    const b = bench();
    const hexes = Array.from({ length: SCAN_BOUND + 1 }, (_, index) => b.blobs.put(Buffer.from(`synthetic photo bulk-${index}`)).slice("sha256:".length));
    b.land(GOOGLE, hexes.map((hex, index) => googlePhoto(hex, new Date(Date.UTC(2025, 0, 1) + index * 60_000).toISOString())));
    const first = (await b.label())!;
    expect(first.facts).toMatchObject({ scanned: SCAN_BOUND, owed: 1 });
    expect(keysOf(first, "scan")).toEqual(sorted(hexes.slice(1)));
    const second = (await b.label())!;
    expect(second.facts).toMatchObject({ scanned: 1, owed: 0 });
    expect(keysOf(second, "scan")).toEqual([hexes[0]]);
    expect(await b.label()).toBeNull();
    artifact(b.dir, "bound.json", { first: first.facts, second: second.facts });
  });

  it("L29 L34 L31 L32: a backlog groups before its last run, gives a scanned photo no model image until it is grouped, or the runs after it read a record or group again", async () => {
    const b = bench({ scanBound: 2 });
    const hexes = Array.from({ length: 5 }, (_, index) => b.photo(`backlog-${index}`, [{ box: LEFT, tier: "seed", tag: 1 }]));
    b.land(GOOGLE, hexes.map((hex, index) => googlePhoto(hex, `2025-02-0${index + 1}T10:00:00Z`)));
    b.land(PEOPLE, [person("person-a", "Person A"), faceStatement(hexes[0]!, LEFT, { is: "person-a" })]);
    const runs: { facts: JsonObject; commands: string[]; kinds: string[] }[] = [];
    for (let run = 0; run < 3; run++) {
      const before = b.calls().length;
      const labelled = (await b.label())!;
      runs.push({ facts: labelled.facts, commands: b.calls().slice(before).map((call) => call.command), kinds: [...new Set(labelled.lines.map((line) => line.kind))].sort() });
    }
    expect(runs.map((run) => run.commands)).toEqual([["scan", "scan"], ["scan", "scan"], ["scan", "scan", "group"]]);
    expect(runs.map((run) => [run.facts.scanned, run.facts.owed, run.facts.grouped])).toEqual([[2, 3, false], [2, 1, false], [1, 0, true]]);
    expect(runs.map((run) => run.kinds)).toEqual([["image", "model-image", "scan"], ["model-image", "scan"], ["model-image", "named", "scan"]]);
    expect(b.heads("model-image").map((head) => head.content)).toEqual(hexes.map(() => modelImage([LEFT, "Person A"])));

    const settled = b.calls().length;
    expect(await b.label()).toBeNull();
    expect(b.contentReads()).toEqual([]);
    expect(b.calls().length).toBe(settled);

    const sent = b.photo("sent", [{ box: LEFT, tier: "seed", tag: 1 }]);
    b.land(WHATSAPP, [whatsappPhoto("3EB3A1", sent, "2025-02-06T10:00:00Z")]);
    const chat = (await b.label())!;
    expect(b.calls().slice(settled).map((call) => [call.command, (call.request.photos as { key: string }[]).map((photo) => photo.key).length])).toEqual([["scan", 0], ["scan", 1], ["group", 6]]);
    expect(b.calls().at(-2)!.request.photos).toEqual([{ key: sent, path: expect.any(String) }]);
    expect(chat.facts).toMatchObject({ scanned: 1, grouped: true });
    expect(keysOf(chat, "model-image")).toEqual([]);
    expect(b.who(faceKey(sent, LEFT))).toBe("person-a");

    const quiet = b.calls().length;
    expect(await b.label()).toBeNull();
    expect(b.contentReads()).toEqual([]);
    const voice = b.blobs.put(Buffer.from("synthetic voice note")).slice("sha256:".length);
    b.land(WHATSAPP, [whatsappPhoto("3EB3A2", voice, "2025-02-06T10:05:00Z", 3)]);
    expect(await b.label()).toBeNull();
    expect(b.contentReads().filter((read) => read.method !== "naming" && read.kind !== "msg")).toEqual([]);
    expect(b.calls().length).toBe(quiet);
    artifact(b.dir, "backlog.json", { runs, chat: chat.facts });
  });

  it("L30: a naming made during a backlog waits for the backlog's end", async () => {
    const b = bench({ scanBound: 2 });
    const hexes = Array.from({ length: 5 }, (_, index) => b.photo(`named-${index}`, [{ box: LEFT, tier: "seed", tag: 1 }]));
    b.land(GOOGLE, hexes.map((hex, index) => googlePhoto(hex, `2025-03-0${index + 1}T10:00:00Z`)));
    const grouped: boolean[] = [];
    grouped.push((await b.label())!.facts.grouped as boolean);
    b.land(PEOPLE, [person("person-a", "Person A"), faceStatement(hexes[4]!, LEFT, { is: "person-a" })]);
    const naming = (await b.label())!;
    grouped.push(naming.facts.grouped as boolean);
    expect(naming.facts).toMatchObject({ scanned: 2, owed: 1, grouped: true });
    expect(keysOf(naming, "model-image")).toEqual(sorted(hexes.slice(1)));
    for (const hex of hexes.slice(1)) expect(b.who(faceKey(hex, LEFT))).toBe("person-a");
    grouped.push((await b.label())!.facts.grouped as boolean);
    expect(grouped).toEqual([false, true, true]);
    artifact(b.dir, "naming.json", { grouped, naming: naming.facts });
  });

  it("L33: a scan of an image no record names any more is grouped, or its faces and its place in a cluster stand", async () => {
    const b = bench();
    const hexes = ["a", "b", "c"].map((name) => b.photo(`gone-${name}`, [{ box: LEFT, tier: "seed", tag: 6 }]));
    b.land(GOOGLE, hexes.map((hex, index) => googlePhoto(hex, `2025-04-0${index + 1}T10:00:00Z`)));
    b.cameraTook(hexes);
    await b.label();
    expect(b.heads("cluster")).toHaveLength(1);
    b.land(GOOGLE, [{ kind: "img", key: hexes[0]!, content: null, gone: true }]);
    const edited = (await b.label())!;
    expect(b.calls().at(-1)!.command).toBe("group");
    expect((b.calls().at(-1)!.request.photos as { key: string }[]).map((photo) => photo.key)).toEqual(sorted(hexes.slice(1)));
    expect(edited.lines.filter((line) => line.gone === true).map((line) => [line.kind, line.key])).toEqual(expect.arrayContaining([["image", hexes[0]]]));
    expect(b.content("scan", hexes[0]!)).toBeDefined();
    expect(b.heads("cluster")).toEqual([]);
    artifact(b.dir, "gone.json", { lines: edited.lines });
  });

  it("L13 L35: a new pipeline leaves a photo scanned under the old one", async () => {
    const { b, p1 } = await flow();
    await b.label();
    expect(await b.label()).toBeNull();
    b.config.pipeline = { ...PIPELINE, version: 2 };
    b.configure();
    const again = (await b.label())!;
    expect(again.facts).toMatchObject({ scanned: 8, grouped: true });
    expect(new Set(b.heads("scan").map((head) => (head.content as JsonObject).pipeline))).toEqual(new Set([again.facts.pipeline]));
    expect(keysOf(again, "named")).toEqual([]);
    expect(b.who(faceKey(p1, LEFT))).toBe("person-a");
    expect(b.content<JsonObject>("model-image", p1)).toEqual(modelImage([LEFT, "Person A"], [RIGHT, null]));
  });

  it("L36: a model image is drawn by the labeler or delivered as a JPEG, or one of another shape (a JPEG drawn, names drawn) is never restated as every face and its name", async () => {
    const { b, p1 } = await flow();
    await b.label();
    expect(b.calls().map((call) => call.command)).not.toContain("draw");
    const jpeg = b.blobs.put(Buffer.from("synthetic drawn jpeg of p1"));
    const names = [{ name: "Person A", box: LEFT }];
    b.land(FACES, [{ kind: "model-image", key: p1, content: { blob: jpeg, width: 1536, height: 1152, drawn: names }, blobs: [jpeg] }], "faces", { "model-image": () => [] });
    b.passed();
    const restated = (await b.label())!;
    expect(restated.lines).toEqual([{ kind: "model-image", key: p1, content: modelImage([LEFT, "Person A"], [RIGHT, null]) }]);
    expect(restated.files.map((file) => file.path)).toEqual(["faces.ndjson"]);
    expect(b.content("model-image", p1)).toEqual(modelImage([LEFT, "Person A"], [RIGHT, null]));
    const view = b.home.db.view();
    try {
      expect(view.blobsOf(view.head({ source: FACES, kind: "model-image", key: p1 })!.version)).toEqual([]);
    } finally {
      view.close();
    }
    expect(await b.label()).toBeNull();
    artifact(b.dir, "restated.json", { lines: restated.lines, facts: restated.facts });
  });

  it("L37: the home's drawing is not the engine's draw of the photo with its faces, leaves its folder, answers bytes for a photo that does not decode, or a labeler run removes it", async () => {
    const { b, p1 } = await flow();
    const names = [{ name: "Person A", box: LEFT }];
    const bytes = b.labeler.draw(`sha256:${p1}`, names);
    expect(bytes.toString("utf8")).toBe(`drawn ${p1} ${JSON.stringify(names)}`);
    expect(b.calls().map((call) => call.request)).toEqual([{ images: [{ path: join(b.settings.blobs, p1.slice(0, 2), p1.slice(2, 4), p1), output: expect.stringContaining(join(b.settings.work, "draw-")), faces: names }] }]);
    expect(readdirSync(b.settings.work)).toEqual([]);
    const broken = b.photo("broken", [], Buffer.from("not an image: synthetic bytes, broken"));
    expect(() => b.labeler.draw(`sha256:${broken}`, [])).toThrow(/face-engine draw did not draw/u);
    b.config.fail = { draw: 1 };
    b.configure();
    expect(() => b.labeler.draw(`sha256:${p1}`, names)).toThrow(/face-engine draw failed: exit 1: face-engine: a fake failure/u);
    expect(readdirSync(b.settings.work)).toEqual([]);
    b.config.fail = {};
    b.configure();
    mkdirSync(join(b.settings.work, "draw-in-flight"));
    await b.label();
    expect(readdirSync(b.settings.work).sort()).toEqual(["draw-in-flight", "run"]);
    artifact(b.dir, "draw.json", { drawn: bytes.toString("utf8"), calls: b.calls().filter((call) => call.command === "draw").map((call) => call.request) });
  });

  it("L50: a scan stated under the pipeline's CBOR id is scanned again, restated other than as it stands or when its files are gone, or its files delivered again", async () => {
    const { b, p1 } = await flow();
    await b.label();
    const before = b.heads("scan");
    const lost = before.find((head) => typeof (head.content as JsonObject).vectors === "string" && head.key !== p1)!;
    b.land(FACES, before.map((head) => {
      const content = { ...(head.content as JsonObject), pipeline: CBOR_PIPELINE, ...(head.key === lost.key ? { vectors: `sha256:${"f".repeat(64)}` } : {}) };
      const blobs = head.key === lost.key ? [] : namedBlobs("scan", content);
      return { kind: "scan", key: head.key, content, ...(blobs.length === 0 ? {} : { blobs }) };
    }), "faces", { scan: () => [] });
    b.passed();
    const again = (await b.label())!;
    expect(again.facts).toMatchObject({ scanned: 1, restated: before.length - 1 });
    expect(again.lines.filter((line) => line.kind === "scan").map((line) => line.key).sort()).toEqual(before.map((head) => head.key).sort());
    expect(b.heads("scan")).toEqual(before.map((head) => expect.objectContaining({ key: head.key, version: head.version })));
    expect(keysOf(again, "named")).toEqual([]);
    expect(b.who(faceKey(p1, LEFT))).toBe("person-a");
    b.passed();
    expect(await b.label()).toBeNull();
  });

  it("L1: the engine is missing, or its model files are, and a run starts anyway", async () => {
    const missing = bench({ engine: "/nonexistent/face-engine" });
    await expect(missing.label()).rejects.toMatchObject({ reason: "not-installed", message: expect.stringMatching(/face engine is not built/u) });
    const unfetched = bench({ models: false });
    await expect(unfetched.label()).rejects.toMatchObject({ reason: "not-installed", message: expect.stringMatching(/det_10g\.onnx, w600k_r50\.onnx missing .*lifestream faces on/u) });
    expect(unfetched.calls()).toEqual([]);
  });

  it("L2 L3: a failing, refusing or hanging engine delivers part of a run, or a stopped run leaves the next one less to do", async () => {
    const { b, p1, p2, p3, p4, p5, c1, s1, u } = await flow();
    const failures: Record<string, string> = {};
    const fails = async (reason: string): Promise<void> => {
      const error = await b.label().then(() => null, (thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(LabelerUnavailable);
      expect((error as LabelerUnavailable).reason).toBe(reason);
      failures[reason] = (error as Error).message;
    };
    b.config.fail = { group: 1 };
    b.configure();
    await fails("crashed");
    expect(failures.crashed).toMatch(/face-engine group failed: exit 1: face-engine: a fake failure/u);
    b.config.fail = { group: 2 };
    b.configure();
    await fails("unreadable");
    expect(failures.unreadable).toMatch(/face-engine group could not read the request/u);
    expect(b.heads("scan")).toEqual([]);
    const slow = bench({ timeoutMs: 1_500 });
    slow.config.hang = "scan";
    slow.configure();
    const error = await slow.label().then(() => null, (thrown: unknown) => thrown);
    expect((error as LabelerUnavailable).reason).toBe("timeout");
    b.config.fail = {};
    b.configure();
    const scans = () => b.calls().filter((call) => call.command === "scan" && (call.request.photos as unknown[]).length > 0).length;
    const before = scans();
    const done = (await b.label())!;
    expect(scans()).toBe(before + 1);
    expect(keysOf(done, "scan")).toEqual(sorted([p1, p2, p3, p4, p5, c1, s1, u]));
    artifact(b.dir, "failures.json", { failures, timeout: (error as Error).message });
  });

  it("L15: the connector lands part of a delivery with a bad line, a missing file, a faces record with content, a named record out of order, or a slug too long", async () => {
    const { b } = await flow();
    const good = (await b.label())!;
    const listing = fetchedBytes(good.files.find((file) => file.path === "faces.ndjson")!).toString("utf8").trim().split("\n");
    const deliver = (lines: string[], files = good.files.filter((file) => file.path !== "faces.ndjson")): Delivery => {
      const stored = [{ path: "faces.ndjson", bytes: Buffer.from(`${lines.join("\n")}\n`) }, ...files].map((file) => {
        const bytes = fetchedBytes(file);
        return { path: file.path, blob: b.blobs.put(bytes), size: bytes.length };
      });
      return { id: "bad", source: FACES, sealed_ms: T0, stated_ms: T0, facts: {}, files: stored };
    };
    const refusals: string[] = [];
    const refused = async (delivery: Delivery) => {
      let given = 0;
      const reading = (async () => {
        for await (const _ of facesConnector.read(delivery, b.blobs)) given++;
      })();
      await expect(reading).rejects.toBeInstanceOf(Refused);
      await reading.catch((error: Error) => refusals.push(error.message));
      expect(given).toBe(0);
    };
    const middle = Math.floor(listing.length / 2);
    await refused(deliver([...listing.slice(0, middle), "{not json", ...listing.slice(middle)]));
    const unheld = `sha256:${"f".repeat(64)}`;
    const scanned = listing.findIndex((line) => line.includes('"kind":"scan"') && line.includes('"vectors":"sha256:'));
    const stray = JSON.parse(listing[scanned]!) as { content: JsonObject };
    await refused(deliver(listing.map((line, index) => (index === scanned ? JSON.stringify({ ...stray, content: { ...stray.content, vectors: unheld } }) : line))));
    const photo = "0".repeat(64);
    await refused(deliver([...listing, JSON.stringify({ content: { faces: [], height: 3000, width: 4000 }, key: photo, kind: "faces" })]));
    expect(await collect(facesConnector.read(deliver([...listing, JSON.stringify({ gone: true, key: photo, kind: "faces" })]), b.blobs))).toHaveLength(listing.length + 1);
    const named = listing.map((line) => JSON.parse(line) as { kind: string; key: string; content: Named }).find((line) => line.kind === "named")!;
    await refused(deliver([...listing.filter((line) => !line.includes('"kind":"named"')), JSON.stringify({ ...named, content: { ...named.content, photos: [...named.content.photos].reverse() } })]));
    await refused(deliver(listing, [{ path: `${"0".repeat(64)}.jpg`, bytes: Buffer.from("synthetic") }]));
    const clustered = listing.findIndex((line) => line.includes('"kind":"cluster"'));
    const cluster = JSON.parse(listing[clustered]!) as { content: JsonObject };
    await refused(deliver(listing.map((line, index) => (index === clustered ? JSON.stringify({ ...cluster, content: { ...cluster.content, suggested: [{ person: "a".repeat(65), score: 0.5 }] } }) : line))));
    expect(refusals.at(-1)).toContain(notASlug("each suggested person"));
    artifact(b.dir, "refusals.json", refusals);
  });

  it("L16: the install leaves the models unfetched, fetches them twice, passes a failing self-check, or leaves models that failed it installed", async () => {
    const b = bench({ models: false });
    writeFileSync(b.settings.fetch, `#!/bin/sh\necho fetched >> '${join(b.dir, "fetch.log")}'\nmkdir -p "$1" && echo synthetic > "$1/det_10g.onnx" && echo synthetic > "$1/w600k_r50.onnx"\n`);
    await expect(b.label()).rejects.toMatchObject({ reason: "not-installed" });
    expect(await b.labeler.install()).toMatchObject({ ok: true });
    await expect(b.label()).resolves.toBeNull();
    await b.labeler.install();
    expect(readFileSync(join(b.dir, "fetch.log"), "utf8").trim().split("\n")).toEqual(["fetched"]);
    const reference = b.settings.reference;
    expect(b.calls().filter((call) => call.command === "self-check").map((call) => call.request)).toEqual([
      { models: b.settings.models, reference }, { models: b.settings.models, reference },
    ]);
    b.config.selfCheck = false;
    b.configure();
    await expect(b.labeler.install()).rejects.toThrow(/self-check did not pass/u);
    expect(modelsInstalled(b.settings.models)).toBe(false);
    await expect(b.label()).rejects.toMatchObject({ reason: "not-installed", message: expect.stringMatching(/have not passed the engine's self-check/u) });
    b.config.selfCheck = true;
    b.configure();
    expect(await b.labeler.install()).toMatchObject({ ok: true });
    expect(modelsInstalled(b.settings.models)).toBe(true);
    expect(readFileSync(join(b.dir, "fetch.log"), "utf8").trim().split("\n")).toEqual(["fetched"]);
    const unbuilt = bench({ engine: join(b.dir, "unbuilt", "face-engine") });
    await expect(unbuilt.labeler.install()).rejects.toThrow(/face engine is not built/u);
  });

  it("L38 L39: a chat image of a named person does not join them, a chat image starts a group, or a stranger's screenshot seen thirty times makes one", async () => {
    const b = bench();
    const named = b.photo("named", [{ box: LEFT, tier: "seed", tag: 1 }]);
    b.land(GOOGLE, [googlePhoto(named, "2025-01-01T10:00:00Z")]);
    b.cameraTook([named]);
    b.land(PEOPLE, [person("person-a", "Person A"), faceStatement(named, LEFT, { is: "person-a" })]);
    const ofA = ["a1", "a2", "a3"].map((name) => b.photo(`chat-${name}`, [{ box: LEFT, tier: "seed", tag: 1 }]));
    const ofStranger = ["s1", "s2", "s3"].map((name) => b.photo(`chat-${name}`, [{ box: LEFT, tier: "seed", tag: 2 }]));
    b.land(WHATSAPP, [...ofA, ...ofStranger].map((hex, index) => whatsappPhoto(`3EB5A${index}`, hex, `2025-01-0${index + 2}T10:00:00Z`)));
    const shots = Array.from({ length: 30 }, (_, index) => b.photo(`shot-${index}`, [{ box: LEFT, tier: "seed", tag: 3 }]));
    b.land(GOOGLE, shots.map((hex, index) => googlePhoto(hex, new Date(Date.UTC(2025, 1, 1) + index * 60_000).toISOString())));
    const run = (await b.label())!;
    expect(run.facts).toMatchObject({ grouped: true, clusters: 0 });
    for (const hex of ofA) expect(b.who(faceKey(hex, LEFT))).toBe("person-a");
    for (const hex of [...ofStranger, ...shots]) expect(b.who(faceKey(hex, LEFT))).toBe("");
    expect(b.heads("cluster")).toEqual([]);
    artifact(b.dir, "no-camera.json", { facts: run.facts, named: b.heads("named") });
  });

  it("L40: the camera labeler states its photos after the faces labeler grouped, and the faces labeler does not group again, or groups more than once", async () => {
    const b = bench();
    const hexes = ["a", "b", "c"].map((name) => b.photo(`late-camera-${name}`, [{ box: LEFT, tier: "seed", tag: 4 }]));
    b.land(GOOGLE, hexes.map((hex, index) => googlePhoto(hex, `2025-05-0${index + 1}T10:00:00Z`)));
    const before = (await b.label())!;
    expect(before.facts).toMatchObject({ grouped: true, clusters: 0 });
    const calls = b.calls().length;
    b.cameraTook(hexes);
    const regrouped = (await b.label())!;
    expect(regrouped.facts).toMatchObject({ grouped: true, scanned: 0, clusters: 1 });
    expect(await b.label()).toBeNull();
    b.passed();
    expect(await b.label()).toBeNull();
    expect(b.calls().slice(calls).filter((call) => call.command === "group")).toHaveLength(1);
    artifact(b.dir, "late-camera.json", { before: before.facts, regrouped: regrouped.facts });
  });

  it("L41: a backlog past the battery bar scans on battery, one at the bar waits, Scan now does not run it, or the scans do not go newest first", async () => {
    const b = bench({ battery_backlog: 2 });
    b.power.mains = false;
    const hexes = Array.from({ length: 3 }, (_, index) => b.blobs.put(Buffer.from(`synthetic photo power-${index}`)).slice("sha256:".length));
    b.land(GOOGLE, hexes.map((hex, index) => googlePhoto(hex, `2025-06-0${index + 1}T10:00:00Z`)));
    const waiting = await b.label().then(() => null, (thrown: unknown) => thrown as LabelerUnavailable);
    expect(waiting).toMatchObject({ reason: "waiting-for-power", message: expect.stringMatching(/^3 images are owed a scan, more than faces\.battery_backlog \(2\)/u) });
    expect(b.calls().filter((call) => ((call.request.photos as unknown[] | undefined)?.length ?? 0) > 0)).toEqual([]);
    b.home.db.commit((tx) => tx.tables.meta.set(SCAN_NOW, String(T0)));
    const now = (await b.label())!;
    expect(now.facts).toMatchObject({ scanned: 3, owed: 0 });
    expect((b.calls().filter((call) => call.command === "scan").at(-1)!.request.photos as { key: string }[]).map((photo) => photo.key)).toEqual([...hexes].reverse());
    b.home.db.commit((tx) => tx.tables.meta.delete(SCAN_NOW));
    const more = Array.from({ length: 2 }, (_, index) => b.blobs.put(Buffer.from(`synthetic photo power-more-${index}`)).slice("sha256:".length));
    b.land(GOOGLE, more.map((hex, index) => googlePhoto(hex, `2025-07-0${index + 1}T10:00:00Z`)));
    expect((await b.label())!.facts).toMatchObject({ scanned: 2, owed: 0 });
    b.power.mains = true;
    const plugged = Array.from({ length: 3 }, (_, index) => b.blobs.put(Buffer.from(`synthetic photo power-plugged-${index}`)).slice("sha256:".length));
    b.land(GOOGLE, plugged.map((hex, index) => googlePhoto(hex, `2025-08-0${index + 1}T10:00:00Z`)));
    expect((await b.label())!.facts).toMatchObject({ scanned: 3, owed: 0 });
    artifact(b.dir, "power.json", { waiting: waiting!.message, now: now.facts });
  });

  it("L42: a face group declined for a person is suggested for them again once it gains faces, or its suggestions come without their scores", async () => {
    const b = bench();
    b.config.suggested = { 5: [{ person: "person-b", score: 0.7 }, { person: "person-c", score: 0.55 }] };
    const hexes = ["a", "b", "c"].map((name) => b.photo(`declined-${name}`, [{ box: LEFT, tier: "seed", tag: 5 }]));
    b.land(GOOGLE, hexes.map((hex, index) => googlePhoto(hex, `2025-09-0${index + 1}T10:00:00Z`)));
    b.cameraTook(hexes);
    b.land(PEOPLE, [person("person-b", "Person B"), person("person-c", "Person C")]);
    await b.label();
    expect(b.heads("cluster")[0]!.content).toMatchObject({ suggested: [{ person: "person-b", score: 0.7 }, { person: "person-c", score: 0.55 }] });
    b.land(PEOPLE, hexes.map((hex) => faceStatement(hex, LEFT, { is_not: ["person-b"] })));
    await b.label();
    expect(b.heads("cluster")[0]!.content).toMatchObject({ size: 3, suggested: [{ person: "person-c", score: 0.55 }] });
    const grown = b.photo("declined-d", [{ box: LEFT, tier: "seed", tag: 5 }]);
    b.land(GOOGLE, [googlePhoto(grown, "2025-09-04T10:00:00Z")]);
    b.cameraTook([grown]);
    await b.label();
    expect(b.heads("cluster")[0]!.content).toMatchObject({ size: 4, suggested: [{ person: "person-c", score: 0.55 }] });
    artifact(b.dir, "declined.json", { clusters: b.heads("cluster") });
  });

  it("L43: a face near a named person that nothing took is not a Maybe of them, one under the bar or said not to be them is, or an answered Maybe stays", async () => {
    const b = bench();
    const named = b.photo("maybe-named", [{ box: LEFT, tier: "seed", tag: 6 }]);
    const near = b.photo("maybe-near", [{ box: LEFT, tier: "seed", tag: 6, likeness: 0.5 }]);
    const nearer = b.photo("maybe-nearer", [{ box: LEFT, tier: "assign", tag: 6, likeness: 0.52 }]);
    const declined = b.photo("maybe-declined", [{ box: LEFT, tier: "seed", tag: 6, likeness: 0.55 }]);
    const far = b.photo("maybe-far", [{ box: LEFT, tier: "seed", tag: 6, likeness: 0.3 }]);
    const all = [named, near, nearer, declined, far];
    b.land(GOOGLE, all.map((hex, index) => googlePhoto(hex, `2025-10-0${index + 1}T10:00:00Z`)));
    b.cameraTook(all);
    b.land(PEOPLE, [person("person-a", "Person A"), faceStatement(named, LEFT, { is: "person-a" }), faceStatement(declined, LEFT, { is_not: ["person-a"] })]);
    const run = (await b.label())!;
    expect(run.facts).toMatchObject({ maybe: 1 });
    expect(b.heads("maybe")).toEqual([{
      key: "person-a", version: expect.any(String),
      content: { faces: [{ face: faceKey(nearer, LEFT), score: 0.52, crop: b.crop(nearer) }, { face: faceKey(near, LEFT), score: 0.5, crop: b.crop(near) }] },
    }]);
    for (const hex of [near, nearer, declined, far]) expect(b.who(faceKey(hex, LEFT))).toBe("");
    expect(b.heads("cluster")).toEqual([]);
    b.land(PEOPLE, [faceStatement(nearer, LEFT, { is: "person-a" }), faceStatement(near, LEFT, { is_not: ["person-a"] })]);
    const answered = (await b.label())!;
    expect(answered.lines).toContainEqual({ gone: true, key: "person-a", kind: "maybe" });
    expect(b.heads("maybe")).toEqual([]);
    expect(b.who(faceKey(nearer, LEFT))).toBe("person-a");
    expect(b.who(faceKey(near, LEFT))).toBe("");
    artifact(b.dir, "maybe.json", { first: run.lines.filter((line) => line.kind === "maybe"), answered: answered.lines });
  });

  it("L44: a cluster of another group rule is never grouped again, or a run regroups once it is", async () => {
    const { b } = await flow();
    await b.label();
    const [cluster] = b.heads("cluster");
    const { rule: _rule, ...older } = cluster!.content as JsonObject;
    b.land(FACES, [{ kind: "cluster", key: cluster!.key, content: { ...older, suggested: ["person-b"] } }], "faces", { cluster: () => [] });
    b.passed();
    const calls = b.calls().length;
    const regrouped = (await b.label())!;
    expect(b.calls().slice(calls).map((call) => call.command)).toEqual(["scan", "group"]);
    expect(regrouped.lines.map((line) => [line.kind, line.key])).toEqual([["cluster", cluster!.key]]);
    expect(b.heads("cluster")[0]!.content).toEqual(cluster!.content);
    expect(await b.label()).toBeNull();
    b.passed();
    expect(await b.label()).toBeNull();
    expect(b.calls().slice(calls).filter((call) => call.command === "group")).toHaveLength(1);
    artifact(b.dir, "rule.json", { lines: regrouped.lines });
  });

  it("L45: on battery past the bar, the owner's naming or a rename waits for mains power with the scan, an erased Maybe photo stays a Maybe while it waits, or the scan does not go on once the power is back", async () => {
    const b = bench({ battery_backlog: 2 });
    const group = ["a", "b", "c"].map((name) => b.photo(`held-${name}`, [{ box: LEFT, tier: "seed", tag: 7 }]));
    const near = b.photo("held-near", [{ box: LEFT, tier: "seed", tag: 7, likeness: 0.5 }]);
    b.land(GOOGLE, [...group, near].map((hex, index) => googlePhoto(hex, `2025-05-0${index + 1}T10:00:00Z`)));
    b.cameraTook([...group, near]);
    await b.label();
    expect(b.heads("model-image").map((head) => head.content)).toEqual([0, 1, 2, 3].map(() => modelImage([LEFT, null])));
    b.power.mains = false;
    const owed = ["d", "e", "f"].map((name) => b.photo(`held-${name}`, [{ box: LEFT, tier: "seed", tag: 7 }]));
    b.land(GOOGLE, owed.map((hex, index) => googlePhoto(hex, `2025-06-0${index + 1}T10:00:00Z`)));
    b.cameraTook(owed);
    const scanned = () => b.calls().filter((call) => call.command === "scan" && (call.request.photos as unknown[]).length > 0).length;
    const before = scanned();
    const rests = async () => b.label().then(() => null, (thrown: unknown) => thrown as LabelerUnavailable);
    expect(await rests()).toMatchObject({ reason: "waiting-for-power", output: expect.objectContaining({ facts: expect.objectContaining({ images: 3, scanned: 0, owed: 3 }) }) });
    expect(b.heads("image").map((head) => head.key)).toEqual(expect.arrayContaining(owed));
    b.land(PEOPLE, [person("person-a", "Person A"), faceStatement(group[0]!, LEFT, { is: "person-a" })]);
    expect(await rests()).toMatchObject({ reason: "waiting-for-power", output: expect.objectContaining({ facts: expect.objectContaining({ grouped: true, scanned: 0 }) }) });
    for (const hex of group) {
      expect(b.who(faceKey(hex, LEFT))).toBe("person-a");
      expect(b.content("model-image", hex)).toEqual(modelImage([LEFT, "Person A"]));
    }
    expect(b.content<{ faces: { face: string }[] }>("maybe", "person-a")!.faces.map((face) => face.face)).toEqual([faceKey(near, LEFT)]);
    b.home.db.commit((tx) => tx.records.erase({
      records: [{ source: GOOGLE, kind: "img", key: near }, ...["image", "scan", "model-image"].map((kind) => ({ source: FACES, kind, key: near }))],
      units: [{ family: "photos", unit: `unknown/${Date.parse("2025-05-04T10:00:00Z")}/${near}` }],
      reason: "a synthetic erasure", at_ms: T0,
    }));
    const erased = await rests();
    expect(erased).toMatchObject({ reason: "waiting-for-power", output: expect.objectContaining({ facts: expect.objectContaining({ grouped: false, scanned: 0 }) }) });
    expect(b.heads("maybe")).toEqual([]);
    expect(group.every((hex) => b.who(faceKey(hex, LEFT)) === "person-a")).toBe(true);
    const groups = b.calls().filter((call) => call.command === "group").length;
    b.land(PEOPLE, [person("person-a", "Person Alpha")]);
    await rests();
    for (const hex of group) expect(b.content("model-image", hex)).toEqual(modelImage([LEFT, "Person Alpha", "person-a"]));
    expect(b.calls().filter((call) => call.command === "group")).toHaveLength(groups);
    expect(scanned()).toBe(before);
    b.power.mains = true;
    const resumed = (await b.label())!;
    expect(resumed.facts).toMatchObject({ scanned: 3, owed: 0 });
    expect(owed.every((hex) => b.who(faceKey(hex, LEFT)) === "person-a")).toBe(true);
    artifact(b.dir, "power-held.json", { model_images: b.heads("model-image"), resumed: resumed.facts });
  });
  it("L46: a value the memo kept for another version of the labeler's code is used", async () => {
    const { b, p1 } = await flow();
    await b.label();
    const view = b.home.db.view();
    const version = view.head({ source: FACES, kind: "named", key: "person-a" })!.version;
    view.close();
    const older = b.settings.memo("an older faces labeler");
    older.values("named", [version], () => ({ photos: [{ face: faceKey(p1, RIGHT), at_ms: null, camera: true, crop: null, tier: "observe", size: 1 }], labels: [] }));
    older.close();
    b.land(PEOPLE, [person("person-a", "Person A Renamed")]);
    await b.label();
    expect(b.ownVersions()).toContain(version);
    expect(b.content<JsonObject>("model-image", p1)).toEqual(modelImage([LEFT, "Person A Renamed", "person-a"], [RIGHT, null]));
    expect(b.content<Named>("named", "person-a")!.photos.map((photo) => photo.face)).not.toContain(faceKey(p1, RIGHT));
    b.land(PEOPLE, [person("person-a", "Person A")]);
    await b.label();
    expect(b.ownVersions()).not.toContain(version);
    artifact(b.dir, "memo-version.json", { named: b.heads("named") });
  });

  it("L47: a run that reads its records reads a version of its own or a face statement it read before, or one not stated since its last run", async () => {
    const { b, p4 } = await flow();
    await b.label();
    const read = new Set(b.ownVersions());
    expect(read.size).toBe(1);
    const before = b.ownHeads();
    b.land(PEOPLE, [person("person-b", "Person B"), faceStatement(p4, LEFT, { is: "person-b" })]);
    expect((await b.label())!.facts).toMatchObject({ grouped: true });
    const second = b.ownVersions();
    expect(second.length).toBeGreaterThan(1);
    expect(second.filter((version) => read.has(version))).toEqual([]);
    expect(new Set(second).size).toBe(second.length);
    for (const version of second) read.add(version);
    const stated = new Set([...b.ownHeads()].filter((version) => !before.has(version)));
    b.land(PEOPLE, [person("person-b", "Person B Renamed")]);
    expect((await b.label())!.facts).toMatchObject({ grouped: false });
    const third = b.ownVersions();
    expect(third.length).toBeGreaterThan(0);
    expect(third.filter((version) => read.has(version) || !stated.has(version))).toEqual([]);
    artifact(b.dir, "reads.json", { second: second.length, third: third.length });
  });

  it("L49: a run whose delivery never landed leaves its group unowed, the run after a group landed groups again, or a repair of its own records is never stated again", async () => {
    const { b, p4 } = await flow();
    await b.label();
    const calls = b.calls().length;
    b.land(PEOPLE, [person("person-b", "Person B"), faceStatement(p4, LEFT, { is: "person-b" })]);
    expect(await b.label({ lost: true })).toBeNull();
    const again = (await b.label())!;
    expect(again.facts).toMatchObject({ grouped: true });
    expect(b.who(faceKey(p4, LEFT))).toBe("person-b");
    expect(await b.label()).toBeNull();
    b.passed();
    expect(await b.label()).toBeNull();
    expect(b.calls().slice(calls).filter((call) => call.command === "group")).toHaveLength(2);
    const named = b.content<Named>("named", "person-b");
    const run = b.home.db.commit((tx) => tx.tables.runs.start({ kind: "repair", subject: FACES, started_ms: T0 }));
    const view = b.home.db.view();
    const plan = view.planRepair({ source: FACES, kinds: ["named"], run, fix: (head) => (head.key === "person-b" ? "gone" : "keep") });
    view.close();
    expect(plan.next).toBeNull();
    b.home.db.commit((tx) => tx.records.applyRepair(run, plan, { has: () => true }));
    expect(b.content("named", "person-b")).toBeUndefined();
    const restated = (await b.label())!;
    expect(keysOf(restated, "named")).toEqual(["person-b"]);
    expect(b.content<Named>("named", "person-b")).toEqual(named);
    expect(await b.label()).toBeNull();
    artifact(b.dir, "lost.json", { lines: again.lines.map((line) => [line.kind, line.key]), restated: restated.lines.map((line) => [line.kind, line.key]) });
  });

  it("L50: one picture outside the record names a face the named faces would not, misses a merge, reads another pipeline's vectors, groups the library, or moves the labeler's own", async () => {
    const b = bench();
    const MIDDLE: Box = [800, 100, 1000, 300];
    const LOW: Box = [100, 500, 300, 700];
    const named = b.photo("named-a", [{ box: LEFT, tier: "seed", tag: 1 }, { box: RIGHT, tier: "seed", tag: 5 }]);
    const merged = b.photo("named-b", [{ box: LEFT, tier: "seed", tag: 2 }]);
    const other = b.photo("unnamed", [{ box: LEFT, tier: "seed", tag: 6 }]);
    b.land(GOOGLE, [googlePhoto(named, "2025-01-01T10:00:00Z"), googlePhoto(merged, "2025-01-02T10:00:00Z"), googlePhoto(other, "2025-01-03T10:00:00Z")]);
    b.land(PEOPLE, [person("person-a", "Person A"), person("person-b", "Person B", "person-c"), person("person-c", "Person C"),
      faceStatement(named, LEFT, { is: "person-a" }), faceStatement(merged, LEFT, { is: "person-b" }), faceStatement(other, LEFT, { is_not: ["person-a"] })]);
    await b.label();
    expect(await b.label()).toBeNull();
    const heads = b.home.heads(FACES);
    const read = () => {
      const view = b.home.db.view();
      try {
        return faceAnchors(view, UNIT);
      } finally {
        view.close();
      }
    };
    const anchors = read();
    expect(anchors).toEqual({
      photos: [
        { key: named, pipeline: expect.any(String), vectors: b.content<{ vectors: string }>("scan", named)!.vectors, faces: [LEFT, RIGHT], named: [{ box: LEFT, is: "person-a" }] },
        { key: merged, pipeline: expect.any(String), vectors: b.content<{ vectors: string }>("scan", merged)!.vectors, faces: [LEFT], named: [{ box: LEFT, is: "person-b" }] },
      ].sort((left, right) => (left.key < right.key ? -1 : 1)),
      merged: { "person-b": "person-c" },
    });

    const staged = join(b.dir, "stage", "chat-photo.jpg");
    mkdirSync(dirname(staged), { recursive: true });
    const bytes = Buffer.from("synthetic chat photo");
    writeFileSync(staged, bytes);
    const OBSERVED: Box = [1100, 100, 1300, 300];
    b.config.faces![sha256(bytes)] = [
      { box: LEFT, tier: "seed", tag: 1 }, { box: RIGHT, tier: "seed", tag: 5 }, { box: MIDDLE, tier: "assign", tag: 2 },
      { box: OBSERVED, tier: "observe", tag: 1 }, { box: LOW, tier: "seed", tag: 1, likeness: 0.3 },
    ];
    b.configure();
    const calls = b.calls().length;
    const match = await b.labeler.matchOne(staged, anchors);
    expect(match).toEqual({
      pipeline: anchors.photos[0]!.pipeline, status: "ok", width: 4000, height: 3000,
      faces: [
        { box: LEFT, who: "person:person-a" }, { box: RIGHT, who: null }, { box: MIDDLE, who: "person:person-c" },
        { box: OBSERVED, who: null }, { box: LOW, who: null },
      ],
    });
    const asked = b.calls().slice(calls);
    expect(asked.map((call) => call.command)).toEqual(["scan", "group"]);
    const group = asked[1]!.request as { photos: { key: string; faces: { box: Box; tier: string }[] }[]; statements: JsonObject[]; people: JsonObject };
    expect(group.photos.map((photo) => photo.key)).toEqual([named, merged, "asked"].sort());
    expect(group.photos.filter((photo) => photo.key !== "asked").flatMap((photo) => photo.faces.map((face) => face.tier))).toEqual(["observe", "observe", "observe"]);
    expect(group.photos.find((photo) => photo.key === "asked")!.faces.map((face) => face.tier)).toEqual(["assign", "assign", "assign", "observe", "assign"]);
    expect(group.statements).toEqual(expect.arrayContaining([{ photo: named, box: LEFT, is: "person-a" }, { photo: merged, box: LEFT, is: "person-b" }]));
    expect(group.statements).toHaveLength(2);
    expect(group.people).toEqual({ "person-b": "person-c" });
    expect(b.home.heads(FACES)).toEqual(heads);
    expect(await b.label()).toBeNull();
    b.passed();
    expect(await b.label()).toBeNull();
    expect(readdirSync(b.settings.work).filter((name) => name.startsWith("match-"))).toEqual([]);

    const plain = join(b.dir, "stage", "plain.jpg");
    writeFileSync(plain, "synthetic plain chat photo");
    const broken = join(b.dir, "stage", "broken.jpg");
    writeFileSync(broken, "not an image, synthetic");
    const before = b.calls().length;
    expect(await b.labeler.matchOne(plain, anchors)).toEqual({ pipeline: anchors.photos[0]!.pipeline, status: "ok", width: 4000, height: 3000, faces: [] });
    expect(await b.labeler.matchOne(broken, anchors)).toEqual({ pipeline: anchors.photos[0]!.pipeline, status: "unreadable", width: null, height: null, faces: [] });
    b.config.pipeline = { ...PIPELINE, version: 2 };
    b.configure();
    const moved = await b.labeler.matchOne(staged, anchors);
    expect(moved.faces.map((face) => face.who)).toEqual([null, null, null, null, null]);
    expect(b.calls().slice(before).map((call) => call.command)).toEqual(["scan", "scan", "scan"]);
    artifact(b.dir, "match-one.json", { anchors, match, group } as unknown as Json);
  });

  it("L50: one picture is placed with the face models missing", async () => {
    const b = bench({ models: false });
    await expect(b.labeler.matchOne(join(b.dir, "absent.jpg"), { photos: [], merged: {} })).rejects.toMatchObject({ reason: "not-installed" });
    expect(b.calls()).toEqual([]);
  });
});
