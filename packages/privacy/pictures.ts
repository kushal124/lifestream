import { overlap, type Box } from "@lifestreamprotocol/core";

export interface Recipe {
  blob: string;
  filled: Box[];
  covered: Cover[];
  written: { box: Box; placeholder: string }[];
  engine: string;
}

export interface Cover {
  box: Box;
  colour: string;
  placeholder?: string;
}

export type Draft = Omit<Recipe, "engine" | "covered"> & { covered: (Omit<Cover, "colour"> & { colour?: string })[] };

export interface Picture {
  jpeg: Uint8Array;
  recipe: Recipe;
}

export function drew(picture: Picture): boolean {
  const { filled, covered, written } = picture.recipe;
  return filled.length > 0 || covered.length > 0 || written.length > 0;
}

export interface Findings {
  lines: { words: { text: string; box: Box }[] }[];
  faces: Face[];
}

export function linesText(lines: Findings["lines"]): { text: string; words: { start: number; end: number; box: Box }[] } {
  let text = "";
  const words: { start: number; end: number; box: Box }[] = [];
  lines.forEach((line, lineAt) => {
    if (lineAt > 0) text += "\n";
    line.words.forEach((word, wordAt) => {
      if (wordAt > 0) text += " ";
      words.push({ start: text.length, end: text.length + word.text.length, box: word.box });
      text += word.text;
    });
  });
  return { text, words };
}

export interface Face {
  box: Box;
  who?: string;
}

export interface Pictures {
  read(blob: string): Promise<Findings | { cannot: string }>;
  make(draft: Draft): Promise<Picture | { cannot: string }>;
}

export interface PictureText {
  picture: string;
  faces?: readonly { box: Box; placeholder: string }[];
  tags?: true;
}

export function tagOf(placeholder: string): string {
  const parts = /^\[\[Person (\d+)\]\]$/u.exec(placeholder);
  if (parts === null) throw new TypeError(`a face's placeholder is [[Person N]], not ${JSON.stringify(placeholder)}`);
  return `P${parts[1]}`;
}

export function facesDrawn(found: readonly Box[], asked: readonly { box: Box; placeholder: string }[], cover: boolean): Pick<Draft, "covered" | "written"> {
  if (!cover) return { covered: [], written: asked.map((face) => ({ box: face.box, placeholder: face.placeholder })) };
  const covered: Draft["covered"] = asked.map((face) => ({ box: face.box, placeholder: face.placeholder }));
  const others: Draft["covered"] = [];
  for (const box of found) {
    if (covered.some((face) => overlap(face.box, box, "smaller") >= 0.5)) continue;
    const same = others.find((face) => overlap(face.box, box, "smaller") >= 0.5);
    if (same === undefined) others.push({ box });
    else same.box = holding(same.box, box);
  }
  return { covered: [...covered, ...others], written: [] };
}

function holding(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}
