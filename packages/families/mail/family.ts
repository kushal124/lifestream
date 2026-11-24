import {
  daysOf, digest, handleId, handleOf, instant, render, textHead,
  type Ask, type BlobReader, type DaySettings, type ExtractRow, type Head, type Json, type MailAdapter, type MailItem, type Piece, type RecordRef, type Reply,
  type SourceRow, type SourceSelector, type Version, type View,
} from "@lifestreamprotocol/core";
import { labelInputs, type Books } from "../shared/labels.js";
import { factId, type Change, type Collection, type DayFact, type DayLine, type DayProjection, type Family, type Given, type Labels, type Plan, type Touched } from "../family.js";
import { joined, nameParty, printed, type Printed, type Printable } from "../shared/cast.js";
import { readMail, type MailAddress } from "../shared/mime.js";
import { BLOB_BYTES, recordRead, recordText } from "../shared/text.js";
import { MAIL_TAG, MAIL_TAG_PROMPT, tagInput, tagOf, tagPack, tagRefusal, type MailTag } from "./tag.js";

export const MAIL_FAMILY = "mail";
export const MAIL_KIND = "mailmsg";
export const ERASE_ALL = "all";
export const MAIL_BODY_CAP = 10_000;
const DAY_MS = 86_400_000;

export interface MailEntry {
  key: string;
  at_ms: number;
  route: "read" | "bulk" | "junk";
  junk: string | null;
  draft: boolean;
  from: { address: string; name: string | null } | null;
  to: { address: string; name: string | null }[];
  subject: string;
  attachments: string[];
  invitation: string | null;
  body: string | null;
  unreadable: string | null;
  pack: Piece[] | null;
}

export interface MailDayContent {
  source: string;
  mails: MailEntry[];
}

const READERS: Readonly<Record<string, (value: Json) => string | null>> = { [MAIL_TAG]: tagRefusal };

export function mailFamily(books: Books): (given: readonly Given<MailAdapter>[]) => Family {
  return (given) => mailOver(books, given);
}

function mailOver(books: Books, given: readonly Given<MailAdapter>[]): Family {
  const byProduct = new Map(given.filter((each) => each.adapter.kinds.includes(MAIL_KIND)).map((each) => [each.product, each.adapter]));
  const mailboxes: SourceSelector = { product: [...byProduct.keys()] };
  const adapterOf = (source: SourceRow | undefined): MailAdapter | undefined => source === undefined ? undefined : byProduct.get(source.product);
  return {
    name: MAIL_FAMILY,
    adapters: given,
    type: "mail",
    code: "6",
    inputs: [{ sources: mailboxes, kinds: [MAIL_KIND], role: "evidence" }, ...labelInputs(books)],
    prompts: { [MAIL_TAG]: MAIL_TAG_PROMPT },
    readers: READERS,
    works: { mail: mailboxes },

    touched(changes: readonly Change[], view: View): Touched[] {
      return changes.flatMap((change): Touched[] => {
        const source = view.source(change.record.source);
        if (change.record.kind !== MAIL_KIND || adapterOf(source) === undefined) return [];
        const units = [change.before, change.after].flatMap((version) => {
          const day = utcDay(version);
          return day === null ? [] : [`${change.record.source}/${day}`];
        });
        return [...new Set(units)].map((unit) => ({ unit }));
      });
    },

    extract(unit: string, view: View, files: BlobReader) {
      const slash = unit.lastIndexOf("/");
      const source = unit.slice(0, slash);
      const row = view.source(source);
      const adapter = adapterOf(row);
      if (adapter === undefined) return null;
      const start_ms = instant(unit.slice(slash + 1), "date").start_ms;
      const read: { entry: MailEntry; thread: string | null }[] = [];
      for (const { head, version } of view.records(source, MAIL_KIND, { start_ms, end_ms: start_ms + DAY_MS })) {
        const at_ms = version.time?.start_ms;
        if (at_ms === undefined || at_ms < start_ms || at_ms >= start_ms + DAY_MS) continue;
        const entry = readEntry(head, at_ms, (header) => adapter.mail({ source: row!, version }, header), files);
        if (entry !== null) read.push(entry);
      }
      read.sort((left, right) => left.entry.at_ms - right.entry.at_ms || compare(left.entry.key, right.entry.key));
      const mails = read.filter((mail, at) => !replaced(mail, read.slice(at + 1))).map((mail) => mail.entry);
      if (mails.length === 0) return null;
      const content = { source, mails } satisfies MailDayContent as unknown as Json;
      return { content, start_ms: mails[0]!.at_ms, end_ms: mails.at(-1)!.at_ms, reading: digest(content) };
    },

    days(extract: ExtractRow, settings: DaySettings): string[] {
      const days = new Set<string>();
      for (const entry of entries(extract)) for (const day of daysOf({ start_ms: entry.at_ms, precision: "ms" }, settings)) days.add(day);
      return [...days].sort();
    },

    items(extract: ExtractRow) {
      const { source } = content(extract);
      return entries(extract).flatMap((entry) => entry.pack === null ? [] : [{ item: itemOf(source, entry.key), prompt: MAIL_TAG }]);
    },

    plan(extract: ExtractRow, answered: ReadonlyMap<string, Reply>): Plan {
      const { source } = content(extract);
      const asks: Ask[] = [];
      const answers: { item: string; content: Json }[] = [];
      const refusals: { item: string; reason: string }[] = [];
      for (const entry of entries(extract)) {
        if (entry.pack === null) continue;
        const item = itemOf(source, entry.key);
        const reply = answered.get(item);
        if (reply === undefined) {
          asks.push({ family: "mail", item, prompt: MAIL_TAG, input: tagInput(entry.pack), work: "mail", source });
          continue;
        }
        const refused = READERS[MAIL_TAG]!(reply.value);
        if (refused === null) answers.push({ item, content: tagOf(reply.value) });
        else refusals.push({ item, reason: refused });
      }
      return { asks, answers, refusals };
    },

    replicas(thing, view) {
      const held = view.sources(mailboxes).map((source) => source.id);
      const whole = thing === ERASE_ALL ? held : held.filter((id) => id === thing);
      const records: RecordRef[] = [];
      for (const source of whole) {
        const seen = new Set<string>();
        for (const { kind, key } of view.statements(0, { sources: [source] })) {
          if (seen.has(`${kind}\0${key}`)) continue;
          seen.add(`${kind}\0${key}`);
          records.push({ source, kind, key });
        }
      }
      const slash = thing.lastIndexOf("/");
      const email = { source: thing.slice(0, Math.max(slash, 0)), kind: MAIL_KIND, key: thing.slice(slash + 1) };
      if (whole.length === 0 && slash > 0 && held.includes(email.source) && view.head(email) !== undefined) records.push(email);
      records.sort((left, right) => compare(left.source, right.source) || compare(left.kind, right.kind) || compare(left.key, right.key));
      return { records, items: records.filter((record) => record.kind === MAIL_KIND).map((record) => itemOf(record.source, record.key)) };
    },

    text: {
      version: "1",
      kinds: [MAIL_KIND],
      of(record, version, files, view) {
        const source = view.source(record.source);
        const blob = adapterOf(source)?.mail({ source: source!, version }, () => null)?.blob ?? null;
        if (blob === null || !files.has(blob)) return null;
        const read = readMail(files.prefix(blob, BLOB_BYTES));
        const addresses = [...(read.from === null ? [] : [read.from]), ...read.to, ...read.cc].map((party) => party.address);
        return recordText({ title: read.subject, text: read.reply, who: addresses });
      },
    },

    read: {
      of(record, version, files, view) {
        const source = view.source(record.source);
        const blob = adapterOf(source)?.mail({ source: source!, version }, () => null)?.blob ?? null;
        if (blob === null || !files.has(blob)) return null;
        const read = readMail(files.bytes(blob));
        return recordRead({ title: read.subject, text: read.text, ...(read.from === null ? {} : { from: read.from.address }), to: [...read.to, ...read.cc].map((party) => party.address) });
      },
    },

    day(input): DayProjection {
      const lines: DayLine[] = [];
      const facts: DayFact[] = [];
      for (const extract of input.extracts) {
        const { source } = content(extract);
        const row = input.sources.get(source);
        const owner = (adapterOf(row)?.owner === "account" ? row!.account : "").toLowerCase();
        for (const entry of entries(extract)) {
          const item = entry.pack === null ? undefined : itemOf(source, entry.key);
          const enrichment = item === undefined ? undefined : input.enrichments.get(item);
          const tag = enrichment?.state === "done" ? enrichment.content as MailTag : undefined;
          const record = { source, kind: MAIL_KIND, key: entry.key };
          const line = lines.push({
            family: "mail",
            unit: extract.unit, units: [extract.unit],
            start_ms: entry.at_ms,
            end_ms: null,
            ...mailText(entry, tag, enrichment?.state, input.labels),
            record, ...(item === undefined ? {} : { item }),
          }) - 1;
          if (!entry.draft) facts.push(mailFact(extract.unit, entry, owner, input.labels, record, line));
        }
      }
      return { lines, facts };
    },
    collections: MAIL_COLLECTIONS,
  };
}

export const MAIL_COLLECTIONS: Readonly<Record<string, Collection>> = {
  mails: { keys: ["direction", "title"], measures: {} },
};

function mailFact(unit: string, entry: MailEntry, owner: string, labels: Labels, record: RecordRef, line: number): DayFact {
  const own = (address: string) => address.toLowerCase() === owner || labels.person(address)?.me === true;
  const who = new Map<string, DayFact["who"][number]>();
  const add = (address: string, role: "sender" | "receiver") => {
    if (own(address)) return;
    const handle = handleOf(address);
    const id = handle === null ? address : handleId(handle);
    who.set(`${id}\0${role}`, { handle: id, role });
  };
  if (entry.from !== null) add(entry.from.address, "sender");
  for (const to of entry.to) add(to.address, "receiver");
  const read = entry.unreadable === null;
  return {
    of: "mails", id: factId("mails", itemOf(record.source, record.key)), time_ms: entry.at_ms, start_ms: entry.at_ms, end_ms: entry.at_ms,
    keys: read ? { direction: entry.from !== null && own(entry.from.address) ? "sent" : "received", title: entry.subject } : {},
    measures: {},
    who: [...who.keys()].sort().map((key) => who.get(key)!),
    from: { units: [unit], record, alone: true }, lines: [line],
  };
}

function mailText(entry: MailEntry, tag: MailTag | undefined, state: string | undefined, labels: Labels): Printed {
  if (entry.unreadable !== null) return printed`Mail that could not be read (${entry.unreadable})`;
  const name = (party: { address: string; name: string | null }): Printable => nameParty({ id: party.address, kind: "email", provider: party.name }, labels);
  const from = entry.from === null ? "an unnamed sender" : name(entry.from);
  const subject = entry.subject === "" ? "(no subject)" : `“${entry.subject}”`;
  if (entry.route === "junk") return printed`Mail in ${String(entry.junk)} from ${from}: ${subject}`;
  const mail = entry.draft ? "Mail in Drafts" : "Mail";
  const extras = [
    ...(entry.attachments.length === 0 ? [] : [`[attached: ${entry.attachments.join(", ")}]`]),
    ...(entry.invitation === null ? [] : [`[invitation: ${entry.invitation}]`]),
  ].join(" ");
  const tail = extras === "" ? "" : ` ${extras}`;
  if (entry.route === "bulk" || tag?.from === "machine") {
    if (tag === undefined) return printed`${mail} from ${from}: ${subject} (${state === undefined ? "tag pending" : "no tag"})${tail}`;
    const facts = [tag.provider, tag.amount, tag.reference === null ? null : `ref ${tag.reference}`].filter((fact) => fact !== null);
    return printed`${mail} from ${from}: ${subject} — ${tag.kind}, ${tag.topic}: ${tag.gist}${facts.length === 0 ? "" : ` (${facts.join("; ")})`}${tail}`;
  }
  const to: Printable = entry.to.length === 0 ? "" : printed` to ${joined(entry.to.map(name), ", ")}`;
  const body = entry.body === null || entry.body === "" ? "" : ` — ${entry.body}`;
  return printed`${mail} from ${from}${to}: ${subject}${body}${tail}`;
}

function replaced({ entry, thread }: { entry: MailEntry; thread: string | null }, later: readonly { entry: MailEntry; thread: string | null }[]): boolean {
  if (!entry.draft || thread === null || entry.from === null) return false;
  const sender = entry.from.address;
  return later.some((mail) => mail.thread === thread && mail.entry.from?.address === sender);
}

function readEntry(head: Head, at_ms: number, item: (header: (name: string) => string | null) => MailItem | null, files: BlobReader): { entry: MailEntry; thread: string | null } | null {
  const entry: MailEntry = {
    key: head.key, at_ms, route: "read", junk: null, draft: false, from: null, to: [], subject: "", attachments: [], invitation: null,
    body: null, unreadable: null, pack: null,
  };
  const stated = item(() => null);
  if (stated === null) return null;
  const pulled = stated.thread ?? null;
  const blob = stated.blob;
  if (blob === null) return { entry: { ...entry, unreadable: "no single original message/rfc822 blob" }, thread: pulled };
  if (!files.has(blob)) return { entry: { ...entry, unreadable: "its bytes are not in the blob store" }, thread: pulled };
  try {
    const bytes = files.bytes(blob);
    const read = readMail(bytes);
    const mailbox = item((name) => read.header(name)) ?? stated;
    const routed = route(mailbox, {
      unsubscribe: read.header("list-unsubscribe"), list_id: read.header("list-id"), precedence: read.header("precedence"),
    });
    const pack = routed.route === "junk" || routed.draft ? null : tagPack(bytes, at_ms, mailbox.exported === true);
    const thread = mailbox.thread ?? null;
    return { thread, entry: {
      ...entry,
      ...routed,
      from: read.from === null ? null : party(read.from),
      to: [...read.to, ...read.cc].map(party),
      subject: read.subject,
      attachments: read.attachments.map((attachment) => attachment.name ?? attachment.media_type),
      invitation: read.invitation?.summary ?? null,
      body: routed.route === "read" ? capped(read.reply) : null,
      pack,
    } };
  } catch (error) {
    return { entry: { ...entry, unreadable: error instanceof Error ? error.message : String(error) }, thread: pulled };
  }
}

function route(
  mailbox: MailItem,
  markers: { unsubscribe: string | null; list_id: string | null; precedence: string | null },
): { route: MailEntry["route"]; junk: string | null; draft: boolean } {
  const draft = mailbox.draft === true;
  if (mailbox.junk !== undefined && mailbox.junk !== null) return { route: "junk", junk: mailbox.junk, draft };
  const precedence = markers.precedence?.trim().toLowerCase();
  if (markers.unsubscribe !== null || markers.list_id !== null || precedence === "bulk" || precedence === "list") return { route: "bulk", junk: null, draft };
  return { route: "read", junk: null, draft };
}

function party(address: MailAddress): { address: string; name: string | null } {
  return { address: address.address, name: address.name };
}

function capped(text: string): string {
  if (text.length <= MAIL_BODY_CAP) return text;
  const head = textHead(text, MAIL_BODY_CAP);
  return `${head} […${text.length - head.length} more characters]`;
}

function itemOf(source: string, key: string): string {
  return `${source}/${key}`;
}

function utcDay(version: Version | undefined): string | null {
  const at = version?.time?.start_ms;
  return at === undefined ? null : render(at, "UTC", "day");
}

function content(extract: ExtractRow): MailDayContent {
  return extract.content as unknown as MailDayContent;
}

function entries(extract: ExtractRow): MailEntry[] {
  return content(extract).mails;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
