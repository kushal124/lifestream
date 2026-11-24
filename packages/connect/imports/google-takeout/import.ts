import { isObject } from "@lifestreamprotocol/core";
import type { Member } from "../../shared/members.js";
import type { Import } from "../index.js";
import { memberOf, patternsUnder } from "../reads.js";

const NAMED = /([A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})$/u;
const ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/u;
const TEXT_BYTES = 8 * 1024 * 1024;
const STAMP = /\d{8}T\d{6}Z/u;

const ROOT = { kind: "google-takeout", root: "Takeout/" } as const;
const BROWSER = /(?:^|\/)Takeout\/archive_browser\.html$/u;

export function stampInstant(stamp: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/u.exec(stamp);
  if (match === null) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number) as [number, number, number, number, number, number];
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const back = new Date(ms);
  return back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day && back.getUTCHours() === hour && back.getUTCMinutes() === minute && back.getUTCSeconds() === second ? ms : null;
}

function stampIn(text: string): string | null {
  const found = STAMP.exec(text)?.[0];
  return found !== undefined && stampInstant(found) !== null ? found : null;
}

export function stampOfName(file: string): string | null {
  const name = file.slice(file.lastIndexOf("/") + 1);
  return name.toLowerCase().startsWith("takeout-") ? stampIn(name) : null;
}

function textOf(member: Member): string | null {
  try {
    return member.bytes(TEXT_BYTES).toString("utf8");
  } catch {
    return null;
  }
}

function profileEmails(text: string): string[] {
  let profile: unknown;
  try {
    profile = JSON.parse(text);
  } catch {
    return [];
  }
  const listed = isObject(profile) && Array.isArray(profile.emails) ? profile.emails : [];
  const all: string[] = [];
  const primary: string[] = [];
  for (const item of listed) {
    const value = typeof item === "string" ? item : isObject(item) && typeof item.value === "string" ? item.value : undefined;
    const address = value?.trim();
    if (address === undefined || !ADDRESS.test(address)) continue;
    all.push(address.toLowerCase());
    if (isObject(item) && item.primary === true) primary.push(address.toLowerCase());
  }
  return primary.length > 0 ? primary : all;
}

export const googleTakeout: Import = {
  kind: "google-takeout",
  name: "Google Takeout",
  root: "Takeout/",
  of: (connector) => patternsUnder(connector, "Takeout/"),
  icon: "archive",
  takes: "Google takes minutes, or hours with photos",
  wait: "Minutes, or hours with photos",
  file: "zip",
  ask: "Whose Google account is this?",
  accounts: "google",
  guide: [
    {
      title: "Choose what Google sends",
      words: "On Google Takeout, press Deselect all, then tick Mail, Calendar, Contacts, Google Photos and My Activity. Under My Activity, press Multiple formats and choose JSON.",
      open: { label: "Open Google Takeout", url: "https://takeout.google.com/" },
    },
    { title: "Make the export", words: "Press Next step. Keep Send download link via email, Export once and .zip, choose 10 GB files, and press Create export." },
    { title: "Wait for the email", words: "When Google emails you, download every file." },
  ],

  async named(members) {
    const named = new Set<string>();
    const files = new Set<string>();
    for (const member of members) {
      const under = memberOf(ROOT, member.name);
      if (under === null) continue;
      const { folder, path } = under;
      const base = path.slice(path.lastIndexOf("/") + 1);
      if (folder === "Profile" && base === "Profile.json") {
        const text = textOf(member);
        if (text !== null) for (const email of profileEmails(text)) named.add(email);
      } else if ((folder === "Calendar" && base.toLowerCase().endsWith(".ics")) || folder === "Google Account") {
        const stem = base.replace(/\.[A-Za-z]+$/u, "").replace(/\.SubscriberInfo$/u, "");
        const account = NAMED.exec(stem)?.[1];
        if (account !== undefined) files.add(account.toLowerCase());
      }
    }
    for (const name of files) if (![...files].some((other) => other !== name && name.endsWith(`_${other}`))) named.add(name);
    return { named: [...named].sort() };
  },

  async stamp(file, members) {
    const named = stampOfName(file);
    if (named !== null) return named;
    for (const member of members) {
      if (!BROWSER.test(member.name)) continue;
      const text = textOf(member);
      const stamp = text === null ? null : stampIn(text);
      if (stamp !== null) return stamp;
    }
    return null;
  },

  async states(file, members) {
    const stamp = await googleTakeout.stamp!(file, members);
    const time = stamp === null ? null : stampInstant(stamp);
    return time === null ? null : { time_ms: time };
  },
};
