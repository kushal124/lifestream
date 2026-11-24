import type { JsonObject } from "@lifestreamprotocol/core";
import type { Fixture } from "../../../test/drive.js";
import { labelledLink } from "../../../shared/meta-export.js";
import { JPEG, metaFixture, metaJson, MP4, mojibake, WEBP } from "../../meta/test/fixtures.js";

export const HANDLE = "person-a";
export const SOURCE = `instagram:${HANDLE}:export`;
export const PROFILE = "personal_information/personal_information/personal_information.json";
export const EXPORTED_AT = "2026-09-20T12:00:00.000Z";
export const LATER_AT = "2026-10-01T12:00:00.000Z";

export const at = (iso: string): number => Date.parse(iso) / 1000;

const A = "your_instagram_activity";
export const THREAD_B = `${A}/messages/inbox/personb_1000000000000001`;
export const THREAD_C = "message_requests/personc_1000000000000002";

export const MEDIA: Record<string, Buffer> = {
  "media/posts/202509/10000000000000001_n.jpg": JPEG(1),
  "media/posts/10000000000000002_n.mp4": MP4(2),
  "media/igtv/202509/10000000000000003_n.mp4": MP4(3),
  "media/stories/202509/10000000000000004_n.jpg": JPEG(4),
  "media/stories/202509/10000000000000005_n.webp": WEBP(5),
  [`${THREAD_B}/photos/10000000000000010_n.jpg`]: JPEG(10),
};

const camera = { camera_metadata: { has_camera_metadata: false } };

function postMedia(uri: string, time: number, title: string): JsonObject {
  return { uri, creation_timestamp: time, media_metadata: camera, title, cross_post_source: { source_app: "FB" }, dubbing_info: [], media_variants: [] };
}

function post(fbid: string, time: number, caption: string, media: JsonObject): JsonObject {
  return {
    timestamp: time,
    media: [],
    label_values: [
      { label: "Caption", value: caption },
      { label: "Media", media: [media] },
      { label: "Creation time", timestamp_value: time },
      { label: "Marked as AI generated", vec: [] },
      { title: "Metadata", dict: [{ label: "Latitude", value: "0.000001", dict: [{ label: "Source", value: "Synthetic" }], title: "" }] },
      { label: "Visibility", value: "Public" },
    ],
    fbid,
  };
}

function liked(fbid: string, time: number, href: string, owner: string): JsonObject {
  return {
    timestamp: time,
    media: [],
    label_values: [
      { label: "URL", value: href, href },
      { label: "Caption", value: "" },
      { title: "Owner", dict: [{ dict: [{ label: "URL", value: `https://www.instagram.com/${owner}` }, { label: "Name", value: "Synthetic Owner" }, { label: "Username", value: owner }], title: "" }] },
    ],
    fbid,
  };
}

function message(sender: string, time: string, fields: JsonObject): JsonObject {
  return { sender_name: sender, timestamp_ms: Date.parse(time), ...fields, is_geoblocked_for_viewer: false, is_unsent_image_by_messenger_kid_parent: false };
}

export function exportMembers(version: "first" | "later" = "first"): Record<string, Buffer> {
  const first = version === "first";
  const posts = [
    post("17900000000000001", at("2026-09-01T08:00:00Z"), mojibake(first ? "A synthetic caption, café ☕ 😀" : "A synthetic caption, edited ☕"), postMedia("media/posts/202509/10000000000000001_n.jpg", at("2026-09-01T08:00:00Z"), "")),
    post("17900000000000002", at("2026-09-02T09:30:00Z"), "Second synthetic post", postMedia("media/posts/10000000000000002_n.mp4", at("2026-09-02T09:30:00Z"), "")),
    post("17900000000000003", at("2026-09-03T10:00:00Z"), "A post whose file Meta left out", postMedia("media/posts/202509/10000000000000009_n.jpg", at("2026-09-03T10:00:00Z"), "")),
  ];
  const comments = [
    { media_list_data: [{ uri: "" }], string_map_data: { Comment: { value: mojibake("Lovely 👍") }, "Media Owner": { value: "person-b" }, Time: { timestamp: at("2026-09-04T11:00:00Z") } } },
    ...(first ? [{ media_list_data: [{ uri: "" }], string_map_data: { Comment: { value: "A comment on a post of an unknown owner" }, Time: { timestamp: at("2026-09-04T12:00:00Z") } } }] : []),
  ];
  const requests = first ? THREAD_C : THREAD_C.replace("message_requests", "inbox");
  const members: Record<string, Buffer> = {
    "personal_information/personal_information/personal_information.json": metaJson({
      profile_user: [{
        title: "",
        media_map_data: { "Profile Photo": { uri: "media/other/10000000000000000_n.jpg", creation_timestamp: at("2026-01-01T00:00:00Z"), media_metadata: camera, title: "", cross_post_source: { source_app: "FB" } } },
        string_map_data: {
          Username: { href: "", value: HANDLE, timestamp: 0 },
          Name: { href: "", value: mojibake("Pérson A"), timestamp: 0 },
          Bio: { href: "", value: "", timestamp: 0 },
          "Private Account": { href: "", value: "False", timestamp: 0 },
        },
      }],
    }),
    [`${A}/media/posts.json`]: metaJson(posts),
    [`${A}/media/posts_1.json`]: metaJson([{ media: [postMedia("media/posts/202509/10000000000000001_n.jpg", at("2026-09-01T08:00:00Z"), "")] }]),
    [`${A}/media/igtv_videos.json`]: metaJson({ ig_igtv_media: [{ media: [postMedia("media/igtv/202509/10000000000000003_n.mp4", at("2026-09-05T18:00:00Z"), "A synthetic video")] }] }),
    [`${A}/media/stories.json`]: metaJson({
      ig_stories: [
        {
          uri: "media/stories/202509/10000000000000004_n.jpg", creation_timestamp: at("2026-09-06T07:00:00Z"),
          media_metadata: { photo_metadata: { exif_data: [{ device_id: "synthetic-device", date_time_original: "20260906T070000.000Z", source_type: "camera" }] }, ...camera },
          title: "", cross_post_source: { source_app: "FB" },
        },
        { uri: "media/stories/202509/10000000000000005_n.webp", creation_timestamp: at("2026-09-06T07:05:00Z"), media_metadata: camera, title: mojibake("Good morning ☀"), cross_post_source: { source_app: "FB" }, dubbing_info: [], media_variants: [] },
      ],
    }),
    [`${A}/comments/post_comments_1.json`]: metaJson(comments),
    [`${A}/comments/reels_comments.json`]: metaJson({ comments_reels_comments: [{ string_map_data: { Comment: { value: "A synthetic reel comment" }, "Media Owner": { value: "person-c" }, Time: { timestamp: at("2026-09-04T13:00:00Z") } } }] }),
    [`${A}/likes/liked_posts.json`]: metaJson([
      liked("17900000000000101", at("2026-09-07T20:00:00Z"), "https://www.instagram.com/p/AAAAAAAAAA1/", "person-b"),
      liked("17900000000000102", at("2026-09-07T20:01:00Z"), "https://www.instagram.com/reel/AAAAAAAAAA2/", "person-c"),
    ]),
    [`${A}/story_interactions/story_likes.json`]: metaJson(liked("17900000000000103", at("2026-09-08T06:00:00Z"), "https://www.instagram.com/stories/person-b/3000000000000000001", "person-b")),
    [`${A}/likes/liked_comments.json`]: metaJson({ likes_comment_likes: [{ title: "person-b", string_list_data: [{ href: "https://www.instagram.com/p/AAAAAAAAAA1/", value: "x", timestamp: at("2026-09-07T20:02:00Z") }] }] }),
    "connections/followers_and_following/following.json": metaJson({
      relationships_following: [
        { title: "person-b", string_list_data: [{ href: "https://www.instagram.com/_u/person-b", timestamp: at("2026-08-01T10:00:00Z") }] },
        { title: "person-c", string_list_data: [{ href: "https://www.instagram.com/_u/person-c", timestamp: at("2026-08-02T10:00:00Z") }] },
      ],
    }),
    "connections/followers_and_following/followers_1.json": metaJson([{ title: "", media_list_data: [], string_list_data: [{ href: "https://www.instagram.com/person-d", value: "person-d", timestamp: at("2026-08-03T10:00:00Z") }] }]),
    [`${A}/messages/your_chat_information.json`]: metaJson([{ timestamp: at("2026-09-01T00:00:00Z"), media: [], label_values: [{ label: "Setting", value: "On", vec: [], timestamp_value: 0 }], fbid: "17900000000000900" }]),
    [`${THREAD_B}/message_1.json`]: metaJson({
      participants: [{ name: "Person B" }, { name: mojibake("Pérson A") }],
      messages: [
        ...(first ? [] : [message("Person B", "2026-09-21T09:00:00.500Z", { content: "A message after the first download" })]),
        message(mojibake("Pérson A"), "2026-09-10T10:00:05.250Z", { photos: [{ uri: `${THREAD_B}/photos/10000000000000010_n.jpg`, creation_timestamp: at("2026-09-10T10:00:05Z") }] }),
        message("Person B", "2026-09-10T10:00:00.125Z", {
          content: mojibake("Hello ✨ see you at 6"),
          reactions: [{ reaction: mojibake("❤"), actor: mojibake("Pérson A"), timestamp: at("2026-09-10T10:01:00Z") }],
        }),
      ],
      title: "Person B", is_still_participant: true, thread_path: THREAD_B.slice(`${A}/messages/`.length), magic_words: [],
    }),
    [`${THREAD_B}/message_2.json`]: metaJson({
      participants: [{ name: "Person B" }, { name: mojibake("Pérson A") }],
      messages: [
        message("Person B", "2026-09-09T08:00:00.000Z", { content: "An older message", share: { link: "https://www.instagram.com/p/AAAAAAAAAA3/", share_text: "A shared post", original_content_owner: "person-c" } }),
        message("Person B", "2026-09-09T07:00:00.000Z", { content: "Same words" }),
      ],
      title: "Person B", is_still_participant: true, thread_path: THREAD_B.slice(`${A}/messages/`.length), magic_words: [],
    }),
    [`${A}/messages/${requests}/message_1.json`]: metaJson({
      participants: [{ name: "Person C" }, { name: "Person B" }, { name: mojibake("Pérson A") }],
      messages: [message("Person B", "2026-09-09T07:00:00.000Z", { content: "Same words" })],
      title: "Person C", is_still_participant: true, thread_path: requests, magic_words: [], ...(first ? { is_pending: true } : {}),
    }),
    ...MEDIA,
  };
  return members;
}

export const instagramFixture: Fixture = (folder) => {
  const all = exportMembers();
  const kept = [
    "personal_information/personal_information/personal_information.json", `${A}/media/posts.json`, `${A}/likes/liked_posts.json`,
    `${THREAD_B}/message_1.json`, `${THREAD_B}/message_2.json`, "media/posts/202509/10000000000000001_n.jpg", `${THREAD_B}/photos/10000000000000010_n.jpg`,
  ];
  return metaFixture(folder, SOURCE, Object.fromEntries(kept.map((path) => [path, all[path]!])), kept[0]!, {
    [`${A}/media/posts.json`]: (item) => `post ${item.fbid as string}`,
    [`${A}/likes/liked_posts.json`]: (item) => `like ${labelledLink(item)!}`,
  });
};
