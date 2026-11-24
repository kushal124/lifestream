# GitHub: `github:<login>:cloud`

The person's own activity on GitHub, in every repository a fine-grained personal access token
sees (read-only: Contents, Issues, Pull requests, Metadata). It is signed in to by its one `key`
route (`signin`): the login and the token typed in one sheet (`account-connect`), the token
checked before anything is sealed by its declared check, `check: { url: "https://api.github.com/user",
account: "login" }`, which the home runs: a 401 is the token refused,
and the answer's `login` is the account, refused, naming the login, when it is another's. The token is sealed as
`github.<n>`, the `token` field's name and a generation, which the block's `token` names; `login`
is the declared account (`account: true`).

## What it reads

**`github-api`**: a delivery the `github-api` acquirer sealed. `pull.json`
(`org.lifestreamprotocol.github-api-pull/0.1`: account, fetched_at, requests, `stopped` when a
stop cut the poll short, and one entry per page: file, sha256, bytes, `what`, request) and one
`page-NNNNN.json` per answer, its bytes as GitHub sent them. The account must be the source's;
the first page is `GET /user`, whose login must be the account. Each file must match the hash
and size the pull states, and every file must be listed, before the first row: a pull that
fails either lands nothing.

A page holds GitHub's items whoever wrote them. A row is made only for the account's own:

| `what` | Request | Rows |
|---|---|---|
| `user` | `/user` | none: it proves whose token it is |
| `repos`, `branches` | `/user/repos`, `/repos/{repo}/branches` | none: where the poll looked |
| `issues` | `/issues?filter=all&state=all&sort=updated&direction=asc&since=` | each item the login opened: `pr` when it states `pull_request`, else `issue` |
| `issue-comments`, `review-comments` | `/repos/{repo}/issues/comments`, `/repos/{repo}/pulls/comments`, each `?sort=updated&direction=asc&since=` | each comment the login wrote |
| `reviews` | `/repos/{repo}/pulls/{n}/reviews` | each review the login wrote |
| `commits` | `/repos/{repo}/commits?sha=&author=` | each commit GitHub links to the login as author |
| `compare` | `/repos/{repo}/compare/{base}...{head}` | the same, from the comparison's `commits`; its `files` (the diff) stays in the delivery |

## Kinds and keys

| Kind | Key | Content | Time |
|---|---|---|---|
| `commit` | the commit SHA | `{type: "github.commit", content}`: the list item as GitHub states it (`commit` with author, committer, message, tree and verification; `author`, `committer`, `parents`, urls) | `commit.author.date` |
| `pr` | GitHub's node id | `{type: "github.pr", content}`: the item as the issues list states it, `repository` cut to its identity | `created_at` |
| `issue` | GitHub's node id | `{type: "github.issue", content}`: the same | `created_at` |
| `review` | GitHub's node id | `{type: "github.review", content}`: the review as stated (state, body, `commit_id`, `submitted_at`) | `submitted_at`; none for a review still `PENDING` |
| `comment` | GitHub's node id | `{type: "github.issue-comment" \| "github.review-comment", content}`: the comment as stated (a review comment with its path, line, diff hunk and `pull_request_review_id`) | `created_at` |

## Day lines

No family reads code, so each record is a plain line (`adapter.ts`, the plain family), at its
record's own time, under the stream's name, GitHub. A line names what the person did, GitHub's
`owner/repo#number` for what it was done to, and the person's own words after a colon, their
line breaks as spaces and cut at 280 characters with `…`:

| Record | Line |
|---|---|
| `issue` | `Opened issue person-a/repo-one#1 “Title”: body` |
| `pr` | `Opened pull request person-a/repo-one#3 “Title”: body` |
| `commit` | `Committed “subject” to person-a/repo-one: the rest of the message` |
| `review` | `Approved pull request person-a/repo-one#3: body`; `Asked for changes on` for changes requested, `Started a review of` while pending, else `Reviewed` |
| `comment` on an issue or pull request | `Commented on person-a/repo-one#1: body` |
| `comment` on a pull request's diff | `Commented on src/file.ts in pull request person-a/repo-one#3: body` |

Each part GitHub does not state is left out: an empty body has no colon, an item whose repository
or number is not stated has no reference. The repository comes from the issue's `repository`, else
the API urls an item states (`repository_url`, `url`, `issue_url`, `pull_request_url`). Search
finds a record by its line's words and its `html_url`, the line's link. Every record opens in GitHub at its `html_url`,
`open.record`'s `{content.content.html_url}`: the page GitHub states, a comment's and a review's anchored on its pull
request or issue. A pending review states no
time, so it prints on no day; search finds it. A pull request's merge and an issue's close print
no line: they are fields of the item, whose record is timed by its opening.

## Rules

- **Whose.** A commit is the person's when GitHub links its author to the login
  (`author.login`): a commit whose author email no GitHub account claims (`author: null`) is not
  read, nor one the person only committed (a rebase or cherry-pick of another's work). An issue
  or pull request is the person's when they opened it; one only assigned to them is not, since the
  assignment is another's act and the person's own part in it is their comments, reviews and
  commits. Left out: issues, pull requests and comments in repositories the token cannot see
  (another owner's open-source project), commit comments, discussions, gists, stars and releases.
- **The repository an issue names** is kept by its identity alone (`id`, `node_id`,
  `full_name`): the issues list states the whole repository in each item, and its counters and
  times change with every push, which would make each restatement of an old issue a new version.
- **Every other field is GitHub's**, numbers above 2^53 kept as text. Times are GitHub's UTC
  (`Z`): REST does not state the person's offset (a signed commit's `verification.payload`
  carries git's own author line, offset included, and stays in the content).
- **Nothing is ever gone.** GitHub states no deletion through these lists. A commit a force-push
  or a deleted branch left unreachable is still a commit the person made, and stays live.
- **Edits.** An edited comment, issue or review is a new version of the same record: GitHub moves
  its `updated_at`, and the comment's issue's.
- **One SHA, two repositories.** A fork holds its parent's commits under the same SHAs, with
  other urls and node ids. Both copies are one record, keyed by the SHA; the copy read last is its
  head.

## The poll

`github-api` polls at its connector's refresh (every 5 minutes by default), REST with headers `Accept:
application/vnd.github+json` and `X-GitHub-Api-Version: 2022-11-28`. A poll costs what changed:

- `/user`, then the issues list from the cursor `issues` (the newest `updated_at` sealed). For
  each item, its repository's comment lists are brought up to date from their own cursors
  (`comments`; a list with none yet from the stream's start, `lent.start_ms`), once per poll, and a pull request's reviews are read whole. A comment or review
  moves its issue's `updated_at`, so the list names where to look. The cursor moves past an item
  only once all it named is sealed.
- `/user/repos`, then for each repository whose `pushed_at` moved, its branches, and for each
  branch whose head moved, `compare/{old head}...{new head}`: every commit the new head reaches
  that the old does not, a force-push's and a late push of an old commit included. A branch never
  seen is compared with the default branch's head; a default branch never seen (the backfill) is
  listed whole with `author=<login>`. A head GitHub no longer knows (404) falls back the same way.
- Every `since` list is asked from the newest `updated_at` it sealed, inclusive, and keeps the ids
  it sealed at that second: an item listed at it is new only when its id is not kept, so one that
  arrives in the same second as the last sealed lands, and those sealed are not restated. A full
  page all at that one second is followed by its link.
  A branch's comparison or walk a stop cut short goes on from its next page while the branch's
  head is unchanged (the repository's `reading`): the result of two fixed SHAs never changes. That
  branch is read first in its repository's next poll, so another branch's stop never takes its
  place; once it moved, its comparison starts again from its sealed head.

An idle poll costs `/user`, the issues list, what its newest item names, and the repository list,
and seals nothing: a poll is sealed only when a list held an item newer than the cursor it was
asked from or at its second and not kept, or a branch moved; else only its cursor and memory move.

**What it keeps.** The cursor holds the poll's clock, `issues` and the ids sealed at it (`issues_held`). The rest is the poll's
memory, each entry written by the call that sealed what it says: part `repo`, by the repository's
id, its full name, the `pushed_at` whose branches were all read and a `reading` a stop cut short;
part `branch:<repo id>`, each branch's head whose commits are sealed, dropped when the branch is
gone from the list; part `comments`, by the repository's full name, the newest `updated_at` of its
issue and review comment lists and the ids sealed at each. A repository the token no longer lists is forgotten with its
branches. A comment list is keyed by name, so a renamed repository's is read from the stream's start.

**Bounds and limits.** A poll makes at most 400 requests; one stopped there says so (`more`), and
the next goes on at once from where it stopped, so the backfill arrives in bounded deliveries. It
is one forward walk from the stream's start (`lent.start_ms`) with no page of its own: a start moved earlier
than the one the cursor was left under (`lent.from_ms`) lists the issues again from the new start, every comment list's cursor dropped with it, so the connector declares no pace; a paced history, which needs a backward
cursor, is deferred. Its requests go through the request loop (shared/http.ts): a 403 or 429
that says the limit is spent (`x-ratelimit-remaining: 0`, or `retry-after`), or a 2xx leaving 500
requests or fewer this hour, stops the poll: what it finished is sealed with `stopped:
{reason: "rate-limit", resume_at}`, and it is not due before GitHub's reset; with nothing finished it
is a wait (`NotYet` `provider-limit`) until then. A 401 (a revoked token) is `NeedsYou` `signed-out`. The limit is the
account's, shared with every other client of it. A repository whose branch list answers 403
(not a rate limit), 404 or 451 (an organisation behind SAML, a takedown, a rename since the
listing) is skipped: its `pushed_at` stays, the poll's facts name it in `skipped`, and the next poll
asks again. Any other failure (a 5xx, a timeout, a 401) fails the poll whole; nothing moves, and
the next poll asks again. A `next` link off
`api.github.com` is refused, so the token goes nowhere else.

## Node ids

The key of everything but a commit is the `node_id` REST states. GitHub has two spellings:
objects made before its 2021 migration state the legacy one (`MDExOlB1bGxSZXF1ZXN0…`, the
base64 of `011:PullRequest<id>`), newer ones the new (`PR_kwDO…`). The `X-Github-Next-Global-ID` header does not
change what REST states (measured on public objects). Should REST ever state the new spelling for
an old object, its records would be keyed twice.
