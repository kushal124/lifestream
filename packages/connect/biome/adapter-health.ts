import { instant, isObject, type Adapters, type HealthItem, type InputRecord, type Json, type JsonObject } from "@lifestreamprotocol/connect/sdk";

export const healthAdapters: Readonly<Record<string, Pick<Adapters, "health">>> = {
  "screen-time": {
    health: {
      version: "1",
      kinds: ["usage"],
      item({ version }: InputRecord): HealthItem | null {
        const content = object(version.content);
        const data = content?.type === "usage.segment" ? object(object(object(content.content)?.payload)?.data) : null;
        if (data === null || object(data.segmentInterval)?.kind !== "hourly") return null;
        const wall = object(object(content!.content)?.captured)?.wall_rfc3339;
        const used = new Map<string, number>();
        for (const value of Array.isArray(data.categories) ? data.categories : []) {
          const category = object(value);
          const each = number(category?.totalActivityDuration);
          const name = text(object(category?.category)?.localizedDisplayName) ?? "unnamed";
          if (each !== null && each > 0) used.set(name, (used.get(name) ?? 0) + each);
        }
        return {
          item: "usage", captured_ms: typeof wall === "string" ? capturedAt(wall) : null, seconds: number(data.totalActivityDuration),
          categories: [...used].map(([name, seconds]) => ({ name, seconds })).sort((left, right) => right.seconds - left.seconds || compare(left.name, right.name)),
        };
      },
    },
  },
};

function capturedAt(wall: string): number | null {
  try {
    return instant(wall, "rfc3339").start_ms;
  } catch {
    return null;
  }
}

function object(value: Json | undefined): JsonObject | null {
  return isObject(value) ? value : null;
}

function text(value: Json | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function number(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
