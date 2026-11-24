# Instagram: `instagram:<handle>:export`

**Reads** Instagram's "Download your information" in JSON format: the person's posts, stories,
comments, likes, follows and message threads. It arrives as a download on the upload lane;
nothing polls it. Reader `instagram-export`. How a delivery holds the export, Meta's text
repair, message threads, media and refusals are [meta.md](../meta/meta.md).

The handle is the `Username` that `personal_information/personal_information/personal_information.json`
names; a delivery naming another is refused whole.

```
lifestream source add instagram:<handle>:export --connector instagram-export --options '{"lane":"upload:local:<mac>"}'
```

## Kinds, keys, content, time

Paths are under the export's root; `A` is `your_instagram_activity`.

| File | Kind | Key | Time |
|---|---|---|---|
| `A/media/posts.json` | `post` | `fbid`, Meta's id | `timestamp` |
| `A/media/igtv_videos.json` (`ig_igtv_media`) | `post` | the fingerprint | the earliest `creation_timestamp` of its `media` |
| `A/media/stories.json` (`ig_stories`) | `story` | the fingerprint | `creation_timestamp` |
| `A/comments/post_comments_<n>.json` | `comment` | the fingerprint | the one `timestamp` its `string_map_data` states |
| `A/comments/reels_comments.json` (`comments_reels_comments`) | `comment` | the fingerprint | as above |
| `A/likes/liked_posts.json` | `like` | the post's link: the `href` of the one `label_values` entry stating one | `timestamp` |
| `A/story_interactions/story_likes.json` | `like` | the story's link, as above | `timestamp` |
| `connections/followers_and_following/following.json` (`relationships_following`) | `follow` | `title`, the handle followed | its first `string_list_data` entry's `timestamp` |
| `A/messages/<folder>/<thread>/message_<n>.json` | `chat`, `msg` | [meta.md, "Message threads"](../meta/meta.md#message-threads) | |

The member in brackets is the one a file lists its items under; the others are a list, or, when
Meta has one item, the item itself (`story_likes.json`). The content is every member of the item:
`{type: "instagram.<kind>", ...item, blobs?}`. A post's photo or video (under `media/posts/`,
`media/archived_posts/`, `media/igtv/`), a story's, and a message's photos are its blobs. A
comment's `media_list_data` names no file (`uri` is empty).

## Not read

No kind or key rule names these, so they stay in the delivery and land no record:

- `A/media/posts_<n>.json` and `A/media/archived_posts.json`: the posts of `posts.json` again, in
  an older shape without their ids. `A/media/other_content.json`, `A/media/profile_photos.json`.
- `A/likes/liked_comments.json`: a comment liked names only its post's link, which every comment
  liked on that post shares.
- `connections/followers_and_following/followers_<n>.json` (who follows the person),
  `following_hashtags.json`, `pending_follow_requests.json`, `blocked_profiles.json`,
  `hide_story_from.json`, `removed_suggestions.json`, `A/threads/`.
- `A/saved/`, `A/story_interactions/` other than `story_likes.json` (polls, quizzes,
  questions, emoji sliders), `A/messages/your_chat_information.json`, `A/shopping/`,
  `A/monetization/`, and every folder beside `A`, `media` and `connections`
  (`personal_information/` is read only for the account).

No family reads these kinds yet; the records land and wait.
