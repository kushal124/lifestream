
/** The types of data, each by its key with the name a person sees and the icon drawn for it. */
export const TYPES = {
  "messages": { name: "Messages", icon: "message" },
  "mail": { name: "Mail", icon: "mail" },
  "calls": { name: "Calls", icon: "call" },
  "voice": { name: "Voice", icon: "voice-note" },
  "plans": { name: "Calendar", icon: "calendar-event" },
  "health": { name: "Health", icon: "health" },
  "places": { name: "Places", icon: "places" },
  "photos": { name: "Photos", icon: "photos" },
  "device-activity": { name: "Screen", icon: "screen" },
  "web": { name: "Browsing", icon: "web" },
  "ai": { name: "AI chats", icon: "ai" },
  "notes": { name: "Notes", icon: "note" },
  "listening": { name: "Listening", icon: "listening" },
  "watching": { name: "Watching", icon: "watching" },
  "money": { name: "Money", icon: "money" },
  "social": { name: "Social", icon: "people" },
  "code": { name: "Code", icon: "coding-agent" },
  "check-ins": { name: "Check-ins", icon: "check-in" },
  "contacts": { name: "Contacts", icon: "people" },
} as const satisfies Readonly<Record<string, { readonly name: string; readonly icon: string }>>;

/** The key of a type of data, as `TYPES` lists it. */
export type Type = keyof typeof TYPES;

/** A source's parts as its name spells them. */
export interface NameParts {
  /** The product as a person names it, as `whatsapp` or `google-photos`. */
  product: string;
  /** Whose data it is at the product, as an email, a phone number or a user id, or `local` when there is none. */
  account: string;
  /** Which copy is read, as a device's unit, `cloud` for the account's own copy or `export` for a download. */
  copy: string;
}

export interface SourceParts extends NameParts {
  vendor: string;
}

export interface SourceSelector {
  product?: readonly string[];
  vendor?: readonly string[];
  copy?: readonly string[];
}

export class SourceNameError extends Error {
  override name = "SourceNameError";
}

const RULE = "a source is <product>:<account>:<copy>, the product one the home knows";

/** The product, account and copy a source's name spells as `<product>:<account>:<copy>`. */
export function sourceName(id: string): NameParts {
  const parts = id.split(":");
  if (parts.length !== 3 || parts.some((part) => part === "")) throw new SourceNameError(`${JSON.stringify(id)}: ${RULE}`);
  if (/[/\\\0]/u.test(id)) throw new SourceNameError(`${JSON.stringify(id)}: a source names one directory: no slash, backslash or NUL`);
  const [product, account, copy] = parts as [string, string, string];
  return { product, account, copy };
}

export function notAProduct(id: string): SourceNameError {
  return new SourceNameError(`${JSON.stringify(id)}: ${RULE}; ${id.split(":")[0]} is not a product (no connector declares it)`);
}

export function accountOf(source: string): string {
  return source.slice(0, source.lastIndexOf(":"));
}

export function accountName(text: string): string {
  const trimmed = text.trim();
  const account = trimmed.includes("@") ? trimmed.toLowerCase() : `${trimmed.startsWith("+") ? "+" : ""}${trimmed.replace(/\D/gu, "")}`;
  if (account === "" || account === "+" || /[:/\\\0\s]/u.test(account)) {
    throw new SourceNameError(`${JSON.stringify(text)}: an account is an email address or a phone number, with no colon, slash, backslash, space or NUL`);
  }
  return account;
}

export function selects(selector: SourceSelector, parts: Pick<SourceParts, "product" | "copy"> & { vendor?: string }): boolean {
  return (selector.product === undefined || selector.product.includes(parts.product))
    && (selector.vendor === undefined || (parts.vendor !== undefined && selector.vendor.includes(parts.vendor)))
    && (selector.copy === undefined || selector.copy.includes(parts.copy));
}
