# Wispr Flow: `wispr-flow:<account>:<unit>`

**Reads** `flow.sqlite`, Wispr Flow's database on the Mac, holding only the `History` rows that
changed (`kind: "changes"`); every row the file holds is stated. A delivery from an older Mac (the whole table, or a delta stating `after` and `through`) holds whole rows too and is read the same way, for one release more. Every other table (meetings, notes, Granola imports, the
dictionary) arrives empty and is never read. The account is the email Wispr states in its
`config.json` (`prefs.user.email`); the database itself states none.

| Kind | Key | Content | Time |
|---|---|---|---|
| `dictation` | `transcriptEntityId`; `no-transcript-id` when it is empty | `wispr-flow.dictation`: `History`, every column of the row as SQLite holds it: each text form (`asrText`, `formattedText`, `editedText`, `pastedText`, …), `app`, `url`, `status`, `additionalContext`, `timestamp` as spelled; a BLOB (`audio`, `screenshot`, `builtInAudio`) and `opusChunks` as `{hash, bytes}` | `timestamp` (Sequelize's UTC, `YYYY-MM-DD HH:MM:SS.sss +00:00`); the offset is `-timezoneOffsetMinutes` when stated, else none; no timestamp, no time |

- A dictation names the blobs of its BLOB columns and of `opusChunks` (the audio as Opus
  packets in JSON text, stored as JSON).
- An edit Wispr makes to an older row is a changed row, and ships. A row missing from a delivery
  states nothing; no row is ever `gone`.
- Wispr can hold one row with an empty `transcriptEntityId`, its primary key: a paste it records
  with no id, no time and no audio (`status: "extension_paste"`). It lands under the one key
  `no-transcript-id`, its content as Wispr wrote it, and with no time it is on no day.
- A row whose `transcriptEntityId` is not text is refused, as is one whose `timestamp` is not
  Sequelize's UTC spelling.


## What the voice family reads

**Adapter** `wisprFlowVoice` (adapter.ts; [voice](../../../families/voice/)): a
`dictation` is its words, the last form it states: `editedText` (the person's own edit after Wispr
pasted), else `pastedText`, else `formattedText`, else `asrText`; the `app` it went into; and the
page, the host and path of its `url`. Nothing else is read: audio, screenshot, latencies, scores,
upload flags, textbox and context can tick and nothing is written.

## Ledger

How the Mac keeps custody of this source: a memory of the store, per pass, holding every row sent by table, key, fingerprint and seal. `DatabaseDomainTests` and `ClosedStoreShippingTests` in the macOS app hold each answer.

1. **Order.** None is needed: a read sends every row whose fingerprint the memory does not hold. Dictations of the last 7 days (`timestamp`) go live; older ones in history pages, newest first.
2. **Reuse.** Yes: `History` is a plain rowid table, so once the newest dictation is deleted the next one takes its rowid. Its values differ, so its fingerprint does, and it ships.
3. **Rebuilds.** Reinstalling Wispr Flow makes a new file: the memory starts again and every dictation ships.
4. **Late arrivals.** None: Wispr writes a dictation as it is made.
5. **Edits.** `editedText` and every other change in place change a fingerprint, and ship. A deletion ships nothing.
6. **Lost.** Dictations deleted between the memory's highest rowid and the store's lowest before this Mac carried them are stated lost, once.
