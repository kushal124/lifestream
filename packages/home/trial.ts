import { createInterface } from "node:readline";
import { declaredInChild, IMPORTING, trial, TRIAL_ANSWER, type DeclareAsk, type TrialAsk } from "./folders.js";
import type { ProofEvent, ProveAsk } from "./conformance-acquirers.js";

const serveGuarded = process.argv.includes("--serve");
const serveUnguarded = process.argv.includes("--serve-unguarded");

if (serveGuarded || serveUnguarded) {
  const { guardConnections, resetConnections } = serveGuarded ? await import("./conformance-acquirers.js") : { guardConnections: () => undefined, resetConnections: () => undefined };
  const { proveInChild } = serveGuarded ? await import("./conformance.js") : { proveInChild: undefined };
  guardConnections();
  let busy = false;
  process.on("beforeExit", () => {
    if (busy) process.exit(13);
  });
  const emit = (event: ProofEvent) => process.stdout.write(`\n${JSON.stringify(event)}\n`);
  const readLine = async (line: string) => {
    if (line.trim() === "") return;
    const ask = JSON.parse(line) as TrialAsk | ProveAsk | DeclareAsk;
    resetConnections();
    process.stdin.pause();
    process.stdin.unref();
    busy = true;
    try {
      if ("prove" in ask) {
        await proveInChild!(ask, emit);
      } else if ("declare" in ask) {
        process.stdout.write(IMPORTING);
        const answer = await declaredInChild(ask);
        process.stdout.write(`\n${TRIAL_ANSWER}${JSON.stringify(answer)}\n`);
      } else {
        process.stdout.write(IMPORTING);
        const answer = await trial(ask);
        process.stdout.write(`\n${TRIAL_ANSWER}${JSON.stringify(answer)}\n`);
      }
    } finally {
      busy = false;
      process.stdin.ref();
      process.stdin.resume();
    }
  };
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) await readLine(line);
  process.stdout.write("", () => process.exit(0));
} else {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const ask = JSON.parse(Buffer.concat(chunks).toString("utf8")) as TrialAsk | ProveAsk | DeclareAsk;
  if ("prove" in ask) {
    const { guardConnections } = await import("./conformance-acquirers.js");
    const { proveInChild } = await import("./conformance.js");
    guardConnections();
    const emit = (event: ProofEvent) => process.stdout.write(`${JSON.stringify(event)}\n`);
    await proveInChild(ask, emit);
    process.stdout.write("", () => process.exit(0));
  } else if ("declare" in ask) {
    const { guardConnections } = await import("./conformance-acquirers.js");
    guardConnections();
    process.stdout.write(IMPORTING);
    const answer = await declaredInChild(ask);
    process.stdout.write(JSON.stringify(answer), () => process.exit(0));
  } else {
    if (ask.guarded === true) (await import("./conformance-acquirers.js")).guardConnections();
    process.stdout.write(IMPORTING);
    const answer = await trial(ask);
    process.stdout.write(JSON.stringify(answer), () => process.exit(0));
  }
}
