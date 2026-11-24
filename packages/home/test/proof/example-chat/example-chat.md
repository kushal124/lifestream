# Example Chat (a proof connector)

A home connector of the proof: a messages network no release knows, whose parties
are its own user ids. Synthetic: no app of this name exists, and no release holds this folder.

Source: `example-chat:<account>:export`, the account the download's `messages.json` names. Reader: `example-chat`, with
no acquirer: the download is an import of its own kind (`export`, templates/export/export.md), and the reader's
`account` rule reads `messages.json` before any row. It declares the messages family's `processing` (photos, voice), as
every messages connector does.

| Kind | Key | Content | Time |
|---|---|---|---|
| `msg` | `<chat>:<id>` | `{ type: "example-chat.msg", id, chat, from, text, at }` | `at`, an instant |

The messages family reads it through `messages` (adapter.ts): a chat is the partner's user id, or `g-<id>` for a group;
a sender is `me` or a user id, stated as a `network` handle, `example-chat:<id>`, which People shows as its own.
