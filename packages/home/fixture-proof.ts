import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { backfillFaults, statedAt, type Connector, type Reader } from "@lifestreamprotocol/connect";
import { openHomeFolder, REST, type Delivery, type HomeDb, type ReaderOutput } from "@lifestreamprotocol/core";
import { checkoutLanding, landDelivery, written, type Delivered, type Fixture } from "./fixture-day.js";
import { errorText } from "./jobs.js";
import type { Loaded } from "./registry.js";
import type { Settings } from "./settings.js";

export const FILES_RULE = "a fixture states each file it writes in `files`, and no other";
export const SHAPE_RULE = 'a fixture states each file "trust" (spoiled, it refuses the rest of the delivery) or { alone, prefix?, cut? } (spoiled, it costs the heads it alone holds), and its heads as a list, each head `<kind> <key>`';
export const STATES_RULE = "a fixture states what its delivery lands, in `heads` or in the heads its files alone hold";
export const WHOLE_RULE = "a fixture's whole delivery imports, refusing nothing and landing every head it states";
export const READS_AGAIN_RULE = "a reader that reads an interrupted delivery again from its first row reads the same rows, and takes from `view` only the records this delivery does not state";
export const STATED_RULE = "a fixture's facts give its delivery the statement time the home stamps it with, which the read-again and timing proofs read it at";
export const TIMED_RULE = "an item is timed by when it happened, never when it arrived";
export const SPOILED_RULES = {
  imports: "a spoiled file fails no import: its reader refuses what it cannot read and lands the rest",
  costs: "a spoiled file costs the heads its entry in `files` states and no other: `alone` lost, `prefix` kept from half the file, `cut` landed from it",
  trust: "a trust file spoiled refuses the rest of its delivery, once",
  named: "a spoiled file is refused under its own path, and refuses nothing else",
  silent: "a head a spoiled file costs is refused, never lost in silence",
} as const;

const NO_FILE = Buffer.from("these bytes are no file at all\n");
const CARRIED = "blobs";
const HEAD = /^\S+ \S/u;

type Spoiled = "trust" | { readonly alone: readonly string[]; readonly prefix?: readonly string[]; readonly cut?: readonly string[] };

interface Stated {
  readonly files: Readonly<Record<string, Spoiled>>;
  readonly heads: readonly string[];
}

interface Imported {
  readonly state: string;
  readonly error: string | null;
  readonly heads: string[];
  readonly refusals: { kind: string; key: string; why: string }[];
  readonly first?: Read;
  readonly again?: string | null;
}

interface Proof {
  readonly work: string;
  readonly registry: Loaded;
  readonly settings: Settings;
}

export interface FixtureProofs {
  readonly faults: string[];
  readonly lines: string[];
}

export async function fixtureProofs(options: {
  readonly work: string;
  readonly registry: Loaded;
  readonly settings: Settings;
  readonly connectors: readonly Connector[];
  readonly fixtures: Readonly<Record<string, Fixture>>;
}): Promise<FixtureProofs> {
  const { work, registry, settings, connectors, fixtures } = options;
  const proof: Proof = { work, registry, settings };
  const faults: string[] = [];
  const lines: string[] = [];
  const landed = new Map<string, Set<string>>();
  for (const connector of connectors) {
    for (const read of new Set(connector.sources.map((source) => source.read))) {
      const fixture = fixtures[read];
      const reader = registry.readers.find((each) => each.name === read);
      if (fixture === undefined || reader === undefined) {
        faults.push(`fixtures.${read}: ${fixture === undefined ? "the reader has no fixture" : "no module exports the reader"}`);
        continue;
      }
      const proved = await proveFixture(proof, connector, reader, fixture);
      faults.push(...proved.faults.map((what) => `fixtures.${read}: ${what}`));
      lines.push(...proved.lines);
      for (const kind of proved.kinds) landed.set(connector.id, (landed.get(connector.id) ?? new Set()).add(kind));
    }
  }
  for (const connector of connectors) {
    for (const [member, what] of countFaults(connector, landed.get(connector.id) ?? new Set())) faults.push(`${connector.id}.${member}: ${what}`);
    lines.push(`${connector.id}\t(counts)\t-\t${[...landed.get(connector.id) ?? []].sort().join(", ") || "nothing"} landed; counts ${connector.counts?.join(", ") ?? (connector.noun === undefined ? "nothing" : "every kind")}`);
  }
  return { faults, lines };
}

export function countFaults(connector: Connector, landed: ReadonlySet<string>): [string, string][] {
  return backfillFaults(connector, false, landed).filter(([member]) => member === "counts");
}

async function proveFixture(proof: Proof, connector: Connector, reader: Reader, fixture: Fixture): Promise<{ faults: string[]; lines: string[]; kinds: string[] }> {
  const read = reader.name;
  const faults: string[] = [];
  const lines: string[] = [];
  const folder = mkdtempSync(join(proof.work, "fixture-"));
  const given = fixture(folder);
  const whole = written(folder);
  const stated = statedOf(given);
  if (typeof stated === "string") return { faults: [`${stated}: ${SHAPE_RULE}`], lines, kinds: [] };
  const unsaid = [...Object.keys(whole).filter((path) => !Object.hasOwn(stated.files, path)), ...Object.keys(stated.files).filter((path) => !Object.hasOwn(whole, path))];
  if (unsaid.length > 0) return { faults: [`it writes or states files the other does not: ${unsaid.join(", ")}: ${FILES_RULE}`], lines, kinds: [] };
  const reading = fixtureRead(reader, given, folder, whole, proof.work, Date.now());
  if (typeof reading === "string") faults.push(`its facts state no statement time the home reads (${reading}), so it is never read again nor timed: ${STATED_RULE}`);
  const all = await importOnce(proof, read, given, folder, whole, typeof reading === "string" ? undefined : reading);
  const kinds = all.heads.map((head) => head.slice(0, head.indexOf(" ")));
  lines.push(`${read}\t(whole)\t-\t${all.state}, ${all.heads.length} landed, ${all.refusals.length} refused`);
  const spoils = Object.values(stated.files).flatMap((spoiled) => (spoiled === "trust" ? [] : [spoiled]));
  const unlanded = [...new Set([...stated.heads, ...spoils.flatMap((spoiled) => [...spoiled.alone, ...(spoiled.prefix ?? [])])])].filter((head) => !all.heads.includes(head));
  if (all.state !== "imported" || all.refusals.length > 0 || unlanded.length > 0) {
    faults.push(`its whole delivery is ${all.state}${all.error === null ? "" : ` (${all.error.split("\n")[0]})`}, landing ${all.heads.length} (not ${unlanded.join(", ") || "one short"}) and refusing ${all.refusals.map((each) => `${each.key}: ${each.why}`).join("; ") || "nothing"}: ${WHOLE_RULE}`);
    return { faults, lines, kinds };
  }
  if (typeof all.again === "string") faults.push(`read again with its own records landed, ${all.again}: ${READS_AGAIN_RULE}`);
  if (spoils.length === 0 && stated.heads.length === 0) {
    faults.push(`every file is trust and it states no heads, where its whole lands ${all.heads.join(", ") || "nothing"}: ${STATES_RULE}`);
    return { faults, lines, kinds };
  }
  if (all.first !== undefined) faults.push(...timeFaults(connector, all.first.rows, all.first.stated_ms, new Set(kinds)));
  for (const [path, spoiled] of Object.entries(stated.files)) {
    for (const spoil of ["half", "no file"] as const) {
      const bytes = spoil === "half" ? whole[path]!.subarray(0, Math.floor(whole[path]!.length / 2)) : NO_FILE;
      const got = await importOnce(proof, read, given, folder, { ...whole, [path]: bytes });
      const wrong = spoiledFaults(path, spoiled, spoil, all.heads, got);
      lines.push(`${read}\t${path}\t${spoil}\t${wrong.length === 0 ? `ok, ${got.heads.length} landed, refused ${got.refusals.map((each) => each.kind === REST ? "the rest" : each.key).join(", ") || "nothing"}` : wrong.join("; ")}`);
      for (const each of wrong) faults.push(`${path} ${spoil}: ${each}`);
    }
  }
  return { faults, lines, kinds };
}

function spoiledFaults(path: string, spoiled: Spoiled, spoil: "half" | "no file", whole: readonly string[], got: Imported): string[] {
  const lost = spoiled === "trust" ? whole : spoiled.alone.filter((head) => spoil === "no file" || !(spoiled.prefix ?? []).includes(head));
  const cut = spoiled !== "trust" && spoil === "half" ? spoiled.cut ?? [] : [];
  const expected = [...whole.filter((head) => !lost.includes(head)), ...cut].sort();
  const rest = got.refusals.filter((each) => each.kind === REST);
  return [
    ...(got.state === "imported" ? [] : [`the import is ${got.state}: ${got.error}: ${SPOILED_RULES.imports}`]),
    ...(JSON.stringify(got.heads) === JSON.stringify(expected) ? [] : [
      `landed ${got.heads.length} of ${expected.length} expected: lost ${expected.filter((head) => !got.heads.includes(head)).join(", ") || "none"}, landed besides ${got.heads.filter((head) => !expected.includes(head)).join(", ") || "none"}: ${SPOILED_RULES.costs}`,
    ]),
    ...(spoiled === "trust"
      ? (rest.length === 1 ? [] : [`refuses the rest ${rest.length === 0 ? "never" : `${rest.length} times`}: ${SPOILED_RULES.trust}`])
      : [
        ...got.refusals.filter((each) => each.kind === REST || !refusedAs(path, each)).map((each) => `refuses ${each.kind === REST ? "the rest" : `${each.kind} ${each.key}`}: ${each.why}: ${SPOILED_RULES.named}`),
        ...(spoil === "no file" && lost.length > 0 && got.refusals.length === 0 ? [`loses ${lost.join(", ")} refusing nothing: ${SPOILED_RULES.silent}`] : []),
      ]),
  ];
}

function refusedAs(path: string, refusal: Imported["refusals"][number]): boolean {
  return refusal.key === path || [`${path}/`, `${path}:`, `${path}[`].some((under) => refusal.key.startsWith(under)) || (refusal.kind === "file" && namesToken(refusal.why, path));
}

function namesToken(text: string, token: string): boolean {
  const apart = (char: string | undefined) => char === undefined || /[\s"'()[\]{},;:]/u.test(char);
  for (let at = text.indexOf(token); at >= 0; at = text.indexOf(token, at + 1)) if (apart(text[at - 1]) && apart(text[at + token.length])) return true;
  return false;
}

function statedOf(given: Delivered): Stated | string {
  const heads = (value: unknown) => Array.isArray(value) && value.every((head) => typeof head === "string" && HEAD.test(head));
  const files = given.files as Readonly<Record<string, unknown>> | undefined;
  if (files === null || typeof files !== "object" || Array.isArray(files)) return `its files are ${JSON.stringify(files)}, no object of the files it writes`;
  for (const [path, spoiled] of Object.entries(files)) {
    if (spoiled === "trust") continue;
    const entry = spoiled as { alone?: unknown; prefix?: unknown; cut?: unknown } | null;
    const known = entry !== null && typeof entry === "object" && !Array.isArray(entry) && Object.keys(entry).every((key) => ["alone", "prefix", "cut"].includes(key));
    if (!known || !heads(entry.alone) || (entry.prefix !== undefined && !heads(entry.prefix)) || (entry.cut !== undefined && !heads(entry.cut))) return `its files.${path} is ${JSON.stringify(spoiled)}`;
  }
  if (given.heads !== undefined && !heads(given.heads)) return `its heads are ${JSON.stringify(given.heads)}`;
  return { files: files as Readonly<Record<string, Spoiled>>, heads: (given.heads ?? []) as readonly string[] };
}

async function importOnce(proof: Proof, reader: string, given: Delivered, folder: string, files: Readonly<Record<string, Buffer>>, twice?: FixtureRead): Promise<Imported> {
  const { source } = given;
  const { home, release } = checkoutLanding(proof.registry, proof.settings);
  const { read } = home;
  try {
    const first = twice === undefined ? undefined : await twice.rows(read);
    const { delivery, run } = await landDelivery(home, reader, { ...given, files }, folder, files);
    if (run === null) return { state: "not begun", error: `${delivery}: the import kind took no delivery`, heads: [], refusals: [] };
    const again = first === undefined ? undefined : rowsDiffer(textOf(first), textOf(await twice!.rows(read)));
    const view = read.view();
    try {
      const row = view.tables.deliveries.get(delivery, source);
      const heads = view.kinds(source).flatMap((kind) => [...view.heads(source, kind)].filter((head) => head.version !== "gone").map((head) => `${kind} ${head.key}`)).sort();
      const counts = (view.tables.runs.get(run)?.counts ?? {}) as { refusals?: { kind: string; key: string; violations: string[] }[] };
      const refusals = (counts.refusals ?? []).map((each) => ({ kind: each.kind, key: each.key, why: each.violations.join("; ") }));
      return {
        state: row?.state ?? "not indexed", error: row?.error ?? null, heads, refusals,
        ...(first === undefined ? {} : { first }), ...(again === undefined ? {} : { again }),
      };
    } finally {
      view.close();
    }
  } finally {
    release();
  }
}

export interface Read {
  readonly stated_ms: number;
  readonly rows: ReaderOutput[];
  readonly threw: string | null;
}

export interface FixtureRead {
  rows(home: HomeDb | null): Promise<Read>;
}

export function fixtureRead(reader: Reader, given: Delivered, folder: string, files: Readonly<Record<string, Buffer>>, work: string, at_ms: number): FixtureRead | string {
  const reads = mkdtempSync(join(work, "reads-"));
  const blobs = openHomeFolder(reads).blobs(reads);
  const carried = join(folder, CARRIED);
  for (const hex of existsSync(carried) ? readdirSync(carried) : []) blobs.put(readFileSync(join(carried, hex)));
  const facts = { fetched_at: new Date(at_ms).toISOString(), ...given.facts };
  let stated_ms: number;
  try {
    stated_ms = statedAt(facts);
  } catch (error) {
    return errorText(error).split("\n")[0]!;
  }
  const delivery: Delivery = {
    id: `${given.source}/fixture`, source: given.source, sealed_ms: stated_ms, stated_ms, facts,
    files: Object.entries(files).map(([path, bytes]) => ({ path, blob: blobs.put(bytes), size: bytes.length })),
  };
  return {
    async rows(home) {
      const view = home?.view();
      const rows: ReaderOutput[] = [];
      try {
        for await (const row of reader.read(delivery, blobs, view)) rows.push(row);
      } catch (error) {
        return { stated_ms, rows, threw: errorText(error).split("\n")[0]! };
      } finally {
        view?.close();
      }
      return { stated_ms, rows, threw: null };
    },
  };
}

export function timeFaults(connector: Connector, rows: readonly ReaderOutput[], stated_ms: number, kinds: ReadonlySet<string>): string[] {
  if (connector.noun === undefined) return [];
  const counted = new Set(connector.counts ?? kinds);
  const arrived = new Map<string, string>();
  for (const row of rows) {
    if (row.gone !== true && counted.has(row.kind) && row.time?.start_ms === stated_ms && !arrived.has(row.kind)) arrived.set(row.kind, row.key);
  }
  return [...arrived].map(([kind, key]) => `${kind} ${key} starts at its delivery's statement time: ${TIMED_RULE}`);
}

function textOf(read: Read): string[] {
  return [...read.rows.map(rowText), ...(read.threw === null ? [] : [`throws ${read.threw}`])];
}

function rowText({ bytes, streamed, ...row }: ReaderOutput): string {
  return JSON.stringify({
    ...row,
    ...(bytes === undefined ? {} : { bytes: bytes.map((each) => createHash("sha256").update(each).digest("hex")) }),
    ...(streamed === undefined ? {} : { streamed: streamed.map(({ hash, size }) => ({ hash, size })) }),
  });
}

export function rowsDiffer(first: readonly string[], again: readonly string[]): string | null {
  const at = first.findIndex((row, index) => row !== again[index]);
  if (at === -1 && first.length === again.length) return null;
  if (at === -1) return `it reads ${again.length} rows where it read ${first.length}`;
  const named = (text: string | undefined) => {
    if (text === undefined) return "none";
    if (text.startsWith("throws ")) return text;
    const { kind, key, gone } = JSON.parse(text) as ReaderOutput;
    return `${kind} ${key}${gone === true ? " gone" : ""}`;
  };
  const [was, is] = [named(first[at]), named(again[at])];
  const row = was === is ? `its row ${at + 1}, ${is}, states other content, time or blobs` : `its row ${at + 1} is ${is} where it read ${was}`;
  return `${row}${first.length === again.length ? "" : `, ${again.length} rows where it read ${first.length}`}`;
}
