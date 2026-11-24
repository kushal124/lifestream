import { describe, expect, it } from "vitest";
import type { Box } from "@lifestreamprotocol/core";
import { putBack, whoOf, type CaptionFaces } from "./faces.js";
import { PHOTO_CAPTION_PROMPT } from "./family.js";

const box = (x: number, y = 0, width = 100, height = 100): Box => ({ x, y, width, height });

describe("put-back", () => {
  const answer: CaptionFaces = {
    caption: "[[Person 1]], in a blue cap, holds a cake beside [[Person 2]]. [[Person 2]] smiles. A poster behind shows [[Person 3]].",
    faces: [
      { placeholder: "[[Person 1]]", who: "a man" },
      { placeholder: "[[Person 2]]", who: "a woman" },
      { placeholder: "[[Person 3]]", who: "" },
    ],
  };
  const asked = [{ placeholder: "[[Person 1]]", box: box(0) }, { placeholder: "[[Person 2]]", box: box(200) }, { placeholder: "[[Person 3]]", box: box(400) }];

  it("writes a named face as its name with its span, any other as its who, capitalised where it starts a sentence, and nothing else", () => {
    const back = putBack(answer, asked, [{ box: box(10, 5), who: "p-ada", shown: "Ada Example" }]);
    expect(back.text).toBe("Ada Example, in a blue cap, holds a cake beside a woman. A woman smiles. A poster behind shows a person.");
    expect(back.names).toEqual([{ start: 0, end: 11, who: "p-ada" }]);
  });

  it("gives a face of the model image to the entry that overlaps it most, once, and puts each span where its name stands", () => {
    const both = [{ placeholder: "[[Person 1]]", box: box(0) }, { placeholder: "[[Person 2]]", box: box(30) }];
    const back = putBack({ caption: "[[Person 2]] waves at [[Person 1]].", faces: [
      { placeholder: "[[Person 1]]", who: "a boy" }, { placeholder: "[[Person 2]]", who: "a girl" }] }, both,
    [{ box: box(25), who: "p-rose", shown: "Rose Example" }]);
    expect(back.text).toBe("Rose Example waves at a boy.");
    expect(back.names).toEqual([{ start: 0, end: 12, who: "p-rose" }]);
    const later = putBack({ caption: "A table; [[Person 1]] and [[Person 2]] sit.", faces: [] }, both,
      [{ box: box(0), who: "p-ada", shown: "Ada Example" }, { box: box(30), who: "p-rose", shown: "Rose Example" }]);
    expect(later.text).toBe("A table; Ada Example and Rose Example sit.");
    expect(later.names.map((span) => later.text.slice(span.start, span.end))).toEqual(["Ada Example", "Rose Example"]);
  });

  it("matches no face that shares under half of the boxes' union", () => {
    expect(putBack(answer, asked, [{ box: box(60), who: "p-ada", shown: "Ada Example" }]).names).toEqual([]);
  });

  it("matches the same face a rescan moved, never a small face inside the entry's box (a photo held up)", () => {
    const one = [{ placeholder: "[[Person 1]]", box: box(0) }];
    const caption: CaptionFaces = { caption: "[[Person 1]] holds a photo.", faces: [{ placeholder: "[[Person 1]]", who: "a man" }] };
    const inside = { box: box(20, 20, 30, 30), who: "p-rose", shown: "Rose Example" };
    expect(putBack(caption, one, [inside, { box: box(10), who: "p-ada", shown: "Ada Example" }]).text).toBe("Ada Example holds a photo.");
    expect(putBack(caption, one, [inside]).text).toBe("A man holds a photo.");
  });

  it("writes a `who` that is a description, and \"a person\" for one holding a name, words off the photo or a placeholder", () => {
    for (const who of ["a man", "an older woman", "a young girl", "a middle-aged man", " a boy "]) expect(whoOf(who)).toBe(who.trim());
    for (const who of [undefined, "", "Barack Example", "a man named Ada", "a man in a blue cap and a red scarf", "[[Person 2]]'s child", "a \"STAFF\" badge wearer", "man", "the Example family", "a 40 year old"]) {
      expect(whoOf(who)).toBe("a person");
    }
    const back = putBack({ caption: "[[Person 1]] waves.", faces: [{ placeholder: "[[Person 1]]", who: "Ada Example" }] }, [{ placeholder: "[[Person 1]]", box: box(0) }], []);
    expect(back.text).toBe("A person waves.");
  });
});

describe("the words", () => {
  it("say what a tag stands for, ask for the answer's shape, and read a version-9 caption as a caption with no face", () => {
    expect(PHOTO_CAPTION_PROMPT.text).toContain("The tag Pn stands for the placeholder [[Person n]]");
    expect(PHOTO_CAPTION_PROMPT.text).toContain('{"caption":');
    expect(PHOTO_CAPTION_PROMPT.text).toContain("their expression and whether they wear glasses when they show");
    expect(PHOTO_CAPTION_PROMPT.text).not.toContain("covered face");
    expect([PHOTO_CAPTION_PROMPT.version, Object.keys((PHOTO_CAPTION_PROMPT.type as { properties: object }).properties), PHOTO_CAPTION_PROMPT.keeps]).toEqual([10, ["caption", "faces"], [{ version: 9, type: "text" }]]);
    expect(PHOTO_CAPTION_PROMPT.converters![9]!("A dog on a beach.")).toEqual({ caption: "A dog on a beach.", faces: [] });
  });
});
