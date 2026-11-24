import type { Adapter, InputRecord } from "./adapter.js";

/** One message of a mailbox, as where its bytes are and what the mailbox says of it. */
export interface MailItem {
  /** The blob of the message's original bytes as `message/rfc822`, as `sha256:<hex>`, which the family reads for its sender, subject and words. */
  blob: string | null;
  /** The bytes are the message as an mbox export holds it, with mboxrd's `>From ` quoting, which the family undoes before reading them. */
  exported?: boolean;
  /** The folder the mailbox files it in as junk, such as `Spam` or `Trash`, which the day names it as in and whose body the family does not read. */
  junk?: string | null;
  /** The mailbox says it is a draft, never sent, which the day prints as in Drafts and counts as no mail sent. */
  draft?: boolean;
  /** The mailbox's thread id, where a later mail of a draft's sender in the same thread hides the draft. */
  thread?: string | null;
}

/** How a mailbox's records become the mail of a day. */
export interface MailAdapter extends Adapter {
  /** Each of its sources' accounts is the mailbox's own address, so mail from that address is the person's own. */
  owner?: "account";
  /** One record read as its message, given a reader of the message's own headers that answers null before the bytes are read. */
  mail(record: InputRecord, header: (name: string) => string | null): MailItem | null;
}
