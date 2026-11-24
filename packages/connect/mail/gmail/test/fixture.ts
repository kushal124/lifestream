import type { FakeMailbox, ImapMessage, ItemOf, Scenario } from "@lifestreamprotocol/connect/sdk";
import type { Fixture } from "../../../test/drive.js";
import { ACCOUNT, gmailFixture, message } from "./fixtures.js";

export const fixtures: Readonly<Record<string, Fixture>> = {
  "gmail": gmailFixture,
};

export const immutable = true;

export const settings = { account: ACCOUNT, password: "gmail.password", per_poll: 10 };
export const secrets: Readonly<Record<string, string>> = { password: "synthetic-app-password" };

const FIRST_MSGID = 1790000000000100000n;
const HOUR = 3_600_000;
const SECOND = 1_000;

function mailOf(n: number, scenario: Scenario): ImapMessage {
  const received = dated(scenario, n);
  const id = String(FIRST_MSGID + BigInt(n));
  const date = new Date(received).toUTCString().replace("GMT", "+0000");
  return {
    uid: n + 1, emailId: id, threadId: id, labels: new Set(["\\Inbox"]), internalDate: new Date(received),
    source: message(["From: person-b@example.com", `To: ${ACCOUNT}`, `Subject: Synthetic mail ${n}`, `Date: ${date}`], [`Synthetic body ${n}.`]),
  };
}

export const dated = (scenario: Scenario, n: number): number => scenario.stamped?.[n] ?? (n < scenario.old ? scenario.start_ms - (scenario.old - n) * HOUR : scenario.start_ms + (n - scenario.old + 1) * SECOND);

export function mailbox(scenario: Scenario): FakeMailbox {
  const messages = Array.from({ length: scenario.items }, (_, n) => n).filter((n) => !scenario.removed.includes(n)).map((n) => mailOf(n, scenario));
  return {
    "INBOX": { uidValidity: 1, uidNext: 1, messages: [] },
    "[Gmail]/All Mail": { specialUse: "\\All", uidValidity: 2, uidNext: scenario.items + 1, messages },
    "[Gmail]/Spam": { specialUse: "\\Junk", uidValidity: 3, uidNext: 1, messages: [] },
    "[Gmail]/Trash": { specialUse: "\\Trash", uidValidity: 4, uidNext: 1, messages: [] },
  };
}

export const item: ItemOf = ({ kind, key }) => (kind === "mailmsg" && /^\d+$/u.test(key) && BigInt(key) >= FIRST_MSGID ? Number(BigInt(key) - FIRST_MSGID) : null);
