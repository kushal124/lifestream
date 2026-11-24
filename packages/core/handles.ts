
export type HandleKind = "phone" | "email" | "jid" | "network";

export interface Handle {
  kind: HandleKind;
  value: string;
}

const DIRECTIONAL_MARKS = /[‪-‮⁦-⁩]/gu;
const PHONE_SPELLING = /^\+?[\d\s().-]+$/u;
const JID = /^(\d+)@(s\.whatsapp\.net|lid)$/iu;
const INTERNATIONAL = "00";

const ONE_DIGIT = new Set(["1", "7"]);
const TWO_DIGITS = new Set([
  "20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49",
  "51", "52", "53", "54", "55", "56", "57", "58", "60", "61", "62", "63", "64", "65", "66", "81", "82", "84", "86",
  "90", "91", "92", "93", "94", "95", "98",
]);

export function canonicalPhone(value: string, country?: string | null): string | null {
  const spelling = value.replace(DIRECTIONAL_MARKS, "").trim();
  if (!PHONE_SPELLING.test(spelling)) return null;
  const digits = spelling.replace(/\D/gu, "");
  if (spelling.startsWith("+")) return e164(digits);
  if (digits.startsWith(INTERNATIONAL)) return e164(digits.slice(INTERNATIONAL.length));
  if (country === undefined) return /^\d+$/u.test(spelling) ? e164(digits) : null;
  if (country === null) return null;
  const national = country === "1" || !digits.startsWith("0") ? digits : digits.slice(1);
  return national.length >= 7 && national.length <= 15 ? e164(`${country}${national}`) : null;
}

function e164(digits: string): string | null {
  return digits.length >= 7 && digits.length <= 15 && !digits.startsWith("0") ? `+${digits}` : null;
}

export function callingCode(phone: string): string | null {
  const canonical = canonicalPhone(phone);
  if (canonical === null) return null;
  const digits = canonical.slice(1);
  if (ONE_DIGIT.has(digits[0]!)) return digits[0]!;
  return TWO_DIGITS.has(digits.slice(0, 2)) ? digits.slice(0, 2) : digits.slice(0, 3);
}

export function canonicalEmail(value: string): string | null {
  if (/[\ud800-\udfff]/u.test(value)) return null;
  const address = value.trim().replace(/^mailto:/iu, "").normalize("NFC").toLowerCase();
  return /^[^@\s<>]+@[^@\s<>]+$/u.test(address) ? address : null;
}

export function canonicalJid(value: string): string | null {
  const match = JID.exec(value.trim());
  if (match === null) return null;
  if (match[2]!.toLowerCase() === "lid") return match[1]!.startsWith("0") ? null : `${match[1]}@lid`;
  const phone = e164(match[1]!);
  return phone === null ? null : `${phone.slice(1)}@s.whatsapp.net`;
}

export function phoneOfJid(value: string): string | null {
  const jid = canonicalJid(value);
  return jid?.endsWith("@s.whatsapp.net") ? `+${jid.slice(0, jid.indexOf("@"))}` : null;
}

export function handleOf(id: string, network?: string): Handle | null {
  const jid = canonicalJid(id);
  if (jid !== null) {
    const phone = phoneOfJid(jid);
    return phone === null ? { kind: "jid", value: jid } : { kind: "phone", value: phone };
  }
  const phone = canonicalPhone(id);
  if (phone !== null) return { kind: "phone", value: phone };
  const email = canonicalEmail(id);
  if (email !== null) return { kind: "email", value: email };
  const value = network === undefined ? null : networkHandle(network, id);
  return value === null ? null : { kind: "network", value };
}

export const RESERVED_NETWORKS: readonly string[] = ["phone", "email", "jid", "person", "contact", "group", "google", "face"];

const PRODUCT = /^[a-z0-9][a-z0-9-]*$/u;
const SPACE_OR_CONTROL = /[\s\p{Cc}]/u;

export function networkHandle(product: string, id: string): string | null {
  if (!PRODUCT.test(product) || RESERVED_NETWORKS.includes(product)) return null;
  const spelled = id.normalize("NFC");
  return spelled === "" || SPACE_OR_CONTROL.test(spelled) ? null : `${product}:${spelled}`;
}

export function canonicalNetwork(value: string): string | null {
  const colon = value.indexOf(":");
  if (colon < 0) return null;
  const id = value.slice(colon + 1);
  const spelled = networkHandle(value.slice(0, colon), id);
  return spelled === null || (!DIGITS.test(id) && handleOf(id) !== null) ? null : spelled;
}
const DIGITS = /^\d+$/u;

export function handleFrom(kind: string, value: string): Handle | null {
  if (kind === "network") {
    const network = canonicalNetwork(value);
    return network === null ? null : { kind: "network", value: network };
  }
  const spell = kind === "phone" ? canonicalPhone : kind === "email" ? canonicalEmail : kind === "jid" ? canonicalJid : undefined;
  const spelled = spell === undefined ? null : spell(value);
  return spelled === null ? null : handleOf(spelled);
}

export function handleId(handle: Handle): string {
  return handle.kind === "network" ? handle.value : `${handle.kind}:${handle.value}`;
}

export function compareHandles(left: Handle, right: Handle): number {
  const rank = KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind);
  return rank !== 0 ? rank : left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
}

const KIND_ORDER: readonly HandleKind[] = ["phone", "email", "jid", "network"];

export function isPhoneShaped(value: string): boolean {
  const stripped = value.replace(DIRECTIONAL_MARKS, "").trim();
  return stripped.replace(/\D/gu, "").length >= 7 && PHONE_SPELLING.test(stripped);
}

export function participantHandle(value: string): string {
  return value.trim().replace(/\(sms[a-z_]*\)$/iu, "");
}
