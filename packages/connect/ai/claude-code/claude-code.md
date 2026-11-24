# Claude Code sessions: `claude-code:local:<mac unit>`

**Reads** the session logs the Mac app ships from `~/.claude/projects`: each session's own log
`<session>.jsonl` and each of its sub-agents' `<session>/subagents/agent-<id>.jsonl` (the project
folder, a path on the Mac, is not in the name; every line states its `cwd`), and the session's
whole files: every file under `<session>/tool-results/` (a long tool output, a PDF's pages) and
each sub-agent's `<session>/subagents/agent-<id>.meta.json`. A log ships in parts as it grows: each
delivery carries, for each log, the complete lines it gained since the last delivery the home took,
and `parts.json` states where each part starts (`shared/sessions.ts`). Together the parts are the whole
log, every line copied. A whole file ships when it first appears, never in a later delivery than a
line that names it, and again only if its size changes; `parts.json` states its hash, and every earlier one's of a session the delivery carries
part of. The connector is `claude-code-sessions`; the Mac reads it as a declared store (the connector's
`mac.store`, a `logs` engine over `~/.claude/projects`), run by the Mac's store shipper's
`LogsEngine.swift` (macos-app/Sources/Shipping/Stores/).

| Kind | Key | Content | Time |
|---|---|---|---|
| `agent-turn` | the line's own `uuid` | `claude-code.line`: `{type, line}`, `line` the log's line whole, every field; its blobs the tool-result files it names | the line's `timestamp` |

A line names a tool-result file by its path on the Mac, `…/<session>/tool-results/<name>`: the
spilled output a tool result points to, or a file the agent then read. The row lists each such
file's hash in `blobs`, whichever delivery carried it.

## Its adapter

`adapter.ts` gives the ai family its ai adapter (`packages/core/inputs/ai.ts`), with `folder`
(a line's search text is titled by the folder it ran in). Of every line it reads `sessionId`
(the session, a sub-agent's lines its session's), `type`, `cwd` and `agentId`; of a typed prompt,
its words and images; of an assistant line, each `tool_use` part's id (a tool call), and the file
an `Edit`, `MultiEdit`, `Write` or `NotebookEdit` names. A line is the person's typed turn when it
is not an `assistant` or `system` line, not an injected notice (`attachment`, or `isMeta`), not a
tool result (`toolUseResult`, or a `tool_result` part), not a sub-agent's prompt (`isSidechain`
with a null `parentUuid` and an `agentId`), unless the line states `origin.kind` `human`: a fork
restates the person's prompt with its own `agentId` and keeps its origin. A line stating `origin`
or `promptSource` is typed only with `origin.kind` `human`; an older line stating neither is
typed when it is a `user` line with words, not a compaction summary (`isCompactSummary`) and not
a slash command's output (`<local-command-…>`). A slash command (`<command-name>`) prints as
`/name args`. Its words for search (`said`) are a typed prompt, or the text parts of an
assistant line; a sub-agent's prompt is its agent's tool input, not read.

## Which lines are records

A line that states a `uuid` is one record: `user`, `assistant`, `attachment` and `system` lines.
A line with no uuid is the log's own bookkeeping, shipped and kept in the delivery, and is no
record: `queue-operation`, `mode`, `permission-mode`, `ai-title`, `custom-title`, `last-prompt`,
`atis-latch`, `bridge-session`, `cost-state`, `file-history-snapshot`, `file-history-delta`,
`pr-link`, `frame-link`, `artifact-autoreact-ledger`, `artifact-comment-monitor`,
`fork-context-ref`.

A uuid can be stated twice. A forked sub-agent's log restates the turns it inherited from the
agent it forked, with its own `agentId`; and a prompt line is now and then written again with a
new `promptId`. One uuid is one record: the delivery stated last is its head, and the earlier
content stays a version of it.

## Who wrote a line

The line's own fields say, in this order:

| Line | Fields |
|---|---|
| assistant turn | `type` `assistant` |
| the program's own event (a turn's duration, a compaction, a hook) | `type` `system`, with its `subtype` |
| injected notice (the date, reminders, listings, a task's notification) | `type` `attachment`, or `isMeta` true |
| tool result | `type` `user` with `toolUseResult`, or a `tool_result` part in `message.content` |
| a prompt an agent gave a sub-agent | `type` `user`, `isSidechain` true and `parentUuid` null, in a sub-agent's log (`agentId` names it) |
| a prompt the person typed | `type` `user` with `origin.kind` `human` (`promptSource` `typed`, `queued`, `suggestion_accepted`) |

Older Claude Code versions state no `promptSource` and no `origin`; their typed prompts are the
remaining `user` lines with text content. `isCompactSummary` marks the summary a compaction
writes; `<command-name>` and `<local-command-stdout>` text marks a slash command and its output.

## Rules

- **A session a program started never ships**: one whose first line stating an `entrypoint`
  states `sdk-cli` (`claude -p`) or `sdk-ts` (the Agent SDK), any `sdk-`. A person's are `cli` and
  `claude-desktop`. A log read from its first line whose session a program started, or whose lines
  before the first stating an `entrypoint` do not read, is refused once, whole, and the delivery's
  other logs land. A person's session a program carries on later stays the person's.
- **Nothing is gone.** Claude Code deletes a session 30 days after its last use; a log missing
  from a delivery says nothing.
- **Whole files are kept, and are no record.** A tool-result file no line names (a PDF's page
  images, an output never pointed to) still ships and stays in its delivery. A sub-agent's meta
  states what no line states (`spawnDepth`, `requestNonInteractive`, `isFork`, `stoppedByUser`,
  `spawnedWithWorktree`); it ships and is kept, and becomes a record once its kind is ruled.
  The project's memory notes are not shipped.
- **Refused whole**: a delivery without `parts.json`, a log it lists and does not carry or
  carries and does not list, a name that is no session log or session file, a whole file that is
  not the bytes `parts.json` states. **Refused alone**: a line that is not one JSON object, or a
  turn without a readable `timestamp` (named by log and line); a part whose lines are not the
  count it states, after the lines it holds.
- **Who reads it**: the ai family ([families/ai/ai.md](../../../families/ai/)): one line
  per session, and the turns the person typed.

## Ledger

How the Mac keeps custody of this source: each seal's ledger entry holds how far it carried each log (bytes, lines, the hash of the last 4 KiB) and each whole file (bytes, hash). `SessionLogDomainTests` hold each answer.

1. **Order.** Each log's byte offset: a seal carries the complete lines after the offsets of the newest seal the home received. A backlog that does not fit one bundle (a first sync, a new pass) ships the sessions written in the last hour at once, and the rest in history pages (`history: true`), one while the home has imported all it received.
2. **Reuse.** Not applicable.
3. **Rebuilds.** A log that no longer ends as it did where its offset stopped was rewritten, and ships again from its first line.
4. **Late arrivals.** Logs appear in any order; a listing finds them.
5. **Edits.** A rewrite ships the log again from its first line.
6. **Lost.** The ledger keeps an entry for every seal from `imported` on, so a restore to any of them ships exactly the lines after it; below them, every log from its first line. What Claude Code deleted itself (its cleanup of old sessions) cannot be named.
