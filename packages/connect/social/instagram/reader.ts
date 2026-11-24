import { isObject, type Json, type JsonObject } from "@lifestreamprotocol/connect/sdk";
import * as metaExport from "../../shared/meta-export.js";

const { labelledLink, metaConnector, textOf } = metaExport;
type ItemFile = metaExport.ItemFile;

export const ACTIVITY = "your_instagram_activity";
export const PROFILE = "personal_information/personal_information/personal_information.json";

export const FILES: readonly ItemFile[] = [
  { path: /^your_instagram_activity\/media\/posts\.json$/u, kind: "post", key: (item) => textOf(item, "fbid"), time: (item) => item.timestamp },
  { path: /^your_instagram_activity\/media\/igtv_videos\.json$/u, kind: "post", under: "ig_igtv_media", time: earliestMedia },
  { path: /^your_instagram_activity\/media\/stories\.json$/u, kind: "story", under: "ig_stories", time: (item) => item.creation_timestamp },
  { path: /^your_instagram_activity\/comments\/post_comments_\d+\.json$/u, kind: "comment", time: mappedTime },
  { path: /^your_instagram_activity\/comments\/reels_comments\.json$/u, kind: "comment", under: "comments_reels_comments", time: mappedTime },
  { path: /^your_instagram_activity\/likes\/liked_posts\.json$/u, kind: "like", key: labelledLink, time: (item) => item.timestamp },
  { path: /^your_instagram_activity\/story_interactions\/story_likes\.json$/u, kind: "like", key: labelledLink, time: (item) => item.timestamp },
  { path: /^connections\/followers_and_following\/following\.json$/u, kind: "follow", under: "relationships_following", key: (item) => textOf(item, "title"), time: listedTime },
];

export const instagram = metaConnector({ product: "instagram", name: "instagram-export", activity: ACTIVITY, profile: PROFILE, accounts: handles, files: FILES });

function handles(profile: JsonObject): string[] {
  const users = Array.isArray(profile.profile_user) ? profile.profile_user : [];
  return users.flatMap((user) => {
    const username = isObject(user) && isObject(user.string_map_data) ? user.string_map_data.Username : undefined;
    return isObject(username) && typeof username.value === "string" && username.value !== "" ? [username.value] : [];
  });
}

function earliestMedia(item: JsonObject): Json | undefined {
  const times = (Array.isArray(item.media) ? item.media : []).flatMap((media) => (isObject(media) && typeof media.creation_timestamp === "number" ? [media.creation_timestamp] : []));
  return times.length === 0 ? undefined : Math.min(...times);
}

function mappedTime(item: JsonObject): Json | undefined {
  const map = item.string_map_data;
  if (!isObject(map)) return undefined;
  const times = new Set(Object.values(map).flatMap((entry) => (isObject(entry) && entry.timestamp !== undefined ? [entry.timestamp] : [])));
  return times.size === 1 ? [...times][0] : undefined;
}

function listedTime(item: JsonObject): Json | undefined {
  const first = Array.isArray(item.string_list_data) ? item.string_list_data[0] : undefined;
  return isObject(first) ? first.timestamp : undefined;
}
