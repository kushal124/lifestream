# X's archive: `x:<account id>:export`

**Reads** X's (Twitter's) "Download an archive of your data": the posts, the deleted posts X
still keeps, the likes and the direct messages, with the media files the archive holds for
each. A delivery holds the archive's ZIP, or its members extracted at their paths in the
archive under any prefix. It arrives as a download on the upload lane; nothing polls it.
Reader `x-archive`.

The archive is the folder holding `data/manifest.js`; a delivery holding none yields no row.
Its `data/account.js` must name the source's account id: an archive of another account is
refused whole, naming both. Each data file is JavaScript, `window.YTD.<name>.part<n> = [ … ]`,
`<name>` the file's name with `-` spelled `_`. A data file may be split over `<file>.js`,
`<file>-part1.js`, …; every part is read, each checked to name its file and part, and its array
after the first `=` is read one element at a time.

| Kind | Read from | Key | Content | Time |
|---|---|---|---|---|
| `post` | `tweets.js`, `deleted-tweets.js` | the post's `id_str` | `{type: "x.post", tweet: {…every member X states}, blobs?}` | `created_at` (`Tue Sep 01 08:00:00 +0000 2026`, UTC, to the second; no offset stated) |
| `like` | `like.js` | the liked post's `tweetId` | `{type: "x.like", like: {tweetId, fullText?, expandedUrl?}}` | none: X states no time for a like |
| `msg` | `direct-messages.js`, `direct-messages-group.js` | the message's `id` | `{type: "x.msg", conversationId, messageCreate: {…}, blobs?}`, or `welcomeMessageCreate` (a business account's welcome message) in its place | `createdAt`, UTC, to the millisecond |

- Each element is kept whole, under the member X states it in (`tweet`, `like`,
  `messageCreate`). A message adds its conversation's `conversationId`, the one member of the
  conversation it is in; a group conversation's id is a number, a one-to-one's
  `<user id>-<user id>`. The time string stays in the content.
- A deleted post is a `post` whose `tweet` states `deleted_at`. A post an earlier archive
  stated live and a later one states deleted changes to the version with `deleted_at`; nothing
  is ever `gone`, and a post a later archive lacks stays as it was.
- One conversation is held in memory while its messages are read; a data file of any size
  costs one element (a post, a like, a conversation).

## Media

A post's or message's media files are the files of its media folder named `<its id>-…`:
`tweets_media/` for `tweets.js`, `deleted_tweets_media/` for `deleted-tweets.js`,
`direct_messages_media/` and `direct_messages_group_media/` for the messages. Each becomes a
blob of the record, listed once in name order as `{hash, bytes, media_type, role: "attachment",
file}`, `file` its name in the folder. An extracted file is the delivery's own file. A ZIP
member is stored, never read whole (`shared/members.ts` `stored`): hashed in chunks as it is read,
its `hash` the SHA-256 of its bytes, and handed to the home by stream with the row
(`ReaderOutput.streamed`), of any size. A post or message whose media the archive does not hold keeps its media URLs and
lists no blob.

## Not read

What the table cannot name stays in the delivery, landing no record: `tweet-headers.js`,
`deleted-tweet-headers.js`, `direct-message-headers.js` and `direct-message-group-headers.js`
(the ids and times of items the full files state); a conversation's `participantsJoin`,
`participantsLeave` and `joinConversation` members; `note-tweet.js` (a long post's full text,
keyed by its own id, not the post's); `message-event.js` (X's encrypted chat); `article.js`;
`grok-chat-item.js` and `grok_chat_media/`; `follower.js`, `following.js`, `block.js`,
`mute.js`, the lists; the profile, the account's settings, devices, logins and ads files.
`data/account.js` and `data/manifest.js` are read only to find and check the archive. The
archive states no bookmarks, so no row is a `bookmark`.

## Refused

The delivery, whole, when the source is not `x:<account id>:export`; `data/account.js` is
missing, does not state one `accountId`, or names another account; or the delivery holds two
archives (a ZIP and its extraction together). Otherwise each part alone, named in the run's
refusals (a row of kind `file`), while the rest lands. A data file that does not begin
`window.YTD.<its name>.part<its part> =`, or is not UTF-8 JSON, by its path; an array that is not
closed keeps the elements before the break. A post's or like's element that is not `{tweet: {…}}`
or `{like: {…}}`, a post with no `id_str` of digits or a `created_at` that is no instant, a like
with no `tweetId` of digits, a conversation that is not `{dmConversation: {conversationId,
messages: […]}}`, or an element stating a `type` or `blobs` member of its own, by its place; a
message with no `id` of digits or a `createdAt` that is no RFC 3339 instant, or stating a `type`,
`blobs` or `conversationId` member, by its place in its conversation. A ZIP that cannot be read,
or a file named `.zip` that is no zip, by its path. A row alone, counted, when its content breaks the guard:
a post's `full_text` or `deleted_at` not a string, its `entities` or `extended_entities` not an
object; a like's `fullText` or `expandedUrl` not a string; a message's `senderId` or `text` not
a string, its `mediaUrls` not a list of strings. A member X adds later is kept as it is.

No family reads these kinds yet: the social family (posts, likes, bookmarks) and the messages
family's reading of X's messages are owed. The records land and wait.
