import { describe, expect, it } from "vitest";
import { cleanTitle, keyOf, plainLine, proseChars } from "./screen-keys.js";

describe("cleanTitle", () => {
  it("takes off counts, the sound mark, versions, a leading glyph and the truncation mark (K1)", () => {
    expect(cleanTitle("(3) Example Page — Site")).toBe("Example Page — Site");
    expect(cleanTitle("Example Page — Site [12+]")).toBe("Example Page — Site");
    expect(cleanTitle("Example Video 🔊 — Site")).toBe("Example Video — Site");
    expect(cleanTitle("Example Editor 4.2.1")).toBe("Example Editor");
    expect(cleanTitle("Example Tool — Version 1.20 (233)")).toBe("Example Tool");
    expect(cleanTitle("⠋ Building example-project")).toBe("Building example-project");
    expect(cleanTitle("● notes.txt — Example Editor")).toBe("notes.txt — Example Editor");
    expect(cleanTitle("A very long example … the end of it")).toBe("A very long example the end of it");
    expect(cleanTitle(null)).toBe("");
  });
});

describe("keyOf", () => {
  it("names a WhatsApp chat from its call button, else its message list, never a guess (K2)", () => {
    expect(keyOf("WhatsApp", null, "WhatsApp", ["[Button] Search", "[Button] Start video call with Person A"]).name).toBe("Person A");
    expect(keyOf("WhatsApp", null, "WhatsApp", ["Messages in chat with Group B", "[Button] Start voice call with Person C"]).name).toBe("Person C");
    expect(keyOf("WhatsApp", null, "WhatsApp", ["Messages in chat with Group B"]).name).toBe("Group B");
    expect(keyOf("WhatsApp", null, "WhatsApp", ["Chats", "Archived"]).name).toBe("WhatsApp");
  });

  it("names a coding agent's and Claude's thread from their lines (K2)", () => {
    expect(keyOf("Codex", null, "Codex", ["[Button] Thread actions for Fix the example build"]).name).toBe("Fix the example build");
    expect(keyOf("Claude", null, null, ["[Button] Example session, rename session"]).name).toBe("Example session");
  });

  it("keeps a title of its own, and an app with no row keeps its cleaned title (K2)", () => {
    expect(keyOf("WhatsApp", null, "(2) Person D", ["[Button] Start video call with Person A"]).name).toBe("Person D");
    expect(keyOf("Example App", null, "Example App", ["[Button] Start video call with Person A"]).name).toBe("Example App");
  });

  it("names a video page whose title is the site's name by its first heading (K3)", () => {
    const key = keyOf("Example Browser", "www.youtube.com", "(1) YouTube", ["[Link] Home", "[Heading] Example Talk About Rugs", "[Heading] Comments"]);
    expect(key).toEqual({ app: "Example Browser", site: "youtube.com", name: "Example Talk About Rugs", title: "(1) YouTube" });
    expect(keyOf("Example Browser", "youtube.com", "Example Talk — YouTube", ["[Heading] Other"]).name).toBe("Example Talk — YouTube");
  });
});

describe("prose", () => {
  const sentence = "This is an example sentence that goes on for a while, so that it reads as prose on a page of its own.";
  it("counts sentences, never tab strips, short lines or figures (K4)", () => {
    expect(proseChars([sentence], false)).toBe(sentence.length);
    expect(proseChars([`Tab one | Tab two | ${sentence}`], false)).toBe(0);
    expect(proseChars(["Too short to count as prose."], false)).toBe(0);
    expect(proseChars(["12 34 56 78 90 12 34 56 78 90 12 34 56 78 90 12 34 56 78 90 12 34 56 78 90 12 34 56 78."], false)).toBe(0);
    const short = "A shorter example line in a book, read as prose here.";
    expect(proseChars([short], false)).toBe(0);
    expect(proseChars([short], true)).toBe(short.length);
  });

  it("reads a line as words without its role tag or cursor mark", () => {
    expect(plainLine("[Button]  Send   now")).toBe("Send now");
    expect(plainLine("▶ cursor here: [TextField] draft")).toBe("draft");
  });
});
