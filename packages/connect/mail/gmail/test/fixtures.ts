import { createHash } from "node:crypto";
import { closeSync, openSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "@lifestreamprotocol/core";
import type { Fixture } from "../../../test/drive.js";

export const ACCOUNT = "person-a@example.com";
export const SOURCE = `gmail:${ACCOUNT}:cloud`;

const crlf = (lines: string[]): Buffer => Buffer.from(lines.map((line) => `${line}\r\n`).join(""), "utf8");
const hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export function message(headers: string[], body: string[]): Buffer {
  return crlf([...headers, "", ...body]);
}

export const IMAP_MESSAGES: { uid: number; gm_msgid: string; gm_thrid: string; folder: string; labels: string[]; internaldate: string; bytes: Buffer }[] = [
  {
    uid: 101,
    gm_msgid: "1790000000000000101",
    gm_thrid: "1790000000000000101",
    folder: "[Gmail]/All Mail",
    labels: ["\\Inbox", "\\Important"],
    internaldate: "2026-09-06T12:01:00.000Z",
    bytes: message(
      ["From: Person B <person-b@example.com>", `To: ${ACCOUNT}`, "Subject: strict offset", "Date: Sun, 6 Sep 2026 17:31:00 +0530", "X-GM-THRID: 1790000000000000101"],
      ["A synthetic body."],
    ),
  },
  {
    uid: 102,
    gm_msgid: "1790000000000000102",
    gm_thrid: "1790000000000000101",
    folder: "[Gmail]/All Mail",
    labels: [],
    internaldate: "2026-09-06T12:02:00.000Z",
    bytes: message(
      [`From: ${ACCOUNT}`, "To: person-b@example.com", "Subject: folded with a comment", "Date: Sun, 06 Sep 2026", "\t12:02:30 -0000 (UTC)"],
      ["A synthetic reply."],
    ),
  },
  {
    uid: 103,
    gm_msgid: "1790000000000000103",
    gm_thrid: "1790000000000000103",
    folder: "[Gmail]/All Mail",
    labels: ["\\Inbox"],
    internaldate: "2026-09-06T12:03:00.000Z",
    bytes: message(["From: person-c@example.com", `To: ${ACCOUNT}`, "Subject: a named zone falls back", "Date: Sun, 6 Sep 2026 12:03:10 GMT"], ["Body."]),
  },
  {
    uid: 7,
    gm_msgid: "1790000000000000104",
    gm_thrid: "1790000000000000104",
    folder: "[Gmail]/Spam",
    labels: ["\\Spam"],
    internaldate: "2026-09-06T12:04:00.000Z",
    bytes: message(["From: person-d@example.com", `To: ${ACCOUNT}`, "Subject: no date at all"], ["Body."]),
  },
  {
    uid: 8,
    gm_msgid: "1790000000000000105",
    gm_thrid: "1790000000000000104",
    folder: "[Gmail]/Spam",
    labels: ["\\Spam", "Receipts"],
    internaldate: "2026-09-06T12:05:00.000Z",
    bytes: message(["From: person-d@example.com", "Subject: a date that does not exist", "Date: Wed, 31 Sep 2026 10:00:00 +0000"], ["Body."]),
  },
];

export function imapPull(messages = IMAP_MESSAGES, fetchedAt = "2026-09-07T04:00:00.000Z"): { files: Record<string, Buffer>; facts: JsonObject } {
  const files: Record<string, Buffer> = {};
  const entries = messages.map((entry) => {
    const file = `msg-${entry.gm_msgid}.eml`;
    files[file] = entry.bytes;
    return {
      file,
      folder: entry.folder,
      gm_msgid: entry.gm_msgid,
      gm_thrid: entry.gm_thrid,
      labels: entry.labels,
      internaldate: entry.internaldate,
      sha256: hex(entry.bytes),
      bytes: entry.bytes.length,
    };
  });
  const manifest = {
    format: "org.lifestreamprotocol.gmail-imap-pull/0.2",
    complete: true,
    account: ACCOUNT,
    fetched_at: fetchedAt,
    folders: [
      { folder: "[Gmail]/All Mail", uidvalidity: "77", uidnext: "104" },
      { folder: "[Gmail]/Spam", uidvalidity: "88", uidnext: "9" },
    ],
    messages: entries,
  };
  files["pull.json"] = Buffer.from(`${JSON.stringify(manifest)}\n`);
  return { files, facts: { fetched_at: fetchedAt, account: ACCOUNT, messages: entries.length, sources: [{ id: SOURCE, connector: "gmail-imap" }] } };
}

export function takeoutMbox(): Buffer {
  return crlf([
    "From 1790000000000000201@xxx Sat Sep 05 08:00:00 +0000 2026",
    "X-GM-THRID: 1790000000000000201",
    "X-Gmail-Labels: Inbox,Opened",
    "From: Person B <person-b@example.com>",
    `To: ${ACCOUNT}`,
    "Subject: seed message",
    "Date: Sat, 5 Sep 2026 13:30:00 +0530",
    "",
    "A synthetic body.",
    ">From the quoting Gmail adds",
    "From here a line that is no delimiter",
    "",
    "From 1790000000000000202@xxx Sat Sep 05 09:15:30 +0000 2026",
    "X-GM-THRID: 1790000000000000201",
    "X-Gmail-Labels: Sent",
    `From: ${ACCOUNT}`,
    "Subject: Re: seed message",
    "",
    "No Date header: the delimiter's internal date is the time.",
    "",
    "From 1790000000000000203@xxx Sun Sep  6 23:59:59 +0000 2026",
    "X-GM-THRID: 1790000000000000203",
    "X-Gmail-Labels: Archived",
    "From: person-c@example.com",
    "Subject: =?utf-8?q?caf=C3=A9?=",
    "Date: Mon, 7 Sep 26 05:29:59 +0530",
    "",
    "A two-digit year falls back to the internal date.",
    "",
  ]);
}

export function takeoutFacts(source = SOURCE, exportedAt = "2026-09-08T00:00:00Z"): JsonObject {
  return { exported_at: exportedAt, fetched_at: "2026-09-08T01:00:00Z", sources: [{ id: source, connector: "gmail-takeout" }] };
}
export const TAKEOUT_FACTS = takeoutFacts();

export function largeMbox(path: string, size: number): number {
  const fd = openSync(path, "w");
  const filler = `${"x".repeat(76)}\r\n`.repeat(820);
  let messages = 0;
  try {
    for (let at = 0; at < size; messages++) {
      const id = String(1790000000000000000n + BigInt(messages));
      const thread = String(1790000000000000000n + BigInt(messages % 500));
      const chunk = `${[`From ${id}@xxx Sat Sep 05 08:00:00 +0000 2026`, `X-GM-THRID: ${thread}`, "Date: Sat, 5 Sep 2026 13:30:00 +0530", "", ""].join("\r\n")}${filler}`;
      writeSync(fd, chunk);
      at += chunk.length;
    }
  } finally {
    closeSync(fd);
  }
  return messages;
}

export const gmailFixture: Fixture = (folder) => {
  writeFileSync(join(folder, "a.mbox"), takeoutMbox());
  const [first, second, third] = ["1790000000000000201", "1790000000000000202", "1790000000000000203"];
  return {
    source: SOURCE,
    facts: TAKEOUT_FACTS,
    files: { "a.mbox": { alone: [`mailmsg ${first}`, `mailmsg ${second}`, `mailmsg ${third}`, `chat ${first}`, `chat ${third}`], prefix: [`mailmsg ${first}`, `mailmsg ${second}`, `chat ${first}`], cut: ["chat 179000000"] } },
  };
};
