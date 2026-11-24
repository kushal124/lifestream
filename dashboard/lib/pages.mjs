// @ts-check
import { readFileSync } from 'node:fs';

export const CONTRACT = new URL('../../packages/home/contract/pages.json', import.meta.url);

/** @typedef {{ route: string, moves: string[], device: boolean }} PageEntry */

/** @type {Readonly<Record<string, PageEntry>>} */
export const PAGES = Object.freeze(Object.fromEntries(Object.entries(
  /** @type {{ pages: Record<string, PageEntry> }} */ (JSON.parse(readFileSync(CONTRACT, 'utf8'))).pages,
).map(([name, page]) => [name, { route: page.route, moves: [...page.moves], device: page.device }])));
