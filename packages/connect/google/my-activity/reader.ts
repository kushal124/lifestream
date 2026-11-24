import { archive, consuming, each, fingerprint, forThisAccount, instantOf, isObject, jsonElements, readJson, refuse, rfc3339, stored, utf8, type Guard, type Json, type JsonObject, type Member, type Reader, type ReaderOutput, type Streamed } from "@lifestreamprotocol/connect/sdk";
import { cells, HTML_TIME, htmlEntry } from "./html.js";

export const FOLDERS: Readonly<Record<string, readonly string[]>> = {
  "google-search": ["AI Mode", "Google Lens", "Image Search", "Search", "Video Search"],
  youtube: ["YouTube"],
  "google-maps": ["Maps"],
  chrome: ["Chrome"],
  gemini: ["Gemini Apps"],
  android: ["Android"],
  "gmail-activity": ["Gmail"],
  "google-ads": ["Ads"],
  "google-analytics": ["Google Analytics"],
  "google-arts-culture": ["Google Arts & Culture"],
  "google-assistant": ["Assistant"],
  "google-books": ["Books"],
  "google-business-profile": ["Google Business Profile"],
  "google-developers": ["Developers"],
  "google-discover": ["Discover"],
  "google-drive": ["Drive"],
  "google-flights": ["Flights"],
  "google-help": ["Help"],
  "google-hotels": ["Hotels"],
  "google-news": ["Google News", "News"],
  "google-play": ["Google Play Store"],
  "google-play-games": ["Google Play Games"],
  "google-play-movies": ["Google Play Movies & TV"],
  "google-shopping": ["Shopping"],
  "google-store": ["Google Store"],
  "google-takeout": ["Takeout"],
  "google-translate": ["Google Translate"],
  "google-travel": ["Travel"],
  "google-tv": ["Google TV"],
  "google-voice-match": ["Voice Match"],
};

export const VERBS: Readonly<Record<string, { kind: string; products?: readonly string[] }>> = {
  Searched: { kind: "search" },
  Visited: { kind: "page-visit" },
  Watched: { kind: "watch" },
  Directions: { kind: "directions" },
  Viewed: { kind: "place-view", products: ["google-maps"] },
  Prompted: { kind: "msg", products: ["gemini"] },
  Subscribed: { kind: "follow", products: ["youtube"] },
  Liked: { kind: "like", products: ["youtube"] },
};

export const ACTIVITY = "activity";
export const CONTENT_TYPE = "google.activity";

const ACTIVITY_FILE = "MyActivity.json";
const HTML_FILE = "MyActivity.html";
const ROOT = "Takeout/My Activity";
const MEMBER = /(?:^|\/)Takeout\/My Activity\/([^/]+)\/([^/]+)$/u;
const SOURCE = /^([a-z0-9-]+):([^:]+):export$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const BLOB = /^sha256:[0-9a-f]{64}$/u;
const ADDED = ["type", "blobs"];

const MEDIA: Readonly<Record<string, string>> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", mp4: "video/mp4", pdf: "application/pdf",
};


const STRINGS = ["titleUrl", "description", "imageFile"];
const STRING_LISTS = ["activityControls", "attachedFiles", "audioFiles"];
const OBJECT_LISTS = ["subtitles", "details", "locationInfos", "safeHtmlItem"];

const entry: Guard = (content) => {
  if (!isObject(content)) return ["content must be an object"];
  const out: string[] = [];
  if (content.type !== CONTENT_TYPE) out.push(`type must be ${CONTENT_TYPE}`);
  const html = content.stated !== undefined;
  if (typeof content.time !== "string" || !UTC.test(content.time)) out.push("time must be an RFC 3339 UTC instant ending in Z");
  if (html && (typeof content.stated !== "string" || !HTML_TIME.test(content.stated))) out.push("stated must be the HTML page's local time");
  for (const member of ["header", "title"]) if (typeof content[member] !== "string") out.push(`${member} must be a string`);
  for (const member of STRINGS) if (content[member] !== undefined && typeof content[member] !== "string") out.push(`${member} must be a string`);
  if ((!html || content.products !== undefined) && (!Array.isArray(content.products) || content.products.length === 0 || content.products.some((item) => typeof item !== "string"))) {
    out.push("products must list at least one product, as strings");
  }
  for (const member of STRING_LISTS) {
    const value = content[member];
    if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== "string"))) out.push(`${member} must be a list of strings`);
  }
  for (const member of OBJECT_LISTS) {
    const value = content[member];
    if (value !== undefined && (!Array.isArray(value) || value.some((item) => !isObject(item) || Object.values(item).some((field) => typeof field !== "string")))) {
      out.push(`${member} must be a list of objects of strings`);
    }
  }
  if (content.blobs !== undefined) {
    if (!Array.isArray(content.blobs) || content.blobs.length === 0) out.push("blobs, when stated, must list at least one file");
    else {
      for (const blob of content.blobs) {
        if (!isObject(blob) || Object.keys(blob).sort().join(",") !== "bytes,file,hash,media_type,role" || typeof blob.hash !== "string" || !BLOB.test(blob.hash) ||
          !Number.isSafeInteger(blob.bytes) || (blob.bytes as number) < 0 || typeof blob.media_type !== "string" || blob.role !== "attachment" ||
          typeof blob.file !== "string" || blob.file === "") {
          out.push("a blob is exactly { hash, bytes, media_type, role: attachment, file }");
        }
      }
    }
  }
  return out;
};


export const myActivity: Reader = {
  name: "google-my-activity",
  kinds: Object.fromEntries([...new Set([...Object.values(VERBS).map((verb) => verb.kind), ACTIVITY])].map((kind) => [kind, entry])),
  async *read(delivery, files) {
    const product = productOf(delivery.source);
    const folders = FOLDERS[product];
    if (folders === undefined || !forThisAccount(delivery)) return;
    let read: Member[] = [];
    yield* consuming(delivery, archive(delivery, files, async function* (members) {
      const found = foldersOf(members, new Set(folders));
      read = [...found.values()].flatMap((folder) => [...folder.members.values()]);
      yield* each([...found].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)), ([folder]) => `${ROOT}/${folder}`, ([folder, { members, twice }]) => {
        if (twice !== undefined) refuse(twice);
        const json = members.get(ACTIVITY_FILE);
        if (json !== undefined) {
          const attachments = new Attachments(members);
          return each([json], (file) => file.where, (file) => each(jsonElements(file.chunks(), file.where), (element) => element.where, async ({ read, where }) => [await entryRow(product, read(), where, attachments)]));
        }
        const html = members.get(HTML_FILE) ?? refuse(`${folder} holds no ${ACTIVITY_FILE} or ${HTML_FILE}`);
        const zone = zoneOf(delivery.facts.zone, html.where);
        return each([html], (file) => file.where, (file) => each(cells(file.chunks(), file.where), (cell) => cell.where, ({ html: text, where }) => [htmlRow(product, text, where, zone)]));
      }, { group: true });
    }), () => read);
  },
};

function productOf(source: string): string {
  const match = SOURCE.exec(source);
  if (match === null) refuse(`${source} is not a <product>:<account>:export source`);
  return match[1]!;
}

function foldersOf(members: readonly Member[], folders: ReadonlySet<string>): Map<string, { members: Map<string, Member>; twice?: string }> {
  const found = new Map<string, { members: Map<string, Member>; twice?: string }>();
  for (const member of members) {
    const match = MEMBER.exec(member.name);
    if (match === null || !folders.has(match[1]!)) continue;
    const [, folder, name] = match as unknown as [string, string, string];
    let held = found.get(folder);
    if (held === undefined) found.set(folder, (held = { members: new Map() }));
    const other = held.members.get(name);
    if (other !== undefined) held.twice ??= `the delivery holds ${folder}/${name} twice: ${other.where} and ${member.where}`;
    else held.members.set(name, member);
  }
  return found;
}

function zoneOf(stated: unknown, where: string): string {
  if (typeof stated !== "string" || stated === "") refuse(`${where}: the delivery states no zone to read its local times in`);
  try {
    new Intl.DateTimeFormat("en", { timeZone: stated });
  } catch {
    refuse(`${where}: ${JSON.stringify(stated)} is no zone this runtime knows`);
  }
  return stated;
}

function htmlRow(product: string, cell: string, locator: string, zone: string): ReaderOutput {
  const { entry, time } = htmlEntry(cell, locator, zone);
  const { header, title, titleUrl } = entry as { header: string; title: string; titleUrl?: string };
  return { kind: kindOf(product, title), key: entryKey(time.start_ms, header, title, titleUrl), content: { type: CONTENT_TYPE, ...entry }, time, locator };
}

async function entryRow(product: string, element: Buffer, locator: string, attachments: Attachments): Promise<ReaderOutput> {
  const value = readJson(utf8(element, locator), locator);
  if (!isObject(value)) refuse(`${locator} is not a JSON object`);
  for (const member of ADDED) if (Object.hasOwn(value, member)) refuse(`${locator} states a ${member} member, which this connector does not read`);
  const time = text(value, "time", locator);
  const header = text(value, "header", locator);
  const title = text(value, "title", locator);
  const titleUrl = value.titleUrl;
  if (titleUrl !== undefined && typeof titleUrl !== "string") refuse(`${locator} titleUrl must be a string`);
  if (!UTC.test(time)) refuse(`${locator} time ${JSON.stringify(time)} is not an RFC 3339 UTC instant`);
  const at = instantOf(time, "rfc3339", locator);
  const linked = await attachments.of(value);
  const content: JsonObject = { type: CONTENT_TYPE, ...value, ...(linked.length === 0 ? {} : { blobs: linked.map((blob) => blob.listed) }) };
  const streamed = linked.flatMap((blob) => (blob.streamed === undefined ? [] : [blob.streamed]));
  return {
    kind: kindOf(product, title),
    key: entryKey(at.start_ms, header, title, titleUrl),
    content,
    time: at,
    ...(linked.length === 0 ? {} : { blobs: linked.map((blob) => blob.listed.hash as string), media: Object.fromEntries(linked.map((blob) => [blob.listed.hash, blob.listed.media_type])) }),
    ...(streamed.length === 0 ? {} : { streamed }),
    locator,
  };
}

export function kindOf(product: string, title: string): string {
  const verb = VERBS[title.split(" ", 1)[0]!];
  return verb === undefined || (verb.products !== undefined && !verb.products.includes(product)) ? ACTIVITY : verb.kind;
}

export function entryKey(at_ms: number, header: string, title: string, titleUrl: string | undefined): string {
  return fingerprint({ time: rfc3339(at_ms, "s"), header, title, ...(titleUrl === undefined ? {} : { titleUrl }) });
}

class Attachments {
  readonly #members: ReadonlyMap<string, Member>;
  #stems: Map<string, [string, Member][]> | undefined;

  constructor(members: ReadonlyMap<string, Member>) {
    this.#members = members;
  }

  async of(value: JsonObject): Promise<{ listed: JsonObject; streamed?: Streamed }[]> {
    const named = [...strings(value.attachedFiles), ...strings(value.imageFile), ...strings(value.audioFiles)];
    const seen = new Set<string>();
    const out: { listed: JsonObject; streamed?: Streamed }[] = [];
    for (const name of named) {
      const found = this.#find(name);
      if (found === undefined) continue;
      const [file, member] = found;
      if (seen.has(file)) continue;
      seen.add(file);
      const media_type = MEDIA[extension(file)] ?? "application/octet-stream";
      const held = await stored(member);
      out.push({ listed: { hash: held.hash, bytes: held.size, media_type, role: "attachment", file }, ...(held.streamed === undefined ? {} : { streamed: held.streamed }) });
    }
    return out;
  }

  #find(name: string): [string, Member] | undefined {
    if (name === ACTIVITY_FILE) return undefined;
    const exact = this.#members.get(name);
    if (exact !== undefined) return [name, exact];
    this.#stems ??= this.#index();
    const same = this.#stems.get(stem(name));
    return same?.length === 1 ? same[0] : undefined;
  }

  #index(): Map<string, [string, Member][]> {
    const stems = new Map<string, [string, Member][]>();
    for (const [name, member] of this.#members) {
      if (name === ACTIVITY_FILE || extension(name) === "") continue;
      const list = stems.get(stem(name));
      if (list === undefined) stems.set(stem(name), [[name, member]]);
      else list.push([name, member]);
    }
    return stems;
  }
}

function stem(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

function strings(value: Json | undefined): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function text(value: JsonObject, member: string, locator: string): string {
  const stated = value[member];
  if (typeof stated !== "string") refuse(`${locator} states no ${member}`);
  return stated;
}
