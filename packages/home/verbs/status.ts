import { connect } from "node:net";
import { join } from "node:path";
import type { DaySettings, JsonObject } from "@lifestreamprotocol/core";
import { HomeFile } from "../home-file.js";
import type { DoorAddress } from "../settings.js";
import { readStatus, renderStatus, type StatusReport } from "../status.js";
import { readArgs } from "./args.js";
import type { VerbContext } from "./context.js";

export async function status(ctx: VerbContext, args: readonly string[]) {
  words(args);
  const door = await probeDoor(ctx.settings.door);
  const { connectors, families } = await ctx.registry();
  const options = { folder: ctx.folder, now_ms: ctx.now(), settings: ctx.settings, connectors, families, ledger: ctx.ledger, door, stated: null, refused: [] };
  const report = new HomeFile(ctx.folder, 5_000).read((db) => readStatus(db, options)) ?? readStatus(null, options);
  return said(report, ctx.out, ctx.settings.day);
}
status.usage = "status";

export async function relayStatus(args: readonly string[], read: (route: string) => Promise<JsonObject>, out: (line: string) => void, day: DaySettings): Promise<unknown> {
  words(args);
  return said(await read("/v1/status") as unknown as StatusReport, out, day);
}

const words = (args: readonly string[]): void => void readArgs("status", args, {}, status.usage, 0);

function said(report: StatusReport, out: (line: string) => void, day: DaySettings): StatusReport {
  out(renderStatus(report, day).trimEnd());
  return report;
}

const LOOPBACK = "127.0.0.1";

async function probeDoor(address: DoorAddress): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = connect({ host: LOOPBACK, port: address.port });
    socket.setTimeout(1_000, () => {
      socket.destroy();
      resolve(`no answer on ${LOOPBACK}:${address.port} within a second`);
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve(null);
    });
    socket.once("error", (error) => resolve(`${LOOPBACK}:${address.port}: ${error.message}`));
  });
}
