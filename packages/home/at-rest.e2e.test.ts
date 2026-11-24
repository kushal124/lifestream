import { chmodSync, statSync } from "node:fs";
import { describe, expect, it, onTestFinished } from "vitest";
import { AT_REST_META, type RestReader } from "./at-rest.js";
import { makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { startHere } from "./test/harness-home.js";
import { statusOf } from "./test/harness-status.js";

const PLAIN = `<plist version="1.0"><dict><key>FilesystemType</key><string>apfs</string><key>Encryption</key><false/><key>GlobalPermissionsEnabled</key><false/></dict></plist>`;

function root(prefix: string): string {
  const made = makeRoot(prefix, { sources: {} });
  onTestFinished(() => removeRoot(made));
  return made;
}

describe("a home's disks at its start", () => {
  it("closes a loose folder, reads its disks off the loop and lists what they ask; with no reader, nothing", async () => {
    const folder = root("lifestream-at-rest-");
    chmodSync(folder, 0o755);
    const ran: string[] = [];
    const reader: RestReader = {
      platform: "darwin",
      device: (path) => (path === folder ? 1 : 2),
      run: async (program, args) => {
        ran.push(program);
        if (program === "df") return { code: 0, out: "Filesystem\n/dev/disk9s1 1 1 1 1% /Volumes/Synthetic\n" };
        if (program === "diskutil") return { code: 0, out: PLAIN };
        return { code: 0, out: args[0] === "status" ? "FileVault is Off.\n" : "" };
      },
    };
    await startHere(folder, { tickMs: TICK_MS, slot: null, log: () => undefined, rest: reader });
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    await until("the reading is kept", () => readHome(folder, (db) => db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(AT_REST_META)) !== undefined);
    expect(statusOf(folder).needs.filter((need) => need.id.startsWith("rest:")).map((need) => need.id)).toEqual(["rest:machine", "rest:home", "rest:owners", "rest:machine-owners"]);
    expect([...new Set(ran)].sort()).toEqual(["df", "diskutil", "fdesetup"]);

    const unread = root("lifestream-at-rest-none-");
    await startHere(unread, { tickMs: TICK_MS, slot: null, log: () => undefined });
    await until("the home has ticked", () => readHome(unread, (db) => db.prepare("SELECT count(*) FROM events").pluck().get() as number) > 0);
    expect([readHome(unread, (db) => db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(AT_REST_META)), statusOf(unread).needs.filter((need) => need.id.startsWith("rest:"))]).toEqual([undefined, []]);
  });
});
