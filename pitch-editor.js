// UtaMix pitch editor — Melodyne-style: pitch / timing / volume / formant / cut tools on note blobs.
const DSP = window.DSP;
const KW = 42;  // keyboard width
const RH = 22;  // ruler height
const BLACK = new Set([1, 3, 6, 8, 10]);
const TOOL_HINT = {
  pitch: '音のかたまりを上下にドラッグで音程を変更。ダブルタップで分割。',
  time: 'ノートを左右にドラッグで位置を移動。両端をつかむと長さを変更。ダブルタップで元に戻す。',
  amp: 'ノートを上下にドラッグで音量を変更。ダブルタップでミュート（消音）。',
  formant: 'ノートを上下にドラッグで声質（フォルマント）を変更。上げると細く若く、下げると太く大人っぽく。',
  cut: '消したい範囲を左右になぞって選択 →「カット」。息・ノイズ・不要な声を無音にできます。',
};

const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};

export class PitchEditor {
  constructor(api) {
    this.api = api;
    this.root = api.root;
    this.canvas = this.root.querySelector('#peCanvas');
    this.panel = this.root.querySelector('#pePanel');
    this.isOpen = false;
    this.snap = true;
    this.withBacking = true;
    this.tool = 'pitch';
    this.sel = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.pos = 0;
    this.macro = { center: 0.8, drift: 0.3 };
    this.refId = null;
    this.pendingCut = null;
    this.selCut = -1;
    this.bind();
    new ResizeObserver(() => { if (this.isOpen) { this.resize(); this.draw(); } }).observe(this.canvas);
    api.onRenderState((tr, st) => {
      if (!this.isOpen || tr !== this.tr) return;
      this.root.querySelector('#peStatus').textContent = st === 'busy' ? '処理中…' : st === 'error' ? 'エラー' : '';
    });
  }

  // ---------- open / layout ----------
  open(tr) {
    this.tr = tr;
    this.an = this.api.analysisOf(tr);
    if (!tr.pitch.notes) tr.pitch.notes = DSP.segmentNotes(this.an).map((n) => ({ s: n.s, e: n.e, c: n.c, rms: n.rms, t: n.c, flat: 0, vib: 1, gain: 0, form: 0, mute: false, ts: 0, te: 0 }));
    if (!tr.cuts) tr.cuts = [];
    this.sel = new Set();
    this.undoStack = []; this.redoStack = [];
    this.pendingCut = null; this.selCut = -1;
    if (this.refId === tr.id) this.refId = null;
    this.isOpen = true;
    this.root.querySelector('#peName').textContent = tr.name;
    this.root.querySelector('#peStatus').textContent = '';
    this.midi = new Float32Array(this.an.f0.length);
    let maxR = 1e-6;
    for (let i = 0; i < this.an.f0.length; i++) {
      this.midi[i] = this.an.f0[i] ? DSP.hzToMidi(this.an.f0[i]) : 0;
      if (this.an.rms[i] > maxR) maxR = this.an.rms[i];
    }
    this.maxRms = maxR;
    this.resize();
    this.fitView();
    this.recalc();
    this.renderPanel();
    this.syncHeader();
    this.draw();
  }

  resize() {
    const r = Math.min(3, window.devicePixelRatio || 1);
    this.W = this.canvas.clientWidth; this.H = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.W * r); this.canvas.height = Math.round(this.H * r);
    this.dpr = r;
  }

  fitView() {
    const notes = this.tr.pitch.notes || [];
    const hop = this.an.hop;
    this.pps = 110;
    this.pxSemi = 18;
    if (notes.length) {
      const ms = notes.map((n) => this.noteT(n)).sort((a, b) => a - b);
      this.top = ms[ms.length >> 1] + (this.H - RH) / this.pxSemi / 2;
      const startT = this.T(notes[0].s * hop);
      const p = this.pos > startT ? this.pos : startT;
      this.t0 = Math.max(0, p - 0.4);
    } else {
      this.top = 72; this.t0 = this.T(0);
    }
  }

  syncHeader() {
    const tr = this.tr;
    this.root.querySelectorAll('#peTool button').forEach((b) => b.classList.toggle('on', b.dataset.tool === this.tool));
    const set = (id, on, label) => { const b = this.root.querySelector(id); b.setAttribute('aria-pressed', on ? 'true' : 'false'); if (label) b.textContent = label; };
    set('#peTune', tr.pitch.tuneOn, tr.pitch.tuneOn ? 'オートチューン ON' : 'オートチューン');
    set('#peSnap', this.snap);
    if (this.api.follow) set('#peFollow', this.api.follow(), this.api.follow() ? '追尾' : '追尾オフ');
    { const orig = this.api.origListen ? this.api.origListen(tr) : false; set('#peAB', !orig, orig ? '元の声' : '補正後'); }
    set('#peWithBacking', this.withBacking);
    const ref = this.refTrack();
    set('#peRef', !!ref, '参照：' + (ref ? ref.name : 'なし'));
    this.root.querySelector('#peKey').textContent = 'キー ' + this.api.keyLabel(this.api.getProject().key);
    this.root.querySelector('#peSnap').style.display = this.tool === 'pitch' ? '' : 'none';
  }

  updatePlayButton(playing) {
    const b = this.root.querySelector('#pePlay');
    b.textContent = playing ? '❚❚' : '▶';
    b.classList.toggle('on', playing);
  }

  refTrack() {
    const p = this.api.getProject();
    return this.refId && p ? p.tracks.find((t) => t.id === this.refId) || null : null;
  }

  // ---------- coordinates ----------
  x(t) { return KW + (t - this.t0) * this.pps; }
  tAt(x) { return this.t0 + (x - KW) / this.pps; }
  y(m) { return RH + (this.top - m) * this.pxSemi; }
  mAt(y) { return this.top - (y - RH) / this.pxSemi; }
  noteT(n) { return n.t != null ? n.t : n.c; }
  get notes() { return this.tr.pitch.notes || []; }
  get hop() { return this.an.hop; }
  get off() { return this.tr.offset || 0; }
  // audio time <-> timeline time (tracks can be split into clips)
  T(t) { return this.api.tl ? this.api.tl(this.tr, t) : (this.tr.offset || 0) + t; }
  A(T) { return this.api.au ? this.api.au(this.tr, T) : T - (this.tr.offset || 0); }
  noteOutStart(n) { return n.s * this.hop + (n.ts || 0); }
  noteOutEnd(n) { return n.e * this.hop + (n.te || 0); }

  recalc() {
    const tr = this.tr;
    const c = DSP.noteCurves(this.an, this.notes, { transitionMs: tr.pitch.transitionMs, cuts: tr.cuts, tune: tr.pitch.tuneOn ? tr.pitch.tune : null, key: this.api.getProject().key });
    this.shift = c.shift;
    this.map = c.map || null;
  }
  // input (track-local seconds) -> output (track-local seconds)
  inToOut(t) {
    const m = this.map;
    if (!m) return t;
    const a = m.inT, b = m.outT;
    if (t <= a[0]) return b[0] + (t - a[0]);
    for (let i = 0; i < a.length - 1; i++) if (t <= a[i + 1]) return b[i] + (t - a[i]) * (b[i + 1] - b[i]) / (a[i + 1] - a[i]);
    return b[b.length - 1] + (t - a[a.length - 1]);
  }
  outToIn(t) {
    const m = this.map;
    if (!m) return t;
    const a = m.inT, b = m.outT;
    if (t <= b[0]) return a[0] + (t - b[0]);
    for (let i = 0; i < b.length - 1; i++) if (t <= b[i + 1]) return a[i] + (t - b[i]) * (a[i + 1] - a[i]) / Math.max(1e-9, b[i + 1] - b[i]);
    return a[a.length - 1] + (t - b[b.length - 1]);
  }

  // ---------- drawing ----------
  draw() {
    if (!this.isOpen) return;
    const g = this.canvas.getContext('2d');
    const { W, H } = this;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const key = this.api.getProject().key;
    const scale = DSP.scaleSet(key.mode === 'chromatic' ? { tonic: 0, mode: 'chromatic' } : key);
    const mTop = Math.ceil(this.top) + 1, mBot = Math.floor(this.mAt(H)) - 1;
    for (let m = mBot; m <= mTop; m++) {
      const y0 = this.y(m + 0.5), y1 = this.y(m - 0.5);
      const pc = ((m % 12) + 12) % 12;
      g.fillStyle = scale.has(pc) ? '#12161d' : '#0c0e12';
      g.fillRect(KW, y0, W - KW, y1 - y0);
      g.fillStyle = pc === 0 ? '#262c37' : '#161a21';
      g.fillRect(KW, Math.round(y1) - 0.5, W - KW, 1);
    }
    const step = [0.25, 0.5, 1, 2, 5, 10].find((s) => s * this.pps >= 60) || 10;
    for (let t = Math.floor(this.t0 / step) * step; this.x(t) < W; t += step) {
      if (t < 0) continue;
      g.fillStyle = '#171b22';
      g.fillRect(Math.round(this.x(t)), RH, 1, H - RH);
    }
    const tr = this.tr, an = this.an, hop = an.hop;
    const isNote = true;
    // cuts
    tr.cuts.forEach(([a, b], i) => {
      const x0 = this.x(this.T(this.inToOut(a))), x1 = this.x(this.T(this.inToOut(b)));
      if (x1 < KW || x0 > W) return;
      g.fillStyle = i === this.selCut ? 'rgba(255,93,108,0.28)' : 'rgba(255,93,108,0.14)';
      g.fillRect(x0, RH, x1 - x0, H - RH);
      g.strokeStyle = 'rgba(255,93,108,0.35)'; g.lineWidth = 1;
      g.save(); g.beginPath(); g.rect(x0, RH, x1 - x0, H - RH); g.clip();
      for (let xx = x0 - H; xx < x1; xx += 10) { g.beginPath(); g.moveTo(xx, H); g.lineTo(xx + H, RH); g.stroke(); }
      g.restore();
      g.fillStyle = '#ff8d96'; g.font = 'bold 10px -apple-system, sans-serif';
      g.fillText('カット', Math.max(KW + 2, x0 + 3), RH + 12);
    });
    if (this.pendingCut) {
      const [a, b] = this.pendingCut;
      g.fillStyle = 'rgba(244,201,93,0.18)';
      g.fillRect(this.x(Math.min(a, b)), RH, Math.abs(b - a) * this.pps, H - RH);
    }
    // reference track
    const ref = this.refTrack();
    if (ref && ref.pitch.notes) {
      const ran = this.api.analysisOf(ref);
      if (ran) {
        g.strokeStyle = hexA(ref.color, 0.7); g.lineWidth = 1.5; g.setLineDash([4, 3]);
        for (const n of ref.pitch.notes) {
          const x0 = this.x(this.api.tl ? this.api.tl(ref, n.s * ran.hop + (n.ts || 0)) : ref.offset + n.s * ran.hop + (n.ts || 0)), x1 = this.x(this.api.tl ? this.api.tl(ref, n.e * ran.hop + (n.te || 0)) : ref.offset + n.e * ran.hop + (n.te || 0));
          if (x1 < KW || x0 > W) continue;
          const yc = this.y(this.noteT(n));
          g.strokeRect(x0, yc - this.pxSemi * 0.3, x1 - x0, this.pxSemi * 0.6);
        }
        g.setLineDash([]);
      }
    }
    // blobs
    const color = tr.color || '#5fd4c4';
    this.notes.forEach((n, i) => {
      const xs = this.x(this.T(this.noteOutStart(n))), xe = this.x(this.T(this.noteOutEnd(n)));
      if (xe < KW || xs > W) return;
      const tc = this.noteT(n);
      const yc = this.y(isNote ? tc : n.c);
      if (isNote && Math.abs(tc - n.c) > 0.04 && this.tool === 'pitch') {
        g.strokeStyle = 'rgba(255,255,255,0.18)'; g.setLineDash([3, 3]); g.lineWidth = 1;
        const xo0 = this.x(this.T(n.s * hop)), xo1 = this.x(this.T(n.e * hop));
        g.strokeRect(xo0, this.y(n.c) - this.pxSemi * 0.32, xo1 - xo0, this.pxSemi * 0.64);
        g.setLineDash([]);
      }
      const sel = this.sel.has(i);
      const gl = n.mute ? 0.25 : Math.min(2.5, Math.pow(10, (n.gain || 0) / 20));
      const maxH = this.pxSemi * 0.48;
      const len = n.e - n.s;
      const env = (k) => Math.max(2.5, Math.min(maxH * 1.4, Math.sqrt(an.rms[k] / this.maxRms * gl) * maxH * 1.1));
      const fx = (k) => xs + (k + 0.5 - n.s) / len * (xe - xs);
      g.beginPath();
      g.moveTo(xs, yc);
      for (let k = n.s; k < n.e; k++) g.lineTo(fx(k), yc - env(k));
      g.lineTo(xe, yc);
      for (let k = n.e - 1; k >= n.s; k--) g.lineTo(fx(k), yc + env(k));
      g.closePath();
      if (n.mute) {
        g.setLineDash([3, 3]); g.strokeStyle = sel ? '#f4c95d' : 'rgba(255,255,255,0.4)'; g.lineWidth = 1; g.stroke(); g.setLineDash([]);
      } else {
        g.fillStyle = sel ? 'rgba(244,201,93,0.9)' : hexA(color, isNote ? 0.55 : 0.3);
        g.fill();
        if (sel) { g.strokeStyle = '#fff3c9'; g.lineWidth = 1; g.stroke(); }
      }
      if (sel && this.tool === 'time') {
        g.fillStyle = '#f4c95d';
        g.fillRect(xs - 2, yc - this.pxSemi * 0.8, 4, this.pxSemi * 1.6);
        g.fillRect(xe - 2, yc - this.pxSemi * 0.8, 4, this.pxSemi * 1.6);
      }
      // badges
      const badges = [];
      if (n.mute) badges.push('ミュート');
      else if (n.gain && (this.tool === 'amp' || sel)) badges.push((n.gain > 0 ? '+' : '') + n.gain.toFixed(1) + 'dB');
      if (n.form && (this.tool === 'formant' || sel)) badges.push('声質' + (n.form > 0 ? '+' : '') + n.form.toFixed(1));
      if (badges.length && xe - xs > 24) {
        g.font = '10px -apple-system, sans-serif'; g.fillStyle = '#cfd3da';
        g.fillText(badges.join(' '), xs + 2, yc + this.pxSemi * 0.5 + 10);
      }
    });
    // pitch curves
    const k0 = Math.max(0, Math.floor(this.outToIn(this.A(this.t0)) / hop) - 2);
    const k1 = Math.min(an.f0.length, Math.ceil(this.outToIn(this.A(this.tAt(W))) / hop) + 2);
    const curve = (useShift, style, width) => {
      g.strokeStyle = style; g.lineWidth = width; g.beginPath();
      let pen = false;
      for (let k = k0; k < k1; k++) {
        if (!this.midi[k]) { pen = false; continue; }
        const m = this.midi[k] + (useShift && tr.pitch.enabled ? this.shift[k] : 0);
        const tt = useShift && tr.pitch.enabled ? this.inToOut((k + 0.5) * hop) : (k + 0.5) * hop;
        const px = this.x(this.T(tt)), py = this.y(m);
        if (pen) g.lineTo(px, py); else { g.moveTo(px, py); pen = true; }
      }
      g.stroke();
    };
    curve(false, 'rgba(255,255,255,0.16)', 1);
    curve(true, 'rgba(255,255,255,0.92)', 1.6);
    if (this.sel.size === 1) {
      const n = this.notes[[...this.sel][0]];
      if (n) {
        const tc = this.noteT(n);
        const lx = Math.max(KW + 4, this.x(this.T(this.noteOutStart(n)))), ly = this.y(isNote ? tc : n.c) - this.pxSemi * 0.6 - 4;
        const label = this.noteName(tc);
        g.font = 'bold 12px -apple-system, sans-serif';
        const w = g.measureText(label).width + 10;
        g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(lx, ly - 14, w, 18);
        g.fillStyle = '#f4c95d'; g.fillText(label, lx + 5, ly);
      }
    }
    // ruler
    g.fillStyle = '#101318'; g.fillRect(KW, 0, W - KW, RH);
    g.font = '10px -apple-system, sans-serif'; g.fillStyle = '#7d8595'; g.textBaseline = 'middle';
    for (let t = Math.floor(this.t0 / step) * step; this.x(t) < W; t += step) {
      if (t < 0) continue;
      const xx = Math.round(this.x(t));
      g.fillRect(xx, RH - 6, 1, 6);
      const m = Math.floor(t / 60), s = t - m * 60;
      g.fillText(`${m}:${s < 10 ? '0' : ''}${s % 1 ? s.toFixed(2).replace(/0$/, '') : s}`, xx + 3, 9);
    }
    g.textBaseline = 'alphabetic';
    // keyboard
    for (let m = mBot; m <= mTop; m++) {
      const y0 = this.y(m + 0.5), y1 = this.y(m - 0.5);
      const pc = ((m % 12) + 12) % 12;
      g.fillStyle = BLACK.has(pc) ? '#1a1d24' : '#cfd3da';
      g.fillRect(0, y0, KW, y1 - y0);
      g.fillStyle = '#0b0d11'; g.fillRect(0, Math.round(y1) - 0.5, KW, 1);
      if (scale.has(pc) && key.mode !== 'chromatic') { g.fillStyle = '#5fd4c4'; g.fillRect(KW - 4, y0 + 1, 3, y1 - y0 - 2); }
      if (pc === 0 || (this.pxSemi >= 16 && !BLACK.has(pc)) || this.pxSemi >= 22) {
        g.fillStyle = BLACK.has(pc) ? '#8d95a5' : '#2a2f3a';
        g.font = (pc === 0 ? 'bold ' : '') + '10px -apple-system, sans-serif';
        g.fillText(this.api.noteNames[pc] + (pc === 0 ? (Math.floor(m / 12) - 1) : ''), 4, (y0 + y1) / 2 + 4);
      }
    }
    g.fillStyle = '#101318'; g.fillRect(0, 0, KW, RH);
    const px = this.x(this.pos);
    if (px >= KW && px <= W) { g.fillStyle = '#f4c95d'; g.fillRect(Math.round(px), 0, 1.5, H); }
  }

  noteName(m) {
    const r = Math.round(m);
    const cents = Math.round((m - r) * 100);
    const nm = this.api.noteNames[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1);
    return cents === 0 ? nm : `${nm} ${cents > 0 ? '+' : ''}${cents}¢`;
  }

  tick(pos) {
    if (!this.isOpen) return;
    const moved = Math.abs(pos - this.pos) > 1e-4;
    this.pos = pos;
    if (this.api.isPlaying() && (!this.api.follow || this.api.follow())) {
      const px = this.x(pos);
      if (px > this.W * 0.82 || px < KW) this.t0 = pos - (this.W - KW) * 0.12 / this.pps;
    }
    if (moved) this.draw();
  }

  // ---------- editing ----------
  snapshot() { return JSON.stringify({ notes: this.tr.pitch.notes, cuts: this.tr.cuts }); }
  pushUndo() { this.undoStack.push(this.snapshot()); this.redoStack = []; }
  restore(s) { const o = JSON.parse(s); this.tr.pitch.notes = o.notes; this.tr.cuts = o.cuts; this.sel = new Set(); this.selCut = -1; this.committed(); }
  undo() { if (!this.undoStack.length) return; this.redoStack.push(this.snapshot()); this.restore(this.undoStack.pop()); }
  redo() { if (!this.redoStack.length) return; this.undoStack.push(this.snapshot()); this.restore(this.redoStack.pop()); }

  committed() {
    this.recalc();
    this.api.saveProject();
    this.api.schedulePitchRender(this.tr);
    this.renderPanel();
    this.draw();
  }

  hitNote(x, y) {
    const t = this.A(this.tAt(x));
    const isNote = true;
    let best = -1, bd = 1e9;
    this.notes.forEach((n, i) => {
      const a = this.noteOutStart(n), b = this.noteOutEnd(n);
      const pad = 8 / this.pps;
      if (t < a - pad || t > b + pad) return;
      const yc = this.y(isNote ? this.noteT(n) : n.c);
      const d = Math.abs(y - yc);
      if (d < Math.max(this.pxSemi * 0.9, 16) && d < bd) { bd = d; best = i; }
    });
    return best;
  }

  splitAt(i, tAbs) {
    const notes = this.notes;
    const n = notes[i];
    const tin = this.outToIn(this.A(tAbs));
    const k = Math.round(tin / this.hop);
    if (k - n.s < 3 || n.e - k < 3) { this.api.toast('短すぎて分割できません'); return; }
    this.pushUndo();
    const a = DSP.makeNote(this.midi, this.an.rms, n.s, k), b = DSP.makeNote(this.midi, this.an.rms, k, n.e);
    const d = this.noteT(n) - n.c;
    const base = { flat: n.flat || 0, vib: n.vib != null ? n.vib : 1, gain: n.gain || 0, form: n.form || 0, mute: !!n.mute };
    const na = Object.assign({ s: a.s, e: a.e, c: a.c, rms: a.rms, t: a.c + d, ts: n.ts || 0, te: 0 }, base);
    const nb = Object.assign({ s: b.s, e: b.e, c: b.c, rms: b.rms, t: b.c + d, ts: 0, te: n.te || 0 }, base);
    if (n.ts || n.te) { na.te = n.ts || 0; nb.ts = n.te || 0; }
    if (this.snap && Math.abs(d) > 0.01) { na.t = Math.round(na.t); nb.t = Math.round(nb.t); }
    notes.splice(i, 1, na, nb);
    this.sel = new Set([i + 1]);
    this.committed();
  }

  mergeNext() {
    const notes = this.notes;
    const idx = [...this.sel].sort((a, b) => a - b);
    if (!idx.length) return;
    const i = idx[0];
    const j = idx.length > 1 ? idx[idx.length - 1] : i + 1;
    if (j >= notes.length) { this.api.toast('結合できる次のノートがありません'); return; }
    this.pushUndo();
    const a = notes[i], b = notes[j];
    const m = DSP.makeNote(this.midi, this.an.rms, a.s, b.e);
    const d = this.noteT(a) - a.c;
    notes.splice(i, j - i + 1, { s: m.s, e: m.e, c: m.c, rms: m.rms, t: this.snap && Math.abs(d) > 0.01 ? Math.round(m.c + d) : m.c + d,
      flat: a.flat || 0, vib: a.vib != null ? a.vib : 1, gain: a.gain || 0, form: a.form || 0, mute: !!a.mute, ts: a.ts || 0, te: b.te || 0 });
    this.sel = new Set([i]);
    this.committed();
  }

  setSel(fn, undo = true) {
    if (!this.sel.size) return;
    if (undo) this.pushUndo();
    for (const i of this.sel) fn(this.notes[i]);
    this.committed();
  }

  // time-tool limits for note i
  timeLimits(i) {
    const notes = this.notes, n = notes[i], hop = this.hop;
    const prev = notes[i - 1], next = notes[i + 1];
    const lo = prev ? ((prev.ts || prev.te) ? this.noteOutEnd(prev) + 0.005 : (prev.s + prev.e) / 2 * hop + 0.02) : 0;
    const hi = next ? ((next.ts || next.te) ? this.noteOutStart(next) - 0.005 : (next.s + next.e) / 2 * hop - 0.02) : 1e9;
    return { lo, hi, s0: n.s * hop, e0: n.e * hop };
  }

  // ---------- gestures ----------
  bind() {
    const cv = this.canvas;
    const pts = new Map();
    let mode = null, sx = 0, sy = 0, st0 = 0, stop = 0, moved = false, drag = null, lastTap = { t: 0, i: -1 };
    let pinch = null;
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        if (mode === 'drag' && moved && drag) { const s = drag.snap; this.undoStack.pop(); this.restore(s); }
        this.pendingCut = mode === 'cutsel' ? null : this.pendingCut;
        mode = 'pinch';
        pinch = { dx: Math.max(30, Math.abs(a.x - b.x)), dy: Math.max(30, Math.abs(a.y - b.y)), pps: this.pps, ps: this.pxSemi,
          tm: this.tAt((a.x + b.x) / 2), mm: this.mAt((a.y + b.y) / 2) };
        return;
      }
      if (pts.size > 2) return;
      sx = e.offsetX; sy = e.offsetY; st0 = this.t0; stop = this.top; moved = false;
      if (e.offsetX > KW && e.offsetY > RH) {
        if (this.tool === 'cut') {
          const tin = this.outToIn(this.A(this.tAt(e.offsetX)));
          const ci = this.tr.cuts.findIndex(([a, b]) => tin >= a && tin <= b);
          mode = 'cutsel'; drag = { ci, t0: this.tAt(e.offsetX) };
          return;
        }
        if (true) {
          const i = this.hitNote(e.offsetX, e.offsetY);
          if (i >= 0) {
            const now = performance.now();
            if (now - lastTap.t < 320 && lastTap.i === i) {
              mode = 'none'; lastTap = { t: 0, i: -1 };
              this.sel = new Set([i]);
              if (this.tool === 'pitch') this.splitAt(i, this.tAt(e.offsetX));
              else if (this.tool === 'amp') this.setSel((n) => { n.mute = !n.mute; });
              else if (this.tool === 'time') this.setSel((n) => { n.ts = 0; n.te = 0; });
              else if (this.tool === 'formant') this.setSel((n) => { n.form = 0; });
              return;
            }
            lastTap = { t: now, i };
            if (!this.sel.has(i)) this.sel = new Set([i]);
            mode = 'drag';
            const n = this.notes[i];
            let zone = 'move';
            if (this.tool === 'time') {
              const xs = this.x(this.T(this.noteOutStart(n))), xe = this.x(this.T(this.noteOutEnd(n)));
              const w = Math.max(1, xe - xs), r = (e.offsetX - xs) / w;
              if (r < 0.25 && w > 30) zone = 'start'; else if (r > 0.75 && w > 30) zone = 'end';
            }
            drag = { i, zone, snap: this.snapshot(), orig: new Map([...this.sel].map((k) => { const q = this.notes[k]; return [k, { t: this.noteT(q), gain: q.gain || 0, form: q.form || 0, ts: q.ts || 0, te: q.te || 0 }]; })) };
            this.renderPanel();
            this.draw();
            return;
          }
        }
      }
      mode = 'pan';
    });
    cv.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
      if (mode === 'pinch' && pts.size >= 2) {
        const [a, b] = [...pts.values()];
        const dx = Math.max(30, Math.abs(a.x - b.x)), dy = Math.max(30, Math.abs(a.y - b.y));
        this.pps = Math.max(15, Math.min(1200, pinch.pps * dx / pinch.dx));
        this.pxSemi = Math.max(7, Math.min(48, pinch.ps * dy / pinch.dy));
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        this.t0 = pinch.tm - (cx - KW) / this.pps;
        this.top = pinch.mm + (cy - RH) / this.pxSemi;
        this.draw();
        return;
      }
      const dx = e.offsetX - sx, dy = e.offsetY - sy;
      if (!moved && Math.hypot(dx, dy) < 6) return;
      if (!moved && mode === 'drag') this.pushUndo();
      moved = true;
      if (mode === 'drag') {
        if (this.tool === 'pitch') {
          const d = -dy / this.pxSemi;
          for (const [k, o] of drag.orig) this.notes[k].t = this.snap ? Math.round(o.t + d) : o.t + d;
        } else if (this.tool === 'amp') {
          const d = -dy / 4;
          for (const [k, o] of drag.orig) this.notes[k].gain = Math.max(-30, Math.min(12, Math.round((o.gain + d) * 2) / 2));
        } else if (this.tool === 'formant') {
          const d = -dy / 14;
          for (const [k, o] of drag.orig) this.notes[k].form = Math.max(-6, Math.min(6, Math.round((o.form + d) * 10) / 10));
        } else if (this.tool === 'time') {
          const i = drag.i, n = this.notes[i], o = drag.orig.get(i), L = this.timeLimits(i);
          let d = dx / this.pps;
          if (drag.zone === 'move') {
            d = Math.max(L.lo - (L.s0 + o.ts), Math.min(L.hi - (L.e0 + o.te), d));
            d = Math.max(-L.s0 - o.ts, d);
            n.ts = o.ts + d; n.te = o.te + d;
          } else if (drag.zone === 'start') {
            const ns = Math.max(L.lo, Math.min(L.e0 + o.te - 0.03, L.s0 + o.ts + d));
            n.ts = ns - L.s0;
          } else {
            const ne = Math.min(L.hi, Math.max(L.s0 + o.ts + 0.03, L.e0 + o.te + d));
            n.te = ne - L.e0;
          }
        }
        this.recalc();
        this.draw();
        this.updateInfo();
      } else if (mode === 'cutsel') {
        this.pendingCut = [drag.t0, this.tAt(e.offsetX)];
        this.selCut = -1;
        this.draw();
      } else if (mode === 'pan') {
        this.t0 = Math.max(-1, st0 - dx / this.pps);
        this.top = Math.max(20, Math.min(110, stop + dy / this.pxSemi));
        this.draw();
      }
    });
    const end = (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.delete(e.pointerId);
      if (pts.size > 0) { if (mode === 'pinch') mode = 'none'; return; }
      if (mode === 'drag' && moved) this.committed();
      else if (mode === 'cutsel') {
        if (!moved) {
          this.pendingCut = null;
          this.selCut = drag.ci;
          if (drag.ci < 0) { this.api.seek(Math.max(0, this.tAt(e.offsetX))); this.pos = Math.max(0, this.tAt(e.offsetX)); }
          this.renderPanel(); this.draw();
        } else {
          const [a, b] = this.pendingCut;
          if (Math.abs(b - a) < 0.02) this.pendingCut = null;
          this.renderPanel(); this.draw();
        }
      } else if (mode === 'pan' && !moved && e.type === 'pointerup') {
        this.api.seek(Math.max(0, this.tAt(e.offsetX)));
        this.sel = new Set();
        this.pos = Math.max(0, this.tAt(e.offsetX));
        this.renderPanel();
        this.draw();
      }
      mode = null; drag = null;
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);

    const q = (s) => this.root.querySelector(s);
    q('#peBack').onclick = () => { this.isOpen = false; this.api.close(); };
    q('#peTitle').onclick = () => this.api.pickTrack('編集するトラック', this.tr.id, false, (t) => { if (t && t !== this.tr) this.api.openTrack(t); });
    q('#peRef').onclick = () => this.api.pickTrack('参照として重ねて表示', this.refId, true, async (t) => {
      if (t) await this.api.ensureNotes(t);
      this.refId = t ? t.id : null;
      this.syncHeader(); this.draw();
    }, this.tr.id);
    q('#peUndo').onclick = () => this.undo();
    q('#peRedo').onclick = () => this.redo();
    q('#peSnap').onclick = () => { this.snap = !this.snap; this.syncHeader(); };
    q('#peFollow').onclick = () => { if (this.api.setFollow) this.api.setFollow(!this.api.follow()); this.syncHeader(); };
    // 聴き比べ: switch instantly between the corrected voice and the original recording
    q('#peAB').onclick = () => {
      if (this.api.setOrigListen) this.api.setOrigListen(this.tr, !this.api.origListen(this.tr));
      this.syncHeader(); this.draw();
    };
    q('#peWithBacking').onclick = () => { this.withBacking = !this.withBacking; this.syncHeader(); if (this.api.isPlaying()) { this.api.stop(); this.api.play(this.tr, this.withBacking, this.pos); } };
    q('#pePlay').onclick = () => this.api.play(this.tr, this.withBacking, this.pos);
    q('#peTune').onclick = async () => {
      this.pushUndo();
      this.tr.pitch.tuneOn = !this.tr.pitch.tuneOn;
      this.tr.pitch.enabled = true;
      if (this.tr.pitch.tuneOn) await this.api.ensureKey();
      this.syncHeader();
      this.committed();
    };
    q('#peKey').onclick = () => this.api.keySheet(() => { this.syncHeader(); this.recalc(); this.renderPanel(); this.draw(); });
    q('#peTool').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.disabled) return;
      this.tool = b.dataset.tool;
      this.pendingCut = null; this.selCut = -1;
      this.syncHeader(); this.renderPanel(); this.draw();
    });
  }

  // ---------- panel ----------
  updateInfo() {
    const el = this.panel.querySelector('.nn');
    if (!el || this.sel.size !== 1) return;
    const n = this.notes[[...this.sel][0]];
    el.firstChild.textContent = this.infoText(n);
  }
  infoText(n) {
    if (this.tool === 'amp') return n.mute ? 'ミュート' : ((n.gain > 0 ? '+' : '') + (n.gain || 0).toFixed(1) + ' dB');
    if (this.tool === 'formant') return '声質 ' + ((n.form > 0 ? '+' : '') + (n.form || 0).toFixed(1));
    if (this.tool === 'time') { const d = ((n.ts || 0) + (n.te || 0)) / 2 * 1000; return (d >= 0 ? '+' : '') + Math.round(d) + ' ms'; }
    return this.noteName(this.noteT(n));
  }

  renderPanel() {
    const p = this.panel;
    p.innerHTML = '';
    const tr = this.tr;
    const pct = (v) => Math.round(v * 100) + '%';
    const slider = (label, min, max, step, value, fmt, oninput, onchange) => {
      const val = h('span', { class: 'val' }, fmt(value));
      const inp = h('input', { type: 'range', min, max, step, value });
      inp.addEventListener('input', () => { const v = parseFloat(inp.value); val.textContent = fmt(v); oninput(v); });
      if (onchange) inp.addEventListener('change', () => onchange(parseFloat(inp.value)));
      return h('div', { class: 'row', style: 'margin:4px 0' }, h('label', {}, label), inp, val);
    };
    // cut tool panel (works in both modes)
    if (this.tool === 'cut') {
      p.append(h('p', { class: 'note', style: 'margin:0 0 6px' }, TOOL_HINT.cut));
      if (this.pendingCut) {
        const [a, b] = this.pendingCut;
        p.append(h('div', { class: 'mini-btns' },
          h('button', { style: 'background:#5a2a31;color:#ffd0d5', onclick: () => {
            const ia = this.outToIn(this.A(Math.min(a, b))), ib = this.outToIn(this.A(Math.max(a, b)));
            this.pushUndo();
            this.tr.cuts.push([Math.max(0, ia), Math.max(0, ib)]);
            this.tr.cuts = mergeRanges(this.tr.cuts);
            this.pendingCut = null;
            this.committed();
            this.api.toast('カットしました');
          } }, `この範囲をカット（${Math.abs(b - a).toFixed(2)}秒）`),
          h('button', { onclick: () => { this.pendingCut = null; this.renderPanel(); this.draw(); } }, 'キャンセル')));
      } else if (this.selCut >= 0) {
        p.append(h('div', { class: 'mini-btns' },
          h('button', { onclick: () => { this.pushUndo(); this.tr.cuts.splice(this.selCut, 1); this.selCut = -1; this.committed(); } }, 'このカットを解除'),
          h('button', { onclick: () => { this.selCut = -1; this.renderPanel(); this.draw(); } }, '閉じる')));
      }
      p.append(h('div', { class: 'note', style: 'margin-top:8px' }, `カット：${tr.cuts.length}箇所（カット部分をタップで選択）`));
      if (tr.cuts.length) p.append(h('div', { class: 'mini-btns', style: 'margin-top:6px' }, h('button', { onclick: () => { this.pushUndo(); this.tr.cuts = []; this.selCut = -1; this.committed(); } }, 'カットをすべて解除')));
      return;
    }
    if (tr.pitch.tuneOn) {
      const t = tr.pitch.tune;
      const box = h('div', { class: 'chips' });
      [['ケロケロ', 0, 1], ['はっきり', 12, 1], ['ほどよく', 40, 0.9], ['自然', 90, 0.8]].forEach(([nm, sp, stg]) => {
        box.append(h('button', { class: t.speedMs === sp && t.strength === stg ? 'on' : '', onclick: () => { this.pushUndo(); t.speedMs = sp; t.strength = stg; this.committed(); } }, nm));
      });
      p.append(h('details', { class: 'section', style: 'margin:0 0 8px', open: this.tuneOpen || null },
        h('summary', {}, `オートチューン（キー ${this.api.keyLabel(this.api.getProject().key)}）`), box,
        slider('スピード', 0, 200, 1, t.speedMs, (v) => v === 0 ? '最速' : v + ' ms', (v) => { t.speedMs = v; this.recalc(); this.draw(); }, () => this.committed()),
        slider('強さ', 0, 1, 0.05, t.strength, pct, (v) => { t.strength = v; this.recalc(); this.draw(); }, () => this.committed())));
      p.lastChild.addEventListener('toggle', (e) => { this.tuneOpen = e.target.open; });
    }
    const notes = this.notes;
    const selIdx = [...this.sel];
    if (selIdx.length) {
      const n = notes[selIdx[0]];
      p.append(h('div', { class: 'pe-note-info' },
        h('div', { class: 'nn' }, selIdx.length === 1 ? this.infoText(n) : `${selIdx.length}個選択`,
          selIdx.length === 1 && this.tool === 'pitch' ? h('small', {}, '元 ' + this.noteName(n.c)) : null)));
      if (this.tool === 'pitch') {
        p.append(h('div', { class: 'mini-btns', style: 'margin:6px 0' },
          h('button', { onclick: () => this.setSel((q) => { q.t = this.noteT(q) + 1; }) }, '▲ 半音'),
          h('button', { onclick: () => this.setSel((q) => { q.t = this.noteT(q) - 1; }) }, '▼ 半音'),
          h('button', { onclick: () => this.setSel((q) => { q.t = this.noteT(q) + 0.1; }) }, '+10¢'),
          h('button', { onclick: () => this.setSel((q) => { q.t = this.noteT(q) - 0.1; }) }, '−10¢'),
          h('button', { disabled: selIdx.length !== 1, onclick: () => {
            const nn = notes[selIdx[0]];
            const a = this.T(this.noteOutStart(nn)), b = this.T(this.noteOutEnd(nn));
            this.splitAt(selIdx[0], this.pos > a && this.pos < b ? this.pos : (a + b) / 2);
          } }, '分割'),
          h('button', { onclick: () => this.mergeNext() }, '結合'),
          h('button', { onclick: () => this.setSel((q) => { q.t = q.c; q.flat = 0; q.vib = 1; }) }, '元に戻す')));
        p.append(
          slider('ゆらぎ補正', 0, 1, 0.05, n.flat || 0, pct, (v) => { for (const i of selIdx) notes[i].flat = v; this.recalc(); this.draw(); }, () => { this.pushUndo(); this.committed(); }),
          slider('ビブラート', 0, 2, 0.05, n.vib != null ? n.vib : 1, (v) => v === 0 ? 'なし' : pct(v), (v) => { for (const i of selIdx) notes[i].vib = v; this.recalc(); this.draw(); }, () => { this.pushUndo(); this.committed(); }));
      } else if (this.tool === 'amp') {
        p.append(slider('音量', -30, 12, 0.5, n.gain || 0, (v) => (v > 0 ? '+' : '') + v + ' dB', (v) => { for (const i of selIdx) notes[i].gain = v; this.draw(); }, () => { this.pushUndo(); this.committed(); }),
          h('div', { class: 'mini-btns', style: 'margin:6px 0' },
            h('button', { onclick: () => this.setSel((q) => { q.mute = !n.mute; }) }, n.mute ? 'ミュート解除' : 'ミュート（消音）'),
            h('button', { onclick: () => this.setSel((q) => { q.gain = 0; q.mute = false; }) }, '元に戻す')));
      } else if (this.tool === 'formant') {
        p.append(slider('声質', -6, 6, 0.1, n.form || 0, (v) => (v > 0 ? '+' : '') + v.toFixed(1), (v) => { for (const i of selIdx) notes[i].form = v; this.draw(); }, () => { this.pushUndo(); this.committed(); }),
          h('div', { class: 'mini-btns', style: 'margin:6px 0' }, h('button', { onclick: () => this.setSel((q) => { q.form = 0; }) }, '元に戻す')));
      } else if (this.tool === 'time') {
        const nudge = (d) => {
          if (selIdx.length !== 1) return;
          const i = selIdx[0], q = notes[i], L = this.timeLimits(i);
          const dd = Math.max(L.lo - (L.s0 + (q.ts || 0)), Math.min(L.hi - (L.e0 + (q.te || 0)), d));
          this.pushUndo(); q.ts = (q.ts || 0) + dd; q.te = (q.te || 0) + dd; this.committed();
        };
        p.append(h('div', { class: 'mini-btns', style: 'margin:6px 0' },
          h('button', { onclick: () => nudge(-0.01) }, '← 10ms'),
          h('button', { onclick: () => nudge(0.01) }, '10ms →'),
          h('button', { onclick: () => this.setSel((q) => { q.ts = 0; q.te = 0; }) }, 'タイミングを戻す')));
      }
    } else {
      p.append(h('p', { class: 'note', style: 'margin:0 0 6px' }, TOOL_HINT[this.tool] + ' 空いている所をタップで再生位置、2本指で拡大・縮小。'));
    }
    p.append(h('div', { class: 'mini-btns', style: 'margin-top:6px' },
      h('button', { onclick: () => { this.sel = new Set(notes.map((_, i) => i)); this.renderPanel(); this.draw(); } }, 'すべて選択'),
      selIdx.length ? h('button', { onclick: () => { this.sel = new Set(); this.renderPanel(); this.draw(); } }, '選択解除') : null,
      h('button', { onclick: () => { this.fitView(); this.draw(); } }, '表示リセット')));
    if (this.tool === 'pitch') {
      const det = h('details', { class: 'section', style: 'margin:8px 0 0' }, h('summary', {}, '詳細設定・自動補正'),
        slider('なめらかさ', 0, 150, 5, tr.pitch.transitionMs, (v) => v + ' ms', (v) => { tr.pitch.transitionMs = v; this.recalc(); this.draw(); }, () => this.committed()));
      if (!tr.harmonyOf) {
        det.append(h('div', { class: 'note', style: 'margin-top:6px;font-weight:700;color:#eceef2' }, `自動補正（キー ${this.api.keyLabel(this.api.getProject().key)}）`),
          slider('音程の補正', 0, 1, 0.05, this.macro.center, pct, (v) => { this.macro.center = v; }),
          slider('ゆらぎ補正', 0, 1, 0.05, this.macro.drift, pct, (v) => { this.macro.drift = v; }),
          h('div', { class: 'mini-btns', style: 'margin:4px 0 8px' },
            h('button', { onclick: async () => {
              this.pushUndo();
              await this.api.autoCorrect(tr, this.macro.center, this.macro.drift, this.sel.size ? new Set(this.sel) : null);
              this.macroOpen = true; this.recalc(); this.renderPanel(); this.draw();
              this.api.toast(this.sel.size ? '選択したノートを補正しました' : '全体を補正しました');
            } }, selIdx.length ? '選択したノートに適用' : '全体に適用')));
      }
      if (this.macroOpen) det.open = true;
      det.addEventListener('toggle', () => { this.macroOpen = det.open; });
      p.append(det);
    }
  }
}

function mergeRanges(r) {
  const s = r.map(([a, b]) => [Math.min(a, b), Math.max(a, b)]).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const x of s) {
    if (out.length && x[0] <= out[out.length - 1][1] + 0.01) out[out.length - 1][1] = Math.max(out[out.length - 1][1], x[1]);
    else out.push(x);
  }
  return out;
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
