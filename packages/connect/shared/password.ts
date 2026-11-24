import { SecretError, type Secrets } from "@lifestreamprotocol/core";
import { NeedsYou } from "../seams.js";

export type PasswordUse = "export" | "sign-in";

const WANTS: Readonly<Record<PasswordUse, string>> = { export: " wants your password to make your export", "sign-in": " wants your password to sign in" };
const AGAIN = "'s password needs typing again on this Mac";

export function recipeSecret(secrets: Pick<Secrets, "get">, name: string, company: string, use: PasswordUse): string {
  let value: string | undefined;
  try {
    value = secrets.get(name);
  } catch (error) {
    if (!(error instanceof SecretError)) throw error;
    if (error.reason === "other-key") throw new NeedsYou("password", `${company}${AGAIN} (${name})`, { facts: { secret: name, company, use, sealed: true }, answered: false });
    throw error;
  }
  if (value === undefined) throw new NeedsYou("password", `${company}${WANTS[use]} (${name})`, { facts: { secret: name, company, use }, answered: false });
  return value;
}
