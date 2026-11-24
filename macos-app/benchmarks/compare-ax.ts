#!/usr/bin/env -S node --import tsx
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { assembleAxTree } from "../../sources/screen/coast-reader.js";
import type { DecodedCoastAxNode } from "../../sources/screen/coast-ax.js";

type OwnFrame = { t: number; app: string | null; tokens: Set<string>; ax: boolean; status: string; nodes: number; display: number };
type CoastFrame = { timestamp: number; root_hash: Uint8Array | null; bundle_id: string | null; is_partial_tree: number | null; extraction_mode: string | null };
function words(text: string): Set<string> { return new Set(text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []); }
function summary(input: number[]) {
  const values = [...input].sort((a, b) => a - b);
  if (!values.length) return { n: 0 };
  return { n: values.length, min: values[0], median: (values[Math.floor((values.length - 1) / 2)]! + values[Math.floor(values.length / 2)]!) / 2,
    p95: values[Math.ceil(values.length * .95) - 1], max: values.at(-1), mean: values.reduce((a, b) => a + b, 0) / values.length };
}
function textFromTree(tree: unknown): { text: string; nodes: number; hidden: number } {
  const stack: unknown[] = [tree]; const text: string[] = []; let nodes = 0, hidden = 0;
  while (stack.length) {
    const branch = stack.pop() as { node: DecodedCoastAxNode; children: unknown[] };
    nodes++; if (branch.node.visible === false) hidden++;
    for (const value of [branch.node.title, branch.node.description, branch.node.value]) if (typeof value === "string") text.push(value);
    stack.push(...branch.children);
  }
  return { text: text.join("\n"), nodes, hidden };
}
function dateMilliseconds(value: unknown): number {
  const result = typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(result)) throw new Error("invalid capture timestamp");
  return result;
}
function loadOwn(store: string, start: number, end: number, executable: string): OwnFrame[] {
  const output: OwnFrame[] = [];
  for (let day = Math.floor(start / 86400) * 86400; day < end; day += 86400) {
    const folder = join(store, new Date(day * 1000).toISOString().slice(0, 10));
    let entries: string[];
    try { entries = readdirSync(folder); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const plain = join(folder, name, "observation.json"), compressed = join(folder, name, "observation.lsm");
      if (existsSync(plain) === existsSync(compressed)) throw new Error("Expected exactly one metadata file per committed bundle");
      const record = JSON.parse(existsSync(plain) ? readFileSync(plain, "utf8") :
        execFileSync(executable, ["decode-metadata", "--input", compressed], { encoding: "utf8", maxBuffer: 17 * 1024 * 1024, timeout: 20000 }));
      const t = dateMilliseconds(record.capturedAt) / 1000;
      if (t < start || t >= end || record.status !== "captured") continue;
      const nodes: { text?: string }[] = record.accessibility?.nodes ?? [];
      output.push({ t, app: record.application?.bundleID ?? null, ax: record.accessibility != null,
        tokens: words(nodes.map(node => node.text ?? "").join("\n")), status: record.accessibility?.status ?? "absent",
        nodes: nodes.length, display: record.displayID });
    }
  }
  return output.sort((a, b) => a.t - b.t);
}
function main() {
  const args = process.argv.slice(2); const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith("--") || !args[i + 1] || !["--window", "--coast-db", "--own-store", "--output", "--own-executable"].includes(args[i]!)) throw new Error("invalid arguments");
    options.set(args[i]!, args[i + 1]!);
  }
  for (const required of ["--window", "--coast-db", "--own-store"]) if (!options.has(required)) throw new Error("missing argument");
  const window = JSON.parse(readFileSync(options.get("--window")!, "utf8"));
  const { start, end } = window;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 86400 || Date.now() / 1000 < end) throw new Error("window must be complete and no longer than one day");
  const own = loadOwn(options.get("--own-store")!, start, end, options.get("--own-executable") ?? join(homedir(), "Applications/Lifestream.app/Contents/MacOS/Lifestream"));
  const db = new DatabaseSync(options.get("--coast-db")!, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN");
    const coast = db.prepare(`SELECT f.timestamp, ax.root_hash,
      COALESCE(ax.bundle_id,a.bundle_id) AS bundle_id, ax.is_partial_tree, ax.extraction_mode
      FROM frame f LEFT JOIN ax_snapshot ax ON ax.frame_id=f.id
      LEFT JOIN segment s ON s.id=f.segment LEFT JOIN application a ON a.id=s.application
      WHERE f.timestamp>=? AND f.timestamp<? ORDER BY f.timestamp,f.id`).all(start * 1000, end * 1000) as CoastFrame[];
    const nodeStatement = db.prepare("SELECT payload FROM ax_node WHERE hash=?");
    let decoded = new Map<string, DecodedCoastAxNode>();
    const available = new Set(own.map((_, i) => i));
    const byApp = new Map<string, { agreement: number[]; coastCoverage: number[]; ownNodes: number[] }>();
    let temporal = 0, sameApp = 0, bothAX = 0, nonemptyBoth = 0, coastEmpty = 0, ownEmpty = 0, errors = 0, partialCoast = 0, partialOwn = 0, hiddenNodes = 0, nonfiniteGeometry = 0;
    const jaccard: number[] = [], coastCoverage: number[] = [], ownCoverage: number[] = [], coastNodeCounts: number[] = [], ownNodeCounts: number[] = [], offsets: number[] = [];
    for (const frame of coast) {
      const t = frame.timestamp / 1000;
      let nearest = -1, distance = 1.100000001;
      for (const index of available) {
        const current = Math.abs(own[index]!.t - t);
        if (current < distance) { nearest = index; distance = current; }
      }
      if (nearest < 0) continue;
      available.delete(nearest); temporal++;
      const ours = own[nearest]!;
      if (!frame.bundle_id || !ours.app || frame.bundle_id.toLowerCase() !== ours.app.toLowerCase()) continue;
      sameApp++;
      if (!(frame.root_hash instanceof Uint8Array) || !ours.ax) continue;
      bothAX++;
      try {
        if (decoded.size > 50000) decoded = new Map();
        const tree = assembleAxTree(Buffer.from(frame.root_hash).toString("hex"), nodeStatement, decoded, new Set(), () => { nonfiniteGeometry++; });
        const extracted = textFromTree(tree); const coastTokens = words(extracted.text);
        hiddenNodes += extracted.hidden;
        coastNodeCounts.push(extracted.nodes); ownNodeCounts.push(ours.nodes); offsets.push(distance);
        if (frame.is_partial_tree) partialCoast++;
        if (!ours.status.startsWith("complete")) partialOwn++;
        if (!coastTokens.size) coastEmpty++;
        if (!ours.tokens.size) ownEmpty++;
        if (coastTokens.size && ours.tokens.size) nonemptyBoth++;
        const common = [...coastTokens].filter(token => ours.tokens.has(token)).length;
        const union = coastTokens.size + ours.tokens.size - common;
        if (union) jaccard.push(common / union);
        const key = ours.app.toLowerCase();
        const group = byApp.get(key) ?? { agreement: [], coastCoverage: [], ownNodes: [] };
        if (union) group.agreement.push(common / union);
        if (coastTokens.size) group.coastCoverage.push(common / coastTokens.size);
        group.ownNodes.push(ours.nodes); byApp.set(key, group);
        if (coastTokens.size) coastCoverage.push(common / coastTokens.size);
        if (ours.tokens.size) ownCoverage.push(common / ours.tokens.size);
      } catch { errors++; }
    }
    const result = { window: { start, end }, measured_at: Date.now() / 1000,
      coast_frames: coast.length, own_frames: own.length, temporal_pairs: temporal, same_known_app_pairs: sameApp,
      paired_ax_snapshots: bothAX, decoded_pairs: bothAX - errors, decode_failures: errors, both_nonempty_ax_pairs: nonemptyBoth,
      coast_empty_ax_pairs: coastEmpty, own_empty_ax_pairs: ownEmpty, coast_partial_pairs: partialCoast, own_noncomplete_pairs: partialOwn,
      coast_hidden_nodes_in_pairs: hiddenNodes, nonfinite_geometry_in_decoded_nodes: nonfiniteGeometry,
      ax_token_jaccard_agreement: summary(jaccard), coast_ax_tokens_present_in_own: summary(coastCoverage),
      own_ax_tokens_present_in_coast: summary(ownCoverage), coast_nodes_per_pair: summary(coastNodeCounts), own_nodes_per_pair: summary(ownNodeCounts),
      frame_time_difference_seconds: summary(offsets),
      by_application: Object.fromEntries([...byApp].map(([key, value]) => [key, {
        agreement: summary(value.agreement), coast_tokens_present_in_own: summary(value.coastCoverage), own_nodes: summary(value.ownNodes)
      }])) ,
      limitations: ["Agreement is not accuracy; neither recorder is ground truth.",
        "Pairs are one-to-one nearest frame timestamps within 1.1 seconds, then filtered to the same known app; display/window equivalence is not established.",
        "Only title, description and value text is compared; roles and auxiliary attributes are excluded to avoid inflating overlap with structural vocabulary.",
        "Coast hidden nodes are included and counted; AX content is not proof of visible screen content.",
        "Text uses NFKC Unicode letter/number token sets; ordering and repeated words are not scored.",
        "Nonempty Coast text with empty own text contributes zero Coast coverage; both-empty pairs are excluded from Jaccard.",
        "Coast AX binary decoding, child traversal, hash verification and cycle rejection reuse the existing source reader."] };
    const serialized = JSON.stringify(result, null, 2) + "\n";
    if (options.has("--output")) writeFileSync(options.get("--output")!, serialized, { mode: 0o600 });
    else process.stdout.write(serialized);
    db.exec("ROLLBACK");
  } finally { db.close(); }
}
try { main(); } catch { process.stderr.write("AX comparison failed. Check arguments, completed window, and read access; no captured text was emitted.\n"); process.exitCode = 1; }
