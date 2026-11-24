import { describe, expect, it } from "vitest";
import { STATEMENTS_FILE } from "../shared/statements.js";
import { artifact, collect, deliver, openTestHome } from "../test/drive.js";
import { devicesHome } from "./reader.js";

const DEVICES = "devices:local:macbook-pro-0001";
const DEVICE = "dashboard-macbook-pro-0001";
const CAMERA = "synthetic-make/synthetic-camera";
const statements = (lines: unknown[]) => Buffer.from(lines.map((line) => `${typeof line === "string" ? line : JSON.stringify(line)}\n`).join(""));
const word = (mine: boolean, dates: { from?: string; to?: string } = {}) => ({ type: "devices.camera", mine, ...dates });
const facts = (fetched_at: string) => ({ fetched_at, device: DEVICE });

describe("the owner's word on cameras: each of these is impossible", () => {
  it("D1 D2: a word of another shape lands, refuses its neighbours, or is not named by its line", async () => {
    const home = openTestHome();
    const good = { kind: "camera", key: CAMERA, content: word(false) };
    const bad: [string, unknown][] = [
      ["a key that is no camera's id", { kind: "camera", key: "Synthetic Camera", content: word(false) }],
      ["mine not a boolean", { kind: "camera", key: CAMERA, content: { type: "devices.camera", mine: "no" } }],
      ["no mine", { kind: "camera", key: CAMERA, content: { type: "devices.camera", from: "2026-10-01" } }],
      ["a date the calendar lacks", { kind: "camera", key: CAMERA, content: word(false, { from: "2026-02-30" }) }],
      ["a date spelled otherwise", { kind: "camera", key: CAMERA, content: word(false, { to: "2026-10-01T00:00:00Z" }) }],
      ["from after to", { kind: "camera", key: CAMERA, content: word(true, { from: "2026-10-02", to: "2026-10-01" }) }],
      ["a member more", { kind: "camera", key: CAMERA, content: { ...word(false), unit: "iphone-aa01" } }],
      ["another type", { kind: "camera", key: CAMERA, content: { type: "devices.phone", mine: false } }],
      ["another kind", { kind: "phone", key: CAMERA, content: word(false) }],
      ["content null", { kind: "camera", key: CAMERA, content: null }],
    ];
    const refusals: Record<string, string> = {};
    for (const [name, line] of bad) {
      const delivery = deliver(home, DEVICES, { [STATEMENTS_FILE]: statements([good, line, good]) }, facts("2026-10-14T08:00:00.123Z"));
      const rows = await collect(devicesHome.read(delivery, home.blobs));
      expect(rows.map((row) => [row.locator, row.refused === undefined]), name).toEqual([[`${STATEMENTS_FILE}:1`, true], [`${STATEMENTS_FILE}:2`, false], [`${STATEMENTS_FILE}:3`, true]]);
      expect(rows[1]!.refused, name).toContain(`${STATEMENTS_FILE} line 2`);
      refusals[name] = rows[1]!.refused!;
    }
    const dated = deliver(home, DEVICES, { [STATEMENTS_FILE]: statements([{ kind: "camera", key: "phone/iphone-aa01", content: word(false, { from: "2026-10-01", to: "2026-10-01" }) }]) }, facts("2026-10-14T08:00:00.123Z"));
    expect(await home.land(devicesHome, dated)).toMatchObject({ new: 1, refused: 0 });
    expect(home.heads(DEVICES).filter((head) => head.key === CAMERA)).toEqual([]);
    artifact(home.dir, "refusals.json", refusals);
  });

  it("D3: a newer word does not replace the old, an older one sent late does, or a word taken back loses its history", async () => {
    const home = openTestHome();
    const said = (at: string, line: unknown) => home.land(devicesHome, deliver(home, DEVICES, { [STATEMENTS_FILE]: statements([line]) }, facts(at)));
    expect(await said("2026-10-14T08:00:00.000Z", { kind: "camera", key: CAMERA, content: word(false) })).toMatchObject({ new: 1 });
    expect(await said("2026-10-14T09:00:00.000Z", { kind: "camera", key: CAMERA, content: word(false, { from: "2026-03-01" }) })).toMatchObject({ changed: 1 });
    expect(await said("2026-10-13T09:00:00.000Z", { kind: "camera", key: CAMERA, content: word(true) })).toMatchObject({ late: 1 });
    expect(home.heads(DEVICES)[0]).toMatchObject({ content: word(false, { from: "2026-03-01" }), time: null });
    expect(await said("2026-10-14T10:00:00.000Z", { kind: "camera", key: CAMERA, gone: true })).toMatchObject({ gone: 1 });
    expect(home.heads(DEVICES).map((head) => head.gone)).toEqual([true]);
    artifact(home.dir, "words.json", home.heads(DEVICES));
  });
});
