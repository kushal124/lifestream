// @ts-check
import { downsampler, levelOf, RATE, seconds } from '../../lib/ask-media.js';

const LEVEL_SAMPLES = RATE / 10;

/** @typedef {{ stop: () => Promise<Uint8Array>, cancel: () => void }} Recording */

/**
 * @param {{ second: (k: number, bytes: Uint8Array) => void, level: (level: number) => void, full: () => void }} hear
 * @param {number} most
 * @returns {Promise<Recording>}
 */
export async function record(hear, most) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  const context = new AudioContext();
  const release = () => {
    for (const track of stream.getTracks()) track.stop();
    void context.close().catch(() => undefined);
  };
  try {
    await context.audioWorklet.addModule(new URL('ui/ask/worklet.js', document.baseURI));
  } catch (error) {
    release();
    throw error;
  }
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, 'lifestream-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
  const quiet = context.createGain();
  quiet.gain.value = 0;
  source.connect(node).connect(quiet).connect(context.destination);
  const down = downsampler(context.sampleRate);
  const cut = seconds(most);
  let k = 0;
  /** @type {Int16Array[]} */
  let pending = [];
  let counted = 0;
  /** @type {() => void} */
  let flushed = () => undefined;
  node.port.onmessage = event => {
    if (event.data === 'flushed') return flushed();
    if (cut.full) return;
    const samples = down(/** @type {Float32Array} */ (event.data));
    for (const done of cut.push(samples)) hear.second(k++, done);
    if (cut.full) return hear.full();
    pending.push(samples);
    counted += samples.length;
    if (counted < LEVEL_SAMPLES) return;
    const joined = new Int16Array(counted);
    let at = 0;
    for (const part of pending) {
      joined.set(part, at);
      at += part.length;
    }
    hear.level(levelOf(joined));
    pending = [];
    counted = 0;
  };
  return {
    async stop() {
      await new Promise(done => {
        flushed = () => done(undefined);
        node.port.postMessage('flush');
      });
      node.port.onmessage = null;
      release();
      return cut.rest();
    },
    cancel() {
      node.port.onmessage = null;
      release();
    },
  };
}
