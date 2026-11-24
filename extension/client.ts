import {
  StationError,
  type Answers,
  type ErrandSpec,
  type Found,
  type Locator,
  type Op,
  type Outline,
  type Site,
  type PageRequest,
  type PageResponse,
  type Result,
  type StationInfo,
  type Value,
  type WaitFor,
} from "./wire.js";


export interface Placement {
  readonly station?: string;
  readonly wait_ms?: number;
}

export interface Stations {
  list(): Promise<(StationInfo & { seen: number; present: boolean })[]>;
  open(spec: ErrandSpec, place?: Placement): Promise<Errand>;
  attach(errand: string): Errand;
  using<T>(spec: ErrandSpec, body: (errand: Errand) => Promise<T>, place?: Placement): Promise<T>;
  offer(sites: readonly Site[], station?: string): Promise<void>;
  sites(): Promise<(Site & { readonly chosen: boolean; readonly stations: readonly { readonly unit: string; readonly signed_in: boolean | null; readonly allowed?: boolean }[] })[]>;
  reload(unit: string): Promise<void>;
}

export interface Errand {
  readonly id: string;
  readonly station: StationInfo | null;
  open(url: string): Promise<Tab>;
  tab(id: number): Tab;
  file(name: string): Promise<Uint8Array>;
  close(): Promise<void>;
}

export interface Tab {
  readonly id: number;
  goto(url: string): Promise<string>;
  snapshot(options?: { text?: boolean }): Promise<Outline>;
  find(target: Locator): Promise<Found[]>;
  click(target: Locator): Promise<string>;
  fill(target: Locator, value: Value): Promise<void>;
  select(target: Locator, option: string): Promise<string>;
  wait(wanted: WaitFor, ms: number): Promise<Outline>;
  fetch(requests: readonly PageRequest[]): Promise<PageResponse[]>;
  json(url: string, options?: Omit<PageRequest, "url" | "as" | "name">): Promise<PageResponse>;
}

export function connect(url: string, token: string, options: { fetch?: typeof fetch } = {}): Stations {
  const send = options.fetch ?? fetch;
  const base = url.replace(/\/+$/u, "");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await send(`${base}${path}`, init);
    if (!response.ok) {
      const refused = (await response.json().catch(() => ({}))) as { code?: string; message?: string };
      throw new StationError((refused.code ?? "BAD_CALL") as StationError["code"], refused.message ?? `the stations answered ${response.status}`);
    }
    return response;
  }

  function errandOf(id: string, station: StationInfo | null): Errand {
    const path = `/v1/errands/${id}`;
    async function op<K extends keyof Answers>(sent: Op & { op: K }): Promise<Answers[K]> {
      const result = (await (await call("POST", `${path}/calls`, sent)).json()) as Result;
      if (!result.ok) throw new StationError(result.error.code, result.error.message, result.error.snapshot);
      return result.value as Answers[K];
    }
    function tabOf(tab: number): Tab {
      return {
        id: tab,
        goto: async (url) => (await op({ op: "goto", tab, url })).url,
        snapshot: (options = {}) => op(options.text === true ? { op: "snapshot", tab, text: true } : { op: "snapshot", tab }),
        find: (target) => op({ op: "find", tab, target }),
        click: async (target) => (await op({ op: "click", tab, target })).url,
        fill: async (target, value) => void (await op({ op: "fill", tab, target, value })),
        select: async (target, option) => (await op({ op: "select", tab, target, option })).selected,
        wait: (wanted, ms) => op({ op: "wait", tab, for: wanted, ms }),
        fetch: (requests) => op({ op: "fetch", tab, requests }),
        json: async (url, options = {}) => (await op({ op: "fetch", tab, requests: [{ ...options, url, as: "json" }] }))[0] as PageResponse,
      };
    }
    return {
      id,
      station,
      open: async (url) => tabOf((await op({ op: "open", url })).tab),
      tab: tabOf,
      file: async (name) => new Uint8Array(await (await call("GET", `${path}/files/${name.split("/").map(encodeURIComponent).join("/")}`)).arrayBuffer()),
      close: async () => void (await call("DELETE", path)),
    };
  }

  const stations: Stations = {
    list: async () => ((await (await call("GET", "/v1/stations")).json()) as { stations: Awaited<ReturnType<Stations["list"]>> }).stations,
    open: async (spec, place = {}) => {
      const answer = (await (await call("POST", "/v1/errands", { spec, ...place })).json()) as {
        errand: string;
        station: StationInfo;
      };
      return errandOf(answer.errand, answer.station);
    },
    attach: (errand) => errandOf(errand, null),
    offer: async (sites, station) => void (await call("PUT", "/v1/sites", station === undefined ? { sites } : { station, sites })),
    sites: async () => ((await (await call("GET", "/v1/sites")).json()) as { sites: Awaited<ReturnType<Stations["sites"]>> }).sites,
    reload: async (unit) => void (await call("POST", `/v1/stations/${encodeURIComponent(unit)}/reload`)),
    using: async (spec, body, place) => {
      const errand = await stations.open(spec, place);
      try {
        return await body(errand);
      } finally {
        await errand.close().catch(() => undefined);
      }
    },
  };
  return stations;
}
