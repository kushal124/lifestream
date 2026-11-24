import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Fixture } from "../../../test/drive.js";
import { photosFixture } from "../../../ios-app/phone.test-support.js";

const SOURCE = "apple-photos:person-a@example.com:macbook-pro-0001";
const MODIFIED = "2026-10-03T08:41:05.1234510+05:30";
const LOCALS = [1, 2, 3].map((index) => `CCCCCCCC-0000-4000-8000-00000000000${index}/L0/001`);

const line = (local: string): string =>
  JSON.stringify({
    kind: "asset",
    observed_at: "2026-10-03T09:30:00.5+05:30",
    payload: {
      local_identifier: local, cloud_identifier: `${local.slice(0, 36)}:001:synthetic`, modification_date: MODIFIED, creation_date: "2026-10-03T03:10:00.5Z",
      media_type: "image", media_subtypes: 0, pixel_width: 4032, pixel_height: 3024, location: null, favorite: false, hidden: false,
      resources: [{ type: "photo", type_raw: 1, uti: "public.heic", original_filename: "IMG_0001.HEIC", blob: null, not_local: true }],
    },
  });

export const fixture: Fixture = (folder) => {
  writeFileSync(join(folder, "photos.jsonl"), LOCALS.map((local) => `${line(local)}\n`).join(""));
  const heads = LOCALS.map((local) => `img ${local}:20261003T031105.123451Z`);
  return { source: SOURCE, facts: { snapshot_taken_at: "2026-10-03T05:00:00Z" }, files: { "photos.jsonl": { alone: heads, prefix: heads.slice(0, 1) } } };
};

export const fixtures: Readonly<Record<string, Fixture>> = {
  "photos-ios-bundle": photosFixture,
  "photos-mac-bundle": fixture,
};
