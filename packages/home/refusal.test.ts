import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DOOR_AWAY, NOT_NOW, notNowRefusal, STARTING, STARTING_SAID, UNWRITABLE, waitBody } from "./refusal.js";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const copies = (path: string): boolean => readFileSync(join(REPO, path), "utf8").includes(STARTING);

describe("a home starting", () => {
  it("is told by its kind by the Mac's Set up and the iPhone's pairing, which hold no copy of its words", () => {
    expect(copies("macos-app/Sources/Lifestream/Setup/SetupStart.swift")).toBe(false);
    expect(copies("ios-app/Sources/LifestreamCaptureCore/HomeStarting.swift")).toBe(false);
    expect(waitBody("starting", STARTING_SAID).wait).toBe("starting");
  });

  it("names the machine as the door's other words do", () => {
    for (const words of [STARTING, DOOR_AWAY, UNWRITABLE]) expect(words.startsWith("Lifestream")).toBe(true);
  });
});

describe("a not-now's kind", () => {
  it("is stated on each, a start with its title and line apart, a wait on the person with its own words, a request's own with none", () => {
    expect(waitBody("starting")).toEqual({ wait: "starting", title: "Lifestream is starting", line: null, acts: [] });
    expect(STARTING.startsWith(`${STARTING_SAID.title}: `)).toBe(true);
    expect(waitBody("needs", { title: "Lifestream's drive isn't connected", line: "Connect it and it starts again", acts: [] }))
      .toEqual({ wait: "needs", title: "Lifestream's drive isn't connected", line: "Connect it and it starts again", acts: [] });
    expect(waitBody("busy")).toEqual({ wait: "busy", title: null, line: null, acts: [] });
    expect(() => waitBody("needs")).toThrow(/states its words/u);
    const refusal = notNowRefusal("busy", "Your people are being prepared.", 5);
    expect([refusal.status, refusal.code, refusal.words, refusal.retryAfter, refusal.extra]).toEqual([503, NOT_NOW, "Your people are being prepared.", 5, waitBody("busy")]);
  });
});
