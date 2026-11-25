import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESIGN = join(ROOT, "design");

type ThemeId = "dark" | "light" | "dark-hc" | "light-hc";
const THEMES: readonly ThemeId[] = ["dark", "light", "dark-hc", "light-hc"];

interface Token { readonly name: string; readonly value: string | Partial<Record<ThemeId, string>>; readonly usage?: string }
interface Family { readonly note?: string; readonly tokens: readonly Token[] }
interface Style {
  readonly name: string; readonly fontSize: string; readonly lineHeight: string; readonly fontWeight: number;
  readonly letterSpacing?: string; readonly fontStyle?: string; readonly family?: string; readonly uppercase?: boolean;
  readonly sample?: string; readonly usage?: string;
}
interface Group { readonly name: string; readonly family: string; readonly note?: string; readonly styles: readonly Style[] }
interface Tokens {
  readonly name: string;
  readonly color: { readonly themes: readonly { id: ThemeId; name: string }[]; readonly tokens: readonly Token[] };
  readonly type: { readonly families: Record<string, string>; readonly groups: readonly Group[] };
  readonly spacing: Family; readonly radius: Family; readonly shadow: Family; readonly size: Family;
  readonly stroke: Family; readonly opacity: Family; readonly duration: Family; readonly easing: Family;
  readonly map: Family;
  readonly health: { readonly note: string; readonly states: readonly { name: string; signal: "idle" | "caution" | "warning" | null; word: string | null; usage: string }[] };
  readonly onboarding: Onboarding;
}
type Night = "night" | "night-hc";
interface NightToken { readonly name: string; readonly value: { readonly night: string; readonly "night-hc"?: string }; readonly usage: string }
interface Onboarding {
  readonly note: string;
  readonly font: { readonly family: string; readonly src: string; readonly weight: string; readonly usage: string };
  readonly color: readonly NightToken[]; readonly shadow: readonly NightToken[]; readonly type: readonly Style[];
}
interface IconEntry { readonly phosphor?: string; readonly regular?: string[]; readonly fill?: string[]; readonly stroke?: string[]; readonly solid?: string[] }
interface IconData { readonly icons: Record<string, IconEntry> }

const tokens = JSON.parse(readFileSync(join(DESIGN, "tokens.json"), "utf8")) as Tokens;
const READ: Readonly<Record<"swiftMap" | "cssMap" | "cssEdge" | "swiftOnboarding", readonly string[]>> = {
  cssEdge: ["shadow-panel"],
  swiftMap: ["map-land", "map-road-minor", "map-road-major", "map-dim"],
  cssMap: ["map-land", "map-water", "map-green", "map-road-minor", "map-road-major"],
  swiftOnboarding: ["ob-ground", "ob-ink", "ob-soft", "ob-line", "ob-hairline", "ob-panel", "ob-raised", "ob-glacier"],
};
const icons = JSON.parse(readFileSync(join(DESIGN, "icons.json"), "utf8")) as IconData;


const appearance = (theme: ThemeId): "dark" | "light" => (theme.startsWith("light") ? "light" : "dark");
function themed(token: Token, theme: ThemeId): string {
  const raw = typeof token.value === "string" ? token.value : (token.value[theme] ?? token.value[appearance(theme)]);
  if (raw === undefined) throw new Error(`${token.name} has no value for ${theme}`);
  return raw;
}
const ALIAS = /\{([a-z0-9-]+)\}(?: \/ ([\d.]+)%)?/gu;
const colors = new Map(tokens.color.tokens.map((t) => [t.name, t]));
function colorOf(name: string, theme: ThemeId, depth = 0): string {
  const token = colors.get(name);
  if (token === undefined || depth > 16) throw new Error(`no colour token ${name}`);
  return resolved(themed(token, theme), theme, depth);
}
function resolved(raw: string, theme: ThemeId, depth = 0): string {
  return raw.replace(ALIAS, (_, name: string, pct?: string) => {
    const base = colorOf(name, theme, depth + 1);
    return pct === undefined ? base : atAlpha(base, +pct / 100);
  });
}
function atAlpha(value: string, alpha: number): string {
  const c = rgba(value);
  return `rgba(${c.r},${c.g},${c.b},${+(c.a * alpha).toFixed(4)})`;
}
interface RGBA { r: number; g: number; b: number; a: number }
function rgba(value: string): RGBA {
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/iu.exec(value);
  if (hex !== null) {
    const n = parseInt(hex[1]!, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: hex[2] === undefined ? 1 : parseInt(hex[2], 16) / 255 };
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/u.exec(value);
  if (fn !== null) return { r: +fn[1]!, g: +fn[2]!, b: +fn[3]!, a: fn[4] === undefined ? 1 : +fn[4] };
  throw new Error(`cannot read colour ${value}`);
}
const linear = (c: number): number => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = (c: RGBA): number => 0.2126 * linear(c.r) + 0.7152 * linear(c.g) + 0.0722 * linear(c.b);
function contrast(a: string, b: string): number {
  const x = luminance(rgba(a)), y = luminance(rgba(b));
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const night = (token: NightToken, mode: Night): string => (mode === "night" ? token.value.night : (token.value["night-hc"] ?? token.value.night));
const obColor = (name: string, mode: Night): string => {
  const token = tokens.onboarding.color.find((t) => t.name === name);
  if (token === undefined) throw new Error(`no onboarding colour ${name}`);
  return night(token, mode);
};
function over(fg: string, ground: string): string {
  const f = rgba(fg), g = rgba(ground);
  const mix = (a: number, b: number): number => Math.round(a * f.a + b * (1 - f.a));
  return `rgba(${mix(f.r, g.r)}, ${mix(f.g, g.g)}, ${mix(f.b, g.b)}, 1)`;
}


const GROUNDS = ["canvas", "surface", "raised", "well", "overlay"];
const SIGNALS = ["plan", "now", "engaged", "caution", "warning"];
function promises(): string[] {
  const fails: string[] = [];
  const need = (theme: ThemeId, fg: string, bg: string, bar: number): void => {
    const ratio = contrast(colorOf(fg, theme), colorOf(bg, theme));
    if (ratio < bar) fails.push(`${theme}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, under ${bar}:1`);
  };
  for (const theme of THEMES) {
    const text = theme.endsWith("-hc") ? 7 : 4.5;
    for (const fg of ["text", "text-secondary", "text-tertiary"]) for (const bg of GROUNDS) need(theme, fg, bg, text);
    need(theme, "text-inverse", "text", text);
    need(theme, "text", "thumb", text);
    for (const s of SIGNALS) {
      for (const bg of ["canvas", "surface", `${s}-soft`]) need(theme, s, bg, 4.5);
      need(theme, s, "raised", 3);
      need(theme, "on-signal", s, 4.5);
      need(theme, "text", `${s}-soft`, text);
      need(theme, "text-secondary", `${s}-soft`, text);
    }
    for (const bg of ["canvas", "surface", "here-soft"]) need(theme, "here", bg, 4.5);
    need(theme, "here", "raised", 3);
    need(theme, "text", "here-soft", text);
    for (const bg of ["canvas", "surface", "raised"]) need(theme, "life", bg, 3);
    for (const bg of ["canvas", "surface"]) for (const fg of ["data-2", "data-3"]) need(theme, fg, bg, 3);
    for (const rank of [1, 2, 3, 4, 5]) need(theme, `storage-${rank}`, "surface", 3);
    need(theme, "life-glyph", "life", 3);
    for (const bg of ["canvas", "surface", "well"]) need(theme, "stroke-control", bg, 3);
    need(theme, "code", "code-ground", 15);
    const land = mapColor("map-land", theme);
    for (const name of ["map-name-street", "map-name-park", "map-name-area", "map-name-water"]) {
      const ratio = contrast(mapColor(name, theme), land);
      if (ratio < 3) fails.push(`${theme}: ${name} on map-land is ${ratio.toFixed(2)}:1, under 3:1`);
    }
    for (const fg of ["life", "here", "text-secondary"]) {
      const ratio = contrast(colorOf(fg, theme), land);
      if (ratio < 3) fails.push(`${theme}: ${fg} on map-land is ${ratio.toFixed(2)}:1, under 3:1`);
    }
  }
  for (const mode of ["night", "night-hc"] as const) {
    const text = mode === "night-hc" ? 7 : 4.5;
    const ground = obColor("ob-ground", mode);
    const need = (fg: string, bg: string, bar: number): void => {
      const back = bg === "ob-ground" ? ground : over(obColor(bg, mode), ground);
      const ratio = contrast(obColor(fg, mode), back);
      if (ratio < bar) fails.push(`${mode}: ${fg} on ${bg} is ${ratio.toFixed(2)}:1, under ${bar}:1`);
    };
    for (const fg of ["ob-ink", "ob-soft", "ob-glacier"]) for (const bg of ["ob-ground", "ob-raised"]) need(fg, bg, text);
    need("ob-ground", "ob-ink", text);
    need("ob-faint", "ob-ground", mode === "night-hc" ? 4.5 : 3);
    need("ob-live", "ob-ground", 3);
  }
  return fails;
}


const LAYER_SPLIT = /,(?![^(]*\))/u;
const RING = /^inset 0 0 0 ([\d.]+px) (.+)$/u;
function edgeAndDrop(t: Token, theme: ThemeId): { edge: string; drop: string } {
  const split = THEMES.map((each) => {
    const layers = resolved(themed(t, each), each).split(LAYER_SPLIT).map((l) => l.trim());
    const rings = layers.map((l) => RING.exec(l)).filter((m) => m !== null);
    const drop = layers.filter((l) => !l.startsWith("inset"));
    return { each, rings, drop, whole: rings.length <= 1 && rings.length + drop.length === layers.length };
  });
  const widths = new Set(split.flatMap((s) => s.rings.map((m) => m[1])));
  const mine = split.find((s) => s.each === theme);
  if (widths.size !== 1 || mine === undefined || split.some((s) => !s.whole)) throw new Error(`${t.name} is not one inset ring of one width beside outer layers`);
  return { edge: `${[...widths][0]} solid ${mine.rings[0]?.[2] ?? "transparent"}`, drop: mine.drop.join(", ") || "none" };
}

function css(): string {
  const block = (theme: ThemeId): string[] => [
    ...tokens.color.tokens.map((t) => {
      const alias = /^\{([a-z0-9-]+)\}$/u.exec(themed(t, theme));
      return `  --${t.name}: ${alias === null ? colorOf(t.name, theme) : `var(--${alias[1]})`};`;
    }),
    ...tokens.shadow.tokens.map((t) => `  --${t.name}: ${resolved(themed(t, theme), theme)};`),
    ...tokens.shadow.tokens.filter((t) => READ.cssEdge.includes(t.name)).flatMap((t) => {
      const split = edgeAndDrop(t, theme);
      return [`  --${t.name}-edge: ${split.edge};`, `  --${t.name}-drop: ${split.drop};`];
    }),
    ...READ.cssMap.map((name) => `  --${name}: ${mapColor(name, theme)};`),
    `  color-scheme: ${theme.startsWith("light") ? "light" : "dark"};`,
  ];
  const ob = tokens.onboarding;
  const nightBlock = (mode: Night): string[] => [...ob.color, ...ob.shadow]
    .filter((t) => mode === "night" || t.value["night-hc"] !== undefined)
    .map((t) => `  --${t.name}: ${night(t, mode)};`);
  const contrastThemes = '[data-theme="dark-hc"], [data-theme="light-hc"]';
  const out = [
    ':root, [data-theme="dark"] {', ...block("dark"), "}",
    '@media (prefers-color-scheme: light) { :root:not([data-theme]) {', ...block("light"), "} }",
    '@media (prefers-contrast: more) { :root:not([data-theme]) {', ...block("dark-hc"), "} }",
    '@media (prefers-color-scheme: light) and (prefers-contrast: more) { :root:not([data-theme]) {', ...block("light-hc"), "} }",
    ...(["light", "dark-hc", "light-hc"] as const).flatMap((theme) => [`[data-theme="${theme}"] {`, ...block(theme), "}"]),
    "",
    ":root {", ...nightBlock("night"), "}",
    "@media (prefers-contrast: more) { :root:not([data-theme]) {", ...nightBlock("night-hc"), "} }",
    `${contrastThemes} {`, ...nightBlock("night-hc"), "}",
    "",
    ".ck-night {", ...block("dark"), "}",
    "@media (prefers-contrast: more) { :root:not([data-theme]) .ck-night, :root:not([data-theme]).ck-night {", ...block("dark-hc"), "} }",
    `${contrastThemes.split(", ").flatMap((theme) => [`${theme} .ck-night`, `${theme}.ck-night`]).join(", ")} {`, ...block("dark-hc"), "}",
    "",
    `@font-face { font-family: "${ob.font.family}"; src: url("${ob.font.src}") format("woff2"); font-weight: ${ob.font.weight}; font-display: block; }`,
    "",
    ":root {",
    ...[tokens.spacing, tokens.radius, tokens.size, tokens.stroke, tokens.opacity, tokens.duration, tokens.easing]
      .flatMap((family) => family.tokens.map((t) => `  --${t.name}: ${t.value as string};`)),
    ...Object.entries(tokens.type.families).map(([key, stack]) => `  --font-${key}: ${stack};`),
    `  --ob-font: "${ob.font.family}", ${tokens.type.families.sans};`,
    ...macStyles().map((s) => `  --${s.name}-size: ${s.fontSize};`),
    ...ob.type.map((s) => `  --${s.name}-size: ${s.fontSize};`),
    "}",
    "",
  ];
  const typeClass = (s: Style, family: string): string => {
    const rules = [`font-family: var(--${family})`, `font-size: ${s.fontSize}`, `line-height: ${s.lineHeight}`, `font-weight: ${s.fontWeight}`];
    if (s.letterSpacing !== undefined) rules.push(`letter-spacing: ${s.letterSpacing}`);
    if (s.fontStyle !== undefined) rules.push(`font-style: ${s.fontStyle}`);
    if (/figure/u.test(s.name)) rules.push("font-variant-numeric: tabular-nums");
    if (uppercase(s)) rules.push("text-transform: uppercase");
    return `.${s.name} { ${rules.join("; ")}; }`;
  };
  for (const group of macGroups()) {
    for (const s of group.styles) out.push(typeClass(s, `font-${s.family ?? group.family}`));
  }
  out.push(...ob.type.map((s) => typeClass(s, "ob-font")));
  return `${out.join("\n")}\n`;
}

const macGroups = (): readonly Group[] => tokens.type.groups.filter((g) => g.styles.every((s) => s.name.startsWith("mac-")));
const macStyles = (): readonly Style[] => macGroups().flatMap((g) => g.styles);

const uppercase = (s: Style): boolean => s.uppercase === true || /mono-label/u.test(s.name);

function signinCss(): string {
  const used = ["canvas", "surface", "border", "text", "text-secondary", "text-tertiary"];
  const block = (theme: ThemeId): string[] => [...used.map((name) => `  --${name}: ${colorOf(name, theme)};`), `  color-scheme: ${theme.startsWith("light") ? "light" : "dark"};`];
  const styles = new Map(tokens.type.groups.flatMap((group) => group.styles.map((s) => [s.name, { ...s, family: s.family ?? group.family }] as const)));
  const type = (name: string, scale = 1): string => {
    const s = styles.get(name);
    if (s === undefined) throw new Error(`no type style ${name}`);
    const rules = [`font-family: ${tokens.type.families[s.family]}`, `font-size: ${px(s.fontSize) * scale}px`, `line-height: ${px(s.lineHeight) * scale}px`, `font-weight: ${s.fontWeight}`];
    if (s.letterSpacing !== undefined) rules.push(`letter-spacing: ${s.letterSpacing}`);
    if (/figure/u.test(name)) rules.push("font-variant-numeric: tabular-nums");
    return rules.join("; ");
  };
  const value = (family: Family, name: string): string => {
    const token = family.tokens.find((t) => t.name === name);
    if (token === undefined) throw new Error(`no token ${name}`);
    return token.value as string;
  };
  return [
    ":root {", ...block("dark"), "}",
    "@media (prefers-color-scheme: light) { :root {", ...block("light"), "} }",
    "@media (prefers-contrast: more) { :root {", ...block("dark-hc"), "} }",
    "@media (prefers-color-scheme: light) and (prefers-contrast: more) { :root {", ...block("light-hc"), "} }",
    "",
    `* { box-sizing: border-box; margin: 0; }`,
    `body { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: ${value(tokens.spacing, "space-6")} ${value(tokens.spacing, "space-4")}; background: var(--canvas); color: var(--text); ${type("ios-body")}; }`,
    `.signin { width: 100%; max-width: 440px; padding: ${value(tokens.spacing, "space-8")} ${value(tokens.spacing, "space-6")}; background: var(--surface); border: 1px solid var(--border); border-radius: ${value(tokens.radius, "radius-lg")}; display: flex; flex-direction: column; gap: ${value(tokens.spacing, "space-4")}; }`,
    `.mark { width: ${value(tokens.spacing, "space-16")}; height: ${value(tokens.spacing, "space-16")}; }`,
    `.mark svg { display: block; width: 100%; height: 100%; }`,
    `.brand { ${type("ios-mono-label")}; text-transform: uppercase; color: var(--text-tertiary); }`,
    `h1 { ${type("ios-title-2")}; overflow-wrap: anywhere; }`,
    `.from { ${type("ios-subhead")}; color: var(--text-secondary); overflow-wrap: anywhere; }`,
    `.gets { ${type("ios-body")}; }`,
    `.number { ${type("ios-figure-xl", 1.5)}; white-space: nowrap; text-align: center; padding: ${value(tokens.spacing, "space-4")} 0; }`,
    `.how { ${type("ios-subhead")}; color: var(--text-secondary); text-align: center; }`,
    `.foot { ${type("ios-footnote")}; color: var(--text-tertiary); border-top: 1px solid var(--border); padding-top: ${value(tokens.spacing, "space-4")}; }`,
    `[hidden] { display: none !important; }`,
    "",
  ].join("\n");
}


const SWIFT_KEYWORDS = new Set(["private", "public", "internal", "default", "case", "return", "in", "is", "as", "do", "for", "if", "let", "var", "class", "struct", "enum", "func", "import", "init", "self", "super", "true", "false", "nil", "switch", "while", "repeat", "where", "static", "protocol", "extension", "operator", "throw", "throws", "try", "catch", "guard", "defer", "break", "continue", "fallthrough", "subscript", "deinit", "associatedtype", "typealias", "inout", "rethrows", "Any", "Self", "Type"]);
const camelRaw = (name: string): string => name.replace(/-([a-z0-9])/gu, (_, c: string) => c.toUpperCase());
const camel = (name: string): string => { const c = camelRaw(name); return SWIFT_KEYWORDS.has(c) ? `\`${c}\`` : c; };
const swiftName = (name: string, prefix: string): string => {
  const rest = camel(name.startsWith(prefix) ? name.slice(prefix.length) : name);
  return /^\d/u.test(rest) ? `s${rest}` : rest;
};
const px = (value: string): number => parseFloat(value);
const num = (n: number): string => (Number.isInteger(n) ? `${n}` : `${+n.toFixed(4)}`);

const IOS_TEXT_STYLE: Record<number, string> = { 34: ".largeTitle", 28: ".title", 22: ".title2", 20: ".title3", 17: ".body", 16: ".callout", 15: ".subheadline", 13: ".footnote", 12: ".caption", 11: ".caption2" };

function rgbaSwift(value: string): string {
  const c = rgba(value);
  return `RGBA(${num(c.r / 255)}, ${num(c.g / 255)}, ${num(c.b / 255)}, ${num(c.a)})`;
}

function shadowLayers(value: string): string {
  const layers = value.split(/,(?![^(]*\))/u).map((l) => l.trim());
  return `[${layers.map((l) => {
    const inset = l.startsWith("inset");
    const color = /(rgba?\([^)]*\)|#[0-9a-f]{3,8})/iu.exec(l)?.[1] ?? "rgba(0,0,0,0)";
    const nums = l.replace("inset", "").replace(color, "").trim().split(/\s+/u).map(px);
    const [x = 0, y = 0, blur = 0, spread = 0] = nums;
    return `.init(color: ${rgbaSwift(color)}, x: ${num(x)}, y: ${num(y)}, blur: ${num(blur)}, spread: ${num(spread)}, inset: ${inset})`;
  }).join(", ")}]`;
}

function swift(): string {
  const L: string[] = [
    "import SwiftUI",
    "",
    "public extension Cockpit {",
    "  enum Color {",
  ];
  for (const t of tokens.color.tokens) {
    const v = THEMES.map((theme) => rgbaSwift(colorOf(t.name, theme)));
    L.push(`    public static let ${camel(t.name)} = Cockpit.dynamic(dark: ${v[0]}, light: ${v[1]}, darkHC: ${v[2]}, lightHC: ${v[3]})`);
  }
  for (const t of tokens.map.tokens.filter((x) => READ.swiftMap.includes(x.name))) {
    const v = THEMES.map((theme) => rgbaSwift(mapColor(t.name, theme)));
    L.push(`    public static let ${camel(t.name)} = Cockpit.dynamic(dark: ${v[0]}, light: ${v[1]}, darkHC: ${v[2]}, lightHC: ${v[3]})`);
  }
  L.push("  }", "");
  const textStyle = (s: Style, family: string, name: string, indent: string): void => {
    const design = family === "mono" ? ".monospaced" : family === "serif" ? ".serif" : ".default";
    const size = px(s.fontSize);
    const appleStyle = s.name.startsWith("ios-") ? (IOS_TEXT_STYLE[size] ?? "nil") : "nil";
    const tracking = s.letterSpacing === undefined ? 0 : parseFloat(s.letterSpacing) * size;
    L.push(`${indent}public static let ${name} = TextStyle(size: ${num(size)}, lineHeight: ${num(px(s.lineHeight))}, weight: ${s.fontWeight}, design: ${design}, textStyle: ${appleStyle}, tracking: ${num(tracking)}, italic: ${s.fontStyle === "italic"}, tabular: ${/figure/u.test(s.name)}, uppercase: ${uppercase(s)})`);
  };
  L.push("  enum Style {");
  for (const group of tokens.type.groups) for (const s of group.styles) textStyle(s, s.family ?? group.family, camel(s.name), "    ");
  L.push("  }", "");
  const numbers = (title: string, doc: string, family: Family, prefix: string, unit: (v: string) => string): void => {
    L.push(`  enum ${title} {`);
    for (const t of family.tokens) L.push(`    public static let ${swiftName(t.name, prefix)}: ${unit === seconds ? "Double" : "CGFloat"} = ${unit(t.value as string)}`);
    L.push("  }", "");
  };
  const points = (v: string): string => num(px(v));
  const seconds = (v: string): string => num(px(v) / 1000);
  numbers("Space", "The 4-point spacing scale.", tokens.spacing, "space-", points);
  numbers("Radius", "Corner radii; inner shapes take the outer radius minus the inset.", tokens.radius, "radius-", points);
  numbers("Size", "Fixed dimensions: hit targets, controls, rows, icons, the stream's marks.", tokens.size, "size-", points);
  numbers("Stroke", "Line weights.", { tokens: tokens.stroke.tokens.filter((t) => !t.name.startsWith("dash")) }, "stroke-", points);
  numbers("Opacity", "Opacities.", tokens.opacity, "opacity-", (v) => v);
  numbers("Duration", "Durations, in seconds.", tokens.duration, "duration-", seconds);
  L.push("  enum Dash {");
  for (const t of tokens.stroke.tokens.filter((x) => x.name.startsWith("dash"))) L.push(`    public static let ${swiftName(t.name, "dash-")}: [CGFloat] = [${(t.value as string).split(/\s+/u).join(", ")}]`);
  L.push("  }", "");
  L.push("  enum Ease {");
  for (const t of tokens.easing.tokens) {
    const m = /cubic-bezier\(([^)]*)\)/u.exec(t.value as string);
    const [a, b, c, d] = m![1]!.split(",").map((x) => x.trim());
    if (t.name === "ease-spring") L.push("    public static func spring() -> Animation { .spring(response: 0.3, dampingFraction: 0.85) }");
    else L.push(`    public static func ${swiftName(t.name, "ease-")}(_ duration: Double) -> Animation { .timingCurve(${a}, ${b}, ${c}, ${d}, duration: duration) }`);
  }
  L.push("  }", "");
  L.push("  enum Shadow {");
  for (const t of tokens.shadow.tokens) {
    const v = THEMES.map((theme) => shadowLayers(resolved(themed(t, theme), theme)));
    L.push(`    public static let ${swiftName(t.name, "shadow-")} = ShadowSet(dark: ${v[0]}, light: ${v[1]}, darkHC: ${v[2]}, lightHC: ${v[3]})`);
  }
  L.push("  }", "");
  const ob = tokens.onboarding;
  L.push("  enum Onboarding {", "    public enum Color {");
  for (const t of ob.color.filter((x) => READ.swiftOnboarding.includes(x.name))) {
    const [n, hc] = (["night", "night-hc"] as const).map((mode) => rgbaSwift(night(t, mode)));
    L.push(`      public static let ${swiftName(t.name, "ob-")} = Cockpit.dynamic(dark: ${n}, light: ${n}, darkHC: ${hc}, lightHC: ${hc})`);
  }
  L.push("    }", "", "    public enum Shadow {");
  for (const t of ob.shadow) {
    const [n, hc] = (["night", "night-hc"] as const).map((mode) => shadowLayers(night(t, mode)));
    L.push(`      public static let ${swiftName(t.name, "ob-shadow-")} = ShadowSet(dark: ${n}, light: ${n}, darkHC: ${hc}, lightHC: ${hc})`);
  }
  L.push("    }", "  }", "}", "");
  return L.join("\n");
}


interface Op { readonly op: "m" | "l" | "c" | "z"; readonly p: readonly number[] }

function arcToCubics(x1: number, y1: number, rxIn: number, ryIn: number, rotation: number, large: boolean, sweep: boolean, x2: number, y2: number): number[][] {
  let rx = Math.abs(rxIn), ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return [[x1, y1, x2, y2, x2, y2]];
  const phi = (rotation * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy, yp = -sin * dx + cos * dy;
  const lambda = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
  const num2 = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const den = rx * rx * yp * yp + ry * ry * xp * xp;
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num2 / den));
  const cxp = (coef * rx * yp) / ry, cyp = (-coef * ry * xp) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2, cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const ux = (xp - cxp) / rx, uy = (yp - cyp) / ry, vx = (-xp - cxp) / rx, vy = (-yp - cyp) / ry;
  const start = angle(1, 0, ux, uy);
  let turn = angle(ux, uy, vx, vy);
  if (!sweep && turn > 0) turn -= 2 * Math.PI;
  if (sweep && turn < 0) turn += 2 * Math.PI;
  const segments = Math.max(1, Math.ceil(Math.abs(turn) / (Math.PI / 2) - 1e-9));
  const delta = turn / segments, k = (4 / 3) * Math.tan(delta / 4);
  const at = (ex: number, ey: number): number[] => [cx + rx * ex * cos - ry * ey * sin, cy + rx * ex * sin + ry * ey * cos];
  const out: number[][] = [];
  for (let i = 0; i < segments; i++) {
    const a = start + i * delta, b = a + delta;
    const c1 = at(Math.cos(a) - k * Math.sin(a), Math.sin(a) + k * Math.cos(a));
    const c2 = at(Math.cos(b) + k * Math.sin(b), Math.sin(b) - k * Math.cos(b));
    out.push([...c1, ...c2, ...(i === segments - 1 ? [x2, y2] : at(Math.cos(b), Math.sin(b)))]);
  }
  return out;
}

function pathOps(d: string): Op[] {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gu) ?? [];
  const ops: Op[] = [];
  const isCmd = (t: string | undefined): boolean => t !== undefined && /^[a-zA-Z]$/u.test(t);
  let i = 0, cmd = "", x = 0, y = 0, sx = 0, sy = 0;
  let lastC: number[] | null = null, lastQ: number[] | null = null;
  const n = (): number => {
    const t = tokens[i++];
    if (t === undefined || isCmd(t)) throw new Error(`icons: a number is missing in ${d.slice(0, 48)}…`);
    return +t;
  };
  const flag = (): boolean => {
    const t = tokens[i]!;
    if (t.length > 1) { tokens[i] = t.slice(1); return t[0] === "1"; }
    i++;
    return t === "1";
  };
  const cubic = (p: number[]): void => { ops.push({ op: "c", p }); x = p[4]!; y = p[5]!; };
  while (i < tokens.length) {
    if (isCmd(tokens[i])) cmd = tokens[i++]!;
    const rel = cmd === cmd.toLowerCase(), ox = rel ? x : 0, oy = rel ? y : 0;
    let nextC: number[] | null = null, nextQ: number[] | null = null;
    switch (cmd.toUpperCase()) {
      case "M": x = ox + n(); y = oy + n(); sx = x; sy = y; ops.push({ op: "m", p: [x, y] }); cmd = rel ? "l" : "L"; break;
      case "L": x = ox + n(); y = oy + n(); ops.push({ op: "l", p: [x, y] }); break;
      case "H": x = ox + n(); ops.push({ op: "l", p: [x, y] }); break;
      case "V": y = oy + n(); ops.push({ op: "l", p: [x, y] }); break;
      case "C": { const p = [ox + n(), oy + n(), ox + n(), oy + n(), ox + n(), oy + n()]; nextC = p.slice(2, 4); cubic(p); break; }
      case "S": {
        const c1: number[] = lastC === null ? [x, y] : [2 * x - lastC[0]!, 2 * y - lastC[1]!];
        const p: number[] = [...c1, ox + n(), oy + n(), ox + n(), oy + n()];
        nextC = p.slice(2, 4); cubic(p); break;
      }
      case "Q": case "T": {
        const q: number[] = cmd.toUpperCase() === "Q" ? [ox + n(), oy + n()] : lastQ === null ? [x, y] : [2 * x - lastQ[0]!, 2 * y - lastQ[1]!];
        const ex = ox + n(), ey = oy + n();
        nextQ = q;
        cubic([x + (2 / 3) * (q[0]! - x), y + (2 / 3) * (q[1]! - y), ex + (2 / 3) * (q[0]! - ex), ey + (2 / 3) * (q[1]! - ey), ex, ey]);
        break;
      }
      case "A": {
        const rx = n(), ry = n(), rot = n(), large = flag(), sweep = flag(), ex = ox + n(), ey = oy + n();
        for (const p of arcToCubics(x, y, rx, ry, rot, large, sweep, ex, ey)) cubic(p);
        break;
      }
      case "Z": ops.push({ op: "z", p: [] }); x = sx; y = sy; break;
      default: throw new Error(`icons: unknown path command ${cmd}`);
    }
    lastC = nextC; lastQ = nextQ;
  }
  return ops;
}

function swiftOps(paths: readonly string[]): string {
  const coord = (v: number): string => num(Math.round(v * 100) / 100);
  return `[${paths.flatMap(pathOps).map((o) => (o.op === "z" ? ".z" : `.${o.op}(${o.p.map(coord).join(", ")})`)).join(", ")}]`;
}

function iconsSwift(): string {
  const entries = Object.entries(icons.icons);
  const drawing = (meaning: string, data: IconEntry): string => data.stroke !== undefined
    ? `.own(stroke: IconDrawing.${camel(meaning)}, solid: ${data.solid === undefined ? "nil" : `IconDrawing.${camelRaw(meaning)}Solid`})`
    : `.phosphor(regular: IconDrawing.${camel(meaning)}, fill: ${data.fill === undefined ? "nil" : `IconDrawing.${camelRaw(meaning)}Fill`})`;
  const L: string[] = [
    "import CoreGraphics",
    "",
    "public extension Cockpit {",
    "  enum Icon: String, CaseIterable, Sendable {",
    ...entries.map(([meaning]) => `    case ${camel(meaning)} = "${meaning}"`),
    "    public var phosphorName: String? {",
    "      switch self {",
    ...entries.map(([meaning, data]) => `      case .${camel(meaning)}: return ${data.phosphor === undefined ? "nil" : `"${data.phosphor}"`}`),
    "      }",
    "    }",
    "  }",
    "",
    "  enum IconDrawing: Sendable {",
    "    case phosphor(regular: [PathOp], fill: [PathOp]?)",
    "    case own(stroke: [PathOp], solid: [PathOp]?)",
    "  }",
    "}",
    "",
    "extension Cockpit.Icon {",
    "  var drawing: Cockpit.IconDrawing {",
    "    switch self {",
    ...entries.map(([meaning, data]) => `    case .${camel(meaning)}: return ${drawing(meaning, data)}`),
    "    }",
    "  }",
    "}",
    "",
    "private enum IconDrawing {",
  ];
  for (const [meaning, data] of entries) {
    L.push(`  static let ${camel(meaning)}: [Cockpit.PathOp] = ${swiftOps(data.stroke ?? data.regular ?? [])}`);
    if (data.fill !== undefined) L.push(`  static let ${camelRaw(meaning)}Fill: [Cockpit.PathOp] = ${swiftOps(data.fill)}`);
    if (data.solid !== undefined) L.push(`  static let ${camelRaw(meaning)}Solid: [Cockpit.PathOp] = ${swiftOps(data.solid)}`);
  }
  L.push("}", "");
  return L.join("\n");
}


const TILES = "https://tiles.openfreemap.org/planet";
const GLYPHS = "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf";
const ATTRIBUTION = '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> '
  + '<a href="https://www.openmaptiles.org/" target="_blank">© OpenMapTiles</a> '
  + 'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';
const FONT = { regular: ["Noto Sans Regular"], bold: ["Noto Sans Bold"], italic: ["Noto Sans Italic"] };

function mapColor(name: string, theme: ThemeId): string {
  const token = tokens.map.tokens.find((t) => t.name === name);
  if (token === undefined || typeof token.value === "string") throw new Error(`no map token ${name}`);
  return themed(token, theme);
}

type Expression = unknown[];
type Layer = Record<string, unknown>;
const geometry = (...types: string[]): Expression => ["match", ["geometry-type"], types, true, false];
const classIs = (...classes: string[]): Expression => ["match", ["get", "class"], classes, true, false];
const kindIs = (...kinds: string[]): Expression => ["match", ["get", "kind"], kinds, true, false];
const byZoom = (...stops: number[]): Expression => ["interpolate", ["exponential", 1.4], ["zoom"], ...stops];
const latinName: Expression = ["coalesce", ["get", "name_en"], ["get", "name:latin"], ["get", "name"]];
const hot: Expression = ["boolean", ["feature-state", "hot"], false];
const clustered: Expression = ["has", "point_count"];
const gathered: Expression = ["max", 1, ["get", "places"]];
const clusterR = 9;
const gatheredWords: Expression = ["case", [">=", gathered, 1000],
  ["concat", ["to-string", ["/", ["round", ["/", gathered, 100]], 10]], "k"], ["to-string", gathered]];
const reachPx: Expression = ["interpolate", ["exponential", 2], ["zoom"],
  ...[8, 10, 12, 14, 16, 18, 20, 22].flatMap((zoom) => [zoom, ["max", ["+", ["get", "r"], 6], ["*", ["get", "reach0"], 2 ** zoom]]])];

const REACH_NAMED_PX = 90;
const focusNameOffset: Expression = ["interpolate", ["exponential", 2], ["zoom"],
  ...[8, 10, 12, 14, 16, 18, 20, 22].flatMap((zoom) => [zoom, ["/", ["let", "px", ["*", ["coalesce", ["get", "reach0"], 0], 2 ** zoom],
    ["case", [">", ["var", "px"], REACH_NAMED_PX], ["+", ["get", "r"], 11], ["+", ["max", ["var", "px"], ["+", ["get", "r"], 6]], 11]]], 12]])];

function mapStyle(theme: ThemeId): Record<string, unknown> {
  const map = (name: string): string => mapColor(`map-${name}`, theme);
  const token = (name: string): string => colorOf(name, theme);
  const halo = { "text-halo-color": map("land"), "text-halo-width": 1.5, "text-halo-blur": 0.5 };
  const fill = (id: string, layer: string, filter: Expression, color: string, more: Layer = {}, opacity: unknown = 1): Layer => ({
    id, type: "fill", source: "base", "source-layer": layer, filter: ["all", geometry("Polygon", "MultiPolygon"), filter],
    ...more, paint: { "fill-color": color, "fill-antialias": false, "fill-opacity": opacity },
  });
  const road = (id: string, classes: string[], color: string, minzoom: number, width: Expression, opacity: unknown = 1): Layer => ({
    id, type: "line", source: "base", "source-layer": "transportation", minzoom,
    filter: ["all", geometry("LineString", "MultiLineString"), classIs(...classes), ["!=", ["get", "brunnel"], "tunnel"]],
    layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": color, "line-width": width, "line-opacity": opacity },
  });
  const place = (id: string, classes: string[], zooms: Layer, layout: Layer, color: string): Layer => ({
    id, type: "symbol", source: "base", "source-layer": "place", ...zooms,
    filter: ["all", geometry("Point", "MultiPoint"), classIs(...classes)],
    layout: { "text-field": latinName, "text-max-width": 8, "text-padding": 4, ...layout }, paint: { ...halo, "text-color": color },
  });
  const caps = { "text-font": FONT.bold, "text-transform": "uppercase", "text-letter-spacing": 0.14 };
  const discEdge = { "circle-stroke-color": token("canvas"), "circle-stroke-width": 1.5, "circle-pitch-alignment": "map" };
  const quick = { duration: 150, delay: 0 };
  return {
    version: 8,
    name: `${tokens.name} · ${theme}`,
    glyphs: GLYPHS,
    sources: {
      base: { type: "vector", url: TILES, attribution: ATTRIBUTION },
      marks: { type: "geojson", data: { type: "FeatureCollection", features: [] }, promoteId: "key", cluster: true,
        clusterRadius: 28, clusterMaxZoom: 17,
        clusterProperties: { weight: ["+", ["get", "weight"]], places: ["+", ["get", "places"]] } },
      life: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
    },
    layers: [
      { id: "land", type: "background", paint: { "background-color": map("land") } },
      fill("green", "landcover", classIs("wood", "grass", "farmland"), map("green"), {}, byZoom(4, 0.4, 10, 0.8)),
      fill("park", "landuse", classIs("park", "cemetery", "pitch", "playground", "garden"), map("green")),
      fill("park-area", "park", ["literal", true], map("green"), {}, 0.7),
      fill("water", "water", ["!=", ["get", "brunnel"], "tunnel"], map("water")),
      { id: "waterway", type: "line", source: "base", "source-layer": "waterway", filter: ["!=", ["get", "brunnel"], "tunnel"],
        layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": map("water"), "line-width": byZoom(8, 0.5, 18, 6) } },
      fill("building", "building", ["literal", true], map("building"), { minzoom: 14.5 }, byZoom(14.5, 0, 16, 1)),
      { id: "boundary", type: "line", source: "base", "source-layer": "boundary", maxzoom: 10,
        filter: ["all", ["==", ["get", "admin_level"], 2], ["!=", ["get", "maritime"], 1]],
        paint: { "line-color": map("boundary"), "line-width": byZoom(2, 0.75, 9, 1.25), "line-dasharray": [3, 2] } },
      road("road-path", ["path", "track"], map("path"), 15.5, byZoom(15.5, 0.75, 20, 3), byZoom(15.5, 0, 16.5, 1)),
      road("road-minor", ["minor", "service"], map("road-minor"), 12, byZoom(12, 0.5, 14, 1, 20, 14), byZoom(12, 0.3, 15, 1)),
      road("road-major", ["primary", "secondary", "tertiary", "trunk"], map("road-major"), 7, byZoom(7, 0.5, 12, 1.5, 14, 2.5, 20, 22)),
      road("road-motorway", ["motorway"], map("road-motorway"), 5, byZoom(5, 0.5, 12, 2, 14, 3, 20, 26)),
      { id: "water-name", type: "symbol", source: "base", "source-layer": "water_name", minzoom: 3,
        filter: geometry("Point", "MultiPoint"),
        layout: { "text-field": latinName, "text-font": FONT.italic, "text-size": byZoom(3, 11, 12, 12), "text-max-width": 8,
          "text-letter-spacing": 0.02 },
        paint: { ...halo, "text-color": map("name-water") } },
      { id: "park-name", type: "symbol", source: "base", "source-layer": "park", minzoom: 14, filter: geometry("Point"),
        layout: { "text-field": latinName, "text-font": FONT.regular, "text-size": 10.5, "text-max-width": 8, "text-padding": 6 },
        paint: { ...halo, "text-color": map("name-park") } },
      { id: "street-name", type: "symbol", source: "base", "source-layer": "transportation_name", minzoom: 14.5,
        filter: ["all", geometry("LineString", "MultiLineString"), classIs("primary", "secondary", "tertiary", "minor", "trunk")],
        layout: { "text-field": latinName, "text-font": FONT.regular, "text-size": 10.5, "symbol-placement": "line",
          "symbol-spacing": 420, "text-max-angle": 28, "text-rotation-alignment": "map", "text-padding": 8 },
        paint: { ...halo, "text-color": map("name-street"), "text-opacity": 0.6 } },
      place("area-name", ["suburb", "neighbourhood", "quarter"], { minzoom: 12.5, maxzoom: 16 },
        { ...caps, "text-size": 10, "text-max-width": 7 }, map("name-area")),
      place("town-name", ["town", "village"], { minzoom: 9, maxzoom: 14 },
        { "text-font": FONT.regular, "text-size": byZoom(9, 11, 13, 13) }, token("text-tertiary")),
      { ...place("city-name", ["city"], { minzoom: 5, maxzoom: 13 }, { "text-font": FONT.regular,
        "text-size": byZoom(5, 11, 10, 14), "symbol-sort-key": ["get", "rank"] }, token("text-secondary")),
      filter: ["all", geometry("Point", "MultiPoint"), classIs("city"), ["<=", ["coalesce", ["get", "rank"], 99], ["step", ["zoom"], 3, 7, 6, 9, 99]]] },
      place("country-name", ["country"], { maxzoom: 6 }, { ...caps, "text-size": 10 }, map("name-area")),
      { id: "life-reach", type: "circle", source: "life", filter: ["all", kindIs("disc", "ring"), ["get", "focus"]],
        paint: { "circle-radius": reachPx, "circle-color": token("here"), "circle-opacity": 0.04,
          "circle-stroke-color": token("here"), "circle-stroke-width": 1.5, "circle-stroke-opacity": 0.8,
          "circle-pitch-alignment": "map" } },
      { id: "life-hot-reach", type: "circle", source: "marks", filter: ["all", ["!", clustered], ["has", "reach0"]],
        paint: { "circle-radius": reachPx, "circle-color": token("life"), "circle-opacity": ["case", hot, 0.07, 0],
          "circle-stroke-color": token("life"), "circle-stroke-width": 1.5, "circle-stroke-opacity": ["case", hot, 0.9, 0],
          "circle-pitch-alignment": "map", "circle-opacity-transition": quick, "circle-stroke-opacity-transition": quick } },
      { id: "life-disc", type: "circle", source: "marks", filter: ["!", clustered],
        layout: { "circle-sort-key": ["-", 0, ["get", "r"]] },
        paint: { "circle-radius": ["+", ["get", "r"], ["case", hot, 1.5, 0]],
          "circle-color": token("life"), ...discEdge,
          "circle-radius-transition": quick } },
      { id: "life-cluster", type: "circle", source: "marks", filter: clustered,
        paint: { "circle-radius": ["+", clusterR, ["case", hot, 1.5, 0]],
          "circle-color": token("life"), ...discEdge,
          "circle-radius-transition": quick } },
      { id: "life-cluster-count", type: "symbol", source: "marks", filter: clustered,
        layout: { "text-field": gatheredWords, "text-font": FONT.bold, "text-size": 11,
          "text-allow-overlap": true, "text-ignore-placement": true },
        paint: { "text-color": token("life-glyph") } },
      { id: "life-ring", type: "circle", source: "life", filter: ["all", kindIs("ring"), ["!", ["get", "focus"]]],
        paint: { "circle-radius": ["get", "r"], "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": token("text-secondary"),
          "circle-stroke-width": 1.5, "circle-pitch-alignment": "map" } },
      { id: "life-focus-halo", type: "circle", source: "life", filter: ["all", kindIs("disc", "ring"), ["get", "focus"]],
        paint: { "circle-radius": ["max", 10, ["+", ["get", "r"], 6]], "circle-color": token("here"), "circle-opacity": 0.25,
          "circle-pitch-alignment": "map" } },
      { id: "life-focus", type: "circle", source: "life", filter: ["all", kindIs("disc", "ring"), ["get", "focus"]],
        paint: { "circle-radius": ["max", 6, ["+", ["get", "r"], 2]], "circle-color": token("here"), "circle-stroke-color": token("canvas"),
          "circle-stroke-width": 1.5, "circle-pitch-alignment": "map" } },
      { id: "life-here-halo", type: "circle", source: "life", filter: kindIs("here"),
        paint: { "circle-radius": 10, "circle-color": token("here"), "circle-opacity": 0.25 } },
      { id: "life-here", type: "circle", source: "life", filter: kindIs("here"),
        paint: { "circle-radius": 6, "circle-color": token("here"), "circle-stroke-color": token("canvas"), "circle-stroke-width": 1.5 } },
      { id: "life-name", type: "symbol", source: "marks", filter: ["all", ["!", clustered], ["!=", ["get", "label"], ""]],
        layout: { "text-field": ["get", "label"], "text-font": FONT.regular, "text-size": 11, "text-max-width": 9,
          "text-padding": 3, "symbol-sort-key": ["-", 0, ["get", "weight"]],
          "text-variable-anchor": ["bottom", "top", "right", "left"], "text-radial-offset": ["/", ["+", ["get", "r"], 4], 11],
          "text-justify": "auto" },
        paint: { ...halo, "text-color": ["case", hot, token("text"), token("text-secondary")],
          "text-color-transition": quick } },
      { id: "life-focus-name", type: "symbol", source: "life",
        filter: ["all", kindIs("disc"), ["get", "focus"], ["!=", ["coalesce", ["get", "label"], ""], ""]],
        layout: { "text-field": ["get", "label"], "text-font": FONT.bold, "text-size": 12, "text-max-width": 10,
          "text-padding": 3, "text-variable-anchor": ["bottom", "top", "right", "left"],
          "text-radial-offset": focusNameOffset, "text-justify": "auto" },
        paint: { ...halo, "text-halo-width": 2, "text-color": token("text") } },
      { id: "life-lit-name", type: "symbol", source: "life",
        filter: ["all", kindIs("here"), ["!=", ["coalesce", ["get", "label"], ""], ""]],
        layout: { "text-field": ["get", "label"], "text-font": FONT.bold, "text-size": 12, "text-max-width": 10,
          "text-padding": 3, "text-variable-anchor": ["top", "bottom", "right", "left"], "text-radial-offset": 1.75,
          "text-justify": "auto" },
        paint: { ...halo, "text-halo-width": 2, "text-color": token("text") } },
      ...[["marks", ["coalesce", ["get", "r"], clusterR], ["literal", true], 0],
        ["life", ["coalesce", ["get", "r"], 8], kindIs("disc", "ring", "here"), 26]].map(([source, r, filter, least]) => ({
        id: `life-room-${source as string}`, type: "symbol", source, filter,
        layout: { "text-field": "O", "text-font": FONT.regular, "text-size": ["max", ["*", r, 1.5], least], "text-allow-overlap": true,
          "text-ignore-placement": false, "text-padding": 0 },
        paint: { "text-opacity": 0 } })),
    ],
  };
}


function healthSwift(): string {
  const cases = tokens.health.states.map((state) => (state.name.includes("-") ? `case ${camel(state.name)} = "${state.name}"` : `case ${state.name}`));
  const by = (signal: string | null) => tokens.health.states.filter((state) => state.signal === signal).map((state) => `.${camel(state.name)}`).join(", ");
  const signals = [...new Set(tokens.health.states.map((state) => state.signal))];
  return [
    "import SwiftUI",
    "",
    "public extension Cockpit {",
    "    enum HealthState: String, CaseIterable, Sendable {",
    ...cases.map((each) => `        ${each}`),
    "",
    "        public var signal: SignalKind? {",
    "            switch self {",
    ...signals.map((signal) => `            case ${by(signal)}: ${signal === null ? "nil" : `.${signal}`}`),
    "            }",
    "        }",
    "",
    "        public var word: String? {",
    "            switch self {",
    ...tokens.health.states.map((state) => `            case .${camel(state.name)}: ${state.word === null ? "nil" : JSON.stringify(state.word)}`),
    "            }",
    "        }",
    "    }",
    "}",
    "",
  ].join("\n");
}

const healthStates = (): string => `${JSON.stringify(Object.fromEntries(tokens.health.states.map((state) => [state.name, { signal: state.signal, word: state.word }])), null, 2)}\n`;

function launchBackground(): string {
  const components = (theme: ThemeId): string => {
    const c = rgba(colorOf("canvas", theme));
    const f = (v: number): string => v.toFixed(3);
    return `"components" : { "alpha" : "${f(c.a)}", "blue" : "${f(c.b / 255)}", "green" : "${f(c.g / 255)}", "red" : "${f(c.r / 255)}" }`;
  };
  return [
    "{", '  "colors" : [',
    "    {", "      \"color\" : {", '        "color-space" : "srgb",', `        ${components("light")}`, "      },", '      "idiom" : "universal"', "    },",
    "    {", '      "appearances" : [ { "appearance" : "luminosity", "value" : "dark" } ],', "      \"color\" : {", '        "color-space" : "srgb",',
    `        ${components("dark")}`, "      },", '      "idiom" : "universal"', "    }",
    "  ],", '  "info" : { "author" : "xcode", "version" : 1 }', "}", "",
  ].join("\n");
}

const mapStyles = (): string => `${JSON.stringify(Object.fromEntries(THEMES.map((theme) => [theme, mapStyle(theme)])))}\n`;


if (process.argv.includes("--watch")) {
  const run = (): void => { spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], { stdio: "inherit" }); };
  let pending: NodeJS.Timeout | undefined;
  watch(DESIGN, (_, file) => { if (file === "tokens.json" || file === "icons.json") { clearTimeout(pending); pending = setTimeout(run, 50); } });
  run();
  console.log("design: watching design/tokens.json and design/icons.json");
} else {
  main();
}

function main(): void {
  const fails = promises();
  if (fails.length > 0) {
    console.error(`design: ${fails.length} contrast promise(s) broken:\n${fails.join("\n")}`);
    process.exit(1);
  }
  const outputs: [string, string][] = [
    [join(DESIGN, "css", "cockpit.css"), css()],
    [join(ROOT, "mcp", "signin.css"), signinCss()],
    [join(DESIGN, "swift", "Sources", "Cockpit", "Tokens.swift"), swift()],
    [join(DESIGN, "swift", "Sources", "Cockpit", "Icons.swift"), iconsSwift()],
    [join(ROOT, "dashboard", "public", "ui", "kit", "map-style.json"), mapStyles()],
    [join(DESIGN, "swift", "Sources", "Cockpit", "Components", "HealthState.swift"), healthSwift()],
    [join(ROOT, "dashboard", "public", "ui", "kit", "health-states.json"), healthStates()],
    [join(ROOT, "ios-app", "LifestreamCapture", "Resources", "Assets.xcassets", "LaunchBackground.colorset", "Contents.json"), launchBackground()],
  ];
  if (process.argv.includes("--check")) {
    const stale = outputs.filter(([path, text]) => { try { return readFileSync(path, "utf8") !== text; } catch { return true; } });
    for (const [path] of stale) console.error(`design: ${path.slice(ROOT.length + 1)} is not what design/tokens.json makes; run npx tsx tools/design.ts`);
    process.exit(stale.length > 0 ? 1 : 0);
  }
  for (const [path, text] of outputs) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    console.log(`design: wrote ${path.slice(ROOT.length + 1)}`);
  }
}
