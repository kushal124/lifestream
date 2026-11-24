import { describe, expect, it } from "vitest";
import type { Connector, Road } from "@lifestreamprotocol/connect";
import type { AttemptRow, JobRow, PollRow } from "@lifestreamprotocol/core";
import { POLL_REFRESH, refreshOf, type LaneTables, type RefreshFolded, type RefreshInput } from "./refresh-now.js";

const T0 = Date.UTC(2026, 10, 11, 9, 0, 0);
const DAY = { zone: "UTC", day_start_hour: 4 };
const MAC = "macbook-pro-0001";
const AIR = "macbook-air-bb17";
const PHONE = "iphone-0000cc33";
const NAMES: Record<string, string> = { [MAC]: "MacBook Pro", [AIR]: "MacBook Air", [PHONE]: "iPhone 17 Pro" };

const declared = (id: string, road: Road, extra: Partial<Connector> = {}): Connector => ({
  id, product: "apple-notes", name: "Notes", vendor: "apple", type: "notes", records: "Synthetic notes.", noun: ["note", "notes"],
  sources: [{ id: `apple-notes:<account>:${id}`, read: "fake-rows", arrives: road }],
  ...(road === "poll" || road === "chrome" ? { acquirers: [`${id}-lane`], refresh: { default: "1h", min: "1m" } } : {}),
  ...extra,
} as Connector);

const POLLED = declared("polled", "poll");
const SECRET = declared("secret", "poll", { fields: { token: { kind: "secret", label: "Token", secret: "secret-token" } } });
const { refresh: _, ...unclocked } = declared("unclocked", "poll");
const UNCLOCKED = unclocked as Connector;
const SITE = declared("site", "chrome", { acquirers: ["site-a"], chrome: { origin: "https://chat.example.com", probe: null } } as Partial<Connector>);
const SHIPPED = declared("shipped", "mac");
const PHONED = declared("phoned", "phone");
const UPLOADED = declared("uploaded", "upload");
const LABELED = declared("labeled", "label");
const OWNED = declared("owned", "owner");

function tables(state: { polls?: Record<string, Partial<PollRow>>; jobs?: Record<string, JobRow["state"]>; meta?: Record<string, string>; fetched?: Record<string, Partial<AttemptRow>> } = {}): LaneTables {
  return {
    polls: { get: (lane: string) => (state.polls?.[lane] === undefined ? undefined : { acquirer: lane, next_ms: T0 + 3_600_000, paged_ms: null, page_next_ms: null, held_ms: null, pages: false, ...state.polls[lane] }) },
    jobs: { get: (kind: string, key: string) => (kind === "poll" && state.jobs?.[key] !== undefined ? { state: state.jobs[key] } : undefined) },
    meta: { get: (key: string) => state.meta?.[key] },
    attempts: { of: (target: string) => (state.fetched?.[target.replace(/^fetch:/u, "")] === undefined ? [] : [{ target, at_ms: T0, ...state.fetched[target.replace(/^fetch:/u, "")] }]) },
  } as unknown as LaneTables;
}

const built = (...connectors: Connector[]): Record<string, Partial<PollRow>> => Object.fromEntries(connectors.flatMap((each) => (each.acquirers ?? []).map((lane) => [lane, {}])));

type Copy = RefreshFolded["live"][number];
const copy = (connector: Connector, road: Road, unit: string | null, quiet = false, on = true): Copy => ({
  row: { id: `apple-notes:local:${connector.id}${unit === null ? "" : `:${unit}`}` }, road, unit,
  facts: { on, device: unit === null ? null : { trouble: quiet ? { state: "quiet" } : null } }, said: { acts: [] },
});

function folded(connector: Connector, live: readonly Copy[], over: Partial<RefreshFolded> = {}): RefreshFolded {
  return { connector, name: "Notes", on: true, set_up: true, pauses: [], health: { state: "ok" }, said: { acts: [] }, live, ...over };
}

function input(over: Partial<RefreshInput> = {}): RefreshInput {
  return { now_ms: T0, settings: { day: DAY, connectors: {} }, free_bytes: 1e12, needs: [], present: ["chrome-0000aa01"], ...over };
}

const nameOf = (unit: string) => NAMES[unit] ?? unit;
const act = (id: string) => ({ do: "refresh", label: "Check now", of: id });

describe("Refresh now's row", () => {
  it("each row of the table: the act where a fetch can run from here, null everywhere else", () => {
    const home = tables({ polls: built(POLLED, SITE, UNCLOCKED) });
    expect(refreshOf(home, folded(POLLED, [copy(POLLED, "poll", null)]), input(), nameOf)).toEqual({ act: act("polled"), blocked: null, asked: [] });
    expect(refreshOf(home, folded(SITE, [copy(SITE, "chrome", null)]), input(), nameOf)).toEqual({ act: act("site"), blocked: null, asked: [] });
    const mac = folded(SHIPPED, [copy(SHIPPED, "mac", MAC)]);
    for (const unit of [undefined, MAC, PHONE]) expect(refreshOf(home, mac, input(unit === undefined ? {} : { unit }), nameOf)?.act).toEqual(act("shipped"));
    const phone = folded(PHONED, [copy(PHONED, "phone", PHONE)]);
    expect(refreshOf(home, phone, input({ unit: PHONE }), nameOf)).toEqual({ act: act("phoned"), blocked: null, asked: [] });
    for (const unit of [undefined, MAC, "iphone-0000dd44"]) expect(refreshOf(home, phone, input(unit === undefined ? {} : { unit }), nameOf)).toBeNull();
    expect(refreshOf(home, folded(UPLOADED, [copy(UPLOADED, "upload", null)]), input(), nameOf)).toBeNull();
    expect(refreshOf(home, folded(LABELED, [copy(LABELED, "label", null)]), input(), nameOf)).toBeNull();
    expect(refreshOf(home, folded(OWNED, [copy(OWNED, "owner", MAC)]), input({ unit: MAC }), nameOf)).toBeNull();
    expect(refreshOf(home, folded(POLLED, [], { set_up: false }), input(), nameOf)).toBeNull();
    expect(refreshOf(home, folded(POLLED, [copy(POLLED, "poll", null)], { on: false }), input(), nameOf)).toBeNull();
    expect(refreshOf(home, folded(SHIPPED, [copy(SHIPPED, "mac", MAC, false, false)]), input(), nameOf)).toBeNull();
    expect(refreshOf(home, folded(UNCLOCKED, [copy(UNCLOCKED, "poll", null)]), input(), nameOf)).toBeNull();
    expect(refreshOf(tables(), folded(POLLED, [copy(POLLED, "poll", null)]), input(), nameOf)).toBeNull();
    for (const state of ["needs-you", "broken"]) expect(refreshOf(home, folded(POLLED, [copy(POLLED, "poll", null)], { health: { state } }), input(), nameOf)).toBeNull();
    expect(refreshOf(home, folded(POLLED, [copy(POLLED, "poll", null)], { said: { acts: [{ do: "try" }] } }), input(), nameOf)).toBeNull();
    expect(refreshOf(home, folded(POLLED, [{ ...copy(POLLED, "poll", null), said: { acts: [{ do: "try" }] } }]), input(), nameOf)).toBeNull();
  });

  it("each blocked reason, said in its words, and none guessed", () => {
    const polled = folded(POLLED, [copy(POLLED, "poll", null)]);
    const blocked = (t: LaneTables, f: RefreshFolded, i: Partial<RefreshInput> = {}) => refreshOf(t, f, input(i), nameOf)?.blocked ?? null;
    const home = tables({ polls: built(POLLED, SECRET, SITE) });
    for (const at of ["queued", "running"]) {
      expect(blocked(tables({ polls: built(POLLED), meta: { [`${POLL_REFRESH}polled-lane`]: at } }), polled)).toEqual({ reason: "running", words: "Refreshing", until_ms: null });
    }
    const site = folded(SITE, [copy(SITE, "chrome", null)]);
    expect(blocked(tables({ polls: built(SITE), jobs: { "site-b": "running" } }), site)).toBeNull();
    expect(blocked(tables({ polls: built(POLLED), jobs: { "polled-lane": "running" } }), polled)).toBeNull();
    const heldUntil = T0 + 5 * 3_600_000 + 20 * 60_000;
    expect(blocked(tables({ polls: { "polled-lane": { held_ms: heldUntil } } }), polled)).toEqual({ reason: "held", words: "Notes asked to wait until 14:20", until_ms: heldUntil });
    expect(blocked(tables({ polls: { "polled-lane": { held_ms: T0 - 1 } } }), polled)).toBeNull();
    expect(blocked(home, folded(POLLED, polled.live, { pauses: [{ scope: "all" }] }))).toEqual({ reason: "paused", words: "Paused", until_ms: null });
    expect(blocked(home, folded(POLLED, polled.live, { health: { state: "paused" } }))?.reason).toBe("paused");
    expect(blocked(home, folded(POLLED, polled.live, { pauses: [{ scope: "history" }] }))).toBeNull();
    expect(blocked(tables({ polls: built(POLLED), fetched: { "polled-lane": { outcome: "wait", reason: "offline" } } }), polled))
      .toEqual({ reason: "offline", words: "Waiting for internet", until_ms: null });
    expect(blocked(tables({ polls: built(POLLED), fetched: { "polled-lane": { outcome: "wait", reason: "provider-limit" } } }), polled)).toBeNull();
    expect(blocked(home, site, { present: [] })).toEqual({ reason: "chrome", words: "Open Chrome", until_ms: null });
    expect(blocked(home, polled, { free_bytes: 0 })).toEqual({ reason: "disk", words: "Your Mac’s disk is full", until_ms: null });
    expect(blocked(home, folded(SHIPPED, [copy(SHIPPED, "mac", MAC)]), { free_bytes: 0 })?.reason).toBe("disk");
    const locked = { needs: [{ id: "vault:locked" }] };
    expect(blocked(home, folded(SECRET, [copy(SECRET, "poll", null)]), locked)).toEqual({ reason: "vault", words: "Unlock Lifestream first", until_ms: null });
    expect(blocked(home, polled, locked)).toBeNull();
    const quiet = folded(SHIPPED, [copy(SHIPPED, "mac", MAC, true), copy(SHIPPED, "mac", AIR, true)]);
    expect(blocked(home, quiet)).toEqual({ reason: "device", words: "Open Lifestream on MacBook Pro and MacBook Air", until_ms: null });
    expect(blocked(home, folded(SHIPPED, [copy(SHIPPED, "mac", MAC, true), copy(SHIPPED, "mac", AIR)]))).toBeNull();
    expect(blocked(home, folded(SHIPPED, [copy(SHIPPED, "mac", MAC, true)]), { unit: MAC })).toBeNull();
  });

  it("asked: the Macs asked that have not taken it, of this stream's copies, the Mac pressing never among them", () => {
    const home = tables();
    const shipped = folded(SHIPPED, [copy(SHIPPED, "mac", MAC), copy(SHIPPED, "mac", AIR)]);
    const asked = [
      { unit: MAC, source: `apple-notes:local:shipped:${MAC}` }, { unit: AIR, source: `apple-notes:local:shipped:${AIR}` },
      { unit: AIR, source: "apple-notes:local:other:macbook-air-bb17" },
    ];
    expect(refreshOf(home, shipped, input({ asked }), nameOf)?.asked).toEqual([{ unit: MAC, name: "MacBook Pro" }, { unit: AIR, name: "MacBook Air" }]);
    expect(refreshOf(home, shipped, input({ asked, unit: AIR }), nameOf)?.asked).toEqual([{ unit: MAC, name: "MacBook Pro" }]);
    expect(refreshOf(home, shipped, input(), nameOf)?.asked).toEqual([]);
  });
});
