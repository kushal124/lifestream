import { onTestFinished } from "vitest";
import type { Stations } from "../client.js";

export function closing(driver: Stations): Stations {
  const finished = (errand: { close(): Promise<void> }) => onTestFinished(() => errand.close().catch(() => undefined));
  return {
    ...driver,
    open: async (spec, place) => {
      const errand = await driver.open(spec, place);
      finished(errand);
      return errand;
    },
    using: (spec, body, place) => driver.using(spec, async (errand) => {
      finished(errand);
      return body(errand);
    }, place),
  };
}
