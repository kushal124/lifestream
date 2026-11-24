import type { Json } from "@lifestreamprotocol/core";
import { csvRows } from "./csv.js";
import { jsonAt, jsonPath, readJson, utf8 } from "./json.js";
import type { Member } from "./members.js";
import { matches } from "./patterns.js";
import { Refused, refuse } from "./refused.js";

/** A rule for reading the account an import came from out of one of its files. */
export type ImportAccount =
  | {
    /** The pattern, as `matches` reads it, of the JSON files the account is read from. */
    readonly file: string;
    /** A path into the file, as `jsonAt` reads it, whose values are each handed to `json` in turn, the whole file being handed when absent. */
    readonly at?: string;
    /** Reads the account from a JSON value, or answers undefined when the value names none. */
    readonly json: (json: Json) => string | undefined;
  }
  | {
    /** The pattern, as `matches` reads it, of the CSV files the account is read from. */
    readonly file: string;
    /** Reads the account from one row's fields by column name, or answers undefined when the row names none. */
    readonly row: (fields: Readonly<Record<string, string>>) => string | undefined;
  }
  | {
    /** The pattern, as `matches` reads it, of the text files the account is read from. */
    readonly file: string;
    /** Reads the account from a file's whole text, or answers undefined when it names none. */
    readonly text: (text: string) => string | undefined;
  };

/** The accounts an import's files name, or why one that was read cannot be taken. */
export type AccountsNamed =
  | {
    /** The accounts named, each spelled as a source's id spells it, sorted, and none when no rule read one. */
    readonly named: readonly string[];
  }
  | {
    /** Why an account cannot be taken: a rule refused, or what it read cannot be spelled as a source's account. */
    readonly refused: string;
  };

/** Tries each rule in turn over the members its pattern matches and returns the accounts the first rule to name any reads, or why one cannot be taken, a member that cannot be read being passed over. */
export async function accountsNamed(members: readonly Member[], rules: ImportAccount | readonly ImportAccount[]): Promise<AccountsNamed> {
  const ordered: readonly ImportAccount[] = "file" in rules ? [rules] : rules;
  for (const rule of ordered) if ("json" in rule && rule.at !== undefined) jsonPath(rule.at);
  for (const rule of ordered) {
    const named = await namedBy(members, rule);
    if ("refused" in named || named.named.length > 0) return named;
  }
  return { named: [] };
}

async function namedBy(members: readonly Member[], rule: ImportAccount): Promise<AccountsNamed> {
  const named = new Set<string>();
  try {
    for (const member of members) {
      if (!matches(rule.file, member.name)) continue;
      const read = await readMember(member, rule);
      if (read !== undefined) named.add(spelled(read));
    }
  } catch (error) {
    if (error instanceof Refused) return { refused: error.message };
    throw error;
  }
  return { named: [...named].sort() };
}

async function readMember(member: Member, rule: ImportAccount): Promise<string | undefined> {
  try {
    if ("text" in rule) return ruled(() => rule.text(utf8(member.bytes(), member.where)));
    if ("json" in rule && rule.at === undefined) {
      const json = readJson(utf8(member.bytes(), member.where), member.where);
      return ruled(() => rule.json(json));
    }
    if ("json" in rule) {
      for await (const part of jsonAt(member.chunks(), member.where, [rule.at!])) {
        const json = readJson(utf8(part.read(), part.where), part.where);
        const read = ruled(() => rule.json(json));
        if (read !== undefined) return read;
      }
      return undefined;
    }
    for await (const row of csvRows(member.chunks(), member.where)) {
      const fields = row.read();
      const read = ruled(() => rule.row(fields));
      if (read !== undefined) return read;
    }
    return undefined;
  } catch (error) {
    if (error instanceof Ruled) throw error.refusal;
    if (error instanceof Refused) return undefined;
    throw error;
  }
}

class Ruled extends Error {
  constructor(readonly refusal: Refused) {
    super(refusal.message);
  }
}

function ruled(rule: () => string | undefined): string | undefined {
  try {
    return answered(rule());
  } catch (error) {
    throw error instanceof Refused ? new Ruled(error) : error;
  }
}

function answered(read: unknown): string | undefined {
  return typeof read === "string" && read.trim() !== "" ? read : undefined;
}

export function spelled(account: string): string {
  const trimmed = account.trim();
  const once = trimmed.includes("@") ? trimmed.toLowerCase() : trimmed;
  if (once === "" || /[:/\\\0\s]/u.test(once)) refuse(`the account ${JSON.stringify(account)} cannot name a source: no colon, slash, backslash, space or NUL`);
  return once;
}
