import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "@lifestreamprotocol/core";
import { ArtifactError, claudeEnv, codesigned, codexEnv, lastEntry, makeReady, readyEntry, Refused, type Build, type SignatureCheck } from "@lifestreamprotocol/model";


const PROGRAM_NAMES = ["codex", "claude"] as const;
export type ProgramName = (typeof PROGRAM_NAMES)[number];

export function isProgramName(value: unknown): value is ProgramName {
  return PROGRAM_NAMES.some((name) => name === value);
}

export interface ProgramRow extends Build {
  name: ProgramName;
}

const CODEX = "0.166.0";
const CLAUDE = "2.1.321";

const PROGRAMS: Readonly<Record<string, readonly ProgramRow[]>> = {
  "darwin-arm64": [
    {
      name: "codex", version: CODEX, team: "2DC432GLL2", entry: "package/vendor/aarch64-apple-darwin/bin/codex",
      artifact: { url: `https://registry.npmjs.org/@openai/codex/-/codex-${CODEX}-darwin-arm64.tgz`, bytes: 147_077_955, sha256: "181d2eda8addbeca0b689c996df207293947928bdd9c88a097837ae1c7e69ca5" },
    },
    {
      name: "claude", version: CLAUDE, team: "Q6L2SF6YDW", entry: "package/claude",
      artifact: { url: `https://registry.npmjs.org/@anthropic-ai/claude-code-darwin-arm64/-/claude-code-darwin-arm64-${CLAUDE}.tgz`, bytes: 147_739_378, sha256: "c2a561c2f090d2875d5b7bfac7c65c9050db3416559e7f8b40979b3ca615d5a3" },
    },
  ],
};

const HERE: readonly ProgramRow[] = PROGRAMS[`${process.platform}-${process.arch}`] ?? [];

const PRODUCT: Record<ProgramName, string> = { codex: "Codex", claude: "Claude Code" };

const RETRY_MS = 5 * 60_000;

export function programFolder(dir: string, name: ProgramName): string {
  return join(dir, "subscriptions", name);
}

export function signInFolder(dir: string, name: ProgramName): string {
  return join(dir, name);
}

function chosen(dir: string, name: ProgramName): boolean {
  return existsSync(programFolder(dir, name));
}

export function readyBinary(dir: string, name: ProgramName, rows: readonly ProgramRow[] = Object.values(PROGRAMS).flat()): string | null {
  const version = rows.find((row) => row.name === name)?.version;
  return version === undefined ? null : readyEntry(programFolder(dir, name), version);
}

export function lastBinary(dir: string, name: ProgramName): string | null {
  return lastEntry(programFolder(dir, name));
}

function versionEnv(dir: string, name: ProgramName): NodeJS.ProcessEnv {
  const home = signInFolder(dir, name);
  return name === "codex" ? codexEnv(home) : claudeEnv(home);
}

export interface ProgramState {
  name: ProgramName;
  state: "absent" | "fetching" | "ready" | "failed";
  bytes: number | null;
  total: number | null;
  why: string | null;
}

export interface ProgramsOptions {
  dir: string;
  rows?: readonly ProgramRow[];
  signed?: SignatureCheck;
  overridden?: (name: ProgramName) => boolean;
  retryMs?: number;
  log?: (line: JsonObject) => void;
  ready?: (name: ProgramName) => void;
}

export class Programs {
  readonly #dir: string;
  readonly #rows: readonly ProgramRow[];
  readonly #signed: SignatureCheck;
  readonly #overridden: (name: ProgramName) => boolean;
  readonly #retryMs: number;
  readonly #log: (line: JsonObject) => void;
  readonly #readied: (name: ProgramName) => void;
  readonly #fetching = new Map<ProgramName, { done: Promise<void>; bytes: number }>();
  readonly #failed = new Map<ProgramName, string>();
  readonly #retries = new Map<ProgramName, ReturnType<typeof setTimeout>>();
  readonly #stopping = new AbortController();

  constructor(options: ProgramsOptions) {
    this.#dir = options.dir;
    this.#readied = options.ready ?? (() => undefined);
    this.#rows = options.rows ?? HERE;
    this.#signed = options.signed ?? codesigned;
    this.#overridden = options.overridden ?? (() => false);
    this.#retryMs = options.retryMs ?? RETRY_MS;
    this.#log = options.log ?? (() => undefined);
  }

  start(): void {
    for (const name of PROGRAM_NAMES) if (chosen(this.#dir, name)) void this.#fetch(name);
  }

  state(): ProgramState[] {
    return PROGRAM_NAMES.map((name) => this.#stateOf(name));
  }

  choose(name: ProgramName): ProgramState[] {
    mkdirSync(programFolder(this.#dir, name), { recursive: true });
    if (!this.#ready(name)) void this.#fetch(name);
    return this.state();
  }

  async close(): Promise<void> {
    this.#stopping.abort(new Error("the home is stopping"));
    for (const timer of this.#retries.values()) clearTimeout(timer);
    this.#retries.clear();
    await Promise.all([...this.#fetching.values()].map((each) => each.done));
  }

  #row(name: ProgramName): ProgramRow | undefined {
    return this.#rows.find((row) => row.name === name);
  }

  #ready(name: ProgramName): boolean {
    return readyBinary(this.#dir, name, this.#rows) !== null;
  }

  #stateOf(name: ProgramName): ProgramState {
    const base = { name, bytes: null, total: null, why: null };
    if (!chosen(this.#dir, name)) return { ...base, state: "absent" };
    if (this.#overridden(name) || this.#ready(name)) return { ...base, state: "ready" };
    const running = this.#fetching.get(name);
    if (running !== undefined) return { ...base, state: "fetching", bytes: running.bytes, total: this.#row(name)!.artifact.bytes };
    const why = this.#failed.get(name) ?? (this.#row(name) === undefined ? `The computer Lifestream runs on has no build of ${PRODUCT[name]}.` : `${PRODUCT[name]} is not ready on this Mac.`);
    return { ...base, state: "failed", why };
  }

  #fetch(name: ProgramName): Promise<void> {
    const running = this.#fetching.get(name);
    if (running !== undefined) return running.done;
    const row = this.#row(name);
    if (row === undefined || this.#overridden(name)) return Promise.resolve();
    clearTimeout(this.#retries.get(name));
    this.#retries.delete(name);
    this.#failed.delete(name);
    const entry = { done: Promise.resolve(), bytes: 0 };
    const started = Date.now();
    this.#log({ programs: "fetching", name, version: row.version });
    entry.done = makeReady(programFolder(this.#dir, name), row, { signed: this.#signed, env: versionEnv(this.#dir, name), signal: this.#stopping.signal, progress: (bytes) => { entry.bytes = bytes; } })
      .then(() => {
        this.#log({ programs: "ready", name, version: row.version, ms: Date.now() - started });
        this.#readied(name);
      })
      .catch((error: unknown) => {
        if (this.#stopping.signal.aborted) return;
        const why = wordsOf(name, error);
        this.#failed.set(name, why);
        this.#log({ programs: "failed", name, version: row.version, why, error: (error as Error).message ?? String(error) });
        if (retried(error)) {
          this.#retries.set(name, setTimeout(() => {
            this.#retries.delete(name);
            if (chosen(this.#dir, name) && !this.#ready(name) && !this.#stopping.signal.aborted) void this.#fetch(name);
          }, this.#retryMs));
        }
      })
      .finally(() => this.#fetching.delete(name));
    this.#fetching.set(name, entry);
    return entry.done;
  }
}

function retried(error: unknown): boolean {
  if (!(error instanceof ArtifactError)) return !(error instanceof Refused);
  return error.reason === "offline" || error.reason === "full" || error.reason === "disk" || (error.reason === "refused" && (error.status === 429 || (error.status ?? 0) >= 500));
}

function wordsOf(name: ProgramName, error: unknown): string {
  const product = PRODUCT[name];
  if (error instanceof Refused) return `${product} as downloaded is not what its maker published.`;
  if (!(error instanceof ArtifactError)) return `${product} could not be set up on this Mac.`;
  switch (error.reason) {
    case "offline": return "This Mac is offline.";
    case "hash": return `The download did not match what ${product}'s maker published.`;
    case "full": return `This Mac's disk is full: ${product} needs room to download.`;
    case "disk": return `This Mac could not write ${product} to its disk.`;
    case "refused": return `${product}'s download was refused${error.status === undefined ? "" : ` (HTTP ${error.status})`}.`;
  }
}
