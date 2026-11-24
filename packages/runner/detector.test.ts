import { describe, expect, it } from "vitest";
import { BATCH_TOKENS, batches, logProbabilities, padded, providersFor, withFallback, type Classifier } from "./detector.js";
import { Broken } from "./one-model.js";

describe("the detector's batches", () => {
  it("pads every passage to the longest with its padding masked, and reads each token's log-probabilities from its own row", () => {
    const batch = [[7], [5, 6, 9]];
    const { ids, mask, shape } = padded(batch);
    expect(shape).toEqual([2, 3]);
    expect([...ids]).toEqual([7n, 0n, 0n, 5n, 6n, 9n]);
    expect([...mask]).toEqual([1n, 0n, 0n, 1n, 1n, 1n]);
    const data = Float32Array.from([0.9, 0.1, 0, 5, 0, 5, 0.2, 0.8, 0.7, 0.3, 0.1, 0.9]);
    const scores = logProbabilities(batch, [2, 3, 2], data);
    expect(scores.map((row) => row.length)).toEqual([2, 6]);
    const logits = [[0.9, 0.1], [0.2, 0.8, 0.7, 0.3, 0.1, 0.9]];
    scores.forEach((row, index) => {
      for (let token = 0; token < row.length / 2; token++) {
        const [a, b] = [logits[index]![token * 2]!, logits[index]![token * 2 + 1]!];
        const total = Math.log(Math.exp(a) + Math.exp(b));
        expect(row[token * 2]).toBeCloseTo(a - total, 6);
        expect(row[token * 2 + 1]).toBeCloseTo(b - total, 6);
        expect(Math.exp(row[token * 2]!) + Math.exp(row[token * 2 + 1]!)).toBeCloseTo(1, 6);
      }
    });
    expect([...logProbabilities([[1]], [1, 1, 2], Float32Array.from([1_000, 0]))[0]!]).toEqual([0, -1_000]);
  });

  it("refuses logits of another shape than the batch's, or one that is no number", () => {
    const batch = [[7], [5, 6]];
    const good = Float32Array.from([1, 0, 1, 0, 1, 0, 1, 0]);
    expect(() => logProbabilities(batch, [2, 2, 2], good)).not.toThrow();
    expect(() => logProbabilities(batch, [2, 1, 2], good.subarray(0, 4))).toThrow(/logits of \[2, 1, 2\]/u);
    expect(() => logProbabilities(batch, [1, 2, 2], good.subarray(0, 4))).toThrow(/logits/u);
    expect(() => logProbabilities(batch, [2, 2, 2], good.subarray(0, 6))).toThrow(/logits/u);
    expect(() => logProbabilities(batch, [2, 2], good.subarray(0, 4))).toThrow(/logits/u);
    expect(() => logProbabilities(batch, [2, 2, 0], new Float32Array(0))).toThrow(/logits/u);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => logProbabilities(batch, [2, 2, 2], Float32Array.from([1, 0, 1, 0, 1, bad, 1, 0]))).toThrow(/no number/u);
    }
  });

  it("puts every passage with a token in one batch, shortest first, each batch within the bound, and one longer alone", () => {
    const lengths = [0, 3, 2_000, 400, 1, 3_000, 400, 700, 2];
    const passages = lengths.map((length) => Array.from({ length }, () => 1));
    const made = batches(passages);
    expect(made.flat().sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(made.flat().map((index) => lengths[index])).toEqual([1, 2, 3, 400, 400, 700, 2_000, 3_000]);
    for (const batch of made) {
      const longest = Math.max(...batch.map((index) => lengths[index]!));
      expect(batch.length === 1 || batch.length * longest <= BATCH_TOKENS).toBe(true);
    }
    expect(made.at(-1)).toEqual([5]);
  });
});

describe("where the detector's graph runs", () => {
  it("runs on WebGPU then the CPU on Apple silicon, on the CPU alone everywhere else", () => {
    expect(providersFor("darwin", "arm64")).toEqual(["webgpu", "cpu"]);
    expect(providersFor("darwin", "x64")).toEqual(["cpu"]);
    expect(providersFor("linux", "arm64")).toEqual(["cpu"]);
    expect(providersFor("linux", "x64")).toEqual(["cpu"]);
    expect(providersFor("win32", "x64")).toEqual(["cpu"]);
  });

  function played(refuses: (providers: readonly string[]) => string | null, fails: (providers: readonly string[]) => string | null = () => null) {
    const tries: string[][] = [];
    const said: string[] = [];
    const loadOn = async (path: string, providers: readonly string[]): Promise<Classifier> => {
      tries.push([...providers]);
      const why = refuses(providers);
      if (why !== null) throw new Error(why);
      return {
        width: 2,
        classify: async () => {
          const failed = fails(providers);
          if (failed !== null) throw new Error(failed);
          return [];
        },
        dispose: () => {},
      };
    };
    return { tries, said, log: (line: string) => said.push(line), loadOn };
  }

  it("loads on the GPU when it makes a session, and says nothing", async () => {
    const run = played(() => null);
    const load = withFallback(["webgpu", "cpu"], run.loadOn, run.log);
    await load("/graph.onnx");
    await load("/graph.onnx");
    expect(run.tries).toEqual([["webgpu", "cpu"], ["webgpu", "cpu"]]);
    expect(run.said).toEqual([]);
  });

  it("loads on the CPU when the GPU makes no session, says why once, and never tries the GPU again", async () => {
    const run = played((providers) => (providers[0] === "webgpu" ? "no adapter" : null));
    const load = withFallback(["webgpu", "cpu"], run.loadOn, run.log);
    await expect(load("/graph.onnx")).resolves.toBeDefined();
    await expect(load("/graph.onnx")).resolves.toBeDefined();
    expect(run.tries).toEqual([["webgpu", "cpu"], ["cpu"], ["cpu"]]);
    expect(run.said).toHaveLength(1);
    expect(run.said[0]).toMatch(/runs on the CPU until the runner restarts: ONNX Runtime's webgpu made no session: no adapter/u);
  });

  it("fails a graph the CPU fails too as the CPU's, says nothing of the GPU, and keeps the GPU for the next load", async () => {
    let broken = true;
    const run = played((providers) => (broken ? `${providers[0]}: no such graph` : null));
    const load = withFallback(["webgpu", "cpu"], run.loadOn, run.log);
    await expect(load("/graph.onnx")).rejects.toThrow("cpu: no such graph");
    expect(run.said).toEqual([]);
    broken = false;
    await load("/graph.onnx");
    expect(run.tries).toEqual([["webgpu", "cpu"], ["cpu"], ["webgpu", "cpu"]]);
  });

  it("loads on the CPU alone where the CPU is the platform's, its failure the load's", async () => {
    const run = played(() => "no such graph");
    const load = withFallback(["cpu"], run.loadOn, run.log);
    await expect(load("/graph.onnx")).rejects.toThrow("no such graph");
    expect(run.tries).toEqual([["cpu"]]);
    expect(run.said).toEqual([]);
  });

  it("fails a find whose GPU session fails its run as Broken, says why once, and loads the next on the CPU; a CPU run that fails is its own", async () => {
    let lost = true;
    const run = played(() => null, (providers) => (providers[0] === "webgpu" && lost ? "the device was lost" : providers[0] === "cpu" ? "cpu: a bad batch" : null));
    const load = withFallback(["webgpu", "cpu"], run.loadOn, run.log);
    const gpu = await load("/graph.onnx");
    await expect(gpu.classify([[1]])).rejects.toSatisfy((error) => error instanceof Broken && /webgpu session failed a run: the device was lost/u.test(error.message));
    await expect(gpu.classify([[1]])).rejects.toBeInstanceOf(Broken);
    expect(run.said).toEqual(["runner: the detector runs on the CPU until the runner restarts: ONNX Runtime's webgpu failed a run: the device was lost"]);
    lost = false;
    const cpu = await load("/graph.onnx");
    expect(run.tries).toEqual([["webgpu", "cpu"], ["cpu"]]);
    await expect(cpu.classify([[1]])).rejects.toSatisfy((error) => !(error instanceof Broken) && (error as Error).message === "cpu: a bad batch");
    expect(run.said).toHaveLength(1);
  });
});
