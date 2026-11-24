import { digest, type Json } from "@lifestreamprotocol/core";
import type { GuidesHeld, WaitingList } from "./access-routes.js";
import { guidesOf } from "./agent-guides.js";
import type { AnswerOf, Body, PageHandler } from "./pages.js";

export function waitingPage(list: WaitingList, position: string): PageHandler<AnswerOf<"agentsWaiting">> {
  const body: Body<AnswerOf<"agentsWaiting">> = { requests: list.requests.map((each) => ({ ...each, choices: [...each.choices] })), asks: list.asks };
  return {
    params: [],
    open: (_ask, use) => use({ position, inputs: [digest(body as unknown as Json)], counting: false, build: () => body }),
  };
}

export function guidesPage(held: GuidesHeld, position: string): PageHandler<AnswerOf<"agentGuides">> {
  return {
    params: [],
    open: (ask, use) => {
      const body: Body<AnswerOf<"agentGuides">> = guidesOf(held.readers, ask.device, held.sees);
      return use({ position, inputs: [digest(body as unknown as Json)], counting: false, build: () => body });
    },
  };
}
