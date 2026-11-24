import { askFor, chosen, CONNECTING_MS, link, needsNow, setUpOrigins, STATUS_KEY, withheld, type Status } from "./chrome.js";
import { button, iconButton, paint, redrawOn, settingRow, settingsSection, standing, statusStrip, toggle, wayOut } from "./look.js";
import type { Act, Need, Site } from "./wire.js";

const OPENED_MS = Date.now();


const said = new Map<string, string>();
const refusedOf = (name: string): string => `Chrome didn’t allow ${name}. Try again.`;
const asking = new Set<string>();
let missing = new Map<string, readonly string[]>();
const lacking = (sites: readonly Pick<Site, "origin" | "origins">[]): string[] =>
  [...new Set(sites.flatMap((site) => missing.get(site.origin) ?? setUpOrigins(site)))];

async function keep(choose: readonly string[], stop: readonly string[]): Promise<void> {
  const answer = await chrome.runtime.sendMessage({ to: "worker", choose, stop }).catch(() => ({ ok: false })) as { ok?: boolean; error?: string } | undefined;
  if (answer?.ok !== true) for (const id of [...choose, ...stop]) said.set(id, answer?.error ?? "Lifestream didn’t answer. Try again.");
}

function setUp(sites: readonly Site[]): void {
  const hosts = lacking(sites);
  for (const site of sites) asking.add(site.id);
  void render();
  const asked = askFor(hosts).then(
    () => sites.forEach((site) => said.delete(site.id)),
    () => sites.forEach((site) => said.set(site.id, refusedOf(site.name))),
  );
  void asked.then(() => keep(sites.map((site) => site.id), [])).finally(() => {
    for (const site of sites) asking.delete(site.id);
    void render();
  });
}

const opened = (need: Need): Promise<{ ok?: boolean; error?: string } | undefined> =>
  chrome.runtime.sendMessage({ to: "worker", opened: need }).catch(() => ({ ok: false }));

const pressed = (act: Extract<Act, { do: "try" | "skip" | "read" | "ignore" }>): Promise<{ ok?: boolean; error?: string } | undefined> =>
  chrome.runtime.sendMessage({ to: "worker", act }).catch(() => ({ ok: false }));

function run(need: Need, act: Act): void {
  switch (act.do) {
    case "allow":
      void askFor(lacking([{ origin: act.origin, origins: [act.origin] }])).catch(() => said.set(need.id, refusedOf(new URL(act.origin).hostname))).then(render);
      return;
    case "chrome":
      void chrome.tabs.create({ url: act.url }).then(() => window.close());
      return;
    case "open":
      void Promise.all([opened(need), chrome.tabs.create({ url: act.url })]).then(() => window.close());
      return;
    default:
      void pressed(act).then((answer) => {
        if (answer?.ok !== true) said.set(need.id, answer?.error ?? "Lifestream didn’t answer. Try again.");
        return render();
      });
  }
}

function reach(need: Need): void {
  void opened(need).then((answer) => {
    if (answer?.ok === true) return window.close();
    said.set(need.id, answer?.error ?? "Lifestream didn’t answer. Try again.");
    return render();
  });
}

function buttons(need: Need, drawn: Map<string, () => void>): { label: string; key: string }[] {
  const at = need.at?.errand != null ? { label: "Open", run: () => reach(need) }
    : need.at?.open != null ? { label: "Open", run: () => run(need, { do: "open", label: "Open", url: need.at!.open! }) } : null;
  const acts = need.acts.filter((act) => at === null || act.do !== "open").map((act) => ({ label: act.label, run: () => run(need, act) }));
  return [...(at === null ? [] : [at]), ...acts].map((each, n) => {
    const key = `need:${need.id}:${n}`;
    drawn.set(key, each.run);
    return { label: each.label, key };
  });
}

function about(need: Need, site: Site): boolean {
  const allows = need.acts.flatMap((act) => (act.do === "allow" ? [act.origin] : []));
  if (allows.length > 0) return allows.includes(site.origin);
  return need.at?.site === new URL(site.origin).host || need.connector === site.id;
}

const signIn = (site: Site): string =>
  site.account != null ? `Signed in as ${site.account.email}` : site.signed_in === true ? "Signed in" : site.signed_in === false ? "Not signed in" : "";

let acts = new Map<string, () => void>();

function account(site: Site, on: boolean, need: Need | undefined, reading: boolean, drawn: Map<string, () => void>): string {
  drawn.set(`site:${site.id}`, () => (on ? void keep([], [site.id]).then(render) : setUp([site])));
  const words = said.get(site.id) ?? (need === undefined ? undefined : said.get(need.id));
  const line = words !== undefined ? { line: words }
    : need !== undefined ? { line: need.words, signal: "caution" as const }
      : on && reading ? { line: "Reading now", signal: "engaged" as const, pulse: true }
        : { line: signIn(site) };
  const acts = need === undefined ? "" : buttons(need, drawn).map((each) => button(each.label, { attrs: { "data-act": each.key } })).join("");
  const end = acts + toggle({ on, label: `Read ${site.name}`, busy: asking.has(site.id), attrs: { "data-act": `site:${site.id}` } });
  return settingRow({ label: site.name, ...line, end, dim: !on });
}

let drawing = 0;

async function render(): Promise<void> {
  const mine = ++drawing;
  const root = document.getElementById("root");
  if (root === null) return;
  const drawn = new Map<string, () => void>();
  const status = (await chrome.storage.session.get(STATUS_KEY))[STATUS_KEY] as Status | undefined;
  const now = await link(Date.now() - OPENED_MS);
  drawn.set("settings", () => void chrome.runtime.openOptionsPage());
  const head = `<header class="ls-head"><div id="standing" class="ls-standing">${standing(now)}</div>`
    + iconButton("settings", "Settings", { attrs: { "data-act": "settings" } }) + `</header>${wayOut(now)}`;
  if (!now.paired) {
    if (mine !== drawing) return;
    drawn.set("pair", () => void chrome.runtime.openOptionsPage());
    acts = drawn;
    return paint(root, head + `<div class="ls-pair">${button("Pair with another computer…", { variant: "plain", size: "sm", attrs: { "data-act": "pair" } })}</div>`);
  }

  const sites = [...(status?.sites ?? [])].filter((site) => site.form !== true).sort((a, b) => Number(b.signed_in === true) - Number(a.signed_in === true));
  const picked = new Set(await chosen());
  const needs = await needsNow(status?.needs ?? [], status?.sites ?? []);
  const withholds = new Map(await Promise.all((status?.sites ?? []).map(async (site) => [site.origin, await withheld([site])] as const)));
  const running = status?.errands ?? [];
  const held = new Set<Need>();
  const rows = sites.map((site) => {
    const need = needs.find((each) => !held.has(each) && about(each, site));
    if (need !== undefined) held.add(need);
    return account(site, picked.has(site.id), need, running.some((errand) => errand.origins.includes(site.origin)), drawn);
  });
  const loose = needs.filter((need) => !held.has(need)).map((need) => ({
    tone: need.state === "broken" ? "warning" as const : "caution" as const, title: need.words, line: said.get(need.id) ?? need.at?.site ?? "",
    actions: buttons(need, drawn).map((each) => ({ label: each.label, attrs: { "data-act": each.key } })),
  }));
  const off = sites.filter((site) => !picked.has(site.id));
  drawn.set("all", () => setUp(off));
  const all = off.length > 1 ? button("Set up all", { variant: "plain", attrs: { "data-act": "all" } }) : "";
  const accounts = settingsSection({ heading: "Accounts", act: all, rows, attrs: { id: "accounts" } });
  if (mine !== drawing) return;
  acts = drawn;
  missing = withholds;
  return paint(root, head + `<div id="connected" class="ls-body">${loose.length === 0 ? "" : `<div id="needs" class="ck-strips">${loose.map((need) => statusStrip(need)).join("")}</div>`}${accounts}</div>`);
}

document.addEventListener("click", (event) => {
  const act = (event.target as Element | null)?.closest?.("[data-act]")?.getAttribute("data-act");
  if (act !== undefined && act !== null) acts.get(act)?.();
});
void chrome.runtime.sendMessage({ to: "worker", survey: true }).catch(() => undefined);
void render();
redrawOn(() => void render());
const deadline = setInterval(() => {
  clearInterval(deadline);
  void render();
}, CONNECTING_MS);
