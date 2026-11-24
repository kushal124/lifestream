import { overlap, type Box, type Drawn } from "@lifestreamprotocol/core";


export interface FaceSaid {
  placeholder: string;
  who: string;
}

export interface CaptionFaces {
  caption: string;
  faces: FaceSaid[];
}

export interface FaceNamed {
  box: Box;
  who: string;
  shown: string;
}

const PLACEHOLDER = /\[\[Person \d+\]\]/gu;

export function putBack(answer: CaptionFaces, asked: readonly Drawn[], named: readonly FaceNamed[]): { text: string; names: { start: number; end: number; who: string }[] } {
  const person = matched(asked, named);
  const said = new Map(answer.faces.map((face) => [face.placeholder, face]));
  const names: { start: number; end: number; who: string }[] = [];
  let text = "";
  let at = 0;
  for (const found of answer.caption.matchAll(PLACEHOLDER)) {
    text += answer.caption.slice(at, found.index);
    at = found.index + found[0].length;
    const face = person.get(found[0]);
    if (face !== undefined) {
      names.push({ start: text.length, end: text.length + face.shown.length, who: face.who });
      text += face.shown;
      continue;
    }
    const who = whoOf(said.get(found[0])?.who);
    text += /(?:^|[.!?]\s+)$/u.test(text) ? who[0]!.toUpperCase() + who.slice(1) : who;
  }
  return { text: text + answer.caption.slice(at), names };
}

export function whoOf(said: string | undefined): string {
  const who = said?.trim() ?? "";
  return DESCRIPTION.test(who) ? who : "a person";
}

const DESCRIPTION = /^an? [a-z]+(?:[ -][a-z]+){0,2}$/u;

function matched(asked: readonly Drawn[], named: readonly FaceNamed[]): Map<string, FaceNamed> {
  const pairs = asked.flatMap((face, i) => named.map((name, j) => ({ i, j, share: overlap(face.box, name.box, "union") })))
    .filter((pair) => pair.share >= 0.5)
    .sort((a, b) => b.share - a.share || a.i - b.i || a.j - b.j);
  const out = new Map<string, FaceNamed>();
  const taken = new Set<number>();
  for (const { i, j } of pairs) {
    if (out.has(asked[i]!.placeholder) || taken.has(j)) continue;
    out.set(asked[i]!.placeholder, named[j]!);
    taken.add(j);
  }
  return out;
}
