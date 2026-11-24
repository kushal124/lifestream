import type { IncomingMessage } from "node:http";
import type { Connector } from "@lifestreamprotocol/connect";
import type { JsonObject } from "@lifestreamprotocol/core";
import type { Act } from "./door.js";
import type { Principal } from "./principals.js";
import { refuse } from "./refusal.js";

const ROUTES: Readonly<Record<string, string>> = {
  "/v1/signin/key": "account-connect",
  "/v1/signin/device/start": "device-start",
  "/v1/signin/device/poll": "device-poll",
  "/v1/signin/client/start": "client-start",
  "/v1/signin/client/finish": "client-finish",
};

const MEMBERS: Readonly<Record<string, readonly string[]>> = {
  "account-connect": ["values"],
  "device-start": [],
  "device-poll": ["attempt", "interval_ms"],
  "client-start": ["client", "port"],
  "client-finish": ["attempt", "address"],
};

export const isSignInRoute = (pathname: string): boolean => Object.hasOwn(ROUTES, pathname);

export interface SignInDoor {
  connectors: readonly Connector[];
  homeUnit(): string;
  body(request: IncomingMessage): Promise<JsonObject>;
  relay(request: JsonObject, act: Act, http: IncomingMessage): Promise<unknown>;
}

export function signinRoutes(door: SignInDoor): (principal: Principal, pathname: string, request: IncomingMessage) => Promise<[number, JsonObject]> {
  return async (principal, pathname, request) => {
    if (principal.kind !== "mac" && principal.kind !== "phone") {
      refuse(403, "PRINCIPAL_SCOPE", `pass ${principal.id} is no device's: a sign-in is made on a Mac or a phone`);
    }
    const verb = ROUTES[pathname]!;
    const body = await door.body(request);
    const { connector, route } = body;
    if (typeof connector !== "string" || typeof route !== "string") refuse(422, "BAD_REQUEST", "a sign-in names a connector and its route");
    if (!door.connectors.some((each) => each.id === connector)) refuse(403, "PRINCIPAL_SCOPE", `the home declares no connector ${connector}`);
    const asked: JsonObject = { verb, connector, route };
    for (const member of MEMBERS[verb]!) if (body[member] !== undefined) asked[member] = body[member]!;
    if (verb === "client-start") asked.local = principal.kind === "mac" && principal.unit === door.homeUnit();
    const answer = await door.relay(asked, "POST /v1/signin/<way>", request);
    return [200, answer as JsonObject];
  };
}
