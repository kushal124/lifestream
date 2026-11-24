import { declarations, type Connector } from "@lifestreamprotocol/connect";
import { digest, type Adapters, type Json, type SourceRow } from "@lifestreamprotocol/core";
import { describe, expect, it } from "vitest";
import { chatOpen, filled, recordOpen } from "./open-in.js";
import { ownerOf, readsSource } from "./sources-read.js";
import type { Statement } from "./stated.js";
import { declaredStores, knownStoresSwift, storeNeeds, storeStateOf, storesIn } from "./stores.js";

const MAC = "macbook-pro-0001";
const AIR = "macbook-air-bb07";
const connector = (id: string): Connector => declarations().find((each) => each.id === id)!;
const statement = (stores: Statement["stores"]): Statement => ({
  pass: "synthetic-pass", grants: null, found: null, imports: null, settings: null, sending: {}, room: null, network: null, recorder: null, stores,
  heard_ms: 0, waiting_since_ms: null,
});
const nameOf = (unit: string) => (unit === MAC ? "MacBook Pro" : "MacBook Air");

describe("the declared stores", () => {
  it("are listed in KnownStores.swift by the digest of each connector's whole Mac block, sorted by id", () => {
    const { stores } = declaredStores(declarations());
    expect(Object.keys(stores)).toHaveLength(14);
    const swift = knownStoresSwift(declarations());
    const listed = [...swift.matchAll(/^ {8}"([a-z-]+)": "(sha256:[0-9a-f]{64})",$/gmu)].map(([, id, hash]) => [id, hash]);
    expect(listed).toEqual(Object.keys(stores).sort().map((id) => [id, digest(stores[id] as unknown as Json)]));
    expect(stores.imessage).toEqual({ app: "Messages", grants: ["fullDiskAccess"], product: "imessage", store: connector("imessage").mac!.store });
    expect(stores["claude-code"]).toEqual({ grants: [], product: "claude-code", store: connector("claude-code").mac!.store });
    expect(knownStoresSwift([])).toContain("public static let digests: [String: String] = [:]");
  });

  it("carry the product of the store's `mac` source, which need not be its connector's id", () => {
    const notes = connector("apple-notes");
    const importer: Connector = { ...notes, id: "example-importer", product: "example-importer",
      sources: [{ id: "example-notes:local:<unit>", read: notes.sources[0]!.read, arrives: "mac" }] };
    const { stores } = declaredStores([importer]);
    expect(Object.keys(stores)).toEqual(["example-importer"]);
    expect(stores["example-importer"]!.product).toBe("example-notes");
  });

  it("ask the person on each Mac that waits on an Allow or was refused one, and say a store the Mac refused as unsafe is broken", () => {
    const imessage = connector("imessage");
    const macs = [
      { unit: MAC, own: statement({ digest: null, states: { imessage: "asked", chrome: "allowed" } }) },
      { unit: AIR, own: statement({ digest: null, states: { imessage: "refused" } }) },
    ];
    expect(storeNeeds(imessage, "iMessage", macs, () => false, nameOf)).toEqual([
      expect.objectContaining({ id: `grant:store:imessage:${MAC}`, state: "needs-you", reason: "grant", words: "Allow iMessage on MacBook Pro", unit: MAC,
        streams: ["imessage"], acts: [{ do: "grant", label: "Allow", unit: MAC, grant: "store:imessage" }] }),
      expect.objectContaining({ id: `grant:store:imessage:${AIR}`, words: "Allow iMessage on MacBook Air", acts: [{ do: "grant", label: "Allow", unit: AIR, grant: "store:imessage" }] }),
    ]);
    expect(storeNeeds(imessage, "iMessage", macs, (unit) => unit === AIR, nameOf).map((need) => need.unit)).toEqual([MAC]);
    expect(storeNeeds(connector("chrome"), "Chrome", macs, () => false, nameOf)).toEqual([]);
    const unsafe = storeNeeds(imessage, "iMessage", [{ unit: MAC, own: statement({ digest: null, states: { imessage: "unsafe" } }) }], () => false, nameOf);
    expect(unsafe).toEqual([expect.objectContaining({ id: `store:imessage:${MAC}`, state: "broken", reason: "failing", acts: [], words: "MacBook Pro can’t read iMessage" })]);
    expect(storeNeeds(connector("screen"), "Screen", [{ unit: MAC, own: statement({ digest: null, states: { screen: "asked" } }) }], () => false, nameOf)).toEqual([]);
    expect([storeStateOf(macs[0]!.own, "chrome"), storeStateOf(macs[1]!.own, "chrome"), storeStateOf(undefined, "chrome")]).toEqual(["allowed", null, null]);
  });

  it("are stated in a body only as a digest and each store's state", () => {
    expect(storesIn(undefined)).toBeUndefined();
    expect(storesIn({ digest: null, states: { imessage: "asked" } })).toEqual({ digest: null, states: { imessage: "asked" } });
    expect(storesIn({ digest: `sha256:${"a".repeat(64)}`, states: {} })).toEqual({ digest: `sha256:${"a".repeat(64)}`, states: {} });
    for (const bad of [{ digest: "abc", states: {} }, { states: {} }, { digest: null, states: { imessage: "later" } }, { digest: null, states: [] }]) {
      expect(() => storesIn(bad)).toThrow(/stores states digest/u);
    }
  });
});

describe("Open in", () => {
  const gmail = connector("gmail");
  it("links a Gmail message by its X-GM-MSGID in hex in its account, and a conversation by the part of its key before :", () => {
    expect(recordOpen(gmail, "mailmsg", { account: "person-a@example.com", key: "1789000000000000001" })).toEqual({
      label: "Open in Gmail", href: `https://mail.google.com/mail/?authuser=person-a%40example.com#all/${(1789000000000000001n).toString(16)}`,
    });
    expect(recordOpen(connector("chatgpt"), "msg", { account: "person-a@example.com", key: "conv-1:msg-2" })).toEqual({ label: "Open in ChatGPT", href: "https://chatgpt.com/c/conv-1" });
    expect(recordOpen(connector("claude"), "chat", { account: "person-a@example.com", key: "conv-3" })).toEqual({ label: "Open in Claude", href: "https://claude.ai/chat/conv-3" });
  });

  it("answers none for a kind the template does not name, a connector with none, a value it cannot take, or a group", () => {
    expect(recordOpen(gmail, "label", { account: "person-a@example.com", key: "17" })).toBeNull();
    expect(recordOpen(gmail, "mailmsg", { account: "person-a@example.com", key: "not-a-number" })).toBeNull();
    expect(recordOpen(gmail, "mailmsg", { account: null, key: "17" })).toBeNull();
    expect(recordOpen(connector("screen"), "frame", { account: "local", key: "1" })).toBeNull();
    expect(recordOpen(undefined, "msg", { account: null, key: "1" })).toBeNull();
    expect(chatOpen(connector("whatsapp"), "15550000001@s.whatsapp.net", false)).toEqual({ label: "Open in WhatsApp", href: "https://wa.me/15550000001" });
    expect(chatOpen(connector("whatsapp"), "120363000000000001@g.us", true)).toBeNull();
    expect(chatOpen(connector("imessage"), "person-a@example.com", false)).toEqual({ label: "Open in iMessage", href: "imessage:person-a%40example.com" });
    expect(chatOpen(connector("gmail"), "thread", false)).toBeNull();
  });

  it("links a GitHub record of every kind by the page its content states", () => {
    const github = connector("github");
    const at = (kind: string, html_url: string) => recordOpen(github, kind, { account: "person-a", key: "N_fake1", content: { type: `github.${kind}`, content: { html_url } } });
    for (const [kind, page] of [
      ["commit", "https://github.com/person-a/repo-one/commit/abcdef0123"], ["pr", "https://github.com/person-a/repo-one/pull/3"],
      ["issue", "https://github.com/person-a/repo-one/issues/1"], ["review", "https://github.com/person-a/repo-one/pull/3#pullrequestreview-80001"],
      ["comment", "https://github.com/person-a/repo-one/issues/1#issuecomment-70001"],
    ] as const) expect(at(kind, page)).toEqual({ label: "Open in GitHub", href: page });
    expect(recordOpen(github, "issue", { account: "person-a", key: "N_fake1", content: { type: "github.issue", content: {} } })).toBeNull();
    expect(recordOpen(github, "issue", { account: "person-a", key: "N_fake1" })).toBeNull();
    expect(at("issue", "javascript:alert(1)")).toBeNull();
  });

  it("percent-encodes each value and fills each filter", () => {
    expect(filled("https://example.com/{key}", { key: "a/b#c d" })).toBe("https://example.com/a%2Fb%23c%20d");
    expect(filled("https://example.com/{key|after::}", { key: "conv:msg" })).toBe("https://example.com/msg");
    expect(filled("https://example.com/{key|before:@}", { key: "nothing-to-cut" })).toBe("https://example.com/nothing-to-cut");
    expect(filled("https://example.com/{key|hex}", { key: "255" })).toBe("https://example.com/ff");
    expect(filled("https://example.com/{content.repo.name}/{content.number}", { content: { repo: { name: "a/b" }, number: 7 } })).toBe("https://example.com/a%2Fb/7");
    expect(filled("https://example.com/{content.number|hex}", { content: { number: 255 } })).toBe("https://example.com/ff");
    expect(filled("https://example.com/{content.repo}", { content: { repo: { name: "a" } } })).toBeNull();
    expect(filled("{content.url|before:#}", { content: { url: "https://example.com/a/b#c" } })).toBe("https://example.com/a/b");
    expect(filled("{content.url}", { content: { url: "http://example.com/a" } })).toBeNull();
    expect(filled("{content.url}", { content: { url: "https://github.com@evil.example/" } })).toBeNull();
    expect(filled("{content.url}", { content: { url: "\nhttps://example.com/a" } })).toBe("https://example.com/a");
    expect(filled("https://example.com/{key|after:🔗}", { key: "a🔗b" })).toBe("https://example.com/b");
  });
});

describe("a source's family and owner", () => {
  const row = (id: string, connector: string): SourceRow => {
    const [product, account, copy] = id.split(":") as [string, string, string];
    return { id, product, vendor: "example", account, copy, connector, options: {}, read_through_ms: null, added_ms: 0 };
  };
  const mail = row("gmail:person-a@example.com:cloud", "gmail-imap");
  const notes = row("apple-notes:local:macbook-pro-0001", "notes-mac");

  it("is the family whose evidence inputs read it", () => {
    const family = { inputs: [{ sources: { product: ["gmail"] }, kinds: ["mailmsg"], role: "evidence" as const }, { sources: {}, kinds: ["label"], role: "labels" as const }] };
    expect([readsSource(family, mail), readsSource(family, notes)]).toEqual([true, false]);
  });

  it("is the owner's where its connector's adapter declares the account its own, and nowhere with no adapters held", () => {
    const adapters = { gmail: { mail: { version: "1", kinds: ["mailmsg"], owner: "account", mail: () => null } } } as unknown as Record<string, Adapters>;
    const owner = ownerOf({ connectors: declarations(), adapters });
    expect([owner(mail), owner(notes)]).toEqual([true, false]);
    expect(ownerOf({ connectors: declarations() })(mail)).toBe(false);
  });
});
