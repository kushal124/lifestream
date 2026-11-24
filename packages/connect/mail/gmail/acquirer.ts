import { createHash } from "node:crypto";
import {
  feeds, movedEarlier, NeedsYou, NotYet, offline, Refused, rfc3339, UNDATED,
  type Acquirer, type Dependencies, type Fetched, type FetchedFile, type ImapClient, type ImapMailbox, type ImapMessage, type ImapQuery, type ImapSizeQuery, type JsonObject, type Lent, type Memory, type Months, type Secrets, type SignedIn,
} from "@lifestreamprotocol/connect/sdk";
import { GMAIL_IMAP, PULL_FORMAT, PULL_MANIFEST } from "./reader.js";

function refuse(message: string): never {
  throw new Refused(`gmail-imap: ${message}`);
}

export interface GmailImapSettings {
  account: string;
  password: string;
  spam?: boolean;
  trash?: boolean;
  per_poll?: number;
  bootstrap?: Record<string, FolderCursor>;
}

export interface FolderCursor {
  uidvalidity: string;
  uidnext: string;
  low?: string;
  start?: string;
  read?: { low: string; since: string };
}

export interface GmailImapState {
  polled_ms: number;
  folders: Record<string, FolderCursor>;
  counted?: true;
}

export const CHARGED = "charged";

interface Charge {
  at_ms: number;
  n: number;
}

const USES = { "\\All": "All Mail", "\\Junk": "Spam", "\\Trash": "Trash" } as const;

async function flagged(client: { list(): Promise<readonly ImapMailbox[]> }, uses: readonly (keyof typeof USES)[]): Promise<string[]> {
  const listed = await client.list();
  return uses.map((use) => listed.find((mailbox) => mailbox.specialUse === use)?.path
    ?? refuse(`the server lists no mailbox flagged ${use}: ${USES[use]} is hidden from IMAP; tick "Show in IMAP" beside ${USES[use]} in Gmail's settings, under Labels`));
}

const HOST = "imap.gmail.com";
const PORT = 993;
const PER_POLL = 500;
const DAY_BYTES = 2_000_000_000;
const DAY_MS = 86_400_000;
const THROTTLE_MS = 3_600_000;
const THROTTLED = "Gmail answered THROTTLED";
const QUERY: ImapQuery = { uid: true, source: true, threadId: true, labels: true, internalDate: true };
const SIZES: ImapSizeQuery = { uid: true, size: true };
const DATED: ImapSizeQuery = { uid: true, size: true, internalDate: true };

export function gmailImapAcquirer(settings: GmailImapSettings, dependencies: Dependencies = {}): Acquirer {
  const perPoll = settings.per_poll ?? PER_POLL;
  const now = dependencies.now ?? Date.now;
  const source = `gmail:${settings.account}:cloud`;

  async function session<T extends object>(
    state: JsonObject | null,
    secrets: Secrets,
    lent: Lent,
    read: (client: ImapClient, call: Call) => Promise<{ next: Record<string, FolderCursor>; folders: JsonObject[] } & T>,
  ): Promise<Fetched & T> {
    if (!Number.isSafeInteger(perPoll) || perPoll < 1) refuse("per_poll must be a positive integer");
    const previous = state as GmailImapState | null;
    const cursors = underStart({ ...(settings.bootstrap ?? {}), ...(previous?.folders ?? {}) }, lent);
    const password = secret(secrets, settings.password);
    const at = now();
    const fetchedAt = rfc3339(at);
    const pull: Pull = { files: [], messages: [], sealed: new Set(), bytes: 0 };
    const charged = chargesIn(lent.memory);
    const counted = previous?.counted === true;
    const keep = (folders: Record<string, FolderCursor>, count = counted): JsonObject => {
      charge(lent.memory, charged, at, pull.bytes);
      return { polled_ms: at, folders, ...(count ? { counted: true } : {}) } satisfies GmailImapState as unknown as JsonObject;
    };
    const client = await imapOf(dependencies)({ host: HOST, port: PORT, account: settings.account, password });
    let answer: { next: Record<string, FolderCursor>; folders: JsonObject[] } & T;
    try {
      await login(client);
      answer = await read(client, { cursors, at, pull, keep, counted, start_ms: lent.start_ms, spent: charged.filter((entry) => entry.at_ms > at - DAY_MS) });
    } catch (error) {
      if (error instanceof NotYet || error instanceof NeedsYou || error instanceof Refused) throw error;
      if (throttled(error)) throw new NotYet("provider-limit", THROTTLED, { state: keep(cursors), backoff_ms: at + THROTTLE_MS });
      if (pull.bytes === 0) throw error;
      throw new NotYet(offline(error) ? "offline" : "retrying", error instanceof Error ? error.message : String(error), { state: keep(cursors) });
    } finally {
      try {
        await client.logout();
      } catch {
        client.close();
      }
    }
    const { next, folders, ...said } = answer;
    const manifest = { format: PULL_FORMAT, complete: true, account: settings.account, fetched_at: fetchedAt, folders, messages: pull.messages };
    return {
      files: pull.messages.length === 0 ? [] : [...pull.files, { path: PULL_MANIFEST, bytes: Buffer.from(`${JSON.stringify(manifest)}\n`) }],
      facts: { fetched_at: fetchedAt, account: settings.account, messages: pull.messages.length, ...feeds(source, GMAIL_IMAP) },
      state: keep(next, counted || (said as { months?: Months }).months !== undefined),
      ...(said as unknown as T),
    };
  }

  const uses = ["\\All", ...(settings.spam === true ? ["\\Junk"] as const : []), ...(settings.trash === true ? ["\\Trash"] as const : [])] as const;

  return {
    name: GMAIL_IMAP,
    source,
    months: true,
    fetch: (state, secrets, lent) => session<{ more?: true }>(state, secrets, lent, async (client, { cursors, pull, start_ms }) => {
      const next: Record<string, FolderCursor> = { ...cursors };
      const folders: JsonObject[] = [];
      const polled = await flagged(client, uses);
      const looked: { folder: string; uidvalidity: string; uidNext: number }[] = [];
      for (const folder of polled) {
        const mailbox = await client.mailboxOpen(folder, { readOnly: true });
        const uidvalidity = String(mailbox.uidValidity);
        const cursor = cursors[folder];
        if (cursor !== undefined && uidvalidity !== cursor.uidvalidity) changed(folder, uidvalidity, cursor);
        looked.push({ folder, uidvalidity, uidNext: mailbox.uidNext });
      }
      let open = polled.at(-1);
      let more = false;
      for (const { folder, uidvalidity, uidNext } of looked) {
        const cursor = cursors[folder];
        if (cursor === undefined) {
          next[folder] = { uidvalidity, uidnext: String(uidNext) };
          folders.push({ folder, uidvalidity, uidnext: next[folder]!.uidnext });
          continue;
        }
        const from = Number(cursor.uidnext);
        const room = perPoll - pull.messages.length;
        let through = from - 1;
        if (uidNext > from && room > 0) {
          through = Math.min(uidNext - 1, from + room - 1);
          if (open !== folder) {
            const mailbox = await client.mailboxOpen(folder, { readOnly: true });
            if (String(mailbox.uidValidity) !== uidvalidity) changed(folder, String(mailbox.uidValidity), cursor);
            open = folder;
          }
          const last = through;
          await download(client, folder, await sizesOf(client, `${from}:${through}`, DATED, (message) => message.uid >= from && message.uid <= last && !before(message, start_ms)), pull);
        }
        if (uidNext - 1 > through) more = true;
        next[folder] = { ...cursor, uidvalidity, uidnext: String(Math.max(from, through + 1)) };
        folders.push({ folder, uidvalidity, uidnext: next[folder]!.uidnext });
      }
      return { next, folders, ...(more ? { more: true as const } : {}) };
    }),
    page: (state, secrets, lent) => session<{ left: number; months?: Months }>(state, secrets, lent, async (client, { cursors, at, pull, keep, counted, spent }) => {
      const [folder, ...others] = await flagged(client, uses) as [string, ...string[]];
      const mailbox = await client.mailboxOpen(folder, { readOnly: true });
      const uidvalidity = String(mailbox.uidValidity);
      const { read: passed, ...held } = cursors[folder] ?? ({} as Partial<FolderCursor>);
      if (held.uidvalidity !== undefined && uidvalidity !== held.uidvalidity) changed(folder, uidvalidity, held as FolderCursor);
      const live = held.uidnext ?? String(mailbox.uidNext);
      const start = held.start ?? live;
      const since = lent.start_ms === null ? undefined : dayOf(lent.start_ms);
      const low = Number(held.low ?? start);
      const read = passed !== undefined && Number(passed.low) < low ? passed : undefined;
      const cursor: FolderCursor = { uidvalidity, uidnext: live, start, low: String(low), ...(read === undefined ? {} : { read }) };
      const counts = low === Number(start) || !counted;
      const done = async (left: number, after: FolderCursor) => ({
        next: { ...cursors, [folder]: after }, folders: [{ folder, uidvalidity, uidnext: live }], left, ...(counts ? { months: await countOf(client, mailbox.uidNext, others) } : {}),
      });
      if (low <= 1) return done(0, cursor);
      const found = await search(client, { uid: `1:${low - 1}`, ...(since === undefined ? {} : { since: new Date(since) }) });
      const already = new Set(read === undefined ? [] : await search(client, { uid: `${read.low}:${low - 1}`, since: new Date(read.since) }));
      const candidates = [...new Set(found.filter((uid) => uid >= 1 && uid < low && !already.has(uid)))].sort((left, right) => right - left);
      if (candidates.length === 0) return done(0, cursor);
      const highest = candidates.slice(0, perPoll);
      const asked = new Set(highest);
      const sizes = await sizesOf(client, set(highest), SIZES, (message) => asked.has(message.uid));
      let free = DAY_BYTES - spent.reduce((sum, entry) => sum + entry.n, 0);
      const chosen: number[] = [];
      for (const uid of highest) {
        const size = sizes.get(uid) ?? 0;
        if (size > free) break;
        free -= size;
        chosen.push(uid);
      }
      if (chosen.length === 0) {
        throw new NotYet("provider-limit", "the daily download allowance is spent", { state: keep({ ...cursors, [folder]: cursor }), next_ms: aged(spent, (sizes.get(highest[0]!) ?? 0) - free, at) });
      }
      await download(client, folder, new Map(chosen.map((uid) => [uid, sizes.get(uid) ?? 0])), pull);
      return done(candidates.length - chosen.length, { ...cursor, low: String(Math.min(...chosen)) });
    }),
  };
}

interface Call {
  cursors: Record<string, FolderCursor>;
  at: number;
  pull: Pull;
  keep(folders: Record<string, FolderCursor>): JsonObject;
  counted: boolean;
  start_ms: number | null;
  spent: readonly Charge[];
}

const dayOf = (ms: number): string => rfc3339(ms).slice(0, 10);

function underStart(cursors: Record<string, FolderCursor>, lent: Lent): Record<string, FolderCursor> {
  const from_ms = movedEarlier(lent);
  if (from_ms === null) return cursors;
  return Object.fromEntries(Object.entries(cursors).map(([folder, cursor]) => [
    folder, cursor.low === undefined || cursor.start === undefined ? cursor : { ...cursor, start: cursor.uidnext, low: cursor.uidnext, read: { low: cursor.low, since: dayOf(from_ms) } },
  ]));
}

function before(message: ImapMessage, start_ms: number | null): boolean {
  const at = message.internalDate instanceof Date ? message.internalDate.getTime() : Number.NaN;
  return start_ms !== null && Number.isFinite(at) && at < start_ms;
}

async function search(client: ImapClient, query: { uid: string; since?: Date }): Promise<number[]> {
  const found = await client.search(query, { uid: true });
  if (!Array.isArray(found)) throw new Error(`Gmail refused UID SEARCH UID ${query.uid}`);
  return found;
}

async function sizesOf(client: ImapClient, range: string, query: ImapSizeQuery, wanted: (message: ImapMessage) => boolean): Promise<Map<number, number>> {
  const sizes = new Map<number, number>();
  for await (const message of client.fetch(range, query, { uid: true })) if (wanted(message)) sizes.set(message.uid, message.size ?? 0);
  return sizes;
}

async function countOf(client: ImapClient, uidNext: number, others: readonly string[]): Promise<Months> {
  const months: Months = {};
  await count(client, uidNext, months);
  for (const folder of others) await count(client, (await client.mailboxOpen(folder, { readOnly: true })).uidNext, months);
  return months;
}

async function count(client: ImapClient, uidNext: number, months: Months): Promise<void> {
  if (uidNext <= 1) return;
  for await (const message of client.fetch(`1:${uidNext - 1}`, DATED, { uid: true })) {
    const month = monthOf(message.internalDate);
    const [items, bytes] = months[month] ?? [0, 0];
    months[month] = [items + 1, (bytes ?? 0) + (message.size ?? 0)];
  }
}

function monthOf(date: Date | undefined): string {
  const month = date instanceof Date && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 7) : UNDATED;
  return /^\d{4}-\d{2}$/u.test(month) ? month : UNDATED;
}

async function download(client: ImapClient, folder: string, sizes: ReadonlyMap<number, number>, pull: Pull): Promise<void> {
  if (sizes.size === 0) return;
  for (const size of sizes.values()) pull.bytes += size;
  const answered: ImapMessage[] = [];
  for await (const message of client.fetch(set([...sizes.keys()]), QUERY, { uid: true })) if (sizes.has(message.uid)) answered.push(message);
  take(folder, answered, pull);
}

interface Pull {
  files: FetchedFile[];
  messages: JsonObject[];
  sealed: Set<string>;
  bytes: number;
}

function take(folder: string, answered: readonly ImapMessage[], pull: Pull): void {
  for (const message of [...answered].sort((left, right) => left.uid - right.uid)) {
    const entry = pulled(folder, message);
    if (pull.sealed.has(entry.gm_msgid)) continue;
    pull.sealed.add(entry.gm_msgid);
    pull.files.push({ path: entry.file, bytes: message.source! });
    pull.messages.push(entry);
  }
}

function chargesIn(memory: Memory): Charge[] {
  const charges: Charge[] = [];
  for (let page = memory.list(CHARGED); page.length > 0; page = memory.list(CHARGED, page.at(-1)![0])) {
    for (const [key, n] of page) charges.push({ at_ms: Number(key), n: n as number });
  }
  return charges;
}

function charge(memory: Memory, charged: readonly Charge[], at: number, n: number): void {
  for (const entry of charged) if (entry.at_ms <= at - DAY_MS) memory.drop(CHARGED, String(entry.at_ms));
  if (n > 0) memory.put(CHARGED, String(at), (charged.find((entry) => entry.at_ms === at)?.n ?? 0) + n);
}

function aged(bytes: readonly Charge[], need: number, at: number): number {
  let freed = 0;
  for (const entry of [...bytes].sort((left, right) => left.at_ms - right.at_ms)) {
    freed += entry.n;
    if (freed >= need) return entry.at_ms + DAY_MS;
  }
  return at + DAY_MS;
}

function set(uids: readonly number[]): string {
  const sorted = [...uids].sort((left, right) => left - right);
  const runs: string[] = [];
  for (let index = 0; index < sorted.length; ) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1) end++;
    runs.push(end === index ? String(sorted[index]) : `${sorted[index]}:${sorted[end]}`);
    index = end + 1;
  }
  return runs.join(",");
}

function changed(folder: string, uidvalidity: string, cursor: FolderCursor): never {
  return refuse(`folder ${JSON.stringify(folder)} states UIDVALIDITY ${uidvalidity}, its cursor ${cursor.uidvalidity}; a full pull of a folder is a person's decision`);
}

function throttled(error: unknown): boolean {
  const answer = (error as { response?: { attributes?: { section?: { value?: unknown }[] }[] } } | null)?.response;
  const code = typeof answer === "object" && answer !== null ? answer.attributes?.[0]?.section?.[0]?.value : undefined;
  return typeof code === "string" && code.toUpperCase() === "THROTTLED";
}

interface PulledMessage extends JsonObject {
  file: string;
  folder: string;
  gm_msgid: string;
  gm_thrid: string;
  labels: string[];
  internaldate: string;
  sha256: string;
  bytes: number;
}

function pulled(folder: string, message: ImapMessage): PulledMessage {
  const at = `${folder} UID ${message.uid}`;
  const gmMsgid = decimal(message.emailId, `${at} X-GM-MSGID`);
  const gmThrid = decimal(message.threadId, `${at} X-GM-THRID`);
  const source = message.source;
  if (source === undefined || source.length === 0) refuse(`${at} answered with no message source`);
  const date = message.internalDate;
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) refuse(`${at} answered with no INTERNALDATE`);
  return {
    file: `msg-${gmMsgid}.eml`,
    folder,
    gm_msgid: gmMsgid,
    gm_thrid: gmThrid,
    labels: [...new Set(message.labels ?? [])].sort(),
    internaldate: rfc3339(date.getTime()),
    sha256: createHash("sha256").update(source).digest("hex"),
    bytes: source.length,
  };
}

export const gmailSignedIn: SignedIn = async ({ fields, credential, signal }, dependencies = {}) => {
  const password = credential.replace(/\s/gu, "");
  const account = typeof fields.account === "string" ? fields.account : refuse("the sign-in names no Gmail address");
  signal.throwIfAborted();
  const client = await imapOf(dependencies)({ host: HOST, port: PORT, account, password });
  if (signal.aborted) {
    client.close();
    throw signal.reason;
  }
  let stop!: (reason: unknown) => void;
  const stopped = new Promise<never>((_, reject) => { stop = reject; });
  const abort = () => {
    client.close();
    stop(signal.reason);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await Promise.race([(async () => {
      await login(client);
      try {
        await client.logout();
      } catch {
        client.close();
      }
    })(), stopped]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
  return { credential: password };
};

function imapOf(dependencies: Dependencies): NonNullable<Dependencies["imap"]> {
  return dependencies.imap ?? refuse("the home lends no IMAP connection (Dependencies.imap)");
}

async function login(client: ImapClient): Promise<void> {
  try {
    await client.connect();
  } catch (error) {
    client.close();
    if (refusedLogin(error)) throw new NeedsYou("signed-out", "Gmail did not accept this app password");
    throw error;
  }
}

function refusedLogin(error: unknown): boolean {
  const failed = error as { authenticationFailed?: unknown; response?: unknown; serverResponseCode?: unknown };
  return failed.authenticationFailed === true && ((typeof failed.response === "string" && failed.response !== "") || typeof failed.serverResponseCode === "string");
}

function secret(secrets: Secrets, service: string): string {
  const value = secrets.get(service);
  if (value === undefined) refuse(`no secret is stored for ${service}`);
  return value;
}

function decimal(value: unknown, where: string): string {
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/u.test(value)) return value;
  return refuse(`${where} is not a decimal id`);
}
