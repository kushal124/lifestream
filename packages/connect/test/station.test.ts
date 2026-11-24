import { describe, expect, it } from "vitest";
import { stationsOver, type PageRequest } from "../shared/station.js";
import { FakeRelay } from "./station.js";

const ORIGIN = "https://site.example";
const HTML = "<html><body>Synthetic orders</body></html>";

describe("the in-memory station's bodies", () => {
  it("answers a string as its text, bytes as they are, and any other value as its JSON", async () => {
    const bodies: Readonly<Record<string, unknown>> = { "/page": HTML, "/bytes": Buffer.from([0, 1, 2]), "/json": { id: "user-0001" } };
    const relay = new FakeRelay({ answer: ({ url }) => ({ status: 200, body: bodies[url.pathname] }) });
    const stations = stationsOver("https://door.example", "drive-token-synthetic", { fetch: relay.fetch });
    const got = await stations.using({ name: "synthetic", origins: [ORIGIN], deadline_ms: 60_000 }, async (errand) => {
      const tab = await errand.open(`${ORIGIN}/`);
      const read = async (name: string) => {
        const [answer] = await tab.fetch([{ url: `${ORIGIN}/${name}`, as: "file", name }]);
        expect(answer).toMatchObject({ status: 200, file: { name } });
        return Buffer.from(await errand.file(name));
      };
      return { page: (await read("page")).toString("utf8"), bytes: [...(await read("bytes"))], json: JSON.parse((await read("json")).toString("utf8")) as unknown };
    });
    expect(got).toEqual({ page: HTML, bytes: [0, 1, 2], json: { id: "user-0001" } });
  });

  it("holds a value from a JSON body only: a request that holds one is never kept as a file", async () => {
    // @ts-expect-error A request kept as a file holds nothing: `hold` is a JSON body's.
    const typed: PageRequest = { url: `${ORIGIN}/token`, as: "file", name: "token", hold: { name: "token", path: "token" } };
    const relay = new FakeRelay({ answer: () => ({ status: 200, body: { token: "token-synthetic" } }) });
    const stations = stationsOver("https://door.example", "drive-token-synthetic", { fetch: relay.fetch });
    const refused = await stations.using({ name: "synthetic", origins: [ORIGIN], deadline_ms: 60_000 }, async (errand) => (await errand.open(`${ORIGIN}/`)).fetch([typed])).catch((error: unknown) => error);
    expect([(refused as { code?: string }).code, relay.requested]).toEqual(["BAD_CALL", []]);
  });
});
