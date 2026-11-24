import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { BlobStore, Delivery, JsonObject } from "@lifestreamprotocol/core";
import { artifact, collect, damageOverflow, deliver, macBundle, openTestHome, type TestHome } from "../../test/drive.js";
import { appleReminders } from "./reader.js";
import { bytes, CLOUD_STORE, CLOUD_USER, createCloudStore, createLocalStore, DAY, DAY0, IDS, LOCAL_ACCOUNT, LOCAL_STORE, renumbered, SOURCE, write } from "./test/fixture.js";

const THROUGH = 4;
const SNAPSHOT = { snapshot_taken_at: "2026-09-23T04:00:00.000Z", kind: "snapshot", through: THROUGH };

function stores(home: TestHome): { cloud: string; local: string } {
  const cloud = join(home.dir, CLOUD_STORE);
  const local = join(home.dir, LOCAL_STORE);
  createCloudStore(cloud);
  createLocalStore(local);
  return { cloud, local };
}

function shipped(blobs: BlobStore, paths: { cloud: string; local: string }, facts: JsonObject = SNAPSHOT, swapped = false): Delivery {
  const [cloud, local] = swapped ? [LOCAL_STORE, CLOUD_STORE] : [CLOUD_STORE, LOCAL_STORE];
  return deliver(blobs, SOURCE, { [cloud]: readFileSync(paths.cloud), [local]: readFileSync(paths.local) }, facts);
}

const ms = (seconds: number): number => (seconds + 978_307_200) * 1000;
const upper = (uuid: string): string => uuid.toUpperCase();
const cloudKey = (uuid: string): string => `${upper(uuid)}:${CLOUD_USER}`;
const localKey = (uuid: string): string => `${upper(uuid)}:${LOCAL_ACCOUNT}`;
const withoutAccount = (key: string): string => key.slice(0, key.lastIndexOf(":"));

describe("Apple Reminders: each of these is impossible", () => {
  it("a synthetic delivery lands different heads than expected, or drops a field the store states", async () => {
    const home = openTestHome();
    try {
      const paths = stores(home);
      const landed = await home.land(appleReminders, shipped(home.blobs, paths));
      expect(landed).toMatchObject({ new: 5, refused: 0, duplicated: 0 });
      const heads = home.heads(SOURCE);
      expect(heads.map((head) => [head.key, head.start_ms, head.end_ms])).toEqual([
        [cloudKey(IDS.dueAllDay), Date.parse("2026-09-23T00:00:00Z"), Date.parse("2026-09-24T00:00:00Z")],
        [cloudKey(IDS.dueTimed), ms(DAY0 + DAY + 30_600), null],
        [cloudKey(IDS.undated), null, null],
        [cloudKey(IDS.subtask), null, null],
        [localKey(IDS.local), ms(DAY0 + 2 * DAY + 3_600), null],
      ]);
      const first = heads[0]!.content as JsonObject;
      const record = first.reminder as JsonObject;
      expect(record).toMatchObject({ ZTITLE: "Fake errand", ZNOTES: "Fake note", ZFLAGGED: 1, ZCKIDENTIFIER: upper(IDS.dueAllDay), ZTITLEDOCUMENT: { $bytes64: "AQI=" } });
      for (const column of ["Z_PK", "Z_OPT", "ZCKCLOUDSTATE", "ZCKSERVERRECORDDATA", "ZSPOTLIGHTINDEXCOUNT", "ZLIST", "ZACCOUNT"]) expect(record).not.toHaveProperty(column);
      expect(first.list).toMatchObject({ entity: "REMCDList", ZNAME: "Fake list", ZCKIDENTIFIER: "SYNTH-LIST-0001" });
      expect(first.list).not.toHaveProperty("ZREMINDERIDSMERGEABLEORDERING_V2_JSON");
      expect(first.account).toMatchObject({ entity: "REMCDAccount", ZNAME: "iCloud", ZTYPE: 2, ZPERSONID: "PRIMARY-CLOUDKIT" });
      const alarm = (first.objects as JsonObject[])[0]!;
      expect(first.objects).toHaveLength(1);
      expect(alarm).toMatchObject({ entity: "REMCDAlarm", ZALARMUID: "SYNTH-ALARM-0001", ZCKIDENTIFIER: "SYNTH-ALARM-0001" });
      expect(alarm.trigger).toMatchObject({ entity: "REMCDAlarmDateTrigger", ZCKIDENTIFIER: "SYNTH-TRIGGER-0001", ZDATECOMPONENTSDATA: { $bytes64: "Cgs=" } });
      for (const column of ["ZREMINDER", "ZTRIGGER", "Z16_TRIGGER", "ZCKSERVERRECORDDATA"]) expect(alarm).not.toHaveProperty(column);
      const timed = heads[1]!.content as JsonObject;
      expect(timed.objects).toEqual([expect.objectContaining({ entity: "REMCDHashtag", ZNAME1: "work" })]);
      expect(timed.alerts).toEqual([expect.objectContaining({ ZDUEDATEDELTACOUNT: 1, ZDUEDATEDELTAUNIT: 2 })]);
      expect((heads[3]!.content as JsonObject).parent).toBe(upper(IDS.dueAllDay));
      expect((heads[4]!.content as JsonObject).account).toMatchObject({ ZNAME: "Local", ZINACTIVE: 1 });
      artifact(home.dir, "heads.json", { landed, heads });
    } finally {
      home.close();
    }
  });

  it("the same delivery again writes a new version", async () => {
    const home = openTestHome();
    try {
      const paths = stores(home);
      await home.land(appleReminders, shipped(home.blobs, paths));
      const again = await home.land(appleReminders, shipped(home.blobs, paths, { ...SNAPSHOT, snapshot_taken_at: "2026-09-24T04:00:00.000Z" }));
      expect(again).toMatchObject({ new: 0, changed: 0, restated: 5, gone: 0 });
      artifact(home.dir, "again.json", again);
    } finally {
      home.close();
    }
  });

  it("an edit is missed, a sync of the same reminder moves its head, or a purged reminder lands a gone", async () => {
    const home = openTestHome();
    try {
      const paths = stores(home);
      await home.land(appleReminders, shipped(home.blobs, paths));
      write(paths.cloud, "UPDATE ZREMCDREMINDER SET ZCOMPLETED = 1, ZCOMPLETIONDATE = 811900000.5, Z_OPT = Z_OPT + 1 WHERE Z_PK = 1");
      write(paths.cloud, "UPDATE ZREMCDREMINDER SET ZCKSERVERRECORDDATA = X'FF', ZCKCLOUDSTATE = 9, Z_OPT = Z_OPT + 1 WHERE Z_PK = 2");
      write(paths.cloud, "UPDATE ZREMCDBASELIST SET ZREMINDERIDSMERGEABLEORDERING_V2_JSON = X'5B315D'");
      write(paths.local, "DELETE FROM ZREMCDREMINDER WHERE Z_PK = 1");
      const facts = { snapshot_taken_at: "2026-09-23T04:05:00.000Z", kind: "delta", after: THROUGH, through: THROUGH + 4 };
      const landed = await home.land(appleReminders, shipped(home.blobs, paths, facts));
      expect(landed).toMatchObject({ changed: 1, new: 0, restated: 3, gone: 0 });
      expect(landed.changedPaths).toEqual({ "reminder.ZCOMPLETED": 1, "reminder.ZCOMPLETIONDATE": 1 });
      expect(home.heads(SOURCE).find((head) => head.key === localKey(IDS.local))!.gone).toBe(false);
      artifact(home.dir, "delta.json", landed);
    } finally {
      home.close();
    }
  });

  it("a changes delivery is read as less than it holds", async () => {
    const home = openTestHome();
    try {
      const changes = macBundle(home, SOURCE, new URL("./test/changes-bundle.zip", import.meta.url));
      expect(changes.facts.kind).toBe("changes");
      const store = changes.files.find((each) => each.path.startsWith("Data-"))!;
      const file = join(home.dir, "changes.sqlite");
      writeFileSync(file, home.blobs.bytes(store.blob));
      const db = new Database(file, { readonly: true });
      const reminders = Number((db.prepare("SELECT count(*) AS n FROM ZREMCDREMINDER").get() as { n: number }).n);
      db.close();
      const rows = await collect(appleReminders.read(changes, home.blobs));
      expect(rows.length).toBe(reminders);
      expect(await home.land(appleReminders, changes, rows)).toMatchObject({ refused: 0 });
      artifact(home.dir, "changes.json", { reminders, rows: rows.length });
    } finally {
      home.close();
    }
  });

  it("a store lacking what this connector reads is read, or another source's file refuses the delivery", async () => {
    const home = openTestHome();
    try {
      const paths = stores(home);
      const db = new Database(paths.local);
      db.exec("ALTER TABLE ZREMCDREMINDER DROP COLUMN ZDUEDATE");
      db.close();
      await expect(collect(appleReminders.read(shipped(home.blobs, paths), home.blobs))).rejects.toThrow(
        new RegExp(`${LOCAL_STORE.replaceAll(".", "\\.")} ZREMCDREMINDER lacks columns this connector reads: ZDUEDATE`, "u"),
      );
      const other = deliver(home.blobs, SOURCE, { "notes.sqlite": Buffer.from("x") }, SNAPSHOT);
      expect(await collect(appleReminders.read(other, home.blobs))).toEqual([]);
    } finally {
      home.close();
    }
  });

  it("one account's store that does not open refuses the other account's reminders", async () => {
    const home = openTestHome();
    try {
      const paths = stores(home);
      const landed = await home.land(appleReminders, deliver(home.blobs, SOURCE, { [CLOUD_STORE]: Buffer.from("no database at all"), [LOCAL_STORE]: readFileSync(paths.local) }, SNAPSHOT));
      expect(landed).toMatchObject({ new: 1, refused: 1 });
      expect(landed.refusals.map((refusal) => `${refusal.key} ${refusal.violations.join()}`)).toEqual([expect.stringMatching(new RegExp(`^${CLOUD_STORE.replaceAll(".", "\\.")} .*does not open as a SQLite database`, "u"))]);
      expect(home.heads(SOURCE).map((head) => head.key)).toEqual([localKey(IDS.local)]);
      artifact(home.dir, "one-store.json", landed);
    } finally {
      home.close();
    }
  });

  it("a reminder with no identifier is dropped unreported, or one with nothing to name it by lands", async () => {
    const home = openTestHome();
    try {
      const paths = stores(home);
      write(paths.cloud, `INSERT INTO ZREMCDREMINDER (Z_PK, Z_ENT, Z_OPT, ZACCOUNT, ZLIST, ZTITLE, ZCREATIONDATE) VALUES (5, 39, 1, 1, 1, 'Fake unnamed', ${DAY0});
                          INSERT INTO ZREMCDREMINDER (Z_PK, Z_ENT, Z_OPT, ZACCOUNT, ZLIST) VALUES (6, 39, 1, 1, 1)`);
      const facts = { ...SNAPSHOT, through: THROUGH + 1 };
      const landed = await home.land(appleReminders, shipped(home.blobs, paths, facts));
      expect(landed).toMatchObject({ new: 6, refused: 1 });
      const fingerprinted = home.heads(SOURCE).filter((head) => !/^[0-9A-F-]{36}$/u.test(withoutAccount(head.key)));
      expect(fingerprinted.map((head) => (head.content as { reminder: JsonObject }).reminder.ZTITLE)).toEqual(["Fake unnamed"]);
      artifact(home.dir, "unnamed.json", landed);
    } finally {
      home.close();
    }
  });

  it("one identifier in two stores lands under keys that move when the first copy is deleted, the rows are renumbered or the stores are renamed", async () => {
    const home = openTestHome();
    try {
      const paths = stores(home);
      write(paths.local, `INSERT INTO ZREMCDREMINDER (Z_PK, Z_ENT, Z_OPT, ZALLDAY, ZCOMPLETED, ZACCOUNT, ZLIST, ZCREATIONDATE, ZTITLE, ZIDENTIFIER)
                          VALUES (2, 39, 1, 0, 0, 1, 1, ${DAY0 + 1200}, 'Fake someday, local copy', ${bytes(IDS.undated)})`);
      const landed = await home.land(appleReminders, shipped(home.blobs, paths, { ...SNAPSHOT, through: THROUGH + 1 }));
      expect(landed).toMatchObject({ new: 6, duplicated: 0 });
      const first = home.heads(SOURCE);
      expect(first.filter((head) => withoutAccount(head.key) === upper(IDS.undated)).map((head) => head.key)).toEqual([localKey(IDS.undated), cloudKey(IDS.undated)]);

      renumbered(paths.cloud);
      const again = await home.land(appleReminders, shipped(home.blobs, paths, { snapshot_taken_at: "2026-09-23T04:05:00.000Z", kind: "delta", after: THROUGH + 1, through: THROUGH + 2 }, true));
      expect(again).toMatchObject({ new: 0, changed: 0, restated: 6, gone: 0, duplicated: 0 });
      expect(home.heads(SOURCE).map((head) => [head.key, head.version])).toEqual(first.map((head) => [head.key, head.version]));

      write(paths.local, "DELETE FROM ZREMCDREMINDER WHERE Z_PK = 2");
      const after = await home.land(appleReminders, shipped(home.blobs, paths, { snapshot_taken_at: "2026-09-23T04:10:00.000Z", kind: "delta", after: THROUGH + 2, through: THROUGH + 3 }, true));
      expect(after).toMatchObject({ new: 0, changed: 0, restated: 5, gone: 0, duplicated: 0 });
      const survivor = first.find((head) => head.key === cloudKey(IDS.undated))!;
      expect(home.heads(SOURCE).find((head) => head.key === survivor.key)!.version).toBe(survivor.version);
      artifact(home.dir, "copies.json", { first: first.map((head) => [head.key, head.version]), again, after });
    } finally {
      home.close();
    }
  });

  it("one key twice in one delivery lands a version chosen by the order of the store's rows", async () => {
    const home = openTestHome();
    try {
      const twice = (pk: number) => "INSERT INTO ZREMCDREMINDER (Z_PK, Z_ENT, Z_OPT, ZALLDAY, ZCOMPLETED, ZACCOUNT, ZLIST, ZCREATIONDATE, ZTITLE, ZNOTES, ZIDENTIFIER) " +
        `VALUES (${pk}, 39, 1, 0, 0, 1, 1, ${DAY0 + 1200}, 'Fake someday', 'Fake second copy', ${bytes(IDS.undated)})`;
      const heads: [string, string][][] = [];
      for (const [name, rebuild, pk] of [["after", false, 9], ["before", true, 1]] as const) {
        const paths = { cloud: join(home.dir, `${name}-${CLOUD_STORE}`), local: join(home.dir, `${name}-${LOCAL_STORE}`) };
        createCloudStore(paths.cloud);
        createLocalStore(paths.local);
        if (rebuild) renumbered(paths.cloud);
        write(paths.cloud, twice(pk));
        const each = openTestHome();
        try {
          const landed = await each.land(appleReminders, shipped(each.blobs, paths, { ...SNAPSHOT, through: THROUGH + (rebuild ? 2 : 1) }));
          expect(landed).toMatchObject({ new: 5, duplicated: 1, refused: 0 });
          heads.push(each.heads(SOURCE).map((head) => [head.key, head.version]));
        } finally {
          each.close();
        }
      }
      expect(heads[1]).toEqual(heads[0]);
      artifact(home.dir, "twice.json", heads[0]);
    } finally {
      home.close();
    }
  });

  it("a reminder the store cannot return is dropped, refused twice, or holds back the copy that shares its key", async () => {
    const home = openTestHome();
    try {
      const paths = stores(home);
      write(paths.cloud,
        "INSERT INTO ZREMCDREMINDER (Z_PK, Z_ENT, Z_OPT, ZALLDAY, ZCOMPLETED, ZACCOUNT, ZLIST, ZCREATIONDATE, ZTITLE, ZIDENTIFIER, ZCKSERVERRECORDDATA) " +
        `VALUES (9, 39, 1, 0, 0, 1, 1, ${DAY0 + 1200}, 'Fake someday', ${bytes(IDS.undated)}, randomblob(20000)); ` +
        "INSERT INTO ZREMCDREMINDER (Z_PK, Z_ENT, Z_OPT, ZALLDAY, ZCOMPLETED, ZACCOUNT, ZLIST, ZCREATIONDATE, ZTITLE, ZNOTES, ZIDENTIFIER) " +
        `VALUES (10, 39, 1, 0, 0, 1, 1, ${DAY0 + 1300}, 'Fake unreadable', hex(randomblob(10000)), ${bytes("11111111-2222-4333-8444-000000000099")})`);
      damageOverflow(paths.cloud, "ZREMCDREMINDER");
      const landed = await home.land(appleReminders, shipped(home.blobs, paths, { ...SNAPSHOT, through: THROUGH + 1 }));
      expect(landed).toMatchObject({ new: 5, refused: 2 });
      expect(landed.refusals.map((refusal) => `${refusal.key}: ${refusal.violations.join("; ")}`).sort()).toEqual([
        expect.stringMatching(new RegExp(`^${CLOUD_STORE} ZREMCDREMINDER Z_PK 10: SQLite cannot return it: SQLITE_CORRUPT`, "u")),
        expect.stringMatching(new RegExp(`^${CLOUD_STORE} ZREMCDREMINDER Z_PK 9: SQLite cannot return it: SQLITE_CORRUPT`, "u")),
      ]);
      expect(home.heads(SOURCE).map((head) => head.key.split(":")[0])).toContain(IDS.undated);
      artifact(home.dir, "damaged.json", { landed, keys: home.heads(SOURCE).map((head) => head.key) });
    } finally {
      home.close();
    }
  });

  it("an account named with a ':', or by no CloudKit user, or a reminder with no account, makes a key whose account is not its last part", async () => {
    const home = openTestHome();
    try {
      const paths = stores(home);
      write(paths.cloud, `UPDATE ZREMCDOBJECT SET ZCKUSERRECORDNAME = 'fake:100%' WHERE Z_PK = 1;
                          UPDATE ZREMCDREMINDER SET ZACCOUNT = NULL WHERE Z_PK = 3`);
      const rows = await collect(appleReminders.read(shipped(home.blobs, paths, { ...SNAPSHOT, through: THROUGH + 1 }), home.blobs));
      const keys = Object.fromEntries(rows.map((row) => [row.locator, row.key]));
      expect(keys[`${CLOUD_STORE} ZREMCDREMINDER row 1`]).toBe(`${upper(IDS.dueAllDay)}:fake%3A100%25`);
      expect(keys[`${CLOUD_STORE} ZREMCDREMINDER row 3`]).toBe(`${upper(IDS.undated)}:`);
      expect(keys[`${LOCAL_STORE} ZREMCDREMINDER row 1`]).toBe(localKey(IDS.local));
      expect(withoutAccount(keys[`${CLOUD_STORE} ZREMCDREMINDER row 1`]!)).toBe(upper(IDS.dueAllDay));
      artifact(home.dir, "names.json", keys);
    } finally {
      home.close();
    }
  });
});
