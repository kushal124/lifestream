import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { homeSecrets, keyId, SecretError } from "./secrets.js";

const CORE = dirname(fileURLToPath(import.meta.url));
const temps: string[] = [];
afterEach(() => {
  if (process.env.LIFESTREAM_KEEP_ARTIFACTS !== "1") for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "lifestream-secrets-"));
  temps.push(dir);
  return dir;
}

function artifact(dir: string, name: string, value: unknown): void {
  writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`);
}

const SERVICE = "whoop";

const root = (dir: string): string => join(dir, "..", "..");

function secretsDir(): string {
  const dir = join(temp(), "config", "secrets");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function crashRotation(dir: string, at: "rename" | "write", value: string, key?: Buffer): { status: number | null; signal: string | null; stderr: string } {
  const script = join(root(dir), `crash-${at}.mts`);
  writeFileSync(script, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    if (${JSON.stringify(at)} === "rename") {
      fs.renameSync = () => process.kill(process.pid, "SIGKILL");
    } else {
      const write = fs.writeSync;
      fs.writeSync = (fd, buffer, ...rest) => {
        write(fd, buffer.subarray(0, Math.floor(buffer.length / 2)));
        process.kill(process.pid, "SIGKILL");
      };
    }
    syncBuiltinESMExports();
    const { homeSecrets } = await import(${JSON.stringify(pathToFileURL(join(CORE, "secrets.ts")).href)});
    const key = ${JSON.stringify(key?.toString("hex") ?? null)};
    const secrets = homeSecrets(${JSON.stringify(dir)}, { key: Buffer.from(key ?? ${JSON.stringify(ROTATING.toString("hex"))}, "hex") });
    if (key === null) secrets.rotate(${JSON.stringify(SERVICE)}, ${JSON.stringify(value)});
    else secrets.set(${JSON.stringify(SERVICE)}, ${JSON.stringify(value)});
    console.log("rotated without a crash");
  `);
  const result = spawnSync(process.execPath, ["--import", "tsx", script], { cwd: CORE, encoding: "utf8" });
  return { status: result.status, signal: result.signal, stderr: result.stderr };
}

function code(read: () => unknown): string {
  try {
    read();
    return "read";
  } catch (error) {
    if (error instanceof SecretError) return "SECRET";
    throw error;
  }
}

function outcome(read: () => unknown): { value: unknown } | { reason: string; message: string } {
  try {
    return { value: read() };
  } catch (error) {
    if (!(error instanceof SecretError)) throw error;
    return { reason: error.reason, message: error.message };
  }
}

function flipped(text: string, at: number): string {
  const head = text.slice(0, text.lastIndexOf(":") + 1);
  const bytes = Buffer.from(text.slice(head.length), "base64");
  const index = at < 0 ? bytes.length + at : at;
  bytes[index] = bytes[index]! ^ 0x01;
  return head + bytes.toString("base64");
}

const PASSWORD = "x.password";
const VALUE = "fake-password-correct-horse";
const ROTATING = randomBytes(32);

describe("secrets: each of these is impossible", () => {
  it("a rotated secret is lost on a crash between its write and its rename", () => {
    const dir = secretsDir();
    writeFileSync(join(dir, SERVICE), "fake-refresh-1\n", { mode: 0o600 });
    const crashed = crashRotation(dir, "rename", "fake-refresh-2");
    expect(crashed.signal).toBe("SIGKILL");
    const secrets = homeSecrets(dir, { key: ROTATING });
    expect(secrets.get(SERVICE)).toBe("fake-refresh-2");
    expect(readdirSync(dir)).toEqual([SERVICE]);
    expect(statSync(join(dir, SERVICE)).mode & 0o777).toBe(0o600);
    artifact(root(dir), "rename-crash.json", { crashed, read: "fake-refresh-2", left: readdirSync(dir) });
  });

  it("a crash half way through writing a rotation leaves a partial secret to be read", () => {
    const dir = secretsDir();
    writeFileSync(join(dir, SERVICE), "fake-refresh-1", { mode: 0o600 });
    const crashed = crashRotation(dir, "write", "fake-refresh-2-and-a-long-tail");
    expect(crashed.signal).toBe("SIGKILL");
    expect(readdirSync(dir).length).toBe(2);
    const secrets = homeSecrets(dir, { key: ROTATING });
    expect(secrets.get(SERVICE)).toBe("fake-refresh-1");
    secrets.rotate(SERVICE, "fake-refresh-3");
    expect(secrets.get(SERVICE)).toBe("fake-refresh-3");
    expect(readdirSync(dir)).toEqual([SERVICE]);
    artifact(root(dir), "write-crash.json", { crashed, after: readdirSync(dir) });
  });

  it("a secret is read past its file, or from the Keychain", () => {
    const dir = secretsDir();
    const bin = join(root(dir), "bin");
    const asked = join(root(dir), "security-asked");
    mkdirSync(bin);
    writeFileSync(join(bin, "security"), `#!/bin/sh\necho "$@" >> ${JSON.stringify(asked)}\necho fake-from-keychain\n`, { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    process.env.LIFESTREAM_SECRET_COAST = "fake-from-process";
    let read: Record<string, string | undefined>;
    let file: string | undefined;
    try {
      const env = { LIFESTREAM_SECRET_WHOOP: "fake-from-env", LIFESTREAM_SECRET_GOOGLE_CALENDAR: "fake-calendar-token" };
      const secrets = homeSecrets(dir, { env });
      read = { env: secrets.get(SERVICE), calendar: secrets.get("google-calendar"), none: secrets.get("gmail-imap"), process: homeSecrets(dir).get("coast") };
      writeFileSync(join(dir, SERVICE), "fake-from-file\n", { mode: 0o600 });
      file = secrets.get(SERVICE);
    } finally {
      process.env.PATH = path;
      delete process.env.LIFESTREAM_SECRET_COAST;
    }
    expect(read).toEqual({ env: "fake-from-env", calendar: "fake-calendar-token", none: undefined, process: undefined });
    expect(file).toBe("fake-from-file");
    expect(existsSync(asked)).toBe(false);
    artifact(root(dir), "order.json", { read, file, keychain_asked: existsSync(asked) });
  });

  it("a secret is read from a file others can read, or a refusal carries its value", () => {
    const dir = secretsDir();
    writeFileSync(join(dir, SERVICE), "fake-refresh-1", { mode: 0o644 });
    chmodSync(join(dir, SERVICE), 0o644);
    const secrets = homeSecrets(dir, { key: ROTATING });
    let message = "";
    try {
      secrets.get(SERVICE);
    } catch (error) {
      expect(error).toBeInstanceOf(SecretError);
      message = (error as Error).message;
    }
    expect(message).toContain(join(dir, SERVICE));
    expect(message).toContain("0600");
    expect(message).not.toContain("fake-refresh-1");
    secrets.rotate(SERVICE, "fake-refresh-2");
    expect(statSync(join(dir, SERVICE)).mode & 0o777).toBe(0o600);
    expect(secrets.get(SERVICE)).toBe("fake-refresh-2");
    const names = ["../principals.json", "a/b", ".hidden", "", "whoop\n"].map((name) => code(() => secrets.get(name)));
    expect(names).toEqual(names.map(() => "SECRET"));
    expect(code(() => secrets.rotate(SERVICE, ""))).toBe("SECRET");
    artifact(root(dir), "mode.json", { message, names });
  });
});

describe("sealed secrets: each of these is impossible", () => {
  const key = randomBytes(32);
  const other = randomBytes(32);

  it("a sealed value is read without its key, or opened by another key", () => {
    const dir = secretsDir();
    homeSecrets(dir, { env: {}, key }).set(PASSWORD, VALUE);
    const stored = readFileSync(join(dir, PASSWORD), "utf8");
    const id = createHash("sha256").update(key).digest("hex").slice(0, 8);
    expect(stored.startsWith(`lifestream-sealed:v1:${id}:`)).toBe(true);
    expect(keyId(key)).toBe(id);
    const locked = outcome(() => homeSecrets(dir, { env: {} }).get(PASSWORD));
    const elsewhere = outcome(() => homeSecrets(dir, { env: {}, key: other }).get(PASSWORD));
    const opened = outcome(() => homeSecrets(dir, { env: {}, key }).get(PASSWORD));
    expect(locked).toMatchObject({ reason: "locked" });
    expect(elsewhere).toMatchObject({ reason: "other-key" });
    expect((elsewhere as { message: string }).message).toContain(id);
    expect((elsewhere as { message: string }).message).toContain(keyId(other));
    expect(opened).toEqual({ value: VALUE });
    for (const refusal of [locked, elsewhere] as { message: string }[]) {
      expect(refusal.message).not.toContain(VALUE);
      expect(refusal.message).not.toContain(key.toString("hex"));
      expect(refusal.message).not.toContain(key.toString("base64"));
    }
    expect(statSync(join(dir, PASSWORD)).mode & 0o777).toBe(0o600);
    artifact(root(dir), "sealed-keys.json", { stored: stored.slice(0, 31), locked, elsewhere, opened: "opened" in opened });
  });

  it("a changed, cut or renamed sealed value opens to anything", () => {
    const dir = secretsDir();
    const secrets = homeSecrets(dir, { env: {}, key });
    secrets.set(PASSWORD, VALUE);
    const stored = readFileSync(join(dir, PASSWORD), "utf8");
    const write = (name: string, text: string) => writeFileSync(join(dir, name), text, { mode: 0o600 });
    const cases: Record<string, string> = {
      nonce: flipped(stored, 0),
      ciphertext: flipped(stored, 12),
      tag: flipped(stored, -1),
      truncated: stored.slice(0, stored.length - 8),
      "truncated to the tag": `${stored.slice(0, stored.lastIndexOf(":") + 1)}${Buffer.from(stored.slice(stored.lastIndexOf(":") + 1), "base64").subarray(0, 20).toString("base64")}`,
      "not base64": `${stored.slice(0, stored.lastIndexOf(":") + 1)}!!!${stored.slice(stored.lastIndexOf(":") + 4)}`,
      "an unknown form": stored.replace("lifestream-sealed:v1:", "lifestream-sealed:v2:"),
    };
    const read: Record<string, unknown> = {};
    for (const [name, text] of Object.entries(cases)) {
      write(PASSWORD, text);
      read[name] = outcome(() => secrets.get(PASSWORD));
    }
    write("y.password", stored);
    read.renamed = outcome(() => secrets.get("y.password"));
    for (const [name, result] of Object.entries(read)) {
      expect(result, name).toMatchObject({ reason: "refused" });
      expect((result as { message: string }).message, name).not.toContain(VALUE);
    }
    artifact(root(dir), "sealed-tampered.json", read);
  });

  it("set writes a password plain, a seal reuses its nonce, or a key of the wrong size is taken", () => {
    const dir = secretsDir();
    const unkeyed = outcome(() => homeSecrets(dir, { env: {} }).set(PASSWORD, VALUE));
    expect(unkeyed).toMatchObject({ reason: "locked" });
    expect(existsSync(join(dir, PASSWORD))).toBe(false);
    expect(outcome(() => homeSecrets(dir, { env: {}, key: randomBytes(16) }))).toMatchObject({ reason: "refused" });
    const secrets = homeSecrets(dir, { env: {}, key });
    secrets.set(PASSWORD, VALUE);
    const first = readFileSync(join(dir, PASSWORD), "utf8");
    secrets.set(PASSWORD, VALUE);
    const second = readFileSync(join(dir, PASSWORD), "utf8");
    expect(second).not.toBe(first);
    expect(secrets.get(PASSWORD)).toBe(VALUE);
    expect(code(() => secrets.set(PASSWORD, ""))).toBe("SECRET");
    expect(readdirSync(dir)).toEqual([PASSWORD]);
    artifact(root(dir), "sealed-set.json", { unkeyed, differ: first !== second });
  });

  it("a rotation is written plain, with a key or without one, a plain file stops reading, or the list carries a value", () => {
    const dir = secretsDir();
    writeFileSync(join(dir, SERVICE), "fake-refresh-1\n", { mode: 0o600 });
    writeFileSync(join(dir, "gmail-imap"), "fake-app-password", { mode: 0o600 });
    const secrets = homeSecrets(dir, { env: { LIFESTREAM_SECRET_FROM_ENV: "fake-env-value" }, key });
    expect(secrets.get(SERVICE)).toBe("fake-refresh-1");
    expect(secrets.get("from-env")).toBe("fake-env-value");
    secrets.rotate(SERVICE, "fake-refresh-2");
    expect(readFileSync(join(dir, SERVICE), "utf8").startsWith(`lifestream-sealed:v1:${keyId(key)}:`)).toBe(true);
    expect(secrets.get(SERVICE)).toBe("fake-refresh-2");
    expect(outcome(() => homeSecrets(dir).rotate("other-token", "fake-token-1"))).toMatchObject({ reason: "locked", message: expect.not.stringContaining("fake-token-1") });
    expect(existsSync(join(dir, "other-token"))).toBe(false);
    secrets.set(PASSWORD, VALUE);
    const listed = secrets.list();
    expect(listed).toEqual([
      { name: "gmail-imap", sealed: null },
      { name: SERVICE, sealed: keyId(key) },
      { name: PASSWORD, sealed: keyId(key) },
    ]);
    expect(JSON.stringify(listed)).not.toContain("fake-");
    artifact(root(dir), "sealed-rotation.json", { listed });
  });

  it("a crash while a sealed value is written leaves a partial one read, or loses the one before", () => {
    const write = secretsDir();
    homeSecrets(write, { env: {}, key }).set(SERVICE, "fake-password-1");
    const cut = crashRotation(write, "write", "fake-password-2-and-a-long-tail", key);
    expect(cut.signal).toBe("SIGKILL");
    expect(readdirSync(write).length).toBe(2);
    expect(homeSecrets(write, { env: {}, key }).get(SERVICE)).toBe("fake-password-1");
    homeSecrets(write, { env: {}, key }).set(SERVICE, "fake-password-3");
    expect(readdirSync(write)).toEqual([SERVICE]);
    expect(homeSecrets(write, { env: {}, key }).get(SERVICE)).toBe("fake-password-3");

    const rename = secretsDir();
    homeSecrets(rename, { env: {}, key }).set(SERVICE, "fake-password-1");
    const unrenamed = crashRotation(rename, "rename", "fake-password-2", key);
    expect(unrenamed.signal).toBe("SIGKILL");
    expect(homeSecrets(rename, { env: {}, key }).get(SERVICE)).toBe("fake-password-2");
    expect(readdirSync(rename)).toEqual([SERVICE]);
    expect(statSync(join(rename, SERVICE)).mode & 0o777).toBe(0o600);
    artifact(root(write), "sealed-crash.json", { cut, unrenamed });
  });
});
