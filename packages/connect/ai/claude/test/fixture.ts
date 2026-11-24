import type { Fixture } from "../../../test/drive.js";
import type { ItemOf, Scenario, Site } from "../../../sdk.js";
import { ClaudeSite, claudeBrowserFixture, type ClaudeChat } from "../../test/browser.js";
import { claudeFixture } from "../../test/fixtures.js";

export const fixtures: Readonly<Record<string, Fixture>> = {
  "claude-browser": claudeBrowserFixture,
  "claude-export": claudeFixture,
};

const HOUR = 3_600_000;
const SECOND = 1_000;
const pad = (n: number, width: number) => String(n).padStart(width, "0");
const claudeTime = (ms: number) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/u, ".$1001Z");

function chatOf(n: number, created_ms: number, updated_ms: number, edited: boolean): ClaudeChat {
  const id = (last: string) => `c${pad(n, 7)}-0000-4000-8000-${pad(n, 11)}${last}`;
  const at = claudeTime(created_ms);
  return {
    uuid: id("0"), name: `Synthetic browser chat ${n}${edited ? ", edited" : ""}`, created_at: at, updated_at: claudeTime(updated_ms),
    messages: [
      { uuid: id("a"), parent: null, sender: "human", text: `Synthetic question ${n}.`, at },
      { uuid: id("b"), parent: id("a"), sender: "assistant", text: `Synthetic answer ${n}.`, at },
    ],
  };
}

export function site(scenario: Scenario): Site {
  const site = new ClaudeSite();
  site.chats = [];
  for (let n = 0; n < scenario.items; n++) {
    if (scenario.removed.includes(n)) continue;
    site.chats.push(chatOf(n, createdAt(scenario, n), dated(scenario, n), scenario.edited.includes(n)));
  }
  return site;
}

const createdAt = (scenario: Scenario, n: number): number => scenario.stamped?.[n] ?? (n < scenario.old ? scenario.start_ms - (scenario.old - n) * HOUR : scenario.start_ms + (n - scenario.old + 1) * SECOND);

export const dated = (scenario: Scenario, n: number): number => (scenario.edited.includes(n) ? scenario.start_ms + (scenario.items + 1) * SECOND : createdAt(scenario, n));

export const item: ItemOf = ({ key }) => {
  const n = /^c(\d{7})-0000-4000-8000-/u.exec(key)?.[1];
  return n === undefined ? null : Number(n);
};
