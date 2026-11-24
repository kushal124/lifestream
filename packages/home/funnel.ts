import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { isObject, writeDurably } from "@lifestreamprotocol/core";
import type { Machine } from "./machine.js";


export const PUBLIC_PORT = 4683;
const TARGET = `http://127.0.0.1:${PUBLIC_PORT}`;
const READ_MS = 10_000;
const SET_MS = 20_000;
const SIGN_IN_PAGE = /https:\/\/login\.tailscale\.com\/\S+/u;
const REMOVE = ["serve", "--https=443", "--set-path=/", "off"];
const DOWNLOAD = "https://tailscale.com/download/mac";

export interface PublicState {
  readonly state: "on" | "off" | "taken" | "blocked";
  readonly origin: string | null;
  readonly why: string | null;
  readonly open: string | null;
}

export interface Kept {
  readonly restored: "empty" | "funnel-off" | null;
  readonly state: PublicState | null;
}

export const REACH_META = "reach.need";

export interface ReachNeed {
  readonly state: "taken" | "blocked";
  readonly why: string;
  readonly open: string | null;
  readonly since_ms: number;
}

export const TAKEN = "Tailscale already serves something else at this address";
export const FUNNEL_ON = "Tailscale serves something else at this address, and Funnel is on for it: check Tailscale's serve settings";
const UNCONFIRMED = "Lifestream could not confirm what Tailscale serves now";
const NO_TAILSCALE = "Install Tailscale on this Mac";
const NOT_RUNNING = "Open Tailscale on this Mac";
const SIGNED_OUT = "Sign in to Tailscale";
const TURNED_OFF = "Turn on Tailscale";
const NO_FUNNEL = "Allow Funnel in Tailscale";
const KNOWN = new Set([NO_TAILSCALE, NOT_RUNNING, SIGNED_OUT, TURNED_OFF, NO_FUNNEL]);

type Held = "empty" | "ours" | "other";

interface Look {
  readonly blocked: PublicState | null;
  readonly origin: string;
  readonly address: string;
  readonly held: Held;
  readonly funnel: boolean;
  readonly mounted: boolean;
}

export function publicOrigin(at: Machine): string | null {
  try {
    const value = JSON.parse(readFileSync(publicFile(at), "utf8")) as unknown;
    return isObject(value) && typeof value.origin === "string" ? value.origin : null;
  } catch {
    return null;
  }
}

const turns = new Map<string, Promise<unknown>>();
const offs = new Map<string, number>();

function inTurn<T>(at: Machine, work: () => Promise<T>): Promise<T> {
  const mine = (turns.get(at.dir) ?? Promise.resolve()).then(work);
  const settled = mine.then(() => undefined, () => undefined);
  turns.set(at.dir, settled);
  void settled.then(() => {
    if (turns.get(at.dir) === settled) turns.delete(at.dir);
  });
  return mine;
}

export function reachIdle(at: Machine): Promise<void> {
  return (turns.get(at.dir) ?? Promise.resolve()).then(() => undefined);
}

export type NoteReach = (state: PublicState | null) => void;

function verbTurn(at: Machine, work: () => Promise<PublicState>, note?: NoteReach): Promise<PublicState> {
  return inTurn(at, async () => {
    const state = await work();
    note?.(existsSync(publicFile(at)) ? state : null);
    return state;
  });
}

export async function publicStatus(at: Machine): Promise<PublicState> {
  return stateOf(at, await lookAt(at));
}

export function publicOn(at: Machine, note?: NoteReach): Promise<PublicState> {
  const asked = offs.get(at.dir) ?? 0;
  return verbTurn(at, async () => {
    const before = await lookAt(at, true);
    if (before.blocked !== null && before.blocked.why !== NO_FUNNEL) return before.blocked;
    if (before.held === "other") return taken(before);
    return setOurs(at, before, () => (offs.get(at.dir) ?? 0) === asked);
  }, note);
}

export function publicOff(at: Machine, note?: NoteReach): Promise<PublicState> {
  offs.set(at.dir, (offs.get(at.dir) ?? 0) + 1);
  rmSync(publicFile(at), { force: true });
  return verbTurn(at, async () => {
    const look = await lookAt(at, true);
    if (look.blocked !== null && look.blocked.why !== NO_FUNNEL) return look.blocked;
    if (look.mounted) {
      const off = await removeOurs(at, look.address);
      if (off.code !== 0) return blocked(`Tailscale did not turn Funnel off: ${firstLine(off.out)}`, null);
    }
    return stateOf(at, await lookAt(at));
  }, note);
}

export function keepPublic(at: Machine, keeper: { live(): boolean; note(kept: Kept): void }): Promise<void> {
  return inTurn(at, async () => {
    if (!keeper.live()) return;
    const kept = await keeping(at, keeper.live);
    if (kept !== null && keeper.live()) keeper.note(kept);
  });
}

async function keeping(at: Machine, live: () => boolean): Promise<Kept | null> {
  if (!existsSync(publicFile(at))) return { restored: null, state: null };
  const look = await lookAt(at);
  if (look.blocked !== null) return { restored: null, state: look.blocked };
  if (look.held === "other") return { restored: null, state: taken(look) };
  if (look.held === "ours" && look.funnel) {
    if (publicOrigin(at) !== look.origin) writeOrigin(at, look.origin, () => existsSync(publicFile(at)));
    return { restored: null, state: { state: "on", origin: look.origin, why: null, open: null } };
  }
  if (!live()) return null;
  const state = await setOurs(at, look, () => existsSync(publicFile(at)));
  return { restored: state.state !== "on" ? null : look.held === "empty" ? "empty" : "funnel-off", state };
}

async function setOurs(at: Machine, before: Look, still: () => boolean): Promise<PublicState> {
  if (before.held !== "ours" || !before.funnel) {
    const set = await run(at.tailscale!, ["funnel", "--bg", "--yes", "--https=443", TARGET], SET_MS, true);
    if (set.page !== null) return blocked(NO_FUNNEL, set.page);
    if (set.code !== 0) return before.blocked ?? blocked(`Tailscale did not turn Funnel on: ${firstLine(set.out)}`, null);
  }
  const after = await lookAt(at);
  if (after.blocked !== null) return after.blocked;
  if (after.held !== "ours" || !after.funnel) {
    if (!after.mounted) return taken(after);
    await removeOurs(at, after.address);
    const final = await lookAt(at, true);
    if (final.blocked !== null && final.blocked.why !== NO_FUNNEL) {
      const last = taken(after);
      return { ...last, why: `${last.why}. ${UNCONFIRMED}` };
    }
    return taken(final);
  }
  return { state: writeOrigin(at, after.origin, still) ? "on" : "off", origin: after.origin, why: null, open: null };
}

function writeOrigin(at: Machine, origin: string, still: () => boolean): boolean {
  if (!still()) return false;
  mkdirSync(dirname(publicFile(at)), { recursive: true });
  writeDurably(publicFile(at), `${JSON.stringify({ origin })}\n`);
  return true;
}

export type Trouble = "no-tailscale" | "signed-out" | "not-running" | "no-funnel" | "taken" | "funnel-on" | "other";

export function troubleOf(state: PublicState): Trouble | null {
  if (state.state === "taken") return state.why?.startsWith(FUNNEL_ON) === true ? "funnel-on" : "taken";
  if (state.state !== "blocked") return null;
  if (state.why === NO_TAILSCALE) return "no-tailscale";
  if (state.why === SIGNED_OUT) return "signed-out";
  if (state.why === NOT_RUNNING || state.why === TURNED_OFF) return "not-running";
  if (state.why === NO_FUNNEL) return "no-funnel";
  return "other";
}

export function actionable(state: PublicState): boolean {
  return state.state === "taken" || (state.state === "blocked" && state.why !== null && KNOWN.has(state.why));
}

export function noteReach(meta: { get(key: string): string | undefined; set(key: string, value: string): void; delete(key: string): void }, state: PublicState | null, now_ms: number): void {
  const held = meta.get(REACH_META);
  if (state === null || (state.state !== "taken" && state.state !== "blocked")) {
    if (held !== undefined) meta.delete(REACH_META);
    return;
  }
  if (!actionable(state)) return;
  const was = held === undefined ? null : JSON.parse(held) as ReachNeed;
  const same = was !== null && was.state === state.state && was.why === state.why;
  if (same && was.open === state.open) return;
  const need: ReachNeed = { state: state.state, why: state.why ?? "", open: state.open, since_ms: same ? was.since_ms : now_ms };
  meta.set(REACH_META, JSON.stringify(need));
}

export function reachNeed(meta: { get(key: string): string | undefined }): ReachNeed | null {
  const held = meta.get(REACH_META);
  return held === undefined ? null : JSON.parse(held) as ReachNeed;
}

async function removeOurs(at: Machine, address: string): Promise<{ code: number | null; out: string }> {
  const read = await run(at.tailscale!, ["serve", "status", "--json"], READ_MS);
  const config = read.code === 0 ? parsed(read.out) : null;
  if (config === null) return { code: read.code ?? 1, out: read.out };
  return held(config, address).mounted ? run(at.tailscale!, REMOVE, SET_MS) : { code: 0, out: "" };
}

function stateOf(at: Machine, look: Look): PublicState {
  if (look.blocked !== null) return look.blocked;
  if (look.held === "other") return taken(look);
  const on = look.held === "ours" && look.funnel && publicOrigin(at) === look.origin;
  return { state: on ? "on" : "off", origin: look.origin, why: null, open: null };
}

async function lookAt(at: Machine, funnelOnly = false): Promise<Look> {
  const none = (state: PublicState): Look => ({ blocked: state, origin: "", address: "", held: "empty", funnel: false, mounted: false });
  const binary = at.tailscale;
  if (binary === null) return none(blocked(NO_TAILSCALE, DOWNLOAD));
  const status = await run(binary, ["status", "--json"], READ_MS);
  if (status.code === null) return none(blocked(`Tailscale did not answer: ${firstLine(status.out)}`, null));
  const read = status.code === 0 ? parsed(status.out) : null;
  if (read === null) return none(blocked(NOT_RUNNING, null));
  if (read.BackendState === "NeedsLogin") return none(blocked(SIGNED_OUT, typeof read.AuthURL === "string" && read.AuthURL !== "" ? read.AuthURL : null));
  const self = isObject(read.Self) ? read.Self : {};
  const name = typeof self.DNSName === "string" ? self.DNSName.replace(/\.$/u, "") : "";
  if (read.BackendState !== "Running" || name === "") return none(blocked(TURNED_OFF, null));
  const capabilities = new Set([...Object.keys(isObject(self.CapMap) ? self.CapMap : {}), ...(Array.isArray(self.Capabilities) ? self.Capabilities : [])]);
  const allowed = capabilities.has("https") && capabilities.has("funnel");
  if (!allowed && !funnelOnly) return none(blocked(NO_FUNNEL, null));
  const serving = await run(binary, ["serve", "status", "--json"], READ_MS);
  const config = serving.code === 0 ? parsed(serving.out) : null;
  if (config === null) return none(blocked(`Tailscale did not say what it serves: ${firstLine(serving.out)}`, null));
  return { blocked: allowed ? null : blocked(NO_FUNNEL, null), origin: `https://${name}`, address: `${name}:443`, ...held(config, `${name}:443`) };
}

function held(config: Record<string, unknown>, address: string): { held: Held; funnel: boolean; mounted: boolean } {
  const at443 = (value: unknown) => isObject(value) ? Object.keys(value).filter((key) => key === "443" || key.endsWith(":443")) : [];
  const foreground = Object.values(isObject(config.Foreground) ? config.Foreground : {});
  const tcp = isObject(config.TCP) ? config.TCP["443"] : undefined;
  const web = isObject(config.Web) ? config.Web : {};
  const handlers = isObject(web[address]) && isObject(web[address].Handlers) ? web[address].Handlers : {};
  const mounted = JSON.stringify(handlers["/"]) === JSON.stringify({ Proxy: TARGET });
  const funnel = isObject(config.AllowFunnel) && config.AllowFunnel[address] === true;
  const others = at443(config.Web).filter((key) => key !== address).length + at443(config.AllowFunnel).filter((key) => key !== address).length
    + foreground.reduce<number>((count, session) => count + (isObject(session) ? at443(session.TCP).length + at443(session.Web).length : 0), 0);
  if (tcp === undefined && Object.keys(handlers).length === 0 && !funnel && others === 0) return { held: "empty", funnel, mounted };
  const ours = others === 0 && JSON.stringify(tcp) === JSON.stringify({ HTTPS: true }) && Object.keys(handlers).length === 1 && mounted;
  return { held: ours ? "ours" : "other", funnel, mounted };
}

function publicFile(at: Machine): string {
  return join(at.dir, "mcp", "public.json");
}

function blocked(why: string, open: string | null): PublicState {
  return { state: "blocked", origin: null, why, open };
}


function taken(look: Pick<Look, "funnel">): PublicState {
  return { state: "taken", origin: null, why: look.funnel ? FUNNEL_ON : TAKEN, open: null };
}

function parsed(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown;
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find((line) => line !== "") ?? "it said nothing";
}

function run(binary: string, args: readonly string[], within: number, page = false): Promise<{ code: number | null; out: string; page: string | null }> {
  return new Promise((resolve) => {
    let out = "";
    let found: string | null = null;
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TAILSCALE_BE_CLI: "1" } });
    const timer = setTimeout(() => child.kill("SIGKILL"), within);
    const take = (chunk: Buffer) => {
      out += chunk.toString("utf8");
      const url = page ? SIGN_IN_PAGE.exec(out)?.[0] ?? null : null;
      if (url !== null && found === null) {
        found = url;
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, out: error.message, page: null });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, page: found });
    });
  });
}
