import { describe, expect, it } from "vitest";
import { CHECKPOINT_PAGES } from "@lifestreamprotocol/core";
import { BEHIND_MS, DRAIN_MS, RESIDUE_PAGES, WriteLog, type Copied, type Drain, type LogSeam } from "./write-log.js";

const TRY = CHECKPOINT_PAGES;
const DRAIN = 4 * TRY;
const TURN = 1_000;
const MINUTE = 60_000;

function fakeLog(raised: number | null = null) {
  const at = { now: 0, log: 0, left: 0, readers: 0, pinned: false, flight: 0 };
  const waits: number[] = [];
  const calls: string[] = [];
  const began: { frames: number; jobs: number }[] = [];
  const drains: Drain[] = [];
  const need: (number | null)[] = [];
  let sent: { log: number } | null = null;
  const seam: LogSeam = {
    now: () => at.now,
    look: () => {
      calls.push("look");
      return { busy: 0, log: at.log, checkpointed: at.log - at.left };
    },
    copy: () => {
      calls.push("copy");
      sent = { log: at.log };
    },
    truncate: (wait_ms) => {
      calls.push("truncate");
      expect(at.left, "left to copy at a truncate").toBeLessThan(RESIDUE_PAGES);
      waits.push(wait_ms);
      if (wait_ms > 0) at.flight = 0;
      if (at.readers > 0 || at.flight > 0) return { busy: 1, log: at.log, checkpointed: at.log - at.left };
      at.log = 0;
      at.left = 0;
      return { busy: 0, log: 0, checkpointed: 0 };
    },
    began: (frames, jobs) => began.push({ frames, jobs }),
    ended: (drain) => drains.push(drain),
    need: (since_ms) => need.push(since_ms),
  };
  const rule = new WriteLog(seam, { drain_pages: DRAIN, turn_ms: TURN }, raised);
  const none = new Set<number>();
  const write = (frames: number) => {
    at.log += frames;
    at.left += frames;
  };
  const taken = () => {
    const out = sent;
    sent = null;
    expect(out, "a copy out").not.toBeNull();
    return out!;
  };
  const answer = (running: ReadonlySet<number> = none) => {
    const { log } = taken();
    if (!at.pinned) at.left = Math.min(at.left, at.log - log);
    const copied: Copied = { checkpointed: Math.min(log, at.log - at.left), ms: 5 };
    rule.copied(copied, running);
  };
  const lose = (running: ReadonlySet<number> = none) => {
    taken();
    rule.copied("lost", running);
  };
  const close = (running: ReadonlySet<number> = none) => {
    taken();
    rule.copied("closed", running);
  };
  return { at, waits, calls, began, drains, need, rule, none, write, answer, lose, close };
}

describe("the tries", () => {
  it("try only at the mark or on the clock, wholly copied or not, and once a failure, as many frames again", () => {
    const { at, waits, began, rule, none } = fakeLog();
    at.log = TRY - 1;
    rule.tick(false, none);
    expect(waits).toEqual([]);
    at.readers = 1;
    rule.tick(true, none);
    expect(waits).toEqual([0]);
    at.log = TRY;
    rule.tick(false, none);
    expect(waits).toEqual([0, 0]);
    at.log = 2 * TRY - 1;
    rule.tick(false, none);
    expect(waits.length).toBe(2);
    at.log = 2 * TRY;
    rule.tick(false, none);
    expect(waits.length).toBe(3);
    expect(began).toEqual([]);
    at.readers = 0;
    at.log = 3 * TRY;
    rule.tick(false, none);
    expect([at.log, waits.length, began.length]).toEqual([0, 4, 0]);
    at.log = TRY;
    rule.tick(false, none);
    expect(waits.length).toBe(5);
  });

  it("a try that fails over the drain's mark begins a drain, saying the frames and the jobs; jobs start only once it ends", () => {
    const { at, waits, began, rule } = fakeLog();
    at.readers = 1;
    at.log = DRAIN;
    rule.tick(false, new Set([7, 8]));
    expect(began).toEqual([{ frames: DRAIN, jobs: 2 }]);
    expect(rule.mayStart(new Set([7, 8]))).toBe(false);
    expect(waits).toEqual([0]);
    at.log = DRAIN + TRY;
    rule.tick(true, new Set([7, 8]));
    expect(waits).toEqual([0]);
  });
});

describe("a drain", () => {
  it("waits for readers, not jobs: each job's end tries without waiting, and a job that reads nothing holds none", () => {
    const { at, waits, drains, rule } = fakeLog();
    at.readers = 2;
    at.log = DRAIN;
    rule.tick(false, new Set([1, 2, 3]));
    at.readers = 1;
    at.now = 10_000;
    expect(rule.mayStart(new Set([2, 3]))).toBe(false);
    expect(waits).toEqual([0, 0]);
    at.readers = 0;
    at.now = 25_000;
    expect(rule.mayStart(new Set([3]))).toBe(true);
    expect(waits).toEqual([0, 0, 0]);
    expect(drains).toEqual([{ at_ms: 25_000, end: "emptied", ms: 25_000, frames: DRAIN, jobs: 1 }]);
    expect(rule.mayStart(new Set([3, 4]))).toBe(true);
  });

  it("with no job running waits a turn at a time for a read in flight, never past its bound, and ends when the read does", () => {
    const { at, waits, drains, rule, none } = fakeLog();
    at.readers = 1;
    at.log = DRAIN;
    rule.tick(false, none);
    for (let turn = 0; turn < 3; turn++) {
      expect(rule.mayStart(none)).toBe(false);
      at.now += TURN;
    }
    expect(waits).toEqual([0, TURN, TURN, TURN]);
    at.readers = 0;
    expect(rule.mayStart(none)).toBe(true);
    expect(drains).toEqual([expect.objectContaining({ end: "emptied", ms: 3 * TURN, jobs: 0 })]);
  });

  it("waits no longer than its bound has left", () => {
    const { at, waits, rule, none } = fakeLog();
    at.readers = 1;
    at.log = DRAIN;
    rule.tick(false, none);
    at.now = DRAIN_MS - 300;
    expect(rule.mayStart(none)).toBe(false);
    expect(waits.at(-1)).toBe(300);
  });
});

describe("its bound", () => {
  it("ends one a job outlasted, and begins none while that job runs, then one at the next failed try once it ended", () => {
    const { at, waits, began, drains, need, rule } = fakeLog();
    at.readers = 1;
    at.log = DRAIN;
    rule.tick(false, new Set([5]));
    at.now = DRAIN_MS - 1;
    expect(rule.mayStart(new Set([5]))).toBe(false);
    at.now = DRAIN_MS;
    expect(rule.mayStart(new Set([5]))).toBe(true);
    expect(waits).toEqual([0, 0]);
    expect(drains).toEqual([{ at_ms: DRAIN_MS, end: "outlasted", ms: DRAIN_MS, frames: DRAIN, jobs: 1 }]);
    for (const step of [1, 2, 3]) {
      at.log = DRAIN + step * TRY;
      rule.tick(false, new Set([5, 6]));
      expect(rule.mayStart(new Set([5, 6]))).toBe(true);
    }
    expect([began.length, waits.length]).toEqual([1, 5]);
    expect(rule.mayStart(new Set([6]))).toBe(true);
    at.log = DRAIN + 4 * TRY;
    rule.tick(false, new Set([6]));
    expect(began.length).toBe(2);
    expect(need).toEqual([]);
  });

  it("ends one no job outlasted as held from outside, begins the next only at the drain's mark again, and raises the need after ten minutes of them", () => {
    const { at, began, drains, need, rule, none } = fakeLog();
    at.readers = 1;
    at.log = DRAIN;
    rule.tick(false, none);
    at.now = DRAIN_MS;
    expect(rule.mayStart(none)).toBe(true);
    expect(drains.map((drain) => drain.end)).toEqual(["outside"]);
    expect(need).toEqual([]);
    at.log = DRAIN + 3 * TRY;
    rule.tick(false, none);
    expect(began.length).toBe(1);
    at.log = 2 * DRAIN;
    at.now = BEHIND_MS;
    rule.tick(false, none);
    expect(began.length).toBe(2);
    at.now = BEHIND_MS + DRAIN_MS;
    expect(rule.mayStart(none)).toBe(true);
    expect(need).toEqual([DRAIN_MS]);
    at.log = 3 * DRAIN;
    rule.tick(false, none);
    at.now += DRAIN_MS;
    rule.mayStart(none);
    expect(need).toEqual([DRAIN_MS]);
    at.readers = 0;
    at.log = 3 * DRAIN + TRY;
    rule.tick(false, none);
    expect(need).toEqual([DRAIN_MS, null]);
  });

  it("begins none while any job the last drain outlasted still runs, however many it outlasted", () => {
    const { at, began, rule } = fakeLog();
    at.readers = 1;
    at.log = DRAIN;
    rule.tick(false, new Set([5, 7]));
    at.now = DRAIN_MS;
    expect(rule.mayStart(new Set([5, 7]))).toBe(true);
    expect(rule.mayStart(new Set([5]))).toBe(true);
    at.log = DRAIN + TRY;
    rule.tick(false, new Set([5]));
    expect(began.length).toBe(1);
    expect(rule.mayStart(new Set())).toBe(true);
    at.log = DRAIN + 2 * TRY;
    rule.tick(false, new Set());
    expect(began.length).toBe(2);
  });

  it("with a read from outside standing and nothing written, tries once a minute: the need comes at ten minutes and ends with the read, clocks off", () => {
    const { at, began, need, rule, none } = fakeLog();
    at.readers = 1;
    at.log = DRAIN;
    rule.tick(false, none);
    at.now = DRAIN_MS;
    rule.mayStart(none);
    const tries = () => rule.tick(false, none);
    at.now = DRAIN_MS + 30_000;
    tries();
    expect(need).toEqual([]);
    for (at.now = DRAIN_MS + MINUTE; at.now < DRAIN_MS + BEHIND_MS; at.now += MINUTE) tries();
    expect(need).toEqual([]);
    at.now = DRAIN_MS + BEHIND_MS;
    tries();
    expect(need).toEqual([DRAIN_MS]);
    expect(began.length).toBe(1);
    at.readers = 0;
    at.now += MINUTE;
    tries();
    expect(need).toEqual([DRAIN_MS, null]);
  });

  it("counts no paced try toward the need while a job of the home's runs, and waits for nothing then", () => {
    const { at, waits, need, rule, none } = fakeLog();
    at.readers = 1;
    at.log = DRAIN;
    rule.tick(false, none);
    at.now = DRAIN_MS;
    rule.mayStart(none);
    const from = waits.length;
    for (at.now = DRAIN_MS + MINUTE; at.now <= DRAIN_MS + 2 * BEHIND_MS; at.now += MINUTE) rule.tick(false, new Set([9]));
    expect(need).toEqual([]);
    expect(new Set(waits.slice(from))).toEqual(new Set([0]));
  });

  it("gives the door's reads in flight a turn before a paced try counts: the read from outside gone, a door read at each try raises no need", () => {
    const { at, waits, need, rule, none } = fakeLog();
    at.readers = 1;
    at.log = DRAIN;
    rule.tick(false, none);
    at.now = DRAIN_MS;
    rule.mayStart(none);
    at.readers = 0;
    for (at.now = DRAIN_MS + MINUTE; at.now <= DRAIN_MS + BEHIND_MS; at.now += MINUTE) {
      at.flight = 1;
      rule.tick(false, none);
    }
    expect(need).toEqual([]);
    expect(at.log).toBe(0);
    expect(waits.at(-1)).toBe(TURN);
  });

  it("raises no need for two drains held from outside under ten minutes apart", () => {
    const { at, need, rule, none } = fakeLog();
    at.readers = 1;
    at.log = DRAIN;
    rule.tick(false, none);
    at.now = DRAIN_MS;
    rule.mayStart(none);
    at.log = 2 * DRAIN;
    rule.tick(false, none);
    at.now += DRAIN_MS;
    rule.mayStart(none);
    expect(need).toEqual([]);
  });
});

describe("a need taken up at the start", () => {
  it("ends when the log is emptied, and is never raised again meanwhile", () => {
    const { at, need, rule, none } = fakeLog(5 * MINUTE);
    at.readers = 1;
    at.log = DRAIN;
    at.now = 30 * MINUTE;
    rule.tick(false, none);
    at.now += DRAIN_MS;
    rule.mayStart(none);
    expect(need).toEqual([]);
    at.readers = 0;
    at.log = 2 * DRAIN;
    rule.tick(false, none);
    expect(need).toEqual([null]);
  });

  it("ends at the first tick that finds the log under the try's mark", () => {
    const { at, need, waits, rule, none } = fakeLog(5 * MINUTE);
    at.log = 12;
    rule.tick(false, none);
    expect([need, waits]).toEqual([[null], []]);
  });
});

describe("the copy", () => {
  it("a try with RESIDUE_PAGES or more left to copy sends one copy, and the thread neither looks nor truncates until it answers; then a truncate of what the commits meanwhile left", () => {
    const { at, waits, calls, rule, none, write, answer } = fakeLog();
    write(TRY);
    rule.tick(false, none);
    expect(calls).toEqual(["look", "copy"]);
    rule.tick(true, none);
    rule.tick(false, new Set([1]));
    expect(rule.mayStart(new Set([1]))).toBe(true);
    write(10);
    expect(calls).toEqual(["look", "copy"]);
    answer();
    expect(calls).toEqual(["look", "copy", "look", "truncate"]);
    expect([waits, at.log]).toEqual([[0], 0]);
  });

  it("a try with under RESIDUE_PAGES left truncates at once, sending no copy", () => {
    const { at, calls, rule, none, write } = fakeLog();
    at.log = TRY;
    write(RESIDUE_PAGES - 1);
    rule.tick(false, none);
    expect(calls).toEqual(["look", "truncate"]);
    expect(at.log).toBe(0);
  });

  it("a copy that copied all it saw while the commits left RESIDUE_PAGES more asks another, and one that moved nothing ends the try as a failed truncate would, with none", () => {
    const { at, waits, calls, began, rule, none, write, answer } = fakeLog();
    write(TRY);
    rule.tick(false, none);
    write(RESIDUE_PAGES);
    answer();
    expect(calls).toEqual(["look", "copy", "look", "copy"]);
    answer();
    expect([calls.at(-1), at.log]).toEqual(["truncate", 0]);
    at.readers = 1;
    at.pinned = true;
    write(DRAIN);
    rule.tick(false, none);
    answer();
    expect(waits).toEqual([0]);
    expect(began).toEqual([{ frames: DRAIN, jobs: 0 }]);
  });

  it("a lost copy is a failed try: no tick sends another until the log grows as many frames again", () => {
    const { at, calls, rule, none, write, answer, lose } = fakeLog();
    write(TRY);
    rule.tick(false, none);
    lose();
    expect(calls).toEqual(["look", "copy", "look"]);
    rule.tick(false, none);
    expect(calls).toEqual(["look", "copy", "look", "look"]);
    write(TRY);
    rule.tick(false, none);
    expect(calls.at(-1)).toBe("copy");
    answer();
    expect(at.log).toBe(0);
  });

  it("a copy closed by a hold or the stop is no try: nothing settles, and the next tick sends another", () => {
    const { at, calls, rule, none, write, answer, close } = fakeLog();
    write(TRY);
    rule.tick(false, none);
    close();
    expect(calls).toEqual(["look", "copy"]);
    rule.tick(false, none);
    expect(calls).toEqual(["look", "copy", "look", "copy"]);
    answer();
    expect(at.log).toBe(0);
  });
});

describe("a drain through the copier", () => {
  const pinnedDrain = (running: ReadonlySet<number>) => {
    const log = fakeLog();
    log.at.readers = 1;
    log.at.pinned = true;
    log.write(DRAIN);
    log.rule.tick(false, running);
    log.answer(running);
    expect(log.began).toEqual([{ frames: DRAIN, jobs: running.size }]);
    log.calls.length = 0;
    return log;
  };

  it("each job's end sends a copy, jobs wait while it is out, and the drain ends emptied once a copy and a truncate go through", () => {
    const { at, waits, calls, drains, rule, answer } = pinnedDrain(new Set([1, 2]));
    expect(rule.mayStart(new Set([1, 2]))).toBe(false);
    expect(calls).toEqual([]);
    at.now = 10_000;
    expect(rule.mayStart(new Set([2]))).toBe(false);
    expect(calls).toEqual(["look", "copy"]);
    expect(rule.mayStart(new Set([2]))).toBe(false);
    answer(new Set([2]));
    expect(drains).toEqual([]);
    at.readers = 0;
    at.pinned = false;
    at.now = 20_000;
    expect(rule.mayStart(new Set())).toBe(false);
    answer(new Set());
    expect(waits.at(-1)).toBe(TURN);
    expect(drains).toEqual([{ at_ms: 20_000, end: "emptied", ms: 20_000, frames: DRAIN, jobs: 0 }]);
    expect(rule.mayStart(new Set([3]))).toBe(true);
  });

  it("its bound ends it while a copy is out, outlasted with a job running, and the late answer is a try of its own that begins no drain behind that job", () => {
    const { at, began, drains, rule, answer } = pinnedDrain(new Set([5]));
    expect(rule.mayStart(new Set([6]))).toBe(false);
    at.now = DRAIN_MS;
    expect(rule.mayStart(new Set([6]))).toBe(true);
    expect(drains).toEqual([{ at_ms: DRAIN_MS, end: "outlasted", ms: DRAIN_MS, frames: DRAIN, jobs: 1 }]);
    answer(new Set([6]));
    expect(began.length).toBe(1);
  });

  it("its bound ends it while a copy is out, from outside with none running", () => {
    const { at, drains, rule } = pinnedDrain(new Set());
    expect(rule.mayStart(new Set())).toBe(false);
    at.now = DRAIN_MS;
    expect(rule.mayStart(new Set())).toBe(true);
    expect(drains.map((drain) => drain.end)).toEqual(["outside"]);
  });

  it("a lost copy in a drain is a failed try: its bound ends the drain from outside, and lost tries raise the need at ten minutes as held ones do", () => {
    const { at, calls, drains, need, rule, none, answer, lose } = pinnedDrain(new Set());
    expect(rule.mayStart(none)).toBe(false);
    lose();
    expect(rule.mayStart(none)).toBe(false);
    expect(calls).toEqual(["look", "copy", "look", "look", "copy"]);
    expect(drains).toEqual([]);
    at.now = DRAIN_MS;
    lose();
    expect(drains.map((drain) => drain.end)).toEqual(["outside"]);
    at.now = DRAIN_MS + BEHIND_MS;
    rule.tick(false, none);
    lose();
    expect(need).toEqual([DRAIN_MS]);
    at.readers = 0;
    at.pinned = false;
    at.now += MINUTE;
    rule.tick(false, none);
    answer();
    expect(need).toEqual([DRAIN_MS, null]);
  });
});
