import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { declarations, vendorOf } from "@lifestreamprotocol/connect";
import { openHome, openHomeFolder, type Adapters, type Json } from "@lifestreamprotocol/core";
import { messagesFamily, type Family } from "@lifestreamprotocol/families";
import { HomeFile } from "./home-file.js";
import { openReads, type Reply } from "./reads.js";
import { Refusal } from "./refusal.js";
import { lastGood } from "./settings.js";
import { RELEASE_FED } from "./test/fed.js";
import { makeRoot, removeRoot } from "./test/harness-root.js";

const ACCOUNT = "person-a@example.com";
const GMAIL = `gmail:${ACCOUNT}:cloud`;
const CHATGPT = `chatgpt:${ACCOUNT}:browser`;
const NOTES = "apple-notes:local:macbook-pro-0001";
const MESSAGE = "1789000000000000001";
const roots: string[] = [];
afterAll(() => roots.forEach(removeRoot));

type Landed = readonly [id: string, connector: string, kind: string, key: string, content: Json];

function scratch(more: readonly Landed[] = []): string {
  const root = makeRoot("lifestream-open-in-", { sources: {} });
  roots.push(root);
  const db = openHome(openHomeFolder(root), "migrate");
  const object = (content: Json) => (typeof content === "object" && content !== null ? [] : ["not an object"]);
  db.commit((tx) => {
    const synthetic = { text: "synthetic" };
    const landed: Landed[] = [[GMAIL, "gmail-imap", "mailmsg", MESSAGE, synthetic], [CHATGPT, "chatgpt-browser", "msg", "conv-1:msg-2", synthetic], [NOTES, "notes-mac", "note", "n1", synthetic], ...more];
    for (const [id, connector, kind, key, content] of landed) {
      tx.tables.sources.add({ id, vendor: vendorOf(declarations(), id), connector, added_ms: 0 });
      const run = tx.tables.runs.start({ kind: "import", subject: id, started_ms: 0 });
      tx.records.land(run, { id: `${id}/1`, source: id, stated_ms: 1 }, [{ kind, key, content, time: { start_ms: 1, precision: "ms" as const } }],
        { [kind]: object }, { has: () => true });
    }
  });
  db.close();
  return root;
}

const MAIL: Pick<Family, "name" | "inputs"> = { name: "mail", inputs: [{ sources: { product: ["gmail"] }, kinds: ["mailmsg"], role: "evidence" }] };

function read(root: string, adapters?: Record<string, Adapters>) {
  const reads = openReads({
    folder: openHomeFolder(root), home: new HomeFile(openHomeFolder(root)), blobs: openHomeFolder(root).blobs(join(root, "blobs"), { reading: true }), settings: lastGood(root),
    registry: { families: [MAIL as Family, messagesFamily({ books: RELEASE_FED.labels })(RELEASE_FED.messages)], connectors: declarations(), readers: [], ...(adapters === undefined ? {} : { adapters }) },
  });
  return (path: string): { status: number; body: Record<string, any> } => {
    const route = reads.reply(new URL(path, "http://door").pathname)!;
    try {
      const reply = route({ url: path, now_ms: Date.now(), held: { machine: process.env.LIFESTREAM_MACHINE_DIR!, sites: [], present: [], refused: [], stated: {} } }) as Reply;
      return { status: reply.status, body: JSON.parse(typeof reply.body === "string" ? reply.body : Buffer.from(reply.body).toString("utf8")) };
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return { status: error.status, body: { code: error.code } };
    }
  };
}

describe("reads that name no product", () => {
  it("answer a record's page at its provider from its connector's open, and none where it declares none", () => {
    const get = read(scratch());
    const open = (source: string, kind: string, key: string) => get(`/v1/record?source=${encodeURIComponent(source)}&kind=${kind}&key=${encodeURIComponent(key)}`).body.open;
    expect(open(GMAIL, "mailmsg", MESSAGE)).toEqual({ label: "Open in Gmail", href: `https://mail.google.com/mail/?authuser=person-a%40example.com#all/${BigInt(MESSAGE).toString(16)}` });
    expect(open(CHATGPT, "msg", "conv-1:msg-2")).toEqual({ label: "Open in ChatGPT", href: "https://chatgpt.com/c/conv-1" });
    expect(open(NOTES, "note", "n1")).toBeNull();
  });

  it("answer a record's page its content states, filled from the record's version", () => {
    const github = "github:person-a:cloud";
    const page = "https://github.com/person-a/repo-one/pull/3#pullrequestreview-80001";
    const get = read(scratch([[github, "github-api", "review", "PRR_fake4", { type: "github.review", content: { html_url: page } }]]));
    expect(get(`/v1/record?source=${encodeURIComponent(github)}&kind=review&key=PRR_fake4`).body.open).toEqual({ label: "Open in GitHub", href: page });
  });

  it("answer a one-to-one chat's page, and none for a group", () => {
    const get = read(scratch());
    const chats = get(`/v1/labels?chat=${encodeURIComponent("whatsapp:15550000009@s.whatsapp.net")}&chat=${encodeURIComponent("whatsapp:120363000000000001@g.us")}`).body.chats;
    expect(chats.map((chat: unknown[]) => [chat[0], chat[2], chat[3]])).toEqual([
      ["whatsapp:15550000009@s.whatsapp.net", false, { label: "Open in WhatsApp", href: "https://wa.me/15550000009" }],
      ["whatsapp:120363000000000001@g.us", true, null],
    ]);
  });

  it("list a family's sources, each owner's marked where its adapter says so, and refuse a family the home does not read", () => {
    const root = scratch();
    const plain = read(root);
    expect(plain("/v1/sources?family=mail").body.sources.map((row: { id: string; owner?: true }) => [row.id, row.owner])).toEqual([[GMAIL, undefined]]);
    expect(plain("/v1/sources").body.sources.map((row: { id: string }) => row.id)).toEqual([CHATGPT, GMAIL, NOTES].sort());
    const refused = plain("/v1/sources?family=nothing");
    expect([refused.status, refused.body.code]).toEqual([422, "BAD_PARAMETER"]);
    const adapters = { gmail: { mail: { version: "1", kinds: ["mailmsg"], owner: "account", mail: () => null } } } as unknown as Record<string, Adapters>;
    expect(read(root, adapters)("/v1/sources").body.sources.map((row: { id: string; owner?: true }) => [row.id, row.owner ?? false])).toEqual([[NOTES, false], [CHATGPT, false], [GMAIL, true]]);
  });
});
