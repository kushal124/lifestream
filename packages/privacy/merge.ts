import { hides, type Level, type Mark } from "@lifestreamprotocol/core";

export interface Found extends Mark {
  way: number;
}

export function mergeMarks(found: readonly Found[], level: Level): Mark[] {
  const order = [...found].sort((left, right) => left.way - right.way || (right.end - right.start) - (left.end - left.start) || left.start - right.start);
  const standing = new Standing();
  for (const mark of order) place(standing, mark, level);
  return standing.marks.map(({ way: _way, ...mark }) => mark);
}

class Standing {
  readonly marks: Found[] = [];
  readonly #came = new Map<Found, number>();
  #next = 0;

  meets(mark: Found): Found[] {
    const met: Found[] = [];
    for (let index = this.#first((other) => other.end > mark.start); index < this.marks.length && this.marks[index]!.start < mark.end; index += 1) {
      if (mark.start < this.marks[index]!.end) met.push(this.marks[index]!);
    }
    return met.sort((left, right) => this.#came.get(left)! - this.#came.get(right)!);
  }

  add(mark: Found): void {
    this.marks.splice(this.#first((other) => other.start > mark.start), 0, mark);
    this.#came.set(mark, this.#next++);
  }

  remove(mark: Found): void {
    this.marks.splice(this.marks.indexOf(mark, this.#first((other) => other.start >= mark.start)), 1);
    this.#came.delete(mark);
  }

  replace(mark: Found, by: Found): void {
    this.marks[this.marks.indexOf(mark, this.#first((other) => other.start >= mark.start))] = by;
    const came = this.#came.get(mark)!;
    this.#came.delete(mark);
    this.#came.set(by, came);
  }

  #first(after: (other: Found) => boolean): number {
    let low = 0;
    let high = this.marks.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (after(this.marks[middle]!)) high = middle;
      else low = middle + 1;
    }
    return low;
  }
}

function place(standing: Standing, arriving: Found, level: Level): void {
  let mark = arriving;
  for (;;) {
    const meets = standing.meets(mark);
    if (meets.length === 0) {
      standing.add(mark);
      return;
    }
    const holder = meets.find((other) => other.start <= mark.start && mark.end <= other.end);
    if (holder !== undefined) {
      standing.replace(holder, outer(holder, mark, level));
      return;
    }
    const held = meets.filter((other) => mark.start <= other.start && other.end <= mark.end);
    const partial = meets.filter((other) => !held.includes(other));
    for (const other of meets) standing.remove(other);
    for (const inner of held) mark = outer(mark, inner, level);
    if (partial.length === 0) {
      standing.add(mark);
      return;
    }
    for (const other of partial) mark = joined(mark, other, level);
  }
}

function outer(holder: Found, inner: Found, level: Level): Found {
  const holderHidden = hides(level, holder.type);
  const innerHidden = hides(level, inner.type);
  if (holder.start === inner.start && holder.end === inner.end) {
    if (holderHidden !== innerHidden) return innerHidden ? inner : holder;
    return inner.way < holder.way ? inner : holder;
  }
  return innerHidden && !holderHidden ? { start: holder.start, end: holder.end, type: inner.type, way: Math.min(holder.way, inner.way) } : holder;
}

function joined(left: Found, right: Found, level: Level): Found {
  const leftHidden = hides(level, left.type);
  const rightHidden = hides(level, right.type);
  const earlier = left.way !== right.way ? (left.way < right.way ? left : right) : (left.end - left.start >= right.end - right.start ? left : right);
  const type = leftHidden !== rightHidden ? (leftHidden ? left.type : right.type) : earlier.type;
  return { start: Math.min(left.start, right.start), end: Math.max(left.end, right.end), type, way: Math.min(left.way, right.way) };
}
