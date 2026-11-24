# Gmail: `gmail:<address>:cloud`

Reader `gmail`. Source `gmail:<address>:cloud`: the account's one mailbox, the same from any
route. Two feeders bring it: `gmail-imap`, the IMAP poll, and `gmail-takeout`, a Takeout's Mail:
an import's delivery, which the home's listing routes to the mailbox
([imports.md](../../imports/imports.md)), or a delivery on the exporter's
lane that states it. Each delivery's facts state the
source and the feeder that brought it (`sources`); the home makes the source from whichever comes
first, naming that feeder, on no lane (a `cloud` source is no route's), and the registry's feeders
map both names to `gmail` (`home/registry-home.ts`), so either source row reads either route.
Turning the mailbox off stops its poll, and stops another lane that fed it only once every source
that lane's deliveries fed is off too (home/catalog.ts `Switch.poll`).
Both name a message by its X-GM-MSGID, so a message seen by both is one record.

## What it reads

A delivery is read by the feeder its facts name for the source, never by the files it holds. One
on another lane that names neither for the source (another account's, or another product's on
the exporter's lane) states nothing for it; one on the mailbox's own lane that names none, and one
that names another feeder, are refused.

- **`gmail-imap`**: a delivery the `gmail-imap` acquirer sealed. `pull.json`
  (`org.lifestreamprotocol.gmail-imap-pull/0.2`: account, fetched_at, folders with their
  UID cursors, and one entry per message: file, folder, X-GM-MSGID, X-GM-THRID, labels,
  INTERNALDATE, sha256, bytes) and one `msg-<X-GM-MSGID>.eml` per message. One without
  `pull.json` is refused. The account must be the source's. Each file must match the hash and
  size the pull states.
- **`gmail-takeout`**: a Takeout export. An archive delivery is read only in the files its
  listing gives the mailbox, and in them only the `.mbox` members under `Takeout/Mail/` (the
  archives' folder table's claim: a member of it that is no mailbox is refused by its name; the
  folder's settings files, `User Settings/*.json`, are claimed by no reader and are kept text, copied
  out beside the sweep's receipt, so they hold nothing back); once every row of such a file is landed
  and none refused, the reader states it consumed (core's `consumed` row), and the home lets it go once
  every member of it is claimed or kept text, and consumed. Every mailbox it holds, a file of its own or a member
  of one of its ZIPs, known by its first line, a Gmail delimiter, never by its name (a mailbox an
  export named `.zip` is read as the mailbox it is: `shared/members.ts`), streamed one message at
  a time. Finding mailboxes prefix-reads every ZIP member. A file whose first bytes are a zip's
  and which cannot be listed, a member whose prefix cannot be read, and a member named
  `.mbox` (where an export puts mail) whose first line is not the delimiter, are each refused
  alone, named by its path in the run's refusals, so the delivery is kept, and the rest lands. A
  mailbox whose bytes break part way (a bad CRC) keeps the messages before the break, and a
  message that cannot be read is refused alone. A message is the bytes between its Gmail delimiter line
  (`From <X-GM-MSGID>@xxx <date> +0000 <year>`) and the next, kept exactly: `>From ` quoting
  and the separating blank line included. Each row hands the home those bytes (`ReaderOutput.bytes`),
  one message at a time, to store as the message's blob.

The `gmail-imap` acquirer reads IMAP read-only, one session a call, each opened through the IMAP
connection the home lends it (`Dependencies.imap`). Its `fetch` runs at its
connector's refresh (every 5 minutes by default), at most 500 messages a call (`per_poll`, as a page), from each folder's
cursor `{uidvalidity, uidnext}` in the poll's cursor: new mail, from the first call on. It finds each
mailbox by the special use the server flags it with (RFC 6154), never by its name, which is the
account's language's (`[Gmail]/All Mail`, `[Google Mail]/All Mail`, `[Gmail]/Alle Nachrichten`):
always the one flagged `\All`, All Mail, which holds every message once but spam and trash; then,
when the connector's `spam` is on, the one flagged `\Junk`; then, when `trash` is on, the one
flagged `\Trash`. Both are off unless the person turns them on. A mailbox the poll reads that the
server lists with no flag (hidden from IMAP in Gmail's settings) refuses the poll, saying to tick
"Show in IMAP" beside it in Gmail's settings.
The cursor only moves forward. A folder with no cursor starts from now: its first poll takes
the folder's UIDNEXT as its cursor and fetches nothing, so mail lands from now on (or from a
`bootstrap` cursor where a seed left off). A fetch asks each new UID's `RFC822.SIZE` and
INTERNALDATE and leaves out one received before the stream's start (`lent.start_ms`), mail
imported or moved in with an old date, its cursor moving past it all the same. A folder whose
UIDVALIDITY changed is refused; a full pull of a folder is a person's decision. A fetch that stops
at its 500 with more is asked again at once.

The mailbox signs in by one route, a `key` route: "Use an app password", its two `steps` Google's 2-Step Verification on, then an app password
from Google's app-passwords page, each with a link, and its `note` "Signs in with an app password, never your Google password." The person types the address (`account`, the connector's
account field) and the app password (`password`); the home runs the route's check
(`gmailSignedIn`, exported as `signins`) before anything is sealed: the password with every space
and line end taken out (Google shows it in groups of four), one read-only session on
`imap.gmail.com` logged in as the address and logged out, through the IMAP connection the home lends
the check as it lends the poll (`Dependencies.imap`). The check
states no account: the address typed is the account. It answers the stripped password, which the
home seals under the password field's secret name and a generation (`gmail.password.1`) and the
block names. Google refusing the password, at the check or at a poll, is a login it answered NO to:
`NeedsYou` `signed-out`, "Gmail did not accept this app password", the person's to sign in again by
the route's sheet; a connection never made or cut while the login waited, as with no internet, is
the network's (connect `shared/offline.ts`): at the check, "Gmail did not answer" and nothing
written; at a poll, a wait the home polls again within a minute. imapflow takes no signal, so the
sign-in's deadline closes the check's session.

Its `page` reads the mailbox's history,
whenever the home's backfill pace says (`1m` by default, `30s` to `1h`), as far back as the
stream's start (`lent.start_ms`, a floor on INTERNALDATE; null for all). It reads All Mail alone downward by UID, below the lowest a page has read
(`low` in that folder's cursor) from where the live cursor stood when paging began (`start`): it
asks `UID SEARCH [SINCE <the start's date>] UID 1:<low − 1>`, the `RFC822.SIZE` of the highest
500, and then the sources of those that fit, highest first. It answers `left`, in emails: what the
search found that the page did not take. A search the server answers NO or BAD fails the page;
it is never "none left". UID order is not INTERNALDATE order (mail moved in or imported keeps its
received date at a new UID), so a start earlier than the one the cursor was left under
(`lent.from_ms`) walks again from the live cursor, `start` moved up to it, whichever call, fetch or
page, sees it first: what the later start's walk and the fetches since read (`read: {low, since}`,
at or above its `low`, `SINCE` that start's day) is searched apart and left out, never downloaded
twice, and the old-dated mail a fetch left out is read. A third start, earlier again, before that walk
passes the first's `low` reads that band again, and it lands restated. Google allows 2,500 MB of IMAP download a day ("Gmail bandwidth limits", read 26
October 2026; which day it counts is not stated), so the poll's memory keeps the mailbox's bytes of every
source either call downloaded in the last 24 hours (part `charged`: each call's instant, its bytes, dropped a day
after it), never the cursor, whose size would follow the day's calls. Either call asks a
source's `RFC822.SIZE` before the source, and each source is charged at that size as the FETCH
that asks for it begins, so a download cut midway, inside a message too, counts all it may have
cost. A page takes no message that would carry them past 2,000 MB, leaving the last 500 MB to new
mail. The charge survives whatever ends the call, as a call's memory commits with the cursor it gives: a sealed
call's with the cursor it returns; a call that fails after a download began is a wait (`NotYet`, the failure's words,
the network's offline wait for a cut connection) carrying the cursor as it was, and the charge with it, but a refusal (a
message answered without its source or `X-GM-MSGID`, a folder renumbered), which fails the call
as itself, every call downloading it again until a release reads it; a failure before any byte (a
folder gone or renumbered, every folder looked at before any is downloaded) is the call's own. A
page with none that fits waits (`NotYet` `next_ms`, when enough has aged out): its own turn, which
never holds the fetch. Google's own throttle (a command answered `NO [THROTTLED]`, which imapflow
gives as the response code of its parsed answer), to either call, is a provider back-off: nothing
is sealed, and the call's wait holds both calls an hour (`NotYet` `backoff_ms`), its downloads
charged. A `BYE` closes the session, which imapflow reports as any other closed connection: the
network's offline wait. A fetch carries `low`, `start` and `read` forward; a page writes its
folder's cursor whole, from `uidvalidity`, `uidnext`, `start`, `low` and `read`, and nothing else. A
mailbox connected before the page has no `start`: its first page starts at its live cursor as it
stands, so the mail the fetch brought since its
connect day is read once more and lands restated. A message both a page and a Takeout hold is one
record (below). Takeout stays the road to what IMAP hides.

The first page of each walk, the one that has taken nothing yet (`low` at `start`), counts the
whole mailbox for the price of a start, and so does any page while the cursor holds no
`counted: true`, the mark a count leaves, a walk that ended before counting included: that page
counts without downloading anything. A count is one `UID FETCH 1:<UIDNEXT − 1> (UID RFC822.SIZE
INTERNALDATE)` on All Mail, which the page holds open, and then on Spam and on Trash where they
are on, each message by the UTC month of its INTERNALDATE, its `RFC822.SIZE` its bytes. It answers
them as the page's `months` (the acquirer says `months: true`), above and below the start alike,
and no later page of the walk answers any; the home keeps them as the copy's count. A page that fails keeps
no count, and the page after it, having taken nothing yet either, counts again.

The cursor is the source's: the home hands a poll of another address no cursor, so a new
address reads from now, and the same address again keeps the cursor where no poll of another
wrote over it. Each delivery's facts state its source
(`gmail:<address>:cloud`, `gmail-imap`), which the home makes from the first one: no source is
added by hand.

## Kinds and keys

| Kind | Key | Content | Time |
|---|---|---|---|
| `mailmsg` | X-GM-MSGID, decimal | `{type: "gmail.msg", content, blobs: [the message bytes as message/rfc822]}`; `content` is `{from_line}` from Takeout, `{gm_msgid, gm_thrid, folder, labels, internaldate}` from IMAP | the `Date` header when it is a strict numeric-offset RFC 5322 date, its offset kept; else the internal date |
| `chat` | X-GM-THRID, decimal | `{type: "gmail.thread", thread_id, messages}`: every message the export puts in the thread, ascending; Takeout only | first to last internal date |

The read flag is never captured: other agents open the mail on the person's behalf.

A message both routes bring is one record with two versions: the two routes' bytes differ (a
Takeout's carry Gmail's `X-GM-THRID` and `X-Gmail-Labels` headers before the message, `>From `
quoting and the separating blank line; a pull's are the message as IMAP serves it), and so do
their contents. Each statement keeps its own version and blob. The newer statement is the head,
whichever came first: a pull's time is when it was fetched, a Takeout's when it was made
(`exported_at`), so a Takeout made after the pull replaces it, and a pull of mail older than the
Takeout lands late, leaving the head be. Proven, in both orders and from a source naming either
feeder, by `packages/home/import-kinds.e2e.test.ts`.

What that costs: a head that moves is read again by the mail family, and its tag (`mail-tag`)
is not asked again. The tag is named by the text the model reads, which prints the message and
never its route: a Takeout's bytes are read back first (Gmail's headers before the message are
never printed, the blank line after it is dropped, and its `From ` quoting reversed as mboxrd
writes it), so every version of the message that prints the same text is the same ask (the mail
family's [tag](../../../families/mail/)). So a message is
asked once, whichever route brings it first, and whichever is its head. The one exception: if
Gmail quotes as mboxo (only lines that start `From `), a line the sender wrote starting `>From `
reads differently from a Takeout and from a pull, and that message is asked once more. Proven,
a pull then a Takeout of the same messages, a Takeout the head before the deploy that named the
tag by its text included, by `packages/home/import-kinds.e2e.test.ts`.

## Its adapter

`adapter.ts` gives the mail family its mail adapter (`packages/core/inputs/mail.ts`), with
`owner: "account"` (the source's account is the mailbox's own address). A `mailmsg` record's
bytes are its one original `message/rfc822` blob. Spam, trash and chat are Gmail's word: the IMAP
folder (`Spam`, `Trash`, or one ending `/Spam` or `/Trash`), or a label `Spam`, `Trash` or `Chat`:
the pull's labels, else a Takeout's `X-Gmail-Labels` header. A draft is a label `Draft` or
`Drafts`. Its thread is the pull's `gm_thrid`, else a Takeout's `X-GM-THRID` header. A record
whose content states the mbox `from_line` (a Takeout's; a pull's never does) holds an mbox
export's bytes (`exported`). IMAP flags, other labels and the internal date are not read.
