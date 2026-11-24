import type { JsonObject } from "@lifestreamprotocol/core";
import type { Fixture } from "../../../test/drive.js";
import { GIF, JPEG, metaFixture, metaJson, MP4, mojibake, PNG } from "../../meta/test/fixtures.js";

export const USERNAME = "person.a";
export const SOURCE = `facebook:${USERNAME}:export`;
export const EXPORTED_AT = "2026-09-20T12:00:00.000Z";
export const LATER_AT = "2026-10-01T12:00:00.000Z";
export const PROFILE = "personal_information/profile_information/profile_information.json";

export const at = (iso: string): number => Date.parse(iso) / 1000;

const A = "your_facebook_activity";
const UPLOADS = `${A}/posts/media/mobailaapaloda_1000000000000001`;
export const THREAD_B = `${A}/messages/inbox/personb_1000000000000001`;

export const MEDIA: Record<string, Buffer> = {
  [`${UPLOADS}/10000000000000001_n.jpg`]: JPEG(1),
  [`${A}/posts/media/videos/10000000000000002_n.mp4`]: MP4(2),
  [`${A}/posts/media/Group_1000000000000002/10000000000000003_n.jpg`]: JPEG(3),
  [`${A}/posts/media/your_posts/10000000000000004_n.png`]: PNG(4),
  [`${A}/posts/media/stickers_used/10000000000000005_n.png`]: PNG(5),
  [`${THREAD_B}/photos/10000000000000010_n.png`]: PNG(10),
  [`${THREAD_B}/gifs/10000000000000011_n.gif`]: GIF(11),
  [`${THREAD_B}/videos/10000000000000012_n.mp4`]: MP4(12),
  [`${A}/messages/stickers_used/10000000000000013_n.png`]: PNG(13),
  [`${A}/messages/inbox/group_1000000000000003/photos/10000000000000014_n.jpg`]: JPEG(14),
};

const hi = (text: string): string => mojibake(text);
const exif = (time: number) => ({ photo_metadata: { exif_data: [{ upload_ip: "192.0.2.1", taken_timestamp: time }] } });

function message(sender: string, time: string, fields: JsonObject): JsonObject {
  return { sender_name: sender, timestamp_ms: Date.parse(time), ...fields, is_geoblocked_for_viewer: false, is_unsent_image_by_messenger_kid_parent: false };
}

function thread(path: string, title: string, messages: JsonObject[], fields: JsonObject = {}): Buffer {
  return metaJson({ participants: [{ name: title }, { name: "Person A" }], messages, title, is_still_participant: true, thread_path: path, magic_words: [], ...fields });
}

export function profile(username: string | undefined, uri: string): Buffer {
  return metaJson({
    profile_v2: {
      name: { full_name: "Person A", first_name: "Person", middle_name: "", last_name: "A" },
      emails: { emails: ["person-a@example.com"], previous_emails: [], pending_emails: [], ad_account_emails: [] },
      birthday: { year: 2000, month: 1, day: 1 },
      gender: { gender_option: "MALE", pronoun: "HE" },
      previous_names: [], other_names: [],
      current_city: { name: "Example Town", timestamp: at("2020-01-01T00:00:00Z") },
      phone_numbers: [{ phone_type: "Mobile", phone_number: "+15550000001", verified: true, creation_time: at("2020-01-01T00:00:00Z") }],
      ...(username === undefined ? {} : { username }),
      about_me: "",
      registration_timestamp: at("2010-01-01T00:00:00Z"),
      profile_uri: uri,
    },
  });
}

const statusPost: JsonObject = {
  timestamp: at("2026-09-01T08:00:00Z"),
  attachments: [{ data: [{ media: { uri: `${UPLOADS}/10000000000000001_n.jpg`, creation_timestamp: at("2026-09-01T08:00:00Z"), media_metadata: exif(at("2026-08-31T20:00:00Z")), description: hi("नमस्ते"), title: hi("मोबाइल अपलोड") } }] }],
  data: [{ post: hi("नमस्ते, a synthetic status ☕") }],
  title: hi("Person A ने एक फ़ोटो अपडेट की।"),
};

export function exportMembers(): Record<string, Buffer> {
  return {
    [PROFILE]: profile(USERNAME, `https://www.facebook.com/${USERNAME}`),
    [`${A}/posts/your_posts__check_ins__photos_and_videos_1.json`]: metaJson([
      statusPost,
      statusPost,
      {
        timestamp: at("2026-09-02T09:00:00Z"),
        attachments: [{ data: [{ place: { name: "Example Cafe", coordinate: { latitude: 0.000001, longitude: 0.000002 }, address: "", url: "https://www.facebook.com/100000000000201" } }] }],
        data: [{ post: "A synthetic check-in", update_timestamp: at("2026-09-02T09:05:00Z") }],
        title: hi("Person A Example Cafe में थे।"),
        tags: [{ name: "Person B" }],
      },
      {
        timestamp: at("2026-09-03T10:00:00Z"),
        attachments: [{ data: [{ media: { uri: `${A}/posts/media/videos/10000000000000002_n.mp4`, creation_timestamp: at("2026-09-03T10:00:00Z"), media_metadata: { video_metadata: { exif_data: [{ upload_ip: "192.0.2.1", upload_timestamp: at("2026-09-03T10:00:00Z") }] } }, title: "", description: "", dubbing_info: [], media_variants: [] } }] }],
        data: [],
      },
    ]),
    [`${A}/posts/posts_on_other_pages_and_profiles.json`]: metaJson([
      {
        timestamp: at("2026-09-04T11:00:00Z"),
        media: [],
        label_values: [
          { label: hi("मैसेज"), value: "A synthetic post on another profile" },
          { label: hi("टार्गेट"), value: "Person B" },
          { label: hi("बटन"), timestamp_value: at("2026-09-04T11:00:00Z"), media: [] },
        ],
        fbid: "100000000000001",
      },
    ]),
    [`${A}/groups/group_posts_and_comments.json`]: metaJson({
      group_posts_v2: [
        {
          timestamp: at("2026-09-05T12:00:00Z"),
          data: [{ post: "A synthetic group post" }],
          title: hi("Person A ने Example Group में पोस्ट किया।"),
          attachments: [{ data: [{ media: { uri: `${A}/posts/media/Group_1000000000000002/10000000000000003_n.jpg`, creation_timestamp: at("2026-09-05T12:00:00Z"), media_metadata: exif(at("2026-09-05T11:00:00Z")), title: "", description: "" } }] }],
        },
        {
          timestamp: at("2026-09-05T12:00:00Z"),
          attachments: [{ data: [{ poll: { question: "A synthetic poll?", options: [{ option: "Yes", voted: true }, { option: "No", voted: false }] } }] }],
        },
      ],
    }),
    [`${A}/comments_and_reactions/comments.json`]: metaJson({
      comments_v2: [
        {
          timestamp: at("2026-09-06T13:00:00Z"),
          data: [{ comment: { timestamp: at("2026-09-06T13:00:00Z"), comment: hi("बहुत अच्छा 👍"), author: "Person A" } }],
          title: hi("Person A ने Person B की पोस्ट पर टिप्पणी की।"),
          attachments: [{ data: [{ media: { uri: `${A}/posts/media/your_posts/10000000000000004_n.png`, creation_timestamp: at("2026-09-06T13:00:00Z"), media_metadata: exif(at("2026-09-06T13:00:00Z")), ai_stickers: [] } }] }],
        },
        { timestamp: at("2026-09-06T14:00:00Z"), title: hi("Person A ने एक टिप्पणी की।") },
      ],
    }),
    [`${A}/groups/your_comments_in_groups.json`]: metaJson({
      group_comments_v2: [{ timestamp: at("2026-09-06T15:00:00Z"), data: [{ comment: { timestamp: at("2026-09-06T15:00:00Z"), comment: "A synthetic group comment", author: "Person A", group: "Example Group" } }], title: hi("Person A ने टिप्पणी की।"),
        attachments: [{ data: [{ media: { uri: `${A}/posts/media/stickers_used/10000000000000005_n.png`, creation_timestamp: at("2026-09-06T15:00:00Z"), media_metadata: exif(at("2026-09-06T15:00:00Z")), ai_stickers: [] } }] }] }],
    }),
    [`${A}/comments_and_reactions/likes_and_reactions.json`]: metaJson([
      {
        timestamp: at("2026-09-07T16:00:00Z"),
        media: [],
        label_values: [
          { label: hi("प्रतिक्रिया"), value: "LIKE" },
          { label: "URL", value: "https://www.facebook.com/person.b/posts/pfbid000000000000000000000000001", href: "https://www.facebook.com/person.b/posts/pfbid000000000000000000000000001" },
          { label: hi("नाम"), value: "Person B" },
        ],
        fbid: "100000000000101",
      },
      {
        timestamp: at("2026-09-07T16:05:00Z"),
        media: [],
        label_values: [
          { label: hi("प्रतिक्रिया"), value: "LOVE" },
          { label: "URL", value: "https://www.facebook.com/person.b/posts/pfbid000000000000000000000000001?comment_id=100000000000102", href: "https://www.facebook.com/person.b/posts/pfbid000000000000000000000000001?comment_id=100000000000102" },
        ],
        fbid: "100000000000102",
      },
      { timestamp: at("2026-09-07T16:10:00Z"), media: [], label_values: [{ label: hi("प्रतिक्रिया"), value: "HAHA" }], fbid: "100000000000103" },
    ]),
    [`${A}/comments_and_reactions/likes_and_reactions_1.json`]: metaJson([{ timestamp: at("2026-09-07T16:00:00Z"), data: [{ reaction: { reaction: "LIKE", actor: "Person A" } }], title: hi("Person A ने Person B की पोस्ट पसंद की।") }]),
    [`${A}/pages/pages_you've_liked.json`]: metaJson({ page_likes_v2: [{ name: "Example Page", timestamp: at("2026-08-01T10:00:00Z"), url: "https://www.facebook.com/100000000000301" }] }),
    "connections/followers/who_you've_followed.json": metaJson({ following_v3: [{ name: "Person B", timestamp: at("2026-08-02T10:00:00Z") }, { name: "Example Page", timestamp: at("2026-08-01T10:00:00Z") }] }),
    [`${A}/pages/pages_and_profiles_you_follow.json`]: metaJson({ pages_followed_v2: [{ timestamp: at("2026-08-01T10:00:00Z"), data: [{ name: "Example Page" }], title: "" }] }),
    "connections/friends/your_friends.json": metaJson({ friends_v2: [{ name: "Person B", timestamp: at("2020-01-01T00:00:00Z") }] }),
    [`${THREAD_B}/message_1.json`]: thread("inbox/personb_1000000000000001", "Person B", [
      message("Person A", "2026-09-10T10:00:06.000Z", { sticker: { uri: `${A}/messages/stickers_used/10000000000000013_n.png`, ai_stickers: [] } }),
      message("Person B", "2026-09-10T10:00:05.000Z", { videos: [{ uri: `${THREAD_B}/videos/10000000000000012_n.mp4`, creation_timestamp: at("2026-09-10T10:00:05Z") }] }),
      message("Person B", "2026-09-10T10:00:04.000Z", { gifs: [{ uri: `${THREAD_B}/gifs/10000000000000011_n.gif` }] }),
      message("Person A", "2026-09-10T10:00:03.000Z", { photos: [{ uri: `${THREAD_B}/photos/10000000000000010_n.png`, creation_timestamp: at("2026-09-10T10:00:03Z") }, { uri: "https://example.com/v/t1.0-9/10000000000000015_n.jpg", creation_timestamp: at("2026-09-10T10:00:03Z") }], ip: "192.0.2.2" }),
      message("Person B", "2026-09-10T10:00:02.000Z", { content: "", call_duration: 120 }),
      message("Person B", "2026-09-10T10:00:00.000Z", { content: hi("नमस्ते ✨"), reactions: [{ reaction: hi("❤"), actor: "Person A" }], share: { link: "https://example.com/article" } }),
    ]),
    [`${A}/messages/archived_threads/personc_1000000000000002/message_1.json`]: thread("archived_threads/personc_1000000000000002", "Person C", [message("Person C", "2026-09-11T10:00:00.000Z", { content: "An archived message" })], { joinable_mode: { mode: 1, link: "" } }),
    [`${A}/messages/inbox/group_1000000000000003/message_1.json`]: thread("inbox/group_1000000000000003", "Example Group", [message("Person B", "2026-09-12T10:00:00.000Z", { content: "A group message", missed: false })], {
      image: { uri: `${A}/messages/inbox/group_1000000000000003/photos/10000000000000014_n.jpg`, creation_timestamp: at("2026-09-12T09:00:00Z") },
    }),
    ...MEDIA,
  };
}

export const facebookFixture: Fixture = (folder) => {
  const all = exportMembers();
  const kept = [
    PROFILE, `${A}/posts/posts_on_other_pages_and_profiles.json`, `${THREAD_B}/message_1.json`,
    `${A}/messages/stickers_used/10000000000000013_n.png`, `${THREAD_B}/videos/10000000000000012_n.mp4`, `${THREAD_B}/gifs/10000000000000011_n.gif`, `${THREAD_B}/photos/10000000000000010_n.png`,
  ];
  return metaFixture(folder, SOURCE, Object.fromEntries(kept.map((path) => [path, all[path]!])), PROFILE, {
    [`${A}/posts/posts_on_other_pages_and_profiles.json`]: (item) => `post ${item.fbid as string}`,
  });
};
