import { describe, expect, it } from "vitest";
import { hitKind, type PhotoKind } from "./family.js";

const TABLE: readonly [PhotoKind, string | null, string][] = [
  ["photograph", "A printed page of a rental agreement on a wooden desk", "document"],
  ["photograph", "A restaurant MENU held up in a dim room", "document"],
  ["photograph", "A laptop screen showing a spreadsheet", "document"],
  ["photograph", "Handwritten notes on a whiteboard after a meeting", "document"],
  ["photograph", "A receipt from a pharmacy", "document"],
  ["photograph", "Two people on a beach at sunset", "photograph"],
  ["photograph", "A dog asleep on a sofa; a paperback lies beside it", "photograph"],
  ["photograph", "A view over the pageant parade", "photograph"],
  ["photograph", null, "photograph"],
  [null, "A printed page", "document"],
  ["screenshot", "A screenshot of a document", "screenshot"],
  ["image", "A page of a comic", "image"],
  ["video", "A slide deck presented on a screen", "video"],
];

describe("a photo's hit kind", () => {
  it("reads a photograph of a page or a screen as a document, by whole words; any other kind stays", () => {
    expect(TABLE.map(([kind, caption]) => hitKind(kind, caption))).toEqual(TABLE.map(([, , kind]) => kind));
  });
});
