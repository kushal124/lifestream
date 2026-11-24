# Contacts: `apple-contacts:<account>:<copy>`, `google-contacts:<account>:export`

## What it reads

**`contacts-vcard`**: every `.vcf` file, sliced into cards byte for byte, never unfolded, each card
whole with its photo inside. A file is read once, as a stream, card by card, never whole, so no
size refuses it (`shared/vcard.ts` `streamCards`). A file with text between cards, a nested or
unclosed card, or bytes that are not UTF-8 is refused from its fault on, naming the file: every
whole card before the fault lands, each its own exact bytes, and the other files are read. Such
a file in an import keeps its import's file, which the reader never states consumed. A file of no bytes, or of white space alone,
holds no card: it lands nothing and is no refusal (a Takeout writes one for a contact list with no
member of its own). A delivery with no `.vcf` at all is refused. A Takeout's delivery (an import:
[imports.md](../../imports/imports.md)) is read only in the files its
listing gives the source, and in them only the `.vcf` members one folder under `Takeout/Contacts/`
(`Takeout/Contacts/<list>/<file>.vcf`), each for the account the import states; the listing
names the source `google-contacts:<account>:export`, the Google account's own address book (the
owner's ruling, 27 October). Once every row of such a file is landed and
none refused, the reader states it consumed, and the home lets it go.

The owner's people, the other label source the families name people by, is
[people](../../people/people.md).

## Kinds and keys

| Kind | Key | Content | Time |
|---|---|---|---|
| `contact` | SHA-256 of the card's bytes, 64 hex | `{type: "contacts.card", card}` | none: a card states no time |

An edited card is a new record; the old one stays, because an export never states a deletion. An
export has no identifier for a contact, and its bytes are the person's file: its key is the
card's hash.

The phone app reads the same address book and writes its own source,
`apple-contacts:<apple id>:<unit>` ([ios-app](../../ios-app/ios-app.md)): keyed by the system's
identifier for each contact, its photo its own blob, never in the card. Every reader of a contact
reads it through one adapter (`packages/families/shared/contact.ts`): a contact is known by its
source and key together, and its photo is the record's blob for the phone's and the card's own
`PHOTO` for an export's. Readers take every `apple-contacts` and `google-contacts` source and
name a handle by the first card that states it (`packages/families/shared/labels.ts`).

## Its adapter

`adapter.ts`, the labels family's: its `contact` records, each
card the vCard its content holds, so it reads none itself (`card` absent). It is registered for both
products the connector states, `apple-contacts` and `google-contacts`.
