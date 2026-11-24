import { PLACES, writePrepared } from "../prepared.js";
import { PRESENCE_META, presenceOver, type Presence, type PresenceSource, type PresenceTables } from "../presence.js";
import { openHomeFolder } from "@lifestreamprotocol/core";
import { dirname } from "node:path";

export function presenceSource(file: string): PresenceSource {
  let last: Presence | undefined;
  return { file, held: (version, load) => last?.version === version ? last : (last = presenceOver({ ...load(), version })) };
}

export function writePresenceFile(file: string, tables: PresenceTables, position = "1"): void {
  writePrepared(openHomeFolder(dirname(file)), file, PLACES, {
    rows: new Map(), position, meta: { [PRESENCE_META]: tables.version },
    own(db) {
      const removed = ["area", "presence", "placed"].reduce((sum, table) => sum + db.prepare(`DELETE FROM ${table}`).run().changes, 0);
      const area = db.prepare("INSERT INTO area (id, place, city, city_id, region, country, country_code, zone) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
      for (const each of tables.areas) area.run(each.id, each.place, each.city, each.city_id, each.region, each.country, each.country_code, each.zone);
      const piece = db.prepare("INSERT INTO presence (start_ms, end_ms, known, guessed, zone, accounts) VALUES (?, ?, ?, ?, ?, ?)");
      for (const [start_ms, end_ms, known, guessed, zone, accounts] of tables.pieces) piece.run(start_ms, end_ms, known, guessed, zone, accounts.join("\x1e"));
      const placed = db.prepare("INSERT INTO placed (day, area, guessed) VALUES (?, ?, ?)");
      for (const [day, at, guessed] of tables.placed) placed.run(day, at, guessed ? 1 : 0);
      return { written: tables.areas.length + tables.pieces.length + tables.placed.length, removed };
    },
  });
}
