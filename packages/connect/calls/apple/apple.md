# Call history: `apple-calls:<apple id>:<unit>`

**Reads** `callhistory.sqlite`, what changed in the Mac's `CallHistory.storedata`
(`kind: "changes"`), or an iPhone backup's whole: every call the file holds is stated; its handles
and emergency media are read by lookup. A delivery from an older Mac (a `VACUUM INTO` copy, or a
delta stating `after` and `through`) holds whole rows too and is read the same way, for one release
more; a backup's whole store is read so for good.

A phone backup comes on the import road (imports/imports.md, "Each kind": the iPhone backup): the
Mac pulls `callhistory.sqlite` (`CallHistory.storedata`, its WAL folded in) out into an
`apple-calls/` folder, its row `**/apple-calls/callhistory.sqlite` (this connector's `export`), for
`apple-calls:<apple id>:<unit>` on the `upload` road, the unit the phone's. The phone's store is the
Mac's schema: a column it has that the Mac's lacks is lawful and unread. Its rows of provider
`net.whatsapp.WhatsApp` are calls of that provider, as the Mac's are.
A store is read whatever it holds beyond a call's identity (`ZCALLRECORD`'s `Z_PK` and `ZUNIQUE_ID`,
`ZHANDLE.Z_PK`, the handle join's two keys, `ZEMERGENCYMEDIAITEM.ZUPLOADEDFORCALL` where that table
is): a column this connector reads that the store lacks is left out of its calls, as macOS 15's
`ZCALLRECORD` lacks `ZINITIATOR` (the initiator member left out), `ZCOMMUNICATIONTRUSTSCORE`,
`ZNEEDEDSCANNOUNCEMENT`, `ZBLOCKEDBYEXTENSIONNAME`, `ZREMINDERUUID`, `ZORIGINATINGUITYPE` and
`ZORIGINATINGDEVICENAME`; a store without `ZEMERGENCYMEDIAITEM` leaves `emergency_media` out. A store
that lacks an identity column is refused, naming it, and a column a later macOS adds is lawful and
unread: `lifestream report` names it.

| Kind | Key | Content | Time |
|---|---|---|---|
| `call` | `ZUNIQUE_ID` | `apple.call`: call (every `ZCALLRECORD` column it reads that the store has, BLOBs as `$bytes64`), initiator handle where the store has `ZINITIATOR`, remote handles and, where the store has them, emergency media, in canonical order | `ZDATE` to `ZDATE + ZDURATION` (Core Data seconds); no length, the instant; `ZDATE` zero or `NULL`, no time |

## Its adapter

`adapter.ts` (`appleCallsAdapter`, version 1, network `apple`) reads a `call` record for the calls
family (`packages/core/inputs/calls.ts`): `ZDATE`, `ZDURATION`, `ZORIGINATED`, `ZANSWERED`,
`ZSERVICE_PROVIDER`, `ZCALL_CATEGORY`, `ZNAME`, the remote handles' `ZTYPE`, `ZNORMALIZEDVALUE` and
`ZVALUE`. A call is connected when it was answered or has a length; an incoming one that was not
is missed. FaceTime category 2 is video. `ZREAD` flips when a missed call is seen, and junk scores
and conversation ids change between snapshots: none is read.

## Ledger

How the Mac keeps custody of this source: a memory of the store, per pass, holding every row sent by table, key, fingerprint and seal. `DatabaseDomainTests` in the macOS app hold each answer.

1. **Order.** None is needed: a read sends every row whose fingerprint the memory does not hold. Calls of the last 7 days (`ZDATE`) go live; older ones in history pages, newest first.
2. **Reuse.** A key that comes back with other values has another fingerprint, and ships.
3. **Rebuilds.** `Z_METADATA.Z_UUID`: a new store (a macOS migration, signing out of iCloud) renumbers; the memory starts again and the whole store ships.
4. **Late arrivals.** An iPhone's calls reach the Mac in batches, each with a new `Z_PK`: they ship as any new row, into a page when older than the live span.
5. **Edits.** A call changed in place, a participant joined, or emergency media uploaded changes a row's fingerprint, and the call ships with them. A call the person deleted ships nothing.
6. **Lost.** macOS prunes the oldest calls: the ids between the memory's highest call and the store's lowest are stated `call rows with ids <a> to <b> left the app before this Mac carried them`, once.
