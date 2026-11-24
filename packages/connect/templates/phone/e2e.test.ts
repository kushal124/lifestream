import { describe, expect, it } from "vitest";
import { instant, type Delivery } from "@lifestreamprotocol/connect/sdk";
import { INSTALL, sealedFiles, UNIT, type SyntheticBundle } from "../../ios-app/phone.test-support.js";
import { artifact, openTestHome, type TestHome } from "../../test/drive.js";
import { examplePhone } from "./reader.js";
import { FIRST, shipment, SOURCE, written } from "./test/fixture.js";

function sealed(home: TestHome, made: SyntheticBundle): Delivery {
  const stated_ms = instant(made.created_at, "rfc3339").start_ms;
  return {
    id: `phone:${UNIT}/${made.bundle_id}`, source: SOURCE, sealed_ms: stated_ms, stated_ms,
    facts: { bundle_id: made.bundle_id, created_at: made.created_at }, files: sealedFiles(home.blobs, made),
  };
}

describe("example phone: each of these is impossible", () => {
  it("a shipment lands other heads than its entries, or a note is timed by when the phone shipped it", async () => {
    const home = openTestHome();
    const landed = await home.land(examplePhone, sealed(home, FIRST()));
    expect(landed).toMatchObject({ new: 2, refused: 0 });
    const heads = home.heads(SOURCE);
    expect(heads.map((head) => [head.key, head.start_ms])).toEqual([
      [`${INSTALL}:1`, Date.parse("2026-10-03T02:10:00.000Z")],
      [`${INSTALL}:2`, Date.parse("2026-10-03T02:20:00.000Z")],
    ]);
    artifact(home.dir, "heads.json", heads);
  });

  it("the same entries again make a new version, or an entry of another kind costs more than its line", async () => {
    const home = openTestHome();
    await home.land(examplePhone, sealed(home, FIRST()));
    expect(await home.land(examplePhone, sealed(home, FIRST()))).toMatchObject({ new: 0, changed: 0 });
    const mixed = shipment("mixed", "2026-10-03T10:00:00.250+05:30", [
      written(3, "2026-10-03T03:00:00.000Z", "Synthetic phone note three."),
      written(4, "2026-10-03T03:05:00.000Z", "Synthetic phone note four.", "sketch"),
      written(5, "2026-10-03T03:10:00.000Z", "Synthetic phone note five."),
    ]);
    expect(await home.land(examplePhone, sealed(home, mixed))).toMatchObject({ new: 2, refused: 1 });
    expect(home.heads(SOURCE).map((head) => head.key)).toEqual([1, 2, 3, 5].map((sequence) => `${INSTALL}:${sequence}`));
  });
});
