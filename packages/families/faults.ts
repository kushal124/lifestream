import type { Adapters } from "@lifestreamprotocol/core";
import { aiFaults } from "./ai/faults.js";
import { calendarFaults } from "./calendar/faults.js";
import type { StatedFaults } from "./family.js";
import { healthFaults } from "./health/faults.js";
import { listeningFaults } from "./listening/faults.js";
import { mailFaults } from "./mail/faults.js";
import { messagesFaults } from "./messages/faults.js";
import { contentTxn } from "./money/family.js";
import { moneyFaults } from "./money/faults.js";
import { photosFaults } from "./photos/faults.js";
import { physicalFaults } from "./physical/faults.js";
import { plainFaults } from "./plain/faults.js";
import { voiceFaults } from "./voice/faults.js";

export const STATED_FAULTS: { readonly [F in keyof Adapters]?: StatedFaults<NonNullable<Adapters[F]>> } = {
  ai: aiFaults, calendar: calendarFaults, health: healthFaults, listening: listeningFaults, mail: mailFaults, messages: messagesFaults,
  money: moneyFaults, photos: photosFaults, physical: physicalFaults, line: plainFaults, voice: voiceFaults,
};

export const ABSENT_MEMBERS: { readonly [F in keyof Adapters]?: Readonly<Record<string, (input: never) => unknown>> } = {
  money: { txn: contentTxn },
};

export function absentMembers(family: string): Readonly<Record<string, (input: never) => unknown>> {
  return (Object.hasOwn(ABSENT_MEMBERS, family) ? ABSENT_MEMBERS[family as keyof Adapters] : undefined) ?? {};
}

export function statedFaults(family: string, stated: Parameters<StatedFaults>[0]): string[] {
  const check = Object.hasOwn(STATED_FAULTS, family) ? STATED_FAULTS[family as keyof Adapters] as StatedFaults | undefined : undefined;
  return check === undefined ? [] : check(stated);
}
