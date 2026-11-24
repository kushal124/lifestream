import { createHash } from "node:crypto";
import { isObject, readJson, refuse, sourceName, utf8, type Guard, type Json, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";
import { exact, ownerConnector, readStatements, type OwnerReader, type Pictures, type StatementKind } from "../shared/statements.js";
import { handleOf, isFaceKey, notASlug, personRecordFaults, profileFault, SLUG } from "@lifestreamprotocol/core";

export const PEOPLE_FILE = "people.json";
export const PEOPLE_FORMAT = "org.lifestreamprotocol.people/1";

const HASH = /^sha256:[0-9a-f]{64}$/u;
const CONTACT = /^contact:[0-9a-f]{16}$/u;
const HANDLE_KINDS = ["phone", "email", "jid"];
const PICTURE_BYTES = 1024 * 1024;
const PICTURE_SIDE = 1024;
const FRAMES = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export const face: Guard = (content) => {
  if (!isObject(content)) return ["content must be an object"];
  const members = Object.keys(content).sort().join(",");
  if (members === "is") return typeof content.is === "string" && SLUG.test(content.is) ? [] : [notASlug("is")];
  if (members === "ignore") return content.ignore === true ? [] : ["ignore must be true"];
  if (members !== "is_not") return ["content must hold exactly one of is, is_not and ignore"];
  const slugs = content.is_not;
  if (!Array.isArray(slugs) || slugs.length === 0) return ["is_not must be a list of slugs"];
  if (!slugs.every((slug) => typeof slug === "string" && SLUG.test(slug))) return [notASlug("each of is_not")];
  return slugs.every((slug, index) => index === 0 || (slugs[index - 1] as string) < (slug as string)) ? [] : ["is_not must be sorted, without repeats"];
};

export const photo: Guard = (content) => {
  if (!exact(content, ["type", "image"], ["face"])) return ["content must hold exactly type and image, and face for a face picked"];
  const out: string[] = [];
  if (content.type !== "people.photo") out.push("type must be people.photo");
  if (typeof content.image !== "string" || !HASH.test(content.image)) out.push("image must be 'sha256:' and 64 lowercase hex");
  if (Object.hasOwn(content, "face") && !(typeof content.face === "string" && isFaceKey(content.face))) out.push("face must be a face key");
  return out;
};

const MOST_PROFILES = 12;
const WORK_CHARACTERS = 120;
const FIRST_YEAR = 1900;
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const FIELDS = ["birthday", "profiles", "work"];

export const details: Guard = (content) => {
  if (!exact(content, ["type", "work", "birthday", "profiles"], ["cleared"])) return ["content must hold exactly type, work, birthday and profiles, and cleared if any"];
  const out: string[] = [];
  if (Object.hasOwn(content, "cleared")) out.push(...clearedFaults(content));
  if (content.type !== "people.details") out.push("type must be people.details");
  const work = content.work;
  if (work !== null && !(typeof work === "string" && [...work.trim()].length >= 1 && [...work.trim()].length <= WORK_CHARACTERS)) {
    out.push(`work must be null or 1 to ${WORK_CHARACTERS} characters once trimmed`);
  }
  if (content.birthday !== null) {
    const fault = birthdayFault(content.birthday!);
    if (fault !== undefined) out.push(fault);
  }
  const profiles = content.profiles;
  if (!Array.isArray(profiles) || profiles.length > MOST_PROFILES) return [...out, `profiles must be a list of at most ${MOST_PROFILES}`];
  const seen = new Set<string>();
  for (const [index, profile] of profiles.entries()) {
    const fault = profileFault(profile);
    if (fault !== undefined) {
      out.push(`profiles[${index}]: ${fault}`);
      continue;
    }
    const { network, value } = profile as { network: string; value: string };
    if (seen.has(`${network}:${value}`)) out.push(`profiles[${index}] repeats ${network}:${value}`);
    seen.add(`${network}:${value}`);
  }
  return out;
};

function clearedFaults(content: { [member: string]: Json }): string[] {
  const cleared = content.cleared;
  if (!Array.isArray(cleared) || cleared.length === 0 || !cleared.every((field) => typeof field === "string" && FIELDS.includes(field))) {
    return [`cleared must be a list of one to three of ${FIELDS.join(", ")}`];
  }
  if (!cleared.every((field, index) => index === 0 || (cleared[index - 1] as string) < (field as string))) return ["cleared must be sorted, without repeats"];
  return cleared.flatMap((field) => {
    const value = content[field as string];
    return value === null || (Array.isArray(value) && value.length === 0) ? [] : [`cleared names ${field as string}, which holds a value`];
  });
}

function birthdayFault(birthday: Json): string | undefined {
  if (!exact(birthday, ["month", "day", "year"])) return "birthday must be null or exactly month, day and year";
  const { month, day, year } = birthday;
  if (!Number.isInteger(month) || (month as number) < 1 || (month as number) > 12) return "birthday's month must be 1 to 12";
  const thisYear = new Date().getUTCFullYear();
  if (year !== null && !(Number.isInteger(year) && (year as number) >= FIRST_YEAR && (year as number) <= thisYear)) return `birthday's year must be null or ${FIRST_YEAR} to ${thisYear}`;
  const leap = year === null || ((year as number) % 4 === 0 && ((year as number) % 100 !== 0 || (year as number) % 400 === 0));
  const days = month === 2 && !leap ? 28 : MONTH_DAYS[(month as number) - 1]!;
  return Number.isInteger(day) && (day as number) >= 1 && (day as number) <= days ? undefined : `birthday's day must be a day month ${month as number} holds`;
}

export const group: Guard = (content) => isObject(content) && Object.keys(content).join(",") === "quiet" && typeof content.quiet === "boolean" ? [] : ["content must hold exactly quiet, true or false"];

function chatKey(key: string): string | undefined {
  return /^(?:whatsapp|imessage):\S+$/u.test(key) ? undefined : `${JSON.stringify(key)} names no chat: whatsapp:<chat id> or imessage:<chat id>`;
}

function personKey(key: string): string | undefined {
  const colon = key.indexOf(":");
  const [kind, value] = [key.slice(0, colon), key.slice(colon + 1)];
  if (kind === "person") return SLUG.test(value) ? undefined : notASlug(`${JSON.stringify(key)}'s person`);
  if (CONTACT.test(key)) return undefined;
  const handle = HANDLE_KINDS.includes(kind) ? handleOf(value) : null;
  if (handle !== null && handle.kind === kind && handle.value === value) return undefined;
  return `${JSON.stringify(key)} names no person: person:<slug>, a handle id in core's spelling, or contact:<16 hex>`;
}

function picture(content: Json, pictures: Pictures): string | undefined {
  const { image, face: picked } = content as { image: string; face?: string };
  if (picked !== undefined) return pictures.held(image) ? undefined : `the face's picture ${image} is not one the home holds`;
  const carried = pictures.carried(image);
  if (carried === undefined) return `its picture ${image} is not carried by the bundle`;
  if (carried.size > PICTURE_BYTES) return `its picture is ${carried.size} bytes, over 1 MiB`;
  const bytes = carried.bytes();
  if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== image) return `its picture's bytes are not ${image}`;
  const frame = jpegFrame(bytes);
  if (frame === null) return "its picture is no JPEG";
  return frame.width === frame.height && frame.width >= 1 && frame.width <= PICTURE_SIDE ? undefined
    : `its picture is ${frame.width} by ${frame.height}, not a square of 1 to ${PICTURE_SIDE} pixels`;
}

function jpegFrame(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  for (let at = 2; at + 4 <= bytes.length;) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) at += 1;
    else if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) at += 2;
    else if (marker === 0xd9 || marker === 0xda) return null;
    else if (FRAMES.has(marker)) {
      if (at + 10 > bytes.length) return null;
      const length = bytes.readUInt16BE(at + 2);
      if (length < 8 + 3 * bytes[at + 9]! || at + 2 + length > bytes.length) return null;
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    else at += 2 + bytes.readUInt16BE(at + 2);
  }
  return null;
}

const STATEMENTS: Readonly<Record<string, StatementKind>> = {
  person: {
    guard: personRecordFaults,
    key: (key, content) => content === null ? "a person is never stated gone: merge it into another" : isObject(content) && content.slug === key ? undefined : "its slug must be its key",
  },
  face: { guard: face, key: (key) => !isFaceKey(key) ? `${JSON.stringify(key)} is not a face key` : undefined },
  photo: {
    guard: photo, key: personKey, picture,
    blobs: (content) => Object.hasOwn(content, "face") ? {} : { [content.image as string]: "image/jpeg" },
  },
  details: { guard: details, key: personKey },
  group: { guard: group, key: chatKey },
};

export const peopleHome: OwnerReader = {
  ...ownerConnector("people-home", STATEMENTS),
  async *read(delivery, files) {
    if (delivery.files.length === 1 && delivery.files[0]!.path === PEOPLE_FILE) {
      const unit = sourceName(delivery.source).copy;
      for (const [index, entry] of peopleFile(files.bytes(delivery.files[0]!.blob)).entries()) {
        const key = isObject(entry) && typeof entry.slug === "string" ? entry.slug : `#${index}`;
        yield { kind: "person", key, content: entry, device: unit, locator: `${PEOPLE_FILE}:${index}` } satisfies ReaderOutput;
      }
      return;
    }
    yield* readStatements(delivery, (file) => files.bytes(file.blob), STATEMENTS);
  },
};

export function peopleFile(bytes: Buffer): Json[] {
  const value = readJson(utf8(bytes, PEOPLE_FILE), PEOPLE_FILE);
  if (!isObject(value) || Object.keys(value).sort().join(",") !== "format,people" || value.format !== PEOPLE_FORMAT || !Array.isArray(value.people)) {
    refuse(`${PEOPLE_FILE} must hold exactly format ${PEOPLE_FORMAT} and a people list`);
  }
  return value.people;
}
