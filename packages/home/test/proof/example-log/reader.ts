import { each, instantOf, isObject, parseLine, refuse, utf8, type Guard, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";

export const ENTRY = "entry";
const FILE = "entries.ndjson";

const entry: Guard = (content) =>
  isObject(content) && content.type === "example-log.entry" && typeof content.id === "string" && typeof content.text === "string" ? [] : ["an entry is { type: example-log.entry, id, text, … }"];

export const exampleLog: Reader = {
  name: "example-log",
  kinds: { [ENTRY]: entry },
  async *read(delivery, files) {
    const file = delivery.files.find((each) => each.path === FILE) ?? refuse(`the delivery carries no ${FILE}`);
    const lines = utf8(files.bytes(file.blob), FILE).split("\n").filter((line) => line.trim() !== "");
    yield* each(lines.map((line, at) => ({ line, index: at })), ({ index }) => `${FILE} line ${index + 1}`, ({ line, index }): ReaderOutput[] => {
      const value = parseLine(line, `${FILE} line ${index + 1}`);
      if (!isObject(value) || typeof value.id !== "string" || value.id === "") refuse(`${FILE} line ${index + 1} states no id`);
      if (Object.hasOwn(value, "type")) refuse(`entry ${value.id} states a member type, which is the content's own`);
      return [{ kind: ENTRY, key: value.id, content: { type: "example-log.entry", ...value }, time: instantOf(String(value.at), "rfc3339", `entry ${value.id} at`), locator: `${FILE}:${index + 1}` }];
    });
  },
};
