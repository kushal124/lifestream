import { render, type AiTurn } from "@lifestreamprotocol/core";

export interface Turn extends AiTurn {
  key: string;
  at_ms: number;
  source?: string;
}

export function conversationOfKey(key: string): string {
  const colon = key.indexOf(":");
  return colon < 0 ? key : key.slice(0, colon);
}

export function statesNothing(turn: Turn): boolean {
  return turn.words.trim() === "" && turn.attachments.length === 0 && turn.images === 0 &&
    turn.tools.length === 0 && turn.documents.length === 0 && turn.voice == null;
}

export const DAY_MS = 86_400_000;

export function pushNew(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

export function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function utcDate(ms: number): string {
  return render(ms, "UTC", "day");
}
