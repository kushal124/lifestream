import { hkdfSync } from "node:crypto";
import { KEY_BYTES, keyId, openBytes, sealBytes } from "./secrets.js";

export type KeyLabel = `store:${string}` | "files" | "names" | "ask-pending";
export type WrappedKind = "data" | "backup";
export type KeyErrorCode = "LOCKED" | "NOT_HANDED" | "REFUSED";

const DERIVE_SALT = "lifestream-derive:v1";
const DERIVE_INFO = "lifestream-derive:v1:";
const WRAP_ASSOCIATED = "lifestream-key:v1:";
const HANDED_FORM = "lifestream-keys:v1";

const ROLE = /^[a-z][a-z0-9-]*$/u;
const HEX_KEY = /^[0-9a-f]{64}$/u;

export class KeyError extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && value.name === "KeyError";
  }

  constructor(
    readonly code: KeyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "KeyError";
  }
}

export type HandedKeys =
  | { form: typeof HANDED_FORM; data: string }
  | { form: typeof HANDED_FORM; keys: Partial<Record<KeyLabel, string>> };

let keyIn: (keys: Keys, label: KeyLabel) => Buffer;

export class Keys {
  readonly #data: Buffer | undefined;
  readonly #keys: Map<KeyLabel, Buffer>;

  static {
    keyIn = (keys, label) => keys.#of(label);
  }

  private constructor(data: Buffer | undefined, keys: Map<KeyLabel, Buffer>) {
    this.#data = data;
    this.#keys = keys;
  }

  static derive(dataKey: Uint8Array): Keys {
    assertKey(dataKey, "a data key");
    return new Keys(Buffer.from(dataKey), new Map());
  }

  static read(handed: unknown): Keys {
    if (typeof handed !== "object" || handed === null || Array.isArray(handed)) refuse("handed keys are not an object");
    const { form, keys: given, data, ...rest } = handed as Record<string, unknown>;
    if (form !== HANDED_FORM || Object.keys(rest).length > 0) refuse(`handed keys are not in the form ${HANDED_FORM}`);
    if ((data === undefined) === (given === undefined)) refuse("handed keys hold either the data key or derived keys");
    if (data !== undefined) {
      if (typeof data !== "string" || !HEX_KEY.test(data)) refuse(`the handed data key is not ${KEY_BYTES} bytes of hex`);
      return new Keys(Buffer.from(data, "hex"), new Map());
    }
    if (typeof given !== "object" || given === null || Array.isArray(given)) refuse("handed keys hold no keys object");
    const keys = new Map<KeyLabel, Buffer>();
    for (const [label, hex] of Object.entries(given)) {
      if (typeof hex !== "string" || !HEX_KEY.test(hex)) refuse(`the handed key ${label} is not ${KEY_BYTES} bytes of hex`);
      keys.set(assertLabel(label as KeyLabel), Buffer.from(hex, "hex"));
    }
    return new Keys(undefined, keys);
  }

  only(labels: readonly KeyLabel[]): Keys {
    return new Keys(undefined, new Map(labels.map((label) => [label, this.#of(label)])));
  }

  hand(): HandedKeys {
    if (this.#data !== undefined) return { form: HANDED_FORM, data: this.#data.toString("hex") };
    const keys: Partial<Record<KeyLabel, string>> = {};
    for (const label of [...this.#keys.keys()].sort()) keys[label] = this.#keys.get(label)!.toString("hex");
    return { form: HANDED_FORM, keys };
  }

  #of(label: KeyLabel): Buffer {
    assertLabel(label);
    let key = this.#keys.get(label);
    if (key === undefined && this.#data !== undefined) this.#keys.set(label, (key = deriveKey(this.#data, label)));
    if (key === undefined) throw new KeyError("NOT_HANDED", `this program was not handed the key ${label}`);
    return Buffer.from(key);
  }
}

export function keyBytesOf(keys: Keys, label: KeyLabel): Buffer {
  return keyIn(keys, label);
}

export function wrapKey(vaultKey: Uint8Array, kind: WrappedKind, id: number, key: Uint8Array): Buffer {
  assertKey(vaultKey, "a vault key");
  assertKey(key, `a ${kind} key`);
  return sealBytes(vaultKey, associated(vaultKey, kind, id), key);
}

export function openKey(vaultKey: Uint8Array, kind: WrappedKind, id: number, wrapped: Uint8Array): Buffer | null {
  assertKey(vaultKey, "a vault key");
  const opened = openBytes(vaultKey, associated(vaultKey, kind, id), wrapped);
  return opened !== null && opened.length === KEY_BYTES ? opened : null;
}

function deriveKey(dataKey: Uint8Array, label: KeyLabel): Buffer {
  return Buffer.from(hkdfSync("sha256", dataKey, Buffer.from(DERIVE_SALT, "utf8"), Buffer.from(`${DERIVE_INFO}${label}`, "utf8"), KEY_BYTES));
}

function associated(vaultKey: Uint8Array, kind: WrappedKind, id: number): string {
  if (kind !== "data" && kind !== "backup") refuse(`a wrapped key's kind is data or backup, not ${String(kind)}`);
  if (!Number.isSafeInteger(id) || id < 1) refuse(`a wrapped key's id is a whole number from 1, not ${id}`);
  return `${WRAP_ASSOCIATED}${kind}:${id}:${keyId(vaultKey)}`;
}

function assertLabel(label: KeyLabel): KeyLabel {
  if (label === "files" || label === "names" || label === "ask-pending") return label;
  if (label.startsWith("store:") && ROLE.test(label.slice("store:".length))) return label;
  return refuse(`${label} is not a key's label`);
}

function assertKey(key: Uint8Array, what: string): void {
  if (key.length !== KEY_BYTES) refuse(`${what} is ${KEY_BYTES} bytes, not ${key.length}`);
}

function refuse(message: string): never {
  throw new KeyError("REFUSED", message);
}
