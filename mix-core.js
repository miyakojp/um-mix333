/* UtaMix mix renderer (runs inside the worker).
   A plain-JavaScript copy of the playback effect chain (EQ, de-esser, compressor, saturation, colour FX,
   doubler, pan, reverb, delay, groups, master limiter). Used for 書き出し / バランス / バックグラウンド再生
   instead of the browser's OfflineAudioContext, which can freeze or crash on iPhone.
   The filter / compressor / panner / convolver maths follows the Web Audio specification and the
   compressor algorithm used by the browsers, so the result sounds the same as playback. */
'use strict';
(function (G) {
  const MIX = {};
  const dbToGain = (d) => Math.pow(10, d / 20);
  const lin2db = (x) => 20 * Math.log10(x);
  const HALF_PI = Math.PI / 2;

  const REVERB_TYPES = {
    room: { decay: 0.9, damp: 0.55, pre: 10 },
    plate: { decay: 1.7, damp: 0.35, pre: 20 },
    hall: { decay: 2.8, damp: 0.5, pre: 30 },
  };
  const DELAY_NOTES = { '1/4': 1, '1/8': 0.5, '1/8.': 0.75, '1/16': 0.25 };
  const COLOR_TYPES = {
    none: {},
    phone: { hp: 450, lp: 3200, q: 0.9, drive: 0.45 },
    radio: { hp: 280, lp: 4500, q: 0.8, drive: 0.25, bits: 9 },
    megaphone: { hp: 750, lp: 2600, q: 2.2, drive: 0.95 },
    robot: { hp: 70, lp: 9000, q: 0.7, drive: 0.12, ring: 55 },
    lofi: { hp: 180, lp: 3800, q: 0.7, drive: 0.2, bits: 6 },
  };

  // ---------- same generators as audio-engine.js ----------
  function makeIR(type, sr) {
    const t = REVERB_TYPES[type] || REVERB_TYPES.plate;
    const pre = Math.round(sr * t.pre / 1000);
    const len = pre + Math.round(sr * t.decay * 0.85);
    let seed = 12345 + type.length * 777;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
    const out = [];
    for (let ch = 0; ch < 2; ch++) {
      const d = new Float32Array(len);
      let lp = 0;
      for (let i = pre; i < len; i++) {
        const tt = (i - pre) / sr;
        const env = Math.exp(-6.9 * tt / t.decay);
        const a = Math.min(0.95, t.damp * (0.15 + tt / t.decay));
        lp = lp * a + rnd() * (1 - a);
        let er = 0;
        if (tt < 0.08) er = (Math.abs(rnd()) > 0.985 ? rnd() * 2.5 : 0);
        // smooth build-up (no harsh burst at the start) and a soft fade at the very end (no cut-off tail)
      const rise = 1 - Math.exp(-tt / (type === 'hall' ? 0.012 : type === 'plate' ? 0.003 : 0.005));
      const tailFade = Math.min(1, (len - i) / (0.08 * sr));
      d[i] = (lp * 1.6 * rise + er) * env * tailFade;
      }
      out.push(d);
    }
    return out;
  }
  function satCurve(amount, bits) {
    const n = 2048, c = new Float32Array(n);
    const k = 1 + amount * 6;
    const norm = Math.tanh(k);
    const steps = bits ? Math.pow(2, bits - 1) : 0;
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1) * 2 - 1;
      let v = Math.tanh(k * x) / norm;
      if (steps) v = Math.round(v * steps) / steps;
      c[i] = v;
    }
    return c;
  }
  function deessCurve(amount) {
    const n = 1024, c = new Float32Array(n);
    const thrDb = -12 - amount * 30, ratio = 6;
    for (let i = 0; i < n; i++) {
      const x = Math.abs(i / (n - 1) * 2 - 1);
      const db = 20 * Math.log10(x + 1e-9);
      const over = Math.max(0, db - thrDb);
      const red = Math.min(18, over * (1 - 1 / ratio)) * (amount > 0 ? 1 : 0);
      c[i] = Math.pow(10, -red / 20) - 1;
    }
    return c;
  }
  // WaveShaper curve lookup (Web Audio spec)
  function shape(curve, x) {
    const n = curve.length;
    const v = (n - 1) / 2 * (x + 1);
    if (v <= 0) return curve[0];
    if (v >= n - 1) return curve[n - 1];
    const k = Math.floor(v), f = v - k;
    return (1 - f) * curve[k] + f * curve[k + 1];
  }

  // ---------- biquad (Web Audio spec formulas; lowpass/highpass Q is in dB) ----------
  class BQ {
    constructor(type, f0, q, g, sr) {
      const nyq = sr / 2;
      this.s = [new Float64Array(4), new Float64Array(4)];
      if (f0 >= nyq) {
        if (type === 'highpass') { this.c = [0, 0, 0, 0, 0]; return; }
        this.c = [1, 0, 0, 0, 0]; return;
      }
      const w = 2 * Math.PI * f0 / sr, cs = Math.cos(w), sn = Math.sin(w);
      const A = Math.pow(10, (g || 0) / 40);
      let b0, b1, b2, a0, a1, a2;
      if (type === 'lowpass' || type === 'highpass') {
        const al = sn / (2 * Math.pow(10, (q == null ? 1 : q) / 20));
        if (type === 'lowpass') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; }
        else { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; }
        a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al;
      } else if (type === 'peaking') {
        const al = sn / (2 * (q || 1));
        b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A;
      } else {
        const alS = sn / 2 * Math.SQRT2, sA = 2 * alS * Math.sqrt(A);
        if (type === 'lowshelf') {
          b0 = A * ((A + 1) - (A - 1) * cs + sA); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - sA);
          a0 = (A + 1) + (A - 1) * cs + sA; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - sA;
        } else {
          b0 = A * ((A + 1) + (A - 1) * cs + sA); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - sA);
          a0 = (A + 1) - (A - 1) * cs + sA; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - sA;
        }
      }
      this.c = [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
    }
    run(x, ch) {
      const c = this.c, s = this.s[ch];
      const b0 = c[0], b1 = c[1], b2 = c[2], a1 = c[3], a2 = c[4];
      let x1 = s[0], x2 = s[1], y1 = s[2], y2 = s[3];
      for (let i = 0; i < x.length; i++) {
        const xi = x[i];
        let yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        if (yi < 1e-25 && yi > -1e-25) yi = 0;
        x2 = x1; x1 = xi; y2 = y1; y1 = yi; x[i] = yi;
      }
      s[0] = x1; s[1] = x2; s[2] = y1; s[3] = y2;
    }
    step(xi, ch) {
      const c = this.c, s = this.s[ch];
      let yi = c[0] * xi + c[1] * s[0] + c[2] * s[1] - c[3] * s[2] - c[4] * s[3];
      if (yi < 1e-25 && yi > -1e-25) yi = 0;
      s[1] = s[0]; s[0] = xi; s[3] = s[2]; s[2] = yi;
      return yi;
    }
  }

  // ---------- DynamicsCompressor (the algorithm used inside the browsers) ----------
  class Comp {
    constructor(sr, threshold, knee, ratio, attack, release) {
      this.sr = sr;
      this.preN = Math.round(0.006 * sr);
      this.size = 1; while (this.size < this.preN + 2) this.size <<= 1;
      this.mask = this.size - 1;
      this.buf = [new Float32Array(this.size), new Float32Array(this.size)];
      this.w = this.preN; this.r = 0;
      this.det = 1; this.gain = 1; this.maxAtt = -1;
      this.setCurve(threshold, knee, Math.max(1, ratio));
      this.attackFrames = Math.max(0.001, attack) * sr;
      const relF = sr * release;
      const y1 = relF * 0.09, y2 = relF * 0.16, y3 = relF * 0.42, y4 = relF * 0.98;
      this.kA = 0.9999999999999998 * y1 + 1.8432219684323923e-16 * y2 - 1.9373394351676423e-16 * y3 + 8.824516011816245e-18 * y4;
      this.kB = -1.5788320352845888 * y1 + 2.3305837032074286 * y2 - 0.9141194204840429 * y3 + 0.1623677525612032 * y4;
      this.kC = 0.5334142869106424 * y1 - 1.272736789213631 * y2 + 0.9258856042207512 * y3 - 0.18656310191776226 * y4;
      this.kD = 0.08783463138207234 * y1 - 0.1694162967925622 * y2 + 0.08588057951595272 * y3 - 0.00429891410546283 * y4;
      this.kE = -0.042416883008123074 * y1 + 0.1115693827987602 * y2 - 0.09764676325265872 * y3 + 0.028494263462021576 * y4;
      this.satReleaseFrames = 0.0025 * sr;
      const full = this.saturate(1);
      this.master = Math.pow(1 / full, 0.6);
    }
    kneeCurve(x, k) { if (x < this.linThr) return x; return this.linThr + (1 - Math.exp(-k * (x - this.linThr))) / k; }
    setCurve(thrDb, kneeDb, ratio) {
      this.linThr = dbToGain(thrDb);
      this.slope = 1 / ratio;
      const xDb = thrDb + kneeDb, x = dbToGain(xDb);
      let minK = 0.1, maxK = 10000, k = 5;
      for (let i = 0; i < 15; i++) {
        let slope;
        if (x < this.linThr) slope = 1;
        else {
          const x2 = x * 1.001;
          slope = (lin2db(this.kneeCurve(x2, k)) - lin2db(this.kneeCurve(x, k))) / (lin2db(x2) - lin2db(x));
        }
        if (slope < this.slope) maxK = k; else minK = k;
        k = Math.sqrt(minK * maxK);
      }
      this.k = k;
      this.kneeThrDb = thrDb + kneeDb;
      this.kneeThr = dbToGain(this.kneeThrDb);
      this.yKneeThrDb = lin2db(this.kneeCurve(this.kneeThr, k));
    }
    saturate(x) {
      if (x < this.kneeThr) return this.kneeCurve(x, this.k);
      return dbToGain(this.yKneeThrDb + this.slope * (lin2db(x) - this.kneeThrDb));
    }
    // chs: 1 or 2 Float32Arrays, processed in place. length must be a multiple of 32.
    run(chs) {
      const n = chs[0].length, nch = chs.length, bufs = this.buf, mask = this.mask;
      let det = this.det, gain = this.gain, r = this.r, w = this.w;
      for (let d0 = 0; d0 < n; d0 += 32) {
        if (!isFinite(det)) det = 1;
        const desired = det;
        const scaled = Math.asin(Math.min(1, Math.max(-1, desired))) / HALF_PI;
        let rate;
        const releasing = scaled > gain;
        let diff = lin2db(gain / scaled);
        if (releasing) {
          this.maxAtt = -1;
          if (!isFinite(diff)) diff = -1;
          let x = Math.min(0, Math.max(-12, diff));
          x = 0.25 * (x + 12);
          const x2 = x * x, x3 = x2 * x, x4 = x2 * x2;
          const relFrames = this.kA + this.kB * x + this.kC * x2 + this.kD * x3 + this.kE * x4;
          rate = dbToGain(5 / relFrames);
        } else {
          if (!isFinite(diff)) diff = 1;
          if (this.maxAtt === -1 || this.maxAtt < diff) this.maxAtt = diff;
          const eff = Math.max(0.5, this.maxAtt);
          rate = 1 - Math.pow(0.25 / eff, 1 / this.attackFrames);
        }
        const end = Math.min(n, d0 + 32);
        for (let i = d0; i < end; i++) {
          let inp = 0;
          for (let c = 0; c < nch; c++) { const v = chs[c][i]; bufs[c][w] = v; const a = v < 0 ? -v : v; if (a > inp) inp = a; }
          const shaped = this.saturate(inp);
          const att = inp <= 0.0001 ? 1 : shaped / inp;
          let attDb = -lin2db(att);
          if (attDb < 2) attDb = 2;
          const satRate = dbToGain(attDb / this.satReleaseFrames) - 1;
          det += (att - det) * (att > det ? satRate : 1);
          if (det > 1) det = 1;
          if (!isFinite(det)) det = 1;
          if (rate < 1) gain += (scaled - gain) * rate;
          else { gain *= rate; if (gain > 1) gain = 1; }
          const total = this.master * Math.sin(HALF_PI * gain);
          for (let c = 0; c < nch; c++) chs[c][i] = bufs[c][r] * total;
          r = (r + 1) & mask; w = (w + 1) & mask;
        }
      }
      this.det = det; this.gain = gain; this.r = r; this.w = w;
    }
  }

  // ---------- delay line with linear interpolation ----------
  class Delay {
    constructor(maxSamples) { let s = 2; while (s < maxSamples + 4) s <<= 1; this.b = new Float32Array(s); this.m = s - 1; this.w = 0; }
    read(d) { // value written d samples ago (d >= 1)
      const p = this.w - d, i = Math.floor(p), f = p - i;
      const a = this.b[i & this.m], b = this.b[(i + 1) & this.m];
      return a + (b - a) * f;
    }
    write(x) { this.b[this.w] = x; this.w = (this.w + 1) & this.m; }
  }

  // stereo panner (Web Audio spec), returns [L, R] gains for mono, or applies to stereo
  function panMono(x, pan, outL, outR, add) {
    const p = (Math.max(-1, Math.min(1, pan)) + 1) / 2, gl = Math.cos(p * HALF_PI), gr = Math.sin(p * HALF_PI);
    if (add) for (let i = 0; i < x.length; i++) { outL[i] += x[i] * gl; outR[i] += x[i] * gr; }
    else for (let i = 0; i < x.length; i++) { outL[i] = x[i] * gl; outR[i] = x[i] * gr; }
  }
  function panStereo(L, R, pan, outL, outR) {
    pan = Math.max(-1, Math.min(1, pan));
    if (pan <= 0) {
      const x = pan + 1, gl = Math.cos(x * HALF_PI), gr = Math.sin(x * HALF_PI);
      for (let i = 0; i < L.length; i++) { const l = L[i], r = R[i]; outL[i] += l + r * gl; outR[i] += r * gr; }
    } else {
      const x = pan, gl = Math.cos(x * HALF_PI), gr = Math.sin(x * HALF_PI);
      for (let i = 0; i < L.length; i++) { const l = L[i], r = R[i]; outL[i] += l * gl; outR[i] += r + l * gr; }
    }
  }

  // ---------- convolution reverb (uniformly partitioned, FFT) ----------
  class Conv {
    constructor(ir, B, sr) {
      this._sr = sr;
      const fft = G.DSP.makeFFT(2 * B);
      this.B = B; this.N = 2 * B; this.fft = fft; this.H = this.N / 2 + 1;
      const len = ir[0].length;
      // Web Audio "normalize" scaling
      let power = 0;
      for (const c of ir) for (let i = 0; i < len; i++) power += c[i] * c[i];
      power = Math.sqrt(power / (ir.length * len));
      if (!isFinite(power) || power < 0.000125) power = 0.000125;
      const scale = (1 / power) * 0.00125 * (44100 / sr);
      this.P = Math.max(1, Math.ceil(len / B));
      const re = new Float64Array(this.N), im = new Float64Array(this.N);
      this.hL = []; this.hR = [];
      for (let p = 0; p < this.P; p++) {
        for (let k = 0; k < 2; k++) {
          re.fill(0); im.fill(0);
          const src = ir[k];
          for (let i = 0; i < B && p * B + i < len; i++) re[i] = src[p * B + i] * scale;
          fft(re, im, false);
          const sp = new Float32Array(this.H * 2);
          for (let i = 0; i < this.H; i++) { sp[2 * i] = re[i]; sp[2 * i + 1] = im[i]; }
          (k ? this.hR : this.hL).push(sp);
        }
      }
      this.fdl = []; for (let p = 0; p < this.P; p++) this.fdl.push(new Float32Array(this.H * 2));
      this.head = 0;
      this.inBuf = new Float64Array(this.N);
      this.re = re; this.im = im;
      this.accL = new Float64Array(this.H * 2); this.accR = new Float64Array(this.H * 2);
    }
    process(x, outL, outR) { // x: B samples (mono) → adds into outL/outR
      const B = this.B, N = this.N, H = this.H, re = this.re, im = this.im;
      this.inBuf.copyWithin(0, B);
      for (let i = 0; i < B; i++) this.inBuf[B + i] = x[i];
      re.set(this.inBuf); im.fill(0);
      this.fft(re, im, false);
      this.head = (this.head + this.P - 1) % this.P;
      const X = this.fdl[this.head];
      for (let i = 0; i < H; i++) { X[2 * i] = re[i]; X[2 * i + 1] = im[i]; }
      const aL = this.accL, aR = this.accR;
      aL.fill(0); aR.fill(0);
      for (let p = 0; p < this.P; p++) {
        const Xp = this.fdl[(this.head + p) % this.P], hl = this.hL[p], hr = this.hR[p];
        for (let j = 0; j < 2 * H; j += 2) {
          const xr = Xp[j], xi = Xp[j + 1];
          aL[j] += xr * hl[j] - xi * hl[j + 1]; aL[j + 1] += xr * hl[j + 1] + xi * hl[j];
          aR[j] += xr * hr[j] - xi * hr[j + 1]; aR[j + 1] += xr * hr[j + 1] + xi * hr[j];
        }
      }
      // pack: Z = YL + i*YR, using the symmetry of real signals
      for (let k = 0; k < H; k++) {
        const lr = aL[2 * k], li = aL[2 * k + 1], rr = aR[2 * k], ri = aR[2 * k + 1];
        re[k] = lr - ri; im[k] = li + rr;
        if (k > 0 && k < N / 2) { re[N - k] = lr + ri; im[N - k] = -li + rr; }
      }
      this.fft(re, im, true);
      for (let i = 0; i < B; i++) { outL[i] += re[B + i]; outR[i] += im[B + i]; }
    }
  }

  // piecewise-linear time curve reader (times in samples, read forward)
  class Curve {
    constructor(keys, sr) { this.t = keys.map((k) => k[0] * sr); this.v = keys.map((k) => k[1]); this.i = 0; }
    at(n) {
      const t = this.t, v = this.v;
      if (n <= t[0]) return v[0];
      while (this.i < t.length - 1 && n > t[this.i + 1]) this.i++;
      if (this.i >= t.length - 1) return v[v.length - 1];
      const t0 = t[this.i], t1 = t[this.i + 1];
      return t1 > t0 ? v[this.i] + (v[this.i + 1] - v[this.i]) * (n - t0) / (t1 - t0) : v[this.i + 1];
    }
  }

  // ---------- channel strip ----------
  class Strip {
    constructor(sr, cfg, nch) {
      const fx = cfg.fx;
      this.sr = sr; this.nch = nch;
      this.inGain = dbToGain(cfg.clipGain || 0);
      this.filters = [];
      if (fx.hpf > 0) this.filters.push(new BQ('highpass', fx.hpf, 0.707, 0, sr));
      for (const b of fx.eq || []) if (Math.abs(b.g) > 0.05) this.filters.push(new BQ(b.type, b.f, b.q, b.g, sr));
      const ds = fx.deess || { amount: 0, f: 6500 };
      if (ds.amount > 0) {
        this.ds = { lo1: new BQ('lowpass', ds.f, 0.7071, 0, sr), lo2: new BQ('lowpass', ds.f, 0.7071, 0, sr),
          hi1: new BQ('highpass', ds.f, 0.7071, 0, sr), hi2: new BQ('highpass', ds.f, 0.7071, 0, sr), env: new BQ('lowpass', 40, 0.5, 0, sr), map: deessCurve(ds.amount) };
      }
      const c = fx.comp || {};
      this.comp = c.on ? new Comp(sr, c.threshold, c.knee, c.ratio, c.attack / 1000, c.release / 1000) : null;
      this.makeup = dbToGain(fx.gain || 0);
      this.sat = fx.sat || 0;
      if (this.sat > 0) this.satCurve = satCurve(this.sat);
      // the browser's 2x-oversampled WaveShaper delays its output by 128 samples
      this.satLat = this.sat > 0.3 ? 128 : 0;
      if (this.satLat) this.satDl = [new Delay(256), new Delay(256)];
      const col = fx.color || { type: 'none', mix: 0 };
      const ct = COLOR_TYPES[col.type] || COLOR_TYPES.none;
      this.colMix = col.type === 'none' ? 0 : (col.mix || 0);
      if (col.type !== 'none' && this.colMix > 0) {
        this.col = { hp: new BQ('highpass', ct.hp, ct.q, 0, sr), lp: new BQ('lowpass', ct.lp, ct.q, 0, sr), curve: satCurve(ct.drive, ct.bits), ring: col.type === 'robot' ? (ct.ring || 55) : 0 };
        this.colWet = this.colMix * (col.type === 'robot' ? 1.4 : 1.1);
      }
      this.fader = dbToGain(cfg.vol || 0);
      this.pan = cfg.pan || 0;
      this.dbl = fx.doubler || 0;
      if (this.dbl > 0) {
        this.dblHp = new BQ('highpass', 250, 0.7, 0, sr);
        this.dL = [new Delay(0.1 * sr), new Delay(0.1 * sr)]; this.dR = [new Delay(0.1 * sr), new Delay(0.1 * sr)];
      }
      this.rev = fx.rev || 0; this.dly = fx.dly || 0;
      this.t = 0;
      // per-clip effects (time curves)
      const au = cfg.auto;
      if (au) {
        const C = (k) => (k && k.length ? new Curve(k, sr) : null);
        this.aRev = C(au.rev); this.aDly = C(au.dly); this.aVol = C(au.vol); this.aDry = C(au.dry);
        this.aLp = au.lp && au.lp.length ? { c: new Curve(au.lp, sr), f: new BQ('lowpass', sr, 0.7, 0, sr), cur: -1 } : null;
        this.aCol = Object.entries(au.col || {}).filter(([k, v]) => COLOR_TYPES[k] && v && v.length).map(([k, v]) => {
          const ct = COLOR_TYPES[k];
          return { c: new Curve(v, sr), hp: new BQ('highpass', ct.hp, ct.q, 0, sr), lp: new BQ('lowpass', ct.lp, ct.q, 0, sr), curve: satCurve(ct.drive, ct.bits), ring: k === 'robot' ? (ct.ring || 55) : 0 };
        });
      }
      this.tmp = null;
    }
    // chs: input channels (n samples, modified). faderAdd: [L,R] added at the fader (group returns).
    // outL/outR: stereo destination (added). revOut/dlyOut: mono send buses (added) or null.
    process(chs, n, faderAdd, outL, outR, revOut, dlyOut) {
      let nch = chs.length;
      const sr = this.sr;
      if (this.inGain !== 1) for (const x of chs) for (let i = 0; i < n; i++) x[i] *= this.inGain;
      for (const f of this.filters) for (let c = 0; c < nch; c++) f.run(chs[c], c);
      if (this.ds) {
        const d = this.ds;
        const his = [], mod = new Float32Array(n);
        for (let c = 0; c < nch; c++) {
          const x = chs[c], hi = new Float32Array(x);
          d.hi1.run(hi, c); d.hi2.run(hi, c);
          d.lo1.run(x, c); d.lo2.run(x, c);
          const env = new Float32Array(n);
          for (let i = 0; i < n; i++) env[i] = Math.abs(hi[i]);
          d.env.run(env, c);
          for (let i = 0; i < n; i++) mod[i] += shape(d.map, env[i]) / nch;
          his.push(hi);
        }
        for (let c = 0; c < nch; c++) { const x = chs[c], hi = his[c]; for (let i = 0; i < n; i++) x[i] += hi[i] * (1 + mod[i]); }
      }
      if (this.comp) {
        this.comp.run(chs);
        // the browser's compressor always outputs stereo (a mono voice becomes L = R from here on)
        if (chs.length === 1) chs.push(new Float32Array(chs[0]));
      }
      nch = chs.length;
      if (this.makeup !== 1) for (const x of chs) for (let i = 0; i < n; i++) x[i] *= this.makeup;
      { // saturation (dry is always applied)
        const dry = 1 - this.sat * 0.45, wet = this.sat * 0.6;
        if (this.sat > 0) {
          const cv = this.satCurve, L = this.satLat;
          for (let c = 0; c < chs.length; c++) {
            const x = chs[c];
            if (L) { const dl = this.satDl[c]; for (let i = 0; i < n; i++) { const w = dl.read(L); dl.write(shape(cv, x[i])); x[i] = x[i] * dry + w * wet; } }
            else for (let i = 0; i < n; i++) x[i] = x[i] * dry + shape(cv, x[i]) * wet;
          }
        } else if (dry !== 1) for (const x of chs) for (let i = 0; i < n; i++) x[i] *= dry;
      }
      this._colDrySig = null;
      // per-clip voice effects take the signal from before the base colour (like satOut in playback)
      const pre = this.aCol && this.aCol.length ? chs.map((x) => new Float32Array(x)) : null;
      if (this.col) {
        const cl = this.col, dry = 1 - this.colMix, wet = this.colWet;
        if (this.aDry) this._colDrySig = chs.map((x) => { const d = new Float32Array(n); for (let i = 0; i < n; i++) d[i] = x[i] * dry; return d; });
        for (let c = 0; c < nch; c++) {
          const x = chs[c];
          for (let i = 0; i < n; i++) {
            let y = cl.lp.step(cl.hp.step(x[i], c), c);
            y = shape(cl.curve, y);
            if (cl.ring) y *= Math.sin(2 * Math.PI * cl.ring * (this.t + i) / sr);
            x[i] = x[i] * dry + y * wet;
          }
        }
      }
      // per-clip voice effects (in parallel with the normal sound, which is faded down by "dry")
      if (this.aCol && this.aCol.length || this.aDry) {
        const t0 = this.t;
        const ys = this.aCol ? this.aCol.map(() => chs.map(() => new Float32Array(n))) : [];
        if (this.aCol) this.aCol.forEach((ac, k) => {
          for (let c = 0; c < chs.length; c++) {
            const x = pre[c], y = ys[k][c];
            for (let i = 0; i < n; i++) {
              let v = ac.lp.step(ac.hp.step(x[i], c), c);
              v = shape(ac.curve, v);
              if (ac.ring) v *= Math.sin(2 * Math.PI * ac.ring * (t0 + i) / sr);
              y[i] = v;
            }
          }
        });
        // the plain/base-colour signal is scaled by "dry"; the base colour wet part was already mixed in,
        // so scale the whole stage output (matches: colDry→autoDry, colWet unaffected only when no base colour)
        for (let i = 0; i < n; i++) {
          const d = this.aDry ? this.aDry.at(t0 + i) : 1;
          let w = []; if (this.aCol) for (let k = 0; k < this.aCol.length; k++) w.push(this.aCol[k].c.at(t0 + i));
          for (let c = 0; c < chs.length; c++) {
            let o = (this._colDrySig ? this._colDrySig[c][i] * d + (chs[c][i] - this._colDrySig[c][i]) : chs[c][i] * d);
            for (let k = 0; k < w.length; k++) o += ys[k][c][i] * w[k];
            chs[c][i] = o;
          }
        }
      }
      if (faderAdd) {
        if (nch === 1) { const x = chs[0]; for (let i = 0; i < n; i++) x[i] += 0.5 * (faderAdd[0][i] + faderAdd[1][i]); }
        else for (let c = 0; c < 2; c++) { const x = chs[c], a = faderAdd[c]; for (let i = 0; i < n; i++) x[i] += a[i]; }
      }
      if (this.fader !== 1) for (const x of chs) for (let i = 0; i < n; i++) x[i] *= this.fader;
      if (this.aLp) {
        const al = this.aLp, nyq = sr / 2;
        for (let i0 = 0; i0 < n; i0 += 32) {
          const f = Math.min(nyq, al.c.at(this.t + i0));
          if (Math.abs(f - al.cur) > 0.5) { const nb = new BQ('lowpass', f, 0.7, 0, sr); al.f.c = nb.c; al.cur = f; }
          const e = Math.min(n, i0 + 32);
          for (let c = 0; c < chs.length; c++) { const x = chs[c]; for (let i = i0; i < e; i++) x[i] = al.f.step(x[i], c); }
        }
      }
      if (this.aVol) { const t0 = this.t; for (let i = 0; i < n; i++) { const gg = this.aVol.at(t0 + i); for (const x of chs) x[i] *= gg; } }
      // sends (post fader, pre pan, mono)
      if (revOut && this.rev > 0) { const g = this.rev; if (nch === 1) { const x = chs[0]; for (let i = 0; i < n; i++) revOut[i] += x[i] * g; } else { const a = chs[0], b = chs[1]; for (let i = 0; i < n; i++) revOut[i] += 0.5 * (a[i] + b[i]) * g; } }
      if (dlyOut && this.dly > 0) { const g = this.dly; if (nch === 1) { const x = chs[0]; for (let i = 0; i < n; i++) dlyOut[i] += x[i] * g; } else { const a = chs[0], b = chs[1]; for (let i = 0; i < n; i++) dlyOut[i] += 0.5 * (a[i] + b[i]) * g; } }
      if (revOut && this.aRev) { const t0 = this.t, m = chs.length === 1; for (let i = 0; i < n; i++) { const gg = this.aRev.at(t0 + i); if (gg) revOut[i] += (m ? chs[0][i] : 0.5 * (chs[0][i] + chs[1][i])) * gg; } }
      if (dlyOut && this.aDly) { const t0 = this.t, m = chs.length === 1; for (let i = 0; i < n; i++) { const gg = this.aDly.at(t0 + i); if (gg) dlyOut[i] += (m ? chs[0][i] : 0.5 * (chs[0][i] + chs[1][i])) * gg; } }
      // doubler (from the post-fader signal, added after the pan)
      if (this.dbl > 0) {
        const g = this.dbl * 0.55;
        const pl = (-0.8 + 1) / 2, plL = Math.cos(pl * HALF_PI), plR = Math.sin(pl * HALF_PI);
        const pr = (0.8 + 1) / 2, prL = Math.cos(pr * HALF_PI), prR = Math.sin(pr * HALF_PI);
        for (let i = 0; i < n; i++) {
          const tt = (this.t + i) / sr;
          const dl = (0.011 + 0.0015 * Math.sin(2 * Math.PI * 0.31 * tt)) * sr, dr = (0.017 + 0.0015 * Math.sin(2 * Math.PI * 0.43 * tt)) * sr;
          if (nch === 1) {
            const h = this.dblHp.step(chs[0][i], 0);
            const a = this.dL[0].read(dl), b = this.dR[0].read(dr);
            this.dL[0].write(h); this.dR[0].write(h);
            outL[i] += (a * plL + b * prL) * g; outR[i] += (a * plR + b * prR) * g;
          } else {
            const hL = this.dblHp.step(chs[0][i], 0), hR = this.dblHp.step(chs[1][i], 1);
            const aL = this.dL[0].read(dl), aR = this.dL[1].read(dl), bL = this.dR[0].read(dr), bR = this.dR[1].read(dr);
            this.dL[0].write(hL); this.dL[1].write(hR); this.dR[0].write(hL); this.dR[1].write(hR);
            // stereo panner at -0.8 / +0.8
            const x1 = -0.8 + 1, g1L = Math.cos(x1 * HALF_PI), g1R = Math.sin(x1 * HALF_PI);
            const g2L = Math.cos(0.8 * HALF_PI), g2R = Math.sin(0.8 * HALF_PI);
            outL[i] += ((aL + aR * g1L) + (bL * g2L)) * g; outR[i] += ((aR * g1R) + (bR + bL * g2R)) * g;
          }
        }
      }
      if (nch === 1) panMono(chs[0], this.pan, outL, outR, true);
      else panStereo(chs[0], chs[1], this.pan, outL, outR);
      this.t += n;
    }
  }

  // reverb + delay returns
  class Sends {
    constructor(sr, bus, B) {
      const rt = REVERB_TYPES[bus.reverb.type] || REVERB_TYPES.plate;
      const ir = makeIR(bus.reverb.type, sr);
      this.conv = new Conv(ir, B, sr);
      this.pre = new Delay(0.25 * sr); this.preN = (rt.pre / 1000 + 0.015) * sr;
      this.revHp = new BQ('highpass', 220, 1, 0, sr); this.revLp = new BQ('lowpass', 9000, 1, 0, sr);
      this.dlyHp = new BQ('highpass', 350, 1, 0, sr); this.dlyLp = new BQ('lowpass', 4500, 1, 0, sr);
      const beat = 60 / Math.max(40, Math.min(240, bus.bpm || 120));
      this.dt = Math.min(1.9, beat * (DELAY_NOTES[bus.delay.note] || 0.5)) * sr;
      this.fb = Math.min(0.8, bus.delay.feedback);
      const pp = bus.delay.pingpong ? 0.85 : 0;
      const a = (-pp + 1) / 2, b = (pp + 1) / 2;
      this.pLl = Math.cos(a * HALF_PI); this.pLr = Math.sin(a * HALF_PI); this.pRl = Math.cos(b * HALF_PI); this.pRr = Math.sin(b * HALF_PI);
      this.dL = new Delay(2.0 * sr); this.dR = new Delay(2.0 * sr);
      this.B = B;
    }
    // rev/dly: mono send buses (B samples). Adds the returns into retL/retR.
    process(rev, dly, retL, retR) {
      const B = this.B, dt = this.dt, fb = this.fb;
      const revIn = new Float32Array(B);
      for (let i = 0; i < B; i++) {
        const lOut = this.dL.read(dt), rOut = this.dR.read(dt);
        const x = this.dlyLp.step(this.dlyHp.step(dly[i] + fb * rOut, 0), 0);
        this.dL.write(x); this.dR.write(fb * lOut);
        const oL = lOut * this.pLl + rOut * this.pRl, oR = lOut * this.pLr + rOut * this.pRr;
        retL[i] += oL; retR[i] += oR;
        revIn[i] = rev[i] + 0.5 * (oL + oR);
      }
      const pd = new Float32Array(B);
      for (let i = 0; i < B; i++) { pd[i] = this.pre.read(this.preN); this.pre.write(revIn[i]); }
      const wl = new Float32Array(B), wr = new Float32Array(B);
      this.conv.process(pd, wl, wr);
      this.revHp.run(wl, 0); this.revHp.run(wr, 1); this.revLp.run(wl, 0); this.revLp.run(wr, 1);
      for (let i = 0; i < B; i++) { retL[i] += wl[i] * 0.9; retR[i] += wr[i] * 0.9; }
    }
  }

  // ---------- the whole mix ----------
  class Mixer {
    constructor(cfg) {
      const sr = cfg.sr, B = 4096;
      this.sr = sr; this.B = B; this.total = cfg.total;
      this.tracks = cfg.tracks.map((t) => ({ id: t.id, kind: t.kind, nch: t.nch, strip: new Strip(sr, t, t.nch) }));
      const gr = cfg.groups;
      this.gv = new Strip(sr, { fx: gr.vocal.fx, vol: gr.vocal.vol }, 2);
      this.gb = new Strip(sr, { fx: gr.backing.fx, vol: gr.backing.vol }, 2);
      this.master = new Strip(sr, { fx: gr.master.fx, vol: gr.master.vol }, 2);
      const dd = gr.backing.fxOff ? 0 : (gr.backing.duck || 0);
      if (dd > 0) {
        const n = 1024, eqC = new Float32Array(n), gC = new Float32Array(n);
        for (let i = 0; i < n; i++) { const x = Math.abs(i / (n - 1) * 2 - 1), r = Math.min(1, x / 0.06); eqC[i] = -dd * r; gC[i] = Math.pow(10, -0.3 * dd * r / 20) - 1; }
        this.duck = { eqC, gC, env: new BQ('lowpass', 8, 0, 0, sr), st: [new Float64Array(4), new Float64Array(4)], cur: 1e9, c: null };
      }
      this.limiter = gr.master.limiter ? new Comp(sr, -1.5, 0, 20, 0.002, 0.12) : new Comp(sr, 0, 0, 1, 0.003, 0.25);
      this.trim = dbToGain(-0.8);
      const needSends = cfg.tracks.some((t) => (t.fx.rev || 0) > 0 || (t.fx.dly || 0) > 0 || (t.auto && (t.auto.rev || t.auto.dly)));
      this.sends = needSends ? new Sends(sr, cfg.bus, B) : null;
      this.keep = cfg.keep !== false;
      if (this.keep) { this.L = new Float32Array(cfg.total); this.R = new Float32Array(cfg.total); }
      this.pos = 0;
    }
    // srcs: {trackId: [Float32Array per channel]} covering the next chunk (length multiple of B)
    chunk(srcs, len) {
      const B = this.B;
      for (let o = 0; o < len; o += B) {
        const vL = new Float32Array(B), vR = new Float32Array(B), bL = new Float32Array(B), bR = new Float32Array(B);
        const rev = this.sends ? new Float32Array(B) : null, dly = this.sends ? new Float32Array(B) : null;
        for (const t of this.tracks) {
          const s = srcs[t.id];
          const chs = [];
          for (let c = 0; c < t.nch; c++) chs.push(s ? new Float32Array(s[c].subarray(o, o + B)) : new Float32Array(B));
          if (t.kind === 'backing') t.strip.process(chs, B, null, bL, bR, rev, dly);
          else t.strip.process(chs, B, null, vL, vR, rev, dly);
        }
        let ret = null;
        if (this.sends) { ret = [new Float32Array(B), new Float32Array(B)]; this.sends.process(rev, dly, ret[0], ret[1]); }
        const mL = new Float32Array(B), mR = new Float32Array(B);
        if (this.duck) {
          // vocal group → envelope → dip in the backing around 3 kHz + slight level drop
          const gvL = new Float32Array(B), gvR = new Float32Array(B);
          this.gv.process([vL, vR], B, ret, gvL, gvR, null, null);
          const gbL = new Float32Array(B), gbR = new Float32Array(B);
          this.gb.process([bL, bR], B, null, gbL, gbR, null, null);
          const D = this.duck, sr = this.sr;
          const eL = new Float32Array(B), eR = new Float32Array(B);
          for (let i = 0; i < B; i++) { eL[i] = Math.abs(gvL[i]); eR[i] = Math.abs(gvR[i]); }
          D.env.run(eL, 0); D.env.run(eR, 1);
          for (let i0 = 0; i0 < B; i0 += 32) {
            const e = Math.min(B, i0 + 32);
            for (let i = i0; i < e; i++) {
              const dB = 0.5 * (shape(D.eqC, eL[i]) + shape(D.eqC, eR[i]));
              if (Math.abs(dB - D.cur) > 0.02) { D.cur = dB; D.c = new BQ('peaking', 2800, 0.7, dB, sr).c; }
              const c = D.c, gg = 1 + 0.5 * (shape(D.gC, eL[i]) + shape(D.gC, eR[i]));
              for (let ch = 0; ch < 2; ch++) {
                const st = D.st[ch], xi = ch ? gbR[i] : gbL[i];
                let yi = c[0] * xi + c[1] * st[0] + c[2] * st[1] - c[3] * st[2] - c[4] * st[3];
                st[1] = st[0]; st[0] = xi; st[3] = st[2]; st[2] = yi;
                if (ch) mR[i] += yi * gg; else mL[i] += yi * gg;
              }
            }
          }
          for (let i = 0; i < B; i++) { mL[i] += gvL[i]; mR[i] += gvR[i]; }
        } else {
          this.gv.process([vL, vR], B, ret, mL, mR, null, null);
          this.gb.process([bL, bR], B, null, mL, mR, null, null);
        }
        const oL = new Float32Array(B), oR = new Float32Array(B);
        this.master.process([mL, mR], B, null, oL, oR, null, null);
        this.limiter.run([oL, oR]);
        const p = this.pos, tg = this.trim;
        if (this.keep) {
          const m = Math.min(B, this.total - p);
          for (let i = 0; i < m; i++) { this.L[p + i] = oL[i] * tg; this.R[p + i] = oR[i] * tg; }
        }
        this.pos += B;
      }
    }
  }
  MIX.Mixer = Mixer;
  MIX.BLOCK = 4096;
  G.MIX = MIX;
})(typeof self !== 'undefined' ? self : globalThis);
