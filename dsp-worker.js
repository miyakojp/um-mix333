/* UtaMix DSP worker: heavy audio processing off the UI thread. No network access is used. */
'use strict';
importScripts('dsp-core.js', 'mix-core.js');
let mixer = null;

const store = new Map(); // id -> {sr, chs, data (mono), an, marks, chroma, clean: {key, y, info}, keyshift: Map}

function entry(id) {
  const e = store.get(id);
  if (!e) throw new Error('audio not loaded: ' + id);
  return e;
}
function mono(chs) {
  if (chs.length === 1) return chs[0];
  const n = chs[0].length, out = new Float32Array(n);
  for (const c of chs) for (let i = 0; i < n; i++) out[i] += c[i] / chs.length;
  return out;
}
function ensureAn(e, prog) {
  if (!e.an) { e.an = DSP.analyzePitch(e.data, e.sr, {}, prog); e.marks = null; }
  return e.an;
}

// noise / click / breath cleanup, cached by settings
function cleaned(e, c, prog) {
  const key = JSON.stringify(c);
  if (!e.cleanCache) e.cleanCache = new Map();
  if (e.cleanCache.has(key)) return e.cleanCache.get(key);
  let y = e.data;
  const info = {};
  if (c.nr) {
    const prof = c.profile ? [Math.round(c.profile[0] * e.sr), Math.round(c.profile[1] * e.sr)] : null;
    const r = DSP.denoise(y, e.sr, { auto: c.auto, level: c.level, reduceDb: c.reduceDb, sens: c.sens, gate: c.gate, profile: prof }, (p) => prog && prog(p * 0.6));
    y = r.y; info.noiseDb = r.noiseDb; info.snr = r.snr; info.reduceDb = r.reduceDb;
  }
  if (c.click > 0) {
    const r = DSP.declick(y, e.sr, c.click, ensureAn(e));
    y = r.y; info.clicks = r.count;
  }
  if (c.breath > 0) {
    const r = DSP.breathReduce(y, e.sr, ensureAn(e), c.breath);
    y = r.y; info.breaths = r.count;
  }
  const res = { key, y, info };
  e.cleanCache.set(key, res);
  while (e.cleanCache.size > 1) e.cleanCache.delete(e.cleanCache.keys().next().value);
  return res;
}

self.onmessage = (ev) => {
  const msg = ev.data;
  const reply = (payload, transfer) => self.postMessage(Object.assign({ reqId: msg.reqId }, payload), transfer || []);
  const prog = (p) => self.postMessage({ reqId: msg.reqId, progress: p });
  try {
    switch (msg.type) {
      case 'load': {
        const chs = msg.chs || [msg.data];
        store.set(msg.id, { sr: msg.sr, chs, data: mono(chs), an: null, marks: null, chroma: null, clean: null, keyshift: new Map() });
        reply({ ok: true });
        break;
      }
      case 'drop': {
        store.delete(msg.id);
        reply({ ok: true });
        break;
      }
      case 'setAnalysis': {
        const e = entry(msg.id);
        e.an = msg.an; e.marks = null;
        reply({ ok: true });
        break;
      }
      case 'analyze': {
        const e = entry(msg.id);
        ensureAn(e, (p) => prog(p * 0.95));
        const notes = DSP.segmentNotes(e.an);
        reply({ ok: true, an: { hop: e.an.hop, f0: e.an.f0, rms: e.an.rms }, notes });
        break;
      }
      // vocal processing: cleanup -> (pitch/time/formant/gain via PSOLA) or gain-only
      case 'process': {
        const e = entry(msg.id);
        let x = e.data;
        let info = null;
        if (msg.clean) { const c = cleaned(e, msg.clean, prog); x = c.y; info = c.info; }
        let out;
        if (msg.pitch) {
          const an = ensureAn(e);
          if (!e.marks) e.marks = DSP.pitchMarks(e.data, e.sr, an);
          out = DSP.psola(x, e.sr, an, e.marks, msg.curves);
        } else if (msg.curves && msg.curves.gain) {
          out = DSP.applyGain(x, e.sr, msg.curves.hop, msg.curves.gain);
        } else {
          out = Float32Array.from(x);
        }
        reply({ ok: true, out, info }, [out.buffer]);
        break;
      }
      case 'keyshift': {
        const e = entry(msg.id);
        const chs = e.chs.map((c, i) => DSP.pitchShiftPV(c, e.sr, msg.semis, (p) => prog((i + p) / e.chs.length)));
        reply({ ok: true, chs }, chs.map((c) => c.buffer));
        break;
      }
      case 'chroma': {
        const e = entry(msg.id);
        if (!e.chroma) e.chroma = DSP.chroma(e.data, e.sr, prog);
        reply({ ok: true, chroma: { hop: e.chroma.hop, n: e.chroma.n, frames: e.chroma.frames } });
        break;
      }
      case 'bpm': {
        const e = entry(msg.id);
        reply({ ok: true, bpm: DSP.estimateBPM(e.data, e.sr) });
        break;
      }
      case 'loudness': {
        reply({ ok: true, lufs: DSP.loudness(msg.chs, msg.sr) });
        break;
      }
      // ---- mix renderer (書き出し・バランス・バックグラウンド再生) ----
      case 'mixBegin': {
        mixer = new MIX.Mixer(msg.cfg);
        reply({ ok: true });
        break;
      }
      case 'mixChunk': {
        if (!mixer) throw new Error('mixer not started');
        mixer.chunk(msg.srcs, msg.len);
        reply({ ok: true });
        break;
      }
      case 'mixEnd': {
        if (!mixer) throw new Error('mixer not started');
        const m = mixer; mixer = null;
        let L = m.L, R = m.R;
        const sr = m.sr;
        if (msg.mode === 'measure') { reply({ ok: true, lufs: DSP.loudness([L, R], sr) }); break; }
        if (msg.mode === 'profile') { reply({ ok: true, lufs: DSP.loudness([L, R], sr), profile: DSP.bandProfile([L, R], sr) }); break; }
        let last = L.length - 1;
        const spanN = Math.round((msg.span || 0) * sr);
        while (last > spanN && Math.abs(L[last]) < 1e-4 && Math.abs(R[last]) < 1e-4) last--;
        L = L.subarray(0, last + 1); R = R.subarray(0, last + 1);
        let before = null, gainDb = 0;
        if (msg.target != null) { before = DSP.loudness([L, R], sr); if (isFinite(before)) gainDb = Math.max(-20, Math.min(24, msg.target - before)); }
        prog(0.3);
        DSP.limit([L, R], sr, msg.ceil != null ? msg.ceil : -1, gainDb);
        prog(0.6);
        const blob = DSP.encodeWav([L, R], sr, msg.bits || 24);
        reply({ ok: true, blob, before, samples: L.length, sr });
        break;
      }
      case 'dropAll': {
        store.clear();
        reply({ ok: true });
        break;
      }
      case 'finalize': {
        // loudness-normalise + limit an exported mix
        const chs = msg.chs;
        let gainDb = 0, before = null;
        if (msg.target != null) { before = DSP.loudness(chs, msg.sr); gainDb = Math.max(-20, Math.min(24, msg.target - before)); }
        DSP.limit(chs, msg.sr, msg.ceil != null ? msg.ceil : -1, gainDb);
        reply({ ok: true, chs, before, gainDb }, chs.map((c) => c.buffer));
        break;
      }
      default:
        reply({ ok: false, error: 'unknown message' });
    }
  } catch (err) {
    reply({ ok: false, error: String(err && err.message || err) });
  }
};
