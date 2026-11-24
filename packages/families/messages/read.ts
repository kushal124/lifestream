import { render, type MessagePart, type MessagesAdapter, type PartyKind, type SourceRow, type Version } from "@lifestreamprotocol/core";
import type { RecordRead, RecordText } from "../family.js";
import { recordRead, recordText } from "../shared/text.js";
import { partyWho } from "./networks.js";

export type Part = MessagePart;

export interface Fact {
  source: string;
  key: string;
  at: number;
  from: { id: string; kind: PartyKind };
  text?: string;
  parts?: Part[];
  forwarded?: true;
  edited?: true;
  withdrawn?: true;
  reply_to?: string;
}

export interface Read {
  network: string;
  chat: string;
  day: string;
  fact: Fact;
}

export function readMessage(adapter: MessagesAdapter, source: SourceRow, version: Version): Read | null {
  const at = version.time?.start_ms;
  if (at === undefined) return null;
  const read = readFound(adapter, source, version, at);
  return read === null ? null : { network: source.product, chat: read.chat, day: render(at, "UTC", "day"), fact: read.fact };
}

function readFound(adapter: MessagesAdapter, source: SourceRow, version: Version, at: number): { chat: string; fact: Fact } | null {
  const said = adapter.message({ source, version });
  if (said === null) return null;
  const fact: Fact = {
    source: source.id, key: version.key, at, from: said.from,
    ...(said.text === null ? {} : { text: said.text }),
    ...(said.parts.length === 0 ? {} : { parts: [...said.parts] }),
    ...(said.forwarded ? { forwarded: true as const } : {}),
    ...(said.edited ? { edited: true as const } : {}),
    ...(said.withdrawn ? { withdrawn: true as const } : {}),
    ...(said.reply_to === null ? {} : { reply_to: said.reply_to }),
  };
  return { chat: said.chat, fact };
}

export function messageText(adapter: MessagesAdapter, source: SourceRow, version: Version): RecordText | null {
  const found = readFound(adapter, source, version, version.time?.start_ms ?? 0);
  if (found === null || found.fact.text === undefined) return null;
  const who = [found.fact.from, ...adapter.members(found.chat)].flatMap((party) => partyWho(source.product, party) ?? []);
  return recordText({ text: found.fact.text, who });
}

export function messageRead(adapter: MessagesAdapter, source: SourceRow, version: Version): RecordRead | null {
  const found = readFound(adapter, source, version, version.time?.start_ms ?? 0);
  if (found === null || found.fact.text === undefined) return null;
  const from = found.fact.from.kind === "me" ? null : partyWho(source.product, found.fact.from) ?? undefined;
  const to = adapter.members(found.chat).flatMap((party) => partyWho(source.product, party) ?? []);
  return recordRead({ text: found.fact.text, ...(from === undefined ? {} : { from }), to });
}
