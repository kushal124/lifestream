import { describe, expect, it } from "vitest";
import { NeedsYou } from "../../seams.js";
import type { Scenario, Site } from "../../shared/dependencies.js";
import { artifact, memorySecrets, openTestHome, poll, temp, type PollRecord, type TestHome } from "../../test/drive.js";
import { FakeRelay } from "../../test/station.js";
import { exampleBrowserAcquirer } from "./acquirer.js";
import { exampleBrowser } from "./reader.js";
import { ExampleBrowserSite, notesOf, secrets, settings, site, SOURCE } from "./test/fixture.js";

const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const HOUR = 3_600_000;
const SECRETS = memorySecrets({ ...secrets });

const scenario = (items: number, old = 0, edited: readonly number[] = []): Scenario => ({ items, old, edited, removed: [], start_ms: NOW });

function lane(over: { site: Site }) {
  const relay = new FakeRelay({ answer: (request) => over.site.answer(request) });
  return relay.lend(exampleBrowserAcquirer({ ...settings, work: temp("example-browser-work-"), zone: "UTC", unit: "macbook-pro-0001" }, { sleep: async () => undefined, now: () => NOW }));
}

async function polled(home: TestHome, acquirer: ReturnType<typeof lane>, record: PollRecord, call: "fetch" | "page" = "fetch") {
  const delivery = await poll(home, acquirer, record, SECRETS, NOW, call);
  return delivery === undefined ? undefined : home.land(exampleBrowser, delivery);
}

describe("example browser: each of these is impossible", () => {
  it("a first poll reads history as new, a page misses a note, or a note is timed by when it arrived", async () => {
    const home = openTestHome();
    const acquirer = lane({ site: site(scenario(3, 2)) });
    const record: PollRecord = { state: null, deliveries: [] };
    expect(await polled(home, acquirer, record)).toMatchObject({ new: 1, refused: 0 });
    expect(await polled(home, acquirer, record, "page")).toMatchObject({ new: 2, refused: 0 });
    expect(record.left).toBe(0);
    const heads = home.heads(SOURCE);
    expect(heads.map((head) => [head.key, head.start_ms])).toEqual([["note-000", NOW - 2 * HOUR], ["note-001", NOW - HOUR], ["note-002", NOW]]);
    artifact(home.dir, "heads.json", heads);
  });

  it("a poll with nothing new seals anything, or an edited note is missed or lands twice", async () => {
    const home = openTestHome();
    const example = new ExampleBrowserSite();
    example.notes = notesOf(scenario(2));
    const acquirer = lane({ site: example });
    const record: PollRecord = { state: null, deliveries: [] };
    expect(await polled(home, acquirer, record)).toMatchObject({ new: 2 });
    expect(await polled(home, acquirer, record)).toBeUndefined();
    example.notes = notesOf(scenario(2, 0, [1]));
    expect(await polled(home, acquirer, record)).toMatchObject({ new: 0, changed: 1 });
    expect(await polled(home, acquirer, record)).toBeUndefined();
    expect(home.heads(SOURCE).map((head) => head.key)).toEqual(["note-000", "note-001"]);
  });

  it("a signed-out site is read, or anything but the person's to sign in again", async () => {
    const home = openTestHome();
    const example = new ExampleBrowserSite();
    example.signedOut = true;
    const record: PollRecord = { state: null, deliveries: [] };
    const refused = await polled(home, lane({ site: example }), record).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(NeedsYou);
    expect(record.deliveries).toEqual([]);
  });
});
