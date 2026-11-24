import { damageOverflow, macBundle, openTestHome, parityOf, type GoldenRow } from "../../test/drive.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openHome, openHomeFolder, versionId, type JsonObject, type ReaderOutput } from "@lifestreamprotocol/core";
import { whatsappConnector } from "./reader.js";
import {
  artifact, businessStore, deliver, DELTA_AFTER, DELTA_THROUGH, heads, land, laterTraffic, MAC_SOURCE, macStore, PHONE_SOURCE,
  phoneStore, sealDelta, sealSnapshot, temp, collect,
} from "./whatsapp.test-support.js";

const GOLDEN = JSON.parse(readFileSync(new URL("./test/parity.golden.json", import.meta.url), "utf8")) as Record<string, GoldenRow[]>;
const KINDS = Object.keys(whatsappConnector.kinds);
const T1 = Date.UTC(2026, 9, 1, 4);
const T2 = T1 + 3_600_000;
const T3 = T2 + 3_600_000;

async function fixture(dir: string) {
  const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
  const live = macStore(join(dir, "mac"));
  const snapshot = await deliver(blobs, MAC_SOURCE, T1, sealSnapshot(live, join(dir, "snapshot")), { kind: "snapshot", through: DELTA_AFTER });
  laterTraffic(live);
  const delta = await deliver(blobs, MAC_SOURCE, T2, sealDelta(live, join(dir, "delta"), DELTA_AFTER), { kind: "delta", after: DELTA_AFTER, through: DELTA_THROUGH });
  const phone = await deliver(blobs, PHONE_SOURCE, T3, { "chats.sqlite": phoneStore(join(dir, "phone")) });
  return { blobs, live, deliveries: { "mac-snapshot": snapshot, "mac-delta": delta, "phone-backup": phone } };
}

async function rowsOf(delivery: Parameters<typeof whatsappConnector.read>[0], blobs: Parameters<typeof whatsappConnector.read>[1]): Promise<ReaderOutput[]> {
  return collect(whatsappConnector.read(delivery, blobs));
}

describe("WhatsApp connector: each of these is impossible", () => {
  it("the parity golden differs", async () => {
    const dir = temp();
    const { blobs, deliveries } = await fixture(dir);
    const compared: Record<string, JsonObject[]> = {};
    for (const [name, delivery] of Object.entries(deliveries)) {
      const actual = parityOf(await rowsOf(delivery, blobs));
      expect(actual, name).toEqual(parityOf(GOLDEN[name]!));
      compared[name] = actual as unknown as JsonObject[];
    }
    artifact(dir, "parity.json", compared);
  });

  it("a synthetic delivery lands different heads than expected", async () => {
    const dir = temp();
    const { blobs, deliveries } = await fixture(dir);
    const home = openHome(openHomeFolder(dir), "migrate");
    try {
      const counts: Record<string, JsonObject> = {};
      for (const [name, delivery] of Object.entries(deliveries)) {
        const landed = land(home, delivery, await collect(whatsappConnector.read(delivery, blobs)), whatsappConnector.kinds);
        expect(landed.refused, `${name}: ${JSON.stringify(landed.refusals)}`).toBe(0);
        expect(landed.duplicated + landed.gone + landed.late).toBe(0);
        counts[name] = { new: landed.new, changed: landed.changed, restated: landed.restated, changedPaths: landed.changedPaths };
      }
      expect(counts["mac-delta"]).toMatchObject({ new: 5, changed: 1, restated: 3, changedPaths: { "chat.ZUNREADCOUNT": 1, "chat.ZLASTMESSAGEDATE": 1 } });

      const expected = new Map<string, string>();
      for (const name of ["mac-snapshot", "mac-delta", "phone-backup"]) {
        const source = name === "phone-backup" ? PHONE_SOURCE : MAC_SOURCE;
        for (const record of GOLDEN[name]!) expected.set(`${source} ${record.kind}:${record.key}`, versionId(record.kind, record.key, record.content).id);
      }
      const landed = [...heads(home, MAC_SOURCE, KINDS).map((head) => ({ source: MAC_SOURCE, ...head })), ...heads(home, PHONE_SOURCE, KINDS).map((head) => ({ source: PHONE_SOURCE, ...head }))];
      expect(new Map(landed.map((head) => [`${head.source} ${head.kind}:${head.key}`, head.version]))).toEqual(expected);
      const byKey = new Map(landed.map((head) => [`${head.kind}:${head.key}`, head]));
      expect(byKey.get("msg:90000000000002@lid:SYNTH-2")).toMatchObject({ start_ms: Date.UTC(2026, 4, 9, 6, 13, 30, 125), precision: "ms" });
      expect(byKey.get("pushname:15550000002@s.whatsapp.net")).toMatchObject({ start_ms: null, precision: null });
      artifact(dir, "heads.json", { counts, heads: landed });
    } finally {
      home.close();
    }
  });

  it("a smaller snapshot lands a gone", async () => {
    const dir = temp();
    const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const live = macStore(join(dir, "mac"));
    const full = await deliver(blobs, MAC_SOURCE, T1, sealSnapshot(live, join(dir, "full")));
    const db = new Database(live.chats);
    db.exec("DELETE FROM ZWAMESSAGE WHERE Z_PK IN (3, 5); DELETE FROM ZWACHATSESSION WHERE Z_PK = 2; DELETE FROM ZWAPROFILEPUSHNAME WHERE Z_PK = 2");
    db.close();
    const smaller = await deliver(blobs, MAC_SOURCE, T2, sealSnapshot(live, join(dir, "smaller")));
    const home = openHome(openHomeFolder(dir), "migrate");
    try {
      const first = land(home, full, await collect(whatsappConnector.read(full, blobs)), whatsappConnector.kinds);
      const second = land(home, smaller, await collect(whatsappConnector.read(smaller, blobs)), whatsappConnector.kinds);
      expect(second.gone).toBe(0);
      const live2 = heads(home, MAC_SOURCE, KINDS);
      expect(live2.length).toBe(first.new);
      for (const key of ["msg:90000000000003@lid:SYNTH-3", "msg:15550000001-1700000000@g.us:SYNTH-5", "chat:90000000000003@lid", "pushname:90000000000003@lid"]) {
        expect(live2.some((head) => `${head.kind}:${head.key}` === key), key).toBe(true);
      }
      artifact(dir, "smaller.json", { first, second, heads: live2 });
    } finally {
      home.close();
    }
  });

  it("a changes delivery is read as less than it holds", async () => {
    const home = openTestHome("whatsapp-changes-");
    const delivery = macBundle(home, MAC_SOURCE, new URL("./test/changes-bundle.zip", import.meta.url));
    expect(delivery.facts.kind).toBe("changes");
    const rows = await collect(whatsappConnector.read(delivery, home.blobs));
    const held = (member: string, sql: string): number => {
      const path = join(home.dir, member);
      writeFileSync(path, home.blobs.bytes(delivery.files.find((each) => each.path === member)!.blob));
      const db = new Database(path, { readonly: true });
      try {
        return Number((db.prepare(sql).get() as { n: number }).n);
      } finally {
        db.close();
      }
    };
    const count = (kind: string) => rows.filter((row) => row.kind === kind).length;
    expect(count("msg")).toBe(held("chats.sqlite", "SELECT count(*) AS n FROM ZWAMESSAGE"));
    expect(count("chat")).toBe(held("chats.sqlite", "SELECT count(*) AS n FROM ZWACHATSESSION"));
    expect(count("chat")).toBeGreaterThan(held("chats.sqlite", "SELECT count(DISTINCT ZCHATSESSION) AS n FROM ZWAMESSAGE"));
    expect(count("pushname")).toBe(held("chats.sqlite", "SELECT count(*) AS n FROM ZWAPROFILEPUSHNAME"));
    expect(count("call")).toBe(held("calls.sqlite", "SELECT count(*) AS n FROM ZWACDCALLEVENT"));
    const landed = await home.land(whatsappConnector, delivery, rows);
    expect(landed.refused).toBe(0);
    expect(rows.filter((row) => (row.blobs ?? []).length > 0).length).toBe(2);
    artifact(home.dir, "changes.json", { counts: Object.fromEntries(KINDS.map((kind) => [kind, count(kind)])), landed: { new: landed.new } });
    home.close();
  });

  it("a calls-only delivery is refused or changes chats", async () => {
    const home = openTestHome("whatsapp-calls-only-");
    const live = macStore(join(home.dir, "mac"));
    const snapshot = await deliver(home.blobs, MAC_SOURCE, T1, sealSnapshot(live, join(home.dir, "snapshot")));
    const first = await home.land(whatsappConnector, snapshot);
    expect(first.refused).toBe(0);
    const before = home.heads(MAC_SOURCE);
    const db = new Database(live.calls);
    db.exec("UPDATE ZWAAGGREGATECALLEVENT SET ZMISSED = 1, ZFIRSTDATE = NULL WHERE Z_PK = 10; DELETE FROM ZWACDCALLEVENT WHERE Z1CALLEVENTS != 10");
    db.close();
    const delivery = await deliver(home.blobs, MAC_SOURCE, T2, { "calls.sqlite": live.calls }, { kind: "changes" });
    const landed = await home.land(whatsappConnector, delivery);
    expect(landed).toMatchObject({ new: 0, changed: 2, restated: 0, refused: 0, gone: 0, changedPaths: { "aggregate.ZMISSED": 2, "aggregate.ZFIRSTDATE": 2 } });
    const after = home.heads(MAC_SOURCE);
    expect(after).toHaveLength(before.length);
    for (const head of before) {
      const current = after.find((row) => row.kind === head.kind && row.key === head.key)!;
      if (head.kind !== "call" || head.key === "SYNTH-CALL-2") expect(current).toEqual(head);
      else {
        const content = head.content as JsonObject;
        expect(current.content).toEqual({ ...content, aggregate: { ...(content.aggregate as JsonObject), ZMISSED: 1, ZFIRSTDATE: null } });
        expect([current.stated_ms, current.start_ms]).toEqual([T2, head.start_ms]);
      }
    }
    artifact(home.dir, "calls-only.json", { landed, before, after });
    home.close();
  });

  it("a chat store that does not open holds back the call history, or a call history that does not open the chats", async () => {
    const home = openTestHome("whatsapp-one-store-");
    try {
      const live = macStore(join(home.dir, "mac"));
      const broken = join(home.dir, "broken.sqlite");
      writeFileSync(broken, "no database at all");
      const landed = {
        chats: await home.land(whatsappConnector, await deliver(home.blobs, MAC_SOURCE, T1, { "chats.sqlite": broken, "calls.sqlite": live.calls })),
        calls: await home.land(whatsappConnector, await deliver(home.blobs, MAC_SOURCE, T2, { "chats.sqlite": live.chats, "calls.sqlite": broken })),
      };
      expect(landed.chats).toMatchObject({ new: 3, refused: 1 });
      expect(landed.chats.refusals.map((refusal) => refusal.key)).toEqual(["chats.sqlite"]);
      expect(landed.calls).toMatchObject({ refused: 1 });
      expect(landed.calls.new).toBeGreaterThan(0);
      expect(landed.calls.refusals.map((refusal) => refusal.key)).toEqual(["calls.sqlite"]);
      expect(home.heads(MAC_SOURCE).filter((head) => head.kind === "call").map((head) => head.key)).toEqual(["SYNTH-CALL-1", "SYNTH-CALL-2", "SYNTH-CALL-3"]);
      artifact(home.dir, "one-store.json", landed);
    } finally {
      home.close();
    }
  });

  it("a message whose media row sits on a damaged page ends the delivery, taking the messages and the call history after it", async () => {
    const home = openTestHome("whatsapp-damaged-media-");
    try {
      const live = macStore(join(home.dir, "mac"));
      const damaged = join(home.dir, "damaged.sqlite");
      writeFileSync(damaged, readFileSync(live.chats));
      const db = new Database(damaged);
      db.prepare("UPDATE ZWAMEDIAITEM SET ZMETADATA = ? WHERE Z_PK = 2").run(Buffer.alloc(12_000, 0x61));
      db.close();
      damageOverflow(damaged, "ZWAMEDIAITEM");
      const keys = (rows: ReaderOutput[]) => rows.filter((row) => row.refused === undefined).map((row) => `${row.kind} ${row.key}`);
      const clean = await collect(whatsappConnector.read(await deliver(home.blobs, MAC_SOURCE, T1, { "chats.sqlite": live.chats, "calls.sqlite": live.calls }), home.blobs));
      const read = await collect(whatsappConnector.read(await deliver(home.blobs, MAC_SOURCE, T1, { "chats.sqlite": damaged, "calls.sqlite": live.calls }), home.blobs));
      expect(read.filter((row) => row.refused !== undefined)).toEqual([
        expect.objectContaining({ key: "ZWAMESSAGE Z_PK 6", refused: expect.stringMatching(/^SQLite cannot return it: SQLITE_CORRUPT/u) }),
      ]);
      const lost = keys(clean).filter((key) => !keys(read).includes(key));
      expect(lost).toHaveLength(1);
      expect(lost[0]).toMatch(/^msg .*:SYNTH-6$/u);
      expect(keys(read).filter((key) => key.startsWith("call "))).toHaveLength(3);
      artifact(home.dir, "damaged-media.json", { lost, refused: read.filter((row) => row.refused !== undefined) });
    } finally {
      home.close();
    }
  });

  it("a reply whose parent the store no longer holds is dropped or refused", async () => {
    const dir = temp();
    const live = macStore(join(dir, "mac"));
    const db = new Database(live.chats);
    db.exec("DELETE FROM ZWAMESSAGE WHERE Z_PK = 1");
    db.close();
    const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const delivery = await deliver(blobs, MAC_SOURCE, T1, sealSnapshot(live, join(dir, "changes")), { kind: "changes" });
    const home = openHome(openHomeFolder(dir), "migrate");
    try {
      const rows = await collect(whatsappConnector.read(delivery, blobs));
      const landed = land(home, delivery, rows, whatsappConnector.kinds);
      expect(landed.refused).toBe(0);
      const reply = rows.find((row) => row.kind === "msg" && row.key === "90000000000002@lid:SYNTH-2")?.content as JsonObject;
      expect(reply.parent_stanza_id).toBeNull();
      expect(reply.ZPARENTMESSAGE).toBe(1);
      expect(heads(home, MAC_SOURCE, ["msg"]).some((head) => head.key === "90000000000002@lid:SYNTH-2")).toBe(true);
      artifact(dir, "orphan-reply.json", { landed, reply });
    } finally {
      home.close();
    }
  });

  it("a duplicated key in one delivery goes unreported", async () => {
    const dir = temp();
    const live = macStore(join(dir, "mac"));
    const db = new Database(live.chats);
    db.exec(`
      INSERT INTO ZWACHATSESSION (Z_PK, ZCONTACTJID, ZCONTACTIDENTIFIER, ZPARTNERNAME) VALUES (8, '90000000000002@lid', NULL, 'Synthetic Twin');
      INSERT INTO ZWAMESSAGE (Z_PK, ZCHATSESSION, ZSTANZAID, ZTEXT, ZFROMJID, ZTOJID, ZMESSAGEDATE, ZISFROMME)
        VALUES (20, 8, 'SYNTH-1', 'synthetic twin copy', '90000000000002@lid', '15550000001@s.whatsapp.net', 800000300, 0);
    `);
    db.close();
    const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const delivery = await deliver(blobs, MAC_SOURCE, T1, sealSnapshot(live, join(dir, "snapshot")));
    const home = openHome(openHomeFolder(dir), "migrate");
    try {
      const landed = land(home, delivery, await collect(whatsappConnector.read(delivery, blobs)), whatsappConnector.kinds);
      expect(landed.duplicated).toBe(2);
      const twin = heads(home, MAC_SOURCE, ["msg"]).find((head) => head.key === "90000000000002@lid:SYNTH-1");
      expect(twin?.start_ms).toBe(Date.UTC(2026, 4, 9, 6, 18, 20));
      artifact(dir, "duplicated.json", { landed });
    } finally {
      home.close();
    }
  });

  it("the business list states more than its verified names, keys a business otherwise than by its id, or holds back the chats beside it", async () => {
    const dir = temp();
    const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const live = macStore(join(dir, "mac"));
    const business = businessStore(join(dir, "mac", "Biz", "Biz.sqlite"));
    const rows = await rowsOf(await deliver(blobs, MAC_SOURCE, T1, { "chats.sqlite": live.chats, "business.sqlite": business }, { kind: "changes" }), blobs);
    expect(rows.filter((row) => row.kind === "business").map((row) => [row.key, row.content])).toEqual([
      ["90000000000041@lid", { type: "whatsapp.business", ZJID: "90000000000041@LID", ZPHONENUMBERJID: "15550000041@s.whatsapp.net", ZNAME: "Example Shop", ZVERIFICATIONLEVEL: 3 }],
      ["90000000000042@lid", { type: "whatsapp.business", ZJID: "90000000000042@lid", ZPHONENUMBERJID: null, ZNAME: "Synthetic Studio", ZVERIFICATIONLEVEL: 1 }],
      ["90000000000043@lid", { type: "whatsapp.business", ZJID: "90000000000043@lid", ZPHONENUMBERJID: "15550000043@s.whatsapp.net", ZNAME: null, ZVERIFICATIONLEVEL: 2 }],
    ]);
    for (const row of rows.filter((each) => each.kind === "business")) expect(whatsappConnector.kinds.business!(row.content!)).toEqual([]);
    expect(rows.filter((row) => row.kind === "msg").length).toBeGreaterThan(0);
    expect(rows.filter((row) => row.kind === "business" && row.time !== undefined)).toEqual([]);
    const db = new Database(business);
    db.exec("ALTER TABLE ZWABIZVERIFIEDNAMEDATA ADD COLUMN ZNEWCOLUMN INTEGER");
    db.close();
    const added = await rowsOf(await deliver(blobs, MAC_SOURCE, T2, { "business.sqlite": business }, { kind: "changes" }), blobs);
    expect(added).toEqual(rows.filter((row) => row.kind === "business"));
    const dropped = new Database(business);
    dropped.exec("ALTER TABLE ZWABIZVERIFIEDNAMEDATA DROP COLUMN ZVERIFICATIONLEVEL");
    dropped.close();
    const refused = await rowsOf(await deliver(blobs, MAC_SOURCE, T3, { "chats.sqlite": live.chats, "business.sqlite": business }, { kind: "changes" }), blobs);
    expect(refused.filter((row) => row.refused !== undefined)).toEqual([expect.objectContaining({ key: "business.sqlite", refused: expect.stringMatching(/ZWABIZVERIFIEDNAMEDATA lacks columns this connector reads: ZVERIFICATIONLEVEL/u) })]);
    expect(refused.filter((row) => row.kind === "msg")).toEqual(rows.filter((row) => row.kind === "msg"));
    artifact(dir, "business.json", { rows: rows.filter((row) => row.kind === "business"), refused: refused.filter((row) => row.refused !== undefined) });
  });

  it("a column WhatsApp adds stops the source or changes a version, or a known column it drops lands", async () => {
    const dir = temp();
    const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const read = async (name: string, change?: string) => {
      const live = macStore(join(dir, name));
      if (change !== undefined) {
        const db = new Database(live.chats);
        db.exec(change);
        db.close();
      }
      return rowsOf(await deliver(blobs, MAC_SOURCE, T1, sealSnapshot(live, join(dir, `${name}-snapshot`))), blobs);
    };
    const before = await read("before");
    const added = await read("added", "ALTER TABLE ZWAMESSAGE ADD COLUMN ZNEWCOLUMN INTEGER");
    expect(added).toEqual(before);
    const dropped = await read("dropped", "ALTER TABLE ZWAMESSAGE DROP COLUMN ZSTARRED");
    const refused = dropped.filter((row) => row.refused !== undefined);
    expect(refused).toEqual([expect.objectContaining({ key: "chats.sqlite", refused: expect.stringMatching(/the file ZWAMESSAGE lacks columns this connector reads: ZSTARRED/u) })]);
    expect(dropped.filter((row) => row.kind === "call")).toEqual(before.filter((row) => row.kind === "call"));
    artifact(dir, "schema.json", { rows: before.length, refused });
  });
});
