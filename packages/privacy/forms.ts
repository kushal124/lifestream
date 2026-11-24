
const PLACE_STREET = ["Road", "Street", "Avenue", "Boulevard", "Highway", "Marg", "Nagar", "Colony", "Layout", "Sector", "Chowk", "Vihar", "Enclave", "Apartments", "Residency", "Towers", "Puram"];

export const STREET: readonly string[] = [
  ...PLACE_STREET,
  "Rd", "St", "Lane", "Ln", "Ave", "Drive", "Dr", "Blvd", "Court", "Ct", "Way", "Place", "Pl",
  "Terrace", "Crescent", "Close", "Square", "Hwy", "Parkway", "Pkwy", "Circle", "Trail", "Cove", "Row", "Plains", "Pike",
  "Cross", "Main", "Apartment", "Apts", "Tower", "Heights", "Society", "CHS", "Complex", "Building", "Bldg", "Floor", "Mansion", "Villas", "Estate",
  "Plaza", "Gali", "Bagh", "Peth", "Ulitsa", "Strasse", "Straße", "Rue", "Calle", "Via",
];

export const PLACE_ENDS: ReadonlySet<string> = new Set([...PLACE_STREET.map((word) => word.toLowerCase()), "town", "city", "village"]);

export const STREET_WORD = new RegExp(`(?<![\\p{L}])(?:${STREET.join("|")})\\.?(?![\\p{L}])`, "u");

export function isDate(text: string): boolean {
  let parts = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/u.exec(text);
  if (parts !== null) return year(parts[3]!) && ((day(parts[1]!) && month(parts[2]!)) || (month(parts[1]!) && day(parts[2]!)));
  parts = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:T[\d:.]+Z?)?$/u.exec(text);
  if (parts !== null) return year(parts[1]!) && month(parts[2]!) && day(parts[3]!);
  parts = /^(\d{1,2})[-/](\d{4})$/u.exec(text);
  if (parts !== null) return month(parts[1]!) && year(parts[2]!);
  parts = /^(\d{4})[-/](\d{1,2})$/u.exec(text);
  if (parts !== null) return year(parts[1]!) && (month(parts[2]!) || (+parts[1]! + 1) % 100 === +parts[2]!);
  return /^(?:19|20)\d{2}$/u.test(text);
}

function day(part: string): boolean {
  return +part >= 1 && +part <= 31;
}
function month(part: string): boolean {
  return +part >= 1 && +part <= 12;
}
function year(part: string): boolean {
  return part.length === 2 || /^(?:19|20)\d{2}$/u.test(part);
}

export const PREDICATE_STARTS: ReadonlySet<string> = new Set(["will", "would", "shall", "should", "may", "might", "can", "could", "must", "ought", "do", "does", "did", "has", "have", "had", "is", "was", "are", "were", "am", "be", "thanks", "thank"]);

const FAITH_WORDS = [
  "christian", "christians", "christianity", "catholic", "catholics", "catholicism", "protestant", "protestants", "protestantism", "orthodox",
  "anglican", "anglicans", "anglicanism", "episcopalian", "episcopalians", "baptist", "baptists", "methodist", "methodists", "methodism",
  "lutheran", "lutherans", "lutheranism", "presbyterian", "presbyterians", "calvinist", "calvinists", "reformed", "evangelical", "evangelicals",
  "pentecostal", "pentecostals", "charismatic", "mormon", "mormons", "mormonism", "adventist", "adventists", "quaker", "quakers",
  "mennonite", "mennonites", "amish", "hutterite", "hutterites", "unitarian", "unitarians", "maronite", "maronites", "copt", "copts", "coptic",
  "jacobite", "jacobites", "nestorian", "syriac", "jehovah", "isai", "isaai", "masihi",
  "islam", "islamic", "muslim", "muslims", "moslem", "moslems", "musalman", "musalmaan", "musalmans", "musulman", "mussalman", "sunni", "sunnis",
  "shia", "shias", "shiite", "shiites", "shii", "sufi", "sufis", "sufism", "ahmadi", "ahmadis", "ahmadiyya", "ismaili", "ismailis", "bohra", "bohras",
  "salafi", "salafis", "wahhabi", "wahhabis", "deobandi", "barelvi", "ibadi", "ibadis", "druze", "alawite", "alawites", "alevi", "alevis",
  "hindu", "hindus", "hinduism", "sanatani", "vaishnava", "vaishnav", "vaishnavas", "vaishnavism", "shaiva", "shaivite", "shaivites", "shaivism",
  "shakta", "shaktas", "shaktism", "smarta", "smartas", "lingayat", "lingayats",
  "buddhist", "buddhists", "buddhism", "bauddh", "bauddha", "theravada", "mahayana", "vajrayana", "zen",
  "sikh", "sikhs", "sikhism", "ravidassia", "ravidasia", "jain", "jains", "jainism", "digambar", "digambara", "shwetambar", "svetambara", "shvetambara",
  "jew", "jews", "jewish", "judaism", "yahudi", "yahoodi", "hasidic", "hasidim", "haredi", "haredim",
  "zoroastrian", "zoroastrians", "zoroastrianism", "parsi", "parsis", "parsee", "parsees", "bahai", "bahais",
  "shinto", "shintoism", "taoist", "taoists", "taoism", "daoist", "daoism", "confucian", "confucianism", "caodai", "tenrikyo", "cheondoism",
  "spiritist", "spiritists", "spiritism", "candomble", "umbanda", "santeria", "vodou", "voodoo", "falun", "rastafarian", "rastafarians", "rastafari",
  "yazidi", "yazidis", "wiccan", "wiccans", "pagan", "pagans", "paganism", "animist", "animists", "animism",
  "atheist", "atheists", "atheism", "agnostic", "agnostics", "nastik",
];
export const FAITHS: ReadonlySet<string> = new Set(FAITH_WORDS);

export function isFaith(word: string): boolean {
  const lower = word.toLowerCase();
  return FAITHS.has(lower) || FAITHS.has(lower.normalize("NFD").replace(/[\p{M}'’]/gu, ""));
}

export const ORGANISATIONS: ReadonlySet<string> = new Set(["bank", "ltd", "limited", "pvt", "private", "inc", "llc", "llp", "plc", "corp", "corporation", "company", "co", "group", "technologies", "solutions", "services", "hospital", "hospitals", "healthcare", "clinic", "school", "college", "university", "institute", "foundation", "trust", "society", "association", "airlines", "railways", "insurance", "finance", "capital", "securities", "holdings", "industries", "enterprises", "agency", "department", "ministry", "bureau", "council", "committee", "associates", "partners", "sons", "brothers", "service", "support", "team"]);

export const OF_ORGANISATION: ReadonlySet<string> = new Set(["bank", "university", "ministry", "department", "state", "republic", "institute", "college", "school", "church", "kingdom", "city", "province", "county", "district"]);

export const CURRENCY_CODES: readonly string[] = ["rs", "inr", "usd", "eur", "gbp", "aed", "sgd", "aud", "cad", "jpy", "cny", "chf"];
export const CURRENCY_SIGNS: readonly string[] = ["₹", "$", "€", "£", "¥"];
export const CURRENCY_NAMES: readonly string[] = ["dollars?", "rupees?"];

export const ID_WORDS: readonly string[] = ["reference", "ref", "id", "code", "no", "number", "#"];

export const PASSWORD_WORDS: readonly string[] = ["password", "passwd", "pwd", "passphrase", "passcode"];
export const CODE_WORDS: readonly string[] = ["otp", "pin", "mpin", "tpin"];
export const CARD_CODE_WORDS: readonly string[] = ["cvv", "cvc"];
export const KEY_WORDS: readonly string[] = ["secret", "token"];
export const SECRET_WORDS: readonly string[] = [...PASSWORD_WORDS, ...CODE_WORDS, ...CARD_CODE_WORDS, ...KEY_WORDS, "pass", "key", "code", "bearer"];

const MASK_RUN = "(?:[Xx•]{2,}|\\*{2,})";
export const MASK = `(?:(?:${MASK_RUN}[ -](?=[Xx•*]{2})){1,3}${MASK_RUN}[ -]?|[Xx•]{2,}[ -]?|\\*{2,}-?)`;

export function isBold(found: string, text: string, start: number): boolean {
  if (!found.startsWith("**") || found.startsWith("***")) return false;
  const lineEnd = text.indexOf("\n", start);
  return /[^\s*]\*\*(?!\*)/u.test(text.slice(start + found.length, lineEnd === -1 ? text.length : lineEnd));
}

const SENDS = "(?:no-?reply|do-?not-?reply|notifications?|notify|alerts?|mailer|mailer-daemon|postmaster|calendar-notification|news(?:letter)?|updates?|e?statements?|receipts?)";
const DESKS = "(?:info|support|customer-?(?:care|service|support)|care|hello|team|help|helpdesk|billing|accounts?|service|enquir(?:y|ies)|contact|marketing|orders?|bookings?|feedback|admin)";
const local = (roles: string) => new RegExp(`^${roles}(?:\\p{N}*|[-._][\\p{L}\\p{N}]+)$`, "iu");
const SENDER = local(SENDS);
const ROLE = local(`(?:${SENDS}|${DESKS})`);
const localOf = (address: string) => address.slice(0, Math.max(0, address.lastIndexOf("@")));

export function isSenderMailbox(address: string): boolean {
  return SENDER.test(localOf(address));
}

export function isRoleMailbox(address: string): boolean {
  return ROLE.test(localOf(address));
}
