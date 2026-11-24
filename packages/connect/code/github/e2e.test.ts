import { describe, expect, it } from "vitest";
import { artifact, collect, deliver, openTestHome } from "../../test/drive.js";
import { Refused } from "../../shared/refused.js";
import { line } from "./adapter.js";
import { githubApi } from "./reader.js";
import { commit, inline, issue, LOGIN, note, OTHER, pull, review, SOURCE, user } from "./test/fixtures.js";

const SHA_A = "1".repeat(40);
const SHA_B = "2".repeat(40);
const SHA_C = "3".repeat(40);
const SHA_D = "4".repeat(40);
const T1 = Date.UTC(2026, 8, 10, 8, 0, 0);
const T2 = Date.UTC(2026, 8, 11, 8, 0, 0);

function firstPull(): Record<string, Buffer> {
  return pull([
    { what: "user", body: user(LOGIN) },
    { what: "issues", body: [issue("I_fake1", LOGIN, "2026-09-01T10:00:00Z"), issue("I_fake2", OTHER, "2026-09-01T11:00:00Z"), issue("PR_fake3", LOGIN, "2026-09-02T09:30:00Z", { pr: true, number: 3, title: "synthetic pull request" })] },
    { what: "issue-comments", body: [note("IC_fake1", LOGIN, "2026-09-03T12:00:00Z"), note("IC_fake2", OTHER, "2026-09-03T12:05:00Z")] },
    { what: "review-comments", body: [inline("PRRC_fake1", LOGIN, "2026-09-04T08:00:00Z", "synthetic inline comment")] },
    { what: "reviews", body: [review("PRR_fake1", LOGIN, "2026-09-04T08:01:00Z"), review("PRR_fake2", LOGIN, null), review("PRR_fake3", OTHER, "2026-09-04T09:00:00Z")] },
    { what: "repos", body: [{ id: 501, full_name: "person-a/repo-one", default_branch: "main", pushed_at: "2026-09-05T00:00:00Z" }] },
    { what: "branches", body: [{ name: "main", commit: { sha: SHA_C } }] },
    { what: "commits", body: [commit(SHA_A, LOGIN, "2026-09-05T07:00:00Z"), commit(SHA_B, OTHER, "2026-09-05T07:30:00Z")] },
    { what: "compare", body: { status: "diverged", ahead_by: 2, behind_by: 1, commits: [commit(SHA_C, LOGIN, "2026-09-05T08:00:00Z"), commit(SHA_D, null, "2026-09-05T08:10:00Z")], files: [{ filename: "synthetic.txt", patch: "@@ -1 +1 @@" }] } },
  ]);
}

const EXPECTED = [
  ["comment", "IC_fake1", Date.parse("2026-09-03T12:00:00Z")],
  ["comment", "PRRC_fake1", Date.parse("2026-09-04T08:00:00Z")],
  ["commit", SHA_A, Date.parse("2026-09-05T07:00:00Z")],
  ["commit", SHA_C, Date.parse("2026-09-05T08:00:00Z")],
  ["issue", "I_fake1", Date.parse("2026-09-01T10:00:00Z")],
  ["pr", "PR_fake3", Date.parse("2026-09-02T09:30:00Z")],
  ["review", "PRR_fake1", Date.parse("2026-09-04T08:01:00Z")],
  ["review", "PRR_fake2", null],
];

describe("github connector: each of these is impossible", () => {
  it("a pull lands what another person wrote, or misses what the person wrote", async () => {
    const home = openTestHome();
    const landed = await home.land(githubApi, deliver(home, SOURCE, firstPull(), {}, T1));
    expect(landed).toMatchObject({ new: 8, refused: 0, duplicated: 0, gone: 0 });
    const heads = home.heads(SOURCE);
    expect(heads.map((head) => [head.kind, head.key, head.start_ms])).toEqual(EXPECTED);
    const own = heads.find((head) => head.key === "I_fake1")!.content as { type: string; content: { repository: unknown; title: string } };
    expect(own.type).toBe("github.issue");
    expect(own.content.repository).toEqual({ id: 501, node_id: "R_fake501", full_name: "person-a/repo-one" });
    expect(own.content.title).toBe("synthetic issue");
    const types = Object.fromEntries(heads.map((head) => [head.key, (head.content as { type: string }).type]));
    expect(types).toMatchObject({ IC_fake1: "github.issue-comment", PRRC_fake1: "github.review-comment", [SHA_A]: "github.commit", PR_fake3: "github.pr", PRR_fake1: "github.review" });
    artifact(home.dir, "heads.json", { landed, heads });
  });

  it("a record the person made gives no day line, or one that misses what they did, where, or its page", async () => {
    const home = openTestHome();
    await home.land(githubApi, deliver(home, SOURCE, firstPull(), {}, T1));
    const lines = Object.fromEntries(home.heads(SOURCE).map((head) => [head.key, line.line({ version: { kind: head.kind, key: head.key, content: head.content } } as never)]));
    expect(lines).toEqual({
      IC_fake1: { text: "Commented on person-a/repo-one#1: synthetic comment", link: "https://github.com/person-a/repo-one/issues/1#issuecomment-70001" },
      PRRC_fake1: { text: "Commented on src/synthetic.ts in pull request person-a/repo-one#3: synthetic inline comment", link: "https://github.com/person-a/repo-one/pull/3#discussion_r71001" },
      [SHA_A]: { text: "Committed “synthetic commit 1111” to person-a/repo-one", link: `https://github.com/person-a/repo-one/commit/${SHA_A}` },
      [SHA_C]: { text: "Committed “synthetic commit 3333” to person-a/repo-one", link: `https://github.com/person-a/repo-one/commit/${SHA_C}` },
      I_fake1: { text: "Opened issue person-a/repo-one#1 “synthetic issue”: synthetic body", link: "https://github.com/person-a/repo-one/issues/1" },
      PR_fake3: { text: "Opened pull request person-a/repo-one#3 “synthetic pull request”: synthetic body", link: "https://github.com/person-a/repo-one/pull/3" },
      PRR_fake1: { text: "Approved pull request person-a/repo-one#3: synthetic review", link: "https://github.com/person-a/repo-one/pull/3#pullrequestreview-80001" },
      PRR_fake2: { text: "Started a review of pull request person-a/repo-one#3: synthetic review", link: "https://github.com/person-a/repo-one/pull/3#pullrequestreview-80001" },
    });
    const said = (type: string, content: object) => line.line({ version: { kind: "comment", key: "k", content: { type, content } } } as never)?.text;
    const message = "Fix the synthetic parser\n\nIt read\nevery line twice.";
    expect(said("github.commit", { ...commit(SHA_A, LOGIN, "2026-09-05T07:00:00Z"), commit: { message } })).toBe("Committed “Fix the synthetic parser” to person-a/repo-one: It read every line twice.");
    expect(said("github.review", { ...review("PRR_fake5", LOGIN, "2026-09-05T08:00:00Z"), state: "CHANGES_REQUESTED", body: "" })).toBe("Asked for changes on pull request person-a/repo-one#3");
    expect(said("github.review", { ...review("PRR_fake6", LOGIN, "2026-09-05T08:00:00Z"), state: "COMMENTED" })).toBe("Reviewed pull request person-a/repo-one#3: synthetic review");
    const long = said("github.issue-comment", note("IC_fake3", LOGIN, "2026-09-03T12:00:00Z", "word ".repeat(100)))!;
    expect(long).toBe(`Commented on person-a/repo-one#1: ${"word ".repeat(56).trimEnd()}…`);
    expect(said("github.other", {})).toBeUndefined();
    artifact(home.dir, "lines.json", lines);
  });

  it("the same pull again writes anything new", async () => {
    const home = openTestHome();
    await home.land(githubApi, deliver(home, SOURCE, firstPull(), {}, T1));
    const again = await home.land(githubApi, deliver(home, SOURCE, firstPull(), {}, T2));
    expect(again).toMatchObject({ new: 0, changed: 0, restated: 8, gone: 0 });
    artifact(home.dir, "heads.json", { again, heads: home.heads(SOURCE) });
  });

  it("an edit does not move its head, a repository's counters move an issue's, or a missing item goes", async () => {
    const home = openTestHome();
    await home.land(githubApi, deliver(home, SOURCE, firstPull(), {}, T1));
    const second = pull([
      { what: "user", body: user(LOGIN) },
      { what: "issues", body: [issue("PR_fake3", LOGIN, "2026-09-02T09:30:00Z", { pr: true, number: 3, title: "synthetic pull request", open_issues: 9 })] },
      { what: "issue-comments", body: [note("IC_fake1", LOGIN, "2026-09-03T12:00:00Z", "synthetic comment, edited")] },
    ]);
    const landed = await home.land(githubApi, deliver(home, SOURCE, second, {}, T2));
    expect(landed).toMatchObject({ new: 0, changed: 1, restated: 1, gone: 0 });
    const heads = home.heads(SOURCE);
    expect(heads.map((head) => [head.kind, head.key, head.start_ms])).toEqual(EXPECTED);
    expect(heads.every((head) => !head.gone)).toBe(true);
    expect(JSON.stringify(heads.find((head) => head.key === "IC_fake1")!.content)).toContain("edited");
    artifact(home.dir, "heads.json", { landed, heads });
  });

  it("a page that does not match its manifest, or another account's token lands anything", async () => {
    const home = openTestHome();
    const tampered = firstPull();
    tampered["page-00002.json"] = Buffer.from("[]");
    await expect(collect(githubApi.read(deliver(home, SOURCE, tampered, {}, T1), home.blobs))).rejects.toThrow(/page-00002\.json does not match/u);
    const stranger = pull([{ what: "user", body: user(OTHER) }, { what: "issues", body: [issue("I_fake9", OTHER, "2026-09-01T10:00:00Z")] }]);
    const error = await collect(githubApi.read(deliver(home, SOURCE, stranger, {}, T1), home.blobs)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Refused);
    expect(String(error)).toMatch(/the token belongs to "person-b", not "person-a"/u);
    const elsewhere = pull([{ what: "user", body: user(LOGIN) }], { account: OTHER });
    await expect(collect(githubApi.read(deliver(home, SOURCE, elsewhere, {}, T1), home.blobs))).rejects.toThrow(/states account "person-b"/u);
    expect(home.heads(SOURCE)).toEqual([]);
  });

  it("a malformed item or page costs the items and pages after it, or its refusal does not name it", async () => {
    const home = openTestHome();
    const files = pull([
      { what: "user", body: user(LOGIN) },
      { what: "issues", body: [issue("I_fake1", LOGIN, "2026-09-01T10:00:00Z"), 7, issue("I_fake2", LOGIN, "2026-09-01T11:00:00Z")] },
      { what: "reviews", body: { message: "not a list" } },
      { what: "issue-comments", body: [note("IC_fake1", LOGIN, "2026-09-03T12:00:00Z")] },
    ]);
    const landed = await home.land(githubApi, deliver(home, SOURCE, files, {}, T1));
    expect(landed).toMatchObject({ new: 3, refused: 2 });
    expect(landed.refusals).toEqual([
      { kind: "file", key: "page-00002.json[1]", violations: [expect.stringMatching(/is not an object/u)] },
      { kind: "file", key: "page-00003.json", violations: [expect.stringMatching(/the reviews page is not an array/u)] },
    ]);
    expect(home.heads(SOURCE).map((head) => head.key)).toEqual(["IC_fake1", "I_fake1", "I_fake2"]);
    artifact(home.dir, "malformed.json", { landed, heads: home.heads(SOURCE) });
  });

  it("a pull a rate limit stopped before its first page fails, or lands anything", async () => {
    const home = openTestHome();
    const stopped = pull([], { stopped: { reason: "rate-limit", resume_at: "2026-09-10T09:00:00.000Z" } });
    const landed = await home.land(githubApi, deliver(home, SOURCE, stopped, {}, T1));
    expect(landed).toMatchObject({ new: 0, refused: 0 });
    expect(home.heads(SOURCE)).toEqual([]);
  });
});
