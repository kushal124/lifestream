import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHome, openHomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import { physicalFamily } from "@lifestreamprotocol/families";
import { drain, driveBacklog, physicalBacklog, readFixes, summary } from "./backlog.js";
import { RELEASE_FED } from "./fed.js";

const physical = physicalFamily({ photos: RELEASE_FED.photos })(RELEASE_FED.physical);

const scale = Number(process.argv[2] ?? "1");
if (!(scale > 0)) throw new Error("usage: measure-extract-cost.ts [scale > 0] [artifact.json]");
const dir = mkdtempSync(join(tmpdir(), "lifestream-measure-extract-cost-"));
const out = process.argv[3] ?? join(tmpdir(), `lifestream-extract-cost-${Date.now()}.json`);

function open(name: string) {
  const at = mkdtempSync(join(dir, `${name}-`));
  const db = openHome(openHomeFolder(at), "migrate");
  return { db, reader: openHome(openHomeFolder(at), "read"), blobs: openHomeFolder(at).blobs(join(at, "blobs")) };
}

try {
  const drive: Record<string, JsonObject> = {};
  for (const hours of [6 * scale, 24 * scale]) {
    const { db, reader, blobs } = open(`drive-${hours}h`);
    const rows = driveBacklog(db, hours);
    const drained = await drain(db, reader, blobs, physical);
    reader.close();
    db.close();
    drive[`${hours}h`] = { rows, ...summary(drained) };
  }
  const phone: Record<string, JsonObject> = {};
  for (const days of [2 * scale, 8 * scale].map(Math.round)) {
    const { db, reader, blobs } = open(`phone-${days}d`);
    const rows = physicalBacklog(db, days, true);
    const drained = await drain(db, reader, blobs, physical);
    reader.close();
    db.close();
    phone[`${days}d`] = { rows, ...summary(drained) };
  }
  const { db, reader } = open("range-read");
  physicalBacklog(db, 4);
  const view = reader.view();
  const range = { day: readFixes(view, 1), days: readFixes(view, 4) };
  view.close();
  reader.close();
  db.close();
  const per = (measured: Record<string, JsonObject>) => Object.values(measured).map((each) => each.ms_per_50k_statements as number);
  const [shortDrive, longDrive] = per(drive);
  const [fewDays, manyDays] = per(phone);
  const ratios = {
    drive_long_over_short_per_statement: longDrive! / shortDrive!,
    phone_many_over_few_per_statement: manyDays! / fewDays!,
    range_four_days_over_one: range.days.ms / range.day.ms,
  };
  writeFileSync(out, `${JSON.stringify({ scale, drive, phone, range, ratios }, null, 1)}\n`);
  console.log(JSON.stringify(ratios));
  console.log(`artifact: ${out}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
