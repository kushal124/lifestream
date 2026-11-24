import { each, instantOf, isObject, readJson, refuse, spanOf, utf8, type Guard, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";

export const NOTE = "note";
const MANIFEST = "folder.json";

const note: Guard = (content) =>
  isObject(content) && content.type === "example.note" && typeof content.path === "string" && typeof content.text === "string" ? [] : ["a note is { type: example.note, path, text }"];

export const exampleFolder: Reader = {
  name: "example-folder",
  kinds: { [NOTE]: note },
  async *read(delivery, files) {
    const manifest = delivery.files.find((file) => file.path === MANIFEST) ?? refuse(`the delivery holds no ${MANIFEST}`);
    const stated = readJson(utf8(files.bytes(manifest.blob), MANIFEST), MANIFEST);
    if (!isObject(stated) || !Array.isArray(stated.files) || !Array.isArray(stated.gone)) refuse(`${MANIFEST} is not { files, gone }`);
    const blobs = new Map(delivery.files.map((file) => [file.path, file.blob]));
    yield* each(stated.files, (_, index) => `${MANIFEST} files[${index}]`, (listed): ReaderOutput[] => {
      if (!isObject(listed) || typeof listed.path !== "string" || listed.path === "" || typeof listed.file !== "string") refuse("a file is { path, file, created, modified }");
      const blob = blobs.get(listed.file) ?? refuse(`${listed.file}, which ${listed.path} names, is not in the delivery`);
      const created = instantOf(String(listed.created), "rfc3339", `${listed.path} created`);
      const modified = instantOf(String(listed.modified), "rfc3339", `${listed.path} modified`);
      return [{
        kind: NOTE, key: listed.path, content: { type: "example.note", path: listed.path, text: utf8(files.bytes(blob), listed.path) },
        time: modified.start_ms > created.start_ms ? spanOf(created, modified, listed.path) : modified, locator: listed.file,
      }];
    });
    yield* each(stated.gone, (_, index) => `${MANIFEST} gone[${index}]`, (path): ReaderOutput[] => {
      if (typeof path !== "string" || path === "") refuse("a gone path is text");
      return [{ kind: NOTE, key: path, content: null, gone: true, locator: MANIFEST }];
    });
  },
};
