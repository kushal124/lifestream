import { piecesText, render, textHead, type Json, type Piece } from "@lifestreamprotocol/core";
import { free, said, sayJoined } from "../shared/said.js";
import { CALL_TITLE, object, SOUND_TITLE } from "./sittings.js";
import { AFTER_END_MS, type FrameRow, type GapRow, type InputEvent, type MachineEvent, type SittingRead } from "./frames.js";

export const PART_BUDGET_CHARS = 450_000;
const ACT_BUDGET = 60;
const CHANGE_BUDGET = 40;
const MIN_PART_MS = 5 * 60_000;
const LAST_PART_MERGE_MS = 3 * 60_000;
const BLOCK_MS = 60 * 60_000;
const BLOCK_SNAP_MS = 10 * 60_000;
const MIN_LAST_BLOCK_MS = 15 * 60_000;
const ROW_JOIN_MS = 6_000;
const BLIND_MS = 10_000;
const SNAPSHOT_EVERY_MS = 60_000;
const RESULT_MS = 3_000;
const ECHO_MS = 10_000;
const SHORTCUT_MEANINGS: ReadonlyMap<string, string> = new Map([
  ["cmd+space", "open Spotlight"], ["cmd+tab", "switch app"], ["cmd+q", "quit the app"],
  ["cmd+w", "close the tab or window"], ["cmd+shift+w", "close the window"], ["cmd+t", "new tab"],
  ["cmd+shift+t", "reopen the closed tab"], ["cmd+n", "new window"], ["cmd+l", "go to the address bar"],
  ["ctrl+tab", "next tab"], ["ctrl+shift+tab", "previous tab"], ["cmd+digit", "go to that tab"],
  ["cmd+shift+]", "next tab"], ["cmd+shift+[", "previous tab"], ["cmd+[", "back"], ["cmd+]", "forward"],
  ["cmd+r", "reload"], ["cmd+f", "find"], ["cmd+c", "copy"], ["cmd+v", "paste"], ["cmd+x", "cut"],
  ["cmd+a", "select all"], ["cmd+z", "undo"], ["cmd+shift+z", "redo"], ["cmd+s", "save"],
  ["cmd+h", "hide the app"], ["cmd+m", "minimise the window"], ["cmd+`", "next window of the app"],
  ["cmd+,", "open settings"], ["cmd+k", "open the app's quick switcher or command menu"],
  ["cmd+return", "send or submit, in many apps"],
]);

export interface Clock {
  zone: string;
  hms(ms: number): string;
  day(ms: number): string;
}

export function clockOf(zone: string): Clock {
  return { zone, hms: (ms) => render(ms, zone, "s").slice(11), day: (ms) => render(ms, zone, "s").slice(0, 10) };
}

export function clockReader(anchor: number, clock: Clock): (hms: string) => number {
  const midnight = anchor - (anchor % 1000) - seconds(clock.hms(anchor)) * 1000;
  let floor = anchor - 3_600_000;
  return (hms) => {
    let ms = midnight + seconds(hms) * 1000;
    while (ms < floor) ms += 86_400_000;
    floor = Math.max(floor, ms - 3_600_000);
    return ms;
  };
}

function seconds(hms: string): number {
  const [h, m, s] = hms.split(":").map(Number);
  return h! * 3600 + m! * 60 + s!;
}

export interface Action {
  t: number;
  until?: number;
  kind: "typed" | "posted" | "pressed" | "erased" | "shortcut" | "scrolled" | "clicked" | "double-clicked" |
    "right-clicked" | "switched to" | "screen locked" | "screen unlocked" |
    "password field active (keys hidden)" | "password field closed";
  app?: string;
  site?: string;
  text?: string;
  keys?: number | string;
  into?: Piece[];
  on?: Piece[];
  poster?: string;
  dy?: number;
  meaning?: string;
  effect?: Piece[];
}

export interface Evidence {
  read: SittingRead;
  clock: Clock;
  actions: Action[];
  handsAt: number[];
  personal: InputEvent[];
}

export function evidenceOf(read: SittingRead, clock: Clock): Evidence {
  const actions = actionsFrom(read.events);
  return {
    read, clock, actions,
    handsAt: actions.filter((act) => act.kind !== "scrolled").map((act) => act.t).sort((l, r) => l - r),
    personal: read.events.filter(isPersonal),
  };
}


export interface PartCut {
  start_ms: number;
  end_ms: number;
  carry: Piece[];
  empty: boolean;
}

export interface BlockCut {
  start_ms: number;
  end_ms: number;
  parts: PartCut[];
}

export function blocksOf(evidence: Evidence, start: number, end: number): BlockCut[] {
  const { rows } = evidence.read;
  const real = evidence.handsAt;
  return blockBounds(rows, real, start, end).map(([a, b]): BlockCut => ({
    start_ms: a,
    end_ms: b,
    parts: partBounds(rows, real, a, b).map(([pa, pb], index): PartCut => ({
      start_ms: pa,
      end_ms: pb,
      carry: index === 0 && pa === start ? [] : carry(evidence, pa),
      empty: firstAtOrAfter(rows, pa) === firstAtOrAfter(rows, pb),
    })),
  }));
}

function changesIn(rows: readonly FrameRow[]): number[] {
  const changes: number[] = [];
  let previous = "";
  for (const row of rows) {
    const key = `${row.app}|${row.title}|${row.site}`;
    if (previous !== "" && key !== previous) changes.push(row.t);
    previous = key;
  }
  return changes;
}

function handsBusy(real: readonly number[], t: number): boolean {
  return countThrough(real, t) > countThrough(real, t - 30_000);
}

function blockBounds(rows: readonly FrameRow[], real: readonly number[], start: number, end: number): [number, number][] {
  const changes = changesIn(rows);
  const bounds: [number, number][] = [];
  let from = start;
  while (end - from > BLOCK_MS + MIN_LAST_BLOCK_MS) {
    const target = from + BLOCK_MS;
    const near = changes.slice(countBefore(changes, target), countThrough(changes, target + BLOCK_SNAP_MS));
    const at = near.find((t) => handsBusy(real, t)) ?? near[0] ?? target;
    if (end - at < MIN_LAST_BLOCK_MS) break;
    bounds.push([from, at]);
    from = at;
  }
  bounds.push([from, end]);
  return bounds;
}

function partBounds(rows: readonly FrameRow[], real: readonly number[], start: number, end: number): [number, number][] {
  const bounds: [number, number][] = [];
  let from = start;
  let changes = 0;
  for (const t of changesIn(within(rows, start, end))) {
    changes++;
    const acts = countBefore(real, t) - countBefore(real, from);
    if (t - from >= MIN_PART_MS && end - t >= MIN_PART_MS && handsBusy(real, t) && (acts >= ACT_BUDGET || changes >= CHANGE_BUDGET)) {
      bounds.push([from, t]);
      from = t;
      changes = 0;
    }
  }
  bounds.push([from, end]);
  if (bounds.length > 1 && bounds.at(-1)![1] - bounds.at(-1)![0] < LAST_PART_MERGE_MS) {
    const last = bounds.pop()!;
    bounds.at(-1)![1] = last[1];
  }
  return bounds;
}

export function appSeconds(rows: readonly FrameRow[], end: number): [string, number][] {
  const seconds = new Map<string, number>();
  rows.forEach((row, index) => {
    const next = Math.min(rows[index + 1]?.t ?? end, row.t + BLIND_MS);
    seconds.set(row.app, (seconds.get(row.app) ?? 0) + Math.max(0, next - row.t));
  });
  return [...seconds].map(([app, ms]): [string, number] => [app, Math.round(ms / 1000)])
    .sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1));
}

export function partEvidence(evidence: Evidence, a: number, b: number, end: number): Piece[] {
  const { read, clock } = evidence;
  const { hms } = clock;
  const rows = within(read.rows, a, b);
  const acts = withResults(evidence.actions, read.rows, a, b);
  const runs = timelineRuns(rows, a, b);
  const timeline = sayJoined(runs.map((run) => runLine(run, read, acts, evidence.personal, a, hms)), "\n");
  const actionText = sayJoined(acts.map((act) => actionLine(act, hms)), "\n");
  const last = b >= end;
  const machineText = sayJoined(within(read.machine, a - 60_000, last ? b + AFTER_END_MS : b)
    .map((event) => said`${hms(event.t)} ${machineLine(event)}${event.t >= b ? " (after this stretch ended)" : ""}`), "\n");
  const screen = screenText(rows, runs, acts, PART_BUDGET_CHARS - piecesText(timeline).length - piecesText(actionText).length, hms);
  const or = (pieces: Piece[], none: string): Piece[] | string => pieces.length > 0 ? pieces : none;
  return sayJoined([
    `STRETCH: ${hms(a)} to ${hms(b)} ${clock.zone}, ${clock.day(a)}`,
    `Sources: the screen (the app, window and website in front about every 2 s, with the text on screen; "marked idle" = no keyboard or mouse for a few seconds)${read.hasInput ? ", and the input log (every key, click and scroll)" : ""}.`,
    said`\n## 1. TIMELINE (every stretch where the app, window and site stayed the same)\n${or(timeline, "(nothing)")}`,
    said`\n## 2. MACHINE EVENTS${last ? " (and the first minutes after the person left the Mac)" : ""}\n${or(machineText, "(none)")}`,
    said`\n## 3. ACTIONS (from the input log; typed text is what the keys produced, deletes applied)\n${read.hasInput ? or(actionText, "(none)") : "(no input log for this time)"}`,
    said`\n## 4. SCREEN TEXT (page text at the start of each stretch, next to each action, and periodically; each window shows only lines it has not shown before)\n${sayJoined(screen, "\n")}`,
  ], "\n");
}

export function visibleOf(evidence: string): string {
  const sections = evidence.split(/\n\n## \d\. /u);
  return [sections[1], sections[3], sections[4]]
    .map((section) => section === undefined ? "" : section.slice(section.indexOf("\n") + 1)).join("\n");
}

function machineLine(event: MachineEvent): Piece[] {
  return said`${event.event}${Object.keys(event.detail).length > 0 ? said` ${free(JSON.stringify(event.detail))}` : ""}`;
}

function carry(evidence: Evidence, at: number): Piece[] {
  const { hms } = evidence.clock;
  const before = within(evidence.read.rows, at - 30 * 60_000, at);
  if (before.length === 0) return [];
  const last = before.at(-1)!;
  const calls = before.filter((row) => CALL_TITLE.test(row.title ?? ""));
  const live = calls.length > 0 && calls.at(-1)!.t >= at - 5 * 60_000;
  const lastInput = evidence.handsAt[countBefore(evidence.handsAt, at) - 1];
  return sayJoined([
    said`In front just before ${hms(at)}: ${placed(last)}.`,
    live ? said`A call window (“${free(calls.at(-1)!.title ?? "")}”) was open from at least ${hms(calls[0]!.t)} and was still open within the last 5 minutes before this part: treat the call as continuing unless this part shows it ending.` : null,
    before.slice(-15).some((row) => SOUND_TITLE.test(row.title ?? "")) ? "Sound was playing just before this part." : null,
    lastInput !== undefined ? `The last keyboard or mouse action before this part was at ${hms(lastInput)}.` : null,
  ].filter((line) => line !== null), " ");
}


function actionsFrom(events: readonly InputEvent[]): Action[] {
  const acts: Action[] = [];
  interface Typing {
    s: number; e: number; chars: string[]; keys: number; printed: number; named: string[];
    app?: string; site?: string; into: Piece[]; field: string; posted: boolean; poster?: string;
  }
  let typing: Typing | null = null;
  let scroll: { s: number; e: number; dy: number; dx: number; app?: string; site?: string } | null = null;
  const flushTyping = () => {
    if (typing === null) return;
    const done = typing as Typing;
    const words = done.chars.join("");
    const base = { t: done.s, until: done.e, keys: done.keys, into: done.into, ...where(done.app, done.site), ...(done.poster ? { poster: done.poster } : {}) };
    if (done.posted) acts.push({ ...base, kind: "posted", text: words });
    else if (words !== "") acts.push({ ...base, kind: "typed", text: words });
    else if (done.printed > 0) acts.push({ ...base, kind: "erased", text: "" });
    else if (done.named.length > 0) acts.push({ ...base, kind: "pressed", text: done.named.join(", ") });
    typing = null;
  };
  const flushScroll = () => {
    if (scroll === null) return;
    const done = scroll as { s: number; e: number; dy: number; dx: number; app?: string; site?: string };
    if (Math.abs(done.dy) + Math.abs(done.dx) >= 40) acts.push({ t: done.s, until: done.e, kind: "scrolled", dy: Math.round(done.dy), ...where(done.app, done.site) });
    scroll = null;
  };
  for (const event of events) {
    const raw = event.raw;
    if (event.e === "key_down") {
      const mods = Array.isArray(raw.mods) ? raw.mods.map(String) : [];
      const key = typeof raw.key === "string" ? raw.key : undefined;
      const name = typeof raw.name === "string" ? raw.name : undefined;
      if (mods.includes("cmd") || mods.includes("ctrl")) {
        flushTyping();
        const keys = `${mods.filter((mod) => mod !== "shift" || key).join("+")}+${keyName(key, name, raw.code)}`;
        const meaning = SHORTCUT_MEANINGS.get(keys.replace(/^(.*)\+[1-9]$/u, "$1+digit"));
        acts.push({ t: event.t, kind: "shortcut", keys, ...(meaning ? { meaning } : {}), into: elementText(raw.el), ...where(event.app, event.site), ...(event.poster ? { poster: event.poster } : {}) });
        continue;
      }
      const posted = event.poster !== undefined;
      const field = fieldKey(raw.el);
      const current = typing as Typing | null;
      if (current === null || event.t - current.e > 4_000 || current.app !== event.app || current.posted !== posted ||
          (field !== "" && current.field !== field && current.chars.length > 0)) {
        flushTyping();
        typing = { s: event.t, e: event.t, chars: [], keys: 0, printed: 0, named: [], field, posted, into: elementText(raw.el, false),
          ...(event.app ? { app: event.app } : {}), ...(event.site ? { site: event.site } : {}), ...(event.poster ? { poster: event.poster } : {}) };
      }
      const open = typing!;
      open.e = event.t;
      open.keys++;
      if (raw.hidden !== undefined && raw.hidden !== false) { open.chars.push("•"); open.printed++; }
      else if (key !== undefined && key.trim() !== "") { open.chars.push(key); open.printed++; }
      else if (name === "delete") open.chars.pop();
      else if (name === "return") open.chars.push("⏎");
      else if (name === "tab") open.chars.push("⇥");
      else if (name === "space" || key === " ") { open.chars.push(" "); open.printed++; }
      else if (name !== undefined) open.named.push(name);
      if (name === "return" || name === "escape") flushTyping();
    } else if (event.e === "down") {
      flushTyping();
      const clicks = Number(raw.clicks ?? 1);
      acts.push({ t: event.t, kind: raw.button === "right" ? "right-clicked" : clicks > 1 ? "double-clicked" : "clicked",
        on: elementText(raw.el), ...where(event.app, event.site), ...(event.poster ? { poster: event.poster } : {}) });
    } else if (event.e === "scroll") {
      if (raw.phase === "momentum" || raw.phase === "momentum_end") {
        if (scroll !== null) (scroll as { e: number }).e = event.t;
        continue;
      }
      const open = scroll as { e: number; app?: string } | null;
      if (open === null || event.t - open.e > 1_500 || open.app !== event.app) {
        flushScroll();
        scroll = { s: event.t, e: event.t, dy: 0, dx: 0, ...where(event.app, event.site) };
      }
      const now = scroll!;
      now.e = event.t;
      now.dy += Number(raw.dy ?? 0);
      now.dx += Number(raw.dx ?? 0);
    } else if (event.e === "activate") {
      flushTyping();
      acts.push({ t: event.t, kind: "switched to", ...(event.app ? { app: event.app } : {}) });
    } else if (event.e === "locked") {
      acts.push({ t: event.t, kind: raw.on === true ? "screen locked" : "screen unlocked" });
    } else if (event.e === "secure_input") {
      acts.push({ t: event.t, kind: raw.on === true ? "password field active (keys hidden)" : "password field closed" });
    }
  }
  flushTyping();
  flushScroll();
  return acts.sort((left, right) => left.t - right.t);
}

function keyName(key: string | undefined, name: string | undefined, code: Json | undefined): string {
  if (key !== undefined && key.trim() !== "") return key.toLowerCase();
  return name ?? (key === " " ? "space" : `key ${String(code)}`);
}

function where(app: string | undefined, site: string | undefined): { app?: string; site?: string } {
  return { ...(app ? { app } : {}), ...(site ? { site } : {}) };
}

function fieldKey(value: Json | undefined): string {
  const el = object(value);
  if (Object.keys(el).length === 0 || el.err !== undefined) return "";
  return `${String(el.role ?? "")}|${String(el.title ?? el.desc ?? "")}`;
}

const ELEMENT_UNITS = 80;

function elementText(value: Json | undefined, withValue = true): Piece[] {
  const el = object(value);
  if (Object.keys(el).length === 0 || el.err !== undefined) return [];
  const action = Object.keys(object(el.action)).length > 0 ? object(el.action) : el;
  const role = String(action.role ?? el.role ?? "").replace(/^AX/u, "");
  const bits: Piece[][] = role === "" ? [] : [said`${role}`];
  const label = action.title || action.desc || el.title || el.desc;
  if (label) bits.push(said`“${free(textHead(String(label), ELEMENT_UNITS))}”`);
  if (withValue && el.value && !label) bits.push(said`“${free(textHead(String(el.value), ELEMENT_UNITS))}”`);
  const url = action.url || el.url;
  if (url) bits.push(said`<${free(shortUrl(String(url)))}>`);
  return sayJoined(bits, " ");
}

function shortUrl(value: string): string {
  try {
    const url = new URL(value);
    return textHead(url.host + url.pathname, ELEMENT_UNITS);
  } catch {
    return textHead(value, ELEMENT_UNITS);
  }
}

function place(row: FrameRow): string {
  return piecesText(placed(row));
}

function placed(row: FrameRow): Piece[] {
  return said`${row.app}${row.site ? said` · ${free(row.site)}` : ""} · “${free(row.title ?? "")}”`;
}

function withResults(acts: readonly Action[], rows: readonly FrameRow[], a: number, b: number): Action[] {
  const out: Action[] = [];
  for (let index = firstAtOrAfter(acts, a); index < acts.length && acts[index]!.t < b; index++) {
    const act = acts[index]!;
    const entered = (act.kind === "typed" || act.kind === "posted") && act.text?.endsWith("⏎") === true;
    if (act.kind !== "shortcut" && !entered) {
      out.push(act);
      continue;
    }
    const at = act.until ?? act.t;
    const before = rows[firstAfter(rows, at) - 1];
    const next = resultingAct(acts, index, at);
    let effect: Piece[] | undefined;
    if (next?.kind === "switched to") effect = said`${next.app ?? "another app"} came to the front`;
    else {
      const changed = changedFront(rows, at, Math.min(at + RESULT_MS, next?.t ?? Number.POSITIVE_INFINITY), before);
      effect = changed ? said`now in front: ${placed(changed)}` : before ? said`nothing changed in front` : undefined;
    }
    if (entered) {
      const words = act.text!.replace(/⏎$/u, "").trim();
      if (words.length > 0 && echoed(words, at, rows)) effect = said`${effect ? said`${effect}; ` : ""}the text then showed on screen`;
    }
    out.push(effect === undefined ? act : { ...act, effect });
  }
  return out;
}

function resultingAct(acts: readonly Action[], index: number, at: number): Action | undefined {
  const act = acts[index]!;
  for (let later = index + 1; later < acts.length && acts[later]!.t - at <= RESULT_MS; later++) {
    const next = acts[later]!;
    if (next.t > act.t && (next.kind === "switched to" || next.kind === "shortcut" || next.kind === "typed" || next.kind === "clicked")) return next;
  }
  return undefined;
}

function changedFront(rows: readonly FrameRow[], at: number, limit: number, before: FrameRow | undefined): FrameRow | undefined {
  const was = before === undefined ? undefined : place(before);
  for (let index = firstAfter(rows, at); index < rows.length && rows[index]!.t <= limit; index++) {
    if (was === undefined || place(rows[index]!) !== was) return rows[index];
  }
  return undefined;
}

function echoed(words: string, at: number, rows: readonly FrameRow[]): boolean {
  const want = words.toLowerCase().replace(/\s+/gu, " ");
  const probe = want.length >= 8 ? want.slice(0, 40) : want;
  for (let index = firstAfter(rows, at); index < rows.length && rows[index]!.t <= at + ECHO_MS; index++) {
    for (const line of rows[index]!.text()) {
      const have = line.toLowerCase().replace(/\s+/gu, " ").trim();
      if (want.length >= 8 ? have.includes(probe) : have === probe) return true;
    }
  }
  return false;
}

function actionLine(act: Action, hms: (ms: number) => string): Piece[] {
  const at = sayJoined([...act.app ? [act.app] : [], ...act.site ? [free(act.site)] : []], " · ");
  const span = act.until !== undefined && act.until - act.t >= 1000 ? `${hms(act.t)}–${hms(act.until)}` : hms(act.t);
  const effect = act.effect ? said` → ${act.effect}` : "";
  const into = (word: string) => act.into?.length ? said` ${word} ${act.into}` : "";
  switch (act.kind) {
    case "typed": return said`${span} typed ${free(JSON.stringify(act.text))}${into("into")} (${at})${effect}`;
    case "posted": return said`${span} text entered by ${act.poster ?? "a program"} (dictation or paste)${act.text ? said`: ${free(JSON.stringify(act.text))}` : ""}, ${String(act.keys)} keys${into("into")} (${at})${effect}`;
    case "erased": return said`${span} typed ${String(act.keys)} keys and deleted them all${into("in")} (${at})`;
    case "pressed": return said`${span} pressed ${act.text!}${into("in")} (${at})`;
    case "shortcut": return said`${span} pressed ${String(act.keys)}${act.meaning ? ` (${act.meaning})` : ""}${into("in")} (${at})${effect}`;
    case "scrolled": return said`${span} scrolled ${act.dy! < 0 ? "down" : "up"} ${Math.abs(act.dy!)} pt (${at})`;
    case "switched to": return said`${span} switched to ${act.app ?? "another app"}`;
    default: return said`${span} ${act.kind}${act.on?.length ? said` ${act.on}` : ""}${at.length > 0 ? said` (${at})` : ""}`;
  }
}


interface Run {
  key: string;
  s: number;
  e: number;
  lastT: number;
  rows: FrameRow[];
  blind?: true;
}

function timelineRuns(rows: readonly FrameRow[], a: number, b: number): Run[] {
  const runs: Run[] = [];
  let cursor = a;
  for (const row of rows) {
    if (row.t - cursor > BLIND_MS) runs.push({ key: "blind", s: cursor, e: row.t, lastT: row.t, rows: [], blind: true });
    const key = `${row.app}|${row.title}|${row.site}`;
    const last = runs.at(-1);
    if (last !== undefined && last.blind === undefined && last.key === key && row.t - last.lastT <= ROW_JOIN_MS) {
      last.lastT = row.t;
      last.e = Math.min(b, row.t + 2_000);
      last.rows.push(row);
    } else {
      runs.push({ key, s: row.t, e: Math.min(b, row.t + 2_000), lastT: row.t, rows: [row] });
    }
    cursor = Math.min(b, row.t + 2_000);
  }
  if (b - cursor > BLIND_MS) runs.push({ key: "blind", s: cursor, e: b, lastT: b, rows: [], blind: true });
  return runs;
}

function runLine(run: Run, read: SittingRead, acts: readonly Action[], personal: readonly InputEvent[], a: number, hms: (ms: number) => string): Piece[] {
  if (run.blind) return said`${hms(run.s)}–${hms(run.e)} (${duration(run.e - run.s)}) NO CAPTURE: ${blindReason(run, read, acts, hms)}`;
  const first = run.rows[0]!;
  const hands = { keys: 0, clicks: 0, scrolls: 0, moves: 0 };
  for (let index = firstAtOrAfter(read.events, run.s); index < read.events.length && read.events[index]!.t < run.e; index++) {
    const event = read.events[index]!;
    if (event.e === "key_down") hands.keys++;
    else if (event.e === "down") hands.clicks++;
    else if (event.e === "scroll" && event.raw.phase !== "momentum" && event.raw.phase !== "momentum_end") hands.scrolls++;
    else if (event.e === "move") hands.moves++;
  }
  let still = 0;
  for (const row of run.rows) {
    const before = personal[firstAtOrAfter(personal, row.t + 1) - 1];
    still = Math.max(still, Math.round((row.t - Math.max(before?.t ?? a, a)) / 1000));
  }
  const titles = [...new Set(run.rows.map((row) => row.title).filter((title): title is string => title !== null))];
  const marks = [titles.some((title) => SOUND_TITLE.test(title)) ? "sound playing" : "",
    titles.some((title) => CALL_TITLE.test(title)) ? "call: camera/mic on" : ""].filter(Boolean);
  const inactive = run.rows.filter((row) => row.inactive).length;
  const handsText = read.hasInput
    ? ` · hands: ${hands.keys} keys, ${hands.clicks} clicks, ${hands.scrolls} scrolls, ${hands.moves} pointer moves · longest still ${still} s` : "";
  const passing = run.rows.length === 1 && hands.keys + hands.clicks + hands.scrolls === 0
    ? " · in passing (a title this brief may be left over from the page before)" : "";
  return said`${hms(run.s)}–${hms(run.e)} (${duration(run.e - run.s)}) ${placed(first)}${handsText}${marks.length > 0 ? ` · ${marks.join(", ")}` : ""}${inactive > 0 ? ` · marked idle ${Math.round((100 * inactive) / run.rows.length)}%` : ""}${passing}`;
}

function sortedCount<T>(items: readonly T[], counted: (item: T) => boolean): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (counted(items[mid]!)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function countBefore(times: readonly number[], t: number): number {
  return sortedCount(times, (at) => at < t);
}

function countThrough(times: readonly number[], t: number): number {
  return sortedCount(times, (at) => at <= t);
}

function firstAtOrAfter(items: readonly { t: number }[], t: number): number {
  return sortedCount(items, (item) => item.t < t);
}

function firstAfter(items: readonly { t: number }[], t: number): number {
  return sortedCount(items, (item) => item.t <= t);
}

function within<T extends { t: number }>(items: readonly T[], from: number, to: number): T[] {
  return items.slice(firstAtOrAfter(items, from), firstAtOrAfter(items, to));
}

function isPersonal(event: InputEvent): boolean {
  if (event.raw.syn !== undefined) return event.e === "key_down";
  if (event.e === "scroll") return event.raw.phase !== "momentum" && event.raw.phase !== "momentum_end";
  return event.e === "key_down" || event.e === "down" || event.e === "move";
}

const AWAY = /^(lock|sleep|display_sleep|screensaver_start|logout|shutdown)$/u;

function blindReason(run: Run, read: SittingRead, acts: readonly Action[], hms: (ms: number) => string): Piece[] | string {
  const stated = read.gaps.filter((gap: GapRow) => gap.s < run.e && gap.e >= run.s);
  if (stated.some((gap) => gap.status === "excluded")) return "an app, site or private window that is never recorded was in front; the person was at the Mac";
  const away = read.machine.slice(firstAtOrAfter(read.machine, run.s - 60_000), firstAfter(read.machine, run.e)).find((event) => AWAY.test(event.event));
  if (away !== undefined) return `nothing recorded; the machine reported ${away.event} at ${hms(away.t)}`;
  const reasons = [...new Set(stated.map((gap) => gap.reason).filter((reason): reason is string => reason !== null))];
  if (reasons.length > 0) return said`nothing recorded; the screen stated: ${sayJoined(reasons.slice(0, 3).map((reason) => free(reason)), ", ")}`;
  const locked = acts.find((act) => act.kind === "screen locked" && act.t >= run.s - 60_000 && act.t <= run.e);
  if (locked !== undefined) return `nothing recorded; the screen was locked at ${hms(locked.t)}`;
  const busy = acts.filter((act) => act.t >= run.s && act.t < run.e && act.kind !== "switched to").length;
  const switches = acts.filter((act) => act.t >= run.s && act.t < run.e && act.kind === "switched to").length;
  if (busy + switches > 0) {
    return `no frames were saved, but the machine was awake and the person was using it (${busy} actions, ${switches} app switches in this gap; see ACTIONS)`;
  }
  return "no frames, and no machine event or input saying why";
}

function screenText(rows: readonly FrameRow[], runs: readonly Run[], acts: readonly Action[], budget: number, hms: (ms: number) => string): Piece[][] {
  const want = new Set<number>();
  for (const run of runs) if (run.blind === undefined) want.add(run.rows[0]!.t);
  const near = acts.filter((act) => act.kind !== "switched to").flatMap((act) => [act.t - 1_500, (act.until ?? act.t) + 1_500]).sort((l, r) => l - r);
  let index = 0;
  for (const at of near) {
    while (index + 1 < rows.length && Math.abs(rows[index + 1]!.t - at) <= Math.abs(rows[index]!.t - at)) index++;
    if (rows[index] !== undefined) want.add(rows[index]!.t);
  }
  const seen = new Map<string, Set<string>>();
  const lastAt = new Map<string, number>();
  const blocks: Piece[][] = [];
  let size = 0;
  for (const row of rows) {
    const window = `${row.app}|${String(row.title ?? "").slice(0, 60)}`;
    const periodic = row.t - (lastAt.get(window) ?? Number.NEGATIVE_INFINITY) >= SNAPSHOT_EVERY_MS;
    if (!want.has(row.t) && !periodic) continue;
    lastAt.set(window, row.t);
    const known = seen.get(window) ?? new Set<string>();
    seen.set(window, known);
    const fresh = row.text().filter((line) => {
      const key = line.trim();
      if (known.has(key)) return false;
      known.add(key);
      return true;
    });
    if (fresh.length === 0) continue;
    const block = said`--- ${hms(row.t)} · ${placed(row)} · ${fresh.length} new lines\n${free(fresh.join("\n"))}\n`;
    const length = piecesText(block).length;
    if (size + length > budget) {
      blocks.push(said`--- ${hms(row.t)} · (text budget reached; later text omitted)\n`);
      break;
    }
    blocks.push(block);
    size += length;
  }
  return blocks;
}

export function duration(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 6_000) / 10} min` : `${Math.round(ms / 1000)} s`;
}
