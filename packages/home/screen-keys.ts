
export interface ScreenKey {
  app: string;
  site: string;
  name: string;
  title: string;
}

export const VIDEO_SITES: ReadonlyMap<string, string> = new Map([
  ["youtube.com", "YouTube"],
  ["m.youtube.com", "YouTube"],
  ["vimeo.com", "Vimeo"],
  ["twitch.tv", "Twitch"],
  ["netflix.com", "Netflix"],
]);

export interface ProductWindows {
  apps: readonly string[];
  sites: readonly string[];
}

export const PRODUCT_WINDOWS: ReadonlyMap<string, Partial<ProductWindows>> = new Map<string, Partial<ProductWindows>>([
  ["whatsapp", { apps: ["WhatsApp"], sites: ["web.whatsapp.com"] }],
  ["imessage", { apps: ["Messages"] }],
  ["gmail", { sites: ["mail.google.com"] }],
  ["chatgpt", { apps: ["ChatGPT"], sites: ["chatgpt.com", "chat.openai.com"] }],
  ["claude", { apps: ["Claude"], sites: ["claude.ai"] }],
  ["codex", { apps: ["Codex"] }],
  ["apple-notes", { apps: ["Notes"] }],
  ["apple-calendar", { apps: ["Calendar"] }],
  ["apple-reminders", { apps: ["Reminders"] }],
  ["google-calendar", { sites: ["calendar.google.com"] }],
  ["granola", { apps: ["Granola"] }],
  ["spotify", { apps: ["Spotify"], sites: ["open.spotify.com"] }],
  ["github", { sites: ["github.com"] }],
  ["x", { sites: ["x.com", "twitter.com"] }],
  ["instagram", { sites: ["instagram.com"] }],
  ["facebook", { sites: ["facebook.com"] }],
  ["apple-photos", { apps: ["Photos"] }],
  ["google-photos", { sites: ["photos.google.com"] }],
  ["safari", { apps: ["Safari"] }],
  ["chrome", { apps: ["Google Chrome"] }],
]);

export function productWindows(products: readonly string[]): ProductWindows | undefined {
  const rows = products.map((product) => PRODUCT_WINDOWS.get(product));
  if (rows.length === 0 || rows.some((row) => row === undefined)) return undefined;
  return { apps: [...new Set(rows.flatMap((row) => row!.apps ?? []))], sites: [...new Set(rows.flatMap((row) => row!.sites ?? []))] };
}

const ROLE = /^\[(\w+)\] /u;
const CURSOR = /^▶ cursor here: /u;

interface NameRow {
  app: RegExp;
  patterns: RegExp[];
}

export const NAMES: readonly NameRow[] = [
  { app: /^Codex$/u, patterns: [/^(?:\[\w+\] )?Thread actions for (.+)$/u] },
  { app: /^Claude$/u, patterns: [/^(?:\[\w+\] )?(.+), rename session$/u] },
  {
    app: /^WhatsApp$/u,
    patterns: [/^(?:\[\w+\] )?Start (?:video|voice) call with (.+)$/u, /^(?:\[\w+\] )?Messages in chat with (.+)$/u],
  },
];

const HEADING = /^\[Heading\] (.+)$/u;

const COUNT = /(?:^|\s)[([]\d+\+?[)\]](?=\s|$)/gu;
const SOUND = /[🔊🔈🔉🔇]|\s[-–—]\s(?:Audio playing|Playing audio)\b/gu;
const VERSION = /\s(?:[-–—]\s)?(?:(?:Version|v)\s?\d+(?:\.\d+)+(?:\s\(\d+\))?|\d+\.\d+\.\d+(?:\.\d+)?)(?=\s|$)/giu;
const LEADING = /^[\s•●○◐◑◒◓✳✶✻✽✢*·⠀-⣿⏺⏸▶■□◆◇★☆]+/u;
const ELLIPSIS = /\s*…\s*/gu;

export function cleanTitle(title: string | null): string {
  if (title === null) return "";
  return title
    .replace(SOUND, " ")
    .replace(COUNT, " ")
    .replace(VERSION, " ")
    .replace(LEADING, "")
    .replace(ELLIPSIS, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function siteOf(site: string | null): string {
  return site === null ? "" : site.toLowerCase().replace(/^www\./u, "");
}

export function keyOf(app: string, site: string | null, title: string | null, lines: readonly string[]): ScreenKey {
  return keyOfFrame(app, site, title, () => lines);
}

export function keyOfFrame(app: string, site: string | null, title: string | null, lines: () => readonly string[]): ScreenKey {
  const host = siteOf(site);
  const cleaned = cleanTitle(title);
  const shown = title ?? "";
  const video = VIDEO_SITES.get(host);
  if (video !== undefined && sameName(cleaned, video)) {
    const heading = firstMatch(lines(), [HEADING]);
    if (heading !== null) return { app, site: host, name: heading, title: shown };
  }
  if (cleaned === "" || sameName(cleaned, app)) {
    const row = NAMES.find((candidate) => candidate.app.test(app));
    const named = row === undefined ? null : firstMatch(lines(), row.patterns);
    if (named !== null) return { app, site: host, name: named, title: shown };
  }
  return { app, site: host, name: cleaned, title: shown };
}

function sameName(title: string, name: string): boolean {
  return title.toLowerCase() === name.toLowerCase();
}

function firstMatch(lines: readonly string[], patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    for (const line of lines) {
      const found = pattern.exec(line.replace(CURSOR, ""))?.[1]?.trim();
      if (found !== undefined && found !== "") return found;
    }
  }
  return null;
}

export function plainLine(line: string): string {
  return line.replace(CURSOR, "").replace(ROLE, "").replace(/\s+/gu, " ").trim();
}

const DOCUMENT_APPS = /^(?:Preview|Books|Adobe Acrobat(?: Reader)?|Skim)$/u;

export function documentLike(app: string, title: string | null): boolean {
  return DOCUMENT_APPS.test(app) || /\.pdf\b/iu.test(title ?? "");
}

export function proseChars(lines: readonly string[], document: boolean): number {
  const [chars, words] = document ? [50, 8] : [100, 12];
  let total = 0;
  for (const raw of lines) {
    const line = plainLine(raw);
    if (line.length < chars) continue;
    if ((line.match(/\|/gu)?.length ?? 0) >= 2) continue;
    if (line.split(" ").length < words) continue;
    if (!/[.!?。]/u.test(line)) continue;
    const letters = line.match(/[\p{L}\s]/gu)?.length ?? 0;
    if (letters < 0.8 * line.length) continue;
    total += line.length;
  }
  return total;
}
