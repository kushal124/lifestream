import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createHistory, type History } from "../packages/connect/browser/chrome/test/fixture.js";
import { folderAt, frameLine, inlineDelivery } from "../packages/connect/macos-app/screen/test/fixture.js";
import { acquisitionBundle, zip } from "../packages/home/test/support.js";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const PAGE_ROWS = 20_000;
export const LIVE_MS = 7 * DAY_MS;
export const ACCOUNT = "person-a@example.com";
export const WHATSAPP_ACCOUNT = "+15550000001";
export const CHROME_PROFILE = "profile-1";

export const MAC_STREAMS = ["whatsapp", "imessage", "chrome", "screen", "claude-code"] as const;
export const PHONE_STREAMS = ["location", "motion", "apple-health", "apple-photos"] as const;
export type MacStream = (typeof MAC_STREAMS)[number];
export type PhoneStream = (typeof PHONE_STREAMS)[number];
export type StreamName = MacStream | PhoneStream;
export const DATABASES: ReadonlySet<StreamName> = new Set(["whatsapp", "imessage", "chrome"]);

export type Rates = Record<StreamName, number>;

export interface Size {
  full_days: number;
  history_days: number;
  full: Rates;
  light: Rates;
  takeout: { entries: number; bad_bytes: number };
  live: { rounds: number; every_ms: number };
  photo_bytes: number;
  reply_bytes: number;
  helpers: number | "auto";
}

const OWNER: Rates = {
  whatsapp: 3_000, imessage: 500, chrome: 3_000, screen: 17_280, "claude-code": 20_000,
  location: 8_640, motion: 500, "apple-health": 100_000, "apple-photos": 30,
};
const LIGHT: Rates = {
  whatsapp: 300, imessage: 50, chrome: 200, screen: 0, "claude-code": 0,
  location: 500, motion: 50, "apple-health": 2_000, "apple-photos": 3,
};

export const SIZES: Readonly<Record<"tiny" | "week" | "heavy" | "founder", Size>> = {
  tiny: {
    full_days: 1, history_days: 2,
    full: { whatsapp: 24, imessage: 12, chrome: 24, screen: 48, "claude-code": 24, location: 48, motion: 12, "apple-health": 96, "apple-photos": 4 },
    light: { whatsapp: 12, imessage: 6, chrome: 12, screen: 0, "claude-code": 0, location: 12, motion: 4, "apple-health": 24, "apple-photos": 2 },
    takeout: { entries: 20, bad_bytes: 64 * 1024 }, live: { rounds: 3, every_ms: 500 }, photo_bytes: 0, reply_bytes: 400, helpers: 3,
  },
  week: {
    full_days: 7, history_days: 365, full: OWNER, light: LIGHT,
    takeout: { entries: 2_000, bad_bytes: 32 * 1024 * 1024 }, live: { rounds: 30, every_ms: 2_000 }, photo_bytes: 0, reply_bytes: 2_000, helpers: "auto",
  },
  heavy: {
    full_days: 365, history_days: 3_650, full: OWNER, light: LIGHT,
    takeout: { entries: 50_000, bad_bytes: 512 * 1024 * 1024 }, live: { rounds: 60, every_ms: 2_000 }, photo_bytes: 160 * 1024, reply_bytes: 2_000, helpers: "auto",
  },
  founder: {
    full_days: 365, history_days: 3_650,
    full: { whatsapp: 570, imessage: 95, chrome: 570, screen: 3_283, "claude-code": 3_800, location: 1_642, motion: 95, "apple-health": 7_800, "apple-photos": 2_000 },
    light: { whatsapp: 57, imessage: 10, chrome: 38, screen: 0, "claude-code": 0, location: 95, motion: 10, "apple-health": 380, "apple-photos": 11 },
    takeout: { entries: 50_000, bad_bytes: 64 * 1024 * 1024 }, live: { rounds: 60, every_ms: 2_000 }, photo_bytes: 4 * 1024, reply_bytes: 2_000, helpers: "auto",
  },
};


export class Stream {
  readonly history: number;
  readonly full: number;
  readonly #appended: number[] = [];

  constructor(readonly name: StreamName, readonly life: Life) {
    this.history = Math.round(life.size.light[name] * life.size.history_days);
    this.full = Math.round(life.size.full[name] * life.size.full_days);
  }

  get top(): number {
    return this.history + this.full + this.#appended.length;
  }

  time(ordinal: number): number {
    const { history_start, full_start, end } = this.life;
    const sat = this.name === "screen" ? sitting : (ms: number) => ms;
    if (ordinal <= this.history) return sat(Math.floor(history_start + (ordinal - 0.5) * ((full_start - history_start) / this.history)));
    if (ordinal <= this.history + this.full) return sat(Math.floor(end - (this.history + this.full - ordinal) * ((end - full_start) / this.full)));
    return this.#appended[ordinal - this.history - this.full - 1]!;
  }

  within(from_ms: number, to_ms: number): [number, number] | null {
    const first = this.#search(from_ms), last = this.#search(to_ms) - 1;
    return first > last ? null : [first, last];
  }

  append(times: number[]): [number, number] {
    const first = this.top + 1;
    this.#appended.push(...times);
    return [first, this.top];
  }

  #search(ms: number): number {
    let low = 1, high = this.history + this.full + 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.time(middle) < ms) low = middle + 1;
      else high = middle;
    }
    return low;
  }
}

const SITTING_BLOCK_MS = 3 * HOUR_MS;

function sitting(ms: number): number {
  const block = Math.floor(ms / SITTING_BLOCK_MS) * SITTING_BLOCK_MS;
  return block + Math.floor((ms - block) * 0.9);
}

export interface Page {
  from_ms: number;
  to_ms: number;
  history: boolean;
}

export class Life {
  readonly end: number;
  readonly full_start: number;
  readonly history_start: number;
  readonly streams: Record<StreamName, Stream>;

  constructor(readonly size: Size, readonly seed: number, readonly now_ms: number) {
    this.end = now_ms - MINUTE_MS;
    this.full_start = this.end - size.full_days * DAY_MS;
    this.history_start = this.full_start - size.history_days * DAY_MS;
    this.streams = Object.fromEntries([...MAC_STREAMS, ...PHONE_STREAMS].map((name) => [name, new Stream(name, this)])) as Record<StreamName, Stream>;
  }

  pages(names: readonly StreamName[]): Page[] {
    const screen = names.length === 1 && names[0] === "screen";
    const live_from = screen
      ? (this.streams.screen.top <= PAGE_ROWS ? this.history_start : Math.floor(this.now_ms / HOUR_MS) * HOUR_MS - HOUR_MS)
      : Math.max(this.full_start, this.end - LIVE_MS + 1);
    const periods: Page[] = [
      { from_ms: live_from, to_ms: this.end + 1, history: false },
      { from_ms: this.full_start, to_ms: live_from, history: true },
      { from_ms: this.history_start, to_ms: Math.min(this.full_start, live_from), history: true },
    ];
    const whole = names.every((name) => DATABASES.has(name));
    const pages: Page[] = [];
    for (const period of periods) {
      if (period.to_ms <= period.from_ms) continue;
      const rows = names.reduce((sum, name) => sum + count(this.streams[name].within(period.from_ms, period.to_ms)), 0);
      if (rows === 0) continue;
      if (whole && !period.history) {
        pages.push(period);
        continue;
      }
      const span = period.to_ms - period.from_ms;
      const parts = Math.ceil(rows / PAGE_ROWS);
      for (let part = parts; part >= 1; part--) {
        pages.push({ from_ms: period.from_ms + Math.floor((span * (part - 1)) / parts), to_ms: period.from_ms + Math.floor((span * part) / parts), history: period.history });
      }
    }
    return screen ? pages.sort((a, b) => Number(a.history) - Number(b.history) || a.from_ms - b.from_ms) : pages;
  }

  pick(name: string, ordinal: number, range: number): number {
    return createHash("sha256").update(`${this.seed}:${name}:${ordinal}`).digest().readUInt32BE(0) % range;
  }

  uuid(name: string, ordinal: number): string {
    const hex = createHash("sha256").update(`${this.seed}:${name}:${ordinal}:uuid`).digest("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  }
}

export function count(range: [number, number] | null): number {
  return range === null ? 0 : range[1] - range[0] + 1;
}

export interface Upload {
  path: string;
  bytes: Buffer;
  rows: number;
  by: Record<string, number>;
}


export type MacContent = { stream: MacStream; ordinals: [number, number]; history: boolean } | { takeout: true };

export function macDelivery(life: Life, source: string, content: MacContent, seal: number, fetched_ms: number): Upload {
  const custody = { [source]: { seal } };
  if ("takeout" in content) {
    const { files, rows } = takeout(life);
    return { ...acquisitionBundle({ source, feeder: "upload-folder", fetched_ms, files, custody }), rows, by: {} };
  }
  const { stream, ordinals, history } = content;
  const facts = history ? { history: true } : {};
  const rows = ordinals[1] - ordinals[0] + 1;
  const changes = { kind: "changes" };
  const bundle = (feeder: string, files: [string, Buffer][], stated: Record<string, unknown>) =>
    ({ ...acquisitionBundle({ source, feeder, fetched_ms, files, facts: { ...stated, ...facts }, custody }), rows, by: { [stream]: rows } });
  switch (stream) {
    case "whatsapp": return bundle("whatsapp-mac", [["chats.sqlite", whatsappStore(life, ordinals)]], changes);
    case "imessage": return bundle("imessage-mac", [["messages.db", imessageStore(life, ordinals)]], changes);
    case "chrome": return bundle("chrome-mac", [["history.sqlite", chromeStore(life, ordinals)]], changes);
    case "screen": return bundle("screen-recorder", [["observations.jsonl", screenLines(life, ordinals)]], {});
    case "claude-code": return bundle("claude-code-sessions", claudeSession(life, ordinals), {});
  }
}

function store(write: (path: string) => void): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "volume-store-"));
  try {
    const path = join(dir, "store.sqlite");
    write(path);
    return readFileSync(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const APPLE_EPOCH_MS = 978_307_200_000;
const CHATS = 12;

const WHATSAPP_SCHEMA = `
CREATE TABLE ZWAPROFILEPUSHNAME (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZJID VARCHAR, ZPUSHNAME VARCHAR);
CREATE TABLE ZWACHATSESSION (
  Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCONTACTJID VARCHAR, ZCONTACTIDENTIFIER VARCHAR,
  ZPARTNERNAME VARCHAR, ZSESSIONTYPE INTEGER, ZFLAGS INTEGER, ZARCHIVED INTEGER, ZHIDDEN INTEGER, ZREMOVED INTEGER,
  ZMESSAGECOUNTER INTEGER, ZUNREADCOUNT INTEGER, ZIDENTITYVERIFICATIONSTATE INTEGER, ZIDENTITYVERIFICATIONEPOCH INTEGER,
  ZLASTMESSAGEDATE TIMESTAMP, ZLASTMESSAGETEXT VARCHAR, ZLOCATIONSHARINGENDDATE TIMESTAMP, ZETAG VARCHAR,
  ZSAVEDINPUT VARCHAR, ZSPOTLIGHTSTATUS INTEGER, ZCONTACTABID INTEGER, ZGROUPINFO INTEGER, ZLASTMESSAGE INTEGER,
  ZPROPERTIES BLOB
);
CREATE TABLE ZWAGROUPINFO (
  Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCHATSESSION INTEGER, ZLASTMESSAGEOWNER INTEGER,
  ZPICTUREPATH VARCHAR, ZSTATE INTEGER, ZCREATIONDATE TIMESTAMP, ZSUBJECTTIMESTAMP TIMESTAMP, ZCREATORJID VARCHAR,
  ZOWNERJID VARCHAR, ZSUBJECTOWNERJID VARCHAR, ZSOURCEJID VARCHAR, ZPICTUREID VARCHAR
);
CREATE TABLE ZWAMEDIAITEM (
  Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZFILESIZE INTEGER, ZMEDIAORIGIN INTEGER,
  ZMOVIEDURATION FLOAT, ZASPECTRATIO FLOAT, ZHACCURACY FLOAT, ZLATITUDE FLOAT, ZLONGITUDE FLOAT,
  ZMEDIAURLDATE TIMESTAMP, ZAUTHORNAME VARCHAR, ZCOLLECTIONNAME VARCHAR, ZMEDIAURL VARCHAR, ZTITLE VARCHAR,
  ZVCARDNAME VARCHAR, ZVCARDSTRING VARCHAR, ZMEDIAKEY BLOB, ZMESSAGE INTEGER, ZMEDIALOCALPATH VARCHAR,
  ZTHUMBNAILLOCALPATH VARCHAR, ZXMPPTHUMBPATH VARCHAR, ZCLOUDSTATUS INTEGER, ZMETADATA BLOB
);
CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZMEMBERJID VARCHAR, ZCONTACTIDENTIFIER VARCHAR);
CREATE TABLE ZWAMESSAGE (
  Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZSORT INTEGER, ZDOCID VARCHAR, ZSPOTLIGHTSTATUS INTEGER,
  ZCHATSESSION INTEGER, ZGROUPMEMBER INTEGER, ZLASTSESSION INTEGER, ZMEDIAITEM INTEGER, ZMESSAGEINFO INTEGER,
  ZPARENTMESSAGE INTEGER, ZSTANZAID VARCHAR, ZTEXT VARCHAR, ZFROMJID VARCHAR, ZTOJID VARCHAR, ZPUSHNAME VARCHAR,
  ZMESSAGEDATE TIMESTAMP, ZSENTDATE TIMESTAMP, ZMESSAGETYPE INTEGER, ZGROUPEVENTTYPE INTEGER, ZFLAGS INTEGER,
  ZMESSAGESTATUS INTEGER, ZMESSAGEERRORSTATUS INTEGER, ZISFROMME INTEGER, ZSTARRED INTEGER, ZMEDIASECTIONID VARCHAR,
  ZPHASH VARCHAR, ZENCRETRYCOUNT INTEGER, ZFILTEREDRECIPIENTCOUNT INTEGER, ZCHILDMESSAGESDELIVEREDCOUNT INTEGER,
  ZCHILDMESSAGESPLAYEDCOUNT INTEGER, ZCHILDMESSAGESREADCOUNT INTEGER, ZDATAITEMVERSION INTEGER
);
CREATE INDEX Z_WAMESSAGE_CHATSESSION ON ZWAMESSAGE (ZCHATSESSION);
CREATE TABLE ZWAMESSAGEINFO (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZMESSAGE INTEGER, ZRECEIPTINFO BLOB);
CREATE TABLE ZWAPROFILEPICTUREITEM (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZJID VARCHAR, ZTHUMBNAILDATA BLOB);
`;

const peer = (chat: number) => `155500001${String(chat).padStart(2, "0")}`;

function whatsappStore(life: Life, [first, last]: [number, number]): Buffer {
  const stream = life.streams.whatsapp;
  return store((path) => {
    const db = new Database(path);
    db.exec(WHATSAPP_SCHEMA);
    db.exec("ALTER TABLE ZWAMESSAGE ADD COLUMN ZSYNTHETICLATER INTEGER");
    db.exec("BEGIN");
    const message = db.prepare(`INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, Z_OPT, ZSORT, ZDOCID, ZSPOTLIGHTSTATUS, ZCHATSESSION, ZSTANZAID, ZTEXT,
      ZFROMJID, ZTOJID, ZPUSHNAME, ZMESSAGEDATE, ZSENTDATE, ZMESSAGETYPE, ZGROUPEVENTTYPE, ZFLAGS, ZMESSAGESTATUS, ZMESSAGEERRORSTATUS,
      ZISFROMME, ZENCRETRYCOUNT, ZFILTEREDRECIPIENTCOUNT, ZCHILDMESSAGESDELIVEREDCOUNT, ZCHILDMESSAGESPLAYEDCOUNT, ZCHILDMESSAGESREADCOUNT, ZDATAITEMVERSION)
      VALUES (?, 9, 4, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, 0, ?, 0, 0, 0, 0, 0, 3)`);
    const chats = new Map<number, number>();
    for (let ordinal = first; ordinal <= last; ordinal++) {
      const chat = life.pick("whatsapp-chat", ordinal, CHATS) + 1;
      const mine = life.pick("whatsapp-mine", ordinal, 2);
      const date = (stream.time(ordinal) - APPLE_EPOCH_MS) / 1000;
      const me = `${WHATSAPP_ACCOUNT.slice(1)}@s.whatsapp.net`, them = `${peer(chat)}@s.whatsapp.net`;
      message.run(ordinal, ordinal, ordinal * 7, chat, `SYNTH-${life.seed}-${ordinal}`, `synthetic message ${ordinal} in chat ${chat}`,
        mine === 1 ? me : them, mine === 1 ? them : me, mine === 1 ? null : `Synthetic Person ${chat}`, date, date + 0.25, mine === 1 ? 8 : 6, mine);
      chats.set(chat, Math.max(chats.get(chat) ?? 0, date));
    }
    const chat = db.prepare(`INSERT INTO ZWACHATSESSION (Z_PK, Z_ENT, Z_OPT, ZCONTACTJID, ZPARTNERNAME, ZSESSIONTYPE, ZFLAGS, ZARCHIVED, ZHIDDEN, ZREMOVED,
      ZMESSAGECOUNTER, ZUNREADCOUNT, ZIDENTITYVERIFICATIONSTATE, ZIDENTITYVERIFICATIONEPOCH, ZLASTMESSAGEDATE, ZLASTMESSAGETEXT, ZLOCATIONSHARINGENDDATE,
      ZETAG, ZSPOTLIGHTSTATUS, ZCONTACTABID, ZPROPERTIES) VALUES (?, 6, 3, ?, ?, 0, 0, 0, 0, 0, 2, 0, 0, 0, ?, 'synthetic last line', 0, ?, 1, ?, ?)`);
    const name = db.prepare("INSERT INTO ZWAPROFILEPUSHNAME (Z_PK, Z_ENT, Z_OPT, ZJID, ZPUSHNAME) VALUES (?, 12, 1, ?, ?)");
    for (const [pk, last_date] of [...chats].sort((a, b) => a[0] - b[0])) {
      chat.run(pk, `${peer(pk)}@s.whatsapp.net`, `Synthetic Chat ${pk}`, last_date, `SYNTH-ETAG-${pk}`, 100 + pk, Buffer.from([1, pk]));
      name.run(pk, `${peer(pk)}@s.whatsapp.net`, `Synthetic Person ${pk}`);
    }
    db.exec("COMMIT");
    db.close();
  });
}

const IMESSAGE_SCHEMA = `
CREATE TABLE _SqliteDatabaseProperties (key TEXT, value TEXT, UNIQUE(key));
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, country TEXT, service TEXT NOT NULL, uncanonicalized_id TEXT);
CREATE TABLE chat (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, state INTEGER, account_id TEXT,
  properties BLOB, chat_identifier TEXT, service_name TEXT, room_name TEXT, account_login TEXT, is_archived INTEGER DEFAULT 0,
  last_addressed_handle TEXT, display_name TEXT, group_id TEXT, is_filtered INTEGER, successful_query INTEGER,
  last_read_message_timestamp INTEGER DEFAULT 0
);
CREATE TABLE message (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT NOT NULL, text TEXT, replace INTEGER DEFAULT 0,
  service_center TEXT, handle_id INTEGER DEFAULT 0, subject TEXT, country TEXT, attributedBody BLOB, version INTEGER DEFAULT 0,
  type INTEGER DEFAULT 0, service TEXT, account TEXT, account_guid TEXT, error INTEGER DEFAULT 0, date INTEGER,
  date_read INTEGER, date_delivered INTEGER, is_delivered INTEGER DEFAULT 0, is_finished INTEGER DEFAULT 0,
  is_emote INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0, is_empty INTEGER DEFAULT 0, is_delayed INTEGER DEFAULT 0,
  is_auto_reply INTEGER DEFAULT 0, is_prepared INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0, is_system_message INTEGER DEFAULT 0,
  is_sent INTEGER DEFAULT 0, has_dd_results INTEGER DEFAULT 0, is_played INTEGER DEFAULT 0, was_downgraded INTEGER DEFAULT 0,
  did_notify_recipient INTEGER DEFAULT 0, cache_roomnames TEXT, associated_message_guid TEXT,
  associated_message_type INTEGER DEFAULT 0, message_summary_info BLOB, date_edited INTEGER DEFAULT 0,
  date_retracted INTEGER DEFAULT 0, flags INTEGER DEFAULT 0
);
CREATE TABLE attachment (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, created_date INTEGER DEFAULT 0, filename TEXT,
  uti TEXT, mime_type TEXT, transfer_state INTEGER DEFAULT 0, is_outgoing INTEGER DEFAULT 0, transfer_name TEXT, total_bytes INTEGER DEFAULT 0
);
CREATE TABLE chat_message_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
CREATE TABLE chat_handle_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, handle_id INTEGER REFERENCES handle (ROWID) ON DELETE CASCADE, UNIQUE(chat_id, handle_id));
CREATE TABLE message_attachment_join (message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, attachment_id INTEGER REFERENCES attachment (ROWID) ON DELETE CASCADE, UNIQUE(message_id, attachment_id));
CREATE TABLE sync_chat_slice (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, service_name TEXT, chat_id TEXT, slice BLOB);
CREATE INDEX chat_message_join_idx_message_id_only ON chat_message_join (message_id);
CREATE INDEX message_attachment_join_idx_message_id ON message_attachment_join (message_id);
CREATE INDEX chat_handle_join_idx_handle_id ON chat_handle_join (handle_id);
INSERT INTO _SqliteDatabaseProperties (key, value) VALUES ('_ClientVersion', '19201'), ('counter_in_all', '9');
`;

function imessageStore(life: Life, [first, last]: [number, number]): Buffer {
  const stream = life.streams.imessage;
  return store((path) => {
    const db = new Database(path);
    db.exec(IMESSAGE_SCHEMA);
    db.exec("BEGIN");
    const chats = new Set<number>();
    for (let ordinal = first; ordinal <= last; ordinal++) chats.add(life.pick("imessage-chat", ordinal, CHATS) + 1);
    const handle = db.prepare("INSERT INTO handle (ROWID, id, country, service, uncanonicalized_id) VALUES (?, ?, 'us', 'iMessage', NULL)");
    const chat = db.prepare(`INSERT INTO chat (ROWID, guid, style, state, account_id, properties, chat_identifier, service_name, room_name, account_login,
      is_archived, last_addressed_handle, display_name, group_id, is_filtered, successful_query, last_read_message_timestamp)
      VALUES (?, ?, 45, 3, 'SYNTH-ACCOUNT', ?, ?, 'iMessage', NULL, ?, 0, ?, '', ?, 0, 1, 0)`);
    const member = db.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)");
    for (const pk of [...chats].sort((a, b) => a - b)) {
      handle.run(pk, `+${peer(pk)}`);
      chat.run(pk, `iMessage;-;+${peer(pk)}`, Buffer.from([0x62, 0x70, pk]), `+${peer(pk)}`, `E:${ACCOUNT}`, WHATSAPP_ACCOUNT, `SYNTH-GROUP-${pk}`);
      member.run(pk, pk);
    }
    const message = db.prepare(`INSERT INTO message (ROWID, guid, text, handle_id, service, account, date, date_read, date_delivered, is_delivered, is_finished,
      is_from_me, is_read, is_sent, is_played, was_downgraded, did_notify_recipient, associated_message_type, date_edited, date_retracted, flags)
      VALUES (?, ?, ?, ?, 'iMessage', ?, ?, ?, ?, 1, 1, ?, ?, ?, 0, 0, 0, 0, 0, 0, 5)`);
    const joined = db.prepare("INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (?, ?, ?)");
    for (let ordinal = first; ordinal <= last; ordinal++) {
      const chat = life.pick("imessage-chat", ordinal, CHATS) + 1;
      const mine = life.pick("imessage-mine", ordinal, 2);
      const date = BigInt(stream.time(ordinal) - APPLE_EPOCH_MS) * 1_000_000n;
      message.run(ordinal, `SYNTH-${life.seed}-${ordinal}`, `synthetic message ${ordinal} in chat ${chat}`, chat, `e:${ACCOUNT}`, date,
        mine === 1 ? 0n : date + 1_000_000_000n, date + 1n, mine, mine === 1 ? 0 : 1, mine);
      joined.run(chat, ordinal, date);
    }
    db.exec("COMMIT");
    db.close();
  });
}

const CHROME_PAGES = 4_000;
const CHROME_LEFT_OPEN = 500;

function chromeStore(life: Life, [first, last]: [number, number]): Buffer {
  const stream = life.streams.chrome;
  const microseconds = (ms: number) => (BigInt(ms) + 11_644_473_600_000n) * 1000n;
  const urls = new Map<number, History["urls"][number]>();
  const visits: History["visits"] = [];
  const searches = new Map<number, History["searches"][number]>();
  for (let ordinal = first; ordinal <= last; ordinal++) {
    const page = life.pick("chrome-page", ordinal, CHROME_PAGES) + 1;
    const at = microseconds(stream.time(ordinal));
    const stay = life.pick("chrome-open", ordinal, CHROME_LEFT_OPEN) === 0
      ? BigInt(DAY_MS + life.pick("chrome-days", ordinal, 20 * DAY_MS)) * 1000n
      : BigInt(life.pick("chrome-stay", ordinal, 120_000)) * 1000n;
    visits.push({ id: ordinal, url: page, at, duration: stay });
    const seen = urls.get(page);
    const site = `site-${page % (CHROME_PAGES / 10)}.example.com`;
    const search = page % 10 === 0;
    const url = search
      ? `https://search.example.com/search?q=synthetic+query+${page}&source=hp&ei=SYNTH${page}AAAAAAAAAAAAAAAAAAAAAAAAAA&oq=synthetic+query&sclient=gws-wiz`
      : `https://${site}/articles/2026/section-${page % 7}/synthetic-article-number-${page}-with-a-long-slug?utm_source=synthetic&utm_medium=feed&ref=${page % 13}`;
    const title = search ? `synthetic query ${page} - Search` : `Synthetic article ${page}: a title of a sentence, as most pages give one | Site ${page % (CHROME_PAGES / 10)}`;
    urls.set(page, { id: page, url, title, visitCount: (seen?.visitCount ?? 0) + 1, lastVisit: at });
    if (search) searches.set(page, { keyword: 2, url: page, term: `synthetic query ${page}` });
  }
  return store((path) => createHistory(path, { urls: [...urls.values()].sort((a, b) => a.id - b.id), visits, searches: [...searches.values()], downloads: [] }));
}

const FRAME = (() => {
  const lines = inlineDelivery().files["observations.jsonl"]!.toString("utf8").split("\n").filter((line) => line !== "" && !line.includes('"status":"gap"'));
  const line = lines[0]!;
  const spelling = line.slice(line.indexOf('"observation":') + '"observation":'.length, line.lastIndexOf(',"archive":'));
  const { capturedAt, capturedUntil } = JSON.parse(spelling) as { capturedAt: number; capturedUntil: number };
  return { spelling, at: `"capturedAt":${capturedAt},`, until: `"capturedUntil":${capturedUntil},` };
})();

function screenLines(life: Life, [first, last]: [number, number]): Buffer {
  const stream = life.streams.screen;
  const lines: string[] = [];
  for (let ordinal = first; ordinal <= last; ordinal++) {
    const at = stream.time(ordinal) + 0.25;
    const observation = FRAME.spelling.replace(FRAME.at, `"capturedAt":${at},`).replace(FRAME.until, `"capturedUntil":${at + 31.25},`);
    lines.push(`${frameLine(folderAt(at, ordinal), observation)}\n`);
  }
  return Buffer.from(lines.join(""));
}

function claudeSession(life: Life, [first, last]: [number, number]): [string, Buffer][] {
  const stream = life.streams["claude-code"];
  const session = life.uuid("claude-session", first);
  const reply = "synthetic reply text ".repeat(Math.ceil(life.size.reply_bytes / 21)).slice(0, life.size.reply_bytes);
  const common = { userType: "external", entrypoint: "cli", cwd: "/Users/person-a/project", sessionId: session, version: "2.1.290", gitBranch: "main" };
  const lines: string[] = [];
  let parent: string | null = null;
  for (let ordinal = first; ordinal <= last; ordinal++) {
    const uuid = life.uuid("claude-line", ordinal);
    const timestamp = new Date(stream.time(ordinal)).toISOString();
    const line = ordinal % 2 === 1
      ? { parentUuid: parent, isSidechain: false, promptId: `prompt-${ordinal}`, type: "user", message: { role: "user", content: `synthetic prompt ${ordinal}` }, uuid, timestamp, permissionMode: "default", promptSource: "typed", origin: { kind: "human" }, ...common }
      : { parentUuid: parent, isSidechain: false, message: { model: "claude-example", id: `msg_${ordinal}`, type: "message", role: "assistant", content: [{ type: "text", text: reply }] }, type: "assistant", uuid, timestamp, ...common };
    lines.push(JSON.stringify(line));
    parent = uuid;
  }
  const log = `${session}.jsonl`;
  const parts = { parts: [{ file: log, from_byte: 0, from_line: 1, lines: lines.length }], files: [] };
  return [["parts.json", Buffer.from(JSON.stringify(parts))], [log, Buffer.from(lines.map((line) => `${line}\n`).join(""))]];
}

export const TAKEOUT_PRODUCTS = ["google-search", "youtube"] as const;
export const TAKEOUT_GOOD = "Takeout/takeout-20261001T000000Z-001.zip";
export const TAKEOUT_MAILBOX = "Takeout/takeout-20261001T000000Z-002.zip";
export const TAKEOUT_BAD = "Takeout/takeout-20261001T000000Z-003.zip";

function takeout(life: Life): { files: [string, Buffer][]; rows: number } {
  const { entries, bad_bytes } = life.size.takeout;
  const search: object[] = [], youtube: object[] = [];
  for (let ordinal = 1; ordinal <= entries; ordinal++) {
    const time = new Date(life.history_start + life.pick("takeout-time", ordinal, Math.max(1, life.full_start - life.history_start))).toISOString();
    if (ordinal % 2 === 1) {
      search.push({ header: "Search", title: `Searched for synthetic query ${ordinal}`, titleUrl: `https://www.google.com/search?q=synthetic+query+${ordinal}`, time, products: ["Search"], activityControls: ["Search Services History"] });
    } else {
      youtube.push({ header: "YouTube", title: `Watched Synthetic video ${ordinal}`, titleUrl: `https://www.youtube.com/watch?v=synthetic${ordinal}`, time, products: ["YouTube"], activityControls: ["YouTube watch history"] });
    }
  }
  const archive = zip([
    ["Takeout/My Activity/Search/MyActivity.json", Buffer.from(JSON.stringify(search))],
    ["Takeout/My Activity/YouTube/MyActivity.json", Buffer.from(JSON.stringify(youtube))],
  ]);
  const message = "From synthetic@example.com Thu Oct  1 00:00:00 2026\nFrom: person-a@example.com\nSubject: synthetic\n\nsynthetic body\n\n";
  const mailbox = Buffer.from(message.repeat(Math.ceil(bad_bytes / message.length))).subarray(0, bad_bytes);
  const broken = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("synthetic archive cut short")]);
  const index = { format: "org.lifestreamprotocol.upload/1", files: [TAKEOUT_GOOD, TAKEOUT_MAILBOX, TAKEOUT_BAD].map((path) => ({ path, media_type: "application/zip" })) };
  return {
    files: [["upload.json", Buffer.from(JSON.stringify(index))], [`files/${TAKEOUT_GOOD}`, archive], [`files/${TAKEOUT_MAILBOX}`, mailbox], [`files/${TAKEOUT_BAD}`, broken]],
    rows: entries,
  };
}


export const PHONE_DOMAINS: Readonly<Record<PhoneStream, string>> = { location: "location", motion: "motion", "apple-health": "health", "apple-photos": "photos" };
const INSTALL = "00000000-0000-4000-8000-0000000000a1";
const PROCESS = "00000000-0000-4000-8000-0000000000c1";
const JPEG = readFileSync(new URL("../packages/families/photos/test/golden/p1.jpg", import.meta.url));

export type PhoneContent = Partial<Record<PhoneStream, [number, number]>>;

export function phoneDelivery(life: Life, content: PhoneContent, seals: Record<string, number>, created_ms: number): Upload {
  const members: [string, Buffer][] = [];
  const files: Record<string, unknown> = {};
  const blobs: Buffer[] = [];
  const by: Record<string, number> = {};
  let first = Infinity, last = -Infinity;
  for (const name of PHONE_STREAMS) {
    const range = content[name];
    if (range === undefined) continue;
    const lines: string[] = [];
    for (let ordinal = range[0]; ordinal <= range[1]; ordinal++) {
      const at = life.streams[name].time(ordinal);
      first = Math.min(first, at);
      last = Math.max(last, at);
      const entry = phoneEntry(life, name, ordinal, blobs);
      lines.push(`${JSON.stringify(entry)}\n`);
    }
    const bytes = Buffer.from(lines.join(""));
    const file = `${PHONE_DOMAINS[name]}.jsonl`;
    members.push([file, bytes]);
    files[file] = { sha256: `sha256:${sha256(bytes)}`, bytes: bytes.length, observations: lines.length, first_sequence: range[0], last_sequence: range[1] };
    by[name] = lines.length;
  }
  for (const blob of blobs) {
    const name = `blobs/${sha256(blob)}`;
    members.push([name, blob]);
    files[name] = { sha256: `sha256:${sha256(blob)}`, bytes: blob.length, observations: 0 };
  }
  const created_at = new Date(created_ms).toISOString();
  const covered = last < first ? { start: created_at, end: created_at } : { start: new Date(first).toISOString(), end: new Date(last).toISOString() };
  const manifest: Record<string, unknown> = {
    schema_version: 3,
    device: { machine_model: "iPhoneSynthetic,1", marketing_name: "Synthetic iPhone", os_version: "SyntheticOS 1.0", install_id: INSTALL, enrolled_at: "2026-08-31T09:00:00Z" },
    app_version: "1.0.0-synthetic", created_at, time_range_covered: covered, files,
    custody: Object.fromEntries(Object.entries(seals).map(([source, seal]) => [source, { seal }])),
  };
  const id = `sha256:${sha256(Buffer.from(sorted(manifest)))}`;
  const bytes = zip([["manifest.json", Buffer.from(JSON.stringify({ ...manifest, bundle_id: id }))], ...members], { zip64: true });
  return { path: `/v1/bundles/${id}`, bytes, rows: Object.values(by).reduce((sum, n) => sum + n, 0), by };
}

function phoneEntry(life: Life, name: PhoneStream, ordinal: number, blobs: Buffer[]): object {
  const at = life.streams[name].time(ordinal);
  const iso = new Date(at).toISOString();
  const recorded = { schema_version: 1, domain: PHONE_DOMAINS[name], sequence: ordinal, observed_at: iso,
    captured: { wall_rfc3339: iso, wall_unix_seconds: at / 1000, elapsed_seconds: 1000.5 }, process_instance_id: PROCESS };
  switch (name) {
    case "location": {
      const drift = life.pick("location", ordinal, 1000) / 1_000_000;
      return { ...recorded, kind: "fix", payload: { latitude: 0.5 + drift, longitude: -0.25 - drift, altitude: 3.5, horizontal_accuracy: 12.25, vertical_accuracy: 4, speed: -1, course: -1, timestamp_unix_seconds: at / 1000 } };
    }
    case "motion":
      return { ...recorded, kind: "activity", payload: { start: iso, activity: ["walking", "stationary", "automotive"][life.pick("motion", ordinal, 3)], confidence: "high" } };
    case "apple-health": {
      const heart = ordinal % 2 === 0;
      const end = new Date(at + (heart ? 0 : 60_000)).toISOString();
      return {
        domain: "health", kind: "sample", sequence: ordinal, captured: { wall_rfc3339: iso },
        payload: {
          uuid: life.uuid("health", ordinal).toUpperCase(),
          sample_type: heart ? "HKQuantityTypeIdentifierHeartRate" : "HKQuantityTypeIdentifierStepCount",
          start_date_rfc3339: iso, start_date_unix_seconds: at / 1000, end_date_rfc3339: end, end_date_unix_seconds: Date.parse(end) / 1000,
          source_revision: { source_name: "Synthetic Health Source", bundle_identifier: "org.example.synthetic-health", version: "9.1", product_type: "SyntheticPhone9,9", operating_system_version: { major: 9, minor: 1, patch: 0 } },
          device: { name: "Synthetic Watch", manufacturer: "Synthetic Maker", model: "Watch", hardware_version: "SyntheticWatch1,1", software_version: "9.1", local_identifier: "synthetic-local-device" },
          metadata: { HKWasUserEntered: false },
          secure_archive_base64: "c3ludGhldGlj",
          quantity_description: heart ? `${60 + life.pick("heart", ordinal, 60)} count/min` : `${life.pick("steps", ordinal, 200)} count`,
        },
      };
    }
    case "apple-photos": {
      const original = photo(life, ordinal);
      blobs.push(original);
      return {
        domain: "photos", kind: "asset", sequence: ordinal, captured: { wall_rfc3339: iso },
        payload: {
          local_identifier: `${life.uuid("photo", ordinal).toUpperCase()}/L0/001`, modification_date: iso, creation_date: iso, media_type: "image", media_subtypes: 0,
          pixel_width: 640, pixel_height: 480, location: null, favorite: false, hidden: false,
          resources: [{ type: "photo", type_raw: 1, uti: "public.jpeg", original_filename: `IMG_${ordinal}.JPG`, blob: { hash: `sha256:${sha256(original)}`, bytes: original.length, type: "image/jpeg", role: "original" } }],
        },
      };
    }
  }
}

function photo(life: Life, ordinal: number): Buffer {
  const segment = (text: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt16BE(0xfffe, 0);
    head.writeUInt16BE(text.length + 2, 2);
    return Buffer.concat([head, text]);
  };
  const comments = [segment(Buffer.from(`synthetic photo ${life.seed}-${ordinal}`))];
  for (let left = life.size.photo_bytes - JPEG.length; left > 0; left -= 65_000) comments.push(segment(Buffer.alloc(Math.min(65_000, left), 0x20)));
  return Buffer.concat([JPEG.subarray(0, 2), ...comments, JPEG.subarray(2)]);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sorted(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sorted).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${sorted(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
