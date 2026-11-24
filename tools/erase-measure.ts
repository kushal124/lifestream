import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { civilDay, openHomeFolder } from "@lifestreamprotocol/core";
import { basicInstant, deliveryAt, openSealing } from "../packages/home/inbox.js";
import { preparedDirOf, preparedFileOf } from "../packages/home/prepared.js";
import { recordRead } from "../packages/home/index-file.js";
import { searchFileOf } from "../packages/home/search-index.js";
import { termsOf } from "../packages/home/search-words.js";
import { homeSocket } from "../packages/home/lifecycle.js";
import { askHome } from "../packages/home/socket.js";
import { REPO } from "../packages/home/test/support.js";
import type { SizeName, VolumeReport } from "./volume.js";

const DAY = { zone: "UTC", day_start_hour: 4 } as const;
const DAY_MS = 86_400_000;
const SHARES = { one: 0.08, kills: 0.02, days: 0.02, blobs: 0.02 } as const;
type Box = "all" | keyof typeof SHARES;
const BOXES: Box[] = ["all", "one", "kills", "days", "blobs"];
const PULL: Record<Box, number> = { all: 500, one: 500, kills: 0, days: 100, blobs: 100 };
const POINTS = ["erase.intent", "erase.cleanup", "erase.ledger", "erase.search", "erase.blobs", "erase.purge", "erase.delivery", "erase.committed"];

const accountOf = (box: Box) => `person-${box}@example.com`;
const sourceOf = (box: Box) => `gmail:${accountOf(box)}:cloud`;
const tokenOf = (box: Box, n: number) => `zqx${box}${String(n).padStart(6, "0")}t`;
const hexOf = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const crlf = (lines: string[]) => Buffer.from(lines.map((line) => `${line}\r\n`).join(""), "utf8");
const FILLER = "the synthetic quarterly notice lists several routine items for review before the next cycle begins".split(" ");

interface Email { box: Box; n: number; msgid: string; at_ms: number; bytes: Buffer; token: string }

function emailsOf(total: number, now: number): Record<Box, Email[]> {
  const counts = { one: 0, kills: 0, days: 0, blobs: 0, all: 0 } as Record<Box, number>;
  for (const box of Object.keys(SHARES) as (keyof typeof SHARES)[]) counts[box] = Math.max(16, Math.round(total * SHARES[box]));
  counts.all = Math.max(16, total - counts.one - counts.kills - counts.days - counts.blobs);
  const out = {} as Record<Box, Email[]>;
  BOXES.forEach((box, b) => {
    const span = (box === "days" ? 200 : 365) * DAY_MS;
    out[box] = Array.from({ length: counts[box] }, (_, i) => {
      const n = i + 1;
      const at_ms = now - 2 * DAY_MS - Math.floor((i * span) / counts[box]);
      const token = tokenOf(box, n);
      const body = Array.from({ length: 24 }, (_, line) => FILLER.map((word, w) => (line * 7 + w + n) % 5 === 0 ? `${word}${(n + line) % 97}` : word).join(" "));
      if (n % 10 === 0) body.push(...Array.from({ length: 60 }, () => FILLER.join(" ")));
      const bytes = crlf([
        `From: Sender ${n % 300} <sender-${n % 300}@example.com>`, `To: ${accountOf(box)}`, `Subject: Synthetic notice ${n} ${token}`,
        `Date: ${new Date(at_ms).toUTCString().replace("GMT", "+0000")}`, `X-GM-THRID: ${7900000000000000000n + BigInt(b) * 100_000_000n + BigInt(n)}`,
        "", `Reference ${token}.`, ...body,
      ]);
      return { box, n, msgid: String(7900000000000000000n + BigInt(b) * 100_000_000n + BigInt(n)), at_ms, bytes, token };
    });
  });
  return out;
}

function sealPulls(root: string, box: Box, emails: Email[], start_ms: number): string[] {
  const size = box === "kills" ? Math.ceil(emails.length / POINTS.length) : PULL[box];
  const ids: string[] = [];
  for (let first = 0, page = 0; first < emails.length; first += size, page++) {
    const part = emails.slice(first, first + size);
    const fetched_at = new Date(start_ms + page * 60_000).toISOString().replace(/\.\d+Z$/u, ".000Z");
    const manifest = {
      format: "org.lifestreamprotocol.gmail-imap-pull/0.2", complete: true, account: accountOf(box), fetched_at,
      folders: [{ folder: "[Gmail]/All Mail", uidvalidity: "7", uidnext: String(emails.length + 1) }],
      messages: part.map((email) => ({
        file: `msg-${email.msgid}.eml`, folder: "[Gmail]/All Mail", gm_msgid: email.msgid, gm_thrid: email.msgid, labels: ["\\Inbox"],
        internaldate: new Date(email.at_ms).toISOString(), sha256: hexOf(email.bytes), bytes: email.bytes.length,
      })),
    };
    const name = basicInstant(fetched_at);
    const sealing = openSealing(openHomeFolder(root), { source: sourceOf(box), name, feeder: "gmail-imap", fetched_at });
    const files: [string, Buffer][] = [...part.map((email) => [`msg-${email.msgid}.eml`, email.bytes] as [string, Buffer]), ["pull.json", Buffer.from(`${JSON.stringify(manifest)}\n`)]];
    pending.push((async () => {
      for (const [path, bytes] of files) await sealing.write(path, (async function* () { yield bytes; })());
      sealing.seal({ account: accountOf(box), messages: part.length, sources: [{ id: sourceOf(box), connector: "gmail-imap" }] });
    })());
    ids.push(`${sourceOf(box)}/${name}`);
  }
  return ids;
}
let pending: Promise<void>[] = [];


class HomeProcess {
  child: ChildProcess | null = null;
  constructor(readonly root: string, readonly machine: string, readonly log: string) {}

  async start(failpoint?: string): Promise<void> {
    const env = { ...process.env, LIFESTREAM_MACHINE_DIR: this.machine, ...(failpoint === undefined ? {} : { LIFESTREAM_FAILPOINT: failpoint }) };
    const child = spawn(process.execPath, ["--import", "tsx", "packages/home/cli.ts", "serve", "--root", this.root], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    await new Promise<void>((done, fail) => {
      let buffered = "";
      const take = (chunk: Buffer) => {
        appendFileSync(this.log, chunk);
        buffered += chunk.toString("utf8");
        if (buffered.includes('"home":"started"')) { buffered = ""; done(); }
        else if (buffered.length > 1 << 20) buffered = buffered.slice(-4096);
      };
      child.stdout!.on("data", take);
      child.stderr!.on("data", take);
      child.once("exit", (code, signal) => fail(new Error(`the home exited before it started (${code ?? signal})`)));
    });
  }

  exited(): Promise<{ code: number | null; signal: string | null }> {
    const child = this.child;
    if (child === null || child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child?.exitCode ?? null, signal: child?.signalCode ?? null });
    return new Promise((done) => child.once("exit", (code, signal) => done({ code, signal })));
  }

  async stop(): Promise<void> {
    if (this.child === null) return;
    const ended = this.exited();
    this.child.kill("SIGTERM");
    await ended;
    this.child = null;
  }

  kill(): void {
    this.child?.kill("SIGKILL");
  }
}


const readDb = <T>(path: string, work: (db: Database.Database) => T): T => {
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 30_000 });
  try {
    return work(db);
  } finally {
    db.close();
  }
};
const until = async (what: string, test: () => boolean, limit_ms: number): Promise<number> => {
  const started = Date.now();
  while (!test()) {
    if (Date.now() - started > limit_ms) throw new Error(`gave up waiting for ${what} after ${Math.round(limit_ms / 1000)} s`);
    await new Promise((done) => setTimeout(done, 250));
  }
  return Date.now() - started;
};
const seconds = (ms: number) => Math.round(ms / 100) / 10;

function freePages(path: string): { page_size: number; free: Set<number> } {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(100);
    readSync(fd, header, 0, 100, 0);
    const raw = header.readUInt16BE(16);
    const page_size = raw === 1 ? 65_536 : raw;
    const free = new Set<number>();
    const page = Buffer.alloc(page_size);
    for (let trunk = header.readUInt32BE(32); trunk !== 0;) {
      free.add(trunk);
      readSync(fd, page, 0, page_size, (trunk - 1) * page_size);
      const leaves = page.readUInt32BE(4);
      for (let i = 0; i < leaves; i++) free.add(page.readUInt32BE(8 + 4 * i));
      trunk = page.readUInt32BE(0);
    }
    return { page_size, free };
  } finally {
    closeSync(fd);
  }
}

function offsetsIn(path: string, needle: Buffer): number[] {
  if (!existsSync(path)) return [];
  const fd = openSync(path, "r");
  const found: number[] = [];
  try {
    const slice = Buffer.alloc(64 << 20);
    for (let at = 0, size = statSync(path).size; at < size; at += slice.length - needle.length) {
      const read = readSync(fd, slice, 0, slice.length, at);
      const view = slice.subarray(0, read);
      for (let i = view.indexOf(needle); i !== -1; i = view.indexOf(needle, i + 1)) if (!found.includes(at + i)) found.push(at + i);
      if (read < slice.length) break;
    }
  } finally {
    closeSync(fd);
  }
  return found;
}

function bytesOf(file: string, before: string, tokens: string[]) {
  const after = freePages(file);
  const was = existsSync(before) ? freePages(before).free : new Set<number>();
  const hits = { before: tokens.reduce((sum, token) => sum + offsetsIn(before, Buffer.from(token)).length, 0), in_use: 0, freed_by_erasure: 0, free_before: 0, log: 0 };
  for (const token of tokens) {
    for (const offset of offsetsIn(file, Buffer.from(token))) {
      const page = Math.floor(offset / after.page_size) + 1;
      if (!after.free.has(page)) hits.in_use++;
      else if (was.has(page)) hits.free_before++;
      else hits.freed_by_erasure++;
    }
    hits.log += offsetsIn(`${file}-wal`, Buffer.from(token)).length;
  }
  return { bytes: statSync(file).size, log_bytes: existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0, ...hits };
}


async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      out: { type: "string" }, size: { type: "string", default: "week" }, emails: { type: "string", default: "50000" },
      requests: { type: "string", default: "168000" }, replies: { type: "string", default: "246000" }, against: { type: "string" }, keep: { type: "boolean", default: false },
    },
  });
  if (values.out === undefined) throw new Error("--out <dir> is needed");
  const out = resolve(values.out);
  const tmp = join(out, "tmp");
  mkdirSync(tmp, { recursive: true });
  process.env.TMPDIR = tmp;
  const say = (line: string) => {
    const stamped = `${new Date().toISOString()} ${line}`;
    console.log(stamped);
    appendFileSync(join(out, "run.log"), `${stamped}\n`);
  };
  const report: Record<string, unknown> = { started: new Date().toISOString(), size: values.size, emails: Number(values.emails), requests: Number(values.requests), replies: Number(values.replies) };
  const save = () => writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const begun = Date.now();

  const { runVolume } = await import("./volume.js");
  say(`volume ${values.size}`);
  const volume = await runVolume({ size: values.size as SizeName, seed: 1, out: join(out, "volume"), keep: true, log: (line) => say(`  volume: ${line}`), ...(values.against === undefined ? {} : { against: values.against }) });
  const root = volume.root;
  const machine = join(tmp, readdirSync(tmp).find((name) => name.startsWith("vol-machine-"))!);
  report.volume = { seconds: volume.report.tool.seconds, report: volume.json, root, machine };
  report.fast = fastRow(volume.report, values.against);
  save();
  const homeDb = join(root, "home.db");
  const ledgerDb = join(root, "replies", "replies.db");
  const indexDb = () => searchFileOf(root, machine);
  const folder = openHomeFolder(root, { machine, program: "home" });
  const home = new HomeProcess(root, machine, join(out, "home.log"));
  const ask = async (verb: string, args: string[]) => askHome(homeSocket(root, machine), verb, args, () => undefined) as Promise<Record<string, unknown>>;
  const count = (sql: string, ...params: unknown[]) => readDb(homeDb, (db) => db.prepare(sql).pluck().get(...params) as number);
  const quiet = () => count("SELECT count(*) FROM jobs WHERE state = 'running' OR (state = 'queued' AND not_before_ms <= ?)", Date.now()) === 0
    && count("SELECT count(*) FROM deliveries WHERE state IN ('sealed', 'importing')") === 0;
  const settle = async (what: string, limit_ms = 4 * 3_600_000) => {
    const waited = await until(what, quiet, limit_ms);
    say(`  ${what}: ${seconds(waited)} s`);
    return waited;
  };
  const found = (token: string): number => {
    const answer = recordRead(folder, indexDb(), {}, (read) => read.search({ terms: termsOf(token).map((term) => ({ ...term, exact: true })), order: "relevance", limit: 50 }));
    if (answer === "busy") throw new Error("the search index is being written");
    return answer !== "none" && "hits" in answer ? answer.hits.length : 0;
  };
  const dayText = (day: string) => ["day.json", "day.txt", "day.lines.json"].map((suffix) => join(root, "days", `${day}.${suffix}`)).filter(existsSync).map((file) => readFileSync(file, "utf8")).join("\n");
  const standing = () => ({
    intent: count("SELECT count(*) FROM meta WHERE key = 'erasure'"),
    erasing: readDb(ledgerDb, (db) => db.prepare("SELECT count(*) FROM meta WHERE key = 'erasing'").pluck().get() as number),
  });
  const okRuns = () => count("SELECT count(*) FROM runs WHERE kind = 'erase' AND outcome = 'ok'");
  const copyAside = async (name: string) => {
    const dir = join(out, "copies", name);
    rmSync(join(out, "copies"), { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    for (const [file, copy] of [[homeDb, "home.db"], [ledgerDb, "replies.db"], [indexDb(), "index.db"]] as const) {
      const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 30_000 });
      try {
        await db.backup(join(dir, copy));
      } finally {
        db.close();
      }
    }
    return dir;
  };

  const now = Date.now();
  const emails = emailsOf(Number(values.emails), now);
  const pulls = {} as Record<Box, string[]>;
  BOXES.forEach((box, b) => { pulls[box] = sealPulls(root, box, emails[box], now - DAY_MS + b * 3_600_000); });
  for (const each of pending) await each;
  pending = [];
  say(`sealed ${BOXES.map((box) => `${box} ${emails[box].length} in ${pulls[box].length}`).join(", ")}`);
  await home.start();
  const mailIn = await settle("the mail imported and the home quiet");
  const mail = { counts: Object.fromEntries(BOXES.map((box) => [box, emails[box].length])), pulls: Object.fromEntries(BOXES.map((box) => [box, pulls[box].length])), import_seconds: seconds(mailIn),
    records: count("SELECT count(*) FROM heads WHERE source LIKE 'gmail:%'") };
  report.mail = mail;
  say(`mail records ${mail.records}`);
  await home.stop();

  const grown = growLedger(root, ledgerDb, homeDb, emails, Number(values.requests), Number(values.replies));
  report.ledger = grown;
  say(`ledger ${JSON.stringify(grown)}`);
  save();
  await home.start();
  await settle("the home quiet on the grown ledger");
  report.sizes = sizes(root, machine);
  const control = emails.all[0]!;
  report.control = { day_holds: dayText(civilDay(control.at_ms, DAY)).includes(control.token), search_finds: found(control.token) };
  say(`control: ${JSON.stringify(report.control)}`);
  save();

  const erasures: Record<string, unknown> = {};
  report.erasures = erasures;
  const erase = async (name: string, family: string, thing: string, purge: boolean) => {
    await copyAside(name);
    const plan_started = Date.now();
    const preview = await ask("erase", [family, thing, ...(purge ? ["--purge-deliveries"] : [])]);
    const plan_ms = Date.now() - plan_started;
    const started = Date.now();
    const applied = await ask("erase", [family, thing, ...(purge ? ["--purge-deliveries"] : []), "--apply"]);
    const wall_ms = Date.now() - started;
    const kept = { plan_ms, wall_ms, records: applied.records, days: (applied.days as string[] | undefined)?.length, deliveries_purged: applied.deliveries_purged,
      ledger: applied.ledger, logs_kept: applied.logs_kept, ms: applied.ms, items: (preview.items as string[] | undefined)?.length };
    erasures[name] = kept;
    say(`erased ${name}: ${JSON.stringify(kept)}`);
    save();
    return { preview, applied, started };
  };
  const message = readDb(homeDb, (db) => db.prepare("SELECT key FROM heads WHERE kind = 'msg' AND source LIKE 'whatsapp:%' ORDER BY key LIMIT 1 OFFSET 100").pluck().get() as string | undefined);
  if (message !== undefined) await erase("message", "messages", message, false);
  const photos = photosOf(homeDb);
  const photo = photos[Math.min(10, photos.length - 1)];
  if (photo !== undefined) await erase("photo", "photos", photo, false);
  await settle("quiet after the message and the photo");

  const verdict = (what: Email[], box: Box, deliveries: string[], runs_before: number, whole: boolean) => {
    const sample = what.slice(0, 5);
    const days = [...new Set(sample.map((email) => civilDay(email.at_ms, DAY)))];
    const purged = deliveries.filter((id) => count("SELECT count(*) FROM deliveries WHERE id = ? AND coalesce(error, '') NOT LIKE 'purged by erasure run %'", id) === 0
      && !existsSync(deliveryAt(openHomeFolder(root), id)));
    return {
      day_holds: sample.filter((email) => days.some((day) => dayText(day).includes(email.token))).length,
      search_finds: sample.reduce((sum, email) => sum + found(email.token), 0),
      records: whole ? count("SELECT count(*) FROM heads WHERE source = ?", sourceOf(box)) : sample.reduce((sum, email) => sum + count("SELECT count(*) FROM heads WHERE source = ? AND key = ?", sourceOf(box), email.msgid), 0),
      deliveries_named: deliveries.length, deliveries_purged: purged.length,
      ok_runs: okRuns() - runs_before, ...standing(),
    };
  };
  const intentNow = () => readDb(homeDb, (db) => db.prepare("SELECT value FROM meta WHERE key = 'erasure'").pluck().get() as string | undefined);
  const kills: Record<string, unknown> = {};
  report.kills = kills;
  const size = Math.ceil(emails.kills.length / POINTS.length);
  for (const [i, point] of POINTS.entries()) {
    const email = emails.kills[i * size]!;
    await home.stop();
    const runs_before = okRuns();
    await home.start(point);
    const thing = `${sourceOf("kills")}/${email.msgid}`;
    const died = await ask("erase", ["mail", thing, "--purge-deliveries", "--apply"]).then(() => "returned", (error: Error) => error.message.slice(0, 120));
    const exit = await home.exited();
    const intent = intentNow();
    const deliveries = intent === undefined ? [] : (JSON.parse(intent) as { deliveries: string[] }).deliveries;
    const restarted = Date.now();
    await home.start();
    await settle(`the start after ${point}`);
    kills[point] = { died, exit, intent_stood: intent !== undefined, restart_to_quiet_s: seconds(Date.now() - restarted), ...verdict([email], "kills", deliveries, runs_before, false) };
    say(`killed at ${point}: ${JSON.stringify(kills[point])}`);
    save();
  }

  report.single_index = bytesOf(indexDb(), join(out, "copies", "none"), POINTS.map((_, i) => emails.kills[i * size]!.token));
  say(`index after single erasures: ${JSON.stringify(report.single_index)}`);

  const between = async (name: string, box: Box, watched: string[]) => {
    const runs_before = okRuns();
    const present = watched.filter(existsSync);
    let caught: { gone: number; of: number } | null = null;
    const answer = ask("erase", ["mail", sourceOf(box), "--purge-deliveries", "--apply"]).then(() => "returned", (error: Error) => error.message.slice(0, 120));
    const watching = (async () => {
      while (caught === null) {
        const gone = present.filter((file) => !existsSync(file)).length;
        if (gone > 0 && gone < present.length) {
          home.kill();
          caught = { gone, of: present.length };
          return;
        }
        if (gone === present.length && present.length > 0) return;
        await new Promise((done) => setImmediate(done));
      }
    })();
    await watching;
    const died = await answer;
    await home.exited();
    const intent = intentNow();
    const deliveries = intent === undefined ? pulls[box] : (JSON.parse(intent) as { deliveries: string[] }).deliveries;
    await home.start();
    await settle(`the start after the kill between ${name}`);
    kills[`between ${name}`] = { died, caught, intent_stood: intent !== undefined, ...verdict(emails[box], box, deliveries, runs_before, true) };
    say(`killed between ${name}: ${JSON.stringify(kills[`between ${name}`])}`);
    save();
  };
  const dayFiles = [...new Set(emails.days.map((email) => civilDay(email.at_ms, DAY)))].map((day) => join(root, "days", `${day}.day.txt`));
  await between("two days' files", "days", dayFiles);
  const blobFiles = emails.blobs.map((email) => { const hex = hexOf(email.bytes); return join(root, "blobs", hex.slice(0, 2), hex.slice(2, 4), hex); });
  await between("two blobs", "blobs", blobFiles);

  const warm = preparedRuns(homeDb, 0);
  const { applied: one, started: applied_ms } = await erase("one mailbox", "mail", sourceOf("one"), true);
  const erasedDays = (one.days as string[]) ?? [];
  const sample = emails.one.slice(0, 5);
  report.returned = {
    erased_days: erasedDays.length,
    day_files_standing: erasedDays.filter((day) => existsSync(join(root, "days", `${day}.day.txt`))).length,
    day_files_holding: sample.filter((email) => dayText(civilDay(email.at_ms, DAY)).includes(email.token)).length,
    search_finds: sample.reduce((sum, email) => sum + found(email.token), 0),
    records: count("SELECT count(*) FROM heads WHERE source = ?", sourceOf("one")),
    ...standing(), logs_kept: one.logs_kept,
  };
  say(`as it returned: ${JSON.stringify(report.returned)}`);
  const people = preparedFileOf(preparedDirOf(root, machine, "people"), "people");
  const places = preparedFileOf(preparedDirOf(root, machine, "places"), "places");
  const cold_ms = await until("both prepared files again", () => existsSync(people) && existsSync(places) && preparedRuns(homeDb, applied_ms).ended >= 2, 2 * 3_600_000);
  report.prepared = { cold_to_both_s: seconds(cold_ms), warm: warm.durations, cold: preparedRuns(homeDb, applied_ms).durations };
  say(`prepared again: ${JSON.stringify(report.prepared)}`);
  await settle("quiet after one mailbox");
  save();

  await copyAside("mail all");
  const allPreview = await ask("erase", ["mail", "all"]);
  report.statements = ledgerStatements(join(out, "copies", "mail all", "replies.db"), allPreview.items as string[]);
  say(`ledger statements: ${JSON.stringify(report.statements)}`);
  await erase("mail all", "mail", "all", false);
  await home.stop();
  const tokens = emails.all.filter((_, i) => i % Math.floor(emails.all.length / 5) === 0).slice(0, 5).map((email) => email.token);
  const before = join(out, "copies", "mail all");
  report.bytes = {
    tokens: tokens.length,
    "home.db": bytesOf(homeDb, join(before, "home.db"), tokens),
    "replies.db": bytesOf(ledgerDb, join(before, "replies.db"), tokens),
    "index.db": bytesOf(indexDb(), join(before, "index.db"), tokens),
  };
  say(`bytes: ${JSON.stringify(report.bytes)}`);
  save();

  report.merge = await mergeCopy(indexDb(), join(out, "merge"), tokens, say);
  say(`merge: ${JSON.stringify(report.merge)}`);
  report.seconds = seconds(Date.now() - begun);
  save();
  writeFileSync(join(out, "report.md"), `# Erase measure\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`);
  rmSync(join(out, "copies"), { recursive: true, force: true });
  if (values.keep !== true) {
    rmSync(root, { recursive: true, force: true });
    rmSync(machine, { recursive: true, force: true });
  }
  say("done");
}

function fastRow(now: VolumeReport, against: string | undefined) {
  const pick = (report: VolumeReport) => ({
    history_in_s: report.scenarios.first_day.history_in_seconds, rows_a_second: report.scenarios.first_day.rows_a_second,
    rebuild_family_s: report.scenarios.rebuild.family.seconds, rebuild_every_day_s: report.scenarios.rebuild.every_day.seconds,
  });
  const after = pick(now);
  if (against === undefined) return { after };
  const before = pick(JSON.parse(readFileSync(against, "utf8")) as VolumeReport);
  const change = Object.fromEntries(Object.entries(after).map(([key, value]) => [key, Math.round((value / (before as Record<string, number>)[key]! - 1) * 1000) / 10]));
  return { before, after, change_percent: change };
}

function preparedRuns(homeDb: string, since_ms: number) {
  const rows = readDb(homeDb, (db) => db.prepare("SELECT kind, subject, started_ms, ended_ms FROM runs WHERE (kind IN ('people', 'places') OR subject IN ('people', 'places')) AND started_ms >= ? ORDER BY started_ms")
    .all(since_ms) as { kind: string; subject: string; started_ms: number; ended_ms: number | null }[]);
  return {
    ended: new Set(rows.filter((row) => row.ended_ms !== null).map((row) => `${row.kind} ${row.subject}`)).size,
    durations: rows.slice(-6).map((row) => ({ run: `${row.kind} ${row.subject}`, s: row.ended_ms === null ? null : seconds(row.ended_ms - row.started_ms) })),
  };
}

function photosOf(homeDb: string): string[] {
  return readDb(homeDb, (db) => db.prepare("SELECT source, key FROM heads WHERE kind = 'img' AND source LIKE 'apple-photos:%' ORDER BY source, key").all() as { source: string; key: string }[])
    .map((head) => `photo:${head.source}/${head.key}`);
}

function sizes(root: string, machine: string) {
  const size = (file: string) => existsSync(file) ? statSync(file).size : 0;
  const index = searchFileOf(root, machine);
  return {
    "home.db": size(join(root, "home.db")) + size(join(root, "home.db-wal")),
    "replies.db": size(join(root, "replies", "replies.db")) + size(join(root, "replies", "replies.db-wal")),
    "index.db": size(index) + size(`${index}-wal`),
  };
}

function growLedger(root: string, ledgerDb: string, homeDb: string, emails: Record<Box, Email[]>, requests: number, replies: number) {
  const db = new Database(ledgerDb, { fileMustExist: true, timeout: 30_000 });
  const blobs = join(root, "replies", "blobs");
  const counts = { requests: 0, replies: 0, attachments: 0, attempts: 0 };
  try {
    db.pragma("journal_mode = WAL");
    const prompt = `sha256:${hexOf("synthetic prompt")}`;
    db.prepare("INSERT OR IGNORE INTO prompts(hash, version, text) VALUES (?, '1', 'synthetic prompt')").run(prompt);
    const request = db.prepare(`INSERT INTO requests(key, family, feeder, unit, revision, model, effort, transport, prompt_hash, input_hash, body, attachments, requested, open, prompt, prompt_version)
      VALUES (?, ?, NULL, ?, ?, 'synthetic-model', 'low', 'fake', ?, ?, ?, ?, ?, 0, 'synthetic', 1)`);
    const attempt = db.prepare("INSERT INTO attempts(key, state, started, finished) VALUES (?, 'replied', ?, ?)");
    const outcome = db.prepare("INSERT INTO outcomes(attempt, key, state) VALUES (?, ?, 'replied')");
    const reply = db.prepare("INSERT INTO replies(key, model, prompt_hash, input_hash, text, created, unit, prompt, prompt_version, validation) VALUES (?, 'synthetic-model', ?, ?, ?, ?, ?, 'synthetic', 1, 'accepted')");
    const at = new Date().toISOString();
    const units: { family: string; unit: string; text: string; image: boolean }[] = [];
    for (const box of BOXES) for (const email of emails[box]) {
      units.push({ family: "mail", unit: `${sourceOf(box)}/${email.msgid}`, text: `Tag this email: Synthetic notice ${email.n} ${email.token}. ${email.n % 10 === 0 ? FILLER.join(" ").repeat(60) : FILLER.join(" ")}`, image: false });
    }
    for (const item of photosOf(homeDb)) units.push({ family: "photos", unit: item, text: "Caption this photo.", image: true });
    for (let n = 0; units.length < requests; n++) units.push({ family: n % 3 === 0 ? "ai" : "messages", unit: `synthetic:${n}`, text: `Read this synthetic passage ${n}. ${FILLER.join(" ")}`, image: n % 7 === 0 });
    const write = db.transaction((batch: typeof units, offset: number) => {
      batch.forEach((each, i) => {
        const key = `sha256:${hexOf(`request ${offset + i}`)}`;
        let attachments = "[]";
        if (each.image) {
          const bytes = Buffer.from(`synthetic image ${offset + i} `.repeat(800));
          const hex = hexOf(bytes);
          mkdirSync(join(blobs, hex.slice(0, 2), hex.slice(2, 4)), { recursive: true });
          writeFileSync(join(blobs, hex.slice(0, 2), hex.slice(2, 4), hex), bytes);
          attachments = JSON.stringify([{ kind: "image", sha256: hex, extension: ".jpg" }]);
          counts.attachments++;
        }
        const input = `sha256:${hexOf(`input ${offset + i}`)}`;
        request.run(key, each.family, each.unit, key, prompt, input, JSON.stringify({ messages: [{ role: "user", content: each.text }] }), attachments, at);
        const id = Number(attempt.run(key, at, at).lastInsertRowid);
        outcome.run(id, key);
        reply.run(key, prompt, input, JSON.stringify({ answer: `synthetic answer ${offset + i}` }), at, each.unit);
        counts.requests++; counts.attempts++; counts.replies++;
      });
    });
    for (let first = 0; first < units.length; first += 10_000) write(units.slice(first, first + 10_000), first);
    const older = db.transaction((from: number, to: number) => {
      for (let n = from; n < to; n++) {
        const each = units[n % units.length]!;
        reply.run(`sha256:${hexOf(`older reply ${n}`)}`, prompt, `sha256:${hexOf(`older input ${n}`)}`, JSON.stringify({ answer: `an older synthetic answer ${n}` }), at, each.unit);
        counts.replies++;
      }
    });
    for (let n = 0; counts.replies < replies; n += 10_000) older(n, Math.min(n + 10_000, n + replies - counts.replies));
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  return counts;
}

function ledgerStatements(copy: string, items: string[]) {
  const db = new Database(copy, { fileMustExist: true });
  try {
    const wanted = new Set(items);
    const clock = () => { const started = process.hrtime.bigint(); return () => Number(process.hrtime.bigint() - started) / 1e6; };
    db.exec("BEGIN");
    let tick = clock();
    let walked = 0;
    for (const row of db.prepare("SELECT key, invocation, unit FROM replies WHERE unit IS NOT NULL").iterate() as Iterable<{ unit: string }>) if (wanted.has(row.unit)) walked++;
    const walk_ms = tick();
    const keys: string[] = [];
    const files = new Set<string>();
    const requestsOf = db.prepare("SELECT key, attachments FROM requests WHERE unit = ?");
    const drop = db.prepare("DELETE FROM requests WHERE key = ?");
    tick = clock();
    for (const item of wanted) {
      for (const row of requestsOf.all(item) as { key: string; attachments: string }[]) {
        keys.push(row.key);
        for (const file of JSON.parse(row.attachments) as { sha256: string }[]) files.add(file.sha256);
        drop.run(row.key);
      }
    }
    const requests_ms = tick();
    tick = clock();
    const outcomes = db.prepare("DELETE FROM outcomes WHERE key IN (SELECT value FROM json_each(?))").run(JSON.stringify(keys)).changes;
    const outcomes_ms = tick();
    tick = clock();
    const named = db.prepare("SELECT 1 FROM requests WHERE instr(attachments, ?) > 0 LIMIT 1");
    const sample = files.size > 0 ? [...files] : (db.prepare("SELECT attachments FROM requests WHERE attachments <> '[]' LIMIT 50").pluck().all() as string[]).flatMap((text) => (JSON.parse(text) as { sha256: string }[]).map((file) => `${file.sha256}x`));
    for (const sha256 of sample) named.get(sha256);
    const instr_ms = tick();
    db.exec("ROLLBACK");
    return { items: items.length, replies_walked_matches: walked, walk_ms: Math.round(walk_ms), requests: keys.length, requests_ms: Math.round(requests_ms), outcomes_deleted: outcomes, outcomes_ms: Math.round(outcomes_ms),
      instr_checks: sample.length, instr_named_by_erased: files.size, instr_ms: Math.round(instr_ms), instr_ms_each: sample.length === 0 ? null : Math.round((instr_ms / sample.length) * 10) / 10 };
  } finally {
    db.close();
  }
}

async function mergeCopy(index: string, dir: string, tokens: string[], say: (line: string) => void) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const copy = join(dir, "index.db");
  const source = new Database(index, { readonly: true, fileMustExist: true });
  try {
    await source.backup(copy);
  } finally {
    source.close();
  }
  const before_bytes = statSync(copy).size;
  const db = new Database(copy, { fileMustExist: true });
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("wal_autocheckpoint = 0");
    db.pragma("secure_delete = ON");
    const pageSize = db.pragma("page_size", { simple: true }) as number;
    const changes = () => db.prepare("SELECT total_changes()").pluck().get() as number;
    let frames = 0;
    const step = (count: number) => {
      const was = changes();
      const started = Date.now();
      db.prepare("INSERT INTO fts(fts, rank) VALUES ('merge', ?)").run(count);
      const ms = Date.now() - started;
      const [, log] = (db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number; log: number; checkpointed: number }[]).map((row) => [row.busy, row.log])[0]!;
      frames += log!;
      return { ms, changed: changes() - was >= 2 };
    };
    const started = Date.now();
    const first = step(-16);
    let longest = first.ms;
    let steps = 1;
    for (let last = first; last.changed && steps < 200_000 && Date.now() - started < 3_600_000; steps++) {
      last = step(64);
      longest = Math.max(longest, last.ms);
      if (steps % 500 === 0) say(`  merge: ${steps} steps, ${seconds(Date.now() - started)} s`);
    }
    const whole_ms = Date.now() - started;
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    const hits = tokens.reduce((sum, token) => sum + offsetsIn(copy, Buffer.from(token)).length + offsetsIn(`${copy}-wal`, Buffer.from(token)).length, 0);
    const result = { whole_s: seconds(whole_ms), steps, longest_step_ms: longest, frames_written: frames, bytes_written: frames * pageSize, index_bytes_before: before_bytes, index_bytes_after: statSync(copy).size, token_hits_after: hits };
    rmSync(dir, { recursive: true, force: true });
    return result;
  } catch (error) {
    if (db.open) db.close();
    throw error;
  }
}

await main();
