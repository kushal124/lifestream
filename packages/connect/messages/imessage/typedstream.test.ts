import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { decodeAttributedBody } from "./typedstream.js";

const record: Record<string, unknown> = {};


function attributedBody(text: string, group?: string): Uint8Array {
  const NEW = 0x84;
  const NIL = 0x85;
  const END = 0x86;
  const encode = (value: string) => [...new TextEncoder().encode(value)];
  const unshared = (bytes: number[]) => [bytes.length, ...bytes];
  const shared = (value: string) => [NEW, ...unshared(encode(value))];
  const classes = (chain: [string, number][]) => [...chain.flatMap(([name, version]) => [NEW, ...shared(name), version]), NIL];
  return Uint8Array.from([
    4, 11, ...encode("streamtyped"), 0x81, 0xe8, 0x03,
    ...shared("@"), NEW, ...classes([["NSMutableAttributedString", 0], ["NSObject", 0]]),
    0x92, NEW, ...classes([["NSMutableString", 1], ["NSString", 1], ["NSObject", 0]]),
    ...(group === undefined ? [...shared("+"), ...unshared(encode(text))] : shared(group)), END, END,
  ]);
}

describe("the attributedBody decoder: what must be impossible", () => {
  it("a typedstream body decoded wrong, or hostile bytes throwing instead of refusing", () => {
    const text = "Running late, there in 10 \u{1F44B} café";
    const archive = attributedBody(text);
    expect(decodeAttributedBody(archive)).toEqual({ text });
    for (let length = 0; length < archive.length; length++) {
      const result = decodeAttributedBody(archive.subarray(0, length));
      expect("refused" in result, `prefix ${length}`).toBe(true);
    }
    expect(decodeAttributedBody(Uint8Array.from([4, 11, ...new TextEncoder().encode("typedstream"), 0x81, 0xe8, 0x03]))).toMatchObject({ refused: "bad-header" });
    const badUtf8 = attributedBody("ab");
    badUtf8[badUtf8.length - 4] = 0xff;
    expect(decodeAttributedBody(badUtf8)).toMatchObject({ refused: "bad-utf8" });
    let state = 1;
    const random = () => (state = (state * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
    for (let trial = 0; trial < 500; trial++) {
      const noise = Uint8Array.from({ length: 1 + Math.floor(random() * 80) }, () => Math.floor(random() * 256));
      const result = decodeAttributedBody(Uint8Array.from([...archive.subarray(0, 18), ...noise]));
      expect(typeof result).toBe("object");
    }
    record.typedstream = { text, bytes: archive.length };
  });

  it("a typedstream array whose elements read no bytes keeps a helper decoding for ever", async () => {
    const module = fileURLToPath(new URL("./typedstream.ts", import.meta.url));
    const hostile = ["[1000000000000!]", "[3[1000000000000!]]", "{x=[1000000000000!]}"];
    const results: { group: string; result: unknown }[] = [];
    for (const group of hostile) {
      const bytes = [...attributedBody("", group)];
      const script = `import { decodeAttributedBody } from ${JSON.stringify(module)};
        process.stdout.write(JSON.stringify(decodeAttributedBody(Uint8Array.from(${JSON.stringify(bytes)}))));`;
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
      onTestFinished(() => void child.kill("SIGKILL"));
      let out = "";
      child.stdout.on("data", (chunk: Buffer) => void (out += chunk.toString("utf8")));
      const [status] = (await once(child, "close")) as [number | null];
      expect(status, group).toBe(0);
      results.push({ group, result: JSON.parse(out) as unknown });
    }
    for (const { group, result } of results) expect(result, group).toMatchObject({ refused: "unknown-shape" });
    record.hostileArrays = results;
  });

});
