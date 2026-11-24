import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonical, homeSecrets, type Json, type JsonObject } from "@lifestreamprotocol/core";
import { artifact, openTestHome, poll, type PollRecord, type TestHome } from "../../test/drive.js";
import { Refused } from "../../shared/refused.js";
import { byBytes } from "../../shared/memory.js";
import { NeedsYou, type Secrets } from "../../seams.js";
import { branchesOf, COMMENTS, githubApiAcquirer, REPO, type GithubApiSettings, type GithubApiState, type RepoEntry } from "./acquirer.js";
import { githubApi } from "./reader.js";
import { fakeGithub, type FakeGithub } from "./test/fake.js";

const LOGIN = "person-a";
const OTHER = "person-b";
const SOURCE = `github:${LOGIN}:cloud`;
const TOKEN = "github_pat_synthetic_0001";
const T0 = Date.UTC(2026, 8, 7, 4, 0, 0);
const MINUTE = 60_000;
const SETTINGS: GithubApiSettings = { login: LOGIN, token: "github" };

function secretStore(home: TestHome): Secrets {
  writeFileSync(join(home.dir, "github"), `${TOKEN}\n`, { mode: 0o600 });
  return homeSecrets(home.dir, { env: {} });
}

function world(github: FakeGithub) {
  const one = github.repo("person-a/repo-one");
  const two = github.repo("person-a/repo-two", "trunk");
  github.repo("person-a/empty");
  const own: string[] = [];
  own.push(github.commit(one, "main", LOGIN));
  github.commit(one, "main", OTHER);
  own.push(github.commit(one, "main", LOGIN));
  const base = github.head(one, "main");
  own.push(github.commit(one, "feature", LOGIN, { from: base }));
  github.commit(one, "feature", null);
  own.push(github.commit(one, "spare", LOGIN, { from: base }));
  for (let n = 0; n < 5; n++) own.push(github.commit(two, "trunk", LOGIN));
  github.commit(two, "trunk", OTHER);
  const issue = github.issue(one, LOGIN);
  const theirs = github.issue(one, OTHER);
  const pr = github.issue(one, LOGIN, true);
  const theirPr = github.issue(two, OTHER, true);
  own.push(issue.node_id, pr.node_id);
  own.push(github.note(one, theirs.number, LOGIN));
  github.note(one, issue.number, OTHER);
  github.note(one, pr.number, OTHER, "review");
  own.push(github.note(two, theirPr.number, LOGIN, "review"));
  own.push(github.note(two, theirPr.number, LOGIN, "review-comment"));
  own.push(github.note(one, issue.number, LOGIN));
  return { one, two, issue, theirs, pr, theirPr, own: own.sort() };
}

const held = (record: PollRecord, part: string): Record<string, Json> =>
  Object.fromEntries([...(record.memory?.get(part) ?? [])].sort(([a], [b]) => byBytes(a, b)).map(([key, value]) => [key, JSON.parse(value) as Json]));
const repos = (record: PollRecord): Record<string, RepoEntry> => held(record, REPO) as Record<string, RepoEntry>;
const remembered = (record: PollRecord): Record<string, Record<string, Json>> => Object.fromEntries([...(record.memory?.keys() ?? [])].map((part) => [part, held(record, part)]));

async function untilWhole(home: TestHome, acquirer: ReturnType<typeof githubApiAcquirer>, record: PollRecord, secrets: Secrets, clock: { at: number }, step = MINUTE): Promise<Record<string, RepoEntry>[]> {
  const states: Record<string, RepoEntry>[] = [];
  for (let polls = 0; polls < 100; polls++) {
    if (record.state !== null && record.next?.more === undefined && record.next?.backoff_ms === undefined) return states;
    if (record.next?.backoff_ms !== undefined) clock.at = Math.max(clock.at, record.next.backoff_ms);
    await poll(home, acquirer, record, secrets, clock.at);
    states.push(repos(record));
    clock.at += step;
  }
  throw new Error("the backfill never ended");
}

async function landAll(home: TestHome, record: PollRecord, from = 0): Promise<void> {
  for (const delivery of record.deliveries.slice(from)) await home.land(githubApi, delivery);
}

const keysOf = (home: TestHome): string[] => home.heads(SOURCE).map((head) => head.key).sort();
const manifestOf = (home: TestHome, record: PollRecord, index: number): JsonObject =>
  JSON.parse(home.blobs.text(record.deliveries[index]!.files.find((file) => file.path === "pull.json")!.blob)) as JsonObject;

describe("github-api acquirer: each of these is impossible", () => {
  it("a backfill that stops at its bound loses an item, or a poll after it costs more than what changed", async () => {
    const home = openTestHome();
    const github = fakeGithub(LOGIN, TOKEN);
    const made = world(github);
    const secrets = secretStore(home);
    const clock = { at: T0 };
    const built = githubApiAcquirer({ ...SETTINGS, per_poll: 8 }, { fetch: github.fetch, now: () => clock.at });
    const said: (true | undefined)[] = [];
    const acquirer = { ...built, fetch: async (...args: Parameters<typeof built.fetch>) => { const got = await built.fetch(...args); said.push(got.more); return got; } };
    const record: PollRecord = { state: null, deliveries: [] };
    const states = await untilWhole(home, acquirer, record, secrets, clock);
    expect(record.deliveries.length).toBeGreaterThan(4);
    expect(said).toContain(true);
    expect(said.at(-1)).toBeUndefined();
    expect(built.page).toBeUndefined();
    expect(states.some((state) => Object.values(state).some((repo) => repo.reading !== undefined))).toBe(true);
    for (const [index] of record.deliveries.entries()) expect(manifestOf(home, record, index).requests).toBeLessThanOrEqual(8);
    await landAll(home, record);
    expect(keysOf(home)).toEqual(made.own);
    expect(home.heads(SOURCE).every((head) => !head.gone)).toBe(true);

    const before = github.requests.length;
    clock.at += 5 * MINUTE;
    await poll(home, acquirer, record, secrets, clock.at);
    const idle = github.requests.slice(before);
    const at = encodeURIComponent((record.state as unknown as GithubApiState).issues!);
    expect(idle).toEqual([
      "/user",
      `/issues?filter=all&state=all&sort=updated&direction=asc&per_page=100&since=${at}`,
      `/repos/person-a/repo-one/issues/comments?sort=updated&direction=asc&per_page=100&since=${at}`,
      "/user/repos?affiliation=owner,collaborator,organization_member&sort=full_name&per_page=100",
      "/user/repos?affiliation=owner%2Ccollaborator%2Corganization_member&sort=full_name&per_page=100&page=2",
    ]);

    const mainBefore = github.head(made.one, "main");
    const pushed = github.commit(made.one, "main", LOGIN);
    const old = github.requests.length;
    clock.at += 5 * MINUTE;
    await poll(home, acquirer, record, secrets, clock.at);
    expect(github.requests.slice(old).filter((path) => path.startsWith("/repos/") && !path.includes("/comments"))).toEqual([
      "/repos/person-a/repo-one/branches?per_page=100",
      "/repos/person-a/repo-one/branches?per_page=100&page=2",
      `/repos/person-a/repo-one/compare/${mainBefore}...${pushed}?per_page=100`,
    ]);
    await landAll(home, record, record.deliveries.length - 1);
    expect(keysOf(home)).toEqual([...made.own, pushed].sort());
    artifact(home.dir, "polls.json", { requests: github.requests, state: record.state, memory: remembered(record), heads: home.heads(SOURCE) });
  });

  it("a rate limit fails the poll, or the poll after it loses its place", async () => {
    const home = openTestHome();
    const github = fakeGithub(LOGIN, TOKEN);
    const made = world(github);
    const secrets = secretStore(home);
    const reset = T0 / 1000 + 3600;
    github.limit.reset = reset;
    github.limit.remaining = 20;
    const clock = { at: T0 };
    const acquirer = githubApiAcquirer({ ...SETTINGS, reserve: 15 }, { fetch: github.fetch, now: () => clock.at });
    const record: PollRecord = { state: null, deliveries: [] };
    await poll(home, acquirer, record, secrets, clock.at);
    expect(github.requests).toHaveLength(5);
    expect(manifestOf(home, record, 0).stopped).toEqual({ reason: "rate-limit", resume_at: new Date(reset * 1000).toISOString() });
    expect(record.next).toEqual({ backoff_ms: reset * 1000 });

    clock.at = reset * 1000;
    github.limit.remaining = 4;
    github.limit.reset = reset + 3600;
    github.limit.spentElsewhere = true;
    await poll(home, acquirer, record, secrets, clock.at);
    expect(manifestOf(home, record, 1).stopped).toEqual({ reason: "rate-limit", resume_at: new Date((reset + 3600) * 1000).toISOString() });
    expect(manifestOf(home, record, 1).requests).toBe(5);

    expect(record.next).toEqual({ backoff_ms: (reset + 3600) * 1000 });
    github.limit.remaining = Number.POSITIVE_INFINITY;
    await untilWhole(home, acquirer, record, secrets, clock);
    await landAll(home, record);
    expect(keysOf(home)).toEqual(made.own);
    artifact(home.dir, "polls.json", { requests: github.requests, state: record.state, memory: remembered(record), heads: home.heads(SOURCE) });
  });

  it("a force-push or a deleted branch deletes a landed commit, or a late push of an old commit is missed", async () => {
    const home = openTestHome();
    const github = fakeGithub(LOGIN, TOKEN);
    const made = world(github);
    const secrets = secretStore(home);
    const clock = { at: T0 };
    const acquirer = githubApiAcquirer(SETTINGS, { fetch: github.fetch, now: () => clock.at });
    const record: PollRecord = { state: null, deliveries: [] };
    await untilWhole(home, acquirer, record, secrets, clock);
    await landAll(home, record);
    const landed = record.deliveries.length;

    const featureOld = github.head(made.one, "feature");
    const rewritten = github.commit(made.one, "feature", LOGIN, { from: github.head(made.one, "main") });
    github.deleteBranch(made.one, "spare");
    const old = github.commit(made.two, "local", LOGIN, { date: "2025-06-01T09:00:00Z", from: github.head(made.two, "trunk"), push: false });
    const merge = github.commit(made.two, "trunk", LOGIN, { merge: old });
    clock.at += 5 * MINUTE;
    await poll(home, acquirer, record, secrets, clock.at);
    await landAll(home, record, landed);

    const heads = home.heads(SOURCE);
    expect(heads.filter((head) => head.gone)).toEqual([]);
    expect(keysOf(home)).toEqual([...made.own, rewritten, old, merge].sort());
    expect(github.requests).toContain(`/repos/person-a/repo-one/compare/${featureOld}...${rewritten}?per_page=100`);
    expect(Object.keys(held(record, branchesOf("500")))).toEqual(["feature", "main"]);
    expect(heads.find((head) => head.key === old)!.start_ms).toBe(Date.parse("2025-06-01T09:00:00Z"));
    artifact(home.dir, "polls.json", { requests: github.requests, state: record.state, memory: remembered(record), heads });
  });

  it("an edit to the person's comment, or a review on someone else's pull request, is missed", async () => {
    const home = openTestHome();
    const github = fakeGithub(LOGIN, TOKEN);
    const made = world(github);
    const secrets = secretStore(home);
    const clock = { at: T0 };
    const acquirer = githubApiAcquirer(SETTINGS, { fetch: github.fetch, now: () => clock.at });
    const record: PollRecord = { state: null, deliveries: [] };
    await untilWhole(home, acquirer, record, secrets, clock);
    await landAll(home, record);
    const landed = record.deliveries.length;

    const comment = made.own.find((key) => key.startsWith("IC_"))!;
    github.edit(comment, "synthetic comment, edited");
    const reviewed = github.note(made.two, made.theirPr.number, LOGIN, "review");
    clock.at += 5 * MINUTE;
    await poll(home, acquirer, record, secrets, clock.at);
    await landAll(home, record, landed);
    expect(keysOf(home)).toEqual([...made.own, reviewed].sort());
    expect(JSON.stringify(home.heads(SOURCE).find((head) => head.key === comment)!.content)).toContain("edited");
    artifact(home.dir, "polls.json", { requests: github.requests, state: record.state, memory: remembered(record), heads: home.heads(SOURCE) });
  });

  it("a repository's first comment list reaches before the start, or a start moved earlier never reads the comments it left out", async () => {
    const home = openTestHome();
    const github = fakeGithub(LOGIN, TOKEN);
    const one = github.repo("person-a/repo-one");
    const issue = github.issue(one, LOGIN);
    const old = github.note(one, issue.number, LOGIN);
    const start = Date.UTC(2026, 0, 1, 0, 2, 30);
    const recent = github.note(one, issue.number, LOGIN);
    const secrets = secretStore(home);
    const clock = { at: T0 };
    const acquirer = githubApiAcquirer(SETTINGS, { fetch: github.fetch, now: () => clock.at });
    const record: PollRecord = { state: null, deliveries: [] };
    await poll(home, acquirer, record, secrets, clock.at, "fetch", start);
    expect(github.requests).toContain("/repos/person-a/repo-one/issues/comments?sort=updated&direction=asc&per_page=100&since=2026-01-01T00%3A02%3A30Z");
    await landAll(home, record);
    expect(keysOf(home)).toEqual([issue.node_id, recent].sort());
    const landed = record.deliveries.length;
    clock.at += 5 * MINUTE;
    await poll(home, acquirer, record, secrets, clock.at, "fetch", null);
    await landAll(home, record, landed);
    expect(keysOf(home)).toEqual([issue.node_id, old, recent].sort());
    artifact(home.dir, "polls.json", { requests: github.requests, state: record.state, memory: remembered(record), heads: home.heads(SOURCE) });
  });

  it("more changes in one second than a page holds stall a list", async () => {
    const home = openTestHome();
    const github = fakeGithub(LOGIN, TOKEN);
    const repo = github.repo("person-a/repo-one");
    github.freeze();
    const own = [github.issue(repo, LOGIN), github.issue(repo, LOGIN), github.issue(repo, LOGIN)].map((issue) => issue.node_id);
    const clock = { at: T0 };
    const acquirer = githubApiAcquirer(SETTINGS, { fetch: github.fetch, now: () => clock.at });
    const record: PollRecord = { state: null, deliveries: [] };
    await untilWhole(home, acquirer, record, secretStore(home), clock);
    await landAll(home, record);
    expect(keysOf(home)).toEqual(own.sort());
    artifact(home.dir, "polls.json", { requests: github.requests, state: record.state, memory: remembered(record), heads: home.heads(SOURCE) });
  });

  it("a branch that moves while another's comparison was cut short sends that comparison back to its first page", async () => {
    const home = openTestHome();
    const github = fakeGithub(LOGIN, TOKEN);
    const repo = github.repo("person-a/repo-one");
    const own = [github.commit(repo, "main", LOGIN)];
    const base = github.head(repo, "main");
    own.push(github.commit(repo, "alpha", LOGIN, { from: base }), github.commit(repo, "zeta", LOGIN, { from: base }));
    const secrets = secretStore(home);
    const clock = { at: T0 };
    const acquirer = githubApiAcquirer({ ...SETTINGS, per_poll: 8 }, { fetch: github.fetch, now: () => clock.at });
    const record: PollRecord = { state: null, deliveries: [] };
    await untilWhole(home, acquirer, record, secrets, clock);
    const id = Object.keys(repos(record))[0]!;
    const sealedAt = repos(record)[id]!.pushed_at;

    const zetaOld = github.head(repo, "zeta");
    for (let n = 0; n < 9; n++) own.push(github.commit(repo, "zeta", LOGIN));
    const zetaNew = github.head(repo, "zeta");
    const compare = `/repos/person-a/repo-one/compare/${zetaOld}...${zetaNew}?per_page=100`;
    clock.at += 5 * MINUTE;
    await poll(home, acquirer, record, secrets, clock.at);
    const cut = repos(record)[id]!;
    expect(manifestOf(home, record, record.deliveries.length - 1).stopped).toEqual({ reason: "budget" });
    expect(cut.reading).toMatchObject({ branch: "zeta", head: zetaNew, what: "compare" });
    expect(cut.pushed_at).toBe(sealedAt);

    own.push(github.commit(repo, "alpha", LOGIN));
    const before = github.requests.length;
    clock.at += 5 * MINUTE;
    await untilWhole(home, acquirer, record, secrets, clock);
    const after = github.requests.slice(before);
    expect(after.filter((path) => path.startsWith(compare))).toEqual([`${compare}&page=4`, `${compare}&page=5`]);
    expect(repos(record)[id]!.reading).toBeUndefined();
    expect(held(record, branchesOf(id))).toEqual({ alpha: github.head(repo, "alpha"), main: base, zeta: zetaNew });
    await landAll(home, record);
    expect(keysOf(home)).toEqual(own.sort());
    artifact(home.dir, "polls.json", { requests: github.requests, state: record.state, memory: remembered(record), heads: home.heads(SOURCE) });
  });

  it("one repository GitHub refuses the token fails every poll, or is never read once it is let in", async () => {
    const home = openTestHome();
    const github = fakeGithub(LOGIN, TOKEN);
    const made = world(github);
    const gated = github.repo("person-a/gated");
    const gatedCommit = github.commit(gated, "main", LOGIN);
    github.refuse(gated, 403);
    const secrets = secretStore(home);
    const clock = { at: T0 };
    const acquirer = githubApiAcquirer(SETTINGS, { fetch: github.fetch, now: () => clock.at });
    const record: PollRecord = { state: null, deliveries: [] };
    await untilWhole(home, acquirer, record, secrets, clock);
    await landAll(home, record);
    expect(keysOf(home)).toEqual(made.own);
    expect(record.deliveries.at(-1)!.facts.skipped).toEqual(["person-a/gated"]);
    const gatedId = Object.keys(repos(record)).find((id) => repos(record)[id]!.full_name === gated)!;
    expect(repos(record)[gatedId]!.pushed_at).toBeNull();

    github.refuse(gated, 451);
    clock.at += 5 * MINUTE;
    await poll(home, acquirer, record, secrets, clock.at);
    expect(record.deliveries.at(-1)!.facts.skipped).toEqual(["person-a/gated"]);
    expect(github.requests.filter((path) => path === "/repos/person-a/gated/branches?per_page=100").length).toBeGreaterThanOrEqual(2);

    github.refuse(gated, null);
    const landed = record.deliveries.length;
    clock.at += 5 * MINUTE;
    await poll(home, acquirer, record, secrets, clock.at);
    expect(record.deliveries.at(-1)!.facts.skipped).toBeUndefined();
    await landAll(home, record, landed - 1);
    expect(keysOf(home)).toEqual([...made.own, gatedCommit].sort());
    artifact(home.dir, "polls.json", { requests: github.requests, state: record.state, memory: remembered(record), heads: home.heads(SOURCE) });
  });

  it("a revoked token fails the poll, or is anything but a sign-in the person is asked for again", async () => {
    const home = openTestHome();
    const github = fakeGithub(LOGIN, TOKEN);
    world(github);
    writeFileSync(join(home.dir, "github"), "github_pat_revoked_0001\n", { mode: 0o600 });
    const acquirer = githubApiAcquirer(SETTINGS, { fetch: github.fetch, now: () => T0 });
    const record: PollRecord = { state: null, deliveries: [] };
    const error = await poll(home, acquirer, record, homeSecrets(home.dir, { env: {} }), T0).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NeedsYou);
    expect((error as NeedsYou).reason).toBe("signed-out");
    expect(github.requests).toEqual(["/user"]);
    expect(record.deliveries).toEqual([]);
  });

  it("another account's token lands anything under this source", async () => {
    const home = openTestHome();
    const github = fakeGithub(LOGIN, TOKEN);
    world(github);
    github.actAs(OTHER);
    const acquirer = githubApiAcquirer(SETTINGS, { fetch: github.fetch, now: () => T0 });
    const record: PollRecord = { state: null, deliveries: [] };
    const error = await poll(home, acquirer, record, secretStore(home), T0).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Refused);
    expect(String(error)).toMatch(/the token belongs to "person-b", not "person-a"/u);
    expect(github.requests).toEqual(["/user"]);
    expect(record.deliveries).toEqual([]);
  });
});

describe("github-api's cursor and memory", () => {
  it("grows the cursor with history, fetches what it has after it, or writes memory on a call that found nothing new (N and 4N repositories, one of many branches)", async () => {
    const history = async (count: number, branches: number) => {
      const home = openTestHome();
      const github = fakeGithub(LOGIN, TOKEN, { page: 100 });
      const names = Array.from({ length: count }, (_, n) => github.repo(`person-a/repo-${String(n).padStart(4, "0")}`));
      for (const name of names) github.commit(name, "main", LOGIN);
      const head = github.head(names[0]!, "main");
      for (let n = 0; n < branches; n++) github.push(names[0]!, `branch-${String(n).padStart(5, "0")}`, head);
      for (const name of names.filter((_, n) => n % 10 === 0)) github.note(name, github.issue(name, LOGIN).number, OTHER);
      const clock = { at: T0 };
      const secrets = secretStore(home);
      const acquirer = githubApiAcquirer({ ...SETTINGS, per_poll: 10_000 }, { fetch: github.fetch, now: () => clock.at });
      const record: PollRecord = { state: null, deliveries: [] };
      await poll(home, acquirer, record, secrets, clock.at);
      expect(record.next).toEqual({});
      const cursor = Buffer.byteLength(canonical(record.state!));
      expect([Object.keys(repos(record)).length, Object.keys(held(record, branchesOf("500"))).length, Object.keys(held(record, COMMENTS)).length]).toEqual([count, branches + 1, count / 10]);
      clock.at += 5 * MINUTE;
      const from = github.requests.length;
      await poll(home, acquirer, record, secrets, clock.at);
      expect(github.requests.slice(from).filter((path) => /\/(branches|compare|commits)\b/u.test(path))).toEqual([]);
      expect(record.changes).toEqual({ cleared: [], entries: [] });
      return { count, branches, cursor, requests: github.requests.length };
    };
    const n = await history(100, 4_000);
    const n4 = await history(400, 16_000);
    expect(Math.abs(n4.cursor - n.cursor)).toBeLessThanOrEqual(64);
    expect(Math.max(n.cursor, n4.cursor)).toBeLessThan(16_384);
    artifact(openTestHome().dir, "bounded.json", { n, n4 });
  });

  it("a repository the token no longer lists keeps its entry or its branches", async () => {
    const home = openTestHome();
    const github = fakeGithub(LOGIN, TOKEN);
    const made = world(github);
    const secrets = secretStore(home);
    const clock = { at: T0 };
    const acquirer = githubApiAcquirer(SETTINGS, { fetch: github.fetch, now: () => clock.at });
    const record: PollRecord = { state: null, deliveries: [] };
    await untilWhole(home, acquirer, record, secrets, clock);
    const one = Object.keys(repos(record)).find((id) => repos(record)[id]!.full_name === made.one)!;
    expect(Object.keys(held(record, branchesOf(one)))).toEqual(["feature", "main", "spare"]);
    github.hide(made.one);
    clock.at += 5 * MINUTE;
    await poll(home, acquirer, record, secrets, clock.at);
    expect([repos(record)[one], held(record, branchesOf(one)), held(record, COMMENTS)[made.one]]).toEqual([undefined, {}, expect.any(Object)]);
    expect(record.changes!.cleared).toEqual([branchesOf(one)]);
    artifact(home.dir, "polls.json", { requests: github.requests, state: record.state, memory: remembered(record) });
  });
});
