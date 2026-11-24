import type { Fixture } from "../../../test/drive.js";
import type { ItemOf, Scenario, Site, SiteAnswer, SiteRequest } from "../../../sdk.js";
import { ChatgptSite, chatgptBrowserFixture, type GptChat } from "../../test/browser.js";
import { chatgptConversation, chatgptFixture, node } from "../../test/fixtures.js";

export const fixtures: Readonly<Record<string, Fixture>> = {
  "chatgpt-browser": chatgptBrowserFixture,
  "chatgpt-export": chatgptFixture,
};

const HOUR = 3_600_000;
const SECOND = 1_000;
const pad = (n: number, width: number) => String(n).padStart(width, "0");

class ScenarioSite extends ChatgptSite {
  override answer(request: SiteRequest): SiteAnswer {
    const one = /^\/backend-api\/conversation\/([^/]+)$/u.exec(request.url.pathname);
    const chat = one === null ? undefined : this.main.find((each) => each.id === one[1]);
    if (chat === undefined || this.signedOut) return super.answer(request);
    return { status: 200, body: conversationOf(chat) };
  }
}

function conversationOf(chat: GptChat): Record<string, unknown> {
  const n = chat.id.slice(0, 8);
  const [asked, replied] = [`${n}-1111-4000-8000-000000000001`, `${n}-1111-4000-8000-000000000002`];
  const { id: _, ...conversation } = chatgptConversation(chat.id, chat.title, chat.update, [
    node(asked, "client-created-root", chat.update - 5, "user", [`Synthetic browser question ${n}.`]),
    node(replied, asked, chat.update, "assistant", [`Synthetic browser answer ${n}.`]),
  ]);
  return { ...conversation, owner: null, is_starred: null, gizmo_type: null, memory_scope: "global_enabled" };
}

export function site(scenario: Scenario): Site {
  const site = new ScenarioSite();
  site.main = [];
  site.archived = [];
  site.projects = {};
  for (let n = 0; n < scenario.items; n++) {
    if (scenario.removed.includes(n)) continue;
    const edited = scenario.edited.includes(n);
    const updated = dated(scenario, n);
    site.main.push({ id: `${pad(n, 8)}-0000-4000-8000-${pad(n, 12)}`, title: `Synthetic browser chat ${n}${edited ? ", edited" : ""}`, update: updated / 1000 });
  }
  return site;
}

const createdAt = (scenario: Scenario, n: number): number => scenario.stamped?.[n] ?? (n < scenario.old ? scenario.start_ms - (scenario.old - n) * HOUR : scenario.start_ms + (n - scenario.old + 1) * SECOND);

export const dated = (scenario: Scenario, n: number): number => (scenario.edited.includes(n) ? scenario.start_ms + (scenario.items + 1) * SECOND : createdAt(scenario, n));

export const item: ItemOf = ({ key }) => {
  const n = /^(\d{8})-0000-4000-8000-/u.exec(key)?.[1];
  return n === undefined ? null : Number(n);
};
