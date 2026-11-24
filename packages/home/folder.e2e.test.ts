import { randomBytes } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { diskSpace, openHomeFolder, tryLock } from "@lifestreamprotocol/core";
import { callsLock } from "@lifestreamprotocol/model";
import { adopt, awayWords, look, readHome } from "./lifecycle.js";
import { machine } from "./machine.js";
import { homeRegistryModule } from "./programs.js";
import { readPrincipals } from "./principals.js";
import { declarations } from "@lifestreamprotocol/connect";
import { checkConnectors, connectorSettings, effective, runsAt } from "./settings.js";
import { madeStart } from "./start.js";
import { FAKES, until } from "./test/harness-root.js";
import { openDoor } from "./test/harness-door.js";
import { serveOnce, startHere } from "./test/harness-home.js";
import { statusOf } from "./test/harness-status.js";
import { CLI, dashboardPass, doorOn, HEADERS, home, json, machineOf, mintPasses, newMachine, phoneOf, printed, removeTemps, revokedOn, start, stopChildren, temp } from "./test/machines.js";
import { writeArtifact } from "./test/ops-support.js";

const report: Record<string, unknown> = {};

afterAll(() => {
  writeArtifact("folder", report);
  removeTemps();
});

describe("adopt", () => {
  it("a new folder adopted from nothing names its path, lacks HOME.json, a zone or the pointer, or is made where the spec refuses it", async () => {
    const here = newMachine("adopt-new");
    const folder = join(temp("adopt-new-parent"), "home");
    const adopted = await home(here, ["adopt", folder]);
    expect(adopted.status, adopted.out).toBe(0);
    const answer = adopted.result as { folder: string; id: string; as: string; machine: { dir: string } };
    expect(answer).toMatchObject({ as: "new", machine: { dir: here.dir } });
    const made = json(join(answer.folder, "HOME.json"));
    expect(Object.keys(made).sort()).toEqual(["created", "format", "id"]);
    expect(JSON.stringify(made)).not.toContain(answer.folder);
    expect(made.id).toBe(answer.id);
    const made_ms = Date.parse(String(made.created));
    expect(json(join(answer.folder, "config", "settings.json"))).toEqual({
      "day.zone": "America/New_York", unit: "macbook-pro-0001",
      "history.start": madeStart(made_ms, { zone: "America/New_York", day_start_hour: runsAt(null, "day.day_start_hour") as number }),
    });
    expect(readFileSync(join(here.dir, "home"), "utf8")).toBe(`${answer.folder}\n`);
    expect((await home(here, ["settings", "set", "door.port", "0"])).status).toBe(0);
    const status = await home(here, ["status", "--json"]);
    expect(status.status, status.out).toBe(0);
    const shown = await home(here, ["settings"]);
    expect(shown.out).toMatch(/day\.zone = "America\/New_York" {2}\(the person's\)/u);
    expect(shown.out).toMatch(/model\.cap = 8 {2}\(the release's default\)/u);

    const passes = await mintPasses(here, answer.folder);
    const principals = readFileSync(join(answer.folder, "config", "principals.json"), "utf8");
    const again = await home(here, ["adopt", answer.folder]);
    expect(again.status, again.out).toBe(0);
    expect(again.result).toMatchObject({ as: "kept", id: answer.id, passes: { kept: [passes.deliver.id, passes.read.id, passes.station.id, passes.find.id], revoked: [], suspended: [] } });
    expect(readFileSync(join(answer.folder, "config", "principals.json"), "utf8")).toBe(principals);

    const refusals: Record<string, string> = {};
    for (const [name, place] of [
      ["documents", join(here.user, "Documents", "Lifestream")],
      ["downloads", join(here.user, "Downloads", "Lifestream")],
      ["icloud", join(here.user, "Library", "Mobile Documents", "com~apple~CloudDocs", "Lifestream")],
    ] as const) {
      const refused = await home(here, ["adopt", place]);
      expect(refused.status, `${name}: ${refused.out}`).toBe(1);
      expect(existsSync(place), name).toBe(false);
      refusals[name] = refused.out.trim();
    }
    expect(refusals.documents).toMatch(/is in ~\/Documents/u);
    expect(refusals.icloud).toMatch(/a place a cloud service syncs/u);
    const deep = join(temp("adopt-deep"), "d".repeat(80));
    mkdirSync(deep);
    writeFileSync(join(deep, "machine.json"), readFileSync(join(here.dir, "machine.json")));
    const far = { ...here, dir: deep, env: { ...here.env, LIFESTREAM_MACHINE_DIR: deep } };
    const farPlace = join(temp("adopt-far"), "Lifestream");
    const farLook = await home(far, ["machine", farPlace]);
    const farAdopt = await home(far, ["adopt", farPlace]);
    expect(farAdopt.status, farAdopt.out).toBe(1);
    expect(existsSync(farPlace)).toBe(false);
    refusals.socket = farAdopt.out.trim();
    expect(refusals.socket).toMatch(/\/run\/[0-9a-f]{8}\.sock is \d+ bytes; a socket's path must be under 104: give this machine a shorter directory \(LIFESTREAM_MACHINE_DIR\)$/u);
    const named = (words: string) => words.replace(/[0-9a-f]{8}\.sock/u, "<name>.sock");
    expect(named((farLook.result as { folder: { refused: string } }).folder.refused)).toBe(named(refusals.socket));
    const deepFolder = await home(here, ["machine", join(temp("adopt-deep-folder"), "d".repeat(80), "Lifestream")]);
    expect((deepFolder.result as { folder: { refused: string | null } }).folder.refused).toBeNull();
    const running = tryLock(join(answer.folder, "home.lock"))!;
    const other = join(temp("adopt-other"), "home");
    const whileRunning = await home(here, ["adopt", other]);
    running.release();
    expect(whileRunning.status, whileRunning.out).toBe(1);
    expect(whileRunning.out).toMatch(/Lifestream runs on .*: stop it first/u);
    refusals.running = whileRunning.out.trim();
    expect(readFileSync(join(here.dir, "home"), "utf8")).toBe(`${answer.folder}\n`);
    report.new = { adopted: answer, home_json: made, refusals };
  });

  it("a checkout with no LIFESTREAM_MACHINE_DIR points its machine away from the home it points at, by adopt or move", async () => {
    const here = newMachine("adopt-checkout");
    const user = mkdtempSync(join("/tmp", "ls-ac-"));
    try {
      const { LIFESTREAM_MACHINE_DIR: _named, ...rest } = here.env;
      const env = { ...rest, HOME: user, XDG_DATA_HOME: join(user, "data") };
      const real = machine({ env, home: user }).dir;
      mkdirSync(real, { recursive: true });
      writeFileSync(join(real, "machine.json"), readFileSync(join(here.dir, "machine.json")));
      const first = join(temp("adopt-checkout-first"), "home");
      const made = await home({ env }, ["adopt", first]);
      expect(made.status, made.out).toBe(0);
      const pointer = readFileSync(join(real, "home"), "utf8");

      const second = join(temp("adopt-checkout-second"), "home");
      for (const words of [["adopt", second], ["move", second]]) {
        const refused = await home({ env }, words);
        expect(refused.status, refused.out).toBe(1);
        expect(refused.out).toContain(`this checkout would point this machine away from its home at ${realpathSync(first)}`);
        expect(refused.out).toContain(`LIFESTREAM_MACHINE_DIR=${real}`);
        expect(existsSync(second), words[0]).toBe(false);
        expect(readFileSync(join(real, "home"), "utf8")).toBe(pointer);
      }
      const again = await home({ env }, ["adopt", first]);
      expect(again.status, again.out).toBe(0);
      const meant = await home({ env: { ...env, LIFESTREAM_MACHINE_DIR: real } }, ["adopt", second]);
      expect(meant.status, meant.out).toBe(0);
      expect(readFileSync(join(real, "home"), "utf8")).toBe(`${realpathSync(second)}\n`);
    } finally {
      rmSync(user, { recursive: true, force: true });
    }
  });

  it("a new home's unit is other than the one its Mac pairs as, or an older home with none does not take its Mac's at its start", async () => {
    const here = newMachine("adopt-unit");
    const folder = join(temp("adopt-unit-parent"), "home");
    const adopted = await home(here, ["adopt", folder, "--model", "MacBook Pro", "--serial4", "0b7e"]);
    expect(adopted.status, adopted.out).toBe(0);
    const answer = adopted.result as { folder: string };
    const settingsFile = join(answer.folder, "config", "settings.json");
    expect(json(settingsFile).unit).toBe("macbook-pro-0b7e");
    expect((await home(here, ["adopt", join(temp("adopt-unit-bad"), "home"), "--serial4", "0b7e"])).out).toMatch(/--serial4 is four lowercase hex digits, with --model/u);
    expect((await home(here, ["settings", "set", "door.lan_port", "0"])).status).toBe(0);
    const { port } = await doorOn(here);
    const serving = await startHere(null, { machine: machineOf(here), log: () => undefined });
    const minted = await home(here, ["pair", "--json"]);
    expect(minted.status, minted.out).toBe(0);
    const pass = randomBytes(32).toString("base64url");
    const paired = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
      method: "POST", headers: { "content-type": "application/json", ...HEADERS.deliver },
      body: JSON.stringify({ code: (minted.result as { code: string }).code, pass, kind: "mac", model: "MacBook Pro", serial4: "0b7e" }),
    });
    const body = await paired.json() as { unit: string };
    expect({ status: paired.status, unit: body.unit }).toEqual({ status: 200, unit: "macbook-pro-0b7e" });
    await serving.stop();

    const { unit: _dropped, ...held } = json(settingsFile);
    writeFileSync(settingsFile, JSON.stringify(held));
    await serveOnce(null, { machine: machineOf(here) });
    expect(json(settingsFile).unit).toBe("macbook-pro-0b7e");
    report.unit = { adopted: "macbook-pro-0b7e", paired: body.unit };
  });

  it("a setup's look at a folder differs from what adopt does with it, or makes anything", async () => {
    const here = newMachine("look");
    const looks: Record<string, unknown> = {};
    for (const [name, place] of [
      ["documents", join(here.user, "Documents", "Lifestream")],
      ["icloud", join(here.user, "Library", "Mobile Documents", "com~apple~CloudDocs", "Lifestream")],
    ] as const) {
      const look = await home(here, ["machine", place]);
      expect(look.status, look.out).toBe(0);
      expect(existsSync(place), name).toBe(false);
      const refused = await home(here, ["adopt", place]);
      expect(refused.status, refused.out).toBe(1);
      expect((look.result as { folder: { refused: string } }).folder.refused, name).toBe(refused.out.trim());
      looks[name] = look.result;
    }
    const locked = temp("look-unwritable");
    chmodSync(locked, 0o500);
    const busy = temp("look-busy");
    mkdirSync(join(busy, "home"));
    const held = tryLock(join(busy, "home", "home.lock"))!;
    try {
      for (const [name, place, words] of [["unwritable", join(locked, "Lifestream"), /is not writable by this user/u], ["running", join(busy, "home"), /Lifestream runs on .*: stop it first/u]] as const) {
        const look = await home(here, ["machine", place]);
        const refused = await home(here, ["adopt", place]);
        expect(refused.status, refused.out).toBe(1);
        expect((look.result as { folder: { refused: string } }).folder.refused, name).toBe(refused.out.trim());
        expect(refused.out, name).toMatch(words);
        looks[name] = look.result;
      }
    } finally {
      held.release();
      chmodSync(locked, 0o700);
    }
    const place = join(temp("look-fine"), "Lifestream");
    const fine = await home(here, ["machine", place]);
    expect(fine.status, fine.out).toBe(0);
    expect(fine.result).toMatchObject({
      dir: here.dir, home: null,
      folder: { refused: null, free_bytes: 1e12, door: "http://127.0.0.1:4680" },
    });
    expect(existsSync(place)).toBe(false);
    expect((await home(here, ["adopt", place])).status).toBe(0);
    expect((await home(here, ["settings", "set", "door.port", "4690"])).status).toBe(0);
    const adopted = await home(here, ["machine", place]);
    expect(adopted.result).toMatchObject({ home: realpathSync(place), folder: { refused: null, door: "http://127.0.0.1:4690" } });
    expect((await home(here, ["machine"])).result).toMatchObject({ dir: here.dir, folder: null });
    report.look = { ...looks, fine: fine.result, adopted: adopted.result };
  });

  it("a folder on a network volume is adopted", async () => {
    const at = machine({ env: { LIFESTREAM_MACHINE_DIR: temp("adopt-network-machine") }, home: temp("adopt-network-user") });
    const place = join(temp("adopt-network"), "home");
    await expect(adopt(place, { machine: at, fileSystem: () => "smbfs" })).rejects.toThrow(/is on a network volume \(smbfs\)/u);
    expect(existsSync(place)).toBe(false);
    expect((await adopt(place, { machine: at, fileSystem: () => "apfs" })).as).toBe("new");
  });

  it("a folder on a drive that is not connected is adopted, and made on the boot disk; a folder not there is offered adopt; a disk's free bytes are read at a parent", async () => {
    const at = machine({ env: { LIFESTREAM_MACHINE_DIR: temp("adopt-drive-machine") }, home: temp("adopt-drive-user") });
    const drive = `lifestream-absent-${randomBytes(6).toString("hex")}`;
    const place = join("/Volumes", drive, "Lifestream");
    await expect(adopt(place, { machine: at })).rejects.toThrow(`the drive ${drive} is not connected`);
    expect(look(place, { machine: at }).folder?.refused).toMatch(`the drive ${drive} is not connected`);
    expect(existsSync(join("/Volumes", drive))).toBe(false);
    expect(machine({ env: { LIFESTREAM_MACHINE_DIR: at.dir } }).home).toBeNull();
    const blind = newMachine("adopt-drive-blind");
    const refused = await home({ env: { ...blind.env, PATH: join(blind.dir, "no-tools") } }, ["adopt", place]);
    expect(refused.status, refused.out).toBe(1);
    expect(refused.out).toContain(`the drive ${drive} is not connected${process.platform === "darwin" ? " (the mount table cannot be read)" : ""}`);
    const parent = temp("adopt-drive-gone");
    expect(() => readHome(join(parent, "home"))).toThrow(awayWords(join(parent, "home")));
    expect(() => readHome(parent)).toThrow(`${parent} is not Lifestream's folder: it holds no HOME.json (lifestream adopt <folder> makes one)`);
    expect(() => diskSpace(join(parent, "home"))).toThrow(/ENOENT/u);
  });

  it("a moved folder loses a pass, a setting or its id, or keeps its marker; a retired one starts the home or the door, or ends them", async () => {
    try {
      const from = newMachine("move-from");
      const folder = join(temp("move-from-parent"), "home");
      expect((await home(from, ["adopt", folder])).status).toBe(0);
      const passes = await mintPasses(from, folder);
      expect((await home(from, ["settings", "set", "door.port", "0"])).status).toBe(0);
      expect((await home(from, ["connectors", "set", "gmail", "refresh", "10m"])).status).toBe(0);
      const before = { home: readFileSync(join(folder, "HOME.json"), "utf8"), principals: readFileSync(join(folder, "config", "principals.json"), "utf8"), settings: readFileSync(join(folder, "config", "settings.json"), "utf8") };

      const retired = await home(from, ["retire"]);
      expect(retired.status, retired.out).toBe(0);
      expect(existsSync(join(folder, "RETIRED.json"))).toBe(true);
      const serve: string[] = [];
      let ended: string | null = null;
      void startHere(null, { machine: machineOf(from), log: (line) => serve.push(line) }).then(() => { ended = "started"; }, (error: Error) => { ended = error.message; });
      const opening = openDoor(null, { machine: machineOf(from), registry: homeRegistryModule(), settings: effective(folder).settings.door });
      void opening.then(({ door }) => door.closed.then((why) => { ended ??= `door closed: ${why}`; }), (error: Error) => { ended ??= `door: ${error.message}`; });
      await until("the home waits on the retired folder", () => serve.some((line) => /"home":"waiting","why":"Lifestream moved away: .* holds RETIRED\.json/u.test(line)));
      const { door, logs: doorLogs } = await opening;
      await until("the door listens, waiting on it", () => doorLogs.some((line) => /"door":"open".*"waiting":"Lifestream moved away: .* holds RETIRED\.json/u.test(line)));
      const asked = await fetch(`http://127.0.0.1:${door.port}/v1/status`);
      expect({ status: asked.status, code: ((await asked.json()) as { code: string }).code, ended }).toEqual({ status: 503, code: "NOT_NOW", ended: null });

      const to = newMachine("move-to", { unit: "mac-mini-bb03" });
      const moved = join(temp("move-to-parent"), "home");
      cpSync(folder, moved, { recursive: true });
      const adopted = await home(to, ["adopt", moved]);
      expect(adopted.status, adopted.out).toBe(0);
      expect(adopted.result).toMatchObject({ as: "moved", passes: { kept: [passes.deliver.id, passes.read.id, passes.station.id, passes.find.id], revoked: [], suspended: [] } });
      expect(existsSync(join(moved, "RETIRED.json"))).toBe(false);
      expect({
        home: readFileSync(join(moved, "HOME.json"), "utf8"), principals: readFileSync(join(moved, "config", "principals.json"), "utf8"),
        settings: readFileSync(join(moved, "config", "settings.json"), "utf8"),
      }).toEqual(before);
      expect(readFileSync(join(to.dir, "home"), "utf8").trim()).toBe(realpathSync(moved));
      expect(serve.join("\n")).not.toContain('"home":"started"');
      expect(ended).toBeNull();
      report.move = { retired: retired.result, serve: serve.join("\n"), door: doorLogs.join("\n"), adopted: adopted.result };
    } finally {
      await stopChildren();
    }
  });

  it("a restored folder keeps a reader's pass, lets a station pass in before the person resumes it, or drops a device's pass or a phone's reads", async () => {
    try {
      const was = newMachine("restore-was");
      const folder = join(temp("restore-was-parent"), "home");
      expect((await home(was, ["adopt", folder])).status).toBe(0);
      const passes = { ...(await mintPasses(was, folder)), phone: phoneOf(folder, "iphone-17-pro-aa01") };
      const now = newMachine("restore-now");
      const restored = join(temp("restore-now-parent"), "home");
      cpSync(folder, restored, { recursive: true });
      const adopted = await home(now, ["adopt", restored]);
      expect(adopted.status, adopted.out).toBe(0);
      expect(adopted.result).toMatchObject({ as: "restored", passes: { kept: [passes.deliver.id, passes.phone.id], revoked: [passes.read.id, passes.find.id], suspended: [passes.station.id] } });
      const rows = Object.fromEntries(readPrincipals(openHomeFolder(restored)).principals.map((row) => [row.id, row]));
      expect(rows[passes.deliver.id]).toMatchObject({ revoked_at: null, suspended_at: null });
      expect(rows[passes.phone.id]).toMatchObject({ scopes: ["deliver", "read"], revoked_at: null, suspended_at: null });
      expect(rows[passes.read.id]!.revoked_at).not.toBeNull();
      expect(rows[passes.find.id]!.revoked_at).not.toBeNull();
      expect(rows[passes.station.id]).toMatchObject({ revoked_at: null, suspended_at: expect.any(String) });

      const { port } = await doorOn(now);
      const state = async (who: keyof typeof HEADERS) => (await fetch(`http://127.0.0.1:${port}/v1/exchange`, {
        method: "POST", headers: { authorization: `Bearer ${passes[who].token}`, ...HEADERS[who] },
      })).status;
      const answers = { deliver: await state("deliver"), phone: await state("phone"), read: await state("read"), station: await state("station") };
      expect(answers).toEqual({ deliver: 200, phone: 200, read: 401, station: 401 });
      const resumed = await home(now, ["principals", "resume", passes.station.id]);
      expect(resumed.status, resumed.out).toBe(0);
      expect(await state("station")).toBe(403);
      report.restore = { adopted: adopted.result, answers, resumed: resumed.result };
    } finally {
      await stopChildren();
    }
  });

  it("a folder set up again on the Mac it was taken from keeps that Mac's old pass, so the Mac cannot pair as itself", async () => {
    const was = newMachine("again-was");
    const folder = join(temp("again-was-parent"), "home");
    expect((await home(was, ["adopt", folder])).status).toBe(0);
    const passes = { ...(await mintPasses(was, folder)), phone: phoneOf(folder, "iphone-17-pro-aa01") };
    const now = newMachine("again-now");
    const adopted = await home(now, ["adopt", folder, "--model", "MacBook Pro", "--serial4", "0001"]);
    expect(adopted.status, adopted.out).toBe(0);
    expect(adopted.result).toMatchObject({ as: "restored", passes: { kept: [passes.phone.id], revoked: [passes.deliver.id, passes.read.id, passes.find.id], suspended: [passes.station.id] } });
    const live = readPrincipals(openHomeFolder(folder)).principals.filter((row) => row.revoked_at === null).map((row) => row.unit);
    expect(live).not.toContain("macbook-pro-0001");
    expect(live).toContain("iphone-17-pro-aa01");
    report.again = adopted.result;
  });

  it("an older copy put back over the folder brings back a pass revoked since, or holds one that was not", async () => {
    try {
      const here = newMachine("revoked");
      const folder = join(temp("revoked-parent"), "home");
      expect((await home(here, ["adopt", folder])).status).toBe(0);
      expect((await home(here, ["settings", "set", "helpers", "2"])).status).toBe(0);
      const passes = { ...(await mintPasses(here, folder)), phone: phoneOf(folder, "iphone-17-pro-aa01"), lost: phoneOf(folder, "iphone-15-aa02") };
      const minted = await home(here, ["principals", "mint", "--unit", "dashboard", "--scope", "read", "--scope", "deliver", "--source", "people:local:macbook-pro-0001", "--json"]);
      expect(minted.status, minted.out).toBe(0);
      const both = (minted.result as { principal: { id: string } }).principal.id;
      const run = async () => (await serveOnce(null, { machine: machineOf(here) })).join("\n");
      await run();
      const dashboard = dashboardPass(here, folder);
      expect(dashboard).toMatchObject({ unit: "dashboard", scopes: ["read", "deliver"], revoked_at: null });
      const older = join(temp("revoked-older"), "home");
      cpSync(folder, older, { recursive: true });
      const elsewhere = newMachine("revoked-elsewhere");
      const unseen = await home(elsewhere, ["status", "--root", older]);
      expect(unseen.status, unseen.out).toBe(0);
      expect(existsSync(join(elsewhere.dir, "revoked"))).toBe(false);
      await run();
      expect((await home(here, ["principals", "revoke", passes.read.id])).status).toBe(0);
      await run();
      expect(dashboardPass(here, folder)!.id).toBe(dashboard!.id);
      expect((await home(here, ["principals", "revoke", passes.lost.id])).status).toBe(0);
      expect(revokedOn(here, folder)).toEqual([passes.read.id, passes.lost.id].sort());

      rmSync(folder, { recursive: true, force: true });
      cpSync(older, folder, { recursive: true });
      expect(readPrincipals(openHomeFolder(folder)).principals.find((row) => row.id === passes.read.id)!.revoked_at).toBeNull();
      const started = await run();
      expect(started).toMatch(/"home":"revoked again","passes":\[[^\]]*\]/u);
      const { door, port } = await doorOn(here);
      const state = async (who: keyof typeof HEADERS | "lost") => (await fetch(`http://127.0.0.1:${port}/v1/exchange`, {
        method: "POST", headers: { authorization: `Bearer ${passes[who].token}`, ...HEADERS[who === "lost" ? "phone" : who] },
      })).status;
      const answers = { deliver: await state("deliver"), phone: await state("phone"), lost: await state("lost"), read: await state("read"), station: await state("station") };
      expect(answers).toEqual({ deliver: 200, phone: 200, lost: 401, read: 401, station: 403 });
      await door.close();
      const rows = Object.fromEntries(readPrincipals(openHomeFolder(folder)).principals.map((row) => [row.id, row]));
      const live = (id: string) => rows[id]!.revoked_at === null && rows[id]!.suspended_at === null ? "live" : "stopped";
      expect({
        deliver: live(passes.deliver.id), phone: live(passes.phone.id), station: live(passes.station.id), dashboard: live(dashboard!.id), both: live(both),
        read: live(passes.read.id), lost: live(passes.lost.id),
      }).toEqual({ deliver: "live", phone: "live", station: "live", dashboard: "live", both: "live", read: "stopped", lost: "stopped" });
      expect(rows[passes.phone.id]!.scopes).toEqual(["deliver", "read"]);
      expect(dashboardPass(here, folder)!.id).toBe(dashboard!.id);
      expect(await run()).not.toContain("revoked again");
      const kept = await home(here, ["adopt", folder]);
      expect(kept.result).toMatchObject({ as: "kept", passes: { revoked: [] } });
      const list = revokedOn(here, folder);
      const id = readHome(folder).id;
      rmSync(join(here.dir, "revoked"), { recursive: true });
      mkdirSync(join(here.dir, "witness"));
      writeFileSync(join(here.dir, "witness", `${id}.json`), JSON.stringify({ events: 9, at: new Date().toISOString(), revoked: [passes.read.id, passes.lost.id] }));
      rmSync(folder, { recursive: true, force: true });
      cpSync(older, folder, { recursive: true });
      const upgraded = await home(here, ["adopt", folder]);
      expect(upgraded.result).toMatchObject({ as: "kept", passes: { revoked: [passes.read.id, passes.lost.id] } });
      report.revoked = { started: started.split("\n").find((line) => line.includes("revoked again")), answers, list, upgraded: upgraded.result };
    } finally {
      await stopChildren();
    }
  });

  it("a running home keeps running once retired, or its door takes a delivery after", async () => {
    try {
      const here = newMachine("retire-running");
      const folder = join(temp("retire-running-parent"), "home");
      expect((await home(here, ["adopt", folder])).status).toBe(0);
      const passes = await mintPasses(here, folder);
      expect((await home(here, ["settings", "set", "helpers", "2"])).status).toBe(0);
      const { port } = await doorOn(here);
      const running = start(here, CLI, ["serve", "--registry", FAKES]);
      await printed(running, "the home started", '"home":"started"');
      mkdirSync(join(folder, "replies"), { recursive: true });
      const call = tryLock(callsLock(join(folder, "replies", "replies.db")))!;
      const said: string[] = [];
      const retiring = home(here, ["retire"], said);
      expect(await running.exited).toBe(1);
      // paces: three of its looks; no event shows it has looked.
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(said.join("")).toBe("");
      call.release();
      const answered = await retiring;
      expect(answered.status, answered.out).toBe(0);
      const retired = { result: JSON.parse(answered.out) as unknown };
      expect(running.out()).toMatch(/"home":"stopped","why":"retired: .* holds RETIRED\.json"/u);
      const put = await fetch(`http://127.0.0.1:${port}/v1/acquisitions/apple-notes%3Alocal%3Amacbook-pro-0001/20261009T120000.000Z`, {
        method: "PUT", headers: { authorization: `Bearer ${passes.deliver.token}`, ...HEADERS.deliver }, body: Buffer.from("synthetic bundle"),
      });
      expect({ status: put.status, body: await put.json() }).toMatchObject({ status: 503, body: { code: "NOT_NOW", message: expect.stringContaining("Lifestream has moved") } });
      report.retire_running = { retired: retired.result, home: running.out().trim().split("\n").at(-1) };
    } finally {
      await stopChildren();
    }
  });
});

describe("settings", () => {
  it("an unknown member stops the home or is silent; a value the person set is replaced by a default; a value past a limit runs past it, silently, or is rewritten; change writes an unknown key", async () => {
    try {
      const here = newMachine("settings");
      const folder = join(temp("settings-parent"), "home");
      expect((await home(here, ["adopt", folder])).status).toBe(0);
      const path = join(folder, "config", "settings.json");
      expect((await home(here, ["settings", "set", "door.port", "0"])).status).toBe(0);
      const same = await home(here, ["settings", "set", "clocks", "true", "--json"]);
      expect(same.status, same.out).toBe(0);
      expect(same.result).toEqual({ changed: { key: "clocks", value: true, from: "person" } });
      writeFileSync(path, JSON.stringify({ ...json(path), "model.cap": 6, colcks: false, "connectors.gmail": { refresh: "1s", every_ms: 300_000 }, "door.bind": "100.101.102.103" }));
      const written = readFileSync(path, "utf8");
      const { settings, notices } = effective(folder);
      expect({ cap: settings.model.cap, connectors: settings.connectors, clocks: settings.clocks }).toEqual({ cap: 6, clocks: true, connectors: { gmail: { refresh: "1s", every_ms: 300_000 } } });
      expect(notices.map((notice) => notice.key)).toEqual(["colcks", "door.bind"]);
      const gmail = declarations().find((connector) => connector.id === "gmail")!;
      expect(connectorSettings(gmail, settings.connectors.gmail).refresh_ms).toBe(60_000);
      const checked = checkConnectors({ connectors: declarations() }, settings);
      expect(checked).toEqual([
        { key: "connectors.gmail.every_ms", what: expect.stringMatching(/holds connectors\.gmail\.every_ms, which gmail does not declare: it is kept and ignored/u) },
        { key: "connectors.gmail.refresh", what: expect.stringMatching(/connectors\.gmail\.refresh is 1s, past its bound: it runs at 1m/u) },
      ]);

      const running = start(here, CLI, ["serve", "--registry", FAKES]);
      await printed(running, "the home started", '"home":"started"');
      const said = running.out().split("\n").filter((line) => line.includes('"settings":"connectors.')).map((line) => (JSON.parse(line) as { settings: string }).settings);
      expect(said).toEqual(["connectors.gmail.every_ms", "connectors.gmail.refresh"]);
      const read = statusOf(folder);
      expect(read.needs.filter((need) => need.id.startsWith("settings:"))).toEqual([]);
      expect(read.notices.filter((notice) => notice.id.startsWith("settings:"))).toEqual([
        { id: "settings:colcks", since_ms: null, what: expect.stringMatching(/holds colcks, which this release does not know: it is kept and ignored/u) },
        { id: "settings:door.bind", since_ms: null, what: expect.stringMatching(/holds door\.bind, which this release does not know: it is kept and ignored/u) },
      ]);
      const refused = {
        unknown: await home(here, ["settings", "set", "clocks.typo", "true"]),
        block: await home(here, ["settings", "set", "connectors.gmail", JSON.stringify({ refresh: "10m" })]),
        limit: await home(here, ["connectors", "set", "gmail", "refresh", "1s"]),
        rule: await home(here, ["settings", "set", "day.zone", "Mars/Olympus"]),
      };
      for (const [name, answer] of Object.entries(refused)) expect(answer.status, `${name}: ${answer.out}`).toBe(1);
      expect(refused.unknown.out).toMatch(/clocks\.typo is not a setting/u);
      expect(refused.block.out).toMatch(/connectors\.gmail is set a member at a time: use lifestream connectors set gmail <member> <value>/u);
      expect(refused.limit.out).toMatch(/connectors\.gmail\.refresh runs from 1m up/u);
      expect(refused.rule.out).toMatch(/day\.zone is an IANA time zone/u);
      expect(readFileSync(path, "utf8")).toBe(written);
      expect((await home(here, ["settings", "reset", "colcks"])).status).toBe(0);
      expect((await home(here, ["settings", "reset", "door.bind"])).status).toBe(0);
      expect((await home(here, ["settings", "reset", "model.cap", "--json"])).result).toEqual({ changed: { key: "model.cap", value: 8, from: "release" } });
      expect(Object.keys(json(path)).sort()).toEqual(["clocks", "connectors.gmail", "day.zone", "door.port", "history.start", "unit"]);
      running.child.kill("SIGTERM");
      expect(await running.exited).toBe(0);
      report.settings = { same: same.result, notices, said: read.notices, refused: Object.fromEntries(Object.entries(refused).map(([name, answer]) => [name, answer.out.trim()])) };
    } finally {
      await stopChildren();
    }
  });
});

describe("the machine", () => {
  it("a program taken from the person's installs or PATH rather than the one its current names, run with another sign-in folder than the machine's, found past an override, or lost when the machine folder moves", async () => {
    try {
      const user = temp("codex-user");
      const system = temp("codex-system");
      const place = (path: string, says = "codex-cli 0.166.0") => {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, `#!/bin/sh\necho ${says}\n`, { mode: 0o755 });
        return path;
      };
      const dir = temp("codex-machine");
      const env = { LIFESTREAM_MACHINE_DIR: dir, PATH: join(system, "on-path") };
      const programs = (on: string) => {
        const at = machine({ env: { ...env, LIFESTREAM_MACHINE_DIR: on }, home: user, system });
        return { codex: at.codex, claude: at.claude };
      };
      place(join(system, "on-path", "codex"));
      place(join(system, "on-path", "claude"), "2.1.321 (Claude Code)");
      place(join(system, "opt", "homebrew", "bin", "codex"));
      place(join(user, ".local", "bin", "claude"), "2.1.321 (Claude Code)");
      const found: Record<string, unknown> = {};
      found.none = programs(dir);
      place(join(dir, "subscriptions", "codex", "0.166.0", "package", "bin", "codex"));
      place(join(dir, "subscriptions", "claude", "2.1.321", "package", "claude"), "2.1.321 (Claude Code)");
      found.unnamed = programs(dir);
      writeFileSync(join(dir, "subscriptions", "codex", "current"), "0.166.0/package/bin/codex\n");
      writeFileSync(join(dir, "subscriptions", "claude", "current"), "2.1.321/package/claude\n");
      found.ready = programs(dir);
      const moved = join(temp("codex-moved"), "machine");
      cpSync(dir, moved, { recursive: true });
      found.moved = programs(moved);
      rmSync(join(moved, "subscriptions", "claude", "2.1.321"), { recursive: true });
      found.gone = programs(moved).claude;
      writeFileSync(join(dir, "machine.json"), JSON.stringify({ codex: "/opt/elsewhere/codex", claude: "/opt/elsewhere/claude", unknown: "kept" }));
      found.override = programs(dir);
      expect(found).toEqual({
        none: { codex: null, claude: null },
        unnamed: { codex: null, claude: null },
        ready: {
          codex: { binary: join(dir, "subscriptions", "codex", "0.166.0", "package", "bin", "codex"), home: join(dir, "codex") },
          claude: { binary: join(dir, "subscriptions", "claude", "2.1.321", "package", "claude"), home: join(dir, "claude") },
        },
        moved: {
          codex: { binary: join(moved, "subscriptions", "codex", "0.166.0", "package", "bin", "codex"), home: join(moved, "codex") },
          claude: { binary: join(moved, "subscriptions", "claude", "2.1.321", "package", "claude"), home: join(moved, "claude") },
        },
        gone: null,
        override: { codex: { binary: "/opt/elsewhere/codex", home: join(dir, "codex") }, claude: { binary: "/opt/elsewhere/claude", home: join(dir, "claude") } },
      });
      rmSync(join(dir, "machine.json"));

      const here = newMachine("codex-home", { codex: join(system, "opt", "homebrew", "bin", "codex") });
      const folder = join(temp("codex-home-parent"), "home");
      expect((await home(here, ["adopt", folder])).status).toBe(0);
      expect((await home(here, ["settings", "set", "helpers", "2"])).status).toBe(0);
      const named = (await serveOnce(null, { machine: machineOf(here) })).join("\n");
      expect(named).toContain('"home":"started"');
      expect(named).toContain(`"codex":${JSON.stringify(join(system, "opt", "homebrew", "bin", "codex"))}`);
      writeFileSync(join(here.dir, "machine.json"), JSON.stringify({ codex: join(system, "nowhere", "codex") }));
      expect((await serveOnce(null, { machine: machineOf(here) })).join("\n")).toContain('"home":"started"');
      report.codex = found;
    } finally {
      await stopChildren();
    }
  });
});
