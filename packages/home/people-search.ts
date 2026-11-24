import { civilDay, dayBounds, type DaySettings } from "@lifestreamprotocol/core";
import { findPeople, type PersonDetail, type Searched } from "@lifestreamprotocol/families";
import { outsideAccess, tooBroad, type Call } from "./call.js";
import { reached, type Admission, type CountAsk, type CountContext, type PeopleMap, type Subject } from "./counting.js";
import { CursorError, CursorWriter, GIVEN_MOST, opened, sealed, type Opened } from "./cursor-text.js";
import { keptPerson, peopleMatchOf, PEOPLE_SEARCH_MATCHES, peopleSearchOf, type Elsewhere, type Page, type PeopleSearchAnswer, type PeopleSearchChat } from "./people.js";
import type { PreparedRead } from "./prepared.js";
import { makeRef, readRef } from "./refs.js";
import { refused } from "./refusal.js";
import type { PeopleMatch, SearchPeopleAnswer, SearchPeopleParams } from "./search-contract.js";
import type { RecordRead } from "./search-index.js";
import { admit, collectionsOf, resolve } from "./count.js";


export type PeopleShow<T> = (found: { answer: PeopleSearchAnswer; file: PreparedRead; read: RecordRead; map: PeopleMap; day: DaySettings; refOf: (id: string) => string }) => T;
export interface PeopleOptions {
  nameless?: true;
  resolved?: (read: RecordRead, digest: string) => void;
}
type PeopleSearchAsked = Parameters<typeof peopleSearchOf>[0];

export type SealedPeople = { readonly people: readonly string[] } | { readonly except: readonly string[] };

export function sealedPeople(read: PreparedRead, sealed: SealedPeople): PreparedRead {
  const owner = read.value<{ id: string }>("alias", "me")?.id;
  const out = "people" in sealed ? (id: string) => sealed.people.includes(id) : (id: string) => id !== owner && !sealed.except.includes(id);
  const held = (id: string | undefined) => id !== undefined && !out(id);
  const value = <T>(table: string, key: string): T | undefined => {
    const found = read.value<T>(table, key);
    if (found === undefined) return undefined;
    if (table === "person") return held(key) ? found : undefined;
    if (table === "alias") return held((found as { id: string }).id) ? found : undefined;
    if (table === "names") {
      const names = found as { people: Searched[] };
      return { ...names, people: names.people.filter((each) => held(each.id)) } as T;
    }
    if (table === "answer" && key === "list") {
      const list = found as { chats?: PeopleSearchChat[] };
      const theirs = (chat: PeopleSearchChat) => {
        const id = chat.group ? undefined : keptPerson(read, chat.key);
        return id === undefined || held(id);
      };
      return list.chats === undefined ? found : { ...list, chats: list.chats.filter(theirs) } as T;
    }
    return found;
  };
  return { ...read, value };
}

export function peopleMapOf(read: PreparedRead): PeopleMap {
  return {
    version: read.meta("changed") ?? read.position,
    idOf: (id) => keptPerson(read, id),
    person: (id) => {
      const person = read.value<{ person: PersonDetail }>("person", id)?.person;
      return person === undefined ? undefined : { name: person.name, handles: person.handles.map((handle) => handle.id) };
    },
    find: (name) => findPeople(read.value<{ people: Searched[] }>("names", "all")?.people ?? [], name),
  };
}

export function peopleFound<T>(call: Call, asked: PeopleSearchAsked, options: PeopleOptions, show: PeopleShow<T>): T | undefined {
  const read = call.index();
  const map = call.people();
  const file = call.peopleFileIfReady()!;
  const families = call.families;
  const collections = collectionsOf(families);
  const familyOf = (of: string) => families.find((family) => family.collections?.[of] !== undefined)?.name ?? of;
  const day = read.clock;
  const presence = call.presence();
  const placed = call.whereIfReady() !== undefined;
  const gate = call.gate === undefined ? undefined : call;
  const chats = file.value<{ chats: PeopleSearchChat[] }>("answer", "list")?.chats ?? [];
  if (read.building() !== null) refused("INDEX_BUILDING", "the counts are being made again", { building: ["facts"] });
  return read.facts((facts) => {
    const counts = call.peopleCounts(facts);
    const context: CountContext = { collections, settings: day, now_ms: call.now_ms, people: () => map, ...(presence === undefined ? {} : { presence }), ...(gate === undefined ? {} : { gate }) };
    const today = civilDay(call.now_ms, day);
    const keyed = (of: string, key: string) => collections.get(of)?.keys.includes(key) === true;
    const subject = (of: { person: string } | { chat: string }): Subject => ("chat" in of ? of : { person: of.person, handles: map.person(of.person)?.handles ?? [] });
    const involved = gate === undefined ? undefined
      : (id: string) => (file.value("person", id) === undefined ? call.chatInvolved(id) : call.shown(id)?.involved) === true;
    if (gate !== undefined && "id" in asked && chats.some((chat) => chat.key === asked.id) && call.named(asked.id) === undefined) {
      const touched = call.chatInvolved(asked.id);
      if (touched === undefined) tooBroad();
      if (!touched) outsideAccess();
    }
    const elsewhereOf = (name: string, words: boolean): Elsewhere[] => {
      const found: Elsewhere[] = [];
      const take = (as: Elsewhere["as"], of: string, filters: Partial<CountAsk>) => {
        const sizedAsk: CountAsk = { of, op: "count", by: [], person: [], match: {}, limit: 1, ...filters };
        const sized = counts.size(sizedAsk, (metered) => admit(resolve(metered, sizedAsk, context), call.row) as Admission);
        if (sized === "capped") found.push({ as, family: familyOf(of), capped: true });
        else if (sized !== null) found.push({ as, family: familyOf(of), ...sized });
      };
      if (placed && collections.has("stays")) take("place", "stays", { place: name });
      if (keyed("payments", "payee")) take("payee", "payments", { match: { payee: name } });
      if (keyed("screen_time", "app")) take("app", "screen_time", { match: { app: name } });
      if (words) {
        const looked = reached(read, { words: [{ phrases: [name.replaceAll('"', " ")], negated: false }], to_ms: dayBounds(today, day).end_ms }, families.map((family) => family.name), [], gate);
        if (looked === "unread") found.push({ as: "words", capped: true });
        else for (const each of looked) found.push({ as: "words", family: each.family, n: each.n, ...(each.capped ? { capped: true as const } : {}), ...(each.first === undefined ? {} : { first: each.first, last: each.last! }) });
      }
      return found;
    };
    const answer = peopleSearchOf(asked, {
      searched: file.value<{ people: Searched[] }>("names", "all")?.people ?? [],
      person: (id) => file.value<{ person: PersonDetail }>("person", id)?.person,
      idOf: (id) => (gate === undefined ? keptPerson(file, id) : call.named(id)),
      chats,
      counted: (count) => count({ touch: (of) => counts.touch(of.map(subject)), reach: (of) => counts.reach(subject(of)) }),
      elsewhere: elsewhereOf,
      ...(options.nameless === undefined ? {} : { nameless: true as const }),
      ...(involved === undefined ? {} : {
        served: { involved, handles: (id: string) => call.shown(id)?.handles ?? [], names: (id: string) => call.names(id), searched: (id: string, handles: boolean) => call.searched(id, handles) },
      }),
    }, options.resolved === undefined ? undefined : (digest) => options.resolved!(read, digest));
    if (answer !== undefined) counts.tellPassed();
    const refOf = (id: string) => call.personRef(id);
    return answer === undefined ? undefined : show({ answer, file, read, map, day, refOf });
  });
}

export function peopleSearchAnswer(call: Call, params: SearchPeopleParams, pieces = false): SearchPeopleAnswer {
  const held = params.cursor === undefined ? undefined : opened(params.cursor, ["people"], params);
  const page = held === undefined ? undefined : peoplePage(held);
  const given = held === undefined ? params : held.params;
  const { name, id } = given.name?.startsWith("person.") === true ? { id: given.name } : given;
  if (name !== undefined && name.trim() === "") refused("BAD_PARAMETER", "`name` names no word to find.");
  if (name !== undefined && name.length > 200) refused("BAD_PARAMETER", "`name` is at most 200 characters.");
  const target = id === undefined ? undefined : readRef(id, "id", ["person", "chat"]);
  const paged = page === undefined ? {} : { page };
  const asked: PeopleSearchAsked = target !== undefined ? { id: target.kind === "person" ? target.parts.handle : target.parts.key, ...paged } : { name: name!, ...paged };
  const chatRef = (key: string) => makeRef("chat", { key });
  const found = peopleFound(call, asked, {
    nameless: true,
    ...(held === undefined ? {} : { resolved: (read: RecordRead, digest: string) => held.check({ index: () => read.file, facts: () => read.factsBuild, resolved: () => digest }) }),
  }, ({ answer, read, day, refOf }): SearchPeopleAnswer => {
    const matches = answer.matches.map((match) => {
      const shown = peopleMatchOf(match, refOf);
      if (!pieces || match.kind === "group") return shown;
      const who = (text: string) => ({ text, who: match.id });
      return { ...shown, name: who(shown.name), ...(shown.also === undefined ? {} : { also: shown.also.map(who) }) } as unknown as PeopleMatch;
    });
    const next = answer.next === undefined ? undefined
      : sealed("people", peoplePlace(answer.next), name === undefined ? { id: id! } : { name }, { index: read.file, facts: read.factsBuild, resolved: answer.resolved });
    const today = civilDay(call.now_ms, day);
    const as_of = call.fresh(read.seq, read.held(today, today))?.as_of;
    const kept = call.keptOut();
    if (kept !== undefined) call.log.withheld = kept;
    return {
      ...(kept !== undefined && held === undefined ? { outside: true as const } : {}),
      ...(answer.note === undefined ? {} : { note: answer.note }), matches,
      ...(answer.elsewhere === undefined ? {} : { elsewhere: answer.elsewhere.map(({ chat, ...each }) => (chat === undefined ? each : { ...each, ref: chatRef(chat) })) }),
      ...(answer.capped === true ? { capped: true } : {}), ...(as_of == null ? {} : { as_of }), ...(next === undefined ? {} : { next }),
    };
  });
  return found ?? refused("BAD_PARAMETER", "`id` names no person or chat held now. Find them by `name`.");
}

export function peopleOne(call: Call, id: string, chat = false): PeopleMatch | undefined {
  if (chat && call.peopleIfReady() === undefined) return undefined;
  return peopleFound(call, { id }, {}, ({ answer, refOf }) => (answer.matches[0] === undefined ? undefined : peopleMatchOf(answer.matches[0], refOf)));
}

export function peoplePlace(page: Page): number[] {
  const out = new CursorWriter().put((page.place === undefined ? 0 : 1) | (page.chats === undefined ? 0 : 2));
  if (page.place !== undefined) out.put(page.place + 1);
  out.set(page.given);
  if (page.chats !== undefined) out.put(page.chats);
  return out.written;
}

function peoplePage(held: Opened<"people">): Page {
  try {
    const read = held.place;
    const flags = read.small(3);
    const place = (flags & 1) === 0 ? undefined : read.small() - 1;
    const positions = read.set(GIVEN_MOST + PEOPLE_SEARCH_MATCHES).map((each) => {
      if (each < 0n || each > BigInt(Number.MAX_SAFE_INTEGER)) throw read.broken();
      return Number(each);
    });
    const chats = (flags & 2) === 0 ? undefined : read.small();
    read.end();
    return { given: positions, ...(place === undefined ? {} : { place }), ...(chats === undefined ? {} : { chats }) };
  } catch (error) {
    if (error instanceof CursorError) return refused("BAD_PARAMETER", "`cursor` is not a next this route gave.");
    throw error;
  }
}
