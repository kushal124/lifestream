# Codex sessions: `codex:local:<mac unit>`

**Reads** the rollout logs the Mac app ships from `~/.codex/sessions` and
`~/.codex/archived_sessions`: `rollout-<started>-<session id>.jsonl`, and
`rollout-<started>-<session id>_<segment id>.jsonl`, a later log of the same thread. A log keeps its
name when Codex archives it. A log ships in parts as it grows: each delivery carries, for each log,
the complete lines it gained since the last delivery the home took, and `parts.json` states where
each part starts (`shared/sessions.ts`). Together the parts are the whole log, every line copied. The
connector is `codex-sessions`; the Mac reads it as a declared store (the connector's `mac.store`, a
`logs` engine over `~/.codex/sessions` and `~/.codex/archived_sessions`), run by the Mac's store
shipper's `LogsEngine.swift` (macos-app/Sources/Shipping/Stores/).

| Kind | Key | Content | Time |
|---|---|---|---|
| `agent-turn` | `<session id>:<line number>`; for a segment's log `<session id>_<segment id>:<line number>`; lines numbered from 1 in each log | `codex.line`: `{type, line}`, `line` the log's line whole, every field | the line's `timestamp` |

A segment's log starts with its own `session_meta` (its `history_base` names the thread and where
it branched) and numbers its lines from 1 again, so its key names the segment. A number past
2^53 is kept as its digits, a string.

## Who wrote a line

Line 1 is the session's `session_meta`: `thread_source` says who opened the thread (`user`,
`subagent`, `agent_created_thread`; never `automation`, which never ships), `source.subagent.thread_spawn.parent_thread_id`
and `parent_thread_id` name a sub-agent's parent. Then:

| Line | Fields |
|---|---|
| assistant turn | `response_item` with `payload.role` `assistant`, or `payload.type` `reasoning`, `function_call`, `custom_tool_call`, `web_search_call`; `event_msg` `item_completed` with an `AgentMessage` item |
| injected notice | `response_item` `message` with `role` `developer`, or `role` `user` whose text opens with a tag (`<environment_context>`, `# AGENTS.md instructions`, `<subagent_notification>`, `<turn_aborted>`, `<recommended_plugins>`) |
| tool result | `response_item` `function_call_output`, `custom_tool_call_output`, `tool_search_output`; `event_msg` `item_completed` with a `CommandExecution`, `McpToolCall` or `FileChange` item |
| a message between agents: a prompt an agent gave a sub-agent, or a sub-agent's report to it | `response_item` `agent_message`, its `author` and `recipient` the agents' paths (`/root`, `/root/worker`), after an `inter_agent_communication_metadata` line; in a `subagent` thread, those to it are its prompts |
| a prompt the person typed | `event_msg` `item_completed` with a `UserMessage` item, beside the `response_item` `message` with `role` `user` it sent, in a thread whose `thread_source` is `user` (older logs state none); in a `subagent` thread such items come from its parent agent |

`turn_context`, `token_count`, `token_usage_record`, `world_state`, `compacted` and the task
events are the program's own.

## Its adapter

`adapter.ts` gives the ai family its ai adapter (`packages/core/inputs/ai.ts`). A line's session
is the thread the person opened: a sub-agent's thread names its parent in its first line
(`session_meta`), followed up to the root, and a later segment of a thread
(`<session>_<segment>`) is its session's. The session's working directory is its first line's
`cwd`, read from the source's other records (the log's line 1). Of a `response_item` it reads a
user message's text and images, each tool call (`function_call`, `custom_tool_call`,
`web_search_call`) by id, and the files an `apply_patch` names. A line is the person's typed turn
when it is a `response_item` `message` in the `user` role whose text opens with no tag, in a
thread whose `thread_source` is `user` or unstated and which names no parent; its
`item_completed` `UserMessage` is the same words again and is not printed twice, and in a
sub-agent's thread the prompts are its parent's. Its words for search (`said`) are a
`response_item` message in the person's or the assistant's role, never one the program injects;
a sub-agent's prompts are its parent agent's words, kept.

## Rules

- **A session a program started never ships**: one whose `session_meta` states the originator
  `codex_exec` or the source `exec` (`codex exec`; the home's own model calls, also through the
  Desktop app's binary), or the `thread_source` `automation` (a scheduler opened it). The Mac reads
  no further than its first line. A log read from its first line whose session a program started, or
  whose first line does not read or is not the meta of the session its name states, is refused once,
  whole, and the delivery's other logs land.
- **Nothing is gone.** A log missing from a delivery says nothing.
- **Refused whole**: a delivery without `parts.json`, one carrying any file but a rollout log's part, a log it lists and does not carry or
  carries and does not list, a name that is no rollout log's. **Refused alone**: a line that is not one JSON object, or a
  turn without a readable `timestamp` (named by log and line); a part whose lines are not the
  count it states, after the lines it holds.
- **Who reads it**: the ai family ([families/ai/ai.md](../../../families/ai/)): one line
  per session, and the turns the person typed.

## Ledger

How the Mac keeps custody of this source: each seal's ledger entry holds how far it carried each rollout log (bytes, lines, the hash of the last 4 KiB). `SessionLogDomainTests` hold each answer.

1. **Order.** Each log's byte offset: a seal carries the complete lines after the offsets of the newest seal the home received. A backlog that does not fit one bundle (a first sync, a new pass) ships the sessions written in the last hour at once, and the rest in history pages (`history: true`), one while the home has imported all it received.
2. **Reuse.** Not applicable.
3. **Rebuilds.** A log that no longer ends as it did where its offset stopped ships again from its first line.
4. **Late arrivals.** Logs appear in any order, and an archived log keeps its name; a listing finds them.
5. **Edits.** A rewrite ships the log again from its first line.
6. **Lost.** The ledger keeps an entry for every seal from `imported` on, so a restore to any of them ships exactly the lines after it; below them, every log from its first line.
