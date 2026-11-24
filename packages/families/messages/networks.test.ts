import type { DaySettings, Handle, Json, MessagesAdapter, PersonRecord, SourceRow, Version, View } from "@lifestreamprotocol/core";
import { handleId } from "@lifestreamprotocol/core";
import { describe, expect, it } from "vitest";
import type { Given, ProviderLabel } from "../family.js";
import { chatName, nameId } from "../shared/cast.js";
import { buildLabels, labelTable, ownCountry, ownHandles, personHandles, resolvedName } from "../shared/labels.js";
import type { RecordState } from "../shared/people.js";
import { FED } from "../test/fed.js";
import { messagesFamily, type ChatDay } from "./family.js";
import { networksOf } from "./networks.js";
import { chatDayPart, peopleOf, spelledId, type GroupSettings } from "./people.js";

const DAY: DaySettings = { zone: "UTC", day_start_hour: 0 };
const AT = Date.parse("2026-10-02T10:00:00Z");

const network = (product: string): Given<MessagesAdapter> => ({
  product, name: `Example ${product}`, vendor: "example", type: "messages",
  adapter: {
    version: "1", kinds: ["msg"], message: () => null,
    group: (chat) => chat.startsWith("room-"),
    members: (chat) => chat.startsWith("room-") ? [] : [{ id: chat, kind: "network" }],
    unknown: (id) => `unknown ${id}`,
  },
});
const NETWORKS = networksOf([network("net-a"), network("net-b")]);

const person = (slug: string, name: string, handles: Handle[]): RecordState => {
  const record: PersonRecord = {
    slug, name, full_name: null, show: "name", entity: "person", relationship: null, hidden: false, me: false,
    anchor: handles[0] ?? null, handles: handles.slice(1), excluded: [], dismissed: [], merged_into: null, also_called: [],
  };
  return { record, since: new Map(handles.map((handle) => [handleId(handle), 1])), me_since: null, merged_since: null };
};
const PERSON_A = person("person-a", "Person A", [{ kind: "network", value: "net-a:user-a1" }]);

function chatDay(product: string, chat: string, from: readonly (string | "me")[]): Json {
  const content: ChatDay = {
    network: product, chat, day: "2026-10-02",
    messages: from.map((id, index) => ({
      source: `${product}:owner-1:iphone-aa01`, key: `${chat}:m${index}`, at: AT + index * 60_000,
      from: id === "me" ? { id: "me", kind: "me" } : { id, kind: "network" }, text: "synthetic words",
    })),
  };
  return content as unknown as Json;
}

const RULES: Record<string, GroupSettings> = {
  "net-a": { archived: true, after_days: null, talk: "all" },
  "net-b": { archived: true, after_days: null, talk: "all" },
};

const PROVIDERS: [string, ReadonlyMap<string, ProviderLabel>][] = [
  ["net-a", new Map<string, ProviderLabel>([["room-1", { name: "Room of net-a", archived: true }], ["123456789", { pushName: "Push Name B" }]])],
  ["net-b", new Map<string, ProviderLabel>([["room-1", { name: "Room of net-b" }]])],
];

function labels() {
  return buildLabels({ people: [PERSON_A], providers: PROVIDERS, networks: NETWORKS, places: [] });
}

function people() {
  const built = labels();
  return peopleOf({
    networks: NETWORKS, mail: [], labels: built, cards: [], records: [PERSON_A], providers: new Map(built.table.providers), country: null, own: [],
    faces: null, photos: [], details: [], day: DAY, groups: { words: new Map(), rules: RULES },
    chats: [
      chatDayPart(chatDay("net-a", "123456789", ["123456789", "me", "123456789"]), DAY, NETWORKS),
      chatDayPart(chatDay("net-a", "room-1", ["me", "user-a1"]), DAY, NETWORKS),
      chatDayPart(chatDay("net-b", "room-1", ["me", "user-b1"]), DAY, NETWORKS),
    ],
  });
}

describe("a network the release does not know, through People and the labels", () => {
  it("N1: a network's party is its network's handle in People, never a guessed phone, never dropped", () => {
    const answer = people();
    const handles = answer.persons.flatMap((each) => each.handles.map((handle) => handle.id));
    expect(handles).not.toContain("phone:+123456789");
    const numeric = answer.persons.find((each) => each.handles.some((handle) => handle.id === "net-a:123456789"))!;
    expect(numeric.handles).toEqual([{ id: "net-a:123456789", kind: "network", network: "net-a", words: "unknown 123456789", from: null, own: false }]);
    expect([numeric.received, numeric.sent, numeric.chats]).toEqual([2, 1, [{ key: "net-a:123456789", count: 2 }]]);
    const a = answer.persons.find((each) => each.person === "person-a")!;
    expect([a.name, a.received, a.networks, a.chats]).toEqual(["Person A", 1, ["net-a"], [{ key: "net-a:room-1", count: 1 }]]);
    expect(answer.persons.some((each) => each.handles.some((handle) => handle.id === "net-b:user-b1"))).toBe(true);
  });

  it("N2: a network's person is kept under its handle's id and named by it on a day, its push name by its network", () => {
    const built = labels();
    expect([...built.contents.keys()].filter((unit) => unit.includes("user-a1"))).toEqual(["net-a:user-a1"]);
    expect(built.table.people).toEqual([
      ["network", "net-a:123456789", "net-a:123456789", "Push Name B", "push-name", null, false],
      ["network", "net-a:user-a1", "person:person-a", "Person A", "registry", "person-a", false],
    ]);
    expect(labelTable([...built.contents].map(([unit, content]) => ({ unit, content })))).toEqual(built.table);
    expect(nameId("user-a1", built, "network", "net-a")).toEqual({ name: "Person A", by: "registry", person: "person-a", who: "person:person-a" });
    expect(nameId("123456789", built, "network", "net-a")).toEqual({ name: "Push Name B", by: "push-name", person: null, who: "net-a:123456789" });
    expect(chatName(NETWORKS, "net-a", "user-a1", built)).toEqual({ text: "Person A", names: [{ start: 0, end: 8, who: "person:person-a" }] });
    expect(personHandles(built.table, "net-a:user-a1")).toEqual(["net-a:user-a1"]);
  });

  it("N3: a network handle's person id keeps its spelling", () => {
    expect(spelledId("net-a:123456789")).toBe("net-a:123456789");
    expect(spelledId("net-a:user-a1")).toBe("net-a:user-a1");
    expect(spelledId("phone:+1 555 000 0001")).toBe("phone:+15550000001");
    expect(spelledId("jid:15550000001@s.whatsapp.net")).toBe("phone:+15550000001");
  });

  it("N4: two networks with one raw group id keep their own names and archived flags", () => {
    const built = labels();
    expect([built.provider?.("room-1", "net-a"), built.provider?.("room-1", "net-b")]).toEqual([{ name: "Room of net-a", archived: true }, { name: "Room of net-b" }]);
    expect([chatName(NETWORKS, "net-a", "room-1", built), chatName(NETWORKS, "net-b", "room-1", built)]).toEqual([
      { text: "Room of net-a", names: [] }, { text: "Room of net-b", names: [] },
    ]);
    const chats = Object.fromEntries(people().list.chats.map((chat) => [chat.key, [chat.label, chat.quiet?.why ?? null]]));
    expect([chats["net-a:room-1"], chats["net-b:room-1"]]).toEqual([["Room of net-a", "archived"], ["Room of net-b", null]]);
  });
});

const NUMERIC: Given<MessagesAdapter> = {
  product: "net-c", name: "Example net-c", vendor: "example", type: "messages",
  adapter: {
    version: "1", kinds: ["msg"], owner: "account",
    message: ({ version }) => {
      const { chat, from, text } = version.content as { chat: string; from: string; text: string };
      return { chat, from: from === "me" ? { id: "me", kind: "me" } : { id: from, kind: "network" }, text, parts: [], forwarded: false, edited: false, withdrawn: false, reply_to: null };
    },
    group: (chat) => chat.startsWith("g"),
    members: (chat) => chat.startsWith("g") ? [] : [{ id: chat, kind: "network" }],
    labels: { kinds: ["names"] },
    label: ({ version }) => ({ names: (version.content as { names: [string, string][] }).names }),
    labelText: ({ version }) => {
      const { names } = version.content as { names: [string, string][] };
      return { title: names[0]![1], who: names.map(([id]) => id) };
    },
  },
};
const OWNER = "1000000001";
const source = (product: string, account: string): SourceRow => ({
  id: `${product}:${account}:export`, product, account, copy: "export", vendor: "example", connector: product, options: {}, read_through_ms: null, added_ms: 0,
});
const NET_C = source("net-c", OWNER);
const version = (kind: string, key: string, content: Json): Version => ({ id: `v-${key}`, kind, key, content, text: "", time: { start_ms: AT } } as Version);
const holding = (rows: readonly SourceRow[]): View => ({
  sources: (selector: { product?: readonly string[] } = {}) => rows.filter((row) => selector.product?.includes(row.product) ?? true),
  source: (id: string) => rows.find((row) => row.id === id),
}) as unknown as View;

describe("a network of numeric user ids, through search, the owner's handles and the door's names", () => {
  const family = messagesFamily({ books: [] })([NUMERIC]);
  const text = (kind: string, key: string, content: Json) => family.text!.of({ source: NET_C.id, kind, key }, version(kind, key, content), undefined as never, holding([NET_C]));

  it("N5: a message's people and a label record's ids are the network's handles in search, never a phone, never bent", () => {
    expect(text("msg", "1000000002:m1", { chat: "1000000002", from: "1000000002", text: "synthetic hello" })).toEqual({ text: "synthetic hello", who: ["net-c:1000000002"] });
    expect(text("msg", "1000000002:m2", { chat: "1000000002", from: "me", text: "synthetic reply" })).toEqual({ text: "synthetic reply", who: ["net-c:1000000002"] });
    expect(text("msg", "g900:m3", { chat: "g900", from: "@Person.B:Example.org", text: "synthetic group words" })).toEqual({ text: "synthetic group words", who: ["net-c:@Person.B:Example.org"] });
    expect(text("names", "1000000002", { names: [["1000000002", "Person B"], ["g900", "Group Nine"]] })).toEqual({ title: "Person B", text: "", who: ["net-c:1000000002"] });
    const built = buildLabels({ people: [], networks: networksOf([NUMERIC]), places: [], providers: [["net-c", new Map([["1000000002", { name: "Person B" }]])]] });
    expect(personHandles(built.table, "net-c:1000000002")).toEqual(["net-c:1000000002"]);
  });

  it("N5b: a message as it reads names its sender (the owner's own message null, the person) and whom it went to, never a sender by order", () => {
    const read = (key: string, content: Json) => family.read!.of({ source: NET_C.id, kind: "msg", key }, version("msg", key, content), undefined as never, holding([NET_C]));
    expect(read("1000000002:r1", { chat: "1000000002", from: "1000000002", text: "synthetic hello" })).toEqual({ text: "synthetic hello", from: "net-c:1000000002" });
    expect(read("1000000002:r2", { chat: "1000000002", from: "me", text: "synthetic reply" })).toEqual({ text: "synthetic reply", from: null, to: ["net-c:1000000002"] });
    expect(read("g900:r3", { chat: "g900", from: "@Person.B:Example.org", text: "synthetic group words" })).toEqual({ text: "synthetic group words", from: "net-c:@Person.B:Example.org" });
  });

  it("N6: the owner's numeric account on a network is You's handle on that network, and no calling code", () => {
    const [whatsapp, imessage] = (["whatsapp", "imessage"] as const).map((product) => FED.messages.find((each) => each.product === product)!);
    const networks = networksOf([NUMERIC, whatsapp!, imessage!]);
    const rows = [NET_C, source("whatsapp", "15550000000"), source("whatsapp", "+15550000009"), source("imessage", "+15550000003"),
      source("imessage", "15550000004"), source("imessage", "Person-A@Example.com"), source("imessage", "local"), source("gmail", "person-a@example.com")];
    expect(ownHandles(holding(rows), ["gmail", "imessage", "net-c", "whatsapp"], networks)).toEqual([
      { kind: "network", value: "net-c:1000000001", product: "net-c" },
      { kind: "phone", value: "+15550000000", product: "whatsapp" },
      { kind: "phone", value: "+15550000009", product: "whatsapp" },
      { kind: "phone", value: "+15550000003", product: "imessage" },
      { kind: "phone", value: "+15550000004", product: "imessage" },
      { kind: "email", value: "person-a@example.com", product: "imessage" },
      { kind: "email", value: "person-a@example.com", product: "gmail" },
    ]);
    const own: Given<MessagesAdapter> = { ...NUMERIC, adapter: { ...NUMERIC.adapter, self: (account) => account } };
    expect(ownCountry(holding([NET_C]), networksOf([own]))).toBeNull();
    expect(ownCountry(holding([NET_C, source("whatsapp", "915550000000")]), networksOf([own, whatsapp!]))).toBe("91");
    expect(ownCountry(holding([source("imessage", "915550000000")]), networksOf([imessage!]))).toBe("91");
    expect(ownCountry(holding([source("imessage", "person-a@example.com")]), networksOf([imessage!]))).toBeNull();
  });

  it("N7: a network's party asked by its handle's id is served the name its day's line prints", () => {
    const built = labels();
    for (const id of ["123456789", "user-a1", "unknown-c1"]) {
      const line = nameId(id, built, "network", "net-a");
      expect(resolvedName(`net-a:${id}`, built, NETWORKS)).toEqual([`net-a:${id}`, line.name, line.by, line.person]);
    }
    expect(resolvedName("net-a:123456789", built, NETWORKS)).toEqual(["net-a:123456789", "Push Name B", "push-name", null]);
    expect(resolvedName("net-z:123456789", built, NETWORKS)[1]).toBe("net-z:123456789");
  });
});
