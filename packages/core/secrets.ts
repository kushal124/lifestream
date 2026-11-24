import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

/** The home's secrets, one value under each service's name, as an acquirer reads and refreshes them. */
export interface Secrets {
  /** The value stored under a name, opened from its sealed form, or undefined when none is stored. */
  get(service: string): string | undefined;
  /** Replaces the value under a name with the fresh one a provider handed back, as a rotated refresh token, and seals it. */
  rotate(service: string, value: string): void;
}

export interface HomeSecrets extends Secrets {
  set(service: string, value: string): void;
  remove(service: string): void;
  list(): ({ name: string; sealed: string | null; unreadable?: never } | { name: string; unreadable: string; sealed?: never })[];
}

export class SecretError extends Error {
  override name = "SecretError";

  static override [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && value.name === "SecretError";
  }

  constructor(
    message: string,
    readonly reason: "locked" | "other-key" | "refused" = "refused",
  ) {
    super(message);
  }
}

function refuse(message: string, reason?: SecretError["reason"]): never {
  throw new SecretError(message, reason);
}

export interface SecretSources {
  env?: Record<string, string | undefined>;
  key?: Uint8Array;
}

const SERVICE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SEALED = "lifestream-sealed:";
export const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function keyId(key: Uint8Array): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

export function sealBytes(key: Uint8Array, associated: string, plain: Uint8Array): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(associated, "utf8"));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

export function openBytes(key: Uint8Array, associated: string, sealed: Uint8Array): Buffer | null {
  if (sealed.length <= NONCE_BYTES + TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, NONCE_BYTES));
    decipher.setAAD(Buffer.from(associated, "utf8"));
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    return Buffer.concat([decipher.update(sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)), decipher.final()]);
  } catch {
    return null;
  }
}

export function homeSecrets(dir: string, sources: SecretSources = {}): HomeSecrets {
  const env = sources.env ?? {};
  const key = sources.key;
  if (key !== undefined && key.length !== KEY_BYTES) refuse(`a secrets key is ${KEY_BYTES} bytes, not ${key.length}`);
  return {
    get(service) {
      assertService(service);
      for (const left of pending(dir, service)) if (left.whole) finish(dir, service, left.name);
      const stored = readStored(dir, service);
      if (stored !== undefined) return open(service, stored, key);
      const stated = env[environmentName(service)];
      return stated !== undefined && stated.length > 0 ? open(service, stated, key) : undefined;
    },
    rotate(service, value) {
      assertService(service);
      if (value.length === 0) refuse(`a rotated secret for ${service} cannot be empty`);
      if (key === undefined) refuse(`no key is held to seal the rotated ${service}: nothing was written`, "locked");
      write(dir, service, seal(service, value, key));
    },
    set(service, value) {
      assertService(service);
      if (value.length === 0) refuse(`a secret for ${service} cannot be empty`);
      if (key === undefined) refuse(`no key is held to seal ${service}`, "locked");
      write(dir, service, seal(service, value, key));
    },
    remove(service) {
      assertService(service);
      for (const left of pending(dir, service)) unlinkSync(join(dir, left.name));
      try {
        unlinkSync(join(dir, service));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") refuse(`the secret ${service} could not be removed`);
        return;
      }
      syncDirectory(dir);
    },
    list() {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return [];
      }
      return names.filter((name) => SERVICE.test(name) && lstatSync(join(dir, name)).isFile()).sort().map((name) => {
        let head: string;
        try {
          head = readFileSync(join(dir, name), "utf8").slice(0, SEALED.length + 12);
        } catch (error) {
          return { name, unreadable: `cannot read secret ${name}: ${(error as NodeJS.ErrnoException).code ?? "unknown error"}` };
        }
        return { name, sealed: head.startsWith(`${SEALED}v1:`) ? head.slice(SEALED.length + 3, SEALED.length + 11) : null };
      });
    },
  };
}

function seal(service: string, value: string, key: Uint8Array): string {
  return `${SEALED}v1:${keyId(key)}:${sealBytes(key, service, Buffer.from(value, "utf8")).toString("base64")}`;
}

function open(service: string, text: string, key: Uint8Array | undefined): string {
  if (!text.startsWith(SEALED)) return text;
  const [version, id, payload, ...rest] = text.slice(SEALED.length).split(":");
  if (version !== "v1" || id === undefined || !/^[0-9a-f]{8}$/u.test(id) || payload === undefined || rest.length > 0) {
    refuse(`${service} is sealed in a form this release does not read`);
  }
  if (key === undefined) refuse(`${service} is sealed by key ${id}, and no key is held to open it`, "locked");
  if (id !== keyId(key)) refuse(`${service} is sealed by key ${id}, not by the key held (${keyId(key)}): it must be typed again here`, "other-key");
  const bytes = Buffer.from(payload, "base64");
  const broken = `${service} is sealed but does not open: it was changed, cut short or sealed under another name; type it again`;
  const opened = bytes.toString("base64") === payload ? openBytes(key, service, bytes) : null;
  return opened === null ? refuse(broken) : opened.toString("utf8");
}

function write(dir: string, service: string, text: string): void {
  for (const left of pending(dir, service)) {
    if (left.whole) finish(dir, service, left.name);
    else unlinkSync(join(dir, left.name));
  }
  const salt = randomBytes(8).toString("hex");
  const name = `${prefix(service)}${salt}.${hashOf(salt, text)}`;
  const bytes = Buffer.from(text, "utf8");
  const fd = openSync(join(dir, name), "wx", 0o600);
  try {
    for (let done = 0; done < bytes.length; ) done += writeSync(fd, bytes, done);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  finish(dir, service, name);
}

export function environmentName(service: string): string {
  return `LIFESTREAM_SECRET_${service.toUpperCase().replace(/[^A-Z0-9]/gu, "_")}`;
}

function prefix(service: string): string {
  return `.${service}.rotating.`;
}

function hashOf(salt: string, value: Buffer | string): string {
  return createHash("sha256").update(salt).update(value).digest("hex");
}

function pending(dir: string, service: string): { name: string; whole: boolean }[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(prefix(service)))
    .map((name) => {
      const [salt, hash] = name.slice(prefix(service).length).split(".");
      let whole = false;
      try {
        whole = salt !== undefined && hash !== undefined && hashOf(salt, readFileSync(join(dir, name))) === hash;
      } catch {
      }
      return { name, whole };
    });
}

function finish(dir: string, service: string, name: string): void {
  try {
    renameSync(join(dir, name), join(dir, service));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") refuse(`the secret written for ${service} could not be put in place`);
  }
  syncDirectory(dir);
}

function syncDirectory(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readStored(dir: string, service: string): string | undefined {
  const path = join(dir, service);
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return undefined;
  const mode = stat.mode & 0o777;
  if (!stat.isFile() || mode !== 0o600) refuse(`secret file ${path} must be a file at mode 0600, not ${mode.toString(8).padStart(4, "0")}`);
  const value = readFileSync(path, "utf8").replace(/\n$/u, "");
  if (value.length === 0) refuse(`secret file ${path} is empty`);
  return value;
}

function assertService(service: string): void {
  if (!SERVICE.test(service)) refuse(`${JSON.stringify(service)} cannot name a secret: letters, digits, '.', '_' and '-', not first a dot`);
}
