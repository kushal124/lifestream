import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "@lifestreamprotocol/core";
import type { Fixture } from "../../test/drive.js";

export const UNIT = "macbook-pro-0001";
export const PEOPLE_SOURCE = `people:local:${UNIT}`;

export const PEOPLE: JsonObject[] = [
  {
    type: "people.person",
    slug: "person-b",
    name: "Person B",
    handles: [
      { kind: "email", value: "person-b@example.com", by: "agent", since: "2026-09-02T10:00:00Z" },
      { kind: "name", value: "Person B", by: "subject", since: "2026-09-01T00:00:00Z" },
      { kind: "phone", value: "+15550000002", by: "subject", since: "2026-09-03T08:30:00+05:30" },
    ],
    excluded: [{ kind: "phone", value: "+15550000009", by: "subject", since: "2026-09-02T00:00:00Z" }],
    merged_into: null,
  },
  {
    type: "people.person",
    slug: "person-c",
    name: "Person C",
    handles: [{ kind: "name", value: "Person C", by: "subject", since: "2026-09-04T12:00:00.250Z" }],
    excluded: [],
    merged_into: "person-b",
  },
];

export function peopleBytes(people: JsonObject[] = PEOPLE): Buffer {
  return Buffer.from(`${JSON.stringify({ format: "org.lifestreamprotocol.people/1", people }, null, 2)}\n`);
}

export const peopleFixture: Fixture = (folder) => {
  writeFileSync(join(folder, "people.json"), peopleBytes());
  return {
    source: PEOPLE_SOURCE, facts: { fetched_at: "2026-09-07T04:00:00Z" }, files: { "people.json": "trust" },
    heads: [
      "person person-b", "person person-c",
    ],
  };
};
