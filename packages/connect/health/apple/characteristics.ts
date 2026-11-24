import { isObject, refuse, type Json, type JsonObject, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";

export const CHARACTERISTIC_PREFIX = "HKCharacteristicTypeIdentifier";

const named = (prefix: string, names: readonly string[], from = 0): Record<string, string> =>
  Object.fromEntries(names.map((name, index) => [String(index + from), `${prefix}${name}`]));

const VALUES: Record<string, Record<string, string>> = {
  [`${CHARACTERISTIC_PREFIX}BiologicalSex`]: named("HKBiologicalSex", ["NotSet", "Female", "Male", "Other"]),
  [`${CHARACTERISTIC_PREFIX}BloodType`]: named("HKBloodType", ["NotSet", "APositive", "ANegative", "BPositive", "BNegative", "ABPositive", "ABNegative", "OPositive", "ONegative"]),
  [`${CHARACTERISTIC_PREFIX}FitzpatrickSkinType`]: named("HKFitzpatrickSkinType", ["NotSet", "I", "II", "III", "IV", "V", "VI"]),
  [`${CHARACTERISTIC_PREFIX}WheelchairUse`]: named("HKWheelchairUse", ["NotSet", "No", "Yes"]),
  [`${CHARACTERISTIC_PREFIX}ActivityMoveMode`]: named("HKActivityMoveMode", ["ActiveEnergy", "AppleMoveTime"], 1),
};

const IDENTIFIER = /^HKCharacteristicTypeIdentifier[A-Za-z]+$/u;

export function characteristicRow(identifier: Json | undefined, stated: Json | undefined, where: string): ReaderOutput {
  if (typeof identifier !== "string" || !IDENTIFIER.test(identifier)) refuse(`${where}.identifier must be a HealthKit characteristic identifier`);
  if (stated !== null && typeof stated !== "string" && !(typeof stated === "number" && Number.isSafeInteger(stated))) {
    refuse(`${where}.value must be text, an integer or null`);
  }
  const spelled = typeof stated === "number" ? VALUES[identifier]?.[String(stated)] ?? String(stated) : stated;
  const value = spelled === null || spelled === "" || spelled.endsWith("NotSet") ? null : spelled;
  return { kind: "characteristic", key: identifier, content: { type: "health.characteristic", identifier, value } };
}

export function characteristicGuard(content: Json): string[] {
  if (!isObject(content) || Object.keys(content).sort().join() !== "identifier,type,value" || content.type !== "health.characteristic") {
    return ["content must be {type: health.characteristic, identifier, value}"];
  }
  const { identifier, value } = content as JsonObject;
  if (typeof identifier !== "string" || !IDENTIFIER.test(identifier)) return ["content.identifier must be a HealthKit characteristic identifier"];
  if (value !== null && (typeof value !== "string" || value.length === 0)) return ["content.value must be non-empty text or null"];
  return [];
}
