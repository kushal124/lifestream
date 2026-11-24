import { afterEach, describe, expect, it } from "vitest";
import { instant, type DaySettings, type Instant, type JsonObject, type Line, type LineAdapter, type ReaderOutput } from "@lifestreamprotocol/core";
import type { DayDocument } from "../days.js";
import type { Extracted, Given } from "../family.js";
import { buildLabels } from "../shared/labels.js";
import { TestHome, shuffled } from "../test/drive.js";
import { pin } from "../test/pin.js";
import { plainFamily, type PlainDay } from "./family.js";
import { DATE, datedDays, ZONES } from "./test/dated.js";

const LABELS = buildLabels({ people: [], contacts: [], places: [] });
const LOG = "example-log:local:test";
const OTHER = "other-log:local:test";
const T0 = Date.UTC(2026, 8, 3, 10, 0);
const HOUR = 3_600_000;
const NEW_YORK: DaySettings = { zone: "America/New_York", day_start_hour: 4 };

const lineAdapter: LineAdapter = {
  version: "1",
  kinds: ["line"],
  line({ version }) {
    const content = version.content as JsonObject;
    if (content.skip === true) return null;
    const line = {
      text: content.words as string, ...(typeof content.title === "string" ? { title: content.title } : {}),
      ...(Array.isArray(content.who) ? { who: content.who as string[] } : {}), ...(typeof content.link === "string" ? { link: content.link } : {}),
    };
    return typeof content.stale === "string" ? { ...line, [content.stale]: version.time!.start_ms } : line;
  },
};

const given = (name = "Example log"): Given<LineAdapter> => ({ product: "example-log", name, vendor: "example", type: "notes", adapter: lineAdapter });

function line(key: string, at: number, words: string, extra: JsonObject = {}, kind = "line"): ReaderOutput {
  const time: Instant = { start_ms: at, ...(typeof extra.end === "number" ? { end_ms: extra.end } : {}), precision: "ms" };
  return { kind, key, content: { at, words, ...extra }, time };
}

function dated(key: string, time: Instant, words: string): ReaderOutput {
  return { kind: "line", key, content: { words }, time };
}

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.close();
});

function newHome(settings?: DaySettings, name?: string): TestHome {
  const home = new TestHome("families-plain-", { families: [plainFamily([given(name)])], ...(settings === undefined ? {} : { settings }) });
  homes.push(home);
  return home;
}

function documentOf(home: TestHome, day: string): DayDocument {
  return JSON.parse(home.render(day, LABELS).json) as DayDocument;
}

describe("plain family: what must be impossible", () => {
  it("a line lands outside its source's UTC day, or prints without its record, its stream's block or its connector's type", () => {
    const home = newHome();
    const first = home.deliver(LOG, T0, [
      line("b", T0 + HOUR, "the second line"),
      line("a", T0, "the build passed", { title: "CI" }),
      line("c", T0 + 20 * HOUR, "a line the next UTC day"),
    ]);
    expect(first.written).toEqual([`plain ${LOG}/2026-09-03`, `plain ${LOG}/2026-09-04`]);
    const day = home.extracts("plain").find((row) => row.unit === `${LOG}/2026-09-03`)!;
    expect(day.content).toEqual({
      name: "Example log", type: "notes",
      lines: [
        { start_ms: T0, precision: "ms", text: "the build passed", title: "CI", kind: "line", key: "a" },
        { start_ms: T0 + HOUR, precision: "ms", text: "the second line", kind: "line", key: "b" },
      ],
    } satisfies PlainDay);
    const document = documentOf(home, "2026-09-03");
    expect(document.atoms.map(({ family, text, record, block, type }) => ({ family, text, record, block, type }))).toEqual([
      { family: "plain", text: "CI: the build passed", record: { source: LOG, kind: "line", key: "a" }, block: { key: LOG, title: "Example log" }, type: "notes" },
      { family: "plain", text: "the second line", record: { source: LOG, kind: "line", key: "b" }, block: { key: LOG, title: "Example log" }, type: "notes" },
    ]);
    expect(document.counts.per_family).toEqual({ plain: 2 });
    expect(document.coverage).toEqual([{ family: "plain", sources: [{ source: LOG, read: "into" }] }]);
    home.artifact("day.json", document);
    pin(home.families[0]!, { line: [given()] }, home.extracts("plain"));
  });

  it("a record restated on another day stays in its old day's unit", () => {
    const home = newHome();
    home.deliver(LOG, T0, [line("a", T0, "a line"), line("b", T0 + HOUR, "a line that moves")]);
    const moved = home.deliver(LOG, T0 + 1, [line("b", T0 + 30 * HOUR, "a line that moves")]);
    expect(moved.touched).toEqual([`plain ${LOG}/2026-09-03`, `plain ${LOG}/2026-09-04`]);
    expect((home.extracts("plain").map((row) => [row.unit, (row.content as unknown as PlainDay).lines.map((each) => each.key)]))).toEqual([
      [`${LOG}/2026-09-03`, ["a"]], [`${LOG}/2026-09-04`, ["b"]],
    ]);
    const gone = home.deliver(LOG, T0 + 2, [line("a", T0 + 31 * HOUR, "a line")]);
    expect(gone.deleted).toEqual([`${LOG}/2026-09-03`].map((unit) => `plain ${unit}`));
  });

  it("a record its adapter gives no line prints one, or a kind or a product no adapter names is read", () => {
    const home = newHome();
    const skipped = home.deliver(LOG, T0, [line("a", T0, "no line", { skip: true })]);
    expect(skipped.touched).toEqual([`plain ${LOG}/2026-09-03`]);
    expect(skipped.written).toEqual([]);
    expect(home.deliver(LOG, T0 + 1, [line("k", T0, "a kind no adapter names", {}, "other")]).touched).toEqual([]);
    expect(home.deliver(OTHER, T0, [line("o", T0, "a product no adapter names")]).touched).toEqual([]);
    expect(home.extracts("plain")).toEqual([]);
    expect(documentOf(home, "2026-09-03").counts.per_family).toEqual({ plain: 0 });
  });

  it("a line prints on its unit's UTC day rather than the civil days its instant touches in the day's zone", () => {
    const home = newHome(NEW_YORK);
    const late = Date.UTC(2026, 8, 4, 2, 0);
    home.deliver(LOG, late, [line("late", late, "late in the evening"), line("long", late + HOUR, "a span across the morning", { end: late + 10 * HOUR })]);
    const row = home.extracts("plain")[0]!;
    expect(row.unit).toBe(`${LOG}/2026-09-04`);
    expect(row.days).toEqual(["2026-09-03", "2026-09-04"]);
    expect(documentOf(home, "2026-09-03").atoms.map((atom) => atom.text)).toEqual(["late in the evening", "a span across the morning"]);
    expect(documentOf(home, "2026-09-04").atoms.map((atom) => atom.text)).toEqual(["a span across the morning"]);
  });

  it("a renamed stream keeps its units' readings, so its days keep printing the old name", () => {
    const home = newHome();
    home.deliver(LOG, T0, [line("a", T0, "a line")]);
    const unit = `${LOG}/2026-09-03`;
    const [before, after] = home.read((view) => [plainFamily([given()]), plainFamily([given("Example journal")])].map((family) => family.extract(unit, view, home.blobs)!)) as [Extracted, Extracted];
    expect(after.reading).not.toBe(before.reading);
    expect((after.content as unknown as PlainDay).name).toBe("Example journal");
  });

  it("a record's search text is not its line's title, words, people and link, or a record with no line has one", () => {
    const home = newHome();
    home.deliver(LOG, T0, [
      line("a", T0, "deployed the site", { title: "Deploy", who: ["person-a@example.com"], link: "https://example.com/deploys/1" }),
      line("b", T0, "skipped", { skip: true }),
      line("k", T0, "a kind no adapter names", {}, "other"),
    ]);
    const family = home.families[0]!;
    const texts = home.read((view) => Object.fromEntries([...view.records(LOG, "line"), ...view.records(LOG, "other")]
      .map(({ head, version }) => [`${head.kind} ${head.key}`, family.text!.of(head, version, home.blobs, view)])));
    expect(texts).toEqual({
      "line a": { title: "Deploy", text: "deployed the site", who: ["person-a@example.com"], link: "https://example.com/deploys/1" },
      "line b": null,
      "other k": null,
    });
    expect(family.text!.kinds).toEqual(["line"]);
  });

  it("a line that still states its own time is printed at it, rather than refused by the type and its unit set aside with the fix in its words", () => {
    // @ts-expect-error a line states no time: the typecheck an author's `test` runs refuses it.
    const stated: Line = { at_ms: T0, text: "an adapter written before the line lost its time" };
    const written: LineAdapter = {
      version: "1", kinds: ["line"],
      // @ts-expect-error a line states no time, nor an end.
      line() { return { text: "an adapter written before the line lost its time", at_ms: T0, end_ms: T0 + 60_000 }; },
    };
    void [stated, written];
    for (const stale of ["at_ms", "end_ms"]) {
      const home = newHome();
      home.land(LOG, T0, [line("old", T0, "an adapter written before the line lost its time", { stale })]);
      expect(() => home.extractPass(home.families[0]!)).toThrow(
        `the line adapter of example-log gives line old a line that states ${stale}: a line is placed at its record's own time; drop at_ms and end_ms`,
      );
    }
  });

  it("a dated line is placed at an instant: off its date west or east of UTC or with a 04:00 day start, timed, or out of the untimed section", () => {
    for (const { zone, days, text } of datedDays()) {
      const on = days[DATE]!;
      const film = on.atoms.find((atom) => atom.record?.key === "film");
      expect(film, zone).toMatchObject({ family: "plain", text: "Watched: a synthetic film", flags: ["date_only"], start_ms: Date.UTC(2026, 8, 3), end_ms: null });
      expect(film!.local_start, zone).toBeNull();
      expect(on.atoms.find((atom) => atom.record?.key === "noon")!.flags, zone).not.toContain("date_only");
      const lines = text[DATE]!.split("\n");
      expect(lines.slice(lines.indexOf(`On ${DATE}, time unknown`), undefined).slice(0, 2), zone).toEqual([`On ${DATE}, time unknown`, "Watched: a synthetic film"]);
      for (const other of Object.keys(days).filter((day) => day !== DATE)) {
        expect(days[other]!.atoms.filter((atom) => atom.record?.key === "film"), `${zone} ${other}`).toEqual([]);
      }
    }
    expect(ZONES.map((settings) => settings.day_start_hour)).toEqual([4, 4, 4]);
    expect(ZONES.map((settings) => settings.zone)).toEqual(["America/Los_Angeles", "Pacific/Kiritimati", "UTC"]);
  });

  it("a span of dates leaves a date it covers, ends a day late, or a month or a year is placed on a day", () => {
    const home = newHome(NEW_YORK);
    home.deliver(LOG, T0, [
      dated("trip", { start_ms: Date.UTC(2026, 8, 5), end_ms: Date.UTC(2026, 8, 7), precision: "day" }, "two dates"),
      dated("month", instant("2026-09", "month"), "a month"),
    ]);
    const row = home.extracts("plain")[0]!;
    expect(row.days).toEqual(["2026-09-05", "2026-09-06"]);
    expect((row.content as unknown as PlainDay).lines.map((each) => each.key)).toEqual(["trip"]);
    const atoms = ["2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07"].map((day) => documentOf(home, day).atoms.map((atom) => [atom.record?.key, atom.flags]));
    expect(atoms).toEqual([[], [["trip", ["date_only", "continues_into_next_day"]]], [["trip", ["date_only", "continues_from_previous_day"]]], []]);
    expect(home.extracts("plain").map((each) => each.unit)).toEqual([`${LOG}/2026-09-05`]);
  });

  it("the same records in another order make other extracts", () => {
    const rows = [line("a", T0, "one"), line("b", T0, "two at the same instant"), line("c", T0 + 5 * HOUR, "three"), line("d", T0 + 26 * HOUR, "four")];
    const extracts = [1, 2].map((seed) => {
      const home = newHome();
      home.deliver(LOG, T0, shuffled(rows, seed));
      return home.extracts("plain").map(({ unit, reading, content, days }) => ({ unit, reading, content, days }));
    });
    expect(extracts[1]).toEqual(extracts[0]);
  });

  it("with no line adapter the family is missing from a day's counts and coverage", () => {
    const home = new TestHome("families-plain-none-", { families: [plainFamily([])] });
    homes.push(home);
    const document = documentOf(home, "2026-09-03");
    expect(document.counts.per_family).toEqual({ plain: 0 });
    expect(document.coverage).toEqual([{ family: "plain", sources: [] }]);
    expect(home.families[0]!.inputs).toEqual([]);
  });
});
