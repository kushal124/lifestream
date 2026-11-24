import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Json, JsonObject } from "@lifestreamprotocol/core";
import { artifact, collect, counts, deliver, openTestHome, readStoring, type Head, type TestHome } from "../../test/drive.js";
import { Refused } from "../../shared/refused.js";
import { xArchive } from "./reader.js";
import { ACCOUNT, archiveMembers, archiveZip, dataFile, EXPORTED_AT, LATER_AT, MEDIA, MEDIA_FILES, OTHER, SOURCE, ZIP_NAME } from "./test/fixtures.js";

const hash = (bytes: Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const at = (iso: string): number => Date.parse(iso);

const EXPECTED: [kind: string, key: string, start_ms: number | null, files: string[]][] = [
  ["like", "1600000000000000001", null, []],
  ["like", "1600000000000000002", null, []],
  ["msg", "1900000000000000001", at("2026-09-02T10:00:00.250Z"), ["1900000000000000001-AbCdEfGh.jpg"]],
  ["msg", "1900000000000000002", at("2026-09-02T10:05:00.000Z"), []],
  ["msg", "1900000000000000003", at("2026-09-01T07:00:00.000Z"), []],
  ["msg", "1950000000000000011", at("2026-09-05T20:00:00.000Z"), ["1950000000000000011-SyntheticGroupClip.mp4"]],
  ["post", "1800000000000000001", at("2026-09-01T08:00:00Z"), ["1800000000000000001-AbCdEfGhIjKlMnO.jpg"]],
  ["post", "1800000000000000002", at("2026-09-02T09:30:15Z"), []],
  ["post", "1800000000000000003", at("2026-09-03T18:45:00Z"), ["1800000000000000003-SyntheticVid0003.mp4"]],
  ["post", "1800000000000000004", at("2026-09-04T07:00:00Z"), []],
];

function summary(heads: Head[]): typeof EXPECTED {
  return heads.map((head) => [head.kind, head.key, head.start_ms, ((head.content as { blobs?: { file: string }[] }).blobs ?? []).map((blob) => blob.file)]);
}

async function land(home: TestHome, files: Record<string, Buffer>, exported_at = EXPORTED_AT) {
  return home.land(xArchive, deliver(home, SOURCE, files, { exported_at }));
}

async function refusal(home: TestHome, files: Record<string, Buffer>, source = SOURCE): Promise<Error> {
  return collect(xArchive.read(deliver(home, source, files, { exported_at: EXPORTED_AT }), home.blobs)).then(
    () => expect.fail("the delivery was read"),
    (thrown: unknown) => thrown as Error,
  );
}

describe("x archive: each of these is impossible", () => {
  it("an archive's ZIP lands other heads than expected, or a media file it holds is no blob", async () => {
    const home = openTestHome();
    const files = { [ZIP_NAME]: archiveZip(home.dir, archiveMembers()) };
    const landed = await land(home, files);
    expect(landed).toMatchObject({ new: EXPECTED.length, refused: 0, duplicated: 0, gone: 0 });
    const heads = home.heads(SOURCE);
    expect(summary(heads)).toEqual(EXPECTED);

    const photoPost = heads.find((head) => head.key === "1800000000000000001")!;
    const tweet = (photoPost.content as { tweet: JsonObject }).tweet;
    expect(Object.keys(photoPost.content as JsonObject).sort()).toEqual(["blobs", "tweet", "type"]);
    expect(tweet).toMatchObject({ id_str: "1800000000000000001", created_at: "Tue Sep 01 08:00:00 +0000 2026", favorite_count: "2", possibly_sensitive: false });
    expect((tweet.extended_entities as { media: JsonObject[] }).media[0]!.media_url_https).toBe("https://pbs.twimg.com/media/AbCdEfGhIjKlMnO.jpg");
    expect((photoPost.content as { blobs: Json }).blobs).toEqual([{ hash: hash(MEDIA.photo), bytes: MEDIA.photo.length, media_type: "image/jpeg", role: "attachment", file: "1800000000000000001-AbCdEfGhIjKlMnO.jpg" }]);
    expect(photoPost.time).toEqual({ start_ms: at("2026-09-01T08:00:00Z"), precision: "s" });

    const message = heads.find((head) => head.key === "1900000000000000002")!;
    expect(message.content).toEqual({
      type: "x.msg", conversationId: `${ACCOUNT}-${OTHER}`,
      messageCreate: { recipientId: ACCOUNT, reactions: [], urls: [], text: "synthetic reply message", mediaUrls: [], senderId: OTHER, id: "1900000000000000002", createdAt: "2026-09-02T10:05:00.000Z", editHistory: [] },
    });
    expect(Object.keys(heads.find((head) => head.key === "1900000000000000003")!.content as JsonObject).sort()).toEqual(["conversationId", "type", "welcomeMessageCreate"]);
    expect((heads.find((head) => head.key === "1800000000000000004")!.content as { tweet: JsonObject }).tweet.deleted_at).toBe("Sat Sep 05 07:00:00 +0000 2026");
    expect(heads.find((head) => head.key === "1600000000000000001")!.content).toEqual({
      type: "x.like", like: { tweetId: "1600000000000000001", fullText: "synthetic liked post one", expandedUrl: "https://x.com/i/web/status/1600000000000000001" },
    });

    const rows = await readStoring(xArchive, deliver(home, SOURCE, files, { exported_at: EXPORTED_AT }), home.blobs);
    const handed = rows.flatMap((row) => (row.streamed ?? []).map((each) => [each.hash, row.blobs ?? []] as const));
    expect(handed.map(([blob]) => blob).sort()).toEqual(Object.values(MEDIA).map(hash).sort());
    for (const [blob, listed] of handed) expect(listed).toContain(blob);
    for (const bytes of Object.values(MEDIA)) expect(home.blobs.bytes(hash(bytes)).equals(bytes)).toBe(true);
    expect(rows.some((row) => JSON.stringify(row.content).includes("synthetic grok") || JSON.stringify(row.content).includes("follower"))).toBe(false);
    artifact(home.dir, "heads.json", { landed: counts(landed), heads });
  });

  it("the archive's extracted members land other records than its ZIP", async () => {
    const zipped = openTestHome();
    await land(zipped, { [ZIP_NAME]: archiveZip(zipped.dir, archiveMembers()) });
    const extracted = openTestHome();
    const members = Object.fromEntries(Object.entries(archiveMembers()).map(([path, bytes]) => [`files/twitter-2026-09-10/${path}`, bytes]));
    const landed = await land(extracted, members);
    const versions = (home: TestHome) => home.heads(SOURCE).map((head) => [head.kind, head.key, head.version]);
    expect(versions(extracted)).toEqual(versions(zipped));
    for (const bytes of Object.values(MEDIA)) expect(extracted.blobs.bytes(hash(bytes)).equals(bytes)).toBe(true);
    artifact(extracted.dir, "parity.json", { landed: counts(landed), versions: versions(extracted) });
  });

  it("the same archive again writes a new version", async () => {
    const home = openTestHome();
    const files = { [ZIP_NAME]: archiveZip(home.dir, archiveMembers()) };
    await land(home, files);
    const again = await land(home, files, LATER_AT);
    expect(again).toMatchObject({ new: 0, changed: 0, gone: 0, restated: EXPECTED.length });
    artifact(home.dir, "again.json", counts(again));
  });

  it("a later archive leaves a changed post's head, or a post it lacks goes", async () => {
    const home = openTestHome();
    await land(home, { [ZIP_NAME]: archiveZip(home.dir, archiveMembers()) });
    const later = await land(home, { [ZIP_NAME]: archiveZip(home.dir, archiveMembers("later"), "later.zip") }, LATER_AT);
    expect(later).toMatchObject({ changed: 1, new: 1, gone: 0, restated: EXPECTED.length - 2 });
    expect(later.changedPaths).toEqual({ "tweet.favorite_count": 1 });
    const reply = home.heads(SOURCE, ["post"]).find((head) => head.key === "1800000000000000002")!;
    expect([reply.gone, reply.stated_ms]).toEqual([false, at(EXPORTED_AT)]);
    artifact(home.dir, "later.json", { later: counts(later), heads: home.heads(SOURCE) });
  });

  it("an archive of another account lands anything", async () => {
    const home = openTestHome();
    const error = await refusal(home, { [ZIP_NAME]: archiveZip(home.dir, archiveMembers("first", "1000000000000000009")) });
    expect(error).toBeInstanceOf(Refused);
    expect(error.message).toMatch(/data\/account\.js names account 1000000000000000009, not the source's account 1000000000000000001/u);
    expect(home.heads(SOURCE)).toEqual([]);
    artifact(home.dir, "account.json", { refusal: error.message });
  });

  it("a delivery that holds no archive yields a row, or a source that is not an export reads one", async () => {
    const home = openTestHome();
    const { "data/manifest.js": _manifest, ...unmarked } = archiveMembers();
    const others = { "notes.txt": Buffer.from("not an archive"), "other.zip": archiveZip(home.dir, { "Takeout/Mail/All mail.mbox": Buffer.from("From x\n") }, "other.zip") };
    expect(await collect(xArchive.read(deliver(home, SOURCE, { ...unmarked, ...others }, { exported_at: EXPORTED_AT }), home.blobs))).toEqual([]);
    const files = { [ZIP_NAME]: archiveZip(home.dir, archiveMembers()), ...others };
    expect(await collect(xArchive.read(deliver(home, SOURCE, files, { exported_at: EXPORTED_AT }), home.blobs))).toHaveLength(EXPECTED.length);
    for (const name of [`x:${ACCOUNT}:cloud`, `twitter:${ACCOUNT}:export`, "x:export"]) expect(await refusal(home, files, name), name).toBeInstanceOf(Refused);
    artifact(home.dir, "routing.json", { files: Object.keys(files) });
  });

  it("a malformed data file, element or message refuses more than itself, a malformed archive lands anything, or a file named .zip that is no zip is passed over unnamed", async () => {
    const home = openTestHome();
    const members = archiveMembers();
    const tweet = (fields: JsonObject) => dataFile("tweets", 0, [{ tweet: { id_str: "1800000000000000009", id: "1800000000000000009", full_text: "synthetic", ...fields } }]);
    const message = "data/direct-messages.js[0].dmConversation.messages[0]";
    const parts: [string, Record<string, Buffer>, string, string, RegExp][] = [
      ["a cut array", { ...members, "data/like.js": Buffer.from('window.YTD.like.part0 = [ {"like":{"tweetId":"1600000000000000001"}}') }, "data/like.js", "msg", /data\/like\.js: the top-level array is not closed/u],
      ["an assignment naming another file", { ...members, "data/like.js": dataFile("tweets", 0, []) }, "data/like.js", "msg", /data\/like\.js does not begin window\.YTD\.like\.part0 =/u],
      ["an assignment naming another part", { ...members, "data/tweets-part1.js": dataFile("tweets", 0, []) }, "data/tweets-part1.js", "like", /data\/tweets-part1\.js does not begin window\.YTD\.tweets\.part1 =/u],
      ["a file that is no assignment", { ...members, "data/like.js": Buffer.from("[]") }, "data/like.js", "msg", /data\/like\.js does not begin window\.YTD/u],
      ["an element that is no post", { ...members, "data/tweets.js": dataFile("tweets", 0, ["synthetic"]) }, "data/tweets.js[0]", "like", /data\/tweets\.js\[0\] is not \{tweet: \{…\}\}/u],
      ["a post with no id", { ...members, "data/tweets.js": tweet({ id_str: null, created_at: "Tue Sep 01 08:00:00 +0000 2026" }) }, "data/tweets.js[0]", "like", /data\/tweets\.js\[0\] states no id_str of digits/u],
      ["a post time that is no instant", { ...members, "data/tweets.js": tweet({ created_at: "Tue Sep 31 08:00:00 +0000 2026" }) }, "data/tweets.js[0]", "like", /data\/tweets\.js\[0\] created_at "Tue Sep 31/u],
      ["a post that states the connector's own member", { ...members, "data/tweets.js": dataFile("tweets", 0, [{ tweet: {}, type: "x" }]) }, "data/tweets.js[0]", "like", /data\/tweets\.js\[0\] states a type member/u],
      ["a message with no id", { ...members, "data/direct-messages.js": dataFile("direct_messages", 0, [{ dmConversation: { conversationId: "1-2", messages: [{ messageCreate: { createdAt: "2026-09-02T10:00:00.000Z" } }] } }]) }, message, "like", /direct-messages\.js\[0\]\.dmConversation\.messages\[0\]\.messageCreate states no id/u],
      ["a message time not in UTC", { ...members, "data/direct-messages.js": dataFile("direct_messages", 0, [{ dmConversation: { conversationId: "1-2", messages: [{ messageCreate: { id: "1", createdAt: "2026-09-02 10:00" } }] } }]) }, message, "like", /messages\[0\] "2026-09-02 10:00"/u],
    ];
    const refusals: Record<string, string> = {};
    for (const [name, files, key, beside, message] of parts) {
      const scratch = openTestHome();
      const landed = await land(scratch, files);
      expect(landed.refusals, name).toEqual([{ kind: "file", key, violations: [expect.stringMatching(message)] }]);
      expect(scratch.heads(SOURCE, [beside]), name).toHaveLength(EXPECTED.filter(([kind]) => kind === beside).length);
      refusals[name] = landed.refusals[0]!.violations[0]!;
    }
    const damaged = await land(home, { [ZIP_NAME]: Buffer.from("PK\x03\x04 not a zip") });
    expect(damaged.refusals).toEqual([{ kind: "file", key: ZIP_NAME, violations: [expect.stringMatching(/not a ZIP archive/u)] }]);
    const named = await land(home, { [ZIP_NAME]: Buffer.from("window.YTD.like.part0 = []") });
    expect([named.new, named.refusals]).toEqual([0, [{ kind: "file", key: ZIP_NAME, violations: [expect.stringContaining("named .zip, its first bytes are not a zip's")] }]]);
    refusals["a file named .zip that is no zip"] = named.refusals[0]!.violations[0]!;
    const { "data/account.js": _account, ...unaccounted } = members;
    const wholes: [string, Record<string, Buffer>, RegExp][] = [
      ["no account file", unaccounted, /the delivery holds no data\/account\.js/u],
      ["a ZIP and its extraction together", { ...members, [ZIP_NAME]: archiveZip(home.dir, members) }, /the delivery holds 2 X archives/u],
    ];
    for (const [name, files, message] of wholes) {
      const error = await home.land(xArchive, deliver(home, SOURCE, files, { exported_at: EXPORTED_AT })).then(() => undefined, (thrown: unknown) => thrown);
      expect(error, name).toBeInstanceOf(Refused);
      expect((error as Error).message, name).toMatch(message);
      refusals[name] = (error as Error).message;
    }
    expect(home.heads(SOURCE)).toEqual([]);
    artifact(home.dir, "refusals.json", refusals);
  });

  it("an item that breaks the shape lands, or refuses the others", async () => {
    const home = openTestHome();
    const members = {
      ...archiveMembers(),
      "data/like.js": dataFile("like", 0, [
        { like: { tweetId: "1600000000000000001", fullText: "synthetic liked post one" } },
        { like: { tweetId: "1600000000000000002", fullText: 2 } },
      ]),
      "data/deleted-tweets.js": dataFile("deleted_tweets", 0, [{ tweet: { id_str: "1800000000000000004", created_at: "Fri Sep 04 07:00:00 +0000 2026", full_text: ["synthetic"] } }]),
    };
    const landed = await land(home, members);
    expect(landed).toMatchObject({ new: EXPECTED.length - 2, refused: 2 });
    expect(landed.refusals.map((refused) => [refused.key, refused.violations])).toEqual([
      ["1800000000000000004", ["tweet.full_text must be a string"]],
      ["1600000000000000002", ["like.fullText must be a string"]],
    ]);
    artifact(home.dir, "landed.json", counts(landed));
  });
});
