import { describe, expect, it } from "vitest";
import type { Delivery, JsonObject } from "@lifestreamprotocol/core";
import { artifact, collect, deliver, openTestHome, type TestHome } from "../../test/drive.js";
import { fingerprint } from "../../shared/fingerprint.js";
import { aquaVoice, AUDIO_INDEX_FILE, DICTATION, HISTORY_FILE } from "./reader.js";
import { AQUA_ACCOUNT, AQUA_SOURCE, audioIndex, baseEntries, entry, historyFile, sha256, wav, type Entry } from "./test/fixture.js";

const AT = { snapshot_taken_at: "2026-09-20T08:15:00.000Z" };

function shipped(home: TestHome, entries: Entry[], facts: JsonObject = AT, users: Record<string, Entry[]> = {}, recordings = entries.map((e) => e.file)): Delivery {
  for (const file of recordings) home.blobs.put(wav(file));
  return deliver(home, AQUA_SOURCE, { [HISTORY_FILE]: historyFile({ [AQUA_ACCOUNT]: entries, ...users }), [AUDIO_INDEX_FILE]: audioIndex(recordings) }, facts);
}

describe("Aqua Voice: each of these is impossible", () => {
  it("a synthetic delivery lands different heads than expected, or a dictation loses a text form or its audio", async () => {
    const home = openTestHome();
    try {
      const other = { "100002": [{ ...baseEntries()[0]!, sessionId: 290000001, content: "Another account." }] };
      const delivery = shipped(home, baseEntries(), AT, other);
      const rows = await collect(aquaVoice.read(delivery, home.blobs));
      const landed = await home.land(aquaVoice, delivery, rows);
      expect(landed).toMatchObject({ new: 3, refused: 0, duplicated: 0 });
      const heads = home.heads(AQUA_SOURCE);
      expect(heads.map((head) => [head.kind, head.key, head.start_ms, head.time?.precision])).toEqual([
        [DICTATION, "190000001", Date.parse("2026-09-20T08:00:00.002Z"), "ms"],
        [DICTATION, "190000002", Date.parse("2026-09-20T08:05:00.500Z"), "ms"],
        [DICTATION, "190000003", Date.parse("2026-09-20T08:10:00.084Z"), "ms"],
      ]);
      const third = heads[2]!.content as { dictation: JsonObject; audio: JsonObject };
      expect(third.dictation).toEqual({
        kind: "transcription", source: "local", timestamp: "2026-09-20T08:10:00.084Z", content: "Synthetic third, written.",
        rawText: "synthetic third written", sessionId: 190000003, audioFilePath: `audio/AQ_${baseEntries()[0]!.file}.wav`, audioDurationSeconds: 4.2,
      });
      const recording = wav(baseEntries()[0]!.file);
      expect(third.audio).toEqual({ hash: `sha256:${sha256(recording)}`, bytes: recording.length });
      expect(rows[0]!.blobs).toEqual([`sha256:${sha256(recording)}`]);
      expect(home.blobs.has(rows[0]!.blobs![0]!)).toBe(true);
      expect((heads[0]!.content as { dictation: JsonObject }).dictation.rawText).toBeNull();
      expect(rows.every((row) => row.device === "macbook-pro-0001" && row.locator!.startsWith(`history.json historyByUserId.${AQUA_ACCOUNT}[`))).toBe(true);
      artifact(home.dir, "heads.json", { landed, heads });
    } finally {
      home.close();
    }
  });

  it("the same file again writes something new", async () => {
    const home = openTestHome();
    try {
      await home.land(aquaVoice, shipped(home, baseEntries()));
      const again = await home.land(aquaVoice, shipped(home, baseEntries(), { snapshot_taken_at: "2026-09-20T08:20:00.000Z" }));
      expect(again).toMatchObject({ new: 0, changed: 0, restated: 3, gone: 0 });
    } finally {
      home.close();
    }
  });

  it("a dictation that falls off Aqua's list lands a gone, or a changed one keeps its old head", async () => {
    const home = openTestHome();
    try {
      await home.land(aquaVoice, shipped(home, baseEntries()));
      const [third, second] = baseEntries();
      const fourth: Entry = { sessionId: 190000004, timestamp: "2026-09-20T08:20:00.000Z", content: "Synthetic fourth.", rawText: "synthetic fourth", file: Date.parse("2026-09-20T08:19:59.999Z"), seconds: 2 };
      const later = shipped(home, [fourth, third!, { ...second!, content: "Synthetic second, corrected." }], { snapshot_taken_at: "2026-09-20T08:25:00.000Z" });
      const landed = await home.land(aquaVoice, later);
      expect(landed).toMatchObject({ new: 1, changed: 1, restated: 1, gone: 0 });
      expect(landed.changedPaths).toEqual({ "dictation.content": 1 });
      const heads = home.heads(AQUA_SOURCE);
      expect(heads.filter((head) => head.gone)).toEqual([]);
      expect(heads.map((head) => head.key)).toEqual(["190000001", "190000002", "190000003", "190000004"]);
      artifact(home.dir, "heads.json", { landed, heads });
    } finally {
      home.close();
    }
  });

  it("a malformed file is read, or its refusal does not name it", async () => {
    const home = openTestHome();
    try {
      const file = (bytes: Buffer) => deliver(home, AQUA_SOURCE, { [HISTORY_FILE]: bytes }, AT);
      const refused = async (bytes: Buffer, why: RegExp) =>
        expect(await collect(aquaVoice.read(file(bytes), home.blobs))).toEqual([expect.objectContaining({ kind: "file", key: HISTORY_FILE, refused: expect.stringMatching(why) })]);
      await refused(Buffer.from("{\"version\":1,"), /history\.json/u);
      await refused(Buffer.from(JSON.stringify({ version: 2, historyByUserId: {} })), /must state version 1/u);
      await refused(Buffer.from(JSON.stringify({ version: 1, historyByUserId: { [AQUA_ACCOUNT]: {} } })), /must be a list/u);
      await expect(collect(aquaVoice.read(deliver(home, AQUA_SOURCE, { "settings.json": Buffer.from("{}") }, AT), home.blobs))).rejects.toThrow(/carries no history\.json/u);
    } finally {
      home.close();
    }
  });

  it("a malformed dictation costs the dictations beside it, or its refusal does not name it", async () => {
    const home = openTestHome();
    try {
      const [third, second] = baseEntries();
      const history = Buffer.from(JSON.stringify({ version: 1, historyByUserId: { [AQUA_ACCOUNT]: [entry(third!), 7, entry(second!)] } }));
      for (const recording of [third!.file, second!.file]) home.blobs.put(wav(recording));
      const delivery = deliver(home, AQUA_SOURCE, { [HISTORY_FILE]: history, [AUDIO_INDEX_FILE]: audioIndex([third!.file, second!.file]) }, AT);
      const landed = await home.land(aquaVoice, delivery);
      expect(landed).toMatchObject({ new: 2, refused: 1 });
      expect(landed.refusals).toEqual([{ kind: "file", key: `${HISTORY_FILE} historyByUserId.${AQUA_ACCOUNT}[1]`, violations: [expect.stringMatching(/is not an object/u)] }]);
      expect(home.heads(AQUA_SOURCE).map((head) => head.key)).toEqual(["190000002", "190000003"]);
      artifact(home.dir, "malformed-dictation.json", { landed, heads: home.heads(AQUA_SOURCE) });
    } finally {
      home.close();
    }
  });

  it("a dictation with no session id is refused, or its key depends on when it was seen", async () => {
    const home = openTestHome();
    try {
      const [third, second, first] = baseEntries();
      const entries = [{ ...third!, sessionId: null }, second!, first!];
      const rows = await collect(aquaVoice.read(shipped(home, entries), home.blobs));
      const key = fingerprint({ timestamp: third!.timestamp, audioFilePath: `audio/AQ_${third!.file}.wav` });
      expect(rows[0]!.key).toBe(key);
      const landed = await home.land(aquaVoice, shipped(home, entries), rows);
      expect(landed).toMatchObject({ new: 3, refused: 0 });
      const again = await home.land(aquaVoice, shipped(home, entries, { snapshot_taken_at: "2026-09-21T08:00:00.000Z" }));
      expect(again).toMatchObject({ new: 0, restated: 3 });
      expect(home.heads(AQUA_SOURCE).map((head) => head.key)).toContain(key);
      const bare = await collect(aquaVoice.read(deliver(home, AQUA_SOURCE, {
        [HISTORY_FILE]: Buffer.from(JSON.stringify({ version: 1, historyByUserId: { [AQUA_ACCOUNT]: [{ timestamp: third!.timestamp, sessionId: null, audioFilePath: null }] } })),
      }, AT), home.blobs));
      expect(bare[0]!.key).toBe(fingerprint({ timestamp: third!.timestamp }));
    } finally {
      home.close();
    }
  });

  it("a recording the Mac could not read stops its dictation, or a file without this account's history lands a gone", async () => {
    const home = openTestHome();
    try {
      const entries = baseEntries();
      const landed = await home.land(aquaVoice, shipped(home, entries, AT, {}, [entries[0]!.file]));
      expect(landed).toMatchObject({ new: 3, refused: 0 });
      const heads = home.heads(AQUA_SOURCE);
      expect(heads.map((head) => (head.content as { audio: JsonObject | null }).audio === null)).toEqual([true, true, false]);
      const away = deliver(home, AQUA_SOURCE, { [HISTORY_FILE]: historyFile({ "100002": entries }) }, { snapshot_taken_at: "2026-09-21T08:00:00.000Z" });
      expect(await home.land(aquaVoice, away)).toMatchObject({ new: 0, gone: 0, restated: 0 });
      expect(home.heads(AQUA_SOURCE).filter((head) => head.gone)).toEqual([]);
    } finally {
      home.close();
    }
  });
});
