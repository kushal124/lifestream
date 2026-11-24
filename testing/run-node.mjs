import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statfsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { bundledProgram } from "./program.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const BUNDLE = fileURLToPath(new URL("../packages/home/test/bundle.ts", import.meta.url));
const COMPILE_CACHE = process.env.NODE_COMPILE_CACHE ?? join(REPO, ".build", "compile-cache");
const MAX_CHROMES = 3;

const PRIORITY = new Map([
  "test/onboarding-after.mjs",
  "test/flows-after.mjs",
  "test/places-instant.mjs",
  "test/places.mjs",
  "test/place-circle.mjs",
  "test/photo-viewer.mjs",
  "test/ask-media.mjs",
  "test/tour-walk.mjs",
  "test/people-edit.mjs",
  "test/ask-page.mjs",
  "test/tour-first.mjs",
  "test/days-unnamed.mjs",
  "test/faces.mjs",
  "test/days-folded.mjs",
  "test/people-page.mjs",
  "test/days-picker.mjs",
  "test/llm-web.mjs",
  "test/onboarding-journey.mjs",
  "test/days-clock.mjs",
  "test/video.mjs",
  "test/days-reveal.mjs",
  "test/people-groups.mjs",
  "test/people-deck.mjs",
  "test/access-page.mjs",
  "test/agents.mjs",
  "test/days-side.mjs",
  "test/settings-kit.mjs",
  "test/imports.mjs",
  "test/storage-page.mjs",
  "test/e2e.mjs",
  "test/claude-turns.mjs",
  "test/media.mjs",
  "test/claude.mjs",
  "test/agents-call.mjs",
  "test/claude-picks.mjs",
  "test/privacy.mjs",
  "test/sign-in.mjs",
  "test/agent-signin.mjs",
].map((file, index) => [file, index]));

/** @param {string[]} raw */
function orderFiles(raw) {
  let start = raw.length;
  while (start > 0 && raw[start - 1].endsWith(".mjs") && !raw[start - 1].startsWith("-")) start -= 1;
  if (raw.length - start <= 1) return raw;
  const head = raw.slice(0, start);
  const files = raw.slice(start).map((file, index) => ({
    file,
    rank: PRIORITY.get(file) ?? 10_000,
    index,
  }));
  files.sort((left, right) => left.rank - right.rank || left.index - right.index);
  return [...head, ...files.map(entry => entry.file)];
}

function fastTmp() {
  if (process.platform !== "linux" || !existsSync("/dev/shm")) return undefined;
  try {
    const stat = statfsSync("/dev/shm");
    if (stat.bavail * stat.bsize < 2 * 1024 ** 3) return undefined;
    return mkdtempSync("/dev/shm/ls-node-");
  } catch {
    return undefined;
  }
}

function running(child) {
  return child.exitCode === null && child.signalCode === null;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killGroup(child) {
  try {
    if (child.pid) process.kill(-child.pid, "SIGKILL");
  } catch {
  }
}

let dist = process.env.LIFESTREAM_TEST_DIST;
if (dist === undefined || !existsSync(dist)) {
  dist = execFileSync(TSX, [BUNDLE], { cwd: REPO, encoding: "utf8", env: { ...process.env, NODE_COMPILE_CACHE: COMPILE_CACHE } }).trim();
}
process.env.LIFESTREAM_TEST_DIST = dist;

const args = orderFiles(process.argv.slice(2));
const shmTmp = fastTmp();
const baseEnv = { ...process.env, LIFESTREAM_TEST_DIST: dist, NODE_COMPILE_CACHE: COMPILE_CACHE, ...(shmTmp === undefined ? {} : { TMPDIR: shmTmp }) };

async function startDashboardPool() {
  const [{ CHROME_ARGS, OPEN_ARGS }, { googleChrome }] = await Promise.all([
    import("../dashboard/tools/chrome.mjs"),
    import("./files.mts"),
  ]);
  const chromeBinary = googleChrome();
  const chromeBase = shmTmp ?? tmpdir();

  /** @type {Promise<unknown> | null} */
  let sharedHome = null;
  /** @type {import("node:child_process").ChildProcessWithoutNullStreams | null} */
  let sharedHomeChild = null;

  /** @type {{ id: number, busy: boolean, ownerPid: number, wsUrl: string, child: import("node:child_process").ChildProcess | null, profile: string, ready: Promise<string> | null }[]} */
  const slots = [];
  /** @type {(() => void)[]} */
  const waiters = [];
  let nextSlotId = 1;
  let stopped = false;

  const wakeWaiters = () => {
    for (const wake of waiters.splice(0)) wake();
  };

  /** @param {typeof slots[number]} slot */
  const destroySlot = slot => {
    const index = slots.indexOf(slot);
    if (index !== -1) slots.splice(index, 1);
    if (slot.child !== null) {
      killGroup(slot.child);
      slot.child = null;
    }
    if (slot.profile) rmSync(slot.profile, { recursive: true, force: true });
    wakeWaiters();
  };

  const pruneSlots = () => {
    for (const slot of [...slots]) {
      if (slot.child !== null && !running(slot.child)) {
        destroySlot(slot);
      } else if (slot.busy && slot.ownerPid > 0 && !pidAlive(slot.ownerPid)) {
        destroySlot(slot);
      }
    }
  };

  /** @param {typeof slots[number]} slot */
  const bootSlot = slot => {
    const profile = mkdtempSync(join(chromeBase, "ls-chrome-"));
    slot.profile = profile;
    const child = spawn(chromeBinary, [
      ...CHROME_ARGS,
      "--remote-debugging-port=0",
      ...OPEN_ARGS,
      `--user-data-dir=${profile}`,
      "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"], detached: true });
    slot.child = child;
    child.once("exit", () => {
      if (slots.includes(slot)) destroySlot(slot);
    });
    slot.ready = new Promise((done, fail) => {
      let buffer = "";
      let settled = false;
      const finish = (err, wsUrl) => {
        if (settled) return;
        settled = true;
        if (err) fail(err);
        else done(wsUrl);
      };
      child.once("error", err => finish(err, ""));
      child.once("exit", (code, signal) => finish(new Error(`pooled Chrome exited (${code ?? signal}): ${buffer.slice(-400)}`), ""));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", chunk => {
        if (settled) return;
        buffer += chunk;
        const match = /DevTools listening on (ws:\/\/\S+)/u.exec(buffer);
        if (match) {
          buffer = "";
          child.stderr.resume();
          finish(null, match[1]);
        }
      });
    });
    return slot.ready;
  };

  /** @param {number} ownerPid */
  async function acquireChrome(ownerPid) {
    for (;;) {
      if (stopped) throw new Error("dashboard pool stopped");
      pruneSlots();
      const idleMatch = slots.find(slot => !slot.busy && slot.wsUrl !== "");
      if (idleMatch) {
        idleMatch.busy = true;
        idleMatch.ownerPid = ownerPid;
        return { id: idleMatch.id, wsUrl: idleMatch.wsUrl };
      }
      if (slots.length >= MAX_CHROMES) {
        await new Promise(done => waiters.push(() => done(undefined)));
        continue;
      }
      const slot = {
        id: nextSlotId++,
        busy: true,
        ownerPid,
        wsUrl: "",
        child: null,
        profile: "",
        ready: null,
      };
      slots.push(slot);
      try {
        slot.wsUrl = await bootSlot(slot);
        return { id: slot.id, wsUrl: slot.wsUrl };
      } catch (err) {
        destroySlot(slot);
        throw err;
      }
    }
  }

  /** @param {number} id @param {boolean} broken */
  function releaseChrome(id, broken) {
    const slot = slots.find(each => each.id === id);
    if (!slot) return;
    if (broken || slot.child === null || !running(slot.child)) {
      destroySlot(slot);
      return;
    }
    slot.busy = false;
    slot.ownerPid = 0;
    wakeWaiters();
  }

  function getSharedHome() {
    if (sharedHome !== null) return sharedHome;
    const child = spawn(process.execPath, [...bundledProgram(join("packages", "home", "test", "dashboard-home.ts"))], {
      cwd: REPO,
      stdio: ["pipe", "pipe", "inherit"],
      env: baseEnv,
      detached: true,
    });
    sharedHomeChild = child;
    sharedHome = new Promise((done, fail) => {
      child.once("exit", code => {
        if (sharedHomeChild === child) {
          sharedHomeChild = null;
          sharedHome = null;
        }
        fail(new Error(`shared dashboard-home exited with ${code}`));
      });
      child.once("error", err => {
        if (sharedHomeChild === child) {
          sharedHomeChild = null;
          sharedHome = null;
        }
        fail(err);
      });
      createInterface({ input: child.stdout }).on("line", text => {
        const line = JSON.parse(text);
        if (line.ready) done(line);
      });
    });
    return sharedHome;
  }

  const server = createServer((req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    const parsed = new URL(req.url ?? "/", "http://127.0.0.1");
    if (parsed.pathname === "/home/dashboard") {
      void getSharedHome()
        .then(ready => send(200, ready), err => send(500, { error: String(err) }));
      return;
    }
    if (parsed.pathname === "/chrome/acquire") {
      const ownerPid = Number(parsed.searchParams.get("pid") ?? "0");
      void acquireChrome(ownerPid)
        .then(leased => send(200, leased), err => send(500, { error: String(err) }));
      return;
    }
    if (parsed.pathname === "/chrome/release") {
      const id = Number(parsed.searchParams.get("id") ?? "0");
      const broken = parsed.searchParams.get("broken") === "1";
      releaseChrome(id, broken);
      send(200, { ok: true });
      return;
    }
    send(404, { error: "not found" });
  });

  await new Promise(done => server.listen(0, "127.0.0.1", () => done(undefined)));
  const port = /** @type {import("node:net").AddressInfo} */ (server.address()).port;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    server.closeAllConnections();
    server.close();
    for (const slot of [...slots]) destroySlot(slot);
    if (sharedHomeChild !== null) {
      killGroup(sharedHomeChild);
      sharedHomeChild = null;
    }
  };

  return { url: `http://127.0.0.1:${port}`, stop };
}

const pool = basename(process.cwd()) === "dashboard" ? await startDashboardPool() : null;
const env = { ...baseEnv, ...(pool === null ? {} : { LIFESTREAM_DASHBOARD_POOL: pool.url }) };

const cleanup = () => {
  pool?.stop();
  if (shmTmp !== undefined) rmSync(shmTmp, { recursive: true, force: true });
};

const child = spawn(process.execPath, args, { stdio: "inherit", env });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(/** @type {NodeJS.Signals} */ (signal)));
}
child.on("exit", (code, signal) => {
  cleanup();
  if (signal !== null) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
