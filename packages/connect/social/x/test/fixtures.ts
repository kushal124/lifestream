import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isObject, type Json, type JsonObject } from "@lifestreamprotocol/core";
import type { Fixture, Spoiled } from "../../../test/drive.js";
import { writeZip } from "../../../test/drive.js";

export const ACCOUNT = "1000000000000000001";
export const OTHER = "1000000000000000002";
export const THIRD = "1000000000000000003";
export const SOURCE = `x:${ACCOUNT}:export`;
export const EXPORTED_AT = "2026-09-10T12:00:00.000Z";
export const LATER_AT = "2026-10-01T12:00:00.000Z";
export const ZIP_NAME = "twitter-2026-09-10-0000000000000000000000000000000000000000000000000000000000000001.zip";

export const MEDIA = {
  photo: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("synthetic post photo 0001")]),
  video: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42 synthetic post video 0003")]),
  dm: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("synthetic message photo 0001")]),
  group: Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42 synthetic group video 0001")]),
};

export const MEDIA_FILES = {
  photo: "data/tweets_media/1800000000000000001-AbCdEfGhIjKlMnO.jpg",
  video: "data/tweets_media/1800000000000000003-SyntheticVid0003.mp4",
  dm: "data/direct_messages_media/1900000000000000001-AbCdEfGh.jpg",
  group: "data/direct_messages_group_media/1950000000000000011-SyntheticGroupClip.mp4",
};

export function dataFile(name: string, part: number, elements: Json[]): Buffer {
  return Buffer.from(`window.YTD.${name}.part${part} = ${JSON.stringify(elements, null, 2).replaceAll('": ', '" : ')}`);
}

const sizes = (w: string, h: string) => ({
  medium: { w, h, resize: "fit" }, small: { w, h, resize: "fit" }, large: { w, h, resize: "fit" }, thumb: { w: "150", h: "150", resize: "crop" },
});

function photoMedia(): JsonObject {
  return {
    expanded_url: "https://x.com/person_a/status/1800000000000000001/photo/1", indices: ["20", "43"], url: "https://t.co/AAAAAAAAA1",
    media_url: "http://pbs.twimg.com/media/AbCdEfGhIjKlMnO.jpg", id_str: "1800000000000000101", id: "1800000000000000101",
    media_url_https: "https://pbs.twimg.com/media/AbCdEfGhIjKlMnO.jpg", sizes: sizes("1200", "900"), type: "photo", display_url: "pic.x.com/AAAAAAAAA1",
  };
}

function post(id: string, text: string, created_at: string, more: JsonObject = {}): JsonObject {
  return {
    tweet: {
      edit_info: { initial: { editTweetIds: [id], editableUntil: "2026-09-01T09:00:00.000Z", editsRemaining: "5", isEditEligible: true } },
      retweeted: false, source: '<a href="https://example.com/app" rel="nofollow">Example App</a>',
      entities: { hashtags: [], symbols: [], user_mentions: [], urls: [] },
      display_text_range: ["0", String(text.length)], favorite_count: "0", id_str: id, truncated: false, retweet_count: "0", id,
      created_at, favorited: false, full_text: text, lang: "en",
      ...more,
    },
  };
}

export function archiveMembers(version: "first" | "later" = "first", account = ACCOUNT): Record<string, Buffer> {
  const photoPost = post("1800000000000000001", "synthetic post one https://t.co/AAAAAAAAA1", "Tue Sep 01 08:00:00 +0000 2026", {
    favorite_count: version === "first" ? "2" : "3", possibly_sensitive: false,
    entities: { hashtags: [], symbols: [], user_mentions: [], urls: [], media: [photoMedia()] },
    extended_entities: { media: [photoMedia()] },
  });
  const reply = post("1800000000000000002", "@person_b synthetic reply two", "Wed Sep 02 09:30:15 +0000 2026", {
    entities: { hashtags: [], symbols: [], user_mentions: [{ name: "Person B", screen_name: "person_b", indices: ["0", "9"], id_str: OTHER, id: OTHER }], urls: [] },
    in_reply_to_status_id_str: "1700000000000000001", in_reply_to_user_id: OTHER, in_reply_to_status_id: "1700000000000000001",
    in_reply_to_screen_name: "person_b", in_reply_to_user_id_str: OTHER,
  });
  const videoPost = post("1800000000000000003", "synthetic post three https://t.co/AAAAAAAAA3", "Thu Sep 03 18:45:00 +0000 2026", {
    extended_entities: {
      media: [{
        expanded_url: "https://x.com/person_a/status/1800000000000000003/video/1", indices: ["21", "44"], url: "https://t.co/AAAAAAAAA3",
        media_url: "http://pbs.twimg.com/ext_tw_video_thumb/1800000000000000103/pu/img/SyntheticThumb03.jpg", id_str: "1800000000000000103", id: "1800000000000000103",
        media_url_https: "https://pbs.twimg.com/ext_tw_video_thumb/1800000000000000103/pu/img/SyntheticThumb03.jpg", sizes: sizes("720", "1280"), type: "video",
        display_url: "pic.x.com/AAAAAAAAA3",
        video_info: { aspect_ratio: ["9", "16"], duration_millis: "4000", variants: [{ bitrate: "632000", content_type: "video/mp4", url: "https://video.twimg.com/ext_tw_video/1800000000000000103/pu/vid/SyntheticVid0003.mp4?tag=12" }] },
      }],
    },
  });
  const deleted = {
    tweet: {
      ...post("1800000000000000004", "synthetic deleted post four", "Fri Sep 04 07:00:00 +0000 2026").tweet as JsonObject,
      deleted_at: "Sat Sep 05 07:00:00 +0000 2026",
    },
  };
  const likes = [
    { like: { tweetId: "1600000000000000001", fullText: "synthetic liked post one", expandedUrl: "https://x.com/i/web/status/1600000000000000001" } },
    { like: { tweetId: "1600000000000000002", fullText: "synthetic liked post two", expandedUrl: "https://x.com/i/web/status/1600000000000000002" } },
    ...(version === "later" ? [{ like: { tweetId: "1600000000000000003", fullText: "synthetic liked post three", expandedUrl: "https://x.com/i/web/status/1600000000000000003" } }] : []),
  ];
  const direct = [{
    dmConversation: {
      conversationId: `${ACCOUNT}-${OTHER}`,
      messages: [
        { messageCreate: {
          recipientId: OTHER, reactions: [], urls: [], text: "synthetic message with a photo https://t.co/AAAAAAAAB1",
          mediaUrls: ["https://ton.twitter.com/1.1/ton/data/dm/1900000000000000001/1900000000000000101/AbCdEfGh.jpg"],
          senderId: ACCOUNT, id: "1900000000000000001", createdAt: "2026-09-02T10:00:00.250Z", editHistory: [],
        } },
        { messageCreate: {
          recipientId: ACCOUNT, reactions: [], urls: [], text: "synthetic reply message", mediaUrls: [], senderId: OTHER,
          id: "1900000000000000002", createdAt: "2026-09-02T10:05:00.000Z", editHistory: [],
        } },
        { welcomeMessageCreate: {
          recipientId: ACCOUNT, urls: [{ url: "https://t.co/AAAAAAAAB3", expanded: "https://example.com/welcome", display: "example.com/welcome" }],
          text: "synthetic welcome message https://t.co/AAAAAAAAB3", mediaUrls: [], senderId: OTHER, id: "1900000000000000003", createdAt: "2026-09-01T07:00:00.000Z",
        } },
      ],
    },
  }];
  const group = [{
    dmConversation: {
      conversationId: "1950000000000000001",
      messages: [
        { participantsLeave: { userIds: [THIRD], createdAt: "2026-09-06T12:00:00.000Z" } },
        { messageCreate: {
          reactions: [], urls: [], text: "synthetic group message with a clip",
          mediaUrls: ["https://video.twimg.com/dm_video/1950000000000000111/vid/avc1/320x568/SyntheticGroupClip.mp4?tag=1"],
          senderId: OTHER, id: "1950000000000000011", createdAt: "2026-09-05T20:00:00.000Z", editHistory: [],
        } },
        { participantsJoin: { initiatingUserId: ACCOUNT, userIds: [THIRD], createdAt: "2026-09-05T19:00:00.000Z" } },
        { joinConversation: { initiatingUserId: OTHER, participantsSnapshot: [ACCOUNT, OTHER], createdAt: "2026-09-05T18:00:00.000Z" } },
      ],
    },
  }];
  const manifest = {
    userInfo: { accountId: account, userName: "person_a", displayName: "Person A" },
    archiveInfo: { sizeBytes: "1000", generationDate: "2026-09-10T12:00:00.000Z", isPartialArchive: false, maxPartSizeBytes: "53687091200" },
    readmeInfo: { fileName: "data/README.txt", directory: "data/", name: "README.txt" },
    dataTypes: {
      account: { files: [{ fileName: "data/account.js", globalName: "YTD.account.part0", count: "1" }] },
      tweets: { mediaDirectory: "data/tweets_media", files: [{ fileName: "data/tweets.js", globalName: "YTD.tweets.part0", count: "2" }, { fileName: "data/tweets-part1.js", globalName: "YTD.tweets.part1", count: "1" }] },
      tweetsMedia: { mediaDirectory: "data/tweets_media" },
    },
  };
  return {
    "Your archive.html": Buffer.from("<!DOCTYPE html><html><body>synthetic</body></html>"),
    "assets/images/favicon.ico": Buffer.from([0, 0, 1, 0]),
    "data/README.txt": Buffer.from("synthetic readme"),
    "data/manifest.js": Buffer.from(`window.__THAR_CONFIG = ${JSON.stringify(manifest, null, 2)}`),
    "data/account.js": dataFile("account", 0, [{ account: { email: "person-a@example.com", createdVia: "web", username: "person_a", accountId: account, createdAt: "2015-01-01T00:00:00.000Z", accountDisplayName: "Person A" } }]),
    "data/tweets.js": dataFile("tweets", 0, version === "first" ? [photoPost, reply] : [photoPost]),
    "data/tweets-part1.js": dataFile("tweets", 1, [videoPost]),
    "data/tweet-headers.js": dataFile("tweet_headers", 0, [{ tweet: { tweet_id: "1800000000000000001", user_id: account, created_at: "2026-09-01T08:00:00.000Z" } }]),
    "data/deleted-tweets.js": dataFile("deleted_tweets", 0, [deleted]),
    "data/like.js": dataFile("like", 0, likes),
    "data/direct-messages.js": dataFile("direct_messages", 0, direct),
    "data/direct-message-headers.js": dataFile("direct_message_headers", 0, [{ dmConversation: { conversationId: `${ACCOUNT}-${OTHER}`, messages: [{ messageCreate: { id: "1900000000000000001", senderId: ACCOUNT, recipientId: OTHER, createdAt: "2026-09-02T10:00:00.250Z" } }] } }]),
    "data/direct-messages-group.js": dataFile("direct_messages_group", 0, group),
    "data/follower.js": dataFile("follower", 0, [{ follower: { accountId: OTHER, userLink: `https://twitter.com/intent/user?user_id=${OTHER}` } }]),
    "data/grok-chat-item.js": dataFile("grok_chat_item", 0, []),
    "data/grok_chat_media/2000000000000000001-1.jpg": Buffer.from("synthetic grok image"),
    "data/profile_media/1000000000000000001-AbCdEfGh.jpg": Buffer.from("synthetic avatar"),
    [MEDIA_FILES.photo]: MEDIA.photo,
    [MEDIA_FILES.video]: MEDIA.video,
    [MEDIA_FILES.dm]: MEDIA.dm,
    [MEDIA_FILES.group]: MEDIA.group,
  };
}

export function archiveZip(dir: string, members: Record<string, Buffer>, name = ZIP_NAME): Buffer {
  const path = join(dir, name);
  writeZip(path, Object.entries(members).map(([member, bytes]) => ({ name: member, bytes, method: member.endsWith(".js") ? ("deflate" as const) : ("stored" as const) })));
  return readFileSync(path);
}

const HEADS: Readonly<Record<string, (element: JsonObject) => string[]>> = {
  tweets: (element) => [`post ${(element.tweet as JsonObject).id_str as string}`],
  "deleted-tweets": (element) => [`post ${(element.tweet as JsonObject).id_str as string}`],
  like: (element) => [`like ${(element.like as JsonObject).tweetId as string}`],
  "direct-messages": messageHeads,
  "direct-messages-group": messageHeads,
};

function messageHeads(element: JsonObject): string[] {
  return ((element.dmConversation as JsonObject).messages as JsonObject[]).flatMap((message) => {
    const stated = message.messageCreate ?? message.welcomeMessageCreate;
    return isObject(stated) ? [`msg ${stated.id as string}`] : [];
  });
}

export const xFixture: Fixture = (folder) => {
  const files: Record<string, Spoiled> = {};
  for (const [path, bytes] of Object.entries(archiveMembers())) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), bytes);
    const match = /^data\/([a-z-]+?)(?:-part(\d+))?\.js$/u.exec(path);
    const heads = match === null ? undefined : HEADS[match[1]!];
    if (path === "data/account.js") files[path] = "trust";
    else if (heads === undefined) files[path] = { alone: [] };
    else {
      const text = bytes.toString("utf8");
      const elements = JSON.parse(text.slice(text.indexOf("=") + 1)) as JsonObject[];
      const name = text.slice("window.YTD.".length, text.indexOf(".part"));
      const part = match![2] === undefined ? 0 : Number(match![2]);
      const half = Math.floor(bytes.length / 2);
      const closed = elements.filter((_, index) => dataFile(name, part, elements.slice(0, index + 1)).length - 2 <= half);
      files[path] = { alone: elements.flatMap(heads), prefix: closed.flatMap(heads) };
    }
  }
  return { source: SOURCE, facts: { exported_at: EXPORTED_AT }, files };
};
