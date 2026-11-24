import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeReady } from "@lifestreamprotocol/model";
import { readHome, slotFolder } from "./lifecycle.js";
import { pointAt } from "./machine.js";
import { mintPrincipal, readPrincipals } from "./principals.js";
import type { InitSystem } from "./release.js";
import { FAKES, until } from "./test/harness-root.js";
import { CLI, HEADERS, doorOn, home, machineOf, mintPasses, newMachine, phoneOf, printed, removeTemps, start, stopChildren, temp } from "./test/machines.js";
import { writeArtifact } from "./test/ops-support.js";
import { openHomeFolder } from "@lifestreamprotocol/core";
import { PASSES_STAY, uninstall, type UninstallPlan, type Uninstalled } from "./uninstall.js";
import { draftRecovery, Vault } from "./vault.js";

const PIN = "2.1.321";

const report: Record<string, unknown> = {};

afterAll(() => {
  writeArtifact("uninstall", report);
  removeTemps();
});

function initHolding(...labels: string[]): { releases: { dir: string; init: InitSystem } } {
  return { releases: { dir: "", init: { restart: () => false, holds: (label) => labels.includes(label) } } };
}
const FREE = initHolding();

const DNS = "macbook-pro-0001.tail0000.ts.net";
const OURS = { TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4683" } } } }, AllowFunnel: { [`${DNS}:443`]: true } };

function fakeTailscale(dir: string): { binary: string; serving: () => unknown; ran: () => string[] } {
  const folder = join(dir, "fake-tailscale");
  mkdirSync(folder, { recursive: true });
  const state = join(folder, "state.json");
  const calls = join(folder, "calls.txt");
  writeFileSync(state, JSON.stringify({ status: { BackendState: "Running", AuthURL: "", Self: { DNSName: `${DNS}.`, CapMap: { https: null, funnel: null } } }, serve: OURS }));
  const binary = join(folder, "tailscale");
  writeFileSync(binary, `#!${process.execPath}
const fs = require("node:fs");
const words = process.argv.slice(2).join(" ");
fs.appendFileSync(${JSON.stringify(calls)}, words + "\\n");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
if (words === "status --json") process.stdout.write(JSON.stringify(state.status));
else if (words === "serve status --json") process.stdout.write(JSON.stringify(state.serve));
else if (words === "serve --https=443 --set-path=/ off") { state.serve = {}; fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state)); }
else process.exit(1);
`);
  chmodSync(binary, 0o755);
  return {
    binary,
    serving: () => (JSON.parse(readFileSync(state, "utf8")) as { serve: unknown }).serve,
    ran: () => existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [],
  };
}

function machineNamed(name: string, overrides: Record<string, string> = {}) {
  return newMachine(name, { tailscale: "/nonexistent/tailscale", ...overrides });
}

async function adopted(name: string, overrides: Record<string, string> = {}) {
  const here = machineNamed(name, overrides);
  const folder = join(temp(`${name}-parent`), "home");
  expect((await home(here, ["adopt", folder])).status).toBe(0);
  const passes = { ...(await mintPasses(here, folder)), phone: phoneOf(folder, "iphone-17-pro-aa01") };
  const faces = join(here.user, "Library", "Caches", "face-engine");
  mkdirSync(join(faces, "compiled"), { recursive: true });
  return { here, folder, passes, faces };
}

describe("lifestream uninstall", () => {
  it("kept: the plan changes something, a held job lets it run, a pass still opens the door, Reach from anywhere stays, the folder's records go or it cannot be adopted again", async () => {
    try {
      const machineDir = temp("kept-machine-tailscale");
      const tailscale = fakeTailscale(machineDir);
      const { here, folder, passes, faces } = await adopted("kept", { tailscale: tailscale.binary });
      mintPrincipal(openHomeFolder(folder), {
        unit: "agent", kind: "agent", scopes: ["read"], now_ms: 0,
        granted: { agent: { name: "Example tool", via: "pass", from: null, checked: false, client_id: null, resource: null, anywhere: true } },
      });
      mkdirSync(join(here.dir, "mcp"), { recursive: true });
      writeFileSync(join(here.dir, "mcp", "public.json"), JSON.stringify({ origin: `https://${DNS}` }));
      mkdirSync(join(here.dir, "models", "speech"), { recursive: true });
      writeFileSync(join(here.dir, "models", "speech", "synthetic.gguf"), "a synthetic model file\n");
      mkdirSync(join(here.dir, "runner"), { recursive: true });
      writeFileSync(join(here.dir, "runner", "door-token"), "synthetic-runner-token\n");
      const running = start(here, CLI, ["serve", "--registry", FAKES]);
      await printed(running, "the home started", '"home":"started"');
      const before = readFileSync(join(folder, "config", "principals.json"), "utf8");
      const id = readHome(folder).id;
      const live = readPrincipals(openHomeFolder(folder)).principals.filter((pass) => pass.revoked_at === null).length;

      const plan = await home(here, ["uninstall"], [], FREE);
      expect(plan.status, plan.out).toBe(0);
      expect(plan.result).toEqual({ folder, here: true, old_copy: null, passes: live, jobs: [], erase: false, refused: null, recovery: null } satisfies UninstallPlan);
      expect([existsSync(here.dir), readFileSync(join(folder, "config", "principals.json"), "utf8"), tailscale.serving()]).toEqual([true, before, OURS]);

      const holding = initHolding("org.lifestreamprotocol.home", "org.lifestreamprotocol.runner");
      expect((await home(here, ["uninstall"], [], holding)).result).toMatchObject({ jobs: ["org.lifestreamprotocol.home", "org.lifestreamprotocol.runner"], refused: null });
      const held = await home(here, ["uninstall", "--apply"], [], holding);
      expect(held.status).toBe(1);
      expect(held.out).toMatch(/org\.lifestreamprotocol\.home, org\.lifestreamprotocol\.runner still run: the Mac app removes its jobs first/u);
      expect([existsSync(here.dir), existsSync(faces), readFileSync(join(folder, "config", "principals.json"), "utf8"), tailscale.serving()]).toEqual([true, true, before, OURS]);
      expect(running.out()).not.toContain('"home":"stopped"');

      const applied = await home(here, ["uninstall", "--apply"], [], FREE);
      expect(applied.status, applied.out).toBe(0);
      expect(await running.exited).not.toBeNull();
      const result = applied.result as Uninstalled;
      expect(result).toMatchObject({ folder, home: "kept", revoked: live, public: { state: "off" }, removed: [here.dir, faces] });
      expect(readPrincipals(openHomeFolder(folder)).principals.every((pass) => pass.revoked_at !== null)).toBe(true);
      expect([existsSync(here.dir), existsSync(faces), tailscale.serving()]).toEqual([false, false, {}]);
      expect(tailscale.ran()).toContain("serve --https=443 --set-path=/ off");
      expect([existsSync(join(folder, "HOME.json")), existsSync(join(folder, "home.db")), existsSync(join(folder, "replies", "replies.db"))]).toEqual([true, true, true]);

      const again = await home(here, ["uninstall", "--apply"], [], FREE);
      expect(again.status, again.out).toBe(0);
      expect(again.result).toMatchObject({ folder: null, home: "none", revoked: 0, removed: [] });

      const back = machineNamed("kept-back");
      const taken = await home(back, ["adopt", folder]);
      expect(taken.status, taken.out).toBe(0);
      expect(readHome(folder).id).toBe(id);
      const { port } = await doorOn(back);
      const state = async (who: keyof typeof HEADERS) => (await fetch(`http://127.0.0.1:${port}/v1/exchange`, {
        method: "POST", headers: { authorization: `Bearer ${passes[who].token}`, ...HEADERS[who] },
      })).status;
      const answers = { deliver: await state("deliver"), phone: await state("phone"), read: await state("read"), station: await state("station") };
      expect(answers).toEqual({ deliver: 401, phone: 401, read: 401, station: 401 });
      report.kept = { plan: plan.result, held: held.out.trim(), applied: result, again: again.result, adopted: taken.result, answers, tailscale: tailscale.ran() };
    } finally {
      await stopChildren();
    }
  });

  it("erased: the folder or the folder a move left stays, or the erase runs while the home writes", async () => {
    try {
      const { here, folder, faces } = await adopted("erased");
      const left = join(temp("erased-left"), "home");
      cpSync(folder, left, { recursive: true });
      mkdirSync(join(here.dir, "moved"), { recursive: true });
      writeFileSync(join(here.dir, "moved", `${readHome(folder).id}.json`), JSON.stringify({ from: left, to: folder, bytes: 1 }));
      const logouts = join(temp("erased-logouts"), "logouts.txt");
      const claude = join(here.dir, "subscriptions", "claude", PIN, "package", "claude");
      mkdirSync(join(claude, ".."), { recursive: true });
      writeFileSync(claude, ["#!/bin/sh", `case "$1 $2" in "auth logout") [ -d "${here.dir}" ] && echo "$CLAUDE_CONFIG_DIR here" >> ${logouts}; exit 0;; esac`, "exit 3", ""].join("\n"), { mode: 0o755 });
      writeFileSync(join(here.dir, "subscriptions", "claude", "current"), `${PIN}/package/claude\n`);
      const running = start(here, CLI, ["serve", "--registry", FAKES]);
      await printed(running, "the home started", '"home":"started"');

      const plan = await home(here, ["uninstall", "--erase"], [], FREE);
      expect(plan.result).toMatchObject({ folder, here: true, old_copy: left, erase: true, refused: null });
      expect([existsSync(folder), existsSync(left)]).toEqual([true, true]);

      const applied = await home(here, ["uninstall", "--erase", "--apply"], [], FREE);
      expect(applied.status, applied.out).toBe(0);
      expect(await running.exited).not.toBeNull();
      expect(running.out()).toMatch(/"home":"stopped"/u);
      expect(applied.result).toMatchObject({ folder, home: "erased", revoked: 0, removed: [here.dir, faces], claude_failed: null });
      expect([existsSync(folder), existsSync(left), existsSync(here.dir), existsSync(faces)]).toEqual([false, false, false, false]);
      expect(readFileSync(logouts, "utf8")).toBe(`${join(here.dir, "claude")} here\n`);
      report.erased = { plan: plan.result, applied: applied.result, home: running.out().trim().split("\n").at(-1) };
    } finally {
      await stopChildren();
    }
  });

  it("an erase of a folder away, not a home, or the person's home directory removes anything; a kept folder away fails the uninstall", async () => {
    const steps: Record<string, unknown> = {};
    report.refused = steps;
    const { here, folder, faces } = await adopted("away");
    const away = `${folder}-unplugged`;
    renameSync(folder, away);
    const refused = await home(here, ["uninstall", "--erase", "--apply"], [], FREE);
    expect(refused.status).toBe(1);
    expect(refused.out).toMatch(/Lifestream's folder .* is not there: connect the drive that holds it, then uninstall again, or uninstall and keep it/u);
    expect([existsSync(here.dir), existsSync(join(away, "HOME.json"))]).toEqual([true, true]);
    steps.away = refused.out.trim();
    const kept = await home(here, ["uninstall", "--apply"], [], FREE);
    expect(kept.status, kept.out).toBe(0);
    expect(kept.result).toMatchObject({ folder, home: "away", revoked: null, removed: [here.dir, faces] });
    expect(readPrincipals(openHomeFolder(away)).principals.filter((pass) => pass.revoked_at === null).length).toBeGreaterThan(0);
    steps.away_kept = kept.result;

    const other = machineNamed("not-a-home");
    const plain = temp("not-a-home-folder");
    writeFileSync(join(plain, "notes.txt"), "the person's own file");
    pointAt(machineOf(other), plain);
    const notHome = await home(other, ["uninstall", "--erase", "--apply"], [], FREE);
    expect(notHome.status).toBe(1);
    expect(notHome.out).toContain(`${plain} holds no HOME.json: Lifestream erases only its home's folder`);
    expect([existsSync(join(plain, "notes.txt")), existsSync(other.dir)]).toEqual([true, true]);
    steps.not_a_home = notHome.out.trim();

    const user = machineNamed("user-dir");
    cpSync(join(away, "HOME.json"), join(user.user, "HOME.json"));
    writeFileSync(join(user.user, "notes.txt"), "the person's own file");
    pointAt(machineOf(user), user.user);
    const own = await home(user, ["uninstall", "--erase", "--apply"], [], FREE);
    expect(own.status).toBe(1);
    expect(own.out).toContain(`${user.user} is not a folder Lifestream erases`);
    expect([existsSync(join(user.user, "notes.txt")), existsSync(user.dir)]).toEqual([true, true]);
    steps.user_dir = own.out.trim();
  });

  it("a Claude Code there at an older version stays signed in, one not named is run, one whose moved pin failed to fetch stays signed in, a failed sign-out's words are the program's, or a sign-out that hangs holds the uninstall", async () => {
    const answers: Record<string, unknown> = {};
    for (const [name, version, named, logout] of [
      ["unnamed", PIN, false, "exit 0"],
      ["older", "2.0.0", true, "exit 0"],
      ["moved", "2.0.0", true, "exit 0"],
      ["fails", PIN, true, 'echo "synthetic-token-0000" >&2; exit 1'],
      ["hangs", PIN, true, "sleep 600 & wait"],
    ] as const) {
      const here = machineNamed(`claude-${name}`);
      const logouts = join(temp(`claude-${name}-logouts`), "logouts.txt");
      const claude = join(here.dir, "subscriptions", "claude", version, "package", "claude");
      mkdirSync(join(claude, ".."), { recursive: true });
      writeFileSync(claude, ["#!/bin/sh", `case "$1 $2" in "auth logout") echo "$CLAUDE_CONFIG_DIR" >> ${logouts}; ${logout};; esac`, "exit 3", ""].join("\n"), { mode: 0o755 });
      if (named) writeFileSync(join(here.dir, "subscriptions", "claude", "current"), `${version}/package/claude\n`);
      if (name === "moved") {
        const pinned = { name: "claude" as const, version: PIN, team: "SYNTHETIC1", entry: "package/claude", artifact: { url: "http://synthetic.invalid/claude.tgz", bytes: 1, sha256: "0".repeat(64) } };
        await expect(makeReady(join(here.dir, "subscriptions", "claude"), pinned, { signed: async () => [], env: process.env })).rejects.toThrow("no fetch is made");
        expect(existsSync(join(here.dir, "subscriptions", "claude", "current"))).toBe(false);
      }
      const signOut = new AbortController();
      const uninstalled = uninstall(machineOf(here), FREE.releases.init, false, { out: () => undefined, logout: signOut.signal });
      if (name === "hangs") {
        await until("the hanging sign-out wrote its folder and waits", () => existsSync(logouts));
        signOut.abort();
      }
      const result = await uninstalled;
      const ran = existsSync(logouts) ? readFileSync(logouts, "utf8") : null;
      answers[name] = { claude_failed: result.claude_failed, ran: ran === `${join(here.dir, "claude")}\n` ? "its folder" : ran, removed: !existsSync(here.dir) };
    }
    expect(answers).toEqual({
      unnamed: { claude_failed: null, ran: null, removed: true },
      older: { claude_failed: null, ran: "its folder", removed: true },
      moved: { claude_failed: null, ran: "its folder", removed: true },
      fails: { claude_failed: "it ended with exit 1", ran: "its folder", removed: true },
      hangs: { claude_failed: "it did not end in time", ran: "its folder", removed: true },
    });
    report.claude = answers;
  });

  it("the plan's recovery says a key is saved for a folder away, with no vault, or one that does not read, or says other than the vault's own state of an unconfirmed key or a confirmed one, or not saved for a saved key beside a new one not saved", async () => {
    const { here, folder } = await adopted("recovery");
    const vaultFile = join(folder, "config", "vault.json");
    const slot = (id: string, confirmed: boolean) => ({ id, kind: "recovery", made_ms: 1_700_000_000_000, ...(confirmed ? { confirmed_ms: 1_700_000_100_000 } : {}), wrapped: "AAAA" });
    const machineSlot = { id: "m-0a1b2c3d", kind: "machine", store: "keychain-login", made_ms: 1_700_000_000_000, wrapped: "AAAA" };
    const recoveryOf = async () => {
      const plan = await home(here, ["uninstall"], [], FREE);
      expect(plan.status, plan.out).toBe(0);
      return (plan.result as UninstallPlan).recovery;
    };
    const seen: Record<string, unknown> = {};
    seen.noVault = await recoveryOf();
    writeFileSync(vaultFile, "{ not a vault", { mode: 0o600 });
    seen.unreadable = await recoveryOf();
    writeFileSync(vaultFile, JSON.stringify({ version: 1, key_id: "0a1b2c3d", slots: [machineSlot, slot("r-1", false)] }), { mode: 0o600 });
    seen.unconfirmed = await recoveryOf();
    writeFileSync(vaultFile, JSON.stringify({ version: 1, key_id: "0a1b2c3d", slots: [machineSlot, slot("r-1", true)] }), { mode: 0o600 });
    seen.confirmed = await recoveryOf();
    writeFileSync(vaultFile, JSON.stringify({ version: 1, key_id: "0a1b2c3d", slots: [machineSlot, slot("r-1", true), slot("r-2", false)] }), { mode: 0o600 });
    seen.newWaiting = await recoveryOf();
    seen.windowSays = new Vault({ root: folder, machine: here.dir, home: readHome(folder).id }).state().recovery;
    renameSync(folder, `${folder}-unplugged`);
    seen.away = await recoveryOf();
    expect(seen).toEqual({ noVault: null, unreadable: null, unconfirmed: "unconfirmed", confirmed: "confirmed", newWaiting: "confirmed", windowSays: "confirmed", away: null });
    report.recovery = seen;
  });

  it("an encrypted home kept: with this Mac's slot key on standard input every pass is revoked; with none, or one that opens no slot, none is and the verb says so; the plan counts passes only with the key", async () => {
    const seen: Record<string, unknown> = {};
    const here = machineNamed("keyed");
    const named = readFileSync(join(here.dir, "machine.json"));
    for (const handed of ["key", "none", "wrong"] as const) {
      mkdirSync(here.dir, { recursive: true });
      writeFileSync(join(here.dir, "machine.json"), named);
      const folder = join(temp(`keyed-${handed}-parent`), "home");
      const slot = randomBytes(32);
      const handoff = JSON.stringify({ home_id: randomUUID(), slot_key: slot.toString("hex"), recovery: draftRecovery(1).recovery });
      const adopted = await home(here, ["adopt", folder, "--keyed"], [], { input: async () => handoff });
      expect(adopted.status, adopted.out).toBe(0);
      const opened = () => slotFolder(folder, here.dir, "home", { key: slot, why: null }, Date.now());
      for (const unit of ["reader-0001", "macbook-pro-0001"]) mintPrincipal(opened(), { unit, scopes: ["read"], now_ms: 1 });
      const key = (bytes: Buffer) => ({ input: async () => `${bytes.toString("hex")}\n` });
      const given = handed === "key" ? key(slot) : handed === "wrong" ? key(randomBytes(32)) : {};
      const flag = handed === "none" ? [] : ["--key-on-input"];
      const plan = await home(here, ["uninstall", ...flag], [], { ...FREE, ...given });
      expect(plan.result).toMatchObject({ here: true, passes: handed === "key" ? 2 : null });
      const said: string[] = [];
      const applied = await home(here, ["uninstall", "--apply", ...flag], [], { ...FREE, ...given, going: (text) => said.push(text) });
      expect(applied.status, applied.out).toBe(0);
      expect(applied.result).toMatchObject({ home: "kept", revoked: handed === "key" ? 2 : null });
      expect(said.join("").includes(PASSES_STAY)).toBe(handed !== "key");
      const live = readPrincipals(opened()).principals.filter((row) => row.revoked_at === null).length;
      expect(live).toBe(handed === "key" ? 0 : 2);
      seen[handed] = { plan: (plan.result as UninstallPlan).passes, revoked: (applied.result as Uninstalled).revoked, live };
    }
    expect(await home(machineNamed("keyed-bad"), ["uninstall", "--key-on-input"], [], { ...FREE, input: async () => "not a key" })).toMatchObject({ status: 1 });
    report.keyed = seen;
  });

  it("an encrypted home kept is refused while this Mac's copy is the only vault that opens it, or while its folder is away", async () => {
    const here = machineNamed("keyed-only-copy");
    const folder = join(temp("keyed-only-copy-parent"), "home");
    const handoff = JSON.stringify({ home_id: randomUUID(), slot_key: randomBytes(32).toString("hex"), recovery: draftRecovery(1).recovery });
    expect((await home(here, ["adopt", folder, "--keyed"], [], { input: async () => handoff })).status).toBe(0);
    const copy = join(here.dir, "vaults", `${readHome(folder).id}.json`);
    rmSync(join(folder, "config", "vault.json"));
    const applied = await home(here, ["uninstall", "--apply"], [], FREE);
    expect(applied.status).toBe(1);
    expect(applied.out).toContain("only copy of your home's vault");
    expect([existsSync(copy), existsSync(here.dir)]).toEqual([true, true]);

    renameSync(folder, `${folder}-unplugged`);
    const plan = await home(here, ["uninstall"], [], FREE);
    expect((plan.result as UninstallPlan).refused).toContain("keeps a copy of its vault");
    expect((await home(here, ["uninstall", "--apply"], [], FREE)).status).toBe(1);
    expect(existsSync(copy)).toBe(true);
  });

  it("a machine never set up is refused, or keeps its machine directory", async () => {
    const here = machineNamed("never");
    const plan = await home(here, ["uninstall", "--erase"], [], FREE);
    expect(plan.result).toEqual({ folder: null, here: false, old_copy: null, passes: 0, jobs: [], erase: true, refused: null, recovery: null } satisfies UninstallPlan);
    const applied = await home(here, ["uninstall", "--erase", "--apply"], [], FREE);
    expect(applied.status, applied.out).toBe(0);
    expect(applied.result).toMatchObject({ folder: null, home: "none", removed: [here.dir], claude_failed: null });
    expect(existsSync(here.dir)).toBe(false);
    report.never = { plan: plan.result, applied: applied.result };
  });
});
