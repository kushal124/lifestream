import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openHomeFolder } from "@lifestreamprotocol/core";
import { PAGES } from "./pages.js";
import { mintPrincipal } from "./principals.js";
import { homeRegistryModule } from "./programs.js";
import { clientFixture, makeRoot, removeRoot, REPO } from "./test/harness-root.js";
import { doorHere } from "./test/harness-door.js";

type Body = Record<string, any>;

const NOW = Date.parse("2026-10-05T06:00:00Z");
const READER = "synthetic-streams-reader".padEnd(43, "r");
const SPACE = { total_bytes: 500_000_000_000, free_bytes: 200_000_000_000 };
const PHONE = "phone/99.0.0";
const MAC = "mac/99.0.0";
const TIME_WORD = /\b(?:today|yesterday|tomorrow|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{4})\b|\d{1,2}:\d{2}/u;

describe("/v1/connectors, a page answer by the asking device's kind", () => {
  let root: string;
  let url = "";

  const opened = async () => {
    url = (await doorHere(root, { registry: homeRegistryModule(), clock: () => NOW, space: () => SPACE })).url;
  };
  const get = async (headers: Record<string, string> = {}) => {
    const response = await fetch(`${url}/v1/connectors`, { headers: { authorization: `Bearer ${READER}`, ...headers } });
    const text = await response.text();
    return { status: response.status, etag: response.headers.get("etag"), vary: response.headers.get("vary"), body: text === "" ? null : JSON.parse(text) as Body };
  };
  const pinned = (name: string, body: Body) => {
    mkdirSync(join(REPO, "homelink", "Tests", "Fixtures", "pages"), { recursive: true });
    const steady = { ...body, disk: { ...body.disk, free_bytes: 0 }, adding: { ...body.adding, prompt: "Lifestream runs on this Mac." } };
    const plain = JSON.parse(JSON.stringify(steady).replaceAll(root, "/home").replace(/"(port|lan_port)":\d+/gu, '"$1":0')) as Body;
    const fixture = clientFixture(`pages/connectors.${name}`, plain);
    expect(fixture.held, `homelink/Tests/Fixtures/pages/connectors.${name}.json is this read: LIFESTREAM_FIXTURES=write writes it`).toBe(fixture.written);
  };

  beforeAll(() => {
    root = makeRoot("lifestream-page-streams-", { sources: {}, settings: { unit: "macbook-pro-0001", "day.zone": "Asia/Kolkata" } });
    mintPrincipal(openHomeFolder(root), { unit: "reader-0001", scopes: ["read"], token: READER, now_ms: 0 });
  });

  afterAll(() => {
    if (root !== undefined) removeRoot(root);
  });

  it("answers the report with its rows, needs and badge, each passing the page's shape, the joined streams one row", async () => {
    await opened();
    const phone = await get({ "lifestream-device": PHONE });
    expect(phone.status).toBe(200);
    expect(phone.vary).toContain("lifestream-device");
    PAGES.connectors.shape.parse(phone.body!);
    for (const row of phone.body!.rows as Body[]) expect([row.line, ...row.more].join(" · "), row.name).not.toMatch(TIME_WORD);
    const dictation = (phone.body!.rows as Body[]).find((row) => row.name === "Dictation");
    expect(dictation).toMatchObject({ joined: true });
    expect([...dictation!.ids].sort()).toEqual(["aqua-voice", "wispr-flow"]);
    expect((phone.body!.connectors as Body[]).every((connector) => Array.isArray(connector.callout))).toBe(true);
    expect(phone.body!.badge).toEqual({ needs: (phone.body!.needs as Body[]).filter((need) => !need.banner).length, asks: 0 });
    pinned("phone", phone.body!);
    pinned("full", (await get({ "lifestream-device": MAC })).body!);
  });

  it("answers 304 on the same ETag, and another ETag for each device kind", async () => {
    await opened();
    const phone = await get({ "lifestream-device": PHONE });
    expect((await get({ "lifestream-device": PHONE, "if-none-match": phone.etag! })).status).toBe(304);
    const mac = await get({ "lifestream-device": MAC });
    const plain = await get();
    expect(new Set([phone.etag, mac.etag, plain.etag]).size).toBe(3);
    expect((await get({ "lifestream-device": MAC, "if-none-match": phone.etag! })).status).toBe(200);
  });

  it("stays readable by a model's read, as Ask reads it", async () => {
    await opened();
    const read = await get({ "lifestream-reader": "model" });
    expect(read.status).toBe(200);
    expect(read.body!.connectors).toEqual(expect.arrayContaining([expect.objectContaining({ id: "wispr-flow" })]));
  });
});
