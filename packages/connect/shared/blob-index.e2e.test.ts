import { artifact, temp } from "../test/drive.js";
import { describe, expect, it } from "vitest";
import { blobIndex } from "./blob-index.js";
import { Refused } from "./refused.js";

const HEX = "ab".repeat(32);

describe("the blob index: each of these is impossible", () => {
  it("a locator resolves to a blob the index does not state, or a damaged index reads", () => {
    const dir = temp();
    const index = blobIndex(
      Buffer.from(
        JSON.stringify({
          format: "org.lifestreamprotocol.blob-index/1",
          entries: { "Media/15550000001@s.whatsapp.net/a/b/fake.jpg": { sha256: HEX, bytes: 1234 }, "Attachments/ab/01/fake.heic": { sha256: "cd".repeat(32), bytes: 0 } },
        }),
      ),
    );
    expect(index.get("Media/15550000001@s.whatsapp.net/a/b/fake.jpg")).toEqual({ blob: `sha256:${HEX}`, size: 1234 });
    expect(index.get("Media/other.jpg")).toBeUndefined();
    const damaged = [
      { format: "org.lifestreamprotocol.blob-index/2", entries: {} },
      { format: "org.lifestreamprotocol.blob-index/1" },
      { format: "org.lifestreamprotocol.blob-index/1", entries: { "a.jpg": { sha256: HEX.toUpperCase(), bytes: 1 } } },
      { format: "org.lifestreamprotocol.blob-index/1", entries: { "a.jpg": { sha256: HEX, bytes: -1 } } },
      { format: "org.lifestreamprotocol.blob-index/1", entries: { "": { sha256: HEX, bytes: 1 } } },
      { format: "org.lifestreamprotocol.blob-index/1", entries: { "a.jpg": { sha256: HEX, bytes: 1, extra: true } } },
    ].map((value) => {
      try {
        blobIndex(Buffer.from(JSON.stringify(value)));
        return "read";
      } catch (error) {
        return error instanceof Refused ? error.message : "threw";
      }
    });
    const exactly = (name: string) => `blob index entry ${JSON.stringify(name)} must state exactly sha256 (64 lower-case hex digits) and bytes`;
    expect(damaged).toEqual([
      "the blob index must state format org.lifestreamprotocol.blob-index/1",
      "the blob index must state entries as an object",
      exactly("a.jpg"),
      'blob index entry "a.jpg" must state bytes as a non-negative integer',
      exactly(""),
      exactly("a.jpg"),
    ]);
    artifact(dir, "blob-index.json", { entries: [...index], damaged });
  });
});
