import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import type { Report } from "./feedback.js";
import { ask } from "./socket.js";
import { fakeWorker } from "./test/feedback-worker.js";
import { testSocket } from "./test/folder.js";
import { ChildHome, makeRoot, removeRoot, until } from "./test/harness-root.js";

const reportOf = (root: string, id: string): Report => JSON.parse(readFileSync(join(root, "feedback", id, "report.json"), "utf8")) as Report;

async function crashed(point: "feedback-kept" | "feedback-filed") {
  const root = makeRoot(`lifestream-feedback-${point}-`, { sources: {} });
  onTestFinished(() => removeRoot(root));
  const worker = await fakeWorker();
  const env = { LIFESTREAM_TEST_FEEDBACK_URL: worker.url };
  const child = new ChildHome(root);
  onTestFinished(async () => { await child.stop(); });
  child.start(point, { env });
  await child.ready();
  const sock = testSocket(root);
  const id = randomUUID();
  const drafted = await ask(sock, { verb: "feedback", call: "draft", id, about: { kind: "menu" }, by: "reader-0001", device: { kind: null, version: null } });
  expect(drafted).toMatchObject({ email: null });
  await ask(sock, { verb: "feedback", call: "send", id, text: "A synthetic report.", email: null, keep: [], by: "reader-0001" }).catch(() => undefined);
  expect(await child.exited()).toEqual({ code: null, signal: "SIGKILL" });
  rmSync(sock.path, { force: true });
  return {
    root, worker, id,
    async again() {
      child.start(undefined, { env });
      await child.ready();
    },
  };
}

describe("feedback, killed", () => {
  it("killed once report.json is kept and before it went: after a restart the report is queued and the tick sends it", async () => {
    const at = await crashed("feedback-kept");
    expect(reportOf(at.root, at.id)).toMatchObject({ id: at.id, state: "queued", tries: 0 });
    expect(at.worker.filed).toEqual([]);
    await at.again();
    await until("the kept report went", () => reportOf(at.root, at.id).state === "sent");
    expect(at.worker.filed.map((each) => JSON.parse(each.parts.get("report")!.text).id)).toEqual([at.id]);
  });

  it("killed after the Worker took the report and before it was marked sent: after a restart it is sent again under its id, which the Worker keeps once", async () => {
    const at = await crashed("feedback-filed");
    expect(at.worker.filed).toHaveLength(1);
    expect(reportOf(at.root, at.id)).toMatchObject({ state: "queued", sent_ms: null });
    await at.again();
    await until("the report was marked sent", () => reportOf(at.root, at.id).state === "sent");
    expect(at.worker.filed.map((each) => JSON.parse(each.parts.get("report")!.text).id), "the same id twice: the Worker's INSERT keeps it once").toEqual([at.id, at.id]);
  });
});
