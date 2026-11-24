import { mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ensureArtifact, findPassages, removeArtifact, type FindMark, type FindAnswer } from "@lifestreamprotocol/model";
import { marksOf, readsLabels, Unspelled, type Token } from "./decode.js";
import { DETECTOR_FILES, type DetectorRow } from "./files.js";
import { Failed, type Library } from "./library.js";
import { Broken, checkedLoad, oneModel, type Disposable } from "./one-model.js";


export interface Classifier extends Disposable {
  readonly width: number;
  classify(batch: readonly (readonly number[])[]): Promise<ArrayLike<number>[]>;
}

export const BATCH_TOKENS = 2_048;

export function padded(batch: readonly (readonly number[])[]): { ids: BigInt64Array; mask: BigInt64Array; shape: [number, number] } {
  const length = Math.max(...batch.map((ids) => ids.length));
  const ids = new BigInt64Array(batch.length * length);
  const mask = new BigInt64Array(batch.length * length);
  batch.forEach((passage, row) => passage.forEach((id, index) => {
    ids[row * length + index] = BigInt(id);
    mask[row * length + index] = 1n;
  }));
  return { ids, mask, shape: [batch.length, length] };
}

export function logProbabilities(batch: readonly (readonly number[])[], dims: readonly number[], data: Float32Array): Float32Array[] {
  const length = Math.max(...batch.map((ids) => ids.length));
  const [rows, columns, width] = dims;
  if (dims.length !== 3 || rows !== batch.length || columns !== length || width === undefined || width < 1 || data.length !== rows * length * width) {
    throw new Error(`the graph answered logits of [${dims.join(", ")}] for a batch of [${batch.length}, ${length}]`);
  }
  return batch.map((passage, row) => {
    const scores = new Float32Array(passage.length * width);
    for (let token = 0; token < passage.length; token++) {
      const at = (row * length + token) * width;
      let most = -Infinity;
      for (let label = 0; label < width; label++) {
        if (!Number.isFinite(data[at + label]!)) throw new Error(`the graph answered a logit that is no number, at token ${token} of row ${row}`);
        most = Math.max(most, data[at + label]!);
      }
      let sum = 0;
      for (let label = 0; label < width; label++) sum += Math.exp(data[at + label]! - most);
      const total = most + Math.log(sum);
      for (let label = 0; label < width; label++) scores[token * width + label] = data[at + label]! - total;
    }
    return scores;
  });
}

export type LoadClassifier = (path: string) => Promise<Classifier>;

export type LoadOn = (path: string, providers: readonly string[]) => Promise<Classifier>;

export function providersFor(platform: string, arch: string): readonly string[] {
  return platform === "darwin" && arch === "arm64" ? ["webgpu", "cpu"] : ["cpu"];
}

export function withFallback(providers: readonly string[], loadOn: LoadOn, log: (line: string) => void): LoadClassifier {
  let on = providers;
  const toCpu = (why: string): void => {
    if (on[0] === "cpu") return;
    log(`runner: the detector runs on the CPU until the runner restarts: ONNX Runtime's ${on[0]} ${why}`);
    on = ["cpu"];
  };
  const watched = (provider: string, classifier: Classifier): Classifier => ({
    width: classifier.width,
    async classify(batch) {
      try {
        return await classifier.classify(batch);
      } catch (error) {
        toCpu(`failed a run: ${messageOf(error)}`);
        throw new Broken(`the detector's ${provider} session failed a run: ${messageOf(error)}`, { cause: error });
      }
    },
    dispose: () => classifier.dispose(),
  });
  return async (path) => {
    if (on[0] === "cpu") return loadOn(path, on);
    const provider = on[0]!;
    let failed: unknown;
    try {
      return watched(provider, await loadOn(path, on));
    } catch (error) {
      failed = error;
    }
    const classifier = await loadOn(path, ["cpu"]);
    toCpu(`made no session: ${messageOf(failed)}`);
    return classifier;
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Tokens {
  tokens(passage: string): { ids: number[]; tokens: Token[] };
}

interface Detector extends Disposable {
  readonly tokenizer: Tokens;
  readonly labels: readonly string[];
  readonly classifier: Classifier;
}

const loadOnnx: LoadOn = async (path, providers) => {
  const ort = await import("onnxruntime-node");
  const session = await ort.InferenceSession.create(path, { executionProviders: providers });
  if (session.inputNames.join() !== "input_ids,attention_mask") {
    void session.release();
    throw new Error(`the graph takes ${session.inputNames.join(", ")}, not input_ids and attention_mask`);
  }
  const output = session.outputMetadata[0];
  const width = output?.isTensor === true ? output.shape[2] : undefined;
  if (output?.isTensor !== true || output.shape.length !== 3 || typeof width !== "number") {
    void session.release();
    throw new Error(`the graph answers ${JSON.stringify(output)}, not logits of a batch's tokens by a known count of labels`);
  }
  return {
    width,
    async classify(batch) {
      const { ids, mask, shape } = padded(batch);
      const out = await session.run({ input_ids: new ort.Tensor("int64", ids, shape), attention_mask: new ort.Tensor("int64", mask, shape) });
      const logits = out[session.outputNames[0]!]!;
      return logProbabilities(batch, logits.dims as readonly number[], logits.data as Float32Array);
    },
    dispose() {
      void session.release();
    },
  };
};

async function tokenizerOf(tokenizer: string, config: string): Promise<Tokens> {
  const { Tokenizer } = await import("@huggingface/tokenizers");
  const made = new Tokenizer(JSON.parse(readFileSync(tokenizer, "utf8")) as object, JSON.parse(readFileSync(config, "utf8")) as object);
  const added = new Set(made.get_added_tokens_decoder().keys());
  return {
    tokens(passage) {
      const { ids, tokens } = made.encode(passage, { add_special_tokens: false });
      return { ids, tokens: tokens.map((text: string, index: number) => ({ text, added: added.has(ids[index]!) })) };
    },
  };
}

function labelsOf(config: string): string[] {
  const { id2label } = JSON.parse(readFileSync(config, "utf8")) as { id2label?: Record<string, string> };
  const labels = Object.entries(id2label ?? {}).sort(([a], [b]) => Number(a) - Number(b)).map(([, label]) => label);
  if (labels.length === 0 || !readsLabels(labels)) throw new Error(`the model's labels are none this decoding reads: ${labels.join(", ")}`);
  return labels;
}

export function batches(passages: readonly (readonly number[])[]): number[][] {
  const order = passages.map((_, index) => index).filter((index) => passages[index]!.length > 0).sort((a, b) => passages[a]!.length - passages[b]!.length);
  const made: number[][] = [];
  for (const index of order) {
    const last = made.at(-1);
    if (last !== undefined && (last.length + 1) * passages[index]!.length <= BATCH_TOKENS) last.push(index);
    else made.push([index]);
  }
  return made;
}

export function detectorLibrary(folder: string, load: LoadClassifier = withFallback(providersFor(process.platform, process.arch), loadOnnx, (line) => process.stderr.write(`${line}\n`))): Library {
  const pathOf = (row: DetectorRow, name: (typeof DETECTOR_FILES)[number]): string => join(folder, row.id, basename(new URL(row.source[name].url).pathname));
  const models = oneModel<DetectorRow, Detector>((row) => checkedLoad(row.id, DETECTOR_FILES.map((name) => ({ path: pathOf(row, name), artifact: row.source[name] })), async () => {
    const labels = labelsOf(pathOf(row, "config"));
    const tokenizer = await tokenizerOf(pathOf(row, "tokenizer"), pathOf(row, "tokenizer_config"));
    const classifier = await load(pathOf(row, "graph"));
    if (classifier.width !== labels.length) {
      classifier.dispose();
      throw new Error(`the graph scores ${classifier.width} labels, and the model has ${labels.length}`);
    }
    return { tokenizer, labels, classifier, dispose: () => classifier.dispose() };
  }));

  return {
    async fetch(row, progress, signal) {
      const detector = row as DetectorRow;
      mkdirSync(join(folder, row.id), { recursive: true });
      let done = 0;
      for (const name of DETECTOR_FILES) {
        const artifact = detector.source[name];
        await ensureArtifact(artifact, pathOf(detector, name), { signal, progress: (bytes) => progress(done + bytes) });
        done += artifact.bytes;
        progress(done);
      }
    },
    async remove(row, signal) {
      const detector = row as DetectorRow;
      await models.letGo(detector, signal);
      for (const name of DETECTOR_FILES) await removeArtifact(pathOf(detector, name), signal);
    },
    async run(row, call, signal) {
      const detector = row as DetectorRow;
      const passages = findPassages(call.input);
      if (passages === null) throw new Failed("unreadable", `${row.id} finds in a list of passages, and the call's input is none`);
      return models.use(detector, signal, async (model) => {
        const loaded = await model();
        const tokens = passages.map((passage) => loaded.tokenizer.tokens(passage));
        const scores: ArrayLike<number>[] = tokens.map(() => []);
        for (const batch of batches(tokens.map((each) => each.ids))) {
          signal.throwIfAborted();
          const found = await loaded.classifier.classify(batch.map((index) => tokens[index]!.ids));
          batch.forEach((index, row) => (scores[index] = found[row]!));
        }
        const marks = passages.map((passage, index): FindMark[] | null => {
          try {
            return marksOf(passage, tokens[index]!.tokens, loaded.labels, scores[index]!);
          } catch (error) {
            if (!(error instanceof Unspelled)) throw error;
            return null;
          }
        });
        const found: FindAnswer = { file: detector.key.file, decode: detector.key.decode, marks };
        return { text: JSON.stringify(found), model: row.id };
      });
    },
    close: () => models.close(),
  };
}
