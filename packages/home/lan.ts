import { spawn, type ChildProcess } from "node:child_process";
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, X509Certificate } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import type { IncomingMessage, Server } from "node:http";
import { createServer } from "node:https";
import { Server as NetServer, type AddressInfo, type Socket } from "node:net";
import { join } from "node:path";
import { connect } from "node:tls";
import type { JsonObject } from "@lifestreamprotocol/core";
import { HOME_FILE } from "./lifecycle.js";
import type { Machine } from "./machine.js";
import type { Reach } from "./principals.js";
import type { DoorAddress } from "./settings.js";


export const IDENTITY_FILE = join("config", "door-tls.pem");
export const SERVICE_TYPE = "_lifestream._tcp";
const INSTANCE = "Lifestream";
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const OID_ECDSA_SHA256 = Buffer.from([0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x04, 0x03, 0x02]);
const OID_CN = Buffer.from([0x06, 0x03, 0x55, 0x04, 0x03]);
const OID_BASIC_CONSTRAINTS = Buffer.from([0x06, 0x03, 0x55, 0x1d, 0x13]);

export interface Identity {
  readonly key: string;
  readonly cert: string;
  readonly digest: Buffer;
  readonly fingerprint: string;
}

export function identity(folder: string): Identity {
  const path = join(folder, IDENTITY_FILE);
  if (!existsSync(path)) {
    const made = makeIdentity();
    const draft = `${path}.${process.pid}.${randomBytes(4).toString("hex")}`;
    const fd = openSync(draft, "wx", 0o600);
    try {
      writeSync(fd, made);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    try {
      linkSync(draft, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally { rmSync(draft, { force: true }); }
  }
  const text = readFileSync(path, "utf8");
  const key = /-----BEGIN PRIVATE KEY-----[^-]+-----END PRIVATE KEY-----\n/u.exec(text)?.[0];
  const cert = /-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----\n/u.exec(text)?.[0];
  if (key === undefined || cert === undefined) throw new Error(`${path} holds no key and certificate: remove it, and every phone pairs again`);
  const x509 = new X509Certificate(cert);
  if (!x509.checkPrivateKey(createPrivateKey(key))) throw new Error(`${path}: its key is not its certificate's`);
  const digest = createHash("sha256").update(x509.raw).digest();
  return { key, cert, digest, fingerprint: base32(digest) };
}

export function matchOf(home: Pick<Identity, "digest">, code: string): string {
  return base32(createHash("sha256").update(home.digest).update(code, "ascii").digest()).slice(0, 4);
}

export function pairLink(parts: { code: string; addresses: readonly string[]; fingerprint: string; account: string | null }): string {
  const [first, ...others] = parts.addresses;
  const url = new URL(first!);
  const query: [string, string][] = [["code", parts.code], ["host", url.hostname], ["port", url.port], ["fp", parts.fingerprint]];
  if (parts.account !== null) query.push(["account", parts.account]);
  for (const address of others) query.push(["at", address]);
  return `lifestream://pair?${query.map(([name, value]) => `${name}=${encodeURIComponent(value)}`).join("&")}`;
}

export function reach(at: Pick<Machine, "bonjour" | "addresses">, port: number | null): string[] {
  if (port === null) return [];
  const hosts = [at.bonjour, ...at.addresses.lan, ...at.addresses.tailnet];
  return [...new Set(hosts.flatMap((host) => host === null ? [] : [`https://${host}:${port}`]))];
}

export function listening(folder: string, port: number): Promise<boolean> {
  if (port === 0) return Promise.resolve(false);
  const digest = identity(folder).digest;
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, rejectUnauthorized: false, timeout: 1_000 }, () => {
      resolve(createHash("sha256").update(socket.getPeerX509Certificate()?.raw ?? Buffer.alloc(0)).digest().equals(digest));
      socket.destroy();
    });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.on("error", () => resolve(false));
  });
}

export function pathOf(request: IncomingMessage): string | null {
  try {
    return new URL(request.url ?? "/", "http://door").pathname;
  } catch {
    return null;
  }
}

export async function listenLan(door: Server, settings: DoorAddress, at: Machine, folder: () => string, say: (line: JsonObject) => void,
  keep: (socket: Socket, reach: Reach) => void): Promise<{ port: number; close(): Promise<void>; end(): void } | null> {
  if (settings.lan_port === undefined) return null;
  let ready = false;
  let unread: string | null = null;
  const lan = createServer({ requestTimeout: door.requestTimeout }, (request, response) => door.emit("request", request, response));
  const handshaking = new Map<string, Socket>();
  const far = (socket: Socket) => `${socket.remoteAddress}:${socket.remotePort}`;
  lan.on("secureConnection", (socket) => {
    handshaking.delete(far(socket));
    keep(socket, "lan");
  });
  lan.prependListener("connection", (raw: Socket) => {
    const at = far(raw);
    handshaking.set(at, raw);
    raw.once("close", () => { if (handshaking.get(at) === raw) handshaking.delete(at); });
    if (ready) return;
    try {
      if (!existsSync(join(folder(), HOME_FILE))) return;
      const { key, cert } = identity(folder());
      lan.setSecureContext({ key, cert });
      ready = true;
    } catch (error) {
      const why = (error as Error).message;
      if (why !== unread) say({ lan: "no certificate", why });
      unread = why;
    }
  });
  const bound = await new Promise<number | null>((resolve) => {
    lan.once("error", (error) => {
      say({ lan: "failed", port: settings.lan_port!, error: error.message });
      resolve(null);
    });
    lan.listen(settings.lan_port, "0.0.0.0", () => resolve((lan.address() as AddressInfo).port));
  });
  if (bound === null) return null;
  const host = at.bonjour;
  const advertised = at.dnssd === null || host === null ? null : advertise(at.dnssd, host, bound);
  return {
    port: bound,
    close() {
      const closed = new Promise<void>((resolve) => NetServer.prototype.close.call(lan, () => resolve()));
      for (const raw of handshaking.values()) raw.destroy();
      advertised?.stdin?.end();
      return closed;
    },
    end() {
      lan.close();
    },
  };
}

function advertise(dnssd: string, host: string, port: number): ChildProcess {
  const child = spawn("/bin/sh", ["-c", `"$0" -R ${INSTANCE} ${SERVICE_TYPE} local "$1" "host=$2" "port=$1" >/dev/null 2>&1 & read _; kill $!`, dnssd, String(port), host],
    { stdio: ["pipe", "ignore", "ignore"] });
  child.on("error", () => undefined);
  child.unref();
  return child;
}

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>= 8) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTlv(tag: number, ...parts: readonly Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

function derInt(bytes: Buffer): Buffer {
  let at = 0;
  while (at < bytes.length - 1 && bytes[at] === 0) at += 1;
  const trimmed = bytes.subarray(at);
  return derTlv(0x02, (trimmed[0]! & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

function derTime(date: Date): Buffer {
  const stamp = `${date.toISOString().replace(/[-:T]/gu, "").slice(0, 14)}Z`;
  return date.getUTCFullYear() < 2050 ? derTlv(0x17, Buffer.from(stamp.slice(2), "ascii")) : derTlv(0x18, Buffer.from(stamp, "ascii"));
}

function makeIdentity(): string {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x01;
  const alg = derTlv(0x30, OID_ECDSA_SHA256);
  const name = derTlv(0x30, derTlv(0x31, derTlv(0x30, OID_CN, derTlv(0x0c, Buffer.from(INSTANCE, "utf8")))));
  const now = new Date();
  const validity = derTlv(0x30, derTime(now), derTime(new Date(now.getTime() + 36_500 * 86_400_000)));
  const extensions = derTlv(0xa3, derTlv(0x30, derTlv(0x30, OID_BASIC_CONSTRAINTS, Buffer.from([0x01, 0x01, 0xff]), derTlv(0x04, derTlv(0x30)))));
  const tbs = derTlv(0x30, derTlv(0xa0, derInt(Buffer.from([2]))), derInt(serial), alg, name, validity, name, spki, extensions);
  const signature = sign("sha256", tbs, privateKey);
  const der = derTlv(0x30, tbs, alg, derTlv(0x03, Buffer.from([0]), signature));
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const certPem = `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/.{1,64}/gu, "$&\n")}-----END CERTIFICATE-----\n`;
  return `${keyPem}${certPem}`;
}

function base32(bytes: Buffer): string {
  let out = "", bits = 0, value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  return bits > 0 ? out + BASE32[(value << (5 - bits)) & 31] : out;
}
