import { describe, expect, it } from "vitest";
import type { ReaderOutput } from "@lifestreamprotocol/core";
import { artifact, collect, deliver, openTestHome } from "../test/drive.js";
import { deliveredLines, parseLine } from "./lanes.js";
import { lineText } from "./lines.js";
import { each } from "./refused.js";

describe("a delivered JSONL file with one bad line: each of these is impossible", () => {
  it("one line that is not UTF-8, or not one JSON object, stops the read or goes unnamed", async () => {
    const home = openTestHome("connect-lines-");
    const text = (body: string) => Buffer.from(body, "utf8");
    const file = Buffer.concat([
      text('{"n":1}\n'),
      Buffer.from([0x7b, 0x22, 0x6e, 0x22, 0x3a, 0xff, 0x7d, 0x0a]),
      text('{"n":3}\n'),
      text("[3.5]\n"),
      text('{"n":5}'),
    ]);
    const delivery = deliver(home, "input:local:macbook-pro-0001", { "events.jsonl": file }, {}, Date.UTC(2026, 9, 25));
    const derived: number[] = [];
    const rows = await collect(each(deliveredLines(home.blobs, delivery.files[0]!), ({ where }) => where, ({ bytes, line, where }): ReaderOutput[] => {
      const value = parseLine(lineText(bytes, where), where);
      derived.push(line);
      return [{ kind: "event", key: String(value.n), content: value }];
    }));
    const said = rows.map((row) => (row.refused === undefined ? `event ${row.key}` : `${row.key}: ${row.refused}`));
    expect(said).toEqual([
      "event 1",
      expect.stringMatching(/^events\.jsonl:2: events\.jsonl:2 is not UTF-8$/u),
      "event 3",
      expect.stringMatching(/^events\.jsonl:4: events\.jsonl:4 is not one JSON object/u),
      "event 5",
    ]);
    expect(derived).toEqual([1, 3, 5]);
    artifact(home.dir, "lines.json", said);
  });
});
