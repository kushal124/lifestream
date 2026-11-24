import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { declarations } from "@lifestreamprotocol/connect";
import { openHome, openHomeFolder, type ReaderOutput } from "@lifestreamprotocol/core";
import type { Principal } from "./principals.js";
import { restore } from "./restore.js";

const dir = mkdtempSync(join(tmpdir(), "lifestream-restore-"));
afterAll(() => {
  if (process.env.LIFESTREAM_KEEP_ARTIFACTS === "1") console.log(`restore artifact kept: ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
});

const UNIT = "iphone-17-pro-aa01";
const BOOK = `apple-contacts:person-a@example.com:${UNIT}`;
const OTHER = "apple-contacts:person-a@example.com:iphone-aa02";
const card = (key: string): ReaderOutput => ({ kind: "contact", key, content: { type: "contacts.card", card: `BEGIN:VCARD\r\nFN:${key}\r\nEND:VCARD\r\n` } });

describe("the restore's contacts: each of these is impossible", () => {
  it("a live identifier missing, a gone one, another unit's or another kind's given, or more than the keys", () => {
    const db = openHome(openHomeFolder(dir), "migrate");
    try {
      const land = (source: string, stated_ms: number, rows: ReaderOutput[]) => db.commit((tx) => {
        const run = tx.tables.runs.start({ kind: "import", subject: source, started_ms: stated_ms });
        tx.records.land(run, { id: `${source}/${stated_ms}`, source, stated_ms }, rows, { contact: () => [], other: () => [] }, { has: () => true });
        tx.tables.runs.end(run, { ended_ms: stated_ms, outcome: "ok" });
      });
      land(BOOK, 1_000, [card("C-1:ABPerson"), card("C-2:ABPerson"), card("C-3:ABPerson"), { kind: "other", key: "C-4:ABPerson", content: {} }]);
      land(BOOK, 2_000, [{ kind: "contact", key: "C-2:ABPerson", content: null, gone: true }]);
      land(OTHER, 1_000, [card("C-9:ABPerson")]);
      const pass = { id: "p-0000aa01", unit: UNIT } as Principal;
      const delivers = [BOOK, OTHER, `location:local:${UNIT}`];
      const view = db.view();
      const answer = (() => {
        try {
          return restore(view, declarations(), pass, delivers, {});
        } finally {
          view.close();
        }
      })();
      expect(answer.contacts).toEqual({ [BOOK]: ["C-1:ABPerson", "C-3:ABPerson"] });
      const none = db.view();
      try {
        expect(restore(none, declarations(), pass, [`location:local:${UNIT}`], {}).contacts).toEqual({});
      } finally {
        none.close();
      }
      writeFileSync(join(dir, "restore.json"), `${JSON.stringify(answer, null, 2)}\n`);
    } finally {
      db.close();
    }
  });
});
