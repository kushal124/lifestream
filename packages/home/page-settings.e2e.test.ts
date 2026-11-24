import { describe, expect, it, onTestFinished, vi } from "vitest";
import { openHomeFolder } from "@lifestreamprotocol/core";
import { PAGES } from "./pages.js";
import { mintPrincipal } from "./principals.js";
import { homeRegistryModule } from "./programs.js";
import { makeRoot, removeRoot } from "./test/harness-root.js";
import { doorHere } from "./test/harness-door.js";

const storage = vi.hoisted(() => ({ reads: 0 }));

vi.mock("./storage-read.js", async (original) => {
  const real = await original<typeof import("./storage-read.js")>();
  return {
    ...real,
    readStorage: (...args: Parameters<typeof real.readStorage>) => {
      storage.reads += 1;
      return real.readStorage(...args);
    },
  };
});

type Body = Record<string, any>;

const NOW = Date.parse("2026-11-23T06:00:00Z");
const READER = "synthetic-settings-reader".padEnd(43, "r");
const SPACE = { total_bytes: 500_000_000_000, free_bytes: 111_000_000_000 };
const PHONE = "phone/99.0.0";
const MAC = "mac/99.0.0";

describe("Settings' pages through the door", () => {
  let url = "";

  const get = async (path: string, device: string) => {
    const response = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${READER}`, "lifestream-device": device } });
    return { status: response.status, body: await response.json() as Body };
  };

  const open = async () => {
    const root = makeRoot("lifestream-page-settings-", { sources: {}, settings: { unit: "macbook-pro-0001", "day.zone": "Asia/Kolkata" } });
    onTestFinished(() => removeRoot(root));
    mintPrincipal(openHomeFolder(root), { unit: "reader-0001", scopes: ["read"], token: READER, now_ms: 0 });
    url = (await doorHere(root, { registry: homeRegistryModule(), clock: () => NOW, space: () => SPACE })).url;
  };

  it("answers the phone's live Settings with Storage from the disk reading, the storage walk never read", async () => {
    await open();
    storage.reads = 0;
    const phone = await get(PAGES.settings.route, PHONE);
    expect(phone.status).toBe(200);
    PAGES.settings.shape.parse(phone.body);
    expect(phone.body.values.map((each: Body) => each.id)).toEqual(["storage", "time"]);
    expect(phone.body.values[0].value).toEqual([{ kind: "words", words: expect.stringMatching(/^[0-9,.]+ [KMGT]?B left$/u) }]);
    expect(storage.reads).toBe(0);
  });

  it("serves a page of rows by its id, and 404 for a Mac-only id asked by a phone", async () => {
    await open();
    const advanced = await get(`${PAGES.settingsPage.route}?id=advanced`, PHONE);
    expect(advanced.status).toBe(200);
    PAGES.settingsPage.shape.parse(advanced.body);
    const recovery = await get(`${PAGES.settingsPage.route}?id=recovery`, PHONE);
    expect(recovery).toMatchObject({ status: 404, body: { code: "NOT_FOUND" } });
    expect((await get(`${PAGES.settingsPage.route}?id=time`, MAC)).status).toBe(200);
  });
});
