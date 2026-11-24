import { describe, expect, it } from "vitest";
import type { RecordRef, Type } from "@lifestreamprotocol/core";
import { compile, decide, earliest, numbered, opensAt, parseAccess, parseDraft, resolve, scrub, widens, AccessError, type Access, type Allow, type DraftAccess, type Gate, type Reach, type Thing, type Window } from "./access.js";

const NOW = Date.UTC(2026, 10, 13, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const WORK = "gmail:person-a@example.com";
const HOME = "gmail:person-b@example.com";
const CHAT = "whatsapp:15550000001";
const HEALTH = "whoop:person-a@example.com";
const ODD = "oddity:0001";
const CATEGORY: Record<string, Type | null> = { [WORK]: "mail", [HOME]: "mail", [CHAT]: "messages", [HEALTH]: "health", [ODD]: null };
const category = (account: string) => CATEGORY[account] ?? null;
const HOME_ACCOUNTS = Object.entries(CATEGORY).map(([account, category]) => ({ account, category }));

function access(parts: Partial<Access>): Access {
  return { allow: [], items: [], not: [], only: [], window: null, hide: "names", shown: [], ...parts };
}
function allow(reach: Reach, window: Window = null, until_ms: number | null = null): Allow {
  return { reach, window, until_ms };
}
const ALL: Reach = { all: true, but: [] };
function ref(account: string, key: string): RecordRef {
  return { source: `${account}:mac`, kind: "item", key };
}
function thing(accounts: string | string[], start_ms: number | null): Thing {
  return { accounts: typeof accounts === "string" ? [accounts] : accounts, start_ms };
}
function gateOf(lines: Access, now_ms = NOW): Gate {
  const gate = compile(lines, now_ms, category);
  if (gate === null) throw new Error("a full access has no gate");
  return gate;
}
function judge(lines: Access, judged: Thing | null, now_ms = NOW) {
  const gate = compile(lines, now_ms, category);
  return gate === null ? FULL : decide(gate, judged);
}
const FULL = { allowed: true, line: 1, why: "allowed" };
const allowed = (line: number | null) => ({ allowed: true, line, why: "allowed" });
const withheld = (line: number | null, why: string) => ({ allowed: false, line, why });

const UNRESOLVED: (Thing | null)[] = [null, thing([], NOW), thing([], null)];

function expectNoRelaxing(before: Access, after: Access): void {
  const known = [WORK, HOME, CHAT, HEALTH, ODD].flatMap((account) => [thing(account, NOW), thing(account, null), thing([account, CHAT], NOW - HOUR)]);
  for (const now_ms of [NOW, NOW + 2 * HOUR]) {
    for (const each of [...UNRESOLVED, ...known]) {
      if (judge(after, each, now_ms).allowed) expect({ before, after, now_ms, each, allowed: judge(before, each, now_ms).allowed }).toMatchObject({ allowed: true });
    }
  }
}

describe("decide", () => {
  it("a window holds from its first millisecond; a thing with no time only where no window applies", () => {
    const lines = access({ allow: [allow({ type: "mail", but: [] })], window: { past_ms: DAY } });
    expect(judge(lines, thing(WORK, NOW - DAY))).toEqual(allowed(1));
    expect(judge(lines, thing(WORK, NOW - DAY - 1))).toEqual(withheld(2, "window"));
    expect(judge(lines, thing(WORK, null))).toEqual(withheld(2, "window"));
    const since = access({ allow: [allow({ type: "mail", but: [] }, { since_ms: NOW - DAY })] });
    expect(judge(since, thing(WORK, NOW - DAY))).toEqual(allowed(1));
    expect(judge(since, thing(WORK, null))).toEqual(withheld(null, "no-line"));
    const accounts = access({ allow: [allow({ account: WORK, but: [] }), allow({ account: CHAT, but: [] })] });
    expect(judge(accounts, thing(WORK, null))).toEqual(allowed(1));
  });

  it("the access's window holds over a looser line's", () => {
    const lines = access({ allow: [allow({ type: "mail", but: [] }, { past_ms: 7 * DAY })], window: { past_ms: DAY } });
    expect(judge(lines, thing(WORK, NOW - 2 * DAY))).toEqual(withheld(2, "window"));
    expect(judge(lines, thing(WORK, NOW - HOUR))).toEqual(allowed(1));
  });

  it("a one-off has ended at its until_ms exactly, and holds a millisecond before", () => {
    const lines = access({ allow: [allow({ account: CHAT, but: [] }, null, NOW)] });
    expect(judge(lines, thing(CHAT, NOW - HOUR), NOW)).toEqual(withheld(null, "no-line"));
    expect(judge(lines, thing(CHAT, NOW - HOUR), NOW - 1)).toEqual(allowed(1));
  });

  it("a thing of two accounts is allowed only when each is reached at its time, by one allow or two", () => {
    const both = access({ allow: [allow({ type: "mail", but: [] }, { past_ms: DAY }), allow({ type: "messages", but: [] })] });
    expect(judge(both, thing([WORK, CHAT], NOW - HOUR))).toEqual(allowed(null));
    expect(judge(both, thing([WORK, CHAT], NOW - 2 * DAY))).toEqual(withheld(null, "no-line"));
    expect(judge(both, thing([WORK, HOME], NOW - HOUR))).toEqual(allowed(1));
    const mail = access({ allow: [allow({ type: "mail", but: [] }, { past_ms: DAY })] });
    expect(judge(mail, thing([WORK, CHAT], NOW - HOUR))).toEqual(withheld(null, "no-line"));
    const one = access({ allow: [allow({ account: WORK, but: [] })] });
    expect(judge(one, thing([WORK, HOME], NOW))).toEqual(withheld(null, "no-line"));
  });

  it("its line is an allow that reaches every account of the thing, where one does, before one that reaches only some", () => {
    const lines = access({ allow: [allow({ account: WORK, but: [] }), allow({ type: "messages", but: [] }), allow({ all: true, but: ["health"] })] });
    expect(judge(lines, thing([WORK, CHAT], NOW))).toEqual(allowed(3));
    expect(judge(lines, thing(WORK, NOW))).toEqual(allowed(1));
    const windowed = access({ allow: [allow({ account: WORK, but: [] }), allow({ type: "messages", but: [] }), allow({ all: true, but: ["health"] }, { past_ms: DAY })] });
    expect(judge(windowed, thing([WORK, CHAT], NOW - 2 * DAY))).toEqual(allowed(null));
  });

  it("an unresolved thing is allowed only by an open allow, with no window, whatever stands beside it", () => {
    const lines = access({ allow: [allow({ type: "mail", but: [] })] });
    for (const each of UNRESOLVED) expect(judge(lines, each)).toEqual(withheld(null, "unresolved"));
    const open = access({ allow: [allow({ account: CHAT, but: [] }), allow(ALL)] });
    expect(compile(open, NOW, category)).not.toBeNull();
    for (const each of UNRESOLVED) expect(judge(open, each)).toEqual(allowed(2));
    for (const shut of [
      access({ allow: [allow(ALL, { past_ms: DAY })] }), access({ allow: [allow(ALL, null, NOW + HOUR)] }), access({ allow: [allow({ all: true, but: ["health"] })] }),
      access({ allow: [allow(ALL), allow({ account: CHAT, but: [] })], window: { past_ms: DAY } }),
    ]) {
      expect(gateOf(shut).open_line).toBeNull();
      for (const each of UNRESOLVED) expect(judge(shut, each)).toEqual(withheld(null, "unresolved"));
    }
  });

  it("a source with no category: never reached by a category with a but or a type, allowed by its own account line", () => {
    const odd = thing(ODD, NOW);
    expect(judge(access({ allow: [allow({ all: true, but: ["health"] })] }), odd)).toEqual(withheld(null, "no-line"));
    expect(judge(access({ allow: [allow({ type: "mail", but: [] })] }), odd)).toEqual(withheld(null, "no-line"));
    expect(judge(access({ allow: [allow({ all: true, but: ["health"] }), allow({ account: ODD, but: [] })] }), odd)).toEqual(allowed(2));
    expect(judge(access({ allow: [allow(ALL, { past_ms: DAY })] }), odd)).toEqual(allowed(1));
  });

  it("a withholding for two reasons answers window, then no-line", () => {
    const lines = access({ allow: [allow({ type: "mail", but: [] })], window: { past_ms: DAY } });
    expect(judge(lines, thing(CHAT, NOW - 2 * DAY))).toEqual(withheld(2, "window"));
    expect(judge(lines, thing(CHAT, NOW))).toEqual(withheld(null, "no-line"));
  });

  it("each reach leaves out what its but names: an all its categories, a type its accounts", () => {
    const all = access({ allow: [allow({ all: true, but: ["health"] })] });
    expect(judge(all, thing(HEALTH, NOW))).toEqual(withheld(null, "no-line"));
    expect(judge(all, thing(WORK, NOW))).toEqual(allowed(1));
    const type = access({ allow: [allow({ type: "mail", but: [HOME] })] });
    expect(judge(type, thing(HOME, NOW))).toEqual(withheld(null, "no-line"));
    expect(judge(type, thing(WORK, NOW))).toEqual(allowed(1));
  });

  it("lines are numbered each allow, the window, the hiding", () => {
    const lines = access({ allow: [allow(ALL, { past_ms: 7 * DAY }), allow({ account: CHAT, but: [] })], window: { past_ms: DAY } });
    expect(numbered(lines).map((line) => `${line.number} ${line.member} ${line.index}`)).toEqual(["1 allow 0", "2 allow 1", "3 window 0", "4 hide 0"]);
    expect(judge(lines, thing(CHAT, NOW - 2 * DAY))).toEqual(withheld(3, "window"));
    expect(numbered(access({ allow: [allow(ALL)] })).map((line) => line.member)).toEqual(["allow", "hide"]);
  });
});

describe("earliest", () => {
  it("is the first instant a thing of those accounts is allowed: null for all time, never for an account no line reaches", () => {
    const screen = [ODD];
    expect(earliest(gateOf(access({ allow: [allow({ account: ODD, but: [] })] })), screen)).toBeNull();
    expect(earliest(gateOf(access({ allow: [allow({ account: ODD, but: [] }, { past_ms: DAY })] })), screen)).toBe(NOW - DAY);
    expect(earliest(gateOf(access({ allow: [allow({ account: ODD, but: [] }, { past_ms: DAY }), allow(ALL, { past_ms: 3 * DAY })], window: { past_ms: 2 * DAY } })), screen)).toBe(NOW - 2 * DAY);
    expect(earliest(gateOf(access({ allow: [allow({ type: "mail", but: [] })] })), screen)).toBeUndefined();
    const allowedAt = (lines: Access, start_ms: number) => decide(gateOf(lines), { accounts: screen, start_ms }).allowed;
    const lines = access({ allow: [allow({ account: ODD, but: [] }, { since_ms: NOW - 5 * DAY })], window: { past_ms: 7 * DAY } });
    expect(earliest(gateOf(lines), screen)).toBe(NOW - 5 * DAY);
    expect([allowedAt(lines, NOW - 5 * DAY - 1), allowedAt(lines, NOW - 5 * DAY)]).toEqual([false, true]);
  });
});

describe("opensAt", () => {
  it("is the first instant any allow reaches, the access's window bounding it: null for all time", () => {
    expect(opensAt(gateOf(access({ allow: [allow({ type: "mail", but: [] })] })))).toBeNull();
    expect(opensAt(gateOf(access({ allow: [allow({ type: "mail", but: [] }, { past_ms: DAY })] })))).toBe(NOW - DAY);
    expect(opensAt(gateOf(access({ allow: [allow({ type: "mail", but: [] }, { past_ms: DAY }), allow({ account: ODD, but: [] }, { past_ms: 3 * DAY })] })))).toBe(NOW - 3 * DAY);
    expect(opensAt(gateOf(access({ allow: [allow({ type: "mail", but: [] }, { past_ms: 3 * DAY })], window: { past_ms: 2 * DAY } })))).toBe(NOW - 2 * DAY);
    expect(opensAt(gateOf(access({ allow: [allow({ type: "mail", but: [] })], window: { past_ms: 2 * DAY } })))).toBe(NOW - 2 * DAY);
  });
});

describe("compile", () => {
  it("a full access is no gate; with an end, a window, a but or beside a second line it is one", () => {
    const full = access({ allow: [allow(ALL)], hide: "all" });
    expect(compile(full, NOW, category)).toBeNull();
    expect(compile({ ...full, hide: "none" }, NOW, category)).toBeNull();
    for (const limited of [
      access({ allow: [allow(ALL, null, NOW + HOUR)] }), access({ allow: [allow(ALL, { past_ms: DAY })] }), access({ allow: [allow(ALL)], window: { past_ms: DAY } }),
      access({ allow: [allow({ all: true, but: ["health"] })] }), access({ allow: [allow(ALL), allow({ account: ODD, but: [] })] }), access({}),
    ]) expect(compile(limited, NOW, category)).not.toBeNull();
  });

  it("leaves out every ended allow", () => {
    const lines = access({ allow: [allow({ account: WORK, but: [] }, null, NOW), allow({ account: CHAT, but: [] }, null, NOW + 1)] });
    expect(gateOf(lines).allows.map((each) => each.line)).toEqual([2]);
  });
});

describe("widens", () => {
  const base = access({
    allow: [allow({ type: "mail", but: [HOME] }, { past_ms: 7 * DAY }, NOW + HOUR), allow({ account: CHAT, but: [] }, { since_ms: NOW - 7 * DAY })],
    window: { past_ms: 30 * DAY }, hide: ["phone", "email"],
  });
  const change = (edit: (copy: Access) => void) => {
    const copy = structuredClone(base);
    edit(copy);
    return widens(base, copy, HOME_ACCOUNTS);
  };

  it("narrows by each narrowing row of the table", () => {
    expect(change(() => {})).toBe(false);
    expect(change((a) => a.allow.pop())).toBe(false);
    expect(change((a) => (a.allow[0]!.reach as { but: string[] }).but.push(WORK))).toBe(false);
    expect(change((a) => { a.allow[0]!.window = { past_ms: DAY }; })).toBe(false);
    expect(change((a) => { a.allow[1]!.window = { since_ms: NOW - DAY }; })).toBe(false);
    expect(change((a) => { a.allow[0]!.until_ms = NOW; })).toBe(false);
    expect(change((a) => { a.window = { past_ms: DAY }; })).toBe(false);
    expect(change((a) => { a.hide = ["phone", "email", "address"]; })).toBe(false);
    expect(change((a) => { a.hide = "all"; })).toBe(false);
  });

  it("widens by each widening row of the table", () => {
    expect(change((a) => a.allow.push(allow({ account: HEALTH, but: [] })))).toBe(true);
    expect(change((a) => { (a.allow[0]!.reach as { but: string[] }).but = []; })).toBe(true);
    expect(change((a) => { a.allow[1]!.reach = { type: "messages", but: [] }; })).toBe(true);
    expect(change((a) => { a.allow[0]!.window = { past_ms: 8 * DAY }; })).toBe(true);
    expect(change((a) => { a.allow[0]!.window = null; })).toBe(true);
    expect(change((a) => { a.allow[0]!.until_ms = NOW + 2 * HOUR; })).toBe(true);
    expect(change((a) => { a.allow[0]!.until_ms = null; })).toBe(true);
    expect(change((a) => { a.window = { past_ms: 31 * DAY }; })).toBe(true);
    expect(change((a) => { a.window = null; })).toBe(true);
    expect(change((a) => { a.hide = ["phone"]; })).toBe(true);
    expect(change((a) => { a.hide = "none"; })).toBe(true);
    expect(change((a) => { a.hide = "names"; })).toBe(false);
  });

  it("places a narrower reach under a wider one, an account by its category on the home", () => {
    const from = (reach: Reach, to: Reach, accounts = HOME_ACCOUNTS) => widens(access({ allow: [allow(reach)] }), access({ allow: [allow(to)] }), accounts);
    expect(from(ALL, { type: "mail", but: [] })).toBe(false);
    expect(from(ALL, { account: ODD, but: [] })).toBe(false);
    expect(from({ all: true, but: ["health"] }, { type: "mail", but: [] })).toBe(false);
    expect(from({ all: true, but: ["health"] }, { all: true, but: ["health", "money"] })).toBe(false);
    expect(from({ all: true, but: ["mail"] }, { type: "mail", but: [] })).toBe(true);
    expect(from({ all: true, but: ["health"] }, { account: WORK, but: [] })).toBe(false);
    expect(from({ type: "mail", but: [] }, { account: WORK, but: [] })).toBe(false);
    expect(from({ type: "mail", but: [HOME] }, { account: WORK, but: [] })).toBe(false);
    expect(from({ account: WORK, but: [] }, { account: WORK, but: [] })).toBe(false);
    expect(from({ account: WORK, but: [] }, { account: HOME, but: [] })).toBe(true);
    expect(from({ all: true, but: ["health"] }, { account: HEALTH, but: [] })).toBe(true);
    expect(from({ all: true, but: ["health"] }, { account: ODD, but: [] })).toBe(true);
    expect(from({ all: true, but: ["health"] }, { account: "gmail:person-c@example.com", but: [] })).toBe(true);
    expect(from({ type: "mail", but: [HOME] }, { account: HOME, but: [] })).toBe(true);
    expect(from({ type: "mail", but: [] }, { account: CHAT, but: [] })).toBe(true);
    expect(from({ type: "mail", but: [] }, { all: true, but: ["health"] })).toBe(true);
    expect(from({ all: true, but: ["health"] }, { account: WORK, but: [] }, [])).toBe(true);
    expect(from({ type: "mail", but: [] }, { account: WORK, but: [] }, [])).toBe(true);
  });

  it("an open grant split by turning one account off narrows: the editor's Off, each piece inside what was", () => {
    const before = access({ allow: [allow({ all: true, but: ["health", "money"] }, { past_ms: 7 * DAY }, NOW + HOUR)] });
    const after = access({ allow: [
      allow({ all: true, but: ["health", "mail", "money"] }, { past_ms: 7 * DAY }, NOW + HOUR),
      allow({ type: "mail", but: [HOME] }, { past_ms: 7 * DAY }, NOW + HOUR),
    ] });
    expect(widens(before, after, HOME_ACCOUNTS)).toBe(false);
    expectNoRelaxing(before, after);
    expect(widens(before, { ...after, allow: [...after.allow, allow({ account: HOME, but: [] }, null, NOW + HOUR)] }, HOME_ACCOUNTS)).toBe(true);
  });

  it("removing a line never relaxes an unresolved thing: a second allow beside an open one", () => {
    const openAndAccount = access({ allow: [allow(ALL), allow({ account: CHAT, but: [] })] });
    expect(widens(openAndAccount, access({ allow: [allow(ALL)] }), HOME_ACCOUNTS)).toBe(false);
    expectNoRelaxing(openAndAccount, access({ allow: [allow(ALL)] }));
    expect(judge(openAndAccount, null)).toEqual(allowed(1));
  });

  it("widens on a value it cannot compare", () => {
    const lines = access({ allow: [allow(ALL)], window: { since_ms: NOW - DAY } });
    expect(widens(lines, { ...lines, window: { past_ms: HOUR } }, HOME_ACCOUNTS)).toBe(true);
    expect(widens(lines, { ...lines, allow: [{ ...lines.allow[0], area: "x" }] }, HOME_ACCOUNTS)).toBe(true);
    expect(widens(lines, { ...lines, window: undefined }, HOME_ACCOUNTS)).toBe(true);
    expect(widens(lines, { ...lines, not: [{ id: "person-x", handles: [] }] }, HOME_ACCOUNTS)).toBe(true);
    expect(widens("nothing", lines, HOME_ACCOUNTS)).toBe(true);
  });

  it("a change it calls narrowing allows nothing the access before it withheld, over a fixed table of things", () => {
    const random = seeded(1);
    const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
    const REACHES: Reach[] = [
      ALL, { all: true, but: ["health"] }, { all: true, but: ["mail", "health"] }, { type: "mail", but: [] }, { type: "mail", but: [HOME] },
      { type: "messages", but: [] }, { account: CHAT, but: [] }, { account: ODD, but: [] }, { account: WORK, but: [] },
    ];
    const WINDOWS: Window[] = [null, { since_ms: NOW - 2 * DAY }, { since_ms: NOW - 5 * DAY }, { past_ms: DAY }, { past_ms: 3 * DAY }];
    const UNTILS = [null, NOW - 1, NOW + HOUR, NOW + 2 * HOUR];
    const ACCOUNTS = [WORK, HOME, CHAT, HEALTH, ODD];
    const randomAllow = () => allow(structuredClone(pick(REACHES)), pick(WINDOWS), pick(UNTILS));
    const randomAccess = (): Access => access({ allow: Array.from({ length: Math.floor(random() * 4) }, randomAllow), window: pick(WINDOWS) });
    const MUTATIONS: ((a: Access) => void)[] = [
      (a) => a.allow.splice(Math.floor(random() * a.allow.length), 1),
      (a) => a.allow.push(randomAllow()),
      (a) => { if (a.allow.length > 0) pick(a.allow).window = pick(WINDOWS); },
      (a) => { if (a.allow.length > 0) pick(a.allow).until_ms = pick(UNTILS); },
      (a) => { const each = a.allow.length > 0 ? pick(a.allow) : undefined; if (each && !("account" in each.reach)) (each.reach.but as string[]).push(pick([HOME, WORK, "mail", "messages"]) as never); },
      (a) => { if (a.allow.length > 0) pick(a.allow).reach = structuredClone(pick(REACHES)); },
      (a) => { a.window = pick(WINDOWS); },
    ];
    const THINGS: (Thing | null)[] = [...UNRESOLVED];
    const TIMES = [NOW - HOUR, NOW - 2 * DAY - 1, NOW - 4 * DAY, NOW - 10 * DAY, null];
    for (let index = 0; index < 300; index++) {
      THINGS.push(thing([...new Set(Array.from({ length: 1 + Math.floor(random() * 2) }, () => pick(ACCOUNTS)))], pick(TIMES)));
    }
    let narrowed = 0;
    let widened = 0;
    for (let round = 0; round < 1500; round++) {
      const before = randomAccess();
      const after = structuredClone(before);
      for (let step = 0; step < 1 + Math.floor(random() * 2); step++) pick(MUTATIONS)(after);
      if (widens(before, after, HOME_ACCOUNTS)) {
        widened++;
        continue;
      }
      narrowed++;
      for (const now_ms of [NOW, NOW + 90 * 60_000, NOW + 3 * DAY]) {
        for (const each of THINGS) {
          if (judge(after, each, now_ms).allowed) expect({ before, after, now_ms, each, allowed: judge(before, each, now_ms).allowed }).toMatchObject({ allowed: true });
        }
      }
    }
    expect(THINGS.some((each) => each !== null && each.accounts.length > 1)).toBe(true);
    expect(narrowed).toBeGreaterThan(200);
    expect(widened).toBeGreaterThan(200);
  });
});

describe("scrub", () => {
  const lines = access({
    allow: [allow({ all: true, but: ["health"] }), allow({ account: CHAT, but: [] }), allow({ type: "mail", but: [WORK] }), allow({ account: HOME, but: [] })],
  });

  it("takes an allow naming an erased account, in its reach or its but, whole; never widens", () => {
    const account = scrub({ accounts: [WORK] });
    const one = account.access(lines as never);
    expect(one.went).toEqual({ lines: [3] });
    expect(account.names(lines as never)).toBe(true);
    expect(account.names(one.lines)).toBe(false);
    expect(widens(lines, one.lines, HOME_ACCOUNTS)).toBe(false);
    expectNoRelaxing(lines, one.lines as unknown as Access);

    const chat = scrub({ accounts: [CHAT] });
    const two = chat.access(lines as never);
    expect(two.went).toEqual({ lines: [2] });
    expect((two.lines as unknown as Access).allow.map((each) => each.reach)).toEqual([{ all: true, but: ["health"] }, { type: "mail", but: [WORK] }, { account: HOME, but: [] }]);
    expect(widens(lines, two.lines, HOME_ACCOUNTS)).toBe(false);
    expectNoRelaxing(lines, two.lines as unknown as Access);
  });

  it("taking an erased account's allow from beside an open one relaxes nothing unresolved", () => {
    const before = access({ allow: [allow(ALL), allow({ account: CHAT, but: [] })] });
    const after = scrub({ accounts: [CHAT] }).access(before as never);
    expect(after.went).toEqual({ lines: [2] });
    expect(widens(before, after.lines, HOME_ACCOUNTS)).toBe(false);
    for (const each of UNRESOLVED) expect(judge(after.lines as unknown as Access, each).allowed).toBe(judge(before, each).allowed);
  });

  it("leaves lines that name nothing erased as they are, a record included: an access names none", () => {
    const none = scrub({ records: [ref(CHAT, "zz")], accounts: ["oddity:none"] });
    expect(none.access(lines as never)).toEqual({ lines, went: null });
    expect(none.names(lines as never)).toBe(false);
  });

  it("finds an erased identity in a want, an account, a source and a call's read", () => {
    const erased = scrub({ accounts: [WORK], records: [ref(HEALTH, "s")] });
    expect(erased.names({ read: { account: WORK }, past: "1h" })).toBe(true);
    expect(erased.names(`${WORK}:mac`)).toBe(true);
    expect(erased.names(WORK)).toBe(true);
    expect(erased.names([{ source: `${HEALTH}:mac`, kind: "item", key: "s" }])).toBe(true);
    expect(erased.names({ read: { category: "mail" } })).toBe(false);
    expect(erased.names({ read: { account: CHAT } })).toBe(false);
    expect(erased.names({ lines: [3] })).toBe(false);
  });

  it("refuses lines that are no access", () => {
    expect(() => scrub({ accounts: [WORK] }).access({ allow: [] })).toThrow(AccessError);
  });
});

describe("parseAccess", () => {
  const good = access({
    allow: [allow({ all: true, but: ["health", "money"] }), allow({ type: "mail", but: [HOME] }, { past_ms: HOUR }, NOW), allow({ account: CHAT, but: [] })],
    window: { since_ms: 0 }, hide: ["phone", "number.card"],
  });
  const refused = (value: unknown, words: RegExp) => expect(() => parseAccess(value)).toThrow(words);

  it("reads every member of a good access as it is", () => {
    expect(parseAccess(JSON.parse(JSON.stringify(good)))).toEqual(good);
  });

  it("reads a stored row of the first release unchanged", () => {
    const row = `{"allow":[{"reach":{"all":true,"but":["health","money"]},"window":null,"until_ms":null}],"hide":"names","items":[],"not":[],"only":[],"shown":[],"window":null}`;
    expect(parseAccess(JSON.parse(row))).toEqual(JSON.parse(row));
  });

  it("refuses each member the first release does not hold, by name", () => {
    refused({ ...good, items: [ref(CHAT, "r")] }, /^items must be empty$/u);
    refused({ ...good, not: [{ id: "person-sam", handles: ["phone:+15550000002"] }] }, /^not must be empty$/u);
    refused({ ...good, only: [{ id: "person-sam", handles: ["phone:+15550000002"] }] }, /^only must be empty$/u);
    refused({ ...good, shown: [{ detail: "k", until_ms: null }] }, /^shown must be empty$/u);
    refused({ ...good, allow: [allow({ conversation: "c1", account: CHAT } as never)] }, /^allow 0's reach is all, a type or an account$/u);
    refused({ ...good, allow: [allow({ account: CHAT, but: ["c1"] } as never)] }, /^allow 0's reach's but must be empty$/u);
    refused({ ...good, items: null }, /items is a list/u);
  });

  it("refuses an unknown member, a missing one, and a value it cannot evaluate, by name", () => {
    refused({ ...good, area: [] }, /an access has no member area/u);
    refused({ ...good, allow: [{ ...good.allow[0], kinds: [] }] }, /allow 0 has no member kinds/u);
    const { window: _window, ...missing } = good;
    refused(missing, /an access has window/u);
    refused({ ...good, allow: [allow({ type: "pets" as Type, but: [] })] }, /a category/u);
    refused({ ...good, allow: [allow({ account: "gmail", but: [] })] }, /an account, <product>:<account>/u);
    refused({ ...good, allow: [allow({ type: "mail", but: [HOME, HOME] })] }, /names each once/u);
    refused({ ...good, window: { past_ms: 0 } }, /more than 0/u);
    refused({ ...good, window: { since_ms: -1 } }, /milliseconds/u);
    refused({ ...good, window: { since_ms: 1.5 } }, /milliseconds/u);
    refused({ ...good, hide: [] }, /one at least/u);
    refused({ ...good, hide: ["ref"] }, /a detail type/u);
    refused({ ...good, hide: "some" }, /all, names, none/u);
    refused({ ...good, allow: [{ reach: { account: "gmail:a/b", but: [] }, window: null, until_ms: null }] }, /is an account, <product>:<account>, with no slash/u);
    refused(null, /is an object/u);
  });
});

describe("a draft", () => {
  const draft: DraftAccess = {
    ...access({ hide: "all" }),
    allow: [{ reach: { type: "mail", but: [] }, window: null, until_ms: NOW + HOUR }, { reach: { account: WORK, but: [] }, window: { past_ms: DAY }, lasts_ms: HOUR }],
  };

  it("reads a grant's end as an instant or a span from the write, never both, never a span of no time", () => {
    expect(parseDraft(JSON.parse(JSON.stringify(draft)))).toEqual(draft);
    expect(() => parseDraft({ ...draft, allow: [{ reach: ALL, window: null, until_ms: null, lasts_ms: HOUR }] })).toThrow(/allow 0 has until_ms or lasts_ms, never both/u);
    expect(() => parseDraft({ ...draft, allow: [{ reach: ALL, window: null, lasts_ms: 0 }] })).toThrow(/allow 0's lasts_ms is more than 0/u);
    expect(() => parseDraft({ ...draft, allow: [{ reach: ALL, window: null, lasts_ms: -HOUR }] })).toThrow(/allow 0's lasts_ms is milliseconds/u);
    expect(() => parseDraft({ ...draft, allow: [{ reach: ALL, window: null, lasts_ms: Number.MAX_SAFE_INTEGER }] })).toThrow(/allow 0's lasts_ms is at most/u);
    expect(() => parseDraft({ ...draft, allow: [{ reach: ALL, window: null }] })).toThrow(/allow 0 has until_ms/u);
    expect(() => parseDraft({ ...draft, not: [{ id: "person-sam", handles: [] }] })).toThrow(/^not must be empty$/u);
  });

  it("is no access while a span stands: a stored access never holds one", () => {
    expect(() => parseAccess(draft)).toThrow(/allow 1 has no member lasts_ms/u);
    expect(parseAccess(resolve(draft, NOW))).toEqual(resolve(draft, NOW));
    expect(widens(access({}), draft, HOME_ACCOUNTS)).toBe(true);
  });

  it("resolves each span at the write's clock and keeps every instant", () => {
    const later = NOW + 5 * HOUR;
    expect(resolve(draft, later)).toEqual({
      ...access({ hide: "all" }),
      allow: [{ reach: { type: "mail", but: [] }, window: null, until_ms: NOW + HOUR }, { reach: { account: WORK, but: [] }, window: { past_ms: DAY }, until_ms: later + HOUR }],
    });
    const fixed = resolve(draft, NOW);
    expect(resolve(fixed, later)).toEqual(fixed);
  });
});

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
