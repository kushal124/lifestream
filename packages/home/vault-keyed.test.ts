import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { keyId } from "@lifestreamprotocol/core";
import { runCli } from "./cli.js";
import { adopt, look } from "./lifecycle.js";
import { machine, type Machine } from "./machine.js";
import { Refusal } from "./refusal.js";
import { draftRecovery, makeKeyedVault, NO_SLOT_KEY, readHandoff, readVault, recoveryKey, Vault, VAULT_KEY, vaultPath, type KeyedHandoff, type VaultPlace } from "./vault.js";

const HOME_ID = "0f1e2d3c-4b5a-4968-8778-a1b2c3d4e5f6";
const UNIT = "macbook-pro-0001";

function base(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "lifestream-vault-keyed-")));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function placeOf(dir = base()): VaultPlace {
  const root = join(dir, "home");
  mkdirSync(join(root, "config"), { recursive: true, mode: 0o700 });
  return { root, machine: join(dir, "machine"), home: HOME_ID };
}

function handoffOf(home_id = HOME_ID): { handed: KeyedHandoff; slot: Buffer; recovery: string } {
  const slot = randomBytes(32);
  const recovery = draftRecovery(1).recovery;
  return { handed: readHandoff(JSON.stringify({ home_id, slot_key: slot.toString("hex"), recovery })), slot, recovery };
}

function keyed(place = placeOf()): { place: VaultPlace; slot: Buffer; recovery: string } {
  const { handed, slot, recovery } = handoffOf(place.home);
  makeKeyedVault(place, handed, UNIT, 10);
  return { place, slot, recovery };
}

const copyOf = (place: VaultPlace) => join(place.machine, "vaults", `${place.home}.json`);
const bytes = (path: string) => readFileSync(path, "utf8");
const json = (path: string) => JSON.parse(bytes(path)) as Record<string, unknown>;
const stamp = (place: VaultPlace, key_id: string) => writeFileSync(join(place.root, "config", "stores.json"), `${JSON.stringify({ key_id, "home.db": 35 })}\n`);
const keyedStore = (place: VaultPlace) => writeFileSync(join(place.root, "home.db"), randomBytes(4096));
const slotOf = (key: Buffer) => ({ key, store: "keychain-login" as const, unit: UNIT });
const refusal = (work: () => unknown) => {
  try {
    work();
  } catch (error) {
    return (error as Error).message;
  }
  return "answered";
};

function tree(dir: string): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (at: string) => {
    if (!existsSync(at)) return;
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else found[path] = `${statSync(path).mtimeMs}:${bytes(path)}`;
    }
  };
  walk(dir);
  return found;
}

function machineAt(dir: string): Machine {
  return machine({ env: { LIFESTREAM_MACHINE_DIR: join(dir, "machine") }, home: join(dir, "user") });
}

describe("a plain home's vault: version 1, as today", () => {
  it("a version 1 file is never rewritten as version 2, and no copy is made", () => {
    const place = placeOf();
    const vault = new Vault(place);
    const first = randomBytes(32);
    const made = vault.init({ machine: slotOf(first), key: null }, 1);
    const versionOne = () => {
      const file = json(vaultPath(place.root));
      expect(file.version).toBe(1);
      expect(Object.keys(file).sort()).toEqual(["key_id", "slots", "version"]);
      expect(existsSync(join(place.machine, "vaults"))).toBe(false);
    };
    versionOne();
    vault.confirm(made.recovery, 2);
    versionOne();
    const before = bytes(vaultPath(place.root));
    expect(() => vault.newRecovery(3, draftRecovery(3).recovery)).toThrow(/BAD_CALL/u);
    expect(bytes(vaultPath(place.root))).toBe(before);
    const next = vault.newRecovery(3);
    if (!("recovery" in next)) throw new Error("a vault of passwords alone answered no key of its own");
    vault.confirm(next.recovery, 4);
    versionOne();
    const second = randomBytes(32);
    expect(vault.addSlot({ ...slotOf(second), unit: "mac-mini-bb17" }, 5)).toEqual({ slot: `m-${keyId(second)}`, removed: [] });
    versionOne();
    expect(new Vault(place).recover(next.recovery, slotOf(randomBytes(32)), 6).key_id).toBe(made.key_id);
    versionOne();
    expect(new Vault(place).state()).toMatchObject({ keyed: false, key_id: made.key_id });
    expect(new Vault(place).keys).toBeUndefined();
  });
});

describe("a keyed vault: version 2", () => {
  it("round-trips: what is written reads back whole, the copy holds the same bytes, and either key opens data key 1", () => {
    const { place, slot, recovery } = keyed();
    const file = json(vaultPath(place.root));
    expect(readVault(place.root)).toEqual(file);
    expect(bytes(copyOf(place))).toBe(bytes(vaultPath(place.root)));
    expect(file).toMatchObject({
      version: 2, counter: 1,
      slots: [
        { id: `m-${keyId(slot)}`, kind: "machine", unit: UNIT, store: "keychain-login", account: `machine:${HOME_ID}`, made_ms: 10 },
        { id: "r-1", kind: "recovery", number: 1, made_ms: 10, confirmed_ms: 10 },
      ],
      keys: [{ kind: "data", id: 1, made_ms: 10 }],
    });
    expect(statSync(vaultPath(place.root)).mode & 0o777).toBe(0o600);
    expect(statSync(copyOf(place)).mode & 0o777).toBe(0o600);

    const started = new Vault(place);
    expect(started.start({ key: slot, why: null }, 20)).toBeNull();
    const recovered = new Vault(place);
    recovered.recover(recovery, null, 21);
    expect(started.keys!.hand()).toEqual(recovered.keys!.hand());
    expect(started.state()).toMatchObject({
      keyed: true, locked: false, recovery: "confirmed",
      slots: [{ kind: "machine", account: `machine:${HOME_ID}` }, { id: "r-1", kind: "recovery", number: 1 }],
    });

    expect(() => started.newRecovery(30)).toThrow(/drafted/u);
    const drafted = draftRecovery(30).recovery;
    expect(started.newRecovery(30, drafted)).toEqual({ recovery_slot: "r-2", number: 2, made_ms: 30 });
    expect(started.check(drafted)).toMatchObject({ opens: true, slot: "r-2", confirmed_ms: null });
    started.confirm(drafted, 31);
    const after = json(vaultPath(place.root));
    expect(after).toMatchObject({ version: 2, counter: 3, keys: file.keys, slots: [{ account: `machine:${HOME_ID}` }, { id: "r-2", number: 2, confirmed_ms: 31 }] });
    expect(bytes(copyOf(place))).toBe(bytes(vaultPath(place.root)));
    const again = new Vault(place);
    expect(again.start({ key: slot, why: null }, 40)).toBeNull();
    expect(again.keys!.hand()).toEqual(started.keys!.hand());
  });

  it("a key handed at start that opens no slot leaves the vault locked, holding no keys", () => {
    const { place } = keyed();
    const vault = new Vault(place);
    expect(vault.start({ key: randomBytes(32), why: null }, 1)).toBe("the key handed at start opens no machine slot of this vault");
    expect(vault.keys).toBeUndefined();
    expect(vault.state()).toMatchObject({ keyed: true, locked: true });
  });
});

describe("the folder's file and this Mac's copy", () => {
  it("the higher counter wins, either way, and the loser is rewritten to match; the copy's win is logged", () => {
    const { place, slot } = keyed();
    const old = bytes(vaultPath(place.root));
    const open = new Vault(place);
    open.start({ key: slot, why: null }, 1);
    open.addSlot({ ...slotOf(randomBytes(32)), unit: "mac-mini-bb17" }, 2);
    const newer = bytes(vaultPath(place.root));
    expect(json(vaultPath(place.root)).counter).toBe(2);

    writeFileSync(vaultPath(place.root), old);
    const said: unknown[] = [];
    const restored = new Vault(place, (line) => said.push(line));
    expect(restored.state().slots).toHaveLength(3);
    expect(bytes(vaultPath(place.root))).toBe(old);
    expect(restored.start({ key: slot, why: null }, 3)).toBeNull();
    expect(bytes(vaultPath(place.root))).toBe(newer);
    expect(said).toEqual([{ vault: "mended", said: expect.stringContaining("counter 1") }]);

    writeFileSync(copyOf(place), old);
    const quiet: unknown[] = [];
    expect(new Vault(place, (line) => quiet.push(line)).start({ key: slot, why: null }, 4)).toBeNull();
    expect(bytes(copyOf(place))).toBe(newer);
    expect(quiet).toEqual([]);
  });

  it("nothing is rewritten while no key opens the winner", () => {
    const { place, slot } = keyed();
    const old = bytes(vaultPath(place.root));
    const open = new Vault(place);
    open.start({ key: slot, why: null }, 1);
    open.addSlot({ ...slotOf(randomBytes(32)), unit: "mac-mini-bb17" }, 2);
    writeFileSync(vaultPath(place.root), old);
    expect(new Vault(place).start({ key: null, why: "no machine slot's key was handed at start" }, 3)).toBe("no machine slot's key was handed at start");
    expect(bytes(vaultPath(place.root))).toBe(old);
  });

  it("a missing folder file is put back from the copy only when config/stores.json names the copy's key_id", () => {
    const { place, slot } = keyed();
    keyedStore(place);
    const copy = bytes(copyOf(place));
    const key_id = json(copyOf(place)).key_id as string;
    rmSync(vaultPath(place.root));

    const unstamped = new Vault(place);
    expect(unstamped.start({ key: slot, why: null }, 1)).toMatch(/^config\/vault\.json is missing.*config\/stores\.json names no vault/u);
    expect(unstamped.state()).toMatchObject({ keyed: true, locked: true, key_id: null, unreadable: expect.stringContaining("config/vault.json is missing") });
    expect(existsSync(vaultPath(place.root))).toBe(false);

    stamp(place, "0a1b2c3d");
    expect(new Vault(place).start({ key: slot, why: null }, 2)).toMatch(/this Mac's copy is of vault [0-9a-f]{8}, and config\/stores\.json names 0a1b2c3d/u);
    expect(existsSync(vaultPath(place.root))).toBe(false);

    stamp(place, key_id);
    const said: unknown[] = [];
    const back = new Vault(place, (line) => said.push(line));
    expect(back.start({ key: slot, why: null }, 3)).toBeNull();
    expect(bytes(vaultPath(place.root))).toBe(copy);
    expect(back.keys).toBeDefined();
    expect(said).toHaveLength(1);
  });

  it("a damaged folder file is a locked start that names it, never a new vault, when no copy is there", () => {
    const { place, slot } = keyed();
    keyedStore(place);
    rmSync(copyOf(place));
    writeFileSync(vaultPath(place.root), "{ not json");
    expect(new Vault(place).start({ key: slot, why: null }, 1)).toMatch(/^config\/vault\.json does not read as JSON.*this Mac keeps no copy/u);
    expect(bytes(vaultPath(place.root))).toBe("{ not json");
    expect(refusal(() => new Vault(place).init({ machine: slotOf(slot), key: null }, 2))).toMatch(/encrypted/u);
  });

  it("a copy of another vault is put back over a folder file, or is left in place when config/stores.json names the folder file's vault", () => {
    const one = keyed();
    const other = keyed(placeOf());
    keyedStore(one.place);
    const own = bytes(vaultPath(one.place.root));
    writeFileSync(copyOf(one.place), bytes(copyOf(other.place)));
    stamp(one.place, json(vaultPath(one.place.root)).key_id as string);
    const said: unknown[] = [];
    expect(new Vault(one.place, (line) => said.push(line)).start({ key: one.slot, why: null }, 1)).toBeNull();
    expect(bytes(vaultPath(one.place.root))).toBe(own);
    expect(bytes(copyOf(one.place))).toBe(own);
    expect(said).toEqual([{ vault: "mended", said: expect.stringContaining("the copy is written again") }]);
  });

  it("a copy of the wrong shape is no copy: the folder's vault opens and the copy is written again", () => {
    const { place, slot } = keyed();
    keyedStore(place);
    const good = json(copyOf(place));
    const shapes = ["null", JSON.stringify({ ...good, slots: [null] }), JSON.stringify({ ...good, keys: [null] })];
    for (const shape of shapes) {
      writeFileSync(copyOf(place), shape);
      const vault = new Vault(place);
      expect(vault.start({ key: slot, why: null }, 1)).toBeNull();
      expect(vault.keys).toBeDefined();
      expect(bytes(copyOf(place))).toBe(bytes(vaultPath(place.root)));
    }
  });

  it("keeping the folder at uninstall puts its vault back from this Mac's copy, or refuses while the copy is the only one that opens it", () => {
    const { place, slot } = keyed();
    keyedStore(place);
    const copy = bytes(copyOf(place));
    rmSync(vaultPath(place.root));
    expect(refusal(() => new Vault(place).keepInFolder())).toMatch(/only copy of your home's vault.*config\/stores\.json names no vault/u);
    expect([existsSync(vaultPath(place.root)), bytes(copyOf(place))]).toEqual([false, copy]);

    stamp(place, json(copyOf(place)).key_id as string);
    new Vault(place).keepInFolder();
    expect(bytes(vaultPath(place.root))).toBe(copy);
    rmSync(join(place.machine, "vaults"), { recursive: true });
    expect(new Vault(place).start({ key: slot, why: null }, 1)).toBeNull();

    writeFileSync(vaultPath(place.root), "{ not json");
    expect(refusal(() => new Vault(place).keepInFolder())).toBe("answered");
    expect(bytes(vaultPath(place.root))).toBe(bytes(copyOf(place)));
  });

  it("a start sweeps another home's half-written copy in this Mac's vaults, or leaves its own", () => {
    const { place, slot } = keyed();
    const own = `${copyOf(place)}.0f0e0d0c.tmp`;
    const another = join(place.machine, "vaults", "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d.json.0f0e0d0c.tmp");
    writeFileSync(own, "half");
    writeFileSync(another, "half");
    expect(new Vault(place).start({ key: slot, why: null }, 1)).toBeNull();
    expect([existsSync(own), existsSync(another)]).toEqual([false, true]);
  });
});

describe("the acts on a keyed vault", () => {
  it("vault-check says whether a recovery key opens it, names the slot, and writes nothing, locked or open", () => {
    const { place, slot, recovery } = keyed();
    const before = tree(join(place.root, ".."));
    const locked = new Vault(place);
    expect(locked.check(recovery)).toEqual({ opens: true, slot: "r-1", number: 1, made_ms: 10, confirmed_ms: 10 });
    expect(locked.check(recoveryKey.text(randomBytes(32)))).toEqual({ opens: false, slot: "r-1", number: 1, made_ms: 10, confirmed_ms: 10 });
    expect(locked.keys).toBeUndefined();
    expect(locked.state().locked).toBe(true);
    const open = new Vault(place);
    open.start({ key: slot, why: null }, 1);
    expect(open.check(recovery).opens).toBe(true);
    expect(tree(join(place.root, ".."))).toEqual(before);
  });

  it("a refused key is said as a person's sentence that names Lifestream or the recovery key, never the vault, and keeps its code", () => {
    const { place, slot } = keyed();
    const other = recoveryKey.text(randomBytes(32));
    const locked = new Vault(place);
    locked.start(NO_SLOT_KEY, 1);
    const unlocked = (() => {
      try {
        locked.unlock(randomBytes(32), 2);
      } catch (error) {
        return error as Refusal;
      }
      return null;
    })();
    expect([unlocked?.status, unlocked?.code]).toEqual([403, VAULT_KEY]);
    const open = new Vault(place);
    open.start({ key: slot, why: null }, 3);
    open.newRecovery(4, draftRecovery(4).recovery);
    const said = [
      refusal(() => recoveryKey.parse("ABCD EFGH")),
      refusal(() => locked.recover(other, null, 5)),
      unlocked!.words,
      refusal(() => open.confirm(other, 6)),
    ];
    expect(said).toEqual([
      "That isn't a recovery key: a recovery key is 52 letters A–Z and digits 2–7, in groups of four.",
      "That isn't your recovery key: nothing was changed.",
      "The key this Mac offered doesn't open Lifestream: nothing was changed.",
      "That isn't the new recovery key: make a new key and save that one.",
    ]);
    for (const words of said) expect(words).toMatch(/^[A-Z][^]*\.$/u);
    for (const words of said) expect(words).not.toMatch(/vault/iu);
  });

  it("a locked home's why, after an unlock with a key that opens nothing, says that key does not open it, not that no key was handed", () => {
    const { place } = keyed();
    const vault = new Vault(place);
    vault.start(NO_SLOT_KEY, 1);
    expect(vault.state().why).toBe("This Mac didn't hand Lifestream its key when it started.");
    expect(refusal(() => vault.unlock(randomBytes(32), 2))).toMatch(/^\[VAULT_KEY\]/u);
    expect(vault.state()).toMatchObject({ locked: true, why: "This Mac's key doesn't open Lifestream." });
  });

  it("vault-slot adds this Mac's new slot, with this home's account, and removes its old one; refused while locked", () => {
    const { place, slot } = keyed();
    const fresh = randomBytes(32);
    expect(refusal(() => new Vault(place).addSlot(slotOf(fresh), 1))).toBe("the vault is locked: open it with its recovery key before adding a slot");
    const open = new Vault(place);
    open.start({ key: slot, why: null }, 1);
    expect(open.addSlot(slotOf(fresh), 2)).toEqual({ slot: `m-${keyId(fresh)}`, removed: [`m-${keyId(slot)}`] });
    const file = json(vaultPath(place.root)) as { counter: number; slots: { id: string; account?: string }[] };
    expect(file.counter).toBe(2);
    expect(file.slots.map(({ id, account }) => ({ id, account }))).toEqual([{ id: "r-1", account: undefined }, { id: `m-${keyId(fresh)}`, account: `machine:${HOME_ID}` }]);
    expect(new Vault(place).start({ key: slot, why: null }, 3)).not.toBeNull();
    expect(new Vault(place).start({ key: fresh, why: null }, 4)).toBeNull();
  });

  it("vault-init and vault-new are refused on a keyed folder by its bytes, whatever its version says", () => {
    const { place, slot } = keyed();
    const edited = { ...json(vaultPath(place.root)), version: 1 };
    writeFileSync(vaultPath(place.root), `${JSON.stringify(edited)}\n`);
    rmSync(copyOf(place));
    const before = bytes(vaultPath(place.root));
    const encrypted = "this home's vault keeps more than passwords, and none of it opens without its recovery key: no new vault is made over it";
    expect(refusal(() => new Vault(place).newVault(slotOf(slot), 1))).toBe(encrypted);
    expect(refusal(() => new Vault(place).init({ machine: slotOf(slot), key: null }, 1))).toMatch(/encrypted/u);
    expect(bytes(vaultPath(place.root))).toBe(before);

    const passwords = placeOf();
    new Vault(passwords).init({ machine: slotOf(randomBytes(32)), key: null }, 1);
    const swapped = placeOf();
    keyedStore(swapped);
    writeFileSync(vaultPath(swapped.root), bytes(vaultPath(passwords.root)));
    expect(refusal(() => new Vault(swapped).newVault(slotOf(randomBytes(32)), 2))).toBe(encrypted);
    expect(new Vault(swapped).state().keyed).toBe(true);
  });

  it("the hand-off's errors never repeat what it was handed", () => {
    const slot = randomBytes(32).toString("hex");
    const recovery = draftRecovery(1).recovery;
    for (const line of [`{"home_id": "${HOME_ID}", "slot_key": "${slot}", "recovery": "${recovery}"`, JSON.stringify({ home_id: "not an id", slot_key: slot, recovery }), JSON.stringify({ home_id: HOME_ID, slot_key: slot.slice(2), recovery }), JSON.stringify({ home_id: HOME_ID, slot_key: slot, recovery: recovery.slice(5) }), JSON.stringify({ home_id: HOME_ID, slot_key: slot, recovery, more: slot })]) {
      const said = refusal(() => readHandoff(line));
      expect(said).not.toBe("answered");
      expect(said).not.toContain(slot.slice(8, 40));
      expect(said).not.toContain(recovery.slice(5, 20));
    }
  });
});

describe("adopt --keyed", () => {
  it("writes the vault and its copy before HOME.json, and the home id for the launcher", async () => {
    const dir = base();
    const at = machineAt(dir);
    const folder = join(dir, "home");
    const { handed, slot } = handoffOf();
    const seen: { vault: boolean; copy: boolean; home: boolean }[] = [];
    const now = () => {
      seen.push({ vault: existsSync(vaultPath(folder)), copy: existsSync(join(at.dir, "vaults", `${HOME_ID}.json`)), home: existsSync(join(folder, "HOME.json")) });
      return 100;
    };
    const adopted = await adopt(folder, { machine: at, now, keyed: handed, fileSystem: () => "apfs", platform: "darwin" });
    expect(adopted).toMatchObject({ folder, id: HOME_ID, as: "new", vault: { slot: `m-${keyId(slot)}`, recovery_slot: "r-1" } });
    expect(seen).toContainEqual({ vault: true, copy: true, home: false });
    expect(seen.every((each) => !each.home || each.vault)).toBe(true);
    expect(JSON.parse(bytes(join(folder, "HOME.json")))).toMatchObject({ id: HOME_ID });
    expect(bytes(join(at.dir, "home-id"))).toBe(`${HOME_ID}\n`);
    expect(look(folder, { machine: at }).folder).toMatchObject({ form: "keyed", id: HOME_ID });
    expect(new Vault({ root: folder, machine: at.dir, home: HOME_ID }).start({ key: slot, why: null }, 101)).toBeNull();
  });

  it("refuses a folder that holds a home, and leaves it as it is", async () => {
    const dir = base();
    const at = machineAt(dir);
    const folder = join(dir, "home");
    const plain = await adopt(folder, { machine: at, fileSystem: () => "apfs", platform: "darwin" });
    expect(bytes(join(at.dir, "home-id"))).toBe(`${plain.id}\n`);
    expect(look(folder, { machine: at }).folder).toMatchObject({ form: "plain", id: plain.id });
    const before = tree(folder);
    await expect(adopt(folder, { machine: at, keyed: handoffOf().handed, fileSystem: () => "apfs", platform: "darwin" })).rejects.toThrow("this folder holds Lifestream already; it stays as it is");
    expect(tree(folder)).toEqual(before);

    for (const part of ["home.db", "blobs", "days"]) {
      const other = join(dir, `with-${part}`);
      mkdirSync(other);
      if (part === "home.db") writeFileSync(join(other, part), "");
      else mkdirSync(join(other, part));
      expect(look(other, { machine: at }).folder).toMatchObject({ form: "plain", id: null });
      await expect(adopt(other, { machine: at, keyed: handoffOf().handed, fileSystem: () => "apfs", platform: "darwin" })).rejects.toThrow("this folder holds Lifestream already; it stays as it is");
      expect(existsSync(vaultPath(other))).toBe(false);
    }
  });

  it("replaces a vault with no home beside it: the one written last opens it", async () => {
    const dir = base();
    const at = machineAt(dir);
    const folder = join(dir, "home");
    mkdirSync(join(folder, "config"), { recursive: true });
    const cut = handoffOf();
    makeKeyedVault({ root: folder, machine: at.dir, home: HOME_ID }, cut.handed, UNIT, 1);
    expect(look(folder, { machine: at }).folder).toMatchObject({ form: "empty", id: null });
    const next = handoffOf("1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d");
    const adopted = await adopt(folder, { machine: at, keyed: next.handed, fileSystem: () => "apfs", platform: "darwin" });
    expect(adopted.id).toBe("1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d");
    const place = { root: folder, machine: at.dir, home: adopted.id };
    expect(new Vault(place).check(next.recovery).opens).toBe(true);
    expect(new Vault(place).check(cut.recovery).opens).toBe(false);
    expect(new Vault(place).start({ key: next.slot, why: null }, 2)).toBeNull();
    expect([existsSync(join(at.dir, "vaults", `${HOME_ID}.json`)), existsSync(join(at.dir, "vaults", `${adopted.id}.json`))]).toEqual([false, true]);
  });
});

describe("the verbs at a terminal", () => {
  it("machine <folder> answers empty for a folder with no home", () => {
    const dir = base();
    expect(look(join(dir, "nothing"), { machine: machineAt(dir) }).folder).toMatchObject({ form: "empty", id: null });
  });

  it("machine <folder> throws on a home whose form does not read, where it answers refused", () => {
    const dir = base();
    const folder = join(dir, "home");
    mkdirSync(join(folder, "days"), { recursive: true });
    symlinkSync("loop", join(folder, "loop"));
    expect(look(folder, { machine: machineAt(dir) }).folder).toMatchObject({ form: "empty", refused: expect.stringContaining("does not read") });
  });

  it("keys draft prints one new recovery key, its slot and day, and writes nothing", async () => {
    const dir = base();
    const before = tree(dir);
    const out: string[] = [];
    expect(await runCli(["keys", "draft"], { write: (text) => out.push(text), now: () => 1_700_000_000_000 })).toBe(0);
    const drafted = JSON.parse(out.join("")) as { recovery: string; slot: string; number: number; made_ms: number };
    expect(drafted).toEqual({ recovery: expect.stringMatching(/^([A-Z2-7]{4} ){12}[A-Z2-7]{4}$/u), slot: "r-1", number: 1, made_ms: 1_700_000_000_000 });
    expect(recoveryKey.parse(drafted.recovery)).toHaveLength(32);
    expect(tree(dir)).toEqual(before);
  });

  it("adopt --keyed takes its keys on standard input only: none is in argv, the environment, the answer, or a plain file", async () => {
    const dir = base();
    const at = machineAt(dir);
    const folder = join(dir, "home");
    const slot = randomBytes(32);
    const recovery = draftRecovery(1).recovery;
    const line = JSON.stringify({ home_id: HOME_ID, slot_key: slot.toString("hex"), recovery });
    const argv = ["adopt", folder, "--keyed"];
    const out: string[] = [];
    expect(await runCli(argv, { write: (text) => out.push(text), input: async () => line, machine: at })).toBe(0);
    const secrets = [slot.toString("hex"), slot.toString("base64"), recovery, recovery.replace(/ /gu, "")];
    const answer = out.join("");
    expect(JSON.parse(answer)).toMatchObject({ id: HOME_ID, as: "new" });
    for (const secret of secrets) {
      expect(answer).not.toContain(secret);
      expect(argv.join(" ")).not.toContain(secret);
      expect(Object.values(process.env).some((value) => value?.includes(secret) === true)).toBe(false);
      for (const [path, held] of Object.entries({ ...tree(folder), ...tree(at.dir) })) expect(held.includes(secret), path).toBe(false);
    }

    const refused: string[] = [];
    expect(await runCli(["adopt", join(dir, "other"), "--keyed"], { write: (text) => refused.push(text), input: async () => "", machine: at })).toBe(1);
    expect(refused.join("")).toContain("--keyed is made by the Lifestream app's first run");
    expect(existsSync(join(dir, "other"))).toBe(false);
  });
});
