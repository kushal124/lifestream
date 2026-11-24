import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Fixture } from "../../../test/drive.js";
import type { Json, JsonObject } from "@lifestreamprotocol/core";
import { PULL_FORMAT, PULL_MANIFEST, type Page } from "../reader.js";

export const LOGIN = "person-a";
export const OTHER = "person-b";
export const SOURCE = `github:${LOGIN}:cloud`;
const API = "https://api.github.com";
const WEB = "https://github.com";
const REPO = "person-a/repo-one";

export const user = (login: string): JsonObject => ({ login, id: 1000 + login.length, node_id: `U_fake${login}`, type: "User", site_admin: false });

export function commit(sha: string, author: string | null, date: string): JsonObject {
  return {
    sha,
    node_id: `C_fake_${sha.slice(0, 8)}`,
    commit: {
      author: { name: "Synthetic author", email: "person-a@example.com", date },
      committer: { name: "Synthetic committer", email: "committer@example.com", date },
      message: `synthetic commit ${sha.slice(0, 4)}`,
      tree: { sha: "f".repeat(40) },
      comment_count: 0,
    },
    url: `${API}/repos/${REPO}/commits/${sha}`,
    html_url: `${WEB}/${REPO}/commit/${sha}`,
    author: author === null ? null : user(author),
    committer: user("web-flow"),
    parents: [],
  };
}

export function issue(node_id: string, author: string, created_at: string, options: { pr?: boolean; number?: number; open_issues?: number; title?: string } = {}): JsonObject {
  const number = options.number ?? 1;
  return {
    url: `${API}/repos/${REPO}/issues/${number}`,
    repository_url: `${API}/repos/${REPO}`,
    html_url: `${WEB}/${REPO}/${options.pr === true ? "pull" : "issues"}/${number}`,
    id: 9001,
    node_id,
    number,
    title: options.title ?? "synthetic issue",
    user: user(author),
    state: "open",
    assignees: [],
    comments: 0,
    created_at,
    updated_at: created_at,
    closed_at: null,
    body: "synthetic body",
    ...(options.pr === true ? { draft: false, pull_request: { url: `${API}/repos/${REPO}/pulls/${number}`, merged_at: null } } : {}),
    repository: { id: 501, node_id: "R_fake501", full_name: REPO, private: true, pushed_at: created_at, open_issues_count: options.open_issues ?? 3, stargazers_count: 0 },
  };
}

export function note(node_id: string, author: string, created_at: string, body = "synthetic comment"): JsonObject {
  return { id: 70001, node_id, user: user(author), body, created_at, updated_at: created_at, issue_url: `${API}/repos/${REPO}/issues/1`, html_url: `${WEB}/${REPO}/issues/1#issuecomment-70001` };
}

export function inline(node_id: string, author: string, created_at: string, body: string): JsonObject {
  return {
    id: 71001, node_id, user: user(author), body, created_at, updated_at: created_at, path: "src/synthetic.ts", line: 12, pull_request_review_id: 80001,
    pull_request_url: `${API}/repos/${REPO}/pulls/3`, html_url: `${WEB}/${REPO}/pull/3#discussion_r71001`,
  };
}

export function review(node_id: string, author: string, submitted_at: string | null): JsonObject {
  return {
    id: 80001, node_id, user: user(author), body: "synthetic review", state: submitted_at === null ? "PENDING" : "APPROVED",
    ...(submitted_at === null ? {} : { submitted_at }), pull_request_url: `${API}/repos/${REPO}/pulls/3`, html_url: `${WEB}/${REPO}/pull/3#pullrequestreview-80001`, commit_id: "a".repeat(40),
  };
}

export function pull(pages: { what: Page; body: Json }[], options: { account?: string; stopped?: JsonObject } = {}): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  const listed = pages.map(({ what, body }, index) => {
    const file = `page-${String(index + 1).padStart(5, "0")}.json`;
    const bytes = Buffer.from(JSON.stringify(body));
    files[file] = bytes;
    return { file, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, what, request: `/synthetic/${what}` };
  });
  const manifest = {
    format: PULL_FORMAT, complete: true, account: options.account ?? LOGIN, fetched_at: "2026-09-10T08:00:00.000Z", requests: pages.length,
    ...(options.stopped === undefined ? {} : { stopped: options.stopped }), pages: listed,
  };
  files[PULL_MANIFEST] = Buffer.from(`${JSON.stringify(manifest)}\n`);
  return files;
}

const FIXTURE_SHA = "abcdef0123".repeat(4);

export const githubFixture: Fixture = (folder) => {
  const files = pull([
    { what: "user", body: user(LOGIN) },
    { what: "issues", body: [issue("I_fake1", LOGIN, "2026-09-01T10:00:00Z"), issue("PR_fake3", LOGIN, "2026-09-02T09:30:00Z", { pr: true, number: 3, title: "synthetic pull request" })] },
    { what: "issue-comments", body: [note("IC_fake1", LOGIN, "2026-09-03T12:00:00Z")] },
    { what: "review-comments", body: [inline("PRRC_fake2", LOGIN, "2026-09-05T08:03:00Z", "synthetic inline comment")] },
    { what: "commits", body: [commit(FIXTURE_SHA, LOGIN, "2026-09-04T08:00:00Z")] },
    { what: "reviews", body: [review("PRR_fake4", LOGIN, "2026-09-05T08:00:00Z")] },
  ]);
  for (const [path, bytes] of Object.entries(files)) writeFileSync(join(folder, path), bytes);
  return {
    source: SOURCE, facts: {}, files: Object.fromEntries(Object.keys(files).map((path) => [path, "trust" as const])),
    heads: [
      "comment IC_fake1", "comment PRRC_fake2", `commit ${FIXTURE_SHA}`, "issue I_fake1", "pr PR_fake3", "review PRR_fake4",
    ],
  };
};
