# Aqua Voice: `aqua-voice:<account>:<unit>`

**Reads** `history.json`, Aqua Voice's file of the last 100 dictations of each user signed in on
the Mac (version 1, newest first, under `historyByUserId.<user id>`), shipped whole whenever it
changes, and `audio.json`, the blob index of every recording the account's entries name that
the Mac could read. The account is Aqua's user id, the key of `historyByUserId`; another user's
entries belong to that user's source.

| Kind | Key | Content | Time |
|---|---|---|---|
| `dictation` | `sessionId`; when Aqua states none, `fingerprint({timestamp, audioFilePath})`, leaving out a member stated null | `aqua-voice.dictation`: `dictation`, the entry as Aqua states it (`content` as written, `rawText` as heard, `timestamp`, `audioFilePath`, `audioDurationSeconds`, …); `audio`, the recording's `{hash, bytes}`, or null when the Mac could not read it | `timestamp` (RFC 3339, UTC, no offset) |

- A dictation names the blob of its recording.
- Aqua drops an entry once 100 newer ones exist. That states no deletion: no dictation is ever
  `gone`.
- An entry with no `sessionId` is keyed by its fingerprint. If Aqua later fills its id, the
  dictation lands again under the new key; the fingerprint's record stays.
- A `history.json` that is not version 1, or does not parse, is refused by its name, the delivery
  kept. An `audio.json` that does not read refuses the delivery: read without it, every dictation
  would state no recording.


## What the voice family reads

**Adapter** `aquaVoiceVoice` (adapter.ts; [voice](../../../families/voice/)): a
`dictation` is its words, `content` (as written), else `rawText` (as heard). Aqua states no app
and no page; nothing else of an entry is read.

## Ledger

How the Mac keeps custody of this source: each seal's ledger entry holds the SHA-256 of `history.json` and its audio index together (its mark) and the recordings it sent. `AquaVoiceDomainTests` hold each answer.

1. **Order.** No row number: a seal is due when the mark differs from the newest seal the home received; every bundle is the whole file.
2. **Reuse.** A mark can come back when the file returns to an earlier state; harmless, since every bundle is the whole file.
3. **Rebuilds.** A reinstall empties the file; the next bundle is the file as it stands.
4. **Late arrivals.** A recording written after its dictation was listed ships at the next interval it can be read.
5. **Edits.** Caught: any change ships the whole file.
6. **Lost.** Aqua keeps its last 100 dictations, so a restore recovers what the file still holds, and the recordings the rolled-back seals sent ship again. What rolled out of the file cannot be counted, so nothing is stated.
