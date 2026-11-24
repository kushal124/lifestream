import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { declarations } from "@lifestreamprotocol/connect";
import { digest, type Json } from "@lifestreamprotocol/core";
import { serveDoor } from "./door.js";
import { STATED_ROUTE } from "./stated.js";
import { declaredStores } from "./stores.js";
import { DEVICE, makeHome, NOW_MS, REPO, type Home } from "./test/support.js";

const MAC = "macbook-pro-0001";
const PHONE = "iphone-17-pro-aa01";
const FIXTURES = join(REPO, "macos-app", "Tests", "Fixtures", "stores");

function home(): Home {
  const at = makeHome({
    mac: { kind: "mac", scopes: ["deliver"], sources: [`machine:local:${MAC}`], unit: MAC },
    phone: { kind: "phone", scopes: ["deliver"], sources: [`location:local:${PHONE}`], unit: PHONE },
    driver: { scopes: ["drive"] },
  }, []);
  onTestFinished(() => rmSync(at.root, { recursive: true, force: true }));
  return at;
}

async function serve(at: Home): Promise<string> {
  let tick = 0;
  const door = await serveDoor(at.root, { port: 0, max_bundle_bytes: 1 << 30 },
    { log: () => undefined, clock: () => NOW_MS + tick++, floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" } });
  onTestFinished(() => door.close());
  return `http://127.0.0.1:${door.port}`;
}

async function exchange(url: string, at: Home, who: "mac" | "phone", body: unknown = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}/v1/exchange`, {
    method: "POST", headers: { authorization: `Bearer ${at.tokens[who]}`, ...DEVICE[who], "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const fixtures = (): Record<string, Json> => Object.fromEntries(readdirSync(FIXTURES).filter((name) => name.endsWith(".json"))
  .map((name) => [name.slice(0, -5), JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Json]));

describe("a Mac's declared stores", () => {
  it("are handed to a Mac whose digest is not the home's, as the Mac app's fixtures hold them, and to no phone; once its digest is the home's, not again", async () => {
    const at = home();
    const url = await serve(at);
    const held = fixtures();
    const home_digest = digest(held);
    expect(declaredStores(declarations()).digest).toBe(home_digest);

    const first = await exchange(url, at, "mac");
    expect(first.status).toBe(200);
    expect(first.body.stores).toEqual(held);
    expect((await exchange(url, at, "mac", { stores: { digest: null, states: {} } })).body.stores).toEqual(held);
    const stale = `sha256:${"0".repeat(64)}`;
    expect((await exchange(url, at, "mac", { stores: { digest: stale, states: {} } })).body.stores).toEqual(held);

    expect((await exchange(url, at, "mac", { stores: { digest: home_digest, states: { imessage: "allowed" } } })).body).not.toHaveProperty("stores");
    expect((await exchange(url, at, "mac", { room: "ok" })).body).not.toHaveProperty("stores");

    expect((await exchange(url, at, "phone")).body).not.toHaveProperty("stores");
  });

  it("refuses a body's stores of another shape, by what it states", async () => {
    const at = home();
    const url = await serve(at);
    for (const stores of [
      { digest: "sha256:abc", states: {} }, { digest: null }, { digest: null, states: { imessage: "maybe" } },
      { digest: null, states: { "Not An Id": "asked" } }, { digest: null, states: {}, more: true }, ["imessage"],
    ]) {
      const answer = await exchange(url, at, "mac", { stores });
      expect([stores, answer.status, answer.body.code]).toEqual([stores, 422, "BAD_REQUEST"]);
    }
  });

  it("keeps each store's state as the Mac states it, for the report and the needs to read", async () => {
    const at = home();
    const url = await serve(at);
    await exchange(url, at, "mac", { stores: { digest: null, states: { imessage: "asked", chrome: "unsafe" } } });
    await exchange(url, at, "phone", { stores: { digest: null, states: { imessage: "asked" } } });
    const response = await fetch(`${url}${STATED_ROUTE}`, { headers: { authorization: `Bearer ${at.tokens.driver}` } });
    const { stated } = await response.json() as { stated: Record<string, { stores: unknown }> };
    expect([stated[MAC]?.stores, stated[PHONE]?.stores]).toEqual([{ digest: null, states: { imessage: "asked", chrome: "unsafe" } }, null]);
  });
});
