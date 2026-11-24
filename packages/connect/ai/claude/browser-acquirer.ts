import { browserAcquirer, checks, exportedFiles, isObject, readable, readBody, unread, whoIs, type Acquirer, type BrowserRecipe as Recipe, type BrowserSettings, type SiteDependencies } from "@lifestreamprotocol/connect/sdk";
import { claudeBrowserConversation } from "./browser-reader.js";
import { claude } from "./connector.js";
import { chatOrganization } from "./organization.js";

const { uuid } = checks;

const PAGE = 100;

export function claudeBrowserAcquirer(settings: BrowserSettings, dependencies: SiteDependencies = {}): Acquirer {
  let organization: string | null = null;
  const chats = async (pull: Parameters<Recipe["list"]>[0]): Promise<string> => (organization ??= chatOrganization(await pull.json("/api/organizations")));
  return browserAcquirer(settings, dependencies, {
    name: "claude-browser",
    site: claude,
    pace_ms: 0,
    async begin(pull) {
      const { who, bytes } = await whoIs("Claude", claude.chrome.probe, pull.read);
      if (!uuid(who.id) || bytes === undefined) throw new Error(`claude.ai's ${claude.chrome.probe.url} names no account UUID`);
      pull.keep("account.json", bytes);
      organization = null;
      return who;
    },
    async *list(pull, _known, from) {
      const organization = await chats(pull);
      for (let offset = typeof from === "number" ? from : 0; ; offset += PAGE) {
        const page = await pull.json(`/api/organizations/${organization}/chat_conversations?limit=${PAGE}&offset=${offset}`);
        if (page.status !== 200 || !Array.isArray(page.json)) throw new Error(`claude.ai answered ${page.status} listing conversations`);
        const items: [string, string][] = [];
        for (const item of page.json) {
          if (isObject(item) && typeof item.uuid === "string" && uuid(item.uuid) && typeof item.updated_at === "string") items.push([item.uuid, item.updated_at]);
        }
        const last = page.json.length < PAGE;
        yield { items, next: last ? null : offset + PAGE };
        if (last) return;
      }
    },
    *exported(directory) {
      for (const file of exportedFiles(directory, /^conversations\.json$/u)) {
        for (const item of Array.isArray(file) ? file : []) {
          if (isObject(item) && typeof item.uuid === "string" && uuid(item.uuid) && typeof item.updated_at === "string") yield [item.uuid, item.updated_at] as const;
        }
      }
    },
    async conversation(pull, id) {
      const at = `/api/organizations/${await chats(pull)}/chat_conversations/${id}?tree=True`;
      const [rendered, plain] = await pull.files([{ url: `${at}&rendering_mode=messages&render_all_tools=true` }, { url: at }]);
      const missing = [rendered!, plain!].filter((answer) => answer.bytes === undefined);
      if (missing.length > 0) return missing.some((answer) => unread(answer) === "later") ? "later" : "gone";
      const [blocks, texts] = [readBody(rendered!.bytes!, id), readBody(plain!.bytes!, id)];
      if (!isObject(blocks) || !isObject(texts) || !readable(() => claudeBrowserConversation(id, blocks, texts, id))) return "gone";
      pull.keep(`conversations/${id}.messages.json`, rendered!.bytes!);
      pull.keep(`conversations/${id}.text.json`, plain!.bytes!);
      return "read";
    },
  });
}
