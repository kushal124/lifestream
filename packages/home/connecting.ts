import { execFile } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { promisify } from "node:util";
import { extensionOf } from "@lifestreamprotocol/connect";
import type { Reach } from "./principals.js";
import { refuse } from "./refusal.js";


const UNKNOWN = "Chrome";
const PREFLIGHT_S = 600;
const run = promisify(execFile);
const found = new WeakMap<Socket, Promise<string | null>>();

export function allowExtension(request: IncomingMessage, response: ServerResponse): void {
  const id = extensionOf(request.headers.origin);
  if (id === null) return;
  response.setHeader("access-control-allow-origin", `chrome-extension://${id}`);
  response.setHeader("access-control-allow-headers", "authorization, content-type, lifestream-device");
  response.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE");
  response.setHeader("access-control-allow-private-network", "true");
  response.setHeader("access-control-max-age", String(PREFLIGHT_S));
  response.setHeader("vary", "origin");
}

export async function connectFrom(request: IncomingMessage, reach: Reach): Promise<string> {
  if (reach !== "loopback") refuse(403, "CONNECT_LOOPBACK", "only a browser on the home's own Mac connects by an Allow: a browser elsewhere pairs with a code");
  if (extensionOf(request.headers.origin) === null) refuse(403, "CONNECT_ORIGIN", "only the Lifestream extension connects by an Allow");
  const socket = request.socket;
  let browser = found.get(socket);
  if (browser === undefined) found.set(socket, (browser = peer(socket.remoteAddress!, socket.remotePort!, closing(socket)).then((path) => path === null ? null : browserOf(path))));
  return (await browser) ?? UNKNOWN;
}

function closing(socket: Socket): AbortSignal {
  const closed = new AbortController();
  if (socket.destroyed) closed.abort();
  else socket.once("close", () => closed.abort());
  return closed.signal;
}

export function browserOf(executable: string): string | null {
  const app = /^[^]*?\/([^/]+)\.app\//u.exec(executable)?.[1];
  return app === undefined ? null : app.replace(/^Google /u, "").replace(/ Browser$/u, "");
}

async function peer(address: string, port: number, signal: AbortSignal): Promise<string | null> {
  const listed = await run("/usr/sbin/lsof", ["-nP", "-a", `-iTCP@${address}:${port}`, "-sTCP:ESTABLISHED", "-Fpn"], { signal }).catch(() => ({ stdout: "" }));
  let pid: string | null = null, holder: string | null = null;
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1);
    else if (line.startsWith(`n${address}:${port}->`)) holder = pid;
  }
  if (holder === null) return null;
  const named = await run("/bin/ps", ["-o", "comm=", "-p", holder], { signal }).catch(() => ({ stdout: "" }));
  return named.stdout.trim() || null;
}
