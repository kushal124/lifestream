import type { JsonObject } from "@lifestreamprotocol/core";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Fixture, Spoiled } from "../../../test/drive.js";
import { writeZip } from "../../../test/drive.js";
import { entryKey, kindOf } from "../reader.js";

export const ACCOUNT = "person-a@example.com";
export const source = (product: string): string => `${product}:${ACCOUNT}:export`;
export const ROOT = "Takeout/My Activity";
export const EXPORTED_AT = "2026-09-10T12:00:00.000Z";
export const LATER_AT = "2026-10-01T12:00:00.000Z";
export const ZONE = "America/New_York";
export const ABBREVIATION = "EDT";

const SEARCH_CONTROL = ["Search Services History"];
const APP_CONTROL = ["Web & App Activity"];
const YOUTUBE_CONTROL = ["YouTube watch history"];

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("synthetic jpeg 0001")]);
const JPEG_2 = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("synthetic jpeg 0003")]);
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.from("synthetic voice 0001")]);

export const ATTACHMENTS = { jpeg: JPEG, jpeg2: JPEG_2, mp3: MP3 };

export function folders(version: "first" | "later"): Record<string, JsonObject[]> {
  const watched: JsonObject = {
    header: "YouTube", title: "Watched Example video one", titleUrl: "https://www.youtube.com/watch?v=example0001",
    subtitles: [{ name: version === "first" ? "Example Channel" : "Example Channel Renamed", url: "https://www.youtube.com/channel/UC000000000000000000001" }],
    time: "2026-09-02T18:30:00.250Z", products: ["YouTube"], activityControls: YOUTUBE_CONTROL,
  };
  const visited: JsonObject = {
    header: "Search", title: "Visited Example page", titleUrl: "https://www.google.com/url?q=https://example.com/page",
    time: "2026-09-01T08:00:05.456Z", products: ["Search"], activityControls: SEARCH_CONTROL,
  };
  const shared: JsonObject = { header: "example.com", title: "Visited Example shop", titleUrl: "https://example.com/shop", time: "2026-09-03T10:00:00.000Z", activityControls: APP_CONTROL };
  return {
    Search: [
      {
        header: "Search", title: "3 notifications", subtitles: [{ name: "Including topics:" }, { name: "Example topic - dismissed" }],
        time: "2026-09-01T09:30:00.000Z", products: ["Search"], activityControls: SEARCH_CONTROL,
      },
      { header: "Search", title: "Used Search", time: "2026-09-01T09:00:00Z", products: ["Search"], activityControls: SEARCH_CONTROL },
      {
        header: "Search", title: "Viewed Example Cafe", titleUrl: "https://local.google.com/place?id=1000000000000000001&use=srp",
        time: "2026-09-01T08:10:00.000Z", products: ["Search"], activityControls: SEARCH_CONTROL,
      },
      ...(version === "first" ? [visited] : []),
      {
        header: "Search", title: "Searched for example query", titleUrl: "https://www.google.com/search?q=example+query",
        time: "2026-09-01T08:00:00.123Z", products: ["Search"], activityControls: SEARCH_CONTROL,
        locationInfos: [{ name: "At this general area", url: "https://www.google.com/maps/@?api=1&map_action=map&center=0.000001,0.000001&zoom=12", source: "From your device", sourceUrl: "https://support.google.com/websearch/answer/0000001" }],
      },
    ],
    "Image Search": [
      {
        header: "Image Search", title: "Searched for example image", titleUrl: "https://www.google.com/search?q=example+image&tbm=isch",
        time: "2026-09-01T08:20:00.000Z", products: ["Image Search"], activityControls: SEARCH_CONTROL,
      },
    ],
    "Video Search": [
      {
        header: "youtube.com", title: "Watched Example clip", titleUrl: "https://www.youtube.com/watch?v=example0002",
        time: "2026-09-01T08:25:00.000Z", products: ["Video Search"], activityControls: SEARCH_CONTROL,
      },
    ],
    "AI Mode": [
      {
        header: "AI Mode", title: "Searched for example question", titleUrl: "https://www.google.com/?q=example+question&udm=50",
        time: "2026-09-01T08:30:00.000Z", products: ["AI Mode"], activityControls: SEARCH_CONTROL, safeHtmlItem: [{ html: "<p>An example answer.</p>" }],
      },
    ],
    "Google Lens": [{ header: "Google Lens", title: "Searched with Google Lens", time: "2026-09-01T08:35:00Z", products: ["Google Lens"], activityControls: SEARCH_CONTROL }],
    YouTube: [
      { header: "YouTube", title: "Disliked Example video two", titleUrl: "https://www.youtube.com/watch?v=example0003", time: "2026-09-02T19:10:00.000Z", products: ["YouTube"], activityControls: YOUTUBE_CONTROL },
      { header: "YouTube", title: "Liked Example video one", titleUrl: "https://www.youtube.com/watch?v=example0001", time: "2026-09-02T19:05:00.000Z", products: ["YouTube"], activityControls: YOUTUBE_CONTROL },
      {
        header: "YouTube", title: "Subscribed to Example Channel", titleUrl: "https://www.youtube.com/channel/UC000000000000000000001",
        time: "2026-09-02T19:00:00Z", products: ["YouTube"], activityControls: YOUTUBE_CONTROL,
      },
      { header: "YouTube", title: "Searched for example song", titleUrl: "https://www.youtube.com/results?search_query=example+song", time: "2026-09-02T18:45:00.000Z", products: ["YouTube"], activityControls: YOUTUBE_CONTROL },
      watched,
      watched,
      {
        header: "YouTube Music", title: "Watched Example video one", titleUrl: "https://www.youtube.com/watch?v=example0001",
        time: "2026-09-01T07:00:00.000Z", products: ["YouTube"], activityControls: YOUTUBE_CONTROL, details: [{ name: "From Google Ads" }],
      },
    ],
    Maps: [
      ...(version === "later" ? [{ header: "Maps", title: "Searched for example bakery", titleUrl: "https://www.google.com/maps/search/example+bakery/@0.1,0.2,15z", time: "2026-09-20T09:00:00.000Z", products: ["Maps"], activityControls: APP_CONTROL }] : []),
      { header: "Maps", title: "Explored on Google Maps", time: "2026-09-04T09:40:00.000Z", products: ["Maps"], activityControls: APP_CONTROL },
      {
        header: "Maps", title: "Example Cafe", titleUrl: "https://maps.google.com?q=Example%20Cafe,%201%20Example%20Road&ftid=0x0:0x1",
        time: "2026-09-04T09:30:00.000Z", products: ["Maps"], activityControls: APP_CONTROL,
      },
      {
        header: "Maps", title: "Directions to Example Station", titleUrl: "https://www.google.com/maps/dir//Example+Station/@0.1,0.2,13z",
        description: "Current location\nExample Station", time: "2026-09-04T09:20:00.000Z", products: ["Maps"], activityControls: APP_CONTROL,
      },
      { header: "Maps", title: "Searched for example cafe", titleUrl: "https://www.google.com/maps/place/Example+Cafe/@0.1,0.2,17z", time: "2026-09-04T09:10:00.000Z", products: ["Maps"], activityControls: APP_CONTROL },
      { header: "Maps", title: "Viewed area around Example Town", titleUrl: "https://www.google.com/maps/@0.1,0.2,9000a,30y", time: "2026-09-04T09:00:00.000Z", products: ["Maps"], activityControls: APP_CONTROL },
    ],
    Chrome: [
      { header: "Chrome", title: "Used Chrome", time: "2026-09-05T10:05:00.000Z", products: ["Chrome"] },
      { header: "example.com", title: "Visited Example Domain", titleUrl: "https://example.com/", time: "2026-09-05T10:00:00.000Z", products: ["Chrome"], activityControls: APP_CONTROL },
    ],
    "Gemini Apps": [
      { header: "Gemini Apps", title: "Created Gem Example helper", time: "2026-09-06T11:10:00.000Z", products: ["Gemini Apps"], activityControls: ["Gemini Apps Activity"] },
      {
        header: "Gemini Apps", title: "Prompted Describe this photo", time: "2026-09-06T11:05:00.000Z", products: ["Gemini Apps"], activityControls: ["Gemini Apps Activity"],
        attachedFiles: ["photo-0000000000000003.jpg"], subtitles: [{ name: "Attached 1 file." }], safeHtmlItem: [{ html: "<p>A synthetic photo.</p>" }],
      },
      {
        header: "Gemini Apps", title: "Prompted What is in these pictures?", time: "2026-09-06T11:00:00.000Z", products: ["Gemini Apps"], activityControls: ["Gemini Apps Activity"],
        attachedFiles: ["image-0000000000000001.png", "image-0000000000000002.png"], imageFile: "image-0000000000000001.png",
        subtitles: [{ name: "Attached 2 files." }, { name: "-  image-0000000000000001.png" }], details: [{ name: "Gemini Apps" }],
        safeHtmlItem: [{ html: "<p>Two synthetic pictures.</p>" }],
      },
    ],
    "Voice Match": [
      { header: "Voice Match", title: "Trained voice model", time: "2026-09-07T06:00:00.000Z", audioFiles: ["2026-09-07_06_00_00_000_UTC.mp3"], products: ["Voice Match"], details: [{ name: "Started by hotword" }] },
    ],
    Ads: [{ ...shared, products: ["Ads"] }],
    "Google Analytics": [{ ...shared, products: ["Google Analytics"] }],
    "Google Pay": [{ header: "Google Pay", title: "Paid ₹100.00 to Example Shop", time: "2026-09-08T12:00:00.000Z", products: ["Google Pay"], details: [{ name: "Completed" }] }],
  };
}

export function takeoutMembers(version: "first" | "later" = "first"): Record<string, Buffer> {
  const members: Record<string, Buffer> = {};
  for (const [folder, entries] of Object.entries(folders(version))) members[`${ROOT}/${folder}/MyActivity.json`] = activityFile(entries);
  members[`${ROOT}/Gemini Apps/image-0000000000000001.jpg`] = JPEG;
  members[`${ROOT}/Gemini Apps/photo-0000000000000003.jpg`] = JPEG_2;
  members[`${ROOT}/Voice Match/2026-09-07_06_00_00_000_UTC.mp3`] = MP3;
  return members;
}

const VERB = /^(Searched for|Visited|Watched|Liked|Disliked|Subscribed to|Directions to|Viewed area around|Viewed) (.+)$/u;

function escaped(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}

export function htmlTime(utc: string, zone = ZONE, abbreviation = ABBREVIATION): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  }).formatToParts(Date.parse(utc)).map((part) => [part.type, part.value]));
  return `${parts.month} ${parts.day}, ${parts.year}, ${parts.hour}:${parts.minute}:${parts.second}\u202f${parts.dayPeriod} ${abbreviation}`;
}

export function activityCell(entry: JsonObject, time = htmlTime(entry.time as string)): string {
  const title = entry.title as string;
  const url = entry.titleUrl as string | undefined;
  const verb = VERB.exec(title);
  const titled = url === undefined ? escaped(title)
    : verb === null ? `<a href="${escaped(url)}">${escaped(title)}</a>` : `${escaped(verb[1]!)}&nbsp;<a href="${escaped(url)}">${escaped(verb[2]!)}</a>`;
  const subtitles = ((entry.subtitles ?? []) as { name: string; url?: string }[]).map((line) => (line.url === undefined ? escaped(line.name) : `<a href="${escaped(line.url)}">${escaped(line.name)}</a>`));
  const products = ((entry.products ?? []) as string[]).map((product) => `&emsp;${escaped(product)}<br>`).join("");
  const controls = ((entry.activityControls ?? []) as string[]).map(escaped).join(", ");
  return '<div class="outer-cell mdl-cell mdl-cell--12-col mdl-shadow--2dp"><div class="mdl-grid">' +
    `<div class="header-cell mdl-cell mdl-cell--12-col"><p class="mdl-typography--title">${escaped(entry.header as string)}<br></p></div>` +
    `<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1">${[titled, ...subtitles, time].join("<br>")}</div>` +
    '<div class="content-cell mdl-cell mdl-cell--6-col mdl-typography--body-1 mdl-typography--text-right"></div>' +
    `<div class="content-cell mdl-cell mdl-cell--12-col mdl-typography--caption">${products === "" ? "" : `<b>Products:</b><br>${products}`}` +
    `<b>Why is this here?</b><br>&emsp;This activity was saved to your Google Account because the following settings were on:&nbsp;${controls}.&nbsp;You can control these settings &nbsp;<a href="https://myaccount.google.com/activitycontrols">here</a>.</div>` +
    "</div></div>";
}

export function answeredCell(entry: JsonObject, answer: string): string {
  return activityCell(entry, `${htmlTime(entry.time as string)}<br>${answer}`);
}

export function activityHtml(entries: readonly (JsonObject | string)[]): Buffer {
  const cells = entries.map((entry) => (typeof entry === "string" ? entry : activityCell(entry))).join("");
  return Buffer.from('<html><head><meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><title>My Activity</title>' +
    "<style>.header-cell{font-weight:bold}.outer-cell{margin:4px}</style></head><body>" +
    `<div class="mdl-grid">${cells}</div></body></html>`);
}

export function activityFile(entries: readonly JsonObject[]): Buffer {
  return Buffer.from(JSON.stringify(entries, null, 2));
}

export function takeoutZip(dir: string, members: Record<string, Buffer>, name = "takeout.zip"): Buffer {
  const path = join(dir, name);
  writeZip(path, Object.entries(members).map(([member, bytes]) => ({ name: member, bytes, method: "deflate" as const })));
  return readFileSync(path);
}

export const ZIP_NAME = "takeout-20260910T120000Z-1-001.zip";

const IMAGE_SEARCHES: JsonObject[] = ["one", "two", "three"].map((word, index) => ({
  header: "Image Search", title: `Searched for example picture ${word}`, titleUrl: `https://www.google.com/search?q=example+picture+${word}&tbm=isch`,
  time: `2026-09-02T0${index}:15:30.000Z`, products: ["Image Search"], activityControls: SEARCH_CONTROL,
}));

export const myActivityFixture: Fixture = (folder) => {
  const all = folders("first");
  const files: Record<string, Spoiled> = {};
  const head = (entry: JsonObject) => `${kindOf("google-search", entry.title as string)} ${entryKey(Date.parse(entry.time as string), entry.header as string, entry.title as string, entry.titleUrl as string | undefined)}`;
  const write = (path: string, bytes: Buffer) => {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), bytes);
    return Math.floor(bytes.length / 2);
  };
  for (const name of ["Search", "YouTube"]) {
    const entries = all[name]!;
    const path = `${ROOT}/${name}/MyActivity.json`;
    const half = write(path, activityFile(entries));
    if (name !== "Search") {
      files[path] = { alone: [] };
      continue;
    }
    const closed = entries.filter((_, index) => activityFile(entries.slice(0, index + 1)).length - 2 <= half);
    files[path] = { alone: [...new Set(entries.map(head))], prefix: [...new Set(closed.map(head))] };
  }
  const path = `${ROOT}/Image Search/MyActivity.html`;
  const page = activityHtml(IMAGE_SEARCHES);
  const half = write(path, page);
  const marker = Buffer.from('<div class="outer-cell');
  const starts: number[] = [];
  for (let at = page.indexOf(marker); at >= 0; at = page.indexOf(marker, at + 1)) starts.push(at);
  const closed = IMAGE_SEARCHES.filter((_, index) => index + 1 < starts.length && starts[index + 1]! + marker.length <= half);
  files[path] = { alone: IMAGE_SEARCHES.map(head), prefix: closed.map(head) };
  return { source: source("google-search"), facts: { exported_at: EXPORTED_AT, zone: ZONE }, files };
};
