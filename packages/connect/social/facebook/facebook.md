# Facebook: `facebook:<profile>:export`

**Reads** Facebook's "Download your information" in JSON format: the person's posts, comments,
likes, follows and Messenger threads. It arrives as a download on the upload lane; nothing
polls it. Reader `facebook-export`. How a delivery holds the export, Meta's text repair,
message threads, media and refusals are [meta.md](../meta/meta.md).

The profile is what `personal_information/profile_information/profile_information.json` names:
its `profile_v2.username`, or what its `profile_uri` ends in (the username, or the number of a
`profile.php?id=` address). The file states no other number for the profile. A delivery naming
another profile is refused whole.

```
lifestream source add facebook:<profile>:export --connector facebook-export --options '{"lane":"upload:local:<mac>"}'
```

## Kinds, keys, content, time

Paths are under the export's root; `A` is `your_facebook_activity`. Every time is `timestamp`.

| File | Kind | Key |
|---|---|---|
| `A/posts/your_posts__check_ins__photos_and_videos_<n>.json` | `post` | the fingerprint |
| `A/posts/posts_on_other_pages_and_profiles.json` | `post` | `fbid`, Meta's id |
| `A/groups/group_posts_and_comments.json` (`group_posts_v2`) | `post` | the fingerprint |
| `A/comments_and_reactions/comments.json` (`comments_v2`) | `comment` | the fingerprint |
| `A/groups/your_comments_in_groups.json` (`group_comments_v2`) | `comment` | the fingerprint |
| `A/comments_and_reactions/likes_and_reactions.json` | `like` | the link of what was liked (a post, a photo, a comment): the `href` of the one `label_values` entry stating one |
| `A/pages/pages_you've_liked.json` (`page_likes_v2`) | `like` | the page's `url` |
| `connections/followers/who_you've_followed.json` (`following_v3`) | `follow` | `name`, the profile or page followed |
| `A/messages/<folder>/<thread>/message_<n>.json` | `chat`, `msg` | [meta.md, "Message threads"](../meta/meta.md#message-threads) |

The member in brackets is the one a file lists its items under; the others are a list. The
content is every member of the item: `{type: "facebook.<kind>", ...item, blobs?}`. The files a
post, comment or message names (photos, videos, GIFs, audio, stickers, a group's picture) are
its blobs.

Meta writes its own words in the export's language: an export made in Hindi states its
`label_values` labels and each item's `title` ("… ने एक फ़ोटो अपडेट की।") in Hindi, repaired
like all text. Those words are part of the content, and of the fingerprint of an item keyed by
one.

## Not read

No kind or key rule names these, so they stay in the delivery and land no record:

- `A/comments_and_reactions/likes_and_reactions_<n>.json`: likes in an older shape, naming no
  link to key them by.
- `A/pages/pages_and_profiles_you_follow.json`: the pages of `who_you've_followed.json` again.
  `A/pages/pages_and_profiles_you've_unfollowed.json`.
- `A/posts/your_videos.json`, `your_uncategorized_photos.json`, `album/<n>.json`,
  `birthday_media.json`, `shared_memories.json`, `places_you_have_been_tagged_in.json`,
  `edits_you_made_to_posts.json`, `A/activity_you're_tagged_in/`.
- `connections/friends/`, `A/events/`, `A/groups/` other than the two files above,
  `A/saved_items_and_collections/`, `A/other_activity/` (pokes, notes), `A/polls/`,
  `A/facebook_marketplace/`, the settings files under `A/messages/`, and every folder beside
  `A` and `connections` (`personal_information/` is read only for the account).

No family reads these kinds yet; the records land and wait.
