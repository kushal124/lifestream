import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const MAC_ONLY = "testing/mac-only.txt";
export const QUARANTINE = "testing/quarantine.txt";

const PRIORITY: Record<string, readonly string[]> = {
  dashboard: [
    "test/onboarding-after.mjs",
    "test/flows-after.mjs",
    "test/ask-page.mjs",
    "test/tour-walk.mjs",
    "test/tour-first.mjs",
    "test/ask-media.mjs",
    "test/onboarding-journey.mjs",
    "test/places.mjs",
    "test/places-instant.mjs",
    "test/place-circle.mjs",
    "test/photo-viewer.mjs",
    "test/people-edit.mjs",
    "test/llm-web.mjs",
    "test/people-page.mjs",
    "test/video.mjs",
    "test/faces.mjs",
    "test/settings-kit.mjs",
    "test/days-side.mjs",
    "test/days-reveal.mjs",
    "test/days-picker.mjs",
    "test/days-folded.mjs",
    "test/days-unnamed.mjs",
    "test/days-clock.mjs",
    "test/people-deck.mjs",
    "test/people-groups.mjs",
    "test/imports.mjs",
    "test/imports-backups.mjs",
    "test/agents.mjs",
    "test/access-page.mjs",
    "test/connector-page.mjs",
    "test/settings-pages.mjs",
    "test/settings-storage.mjs",
    "test/privacy-pages.mjs",
    "test/storage-page.mjs",
    "test/sidebar.mjs",
    "test/faces-sitting.mjs",
    "test/kit-reach.mjs",
    "test/gallery.mjs",
    "test/flows-gallery.mjs",
    "test/map-order.mjs",
    "test/page-head.mjs",
    "test/stream-names.mjs",
  ],
  mcp: [
    "test/e2e.mjs",
    "test/media.mjs",
    "test/claude-turns.mjs",
    "test/privacy.mjs",
    "test/claude.mjs",
    "test/claude-picks.mjs",
    "test/sign-in.mjs",
    "test/agents-call.mjs",
    "test/agent-signin.mjs",
    "test/on-claude.mjs",
    "test/asking.mjs",
    "test/conversations.mjs",
    "test/tools.mjs",
    "test/door.mjs",
  ],
};

function lines(root: string, list: string): { path: string; reason: string; line: number }[] {
  return readFileSync(join(root, list), "utf8").split("\n").flatMap((text, index) => {
    const [path, ...reason] = text.trim().split(/\s+/u);
    return path === undefined || path === "" || path.startsWith("#") ? [] : [{ path, reason: reason.join(" "), line: index + 1 }];
  });
}

export function macOnly(root = ROOT): { path: string; reason: string; line: number }[] {
  return lines(root, MAC_ONLY);
}

export function quarantined(root = ROOT): { path: string; reason: string; line: number }[] {
  return lines(root, QUARANTINE);
}

export function leftOut(): string[] {
  return [...quarantined(), ...(process.platform === "darwin" ? [] : macOnly())].map((entry) => entry.path);
}

export function nodeTests(folder: string): string[] {
  const out = new Set(leftOut());
  const files = readdirSync(join(ROOT, folder, "test")).filter((name) => name.endsWith(".mjs")).sort()
    .map((name) => `test/${name}`).filter((file) => !out.has(`${folder}/${file}`));
  const order = PRIORITY[folder];
  if (order === undefined) return files;
  const rank = new Map(order.map((file, index) => [file, index]));
  return files.sort((left, right) => {
    const leftRank = rank.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank !== rightRank ? leftRank - rightRank : left.localeCompare(right);
  });
}

export function googleChrome(): string {
  return process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "/usr/bin/google-chrome";
}

export function chromeForTesting(): string | null {
  const cache = join(process.platform === "darwin" ? join(homedir(), "Library", "Caches") : process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "ms-playwright");
  const installs = existsSync(cache) ? readdirSync(cache).filter((name) => /^chromium-\d+$/u.test(name)) : [];
  for (const dir of installs.sort((left, right) => Number(right.slice("chromium-".length)) - Number(left.slice("chromium-".length)))) {
    for (const binary of [
      join(cache, dir, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
      join(cache, dir, "chrome-mac", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
      join(cache, dir, "chrome-linux64", "chrome"),
    ]) if (existsSync(binary)) return binary;
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.stdout.write(`${nodeTests(process.argv[2] ?? "").join("\n")}\n`);
