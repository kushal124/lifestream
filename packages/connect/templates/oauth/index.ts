import type { Acquirer, AcquirerSettings, Adapters, Client, Connector, Dependencies, Reader } from "@lifestreamprotocol/connect/sdk";
import { exampleOauthAcquirer, type ExampleOauthFields } from "./acquirer.js";
import { notes } from "./adapter.js";
import { exampleOauth as exampleOauthConnector } from "./connector.js";
import { exampleOauth } from "./reader.js";

export const contract = 3;
export const connectors: readonly Connector[] = [exampleOauthConnector];
export const readers: Reader[] = [exampleOauth];
export const adapters: Record<string, Adapters> = { "example-oauth": { notes } };
export const acquirers: Record<string, (settings: AcquirerSettings<ExampleOauthFields>, dependencies?: Dependencies) => Acquirer> = { "example-oauth": exampleOauthAcquirer };
export const clients: readonly Client[] = [{
  id: "example", name: "Example", authorize: "https://example.com/oauth/authorize", token: "https://example.com/oauth/token",
  before: ["In Example, open Settings, then Developers, and make an OAuth client.", "Copy its client id and secret here."],
}];
