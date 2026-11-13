/* UtaMix DSP core — pitch detection, note segmentation, TD-PSOLA, key/chord detection, harmony.
   Pure functions, no network, no dependencies. Used by the worker (importScripts) and by tests (Node). */
(function (root) {
  'use strict';
  const DSP = {};

  const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const hzToMidi = (f) => 69 + 12 * Math.log2(f / 440);
  DSP.midiToHz = midiToHz;
  DSP.hzToMidi = hzToMidi;

  const SCALES = {
    major: [0, 2, 4, 5, 7, 9, 11],
    minor: [0, 2, 3, 5, 7, 8, 10],
    chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  };
  DSP.SCALES = SCALES;

  function scaleSet(key) {
    const s = new Set();
    for (const iv of SCALES[key.mode] || SCALES.major) s.add((key.tonic + iv) % 12);
    return s;
  }
  DSP.scaleSet = scaleSet;

  // nearest midi integer in scale
  function snapToScale(m, key) {
    const set = scaleSet(key);
    const base = Math.round(m);
    let best = base, bd = 1e9;
    for (let d = -6; d <= 6; d++) {
      const c = base + d;
      if (!set.has(((c % 12) + 12) % 12)) continue;
      const dist = Math.abs(c - m);
      if (dist < bd) { bd = dist; best = c; }
    }
    return best;
  }
  DSP.snapToScale = snapToScale;

  // ---------- filters / resampling ----------
  function biquadLP(x, sr, fc, q) {
    const w = 2 * Math.PI * fc / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
    const a0 = 1 + al;
    const b0 = (1 - cs) / 2 / a0, b1 = (1 - cs) / a0, b2 = b0, a1 = -2 * cs / a0, a2 = (1 - al) / a0;
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const xi = x[i];
      const yi = b0 * xi + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = xi; y2 = y1; y1 = yi; y[i] = yi;
    }
    return y;
  }

  function resample(x, sr, target) {
    if (sr === target) return Float32Array.from(x);
    let y = x;
    if (target < sr) {
      const fc = target * 0.45;
      y = biquadLP(biquadLP(x, sr, fc, 0.5412), sr, fc, 1.3066); // 4th-order Butterworth
    }
    const ratio = sr / target;
    const n = Math.floor(x.length / ratio);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = i * ratio, k = Math.floor(p), f = p - k;
      const a = y[k] || 0, b = y[k + 1] || 0;
      out[i] = a + (b - a) * f;
    }
    return out;
  }
  DSP.resample = resample;

  // ---------- YIN pitch analysis ----------
  // returns {hop (sec), f0 Float32Array (Hz, 0 = unvoiced), rms Float32Array, conf Float32Array}
  DSP.analyzePitch = function (x, sr, opts = {}, progress) {
    const ASR = 16000;
    const y = resample(x, sr, ASR);
    const hopSec = 0.01;
    const hop = Math.round(ASR * hopSec);
    const W = 384;
    const fmin = opts.fmin || 70, fmax = opts.fmax || 1050;
    const tauMin = Math.floor(ASR / fmax), tauMax = Math.ceil(ASR / fmin);
    const nFrames = Math.max(1, Math.floor(x.length / sr / hopSec));
    const f0 = new Float32Array(nFrames), rms = new Float32Array(nFrames), conf = new Float32Array(nFrames);
    const d = new Float32Array(tauMax + 2), cm = new Float32Array(tauMax + 2);
    const half = W >> 1;
    for (let fi = 0; fi < nFrames; fi++) {
      const s = fi * hop - half;
      if (s < 0 || s + W + tauMax + 1 >= y.length) { f0[fi] = 0; conf[fi] = 1; continue; }
      let e = 0;
      for (let j = 0; j < W; j++) e += y[s + j] * y[s + j];
      rms[fi] = Math.sqrt(e / W);
      if (rms[fi] < 1e-4) { conf[fi] = 1; continue; }
      d[0] = 0;
      for (let tau = 1; tau <= tauMax + 1; tau++) {
        let sum = 0;
        const o = s + tau;
        for (let j = 0; j < W; j++) { const df = y[s + j] - y[o + j]; sum += df * df; }
        d[tau] = sum;
      }
      cm[0] = 1;
      let run = 0;
      for (let tau = 1; tau <= tauMax + 1; tau++) { run += d[tau]; cm[tau] = run > 0 ? d[tau] * tau / run : 1; }
      let tau = -1;
      for (let t = tauMin; t <= tauMax; t++) {
        if (cm[t] < 0.1) { while (t + 1 <= tauMax && cm[t + 1] < cm[t]) t++; tau = t; break; }
      }
      // sub-octave check: a clearly deeper dip near 2*tau means we picked half the period
      if (tau > 0) {
        const t2 = tau * 2;
        if (t2 + 1 <= tauMax) {
          let m2 = t2, mv2 = cm[t2];
          for (let q = t2 - 2; q <= t2 + 2; q++) if (q <= tauMax && cm[q] < mv2) { mv2 = cm[q]; m2 = q; }
          if (cm[tau] > 0.04 && mv2 < cm[tau] * 0.5) tau = m2;
        }
      }
      if (tau < 0) {
        let mv = 1e9;
        for (let t = tauMin; t <= tauMax; t++) if (cm[t] < mv) { mv = cm[t]; tau = t; }
      }
      const a = cm[tau - 1], b = cm[tau], c = cm[tau + 1];
      const den = a - 2 * b + c;
      const shift = den !== 0 ? 0.5 * (a - c) / den : 0;
      const tr = tau + Math.max(-1, Math.min(1, shift));
      conf[fi] = b;
      f0[fi] = ASR / tr;
      if (progress && (fi & 1023) === 0) progress(fi / nFrames);
    }
    // voicing decision
    const sorted = Float32Array.from(rms).sort();
    const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
    const gate = Math.max(p95 * Math.pow(10, -38 / 20), 2e-4);
    for (let i = 0; i < nFrames; i++) {
      if (!(f0[i] > 0) || conf[i] > 0.3 || rms[i] < gate) f0[i] = 0;
    }
    cleanF0(f0);
    return { hop: hopSec, f0, rms, conf };
  };

  function cleanF0(f0) {
    const n = f0.length;
    // octave-error fix vs local median of voiced neighbours
    const m = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (!f0[i]) continue;
      const vals = [];
      for (let k = i - 4; k <= i + 4; k++) if (k >= 0 && k < n && f0[k]) vals.push(f0[k]);
      vals.sort((a, b) => a - b);
      m[i] = vals[vals.length >> 1];
    }
    for (let i = 0; i < n; i++) {
      if (!f0[i]) continue;
      const r = f0[i] / m[i];
      if (r > 1.8 && r < 2.2) f0[i] /= 2;
      else if (r > 0.45 && r < 0.55) f0[i] *= 2;
    }
    // 3-point median
    const c = Float32Array.from(f0);
    for (let i = 1; i < n - 1; i++) {
      if (!c[i - 1] || !c[i] || !c[i + 1]) continue;
      const a = c[i - 1], b = c[i], d = c[i + 1];
      f0[i] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), d));
    }
    // fill short gaps (<=3 frames)
    let i = 0;
    while (i < n) {
      if (f0[i]) { i++; continue; }
      let j = i; while (j < n && !f0[j]) j++;
      if (i > 0 && j < n && j - i <= 3) {
        const a = f0[i - 1], b = f0[j];
        if (Math.abs(hzToMidi(a) - hzToMidi(b)) < 2) for (let k = i; k < j; k++) f0[k] = a + (b - a) * (k - i + 1) / (j - i + 1);
      }
      i = j;
    }
    // remove islands < 5 frames
    i = 0;
    while (i < n) {
      if (!f0[i]) { i++; continue; }
      let j = i; while (j < n && f0[j]) j++;
      if (j - i < 5) for (let k = i; k < j; k++) f0[k] = 0;
      i = j;
    }
  }

  // ---------- note segmentation (Melodyne-style blobs) ----------
  DSP.segmentNotes = function (an) {
    const { f0, rms } = an;
    const n = f0.length;
    const midi = new Float32Array(n);
    for (let i = 0; i < n; i++) midi[i] = f0[i] ? hzToMidi(f0[i]) : 0;
    const notes = [];
    let i = 0;
    while (i < n) {
      if (!f0[i]) { i++; continue; }
      let j = i; while (j < n && f0[j]) j++;
      // voiced run [i, j)
      const sm = new Float32Array(j - i);
      for (let k = i; k < j; k++) {
        let s = 0, c = 0;
        for (let q = k - 3; q <= k + 3; q++) if (q >= i && q < j) { s += midi[q]; c++; }
        sm[k - i] = s / c;
      }
      let segStart = i, cnt = 0, refSum = 0, refN = 0;
      const cuts = [];
      for (let k = i; k < j; k++) {
        const v = sm[k - i];
        if (refN >= 4) {
          const ref = refSum / refN;
          if (Math.abs(v - ref) > 0.85) cnt++; else cnt = 0;
          if (cnt >= 6) {
            const cut = k - cnt + 1;
            if (cut - segStart >= 5) { cuts.push(cut); segStart = cut; }
            refSum = 0; refN = 0; cnt = 0;
            for (let q = cut; q <= k; q++) { refSum += sm[q - i]; refN++; }
            continue;
          }
        }
        if (cnt === 0) { refSum += v; refN++; }
      }
      const bounds = [i, ...cuts, j];
      for (let b = 0; b < bounds.length - 1; b++) {
        notes.push(makeNote(midi, rms, bounds[b], bounds[b + 1]));
      }
      i = j;
    }
    // merge very short notes into adjacent touching neighbour with nearest pitch
    for (let k = 0; k < notes.length; k++) {
      const nt = notes[k];
      if (nt.e - nt.s >= 6) continue;
      const prev = k > 0 && notes[k - 1].e === nt.s ? notes[k - 1] : null;
      const next = k < notes.length - 1 && notes[k + 1].s === nt.e ? notes[k + 1] : null;
      let tgt = null;
      if (prev && next) tgt = Math.abs(prev.c - nt.c) <= Math.abs(next.c - nt.c) ? prev : next;
      else tgt = prev || next;
      if (!tgt) continue;
      const s = Math.min(tgt.s, nt.s), e = Math.max(tgt.e, nt.e);
      const merged = makeNote(midi, rms, s, e);
      const idx = notes.indexOf(tgt);
      notes[idx] = merged;
      notes.splice(k, 1);
      k = Math.max(-1, Math.min(k, idx) - 2);
    }
    return notes;
  };

  function makeNote(midi, rms, s, e) {
    const len = e - s;
    const a = s + Math.floor(len * 0.15), b = Math.max(a + 1, e - Math.floor(len * 0.15));
    const vals = [];
    let r = 0;
    for (let k = a; k < b; k++) if (midi[k]) vals.push(midi[k]);
    for (let k = s; k < e; k++) r += rms[k];
    vals.sort((x, y) => x - y);
    const c = vals.length ? vals[vals.length >> 1] : midi[s];
    return { s, e, c, rms: r / Math.max(1, len) };
  }
  DSP.makeNote = makeNote;

  // ---------- correction curves ----------
  // note fields: s,e,c, t (target), flat (drift correction 0..1), vib (vibrato amount 0..2, default 1)
  DSP.shiftCurveNotes = function (an, notes, opts = {}) {
    const n = an.f0.length;
    const base = new Float32Array(n);
    const has = new Uint8Array(n);
    const devTerm = new Float32Array(n);
    for (const nt of notes) {
      const sh = (nt.t != null ? nt.t : nt.c) - nt.c;
      const drift = nt.flat || 0;
      const vib = nt.vib != null ? nt.vib : 1;
      const s = Math.max(0, nt.s), e = Math.min(n, nt.e);
      for (let k = s; k < e; k++) { base[k] = sh; has[k] = 1; }
      // added vibrato: starts a little after the note begins and fades in, like a singer's natural vibrato
      if (nt.vadd > 0 && e - s > 8) {
        const hop = an.hop, T = (e - s) * hop, rate = nt.vrate || 5.5;
        const delay = Math.min(0.35, T * 0.25), fin = 0.25, fout = 0.06;
        for (let k = s; k < e; k++) {
          const t = (k - s) * hop;
          if (t < delay) continue;
          const w = Math.min(1, (t - delay) / fin, Math.max(0, (T - t) / fout));
          devTerm[k] += nt.vadd * w * Math.sin(2 * Math.PI * rate * (t - delay));
        }
      }
      if (drift === 0 && vib === 1) continue;
      const len = e - s;
      if (len <= 0) continue;
      const dev = new Float32Array(len), ok = new Uint8Array(len);
      for (let k = s; k < e; k++) if (an.f0[k]) { dev[k - s] = hzToMidi(an.f0[k]) - nt.c; ok[k - s] = 1; }
      // slow component (drift) = moving average over ~one vibrato period; fast = vibrato
      const W = 8;
      for (let k = 0; k < len; k++) {
        if (!ok[k]) continue;
        let sum = 0, cnt = 0;
        for (let q = Math.max(0, k - W); q <= Math.min(len - 1, k + W); q++) if (ok[q]) { sum += dev[q]; cnt++; }
        const slow = sum / cnt, fast = dev[k] - slow;
        const nd = slow * (1 - drift) + fast * vib;
        devTerm[s + k] = nd - dev[k];
      }
    }
    let last = -1;
    for (let k = 0; k < n; k++) {
      if (!has[k]) continue;
      if (last >= 0 && k - last > 1) {
        for (let q = last + 1; q < k; q++) base[q] = base[last] + (base[k] - base[last]) * (q - last) / (k - last);
      } else if (last < 0) for (let q = 0; q < k; q++) base[q] = base[k];
      last = k;
    }
    if (last >= 0) for (let q = last + 1; q < n; q++) base[q] = base[last];
    const w = Math.max(0, Math.round((opts.transitionMs != null ? opts.transitionMs : 50) / 1000 / an.hop / 2));
    const sm = smoothArr(base, w);
    const dv = smoothArr(devTerm, 1);
    const out = new Float32Array(n);
    for (let k = 0; k < n; k++) out[k] = sm[k] + dv[k];
    return out;
  };

  function smoothArr(a, w) {
    if (w <= 0) return a;
    const n = a.length, out = new Float32Array(n), cs = new Float64Array(n + 1);
    for (let k = 0; k < n; k++) cs[k + 1] = cs[k] + a[k];
    for (let k = 0; k < n; k++) { const lo = Math.max(0, k - w), hi = Math.min(n, k + w + 1); out[k] = (cs[hi] - cs[lo]) / (hi - lo); }
    return out;
  }
  DSP.smoothArr = smoothArr;

  // gain curve (linear) for cuts only: cuts = [[a,b], ...] seconds (track-local input time)
  DSP.cutGain = function (nFrames, hop, cuts) {
    const g = new Float32Array(nFrames).fill(1);
    for (const [a, b] of cuts || []) {
      for (let k = Math.max(0, Math.floor(a / hop)); k < Math.min(nFrames, Math.ceil(b / hop)); k++) g[k] = 0;
    }
    return smoothArr(g, 1);
  };

  // all curves for note mode: shift, formant, gain, time map
  DSP.noteCurves = function (an, notes, opts = {}) {
    const n = an.f0.length, hop = an.hop;
    let shift = DSP.shiftCurveNotes(an, notes, opts);
    if (opts.tune) shift = DSP.shiftCurveTune(an, opts.key, opts.tune, shift);
    const formant = new Float32Array(n), gain = new Float32Array(n).fill(1);
    let anyF = false, anyG = false, anyT = false;
    for (const nt of notes) {
      const f = nt.form || 0, gdb = nt.gain || 0;
      if (f) anyF = true;
      if (gdb || nt.mute) anyG = true;
      if (nt.ts || nt.te) anyT = true;
      const gl = nt.mute ? 0 : Math.pow(10, gdb / 20);
      for (let k = Math.max(0, nt.s); k < Math.min(n, nt.e); k++) { formant[k] = f; gain[k] = gl; }
    }
    if (opts.cuts && opts.cuts.length) {
      anyG = true;
      for (const [a, b] of opts.cuts) for (let k = Math.max(0, Math.floor(a / hop)); k < Math.min(n, Math.ceil(b / hop)); k++) gain[k] = 0;
    }
    const res = { shift };
    if (anyF) res.formant = smoothArr(formant, 3);
    if (anyG) res.gain = smoothArr(gain, 1);
    if (anyT) {
      const sorted = notes.slice().sort((x, y) => x.s - y.s);
      const inT = [0], outT = [0];
      const push = (i, o) => {
        const pi = inT[inT.length - 1], po = outT[outT.length - 1];
        if (i <= pi + 1e-6) return;
        inT.push(i); outT.push(Math.max(o, po + 0.001));
      };
      // moved notes anchor their edges; untouched notes anchor only their middle so neighbours absorb the stretch
      for (const nt of sorted) {
        if (nt.ts || nt.te) { push(nt.s * hop, nt.s * hop + (nt.ts || 0)); push(nt.e * hop, nt.e * hop + (nt.te || 0)); }
        else { const mid = (nt.s + nt.e) / 2 * hop; push(mid, mid); }
      }
      const end = n * hop, lastD = outT[outT.length - 1] - inT[inT.length - 1];
      push(end + 1, end + 1 + lastD);
      res.map = { inT, outT };
    }
    return res;
  };

  // auto-tune style: per-frame snap with retune speed (ms) and strength (0..1)
  DSP.shiftCurveTune = function (an, key, opts = {}, base) {
    const n = an.f0.length;
    const speedMs = opts.speedMs != null ? opts.speedMs : 20;
    const strength = opts.strength != null ? opts.strength : 1;
    const alpha = speedMs <= 0 ? 1 : 1 - Math.exp(-an.hop * 1000 / speedMs);
    const out = new Float32Array(n);
    let cs = 0, prevTarget = null, gap = 0;
    for (let k = 0; k < n; k++) {
      const b0 = base ? base[k] : 0;
      if (!an.f0[k]) { gap++; if (gap > 15) { cs = 0; prevTarget = null; } out[k] = b0 + cs; continue; }
      gap = 0;
      const m = hzToMidi(an.f0[k]) + b0;
      let tgt = snapToScale(m, key);
      // hysteresis: keep previous target unless clearly closer to a new one
      if (prevTarget != null && tgt !== prevTarget && Math.abs(m - prevTarget) < 0.65) tgt = prevTarget;
      prevTarget = tgt;
      const corr = (tgt - m) * strength;
      cs += alpha * (corr - cs);
      out[k] = b0 + cs;
    }
    return out;
  };

  // ---------- TD-PSOLA ----------
  // marks cache: computed from signal + f0 (analysis), reused across renders
  DSP.pitchMarks = function (x, sr, an) {
    const N = x.length;
    const hopS = an.hop * sr;
    const nF = an.f0.length;
    const f0At = (t) => {
      const fi = Math.round(t / hopS);
      return fi >= 0 && fi < nF ? an.f0[fi] : 0;
    };
    const Pu = Math.round(sr * 0.005);
    const marks = []; // flat arrays later
    let t = 0, prevVoiced = false;
    while (t < N) {
      const f = f0At(t);
      if (f > 0) {
        const P = sr / f;
        if (!prevVoiced) {
          // align first mark of voiced run to the largest peak within one period
          let best = t, bv = -1;
          for (let q = t; q < Math.min(N, t + P); q++) { const v = Math.abs(x[q]); if (v > bv) { bv = v; best = q; } }
          t = best;
          prevVoiced = true;
          if (f0At(t) > 0) continue;
          prevVoiced = false;
          marks.push(t, 0);
          t += Pu;
          continue;
        }
        marks.push(t, 1);
        // next mark: maximise correlation with this period, search 0.8P..1.2P
        const L = Math.round(P);
        const half = L >> 1;
        let bestTau = L, bestC = -Infinity;
        const lo = Math.max(2, Math.floor(P * 0.8)), hi = Math.ceil(P * 1.2);
        if (t + hi + half < N && t - half >= 0) {
          for (let tau = lo; tau <= hi; tau++) {
            let c = 0, e = 0;
            for (let q = -half; q < half; q += 2) { const b = x[t + tau + q]; c += x[t + q] * b; e += b * b; }
            const sc = c / Math.sqrt(e + 1e-12);
            if (sc > bestC) { bestC = sc; bestTau = tau; }
          }
        }
        t += bestTau;
      } else {
        marks.push(t, 0);
        prevVoiced = false;
        t += Pu;
      }
    }
    const M = marks.length / 2;
    const pos = new Int32Array(M), voiced = new Uint8Array(M);
    for (let i = 0; i < M; i++) { pos[i] = marks[2 * i]; voiced[i] = marks[2 * i + 1]; }
    return { pos, voiced, Pu };
  };

  // curves: Float32Array (shift) or {shift, formant?, gain?, map?: {inT, outT} seconds}
  DSP.psola = function (x, sr, an, marks, curves) {
    if (curves instanceof Float32Array) curves = { shift: curves };
    const { shift, formant, gain, map } = curves;
    const N = x.length;
    const { pos, voiced, Pu } = marks;
    const M = pos.length;
    if (!M) return Float32Array.from(x);
    const hopS = an.hop * sr;
    const curveAt = (arr, t) => {
      const nF = arr.length, fp = t / hopS, fi = Math.floor(fp), fr = fp - fi;
      if (fi < 0) return arr[0];
      if (fi >= nF - 1) return arr[nF - 1];
      return arr[fi] + (arr[fi + 1] - arr[fi]) * fr;
    };
    let inA = null, outA = null, Nout = N;
    if (map && map.inT && map.inT.length >= 2) {
      inA = map.inT.map((v) => v * sr); outA = map.outT.map((v) => v * sr);
      const L = inA.length;
      // in -> out for the end
      let j = 0;
      while (j + 1 < L && inA[j + 1] < N) j++;
      const lastOut = j + 1 < L ? outA[j] + (N - inA[j]) * (outA[j + 1] - outA[j]) / (inA[j + 1] - inA[j]) : outA[j] + (N - inA[j]);
      Nout = Math.max(1, Math.round(lastOut));
    }
    let mj = 0;
    const outToIn = (u) => {
      if (!inA) return u;
      const L = inA.length;
      while (mj + 1 < L && outA[mj + 1] < u) mj++;
      if (mj + 1 >= L) return inA[L - 1] + (u - outA[L - 1]);
      const o0 = outA[mj], o1 = outA[mj + 1];
      return inA[mj] + (u - o0) * (inA[mj + 1] - inA[mj]) / Math.max(1e-9, o1 - o0);
    };
    const out = new Float32Array(Nout);
    let u = 0, k = 0;
    while (u < Nout) {
      const a = outToIn(u);
      while (k + 1 < M && pos[k + 1] <= a) k++;
      let m = k;
      if (k + 1 < M && Math.abs(pos[k + 1] - a) < Math.abs(pos[k] - a)) m = k + 1;
      const c = pos[m];
      const left = m > 0 ? c - pos[m - 1] : (voiced[m] ? (pos[m + 1] || c + Pu) - c : Pu);
      const right = m < M - 1 ? pos[m + 1] - c : left;
      const v = voiced[m];
      const r = v ? Math.pow(2, curveAt(shift, a) / 12) : 1;
      const fr = v && formant ? Math.pow(2, curveAt(formant, c) / 12) : 1;
      const g = gain ? curveAt(gain, c) : 1;
      const uc = Math.round(u);
      if (g > 1e-4) {
        if (fr === 1) {
          for (let s2 = -left; s2 < right; s2++) {
            const oi = uc + s2, ii = c + s2;
            if (oi < 0 || oi >= Nout || ii < 0 || ii >= N) continue;
            const w = s2 < 0 ? 0.5 - 0.5 * Math.cos(Math.PI * (s2 + left) / left) : 0.5 + 0.5 * Math.cos(Math.PI * s2 / right);
            out[oi] += x[ii] * w * g;
          }
        } else {
          for (let s2 = -left; s2 < right; s2++) {
            const oi = uc + s2;
            if (oi < 0 || oi >= Nout) continue;
            const ip = c + s2 * fr, i0 = Math.floor(ip);
            if (i0 < 0 || i0 + 1 >= N) continue;
            const val = x[i0] + (x[i0 + 1] - x[i0]) * (ip - i0);
            const w = s2 < 0 ? 0.5 - 0.5 * Math.cos(Math.PI * (s2 + left) / left) : 0.5 + 0.5 * Math.cos(Math.PI * s2 / right);
            out[oi] += val * w * g;
          }
        }
      }
      const step = v ? right / r : right;
      u += Math.max(8, step);
    }
    return out;
  };

  DSP.applyGain = function (x, sr, hop, gain) {
    const y = new Float32Array(x.length), hopS = hop * sr, nF = gain.length;
    for (let i = 0; i < x.length; i++) {
      const fp = i / hopS, fi = Math.floor(fp);
      const g = fi >= nF - 1 ? gain[nF - 1] : gain[fi] + (gain[fi + 1] - gain[fi]) * (fp - fi);
      y[i] = x[i] * g;
    }
    return y;
  };

  // ---------- FFT / chroma ----------
  function fftReal(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < len / 2; j++) {
          const a = i + j, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }
  DSP.fftReal = fftReal;

  // returns {hop, frames: Float32Array(12*n)}
  DSP.chroma = function (x, sr, progress) {
    const ASR = 8000;
    const y = resample(x, sr, ASR);
    const N = 4096, hop = 800; // 0.1s
    const nFr = Math.max(0, Math.floor((y.length - N) / hop) + 1);
    const frames = new Float32Array(12 * nFr);
    const re = new Float32Array(N), im = new Float32Array(N);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const binPc = new Int8Array(N / 2), binW = new Float32Array(N / 2);
    for (let b = 1; b < N / 2; b++) {
      const f = b * ASR / N;
      if (f < 65 || f > 2100) { binPc[b] = -1; continue; }
      const m = hzToMidi(f);
      const r = Math.round(m);
      binPc[b] = ((r % 12) + 12) % 12;
      binW[b] = Math.max(0, 1 - Math.abs(m - r) * 1.6);
    }
    for (let fi = 0; fi < nFr; fi++) {
      const o = fi * hop;
      for (let i = 0; i < N; i++) { re[i] = y[o + i] * win[i]; im[i] = 0; }
      fftReal(re, im);
      const base = fi * 12;
      for (let b = 1; b < N / 2; b++) {
        const pc = binPc[b];
        if (pc < 0) continue;
        const mag = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
        frames[base + pc] += Math.sqrt(mag) * binW[b];
      }
      if (progress && (fi & 63) === 0) progress(fi / nFr);
    }
    return { hop: hop / ASR, frames, n: nFr };
  };

  const KS_MAJ = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KS_MIN = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  function corr(a, b) {
    let ma = 0, mb = 0;
    for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
    ma /= 12; mb /= 12;
    let s = 0, sa = 0, sb = 0;
    for (let i = 0; i < 12; i++) { const da = a[i] - ma, db = b[i] - mb; s += da * db; sa += da * da; sb += db * db; }
    return s / Math.sqrt(sa * sb + 1e-12);
  }
  DSP.detectKey = function (pcHist) {
    const res = [];
    for (let t = 0; t < 12; t++) {
      const rot = new Array(12);
      for (let i = 0; i < 12; i++) rot[i] = pcHist[(i + t) % 12];
      res.push({ tonic: t, mode: 'major', score: corr(rot, KS_MAJ) });
      res.push({ tonic: t, mode: 'minor', score: corr(rot, KS_MIN) });
    }
    res.sort((a, b) => b.score - a.score);
    return res;
  };

  // chord templates (maj/min triads)
  const CHORDS = [];
  for (let r = 0; r < 12; r++) {
    CHORDS.push({ root: r, q: 'maj', pcs: [r, (r + 4) % 12, (r + 7) % 12] });
    CHORDS.push({ root: r, q: 'min', pcs: [r, (r + 3) % 12, (r + 7) % 12] });
  }
  DSP.CHORDS = CHORDS;

  // chroma vector over [t0,t1) seconds
  DSP.chromaRange = function (ch, t0, t1) {
    const v = new Float32Array(12);
    const a = Math.max(0, Math.floor(t0 / ch.hop)), b = Math.min(ch.n, Math.ceil(t1 / ch.hop) + 1);
    for (let f = a; f < b; f++) for (let p = 0; p < 12; p++) v[p] += ch.frames[f * 12 + p];
    return v;
  };

  DSP.bestChord = function (v, key) {
    let tot = 0;
    for (let p = 0; p < 12; p++) tot += v[p];
    if (tot <= 1e-6) return null;
    const set = key ? scaleSet(key) : null;
    let best = null, bs = -1e9;
    for (const c of CHORDS) {
      let inS = 0;
      for (const p of c.pcs) inS += v[p];
      let out = tot - inS;
      let sc = inS / tot - 0.35 * out / tot;
      if (set) { let diat = c.pcs.every((p) => set.has(p)); if (diat) sc += 0.08; }
      if (sc > bs) { bs = sc; best = c; }
    }
    return best;
  };

  // ---------- harmony line (Viterbi over notes) ----------
  // mel: [{t (midi target), s, e}] ; chords: array aligned (chord or null)
  // dir: 'up' | 'down'
  DSP.harmonyLine = function (mel, key, chords, dir, hopSec) {
    const set = scaleSet(key.mode === 'chromatic' ? { tonic: key.tonic, mode: 'major' } : key);
    const prefUp = { 3: 0, 4: 0, 5: 1.6, 7: 1.2, 8: 1.5, 9: 1.4, 2: 4, 6: 3.5 };
    const prefDn = { 3: 0, 4: 0, 5: 1.0, 7: 1.6, 8: 0.6, 9: 0.6, 2: 4, 6: 3.5 };
    const pref = dir === 'up' ? prefUp : prefDn;
    const sgn = dir === 'up' ? 1 : -1;
    const cands = mel.map((nt, i) => {
      const m = Math.round(nt.t);
      const list = [];
      for (let iv = 2; iv <= 9; iv++) {
        const h = m + sgn * iv;
        const pc = ((h % 12) + 12) % 12;
        if (!set.has(pc)) continue;
        let cost = pref[iv] != null ? pref[iv] : 3;
        const ch = chords && chords[i];
        if (ch) {
          const inCh = ch.pcs.includes(pc);
          const melIn = ch.pcs.includes(((m % 12) + 12) % 12);
          if (!inCh) cost += melIn ? 1.2 : 0.4;
        }
        list.push({ h, cost });
      }
      if (!list.length) list.push({ h: m + sgn * 4, cost: 5 });
      return list;
    });
    const n = mel.length;
    if (!n) return [];
    const D = cands.map((l) => new Float64Array(l.length).fill(Infinity));
    const B = cands.map((l) => new Int32Array(l.length).fill(-1));
    for (let j = 0; j < cands[0].length; j++) D[0][j] = cands[0][j].cost;
    for (let i = 1; i < n; i++) {
      const gap = (mel[i].s - mel[i - 1].e) * hopSec;
      const linked = gap < 0.6;
      const melMove = Math.round(mel[i].t) - Math.round(mel[i - 1].t);
      for (let j = 0; j < cands[i].length; j++) {
        let best = Infinity, bi = 0;
        for (let q = 0; q < cands[i - 1].length; q++) {
          let tc = 0;
          if (linked) {
            const leap = Math.abs(cands[i][j].h - cands[i - 1][q].h);
            tc = leap === 0 ? 0 : leap <= 2 ? 0.15 : leap <= 4 ? 0.45 : 0.9 + 0.3 * (leap - 5);
            const hMove = cands[i][j].h - cands[i - 1][q].h;
            if (melMove !== 0 && hMove !== 0 && Math.sign(melMove) !== Math.sign(hMove)) tc += 0.25;
          }
          const v = D[i - 1][q] + tc;
          if (v < best) { best = v; bi = q; }
        }
        D[i][j] = best + cands[i][j].cost;
        B[i][j] = bi;
      }
    }
    let bj = 0;
    for (let j = 1; j < cands[n - 1].length; j++) if (D[n - 1][j] < D[n - 1][bj]) bj = j;
    const res = new Array(n);
    for (let i = n - 1; i >= 0; i--) { res[i] = cands[i][bj].h; bj = B[i][bj]; }
    return res;
  };

  // ---------- fast FFT with tables ----------
  function makeFFT(n) {
    const rev = new Uint32Array(n);
    const bits = Math.log2(n) | 0;
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
    const cosT = new Float64Array(n / 2), sinT = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cosT[i] = Math.cos(2 * Math.PI * i / n); sinT[i] = -Math.sin(2 * Math.PI * i / n); }
    return function fft(re, im, inverse) {
      for (let i = 0; i < n; i++) { const j = rev[i]; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
      const sg = inverse ? -1 : 1;
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = 0, k = 0; j < half; j++, k += step) {
            const a = i + j, b = a + half;
            const wr = cosT[k], wi = sinT[k] * sg;
            const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
            re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          }
        }
      }
      if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    };
  }
  DSP.makeFFT = makeFFT;
  // Long-term tone profile of a sound (used by AI MIX): energy in 7 bands (dB, relative to the whole),
  // plus how much the level moves (dyn, dB). Only the parts where something sounds are counted.
  // bands: 0 sub(<80) 1 low(80-200) 2 low-mid(200-500) 3 mid(500-2k) 4 presence(2-5k) 5 sibilance(5-9k) 6 air(9-16k)
  DSP.BAND_EDGES = [20, 80, 200, 500, 2000, 5000, 9000, 16000];
  DSP.bandProfile = function (chs, sr, from, to) {
    const N = 4096, fft = makeFFT(N), E = DSP.BAND_EDGES;
    const a = chs[0], b = chs.length > 1 ? chs[1] : null;
    const s0 = Math.max(0, Math.round((from || 0) * sr)), s1 = Math.min(a.length, to ? Math.round(to * sr) : a.length);
    const total = Math.max(0, Math.floor((s1 - s0) / N));
    if (total < 4) return null;
    const step = Math.max(1, Math.floor(total / 500));
    const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const re = new Float64Array(N), im = new Float64Array(N);
    const frames = [];
    for (let f = 0; f < total; f += step) {
      const st = s0 + f * N; let e = 0;
      for (let i = 0; i < N; i++) { const v = b ? 0.5 * (a[st + i] + b[st + i]) : a[st + i]; re[i] = v * win[i]; im[i] = 0; e += v * v; }
      const rms = Math.sqrt(e / N);
      if (rms < 1e-5) continue;
      fft(re, im);
      const bands = new Float64Array(7);
      for (let k = 1; k < N / 2; k++) {
        const fr = k * sr / N; if (fr < E[0] || fr >= E[7]) continue;
        let q = 0; while (fr >= E[q + 1]) q++;
        bands[q] += re[k] * re[k] + im[k] * im[k];
      }
      frames.push({ rms, bands });
    }
    if (frames.length < 4) return null;
    const mx = frames.reduce((m, f) => Math.max(m, f.rms), 0);
    const act = frames.filter((f) => f.rms > mx * 0.0316);
    const sum = new Float64Array(7); let tot = 0;
    for (const f of act) for (let q = 0; q < 7; q++) { sum[q] += f.bands[q]; tot += f.bands[q]; }
    const lv = act.map((f) => 20 * Math.log10(f.rms)).sort((x, y) => x - y);
    const pc = (p) => lv[Math.min(lv.length - 1, Math.floor(lv.length * p))];
    return { bands: Array.from(sum, (v) => 10 * Math.log10(v / (tot + 1e-30) + 1e-12)), dyn: pc(0.95) - pc(0.3), level: pc(0.7) };
  };
  // WAV writer in small parts (no single huge allocation)
  DSP.encodeWav = function encodeWav(channels, sampleRate, bits) {
    const nCh = channels.length, n = channels[0].length;
    const bps = bits / 8;
    const dataLen = n * nCh * bps;
    const hdr = new ArrayBuffer(44);
    const v = new DataView(hdr);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); ws(8, 'WAVE');
    ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nCh, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nCh * bps, true);
    v.setUint16(32, nCh * bps, true); v.setUint16(34, bits, true);
    ws(36, 'data'); v.setUint32(40, dataLen, true);
    const parts = [hdr];
    const CH = 131072;
    for (let s0 = 0; s0 < n; s0 += CH) {
      const m = Math.min(CH, n - s0);
      const u8 = new Uint8Array(m * nCh * bps);
      let o = 0;
      if (bits === 16) {
        for (let i = s0; i < s0 + m; i++) for (let c = 0; c < nCh; c++) {
          const s = Math.max(-1, Math.min(1, channels[c][i] + (Math.random() - Math.random()) / 32768));
          const iv = s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
          u8[o++] = iv & 255; u8[o++] = (iv >> 8) & 255;
        }
      } else {
        for (let i = s0; i < s0 + m; i++) for (let c = 0; c < nCh; c++) {
          const s = Math.max(-1, Math.min(1, channels[c][i]));
          const iv = Math.round(s < 0 ? s * 8388608 : s * 8388607);
          u8[o++] = iv & 255; u8[o++] = (iv >> 8) & 255; u8[o++] = (iv >> 16) & 255;
        }
      }
      parts.push(u8);
    }
    return new Blob(parts, { type: 'audio/wav' });
  };

  function biquadCoefs(type, f0, sr, q, gainDb) {
    const w = 2 * Math.PI * f0 / sr, cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
    else if (type === 'hp') { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
    else { // high shelf
      const A = Math.pow(10, gainDb / 40), sA = 2 * Math.sqrt(A) * al;
      b0 = A * ((A + 1) + (A - 1) * cs + sA); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - sA);
      a0 = (A + 1) - (A - 1) * cs + sA; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - sA;
    }
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }
  function biquadRun(x, c, reverse) {
    const y = new Float32Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    const n = x.length;
    for (let j = 0; j < n; j++) {
      const i = reverse ? n - 1 - j : j;
      const xi = x[i];
      const yi = c[0] * xi + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
      x2 = x1; x1 = xi; y2 = y1; y1 = yi; y[i] = yi;
    }
    return y;
  }
  DSP.biquadCoefs = biquadCoefs;
  DSP.biquadRun = biquadRun;

  // ---------- spectral noise reduction ----------
  // opts: {reduceDb, sens (0..1), auto, profile: [startSample, endSample] | null}
  // Noise reduction v2:
  //  - the noise "fingerprint" comes from the quietest moments, and its level is then followed over time
  //    in 24 frequency bands (so a fan / air conditioner / street noise that changes is still tracked)
  //  - Wiener-style gain with decision-directed smoothing (far less "watery" artefacts than plain subtraction)
  //  - a soft gate makes the gaps between phrases quieter still (with look-ahead and hold so words are not chopped)
  //  - rumble below ~55 Hz is removed
  DSP.denoise = function (x, sr, opts, progress) {
    const N = sr > 60000 ? 2048 : 1024, hop = N / 4, nb = N / 2 + 1;
    const fft = makeFFT(N);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const len = x.length;
    const F = Math.ceil((len + N) / hop);
    const re = new Float64Array(N), im = new Float64Array(N);
    const frameStart = (f) => f * hop - (N - hop);
    const load = (f) => {
      const st = frameStart(f);
      for (let i = 0; i < N; i++) { const j = st + i; re[i] = j >= 0 && j < len ? x[j] * win[i] : 0; im[i] = 0; }
    };
    // frequency bands (log spaced)
    const NB = 24, bandOf = new Uint8Array(nb), fLo = 50, fHi = sr / 2;
    for (let b = 0; b < nb; b++) {
      const f = Math.max(fLo, b * sr / N);
      bandOf[b] = Math.min(NB - 1, Math.floor(NB * Math.log(f / fLo) / Math.log(fHi / fLo)));
    }
    const cutBin = Math.ceil(55 * N / sr);
    // pass 1: frame energy + band amplitudes
    const en = new Float64Array(F), bandA = new Float32Array(F * NB);
    const tmp = new Float64Array(NB);
    for (let f = 0; f < F; f++) {
      load(f); fft(re, im);
      tmp.fill(0);
      let e = 0;
      for (let b = cutBin; b < nb; b++) { const p2 = re[b] * re[b] + im[b] * im[b]; tmp[bandOf[b]] += p2; e += p2; }
      en[f] = e;
      for (let k = 0; k < NB; k++) bandA[f * NB + k] = Math.sqrt(tmp[k]);
      if (progress && (f & 255) === 0) progress(0.35 * f / F);
    }
    let chosen = [];
    if (opts.profile) {
      for (let f = 0; f < F; f++) { const st = frameStart(f); if (st >= opts.profile[0] && st + N <= opts.profile[1]) chosen.push(f); }
    }
    const active = [];
    for (let f = 0; f < F; f++) if (en[f] > 1e-12) active.push(f);
    if (!active.length) return { y: Float32Array.from(x), noiseDb: -120, snr: 99 };
    active.sort((a, b) => en[a] - en[b]);
    if (!chosen.length) chosen = active.slice(0, Math.max(4, Math.floor(active.length * 0.08)));
    // fine fingerprint from the chosen frames
    const prof = new Float64Array(nb), profBand = new Float64Array(NB);
    let nE = 0;
    for (const f of chosen) {
      load(f); fft(re, im);
      for (let b = 0; b < nb; b++) prof[b] += Math.hypot(re[b], im[b]);
      for (let k = 0; k < NB; k++) profBand[k] += bandA[f * NB + k];
      const st = frameStart(f); let e = 0, c = 0;
      for (let i = 0; i < N; i += 4) { const j = st + i; if (j >= 0 && j < len) { e += x[j] * x[j]; c++; } }
      nE += c ? e / c : 0;
    }
    for (let b = 0; b < nb; b++) prof[b] /= chosen.length;
    for (let k = 0; k < NB; k++) profBand[k] = profBand[k] / chosen.length + 1e-12;
    const noiseDb = 10 * Math.log10(nE / chosen.length + 1e-20);
    let sigE = 0; { const f = active[Math.floor(active.length * 0.6)]; const st = frameStart(f); let e = 0, c = 0; for (let i = 0; i < N; i += 4) { const j = st + i; if (j >= 0 && j < len) { e += x[j] * x[j]; c++; } } sigE = c ? e / c : 0; }
    const snr = 10 * Math.log10((sigE + 1e-20) / (nE / chosen.length + 1e-20));
    // follow the noise level over time: minimum of the smoothed band amplitude in ~0.5 s blocks, +-4 blocks
    const BL = Math.max(8, Math.round(0.5 * sr / hop)), nBlk = Math.ceil(F / BL);
    const blkMin = new Float32Array(nBlk * NB).fill(1e30);
    for (let k = 0; k < NB; k++) {
      let acc = 0;
      for (let f = 0; f < F; f++) {
        acc += bandA[f * NB + k]; if (f >= 5) acc -= bandA[(f - 5) * NB + k];
        if (f >= 4) { const v = acc / 5, q = Math.floor(f / BL) * NB + k; if (v < blkMin[q]) blkMin[q] = v; }
      }
    }
    const locMin = (blk, k) => { let m = 1e30; for (let q = Math.max(0, blk - 2); q <= Math.min(nBlk - 1, blk + 2); q++) { const v = blkMin[q * NB + k]; if (v < m) m = v; } return m; };
    const ref = new Float64Array(NB);
    for (let k = 0; k < NB; k++) {
      const vals = chosen.map((f) => locMin(Math.floor(f / BL), k)).filter((v) => v < 1e29).sort((p, q) => p - q);
      ref[k] = vals.length ? vals[vals.length >> 1] + 1e-12 : 1e-12;
    }
    const track = !opts.profile; // a hand-picked noise sample is used as it is
    const ratio = new Float32Array(nBlk * NB).fill(1);
    if (track) for (let q = 0; q < nBlk; q++) for (let k = 0; k < NB; k++) { const m = locMin(q, k); ratio[q * NB + k] = m > 1e29 ? 1 : Math.max(0.6, Math.min(3, m / ref[k])); }
    // strength
    let reduceDb = opts.reduceDb, sens = opts.sens, gateDb = opts.gate || 0;
    if (opts.auto) {
      const L = Math.max(0, Math.min(2, opts.level || 0));
      reduceDb = (noiseDb < -75 ? 8 : noiseDb < -62 ? 14 : noiseDb < -50 ? 18 : 22) + 6 * L;
      sens = 0.45 + 0.3 * L;
      gateDb = (noiseDb < -80 ? 4 : 8) + 6 * L;
      if (snr < 12) { reduceDb = Math.min(reduceDb, 8 + 4 * L); sens = 0.2 + 0.2 * L; gateDb = Math.min(gateDb, 6); }
    }
    const floor = Math.pow(10, -reduceDb / 20), mu = 0.6 + sens * 2.2;
    // gate: decide per frame from the voice-band SNR (known from pass 1), with look-ahead and hold
    const gate = new Float32Array(F).fill(1);
    if (gateDb > 0) {
      const gFloor = Math.pow(10, -gateDb / 20);
      const k0 = bandOf[Math.round(150 * N / sr)], k1 = bandOf[Math.min(nb - 1, Math.round(6000 * N / sr))];
      const open = new Float32Array(F);
      for (let f = 0; f < F; f++) {
        const q = Math.floor(f / BL); let s2 = 0, n2 = 0;
        for (let k = k0; k <= k1; k++) { const a = bandA[f * NB + k], n = profBand[k] * ratio[q * NB + k]; s2 += a * a; n2 += n * n; }
        const r = s2 / (n2 + 1e-20);                       // 1 = only noise
        open[f] = Math.max(0, Math.min(1, (r - 2.2) / 4)); // fully open from ~8 dB above the noise
      }
      const LA = Math.round(0.03 * sr / hop), HOLD = Math.round(0.14 * sr / hop);
      let held = 0, cur = 0;
      for (let f = 0; f < F; f++) {
        let o = 0; for (let j = f; j <= Math.min(F - 1, f + LA); j++) if (open[j] > o) o = open[j];
        if (o >= cur) { cur = o; if (o > 0.5) held = HOLD; }
        else if (held > 0) held--;
        else cur = cur * 0.9 + o * 0.1;
        gate[f] = gFloor + (1 - gFloor) * cur;
      }
    }
    // pass 2: process
    const out = new Float32Array(len);
    const prevG = new Float32Array(nb).fill(1), prevPost = new Float32Array(nb).fill(1), g = new Float32Array(nb);
    const AL = 0.9;
    for (let f = 0; f < F; f++) {
      load(f); fft(re, im);
      const q = Math.floor(f / BL) * NB, gf = gate[f];
      for (let b = 0; b < nb; b++) {
        if (b < cutBin) { g[b] = 0; continue; }
        const n = prof[b] * ratio[q + bandOf[b]];
        const post = (re[b] * re[b] + im[b] * im[b]) / (n * n + 1e-24);
        const prio = AL * prevG[b] * prevG[b] * prevPost[b] + (1 - AL) * Math.max(post - 1, 0);
        let gg = prio / (prio + mu);
        if (gg < floor) gg = floor;
        prevG[b] = gg; prevPost[b] = post;
        g[b] = gg;
      }
      for (let b = 0; b < nb; b++) {
        const v = b < cutBin ? 0 : (g[Math.max(cutBin, b - 1)] * 0.25 + g[b] * 0.5 + g[Math.min(nb - 1, b + 1)] * 0.25) * gf;
        re[b] *= v; im[b] *= v;
        if (b > 0 && b < N / 2) { re[N - b] *= v; im[N - b] *= v; }
      }
      fft(re, im, true);
      const st = frameStart(f);
      for (let i = 0; i < N; i++) { const j = st + i; if (j >= 0 && j < len) out[j] += re[i] * win[i] / 1.5; }
      if (progress && (f & 255) === 0) progress(0.35 + 0.65 * f / F);
    }
    return { y: out, noiseDb, snr, reduceDb, gateDb };
  };

  // ---------- lip noise / click removal ----------
  DSP.declick = function (x, sr, sens, an) {
    const len = x.length;
    const hpC = biquadCoefs('hp', 3000, sr, 0.707);
    const hp = biquadRun(biquadRun(x, hpC), hpC);
    const W = Math.round(0.015 * sr);
    const cs = new Float64Array(len + 1);
    for (let i = 0; i < len; i++) cs[i + 1] = cs[i] + Math.abs(hp[i]);
    // sens 0..1 = normal range, up to 1.3 = "最強" (catches smaller clicks too)
    const thr = sens <= 1 ? 9 - 6 * sens : Math.max(1.6, 3 - 4.5 * (sens - 1)), absMin = Math.max(0.0012, 0.004 - 0.002 * Math.min(1, sens) - 0.002 * Math.max(0, sens - 1));
    const maxLen = Math.round(0.004 * sr), pad = Math.round(0.001 * sr), gapJoin = Math.round(0.001 * sr);
    const regions = [];
    let a = -1, lastHit = -1;
    for (let i = 0; i < len; i++) {
      const lo = Math.max(0, i - W), hi = Math.min(len, i + W);
      const bg = (cs[hi] - cs[lo]) / (hi - lo);
      const e = Math.abs(hp[i]);
      let th = thr;
      let P = 0;
      if (an) {
        const fi = Math.round(i / (an.hop * sr));
        const f0 = fi >= 0 && fi < an.f0.length ? an.f0[fi] : 0;
        if (f0) { th = thr * 1.8; P = Math.round(sr / f0); }
      }
      if (e > absMin && e > th * bg) {
        // glottal pulses repeat every period; real clicks don't
        if (P) {
          let rep = false;
          for (const dir of [-1, 1]) {
            const c0 = i + dir * P, r = Math.max(2, Math.round(P * 0.12));
            for (let q = c0 - r; q <= c0 + r; q++) if (q >= 0 && q < len && Math.abs(hp[q]) > e * 0.45) { rep = true; break; }
            if (rep) break;
          }
          if (rep) continue;
        }
        if (a < 0 || i - lastHit > gapJoin) { if (a >= 0) regions.push([a, lastHit]); a = i; }
        lastHit = i;
      }
    }
    if (a >= 0) regions.push([a, lastHit]);
    const lpC = biquadCoefs('lp', 1800, sr, 0.707);
    const lp = biquadRun(biquadRun(x, lpC), lpC, true);
    const y = Float32Array.from(x);
    let count = 0;
    const fadeN = Math.max(4, Math.round(0.0006 * sr));
    for (const [r0, r1] of regions) {
      if (r1 - r0 > maxLen) continue;
      const s0 = Math.max(0, r0 - pad), s1 = Math.min(len - 1, r1 + pad);
      for (let i = s0 - fadeN; i <= s1 + fadeN; i++) {
        if (i < 0 || i >= len) continue;
        let w = 1;
        if (i < s0) w = (i - (s0 - fadeN)) / fadeN; else if (i > s1) w = 1 - (i - s1) / fadeN;
        y[i] = x[i] * (1 - w) + lp[i] * w;
      }
      count++;
    }
    return { y, count };
  };

  // ---------- breath reduction (needs pitch analysis) ----------
  DSP.breathReduce = function (x, sr, an, db) {
    if (!db) return { y: x, count: 0 };
    const hopS = an.hop * sr, n = an.f0.length;
    const vr = [];
    for (let k = 0; k < n; k++) if (an.f0[k]) vr.push(an.rms[k]);
    if (!vr.length) return { y: x, count: 0 };
    vr.sort((p, q) => p - q);
    const vmed = vr[vr.length >> 1];
    const gain = new Float32Array(n).fill(1);
    const gl = Math.pow(10, -db / 20);
    let count = 0, k = 0;
    while (k < n) {
      if (an.f0[k]) { k++; continue; }
      let j = k; while (j < n && !an.f0[j]) j++;
      const a = k + 2, b = j - 4; // keep consonant right before the next vowel
      // stronger settings also catch shorter / louder breaths
      const strong = db > 18;
      if (b - a >= (strong ? 9 : 13)) {
        let mx = 0, sum = 0;
        for (let q = a; q < b; q++) { mx = Math.max(mx, an.rms[q]); sum += an.rms[q]; }
        const mean = sum / (b - a);
        if (mean > vmed * 0.015 && mx < vmed * (strong ? 0.9 : 0.7)) { for (let q = a; q < b; q++) gain[q] = gl; count++; }
      }
      k = j;
    }
    const g = smoothArr(gain, 2);
    return { y: DSP.applyGain(x, sr, an.hop, g), count };
  };

  // ---------- phase-vocoder pitch shift (for backing tracks) ----------
  DSP.pitchShiftPV = function (x, sr, semis, progress) {
    if (!semis) return Float32Array.from(x);
    const ratio = Math.pow(2, semis / 12);
    const N = 4096, Ha = 1024, Hs = Math.round(Ha * ratio), nb = N / 2 + 1;
    const fft = makeFFT(N);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const len = x.length;
    const F = Math.ceil(len / Ha) + 2;
    const L2 = F * Hs + N;
    const y = new Float32Array(L2), wsum = new Float32Array(L2);
    const re = new Float64Array(N), im = new Float64Array(N);
    const mag = new Float64Array(nb), ph = new Float64Array(nb);
    const prevPh = new Float64Array(nb), synPh = new Float64Array(nb);
    const omega = new Float64Array(nb);
    for (let b = 0; b < nb; b++) omega[b] = 2 * Math.PI * b * Ha / N;
    const peaks = new Int32Array(nb);
    for (let f = 0; f < F; f++) {
      const st = f * Ha - N / 2;
      for (let i = 0; i < N; i++) { const j = st + i; re[i] = j >= 0 && j < len ? x[j] * win[i] : 0; im[i] = 0; }
      fft(re, im);
      for (let b = 0; b < nb; b++) { mag[b] = Math.hypot(re[b], im[b]); ph[b] = Math.atan2(im[b], re[b]); }
      // peaks
      let np = 0;
      for (let b = 2; b < nb - 2; b++) if (mag[b] > mag[b - 1] && mag[b] >= mag[b + 1] && mag[b] > mag[b - 2] && mag[b] >= mag[b + 2]) peaks[np++] = b;
      if (f === 0) {
        for (let b = 0; b < nb; b++) synPh[b] = ph[b];
      } else if (np === 0) {
        for (let b = 0; b < nb; b++) {
          let d = ph[b] - prevPh[b] - omega[b]; d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
          synPh[b] += (omega[b] + d) * ratio;
        }
      } else {
        const newSyn = new Float64Array(nb);
        for (let p = 0; p < np; p++) {
          const pk = peaks[p];
          let d = ph[pk] - prevPh[pk] - omega[pk]; d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
          newSyn[pk] = synPh[pk] + (omega[pk] + d) * ratio;
        }
        // region of influence: bins lock to nearest peak
        let p = 0;
        for (let b = 0; b < nb; b++) {
          while (p + 1 < np && Math.abs(peaks[p + 1] - b) < Math.abs(peaks[p] - b)) p++;
          const pk = peaks[p];
          newSyn[b] = newSyn[pk] + (ph[b] - ph[pk]);
        }
        for (let b = 0; b < nb; b++) synPh[b] = newSyn[b];
      }
      for (let b = 0; b < nb; b++) prevPh[b] = ph[b];
      for (let b = 0; b < nb; b++) {
        re[b] = mag[b] * Math.cos(synPh[b]); im[b] = mag[b] * Math.sin(synPh[b]);
        if (b > 0 && b < N / 2) { re[N - b] = re[b]; im[N - b] = -im[b]; }
      }
      fft(re, im, true);
      const os = f * Hs;
      for (let i = 0; i < N; i++) { y[os + i] += re[i] * win[i]; wsum[os + i] += win[i] * win[i]; }
      if (progress && (f & 63) === 0) progress(f / F * 0.9);
    }
    for (let i = 0; i < L2; i++) y[i] = wsum[i] > 1e-3 ? y[i] / wsum[i] : 0;
    // stretched signal: input time t maps to t*(Hs/Ha) + offset of N/2*(ratio_eff-1)
    const eff = Hs / Ha;
    let src = y;
    if (eff > 1) { const c = biquadCoefs('lp', sr / 2 / eff * 0.92, sr, 0.54); const c2 = biquadCoefs('lp', sr / 2 / eff * 0.92, sr, 1.31); src = biquadRun(biquadRun(y, c), c2); }
    const out = new Float32Array(len);
    // input time t (frame centre f*Ha) lands at f*Hs + N/2 in the stretched signal
    for (let i = 0; i < len; i++) {
      const p = i * eff + N / 2;
      const i0 = Math.floor(p), fr = p - i0;
      const a = src[i0 - 1] || 0, b = src[i0] || 0, c = src[i0 + 1] || 0, d = src[i0 + 2] || 0;
      out[i] = b + 0.5 * fr * (c - a + fr * (2 * a - 5 * b + 4 * c - d + fr * (3 * (b - c) + d - a)));
    }
    return out;
  };

  // ---------- loudness (ITU-R BS.1770) and limiter ----------
  // streaming: no full-length copies (keeps memory low on phones)
  DSP.loudness = function (chs, sr) {
    const s1 = biquadCoefs('hs', 1681.974450955533, sr, 0.7071752369554196, 3.999843853973347);
    const s2 = biquadCoefs('hp', 38.13547087602444, sr, 0.5003270373238773);
    const step = Math.round(0.1 * sr), n = chs[0].length, nSub = Math.floor(n / step);
    if (nSub < 4) return -70;
    const sub = new Float64Array(nSub);
    for (const c of chs) {
      let a1 = 0, a2 = 0, b1 = 0, b2 = 0, c1 = 0, c2 = 0, d1 = 0, d2 = 0, acc = 0, k = 0, cnt = 0;
      for (let i = 0; i < nSub * step; i++) {
        const x = c[i];
        const y = s1[0] * x + s1[1] * a1 + s1[2] * a2 - s1[3] * b1 - s1[4] * b2;
        a2 = a1; a1 = x; b2 = b1; b1 = y;
        const z = s2[0] * y + s2[1] * c1 + s2[2] * c2 - s2[3] * d1 - s2[4] * d2;
        c2 = c1; c1 = y; d2 = d1; d1 = z;
        acc += z * z;
        if (++cnt === step) { sub[k++] += acc / step; acc = 0; cnt = 0; }
      }
    }
    const blocks = [];
    for (let j = 0; j + 4 <= nSub; j++) blocks.push((sub[j] + sub[j + 1] + sub[j + 2] + sub[j + 3]) / 4);
    const lk = (z) => -0.691 + 10 * Math.log10(z + 1e-20);
    const g1 = blocks.filter((z) => lk(z) > -70);
    if (!g1.length) return -70;
    const rel = lk(g1.reduce((x, y) => x + y, 0) / g1.length) - 10;
    const g2 = g1.filter((z) => lk(z) > rel);
    return lk(g2.reduce((x, y) => x + y, 0) / Math.max(1, g2.length));
  };

  // streaming look-ahead limiter, in place, small ring buffers only
  DSP.limit = function (chs, sr, ceilDb, gainDb) {
    const ceil = Math.pow(10, ceilDb / 20), pre = Math.pow(10, (gainDb || 0) / 20);
    const n = chs[0].length, L = Math.max(2, Math.round(0.005 * sr)), cap = L + 4;
    const qi = new Int32Array(cap), qv = new Float32Array(cap);
    let head = 0, size = 0, pushed = 0;
    const ring = new Float32Array(L);
    let sum = 0;
    const rel = Math.exp(-1 / (0.08 * sr));
    let g = 1;
    const reqAt = (j) => { let pk = 0; for (const c of chs) { const v = Math.abs(c[j] * pre); if (v > pk) pk = v; } return pk > ceil ? ceil / pk : 1; };
    for (let i = 0; i < n; i++) {
      const lim = Math.min(n - 1, i + L);
      while (pushed <= lim) {
        const v = reqAt(pushed);
        while (size > 0 && qv[(head + size - 1) % cap] >= v) size--;
        qi[(head + size) % cap] = pushed; qv[(head + size) % cap] = v; size++;
        pushed++;
      }
      while (size > 0 && qi[head] < i) { head = (head + 1) % cap; size--; }
      const m = size ? qv[head] : 1;
      const r = i % L;
      sum += m - ring[r]; ring[r] = m;
      const avg = sum / Math.min(i + 1, L);
      g = avg < g ? avg : avg + (g - avg) * rel;
      for (const c of chs) { let v = c[i] * pre * g; if (v > ceil) v = ceil; else if (v < -ceil) v = -ceil; c[i] = v; }
    }
    return chs;
  };

  // ---------- harmony that keeps a scale interval ----------
  DSP.diatonicLine = function (mel, key, steps) {
    const k = key.mode === 'chromatic' ? { tonic: key.tonic, mode: 'major' } : key;
    const sc = SCALES[k.mode];
    return mel.map((nt) => {
      const sn = snapToScale(nt.t, k);
      const rel = sn - k.tonic, oct = Math.floor(rel / 12), pc = rel - oct * 12;
      const idx = sc.indexOf(pc);
      const deg = oct * 7 + idx + steps;
      const o2 = Math.floor(deg / 7), i2 = deg - o2 * 7;
      return k.tonic + o2 * 12 + sc[i2];
    });
  };

  // ---------- WAV parser (fallback when the browser can't decode) ----------
  DSP.parseWav = function (ab) {
    const dv = new DataView(ab);
    const str = (o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(dv.getUint8(o + i)); return s; };
    if (ab.byteLength < 44 || str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') return null;
    let o = 12, fmt = null, data = null;
    while (o + 8 <= ab.byteLength) {
      const id = str(o, 4), sz = dv.getUint32(o + 4, true);
      if (id === 'fmt ') {
        let tag = dv.getUint16(o + 8, true);
        const ch = dv.getUint16(o + 10, true), sr = dv.getUint32(o + 12, true), bits = dv.getUint16(o + 22, true);
        if (tag === 0xfffe && sz >= 26) tag = dv.getUint16(o + 32, true);
        fmt = { tag, ch, sr, bits };
      } else if (id === 'data') { data = { o: o + 8, sz: Math.min(sz, ab.byteLength - o - 8) }; }
      o += 8 + sz + (sz & 1);
    }
    if (!fmt || !data) return null;
    const bps = fmt.bits / 8, frames = Math.floor(data.sz / (bps * fmt.ch));
    const chs = Array.from({ length: fmt.ch }, () => new Float32Array(frames));
    for (let i = 0; i < frames; i++) for (let c = 0; c < fmt.ch; c++) {
      const p = data.o + (i * fmt.ch + c) * bps;
      let v = 0;
      if (fmt.tag === 3) v = bps === 4 ? dv.getFloat32(p, true) : dv.getFloat64(p, true);
      else if (bps === 1) v = (dv.getUint8(p) - 128) / 128;
      else if (bps === 2) v = dv.getInt16(p, true) / 32768;
      else if (bps === 3) { let iv = dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getUint8(p + 2) << 16); if (iv & 0x800000) iv -= 0x1000000; v = iv / 8388608; }
      else if (bps === 4) v = dv.getInt32(p, true) / 2147483648;
      chs[c][i] = v;
    }
    return { sr: fmt.sr, channels: chs };
  };


  // ---------- tempo estimation (for delay sync) ----------
  DSP.estimateBPM = function (x, sr) {
    const ASR = 8000, y = resample(x, sr, ASR);
    const N = 512, hop = 128, hopSec = hop / ASR, nb = N / 2;
    const fft = makeFFT(N);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    const F = Math.max(0, Math.floor((y.length - N) / hop));
    if (F < 200) return null;
    const env = new Float32Array(F);
    const re = new Float64Array(N), im = new Float64Array(N), prev = new Float64Array(nb);
    for (let f = 0; f < F; f++) {
      const o = f * hop;
      for (let i = 0; i < N; i++) { re[i] = y[o + i] * win[i]; im[i] = 0; }
      fft(re, im);
      let fl = 0;
      for (let b = 1; b < nb; b++) { const m = Math.log(1 + 100 * Math.hypot(re[b], im[b])); const d = m - prev[b]; if (d > 0) fl += d; prev[b] = m; }
      env[f] = fl;
    }
    // remove slow trend
    const sm = smoothArr(env, 25);
    for (let f = 0; f < F; f++) env[f] = Math.max(0, env[f] - sm[f]);
    const lagOf = (bpm) => 60 / bpm / hopSec;
    const ac = (lag) => { const l0 = Math.floor(lag), fr = lag - l0; let s1 = 0; for (let i = 0; i + l0 + 1 < F; i++) s1 += env[i] * (env[i + l0] * (1 - fr) + env[i + l0 + 1] * fr); return s1; };
    let best = 120, bs = -1;
    for (let bpm = 70; bpm <= 180; bpm += 0.5) {
      const L = lagOf(bpm);
      const sc = (ac(L) + 0.5 * ac(2 * L) + 0.25 * ac(L / 2)) * Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.6, 2));
      if (sc > bs) { bs = sc; best = bpm; }
    }
    return Math.round(best);
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = DSP;
  else root.DSP = DSP;
})(typeof self !== 'undefined' ? self : this);
