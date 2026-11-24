import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const JPEG_START = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const BARS = { assign: 0.56, edge: 0.64, margin: 0.08, maybe: 0.48 };
const rounded = (value) => Math.round(value * 10000) / 10000;

const PORTRAIT_SIZE = 96;
const PORTRAIT_MASK = new Uint8Array(PORTRAIT_SIZE * PORTRAIT_SIZE);
for (let y = 0; y < PORTRAIT_SIZE; y++) {
  for (let x = 0; x < PORTRAIT_SIZE; x++) {
    const face = ((x - 48) / 26) ** 2 + ((y - 50) / 33) ** 2 <= 1;
    const eye = ((x - 38) ** 2 + (y - 44) ** 2 <= 9) || ((x - 58) ** 2 + (y - 44) ** 2 <= 9);
    const mouth = y >= 64 && y <= 66 && x >= 40 && x <= 56;
    PORTRAIT_MASK[y * PORTRAIT_SIZE + x] = face && (eye || mouth) ? 2 : face ? 1 : 0;
  }
}
const pngChunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PORTRAIT_HEADER = (() => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(PORTRAIT_SIZE, 0);
  header.writeUInt32BE(PORTRAIT_SIZE, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return pngChunk("IHDR", header);
})();
const PNG_IEND = pngChunk("IEND", Buffer.alloc(0));

function portrait(tag, seed) {
  const shade = parseInt(sha(seed).slice(0, 2), 16) / 255;
  const hue = (Number(tag) * 67) % 360;
  const rgb = (h, s, l) => {
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return [0, 8, 4].map((n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1)))));
  };
  const ground = rgb(hue, 0.35, 0.22 + 0.08 * shade), skin = rgb(hue, 0.3, 0.62 + 0.08 * shade), dark = rgb(hue, 0.4, 0.18);
  const raw = Buffer.allocUnsafe(PORTRAIT_SIZE * (1 + PORTRAIT_SIZE * 3));
  let at = 0;
  let maskAt = 0;
  for (let y = 0; y < PORTRAIT_SIZE; y++) {
    raw[at++] = 0;
    for (let x = 0; x < PORTRAIT_SIZE; x++) {
      const kind = PORTRAIT_MASK[maskAt++];
      const color = kind === 2 ? dark : kind === 1 ? skin : ground;
      raw[at++] = color[0];
      raw[at++] = color[1];
      raw[at++] = color[2];
    }
  }
  return Buffer.concat([PNG_SIG, PORTRAIT_HEADER, pngChunk("IDAT", deflateSync(raw)), PNG_IEND]);
}

class FakeExit extends Error {
  /** @param {number} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {string} dir
 * @param {string} command
 * @param {string} requestPath
 * @param {string} resultPath
 * @returns {{ code: number, signal: null, timedOut: boolean, stderr: string }}
 */
export function runFakeEngine(dir, command, requestPath, resultPath) {
  const config = JSON.parse(readFileSync(join(dir, "engine.json"), "utf8"));
  const request = JSON.parse(readFileSync(requestPath, "utf8"));
  appendFileSync(join(dir, "calls.log"), `${command} ${JSON.stringify(request)}\n`);
  const write = (result) => writeFileSync(resultPath, `${JSON.stringify(result)}\n`);
  const fail = (status, message) => {
    throw new FakeExit(status, `face-engine: ${message}\n`);
  };
  const photo = (path) => {
    try {
      return readFileSync(path);
    } catch {
      return fail(1, `cannot read ${path}`);
    }
  };

  function scan() {
    if (request.photos.length === 0) return write({ pipeline: config.pipeline, photos: [] });
    mkdirSync(request.output, { recursive: true });
    const photos = request.photos.map(({ key, path }) => {
      const bytes = photo(path);
      if (bytes.toString("latin1").startsWith("not an image")) return { key, status: "unreadable", reason: "not an image ImageIO can read" };
      const found = config.faces?.[sha(bytes)] ?? [];
      const faces = found.map((face, index) => {
        const [x1, y1, x2, y2] = face.box;
        const size = Math.round(Math.min(x2 - x1, y2 - y1) * 100) / 100;
        const crop = face.tier === "observe" ? undefined : `${key}-${index}.jpg`;
        if (crop !== undefined) writeFileSync(join(request.output, crop), portrait(face.tag, `${key}:${index}`));
        return {
          box: face.box, landmarks: [[x1, y1], [x2, y1], [(x1 + x2) / 2, (y1 + y2) / 2], [x1, y2], [x2, y2]],
          score: 0.9, size, tier: face.tier, ...(crop === undefined ? {} : { crop }),
        };
      });
      if (faces.length > 0) {
        const vectors = new Float32Array(512 * faces.length);
        found.forEach((face, index) => {
          vectors[index * 512] = face.tag;
          vectors[index * 512 + 1] = face.typical ?? 0.95;
          vectors[index * 512 + 2] = face.likeness ?? 0.95;
        });
        writeFileSync(join(request.output, `${key}.f32`), Buffer.from(vectors.buffer));
      }
      return { key, status: "ok", width: 4000, height: 3000, faces, ...(faces.length === 0 ? {} : { vectors: `${key}.f32` }) };
    });
    write({ pipeline: config.pipeline, photos });
  }

  function group() {
    const faces = [];
    for (const entry of request.photos) {
      let vectors = [];
      if (entry.faces.length > 0) {
        let bytes;
        try {
          bytes = readFileSync(entry.vectors);
        } catch {
          fail(1, `cannot read ${entry.vectors}`);
        }
        if (bytes.length !== entry.faces.length * 2048) fail(2, `${entry.vectors} holds ${bytes.length} bytes, not ${entry.faces.length} vectors`);
        vectors = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
      }
      entry.faces.forEach((face, index) => faces.push({
        photo: entry.key, box: face.box, tier: face.tier, key: `${entry.key}:${face.box.map((value) => Math.round(value)).join(",")}`,
        tag: vectors[index * 512], typical: rounded(vectors[index * 512 + 1]), likeness: rounded(vectors[index * 512 + 2]), person: "", cluster: "", maybe: undefined,
        not: new Set(), ignored: false,
      }));
    }
    const follow = (slug) => {
      const seen = new Set([slug]);
      let current = slug;
      while (request.people[current] !== undefined && request.people[current] !== current) {
        current = request.people[current];
        if (seen.has(current)) fail(2, `unreadable request: people merge into each other: ${slug}`);
        seen.add(current);
      }
      return current;
    };
    const unmatched = [];
    for (const statement of request.statements) {
      const iou = (a, b) => {
        const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
        return (w * h) / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - w * h);
      };
      const face = faces.filter((each) => each.photo === statement.photo).find((each) => iou(each.box, statement.box) >= 0.5);
      if (face === undefined) {
        unmatched.push({ photo: statement.photo, box: statement.box });
        continue;
      }
      if (statement.is !== undefined) face.person = follow(statement.is);
      if (statement.is_not !== undefined) face.not = new Set(statement.is_not.map(follow));
      if (statement.ignore === true) face.ignored = true;
    }
    const anchors = new Map(faces.filter((face) => face.person !== "").map((face) => [face.tag, face.person]));
    const open = faces.filter((face) => face.person === "" && !face.ignored && face.tier !== "observe");
    for (const face of open) {
      const person = anchors.get(face.tag);
      if (person !== undefined && !face.not.has(person) && face.likeness >= BARS.assign) face.person = person;
    }
    const byTag = new Map();
    for (const face of open.filter((each) => each.person === "" && each.likeness >= BARS.assign)) byTag.set(face.tag, [...(byTag.get(face.tag) ?? []), face]);
    const clusters = [];
    for (const [tag, members] of byTag) {
      const seeds = members.filter((face) => face.tier === "seed");
      if (seeds.length < 3) continue;
      const id = sha(seeds.map((face) => face.key).sort()[0]).slice(0, 16);
      for (const face of members) face.cluster = id;
      const declined = new Set(members.flatMap((face) => [...face.not]));
      clusters.push({ id, size: members.length, suggested: (config.suggested?.[tag] ?? []).filter((each) => !declined.has(each.person)).slice(0, 3) });
    }
    clusters.sort((a, b) => b.size - a.size || (a.id < b.id ? -1 : 1));
    for (const face of open) {
      const person = anchors.get(face.tag);
      if (face.person !== "" || face.cluster !== "" || person === undefined || face.not.has(person) || face.likeness < BARS.maybe) continue;
      face.maybe = { person, score: face.likeness };
    }
    const photos = request.photos.map((entry) => entry.key).sort().map((key) => ({
      key,
      faces: faces.filter((face) => face.photo === key).map((face) => ({
        face: face.key, person: face.person, cluster: face.cluster, ...(face.cluster === "" ? {} : { typical: face.typical }), ...(face.maybe === undefined ? {} : { maybe: face.maybe }),
      })),
    }));
    write({ bars: BARS, photos, clusters, unmatched });
  }

  function draw() {
    write({
      images: request.images.map((image) => {
        const bytes = photo(image.path);
        if (bytes.toString("latin1").startsWith("not an image")) return { status: "unreadable", reason: "not an image ImageIO can read" };
        writeFileSync(image.output, `drawn ${sha(bytes)} ${JSON.stringify(image.faces)}`);
        return { status: "ok", width: 1536, height: 1152 };
      }),
    });
  }

  function read() {
    write({
      reader: config.reader ?? "fake read 1",
      pictures: request.pictures.map((picture) => {
        const bytes = photo(picture.path);
        if (bytes.toString("latin1").startsWith("not an image")) return { status: "unreadable", reason: "not an image ImageIO can read" };
        const found = config.found?.[sha(bytes)] ?? {};
        return { status: "ok", width: 1400, height: 900, lines: found.lines ?? [], faces: found.faces ?? [] };
      }),
    });
  }

  function make() {
    write({
      engine: config.engine ?? "fake make 1",
      pictures: request.pictures.map((picture) => {
        const bytes = photo(picture.path);
        if (bytes.toString("latin1").startsWith("not an image")) return { status: "unreadable", reason: "not an image ImageIO can read" };
        writeFileSync(picture.output, Buffer.concat([JPEG_START, Buffer.from(`made ${sha(bytes)} ${JSON.stringify({ filled: picture.filled, covered: picture.covered, written: picture.written })}`)]));
        return { status: "ok", width: 1400, height: 900, covered: picture.covered.map((face) => face.colour ?? "#808080") };
      }),
    });
  }

  try {
    if (config.fail?.[command] !== undefined) fail(config.fail[command], config.fail[command] === 2 ? "unreadable request: a fake refusal" : "a fake failure");
    else if (command === "scan") scan();
    else if (command === "group") group();
    else if (command === "draw") draw();
    else if (command === "read") read();
    else if (command === "make") make();
    else if (command === "self-check") write({ ok: config.selfCheck !== false, runtimes: [{ runtime: "gpu", ok: config.selfCheck !== false }, { runtime: "cpu", ok: true }] });
    else fail(2, `usage: no command ${command}`);
    return { code: 0, signal: null, timedOut: false, stderr: "" };
  } catch (error) {
    if (error instanceof FakeExit) return { code: error.code, signal: null, timedOut: false, stderr: error.message };
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.env.FAKE_ENGINE_DIR;
  const config = JSON.parse(readFileSync(join(dir, "engine.json"), "utf8"));
  const [command, requestPath, resultPath] = process.argv.slice(2);
  if (config.hang === command) {
    const request = JSON.parse(readFileSync(requestPath, "utf8"));
    appendFileSync(join(dir, "calls.log"), `${command} ${JSON.stringify(request)}\n`);
    setInterval(() => {}, 1000);
  } else {
    const ran = runFakeEngine(dir, command, requestPath, resultPath);
    if (ran.stderr) process.stderr.write(ran.stderr);
    if (ran.code !== 0) process.exit(ran.code);
  }
}
