/* ...existing code... */
class BytebeatProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { sr = 8000, bits = 8, exprSrc = "t" } = options.processorOptions || {};
    this.bits = bits;
    this.byteSr = sr;
    this.t = 0;
    this.fn = this._compile(exprSrc);
    this.ratio = sampleRate / this.byteSr; // host SR / bytebeat SR
    this.acc = 0;
    this.port.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'update') {
        this.byteSr = msg.sr || this.byteSr;
        this.bits = msg.bits || this.bits;
        this.fn = this._compile(msg.exprSrc || "t");
        this.ratio = sampleRate / this.byteSr;
      }
    };
  }
  _compile(src) {
    try {
      // Support custom gate operator `/--/`:
      // any `A /--/ B` becomes `__gate(A)`; B is ignored since the gate is unary.
      const processed = String(src).replace(
        /([^\s()]+)\s*\/--\/\s*([^\s()]+)/g,
        '__gate($1)'
      );
      return new Function(
        't',
        `"use strict"; const __gate=(x)=>{const v=Math.abs(x*(x*x));return v>100?0:x/2;}; const fol=(A,op,B)=>{let v=op;for(let i=0;i<A;i++) v-=B;return v;}; const tol=(A,op,B)=>{let v=op;for(let i=0;i<B;i++) v+=A;return v;}; return (${processed});`
      );
    } catch {
      return (t) => 0;
    }
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      // advance t when enough host samples elapsed
      this.acc += 1;
      if (this.acc >= this.ratio) {
        this.t++;
        this.acc -= this.ratio;
      }
      let v = this.fn(this.t) || 0;
      let s;
      if (this.bits === 8) {
        s = ((v & 255) - 128) / 128; // map 0..255 to -1..1
      } else {
        v = Math.max(-32768, Math.min(32767, v|0));
        s = v / 32768;
      }
      out[i] = s;
    }
    return true;
  }
}
registerProcessor('bytebeat-processor', BytebeatProcessor);

class ImageProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { buffer = null, sr = 8000 } = options.processorOptions || {};
    this.buffer = buffer;
    this.sr = sr;
    this.ratio = sampleRate / this.sr;
    this.acc = 0;
    this.idx = 0;
    this.port.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.type === 'update') {
        this.buffer = msg.buffer || this.buffer;
        this.sr = msg.sr || this.sr;
        this.ratio = sampleRate / this.sr;
        this.idx = 0;
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0][0];
    if (!this.buffer || this.buffer.length === 0) {
      out.fill(0);
      return true;
    }
    for (let i = 0; i < out.length; i++) {
      this.acc += 1;
      if (this.acc >= this.ratio) {
        this.idx = (this.idx + 1) % this.buffer.length;
        this.acc -= this.ratio;
      }
      const v = this.buffer[this.idx]; // 0..255
      out[i] = (v - 128) / 128;
    }
    return true;
  }
}
registerProcessor('image-processor', ImageProcessor);
/* ...existing code... */

