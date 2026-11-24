import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { areaNames, distanceMeters, samePlace, SUGGESTIONS_LIMIT, wordsOf, type Words } from "@lifestreamprotocol/families";

type Set = "first visits" | "spots";
interface Truth { set: Set; name: string; latitude: number; longitude: number; from_ms: number; to_ms: number }
interface Suggestion { name: string; id?: string; distance_m: number; why?: { product: string; family: string | null; at_ms: number; tier: number } }
interface Own { name: string; latitude: number; longitude: number }
type Count = { first: number; three: number; listed: number; of: number };

const SETS: readonly Set[] = ["first visits", "spots"];
const MEASURED: Readonly<Record<Set, { nearest: [number, number]; rules: [number, number] }>> = {
  "first visits": { nearest: [2, 9], rules: [22, 23] },
  spots: { nearest: [4, 9], rules: [17, 24] },
};
const AREA_KM = 50;

async function door(route: string): Promise<Record<string, unknown>> {
  const machine = process.env.LIFESTREAM_MACHINE_DIR ?? join(homedir(), "Library/Application Support/Lifestream");
  const token = process.env.LIFESTREAM_DOOR_TOKEN ?? readFileSync(join(machine, "reader-token"), "utf8").trim();
  const response = await fetch(`${process.env.LIFESTREAM_DOOR ?? "http://127.0.0.1:4680"}${route}`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return (await response.json()) as Record<string, unknown>;
}

function readTruths(path: string): Truth[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { truths?: unknown };
  if (!Array.isArray(parsed.truths) || parsed.truths.length === 0) throw new Error(`${path} holds no truths: {"truths": [{set, name, latitude, longitude, from_ms, to_ms}]}`);
  return parsed.truths.map((truth: Truth, index: number) => {
    const ok = SETS.includes(truth.set) && typeof truth.name === "string" && truth.name.trim() !== "" &&
      [truth.latitude, truth.longitude, truth.from_ms, truth.to_ms].every((value) => typeof value === "number" && Number.isFinite(value)) && truth.from_ms <= truth.to_ms;
    if (!ok) throw new Error(`${path} truth ${index + 1} must state set (${SETS.join(" or ")}), name, latitude, longitude, from_ms and to_ms`);
    return truth;
  });
}

function wordsAt(truth: Truth): Words {
  const areas = new Set(areaNames(truth, AREA_KM).flatMap((name) => wordsOf(name)));
  return { plain: () => false, person: () => false, area: (word) => areas.has(word), share: () => 0 };
}

function rankOf(truth: Truth, list: readonly Suggestion[]): number | null {
  const words = wordsAt(truth);
  const at = list.findIndex((each) => samePlace(truth.name, each.name, words));
  return at < 0 ? null : at + 1;
}

function ownRow(truth: Truth, row: Suggestion, own: readonly Own[]): boolean {
  return row.id === undefined && own.some((place) => place.name === row.name && Math.abs(Math.round(distanceMeters(truth, place)) - row.distance_m) <= 1);
}

function tally(ranks: readonly (number | null)[]): Count {
  return { first: ranks.filter((rank) => rank === 1).length, three: ranks.filter((rank) => rank !== null && rank <= 3).length, listed: ranks.filter((rank) => rank !== null).length, of: ranks.length };
}

function outside(path: string, what: string): string {
  const checkout = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const target = resolve(path);
  let parent: string;
  try {
    parent = realpathSync(dirname(target));
  } catch {
    throw new Error(`${dirname(target)} does not exist`);
  }
  if (parent === checkout || parent.startsWith(`${checkout}${sep}`)) throw new Error(`${what} names the person's places: keep it outside ${checkout}`);
  return target;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const [truthsPath, outPath] = [value("--truths"), value("--out")];
  if (truthsPath === undefined || outPath === undefined || args.length !== 4) {
    throw new Error("usage: npx tsx tools/suggest-backtest.ts --truths <truths.json> --out <file.json>, both outside the checkout");
  }
  const truths = readTruths(outside(truthsPath, "the truths file"));
  const target = outside(outPath, "the artifact");
  const own = (await door("/v1/places")).places as Own[] ?? [];
  const rows: Record<string, unknown>[] = [];
  const ranks: Record<Set, { rules: (number | null)[]; nearest: (number | null)[] }> = { "first visits": { rules: [], nearest: [] }, spots: { rules: [], nearest: [] } };
  for (const truth of truths) {
    const answer = await door(`/v1/places/suggest?latitude=${truth.latitude}&longitude=${truth.longitude}&from_ms=${truth.from_ms}&to_ms=${truth.to_ms}&limit=${SUGGESTIONS_LIMIT}`);
    const list = (answer.suggestions as Suggestion[]).filter((row) => !ownRow(truth, row, own));
    const nearest = list.filter((each) => each.id !== undefined).sort((left, right) => left.distance_m - right.distance_m);
    const [rules, near] = [rankOf(truth, list), rankOf(truth, nearest)];
    ranks[truth.set].rules.push(rules);
    ranks[truth.set].nearest.push(near);
    rows.push({ set: truth.set, name: truth.name, from_ms: truth.from_ms, rules, nearest: near, top: list.slice(0, 3).map((each) => each.name) });
  }
  const table = Object.fromEntries(SETS.map((set) => {
    const [rules, nearest] = [tally(ranks[set].rules), tally(ranks[set].nearest)];
    const [first, three] = MEASURED[set].rules;
    return [set, { rules, nearest, measured: MEASURED[set], below: rules.of > 0 && (rules.first < first || rules.three < three) }];
  })) as Record<Set, { rules: Count; nearest: Count; measured: (typeof MEASURED)[Set]; below: boolean }>;
  writeFileSync(target, `${JSON.stringify({ measured_ms: Date.now(), table, rows }, null, 1)}\n`);
  const cell = (count: Count) => `${count.first} first · ${count.three} in three (of ${count.of}, ${count.listed} listed)`;
  const lines = ["", `${"".padEnd(14)}${SETS.map((set) => set.padEnd(46)).join("")}`];
  lines.push(`${"Nearest only".padEnd(14)}${SETS.map((set) => cell(table[set].nearest).padEnd(46)).join("")}`);
  lines.push(`${"These rules".padEnd(14)}${SETS.map((set) => cell(table[set].rules).padEnd(46)).join("")}`);
  lines.push(`${"Measured".padEnd(14)}${SETS.map((set) => `${MEASURED[set].rules[0]} first · ${MEASURED[set].rules[1]} in three`.padEnd(46)).join("")}`);
  const below = SETS.filter((set) => table[set].below);
  lines.push("", below.length === 0 ? "not below the measured row" : `BELOW the measured row: ${below.join(", ")}`, `artifact: ${target}`, "");
  process.stdout.write(lines.join("\n"));
  if (below.length > 0) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
