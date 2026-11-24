import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { homeSecrets, openHome, plainFolder, ownerOnly, tryLock, writeDurably, type FileLock, type HomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import { openLedger, type Ledger } from "@lifestreamprotocol/model";
import { errorText, storageError } from "./jobs.js";
import { startHome } from "./home.js";
import { systemRest } from "./at-rest.js";
import { adopt, folderHere, homeFolder, homeSocket, look, readHome, realPath, retire, standing } from "./lifecycle.js";
import { SERIAL4 } from "./pairing.js";
import { holdLine, readHold } from "./hold.js";
import { holdMissing, missingFiles, verify } from "./verbs/verify.js";
import { checkFiles, versionsOff } from "./home-file.js";
import { machine, type Machine } from "./machine.js";
import { move, quiet } from "./move.js";
import { fromRelease, homeRegistryModule, releaseFolder, repoRoot } from "./programs.js";
import { hand, handed, loadGeneration } from "./folders.js";
import { connectorsHelp, FOLDER_ACTIONS, FolderFailed, folderVerb } from "./verbs/connectors-folder.js";
import { homeOf, loadRegistry, type Loaded } from "./registry.js";
import { effective, runsAt } from "./settings.js";
import { buildRelease, install, launchd, rollback, selfCheckHere, type InitSystem } from "./release.js";
import { planUninstall, uninstall } from "./uninstall.js";
import { checkCommand, commandHost, installCommand, removedCommand, type CommandHost } from "./command.js";
import { ask, askHome, NoHomeError, type HomeSocket, type Out } from "./socket.js";
import { NO_ANSWER, NOT_NOW, Refusal, RETRY_SOON_S, STILL_WORKING } from "./refusal.js";
import { serveStations } from "./stations.js";
import { answerForm, readArgs } from "./verbs/args.js";
import { CLI } from "./cli-name.js";
import { fail, VERBS, maintenance, readOpsSettings, type VerbContext } from "./verbs/index.js";
import { agentsCall, MCP_ORIGIN, type CallAgent } from "./agent-call.js";
import { CREDENTIAL, draftRecovery, ENCRYPTED, NO_SLOT_KEY, readHandoff, Vault, VAULT_KEY, type MadeRecovery, type MadeVault, type SlotHanded, type VaultState } from "./vault.js";
import { secretInput } from "./secret-input.js";

export interface CliOptions {
  write?: (text: string) => void;
  going?: (text: string) => void;
  registry?: Loaded;
  now?: () => number;
  releases?: { dir: string; init: InitSystem };
  input?: () => Promise<string>;
  confirm?: Confirm | null;
  machine?: Machine;
  shell?: Pick<CommandHost, "shell" | "env">;
  waitMs?: number;
  startingMs?: number;
}

const COMMANDS = {
  maintenance: maintenance.usage,
  serve: "serve [--registry <module>]",
  build: "build [--commit <rev>]",
  install: "install [<release>]",
  "self-check": "self-check [--root <root>]",
  deploy: "deploy --rollback --to <sha>",
  machine: "machine [<folder>]",
  adopt: "adopt <folder> [--replace | --keyed] [--model <the Mac's marketing name> --serial4 <hex>] (--keyed: an encrypted home, its keys on standard input from the Lifestream app's first run)",
  keys: "keys draft (prints a new recovery key, its slot and day; writes nothing)",
  move: "move <folder>",
  retire: "retire",
  uninstall: "uninstall [--erase] [--apply] [--key-on-input]",
  command: "command [install | remove]",
  verify: verify.usage,
  stations: "stations --state <dir> [--port <n>] [--floor <version>] [--release <commit> [--generation <n>]] [--idle-ms <ms>] [--poll-ms <ms>]",
  secret: "secret set <name> (the value on standard input) | secret list",
  vault: "vault status | vault init | vault recover | vault new [--yes] (the recovery key on standard input; a machine without the Mac app; new replaces a vault no key opens, and deletes its passwords: it asks you to type delete, or takes --yes)",
} as const;
const USAGES: ReadonlyMap<string, string> = new Map([...Object.entries(VERBS).map(([name, verb]) => [name, verb.usage] as const), ...Object.entries(COMMANDS)]);
const FORM = "A verb's answer is its lines, for a person (one with no line of its own prints its answer as one line of JSON); with --json, its answer alone, as one line of JSON, for a program: never both. What a verb says as it goes, a wait or a warning, is on standard error.";
const HELP_FLAGS: readonly string[] = ["--help", "-h"];

export async function runCli(argv: readonly string[], options: CliOptions = {}): Promise<number> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const aside = options.going ?? ((text: string) => process.stderr.write(text));
  const args = [...argv];
  const at = args.indexOf("--root");
  const named = at >= 0 ? args.splice(at, 2)[1] : undefined;
  const helped = args[0] === "help" || HELP_FLAGS.includes(args[0] ?? "");
  const [verb, ...rest] = helped ? args.slice(1) : args;
  if (helped && verb === undefined) {
    write(`usage: ${CLI} <verb> [arguments…] [--root <root>] [--json]\n${[...USAGES.values()].map((usage) => `       ${CLI} ${usage}\n`).join("")}${FORM}\n`);
    return 0;
  }
  const usage = USAGES.get(verb ?? "");
  if (verb === undefined || usage === undefined) {
    write(`usage: ${CLI} <verb> [--root <root>]; ${CLI} help prints each verb's usage; verbs: ${[...USAGES.keys()].join(", ")}\n`);
    return 2;
  }
  if (helped || rest.some((word) => HELP_FLAGS.includes(word))) {
    const guide = verb === "connectors" && rest.every((word) => HELP_FLAGS.includes(word)) ? connectorsHelp(options.machine ?? machine()) : [];
    write(`usage: ${CLI} ${usage}\n${FORM}\n${guide.map((line) => `${line}\n`).join("")}`);
    return 0;
  }
  if (at >= 0 && (named === undefined || named === "" || named.startsWith("--"))) {
    write("--root names a folder: --root <path>\n");
    return 2;
  }
  const form = answerForm(rest);
  const json = form.json;
  const words = form.args;
  const print = (value: unknown) => {
    if (value !== undefined) write(`${JSON.stringify(value)}\n`);
  };
  let lined = false;
  const line = (text: string, going = false) => {
    if (going) return aside(`${text}\n`);
    if (json) return;
    lined = true;
    write(`${text}\n`);
  };
  const answer = (value: unknown) => {
    if (json || !lined) print(value);
  };
  try {
    if (verb === "self-check") {
      readArgs("self-check", words, {}, COMMANDS["self-check"], 0);
      const check = await selfCheckHere(named === undefined ? null : homeFolder(named));
      answer(check);
      return check.problems.length === 0 ? 0 : 1;
    }
    if (verb === "stations") {
      if (named !== undefined) fail(`stations needs no home, so no --root\nusage: ${CLI} ${COMMANDS.stations}`);
      return await stations(words, write);
    }
    if (verb === "adopt") {
      if (named !== undefined) fail(`adopt takes its folder as a word, not --root\nusage: ${CLI} ${COMMANDS.adopt}`);
      const { positionals, values } = readArgs("adopt", words, { replace: { type: "boolean" }, keyed: { type: "boolean" }, model: { type: "string" }, serial4: { type: "string" } }, COMMANDS.adopt, 1);
      if (values.serial4 !== undefined && (values.model === undefined || !SERIAL4.test(values.serial4))) fail(`--serial4 is four lowercase hex digits, with --model\nusage: ${CLI} ${COMMANDS.adopt}`);
      if (values.keyed === true && values.replace === true) fail(`--keyed makes a new home, so no --replace\nusage: ${CLI} ${COMMANDS.adopt}`);
      keepsAway(resolve(positionals[0]!), options.machine);
      const keyed = values.keyed === true ? readHandoff(await handedLine(options.input)) : undefined;
      answer(await adopt(resolve(positionals[0]!), {
        replace: values.replace === true, ...(keyed === undefined ? {} : { keyed }), ...(options.machine === undefined ? {} : { machine: options.machine }),
        ...(values.model === undefined ? {} : { model: values.model }), ...(values.serial4 === undefined ? {} : { serial4: values.serial4 }),
      }));
      return 0;
    }
    if (verb === "keys") {
      if (named !== undefined) fail(`keys draft needs no home, so no --root\nusage: ${CLI} ${COMMANDS.keys}`);
      const { positionals } = readArgs("keys", words, {}, COMMANDS.keys, 1);
      if (positionals[0] !== "draft") fail(`usage: ${CLI} ${COMMANDS.keys}`);
      print(draftRecovery((options.now ?? Date.now)()));
      return 0;
    }
    if (verb === "move") {
      if (named !== undefined) fail(`move moves the home this machine points at, so no --root\nusage: ${CLI} ${COMMANDS.move}`);
      const { positionals } = readArgs("move", words, {}, COMMANDS.move, 1);
      keepsAway(resolve(positionals[0]!), options.machine);
      const stop = new AbortController();
      const abort = () => stop.abort();
      process.on("SIGINT", abort).on("SIGTERM", abort).on("SIGHUP", abort);
      try {
        answer(await move(resolve(positionals[0]!), { out: (said) => line(said, true), signal: stop.signal }));
      } finally {
        process.off("SIGINT", abort).off("SIGTERM", abort).off("SIGHUP", abort);
      }
      return 0;
    }
    if (verb === "machine") {
      if (named !== undefined) fail(`machine takes its folder as a word, not --root\nusage: ${CLI} ${COMMANDS.machine}`);
      const { positionals } = readArgs("machine", words, {}, COMMANDS.machine, { min: 0, max: 1 });
      answer(look(positionals[0] === undefined ? null : resolve(positionals[0])));
      return 0;
    }
    if (verb === "build") {
      if (named !== undefined) fail(`build needs no home, so no --root\nusage: ${CLI} ${COMMANDS.build}`);
      const { values } = readArgs("build", words, { commit: { type: "string" } }, COMMANDS.build, 0);
      if (fromRelease()) fail(`build builds a release from a checkout: run bin/${CLI} build in the repository`);
      const built = buildRelease({ repo: repoRoot(), commit: values.commit ?? "main", into: builds() });
      answer({ release: built.release, ...built.manifest });
      return 0;
    }
    if (verb === "command") {
      if (named !== undefined) fail(`command puts lifestream on this machine's PATH, so no --root\nusage: ${CLI} ${COMMANDS.command}`);
      const { positionals } = readArgs("command", words, {}, COMMANDS.command, { min: 0, max: 1 });
      const at = options.machine ?? machine();
      const host = { ...commandHost(at), ...options.shell, machine: at };
      const act = positionals[0];
      if (act !== undefined && act !== "install" && act !== "remove") fail(`command takes install or remove\nusage: ${CLI} ${COMMANDS.command}`);
      const done = act === "install" ? installCommand(host) : act === "remove" ? removedCommand(host) : checkCommand(host);
      for (const each of [...done.did, done.words]) line(each);
      answer(done);
      return 0;
    }
    const releases = options.releases ?? { dir: machine().dir, init: launchd() };
    if (verb === "install") {
      answer(await installHome(named, words, releases));
      return 0;
    }
    if (verb === "uninstall") {
      if (named !== undefined) fail(`uninstall gives up the home this machine points at, so no --root\nusage: ${CLI} ${COMMANDS.uninstall}`);
      const { values } = readArgs("uninstall", words, { erase: { type: "boolean" }, apply: { type: "boolean" }, "key-on-input": { type: "boolean" } }, COMMANDS.uninstall, 0);
      const at = options.machine ?? machine();
      const erase = values.erase === true;
      const slot = values["key-on-input"] === true ? slotOnInput(await inputText(options.input)) : undefined;
      answer(values.apply === true
        ? await uninstall(at, releases.init, erase, { out: (said) => line(said, true), ...(slot === undefined ? {} : { slot }) })
        : planUninstall(at, releases.init, erase, slot));
      return 0;
    }
    if (verb === "connectors" && FOLDER_ACTIONS.has(words[0] ?? "")) {
      const root = named === undefined ? machine().home : resolve(named);
      try {
        answer(await folderVerb({ root, cwd: process.cwd(), out: (said) => line(said), ...(options.machine === undefined ? {} : { machine: options.machine }) }, words));
        return 0;
      } catch (error) {
        if (!(json && error instanceof FolderFailed)) throw error;
        print(error.answer);
        return 1;
      }
    }
    const here = machine();
    if (named === undefined && here.home === null) {
      write(`this machine holds no home: ${CLI} adopt <folder> makes one, or name one with --root <path>\n`);
      return 2;
    }
    if (verb === "serve") {
      const { values } = readArgs("serve", words, { registry: { type: "string" } }, COMMANDS.serve, 0);
      return await serve(named === undefined ? null : resolve(named), values.registry);
    }
    if (verb === "status") {
      const now = standing(named === undefined ? here.home! : resolve(named), here);
      const waits = "away" in now ? now.away : "refused" in now ? now.refused : now.hold === null ? null : holdLine(now.hold, now.folder);
      if (waits !== null) {
        write(json ? `${JSON.stringify({ waits })}\n` : `${waits}\n`);
        return 1;
      }
    }
    const root = homeFolder(named, here);
    if (verb === "agents" && words[0] === "call") {
      const called = await agentsCall(words.slice(1), { mcp: process.env.LIFESTREAM_MCP || MCP_ORIGIN, line, pass: () => callPass(root, line, options.machine?.dir) });
      answer(called.answer);
      return called.ok ? 0 : 1;
    }
    if (verb === "verify") {
      const verified = await verify(root, here, words, (said) => line(said));
      answer(verified);
      return "asked" in verified || verified.holds ? 0 : 1;
    }
    if (verb === "deploy") {
      const to = rollbackTo(words);
      if (root !== here.home) fail(`the home's jobs run on the folder this machine points at (${here.home ?? "none"}), not ${root}: ${CLI} adopt ${root} first`);
      answer(rollback({ ...releases, root }, to));
      return 0;
    }
    if (verb === "retire") {
      readArgs("retire", words, {}, COMMANDS.retire, 0);
      let retired: unknown;
      let stopping = false;
      try {
        retired = await askHome(homeSocket(root, options.machine?.dir), "retire");
        stopping = true;
      } catch (error) {
        if (!(error instanceof NoHomeError) || error.asked) throw error;
      }
      const locks = await quiet(root, { stopping, ...(options.machine === undefined ? {} : { machine: options.machine }) });
      try {
        retired ??= retire(root);
      } finally {
        locks.release();
      }
      answer(retired);
      return 0;
    }
    if (verb === "secret" || verb === "vault") {
      const at = options.machine ?? machine();
      const input: Typed = options.input ?? ((label, piped) => secretInput({ label, piped, macApp: at.macApp }));
      const confirm = options.confirm !== undefined ? options.confirm : process.stdin.isTTY === true ? typedLine : null;
      return verb === "secret" ? await secret(root, words, answer, input, at) : await vault(root, words, write, json, { input, confirm }, at);
    }
    const folder = () => folderHere(root);
    const plans = (verb === "repair" || verb === "undo") && !words.includes("--apply") && plainFolder(root) !== null;
    let lock: FileLock | null;
    if (plans) lock = tryLock(join(root, "home.lock"));
    else {
      const asked = await askWaiting(root, verb, rest, line, options.machine?.dir, options.waitMs, options.startingMs);
      if ("result" in asked) {
        answer(asked.result ?? undefined);
        return 0;
      }
      lock = asked.lock;
    }
    if (lock === null) {
      if (!plans) {
        write("home.lock is held but the home's socket does not answer: a home is starting or stopping, or maintenance runs; try again\n");
        return 1;
      }
      const context = openContext(folder(), write, options, "read", line);
      try {
        answer(await VERBS[verb]!(context, words));
      } finally {
        context.close();
      }
      return 0;
    }
    try {
      const opened = folder();
      if (verb === "maintenance") {
        answer(maintenance(opened, words));
        return 0;
      }
      const reading = verb === "status" && existsSync(join(root, "home.db")) && existsSync(join(root, "replies", "replies.db"));
      if (reading) {
        const off = versionsOff(opened);
        if (off.length > 0) {
          write(json ? `${JSON.stringify({ waits: off.join("\n") })}\n` : `${off.join("\n")}\n`);
          return 1;
        }
      }
      const context = openContext(opened, write, options, reading ? "read" : "write", line);
      try {
        answer(await VERBS[verb]!(context, words));
      } finally {
        context.close();
      }
      return 0;
    } finally {
      lock.release();
    }
  } catch (error) {
    write(`${(error as Error).message}\n`);
    return 1;
  }
}

const WAIT_MS = 60_000;
const STARTING_MS = 2_000;

function keepsAway(folder: string, handed: Machine | undefined): void {
  if (handed !== undefined || fromRelease() || (process.env.LIFESTREAM_MACHINE_DIR ?? "") !== "") return;
  const at = machine();
  if (at.home === null || !existsSync(at.home) || realPath(at.home) === realPath(folder)) return;
  fail(`this checkout would point this machine away from its home at ${at.home}. A home run from a checkout keeps its own machine files: `
    + `export LIFESTREAM_MACHINE_DIR="$PWD/.build/dev/machine" first (docs/contributing/develop.md). To change this machine's home on purpose, set LIFESTREAM_MACHINE_DIR=${at.dir}`);
}

async function askWaiting(root: string, verb: string, rest: readonly string[], line: Out, machineDir?: string, waitMs: number = WAIT_MS, startingMs: number = STARTING_MS): Promise<{ result: unknown } | { lock: FileLock | null }> {
  const deadline = Date.now() + waitMs;
  const said = new Set<string>();
  const once = (words: string) => {
    if (said.has(words)) return;
    said.add(words);
    line(words, true);
  };
  for (;;) {
    try {
      return { result: await askHome(homeSocket(root, machineDir), verb, rest, line) };
    } catch (error) {
      if (error instanceof Refusal && error.code === NOT_NOW) {
        const left = deadline - Date.now();
        if (left <= 0) throw error;
        once(`${error.message} (asking again)`);
        await delay(Math.min((error.retryAfter ?? RETRY_SOON_S) * 1_000, left));
        continue;
      }
      if (!(error instanceof NoHomeError) || error.asked) throw error;
      const lock = tryLock(join(root, "home.lock"));
      if (lock !== null || !error.absent || Date.now() >= deadline) return { lock };
      once("the home is starting; waiting");
      await delay(Math.min(startingMs, Math.max(0, deadline - Date.now())));
    }
  }
}

async function callPass(root: string, line: Out, machineDir?: string): Promise<{ pass: string; agent: CallAgent }> {
  const asked = await askWaiting(root, "agents-call", [], line, machineDir);
  if ("result" in asked) return asked.result as { pass: string; agent: CallAgent };
  asked.lock?.release();
  return fail(`no home runs on ${root}: ${CLI} agents call reads it through the running home's door and the MCP server; start the home (open Lifestream, or ${CLI} serve), then ask again`);
}

async function secret(root: string, args: readonly string[], answer: (value: unknown) => void, input: Typed, at: Machine): Promise<number> {
  const { positionals } = readArgs("secret", args, {}, COMMANDS.secret, { min: 1, max: 2 });
  const [what, name] = positionals as [string, string | undefined];
  if (what === "list" && name === undefined) {
    answer(homeSecrets(join(root, "config", "secrets")).list());
    return 0;
  }
  if (what !== "set" || name === undefined) fail(`usage: ${CLI} ${COMMANDS.secret}`);
  const value = (await input(name, `printf '%s' "<${name}>" | ${CLI} secret set ${name}`)).replace(/\r?\n$/u, "");
  if (value === "") fail(`no value was given for ${name} on standard input`);
  try {
    answer(await ask(homeSocket(root, at.dir), { verb: "seal", secret: name, value, cwd: process.cwd() }));
  } catch (error) {
    if (!(error instanceof NoHomeError)) throw error;
    fail(`no home runs on ${root}: the running home holds the vault key a password is sealed with; start it, then set ${name} again`);
  }
  return 0;
}

async function vault(root: string, args: readonly string[], write: (text: string) => void, json: boolean, { input, confirm }: { input: Typed; confirm: Confirm | null }, at: Machine): Promise<number> {
  const { positionals, values } = readArgs("vault", args, { yes: { type: "boolean" } }, COMMANDS.vault, 1);
  const what = positionals[0]!;
  if (values.yes === true && what !== "new") fail(`--yes is an argument of vault new only\nusage: ${CLI} ${COMMANDS.vault}`);
  const sock = homeSocket(root, at.dir);
  if (what === "status") {
    let state: VaultState & { requests?: { at_ms: number; secret: string; lane: string; task: string; ok: boolean }[] };
    let running = true;
    try {
      state = (await ask(sock, { verb: "vault" })) as typeof state;
    } catch (error) {
      if (!(error instanceof NoHomeError)) throw error;
      state = new Vault({ root, machine: at.dir, home: readHome(root).id }).state();
      running = false;
    }
    write(json ? `${JSON.stringify({ ...state, running })}\n` : vaultLines(state, running));
    return 0;
  }
  if (what !== "init" && what !== "recover" && what !== "new") fail(`usage: ${CLI} ${COMMANDS.vault}`);
  if (json) fail(`vault ${what} is said in lines, for a person at the terminal: run it without --json`);
  if (at.macApp) fail(`vault ${what} at a terminal is refused on a Mac with the Lifestream app: its screen recorder and input log would keep the recovery key; open Lifestream, whose window shows and takes it`);
  const withSlot = async (request: JsonObject): Promise<unknown> => {
    const slot = tpmSlot(at);
    if (slot === null) {
      write("this machine has no TPM: the vault gets no machine slot, so the home starts locked after each restart until the recovery key opens it; save the recovery key before the home next restarts\n");
      return ask(sock, request);
    }
    const before = credential(at);
    keepCredential(at, slot.sealed);
    try {
      return await ask(sock, { ...request, slot_key: slot.key.toString("base64"), store: "systemd-tpm2" });
    } catch (error) {
      if (error instanceof NoHomeError && error.asked) return fail(answerLost(request.verb as string, error));
      keepCredential(at, before);
      throw error;
    }
  };
  try {
    if (what === "recover") {
      const typed = (await input("recovery key", `printf '%s' "<recovery key>" | ${CLI} vault ${what}`)).trim();
      const recovered = (await withSlot({ verb: "recover", recovery: typed })) as { key_id: string; slot: string | null };
      write(`vault ${recovered.key_id} opened${recovered.slot === null ? "" : `; machine slot ${recovered.slot} added`}\n`);
      return 0;
    }
    let shown: MadeRecovery;
    const state = (await ask(sock, { verb: "vault" })) as VaultState;
    if (what === "new" && state.keyed) fail(ENCRYPTED);
    if (what === "init" && state.keyed) fail("this home is encrypted: a new recovery key is made in the Lifestream app, which shows it to you and hands it to the home; no terminal makes one");
    if (what === "new" && state.locked && state.key_id !== null) {
      const opened = await credentialOpens(sock, at, state.key_id);
      if (opened.key_id !== null) {
        write(`this machine's ${CREDENTIAL}.cred opened vault ${opened.key_id}: its passwords are open and nothing was deleted. The home started without it: start the home from its unit, which loads it (LoadCredentialEncrypted=${CREDENTIAL}:${join(at.dir, `${CREDENTIAL}.cred`)}), or it starts locked again\n`);
        return 0;
      }
      write(`${opened.why}\n`);
      await confirmDelete(state.key_id, values.yes === true, confirm);
    }
    if (what !== "new" && state.recovery === "confirmed") fail(`a vault exists (key ${state.key_id}) and its recovery key is confirmed: nothing to make`);
    if (what === "new" || state.key_id === null) {
      const answered = (await withSlot({ verb: what === "new" ? "vault-new" : "vault-init" })) as MadeVault | { opened: string };
      if ("opened" in answered) {
        write(`vault ${answered.opened} opened with this machine's key: its passwords are open and nothing was deleted\n`);
        return 0;
      }
      const made = answered;
      write(`vault ${made.key_id} made${made.slot === null ? "" : `, machine slot ${made.slot}`}${what === "new" ? ", in place of the vault no key opened: its passwords are deleted, and each stream that needs one asks for it again" : ""}\n`);
      shown = made;
    } else {
      shown = (await ask(sock, { verb: "vault-recovery" })) as MadeRecovery;
      write(`vault ${state.key_id}: its recovery key was never confirmed; a new one is made\n`);
    }
    const [name, madeOn] = recoveryName(shown, runsAt(root, "day.zone") as string);
    write(`\nyour recovery key, shown once (save it in your password manager or print it):\n\n    ${name}\n    ${madeOn}\n\n    ${shown.recovery}\n\ntype it back to confirm it:\n`);
    const confirmed = (await ask(sock, { verb: "vault-confirm", recovery: (await input("recovery key", `printf '%s' "<recovery key>" | ${CLI} vault ${what}`)).trim() })) as { confirmed: string };
    write(`recovery key ${confirmed.confirmed} confirmed: the vault opened with it\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof NoHomeError)) throw error;
    return fail(`no home runs on ${root}: the running home holds the vault; start it, then run vault ${what} again`);
  }
}

function recoveryName(made: MadeRecovery, zone: string): [string, string] {
  const day = new Date(made.made_ms).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: zone });
  return [`Lifestream recovery key ${made.recovery_slot.slice("r-".length)}`, `Made on ${day}`];
}

async function credentialOpens(sock: HomeSocket, at: Machine, keyId: string): Promise<{ key_id: string; why?: never } | { key_id: null; why: string }> {
  const path = join(at.dir, `${CREDENTIAL}.cred`);
  if (!existsSync(path)) return { key_id: null, why: `this machine keeps no ${CREDENTIAL}.cred, so no machine slot opens vault ${keyId} here` };
  if (at.systemdCreds === null) return { key_id: null, why: `this machine has no systemd-creds to decrypt its ${CREDENTIAL}.cred, so no machine slot opens vault ${keyId} here` };
  const decrypted = spawnSync(at.systemdCreds, ["decrypt", `--name=${CREDENTIAL}`, path, "-"]);
  if (decrypted.status !== 0 || decrypted.stdout.length === 0) return { key_id: null, why: `this machine's ${CREDENTIAL}.cred does not decrypt (${decrypted.stderr.toString("utf8").trim() || `systemd-creds exited ${decrypted.status}`}), so it does not open vault ${keyId}` };
  try {
    return (await ask(sock, { verb: "unlock", slot_key: decrypted.stdout.toString("base64") })) as { key_id: string };
  } catch (error) {
    if (!(error instanceof Refusal && error.code === VAULT_KEY)) throw error;
    return { key_id: null, why: `this machine's ${CREDENTIAL}.cred does not open vault ${keyId}` };
  }
}

async function confirmDelete(keyId: string, yes: boolean, confirm: Confirm | null): Promise<void> {
  if (yes) return;
  const warning = `a new vault deletes every password sealed by vault ${keyId}, which no key here opens, and each stream that needs one asks for it again`;
  if (confirm === null) fail(`${warning}: nothing was deleted; run vault new at a terminal and type delete, or give --yes`);
  const typed = (await confirm(`${warning}.\nType delete to go on: `)).trim();
  if (typed !== "delete") fail(`nothing was deleted: vault new goes on only when delete is typed`);
}

async function typedLine(question: string): Promise<string> {
  const lines = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  try {
    return await new Promise<string>((done) => {
      lines.once("SIGINT", () => done(""));
      lines.question(question, done);
    });
  } finally {
    lines.close();
  }
}

function answerLost(verb: string, error: NoHomeError): string {
  const after = verb === "recover"
    ? "if it says unlocked, the recovery took"
    : `if it shows a recovery key unconfirmed, the vault was made and its recovery key never shown: ${CLI} vault init makes a new one to save`;
  return `${error.began ? STILL_WORKING : NO_ANSWER} It may have run ${verb} (${error.message}), so this machine keeps the new ${CREDENTIAL}.cred, the one that opens what it made. Run ${CLI} vault status: ${after}`;
}

function tpmSlot(at: Machine): { key: Buffer; sealed: Buffer } | null {
  if (at.systemdCreds === null || spawnSync(at.systemdCreds, ["has-tpm2"], { stdio: "ignore" }).status !== 0) return null;
  const key = randomBytes(32);
  const encrypted = spawnSync(at.systemdCreds, ["encrypt", "--with-key=tpm2", `--name=${CREDENTIAL}`, "-", "-"], { input: key });
  if (encrypted.status !== 0 || encrypted.stdout.length === 0) fail(`systemd-creds could not encrypt the machine slot's key to the TPM: ${encrypted.stderr.toString("utf8").trim()}`);
  return { key, sealed: encrypted.stdout };
}

function credential(at: Machine): Buffer | null {
  const path = join(at.dir, `${CREDENTIAL}.cred`);
  return existsSync(path) ? readFileSync(path) : null;
}

function keepCredential(at: Machine, sealed: Buffer | null): void {
  const path = join(at.dir, `${CREDENTIAL}.cred`);
  if (sealed === null) rmSync(path, { force: true });
  else writeDurably(path, sealed, 0o600);
}

function vaultLines(state: VaultState & { requests?: { at_ms: number; secret: string; lane: string; task: string; ok: boolean }[] }, running: boolean): string {
  const at = (ms: number) => new Date(ms).toISOString();
  const lines: string[] = [];
  const holds = !running ? "the home is not running" : state.locked ? "locked" : `unlocked (by ${state.opened!.by}, ${state.opened!.slot}, at ${at(state.opened!.at_ms)})`;
  lines.push(state.key_id === null ? `no vault yet${state.migrate === null ? "" : `: items are sealed by key ${state.migrate.key_id}, which the vault is made from`}; ${holds}` : `key ${state.key_id}: ${holds}`);
  if (state.unreadable !== undefined) lines.push(`vault: ${state.unreadable}`);
  for (const slot of state.slots) {
    lines.push(slot.kind === "machine"
      ? `machine ${slot.id} unit ${slot.unit ?? "?"} store ${slot.store} made ${at(slot.made_ms)}`
      : `recovery ${slot.id} made ${at(slot.made_ms)} ${slot.confirmed_ms === undefined ? "unconfirmed" : `confirmed ${at(slot.confirmed_ms)}`}`);
  }
  lines.push(`plain items: ${state.plain.length === 0 ? "none" : state.plain.join(", ")}`);
  if (running) {
    lines.push(`secret requests (last ${state.requests?.length ?? 0}):`);
    for (const request of state.requests ?? []) lines.push(`  ${at(request.at_ms)} ${request.secret} ${request.lane} ${request.task} ${request.ok ? "ok" : "refused"}`);
  }
  return `${lines.join("\n")}\n`;
}

type Typed = (label: string, piped: string) => Promise<string>;

async function handedLine(input: (() => Promise<string>) | undefined): Promise<string> {
  const refused = "--keyed is made by the Lifestream app's first run, which hands this home's keys on standard input";
  if (input === undefined && process.stdin.isTTY === true) fail(refused);
  const text = await inputText(input);
  if (text.trim() === "") fail(refused);
  return text;
}

async function inputText(input: (() => Promise<string>) | undefined): Promise<string> {
  if (input !== undefined) return input();
  if (process.stdin.isTTY === true) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function slotOnInput(text: string): SlotHanded {
  const key = text.trim();
  if (key === "") return NO_SLOT_KEY;
  if (!/^[0-9a-fA-F]{64}$/u.test(key)) fail(`--key-on-input reads this Mac's slot key on standard input: 32 bytes of hex\nusage: ${CLI} ${COMMANDS.uninstall}`);
  return { key: Buffer.from(key, "hex"), why: null };
}
type Confirm = (question: string) => Promise<string>;

function rollbackTo(args: readonly string[]): string | undefined {
  const { values } = readArgs("deploy", args, { rollback: { type: "boolean" }, to: { type: "string" } }, COMMANDS.deploy, 0);
  if (values.rollback !== true) {
    fail(`deploy only rolls back: a release arrives inside the Mac app (python3 macos-app/install-app.py builds and installs it), or by ${CLI} build then ${CLI} install <release>\nusage: ${CLI} ${COMMANDS.deploy}`);
  }
  return values.to;
}


function builds(): string {
  return join(repoRoot(), ".build", "lifestream");
}

async function installHome(named: string | undefined, args: readonly string[], releases: { dir: string; init: InitSystem }) {
  const { positionals } = readArgs("install", args, {}, COMMANDS.install, { min: 0, max: 1 });
  if (named !== undefined) fail(`install checks a release against the folder this machine points at, so no --root\nusage: ${CLI} ${COMMANDS.install}`);
  const release = positionals[0] === undefined
    ? fromRelease() ? releaseFolder() : fail(`name the release to install: ${CLI} build makes one\nusage: ${CLI} ${COMMANDS.install}`)
    : resolve(positionals[0]);
  return install({ ...releases, root: machine().home }, release);
}

export function openContext(folder: HomeFolder, write: (text: string) => void, options: CliOptions = {}, mode: "write" | "read" = "write", out: Out = (line) => write(`${line}\n`)): VerbContext & { close(): void } {
  const at = options.machine ?? machine();
  const { root } = folder;
  if (mode === "write") {
    const { id } = readHome(root);
    const held = readHold(at, id);
    if (held !== null) fail(holdLine(held, root));
    const missing = missingFiles(root);
    if (missing.length > 0) fail(holdLine(holdMissing(at, id, missing), root));
  }
  const settings = readOpsSettings(folder);
  let registry: Promise<Loaded> | undefined;
  const log = (line: JsonObject) => write(`${JSON.stringify(line)}\n`);
  if (mode === "write") checkFiles(folder);
  const now = options.now ?? Date.now;
  const db = openHome(folder, mode === "write" ? "migrate" : "read", { log, clock: now, day: () => settings.day });
  let ledger: Ledger | undefined = mode === "write" ? openLedger(folder, { mode: "migrate", log }) : undefined;
  return {
    folder, machine: at, cwd: process.cwd(), by: "terminal", db, settings, blobs: folder.blobs(join(root, "blobs"), mode === "read" ? { reading: true } : {}),
    get ledger() {
      return (ledger ??= openLedger(folder, { mode: "read" }));
    },
    registry: () => (registry ??= options.registry === undefined
      ? (async () => {
        if (handed(root) === null) hand(await loadGeneration({ root, machineDir: at.dir }));
        return loadRegistry(homeRegistryModule().href, effective(folder).settings, homeOf(folder));
      })()
      : Promise.resolve(options.registry)),
    settingsChanged: () => {
      if (options.registry === undefined) registry = undefined;
    },
    now,
    out: (line) => out(line),
    going: (line) => out(line, true),
    close() {
      ledger?.close();
      db.close();
    },
  };
}

async function stations(args: readonly string[], write: (text: string) => void): Promise<number> {
  const { values } = readArgs("stations", args, {
    state: { type: "string" }, port: { type: "string" }, floor: { type: "string" }, release: { type: "string" }, generation: { type: "string" }, "idle-ms": { type: "string" }, "poll-ms": { type: "string" },
  }, COMMANDS.stations, 0);
  if (values.state === undefined) fail(`--state names the directory the stations keep their passes, files and transcript in\nusage: ${CLI} ${COMMANDS.stations}`);
  const whole = (value: string | undefined, flag: string): number | undefined => {
    if (value === undefined) return undefined;
    if (!/^\d+$/u.test(value)) fail(`${flag} is a whole number\nusage: ${CLI} ${COMMANDS.stations}`);
    return Number(value);
  };
  const port = whole(values.port, "--port");
  const idle = whole(values["idle-ms"], "--idle-ms");
  const poll = whole(values["poll-ms"], "--poll-ms");
  const generation = whole(values.generation, "--generation");
  if (generation !== undefined && values.release === undefined) fail(`--generation is a release's: name it with --release\nusage: ${CLI} ${COMMANDS.stations}`);
  const signal = stopSignal();
  const served = await serveStations(resolve(values.state), {
    ...(port === undefined ? {} : { port }), ...(values.floor === undefined ? {} : { floor: values.floor }),
    ...(values.release === undefined ? {} : { home: { version: values.release, generation: generation ?? null } }),
    ...(idle === undefined ? {} : { idle_ms: idle }), ...(poll === undefined ? {} : { poll_ms: poll }),
  });
  write(`stations at ${served.url}; the drive pass and the pairing code in ${join(resolve(values.state), "relay.json")}\n`);
  await signal;
  await served.close();
  return 0;
}

function stopSignal(): Promise<void> {
  return new Promise((done) => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => done());
  });
}

async function serve(root: string | null, registry: string | undefined): Promise<number> {
  const stopping = new AbortController();
  const signal = stopSignal().then(() => stopping.abort());
  let home: Awaited<ReturnType<typeof startHome>>;
  try {
    home = await startHome(root, { registry: registry ?? homeRegistryModule(), signal: stopping.signal, ...(registry === undefined ? { rest: systemRest } : {}) });
  } catch (error) {
    if (stopping.signal.aborted) return 0;
    const why = storageError(error) ? `storage: ${errorText(error)}` : errorText(error);
    process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), home: "failed", why })}\n`);
    return 1;
  }
  const signalled = await Promise.race([signal.then(() => true as const), home.stopped.then(() => false as const)]);
  await home.stop();
  return signalled ? 0 : 1;
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  ownerOnly();
  runCli(process.argv.slice(2)).then((status) => process.stdout.write("", () => process.exit(status)));
}
