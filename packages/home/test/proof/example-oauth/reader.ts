import { each, instantOf, isObject, readJson, refuse, spanOf, utf8, type Guard, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";

export const NOTE = "note";
const FILE = /^notes\/([\w-]+)\.json$/u;

const note: Guard = (content) => {
  if (!isObject(content)) return ["a note is an object"];
  const problems: string[] = [];
  if (content.type !== "example.note") problems.push("type must be example.note");
  for (const member of ["id", "created_at", "updated_at"]) if (typeof content[member] !== "string") problems.push(`${member} must be text`);
  return problems;
};

export const exampleOauth: Reader = {
  name: "example-oauth",
  kinds: { [NOTE]: note },
  async *read(delivery, files) {
    const notes = delivery.files.filter((file) => FILE.test(file.path)).sort((left, right) => (left.path < right.path ? -1 : 1));
    yield* each(notes, (file) => file.path, (file): ReaderOutput[] => {
      const id = FILE.exec(file.path)![1]!;
      const value = readJson(utf8(files.bytes(file.blob), file.path), file.path);
      if (!isObject(value) || value.id !== id) refuse(`${file.path} holds another note`);
      if (Object.hasOwn(value, "type")) refuse(`${file.path} states a member type, which is the content's own`);
      const created = instantOf(String(value.created_at), "rfc3339", `${file.path} created_at`);
      const updated = instantOf(String(value.updated_at), "rfc3339", `${file.path} updated_at`);
      return [{
        kind: NOTE, key: id, content: { type: "example.note", ...value },
        time: updated.start_ms > created.start_ms ? spanOf(created, updated, file.path) : created, locator: file.path,
      }];
    });
  },
};
