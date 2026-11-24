import { setIcons } from "../dashboard/public/ui/kit/icon.js";
import icons from "../design/icons.json" with { type: "json" };
import { signal } from "../dashboard/public/ui/kit/signal.js";
import { esc } from "../dashboard/public/lib/html.js";
import type { Link } from "./chrome.js";

setIcons(icons);

export { signal } from "../dashboard/public/ui/kit/signal.js";
export { statusStrip } from "../dashboard/public/ui/kit/status-strip.js";
export { button, iconButton } from "../dashboard/public/ui/kit/button.js";
export { textField, toggle } from "../dashboard/public/ui/kit/controls.js";
export { settingRow, settingsSection, settingTile } from "../dashboard/public/ui/kit/setting-row.js";
export { inPlaceLine } from "../dashboard/public/ui/kit/states.js";
export { esc } from "../dashboard/public/lib/html.js";

const drawn = new WeakMap<Element, string>();

export function paint(root: Element, html: string): void {
  if (drawn.get(root) === html) return;
  drawn.set(root, html);
  root.innerHTML = html;
}

export function standing(link: Link): string {
  if (link.signal !== "loading") return signal(link.signal, link.word, { detail: link.where ?? "", strong: true });
  return `<span class="ck-signal ck-signal--idle"><span class="ls-wait" aria-hidden="true"></span><span class="ck-signal__label mac-headline">${esc(link.word)}</span>`
    + (link.where === undefined ? "" : `<span class="ck-signal__detail mac-footnote">${esc(link.where)}</span>`) + "</span>";
}

export const wayOut = (link: Link): string => (link.then === undefined ? "" : `<p class="ls-then mac-footnote">${esc(link.then)}</p>`);

export function redrawOn(draw: () => void): void {
  chrome.storage.onChanged.addListener(() => draw());
  chrome.permissions.onAdded.addListener(() => draw());
  chrome.permissions.onRemoved.addListener(() => draw());
}
