# Chrome on a Mac: `chrome:<profile>:<unit>`

**Reads** `history.sqlite`, what changed in one Chrome profile's `History`
(`kind: "changes"`): every visit, search and download the file holds is stated, table by table;
the URLs and annotations are read by lookup. A delivery from an older Mac (a whole copy, or a delta stating `after` and `through`) holds whole rows too and is read the same way, for one release more. One source per
profile folder: `Default` is `chrome:default:<unit>`, `Profile 2` is `chrome:profile-2:<unit>`
(the folder's name, lowercase, a space a hyphen). Chrome holds the file locked while the profile
is open, so the Mac clones it with its journal and settles the clone to Chrome's last commit
(`SQLiteSource.swift`, through `SQLiteHeldCopy.swift`); what changed ships every interval, because Chrome expires a
visit after about 90 days.

| Kind | Key | Content | Time |
|---|---|---|---|
| `page-visit` | `<visits.id>:<visit_time>` (`6:13434364800000123`) | `chrome.visit`: visit (every `visits` column), url (the page: `id`, `url`, `title`, `hidden`), the visit's `visit_source`, `context_annotations` and `content_annotations` rows, each null when Chrome holds none | `visit_time` to `visit_time + visit_duration`; a length under a millisecond, the instant |
| `search` | `fingerprint({keyword_id, term, url})`, `url` the search page's URL text | `chrome.search`: term (the `keyword_search_terms` row), url (the search page's whole `urls` row, its counters included) | the search page's `last_visit_time` |
| `download` | `downloads.guid` | `chrome.download`: download (every `downloads` column, `hash` as `$bytes64`), url_chain (by `chain_index`), slices (by `offset`) | `start_time` to `end_time`; no end yet, the instant it began |

- A Chrome time is microseconds since 1601-01-01 UTC. It passes 2^53, so the content keeps it as
  decimal text; the record's time is read to the millisecond. Zero is Chrome's "unset" and
  states no time.
- **Keys.** A visit's and a URL's ids are this file's own: a clear of all history recreates
  `visits`, and its ids start again at 1. A visit is named by its id and its time as Chrome
  states it, which never changes; a search by its engine, its words and its page's URL, with
  the URL's id kept in the content.
- A visit copies its own fields and the identity of the page it names, not the page's counters
  (`visit_count`, `typed_count`, `last_visit_time`): those change with every later visit of the
  page, and ride with the search. A search's time is its page's `last_visit_time`, so it moves
  when the search is made again.
- A delivery holds the visits that changed (a visit's later duration or annotation is a change),
  with the URLs and annotations they name; the searches that changed or whose page's counters
  moved, with their URLs; the downloads that changed, with their URL chains and slices.
- Chrome states no deletion: an expired or cleared visit is missing, never `gone`.
- Any column Chrome adds is copied as it stands. A file without `visits`, `urls`,
  `keyword_search_terms`, `downloads` or `downloads_url_chains`, or without a column this page
  names, is refused, naming the table or column. A delivery holding no `history.sqlite` yields no rows.

**Adapter** `chromeWeb` (adapter.ts) reads the web family's `page-visit`, `search` and `download`
for it ([web](../../../families/web/)). Chrome is a
browser a station runs in (`station: true`): a visit states the tab it was in
(`context_annotations.tab_id`) and was shown when `total_foreground_duration` is above 0. A tab open
now reads -1000000 there, so its visit is never shown until the Mac ships the row edited when the
tab closes (Ledger 5). A visit is synced when its `visit_source` is 0 or it names an
`originator_cache_guid`. What is no page reads as nothing: a core transition that is a subframe
(3, 4), a hidden URL, a hop of a redirect chain that went on (no chain end, and a chain start or a
redirect qualifier), a `chrome-extension:` URL (the station's blank page has no tab an errand
opened), and a download whose `by_ext_name` is `Lifestream`, the station's, whose row names no tab
a claim could reach. `visit` reads every visit, hop and hidden too, as its URL, its tab, and, when
its transition is a client redirect (`0x40000000`: the page moved itself), the visit it came from,
`<from_visit>:`, so the family reads a page's navigation to its own URL in the same tab, as a tab
left open does every few hours, as no new visit. A search is its words (`term.term`) and its page's
URL; a download its `target_path`'s file name, its `state` in words when it did not finish, and the last URL of its
chain. The other fields are not read: a visit's length (how long its tab stayed open, not how long
anyone looked), the page's counters, the other annotations, a download's bytes; nor content of
another type under these kinds (a Takeout's Chrome activity).

## Ledger

How the Mac keeps custody of this source: a memory of the store, per pass, holding every row sent by table, key, fingerprint and seal. `DatabaseDomainTests` in the macOS app hold each answer.

1. **Order.** None is needed: a read sends every row whose fingerprint the memory does not hold. Visits of the last 7 days (`visit_time`) go live; older ones in history pages, newest first.
2. **Reuse.** A key that comes back with other values has another fingerprint, and ships.
3. **Rebuilds.** Chrome razes and recreates a corrupt `History`, and a profile folder can be made again under the same name: a new file (its device, inode and birth time), so the memory starts again and the whole history ships. A visit keyed by `<visits.id>:<visit_time>` that comes back with a new id is a new record.
4. **Late arrivals.** A visit synced from another device gets its own new id and ships as any new row.
5. **Edits.** A visit's duration set when its tab closes, an annotation, a URL's title or counters (with the searches on it) and a download's progress each change a fingerprint, and ship. A visit keeps its URL's title as it stood when the visit shipped: a URL changed later restates no visit. A deletion by the person, and the 90-day expiry, ship nothing.
6. **Lost.** Chrome's expiry raises the lowest id every day: the visit ids between the memory's highest and the store's lowest are stated lost, once, when this Mac was away longer than the expiry.
