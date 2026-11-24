
type Dimension = string;

export interface UnitValue {
  factor: number;
  dimension: Dimension;
  offset?: number;
}

const PREFIXES: Record<string, number> = {
  p: 1e-12, n: 1e-9, mc: 1e-6, "µ": 1e-6, m: 1e-3, c: 1e-2, d: 1e-1, da: 1e1, h: 1e2, k: 1e3, M: 1e6, G: 1e9, T: 1e12,
};

interface Base { factor: number; bases: Record<string, number>; prefixed?: true; offset?: number }

const UNITS: Record<string, Base> = {
  g: { factor: 1, bases: { g: 1 }, prefixed: true },
  lb: { factor: 453.59237, bases: { g: 1 } },
  oz: { factor: 28.349523125, bases: { g: 1 } },
  st: { factor: 6350.29318, bases: { g: 1 } },
  m: { factor: 1, bases: { m: 1 }, prefixed: true },
  in: { factor: 0.0254, bases: { m: 1 } },
  ft: { factor: 0.3048, bases: { m: 1 } },
  yd: { factor: 0.9144, bases: { m: 1 } },
  mi: { factor: 1609.344, bases: { m: 1 } },
  L: { factor: 1e-3, bases: { m: 3 }, prefixed: true },
  fl_oz_us: { factor: 29.5735295625e-6, bases: { m: 3 } },
  fl_oz_imp: { factor: 28.4130625e-6, bases: { m: 3 } },
  cup_us: { factor: 236.5882365e-6, bases: { m: 3 } },
  cup_imp: { factor: 284.130625e-6, bases: { m: 3 } },
  pt_us: { factor: 473.176473e-6, bases: { m: 3 } },
  pt_imp: { factor: 568.26125e-6, bases: { m: 3 } },
  s: { factor: 1, bases: { s: 1 }, prefixed: true },
  min: { factor: 60, bases: { s: 1 } },
  hr: { factor: 3600, bases: { s: 1 } },
  d: { factor: 86_400, bases: { s: 1 } },
  Hz: { factor: 1, bases: { s: -1 }, prefixed: true },
  J: { factor: 1000, bases: { g: 1, m: 2, s: -2 }, prefixed: true },
  cal: { factor: 4184, bases: { g: 1, m: 2, s: -2 }, prefixed: true },
  Cal: { factor: 4_184_000, bases: { g: 1, m: 2, s: -2 } },
  kcal: { factor: 4_184_000, bases: { g: 1, m: 2, s: -2 } },
  W: { factor: 1000, bases: { g: 1, m: 2, s: -3 }, prefixed: true },
  Pa: { factor: 1000, bases: { g: 1, m: -1, s: -2 }, prefixed: true },
  mmHg: { factor: 133_322.387415, bases: { g: 1, m: -1, s: -2 } },
  cmAq: { factor: 98_066.5, bases: { g: 1, m: -1, s: -2 } },
  atm: { factor: 101_325_000, bases: { g: 1, m: -1, s: -2 } },
  K: { factor: 1, bases: { K: 1 }, prefixed: true, offset: 0 },
  degC: { factor: 1, bases: { K: 1 }, offset: 273.15 },
  degF: { factor: 5 / 9, bases: { K: 1 }, offset: 459.67 * 5 / 9 },
  count: { factor: 1, bases: {} },
  "%": { factor: 1, bases: {} },
  rad: { factor: 1, bases: {}, prefixed: true },
  deg: { factor: Math.PI / 180, bases: {} },
  S: { factor: 1, bases: { S: 1 }, prefixed: true },
  V: { factor: 1, bases: { V: 1 }, prefixed: true },
  IU: { factor: 1, bases: { IU: 1 } },
  dBASPL: { factor: 1, bases: { dBASPL: 1 } },
  dBHL: { factor: 1, bases: { dBHL: 1 } },
  lx: { factor: 1, bases: { lx: 1 }, prefixed: true },
  fc: { factor: 10.763910416709722, bases: { lx: 1 } },
  appleEffortScore: { factor: 1, bases: { appleEffortScore: 1 } },
  D: { factor: 1, bases: { D: 1 } },
};

const BASE_ORDER = ["g", "m", "s", "K", "S", "V", "IU", "dBASPL", "dBHL", "lx", "appleEffortScore", "D"];

export function unitValue(spelling: string): UnitValue | undefined {
  const parsed = attempt(() => quotient(spelling.trim()));
  if (parsed === undefined) return undefined;
  const dimension = BASE_ORDER.filter((base) => (parsed.bases[base] ?? 0) !== 0).map((base) => `${base}^${parsed.bases[base]}`).join(" ");
  const alone = UNITS[spelling.trim()];
  return { factor: parsed.factor, dimension, ...(alone?.offset !== undefined ? { offset: alone.offset } : {}) };
}

export function convert(value: number, from: UnitValue, to: UnitValue): number | undefined {
  if (from.dimension !== to.dimension) return undefined;
  if (from.offset !== undefined && to.offset !== undefined) return (value * from.factor + from.offset - to.offset) / to.factor;
  return (value * from.factor) / to.factor;
}

interface Parsed { factor: number; bases: Record<string, number> }

function attempt(read: () => Parsed): Parsed | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function quotient(text: string): Parsed {
  const parts = split(text, "/");
  const [first, ...rest] = parts.map(product);
  return rest.reduce((sum, part) => combine(sum, part, -1), first!);
}

function product(text: string): Parsed {
  const factors = split(text, "·*");
  return factors.map(power).reduce((sum, part) => combine(sum, part, 1), { factor: 1, bases: {} });
}

function power(text: string): Parsed {
  const match = /^(.*?)(?:\^(-?\d+))?$/u.exec(text)!;
  const body = match[1]!;
  const exponent = match[2] === undefined ? 1 : Number(match[2]);
  const unit = body.startsWith("(") && body.endsWith(")") ? quotient(body.slice(1, -1)) : one(body);
  return { factor: unit.factor ** exponent, bases: Object.fromEntries(Object.entries(unit.bases).map(([base, n]) => [base, n * exponent])) };
}

function one(text: string): Parsed {
  const mole = /^(p|n|mc|µ|m|c|d|da|h|k|M|G|T)?mol<([0-9.]+)>$/u.exec(text);
  if (mole !== null) {
    const grams = Number(mole[2]);
    if (!Number.isFinite(grams) || grams <= 0) throw new Error("molar mass");
    return { factor: (mole[1] === undefined ? 1 : PREFIXES[mole[1]]!) * grams, bases: { g: 1 } };
  }
  const exact = UNITS[text];
  if (exact !== undefined) return { factor: exact.factor, bases: { ...exact.bases } };
  for (const prefix of Object.keys(PREFIXES).sort((a, b) => b.length - a.length)) {
    if (!text.startsWith(prefix)) continue;
    const unit = UNITS[text.slice(prefix.length)];
    if (unit?.prefixed === true) return { factor: PREFIXES[prefix]! * unit.factor, bases: { ...unit.bases } };
  }
  throw new Error(`unit ${text}`);
}

function combine(a: Parsed, b: Parsed, sign: 1 | -1): Parsed {
  const bases = { ...a.bases };
  for (const [base, n] of Object.entries(b.bases)) bases[base] = (bases[base] ?? 0) + sign * n;
  return { factor: sign === 1 ? a.factor * b.factor : a.factor / b.factor, bases };
}

function split(text: string, marks: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    if (char === "(") depth++;
    else if (char === ")") depth--;
    else if (depth === 0 && marks.includes(char)) {
      parts.push(text.slice(from, at));
      from = at + 1;
    }
    if (depth < 0) throw new Error("parentheses");
  }
  parts.push(text.slice(from));
  if (depth !== 0 || parts.some((part) => part.length === 0)) throw new Error("empty");
  return parts;
}
