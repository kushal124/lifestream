import type { Feed } from "./feed.js";
import { PAGES } from "./pages.js";
import { refuse } from "./refusal.js";

export const SETTLED_MS = 20_000;

export type Bound = (end: () => void) => () => void;

export interface Settling {
  readonly feed: Pick<Feed, "watch">;
  readonly bound?: Bound;
}

export interface Counted {
  readonly reply: { readonly counting?: true };
}

const JOBS: ReadonlyMap<string, string> = new Map([
  ["/v1/people", "people"], ["/v1/people/photos", "people"], ["/v1/places", "places"], ["/v1/places/photos", "places"],
  ...Object.values(PAGES).flatMap((page): [string, string][] => (page.settled === null ? [] : [[page.route, page.settled]])),
]);

const BOUND: Bound = (end) => {
  const timer = setTimeout(end, SETTLED_MS);
  return () => clearTimeout(timer);
};

const OVER = Symbol("over");

export async function readSettled<T extends Counted>(pathname: string, params: URLSearchParams, settling: Settling, read: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  const job = JOBS.get(pathname);
  const stated = params.getAll("settled");
  if (job === undefined || stated.length === 0) return read(signal);
  if (stated.length > 1 || stated[0] !== "1") refuse(422, "BAD_PARAMETER", "settled is 1, stated once");
  const cut = new AbortController();
  let end = (): void => undefined;
  const over = new Promise<typeof OVER>((resolve) => { end = () => resolve(OVER); });
  const unbind = (settling.bound ?? BOUND)(() => end());
  const left = (): void => {
    cut.abort(signal.reason);
    end();
  };
  if (signal.aborted) left();
  else signal.addEventListener("abort", left, { once: true });
  let rung = false;
  let ring: (() => void) | null = null;
  const woken = (): void => {
    const waiting = ring;
    ring = null;
    if (waiting === null) rung = true;
    else waiting();
  };
  const next = (): Promise<void> => new Promise<void>((resolve) => {
    if (!rung) {
      ring = resolve;
      return;
    }
    rung = false;
    resolve();
  });
  const watching = settling.feed.watch([job], woken);
  try {
    const watched = await Promise.race([watching, over]);
    cut.signal.throwIfAborted();
    let last = await read(cut.signal);
    if (watched === OVER) return last;
    if (watched === null) {
      if (last.reply.counting === true) await over;
      return last;
    }
    while (last.reply.counting === true) {
      if (await Promise.race([next(), over]) === OVER) break;
      const again = read(cut.signal);
      const answered = await Promise.race([again, over]);
      if (answered === OVER) {
        again.catch(() => undefined);
        break;
      }
      last = answered;
    }
    cut.signal.throwIfAborted();
    return last;
  } finally {
    signal.removeEventListener("abort", left);
    unbind();
    cut.abort();
    void watching.then((unwatch) => unwatch?.());
  }
}
