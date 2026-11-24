import { addDays, civilDay, instant } from "@lifestreamprotocol/core";
import { distanceMeters, distanceToPlace, type GoogleName, type Place, type Point, type Span } from "./places.js";

export interface GooglePlace {
  id?: string;
  displayName?: { text?: string };
  location?: { latitude?: number; longitude?: number };
  types?: string[];
  primaryType?: string;
}

export interface Answers {
  nearby: readonly GooglePlace[];
  venues: readonly GooglePlace[];
  big: Readonly<Partial<Record<Hint, readonly GooglePlace[]>>>;
}

export type Hint = "airport" | "beach";

export interface Said {
  at_ms: number;
  product: string;
  family: string | null;
  kind: string;
  text: string;
  url?: string;
}

export interface Words {
  plain(word: string): boolean;
  person(word: string): boolean;
  area(word: string): boolean;
  share(word: string): number;
}

type From = "google" | "venue" | "big" | "part" | "own" | "name" | "maps" | "typed";

export interface Typed {
  id: string;
  name: string;
  types: string[];
  distance_m: number | null;
}

export interface Asked {
  photos?: boolean;
  q?: string;
  typed?: readonly Typed[];
}

export interface Candidate {
  name: string;
  distance_m: number;
  from: From;
  id?: string;
  slug?: string;
  types: string[];
  core: string[];
  money: boolean;
  sleep: boolean;
  typed?: true;
}

export interface Suggestion {
  name: string;
  id?: string;
  slug?: string;
  distance_m: number | null;
  why?: { product: string; family: string | null; at_ms: number; tier: 1 | 2 | 3 };
}

export const SUGGESTIONS_MAX = 16;
export const SUGGESTIONS_LIMIT = 500;
export const NEAR_M = 150;
export const OWN_NEAR_M = 150;
export const OWN_NEAR_PHOTO_M = 300;
export const BIG_NEAR_M = 300;
export const BEFORE_MS = 12 * 3_600_000;

const MINUTE = 60_000;
const HOUR = 3_600_000;
const WAY_BEFORE_MS = 3 * HOUR;
const ARRIVED_MS = 10 * MINUTE;
const NIGHT_MS = 4 * HOUR;
const NIGHT_HOUR = 3;
const MEAL_STAY_MS = 40 * MINUTE;
const MEAL_COVER_MS = 30 * MINUTE;
const MEALS: readonly [number, number][] = [[12, 15], [19, 23]];
export const NAME_SHARE = 0.0025;
const WORD_SHARE = 0.0005;

const FILLER = new Set(["the", "and", "of", "a", "an", "at", "by", "in", "on", "for", "to", "n", "de", "la", "le", "les", "du", "des", "da", "del", "di"]);
const STRIP = new Set([...FILLER, "maa", "shri", "sri", "shree", "st"]);
const GENERIC = new Set([
  "restaurant", "cafe", "coffee", "bar", "pub", "kitchen", "bistro", "grill", "diner", "eatery", "canteen", "dhaba", "bakery", "bakers", "sweets", "food", "foods",
  "pizza", "pizzeria", "burger", "lounge", "brewery", "club", "hotel", "resort", "inn", "lodge", "hostel", "guest", "stay", "suites", "rooms",
  "store", "shop", "mart", "market", "supermarket", "hypermarket", "mall", "centre", "center", "plaza", "complex", "arcade", "tower", "building",
  "house", "home", "hospital", "clinic", "medical", "pharmacy", "chemist", "dental", "health", "care", "school", "college", "university", "institute",
  "academy", "station", "railway", "metro", "bus", "stop", "depot", "airport", "terminal", "park", "garden", "gardens", "beach", "temple", "church",
  "mosque", "gym", "fitness", "studio", "salon", "spa", "parlour", "bank", "atm", "office", "services", "service", "solutions", "private", "limited",
  "ltd", "co", "company", "enterprises", "enterprise", "traders", "agency", "group", "international", "global", "india", "city", "new", "old",
  "apartments", "apartment", "residency", "residence", "society", "road", "street", "lane", "nagar", "sector", "block", "phase", "east", "west",
  "north", "south", "point", "corner", "hub", "zone", "world", "express", "cuisine", "family", "multi",
]);
const EXTRA = new Set(["main", "official", "outlet", "branch", "unit", "pvt", "llp", "inc"]);
const MONEY = new Set(["bank", "atm", "finance", "insurance_agency", "accounting"]);
const SLEEP = new Set(["lodging", "hotel", "motel", "resort_hotel", "guest_house", "hostel", "bed_and_breakfast", "inn", "extended_stay_hotel", "cottage",
  "private_guest_room", "farmstay", "budget_japanese_inn", "japanese_inn"]);
const BIG = new Set(["shopping_mall", "hospital", "university", "stadium", "airport", "sports_complex", "amusement_park", "zoo", "park", "beach",
  "convention_center", "golf_course", "train_station", "subway_station"]);
const ADDRESS = /\b(flat|shop|plot|building|bldg|room) ?no\b|^(flat|building|plot) [a-z0-9]{1,3}\b|^\d/iu;
const HINTS: Readonly<Record<Hint, RegExp>> = {
  airport: /airport|terminal|departure|arrivals/iu,
  beach: /\bbeach\b|kitesurf|\bsurf\b|\bshack\b/iu,
};
const PARTS = /\s*(?:\||,|\s-\s|\s–\s|@|\(|\)|\bat\b)\s*/iu;
const OWN_PART = /\s*(?:\||,|\s-\s|\s–\s|@|\()\s*/u;

const FOOD = new Set(["cafe", "coffee_shop", "bar", "pub", "bakery", "ice_cream_shop", "food_court", "tea_house", "dessert_shop", "juice_shop", "wine_bar",
  "cafeteria", "bistro", "diner", "snack_bar", "bar_and_grill", "cocktail_bar", "brewery", "sandwich_shop", "meal_takeaway", "confectionery",
  "chocolate_shop", "cat_cafe", "dog_cafe", "night_club", "lounge_bar"]);
const NOWHERE = new Set(["apartment_building", "apartment_complex", "condominium_complex", "housing_complex", "corporate_office", "service", "consultant",
  "manufacturer", "association_or_organization", "bus_stop", "transit_station", "parking", "parking_lot", "electric_vehicle_charging_station", "atm",
  "real_estate_agency", "insurance_agency", "accounting", "lawyer", "storage", "moving_company", "wholesaler", "general_contractor", "electrician",
  "plumber", "painter", "roofing_contractor", "courier_service", "taxi_service", "transportation_service", "travel_agency",
  "telecommunications_service_provider", "establishment", "point_of_interest", "premise", "subpremise", "street_address", "route", "locality",
  "public_bathroom", "car_repair", "car_wash", "gas_station", "finance", "bank", "local_government_office", "employment_agency", "website_designer",
  "internet_cafe", "warehouse_store"]);
const HOMES = new Set(["bank", "atm", "finance", "apartment_building", "apartment_complex", "condominium_complex", "housing_complex"]);
const SHOPS = new Set(["store", "market", "supermarket", "grocery_store", "pharmacy", "drugstore"]);

const PAYEES = [/\bto ([a-z0-9 .&'-]{3,40}?) on \d/giu, /towards vpa ([a-z0-9._-]+)/giu, /\bat ([a-z0-9 .&'-]{3,40}?) on \d/giu, /paid to ([a-z0-9 .&'-]{3,40}?)(?: on |\.|$)/giu];
const MAPS_NAMES: readonly [RegExp, Field["tier"]][] = [[/Searched for ([^,/\n]+)/gu, 3], [/Directions to ([^,/\n]+)/gu, "directions"], [/Current location \/ ([^,/\n]+)/gu, "directions"]];
const MAPS_PIN = /\/maps\/place\/([^/@]+)\/@(-?\d+\.\d+),(-?\d+\.\d+)/gu;
const MAPS_QUERY = /[?&]q=([^&\s]+)/gu;
const MAPS_NOT = /location history|maps\/timeline|viewed area around/iu;
const NOT_PLACE = new Set(["current location", "maps", "search services history", "at this general area", "from your device"]);
const ACTS = new Set(["used", "viewed", "dismissed", "received", "explored", "said", "shared", "read", "opened", "saw", "translated", "defined", "launched",
  "displayed", "created", "called", "started", "joined", "trained", "initiated", "played", "downloaded", "interacted", "set", "selected", "voted",
  "disliked", "pre", "rented", "saved", "made", "tracked", "confirmed", "bookmarked", "clicked", "sent", "asked", "submitted", "activated", "searched",
  "visited", "watched", "directions"]);
const PERSONAL = new Set(["messages", "notes", "voice", "calls", "calendar"]);


function clean(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function wordsOf(text: string): string[] {
  const cleaned = clean(text);
  return cleaned === "" ? [] : cleaned.split(" ");
}

function own(name: string): string {
  return name.split(OWN_PART).find((part) => part.trim() !== "") ?? "";
}

function generic(word: string): boolean {
  return GENERIC.has(word) || EXTRA.has(word) || (word.endsWith("s") && GENERIC.has(word.slice(0, -1)));
}

function plain(word: string, words: Words): boolean {
  return words.plain(word) || (word.endsWith("s") && words.plain(word.slice(0, -1)));
}

function allWords(name: string): string[] {
  return wordsOf(own(name)).filter((word) => !STRIP.has(word) && !/^\d+$/u.test(word));
}

function coreOf(name: string, words: Words): string[] {
  return allWords(name).filter((word) => !generic(word) && !words.area(word));
}

function keyOf(name: string, words: Words): string {
  const core = coreOf(name, words);
  if (core.length > 0) return core.join("");
  const all = allWords(name);
  return all.length >= 2 ? all.join("") : "";
}

export function samePlace(given: string, name: string, words: Words): boolean {
  if (/\bairport\b/iu.test(given) && /\bairport\b/iu.test(name)) return true;
  const [x, y] = [keyOf(given, words), keyOf(name, words)];
  if (x === "" || y === "") return false;
  if (x === y && x.length >= 3) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length >= 5 && long.startsWith(short)) return true;
  const [a, b] = [allWords(given).join(""), allWords(name).join("")];
  const [less, more] = a.length <= b.length ? [a, b] : [b, a];
  return less.length >= 8 && more.startsWith(less);
}

export function bigHints(names: readonly string[]): Hint[] {
  return (Object.keys(HINTS) as Hint[]).filter((hint) => names.some((name) => HINTS[hint].test(name)));
}


export function candidatesOf(point: Point, answers: Answers, places: readonly Place[], google: readonly GoogleName[], said: readonly Said[], words: Words, asked: Asked = {}): Candidate[] {
  const found: { name: string; distance_m: number; from: From; types: string[]; id?: string }[] = [];
  const at = (place: GooglePlace) => place.location?.latitude === undefined || place.location.longitude === undefined ? null
    : distanceMeters(point, { latitude: place.location.latitude, longitude: place.location.longitude });
  const typesOf = (place: GooglePlace) => (place.types !== undefined && place.types.length > 0 ? place.types : place.primaryType === undefined ? [] : [place.primaryType]).filter((type) => type !== "");
  const google_ = (place: GooglePlace, from: From, reach: (types: string[]) => number) => {
    const name = place.displayName?.text, distance = at(place);
    if (name === undefined || distance === null) return;
    const types = typesOf(place);
    if (distance <= reach(types)) found.push({ name, distance_m: distance, from, types, ...(place.id === undefined ? {} : { id: `google:${place.id}` }) });
  };
  for (const place of answers.nearby) google_(place, "google", () => NEAR_M);
  for (const place of answers.venues) google_(place, "venue", (types) => (types.some((type) => BIG.has(type)) ? BIG_NEAR_M : NEAR_M));
  for (const name of google) {
    const distance = distanceMeters(point, name);
    if (distance <= NEAR_M) found.push({ name: name.name, distance_m: distance, from: "name", types: [], id: name.id });
  }
  for (const record of said) {
    for (const pin of mapsFields(record).pins) {
      const distance = distanceMeters(point, pin);
      if (distance <= NEAR_M) found.push({ name: pin.name, distance_m: distance, from: "maps", types: [] });
    }
  }
  const hints = bigHints([...found.map((each) => each.name), ...places.filter((place) => distanceToPlace(point, place) <= OWN_NEAR_M).map((place) => place.name)]);
  for (const hint of hints) for (const place of answers.big[hint] ?? []) google_(place, "big", () => Infinity);
  for (const typed of asked.typed ?? []) found.push({ name: typed.name, distance_m: typed.distance_m ?? Infinity, from: "typed", types: typed.types, id: typed.id });

  const typing = wordsOf(asked.q ?? "").length > 0;
  const reach = asked.photos === true ? OWN_NEAR_PHOTO_M : OWN_NEAR_M;
  const ownOf = (place: Place): Candidate => ({ ...candidate(place.name, distanceToPlace(point, place), "own", [], undefined, words), slug: place.slug });
  const own = new Map(places.flatMap((place) => {
    const distance = distanceToPlace(point, place);
    return distance <= reach || (typing && holdsWords(place.name, asked.q!)) ? [[place.slug, ownOf(place)] as const] : [];
  }));
  const ownById = new Map(places.flatMap((place) => place.ids.map((id) => [id, place] as const)));
  const ownLetters = new Map([...own.values()].filter((each) => each.distance_m <= reach).map((each) => [clean(each.name), each] as const));

  const byId = new Map<string, Candidate>();
  const byName = new Map<string, Candidate>();
  const named: Candidate[] = [];
  for (const each of [...found].sort((left, right) => left.distance_m - right.distance_m || compare(left.name, right.name))) {
    const name = each.name.trim();
    const letters = clean(name);
    if (letters === "" || ADDRESS.test(name)) continue;
    const carrier = each.id === undefined ? undefined : ownById.get(each.id);
    const mine = carrier !== undefined ? own.get(carrier.slug) ?? own.set(carrier.slug, ownOf(carrier)).get(carrier.slug)! : ownLetters.get(letters);
    const held = mine ?? (each.id !== undefined ? byId.get(each.id) ?? unnamed(byName.get(letters)) : byName.get(letters));
    if (held !== undefined) {
      if (held.from !== "own" && (each.from === "venue" || each.from === "big")) {
        Object.assign(held, candidate(name, held.distance_m, each.from, [...new Set([...held.types, ...each.types])], held.id ?? each.id, words), { name: held.name });
      } else if (held.from !== "own" && held.id === undefined && each.id !== undefined) held.id = each.id;
      if (each.from === "typed") held.typed = true;
      if (held.from !== "own" && held.id !== undefined) byId.set(held.id, held);
      continue;
    }
    const made = candidate(name, each.distance_m, each.from, each.types, each.id, words);
    if (each.from === "typed") made.typed = true;
    if (made.id !== undefined) byId.set(made.id, made);
    if (!byName.has(letters)) byName.set(letters, made);
    named.push(made);
  }
  const listed = [...own.values(), ...named];
  const all = [...listed, ...partsOf(listed, words)];
  const kept = !typing ? all : all.filter((each) => each.typed === true || holdsWords(each.name, asked.q!));
  return kept.sort((left, right) => left.distance_m - right.distance_m || compare(left.name, right.name));
}

function unnamed(held: Candidate | undefined): Candidate | undefined {
  return held !== undefined && held.id === undefined && held.from !== "own" ? held : undefined;
}

export function holdsWords(name: string, typed: string): boolean {
  const own = wordsOf(name);
  return wordsOf(typed).every((word) => own.some((each) => each.startsWith(word)));
}

function candidate(name: string, distance_m: number, from: From, types: string[], id: string | undefined, words: Words): Candidate {
  return {
    name, distance_m, from, types, ...(id === undefined ? {} : { id }), core: coreOf(name, words),
    money: types.some((type) => MONEY.has(type)), sleep: types.some((type) => SLEEP.has(type)),
  };
}

function partsOf(candidates: readonly Candidate[], words: Words): Candidate[] {
  const seen = new Map<string, { tail: string; of: Candidate }[]>();
  for (const each of candidates) {
    const tails = each.name.split(PARTS).map((part) => part.trim()).filter((part) => part !== "").slice(1);
    for (const tail of new Set(tails)) {
      const key = keyOf(tail, words);
      if (key.length < 4) continue;
      seen.set(key, [...seen.get(key) ?? [], { tail, of: each }]);
    }
  }
  const names = new Set(candidates.map((each) => keyOf(each.name, words)));
  const out: Candidate[] = [];
  for (const [key, hits] of seen) {
    if (new Set(hits.map((hit) => hit.of)).size < 2 || names.has(key)) continue;
    const counted = new Map<string, number>();
    for (const { tail } of hits) counted.set(tail, (counted.get(tail) ?? 0) + 1);
    const tail = [...counted].sort(([left, many], [right, more]) => more - many || compare(left, right))[0]![0];
    out.push({ ...candidate(tail, Math.min(...hits.map((hit) => hit.of.distance_m)), "part", ["part_of"], undefined, words) });
  }
  return out;
}

export function phrasesOf(candidates: readonly Candidate[], words: Words): string[] {
  const out = new Set<string>();
  for (const each of candidates) {
    const core = each.core;
    if (core.length === 0) {
      const all = allWords(each.name);
      if (all.length >= 2) out.add(all.join(" "));
      continue;
    }
    out.add(core.join(" "));
    if (core.length < 2) continue;
    out.add(core.join(""));
    for (const word of core) if (rareWord(word, words)) out.add(word);
  }
  return [...out].sort(compare);
}

function rareWord(word: string, words: Words): boolean {
  return word.length >= 5 && !plain(word, words) && !words.person(word) && words.share(word) < WORD_SHARE;
}


interface Field {
  tier: 1 | 2 | 3 | "directions";
  name: string;
}

interface Read {
  said: Said;
  fields: Field[];
  free: string | null;
  words: Set<string>;
  personal: boolean;
}

function mapsFields(said: Said): { fields: Field[]; pins: (Point & { name: string })[] } {
  const fields: Field[] = [];
  const pins: (Point & { name: string })[] = [];
  if (said.product !== "google-maps" || MAPS_NOT.test(`${said.text} ${said.url ?? ""}`)) return { fields, pins };
  for (const [pattern, tier] of MAPS_NAMES) for (const match of said.text.matchAll(pattern)) fields.push({ tier, name: match[1]! });
  const url = said.url ?? "";
  for (const match of url.matchAll(MAPS_QUERY)) fields.push({ tier: 2, name: decode(match[1]!).split(",")[0]! });
  const searched = /Searched for/u.test(said.text);
  for (const match of url.matchAll(MAPS_PIN)) {
    const name = decode(match[1]!);
    fields.push({ tier: searched ? 3 : 2, name });
    pins.push({ name, latitude: Number(match[2]), longitude: Number(match[3]) });
  }
  const first = wordsOf(said.text)[0];
  if (said.kind === "activity" && first !== undefined && !ACTS.has(first)) fields.push({ tier: 2, name: said.text.split("\n")[0]! });
  return { fields: fields.map((field) => ({ ...field, name: field.name.trim() })).filter((field) => field.name !== "" && !NOT_PLACE.has(clean(field.name))), pins };
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/gu, " "));
  } catch {
    return text;
  }
}

function readSaid(said: Said, words: Words): Read {
  const maps = said.product === "google-maps";
  const calendar = said.family === "calendar";
  const fields: Field[] = maps ? mapsFields(said).fields : calendar ? [{ tier: 3, name: said.text }] : [];
  const payees = PAYEES.flatMap((pattern) => [...said.text.matchAll(pattern)].map((match) => match[1]!.split("@")[0]!.trim())).filter((name) => name !== "");
  const pay = payees.length > 0;
  fields.push(...payees.map((name): Field => ({ tier: 3, name })));
  const all = wordsOf(said.text).filter((word) => !STRIP.has(word));
  return {
    said, fields: fields.filter((field) => field.name !== "" && !NOT_PLACE.has(clean(field.name))),
    free: pay ? null : ` ${all.filter((word) => !GENERIC.has(word) && !words.area(word)).join(" ")} `,
    words: pay ? new Set() : new Set(all),
    personal: PERSONAL.has(said.family ?? "") || said.kind === "search",
  };
}

function fieldMatch(name: string, field: string, words: Words): number | null {
  const [mine, theirs] = [keyOf(name, words), keyOf(field, words)];
  if (mine.length < 3 || theirs.length < 3) return null;
  if (mine === theirs) return 0;
  const [short, long] = mine.length <= theirs.length ? [mine, theirs] : [theirs, mine];
  if (short.length >= 5 && long.startsWith(short)) return 0;
  const at = mine.length >= 6 ? wordsOf(field).join("").indexOf(mine) : -1;
  return at >= 0 ? at + 1 : null;
}

function freeMatch(each: Candidate, read: Read, words: Words): 0 | 1 | 2 {
  if (read.free === null || each.money) return 0;
  const core = each.core;
  if (core.length >= 2 && core.some((word) => words.share(word) < NAME_SHARE) && (read.free.includes(` ${core.join(" ")} `) || read.words.has(core.join("")))) return 2;
  if (core.length === 1) {
    const word = core[0]!;
    if (word.length >= 4 && !plain(word, words) && !words.person(word) && read.words.has(word)) return read.personal ? 2 : 1;
    return 0;
  }
  if (!read.personal) return 0;
  return core.some((word) => rareWord(word, words) && read.words.has(word)) ? 1 : 0;
}

function evidence(each: Candidate, read: Read, late: boolean, words: Words): [tier: number, at: number] | null {
  let best: [number, number] | null = null;
  const take = (hit: [number, number]) => {
    if (best === null || hit[0] > best[0] || (hit[0] === best[0] && hit[1] > best[1])) best = hit;
  };
  for (const field of read.fields) {
    const at = fieldMatch(each.name, field.name, words);
    if (at !== null) take([field.tier === "directions" ? (late ? 1 : 3) : field.tier, -at]);
  }
  const free = freeMatch(each, read, words);
  if (free > 0) take([free, -99]);
  return best;
}


function nightAfter(ms: number, zone: string): number {
  const midnight = { zone, day_start_hour: 0 };
  const day = civilDay(ms, midnight);
  const three = instant(`${day}T0${NIGHT_HOUR}:00:00`, "local", { zone }).start_ms;
  return three >= ms ? three : instant(`${addDays(day, 1)}T0${NIGHT_HOUR}:00:00`, "local", { zone }).start_ms;
}

function night(span: Span, zone: string): boolean {
  return span.end_ms - span.start_ms >= NIGHT_MS && nightAfter(span.start_ms, zone) <= span.end_ms;
}

function meal(span: Span, zone: string): boolean {
  if (span.end_ms - span.start_ms < MEAL_STAY_MS) return false;
  const day = civilDay(span.start_ms, { zone, day_start_hour: 0 });
  const at = (hour: number) => instant(`${day}T${String(hour).padStart(2, "0")}:00:00`, "local", { zone }).start_ms;
  return MEALS.some(([from, to]) => Math.min(span.end_ms, at(to)) - Math.max(span.start_ms, at(from)) >= MEAL_COVER_MS);
}

function food(types: readonly string[]): boolean {
  return types.some((type) => type === "restaurant" || type.endsWith("_restaurant") || FOOD.has(type));
}

function fit(each: Candidate, meals: boolean): number {
  if (each.from === "own") return -3;
  if (each.from === "big") return -2;
  if (each.from === "part") return 0;
  const types = each.types;
  if (types.length === 0) return 2;
  if (meals && food(types)) return -1;
  const first = types[0]!;
  if (HOMES.has(first) || each.sleep) return 1;
  if (NOWHERE.has(first)) return 2;
  if (first.endsWith("_store") || SHOPS.has(first)) return 1;
  return 0;
}

export function suggest(spans: readonly Span[], candidates: readonly Candidate[], said: readonly Said[], words: Words, zone: string, limit = SUGGESTIONS_MAX): Suggestion[] {
  const gapOf = (t: number, span: Span) => Math.min(Math.abs(t - span.start_ms), Math.abs(t - span.end_ms));
  const reads: Read[][] = spans.map(() => []);
  for (const record of said) {
    let nearest = -1;
    spans.forEach((span, index) => {
      if (record.at_ms < span.start_ms - BEFORE_MS || record.at_ms > span.end_ms) return;
      if (nearest < 0 || gapOf(record.at_ms, span) < gapOf(record.at_ms, spans[nearest]!)) nearest = index;
    });
    if (nearest >= 0) reads[nearest]!.push(readSaid(record, words));
  }
  const nights = spans.map((span) => night(span, zone));
  const meals = spans.some((span) => meal(span, zone));
  type Hit = { tier: number; when: number; at: number; gap: number; read: Read };
  type Score = { best: Hit | null; boost: number; moved: boolean };
  const better = (left: Score, right: Score) => right.boost - left.boost || (left.best?.when ?? 0) - (right.best?.when ?? 0) || (right.best?.at ?? 0) - (left.best?.at ?? 0) ||
    (left.best?.gap ?? 0) - (right.best?.gap ?? 0);
  const scored = candidates.map((each) => {
    let score: Score = { best: null, boost: 0, moved: false };
    spans.forEach((span, index) => {
      let best: Hit | null = null;
      for (const read of reads[index]!) {
        const t = read.said.at_ms;
        const found = evidence(each, read, t > span.start_ms + ARRIVED_MS, words);
        if (found === null) continue;
        const when = t >= span.start_ms - WAY_BEFORE_MS && t <= span.start_ms + ARRIVED_MS ? 0 : t > span.start_ms && t <= span.end_ms ? 1 : t < span.start_ms ? 2 : 3;
        const hit = { tier: found[0], when, at: found[1], gap: gapOf(t, span), read };
        if (best === null || hit.tier > best.tier || (hit.tier === best.tier && (hit.when < best.when || (hit.when === best.when && (hit.at > best.at || (hit.at === best.at && hit.gap < best.gap)))))) best = hit;
      }
      const sleep = nights[index]! && each.sleep;
      const here: Score = { best, boost: (sleep ? 10 : 0) + (best?.tier ?? 0), moved: best !== null || sleep };
      if (here.moved && (!score.moved || better(here, score) < 0)) score = here;
    });
    return { each, ...score };
  });
  const byEvidence = (left: (typeof scored)[number], right: (typeof scored)[number]) =>
    better(left, right) || fit(left.each, meals) - fit(right.each, meals) || left.each.distance_m - right.each.distance_m || compare(left.each.name, right.each.name);
  const moved = scored.filter((one) => one.moved).sort(byEvidence);
  const rest = scored.filter((one) => !one.moved)
    .sort((left, right) => fit(left.each, meals) - fit(right.each, meals) || left.each.distance_m - right.each.distance_m || compare(left.each.name, right.each.name));
  return [...moved, ...rest].slice(0, limit).map(({ each, best }): Suggestion => ({
    name: each.name, ...(each.id === undefined ? {} : { id: each.id }), ...(each.slug === undefined ? {} : { slug: each.slug }),
    distance_m: Number.isFinite(each.distance_m) ? Math.round(each.distance_m) : null,
    ...(best === null ? {} : { why: { product: best.read.said.product, family: best.read.said.family, at_ms: best.read.said.at_ms, tier: best.tier as 1 | 2 | 3 } }),
  }));
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
