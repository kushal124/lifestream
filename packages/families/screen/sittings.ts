import type { Head, Json, JsonObject, ScreenAdapter, SourceRow, SourceSelector, View } from "@lifestreamprotocol/core";
import type { Given } from "../family.js";
import { Stretches } from "../shared/stretches.js";

export const GAP_MS = 300_000;
const STEP_MS = 15 * 60_000;

export const SOUND_TITLE = /🔊|Audio playing/u;
export const CALL_TITLE = /Camera and microphone|Meet [-–]|Zoom Meeting|FaceTime/u;

export type Role = ScreenAdapter["role"];

export class Roles {
  readonly #given: readonly Given<ScreenAdapter>[];

  constructor(given: readonly Given<ScreenAdapter>[]) {
    this.#given = given;
  }

  products(role: Role): string[] {
    return this.#given.filter((each) => each.adapter.role === role).map((each) => each.product);
  }

  selector(...roles: Role[]): SourceSelector {
    return { product: roles.flatMap((role) => this.products(role)) };
  }

  of(row: SourceRow): Role | null {
    const given = this.#given.find((each) => each.product === row.product);
    return given === undefined || given.adapter.plays?.(row) === false ? null : given.adapter.role;
  }
}

export function sourceRole(view: View, roles: Roles, source: string): { machine: string; role: Role } | null {
  const row = view.source(source);
  const role = row === undefined ? null : roles.of(row);
  return role === null ? null : { machine: row!.copy, role };
}

export function sourceOf(view: View, roles: Roles, machine: string, role: Role): string | undefined {
  return sourceIn(view.sources(), roles, machine, role);
}

export function sourceIn(rows: Iterable<SourceRow>, roles: Roles, machine: string, role: Role): string | undefined {
  const products = roles.products(role);
  return [...rows].find((row) => products.includes(row.product) && row.copy === machine && roles.of(row) === role)?.id;
}

export function unitOf(machine: string, first_ms: number): string {
  return `${machine}/${first_ms}`;
}

export function parseUnit(unit: string): { machine: string; first_ms: number } | null {
  const match = /^([^/:]+)\/(\d+)$/u.exec(unit);
  if (match === null) return null;
  const first_ms = Number(match[2]);
  return Number.isSafeInteger(first_ms) ? { machine: match[1]!, first_ms } : null;
}

export interface Sitting {
  machine: string;
  first_ms: number;
  last_ms: number;
}

interface Presence {
  key: string;
  s: number;
  e: number;
}

export function identityMs(identity: string): number | null {
  const match = /^(\d+)(?::\d+)?$/u.exec(identity);
  return match === null ? null : Number(match[1]);
}

export function object(value: Json | undefined): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

export function text(value: Json | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function coastInactive(content: JsonObject): boolean {
  return String(content.is_inactive ?? 0) !== "0" && content.is_inactive !== false;
}

export function holds(title: string | null): boolean {
  return title !== null && (SOUND_TITLE.test(title) || CALL_TITLE.test(title));
}

class MachineSittings {
  readonly #presence = new Stretches<Presence>((presence) => presence.s);
  #longest = 0;

  constructor(
    private readonly view: View,
    private readonly roles: Roles,
    private readonly machine: string,
    private readonly cutover_ms: number,
  ) {}

  around(lo: number, hi: number): Sitting[] {
    let a = lo - GAP_MS - STEP_MS;
    let b = hi + GAP_MS + STEP_MS;
    let step = STEP_MS;
    for (;;) {
      this.#presence.cover(a, b, (from, to) => this.#read(from, to));
      const sittings = this.#split(a, b);
      const first = sittings[0];
      const last = sittings.at(-1);
      if (first !== undefined && first.first_ms - GAP_MS <= a) {
        a -= step;
        step *= 2;
        continue;
      }
      if (last !== undefined && last.last_ms + GAP_MS >= b) {
        b += step;
        step *= 2;
        continue;
      }
      return sittings.filter((sitting) => sitting.first_ms <= hi + GAP_MS && sitting.last_ms >= lo - GAP_MS);
    }
  }

  startingAt(first_ms: number): Sitting | null {
    return this.around(first_ms, first_ms).find((sitting) => sitting.first_ms === first_ms) ?? null;
  }

  #split(a: number, b: number): Sitting[] {
    const sittings: Sitting[] = [];
    for (const item of this.#presence.within(a - this.#longest, b)) {
      if (item.e < a) continue;
      const open = sittings.at(-1);
      if (open !== undefined && item.s - open.last_ms <= GAP_MS) open.last_ms = Math.max(open.last_ms, item.e);
      else sittings.push({ machine: this.machine, first_ms: item.s, last_ms: item.e });
    }
    return sittings;
  }

  #read(a: number, b: number): Presence[] {
    const found: Presence[] = [];
    const add = (key: string, s: number, e: number) => {
      this.#longest = Math.max(this.#longest, e - s);
      found.push({ key, s, e });
    };
    const cutover = this.cutover_ms;
    const coast = sourceOf(this.view, this.roles, this.machine, "prior");
    if (a < cutover && coast !== undefined) {
      for (const { head, version } of this.view.records(coast, "frame", { start_ms: a, end_ms: Math.min(b, cutover) })) {
        const at = head.start_ms!;
        if (at >= cutover) continue;
        const content = object(version.content);
        if (!coastInactive(content) || holds(text(content.title))) add(`c\0${head.key}`, at, at);
      }
    }
    const recorder = sourceOf(this.view, this.roles, this.machine, "frames");
    if (b > cutover && recorder !== undefined) {
      const range = { start_ms: Math.max(a, cutover), end_ms: b };
      for (const head of this.view.heads(recorder, "frame", range)) {
        const span = clip(head, cutover);
        if (span !== null) add(`f\0${head.key}`, span[0], span[1]);
      }
      for (const { head, version } of this.view.records(recorder, "recorder", range)) {
        if (object(version.content).status !== "excluded") continue;
        const span = clip(head, cutover);
        if (span !== null) add(`r\0${head.key}`, span[0], span[1]);
      }
    }
    return found;
  }
}

function clip(head: Head, cutover_ms: number): [number, number] | null {
  const end = Math.max(head.start_ms!, head.end_ms ?? head.start_ms!);
  if (end < cutover_ms) return null;
  return [Math.max(head.start_ms!, cutover_ms), end];
}

const kept = new WeakMap<View, Map<Roles, Map<string, MachineSittings>>>();

export function sittingsOf(view: View, roles: Roles, machine: string, cutover_ms: number): MachineSittings {
  let byRoles = kept.get(view);
  if (byRoles === undefined) kept.set(view, byRoles = new Map());
  let machines = byRoles.get(roles);
  if (machines === undefined) byRoles.set(roles, machines = new Map());
  const key = `${machine}\0${cutover_ms}`;
  let sittings = machines.get(key);
  if (sittings === undefined) {
    sittings = new MachineSittings(view, roles, machine, cutover_ms);
    machines.set(key, sittings);
  }
  return sittings;
}
