import { describe, expect, it } from "vitest";
import { recordRead, recordText, TEXT_BYTES, TITLE_CHARS } from "./shared/text.js";
import { registryFamilies } from "./test/drive.js";
import { textFamilyOf } from "./texts.js";

describe("search texts", () => {
  it("a kind's text comes from another family than the first in the registry's order that reads it", () => {
    const families = registryFamilies();
    const read = new Map<string, string>();
    for (const family of families) {
      for (const input of family.inputs) {
        for (const product of input.sources.product ?? []) {
          for (const kind of input.kinds) {
            const source = { product, vendor: "synthetic", copy: input.sources.copy?.[0] ?? "mac-0001" };
            read.set(`${product} ${kind}`, textFamilyOf(families, source, kind)?.name ?? "none");
          }
        }
      }
    }
    const byFamily: Record<string, string[]> = {};
    for (const [kind, family] of [...read].sort(([left], [right]) => left < right ? -1 : 1)) (byFamily[family] ??= []).push(kind);
    expect(byFamily).toEqual({
      messages: ["apple-contacts contact", "google-contacts contact", "imessage msg", "people person", "whatsapp business", "whatsapp chat", "whatsapp msg", "whatsapp pushname"],
      mail: ["gmail mailmsg"],
      ai: ["ask chat", "ask msg", "chatgpt chat", "chatgpt msg", "claude chat", "claude msg", "claude-code agent-turn", "codex agent-turn"],
      voice: ["aqua-voice dictation", "wispr-flow dictation"],
      calendar: ["apple-calendar event", "apple-calendar reminder", "apple-reminders reminder", "google-calendar event"],
      notes: ["apple-notes note", "granola note"],
      money: ["example-bank txn"],
      calls: ["apple-calls call", "whatsapp call"],
      listening: ["now-playing now-playing", "spotify play"],
      web: ["chrome page-visit", "chrome search", "safari page-visit"],
      none: [
        "apple-health day-summary", "apple-health sample", "apple-health workout", "apple-photos img", "apple-photos img-file", "camera img", "camera img-file",
        "cameras camera", "cameras photo", "checkin report", "checkin vigilance", "chrome download", "coast ax", "coast frame", "coast session", "devices camera",
        "faces model-image", "google-maps place", "google-photos img", "google-photos img-file", "google-timeline place-visit", "google-timeline trip", "groups month",
        "imessage chat", "imessage chat-state", "input input", "location fix", "machine machine-event", "motion motion", "places hidden", "places place",
        "safari tab", "screen frame", "screen recorder", "screen-time app-focus", "screen-time usage", "stations tab", "voice-notes voice", "whoop cycle", "whoop physio-day",
        "whoop recovery", "whoop sample", "whoop sleep", "whoop workout",
      ],
    });
  });

  it("a text is cut inside a character, or past 64 KB of text or 512 characters of title", () => {
    const text = `${"a".repeat(TEXT_BYTES - 2)}😀tail`;
    const cut = recordText({ title: `${"t".repeat(TITLE_CHARS - 1)}😀`, text })!;
    expect(cut.text).toBe("a".repeat(TEXT_BYTES - 2));
    expect(Buffer.byteLength(cut.text, "utf8")).toBeLessThanOrEqual(TEXT_BYTES);
    expect(cut.title).toBe("t".repeat(TITLE_CHARS - 1));
    expect(recordText({ text: "é".repeat(TEXT_BYTES) })!.text).toBe("é".repeat(TEXT_BYTES / 2));
    expect(recordText({ text: "a".repeat(TEXT_BYTES) })!.text.length).toBe(TEXT_BYTES);
  });

  it("every family that gives a record's words for search reads it whole too (`read`)", () => {
    const families = registryFamilies();
    expect(families.filter((family) => family.text !== undefined && family.read === undefined).map((family) => family.name)).toEqual([]);
  });

  it("a record as it reads: whole past 64 KB, its title uncut; a sender and recipients only as stated, people of no direction as `who`", () => {
    const text = "w".repeat(80 * 1024);
    const title = "t".repeat(TITLE_CHARS + 100);
    expect(recordRead({ title, text })).toEqual({ title, text });
    expect(recordText({ title, text })!.text.length).toBe(TEXT_BYTES);
    const one = recordRead({ title: "Synthetic sync", text: "notes", who: ["person-a@example.com", "person-b@example.com"] })!;
    const other = recordRead({ title: "Synthetic sync", text: "notes", who: ["person-b@example.com", "person-a@example.com"] })!;
    expect([one.from, one.to, other.from, other.to]).toEqual([undefined, undefined, undefined, undefined]);
    expect(new Set(one.who)).toEqual(new Set(other.who));
    expect(recordRead({ text: "hi", from: "Person-A@Example.com", to: ["person-b@example.com", "Person-A@Example.com"] })).toEqual({ text: "hi", from: "person-a@example.com", to: ["person-b@example.com"] });
    expect(recordRead({ text: "hi", from: null, to: ["+1 (555) 000-0003"] })).toEqual({ text: "hi", from: null, to: ["+15550000003"] });
  });

  it("a record with only ids, or only whitespace, has a text; an id is spelled otherwise than the labels route names it", () => {
    expect(recordText({ text: "  \n ", who: ["+15550000002"] })).toBeNull();
    expect(recordText({ title: " ", text: "", link: "https://example.com/" })).toBeNull();
    expect(recordText({
      text: " hi ",
      who: ["15550000002@S.WHATSAPP.NET", "900000000001@lid", "+1 (555) 000-0003", "Person-D@Example.com", "SYNTH-SHORTCODE", "+15550000002"],
      link: " https://example.com/a ",
    })).toEqual({
      text: "hi",
      who: ["15550000002@s.whatsapp.net", "+15550000002", "900000000001@lid", "+15550000003", "person-d@example.com", "SYNTH-SHORTCODE"],
      link: "https://example.com/a",
    });
  });
});
