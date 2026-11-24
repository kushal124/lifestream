import { existsSync, rmSync } from "node:fs";
import { join, parse } from "node:path";
import { KeyError, type HomeFolder } from "@lifestreamprotocol/core";
import { signOutClaude } from "@lifestreamprotocol/model";
import { publicOff, type PublicState } from "./funnel.js";
import { readHome, realPath, slotFolder } from "./lifecycle.js";
import { pointedAt, type Machine } from "./machine.js";
import { oldCopy, quiet } from "./move.js";
import { readPrincipals, writePrincipals } from "./principals.js";
import { JOBS, jobLabel, type InitSystem } from "./release.js";
import { lastBinary, signInFolder } from "./subscriptions.js";
import { removeCommand } from "./command.js";
import { machineKeepsVaults, NO_SLOT_KEY, readVault, recoverySaved, Vault, type SlotHanded, type VaultFile } from "./vault.js";

export interface UninstallPlan {
  folder: string | null;
  here: boolean;
  old_copy: string | null;
  passes: number | null;
  jobs: string[];
  erase: boolean;
  refused: string | null;
  recovery: "confirmed" | "unconfirmed" | null;
}

export interface Uninstalled {
  folder: string | null;
  home: "erased" | "kept" | "away" | "none";
  revoked: number | null;
  public: PublicState;
  removed: string[];
  claude_failed: string | null;
  command: string[];
}

export function faceCache(at: Machine): string {
  return join(at.user, "Library", "Caches", "face-engine");
}

export const PASSES_STAY = "Your devices' passes stay until Lifestream opens this folder again. Revoke them in Devices.";

export function planUninstall(at: Machine, init: InitSystem, erase: boolean, slot: SlotHanded = NO_SLOT_KEY): UninstallPlan {
  const jobs = JOBS.map(jobLabel).filter((label) => init.holds(label));
  const folder = pointedAt(at);
  let here = false;
  let copy: string | null = null;
  let passes: number | null = 0;
  if (folder !== null) {
    try {
      readHome(folder);
      here = true;
    } catch {
      here = false;
    }
    if (here) {
      copy = oldCopy(at, folder)?.path ?? null;
      const opened = passesIn(at, folder, slot);
      passes = opened === null ? null : readPrincipals(opened).principals.filter((pass) => pass.revoked_at === null).length;
    }
  }
  return { folder, here, old_copy: copy, passes, jobs, erase, refused: erase ? eraseRefusal(at, folder, here) : keepRefusal(at, folder, here), recovery: folder === null ? null : recoveryOf(folder) };
}

function recoveryOf(folder: string): UninstallPlan["recovery"] {
  let vault: VaultFile | null;
  try {
    vault = readVault(folder);
  } catch {
    return null;
  }
  const saved = recoverySaved(vault);
  return saved === "none" ? null : saved;
}

const LOGOUT_MS = 30_000;

export interface UninstallOptions {
  readonly out?: (line: string) => void;
  readonly logout?: AbortSignal;
  readonly slot?: SlotHanded;
}

export async function uninstall(at: Machine, init: InitSystem, erase: boolean, options: UninstallOptions = {}): Promise<Uninstalled> {
  const { out = () => {}, logout = AbortSignal.timeout(LOGOUT_MS), slot = NO_SLOT_KEY } = options;
  const plan = planUninstall(at, init, erase, slot);
  if (plan.jobs.length > 0) {
    throw new Error(`${plan.jobs.join(", ")} still ${plan.jobs.length === 1 ? "runs" : "run"}: the Mac app removes its jobs first (Uninstall Lifestream… in its Settings)`);
  }
  if (plan.refused !== null) throw new Error(plan.refused);
  const home: Uninstalled["home"] = plan.folder === null ? "none" : plan.here ? (erase ? "erased" : "kept") : "away";
  let revoked: number | null = home === "away" ? null : 0;
  if (plan.folder !== null && plan.here) {
    const locks = await quiet(plan.folder, { out });
    try {
      if (erase) {
        if (plan.old_copy !== null) rmSync(plan.old_copy, { recursive: true, force: true });
        rmSync(plan.folder, { recursive: true, force: true });
      } else {
        new Vault({ root: plan.folder, machine: at.dir, home: readHome(plan.folder).id }).keepInFolder();
        const opened = passesIn(at, plan.folder, slot);
        revoked = opened === null ? null : revokeAll(opened, Date.now());
        if (revoked === null) out(PASSES_STAY);
      }
    } finally {
      locks.release();
    }
  }
  const reach = await publicOff(at);
  const claude = at.claude?.binary ?? lastBinary(at.dir, "claude");
  const claude_failed = claude === null ? null : await signOutClaude({ binary: claude, home: signInFolder(at.dir, "claude") }, logout);
  const command = removeCommand({ machine: at });
  for (const line of command.did) out(line);
  const removed = [at.dir, faceCache(at)].filter((path) => existsSync(path));
  for (const path of removed) rmSync(path, { recursive: true, force: true });
  return { folder: plan.folder, home, revoked, public: reach, removed, claude_failed, command: command.did };
}

function eraseRefusal(at: Machine, folder: string | null, here: boolean): string | null {
  if (folder === null) return null;
  if (!here && existsSync(folder)) return `${folder} holds no HOME.json: Lifestream erases only its home's folder`;
  if (!here) return `Lifestream's folder ${folder} is not there: connect the drive that holds it, then uninstall again, or uninstall and keep it`;
  const real = realPath(folder);
  if (real === realPath(at.user) || real === parse(real).root) return `${folder} is not a folder Lifestream erases: remove what you want of it yourself`;
  return null;
}

function keepRefusal(at: Machine, folder: string | null, here: boolean): string | null {
  if (folder === null || here || !machineKeepsVaults(at.dir)) return null;
  return `Lifestream's folder ${folder} is not there, and this Mac keeps a copy of its vault: connect the drive that holds it, then uninstall again`;
}

function passesIn(at: Machine, folder: string, slot: SlotHanded): HomeFolder | null {
  try {
    return slotFolder(folder, at.dir, "home", slot, Date.now());
  } catch (error) {
    if (error instanceof KeyError && error.code === "LOCKED") return null;
    throw error;
  }
}

function revokeAll(folder: HomeFolder, now_ms: number): number {
  const file = readPrincipals(folder);
  const live = file.principals.filter((pass) => pass.revoked_at === null).length;
  if (live === 0) return 0;
  const at = new Date(now_ms).toISOString();
  writePrincipals(folder, { ...file, principals: file.principals.map((pass) => pass.revoked_at === null ? { ...pass, revoked_at: at } : pass) });
  return live;
}
