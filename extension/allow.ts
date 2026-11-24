import { askFor, STATUS_KEY, withheld, type Status } from "./chrome.js";
import { button, inPlaceLine, paint, redrawOn, settingRow, settingsSection, settingTile } from "./look.js";
import type { Site } from "./wire.js";


const wanted = new URLSearchParams(document.location.search).get("site");
let refused = "";
let asking = false;
let site: Site | undefined;
let missing: readonly string[] = [];

const close = (): void => void chrome.tabs.getCurrent().then((tab) => (tab?.id === undefined ? undefined : chrome.tabs.remove(tab.id))).catch(() => undefined);

function allow(): void {
  if (site === undefined || asking) return;
  asking = true;
  void render();
  const name = site.name;
  void askFor(missing).then(close, () => {
    asking = false;
    refused = `Chrome didn’t allow ${name}. Try again.`;
    void render();
  });
}

let drawing = 0;

async function render(): Promise<void> {
  const mine = ++drawing;
  const status = (await chrome.storage.session.get(STATUS_KEY))[STATUS_KEY] as Status | undefined;
  if (status === undefined) return;
  site = status.sites.find((each) => each.id === wanted);
  const lacking = site === undefined ? [] : await withheld([site]);
  if (site === undefined || (!asking && lacking.length === 0)) return close();
  if (mine !== drawing) return;
  if (!asking) missing = lacking;
  const allowing = button("Allow", { variant: "primary", busy: asking, attrs: { "data-act": "allow" } });
  paint(document.getElementById("root")!, settingsSection({ rows: [settingRow({
    label: site.name, lead: settingTile("web"), line: `Lifestream asks to read your ${site.name} here.`, end: allowing,
  })] }) + (refused === "" ? "" : inPlaceLine(refused)));
}

document.addEventListener("click", (event) => {
  if ((event.target as Element | null)?.closest?.("[data-act=allow]")) allow();
});
void render();
redrawOn(() => void render());
