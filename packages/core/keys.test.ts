import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { KeyError, Keys, openKey, keyBytesOf, wrapKey, type KeyLabel } from "./keys.js";

const DATA_KEY = Buffer.from(Array.from({ length: 32 }, (_, at) => at));
const LABELS: KeyLabel[] = ["store:home", "store:ledger", "files", "names", "ask-pending"];

const VECTORS: Record<string, string> = {
  "ask-pending": "be6217e05cf0ec4010365f3689c10c779a2dada7877f467ef44fb8ac731f149c",
  files: "32b6ed7d76a5d3b506bd2f3687d98eda9ae04625f97e33d128b1b7f0458c4076",
  names: "b9c7f4e3e3cc4d12478d5ce54d7e3e3d63508b71451a8eae75b0c61a26d305af",
  "store:home": "3352e4d716f869b2de74dbe43f9efa4fb39d9530f32d64290535c855fbe247e5",
  "store:ledger": "90f68d2a397c919645846d73d9413fd62c8eb2cf43fed1c0182c626b1a4fed14",
};

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof KeyError ? error.code : `not a KeyError: ${String(error)}`;
  }
  return undefined;
};

describe("wrapped keys", () => {
  const vaultKey = randomBytes(32);
  const dataKey = randomBytes(32);
  const wrapped = wrapKey(vaultKey, "data", 1, dataKey);

  it("open under the same vault key, kind and id", () => {
    expect(openKey(vaultKey, "data", 1, wrapped)?.equals(dataKey)).toBe(true);
  });

  it("do not open under another id, kind or vault key", () => {
    expect(openKey(vaultKey, "data", 2, wrapped)).toBeNull();
    expect(openKey(vaultKey, "backup", 1, wrapped)).toBeNull();
    expect(openKey(randomBytes(32), "data", 1, wrapped)).toBeNull();
  });

  it("do not open with any one byte changed, or cut short", () => {
    for (let at = 0; at < wrapped.length; at += 1) {
      const changed = Buffer.from(wrapped);
      changed[at] = (changed[at] ?? 0) ^ 0x01;
      expect(openKey(vaultKey, "data", 1, changed)).toBeNull();
    }
    expect(openKey(vaultKey, "data", 1, wrapped.subarray(0, wrapped.length - 1))).toBeNull();
  });

  it("refuse a key of the wrong length and an id below 1", () => {
    expect(codeOf(() => wrapKey(vaultKey, "data", 1, randomBytes(16)))).toBe("REFUSED");
    expect(codeOf(() => wrapKey(randomBytes(31), "data", 1, dataKey))).toBe("REFUSED");
    expect(codeOf(() => wrapKey(vaultKey, "data", 0, dataKey))).toBe("REFUSED");
    expect(codeOf(() => openKey(vaultKey, "data", 1.5, wrapped))).toBe("REFUSED");
  });
});

const handedKeys = (keys: Keys): Record<string, string> => {
  const hand = keys.hand();
  return "keys" in hand ? hand.keys as Record<string, string> : {};
};

describe("derived keys", () => {
  it("match the fixed vectors, so a change of salt or info fails", () => {
    expect(handedKeys(Keys.derive(DATA_KEY).only(LABELS))).toEqual(VECTORS);
  });

  it("are derived when first asked, any store's role among them, the same each time", () => {
    const keys = Keys.derive(DATA_KEY);
    expect(LABELS.map((label) => keyBytesOf(keys, label).toString("hex"))).toEqual(LABELS.map((label) => VECTORS[label]));
    expect(keyBytesOf(keys, "store:a-new-cache").equals(keyBytesOf(keys, "store:a-new-cache"))).toBe(true);
    expect(keyBytesOf(keys, "store:a-new-cache").equals(keyBytesOf(keys, "store:home"))).toBe(false);
  });

  it("differ by label, store role included, and repeat for the same label", () => {
    const keys = Keys.derive(DATA_KEY);
    const hex = LABELS.map((label) => keyBytesOf(keys, label).toString("hex"));
    expect(new Set(hex).size).toBe(LABELS.length);
    expect(keyBytesOf(keys, "store:home").equals(keyBytesOf(keys, "store:ledger"))).toBe(false);
    expect(keyBytesOf(Keys.derive(DATA_KEY).only(["files"]), "files").equals(keyBytesOf(keys, "files"))).toBe(true);
  });

  it("of two data keys have nothing in common", () => {
    const one = Keys.derive(randomBytes(32));
    const two = Keys.derive(randomBytes(32));
    const all = LABELS.flatMap((label) => [keyBytesOf(one, label).toString("hex"), keyBytesOf(two, label).toString("hex")]);
    expect(new Set(all).size).toBe(LABELS.length * 2);
  });

  it("refuse a data key of the wrong length and a label that is no key's", () => {
    const keys = Keys.derive(DATA_KEY);
    expect(codeOf(() => Keys.derive(randomBytes(16)))).toBe("REFUSED");
    expect(codeOf(() => keyBytesOf(keys, "store:" as KeyLabel))).toBe("REFUSED");
    expect(codeOf(() => keyBytesOf(keys, "store:Home" as KeyLabel))).toBe("REFUSED");
    expect(codeOf(() => keyBytesOf(keys, "blobs" as KeyLabel))).toBe("REFUSED");
    expect(codeOf(() => keyBytesOf(keys, "store:a:b" as KeyLabel))).toBe("REFUSED");
    expect(codeOf(() => keys.only(["blobs" as KeyLabel]))).toBe("REFUSED");
  });

  it("answer only the labels a program was handed", () => {
    const pending = Keys.derive(DATA_KEY).only(["ask-pending"]);
    expect(Object.keys(handedKeys(pending))).toEqual(["ask-pending"]);
    expect(codeOf(() => keyBytesOf(pending, "files"))).toBe("NOT_HANDED");
    expect(codeOf(() => keyBytesOf(pending, "store:home"))).toBe("NOT_HANDED");
    expect(codeOf(() => pending.only(["files"]))).toBe("NOT_HANDED");
  });
});

describe("the handed form", () => {
  it("narrowed, round-trips through JSON and holds no data key", () => {
    const dataKey = randomBytes(32);
    const keys = Keys.derive(dataKey).only(LABELS);
    const text = JSON.stringify(keys.hand());
    const read = Keys.read(JSON.parse(text));
    for (const label of LABELS) expect(keyBytesOf(read, label).equals(keyBytesOf(keys, label))).toBe(true);
    expect(codeOf(() => keyBytesOf(read, "store:search"))).toBe("NOT_HANDED");
    for (const spelling of ["hex", "base64", "base64url"] as const) expect(text.includes(dataKey.toString(spelling))).toBe(false);
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual(["form", "keys"]);
  });

  it("whole, carries the data key, so the program derives every label as the home does", () => {
    const keys = Keys.derive(DATA_KEY);
    const hand = JSON.parse(JSON.stringify(keys.hand())) as object;
    expect(Object.keys(hand).sort()).toEqual(["data", "form"]);
    const read = Keys.read(hand);
    for (const label of LABELS) expect(keyBytesOf(read, label).toString("hex")).toBe(VECTORS[label]);
    expect(keyBytesOf(read, "store:search").equals(keyBytesOf(keys, "store:search"))).toBe(true);
  });

  it("is refused in another form, with a short key, with both shapes, or with a label that is no key's", () => {
    const hand = Keys.derive(DATA_KEY).only(["files"]).hand() as { form: string; keys: Record<string, string> };
    const whole = Keys.derive(DATA_KEY).hand() as { form: string; data: string };
    expect(codeOf(() => Keys.read({ ...hand, form: "lifestream-keys:v2" }))).toBe("REFUSED");
    expect(codeOf(() => Keys.read({ ...hand, dataKey: "00" }))).toBe("REFUSED");
    expect(codeOf(() => Keys.read({ ...hand, data: whole.data }))).toBe("REFUSED");
    expect(codeOf(() => Keys.read({ form: hand.form }))).toBe("REFUSED");
    expect(codeOf(() => Keys.read({ form: hand.form, data: "ab" }))).toBe("REFUSED");
    expect(codeOf(() => Keys.read({ form: hand.form, keys: { files: "ab" } }))).toBe("REFUSED");
    expect(codeOf(() => Keys.read({ form: hand.form, keys: { data: hand.keys.files } }))).toBe("REFUSED");
    expect(codeOf(() => Keys.read(null))).toBe("REFUSED");
  });
});
