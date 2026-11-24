import { canonical, deliveredLines, isObject, lineText, parseLine, refuse, type Guard, type Json, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";

export const GROUPS_FILE = "groups.ndjson";
export const MONTH_KIND = "month";

const KEY = /^[a-z0-9][a-z0-9-]*:.+:(\d{4}-(?:0[1-9]|1[0-2]))$/u;
const DAY = /^\d{4}-\d{2}-\d{2}$/u;

export type DaySpan = readonly [string, string];

export interface Month {
  yours: DaySpan[];
}

function isDay(value: Json | undefined): value is string {
  return typeof value === "string" && DAY.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

const monthGuard: Guard = (content) => {
  if (!isObject(content) || Object.keys(content).join(",") !== "yours" || !Array.isArray(content.yours)) return ["content must have exactly yours, a list of spans"];
  const violations: string[] = [];
  let last = "";
  for (const [index, span] of content.yours.entries()) {
    if (!Array.isArray(span) || span.length !== 2 || !isDay(span[0]) || !isDay(span[1]) || span[0] > span[1]) {
      violations.push(`yours[${index}] must be [first, last], two days, first not after last`);
      continue;
    }
    if (span[0] <= last) violations.push(`yours[${index}] must start after the span before it ends`);
    last = span[1];
  }
  return violations;
};

export function groupsLine(key: string, content: Month | "gone"): string {
  return canonical(content === "gone" ? { gone: true, key, kind: MONTH_KIND } : { content: content as unknown as Json, key, kind: MONTH_KIND });
}

export const groupsConnector: Reader = {
  name: "groups",
  kinds: { [MONTH_KIND]: monthGuard },
  async *read(delivery, files): AsyncIterable<ReaderOutput> {
    const [listing, ...more] = delivery.files;
    if (listing === undefined || more.length > 0 || listing.path !== GROUPS_FILE) {
      refuse(`a groups delivery holds one ${GROUPS_FILE}, not ${JSON.stringify(delivery.files.map((file) => file.path))}`);
    }
    for (const yielding of [false, true]) {
      for await (const { bytes, line, where } of deliveredLines(files, listing)) {
        const one = row(lineText(bytes, where), line);
        if (yielding) yield one;
      }
    }
  },
};

function row(line: string, ordinal: number): ReaderOutput {
  const at = `${GROUPS_FILE} line ${ordinal}`;
  const value = parseLine(line, at);
  if (value.kind !== MONTH_KIND) return refuse(`${at} must state kind month`);
  const key = value.key;
  const month = typeof key === "string" ? KEY.exec(key)?.[1] : undefined;
  if (month === undefined) return refuse(`${at} must state a key: <chat key>:<YYYY-MM>`);
  const members = Object.keys(value).sort().join(",");
  if (members === "gone,key,kind" && value.gone === true) return { kind: MONTH_KIND, key: key as string, content: null, gone: true };
  if (members !== "content,key,kind") return refuse(`${at} must have exactly kind, key and content, or kind, key and gone: true`);
  const violations = monthGuard(value.content!);
  if (violations.length === 0 && (value.content as unknown as Month).yours.some(([first, last]) => first.slice(0, 7) !== month || last.slice(0, 7) !== month)) {
    violations.push(`every span must lie inside ${month}`);
  }
  return violations.length > 0 ? refuse(`${at}: ${violations.join("; ")}`) : { kind: MONTH_KIND, key: key as string, content: value.content! };
}
