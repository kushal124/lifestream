import { artifact, collect, CONNECT_ROOT, deliver, openTestHome, parityOf, readGolden, writeZip } from "../../test/drive.js";
import { Refused } from "../../shared/refused.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { gmail } from "./reader.js";
import { ACCOUNT, IMAP_MESSAGES, imapPull, message, SOURCE, TAKEOUT_FACTS, takeoutFacts, takeoutMbox } from "./test/fixtures.js";

const TEST = join(CONNECT_ROOT, "mail", "gmail", "test");

describe("the gmail connector: each of these is impossible", () => {
  it("a synthetic delivery lands different heads than expected", async () => {
    const home = openTestHome();
    const pull = imapPull();
    const imap = await home.land(gmail, deliver(home, SOURCE, pull.files, pull.facts));
    const takeout = await home.land(gmail, deliver(home, SOURCE, { "Takeout/Mail/All mail.mbox": takeoutMbox() }, TAKEOUT_FACTS));
    expect(imap).toMatchObject({ new: 5, refused: 0, duplicated: 0 });
    expect(takeout).toMatchObject({ new: 5, refused: 0, duplicated: 0 });
    const held = home.heads(SOURCE);
    expect(held.map((head) => `${head.kind}:${head.key}`)).toEqual([
      "chat:1790000000000000201",
      "chat:1790000000000000203",
      ...IMAP_MESSAGES.map((entry) => `mailmsg:${entry.gm_msgid}`),
      "mailmsg:1790000000000000201",
      "mailmsg:1790000000000000202",
      "mailmsg:1790000000000000203",
    ].sort());
    const first = held.find((head) => head.key === IMAP_MESSAGES[0]!.gm_msgid)!;
    const blob = (first.content as { blobs: { hash: string }[] }).blobs[0]!.hash;
    expect(home.blobs.bytes(blob).equals(IMAP_MESSAGES[0]!.bytes)).toBe(true);
    artifact(home.dir, "heads.json", { imap, takeout, heads: held });
  });

  it("the parity golden differs", async () => {
    const home = openTestHome();
    const pull = imapPull();
    const imapRows = await collect(gmail.read(deliver(home, SOURCE, pull.files, pull.facts), home.blobs));
    const mbox = { "All mail Including Spam and Trash.mbox": takeoutMbox() };
    const takeoutRows = await collect(gmail.read(deliver(home, SOURCE, mbox, TAKEOUT_FACTS), home.blobs));
    const golden = {
      imap: parityOf(readGolden(join(TEST, "golden-imap.json"))),
      takeout: parityOf(readGolden(join(TEST, "golden-takeout.json"))),
    };
    const ours = { imap: parityOf(imapRows), takeout: parityOf(takeoutRows) };
    artifact(home.dir, "parity.json", { golden, ours });
    expect(ours).toEqual(golden);
  });

  it("a smaller snapshot lands a gone", async () => {
    const home = openTestHome();
    await home.land(gmail, deliver(home, SOURCE, { "a.mbox": takeoutMbox() }, TAKEOUT_FACTS));
    const smaller = takeoutMbox().subarray(0, takeoutMbox().indexOf("From 1790000000000000203@xxx"));
    const later = await home.land(gmail, deliver(home, SOURCE, { "a.mbox": smaller }, takeoutFacts(SOURCE, "2026-09-20T00:00:00Z")));
    const pull = imapPull(IMAP_MESSAGES.slice(0, 1), "2026-09-21T00:00:00.000Z");
    const imap = await home.land(gmail, deliver(home, SOURCE, pull.files, pull.facts));
    expect(later.gone).toBe(0);
    expect(imap.gone).toBe(0);
    const held = home.heads(SOURCE);
    expect(held.filter((head) => head.gone)).toEqual([]);
    expect(held.map((head) => head.key)).toContain("1790000000000000203");
    artifact(home.dir, "heads.json", { later, imap, heads: held });
  });

  it("a duplicated key in one delivery goes unreported", async () => {
    const home = openTestHome();
    const once = takeoutMbox();
    const again = Buffer.concat([once, once.subarray(0, once.indexOf("From 1790000000000000202@xxx"))]);
    const landed = await home.land(gmail, deliver(home, SOURCE, { "a.mbox": again }, TAKEOUT_FACTS));
    expect(landed.duplicated).toBeGreaterThanOrEqual(1);
    const thread = home.heads(SOURCE).find((head) => head.kind === "chat" && head.key === "1790000000000000201")!;
    expect((thread.content as { messages: string[] }).messages).toEqual(["1790000000000000201", "1790000000000000202"]);
    artifact(home.dir, "landed.json", landed);
  });

  it("a mailbox the connector cannot read is skipped unnamed, so the sweep may delete its only copy", async () => {
    const home = openTestHome();
    const damaged = Buffer.concat([Buffer.from("Frm damaged delimiter\r\n"), takeoutMbox()]);
    const zip = join(home.dir, "takeout.zip");
    writeZip(zip, [
      { name: "Takeout/Mail/Damaged.mbox", bytes: damaged, method: "deflate" },
      { name: "Takeout/My Activity/Search/MyActivity.json", bytes: Buffer.from("[]"), method: "deflate" },
    ]);
    const files = { "a.mbox": takeoutMbox(), "b.mbox": damaged, "takeout-001.zip": readFileSync(zip) };
    const landed = await home.land(gmail, deliver(home, SOURCE, files, TAKEOUT_FACTS));
    expect(landed).toMatchObject({ new: 5, refused: 2 });
    expect(landed.refusals).toEqual([
      { kind: "file", key: "b.mbox", violations: [expect.stringContaining("is not Gmail's delimiter")] },
      { kind: "file", key: "takeout-001.zip/Takeout/Mail/Damaged.mbox", violations: [expect.stringContaining("is not Gmail's delimiter")] },
    ]);
    artifact(home.dir, "unreadable.json", landed);
  });

  it("a message it cannot read, or a mailbox whose bytes break, refuses more than itself", async () => {
    const home = openTestHome();
    const threadless = Buffer.from(takeoutMbox().toString("latin1").replace("X-GM-THRID: 1790000000000000201\r\nX-Gmail-Labels: Sent", "X-Gmail-Labels: Sent"), "latin1");
    const one = await home.land(gmail, deliver(home, SOURCE, { "a.mbox": threadless }, TAKEOUT_FACTS));
    expect(one).toMatchObject({ new: 4, refused: 1 });
    expect(one.refusals).toEqual([{ kind: "file", key: expect.stringMatching(/^a\.mbox:message 1 at byte \d+$/u), violations: [expect.stringContaining("states no decimal X-GM-THRID header")] }]);
    expect(home.heads(SOURCE, ["mailmsg"]).map((head) => head.key)).toEqual(["1790000000000000201", "1790000000000000203"]);
    const scratch = openTestHome();
    const zip = join(scratch.dir, "takeout.zip");
    writeZip(zip, [{ name: "Takeout/Mail/All mail.mbox", bytes: takeoutMbox(), method: "stored" }]);
    const damaged = readFileSync(zip);
    damaged[damaged.indexOf("A synthetic body.")] = "a".charCodeAt(0);
    const broken = await scratch.land(gmail, deliver(scratch, SOURCE, { "a.mbox": takeoutMbox(), "takeout.zip": damaged }, TAKEOUT_FACTS));
    expect(broken).toMatchObject({ new: 5, refused: 1 });
    expect(broken.refusals[0]).toMatchObject({ kind: "file", key: "takeout.zip/Takeout/Mail/All mail.mbox" });
    artifact(home.dir, "refused.json", { one, broken });
  });

  it("an mbox inside a Takeout ZIP reads differently from the same mbox as a file", async () => {
    const home = openTestHome();
    const zip = join(home.dir, "takeout.zip");
    writeZip(zip, [{ name: "Takeout/Mail/All mail Including Spam and Trash.mbox", bytes: takeoutMbox(), method: "deflate" }]);
    const zipped = await collect(gmail.read(deliver(home, SOURCE, { "takeout-001.zip": readFileSync(zip) }, TAKEOUT_FACTS), home.blobs));
    const plain = await collect(gmail.read(deliver(home, SOURCE, { "a.mbox": takeoutMbox() }, TAKEOUT_FACTS), home.blobs));
    expect(parityOf(zipped)).toEqual(parityOf(plain));
    expect(zipped[0]!.locator).toBe("takeout-001.zip/Takeout/Mail/All mail Including Spam and Trash.mbox:message 0 at byte 0");
    artifact(home.dir, "rows.json", parityOf(zipped));
  });

  it("a broken local header of another product's ZIP member prevents the mail beside it from landing", async () => {
    const home = openTestHome();
    const zip = join(home.dir, "takeout.zip");
    writeZip(zip, [
      { name: "Takeout/Photos/photo.jpg", bytes: Buffer.from("synthetic photo"), method: "deflate" },
      { name: "Takeout/Mail/All mail.mbox", bytes: takeoutMbox(), method: "deflate" },
    ]);
    const damaged = readFileSync(zip);
    damaged.writeUInt16LE(0xffff, 26);
    const landed = await home.land(gmail, deliver(home, SOURCE, { "takeout.zip": damaged }, TAKEOUT_FACTS));
    expect(landed).toMatchObject({ new: 5, refused: 1 });
    expect(landed.refusals).toEqual([{ kind: "file", key: "takeout.zip/Takeout/Photos/photo.jpg", violations: [expect.stringContaining("Takeout/Photos/photo.jpg: its data runs into the central directory")] }]);
    artifact(home.dir, "damaged-member.json", { landed, heads: home.heads(SOURCE) });
  });

  it("two accounts on one export lane read each other's mailbox", async () => {
    const home = openTestHome();
    const other = "gmail:person-b@example.com:cloud";
    const delivery = deliver(home, other, { "mail.mbox": takeoutMbox() }, { ...takeoutFacts(other), account: "person-b@example.com" });
    const skipped = await home.land(gmail, { ...delivery, source: SOURCE });
    const landed = await home.land(gmail, delivery);
    expect(skipped).toMatchObject({ new: 0, refused: 0 });
    expect(home.heads(SOURCE)).toEqual([]);
    expect(landed).toMatchObject({ new: 5, refused: 0 });
    artifact(home.dir, "accounts.json", { skipped, landed, heads: home.heads(other) });
  });

  it("a Takeout row hands the home bytes other than its blob, or more than one message at a time", async () => {
    const home = openTestHome();
    const zip = join(home.dir, "takeout.zip");
    writeZip(zip, [{ name: "Takeout/Mail/All mail.mbox", bytes: takeoutMbox(), method: "deflate" }]);
    const golden = new Set(
      readGolden(join(TEST, "golden-takeout.json")).flatMap((record) => ((record.content as { blobs?: { hash: string }[] }).blobs ?? []).map((blob) => blob.hash)),
    );
    const checked: Record<string, string[]> = {};
    for (const [name, files] of [
      ["plain", { "a.mbox": takeoutMbox() }],
      ["zipped", { "takeout-001.zip": readFileSync(zip) }],
    ] as const) {
      const hashes: string[] = [];
      for await (const row of gmail.read(deliver(home, SOURCE, files, TAKEOUT_FACTS), home.blobs)) {
        if (row.kind !== "mailmsg") {
          expect(row.bytes).toBeUndefined();
          continue;
        }
        expect(row.bytes).toHaveLength(1);
        const hash = `sha256:${createHash("sha256").update(row.bytes![0]!).digest("hex")}`;
        expect(row.blobs).toEqual([hash]);
        expect((row.content as { blobs: { hash: string; bytes: number }[] }).blobs[0]).toMatchObject({ hash, bytes: row.bytes![0]!.length });
        hashes.push(hash);
      }
      expect(new Set(hashes)).toEqual(golden);
      checked[name] = hashes;
    }
    const pull = imapPull();
    expect((await collect(gmail.read(deliver(home, SOURCE, pull.files, pull.facts), home.blobs))).every((row) => row.bytes === undefined)).toBe(true);
    artifact(home.dir, "bytes.json", checked);
  });

  it("a pull is read for another account, or with bytes other than its manifest states", async () => {
    const home = openTestHome();
    const pull = imapPull();
    const elsewhere = "gmail:person-b@example.com:cloud";
    const other = deliver(home, elsewhere, pull.files, { ...pull.facts, sources: [{ id: elsewhere, connector: "gmail-imap" }] });
    await expect(collect(gmail.read(other, home.blobs))).rejects.toThrow(Refused);
    const swapped = { ...pull.files, [`msg-${IMAP_MESSAGES[0]!.gm_msgid}.eml`]: message(["Subject: other bytes"], ["x"]) };
    await expect(collect(gmail.read(deliver(home, SOURCE, swapped, pull.facts), home.blobs))).rejects.toThrow(/does not match the hash/u);
    artifact(home.dir, "refusals.json", { account: ACCOUNT });
  });

  it("a delivery is read by another route than the feeder it names", async () => {
    const home = openTestHome();
    const pull = imapPull();
    const { "pull.json": _, ...messages } = pull.files;
    await expect(collect(gmail.read(deliver(home, SOURCE, messages, pull.facts), home.blobs))).rejects.toThrow(/an IMAP pull holds pull\.json/u);
    const named = await home.land(gmail, deliver(home, SOURCE, { "pull.json": takeoutMbox() }, TAKEOUT_FACTS));
    expect(named).toMatchObject({ new: 5, refused: 0 });
    const unknown = { ...TAKEOUT_FACTS, sources: [{ id: SOURCE, connector: "gmail-upload" }] };
    await expect(collect(gmail.read(deliver(home, SOURCE, { "a.mbox": takeoutMbox() }, unknown), home.blobs))).rejects.toThrow(/names feeder "gmail-upload"/u);
    const unnamed = deliver(home, SOURCE, { "a.mbox": takeoutMbox() }, { exported_at: "2026-09-08T00:00:00Z" });
    await expect(collect(gmail.read(unnamed, home.blobs))).rejects.toThrow(/names no feeder for gmail:person-a@example\.com:cloud/u);
    expect(await collect(gmail.read({ ...unnamed, id: "upload:local:macbook-pro-0001/20260908T000000Z" }, home.blobs))).toEqual([]);
    artifact(home.dir, "routes.json", named);
  });
});
