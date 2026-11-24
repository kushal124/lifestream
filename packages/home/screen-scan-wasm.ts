
export const DIM = 512;
export const ROW_BYTES = DIM + 4;

const PAGE = 65536;

export function scanLayout(rows: number): { ask: number; out: number; rows: number; pages: number } {
  const ask = 0;
  const out = DIM * 4;
  const start = out + rows * 4;
  return { ask, out, rows: start, pages: Math.ceil((start + rows * ROW_BYTES) / PAGE) };
}

export function scanModuleBytes(pages: number): Uint8Array {
  const $rows = 0, $n = 1, $ask = 2, $out = 3, $end = 4, $q = 5, $qend = 6, $a = 7, $b = 8, $c = 9, $d = 10, $x = 11, $w = 12;
  const get = (local: number) => [0x20, local];
  const set = (local: number) => [0x21, local];
  const tee = (local: number) => [0x22, local];
  const i32 = (value: number) => [0x41, ...sleb(value)];
  const simd = (op: number, ...rest: number[]) => [0xfd, ...uleb(op), ...rest];
  const load = (offset: number) => simd(0x00, 0, ...uleb(offset));
  const zero = simd(0x0c, ...new Array<number>(16).fill(0));
  const [I8_LOW, I8_HIGH, I16_LOW, I16_HIGH, F_ADD, F_MUL, CONVERT, EXTRACT] = [0x87, 0x88, 0xa7, 0xa8, 0xe4, 0xe6, 0xfa, 0x1f];
  const sum = (acc: number, half: number, offset: number) => [
    ...get(acc), ...get($w), ...simd(half), ...simd(CONVERT), ...get($q), ...load(offset), ...simd(F_MUL), ...simd(F_ADD), ...set(acc),
  ];
  const body = [
    ...get($n), 0x45, 0x04, 0x40, 0x0f, 0x0b,
    ...get($rows), ...get($n), ...i32(ROW_BYTES), 0x6c, 0x6a, ...set($end),
    ...get($ask), ...i32(DIM * 4), 0x6a, ...set($qend),
    0x03, 0x40,
    ...zero, ...set($a), ...zero, ...set($b), ...zero, ...set($c), ...zero, ...set($d),
    ...get($ask), ...set($q),
    0x03, 0x40,
    ...get($rows), ...load(0), ...set($x),
    ...get($x), ...simd(I8_LOW), ...set($w),
    ...sum($a, I16_LOW, 0), ...sum($b, I16_HIGH, 16),
    ...get($x), ...simd(I8_HIGH), ...set($w),
    ...sum($c, I16_LOW, 32), ...sum($d, I16_HIGH, 48),
    ...get($rows), ...i32(16), 0x6a, ...set($rows),
    ...get($q), ...i32(64), 0x6a, ...tee($q), ...get($qend), 0x49, 0x0d, 0,
    0x0b,
    ...get($a), ...get($b), ...simd(F_ADD), ...get($c), ...get($d), ...simd(F_ADD), ...simd(F_ADD), ...set($a),
    ...get($out),
    ...get($a), ...simd(EXTRACT, 0), ...get($a), ...simd(EXTRACT, 1), 0x92, ...get($a), ...simd(EXTRACT, 2), ...get($a), ...simd(EXTRACT, 3), 0x92, 0x92,
    ...get($rows), 0x2a, 2, 0,
    0x94, 0x38, 2, 0,
    ...get($out), ...i32(4), 0x6a, ...set($out),
    ...get($rows), ...i32(4), 0x6a, ...tee($rows), ...get($end), 0x49, 0x0d, 0,
    0x0b,
    0x0b,
  ];
  const locals = [2, 3, 0x7f, 6, 0x7b];
  const fn = [...locals, ...body];
  const name = (text: string) => [...uleb(text.length), ...Buffer.from(text, "ascii")];
  const section = (id: number, content: number[]) => [id, ...uleb(content.length), ...content];
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [1, 0x60, 4, 0x7f, 0x7f, 0x7f, 0x7f, 0]),
    ...section(3, [1, 0]),
    ...section(5, [1, 0x00, ...uleb(pages)]),
    ...section(7, [2, ...name("memory"), 0x02, 0, ...name("scan"), 0x00, 0]),
    ...section(10, [1, ...uleb(fn.length), ...fn]),
  ]);
}

function uleb(value: number): number[] {
  const out: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    out.push(byte);
  } while (value !== 0);
  return out;
}

function sleb(value: number): number[] {
  const out: number[] = [];
  for (;;) {
    const byte = value & 0x7f;
    value >>= 7;
    if ((value === 0 && (byte & 0x40) === 0) || (value === -1 && (byte & 0x40) !== 0)) return [...out, byte];
    out.push(byte | 0x80);
  }
}
