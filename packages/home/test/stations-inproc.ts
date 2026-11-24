import { chromeSites, declarations, siteOrigins } from "@lifestreamprotocol/connect";
export { serveStations } from "../stations.js";

export function declaredSites() {
  return chromeSites(declarations()).map((site) => ({
    id: site.id, name: site.name, origin: site.origin, origins: siteOrigins(site), ...(site.form ? { form: true } : {}),
  }));
}
