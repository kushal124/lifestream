
const EDITED_STEM = /-edited$/u;
const COMPANION = /\.(?:mov|mp)$/iu;

export function unmarked(name: string): string {
  const dot = name.indexOf(".", 1);
  return dot < 0 ? name.replace(/\(\d+\)$/u, "") : `${name.slice(0, dot).replace(/\(\d+\)$/u, "")}${name.slice(dot)}`;
}

export function stemOf(name: string): string {
  const dot = name.indexOf(".", 1);
  return (dot < 0 ? name : name.slice(0, dot)).replace(/\(\d+\)$/u, "").replace(EDITED_STEM, "");
}

export function uneditedOf(name: string): string | null {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return EDITED_STEM.test(stem) ? `${stem.replace(EDITED_STEM, "")}${dot > 0 ? name.slice(dot) : ""}` : null;
}

export function extensionless(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function companionName(name: string): boolean {
  return COMPANION.test(name);
}
