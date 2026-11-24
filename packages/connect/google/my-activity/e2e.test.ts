import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonical, parse, type Json } from "@lifestreamprotocol/core";
import { artifact, collect, counts, deliver, openTestHome, pastWholeRead, readStoring, writeZip, type Head, type TestHome } from "../../test/drive.js";
import { Refused } from "../../shared/refused.js";
import { entryKey, FOLDERS, myActivity } from "./reader.js";
import { gmail } from "../../mail/gmail/reader.js";
import { SOURCE as GMAIL_SOURCE, takeoutMbox } from "../../mail/gmail/test/fixtures.js";
import {
  ACCOUNT, activityCell, activityFile, answeredCell, activityHtml, ATTACHMENTS, EXPORTED_AT, folders, htmlTime, LATER_AT, ROOT, source, takeoutMembers, takeoutZip, ZIP_NAME, ZONE,
} from "./test/fixtures.js";

const GOLDEN = parse(readFileSync(new URL("./test/golden.json", import.meta.url), "utf8")) as unknown as Record<string, Summary[]>;
const PRODUCTS = Object.keys(GOLDEN);

type Summary = [kind: string, key: string, start_ms: number, precision: string, title: string];

function summary(heads: Head[]): Summary[] {
  return heads.map((head) => [head.kind, head.key, head.start_ms!, head.time!.precision, (head.content as { title: string }).title]);
}

async function landAll(home: TestHome, files: Record<string, Buffer>, facts = { exported_at: EXPORTED_AT }) {
  const landed: Record<string, ReturnType<typeof counts>> = {};
  for (const product of PRODUCTS) landed[product] = counts(await home.land(myActivity, deliver(home, source(product), files, facts)));
  return landed;
}

function headsOf(home: TestHome): Record<string, Head[]> {
  return Object.fromEntries(PRODUCTS.map((product) => [product, home.heads(source(product))]));
}

describe("google my activity: each of these is impossible", () => {
  it("a Takeout ZIP lands other heads than expected, or an attachment it names is no blob", async () => {
    const home = openTestHome();
    const files = { [ZIP_NAME]: takeoutZip(home.dir, takeoutMembers()) };
    const landed = await landAll(home, files);
    const heads = headsOf(home);
    expect(Object.fromEntries(PRODUCTS.map((product) => [product, summary(heads[product]!)]))).toEqual(GOLDEN);
    for (const product of PRODUCTS) expect(landed[product], product).toMatchObject({ new: GOLDEN[product]!.length, refused: 0, gone: 0 });
    expect(landed.youtube).toMatchObject({ duplicated: 1 });

    const fields = { time: "2026-09-01T08:00:00Z", header: "Search", title: "Searched for example query", titleUrl: "https://www.google.com/search?q=example+query" };
    const search = heads["google-search"]!.find((head) => (head.content as { title: string }).title === "Searched for example query")!;
    expect(search.key).toBe(`sha256:${createHash("sha256").update(canonical(fields)).digest("hex")}`);
    expect(search.content).toEqual({
      type: "google.activity", header: "Search", title: "Searched for example query", titleUrl: "https://www.google.com/search?q=example+query",
      time: "2026-09-01T08:00:00.123Z", products: ["Search"], activityControls: ["Search Services History"],
      locationInfos: [{ name: "At this general area", url: "https://www.google.com/maps/@?api=1&map_action=map&center=0.000001,0.000001&zoom=12", source: "From your device", sourceUrl: "https://support.google.com/websearch/answer/0000001" }],
    });
    const nine = Date.parse("2026-09-01T09:00:00Z");
    expect(entryKey(nine, "Search", "Used Search", undefined)).not.toBe(entryKey(nine, "Search", "Used Search", ""));

    const hash = (bytes: Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const pictures = heads.gemini!.find((head) => (head.content as { title: string }).title === "Prompted What is in these pictures?")!;
    expect((pictures.content as { blobs: Json }).blobs).toEqual([{ hash: hash(ATTACHMENTS.jpeg), bytes: ATTACHMENTS.jpeg.length, media_type: "image/jpeg", role: "attachment", file: "image-0000000000000001.jpg" }]);
    expect((pictures.content as { attachedFiles: Json }).attachedFiles).toEqual(["image-0000000000000001.png", "image-0000000000000002.png"]);
    const voice = heads["google-voice-match"]![0]!;
    expect((voice.content as { blobs: Json }).blobs).toEqual([{ hash: hash(ATTACHMENTS.mp3), bytes: ATTACHMENTS.mp3.length, media_type: "audio/mpeg", role: "attachment", file: "2026-09-07_06_00_00_000_UTC.mp3" }]);
    const rows = [
      ...(await readStoring(myActivity, deliver(home, source("gemini"), files, { exported_at: EXPORTED_AT }), home.blobs)),
      ...(await readStoring(myActivity, deliver(home, source("google-voice-match"), files, { exported_at: EXPORTED_AT }), home.blobs)),
    ];
    const handed = rows.flatMap((row) => (row.streamed ?? []).map((each) => [each.hash, row.blobs]));
    expect(rows.every((row) => row.bytes === undefined)).toBe(true);
    expect(handed.map(([blob]) => blob).sort()).toEqual(Object.values(ATTACHMENTS).map(hash).sort());
    for (const [blob, listed] of handed) expect(listed).toContain(blob);
    for (const bytes of Object.values(ATTACHMENTS)) expect(home.blobs.bytes(hash(bytes)).equals(bytes)).toBe(true);

    const all = Object.values(heads).flat();
    expect(all.some((head) => JSON.stringify(head.content).includes("Google Pay"))).toBe(false);
    expect(await collect(myActivity.read(deliver(home, source("google-pay"), files, { exported_at: EXPORTED_AT }), home.blobs))).toEqual([]);
    artifact(home.dir, "heads.json", { landed, heads });
  });

  it("a source of a product My Activity does not read refuses the Takeout, or Gmail's own source misses its mailbox", async () => {
    const home = openTestHome();
    const files = { [ZIP_NAME]: takeoutZip(home.dir, { ...takeoutMembers(), "Takeout/Mail/All mail Including Spam and Trash.mbox": takeoutMbox() }) };
    const facts = { exported_at: EXPORTED_AT, account: ACCOUNT, sources: [{ id: source("google-search"), connector: "google-my-activity" }, { id: GMAIL_SOURCE, connector: "gmail-takeout" }] };
    const stale = await home.land(myActivity, deliver(home, source("gmail"), files, facts));
    expect(stale).toMatchObject({ new: 0, refused: 0 });
    expect(home.heads(source("gmail"))).toEqual([]);
    const mailbox = await home.land(gmail, deliver(home, GMAIL_SOURCE, files, facts));
    expect(mailbox).toMatchObject({ new: 5, refused: 0 });
    expect(home.heads(GMAIL_SOURCE, ["mailmsg"]).map((head) => head.key)).toEqual(["1790000000000000201", "1790000000000000202", "1790000000000000203"]);
    artifact(home.dir, "unread-product.json", { stale: counts(stale), mailbox: counts(mailbox) });
  });

  it("the Takeout's extracted members land other records than its ZIP", async () => {
    const zipped = openTestHome();
    await landAll(zipped, { [ZIP_NAME]: takeoutZip(zipped.dir, takeoutMembers()) });
    const extracted = openTestHome();
    const members = Object.fromEntries(Object.entries(takeoutMembers()).map(([path, bytes]) => [`exported/${path}`, bytes]));
    const landed = await landAll(extracted, members);
    const versions = (home: TestHome) => Object.fromEntries(PRODUCTS.map((product) => [product, home.heads(source(product)).map((head) => [head.kind, head.key, head.version])]));
    expect(versions(extracted)).toEqual(versions(zipped));
    for (const bytes of Object.values(ATTACHMENTS)) expect(extracted.blobs.bytes(`sha256:${createHash("sha256").update(bytes).digest("hex")}`).equals(bytes)).toBe(true);
    artifact(extracted.dir, "parity.json", { landed, versions: versions(extracted) });
  });

  it("an attachment past a whole read's limit refuses its entry, or is stored under another name than its bytes' SHA-256", async () => {
    const home = openTestHome();
    const clip = pastWholeRead();
    const zip = join(home.dir, ZIP_NAME);
    writeZip(zip, [
      { name: `${ROOT}/Gemini Apps/MyActivity.json`, bytes: activityFile([{ header: "Gemini Apps", title: "Prompted Watch this clip", time: "2026-09-01T00:00:00Z", products: ["Gemini Apps"], attachedFiles: ["clip.mp4"] }]), method: "deflate" },
      { name: `${ROOT}/Gemini Apps/clip.mp4`, bytes: clip.chunks, method: "deflate" },
    ]);
    const delivery = deliver(home, source("gemini"), { [ZIP_NAME]: zip }, { exported_at: EXPORTED_AT });
    const rows = await readStoring(myActivity, delivery, home.blobs);
    const landed = await home.land(myActivity, delivery, rows);
    expect(landed).toMatchObject({ new: 1, refused: 0 });
    expect((home.heads(source("gemini"))[0]!.content as { blobs: Json }).blobs).toEqual([{ hash: clip.hash, bytes: clip.size, media_type: "video/mp4", role: "attachment", file: "clip.mp4" }]);
    expect([rows[0]!.blobs, rows[0]!.streamed?.map((each) => [each.hash, each.size]), home.blobs.has(clip.hash)]).toEqual([[clip.hash], [[clip.hash, clip.size]], true]);
    artifact(home.dir, "past-whole-read.json", { landed: counts(landed), hash: clip.hash, size: clip.size });
  });

  it("the same Takeout again writes a new version", async () => {
    const home = openTestHome();
    const files = { [ZIP_NAME]: takeoutZip(home.dir, takeoutMembers()) };
    await landAll(home, files);
    const again = await landAll(home, files, { exported_at: LATER_AT });
    for (const product of PRODUCTS) expect(again[product], product).toMatchObject({ new: 0, changed: 0, gone: 0, restated: GOLDEN[product]!.length });
    artifact(home.dir, "again.json", again);
  });

  it("an extracted ZIP-based attachment is expanded instead of linked whole", async () => {
    const home = openTestHome();
    const document = takeoutZip(home.dir, { "word/document.xml": Buffer.from("<document>synthetic document</document>") }, "document.docx");
    const files = {
      [`${ROOT}/Gemini Apps/MyActivity.json`]: activityFile([{ header: "Gemini Apps", title: "Prompted Read this document", time: "2026-09-01T00:00:00Z", products: ["Gemini Apps"], attachedFiles: ["document.docx"] }]),
      [`${ROOT}/Gemini Apps/document.docx`]: document,
    };
    const delivery = deliver(home, source("gemini"), files, { exported_at: EXPORTED_AT });
    const first = await home.land(myActivity, delivery);
    const heads = home.heads(source("gemini"));
    const attachment = delivery.files.find((file) => file.path.endsWith("document.docx"))!;
    expect((heads[0]!.content as { blobs: Json }).blobs).toEqual([{ hash: attachment.blob, bytes: document.length, media_type: "application/octet-stream", role: "attachment", file: "document.docx" }]);
    expect(home.blobs.bytes(attachment.blob)).toEqual(document);
    artifact(home.dir, "extracted-document.json", { first, heads });
  });

  it("a later Takeout leaves a changed entry's head, or a missing entry goes", async () => {
    const home = openTestHome();
    await landAll(home, { [ZIP_NAME]: takeoutZip(home.dir, takeoutMembers()) });
    const later = await landAll(home, { [ZIP_NAME]: takeoutZip(home.dir, takeoutMembers("later"), "later.zip") }, { exported_at: LATER_AT });
    expect(later.youtube).toMatchObject({ changed: 1, new: 0, gone: 0 });
    expect(later.youtube!.changedPaths).toEqual({ "subtitles[].name": 1 });
    expect(later["google-maps"]).toMatchObject({ new: 1, changed: 0, gone: 0 });
    expect(later["google-search"]).toMatchObject({ new: 0, changed: 0, gone: 0, restated: GOLDEN["google-search"]!.length - 1 });
    const visit = home.heads(source("google-search"), ["page-visit"]);
    expect(visit.map((head) => [head.gone, (head.content as { title: string }).title, head.stated_ms])).toEqual([[false, "Visited Example page", Date.parse(EXPORTED_AT)]]);
    artifact(home.dir, "later.json", { later, heads: headsOf(home) });
  });

  it("a source reads a folder that is not its own, or a file that is no Takeout", async () => {
    const home = openTestHome();
    const youtubeOnly = Object.fromEntries(Object.entries(takeoutMembers()).filter(([path]) => path.startsWith(`${ROOT}/YouTube/`)));
    const files = {
      [ZIP_NAME]: takeoutZip(home.dir, youtubeOnly),
      "other.zip": takeoutZip(home.dir, { "Takeout/Mail/All mail.mbox": Buffer.from("From x\n") }, "other.zip"),
      "Takeout/My Activity/Unknown Product/MyActivity.json": activityFile([]),
      "notes.txt": Buffer.from("not a takeout"),
    };
    for (const product of Object.keys(FOLDERS)) {
      const rows = await collect(myActivity.read(deliver(home, source(product), files, { exported_at: EXPORTED_AT }), home.blobs));
      expect(rows.length, product).toBe(product === "youtube" ? GOLDEN.youtube!.length + 1 : 0);
    }
    for (const name of [`youtube:${ACCOUNT}:cloud`, "youtube:export"]) {
      await expect(collect(myActivity.read(deliver(home, name, files, { exported_at: EXPORTED_AT }), home.blobs)), name).rejects.toThrow(Refused);
    }
    expect(await collect(myActivity.read(deliver(home, "not-a-product:person-a@example.com:export", files, { exported_at: EXPORTED_AT }), home.blobs))).toEqual([]);
    artifact(home.dir, "routing.json", { files: Object.keys(files) });
  });

  it("a swept unrelated binary prevents a product from reading its retained JSON", async () => {
    const home = openTestHome();
    const delivery = deliver(home, source("youtube"), {
      [`${ROOT}/YouTube/MyActivity.json`]: takeoutMembers()[`${ROOT}/YouTube/MyActivity.json`]!,
      "Takeout/Photos/unlinked.jpg": Buffer.from("unlinked synthetic photo"),
    }, { exported_at: EXPORTED_AT });
    home.blobs.remove(delivery.files.find((file) => file.path.endsWith("unlinked.jpg"))!.blob);
    const landed = await home.land(myActivity, delivery);
    expect(landed).toMatchObject({ new: GOLDEN.youtube!.length, refused: 0 });
    artifact(home.dir, "retained-text.json", { landed, heads: home.heads(source("youtube")) });
  });

  it("a malformed folder lands anything, or refuses more than itself", async () => {
    const home = openTestHome();
    const json = `${ROOT}/YouTube/MyActivity.json`;
    const entry = (fields: Record<string, Json>) => Buffer.from(JSON.stringify([{ header: "YouTube", title: "Watched x", products: ["YouTube"], ...fields }]));
    const cases: [string, Record<string, Buffer>, RegExp][] = [
      ["a cut array", { [json]: Buffer.from('[{"header":"YouTube","title":"Watched x","time":"2026-09-01T00:00:00Z","products":["YouTube"]}') }, /YouTube\/MyActivity\.json: the top-level array is not closed/u],
      ["an element that is no object", { [json]: Buffer.from('["Watched x"]') }, /YouTube\/MyActivity\.json\[0\] is not a JSON object/u],
      ["an entry with no time", { [json]: entry({}) }, /YouTube\/MyActivity\.json\[0\] states no time/u],
      ["a time not in UTC", { [json]: entry({ time: "2026-09-01T05:30:00+05:30" }) }, /is not an RFC 3339 UTC instant/u],
      ["a time that is no instant", { [json]: entry({ time: "2026-02-30T00:00:00Z" }) }, /2026-02-30T00:00:00Z/u],
      ["an entry that states the connector's own member", { [json]: entry({ time: "2026-09-01T00:00:00Z", type: "x" }) }, /states a type member/u],
      ["an HTML page read with no zone", { [`${ROOT}/YouTube/MyActivity.html`]: activityHtml([{ header: "YouTube", title: "Watched x", time: "2026-09-01T00:00:00Z", products: ["YouTube"] }]) }, /YouTube\/MyActivity\.html: the delivery states no zone to read its local times in/u],
      ["a folder with neither file", { [`${ROOT}/YouTube/notes.txt`]: Buffer.from("not an activity file") }, /YouTube holds no MyActivity\.json or MyActivity\.html/u],
      ["a folder stated twice", { [json]: entry({ time: "2026-09-01T00:00:00Z" }), [ZIP_NAME]: takeoutZip(home.dir, { [json]: entry({ time: "2026-09-01T00:00:00Z" }) }) }, /holds YouTube\/MyActivity\.json twice/u],
    ];
    const refusals: Record<string, string> = {};
    const maps = { [`${ROOT}/Maps/MyActivity.json`]: takeoutMembers()[`${ROOT}/Maps/MyActivity.json`]! };
    for (const [name, files, message] of cases) {
      const scratch = openTestHome();
      const product = (other: string) => scratch.land(myActivity, deliver(scratch, source(other), { ...maps, ...files }, { exported_at: EXPORTED_AT }));
      const landed = await product("youtube");
      expect(landed, name).toMatchObject({ new: name === "a cut array" ? 1 : 0, refused: 1 });
      expect(landed.refusals[0]!.violations[0], name).toMatch(message);
      expect((await product("google-maps")).new, name).toBe(GOLDEN["google-maps"]!.length);
      refusals[name] = landed.refusals[0]!.violations[0]!;
    }
    expect(home.heads(source("youtube"))).toEqual([]);
    const damaged = await home.land(myActivity, deliver(home, source("youtube"), {
      [json]: entry({ time: "2026-09-01T00:00:00Z" }), "takeout-002.zip": Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("not a zip")]),
    }, { exported_at: EXPORTED_AT }));
    expect(damaged).toMatchObject({ new: 1, refused: 1 });
    expect(damaged.refusals).toEqual([{ kind: "file", key: "takeout-002.zip", violations: [expect.stringMatching(/^its first bytes are a zip's, and it cannot be listed: .*not a ZIP archive/u)] }]);
    refusals["a damaged archive"] = damaged.refusals[0]!.violations[0]!;
    artifact(home.dir, "refusals.json", refusals);
  });

  it("an entry that breaks the shape lands, or refuses the others", async () => {
    const home = openTestHome();
    const entries = [
      { header: "YouTube", title: "Watched Example video one", titleUrl: "https://www.youtube.com/watch?v=example0001", time: "2026-09-02T18:30:00.250Z", products: ["YouTube"] },
      { header: "YouTube", title: "Watched Example video two", time: "2026-09-02T18:40:00.250Z", products: "YouTube" },
      { header: "YouTube", title: "Liked Example video one", time: "2026-09-02T18:50:00.250Z", products: ["YouTube"], subtitles: [{ name: 1 }] },
    ];
    const landed = await home.land(myActivity, deliver(home, source("youtube"), { [`${ROOT}/YouTube/MyActivity.json`]: activityFile(entries) }, { exported_at: EXPORTED_AT }));
    expect(landed).toMatchObject({ new: 1, refused: 2 });
    expect(landed.refusals.map((refusal) => refusal.violations)).toEqual([["products must list at least one product, as strings"], ["subtitles must be a list of objects of strings"]]);
    artifact(home.dir, "landed.json", counts(landed));
  });

  it("an HTML Takeout lands other keys than its JSON, an abbreviation the home's zone lacks lands, Google's repeat lands twice, or HTML wins over JSON", async () => {
    const all = folders("first");
    const read = ["Search", "YouTube", "Maps"];
    const products = ["google-search", "youtube", "google-maps"];
    const json = Object.fromEntries(read.map((name) => [`${ROOT}/${name}/MyActivity.json`, activityFile(all[name]!)]));
    const elsewhere = { header: "Search", title: "Searched for example elsewhere", time: "2026-09-01T07:00:00.000Z", products: ["Search"] };
    const html = Object.fromEntries(read.map((name) => [
      `${ROOT}/${name}/MyActivity.html`, activityHtml(name === "Search" ? [...all[name]!, activityCell(elsewhere, htmlTime(elsewhere.time, ZONE, "PDT"))] : all[name]!),
    ]));
    const facts = { exported_at: EXPORTED_AT, zone: ZONE };
    const fromJson = openTestHome();
    const fromHtml = openTestHome();
    const landed: Record<"json" | "html", Record<string, ReturnType<typeof counts>>> = { json: {}, html: {} };
    for (const product of products) {
      landed.json[product] = counts(await fromJson.land(myActivity, deliver(fromJson, source(product), json, facts)));
      landed.html[product] = counts(await fromHtml.land(myActivity, deliver(fromHtml, source(product), html, facts)));
    }
    const keys = (home: TestHome) => Object.fromEntries(products.map((product) => [product, home.heads(source(product)).map((head) => [head.kind, head.key, Math.floor(head.start_ms! / 1000) * 1000])]));
    expect(keys(fromHtml)).toEqual(keys(fromJson));
    for (const product of products) expect(landed.html[product], product).toMatchObject({ new: landed.json[product]!.new, refused: product === "google-search" ? 1 : 0 });
    expect(landed.html.youtube).toMatchObject({ duplicated: 1 });
    expect(landed.html["google-search"]!.refusals).toEqual([{
      kind: "file", key: `${ROOT}/Search/MyActivity.html[5]`,
      violations: [`${ROOT}/Search/MyActivity.html[5] time "Sep 1, 2026, 3:00:00\u202fAM PDT" "PDT" is no abbreviation of America/New_York at 2026-09-01T03:00:00`],
    }]);
    const search = fromHtml.heads(source("google-search")).find((head) => (head.content as { title: string }).title === "Searched for example query")!;
    expect(search.content).toEqual({
      type: "google.activity", header: "Search", title: "Searched for example query", titleUrl: "https://www.google.com/search?q=example+query",
      time: "2026-09-01T08:00:00Z", stated: "Sep 1, 2026, 4:00:00\u202fAM EDT", products: ["Search"],
    });
    expect(search.time).toMatchObject({ start_ms: Date.parse("2026-09-01T08:00:00Z"), precision: "s", offset_min: -240 });
    const watched = fromHtml.heads(source("youtube")).find((head) => (head.content as { header: string }).header === "YouTube" && (head.content as { title: string }).title === "Watched Example video one")!;
    expect((watched.content as { subtitles: Json }).subtitles).toEqual([{ name: "Example Channel", url: "https://www.youtube.com/channel/UC000000000000000000001" }]);
    const both = openTestHome();
    await both.land(myActivity, deliver(both, source("google-maps"), { ...json, ...html }, facts));
    expect(both.heads(source("google-maps")).map((head) => head.version)).toEqual(fromJson.heads(source("google-maps")).map((head) => head.version));
    artifact(fromHtml.dir, "html.json", { landed, heads: Object.fromEntries(products.map((product) => [product, fromHtml.heads(source(product))])) });
  });

  it("a Gemini Apps or AI Mode cell, its time before its answer, is refused for its time's place, or its answer or subtitle lost", async () => {
    const facts = { exported_at: EXPORTED_AT, zone: ZONE };
    const gemini = { header: "Gemini Apps", title: "Prompted A synthetic question", time: "2026-09-01T08:30:00.000Z", subtitles: [{ name: "Attached 1 file." }], products: ["Gemini Apps"] };
    const mode = { header: "Search", title: "Searched for synthetic query", titleUrl: "https://www.google.com/search?q=synthetic+query&udm=50", time: "2026-09-01T09:30:00.000Z", subtitles: [{ name: "Synthetic follow-up" }], products: ["AI Mode"] };
    const files = {
      [`${ROOT}/Gemini Apps/MyActivity.html`]: activityHtml([answeredCell(gemini, "<p>A synthetic answer, <b>bold</b> in part.</p>")]),
      [`${ROOT}/AI Mode/MyActivity.html`]: activityHtml([answeredCell(mode, "<p>An example answer.</p>")]),
    };
    const home = openTestHome();
    const landed = { gemini: counts(await home.land(myActivity, deliver(home, source("gemini"), files, facts))), search: counts(await home.land(myActivity, deliver(home, source("google-search"), files, facts))) };
    expect(landed).toMatchObject({ gemini: { new: 1, refused: 0 }, search: { new: 1, refused: 0 } });
    const [prompted] = home.heads(source("gemini"));
    expect(prompted!.content).toEqual({
      type: "google.activity", header: "Gemini Apps", title: "Prompted A synthetic question", subtitles: [{ name: "Attached 1 file." }],
      time: "2026-09-01T08:30:00Z", stated: htmlTime(gemini.time), safeHtmlItem: [{ html: "<p>A synthetic answer, <b>bold</b> in part.</p>" }], products: ["Gemini Apps"],
    });
    const [searched] = home.heads(source("google-search"));
    expect([searched!.start_ms, (searched!.content as { safeHtmlItem: Json }).safeHtmlItem]).toEqual([Date.parse(mode.time), [{ html: "<p>An example answer.</p>" }]]);
    artifact(home.dir, "answered.json", { landed, heads: [prompted, searched] });
  });

  it("an HTML time in its zone's overlap reads one offset for both, one in a gap or out of season lands, or a page cut short loses the entries before the cut", async () => {
    const zone = "America/Los_Angeles";
    const entry = (title: string) => ({ header: "Search", title, products: ["Search"] });
    const cells = [
      activityCell(entry("Used Search"), "Nov 1, 2026, 1:30:00\u202fAM PDT"),
      activityCell(entry("Used Search again"), "Nov 1, 2026, 1:30:00\u202fAM PST"),
      activityCell(entry("Used Search in the gap"), "Mar 8, 2026, 2:30:00\u202fAM PST"),
      activityCell(entry("Used Search in winter"), "Jan 5, 2026, 9:00:00\u202fPM PDT"),
    ];
    const path = `${ROOT}/Search/MyActivity.html`;
    const home = openTestHome();
    const landed = await home.land(myActivity, deliver(home, source("google-search"), { [path]: activityHtml(cells) }, { exported_at: EXPORTED_AT, zone }));
    expect(landed).toMatchObject({ new: 2, refused: 2 });
    expect(home.heads(source("google-search")).map((head) => [(head.content as { title: string }).title, head.start_ms, head.time!.offset_min] as const).sort((left, right) => left[1]! - right[1]!)).toEqual([
      ["Used Search", Date.UTC(2026, 10, 1, 8, 30), -420], ["Used Search again", Date.UTC(2026, 10, 1, 9, 30), -480],
    ]);
    expect(landed.refusals.map((refusal) => refusal.violations[0])).toEqual([
      `${path}[2] time "Mar 8, 2026, 2:30:00\u202fAM PST" "PST" is no abbreviation of ${zone} at 2026-03-08T02:30:00`,
      `${path}[3] time "Jan 5, 2026, 9:00:00\u202fPM PDT" "PDT" is no abbreviation of ${zone} at 2026-01-05T21:00:00`,
    ]);
    const page = activityHtml(cells);
    const third = page.indexOf('<div class="outer-cell', page.indexOf('<div class="outer-cell', page.indexOf('<div class="outer-cell') + 1) + 1);
    const cut = openTestHome();
    const short = await cut.land(myActivity, deliver(cut, source("google-search"), { [path]: page.subarray(0, third + 100) }, { exported_at: EXPORTED_AT, zone }));
    expect(short).toMatchObject({ new: 2, refused: 1 });
    expect(short.refusals).toEqual([{ kind: "file", key: path, violations: [`${path} is not closed by </html> after 2 entries`] }]);
    artifact(home.dir, "zone.json", { landed: counts(landed), cut: counts(short), heads: home.heads(source("google-search")) });
  });
});
