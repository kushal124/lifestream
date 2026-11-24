import type { DayArea, PlacedDays } from "./where.js";

export interface ReadDay {
  day: string;
  known: DayArea[];
  guessed: DayArea[];
  night: DayArea | null;
  night_guess: DayArea | null;
}

export type RunLevel = "country" | "region" | "city";

export interface Run {
  from_day: string;
  to_day: string;
  days: number;
  guessed_days: number;
  nights: number;
  sure: "known" | "partly guessed" | "guessed";
  zone: string | null;
  zones?: string[];
  cities?: string[];
}

export interface AreaRuns {
  level: RunLevel;
  place: { city?: string; region?: string; country: string };
  days: number;
  guessed_days: number;
  nights: number;
  runs: Run[];
}

export function readDays(spans: readonly PlacedDays[]): ReadDay[] {
  return spans.flatMap(({ areas, days }) => days.map((day) => ({
    day: day.day, known: day.known.map((at) => areas[at]!), guessed: day.guessed.map((at) => areas[at]!),
    night: day.night === undefined ? null : areas[day.night]!, night_guess: day.night_guess === undefined ? null : areas[day.night_guess]!,
  })));
}

export function placesBy(days: readonly ReadDay[], level: "country" | "city"): AreaRuns[] {
  return runsBy(days, (area) => {
    const key = keyOf(level, area);
    return key === null ? [] : [key];
  });
}

function keyOf(level: RunLevel, area: DayArea): string | null {
  const within = level === "country" ? "" : level === "region" ? area.region : area.city_id;
  return within === null ? null : `${level}\0${area.country_code ?? ""}\0${area.country}\0${within}`;
}

function levelOf(key: string): RunLevel {
  return key.slice(0, key.indexOf("\0")) as RunLevel;
}

interface Open { run: Run; zones: Map<string, number>; cities: Map<string, number>; known: number }
interface Tally { level: RunLevel; area: DayArea; runs: Run[]; open: Open | null }

function runsBy(days: readonly ReadDay[], keysOf: (area: DayArea) => string[]): AreaRuns[] {
  const tallies = new Map<string, Tally>();
  const opened = new Set<string>();
  for (const day of days) {
    const held = new Map<string, { area: DayArea; guessed: boolean; cities: Set<string> }>();
    for (const [areas, guessed] of [[day.known, false], [day.guessed, true]] as const) {
      for (const area of areas) {
        for (const key of keysOf(area)) {
          const found = held.get(key) ?? { area, guessed, cities: new Set<string>() };
          if (area.city !== null && !(guessed && !found.guessed)) found.cities.add(area.city);
          held.set(key, found);
        }
      }
    }
    const nights = new Set([day.night, day.night_guess].flatMap((area) => area === null ? [] : keysOf(area)));
    for (const key of opened) {
      if (held.has(key)) continue;
      close(tallies.get(key)!);
      opened.delete(key);
    }
    for (const [key, { area, guessed, cities }] of held) {
      let tally = tallies.get(key);
      if (tally === undefined) tallies.set(key, tally = { level: levelOf(key), area, runs: [], open: null });
      opened.add(key);
      const open = tally.open ??= {
        run: { from_day: day.day, to_day: day.day, days: 0, guessed_days: 0, nights: 0, sure: "known", zone: null }, zones: new Map(), cities: new Map(), known: 0,
      };
      open.run.to_day = day.day;
      open.run.days++;
      if (guessed) open.run.guessed_days++;
      if (nights.has(key)) open.run.nights++;
      if (area.zone !== null) open.zones.set(area.zone, (open.zones.get(area.zone) ?? 0) + 1);
      for (const city of cities) open.cities.set(city, (open.cities.get(city) ?? 0) + 1);
    }
  }
  for (const tally of tallies.values()) if (tally.open !== null) close(tally);
  return [...tallies.values()].map(({ level, area, runs }): AreaRuns => ({
    level,
    place: { ...(level === "city" ? { city: area.city! } : {}), ...(level !== "country" && area.region !== null ? { region: area.region } : {}), country: area.country },
    days: sum(runs, "days"), guessed_days: sum(runs, "guessed_days"), nights: sum(runs, "nights"), runs,
  })).sort((left, right) => right.days - left.days || left.runs[0]!.from_day.localeCompare(right.runs[0]!.from_day) || nameOf(left).localeCompare(nameOf(right)));
}

function close(tally: Tally): void {
  const { run, zones, cities } = tally.open!;
  tally.open = null;
  const ranked = (counts: Map<string, number>) => [...counts].sort(([leftName, left], [rightName, right]) => right - left || leftName.localeCompare(rightName)).map(([name]) => name);
  const [zone, ...others] = ranked(zones);
  run.sure = run.guessed_days === 0 ? "known" : run.guessed_days === run.days ? "guessed" : "partly guessed";
  run.zone = zone ?? null;
  if (others.length > 0) run.zones = [zone!, ...others];
  if (tally.level !== "city" && cities.size > 0) run.cities = ranked(cities);
  tally.runs.push(run);
}

function sum(runs: readonly Run[], member: "days" | "guessed_days" | "nights"): number {
  return runs.reduce((total, run) => total + run[member], 0);
}

function nameOf(area: AreaRuns): string {
  return `${area.place.city ?? ""}\0${area.place.region ?? ""}\0${area.place.country}`;
}
