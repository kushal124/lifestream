import { describe, expect, it } from "vitest";
import { artifact, collect, temp } from "../test/drive.js";
import type { ReaderOutput } from "@lifestreamprotocol/core";
import { jsonAt, jsonElements, readJson, utf8 } from "./json.js";
import { each, refuse, Refused } from "./refused.js";

const read = async (text: string, size?: number): Promise<string[]> => {
  const bytes = Buffer.from(text);
  const chunks = size === undefined ? [bytes] : Array.from({ length: Math.ceil(bytes.length / size) }, (_, at) => bytes.subarray(at * size, (at + 1) * size));
  return (await collect(jsonElements(chunks, "synthetic.json"))).map((element) => element.read().toString("utf8"));
};

describe("the JSON array scanner: each of these is impossible", () => {
  it("a malformed array is read as elements: a missing comma, a leading or trailing comma, an empty element", async () => {
    const dir = temp();
    const outcomes: Record<string, string> = {};
    for (const text of ["[{}{}]", "[,{}]", "[{},]", "[{},,{}]", "[1 2]", "[{}", "{}", "[{}] x"]) {
      for (const size of [undefined, 1]) {
        const outcome = await read(text, size).then((elements) => `read ${JSON.stringify(elements)}`, (error: unknown) => (error instanceof Refused ? "refused" : String(error)));
        expect(outcome, `${text} in chunks of ${size ?? "all"}`).toBe("refused");
        outcomes[`${text} ${size ?? "whole"}`] = outcome;
      }
    }
    for (const [text, elements] of [["[]", []], [" [ ] ", []], ['[{"a":[1,{"b":"]"}]}, 2 ,"x,y"]', ['{"a":[1,{"b":"]"}]}', "2", '"x,y"']]] as const) {
      for (const size of [undefined, 1]) expect(await read(text, size)).toEqual(elements);
    }
    artifact(dir, "scanner.json", outcomes);
  });

  it("one element that does not parse refuses the file, or a break in the array loses the elements before it", async () => {
    const dir = temp();
    const read = (files: Record<string, string>): Promise<ReaderOutput[]> =>
      collect(each(Object.entries(files), ([name]) => name, ([name, text]) =>
        each(jsonElements([Buffer.from(text)], name), (_, index) => `${name}[${index}]`, (element): ReaderOutput[] => {
          const value = readJson(utf8(element.read(), name), name);
          return [{ kind: "element", key: JSON.stringify(value), content: value }];
        })));
    const said = (rows: ReaderOutput[]) => rows.map((row) => (row.refused === undefined ? row.key : `${row.key} refused`));
    const rows = await read({
      "malformed.json": '[{"n":1}, {"n":2}, {"n": }, {"n":4}]',
      "broken.json": '[{"n":5}, {"n":6} {"n":7}]',
      "whole.json": '[{"n":8}]',
    });
    expect(said(rows)).toEqual(['{"n":1}', '{"n":2}', "malformed.json[2] refused", '{"n":4}', '{"n":5}', '{"n":6}', "broken.json refused", '{"n":8}']);
    expect(rows.find((row) => row.key === "broken.json")?.refused).toMatch(/broken\.json: two elements with no comma between them in broken\.json, after 2 values/u);
    const named = await read({ "Family:one.json": '[{"n": }, {"n": }]', "Family:two.json": '[{"n": }]', "Calendar [work].json": '[{"n":1} {"n":2}]' });
    const members = named.filter((row) => row.refused !== undefined).map((row) => `${row.key} in ${row.member}`);
    expect(members).toEqual([
      "Family:one.json[0] in Family:one.json", "Family:one.json[1] in Family:one.json", "Family:two.json[0] in Family:two.json", "Calendar [work].json in Calendar [work].json",
    ]);
    expect(rows.filter((row) => row.refused === undefined).map((row) => row.member)).toEqual(Array.from({ length: 6 }, () => undefined));
    const folders: [string, Record<string, string> | null][] = [["Takeout/My Activity/YouTube", { "a.zip/Takeout/My Activity/YouTube/MyActivity.json": '[{"n":1}, {"n": }]' }], ["Takeout/My Activity/Maps", null]];
    const grouped = await collect(each(folders, ([folder]) => folder, ([folder, files]) => {
      if (files === null) refuse(`${folder} was exported as HTML`);
      return each(Object.entries(files), ([name]) => name, ([name, text]) =>
        each(jsonElements([Buffer.from(text)], name), (_, index) => `${name}[${index}]`, (element): ReaderOutput[] => [{ kind: "element", key: name, content: readJson(utf8(element.read(), name), name) }]));
    }, { group: true }));
    const inGroups = grouped.filter((row) => row.refused !== undefined).map((row) => `${row.key} in ${row.member}`);
    expect(inGroups).toEqual([
      "a.zip/Takeout/My Activity/YouTube/MyActivity.json[1] in a.zip/Takeout/My Activity/YouTube/MyActivity.json", "Takeout/My Activity/Maps in Takeout/My Activity/Maps",
    ]);
    artifact(dir, "elements.json", { rows: said(rows), members, inGroups });
  });

  it("an element past the byte or depth limit is held, ends the file, or moves the elements after it to another index", async () => {
    const dir = temp();
    const limits = { bytes: 24, depth: 3 };
    const text = `[{"n":1}, {"n":"${"x".repeat(40)}"}, "${"y".repeat(30)}", [[[["deep"]]]], [[["level 3"]]], {"n":6}]`;
    const outcomes: Record<string, string[]> = {};
    for (const size of [undefined, 1, 7]) {
      const bytes = Buffer.from(text);
      const chunks = size === undefined ? [bytes] : Array.from({ length: Math.ceil(bytes.length / size) }, (_, at) => bytes.subarray(at * size, (at + 1) * size));
      const rows = await collect(each(jsonElements(chunks, "synthetic", limits), (part) => part.where, (part): ReaderOutput[] =>
        [{ kind: "element", key: part.where, content: readJson(utf8(part.read(), part.where), part.where) }]));
      const said = rows.map((row) => (row.refused === undefined ? `${row.key} ${JSON.stringify(row.content)}` : `${row.key} refused: ${row.refused}`));
      expect(said, `chunks of ${size ?? "all"}`).toEqual([
        'synthetic[0] {"n":1}',
        "synthetic[1] refused: synthetic[1] holds more than the 24 bytes one value is read in",
        "synthetic[2] refused: synthetic[2] holds more than the 24 bytes one value is read in",
        "synthetic[3] refused: synthetic[3] nests deeper than the 3 levels one value is read in",
        'synthetic[4] [[["level 3"]]]',
        'synthetic[5] {"n":6}',
      ]);
      outcomes[String(size ?? "whole")] = said;
    }
    const plain = await collect(jsonElements([Buffer.from('[[[[[1]]]], 2]')], "synthetic.json", limits));
    expect(plain.map((part) => {
      try {
        return part.read().toString("utf8");
      } catch (error) {
        return error instanceof Refused ? `refused: ${error.message}` : "threw";
      }
    })).toEqual(["refused: synthetic.json[0] nests deeper than the 3 levels one value is read in", "2"]);
    artifact(dir, "limits.json", outcomes);
  });
});

const chunked = (text: string): (Buffer[])[] => [undefined, 1, 7].map((size) => {
  const bytes = Buffer.from(text);
  return size === undefined ? [bytes] : Array.from({ length: Math.ceil(bytes.length / size) }, (_, at) => bytes.subarray(at * size, (at + 1) * size));
});

const at = async (chunks: Buffer[], paths: string[], limits?: { bytes: number; depth: number }): Promise<string[]> =>
  (await collect(jsonAt(chunks, "result.json", paths, limits))).map((part) => {
    try {
      return `${part.where} ${part.path}: ${part.read().toString("utf8")}`;
    } catch (error) {
      return error instanceof Refused ? `${part.where} refused: ${error.message}` : "threw";
    }
  });

const RESULT = JSON.stringify({
  about: "Here is the data you requested. \"] } [ {",
  personal_information: { user_id: 1000000001, first_name: "Person A" },
  frequent_contacts: { list: [{ id: 7, name: "]]]}}}" }] },
  chats: {
    about: "chats",
    list: [
      { name: "Person B", type: "personal_chat", id: 1000000002, messages: [{ id: 1, text: "hi, [there]" }, { id: 2, text: "{\"quoted\"}" }] },
      { name: "Group C", type: "private_group", id: 3, messages: [] },
      { name: "Person D", type: "personal_chat", id: 1000000004, messages: [{ id: 5, text: "x" }] },
    ],
  },
});
const PATHS = ["personal_information", "chats.list[*].id", "chats.list[*].name", "chats.list[*].messages[*]"];

describe("values at paths deep in one file (jsonAt): each of these is impossible", () => {
  it("a value at a path missed, read out of the file's order, or a value off every path handed back", async () => {
    const dir = temp();
    const want = [
      'result.json personal_information personal_information: {"user_id":1000000001,"first_name":"Person A"}',
      'result.json chats.list[0].name chats.list[*].name: "Person B"',
      "result.json chats.list[0].id chats.list[*].id: 1000000002",
      'result.json chats.list[0].messages[0] chats.list[*].messages[*]: {"id":1,"text":"hi, [there]"}',
      'result.json chats.list[0].messages[1] chats.list[*].messages[*]: {"id":2,"text":"{\\"quoted\\"}"}',
      'result.json chats.list[1].name chats.list[*].name: "Group C"',
      "result.json chats.list[1].id chats.list[*].id: 3",
      'result.json chats.list[2].name chats.list[*].name: "Person D"',
      "result.json chats.list[2].id chats.list[*].id: 1000000004",
      'result.json chats.list[2].messages[0] chats.list[*].messages[*]: {"id":5,"text":"x"}',
    ];
    for (const chunks of chunked(RESULT)) expect(await at(chunks, PATHS)).toEqual(want);
    const parts = await collect(jsonAt([Buffer.from('{"ch\\u0061ts": {"list": [{"messages": [true, null, "a,b"]}]}}')], "r.json", ["chats.list[*].messages[*]"]));
    expect(parts.map((part) => [part.at, part.read().toString("utf8")])).toEqual([
      [["chats", "list", 0, "messages", 0], "true"], [["chats", "list", 0, "messages", 1], "null"], [["chats", "list", 0, "messages", 2], '"a,b"'],
    ]);
    expect(await at([Buffer.from('[{"id": 1, "x": [1]}, {"id": 2}]')], ["[*].id", "[*].missing"])).toEqual(["result.json[0].id [*].id: 1", "result.json[1].id [*].id: 2"]);
    artifact(dir, "json-at.json", want);
  });

  it("a value at a path past the limits held, or ending the file; a value off every path kept at all", async () => {
    const text = JSON.stringify({ skipped: "y".repeat(10_000), chats: { list: [{ messages: [{ id: 1 }, { id: 2, text: "x".repeat(200) }, [[[[[3]]]]], { id: 4 }] }] } });
    for (const chunks of chunked(text)) {
      expect(await at(chunks, ["chats.list[*].messages[*]"], { bytes: 64, depth: 3 })).toEqual([
        'result.json chats.list[0].messages[0] chats.list[*].messages[*]: {"id":1}',
        "result.json chats.list[0].messages[1] refused: result.json chats.list[0].messages[1] holds more than the 64 bytes one value is read in",
        "result.json chats.list[0].messages[2] refused: result.json chats.list[0].messages[2] nests deeper than the 3 levels one value is read in",
        'result.json chats.list[0].messages[3] chats.list[*].messages[*]: {"id":4}',
      ]);
    }
  });

  it("a value its path steps into that is no array or object read as one, or refusing the file", async () => {
    const text = '{"chats": {"list": [{"messages": null}, {"messages": {"id": 1}}, {"messages": [{"id": 2}]}]}}';
    for (const chunks of chunked(text)) {
      expect(await at(chunks, ["chats.list[*].messages[*]"])).toEqual([
        "result.json chats.list[0].messages refused: result.json chats.list[0].messages is no array, as chats.list[*].messages[*] steps into",
        "result.json chats.list[1].messages refused: result.json chats.list[1].messages is no array, as chats.list[*].messages[*] steps into",
        'result.json chats.list[2].messages[0] chats.list[*].messages[*]: {"id": 2}',
      ]);
    }
  });

  it("a break on the way to a path read past, or losing the values before it", async () => {
    for (const [text, why] of [
      ['{"chats": {"list": [{"messages": [{"id": 1}]} {"messages": []}]}}', "two elements with no comma between them in result.json chats.list, after 1 value"],
      ['{"chats": {"list": [{"messages": [{"id": 1}]}]} "more": 1}', "two members with no comma between them in result.json, after 1 value"],
      ['{"chats" {"list": []}}', "a member name with no colon after it in result.json, after 0 values"],
      ['{"chats": {"list": [{"messages": [{"id": 1}],}]}}', "a member owed in result.json chats.list[0], after 1 value"],
      ['{"chats": {"list": [{"messages": [{"id": 1},]}]}}', "a ] where a value is owed, after 1 value"],
      ['{"chats": {"list": [{"messages": [{"id": 1', "the top-level object is not closed, after 0 values"],
      ['{"chats": {"list": [{"messages": [{"id": 1}', "the top-level object is not closed, after 1 value"],
      ['{"chats": {"list": [{"messages": [{"id": 1}]}]}} {}', "bytes follow the top-level value, after 1 value"],
      ["", "the file holds no JSON, after 0 values"],
      ["[]", "the top-level value is no object, as chats.list[*].messages[*] steps into, after 0 values"],
      ['{"chats": {"list": [{"messages": [{"id": 1}]}], "list": [{"messages": [{"id": 2}]}]}}', 'a member named "list" twice in result.json chats, after 1 value'],
      ['{"chats": {"list": [{"messages": [{"id": 1}]}]}, "ch\\u0061ts": 1}', 'a member named "chats" twice in result.json, after 1 value'],
      ['{"caf\u00e9": 1, "cafe\u0301": 2, "chats": {}}', `a member named ${JSON.stringify("cafe\u0301")} twice in result.json, after 0 values`],
      ['{"chats": {"list": [{"messages": [{"id": 1}], "id": 1, "id": 2}]}}', 'a member named "id" twice in result.json chats.list[0], after 1 value'],
      ['{"\\ud800": 1, "chats": {}}', "a member name that does not read in result.json, after 0 values"],
    ] as const) {
      for (const chunks of chunked(text)) {
        const parts: string[] = [];
        const error = await (async () => {
          for await (const part of jsonAt(chunks, "result.json", ["chats.list[*].messages[*]"])) parts.push(part.read().toString("utf8"));
        })().then(() => undefined, (thrown: unknown) => thrown);
        expect(error, text).toBeInstanceOf(Refused);
        expect((error as Error).message, text).toBe(`result.json: ${why}`);
        expect(parts.length, text).toBe(Number(/after (\d+)/u.exec(why)![1]));
      }
    }
  });

  it("a path that holds another, or is no path, read as anything but the code's fault", async () => {
    for (const [paths, why] of [
      [["chats.list[*]", "chats.list[*].messages[*]"], 'jsonAt: "chats.list[*]" holds "chats.list[*].messages[*]"'],
      [["a", "a"], 'jsonAt: "a" holds "a"'],
      [["chats..list"], "is no path"], [["chats.list[0]"], "is no path"], [[""], "is no path"], [["a.[*]"], "is no path"],
    ] as const) {
      const error = await collect(jsonAt([Buffer.from("{}")], "r.json", paths)).then(() => undefined, (thrown: unknown) => thrown as Error);
      expect(error, paths.join(" ")).not.toBeInstanceOf(Refused);
      expect(error?.message, paths.join(" ")).toContain(why);
    }
  });
});
