import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RecordRef } from "@lifestreamprotocol/core";
import { describe, expect, it } from "vitest";
import { episodes, type EpisodesExtras, type EpisodesFile } from "./day-episodes.js";
import { moment, type Moment, type MomentMade, type MomentReads } from "./day-moment.js";
import { atomFocus, dayPage, recordFocus, unitFocus } from "./day-page.js";
import { NO_SIDE, type KnownPerson } from "./day-side.js";
import type { DayAtom } from "./days.js";
import { datedDays, DATE } from "./plain/test/dated.js";

const FOLDER = join(dirname(fileURLToPath(import.meta.url)), "test", "day-page");
const WRITE = process.env.LIFESTREAM_FIXTURES === "write";
const CALLER = "person-a@example.com";
const OPEN = { label: "Open in the app", href: "https://example.com/chat" };
const PLACE = "place-a";
const CALLS_SOURCE = "apple-calls:person-a@example.com:macbook-pro-0001";
const MONDAY = "2031-03-03";
const THURSDAY = "2031-03-06";
const madeOf = (ref: RecordRef): MomentMade => ({
  by: "Model A", at_ms: null, state: "done", line: "Model A · today", ask: { family: "voice", item: `voice-${ref.key}`, prompt: "transcribe" }, choose: [],
});

function callOn(day: string, n: number, key: string, text: string): DayAtom {
  const start_ms = Date.parse(`${day}T09:00:00Z`);
  return {
    n, family: "calls", unit: `calls:local:macbook-pro-0001/${day}`, units: [], start_ms, end_ms: start_ms + 240_000, local_start: "09:00", local_end: "09:04",
    flags: [], text, record: { source: CALLS_SOURCE, kind: "call", key },
  };
}

const WEEK: Readonly<Record<string, DayAtom[]>> = {
  [MONDAY]: [callOn(MONDAY, 1, "CALL-W1", "Video call with Person A, they called, 4 min")],
  [THURSDAY]: [callOn(THURSDAY, 1, "CALL-W2", "Missed phone call from Person A")],
};

const read = (name: string): string => readFileSync(join(FOLDER, name), "utf8");
const { sources } = JSON.parse(read("sources.json")) as { sources: NonNullable<EpisodesExtras["sources"]> };
const today = JSON.parse(read("today.json")) as { day: string; now_ms: number };

function inputsOf(day: string): { file: EpisodesFile; extras: EpisodesExtras } {
  const { sleep, sent, groups, products, ...file } = JSON.parse(read(`${day}.day.json`)) as EpisodesFile & EpisodesExtras;
  return { file, extras: { ...sleep && { sleep }, ...sent && { sent }, ...groups && { groups }, ...products && { products }, sources } };
}

const READS: MomentReads = {
  text: (ref: RecordRef) => ({ title: `Title ${ref.key}`, text: `Where ${ref.key}\nWords of ${ref.key}`, who: [ref.kind.includes("call") ? CALLER : `${ref.key}@example.com`] }),
  account: () => ({
    summary: "A synthetic sitting.",
    life: { people: ["Person A, a friend"], projects: ["Project B (a draft)"] },
    actions: [{ at_ms: 2, what: "saved" }, { at_ms: 1, what: "opened" }],
    timeline: [{ start_ms: 0, end_ms: 60_000, task: "writing", present: "yes" }, { start_ms: 60_000, end_ms: 120_000, task: "reading", present: "no" }],
  }),
  turns: () => null,
  open: () => OPEN,
  place: () => PLACE,
  made: madeOf,
  calls: (asked) => WEEK[asked] ?? [],
  people: () => PEOPLE,
};

const NOTHING: MomentReads = {
  text: () => null, account: () => null, turns: () => null, open: () => null, place: () => null, made: () => null, calls: () => [], people: () => [],
};

interface Golden {
  name: string;
  day: string;
  now: number | null;
}

const GOLDENS: Golden[] = [
  { name: "2031-03-04", day: "2031-03-04", now: null },
  { name: "2031-04-05", day: "2031-04-05", now: null },
  { name: "today", day: today.day, now: today.now_ms },
];

function momentsOf(golden: Golden): Record<string, Moment | null> {
  const { file, extras } = inputsOf(golden.day);
  const ids = episodes(file, extras, golden.now).episodes.map((episode) => episode.id);
  return Object.fromEntries(ids.map((id) => [id, moment(file, extras, { focus: id, whole: false, marks: null, today: golden.day }, READS, golden.now)]));
}

const day = "2031-03-04";
const { file, extras } = inputsOf(day);
const all = episodes(file, extras, null);
const atomsOf = (id: string) => all.episodes.find((episode) => episode.id === id)!.atoms.map((n) => file.atoms.find((atom) => atom.n === n)!);
const first = (kind: string) => all.episodes.find((episode) => episode.kind === kind)!;
const at = (focus: string, reads = READS, now: number | null = null, more: { whole?: boolean; marks?: string[]; today?: string } = {}) =>
  moment(file, extras, { focus, whole: more.whole ?? false, marks: more.marks ?? null, today: more.today ?? day }, reads, now);
const direct = all.episodes.find((episode) => episode.kind === "conversation" && !episode.group && episode.title)!;
const PEOPLE: KnownPerson[] = [
  { id: "person-a", name: "Person A", chats: [], handles: [{ id: `email:${CALLER}`, kind: "email" }] },
  { id: "person-chat", name: "Person Z", chats: [{ key: atomsOf(direct.id)[0]!.block!.key }], handles: [] },
];

describe("a moment: one row of the day, everything the panel draws of it", () => {
  for (const golden of GOLDENS) {
    it(`pins the moment of every row of ${golden.name} (LIFESTREAM_FIXTURES=write rewrites)`, () => {
      const written = `${JSON.stringify(momentsOf(golden), null, 2)}\n`;
      const name = `${golden.name}.moments.json`;
      if (WRITE) writeFileSync(join(FOLDER, name), written);
      expect(written).toBe(read(name));
    });
  }

  it("finds a row by its atom, its unit and its record alike, and marks the record it was asked by", () => {
    const call = first("call");
    const atom = atomsOf(call.id)[0]!;
    const ref = atom.record!;
    const byRecord = at(`rec:${ref.source} ${ref.kind} ${ref.key}`)!;
    expect(at(`a${atom.n}`)!.key).toBe(call.id);
    expect(at(`u:${atom.unit}`)!.key).toBe(call.id);
    expect(byRecord.key).toBe(call.id);
    expect(byRecord.marks).toEqual([ref.key]);
    expect(at(call.id)!.marks).toEqual([]);
  });

  it("opens every row of each golden day by the focus its page gives it, asked with no marks, as its key opens it", () => {
    for (const golden of GOLDENS) {
      const { file: held, extras: more } = inputsOf(golden.day);
      const page = dayPage(held, { ...more, ...NO_SIDE }, golden.now);
      const rows = [...page.all_day, ...page.chapters.flatMap((chapter) => chapter.blocks.flatMap((block) => block.rows)), ...page.also?.rows ?? [], ...page.plans];
      expect(rows.length, golden.name).toBeGreaterThan(0);
      for (const row of rows) {
        const ask = { whole: false, today: golden.day };
        const byKey = moment(held, more, { focus: row.key, marks: null, ...ask }, READS, golden.now);
        const byFocus = moment(held, more, { focus: row.focus!, marks: [], ...ask }, READS, golden.now);
        expect(byFocus, `${golden.name} ${row.key} ${row.focus}`).toEqual(byKey);
      }
    }
  });

  it("answers null for a focus the day holds nothing of", () => {
    expect(at("e999999")).toBeNull();
    expect(at("rec:nowhere kind key")).toBeNull();
  });

  it("opens a site's row as the sitting it sits in, and names that sitting as the row", () => {
    const site = all.episodes.find((episode) => episode.within !== undefined)!;
    const got = at(`a${site.atoms[0]}`)!;
    expect(got.row).toBe(site.within);
    expect(got.view.view).toBe("sitting");
  });

  it("lists other calls with the same person by the records' who, in time order, and none when no record reads", () => {
    const calls = all.episodes.filter((episode) => episode.kind === "call" && episode.start_ms !== null && atomsOf(episode.id)[0]!.record);
    const got = at(calls[0]!.id)!;
    expect(got.view.view).toBe("call");
    if (got.view.view !== "call") return;
    expect(got.view.others.map((other) => other.at_ms)).toEqual(calls.slice(1).map((other) => other.start_ms).sort((a, b) => a! - b!));
    const alone = at(calls[0]!.id, NOTHING)!;
    expect(alone.view.view === "call" && alone.view.others).toEqual([]);
  });

  it("gives a call the week's calls with the same person by the records' who, other days' too, never itself, and never past today", () => {
    const call = all.episodes.find((episode) => episode.kind === "call" && atomsOf(episode.id)[0]!.text.startsWith("Phone call with Person A"))!;
    const own = atomsOf(call.id)[0]!.record!;
    const others = all.episodes.filter((episode) => episode.kind === "call" && episode.id !== call.id && episode.start_ms !== null && atomsOf(episode.id)[0]!.record);
    const week = (asked: string) => {
      const got = at(call.id, READS, null, { today: asked })!.view;
      return got.view === "call" ? got.week : undefined;
    };
    const now = week(day)!;
    expect(now.current).toBe(true);
    expect(now.calls.map((each) => each.focus)).not.toContain(`rec:${own.source} ${own.kind} ${own.key}`);
    expect(now.calls.map((each) => [each.day, each.at_ms])).toEqual([
      [MONDAY, WEEK[MONDAY]![0]!.start_ms], ...others.map((other) => [day, other.start_ms]).sort((left, right) => (left[1] as number) - (right[1] as number)),
    ]);
    expect(now.calls[0]).toEqual({ day: MONDAY, at_ms: WEEK[MONDAY]![0]!.start_ms, title: "Video call", icon: "video", length_ms: 240_000, focus: `rec:${CALLS_SOURCE} call CALL-W1` });
    const later = week("2031-04-01")!;
    expect(later.current).toBe(false);
    expect(later.calls.at(-1)).toMatchObject({ day: THURSDAY, title: "Missed phone call", icon: "call-missed", length_ms: 240_000 });
    expect(week("2031-03-02")!.calls).toEqual([]);
    const alone = at(call.id, NOTHING)!.view;
    expect(alone.view === "call" && alone.week).toBeNull();
  });

  it("gives a stay the slug of the place the home knows it as, and a row inside the stay that same place", () => {
    const stay = first("stay");
    expect(at(stay.id)!.place).toMatchObject({ name: at(stay.id)!.title, slug: PLACE });
    expect(at(stay.id, NOTHING)!.place!.slug).toBeNull();
  });

  it("gives a voice note the transcribe act the home offers for its record", () => {
    const note = first("voice_note");
    const got = at(note.id)!.view;
    expect(got.view).toBe("voice");
    if (got.view !== "voice") return;
    expect(got.notes.map((each) => each.made)).toEqual(got.notes.map((each) => each.record === null ? null : madeOf(each.record)));
    expect(got.notes.some((each) => each.made !== null)).toBe(true);
    const bare = at(note.id, NOTHING)!.view;
    expect(bare.view === "voice" && bare.notes.map((each) => each.made)).toEqual(got.notes.map(() => null));
  });

  it("gives a voice note no words until its transcript is made, its words after", () => {
    const { file: held, extras: more } = inputsOf("2031-04-05");
    const note = episodes(held, more, null).episodes.find((episode) => episode.kind === "voice_note")!;
    const text = held.atoms.find((atom) => atom.n === note.atoms[0])!.text;
    expect(text).not.toContain(": ");
    const ask = { focus: note.id, whole: false, marks: null, today: "2031-04-05" };
    const bare = moment(held, more, ask, NOTHING, null)!.view;
    expect(bare.view === "voice" && bare.notes.map((each) => each.words)).toEqual([""]);
    const made = { ...held, atoms: held.atoms.map((atom) => atom.n === note.atoms[0] ? { ...atom, text: `${text}: Synthetic words.` } : atom) };
    const heard = moment(made, more, ask, NOTHING, null)!.view;
    expect(heard.view === "voice" && heard.notes.map((each) => each.words)).toEqual(["Synthetic words."]);
  });

  it("names each person's id: a chat by its key, a call by its record's handles, none the home holds no person for", () => {
    const call = all.episodes.find((episode) => episode.kind === "call" && atomsOf(episode.id)[0]!.text.startsWith("Phone call with Person A"))!;
    expect(at(call.id)!.people).toEqual([{ name: "Person A", person: "person-a", chat: null, call: atomsOf(call.id)[0]!.record }]);
    expect(at(direct.id)!.people.map((person) => person.person)).toEqual(["person-chat"]);
    expect(at(call.id, NOTHING)!.people.map((person) => person.person)).toEqual([null]);
  });

  it("draws mail with several letters as a list, and a letter's atom opens that letter", () => {
    const mail = all.episodes.find((episode) => episode.kind === "mail_received" && episode.atoms.length > 1)!;
    const listed = at(mail.id)!;
    expect(listed.view.view === "mail" && listed.view.list).toBe(true);
    expect(listed.letter).toBeNull();
    expect(listed.record).toBeNull();
    const second = at(`a${mail.atoms[1]}`)!;
    expect(second.letter).toBe(1);
    expect(second.view.view === "mail" && second.view.letters[1]!.words).toBe(`Where ${atomsOf(mail.id)[1]!.record!.key}\nWords of ${atomsOf(mail.id)[1]!.record!.key}`);
  });

  it("names a letter's sender by the person the home holds for its record's handle, and none it holds no person for", () => {
    const mail = all.episodes.find((episode) => episode.kind === "mail_received" && episode.atoms.length > 1)!;
    const [first, second] = atomsOf(mail.id).map((atom) => atom.record!);
    const sender: KnownPerson = { id: "person-sender", name: "Sender A", chats: [], handles: [{ id: `email:${first!.key}@example.com`, kind: "email" }] };
    const letters = (reads: MomentReads) => {
      const got = at(mail.id, reads)!.view;
      return got.view === "mail" ? got.letters.map((letter) => [letter.person === null, letter.person_id]) : [];
    };
    const named = letters({ ...READS, people: () => [sender] });
    expect(named[0], "the first letter's sender, by its record's handle").toEqual([false, "person-sender"]);
    expect(named[1], `the second, ${second!.key}, held by no one`).toEqual([false, null]);
    expect(letters(NOTHING).map(([, id]) => id), "no person read, no id").toEqual(named.map(() => null));
  });

  it("gives a chat its way out from the home's open and a group none", () => {
    const direct = all.episodes.find((episode) => episode.kind === "conversation" && !episode.group);
    const group = all.episodes.find((episode) => episode.kind === "conversation" && episode.group);
    if (direct) expect(at(direct.id)!.out).toEqual(OPEN);
    if (group) expect(at(group.id)!.out).toBeNull();
    expect(direct ?? group).toBeDefined();
  });

  it("orders a sitting's tasks by time spent and gives each step its own actions", () => {
    const sitting = first("sitting");
    const got = at(sitting.id)!;
    expect(got.view.view).toBe("sitting");
    if (got.view.view !== "sitting" || got.view.account === null) throw new Error("no account");
    expect(got.view.account.tasks.map((task) => task.task)).toEqual(["Writing", "Reading"]);
    expect(got.view.account.steps.map((step) => step.actions.map((action) => action.what))).toEqual([["opened", "saved"], []]);
    expect(got.view.account.steps.map((step) => step.present)).toEqual([null, "no"]);
    expect(got.view.account.people).toEqual(["Person A"]);
    expect(at(sitting.id, NOTHING)!.view.view === "sitting" && (at(sitting.id, NOTHING)!.view as { account: unknown }).account).toBeNull();
  });

  it("calls an event after the home's now a plan, and never on a past day", () => {
    const { file: todayFile, extras: todayExtras } = inputsOf(today.day);
    const later = episodes(todayFile, todayExtras, today.now_ms).episodes.find((episode) => episode.kind === "event" && episode.start_ms !== null && episode.start_ms > today.now_ms);
    const event = first("event");
    expect(at(event.id)!.view.view === "event" && (at(event.id)!.view as { plan: boolean }).plan).toBe(false);
    if (later === undefined) return;
    const got = moment(todayFile, todayExtras, { focus: later.id, whole: false, marks: null, today: today.day }, READS, today.now_ms)!;
    expect(got.view.view === "event" && got.view.plan).toBe(true);
  });

  it("joins a chat's pieces when asked for the whole chat", () => {
    const pieces = new Map<string, string[]>();
    for (const episode of all.episodes.filter((each) => each.kind === "conversation")) {
      const key = atomsOf(episode.id)[0]!.block?.key ?? "";
      pieces.set(key, [...pieces.get(key) ?? [], episode.id]);
    }
    const split = [...pieces.values()].find((ids) => ids.length > 1);
    if (split === undefined) return;
    const asked = atomsOf(split[0]!)[0]!;
    const whole = at(`a${asked.n}`, READS, null, { whole: true })!;
    expect(whole.source.atoms).toBe(split.reduce((sum, id) => sum + atomsOf(id).length, 0));
  });
});

describe("a moment the dashboard's tests once built by hand", () => {
  const START = Date.UTC(2026, 9, 14, 12, 0);
  const ask = { whole: false, marks: null, today: "2026-10-14" };

  it("a call from your other number, or a chat with yourself: You in its name, never \"the user\"", () => {
    const own: EpisodesFile = {
      day: "2026-10-14", zone: "UTC", window: { start_ms: START, end_ms: START + 86_400_000 }, coverage: [],
      atoms: [
        { n: 1, family: "calls", unit: "calls:local:macbook-pro-0001/2026-10-14", units: [], start_ms: START, end_ms: null, local_start: "12:00",
          local_end: null, flags: [], text: "Missed phone call from the user", record: { source: "calls:local:macbook-pro-0001", kind: "call", key: "c1" } },
        { n: 2, family: "messages", unit: "2026-10-14:whatsapp:15550000002@s.whatsapp.net", units: [], start_ms: START + 3_600_000, end_ms: null,
          local_start: "13:00", local_end: null, flags: [], text: "the user: a synthetic note to self",
          record: { source: "whatsapp:15550000001:iphone-aa01", kind: "msg", key: "15550000002@s.whatsapp.net:AAA1" },
          block: { key: "whatsapp:15550000001:iphone-aa01/15550000002@s.whatsapp.net", title: "the user" } },
      ] satisfies DayAtom[],
    };
    const rows = episodes(own, {}).episodes;
    const named = (kind: string) => moment(own, {}, { focus: rows.find((each) => each.kind === kind)!.id, ...ask }, NOTHING, null)!;
    expect([named("call").name, named("conversation").name]).toEqual(["You", "You"]);
    expect(named("call").people.map((person) => person.name)).not.toContain("the user");
  });

  it("a focus names a record whose key holds spaces, and a unit within a time range: the line there is the one marked", () => {
    const unit = "2026-10-14:whatsapp:15550000003@s.whatsapp.net";
    const source = "whatsapp:15550000001:iphone-aa01";
    const lineAt = (n: number, minutes: number, key: string): DayAtom => ({
      n, family: "messages", unit, units: [], start_ms: START + minutes * 60_000, end_ms: null, local_start: `12:0${minutes}`, local_end: null, flags: [],
      text: `Person A: synthetic line ${n}`, record: { source, kind: "msg", key },
      block: { key: "whatsapp:15550000001:iphone-aa01/15550000003@s.whatsapp.net", title: "Person A" },
    });
    const chat: EpisodesFile = {
      day: "2026-10-14", zone: "UTC", window: { start_ms: START, end_ms: START + 86_400_000 }, coverage: [],
      atoms: [lineAt(1, 0, "a key with spaces"), lineAt(2, 2, "second-line"), lineAt(3, 4, "third-line")] satisfies DayAtom[],
    };
    const focused = (focus: string) => moment(chat, {}, { focus, ...ask }, NOTHING, null)!;
    expect(recordFocus({ source, kind: "msg", key: "a key with spaces" })).toBe(`rec:${source} msg a key with spaces`);
    expect(focused(recordFocus({ source, kind: "msg", key: "a key with spaces" })).marks).toEqual(["a key with spaces"]);
    const ranged = unitFocus(unit, { from_ms: START + 120_000, to_ms: START + 180_000 });
    expect(ranged).toBe(`u:${unit}@${START + 120_000}-${START + 180_000}`);
    expect(focused(ranged).marks).toEqual(["second-line"]);
    expect(focused(unitFocus(unit)).key).toBe(focused(ranged).key);
    expect(focused(unitFocus(unit)).marks).toEqual([]);
    expect(focused(atomFocus(3)).marks).toEqual(["third-line"]);
  });

  it("a chat opens where the home's open says, a group and a chat the home has no open for nowhere, a line at its record", () => {
    const { file: lines, extras: more } = inputsOf("2031-07-01");
    const rows = episodes(lines, more).episodes;
    const chat = rows.find((each) => each.family === "messages")!;
    const line = rows.find((each) => each.family === "plain")!;
    const of = (id: string, reads: MomentReads, groups: string[] = []) => moment(lines, { ...more, groups }, { focus: id, ...ask }, reads, null)!;
    expect(of(chat.id, READS).out).toEqual(OPEN);
    expect(of(chat.id, NOTHING).out).toBeNull();
    expect(of(chat.id, READS, ["example-chat:12345"]).out).toBeNull();
    expect(of(line.id, READS).record).toEqual({ source: "example-log:local:test", kind: "line", key: "l-1" });
  });

  it("a dated line is no plan: \"No time of day\" in every zone; a dated event \"All day\"", () => {
    for (const { zone, days } of datedDays()) {
      const dated = days[DATE]! as EpisodesFile;
      const film = dated.atoms.find((atom) => atom.record?.key === "film")!;
      expect(moment(dated, {}, { focus: `a${film.n}`, ...ask }, NOTHING, null)!.untimed, zone).toBe("No time of day");
    }
    const event = all.all_day[0];
    expect(event, "the golden day has an all-day event").toBeDefined();
    expect(at(event!)!.untimed).toBe("All day");
  });
});
