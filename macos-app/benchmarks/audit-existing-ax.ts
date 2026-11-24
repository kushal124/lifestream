import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { assembleAxTree } from "../../sources/screen/coast-reader.js";
import type { DecodedCoastAxNode } from "../../sources/screen/coast-ax.js";

const input = JSON.parse(readFileSync(0, "utf8"));
const db = new DatabaseSync(input.database, { readOnly: true });
db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=10000; BEGIN");
const frames = db.prepare("SELECT ax.root_hash, f.foreground FROM frame f LEFT JOIN ax_snapshot ax ON ax.frame_id=f.id WHERE f.id=?");
const lookup = db.prepare("SELECT payload FROM ax_node WHERE hash=?");
let cache = new Map<string, DecodedCoastAxNode>();
const tokens = (s: string) => new Set(s.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []);
const join = (a: Set<string>, b: Set<string>) => new Set([...a, ...b]);
const coverage = (a: Set<string>, b: Set<string>) => a.size ? [...a].filter(x => b.has(x)).length/a.size : null;
const results: unknown[] = [];
for (const sample of input.samples) {
  try {
    if (cache.size > 50000) cache = new Map();
    const f = frames.get(sample.id) as {root_hash: Uint8Array | null; foreground: string | null};
    const parts: string[] = []; let nodes = 0, hidden = 0;
    if (f.root_hash) {
      const tree = assembleAxTree(Buffer.from(f.root_hash).toString("hex"), lookup, cache, new Set(), () => {});
      const stack = [tree];
      while (stack.length) {
        const branch = stack.pop()!; nodes++; if (branch.node.visible === false) hidden++;
        for (const text of [branch.node.title, branch.node.description, branch.node.value]) if (typeof text === "string") parts.push(text);
        stack.push(...branch.children);
      }
    }
    const ca=tokens(parts.join("\n")), co=tokens(f.foreground ?? ""), oa=tokens(sample.ax), oo=tokens(sample.ocr);
    results.push({id:sample.id,app:sample.app,own_status:sample.status,coast_nodes:nodes,coast_hidden:hidden,
      coast_ax_words:ca.size,own_ax_words:oa.size,coast_ax_in_own_ax:coverage(ca,oa),
      coast_ax_in_own_union:coverage(ca,join(oa,oo)),own_ax_in_coast_union:coverage(oa,join(ca,co)),
      coast_union_in_own_union:coverage(join(ca,co),join(oa,oo)),
      coast_ocr_in_own_union:coverage(co,join(oa,oo)),own_ocr_in_coast_union:coverage(oo,join(ca,co))});
  } catch { results.push({id:sample.id,app:sample.app,error:"AX decode failed"}); }
}
db.exec("ROLLBACK"); db.close();
process.stdout.write(JSON.stringify(results));
