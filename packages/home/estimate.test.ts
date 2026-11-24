import { describe, expect, it } from "vitest";
import type { Connector } from "@lifestreamprotocol/connect";
import type { Months, Span } from "@lifestreamprotocol/core";
import { priceStops, TEXT_BYTES, type CostView, type MacStated, type PriceSettings, type StartCost } from "./estimate.js";

const NOW = Date.UTC(2026, 10, 19, 12);
const MAC = "chats:local:mac-0001";
const MAC_TWO = "chats:local:mac-0002";
const PHOTOS_MAC = "photos:local:mac-0001";
const PHOTOS_PHONE = "photos:local:phone-0001";
const NOTES = "notes:person-a@example.com:cloud";

const chats = {
  id: "chats", product: "chats", name: "Chats", vendor: "example", type: "messages", noun: ["message", "messages"], counts: ["msg"],
  records: "Every chat.", sources: [{ id: "chats:<account>:<unit>", read: "chats-db", arrives: "mac" }], backfill: {}, mac: { grants: ["fullDiskAccess"] },
} satisfies Connector;
const photos = {
  id: "photos", product: "photos", name: "Photos", vendor: "example", type: "photos", noun: ["photo", "photos"], counts: ["img"], mirror: true,
  records: "Every photo.", backfill: {},
  sources: [{ id: "photos:<account>:<unit>", read: "photos-mac", arrives: "mac" }, { id: "photos:<account>:<unit>", read: "photos-phone", arrives: "phone" }],
  mac: { grants: ["photos"], library: true }, phone: { grants: ["photos"], library: true },
} satisfies Connector;
const notes = {
  id: "notes", product: "notes", name: "Notes", vendor: "example", type: "notes", records: "Every note.",
  sources: [{ id: "notes:<account>:cloud", read: "notes-api", arrives: "poll" }], backfill: {},
} satisfies Connector;
const CONNECTORS: readonly Connector[] = [chats, photos, notes];
const READERS: Record<string, string> = { [MAC]: "chats-db", [MAC_TWO]: "chats-db", "chats:local:mac-0003": "chats-db", [PHOTOS_MAC]: "photos-mac", [PHOTOS_PHONE]: "photos-phone", [NOTES]: "notes-api" };

function settingsOf(start = "2026-05-19", connectors: PriceSettings["connectors"] = {}, off: string[] = []): PriceSettings {
  return { history: { start }, connectors, sources: { off } };
}

interface Held {
  text?: number;
  files?: number;
  items?: number | null;
  months?: Months;
  oldest_ms?: number;
  started?: true;
}

function viewOf(sources: Record<string, Held>, more: Partial<CostView> = {}): CostView {
  const entries = Object.entries(sources);
  return {
    sources: entries.map(([id]) => {
      const [, account, copy] = id.split(":") as [string, string, string];
      return { id, connector: READERS[id]!, options: {}, account, copy };
    }),
    retired: new Set(),
    stored: new Map(entries.filter(([, held]) => held.text !== undefined || held.files !== undefined).map(([id, held]) => [id, { text: held.text ?? 0, files: held.files ?? 0 }])),
    spans: new Map(entries.filter(([, held]) => held.items !== undefined).map(([id, held]): [string, Span[]] => [id, [
      { kind: id.startsWith("photos") ? "img" : "msg", live: held.items!, oldest_ms: held.oldest_ms ?? null, newest_ms: null, newest_dated: null },
      ...id.startsWith("notes") ? [] : [{ kind: "aside", live: 1_000_000, oldest_ms: null, newest_ms: null, newest_dated: null }],
    ]])),
    counted: new Map(entries.filter(([, held]) => held.months !== undefined).map(([id, held]) => [id, { months: held.months!, counted_ms: NOW }])),
    started: new Set(entries.filter(([, held]) => held.started === true).map(([id]) => id)),
    macs: [],
    stated: {},
    own_bytes: 0,
    disk: { free_bytes: 100_000_000_000, keep_bytes: 5_000_000_000 },
    ...more,
  };
}

function statedOf(found: string[], grants: Record<string, "on" | "off"> = { fullDiskAccess: "on", photos: "on" }, more: Partial<MacStated> = {}): MacStated {
  return { found, grants, stores: null, sending: {}, heard_ms: NOW, ...more };
}

const unused = (): never => {
  throw new Error("pricing calls no acquirer");
};
const price = (view: CostView, settings = settingsOf(), now_ms = NOW): StartCost => priceStops(view, settings, { connectors: CONNECTORS }, now_ms);
const at = (cost: StartCost, day: string | null) => cost.stops.find((stop) => stop.day === day)!;
const streamAt = (cost: StartCost, stream: string) => cost.stops.map((stop) => stop.streams[stream]);

describe("what each start costs", () => {
  it("prices a counted copy at items × the stream's text an item + its bytes, D's month by its share of days, undated at every stop, the home's own files held", () => {
    const cost = price(viewOf({
      [MAC]: { text: 600_000, items: 300, months: { "2026-11": [1000, 0], "2026-10": [3100, 0], "2026-05": [100, 0], undated: [50, 0] } },
    }, { own_bytes: 1000 }));
    expect(cost.stops.map((stop) => [stop.day, stop.months])).toEqual([["2026-10-19", 1], ["2026-08-19", 3], ["2026-05-19", 6], [null, null]]);
    expect(streamAt(cost, "chats")).toEqual([4_700_000, 8_300_000, 8_383_871, 8_500_000]);
    expect(cost.stops.map((stop) => stop.bytes)).toEqual([4_701_000, 8_301_000, 8_384_871, 8_501_000]);
    expect(cost).toMatchObject({ start: "2026-05-19", first: "2026-05", held_bytes: 601_000, settled: true, disk: { free_bytes: 100_000_000_000, keep_bytes: 5_000_000_000 } });
    expect(cost.stops.every((stop) => !stop.more)).toBe(true);
  });

  it("never prices a stream below what it holds", () => {
    const cost = price(viewOf({ [MAC]: { text: 5_000_000, items: 1000, months: { "2026-11": [100, 0] } } }));
    expect(streamAt(cost, "chats").every((bytes) => bytes === 5_000_000)).toBe(true);
  });

  it("takes the home-wide text an item for a stream under 200 items, measured whenever the home holds text, and TEXT_BYTES on a home holding none", () => {
    const wide = price(viewOf({ [MAC]: { text: 10_000, items: 10, months: { "2026-11": [100, 0] } }, [NOTES]: { text: 1_990_000, items: 990 } }));
    expect(at(wide, null).streams).toEqual({ notes: 1_990_000, chats: 200_000 });
    const few = price(viewOf({ [MAC]: { text: 10_000, items: 10, months: { "2026-11": [100, 0] } } }));
    expect(at(few, null).streams.chats).toBe(100 * 1000);
    const none = price(viewOf({ [MAC]: { months: { "2026-11": [100, 0] } } }));
    expect(at(none, null).streams.chats).toBe(100 * TEXT_BYTES);
    expect(TEXT_BYTES).toBe(3000);
  });

  it("fills a month of null bytes from the copy's mean, and is not settled while a photo read has months it has not reached", () => {
    const cost = price(viewOf({ [PHOTOS_PHONE]: { months: { "2026-11": [10, 20_000_000], "2026-10": [30, null], "2026-09": [10, 0] } } }));
    expect(at(cost, null).streams.photos).toBe(10 * 3000 + 20_000_000 + 30 * 3000 + 30 * 1_000_000 + 10 * 3000);
    expect(cost.settled).toBe(false);
    expect(cost.stops.every((stop) => !stop.more)).toBe(true);
  });

  it("takes the larger copy per month of a mirror, and adds the copies of a stream that is not one", () => {
    const mirrored = price(viewOf({
      [PHOTOS_MAC]: { months: { "2026-11": [10, 1000], "2026-10": [5, 500] } },
      [PHOTOS_PHONE]: { months: { "2026-11": [8, 800], "2026-10": [6, 600] } },
    }));
    expect(at(mirrored, null).streams.photos).toBe(31_000 + 18_600);
    const added = price(viewOf({ [MAC]: { months: { "2026-11": [10, 0] } }, [MAC_TWO]: { months: { "2026-11": [10, 0] } } }));
    expect(at(added, null).streams.chats).toBe(60_000);
  });

  it("counts a mirror's held items by the larger copy of each account, not their sum, for its text an item", () => {
    const cost = price(viewOf({ [PHOTOS_MAC]: { text: 600_000, items: 250, months: { "2026-11": [1000, 0] } }, [PHOTOS_PHONE]: { items: 240 } }));
    expect(at(cost, null).streams.photos).toBe(1000 * 2400);
  });

  it("waits for a device copy's count only once its device has shown the new wire, a start beside left or any count; an older build's copy costs what it holds", () => {
    const old = price(viewOf({ [PHOTOS_PHONE]: { text: 9000, files: 40_000_000, items: 3 } }));
    expect({ more: old.stops.some((stop) => stop.more), settled: old.settled, photos: streamAt(old, "photos").every((bytes) => bytes === 40_009_000) }).toEqual({ more: false, settled: true, photos: true });
    const stated = price(viewOf({ [PHOTOS_PHONE]: { text: 9000, items: 3, started: true } }));
    expect({ more: stated.stops.every((stop) => stop.more), settled: stated.settled }).toEqual({ more: true, settled: false });
    const counting = price(viewOf({ [PHOTOS_MAC]: { text: 9000, items: 3 }, [MAC]: { months: { "2026-11": [1, 0] } } },
      { macs: [{ unit: "mac-0001", sources: [MAC, PHOTOS_MAC], found_ms: null }], stated: { "mac-0001": statedOf(["chats", "photos"]) } }));
    expect({ more: counting.stops.every((stop) => stop.more), settled: counting.settled }).toEqual({ more: true, settled: false });
  });

  it("waits for a paired Mac that has landed nothing yet while one of its sources counts and is on, since its first bundle carries the count", () => {
    const fresh = { macs: [{ unit: "mac-0001", sources: [MAC, PHOTOS_MAC], found_ms: null }] };
    const unheard = price(viewOf({}, fresh));
    expect({ more: unheard.stops.every((stop) => stop.more), settled: unheard.settled }).toEqual({ more: true, settled: false });
    const off = price(viewOf({}, fresh), settingsOf("2026-05-19", {}, ["mac-0001"]));
    expect(off.settled).toBe(true);
    const retired = price(viewOf({}, { ...fresh, retired: new Set(["mac-0001"]) }));
    expect(retired.settled).toBe(true);
    const landed = price(viewOf({ [MAC]: { text: 4000, months: { "2026-11": [10, 0] } }, [PHOTOS_MAC]: { text: 9000, items: 3, months: { "2026-11": [3, 9000] } } },
      { ...fresh, stated: { "mac-0001": statedOf(["chats", "photos"]) } }));
    expect(landed.settled).toBe(true);
  });

  it("is not settled right after found until this Mac has spoken since, then waits for every source it says it reads, and settles once their counts are in", () => {
    const found_ms = NOW - 1000;
    const macs = [{ unit: "mac-0001", sources: [MAC, PHOTOS_MAC], found_ms }];
    const sources = { [MAC]: {}, [PHOTOS_MAC]: {} };
    const settled = (view: CostView) => ({ more: price(view).stops.every((stop) => stop.more), settled: price(view).settled });
    expect(settled(viewOf(sources, { macs }))).toEqual({ more: true, settled: false });
    expect(settled(viewOf(sources, { macs, stated: { "mac-0001": statedOf(["chats", "photos"], { fullDiskAccess: "off", photos: "off" }, { heard_ms: found_ms - 60_000 }) } })))
      .toEqual({ more: true, settled: false });
    const heard = { "mac-0001": statedOf(["chats", "photos"]) };
    expect(settled(viewOf(sources, { macs, stated: heard }))).toEqual({ more: true, settled: false });
    expect(settled(viewOf({ ...sources, [MAC]: { months: { "2026-11": [10, 0] } } }, { macs, stated: heard }))).toEqual({ more: true, settled: false });
    const counted = viewOf({ [MAC]: { months: { "2026-11": [10, 0] } }, [PHOTOS_MAC]: { months: { "2026-11": [3, 9000] } } }, { macs, stated: heard });
    expect(settled(counted)).toEqual({ more: false, settled: true });
    expect(at(price(counted), null).streams).toEqual({ chats: 30_000, photos: 18_000 });
  });

  it("settles after a relaunch on the counts and statement the home kept, though this Mac was last heard long ago", () => {
    const macs = [{ unit: "mac-0001", sources: [MAC, PHOTOS_MAC], found_ms: NOW - 86_400_000 }];
    const kept = viewOf({ [MAC]: { text: 4000, items: 10, months: { "2026-11": [10, 0] } }, [PHOTOS_MAC]: { months: { "2026-11": [3, 9000] } } },
      { macs, stated: { "mac-0001": statedOf(["chats", "photos"], undefined, { heard_ms: NOW - 3_600_000 }) } });
    expect(price(kept, settingsOf(), NOW + 60_000).settled).toBe(true);
  });

  it("waits for no source this Mac cannot read: an app it did not find, a grant not given, a store not allowed, or a source failing to send", () => {
    const macs = [{ unit: "mac-0001", sources: [MAC, PHOTOS_MAC], found_ms: NOW - 1000 }];
    const settled = (own: MacStated) => price(viewOf({ [MAC]: {}, [PHOTOS_MAC]: { months: { "2026-11": [3, 9000] } } }, { macs, stated: { "mac-0001": own } })).settled;
    expect(settled(statedOf(["chats", "photos"]))).toBe(false);
    expect(settled(statedOf(["photos"]))).toBe(true);
    expect(settled(statedOf(["chats", "photos"], { fullDiskAccess: "off", photos: "on" }))).toBe(true);
    expect(settled(statedOf(["chats", "photos"], undefined, { sending: { sources: { [MAC]: { since_ms: NOW, code: "UNREADABLE", message: "synthetic" } } } }))).toBe(true);
    const stored = { ...chats, mac: { grants: ["fullDiskAccess"], store: { feeder: "chats-db", name: "chats", held: "~/Library/Chats/chat.db", account: "local", engine: { kind: "sqlite", stores: [] } } } } as unknown as Connector;
    const storing = (state: "allowed" | "asked") => priceStops(viewOf({ [MAC]: {} }, { macs, stated: { "mac-0001": statedOf(["chats"], undefined, { stores: { digest: null, states: { chats: state } } }) } }),
      settingsOf(), { connectors: [stored, photos, notes] }, NOW).settled;
    expect([storing("allowed"), storing("asked")]).toEqual([false, true]);
  });

  it("prices a photo library still sizing its months, and settles only once the Mac has sized them all", () => {
    const macs = [{ unit: "mac-0001", sources: [PHOTOS_MAC], found_ms: NOW - 1000 }];
    const stated = { "mac-0001": statedOf(["photos"]) };
    const sizing = price(viewOf({ [PHOTOS_MAC]: { months: { "2026-11": [10, 20_000_000], "2026-10": [30, null] } } }, { macs, stated }));
    expect([sizing.settled, at(sizing, null).streams.photos]).toEqual([false, 10 * 3000 + 20_000_000 + 30 * 3000 + 30 * 2_000_000]);
    const sized = price(viewOf({ [PHOTOS_MAC]: { months: { "2026-11": [10, 20_000_000], "2026-10": [30, 45_000_000] } } }, { macs, stated }));
    expect(sized.settled).toBe(true);
  });

  it("prices a stream that cannot count at what it holds at every stop, and waits with more only on a counting copy that is on and not retired", () => {
    const quiet = price(viewOf({ [NOTES]: { text: 700_000, items: 70 }, [MAC]: { text: 50 }, [MAC_TWO]: { text: 50 } }, { retired: new Set(["mac-0002"]) }),
      settingsOf("2026-05-19", {}, [MAC]));
    expect(streamAt(quiet, "notes").every((bytes) => bytes === 700_000)).toBe(true);
    expect({ more: quiet.stops.some((stop) => stop.more), settled: quiet.settled }).toEqual({ more: false, settled: true });
    const waiting = price(viewOf({ [NOTES]: { text: 700_000 }, [MAC]: { text: 4000, started: true } }, { stated: { "mac-0001": statedOf(["chats"]) } }));
    expect(waiting.stops.every((stop) => stop.more && stop.streams.chats === 4000)).toBe(true);
    expect(waiting.settled).toBe(false);
  });

  it("counts a poll copy whose acquirer says months, waiting for its first page's count, and a poll copy whose acquirer says none at what it holds", () => {
    const counting = (view: CostView) => priceStops(view, settingsOf(), { connectors: CONNECTORS, acquirers: [{ name: "notes-api", source: NOTES, months: true, fetch: unused }] }, NOW);
    const waiting = counting(viewOf({ [NOTES]: { text: 700_000, items: 70 } }));
    expect({ more: waiting.stops.every((stop) => stop.more), settled: waiting.settled }).toEqual({ more: true, settled: false });
    const counted = counting(viewOf({ [NOTES]: { text: 700_000, items: 70, months: { "2026-11": [100, 50_000], "2025-01": [900, 450_000] } } }));
    expect([at(counted, "2026-10-19").streams.notes, at(counted, null).streams.notes, counted.settled]).toEqual([100 * 10_000 + 50_000, 1000 * 10_000 + 500_000, true]);
    const silent = priceStops(viewOf({ [NOTES]: { text: 700_000, items: 70 } }), settingsOf(), { connectors: CONNECTORS, acquirers: [{ name: "notes-api", source: NOTES, fetch: unused }] }, NOW);
    expect([streamAt(silent, "notes").every((bytes) => bytes === 700_000), silent.settled]).toEqual([true, true]);
  });

  it("prices a stream with its own start at that start at every stop", () => {
    const cost = price(viewOf({ [MAC]: { months: { "2026-11": [100, 0], "2026-10": [31, 0], "2026-05": [100, 0] } } }), settingsOf("2026-05-19", { chats: { start: "2026-10-19" } }));
    expect(streamAt(cost, "chats").every((bytes) => bytes === 300_000 + 39_000)).toBe(true);
  });

  it("offers 1, 3 and 6 months, 1, 2, 5 and 10 years and the home's start, leaving out those older than the oldest month, and all", () => {
    const oldest_ms = Date.UTC(2020, 0, 5);
    const days = (cost: StartCost) => cost.stops.map((stop) => [stop.day, stop.months]);
    const held = viewOf({ [NOTES]: { text: 1, items: 1, oldest_ms } });
    expect(days(price(held))).toEqual([["2026-10-19", 1], ["2026-08-19", 3], ["2026-05-19", 6], ["2025-11-19", 12], ["2024-11-19", 24], ["2021-11-19", 60], [null, null]]);
    expect(price(held).first).toBe("2020-01");
    expect(days(price(held, settingsOf("2018-02-03"))).slice(-2)).toEqual([["2018-02-03", 105], [null, null]]);
    expect(price(held, settingsOf("all"))).toMatchObject({ start: null });
    expect(days(price(viewOf({}), settingsOf("all"))).length).toBe(8);
    expect(days(price(viewOf({}), settingsOf("2026-02-28"), Date.UTC(2026, 2, 31))).slice(0, 2)).toEqual([["2026-02-28", 1], ["2025-12-31", 3]]);
    expect(days(price(viewOf({}), settingsOf("2026-05-19"), NOW + 86_400_000)).slice(0, 4)).toEqual([["2026-10-20", 1], ["2026-08-20", 3], ["2026-05-19", 6], ["2025-11-20", 12]]);
  });
});
