import { isObject, type Guard, type Json } from "@lifestreamprotocol/connect/sdk";
import { exact, ownerConnector, type StatementKind } from "../shared/statements.js";

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const PROVIDER_ID = /^[a-z][a-z0-9-]*:\S+$/u;
const STAY_UNIT = /^stay\/[^/:\s]+:[^/:\s]+:[^/:\s]+\/\S+$/u;
const NAME_MAX = 200;
const RADIUS = { min: 20, max: 2_000 };
export const ALSO_MAX = 19;
export const HIDDEN_RADIUS_M = 80;

const place: Guard = (content) => {
  if (!exact(content, ["type", "name", "centre", "radius_m", "ids"], ["home", "also"]) || content.type !== "places.place") {
    return ["content must hold exactly type places.place, name, centre, radius_m and ids, and home and also when stated"];
  }
  const out = [...named(content.name), ...centred(content.centre), ...radiused(content.radius_m, "radius_m")];
  const also = content.also;
  if (also !== undefined) {
    if (!Array.isArray(also) || also.length < 1 || also.length > ALSO_MAX) out.push(`also must be a list of 1 to ${ALSO_MAX} circles`);
    else {
      also.forEach((circle, index) => {
        if (!exact(circle, ["centre", "radius_m"])) out.push(`also[${index}] must hold exactly centre and radius_m`);
        else out.push(...centred(circle.centre).map((words) => `also[${index}]: ${words}`), ...radiused(circle.radius_m, `also[${index}].radius_m`));
      });
    }
  }
  const ids = content.ids;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && PROVIDER_ID.test(id))) out.push("ids must be a list of <provider>:<id>");
  else if (!ids.every((id, index) => index === 0 || (ids[index - 1] as string) < (id as string))) out.push("ids must be sorted, without repeats");
  if (content.home !== undefined && typeof content.home !== "boolean") out.push("home must be true or false");
  return out;
};

const googleName: Guard = (content) => {
  if (!exact(content, ["type", "id", "name", "centre"]) || content.type !== "google.place") {
    return ["content must hold exactly type google.place, id, name and centre"];
  }
  const out = [...named(content.name), ...centred(content.centre)];
  if (typeof content.id !== "string" || !/^\S+$/u.test(content.id)) out.push("id must be Google's place ID");
  return out;
};

const hidden: Guard = (content) => {
  if (!exact(content, ["type", "centre", "radius_m"]) || content.type !== "places.hidden") return ["content must hold exactly type places.hidden, centre and radius_m"];
  return [...centred(content.centre), ...(content.radius_m === HIDDEN_RADIUS_M ? [] : [`radius_m must be ${HIDDEN_RADIUS_M}`])];
};

const visit: Guard = (content) => {
  if (!exact(content, ["type", "place"]) || content.type !== "places.visit") return ["content must hold exactly type places.visit and place"];
  return content.place === null || (typeof content.place === "string" && ID.test(content.place)) ? [] : ["place must be a place's id, or null"];
};

const minted = (key: string) => ID.test(key) ? undefined : `${JSON.stringify(key)} is not a place's id: lower-case letters, digits and dashes, at most 64`;

const PLACES: Readonly<Record<string, StatementKind>> = {
  place: { guard: place, key: minted },
  hidden: { guard: hidden, key: minted },
  visit: { guard: visit, key: (key) => STAY_UNIT.test(key) ? undefined : `${JSON.stringify(key)} is not a stay's extract unit: stay/<source>/<key>` },
};

const GOOGLE: Readonly<Record<string, StatementKind>> = {
  place: {
    guard: googleName,
    key: (key, content) => content === null
      ? (/^google:\S+$/u.test(key) ? undefined : `${JSON.stringify(key)} is not google:<place ID>`)
      : isObject(content) && key === `google:${String(content.id)}` ? undefined : "its key must be google:<its id>",
  },
};

export const placesHome = ownerConnector("places-home", PLACES);

export const googlePlaceNames = ownerConnector("google-place-names", GOOGLE);

function named(name: Json | undefined): string[] {
  return typeof name === "string" && name.length > 0 && name.length <= NAME_MAX && name === name.trim() ? [] : [`name must be trimmed, 1 to ${NAME_MAX} characters`];
}

function radiused(radius: Json | undefined, name: string): string[] {
  return typeof radius === "number" && Number.isFinite(radius) && radius >= RADIUS.min && radius <= RADIUS.max ? [] : [`${name} must be ${RADIUS.min} to ${RADIUS.max}`];
}

function centred(centre: Json | undefined): string[] {
  const within = (value: Json | undefined, limit: number) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
  return exact(centre, ["latitude", "longitude"]) && within(centre.latitude, 90) && within(centre.longitude, 180) ? [] : ["centre must be a latitude and longitude in range"];
}
