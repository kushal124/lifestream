import type { MacStore } from "@lifestreamprotocol/connect/sdk";

export const store = {
  feeder: "chrome-mac",
  name: "chrome",
  held: "~/Library/Application Support/Google/Chrome/<account>/History",
  account: {
    folders: "~/Library/Application Support/Google/Chrome",
    holding: "History",
    match: "^(Default|Profile [0-9]+)$",
    spell: "lower-hyphen",
  },
  spelled: false,
  engine: {
    kind: "sqlite",
    stores: [
      {
        identity: "file",
        member: "history.sqlite",
        path: "~/Library/Application Support/Google/Chrome/<account>/History",
        tables: [
          {
            key: "id",
            name: "visits",
            role: { main: { rows: "visits", time: "NULLIF(visit_time, 0) / 1000000 - 11644473600" } },
            touched_by: [
              [
                "visit_source",
                "SELECT id AS k FROM visit_source WHERE id IN (SELECT t_key FROM temp.touched WHERE t_name = 'visit_source')",
              ],
              [
                "context_annotations",
                "SELECT visit_id AS k FROM context_annotations WHERE visit_id IN (SELECT t_key FROM temp.touched WHERE t_name = 'context_annotations')",
              ],
              [
                "content_annotations",
                "SELECT visit_id AS k FROM content_annotations WHERE visit_id IN (SELECT t_key FROM temp.touched WHERE t_name = 'content_annotations')",
              ],
            ],
          },
          {
            keep: "id IN (SELECT id FROM visits)",
            key: "id",
            name: "visit_source",
            role: "follows",
            when_declared: true,
          },
          {
            keep: "visit_id IN (SELECT id FROM visits)",
            key: "visit_id",
            name: "context_annotations",
            role: "follows",
            when_declared: true,
          },
          {
            keep: "visit_id IN (SELECT id FROM visits)",
            key: "visit_id",
            name: "content_annotations",
            role: "follows",
            when_declared: true,
          },
          {
            key: "rowid",
            name: "keyword_search_terms",
            role: "changes",
            touched_by: [
              [
                "urls",
                "SELECT rowid AS k FROM keyword_search_terms WHERE url_id IN (SELECT t_key FROM temp.touched WHERE t_name = 'urls')",
              ],
            ],
          },
          {
            keep: "id IN (SELECT url FROM visits UNION SELECT url_id FROM keyword_search_terms)",
            key: "id",
            name: "urls",
            role: "follows",
          },
          {
            key: "id",
            name: "downloads",
            role: "changes",
            touched_by: [
              [
                "downloads_url_chains",
                "SELECT id AS k FROM downloads_url_chains WHERE rowid IN (SELECT t_key FROM temp.touched WHERE t_name = 'downloads_url_chains')",
              ],
              [
                "downloads_slices",
                "SELECT download_id AS k FROM downloads_slices WHERE rowid IN (SELECT t_key FROM temp.touched WHERE t_name = 'downloads_slices')",
              ],
            ],
          },
          { keep: "id IN (SELECT id FROM downloads)", key: "rowid", name: "downloads_url_chains", role: "follows" },
          {
            keep: "download_id IN (SELECT id FROM downloads)",
            key: "rowid",
            name: "downloads_slices",
            role: "follows",
            when_declared: true,
          },
        ],
      },
    ],
  },
} satisfies MacStore;
