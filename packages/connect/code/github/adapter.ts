import { isObject, textHead, type InputRecord, type Json, type JsonObject, type Line, type LineAdapter } from "@lifestreamprotocol/connect/sdk";

const EXCERPT = 280;
const NUMBERED = /\/repos\/([^/]+\/[^/]+)\/(?:issues|pulls)\/(\d+)$/u;
const REPOSITORY = /\/repos\/([^/]+\/[^/]+)(?:\/|$)/u;

const REVIEWED: Readonly<Record<string, string>> = {
  APPROVED: "Approved",
  CHANGES_REQUESTED: "Asked for changes on",
  PENDING: "Started a review of",
};

function words(value: Json | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  const cut = textHead(flat, EXCERPT);
  return cut.length < flat.length ? `${cut.trimEnd()}…` : flat;
}

function saying(body: string): string {
  return body === "" ? "" : `: ${excerpt(body)}`;
}

function quoted(title: string): string {
  return title === "" ? "" : ` “${title}”`;
}

function numbered(url: Json | undefined): string | null {
  const found = NUMBERED.exec(words(url));
  return found === null ? null : `${found[1]}#${found[2]}`;
}

function repositoryOf(item: JsonObject): string | null {
  const full = isObject(item.repository) ? words(item.repository.full_name) : "";
  if (full !== "") return full;
  return REPOSITORY.exec(words(item.repository_url) || words(item.url))?.[1] ?? null;
}

function opened(noun: string, item: JsonObject): string {
  const repository = repositoryOf(item);
  const ref = repository !== null && typeof item.number === "number" ? ` ${repository}#${item.number}` : "";
  return `Opened ${noun}${ref}${quoted(words(item.title))}${saying(words(item.body))}`;
}

function committed(item: JsonObject): string {
  const message = isObject(item.commit) ? words(item.commit.message) : "";
  const [subject = "", ...rest] = message.split("\n");
  const repository = repositoryOf(item);
  return `Committed${quoted(subject.trim())}${repository === null ? "" : ` to ${repository}`}${saying(rest.join("\n").trim())}`;
}

function reviewed(item: JsonObject): string {
  const ref = numbered(item.pull_request_url);
  return `${REVIEWED[words(item.state)] ?? "Reviewed"} pull request${ref === null ? "" : ` ${ref}`}${saying(words(item.body))}`;
}

function commented(item: JsonObject, inReview: boolean): string {
  const ref = numbered(inReview ? item.pull_request_url : item.issue_url);
  const on = inReview ? `pull request${ref === null ? "" : ` ${ref}`}` : ref ?? "an issue";
  const path = words(item.path);
  return `Commented on ${inReview && path !== "" ? `${path} in ${on}` : on}${saying(words(item.body))}`;
}

function textOf(type: string, item: JsonObject): string | null {
  switch (type) {
    case "github.issue": return opened("issue", item);
    case "github.pr": return opened("pull request", item);
    case "github.commit": return committed(item);
    case "github.review": return reviewed(item);
    case "github.issue-comment": return commented(item, false);
    case "github.review-comment": return commented(item, true);
    default: return null;
  }
}

export const line: LineAdapter = {
  version: "1",
  kinds: ["commit", "pr", "issue", "review", "comment"],
  line({ version }: InputRecord): Line | null {
    const content = version.content;
    if (!isObject(content) || typeof content.type !== "string" || !isObject(content.content)) return null;
    const text = textOf(content.type, content.content);
    if (text === null) return null;
    const link = words(content.content.html_url);
    return link === "" ? { text } : { text, link };
  },
};
