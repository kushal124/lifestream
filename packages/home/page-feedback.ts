import { digest, type Json } from "@lifestreamprotocol/core";
import { FEEDBACK_KINDS, TEXT_MAX, type ReportState } from "./feedback.js";
import { KIND_TITLES } from "./feedback-text.js";
import type { AnswerOf, Body, PageHandler } from "./pages.js";

export const FEEDBACK_WORDS = {
  title: "Send feedback",
  about: { chat: "Feedback on this answer", connector: "Report a problem with {name}" },
  field: { placeholder: "What happened, or what would make Lifestream better?", max: TEXT_MAX },
  email: { label: "Email for a reply", placeholder: "Optional" },
  add: { screenshot: "Add screenshot" },
  see: "See what's sent",
  send: "Send",
  clear: "Clear",
  sent: { title: "Sent. Thank you.", line: "We'll reply to {email}." },
  again: "The attachments were made again. Read them before you send.",
  privacy: "Names and contact details in attachments are replaced. Read it before you send. A screenshot goes as it is.",
} as const;

export const REPORT_WORDS = {
  act: "Report a problem",
  receiver: "The people who make Lifestream",
  states: { queued: "Waiting to send", sent: "Sent", refused: "Not taken", expired: "Gave up" },
  erased: "Sent before you erased it; the people who make Lifestream hold this copy.",
} as const satisfies { act: string; receiver: string; states: Record<ReportState, string>; erased: string };

export function feedbackBody(open: boolean): Body<AnswerOf<"feedback">> {
  const { add, ...words } = FEEDBACK_WORDS;
  return {
    open,
    ...words,
    about: { ...words.about },
    field: { ...words.field },
    email: { ...words.email },
    sent: { ...words.sent },
    kinds: FEEDBACK_KINDS.map((kind) => ({ kind, title: KIND_TITLES[kind], add: kind === "screenshot" ? add.screenshot : null })),
  };
}

export function feedbackPage(open: boolean): PageHandler<AnswerOf<"feedback">> {
  const body = feedbackBody(open);
  return {
    params: [],
    open: (_ask, use) => use({ position: "0:0", inputs: [digest(body as unknown as Json)], counting: false, build: () => body }),
  };
}
