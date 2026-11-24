import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { homeSecrets, keyId } from "@lifestreamprotocol/core";
import { Refusal } from "./refusal.js";
import { openWith, readVault, recoveryKey, Vault, VAULT_KEY, vaultPath, type MadeVault } from "./vault.js";

const roots: string[] = [];
const rootOf = () => {
  const root = mkdtempSync(join(tmpdir(), "lifestream-vault-new-unit-"));
  roots.push(root);
  mkdirSync(join(root, "config", "secrets"), { recursive: true, mode: 0o700 });
  return root;
};
const placeOf = (root: string) => ({ root, machine: join(root, "..", `${root.split("/").pop()}-machine`), home: "0f1e2d3c-4b5a-4968-8778-a1b2c3d4e5f6" });
const secretsOf = (root: string, key?: Buffer) => homeSecrets(join(root, "config", "secrets"), key === undefined ? {} : { key });
const plant = (root: string, name: string, text: string) => writeFileSync(join(root, "config", "secrets", name), text, { mode: 0o600 });
const slotOf = (key: Buffer) => ({ key, store: "keychain-login" as const, unit: "macbook-pro-0001" });
const refusal = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    return (error as Error).message;
  }
  return "answered";
};
const thrown = (work: () => unknown): unknown => {
  try {
    work();
  } catch (error) {
    return error;
  }
  return null;
};
const wrongKey = (error: unknown): boolean => error instanceof Refusal && error.code === VAULT_KEY;

const madeOf = (outcome: ReturnType<Vault["newVault"]>): { made: MadeVault; removed: string[] } => {
  if ("opened" in outcome) throw new Error(`the vault opened (${outcome.opened}) where a new one was asked`);
  return outcome;
};

function lostHome(machine: Buffer = randomBytes(32)): { root: string; old: string; recovery: string } {
  const root = rootOf();
  const made = new Vault(placeOf(root));
  const { recovery } = made.init({ machine: slotOf(machine), key: null }, 1);
  made.confirm(recovery, 2);
  made.seal("google.password", "fake-password-google");
  made.seal("github", "fake-token-github");
  plant(root, "typed-by-hand", "fake-token-typed\n");
  return { root, old: readVault(root)!.key_id, recovery };
}

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("a new vault (vault-new): only for a vault nothing opens", () => {
  it("a folder with no vault, an open vault, or a vault of another version is replaced", () => {
    const empty = rootOf();
    expect(refusal(() => new Vault(placeOf(empty)).newVault(null, 1))).toBe("no vault is made yet: make one, and its recovery key, instead");

    const { root, recovery } = lostHome();
    const open = new Vault(placeOf(root));
    expect(open.recover(recovery, null, 4).key_id).toBe(readVault(root)!.key_id);
    const before = readFileSync(vaultPath(root), "utf8");
    expect(refusal(() => open.newVault(null, 5))).toBe("passwords are open: nothing is lost; make a new recovery key in Settings instead");
    expect(readFileSync(vaultPath(root), "utf8")).toBe(before);
    expect(secretsOf(root).list().filter((item) => item.sealed !== null)).toHaveLength(2);

    const encrypted = rootOf();
    writeFileSync(vaultPath(encrypted), `${JSON.stringify({ version: 2, key_id: "0a1b2c3d", slots: [], data: "sealed" })}\n`, { mode: 0o600 });
    secretsOf(encrypted, randomBytes(32)).set("google.password", "fake-password-google");
    expect(refusal(() => new Vault(placeOf(encrypted)).newVault(slotOf(randomBytes(32)), 1))).toBe("this home's vault keeps more than passwords, and none of it opens without its recovery key: no new vault is made over it");
    expect(JSON.parse(readFileSync(vaultPath(encrypted), "utf8"))).toMatchObject({ version: 2 });
    expect(secretsOf(encrypted).list()).toHaveLength(1);

    const broken = rootOf();
    writeFileSync(vaultPath(broken), "{ not json", { mode: 0o600 });
    expect(refusal(() => new Vault(placeOf(broken)).newVault(null, 1))).toBe("config/vault.json does not read as JSON");
  });

  it("a sealed item outlives the new vault, a plain one is lost, or the old key or slot still opens it", () => {
    const { root, old } = lostHome();
    const gone = randomBytes(32);
    secretsOf(root, gone).set("x.password", "fake-password-other-key");
    const vault = new Vault(placeOf(root));
    expect(vault.start({ key: null, why: "no machine slot's key was handed at start" }, 3)).not.toBeNull();
    const slot = randomBytes(32);
    const { made, removed } = madeOf(vault.newVault(slotOf(slot), 10));
    expect(removed).toEqual(["github", "google.password", "x.password"]);
    expect(made).toEqual({ key_id: expect.stringMatching(/^[0-9a-f]{8}$/u), slot: `m-${keyId(slot)}`, recovery_slot: "r-2", made_ms: 10, recovery: expect.stringMatching(/^([A-Z2-7]{4} ){12}[A-Z2-7]{4}$/u) });
    expect(made.key_id).not.toBe(old);
    expect(secretsOf(root).list()).toEqual([{ name: "typed-by-hand", sealed: null }]);
    const file = readVault(root)!;
    expect(file.slots.map(({ id, kind, unit, store, confirmed_ms }) => ({ id, kind, unit, store, confirmed_ms }))).toEqual([
      { id: `m-${keyId(slot)}`, kind: "machine", unit: "macbook-pro-0001", store: "keychain-login", confirmed_ms: undefined },
      { id: "r-2", kind: "recovery", unit: undefined, store: undefined, confirmed_ms: undefined },
    ]);
    expect(openWith(file, "recovery", recoveryKey.parse(made.recovery))!.key.equals(vault.key!)).toBe(true);
    expect(vault.state()).toMatchObject({ key_id: made.key_id, locked: false, opened: { by: "init", slot: `m-${keyId(slot)}` }, recovery: "unconfirmed", plain: ["typed-by-hand"] });
    expect(vault.kept).toBe(true);
    expect(vault.get("google.password")).toBeUndefined();

    const next = new Vault(placeOf(root));
    expect(next.start({ key: slot, why: null }, 20)).toBeNull();
    expect(next.state()).toMatchObject({ key_id: made.key_id, opened: { by: "start" } });
  });

  it("a new vault with no machine slot answers a secret before its recovery key is confirmed, or the confirm differs from a first init", () => {
    const { root } = lostHome();
    const vault = new Vault(placeOf(root));
    const { made } = madeOf(vault.newVault(null, 10));
    expect(made.slot).toBeNull();
    expect(vault.kept).toBe(false);
    expect(refusal(() => vault.get("typed-by-hand"))).toBe("Passwords are locked until the recovery key is confirmed");
    expect(vault.sealPlain()).toBeNull();
    expect(vault.confirm(made.recovery, 11)).toBe("r-2");
    expect(vault.kept).toBe(true);
    expect(vault.sealPlain()).toEqual({ sealed: ["typed-by-hand"], failed: [] });
    expect(vault.state()).toMatchObject({ recovery: "confirmed", plain: [] });
    expect(vault.get("typed-by-hand")).toBe("fake-token-typed");
  });

  it("a home stopped between deleting the sealed items and writing vault.json, or after the write before its key was confirmed, cannot run it again", () => {
    const { root, old } = lostHome();
    for (const item of secretsOf(root).list()) if (item.sealed !== null) secretsOf(root).remove(item.name);
    expect(readVault(root)!.key_id).toBe(old);
    const { made, removed } = madeOf(new Vault(placeOf(root)).newVault(null, 10));
    expect(removed).toEqual([]);
    expect(readVault(root)!.key_id).toBe(made.key_id);
    expect(secretsOf(root).list()).toEqual([{ name: "typed-by-hand", sealed: null }]);

    const again = new Vault(placeOf(root));
    const second = madeOf(again.newVault(null, 11)).made;
    expect(second.key_id).not.toBe(made.key_id);
    expect(second.recovery_slot).toBe("r-3");
  });

  it("the machine key handed opens the vault instead: it is held and nothing is deleted", () => {
    const machine = randomBytes(32);
    const { root, old } = lostHome(machine);
    const before = readFileSync(vaultPath(root), "utf8");
    const vault = new Vault(placeOf(root));
    expect(vault.start({ key: null, why: "no machine slot's key was handed at start" }, 3)).not.toBeNull();
    expect(vault.newVault(slotOf(machine), 10)).toEqual({ opened: old });
    expect(readFileSync(vaultPath(root), "utf8")).toBe(before);
    expect(secretsOf(root).list().filter((item) => item.sealed !== null).map((item) => item.name)).toEqual(["github", "google.password"]);
    expect(vault.state()).toMatchObject({ key_id: old, locked: false, opened: { by: "unlock", slot: `m-${keyId(machine)}` } });
    expect(vault.get("github")).toBe("fake-token-github");
  });

  it("a vault.json that does not read for a moment deletes nothing, and its unlock is not refused as a wrong key", () => {
    const machine = randomBytes(32);
    const { root, old } = lostHome(machine);
    const vault = new Vault(placeOf(root));
    vault.start({ key: null, why: "no machine slot's key was handed at start" }, 3);
    const sealed = () => secretsOf(root).list().filter((item) => item.sealed !== null).map((item) => item.name);
    const kept = readFileSync(vaultPath(root), "utf8");

    renameSync(vaultPath(root), `${vaultPath(root)}.away`);
    expect(wrongKey(thrown(() => vault.unlock(machine, 4)))).toBe(false);
    expect(refusal(() => vault.newVault(slotOf(randomBytes(32)), 5))).toBe("no vault is made yet: make one, and its recovery key, instead");
    renameSync(`${vaultPath(root)}.away`, vaultPath(root));

    writeFileSync(vaultPath(root), "{ half a write", { mode: 0o600 });
    expect(wrongKey(thrown(() => vault.unlock(machine, 6)))).toBe(false);
    expect(refusal(() => vault.newVault(slotOf(randomBytes(32)), 7))).toBe("config/vault.json does not read as JSON");
    writeFileSync(vaultPath(root), kept, { mode: 0o600 });

    expect(sealed()).toEqual(["github", "google.password"]);
    expect(thrown(() => vault.unlock(randomBytes(32), 8))).toMatchObject({ status: 403, code: VAULT_KEY });
    expect(vault.newVault(slotOf(machine), 9)).toEqual({ opened: old });
    expect(sealed()).toEqual(["github", "google.password"]);
  });
});
