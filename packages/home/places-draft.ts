import { randomBytes } from "node:crypto";
import { places } from "@lifestreamprotocol/connect";
import { canonical, isObject, type Json, type JsonObject, type OpenView } from "@lifestreamprotocol/core";
import { bad, single, statedHead, verbOf, type Drafted, type Drafter, type DraftRead, type Statement } from "./owner-act.js";
import { refuse } from "./refusal.js";

const { ALSO_MAX, HIDDEN_RADIUS_M } = places;
const SLUG_CHARS = 48;
const VERBS = {
  create: ["name", "latitude", "longitude", "radius_m", "ids", "home"],
  edit: ["slug", "name", "latitude", "longitude", "radius_m", "also", "ids", "home", "was"],
  "add-circle": ["slug", "latitude", "longitude", "radius_m"],
  remove: ["slug"],
  hide: ["latitude", "longitude"],
  unhide: ["key"],
} as const;

interface Centre extends JsonObject {
  latitude: number;
  longitude: number;
}

interface Circle extends JsonObject {
  centre: Centre;
  radius_m: number;
}

interface PlaceContent extends JsonObject {
  type: "places.place";
  name: string;
  centre: Centre;
  radius_m: number;
  ids: string[];
}

interface Fields {
  name: string;
  centre: Centre;
  radius_m: number;
  also: Circle[];
  ids: string[];
  home: boolean | null;
}
type Field = keyof Fields;
const MEMBERS: Readonly<Record<Field, string>> = { name: "name", centre: "latitude and longitude", radius_m: "radius_m", also: "also", ids: "ids", home: "home" };

function unknown(): never {
  return refuse(404, "PLACE_UNKNOWN", "There is no such place.");
}

function full(): never {
  return refuse(409, "CIRCLES_FULL", `A place has at most ${ALSO_MAX + 1} circles.`);
}

export function mintedSlug(name: string): string {
  const slug = name.trim().normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-/u, "")
    .slice(0, SLUG_CHARS).replace(/-$/u, "");
  const hex = randomBytes(3).toString("hex");
  return slug === "" ? hex : `${slug}-${hex}`;
}

export const placesDrafter: Drafter = {
  draft({ view, source }: DraftRead, action: JsonObject): Drafted {
    const verb = verbOf(action, VERBS, "A place's action is create, edit, add-circle, remove, hide or unhide.");
    const drafted = (statement: Statement | null, id: string): Drafted => single(verb, statement, id);
    if (verb === "create") {
      const name = textOf(action.name, "A place is made with its name.");
      const slug = fresh(view, source, "place", () => mintedSlug(name));
      const content: PlaceContent = {
        type: "places.place", name, centre: centreOf(action), radius_m: numberOf(action.radius_m, "A place's circle has its radius."), ids: idsOf(action.ids),
        ...(action.home === undefined || action.home === null ? {} : { home: homeOf(action.home) }),
      };
      return drafted({ kind: "place", key: slug, content }, `place:${slug}`);
    }
    if (verb === "hide") {
      const key = fresh(view, source, "hidden", () => mintedSlug("hidden"));
      return drafted({ kind: "hidden", key, content: { type: "places.hidden", centre: centreOf(action), radius_m: HIDDEN_RADIUS_M } }, `hidden:${key}`);
    }
    if (verb === "unhide") {
      const key = keyOf(action.key);
      if (statedHead(view, source, "hidden", key) === undefined) unknown();
      return drafted({ kind: "hidden", key, gone: true }, `hidden:${key}`);
    }
    const slug = keyOf(action.slug);
    const head = (statedHead(view, source, "place", slug) as PlaceContent | undefined) ?? unknown();
    if (verb === "remove") return drafted({ kind: "place", key: slug, gone: true }, `place:${slug}`);
    const next: PlaceContent = { ...head };
    if (verb === "add-circle") {
      const also = [...circlesOf(head.also), { centre: centreOf(action), radius_m: numberOf(action.radius_m, "A circle has its radius.") }];
      if (also.length > ALSO_MAX) full();
      next.also = also;
    } else {
      const sent = fieldsOf(action);
      unchangedSince(head, sent, wasOf(action.was, sent));
      const { also, home, ...plain } = sent;
      if (also !== undefined && also.length > ALSO_MAX) full();
      Object.assign(next, plain);
      if (also?.length === 0) delete next.also;
      else if (also !== undefined) next.also = also;
      if (home === null) delete next.home;
      else if (home !== undefined) next.home = home;
    }
    return drafted(canonical(next) === canonical(head) ? null : { kind: "place", key: slug, content: next }, `place:${slug}`);
  },
};

function fresh(view: OpenView, source: string, kind: "place" | "hidden", mint: () => string): string {
  for (;;) {
    const key = mint();
    if (statedHead(view, source, kind, key) === undefined) return key;
  }
}

function fieldsOf(at: JsonObject): Partial<Fields> {
  const fields: Partial<Fields> = {};
  if (at.name !== undefined) fields.name = textOf(at.name, "A place's name is text.");
  if (at.latitude !== undefined || at.longitude !== undefined) fields.centre = centreOf(at);
  if (at.radius_m !== undefined) fields.radius_m = numberOf(at.radius_m, "A place's radius is a number of metres.");
  if (at.also !== undefined) fields.also = alsoOf(at.also);
  if (at.ids !== undefined) fields.ids = idsOf(at.ids);
  if (at.home !== undefined) fields.home = at.home === null ? null : homeOf(at.home);
  return fields;
}

function wasOf(value: Json | undefined, sent: Partial<Fields>): Partial<Fields> {
  if (value === undefined && Object.keys(sent).length === 0) return {};
  if (!isObject(value ?? null)) bad("An edit carries was: the value of each member it sends as it read them.");
  const was = fieldsOf(value as JsonObject);
  const missing = (Object.keys(sent) as Field[]).find((field) => !Object.hasOwn(was, field));
  if (missing !== undefined) bad(`An edit's was carries the ${MEMBERS[missing]} it changes.`);
  const stray = (Object.keys(was) as Field[]).find((field) => !Object.hasOwn(sent, field));
  if (stray !== undefined) bad(`An edit's was carries no ${MEMBERS[stray]} it does not send.`);
  return was;
}

function headFields(head: PlaceContent): Fields {
  return { name: head.name, centre: head.centre, radius_m: head.radius_m, also: circlesOf(head.also), ids: head.ids ?? [], home: typeof head.home === "boolean" ? head.home : null };
}

function unchangedSince(head: PlaceContent, sent: Partial<Fields>, was: Partial<Fields>): void {
  const now = headFields(head);
  const changed = (Object.keys(sent) as Field[]).some((field) =>
    canonical(now[field] as Json) !== canonical(was[field] as Json) && canonical(now[field] as Json) !== canonical(sent[field] as Json));
  if (!changed) return;
  refuse(409, "CHANGED", `${head.name} was changed elsewhere: read it again.`);
}

function alsoOf(value: Json): Circle[] {
  if (!Array.isArray(value)) bad("A place's other circles are a list.");
  return (value as Json[]).map((circle) => {
    if (!isObject(circle)) bad("A circle is its centre and radius.");
    return { centre: centreOf(circle as JsonObject), radius_m: numberOf((circle as JsonObject).radius_m, "A circle has its radius.") };
  });
}

function keyOf(value: Json | undefined): string {
  return typeof value === "string" && value !== "" ? value : bad("A place is named by its id.");
}

function textOf(value: Json | undefined, words: string): string {
  return typeof value === "string" ? value.trim() : bad(words);
}

function numberOf(value: Json | undefined, words: string): number {
  return typeof value === "number" ? value : bad(words);
}

function centreOf(at: JsonObject): Centre {
  return { latitude: numberOf(at.latitude, "A circle's centre is its latitude and longitude."), longitude: numberOf(at.longitude, "A circle's centre is its latitude and longitude.") };
}

function homeOf(value: Json): boolean {
  if (typeof value !== "boolean") bad("Whether a place is home is true or false.");
  return value;
}

function idsOf(value: Json | undefined): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((id) => typeof id === "string")) bad("A place's ids are a list of <provider>:<id>.");
  return [...new Set(value as string[])].sort();
}

function circlesOf(value: Json | undefined): Circle[] {
  return Array.isArray(value) ? value as Circle[] : [];
}
