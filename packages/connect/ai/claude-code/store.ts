import type { MacStore } from "@lifestreamprotocol/connect/sdk";

export const store = {
  feeder: "claude-code-sessions",
  name: "claude_code",
  held: "~/.claude/projects/",
  account: "local",
  engine: {
    kind: "logs",
    beside: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(subagents/agent-[0-9a-z]+\\.meta\\.json|tool-results/([^./][^/]*/)*[^./][^/]*)$",
    match: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\\.jsonl|/subagents/agent-[0-9a-z]+\\.jsonl)$",
    roots: [{ depth: 1, path: "~/.claude/projects" }],
    start: { line: { stating: "entrypoint" }, program: [{ at: "entrypoint", prefix: "sdk-" }] },
  },
} satisfies MacStore;
