import type { AnswerType, Json, JsonObject, Prompt } from "@lifestreamprotocol/core";
import { describe, expect, it } from "vitest";
import { bare, check, compatible, faults, fit, parse, read, readAnswer } from "./answer-types.js";

const string = (more: JsonObject = {}): JsonObject => ({ type: "string", ...more });
const object = (properties: Record<string, JsonObject>, more: JsonObject = {}): JsonObject =>
  ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false, ...more });
const nullable = (node: JsonObject): JsonObject => ({ ...node, type: [node.type as string, "null"] });

const TAG = object({
  kind: string({ enum: ["receipt", "notice"], description: "what the mail is" }),
  amount: nullable({ type: "number" }),
  lines: { type: "array", items: object({ what: string(), count: { type: "integer" } }) },
});

describe("answer types", () => {
  it("parses what readers accept today: text as it stands, the first JSON object fenced or among prose", () => {
    expect(parse("text", "  A synthetic caption.\n")).toEqual({ value: "  A synthetic caption.\n" });
    expect(parse(TAG, '{"kind":"receipt"}')).toEqual({ value: { kind: "receipt" } });
    expect(parse(TAG, '```json\n{"kind":"notice","amount":2}\n```\nThat is all.')).toEqual({ value: { kind: "notice", amount: 2 } });
    expect(parse(TAG, 'Here it is: {"kind":"receipt","note":"a } in a string"} and {"kind":"other"}')).toEqual({ value: { kind: "receipt", note: "a } in a string" } });
    const own = { kind: "receipt", note: "fix this ```py\nx = 1\n``` please" };
    expect(parse(TAG, JSON.stringify(own))).toEqual({ value: own });
    expect(parse(TAG, `\`\`\`json\n${JSON.stringify(own)}\n\`\`\``)).toEqual({ value: own });
    expect(parse(TAG, 'The {kind} you asked for:\n```json\n{"kind":"notice"}\n```')).toEqual({ value: { kind: "notice" } });
    expect(parse(TAG, "I cannot tag this mail.")).toEqual({ violations: ["the answer holds no JSON object"] });
    expect(parse(TAG, '{"kind": "receipt",')).toMatchObject({ violations: [expect.stringMatching(/^the answer is not JSON: /u)] });
  });

  it("fits an answer: a member the type does not name is dropped, a nullable member it lacks reads null, at every depth", () => {
    const value = { kind: "receipt", extra: true, lines: [{ what: "a synthetic item", count: 2, unit: "box" }] };
    expect(fit(TAG, value)).toEqual({ kind: "receipt", amount: null, lines: [{ what: "a synthetic item", count: 2 }] });
    expect(fit(TAG, { amount: 3 })).toEqual({ amount: 3 });
    expect(fit("text", "as it stands")).toBe("as it stands");
    expect(read(TAG, '{"kind":"notice","lines":[],"model_note":"dropped"}')).toEqual({ value: { kind: "notice", amount: null, lines: [] } });
  });

  it("checks an answer against its type and says where each violation is", () => {
    expect(check(TAG, { kind: "receipt", amount: null, lines: [{ what: "x", count: 1 }] })).toEqual([]);
    expect(check(TAG, { kind: "invoice", amount: "12", lines: [{ what: 3, count: 1.5 }] })).toEqual([
      '"kind" must be one of receipt, notice, not "invoice"',
      '"amount" must be a number',
      '"lines[0].what" must be a string',
      '"lines[0].count" must be an integer',
    ]);
    expect(check(TAG, { amount: 1, lines: null })).toEqual(['"kind" is missing', '"lines" must be an array, not null']);
    expect(check(TAG, ["not", "an", "object"])).toEqual(["the answer must be an object"]);
    expect(check("text", { not: "text" })).toEqual(["the answer must be text"]);
  });

  it("refuses a type outside the subset", () => {
    expect(faults("text")).toEqual([]);
    expect(faults(TAG)).toEqual([]);
    expect(faults(nullable(TAG))).toEqual(["the answer type is `text` or a JSON Schema whose root is an object"]);
    expect(faults(object({ start: string({ pattern: "^\\d\\d$" }) }))).toEqual(['"start": "pattern" is not in the subset; a reader\'s rule says it']);
    expect(faults({ type: "object", properties: { a: string(), b: string() }, required: ["a"], additionalProperties: false })).toEqual(["the answer: an object requires every property"]);
    expect(faults({ type: "object", properties: { a: string() }, required: ["a"] })).toEqual(["the answer: an object states additionalProperties false"]);
    expect(faults(object({ map: { type: "object", additionalProperties: { type: "string" } } }))).toEqual(['"map": an object states its properties']);
    expect(faults(object({ any: { type: ["string", "number"] } }))).toEqual(['"any": type is one of object, array, string, number, integer, boolean, or one of them and "null"']);
    expect(faults(object({ state: { type: ["string", "null"], enum: ["on", "off", null] } }))).toEqual([]);
    expect(faults(object({ state: { type: ["string", "null"], enum: ["on", "off"] } }))).toEqual(['"state": a nullable enum lists null once, and only a nullable one does']);
    expect(faults(object({ state: { type: "number", enum: [1, 2] } }))).toEqual(['"state": "enum" is not in the subset; a reader\'s rule says it']);
  });

  it("calls a type compatible only when it widens, and says why each other change is a new version", () => {
    const widened: [string, AnswerType, AnswerType][] = [
      ["a nullable member added", TAG, { ...TAG, properties: { ...(TAG.properties as JsonObject), note: nullable(string()) }, required: [...(TAG.required as string[]), "note"] }],
      ["an enum gained values", TAG, object({ ...(TAG.properties as Record<string, JsonObject>), kind: string({ enum: ["receipt", "notice", "invite"] }) })],
      ["a member became nullable", TAG, object({ ...(TAG.properties as Record<string, JsonObject>), kind: nullable(string({ enum: ["receipt", "notice", null] })) })],
      ["an integer became a number", TAG, object({ ...(TAG.properties as Record<string, JsonObject>), lines: { type: "array", items: object({ what: string(), count: { type: "number" } }) } })],
      ["a description changed", TAG, object({ ...(TAG.properties as Record<string, JsonObject>), kind: string({ enum: ["receipt", "notice"], description: "another word" }) })],
      ["text stayed text", "text", "text"],
    ];
    for (const [what, old, next] of widened) expect(compatible(old, next), what).toEqual([]);

    const props = TAG.properties as Record<string, JsonObject>;
    const { amount: _amount, ...withoutAmount } = props;
    const refused: [string, AnswerType, AnswerType, string[]][] = [
      ["a member removed", TAG, object(withoutAmount), ['"amount" was removed']],
      ["a member renamed", TAG, object({ ...withoutAmount, total: nullable({ type: "number" }) }), ['"amount" was removed']],
      ["a member retyped", TAG, object({ ...props, amount: nullable(string()) }), ['"amount" was a number and is a string']],
      ["a member added, not nullable", TAG, object({ ...props, note: string() }), ['"note" was added, and is not nullable']],
      ["a member made required", TAG, object({ ...props, amount: { type: "number" } }), ['"amount" is no longer nullable']],
      ["an enum narrowed", TAG, object({ ...props, kind: string({ enum: ["receipt"] }) }), ['"kind"\'s enum lost notice']],
      ["a string became an enum", object({ kind: string() }), object({ kind: string({ enum: ["receipt"] }) }), ['"kind" became an enum']],
      ["a number became an integer", object({ n: { type: "number" } }), object({ n: { type: "integer" } }), ['"n" was a number and is an integer']],
      ["an item retyped", TAG, object({ ...props, lines: { type: "array", items: string() } }), ['"lines[]" was an object and is a string']],
      ["text to an object", "text", TAG, ["`text` became an object"]],
      ["an object to text", TAG, "text", ["an object became `text`"]],
    ];
    for (const [what, old, next, why] of refused) expect(compatible(old, next), what).toEqual(why);

    const removed = object(withoutAmount);
    const back = object({ ...withoutAmount, amount: nullable(string()) });
    expect(compatible(TAG, removed)).not.toEqual([]);
    expect(compatible(removed, back)).toEqual([]);
    expect(compatible(TAG, back)).toEqual(['"amount" was a number and is a string']);
    expect(compatible(TAG, object({ ...props, kind: string({ pattern: "x" }) }))).toEqual(['the new type: "kind": "pattern" is not in the subset; a reader\'s rule says it']);
  });

  it("leaves out every description and nothing else, a member named description included", () => {
    const faced = object({ caption: string({ description: "the caption" }), faces: { type: "array", description: "who is in it", items: object({ description: string({ description: "where the face is" }) }) } });
    expect(bare(faced)).toEqual(object({ caption: string(), faces: { type: "array", items: object({ description: string() }) } }));
    expect(bare(TAG)).toEqual(object({ ...(TAG.properties as Record<string, JsonObject>), kind: string({ enum: ["receipt", "notice"] }) }));
    expect(bare("text")).toBe("text");
  });

  it("a version is stated without what it keeps", () => {
    // @ts-expect-error a version states the older versions it keeps, none included: there is no default
    const bumped: Prompt = { version: 2, type: "text", text: "Caption this synthetic photo." };
    const stated: Prompt = { ...bumped, keeps: [] };
    expect(stated.keeps).toEqual([]);
  });

  it("reads a kept version's answer as its own type, through its converter, then as the current type; a bad conversion is no answer", () => {
    const caption = (converter?: (answer: Json) => Json): Prompt => ({
      version: 10,
      type: object({ caption: string(), faces: { type: "array", items: object({ placeholder: string(), description: string() }) } }),
      keeps: [{ version: 9, type: "text" }, { version: 8, type: object({ caption: string() }) }],
      text: "Caption this synthetic photo.",
      ...(converter === undefined ? {} : { converters: { 9: converter } }),
    });
    const good = caption((answer) => ({ caption: answer, faces: [] }));
    expect(readAnswer(good, 10, '{"caption":"a synthetic room","faces":[{"placeholder":"[[Person 1]]","description":"at the door"}]}'))
      .toEqual({ value: { caption: "a synthetic room", faces: [{ placeholder: "[[Person 1]]", description: "at the door" }] } });
    expect(readAnswer(good, 9, "A synthetic room.")).toEqual({ value: { caption: "A synthetic room.", faces: [] } });
    expect(readAnswer(good, 8, '{"caption":"a synthetic room"}')).toEqual({ violations: ['"faces" is missing'] });
    expect(readAnswer(caption((answer) => ({ caption: answer })), 9, "A synthetic room.")).toEqual({ violations: ['"faces" is missing'] });
    expect(readAnswer(caption(() => { throw new Error("synthetic"); }), 9, "x")).toEqual({ violations: ["version 9's converter failed: synthetic"] });
    expect(readAnswer(good, 7, "x")).toEqual({ violations: ["version 7 is not kept by version 10"] });
  });
});
