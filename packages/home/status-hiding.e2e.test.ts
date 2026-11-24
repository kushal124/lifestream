import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { HIDING_META, type HidingWaits } from "./copies.js";
import { readStatus, renderStatus, type StatusOptions } from "./status.js";
import { cleanup, makeHome, makeHomeDb, NOW_MS } from "./test/support.js";
import { readOpsSettings } from "./verbs/context.js";
import { openHomeFolder } from "@lifestreamprotocol/core";

const roots: string[] = [];
afterAll(() => cleanup(roots));

const LINE = "Waiting for People to list the names of your people";

function statusOf(waits: HidingWaits | undefined) {
  const { root } = makeHome({}, roots);
  const db = makeHomeDb(join(root, "home.db"));
  try {
    if (waits !== undefined) db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(HIDING_META, JSON.stringify(waits));
    const settings = readOpsSettings(root);
    const options: StatusOptions = { folder: openHomeFolder(root), now_ms: NOW_MS, settings, connectors: [], families: [], ledger: null };
    const report = readStatus(db, options);
    return { privacy: report.privacy, text: renderStatus(report, settings.day), none: readStatus(null, options).privacy };
  } finally {
    db.close();
  }
}

describe("lifestream status: hiding", () => {
  it("S1, S3: says hiding waits, with the line the pages show, while a level that hides waits", () => {
    const waiting = statusOf({ all: LINE, names: LINE });
    expect(waiting.privacy).toEqual({ ready: false, line: LINE });
    expect(waiting.text).toContain(`Hiding\n  ${LINE}: what goes hidden waits until it is ready`);
    expect(statusOf({ names: LINE }).privacy).toEqual({ ready: false, line: LINE });
  });

  it("S2, S3: says ready, no line, for a home whose hiding is ready, one that wrote nothing yet, and one with no home.db", () => {
    const ready = statusOf({});
    expect(ready.privacy).toEqual({ ready: true, line: null });
    expect(ready.text).not.toContain("Hiding");
    expect(statusOf(undefined).privacy).toEqual({ ready: true, line: null });
    expect(ready.none).toEqual({ ready: true, line: null });
  });
});
