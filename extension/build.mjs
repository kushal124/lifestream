import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const store = process.argv.includes("--store");
const named = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
const development = process.env.LIFESTREAM_DEVELOPMENT === "1";
if (store && development) throw new Error("a store build is never a development one: build it without LIFESTREAM_DEVELOPMENT");
if (store && named !== undefined) throw new Error("a store build goes to store/: name no folder");
const door = process.env.LIFESTREAM_DOOR ?? "http://127.0.0.1:4680";
if (store && process.env.LIFESTREAM_DOOR !== undefined) throw new Error("a store build connects to this Mac's door: build it without LIFESTREAM_DOOR");
const generation = store ? stamp() : null;
const out = store ? join(here, "store", "dist") : (named ?? join(here, "dist"));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const tokens = JSON.parse(readFileSync(join(here, "..", "design", "tokens.json"), "utf8"));
const colour = (name, within = tokens) => {
  if (within?.name === name && typeof within.value?.dark === "string") return within.value.dark;
  for (const each of typeof within === "object" && within !== null ? Object.values(within) : []) {
    const found = typeof each === "object" ? colour(name, each) : undefined;
    if (found !== undefined) return found;
  }
  if (within === tokens) throw new Error(`design/tokens.json has no colour ${name}`);
  return undefined;
};
const badge = { background: colour("caution"), text: colour("on-signal") };
const common = {
  bundle: true, target: "chrome120", logLevel: "warning", legalComments: "none",
  define: { LIFESTREAM_DEVELOPMENT: String(development), LIFESTREAM_DOOR: JSON.stringify(door), LIFESTREAM_BADGE: JSON.stringify(badge), LIFESTREAM_GENERATION: String(generation) },
};
await build({ ...common, entryPoints: [join(here, "worker.ts")], outfile: join(out, "worker.js"), format: "esm" });
await build({ ...common, entryPoints: [join(here, "page-entry.ts")], outfile: join(out, "page.js"), format: "iife" });
await build({ ...common, entryPoints: [join(here, "options.ts")], outfile: join(out, "options.js"), format: "iife" });
await build({ ...common, entryPoints: [join(here, "popup.ts")], outfile: join(out, "popup.js"), format: "iife" });
await build({ ...common, entryPoints: [join(here, "allow.ts")], outfile: join(out, "allow.js"), format: "iife" });
await build({ ...common, entryPoints: [join(here, "blank.ts")], outfile: join(out, "blank.js"), format: "iife" });
const { key: _key, ...manifest } = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
mkdirSync(join(out, "icons"));
for (const file of ["manifest.json", "options.html", "popup.html", "allow.html", "blank.html", "pages.css", ...Object.values(manifest.icons)]) {
  copyFileSync(join(here, file), join(out, file));
}
for (const file of ["design/css/cockpit.css", "design/css/kit.css", "dashboard/public/loader.svg", "dashboard/public/loader-still.svg"]) {
  copyFileSync(join(here, "..", file), join(out, basename(file)));
}

if (store) {
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const zip = join(here, "store", `lifestream-${manifest.version}.zip`);
  rmSync(zip, { force: true });
  const zipped = spawnSync("zip", ["-q", "-r", "-X", zip, "."], { cwd: out, encoding: "utf8" });
  if (zipped.status !== 0) throw new Error(`zip failed: ${zipped.error?.message ?? zipped.stderr}`);
  console.log(`built ${zip} for the Chrome Web Store, generation ${generation}`);
} else {
  console.log(`built ${out}${development ? " (development: reloads when the door asks)" : ""}`);
}

function stamp() {
  const git = (...args) => spawnSync("git", args, { cwd: here, encoding: "utf8" });
  const refuse = (why) => {
    throw new Error(`a store build is made from a clean commit on origin/main: ${why}`);
  };
  const status = git("status", "--porcelain");
  if (status.status !== 0) refuse(`git cannot read this tree (${status.stderr.trim()})`);
  if (status.stdout.trim() !== "") refuse(`commit or remove what is uncommitted first:\n${status.stdout.trimEnd()}`);
  const fetched = git("fetch", "--quiet", "origin", "main");
  if (fetched.status !== 0) refuse(`origin/main could not be fetched (${fetched.stderr.trim()})`);
  if (git("merge-base", "--is-ancestor", "HEAD", "origin/main").status !== 0) refuse(`${git("rev-parse", "--short", "HEAD").stdout.trim()} is not on origin/main: push it to main first`);
  return Number(git("rev-list", "--count", "HEAD").stdout.trim());
}
