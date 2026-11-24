
export const PASSAGE_LIMIT = 1_000;

export interface Passage {
  start: number;
  end: number;
}

export function passagesOf(text: string): Passage[] {
  const passages: Passage[] = [];
  let paragraph: Passage | null = null;
  let start = 0;
  for (const line of text.split("\n")) {
    const end = start + line.length;
    if (line.trim() === "") {
      if (paragraph !== null) passages.push(...cut(text, paragraph));
      paragraph = null;
    } else {
      paragraph = paragraph === null ? { start, end } : { start: paragraph.start, end };
    }
    start = end + 1;
  }
  if (paragraph !== null) passages.push(...cut(text, paragraph));
  return passages;
}

function cut(text: string, paragraph: Passage): Passage[] {
  const parts: Passage[] = [];
  let from = paragraph.start;
  while (paragraph.end - from > PASSAGE_LIMIT) {
    let space = from + PASSAGE_LIMIT;
    while (space > from && !/\s/u.test(text[space]!)) space -= 1;
    if (space > from) {
      parts.push({ start: from, end: space });
      from = space + 1;
    } else {
      parts.push({ start: from, end: from + PASSAGE_LIMIT });
      from += PASSAGE_LIMIT;
    }
  }
  if (paragraph.end > from) parts.push({ start: from, end: paragraph.end });
  return parts;
}
