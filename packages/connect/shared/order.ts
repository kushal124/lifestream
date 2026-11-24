import { canonical, type Json, type ReaderOutput } from "@lifestreamprotocol/core";

/** The values sorted by their canonical JSON text. */
export function ordered<T extends Json>(values: readonly T[]): T[] {
  return values
    .map((value) => ({ value, text: canonical(value) }))
    .sort((left, right) => compare(left.text, right.text))
    .map((entry) => entry.value);
}

/** Whether values are already sorted by their canonical JSON text. */
export function inOrder(values: readonly Json[]): boolean {
  return values.every((value, index) => index === 0 || compare(canonical(values[index - 1]!), canonical(value)) <= 0);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Holds back the rows of a key the delivery holds more than once, by the count given for it, until every copy has come, then hands them over sorted by their content's canonical JSON, `rest` handing over any still held. */
export function together(copies: ReadonlyMap<string, number>): { row(row: ReaderOutput): ReaderOutput[]; rest(): ReaderOutput[] } {
  const held = new Map<string, ReaderOutput[]>();
  const sorted = (group: ReaderOutput[]): ReaderOutput[] => group
    .map((row) => ({ row, text: canonical(row.content) }))
    .sort((left, right) => compare(left.text, right.text))
    .map((entry) => entry.row);
  return {
    row(row) {
      const count = copies.get(row.key) ?? 1;
      if (count === 1) return [row];
      const group = [...(held.get(row.key) ?? []), row];
      if (group.length < count) {
        held.set(row.key, group);
        return [];
      }
      held.delete(row.key);
      return sorted(group);
    },
    rest() {
      const groups = [...held.values()];
      held.clear();
      return groups.flatMap(sorted);
    },
  };
}
