import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { flush, formOf, homeSecrets, isObject, KEY_BYTES, Keys, makeUnder, keyId, openBytes, openKey, sealBytes, SecretError, storeStamp, wrapKey, type Form, type HomeSecrets, type Json } from "@lifestreamprotocol/core";
import { failpoint } from "./failpoint.js";
import { Refusal } from "./refusal.js";


export type SlotStore = "keychain-login" | "keychain-data-protection" | "systemd-tpm2";

export interface Slot {
  id: string;
  kind: "machine" | "recovery";
  unit?: string;
  store?: SlotStore;
  account?: string;
  number?: number;
  made_ms: number;
  confirmed_ms?: number;
  wrapped: string;
}

export interface PasswordVault {
  version: 1;
  key_id: string;
  slots: Slot[];
}

export interface KeyedVault {
  version: 2;
  counter: number;
  key_id: string;
  slots: Slot[];
  keys: WrappedKey[];
}

export interface WrappedKey {
  kind: "data";
  id: number;
  made_ms: number;
  wrapped: string;
}

export type VaultFile = PasswordVault | KeyedVault;

export interface VaultPlace {
  readonly root: string;
  readonly machine: string;
  readonly home: string;
}

export interface Drafted {
  recovery: string;
  slot: "r-1";
  number: 1;
  made_ms: number;
}

export interface KeyedHandoff {
  home_id: string;
  slot_key: Buffer;
  recovery: Buffer;
}

export interface MadeKeyed {
  key_id: string;
  slot: string;
  recovery_slot: "r-1";
}

export interface Checked {
  opens: boolean;
  slot: string;
  number: number;
  made_ms: number;
  confirmed_ms: number | null;
}

export interface Opened {
  by: "start" | "unlock" | "recover" | "init";
  slot: string;
  at_ms: number;
}

export interface MadeRecovery {
  recovery_slot: string;
  made_ms: number;
  recovery: string;
}

export interface AddedRecovery {
  recovery_slot: string;
  number: number;
  made_ms: number;
}

export interface FolderKeys {
  keys: Keys;
  vault: string;
}

export type Opening = { form: "plain" } | ({ form: "keyed" } & FolderKeys) | { form: "locked"; why: string };

export interface MadeVault extends MadeRecovery {
  key_id: string;
  slot: string | null;
}

export class VaultError extends Error {
  override name = "VaultError";
}

const STORES: ReadonlySet<string> = new Set<SlotStore>(["keychain-login", "keychain-data-protection", "systemd-tpm2"]);
export const LOCKED_SINCE = "vault:locked-since";
export const REFUSED_AT = "vault:refused-at";
export const UNSEALED = "vault:unsealed";
export const VAULT_FD = "LIFESTREAM_VAULT_FD";
export const CREDENTIAL = "vault-machine";
export const VAULT_KEY = "VAULT_KEY";
export const OTHER_MAC_KEY = "The key this Mac offered doesn't open Lifestream: nothing was changed";

export function vaultPath(root: string): string {
  return join(root, "config", "vault.json");
}

export function readVault(root: string): VaultFile | null {
  const text = textAt(vaultPath(root));
  return text === null ? null : vaultOf(text, "config/vault.json");
}

function textAt(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function vaultOf(text: string, named: string): VaultFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new VaultError(`${named} does not read as JSON`);
  }
  if (!isObject(value)) throw new VaultError(`${named} is not a vault this release reads (not an object)`);
  const vault = value as Partial<KeyedVault> | Partial<PasswordVault>;
  if ((vault.version !== 1 && vault.version !== 2) || typeof vault.key_id !== "string" || !/^[0-9a-f]{8}$/u.test(vault.key_id) || !Array.isArray(vault.slots)) {
    throw new VaultError(`${named} is not a vault this release reads (version 1, key_id, slots)`);
  }
  if (vault.version === 2 && (!Number.isSafeInteger(vault.counter) || vault.counter! < 1 || !Array.isArray(vault.keys) || !(vault.keys as Partial<WrappedKey>[]).every(wrappedKey) || !vault.keys.some((key) => key.kind === "data" && key.id === 1))) {
    throw new VaultError(`${named} is not a vault this release reads (version 2, counter, data key 1)`);
  }
  for (const slot of vault.slots as Partial<Slot>[]) {
    if (!isObject(slot)) throw new VaultError(`${named} holds a slot this release does not read (not an object)`);
    const machine = slot.kind === "machine" && typeof slot.store === "string" && STORES.has(slot.store) && /^m-[0-9a-f]{8}$/u.test(slot.id ?? "") && (slot.account === undefined || typeof slot.account === "string");
    const recovery = slot.kind === "recovery" && /^r-[1-9][0-9]*$/u.test(slot.id ?? "") && (vault.version === 1 || slot.number === Number(slot.id!.slice(2)));
    if ((!machine && !recovery) || typeof slot.wrapped !== "string" || typeof slot.made_ms !== "number") {
      throw new VaultError(`${named} holds a slot this release does not read (${JSON.stringify(slot.id ?? null)})`);
    }
  }
  return vault as VaultFile;
}

function wrappedKey(key: Partial<WrappedKey>): boolean {
  return isObject(key) && key.kind === "data" && Number.isSafeInteger(key.id) && key.id! >= 1 && typeof key.made_ms === "number" && typeof key.wrapped === "string";
}

export function draftRecovery(now_ms: number): Drafted {
  return { recovery: recoveryKey.text(randomBytes(KEY_BYTES)), slot: "r-1", number: 1, made_ms: now_ms };
}

export function readHandoff(line: string): KeyedHandoff {
  const refused = (what: string): never => fail(`adopt --keyed reads one line on its standard input, {"home_id", "slot_key", "recovery"}: ${what}`);
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return refused("it does not read as JSON");
  }
  if (!isObject(value)) return refused("it is not an object");
  const { home_id, slot_key, recovery, ...rest } = value;
  if (Object.keys(rest).length > 0) refused("it holds more than those three");
  if (typeof home_id !== "string" || !HOME_ID.test(home_id)) refused("home_id is not a home's id");
  if (typeof slot_key !== "string" || !/^[0-9a-fA-F]{64}$/u.test(slot_key)) refused(`slot_key is not ${KEY_BYTES} bytes of hex`);
  if (typeof recovery !== "string") refused("recovery is not a recovery key's text");
  let parsed: Buffer;
  try {
    parsed = recoveryKey.parse(recovery as string);
  } catch (error) {
    return refused((error as Error).message);
  }
  return { home_id: home_id as string, slot_key: Buffer.from(slot_key as string, "hex"), recovery: parsed };
}

export function makeKeyedVault(place: VaultPlace, handed: KeyedHandoff, unit: string, now_ms: number): MadeKeyed {
  const vaultKey = randomBytes(KEY_BYTES);
  const dataKey = randomBytes(KEY_BYTES);
  try {
    const vault: KeyedVault = { version: 2, counter: 1, key_id: keyId(vaultKey), slots: [], keys: [] };
    const slot = addMachine(vault, vaultKey, { key: handed.slot_key, store: "keychain-login", unit }, place.home, now_ms);
    vault.slots.push({ ...made(vault, vaultKey, handed.recovery, { id: "r-1", kind: "recovery", number: 1 }, now_ms), confirmed_ms: now_ms });
    vault.keys.push({ kind: "data", id: 1, made_ms: now_ms, wrapped: wrapKey(vaultKey, "data", 1, dataKey).toString("base64") });
    const replaced = copiesNamedIn(place.root).filter((home) => home !== place.home);
    writeBoth(place, vault);
    for (const home of replaced) rmSync(copyPath({ ...place, home }), { force: true });
    return { key_id: vault.key_id, slot, recovery_slot: "r-1" };
  } finally {
    vaultKey.fill(0);
    dataKey.fill(0);
  }
}

export function openWith(vault: VaultFile, kind: Slot["kind"], slotKey: Uint8Array): { key: Buffer; slot: Slot } | null {
  for (const slot of vault.slots) {
    if (slot.kind !== kind) continue;
    const key = unwrap(slot, vault.key_id, slotKey);
    if (key !== null) return { key, slot };
  }
  return null;
}

export const recoveryKey = {
  text(key: Uint8Array): string {
    let bits = 0;
    let value = 0;
    let out = "";
    for (const byte of key) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        out += BASE32[(value >>> (bits - 5)) & 31];
        bits -= 5;
      }
    }
    if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
    return out.match(/.{1,4}/gu)!.join(" ");
  },
  parse(typed: string): Buffer {
    const plain = typed.replace(/[\s-]/gu, "").toUpperCase();
    const refused = new VaultError("That isn't a recovery key: a recovery key is 52 letters A–Z and digits 2–7, in groups of four.");
    if (!/^[A-Z2-7]{52}$/u.test(plain)) throw refused;
    const bytes: number[] = [];
    let bits = 0;
    let value = 0;
    for (const char of plain) {
      value = ((value << 5) | BASE32.indexOf(char)) & 0xfff;
      bits += 5;
      if (bits >= 8) {
        bytes.push((value >>> (bits - 8)) & 0xff);
        bits -= 8;
      }
    }
    const key = Buffer.from(bytes.slice(0, KEY_BYTES));
    if (recoveryKey.text(key).replace(/ /gu, "") !== plain) throw refused;
    return key;
  },
};

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const HOME_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;
export const ENCRYPTED = "this home's vault keeps more than passwords, and none of it opens without its recovery key: no new vault is made over it";

export interface SlotHanded {
  readonly key: Buffer | null;
  readonly why: string | null;
}

export const NO_SLOT_KEY: SlotHanded = { key: null, why: "no machine slot's key was handed at start" };

export function takeSlotKey(env: NodeJS.ProcessEnv = process.env): SlotHanded {
  const named = env[VAULT_FD];
  delete env[VAULT_FD];
  if (named !== undefined) {
    if (named !== "3") return { key: null, why: `${VAULT_FD} names ${JSON.stringify(named)}: only fd 3 is read` };
    const chunks: Buffer[] = [];
    try {
      const buffer = Buffer.alloc(KEY_BYTES + 1);
      for (let total = 0; total <= KEY_BYTES; ) {
        const read = readSync(3, buffer);
        if (read === 0) break;
        chunks.push(Buffer.from(buffer.subarray(0, read)));
        total += read;
      }
    } catch (error) {
      return { key: null, why: `fd 3 does not read (${(error as NodeJS.ErrnoException).code ?? "unknown"})` };
    }
    closeSync(3);
    return slotKeyOf(Buffer.concat(chunks), "fd 3");
  }
  const credentials = env.CREDENTIALS_DIRECTORY;
  if (credentials !== undefined && credentials !== "") {
    try {
      return slotKeyOf(readFileSync(join(credentials, CREDENTIAL)), `the ${CREDENTIAL} credential`);
    } catch (error) {
      return { key: null, why: `the unit loaded no readable ${CREDENTIAL} credential (${(error as NodeJS.ErrnoException).code ?? "unknown"})` };
    }
  }
  return NO_SLOT_KEY;
}

function slotKeyOf(bytes: Buffer, from: string): SlotHanded {
  return bytes.length === KEY_BYTES ? { key: bytes, why: null } : { key: null, why: `${from} held ${bytes.length} bytes, not a ${KEY_BYTES}-byte key` };
}

export interface VaultState {
  keyed: boolean;
  key_id: string | null;
  locked: boolean;
  why?: string;
  opened: Opened | null;
  migrate: { key_id: string } | null;
  recovery: "none" | "unconfirmed" | "confirmed";
  slots: Omit<Slot, "wrapped">[];
  plain: string[];
  unreadable?: string;
}

export interface NewMachineSlot {
  key: Buffer;
  store: SlotStore;
  unit: string | null;
}

export function recoverySaved(vault: VaultFile | null): VaultState["recovery"] {
  const recoveries = vault?.slots.filter((slot) => slot.kind === "recovery") ?? [];
  if (recoveries.length === 0) return "none";
  return recoveries.some((slot) => slot.confirmed_ms !== undefined) ? "confirmed" : "unconfirmed";
}

const LOCKED_WHY = {
  unhanded: "This Mac didn't hand Lifestream its key when it started.",
  unopened: "This Mac's key doesn't open Lifestream.",
} as const;

export class Vault {
  #key: Buffer | null = null;
  #keys: Keys | undefined;
  #opened: Opened | null = null;
  #kept = false;
  #form: Form | undefined;
  #keyId: string | undefined;
  #shut: keyof typeof LOCKED_WHY = "unhanded";

  constructor(
    readonly place: VaultPlace,
    readonly log: (said: Record<string, Json>) => void = () => {},
  ) {}

  get root(): string {
    return this.place.root;
  }

  get key(): Buffer | null {
    return this.#key;
  }

  get keys(): Keys | undefined {
    return this.#keys;
  }

  get form(): Form {
    return (this.#form ??= formOf(this.root));
  }

  get folderKeys(): FolderKeys | undefined {
    return this.#keys === undefined ? undefined : { keys: this.#keys, vault: this.#keyId! };
  }

  get opened(): Opened | null {
    return this.#opened;
  }

  get kept(): boolean {
    return this.#key !== null && this.#kept;
  }

  sealable(): Buffer {
    if (this.kept) return this.#key!;
    if (this.#key !== null) throw new SecretError("Passwords are locked until the recovery key is confirmed", "locked");
    let exists = true;
    try {
      exists = readVault(this.root) !== null;
    } catch {
    }
    if (!exists) throw new SecretError("No vault yet: make your recovery key in the Lifestream app first", "locked");
    throw new SecretError("Passwords are locked on this Mac", "locked");
  }

  get(name: string): string | undefined {
    this.sealable();
    return this.#secrets().get(name);
  }

  seal(name: string, value: string): string {
    const key = this.sealable();
    this.#secrets().set(name, value);
    return keyId(key);
  }

  rotate(name: string, value: string): void {
    this.sealable();
    this.#secrets().rotate(name, value);
  }

  held(name: string): boolean {
    if (!this.kept) return false;
    const item = this.#secrets().list().find((each) => each.name === name);
    return item?.unreadable === undefined && item !== undefined && (item.sealed === null || item.sealed === keyId(this.#key!));
  }

  names(): string[] {
    return this.#secrets().list().map((item) => item.name);
  }

  remove(name: string): void {
    this.#secrets().remove(name);
  }

  #secrets(): HomeSecrets {
    const dir = join(this.root, "config", "secrets");
    makeUnder(this.root, dir, 0o700);
    return homeSecrets(dir, this.#key === null ? {} : { key: this.#key });
  }

  start(handed: SlotHanded, now_ms: number): string | null {
    sweepTemporaries(dirname(vaultPath(this.root)), "vault.json.");
    if (HOME_ID.test(this.place.home)) sweepTemporaries(join(this.place.machine, VAULTS), `${this.place.home}.json.`);
    const settled = this.#settled();
    const why = this.#opening(settled, handed, now_ms);
    if (why === null) this.#mend(settled.mend);
    return why;
  }

  open(handed: SlotHanded, now_ms: number): Opening {
    if (this.form === "plain") return { form: "plain" };
    const why = this.#keys === undefined ? this.#opening(this.#settled(), handed, now_ms) : null;
    const keys = this.folderKeys;
    return keys === undefined ? { form: "locked", why: why ?? "no key has opened the vault" } : { form: "keyed", ...keys };
  }

  #opening(settled: Settled, handed: SlotHanded, now_ms: number): string | null {
    this.#shut = handed.key === null ? "unhanded" : "unopened";
    if (settled.vault === null) return settled.why ?? "no vault is made yet";
    if (handed.key === null) return handed.why ?? NO_SLOT_KEY.why!;
    const opened = openWith(settled.vault, "machine", handed.key);
    if (opened === null) return "the key handed at start opens no machine slot of this vault";
    try {
      this.#hold(settled.vault, opened.key, { by: "start", slot: opened.slot.id, at_ms: now_ms });
    } catch (error) {
      if (error instanceof VaultError) return error.message;
      throw error;
    }
    return null;
  }

  state(): VaultState {
    const settled = this.#settled();
    const vault = settled.vault;
    let unreadable = settled.vault === null ? settled.why : null;
    const items = homeSecrets(join(this.root, "config", "secrets")).list();
    const unreadItems = items.flatMap((item) => item.unreadable === undefined ? [] : [item.unreadable]);
    if (unreadItems.length > 0) unreadable = [unreadable, ...unreadItems].filter(Boolean).join("; ");
    const sealedBy = new Map<string, number>();
    for (const item of items) if (typeof item.sealed === "string") sealedBy.set(item.sealed, (sealedBy.get(item.sealed) ?? 0) + 1);
    const most = [...sealedBy].sort((a, b) => b[1] - a[1])[0]?.[0];
    const keyed = this.#isKeyed();
    return {
      keyed,
      key_id: vault?.key_id ?? null,
      locked: this.#key === null,
      ...(keyed && this.#key === null ? { why: LOCKED_WHY[this.#shut] } : {}),
      opened: this.#opened,
      migrate: vault === null && unreadable === null && most !== undefined ? { key_id: most } : null,
      recovery: recoverySaved(vault),
      slots: (vault?.slots ?? []).map(({ wrapped: _wrapped, ...slot }) => (slot.kind === "recovery" ? { ...slot, number: numberOf(slot) } : slot)),
      plain: items.filter((item) => item.sealed === null).map((item) => item.name),
      ...(unreadable === null ? {} : { unreadable }),
    };
  }

  unlock(slotKey: Buffer, now_ms: number): string {
    const settled = this.#settled();
    const vault = this.#found(settled);
    const opened = openWith(vault, "machine", slotKey);
    if (opened === null) {
      this.#shut = "unopened";
      throw new Refusal(403, VAULT_KEY, `${OTHER_MAC_KEY}.`);
    }
    if (this.#key === null) this.#hold(vault, opened.key, { by: "unlock", slot: opened.slot.id, at_ms: now_ms });
    this.#mend(settled.mend);
    return vault.key_id;
  }

  init(options: { machine: NewMachineSlot | null; key: Buffer | null }, now_ms: number): MadeVault {
    if (this.#isKeyed()) fail("this home is encrypted: its vault is made with the home alone, and opens with this Mac's key or its recovery key");
    if (readVault(this.root) !== null) throw new VaultError("a vault exists in this folder: unlock it, or recover it with its recovery key");
    const items = this.#secrets().list();
    const unreadable = items.find((item) => item.unreadable !== undefined);
    if (options.key !== null && unreadable !== undefined) throw new VaultError(unreadable.unreadable);
    const sealedBy = [...new Set(items.flatMap((item) => (typeof item.sealed === "string" ? [item.sealed] : [])))];
    if (options.key !== null && !sealedBy.includes(keyId(options.key))) {
      throw new VaultError(`the key handed (${keyId(options.key)}) is not the key this folder's passwords are sealed by${sealedBy.length === 0 ? " (none is sealed)" : ` (${sealedBy.join(", ")})`}`);
    }
    return this.#make(options.key ?? randomBytes(KEY_BYTES), options.machine, now_ms, 1);
  }

  newVault(machine: NewMachineSlot | null, now_ms: number): { opened: string } | { made: MadeVault; removed: string[] } {
    if (this.#isKeyed()) fail(ENCRYPTED);
    let vault: VaultFile | null;
    try {
      vault = readVault(this.root);
    } catch (error) {
      const version = storedVersion(this.root);
      if (version !== undefined && version !== 1) fail(ENCRYPTED);
      throw error;
    }
    if (vault === null) fail("no vault is made yet: make one, and its recovery key, instead");
    if (this.#key !== null) fail("passwords are open: nothing is lost; make a new recovery key in Settings instead");
    const opened = machine === null ? null : openWith(vault, "machine", machine.key);
    if (opened !== null) {
      this.#hold(vault, opened.key, { by: "unlock", slot: opened.slot.id, at_ms: now_ms });
      return { opened: vault.key_id };
    }
    const next = 1 + Math.max(0, ...vault.slots.filter((slot) => slot.kind === "recovery").map(numberOf));
    const secrets = this.#secrets();
    const removed = secrets.list().flatMap((item) => (typeof item.sealed === "string" ? [item.name] : []));
    for (const name of removed) secrets.remove(name);
    return { made: this.#make(randomBytes(KEY_BYTES), machine, now_ms, next), removed };
  }

  newRecovery(now_ms: number, drafted?: unknown): MadeRecovery | AddedRecovery {
    const vault = this.#found(this.#settled());
    const key = this.#key ?? fail("passwords are locked: unlock the vault before making a new recovery key");
    const keyed = this.#isKeyed();
    if (!keyed && drafted !== undefined) throw new Refusal(400, "BAD_CALL", "this home is not encrypted: it makes its own recovery key, so vault-recovery on it is handed none (recovery)");
    if (keyed && typeof drafted !== "string") fail("this home is encrypted: a new recovery key is drafted (keys draft), shown, then handed in the request as recovery; the home makes none");
    const recovery = keyed ? recoveryKey.parse(drafted as string) : randomBytes(KEY_BYTES);
    vault.slots = vault.slots.filter((slot) => slot.kind !== "recovery" || slot.confirmed_ms !== undefined);
    const next = 1 + Math.max(0, ...vault.slots.filter((slot) => slot.kind === "recovery").map(numberOf));
    const slot = made(vault, key, recovery, { id: `r-${next}`, kind: "recovery", ...(vault.version === 2 ? { number: next } : {}) }, now_ms);
    vault.slots.push(slot);
    save(this.place, vault);
    if (keyed) {
      recovery.fill(0);
      return { recovery_slot: slot.id, number: next, made_ms: slot.made_ms };
    }
    return { recovery_slot: slot.id, made_ms: slot.made_ms, recovery: recoveryKey.text(recovery) };
  }

  discard(): { dropped: number[] } {
    const settled = this.#settled();
    if (settled.vault === null && settled.why === null) return { dropped: [] };
    const vault = this.#found(settled);
    const waiting = vault.slots.filter((slot) => slot.kind === "recovery" && slot.confirmed_ms === undefined);
    if (waiting.length === 0) return { dropped: [] };
    vault.slots = vault.slots.filter((slot) => !waiting.includes(slot));
    save(this.place, vault);
    return { dropped: waiting.map(numberOf) };
  }

  confirm(typed: string, now_ms: number): string {
    const vault = this.#found(this.#settled());
    const waiting = vault.slots.find((slot) => slot.kind === "recovery" && slot.confirmed_ms === undefined) ?? fail("no new recovery key waits to be confirmed");
    const opened = openWith({ ...vault, slots: [waiting] }, "recovery", recoveryKey.parse(typed)) ?? fail("That isn't the new recovery key: make a new key and save that one.");
    if (this.#key === null) this.#hold(vault, opened.key, { by: "recover", slot: opened.slot.id, at_ms: now_ms });
    opened.slot.confirmed_ms = now_ms;
    vault.slots = vault.slots.filter((slot) => slot.kind !== "recovery" || slot === opened.slot);
    save(this.place, vault);
    this.#kept = true;
    return opened.slot.id;
  }

  recover(typed: string, machine: NewMachineSlot | null, now_ms: number): { key_id: string; slot: string | null; recovery: string } {
    const settled = this.#settled();
    const vault = this.#found(settled);
    const opened = openWith(vault, "recovery", recoveryKey.parse(typed));
    if (opened === null) throw new VaultError("That isn't your recovery key: nothing was changed.");
    if (this.#key === null) this.#hold(vault, opened.key, { by: "recover", slot: opened.slot.id, at_ms: now_ms });
    let changed = false;
    if (opened.slot.confirmed_ms === undefined) {
      opened.slot.confirmed_ms = now_ms;
      vault.slots = vault.slots.filter((slot) => slot.kind !== "recovery" || slot === opened.slot);
      changed = true;
    }
    let slot: string | null = null;
    if (machine !== null) {
      vault.slots = vault.slots.filter((each) => !thisMachine(each, machine));
      slot = addMachine(vault, opened.key, machine, this.place.home, now_ms);
      changed = true;
    }
    if (changed) save(this.place, vault);
    else this.#mend(settled.mend);
    this.#kept = true;
    return { key_id: vault.key_id, slot, recovery: opened.slot.id };
  }

  addSlot(machine: NewMachineSlot, now_ms: number): { slot: string; removed: string[] } {
    const key = this.#key ?? fail("the vault is locked: open it with its recovery key before adding a slot");
    const vault = this.#found(this.#settled());
    const removed = vault.slots.filter((each) => thisMachine(each, machine)).map((each) => each.id);
    vault.slots = vault.slots.filter((each) => !thisMachine(each, machine));
    const slot = addMachine(vault, key, machine, this.place.home, now_ms);
    save(this.place, vault);
    return { slot, removed: removed.filter((id) => id !== slot) };
  }

  check(typed: string): Checked {
    const vault = this.#found(this.#settled());
    const recoveries = vault.slots.filter((slot) => slot.kind === "recovery");
    if (recoveries.length === 0) fail("this vault holds no recovery key to check");
    const key = recoveryKey.parse(typed);
    const opened = recoveries.find((slot) => unwrap(slot, vault.key_id, key) !== null);
    const named = opened ?? recoveries.find((slot) => slot.confirmed_ms !== undefined) ?? recoveries.at(-1)!;
    return { opens: opened !== undefined, slot: named.id, number: numberOf(named), made_ms: named.made_ms, confirmed_ms: named.confirmed_ms ?? null };
  }

  sealPlain(): { sealed: string[]; failed: { name: string; why: string }[] } | null {
    const done = { sealed: [] as string[], failed: [] as { name: string; why: string }[] };
    const vault = this.#settled().vault;
    if (this.#key === null || !vault?.slots.some((slot) => slot.kind === "recovery" && slot.confirmed_ms !== undefined)) return null;
    const secrets = this.#secrets();
    for (const item of secrets.list()) {
      if (item.unreadable !== undefined) {
        done.failed.push({ name: item.name, why: item.unreadable });
        continue;
      }
      if (item.sealed !== null) continue;
      try {
        secrets.set(item.name, secrets.get(item.name)!);
      } catch (error) {
        done.failed.push({ name: item.name, why: (error as Error).message });
        continue;
      }
      done.sealed.push(item.name);
      failpoint("vault.sealed-one");
    }
    return done;
  }

  #make(key: Buffer, machine: NewMachineSlot | null, now_ms: number, number: number): MadeVault {
    const vault: PasswordVault = { version: 1, key_id: keyId(key), slots: [] };
    const slot = machine === null ? null : addMachine(vault, key, machine, this.place.home, now_ms);
    const recovery = randomBytes(KEY_BYTES);
    const recoverySlot = made(vault, key, recovery, { id: `r-${number}`, kind: "recovery" }, now_ms);
    vault.slots.push(recoverySlot);
    save(this.place, vault);
    this.#hold(vault, key, { by: "init", slot: slot ?? recoverySlot.id, at_ms: now_ms });
    return { key_id: vault.key_id, slot, recovery_slot: recoverySlot.id, made_ms: recoverySlot.made_ms, recovery: recoveryKey.text(recovery) };
  }

  #isKeyed(): boolean {
    return this.form === "keyed";
  }

  keepInFolder(): void {
    if (!("vault" in readCopy(this.place))) return;
    const settled = settleKeyed(this.place);
    if (settled.mend?.write === "folder") writeFolder(this.root, settled.mend.with);
    const kept = settlePlain(this.root).vault;
    if (settled.vault !== null && kept !== null && serialized(kept) === serialized(settled.vault)) return;
    fail(`this Mac holds the only copy of your home's vault that opens it (${settled.why ?? "config/vault.json does not match it"}): open Lifestream with its folder connected, then uninstall again`);
  }

  #settled(): Settled {
    return this.#isKeyed() ? settleKeyed(this.place) : settlePlain(this.root);
  }

  #found(settled: Settled): VaultFile {
    return settled.vault ?? fail(settled.why ?? "no vault is made in this folder yet");
  }

  #mend(mend: Mend | null | undefined): void {
    if (mend === null || mend === undefined) return;
    try {
      if (mend.write === "folder") writeFolder(this.root, mend.with);
      else writeCopy(this.place, mend.with);
    } catch (error) {
      this.log({ vault: "unmended", said: mend.said ?? `this Mac's copy of the vault was not written`, why: (error as Error).message });
      return;
    }
    if (mend.said !== null) this.log({ vault: "mended", said: mend.said });
  }

  #hold(vault: VaultFile, key: Buffer, opened: Opened): void {
    if (vault.version === 2) {
      const wrapped = vault.keys.find((each) => each.kind === "data" && each.id === 1)!;
      const data = openKey(key, "data", 1, Buffer.from(wrapped.wrapped, "base64"));
      if (data === null) fail("data key 1 does not open under this vault's key: config/vault.json is damaged");
      this.#keys = Keys.derive(data);
      this.#keyId = vault.key_id;
      data.fill(0);
    }
    this.#key = key;
    this.#opened = opened;
    this.#kept = opened.by !== "init" || opened.slot.startsWith("m-");
  }
}

interface Mend {
  write: "folder" | "copy";
  with: KeyedVault;
  said: string | null;
}

type Settled = { vault: VaultFile; mend: Mend | null; why?: undefined } | { vault: null; why: string | null; mend?: undefined };

const VAULTS = "vaults";
const MACHINE_ACCOUNT = "machine:";

function settlePlain(root: string): Settled {
  try {
    const vault = readVault(root);
    return vault === null ? { vault: null, why: null } : { vault, mend: null };
  } catch (error) {
    return { vault: null, why: (error as Error).message };
  }
}

function settleKeyed(place: VaultPlace): Settled {
  const read = settlePlain(place.root);
  const folder = read.vault?.version === 2 ? read.vault : null;
  const lost = read.vault === null ? read.why ?? "config/vault.json is missing" : folder === null ? "config/vault.json is a vault of passwords alone, and this home is encrypted" : null;
  const copy = readCopy(place);
  if (folder !== null) {
    if (!("vault" in copy)) return { vault: folder, mend: { write: "copy", with: folder, said: null } };
    const other = copy.vault;
    if (other.key_id === folder.key_id) {
      if (other.counter > folder.counter) {
        return { vault: other, mend: { write: "folder", with: other, said: `config/vault.json (counter ${folder.counter}) was older than this Mac's copy (counter ${other.counter}): put back from the copy` } };
      }
      return { vault: folder, mend: serialized(other) === serialized(folder) ? null : { write: "copy", with: folder, said: null } };
    }
    const stamped = stampedKeyId(place.root);
    if (stamped === other.key_id) {
      return { vault: other, mend: { write: "folder", with: other, said: `config/vault.json is of vault ${folder.key_id}, and config/stores.json names this Mac's copy, vault ${other.key_id}: put back from the copy` } };
    }
    if (stamped === folder.key_id) {
      return { vault: folder, mend: { write: "copy", with: folder, said: `this Mac's copy was of vault ${other.key_id}, and config/stores.json names config/vault.json's, vault ${folder.key_id}: the copy is written again from it` } };
    }
    return { vault: folder, mend: null };
  }
  if (!("vault" in copy)) return { vault: null, why: `${lost}, and ${copy.why}: the home stays locked until config/vault.json is put back` };
  const stamped = stampedKeyId(place.root);
  if (stamped !== copy.vault.key_id) {
    return {
      vault: null,
      why: `${lost}, and ${stamped === undefined ? `config/stores.json names no vault, so this Mac's copy (vault ${copy.vault.key_id}) is not put back` : `this Mac's copy is of vault ${copy.vault.key_id}, and config/stores.json names ${stamped}: it is not put back`}`,
    };
  }
  return { vault: copy.vault, mend: { write: "folder", with: copy.vault, said: `${lost}: put back from this Mac's copy (vault ${copy.vault.key_id}, counter ${copy.vault.counter})` } };
}

function readCopy(place: VaultPlace): { vault: KeyedVault } | { why: string } {
  let text: string | null;
  try {
    text = textAt(copyPath(place));
  } catch (error) {
    return { why: `this Mac's copy does not read (${(error as NodeJS.ErrnoException).code ?? "unknown"})` };
  }
  if (text === null) return { why: "this Mac keeps no copy of it" };
  try {
    const vault = vaultOf(text, "this Mac's copy");
    return vault.version === 2 ? { vault } : { why: "this Mac's copy is a vault of passwords alone" };
  } catch (error) {
    if (error instanceof VaultError) return { why: error.message };
    throw error;
  }
}

function stampedKeyId(root: string): string | undefined {
  return storeStamp(root)?.key_id ?? undefined;
}

function copyPath(place: VaultPlace): string {
  if (!HOME_ID.test(place.home)) fail(`this home's id (${JSON.stringify(place.home)}) names no copy of its vault`);
  return join(place.machine, VAULTS, `${place.home}.json`);
}

export function machineKeepsVaults(machine: string): boolean {
  try {
    return readdirSync(join(machine, VAULTS)).some((name) => name.endsWith(".json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function copiesNamedIn(root: string): string[] {
  let vault: VaultFile | null;
  try {
    vault = readVault(root);
  } catch {
    return [];
  }
  if (vault?.version !== 2) return [];
  return vault.slots.flatMap((slot) => (slot.kind === "machine" && slot.account?.startsWith(MACHINE_ACCOUNT) === true ? [slot.account.slice(MACHINE_ACCOUNT.length)] : [])).filter((home) => HOME_ID.test(home));
}

function numberOf(slot: Pick<Slot, "id" | "number">): number {
  return slot.number ?? Number(slot.id.slice(2));
}

function thisMachine(slot: Slot, machine: NewMachineSlot): boolean {
  return slot.kind === "machine" && slot.unit === (machine.unit ?? undefined) && slot.store === machine.store;
}

function storedVersion(root: string): unknown {
  try {
    return (JSON.parse(readFileSync(vaultPath(root), "utf8")) as { version?: unknown } | null)?.version;
  } catch {
    return undefined;
  }
}

function fail(message: string): never {
  throw new VaultError(message);
}

function addMachine(vault: VaultFile, key: Buffer, machine: NewMachineSlot, home: string, now_ms: number): string {
  if (machine.key.length !== KEY_BYTES) throw new VaultError(`a slot key is ${KEY_BYTES} bytes`);
  const id = `m-${keyId(machine.key)}`;
  vault.slots = vault.slots.filter((slot) => slot.id !== id);
  const account = vault.version === 2 ? { account: `${MACHINE_ACCOUNT}${home}` } : {};
  vault.slots.push(made(vault, key, machine.key, { id, kind: "machine", ...(machine.unit === null ? {} : { unit: machine.unit }), store: machine.store, ...account }, now_ms));
  return id;
}

function made(vault: VaultFile, key: Buffer, slotKey: Buffer, slot: Omit<Slot, "made_ms" | "wrapped">, now_ms: number): Slot {
  return { ...slot, made_ms: now_ms, wrapped: sealBytes(slotKey, associated(slot.id, vault.key_id), key).toString("base64") };
}

function unwrap(slot: Slot, id: string, slotKey: Uint8Array): Buffer | null {
  const key = openBytes(slotKey, associated(slot.id, id), Buffer.from(slot.wrapped, "base64"));
  return key !== null && key.length === KEY_BYTES && keyId(key) === id ? key : null;
}

function associated(slot: string, id: string): string {
  return `lifestream-vault:v1:${slot}:${id}`;
}

function save(place: VaultPlace, vault: VaultFile): void {
  if (vault.version === 1) return writeFolder(place.root, vault);
  vault.counter += 1;
  writeBoth(place, vault);
}

function writeBoth(place: VaultPlace, vault: KeyedVault): void {
  writeFolder(place.root, vault);
  writeCopy(place, vault);
}

function writeFolder(root: string, vault: VaultFile): void {
  const path = vaultPath(root);
  makeUnder(root, dirname(path), 0o700);
  writeWhole(path, vault);
}

function writeCopy(place: VaultPlace, vault: KeyedVault): void {
  const path = copyPath(place);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeWhole(path, vault);
}

function serialized(vault: VaultFile): string {
  return `${JSON.stringify(vault, null, 2)}\n`;
}

function writeWhole(path: string, vault: VaultFile): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, serialized(vault), { mode: 0o600, flag: "wx" });
    flush(temporary);
    failpoint("vault.renaming");
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  flush(dirname(path));
}

function sweepTemporaries(dir: string, prefix: string): void {
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    if (name.startsWith(prefix) && name.endsWith(".tmp")) rmSync(join(dir, name), { force: true });
  }
}
