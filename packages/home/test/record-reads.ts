import type { Collection } from "@lifestreamprotocol/families";
import { countWhole, PeopleCounts, type Admission, type CountAnswer, type CountAsk, type CountContext, type Edges, type Population, type Raw } from "../counting.js";
import type { Cell } from "../cell.js";
import { Refusal } from "../refusal.js";
import type { SearchAnswer, SearchQuery } from "../record-search.js";
import { termsOf, type Term } from "../search-words.js";
import type { SearchIndex } from "../search-index.js";
import { countParams, paramsOf } from "../search-contract.js";
import { readRef } from "../refs.js";
import { admit, ALWAYS, countAskedOf, countAskOf, countWithAlso, openRowIn, readsOf, resolve, countAttached, type CountReads } from "../count.js";

export const exactTerms = (typed: string): Term[] => termsOf(typed).map((term) => ({ ...term, exact: true }));

export function searchOf(index: SearchIndex, query: SearchQuery): SearchAnswer {
  return index.snapshot({}, (read) => read.search(query));
}

export function peopleCountsOf<T>(index: SearchIndex, context: CountContext, collections: { person: readonly string[]; chat: readonly string[] }, budget: number, work: (counts: PeopleCounts) => T): T {
  return index.snapshot({}, (read) => read.facts((facts) => work(new PeopleCounts(facts, context, collections, budget))));
}

export function countAsked(params: Readonly<Record<string, string | readonly string[]>>, collections: ReadonlyMap<string, Collection>): CountAsk {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) for (const each of [value].flat()) query.append(name, each);
  return countAskedOf(paramsOf(countParams, query), collections);
}

export function countOf(index: SearchIndex, ask: CountAsk, context: CountContext): CountAnswer {
  return index.snapshot(countAttached(ask, context), (read) => countWithAlso(read, ask, context));
}

export function rowOf(index: SearchIndex, ref: string, context: CountContext): CountAnswer {
  const { ask, kept, scope } = readRef(ref, "ref", ["row"]).parts;
  const asked = countAskOf(ask, context.collections);
  return index.snapshot(countAttached(asked, context), (read) => openRowIn(read, asked, kept, scope, undefined, context)).answer;
}

export function readsOfIndex(index: SearchIndex, context: CountContext): CountReads {
  const step = <T>(ask: CountAsk, run: (reads: CountReads) => T): T => index.snapshot(countAttached(ask, context), (read) => run(readsOf(read, context)));
  return {
    resolve: (ask, options) => step(ask, (reads) => reads.resolve(ask, options)),
    count: (ask, admitted, snapshot) => step(ask, (reads) => reads.count(ask, admitted, snapshot)),
  };
}

export interface PopulationSaid {
  total: { partition: string | null; n: number }[];
  groups: { keys: Raw[]; partition: string | null; n: number }[];
  overlap: number;
  matched: Record<string, { value: string; n: number }[][]>;
  covers: { source: string; last: string }[];
  held: Edges;
}

export function countedBy(index: SearchIndex, ask: CountAsk, context: CountContext, way: "chosen" | "facts", admission?: Admission): PopulationSaid | { refused: string; message: string } {
  const by = ask.by.filter((key) => key !== "item");
  const rows = <T extends { keys?: Raw[]; partition: string | null }>(list: readonly T[]) => [...list].sort((left, right) => (JSON.stringify([left.keys, left.partition]) < JSON.stringify([right.keys, right.partition]) ? -1 : 1));
  try {
    return index.snapshot(countAttached(ask, context), (record) => record.facts((read) => {
      return countWhole(read, ask, context, admission ?? admit(resolve(read, ask, context), ALWAYS) as Admission, (run): PopulationSaid => {
        const population: Population = way === "chosen" ? run.populationOf() : run.factRows();
        const matched: PopulationSaid["matched"] = {};
        for (const [key, took] of Object.entries(run.admitted.took)) {
          matched[key] = took.map(({ names }) => population.matchedOf(key, names).map(({ value, n }) => ({ value, n })).sort((left, right) => (left.value < right.value ? -1 : 1)));
        }
        return {
          total: rows(population.groupsOf([])).map(({ partition, n }) => ({ partition, n })),
          groups: rows(population.groupsOf(by)).map(({ keys, partition, n }) => ({ keys, partition, n })),
          overlap: population.overlapOf(by), matched, covers: population.coversOf(), held: population.edges(),
        };
      });
    }));
  } catch (error) {
    if (error instanceof Refusal) return { refused: error.code, message: error.message };
    throw error;
  }
}

export function shown(answer: CountAnswer): Record<string, unknown> {
  const show = (cell: Cell) => cell.value;
  const named = (cell: Cell) => String(show(cell));
  const cells = (record: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(record).map(([name, value]) => [name, isCell(value) ? show(value)
    : Array.isArray(value) ? value.map((each) => (isCell(each) ? show(each) : cells(each as Record<string, unknown>))) : typeof value === "object" && value !== null ? cells(value as Record<string, unknown>) : value]));
  if (answer.catalog !== undefined) {
    return { asked: show(answer.asked), families: cells((answer.families ?? {}) as unknown as Record<string, unknown>), catalog: cells(answer.catalog as unknown as Record<string, unknown>), ...fresh(answer), next: null };
  }
  return {
    asked: show(answer.asked),
    matched: {
      ...(answer.matched.from === undefined ? {} : { from: answer.matched.from }), ...(answer.matched.to === undefined ? {} : { to: answer.matched.to }),
      ...Object.fromEntries(Object.entries(answer.matched.values).map(([key, terms]) => [key, Object.fromEntries(terms.map(({ said, values }) => [named(said), values.map((each) => `${show(each.value)} (${each.n})`)]))])),
      ...(answer.matched.person.length === 0 ? {} : { person: Object.fromEntries(answer.matched.person.map((each) => [named(each.said), show(each.is)])) }),
    },
    ...(answer.abroad === undefined ? {} : { abroad: answer.abroad.map(cells) }),
    ...(answer.days_there === undefined ? {} : { days_there: show(answer.days_there) }),
    population: cells(answer.population),
    ...(answer.held === undefined ? {} : { held: show(answer.held) }),
    ...(answer.covers === undefined ? {} : { covers: answer.covers.map(show) }),
    ...(answer.counted === undefined ? {} : { counted: show(answer.counted) }),
    ...(answer.also === undefined ? {} : { also: answer.also.map(show) }),
    ...(answer.readings === undefined ? {} : { readings: answer.readings.map(show) }),
    total: answer.total.length === 1 && answer.total[0]!.partition === undefined ? cells(answer.total[0]!.cells) : answer.total.map((each) => ({ ...(each.partition === undefined ? {} : { of: show(each.partition) }), ...cells(each.cells) })),
    columns: answer.columns,
    rows: answer.rows.map((row) => row.map(show)),
    ...fresh(answer),
    next: answer.next === null ? null : show(answer.next),
  };
}

function fresh(answer: CountAnswer): Record<string, unknown> {
  return {
    ...(answer.as_of === undefined ? {} : { as_of: answer.as_of }),
    ...(answer.pending === undefined ? {} : { pending: answer.pending }),
    ...(answer.pending_more === undefined ? {} : { pending_more: answer.pending_more }),
  };
}

function isCell(value: unknown): value is Cell {
  return typeof value === "object" && value !== null && "is" in value && "value" in value && typeof (value as { is: unknown }).is === "string";
}
