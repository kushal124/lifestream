import { carriesNothing, each, instantOf, isObject, readJson, refuse, utf8, type Guard, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";

export const NOTE = "note";
const FILE = /^notes\/([\w-]+)\.json$/u;

const note: Guard = (content) =>
  isObject(content) && content.type === "example.note" && typeof content.id === "string" && typeof content.created_at === "string" ? [] : ["a note is { type: example.note, id, created_at, … }"];

export const exampleBrowser: Reader = {
  name: "example-browser",
  kinds: { [NOTE]: note },
  async *read(delivery, files) {
    if (carriesNothing(delivery)) return;
    const account = delivery.files.find((file) => file.path === "account.json") ?? refuse(`delivery ${delivery.id} holds no account.json`);
    const stated = readJson(utf8(files.bytes(account.blob), account.path), account.path);
    if (!isObject(stated) || delivery.source !== `example:${String(stated.id)}:browser`) refuse(`account.json names another account than ${delivery.source}'s`);
    const notes = delivery.files.filter((file) => FILE.test(file.path)).sort((left, right) => (left.path < right.path ? -1 : 1));
    yield* each(notes, (file) => file.path, (file): ReaderOutput[] => {
      const id = FILE.exec(file.path)![1]!;
      const value = readJson(utf8(files.bytes(file.blob), file.path), file.path);
      if (!isObject(value) || value.id !== id) refuse(`${file.path} holds another note`);
      if (Object.hasOwn(value, "type")) refuse(`${file.path} states a member type, which is the content's own`);
      return [{ kind: NOTE, key: id, content: { type: "example.note", ...value }, time: instantOf(String(value.created_at), "rfc3339", `${file.path} created_at`), locator: file.path }];
    });
  },
};
