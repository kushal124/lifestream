import { instant, isObject, TimeError, type CalendarAdapter, type InputRecord } from "@lifestreamprotocol/connect/sdk";

export const calendarAdapter: CalendarAdapter = {
  version: "1",
  kinds: ["reminder"],
  authority: "own",
  keys: "held",
  units: "product",

  reminder({ version }: InputRecord) {
    const content = version.content;
    if (!isObject(content) || content.type !== "apple.reminder" || !isObject(content.reminder)) return null;
    const row = content.reminder;
    const completed = row.ZCOMPLETED === 1;
    const due = version.time ?? null;
    return {
      modified: seconds(row.ZLASTMODIFIEDDATE) ?? Number.NEGATIVE_INFINITY,
      deleted: row.ZMARKEDFORDELETION === 1,
      value: {
        title: text(row.ZTITLE) ?? "",
        due: due === null ? null : { start_ms: due.start_ms, end_ms: due.end_ms ?? null, date_only: due.precision === "day" },
        completed,
        completed_ms: completed ? seconds(row.ZCOMPLETIONDATE) : null,
        list: isObject(content.list) ? text(content.list.ZNAME) : null,
        flagged: row.ZFLAGGED === 1,
      },
    };
  },

  words({ version }: InputRecord) {
    const content = version.content;
    if (!isObject(content) || content.type !== "apple.reminder" || !isObject(content.reminder)) return null;
    const row = content.reminder;
    return row.ZMARKEDFORDELETION === 1 ? null : { title: text(row.ZTITLE), text: text(row.ZNOTES) ?? "", who: [] };
  },
};

function seconds(value: unknown): number | null {
  if (typeof value !== "number") return null;
  try {
    return instant(value, "apple-s").start_ms;
  } catch (error) {
    if (error instanceof TimeError) return null;
    throw error;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
