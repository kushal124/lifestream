import type { Connector } from "@lifestreamprotocol/connect";
import type { ConnectorReport, Copy, DeviceRow, DeviceStream, Need } from "./streams-report.js";

type Listed = Pick<ConnectorReport, "id" | "shown" | "lead" | "line"> & {
  health: Pick<ConnectorReport["health"], "words">;
  copies: readonly (Pick<Copy, "unit" | "road" | "line"> & { health: Pick<Copy["health"], "state" | "words"> })[];
};

const FINE = new Set(["ok", "syncing"]);

export function deviceStreams(device: Pick<DeviceRow, "unit" | "kind">, connectors: readonly Listed[], needs: readonly Pick<Need, "connector" | "unit" | "words">[],
  declared: readonly Pick<Connector, "id" | "mac" | "phone">[]): DeviceStream[] {
  const blocked = new Set(declared.filter((connector) => connector[device.kind] !== undefined).map((connector) => connector.id));
  return connectors.filter((connector) => connector.shown === "stream" && blocked.has(connector.id)).flatMap((connector): DeviceStream[] => {
    const own = connector.copies.find((copy) => copy.unit === device.unit && copy.road === device.kind);
    if (own === undefined) return [];
    if (connector.copies.every((copy) => copy.unit === device.unit)) {
      return [{ id: connector.id, line: [connector.lead, connector.line].filter(Boolean).join(" · ") || connector.health.words }];
    }
    const need = needs.find((each) => each.connector === connector.id && each.unit === device.unit);
    return [{ id: connector.id, line: need?.words ?? (FINE.has(own.health.state) ? own.line : own.health.words) }];
  });
}
