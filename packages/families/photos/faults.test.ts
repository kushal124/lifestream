import { describe, expect, it } from "vitest";
import type { PhotosAdapter } from "@lifestreamprotocol/core";
import { BLOB, HEX, statedOf } from "../test/stated.js";
import { photosFaults } from "./faults.js";

const OTHER = "cd".repeat(32);
const FILE = { sha256: HEX, media_type: "image/jpeg" };
const COPY = {
  id: "photo-1", records: [], at_ms: null, cloud: null, names: [], video: false, originals: [FILE], renders: [], motion: { renders: [], originals: [] }, duration_ms: null,
  files: [HEX], resources: [{ type: "photo", name: null, size: null, files: [HEX, OTHER], refused: false }], modified_ms: 1, erased: false,
};
const said = (member: string, value: unknown) => photosFaults(statedOf<PhotosAdapter>({}, member, value, null));
const RULE = "is a SHA-256 in 64 lower-case hex digits, no `sha256:`";

describe("photosFaults", () => {
  it("passes a copy, files and an image that keep every rule", () => {
    expect(said("copy", COPY)).toEqual([]);
    expect(said("files", [HEX, OTHER])).toEqual([]);
    expect(said("image", HEX)).toEqual([]);
    expect(said("image", null)).toEqual([]);
  });

  it("names each SHA-256 that is not one", () => {
    expect(said("files", [BLOB])).toEqual([`each of \`files\` ${RULE}: \`${BLOB}\` is none`]);
    expect(said("image", HEX.toUpperCase())).toEqual([`each of \`image\` ${RULE}: \`${HEX.toUpperCase()}\` is none`]);
    expect(said("copy", { ...COPY, renders: [{ sha256: "abc", media_type: "image/jpeg" }] })).toEqual([`each of \`renders[].sha256\` ${RULE}: \`abc\` is none`]);
    expect(said("copy", { ...COPY, motion: { renders: [], originals: [{ sha256: BLOB, media_type: "video/quicktime" }] } })).toEqual([`each of \`motion.originals[].sha256\` ${RULE}: \`${BLOB}\` is none`]);
    expect(said("copy", { ...COPY, resources: [{ ...COPY.resources[0], files: ["xyz"] }] })).toEqual([`each of \`resources[].files\` ${RULE}: \`xyz\` is none`]);
  });
});
