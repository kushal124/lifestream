import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { checkTests, type Break } from "./check-tests.js";

const roots: string[] = [];
const artifact: Record<string, Break[]> = {};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(() => {
  writeFileSync(join(tmpdir(), "check-tests.json"), `${JSON.stringify(artifact, null, 2)}\n`);
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "check-tests-"));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "add", "-A"]);
  return root;
}

function check(name: string, files: Record<string, string>): string[] {
  const breaks = checkTests(repo(files));
  artifact[name] = breaks;
  return breaks.map((entry) => `${entry.file}:${entry.line}: ${entry.what}`);
}

const lines = (...each: string[]) => `${each.join("\n")}\n`;

describe("timeouts", () => {
  it("names a timeout stated by an it, a describe, a hook, through each and skipIf, and as an option", () => {
    expect(check("timeouts", {
      "packages/a/a.e2e.test.ts": lines(
        'import { afterAll, describe, it } from "vitest";',
        "afterAll(() => undefined, 10_000);",
        'describe.skipIf(false)("a", () => {',
        '  it("one", async () => {',
        "    await Promise.resolve();",
        "  }, 300_000);",
        '  it.each([1])("two %s", () => undefined, 5_000);',
        '  it("three", { timeout: 60_000 }, () => undefined);',
        "  const SLOW = 60_000;",
        '  it("four", () => undefined, 5 * 60_000);',
        '  it("five", async () => undefined, SLOW);',
        "  const timeout = SLOW;",
        '  it("six", { timeout }, function () {});',
        "}, 1_000);",
      ),
    })).toEqual([
      "packages/a/a.e2e.test.ts:2: a timeout stated by hand (10_000): the config's one timeout ends a hung test",
      "packages/a/a.e2e.test.ts:3: a timeout stated by hand (1_000): the config's one timeout ends a hung test",
      "packages/a/a.e2e.test.ts:4: a timeout stated by hand (300_000): the config's one timeout ends a hung test",
      "packages/a/a.e2e.test.ts:7: a timeout stated by hand (5_000): the config's one timeout ends a hung test",
      "packages/a/a.e2e.test.ts:8: a timeout stated by hand (timeout: 60_000): the config's one timeout ends a hung test",
      "packages/a/a.e2e.test.ts:10: a timeout stated by hand (5 * 60_000): the config's one timeout ends a hung test",
      "packages/a/a.e2e.test.ts:11: a timeout stated by hand (SLOW): the config's one timeout ends a hung test",
      "packages/a/a.e2e.test.ts:13: a timeout stated by hand (timeout): the config's one timeout ends a hung test",
    ]);
  });

  it("passes a callback's delay, a test with no timeout, and a number that is a test's data", () => {
    expect(check("no timeouts", {
      "packages/a/a.e2e.test.ts": lines(
        'import { expect, it } from "vitest";',
        'it("waits on an event", async () => {',
        "  setTimeout(() => {",
        "    void 0;",
        "  }, 100);",
        "  expect([1, 2]).toEqual([1, 2]);",
        "});",
      ),
    })).toEqual([]);
  });
});

describe("sleeps", () => {
  it("finds an arrow callback used as a hand timeout", () => {
    expect(check("arrow-timeout", { "packages/a/a.e2e.test.ts": "setTimeout(() => resolve(null), 20_000);" })).toEqual([
      "packages/a/a.e2e.test.ts:1: a sleep of 20_000 ms: wait for an event that shows the point passed (or a paces: comment above it, where nothing is recorded)",
    ]);
  });

  it("names a sleep of 200 ms or more, unless a `paces:` comment stands over it; passes a poll's interval", () => {
    expect(check("sleeps", {
      "packages/a/a.e2e.test.ts": lines(
        'import { it } from "vitest";',
        "const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));",
        'it("sleeps", async () => {',
        "  await new Promise((resolve) => setTimeout(resolve, 1_500));",
        "  await sleep(500);",
        "  // A held lock leaves no mark a test could wait on: this paces three of its looks.",
        "  await sleep(800);",
        "  // paces: three looks of a held lock, which leaves no mark a test could wait on.",
        "  await new Promise((resolve) => setTimeout(resolve, 1_500));",
        "  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 50));",
        "});",
      ),
    })).toEqual([
      "packages/a/a.e2e.test.ts:4: a sleep of 1_500 ms: wait for an event that shows the point passed (or a paces: comment above it, where nothing is recorded)",
      "packages/a/a.e2e.test.ts:5: a sleep of 500 ms: wait for an event that shows the point passed (or a paces: comment above it, where nothing is recorded)",
      "packages/a/a.e2e.test.ts:7: a sleep of 800 ms: wait for an event that shows the point passed (or a paces: comment above it, where nothing is recorded)",
    ]);
  });

  it("names AbortSignal.timeout in a test", () => {
    expect(check("abort timeout", {
      "packages/a/test/drive.ts": "export const ask = () => fetch(\"http://127.0.0.1:1/\", { signal: AbortSignal.timeout(1_000) });\n",
    })).toEqual(["packages/a/test/drive.ts:1: AbortSignal.timeout: a time the machine sets; wait for the answer"]);
  });
});

describe("the Mac's own files", () => {
  it("names a line of testing/mac-only.txt that names no file, and passes comments, blank lines and files that exist", () => {
    expect(check("mac only", {
      "packages/a/b.e2e.test.ts": "export {};\n",
      "testing/mac-only.txt": lines("# packages/a/gone.e2e.test.ts a comment", "", "packages/a/b.e2e.test.ts the home lacks a thing", "  packages/a/gone.e2e.test.ts  it lacks another"),
    })).toEqual(["testing/mac-only.txt:4: packages/a/gone.e2e.test.ts is no file: take its line off, or name the file it became"]);
  });

  it("finds a quarantined Swift test in a target whose folder its Package.swift names, and names one that is gone", () => {
    expect(check("quarantine swift", {
      "faces/Package.swift": lines('    .testTarget(name: "FaceEngineTests", dependencies: ["face-engine"], path: "EngineTests"),'),
      "faces/EngineTests/PictureTests.swift": lines("final class PictureTests: XCTestCase {", "  func testAPoster() throws {}", "}"),
      "testing/quarantine.txt": lines("faces/FaceEngineTests/PictureTests/testAPoster  hung", "faces/FaceEngineTests/PictureTests/testGone  red"),
    })).toEqual(["testing/quarantine.txt:2: faces/FaceEngineTests/PictureTests/testGone is no test: take its line off, or name the test as it is now"]);
  });

  it("finds a quarantined Swift test of a package in a folder of a folder, as design/swift's", () => {
    expect(check("quarantine nested swift", {
      "design/swift/Tests/CockpitTests/AskTraceTests.swift": lines("final class AskTraceTests: XCTestCase {", "  func testA() {}", "}"),
      "testing/quarantine.txt": lines("design/swift/CockpitTests/AskTraceTests/testA  hung", "design/swift/CockpitTests/AskTraceTests/testGone  red"),
    })).toEqual(["testing/quarantine.txt:2: design/swift/CockpitTests/AskTraceTests/testGone is no test: take its line off, or name the test as it is now"]);
  });
});

describe("durations", () => {
  it("names the clock read in an expect, or a name set from the clock less a start", () => {
    expect(check("durations", {
      "packages/a/a.e2e.test.ts": lines(
        'import { expect, it } from "vitest";',
        "const after = { rows: [] as number[] };",
        'it("is quick", () => {',
        "  const started = Date.now();",
        "  expect(Date.now() - started).toBeLessThan(1_000);",
        "  const took = performance.now() - started;",
        "  expect(took).toBeLessThan(200);",
        "  expect(started).toBeGreaterThan(0);",
        "  const since = Date.now() - 3 * 86_400_000;",
        "  expect(since).toBeLessThan(started);",
        "  expect(after.rows.slice(0, 1)).toEqual([]);",
        "});",
      ),
      "dashboard/test/b.mjs": lines(
        "import assert from 'node:assert/strict';",
        "const began = Date.now();",
        "const waited = Date.now() - began;",
        "assert.ok(waited < 500);",
      ),
    })).toEqual([
      "dashboard/test/b.mjs:4: a duration in an assertion (waited): assert a count or a state the code records",
      "packages/a/a.e2e.test.ts:5: a duration in an assertion (Date.now() - started): assert a count or a state the code records",
      "packages/a/a.e2e.test.ts:7: a duration in an assertion (took): assert a count or a state the code records",
    ]);
  });

  it("passes a latency budget in a file that measures latency under load", () => {
    expect(check("latency budget", {
      "packages/home/home-full.e2e.test.ts": lines(
        'import { expect, it } from "vitest";',
        'it("p95", () => {',
        "  const began = Date.now();",
        "  expect(Date.now() - began).toBeLessThan(20_000);",
        "});",
      ),
    })).toEqual([]);
  });
});

describe("wait helpers", () => {
  it("names an until of a test's own, in any form, and passes each island's one helper and its callers", () => {
    const helper = "export async function until(what: string, ready: () => boolean) { while (!ready()) await Promise.resolve(what); }\n";
    expect(check("wait helpers", {
      "packages/a/a.e2e.test.ts": lines(
        'import { until } from "../home/test/harness-root.js";',
        'await until("the row", () => true);',
        "async function until2() {}",
        "{ const until = async () => undefined; }",
      ),
      "packages/b/test/drive.ts": "export async function until(ready: () => boolean) { while (!ready()) await Promise.resolve(); }\n",
      "packages/model/b.e2e.test.ts": "let until = (ready: () => boolean) => ready();\n",
      "dashboard/test/c.mjs": "const until = async ready => ready();\n",
      "packages/home/test/harness-root.ts": helper,
      "packages/model/model.e2e.test.ts": helper,
      "extension/test/until.ts": helper,
      "mcp/test/until.mjs": "export async function until(what, check) { return check(); }\n",
      "dashboard/test/until.mjs": "export async function until(what, ready) { return ready(); }\n",
    })).toEqual([
      "dashboard/test/c.mjs:1: a wait helper of its own: use dashboard/test/until.mjs, the suite's one wait, which names what it waits for and gives up in 30 s",
      "packages/a/a.e2e.test.ts:4: a wait helper of its own: use packages/home/test/harness-root.ts, the suite's one wait, which names what it waits for and gives up in 30 s",
      "packages/b/test/drive.ts:1: a wait helper of its own: use packages/home/test/harness-root.ts, the suite's one wait, which names what it waits for and gives up in 30 s",
      "packages/model/b.e2e.test.ts:1: a wait helper of its own: use packages/model/model.e2e.test.ts, the suite's one wait, which names what it waits for and gives up in 30 s",
    ]);
  });
});

describe("the phone's UI tests", () => {
  it("names a sleep, a swipe or drag and a wait with seconds outside the helpers; passes the helpers, a test run by hand, a sleep that paces, the one wait and a comment", () => {
    const ui = "ios-app/LifestreamCaptureUITests";
    const sleep = "a sleep: wait on what the app shows (`appears()`, `vanishes()`, `until`), or a paces: comment above it where nothing is recorded";
    const timed = "a wait with a time of its own: wait through UITestNavigation's `until(what)`, `appears(what)` or `vanishes(what)`, which give up in 30 s";
    const swipe = "a swipe or drag of its own: scroll with UITestNavigation's `bringIntoView` or `scrolledTo`, close a sheet with `swipeAway`, drag a gesture under test with `drag(to:)`";
    expect(check("swift", {
      [`${ui}/PlacesFlowUITests.swift`]: lines(
        "func testA() {",
        "    Thread.sleep(forTimeInterval: 0.25)",
        "    app.swipeUp()",
        "    start.press(forDuration: 0.05, thenDragTo: end)",
        "    // Never app.swipeDown() here: the helper knows where the page ends.",
        "    usleep(1_000)",
        "    RunLoop.current.run(until: Date().addingTimeInterval(0.7))",
        "    // paces: the playback behind the home screen; nothing is recorded to wait on.",
        "    RunLoop.current.run(until: Date().addingTimeInterval(2))",
        "    XCTAssertTrue(row.appears(within: 10), \"the row\")",
        "    XCTAssertTrue(sheet.vanishes(within:5))",
        "    XCTAssertTrue(waitUntil(5) { label.label == \"Pause\" })",
        "    XCTAssertEqual(XCTWaiter.wait(for: [shown], timeout: 10), .completed)",
        "    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 2.5))",
        "    row.appears(\"the row\")",
        "    until(\"playback pauses\") { label.label == \"Play\" }",
        "    // Never row.appears(within: 5): the one wait gives up in 30 s.",
        "    XCTAssertTrue(row.waitForExistence(timeout: waitLimit))",
        "    XCTAssertTrue(sheet.vanishes(",
        "        within: limit))",
        "}",
      ),
      [`${ui}/UITestNavigation.swift`]: lines(
        "func drag() {",
        "    from.press(forDuration: 0.05, thenDragTo: to)",
        "    sheet.swipeDown(velocity: .fast)",
        "    _ = holds(within: 2) { !close.exists }",
        "    return exists || waitForExistence(timeout: waitLimit)",
        "}",
      ),
      [`${ui}/SpeedUITests.swift`]: lines("for _ in 0..<5 { list.swipeUp(velocity: .fast) }", "XCTAssertTrue(waitUntil(5) { true })", "_ = screen.vanishes(within: 5)"),
    })).toEqual([
      `${ui}/PlacesFlowUITests.swift:2: ${sleep}`,
      `${ui}/PlacesFlowUITests.swift:3: ${swipe}`,
      `${ui}/PlacesFlowUITests.swift:4: ${swipe}`,
      `${ui}/PlacesFlowUITests.swift:6: ${sleep}`,
      `${ui}/PlacesFlowUITests.swift:7: ${sleep}`,
      `${ui}/PlacesFlowUITests.swift:10: ${timed}`,
      `${ui}/PlacesFlowUITests.swift:11: ${timed}`,
      `${ui}/PlacesFlowUITests.swift:12: ${timed}`,
      `${ui}/PlacesFlowUITests.swift:13: ${timed}`,
      `${ui}/PlacesFlowUITests.swift:14: ${timed}`,
      `${ui}/PlacesFlowUITests.swift:18: ${timed}`,
      `${ui}/PlacesFlowUITests.swift:19: ${timed}`,
    ]);
  });
});

describe("the phone's UI tests stay few and small", () => {
  const ui = "ios-app/LifestreamCaptureUITests";
  const tests = (name: string, count: number) => lines(
    `final class ${name}: XCTestCase {`,
    ...Array.from({ length: count }, (_, index) => `    func testJourney${index}() throws {}`),
    "}",
  );

  it("names a total over the budget, however the classes split it; passes a class of many tests under it and leaves out a held file, the helpers and the tests run by hand", () => {
    const files: Record<string, string> = {
      [`${ui}/AskFlowUITests.swift`]: tests("AskFlowUITests", 13),
      [`${ui}/SpeedUITests.swift`]: tests("SpeedUITests", 9),
      [`${ui}/UITestKit.swift`]: lines("// func testNothing() is no test here", "func testable() {}"),
      [`${ui}/PlacesFlowUITests.swift`]: lines("import XCTest", "", tests("PlacesFlowUITests", 13)),
    };
    for (let index = 0; index < 7; index++) files[`${ui}/Flow${index}UITests.swift`] = tests(`Flow${index}UITests`, 4);
    expect(check("ui total", files)).toEqual([
      `${ui}:0: 41 UI tests, more than 40: fold the journeys that are not independent, and leave a rule, its states and its words to a unit test`,
    ]);
    delete files[`${ui}/Flow6UITests.swift`];
    expect(check("ui total, one class of thirteen", files)).toEqual([]);
  });

  it("names a launch of a test's own; passes UITestKit's launch and relaunch, the helpers' own and a held file's", () => {
    const launch = "a launch of its own: launch through UITestKit's `launch` (or `relaunch`), dark, opened on its page with `open:`; SpringBoard is its `springboard`";
    const own = lines(
      "let app = XCUIApplication()",
      "app.launchArguments = [\"--ui-testing\", \"--ui-test-reset\"]",
      "app.launch()",
      "let board = XCUIApplication(bundleIdentifier: \"com.apple.springboard\")",
      "// Never app.launchArguments here.",
      "let app = launch(\"--ui-test-proof\", open: \"stream:location\", tab: \"settings\")",
      "app.relaunch(opens: .unwaited)",
      "springboard.buttons[\"Allow\"].tap()",
      "app.launch(",
      ")",
      "app .launch ( )",
      "app.relaunch(",
      "    opens: .unwaited)",
    );
    expect(check("ui launcher", {
      [`${ui}/NotesFlowUITests.swift`]: own,
      [`${ui}/AskFlowUITests.swift`]: own,
      [`${ui}/UITestKit.swift`]: own,
      [`${ui}/UITestNavigation.swift`]: own,
    })).toEqual([1, 2, 3, 4, 9, 11].map((line) => `${ui}/NotesFlowUITests.swift:${line}: ${launch}`));
  });

  it("names copy as a lookup, once a line, and a name bound to it; passes what a wait or an assertion says, an identifier, three words, an interpolation's words, another field's predicate argument and what the test typed", () => {
    const copy = (words: string) => `copy as a lookup ("${words}"): find the element by its accessibility identifier; when the words are the point, a unit test owns them`;
    const lookups = lines(
      "app.staticTexts[\"Lifestream is locked now\"].appears()",
      "app.staticTexts.matching(NSPredicate(format: \"label BEGINSWITH[c] 'Last talked to them'\")).firstMatch",
      "app.buttons.matching(NSPredicate(format: \"identifier BEGINSWITH %@ AND label == %@\", \"trip.day.\", \"Synthetic City by night\"))",
      "XCTAssertTrue(gym.label.contains(\"You're here right now\"), \"the phone sits at it, said in many words\")",
      "XCTAssertTrue(row.label.hasPrefix(\"You were here on \"))",
      "until(\"the head ends in the name\") { head.label.hasSuffix(\"at The Office today\") }",
      "XCTAssertEqual(position.label, \"Name this place, 1 of 3\", \"a drag on the map is no Skip\")",
      "XCTAssertEqual(",
      "    \"Same Apple ID as your Mac\",",
      "    account.label)",
      "XCTAssertTrue(said(app, \"Set it up on your Mac first\").exists)",
      "item(\"Reset to the default\").tap()",
      "position.label(becomes: \"Name this place, 2 of 3\")",
      "XCTAssertTrue(app.staticTexts[\"one two three four\"].label.contains(\"five six seven eight\"))",
      "until(\"the pan undone\") { center.value as? String == \"Where it was put\" }",
      "XCTAssertTrue(\"Where it was put\" != pause.label, \"never where it was put, whatever it says\")",
      "let locked = \"Lifestream is locked now\"",
      "app.staticTexts[locked].appears()",
      "XCTAssertEqual(position.label, locked)",
      "app.buttons.matching(NSPredicate(format: \"identifier == %@ AND label BEGINSWITH %@\", \"one two three four\", \"Where you were last\")).firstMatch",
    );
    const allowed = lines(
      "row.appears(\"the row of the place named, at last\")",
      "sheet.vanishes(\"the sheet goes when Done is pressed\")",
      "until(\"the count drawn on the page in front\") { count() == 3 }",
      "XCTAssertTrue(row.exists, \"a place visited once is folded away\")",
      "XCTAssertEqual(also.count, 2, \"C and the circle added to it\")",
      "app.descendants(matching: .any)[\"places.row.the-office\"].firstMatch.tap()",
      "XCTAssertEqual(invite.label, \"1 place to name\")",
      "XCTAssertTrue(row.label.contains(\"\\(first) \\(second) \\(third) \\(fourth)\"))",
      "let names = [\"one two three four\"]",
      "// app.staticTexts[\"a comment is never a lookup\"]",
      "app.buttons.matching(NSPredicate(format: \"label != '' AND identifier == %@\", \"a b c d e\")).firstMatch",
      "let note = \"a synthetic note typed here\"",
      "app.type(note, into: editor)",
      "XCTAssertEqual(editor.value as? String, note)",
      "body.typeText(\"Groceries and milk today\")",
      "body.typeText(\"\\nBread and butter too\")",
      "XCTAssertEqual(body.value as? String, \"Groceries and milk today\\nBread and butter too\")",
      "until(\"the note kept\") { body.value as? String == \"Groceries and milk today\" }",
    );
    expect(check("ui copy", {
      [`${ui}/PlacesFlowUITests.swift`]: lookups + allowed,
      [`${ui}/SearchFlowUITests.swift`]: lookups,
    })).toEqual([
      `${ui}/PlacesFlowUITests.swift:1: ${copy("Lifestream is locked now")}`,
      `${ui}/PlacesFlowUITests.swift:2: ${copy("Last talked to them")}`,
      `${ui}/PlacesFlowUITests.swift:3: ${copy("Synthetic City by night")}`,
      `${ui}/PlacesFlowUITests.swift:4: ${copy("You're here right now")}`,
      `${ui}/PlacesFlowUITests.swift:5: ${copy("You were here on ")}`,
      `${ui}/PlacesFlowUITests.swift:6: ${copy("at The Office today")}`,
      `${ui}/PlacesFlowUITests.swift:7: ${copy("Name this place, 1 of 3")}`,
      `${ui}/PlacesFlowUITests.swift:9: ${copy("Same Apple ID as your Mac")}`,
      `${ui}/PlacesFlowUITests.swift:11: ${copy("Set it up on your Mac first")}`,
      `${ui}/PlacesFlowUITests.swift:12: ${copy("Reset to the default")}`,
      `${ui}/PlacesFlowUITests.swift:13: ${copy("Name this place, 2 of 3")}`,
      `${ui}/PlacesFlowUITests.swift:14: ${copy("one two three four")}`,
      `${ui}/PlacesFlowUITests.swift:15: ${copy("Where it was put")}`,
      `${ui}/PlacesFlowUITests.swift:16: ${copy("Where it was put")}`,
      `${ui}/PlacesFlowUITests.swift:18: ${copy("Lifestream is locked now")}`,
      `${ui}/PlacesFlowUITests.swift:19: ${copy("Lifestream is locked now")}`,
      `${ui}/PlacesFlowUITests.swift:20: ${copy("Where you were last")}`,
    ]);
  });
});
