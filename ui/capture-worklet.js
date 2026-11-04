'use strict';
// Runs on the audio thread: collects the 128-frame render quanta into small blocks and hands them to the page.
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() { super(); this.block = new Float32Array(512); this.filled = 0; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.block[this.filled++] = channel[i];
      if (this.filled === this.block.length) { const out = this.block; this.block = new Float32Array(out.length); this.filled = 0; this.port.postMessage(out, [out.buffer]); }
    }
    return true;
  }
}
registerProcessor('capture-processor', CaptureProcessor);
