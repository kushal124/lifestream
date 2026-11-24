import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { openHomeFolder, tryLock } from "@lifestreamprotocol/core";
import type { Door } from "../door.js";
import { runCli, type CliOptions } from "../cli.js";
import { readHome, startingSettings } from "../lifecycle.js";
import { machine } from "../machine.js";
import { checkoutProgram, homeRegistryModule } from "../programs.js";
import { mintPrincipal, passOf, type Scope } from "../principals.js";
import { effectiveOf, settingsPath } from "../settings.js";
import type { SlotHanded } from "../vault.js";
import { REPO, until } from "./harness-root.js";
import { openDoor } from "./harness-door.js";
import { DEVICE } from "./support.js";

export const CLI = join(REPO, "packages", "home", "cli.ts");
const CLI_CHILD = join(REPO, "packages", "home", "test", "cli-child.ts");
const temps: string[] = [];
const children: ChildProcess[] = [];

export async function stopChildren(): Promise<void> {
  await Promise.all(children.splice(0).map((child) => child.exitCode !== null || child.signalCode !== null ? undefined : new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGKILL");
  })));
}

export function removeTemps(): void {
  if (process.env.LIFESTREAM_KEEP_ARTIFACTS !== "1") for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function temp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ls-${name.split("-").map((word) => word[0]).join("")}-`));
  temps.push(dir);
  return dir;
}

export function newMachine(name: string, overrides: Record<string, string> = {}): { dir: string; user: string; env: NodeJS.ProcessEnv } {
  const dir = temp(`${name}-machine`);
  const user = temp(`${name}-user`);
  writeFileSync(join(dir, "machine.json"), JSON.stringify({ dnssd: join(dir, "no-dns-sd"), bonjour: "127.0.0.1", unit: "macbook-pro-0001", ...overrides }));
  return { dir, user, env: { ...process.env, LIFESTREAM_MACHINE_DIR: dir, HOME: user, TZ: "America/New_York" } };
}

function setEnv(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  for (const [key, value] of Object.entries(env)) if (value !== undefined && process.env[key] !== value) process.env[key] = value;
}

export async function home(on: { env: NodeJS.ProcessEnv }, args: string[], lines: string[] = [], options: Omit<CliOptions, "write"> = {}): Promise<{ status: number; out: string; result: unknown }> {
  const own = { ...process.env };
  setEnv(on.env);
  let status: number;
  try {
    status = await runCli(args, { ...options, write: (text) => lines.push(text) });
  } finally {
    setEnv(own);
  }
  const out = lines.join("");
  let result: unknown;
  try {
    result = JSON.parse(out.trim().split("\n").at(-1) ?? "");
  } catch {
    result = undefined;
  }
  return { status, out, result };
}

export function cliProgram(): string[] {
  return checkoutProgram(CLI_CHILD);
}

export function start(on: { env: NodeJS.ProcessEnv }, program: string, args: string[]): { out: () => string; exited: Promise<number | null>; child: ChildProcess } {
  const child = spawn(process.execPath, [...checkoutProgram(program === CLI ? CLI_CHILD : program), ...args], { cwd: REPO, env: on.env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let out = "";
  child.stdout!.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
  child.stderr!.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
  return { out: () => out, exited: new Promise((resolve) => child.once("close", (code) => resolve(code))), child };
}

export async function printed(running: { out: () => string; exited: Promise<number | null> }, what: string, line: string): Promise<void> {
  const died = running.exited.then((code) => {
    throw new Error(`${what}: the child exited ${code} before it printed ${line}:\n${running.out()}`);
  });
  const came = until(what, () => running.out().includes(line)).catch((error: unknown) => {
    throw new Error(`${(error as Error).message}\n${running.out()}`);
  });
  await Promise.race([came, died]);
}

export const json = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

export const machineOf = (on: { dir: string; user: string }) => machine({ env: { LIFESTREAM_MACHINE_DIR: on.dir }, home: on.user });

export async function doorOn(on: { env: NodeJS.ProcessEnv; dir: string; user: string }, slot?: SlotHanded): Promise<{ door: Door; port: number; logs: string[] }> {
  expect((await home(on, ["settings", "set", "door.port", "0"])).status).toBe(0);
  const at = machineOf(on);
  const { door, logs } = await openDoor(null, { machine: at, registry: homeRegistryModule(), settings: effectiveOf(startingSettings(at.home!, at), settingsPath(at.home!)).settings.door, ...(slot === undefined ? {} : { slot }) });
  expect((await home(on, ["settings", "set", "door.port", String(door.port)])).status).toBe(0);
  return { door, port: door.port, logs };
}

export function runsOn(folder: string): boolean {
  const lock = tryLock(join(folder, "home.lock"));
  lock?.release();
  return lock === null;
}

export const dashboardPass = (on: { dir: string }, folder: string) =>
  passOf(openHomeFolder(folder), readFileSync(join(on.dir, "dashboard", "door-token"), "utf8").trim());

export const revokedOn = (on: { dir: string }, folder: string) => json(join(on.dir, "revoked", `${readHome(folder).id}.json`)).revoked as string[];

export async function mintPasses(on: { env: NodeJS.ProcessEnv }, folder: string): Promise<Record<"deliver" | "read" | "station" | "find", { id: string; token: string }>> {
  const paired = (unit: string, kind: "mac" | "extension", scopes: Scope[], sources: string[]) => {
    const token = randomBytes(32).toString("base64url");
    return { id: mintPrincipal(openHomeFolder(folder), { unit, kind, scopes, sources, token, now_ms: Date.now() }).principal.id, token };
  };
  const deliver = paired("macbook-pro-0001", "mac", ["deliver"], ["apple-notes:local:macbook-pro-0001"]);
  const minted = async (unit: string, scope: Scope) => {
    const answer = await home(on, ["principals", "mint", "--unit", unit, "--scope", scope, "--json"]);
    expect(answer.status, answer.out).toBe(0);
    const { principal, token } = answer.result as { principal: { id: string }; token: string };
    return { id: principal.id, token };
  };
  const read = await minted("dashboard", "read");
  const station = paired("chrome-aa01", "extension", ["station"], []);
  return { deliver, read, station, find: await minted("privacy-bench", "find") };
}

export function phoneOf(folder: string, unit: string): { id: string; token: string } {
  const token = randomBytes(32).toString("base64url");
  return { id: mintPrincipal(openHomeFolder(folder), { unit, kind: "phone", scopes: ["deliver", "read"], sources: [`location:local:${unit}`], token, now_ms: Date.now() }).principal.id, token };
}

export const HEADERS = { deliver: DEVICE.mac, phone: { "lifestream-device": "phone/1.0.0" }, read: {}, station: { "lifestream-device": "extension/1.0.0" } } as const;
