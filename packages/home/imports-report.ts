import type Database from "better-sqlite3";
import { imports as declared, productName, type Connector, type Reader } from "@lifestreamprotocol/connect";
import { civilDay, isSettled, readTables, roomOf, sourceName, type DaySettings, type HomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import { phoneUnits, shownName } from "./devices.js";
import { readPrincipals } from "./principals.js";
import { admittedFiles, consumedOf, fileId, heldImports, importIdOf, letGoOf, listingOf, openDayKey, routedSources, spanKey, tallyOf as keptTally, voidOf, type HeldImport, type Tally } from "./imports.js";
import { deliveryAt, receiptOf as receiptFile } from "./inbox.js";
import type { Receipt } from "./sweep.js";
import { STATES, type Health } from "./health.js";
import type { Act, Raised } from "./streams-report.js";
import type { MacImportFile, Stated } from "./stated.js";
import { amount, dayWords, monthWords, number, reasonWords, sizeWords, wordsOf } from "./stream-words.js";

export interface ImportFileReport {
  id: string;
  name: string;
  bytes: number;
  state: MacImportFile["state"] | "held" | "read" | "kept";
  words: string;
  line: string;
  acts: Act[];
}

export interface ImportProductReport {
  id: string;
  name: string;
  state: "asked" | "waiting" | "reading" | "read" | "partly" | "skipped" | "not-read";
  count: number;
  line: string;
}

export interface ImportAsk {
  words: string;
  choices: string[];
  other: boolean;
  choose: string;
  another: string;
}

export interface ImportHeld {
  id: string;
  account: string | null;
  made_at: string;
  name: string;
  health: Health<Act>;
  line: string;
  ask: ImportAsk | null;
  files: ImportFileReport[];
  products: ImportProductReport[];
  span: { from: string; to: string } | null;
  open_day: string | null;
  open: string | null;
  downloaded: string | null;
  notice: { title: string; body: string } | null;
}

export interface ImportWhich {
  need: string;
  words: string;
  line: string;
  imports: string[];
  choices: { unit: string; words: string; line: string }[];
  choose: string;
}

const WHICH = "Which iPhone is this backup from?";
const NEW_PHONE = "An iPhone not set up with Lifestream";

const ofDevice = (kind: declared.ImportKind): boolean => kind.reads.some((read) => read.copy === declared.UNIT);

export interface ImportReport {
  kind: string;
  name: string;
  icon: string;
  takes: string;
  wait: string | null;
  file: string;
  reads: string | null;
  products: { id: string; name: string }[];
  guide: { title?: string; words: string; open?: { label: string; url: string } }[];
  recognise: string[];
  leaves: string[];
  root?: string;
  lists?: "backups";
  which?: ImportWhich[];
  drop: { words: string; line: string; choose: string; away: string };
  titles: { reads: string; guide: string; held: string };
  health: Health<Act>;
  line: string;
  coming: ImportFileReport[];
  held: ImportHeld[];
}

export type ExportRow = { import: string; name: string; icon: string; opens: boolean; line: string };

export interface ImportsInput {
  folder: HomeFolder;
  now_ms: number;
  connectors: readonly Connector[];
  free_bytes: number;
  max_bundle_bytes: number;
  day: DaySettings;
  stated: Stated | null;
}

const FILES_NOUN = ["file", "files"] as const;
const OPAQUE = /^(?:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}|[0-9a-f]{16,}|\d{10,}|user-[0-9a-z]+)$/iu;
export const NO_READERS: readonly Reader[] = [];
const KEEP_BYTES = 5e9;
const HTML_LINE = "Came as HTML. Choose JSON next time: it holds more.";

function stampInstant(stamp: string | null): number | null {
  const parts = stamp === null ? null : /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u.exec(stamp);
  return parts === null ? null : Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]), Number(parts[4]), Number(parts[5]), Number(parts[6]));
}
const DROP_LINE = "Lifestream reads a copy; your file stays where it is.";
const ok = (): Health<Act> => ({ state: "ok", reason: null, words: "", since_ms: null, next_ms: null, acts: [], detail: null });
const some = (names: readonly string[]): string => (names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")}, ${names.length - 2} more`);

interface Row {
  id: string;
  source: string;
  state: string;
  run: number | null;
  refused: number;
  sealed_ms: number;
  error: string | null;
}

const under = (key: string, path: string): boolean => key === path || key.startsWith(`${path}/`);
export const outstandingOf = (row: { readonly state: string; readonly refused: number }): boolean => row.state === "imported" && row.refused > 0;

export const healthOf = (need: Raised): Health<Act> => ({ state: need.state, reason: need.reason, words: need.words, since_ms: need.since_ms, next_ms: null, acts: need.acts, detail: need.detail, ...need.line === undefined ? {} : { line: need.line } });

function worstOf(healths: readonly Health<Act>[]): Health<Act> | null {
  return healths.reduce<Health<Act> | null>((worst, each) => (worst === null || STATES.indexOf(each.state) < STATES.indexOf(worst.state) ? each : worst), null);
}

export function readImports(db: Database.Database, input: ImportsInput): {
  imports: ImportReport[]; needs: Raised[]; fed: (connector: Connector) => ExportRow | null;
} {
  const needs: Raised[] = [];
  const raise = (need: Omit<Raised, "next_ms" | "unit" | "at" | "detail"> & { detail?: string | null }): Raised => {
    const raised: Raised = { ...need, next_ms: null, unit: null, at: null, detail: need.detail ?? null };
    needs.push(raised);
    return raised;
  };
  const kinds = declared.importKinds(input.connectors, NO_READERS);
  const tables = readTables(db);
  const blockedAt = tables.deliveries.blockedAt;
  const metaGet = db.prepare("SELECT value FROM meta WHERE key = ?").pluck();
  const get = (key: string): string | undefined => metaGet.get(key) as string | undefined;
  const meta = { get };
  const shipment = db.prepare("SELECT id, source, state, run, refused, sealed_ms, error FROM deliveries WHERE id = ?");
  const bySeal = db.prepare("SELECT id FROM deliveries WHERE source = ? AND pass = ? AND seal = ? LIMIT 1").pluck();
  const runCounts = db.prepare("SELECT counts FROM runs WHERE id = ?").pluck();
  const jobOf = db.prepare("SELECT state, progress FROM jobs WHERE kind = ? AND key = ?");
  const sourceRows = db.prepare("SELECT id, vendor, connector FROM sources").all() as { id: string; vendor: string; connector: string }[];
  const held = heldImports(meta);
  const admitted = admittedFiles(meta);
  const low = roomOf(input.free_bytes) !== "ok";
  const { day } = input;

  const countedKinds = (source: string): readonly string[] | null => {
    const named = sourceRows.find((row) => row.id === source)?.connector;
    const connector = input.connectors.find((each) => each.sources.some((declaredSource) => declaredSource.read === named || declaredSource.feeders?.includes(named ?? "") === true));
    return connector?.counts ?? null;
  };
  const tallyOf = (row: Row): Tally | null => keptTally(meta, row.id, row.source);
  const counted = (row: Row): number => {
    const tally = tallyOf(row);
    if (row.state !== "importing" && tally !== null) {
      const counts = countedKinds(row.source);
      return Object.entries(tally.kinds).reduce((total, [kind, count]) => total + (counts === null || counts.includes(kind) ? count : 0), 0);
    }
    const sum = (counts: JsonObject | null) => (counts === null ? 0 : ["new", "restated", "changed", "late"].reduce((total, key) => total + (typeof counts[key] === "number" ? (counts[key] as number) : 0), 0));
    if (row.state === "importing") {
      const job = jobOf.get("import", row.source) as { state: string; progress: string | null } | undefined;
      const progress = job?.progress === null || job?.progress === undefined ? null : (JSON.parse(job.progress) as { run?: number; counts?: JsonObject });
      return progress?.run === row.run ? sum(progress.counts ?? null) : 0;
    }
    if (row.run === null) return 0;
    const kept = runCounts.get(row.run) as string | null | undefined;
    return sum(kept === null || kept === undefined ? null : (JSON.parse(kept) as JsonObject));
  };
  const refusedOf = (row: Row, paths: readonly string[], gone: ReadonlySet<string> = new Set()): { members: number; files: Set<string>; gone: number } => {
    if (row.refused === 0 || paths.length === 0) return { members: 0, files: new Set(), gone: 0 };
    const kept = paths.filter((path) => !gone.has(path));
    const files = new Set<string>();
    let named = 0;
    let members = 0;
    let given = 0;
    let unplaced = 0;
    for (const [member, count] of Object.entries(tallyOf(row)?.refused?.members ?? {})) {
      named += count;
      const file = paths.find((path) => under(member, path));
      if (file !== undefined && gone.has(file)) given++;
      else if (file === undefined) unplaced++;
      else {
        members++;
        files.add(file);
      }
    }
    const unnamed = Math.max(0, row.refused - named) + unplaced;
    if (unnamed > 0) for (const path of kept) files.add(path);
    return kept.length > 0 ? { members: members + unnamed, files, gone: given } : { members, files, gone: given + unnamed };
  };
  const receiptOf = (delivery: string): Receipt | null => {
    const bytes = receiptFile(input.folder, deliveryAt(input.folder, delivery)).read();
    if (bytes === undefined) return null;
    try {
      return JSON.parse(bytes.toString("utf8")) as Receipt;
    } catch {
      return null;
    }
  };
  const nounOf = (product: string): readonly [string, string] => {
    const connector = input.connectors.find((each) => each.product === product || each.sources.some((source) => source.id.split(":")[0] === product));
    return connector?.noun ?? ["record", "records"];
  };
  const dated = (ms: number): string => `${Number(civilDay(ms, day).slice(8))} ${monthWords(ms, day)}`;
  const madeOf = (entry: HeldImport): number => entry.time_ms ?? entry.at_ms;

  const said = new Map<string, Said[]>();
  const whichNeeds = new Map<string, Raised>();
  const reports = kinds.map((kind): ImportReport => {
    const ofKind = Object.entries(held).filter(([, entry]) => entry.kind === kind.id);
    const askingReads = new Set(ofKind.filter(([, entry]) => (entry.account === null || entry.unit === null) && entry.ended !== true).map(([id, entry]) => readOf(id, entry)));
    const asked = (id: string, entry: HeldImport): number => (askingReads.has(readOf(id, entry)) ? 0 : 1);
    const own = ofKind.sort(([leftId, left], [rightId, right]) => asked(leftId, left) - asked(rightId, right) || madeOf(right) - madeOf(left) || readOf(leftId, left).localeCompare(readOf(rightId, right)));
    const imports = own.map(([id, entry]) => heldOf(kind, id, entry));
    said.set(kind.id, imports);
    const coming = macFiles(kind).filter((file) => file.state !== "joined").map((file) => file.report);
    const going = macFiles(kind).filter((file) => !["refused", "missing", "already"].includes(file.report.state));
    const sending = going.some((file) => ["checking", "waiting", "sending"].includes(file.report.state));
    const notIn = imports.find((each) => !each.in);
    const newest = imports.find((each) => each.in);
    const last = newest === undefined ? [] : imports.filter((each) => each.in && each.read === newest.read);
    const health = worstOf([...imports.map((each) => each.held.health).filter((each) => each.state === "needs-you" || each.state === "broken"), ...(notIn ?? newest) === undefined ? [] : [(notIn ?? newest)!.held.health]]);
    return {
      kind: kind.id, name: kind.name, icon: kind.icon, takes: kind.takes, wait: kind.wait, file: kind.file,
      reads: readByMany(kind) ? null : readsOf(kind),
      products: readByMany(kind) ? [...kind.products].sort((a, b) => declaredAt(a.id) - declaredAt(b.id)).map((product) => ({ id: product.id, name: shownProduct(product.id, product.name) })) : [],
      guide: kind.guide.map((step) => ({ ...(step.title === undefined ? {} : { title: step.title }), words: step.words, ...(step.open === undefined ? {} : { open: { ...step.open } }) })),
      recognise: [...kind.recognise], leaves: [...kind.leaves], ...(kind.root === undefined ? {} : { root: kind.root }),
      ...ofDevice(kind) ? { lists: "backups" as const, which: whichOf(kind, own) } : {},
      drop: { words: `Drop the ${kind.file} here`, line: DROP_LINE, choose: "Choose file…", away: "On your Mac" },
      titles: { reads: "What it brings", guide: "How to get it", held: "Your imports" },
      health: health ?? ok(),
      line: sending ? `Sending · ${number(going.filter((file) => file.report.state === "sent" || file.state === "joined").length)} of ${amount(going.length, FILES_NOUN)}`
        : notIn !== undefined ? notIn.row : last.length > 0 ? broughtRow(kind, last) : kind.takes,
      coming,
      held: imports.map((each) => each.held),
    };
  });

  const fed = (connector: Connector): ExportRow | null => {
    const kind = kinds.find((each) => each.id === connector.id) ?? kinds.find((each) => each.id === declared.importOf(connector)?.kind);
    if (kind === undefined) return null;
    const product = connector.export !== undefined && "product" in connector.export ? connector.export.product.id : null;
    const newest = (said.get(kind.id) ?? []).find((each) => each.held.account !== null && (product === null || each.held.products.some((each) => each.id === product)));
    const line = newest === undefined ? kind.takes : newest.in ? `Imported ${dayWords(newest.at_ms, input.now_ms, day)}` : "Importing";
    return { import: kind.id, name: kind.name, icon: kind.icon, opens: false, line };
  };
  return { imports: reports, needs, fed };

  function notThis(kind: declared.ImportKind): string {
    const named = /(?:export|backup|Takeout)$/u.test(kind.name) ? kind.name : `${kind.name} export`;
    return `${/^[aeiou]/iu.test(named) ? "an" : "a"} ${named}`;
  }

  function companyOf(kind: declared.ImportKind): string {
    return (kind.root === undefined ? ownConnector(kind)?.name : undefined) ?? `${kind.vendor.charAt(0).toUpperCase()}${kind.vendor.slice(1)}`;
  }

  function shownProduct(id: string, fallback: string): string {
    return input.connectors.find((each) => each.export !== undefined && "product" in each.export && each.export.product.id === id)?.name ?? fallback;
  }

  function declaredAt(id: string): number {
    const at = input.connectors.findIndex((each) => each.export !== undefined && "product" in each.export && each.export.product.id === id);
    return at === -1 ? input.connectors.length : at;
  }

  function readByMany(kind: declared.ImportKind): boolean {
    return kind.root !== undefined || kind.products.length > 1;
  }

  function ownConnector(kind: declared.ImportKind): Connector | undefined {
    return input.connectors.find((each) => each.id === kind.id);
  }

  function readOf(id: string, entry: HeldImport): string {
    return entry.device === undefined ? `import:${id}` : `backup:${entry.device.device}:${madeOf(entry)}`;
  }

  function broughtRow(kind: declared.ImportKind, last: readonly Said[]): string {
    const brought = `Imported ${dayWords(Math.min(...last.map((each) => each.at_ms)), input.now_ms, day)}`;
    const refused = last.reduce((total, each) => total + each.refused, 0);
    if (refused > 0) return `${brought} · ${amount(refused, FILES_NOUN)} couldn’t be read`;
    const rank = (id: string): number => ((at) => (at === -1 ? kind.products.length : at))(kind.products.findIndex((product) => product.id === id));
    const read = [...new Map(last.flatMap((each) => each.read_products).map((product) => [product.id, product])).values()]
      .sort((left, right) => rank(left.id) - rank(right.id) || left.name.localeCompare(right.name)).map((product) => product.name);
    const several = kind.root !== undefined || last.reduce((total, each) => total + each.products, 0) > 1;
    return read.length > 0 && several ? `${brought} · ${some(read)}` : brought;
  }

  function readsOf(kind: declared.ImportKind): string | null {
    const connector = ownConnector(kind);
    return connector === undefined ? null : connector.gives ?? connector.records;
  }

  function macFiles(kind: declared.ImportKind): { state: "joined" | "own"; report: ImportFileReport }[] {
    const retired = db.prepare("SELECT retired_ms FROM devices WHERE unit = ?").pluck();
    return Object.entries(input.stated ?? {}).filter(([unit]) => (retired.get(unit) ?? null) === null).flatMap(([unit, statement]) =>
      (statement.imports ?? []).filter((each) => each.kind === kind.id).flatMap((each) => each.files.map((file) => {
        const delivery = file.seal === null || file.pass === null ? null : (bySeal.get(`upload:local:${unit}`, file.pass, file.seal) as string | undefined) ?? null;
        const before = file.sha256 === null ? undefined : admitted[`${kind.id}/${file.sha256}`];
        const already = (at: number | null): { state: "own"; report: ImportFileReport } => ({ state: "own", report: {
          id: file.id, name: file.name, bytes: file.bytes, state: "already", words: "Already imported", line: at === null ? sizeWords(file.bytes) : dayWords(at, input.now_ms, day), acts: [],
        } });
        const voided = delivery === null ? null : voidOf(meta, delivery);
        if (voided !== null) {
          if (voided.dropped === true) return { state: "joined" as const, report: macReport(kind, file) };
          return already(admitted[`${kind.id}/${voided.digest}`]?.at_ms ?? null);
        }
        if (delivery !== null && importIdOf(meta, delivery) !== null) return { state: "joined" as const, report: macReport(kind, file) };
        if (before !== undefined && before.delivery !== delivery) return already(before.at_ms);
        if (file.state === "already") return already(null);
        return { state: "own" as const, report: macReport(kind, file) };
      })));
  }

  function macReport(kind: declared.ImportKind, file: MacImportFile): ImportFileReport {
    const size = sizeWords(file.bytes);
    const said = (words: string, line: string = size): ImportFileReport => ({ id: file.id, name: file.name, bytes: file.bytes, state: file.state, words, line, acts: [] });
    switch (file.state) {
      case "checking": return said("Checking…");
      case "refused":
        if (file.why === "not-this-kind") return said(`This isn’t ${notThis(kind)}`, kind.file === "zip" ? `Choose the zip ${companyOf(kind)} emailed you` : `Choose the ${kind.file} ${companyOf(kind)} made`);
        if (file.why === "nothing-read") return said("Nothing in it Lifestream reads", "not sent");
        if (file.why === "too-large") return said("Too large to send", `over ${sizeWords(input.max_bundle_bytes)}`);
        return said("Couldn’t open it", "Download it again");
      case "waiting":
        if (file.why === "battery") return said("Waiting", "plug in your Mac");
        if (file.why === "mac-room") return said("Waiting", `needs ${sizeWords(file.bytes)} free on this Mac`);
        if (file.why === "home-room") return said("Waiting", `Lifestream needs ${sizeWords(KEEP_BYTES + 2 * file.bytes)} free`);
        return said("Waiting its turn");
      case "sending": return said("Sending", `${sizeWords(file.sent_bytes ?? 0)} of ${size}`);
      case "missing": return said("Can't find it", "Choose it again");
      case "already": return said("Already imported");
      case "sent": return said("Imported");
    }
  }

  function heldOf(kind: declared.ImportKind, id: string, entry: HeldImport): Said {
    const account = entry.account;
    const deliveries = entry.deliveries.map((delivery) => {
      const listing = listingOf(meta, delivery);
      const receipt = receiptOf(delivery);
      const letGo = new Set(letGoOf(meta, delivery));
      const removed = new Set((receipt?.removed ?? []).map((path) => (path.startsWith("files/") ? path.slice("files/".length) : path).split("/")[0]!));
      const routes = listing === null ? [] : routedSources(listing, entry).map((route) => ({ source: route.id, of: route.of, files: route.files }));
      const sources = new Set(routes.map((route) => route.source));
      const rows = (shipment.all(delivery) as Row[]).filter((row) => sources.has(row.source));
      return { id: delivery, listing, routes, rows, letGo, removed };
    });
    const rows = deliveries.flatMap((delivery) => delivery.rows);
    const phoneAsked = entry.unit === null;
    const provisional = account === null || phoneAsked;
    const settled = !provisional && rows.length > 0 && rows.every(isSettled) && deliveries.every((delivery) => delivery.listing !== null);
    const stopped = rows.filter((row) => blockedAt(row.source)?.id === row.id);

    type Kept = { id: string; name: string; reads: boolean; rows: { row: Row; paths: string[]; gone: ReadonlySet<string> }[]; unclaimed: number; activity: Set<string> };
    const products = new Map<string, Kept>();
    for (const delivery of entry.ended === true ? [] : deliveries) {
      if (delivery.listing === null) continue;
      for (const product of delivery.listing.products) {
        const kept = products.get(product.id) ?? { id: product.id, name: product.name, reads: product.reads, rows: [], unclaimed: 0, activity: new Set<string>() };
        for (const route of delivery.routes.filter((each) => each.of === product.id)) {
          const row = delivery.rows.find((each) => each.source === route.source);
          if (row === undefined) continue;
          const had = kept.rows.find((each) => each.row === row);
          if (had === undefined) kept.rows.push({ row, paths: [...route.files], gone: delivery.letGo });
          else had.paths = [...new Set([...had.paths, ...route.files])].sort();
        }
        kept.unclaimed += product.unclaimed;
        if (product.activity !== null) kept.activity.add(product.activity);
        products.set(product.id, kept);
      }
    }
    let outstanding = 0;
    let refusedMembers = 0;
    const listed = kind.products;
    const rank = (productId: string): number => ((at) => (at === -1 ? listed.length : at))(listed.findIndex((product) => product.id === productId));
    const nounOfKept = (product: Kept): readonly [string, string] =>
      listed.find((each) => each.id === product.id)?.noun ?? (product.rows[0] === undefined ? (["record", "records"] as const) : nounOf(sourceName(product.rows[0].row.source).product));
    const productReports = [...products.values()].map((product): ImportProductReport => {
      const noun = nounOfKept(product);
      const count = product.rows.reduce((total, { row }) => total + counted(row), 0);
      const name = shownProduct(product.id, product.name);
      const base = { id: product.id, name, count };
      if (provisional) return { ...base, state: "asked", line: name };
      if (!product.reads) return { ...base, state: "not-read", line: `${name} · not read yet` };
      if (product.rows.length === 0) return { ...base, state: "waiting", line: `${name} · waiting` };
      if (!product.rows.every(({ row }) => isSettled(row))) {
        if (product.rows.every(({ row }) => row.state === "sealed") && count === 0) return { ...base, state: "waiting", line: `${name} · waiting` };
        return { ...base, state: "reading", line: `${name} · ${number(count)} so far` };
      }
      const open = product.rows.filter(({ row }) => outstandingOf(row)).reduce((total, { row, paths, gone }) => total + refusedOf(row, paths, gone).members, 0);
      const skipped = product.rows.filter(({ row }) => row.state === "dead").reduce((total, { row, paths }) => total + Math.max(1, refusedOf(row, paths).members), 0)
        + product.rows.filter(({ row }) => outstandingOf(row)).reduce((total, { row, paths, gone }) => total + refusedOf(row, paths, gone).gone, 0);
      outstanding += open;
      refusedMembers += open + skipped;
      const counts = count > 0 ? [amount(count, noun)] : [];
      if (open > 0) return { ...base, state: "partly", line: [name, ...counts, `${amount(open, FILES_NOUN)} couldn’t be read`].join(" · ") };
      if (skipped > 0) return { ...base, state: "skipped", line: [name, ...counts, `${amount(skipped, FILES_NOUN)} skipped`].join(" · ") };
      const html = product.activity.has("html") && !product.activity.has("json") ? [HTML_LINE] : [];
      return { ...base, state: "read", line: [name, amount(count, noun), ...html].join(" · ") };
    }).sort((left, right) => rank(left.id) - rank(right.id) || left.name.localeCompare(right.name));

    const files: ImportFileReport[] = [];
    for (const delivery of deliveries) {
      for (const file of delivery.listing?.files ?? []) {
        if (delivery.removed.has(file.path) || delivery.letGo.has(file.path)) continue;
        const fid = fileId(delivery.id, file.path);
        const size = sizeWords(file.bytes);
        const report = (state: ImportFileReport["state"], words: string, line: string = size): ImportFileReport => ({
          id: fid, name: ofDevice(kind) ? delivery.listing?.products.find((product) => product.files.includes(file.path))?.name ?? file.path : file.path, bytes: file.bytes, state, words, line, acts: state === "kept" || provisional ? [{ do: "let-go", label: "Remove file", need: `import:${id}:file:${fid}` }] : [],
        });
        if (entry.ended === true) {
          files.push(report("kept", "Kept"));
          continue;
        }
        const claims = delivery.routes.filter((route) => route.files.includes(file.path));
        const claimRows = claims.map((route) => delivery.rows.find((row) => row.source === route.source));
        if (provisional || claimRows.some((row) => row === undefined || !isSettled(row))) {
          files.push(report("held", "Imported"));
          continue;
        }
        const reads = new Map<Row, Set<string>>();
        claims.forEach((route, at) => reads.set(claimRows[at]!, new Set([...reads.get(claimRows[at]!) ?? [], ...route.files])));
        const refused = [...reads].reduce((total, [row, paths]) => {
          const of = refusedOf(row, [...paths].sort());
          return total + (of.files.has(file.path) ? Math.max(1, Object.keys(tallyOf(row)?.refused?.members ?? {}).filter((member) => under(member, file.path)).length) : 0);
        }, 0);
        const unread = (delivery.listing?.products ?? []).filter((product) => !product.reads && product.files.includes(file.path)).map((product) => product.name);
        const consumed = claims.length > 0 && claims.every((route, at) => {
          const row = claimRows[at]!;
          return row.state === "imported" && row.refused === 0 && consumedOf(meta, delivery.id, route.source)?.includes(file.path) === true;
        });
        if (file.refused !== undefined) files.push(report("kept", "Kept", "couldn’t read it"));
        else if (refused > 0) files.push(report("kept", "Kept", `${amount(refused, FILES_NOUN)} couldn't be read`));
        else if (unread.length > 0) files.push(report("kept", "Kept", `${some(unread)} ${unread.length === 1 ? "isn't" : "aren't"} read yet`));
        else if ((file.unclaimed ?? 0) > 0) files.push(report("kept", "Kept", `${amount(file.unclaimed!, FILES_NOUN)} Lifestream doesn't read yet`));
        else if (consumed) files.push(report("read", "Read"));
        else files.push(report("kept", "Kept", "files Lifestream doesn't read yet"));
      }
    }
    const shownFiles = files.every((file) => file.state === "read") ? [] : files;

    const isIn = settled;
    const spanKept = get(spanKey(id));
    const span = isIn && spanKept !== undefined ? (JSON.parse(spanKept) as { from: string; to: string }) : null;
    const open_day = isIn ? get(openDayKey(id)) ?? null : null;
    const name = entry.device !== undefined
      ? `${typeof entry.unit === "string" ? shownName(tables, entry.unit) : entry.device.model_name} · backup of ${dayWords(madeOf(entry), input.now_ms, day)}`
      : [dated(madeOf(entry)), account !== null && !OPAQUE.test(account) ? account : kind.name].join(" · ");

    const need = { connector: kind.id, copy: null, since_ms: null };
    const own: Raised[] = [];
    for (const row of stopped) {
      const key = `job:import:${row.source}`;
      own.push(raise({ ...need, id: key, copy: row.source, since_ms: row.sealed_ms, state: "broken", reason: "import", detail: row.error,
        words: `Couldn’t import ${productName(input.connectors, sourceName(row.source).product)}`, line: `From your ${kind.name}`, acts: [{ do: "skip", label: "Skip it", need: key }] }));
    }
    let ask: ImportAsk | null = null;
    let notice: ImportHeld["notice"] = null;
    let line: string;
    if (entry.ended === true) {
      const key = `import:${id}:refused`;
      own.push(raise({ ...need, id: key, state: entry.failed === undefined ? "needs-you" : "broken", reason: "import", words: entry.refused ?? `This isn’t ${notThis(kind)}`, line: `Your ${kind.name}`,
        detail: entry.failed ?? null, acts: [{ do: "skip", label: "Skip it", need: key }] }));
      line = entry.refused ?? `This isn’t ${notThis(kind)}`;
    } else if (phoneAsked) {
      const device = entry.device!.device;
      const raised = whichNeeds.get(device) ?? raise({ ...need, id: `import:${id}:which`, state: "needs-you", reason: "choose", words: WHICH, line: `Your ${kind.name}`,
        acts: [{ do: "import", label: "Choose", kind: kind.id }] });
      whichNeeds.set(device, raised);
      own.push(raised);
      line = WHICH;
    } else if (provisional) {
      const stamped = entry.time_ms ?? stampInstant(entry.stamp);
      const whose = whoseOf(kind, entry);
      const words = (entry.named?.length ?? 0) <= 1 && kind.root !== undefined && stamped !== null
        ? `${whose.ask.replace(/\?$/u, "")} ${kind.name.split(" ").at(-1)!} from ${dayWords(stamped, input.now_ms, day)}?` : whose.ask;
      ask = { words, choices: (entry.named?.length ?? 0) > 1 ? [...entry.named!] : choicesOf(kind, entry, whose.vendor), other: (entry.named?.length ?? 0) <= 1, choose: "Choose", another: "Another…" };
      own.push(raise({ ...need, id: `import:${id}:whose`, state: "needs-you", reason: "choose", words, line: `Your ${kind.name}`, acts: [{ do: "import", label: "Choose", kind: kind.id }] }));
      line = entry.refused ?? words;
    } else if (isIn) {
      if (outstanding > 0) {
        const key = `import:${id}:refused`;
        own.push(raise({ ...need, id: key, state: "needs-you", reason: "import", words: `Couldn't read ${amount(outstanding, FILES_NOUN)}`, line: `From your ${kind.name}`,
          acts: [{ do: "skip", label: "Skip it", need: key }] }));
      }
      const years = span === null ? [] : [span.from.slice(0, 4) === span.to.slice(0, 4) ? span.from.slice(0, 4) : `${span.from.slice(0, 4)}–${span.to.slice(0, 4)}`];
      const only = productReports.length === 1 ? products.get(productReports[0]!.id) : undefined;
      const total = kind.root === undefined && only !== undefined ? [amount(productReports[0]!.count, nounOfKept(only))] : [];
      const told = [...years, ...outstanding > 0 ? [`${amount(outstanding, FILES_NOUN)} couldn’t be read`] : total];
      line = ["Imported", ...told].join(" · ");
      notice = { title: `${kind.name} imported`, body: told.length === 0 ? dayWords(entry.at_ms, input.now_ms, day) : told.join(" · ") };
    } else if (low) {
      const space = reasonWords("waiting", "disk", wordsOf(kind.name, null, input.now_ms, day));
      line = `${space} · ${Math.max(1, Math.ceil((KEEP_BYTES - input.free_bytes) / 1e9))} GB free to go on · your files are kept`;
    } else if (kind.root !== undefined && productReports.some((product) => product.id === "mail" && product.state === "reading")) {
      line = "Reading your Takeout's mail · new mail waits";
    } else {
      const parts = productReports.filter((product) => product.state !== "not-read").map((product) =>
        product.state === "reading" ? `${product.name} ${number(product.count)} so far` : product.state === "waiting" ? product.name
          : `${product.name} ${amount(product.count, listed.find((each) => each.id === product.id)?.noun ?? nounOf(product.id))}`);
      line = ["Importing", ...parts].join(" · ");
    }
    const worst = own.reduce<Raised | null>((best, each) => (best === null || STATES.indexOf(each.state) < STATES.indexOf(best.state) ? each : best), null);
    const health: Health<Act> = worst !== null ? healthOf(worst)
      : !isIn && low ? { state: "waiting", reason: "disk", words: reasonWords("waiting", "disk", wordsOf(kind.name, null, input.now_ms, day)), since_ms: null, next_ms: null, acts: [], detail: null, line: "your files are kept" }
        : isIn ? ok() : { state: "syncing", reason: null, words: "", since_ms: null, next_ms: null, acts: [], detail: null };
    return {
      in: isIn, row: line, at_ms: entry.at_ms, read: readOf(id, entry), refused: refusedMembers, products: productReports.length,
      read_products: productReports.filter((product) => product.state === "read").map((product) => ({ id: product.id, name: product.name })),
      held: {
        id, account, made_at: new Date(madeOf(entry)).toISOString(), name, health, line, ask, files: shownFiles, products: productReports, span, open_day,
        open: open_day === null ? null : "Open a day",
        downloaded: isIn && !ofDevice(kind) ? `You can delete the ${entry.deliveries.length > 1 ? "files" : "file"} you downloaded.` : null,
        notice,
      },
    };
  }

  function choicesOf(kind: declared.ImportKind, entry: HeldImport, vendor: string): string[] {
    const accounts = new Set<string>(Object.values(held).filter((each) => each.kind === kind.id && each.account !== null && whoseOf(kind, each).vendor === vendor).map((each) => each.account!));
    for (const source of sourceRows) {
      const parts = source.id.split(":");
      if (parts.length === 3 && source.vendor === vendor && parts[1] !== "local" && (vendor !== "google" || parts[1]!.includes("@"))) accounts.add(parts[1]!);
    }
    const first = entry.stamp === null ? [] : Object.values(held).filter((each) => each.kind === kind.id && each.stamp === entry.stamp && each.account !== null).map((each) => each.account!);
    return [...new Set([...first.sort(), ...[...accounts].sort()])];
  }

  function whoseOf(kind: declared.ImportKind, entry: HeldImport): { vendor: string; ask: string } {
    const product = entry.deliveries.map((delivery) => listingOf(meta, delivery)?.products[0]?.id).find((id) => id !== undefined);
    return product === undefined ? { vendor: kind.vendor, ask: kind.ask } : kind.whose(product);
  }

  function whichOf(kind: declared.ImportKind, own: readonly [string, HeldImport][]): ImportWhich[] {
    const waiting = own.filter(([, entry]) => entry.unit === null && entry.ended !== true && entry.device !== undefined);
    if (waiting.length === 0) return [];
    const passes = readPrincipals(input.folder).principals.filter((row) => row.kind === "phone");
    const phones = phoneUnits(tables, passes);
    const heard = (unit: string): number | null => {
      const newest = passes.filter((row) => row.unit === unit).flatMap((row) => tables.deliveries.sealedBy(row.id)?.newest_ms ?? []);
      return newest.length === 0 ? null : Math.max(...newest);
    };
    const products = new Set(input.connectors.filter((connector) => declared.importOf(connector)?.kind === kind.id).map((connector) => connector.product));
    const sources = sourceRows.map((row) => sourceName(row.id)).filter((name) => products.has(name.product));
    const devices = [...new Set(waiting.map(([, entry]) => entry.device!.device))];
    return devices.map((device) => {
      const of = waiting.filter(([, entry]) => entry.device!.device === device);
      const stated = of[0]![1].device!;
      const choices = phones.map((phone) => {
        const holds = sources.filter((name) => name.copy === phone.unit);
        const names = [...new Set(holds.map((name) => productName(input.connectors, name.product)))].sort();
        const last = heard(phone.unit);
        const line = [
          ...names.length > 0 ? [`${names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`} already here from this phone`] : [],
          ...phone.retired ? ["removed"] : [],
          ...last !== null ? [`last heard from ${dayWords(last, input.now_ms, day)}`] : phone.passed && !phone.retired ? ["nothing sent yet"] : [],
        ].join(" · ");
        const rank = holds.some((name) => stated.accounts.includes(name.account)) ? 0 : phone.model === stated.model_name ? 1 : 2;
        return { rank, choice: { unit: phone.unit, words: shownName(tables, phone.unit), line } };
      }).sort((a, b) => a.rank - b.rank || a.choice.words.localeCompare(b.choice.words) || a.choice.unit.localeCompare(b.choice.unit)).map((each) => each.choice);
      return {
        need: `import:${of[0]![0]}:which`, words: WHICH, line: `${stated.model_name} · ${dated(madeOf(of[0]![1]))}`,
        imports: of.map(([id]) => id), choices: [...choices, { unit: "new", words: NEW_PHONE, line: "" }], choose: "Choose",
      };
    });
  }
}

interface Said {
  held: ImportHeld;
  in: boolean;
  row: string;
  at_ms: number;
  read: string;
  refused: number;
  products: number;
  read_products: { id: string; name: string }[];
}
