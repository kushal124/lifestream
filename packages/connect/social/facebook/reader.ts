import { isObject, type JsonObject } from "@lifestreamprotocol/connect/sdk";
import * as metaExport from "../../shared/meta-export.js";

const { labelledLink, metaConnector, textOf } = metaExport;
type ItemFile = metaExport.ItemFile;

export const ACTIVITY = "your_facebook_activity";
export const PROFILE = "personal_information/profile_information/profile_information.json";

const stamp = (item: JsonObject) => item.timestamp;

export const FILES: readonly ItemFile[] = [
  { path: /^your_facebook_activity\/posts\/your_posts__check_ins__photos_and_videos_\d+\.json$/u, kind: "post", time: stamp },
  { path: /^your_facebook_activity\/posts\/posts_on_other_pages_and_profiles\.json$/u, kind: "post", key: (item) => textOf(item, "fbid"), time: stamp },
  { path: /^your_facebook_activity\/groups\/group_posts_and_comments\.json$/u, kind: "post", under: "group_posts_v2", time: stamp },
  { path: /^your_facebook_activity\/comments_and_reactions\/comments\.json$/u, kind: "comment", under: "comments_v2", time: stamp },
  { path: /^your_facebook_activity\/groups\/your_comments_in_groups\.json$/u, kind: "comment", under: "group_comments_v2", time: stamp },
  { path: /^your_facebook_activity\/comments_and_reactions\/likes_and_reactions\.json$/u, kind: "like", key: labelledLink, time: stamp },
  { path: /^your_facebook_activity\/pages\/pages_you've_liked\.json$/u, kind: "like", under: "page_likes_v2", key: (item) => textOf(item, "url"), time: stamp },
  { path: /^connections\/followers\/who_you've_followed\.json$/u, kind: "follow", under: "following_v3", key: (item) => textOf(item, "name"), time: stamp },
];

export const facebook = metaConnector({ product: "facebook", name: "facebook-export", activity: ACTIVITY, profile: PROFILE, accounts: profiles, files: FILES });

function profiles(profile: JsonObject): string[] {
  const stated = isObject(profile.profile_v2) ? profile.profile_v2 : {};
  const names: string[] = [];
  const username = textOf(stated, "username");
  if (username !== undefined) names.push(username);
  const uri = textOf(stated, "profile_uri");
  if (uri !== undefined) {
    const named = /[?&]id=(\d+)(?:&|$)/u.exec(uri)?.[1] ?? /\/([^/?#]+)\/?(?:[?#].*)?$/u.exec(uri)?.[1];
    if (named !== undefined && !names.includes(named)) names.push(named);
  }
  return names;
}
