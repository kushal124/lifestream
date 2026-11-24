import { abbreviatedInstantOf, refuse, type Instant, type JsonObject } from "@lifestreamprotocol/connect/sdk";

const CELL = '<div class="outer-cell';
const CELL_LIMIT = 16 * 1024 * 1024;
const OPENS = /^\s*(?:<!DOCTYPE html>\s*)?<html[\s>]/iu;
const CLOSES = /<\/html>\s*$/iu;
const HEADER = /<p class="mdl-typography--title">([\s\S]*?)<\/p>/u;
const CONTENT = /<div class="content-cell ([^"]*)">([\s\S]*?)<\/div>/gu;
const BREAK = /<br\s*\/?>/u;
const LINK = /<a href="([^"]*)"/u;
const TAG = /<[^>]*>/gu;
const ENTITY = /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/giu;
const NAMED: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", emsp: " " };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const HTML_TIME = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}):(\d{2})[  ](AM|PM) (\S+)$/u;

export async function* cells(chunks: AsyncIterable<Buffer>, where: string): AsyncGenerator<{ html: string; where: string }> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const text = (chunk?: Buffer): string => {
    try {
      return decoder.decode(chunk, { stream: chunk !== undefined });
    } catch {
      refuse(`${where} is not UTF-8`);
    }
  };
  let held = "";
  let checked = false;
  let inCells = false;
  let index = 0;
  const page = () => {
    if (!OPENS.test(held)) refuse(`${where} is not the HTML page My Activity writes`);
    checked = true;
  };
  const next = (cell: string) => ({ html: cell, where: `${where}[${index++}]` });
  for await (const chunk of chunks) {
    held += text(chunk);
    if (!checked) {
      held = held.trimStart();
      if (held.length < "<!DOCTYPE html>".length) continue;
      page();
    }
    if (!inCells) {
      const first = held.indexOf(CELL);
      if (first < 0) {
        held = held.slice(-CELL.length);
        continue;
      }
      held = held.slice(first);
      inCells = true;
    }
    let start = 0;
    for (let end = held.indexOf(CELL, 1); end >= 0; start = end, end = held.indexOf(CELL, end + 1)) yield next(held.slice(start, end));
    held = held.slice(start);
    if (held.length > CELL_LIMIT) refuse(`${where}[${index}] is larger than ${CELL_LIMIT} bytes`);
  }
  held += text();
  if (!checked) page();
  if (!CLOSES.test(held)) refuse(`${where} is not closed by </html> after ${index} entries`);
  if (inCells) yield next(held);
}

export function htmlEntry(cell: string, where: string, zone: string): { entry: JsonObject; time: Instant } {
  const header = HEADER.exec(cell);
  if (header === null) refuse(`${where} states no header`);
  const contents = [...cell.matchAll(CONTENT)].map(([, classes, inner]) => ({ classes: classes!.split(" "), inner: inner! }));
  const body = contents.find((each) => each.classes.includes("mdl-typography--body-1") && !each.classes.includes("mdl-typography--text-right"));
  if (body === undefined) refuse(`${where} states no title`);
  const lines = body.inner.split(BREAK).filter((line) => line !== "");
  if (lines.length < 2) refuse(`${where} states no time`);
  const found = lines.findIndex((line, index) => index > 0 && HTML_TIME.test(line.replace(TAG, "")));
  const at = found < 0 ? lines.length - 1 : found;
  const stated = textOf(lines[at]!, where);
  const title = lines[0]!;
  const url = LINK.exec(title)?.[1];
  const answer = lines.slice(at + 1);
  const subtitles = lines.slice(1, at).map((line) => {
    const link = LINK.exec(line)?.[1];
    return { name: textOf(line, where), ...(link === undefined ? {} : { url: textOf(link, where) }) };
  });
  const caption = contents.find((each) => each.classes.includes("mdl-typography--caption"));
  const products = caption === undefined ? [] : productsOf(caption.inner, where);
  const time = timeOf(stated, zone, where);
  const entry: JsonObject = {
    header: textOf(header[1]!.replace(BREAK, ""), where),
    title: textOf(title.replace(/&nbsp;(?=<a\b)/gu, " "), where),
    ...(url === undefined ? {} : { titleUrl: textOf(url, where) }),
    ...(subtitles.length === 0 ? {} : { subtitles }),
    time: new Date(time.start_ms).toISOString().replace(/\.000Z$/u, "Z"),
    stated,
    ...(answer.length === 0 ? {} : { safeHtmlItem: [{ html: answer.join("<br>") }] }),
    ...(products.length === 0 ? {} : { products }),
  };
  return { entry, time };
}

function productsOf(caption: string, where: string): string[] {
  const at = caption.indexOf("<b>Products:</b>");
  if (at < 0) return [];
  const after = caption.slice(at + "<b>Products:</b>".length);
  const end = after.indexOf("<b>");
  return (end < 0 ? after : after.slice(0, end)).split(BREAK).map((line) => textOf(line, where).replace(/^ /u, "")).filter((line) => line !== "");
}

function timeOf(stated: string, zone: string, where: string): Instant {
  const [, month, day, year, hour, minute, second, half, abbreviation] = HTML_TIME.exec(stated) ?? [];
  const twelve = Number(hour);
  if (abbreviation === undefined || twelve < 1 || twelve > 12) refuse(`${where} time ${JSON.stringify(stated)} is not a time as My Activity's HTML spells it`);
  const clock = (twelve % 12) + (half === "PM" ? 12 : 0);
  const pad = (value: number | string) => String(value).padStart(2, "0");
  const wall = `${year}-${pad(MONTHS.indexOf(month!) + 1)}-${pad(day!)}T${pad(clock)}:${minute}:${second}`;
  return abbreviatedInstantOf(wall, abbreviation!, zone, `${where} time ${JSON.stringify(stated)}`);
}

function textOf(fragment: string, where: string): string {
  return fragment.replace(TAG, "").replace(ENTITY, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      if (!Number.isSafeInteger(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) refuse(`${where} states an entity that is no character: ${whole}`);
      return String.fromCodePoint(code);
    }
    return NAMED[body] ?? refuse(`${where} states an entity Takeout does not write: ${whole}`);
  });
}
