import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openHome, openHomeFolder, type HomeDb } from "@lifestreamprotocol/core";
import { LANE } from "./jobs.js";
import { lookAtInbox } from "./import.js";
import { makeRoot, readHome, removeRoot } from "./test/harness-root.js";

describe("the inbox look asked for: queued, or an error while it is dead", () => {
  const now = Date.UTC(2026, 9, 6, 12);
  let root: string;
  let db: HomeDb;
  const look = () => readHome(root, (home) => home.prepare("SELECT state, lane FROM jobs WHERE kind = 'index-inbox' AND key = 'inbox'").get());

  beforeAll(() => {
    root = makeRoot("lifestream-inbox-look-", { sources: {} });
    db = openHome(openHomeFolder(root), "migrate");
  });

  afterAll(() => {
    db.close();
    removeRoot(root);
  });

  it("queued in the polls lane when it is not dead", () => {
    db.commit((tx) => lookAtInbox(tx, now));
    expect(look()).toEqual({ state: "queued", lane: LANE.polls });
  });

  it("dead: the commit throws, naming the look, and writes nothing; revived, it is queued again", () => {
    const writer = new Database(join(root, "home.db"));
    writer.prepare("UPDATE jobs SET state = 'dead' WHERE kind = 'index-inbox' AND key = 'inbox'").run();
    writer.close();
    expect(() => db.commit((tx) => lookAtInbox(tx, now))).toThrow("the inbox look (index-inbox inbox) is dead");
    expect(look()).toEqual({ state: "dead", lane: LANE.polls });
    db.commit((tx) => tx.tables.jobs.revive(now));
    db.commit((tx) => lookAtInbox(tx, now));
    expect(look()).toEqual({ state: "queued", lane: LANE.polls });
  });
});
