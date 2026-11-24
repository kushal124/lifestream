import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request as plainRequest } from "node:http";
import { request as tlsRequest } from "node:https";
import { connect as tcpConnect, createServer as tcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { serveDoor } from "./door.js";
import { IDENTITY_FILE } from "./lan.js";
import { SHOWN_MS } from "./pairing.js";
import { mintPrincipal } from "./principals.js";
import { askHome, type HomeSocket } from "./socket.js";
import { startHome } from "./home.js";
import { machine } from "./machine.js";
import { FAKES, LOOK_MS, makeRoot, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { doorHere } from "./test/harness-door.js";
import { DEVICE, startDoor, type DoorProcess } from "./test/support.js";
import { testSocket } from "./test/folder.js";
import { openHomeFolder } from "@lifestreamprotocol/core";

const report: Record<string, unknown> = {};
const HAND_LOADED = "chrome-extension://bioodomopbikaidodldikkkinnpfddin";

afterAll(() => {
  const directory = join(import.meta.dirname, ".build", "e2e");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "lan.json"), `${JSON.stringify(report, null, 2)}\n`);
});

const TAILNET = "100.81.6.81";

function machineDir(addresses: string[] = [TAILNET]): string {
  const dir = mkdtempSync(join(tmpdir(), "lifestream-lan-machine-"));
  interfaces(dir, addresses);
  return dir;
}

function interfaces(dir: string, addresses: string[]): void {
  writeFileSync(join(dir, "machine.json"), JSON.stringify({ dnssd: join(dir, "no-dns-sd"), bonjour: "127.0.0.1", addresses }));
}

interface DoorHandle {
  readonly url: string;
  readonly logs: readonly string[];
  readonly child?: DoorProcess["child"];
  stop(): Promise<unknown>;
}

interface Running {
  root: string;
  sock: HomeSocket;
  lan: number;
  door: DoorHandle;
  env: Record<string, string>;
  ticks(): { count: number; at_ms: number | null };
}

async function running(prefix: string, options: { lan?: number; clock?: () => number; childDoor?: boolean } = {}): Promise<Running> {
  const { lan, clock, childDoor = false } = options;
  const root = makeRoot(prefix, { sources: {}, ...(lan === undefined ? {} : { settings: { "door.lan_port": lan } }) });
  const env = { LIFESTREAM_MACHINE_DIR: machineDir() };
  const at = machine({ env: { ...process.env, ...env } });
  let door: DoorHandle;
  let boundLan: number;
  if (childDoor) {
    const proc = await startDoor({ root, tokens: {}, ids: {} }, env);
    door = proc;
    boundLan = lan ?? proc.lan!;
  } else {
    const inproc = await doorHere(root, { machine: at });
    const opened = JSON.parse(inproc.logs.find((line) => line.includes('"door":"open"'))!) as { lan?: number };
    door = inproc;
    boundLan = lan ?? opened.lan!;
  }
  const here = await startHome(root, {
    registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, slot: null, log: () => undefined,
    ...(clock === undefined ? {} : { clock }), machine: at,
  });
  onTestFinished(async () => {
    await door.stop();
    await here.stop();
    removeRoot(root);
    rmSync(env.LIFESTREAM_MACHINE_DIR, { recursive: true, force: true });
  });
  return { root, sock: testSocket(root, env.LIFESTREAM_MACHINE_DIR), lan: boundLan, door, env, ticks: () => here.stats().ticks };
}

interface Answer { status: number; body: Record<string, unknown>; fingerprint: string }

function overLan(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const asked = tlsRequest({ host: "127.0.0.1", port, method, path, headers, rejectUnauthorized: false, agent: false }, (response) => {
      const raw = (response.socket as TLSSocket).getPeerCertificate().raw;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>,
        fingerprint: base32(createHash("sha256").update(raw).digest()),
      }));
    });
    asked.on("error", reject);
    asked.end(body);
  });
}

function plain(port: number, path: string): Promise<{ status: number } | { error: string }> {
  return new Promise((resolve) => {
    const asked = plainRequest({ host: "127.0.0.1", port, path, agent: false }, (response) => {
      response.resume();
      resolve({ status: response.statusCode! });
    });
    asked.on("error", (error: NodeJS.ErrnoException) => resolve({ error: error.code ?? error.message }));
    asked.end();
  });
}

function base32(bytes: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let at = 0; at < bits.length; at += 5) out += alphabet[parseInt(bits.slice(at, at + 5).padEnd(5, "0"), 2)];
  return out;
}

const decoded = (text: string) => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...text].map((char) => alphabet.indexOf(char).toString(2).padStart(5, "0")).join("");
  return Buffer.from(bits.slice(0, bits.length - (bits.length % 8)).match(/.{8}/gu)!.map((byte) => parseInt(byte, 2)));
};

type Paired = { code: string; link: string; match: string; expires_ms: number };
const code = async (sock: HomeSocket) => (await askHome(sock, "pair", ["--account", "person-a@example.com"])) as Paired;
const pairBody = (pairing: string, pass: string) => JSON.stringify({ code: pairing, pass, kind: "phone", model: "iPhone 17 Pro", account: "person-a@example.com", name: "iPhone" });
const newPass = () => Buffer.from(createHash("sha256").update(String(Math.random())).digest()).toString("base64url");

describe("the certificate", () => {
  it("is made once and kept across the door's restarts; the link names it, its key is the user's alone, and its four fold in the code", async () => {
    const at = await running("lifestream-lan-identity-");
    const shown = await code(at.sock);
    const link = new URL(shown.link);
    expect({ scheme: link.protocol, host: link.host, params: [...link.searchParams.keys()] })
      .toEqual({ scheme: "lifestream:", host: "pair", params: ["code", "host", "port", "fp", "account", "at"] });
    expect({ code: link.searchParams.get("code"), host: link.searchParams.get("host"), port: Number(link.searchParams.get("port")), account: link.searchParams.get("account") })
      .toEqual({ code: shown.code, host: "127.0.0.1", port: at.lan, account: "person-a@example.com" });
    const fingerprint = link.searchParams.get("fp")!;
    expect(fingerprint).toMatch(/^[A-Z2-7]{52}$/u);
    const before = await overLan(at.lan, "GET", "/v1/status", {});
    expect(before.fingerprint, "the listener shows the certificate the link names").toBe(fingerprint);
    expect(statSync(join(at.root, IDENTITY_FILE)).mode & 0o777).toBe(0o600);
    const spki = new X509Certificate(readFileSync(join(at.root, IDENTITY_FILE))).publicKey.export({ type: "spki", format: "der" });
    expect(spki.length, "a P-256 key named by its curve: 91 bytes, never its parameters in full").toBe(91);
    const four = base32(createHash("sha256").update(decoded(fingerprint)).update(shown.code, "ascii").digest()).slice(0, 4);
    expect(shown.match).toBe(four);
    expect(shown.match, "the four are not the fingerprint's own").not.toBe(fingerprint.slice(0, 4));

    await at.door.stop();
    const again = await doorHere(at.root, { machine: machine({ env: { ...process.env, ...at.env } }) });
    onTestFinished(async () => { await again.stop(); });
    const after = await overLan(at.lan, "GET", "/v1/status", {});
    expect(after.fingerprint, "a restart keeps the certificate").toBe(fingerprint);
    report.identity = { link: shown.link.replace(/code=\d+/u, "code=<code>"), match: shown.match, kept: after.fingerprint === fingerprint };
  });
});

describe("the listener", () => {
  it("never answers plain http, serves a device's pass, and refuses a reader's or none", async () => {
    const at = await running("lifestream-lan-listener-");
    const clear = await plain(at.lan, "/v1/status");
    expect("error" in clear, `plain http to the listener: ${JSON.stringify(clear)}`).toBe(true);

    const shown = await code(at.sock);
    const pass = newPass();
    const paired = await overLan(at.lan, "POST", "/v1/pair", { ...DEVICE.phone, "content-type": "application/json" }, pairBody(shown.code, pass));
    expect(paired.status).toBe(200);
    const exchanged = await overLan(at.lan, "POST", "/v1/exchange", { ...DEVICE.phone, authorization: `Bearer ${pass}`, "content-type": "application/json" }, "{}");
    expect(exchanged.status, "a paired phone exchanges from the Wi-Fi").toBe(200);
    const phoneReads = await overLan(at.lan, "GET", "/v1/status", { ...DEVICE.phone, authorization: `Bearer ${pass}` });
    expect(phoneReads.status, "a phone's pass reads from the Wi-Fi").toBe(200);

    const reader = mintPrincipal(openHomeFolder(at.root), { unit: "reader", scopes: ["read"], now_ms: Date.now() }).token;
    const fromLan = await overLan(at.lan, "GET", "/v1/status", { authorization: `Bearer ${reader}` });
    expect({ status: fromLan.status, code: fromLan.body.code }).toEqual({ status: 403, code: "PRINCIPAL_SCOPE" });
    const fromLoopback = await fetch(`${at.door.url}/v1/status`, { headers: { authorization: `Bearer ${reader}` } });
    expect(fromLoopback.status, "the same pass reads at loopback").toBe(200);
    const none = await overLan(at.lan, "GET", "/v1/status", {});
    const unknown = await overLan(at.lan, "GET", "/v1/status", { authorization: `Bearer ${newPass()}` });
    expect([none.status, unknown.status]).toEqual([401, 401]);
    const connect = await overLan(at.lan, "POST", "/v1/pair", { origin: HAND_LOADED, "content-type": "application/json" },
      JSON.stringify({ connect: true, pass: newPass(), kind: "extension", unit: "chrome-5550aa0c" }));
    expect({ status: connect.status, code: connect.body.code }).toEqual({ status: 403, code: "CONNECT_LOOPBACK" });
    report.listener = { plain: clear, pair: paired.status, exchange: exchanged.status, phone_reads: phoneReads.status, reader: fromLan.body.code, none: none.status, unknown: unknown.status, connect: connect.body.code };
  });

  it("lets the Mac app's pass read or start a program's download from the Wi-Fi", async () => {
    const at = await running("lifestream-lan-programs-");
    const mac = mintPrincipal(openHomeFolder(at.root), { unit: "macbook-pro-0001", kind: "mac", scopes: ["deliver"], sources: ["apple-notes:local:macbook-pro-0001"], now_ms: Date.now() }).token;
    const headers = { ...DEVICE.mac, authorization: `Bearer ${mac}` };
    const fromLan = [await overLan(at.lan, "GET", "/v1/subscriptions", headers), await overLan(at.lan, "POST", "/v1/subscriptions/claude", headers)];
    expect(fromLan.map((each) => [each.status, each.body.code])).toEqual([[403, "PRINCIPAL_SCOPE"], [403, "PRINCIPAL_SCOPE"]]);
    const fromLoopback = await fetch(`${at.door.url}/v1/subscriptions`, { headers });
    expect(fromLoopback.status).toBe(200);
  });
});

describe("pairing from the network", () => {
  it("tells a phone where its home is in the link, the pairing answer and every answer after, from the interfaces; a code no window asks for pairs nothing", async () => {
    let now = Date.now();
    const at = await running("lifestream-lan-pair-", { clock: () => now });
    const where = [`https://127.0.0.1:${at.lan}`, `https://${TAILNET}:${at.lan}`];
    const shown = await code(at.sock);
    const link = new URL(shown.link);
    expect({ host: link.searchParams.get("host"), port: Number(link.searchParams.get("port")), at: link.searchParams.getAll("at") }, "the link: Bonjour name, then the tailnet's")
      .toEqual({ host: "127.0.0.1", port: at.lan, at: [where[1]] });
    const pass = newPass();
    const paired = await overLan(at.lan, "POST", "/v1/pair", { ...DEVICE.phone, "content-type": "application/json" }, pairBody(shown.code, pass));
    const answer = paired.body.answer as { addresses?: string[] };
    expect(answer.addresses, "the pairing answer lists the link's addresses, each the listener: TLS to the pinned certificate").toEqual(where);
    const phone = { ...DEVICE.phone, authorization: `Bearer ${pass}`, "content-type": "application/json" };
    const later = await overLan(at.lan, "POST", "/v1/exchange", phone, "{}");
    expect(later.body.addresses, "a later exchange answers the same list").toEqual(where);

    const mac = await overLan(at.lan, "POST", "/v1/pair", { ...DEVICE.mac, "content-type": "application/json" },
      JSON.stringify({ code: (await code(at.sock)).code, pass: newPass(), kind: "mac", model: "MacBook Pro", serial4: "0001" }));
    expect({ status: mac.status, addresses: "addresses" in (mac.body.answer as object) }, "a Mac is answered no addresses: it keeps where it paired").toEqual({ status: 200, addresses: false });

    interfaces(at.env.LIFESTREAM_MACHINE_DIR!, []);
    const gone = await overLan(at.lan, "POST", "/v1/exchange", phone, "{}");
    expect(gone.body.addresses, "the interface removed: the next answer drops it").toEqual([where[0]]);
    expect(new URL((await code(at.sock)).link).searchParams.getAll("at"), "a link with one address names no other").toEqual([]);

    const closing = (await askHome(at.sock, "pair", ["show", "--account", "person-a@example.com"])) as Paired;
    expect(new URL(closing.link).searchParams.get("code")).toBe(closing.code);
    now += SHOWN_MS + 1_000;
    await until("a tick at the clock past the code's lease", () => at.ticks().at_ms === now);
    now -= SHOWN_MS + 1_000;
    const closed = await overLan(at.lan, "POST", "/v1/pair", { ...DEVICE.phone, "content-type": "application/json" }, pairBody(closing.code, newPass()));
    expect({ status: closed.status, code: closed.body.code }).toEqual({ status: 403, code: "PAIR_CODE" });
    report.pairing = { link: shown.link.replace(/code=\d+/u, "code=<code>"), paired: answer.addresses, exchange: later.body.addresses, mac_addresses: false,
      tailnet_gone: gone.body.addresses, closed: closed.body.code };
  });

  it("with the listener's port taken, serves on, names no link and no address, and says what to do", async () => {
    const taken = tcpServer();
    await new Promise<void>((resolve) => taken.listen(0, "0.0.0.0", resolve));
    onTestFinished(() => { taken.close(); });
    const port = (taken.address() as { port: number }).port;
    const at = await running("lifestream-lan-taken-", { lan: port });
    expect(JSON.parse(at.door.logs.find((line) => line.includes('"lan":"failed"'))!)).toMatchObject({ lan: "failed", port });
    const said: string[] = [];
    const shown = (await askHome(at.sock, "pair", [], (line) => said.push(line))) as { code: string; link: string | null; why?: string };
    const why = `Lifestream can't open its Wi-Fi connection. Quit what uses port ${port}, or restart Lifestream.`;
    expect({ link: shown.link, why: shown.why }).toEqual({ link: null, why });
    expect(said.at(-1)).toBe(`no link: ${why} An app on this Mac pairs with this code at ${at.door.url}`);
    const paired = await fetch(`${at.door.url}/v1/pair`, { method: "POST", headers: { ...DEVICE.phone, "content-type": "application/json" }, body: pairBody(shown.code, newPass()) });
    expect({ status: paired.status, addresses: ((await paired.json()) as { answer: { addresses?: unknown } }).answer.addresses }).toEqual({ status: 200, addresses: [] });
    report.taken = { lan: "failed", why: shown.why };
  });
});

describe("the door on the Wi-Fi and at loopback", () => {
  it("answers a target no URL reads 400 and serves on", async () => {
    const at = await running("lifestream-lan-target-", { childDoor: true });
    const raw = (send: (text: string) => Socket | TLSSocket): Promise<string> => new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const socket = send("GET //[/ HTTP/1.1\r\nHost: door\r\nConnection: close\r\n\r\n");
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").split("\r\n")[0]!));
      socket.on("error", reject);
    });
    const port = Number(new URL(at.door.url).port);
    const fromLan = await raw((text) => { const socket = tlsConnect({ host: "127.0.0.1", port: at.lan, rejectUnauthorized: false }, () => socket.write(text)); return socket; });
    const fromLoopback = await raw((text) => { const socket = tcpConnect(port, "127.0.0.1", () => socket.write(text)); return socket; });
    expect([fromLan, fromLoopback]).toEqual(["HTTP/1.1 400 Bad Request", "HTTP/1.1 400 Bad Request"]);
    const after = await overLan(at.lan, "GET", "/v1/status", {});
    expect({ exited: at.door.child!.exitCode, status: after.status }, "the door serves on").toEqual({ exited: null, status: 401 });
    report.target = { lan: fromLan, loopback: fromLoopback, after: after.status };
  });

  it("ends the listener's connections with its close: one idle after a request, one mid-handshake", async () => {
    const root = makeRoot("lifestream-lan-close-", { sources: {}, settings: {} });
    onTestFinished(() => removeRoot(root));
    const lines: string[] = [];
    const door = await serveDoor(root, { port: 0, lan_port: 0, max_bundle_bytes: 1 << 30 }, { log: (line) => lines.push(line) });
    const lan = (JSON.parse(lines.find((line) => line.includes('"door":"open"'))!) as { lan: number }).lan;
    const idle = tlsConnect({ host: "127.0.0.1", port: lan, rejectUnauthorized: false });
    await once(idle, "secureConnect");
    idle.write("GET /v1/status HTTP/1.1\r\nHost: door\r\n\r\n");
    await once(idle, "data");
    const handshaking = tcpConnect(lan, "127.0.0.1");
    await once(handshaking, "connect");
    idle.write("GET /v1/status HTTP/1.1\r\nHost: door\r\n\r\n");
    await once(idle, "data");
    const ended = Promise.all([once(idle, "close"), once(handshaking, "close")]);
    await door.close();
    await ended;
    expect({ idle: idle.destroyed, handshaking: handshaking.destroyed }).toEqual({ idle: true, handshaking: true });
    report.close = { idle: "ended", handshaking: "ended" };
  });
});
