import type { ReaderOutput } from "@lifestreamprotocol/core";
import { describe, expect, it } from "vitest";
import { artifact, collect, temp } from "../test/drive.js";
import { csvRows } from "./csv.js";
import { each, Refused } from "./refused.js";


const chunked = (bytes: Buffer, size?: number): Buffer[] =>
  size === undefined ? [bytes] : Array.from({ length: Math.ceil(bytes.length / size) }, (_, at) => bytes.subarray(at * size, (at + 1) * size));

async function read(text: string | Buffer, size?: number, limits?: { bytes: number }): Promise<(Record<string, string> | string)[]> {
  const bytes = typeof text === "string" ? Buffer.from(text) : text;
  const out: (Record<string, string> | string)[] = [];
  try {
    for await (const row of csvRows(chunked(bytes, size), "export.csv", limits)) {
      try {
        out.push({ ...row.read() });
      } catch (error) {
        if (!(error instanceof Refused)) throw error;
        out.push(`${row.where} refused: ${error.message}`);
      }
    }
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    out.push(`file refused: ${error.message}`);
  }
  return out;
}

async function readBoth(text: string | Buffer, limits?: { bytes: number }): Promise<(Record<string, string> | string)[]> {
  const whole = await read(text, undefined, limits);
  expect(await read(text, 1, limits), `${String(text)} in one-byte chunks`).toEqual(whole);
  return whole;
}

describe("csvRows: each of these is impossible", () => {
  it("a quoted line break splits its row, a doubled quote reads as two, a doubled header names its last column", async () => {
    const dir = temp();
    const text = 'Name,Note,Distance,Distance\r\nfilm,"two\nlines, and a comma",12,12000\r\n"say ""hi""","line\r\nbreak",3,3000\r\n';
    const rows = await readBoth(text);
    expect(rows).toEqual([
      { Name: "film", Note: "two\nlines, and a comma", Distance: "12000" },
      { Name: 'say "hi"', Note: "line\r\nbreak", Distance: "3000" },
    ]);
    artifact(dir, "quoted.json", { text, rows });
  });

  it("a row is ended wrongly: a trailing break makes a row, a blank line is a row, CR, LF and CRLF read differently, a mark stays on the first name", async () => {
    const dir = temp();
    const outcomes: Record<string, unknown> = {};
    for (const text of ["a,b\n1,2\n", "a,b\r\n1,2\r\n", "a,b\r1,2\r", "a,b\n1,2", "﻿a,b\n1,2\n", "a,b\n\n1,2\n\r\n\n"]) {
      const rows = await readBoth(text);
      expect(rows, JSON.stringify(text)).toEqual([{ a: "1", b: "2" }]);
      outcomes[JSON.stringify(text)] = rows;
    }
    expect(await readBoth("")).toEqual([]);
    expect(await readBoth("a,b\r\n")).toEqual([]);
    expect(await readBoth('a,b,c\n1,,\n"",x,""\n')).toEqual([{ a: "1", b: "", c: "" }, { a: "", b: "x", c: "" }]);
    expect(await readBoth('size,name\n12" vinyl, a b \n')).toEqual([{ size: '12" vinyl', name: " a b " }]);
    expect(await readBoth("名前,città\né,ü\n")).toEqual([{ 名前: "é", città: "ü" }]);
    artifact(dir, "breaks.json", outcomes);
  });

  it("a malformed row refuses the rows after it, or a refusal names the wrong row", async () => {
    const dir = temp();
    const text = Buffer.concat([
      Buffer.from('a,b\n1,"two\nlines"\n2\n3,4,5\n\n"6"x,7\n8,'),
      Buffer.from([0xff, 0xfe]),
      Buffer.from("\n9,10\n"),
    ]);
    const rows = await readBoth(text);
    expect(rows).toEqual([
      { a: "1", b: "two\nlines" },
      "export.csv row 3 refused: export.csv row 3 has 1 field; its header has 2",
      "export.csv row 4 refused: export.csv row 4 has 3 fields; its header has 2",
      "export.csv row 6 refused: export.csv row 6: field 1 has bytes after its closing quote",
      "export.csv row 7 refused: export.csv row 7 is not UTF-8",
      { a: "9", b: "10" },
    ]);
    const read = await collect(each(csvRows([text], "export.csv"), (row) => row.where, (row): ReaderOutput[] => {
      const fields = row.read();
      return [{ kind: "row", key: fields.a ?? "", content: fields }];
    }));
    expect(read.map((row) => (row.refused === undefined ? row.key : `${row.key} refused`))).toEqual([
      "1", "export.csv row 3 refused", "export.csv row 4 refused", "export.csv row 6 refused", "export.csv row 7 refused", "9",
    ]);
    artifact(dir, "malformed.json", rows);
  });

  it("a quote never closed, or a header that does not read, is read as rows", async () => {
    const dir = temp();
    const outcomes: Record<string, unknown> = {};
    const cases: [string | Buffer, (Record<string, string> | string)[]][] = [
      ['a,b\n1,2\n3,"open\n4,5\n', [{ a: "1", b: "2" }, "file refused: export.csv: row 3 opens a quoted field that never closes, after 1 row"]],
      ['a,"b\n', ["file refused: export.csv: row 1 opens a quoted field that never closes, after 0 rows"]],
      ['a,"b"c\n1,2\n', ["file refused: export.csv: the header, row 1: field 2 has bytes after its closing quote"]],
      [Buffer.concat([Buffer.from("a,"), Buffer.from([0xc3]), Buffer.from("\n1,2\n")]), ["file refused: export.csv: the header, row 1 is not UTF-8"]],
    ];
    for (const [text, expected] of cases) {
      const rows = await readBoth(text);
      expect(rows).toEqual(expected);
      outcomes[String(text)] = rows;
    }
    artifact(dir, "unread.json", outcomes);
  });

  it("a row past the byte limit is held, ends the file, or moves the rows after it", async () => {
    const dir = temp();
    const limits = { bytes: 16 };
    const text = `a,b\n1,2\n${"x".repeat(20)},"${"y\n".repeat(10)}"\n3,4\n`;
    const rows = await readBoth(text, limits);
    expect(rows).toEqual([
      { a: "1", b: "2" },
      "export.csv row 3 refused: export.csv row 3 holds more than the 16 bytes one row is read in",
      { a: "3", b: "4" },
    ]);
    expect(await readBoth(`${"h".repeat(20)}\n1\n`, limits)).toEqual(["file refused: export.csv: the header, row 1 holds more than the 16 bytes one row is read in"]);
    artifact(dir, "limits.json", rows);
  });

  it("a row's separators and quotes escape the byte limit, its fields past the header's width are kept, or a header has no width bound", async () => {
    const limits = { bytes: 16 };
    const header = "a,b,c,d,e,f,g,h";
    expect(await readBoth(`${header}\n${Array(8).fill("xx").join(",")}\n${Array(8).fill('""').join(",")}\n,,,,,,,\n`, limits)).toEqual([
      "export.csv row 2 refused: export.csv row 2 holds more than the 16 bytes one row is read in",
      "export.csv row 3 refused: export.csv row 3 holds more than the 16 bytes one row is read in",
      Object.fromEntries([..."abcdefgh"].map((name) => [name, ""])),
    ]);
    expect(await readBoth(`a,b\n${"x".repeat(7)},${"y".repeat(8)}\r\n`, limits)).toEqual([{ a: "x".repeat(7), b: "y".repeat(8) }]);
    expect(await readBoth(`a,b\n${"1,".repeat(999)}1\n3,4\n`)).toEqual([
      "export.csv row 2 refused: export.csv row 2 has 1000 fields; its header has 2",
      { a: "3", b: "4" },
    ]);
    expect(await read(`${"h,".repeat(16_384)}h\n1\n`)).toEqual(["file refused: export.csv: the header, row 1 has more than the 16384 columns a header is read in"]);
    expect(await read(`${"h,".repeat(16_383)}h\n`)).toEqual([]);
  });
});
