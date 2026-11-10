// Captures microphone PCM in the audio thread and sends it to the page. Stays on device.
class UtaRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.buf = new Float32Array(4096);
    this.n = 0;
    this.firstFrame = -1;
    this.peak = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.on = true; this.firstFrame = -1; this.n = 0; }
      if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ done: true }); }
    };
  }
  flush() {
    if (this.n > 0) {
      const out = this.buf.slice(0, this.n);
      this.port.postMessage({ pcm: out, peak: this.peak }, [out.buffer]);
      this.n = 0; this.peak = 0;
    }
  }
  process(inputs) {
    const inp = inputs[0];
    if (this.on && inp && inp.length) {
      const ch = inp[0];
      if (this.firstFrame < 0) { this.firstFrame = currentFrame; this.port.postMessage({ firstFrame: currentFrame }); }
      for (let i = 0; i < ch.length; i++) {
        let s = ch[i];
        if (inp.length > 1) s = (s + inp[1][i]) * 0.5;
        this.buf[this.n++] = s;
        const a = s < 0 ? -s : s;
        if (a > this.peak) this.peak = a;
        if (this.n === this.buf.length) this.flush();
      }
    }
    return true;
  }
}
registerProcessor('uta-recorder', UtaRecorder);
