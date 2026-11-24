import type { DetailType } from "@lifestreamprotocol/core";
import type { NamedPerson, NameTable } from "../names.js";

export interface BenchDetail {
  start: number;
  end: number;
  type: DetailType;
  shape: string;
  known: boolean;
}

export interface BenchDoc {
  id: string;
  kind: string;
  text: string;
  details: BenchDetail[];
  optional: [number, number, string][];
}

export interface Rng {
  next(): number;
  int(below: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
}

export function rngOf(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    int: (below) => Math.floor(next() * below),
    pick: (items) => items[Math.floor(next() * items.length)]!,
    chance: (p) => next() < p,
  };
}

const GIVEN_F = ["Priya", "Ananya", "Aditi", "Kavya", "Sneha", "Pooja", "Neha", "Divya", "Isha", "Riya", "Meera", "Shreya", "Nisha", "Anjali", "Tanvi", "Aishwarya", "Lakshmi", "Swati", "Payal", "Sakshi", "Nandini", "Radhika", "Kiran", "Asha", "Deepa", "Farah", "Zoya", "Sana", "Gurpreet", "Simran", "Harleen", "Fatima", "Mary", "Grace", "Rose", "Joy", "Hope", "Sunita", "Rekha", "Usha"];
const GIVEN_M = ["Rohan", "Arjun", "Aditya", "Rahul", "Vikram", "Karan", "Siddharth", "Aman", "Nikhil", "Varun", "Rohit", "Akash", "Kunal", "Ankit", "Saurabh", "Abhishek", "Harsh", "Yash", "Pranav", "Manish", "Suresh", "Ramesh", "Mahesh", "Rajesh", "Deepak", "Suraj", "Sagar", "Prem", "Imran", "Faisal", "Arif", "Harpreet", "Gurdeep", "Joseph", "Thomas", "Will", "Max", "Mark", "Raja", "Ram"];
const FAMILY = ["Sharma", "Verma", "Gupta", "Mehta", "Iyer", "Nair", "Reddy", "Rao", "Patel", "Shah", "Desai", "Joshi", "Kulkarni", "Deshpande", "Banerjee", "Chatterjee", "Mukherjee", "Das", "Bose", "Sen", "Singh", "Kaur", "Gill", "Malhotra", "Kapoor", "Khanna", "Chopra", "Agarwal", "Jain", "Bansal", "Menon", "Pillai", "Krishnan", "Subramanian", "Naidu", "Khan", "Sheikh", "Qureshi", "D'Souza", "Fernandes", "Pereira", "Thakur", "Yadav", "Mishra", "Tiwari", "Pandey", "Chauhan", "Bhat", "Hegde", "Shetty"];
const NICKS = ["Bunty", "Pinky", "Sunny", "Lucky", "Honey", "Golu", "Chintu", "Monu", "Tinku", "Babloo", "Guddu", "Dolly"];
const BUSINESSES = ["Swiggy", "Zomato", "Amazon", "Flipkart", "Myntra", "BigBasket", "Blinkit", "Uber", "Ola", "Rapido", "IRCTC", "IndiGo", "Air India", "MakeMyTrip", "Airtel", "Jio", "Zerodha", "PhonePe", "Google Pay", "Paytm", "Nykaa", "Decathlon", "Croma", "Tata 1mg"];
const BANKS = [
  { name: "HDFC Bank", short: "HDFC", ifsc: "HDFC", care: "1800 202 6161" },
  { name: "ICICI Bank", short: "ICICI", ifsc: "ICIC", care: "1800 1080" },
  { name: "State Bank of India", short: "SBI", ifsc: "SBIN", care: "1800 1234" },
  { name: "Axis Bank", short: "Axis", ifsc: "UTIB", care: "1800 419 5959" },
  { name: "Kotak Mahindra Bank", short: "Kotak", ifsc: "KKBK", care: "1860 266 2666" },
];
const UPI_SUFFIX = ["okaxis", "oksbi", "okhdfcbank", "okicici", "ybl", "paytm", "ibl", "axl"];
const CITIES = [
  { city: "Bengaluru", pin: "5600", areas: ["Indiranagar", "Koramangala", "HSR Layout", "Jayanagar", "Whitefield", "Malleshwaram"] },
  { city: "Mumbai", pin: "4000", areas: ["Andheri West", "Bandra West", "Powai", "Chembur", "Malad East", "Dadar"] },
  { city: "Pune", pin: "4110", areas: ["Kothrud", "Baner", "Aundh", "Viman Nagar", "Hadapsar", "Wakad"] },
  { city: "Hyderabad", pin: "5000", areas: ["Banjara Hills", "Madhapur", "Gachibowli", "Kondapur", "Begumpet", "Kukatpally"] },
  { city: "New Delhi", pin: "1100", areas: ["Lajpat Nagar", "Saket", "Dwarka", "Rohini", "Karol Bagh", "Vasant Kunj"] },
  { city: "Chennai", pin: "6000", areas: ["Adyar", "T Nagar", "Velachery", "Anna Nagar", "Mylapore", "Besant Nagar"] },
  { city: "Kolkata", pin: "7000", areas: ["Salt Lake", "Ballygunge", "Behala", "New Town", "Gariahat", "Tollygunge"] },
];
const BUILDINGS = ["Shanti Apartments", "Prestige Residency", "Sai Krupa Towers", "Green Park Society", "Lakeview Heights", "Ashirwad Enclave", "Gokul Dham", "Sunrise CHS", "Brigade Meadows", "Royal Palms"];
const TEST_CARDS = ["4111 1111 1111 1111", "5555 5555 5555 4444", "4012 8888 8888 1881", "5105 1051 0510 5100", "4000 0566 5566 5556"];
const PAN_PREFIX = ["ABC", "XYZ", "PQR", "LMN", "DEF", "GHJ"];

interface Person {
  who: string;
  given: string;
  family: string;
  nick?: string;
  phone: string;
  email: string;
  upi: string;
  handle: string;
  known: boolean;
}

const pad = (n: number, width: number) => String(n).padStart(width, "0");

function mobile(r: Rng): string {
  return `${r.pick(["98765", "99999", "90000", "80000", "70000", "60000"])}0${pad(r.int(10_000), 4)}`;
}

function personOf(r: Rng, index: number, known: boolean): Person {
  const female = r.chance(0.5);
  const given = r.pick(female ? GIVEN_F : GIVEN_M);
  const family = r.pick(FAMILY);
  const phone = mobile(r);
  const plainFamily = family.toLowerCase().replace(/[^a-z]/gu, "");
  const email = r.pick([
    `${given.toLowerCase()}.${plainFamily}@example.com`,
    `${given.toLowerCase()}${pad(r.int(100), 2)}@example.in`,
    `${given[0]!.toLowerCase()}${plainFamily}@example.org`,
  ]);
  const upi = r.pick([`${given.toLowerCase()}.${plainFamily}@${r.pick(UPI_SUFFIX)}`, `${phone}@${r.pick(["ybl", "paytm", "ibl"])}`, `${given.toLowerCase()}${plainFamily}@paytm`]);
  const handle = r.pick([`${given.toLowerCase()}.${plainFamily}_${pad(r.int(100), 2)}`, `${given.toLowerCase()}_${plainFamily}`, `the${given.toLowerCase()}${plainFamily}`]);
  return { who: `p-${pad(index, 4)}`, given, family, ...(r.chance(0.15) ? { nick: r.pick(NICKS) } : {}), phone, email, upi, handle, known };
}

class Writer {
  text = "";
  details: BenchDetail[] = [];
  optional: [number, number, string][] = [];
  t(words: string): this {
    this.text += words;
    return this;
  }
  d(type: DetailType, shape: string, value: string, known = false): this {
    const start = this.text.length;
    this.text += value;
    this.details.push({ start, end: this.text.length, type, shape, known });
    return this;
  }
  o(what: string, value: string): this {
    const start = this.text.length;
    this.text += value;
    this.optional.push([start, this.text.length, what]);
    return this;
  }
  call<A extends unknown[]>(helper: (w: Writer, ...args: A) => Writer, ...args: A): this {
    helper(this, ...args);
    return this;
  }
}

export interface Shape {
  shape: string;
  type: DetailType;
  make: (r: Rng) => string;
  context: string;
  table?: true;
}

const amount = (r: Rng) => `${(r.int(90) + 1) * 50 + r.int(50)}.${pad(r.int(100), 2)}`;
const date = (r: Rng) => `${pad(r.int(28) + 1, 2)}-${pad(r.int(12) + 1, 2)}-2026`;
const time = (r: Rng) => `${r.int(12) + 1}:${pad(r.int(60), 2)} ${r.pick(["AM", "PM"])}`;
const last4 = (r: Rng) => pad(r.int(10_000), 4);
const digitsOf = (r: Rng, n: number) => Array.from({ length: n }, () => String(r.int(10))).join("");
const letters = (r: Rng, n: number) => Array.from({ length: n }, () => String.fromCharCode(65 + r.int(26))).join("");
const alnum = (r: Rng, n: number) => Array.from({ length: n }, () => (r.chance(0.5) ? String(r.int(10)) : String.fromCharCode(65 + r.int(26)))).join("");

function aadhaar(r: Rng): string {
  const body = `9999${pad(r.int(10_000), 4)}${pad(r.int(1000), 3)}`;
  return `${body}${verhoeffDigit(body)}`.replace(/(\d{4})(\d{4})(\d{4})/u, "$1 $2 $3");
}

const pan = (r: Rng, kind = "P") => `${r.pick(PAN_PREFIX)}${kind}${letters(r, 1)}${pad(r.int(1000), 4)}${letters(r, 1)}`;

function address(r: Rng): { value: string; shape: string } {
  const place = r.pick(CITIES);
  const area = r.pick(place.areas);
  const pin = `${place.pin}${pad(r.int(100), 2)}`;
  switch (r.int(4)) {
    case 0: return { value: `Flat ${r.int(9) + 1}0${r.int(9) + 1}, ${r.pick(BUILDINGS)}, ${r.int(20) + 1}th Cross, ${area}, ${place.city} ${pin}`, shape: "address.flat" };
    case 1: return { value: `H.No. ${r.int(20) + 1}-${r.int(9) + 1}-${r.int(900) + 100}, Road No. ${r.int(12) + 1}, ${area}, ${place.city} - ${pin}`, shape: "address.house" };
    case 2: return { value: `${r.int(300) + 1}, ${r.pick(BUILDINGS)}, ${area}`, shape: "address.short" };
    default: return { value: `${r.pick(["B", "C", "D"])}-${r.int(400) + 100}, ${r.pick(BUILDINGS)}, Near ${r.pick(["Metro Station", "City Mall", "Ganesh Temple", "Bus Depot"])}, ${area}, ${place.city}, ${r.pick(["Karnataka", "Maharashtra", "Telangana", "Delhi", "Tamil Nadu", "West Bengal"])} ${pin}`, shape: "address.landmark" };
  }
}

export const SHAPES: readonly Shape[] = [
  { shape: "phone.in-bare", type: "phone", make: (r) => mobile(r).replace(/(\d{5})(\d{5})/u, "$1 $2"), context: "mera number {} hai, call kar" },
  { shape: "phone.in-plain", type: "phone", make: mobile, context: "Contact: {}" },
  { shape: "phone.in-intl", type: "phone", make: (r) => `+91 ${mobile(r).replace(/(\d{5})(\d{5})/u, "$1 $2")}`, context: "Mobile: {}" },
  { shape: "phone.in-intl-tight", type: "phone", make: (r) => `+91${mobile(r)}`, context: "Registered mobile {} updated." },
  { shape: "phone.in-dash", type: "phone", make: (r) => `+91-${mobile(r).replace(/(\d{5})(\d{5})/u, "$1-$2")}`, context: "Ph: {}" },
  { shape: "phone.in-555", type: "phone", make: (r) => `+91 55500 0${pad(r.int(10_000), 4)}`, context: "Call me on {} after 6." },
  { shape: "phone.landline", type: "phone", make: (r) => `${r.pick(["080", "022", "020", "040", "011"])}-${r.int(9) + 2}${digitsOf(r, 3)} ${digitsOf(r, 4)}`, context: "Office: {}" },
  { shape: "phone.wa-id", type: "phone", make: (r) => `91${mobile(r)}@s.whatsapp.net`, context: "chat {} muted" },
  { shape: "email.name", type: "email", make: (r) => `${r.pick(GIVEN_F).toLowerCase()}.${r.pick(FAMILY).toLowerCase().replace(/[^a-z]/gu, "")}@example.com`, context: "Email: {}" },
  { shape: "email.digits", type: "email", make: (r) => `${r.pick(GIVEN_M).toLowerCase()}${pad(r.int(100), 2)}@example.in`, context: "mail kar de {} pe" },
  { shape: "upi.name", type: "number.payment", make: (r) => `${r.pick(GIVEN_F).toLowerCase()}.${r.pick(FAMILY).toLowerCase().replace(/[^a-z]/gu, "")}@${r.pick(UPI_SUFFIX)}`, context: "gpay kar de {} pe" },
  { shape: "upi.phone", type: "number.payment", make: (r) => `${mobile(r)}@${r.pick(["ybl", "paytm", "ibl"])}`, context: "Paid to VPA {}" },
  { shape: "bank.masked-xx", type: "number", make: (r) => `XX${last4(r)}`, context: "debited from A/c {} on 12-11-26" },
  { shape: "bank.masked-long", type: "number", make: (r) => `XXXXXXXX${last4(r)}`, context: "A/c no. {} credited" },
  { shape: "bank.masked-stars", type: "number", make: (r) => `**${last4(r)}`, context: "your account {} was debited" },
  { shape: "bank.account-word", type: "number.bank", make: (r) => `50100${digitsOf(r, 9)}`, context: "Account Number: {}" },
  { shape: "bank.account-bare", type: "number.bank", make: (r) => `${r.pick(["0012", "3291", "9180"])}${digitsOf(r, 8)}`, context: "Beneficiary: {}, IFSC below" },
  { shape: "bank.ifsc", type: "number.bank", make: (r) => `${r.pick(BANKS).ifsc}0${pad(r.int(1_000_000), 6)}`, context: "IFSC: {}" },
  { shape: "id.customer", type: "number", make: (r) => digitsOf(r, 9), context: "Customer ID: {}" },
  { shape: "id.employee", type: "number", make: (r) => `EMP${digitsOf(r, 5)}`, context: "My employee ID is {}." },
  { shape: "card.ending", type: "number", make: last4, context: "spent on your card ending {} at" },
  { shape: "card.masked-groups", type: "number", make: last4, context: "Card: XXXX XXXX XXXX {}" },
  { shape: "card.full", type: "number.card", make: (r) => r.pick(TEST_CARDS), context: "card no {} exp 09/29" },
  { shape: "tax.pan", type: "number.tax", make: (r) => pan(r), context: "PAN: {}" },
  { shape: "tax.gstin", type: "number.tax", make: (r) => `29${pan(r, "C")}1Z${alnum(r, 1)}`, context: "GSTIN {}" },
  { shape: "gov.aadhaar", type: "number.government", make: aadhaar, context: "Aadhaar: {}" },
  { shape: "gov.aadhaar-masked", type: "number", make: last4, context: "Aadhaar XXXX XXXX {} linked" },
  { shape: "gov.passport", type: "number.government", make: (r) => `${r.pick(["Z", "P", "M", "T"])}${pad(r.int(10_000_000), 7)}`, context: "Passport No: {}" },
  { shape: "gov.voter", type: "number.government", make: (r) => `${letters(r, 3)}${pad(r.int(10_000_000), 7)}`, context: "Voter ID: {}" },
  { shape: "gov.licence", type: "number.government", make: (r) => `KA01 2019${pad(r.int(10_000_000), 7)}`, context: "DL No. {}" },
  { shape: "order.amazon", type: "number.order", make: (r) => `40${r.int(9) + 1}-${digitsOf(r, 7)}-${digitsOf(r, 7)}`, context: "Order #{} has shipped" },
  { shape: "order.flipkart", type: "number.order", make: (r) => `OD${digitsOf(r, 18)}`, context: "Order ID {} delivered" },
  { shape: "order.pnr-rail", type: "number.order", make: (r) => `${r.int(9) + 1}${digitsOf(r, 9)}`, context: "PNR: {}" },
  { shape: "order.pnr-air", type: "number.order", make: (r) => (r.chance(0.5) ? letters(r, 6) : alnum(r, 6)), context: "Booking reference {}" },
  { shape: "order.awb", type: "number.order", make: (r) => digitsOf(r, 12), context: "AWB {} out for delivery" },
  { shape: "order.invoice", type: "number.order", make: (r) => `INV-2026-${pad(r.int(100_000), 5)}`, context: "Invoice no. {}" },
  { shape: "order.bare-id", type: "number.order", make: (r) => digitsOf(r, 10), context: "Your Swiggy order {} is on the way" },
  { shape: "secret.otp-before", type: "secret", make: (r) => digitsOf(r, 6), context: "{} is your OTP for login. Do not share." },
  { shape: "secret.otp-after", type: "secret", make: (r) => digitsOf(r, 6), context: "OTP: {}" },
  { shape: "secret.otp-hinglish", type: "secret", make: (r) => digitsOf(r, 6), context: "bhai otp aaya {} bata de" },
  { shape: "secret.password", type: "secret", make: (r) => `${r.pick(FAMILY).replace(/[^A-Za-z]/gu, "")}@${digitsOf(r, 4)}`, context: "password: {}" },
  { shape: "secret.wifi", type: "secret", make: (r) => `${r.pick(["home", "flat", "wifi"])}${digitsOf(r, 4)}${r.pick(["!", "#", "$"])}`, context: "wifi ka password {} hai" },
  { shape: "secret.api-key", type: "secret", make: (r) => `sk-proj-EXAMPLE${alnum(r, 24)}`, context: "OPENAI_API_KEY={}" },
  { shape: "secret.github", type: "secret", make: (r) => `ghp_EXAMPLE${alnum(r, 29)}`, context: "token: {}" },
  { shape: "account.handle-at", type: "account", make: (r) => `@${r.pick(GIVEN_F).toLowerCase()}.${r.pick(FAMILY).toLowerCase().replace(/[^a-z]/gu, "")}_${pad(r.int(100), 2)}`, context: "follow {} on insta" },
  { shape: "account.shell", type: "account", make: (r) => `${r.pick(GIVEN_M).toLowerCase()}${r.pick(FAMILY)[0]!.toLowerCase()}`, context: "{}@macbook-pro-0001:~$ ls" },
  { shape: "account.linkedin", type: "account", make: (r) => `${r.pick(GIVEN_F).toLowerCase()}-${r.pick(FAMILY).toLowerCase().replace(/[^a-z]/gu, "")}-${digitsOf(r, 3)}`, context: "linkedin.com/in/{}" },
  { shape: "account.home-folder", type: "account", make: (r) => `${r.pick(GIVEN_M).toLowerCase()}${r.pick(FAMILY)[0]!.toLowerCase()}`, context: "/Users/{}/Documents/tax" },
  { shape: "address.flat", type: "address", make: (r) => { for (;;) { const a = address(r); if (a.shape === "address.flat") return a.value; } }, context: "Deliver to: {}" },
  { shape: "address.house", type: "address", make: (r) => { for (;;) { const a = address(r); if (a.shape === "address.house") return a.value; } }, context: "Address: {}" },
  { shape: "address.short", type: "address", make: (r) => { for (;;) { const a = address(r); if (a.shape === "address.short") return a.value; } }, context: "aaja {} pe" },
  { shape: "address.landmark", type: "address", make: (r) => { for (;;) { const a = address(r); if (a.shape === "address.landmark") return a.value; } }, context: "Shipping address: {}" },
  { shape: "person.full", type: "person", make: (r) => `${r.pick(GIVEN_F)} ${r.pick(FAMILY)}`, context: "Meeting with {} at 4.", table: true },
  { shape: "person.given", type: "person", make: (r) => r.pick(GIVEN_M.filter((name) => !["Will", "Max", "Mark", "Raja", "Ram"].includes(name))), context: "{} said he'll come by 7.", table: true },
  { shape: "person.nick", type: "person", make: (r) => r.pick(NICKS), context: "{} bhai kidhar ho", table: true },
  { shape: "person.upper", type: "person", make: (r) => `${r.pick(GIVEN_M)} ${r.pick(FAMILY)}`.toUpperCase(), context: "Passenger: MR {}", table: true },
  { shape: "person.family-honorific", type: "person", make: (r) => r.pick(FAMILY), context: "{} ji ne bola tha", table: true },
  { shape: "person.initial", type: "person", make: (r) => `${r.pick(GIVEN_F)} ${r.pick(FAMILY)[0]}.`, context: "Paid by {}", table: true },
  { shape: "person.lower", type: "person", make: (r) => r.pick(GIVEN_F).toLowerCase(), context: "{} bol rahi thi kal", table: true },
];

const SHAPE = new Map(SHAPES.map((shape) => [shape.shape, shape]));
const valueOf = (r: Rng, shape: string) => SHAPE.get(shape)!.make(r);

function nameOf(r: Rng, person: Person, weights: { full: number; given?: number; nick?: number; upper?: number; family?: number; initial?: number; lower?: number }): { value: string; shape: string } {
  const options: [string, number][] = Object.entries(weights).filter(([shape]) => shape !== "nick" || person.nick !== undefined) as [string, number][];
  const total = options.reduce((sum, [, weight]) => sum + weight, 0);
  let at = r.next() * total;
  let chosen = options[0]![0];
  for (const [shape, weight] of options) {
    if ((at -= weight) < 0) { chosen = shape; break; }
  }
  switch (chosen) {
    case "given": return { value: person.given, shape: "person.given" };
    case "nick": return { value: person.nick!, shape: "person.nick" };
    case "upper": return { value: `${person.given} ${person.family}`.toUpperCase(), shape: "person.upper" };
    case "family": return { value: person.family, shape: "person.family-honorific" };
    case "initial": return { value: `${person.given} ${person.family[0]}.`, shape: "person.initial" };
    case "lower": return { value: person.given.toLowerCase(), shape: "person.lower" };
    default: return { value: `${person.given} ${person.family}`, shape: "person.full" };
  }
}

function name(w: Writer, r: Rng, person: Person, weights: Parameters<typeof nameOf>[2]): Writer {
  const { value, shape } = nameOf(r, person, weights);
  return w.d("person", shape, value, person.known);
}

const emailShape = (person: Person) => (/\d@/u.test(person.email) ? "email.digits" : "email.name");
const upiShape = (person: Person) => (/^\d/u.test(person.upi) ? "upi.phone" : "upi.name");

const phoneAs = (r: Rng, person: Person): { value: string; shape: string } => {
  switch (r.int(4)) {
    case 0: return { value: person.phone.replace(/(\d{5})(\d{5})/u, "$1 $2"), shape: "phone.in-bare" };
    case 1: return { value: person.phone, shape: "phone.in-plain" };
    case 2: return { value: `+91 ${person.phone.replace(/(\d{5})(\d{5})/u, "$1 $2")}`, shape: "phone.in-intl" };
    default: return { value: `+91${person.phone}`, shape: "phone.in-intl-tight" };
  }
};

function phone(w: Writer, r: Rng, person: Person): Writer {
  const { value, shape } = phoneAs(r, person);
  return w.d("phone", shape, value, person.known);
}

const HINGLISH = ["bhai kal milte hai", "kya scene hai aaj?", "haan done 👍", "ok bhej diya", "ghar pe hai kya?", "khana kha liya?", "kal office nahi aaunga", "traffic bahut hai yaar", "theek hai, dekhte hai", "acha sun", "abhi meeting mein hu", "paise bhej diye check kar", "kitne baje aayega?", "chal thik hai", "arre wah 😂", "sahi hai"];
const ENGLISH = ["Hope you're doing well!", "Will call you later", "Happy birthday!! 🎉", "Running late, sorry", "Sure, see you at 7", "Can you send the notes?", "Grace period ends Friday btw", "Sunny day today finally", "Mark this one as done pls", "max 2 people allowed they said", "Lucky draw results are out", "Joy of a long weekend", "Will do", "Rose day at school tomorrow", "Ram prices went up again, 16GB is so costly"];

export const ORDINARY: readonly string[] = [...HINGLISH, ...ENGLISH];

type Cast = { known: Person[]; strangers: Person[]; owner: Person };

function someone(r: Rng, cast: Cast, knownShare = 0.75): Person {
  return r.chance(knownShare) ? r.pick(cast.known) : r.pick(cast.strangers);
}

const KINDS: Record<string, (w: Writer, r: Rng, cast: Cast) => void> = {
  "sms.bank-debit": (w, r, cast) => {
    const bank = r.pick(BANKS);
    const payee = someone(r, cast, 0.6);
    w.t(`${bank.short}: Rs.${amount(r)} debited from A/c `).d("number", "bank.masked-xx", `XX${last4(r)}`).t(` on ${date(r)} to VPA `)
      .d("number.payment", upiShape(payee), payee.upi, payee.known).t(" (UPI Ref No ").o("transaction reference", digitsOf(r, 12)).t(`). Not you? Call `).o("helpline", bank.care).t(" or SMS BLOCK to ").o("helpline", "5676791").t(".");
  },
  "sms.card-spend": (w, r) => {
    const bank = r.pick(BANKS);
    w.t(`Rs ${amount(r)} spent on your ${bank.short} Bank Credit Card ending `).d("number", "card.ending", last4(r)).t(" at ").o("business", r.pick(BUSINESSES).toUpperCase())
      .t(` on ${date(r)} ${time(r)}. Avl Lmt: Rs ${amount(r)}. Not you? Call `).o("helpline", bank.care);
  },
  "sms.salary": (w, r, cast) => {
    w.t("Dear Customer, your A/c no. ").d("number", "bank.masked-long", `XXXXXXXX${last4(r)}`).t(` is credited by INR ${amount(r)} on ${date(r)} by NEFT from `)
      .o("business", r.pick(["ACME TECHNOLOGIES PVT LTD", "EXAMPLE SOFTWARE LLP", "SAMPLE RETAIL PVT LTD"])).t(". Avl Bal: INR ").t(amount(r)).t(". -").o("business", r.pick(BANKS).name);
    if (r.chance(0.3)) w.t(" Txn by ").d("person", "person.upper", `${cast.owner.given} ${cast.owner.family}`.toUpperCase(), true);
  },
  "sms.otp": (w, r) => {
    const shape = r.pick(["secret.otp-before", "secret.otp-after"]);
    const code = digitsOf(r, 6);
    if (shape === "secret.otp-before") w.d("secret", shape, code).t(` is your OTP for txn of INR ${amount(r)} at `).o("business", r.pick(BUSINESSES)).t(" on card ending ").d("number", "card.ending", last4(r)).t(". Valid for 10 mins. Do not share it with anyone.");
    else w.t(`Use OTP: `).d("secret", shape, code).t(` to log in to your `).o("business", r.pick(BUSINESSES)).t(` account. It is valid for 5 minutes. Do not share.`);
  },
  "sms.upi-received": (w, r, cast) => {
    const from = someone(r, cast);
    w.t(`Received Rs.${amount(r)} in your A/c `).d("number", "bank.masked-xx", `XX${last4(r)}`).t(" from ").d("number.payment", upiShape(from), from.upi, from.known)
      .t(` (`).d("person", "person.upper", `${from.given} ${from.family}`.toUpperCase(), from.known).t(`) on ${date(r)}. UPI Ref: `).o("transaction reference", digitsOf(r, 12)).t(".");
  },
  "mail.statement": (w, r, cast) => {
    const bank = r.pick(BANKS);
    w.t("Dear ").d("person", "person.full", `${cast.owner.given} ${cast.owner.family}`, true).t(`,\n\nYour ${bank.name} savings account statement for October 2026 is attached.\n\nAccount Number: `)
      .d("number.bank", "bank.account-word", `50100${digitsOf(r, 9)}`).t("\nIFSC: ").d("number.bank", "bank.ifsc", `${bank.ifsc}0${pad(r.int(1_000_000), 6)}`)
      .t(`\nBranch: `).o("place name", r.pick(CITIES).city).t(`\nThe password to open the PDF is the first four letters of your name and your date of birth (DDMM).\n\nCustomer ID: `).d("number", "id.customer", digitsOf(r, 9))
      .t(`\n\nFor queries call `).o("helpline", bank.care).t(".");
  },
  "mail.order-shipped": (w, r, cast) => {
    const a = address(r);
    w.t("Hi ").d("person", "person.given", cast.owner.given, true).t(",\n\nYour order #").d("number.order", "order.amazon", valueOf(r, "order.amazon")).t(" has shipped and will arrive by ")
      .t(r.pick(["Friday", "Saturday", "tomorrow"])).t(".\n\nShipping to:\n").d("person", "person.full", `${cast.owner.given} ${cast.owner.family}`, true).t("\n").d("address", a.shape, a.value)
      .t("\nPhone: ").d("phone", "phone.in-intl", `+91 ${cast.owner.phone.replace(/(\d{5})(\d{5})/u, "$1 $2")}`, true).t(`\n\nOrder total: ₹${amount(r)}\nTrack with AWB `).d("number.order", "order.awb", digitsOf(r, 12)).t(".\n\nThanks for shopping with us.\n").o("business", "Amazon.in");
  },
  "mail.order-delivered": (w, r, cast) => {
    const agent = r.pick(cast.strangers);
    w.t("Your Flipkart order ").d("number.order", "order.flipkart", valueOf(r, "order.flipkart")).t(" was delivered.\nDelivered by ").d("person", "person.given", agent.given, false)
      .t(" (").d("phone", "phone.in-plain", agent.phone, false).t(") at ").t(time(r)).t(".\nItems: 1 x boAt Airdopes 141, 1 x Decathlon water bottle 1L\nRate your delivery experience.");
  },
  "mail.food-receipt": (w, r, cast) => {
    const agent = r.pick(cast.strangers);
    w.t("Thank you for ordering from ").o("business", r.pick(["Meghana Foods", "Empire Restaurant", "Truffles", "Haldiram's"])).t(".\nOrder ID: ").d("number.order", "order.bare-id", digitsOf(r, 10))
      .t(`\nDelivered to: `).d("address", "address.short", address(r).value.split(", ").slice(0, 3).join(", ")).t(`\nYour delivery partner: `).d("person", "person.given", agent.given, false)
      .t(`\nItem total ₹${amount(r)}, delivery fee ₹35, taxes ₹${r.int(90) + 10}.\nPaid via UPI.`);
  },
  "mail.train-ticket": (w, r, cast) => {
    const pnr = `${r.int(9) + 1}${digitsOf(r, 9)}`;
    const companion = someone(r, cast);
    w.t("IRCTC E-Ticket\nPNR No.: ").d("number.order", "order.pnr-rail", pnr).t(`\nTrain No./Name: 12951 / MUMBAI RAJDHANI\nDate of Journey: ${date(r)}\nFrom: NEW DELHI (NDLS) To: MUMBAI CENTRAL (MMCT)\nPassenger Details:\n1. `)
      .d("person", "person.upper", `${cast.owner.given} ${cast.owner.family}`.toUpperCase(), true).t(` M ${r.int(30) + 22} CNF B4/${r.int(70) + 1}\n2. `)
      .d("person", "person.upper", `${companion.given} ${companion.family}`.toUpperCase(), companion.known).t(` ${r.pick(["F", "M"])} ${r.int(30) + 22} CNF B4/${r.int(70) + 1}\nTotal Fare: ₹${amount(r)}\nTransaction ID: `).o("transaction reference", `100${digitsOf(r, 9)}`);
  },
  "mail.flight": (w, r, cast) => {
    w.t("Your IndiGo booking is confirmed.\nBooking reference: ").d("number.order", "order.pnr-air", valueOf(r, "order.pnr-air")).t(`\nFlight 6E ${r.int(9000) + 100}, BLR → DEL, ${date(r)}, departs ${time(r)}\nPassenger: Mr `)
      .d("person", "person.full", `${cast.owner.given} ${cast.owner.family}`, true).t(`\nSeat ${r.int(30) + 1}${r.pick(["A", "C", "D", "F"])}\nContact: `).d("email", emailShape(cast.owner), cast.owner.email, true).t(", ").d("phone", "phone.in-dash", `+91-${cast.owner.phone.replace(/(\d{5})(\d{5})/u, "$1-$2")}`, true)
      .t("\nWeb check-in opens 48 hours before departure.");
  },
  "mail.hotel": (w, r, cast) => {
    w.t("Dear ").d("person", "person.family-honorific", cast.owner.family, true).t(" ji,\nThank you for choosing us. Your confirmation number is ").d("number.order", "order.bare-id", digitsOf(r, 10))
      .t(`.\nCheck-in: ${date(r)}, 2 PM. Guests: 2.\nInvoice no. `).d("number.order", "order.invoice", valueOf(r, "order.invoice")).t(`\nGSTIN of guest: `).d("number.tax", "tax.gstin", valueOf(r, "tax.gstin")).t("\nWarm regards,\nFront Office");
  },
  "chat.whatsapp-hinglish": (w, r, cast) => {
    const friend = someone(r, cast, 0.85);
    const other = someone(r, cast);
    const lines = 4 + r.int(5);
    for (let at = 0; at < lines; at += 1) {
      const mine = r.chance(0.5);
      w.t(`[${date(r).replace("-2026", "/26").replace(/-/gu, "/")}, ${time(r)}] `);
      if (mine) w.t("You: ");
      else name(w, r, friend, { full: 3, given: 2, nick: 2 }).t(": ");
      switch (r.int(9)) {
        case 0: name(w, r, other, { full: 1, given: 3, lower: 2, nick: 1 }).t(" ko bhi bula lena"); break;
        case 1: w.t("mera number ").call(phone, r, mine ? cast.owner : friend).t(" hai, save kar le"); break;
        case 2: { const payee = mine ? cast.owner : friend; w.t("gpay kar de ").d("number.payment", upiShape(payee), payee.upi, payee.known).t(" pe"); break; }
        case 3: w.t("bhai otp aaya ").d("secret", "secret.otp-hinglish", digitsOf(r, 6)).t(" bata de jaldi"); break;
        case 4: w.t("wifi ka password ").d("secret", "secret.wifi", valueOf(r, "secret.wifi")).t(" hai"); break;
        case 5: w.d("person", "person.family-honorific", other.family, other.known).t(" uncle ne bola tha kal aayenge"); break;
        case 6: w.t("aaja ").d("address", "address.short", address(r).value.split(", ").slice(0, 3).join(", ")).t(" pe, sab yahi hai"); break;
        default: w.t(r.pick(HINGLISH));
      }
      w.t("\n");
    }
  },
  "chat.whatsapp-english": (w, r, cast) => {
    const friend = someone(r, cast, 0.85);
    const other = someone(r, cast);
    const lines = 4 + r.int(5);
    for (let at = 0; at < lines; at += 1) {
      const mine = r.chance(0.5);
      w.t(`${time(r)} `);
      if (mine) w.t("You: ");
      else name(w, r, friend, { full: 2, given: 3, nick: 1 }).t(": ");
      switch (r.int(9)) {
        case 0: w.t("Can you send me "); name(w, r, other, { full: 2, given: 3 }).t("'s number?"); break;
        case 1: w.t("It's ").call(phone, r, other).t(", tell them I gave it"); break;
        case 2: w.t("Sending the PAN for the form: ").d("number.tax", "tax.pan", valueOf(r, "tax.pan")); break;
        case 3: { const writer = mine ? cast.owner : friend; w.t("my email is ").d("email", emailShape(writer), writer.email, writer.known); break; }
        case 4: w.t("follow ").d("account", "account.handle-at", `@${other.handle}`, other.known).t(" on insta, they post the menus"); break;
        case 5: w.t("Card no is ").d("number.card", "card.full", r.pick(TEST_CARDS)).t(" exp 09/29, use it for the tickets"); break;
        default: w.t(r.pick(ENGLISH));
      }
      w.t("\n");
    }
  },
  "screen.kyc-form": (w, r, cast) => {
    const me = cast.owner;
    const a = address(r);
    w.t("KYC Details\nFull name\n").d("person", "person.full", `${me.given} ${me.family}`, true).t(`\nDate of birth\n${pad(r.int(28) + 1, 2)}/${pad(r.int(12) + 1, 2)}/199${r.int(10)}\nPAN\n`).d("number.tax", "tax.pan", valueOf(r, "tax.pan"))
      .t("\nAadhaar\n").d("number.government", "gov.aadhaar", aadhaar(r)).t("\nMobile\n").d("phone", "phone.in-intl", `+91 ${me.phone.replace(/(\d{5})(\d{5})/u, "$1 $2")}`, true)
      .t("\nEmail\n").d("email", emailShape(me), me.email, true).t("\nAddress\n").d("address", a.shape, a.value).t("\nNominee\n");
    const nominee = someone(r, cast, 0.9);
    name(w, r, nominee, { full: 1 }).t("\nContinue   Save draft   Help");
  },
  "screen.passport-form": (w, r, cast) => {
    w.t("Passport Seva - Application Form\nGiven Name: ").d("person", "person.given", cast.owner.given, true).t("\nSurname: ").d("person", "person.family-honorific", cast.owner.family, true)
      .t("\nOld Passport No: ").d("number.government", "gov.passport", valueOf(r, "gov.passport")).t("\nVoter ID: ").d("number.government", "gov.voter", valueOf(r, "gov.voter"))
      .t("\nDriving Licence: ").d("number.government", "gov.licence", valueOf(r, "gov.licence")).t(`\nPlace of birth: `).o("place name", r.pick(CITIES).city).t("\nEmergency contact: ");
    const kin = someone(r, cast, 0.9);
    name(w, r, kin, { full: 1 }).t(", ").call(phone, r, kin).t("\nNext   Back   Save");
  },
  "screen.upi-app": (w, r, cast) => {
    const payee = someone(r, cast, 0.7);
    w.t("Payment successful\n₹").t(amount(r)).t("\nPaid to\n");
    name(w, r, payee, { full: 3, upper: 1 }).t("\n").d("number.payment", upiShape(payee), payee.upi, payee.known)
      .t("\nUPI transaction ID\n").o("transaction reference", digitsOf(r, 12)).t(`\nDebited from\n${r.pick(BANKS).name} `).d("number", "bank.masked-stars", `**${last4(r)}`)
      .t(`\n${date(r)}, ${time(r)}\nShare   Split bill   Done`);
  },
  "screen.bank-app": (w, r, cast) => {
    const bank = r.pick(BANKS);
    w.t(`${bank.name}\nGood evening, `).d("person", "person.given", cast.owner.given, true).t("\nSavings Account\n").d("number", "bank.masked-long", `XXXXXXXX${last4(r)}`)
      .t(`\nAvailable balance ₹${amount(r)}\nRecent transactions\n`);
    for (let at = 0; at < 3 + r.int(3); at += 1) {
      const who = someone(r, cast, 0.6);
      w.t(`${date(r)}  UPI/`).d("person", "person.upper", `${who.given} ${who.family}`.toUpperCase(), who.known).t("/").o("transaction reference", digitsOf(r, 12)).t(`  -₹${amount(r)}\n`);
    }
    w.t("Cards\nCredit card XXXX XXXX XXXX ").d("number", "card.masked-groups", last4(r)).t("\nHome   Pay   Invest   Profile");
  },
  "screen.contacts": (w, r, cast) => {
    w.t("Contacts   Search\n");
    for (let at = 0; at < 4 + r.int(4); at += 1) {
      const who = r.pick(cast.known);
      name(w, r, who, { full: 3, nick: 1 }).t("\n").call(phone, r, who).t(r.chance(0.3) ? "  (Work)\n" : "\n");
      if (r.chance(0.2)) w.t("Office ").d("phone", "phone.landline", valueOf(r, "phone.landline"), false).t("\n");
    }
    w.t("Favourites   Recents   Contacts   Keypad");
  },
  "screen.inbox": (w, r, cast) => {
    w.t("Inbox   Primary   Promotions\n");
    for (let at = 0; at < 4 + r.int(4); at += 1) {
      if (r.chance(0.5)) {
        const who = someone(r, cast);
        name(w, r, who, { full: 3, given: 1 }).t(`  ${r.pick(["Re: plans for Saturday", "Photos from the trip", "Rent for November", "Fwd: invitation", "Quick question"])}  ${time(r)}\n`);
      } else w.o("business", r.pick(BUSINESSES)).t(`  ${r.pick(["Your order is on the way", "Big Diwali sale is live", "Your statement is ready", "Trip receipt"])}  ${time(r)}\n`);
    }
    w.t("Compose   Mail   Meet");
  },
  "screen.terminal": (w, r, cast) => {
    const user = `${cast.owner.given.toLowerCase()}${cast.owner.family[0]!.toLowerCase()}`;
    w.t("Last login: Wed Nov 11 21:04:12 on ttys002\n").d("account", "account.shell", user).t("@macbook-pro-0001:~$ cd /Users/").d("account", "account.home-folder", user)
      .t("/projects/expense-app\n").d("account", "account.shell", user).t("@macbook-pro-0001:~/projects/expense-app$ cat .env\nOPENAI_API_KEY=").d("secret", "secret.api-key", valueOf(r, "secret.api-key"))
      .t("\nGITHUB_TOKEN=").d("secret", "secret.github", valueOf(r, "secret.github")).t("\nDB_HOST=localhost\nDB_PASSWORD=").d("secret", "secret.password", valueOf(r, "secret.password")).t("\nPORT=3000\n");
  },
  "ai.leave-letter": (w, r, cast) => {
    const manager = someone(r, cast, 0.6);
    w.t("User: Write a leave application to my manager ").d("person", "person.full", `${manager.given} ${manager.family}`, manager.known).t(". I need leave from 14 to 18 November for my sister's wedding in ")
      .o("place name", r.pick(CITIES).city).t(". My employee ID is ").d("number", "id.employee", `EMP${digitsOf(r, 5)}`).t(".\n\nAssistant: Sure. Here is a draft:\n\nDear ").d("person", "person.family-honorific", manager.family, manager.known)
      .t(" Sir,\n\nI am writing to request leave from 14 to 18 November 2026 to attend my sister's wedding. I will make sure my tasks are handed over before I leave.\n\nRegards,\n").d("person", "person.full", `${cast.owner.given} ${cast.owner.family}`, true).t("\n");
  },
  "ai.rent-message": (w, r, cast) => {
    const landlord = someone(r, cast, 0.7);
    const a = address(r);
    w.t("User: my landlord ").d("person", "person.given", landlord.given, landlord.known).t(" is asking for the rent receipt details for HRA. flat is ").d("address", a.shape, a.value)
      .t(`, rent is 32000, his PAN is `).d("number.tax", "tax.pan", valueOf(r, "tax.pan")).t(" and I pay to ").d("number.payment", upiShape(landlord), landlord.upi, landlord.known)
      .t(". can you make the receipt text\n\nAssistant: Here is a rent receipt you can use:\n\nReceived from ").d("person", "person.full", `${cast.owner.given} ${cast.owner.family}`, true).t(" a sum of ₹32,000 towards rent for the premises at ")
      .d("address", a.shape, a.value).t(" for the month of November 2026.\nLandlord: ").d("person", "person.full", `${landlord.given} ${landlord.family}`, landlord.known).t(", PAN ").d("number.tax", "tax.pan", valueOf(r, "tax.pan")).t("\n");
  },
  "ai.resume": (w, r, cast) => {
    const me = cast.owner;
    w.t("User: Fix the header of my resume:\n").d("person", "person.upper", `${me.given} ${me.family}`.toUpperCase(), true).t(" | ").d("email", emailShape(me), me.email, true).t(" | ")
      .call(phone, r, me).t(" | linkedin.com/in/").d("account", "account.linkedin", `${me.given.toLowerCase()}-${me.family.toLowerCase().replace(/[^a-z]/gu, "")}-${digitsOf(r, 3)}`)
      .t("\n\nAssistant: Here is a cleaner header:\n\n").d("person", "person.full", `${me.given} ${me.family}`, true).t("\n").d("email", emailShape(me), me.email, true).t(" · ").call(phone, r, me).t("\nWill you also want a summary line? Max two sentences works best.\n");
  },
  "ai.tax": (w, r, cast) => {
    w.t("User: I filed ITR for AY 2026-27, my PAN ").d("number.tax", "tax.pan", valueOf(r, "tax.pan")).t(", and the refund of 14,200 hasn't come. Acknowledgement number ").o("transaction reference", digitsOf(r, 15))
      .t(". My bank account ").d("number.bank", "bank.account-bare", valueOf(r, "bank.account-bare")).t(" IFSC ").d("number.bank", "bank.ifsc", valueOf(r, "bank.ifsc")).t(" is pre-validated. What should I check?\n\nAssistant: A few things to check:\n1. Your bank account must be pre-validated and linked to your PAN.\n2. Check the refund status on the e-filing portal.\n3. If it says 'refund failed', raise a refund re-issue request.\n");
    if (r.chance(0.4)) w.t("User: also my CA ").d("person", "person.full", ((stranger) => `${stranger.given} ${stranger.family}`)(r.pick(cast.strangers)), false).t(" said to mail him at ").d("email", "email.digits", valueOf(r, "email.digits")).t("\n");
  },
};

const WEIGHTS: Record<string, number> = {
  "sms.bank-debit": 4, "sms.card-spend": 3, "sms.salary": 2, "sms.otp": 3, "sms.upi-received": 3, "mail.statement": 2, "mail.order-shipped": 3, "mail.order-delivered": 2,
  "mail.food-receipt": 2, "mail.train-ticket": 2, "mail.flight": 2, "mail.hotel": 1, "chat.whatsapp-hinglish": 6, "chat.whatsapp-english": 5, "screen.kyc-form": 2,
  "screen.passport-form": 1, "screen.upi-app": 3, "screen.bank-app": 2, "screen.contacts": 2, "screen.inbox": 2, "screen.terminal": 1, "ai.leave-letter": 2,
  "ai.rent-message": 2, "ai.resume": 1, "ai.tax": 2,
};

export function generate(seed: number, details: number): { docs: BenchDoc[]; table: NameTable } {
  const r = rngOf(seed);
  const people = Array.from({ length: 400 }, (_, index) => personOf(r, index, index < 300));
  const owner = people[0]!;
  const cast: Cast = { known: people.filter((person) => person.known), strangers: people.filter((person) => !person.known), owner };
  const kinds = Object.entries(WEIGHTS).flatMap(([kind, weight]) => Array.from({ length: weight }, () => kind));
  const docs: BenchDoc[] = [];
  let written = 0;
  while (written < details) {
    const kind = r.pick(kinds);
    const w = new Writer();
    KINDS[kind]!(w, r, cast);
    docs.push({ id: `synthetic:${seed}:${pad(docs.length, 5)}`, kind, text: w.text, details: w.details, optional: w.optional });
    written += w.details.length;
  }
  const filler = Array.from({ length: 1600 }, (_, index) => personOf(r, 400 + index, true));
  const named = (person: Person): NamedPerson => ({
    who: person.who, is: "human", shown: `${person.given} ${person.family}`,
    names: [...new Set([`${person.given} ${person.family}`, person.given, ...(person.nick === undefined ? [] : [person.nick])])],
    accounts: [`+91${person.phone}`, person.email, person.upi, person.handle],
  });
  const table: NameTable = {
    version: `synthetic-${seed}`,
    owner: { who: owner.who, shown: `${owner.given} ${owner.family}` },
    people: [...cast.known, ...filler].map(named),
  };
  return { docs, table };
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
const VERHOEFF_INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

function verhoeffDigit(body: string): string {
  let check = 0;
  for (let at = 0; at < body.length; at += 1) check = VERHOEFF_D[check]![VERHOEFF_P[(at + 1) % 8]![Number(body[body.length - 1 - at])]!]!;
  return String(VERHOEFF_INV[check]);
}
