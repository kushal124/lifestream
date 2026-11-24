import { readFileSync } from "node:fs";
import { join } from "node:path";
import { damaged, handedFolderIn, LEDGER_DB, openHandedFolder } from "@lifestreamprotocol/core";
import { CALL_EXIT, LEDGER_DAMAGED_EXIT, runCall, type CallResult, type CallRoute } from "./call.js";
import { callCopiesOf } from "./ledger.js";
import { bounded, errorText } from "./transport.js";
import { readTransportSettings, type TransportSettings } from "./settings.js";
import type { ProgramAt } from "./transports/program.js";

const args = new Map<string, string>();
process.on("uncaughtException", (error) => exit(1, errorText(error)));
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 2) {
  const name = argv[index];
  const value = argv[index + 1];
  if (name === undefined || !name.startsWith("--") || value === undefined) usage();
  args.set(name.slice(2), value);
}
const root = args.get("root");
const key = args.get("key");
const route = readRoute(args.get("route"));
if (root === undefined || key === undefined || !/^sha256:[0-9a-f]{64}$/u.test(key) || route === null) usage();
const transports = readTransports(args.get("transports") ?? "{}");
const programs = readPrograms(args.get("programs") ?? "{}");
const door = args.get("door");
const copy = args.get("sent-copy");
if (copy !== undefined && !/^[1-9]\d{0,14}$/u.test(copy)) usage();
const machine = args.get("machine");
const home = args.get("home");
if (machine === undefined || machine === "" || home === undefined || !/^[^/]+$/u.test(home) || home === "." || home === "..") usage();

const killAt = process.env.LIFESTREAM_CALL_FAILPOINT;
let result: CallResult;
try {
  const [secretsLine = "", folderLine = ""] = readFileSync(0, "utf8").split("\n", 2);
  if (folderLine.trim() === "") exit(64, "standard input holds no folder line: the home hands its folder on the second line, plain or keyed");
  const secrets = secretsOf(secretsLine);
  const folder = openHandedFolder(handedFolderIn(folderLine));
  result = await runCall({
    folder, key, route, transports, copies: callCopiesOf(machine, home), ...(copy === undefined ? {} : { sentCopy: Number(copy) }),
    found: { programs, ...(door === undefined ? {} : { door }), held: (name) => Object.hasOwn(secrets, name), secret: (name) => secrets[name] },
    blobs: folder.blobs(join(root, "blobs"), { reading: true }),
    ...(killAt === undefined ? {} : { failpoint: (at: string) => { if (at === killAt) process.kill(process.pid, "SIGKILL"); } }),
  });
} catch (error) {
  if (damaged(error) && (error as { database?: unknown }).database === LEDGER_DB) exit(LEDGER_DAMAGED_EXIT, `the ledger is damaged: ${errorText(error)}`);
  exit(1, errorText(error));
}
say(process.stdout, { ...result, ...(result.reason === undefined ? {} : { reason: bounded(result.reason) }) });
process.exitCode = CALL_EXIT[result.outcome];

function say(stream: NodeJS.WriteStream, line: Record<string, unknown>): void {
  stream.write(`${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
}

function exit(code: number, reason: string): never {
  const named = args.get("key");
  say(process.stderr, { ...(named === undefined ? {} : { key: named }), exit: code, error: bounded(reason) });
  process.exit(code);
}

function readRoute(text: string | undefined): CallRoute | null {
  if (text === undefined) return null;
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const named = typeof value.transport === "string" && value.transport !== "";
  const runner = value.runner === undefined || (typeof value.runner === "string" && value.runner !== "");
  const timeout = typeof value.timeout_ms === "number" && Number.isSafeInteger(value.timeout_ms) && value.timeout_ms > 0;
  const line = value.line === undefined || value.line === "chat";
  if (!named || !runner || !timeout || !line) return null;
  return {
    transport: value.transport as string, ...(value.runner === undefined ? {} : { runner: value.runner as string }), timeout_ms: value.timeout_ms as number,
    ...(value.line === undefined ? {} : { line: "chat" as const }),
  };
}

function readTransports(text: string): TransportSettings {
  try {
    return readTransportSettings(JSON.parse(text));
  } catch (error) {
    return usage(`--transports: ${errorText(error)}`);
  }
}

function readPrograms(text: string): Record<string, ProgramAt> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  const each = typeof value === "object" && value !== null && !Array.isArray(value) ? Object.entries(value) : null;
  if (each === null || each.some(([, at]) => typeof (at as ProgramAt | null)?.binary !== "string" || typeof (at as ProgramAt | null)?.home !== "string")) {
    return usage("--programs: an object of { binary, home } by transport");
  }
  return Object.fromEntries(each) as Record<string, ProgramAt>;
}

function secretsOf(line: string): Record<string, string> {
  if (line.trim() === "") return {};
  try {
    return JSON.parse(line) as Record<string, string>;
  } catch {
    return exit(64, "the secrets line on standard input does not read as JSON");
  }
}

function usage(refused?: string): never {
  return exit(64, `usage: call-main.ts --root <folder> --route <route> [--transports <transports block>] [--programs <programs>] [--door <address>] [--sent-copy <id>] --machine <folder> --home <home id> --key <request key>; standard input: the secrets line, then the folder line${refused === undefined ? "" : `; ${refused}`}`);
}
