import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { faces as facesModule } from "@lifestreamprotocol/connect";
import { flush, isRead, type JsonObject } from "@lifestreamprotocol/core";
import { targetOf } from "../attempts.js";
import { findingsDirOf, forgetMatches } from "../engine-pictures.js";
import { connectorOfJob, LANE, type Kind } from "../jobs.js";
import { homeOf } from "../registry.js";
import { deliveriesOf, deliveryDirectory, inboxLane, readSealed } from "../inbox.js";
import { forgetPeopleUndo } from "../people-draft.js";
import { emptyFacesWork, facesMemo, faceModels, facesRun } from "../registry-home.js";
import { readArgs } from "./args.js";
import { turn } from "./connectors.js";
import { fail, holdHome, readersOf, type VerbContext } from "./context.js";
import { CLI } from "../cli-name.js";

const USAGE = "faces on | faces off | faces forget";
const LABELER = "faces";
const FACES = facesModule.connectors[0]!.id;

export async function faces(ctx: VerbContext, args: readonly string[]) {
  const { positionals } = readArgs("faces", args, {}, USAGE, 1);
  const unit = ctx.settings.unit;
  const action = positionals[0];
  if (action === "on") return on(ctx);
  if (action === "off") return turn(ctx, FACES, false);
  if (action === "forget") return forget(ctx, unit);
  return fail(`usage: ${CLI} ${USAGE}`);
}
faces.usage = USAGE;

async function on(ctx: VerbContext) {
  const turned = await turn(ctx, FACES, true, true);
  const installed = facesModule.modelsInstalled(faceModels(ctx.folder.root));
  const registry = await ctx.registry();
  const at = ctx.now();
  ctx.db.commit((tx) => {
    const job = (kind: string, lane: number) => tx.tables.jobs.enqueue({ kind, key: LABELER, connector: connectorOfJob(registry, tx.tables, kind, LABELER), lane, not_before_ms: at, now_ms: at });
    if (installed) job("label", LANE.live);
    else if (job("install", LANE.polls) === "dead") tx.tables.jobs.revive(at, { kind: "install", key: LABELER });
  });
  ctx.out(installed ? "faces scans what it owes" : "faces gets the face models first: the install faces job fetches them and checks the engine");
  return { ...turned, installing: !installed };
}

async function forget(ctx: VerbContext, unit: string) {
  const source = `faces:local:${unit}`;
  const people = `people:local:${unit}`;
  await forgottenOf(ctx, source, people);
  return await holdHome(ctx, () => forgetHeld(ctx, source, people));
}

async function forgottenOf(ctx: VerbContext, source: string, people: string): Promise<{ source: string; kinds: string[] }[]> {
  const registry = await ctx.registry();
  const view = ctx.db.view();
  try {
    if (view.tables.deliveries.waiting(people) !== undefined) fail(`a delivery of ${people} waits to import, and may name faces again: faces forget runs once it has landed`);
    const forgotten = [{ source, kinds: view.kinds(source).filter((kind) => kind !== facesModule.MODEL_IMAGE_KIND) }, { source: people, kinds: ["face"] }];
    for (const { source: of, kinds } of forgotten) {
      for (const kind of kinds) {
        const readers = readersOf(registry, view.source(of), kind);
        if (readers.length > 0) fail(`family ${readers.map((family) => family.name).join(", ")} reads ${kind} of ${of}: faces forget would leave its extracts showing it`);
      }
    }
    return forgotten;
  } finally {
    view.close();
  }
}

async function forgetHeld(ctx: VerbContext, source: string, people: string) {
  const forgotten = await forgottenOf(ctx, source, people);
  await turn(ctx, FACES, false);
  const deliveries = deliveriesOf(ctx.folder, source);
  const copies = [...new Set(deliveries.flatMap((name) => (readSealed(ctx.folder, deliveryDirectory(ctx.folder, source, name))?.files ?? []).map((file) => `sha256:${file.sha256}`)))];

  const at = ctx.now();
  return ctx.db.commit((tx) => {
    const run = tx.tables.runs.start({ kind: "forget", subject: source, started_ms: at });
    const forgot = tx.records.forget({ sources: forgotten, blobs: copies });
    tx.tables.cursors.reset(`label:${LABELER}`, null, at);
    tx.tables.meta.delete(`${LABELER}:now`);
    tx.tables.attempts.delete(targetOf("label", LABELER));
    forgetPeopleUndo(tx);
    let superseded = 0;
    for (const name of deliveries) {
      const row = tx.tables.deliveries.get(`${source}/${name}`, source);
      if (row === undefined || isRead(row)) continue;
      tx.tables.deliveries.move(row.id, source, { move: "supersede", why: `removed by faces forget run ${run}` });
      superseded++;
    }
    const counts = { records: forgot.records, statements: forgot.statements, versions: forgot.versions.length, blobs: forgot.blobs.length, deliveries: deliveries.length, superseded };
    tx.tables.runs.end(run, { ended_ms: at, outcome: "ok", counts });
    tx.tables.events.append({ at_ms: at, kind: "forget", key: source, detail: { run, ...counts } });
    for (const hash of forgot.blobs) ctx.blobs.remove(hash);
    inboxLane(ctx.folder, source).remove();
    emptyFacesWork(homeOf(ctx.folder));
    rmSync(dirname(facesMemo(ctx.folder.root, ctx.machine.dir)), { recursive: true, force: true });
    for (const folder of forgetMatches(findingsDirOf(ctx.folder, ctx.machine.dir))) flush(folder);
    ctx.out(`faces is off and holds nothing but the names on its model images: ${forgot.records} records and ${forgot.blobs.length} files removed; person records stay`);
    return { run, ...counts };
  });
}

export const installKind: Kind<null, never, JsonObject, number> = {
  dies: true,
  begin(main, tx) {
    if (main.settings.unit === null || facesModule.modelsInstalled(faceModels(main.folder.root))) return null;
    return { data: null, state: tx.tables.runs.start({ kind: "install", subject: LABELER, started_ms: main.now() }) };
  },
  async *helper(env) {
    const labeler = env.registry.labelers?.find((each) => each.name === LABELER) as facesModule.FacesLabeler | undefined;
    if (labeler === undefined) throw new Error("the home builds no faces labeler: the settings name no unit");
    return await labeler.install(env.signal);
  },
  done(main, tx, running, check) {
    const at = main.now();
    tx.tables.runs.end(running.state, { ended_ms: at, outcome: "ok", counts: { self_check: check } });
    tx.tables.jobs.enqueue({ kind: "label", key: LABELER, connector: connectorOfJob(main.registry, tx.tables, "label", LABELER), lane: LANE.live, not_before_ms: at, now_ms: at });
    if (facesRun(main.settings, main.folder.root)) main.facesTurned(tx);
  },
  failed(main, tx, _job, run, error) {
    if (run !== undefined) tx.tables.runs.end(run, { ended_ms: main.now(), outcome: "failed", error });
  },
  stopped(main, tx, running) {
    tx.tables.runs.end(running.state, { ended_ms: main.now(), outcome: "failed", error: "stopped" });
  },
};
