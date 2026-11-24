import { canonical, deliveredLines, each, instantOf, isObject, lineText, parseLine, refuse, spanOf, type Guard, type Instant, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";

export const MONTH = "month";
export const MONTHS_FILE = "months.ndjson";
const KEY = /^\d{4}-(?:0[1-9]|1[0-2])$/u;

export interface Month {
  notes: number;
}

const month: Guard = (content) =>
  isObject(content) && Object.keys(content).join() === "notes" && Number.isSafeInteger(content.notes) && (content.notes as number) > 0 ? [] : ["a month is { notes }, a count above 0"];

export function monthLine(key: string, content: Month | "gone"): string {
  return canonical(content === "gone" ? { gone: true, key, kind: MONTH } : { content: { notes: content.notes }, key, kind: MONTH });
}

export function monthSpan(key: string, where: string): Instant {
  const [year, number] = key.split("-").map(Number) as [number, number];
  const end = new Date(Date.UTC(year, number, 1) - 1).toISOString();
  return spanOf(instantOf(`${key}-01T00:00:00.000Z`, "rfc3339", where), instantOf(end, "rfc3339", where), where);
}

export const exampleLabel: Reader = {
  name: "example-label",
  kinds: { [MONTH]: month },
  async *read(delivery, files) {
    const file = delivery.files.find((each) => each.path === MONTHS_FILE) ?? refuse(`a delivery of the labeler holds ${MONTHS_FILE}`);
    yield* each(deliveredLines(files, file), (part) => part.where, ({ bytes, where }): ReaderOutput[] => {
      const value = parseLine(lineText(bytes, where), where);
      if (value.kind !== MONTH || typeof value.key !== "string" || !KEY.test(value.key)) refuse(`${where} states no month: kind month, key YYYY-MM`);
      if (value.gone === true) return [{ kind: MONTH, key: value.key, content: null, gone: true }];
      return [{ kind: MONTH, key: value.key, content: value.content ?? null, time: monthSpan(value.key, where), locator: where }];
    });
  },
};
