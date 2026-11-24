import {
  calledName, canonical, canonicalPhone, compareHandles, ENTITIES, foldName, handleId, isFaceKey, isObject, isSqliteError, MOST_CALLED, readPersonRecord, sha256, slugOf,
  type Entity, type Guard, type Handle, type Json, type JsonObject, type OpenView, type Tx,
} from "@lifestreamprotocol/core";
import {
  calledId, cardParts, claimsOf, CONTACT_KIND, contactId, contactPersonId, detailsOf, heldHandles, isGroupChat, mergeTree, networksIn, ownCountry, ownHandles, ownProductsIn, PEOPLE_SOURCES, productNames, productWords, readPeople, sameIdOf, spelledId, statedPerson, suggestionId, youOf,
  type Details, type DetailsStatement, type MergeTree, type Networks, type PersonDetail, type RecordState, type StatedPerson, type You,
} from "@lifestreamprotocol/families";
import type { OwnerReader } from "@lifestreamprotocol/connect";
import type { Drafted as OwnerDrafted, Drafter, DraftRead, Statement, WriterHost } from "./owner-act.js";
import { peopleJoined, type PeopleJoin } from "./people.js";
import { damaged, PEOPLE, preparedDirOf, preparedFileOf, readPrepared, type PreparedRead } from "./prepared.js";
import { notNow, refuse, Refusal, RETRY_SOON_S } from "./refusal.js";

export const PEOPLE_UNDO = "people:undo";
export const PEOPLE_UNDONE = "people:undone";

export function forgetPeopleUndo(tx: Tx): void {
  tx.tables.meta.delete(PEOPLE_UNDO);
  tx.tables.meta.delete(PEOPLE_UNDONE);
}

const TEXT_LIMIT = 120;
const SUGGESTION = /^[0-9a-f]{16}$/u;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const PICTURE_BYTES = 1024 * 1024;
const KINDS = ["phone", "email", "jid"] as const;
const FIELDS = ["name", "full_name", "entity", "relationship", "hidden"] as const;
const NOT_YOURS = ["entity", "relationship", "hidden"] as const;
const DETAIL_MEMBERS = ["work", "birthday", "profiles"];
const BUSINESS_OFFER: Suggestion = { id: suggestionId("entity", "business"), kind: "entity", value: "business", reasons: {}, ticked: false };

const CODES = [
  "BAD_ACTION", "PERSON_UNKNOWN", "NOT_OFFERED", "JOINED", "HANDLE_TAKEN", "NO_FACES", "NOT_LAST", "UNDONE", "NOTHING_TO_UNDO", "NOT_THEIRS", "NO_HANDLE",
  "NO_NAME", "RECORD_ELSEWHERE", "PHOTO_GONE", "OWN_ACCOUNT", "IS_YOU", "NAMES_FULL", "NOT_JOINED",
] as const;

export const peopleDrafter: Drafter = {
  draft({ view, source, host, reader }: DraftRead, action: JsonObject): OwnerDrafted {
    const file = preparedFileOf(preparedDirOf(host.folder.root, host.machine, "people"), "people");
    const draft = (prepared: PreparedRead | null) =>
      new Action(view, source, prepared === null ? null : peopleJoined(view, prepared, host.registry.families), reader, host).draft(action);
    let read: { value: Drafted } | undefined;
    try {
      read = readPrepared(host.folder, file, PEOPLE.format, draft);
    } catch (error) {
      const prepared = (error as { database?: unknown }).database === undefined
        && (damaged(error) || (isSqliteError(error) && error.code.startsWith("SQLITE_BUSY")));
      if (prepared) notNow("busy", "Your people are being prepared.", RETRY_SOON_S);
      throw error;
    }
    const drafted = read === undefined ? draft(null) : read.value;
    const undoing = drafted.kind === "undo";
    return {
      kind: drafted.kind, statements: drafted.statements, blobs: drafted.blobs, id: drafted.id, undoable: !undoing,
      keep(tx, delivery) {
        const spent = undoing ? { ...drafted.spent, ...drafted.groups } : drafted.spent;
        if (Object.keys(spent).length > 0) tx.tables.meta.set(PEOPLE_UNDONE, JSON.stringify(spent));
        else tx.tables.meta.delete(PEOPLE_UNDONE);
        if (undoing) tx.tables.meta.set(PEOPLE_UNDO, JSON.stringify({ act: drafted.undoes!, undone: true } satisfies Undo));
        else tx.tables.meta.set(PEOPLE_UNDO, JSON.stringify({ act: delivery, statements: drafted.inverse, groups: drafted.groups } satisfies Undo));
      },
    };
  },
  follow(view, id) {
    if (!id.startsWith("person:")) return id;
    const slug = id.slice("person:".length);
    return `person:${mergeTree(readPeople(view)).rootOf.get(slug) ?? slug}`;
  },
};

type FaceContent = { is: string } | { is_not: string[] } | { ignore: true };
interface DetailsContent extends JsonObject { type: "people.details"; work: string | null; birthday: Json; profiles: Json[]; cleared?: string[] }
type Suggestion = PersonDetail["suggestions"][number];
type Served = PersonDetail | null;

interface Undo {
  act: string;
  statements?: Statement[];
  groups?: Record<string, string[]>;
  undone?: true;
}

const NO_DETAILS: DetailsContent = { type: "people.details", work: null, birthday: null, profiles: [] };

function fail(status: number, code: (typeof CODES)[number], words: string): never {
  return refuse(status, code, words);
}

function bad(words: string): never {
  return fail(400, "BAD_ACTION", words);
}

interface Drafted {
  kind: string;
  statements: Statement[];
  inverse: Statement[];
  blobs: Map<string, Buffer>;
  id: string | null;
  groups: Record<string, string[]>;
  spent: Record<string, string[]>;
  undoes?: string;
}

class Action {
  readonly #persons = new Map<string, JsonObject>();
  readonly #records = new Map<string, StatedPerson | undefined>();
  readonly #stated = new Map<string, { content: JsonObject; stated_ms: number } | null>();
  readonly #answering: Record<string, string[]> = {};
  readonly #served = new Map<string, Served>();
  readonly #drafted = new Map<string, StatedPerson>();
  readonly #faced = new Map<string, FaceContent>();
  readonly #pictured = new Map<string, { content: JsonObject; square: Buffer; person: Served }>();
  readonly #detailed = new Map<string, { changed: Partial<DetailsContent>; person: Served }>();
  readonly #bases = new Map<string, StatedPerson>();
  readonly #first = new Map<string, StatedPerson>();
  readonly #worded = new Map<string, boolean | null>();
  #states: readonly RecordState[] | undefined;
  #tree: MergeTree | undefined;
  #you: { answer: You } | undefined;
  #claims: ReadonlyMap<string, string | null> | undefined;
  #own: readonly (Handle & { product: string })[] | undefined;
  #madeYou: string | null = null;
  readonly #mergedIn = new Map<string, Served>();
  #cards: ReadonlyMap<string, readonly string[]> | undefined;

  constructor(
    private readonly view: OpenView,
    private readonly source: string,
    private readonly people: PeopleJoin | null,
    private readonly reader: OwnerReader,
    private readonly host: WriterHost,
  ) {
    for (const { head, version } of view.records(source, "person")) if (isObject(version.content)) this.#persons.set(head.key, version.content);
  }

  draft(action: JsonObject): Drafted {
    const kind = action.kind;
    if (kind === "undo") return this.#undo(action.act);
    let slug: string | null = null;
    if (kind === "confirm") {
      slug = this.#confirm(action);
    } else if (kind === "photo") {
      const picture = pictureOf(action.upload);
      if (picture === null) bad("A photo carries the picture chosen.");
      const who = this.personOf(action.id);
      slug = this.#put(this.ensure(who));
      this.#pictured.set(slug, { ...picture!, person: who.person });
    } else if (kind === "name") {
      slug = this.#name(action);
    } else if (kind === "ignore") {
      const out = new Set(Array.isArray(action.out) ? action.out : []);
      for (const face of this.#groupOf(action.cluster)) if (!out.has(face)) this.#faced.set(face, { ignore: true });
    } else if (kind === "maybe") {
      const faced = (list: unknown): list is string[] => Array.isArray(list) && list.every((face) => typeof face === "string" && isFaceKey(face));
      const yes = action.yes ?? [];
      const no = action.no ?? [];
      if (!faced(yes) || !faced(no) || yes.length + no.length === 0) bad("A Maybe answer names the faces it answers.");
      if (yes.some((face) => no.includes(face))) bad("A face is theirs or not, never both.");
      slug = this.#put(this.ensure(this.personOf(action.id)));
      for (const face of yes) this.#faced.set(face, { is: slug });
      for (const face of no) this.#faced.set(face, this.#notOf(face, slug));
    } else if (kind === "group") {
      this.#worded.set(groupKey(action.chat, networksIn(this.host.registry.families)), wordOf(action.quiet));
    } else if (kind === "businesses") {
      this.#businesses(action);
    } else if (kind === "you") {
      slug = this.#youAct(action);
    } else {
      bad("An action is confirm, you, businesses, photo, name, ignore, maybe, group or undo.");
    }
    const { made, inverse, blobs } = this.#statements();
    return { kind: kind as string, statements: made, inverse, blobs, id: slug === null ? null : `person:${slug}`, groups: this.#answering, spent: this.#spent() };
  }


  current(slug: string): JsonObject | undefined {
    return this.#persons.get(slug);
  }

  stated(kind: "face" | "photo" | "details" | "group", key: string): { content: JsonObject; stated_ms: number } | null {
    const at = `${kind}\0${key}`;
    if (this.#stated.has(at)) return this.#stated.get(at)!;
    const head = this.view.head({ source: this.source, kind, key });
    const content = head === undefined || head.version === "gone" ? undefined : this.view.version(head.version).content;
    const found = content !== undefined && isObject(content) ? { content, stated_ms: head!.stated_ms } : null;
    this.#stated.set(at, found);
    return found;
  }

  faceNow(key: string): FaceContent | null {
    return (this.stated("face", key)?.content ?? null) as FaceContent | null;
  }

  get own(): readonly (Handle & { product: string })[] {
    this.#own ??= ownHandles(this.view, ownProductsIn(this.host.registry.families), networksIn(this.host.registry.families));
    return this.#own;
  }

  ownProductsOf(handle: Handle): string[] {
    return this.own.filter((each) => sameHandle(each, handle)).map((each) => each.product);
  }

  get states(): readonly RecordState[] {
    this.#states ??= readPeople(this.view);
    return this.#states;
  }

  get #merged(): MergeTree {
    this.#tree ??= mergeTree(this.states);
    return this.#tree;
  }

  get youNow(): You {
    this.#you ??= { answer: youOf(this.#merged, this.own) };
    return this.#you.answer;
  }

  claimantOf(handle: Handle): string | null | undefined {
    this.#claims ??= claimsOf(this.#merged, this.own);
    return this.#claims.get(handleId(handle));
  }

  #statesAfter(root?: StatedPerson): RecordState[] {
    const after = Number.MAX_SAFE_INTEGER;
    const drafts = new Map([...this.#drafted, ...root === undefined ? [] : [[root.slug, root] as const]]);
    const states = this.states.flatMap((state): RecordState[] => drafts.has(state.record.slug) ? [] : [state]);
    for (const record of drafts.values()) {
      const was = this.states.find((state) => state.record.slug === record.slug);
      states.push({
        record,
        since: new Map(heldHandles(record).map((handle) => [handleId(handle), was?.since.get(handleId(handle)) ?? after])),
        me_since: !record.me ? null : was?.record.me === true ? was.me_since : after,
        merged_since: record.merged_into === null ? null : was?.record.merged_into === record.merged_into ? was.merged_since : after,
      });
    }
    return states;
  }

  #youAfter(root: StatedPerson): You {
    return youOf(mergeTree(this.#statesAfter(root)), this.own);
  }

  isYou({ slug, person }: { slug: string | null; person: Served }): boolean {
    const you = this.youNow;
    if (you === null) return false;
    if ("root" in you) return slug === you.root;
    return slug === null && person !== null && this.#holdsOwn(person);
  }

  #isYours(slug: string): boolean {
    const you = this.youNow;
    if (you !== null && "root" in you) return slug === you.root;
    return this.#first.has(slug) && this.#drafted.get(slug)?.me === true;
  }

  rootOf(slug: string): string {
    return this.#merged.rootOf.get(slug) ?? slug;
  }

  asRecord(slug: string): StatedPerson | undefined {
    if (this.#records.has(slug)) return this.#records.get(slug);
    const stated = this.current(slug);
    const record = stated === undefined ? null : readPersonRecord(stated);
    const found = record === null ? undefined : statedPerson(record);
    this.#records.set(slug, found);
    return found;
  }

  newSlug(text: string): string {
    const held = new Set([...this.#drafted.keys(), ...this.view.sources(PEOPLE_SOURCES).flatMap((source) => [...this.view.heads(source.id, "person")].map((head) => head.key))]);
    const base = slugOf(text);
    let slug = base;
    for (let n = 2; held.has(slug); n++) slug = `${base.slice(0, 60)}-${n}`;
    return slug;
  }


  served(id: string, need = true): Served {
    if (this.people === null) return need ? notNow("busy", "Your people are being prepared.", RETRY_SOON_S) : null;
    if (this.#served.has(id)) return this.#served.get(id)!;
    const found = this.people.detail(id) ?? null;
    this.#served.set(id, found);
    return found;
  }

  personOf(id: unknown): { slug: string | null; person: Served } {
    if (typeof id !== "string" || !/^[a-z]+:./u.test(id)) bad("A person is named by their id.");
    const asked = id as string;
    if (asked.startsWith("person:") && this.current(asked.slice("person:".length)) !== undefined) {
      return this.#rooted(this.rootOf(asked.slice("person:".length)), []);
    }
    const person = this.served(asked);
    const requested = idHandle(spelledId(asked) ?? asked);
    if (requested !== null && this.ownProductsOf(requested).length > 0) return this.#yours(asked, person);
    for (const [handle, served] of [[requested, false], [person === null ? null : idHandle(person.id), true]] as const) {
      const root = handle === null ? undefined : this.claimantOf(handle);
      if (root === undefined) continue;
      if (root === null) return this.#yours(asked, person);
      return this.#through(root, served ? requested : null, person, asked);
    }
    if (person === null) return fail(404, "PERSON_UNKNOWN", "There is no such person.");
    if (person.person !== null) return this.#through(this.rootOf(person.person), requested, person, asked);
    if (this.#holdsOwn(person)) return this.#yours(asked, person);
    return { slug: null, person };
  }

  #through(slug: string, requested: Handle | null, person: Served, asked: string): { slug: string; person: Served } {
    if (this.current(slug) === undefined) fail(409, "RECORD_ELSEWHERE", "This person's record is kept by another of your devices.");
    if (requested !== null && !this.#group(slug, person).keys.has(handleId(requested))) notNow("busy", "Your people are being prepared.", RETRY_SOON_S);
    return this.#rooted(slug, [asked]);
  }

  #yours(asked: string, person: Served): { slug: string | null; person: Served } {
    const you = this.youNow;
    return you !== null && "root" in you ? this.#rooted(you.root, [asked]) : { slug: null, person };
  }

  #holdsOwn(person: PersonDetail): boolean {
    return person.person === null && person.handles.some((handle) => this.own.some((each) => handleId(each) === handle.id));
  }

  #rooted(slug: string, ids: readonly string[]): { slug: string; person: Served } {
    const anchor = this.asRecord(slug)?.anchor ?? null;
    for (const id of [...ids, `person:${slug}`, ...(anchor === null ? [] : [handleId(anchor)])]) {
      const row = this.#rootsOwn(slug, this.served(id, false));
      if (row !== null) return { slug, person: row };
    }
    return { slug, person: null };
  }

  #rootsOwn(slug: string, row: Served): Served {
    if (row === null || row.id === `person:${slug}` || row.person === null) return row;
    if (row.joined.some((entry) => entry.id === `person:${slug}`)) notNow("busy", "Your people are being prepared.", RETRY_SOON_S);
    return null;
  }

  nameOf(slug: string): string {
    const record = this.current(slug);
    const named = typeof record?.name === "string" ? record.name : typeof record?.full_name === "string" ? record.full_name : null;
    return named ?? this.served(`person:${slug}`, false)?.name ?? "another person";
  }

  joinedInto(id: string): string | null {
    const slug = id.startsWith("person:") ? id.slice("person:".length) : this.#memberHolding(idHandle(id));
    if (slug === null || typeof this.current(slug)?.merged_into !== "string") return null;
    const root = this.rootOf(slug);
    return root === slug ? null : root;
  }

  #memberHolding(handle: Handle | null): string | null {
    const root = handle === null ? undefined : this.claimantOf(handle);
    if (typeof root !== "string") return null;
    return this.states.find((state) => this.rootOf(state.record.slug) === root && heldHandles(state.record).some((each) => sameHandle(each, handle!)))?.record.slug ?? null;
  }


  #take(slug: string): StatedPerson | undefined {
    const found = this.#drafted.get(slug) ?? this.#bases.get(slug) ?? this.asRecord(slug);
    if (found === undefined) return undefined;
    if (!this.#drafted.has(slug) && !this.#bases.has(slug)) this.#bases.set(slug, found);
    return structuredClone(found);
  }

  #put(record: StatedPerson): string {
    this.#drafted.set(record.slug, record);
    return record.slug;
  }

  #born(record: StatedPerson): string {
    this.#first.set(record.slug, structuredClone(record));
    return this.#put(record);
  }


  ensure(who: { slug: string | null; person: Served }): StatedPerson {
    const { slug, person } = who;
    const you = this.youNow;
    if (slug !== null) {
      const record = this.#take(slug) ?? fail(409, "RECORD_ELSEWHERE", "Their record has not reached your people yet: try again in a moment.");
      if (you !== null && "root" in you && !you.marked && slug === you.root) record.me = true;
      return record;
    }
    const holder = this.isYou(who);
    const anchor = holder ? ordered(this.own.map(({ kind, value }) => ({ kind, value })))[0] ?? null : person === null ? null : idHandle(person.id);
    if (anchor === null || person === null) return fail(409, "NO_HANDLE", "This contact card has no number or email to keep them by.");
    const made = [...this.#first.values()].find((record) => record.anchor !== null && sameHandle(record.anchor, anchor));
    if (made !== undefined) return this.#take(made.slug)!;
    const named = person.by === "none" ? anchor.value : person.name;
    return this.#take(this.#born(fresh(this.newSlug(named), { anchor, me: holder })))!;
  }

  #youAct(action: JsonObject): string {
    const name = action.name === undefined || action.name === null ? null : textOf("name", action.name);
    if (name === null) bad("Say what Lifestream should call you.");
    const full = Object.hasOwn(action, "full_name") ? { full_name: textOf("full_name", action.full_name) } : {};
    const you = this.youNow;
    if (you !== null && "root" in you) {
      const record = this.#take(you.root) ?? fail(409, "RECORD_ELSEWHERE", "Your record is kept by another of your devices.");
      return this.#put(Object.assign(record, { name, ...full, show: "name", me: true }));
    }
    const record = fresh(this.newSlug(name!), { name, ...full, me: true });
    this.#madeYou = record.slug;
    return this.#born(record);
  }

  #confirm(action: JsonObject): string {
    if (action.photo !== undefined) bad("Their photo is a picture you frame now: choose it again.");
    if (action.upload !== undefined) bad("Their photo is saved when you use it, not with the card.");
    const accept = idsOf(action.accept);
    const decline = idsOf(action.decline);
    const added = listOf(action.add, "Added people are named by their ids.");
    for (const id of added) if (!id.startsWith("person:") && idHandle(id) === null) bad("Only a person, a number or an email is added.");
    const split = listOf(action.split, "People split off are named by their ids.");
    for (const id of split) if (!/^person:./u.test(id)) bad("People split off are named by their ids.");
    if (split.some((id) => added.includes(id))) bad("A person is split off or added, never both.");
    const cut = listOf(action.unlink, "A number or email taken off is named by its id.").map((id) => idHandle(id) ?? bad("A number or email taken off is named by its id."));
    const groups = listOf(action.groups, "Face groups are named by their ids.");
    const details = action.details === undefined ? null : changedDetails(action.details);
    const adding = namesOf(action.add_names);
    const removing = namesOf(action.remove_names);
    if (adding.some((name) => removing.some((other) => foldName(other) === foldName(name)))) bad("A name is added or taken off, never both.");
    const who = this.personOf(action.id);
    const into = this.joinedInto(action.id as string);
    if (into !== null) fail(409, "JOINED", `They were joined into ${this.nameOf(into)}.`);
    const leaving = this.#leavingOf(who, split);
    if (this.isYou(who) && NOT_YOURS.some((field) => Object.hasOwn(action, field))) bad("You are always you: no relationship, type or Hide.");
    for (const handle of cut) {
      const products = this.ownProductsOf(handle);
      if (products.length > 0) fail(409, "OWN_ACCOUNT", `Lifestream reads your ${productWords(products, productNames(this.host.registry.families))} from this account: it stays yours.`);
    }
    const offered: readonly Suggestion[] = who.person?.suggestions ?? [];
    const pick = (id: string): Suggestion => offered.find((each) => each.id === id) ?? fail(409, "NOT_OFFERED", "That suggestion is no longer offered: open the person again.");
    const accepted = accept.map(pick);
    for (const suggestion of accepted) if (this.#staleOffer(who.slug, suggestion) !== null) fail(409, "NOT_OFFERED", "That suggestion is no longer offered: open the person again.");
    const record = this.ensure(who);
    if (record.show === "full_name") Object.assign(record, { name: record.full_name ?? record.name, show: "name" });
    for (const suggestion of accepted) this.#accepted(record, suggestion);
    for (const suggestion of decline.map(pick)) record.dismissed = [...new Set([...record.dismissed, suggestion.id])].sort();
    for (const id of added) {
      const other = this.personOf(id);
      const lone = !id.startsWith("person:") && other.slug === null && (other.person === null || (!other.person.card && other.person.by === "none" && other.person.handles.length <= 1));
      if (id.startsWith("person:") || other.slug === null && !lone) this.#joined(record, other);
      else if (!this.#youAlready(record, other)) this.#claimed(record, idHandle(id)!, other.slug);
    }
    for (const handle of cut) unlinked(record, who.person, handle);
    this.#split(record, leaving);
    called(record, adding, removing);
    for (const field of FIELDS) if (Object.hasOwn(action, field)) Object.assign(record, edited(field, action[field]));
    for (const cluster of groups) for (const face of this.#groupOf(cluster)) this.#faced.set(face, { is: record.slug });
    if (details !== null) this.#detailed.set(record.slug, { changed: details, person: who.person });
    return this.#put(record);
  }

  #leavingOf(who: { slug: string | null; person: Served }, split: readonly string[]): Map<string, Set<string>> {
    const leaving = new Map<string, Set<string>>();
    for (const id of new Set(split)) {
      const slug = id.slice("person:".length);
      if (who.slug === null || slug === who.slug || this.current(slug) === undefined || this.rootOf(slug) !== who.slug) {
        fail(409, "NOT_JOINED", "They are not joined into this person any more: open the person again.");
      }
      const entry = who.person?.joined.find((each) => each.id === id) ?? notNow("busy", "Your people are being prepared.", RETRY_SOON_S);
      leaving.set(slug, new Set(entry.handles));
    }
    return leaving;
  }

  #split(root: StatedPerson, leaving: ReadonlyMap<string, ReadonlySet<string>>): void {
    if (leaving.size === 0) return;
    for (const slug of leaving.keys()) this.#put(Object.assign(this.#take(slug)!, { merged_into: null }));
    const handles = new Set([...leaving.values()].flatMap((each) => [...each]));
    for (const slug of [root.slug, ...this.#members(root.slug)]) {
      const record = slug === root.slug ? root : this.#take(slug)!;
      const excluded = record.excluded.filter((handle) => !handles.has(handleId(handle)));
      if (excluded.length === record.excluded.length) continue;
      record.excluded = excluded;
      if (record !== root) this.#put(record);
    }
    root.dismissed = [...new Set([...root.dismissed, ...[...leaving.keys()].map((slug) => sameIdOf(`person:${root.slug}`, `person:${slug}`))])].sort();
    const you = this.youNow;
    if (you === null || !("root" in you)) return;
    if (you.marked && you.root === root.slug) {
      for (const slug of leaving.keys()) {
        for (const each of [slug, ...this.#members(slug)]) {
          const record = this.#take(each)!;
          if (!record.me) continue;
          this.#put(Object.assign(record, { me: false }));
          root.me = true;
        }
      }
    }
    const after = this.#youAfter(root);
    if (after === null || !("root" in after) || after.root !== you.root) {
      fail(409, "IS_YOU", `Not split off: that would make ${this.nameOf(after !== null && "root" in after ? after.root : you.root)} you.`);
    }
  }

  #staleOffer(slug: string | null, suggestion: Suggestion): string | null {
    const record = slug === null ? undefined : this.asRecord(slug);
    if (record === undefined) return null;
    if (record.dismissed.includes(suggestion.id)) return suggestion.kind === "entity" && suggestion.value === "business" ? "You said they are not a business." : "You said no to it.";
    if (suggestion.kind === "entity" && suggestion.value === "business" && record.entity !== null) return "You said what they are.";
    return null;
  }

  #businesses(action: JsonObject): void {
    const ids = listOf(action.ids, "Accept all businesses names its people by their ids.");
    if (ids.length === 0) bad("Accept all businesses names one person at least.");
    if (Object.keys(action).some((member) => member !== "of" && member !== "kind" && member !== "request" && member !== "ids")) bad("Accept all businesses carries only its people.");
    const marking: { id: string; offer: string }[] = [];
    const refused: JsonObject[] = [];
    const people = new Set<string>();
    for (const id of ids) {
      try {
        const who = this.personOf(id);
        const into = this.joinedInto(id);
        if (into !== null) fail(409, "JOINED", `They were joined into ${this.nameOf(into)}.`);
        const person = who.slug !== null ? `person:${who.slug}` : who.person?.id ?? id;
        if (people.has(person)) continue;
        people.add(person);
        const offer = who.person?.suggestions.find((each) => each.kind === "entity" && each.value === "business");
        const stale = this.#staleOffer(who.slug, offer ?? BUSINESS_OFFER);
        if (stale !== null) fail(409, "NOT_OFFERED", stale);
        if (offer === undefined) fail(409, "NOT_OFFERED", "No longer offered as a business.");
        if (who.slug !== null && this.asRecord(who.slug) === undefined) fail(409, "RECORD_ELSEWHERE", "Their record has not reached your people yet: try again in a moment.");
        if (who.slug === null && idHandle(who.person!.id) === null) fail(409, "NO_HANDLE", "This contact card has no number or email to keep them by.");
        marking.push({ id, offer: offer!.id });
      } catch (error) {
        if (!(error instanceof Refusal) || (error.status !== 404 && error.status !== 409)) throw error;
        refused.push({ id, code: error.code, message: error.words });
      }
    }
    if (refused.length > 0) {
      refuse(409, "NOT_OFFERED", `${refused.length} of them can’t be marked: they changed since you looked.`, undefined, { refused });
    }
    for (const { id, offer } of marking) this.#confirm({ id, accept: [offer] });
  }

  #accepted(record: StatedPerson, suggestion: Suggestion): void {
    if (suggestion.kind === "handle") {
      const handle = idHandle(suggestion.value) ?? fail(409, "NO_HANDLE", "That suggestion names no handle.");
      const theirs = this.served(suggestion.value, false)?.person ?? null;
      this.#claimed(record, handle, theirs === null ? null : this.rootOf(theirs));
    } else if (suggestion.kind === "full_name") {
      record.full_name = suggestion.value;
    } else if (suggestion.kind === "entity") {
      record.entity = suggestion.value as Entity;
    } else if (suggestion.kind === "same") {
      const other = suggestion.value.includes(":") ? suggestion.value : `person:${suggestion.value}`;
      this.#joined(record, this.personOf(other));
    }
  }

  #joined(record: StatedPerson, other: { slug: string | null; person: Served }): void {
    if (this.#youAlready(record, other)) return;
    const merged = this.ensure(other);
    if (merged.slug === record.slug) return;
    merged.merged_into = record.slug;
    this.#mergedIn.set(merged.slug, other.person);
    this.#put(merged);
  }

  #youAlready(record: StatedPerson, other: { slug: string | null; person: Served }): boolean {
    if (!this.isYou(other)) return false;
    if (this.#isYours(record.slug)) return true;
    return fail(409, "IS_YOU", "You can't be joined into someone else. Add them from your own page.");
  }


  #claimed(record: StatedPerson, handle: Handle, theirs: string | null): void {
    if (this.ownProductsOf(handle).length > 0 && !this.#isYours(record.slug)) fail(409, "IS_YOU", "You can't be joined into someone else. Add them from your own page.");
    const claimant = this.claimantOf(handle);
    const you = this.youNow;
    const owner = claimant === undefined ? theirs : claimant ?? (you !== null && "root" in you ? you.root : null);
    if (owner !== null && owner !== record.slug) fail(409, "HANDLE_TAKEN", "That number or email is another person's: add them by name.");
    linked(record, handle);
  }

  #name(action: JsonObject): string {
    if (Object.hasOwn(action, "me") || Object.hasOwn(action, "merge")) bad("A face group is named as a person, You by your id, or a new name.");
    const faces = this.#groupOf(action.cluster);
    const target = action.target;
    let record: StatedPerson;
    if (isObject(target) && target.kind === "person") {
      record = this.ensure(this.personOf(target.id));
    } else if (isObject(target) && target.kind === "new") {
      const named = textOf("name", target.name);
      if (named === null) bad(`A name is 1 to ${TEXT_LIMIT} characters.`);
      record = fresh(this.newSlug(named!), { name: named });
      this.#born(record);
    } else {
      return bad("A face group is named as a person or a new name.");
    }
    const slug = this.#put(record);
    const out = new Set(Array.isArray(action.out) ? action.out : []);
    for (const face of faces) this.#faced.set(face, out.has(face) ? this.#notOf(face, slug) : { is: slug });
    return slug;
  }

  #groupOf(cluster: unknown): string[] {
    if (typeof cluster !== "string") return fail(409, "NO_FACES", "This group has no faces left to name.");
    const open = (face: string) => this.#open(face);
    let faces = this.#clusterFaces(cluster).filter(open);
    if (faces.length === 0) faces = (this.#spentNow()[cluster] ?? []).filter(open);
    if (faces.length === 0) fail(409, "NO_FACES", "This group has no faces left to name.");
    this.#answering[cluster] = faces;
    return faces;
  }

  #clusterFaces(cluster: string): string[] {
    for (const source of this.view.sources({ product: ["faces"] })) {
      const head = this.view.head({ source: source.id, kind: "cluster", key: cluster });
      if (head === undefined || head.version === "gone") continue;
      const content = this.view.version(head.version).content;
      const listed = isObject(content) && Array.isArray(content.faces) ? content.faces : [];
      return listed.flatMap((face) => isObject(face) && typeof face.face === "string" ? [face.face] : []);
    }
    return [];
  }

  #open(face: string): boolean {
    const said = this.#faced.get(face) ?? this.faceNow(face);
    return said === null || !("is" in said || "ignore" in said);
  }

  #spentNow(): Record<string, string[]> {
    const kept = this.view.tables.meta.get(PEOPLE_UNDONE);
    return kept === undefined ? {} : JSON.parse(kept) as Record<string, string[]>;
  }

  #spent(): Record<string, string[]> {
    const left: Record<string, string[]> = {};
    for (const [cluster, faces] of Object.entries(this.#spentNow())) {
      const served = new Set(this.#clusterFaces(cluster));
      if (faces.some((face) => served.has(face))) continue;
      const open = faces.filter((face) => this.#open(face));
      if (open.length > 0) left[cluster] = open;
    }
    return left;
  }

  #notOf(face: string, slug: string): FaceContent {
    const before = this.faceNow(face);
    return { is_not: [...new Set([...(before !== null && "is_not" in before ? before.is_not : []), slug])].sort() };
  }

  #now(slug: string): StatedPerson | undefined {
    return this.#drafted.get(slug) ?? this.asRecord(slug);
  }

  #members(slug: string): string[] {
    return [...mergeTree(this.#statesAfter()).rootOf].flatMap(([each, root]) => each !== slug && root === slug && (this.#persons.has(each) || this.#drafted.has(each)) ? [each] : []);
  }

  #newest(kind: "photo" | "details", keys: Iterable<string>): { content: JsonObject; stated_ms: number; key: string } | null {
    let newest: { content: JsonObject; stated_ms: number; key: string } | null = null;
    for (const key of keys) {
      const found = this.stated(kind, key);
      if (found === null) continue;
      if (newest === null || found.stated_ms > newest.stated_ms || (found.stated_ms === newest.stated_ms && key < newest.key)) newest = { ...found, key };
    }
    return newest;
  }

  #group(slug: string, person: Served): { records: string[]; keys: Set<string> } {
    const records = [slug, ...this.#members(slug)];
    const inGroup = new Set(records.map((each) => `person:${each}`));
    const leaving = new Set((person?.joined ?? []).filter((entry) => !inGroup.has(entry.id)).flatMap((entry) => entry.handles));
    const handles = new Set([
      ...records.flatMap((each) => heldHandles(this.#now(each) ?? fresh(each, {})).map(handleId)),
      ...(person?.handles ?? []).map((handle) => handle.id).filter((id) => !leaving.has(id)),
      ...[...this.#mergedIn].filter(([merged]) => inGroup.has(`person:${merged}`)).flatMap(([, row]) => (row?.handles ?? []).map((handle) => handle.id)),
    ]);
    const cards = [...this.#keyedCards()].flatMap(([contact, ids]) => ids.some((id) => handles.has(id)) ? [contact] : []);
    return { records, keys: new Set([...inGroup, ...handles, ...cards]) };
  }

  #keyedCards(): ReadonlyMap<string, readonly string[]> {
    if (this.#cards !== undefined) return this.#cards;
    const wanted = new Set(["photo", "details"].flatMap((kind) => [...this.view.heads(this.source, kind)].flatMap((head) => head.key.startsWith("contact:") ? [head.key] : [])));
    const cards = new Map<string, string[]>();
    const country = wanted.size === 0 ? null : ownCountry(this.view, networksIn(this.host.registry.families));
    for (const source of wanted.size === 0 ? [] : this.view.sources({})) {
      for (const head of this.view.heads(source.id, CONTACT_KIND)) {
        const contact = contactPersonId({ id: contactId({ source: source.id, key: head.key }) });
        const parts = wanted.has(contact) && !cards.has(contact) ? cardParts(this.view.version(head.version).content) : null;
        if (parts === null) continue;
        const phones = parts.phones.flatMap((phone) => {
          const value = canonicalPhone(phone, country);
          return value === null ? [] : [handleId({ kind: "phone", value })];
        });
        cards.set(contact, [...phones, ...parts.emails.map((value) => handleId({ kind: "email", value }))]);
      }
    }
    this.#cards = cards;
    return cards;
  }

  newestOf(kind: "photo", slug: string, person: Served): JsonObject | null {
    return this.#newest(kind, this.#group(slug, person).keys)?.content ?? null;
  }

  #detailsEdit(slug: string, person: Served, changed: Partial<DetailsContent>): { own: JsonObject | null; ownKey: string | null; content: DetailsContent } {
    const root = this.#now(slug) ?? fresh(slug, {});
    const ownKeys = new Set([`person:${slug}`, ...heldHandles(root).map(handleId)]);
    const newest = this.#newest("details", ownKeys);
    const own = newest?.content ?? null;
    const base = (own as DetailsContent | null) ?? NO_DETAILS;
    const content: DetailsContent = { type: "people.details", work: base.work, birthday: base.birthday, profiles: base.profiles, ...changed };
    const cleared = new Set(base.cleared ?? []);
    const group = this.#group(slug, person);
    let shown: Details | undefined;
    if (group.records.length > 1) {
      const statements = [...group.keys].filter((key) => !ownKeys.has(key)).flatMap((key): DetailsStatement[] => {
        const found = this.stated("details", key);
        return found === null ? [] : [{ key, stated_ms: found.stated_ms, details: found.content as unknown as Details }];
      });
      shown = detailsOf({ root: slug, records: [root, ...group.records.slice(1).map((member) => this.#now(member) ?? fresh(member, {}))] }, statements);
    }
    for (const field of Object.keys(changed) as (keyof Details & string)[]) {
      const empty = (value: Json | undefined) => value === null || value === undefined || (Array.isArray(value) && value.length === 0);
      if (!empty(content[field])) cleared.delete(field);
      else if (shown !== undefined && !empty(shown[field] as Json | undefined)) cleared.add(field);
    }
    if (cleared.size > 0) content.cleared = [...cleared].sort(byText);
    const guard: Guard = this.reader.statements.details?.guard ?? (() => []);
    const faults = guard(content);
    if (faults.length > 0) bad(`Their details: ${faults.join("; ")}.`);
    return { own, ownKey: newest?.key ?? null, content };
  }

  #statements(): { made: Statement[]; inverse: Statement[]; blobs: Map<string, Buffer> } {
    const made: Statement[] = [];
    const inverse: Statement[] = [];
    const blobs = new Map<string, Buffer>();
    const marked = [...this.#drafted.values()].filter((record) => record.me && this.asRecord(record.slug)?.me !== true);
    if (marked.length > 0) oneYou(this.youNow, marked.map(({ slug, anchor }) => ({ slug, anchor, first: this.#first.has(slug) })), this.own, this.#madeYou);
    for (const [slug, record] of this.#drafted) {
      const base = this.#bases.get(slug);
      if (base !== undefined && same(base, record)) continue;
      made.push({ kind: "person", key: slug, content: checked(record) as unknown as Json });
      const before = this.current(slug) ?? this.#first.get(slug) as unknown as JsonObject | undefined;
      if (before !== undefined && !same(before, record)) inverse.push({ kind: "person", key: slug, content: before });
    }
    for (const [key, content] of this.#faced) {
      const before = this.faceNow(key);
      if (before !== null && same(before, content)) continue;
      made.push({ kind: "face", key, content: content as unknown as Json });
      inverse.push(before === null ? { kind: "face", key, gone: true } : { kind: "face", key, content: before as unknown as Json });
    }
    for (const [slug, { content, square, person }] of this.#pictured) {
      const shown = this.newestOf("photo", slug, person)?.image ?? null;
      if (shown === content.image) continue;
      const key = `person:${slug}`;
      const before = this.stated("photo", key)?.content ?? null;
      made.push({ kind: "photo", key, content });
      inverse.push(before === null || before.image !== shown ? { kind: "photo", key, gone: true } : { kind: "photo", key, content: before });
      blobs.set(content.image as string, square);
    }
    for (const [slug, { changed, person }] of this.#detailed) {
      const { own, ownKey, content } = this.#detailsEdit(slug, person, changed);
      if (same(own ?? NO_DETAILS, content)) continue;
      const key = `person:${slug}`;
      const before = this.stated("details", key)?.content ?? null;
      made.push({ kind: "details", key, content });
      inverse.push(before === null || ownKey !== key ? { kind: "details", key, gone: true } : { kind: "details", key, content: before });
    }
    for (const [chat, quiet] of this.#worded) {
      const before = this.stated("group", chat)?.content ?? null;
      if (quiet === null ? before === null : before !== null && before.quiet === quiet) continue;
      made.push(quiet === null ? { kind: "group", key: chat, gone: true } : { kind: "group", key: chat, content: { quiet } });
      inverse.push(before === null ? { kind: "group", key: chat, gone: true } : { kind: "group", key: chat, content: before });
    }
    return { made, inverse, blobs };
  }


  #undo(act: unknown): Drafted {
    const kept = this.view.tables.meta.get(PEOPLE_UNDO);
    if (typeof act !== "string") bad("An undo names the action it takes back.");
    if (kept === undefined) fail(409, "NOTHING_TO_UNDO", "There is nothing to undo.");
    const undo = JSON.parse(kept!) as Undo;
    if (undo.act !== act) fail(409, "NOT_LAST", "Another device changed your people since.");
    if (undo.undone === true) fail(409, "UNDONE", "That action is undone already.");
    const newest = this.view.tables.deliveries.imported(this.source).reduce<{ id: string; run: number } | null>((last, row) => last === null || row.run > last.run ? row : last, null);
    if (newest?.id !== act) fail(409, "NOT_LAST", "Another device changed your people since.");
    const statements = undo.statements ?? [];
    if (statements.length === 0) fail(409, "NOTHING_TO_UNDO", "That action made a person, who stays: there is nothing to undo.");
    const blobs = new Map<string, Buffer>();
    for (const statement of statements) {
      if (statement.kind !== "photo" || !("content" in statement) || !isObject(statement.content) || statement.content.face !== undefined) continue;
      const image = statement.content.image as string;
      if (!this.host.blobs.has(image)) fail(409, "PHOTO_GONE", "The photo they showed before is no longer in Lifestream.");
      blobs.set(image, this.host.blobs.bytes(image));
    }
    return { kind: "undo", statements, inverse: [], blobs, id: null, groups: undo.groups ?? {}, spent: this.#spent(), undoes: act as string };
  }
}

function groupKey(value: unknown, networks: Networks): string {
  const key = typeof value === "string" ? value : "";
  const colon = key.indexOf(":");
  if (colon < 0 || !isGroupChat(networks, key.slice(0, colon), key.slice(colon + 1))) {
    bad("A word on a group names a group chat, as People serves its key: <network>:<chat>.");
  }
  return key;
}

function wordOf(value: unknown): boolean | null {
  if (value !== true && value !== false && value !== null) bad("A word on a group is quiet: true, false or null.");
  return value as boolean | null;
}

function fresh(slug: string, given: Partial<StatedPerson>): StatedPerson {
  return {
    type: "people.person", slug, name: null, full_name: null, show: "name", entity: null, relationship: null,
    hidden: false, me: false, anchor: null, handles: [], excluded: [], dismissed: [], also_called: [], merged_into: null, ...given,
  };
}

function idHandle(id: string): Handle | null {
  const colon = id.indexOf(":");
  const kind = id.slice(0, colon) as Handle["kind"];
  return colon > 0 && (KINDS as readonly string[]).includes(kind) && id.length > colon + 1 ? { kind, value: id.slice(colon + 1) } : null;
}

const sameHandle = (left: Handle, right: Handle): boolean => left.kind === right.kind && left.value === right.value;


function ordered(handles: readonly Handle[]): Handle[] {
  return [...new Map(handles.map((handle) => [handleId(handle), handle])).values()].sort(compareHandles);
}

function linked(record: StatedPerson, handle: Handle): void {
  record.excluded = record.excluded.filter((each) => !sameHandle(each, handle));
  if (!heldHandles(record).some((each) => sameHandle(each, handle))) record.handles = ordered([...record.handles, handle]);
}

function unlinked(record: StatedPerson, person: Served, handle: Handle): void {
  const theirs: Handle[] = (person?.handles ?? []).map((each) => ({ kind: each.kind as Handle["kind"], value: each.kind === "network" ? each.id : each.id.slice(each.kind.length + 1) }));
  if (![...theirs, ...heldHandles(record)].some((each) => sameHandle(each, handle))) fail(409, "NOT_THEIRS", "That is not one of theirs.");
  record.handles = record.handles.filter((each) => !sameHandle(each, handle));
  record.excluded = ordered([...record.excluded.filter((each) => !sameHandle(each, handle)), handle]);
  if (record.anchor !== null && sameHandle(record.anchor, handle)) {
    record.anchor = ordered(theirs.filter((each) => !record.excluded.some((off) => sameHandle(off, each))))[0] ?? null;
    if (record.anchor === null && record.name === null && person !== null && person.by !== "none") record.name = person.call_name ?? null;
  }
}

function edited(field: (typeof FIELDS)[number], value: Json | undefined): Partial<StatedPerson> {
  if (field === "entity") {
    if (typeof value !== "string" || !(ENTITIES as readonly string[]).includes(value)) bad("A type is person, AI, business or bot.");
    return { entity: value as Entity };
  }
  if (field === "hidden") {
    if (typeof value !== "boolean") bad("Hidden is yes or no.");
    return { hidden: value as boolean };
  }
  return { [field]: textOf(field, value) };
}

function textOf(field: string, value: Json | undefined): string | null {
  if (value === null) return null;
  if (typeof value !== "string") bad(`${field.replace("_", " ")} is text.`);
  const text = (value as string).replace(/\s+/gu, " ").trim();
  if (text.length > TEXT_LIMIT) bad(`A ${field.replace("_", " ")} is at most ${TEXT_LIMIT} characters.`);
  return text === "" ? null : text;
}

function checked(record: StatedPerson): StatedPerson {
  if (record.name === null && record.full_name === null && record.anchor === null && record.handles.length === 0) {
    fail(409, "NO_NAME", "A person needs a name or a number or email to be kept by.");
  }
  return record;
}

const byText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function called(record: StatedPerson, adding: readonly string[], removing: readonly string[]): void {
  if (adding.length + removing.length === 0) return;
  const without = (names: readonly string[], name: string) => names.filter((each) => foldName(each) !== foldName(name));
  for (const name of removing) {
    record.also_called = without(record.also_called, name);
    record.dismissed = [...new Set([...record.dismissed, calledId(name)])].sort();
  }
  for (const name of adding) {
    record.also_called = [...without(record.also_called, name), name];
    record.dismissed = record.dismissed.filter((id) => id !== calledId(name));
  }
  if (adding.length > 0 && record.also_called.length > MOST_CALLED) fail(409, "NAMES_FULL", `A person has at most ${MOST_CALLED} other names.`);
  record.also_called.sort((left, right) => byText(foldName(left), foldName(right)));
}

function namesOf(value: Json | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) bad("Other names are a list.");
  return (value as Json[]).map((name) => (typeof name === "string" ? calledName(name) : null) ?? bad("Another name is 1 to 60 characters, with no control character."));
}

export interface Marked {
  readonly slug: string;
  readonly anchor: Handle | null;
  readonly first: boolean;
}

export function oneYou(you: You, marked: readonly Marked[], own: readonly Handle[], made: string | null): void {
  const allowed = ({ slug, anchor, first }: Marked): boolean => {
    if (you !== null && "root" in you) return slug === you.root;
    if (slug === made) return true;
    return you !== null && first && anchor !== null && own.some((handle) => sameHandle(handle, anchor));
  };
  const wrong = marked.find((record) => !allowed(record)) ?? (marked.length > 1 ? marked[1] : undefined);
  if (wrong !== undefined) throw new Error(`the writer marked ${wrong.slug} as You, which who You is does not allow`);
}

function idsOf(value: Json | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && SUGGESTION.test(id))) bad("Suggestions are named by their ids.");
  return value as string[];
}

function listOf(value: Json | undefined, refusal: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string" && id !== "")) bad(refusal);
  return value as string[];
}

function changedDetails(value: Json): Partial<DetailsContent> {
  if (!isObject(value) || Object.keys(value).some((member) => !DETAIL_MEMBERS.includes(member))) bad("Details are work, a birthday and profiles.");
  const changed: Partial<DetailsContent> = {};
  const given = value as JsonObject;
  if (Object.hasOwn(given, "work")) {
    const work = given.work;
    if (work !== null && typeof work !== "string") bad("Work is text.");
    changed.work = work === null ? null : (work as string).replace(/\s+/gu, " ").trim() || null;
  }
  if (Object.hasOwn(given, "birthday")) {
    const birthday = given.birthday;
    if (birthday !== null && !isObject(birthday)) bad("A birthday is a month and a day, and a year or none.");
    changed.birthday = birthday === null ? null : { year: null, ...(birthday as JsonObject) };
  }
  if (Object.hasOwn(given, "profiles")) {
    if (!Array.isArray(given.profiles)) bad("Profiles are a list.");
    const seen = new Set<string>();
    changed.profiles = (given.profiles as Json[]).filter((profile) => {
      const key = JSON.stringify(isObject(profile) ? [profile.network, profile.value] : profile);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  return changed;
}

function pictureOf(upload: Json | undefined): { content: JsonObject; square: Buffer } | null {
  if (upload === undefined) return null;
  if (typeof upload !== "string" || upload === "" || !BASE64.test(upload)) bad("That picture can't be read.");
  const square = Buffer.from(upload as string, "base64");
  if (square.length > PICTURE_BYTES) bad("That picture is too large.");
  return { content: { type: "people.photo", image: sha256(square) }, square };
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left as Json) === canonical(right as Json);
}
