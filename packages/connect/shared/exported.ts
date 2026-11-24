import { sourceName, type Delivery } from "@lifestreamprotocol/core";

/** Whether a delivery belongs to its source's account: it states no `account` fact, or one equal to the source's account in any case. */
export function forThisAccount(delivery: Delivery): boolean {
  const account = delivery.facts.account;
  return typeof account !== "string" || account.toLowerCase() === sourceName(delivery.source).account.toLowerCase();
}
