import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { Fixture } from "../../../test/drive.js";

export const WISPR_UNIT = "macbook-pro-0001";
export const WISPR_SOURCE = `wispr-flow:person-a@example.com:${WISPR_UNIT}`;
export const SNAPSHOT = { snapshot_taken_at: "2026-09-21T04:00:00.000Z", kind: "snapshot" };

const HISTORY = [
  "CREATE TABLE `History` (`transcriptEntityId` VARCHAR(36) NOT NULL UNIQUE PRIMARY KEY, `asrText` TEXT, `formattedText` TEXT, " +
    "`editedText` TEXT, `timestamp` DATETIME, `audio` BLOB, `screenshot` BLOB, `additionalContext` JSON, `status` VARCHAR(255), " +
    "`app` VARCHAR(255), `url` VARCHAR(255), `e2eLatency` FLOAT, `needsUploading` TINYINT(1) NOT NULL DEFAULT 0, `duration` FLOAT, " +
    "`numWords` INTEGER, `shareType` TEXT NOT NULL DEFAULT 'no', `textboxContents` TEXT, `appVersion` VARCHAR(255) NOT NULL DEFAULT '0.0.0', " +
    "`editedTextStatus` TEXT NOT NULL DEFAULT 'NOT_EXTRACTED', `editedTextAttempts` INTEGER NOT NULL DEFAULT 0, `toneMatchedText` TEXT, " +
    "`toneMatchPairs` JSONB, `feedback` TEXT, `language` TEXT, `isArchived` TINYINT(1) NOT NULL DEFAULT 0, `micDevice` TEXT, " +
    "`conversationId` VARCHAR(255), `builtInAudio` BLOB, `formattingDivergenceScore` FLOAT, `pastedText` TEXT, `defaultAsrText` TEXT, " +
    "`fallbackAsrText` TEXT, `defaultFormattedText` TEXT, `fallbackFormattedText` TEXT, `fallbackAsrDivergenceScore` FLOAT, " +
    "`fallbackFormattingDivergenceScore` FLOAT, `detectedLanguage` TEXT, `averageLogProb` FLOAT, `hasRevertedAI` TINYINT(1), `axText` TEXT, " +
    "`userEditMetaData` JSON, `axHTML` TEXT, `opusChunks` JSON, `usedFallbackAsr` TINYINT(1), `usedFallbackFormatting` TINYINT(1), " +
    "`desiredAsr` TEXT, `desiredFormatted` TEXT, `calledExternalAsr` TINYINT(1), `transcriptOrigin` TEXT, `platform` VARCHAR(255), " +
    "`transcriptCommand` TEXT, `personalizationStyleSettings` JSON, `clientNetworkLatency` FLOAT, `fallbackLevel` INTEGER, " +
    "`speechDuration` FLOAT, `timezoneOffsetMinutes` INTEGER, `numWordsCorrected` INTEGER, `numDictionaryReplacements` INTEGER, " +
    "`serverFinalizedText` TEXT, `contentObservationEndReason` VARCHAR(255) DEFAULT NULL, " +
    "`contentObservationEndLastKeystroke` VARCHAR(255) DEFAULT NULL, `editDistanceToDictated` FLOAT DEFAULT NULL, " +
    "`editedTextUnbounded` TEXT DEFAULT NULL)",
  "CREATE INDEX `idx_formattedText` ON `History` (`formattedText`)",
  "CREATE INDEX `idx_timestamp_archived` ON `History` (`timestamp`, `isArchived`)",
  "CREATE TABLE `Notes` (`id` VARCHAR(36) PRIMARY KEY, `title` TEXT, `content` TEXT)",
  "CREATE TABLE `Meetings` (`id` VARCHAR(36) PRIMARY KEY, `title` TEXT, `transcript` TEXT)",
];

export interface Dictation {
  id: string;
  asr: string | null;
  formatted: string | null;
  edited?: string | null;
  pasted?: string | null;
  timestamp: string | null;
  west?: number;
  status?: string;
  app?: string | null;
  url?: string | null;
  audio?: Buffer;
  screenshot?: Buffer;
  opus?: string;
  context?: string;
}

export function createFlowStore(path: string, dictations: Dictation[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    for (const statement of HISTORY) db.exec(statement);
    db.prepare("INSERT INTO Notes VALUES (?, ?, ?)").run("SYNTH-NOTE-0001", "Synthetic note", "a note no reader may take");
    db.prepare("INSERT INTO Meetings VALUES (?, ?, ?)").run("SYNTH-MEETING-0001", "Synthetic meeting", "a transcript no reader may take");
  } finally {
    db.close();
  }
  appendDictations(path, dictations);
}

export function appendDictations(path: string, dictations: Dictation[]): void {
  const db = new Database(path);
  try {
    const insert = db.prepare(
      "INSERT INTO History (transcriptEntityId, asrText, formattedText, editedText, pastedText, timestamp, timezoneOffsetMinutes, status, app, url, " +
        "audio, screenshot, opusChunks, additionalContext, appVersion, duration, numWords, platform) " +
        "VALUES (@id, @asr, @formatted, @edited, @pasted, @timestamp, @west, @status, @app, @url, @audio, @screenshot, @opus, @context, '1.3.0', 2.5, 4, 'desktop')",
    );
    for (const dictation of dictations) {
      insert.run({
        id: dictation.id, asr: dictation.asr, formatted: dictation.formatted, edited: dictation.edited ?? null, pasted: dictation.pasted ?? dictation.formatted,
        timestamp: dictation.timestamp, west: dictation.west ?? null, status: dictation.status ?? "formatted",
        app: dictation.app === undefined ? "com.example.editor" : dictation.app, url: dictation.url === undefined ? "https://example.com/page" : dictation.url,
        audio: dictation.audio ?? null, screenshot: dictation.screenshot ?? null, opus: dictation.opus ?? null,
        context: dictation.context ?? JSON.stringify({ ax_context: null, user_first_name: "Person", user_last_name: "A" }),
      });
    }
  } finally {
    db.close();
  }
}

export function cursor(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return Number((db.prepare("SELECT max(rowid) AS n FROM History").get() as { n: number }).n);
  } finally {
    db.close();
  }
}

export function seal(source: string, path: string, after?: number): void {
  const db = new Database(source, { readonly: true });
  db.prepare("VACUUM INTO ?").run(path);
  db.close();
  const copy = new Database(path);
  try {
    if (after !== undefined) copy.prepare("DELETE FROM History WHERE NOT (rowid > ?)").run(after);
    copy.exec("DELETE FROM Notes; DELETE FROM Meetings; VACUUM;");
  } finally {
    copy.close();
  }
}

export const T = "2026-09-20";
export const WAV = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVEsynthetic dictation audio")]);
export const SHOT = Buffer.from("synthetic png screenshot bytes");
export const OPUS = JSON.stringify({ packets: ["synthetic-packet-1", "synthetic-packet-2"], packet_duration: 20, audio_encoding: "opus", byte_encoding: "ascii85" });

export function hashOf(bytes: Buffer | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function baseDictations(): Dictation[] {
  return [
    {
      id: "00000000-0000-4000-8000-000000000001", asr: "um synthetic dictation one", formatted: "Synthetic dictation one.",
      timestamp: `${T} 08:00:00.250 +00:00`, west: -330, audio: WAV, opus: OPUS,
    },
    {
      id: "00000000-0000-4000-8000-000000000002", asr: "synthetic two", formatted: "Synthetic two.", edited: "Synthetic two, edited.",
      timestamp: `${T} 09:00:00.000 +00:00`, west: 420, screenshot: SHOT, app: "com.example.browser", url: "https://example.com/compose",
    },
    { id: "00000000-0000-4000-8000-000000000003", asr: null, formatted: null, timestamp: `${T} 10:00:00.500 +00:00`, status: "dismissed", app: null, url: null },
  ];
}

export const fixture: Fixture = (folder) => {
  createFlowStore(join(folder, "flow.sqlite"), baseDictations());
  return {
    source: WISPR_SOURCE, facts: { snapshot_taken_at: "2026-09-21T04:00:00.000Z", kind: "snapshot" }, files: { "flow.sqlite": "trust" },
    heads: [
      "dictation 00000000-0000-4000-8000-000000000001", "dictation 00000000-0000-4000-8000-000000000002",
      "dictation 00000000-0000-4000-8000-000000000003",
    ],
  };
};

export const fixtures: Readonly<Record<string, Fixture>> = {
  "wispr-flow-mac": fixture,
};
