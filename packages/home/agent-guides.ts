import type { DeviceKind } from "./devices.js";
import type { AnswerOf, Body, Guide } from "./pages.js";
import type { GrantApp } from "./principals.js";

export const GUIDE_APPS = ["claude", "chatgpt", "muse", "grok-bot", "instinct", "another"] as const;
export type GuideApp = (typeof GUIDE_APPS)[number];
export const KEY_APPS = ["grok-bot", "instinct", "another"] as const;
export type KeyApp = (typeof KEY_APPS)[number];

export type Guides = Body<AnswerOf<"agentGuides">>;
type Step = Guide["steps"][number];
type Link = NonNullable<Guide["done"]["open"]>;
type Value = Extract<Step, { kind: "message" }>["value"];
type Setup = NonNullable<Guide["address"]>;
type On = "mac" | "phone";

export interface Sees {
  readonly access: unknown;
  readonly view: unknown;
}

export interface GuideReader {
  readonly id: string;
  readonly kind: "chat" | "agent";
  readonly via: "sign-in" | "pass" | null;
  readonly from: string | null;
  readonly app: GrantApp | null;
  readonly made_ms: number;
  readonly disconnected_ms: number | null;
}

export const NAME_SLOT = "{name}";
export const HOST_SLOT = "{host}";
export const DEFAULT_MARK = "ai-apps";
export const CHAT_MARK = "chat";

const TITLE = "Connect an agent";
const QUESTION = "Use Lifestream to tell me what I did yesterday.";
const ASK_TITLE = "Ask it first";
const MAKE = "Make the key";
const ONCE = "The key shows only now. Make a new one any time.";
const unknown = (name: string) => `Lifestream didn’t say whether the key was made. Make it again. If Agents then lists ${name} twice, disconnect the one that hasn’t read.`;
const SEES = "It will see";
const LIFESTREAM: Value = { label: "Name", text: "Lifestream", address: false };
const MUSE_MESSAGE = "Connect Lifestream as a custom connector named Lifestream. Connect over HTTPS using Streamable HTTP and OAuth with dynamic client registration. "
  + "Discover Lifestream’s OAuth settings. Use public-client token authentication, the read scope and the exact MCP URL as the resource. Open the secure sign-in card. "
  + "After sign-in, list the tools and set up the connector for Lifestream reads. The MCP URL is: ";
const INSTINCT_MESSAGE = "I want to connect Lifestream as a remote MCP server with an Authorization header. Send me a secure link where I can enter its address and key.";

const address = (label: string, text = ""): Value => ({ label, text, address: true });
const web = (name: string, url: string): Link => ({ to: "web", label: `Open ${name}`, url });
const MESSAGES: Link = { to: "messages", label: "Open Messages" };
const press = (on: On) => (on === "mac" ? "click" : "tap");

const setup = (name: string, on: On): Setup => ({
  title: on === "mac" ? "Set up Tailscale" : "Set up Tailscale on your Mac",
  line: `${name} reaches ${on === "mac" ? "this Mac" : "your Mac"} through Tailscale, a free app.`,
  ready: "Tailscale is ready. Turn on Lifestream’s agent address.",
  on: "Turn on",
});

interface SignInEntry {
  readonly how: "sign-in";
  readonly app: "claude" | "chatgpt" | "muse";
  readonly name: string;
  readonly mark: string;
  readonly site: string;
  readonly hosts: readonly string[];
  readonly from: string | null;
  readonly need: string;
  readonly link: string;
  readonly first: (on: On, link: Link) => Step;
  readonly hint: string;
  readonly phone: boolean;
}

interface KeyEntry {
  readonly how: "key";
  readonly app: KeyApp;
  readonly name: string;
  readonly mark: string;
  readonly site: null;
  readonly hosts: readonly string[];
  readonly need: string;
  readonly line: string | null;
  readonly whole: readonly On[];
  readonly steps: (sees: Step) => Step[];
  readonly done: Guide["done"];
}

type Entry = SignInEntry | KeyEntry;

const added = (name: string, path: string[], url: string, then: string) => (on: On, link: Link): Step => ({
  kind: "add", title: `Add Lifestream to ${name}`, where: on === "mac" ? "In the sidebar" : "On a computer", path, values: [LIFESTREAM, address(url)], then, open: on === "mac" ? link : null,
});

const yes = (entry: SignInEntry, on: On): Step => {
  const { name } = entry;
  const click = entry.phone ? press(on) : "click";
  return {
    kind: "yes", title: "Say yes here", line: `${name} opens Lifestream’s sign-in page. Its number comes here.`, wait: `Waiting for ${name}`, hint: entry.hint,
    sees: SEES, other: `A sign-in from ${HOST_SLOT} is waiting`,
    wrong: `That wasn’t the number ${name} showed. In ${name}, ${click} Connect to try again.`,
    finishing: `Finishing in ${name}…`,
    unfinished: `${name} did not finish. In ${name}, ${click} Connect again.`,
    out: `The request ended. In ${name}, ${click} Connect to ask again.`,
    denied: `Not allowed. ${name} can’t read your Lifestream.`,
    reads: `${name} can read your Lifestream`,
  };
};

const asked = (line: string): Guide["done"]["ask"] => ({ title: ASK_TITLE, line, question: QUESTION });

const CATALOG: readonly Entry[] = [
  {
    how: "sign-in", app: "claude", name: "Claude", mark: "claude", site: "claude.ai", hosts: ["claude.ai", "claude.com"], from: null,
    need: "Needs Claude on the web. A free account can add one custom connector.", link: "https://claude.ai/",
    first: added("Claude", ["Plugins", "Connectors", "Add", "Add custom connector"], "MCP server URL", "Click Continue, then Add, then Connect."),
    hint: "Nothing yet? In Claude, click Install or Connect.", phone: false,
  },
  {
    how: "sign-in", app: "chatgpt", name: "ChatGPT", mark: "chatgpt", site: "chatgpt.com", hosts: ["chatgpt.com"], from: null,
    need: "Needs ChatGPT on the web, on a Pro, Business, Enterprise or Edu plan.", link: "https://chatgpt.com/",
    first: added("ChatGPT", ["Plugins", "Add", "Add custom MCP server"], "Server URL", "Leave the rest as it is. Tick I understand, then Create as a plugin, then Install."),
    hint: "Nothing yet? In ChatGPT, click Install or Connect.", phone: false,
  },
  {
    how: "sign-in", app: "muse", name: "Muse", mark: "muse", site: "muse.ai", hosts: ["agent.meta.ai"], from: "From agent.meta.ai, where Muse runs",
    need: "Needs Muse on the web.", link: "https://muse.ai/",
    first: (on, link) => ({
      kind: "message", title: "Ask Muse to connect", line: `In a new side chat, send this. Then ${press(on)} Connect on the card Muse shows.`,
      value: address("Message", MUSE_MESSAGE), open: link, next: null,
    }),
    hint: "Nothing yet? Ask Muse to finish setting up the connector.", phone: true,
  },
  {
    how: "key", app: "grok-bot", name: "Grok Bot", mark: "grok-bot", site: null, hosts: [], need: "Needs the Grok Bot desktop app.", line: null, whole: ["mac"],
    steps: (sees) => [sees, {
      kind: "give", title: "Add Lifestream to Grok Bot", where: "In Grok Bot", path: ["Connect apps", "Add a custom connector"],
      then: "Type: Remote HTTPS. Then click Add plugin.", warn: null, once: ONCE, unknown: unknown("Grok Bot"),
    }],
    done: { title: "Grok Bot is connected", ask: asked("In a Grok Bot chat, send this:"), open: null },
  },
  {
    how: "key", app: "instinct", name: "Instinct", mark: "instinct", site: null, hosts: [], need: "Needs Instinct in Messages.", line: null, whole: ["mac", "phone"],
    steps: (sees) => [
      {
        kind: "message", title: "Ask Instinct for a secure link", line: "Text Instinct this, then wait for its link.",
        value: { label: "Message", text: INSTINCT_MESSAGE, address: false }, open: MESSAGES, next: "I have the link",
      },
      sees,
      { kind: "give", title: "Paste them into the secure link", where: null, path: [], then: null, warn: "Paste the key only into the secure link, never into Messages.", once: ONCE, unknown: unknown("Instinct") },
    ],
    done: { title: "Instinct is connected", ask: asked("Text Instinct this:"), open: MESSAGES },
  },
  {
    how: "key", app: "another", name: "Another agent", mark: "add", site: null, hosts: [], need: "For an app that takes an address and a key.",
    line: "Claude Code, Cursor, a script", whole: ["mac"],
    steps: (sees) => [
      { kind: "name", title: "Name the app", placeholder: "Claude Code" },
      sees,
      { kind: "give", title: `Give ${NAME_SLOT} the address and the key`, where: null, path: [], then: null, warn: null, once: ONCE, unknown: unknown(NAME_SLOT) },
    ],
    done: { title: `${NAME_SLOT} is connected`, ask: null, open: null },
  },
];

const SIGN_INS = CATALOG.filter((entry): entry is SignInEntry => entry.how === "sign-in");

export function appOfHost(host: string | null): SignInEntry["app"] | null {
  return host === null ? null : SIGN_INS.find((entry) => entry.hosts.includes(host))?.app ?? null;
}

export function appOfReader(reader: Pick<GuideReader, "kind" | "via" | "from" | "app">): GuideApp | null {
  if (reader.kind !== "agent") return null;
  return reader.via === "sign-in" ? appOfHost(reader.from) : reader.app;
}

export function markOf(reader: Pick<GuideReader, "kind" | "via" | "from" | "app">): string {
  if (reader.kind === "chat") return CHAT_MARK;
  const app = appOfReader(reader);
  return app === null ? DEFAULT_MARK : entryOf(app).mark;
}

export function nameOf(app: GuideApp): string {
  return entryOf(app).name;
}

export function signInFrom(app: SignInEntry["app"], host: string): string {
  return SIGN_INS.find((entry) => entry.app === app)?.from ?? `From ${host}`;
}

export function keyWholeOn(app: KeyApp, device: DeviceKind | null): boolean {
  const entry = entryOf(app);
  return entry.how === "key" && entry.whole.includes(device === "phone" ? "phone" : "mac");
}

export function siteOf(app: GuideApp): string | null {
  return entryOf(app).site;
}

function entryOf(app: GuideApp): Entry {
  return CATALOG.find((entry) => entry.app === app)!;
}

function connectedOf(app: GuideApp, readers: readonly GuideReader[]): string | null {
  const newest = readers
    .filter((reader) => reader.disconnected_ms === null && appOfReader(reader) === app)
    .reduce<GuideReader | null>((held, reader) => (held === null || reader.made_ms > held.made_ms ? reader : held), null);
  return newest?.id ?? null;
}

function guideOf(entry: Entry, on: On, readers: readonly GuideReader[], sees: (name: string) => Sees): Guide {
  const head = { app: entry.app, name: entry.name, mark: entry.mark, how: entry.how, connected: connectedOf(entry.app, readers), head: `Connect ${entry.name}`, need: entry.need, hosts: [...entry.hosts] };
  if (entry.how === "sign-in") {
    const link = web(entry.name, entry.link);
    return {
      ...head, line: null, address: setup(entry.name, on),
      steps: [entry.first(on, link), yes(entry, on)],
      done: { title: `${entry.name} is connected`, ask: asked(`In a new ${entry.name} chat, send this:`), open: link },
    };
  }
  const named = entry.app === "another" ? NAME_SLOT : entry.name;
  const seen = sees(entry.name);
  const whole = entry.whole.includes(on);
  const steps = whole
    ? entry.steps({ kind: "sees", title: `Choose what ${named} sees`, make: MAKE, sees: SEES, access: seen.access, view: seen.view })
    : [{ kind: "elsewhere" as const, title: "On your Mac", line: `${entry.name} runs on your Mac. Connect it in Lifestream there.` }];
  return { ...head, line: entry.line, address: whole && entry.app !== "another" ? setup(entry.name, on) : null, steps, done: entry.done };
}

export function guidesOf(readers: readonly GuideReader[], device: DeviceKind | null, sees: (name: string) => Sees): Guides {
  const on: On = device === "phone" ? "phone" : "mac";
  return { title: TITLE, apps: CATALOG.map((entry) => guideOf(entry, on, readers, sees)) };
}
