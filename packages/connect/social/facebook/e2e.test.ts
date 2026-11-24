import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse, type Json, type JsonObject } from "@lifestreamprotocol/core";
import { artifact, collect, counts, deliver, openTestHome, type Head, type TestHome } from "../../test/drive.js";
import { Refused } from "../../shared/refused.js";
import { extracted, metaJson, zipOf } from "../meta/test/fixtures.js";
import { facebook } from "./reader.js";
import { EXPORTED_AT, exportMembers, LATER_AT, MEDIA, PROFILE, profile, SOURCE, THREAD_B } from "./test/fixtures.js";

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

const blobFiles = (head: Head): Json[] => ((head.content as { blobs?: JsonObject[] }).blobs ?? []).map((blob) => blob.file!);

describe("facebook export: each of these is impossible", () => {
  it("an export lands other heads than expected, or a file it names is no blob", async () => {
    const home = openTestHome();
    const files = { "facebook-person.a.zip": zipOf(home.dir, exportMembers(), "facebook-person.a.zip") };
    const landed = await home.land(facebook, deliver(home, SOURCE, files, facts));
    const heads = home.heads(SOURCE);
    expect(summary(heads)).toEqual(GOLDEN);
    expect(landed).toMatchObject({ new: GOLDEN.length, refused: 0, gone: 0 });

    const status = find(heads, "post", (content) => Array.isArray(content.attachments) && JSON.stringify(content).includes("synthetic status"));
    expect((status.content as { data: Json }).data).toEqual([{ post: "नमस्ते, a synthetic status ☕" }]);
    expect((status.content as { title: string }).title).toBe("Person A ने एक फ़ोटो अपडेट की।");
    expect(blobFiles(status)).toEqual(["your_facebook_activity/posts/media/mobailaapaloda_1000000000000001/10000000000000001_n.jpg"]);
    const other = find(heads, "post", (content) => content.fbid === "100000000000001");
    expect(other.key).toBe("100000000000001");
    expect((other.content as { label_values: JsonObject[] }).label_values[0]).toEqual({ label: "मैसेज", value: "A synthetic post on another profile" });
    expect(heads.filter((head) => head.kind === "post" && head.start_ms === Date.parse("2026-09-05T12:00:00Z"))).toHaveLength(2);

    const likes = heads.filter((head) => head.kind === "like").map((head) => head.key);
    expect(likes.filter((key) => !key.startsWith("sha256:"))).toEqual([
      "https://www.facebook.com/100000000000301",
      "https://www.facebook.com/person.b/posts/pfbid000000000000000000000000001",
      "https://www.facebook.com/person.b/posts/pfbid000000000000000000000000001?comment_id=100000000000102",
    ]);
    expect(likes.filter((key) => key.startsWith("sha256:"))).toHaveLength(1);
    expect(heads.filter((head) => head.kind === "follow").map((head) => head.key)).toEqual(["Example Page", "Person B"]);

    const photo = find(heads, "msg", (content) => Array.isArray(content.photos));
    expect(blobFiles(photo)).toEqual([`${THREAD_B}/photos/10000000000000010_n.png`]);
    expect((photo.content as { photos: JsonObject[] }).photos).toHaveLength(2);
    expect(blobFiles(find(heads, "msg", (content) => content.sticker !== undefined))).toEqual(["your_facebook_activity/messages/stickers_used/10000000000000013_n.png"]);
    expect(blobFiles(find(heads, "msg", (content) => content.gifs !== undefined))).toEqual([`${THREAD_B}/gifs/10000000000000011_n.gif`]);
    expect(find(heads, "msg", (content) => content.content === "नमस्ते ✨").content).toMatchObject({ reactions: [{ reaction: "❤", actor: "Person A" }] });
    expect(blobFiles(find(heads, "chat", (content) => content.title === "Example Group"))).toEqual(["your_facebook_activity/messages/inbox/group_1000000000000003/photos/10000000000000014_n.jpg"]);

    const rows = await collect(facebook.read(deliver(home, SOURCE, files, facts), home.blobs));
    const handed = new Set(rows.flatMap((row) => (row.streamed ?? []).map((each) => each.hash)));
    expect([...handed].sort()).toEqual(Object.values(MEDIA).map(sha).sort());
    expect(rows.some((row) => /likes_and_reactions_1|pages_and_profiles_you_follow|your_friends/u.test(row.locator ?? ""))).toBe(false);
    artifact(home.dir, "heads.json", { landed: counts(landed), heads });
  });

  it("the extracted export lands other records than its ZIP, or the same export again writes a new version", async () => {
    const zipped = openTestHome();
    await zipped.land(facebook, deliver(zipped, SOURCE, { "facebook.zip": zipOf(zipped.dir, exportMembers(), "facebook.zip") }, facts));
    const home = openTestHome();
    const files = extracted(exportMembers(), "files/facebook-person.a-2026-09-20");
    await home.land(facebook, deliver(home, SOURCE, files, facts));
    const versions = (one: TestHome) => one.heads(SOURCE).map((head) => [head.kind, head.key, head.version]);
    expect(versions(home)).toEqual(versions(zipped));
    for (const bytes of Object.values(MEDIA)) expect(home.blobs.bytes(sha(bytes)).equals(bytes)).toBe(true);
    const again = await home.land(facebook, deliver(home, SOURCE, files, { exported_at: LATER_AT }));
    expect(again).toMatchObject({ new: 0, changed: 0, gone: 0, restated: GOLDEN.length });
    artifact(home.dir, "parity.json", { again: counts(again), versions: versions(home) });
  });

  it("an export lands under a profile the file does not name", async () => {
    const home = openTestHome();
    const members = exportMembers();
    const land = (source: string, files: Record<string, Buffer>) => home.land(facebook, deliver(home, source, files, facts)).then(() => undefined, (thrown: unknown) => thrown as Error);
    const error = await land("facebook:person.b:export", members);
    expect(error).toBeInstanceOf(Refused);
    expect(error!.message).toMatch(/the export is person\.a's, and the source is person\.b's/u);
    expect(home.heads("facebook:person.b:export")).toEqual([]);
    const numbered = { ...members, [PROFILE]: profile(undefined, "https://www.facebook.com/profile.php?id=100000000000009") };
    expect(await land("facebook:100000000000009:export", numbered)).toBeUndefined();
    expect((await land(SOURCE, numbered))!.message).toMatch(/the export is 100000000000009's, and the source is person\.a's/u);
    expect((await land(SOURCE, { ...members, [PROFILE]: metaJson({ profile_v2: {} }) }))!.message).toMatch(/names no account/u);
  });

  it("a malformed file or message refuses more than itself", async () => {
    const members = exportMembers();
    const comments = "your_facebook_activity/comments_and_reactions/comments.json";
    const thread = `${THREAD_B}/message_1.json`;
    const cases: [string, Record<string, Buffer>, string, RegExp][] = [
      ["comments under another member", { ...members, [comments]: metaJson({ comments_v3: [] }) }, comments, /comments\.json lists its items under "comments_v3", not "comments_v2"/u],
      ["a file that opens as no object", { ...members, [comments]: Buffer.from("[]") }, comments, /comments\.json does not open as \{"comments_v2": \[\.\.\.\]\}/u],
      ["an object closed twice", { ...members, [comments]: Buffer.from('{"comments_v2": []}}') }, comments, /comments\.json: bytes follow the top-level value/u],
      ["a message that is no object", { ...members, [thread]: metaJson({ thread_path: "inbox/personb_1000000000000001", messages: [1] }) }, `${thread} messages[0]`, /message_1\.json messages\[0\] is not a JSON object/u],
      ["a message that states the connector's own member", { ...members, [thread]: metaJson({ thread_path: "inbox/personb_1000000000000001", messages: [{ thread_path: "x" }] }) }, `${thread} messages[0]`, /states a thread_path member/u],
    ];
    const posts = GOLDEN.filter(([kind]) => kind === "post").length;
    for (const [name, files, key, message] of cases) {
      const home = openTestHome();
      const landed = await home.land(facebook, deliver(home, SOURCE, files, facts));
      expect(landed.refusals, name).toEqual([{ kind: "file", key, violations: [expect.stringMatching(message)] }]);
      expect(home.heads(SOURCE, ["post"]), name).toHaveLength(posts);
    }
  });
});
