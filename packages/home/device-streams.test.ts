import { describe, expect, it } from "vitest";
import { declarations } from "@lifestreamprotocol/connect";
import { deviceStreams } from "./device-streams.js";

const MAC = { unit: "macbook-pro-0001", kind: "mac" } as const;
const PHONE = { unit: "iphone-17-pro-aa01", kind: "phone" } as const;

const copy = (unit: string, road: "mac" | "phone", line: string, state: "ok" | "needs-you" = "ok", words = "") => ({ unit, road, line, health: { state, words } });

const MACHINE = {
  id: "machine", shown: "stream", lead: null, line: "698 events today", health: { words: "Sent just now" },
  copies: [copy(MAC.unit, "mac", "40,000 events · last 11:59"), copy(PHONE.unit, "phone", "12 events · last 11:58")],
} as const;
const SCREEN_TIME = {
  id: "screen-time", shown: "stream", lead: null, line: "325 app switches today", health: { words: "Sent just now" },
  copies: [copy(MAC.unit, "mac", "9,000 app switches · last 11:59"), copy(PHONE.unit, "phone", "Nothing yet")],
} as const;
const LOCATION = {
  id: "location", shown: "stream", lead: "Catching up", line: "back to May 2026", health: { words: "Syncing" },
  copies: [copy(PHONE.unit, "phone", "800 places · last 11:50")],
} as const;
const CONNECTORS = [MACHINE, SCREEN_TIME, LOCATION];

describe("a device's page lists the streams that device shows, each in its own words", () => {
  it("holds Mac events off an iPhone's page though the phone ships its own machine events, and says the phone's Screen Time, never the Mac's count", () => {
    expect(declarations().find((each) => each.id === "machine")?.phone).toBeUndefined();
    expect(deviceStreams(PHONE, CONNECTORS, [], declarations())).toEqual([
      { id: "screen-time", line: "Nothing yet" },
      { id: "location", line: "Catching up · back to May 2026" },
    ]);
  });

  it("lists the Mac's own on the Mac's page, a shared stream in its Mac copy's words", () => {
    expect(deviceStreams(MAC, CONNECTORS, [], declarations())).toEqual([
      { id: "machine", line: "40,000 events · last 11:59" },
      { id: "screen-time", line: "9,000 app switches · last 11:59" },
    ]);
  });

  it("a shared stream says what this device needs, or its copy's trouble, before its count", () => {
    const need = { connector: "screen-time", unit: PHONE.unit, words: "Allow Screen Time on iPhone" };
    expect(deviceStreams(PHONE, [SCREEN_TIME], [need, { ...need, unit: MAC.unit, words: "Allow Full Disk Access" }], declarations()))
      .toEqual([{ id: "screen-time", line: "Allow Screen Time on iPhone" }]);
    const quiet = { ...SCREEN_TIME, copies: [SCREEN_TIME.copies[0], copy(PHONE.unit, "phone", "Nothing yet", "needs-you", "Open Lifestream on iPhone")] };
    expect(deviceStreams(PHONE, [quiet], [], declarations())).toEqual([{ id: "screen-time", line: "Open Lifestream on iPhone" }]);
  });
});
