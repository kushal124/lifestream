import { artifact, collect, deliver, LENT, memorySecrets, openTestHome, poll, temp, type PollRecord, type TestHome } from "../../test/drive.js";
import { describe, expect, it } from "vitest";
import { canonical } from "@lifestreamprotocol/core";
import { NeedsYou, NotYet, type SignedIn } from "../../seams.js";
import { offline } from "../../shared/offline.js";
import { Refused } from "../../shared/refused.js";
import { CHARGED, gmailImapAcquirer, gmailSignedIn, type GmailImapSettings, type GmailImapState } from "./acquirer.js";
import { gmail } from "./reader.js";
import { fakeGmail, mail, refusedWith, type Folder } from "./test/fake.js";
import { ACCOUNT, SOURCE, TAKEOUT_FACTS, takeoutMbox } from "./test/fixtures.js";

const ALL = "[Gmail]/All Mail";
const SPAM = "[Gmail]/Spam";
const TRASH = "[Gmail]/Trash";
const T0 = Date.UTC(2026, 8, 7, 4, 0, 0);
const MINUTE = 60_000;

function setup(folders: Record<string, Folder>, per_poll?: number, more: Partial<GmailImapSettings> = {}) {
  const server = fakeGmail(folders);
  let clock = T0;
  const acquirer = gmailImapAcquirer(
    {
      account: ACCOUNT,
      password: "gmail-imap",
      spam: true,
      bootstrap: { [ALL]: { uidvalidity: "77", uidnext: "10" }, [SPAM]: { uidvalidity: "88", uidnext: "1" } },
      ...(per_poll === undefined ? {} : { per_poll }),
      ...more,
    },
    { imap: () => server.client, now: () => clock },
  );
  const secrets = memorySecrets({ "gmail-imap": "synthetic-app-password" });
  const record: PollRecord = { state: null, deliveries: [] };
  return { server, acquirer, secrets, record, tick: (ms: number) => (clock += ms), now: () => clock };
}

const sealedIds = (record: PollRecord, home: TestHome): Promise<string[][]> =>
  Promise.all(record.deliveries.map(async (delivery) => (await collect(gmail.read(delivery, home.blobs))).map((row) => row.key)));

describe("gmail-imap acquirer: each of these is impossible", () => {
  it("a poll fetches what the previous one sealed, or one that finds nothing new seals a delivery or leaves its cursor", async () => {
    const home = openTestHome();
    const all: Folder = { uidValidity: 77, uidNext: 10, messages: [] };
    const spam: Folder = { uidValidity: 88, uidNext: 1, messages: [] };
    mail(all, 9, 9);
    mail(all, 10, 10);
    mail(all, 11, 11);
    mail(spam, 1, 12, ["\\Spam"]);
    const { server, acquirer, secrets, record, tick, now } = setup({ [ALL]: all, [SPAM]: spam });

    await poll(home, acquirer, record, secrets, now());
    server.onNextOpen(() => mail(all, 12, 13));
    tick(5 * MINUTE);
    await poll(home, acquirer, record, secrets, now());
    tick(5 * MINUTE);
    await poll(home, acquirer, record, secrets, now());
    tick(5 * MINUTE);
    expect(await poll(home, acquirer, record, secrets, now())).toBeUndefined();
    expect((record.state as unknown as GmailImapState).polled_ms).toBe(now());

    const ids = await sealedIds(record, home);
    expect(ids).toEqual([
      ["1790000000000000010", "1790000000000000011", "1790000000000000012"],
      ["1790000000000000013"],
    ]);
    expect(new Set(ids.flat()).size).toBe(ids.flat().length);
    expect(server.asked.every((asked) => !asked.endsWith(":*"))).toBe(true);
    for (const delivery of record.deliveries) await home.land(gmail, delivery);
    expect(home.heads(SOURCE).map((head) => head.key)).toEqual(ids.flat());
    artifact(home.dir, "polls.json", { asked: server.asked, sealed: ids, state: record.state, heads: home.heads(SOURCE) });
  });

  it("a provider cursor goes backward", async () => {
    const home = openTestHome();
    const all: Folder = { uidValidity: 77, uidNext: 10, messages: [] };
    const spam: Folder = { uidValidity: 88, uidNext: 1, messages: [] };
    for (let uid = 10; uid < 17; uid++) mail(all, uid, uid);
    const { server, acquirer, secrets, record, tick, now } = setup({ [ALL]: all, [SPAM]: spam }, 3);
    const cursors: string[] = [];
    const more: (true | undefined)[] = [];
    for (let polls = 0; polls < 3; polls++) {
      await poll(home, acquirer, record, secrets, now());
      cursors.push((record.state as unknown as GmailImapState).folders[ALL]!.uidnext);
      more.push(record.next?.more);
    }
    expect(cursors).toEqual(["13", "16", "17"]);
    expect(more).toEqual([true, true, undefined]);
    all.uidNext = 12;
    tick(5 * MINUTE);
    await poll(home, acquirer, record, secrets, now());
    expect((record.state as unknown as GmailImapState).folders[ALL]!.uidnext).toBe("17");
    expect((await sealedIds(record, home)).flat()).toEqual(["10", "11", "12", "13", "14", "15", "16"].map((uid) => String(1790000000000000000n + BigInt(uid))));
    artifact(home.dir, "polls.json", { asked: server.asked, cursors, state: record.state });
  });

  it("a UIDVALIDITY change is read as a continuation", async () => {
    const home = openTestHome();
    const all: Folder = { uidValidity: 77, uidNext: 10, messages: [] };
    const spam: Folder = { uidValidity: 88, uidNext: 1, messages: [] };
    mail(all, 10, 10);
    const { server, acquirer, secrets, record, tick, now } = setup({ [ALL]: all, [SPAM]: spam });
    await poll(home, acquirer, record, secrets, now());
    const before = structuredClone(record.state);
    all.uidValidity = 99;
    mail(all, 11, 11);
    tick(5 * MINUTE);
    await expect(poll(home, acquirer, record, secrets, now())).rejects.toThrow(/UIDVALIDITY 99.*person's decision/u);
    expect(record.state).toEqual(before);
    expect(record.deliveries).toHaveLength(1);
    artifact(home.dir, "polls.json", { asked: server.asked, state: record.state });
  });

  it("a mailbox connected with no cursor pulls its history, or misses the mail that arrives after", async () => {
    const home = openTestHome();
    const all: Folder = { uidValidity: 77, uidNext: 1, messages: [] };
    for (let uid = 1; uid <= 3; uid++) mail(all, uid, uid);
    const server = fakeGmail({ [ALL]: all });
    let clock = T0;
    const acquirer = gmailImapAcquirer({ account: ACCOUNT, password: "gmail-imap" }, { imap: () => server.client, now: () => clock });
    const secrets = memorySecrets({ "gmail-imap": "synthetic-app-password" });
    const record: PollRecord = { state: null, deliveries: [] };
    expect(await poll(home, acquirer, record, secrets, clock)).toBeUndefined();
    expect(server.asked).toEqual([]);
    expect((record.state as unknown as GmailImapState).folders[ALL]).toEqual({ uidvalidity: "77", uidnext: "4" });
    expect(record.deliveries).toEqual([]);
    mail(all, 4, 4);
    clock += 5 * MINUTE;
    await poll(home, acquirer, record, secrets, clock);
    expect(server.asked).toEqual([`${ALL} SIZE INTERNALDATE 4:4`, `${ALL} 4`]);
    expect((await sealedIds(record, home)).at(-1)).toEqual(["1790000000000000004"]);
    artifact(home.dir, "polls.json", { asked: server.asked, state: record.state });
  });

  it("a refused app password fails a poll as anything but the person's to sign in again, or a connection cut at login reads as a refused one", async () => {
    const home = openTestHome();
    const all: Folder = { uidValidity: 77, uidNext: 1, messages: [] };
    for (let uid = 1; uid <= 3; uid++) mail(all, uid, uid);
    const server = fakeGmail({ [ALL]: all });
    server.password = "synthetic-app-password";
    const acquirer = gmailImapAcquirer({ account: ACCOUNT, password: "gmail.password" }, { imap: server.imap, now: () => T0 });
    const record: PollRecord = { state: null, deliveries: [] };
    await poll(home, acquirer, record, memorySecrets({ "gmail.password": "synthetic-app-password" }), T0);
    expect(record.state).toEqual({ polled_ms: T0, folders: { [ALL]: { uidvalidity: "77", uidnext: "4" } } });
    const failure = await acquirer.fetch(record.state, memorySecrets({ "gmail.password": "synthetic-revoked" }), LENT).catch((error: unknown) => error);
    expect([failure instanceof NeedsYou, (failure as NeedsYou).reason, (failure as NeedsYou).says]).toEqual([true, "signed-out", "Gmail did not accept this app password"]);
    expect((failure as Error).message).not.toContain("synthetic-revoked");
    server.login = "cut";
    const dropped = await acquirer.fetch(record.state, memorySecrets({ "gmail.password": "synthetic-app-password" }), LENT).catch((error: unknown) => error);
    expect([dropped instanceof NeedsYou, offline(dropped)]).toEqual([false, true]);
    artifact(home.dir, "polls.json", { state: record.state, says: (failure as NeedsYou).says, cut: (dropped as Error).message });
  });

  it("a message in two folders is sealed twice, or a poll runs without its secret", async () => {
    const home = openTestHome();
    const all: Folder = { uidValidity: 77, uidNext: 10, messages: [] };
    const spam: Folder = { uidValidity: 88, uidNext: 1, messages: [] };
    mail(all, 10, 10);
    spam.messages.push({ ...all.messages[0]!, uid: 1 });
    spam.uidNext = 2;
    const { acquirer, secrets, record, now } = setup({ [ALL]: all, [SPAM]: spam });
    await poll(home, acquirer, record, secrets, now());
    const rows = await collect(gmail.read(record.deliveries[0]!, home.blobs));
    expect(rows.map((row) => [row.key, (row.content as { content: { folder: string } }).content.folder])).toEqual([["1790000000000000010", ALL]]);
    expect((record.state as unknown as GmailImapState).folders[SPAM]!.uidnext).toBe("2");
    await expect(acquirer.fetch(record.state, memorySecrets({}), LENT)).rejects.toThrow(/no secret/u);
    artifact(home.dir, "polls.json", { state: record.state, rows: rows.map((row) => row.key) });
  });

  it("a poll reads Spam or Trash while they are off, a mailbox by its English name, or polls one hidden from IMAP", async () => {
    const home = openTestHome();
    const ALLE = "[Gmail]/Alle Nachrichten";
    const PAPIERKORB = "[Gmail]/Papierkorb";
    const all: Folder = { uidValidity: 77, uidNext: 1, messages: [], specialUse: "\\All" };
    const spam: Folder = { uidValidity: 88, uidNext: 1, messages: [], specialUse: "\\Junk" };
    const trash: Folder = { uidValidity: 99, uidNext: 1, messages: [], specialUse: "\\Trash" };
    const server = fakeGmail({ [SPAM]: spam, [PAPIERKORB]: trash, [ALLE]: all });
    let clock = T0;
    const secrets = memorySecrets({ "gmail-imap": "synthetic-app-password" });
    const acquirer = gmailImapAcquirer({ account: ACCOUNT, password: "gmail-imap" }, { imap: () => server.client, now: () => clock });
    const record: PollRecord = { state: null, deliveries: [] };
    await poll(home, acquirer, record, secrets, clock);
    expect(Object.keys((record.state as unknown as GmailImapState).folders)).toEqual([ALLE]);
    mail(all, 1, 1);
    mail(spam, 1, 2, ["\\Spam"]);
    mail(trash, 1, 3, ["\\Trash"]);
    clock += 5 * MINUTE;
    await poll(home, acquirer, record, secrets, clock);
    expect(server.asked).toEqual([`${ALLE} SIZE INTERNALDATE 1:1`, `${ALLE} 1`]);
    expect((await sealedIds(record, home)).at(-1)).toEqual(["1790000000000000001"]);
    const both = gmailImapAcquirer({ account: ACCOUNT, password: "gmail-imap", spam: true, trash: true }, { imap: () => server.client, now: () => clock });
    clock += 5 * MINUTE;
    await poll(home, both, record, secrets, clock);
    expect(Object.keys((record.state as unknown as GmailImapState).folders)).toEqual([ALLE, PAPIERKORB, SPAM]);
    mail(spam, 2, 4, ["\\Spam"]);
    mail(trash, 2, 5, ["\\Trash"]);
    clock += 5 * MINUTE;
    await poll(home, both, record, secrets, clock);
    expect((await sealedIds(record, home)).at(-1)).toEqual(["1790000000000000004", "1790000000000000005"]);
    delete trash.specialUse;
    clock += 5 * MINUTE;
    const shown = structuredClone(record.state);
    await expect(poll(home, both, record, secrets, clock)).rejects.toThrow(/no mailbox flagged \\Trash: Trash is hidden from IMAP.*Show in IMAP/u);
    expect(record.state).toEqual(shown);
    delete all.specialUse;
    clock += 5 * MINUTE;
    const before = structuredClone(record.state);
    await expect(poll(home, acquirer, record, secrets, clock)).rejects.toThrow(/no mailbox flagged \\All.*Show in IMAP/u);
    expect(record.state).toEqual(before);
    artifact(home.dir, "polls.json", { asked: server.asked, state: record.state });
  });
});

describe("gmail-imap sign-in check: each of these is impossible", () => {
  const signal = () => new AbortController().signal;
  const fields = { account: ACCOUNT, password: "gmail.password" };

  it("a login Google refuses is anything but signed out, or says the password; a password typed in groups is sent or sealed with its spaces", async () => {
    const server = fakeGmail({});
    server.password = "abcdefghijklmnop";
    const check: SignedIn = (values) => gmailSignedIn(values, { imap: server.imap });
    const refused = await check({ fields, credential: "synthetic-wrong", signal: signal() }).catch((error: unknown) => error);
    expect([refused instanceof NeedsYou, (refused as NeedsYou).reason, (refused as NeedsYou).says]).toEqual([true, "signed-out", "Gmail did not accept this app password"]);
    expect((refused as Error).message).not.toContain("synthetic-wrong");
    expect(server.closes).toBe(1);
    const signed = await check({ fields, credential: " abcd efgh\tijkl\nmnop ", signal: signal() });
    expect(signed).toEqual({ credential: "abcdefghijklmnop" });
    expect(server.logins).toEqual([{ account: ACCOUNT, password: "synthetic-wrong" }, { account: ACCOUNT, password: "abcdefghijklmnop" }]);
    expect(server.closes).toBe(1);
    const home = openTestHome();
    artifact(home.dir, "check.json", { refused: (refused as Error).message, signed, logins: server.logins.length });
  });

  it("a connection cut at login is anything the home cannot read as the network's; a deadline passed leaves the session open or answers another reason", async () => {
    const server = fakeGmail({});
    const check: SignedIn = (values) => gmailSignedIn(values, { imap: server.imap });
    server.login = "cut";
    const cut = await check({ fields, credential: "abcdefghijklmnop", signal: signal() }).catch((error: unknown) => error);
    expect([cut instanceof NeedsYou, offline(cut)]).toEqual([false, true]);
    server.login = "hang";
    const deadline = new AbortController();
    const waiting = check({ fields, credential: "abcdefghijklmnop", signal: deadline.signal }).catch((error: unknown) => error);
    const closed = server.closes;
    const reason = new DOMException("the sign-in's deadline passed", "TimeoutError");
    deadline.abort(reason);
    expect(await waiting).toBe(reason);
    expect(server.closes).toBe(closed + 1);
    const made = server.logins.length;
    const past = await check({ fields, credential: "abcdefghijklmnop", signal: AbortSignal.abort(reason) }).catch((error: unknown) => error);
    expect([past, server.logins.length, server.closes]).toEqual([reason, made, closed + 1]);
    const home = openTestHome();
    artifact(home.dir, "check-network.json", { cut: (cut as Error).message, closes: server.closes });
  });
});

describe("gmail-imap page: each of these is impossible", () => {
  const HOUR = 60 * MINUTE;
  const DAY_BYTES = 2_000_000_000;
  const cursor = (record: PollRecord) => (record.state as unknown as GmailImapState).folders;
  const bytes = (record: PollRecord) => [...(record.memory?.get(CHARGED) ?? [])].map(([at, n]) => ({ at_ms: Number(at), n: JSON.parse(n) as number })).sort((a, b) => a.at_ms - b.at_ms);
  const charged = (...entries: { at_ms: number; n: number }[]) => new Map([[CHARGED, new Map(entries.map((entry) => [String(entry.at_ms), String(entry.n)]))]]);

  it("a mailbox connected before the page starts paging anywhere but its live cursor, asks a source before its size, or a fetch after a page drops low, start or bytes", async () => {
    const home = openTestHome();
    const all: Folder = { uidValidity: 77, uidNext: 1, messages: [] };
    const spam: Folder = { uidValidity: 88, uidNext: 1, messages: [] };
    for (let uid = 5; uid <= 12; uid++) mail(all, uid, uid);
    const { server, acquirer, secrets, record, tick, now } = setup({ [ALL]: all, [SPAM]: spam });
    record.state = { polled_ms: T0 - HOUR, folders: { [ALL]: { uidvalidity: "77", uidnext: "13" }, [SPAM]: { uidvalidity: "88", uidnext: "1" } } };
    await poll(home, acquirer, record, secrets, now(), "page");
    expect(server.asked).toEqual([`${ALL} SEARCH UID 1:12`, `${ALL} SIZE 5:12`, `${ALL} 5:12`, `${ALL} SIZE INTERNALDATE 1:12`]);
    expect(record.left).toBe(0);
    const sizes = all.messages.reduce((total, entry) => total + entry.source!.length, 0);
    expect(cursor(record)[ALL]).toEqual({ uidvalidity: "77", uidnext: "13", start: "13", low: "5" });
    expect(bytes(record)).toEqual([{ at_ms: T0, n: sizes }]);
    expect(cursor(record)[SPAM]).toEqual({ uidvalidity: "88", uidnext: "1" });
    expect(record.state).not.toHaveProperty("first_ms");
    expect((await sealedIds(record, home))[0]).toHaveLength(8);
    mail(all, 13, 13);
    tick(5 * MINUTE);
    await poll(home, acquirer, record, secrets, now());
    expect((await sealedIds(record, home))[1]).toEqual(["1790000000000000013"]);
    expect(cursor(record)[ALL]).toEqual({ uidvalidity: "77", uidnext: "14", start: "13", low: "5" });
    expect(bytes(record)).toEqual([{ at_ms: T0, n: sizes }, { at_ms: now(), n: all.messages.at(-1)!.source!.length }]);
    server.asked.length = 0;
    tick(MINUTE);
    await poll(home, acquirer, record, secrets, now(), "page");
    expect(server.asked).toEqual([`${ALL} SEARCH UID 1:4`]);
    expect(record.left).toBe(0);
    artifact(home.dir, "pages.json", { state: record.state, facts: record.deliveries.map((delivery) => delivery.facts) });
  });

  it("a page takes a message past the 24 hours' download, waits on anything but its own clock, holds new mail while it waits, or forgets the fetch's bytes", async () => {
    const home = openTestHome();
    const all: Folder = { uidValidity: 77, uidNext: 1, messages: [] };
    const spam: Folder = { uidValidity: 88, uidNext: 1, messages: [] };
    for (let uid = 5; uid <= 12; uid++) mail(all, uid, uid);
    const { server, acquirer, secrets, record, tick, now } = setup({ [ALL]: all, [SPAM]: spam });
    const spent = { at_ms: T0 - 23 * HOUR, n: DAY_BYTES - 100 };
    record.state = { polled_ms: T0 - HOUR, first_ms: T0 - HOUR, folders: { [ALL]: { uidvalidity: "77", uidnext: "13", start: "13", low: "13" }, [SPAM]: { uidvalidity: "88", uidnext: "1" } } };
    record.memory = charged(spent);
    const before = structuredClone(record.state) as unknown as GmailImapState;
    const waited = await poll(home, acquirer, record, secrets, now(), "page").catch((error: unknown) => error);
    expect(waited).toBeInstanceOf(NotYet);
    expect((waited as NotYet).next_ms).toBe(spent.at_ms + 24 * HOUR);
    expect((waited as NotYet).backoff_ms).toBeUndefined();
    expect(server.asked).toEqual([`${ALL} SEARCH UID 1:12`, `${ALL} SIZE 5:12`]);
    expect(cursor(record)).toEqual(before.folders);
    expect(bytes(record)).toEqual([spent]);
    expect(record.deliveries).toHaveLength(0);
    mail(all, 13, 13);
    tick(5 * MINUTE);
    await poll(home, acquirer, record, secrets, now());
    expect((await sealedIds(record, home))[0]).toEqual(["1790000000000000013"]);
    expect(record.next).toEqual({});
    expect(bytes(record)).toEqual([spent, { at_ms: now(), n: all.messages.at(-1)!.source!.length }]);
    const again = await poll(home, acquirer, record, secrets, now(), "page").catch((error: unknown) => error);
    expect((again as NotYet).next_ms).toBe(spent.at_ms + 24 * HOUR);
    tick(HOUR);
    await poll(home, acquirer, record, secrets, now(), "page");
    expect((await sealedIds(record, home))[1]).toHaveLength(8);
    expect(record.left).toBe(0);
    expect(bytes(record).map((entry) => entry.at_ms)).toEqual([T0 + 5 * MINUTE, now()]);
    artifact(home.dir, "cap.json", { asked: server.asked, state: record.state, charged: bytes(record) });
  });

  it("Google's throttle, to either call, moves a cursor, seals anything, answers left at all, holds one call alone, or forgets the bytes it downloaded first", async () => {
    const home = openTestHome();
    const all: Folder = { uidValidity: 77, uidNext: 1, messages: [] };
    const spam: Folder = { uidValidity: 88, uidNext: 1, messages: [] };
    for (let uid = 5; uid <= 12; uid++) mail(all, uid, uid);
    const { server, acquirer, secrets, record, now } = setup({ [ALL]: all, [SPAM]: spam });
    const start = { polled_ms: T0 - HOUR, first_ms: T0 - HOUR, folders: { [ALL]: { uidvalidity: "77", uidnext: "10", start: "10", low: "10" }, [SPAM]: { uidvalidity: "88", uidnext: "1" } } };
    const size = (uid: number) => all.messages.find((entry) => entry.uid === uid)!.source!.length;
    for (const call of ["fetch", "page"] as const) {
      record.state = structuredClone(start);
      delete record.memory;
      delete record.left;
      server.throttleNext(2);
      const waited = await poll(home, acquirer, record, secrets, now(), call).catch((error: unknown) => error);
      expect(waited, call).toBeInstanceOf(NotYet);
      expect((waited as NotYet).backoff_ms, call).toBe(now() + HOUR);
      expect((waited as NotYet).next_ms, call).toBeUndefined();
      expect(record.deliveries, call).toHaveLength(0);
      expect(record.left, call).toBeUndefined();
      expect(cursor(record), call).toEqual(start.folders);
      expect(bytes(record), call).toEqual([{ at_ms: now(), n: (call === "fetch" ? [10, 11, 12] : [5, 6, 7, 8, 9]).reduce((total, uid) => total + size(uid), 0) }]);
    }
    artifact(home.dir, "throttle.json", { asked: server.asked });
  });

  it("a SEARCH the server answers NO says nothing is left, ending the backfill", async () => {
    const home = openTestHome();
    const all: Folder = { uidValidity: 77, uidNext: 1, messages: [] };
    const spam: Folder = { uidValidity: 88, uidNext: 1, messages: [] };
    for (let uid = 5; uid <= 12; uid++) mail(all, uid, uid);
    const { server, acquirer, secrets, record, now } = setup({ [ALL]: all, [SPAM]: spam });
    record.state = { polled_ms: T0 - HOUR, first_ms: T0 - HOUR, folders: { [ALL]: { uidvalidity: "77", uidnext: "13", start: "13", low: "13" }, [SPAM]: { uidvalidity: "88", uidnext: "1" } } };
    const before = structuredClone(record.state);
    server.refuseNextSearch();
    await expect(poll(home, acquirer, record, secrets, now(), "page")).rejects.toThrow(/Gmail refused UID SEARCH UID 1:12/u);
    expect(record.state).toEqual(before);
    expect(record.left).toBeUndefined();
    expect(record.deliveries).toHaveLength(0);
    await poll(home, acquirer, record, secrets, now(), "page");
    expect(record.left).toBe(0);
    expect((await sealedIds(record, home))[0]).toHaveLength(8);
  });

  it("a download that fails midway forgets the bytes Google sent, a message cut inside it among them, so the retry downloads them outside the 24 hours", async () => {
    const home = openTestHome();
    const all: Folder = { uidValidity: 77, uidNext: 1, messages: [] };
    const spam: Folder = { uidValidity: 88, uidNext: 1, messages: [] };
    for (let uid = 5; uid <= 12; uid++) mail(all, uid, uid);
    const { server, acquirer, secrets, record, tick, now } = setup({ [ALL]: all, [SPAM]: spam });
    record.state = { polled_ms: T0 - HOUR, first_ms: T0 - HOUR, folders: { [ALL]: { uidvalidity: "77", uidnext: "13", start: "13", low: "13" }, [SPAM]: { uidvalidity: "88", uidnext: "1" } } };
    const asked = all.messages.reduce((total, entry) => total + entry.source!.length, 0);
    server.failNext(3, refusedWith("UNAVAILABLE", "Internal error"));
    const failed = await poll(home, acquirer, record, secrets, now(), "page").catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(NotYet);
    expect((failed as NotYet).message).toBe("not yet: Command failed");
    expect(record.deliveries).toHaveLength(0);
    expect(cursor(record)[ALL]).toEqual({ uidvalidity: "77", uidnext: "13", start: "13", low: "13" });
    expect(bytes(record)).toEqual([{ at_ms: now(), n: asked }]);
    tick(MINUTE);
    server.failNext(0, Object.assign(new Error("Unexpected close"), { code: "EConnectionClosed" }));
    const cut = await poll(home, acquirer, record, secrets, now(), "page").catch((error: unknown) => error);
    expect([(cut as NotYet).reason, (cut as NotYet).message]).toEqual(["offline", "not yet: Unexpected close"]);
    expect(bytes(record)).toEqual([{ at_ms: now() - MINUTE, n: asked }, { at_ms: now(), n: asked }]);
    all.uidValidity = 78;
    await expect(poll(home, acquirer, record, secrets, now(), "page")).rejects.toThrow(/UIDVALIDITY 78/u);
    all.uidValidity = 77;
    tick(MINUTE);
    await poll(home, acquirer, record, secrets, now(), "page");
    expect((await sealedIds(record, home))[0]).toHaveLength(8);
    expect(bytes(record).map((entry) => entry.at_ms)).toEqual([T0, T0 + MINUTE, T0 + 2 * MINUTE]);
    artifact(home.dir, "charged.json", { asked: server.asked, state: record.state, charged: bytes(record) });
  });

  it("a fetch downloads one folder before another refuses the call, so each retry downloads it again", async () => {
    const home = openTestHome();
    const all: Folder = { uidValidity: 77, uidNext: 10, messages: [] };
    const spam: Folder = { uidValidity: 88, uidNext: 1, messages: [] };
    for (let uid = 10; uid <= 12; uid++) mail(all, uid, uid);
    mail(spam, 1, 13, ["\\Spam"]);
    const { server, acquirer, secrets, record, now } = setup({ [ALL]: all, [SPAM]: spam });
    await poll(home, acquirer, record, secrets, now());
    const before = structuredClone(record.state);
    mail(all, 13, 14);
    spam.uidValidity = 89;
    server.asked.length = 0;
    await expect(poll(home, acquirer, record, secrets, now())).rejects.toThrow(/UIDVALIDITY 89/u);
    expect(server.asked).toEqual([]);
    expect(record.state).toEqual(before);
  });

  it("a message Gmail answers without its X-GM-MSGID is a wait that downloads it again at every call, rather than the lane's refusal", async () => {
    const home = openTestHome();
    const all: Folder = { uidValidity: 77, uidNext: 1, messages: [] };
    const spam: Folder = { uidValidity: 88, uidNext: 1, messages: [] };
    for (let uid = 5; uid <= 12; uid++) mail(all, uid, uid);
    delete all.messages[2]!.emailId;
    const { acquirer, secrets, record, now } = setup({ [ALL]: all, [SPAM]: spam });
    record.state = { polled_ms: T0 - HOUR, first_ms: T0 - HOUR, folders: { [ALL]: { uidvalidity: "77", uidnext: "13", start: "13", low: "13" }, [SPAM]: { uidvalidity: "88", uidnext: "1" } } };
    const before = structuredClone(record.state);
    const refused = await poll(home, acquirer, record, secrets, now(), "page").catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Refused);
    expect((refused as Refused).message).toMatch(/UID 7 X-GM-MSGID is not a decimal id/u);
    expect(record.state).toEqual(before);
    expect(record.deliveries).toHaveLength(0);
  });

  it("a page under a start asks for mail older than it, or counts it as left", async () => {
    const home = openTestHome();
    const all: Folder = { uidValidity: 77, uidNext: 1, messages: [] };
    const spam: Folder = { uidValidity: 88, uidNext: 1, messages: [] };
    for (let uid = 1; uid <= 4; uid++) mail(all, uid, uid, ["\\Inbox"], T0 - 60 * 24 * HOUR + uid * MINUTE);
    for (let uid = 5; uid <= 9; uid++) mail(all, uid, uid, ["\\Inbox"], T0 - 10 * 24 * HOUR + uid * MINUTE);
    const { server, acquirer, secrets, record, now } = setup({ [ALL]: all, [SPAM]: spam });
    await poll(home, acquirer, record, secrets, now(), "page", T0 - 30 * 24 * HOUR);
    expect(server.asked[0]).toBe(`${ALL} SEARCH UID 1:9 SINCE ${new Date(T0 - 30 * 24 * HOUR).toISOString().slice(0, 10)}`);
    expect((await sealedIds(record, home))[0]).toEqual([5, 6, 7, 8, 9].map((id) => String(1790000000000000000n + BigInt(id))));
    expect(record.left).toBe(0);
    expect(cursor(record)[ALL]).toEqual({ uidvalidity: "77", uidnext: "10", low: "5", start: "10" });
    expect(record.from_ms).toBe(T0 - 30 * 24 * HOUR);
  });

  it("moving the start earlier skips an older-dated message at a UID the later start's walk passed, or downloads again what it read", async () => {
    const home = openTestHome();
    const all: Folder = { uidValidity: 77, uidNext: 1, messages: [] };
    const spam: Folder = { uidValidity: 88, uidNext: 1, messages: [] };
    const old = (uid: number) => mail(all, uid, uid, ["\\Inbox"], T0 - 60 * 24 * HOUR + uid * MINUTE);
    const recent = (uid: number) => mail(all, uid, uid, ["\\Inbox"], T0 - 10 * 24 * HOUR + uid * MINUTE);
    [1, 2, 3, 7].forEach(old);
    [4, 5, 6, 8, 9].forEach(recent);
    const widened = setup({ [ALL]: all, [SPAM]: spam });
    const { record, secrets } = widened;
    await poll(home, widened.acquirer, record, secrets, widened.now(), "page", T0 - 30 * 24 * HOUR);
    expect((await sealedIds(record, home))[0]).toEqual([4, 5, 6, 8, 9].map((id) => String(1790000000000000000n + BigInt(id))));
    expect(record.left).toBe(0);
    widened.server.asked.length = 0;
    await poll(home, widened.acquirer, record, secrets, widened.now(), "fetch");
    expect(cursor(record)[ALL]).toEqual({ uidvalidity: "77", uidnext: "10", start: "10", low: "10", read: { low: "4", since: new Date(T0 - 30 * 24 * HOUR).toISOString().slice(0, 10) } });
    widened.server.asked.length = 0;
    await poll(home, widened.acquirer, record, secrets, widened.now(), "page");
    const floorDay = new Date(T0 - 30 * 24 * HOUR).toISOString().slice(0, 10);
    expect(widened.server.asked).toEqual([`${ALL} SEARCH UID 1:9`, `${ALL} SEARCH UID 4:9 SINCE ${floorDay}`, `${ALL} SIZE 1:3,7`, `${ALL} 1:3,7`, `${ALL} SIZE INTERNALDATE 1:9`]);
    expect((await sealedIds(record, home))[1]).toEqual([1, 2, 3, 7].map((id) => String(1790000000000000000n + BigInt(id))));
    expect(record.left).toBe(0);
    expect(cursor(record)[ALL]).toEqual({ uidvalidity: "77", uidnext: "10", start: "10", low: "1", read: { low: "4", since: floorDay } });
    widened.server.asked.length = 0;
    await poll(home, widened.acquirer, record, secrets, widened.now(), "page");
    expect(widened.server.asked).toEqual([]);
    expect(record.left).toBe(0);
    for (const delivery of record.deliveries) await home.land(gmail, delivery);
    expect(home.heads(SOURCE).map((head) => head.key).sort()).toEqual(all.messages.map((entry) => entry.emailId).sort());
    artifact(home.dir, "widened.json", { asked: widened.server.asked, state: record.state });
  });

  it("a page counts its mailbox on any page but a walk's first, with more than one FETCH a mailbox, by anything but INTERNALDATE's UTC month, or counts Spam or Trash while they are off", async () => {
    const home = openTestHome();
    const all: Folder = { uidValidity: 77, uidNext: 1, messages: [] };
    const spam: Folder = { uidValidity: 88, uidNext: 1, messages: [] };
    const trash: Folder = { uidValidity: 99, uidNext: 1, messages: [] };
    mail(all, 5, 5, ["\\Inbox"], Date.UTC(2026, 7, 31, 23, 59));
    for (let uid = 6; uid <= 9; uid++) mail(all, uid, uid, ["\\Inbox"], Date.UTC(2026, 8, 1, 0, uid));
    mail(spam, 1, 20, ["\\Spam"], Date.UTC(2025, 0, 1));
    mail(trash, 1, 21, ["\\Trash"], Date.UTC(2024, 5, 1));
    const { server, acquirer, secrets, record, tick, now } = setup({ [ALL]: all, [SPAM]: spam, [TRASH]: trash }, 2, { spam: false, trash: true });
    const size = (folder: Folder, uids: number[]) => folder.messages.filter((entry) => uids.includes(entry.uid)).reduce((total, entry) => total + entry.source!.length, 0);
    record.state = { polled_ms: T0 - 60 * MINUTE, folders: { [ALL]: { uidvalidity: "77", uidnext: "10" } } };
    await poll(home, acquirer, record, secrets, now(), "page");
    expect(server.asked).toEqual([`${ALL} SEARCH UID 1:9`, `${ALL} SIZE 8:9`, `${ALL} 8:9`, `${ALL} SIZE INTERNALDATE 1:9`, `${TRASH} SIZE INTERNALDATE 1:1`]);
    expect(record.deliveries[0]!.facts.months).toEqual({
      "2026-08": [1, size(all, [5])], "2026-09": [4, size(all, [6, 7, 8, 9])], "2024-06": [1, size(trash, [1])],
    });
    expect(acquirer.months).toBe(true);
    for (let pages = 1; record.left !== 0; pages++) {
      server.asked.length = 0;
      tick(MINUTE);
      await poll(home, acquirer, record, secrets, now(), "page");
      expect(server.asked.filter((asked) => asked.includes("INTERNALDATE")), `page ${pages + 1}`).toEqual([]);
      expect(record.deliveries.at(-1)!.facts, `page ${pages + 1}`).not.toHaveProperty("months");
    }
    expect(record.deliveries).toHaveLength(3);
    artifact(home.dir, "months.json", { months: record.deliveries[0]!.facts.months, facts: record.deliveries.map((delivery) => delivery.facts) });
  });

  it("a fetch lands new mail dated before the start, or a start moved earlier never reads it", async () => {
    const home = openTestHome();
    const all: Folder = { uidValidity: 77, uidNext: 1, messages: [] };
    const spam: Folder = { uidValidity: 88, uidNext: 1, messages: [] };
    for (let uid = 1; uid <= 9; uid++) mail(all, uid, uid, ["\\Inbox"], T0 - 10 * 24 * HOUR + uid * MINUTE);
    const { server, acquirer, secrets, record, tick, now } = setup({ [ALL]: all, [SPAM]: spam });
    const start = T0 - 30 * 24 * HOUR;
    const earlier = T0 - 90 * 24 * HOUR;
    const gm = (id: number) => String(1790000000000000000n + BigInt(id));
    await poll(home, acquirer, record, secrets, now(), "page", start);
    mail(all, 10, 10, ["\\Inbox"], T0 - 60 * 24 * HOUR);
    mail(all, 11, 11, ["\\Inbox"], T0 - HOUR);
    tick(5 * MINUTE);
    server.asked.length = 0;
    await poll(home, acquirer, record, secrets, now(), "fetch", start);
    expect(server.asked).toEqual([`${ALL} SIZE INTERNALDATE 10:11`, `${ALL} 11`]);
    expect(cursor(record)[ALL]).toEqual({ uidvalidity: "77", uidnext: "12", start: "10", low: "1" });
    tick(5 * MINUTE);
    await poll(home, acquirer, record, secrets, now(), "fetch", earlier);
    expect(cursor(record)[ALL]).toEqual({ uidvalidity: "77", uidnext: "12", start: "12", low: "12", read: { low: "1", since: new Date(start).toISOString().slice(0, 10) } });
    tick(5 * MINUTE);
    await poll(home, acquirer, record, secrets, now(), "page", earlier);
    expect(record.left).toBe(0);
    expect(await sealedIds(record, home)).toEqual([[1, 2, 3, 4, 5, 6, 7, 8, 9].map(gm), [gm(11)], [gm(10)]]);
    artifact(home.dir, "fetched.json", { asked: server.asked, state: record.state });
  });

  it("a page on a mailbox whose walk ended with no count downloads anything or leaves it uncounted, or counts it again once counted", async () => {
    const home = openTestHome();
    const all: Folder = { uidValidity: 77, uidNext: 1, messages: [] };
    const spam: Folder = { uidValidity: 88, uidNext: 1, messages: [] };
    for (let uid = 1; uid <= 4; uid++) mail(all, uid, uid, ["\\Inbox"], Date.UTC(2026, 7, 1 + uid));
    const { server, acquirer, secrets, record, tick, now } = setup({ [ALL]: all, [SPAM]: spam });
    record.state = { polled_ms: T0 - HOUR, folders: { [ALL]: { uidvalidity: "77", uidnext: "5", start: "5", low: "1" }, [SPAM]: { uidvalidity: "88", uidnext: "1" } } };
    await poll(home, acquirer, record, secrets, now(), "page");
    expect(server.asked).toEqual([`${ALL} SIZE INTERNALDATE 1:4`]);
    expect([record.left, record.deliveries[0]!.facts.months]).toEqual([0, { "2026-08": [4, all.messages.reduce((total, entry) => total + entry.source!.length, 0)] }]);
    expect(record.state).toMatchObject({ counted: true });
    server.asked.length = 0;
    tick(MINUTE);
    await poll(home, acquirer, record, secrets, now(), "fetch");
    await poll(home, acquirer, record, secrets, now(), "page");
    expect(server.asked).toEqual([]);
    expect(record.deliveries.at(-1)!.facts).not.toHaveProperty("months");
    expect(record.state).toMatchObject({ counted: true });
  });

  it("a message a Takeout seeded and a page reads lands as two records", async () => {
    const home = openTestHome();
    await home.land(gmail, deliver(home, SOURCE, { "Takeout/Mail/All mail.mbox": takeoutMbox() }, TAKEOUT_FACTS));
    const seeded = home.heads(SOURCE, ["mailmsg"]).map((head) => head.key).sort();
    const all: Folder = { uidValidity: 77, uidNext: 1, messages: [] };
    const spam: Folder = { uidValidity: 88, uidNext: 1, messages: [] };
    mail(all, 9, 201);
    const { acquirer, secrets, record, now } = setup({ [ALL]: all, [SPAM]: spam });
    await poll(home, acquirer, record, secrets, now(), "page");
    const landed = await home.land(gmail, record.deliveries[0]!);
    expect(landed.new).toBe(0);
    expect(home.heads(SOURCE, ["mailmsg"]).map((head) => head.key).sort()).toEqual(seeded);
  });
});

describe("gmail-imap's cursor and memory", () => {
  it("grows the cursor with a day's calls, downloads a message again after them, or writes memory on a call that found nothing new (N and 4N)", async () => {
    const day = async (calls: number) => {
      const home = openTestHome();
      const all: Folder = { uidValidity: 77, uidNext: 10, messages: [] };
      const spam: Folder = { uidValidity: 88, uidNext: 1, messages: [] };
      const { server, acquirer, secrets, record, tick, now } = setup({ [ALL]: all, [SPAM]: spam });
      const step = Math.floor((20 * 60 * MINUTE) / calls);
      for (let n = 0; n < calls; n++) {
        mail(all, 10 + n, 10 + n);
        await poll(home, acquirer, record, secrets, now());
        tick(step);
      }
      expect([record.deliveries.length, record.memory!.get(CHARGED)!.size]).toEqual([calls, calls]);
      const cursor = Buffer.byteLength(canonical(record.state!));
      server.asked.length = 0;
      expect(await poll(home, acquirer, record, secrets, now())).toBeUndefined();
      expect(server.asked.filter((asked) => !asked.includes("SIZE") && !asked.includes("SEARCH"))).toEqual([]);
      expect(record.changes).toEqual({ cleared: [], entries: [] });
      return { calls, cursor };
    };
    const n = await day(150);
    const n4 = await day(600);
    expect(Math.abs(n4.cursor - n.cursor)).toBeLessThanOrEqual(64);
    expect(Math.max(n.cursor, n4.cursor)).toBeLessThan(16_384);
    artifact(temp(), "bounded.json", { n, n4 });
  });
});
