import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { Fixture } from "../../../test/drive.js";

export const NOTES_UNIT = "macbook-pro-0001";
export const NOTES_SOURCE = `apple-notes:person-a@example.com:${NOTES_UNIT}`;
export const ACCOUNT = "SYNTH-ACCOUNT-0001";
export const T0 = 811_584_000;
export const ENT = { cloudState: 2, attachment: 5, media: 11, note: 12, account: 14, folder: 15, noteData: 19 } as const;
export const FOLDERS = { recentlyDeleted: 1, notes: 3, workouts: 5 } as const;
export const ACCOUNT_PK = 2;

const SCHEMA = [
  "CREATE TABLE ZICCLOUDSYNCINGOBJECT ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, " +
    "ZISPINNED INTEGER, ZISPASSWORDPROTECTED INTEGER, ZMARKEDFORDELETION INTEGER, ZHASCHECKLIST INTEGER, " +
    "ZHASCHECKLISTINPROGRESS INTEGER, ZHASEMPHASIS INTEGER, ZHASSYSTEMTEXTATTACHMENTS INTEGER, ZPAPERSTYLETYPE INTEGER, " +
    "ZISSYSTEMPAPER INTEGER, ZCRYPTOITERATIONCOUNT INTEGER, ZFOLDER INTEGER, ZPARENT INTEGER, ZFOLDERTYPE INTEGER, " +
    "ZNOTE INTEGER, ZMEDIA INTEGER, ZACCOUNT6 INTEGER, ZFILESIZE INTEGER, " +
    "ZCREATIONDATE3 TIMESTAMP, ZMODIFICATIONDATE1 TIMESTAMP, ZCREATIONDATE TIMESTAMP, ZMODIFICATIONDATE TIMESTAMP, " +
    "ZLASTVIEWEDMODIFICATIONDATE TIMESTAMP, " +
    "ZIDENTIFIER VARCHAR, ZTITLE1 VARCHAR, ZSNIPPET VARCHAR, ZPASSWORDHINT VARCHAR, ZTITLE2 VARCHAR, " +
    "ZTYPEUTI VARCHAR, ZTITLE VARCHAR, ZURLSTRING VARCHAR, ZFILENAME VARCHAR, ZGENERATION1 VARCHAR, ZNAME VARCHAR, " +
    "ZCRYPTOSALT BLOB, ZCRYPTOWRAPPEDKEY BLOB, ZCRYPTOINITIALIZATIONVECTOR BLOB, ZCRYPTOTAG BLOB, ZSERVERRECORDDATA BLOB )",
  "CREATE TABLE ZICNOTEDATA ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZNOTE INTEGER, " +
    "ZCRYPTOINITIALIZATIONVECTOR BLOB, ZCRYPTOTAG BLOB, ZDATA BLOB )",
  "CREATE TABLE ATRANSACTION ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZAUTHORTS INTEGER, " +
    "ZBUNDLEIDTS INTEGER, ZCONTEXTNAMETS INTEGER, ZPROCESSIDTS INTEGER, ZTIMESTAMP FLOAT, ZAUTHOR VARCHAR, " +
    "ZBUNDLEID VARCHAR, ZCONTEXTNAME VARCHAR, ZPROCESSID VARCHAR, ZQUERYGEN BLOB )",
  "CREATE TABLE ACHANGE ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCHANGETYPE INTEGER, " +
    "ZENTITY INTEGER, ZENTITYPK INTEGER, ZTRANSACTIONID INTEGER, ZCOLUMNS BLOB )",
  "CREATE TABLE ZICCLOUDSTATE ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZSTATE INTEGER )",
  "CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER)",
  "CREATE INDEX ZICCLOUDSYNCINGOBJECT_ZNOTE_INDEX ON ZICCLOUDSYNCINGOBJECT (ZNOTE)",
  "CREATE INDEX ZICCLOUDSYNCINGOBJECT_ZFOLDER_INDEX ON ZICCLOUDSYNCINGOBJECT (ZFOLDER)",
  "CREATE INDEX ZICNOTEDATA_ZNOTE_INDEX ON ZICNOTEDATA (ZNOTE)",
];

export interface Attachment {
  pk: number;
  identifier: string;
  uti: string;
  media?: { pk: number; identifier: string; filename: string | null; generation: string | null };
  title?: string | null;
}

export interface Note {
  pk: number;
  identifier: string;
  title: string | null;
  snippet?: string | null;
  created: number | null;
  modified: number | null;
  folder?: number | null;
  pinned?: 0 | 1;
  deleted?: 0 | 1;
  locked?: boolean;
  body?: Buffer;
  attachments?: Attachment[];
}

export function createNoteStore(path: string, notes: Note[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    for (const statement of SCHEMA) db.exec(statement);
    db.exec(
      "INSERT INTO Z_PRIMARYKEY VALUES (2, 'ICCloudState', 0, 1), (5, 'ICAttachment', 3, 0), (11, 'ICMedia', 3, 0), " +
        "(12, 'ICNote', 3, 0), (14, 'ICAccount', 13, 1), (15, 'ICFolder', 13, 3), (19, 'ICNoteData', 0, 0)",
    );
    db.exec("INSERT INTO ZICCLOUDSTATE VALUES (1, 2, 1, 0)");
    db.prepare("INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, Z_OPT, ZIDENTIFIER, ZNAME) VALUES (?, ?, 1, ?, 'iCloud')").run(ACCOUNT_PK, ENT.account, ACCOUNT);
    const folder = db.prepare("INSERT INTO ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, Z_OPT, ZIDENTIFIER, ZTITLE2, ZFOLDERTYPE, ZPARENT) VALUES (?, ?, 1, ?, ?, ?, ?)");
    folder.run(FOLDERS.recentlyDeleted, ENT.folder, "SYNTH-FOLDER-TRASH", "Recently Deleted", 1, null);
    folder.run(FOLDERS.notes, ENT.folder, "SYNTH-FOLDER-NOTES", "Notes", 0, null);
    folder.run(FOLDERS.workouts, ENT.folder, "SYNTH-FOLDER-WORKOUTS", "Workouts", 0, FOLDERS.notes);
  } finally {
    db.close();
  }
  appendNotes(path, notes);
}

export function appendNotes(path: string, notes: Note[]): void {
  const db = new Database(path);
  try {
    const transaction = newTransaction(db);
    const change = db.prepare("INSERT INTO ACHANGE (Z_ENT, Z_OPT, ZCHANGETYPE, ZENTITY, ZENTITYPK, ZTRANSACTIONID) VALUES (16001, 1, ?, ?, ?, ?)");
    for (const note of notes) {
      insert(db, "ZICCLOUDSYNCINGOBJECT", {
        Z_PK: note.pk, Z_ENT: ENT.note, Z_OPT: 1,
        ZISPINNED: note.pinned ?? 0, ZISPASSWORDPROTECTED: note.locked === true ? 1 : 0, ZMARKEDFORDELETION: note.deleted ?? 0,
        ZHASCHECKLIST: 0, ZHASCHECKLISTINPROGRESS: 0, ZHASEMPHASIS: 0, ZHASSYSTEMTEXTATTACHMENTS: 0,
        ZPAPERSTYLETYPE: 0, ZISSYSTEMPAPER: 0, ZCRYPTOITERATIONCOUNT: note.locked === true ? 20000 : 0,
        ZFOLDER: note.folder === undefined ? FOLDERS.notes : note.folder,
        ZCREATIONDATE3: note.created, ZMODIFICATIONDATE1: note.modified, ZLASTVIEWEDMODIFICATIONDATE: note.modified,
        ZIDENTIFIER: note.identifier, ZTITLE1: note.title, ZSNIPPET: note.snippet ?? null, ZPASSWORDHINT: note.locked === true ? "the usual" : null,
        ZCRYPTOSALT: note.locked === true ? Buffer.from("synthetic-salt") : null,
        ZCRYPTOWRAPPEDKEY: note.locked === true ? Buffer.from("synthetic-wrapped-key") : null,
        ZCRYPTOINITIALIZATIONVECTOR: null, ZCRYPTOTAG: null, ZSERVERRECORDDATA: Buffer.from(`server-record-${note.pk}`),
      });
      change.run(0, ENT.note, note.pk, transaction);
      if (note.body !== undefined) {
        db.prepare("INSERT INTO ZICNOTEDATA (Z_ENT, Z_OPT, ZNOTE, ZCRYPTOINITIALIZATIONVECTOR, ZCRYPTOTAG, ZDATA) VALUES (?, 1, ?, ?, ?, ?)").run(
          ENT.noteData, note.pk, note.locked === true ? Buffer.from("synthetic-iv") : null, note.locked === true ? Buffer.from("synthetic-tag") : null, note.body,
        );
      }
      for (const attachment of note.attachments ?? []) {
        if (attachment.media !== undefined) {
          insert(db, "ZICCLOUDSYNCINGOBJECT", {
            Z_PK: attachment.media.pk, Z_ENT: ENT.media, Z_OPT: 1, ZIDENTIFIER: attachment.media.identifier,
            ZFILENAME: attachment.media.filename, ZGENERATION1: attachment.media.generation, ZACCOUNT6: ACCOUNT_PK, ZNOTE: null,
          });
          change.run(0, ENT.media, attachment.media.pk, transaction);
        }
        insert(db, "ZICCLOUDSYNCINGOBJECT", {
          Z_PK: attachment.pk, Z_ENT: ENT.attachment, Z_OPT: 1, ZIDENTIFIER: attachment.identifier, ZTYPEUTI: attachment.uti,
          ZTITLE: attachment.title ?? null, ZURLSTRING: null, ZCREATIONDATE: note.created, ZMODIFICATIONDATE: note.modified,
          ZFILESIZE: 0, ZMARKEDFORDELETION: 0, ZNOTE: note.pk, ZMEDIA: attachment.media === undefined ? null : attachment.media.pk,
        });
        change.run(0, ENT.attachment, attachment.pk, transaction);
      }
    }
  } finally {
    db.close();
  }
}

export function editNote(path: string, pk: number, sql: string, ...values: unknown[]): void {
  const db = new Database(path);
  try {
    db.prepare(sql).run(...values);
    const transaction = newTransaction(db);
    db.prepare("INSERT INTO ACHANGE (Z_ENT, Z_OPT, ZCHANGETYPE, ZENTITY, ZENTITYPK, ZTRANSACTIONID) VALUES (16001, 1, 1, ?, ?, ?)").run(ENT.note, pk, transaction);
  } finally {
    db.close();
  }
}

export function purgeNote(path: string, pk: number): void {
  const db = new Database(path);
  try {
    db.prepare("DELETE FROM ZICNOTEDATA WHERE ZNOTE = ?").run(pk);
    db.prepare("DELETE FROM ZICCLOUDSYNCINGOBJECT WHERE Z_PK = ?").run(pk);
    const transaction = newTransaction(db);
    db.prepare("INSERT INTO ACHANGE (Z_ENT, Z_OPT, ZCHANGETYPE, ZENTITY, ZENTITYPK, ZTRANSACTIONID) VALUES (16001, 1, 2, ?, ?, ?)").run(ENT.note, pk, transaction);
  } finally {
    db.close();
  }
}

export function cursor(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return Number((db.prepare("SELECT max(Z_PK) AS n FROM ATRANSACTION").get() as { n: number }).n);
  } finally {
    db.close();
  }
}

export function sealDelta(source: string, path: string, after: number): void {
  const db = new Database(source, { readonly: true });
  db.prepare("VACUUM INTO ?").run(path);
  db.close();
  const delta = new Database(path);
  delta.exec(`
    DELETE FROM ATRANSACTION WHERE NOT (Z_PK > ${after});
    DELETE FROM ACHANGE WHERE NOT EXISTS (SELECT 1 FROM ATRANSACTION AS kept WHERE kept.Z_PK = ACHANGE.ZTRANSACTIONID);
    DELETE FROM ZICCLOUDSYNCINGOBJECT WHERE NOT (Z_ENT IS NOT (SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'ICNote')
      OR EXISTS (SELECT 1 FROM ACHANGE AS kept WHERE kept.ZENTITY = ZICCLOUDSYNCINGOBJECT.Z_ENT AND kept.ZENTITYPK = ZICCLOUDSYNCINGOBJECT.Z_PK));
    DELETE FROM ZICNOTEDATA WHERE NOT EXISTS (SELECT 1 FROM ZICCLOUDSYNCINGOBJECT AS kept WHERE kept.Z_PK = ZICNOTEDATA.ZNOTE);
    VACUUM;
  `);
  delta.close();
}

export function mediaIndex(entries: Record<string, Buffer>): Buffer {
  const index: Record<string, { sha256: string; bytes: number }> = {};
  for (const [locator, bytes] of Object.entries(entries)) index[locator] = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  return Buffer.from(JSON.stringify({ format: "org.lifestreamprotocol.blob-index/1", entries: index }));
}

export function locator(media: { identifier: string; generation: string; filename: string }): string {
  return `Accounts/${ACCOUNT}/Media/${media.identifier}/${media.generation}/${media.filename}`;
}

export function body(text: string): Buffer {
  return Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.from(text)]);
}

export const PASTED = { identifier: "SYNTH-MEDIA-0001", filename: "Pasted Graphic.png", generation: "1_SYNTH-GENERATION-0001" };
export const PASTED_BYTES = Buffer.from("synthetic png bytes");

export function baseNotes(): Note[] {
  return [
    {
      pk: 100, identifier: "SYNTH-NOTE-0001", title: "Synthetic exercise", snippet: "1.1kg * 15 reps",
      created: T0 + 0.25, modified: T0 + 600.5, folder: FOLDERS.workouts, body: body("Synthetic exercise\n1.1kg * 15 reps"),
      attachments: [
        { pk: 200, identifier: "SYNTH-ATTACHMENT-0001", uti: "public.png", media: { pk: 300, ...PASTED } },
        { pk: 201, identifier: "SYNTH-ATTACHMENT-0002", uti: "com.apple.drawing.2" },
        { pk: 202, identifier: "SYNTH-ATTACHMENT-0003", uti: "public.jpeg", media: { pk: 301, identifier: "SYNTH-MEDIA-0002", filename: "Not Downloaded.jpeg", generation: "1_SYNTH-GENERATION-0002" } },
      ],
    },
    { pk: 101, identifier: "SYNTH-NOTE-0002", title: "List", snippet: "fake item", created: T0 + 3600, modified: T0 + 3600, pinned: 1, body: body("List\nfake item") },
    {
      pk: 102, identifier: "SYNTH-NOTE-0003", title: "Old draft", snippet: null, created: T0 - 86400, modified: T0 - 3600,
      folder: FOLDERS.recentlyDeleted, deleted: 1, body: body("Old draft"),
    },
    { pk: 103, identifier: "SYNTH-NOTE-0004", title: null, created: T0 + 7200, modified: null, locked: true, folder: null, body: body("ciphertext") },
  ];
}

function newTransaction(db: Database.Database): number {
  const next = Number((db.prepare("SELECT coalesce(max(Z_PK), 0) + 1 AS n FROM ATRANSACTION").get() as { n: number }).n);
  db.prepare("INSERT INTO ATRANSACTION (Z_PK, Z_ENT, Z_OPT, ZTIMESTAMP, ZAUTHOR, ZBUNDLEID) VALUES (?, 16002, 1, ?, 'synthetic', 'com.example.Notes')").run(next, T0 + next);
  return next;
}

function insert(db: Database.Database, table: string, columns: Record<string, unknown>): void {
  const names = Object.keys(columns);
  db.prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...names.map((name) => columns[name]));
}

export const fixture: Fixture = (folder) => {
  createNoteStore(join(folder, "notes.sqlite"), baseNotes());
  writeFileSync(join(folder, "media.json"), mediaIndex({ [locator(PASTED)]: PASTED_BYTES }));
  return {
    source: NOTES_SOURCE, facts: { snapshot_taken_at: "2026-09-21T00:00:00.000Z" }, files: { "notes.sqlite": "trust", "media.json": "trust" },
    heads: [
      "note SYNTH-NOTE-0001", "note SYNTH-NOTE-0002", "note SYNTH-NOTE-0003", "note SYNTH-NOTE-0004",
    ],
  };
};

export const fixtures: Readonly<Record<string, Fixture>> = {
  "notes-mac": fixture,
};
