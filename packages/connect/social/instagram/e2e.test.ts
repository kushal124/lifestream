import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, type Json, type JsonObject } from "@lifestreamprotocol/core";
import { artifact, collect, counts, deliver, openTestHome, pastWholeRead, readStoring, writeZip, type Head, type TestHome } from "../../test/drive.js";
import { Refused } from "../../shared/refused.js";
import { messageKey } from "../../shared/meta-export.js";
import { extracted, metaJson, mojibake, zipOf } from "../meta/test/fixtures.js";
import { instagram } from "./reader.js";
import { EXPORTED_AT, exportMembers, HANDLE, LATER_AT, MEDIA, PROFILE, SOURCE, THREAD_B } from "./test/fixtures.js";

const GOLDEN = parse(readFileSync(new URL("./test/golden.json", import.meta.url), "utf8")) as unknown as Summary[];

type Summary = [kind: string, key: string, start_ms: number | null, precision: string | null];

const summary = (heads: Head[]): Summary[] => heads.map((head) => [head.kind, head.key, head.start_ms, head.time?.precision ?? null]);
const sha = (bytes: Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const facts = { exported_at: EXPORTED_AT };

function find(heads: Head[], kind: string, test: (content: JsonObject) => boolean): Head {
  const found = heads.filter((head) => head.kind === kind && test(head.content as JsonObject));
  expect(found, kind).toHaveLength(1);
  return found[0]!;
}

async function refusal(home: TestHome, files: Record<string, Buffer>, source = SOURCE): Promise<Error> {
  const error = await home.land(instagram, deliver(home, source, files, facts)).then(() => undefined, (thrown: unknown) => thrown);
  expect(error).toBeInstanceOf(Refused);
  return error as Error;
}

describe("instagram export: each of these is impossible", () => {
  it("an export lands other heads than expected, or a file it names is no blob", async () => {
    const home = openTestHome();
    const files = { "instagram-person-a.zip": zipOf(home.dir, exportMembers(), "instagram-person-a.zip") };
    const landed = await home.land(instagram, deliver(home, SOURCE, files, facts));
    const heads = home.heads(SOURCE);
    expect(summary(heads)).toEqual(GOLDEN);
    expect(landed).toMatchObject({ new: GOLDEN.length, refused: 0, gone: 0 });

    const post = find(heads, "post", (content) => content.fbid === "17900000000000001");
    expect(post.key).toBe("17900000000000001");
    const values = (post.content as { label_values: JsonObject[] }).label_values;
    expect(values[0]).toEqual({ label: "Caption", value: "A synthetic caption, café ☕ 😀" });
    const photo = MEDIA["media/posts/202509/10000000000000001_n.jpg"]!;
    expect((post.content as { blobs: Json }).blobs).toEqual([{ hash: sha(photo), bytes: photo.length, media_type: "image/jpeg", role: "attachment", file: "media/posts/202509/10000000000000001_n.jpg" }]);
    expect(post.time).toEqual({ start_ms: Date.parse("2026-09-01T08:00:00Z"), precision: "s" });
    expect(find(heads, "post", (content) => content.fbid === "17900000000000003").content).not.toHaveProperty("blobs");

    expect(heads.filter((head) => head.kind === "like").map((head) => head.key).sort()).toEqual([
      "https://www.instagram.com/p/AAAAAAAAAA1/", "https://www.instagram.com/reel/AAAAAAAAAA2/", "https://www.instagram.com/stories/person-b/3000000000000000001",
    ]);
    expect(heads.filter((head) => head.kind === "follow").map((head) => head.key)).toEqual(["person-b", "person-c"]);

    const chat = find(heads, "chat", (content) => content.thread_path === "inbox/personb_1000000000000001");
    expect(chat.key).toBe("1000000000000001");
    expect(chat.content).toEqual({ type: "instagram.chat", participants: [{ name: "Person B" }, { name: "Pérson A" }], title: "Person B", is_still_participant: true, thread_path: "inbox/personb_1000000000000001", magic_words: [] });
    const hello = find(heads, "msg", (content) => typeof content.content === "string" && content.content.startsWith("Hello"));
    expect(hello.key).toBe(messageKey("1000000000000001", { sender_name: "Person B", timestamp_ms: Date.parse("2026-09-10T10:00:00.125Z"), content: "Hello ✨ see you at 6" }));
    expect(hello.content).toEqual({
      type: "instagram.msg", thread_path: "inbox/personb_1000000000000001", sender_name: "Person B", timestamp_ms: Date.parse("2026-09-10T10:00:00.125Z"),
      content: "Hello ✨ see you at 6", reactions: [{ reaction: "❤", actor: "Pérson A", timestamp: Date.parse("2026-09-10T10:01:00Z") / 1000 }],
      is_geoblocked_for_viewer: false, is_unsent_image_by_messenger_kid_parent: false,
    });
    expect(hello.time).toEqual({ start_ms: Date.parse("2026-09-10T10:00:00.125Z"), precision: "ms" });
    const sent = find(heads, "msg", (content) => Array.isArray(content.photos));
    const sentPhoto = MEDIA[`${THREAD_B}/photos/10000000000000010_n.jpg`]!;
    expect((sent.content as { blobs: JsonObject[] }).blobs.map((blob) => blob.hash)).toEqual([sha(sentPhoto)]);
    expect(heads.filter((head) => head.kind === "msg" && (head.content as JsonObject).content === "Same words")).toHaveLength(2);

    const rows = await readStoring(instagram, deliver(home, SOURCE, files, facts), home.blobs);
    const handed = rows.flatMap((row) => (row.streamed ?? []).map((each) => each.hash));
    expect(handed.sort()).toEqual(Object.values(MEDIA).map(sha).sort());
    for (const row of rows) for (const each of row.streamed ?? []) expect(row.blobs).toContain(each.hash);
    for (const bytes of Object.values(MEDIA)) expect(home.blobs.bytes(sha(bytes)).equals(bytes)).toBe(true);
    expect(rows.some((row) => /posts_1|followers_1|liked_comments|your_chat_information/u.test(row.locator ?? ""))).toBe(false);
    artifact(home.dir, "heads.json", { landed: counts(landed), heads });
  });

  it("a video past a whole read's limit refuses its post, or is stored under another name than its bytes' SHA-256", async () => {
    const home = openTestHome();
    const clip = pastWholeRead();
    const video = "media/posts/10000000000000002_n.mp4";
    const zip = join(home.dir, "instagram-person-a.zip");
    writeZip(zip, Object.entries(exportMembers()).map(([name, bytes]) => ({ name, bytes: name === video ? clip.chunks : bytes, method: "deflate" as const })));
    const delivery = deliver(home, SOURCE, { "instagram-person-a.zip": zip }, facts);
    const rows = await readStoring(instagram, delivery, home.blobs);
    const landed = await home.land(instagram, delivery, rows);
    expect(landed).toMatchObject({ new: GOLDEN.length, refused: 0 });
    const post = find(home.heads(SOURCE), "post", (content) => content.blobs !== undefined && JSON.stringify(content).includes(video));
    expect((post.content as { blobs: JsonObject[] }).blobs).toEqual([{ hash: clip.hash, bytes: clip.size, media_type: "video/mp4", role: "attachment", file: video }]);
    expect(home.blobs.has(clip.hash)).toBe(true);
    artifact(home.dir, "past-whole-read.json", { landed: counts(landed), hash: clip.hash, size: clip.size });
  });

  it("the extracted export lands other records than its ZIP", async () => {
    const zipped = openTestHome();
    await zipped.land(instagram, deliver(zipped, SOURCE, { "instagram-person-a.zip": zipOf(zipped.dir, exportMembers(), "instagram-person-a.zip") }, facts));
    const home = openTestHome();
    const landed = await home.land(instagram, deliver(home, SOURCE, { ...extracted(exportMembers(), "files/instagram-person-a-2026-09-20"), "files/notes.txt": Buffer.from("not the export") }, facts));
    const versions = (one: TestHome) => one.heads(SOURCE).map((head) => [head.kind, head.key, head.version]);
    expect(versions(home)).toEqual(versions(zipped));
    for (const bytes of Object.values(MEDIA)) expect(home.blobs.bytes(sha(bytes)).equals(bytes)).toBe(true);
    artifact(home.dir, "parity.json", { landed: counts(landed), versions: versions(home) });
  });

  it("the same export again writes a new version", async () => {
    const home = openTestHome();
    const files = { "instagram-person-a.zip": zipOf(home.dir, exportMembers(), "instagram-person-a.zip") };
    await home.land(instagram, deliver(home, SOURCE, files, facts));
    const again = await home.land(instagram, deliver(home, SOURCE, files, { exported_at: LATER_AT }));
    expect(again).toMatchObject({ new: 0, changed: 0, gone: 0, restated: GOLDEN.length });
    artifact(home.dir, "again.json", counts(again));
  });

  it("a later export leaves an edited item's head, re-keys a thread that moved, or a missing item goes", async () => {
    const home = openTestHome();
    await home.land(instagram, deliver(home, SOURCE, { "first.zip": zipOf(home.dir, exportMembers(), "first.zip") }, facts));
    const before = home.heads(SOURCE);
    const later = await home.land(instagram, deliver(home, SOURCE, { "later.zip": zipOf(home.dir, exportMembers("later"), "later.zip") }, { exported_at: LATER_AT }));
    expect(later).toMatchObject({ new: 1, changed: 3, gone: 0 });
    const after = home.heads(SOURCE);
    expect(after.map((head) => [head.kind, head.key])).toEqual(expect.arrayContaining(before.map((head) => [head.kind, head.key])));
    expect(after.filter((head) => head.gone)).toEqual([]);
    expect(find(after, "chat", (content) => content.title === "Person C").content).toMatchObject({ thread_path: "inbox/personc_1000000000000002" });
    artifact(home.dir, "later.json", { later: counts(later), heads: after });
  });

  it("an export of another account lands under this one", async () => {
    const home = openTestHome();
    const members = exportMembers();
    const error = await refusal(home, { "x.zip": zipOf(home.dir, members, "x.zip") }, "instagram:person-b:export");
    expect(error.message).toMatch(/the export is person-a's, and the source is person-b's/u);
    const { [PROFILE]: _profile, ...without } = members;
    expect((await refusal(home, without)).message).toMatch(/with no personal_information\/personal_information\/personal_information\.json/u);
    expect((await refusal(home, { ...members, [PROFILE]: metaJson({ profile_user: [{ title: "", string_map_data: {} }] }) })).message).toMatch(/names no account/u);
    await expect(collect(instagram.read(deliver(home, `instagram:${HANDLE}:cloud`, members, facts), home.blobs))).rejects.toThrow(/is not a instagram:<account>:export source/u);
    expect(home.heads(SOURCE)).toEqual([]);
    expect(home.heads("instagram:person-b:export")).toEqual([]);
  });

  it("a malformed file, item or thread refuses more than itself, a malformed export lands anything, or a file named .zip that is no zip is passed over unnamed", async () => {
    const home = openTestHome();
    const members = exportMembers();
    const likes = "your_instagram_activity/likes/liked_posts.json";
    const stories = "your_instagram_activity/media/stories.json";
    const thread = `${THREAD_B}/message_1.json`;
    const parts: [string, Record<string, Buffer>, string, RegExp][] = [
      ["a cut array", { ...members, [likes]: Buffer.from('[{"timestamp": 1}') }, likes, /liked_posts\.json: the top-level array is not closed/u],
      ["an element that is no object", { ...members, [likes]: Buffer.from('["x"]') }, `${likes}[0]`, /liked_posts\.json\[0\] is not a JSON object/u],
      ["an item that states the connector's own member", { ...members, [likes]: metaJson([{ timestamp: 1, type: "x" }]) }, `${likes}[0]`, /liked_posts\.json\[0\] states a type member/u],
      ["items under another member", { ...members, [stories]: metaJson({ ig_story: [] }) }, stories, /stories\.json lists its items under "ig_story", not "ig_stories"/u],
      ["the items' member twice", { ...members, [stories]: Buffer.from('{"ig_stories": [], "ig_stories": [{"uri": "x"}]}') }, stories, /stories\.json: a member named "ig_stories" twice in your_instagram_activity\/media\/stories\.json/u],
      ["a list never closed", { ...members, [stories]: Buffer.from('{"ig_stories": [{"uri": "x"}') }, stories, /stories\.json/u],
      ["a thread with no thread_path", { ...members, [thread]: metaJson({ participants: [], messages: [] }) }, thread, /message_1\.json states no thread_path/u],
      ["text that is not UTF-8", { ...members, [likes]: Buffer.from([0x5b, 0x22, 0xff, 0x22, 0x5d]) }, `${likes}[0]`, /is not UTF-8/u],
    ];
    const posts = GOLDEN.filter(([kind]) => kind === "post").length;
    const refusals: Record<string, string> = {};
    for (const [name, files, key, message] of parts) {
      const scratch = openTestHome();
      const landed = await scratch.land(instagram, deliver(scratch, SOURCE, files, facts));
      expect(landed.refusals, name).toEqual([{ kind: "file", key, violations: [expect.stringMatching(message)] }]);
      expect(scratch.heads(SOURCE, ["post"]), name).toHaveLength(posts);
      refusals[name] = landed.refusals[0]!.violations[0]!;
    }
    const damaged = await home.land(instagram, deliver(home, SOURCE, { "ig.zip": Buffer.from("PK\x03\x04 not a zip") }, facts));
    expect(damaged.refusals).toEqual([{ kind: "file", key: "ig.zip", violations: [expect.stringMatching(/not a ZIP archive/u)] }]);
    const named = await home.land(instagram, deliver(home, SOURCE, { "ig.zip": Buffer.from("{\"profile_user\": []}") }, facts));
    expect([named.new, named.refusals]).toEqual([0, [{ kind: "file", key: "ig.zip", violations: [expect.stringContaining("named .zip, its first bytes are not a zip's")] }]]);
    refusals["a file named .zip that is no zip"] = named.refusals[0]!.violations[0]!;
    const wholes: [string, Record<string, Buffer>, RegExp][] = [
      ["an export and its ZIP together", { ...extracted(members, "files/ig"), "ig.zip": zipOf(home.dir, members, "ig.zip") }, /holds connections\/followers_and_following\/followers_1\.json twice/u],
      ["two exports", { ...extracted(members, "files/one"), ...extracted(members, "files/two") }, /holds two exports/u],
    ];
    for (const [name, files, message] of wholes) {
      const error = await home.land(instagram, deliver(home, SOURCE, files, facts)).then(() => undefined, (thrown: unknown) => thrown);
      expect(error, name).toBeInstanceOf(Refused);
      expect((error as Error).message, name).toMatch(message);
      refusals[name] = (error as Error).message;
    }
    expect(home.heads(SOURCE)).toEqual([]);
    artifact(home.dir, "refusals.json", refusals);
  });

  it("a delivery holding no Instagram export yields a row, or is refused", async () => {
    const home = openTestHome();
    const files = {
      "files/notes.txt": Buffer.from("not an export"),
      "files/takeout.zip": zipOf(home.dir, { "Takeout/My Activity/Search/MyActivity.json": Buffer.from("[]") }, "takeout.zip"),
      "files/facebook/your_facebook_activity/posts/posts_on_other_pages_and_profiles.json": Buffer.from("[]"),
      "files/facebook/personal_information/personal_information/personal_information.json": exportMembers()[PROFILE]!,
    };
    const rows = await collect(instagram.read(deliver(home, SOURCE, files, facts), home.blobs));
    expect(rows).toEqual([]);
  });

  it("an item that breaks the shape lands, or refuses the others", async () => {
    const home = openTestHome();
    const members = exportMembers();
    const thread = JSON.parse(members[`${THREAD_B}/message_2.json`]!.toString("utf8")) as { messages: JsonObject[] };
    thread.messages[0]!.timestamp_ms = "yesterday";
    const files = {
      ...members,
      [`${THREAD_B}/message_2.json`]: metaJson(thread),
      "your_instagram_activity/likes/liked_posts.json": metaJson([{}, { timestamp: 1757000000, media: [], label_values: [], fbid: "17900000000000104" }]),
    };
    const landed = await home.land(instagram, deliver(home, SOURCE, files, facts));
    expect(landed.refusals.map((refusal) => refusal.violations)).toEqual([["the item states nothing"], ["timestamp_ms must be an integer"]]);
    expect(home.heads(SOURCE, ["like"]).filter((head) => head.key.startsWith("sha256:"))).toHaveLength(1);
    artifact(home.dir, "landed.json", counts(landed));
  });

  it("text Meta wrote right is changed by the repair", async () => {
    const home = openTestHome();
    const members = exportMembers();
    const kept = ["already right ☕", "café", "plain"];
    const files = { ...members, "your_instagram_activity/comments/reels_comments.json": metaJson({ comments_reels_comments: kept.map((value, index) => ({ string_map_data: { Comment: { value }, Time: { timestamp: 1757000000 + index } } })) }) };
    await home.land(instagram, deliver(home, SOURCE, files, facts));
    const comments = home.heads(SOURCE, ["comment"]).map((head) => ((head.content as { string_map_data: { Comment?: { value: string } } }).string_map_data.Comment?.value));
    expect(comments).toEqual(expect.arrayContaining([...kept, "Lovely 👍"]));
    expect(mojibake("Lovely 👍")).not.toBe("Lovely 👍");
  });
});
