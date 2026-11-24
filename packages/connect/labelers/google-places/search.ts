import { keyRefused, RECEIVER, type Lookup } from "./labeler.js";

export interface TypedPlace {
  id: string;
  name: string;
  types: string[];
  distance_m: number | null;
}

export type TypedAnswer = { google: "answered"; places: TypedPlace[] } | { google: "no key" | "refused" | "unreachable" };

export const TYPED_MIN = 2;
export const TYPED_MAX = 100;
const TYPED_PLACES = 5;
const BIAS_M = 1_500;
const TYPED_MS = 4_000;

export async function typedSearch(settings: { key: string; endpoint: string; lookup(sent: Lookup): void }, point: { latitude: number; longitude: number }, q: string, signal?: AbortSignal): Promise<TypedAnswer> {
  const input = q.trim();
  if (input.length < TYPED_MIN) return { google: "answered", places: [] };
  if (input.length > TYPED_MAX) throw new RangeError(`a typed search is at most ${TYPED_MAX} characters`);
  const center = { latitude: point.latitude, longitude: point.longitude };
  settings.lookup({ receiver: RECEIVER, request: "autocomplete", points: 1, chars: input.length });
  let status: number;
  let text: string;
  try {
    const response = await fetch(`${settings.endpoint}/v1/places:autocomplete`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": settings.key },
      body: JSON.stringify({ input, locationBias: { circle: { center, radius: BIAS_M } }, origin: center }),
      signal: AbortSignal.any([...(signal === undefined ? [] : [signal]), AbortSignal.timeout(TYPED_MS)]),
    });
    status = response.status;
    text = await response.text();
  } catch {
    return { google: "unreachable" };
  }
  if (status < 200 || status >= 300) return keyRefused(status, text) ? { google: "refused" } : { google: "unreachable" };
  let answer: unknown;
  try {
    answer = JSON.parse(text);
  } catch {
    return { google: "unreachable" };
  }
  const suggestions = (answer as { suggestions?: unknown }).suggestions;
  const places: TypedPlace[] = [];
  for (const each of Array.isArray(suggestions) ? suggestions : []) {
    const prediction = (each as { placePrediction?: Prediction }).placePrediction;
    const name = prediction?.structuredFormat?.mainText?.text?.trim() || prediction?.text?.text?.trim();
    if (prediction === undefined || typeof prediction.placeId !== "string" || prediction.placeId === "" || typeof name !== "string" || name === "") continue;
    places.push({
      id: `google:${prediction.placeId}`, name, types: Array.isArray(prediction.types) ? prediction.types.filter((type): type is string => typeof type === "string") : [],
      distance_m: typeof prediction.distanceMeters === "number" ? prediction.distanceMeters : null,
    });
    if (places.length === TYPED_PLACES) break;
  }
  return { google: "answered", places };
}

interface Prediction {
  placeId?: unknown;
  text?: { text?: string };
  structuredFormat?: { mainText?: { text?: string } };
  types?: unknown[];
  distanceMeters?: unknown;
}
