export class Stretches<T extends { key: string }> {
  #read: [number, number][] = [];
  readonly #keys = new Set<string>();
  #sorted: T[] = [];

  constructor(readonly at: (value: T) => number) {}

  cover(lo: number, hi: number, load: (from: number, to: number) => T[]): void {
    if (hi <= lo) return;
    let from = lo;
    const kept: [number, number][] = [];
    for (const [a, b] of this.#read) {
      if (b < lo || a > hi) {
        kept.push([a, b]);
        continue;
      }
      if (a > from) this.#add(load(from, a));
      from = Math.max(from, b);
      lo = Math.min(lo, a);
      hi = Math.max(hi, b);
    }
    if (from < hi) this.#add(load(from, hi));
    this.#read = [...kept, [lo, hi] as [number, number]].sort((left, right) => left[0] - right[0]);
  }

  within(lo: number, hi: number): T[] {
    return this.#sorted.slice(this.#first(lo), this.#first(hi));
  }

  #add(found: readonly T[]): void {
    const fresh = found.filter((value) => !this.#keys.has(value.key));
    if (fresh.length === 0) return;
    for (const value of fresh) this.#keys.add(value.key);
    fresh.sort((left, right) => this.#by(left, right));
    const kept = this.#sorted;
    if (kept.length === 0 || this.#by(kept.at(-1)!, fresh[0]!) <= 0) {
      this.#sorted = [...kept, ...fresh];
      return;
    }
    const out: T[] = [];
    let i = 0;
    let j = 0;
    while (i < kept.length || j < fresh.length) {
      if (j >= fresh.length || (i < kept.length && this.#by(kept[i]!, fresh[j]!) <= 0)) out.push(kept[i++]!);
      else out.push(fresh[j++]!);
    }
    this.#sorted = out;
  }

  #by(left: T, right: T): number {
    return this.at(left) - this.at(right) || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
  }

  #first(ms: number): number {
    const sorted = this.#sorted;
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.at(sorted[middle]!) < ms) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}
