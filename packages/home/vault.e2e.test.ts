import { createCipheriv, randomBytes } from "node:crypto";
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { homeSecrets, keyId, type JsonObject } from "@lifestreamprotocol/core";
import { runCli } from "./cli.js";
import { startHome, type Home } from "./home.js";
import { machine, type Machine } from "./machine.js";
import { ask, type HomeSocket } from "./socket.js";
import { artifact, ChildHome, FAKES, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { statusOf } from "./test/harness-status.js";
import { Refusal } from "./refusal.js";
import { readOpsSettings } from "./verbs/index.js";
import { openWith, readVault, recoveryKey, type Slot, type VaultFile } from "./vault.js";
import { testSocket } from "./test/folder.js";


const PASSWORD = "x.password";
const VALUE = "fake-password-correct-horse";
const temps: string[] = [];
const temp = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};

function testMachine(options: { macApp?: boolean; tpm?: boolean } = {}): Machine {
  const user = temp("lifestream-vault-user-");
  const system = temp("lifestream-vault-system-");
  if (options.macApp === true) mkdirSync(join(user, "Applications", "Lifestream.app"), { recursive: true });
  if (options.tpm !== undefined) {
    mkdirSync(join(system, "usr", "bin"), { recursive: true });
    const tool = join(system, "usr", "bin", "systemd-creds");
    writeFileSync(tool, [
      "#!/bin/sh",
      `if [ "$1" = has-tpm2 ]; then ${options.tpm ? "exit 0" : "echo 'partial: no TPM2'; exit 1"}; fi`,
      'if [ "$1" = encrypt ]; then echo encrypt >> "$0.calls"; cat; exit 0; fi',
      'if [ "$1" = decrypt ]; then cat "$3"; exit 0; fi',
      "exit 64",
    ].join("\n"));
    chmodSync(tool, 0o755);
  }
  return machine({ env: { LIFESTREAM_MACHINE_DIR: temp("lifestream-vault-machine-") }, home: user, system });
}

async function startReading(credentials: string | undefined, start: () => Promise<Home>): Promise<Home> {
  const before = process.env.CREDENTIALS_DIRECTORY;
  if (credentials === undefined) delete process.env.CREDENTIALS_DIRECTORY;
  else process.env.CREDENTIALS_DIRECTORY = credentials;
  try {
    return await start();
  } finally {
    if (before === undefined) delete process.env.CREDENTIALS_DIRECTORY;
    else process.env.CREDENTIALS_DIRECTORY = before;
  }
}

const b64 = (bytes: Buffer) => bytes.toString("base64");
const secretsOf = (root: string, key?: Buffer) => {
  mkdirSync(join(root, "config", "secrets"), { recursive: true, mode: 0o700 });
  return homeSecrets(join(root, "config", "secrets"), key === undefined ? {} : { key });
};
const vaultOf = (root: string) => JSON.parse(readFileSync(join(root, "config", "vault.json"), "utf8")) as VaultFile;
const unconfirmedSlot = (vault: VaultFile): Slot => vault.slots.find((each) => each.kind === "recovery" && each.confirmed_ms === undefined)!;
const plant = (root: string, name: string, text: string) => {
  mkdirSync(join(root, "config", "secrets"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, "config", "secrets", name), text, { mode: 0o600 });
};
const spellings = (key: Buffer) => [key.toString("latin1"), key.toString("base64"), key.toString("hex"), key.toString("base64url"), recoveryKey.text(key).replace(/ /gu, "")];
function filesUnder(dir: string): Record<string, string> {
  const found: Record<string, string> = {};
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.parentPath.endsWith("/artifacts")) continue;
    const path = join(entry.parentPath, entry.name);
    found[path] = readFileSync(path).toString("latin1");
  }
  return found;
}
function leaks(where: Record<string, string>, keys: Buffer[]): string[] {
  const found: string[] = [];
  for (const [place, text] of Object.entries(where)) for (const key of keys) for (const spelling of spellings(key)) if (text.includes(spelling)) found.push(place);
  return found;
}
async function answerDropped(sock: HomeSocket, verb: string): Promise<{ taken: unknown[]; close(): Promise<void> }> {
  const real = { ...sock, path: `${sock.path}.real` };
  renameSync(sock.path, real.path);
  const taken: unknown[] = [];
  const server = createServer((socket) => {
    socket.on("error", () => undefined);
    createInterface({ input: socket }).once("line", (line) => {
      const request = JSON.parse(line) as JsonObject;
      void ask(real, request).then((result) => {
        if (request.verb !== verb) return socket.end(`${JSON.stringify({ result })}\n`);
        taken.push(result);
        return socket.destroy();
      }, (error: Error) => socket.end(`${JSON.stringify(error instanceof Refusal
        ? { error: error.words, refusal: { status: error.status, code: error.code, words: error.words, extra: error.extra } }
        : { error: error.message })}\n`));
    });
  });
  await new Promise<void>((done) => server.listen(sock.path, done));
  return {
    taken,
    close: () => new Promise<void>((done) => server.close(() => {
      renameSync(real.path, sock.path);
      done();
    })),
  };
}

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return (error as Error).message;
  }
  return "answered";
}

afterAll(() => {
  if (process.env.LIFESTREAM_KEEP_ARTIFACTS !== "1") for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("vault: a fresh home made from the Mac app's window, restarted, copied and restored", () => {
  let root: string;
  let sock: HomeSocket;
  const at = testMachine({ macApp: true });
  const elsewhere = testMachine({ macApp: true });
  const logs: string[] = [];
  const seen: Record<string, unknown> = {};
  const slot = randomBytes(32);
  const otherSlot = randomBytes(32);
  const newMachineSlot = randomBytes(32);
  let recovery = "";
  let vaultKey: Buffer;
  let copy: string;

  const start = (where: string, slotKey: Buffer | null, on: Machine = at) =>
    startHome(where, { stopGraceMs: 50, registry: FAKES, machine: on, slot: slotKey, log: (line) => logs.push(line), tickMs: TICK_MS });

  beforeAll(async () => {
    root = makeRoot("lifestream-vault-fresh-", { sources: { "apple-notes:local:mac-0001": "fake-rows" } });
    sock = testSocket(root, at.dir);
    let home: Home = await start(root, null);
    try {
      seen.before = await ask(sock, { verb: "vault" });
      seen.sealLocked = await refusal(ask(sock, { verb: "seal", secret: PASSWORD, value: VALUE }));
      seen.confirmEarly = await refusal(ask(sock, { verb: "vault-confirm", recovery: recoveryKey.text(randomBytes(32)) }));
      seen.init = await ask(sock, { verb: "vault-init", slot_key: b64(slot), store: "keychain-login", unit: "macbook-pro-0001" });
      recovery = (seen.init as { recovery: string }).recovery;
      seen.initAgain = await refusal(ask(sock, { verb: "vault-init", slot_key: b64(otherSlot), store: "keychain-login" }));
      seen.afterInit = await ask(sock, { verb: "vault" });
      seen.vaultUnconfirmed = vaultOf(root);
      seen.confirmWrong = await refusal(ask(sock, { verb: "vault-confirm", recovery: recoveryKey.text(randomBytes(32)) }));
      seen.confirmGarbled = await refusal(ask(sock, { verb: "vault-confirm", recovery: `${recovery.slice(0, -1)}${recovery.endsWith("A") ? "B" : "A"}` }));
      seen.stillUnconfirmed = vaultOf(root);
      seen.confirm = await ask(sock, { verb: "vault-confirm", recovery: recovery.toLowerCase().replace(/ /gu, "-") });
      seen.sealed = await ask(sock, { verb: "seal", secret: PASSWORD, value: VALUE });
      plant(root, "typed-by-hand", "fake-token-typed\n");
    } finally {
      await home.stop();
    }
    vaultKey = openWith(vaultOf(root), "recovery", recoveryKey.parse(recovery))!.key;
    seen.vaultConfirmed = vaultOf(root);

    home = await start(root, slot);
    try {
      seen.restarted = await ask(sock, { verb: "vault" });
      seen.unlockOther = await refusal(ask(sock, { verb: "unlock", slot_key: b64(otherSlot) }));
      seen.unlockSame = await ask(sock, { verb: "unlock", slot_key: b64(slot) });
    } finally {
      await home.stop();
    }

    home = await start(root, otherSlot);
    try {
      seen.otherStart = await ask(sock, { verb: "vault" });
      seen.unlockRefused = await refusal(ask(sock, { verb: "unlock", slot_key: b64(otherSlot) }));
      seen.unlocked = await ask(sock, { verb: "unlock", slot_key: b64(slot) });
      seen.afterUnlock = await ask(sock, { verb: "vault" });
    } finally {
      await home.stop();
    }

    const good = readFileSync(join(root, "config", "vault.json"), "utf8");
    const edited = (edit: (vault: VaultFile) => void) => {
      const vault = JSON.parse(good) as VaultFile;
      edit(vault);
      writeFileSync(join(root, "config", "vault.json"), JSON.stringify(vault));
    };
    edited((vault) => { vault.slots.find((each) => each.kind === "machine")!.id = "m-00000000"; });
    home = await start(root, slot);
    seen.renamedSlot = await ask(sock, { verb: "vault" });
    await home.stop();
    edited((vault) => { vault.key_id = keyId(otherSlot); });
    home = await start(root, slot);
    seen.repointed = await ask(sock, { verb: "vault" });
    await home.stop();
    edited((vault) => {
      const planted = randomBytes(32);
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", otherSlot, nonce);
      const id = `m-${keyId(otherSlot)}`;
      cipher.setAAD(Buffer.from(`lifestream-vault:v1:${id}:${vault.key_id}`));
      const body = Buffer.concat([cipher.update(planted), cipher.final()]);
      vault.slots.push({ id, kind: "machine", store: "keychain-login", made_ms: 0, wrapped: Buffer.concat([nonce, body, cipher.getAuthTag()]).toString("base64") });
    });
    home = await start(root, otherSlot);
    seen.plantedKey = await ask(sock, { verb: "vault" });
    await home.stop();
    writeFileSync(join(root, "config", "vault.json"), good, { mode: 0o600 });

    copy = temp("lifestream-vault-copy-");
    cpSync(root, copy, { recursive: true, filter: (path) => !path.endsWith("home.lock") });
    home = await start(copy, null, elsewhere);
    try {
      seen.copied = await ask(testSocket(copy, elsewhere.dir), { verb: "vault" });
      seen.recoverWrong = await refusal(ask(testSocket(copy, elsewhere.dir), { verb: "recover", recovery: recoveryKey.text(randomBytes(32)) }));
      seen.recovered = await ask(testSocket(copy, elsewhere.dir), { verb: "recover", recovery, slot_key: b64(newMachineSlot), store: "keychain-login", unit: "macbook-air-bb01" });
      seen.copiedAfter = await ask(testSocket(copy, elsewhere.dir), { verb: "vault" });
    } finally {
      await home.stop();
    }
    home = await start(copy, newMachineSlot, elsewhere);
    seen.copiedRestart = await ask(testSocket(copy, elsewhere.dir), { verb: "vault" });
    await home.stop();

    artifact(root, "vault-fresh", { ...seen, logs: logs.map((line) => JSON.parse(line) as unknown) });
  });

  afterAll(() => {
    removeRoot(root);
  });

  it("a home with no vault takes a password, or a raw key from an old Mac app", () => {
    expect(seen.before).toMatchObject({ key_id: null, locked: true, migrate: null, recovery: "none", slots: [] });
    expect(seen.sealLocked).toContain("No vault yet: make your recovery key in the Lifestream app first");
    expect(seen.sealLocked).not.toMatch(/locked/iu);
    expect(existsSync(join(root, "config", "secrets", PASSWORD)) && !readFileSync(join(root, "config", "secrets", PASSWORD), "utf8").startsWith("lifestream-sealed:")).toBe(false);
  });

  it("vault.json is written loose, holds a key, or a second init replaces the vault", () => {
    const file = seen.vaultConfirmed as VaultFile;
    expect(statSync(join(root, "config", "vault.json")).mode & 0o777).toBe(0o600);
    expect(file).toMatchObject({ version: 1, key_id: keyId(vaultKey) });
    expect(file.slots.map((each) => each.kind).sort()).toEqual(["machine", "recovery"]);
    expect(file.slots.find((each) => each.kind === "machine")).toMatchObject({ unit: "macbook-pro-0001", store: "keychain-login" });
    expect(seen.initAgain).toMatch(/a vault exists/u);
    expect(leaks({ vault: JSON.stringify(file) }, [vaultKey, slot])).toEqual([]);
  });

  it("vault-init answers other than the recovery slot vault.json holds, or when it was made", () => {
    const written = unconfirmedSlot(seen.vaultUnconfirmed as VaultFile);
    expect(seen.init).toMatchObject({ recovery_slot: written.id, made_ms: written.made_ms });
    expect(written.id).toBe("r-1");
  });

  it("a recovery key is marked confirmed without opening the vault", () => {
    expect(seen.afterInit).toMatchObject({ locked: false, recovery: "unconfirmed", opened: { by: "init" } });
    expect((seen.vaultUnconfirmed as VaultFile).slots.find((each) => each.kind === "recovery")!.confirmed_ms).toBeUndefined();
    expect(seen.confirmEarly).toMatch(/no vault/u);
    expect(seen.confirmWrong).toMatch(/That isn't the new recovery key: make a new key and save that one\./u);
    expect(seen.confirmGarbled).not.toBe("answered");
    expect((seen.stillUnconfirmed as VaultFile).slots.find((each) => each.kind === "recovery")!.confirmed_ms).toBeUndefined();
    expect(seen.confirm).toEqual({ confirmed: "r-1" });
    expect((seen.vaultConfirmed as VaultFile).slots.find((each) => each.kind === "recovery")!.confirmed_ms).toEqual(expect.any(Number));
  });

  it("a recovery key is not 52 base32 characters in groups of four", () => {
    expect(recovery).toMatch(/^([A-Z2-7]{4} ){12}[A-Z2-7]{4}$/u);
  });

  it("a plain item stays plain after a start that holds the key", () => {
    expect(seen.restarted).toMatchObject({ locked: false, opened: { by: "start" }, plain: [] });
    expect(readFileSync(join(root, "config", "secrets", "typed-by-hand"), "utf8").startsWith(`lifestream-sealed:v1:${keyId(vaultKey)}:`)).toBe(true);
    expect(secretsOf(root, vaultKey).get("typed-by-hand")).toBe("fake-token-typed");
    expect(secretsOf(root, vaultKey).get(PASSWORD)).toBe(VALUE);
    expect(seen.sealed).toEqual({ sealed: PASSWORD, key: keyId(vaultKey) });
  });

  it("the home opens with a key that is not its vault's, or a refusal changes anything", () => {
    expect(seen.unlockOther).toMatch(/^\[VAULT_KEY\] The key this Mac offered doesn't open Lifestream/u);
    expect(seen.unlockSame).toEqual({ key_id: keyId(vaultKey) });
    expect(seen.otherStart).toMatchObject({ locked: true, key_id: keyId(vaultKey) });
    expect(seen.unlockRefused).toMatch(/doesn't open Lifestream/u);
    expect(seen.unlocked).toEqual({ key_id: keyId(vaultKey) });
    expect(seen.afterUnlock).toMatchObject({ locked: false, opened: { by: "unlock" } });
    expect(seen.renamedSlot).toMatchObject({ locked: true });
    expect(seen.repointed).toMatchObject({ locked: true });
    expect(seen.plantedKey).toMatchObject({ locked: true });
  });

  it("a copied folder opens on another machine without the recovery key", () => {
    expect(seen.copied).toMatchObject({ locked: true, key_id: keyId(vaultKey) });
    expect(seen.recoverWrong).toMatch(/That isn't your recovery key/u);
    expect(seen.recovered).toMatchObject({ key_id: keyId(vaultKey), slot: `m-${keyId(newMachineSlot)}` });
    expect(seen.copiedAfter).toMatchObject({ locked: false, opened: { by: "recover" }, recovery: "confirmed" });
    expect(vaultOf(copy).slots.filter((each) => each.kind === "machine").map((each) => each.unit).sort()).toEqual(["macbook-air-bb01", "macbook-pro-0001"]);
    expect(seen.copiedRestart).toMatchObject({ locked: false, opened: { by: "start", slot: `m-${keyId(newMachineSlot)}` } });
  });

  it("the vault key, a slot key or the recovery key reaches a file of the folder, a log, an event or home.db", () => {
    const keys = [vaultKey, slot, otherSlot, newMachineSlot];
    const places = { ...filesUnder(root), ...filesUnder(copy), logs: logs.join("\n") };
    expect(leaks(places, keys)).toEqual([]);
    const recoveryPlain = recovery.replace(/ /gu, "");
    expect(Object.entries(places).filter(([, text]) => text.includes(recoveryPlain) || text.includes(recovery)).map(([place]) => place)).toEqual([]);
    const events = readHome(root, (db) => db.prepare("SELECT key FROM events WHERE kind = 'vault' ORDER BY seq").pluck().all());
    expect(events).toEqual(expect.arrayContaining(["init", "confirmed", "opened", "refused", "locked"]));
  });
});

describe("vault: today's home migrated (a Keychain key, items sealed by it and plain ones)", () => {
  let root: string;
  let sock: HomeSocket;
  const at = testMachine({ macApp: true });
  const old = randomBytes(32);
  const another = randomBytes(32);
  const slot = randomBytes(32);
  const seen: Record<string, unknown> = {};

  beforeAll(async () => {
    root = makeRoot("lifestream-vault-migrate-", { sources: {} });
    sock = testSocket(root, at.dir);
    secretsOf(root, old).set("google.password", "fake-password-google");
    secretsOf(root, old).set("meta.password", "fake-password-meta");
    plant(root, "lifestream-whoop-refresh-token", "fake-token-whoop\n");
    plant(root, "openrouter", "fake-key-openrouter");
    plant(root, "github", "fake-token-github\n");
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, machine: at, slot: null, log: () => undefined, tickMs: TICK_MS });
    try {
      chmodSync(join(root, "config", "secrets", "google.password"), 0o000);
      seen.unreadable = await ask(sock, { verb: "vault" });
      seen.unreadableInit = await refusal(ask(sock, { verb: "vault-init", key: b64(old) }));
      expect(seen.unreadableInit).toMatch(/cannot read.*google.password/u);
      expect(seen.unreadable).toMatchObject({ plain: ["github", "lifestream-whoop-refresh-token", "openrouter"], unreadable: expect.stringContaining("google.password") });
      chmodSync(join(root, "config", "secrets", "google.password"), 0o600);
      seen.before = await ask(sock, { verb: "vault" });
      seen.withAnother = await refusal(ask(sock, { verb: "vault-init", slot_key: b64(slot), store: "keychain-login", key: b64(another) }));
      seen.stillNone = existsSync(join(root, "config", "vault.json"));
      seen.init = await ask(sock, { verb: "vault-init", slot_key: b64(slot), store: "keychain-login", key: b64(old) });
      seen.unconfirmed = await ask(sock, { verb: "vault" });
      await ask(sock, { verb: "vault-confirm", recovery: (seen.init as { recovery: string }).recovery });
      seen.after = await ask(sock, { verb: "vault" });
    } finally {
      await home.stop();
    }
    artifact(root, "vault-migrate", seen);
  });

  afterAll(() => removeRoot(root));

  it("the old key is not the vault key, so the sealed items no longer open", () => {
    expect(seen.before).toMatchObject({ key_id: null, locked: true, migrate: { key_id: keyId(old) }, plain: ["github", "lifestream-whoop-refresh-token", "openrouter"] });
    expect(seen.init).toMatchObject({ key_id: keyId(old) });
    expect(secretsOf(root, old).get("google.password")).toBe("fake-password-google");
  });

  it("a vault is made from a key the folder is not sealed by", () => {
    expect(seen.withAnother).toMatch(/not the key/u);
    expect(seen.stillNone).toBe(false);
  });

  it("a plain item is sealed before the recovery key is confirmed, stays plain after, or loses its value", () => {
    expect(seen.unconfirmed).toMatchObject({ locked: false, plain: ["github", "lifestream-whoop-refresh-token", "openrouter"], recovery: "unconfirmed" });
    expect(seen.after).toMatchObject({ locked: false, plain: [], recovery: "confirmed" });
    expect(secretsOf(root).list()).toEqual(["github", "google.password", "lifestream-whoop-refresh-token", "meta.password", "openrouter"].map((name) => ({ name, sealed: keyId(old) })));
    expect(secretsOf(root, old).get("lifestream-whoop-refresh-token")).toBe("fake-token-whoop");
    expect(secretsOf(root, old).get("openrouter")).toBe("fake-key-openrouter");
  });
});

describe("vault: a folder whose items are sealed by a key no Mac holds any more", () => {
  const seen: Record<string, unknown> = {};
  const gone = randomBytes(32);
  let root: string;

  beforeAll(async () => {
    root = makeRoot("lifestream-vault-gone-", { sources: {} });
    secretsOf(root, gone).set("google.password", "fake-password-google");
    plant(root, "github", "fake-token-github\n");
    const on = testMachine({ macApp: true });
    const sock = testSocket(root, on.dir);
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, machine: on, slot: null, log: () => undefined, tickMs: TICK_MS });
    try {
      seen.before = await ask(sock, { verb: "vault" });
      const made = (await ask(sock, { verb: "vault-init", slot_key: b64(randomBytes(32)), store: "keychain-login" })) as { key_id: string; recovery: string };
      seen.made = made;
      await ask(sock, { verb: "vault-confirm", recovery: made.recovery });
      seen.after = await ask(sock, { verb: "vault" });
    } finally {
      await home.stop();
    }
    artifact(root, "vault-gone", seen);
  });

  afterAll(() => removeRoot(root));

  it("a folder sealed by a key that is gone can never have a vault, or its items are lost or opened under the new key", () => {
    expect(seen.before).toMatchObject({ key_id: null, migrate: { key_id: keyId(gone) } });
    expect((seen.made as { key_id: string }).key_id).not.toBe(keyId(gone));
    expect(seen.after).toMatchObject({ locked: false, migrate: null, plain: [] });
    expect(secretsOf(root).list()).toEqual([{ name: "github", sealed: (seen.made as { key_id: string }).key_id }, { name: "google.password", sealed: keyId(gone) }]);
    expect(secretsOf(root, gone).get("google.password")).toBe("fake-password-google");
  });
});

describe("vault: a crash mid-write of vault.json, or mid-migration, with fsync on", () => {
  const seen: Record<string, unknown> = {};
  const old = randomBytes(32);
  const slot = randomBytes(32);
  let root: string;

  beforeAll(async () => {
    root = makeRoot("lifestream-vault-crash-", { sources: {} });
    secretsOf(root, old).set("google.password", "fake-password-google");
    for (const name of ["a-token", "b-token", "c-token"]) plant(root, name, `fake-${name}\n`);
    const child = new ChildHome(root);
    child.start("vault.renaming", { fsync: true });
    try {
      await child.ready();
      seen.renaming = await refusal(ask(testSocket(root), { verb: "vault-init", slot_key: b64(slot), store: "keychain-login", key: b64(old) }));
      seen.renamingExit = await child.exited();
      seen.afterRenaming = { vault: existsSync(join(root, "config", "vault.json")), list: secretsOf(root).list() };
      rmSync(testSocket(root).path, { force: true });
      child.start("vault.sealed-one", { fsync: true });
      await child.ready();
      const made = (await ask(testSocket(root), { verb: "vault-init", slot_key: b64(slot), store: "keychain-login", key: b64(old) })) as { recovery: string };
      seen.sealing = await refusal(ask(testSocket(root), { verb: "vault-confirm", recovery: made.recovery }));
      seen.sealingExit = await child.exited();
      seen.afterSealing = { vault: vaultOf(root), list: secretsOf(root).list() };
      rmSync(testSocket(root).path, { force: true });
      child.start(undefined, { fsync: true, slot });
      await child.ready();
      seen.finished = await ask(testSocket(root), { verb: "vault" });
    } finally {
      await child.stop();
    }
    artifact(root, "vault-crash", seen);
  });

  afterAll(() => removeRoot(root));

  it("a crash mid-write of vault.json leaves it unreadable, or half a vault", () => {
    expect(seen.renamingExit).toMatchObject({ signal: "SIGKILL" });
    expect(seen.afterRenaming).toMatchObject({ vault: false });
    expect((seen.afterRenaming as { list: unknown[] }).list).toEqual([
      { name: "a-token", sealed: null }, { name: "b-token", sealed: null }, { name: "c-token", sealed: null }, { name: "google.password", sealed: keyId(old) },
    ]);
  });

  it("a crash mid-migration loses an item, or leaves it plain after the next start", () => {
    expect(seen.sealingExit).toMatchObject({ signal: "SIGKILL" });
    expect((seen.afterSealing as { vault: VaultFile }).vault.key_id).toBe(keyId(old));
    expect((seen.afterSealing as { list: { sealed: string | null }[] }).list.filter((each) => each.sealed === null)).toHaveLength(2);
    expect(seen.finished).toMatchObject({ locked: false, opened: { by: "start" }, plain: [] });
    for (const name of ["a-token", "b-token", "c-token"]) expect(secretsOf(root, old).get(name)).toBe(`fake-${name}`);
    expect(secretsOf(root, old).get("google.password")).toBe("fake-password-google");
  });
});

describe("vault: unlocking at start, from fd 3 or the systemd credential, never hangs or stops", () => {
  const seen: Record<string, unknown> = {};
  const slot = randomBytes(32);
  let root: string;
  let recovery = "";

  beforeAll(async () => {
    root = makeRoot("lifestream-vault-start-", { sources: { "apple-notes:local:mac-0001": "fake-rows" } });
    const on = testMachine({ macApp: true });
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, machine: on, slot: null, log: () => undefined, tickMs: TICK_MS });
    try {
      recovery = ((await ask(testSocket(root, on.dir), { verb: "vault-init", slot_key: b64(slot), store: "keychain-login" })) as { recovery: string }).recovery;
      await ask(testSocket(root, on.dir), { verb: "vault-confirm", recovery });
      await ask(testSocket(root, on.dir), { verb: "seal", secret: PASSWORD, value: VALUE });
    } finally {
      await home.stop();
    }
    const child = new ChildHome(root);
    const started = async (options: Parameters<ChildHome["start"]>[1], name: string) => {
      child.start(undefined, options);
      try {
        await child.ready();
        seen[name] = await ask(testSocket(root), { verb: "vault" });
      } finally {
        seen[`${name}Exit`] = await child.stop();
      }
    };
    await started({ slot }, "fd");
    await started({ slot: randomBytes(32) }, "wrongFd");
    await started({ slot: slot.subarray(0, 16) }, "shortFd");
    await started({ slot, strayFd: true }, "strayFd");
    await started({ fdNamedOnly: true }, "closedFd");
    const logs: string[] = [];
    const startedHere = async (credentials: string | undefined, name: string) => {
      const home = await startReading(credentials, () => startHome(root, { stopGraceMs: 50, registry: FAKES, log: (line) => logs.push(line), tickMs: TICK_MS }));
      try {
        seen[name] = await ask(testSocket(root), { verb: "vault" });
        if (name === "noFd") {
          const id = await ship(root, { source: "apple-notes:local:mac-0001", fetched_ms: Date.now() - 1_000, rows: [{ kind: "note", key: "n0", content: { text: "synthetic" }, at: Date.now() - 1_000 }] });
          await until("the locked home imports", () => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) === "imported");
          seen.lockedImports = true;
        }
      } finally {
        await home.stop();
        seen[`${name}Exit`] = { code: (await home.stopped) === "stopped" ? 0 : 1, signal: null };
      }
    };
    await startedHere(undefined, "noFd");
    const credentials = mkdtempSync(join(tmpdir(), "lifestream-vault-creds-"));
    temps.push(credentials);
    writeFileSync(join(credentials, "vault-machine"), slot, { mode: 0o400 });
    await startedHere(credentials, "credential");
    renameSync(join(credentials, "vault-machine"), join(credentials, "moved"));
    await startedHere(credentials, "noCredential");
    writeFileSync(join(credentials, "vault-machine"), slot.subarray(0, 8), { mode: 0o400 });
    await startedHere(credentials, "badCredential");
    seen.log = `${readFileSync(join(root, "logs", "home.log"), "utf8")}${logs.join("\n")}`;
    artifact(root, "vault-start", seen);
  });

  afterAll(() => removeRoot(root));

  it("a home handed its machine slot's key on fd 3 does not open the vault", () => {
    expect(seen.fd).toMatchObject({ locked: false, opened: { by: "start", slot: `m-${keyId(slot)}` } });
    expect(seen.credential).toMatchObject({ locked: false, opened: { by: "start" } });
  });

  it("a missing fd 3, a wrong or short key, or a failed systemd credential hangs or stops the home instead of starting it locked", () => {
    for (const name of ["noFd", "wrongFd", "shortFd", "closedFd", "noCredential", "badCredential"]) {
      expect(seen[name], name).toMatchObject({ locked: true });
      expect(seen[`${name}Exit`], name).toEqual({ code: 0, signal: null });
    }
  });

  it("a stray fd 3 is read by a home started by hand", () => {
    expect(seen.strayFd).toMatchObject({ locked: true });
  });

  it("a locked home stops lanes that need no credential", () => {
    expect(seen.lockedImports).toBe(true);
  });

  it("a slot key reaches the log", () => {
    expect(leaks({ log: seen.log as string }, [slot])).toEqual([]);
  });
});

describe("vault: lifestream vault init, status and recover at a terminal", () => {
  const seen: Record<string, unknown> = {};
  const linux = testMachine({ tpm: true });
  const noTpm = testMachine({ tpm: false });
  const mac = testMachine({ macApp: true });
  let root: string;
  let bare: string;
  const outputs: string[] = [];

  const cli = async (where: string, on: Machine, args: string[], inputs: (() => string)[] = []) => {
    const lines: string[] = [];
    const status = await runCli([...args, "--root", where], {
      machine: on, write: (text) => { lines.push(text); outputs.push(text); },
      input: async () => (inputs.shift() ?? (() => ""))(),
    });
    return { status, out: lines.join("") };
  };

  beforeAll(async () => {
    const cred = join(linux.dir, "vault-machine.cred");
    let made = Buffer.alloc(0);
    root = makeRoot("lifestream-vault-cli-", { sources: {} });
    bare = makeRoot("lifestream-vault-cli-bare-", { sources: {} });
    let home = await startHome(root, { stopGraceMs: 50, registry: FAKES, machine: linux, slot: null, log: () => undefined, tickMs: TICK_MS });
    try {
      seen.onMac = await cli(root, mac, ["vault", "init"]);
      seen.recoverOnMac = await cli(root, mac, ["vault", "recover"]);
      let shown = "";
      seen.init = await cli(root, linux, ["vault", "init"], [() => {
        shown = /([A-Z2-7]{4}(?: [A-Z2-7]{4}){12})/u.exec(outputs.join(""))?.[1] ?? "";
        return `${shown}\n`;
      }]);
      seen.shown = shown;
      seen.status = await cli(root, linux, ["vault", "status"]);
      seen.initAgain = await cli(root, linux, ["vault", "init"]);
      made = readFileSync(cred);
      seen.recoverMistyped = await cli(root, linux, ["vault", "recover"], [() => `${recoveryKey.text(randomBytes(32))}\n`]);
      seen.keptMistyped = readFileSync(cred).equals(made);
    } finally {
      await home.stop();
    }
    seen.statusStopped = await cli(root, linux, ["vault", "status"]);
    seen.recoverStopped = await cli(root, linux, ["vault", "recover"], [() => `${seen.shown}\n`]);
    seen.keptStopped = readFileSync(cred).equals(made);
    seen.encrypts = readFileSync(`${linux.systemdCreds!}.calls`, "utf8").trim().split("\n").length;
    const credentials = mkdtempSync(join(tmpdir(), "lifestream-vault-cli-creds-"));
    temps.push(credentials);
    seen.cred = { exists: existsSync(cred), mode: existsSync(cred) ? statSync(cred).mode & 0o777 : null };
    writeFileSync(join(credentials, "vault-machine"), readFileSync(cred));
    home = await startReading(credentials, () => startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS }));
    try {
      seen.unitStart = await ask(testSocket(root), { verb: "vault" });
    } finally {
      await home.stop();
    }
    home = await startHome(bare, { stopGraceMs: 50, registry: FAKES, machine: noTpm, slot: null, log: () => undefined, tickMs: TICK_MS });
    let bareRecovery = "";
    try {
      seen.bareInit = await cli(bare, noTpm, ["vault", "init"], [() => {
        bareRecovery = [...outputs.join("").matchAll(/([A-Z2-7]{4}(?: [A-Z2-7]{4}){12})/gu)].at(-1)?.[1] ?? "";
        return bareRecovery;
      }]);
    } finally {
      await home.stop();
    }
    home = await startHome(bare, { stopGraceMs: 50, registry: FAKES, machine: noTpm, slot: null, log: () => undefined, tickMs: TICK_MS });
    try {
      seen.bareLocked = await ask(testSocket(bare, noTpm.dir), { verb: "vault" });
      seen.bareNeeds = statusOf(bare, { now_ms: Date.now(), settings: readOpsSettings(bare) }).notices.filter((notice) => notice.id === "vault:no-tpm");
      seen.bareRecoverWrong = await cli(bare, noTpm, ["vault", "recover"], [() => `${recoveryKey.text(randomBytes(32))}\n`]);
      seen.bareRecover = await cli(bare, noTpm, ["vault", "recover"], [() => `${bareRecovery}\n`]);
      seen.bareAfter = await ask(testSocket(bare, noTpm.dir), { verb: "vault" });
    } finally {
      await home.stop();
    }
    artifact(root, "vault-cli", { ...seen, outputs });
  });

  afterAll(() => {
    removeRoot(root);
    removeRoot(bare);
  });

  it("a recovery key is shown or typed in a terminal on a Mac with the recorder", () => {
    expect(seen.onMac).toMatchObject({ status: 1, out: expect.stringMatching(/Lifestream app/u) });
    expect(seen.recoverOnMac).toMatchObject({ status: 1, out: expect.stringMatching(/Lifestream app/u) });
  });

  it("init at a terminal leaves the recovery key unconfirmed after it was typed back, or makes no machine slot on a TPM", () => {
    expect(seen.init).toMatchObject({ status: 0 });
    expect(seen.shown).toMatch(/^([A-Z2-7]{4} ){12}[A-Z2-7]{4}$/u);
    const madeOn = new Date(vaultOf(root).slots.find((each) => each.kind === "recovery")!.made_ms).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: readOpsSettings(root).day.zone });
    expect((seen.init as { out: string }).out).toContain(`    Lifestream recovery key 1\n    Made on ${madeOn}\n\n    ${seen.shown as string}\n`);
    expect(madeOn).toMatch(/^\d{1,2} [A-Z][a-z]+ \d{4}$/u);
    expect(vaultOf(root).slots.find((each) => each.kind === "recovery")!.confirmed_ms).toEqual(expect.any(Number));
    expect(vaultOf(root).slots.find((each) => each.kind === "machine")).toMatchObject({ store: "systemd-tpm2" });
    expect(seen.cred).toEqual({ exists: true, mode: 0o600 });
    expect(seen.unitStart).toMatchObject({ locked: false, opened: { by: "start" } });
  });

  it("a refused vault init or recover replaces the TPM credential this box opens with, or makes a slot it never sends", () => {
    expect(seen.initAgain).toMatchObject({ status: 1, out: expect.stringMatching(/a vault exists .* confirmed: nothing to make/u) });
    expect(seen.recoverMistyped).toMatchObject({ status: 1, out: expect.stringMatching(/That isn't your recovery key/u) });
    expect(seen.recoverStopped).toMatchObject({ status: 1, out: expect.stringMatching(/no home runs/u) });
    expect([seen.keptMistyped, seen.keptStopped]).toEqual([true, true]);
    expect(seen.encrypts).toBe(3);
  });

  it("status hides the slots, the lock or the recovery state, or needs the home running", () => {
    expect((seen.status as { out: string }).out).toMatch(/key .*\n/u);
    expect((seen.status as { out: string }).out).toMatch(/recovery r-1 .*confirmed/u);
    expect((seen.status as { out: string }).out).toMatch(/unlocked/u);
    expect((seen.statusStopped as { out: string }).out).toMatch(/not running/u);
    expect((seen.statusStopped as { out: string }).out).toMatch(/machine m-[0-9a-f]{8} .*systemd-tpm2/u);
  });

  it("a box with no TPM opens at start without the recovery key, or recover fails to open it", () => {
    expect(seen.bareInit).toMatchObject({ status: 0, out: expect.stringMatching(/no TPM/u) });
    expect(seen.bareNeeds).toEqual([expect.objectContaining({ id: "vault:no-tpm", what: "This machine has no TPM: unlock it with your recovery key after each restart" })]);
    expect(seen.bareLocked).toMatchObject({ locked: true, slots: [expect.objectContaining({ kind: "recovery" })] });
    expect(seen.bareRecoverWrong).toMatchObject({ status: 1, out: expect.stringMatching(/That isn't your recovery key/u) });
    expect(seen.bareRecover).toMatchObject({ status: 0 });
    expect(seen.bareAfter).toMatchObject({ locked: false, opened: { by: "recover" } });
  });
});

describe("vault: the status lines", () => {
  const seen: Record<string, unknown> = {};
  const at = testMachine({ macApp: true });
  const slot = randomBytes(32);
  let root: string;

  beforeAll(async () => {
    root = makeRoot("lifestream-vault-status-", { sources: {} });
    const sock = testSocket(root, at.dir);
    const needs = () => ((status) => [
      ...status.needs.filter((need) => need.id.startsWith("vault:")).map((need) => ({ id: need.id, what: need.words, line: need.line, state: need.state })),
      ...status.notices.filter((notice) => notice.id.startsWith("vault:")).map((notice) => ({ id: notice.id, what: notice.what, operator: true })),
    ])(statusOf(root, { now_ms: Date.now(), settings: readOpsSettings(root) }));
    let home = await startHome(root, { stopGraceMs: 50, registry: FAKES, machine: at, slot: null, log: () => undefined, tickMs: TICK_MS });
    try {
      seen.empty = needs();
      const made = (await ask(sock, { verb: "vault-init", slot_key: b64(slot), store: "keychain-login" })) as { recovery: string };
      seen.unconfirmed = needs();
      await ask(sock, { verb: "vault-confirm", recovery: made.recovery });
      plant(root, "typed-by-hand", "fake-token-typed\n");
      seen.plainWaiting = needs();
      seen.replacing = await ask(sock, { verb: "vault-recovery" });
      seen.replacingVault = vaultOf(root);
      seen.replacingState = ((await ask(sock, { verb: "vault" })) as { recovery: string }).recovery;
      seen.replacingNeeds = needs();
      seen.oldOpens = openWith(readVault(root)!, "recovery", recoveryKey.parse(made.recovery)) !== null;
      seen.oldConfirms = await refusal(ask(sock, { verb: "vault-confirm", recovery: made.recovery }));
      seen.discarded = await ask(sock, { verb: "vault-discard" });
      seen.discardedOpens = await ask(sock, { verb: "vault-check", recovery: (seen.replacing as { recovery: string }).recovery });
      seen.discardedSlots = readVault(root)!.slots.filter((each) => each.kind === "recovery").map((each) => each.id);
      seen.discardedAgain = await ask(sock, { verb: "vault-discard" });
      seen.handed = await ask(sock, { verb: "vault-recovery", recovery: recoveryKey.text(randomBytes(32)) }).then(() => "answered", (error: Refusal) => ({ code: error.code, slots: readVault(root)!.slots.filter((each) => each.kind === "recovery").length }));
      seen.replacingAgain = await ask(sock, { verb: "vault-recovery" });
      seen.newConfirmed = await ask(sock, { verb: "vault-confirm", recovery: (seen.replacingAgain as { recovery: string }).recovery });
      seen.afterReplace = { state: ((await ask(sock, { verb: "vault" })) as { recovery: string }).recovery, recoveries: readVault(root)!.slots.filter((each) => each.kind === "recovery").length, oldOpens: openWith(readVault(root)!, "recovery", recoveryKey.parse(made.recovery)) !== null };
      for (let tries = 0; tries < 3; tries++) await refusal(ask(sock, { verb: "unlock", slot_key: b64(randomBytes(32)) }));
      seen.refusedEvents = readHome(root, (db) => db.prepare("SELECT count(*) FROM events WHERE kind = 'vault' AND key = 'refused'").pluck().get());
      seen.refused = needs();
    } finally {
      await home.stop();
    }
    plant(root, "loose", "fake-token-loose\n");
    chmodSync(join(root, "config", "secrets", "loose"), 0o644);
    plant(root, "unreadable", "fake-token-unreadable\n");
    chmodSync(join(root, "config", "secrets", "unreadable"), 0o000);
    home = await startHome(root, { stopGraceMs: 50, registry: FAKES, machine: at, slot, log: () => undefined, tickMs: TICK_MS });
    try {
      seen.started = await ask(sock, { verb: "vault" });
      seen.stayed = needs();
    } finally {
      await home.stop();
    }
    home = await startHome(root, { stopGraceMs: 50, registry: FAKES, machine: at, slot: null, log: () => undefined, tickMs: TICK_MS });
    try {
      seen.stayedLocked = needs();
    } finally {
      await home.stop();
    }
    rmSync(join(root, "config", "secrets", "loose"));
    rmSync(join(root, "config", "secrets", "unreadable"));
    home = await startHome(root, { stopGraceMs: 50, registry: FAKES, machine: at, slot: null, log: () => undefined, tickMs: TICK_MS });
    try {
      seen.locked = needs();
    } finally {
      await home.stop();
    }
    artifact(root, "vault-status", seen);
  });

  afterAll(() => removeRoot(root));

  const ids = (name: string) => (seen[name] as { id: string }[]).map((each) => each.id).sort();

  it("a home with no vault is told it is locked, or not told there is no vault", () => {
    expect(seen.empty).toEqual([expect.objectContaining({ id: "vault:none", what: "Passwords aren't set up", state: "needs-you" })]);
    expect(ids("unconfirmed")).not.toContain("vault:none");
  });

  it("an unconfirmed recovery key goes unsaid, or is still said once confirmed; a notice names the Developer ID", () => {
    expect(seen.unconfirmed).toEqual(expect.arrayContaining([expect.objectContaining({ id: "vault:unsaved", what: "Recovery key not saved", line: "Without it, a lost Mac loses your passwords", state: "needs-you" })]));
    expect(ids("plainWaiting")).not.toContain("vault:unsaved");
    expect(JSON.stringify(seen)).not.toContain("Developer ID");
  });

  it("a new recovery key not yet typed back makes the saved one read unsaved, the old key confirms it, or the old key stops opening the vault before then", () => {
    expect(seen.replacingState).toBe("confirmed");
    expect((seen.replacingNeeds as { id: string }[]).map((each) => each.id)).not.toContain("vault:unsaved");
    expect(seen.oldOpens).toBe(true);
    expect(seen.oldConfirms).toMatch(/isn't the new recovery key/u);
    expect(seen.newConfirmed).toEqual({ confirmed: (seen.replacingAgain as { recovery_slot: string }).recovery_slot });
    expect(seen.afterReplace).toEqual({ state: "confirmed", recoveries: 1, oldOpens: false });
  });

  it("a discarded new key still opens the vault, a second discard drops the saved key, or the answer names other than the dropped key's number", () => {
    expect(seen.discarded).toEqual({ dropped: [2] });
    expect(seen.discardedOpens).toMatchObject({ opens: false });
    expect(seen.discardedSlots).toEqual(["r-1"]);
    expect(seen.discardedAgain).toEqual({ dropped: [] });
  });

  it("a plain home handed a recovery key in vault-recovery makes its own instead of refusing it", () => {
    expect(seen.handed).toEqual({ code: "BAD_CALL", slots: 1 });
  });

  it("vault-recovery answers other than the recovery slot vault.json holds, or when it was made", () => {
    const written = unconfirmedSlot(seen.replacingVault as VaultFile);
    expect(Object.keys(seen.replacing as object).sort()).toEqual(["made_ms", "recovery", "recovery_slot"]);
    expect(seen.replacing).toMatchObject({ recovery_slot: written.id, made_ms: written.made_ms });
    expect(written.id).toBe("r-2");
  });

  it("a refused unlock is recorded at every try", () => {
    expect(seen.refusedEvents).toBe(1);
  });

  it("a plain item goes unsaid, or a start that holds the key stops on one it cannot seal", () => {
    expect(seen.plainWaiting).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "vault:plain", operator: true, what: "1 password is stored unsealed: it is sealed at the next start",
    })]));
    expect(seen.started).toMatchObject({ locked: false, plain: ["loose"], unreadable: expect.stringContaining("unreadable") });
    const stayedPlain = expect.objectContaining({ id: "vault:plain", operator: true, what: "1 password stays unsealed: a start that held the key could not seal it" });
    expect(seen.stayed).toEqual(expect.arrayContaining([stayedPlain, expect.objectContaining({ id: "vault:unreadable", operator: true })]));
    expect(seen.stayedLocked).toEqual(expect.arrayContaining([stayedPlain]));
  });

  it("a key this Mac offered that does not open Lifestream goes unsaid", () => {
    expect(seen.refused).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "vault:refused", what: "The key this Mac offered doesn't open Lifestream: nothing was changed",
    })]));
    expect(ids("stayed")).not.toContain("vault:refused");
  });

  it("a locked home goes unsaid", () => {
    expect(seen.locked).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "vault:locked", state: "needs-you", what: "Passwords are locked on this Mac",
    })]));
    expect(ids("stayed")).not.toContain("vault:locked");
  });
});

describe("vault: a new vault for a home whose recovery key and machine slot are both lost (vault-new)", () => {
  const seen: Record<string, unknown> = {};
  const at = testMachine({ macApp: true });
  const linux = testMachine({ tpm: true });
  const lost = randomBytes(32);
  const fresh = randomBytes(32);
  let root: string;
  let encrypted: string;
  let crashed: string;
  let cliRoot: string;
  const outputs: string[] = [];

  beforeAll(async () => {
    root = makeRoot("lifestream-vault-new-", { sources: { "apple-notes:local:poll": "fake-rows" }, clocks: true, settings: { "connectors.fake-poll": { refresh: "1s", password: PASSWORD } } });
    const sock = testSocket(root, at.dir);
    const pollSaid = () => readHome(root, (db) => db.prepare("SELECT outcome || ' ' || coalesce(reason, '') FROM attempts WHERE target = 'fetch:fake-poll' ORDER BY at_ms DESC LIMIT 1").pluck().get() as string | undefined);
    const needs = () => statusOf(root, { now_ms: Date.now(), settings: readOpsSettings(root) }).needs
      .filter((need) => need.id.startsWith("vault:") || need.id.startsWith("password:") || need.id.startsWith("fetch:"))
      .map((need) => ({ id: need.id, reason: need.reason, words: need.words }));
    const start = (slot: Buffer | null) => startHome(root, { stopGraceMs: 50, registry: FAKES, machine: at, slot, log: () => undefined, tickMs: TICK_MS });

    let home = await start(null);
    try {
      seen.noVault = await refusal(ask(sock, { verb: "vault-new", slot_key: b64(fresh), store: "keychain-login" }));
      const made = (await ask(sock, { verb: "vault-init", slot_key: b64(lost), store: "keychain-login" })) as { recovery: string };
      await ask(sock, { verb: "vault-confirm", recovery: made.recovery });
      await ask(sock, { verb: "seal", secret: PASSWORD, value: VALUE });
      seen.open = await refusal(ask(sock, { verb: "vault-new", slot_key: b64(fresh), store: "keychain-login" }));
      seen.openList = secretsOf(root).list();
    } finally {
      await home.stop();
    }
    const lostId = readVault(root)!.key_id;

    home = await start(null);
    try {
      seen.openedByKey = await ask(sock, { verb: "vault-new", slot_key: b64(lost), store: "keychain-login", unit: "macbook-pro-0001" });
      seen.openedByKeyState = await ask(sock, { verb: "vault" });
      seen.openedByKeyList = secretsOf(root).list();
    } finally {
      await home.stop();
    }
    plant(root, "typed-by-hand", "fake-token-typed\n");

    home = await start(null);
    try {
      await until("the poll waits for the vault", () => pollSaid() === "wait vault");
      seen.lockedNeeds = needs();
      seen.made = await ask(sock, { verb: "vault-new", slot_key: b64(fresh), store: "keychain-login", unit: "macbook-pro-0001" });
      seen.madeVault = vaultOf(root);
      seen.state = await ask(sock, { verb: "vault" });
      seen.list = secretsOf(root).list();
      await until("the poll asks for its password", () => pollSaid() === "need password");
      seen.madeNeeds = needs();
      seen.again = await refusal(ask(sock, { verb: "vault-new", slot_key: b64(randomBytes(32)), store: "keychain-login" }));
      seen.confirmed = await ask(sock, { verb: "vault-confirm", recovery: (seen.made as { recovery: string }).recovery });
      seen.confirmedState = await ask(sock, { verb: "vault" });
      seen.confirmedNeeds = needs();
      seen.events = readHome(root, (db) => (db.prepare("SELECT key, detail FROM events WHERE kind = 'vault' AND key IN ('new', 'opened') ORDER BY seq").all() as { key: string; detail: string }[])
        .map((row) => ({ key: row.key, detail: JSON.parse(row.detail) as unknown })));
    } finally {
      await home.stop();
    }
    seen.lostId = lostId;

    home = await start(fresh);
    try {
      seen.restarted = await ask(sock, { verb: "vault" });
    } finally {
      await home.stop();
    }
    home = await start(lost);
    try {
      seen.lostSlot = await ask(sock, { verb: "vault" });
    } finally {
      await home.stop();
    }

    encrypted = makeRoot("lifestream-vault-new-encrypted-", { sources: {} });
    writeFileSync(join(encrypted, "config", "vault.json"), `${JSON.stringify({ version: 2, key_id: "0a1b2c3d", slots: [] })}\n`, { mode: 0o600 });
    secretsOf(encrypted, randomBytes(32)).set("google.password", "fake-password-google");
    home = await startHome(encrypted, { stopGraceMs: 50, registry: FAKES, machine: at, slot: null, log: () => undefined, tickMs: TICK_MS });
    try {
      seen.encrypted = await refusal(ask(testSocket(encrypted, at.dir), { verb: "vault-new", slot_key: b64(fresh), store: "keychain-login" }));
      seen.encryptedAfter = { vault: vaultOf(encrypted) as unknown, list: secretsOf(encrypted).list() };
    } finally {
      await home.stop();
    }

    crashed = makeRoot("lifestream-vault-new-crash-", { sources: {} });
    const setupSock = testSocket(crashed, at.dir);
    const crashSock = testSocket(crashed);
    home = await startHome(crashed, { stopGraceMs: 50, registry: FAKES, machine: at, slot: null, log: () => undefined, tickMs: TICK_MS });
    try {
      const made = (await ask(setupSock, { verb: "vault-init", slot_key: b64(lost), store: "keychain-login" })) as { recovery: string };
      await ask(setupSock, { verb: "vault-confirm", recovery: made.recovery });
      await ask(setupSock, { verb: "seal", secret: PASSWORD, value: VALUE });
    } finally {
      await home.stop();
    }
    plant(crashed, "typed-by-hand", "fake-token-typed\n");
    const crashedId = readVault(crashed)!.key_id;
    const child = new ChildHome(crashed);
    child.start("vault.renaming", { fsync: true });
    try {
      await child.ready();
      seen.crash = await refusal(ask(crashSock, { verb: "vault-new", slot_key: b64(fresh), store: "keychain-login" }));
      seen.crashExit = await child.exited();
      seen.afterCrash = { key_id: readVault(crashed)!.key_id === crashedId, list: secretsOf(crashed).list(), files: readdirSync(join(crashed, "config")).filter((name) => name.startsWith("vault.json")) };
      rmSync(crashSock.path, { force: true });
      child.start(undefined, { fsync: true });
      await child.ready();
      seen.crashLocked = await ask(crashSock, { verb: "vault" });
      seen.rerun = await ask(crashSock, { verb: "vault-new", slot_key: b64(fresh), store: "keychain-login" });
      await ask(crashSock, { verb: "vault-confirm", recovery: (seen.rerun as { recovery: string }).recovery });
    } finally {
      await child.stop();
    }
    seen.afterRerun = { files: readdirSync(join(crashed, "config")).filter((name) => name.startsWith("vault.json")), list: secretsOf(crashed).list() };
    child.start(undefined, { fsync: true, slot: fresh });
    try {
      await child.ready();
      seen.rerunStart = await ask(crashSock, { verb: "vault" });
    } finally {
      await child.stop();
    }

    cliRoot = makeRoot("lifestream-vault-new-cli-", { sources: {} });
    const cliSock = testSocket(cliRoot, linux.dir);
    const cred = join(linux.dir, "vault-machine.cred");
    const questions: string[] = [];
    const typing = (word: string) => async (question: string) => {
      questions.push(question);
      return `${word}\n`;
    };
    const cli = async (on: Machine, args: string[], inputs: (() => string)[] = [], confirm: ((question: string) => Promise<string>) | null = null) => {
      const lines: string[] = [];
      const status = await runCli([...args, "--root", cliRoot], {
        machine: on, write: (text) => { lines.push(text); outputs.push(text); },
        input: async () => (inputs.shift() ?? (() => ""))(),
        confirm,
      });
      return { status, out: lines.join("") };
    };
    const typedBack = () => `${[...outputs.join("").matchAll(/([A-Z2-7]{4}(?: [A-Z2-7]{4}){12})/gu)].at(-1)?.[1] ?? ""}\n`;
    const startCli = (slot: Buffer | null) => startHome(cliRoot, { stopGraceMs: 50, registry: FAKES, machine: linux, slot, log: () => undefined, tickMs: TICK_MS });
    home = await startCli(null);
    let opening = Buffer.alloc(0);
    try {
      seen.cliInit = await cli(linux, ["vault", "init"], [typedBack]);
      await ask(cliSock, { verb: "seal", secret: PASSWORD, value: VALUE });
      opening = readFileSync(cred);
      seen.cliOpen = await cli(linux, ["vault", "new"]);
      seen.cliOpenKept = readFileSync(cred).equals(opening);
    } finally {
      await home.stop();
    }
    home = await startCli(null);
    try {
      seen.cliByHand = await ask(cliSock, { verb: "vault" });
      seen.cliOpens = await cli(linux, ["vault", "new"]);
      seen.cliOpensState = await ask(cliSock, { verb: "vault" });
      seen.cliOpensList = secretsOf(cliRoot).list();
      seen.cliOpensKept = readFileSync(cred).equals(opening);
    } finally {
      await home.stop();
    }
    const wrong = randomBytes(32);
    writeFileSync(cred, wrong, { mode: 0o600 });
    home = await startCli(null);
    try {
      seen.cliOnMac = await cli(at, ["vault", "new"]);
      seen.cliNoTerminal = await cli(linux, ["vault", "new"]);
      seen.cliTypedOther = await cli(linux, ["vault", "new"], [], typing("keep"));
      seen.cliRefusedList = secretsOf(cliRoot).list();
      seen.cliRefusedKept = readFileSync(cred).equals(wrong);
      seen.cliNew = await cli(linux, ["vault", "new"], [typedBack], typing("delete"));
      seen.cliState = await ask(cliSock, { verb: "vault" });
      seen.cliList = secretsOf(cliRoot).list();
    } finally {
      await home.stop();
    }
    seen.cliCred = existsSync(cred) && !readFileSync(cred).equals(wrong);
    seen.questions = [...questions];
    writeFileSync(cred, wrong, { mode: 0o600 });
    home = await startCli(null);
    let dropped: Awaited<ReturnType<typeof answerDropped>> | null = null;
    try {
      dropped = await answerDropped(cliSock, "vault-new");
      seen.cliLost = await cli(linux, ["vault", "new", "--yes"]);
      seen.cliLostTaken = dropped.taken;
    } finally {
      await dropped?.close();
      await home.stop();
    }
    const kept = readFileSync(cred);
    seen.cliLostKept = !kept.equals(wrong);
    home = await startCli(kept);
    try {
      seen.cliLostStart = await ask(cliSock, { verb: "vault" });
      seen.cliLostInit = await cli(linux, ["vault", "init"], [typedBack]);
      seen.cliLostAfter = await ask(cliSock, { verb: "vault" });
    } finally {
      await home.stop();
    }
    artifact(root, "vault-new", { ...seen, outputs });
  });

  afterAll(() => {
    for (const each of [root, encrypted, crashed, cliRoot]) if (each !== undefined) removeRoot(each);
  });

  it("a home with no vault, an open vault, or a vault that keeps more than passwords gets a new vault", () => {
    expect(seen.noVault).toBe("no vault is made yet: make one, and its recovery key, instead");
    expect(seen.open).toBe("passwords are open: nothing is lost; make a new recovery key in Settings instead");
    expect(seen.openList).toEqual([{ name: PASSWORD, sealed: expect.any(String) }]);
    expect(seen.encrypted).toBe("this home's vault keeps more than passwords, and none of it opens without its recovery key: no new vault is made over it");
    expect(seen.encryptedAfter).toMatchObject({ vault: { version: 2, key_id: "0a1b2c3d" }, list: [{ name: "google.password", sealed: expect.any(String) }] });
  });

  it("the key this Mac holds, handed to vault-new, opens the vault instead: nothing is deleted", () => {
    expect(seen.openedByKey).toEqual({ opened: seen.lostId });
    expect(seen.openedByKeyState).toMatchObject({ key_id: seen.lostId, locked: false, opened: { by: "unlock", slot: `m-${keyId(lost)}` } });
    expect(seen.openedByKeyList).toEqual([{ name: PASSWORD, sealed: seen.lostId }]);
  });

  it("a new vault answers other than vault-init, keeps a sealed item, loses a plain one, or reads its recovery key saved before it is typed back", () => {
    const made = seen.made as { key_id: string; slot: string; recovery: string };
    const written = unconfirmedSlot(seen.madeVault as VaultFile);
    expect(Object.keys(made).sort()).toEqual(["key_id", "made_ms", "recovery", "recovery_slot", "slot"]);
    expect(made).toMatchObject({ recovery_slot: written.id, made_ms: written.made_ms });
    expect(made.key_id).not.toBe(seen.lostId);
    expect(made.slot).toBe(`m-${keyId(fresh)}`);
    expect(seen.list).toEqual([{ name: "typed-by-hand", sealed: null }]);
    expect(seen.state).toMatchObject({ key_id: made.key_id, locked: false, opened: { by: "init", slot: made.slot }, recovery: "unconfirmed" });
    expect(seen.again).toBe("passwords are open: nothing is lost; make a new recovery key in Settings instead");
    expect(seen.confirmed).toEqual({ confirmed: "r-2" });
    expect(seen.confirmedState).toMatchObject({ recovery: "confirmed", plain: [] });
    expect(seen.events).toEqual([
      { key: "opened", detail: { by: "init", slot: `m-${keyId(lost)}` } },
      { key: "opened", detail: { by: "unlock", slot: `m-${keyId(lost)}` } },
      { key: "new", detail: { key_id: made.key_id, slot: made.slot, removed: [PASSWORD] } },
      { key: "opened", detail: { by: "init", slot: made.slot } },
    ]);
  });

  it("the home still says passwords are locked after a new vault, or a stream whose password was deleted says other than \"type your password\"", () => {
    expect((seen.lockedNeeds as { id: string }[]).map((need) => need.id)).toContain("vault:locked");
    const after = seen.madeNeeds as { id: string; reason?: string; words: string }[];
    expect(after.map((need) => need.id)).not.toContain("vault:locked");
    expect(after.find((need) => need.id === `password:${PASSWORD}`)).toMatchObject({ reason: "password", words: expect.stringMatching(/^Type your Example password/u) });
    expect(after.map((need) => need.id)).toContain("vault:unsaved");
    expect((seen.confirmedNeeds as { id: string }[]).map((need) => need.id).filter((id) => id.startsWith("vault:"))).toEqual([]);
  });

  it("the new vault's machine slot does not open it at the next start, or the lost one still does", () => {
    expect(seen.restarted).toMatchObject({ key_id: (seen.made as { key_id: string }).key_id, locked: false, opened: { by: "start", slot: `m-${keyId(fresh)}` } });
    expect(seen.lostSlot).toMatchObject({ locked: true });
  });

  it("a crash between deleting the sealed items and writing the new vault leaves a home the new vault cannot be made on again", () => {
    expect(seen.crash).not.toBe("answered");
    expect(seen.crashExit).toMatchObject({ signal: "SIGKILL" });
    expect(seen.afterCrash).toMatchObject({ key_id: true, list: [{ name: "typed-by-hand", sealed: null }] });
    expect(seen.crashLocked).toMatchObject({ locked: true });
    expect(seen.rerun).toMatchObject({ slot: `m-${keyId(fresh)}` });
    expect(seen.afterRerun).toEqual({ files: ["vault.json"], list: [{ name: "typed-by-hand", sealed: (seen.rerun as { key_id: string }).key_id }] });
    expect(seen.rerunStart).toMatchObject({ key_id: (seen.rerun as { key_id: string }).key_id, locked: false, opened: { by: "start" } });
  });

  it("lifestream vault new runs on a Mac with the recorder, makes a vault over an open one, or leaves its key unconfirmed or the box without its TPM slot", () => {
    expect(seen.cliOnMac).toMatchObject({ status: 1, out: expect.stringMatching(/vault new at a terminal is refused on a Mac with the Lifestream app/u) });
    expect(seen.cliOpen).toMatchObject({ status: 1, out: expect.stringMatching(/passwords are open: nothing is lost/u) });
    expect(seen.cliNew).toMatchObject({ status: 0, out: expect.stringMatching(/vault-machine\.cred does not open vault[\s\S]*in place of the vault no key opened[\s\S]*your recovery key, shown once[\s\S]*Lifestream recovery key 2\n {4}Made on [^\n]+\n\n {4}[A-Z2-7]{4}[\s\S]*recovery key r-2 confirmed/u) });
    expect(seen.cliState).toMatchObject({ locked: false, recovery: "confirmed", slots: [{ kind: "machine", store: "systemd-tpm2" }, { kind: "recovery" }] });
    expect(seen.cliList).toEqual([]);
    expect(seen.cliCred).toBe(true);
  });

  it("lifestream vault new deletes passwords this machine's own credential still opens, on a home started by hand without it", () => {
    expect(seen.cliByHand).toMatchObject({ locked: true });
    expect(seen.cliOpens).toMatchObject({ status: 0, out: expect.stringMatching(/vault-machine\.cred opened vault [0-9a-f]{8}: its passwords are open and nothing was deleted/u) });
    expect(seen.cliOpens).not.toMatchObject({ out: expect.stringMatching(/in place of|recovery key, shown once/u) });
    expect(seen.cliOpensState).toMatchObject({ locked: false, opened: { by: "unlock" } });
    expect(seen.cliOpensList).toEqual([{ name: PASSWORD, sealed: expect.any(String) }]);
    expect(seen.cliOpensKept).toBe(true);
  });

  it("lifestream vault new deletes with no terminal and no --yes, or when a word other than delete is typed", () => {
    expect(seen.cliNoTerminal).toMatchObject({ status: 1, out: expect.stringMatching(/a new vault deletes every password sealed by vault [0-9a-f]{8}[\s\S]*nothing was deleted; run vault new at a terminal and type delete, or give --yes/u) });
    expect(seen.cliTypedOther).toMatchObject({ status: 1, out: expect.stringMatching(/nothing was deleted: vault new goes on only when delete is typed/u) });
    expect(seen.cliRefusedList).toEqual([{ name: PASSWORD, sealed: expect.any(String) }]);
    expect(seen.cliRefusedKept).toBe(true);
    expect(seen.questions).toEqual([expect.stringMatching(/deletes every password[\s\S]*Type delete to go on/u), expect.stringMatching(/Type delete to go on/u)]);
  });

  it("a refused vault new puts back other than the credential it replaced", () => {
    expect(seen.cliOpenKept).toBe(true);
  });

  it("an answer lost after the home made the new vault puts back the old credential, or leaves no word on what to do", () => {
    expect(seen.cliLostTaken).toEqual([expect.objectContaining({ key_id: expect.any(String), slot: expect.stringMatching(/^m-/u) })]);
    expect(seen.cliLost).toMatchObject({ status: 1, out: expect.stringMatching(/Lifestream (?:is still working on this|didn't answer)\. It may have run vault-new[\s\S]*keeps the new vault-machine\.cred[\s\S]*vault status[\s\S]*vault init makes a new one/u) });
    expect(seen.cliLostKept).toBe(true);
    const made = (seen.cliLostTaken as { key_id: string; slot: string }[])[0]!;
    expect(seen.cliLostStart).toMatchObject({ key_id: made.key_id, locked: false, opened: { by: "start", slot: made.slot }, recovery: "unconfirmed" });
    expect(seen.cliLostInit).toMatchObject({ status: 0, out: expect.stringMatching(/recovery key was never confirmed[\s\S]*confirmed: the vault opened with it/u) });
    expect(seen.cliLostAfter).toMatchObject({ recovery: "confirmed" });
  });
});
