// @ts-check

const scope = /** @type {{ registerProcessor: (name: string, processor: unknown) => void,
  AudioWorkletProcessor: new () => { port: MessagePort } }} */ (/** @type {unknown} */ (globalThis));

const BLOCK = 2048;

class Capture extends scope.AudioWorkletProcessor {
  constructor() {
    super();
    this.held = new Float32Array(BLOCK);
    this.filled = 0;
    this.port.onmessage = event => {
      if (event.data !== 'flush') return;
      this.post();
      this.port.postMessage('flushed');
    };
  }

  post() {
    if (!this.filled) return;
    const block = this.held.slice(0, this.filled);
    this.port.postMessage(block, [block.buffer]);
    this.filled = 0;
  }

  /** @param {Float32Array[][]} inputs */
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let at = 0;
    while (at < channel.length) {
      const taken = Math.min(BLOCK - this.filled, channel.length - at);
      this.held.set(channel.subarray(at, at + taken), this.filled);
      this.filled += taken;
      at += taken;
      if (this.filled === BLOCK) this.post();
    }
    return true;
  }
}

scope.registerProcessor('lifestream-capture', Capture);
