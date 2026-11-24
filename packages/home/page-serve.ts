import { gzipSync } from "node:zlib";
import { civilDay, type DaySettings } from "@lifestreamprotocol/core";
import { PAGES, pageETag, PageShapeError, type AnswerOf, type Handlers, type PageAsk, type PageContract, type PageHandler, type PageName } from "./pages.js";
import { ContractError } from "./search-contract.js";
import { refuse } from "./refusal.js";
import type { Ask, Reply } from "./reads.js";

const JSON_HEADERS = { "content-type": "application/json", "cache-control": "no-cache" } as const;
const POSITION_HEADER = "lifestream-position";
const SETTLED = "settled";

export type PageRoute = (ask: Ask) => Reply | Promise<Reply>;

const named = (name: string): name is PageName => Object.hasOwn(PAGES, name);

export function servePages(handlers: Handlers, day: () => DaySettings): ReadonlyMap<string, PageRoute> {
  const routes = new Map<string, PageRoute>();
  for (const name of Object.keys(handlers).filter(named)) {
    const handler = handlers[name];
    if (handler !== undefined) routes.set(PAGES[name].route, (ask) => answer(name, handler, ask, day()));
  }
  return routes;
}

export function servePage<N extends PageName>(name: N, handler: PageHandler<AnswerOf<N>>, ask: Ask, day: DaySettings): Reply | Promise<Reply> {
  return answer(name, handler, ask, day);
}

function answer(name: PageName, handler: PageHandler<unknown>, ask: Ask, day: DaySettings): Reply | Promise<Reply> {
  const page: PageContract<unknown> = PAGES[name];
  const params = page.settled === null ? handler.params : [...handler.params, SETTLED];
  if (ask.reader === "model" && !page.models) refuse(403, "PRINCIPAL_SCOPE", `${page.route} is a page answer, read for a person and never for a model`);
  const query = askedOf(ask.url, params);
  const asked: PageAsk = {
    machine: ask.held.machine, now_ms: ask.now_ms, query, today: civilDay(ask.now_ms, day), device: ask.device?.kind ?? null, unit: ask.device?.unit ?? null, held: ask.held,
  };
  const vary = page.device ? "accept-encoding, lifestream-device" : "accept-encoding";
  return handler.open(asked, (opened) => {
    const etag = pageETag(page, asked, opened.inputs);
    const counting = page.settled !== null && opened.counting;
    const marked = counting ? { counting: true as const } : {};
    if (ask.if_none_match === etag) return { status: 304, headers: { etag, vary, [POSITION_HEADER]: opened.position }, body: "", ...marked };
    const made = shaped(name, page, { position: opened.position, today: asked.today, ...opened.build(), ...(page.settled === null ? {} : { counting }) });
    const text = JSON.stringify(made);
    const zipped = ask.gzip === true;
    return {
      status: 200,
      headers: { ...JSON_HEADERS, etag, vary, [POSITION_HEADER]: opened.position, ...(zipped ? { "content-encoding": "gzip" } : {}) },
      body: zipped ? gzipSync(text) : text,
      ...marked,
    };
  });
}

function askedOf(url: string, params: readonly string[]): URLSearchParams {
  const query = new URL(url, "http://door").searchParams;
  for (const each of new Set(query.keys())) {
    if (!params.includes(each)) refuse(422, "BAD_PARAMETER", `${each} is not a parameter of this page`);
    if (query.getAll(each).length > 1) refuse(422, "BAD_PARAMETER", `${each} is stated once`);
  }
  return query;
}

function shaped(name: PageName, page: PageContract<unknown>, made: Record<string, unknown>): Record<string, unknown> {
  try {
    return page.shape.parse(made, "") as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ContractError) throw new PageShapeError(name, error.at.replace(/^\./u, ""), error.why);
    throw error;
  }
}
