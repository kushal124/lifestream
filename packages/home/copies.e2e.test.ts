import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openHomeFolder, wantedOf, type Drawn, type Piece } from "@lifestreamprotocol/core";
import { openLedger, type Ledger } from "@lifestreamprotocol/model";
import { levelOf, openHider, readPrivacySettings, type NameTable, type Pictures, type PrivacySettings } from "@lifestreamprotocol/privacy";
import { AUDIO_LINE, openCopies, type CopyAsked } from "./copies.js";

const NAMES: NameTable = {
  version: "people-1", owner: null,
  people: [{ who: "p-ada", is: "human", shown: "Ada Example", names: ["Ada Example"], accounts: ["person-a@example.com", "+15550000001"] }],
};
const PRIVACY: PrivacySettings = readPrivacySettings({});
const UNREADABLE = `sha256:${"b".repeat(64)}`;
const PHOTO = `sha256:${"a".repeat(64)}`;
let whileRead: () => void = () => undefined;
const pictures: Pictures = {
  async read(blob) {
    whileRead();
    if (blob === UNREADABLE) return { cannot: "This picture cannot be read" };
    return { lines: [{ words: [{ text: "Ada", box: { x: 1, y: 1, width: 10, height: 4 } }, { text: "Example", box: { x: 12, y: 1, width: 20, height: 4 } }] }], faces: [] };
  },
  async make(recipe) {
    return { jpeg: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), recipe: { ...recipe, covered: recipe.covered.map((face) => ({ ...face, colour: face.colour ?? "#808080" })), engine: "fake-1" } };
  },
};

const roots: string[] = [];
afterEach(() => {
  whileRead = () => undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function copiesOver(names: () => NameTable | undefined = () => NAMES) {
  const root = mkdtempSync(join(tmpdir(), "home-copies-"));
  roots.push(root);
  const ledger: Ledger = openLedger(openHomeFolder(root), { mode: "migrate" });
  const hider = openHider({
    people: names, settings: () => PRIVACY, pictures,
    detector: { find: () => Promise.reject(new Error("no detector here")), state: () => ({ state: "absent", why: "off" }) },
    marks: { id: "", epoch: "", read: () => new Map(), write: () => false, dropOthers: async () => 0, forget: () => 0, close: () => undefined },
  });
  const copies = openCopies({ ledger, hider: () => hider, clock: () => 1_000 });
  return { root, ledger, copies };
}

const PIECES: Piece[] = [{ text: "Describe this synthetic note.\n\n" }, { text: "Lunch with Ada Example; write to person-a@example.com or call +15550000001.", free: true }];
const asked = (more: Partial<CopyAsked> = {}): CopyAsked => ({
  op: "copy", key: "sha256:req-1", revision: "sha256:req-1", pieces: PIECES, attachments: [], receiver: "Example AI", route: "fake:fake-model", level: "all", epoch: 0, ...more,
});

describe("a work's level", () => {
  it("is its connector's member, `default` and a broken one following privacy.level, and the home's for a work of no connector", () => {
    const settings = (member?: string) => ({ privacy: { ...PRIVACY, level: "none" as const }, connectors: { "fake-poll": member === undefined ? {} : { "privacy.photos": member } } });
    expect(levelOf(settings("names"), "fake-poll/photos")).toBe("names");
    expect(levelOf(settings("default"), "fake-poll/photos")).toBe("none");
    expect(levelOf(settings(), "fake-poll/photos")).toBe("none");
    expect(levelOf(settings("everything"), "fake-poll/photos")).toBe("none");
    expect(levelOf(settings("all"), null)).toBe("none");
  });
});

describe("a sent copy", () => {
  it("holds the ask hidden under its level and its table, and a retry names the same person by the same placeholder", async () => {
    const { ledger, copies } = copiesOver();
    try {
      const made = await copies.make(asked());
      expect("copy" in made).toBe(true);
      const copy = ledger.sent.get((made as { copy: number }).copy)!;
      expect(copy.body).toBe("Describe this synthetic note.\n\nLunch with [[Person 1]]; write to [[Email 1]] or call [[Phone 1]].");
      expect(copy).toMatchObject({ key: "sha256:req-1", receiver: "Example AI", route: "fake:fake-model", level: "all", counts: { person: 1, email: 1, phone: 1 }, detector: null, written: null });
      const named = ledger.sent.get((await copies.make(asked({ key: "sha256:req-2", level: "names" })) as { copy: number }).copy)!;
      expect(named.body).toBe("Describe this synthetic note.\n\nLunch with Ada Example; write to [[Email 1]] or call [[Phone 1]].");
      const retry = ledger.sent.get((await copies.make(asked({ key: "sha256:req-3", pieces: [...PIECES, { text: "\n\nAgain: Ada Example.", free: true }] })) as { copy: number }).copy)!;
      expect(retry.body).toContain("Again: [[Person 1]].");
    } finally {
      ledger.close();
    }
  });

  it("under `none` holds no body and waits on nothing; a sound or an unreadable picture under a level that hides is never sent, and says why", async () => {
    const { ledger, copies } = copiesOver(() => undefined);
    try {
      const none = await copies.make(asked({ level: "none" }));
      expect(ledger.sent.get((none as { copy: number }).copy)).toMatchObject({ level: "none", body: null, pictures: [], counts: {} });
      expect(await copies.make(asked())).toEqual({ wait: expect.any(String) });
      expect(ledger.placeholders.part("ask:sha256:req-1", wantedOf([])).table.entries).toEqual([]);
    } finally {
      ledger.close();
    }
    const ready = copiesOver();
    try {
      expect(await ready.copies.make(asked({ attachments: [{ blob: PHOTO, media_type: "audio/m4a" }] }))).toEqual({ cannot: AUDIO_LINE });
      expect(await ready.copies.make(asked({ attachments: [{ blob: UNREADABLE, media_type: "image/jpeg" }] }))).toEqual({ cannot: "This picture cannot be read" });
    } finally {
      ready.ledger.close();
    }
  });

  it("covers what a picture's words name, keeps its JPEG as a file of the copy alone while it may be sent, and its recipe", async () => {
    const { root, ledger, copies } = copiesOver();
    try {
      const made = await copies.make(asked({ attachments: [{ blob: PHOTO, media_type: "image/jpeg" }] }));
      const id = (made as { copy: number }).copy;
      const copy = ledger.sent.get(id)!;
      expect(copy.pictures).toHaveLength(1);
      const [recipe] = copy.pictures as [{ blob: string; filled: unknown[]; engine: string }];
      expect(recipe).toMatchObject({ blob: PHOTO, engine: "fake-1" });
      expect(recipe.filled).toHaveLength(2);
      expect(ledger.sent.files(id).map((file) => file.path)).toEqual([join(root, "replies", "sent", String(id), "0.jpg")]);
      expect(ledger.sent.files(id)[0]!.exists()).toBe(true);
    } finally {
      ledger.close();
    }
  });

  it("covers a photo's drawn faces under their tags where its level hides faces, frames them where it leaves faces, and sends the ask's own words as written", async () => {
    const { ledger, copies } = copiesOver();
    const drawn: Drawn[] = [{ placeholder: "[[Person 1]]", box: { x: 10, y: 10, width: 40, height: 50 } }, { placeholder: "[[Person 2]]", box: { x: 90, y: 10, width: 40, height: 50 } }];
    const pieces: Piece[] = [{ text: "Write [[Person 1]] for the face tagged P1.\n\n" }, { text: "Lunch with Ada Example.", free: true }];
    try {
      const scope = "ask:sha256:req-1";
      ledger.placeholders.save(ledger.placeholders.part(scope, wantedOf([])), {
        scope, entries: drawn.map((face) => ({ placeholder: face.placeholder, type: "person", detail: "", face: face.box })), next: { person: 3 },
      });
      const all = ledger.sent.get((await copies.make(asked({ pieces, attachments: [{ blob: PHOTO, media_type: "image/jpeg", drawn }] })) as { copy: number }).copy)!;
      expect(all.body).toBe("Write [[Person 1]] for the face tagged P1.\n\nLunch with [[Person 3]].");
      const [covered] = all.pictures as [{ covered: { placeholder?: string }[]; written: unknown[] }];
      expect(covered.covered.map((face) => face.placeholder)).toEqual(["[[Person 1]]", "[[Person 2]]"]);
      expect(covered.written).toEqual([]);
      const named = ledger.sent.get((await copies.make(asked({ key: "sha256:req-2", level: "names", pieces, attachments: [{ blob: PHOTO, media_type: "image/jpeg", drawn }] })) as { copy: number }).copy)!;
      expect(named.body).toBe("Write [[Person 1]] for the face tagged P1.\n\nLunch with Ada Example.");
      const [framed] = named.pictures as [{ covered: unknown[]; written: { placeholder?: string }[] }];
      expect([framed.covered, framed.written.map((face) => face.placeholder)]).toEqual([[], ["[[Person 1]]", "[[Person 2]]"]]);
    } finally {
      ledger.close();
    }
  });

  it("sends the family's own plain pieces and a retry's own words as written, a value the table holds there too, and hides the free piece beside them", async () => {
    const { ledger, copies } = copiesOver();
    try {
      await copies.make(asked());
      const pieces: Piece[] = [
        { text: "Name a face [[Person 1]] as the prompt says.\n\n" }, { text: "Its first face is Person 1." },
        { text: "\n\nYour previous answer:\n\n" }, { text: "Ada Example ate.", free: true },
        { text: "\n\nWhy it was refused:\n" }, { text: "the answer names [[Person 9]], which the picture does not show" },
        { text: "\n\nAnswer again, as Ada Example asked." },
      ];
      const retry = ledger.sent.get((await copies.make(asked({ key: "sha256:req-4", pieces, quoted: { key: "sha256:req-none", at: 3 } })) as { copy: number }).copy)!;
      expect(retry.body).toBe("Name a face [[Person 1]] as the prompt says.\n\nIts first face is Person 1.\n\nYour previous answer:\n\n[[Person 1]] ate.\n\nWhy it was refused:\n" +
        "the answer names [[Person 9]], which the picture does not show\n\nAnswer again, as Ada Example asked.");
    } finally {
      ledger.close();
    }
  });

  it("a retry quotes the model's own words where the answer it quotes came by a copy, and the asker's free piece where it did not", async () => {
    const { ledger, copies } = copiesOver();
    try {
      const quotedAt = PIECES.length + 1;
      const retryPieces = (answer: string): Piece[] => [...PIECES, { text: "\n\nYour previous answer:\n\n" }, { text: answer, free: true }, { text: "\n\nAgain." }];
      const plain = await copies.make(asked({ key: "sha256:retry-1", pieces: retryPieces("Ada Example ate."), quoted: { key: "sha256:req-0", at: quotedAt } }));
      expect(ledger.sent.get((plain as { copy: number }).copy)!.body).toContain("Your previous answer:\n\n[[Person 1]] ate.");
      ledger.request({
        key: "sha256:req-0", family: "notes", unit: "note-1", revision: "sha256:req-1", model: "fake-model", effort: "low",
        prompt: { name: "note", version: 1, text: "Describe this synthetic note.\n\n", type: "text" }, input_hash: "sha256:input-1", body: "a body", attachments: [],
      }, 1_000);
      const sent = await copies.make(asked({ key: "sha256:req-0" }));
      const answerOf = (made: unknown) => ledger.sent.get((made as { copy: number }).copy)!.body!;
      const begun = ledger.beginAttempt("sha256:req-0", 1_000, "fake", {
        copy: (sent as { copy: number }).copy,
        outbound: { at_ms: 1_000, receiver: "Example AI", route: "fake:fake-model", by: null, what: "ask", tool: null, level: "all", counts: {}, chars: 1, pictures: 0 },
      });
      if (!("attempt" in begun)) throw new Error(`not begun: ${JSON.stringify(begun)}`);
      ledger.land(begun.attempt, { text: "Ada Example ate with [[Person 7]].", model: "fake-model", transport: "fake", written: "[[Person 1]] ate with [[Person 7]]." }, 1_000);
      const quoted = await copies.make(asked({ key: "sha256:retry-2", pieces: retryPieces("Ada Example ate with [[Person 7]]."), quoted: { key: "sha256:req-0", at: quotedAt } }));
      expect(answerOf(quoted)).toContain("Your previous answer:\n\n[[Person 1]] ate with [[Person 7]].\n\nAgain.");
      const elsewhere = await copies.make(asked({ key: "sha256:retry-3", receiver: "Another AI", pieces: retryPieces("Ada Example ate with [[Person 7]]."), quoted: { key: "sha256:req-0", at: quotedAt } }));
      expect(answerOf(elsewhere)).toContain("Your previous answer:\n\n[[Person 1]] ate with ");
      expect(answerOf(elsewhere)).not.toMatch(/Ada/u);
      const named = await copies.make(asked({ key: "sha256:retry-4", level: "names", pieces: retryPieces("Ada Example ate with [[Person 7]]."), quoted: { key: "sha256:req-0", at: quotedAt } }));
      expect(answerOf(named)).toContain("Your previous answer:\n\nAda Example ate with ");
    } finally {
      ledger.close();
    }
  });

  it("a retry under `all` never quotes as written what the model answered a copy under `none`: its real names are hidden", async () => {
    const { ledger, copies } = copiesOver();
    try {
      ledger.request({
        key: "sha256:req-0", family: "notes", unit: "note-1", revision: "sha256:req-0", model: "fake-model", effort: "low",
        prompt: { name: "note", version: 1, text: "Describe this synthetic note.\n\n", type: "text" }, input_hash: "sha256:input-1", body: "a body", attachments: [],
      }, 1_000);
      const none = await copies.make(asked({ key: "sha256:req-0", revision: "sha256:req-0", level: "none" }));
      const begun = ledger.beginAttempt("sha256:req-0", 1_000, "fake", {
        copy: (none as { copy: number }).copy,
        outbound: { at_ms: 1_000, receiver: "Example AI", route: "fake:fake-model", by: null, what: "ask", tool: null, level: "none", counts: {}, chars: 1, pictures: 0 },
      });
      if (!("attempt" in begun)) throw new Error(`not begun: ${JSON.stringify(begun)}`);
      ledger.land(begun.attempt, { text: "Ada Example ate; call +15550000001.", model: "fake-model", transport: "fake" }, 1_000);
      const retry = await copies.make(asked({
        key: "sha256:retry-1", revision: "sha256:req-0", quoted: { key: "sha256:req-0", at: PIECES.length + 1 },
        pieces: [...PIECES, { text: "\n\nYour previous answer:\n\n" }, { text: "Ada Example ate; call +15550000001.", free: true }, { text: "\n\nAgain." }],
      }));
      const body = ledger.sent.get((retry as { copy: number }).copy)!.body!;
      expect(body).toContain("Your previous answer:\n\n[[Person 1]] ate; call [[Phone 1]].");
      expect(body).not.toMatch(/Ada|15550000001/u);
    } finally {
      ledger.close();
    }
  });

  it("an erasure while a picture is read makes no copy and leaves no picture's file", async () => {
    const { root, ledger, copies } = copiesOver();
    try {
      whileRead = () => {
        ledger.placeholders.beginErasure();
        ledger.placeholders.endErasure();
      };
      expect(await copies.make(asked({ attachments: [{ blob: PHOTO, media_type: "image/jpeg" }] }))).toEqual({ wait: expect.stringContaining("erasing") });
      expect(existsSync(join(root, "replies", "sent")) ? readdirSync(join(root, "replies", "sent")) : []).toEqual([]);
      expect(existsSync(join(root, "replies", "blobs")) ? readdirSync(join(root, "replies", "blobs")) : []).toEqual([]);
      expect(ledger.placeholders.part("ask:sha256:req-1", wantedOf([])).table.entries).toEqual([]);
    } finally {
      ledger.close();
    }
  });

  it("texts read before an erasure, or while one runs, make no copy under any level", async () => {
    const { ledger, copies } = copiesOver();
    try {
      ledger.placeholders.beginErasure();
      expect(await copies.make(asked({ level: "none" }))).toEqual({ wait: expect.stringContaining("erasing") });
      ledger.placeholders.endErasure();
      expect(await copies.make(asked())).toEqual({ wait: expect.stringContaining("erasing") });
      expect("copy" in await copies.make(asked({ epoch: ledger.placeholders.epoch().epoch }))).toBe(true);
    } finally {
      ledger.close();
    }
  });
});
