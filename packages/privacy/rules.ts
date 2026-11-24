import { canonicalEmail, isPhoneShaped, isPlainWord, type DetailType, type Links, type Mark } from "@lifestreamprotocol/core";
import { CARD_CODE_WORDS, CODE_WORDS, CURRENCY_CODES, CURRENCY_SIGNS, isBold, isDate, isSenderMailbox, KEY_WORDS, MASK, PASSWORD_WORDS, STREET, STREET_WORD } from "./forms.js";

export const NETWORKS: readonly string[] = ["s.whatsapp.net", "lid", "g.us", "c.us"];

export function idType(id: string): "phone" | "email" | "account" | "number.payment" {
  const value = id.trim();
  const at = value.lastIndexOf("@");
  if (at > 0) {
    const name = value.slice(0, at);
    const domain = value.slice(at + 1).toLowerCase();
    if (NETWORKS.includes(domain)) return /^\+?\d[\d-]*$/u.test(name) ? "phone" : "account";
    if (PAYMENT_HANDLES.includes(domain)) return "number.payment";
    if (domain.includes(".") && canonicalEmail(value) !== null) return "email";
  }
  return isPhoneShaped(value) ? "phone" : "account";
}

export interface Rule {
  name: string;
  type: DetailType | "id";
  pattern: RegExp;
  group?: number;
  check?: (found: string, text: string, start: number) => boolean;
  list?: boolean;
  next?: RegExp;
  cues?: readonly string[];
  lineHolds?: RegExp;
  at?: "@";
}

export interface Span {
  start: number;
  end: number;
}

const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";
const rx = (source: string, flags = "") => new RegExp(source, `dgu${flags}`);
const digits = (text: string) => text.replace(/\D/gu, "");

function anyCase(words: string): string {
  let out = "";
  let inClass = false;
  for (let at = 0; at < words.length; at += 1) {
    const character = words[at]!;
    if (character === "\\") {
      out += character + words[at + 1]!;
      at += 1;
    } else if (inClass) {
      out += /[a-z]/iu.test(character) ? character.toLowerCase() + character.toUpperCase() : character;
      if (character === "]") inClass = false;
    } else if (character === "[") {
      inClass = true;
      out += character;
    } else if (character === " ") out += "[\\s_-]*";
    else out += /[a-z]/iu.test(character) ? `[${character.toLowerCase()}${character.toUpperCase()}]` : character;
  }
  return out;
}

const BETWEEN_ON_LINE = `(?:[ \\t*_|:#=,()\\[\\]'"“”‘’–]|-(?=\\s)|\\([^()\\n\\d]{1,24}\\)|${B}${anyCase("(?:is|are|was|of|hai|ka|ki|ke|such as|for example|for instance|e\\.g\\.|namely|reads)")}${E})*`;
const BETWEEN = `${BETWEEN_ON_LINE}(?:\\n${BETWEEN_ON_LINE})?`;

function afterLabel(labels: readonly string[], value: string, before = ""): RegExp {
  return rx(`(?<![\\p{L}\\p{N}_])${before}(?:${labels.map(anyCase).join("|")})(?:s|es)?${E}(?!-\\p{L})${BETWEEN}${value}`);
}

const EMAIL_GOES_ON = "(?:-[\\p{L}\\p{N}-]*)?\\.(?:[\\p{L}\\p{N}-]+\\.)*\\p{L}{2,}(?![\\p{L}\\p{N}])";
const PART = "[\\p{L}\\p{N}]+(?:[-/._][\\p{L}\\p{N}]+)*";
const ID = `(?=[\\p{L}._/-]*\\p{N}|[A-Z]{1,4} \\p{N})(${PART}(?: (?=\\p{N})${PART}| [A-Z]{1,4}(?= \\p{N})| [A-Z]{1,3}${E}(?![ \\t]*(?:\\p{L}+\\.?[ \\t]*)?:))*)`;

function idLike(found: string): boolean {
  return (digits(found).length >= 3 || /^(?=[A-Z]*\d)[A-Z\d]{8,}$/u.test(found)) && !dateOrTime(found) && !MONEY.test(found);
}
const PRODUCT_HEAD = /^(?:sku|(?:item|product|model|article|catalog(?:ue)?|style)[ _-]?(?:code|id|no\.?|number|#)|upc|ean|asin|hsn(?: code)?)s?$/iu;

function underProductColumn(text: string, start: number): boolean {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const row = text.slice(lineStart, start);
  if (!/^[ \t]*\|/u.test(row)) return false;
  const column = row.split("|").length - 2;
  let end = lineStart - 1;
  for (let rows = 0; end > 0 && rows < 200; rows += 1) {
    const from = text.lastIndexOf("\n", end - 1) + 1;
    const line = text.slice(from, end);
    if (!/^[ \t]*\|/u.test(line)) return false;
    if (/^[ \t]*\|(?:[ \t]*:?-{3,}:?[ \t]*\|)+[ \t]*$/u.test(line)) {
      if (from === 0) return false;
      const head = text.slice(text.lastIndexOf("\n", from - 2) + 1, from - 1).split("|")[column + 1];
      return head !== undefined && PRODUCT_HEAD.test(head.replace(/[*_`]/gu, "").trim());
    }
    end = from - 1;
  }
  return false;
}
const MONEY = new RegExp(`^(?:(?:${CURRENCY_CODES.join("|")})\\.?|[${CURRENCY_SIGNS.join("")}])\\d[\\d,]*(?:\\.\\d{1,2})?$`, "iu");
const dateOrTime = (found: string): boolean => isDate(found) || /^\d{1,2}:\d{2}(?::\d{2})?$/u.test(found);

const LABELS = {
  number: [
    "medical record(?: number| no\\.?| #)?", "MRN", "patient (?:id|number|no\\.?)", "UHID",
    "customer (?:id|number|no\\.?|code|ref(?:erence)?)", "client (?:id|number|no\\.?|code)", "consumer (?:id|number|no\\.?)",
    "employee (?:id|number|no\\.?|code)", "emp\\.? ?(?:id|no\\.?|code)", "staff (?:id|number|no\\.?)", "badge (?:id|number|no\\.?)",
    "member(?:ship)? (?:id|number|no\\.?)", "subscriber (?:id|number|no\\.?)", "student (?:id|number|no\\.?)", "roll (?:number|no\\.?)",
    "policy (?:number|no\\.?|#|id)", "claim (?:number|no\\.?|id|#)", "case (?:number|no\\.?|id|#)", "insurance (?:id|number|no\\.?)",
    "(?:health plan )?beneficiary (?:number|no\\.?|id)",
    "vehicle identification number(?: \\(VIN\\))?", "vehicle (?:identifier|id|number|no\\.?)", "VIN", "chassis (?:number|no\\.?)",
    "licen[cs]e plate(?: number| no\\.?)?", "(?:vehicle )?registration (?:number|no\\.?)", "biometric (?:identifier|id)",
    "(?:national )?provider identifier(?: \\(NPI\\))?", "NPI",
    "id (?:number|no\\.?)", "respondent (?:id|number|no\\.?)", "applicant (?:id|number|no\\.?)", "account holder (?:id|number|no\\.?)",
    "UAN", "(?:EPF|PF|provident fund)(?: account)? (?:number|no\\.?)", "ESIC?(?: (?:number|no\\.?|ip))?", "subscription (?:id|number|no\\.?)",
    "file (?:number|no\\.?)", "folio(?: (?:number|no\\.?))?",
  ],
  role: ["part (?:number|no\\.?|#|id)", "(?:vendor|supplier) (?:id|number|no\\.?|code)", "vehicle", "employee", "patient", "customer", "client", "member", "staff", "student", "inspector", "vendor", "supplier", "respondent", "applicant", "subscriber", "beneficiary"],
  government: [
    "passport(?: (?:ka )?(?:number|no\\.?|#|id))?", "voter (?:id|card)(?: (?:number|no\\.?))?", "EPIC(?: number| no\\.?)?",
    "(?:driving |driver'?s? )?licen[cs]e(?: (?:number|no\\.?|#|id))?", "DL(?: number| no\\.?| #)?",
    "national (?:id(?:entity)?|identification|insurance)(?: (?:number|no\\.?|card))?", "NIN", "NINO",
    "certificate(?: licen[cs]e)? (?:number|no\\.?)", "social security(?: number| no\\.?)?", "SSN", "SIN",
    "aadhaa?r(?: (?:number|no\\.?|card))?", "ration card(?: number| no\\.?)?", "id card(?: number| no\\.?)?",
  ],
  tax: [
    "tax (?:id(?:entification)?(?: (?:number|no\\.?))?|identification number|number|no\\.?|code|reference)", "TIN", "EIN", "ITIN",
    "VAT (?:number|no\\.?|id|reg(?:istration)?(?: number| no\\.?)?)", "GSTIN", "GST (?:number|no\\.?)", "PAN(?: (?:number|no\\.?|card))?",
  ],
  bank: [
    "(?:bank )?routing(?: (?:number|no\\.?|#|code))?", "ABA(?: (?:routing )?(?:number|no\\.?))?", "RTN", "sort code",
    "swift(?: ?\\/ ?bic| bic| code)?", "BIC(?: code)?", "IBAN",
    "(?:(?:bank|savings|checking|current|loan|beneficiary) )?(?:account|a\\/c|acct)\\.?(?: (?:number|no\\.?|num|#))?",
    "beneficiary(?: (?:account|a\\/c))?(?: (?:number|no\\.?))?",
  ],
  card: ["(?:credit|debit)(?: ?\\/ ?| or | )?(?:debit )?card(?: (?:number|no\\.?|#|ending(?: in| with)?))?", "card (?:number|no\\.?|#|ending(?: in| with)?)", "payment(?: method| card)?"],
  order: [
    "order(?: (?:number|no\\.?|#|id|code))?", "booking(?: (?:number|no\\.?|#|id|code))?", "ticket(?: (?:number|no\\.?|#|id))?",
    "tracking(?: (?:number|no\\.?|#|id|code))?", "confirmation(?: (?:number|no\\.?|#|code))?", "PNR(?: number| no\\.?)?",
    "invoice(?: (?:number|no\\.?|#|id))?", "AWB(?: number| no\\.?)?", "shipment (?:id|number|no\\.?)", "consignment (?:number|no\\.?)",
    "transaction (?:id|number|no\\.?|ref(?:erence)?)", "txn (?:id|no\\.?|ref)", "UTR(?: number| no\\.?)?", "receipt (?:number|no\\.?|#)",
    "quotation (?:number|no\\.?)", "ref(?:erence)?\\.?(?: (?:number|no\\.?|id|#))?", "reservation (?:number|no\\.?|code|id)",
    "bill (?:number|no\\.?)", "challan(?: (?:number|no\\.?))?", "voucher (?:number|no\\.?)",
    "PO(?: (?:number|no\\.?|#))?", "purchase order(?: (?:number|no\\.?|#))?",
  ],
  locator: ["booking reference", "booking ref", "PNR", "reservation code", "record locator", "confirmation code"],
  user: ["user ?name", "user ?id", "login (?:id|name)", "screen name", "user"],
  address: [
    "(?:(?:street|home|residential|postal|mailing|billing|shipping|delivery|service|property|permanent|current|office|registered|correspondence|policyholder|business) )?address",
    "deliver(?:y|ed)? to", "ship(?:ped)? to", "consignee", "shipper", "recipient", "addressee",
  ],
  place: [
    "(?:resides?|residing|lives|living|located|situated|stays|staying) at", "premises(?: at)?", "residence(?: is)?(?: at)?",
    "(?:flat|house|apartment|home) is(?: at)?",
  ],
  phone: [
    "call(?: us)?(?: (?:at|on))?", "(?:tele)?phone(?: (?:number|no\\.?))?", "ph\\.?(?: no\\.?)?", "mobile(?: (?:number|no\\.?))?", "mob\\.?(?: no\\.?)?",
    "tel\\.?(?: no\\.?)?", "cell(?: phone)?", "contact(?: (?:number|no\\.?))?", "whatsapp(?: (?:number|no\\.?))?", "helpline(?: (?:number|no\\.?))?", "fax(?: no\\.?)?",
  ],
  secret: [
    ...PASSWORD_WORDS, "pass word", "wi-?fi (?:password|pass|key)",
    "api ?key", "access ?key", "secret ?key", "client ?secret", "auth(?:entication)? ?token", "access ?token", "bearer(?: token)?",
  ],
} as const;

export function labelCues(labels: readonly string[]): string[] {
  const cues = new Set<string>();
  const read = (source: string): void => {
    if (source.startsWith("(?:")) {
      let depth = 0;
      let close = 0;
      const alternatives: string[] = [];
      let from = 3;
      for (let at = 0; at < source.length; at += 1) {
        const character = source[at]!;
        if (character === "\\") at += 1;
        else if (character === "(") depth += 1;
        else if (character === ")" && (depth -= 1) === 0) { close = at; break; }
        else if (character === "|" && depth === 1) { alternatives.push(source.slice(from, at)); from = at + 1; }
      }
      alternatives.push(source.slice(from, close));
      for (const alternative of alternatives) read(alternative);
      if (/^[?*]/u.test(source.slice(close + 1))) read(source.slice(close + 2));
      return;
    }
    const letters = /^[A-Za-z]+/u.exec(source)?.[0] ?? "";
    const optional = source[letters.length] === "?" ? letters.slice(0, -1) : letters;
    if (optional === "") throw new Error(`a label that begins with no letter: ${source}`);
    cues.add(optional.toLowerCase());
  };
  for (const label of labels) read(label);
  return [...cues];
}
export const ID_NAMES: readonly string[] = [...LABELS.number, ...LABELS.government, ...LABELS.tax, ...LABELS.bank, ...LABELS.card, ...LABELS.order, ...LABELS.locator].flatMap((label) => {
  const word = /^([A-Za-z]+)(?:([A-Za-z])\?([a-z]*))?(?:\(\?:.*\)\?)?$/u.exec(label);
  if (word === null) return [];
  const [, before, optional, after] = word;
  return (optional === undefined ? [before!] : [`${before}${optional}${after}`, `${before}${after}`]).map((each) => each.toLowerCase());
});
let idLabelBeforeCache: RegExp | undefined;
export function idLabelBefore(text: string, start: number): boolean {
  if (idLabelBeforeCache === undefined) {
    const ID_LABEL_BEFORE = rx(`(?<![\\p{L}\\p{N}_])(?:${[...LABELS.number, ...LABELS.government, ...LABELS.tax, ...LABELS.bank, ...LABELS.card, ...LABELS.order, ...LABELS.locator].map(anyCase).join("|")})(?:s|es)?${E}(?!-\\p{L})${BETWEEN}$`);
    idLabelBeforeCache = ID_LABEL_BEFORE;
  }
  return idLabelBeforeCache.test(text.slice(Math.max(0, start - 40), start));
}


const NOT_A_PLACE = `(?<!${anyCase("(?:e-?mail|ip|mac|web|wallet|payment|upi|bitcoin|ethereum|crypto|contract|memory|server|url|link|return|reply|ipv[46]|sender|recipient's e-?mail)")}[\\s_-]*)`;

const SUFFIX = [
  "Alley", "Bay", "Bend", "Bluff", "Bypass", "Canyon", "Causeway", "Centers", "Chase", "Commons?", "Courts", "Creek", "Crossing", "Dale",
  "Expressway", "Extension", "Falls", "Ferry", "Ford", "Forest", "Freeway", "Gardens", "Gateway", "Glen", "Grove", "Harbou?r", "Haven",
  "Hills?", "Hollow", "Island", "Junction", "Knolls?", "Lakes?", "Landing", "Lodge", "Loop", "Manor", "Meadows?", "Mews", "Mills?",
  "Mission", "Motorway", "Mount", "Mountain", "Orchard", "Oval", "Parks?", "Path", "Pathway", "Pines?", "Prairie", "Ranch", "Rapids",
  "Rest", "Ridges?", "River", "Route", "Shoals?", "Shores?", "Skyway", "Springs?", "Stravenue", "Stream", "Summit", "Throughway",
  "Trafficway", "Tunnel", "Turnpike", "Underpass", "Valley", "Viaduct", "Villages?", "Ville", "Vista",
];
const SHORT_ADDRESS = /^(?:#[ \t]*|[A-Z]-?)?(?!(?:19|20)\d{2},)\d{1,4}[A-Za-z]?,[ \t]*\p{Lu}[^,]*,[ \t]*\p{Lu}/u;

const HOUSE = `(?:${anyCase("(?:flat|house|h\\.? ?no\\.?|plot|door|shop|unit|apt\\.?|suite|villa|no\\.)")}[ \\t]*(?:${anyCase("no\\.?")}[ \\t]*)?[-:.]?[ \\t]*|#[ \\t]*)?(?:[A-Z]{1,2}[-/]?)?\\d{1,5}[A-Za-z]?(?:[-/]\\d{1,5}[A-Za-z]?)*`;
const WORD = `(?:\\p{Lu}\\.(?=[ \\t]+\\p{Lu})|\\p{Lu}[\\p{L}'’-]*(?:\\p{N}{1,6}${E}|\\.(?=,|[ \\t]*\\d))?|\\d{1,3}(?:st|nd|rd|th|ST|ND|RD|TH))`;
const PLACE_PART = `(?:(?:Near|Opp\\.?|Opposite|Behind|Off|Next to)[ \\t]+)?${WORD}(?:[ \\t]+(?:${WORD}|No\\.?[ \\t]*\\d{1,4}|\\d{1,4}${E}))*`;
const TAIL = `(?:[ \\t]*[-,]?[ \\t]*(?:\\d{6}|\\d{3} \\d{3}|\\d{5}(?:-\\d{4})?|[A-Z]{1,2}\\d[A-Z\\d]? \\d[A-Z]{2})${E})?`;
const NEXT_PART = `,[ \\t]*(?:\\n[ \\t]*(?![^\\n:]{0,30}:))?`;
const ADDRESS = `(?:${HOUSE}(?:,?[ \\t]+|,[ \\t]*\\n[ \\t]*))?${PLACE_PART}(?:${NEXT_PART}(?:(?:\\d{1,5}[A-Za-z]?[ \\t]+)?${PLACE_PART}|\\d{1,5}[A-Za-z]?${E}))*${TAIL}`;

const COUNTRIES = new Set("AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW".split(" "));

export const PAYMENT_HANDLES: readonly string[] = ["upi", "ybl", "ibl", "axl", "apl", "paytm", "okaxis", "oksbi", "okhdfcbank", "okicici", "axisbank", "hdfcbank", "icici", "sbi", "kotak", "yesbank", "idfcbank", "pingpay", "waicici", "wahdfcbank", "waaxis", "wasbi"];

const PROFILES = ["linkedin\\.com\\/(?:in|pub)\\/", "github\\.com\\/", "gitlab\\.com\\/", "twitter\\.com\\/", "x\\.com\\/", "instagram\\.com\\/", "facebook\\.com\\/", "fb\\.com\\/", "t\\.me\\/", "medium\\.com\\/@", "tiktok\\.com\\/@", "youtube\\.com\\/@", "threads\\.net\\/@", "reddit\\.com\\/u(?:ser)?\\/"];

const CODE_WORD = `(?:${anyCase(`(?:${CODE_WORDS.map((word) => (word.endsWith("pin") ? `${word}(?![\\s_-]*code)` : word)).join("|")}|passcode|(?:verification|security|login|access|one[- ]time|auth(?:entication)?|backup|recovery) (?:codes?|password|pin))`)}(?:(?:[\\s*:=,.()-]+\\p{L}{1,8}\\)?){0,3}|(?:\\s+[\\p{L}'’]{1,12}){1,6}\\s+(?:is|was|are))|${anyCase("(?<!(?:pin|zip|postal|post|area|country|dial|std|isd)[\\s_-]*)codes?(?: (?:is|are))?")})`;
const CODE_CUES = [...CODE_WORDS, "passcode", "verification", "security", "login", "access", "one", "auth", "code", "backup", "recovery"];
const CODE_SEPARATOR = `(?:[ \\t]*[,;|][ \\t]*|[ \\t]*\\n[ \\t]*(?:[-*•][ \\t]*|\\d{1,2}[.)][ \\t]*)?|[ \\t]+)`;

const VALUE_WORDS = [...PASSWORD_WORDS, ...KEY_WORDS];

interface Compiled { rules: readonly Rule[]; sticky: readonly (RegExp | undefined)[]; listNext: RegExp; cues: Map<string, { index: number; cue: string }[]>; cueScan: RegExp }
let compiledCache: Compiled | undefined;
function compiled(): Compiled {
  if (compiledCache !== undefined) return compiledCache;
  const LABEL_CUES = Object.fromEntries(Object.entries(LABELS).map(([row, labels]) => [row, labelCues(labels)])) as unknown as Record<keyof typeof LABELS, readonly string[]>;
  const STREET_LINE = new RegExp(`(?<![\\p{L}])${trie([...STREET, "Near", "Opp", "Opposite", "Behind"], () => "", true)}(?![\\p{L}])|\\d[A-Za-z]?[ \\t]+(?:[NSEW]\\.?[ \\t]+)?(?:\\p{Lu}[\\p{L}'’-]*[ \\t]+){1,3}(?:${SUFFIX.join("|")})(?![\\p{L}])|(?<![\\p{N}])(?:\\d{6}|\\d{3})(?![\\p{N}])|\\d,[ \\t]*\\p{Lu}`, "gu");
  const SUFFIX_WORD = new RegExp(`(?<![\\p{L}])(?:${SUFFIX.join("|")})(?![\\p{L}])`, "u");
  const US_STREET = new RegExp(`^(?:#[ \\t]*)?\\d{1,6}[A-Za-z]?[ \\t]+(?:[NSEW]\\.?[ \\t]+)?(?:\\p{Lu}[\\p{L}'’-]*[ \\t]+){1,3}(?:${SUFFIX.join("|")})(?![\\p{L}])`, "u");
  const CODE_NEXT = rx(`${CODE_SEPARATOR}(\\d{4}[ -]\\d{4})(?![\\p{N}])`, "y");
  const RULES: readonly Rule[] = [
    { name: "network id", type: "id", at: "@", pattern: rx(`${B}\\+?[\\p{L}\\p{N}._-]+@(?:s\\.whatsapp\\.net|lid|g\\.us|c\\.us)${E}`, "i") },
    { name: "email", type: "id", at: "@", pattern: rx(`${B}[\\p{L}\\p{N}][\\p{L}\\p{N}._%+-]*@(?:[\\p{L}\\p{N}-]+\\.)+[\\p{L}]{2,}${E}`), check: (found) => !isSenderMailbox(found) },
    { name: "card number after its label", cues: LABEL_CUES.card, type: "number.card", group: 1, pattern: afterLabel(LABELS.card, "(\\d{4}(?:[ -]?\\d{2,6}){2,4})(?![\\p{N}])"), check: (found) => digits(found).length >= 13 && digits(found).length <= 19 },
    { name: "id after its label", cues: LABEL_CUES.number, type: "number", group: 1, list: true, pattern: afterLabel(LABELS.number, ID), check: idLike },
    { name: "id after a person's word", cues: LABEL_CUES.role, type: "number", group: 1, list: true, pattern: afterLabel(LABELS.role, `(?=[\\p{L}./-]*\\p{N})(${PART})${E}`), check: (found) => idLike(found) && (CAPITAL_IN.test(found) ? /\d/u.test(found) : digits(found).length >= 7) },
    { name: "government id after its label", cues: LABEL_CUES.government, type: "number.government", group: 1, list: true, pattern: afterLabel(LABELS.government, ID), check: idLike },
    { name: "tax id after its label", cues: LABEL_CUES.tax, type: "number.tax", group: 1, list: true, pattern: afterLabel(LABELS.tax, ID), check: idLike },
    { name: "bank number after its label", cues: LABEL_CUES.bank, type: "number.bank", group: 1, list: true, pattern: afterLabel(LABELS.bank, ID), check: (found) => (idLike(found) && digits(found).length >= 5) || /^[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/u.test(found) },
    { name: "order number after its label", cues: LABEL_CUES.order, type: "number.order", group: 1, list: true, pattern: afterLabel(LABELS.order, ID), check: (found) => /\d/u.test(found) && digits(found).length >= 3 && found.length >= 5 && !dateOrTime(found) },
    { name: "record locator after its label", cues: LABEL_CUES.locator, type: "number.order", group: 1, pattern: afterLabel(LABELS.locator, `([A-Z0-9]{6})${E}`) },
    { name: "user name after its label", cues: LABEL_CUES.user, type: "account", group: 1, pattern: afterLabel(LABELS.user, "([\\p{L}\\p{N}][\\p{L}\\p{N}._-]*[\\p{L}\\p{N}])"), check: (found, text, start) => found.length >= 3 && !isPlainWord(found) && !dateOrTime(found) && (/[\d._]/u.test(found) || !/(?<![\p{L}])user[^\p{L}\p{N}]*$/iu.test(text.slice(Math.max(0, start - 12), start))) },
    { name: "phone after its word", cues: LABEL_CUES.phone, type: "phone", group: 1, pattern: afterLabel(LABELS.phone, "(\\+?\\d(?:[ .-]?\\d){7,14})(?![\\p{N}]|[.-]\\d)"), check: (found) => !dateOrTime(found) },
    { name: "address after its label", cues: LABEL_CUES.address, type: "address", group: 1, pattern: afterLabel(LABELS.address, "(?=[^\\n|:]*[\\d,])((?:[^\\s|*;:.\"“”<>]|\\.(?=[^\\s])|(?<=(?:^|[\\s,.])(?:No|St|Rd|Ave|Dr|Apt|Opp|Ln|Blvd|Nr|Bldg|Ste|Fl|Sec|Ext|Mt|Ft|H))\\.|[ \\t]+(?=[^\\s|*;:.\"“”<>])|(?<=,)[ \\t]*\\n[ \\t]*(?![^\\n:]{0,30}:)(?=[^\\s|*;:.\"“”<>])){3,160})", NOT_A_PLACE), check: (found) => (/\d/u.test(found) || ((STREET_WORD.test(found) || SUFFIX_WORD.test(found)) && found.includes(","))) && LETTER_IN.test(found) && !/@|^\d{1,3}(?:\.\d{1,3}){3}/u.test(found) },
    { name: "address after its words", cues: LABEL_CUES.place, type: "address", group: 1, pattern: afterLabel(LABELS.place, `(${ADDRESS})`), check: (found) => CAPITAL_IN.test(found) && (STREET_WORD.test(found) || US_STREET.test(found) || /,[ \t]*\d{1,5}[A-Za-z]?$/u.test(found) || /^(?:#|[A-Z]{0,2}-?\d|(?:Flat|House|H\.? ?No|Apt|Unit|Suite|Plot|Door|Villa)\b)/iu.test(found)) },
    { name: "card", type: "number.card", pattern: rx(`${B}\\d(?:[ -]?\\d){12,18}${E}`), check: (found) => luhn(digits(found)) },
    { name: "IBAN", type: "number.bank", pattern: rx(`${B}[A-Z]{2}\\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,3})?)${E}`), check: iban },
    { name: "IFSC", type: "number.bank", pattern: rx(`${B}[A-Z]{4}0[A-Z0-9]{6}${E}`), check: (found) => /\d/u.test(found) },
    { name: "Aadhaar", type: "number.government", pattern: rx(`(?<![\\p{N}])[2-9]\\d{3}[ -]?\\d{4}[ -]?\\d{4}(?![\\p{N}])`), check: (found) => verhoeff(digits(found)) },
    { name: "SSN", type: "number.government", pattern: rx(`(?<![\\p{N}-])(?!000|666|9\\d\\d)\\d{3}-(?!00)\\d{2}-(?!0000)\\d{4}(?![\\p{N}-])`) },
    { name: "GSTIN", type: "number.tax", pattern: rx(`${B}\\d{2}[A-Z]{5}\\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]${E}`) },
    { name: "PAN", type: "number.tax", pattern: rx(`${B}[A-Z]{3}[ABCFGHLJPTK][A-Z]\\d{4}[A-Z]${E}`) },
    { name: "payment address", type: "number.payment", at: "@", pattern: rx(`${B}[\\p{L}\\p{N}._-]{2,}@(?:${PAYMENT_HANDLES.join("|")})${E}(?!${EMAIL_GOES_ON})`, "i") },
    { name: "wallet address", type: "number.payment", pattern: rx(`${B}(?:0x[a-fA-F0-9]{40}|bc1[a-z0-9]{25,59})${E}`) },
    { name: "phone, international", type: "phone", pattern: rx(`(?<![\\p{L}\\p{N}+(])(?:\\(?\\+\\d|00[1-9])[\\d\\s().-]{5,20}\\d(?:\\s*(?:x|ext\\.?)\\s*\\d{1,5})?${E}`), check: (found) => { const body = found.replace(/\s*(?:x|ext\.?)\s*\d+$/u, ""); return digits(body).length >= 8 && digits(body).length <= 17 && (/^\(?\+/u.test(found) || /[\s().-]/u.test(body)); } },
    { name: "phone, North America", type: "phone", pattern: rx(`(?<![\\p{L}\\p{N}+])(?:1[\\s.-])?(?:\\([2-9]\\d{2}\\)\\s?|[2-9]\\d{2}[\\s.-])\\d{3}[\\s.-]\\d{4}(?:\\s*(?:x|ext\\.?)\\s*\\d{1,5})?${E}`) },
    { name: "phone, India", type: "phone", pattern: rx(`${B}0?[6-9]\\d{4}[\\s-]?\\d{5}${E}`) },
    { name: "phone, national", type: "phone", pattern: rx(`(?<![\\p{L}\\p{N}+.,/-])(?:\\(0[1-9]\\d{0,3}\\)\\s?|0[1-9]\\d{0,3}[\\s.-]?)\\d{2,4}(?:[\\s.-]?\\d{2,4}){0,3}(?:\\s*(?:x|ext\\.?)\\s*\\d{1,5})?(?![\\p{L}\\p{N}]|[.,/-]\\d)`), check: (found) => { const body = found.replace(/\s*(?:x|ext\.?)\s*\d+$/u, ""); const count = digits(body).length; return (/\D/u.test(body) ? count >= 9 && count <= 13 : count === 10 || count === 11) && !/^0\d[./-]\d{1,2}[./-]\d{2,4}/u.test(found); } },
    { name: "id by its prefix", type: "number", pattern: rx(`${B}[A-Z]{2,5}-?\\d{5,20}(?![\\p{L}\\p{N}]|[-.,]\\d)`), check: (found, text, start) => !MONEY.test(found) && !underProductColumn(text, start) },
    { name: "id of a capital and digits", type: "number", pattern: rx(`${B}[A-Z](?:[a-z]?-)?\\d{6,8}(?:-[A-Z])?${E}`), check: (found, text, start) => !underProductColumn(text, start) },
    { name: "postal item", type: "number.order", pattern: rx(`${B}[A-Z]{2}\\d{9}[A-Z]{2}${E}`), check: (found) => COUNTRIES.has(found.slice(-2)) },
    { name: "SWIFT code", type: "number.bank", pattern: rx(`${B}[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?${E}`), check: (found) => COUNTRIES.has(found.slice(4, 6)) && /\d/u.test(found.slice(6)) && /^[A-Z]{4}/u.test(found) },
    { name: "routing number", type: "number.bank", pattern: rx(`(?<![\\p{L}\\p{N}.,/-])\\d{9}(?![\\p{L}\\p{N}]|[.,/-]\\d)`), check: aba },
    { name: "last digits", cues: ["ending", "ends", "last", "card", "a", "acct", "account"], type: "number", group: 1, pattern: rx(`${B}(?:ending(?:\\s+(?:in|with))?|ends\\s+(?:in|with)|last\\s+(?:4|four)\\s+digits(?:\\s+of)?|(?:card|a\\/c|acct|account)\\.?(?:[ \\t]+(?:no\\.?|number|#))?)[ \\t]*[:]?[ \\t]*(\\d{4})(?![\\p{L}\\p{N}]|[ -]?\\d)`, "i") },
    { name: "masked phone", type: "phone", pattern: rx(`(?<![\\p{L}\\p{N}+*•])\\+?\\d{2,5}(?:[Xx]{3,7}|\\*{3,7}|•{3,7})\\d{2,4}(?![\\p{L}\\p{N}*•])`), check: (found) => found.replace(/^\+/u, "").length >= 10 && found.replace(/^\+/u, "").length <= 13 },
    { name: "masked digits", type: "number", pattern: rx(`(?<![\\p{L}\\p{N}*•])(?:${MASK}|\\*)\\d{4}(?![\\p{N}*]|[-/.]\\d)`), check: (found, text, start) => !isBold(found, text, start) },
    { name: "key by its prefix", type: "secret", pattern: rx(`${B}(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,}|xox[abposr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,})`) },
    { name: "private key", type: "secret", pattern: rx(`-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----`) },
    { name: "web token", type: "secret", pattern: rx(`${B}eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}`) },
    { name: "value after its word", cues: [...VALUE_WORDS, "api"], type: "secret", group: 1, pattern: rx(`${B}(?:${VALUE_WORDS.join("|")}|api[ _-]?key)${E}[\\s*_]*(?:is\\s*)?[:=](?:[*_]{1,2}(?=\\s))?[\\s_]*(?![\\[(<])([*•●]{3,}(?![^\\s.,;])|\\S*[^\\s.,;:?)\\]}'"*])`, "i"), check: valueAfterWord },
    { name: "secret in a sentence", cues: LABEL_CUES.secret, type: "secret", group: 1, pattern: afterLabel(LABELS.secret, "(?:(?:[\\p{L}'’]{1,16}[ \\t]+){1,6}(?:is|was)[ \\t]+)?([^\\s'\"“”‘’<>`]*[^\\s.,;:?)\\]}'\"“”‘’<>`*])"), check: secretLike },
    { name: "code after its word", cues: CODE_CUES, type: "secret", group: 1, pattern: rx(`${B}${CODE_WORD}${E}[\\s*:=,(-]*(\\d{3,4}(?:[ -]\\d{3,4}){1,2}(?![\\p{N}]|[\\s-]\\d)|\\d{4,10}#?(?![\\p{N}#]|[\\s-]\\d))`) },
    { name: "codes listed after their word", cues: CODE_CUES, type: "secret", group: 1, list: true, next: CODE_NEXT, pattern: rx(`${B}${CODE_WORD}${E}[\\s*:=,(-]*(?:\\d{1,2}[.)][ \\t]+)?(\\d{4}[ -]\\d{4})(?=${CODE_SEPARATOR}\\d{4}[ -]\\d{4}(?!\\d))`) },
    { name: "codes by their shape", type: "secret", group: 1, list: true, next: CODE_NEXT, pattern: rx(`(?<![\\p{L}\\p{N}]|\\p{N}[ -])(\\d{4} \\d{4})(?=(?:${CODE_SEPARATOR}\\d{4} \\d{4}){2}(?!\\d))`), check: (found) => !found.split(" ").every((group) => /^(?:19|20)\d{2}$/u.test(group)) },
    { name: "card code after its word", cues: [...CARD_CODE_WORDS, "card", "security"], type: "secret", group: 1, pattern: rx(`${B}${anyCase(`(?:${CARD_CODE_WORDS.map((word) => `${word}2?`).join("|")}|card verification (?:value|code)|security code)`)}(?:[\\s*:=,.|-]+\\p{L}{1,8}){0,4}[\\s*:=,|-]+(\\d{3,4})(?![\\p{N}]|[\\s-]\\d)`) },
    { name: "code before its word", type: "secret", group: 1, pattern: rx(`(?<!\\d)(\\d{4,8})\\s+is\\s+your\\s+(?:otp|code|pin|(?:verification|security|login|one[- ]time)\\s+(?:code|password))${E}`, "i") },
    { name: "key by its letters", type: "secret", lineHolds: /(?<![A-Za-z0-9])[A-Za-z0-9]{20}/gu, pattern: rx(`(?<![\\p{L}\\p{N}_./=+-])(?:[a-z]{2,10}_){0,3}[A-Za-z0-9]{20,}(?![\\p{L}\\p{N}_/=+-]|\\.[\\p{L}\\p{N}])`), check: (found, text, start) => keyLike(found.slice(found.lastIndexOf("_") + 1)) && !inLink(text, start) },
    { name: "password after a login", type: "secret", group: 1, lineHolds: /[ \t]\/[ \t]/gu, pattern: rx(`(?:${B}[\\p{L}\\p{N}][\\p{L}\\p{N}._%+-]*@(?:[\\p{L}\\p{N}-]+\\.)+\\p{L}{2,}|${B}[a-z][a-z0-9]*[._][a-z0-9]+(?:[._][a-z0-9]+)*)[ \\t]+\\/[ \\t]+([^\\s'"“”<>]*[^\\s.,;:!?)\\]}'"“”<>])`), check: (found, text, start) => found.length >= 6 && LETTER_IN.test(found) && !found.includes("@") && secretLike(found) && !inLink(text, start) },
    { name: "password by its shape", type: "secret", lineHolds: /\p{Ll}[@!$]\d/gu, pattern: rx(`${B}\\p{Lu}\\p{Ll}{2,15}[@!$]\\d{2,6}[!@#$]?(?![\\p{L}\\p{N}@]|\\.[\\p{L}\\p{N}])`) },
    { name: "street address", type: "address", lineHolds: STREET_LINE, pattern: rx(`${B}${HOUSE}(?:,?[ \\t]+|,[ \\t]*\\n[ \\t]*)${PLACE_PART}(?:${NEXT_PART}(?:\\d{1,5}[A-Za-z]?[ \\t]+)?${PLACE_PART}){0,6}${TAIL}`), check: (found, text, start) => STREET_WORD.test(found) || US_STREET.test(found) || shortAddress(found, text, start) || /,\s*(?:Near|Opp\.?|Opposite|Behind)\s/u.test(found) || /(?:^|\D)(?:\d{6}|\d{3} \d{3})$/u.test(found) },
    { name: "coordinate pair", type: "place", lineHolds: /\d\.\d{4}/gu, pattern: rx(`(?<![\\p{L}\\p{N}.])(?:${anyCase("lat(?:itude)?")}\\s*[:=]?\\s*)?-?\\d{1,2}\\.\\d{4,}°?(?:\\s?[NS])?(?:\\s*,\\s*|\\s+)(?:${anyCase("(?:lon(?:g(?:itude)?)?|lng)")}\\s*[:=]?\\s*)?-?\\d{1,3}\\.\\d{4,}°?(?:\\s?[EW]${E})?(?![\\p{N}])`), check: coordinates },
    { name: "home folder", type: "account", group: 1, pattern: rx(`(?<![\\p{L}\\p{N}._~-])(?:\\/Users\\/|\\/home\\/|[A-Za-z]:\\\\Users\\\\)([^\\/\\\\\\s:"'<>]+)`), check: (found) => !["shared", "guest", "public", "default"].includes(found.toLowerCase()) },
    { name: "shell prompt", type: "account", group: 1, at: "@", pattern: rx(`(?<![\\p{L}\\p{N}._@-])([a-z_][a-z0-9_-]{0,31})@[A-Za-z0-9][A-Za-z0-9.-]*(?=:[~\\/]|[ \\t]+[~\\/]\\S*[ \\t]*[%$#])`) },
    { name: "handle", type: "account", at: "@", pattern: rx(`(?<![\\p{L}\\p{N}._%+@/-])@[A-Za-z0-9_](?:[A-Za-z0-9_.]*[A-Za-z0-9_])?(?![\\p{L}\\p{N}_@]|\\.[\\p{L}\\p{N}])`), check: (found) => /[A-Za-z_]/u.test(found) },
    { name: "user name by its shape", type: "account", lineHolds: /\p{Ll}[._]?\d{2}/gu, pattern: rx(`(?<![\\p{L}\\p{N}._%+@/#:-])(?:[a-z]{1,4}_)?\\p{L}\\p{Ll}+(?:\\p{Lu}\\p{Ll}+)*[._]?\\d{2,4}(?![\\p{L}\\p{N}@]|[._-][\\p{L}\\p{N}])`), check: userNameLike },
    { name: "profile path", type: "account", group: 1, lineHolds: /\.(?:com|me|net)\//gu, pattern: rx(`(?<![\\p{L}\\p{N}.-])(?:www\\.)?(?:${PROFILES.join("|")})([A-Za-z0-9._-]{2,})`), check: (found) => /[\d._-]/u.test(found) || !isPlainWord(found) },
  ];
  const STICKY: readonly (RegExp | undefined)[] = RULES.map((rule) => (rule.cues === undefined && rule.at === undefined ? undefined : new RegExp(rule.pattern.source, rule.pattern.flags.replace("g", "") + "y")));
  const LIST_NEXT = rx(`(?:[ \\t]*[,;/&][ \\t]*|[ \\t]+(?:and|or|&)[ \\t]+)${ID}`, "y");
  const CUES = new Map<string, { index: number; cue: string }[]>();
  for (const [index, rule] of RULES.entries()) {
    for (const cue of rule.cues ?? []) {
      const key = cue.slice(0, 2);
      if (!CUES.has(key)) CUES.set(key, []);
      CUES.get(key)!.push({ index, cue });
    }
  }
  const CUE_SCAN = new RegExp(`(?<![\\p{L}\\p{N}])${trie(RULES.flatMap((rule) => rule.cues ?? []), (cue) => (cue.length === 1 ? "(?![\\p{L}\\p{N}])" : ""))}`, "giu");
  compiledCache = { rules: RULES, sticky: STICKY, listNext: LIST_NEXT, cues: CUES, cueScan: CUE_SCAN };
  return compiledCache;
}
export function allRules(): readonly Rule[] {
  return compiled().rules;
}

const CAPITAL_IN = /\p{Lu}/u;
const SMALL_IN = /\p{Ll}/u;
const LETTER_IN = /\p{L}/u;
const ITEM_BEFORE = /\p{Lu}\p{L}*[ \t]+$/u;
const BEFORE_CAPITAL = /(?=\p{Lu})/u;

function shortAddress(found: string, text: string, start: number): boolean {
  return SHORT_ADDRESS.test(found) && !ITEM_BEFORE.test(text.slice(Math.max(0, start - 24), start)) && !/^[ \t]*:/u.test(text.slice(start + found.length));
}

function userNameLike(found: string, text: string, start: number): boolean {
  const letters = found.replace(/^[a-z]{1,4}_/u, "").replace(/[._]?\d+$/u, "");
  const words = letters.split(BEFORE_CAPITAL).map((word) => word.toLowerCase());
  return !words.every((word) => isPlainWord(word)) && !/(?<!\d)00\d+$/u.test(found) && !inLink(text, start);
}

function valueAfterWord(found: string, text: string, start: number): boolean {
  if (/^[*•●]+$/u.test(found)) return true;
  if (found.length < 4) return false;
  return !/(?:api[ _-]?key|secret|token)\W*$/iu.test(text.slice(Math.max(0, start - 40), start)) || !isPlainWord(found.toLowerCase());
}

function secretLike(found: string): boolean {
  if (found.length < 4 || found.length > 200 || dateOrTime(found) || isPlainWord(found) || found.includes("://")) return false;
  return /\d/u.test(found) || /[^\p{L}\p{N}]/u.test(found);
}

function keyLike(run: string): boolean {
  if (run.length < 20) return false;
  const kinds = [...run].map((character) => (/\d/u.test(character) ? 0 : CAPITAL_IN.test(character) ? 1 : 2));
  if (kinds.filter((kind) => kind === 0).length < 2 || kinds.filter((kind) => kind === 1).length < 2 || kinds.filter((kind) => kind === 2).length < 2) return false;
  let changes = 0;
  for (let at = 1; at < kinds.length; at += 1) if (kinds[at] !== kinds[at - 1]) changes += 1;
  return changes >= 0.45 * (run.length - 1);
}

function inLink(text: string, at: number): boolean {
  let start = at;
  while (start > 0 && !/\s/u.test(text[start - 1]!)) start -= 1;
  const word = text.slice(start, at);
  return word.includes("://") || /^\W*www\./iu.test(word);
}

function aba(number: string): boolean {
  const district = Number(number.slice(0, 2));
  if (!((district >= 1 && district <= 12) || (district >= 21 && district <= 32) || (district >= 61 && district <= 72) || district === 80)) return false;
  let sum = 0;
  for (let at = 0; at < 9; at += 1) sum += Number(number[at]) * [3, 7, 1][at % 3]!;
  return sum % 10 === 0;
}

const LINK = /\bhttps?:\/\/[^\s<>"'`]+/giu;

export function ruleMarks(text: string, links: Links, everywhere = false): { marks: Mark[]; soft: Span[] } {
  const { rules: RULES, sticky: STICKY, listNext: LIST_NEXT } = compiled();
  const marks: Mark[] = [];
  const read = everywhere ? null : scanOf(text);
  const take = (rule: Rule, match: RegExpExecArray, from: number): number => {
    const span = match.indices?.[rule.group ?? 0];
    if (span === undefined) return -1;
    const start = from + span[0];
    let end = from + span[1];
    const found = text.slice(start, end);
    if (found === "" || (rule.check !== undefined && !rule.check(found, text, start))) return -1;
    marks.push({ start, end, type: rule.type === "id" ? idType(found) : rule.type });
    let last = from + match.index + match[0].length;
    if (rule.list === true) {
      for (;;) {
        const listNext = rule.next ?? LIST_NEXT;
        listNext.lastIndex = end;
        const next = listNext.exec(text);
        const value = next?.[1];
        if (next === null || value === undefined) break;
        const at = next.indices![1]![0];
        if (!sameForm(found, value) || (rule.check !== undefined && !rule.check(value, text, at))) break;
        marks.push({ start: at, end: at + value.length, type: rule.type === "id" ? idType(value) : rule.type });
        end = at + value.length;
        last = end;
      }
    }
    return last;
  };
  for (const [index, rule] of RULES.entries()) {
    if (read !== null && rule.cues !== undefined) {
      const sticky = STICKY[index]!;
      let after = 0;
      for (const at of read.cued[index] ?? []) {
        if (at < after) continue;
        sticky.lastIndex = at;
        const match = sticky.exec(text);
        if (match !== null) after = Math.max(after, match.index + match[0].length, take(rule, match, 0));
      }
      continue;
    }
    if (read !== null && rule.at !== undefined) {
      const sticky = STICKY[index]!;
      let after = 0;
      for (let at = text.indexOf(rule.at); at !== -1; at = text.indexOf(rule.at, at + 1)) {
        if (at < after) continue;
        let from = at;
        while (from > after && NAME_RUN.test(text[from - 1]!)) from -= 1;
        for (let start = from; start <= at; start += 1) {
          sticky.lastIndex = start;
          const match = sticky.exec(text);
          if (match === null) continue;
          after = Math.max(after, match.index + match[0].length, take(rule, match, 0));
          break;
        }
      }
      continue;
    }
    const lines = read !== null && rule.lineHolds !== undefined ? read.lines(rule) : [[0, text.length] as const];
    for (const [from, to] of lines) {
      const part = from === 0 && to === text.length ? text : text.slice(from, to);
      const pattern = rule.pattern;
      pattern.lastIndex = 0;
      for (let match = pattern.exec(part); match !== null; match = pattern.exec(part)) {
        const last = take(rule, match, from) - from;
        pattern.lastIndex = Math.max(match.index + Math.max(match[0].length, 1), last);
      }
    }
  }
  const soft: Span[] = [];
  for (const match of text.matchAll(LINK)) {
    const parts = linkParts(trimmed(match[0]), links);
    for (const part of parts.hidden) marks.push({ start: match.index + part.start, end: match.index + part.end, type: "link" });
    for (const part of parts.soft) soft.push({ start: match.index + part.start, end: match.index + part.end });
  }
  return { marks, soft };
}


function trie(words: readonly string[], tail: (word: string) => string = () => "", fold = false): string {
  interface Node { next: Map<string, Node>; end: string | null }
  const root: Node = { next: new Map(), end: null };
  for (const word of new Set(words.map((each) => each.toLowerCase()))) {
    let node = root;
    for (const letter of word) {
      if (!node.next.has(letter)) node.next.set(letter, { next: new Map(), end: null });
      node = node.next.get(letter)!;
    }
    node.end = tail(word);
  }
  const source = (node: Node): string => {
    const branches = [...node.next].map(([letter, child]) => `${fold && letter !== letter.toUpperCase() ? `[${letter}${letter.toUpperCase()}]` : letter.replace(/[\\^$.*+?()[\]{}|/-]/gu, "\\$&")}${source(child)}`);
    if (node.end !== null) branches.push(node.end);
    return branches.length === 1 ? branches[0]! : `(?:${branches.join("|")})`;
  };
  return source(root);
}

const NAME_RUN = /[\p{L}\p{N}._%+-]/u;


function sameForm(first: string, next: string): boolean {
  return LETTER_IN.test(first) === LETTER_IN.test(next) && Math.abs(digits(first).length - digits(next).length) <= 3;
}

const WORD_AT = /[\p{L}\p{N}]+/uy;

function scanOf(text: string): { cued: number[][]; lines: (rule: Rule) => [number, number][] } {
  const { cues: CUES, cueScan: CUE_SCAN } = compiled();
  const cued: number[][] = [];
  for (const hit of text.matchAll(CUE_SCAN)) {
    WORD_AT.lastIndex = hit.index;
    const lower = WORD_AT.exec(text)![0].toLowerCase();
    for (const { index, cue } of CUES.get(lower.slice(0, 2)) ?? []) {
      if (!lower.startsWith(cue)) continue;
      const list = (cued[index] ??= []);
      if (list.at(-1) !== hit.index) list.push(hit.index);
    }
  }
  return {
    cued,
    lines(rule) {
      const lines: [number, number][] = [];
      const holds = rule.lineHolds!;
      holds.lastIndex = 0;
      for (let match = holds.exec(text); match !== null; match = holds.exec(text)) {
        const line = lineOf(text, match.index);
        lines.push(line);
        holds.lastIndex = Math.max(line[1], match.index + 1);
      }
      return lines;
    },
  };
}

function lineOf(text: string, at: number): [number, number] {
  let start = text.lastIndexOf("\n", at - 1);
  while (start > 0 && goesOn(text, start)) start = text.lastIndexOf("\n", start - 1);
  let end = text.indexOf("\n", at);
  while (end !== -1 && goesOn(text, end)) end = text.indexOf("\n", end + 1);
  return [start + 1, end === -1 ? text.length : end];
}

function goesOn(text: string, lineBreak: number): boolean {
  const from = Math.max(0, lineBreak - 8);
  let at = lineBreak - 1;
  while (at >= from && (text[at] === " " || text[at] === "\t")) at -= 1;
  return at >= from && text[at] === ",";
}

export function linkParts(link: string, links: Links): { hidden: Span[]; soft: Span[] } {
  const hidden: Span[] = [];
  const soft: Span[] = [];
  if (links === "none") return { hidden, soft };
  const authorityStart = link.indexOf("//") + 2;
  const authorityEnd = firstOf(link, "/?#", authorityStart);
  const at = link.lastIndexOf("@", authorityEnd - 1);
  if (at >= authorityStart) hidden.push({ start: authorityStart, end: at });
  if (links === "path") {
    const from = authorityEnd + 1;
    if (from < link.length) hidden.push({ start: from, end: link.length });
    return { hidden: hidden.filter((span) => span.end > span.start), soft };
  }
  const queryAt = firstOf(link, "?#", authorityEnd);
  let start = authorityEnd + 1;
  while (start <= queryAt) {
    const end = Math.min(firstOf(link, "/", start), queryAt);
    if (end > start) (looksLikeToken(link.slice(start, end)) ? hidden : soft).push({ start, end });
    start = end + 1;
  }
  const hash = link.indexOf("#", authorityEnd);
  const queryEnd = hash === -1 ? link.length : hash;
  if (link[queryAt] === "?" && queryEnd > queryAt + 1) hidden.push({ start: queryAt + 1, end: queryEnd });
  if (hash !== -1 && hash + 1 < link.length) hidden.push({ start: hash + 1, end: link.length });
  return { hidden: hidden.filter((span) => span.end > span.start), soft };
}

export function looksLikeToken(segment: string): boolean {
  let value = segment;
  try {
    value = decodeURIComponent(segment);
  } catch {
  }
  return value.split(/[-_.~+=,;:@!$&'()*]/u).some((piece) => {
    const numbers = digits(piece).length;
    const letters = (piece.match(/\p{L}/gu) ?? []).length;
    if (letters === 0) return numbers >= 5;
    if (numbers >= 2 && piece.length >= 6) return true;
    return piece.length >= 16 && CAPITAL_IN.test(piece) && SMALL_IN.test(piece);
  });
}

function trimmed(link: string): string {
  let end = link.length;
  while (end > 0 && /[.,;:!?'"\])}>]/u.test(link[end - 1]!)) {
    const closer = link[end - 1]!;
    const opener = closer === ")" ? "(" : closer === "]" ? "[" : closer === "}" ? "{" : null;
    if (opener !== null && link.slice(0, end - 1).split(opener).length > link.slice(0, end - 1).split(closer).length) break;
    end -= 1;
  }
  return link.slice(0, end);
}

function firstOf(text: string, characters: string, from: number): number {
  for (let at = from; at < text.length; at += 1) if (characters.includes(text[at]!)) return at;
  return text.length;
}

function luhn(number: string): boolean {
  if (number.length < 13 || number.length > 19) return false;
  let sum = 0;
  for (let at = 0; at < number.length; at += 1) {
    let digit = Number(number[number.length - 1 - at]);
    if (at % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  return sum % 10 === 0;
}

function iban(found: string): boolean {
  const compact = found.replace(/ /gu, "");
  if (compact.length < 15 || compact.length > 34) return false;
  const moved = compact.slice(4) + compact.slice(0, 4);
  let rest = 0;
  for (const character of moved) {
    const value = /\d/u.test(character) ? character : String(character.charCodeAt(0) - 55);
    for (const digit of value) rest = (rest * 10 + Number(digit)) % 97;
  }
  return rest === 1;
}

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

function verhoeff(number: string): boolean {
  if (number.length !== 12) return false;
  let check = 0;
  for (let at = 0; at < number.length; at += 1) check = VERHOEFF_D[check]![VERHOEFF_P[at % 8]![Number(number[number.length - 1 - at])]!]!;
  return check === 0;
}

function coordinates(found: string): boolean {
  const [latitude, longitude] = (found.match(/-?\d+\.\d+/gu) ?? []).map(Number);
  return latitude !== undefined && longitude !== undefined && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}
