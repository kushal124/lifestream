import { browserAcquirer, isObject, unread, whoIs, type Acquirer, type AcquirerSettings, type Dependencies } from "@lifestreamprotocol/connect/sdk";
import { exampleBrowser } from "./connector.js";

const ORIGIN = exampleBrowser.chrome.origin;
const PAGE = 50;
const ID = /^[\w-]+$/u;

export function exampleBrowserAcquirer(settings: AcquirerSettings, dependencies: Dependencies = {}): Acquirer {
  return browserAcquirer(settings, dependencies, {
    name: "example-browser",
    site: exampleBrowser,
    pace_ms: 0,
    async begin(pull) {
      const { who, bytes } = await whoIs("Example", exampleBrowser.chrome.probe, pull.read);
      if (!ID.test(who.id) || bytes === undefined) throw new Error(`${ORIGIN}${exampleBrowser.chrome.probe.url} names no account id`);
      pull.keep("account.json", bytes);
      return who;
    },
    async *list(pull, _known, from, old) {
      for (let offset = typeof from === "number" ? from : 0; ; offset += PAGE) {
        const page = await pull.json(`/api/notes?limit=${PAGE}&offset=${offset}`);
        if (page.status !== 200 || !isObject(page.json) || !Array.isArray(page.json.items)) throw new Error(`${ORIGIN} answered ${page.status} listing notes`);
        const items: [string, string][] = [];
        for (const item of page.json.items) if (isObject(item) && typeof item.id === "string" && ID.test(item.id) && typeof item.updated_at === "string") items.push([item.id, item.updated_at]);
        const last = page.json.items.length < PAGE || items.some(([, at]) => old(at));
        yield { items, next: last ? null : offset + PAGE };
        if (last) return;
      }
    },
    *exported() {},
    async conversation(pull, id) {
      const [answer] = await pull.files([{ url: `/api/notes/${id}` }]);
      if (answer!.bytes === undefined) return unread(answer!);
      pull.keep(`notes/${id}.json`, answer!.bytes);
      return "read";
    },
  });
}
