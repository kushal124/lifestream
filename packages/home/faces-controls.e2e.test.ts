import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { openHomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import { findingsDirOf } from "./engine-pictures.js";
import { deliveryAt, lanes, readDelivery, readSealed } from "./inbox.js";
import { askHome } from "./socket.js";
import { artifact, readHome, readLedger, removeRoot, settled, until } from "./test/harness-root.js";
import { shipFiles } from "./test/harness-deliveries.js";
import { doorHere } from "./test/harness-door.js";
import { startHere } from "./test/harness-home.js";
import { editSettings, testSocket } from "./test/folder.js";
import { facesMemo } from "./registry-home.js";
import { calls, eventually, FACES, facesRoot, facesRow, FETCH, GOOGLE, head, heads, LEFT, naming, PEOPLE, personOf, REGISTRY, removeEngine, resting, scans, sha256, shipPhotos, UNIT, waiting } from "./test/faces.js";

describe("the controls of faces on a running home", () => {
  const roots: string[] = [];
  const doors = new Set<string>();
  const homeOn = async (root: string, log: (line: string) => void = () => undefined) => {
    if (!doors.has(root)) {
      await doorHere(root, { registry: REGISTRY });
      doors.add(root);
      onTestFinished(() => { doors.delete(root); });
    }
    return startHere(root, { registry: REGISTRY, log });
  };

  afterAll(() => {
    for (const root of roots) removeRoot(root);
    removeEngine();
  });

  it("H7: faces on fetches in the verb, queues the install twice, takes models that failed their self-check, or the labeler does not run once the models are in; the Faces row or the captions do not follow", async () => {
    const { root, photos: { n4: late, ...photos } } = facesRoot("lifestream-faces-on-", { n1: 1, n2: 1, n3: 0, n4: 0 }, {
      models: false, camera: true,
    });
    roots.push(root);
    editSettings(root, { unit: null });
    const engine = join(root, "engine");
    const config = join(engine, "engine.json");
    const configure = (change: JsonObject) => writeFileSync(config, JSON.stringify({ ...(JSON.parse(readFileSync(config, "utf8")) as JsonObject), ...change }));
    writeFileSync(join(engine, "fetch-models.sh"), FETCH(engine));
    const requests = () => readLedger(root, (db) => db.prepare("SELECT unit, attachments FROM requests ORDER BY unit").all() as { unit: string; attachments: string }[]) ?? [];
    const captions = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM enrichments WHERE family = 'photos' AND state = 'done'").pluck().get() as number);
    await homeOn(root);
    expect((JSON.parse(readFileSync(join(root, "config", "settings.json"), "utf8")) as JsonObject).unit).toBe(UNIT);
    const sock = testSocket(root);
    await shipPhotos(root, Object.values(photos), Date.now() - 60_000);
    await until("the captions", () => captions() === 2);
    expect(requests().length).toBe(2);
    expect(readFileSync(join(engine, "calls.log"), "utf8").split("\n").filter((line) => line.startsWith("draw ")).map((line) => (JSON.parse(line.slice("draw ".length)) as { images: { faces: unknown[] }[] }).images[0]!.faces))
      .toEqual([[], []]);
    await until("the photos imported", () => settled(root, 1) || resting(root) === "not-installed");
    await until("the cameras labeler's photos", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM heads WHERE source = ? AND kind = 'photo' AND version <> 'gone'").pluck().get(`cameras:local:${UNIT}`) as number) === 3);
    const never = await facesRow(root);
    expect(never).toMatchObject({ id: "faces", set_up: false, health: { state: "setup", reason: "install" } });

    configure({ selfCheck: false });
    expect(await askHome(sock, "faces", ["on"])).toMatchObject({ installing: true });
    await until("the fetch begun", () => existsSync(join(engine, "fetch.log")));
    const installing = await facesRow(root);
    expect(installing).toMatchObject({ set_up: false });
    await askHome(sock, "faces", ["on"]);
    writeFileSync(join(engine, "go"), "");
    const installs = () => readHome(root, (db) => db.prepare("SELECT outcome FROM runs WHERE kind = 'install' ORDER BY id").pluck().all() as string[]);
    await until("the install failed", () => installs().length === 1 && installs()[0] === "failed");
    expect((await facesRow(root)).health.state).not.toBe("ok");
    expect(heads(root, "scan")).toBe(0);
    configure({ selfCheck: true });
    await askHome(sock, "faces", ["on"]);
    await until("every photo scanned", () => heads(root, "scan") === 3);
    await until("the row up to date", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE kind = 'install' AND state IN ('queued', 'running')").pluck().get() as number) === 0);
    expect(readFileSync(join(engine, "fetch.log"), "utf8").trim().split("\n")).toEqual(["fetched"]);
    const runs = readHome(root, (db) => db.prepare("SELECT subject, outcome, counts FROM runs WHERE kind = 'install' ORDER BY id").all() as { subject: string; outcome: string; counts: string | null }[]);
    expect(runs.map((run) => ({ ...run, counts: run.counts === null ? null : JSON.parse(run.counts) as unknown })))
      .toEqual([expect.objectContaining({ subject: "faces", outcome: "failed" }), { subject: "faces", outcome: "ok", counts: { self_check: expect.objectContaining({ ok: true }) } }]);
    const checked = { models: join(root, "tools", "faces", "models", "buffalo_l"), reference: join(engine, "reference") };
    expect(calls(root).filter((line) => line.startsWith("self-check ")).map((line) => JSON.parse(line.slice("self-check ".length)) as unknown)).toEqual([checked, checked]);
    const quiet = () => settled(root, readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries").pluck().get() as number));
    await until("the captions again", () => heads(root, "model-image") === 3 && captions() === 2 && quiet());
    expect(requests().length).toBe(2);
    expect(readHome(root, (db) => db.prepare("SELECT connector FROM sources WHERE id = ?").pluck().get(FACES))).toBe("faces");
    const on = await eventually("the row up to date", async () => {
      const row = await facesRow(root);
      return row.health.state === "ok" && row.history?.state === "done" ? row : undefined;
    });
    expect(on).toMatchObject({ on: true, set_up: true });
    expect(on.copies.map((copy) => copy.id)).toEqual([FACES]);
    configure({ hang: "scan" });
    await shipPhotos(root, [late!], Date.now() - 7_200_000);
    await until("the labeler running and the new burst planned", () => readHome(root, (db) => db.prepare("SELECT state FROM jobs WHERE kind = 'label' AND key = 'faces'").pluck().get()) === "running"
      && readHome(root, (db) => db.prepare("SELECT count(*) FROM extracts WHERE family = 'photos' AND content LIKE ?").pluck().get(`%${late!.hex}%`) as number) > 0
      && readHome(root, (db) => db.prepare("SELECT count(*) FROM dirty_units WHERE family = 'photos'").pluck().get() as number) === 0);
    expect(requests().length).toBe(2);
    expect(readHome(root, (db) => db.prepare("SELECT count(*) FROM enrichments WHERE family = 'photos' AND item = ?").pluck().get(`photo:${late!.hex}`))).toBe(0);
    artifact(root, "faces-on", { never: never.health, installing: installing.health, on: [on.health, on.history], runs });
  });

  it("H8: faces off during a run leaves it going, a label job begins while off, or on again does not scan what came meanwhile", async () => {
    const { root, photos } = facesRoot("lifestream-faces-off-", { f1: 1, f2: 1, f3: 1, f4: 1 });
    roots.push(root);
    const config = join(root, "engine", "engine.json");
    const engine = (change: JsonObject) => writeFileSync(config, JSON.stringify({ ...(JSON.parse(readFileSync(config, "utf8")) as JsonObject), ...change }));
    engine({ hang: "scan" });
    const logs: JsonObject[] = [];
    await homeOn(root, (line) => logs.push(JSON.parse(line) as JsonObject));
    const sock = testSocket(root);
    await shipPhotos(root, [photos.f1!, photos.f2!], Date.now() - 60_000);
    await until("a labeler run under way", () => calls(root).some((line) => line.startsWith("scan ")));
    expect(await askHome(sock, "faces", ["off"])).toMatchObject({ changed: { key: "sources.off", value: ["faces"] } });
    expect(logs).toContainEqual(expect.objectContaining({ job: "label", key: "faces", stopped: `${FACES} is turned off` }));
    const label = () => readHome(root, (db) => db.prepare("SELECT state FROM jobs WHERE kind = 'label' AND key = 'faces'").pluck().get() as string | undefined);
    expect(label()).not.toBe("running");

    engine({ hang: null });
    const asked = calls(root).length;
    await shipPhotos(root, [photos.f3!, photos.f4!], Date.now() - 30_000);
    await until("the photos imported", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM heads WHERE source = ? AND kind = 'img'").pluck().get(GOOGLE) as number) === 4);
    await until("the home quiet", () => settled(root, 2));
    expect(calls(root).length).toBe(asked);
    expect(heads(root, "scan")).toBe(0);
    expect((await facesRow(root)).health.state).toBe("off");

    await askHome(sock, "faces", ["on"]);
    await until("every photo scanned", () => heads(root, "scan") === 4);
    await until("the faces grouped, and each photo's model image stated", () => heads(root, "model-image") === 4);
    expect(await eventually("the row up to date", async () => ((row) => (row.health.state === "ok" && row.history?.state === "done" ? true : undefined))(await facesRow(root)))).toBe(true);
    artifact(root, "faces-off", { stopped: logs.filter((entry) => entry.stopped !== undefined), scans: scans(root) });
  });

  it("H9: a backlog past the battery bar scans on battery, the row does not say it waits for power, Scan now does not run it once and end, or runs while faces' source is off by its own id", async () => {
    const { root, photos } = facesRoot("lifestream-faces-power-", { w1: 0, w2: 0, w3: 0 }, { settings: { "connectors.faces": { battery_backlog: 2 } } });
    roots.push(root);
    writeFileSync(join(root, "engine", "on-battery"), "");
    await homeOn(root);
    const sock = testSocket(root);
    await shipPhotos(root, Object.values(photos), Date.now() - 60_000);
    await until("the labeler waits for power", () => resting(root) === "waiting-for-power");
    await until("the images stated", () => heads(root, "image") === 3);
    expect(heads(root, "scan")).toBe(0);
    const waitingRow = await facesRow(root);
    expect(waitingRow).toMatchObject({ on: true, line: "Waiting for power", health: { state: "waiting", reason: "power", acts: [{ do: "try", label: "Scan now", need: "label:faces" }] } });

    await askHome(sock, "faces", ["off"]);
    await expect(askHome(sock, "act", ["label:faces", "try"])).rejects.toThrow(/label:faces offers no try now/u);
    await askHome(sock, "faces", ["on"]);
    await askHome(sock, "connectors", ["off", FACES]);
    await expect(askHome(sock, "act", ["label:faces", "try"])).rejects.toThrow(/label:faces offers no try now/u);
    expect(await facesRow(root)).toMatchObject({ on: false, health: { state: "off" } });
    await askHome(sock, "faces", ["on"]);
    await until("Scan now offered again", async () => (await facesRow(root)).health.acts.some((act) => act.do === "try"));
    expect(await askHome(sock, "act", ["label:faces", "try"])).toEqual({ acted: "queued" });
    await until("every photo scanned on battery", () => heads(root, "scan") === 3);
    expect(scans(root)).toEqual([[photos.w1!.hex, photos.w2!.hex, photos.w3!.hex]]);
    await until("Scan now ended by the run that left nothing owed", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM meta WHERE key = 'faces:now'").pluck().get() as number) === 0);
    const done = await eventually("the row up to date", async () => {
      const row = await facesRow(root);
      return row.health.state === "ok" && row.history?.state === "done" ? row : undefined;
    });
    expect(done.history).toMatchObject({ state: "done", left: null });
    expect(resting(root)).toBeUndefined();
    artifact(root, "faces-power", { waiting: waitingRow.health, done: done.history });
  });

  it("H10: Delete all face data leaves anything of faces but its model images (a Chat photo's kept match among them), takes a person or the models, leaves faces on or a waiting delivery's files; on again does not scan afresh or redraws a model image whose names stand", async () => {
    const { root, photos } = facesRoot("lifestream-faces-forget-", { k1: 1, k2: 1, k3: 1, m1: 2, m2: 2, m3: 2, k4: 0, k5: 1 }, { camera: true });
    roots.push(root);
    await homeOn(root);
    const sock = testSocket(root);
    const { k5: late, ...first } = photos;
    await shipPhotos(root, Object.values(first), Date.now() - 60_000);
    await shipFiles(root, PEOPLE, Date.now() - 30_000, naming(photos.k1!.hex), { device: UNIT });
    await until("Person A's faces named and the other group made", () => personOf(root, photos.k3!.hex) === "person-a" && heads(root, "cluster") === 1 && heads(root, "model-image") === 7);
    const files = readHome(root, (db) => (db.prepare("SELECT v.text FROM heads h JOIN versions v ON v.id = h.version WHERE h.source = ? AND h.kind = 'scan'").pluck().all(FACES) as string[])
      .flatMap((text) => {
        const scan = (JSON.parse(text) as { content: { vectors: string | null; faces: { crop: string | null }[] | null } }).content;
        return [scan.vectors, ...(scan.faces ?? []).map((face) => face.crop)].filter((blob): blob is string => blob !== null);
      }));
    const blobs = openHomeFolder(root).blobs(join(root, "blobs"));
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((blob) => blobs.has(blob))).toBe(true);
    const named = head(root, "model-image", photos.k1!.hex);
    expect(named).toEqual({ faces: [{ box: LEFT }], names: [{ who: "person:person-a", shown: "Person A" }] });
    const memo = facesMemo(root, process.env.LIFESTREAM_MACHINE_DIR!);
    expect(existsSync(memo)).toBe(true);

    await askHome(sock, "pause", [`import:${FACES}`, "--reason", "a test"]);
    await shipPhotos(root, [late!], Date.now() - 20_000);
    await until("the labeler's delivery waiting", () => waiting(root, FACES) === 1);
    const id = readHome(root, (db) => db.prepare("SELECT id FROM deliveries WHERE source = ? AND state <> 'imported'").pluck().get(FACES) as string);
    const carried = (readSealed(openHomeFolder(root), deliveryAt(openHomeFolder(root), id))?.files ?? []).map((file) => `sha256:${file.sha256}`);
    expect(carried.length).toBeGreaterThan(1);
    const other = readHome(root, (db) => db.prepare("SELECT id FROM deliveries WHERE source <> ? ORDER BY id DESC LIMIT 1").pluck().get(FACES) as string);
    const otherReads = () => readDelivery(openHomeFolder(root), other.slice(0, other.indexOf("/")), other.slice(other.indexOf("/") + 1))?.id;
    expect(otherReads()).toBe(other);

    const chat = "cd".repeat(32);
    const shard = join(findingsDirOf(openHomeFolder(root), process.env.LIFESTREAM_MACHINE_DIR!).dir, chat.slice(0, 2));
    mkdirSync(shard, { recursive: true });
    writeFileSync(join(shard, `${chat}.json`), "{}\n");
    writeFileSync(join(shard, `${chat}.match.json`), `${JSON.stringify({ faces: [{ box: [1, 2, 31, 42], who: "person:person-a" }] })}\n`);

    const forgot = await askHome(sock, "faces", ["forget"]) as JsonObject;
    expect(forgot).toMatchObject({ records: expect.any(Number), blobs: expect.any(Number), superseded: 1 });
    expect(readdirSync(shard)).toEqual([`${chat}.json`]);
    const left = readHome(root, (db) => ({
      faces: db.prepare("SELECT count(*) FROM statements WHERE source = ? AND kind <> 'model-image'").pluck().get(FACES),
      heads: db.prepare("SELECT kind, count(*) AS n FROM heads WHERE source = ? GROUP BY kind").all(FACES),
      statements: db.prepare("SELECT count(*) FROM statements WHERE source = ? AND kind = 'face'").pluck().get(PEOPLE),
      persons: db.prepare("SELECT count(*) FROM heads WHERE source = ? AND kind = 'person'").pluck().get(PEOPLE),
      cursor: db.prepare("SELECT seq FROM cursors WHERE name = 'label:faces'").pluck().get(),
      run: db.prepare("SELECT outcome FROM runs WHERE kind = 'forget' AND subject = ?").pluck().get(FACES),
      delivery: db.prepare("SELECT state FROM deliveries WHERE source = ? AND state <> 'imported'").pluck().all(FACES),
    }));
    expect(left).toEqual({ faces: 0, heads: [{ kind: "model-image", n: 7 }], statements: 0, persons: 1, cursor: 0, run: "ok", delivery: ["superseded"] });
    expect(head(root, "model-image", photos.k1!.hex)).toEqual(named);
    expect(files.filter((blob) => blobs.has(blob))).toEqual([]);
    expect(carried.filter((blob) => blobs.has(blob))).toEqual([]);
    expect(lanes(openHomeFolder(root)).includes(FACES)).toBe(false);
    expect(otherReads()).toBe(other);
    expect(existsSync(join(root, "tools", "faces-work"))).toBe(false);
    expect(existsSync(dirname(memo))).toBe(false);
    expect(existsSync(join(root, "tools", "faces", "models", "buffalo_l", "det_10g.onnx"))).toBe(true);
    expect((JSON.parse(readFileSync(join(root, "config", "settings.json"), "utf8")) as JsonObject)["sources.off"]).toEqual(["faces"]);
    await until("the cameras labeler's photos", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM heads WHERE source = ? AND kind = 'photo' AND version <> 'gone'").pluck().get(`cameras:local:${UNIT}`) as number) === 8);
    expect((await facesRow(root)).health.state).toBe("off");

    await askHome(sock, "resume", [`import:${FACES}`]);
    const drawings = () => readHome(root, (db) => db.prepare("SELECT key FROM statements WHERE source = ? AND kind = 'model-image' ORDER BY seq").pluck().all(FACES) as string[]);
    const drawnBefore = drawings().length;
    const before = scans(root).length;
    await askHome(sock, "faces", ["on"]);
    await until("every photo scanned again", () => heads(root, "scan") === 8);
    expect(scans(root).slice(before).map((keys) => keys.length)).toEqual([8]);
    await until("both groups made again", () => heads(root, "cluster") === 2 && heads(root, "model-image") === 8);
    expect(drawings().slice(drawnBefore).sort()).toEqual([photos.k1!.hex, photos.k2!.hex, photos.k3!.hex, late!.hex].sort());
    expect(head(root, "model-image", photos.k1!.hex)).toEqual({ faces: [{ box: LEFT }], names: [null] });
    artifact(root, "faces-forget", { forgot, left, redrawn: drawings().slice(drawnBefore) });
  });

  it("H11: Delete all face data runs while an owner's delivery that may name faces waits to import, or changes anything when it refuses", async () => {
    const { root, photos } = facesRoot("lifestream-faces-forget-waits-", { q1: 1, q2: 1, q3: 1 }, { camera: true });
    roots.push(root);
    await homeOn(root);
    const sock = testSocket(root);
    await shipPhotos(root, Object.values(photos), Date.now() - 60_000);
    await until("the photos grouped", () => heads(root, "cluster") === 1);
    await askHome(sock, "pause", [`import:${PEOPLE}`, "--reason", "a test"]);
    await shipFiles(root, PEOPLE, Date.now() - 30_000, naming(photos.q1!.hex), { device: UNIT });
    await until("the owner's delivery waiting", () => waiting(root, PEOPLE) === 1);
    await expect(askHome(sock, "faces", ["forget"])).rejects.toThrow(new RegExp(`a delivery of ${PEOPLE} waits to import, and may name faces again`, "u"));
    expect(heads(root, "cluster")).toBe(1);
    expect((JSON.parse(readFileSync(join(root, "config", "settings.json"), "utf8")) as JsonObject)["sources.off"] ?? []).toEqual([]);

    await askHome(sock, "resume", [`import:${PEOPLE}`]);
    await until("the owner's delivery landed", () => waiting(root, PEOPLE) === 0);
    const forgot = await askHome(sock, "faces", ["forget"]) as JsonObject;
    expect(readHome(root, (db) => db.prepare("SELECT count(*) FROM statements WHERE source = ? AND kind = 'face'").pluck().get(PEOPLE))).toBe(0);
    artifact(root, "faces-forget-waits", { forgot });
  });

  it("H12: a labeler turned on by its source, with nothing else moved, stays asleep; a paused one, resumed, does not run", async () => {
    const { root, photos: { s3: paused, ...photos } } = facesRoot("lifestream-labeler-on-", { s1: 1, s2: 1, s3: 1 });
    roots.push(root);
    await homeOn(root);
    const sock = testSocket(root);
    const job = () => readHome(root, (db) => db.prepare("SELECT state FROM jobs WHERE kind = 'label' AND key = 'faces'").pluck().get() as string | undefined);
    const imported = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM heads WHERE source = ? AND kind = 'img'").pluck().get(GOOGLE) as number);
    await askHome(sock, "connectors", ["off", FACES]);
    await shipPhotos(root, Object.values(photos), Date.now() - 60_000);
    await until("the photos imported, the labeler's job ended", () => imported() === 2 && job() === "done");
    expect(heads(root, "scan")).toBe(0);
    await askHome(sock, "connectors", ["on", FACES]);
    await until("the photos scanned", () => heads(root, "scan") === 2);

    await askHome(sock, "pause", ["label:faces", "--reason", "a test"]);
    await shipPhotos(root, [paused!], Date.now() - 30_000);
    await until("the photo imported, the labeler's job held", () => imported() === 3 && job() === "queued");
    expect(heads(root, "scan")).toBe(2);
    await askHome(sock, "resume", ["label:faces"]);
    await until("the paused photo scanned", () => heads(root, "scan") === 3);
    artifact(root, "labeler-on", { scans: scans(root) });
  });
});
