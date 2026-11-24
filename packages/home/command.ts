import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { flush, writeDurably } from "@lifestreamprotocol/core";
import { CLI } from "./cli-name.js";
import type { Machine } from "./machine.js";
import { fromRelease, repoRoot } from "./programs.js";

export const BLOCK = [
  "# >>> Lifestream >>>",
  `case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac`,
  "# <<< Lifestream <<<",
  "",
].join("\n");
const START = "# >>> Lifestream >>>";
const END = "# <<< Lifestream <<<";

export const FISH = [
  "# Lifestream's command on PATH. Settings › Command line › Remove takes this file away.",
  "if not contains -- $HOME/.local/bin $PATH",
  "    set -gx PATH $HOME/.local/bin $PATH",
  "end",
  "",
].join("\n");

export const BLANK = "___";

const SHELL_MS = 5_000;

export interface CommandHost {
  machine: Pick<Machine, "dir" | "user">;
  shell: string | null;
  env(shell: string): string | null;
}

const nameOf = (shell: string): string => basename(shell).replace(/^-/u, "");

export function commandHost(at: Pick<Machine, "dir" | "user">): CommandHost {
  const shell = process.env.SHELL || (() => {
    try {
      return userInfo().shell;
    } catch {
      return null;
    }
  })();
  return {
    machine: at,
    shell: shell === "" ? null : shell,
    env: (path) => {
      const run = nameOf(path) === "zsh" ? `/usr/bin/env; print -r -- "ZDOTDIR=\${ZDOTDIR:-$HOME}"` : "/usr/bin/env";
      const ran = spawnSync(path, ["-ilc", run], { encoding: "utf8", timeout: SHELL_MS, stdio: ["ignore", "pipe", "ignore"], cwd: at.user, env: { ...process.env, HOME: at.user } });
      return ran.error !== undefined || ran.stdout === "" ? null : ran.stdout;
    },
  };
}

export type CommandState = "installed" | "absent" | "blocked";

export interface CommandAnswer {
  state: CommandState;
  link: string;
  words: string;
  did: string[];
  prompt: string;
}

interface Wrote {
  path: string;
  kind: "block" | "file";
  made: boolean;
  joined: boolean;
  pending?: true;
}

interface Record {
  link: { path: string; target: string } | null;
  wrote: Wrote[];
  declined: string[];
  manual: boolean;
  on_path: boolean | null;
}

const EMPTY: Record = { link: null, wrote: [], declined: [], manual: false, on_path: null };

const recordPath = (dir: string): string => join(dir, "command.json");

function readRecord(dir: string): Record {
  const path = recordPath(dir);
  if (!existsSync(path)) return { ...EMPTY };
  try {
    return { ...EMPTY, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<Record>) };
  } catch {
    return { ...EMPTY };
  }
}

function writeRecord(dir: string, record: Record): void {
  mkdirSync(dir, { recursive: true });
  writeDurably(recordPath(dir), `${JSON.stringify(record, null, 2)}\n`, 0o600);
}

const binOf = (user: string): string => join(user, ".local", "bin");
const linkOf = (user: string): string => join(binOf(user), CLI);

export function commandFile(dir: string): string {
  return fromRelease() ? join(dir, "current", "bin", CLI) : join(repoRoot(), "bin", CLI);
}

function shown(path: string, user: string): string {
  const under = relative(user, path);
  return under !== "" && !under.startsWith("..") && !under.startsWith(sep) ? `~/${under}` : path;
}

type At = { kind: "none" } | { kind: "ours"; target: string } | { kind: "other" };

function linkAt(path: string, target: string, dir: string): At {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return { kind: "none" };
  }
  if (!stat.isSymbolicLink()) return { kind: "other" };
  const to = readlinkSync(path);
  const into = relative(resolve(dir), resolve(dirname(path), to));
  return to === target || (!into.startsWith("..") && !into.startsWith(sep) && into !== "") ? { kind: "ours", target: to } : { kind: "other" };
}

function makeLink(user: string, target: string): string | null {
  try {
    mkdirSync(binOf(user), { recursive: true });
    symlinkSync(target, linkOf(user));
    return null;
  } catch (error) {
    return `Lifestream could not make ${shown(linkOf(user), user)}: ${(error as NodeJS.ErrnoException).code === "EACCES" ? "it may not write to ~/.local/bin" : (error as Error).message}.`;
  }
}

const OTHER = "Another program named lifestream is in ~/.local/bin. Lifestream left it alone.";

export function envOf(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u.exec(line);
    if (match !== null) vars.set(match[1]!, match[2]!);
  }
  return vars;
}

export function holdsBin(path: string, user: string): boolean {
  const bin = resolve(binOf(user));
  return path.split(":").some((entry) => entry !== "" && resolve(entry.startsWith("~/") ? join(user, entry.slice(2)) : entry) === bin);
}

function shellFiles(shell: string, user: string, vars: ReadonlyMap<string, string>): { path: string; kind: Wrote["kind"] }[] {
  const name = nameOf(shell);
  if (name === "zsh") {
    const dot = vars.get("ZDOTDIR") || user;
    return [{ path: join(dot, ".zprofile"), kind: "block" }, { path: join(dot, ".zshrc"), kind: "block" }];
  }
  if (name === "bash") {
    const read = [".bash_profile", ".bash_login", ".profile"].map((file) => join(user, file)).find((path) => existsSync(path));
    return [{ path: read ?? join(user, ".bash_profile"), kind: "block" }];
  }
  if (name === "fish") {
    const config = vars.get("XDG_CONFIG_HOME") || join(user, ".config");
    return [{ path: join(config, "fish", "conf.d", "lifestream.fish"), kind: "file" }];
  }
  return [];
}

const LINE_BREAK = 0x0a;

const readBytes = (path: string): Buffer | null => {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
};

const still = (wrote: Wrote): boolean => {
  const bytes = readBytes(wrote.path);
  return bytes !== null && (wrote.kind === "file" || bytes.includes(START));
};

function observe(record: Record): Record {
  const wrote: Wrote[] = [];
  const declined = new Set(record.declined);
  for (const each of record.wrote) {
    const { pending, ...settled } = each;
    if (still(each)) wrote.push(settled);
    else if (pending !== true) declined.add(each.path);
  }
  const same = wrote.length === record.wrote.length && record.wrote.every((each) => each.pending !== true);
  return same ? record : { ...record, wrote, declined: [...declined] };
}

function planned(path: string, kind: Wrote["kind"]): Wrote | null {
  const bytes = readBytes(path);
  if (kind === "file") return bytes === null ? { path, kind, made: true, joined: false } : null;
  if (bytes?.includes(START) === true) return null;
  return { path, kind, made: bytes === null, joined: bytes !== null && bytes.length > 0 && bytes[bytes.length - 1] !== LINE_BREAK };
}

function fileOf(path: string): string {
  let at = path;
  for (let hops = 0; hops < 32; hops += 1) {
    try {
      if (!lstatSync(at).isSymbolicLink()) return at;
    } catch {
      return at;
    }
    at = resolve(dirname(at), readlinkSync(at));
  }
  throw new Error(`${path} is a chain of more than 32 links`);
}

function rewrite(path: string, bytes: Uint8Array): void {
  const file = fileOf(path);
  mkdirSync(dirname(file), { recursive: true });
  const mode = existsSync(file) ? statSync(file).mode & 0o7777 : null;
  const temporary = join(dirname(file), `.${basename(file)}.lifestream-${process.pid}.tmp`);
  try {
    writeFileSync(temporary, bytes, { flag: "w" });
    if (mode !== null) chmodSync(temporary, mode);
    flush(temporary);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
  flush(dirname(file));
}

function write(wrote: Wrote): void {
  if (wrote.kind === "file") rewrite(wrote.path, Buffer.from(FISH));
  else rewrite(wrote.path, Buffer.concat([readBytes(wrote.path) ?? Buffer.alloc(0), Buffer.from(`${wrote.joined ? "\n" : ""}${BLOCK}`)]));
}

function unwrite(wrote: Wrote, user: string): string | null {
  const bytes = readBytes(wrote.path);
  if (bytes === null) return null;
  if (wrote.kind === "file") {
    if (!bytes.equals(Buffer.from(FISH))) return `${shown(wrote.path, user)} changed after Lifestream wrote it, so it stays: delete it yourself once you no longer want it.`;
    unlinkSync(wrote.path);
    return null;
  }
  let rest = bytes;
  for (let at = rest.indexOf(START); at >= 0; at = rest.indexOf(START)) {
    const end = rest.indexOf(END, at);
    if (end < 0) return `${shown(wrote.path, user)} holds the start of Lifestream's lines and not their end, so it stays: take out the lines from "${START}" yourself.`;
    const after = rest.indexOf(LINE_BREAK, end);
    const stop = after < 0 ? rest.length : after + 1;
    const from = wrote.joined && stop === rest.length && at > 0 && rest[at - 1] === LINE_BREAK ? at - 1 : at;
    rest = Buffer.concat([rest.subarray(0, from), rest.subarray(stop)]);
  }
  if (rest.length === bytes.length) return null;
  if (wrote.made && rest.length === 0 && !lstatSync(wrote.path).isSymbolicLink()) unlinkSync(wrote.path);
  else rewrite(wrote.path, rest);
  return null;
}

function answerOf(host: CommandHost, record: Record, did: string[], blocked: string | null = null): CommandAnswer {
  const { dir, user } = host.machine;
  const link = linkOf(user);
  const at = linkAt(link, commandFile(dir), dir);
  const state: CommandState = at.kind === "ours" ? "installed" : at.kind === "other" || blocked !== null ? "blocked" : "absent";
  const reached = record.on_path === true || record.wrote.length > 0;
  const words = state === "blocked" ? (at.kind === "other" ? OTHER : blocked!)
    : state === "absent" ? "Not installed."
      : record.manual ? `${CLI} is in ~/.local/bin, and Lifestream sets up PATH only for zsh, bash and fish: run it as ${link}, or add ~/.local/bin to your shell's PATH yourself.`
        : reached ? `${CLI} works in new terminal windows.`
          : `${CLI} is in ~/.local/bin, which your shell's PATH leaves out: run it as ~/.local/bin/${CLI}.`;
  return { state, link: shown(link, user), words, did, prompt: promptOf(dir, state === "installed", user) };
}

export function installCommand(host: CommandHost): CommandAnswer {
  const { dir, user } = host.machine;
  let record = observe(readRecord(dir));
  const did: string[] = [];
  const target = commandFile(dir);
  const link = linkOf(user);
  const at = linkAt(link, target, dir);
  let blocked: string | null = null;
  if (at.kind === "ours" && at.target !== target) rmSync(link);
  if (at.kind === "none" || (at.kind === "ours" && at.target !== target)) {
    blocked = makeLink(user, target);
    if (blocked === null) did.push(`linked ${shown(link, user)} to ${target}`);
  }
  if (blocked !== null || at.kind === "other") {
    writeRecord(dir, record);
    return answerOf(host, record, did, blocked);
  }
  record = { ...record, link: { path: link, target } };
  const env = host.shell === null ? null : host.env(host.shell);
  const vars = env === null ? new Map<string, string>() : envOf(env);
  const path = vars.get("PATH");
  const onPath = path === undefined ? null : holdsBin(path, user);
  const files = onPath === true ? [] : shellFiles(host.shell ?? "", user, vars);
  record = { ...record, on_path: onPath, manual: onPath !== true && files.length === 0 };
  for (const file of files) {
    if (record.declined.includes(file.path) || record.wrote.some((wrote) => wrote.path === file.path)) continue;
    const wrote = planned(file.path, file.kind);
    if (wrote === null) continue;
    record = { ...record, wrote: [...record.wrote, { ...wrote, pending: true }] };
    writeRecord(dir, record);
    try {
      write(wrote);
      did.push(`${wrote.made ? "made" : "added the PATH line to"} ${shown(wrote.path, user)}${wrote.made && wrote.kind === "block" ? ", with the PATH line" : ""}`);
    } catch (error) {
      did.push(`could not add the PATH line to ${shown(wrote.path, user)}: ${(error as Error).message}`);
    }
  }
  record = observe(record);
  if (env === null && host.shell !== null) did.push(`${basename(host.shell)} did not print its PATH within ${SHELL_MS / 1_000} seconds, so its startup files have the PATH line`);
  writeRecord(dir, record);
  return answerOf(host, record, did, blocked);
}

export function checkCommand(host: CommandHost): CommandAnswer {
  const { dir, user } = host.machine;
  const before = readRecord(dir);
  const record = observe(before);
  const did: string[] = [];
  let blocked: string | null = null;
  if (record.link !== null && linkAt(record.link.path, record.link.target, dir).kind === "none") {
    blocked = makeLink(user, record.link.target);
    if (blocked === null) did.push(`linked ${shown(record.link.path, user)} again`);
  }
  if (record !== before) writeRecord(dir, record);
  return answerOf(host, record, did, blocked);
}

export function removeCommand(host: Pick<CommandHost, "machine">): { removed: string[]; did: string[] } {
  const { dir, user } = host.machine;
  const record = readRecord(dir);
  const link = linkOf(user);
  const removed: string[] = [];
  const did: string[] = [];
  if (linkAt(link, record.link?.target ?? commandFile(dir), dir).kind === "ours") {
    rmSync(link);
    removed.push(link);
    did.push(`removed ${shown(link, user)}`);
  }
  const live = observe(record);
  if (live.wrote.length > 0) writeRecord(dir, { ...live, wrote: live.wrote.map((wrote) => ({ ...wrote, pending: true })) });
  for (const wrote of live.wrote) {
    const stays = unwrite(wrote, user);
    if (stays !== null) did.push(stays);
    else {
      removed.push(wrote.path);
      did.push(wrote.kind === "file" ? `removed ${shown(wrote.path, user)}` : `took the PATH line out of ${shown(wrote.path, user)}`);
    }
  }
  if (existsSync(recordPath(dir))) writeRecord(dir, { ...live, link: null, wrote: [], manual: false });
  return { removed, did };
}

export function removedCommand(host: CommandHost): CommandAnswer {
  const { did } = removeCommand(host);
  return answerOf(host, readRecord(host.machine.dir), did);
}

function commandWord(dir: string, linked: boolean, user: string): string {
  if (linked) return `~/.local/bin/${CLI}`;
  const path = join(dir, "current", "bin", CLI);
  const under = relative(user, path);
  const from = under !== "" && !under.startsWith("..") && !under.startsWith(sep) ? `$HOME/${under.replace(/["\\$`]/gu, "\\$&")}` : path.replace(/["\\$`]/gu, "\\$&");
  return `"${from}"`;
}

function promptOf(dir: string, linked: boolean, user: string): string {
  const word = commandWord(dir, linked, user);
  return `Lifestream runs on this Mac. Run ${word} help connectors and follow it to add a connector for ${BLANK}; type each lifestream command it names as ${word}.`;
}

export function addingOf(dir: string, user: string = homedir()): { prompt: string; blank: string } {
  return { prompt: promptOf(dir, linked(dir), user), blank: BLANK };
}

export function linked(dir: string): boolean {
  const link = readRecord(dir).link;
  return link !== null && linkAt(link.path, link.target, dir).kind === "ours";
}
