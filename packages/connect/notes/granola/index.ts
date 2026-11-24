import { issuerOf, routeNamed, type Acquirer, type Adapters, type Connector, type Reader, type SignedIn } from "@lifestreamprotocol/connect/sdk";
import { notesAdapter } from "./adapter.js";
import { granolaApiAcquirer, type GranolaApiSettings } from "./api.js";
import { granola as meetings } from "./connector.js";
import { granolaMcpAcquirer, granolaMcpSignedIn, type GranolaMcpSettings } from "./mcp.js";
import { granola } from "./reader.js";

export { granola } from "./reader.js";
export { granolaApiAcquirer, type GranolaApiSettings, type GranolaApiState } from "./api.js";
export { granolaMcpAcquirer, granolaMcpSignedIn, type GranolaMcpSettings, type GranolaMcpState } from "./mcp.js";

const ISSUER = issuerOf(routeNamed(meetings, "granola-mcp", "device"));

export const contract = 3;
export const connectors: readonly Connector[] = [meetings];
export const readers: Reader[] = [granola];
export const adapters: Readonly<Record<string, Adapters>> = { [meetings.id]: { notes: notesAdapter } };
export const acquirers: {
  "granola-api": (settings: GranolaApiSettings, dependencies?: Parameters<typeof granolaApiAcquirer>[1]) => Acquirer;
  "granola-mcp": (settings: GranolaMcpSettings, dependencies?: Parameters<typeof granolaMcpAcquirer>[2]) => Acquirer;
} = {
  "granola-api": (settings, dependencies) => granolaApiAcquirer(settings, dependencies),
  "granola-mcp": (settings, dependencies) => granolaMcpAcquirer(settings, ISSUER, dependencies),
};
export const signins: Readonly<Record<string, SignedIn>> = { "granola-mcp": granolaMcpSignedIn(ISSUER) };
