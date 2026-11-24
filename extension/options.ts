import { CONNECTING_MS, keepUnit, link, PAIRING_KEY, stationUnit } from "./chrome.js";
import { doorPermission, doorUrl, onThisMac, pair, PlainHttp, type Pairing } from "./link.js";
import { BelowFloor } from "./station.js";
import { button, inPlaceLine, paint, redrawOn, settingsSection, standing, textField, wayOut } from "./look.js";

const OPENED_MS = Date.now();


const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const part = (label: string, field: string, kind = ""): string =>
  `<label class="ls-part${kind}"><span class="ls-part__label">${label}</span>${field}</label>`;

paint($("pairing"), settingsSection({
  heading: "Pair with another computer",
  line: "On the Mac that runs Lifestream, this browser connects by itself. From another computer, type that Mac’s address and the 8-digit code Lifestream shows on it in Settings › iPhone › Show code.",
  act: button("Pair", { variant: "primary", attrs: { type: "submit" } }),
  body: '<div class="ls-pairing">'
    + part("Computer", textField({ label: "Computer", placeholder: "100.x.y.z or https://…", attrs: { id: "url" } }))
    + part("Code", textField({ label: "Code", placeholder: "8 digits", attrs: { id: "code", inputmode: "numeric", pattern: "[0-9]{4} ?[0-9]{4}", maxlength: "9" } }), " ls-part--code")
    + '</div><div id="pair-error"></div>',
}));

let drawing = 0;

async function render(): Promise<void> {
  const mine = ++drawing;
  const pairing = (await chrome.storage.local.get(PAIRING_KEY))[PAIRING_KEY] as Pairing | undefined;
  if (pairing !== undefined && document.activeElement?.tagName !== "INPUT") $<HTMLInputElement>("url").value = onThisMac(pairing.url) ? "" : pairing.url;
  const now = await link(Date.now() - OPENED_MS);
  if (mine !== drawing) return;
  paint($("status"), settingsSection({ heading: "Lifestream",
    body: `<span id="standing" class="ls-standing">${standing(now)}</span>${wayOut(now)}` }));
}

function failed(sentence: string): void {
  paint($("pair-error"), sentence === "" ? "" : inPlaceLine(sentence));
}

$("pairing").addEventListener("submit", (event) => {
  event.preventDefault();
  const url = $<HTMLInputElement>("url").value.trim();
  const code = $<HTMLInputElement>("code").value.replace(/\s/gu, "");
  if (url === "" || code === "") return;
  failed("");
  let door: string;
  try {
    door = doorUrl(url);
  } catch (error) {
    failed(error instanceof PlainHttp ? error.message : "That isn’t a computer’s name or address.");
    return;
  }
  const wanted = doorPermission(door);
  const reachable = wanted === null ? Promise.resolve(true) : chrome.permissions.request({ origins: [wanted] });
  void (async () => {
    try {
      if (await reachable) {
        const paired = await pair(door, code, await stationUnit(), { version: chrome.runtime.getManifest().version });
        await keepUnit(paired.unit);
        await chrome.storage.local.set({ [PAIRING_KEY]: paired.pairing });
        $<HTMLInputElement>("code").value = "";
      } else failed(`Chrome didn’t allow Lifestream to reach ${new URL(door).hostname}. Pair again, and allow it.`);
    } catch (error) {
      failed(error instanceof BelowFloor ? "Lifestream on that computer needs a newer version of this extension."
        : "Couldn’t pair with that computer. Check its name and the code, then try again.");
    }
    await render();
  })();
});

void render();
redrawOn(() => void render());
const deadline = setInterval(() => {
  clearInterval(deadline);
  void render();
}, CONNECTING_MS);
