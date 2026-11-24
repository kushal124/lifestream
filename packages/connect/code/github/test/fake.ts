import { createHash } from "node:crypto";
import type { JsonObject } from "@lifestreamprotocol/core";

const API = "https://api.github.com";

interface Commit {
  sha: string;
  parents: string[];
  author: string | null;
  date: string;
  message: string;
}

interface Repo {
  id: number;
  full_name: string;
  default_branch: string;
  pushed_at: string | null;
  branches: Map<string, string>;
  commits: Map<string, Commit>;
}

interface Issue {
  id: number;
  node_id: string;
  repo: string;
  number: number;
  user: string;
  pr: boolean;
  title: string;
  created_at: string;
  updated_at: string;
}

interface Note {
  id: number;
  node_id: string;
  repo: string;
  number: number;
  user: string;
  body: string;
  created_at: string;
  updated_at: string;
  what: "issue-comment" | "review-comment" | "review";
}

export function fakeGithub(login: string, token: string, { page: PAGE = 2 }: { page?: number } = {}) {
  const repos = new Map<string, Repo>();
  const issues: Issue[] = [];
  const notes: Note[] = [];
  const requests: string[] = [];
  const refused = new Map<string, number>();
  const hidden = new Set<string>();
  const limit = { remaining: Number.POSITIVE_INFINITY, reset: 0, spentElsewhere: false };
  let user = login;
  let serial = 0;
  let clock = Date.UTC(2026, 0, 1);
  let frozen = false;
  const stamp = (): string => new Date((clock += frozen ? 0 : 60_000)).toISOString().replace(/\.\d{3}Z$/u, "Z");
  const sha = (): string => createHash("sha1").update(`commit ${++serial}`).digest("hex");
  const userObject = (name: string): JsonObject => ({ login: name, id: 1000 + name.length, node_id: `U_fake${name}`, type: "User", site_admin: false });

  function ancestors(repo: Repo, from: string): Set<string> {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const at = stack.pop()!;
      if (seen.has(at)) continue;
      seen.add(at);
      stack.push(...repo.commits.get(at)!.parents);
    }
    return seen;
  }

  function commitItem(repo: Repo, commit: Commit): JsonObject {
    return {
      sha: commit.sha,
      node_id: `C_fake${repo.id}_${commit.sha.slice(0, 8)}`,
      commit: {
        author: { name: `Synthetic ${commit.author ?? "someone"}`, email: `${commit.author ?? "unlinked"}@example.com`, date: commit.date },
        committer: { name: "Synthetic committer", email: "committer@example.com", date: commit.date },
        message: commit.message,
        tree: { sha: createHash("sha1").update(`tree ${commit.sha}`).digest("hex") },
        comment_count: 0,
      },
      url: `${API}/repos/${repo.full_name}/commits/${commit.sha}`,
      html_url: `https://github.com/${repo.full_name}/commit/${commit.sha}`,
      author: commit.author === null ? null : userObject(commit.author),
      committer: userObject("web-flow"),
      parents: commit.parents.map((parent) => ({ sha: parent, url: `${API}/repos/${repo.full_name}/commits/${parent}` })),
    };
  }

  function repoObject(repo: Repo): JsonObject {
    return {
      id: repo.id, node_id: `R_fake${repo.id}`, name: repo.full_name.split("/")[1]!, full_name: repo.full_name, private: true,
      owner: userObject(repo.full_name.split("/")[0]!), default_branch: repo.default_branch, pushed_at: repo.pushed_at,
      updated_at: repo.pushed_at, stargazers_count: 0, open_issues_count: issues.filter((issue) => issue.repo === repo.full_name).length,
    };
  }

  function issueItem(issue: Issue): JsonObject {
    const repo = repos.get(issue.repo)!;
    return {
      url: `${API}/repos/${issue.repo}/issues/${issue.number}`,
      repository_url: `${API}/repos/${issue.repo}`,
      html_url: `https://github.com/${issue.repo}/${issue.pr ? "pull" : "issues"}/${issue.number}`,
      id: issue.id, node_id: issue.node_id, number: issue.number, title: issue.title, user: userObject(issue.user),
      labels: [], state: "open", locked: false, assignees: [], milestone: null,
      comments: notes.filter((note) => note.repo === issue.repo && note.number === issue.number && note.what === "issue-comment").length,
      created_at: issue.created_at, updated_at: issue.updated_at, closed_at: null, author_association: "OWNER", body: `synthetic body of ${issue.title}`,
      ...(issue.pr ? { draft: false, pull_request: { url: `${API}/repos/${issue.repo}/pulls/${issue.number}`, merged_at: null } } : {}),
      repository: repoObject(repo),
    };
  }

  function noteItem(note: Note): JsonObject {
    const common = { id: note.id, node_id: note.node_id, user: userObject(note.user), body: note.body, author_association: "OWNER" };
    if (note.what === "review") {
      return { ...common, state: "COMMENTED", submitted_at: note.created_at, pull_request_url: `${API}/repos/${note.repo}/pulls/${note.number}`, commit_id: "0".repeat(40) };
    }
    if (note.what === "review-comment") {
      return { ...common, created_at: note.created_at, updated_at: note.updated_at, path: "synthetic.txt", line: 1, pull_request_url: `${API}/repos/${note.repo}/pulls/${note.number}` };
    }
    return { ...common, created_at: note.created_at, updated_at: note.updated_at, issue_url: `${API}/repos/${note.repo}/issues/${note.number}` };
  }

  function pageOf(url: URL, items: JsonObject[], extra?: (items: JsonObject[]) => JsonObject): Response {
    const page = Number(url.searchParams.get("page") ?? "1");
    const slice = items.slice((page - 1) * PAGE, page * PAGE);
    const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
    if (page * PAGE < items.length) {
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      headers.link = `<${next.href}>; rel="next", <${API}/elsewhere>; rel="last"`;
    }
    return answer(extra === undefined ? slice : extra(slice), 200, headers);
  }

  function answer(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
    const left = Number.isFinite(limit.remaining) && !(limit.spentElsewhere && status === 200) ? String(limit.remaining) : "4999";
    return new Response(JSON.stringify(body), { status, headers: { "x-ratelimit-remaining": left, "x-ratelimit-reset": String(limit.reset), ...headers } });
  }

  const since = (url: URL) => url.searchParams.get("since");
  const byUpdate = (a: { updated_at: string; id: number }, b: { updated_at: string; id: number }) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : a.id - b.id);

  const fetch = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    requests.push(`${url.pathname}${url.search}`);
    if (url.origin !== API) throw new Error(`the fake was asked for ${url.origin}`);
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${token}`) return answer({ message: "Bad credentials" }, 401);
    if (limit.remaining <= 0) return answer({ message: "API rate limit exceeded for a private account" }, 403);
    limit.remaining--;
    const path = url.pathname;
    if (path === "/user") return answer(userObject(user));
    if (path === "/user/repos") return pageOf(url, [...repos.values()].filter((repo) => !hidden.has(repo.full_name)).sort((a, b) => (a.full_name < b.full_name ? -1 : 1)).map(repoObject));
    if (path === "/issues") {
      const from = since(url);
      return pageOf(url, issues.filter((issue) => from === null || issue.updated_at >= from).sort(byUpdate).map(issueItem));
    }
    const match = /^\/repos\/([^/]+\/[^/]+)\/(.+)$/u.exec(path);
    const repo = match === null ? undefined : repos.get(match[1]!);
    if (match === null || repo === undefined) return answer({ message: "Not Found" }, 404);
    const refusal = refused.get(repo.full_name);
    if (refusal !== undefined) return answer({ message: "Resource protected by organization SAML enforcement" }, refusal);
    const rest = match[2]!;
    if (rest === "branches") return pageOf(url, [...repo.branches].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, head]) => ({ name, commit: { sha: head, url: `${API}/repos/${repo.full_name}/commits/${head}` }, protected: false })));
    if (rest === "issues/comments" || rest === "pulls/comments") {
      const what = rest === "issues/comments" ? "issue-comment" : "review-comment";
      const from = since(url);
      return pageOf(url, notes.filter((note) => note.repo === repo.full_name && note.what === what && (from === null || note.updated_at >= from)).sort(byUpdate).map(noteItem));
    }
    const reviews = /^pulls\/(\d+)\/reviews$/u.exec(rest);
    if (reviews !== null) return pageOf(url, notes.filter((note) => note.repo === repo.full_name && note.what === "review" && note.number === Number(reviews[1])).sort((a, b) => a.id - b.id).map(noteItem));
    if (rest === "commits") {
      const head = url.searchParams.get("sha") ?? repo.branches.get(repo.default_branch)!;
      if (!repo.commits.has(head)) return answer({ message: "No commit found for SHA" }, 404);
      const author = url.searchParams.get("author");
      const listed = [...ancestors(repo, head)].map((each) => repo.commits.get(each)!).filter((commit) => author === null || commit.author === author)
        .sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : a.sha < b.sha ? -1 : 1));
      return pageOf(url, listed.map((commit) => commitItem(repo, commit)));
    }
    const compare = /^compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)$/u.exec(rest);
    if (compare !== null) {
      const [base, head] = [compare[1]!, compare[2]!];
      if (!repo.commits.has(base) || !repo.commits.has(head)) return answer({ message: "Not Found" }, 404);
      const reach = ancestors(repo, head);
      const behind = ancestors(repo, base);
      const ahead = [...reach].filter((each) => !behind.has(each)).map((each) => repo.commits.get(each)!).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.sha < b.sha ? -1 : 1));
      const behindBy = [...behind].filter((each) => !reach.has(each)).length;
      const status = ahead.length === 0 ? (behindBy === 0 ? "identical" : "behind") : behindBy === 0 ? "ahead" : "diverged";
      return pageOf(url, ahead.map((commit) => commitItem(repo, commit)), (slice) => ({
        url: `${API}/repos/${repo.full_name}/compare/${base}...${head}`, status, ahead_by: ahead.length, behind_by: behindBy, total_commits: ahead.length,
        commits: slice, ...(url.searchParams.get("page") === null ? { files: [{ filename: "synthetic.txt", status: "modified", patch: "@@ -1 +1 @@\n-a\n+b" }] } : {}),
      }));
    }
    return answer({ message: "Not Found" }, 404);
  }) as typeof globalThis.fetch;

  const github = {
    fetch,
    requests,
    limit,
    actAs(name: string) {
      user = name;
    },
    repo(full_name: string, default_branch = "main"): string {
      repos.set(full_name, { id: 500 + repos.size, full_name, default_branch, pushed_at: null, branches: new Map(), commits: new Map() });
      return full_name;
    },
    commit(full: string, branch: string, author: string | null, options: { date?: string; from?: string; merge?: string; push?: boolean } = {}): string {
      const repo = repos.get(full)!;
      const parent = options.from ?? repo.branches.get(branch);
      const made: Commit = { sha: sha(), parents: [...(parent === undefined ? [] : [parent]), ...(options.merge === undefined ? [] : [options.merge])], author, date: options.date ?? stamp(), message: `synthetic commit ${serial}` };
      repo.commits.set(made.sha, made);
      if (options.push !== false) github.push(full, branch, made.sha);
      return made.sha;
    },
    push(full: string, branch: string, head: string) {
      const repo = repos.get(full)!;
      repo.branches.set(branch, head);
      repo.pushed_at = stamp();
    },
    refuse(full: string, status: number | null) {
      if (status === null) refused.delete(full);
      else refused.set(full, status);
    },
    hide(full: string) {
      hidden.add(full);
    },
    freeze() {
      frozen = true;
    },
    deleteBranch(full: string, branch: string) {
      const repo = repos.get(full)!;
      repo.branches.delete(branch);
      repo.pushed_at = stamp();
    },
    head(full: string, branch: string): string {
      return repos.get(full)!.branches.get(branch)!;
    },
    issue(full: string, author: string, pr = false): { number: number; node_id: string } {
      const at = stamp();
      const number = issues.filter((issue) => issue.repo === full).length + 1;
      const issue: Issue = { id: 9000 + issues.length, node_id: `${pr ? "PR" : "I"}_fake${issues.length + 1}`, repo: full, number, user: author, pr, title: `synthetic ${pr ? "pull request" : "issue"} ${number}`, created_at: at, updated_at: at };
      issues.push(issue);
      return { number, node_id: issue.node_id };
    },
    note(full: string, number: number, author: string, what: Note["what"] = "issue-comment"): string {
      const at = stamp();
      const note: Note = { id: 70000 + notes.length, node_id: `${what === "review" ? "PRR" : what === "review-comment" ? "PRRC" : "IC"}_fake${notes.length + 1}`, repo: full, number, user: author, body: `synthetic ${what} ${notes.length + 1}`, created_at: at, updated_at: at, what };
      notes.push(note);
      issues.find((issue) => issue.repo === full && issue.number === number)!.updated_at = at;
      return note.node_id;
    },
    edit(node_id: string, body: string) {
      const note = notes.find((each) => each.node_id === node_id)!;
      note.body = body;
      note.updated_at = stamp();
      issues.find((issue) => issue.repo === note.repo && issue.number === note.number)!.updated_at = note.updated_at;
    },
  };
  return github;
}

export type FakeGithub = ReturnType<typeof fakeGithub>;
