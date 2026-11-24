import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const github = {
  id: "github", product: "github", name: "GitHub", vendor: "microsoft", type: "code", noun: ["contribution", "contributions"], counts: ["comment", "commit", "issue", "pr", "review"],
  gives: "Your commits, pull requests, issues and reviews.",
  records: "Your commits, pull requests, issues, reviews and comments.",
  sources: [{ id: "github:<account>:cloud", read: "github-api", arrives: "poll" }],
  acquirers: ["github-api"],
  refresh: { default: "5m", min: "1m" },
  backfill: { about: "Collects your past contributions, a batch at a time." },
  fields: {
    login: { kind: "text", label: "GitHub username", account: true },
    token: { kind: "secret", label: "Token", secret: "github" },
  },
  signin: [{
    acquirer: "github-api", way: "key", fields: ["login", "token"], label: "Use an access token", check: { url: "https://api.github.com/user", account: "login" },
    steps: [{
      title: "Make a token", words: "On GitHub, open Settings › Developer settings › Fine-grained tokens. Let it read Contents, Issues, Pull requests and Metadata.",
      open: { label: "Open GitHub tokens", url: "https://github.com/settings/personal-access-tokens" },
    }],
    note: "Reads only; the token can change nothing.",
    refused: "GitHub refused this token. Check it reads Contents, Issues and Pull requests, then paste it again.",
  }],
  open: { record: { kinds: ["commit", "pr", "issue", "review", "comment"], url: "{content.content.html_url}" } },
} satisfies Connector;
