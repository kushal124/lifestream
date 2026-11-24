import { readFileSync } from "node:fs";
import { join } from "node:path";
import { issuerOf, routeNamed, withRoadDefaults, type Acquirer, type Connector } from "@lifestreamprotocol/connect";
import type { Dependencies } from "@lifestreamprotocol/connect/sdk";
import { labelsFamily, notesFamily } from "@lifestreamprotocol/families";
import { acquirers, connectorsWith, feedersOf } from "../registry-home.js";
import type { Registry, RegistryHome } from "../registry.js";
import type { Settings } from "../settings.js";
import { RELEASE_FED, releaseFolder } from "./fed.js";

const granola = releaseFolder("notes/granola");
const github = releaseFolder("code/github");
const mail = releaseFolder("mail/gmail");

export const FAKE_FILE = "signin-fake.json";

const MOVED: Readonly<Record<string, string>> = { "https://public-api.granola.ai": "/api", "https://api.github.com": "/github" };


export default function registry(settings: Settings, home: RegistryHome): Registry {
  const folder = home.root;
  const { port } = JSON.parse(readFileSync(join(folder, FAKE_FILE), "utf8")) as { port: number };
  const fake = `http://127.0.0.1:${port}`;
  const moved = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const under = MOVED[url.origin];
    if (under === undefined) throw new Error(`the sign-in tests' fetch was asked for ${url.origin}`);
    return globalThis.fetch(`${fake}${under}${url.pathname}${url.search}`, init);
  }) as typeof globalThis.fetch;
  const at = (url: string): string => {
    const parsed = new URL(url);
    return `${fake}${MOVED[parsed.origin]!}${parsed.pathname}${parsed.search}`;
  };
  const checkedAt = (connector: Connector): Connector => ({
    ...connector,
    signin: connector.signin!.map((route) => (route.way === "device" ? { ...route, issuer: fake, resource: `${fake}/mcp` } : route.way === "key" && route.check !== undefined ? { ...route, check: { ...route.check, url: at(route.check.url) } } : route)),
  });
  const meetings = checkedAt(granola.connectors[0]!);
  const declared: readonly Connector[] = [meetings, checkedAt(github.connectors[0]!), ...mail.connectors].map(withRoadDefaults);
  const issuer = issuerOf(routeNamed(meetings, "granola-mcp", "device"));
  const imap = imapOver(`${fake}/imap`);
  const factories: Readonly<Record<string, (settings: never) => Acquirer>> = {
    "granola-api": (each: Parameters<typeof granola.granolaApiAcquirer>[0]) => granola.granolaApiAcquirer(each, { fetch: moved }),
    "granola-mcp": (each: Parameters<typeof granola.granolaMcpAcquirer>[0]) => granola.granolaMcpAcquirer(each, issuer),
    "github-api": (each: Parameters<typeof github.githubApiAcquirer>[0]) => github.githubApiAcquirer(each, { fetch: moved }),
    "gmail-imap": (each: Parameters<typeof mail.gmailImapAcquirer>[0]) => mail.gmailImapAcquirer(each, { imap }),
  } as never;
  return {
    connectors: connectorsWith(declared), readers: [...granola.readers, ...github.readers, ...mail.readers], feeders: feedersOf(declared),
    families: [notesFamily(RELEASE_FED.notes), labelsFamily({ home: settings.unit, messages: RELEASE_FED.messages, mail: RELEASE_FED.mail })(RELEASE_FED.labels)],
    acquirers: acquirers(declared, factories, settings, home),
    signins: { "granola-mcp": granola.granolaMcpSignedIn(issuer), "gmail-imap": (values) => mail.gmailSignedIn(values, { imap }) },
  };
}

type ImapAnswer = { value?: unknown; error?: { message: string; members: Record<string, unknown> } };

function imapOver(url: string): NonNullable<Dependencies["imap"]> {
  return (connection) => {
    const session = { account: connection.account, password: connection.password };
    const inflight = new AbortController();
    const call = async <T>(op: string, args: unknown[] = []): Promise<T> => {
      const response = await globalThis.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op, args, session }), signal: inflight.signal });
      const answer = (await response.json()) as ImapAnswer;
      if (answer.error !== undefined) throw Object.assign(new Error(answer.error.message), answer.error.members);
      return answer.value as T;
    };
    return {
      connect: () => call<void>("connect"),
      logout: () => call<void>("logout"),
      close() {
        inflight.abort();
        void globalThis.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "close", args: [], session }) }).catch(() => undefined);
      },
      list: () => call("list"),
      mailboxOpen: (path, options) => call("mailboxOpen", [path, options]),
      search: (query, options) => call("search", [{ ...query, ...(query.since === undefined ? {} : { since: query.since.toISOString() }) }, options]),
      async *fetch(range, query, options) {
        const messages = await call<{ uid: number; size?: number; emailId?: string; threadId?: string; labels?: string[]; internalDate?: string; source?: string }[]>("fetch", [range, query, options]);
        for (const message of messages) {
          yield {
            uid: message.uid,
            ...(message.size === undefined ? {} : { size: message.size }),
            ...(message.emailId === undefined ? {} : { emailId: message.emailId }),
            ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
            ...(message.labels === undefined ? {} : { labels: new Set(message.labels) }),
            ...(message.internalDate === undefined ? {} : { internalDate: new Date(message.internalDate) }),
            ...(message.source === undefined ? {} : { source: Buffer.from(message.source, "base64") }),
          };
        }
      },
    };
  };
}
