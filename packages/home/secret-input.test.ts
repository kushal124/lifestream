import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runCli } from "./cli.js";
import { machine, type Machine } from "./machine.js";
import { secretInput } from "./secret-input.js";
import { makeRoot, removeRoot } from "./test/harness-root.js";

const PIPED = `printf '%s' "<API key>" | lifestream connectors preview example-api --set key=-`;
const REFUSED = "is not typed at a terminal on a Mac with the Lifestream app: its screen recorder and input log would keep it. Pipe it in: ";
const temps: string[] = [];
const scratch = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const terminal = () => Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });

function machineWith(app: boolean): Machine {
  const user = scratch("lifestream-secret-input-user-");
  if (app) mkdirSync(join(user, "Applications", "Lifestream.app"), { recursive: true });
  return machine({ env: { LIFESTREAM_MACHINE_DIR: scratch("lifestream-secret-input-machine-") }, home: user, system: scratch("lifestream-secret-input-system-") });
}

describe("a secret on standard input", () => {
  it("piped: its one trailing line end dropped, an empty one refused", async () => {
    const piped = (...chunks: string[]) => secretInput({ label: "API key", piped: PIPED, macApp: true }, Readable.from(chunks.map((chunk) => Buffer.from(chunk))));
    expect(await piped("synthetic-key\n")).toBe("synthetic-key");
    expect(await piped("synthetic\nkey\r\n")).toBe("synthetic\nkey");
    await expect(piped()).rejects.toThrow(`standard input held no API key: ${PIPED}`);
  });

  it("typed at a terminal where no Mac app records keys: read up to Return; on a Mac with the app, refused naming the pipe", async () => {
    const typing = terminal();
    const typed = secretInput({ label: "API key", piped: PIPED, macApp: false }, typing);
    typing.write("synthetic-key\r");
    expect(await typed).toBe("synthetic-key");
    await expect(secretInput({ label: "API key", piped: PIPED, macApp: true }, terminal())).rejects.toThrow(`API key ${REFUSED}${PIPED}`);
  });

  it("`secret set` typed at a terminal on a Mac with the app is refused naming its pipe; elsewhere it is read", async () => {
    const root = makeRoot("lifestream-secret-input-", { sources: {} });
    const stdin = vi.spyOn(process, "stdin", "get");
    try {
      const set = async (at: Machine, typing: PassThrough) => {
        stdin.mockReturnValue(typing as unknown as typeof process.stdin);
        const lines: string[] = [];
        const status = await runCli(["secret", "set", "x.password", "--root", root], { machine: at, write: (text) => lines.push(text) });
        return { status, said: lines.join("").trim() };
      };
      expect(await set(machineWith(true), terminal())).toEqual({ status: 1, said: `x.password ${REFUSED}printf '%s' "<x.password>" | lifestream secret set x.password` });
      const typing = terminal();
      const read = set(machineWith(false), typing);
      typing.write("fake-password\r");
      expect(await read).toEqual({ status: 1, said: `no home runs on ${root}: the running home holds the vault key a password is sealed with; start it, then set x.password again` });
    } finally {
      stdin.mockRestore();
      removeRoot(root);
    }
  });
});
