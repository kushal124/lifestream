import type { Adapter, AdapterVersion, InputRecord } from "./adapter.js";

/** A file the person attached to a turn of a chat. */
export interface AiFile {
  /** The file's name, which the day prints as attached. */
  name: string;
  /** The file's media type, which the model asked about the turn is told. */
  mime: string | null;
  /** The text the provider read out of the file, which counts toward the turn's length and is given to the model asked about it. */
  text: string | null;
}

/** One visible turn of a chat with an assistant, printed as a line of its conversation's day. */
export interface AiTurn {
  /** Who said it. */
  role:
    /** The person, whose long turns a model is asked to describe. */
    | "user"
    /** The assistant, printed under its connector's name, whose long replies a model is asked to sum up where the adapter asks it. */
    | "assistant";
  /** The turn's words as they were typed or written. */
  words: string;
  /** The files the person attached to it. */
  attachments: AiFile[];
  /** How many images it carried, which its line counts. */
  images: number;
  /** The names of the tools the assistant used in it, each once, which its line lists. */
  tools: string[];
  /** The titles of the documents the assistant made in it, which its line lists. */
  documents: string[];
  /** The recording of a question the person spoke rather than typed, whose words a model is asked to write down, or null for a typed turn. */
  voice?: {
    /** The recording's blob, as `sha256:<hex>`. */
    audio: string;
    /** The recording's length, in milliseconds. */
    ms: number;
  } | null;
}

/** The session an agent's log line belongs to, whose turns of each UTC hour are one unit. */
export interface AiSession {
  /** The session's id, unique in its source. */
  id: string;
  /** The folder the session ran in as a path, stated outside the lines themselves, which wins over what the lines state and titles the session. */
  cwd?: string | null;
}

/** What one line of an agent's log adds to its session's summary. */
export interface AiLine {
  /** The folder the line states the session ran in as a path, where the first line that states one names the session's folder, or null where it states one that cannot be read. */
  cwd?: string | null;
  /** The sub-agent that wrote the line, which the session counts. */
  agent?: string | null;
  /** The ids of the tool calls the line makes, unique in the session, which the session counts. */
  tools?: readonly string[];
  /** The paths of the files the line's edits name, which the session lists as edited relative to its folder. */
  files?: readonly string[];
  /** A turn the person typed, which the day prints under the session. */
  typed?: {
    /** The words the person typed. */
    words: string;
    /** How many images were sent with them. */
    images: number;
  } | null;
}

/** The words one line of an agent's log is searched by. */
export interface AiSaid {
  /** What the person typed or the agent wrote. */
  words: string;
  /** How many images were sent with a typed turn, which search finds it by too. */
  images?: number;
  /** The folder the line states it ran in as a path, which titles it in search where the adapter asks it. */
  cwd?: string | null;
}

/** The other records of the source the record being read came from. */
export interface SourceRecords {
  /** The live version of the record of that source with this kind and key, if there is one. */
  version(kind: string, key: string): AdapterVersion | undefined;
}

/** How an assistant's chats or a coding agent's logs become conversations and sessions on a day. */
export interface AiAdapter extends Adapter {
  /** The copy, such as `export`, whose sources name the units of an account's conversations, so that the account's other copies join them and lose a tie to it. */
  copy?: string;
  /** Whether the assistant's long replies are summed up by a model, rather than shown in part. */
  gist?: boolean;
  /** Whether a log line's search text is titled by the folder it ran in. */
  folder?: boolean;
  /** The person may speak a question, whose recording's words a model writes down. */
  voice?: true;
  /** One chat message read as its visible turn, or null for a record that is no visible turn. */
  turn?(record: InputRecord): AiTurn | null;
  /** One conversation record read as the conversation's title, or null where it states none. */
  title?(record: InputRecord): string | null;
  /** The session one agent log line belongs to, or null for a line of no session. */
  session?(record: InputRecord, records: SourceRecords): AiSession | null;
  /** What one agent log line adds to the session that `session` named. */
  line?(record: InputRecord, session: string, records: SourceRecords): AiLine | null;
  /** One agent log line's own words, or null for a line with none of its writer's, such as a tool's output. */
  said?(record: InputRecord): AiSaid | null;
}
