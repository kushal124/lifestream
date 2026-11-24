import { browserAcquirer, checks, exportedFiles, isObject, newer, readable, readBody, TOKEN, unread, whoIs, type Acquirer, type BrowserSettings, type Json, type JsonObject, type ListPage, type Pull, type SiteDependencies } from "@lifestreamprotocol/connect/sdk";
import { chatgpt } from "./connector.js";
import { chatgptConversation, chatgptMediaIds } from "./reader.js";

const { uuid } = checks;

const ORIGIN = chatgpt.chrome.origin;
const PAGE = 28;
const EMPTY_WAITS_MS = [2_000, 5_000, 10_000];
const QUIET_PAGES = 2;
const PACE_MS = 5_000;
const AUTHORIZED = { Authorization: { held: TOKEN, prefix: "Bearer " } };
const MEDIA_ID = /^file[-_][A-Za-z0-9]+$/u;

interface Position {
  readonly list: number;
  readonly offset: number;
  readonly quiet: number;
}

function pairs(items: unknown): [string, string][] {
  const out: [string, string][] = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!isObject(item) || typeof item.id !== "string" || !uuid(item.id)) continue;
    out.push([item.id, typeof item.update_time === "string" || typeof item.update_time === "number" ? String(item.update_time) : ""]);
  }
  return out;
}

export function chatgptBrowserAcquirer(settings: BrowserSettings, dependencies: SiteDependencies = {}): Acquirer {
  return browserAcquirer(settings, dependencies, {
    name: "chatgpt-browser",
    site: chatgpt,
    pace_ms: PACE_MS,
    async begin(pull) {
      const { who, bytes } = await whoIs("ChatGPT", chatgpt.chrome.probe, pull.read);
      if (!/^user-[^:]+$/u.test(who.id) || bytes === undefined) throw new Error("chatgpt.com's /backend-api/me names no user-… id");
      pull.keep("me.json", bytes);
      return who;
    },
    async *list(pull, known, from, old): AsyncIterable<ListPage> {
      const at = (from ?? { list: 0, offset: 0, quiet: 0 }) as unknown as Position;
      const unchanged = (items: [string, string][]) => items.every(([id, listed]) => {
        const held = known(id);
        return held !== undefined && !newer(listed, held);
      });
      for (let list = at.list; list < 2; list++) {
        const archived = list === 1 ? "&is_archived=true" : "";
        let quiet = list === at.list ? at.quiet : 0;
        for (let offset = list === at.list ? at.offset : 0; ; offset += PAGE) {
          const ask = (from: number) => listPage(pull, `/backend-api/conversations?offset=${from}&limit=${PAGE}&order=updated${archived}`);
          let found = await ask(offset);
          for (const wait of EMPTY_WAITS_MS) {
            if (found.length > 0) break;
            await pull.wait(wait);
            found = await ask(offset);
          }
          if (found.length === 0) {
            if ((await ask(offset + PAGE)).length > 0) throw new Error(`chatgpt.com listed no conversations at offset ${offset} and some after it: the list's end is not confirmed`);
            break;
          }
          const items = pairs(found);
          quiet = unchanged(items) ? quiet + 1 : 0;
          const ended = quiet === QUIET_PAGES || items.some(([, listed]) => old(listed));
          const next: Position = ended ? { list: list + 1, offset: 0, quiet: 0 } : { list, offset: offset + PAGE, quiet };
          yield { items, next: next as unknown as Json };
          if (ended) break;
        }
      }
      const items: [string, string][] = [];
      for (const gizmo of await projects(pull)) {
        for (let cursor: string | null = "0"; cursor !== null; ) {
          const page = await pull.json(`/backend-api/gizmos/${encodeURIComponent(gizmo)}/conversations?cursor=${encodeURIComponent(cursor)}`, { headers: AUTHORIZED });
          if (page.status !== 200) throw new Error(`chatgpt.com answered ${page.status} listing a project's conversations`);
          items.push(...pairs(isObject(page.json) ? page.json.items : undefined));
          cursor = nextCursor(page.json);
        }
      }
      yield { items, next: null };
    },
    *exported(directory) {
      for (const file of exportedFiles(directory, /^conversations(-\d+)?\.json$/u)) {
        for (const item of Array.isArray(file) ? file : []) {
          if (!isObject(item)) continue;
          const id = typeof item.conversation_id === "string" ? item.conversation_id : item.id;
          if (typeof id === "string" && uuid(id) && typeof item.update_time === "number") yield [id, String(item.update_time)] as const;
        }
      }
    },
    async conversation(pull, id, media) {
      const [answer] = await pull.files([{ url: `/backend-api/conversation/${id}`, headers: AUTHORIZED }]);
      if (answer!.bytes === undefined) return unread(answer!);
      const value = readBody(answer!.bytes, id);
      if (!isObject(value) || value.conversation_id !== id || !readable(() => chatgptConversation(value, id, new Map(), "browser"))) return "gone";
      pull.keep(`conversations/${id}.json`, answer!.bytes);
      const wanted = [...new Set(Object.values(value.mapping as JsonObject).flatMap((node) => chatgptMediaIds({ node })))]
        .filter((file) => !media.fetched(file) && !pull.asked.has(file) && MEDIA_ID.test(file));
      if (wanted.length === 0) return "read";
      for (const file of wanted) pull.asked.add(file);
      const named = await pull.jsons(wanted.map((file) => ({ url: `/backend-api/files/download/${file}?conversation_id=${id}&inline=false`, headers: AUTHORIZED })));
      const links: { file: string; url: string }[] = [];
      for (const [index, file] of wanted.entries()) {
        const said = named[index]!;
        const download = said.status === 200 && isObject(said.json) && said.json.status === "success" ? said.json.download_url : undefined;
        if (typeof download !== "string" || new URL(download, ORIGIN).origin !== ORIGIN) continue;
        links.push({ file, url: download });
      }
      if (links.length === 0) return "read";
      const fetched = await pull.files(links.map((link) => ({ url: link.url, headers: AUTHORIZED })));
      for (const [index, { file }] of links.entries()) {
        const bytes = fetched[index]!.bytes;
        if (bytes === undefined) continue;
        pull.keep(`${file}.dat`, bytes);
        media.took(file);
      }
      return "read";
    },
  });
}

async function listPage(pull: Pull, url: string): Promise<unknown[]> {
  const page = await pull.json(url, { headers: AUTHORIZED });
  if (page.status !== 200) throw new Error(`chatgpt.com answered ${page.status} listing conversations`);
  if (!isObject(page.json) || !Array.isArray(page.json.items)) throw new Error("chatgpt.com answered a conversations page with no items list");
  return page.json.items;
}

async function projects(pull: Pull): Promise<string[]> {
  const out: string[] = [];
  for (let cursor: string | null = ""; cursor !== null; ) {
    const page = await pull.json(`/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0${cursor === "" ? "" : `&cursor=${encodeURIComponent(cursor)}`}`, { headers: AUTHORIZED });
    if (page.status !== 200) throw new Error(`chatgpt.com answered ${page.status} listing projects`);
    for (const item of isObject(page.json) && Array.isArray(page.json.items) ? page.json.items : []) {
      const gizmo = isObject(item) && isObject(item.gizmo) && isObject(item.gizmo.gizmo) ? item.gizmo.gizmo.id : undefined;
      if (typeof gizmo === "string" && /^[A-Za-z0-9-]+$/u.test(gizmo) && !out.includes(gizmo)) out.push(gizmo);
    }
    cursor = nextCursor(page.json);
  }
  return out;
}

function nextCursor(page: unknown): string | null {
  const cursor = isObject(page) ? page.cursor : undefined;
  return typeof cursor === "number" || (typeof cursor === "string" && cursor !== "") ? String(cursor) : null;
}
