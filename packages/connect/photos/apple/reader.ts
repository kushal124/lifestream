import { deliveredLines, each, instantOf, isObject, lineText, parseLine, refuse, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";
import { img, imgFile, PHOTO_FILE_KIND, photoRow } from "./entries.js";

export const PHOTOS_MAC_CONNECTOR = "photos-mac-bundle";
const FILE = "photos.jsonl";

export const photosMac: Reader = {
  name: PHOTOS_MAC_CONNECTOR,
  kinds: { img, [PHOTO_FILE_KIND]: imgFile },
  async *read(delivery, files): AsyncGenerator<ReaderOutput> {
    const file = delivery.files.find((each) => each.path === FILE);
    if (file === undefined) return;
    yield* each(deliveredLines(files, file), (part) => part.where, ({ bytes, line, where: lineAt }): ReaderOutput[] => {
      const where = `${FILE} line ${line}`;
      const entry = parseLine(lineText(bytes, lineAt), where);
      if (!isObject(entry.payload) || typeof entry.observed_at !== "string") refuse(`${where} must state observed_at and its payload`);
      return [{ ...photoRow(entry.kind, entry.payload, instantOf(entry.observed_at, "rfc3339", `${where}.observed_at`), where), locator: where }];
    });
  },
};
