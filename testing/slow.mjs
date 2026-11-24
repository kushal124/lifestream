import { relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { spec, tap } from "node:test/reporters";

const OVER = 15;

export default async function* slow(source) {
  const files = [];
  async function* seen() {
    for await (const event of source) {
      const { name, file, nesting, details } = event.data ?? {};
      if (event.type === "test:complete" && nesting === 0 && file !== undefined && resolve(name) === file) {
        files.push({ file: relative(process.cwd(), name), s: details.duration_ms / 1_000 });
      }
      yield event;
    }
  }
  yield* process.stdout.isTTY ? Readable.from(seen()).pipe(new spec()) : tap(seen());
  files.sort((a, b) => b.s - a.s);
  const shown = (some) => some.map((each) => `${each.file} ${each.s.toFixed(1)} s`).join(", ");
  if (files.length > 0) yield `\n Slowest files  ${shown(files.slice(0, 5))}\n`;
  const over = files.filter((each) => each.s > OVER);
  if (over.length > 0) yield ` Warning: over ${OVER} s in this run, where three files run at once  ${shown(over)}: check each one's time alone (npm test -- test/<file>) before shrinking a test of it\n`;
}
