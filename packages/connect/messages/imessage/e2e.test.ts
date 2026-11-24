import { macBundle, openTestHome, parityOf, type GoldenRow } from "../../test/drive.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openHome, openHomeFolder, versionId, type BlobReader, type Delivery, type JsonObject, type ReaderOutput } from "@lifestreamprotocol/core";
import { imessageConnector } from "./reader.js";
import {
  artifact, BUSINESS_CHAT, deliver, DELTA_AFTER, DELTA_THROUGH, GROUP_CHAT, heads, land, laterTraffic, MAC_SOURCE, MAC_UNIT,
  macStore, PHONE_SOURCE, phoneStore, sealDelta, sealSnapshot, temp, collect,
} from "./imessage.test-support.js";

const GOLDEN = JSON.parse(readFileSync(new URL("./test/parity.golden.json", import.meta.url), "utf8")) as Record<string, GoldenRow[]>;
const KINDS = Object.keys(imessageConnector.kinds);
const T1 = Date.UTC(2026, 9, 1, 4);
const T2 = T1 + 3_600_000;
const T3 = T2 + 3_600_000;

async function fixture(dir: string) {
  const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
  const live = macStore(join(dir, "mac"));
  const snapshot = await deliver(blobs, MAC_SOURCE, T1, sealSnapshot(live, join(dir, "snapshot")), { kind: "snapshot", through: DELTA_AFTER });
  laterTraffic(live);
  const delta = await deliver(blobs, MAC_SOURCE, T2, sealDelta(live, join(dir, "delta"), DELTA_AFTER), { kind: "delta", after: DELTA_AFTER, through: DELTA_THROUGH });
  const phone = await deliver(blobs, PHONE_SOURCE, T3, sealSnapshot(phoneStore(join(dir, "phone")), join(dir, "phone-sealed")));
  return { blobs, deliveries: { "mac-snapshot": snapshot, "mac-delta": delta, "phone-backup": phone } };
}

async function rowsOf(delivery: Delivery, blobs: BlobReader): Promise<ReaderOutput[]> {
  return collect(imessageConnector.read(delivery, blobs));
}

describe("iMessage connector: each of these is impossible", () => {
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
        const landed = land(home, delivery, await collect(imessageConnector.read(delivery, blobs)), imessageConnector.kinds);
        expect(landed.refused, `${name}: ${JSON.stringify(landed.refusals)}`).toBe(0);
        expect(landed.duplicated + landed.gone + landed.late).toBe(0);
        counts[name] = { new: landed.new, changed: landed.changed, restated: landed.restated, changedPaths: landed.changedPaths };
      }
      expect(counts["mac-delta"]).toMatchObject({ new: 5, changed: 1, restated: 3, changedPaths: { "state.last_read_message_timestamp": 1 } });

      const expected = new Map<string, string>();
      for (const name of ["mac-snapshot", "mac-delta", "phone-backup"]) {
        const source = name === "phone-backup" ? PHONE_SOURCE : MAC_SOURCE;
        for (const record of GOLDEN[name]!) expected.set(`${source} ${record.kind}:${record.key}`, versionId(record.kind, record.key, record.content).id);
      }
      const landed = [
        ...heads(home, MAC_SOURCE, KINDS).map((head) => ({ source: MAC_SOURCE, ...head })),
        ...heads(home, PHONE_SOURCE, KINDS).map((head) => ({ source: PHONE_SOURCE, ...head })),
      ];
      expect(new Map(landed.map((head) => [`${head.source} ${head.kind}:${head.key}`, head.version]))).toEqual(expected);
      const plain = landed.filter((head) => head.key === "SYNTH-MSG-PLAIN");
      expect(plain.map((head) => head.source)).toEqual([MAC_SOURCE, PHONE_SOURCE]);
      expect(plain[0]!.version).not.toBe(plain[1]!.version);
      const byKey = new Map(landed.map((head) => [`${head.source} ${head.kind}:${head.key}`, head]));
      expect(byKey.get(`${MAC_SOURCE} msg:SYNTH-MSG-PLAIN`)).toMatchObject({ start_ms: Date.UTC(2026, 4, 9, 6, 13, 20, 123), precision: "ms" });
      expect(byKey.get(`${MAC_SOURCE} chat-state:${MAC_UNIT}:${BUSINESS_CHAT}`)).toMatchObject({ start_ms: null, precision: null });
      artifact(dir, "heads.json", { counts, heads: landed });
    } finally {
      home.close();
    }
  });

  it("a column a later macOS adds makes a new version", async () => {
    const dir = temp();
    const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const live = macStore(join(dir, "mac"));
    const before = await deliver(blobs, MAC_SOURCE, T1, sealSnapshot(live, join(dir, "before")));
    const db = new Database(live.db);
    db.exec(`
      ALTER TABLE message ADD COLUMN is_preview_sent INTEGER DEFAULT 1;
      ALTER TABLE chat ADD COLUMN is_synthetic_later INTEGER DEFAULT 1;
    `);
    db.close();
    const after = await deliver(blobs, MAC_SOURCE, T2, sealSnapshot(live, join(dir, "after")));
    const home = openHome(openHomeFolder(dir), "migrate");
    try {
      const first = land(home, before, await collect(imessageConnector.read(before, blobs)), imessageConnector.kinds);
      const second = land(home, after, await collect(imessageConnector.read(after, blobs)), imessageConnector.kinds);
      expect(second).toMatchObject({ new: 0, changed: 0, refused: 0, restated: first.new });
      expect(imessageConnector.columns!.message).not.toContain("is_preview_sent");
      expect(imessageConnector.columns!.chat).not.toContain("is_synthetic_later");
      artifact(dir, "later-columns.json", { first, second });
    } finally {
      home.close();
    }
  });

  it("a smaller snapshot lands a gone", async () => {
    const dir = temp();
    const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const live = macStore(join(dir, "mac"));
    const full = await deliver(blobs, MAC_SOURCE, T1, sealSnapshot(live, join(dir, "full")));
    const db = new Database(live.db);
    db.exec(`
      DELETE FROM chat_message_join WHERE message_id IN (100, 105) OR chat_id = 12;
      DELETE FROM message WHERE ROWID IN (100, 105);
      DELETE FROM chat WHERE ROWID = 12;
    `);
    db.close();
    const smaller = await deliver(blobs, MAC_SOURCE, T2, sealSnapshot(live, join(dir, "smaller")));
    const home = openHome(openHomeFolder(dir), "migrate");
    try {
      const first = land(home, full, await collect(imessageConnector.read(full, blobs)), imessageConnector.kinds);
      const second = land(home, smaller, await collect(imessageConnector.read(smaller, blobs)), imessageConnector.kinds);
      expect(second.gone).toBe(0);
      const after = heads(home, MAC_SOURCE, KINDS);
      expect(after.length).toBe(first.new);
      for (const key of ["msg:SYNTH-MSG-PLAIN", "msg:SYNTH-MSG-RAW", "chat:SMS;-;XX-TESTBRAND(smsfp)", `chat-state:${MAC_UNIT}:SMS;-;XX-TESTBRAND(smsfp)`]) {
        expect(after.some((head) => `${head.kind}:${head.key}` === key), key).toBe(true);
      }
      artifact(dir, "smaller.json", { first, second, heads: after });
    } finally {
      home.close();
    }
  });

  it("a changes delivery is read as less than it holds", async () => {
    const home = openTestHome("imessage-changes-");
    const delivery = macBundle(home, MAC_SOURCE, new URL("./test/changes-bundle.zip", import.meta.url));
    expect(delivery.facts.kind).toBe("changes");
    const rows = await collect(imessageConnector.read(delivery, home.blobs));
    const path = join(home.dir, "messages.db");
    writeFileSync(path, home.blobs.bytes(delivery.files.find((file) => file.path === "messages.db")!.blob));
    const db = new Database(path, { readonly: true });
    const held = (sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);
    const count = (kind: string) => rows.filter((row) => row.kind === kind).length;
    expect(count("msg")).toBe(held("SELECT count(*) AS n FROM message"));
    expect(count("chat")).toBe(held("SELECT count(*) AS n FROM chat"));
    expect(count("chat-state")).toBe(count("chat"));
    expect(count("chat")).toBeGreaterThan(held("SELECT count(DISTINCT chat_id) AS n FROM chat_message_join"));
    db.close();
    const landed = await home.land(imessageConnector, delivery, rows);
    expect(landed.refused).toBe(0);
    expect(rows.filter((row) => (row.blobs ?? []).length > 0).length).toBe(1);
    artifact(home.dir, "changes.json", { counts: Object.fromEntries(KINDS.map((kind) => [kind, count(kind)])), landed: { new: landed.new } });
    home.close();
  });

  it("a duplicated key in one delivery goes unreported", async () => {
    const dir = temp();
    const live = macStore(join(dir, "mac"));
    const db = new Database(live.db);
    db.exec(`
      INSERT INTO message (ROWID, guid, text, handle_id, service, date, is_from_me) VALUES (300, 'SYNTH-MSG-GROUP', 'synthetic second copy', 2, 'iMessage', 800000009123456789, 0);
      INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (11, 300, 800000009123456789);
    `);
    db.close();
    const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const delivery = await deliver(blobs, MAC_SOURCE, T1, sealSnapshot(live, join(dir, "snapshot")));
    const home = openHome(openHomeFolder(dir), "migrate");
    try {
      const landed = land(home, delivery, await collect(imessageConnector.read(delivery, blobs)), imessageConnector.kinds);
      expect(landed.duplicated).toBe(1);
      const kept = heads(home, MAC_SOURCE, ["msg"]).find((head) => head.key === "SYNTH-MSG-GROUP");
      expect(kept?.start_ms).toBe(Date.UTC(2026, 4, 9, 6, 13, 29, 123));
      artifact(dir, "duplicated.json", { landed });
    } finally {
      home.close();
    }
  });

  it("a message whose date is unset (0 or NULL) is refused or placed on a made-up time", async () => {
    const dir = temp();
    const live = macStore(join(dir, "mac"));
    const db = new Database(live.db);
    db.exec("UPDATE message SET date = NULL WHERE ROWID = 100; UPDATE message SET date = 0 WHERE ROWID = 105");
    db.close();
    const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const delivery = await deliver(blobs, MAC_SOURCE, T1, sealSnapshot(live, join(dir, "snapshot")));
    const home = openHome(openHomeFolder(dir), "migrate");
    try {
      const landed = land(home, delivery, await rowsOf(delivery, blobs), imessageConnector.kinds);
      expect(landed.refused, JSON.stringify(landed.refusals)).toBe(0);
      const view = home.view();
      const unset = [...view.records(MAC_SOURCE, "msg")]
        .filter(({ head }) => head.key === "SYNTH-MSG-PLAIN" || head.key === "SYNTH-MSG-RAW")
        .map(({ head, version }) => [head.key, head.start_ms, (version.content as JsonObject).date]);
      view.close();
      expect(unset).toEqual([["SYNTH-MSG-PLAIN", null, null], ["SYNTH-MSG-RAW", null, 0]]);
      artifact(dir, "unset.json", { landed: landed.new, unset });
    } finally {
      home.close();
    }
  });

  it("a seconds-era database is read as nanoseconds", async () => {
    const dir = temp();
    const live = macStore(join(dir, "mac"));
    const db = new Database(live.db);
    db.exec("UPDATE message SET date = 800000000 WHERE ROWID = 100");
    db.close();
    const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const delivery = await deliver(blobs, MAC_SOURCE, T1, sealSnapshot(live, join(dir, "snapshot")));
    const rows = await rowsOf(delivery, blobs);
    const refused = rows.filter((row) => row.refused !== undefined).map((row) => `${row.key}: ${row.refused}`);
    expect(refused).toEqual(["message ROWID 100: message SYNTH-MSG-PLAIN.date 800000000 is not a nanosecond date"]);
    expect(rows.some((row) => row.kind === "msg" && row.key === "SYNTH-MSG-PLAIN")).toBe(false);
    expect(rows.filter((row) => row.kind === "msg").length).toBeGreaterThan(0);
    artifact(dir, "seconds.json", { refused, chat: GROUP_CHAT });
  });
});
