import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { openHomeFolder, type HomeFolder, type Json } from "@lifestreamprotocol/core";
import { openLedger, type Ledger } from "@lifestreamprotocol/model";
import { defaultAccess, fullAccess, reachesOf, type Existing } from "./access.js";
import { moveAccess, settleAccess } from "./access-move.js";
import { mintPrincipal, readPrincipals, revokePrincipal, writePrincipals } from "./principals.js";
import { cleanup, makeHome, NOW_MS } from "./test/support.js";

const roots: string[] = [];
afterAll(() => cleanup(roots));

const EXISTING: Existing[] = [
  { account: "gmail:person-a@example.com", category: "mail" },
  { account: "whatsapp:+15550000001", category: "messages" },
  { account: "health:local", category: "health" },
];

function folder() {
  const home = makeHome({ reader: { scopes: ["read"] } }, roots);
  const principals = openHomeFolder(home.root);
  const ledger = openLedger(principals, { mode: "migrate" });
  onTestFinished(() => ledger.close());
  const settle = () => settleAccess({ folder: principals, access: ledger.access, existing: () => EXISTING, now_ms: NOW_MS });
  return { root: home.root, principals, ledger, settle };
}

function agentRow(principals: HomeFolder, name: string, agent: Record<string, Json> = {}) {
  return mintPrincipal(principals, {
    unit: "agent", kind: "agent", scopes: ["read"], now_ms: NOW_MS,
    granted: { agent: { name, via: "pass", from: null, checked: false, client_id: null, resource: null, ...agent } as never },
  }).principal.id;
}

function rowsOf(ledger: Ledger, readers: readonly string[]): { reader: string; what: string; by: string; version: number; device: string | null }[] {
  return readers.flatMap((reader) => ledger.access.changes(reader, { limit: 100 })).sort((a, b) => a.seq - b.seq)
    .map(({ reader, what, by, version, device }) => ({ reader, what, by, version, device }));
}

const hideOf = (ledger: Ledger, reader: string) => (ledger.access.get(reader)?.lines as { hide: unknown } | undefined)?.hide;

describe("the move to accesses", () => {
  it("gives each live agent and Chat a full access at its level, once; keeps anywhere and every member it does not know; a second start writes nothing", () => {
    const { principals, ledger, settle } = folder();
    const all = agentRow(principals, "Hermes", { level: "all" });
    const list = agentRow(principals, "Claude", { level: ["number.bank", "secret"], future: { kept: true } });
    const none = agentRow(principals, "Instinct");
    const open = agentRow(principals, "ChatGPT", { level: "none", anywhere: true });
    const broken = agentRow(principals, "Odd", { level: "Names" });
    const gone = agentRow(principals, "Gone", { level: "none" });
    revokePrincipal(principals, gone, NOW_MS);
    const suspended = agentRow(principals, "Resting", { level: "names" });
    const file = readPrincipals(principals);
    writePrincipals(principals, { ...file, principals: file.principals.map((row) => row.id === suspended ? { ...row, suspended_at: new Date(NOW_MS).toISOString() } : row) });

    const first = settle();
    expect(first).toEqual({ moved: true, removed: [] });
    expect(ledger.access.moved()).toBe(NOW_MS);
    expect(Object.fromEntries(ledger.access.all().map((each) => [each.reader, each.lines]))).toEqual({
      [all]: fullAccess("all"), [list]: fullAccess(["number.bank", "secret"]), [none]: fullAccess("names"), [open]: fullAccess("none"),
      [broken]: fullAccess("all"), [suspended]: fullAccess("names"), ask: fullAccess("none"),
    });
    expect(ledger.access.get("ask")!.covers).toEqual(EXISTING.map(({ account }) => account).sort());
    expect(rowsOf(ledger, [all, list, none, open, broken, suspended, "ask"]).every((row) => row.what === "granted" && row.by === "home" && row.version === 1)).toBe(true);
    const after = readPrincipals(principals).principals;
    expect(after.every((row) => row.agent === undefined || !Object.hasOwn(row.agent, "level"))).toBe(true);
    expect(after.find((row) => row.id === open)!.agent).toMatchObject({ name: "ChatGPT", anywhere: true });
    expect(after.find((row) => row.id === list)!.agent).toMatchObject({ name: "Claude", future: { kept: true } });
    expect(after.find((row) => row.id === suspended)!.suspended_at).not.toBeNull();

    const rows = rowsOf(ledger, [all, list, none, open, broken, suspended, "ask"]).length;
    expect(settle()).toEqual({ moved: false, removed: [] });
    expect(rowsOf(ledger, [all, list, none, open, broken, suspended, "ask"])).toHaveLength(rows);
    expect(ledger.access.get(gone)).toBeUndefined();
  });

  it("stopped inside its transaction leaves no access and no mark, and the next start makes it whole; stopped after the mark, the next start writes no access", () => {
    const { root, principals, ledger, settle } = folder();
    const hermes = agentRow(principals, "Hermes", { level: "none" });
    const sqlite = new Database(join(root, "replies", "replies.db"));
    sqlite.exec("CREATE TRIGGER failpoint BEFORE INSERT ON access_moved BEGIN SELECT RAISE(ABORT, 'failpoint'); END;");
    expect(() => settle()).toThrow(/failpoint/u);
    expect(ledger.access.all()).toEqual([]);
    expect(ledger.access.moved()).toBeNull();
    expect(readPrincipals(principals).principals.find((row) => row.id === hermes)!.agent).toHaveProperty("level", "none");
    sqlite.exec("DROP TRIGGER failpoint");
    sqlite.close();
    expect(settle()).toMatchObject({ moved: true });
    expect(hideOf(ledger, hermes)).toBe("none");
    expect(hideOf(ledger, "ask")).toBe("none");

    const second = folder();
    const claude = agentRow(second.principals, "Claude", { level: "all" });
    expect(moveAccess({ folder: second.principals, access: second.ledger.access, existing: () => EXISTING, now_ms: NOW_MS })).toBe(true);
    expect(readPrincipals(second.principals).principals.find((row) => row.id === claude)!.agent).toHaveProperty("level", "all");
    const rows = rowsOf(second.ledger, [claude, "ask"]);
    expect(second.settle()).toEqual({ moved: false, removed: [] });
    expect(rowsOf(second.ledger, [claude, "ask"])).toEqual(rows);
    expect(readPrincipals(second.principals).principals.find((row) => row.id === claude)!.agent).not.toHaveProperty("level");
  });
});

describe("an access no pass can use", () => {
  it("goes at the next start, with its row by the home: a reader with no pass, a revoked pass; Chat and a live pass keep theirs", () => {
    const at = folder();
    const kept = agentRow(at.principals, "Hermes");
    const revoked = agentRow(at.principals, "Claude");
    at.settle();
    revokePrincipal(at.principals, revoked, NOW_MS);
    at.ledger.access.change("p-0000dead", { from: 0, what: "granted", lines: defaultAccess() as unknown as Json, covers: [] }, { at_ms: NOW_MS, by: "person", device: null });
    expect(at.settle()).toEqual({ moved: false, removed: [revoked, "p-0000dead"].sort() });
    expect(at.ledger.access.all().map((each) => each.reader).sort()).toEqual(["ask", kept].sort());
    expect(rowsOf(at.ledger, [revoked, "p-0000dead"]).filter((row) => row.what === "removed").map(({ reader, by }) => ({ reader, by })).sort((a, b) => a.reader.localeCompare(b.reader)))
      .toEqual([{ reader: revoked, by: "home" }, { reader: "p-0000dead", by: "home" }].sort((a, b) => a.reader.localeCompare(b.reader)));
    const bare = agentRow(at.principals, "Bare");
    expect(at.settle()).toEqual({ moved: false, removed: [] });
    expect(at.ledger.access.get(bare)).toBeUndefined();
  });
});

describe("what an access reaches", () => {
  it("covers every account but the categories an allow leaves out; a category, its accounts but those it leaves out; an account itself; an ended allow nothing", () => {
    expect(reachesOf(fullAccess("names"), EXISTING, NOW_MS)).toEqual(["gmail:person-a@example.com", "health:local", "whatsapp:+15550000001"]);
    expect(reachesOf(defaultAccess(), [...EXISTING, { account: "plain:local", category: null }], NOW_MS)).toEqual(["gmail:person-a@example.com", "whatsapp:+15550000001"]);
    const lines = (reach: unknown, until_ms: number | null = null) => ({ ...defaultAccess(), allow: [{ reach, window: null, until_ms }] }) as ReturnType<typeof defaultAccess>;
    expect(reachesOf(lines({ type: "messages", but: [] }), EXISTING, NOW_MS)).toEqual(["whatsapp:+15550000001"]);
    expect(reachesOf(lines({ type: "messages", but: ["whatsapp:+15550000001"] }), EXISTING, NOW_MS)).toEqual([]);
    expect(reachesOf(lines({ account: "health:local", but: [] }), EXISTING, NOW_MS)).toEqual(["health:local"]);
    expect(reachesOf(lines({ account: "health:local", but: [] }, NOW_MS), EXISTING, NOW_MS)).toEqual([]);
  });
});
