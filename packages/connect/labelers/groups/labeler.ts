import { addDays, type Json } from "@lifestreamprotocol/connect/sdk";
import { versionId } from "@lifestreamprotocol/core";
import type { Labeler } from "../../labeler.js";
import { GROUPS_FILE, groupsConnector, groupsLine, MONTH_KIND, type DaySpan, type Month } from "./reader.js";

export const PEOPLE_EVENT = "people";
export const PER_RUN = 5_000;

export interface GroupRow {
  readonly yours: readonly DaySpan[];
  readonly first_day: string;
  readonly last_day: string;
}

export interface PreparedGroups {
  readonly changed: string;
  readonly groups: ReadonlyMap<string, GroupRow>;
}

export interface GroupsSettings {
  unit: string;
  rows(): PreparedGroups | undefined;
  perRun?: number;
}

export function groupsLabeler(settings: GroupsSettings): Labeler {
  const source = `groups:local:${settings.unit}`;
  const most = settings.perRun ?? PER_RUN;
  let settled: string | undefined;
  return {
    name: "groups",
    source,
    inputs: [],
    events: [PEOPLE_EVENT],

    async label(view, _blobs, since) {
      const prepared = settings.rows();
      if (prepared === undefined) return null;
      const stated = !view.statements(since.seq, { sources: [source], kinds: [MONTH_KIND] })[Symbol.iterator]().next().done;
      if (settled === prepared.changed && !stated) return null;
      const heads = new Map<string, string>();
      for (const head of view.heads(source, MONTH_KIND)) if (head.version !== "gone") heads.set(head.key, head.version);

      const lines: string[] = [];
      let owed = 0;
      const state = (line: string) => {
        if (lines.length < most) lines.push(line);
        else owed++;
      };
      const wanted = new Set<string>();
      for (const chat of [...prepared.groups.keys()].sort(compare)) {
        const row = prepared.groups.get(chat)!;
        for (const month of monthsOf(row.first_day, row.last_day)) {
          const key = `${chat}:${month}`;
          wanted.add(key);
          const content: Month = { yours: monthSpans(row.yours, month) };
          if (heads.get(key) !== versionId(MONTH_KIND, key, content as unknown as Json).id) state(groupsLine(key, content));
        }
      }
      for (const key of [...heads.keys()].sort(compare)) if (!wanted.has(key)) state(groupsLine(key, "gone"));

      if (lines.length === 0) {
        settled = prepared.changed;
        return null;
      }
      settled = undefined;
      return {
        files: [{ path: GROUPS_FILE, bytes: Buffer.from(lines.map((line) => `${line}\n`).join("")) }],
        facts: { months: lines.length, owed, sources: [{ id: source, connector: groupsConnector.name }] },
      };
    },
  };
}

export function monthsOf(first: string, last: string): string[] {
  const out: string[] = [];
  for (let month = first.slice(0, 7); month <= last.slice(0, 7); month = nextMonth(month)) out.push(month);
  return out;
}

export function monthSpans(yours: readonly DaySpan[], month: string): DaySpan[] {
  const first = `${month}-01`;
  const last = addDays(`${nextMonth(month)}-01`, -1);
  return yours.flatMap(([from, to]): DaySpan[] => to < first || from > last ? [] : [[from < first ? first : from, to > last ? last : to]]);
}

function nextMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const number = Number(month.slice(5, 7));
  return number === 12 ? `${String(year + 1).padStart(4, "0")}-01` : `${month.slice(0, 4)}-${String(number + 1).padStart(2, "0")}`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
