
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function body(pattern: string): string {
  const parts = pattern.split("/");
  return parts.map((part, at) => {
    const last = at === parts.length - 1;
    if (part === "**") return last ? "[^/]+(?:/[^/]+)*" : "(?:[^/]+/)*";
    return part.split("*").map(literal).join("[^/]*") + (last ? "" : "/");
  }).join("");
}

const made = new Map<string, RegExp>();

function patternOf(pattern: string): RegExp {
  let expression = made.get(pattern);
  if (expression === undefined) made.set(pattern, expression = new RegExp(`^(?:[^/]+/)*${body(pattern)}$`, "iu"));
  return expression;
}

/** Whether a file's name matches a pattern under any leading folders, in any case, `*` standing for any part of one name and `**` for any run of folders. */
export function matches(pattern: string, name: string): boolean {
  return patternOf(pattern).test(name);
}

export function isPattern(pattern: unknown): pattern is string {
  if (typeof pattern !== "string" || pattern === "" || pattern.includes("\\")) return false;
  return pattern.split("/").every((part) => part !== "" && part !== "." && part !== ".." && (part === "**" || !part.includes("**")));
}
