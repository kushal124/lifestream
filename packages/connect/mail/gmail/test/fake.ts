import type { FakeFolder } from "@lifestreamprotocol/connect/sdk";
import { fakeImap, refusedWith, type FakeImap } from "../../../test/imap.js";
import { ACCOUNT, message } from "./fixtures.js";

export type Folder = FakeFolder;

export { refusedWith };

const GMAIL_FLAGS: Readonly<Record<string, string>> = { "[Gmail]/All Mail": "\\All", "[Gmail]/Spam": "\\Junk", "[Gmail]/Trash": "\\Trash" };

export type FakeGmail = FakeImap & { throttleNext(after?: number): void };

export function fakeGmail(folders: Record<string, Folder>): FakeGmail {
  for (const [path, folder] of Object.entries(folders)) if (folder.specialUse === undefined && GMAIL_FLAGS[path] !== undefined) folder.specialUse = GMAIL_FLAGS[path];
  const fake = fakeImap(folders);
  return Object.assign(fake, { throttleNext: (after = 0) => fake.failNext(after, throttled()) });
}

export const throttled = (): Error => refusedWith("THROTTLED", "Request throttled. Try again later.");

export const MAIL_T0 = Date.UTC(2026, 8, 7, 4, 0, 0);

export function mail(folder: Folder, uid: number, id: number, labels: string[] = ["\\Inbox"], received = MAIL_T0 + id * 60_000): void {
  const gm = String(1790000000000000000n + BigInt(id));
  folder.messages.push({
    uid,
    emailId: gm,
    threadId: gm,
    labels: new Set(labels),
    internalDate: new Date(received),
    source: message(["From: person-b@example.com", `To: ${ACCOUNT}`, `Subject: synthetic ${id}`, "Date: Mon, 7 Sep 2026 09:30:00 +0530"], [`body ${id}`]),
  });
  folder.uidNext = Math.max(folder.uidNext, uid + 1);
}
