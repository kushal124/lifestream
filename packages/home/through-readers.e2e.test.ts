import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openHomeFolder, type Json } from "@lifestreamprotocol/core";
import { mintPrincipal } from "./principals.js";
import { applyThrough } from "./through.js";
import { artifact } from "./test/harness-root.js";
import { statusOf, streamsOf } from "./test/harness-status.js";
import { beginLook, custodyAt, HOUR, look, MAC_SOURCE, MINUTE, sealed, settled, statement, throughHome, value, type ThroughHome } from "./test/through.js";

const T0 = Date.UTC(2026, 10, 13, 9, 0, 0);
const T1 = T0 + MINUTE;
const T2 = T0 + 2 * MINUTE;
const T3 = T0 + 3 * MINUTE;
const MAC_UNIT = "macbook-pro-0001";

describe("a lost seal, as its readers say it", () => {
  let home: ThroughHome | undefined;
  const seen: Record<string, unknown> = {};
  afterEach(() => {
    if (home === undefined) return;
    artifact(home.root, "through-readers", seen);
    home.close();
    home = undefined;
  });

  const open = (): { h: ThroughHome; pass: string } => {
    const h = (home = throughHome("lifestream-through-readers-", T0 + 10 * MINUTE));
    const raw = new Database(join(h.root, "home.db"));
    try {
      raw.prepare("UPDATE sources SET connector = 'screen-recorder' WHERE id = ?").run(MAC_SOURCE);
      raw.prepare("INSERT OR IGNORE INTO devices (unit, model, added_ms) VALUES (?, 'MacBook Pro', ?)").run(MAC_UNIT, T0);
    } finally {
      raw.close();
    }
    const { principal } = mintPrincipal(openHomeFolder(h.root), { unit: MAC_UNIT, kind: "mac", scopes: ["deliver"], sources: [MAC_SOURCE], now_ms: T0 });
    return { h, pass: principal.id };
  };
  const notices = (h: ThroughHome) => statusOf(h.root, { now_ms: h.now }).notices.filter((notice) => notice.id.startsWith("through:"));
  const person = (h: ThroughHome, now_ms: number) => {
    const report = streamsOf(h.root, { now_ms });
    return { connectors: report.connectors, devices: report.devices, needs: statusOf(h.root, { now_ms }).needs };
  };

  it("status lists it once a look that covered it ends, names the unit, pass and seal, and drops it when the value applies; the person reads nothing of it", async () => {
    const { h, pass } = open();
    h.commit((tx) => custodyAt(tx, pass, MAC_SOURCE, 1, T0));
    const since = h.now;
    const at = since + HOUR;
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T2), { [pass]: 2 }, h.now), h.now));
    const before = person(h, at);
    expect(before.connectors.find((each) => each.id === "screen")?.copies.map((copy) => copy.id)).toEqual([MAC_SOURCE]);
    await look(h);
    expect(notices(h)).toEqual([]);
    h.now = at;
    const lines: Json[] = [];
    const running = beginLook(h, lines);
    expect(notices(h)).toEqual([]);
    await running.end();
    const listed = notices(h);
    expect(listed).toEqual([{ id: `through:${MAC_SOURCE}`, since_ms: since, what: expect.stringContaining(`${MAC_UNIT}'s pass ${pass}, seal 2,`) as unknown }]);
    expect(listed[0]!.what).toContain("look in inbox/ for its delivery");
    expect(person(h, at)).toEqual(before);
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T3), { [pass]: 2 }, h.now), h.now));
    const later = person(h, at);
    await look(h, lines);
    expect(notices(h)).toEqual(listed);
    expect(person(h, at)).toEqual(later);
    seen.notice = listed;
    h.commit((tx) => sealed(tx, { id: "lane-mac/seal-2", source: MAC_SOURCE, sealed_ms: T1, pass, seal: 2 }));
    h.commit((tx) => settled(tx, "lane-mac/seal-2", MAC_SOURCE, h.now));
    expect([h.readThrough(MAC_SOURCE), notices(h)]).toEqual([T3, []]);
  });

  it("lists no notice once the marked gap closed: a row holds the seal while the value waits behind it", async () => {
    const { h, pass } = open();
    h.commit((tx) => custodyAt(tx, pass, MAC_SOURCE, 1, T0));
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T2), { [pass]: 2 }, h.now), h.now));
    h.now += HOUR;
    await look(h);
    expect(notices(h)).toHaveLength(1);
    h.commit((tx) => sealed(tx, { id: "lane-mac/seal-2", source: MAC_SOURCE, sealed_ms: T1, pass, seal: 2 }));
    expect([h.waiting(MAC_SOURCE)?.lost?.seal, notices(h)]).toEqual([2, []]);
  });

  it("lists no notice for a newer gap the mark does not name, until a look that covered it ends", async () => {
    const { h, pass } = open();
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T1), { [pass]: 1 }, h.now), h.now));
    h.now += HOUR;
    await look(h);
    expect(notices(h).map((notice) => notice.what)).toEqual([expect.stringContaining("seal 1,") as unknown]);
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T2), { [pass]: 2 }, h.now), h.now));
    h.commit((tx) => sealed(tx, { id: "lane-mac/seal-1", source: MAC_SOURCE, sealed_ms: T0, pass, seal: 1 }));
    h.commit((tx) => settled(tx, "lane-mac/seal-1", MAC_SOURCE, h.now));
    expect(notices(h)).toEqual([]);
    await look(h);
    expect(notices(h).map((notice) => notice.what)).toEqual([expect.stringContaining("seal 2,") as unknown]);
  });
});
