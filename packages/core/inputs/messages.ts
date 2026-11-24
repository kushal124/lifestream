import type { Adapter, InputRecord } from "./adapter.js";

/** What kind of party an id names, which decides whether the family makes a person of it. */
export type PartyKind =
  /** The person whose home it is, whose messages a day prints as sent. */
  | "me"
  /** The chat itself, for an event no member stated, which a day prints but counts as no one's message. */
  | "system"
  /** A phone number, read as a person's handle by its spelling. */
  | "phone"
  /** An email address, read as a person's handle by its spelling. */
  | "email"
  /** A WhatsApp id, read as a person's handle by its spelling. */
  | "jid"
  /** An id of the adapter's own network as the network states it, without the product, which the family makes the handle `<product>:<id>`. */
  | "network"
  /** An id of no known kind, a person's handle only where its spelling is a phone, an address or a WhatsApp id. */
  | "raw";

/** One party to a message or a chat, which the family names on a day and joins to a person. */
export interface MessageParty {
  /** The party's id as the network spells it. */
  id: string;
  /** What kind of id it is. */
  kind: PartyKind;
}

/** Something a message carries besides its text, printed in square brackets after it. */
export interface MessagePart {
  /** The words a day prints for it, such as `photo`, `voice note` or `reaction: love`, where a `reaction` or `group event` start marks a message that is no message of its sender's count. */
  what: string;
  /** The blob of the file it carries, as `sha256:<hex>`, where the source holds its bytes. */
  blob?: string;
  /** The file's media type, where an `image/` type makes it one of the message's pictures and links the faces found on it to the message. */
  media_type?: string;
  /** What the family asks a model of the file, whose answer a day prints after the words. */
  ask?:
    /** A caption of an image. */
    | "caption"
    /** A transcript of a voice note. */
    | "transcript";
  /** The audio container the source names, which the family replaces with the container it reads from the file's own bytes. */
  format?: string;
  /** Its length in whole seconds, printed after its words. */
  seconds?: number;
  /** The latitude of a place it shares, in degrees, which a day prints as the place's name or its coordinates. */
  lat?: number;
  /** The longitude of a place it shares, in degrees. */
  lon?: number;
}

/** One message as a day prints it, at the time and under the key of the record it was read from. */
export interface MessageFact {
  /** The chat it was said in as the network spells it, whose messages of one UTC day are one unit. */
  chat: string;
  /** Who said it. */
  from: MessageParty;
  /** Its words, which a day prints and search finds. */
  text: string | null;
  /** What it carries besides its words. */
  parts: readonly MessagePart[];
  /** Whether it was forwarded, which a day prints as `(forwarded)` before it. */
  forwarded: boolean;
  /** Whether it was edited, which a day prints as `(edited)` after it. */
  edited: boolean;
  /** Whether the source states it unsent or deleted, which makes this copy the one a day prints over any other copy of the message. */
  withdrawn: boolean;
  /** The key on the same network of the message it answers or reacts to, which a day names with its sender and time. */
  reply_to: string | null;
}

/** What one label record of a network says about the ids its chats name, which People folds into one name per id. */
export interface MessageLabel {
  /** The names the network's app gives ids, each an id and the name, where the newest a record says wins. */
  names: readonly (readonly [id: string, name: string])[];
  /** A name a party gave itself on the network, as its id and the name. */
  pushName?: readonly [id: string, name: string];
  /** Two ids of one party, each read as the other's alias. */
  pair?: readonly [string, string];
  /** Whether the group the record's key names is archived, which a group setting may use to leave the group out of People. */
  archived?: boolean;
  /** The chat the record's key stands for, on a network whose app keys a chat by an id of its own. */
  chat?: string;
  /** A name for the chat that another record of the same source keys by `key` stands for. */
  named?: readonly [key: string, name: string];
  /** A business the network's app lists, which People shows as a business where its level is 3 or more. */
  business?: {
    /** The business's ids. */
    ids: readonly string[];
    /** How far the network verified its name, as the app states it, where WhatsApp counts 1 to 3 and 3 is highest. */
    level: number;
    /** The name the network verified. */
    name?: string;
  };
}

/** The images one message carries and who sent them, which the faces labeler reads to name the people in them. */
export interface MessageImages {
  /** Each image's blob, as `sha256:<hex>`. */
  blobs: readonly string[];
  /** Who sent them, where the chat is one-to-one and the owner did not send them, which the faces labeler reads as a sign of who is in them. */
  sender: {
    /** The kind of handle the value is. */
    kind:
      /** A WhatsApp id. */
      | "jid"
      /** A phone number. */
      | "phone"
      /** An email address. */
      | "email"
      /** The network's own id, which the labeler makes the handle `<product>:<id>`. */
      | "network";
    /** The handle's value. */
    value: string;
  } | null;
}

/** How a messaging network's records become chat lines, chat units, names and people. */
export interface MessagesAdapter extends Adapter {
  /** Each of its sources' accounts is the owner's own handle on the network, which People counts as the owner's. */
  owner?: "account";
  /** One message record read as a chat line, or null for a record that is no chat line. */
  message(record: InputRecord): MessageFact | null;
  /** The images one message record carries, or null for one that carries none, read by the faces labeler. */
  images?(record: InputRecord): MessageImages | null;
  /** Whether a chat is a group, told by its spelling alone. */
  group(chat: string): boolean;
  /** The parties a chat's own spelling names, which become its title and the people its messages are searched by. */
  members(chat: string): readonly MessageParty[];
  /** A record's key is `<chat>:<id>`, so the family reads the same message kept under a chat's alias as one. */
  keyed?: "chat";
  /** The chat a day shows a chat as, given the ids its labels pair it with, read only when a day needs it. */
  shown?(chat: string, aliases: () => readonly string[]): string;
  /** The words a page shows for a party of this network whose name it does not know. */
  unknown?(id: string): string;
  /** The network's own label records, which the labels family reads into names and the messages family into search words. */
  labels?: {
    /** The kinds of its label records. */
    kinds: readonly string[];
    /** The ids its labels name are WhatsApp ids, kept as `jid` handles rather than `<product>:<id>`. */
    ids?: "jid";
  };
  /** What one of its label records says, or null for one that says nothing a label holds. */
  label?(record: InputRecord): MessageLabel | null;
  /** A label record's search words, as a title and the ids it names as the network spells them, each searched as its party, or null for one with none. */
  labelText?(record: InputRecord): { title: string | null; who: readonly string[] } | null;
  /** The id its labels name a handle by, or null for a handle it spells none of. */
  labelId?(handle: { kind: string; value: string }): string | null;
  /** The owner's own id that a source's account stands for, which takes no name from the app's labels, or null where the account is none of its ids. */
  self?(account: string): string | null;
}
