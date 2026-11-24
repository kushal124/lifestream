import { artifact, collect, CONNECT_ROOT, deliver, openTestHome, parityOf, readGolden, temp, writeZip } from "../../test/drive.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONSUMED, instant, type JsonObject } from "@lifestreamprotocol/core";
import { describe, expect, it } from "vitest";
import { basicInstant } from "../../shared/lanes.js";
import { gcalApi, gcalExport } from "./reader.js";
import { ACCOUNT, API_SOURCE, apiPull, EXPORT_FACTS, EXPORT_FILES, EXPORT_SOURCE, PRIMARY_PAGE_2, primaryIcs } from "./test/fixtures.js";

const TEST = join(CONNECT_ROOT, "calendar", "google", "test");
const exportFiles = (): Record<string, Buffer> => Object.fromEntries(Object.entries(EXPORT_FILES).map(([name, make]) => [name, make()]));

function onePage(items: JsonObject[]): Record<string, Buffer> {
  const page = Buffer.from(JSON.stringify({ items, nextSyncToken: "s" }));
  const manifest = Buffer.from(JSON.stringify({
    format: "org.lifestreamprotocol.google-calendar-api-pull/0.1", complete: true, account: ACCOUNT, fetched_at: "2026-09-07T04:00:00.000Z",
    pages: [{ file: "p.json", sha256: createHash("sha256").update(page).digest("hex"), bytes: page.length }],
  }));
  return { "pull.json": manifest, "p.json": page };
}

function stamped(created: string, index: number): JsonObject {
  return {
    kind: "calendar#event", id: `stamp${index}`, status: "confirmed", iCalUID: `stamp${index}@google.com`, created, updated: created,
    start: { dateTime: "2026-09-09T15:00:00Z" }, end: { dateTime: "2026-09-09T15:45:00Z" },
  };
}

const recordTimeSpelling = (text: string): string => basicInstant(Math.floor(instant(text, "rfc3339").start_ms / 1000) * 1000);

function inRangeStamps(count: number): string[] {
  let seed = 7;
  const next = (below: number): number => {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
    return seed % below;
  };
  const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
  return Array.from({ length: count }, () => {
    const year = 1001 + next(8998);
    const month = 1 + next(12);
    const day = 1 + next(month === 2 ? 28 : 30);
    const fraction = ["", ".0", ".5", ".250", ".999", ".000000", ".123456789"][next(7)]!;
    const zone = ["Z", "z", "+00:00", "+05:30", "-08:00", "+14:00", "-12:00", "+23:59", "-23:59", "+05:45"][next(10)]!;
    return `${pad(year, 4)}-${pad(month)}-${pad(day)}${next(2) === 0 ? "T" : "t"}${pad(next(24))}:${pad(next(60))}:${pad(next(60))}${fraction}${zone}`;
  });
}

describe("calendar connectors: each of these is impossible", () => {
  it("a synthetic delivery lands different heads than expected", async () => {
    const home = openTestHome();
    const pull = apiPull();
    const api = await home.land(gcalApi, deliver(home, API_SOURCE, pull.files, pull.facts));
    const exported = await home.land(gcalExport, deliver(home, EXPORT_SOURCE, exportFiles(), EXPORT_FACTS));
    expect(api).toMatchObject({ new: 7, gone: 1, refused: 0, duplicated: 0 });
    expect(exported).toMatchObject({ new: 8, refused: 0, duplicated: 0 });
    const apiHeads = home.heads(API_SOURCE);
    expect(apiHeads.filter((head) => head.gone).map((head) => head.key)).toEqual(["evt0010@google.com"]);
    expect(home.heads(EXPORT_SOURCE).map((head) => head.key)).toEqual([
      "bday0001@google.com",
      "bday0001@google.com:20260920",
      "evt0001@google.com",
      "evt0002@google.com",
      "ny0001@google.com",
      "ny0002@google.com",
      "series01@google.com",
      "series01@google.com:20260914T033000Z",
    ]);
    artifact(home.dir, "heads.json", { api, exported, heads: { api: apiHeads, export: home.heads(EXPORT_SOURCE) } });
  });

  it("a Takeout .ics with no final line break is refused, or one with a final break or bare LF breaks lands other events", async () => {
    const home = openTestHome();
    const zip = join(temp(), "takeout-20261028T000000Z-001.zip");
    writeZip(zip, Object.entries(exportFiles()).map(([name, bytes]) => ({ name: `Takeout/Calendar/${name}`, bytes })));
    const takeout = deliver(home, EXPORT_SOURCE, { "takeout-20261028T000000Z-001.zip": readFileSync(zip) }, { ...EXPORT_FACTS, import: { kind: "google-takeout", id: "20261028T000000Z" } });
    const read = await collect(gcalExport.read(takeout, home.blobs));
    const events = read.filter((row) => row.kind === "event");
    expect([events.length, read.filter((row) => row.refused !== undefined), read.filter((row) => row.kind === CONSUMED).map((row) => row.key)]).toEqual([8, [], ["takeout-20261028T000000Z-001.zip"]]);
    expect(await home.land(gcalExport, takeout)).toMatchObject({ new: 8, refused: 0 });
    const google = parityOf(events);
    const shapes: Record<string, unknown> = {};
    for (const [shape, eol, final] of [["CRLF, final", "\r\n", "\r\n"], ["LF", "\n", ""], ["LF, final", "\n", "\n"]] as const) {
      const files = Object.fromEntries(Object.entries(exportFiles()).map(([name, bytes]) => [name, Buffer.from(`${bytes.toString("utf8").replaceAll("\r\n", eol)}${final}`)]));
      const rows = await collect(gcalExport.read(deliver(home, EXPORT_SOURCE, files, EXPORT_FACTS), home.blobs));
      const ours = parityOf(rows);
      expect(ours.map(({ kind, key, time, content }) => ({ kind, key, time, content: (content as { content: string }).content.replaceAll(eol, "\r\n") })), shape)
        .toEqual(google.map(({ kind, key, time, content }) => ({ kind, key, time, content: (content as { content: string }).content })));
      expect(ours.every((row) => (row.content as { content: string }).content.endsWith(`END:VEVENT${eol}`)), shape).toBe(true);
      const shapeHome = openTestHome();
      shapes[shape] = await shapeHome.land(gcalExport, deliver(shapeHome, EXPORT_SOURCE, files, EXPORT_FACTS));
      expect(shapes[shape], shape).toMatchObject({ new: 8, refused: 0 });
    }
    const cutHome = openTestHome();
    const cut = primaryIcs().subarray(0, primaryIcs().length - 3);
    const refused = await cutHome.land(gcalExport, deliver(cutHome, EXPORT_SOURCE, { [`${ACCOUNT}.ics`]: cut }, EXPORT_FACTS));
    expect([refused.new, refused.refusals]).toEqual([0, [{ kind: "file", key: `${ACCOUNT}.ics`, violations: [expect.stringContaining("closes no open component")] }]]);
    expect(cutHome.heads(EXPORT_SOURCE)).toEqual([]);
    artifact(home.dir, "line-breaks.json", { takeout: read, shapes, cut: refused });
  });

  it("the parity golden differs", async () => {
    const home = openTestHome();
    const pull = apiPull();
    const apiRows = await collect(gcalApi.read(deliver(home, API_SOURCE, pull.files, pull.facts), home.blobs));
    const exportRows = await collect(gcalExport.read(deliver(home, EXPORT_SOURCE, exportFiles(), EXPORT_FACTS), home.blobs));
    const ours = {
      api: parityOf(apiRows.filter((row) => row.gone !== true)),
      export: parityOf(exportRows),
    };
    const golden = {
      api: parityOf(readGolden(join(TEST, "golden-api.json"))),
      export: parityOf(readGolden(join(TEST, "golden-export.json"))),
    };
    artifact(home.dir, "parity.json", { golden, ours });
    expect(ours).toEqual(golden);
    const trip = exportRows.find((row) => row.key === "evt0002@google.com")!;
    expect(trip.time).toEqual({ start_ms: Date.UTC(2026, 8, 10), end_ms: Date.UTC(2026, 8, 13), precision: "day" });
    expect(apiRows.find((row) => row.key === "evt0002@google.com")!.time).toEqual(trip.time);
  });

  it("a smaller snapshot lands a gone", async () => {
    const home = openTestHome();
    await home.land(gcalExport, deliver(home, EXPORT_SOURCE, exportFiles(), EXPORT_FACTS));
    const smaller = { [`${ACCOUNT}.ics`]: EXPORT_FILES[`${ACCOUNT}.ics`]() };
    const later = await home.land(gcalExport, deliver(home, EXPORT_SOURCE, smaller, { exported_at: "2026-09-20T00:00:00Z" }));
    expect(later).toMatchObject({ gone: 0, restated: 6 });
    expect(home.heads(EXPORT_SOURCE).filter((head) => head.gone)).toEqual([]);
    artifact(home.dir, "heads.json", { later, heads: home.heads(EXPORT_SOURCE) });
  });

  it("a duplicated key in one delivery goes unreported", async () => {
    const home = openTestHome();
    const files = exportFiles();
    const dir = home.dir;
    writeZip(join(dir, "export.zip"), Object.entries(files).map(([name, bytes]) => ({ name: `Takeout/Calendar/${name}`, bytes })));
    const zipOnly = await home.land(gcalExport, deliver(home, EXPORT_SOURCE, { "export.zip": readFileSync(join(dir, "export.zip")) }, EXPORT_FACTS));
    expect(zipOnly).toMatchObject({ new: 8, duplicated: 0 });
    const twice = { ...files, "copy.ics": files[`${ACCOUNT}.ics`]! };
    const landed = await home.land(gcalExport, deliver(home, EXPORT_SOURCE, twice, { exported_at: "2026-09-21T00:00:00Z" }));
    expect(landed.duplicated).toBe(6);
    artifact(home.dir, "landed.json", { zipOnly, landed });
  });

  it("an export's calendar naming another account is read, or refuses the calendars beside it, or an API line with parameters refuses the pull", async () => {
    const home = openTestHome();
    const other = await home.land(gcalExport, deliver(home, "google-calendar:person-b@example.com:export", exportFiles(), EXPORT_FACTS));
    expect([other.new, other.refusals.map((refusal) => [refusal.kind, refusal.key])]).toEqual([0, [["file", `Birthdays_${ACCOUNT}.ics`], ["file", `${ACCOUNT}.ics`]]]);
    const mixed = await home.land(gcalExport, deliver(home, EXPORT_SOURCE, { ...exportFiles(), "person-b@example.com.ics": primaryIcs() }, EXPORT_FACTS));
    expect(mixed).toMatchObject({ new: 8, refused: 1 });
    expect(mixed.refusals).toEqual([{ kind: "file", key: "person-b@example.com.ics", violations: [expect.stringContaining("names account \"person-b@example.com\", not the source's")] }]);
    const pull = apiPull();
    await expect(collect(gcalApi.read(deliver(home, "google-calendar:person-b@example.com:cloud", pull.files, pull.facts), home.blobs))).rejects.toThrow(/not the source's/u);
    const zoned = { ...PRIMARY_PAGE_2[0]!, recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE;TZID=Asia/Kolkata:20260921T090000"] };
    const rows = await collect(gcalApi.read(deliver(home, API_SOURCE, onePage([zoned]), { fetched_at: "2026-09-07T04:00:00.000Z" }), home.blobs));
    expect((rows[0]!.content as { content: string }).content).toContain("EXDATE;TZID=Asia/Kolkata:20260921T090000\r\n");
    artifact(home.dir, "rows.json", rows);
  });

  it("an export event before the zone's transitions, in a gap, with no DTEND or with a line that is no property refuses the events beside it; a .zip that is no zip lands silently", async () => {
    const home = openTestHome();
    const event = (uid: string, ...times: string[]) => ["BEGIN:VEVENT", ...times, "DTSTAMP:20260907T040000Z", `UID:${uid}`, "SUMMARY:Synthetic", "END:VEVENT"];
    const extra = [
      ...event("old0001@google.com", "DTSTART;TZID=America/New_York:20050715T090000", "DTEND;TZID=America/New_York:20050715T100000"),
      ...event("gap0001@google.com", "DTSTART;TZID=America/New_York:20260308T023000", "DTEND;TZID=America/New_York:20260308T040000"),
      ...event("open0001@google.com", "DTSTART:20260920T100000Z"),
      ...event("colon0001@google.com", "DTSTART:20260920T100000Z", "DTEND:20260920T110000Z", "A LINE WITH NO COLON"),
    ].map((line) => `${line}\r\n`).join("");
    const calendar = Buffer.from(primaryIcs().toString("utf8").replace("END:VCALENDAR", `${extra}END:VCALENDAR`));
    const landed = await home.land(gcalExport, deliver(home, EXPORT_SOURCE, { [`${ACCOUNT}.ics`]: calendar }, EXPORT_FACTS));
    expect(landed).toMatchObject({ new: 6, refused: 4 });
    expect(landed.refusals.map((refusal) => [refusal.key.replace(/ at byte \d+$/u, ""), refusal.violations[0]])).toEqual([
      [`${ACCOUNT}.ics:VEVENT 6`, expect.stringContaining("before 2007")],
      [`${ACCOUNT}.ics:VEVENT 7`, expect.stringContaining("in a gap")],
      [`${ACCOUNT}.ics:VEVENT 8`, expect.stringContaining("needs both DTSTART and DTEND")],
      [`${ACCOUNT}.ics:VEVENT 9`, expect.stringContaining("a content line has no unquoted value separator")],
    ]);
    const named = await home.land(gcalExport, deliver(home, EXPORT_SOURCE, { "takeout-calendar.zip": Buffer.from("BEGIN:VCALENDAR\r\n") }, EXPORT_FACTS));
    expect([named.new, named.refusals]).toEqual([0, [{ kind: "file", key: "takeout-calendar.zip", violations: [expect.stringContaining("named .zip, its first bytes are not a zip's")] }]]);
    artifact(home.dir, "refused.json", { landed, named });
  });

  it("a created or updated stamp outside the record-time years refuses the pull, or an in-range one is spelled anew, or one that is no instant refuses more than its event", async () => {
    const home = openTestHome();
    const old = ["0001-01-01T00:00:00.000Z", "0001-01-01T00:00:00+05:30", "1000-01-01T00:00:00+00:01"];
    const edges = ["1000-01-01T00:00:00Z", "0999-12-31T23:59:59.999-01:00", "9999-12-31T23:59:59.999Z", "1969-12-31T23:59:59.999Z", "1970-01-01T00:00:00Z", "2024-02-29T23:59:59.9999+00:01", "2026-08-02T11:30:15.250Z"];
    const inRange = [...edges, ...inRangeStamps(2000)];
    const items = [...old, ...inRange].map(stamped);
    const rows = await collect(gcalApi.read(deliver(home, API_SOURCE, onePage(items), { fetched_at: "2026-09-07T04:00:00.000Z" }), home.blobs));
    const lines = rows.map((row) => {
      const text = (row.content as { content: string }).content;
      const created = /\r\nCREATED:([^\r]*)\r\n/u.exec(text)![1]!;
      expect(text).toContain(`\r\nLAST-MODIFIED:${created}\r\n`);
      return created;
    });
    expect(lines.slice(0, old.length)).toEqual(["00010101T000000Z", "00001231T183000Z", "09991231T235900Z"]);
    expect(lines.slice(old.length)).toEqual(inRange.map(recordTimeSpelling));
    for (const bad of ["2026-02-30T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T23:59:60Z", "2026-01-01T00:00:00-00:00", "2026-01-01T00:00:00+24:00", "0000-01-01T00:00:00+00:01", "9999-12-31T23:59:59-00:01"]) {
      const refused = await collect(gcalApi.read(deliver(home, API_SOURCE, onePage([stamped(bad, 0), stamped("2026-08-02T11:30:15Z", 1)]), { fetched_at: "2026-09-07T04:00:00.000Z" }), home.blobs));
      expect(refused.map((row) => [row.key, row.refused === undefined]), bad).toEqual([["p.json:item 0", false], ["stamp1@google.com", true]]);
    }
    artifact(home.dir, "stamps.json", { old, inRange: inRange.map((text, index) => ({ text, created: lines[old.length + index] })) });
  });
});
