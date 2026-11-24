# Google My Activity: `<product>:<account>:export`

**Reads** a Google Takeout of My Activity: one `MyActivity.json` per product folder under
`Takeout/My Activity/`, each a JSON array of entries, and the files the entries name beside it;
or, exported as HTML (Takeout's default), one `MyActivity.html` per folder, the same entries
rendered (below). A folder holding both is read from its JSON, which holds more. A delivery holds the Takeout's ZIPs (every part), or their members extracted
(any path ending in `Takeout/My Activity/<folder>/<file>`). A file inside a Takeout product
folder (`Takeout/<product>/...`) is already an extracted member, ZIP-based attachments such as
`.docx` and `.xlsx` included; unrelated extracted members are not read. Every other file, a part
at `Takeout/<part>.zip` among them, is sniffed for an outer ZIP by its first bytes
(`shared/members.ts`), whatever its name, a gzipped tar (`.tgz`) as a ZIP is. It arrives as a
Takeout the person downloads and drops on its window, which the Mac sends as an import's delivery:
the home's listing routes each My
Activity folder to its product's source, and the reader reads only the files the listing gives it.
Nothing polls it and it is no site of the popup (no `chrome` block): the person makes the Takeout at
Google by the kind's guide and hands the files over. Its stream (connector `google`, product `google-takeout`)
is named **Google activity** on every page (its declaration's `name`), never Google Takeout, which is the
export it comes in (connect/imports/google-takeout).

**Consumed.** Once every row of an import file it reads is landed and none was refused, the
reader states the file consumed (core's `consumed` row, `shared/members.ts` `consuming`): the
home lets the file go at its next sweep (home `imports.ts`).

One delivery feeds one source per product, each on the same lane, and each reads only its own
folders. A delivery that holds none of them states nothing for that source. Connector
`google-my-activity`.

| Source | Folders |
|---|---|
| `google-search:<email>:export` | Search, Image Search, Video Search, AI Mode, Google Lens |
| `youtube:<email>:export` | YouTube |
| `google-maps:<email>:export` | Maps |
| `chrome:<email>:export` | Chrome |
| `gemini:<email>:export` | Gemini Apps |
| `gmail-activity:<email>:export` | Gmail |
| `android:<email>:export` | Android |
| `google-<name>:<email>:export` | Ads, Assistant, Books, Developers, Discover, Drive, Flights, Help, Hotels, Shopping, Takeout, Travel, Voice Match, and each `Google <name>` folder: `google-ads`, `google-assistant`, `google-books`, `google-developers`, `google-discover`, `google-drive`, `google-flights`, `google-help`, `google-hotels`, `google-shopping`, `google-takeout`, `google-travel`, `google-voice-match`, `google-analytics`, `google-arts-culture`, `google-business-profile`, `google-play` (Google Play Store), `google-play-games`, `google-play-movies` (Google Play Movies & TV), `google-store`, `google-translate`, `google-tv` |
| `google-news:<email>:export` | Google News, News |

The five search folders are one product: every entry of theirs is a Google search under the
Search activity control, linking to google.com's search in one of its modes (images, videos,
AI Mode, Lens). The Google Pay folder is never read, and a folder outside the table is read by
no source.

Gmail's folder is `gmail-activity`, not `gmail`: `gmail:<email>:cloud` is the mailbox, which
Mail's `.mbox` files and Gmail's IMAP poll both feed ([gmail.md](../../mail/gmail/gmail.md)).

## Kinds, keys, content, time

| Kind | Key | Content | Time |
|---|---|---|---|
| the title's verb's (below) | `fingerprint({time, header, title, titleUrl})` (`shared/fingerprint.ts`: `sha256:` + the digest of the canonical JSON), `time` the instant to the second in UTC (`2026-10-27T10:00:12Z`, whatever fraction the JSON states); `titleUrl` left out when the entry states none | `{type: "google.activity", ...every member of the entry, blobs?}` | `time`: the JSON's UTC, to the millisecond or second as stated, the string kept in the content; the HTML's local text, read to the second, its content's `time` that instant as the JSON spells one (`2026-10-27T10:00:12Z`) and `stated` the page's text |

**One key for both formats** (the owner's ruling, 27 October 2026): an entry brought in as HTML and
again as JSON is one record, its HTML content and its JSON content versions of it. Takeout's default
is HTML, which states seconds, so a JSON key to the millisecond would double the common case, a
person who took the default and later chose JSON; on the owner's HTML export (277,798 entries) a
key to the second joined 85 entries whose bodies differ. Two entries of a folder that share the four fields are one record:
Takeout writes some whole entries twice, and repeats some a fraction of a second apart; their rows
are one record stated twice. A home that landed JSON before the key was to the second re-keys its
records once with `key-repair.ts`, through `lifestream repair`, once per
source: each record whose time carries a fraction moves to its key to the second, its content,
time and blobs as they stand; where two come to one key, the first takes it and the others go.

## HTML

`MyActivity.html` is one page, a cell per entry (`<div class="outer-cell …">`), read a cell at a
time whatever its size. A cell's header cell holds the `header`; its body cell the title line, a
line per subtitle and the time, split by `<br>` (a Gemini Apps or AI Mode cell's answer follows the
time as a `<p>` line: the time is found by its shape, never its place); its caption cell
`Products:` and a line per product. The entry it reads is `header`, `title` (the title line's text: the `&nbsp;` Takeout
joins a verb to its link with is the JSON title's space), `titleUrl` (the title's link),
`subtitles` (each line between: `name`, and `url` where it links), `time` (the instant, as the JSON
spells one: RFC 3339 in UTC, to the second), `stated` (the page's own text of the time),
`safeHtmlItem` (what follows the time, as the page's HTML, `[{html}]`) and `products` where the
caption lists them. It states no `details`, `locationInfos`, `activityControls` or attachments:
the page renders none of them as data. Measured
on the owner's HTML export of 27 October 2026: the time is local text to the second in the account's
display zone, `Oct 27, 2026, 3:30:12 PM IST`, a narrow no-break space (U+202F) before AM or PM,
the zone's abbreviation on every entry, no fraction. It is read in the home's day zone, the
delivery's fact `zone` (which the home owes an import delivery's reader: home `imports.ts`
`readerFacts`; a page whose delivery states none is refused): the instant whose wall clock it is
there and whose abbreviation there, at that instant, is the one stated, standard or daylight, as
one of a named list of English locales names it (en-US, en-GB, en-IN, en-AU, en-CA, en-NZ, en-IE,
en-ZA, en-SG, grown when a measured export needs another: `IST`; `PDT` and `PST` in an overlap,
which they tell apart; `GMT+5:30` where a locale has no name) (`shared/delivery.ts`
`abbreviatedInstantOf`).

**The kind is the entry's verb, the first word of its title.**

| Verb | Kind | Where |
|---|---|---|
| `Searched` | `search` | every product |
| `Visited` | `page-visit` | every product |
| `Watched` | `watch` | every product (YouTube, Video Search, Google TV) |
| `Directions` | `directions` | every product (Maps) |
| `Viewed` | `place-view` | Maps only (`Viewed area around …`, `Viewed area in Google Maps`) |
| `Prompted` | `msg` | Gemini only: a request the person sent |
| `Subscribed` | `follow` | YouTube only |
| `Liked` | `like` | YouTube only |
| every other first word | `activity` | e.g. `Used`, `Viewed` outside Maps, `Dismissed`, `Received`, `Explored`, `Said`, `Shared`, `Read`, `Opened`, `Saw`, `Translated`, `Defined`, `Launched`, `Displayed`, `Created`, `Called`, `Started`, `Joined`, `Trained`, `Initiated`, `Played`, `Downloaded`, `Interacted`, `Set`, `Selected`, `Voted`, `Disliked`, `Pre-registered`, `Rented`, `Saved`, `Made`, `Tracked`, `Confirmed`, `Bookmarked`, `Clicked`, `Sent`, `Asked`, `Submitted`, `Activated`; and titles with no verb: a place's name (Maps), a count (`3 notifications`, `21 cards in your feed`), a link (Help) |

## Attachments

The files an entry names in `attachedFiles`, `imageFile` and `audioFiles` are found in its own
folder and become the record's blobs: `blobs` lists each once, as
`{hash, bytes, media_type, role: "attachment", file}`, `file` the member it is. A ZIP member is
stored, never read whole (`shared/members.ts` `stored`): hashed in chunks as it is read, its
`hash` the SHA-256 of its bytes, and handed to the home by stream with the row
(`ReaderOutput.streamed`), so an attachment of any size lands; an extracted member is the delivery's
own file. Takeout names some uploads `.png` and writes them `.jpg`: a name the folder does not
hold is the one member whose name differs from it only in its extension. A name that matches
none, or several, stays a name. The entry keeps every name as it states it.

## Refused

Each part alone, named in the run's refusals (a row of kind `file`), while the rest lands. A file
whose first bytes are a zip's and which cannot be listed, by its path. A folder that holds neither
`MyActivity.json` nor `MyActivity.html`, or one member twice (a ZIP and its extraction together),
by its folder. A page whose delivery states no `zone` (or one the runtime does not know), that is
not an HTML page, or not UTF-8, by its path; one not closed by `</html>` (cut short) keeps the
entries before the cut, and is refused after them; a cell over 16 MiB likewise. A cell with no
header, title or time, a time spelled otherwise, or an abbreviation the home's zone does not have
at that wall clock (another zone's, one out of season, any in a gap), by its place
(`<file>[<index>]`). An entry that is not an object, states no
`time`, `header` or `title`, has a `time` that is not a UTC instant ending in `Z`, or states a
`type` or `blobs` member, by its place (`<file>[<index>]`). A folder's array that is not closed or
not UTF-8 JSON keeps the entries before the break, and its folder is refused after them. The
source must be `<product>:<account>:export`; a product not above states nothing (a home may still
hold a source named for a product before its folder moved, such as `gmail` before
`gmail-activity`). A row alone, counted, when its content breaks
the guard: `products` a non-empty list of strings (an HTML entry's only where stated); `titleUrl`, `description`, `imageFile`
strings; `activityControls`, `attachedFiles`, `audioFiles` lists of strings; `subtitles`,
`details`, `locationInfos`, `safeHtmlItem` lists of objects of strings. A member Takeout adds
later is kept as it is.

Nothing is ever `gone`: an entry a later Takeout lacks stays.
