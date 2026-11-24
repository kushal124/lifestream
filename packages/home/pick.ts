import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { makeUnder, type AskRow, type HandedFolder, type KeyLabel, type Tx } from "@lifestreamprotocol/core";
import { callCopiesOf, LEDGER_STORE, transportSecret, type Ledger, type ModelSettings, type ProgramAt } from "@lifestreamprotocol/model";
import { askKey, type SentAsk } from "./asks.js";
import { failpoint } from "./failpoint.js";
import { readHome } from "./lifecycle.js";
import { serving, type Models, type Routing } from "./models.js";


export const CALL_KEYS: readonly KeyLabel[] = [`store:${LEDGER_STORE.role}`, "files", "names"];

export function callCopiesAt(root: string, machine: string): string {
  return callCopiesOf(machine, readHome(root).id);
}

export interface CallsOptions {
  root: string;
  machine: string;
  home: string;
  handOver(labels: readonly KeyLabel[]): HandedFolder;
  command: readonly string[];
  ledger: Pick<Ledger, "inFlight">;
  model(): ModelSettings;
  models: Pick<Models, "concurrency">;
  programs(): Record<string, ProgramAt>;
  door(): string;
  secret(name: string, key: string): Record<string, string>;
  exited(code: number | null): void;
  hiding(work_id: string | null, leaves: string): boolean;
}

interface Held {
  family: string;
  unit: string;
  item: string;
  work_id: string | null;
  route: string;
  transport: string;
  state: "picked" | "taken" | "sent";
}

const RING = 256;
const PAGE = 64;
const UNSTARTED: AskRow = {
  family: "", item: "", prompt: "", version: 0, input_hash: "", unit: "", work_id: null, at_key: -1, started: true,
  waits: null, retry_ms: null, given_up: null, unhideable: null, state: "pending",
};

export class Calls {
  readonly #held = new Map<string, Held>();
  readonly #rings = new Map<string, { route: string; after: AskRow | null }>();
  readonly #turns = new Map<string, number>();
  #turn = 0;
  started = 0;

  constructor(private readonly options: CallsOptions) {}

  pick(tx: Tx, now: number, routing: Routing, paused: (family: string) => boolean): string[] {
    for (const [known, held] of this.#held) if (held.state === "picked" && paused(held.family)) this.#held.delete(known);
    const busy = new Map<string, string | null>();
    for (const each of this.options.ledger.inFlight()) busy.set(askKey(each), each.transport);
    for (const [known, held] of this.#held) if (!busy.has(known)) busy.set(known, held.transport);
    let free = this.options.model().cap - busy.size;
    if (free <= 0) return [];
    const flying = new Map<string, number>();
    for (const transport of busy.values()) if (transport !== null) flying.set(transport, (flying.get(transport) ?? 0) + 1);
    const room = (transport: string) => Math.min(free, this.options.models.concurrency(transport) - (flying.get(transport) ?? 0));
    const picked = new Set<string>();
    const hidden = new Map<string, boolean>();
    const hiding = (work_id: string | null, leaves: string | null): boolean => {
      if (leaves === null) return true;
      const at = `${work_id}\0${leaves}`;
      if (!hidden.has(at)) hidden.set(at, this.options.hiding(work_id, leaves));
      return hidden.get(at)!;
    };
    const take = (row: AskRow, work_id: string | null, route: string, transport: string): void => {
      if (row.state !== "pending" || row.waits !== null || row.unhideable !== null || (row.retry_ms !== null && row.retry_ms > now) || paused(row.family)) return;
      const known = askKey(row);
      if (busy.has(known)) return;
      if (tx.tables.dirty.marks(row.family, row.unit) !== undefined) return;
      this.#held.set(known, { family: row.family, unit: row.unit, item: row.item, work_id, route, transport, state: "picked" });
      if (work_id !== null) this.#turns.set(work_id, ++this.#turn);
      busy.set(known, transport);
      flying.set(transport, (flying.get(transport) ?? 0) + 1);
      picked.add(row.family);
      free--;
    };
    const choices = tx.tables.itemRoutes.list();
    const chosen = new Set(choices.map((choice) => `${choice.family}\0${choice.item}\0${choice.prompt}`));
    for (const choice of choices) {
      if (free <= 0) break;
      const row = tx.tables.asks.get(choice.family, choice.item, choice.prompt);
      if (row === undefined) continue;
      const now_serving = serving(routing, { work_id: row.work_id, chosen: choice.route, at_key: row.at_key });
      if (!("route" in now_serving) || now_serving.route.state !== "ready" || room(now_serving.route.transport) <= 0) continue;
      if (!hiding(row.work_id, now_serving.route.leaves)) continue;
      take(row, null, now_serving.route.id, now_serving.route.transport);
    }
    const holding = new Map<string, number>();
    for (const held of this.#held.values()) if (held.work_id !== null) holding.set(held.work_id, (holding.get(held.work_id) ?? 0) + 1);
    const works = Object.entries(routing.works).flatMap(([work_id, work]) => {
      const route = work.route === null ? undefined : routing.routes[work.route];
      return route?.state !== "ready" || !hiding(work_id, route.leaves) ? [] : [{ work_id, route }];
    }).sort((a, b) => (holding.get(a.work_id) ?? 0) - (holding.get(b.work_id) ?? 0) || (this.#turns.get(a.work_id) ?? 0) - (this.#turns.get(b.work_id) ?? 0)
      || (a.work_id < b.work_id ? -1 : a.work_id > b.work_id ? 1 : 0));
    for (const { work_id, route } of works) {
      if (free <= 0) break;
      let ring = this.#rings.get(work_id);
      if (ring === undefined || ring.route !== route.id) this.#rings.set(work_id, ring = { route: route.id, after: null });
      let read = 0;
      ringing: while (read < RING && room(route.transport) > 0) {
        const page = tx.tables.asks.next(work_id, ring.after, Math.min(PAGE, RING - read));
        if (page.length === 0) {
          ring.after = null;
          break;
        }
        for (const row of page) {
          if (room(route.transport) <= 0) break ringing;
          read++;
          if (!("route" in serving(routing, { work_id, chosen: null, at_key: row.at_key }))) {
            ring.after = row.started ? UNSTARTED : null;
            if (!row.started) break ringing;
            continue ringing;
          }
          ring.after = row;
          if (!chosen.has(`${row.family}\0${row.item}\0${row.prompt}`)) take(row, work_id, route.id, route.transport);
        }
      }
    }
    return [...picked];
  }

  take(family: string): { unit: string; item: string; route: string }[] {
    const taken: Held[] = [];
    for (const held of this.#held.values()) {
      if (held.family !== family || held.state === "sent") continue;
      held.state = "taken";
      taken.push(held);
    }
    return taken.map(({ unit, item, route }) => ({ unit, item, route }));
  }

  sent(family: string, unit: string, sent: readonly SentAsk[]): void {
    for (const ask of sent) {
      this.#held.set(ask.known, { family, unit, item: ask.item, work_id: ask.work_id, route: ask.route, transport: ask.call.transport, state: "sent" });
      this.#spawn(ask);
    }
  }

  now(family: string, unit: string, ask: SentAsk, ended: (code: number | null) => void): boolean {
    if (this.#held.has(ask.known)) return false;
    this.#held.set(ask.known, { family, unit, item: ask.item, work_id: ask.work_id, route: ask.route, transport: ask.call.transport, state: "sent" });
    try {
      this.#spawn(ask, ended);
    } catch (error) {
      this.#held.delete(ask.known);
      throw error;
    }
    return true;
  }

  holds(known: string): boolean {
    return this.#held.has(known);
  }

  release(family: string): void {
    for (const [known, held] of this.#held) if (held.family === family && held.state === "taken") this.#held.delete(known);
  }

  #spawn(ask: SentAsk, told?: (code: number | null) => void): void {
    const { root, command } = this.options;
    const logs = join(root, "logs");
    makeUnder(root, logs);
    const log = openSync(join(logs, "calls.log"), "a");
    try {
      const transports = this.options.model().transports ?? {};
      const handed = this.options.handOver(CALL_KEYS);
      const child = spawn(command[0]!, [
        ...command.slice(1), "--root", root, "--route", JSON.stringify(ask.call), "--transports", JSON.stringify(transports),
        "--programs", JSON.stringify(this.options.programs()), "--door", this.options.door(), "--machine", this.options.machine, "--home", this.options.home, "--key", ask.key,
        ...(ask.copy === null ? [] : ["--sent-copy", String(ask.copy.id)]),
      ], { detached: true, stdio: ["pipe", log, log] });
      const name = transportSecret(ask.call.transport, transports);
      child.stdin!.on("error", () => undefined);
      child.stdin!.end([name === null ? {} : this.options.secret(name, ask.key), handed].map((line) => JSON.stringify(line)).join("\n"));
      this.started++;
      const ended = (code: number | null) => {
        if (this.#held.get(ask.known)?.state === "sent") this.#held.delete(ask.known);
        this.options.exited(code);
        told?.(code);
      };
      child.once("exit", (code) => ended(code));
      child.once("error", () => ended(null));
      child.unref();
      failpoint("call.spawned");
    } finally {
      closeSync(log);
    }
  }
}
