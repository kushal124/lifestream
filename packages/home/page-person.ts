import { addDays, civilDay, digest, PROFILE_NETWORKS, profileFault, sha256, type DaySettings, type Entity, type Json, type OpenView } from "@lifestreamprotocol/core";
import {
  atomFocus, findPeople, foldedIn, groupTalk, isDirect, lastTalk, listEntry, profileOf, saidIn, saidOf, talkDays, type Conversation, type DayDocument, type JoinedPerson, type Profile, type Spoken,
  type TalkChat, type TalkRun,
} from "@lifestreamprotocol/families";
import { countingIn, faceOnly, isNamed, namesHeld, photoOf, rowOf, searchedIn, type PeopleReads } from "./page-people.js";
import type { AnswerOf, Body, PageHandler, Row, Talk } from "./pages.js";
import type { PeopleJoin } from "./people.js";
import type { PreparedRead } from "./prepared.js";
import { notNow, refuse } from "./refusal.js";
import { amount } from "./stream-words.js";

export interface PersonReads extends PeopleReads {
  dayHead(day: string): string | null;
  dayFile(day: string): Pick<DayDocument, "atoms" | "facts"> | null;
  heard(view: OpenView, chat: string, day: string): Conversation | null;
  calls(machine: string, now_ms: number, handle: string, from: string, to: string): number | null;
  product(id: string): string;
  mails(machine: string, now_ms: number, person: string, to: string): Mail[] | null;
}

type Person = AnswerOf<"person">;
type Group = AnswerOf<"group">;
type Find = AnswerOf<"peopleFind">;
type Listed = ReturnType<PeopleJoin["list"]>;
type Chat = Listed["chats"][number];
type TalkLine = Talk["lines"][number];
type History = Body<Person>["history"];
type Where = Body<Person>["where"][number];
type Handle = JoinedPerson["handles"][number];
type Edit = Body<Person>["edit"];
type Suggestion = Edit["suggestions"][number];
export type Mail = NonNullable<Edit["mails"]["newest"]>[number];

const MONTH_DAYS = 30;
const WEEKS_MOST = 104;
const WEEKS_LEAST = 26;
const WEEKS_BUSY = 12;
const WEEKS_BUSY_LEAST = 3;
const HANDFUL = 20;
const DAY_MS = 86_400_000;
const FIND_MOST = 6;
const MAIL = "Mail";
const MAILS_SHOWN = 6;
const MAILS_AHEAD_DAYS = 365;
const PREPARING_S = 2;
const YOU = "You";
const YOU_SET_IT = "You set it";
const ME = "me";
const MESSAGE: readonly [string, string] = ["message", "messages"];
const MAILS: readonly [string, string] = ["mail", "mails"];
const CALL: readonly [string, string] = ["call", "calls"];
const PERSON: readonly [string, string] = ["person", "people"];
const SUGGESTION: readonly [string, string] = ["suggestion", "suggestions"];
const BEFORE_THAT = " · before that, ";
const LAST = " · last, ";
const ANOTHER_RECORD = "Another record";
const NAMED_BY_NETWORK: ReadonlySet<string> = new Set(["provider", "push-name"]);

const keptTag = (file: PreparedRead): string => file.etag("answer", "list") ?? notNow("busy", "Your people are being prepared.", PREPARING_S);
const listTag = (joined: PeopleJoin, file: PreparedRead, list: Listed): string => (joined.same ? keptTag(file) : sha256(JSON.stringify(list)));
const settingsTag = (day: DaySettings): string => digest({ zone: day.zone, day_start_hour: day.day_start_hour });

export function personPage(reads: PersonReads): PageHandler<Person> {
  return {
    params: ["id"],
    open: (ask, use) => reads.joined(ask.machine, (joined, file, view) => {
      const asked = ask.query.get("id") ?? refuse(422, "BAD_PARAMETER", "id names the person");
      const found = joined.person(asked);
      const person = joined.detail(asked) ?? refuse(404, "PERSON_UNKNOWN", `no person ${asked}`);
      const list = joined.list();
      const day = reads.day();
      const chats = talkChats(list);
      const days = person.me ? [] : talkDays(person, chats, day);
      const handle = person.handles[0]?.id;
      const calls = person.me || handle === undefined ? null : reads.calls(ask.machine, ask.now_ms, handle, addDays(ask.today, 1 - MONTH_DAYS), ask.today);
      const row = found !== undefined && "row" in found ? file.etag("person", found.row) : undefined;
      const mails = person.mails_from + person.mails_to === 0 ? [] : reads.mails(ask.machine, ask.now_ms, person.id, addDays(ask.today, MAILS_AHEAD_DAYS));
      return use({
        position: view.position(),
        counting: person.counting === true,
        inputs: [
          digest({ asked }), row ?? sha256(JSON.stringify(person)), listTag(joined, file, list), settingsTag(day),
          digest({ days: days.map((each) => [each, reads.dayHead(each)]), calls, mails }),
        ],
        build: () => personBody(reads, view, joined, list, person, asked, days, calls, mails, ask.today, day),
      });
    }),
  };
}

function personBody(
  reads: PersonReads, view: OpenView, joined: PeopleJoin, list: Listed, person: JoinedPerson, asked: string, days: readonly string[], calls: number | null, mails: Mail[] | null,
  today: string, settings: DaySettings,
): Body<Person> {
  const theirs = new Set(person.chats.map((each) => each.key));
  const talked = talkChats(list);
  const talk = firstTalk(reads, days, (file) => lastTalk(person, talked, [file]), (run) => isDirect(run, talked), theirs, view);
  const counts = person.days;
  const from = addDays(today, 1 - MONTH_DAYS);
  const thirty = Array.from({ length: MONTH_DAYS }, (_, at) => addDays(from, at)).map((each) => ({ day: each, count: counts[each] ?? 0 }));
  const month = Object.entries(counts).reduce((sum, [each, n]) => (each >= from && each <= today ? sum + n : sum), 0);
  const before = Object.keys(counts).filter((each) => counts[each]! > 0 && each < from).sort().at(-1) ?? null;
  const details = person.details;
  const full = person.full_name ?? "";
  return {
    became: person.id === asked ? null : person.id,
    me: person.me,
    head: {
      name: person.name,
      named: isNamed(person),
      full_name: full !== "" && full !== person.name ? full : null,
      photo: photoOf(person),
      chips: [
        ...(details?.birthday == null ? [] : [{ kind: "birthday" as const, month: details.birthday.month, day: details.birthday.day }]),
        ...(details?.profiles ?? []).map((profile) => ({ kind: "profile" as const, network: profile.network, words: profileWords(profile), href: profileHref(profile) })),
      ],
      since: person.first_ms === null ? null : { kind: "at", at_ms: person.first_ms },
      relationship: person.relationship,
      work: details?.work ?? person.work ?? null,
      entity: person.entity as Entity,
      entity_by: person.entity === "person" ? null : person.entity_by,
    },
    handles: (person.me ? yourHandles(person.handles) : person.handles).map((handle) => ({
      id: handle.id, kind: handle.kind as Body<Person>["handles"][number]["kind"], network: handle.network, words: handle.words, from: handle.from, own: handle.own,
    })),
    month: {
      days: thirty,
      count: month,
      calls: calls === null || calls === 0 ? null : { count: calls, words: amount(calls, CALL) },
      line: month === 0 ? "None in the last 30 days" : `${amount(month, MESSAGE)} in the last 30 days`,
      before: before === null ? null : { day: before, joiner: month === 0 ? LAST : BEFORE_THAT },
    },
    history: historyOf(counts, today, person.first_ms === null ? null : civilDay(person.first_ms, settings)),
    talk: talk === null ? null : talkOf(reads, joined, list, talk),
    where: whereOf(reads, person, list),
    suggestions_line: person.suggestions.length === 0 ? null : amount(person.suggestions.length, SUGGESTION),
    edit: {
      call: isNamed(person) ? filled(person.show === "full_name" ? person.name : person.call_name ?? person.name) : null,
      full_name: filled(person.full_name ?? ""),
      name_from: NAMED_BY_NETWORK.has(person.by) && person.networks[0] !== undefined ? filled(reads.product(person.networks[0])) : null,
      record_id: person.person,
      face: faceOnly(person),
      reach: filled(reachOf(reads, person)),
      last: person.last_ms === null ? null : { kind: "at", at_ms: person.last_ms },
      much: [amount(person.received + person.sent, MESSAGE), person.mails_from + person.mails_to > 0 ? amount(person.mails_from + person.mails_to, MAILS) : ""]
        .filter((each) => each !== "").join(" · "),
      mails: { from: person.mails_from, to: person.mails_to, newest: mails },
      record: person.record === null ? null : {
        type: person.record.type, slug: person.record.slug, name: person.record.name, full_name: person.record.full_name, show: person.record.show,
        entity: person.record.entity, relationship: person.record.relationship, hidden: person.record.hidden, me: person.record.me,
        anchor: person.record.anchor === null ? null : { kind: person.record.anchor.kind, value: person.record.anchor.value },
        handles: person.record.handles.map(({ kind, value }) => ({ kind, value })), excluded: person.record.excluded.map(({ kind, value }) => ({ kind, value })),
        dismissed: [...person.record.dismissed], also_called: [...person.record.also_called], merged_into: person.record.merged_into,
      },
      details: details === undefined ? null : {
        work: details.work, birthday: details.birthday, profiles: details.profiles.map(({ network, value }) => ({ network, value })), cleared: [...(details.cleared ?? [])],
      },
      suggestions: person.suggestions.map((each) => ({
        id: each.id, kind: each.kind, value: each.value, ticked: each.ticked,
        reasons: Object.entries(each.reasons).sort(([left], [right]) => compare(left, right)).map(([reason, count]) => ({ reason, count })),
        other: each.kind === "same" ? sameSide(joined, each.value, each.reasons) : null,
      })),
      also_called: person.also_called.map(({ name, from }) => ({ name, from })),
      names_seen: [...person.names_seen],
      joined: person.joined.map((each) => ({ id: each.id, name: each.name, photo: photoOf(each), handles: [...each.handles], with: [...each.with] })),
    },
  };
}

function sameSide(joined: PeopleJoin, value: string, reasons: Readonly<Record<string, number>>): Suggestion["other"] {
  const id = otherId(value);
  const other = joined.detail(id);
  if (other !== undefined) return { id: other.id, name: other.name, photo: photoOf(other), named: isNamed(other), face: faceOnly(other) };
  const colon = value.indexOf(":");
  return { id, name: colon < 0 ? ANOTHER_RECORD : value.slice(colon + 1), photo: null, named: false, face: colon < 0 && (reasons.seen ?? 0) > 0 };
}

export function profilesOf(words: string): Profile[] {
  const text = words.trim();
  if (/^@[A-Za-z0-9._]+$/u.test(text)) {
    const handle = text.slice(1).toLowerCase();
    return ([{ network: "instagram", value: handle }, { network: "x", value: handle }] as Profile[]).filter((profile) => profileFault(profile as unknown as Json) === undefined);
  }
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/)?[^/?#]*@/iu.test(text)) return [];
  const profile = profileOf(text);
  return profile === null ? [] : [profile];
}

export function groupPage(reads: PersonReads): PageHandler<Group> {
  return {
    params: ["chat"],
    open: (ask, use) => reads.joined(ask.machine, (joined, file, view) => {
      const key = ask.query.get("chat") ?? refuse(422, "BAD_PARAMETER", "chat names the group");
      const list = joined.list();
      const chat = list.chats.find((each) => each.key === key && each.group) ?? refuse(404, "CHAT_UNKNOWN", `no group ${key}`);
      const day = reads.day();
      const days = [civilDay(chat.last_ms, day)];
      return use({
        position: view.position(),
        counting: countingIn(list),
        inputs: [digest({ key }), listTag(joined, file, list), settingsTag(day), digest({ days: days.map((each) => [each, reads.dayHead(each)]) })],
        build: () => groupBody(reads, view, joined, list, chat, days),
      });
    }),
  };
}

function groupBody(reads: PersonReads, view: OpenView, joined: PeopleJoin, list: Listed, chat: Chat, days: readonly string[]): Body<Group> {
  const writers = list.people.flatMap((person) => {
    const count = person.me ? 0 : person.chats.filter((each) => each.key === chat.key).reduce((sum, each) => sum + each.count, 0);
    return count > 0 ? [{ person, count }] : [];
  }).sort((left, right) => right.count - left.count || compare(left.person.id, right.person.id));
  const talk = firstTalk(reads, days, (file) => groupTalk(chat.key, [file]), () => true, new Set([chat.key]), view);
  return {
    head: {
      title: titleOf(chat, chat.key), photo: null,
      line: `${reads.product(chat.network)} group · ${amount(writers.length, PERSON)}`,
      since: { kind: "at", at_ms: chat.first_ms },
      word: chat.word === true ? "always" : chat.word === false ? "never" : "rule",
      quiet: Boolean(chat.quiet),
      why: quietWhy(reads, chat),
    },
    total: chat.total,
    writers: writers.map(({ person, count }) => ({ id: person.id, name: person.name, named: isNamed(person), photo: photoOf(person), share: amount(count, MESSAGE) })),
    yours: chat.total === 0 ? null : `${Math.round((chat.mine / chat.total) * 100)}%`,
    talk: talk === null ? null : talkOf(reads, joined, list, talk),
  };
}

function quietWhy(reads: Pick<PersonReads, "product">, chat: Chat): Body<Group>["head"]["why"] {
  if (!chat.quiet) return chat.word === false ? { words: YOU_SET_IT, since: null } : null;
  if (chat.quiet.why === "owner") return { words: YOU_SET_IT, since: null };
  if (chat.quiet.why === "archived") return { words: `You archived it in ${reads.product(chat.network)}`, since: null };
  return chat.quiet.last_day === null ? { words: "You never wrote in it", since: null } : { words: "You last wrote", since: { kind: "day", day: chat.quiet.last_day } };
}

export function findPage(reads: Pick<PersonReads, "joined">): PageHandler<Find> {
  return {
    params: ["q", "for"],
    open: (ask, use) => reads.joined(ask.machine, (joined, file, view) => {
      const q = ask.query.get("q") ?? refuse(422, "BAD_PARAMETER", "q names the words to find");
      if (q.trim() === "") refuse(422, "BAD_PARAMETER", "q names no word to find");
      const owner = ask.query.get("for");
      const asking = owner === null ? undefined : joined.detail(owner) ?? refuse(404, "PERSON_UNKNOWN", `no person ${owner}`);
      const left = new Set<string>(asking === undefined ? [] : [asking.id, ...asking.handles.map((each) => each.id), ...asking.suggestions.map((each) => otherId(each.value))]);
      const held = asking === undefined ? [] : [...(asking.details?.profiles ?? []), ...asking.suggestions.flatMap((each) => (each.kind === "profile" ? suggestedProfile(each.value) : []))];
      const profiles = profilesOf(q).map(({ network, value }) => ({ network, value })).filter((found) => !held.some((each) => each.network === found.network && each.value === found.value));
      const searched = searchedIn(file);
      const names = namesHeld(searched);
      const rows: Row[] = [];
      for (const each of findPeople(searched, q)) {
        if (rows.length >= FIND_MOST - profiles.length) break;
        const shown = joined.detail(each);
        if (shown === undefined || shown.id.startsWith("contact:") || shown.me || left.has(shown.id) || rows.some((row) => row.id === shown.id)) continue;
        if (asking?.person != null && shown.person === asking.person) continue;
        rows.push(rowOf(listEntry(shown), [...(names.get(shown.id) ?? []), ...(names.get(each) ?? [])]));
      }
      return use({ position: view.position(), inputs: [digest({ q, owner, rows, profiles })], counting: false, build: () => ({ rows, profiles }) });
    }),
  };
}

function firstTalk(
  reads: PersonReads, days: readonly string[], talkIn: (file: { day: string; said: readonly Spoken[] }) => TalkRun | null, settles: (run: TalkRun) => boolean, chats: ReadonlySet<string>, view: OpenView,
): TalkRun | null {
  for (const day of days) {
    const file = reads.dayFile(day);
    if (file === null) continue;
    const said = saidIn(file);
    const plain = talkIn({ day, said });
    if (plain !== null && settles(plain)) return plain;
    const folded = foldedIn(file, chats);
    if (folded.length === 0) {
      if (plain !== null) return plain;
      continue;
    }
    const heard = folded.flatMap(({ chat, n }) => {
      const conversation = reads.heard(view, chat, day);
      return conversation === null ? [] : saidOf(chat, conversation, n);
    });
    const talk = talkIn({ day, said: [...said, ...heard] });
    if (talk !== null) return talk;
  }
  return null;
}

function talkOf(reads: Pick<PersonReads, "product">, joined: PeopleJoin, list: Listed, run: TalkRun): Talk {
  const you = list.you?.id ?? ME;
  const stands = new Map<string, string>();
  const whoOf = (line: Spoken): string => {
    if (line.mine) return you;
    const handle = line.from[0];
    if (handle === undefined) return run.chat;
    if (!stands.has(handle)) stands.set(handle, joined.stands(handle) ?? handle);
    return stands.get(handle)!;
  };
  const lineOf = (line: Spoken): TalkLine => ({
    who: whoOf(line), name: line.mine ? YOU : line.name, text: line.text, forwarded: line.forwarded, at_ms: line.at_ms, mine: line.mine, n: line.n,
  });
  const runs = run.runs;
  const chat = list.chats.find((each) => each.key === run.chat);
  return {
    day: run.day,
    chat: run.chat,
    title: titleOf(chat, run.chat),
    group: chat?.group ?? false,
    network: reads.product(chat?.network ?? run.chat.slice(0, run.chat.indexOf(":"))),
    lines: (runs.at(-1) ?? []).map(lineOf),
    folded: runs.slice(0, -1).map((each) => ({ line: amount(each.length, MESSAGE), lines: each.map(lineOf) })),
    focus: atomFocus(runs.at(-1)?.at(-1)?.n ?? 0),
  };
}

function talkChats(list: Listed): Map<string, TalkChat> {
  return new Map(list.chats.map((chat) => [chat.key, { key: chat.key, group: chat.group, last_ms: chat.last_ms }]));
}

function titleOf(chat: Chat | undefined, key: string): string {
  return chat === undefined || chat.label === "" ? key : chat.label;
}

function whereOf(reads: Pick<PersonReads, "product">, person: JoinedPerson, list: Listed): Where[] {
  const chats = new Map(list.chats.map((chat) => [chat.key, chat]));
  const held = person.chats.flatMap(({ key, count }) => {
    const chat = chats.get(key);
    return chat === undefined ? [] : [{ chat, count }];
  });
  const mostFirst = (some: typeof held) => [...some].sort((left, right) => right.count - left.count || compare(left.chat.key, right.chat.key));
  const groups = held.filter((each) => each.chat.group);
  const quiet = (chat: Chat) => chat.group && Boolean(chat.quiet);
  const rowOf = ({ chat, count }: (typeof held)[number]): Where => ({
    chat: chat.key, title: chat.group ? titleOf(chat, chat.chat) : reads.product(chat.network), group: chat.group, network: reads.product(chat.network),
    when: { kind: "at", at_ms: chat.last_ms }, count, line: amount(count, MESSAGE), quiet: quiet(chat),
  });
  const mails = person.mails_from + person.mails_to;
  return [
    ...mostFirst(held.filter((each) => !each.chat.group)).map(rowOf),
    ...(mails > 0 ? [{ chat: null, title: MAIL, group: false, network: MAIL, when: null, count: mails, line: amount(mails, MAILS), quiet: false }] : []),
    ...mostFirst(groups.filter((each) => !quiet(each.chat))).map(rowOf),
    ...mostFirst(groups.filter((each) => quiet(each.chat))).map(rowOf),
  ];
}

function yourHandles(handles: readonly Handle[]): Handle[] {
  const kind = (handle: Handle) => (handle.kind === "phone" || handle.kind === "jid" ? 0 : handle.kind === "email" ? 1 : 2);
  return handles.map((handle, at) => ({ handle, at }))
    .sort((left, right) => Number(!left.handle.own) - Number(!right.handle.own) || kind(left.handle) - kind(right.handle) || left.at - right.at)
    .map((each) => each.handle);
}

const utc = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const mondayOf = (day: string): string => dayOf(utc(day) - ((new Date(utc(day)).getUTCDay() + 6) % 7) * DAY_MS);

function weeksOf(counts: Readonly<Record<string, number>>, end: string, count: number): { start: string; count: number; day: string | null }[] {
  const last = utc(mondayOf(end));
  const weeks = Array.from({ length: count }, (_, at) => ({ start: dayOf(last - (count - 1 - at) * 7 * DAY_MS), count: 0, day: null as string | null, most: 0 }));
  const first = utc(weeks[0]!.start);
  for (const [day, n] of Object.entries(counts).sort(([left], [right]) => compare(left, right))) {
    const at = Math.floor((utc(day) - first) / (7 * DAY_MS));
    if (at < 0 || at >= count || n <= 0) continue;
    const week = weeks[at]!;
    week.count += n;
    if (n > week.most) {
      week.most = n;
      week.day = day;
    }
  }
  return weeks.map(({ start, count: n, day }) => ({ start, count: n, day }));
}

function yearsOf(counts: Readonly<Record<string, number>>, today: string): { year: string; count: number; day: string | null }[] | null {
  const held = Object.entries(counts).filter(([, n]) => n > 0).sort(([left], [right]) => compare(left, right));
  if (held.length === 0 || held.reduce((sum, [, n]) => sum + n, 0) < HANDFUL) return null;
  const first = Number(held[0]![0].slice(0, 4));
  const last = Number(today.slice(0, 4));
  if (!(first <= last)) return null;
  const years = Array.from({ length: last - first + 1 }, (_, at) => ({ year: String(first + at), count: 0, day: null as string | null, most: 0 }));
  for (const [day, n] of held) {
    const year = years[Number(day.slice(0, 4)) - first];
    if (year === undefined) continue;
    year.count += n;
    if (n > year.most) {
      year.most = n;
      year.day = day;
    }
  }
  return years.filter((year) => year.count > 0).length >= 2 ? years.map(({ year, count, day }) => ({ year, count, day })) : null;
}

function markedOf(bars: readonly { count: number }[]): number | null {
  const most = Math.max(0, ...bars.map((each) => each.count));
  return most > 0 && bars.filter((each) => each.count === most).length === 1 ? bars.findIndex((each) => each.count === most) : null;
}

export function historyOf(counts: Readonly<Record<string, number>>, today: string, firstContact: string | null): History {
  if (weeksOf(counts, today, WEEKS_BUSY).filter((week) => week.count > 0).length >= WEEKS_BUSY_LEAST) {
    const every = weeksOf(counts, today, WEEKS_MOST);
    const began = every.findIndex((week) => week.count > 0);
    const weeks = every.slice(Math.min(began < 0 ? 0 : began, WEEKS_MOST - WEEKS_LEAST));
    return { kind: "weeks", weeks, marked: markedOf(weeks) };
  }
  const total = Object.values(counts).reduce((sum, each) => sum + each, 0);
  const years = yearsOf(counts, today);
  if (years !== null) return { kind: "years", years, total, marked: markedOf(years) };
  const first = Object.keys(counts).filter((each) => counts[each]! > 0).sort()[0] ?? null;
  return { kind: "facts", total, first: firstContact ?? first };
}

function profileWords({ network, value }: { network: string; value: string }): string {
  if (network === "site") return value.split("/")[0]!;
  return network === "instagram" || network === "x" ? `@${value}` : value;
}

function profileHref({ network, value }: { network: string; value: string }): string {
  const handle = encodeURIComponent(value);
  switch (network) {
    case "instagram": return `https://www.instagram.com/${handle}/`;
    case "x": return `https://x.com/${handle}`;
    case "linkedin": return `https://www.linkedin.com/in/${handle}/`;
    case "facebook": return `https://www.facebook.com/${handle}`;
    case "github": return `https://github.com/${handle}`;
    default: return `https://${value}`;
  }
}

function otherId(value: string): string {
  return value.includes(":") ? value : `person:${value}`;
}

function filled(words: string): string | null {
  return words === "" ? null : words;
}

function reachOf(reads: Pick<PersonReads, "product">, person: Pick<JoinedPerson, "networks" | "mails_from" | "mails_to">): string {
  const words = [...person.networks.map((network) => reads.product(network)), ...(person.mails_from + person.mails_to > 0 ? [MAIL] : [])];
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

function suggestedProfile(value: string): Find["profiles"] {
  const colon = value.indexOf(":");
  const network = value.slice(0, colon);
  return colon < 0 || !(PROFILE_NETWORKS as readonly string[]).includes(network) ? [] : [{ network, value: value.slice(colon + 1) }];
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

