// UtaMix — main application. All processing happens on this device.
import { Store, uid } from './storage.js';
import { Engine, PRESETS, PRESET_GROUPS, fxFromPreset, migrateFx, defaultBus, defaultGroups, REVERB_TYPES, DELAY_NOTES, COLOR_TYPES, renderMix, encodeWav, EQ_LABELS, DEFAULT_PRESET } from './audio-engine.js';
export const APP_VERSION = 'v7';
import { PitchEditor } from './pitch-editor.js';

const DSP = window.DSP;
const MAX_TRACKS = 8;
const LANE_H = 64;
const GROUP_H = 44;
const COLORS = ['#5fd4c4', '#ff9f6b', '#a993ff', '#f17cb6', '#7cc8f5', '#f4c95d', '#8fe39b', '#ff8d8d'];
const BACKING_COLOR = '#7f8ba3';
export const NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const KIND_LABEL = { backing: '伴奏', vocal: 'メイン', harmony: 'ハモリ' };
const KIND_BADGE = { backing: 'BGM', vocal: 'MAIN', harmony: 'HARM' };
const GROUPS = [
  { id: 'g:vocal', key: 'vocal', name: 'ボーカル類', color: '#5fd4c4', cat: 'gvocal' },
  { id: 'g:backing', key: 'backing', name: '音源', color: '#7f8ba3', cat: 'gbacking' },
  { id: 'g:master', key: 'master', name: 'マスター', color: '#f4c95d', cat: 'gmaster' },
];
const isVox = (tr) => tr.kind !== 'backing';
const isGroupId = (id) => typeof id === 'string' && id.startsWith('g:');

const $ = (id) => document.getElementById(id);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
};
const clone = (o) => JSON.parse(JSON.stringify(o));
// optional UI parts are passed as null/false; never render them as text
{ const ap = Element.prototype.append; Element.prototype.append = function (...a) { return ap.apply(this, a.filter((x) => x != null && x !== false)); }; }

// ---------------- state ----------------
const engine = new Engine();
let project = null;
const buffers = new Map();
const processed = new Map();
const analyses = new Map();
const peaksCache = new Map();
const chromaCache = new Map();
let selectedId = null;
let sheetTab = 'mix';
let trackClip = null;
const settings = loadLS('utamix.settings', { latencyMode: 'wired', latencyMs: 25, btMs: 180, monitor: false, recTarget: 'auto', preroll: 2 });

function loadLS(key, def) {
  try { return Object.assign({}, def, JSON.parse(localStorage.getItem(key) || 'null') || {}); } catch (e) { return def; }
}
function saveLS(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* ignore */ } }
function saveSettings() { saveLS('utamix.settings', settings); }
function getTemplates() { try { return JSON.parse(localStorage.getItem('utamix.templates') || '[]'); } catch (e) { return []; } }
function setTemplates(t) { saveLS('utamix.templates', t); }

// ---------------- worker RPC ----------------
const worker = new Worker('dsp-worker.js');
let reqSeq = 0;
const pending = new Map();
worker.onmessage = (e) => {
  const m = e.data;
  const p = pending.get(m.reqId);
  if (!p) return;
  if (!('ok' in m)) { if (p.onProgress) p.onProgress(m.progress); return; }
  pending.delete(m.reqId);
  if (m.ok) p.resolve(m); else p.reject(new Error(m.error));
};
function rpc(msg, onProgress, transfer) {
  return new Promise((resolve, reject) => {
    const id = ++reqSeq;
    pending.set(id, { resolve, reject, onProgress });
    worker.postMessage(Object.assign({}, msg, { reqId: id }), transfer || []);
  });
}
const workerAudio = new Set();
const workerAnalysis = new Set();

function monoOf(buf) {
  const n = buf.length, out = new Float32Array(n);
  const c = buf.numberOfChannels;
  for (let ch = 0; ch < c; ch++) { const d = buf.getChannelData(ch); for (let i = 0; i < n; i++) out[i] += d[i] / c; }
  return out;
}
async function ensureWorkerAudio(audioId) {
  if (workerAudio.has(audioId)) return;
  const buf = buffers.get(audioId);
  if (!buf) throw new Error('音源が見つかりません');
  const chs = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c).slice());
  await rpc({ type: 'load', id: audioId, sr: buf.sampleRate, chs }, null, chs.map((c) => c.buffer));
  workerAudio.add(audioId);
}
async function ensureAnalysis(audioId, onProgress) {
  await ensureWorkerAudio(audioId);
  if (analyses.has(audioId)) {
    if (!workerAnalysis.has(audioId)) {
      const an = analyses.get(audioId);
      await rpc({ type: 'setAnalysis', id: audioId, an: { hop: an.hop, f0: an.f0, rms: an.rms } });
      workerAnalysis.add(audioId);
    }
    return analyses.get(audioId);
  }
  const saved = await Store.getAnalysis(audioId).catch(() => null);
  if (saved) {
    const an = { hop: saved.hop, f0: saved.f0, rms: saved.rms };
    analyses.set(audioId, an);
    await rpc({ type: 'setAnalysis', id: audioId, an });
    workerAnalysis.add(audioId);
    return an;
  }
  const res = await rpc({ type: 'analyze', id: audioId }, onProgress);
  const an = { hop: res.an.hop, f0: res.an.f0, rms: res.an.rms };
  analyses.set(audioId, an);
  workerAnalysis.add(audioId);
  Store.putAnalysis({ id: audioId, hop: an.hop, f0: an.f0, rms: an.rms }).catch(() => {});
  return an;
}
function freshNote(n) { return { s: n.s, e: n.e, c: n.c, rms: n.rms, t: n.c, flat: 0, vib: 1, gain: 0, form: 0, mute: false, ts: 0, te: 0 }; }
async function ensureTrackNotes(tr, onProgress) {
  const an = await ensureAnalysis(tr.audioId, onProgress);
  if (!tr.pitch.notes) { tr.pitch.notes = DSP.segmentNotes(an).map(freshNote); saveProject(); }
  return an;
}
async function getChroma(audioId) {
  if (chromaCache.has(audioId)) return chromaCache.get(audioId);
  await ensureWorkerAudio(audioId);
  const r = await rpc({ type: 'chroma', id: audioId });
  chromaCache.set(audioId, r.chroma);
  return r.chroma;
}

// ---------------- model ----------------
function defaultClean() { return { on: false, auto: true, reduceDb: 12, sens: 0.45, click: 0.5, breath: 0, profile: null }; }
function migrateTrack(tr) {
  if (tr.kind === 'vocal' && tr.harmonyOf) tr.kind = 'harmony';
  if (!tr.clean) tr.clean = defaultClean();
  if (!tr.cuts) tr.cuts = [];
  if (!tr.fade) tr.fade = { in: 0, out: 0 };
  if (tr.clipGain == null) tr.clipGain = 0;
  if (tr.keyShift == null) tr.keyShift = 0;
  if (!tr.pitch) tr.pitch = { enabled: false, notes: null, transitionMs: 50, tuneOn: false, tune: { speedMs: 20, strength: 1 } };
  if (tr.pitch.mode === 'tune') tr.pitch.tuneOn = true;
  delete tr.pitch.mode;
  if (tr.pitch.tuneOn == null) tr.pitch.tuneOn = false;
  if (!tr.pitch.tune) tr.pitch.tune = { speedMs: 20, strength: 1 };
  if (tr.pitch.notes) tr.pitch.notes.forEach((n) => { if (n.vib == null) n.vib = 1; if (n.gain == null) n.gain = 0; if (n.form == null) n.form = 0; if (n.ts == null) n.ts = 0; if (n.te == null) n.te = 0; });
  if (tr.fx) migrateFx(tr.fx);
  if (!tr.clips) tr.clips = tr.audioId ? [{ at: tr.offset || 0, a: 0, b: 1e9 }] : [];
  delete tr.undo;
  return tr;
}
function migrateProject(p) {
  if (!p.bus) p.bus = defaultBus();
  if (p.bus.delay.pingpong == null) p.bus.delay.pingpong = false;
  if (!p.groups) {
    p.groups = defaultGroups();
    if (p.bus.master) { p.groups.master.vol = p.bus.master.vol || 0; p.groups.master.limiter = p.bus.master.limiter !== false; }
  }
  const dg = defaultGroups();
  for (const k of ['vocal', 'backing', 'master']) { if (!p.groups[k] || typeof p.groups[k] !== 'object') p.groups[k] = dg[k]; if (!p.groups[k].fx) p.groups[k].fx = dg[k].fx; migrateFx(p.groups[k].fx); }
  if (!p.key) p.key = { tonic: 0, mode: 'major', auto: true };
  if (p.memo == null) p.memo = '';
  if (p.rev == null) p.rev = 0;
  p.tracks.forEach(migrateTrack);
  return p;
}
function nextColor() {
  const used = new Set(project.tracks.map((t) => t.color));
  return COLORS.find((c) => !used.has(c)) || COLORS[project.tracks.length % COLORS.length];
}
function makeTrack(kind, audioId, name) {
  return migrateTrack({
    id: uid(), name, kind, audioId, offset: 0, vol: kind === 'backing' ? -2 : kind === 'harmony' ? -5 : 0, pan: 0, mute: false, solo: false,
    color: kind === 'backing' ? BACKING_COLOR : nextColor(),
    fx: fxFromPreset(DEFAULT_PRESET[kind]),
  });
}
function selTrack() { return project && !isGroupId(selectedId) ? project.tracks.find((t) => t.id === selectedId) || null : null; }
function selGroup() { return project && isGroupId(selectedId) ? GROUPS.find((g) => g.id === selectedId) : null; }

// ---------- clips (regions inside a track) ----------
function rawDur(tr) { const b = tr.audioId && buffers.get(tr.audioId); return b ? b.duration : 0; }
function fixClips(tr) {
  const d = rawDur(tr);
  if (!tr.audioId) { tr.clips = []; return; }
  if (!tr.clips || !tr.clips.length) tr.clips = [{ at: tr.offset || 0, a: 0, b: d || 1e9 }];
  tr.clips.forEach((c) => {
    if (d) c.b = Math.min(c.b, d);
    if (c.hi != null) c.b = Math.min(c.b, c.hi);
    c.a = Math.max(c.lo != null ? c.lo : 0, Math.min(c.a, c.b - 0.01));
  });
  tr.clips = tr.clips.filter((c) => c.b - c.a > 0.04).sort((x, y) => x.at - y.at);
  tr.offset = tr.clips.length ? tr.clips[0].at - tr.clips[0].a : (tr.offset || 0);
}
function trackStart(tr) { return tr.clips && tr.clips.length ? Math.min(...tr.clips.map((c) => c.at)) : (tr.offset || 0); }
function trackEnd(tr) { return tr.clips && tr.clips.length ? Math.max(...tr.clips.map((c) => c.at + c.b - c.a)) : (tr.offset || 0); }
// audio time (inside the track's recording) -> timeline time
function tl(tr, t) {
  const cs = tr.clips || [];
  if (!cs.length) return (tr.offset || 0) + t;
  let best = cs[0];
  for (const c of cs) { if (t >= c.a && t < c.b) return c.at + (t - c.a); if (c.a <= t) best = c; }
  return best.at + (t - best.a);
}
// timeline time -> audio time
function au(tr, T) {
  const cs = tr.clips || [];
  if (!cs.length) return T - (tr.offset || 0);
  let best = cs[0];
  for (const c of cs) { if (T >= c.at && T < c.at + (c.b - c.a)) return c.a + (T - c.at); if (c.at <= T) best = c; }
  return best.a + (T - best.at);
}

// ---------------- processing ----------------
function usesPitch(tr) { const p = tr.pitch; return p.enabled && (!!p.notes || p.tuneOn); }
function needsProcessing(tr) {
  if (!tr.audioId) return false;
  if (tr.kind === 'backing') return !!tr.keyShift;
  return usesPitch(tr) || tr.clean.on || tr.cuts.length > 0;
}
function cleanParams(tr) {
  const c = tr.clean;
  return { nr: true, auto: c.auto, reduceDb: c.reduceDb, sens: c.sens, click: c.auto ? 0.5 : c.click, breath: c.auto ? 0 : c.breath, profile: c.profile };
}
function curvesFor(tr, an, extraNotes) {
  return DSP.noteCurves(an, extraNotes || tr.pitch.notes || [], { transitionMs: tr.pitch.transitionMs, cuts: tr.cuts, tune: tr.pitch.tuneOn ? tr.pitch.tune : null, key: project.key });
}

const procTokens = new Map();
const procTimers = new Map();
let procListeners = [];
function onProcState(fn) { procListeners.push(fn); return () => { procListeners = procListeners.filter((f) => f !== fn); }; }
function emitProc(tr, state) { procListeners.forEach((f) => f(tr, state)); }
const keyCache = new Map();

async function processTrack(tr, onProgress) {
  const token = (procTokens.get(tr.id) || 0) + 1;
  procTokens.set(tr.id, token);
  if (!needsProcessing(tr)) {
    processed.delete(tr.id); peaksCache.delete('p:' + tr.id);
    emitProc(tr, 'done'); afterProcess();
    return;
  }
  emitProc(tr, 'busy');
  try {
    let buf;
    const src = buffers.get(tr.audioId);
    if (tr.kind === 'backing') {
      const kid = tr.audioId + '@k' + tr.keyShift;
      if (keyCache.has(kid)) buf = keyCache.get(kid);
      else {
        let rec = await Store.getAudio(kid).catch(() => null);
        if (!rec) {
          await ensureWorkerAudio(tr.audioId);
          const r = await rpc({ type: 'keyshift', id: tr.audioId, semis: tr.keyShift }, onProgress);
          rec = { id: kid, sr: src.sampleRate, channels: r.chs };
          Store.putAudio(rec).catch(() => {});
        }
        buf = toAudioBuffer(rec);
        keyCache.set(kid, buf);
      }
    } else {
      await ensureWorkerAudio(tr.audioId);
      const pitch = usesPitch(tr);
      let curves = null;
      if (pitch || tr.clean.on) await ensureAnalysis(tr.audioId);
      if (pitch) curves = curvesFor(tr, analyses.get(tr.audioId));
      else if (tr.cuts.length) curves = { hop: 0.01, gain: DSP.cutGain(Math.ceil(src.duration / 0.01) + 1, 0.01, tr.cuts) };
      const transfer = [];
      if (curves) for (const k of ['shift', 'formant', 'gain']) if (curves[k]) transfer.push(curves[k].buffer);
      const res = await rpc({ type: 'process', id: tr.audioId, clean: tr.clean.on ? cleanParams(tr) : null, pitch, curves }, onProgress, transfer);
      if (procTokens.get(tr.id) !== token) return;
      if (res.info) tr.cleanInfo = res.info;
      buf = new AudioBuffer({ length: res.out.length, numberOfChannels: 1, sampleRate: src.sampleRate });
      buf.copyToChannel(res.out, 0);
    }
    if (procTokens.get(tr.id) !== token) return;
    processed.set(tr.id, buf);
    procSig.set(tr.id, sigOf(tr));
    peaksCache.delete('p:' + tr.id);
    emitProc(tr, 'done');
    afterProcess();
  } catch (err) {
    console.error(err);
    emitProc(tr, 'error');
    toast('処理に失敗しました: ' + err.message);
  }
}
function afterProcess() {
  drawTimeline();
  if (engine.playing && !rec.active) playFrom(engine.position, currentPlayFilter);
}
function scheduleProcess(tr, delay = 220) {
  clearTimeout(procTimers.get(tr.id));
  procTimers.set(tr.id, setTimeout(() => processTrack(tr), delay));
}
function bufferFor(tr) {
  if (!tr.audioId) return null;
  if (needsProcessing(tr) && processed.has(tr.id)) return processed.get(tr.id);
  return buffers.get(tr.audioId) || null;
}
function reprocessTuned() { for (const t of project.tracks) if (isVox(t) && t.pitch.enabled && t.pitch.tuneOn) scheduleProcess(t); }

// ---------------- UI helpers ----------------
let toastTimer = null;
function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}
function busy(text, p) {
  const b = $('busy');
  if (text === false) { b.classList.add('hidden'); return; }
  b.classList.remove('hidden');
  $('busyText').textContent = text;
  $('busyProg').style.width = p == null ? '0%' : Math.round(p * 100) + '%';
  $('busyProg').parentElement.style.visibility = p == null ? 'hidden' : 'visible';
}
function openModal(build, opts = {}) {
  const m = $('modal'), card = $('modalCard');
  card.innerHTML = '';
  let closed = false;
  const close = () => { if (closed) return; closed = true; m.classList.add('hidden'); m.onclick = null; if (opts.onClose) opts.onClose(); };
  build(card, close);
  m.classList.remove('hidden');
  m.onclick = (e) => { if (e.target === m && !opts.sticky) close(); };
  return close;
}
function confirmModal(title, text, okLabel, danger) {
  return new Promise((resolve) => {
    openModal((c, close) => {
      c.append(h('h3', {}, title), h('p', {}, text),
        h('div', { class: 'actions' },
          h('button', { class: 'big-btn ' + (danger ? 'danger' : 'primary'), onclick: () => { resolve(true); close(); } }, okLabel || 'OK'),
          h('button', { class: 'big-btn ghost', onclick: () => { resolve(false); close(); } }, 'キャンセル')));
    }, { onClose: () => resolve(false) });
  });
}
function promptModal(title, value, okLabel) {
  return new Promise((resolve) => {
    openModal((c, close) => {
      const inp = h('input', { type: 'text', value: value || '', maxlength: '60' });
      const ok = () => { resolve(inp.value.trim() || null); close(); };
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok(); });
      c.append(h('h3', {}, title), h('div', { style: 'margin:12px 0' }, inp),
        h('div', { class: 'actions' }, h('button', { class: 'big-btn primary', onclick: ok }, okLabel || '決定'),
          h('button', { class: 'big-btn ghost', onclick: () => { resolve(null); close(); } }, 'キャンセル')));
      setTimeout(() => inp.focus(), 50);
    }, { onClose: () => resolve(null) });
  });
}
function infoModal(title, html) {
  openModal((c, close) => {
    c.append(h('h3', {}, title), h('div', { class: 'note', html }), h('div', { class: 'actions' }, h('button', { class: 'big-btn', onclick: close }, '閉じる')));
  });
}
function slider({ label, min, max, step, value, fmt, oninput, onchange }) {
  const val = h('span', { class: 'val' }, fmt ? fmt(value) : value);
  const inp = h('input', { type: 'range', min, max, step: step || 1, value });
  inp.addEventListener('input', () => { const v = parseFloat(inp.value); val.textContent = fmt ? fmt(v) : v; oninput && oninput(v); });
  if (onchange) inp.addEventListener('change', () => onchange(parseFloat(inp.value)));
  return h('div', { class: 'row' }, h('label', {}, label), inp, val);
}
function switchRow(label, checked, onchange) {
  const inp = h('input', { type: 'checkbox' });
  inp.checked = !!checked;
  inp.addEventListener('change', () => onchange(inp.checked));
  return h('div', { class: 'row' }, h('span', { class: 'lbl', style: 'flex:1;width:auto' }, label), h('label', { class: 'switch' }, inp, h('span')));
}
function chips(items, current, onpick, cls) {
  const box = h('div', { class: 'chips' + (cls ? ' ' + cls : '') });
  for (const [val, label] of items) box.append(h('button', { class: current === val ? 'on' : '', onclick: () => onpick(val) }, label));
  return box;
}
function section(title, open, ...kids) { return h('details', { class: 'section', open: open || null }, h('summary', {}, title), ...kids); }
const fmtDb = (v) => (v > 0 ? '+' : '') + (Math.round(v * 10) / 10) + ' dB';
const fmtHz = (v) => v >= 1000 ? (Math.round(v / 100) / 10) + ' kHz' : Math.round(v) + ' Hz';
const fmtPct = (v) => Math.round(v * 100) + '%';
function fmtTime(s) { s = Math.round(Math.max(0, s) * 10) / 10; const m = Math.floor(s / 60), r = s - m * 60; return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1); }
function keyLabel(k) { return k.mode === 'chromatic' ? '全音' : NOTE_NAMES[((k.tonic % 12) + 12) % 12] + (k.mode === 'minor' ? 'm' : ''); }

// compact key selector (used at the top of the pitch / harmony tabs and in the editor)
function keyBar(onChanged) {
  const k = project.key;
  const sel = h('select', { class: 'key-select', 'aria-label': 'キー' });
  NOTE_NAMES.forEach((nm, i) => { const o = h('option', { value: i }, nm); if (i === k.tonic) o.selected = true; sel.append(o); });
  sel.addEventListener('change', () => { k.tonic = +sel.value; k.auto = false; k.detected = true; keyChanged(); onChanged && onChanged(); });
  const mode = h('div', { class: 'seg small' },
    ...[['major', 'メジャー'], ['minor', 'マイナー']].map(([m, l]) => h('button', { class: k.mode === m ? 'on' : '', onclick: () => { k.mode = m; k.auto = false; k.detected = true; keyChanged(); onChanged && onChanged(); } }, l)));
  return h('div', { class: 'keybar' }, h('span', { class: 'kb-label' }, 'キー'), sel, mode,
    h('button', { class: 'pill', onclick: async () => { busy('キーを判定中…'); const r = await detectKey(false); busy(false); if (r) { toast(`キーは ${keyLabel(project.key)} と判定しました`); keyChanged(); onChanged && onChanged(); } } }, '自動'));
}
function keyChanged() { saveProject(); refreshHead(); reprocessTuned(); }

// ---------------- home ----------------
async function showHome() {
  stopAll(); bgStop();
  if (project) { await flushSave(); await gcProject(project); await flushSave(); }
  project = null;
  clearProjectMemory();
  TL.selClip = -1; $('editBar').classList.add('hidden');
  setView('home');
  if (window.__utamixUpdateReady) { location.reload(); return; }
  const list = $('projectList');
  list.innerHTML = '';
  let projects = [];
  try { projects = await Store.listProjects(); } catch (e) { toast('保存領域を開けませんでした'); }
  projects.sort((a, b) => b.updatedAt - a.updatedAt);
  $('emptyHint').classList.toggle('hidden', projects.length > 0);
  for (const p of projects) {
    const bars = h('div', { class: 'pl-bars' });
    for (let i = 0; i < 6; i++) { const tr = p.tracks[i]; bars.append(h('i', { style: `height:${tr ? 10 + ((i * 37 + tr.name.length * 13) % 16) : 4}px;background:${tr ? tr.color : ''}` })); }
    list.append(h('li', { onclick: () => openProject(p.id) }, bars,
      h('div', { class: 'pl-main' }, h('div', { class: 'pl-name' }, p.name),
        h('div', { class: 'pl-meta' }, `${p.tracks.length}トラック · ${new Date(p.updatedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`)),
      h('button', { class: 'icon-btn small', 'aria-label': 'メニュー', onclick: (e) => { e.stopPropagation(); projectMenu(p); } }, '⋯')));
  }
  const est = await Store.estimate();
  let persisted = false;
  try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false; } catch (e) { /* ignore */ }
  if (!persisted) persisted = await Store.requestPersist();
  const standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
  $('storageInfo').innerHTML = '';
  $('storageInfo').append(
    h('div', {}, (est && est.usage != null ? `使用中: ${(est.usage / 1048576).toFixed(0)} MB` : '') + ' · データ保護：' + (persisted || standalone ? '有効' : '未設定（ホーム画面に追加してください）')),
    projects.length ? h('button', { class: 'big-btn ghost', style: 'margin-top:10px;min-height:42px', onclick: () => exportAllBackup(projects) }, `すべてのプロジェクトをバックアップ（${projects.length}件）`) : null);
}
function projectMenu(p) {
  openModal((c, close) => {
    c.append(h('h3', {}, p.name), h('div', { class: 'actions' },
      h('button', { class: 'big-btn primary', onclick: async () => { close(); await openProject(p.id); if (project) exportSheet(); } }, '書き出し（WAV）'),
      h('button', { class: 'big-btn', onclick: async () => { close(); const n = await promptModal('名前を変更', p.name); if (n) { p.name = n; await Store.putProject(p); showHome(); } } }, '名前を変更'),
      h('button', { class: 'big-btn', onclick: async () => { close(); const n = await promptModal('複製して別名で保存', p.name + ' のコピー', '複製'); if (n) { await duplicateProject(p, n); showHome(); } } }, '複製（別名で保存）'),
      h('button', { class: 'big-btn', onclick: async () => { close(); await exportBackup(p); } }, 'バックアップファイルを保存'),
      h('button', { class: 'big-btn danger', onclick: async () => { close(); if (await confirmModal('削除しますか？', `「${p.name}」と録音データを完全に削除します。元に戻せません。`, '削除する', true)) { await deleteProjectData(p); showHome(); } } }, '削除'),
      h('button', { class: 'big-btn ghost', onclick: close }, '閉じる')));
  });
}
async function deleteProjectData(p) {
  for (const id of new Set([...p.tracks.map((t) => t.audioId), ...(p.audioPool || [])].filter(Boolean))) {
    await Store.deleteAudio(id).catch(() => {}); await Store.deleteAnalysis(id).catch(() => {});
    for (let k = -12; k <= 12; k++) if (k) Store.deleteAudio(id + '@k' + k).catch(() => {});
  }
  await Store.deleteProject(p.id);
}
async function duplicateProject(p, name) {
  busy('複製中…');
  try {
    const np = clone(p);
    np.id = uid(); np.name = name; np.createdAt = np.updatedAt = Date.now();
    const remap = new Map();
    for (const id of new Set(p.tracks.map((t) => t.audioId).filter(Boolean))) {
      const a = await Store.getAudio(id);
      if (!a) continue;
      const nid = uid();
      remap.set(id, nid);
      await Store.putAudio({ id: nid, sr: a.sr, channels: a.channels });
      const an = await Store.getAnalysis(id).catch(() => null);
      if (an) await Store.putAnalysis(Object.assign({}, an, { id: nid }));
    }
    const tmap = new Map();
    np.tracks.forEach((t) => { const nid = uid(); tmap.set(t.id, nid); t.id = nid; t.audioId = t.audioId ? remap.get(t.audioId) : null; delete t.cleanInfo; delete t.undo; });
    np.tracks.forEach((t) => { if (t.harmonyOf) t.harmonyOf = tmap.get(t.harmonyOf) || null; });
    np.tracks = np.tracks.filter((t) => t.audioId !== undefined);
    np.audioPool = [...remap.values()];
    await Store.putProject(np);
    busy(false);
    toast(`「${name}」として保存しました`);
    return np;
  } catch (e) { busy(false); infoModal('複製できませんでした', String(e.message || e)); return null; }
}
async function newProject() {
  const name = await promptModal('新しいプロジェクト', '歌ってみた ' + new Date().toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' }), '作成');
  if (!name) return;
  const p = migrateProject({ id: uid(), name, createdAt: Date.now(), updatedAt: Date.now(), tracks: [], bus: defaultBus(), groups: defaultGroups(), key: { tonic: 0, mode: 'major', auto: true }, memo: '', rev: 0 });
  await Store.putProject(p);
  Store.requestPersist();
  openProject(p.id);
}
function clearProjectMemory() {
  for (const id of workerAudio) rpc({ type: 'drop', id }).catch(() => {});
  workerAudio.clear(); workerAnalysis.clear();
  buffers.clear(); processed.clear(); analyses.clear(); peaksCache.clear(); chromaCache.clear(); keyCache.clear();
  selectedId = null;
}
async function openProject(id) {
  const p = await Store.getProject(id);
  if (!p) { toast('プロジェクトが見つかりません'); return; }
  clearProjectMemory();
  project = migrateProject(p);
  setView('studio');
  busy('読み込み中…');
  try {
    const ids = [...new Set(project.tracks.map((t) => t.audioId).filter(Boolean))];
    for (let i = 0; i < ids.length; i++) {
      busy('読み込み中…', i / ids.length);
      const a = await Store.getAudio(ids[i]);
      if (a) buffers.set(a.id, toAudioBuffer(a));
    }
  } catch (e) { toast('音源の読み込みに失敗しました'); }
  busy(false);
  project.tracks = project.tracks.filter((t) => !t.audioId || buffers.has(t.audioId));
  project.tracks.forEach(fixClips);
  if (!project.audioPool) project.audioPool = [...new Set(project.tracks.map((t) => t.audioId).filter(Boolean))];
  engine.seek(0);
  TL.scrollX = 0; TL.scrollY = 0;
  await gcProject(project);
  setSaveState('saved');
  histReset();
  fitZoom();
  refreshStudio();
  for (const tr of project.tracks) if (needsProcessing(tr)) processTrack(tr);
}
function toAudioBuffer(a) {
  const buf = new AudioBuffer({ length: a.channels[0].length, numberOfChannels: a.channels.length, sampleRate: a.sr });
  a.channels.forEach((d, i) => buf.copyToChannel(d, i));
  return buf;
}

// ---------------- undo / redo ----------------
const hist = { undo: [], redo: [], last: null, timer: null, applying: false };
const procSig = new Map();
const sigOf = (tr) => JSON.stringify([tr.audioId, tr.clean, tr.pitch, tr.cuts, tr.keyShift, tr.pitch.tuneOn ? project.key : 0]);
const noInfo = (k, v) => (k === 'cleanInfo' ? undefined : v);
// a snapshot is an array of strings; identical parts are shared between snapshots,
// so the undo history can be unlimited without filling the memory
function snapState() {
  const prev = new Map((hist.last || []).map((x) => [x, x]));
  const intern = (str) => prev.get(str) || str;
  const parts = project.tracks.map((t) => intern(JSON.stringify(t, noInfo)));
  parts.push(intern(JSON.stringify({ groups: project.groups, bus: project.bus, key: project.key, memo: project.memo })));
  return parts;
}
const sameSnap = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
function unsnap(parts) { const o = JSON.parse(parts[parts.length - 1]); o.tracks = parts.slice(0, -1).map((x) => JSON.parse(x)); return o; }
function updateHistBtns() {
  const u = $('btnUndo'), r = $('btnRedo');
  if (u) u.disabled = !hist.undo.length && !hist.timer;
  if (r) r.disabled = !hist.redo.length;
}
function histReset() { clearTimeout(hist.timer); hist.timer = null; hist.undo = []; hist.redo = []; hist.last = null; hist.last = project ? snapState() : null; updateHistBtns(); }
function histCommit() {
  clearTimeout(hist.timer); hist.timer = null;
  if (!project || hist.applying) return;
  const cur = snapState();
  if (!sameSnap(cur, hist.last)) {
    if (hist.last) hist.undo.push(hist.last);
    hist.redo = [];
    hist.last = cur;
  }
  updateHistBtns();
}
async function histApply(str) {
  hist.applying = true;
  stopAll();
  const o = unsnap(str);
  Object.assign(project, { tracks: o.tracks, groups: o.groups, bus: o.bus, key: o.key, memo: o.memo });
  for (const tr of project.tracks) {
    migrateTrack(tr);
    if (tr.audioId && !buffers.has(tr.audioId)) {
      const a = await Store.getAudio(tr.audioId).catch(() => null);
      if (a) buffers.set(a.id, toAudioBuffer(a));
    }
    fixClips(tr);
  }
  project.tracks = project.tracks.filter((t) => !t.audioId || buffers.has(t.audioId));
  if (selectedId && !isGroupId(selectedId) && !project.tracks.some((t) => t.id === selectedId)) selectedId = null;
  for (const tr of project.tracks) {
    if (!needsProcessing(tr)) processed.delete(tr.id);
    else if (procSig.get(tr.id) !== sigOf(tr)) processTrack(tr);
  }
  project.rev = (project.rev || 0) + 1;
  setSaveState('dirty');
  clearTimeout(saveTimer); saveTimer = setTimeout(flushSave, 300);
  engine.updateBus(project);
  refreshStudio();
  hist.applying = false;
  updateHistBtns();
}
async function undo() {
  histCommit();
  if (!hist.undo.length) { toast('これ以上戻せません'); return; }
  hist.redo.push(hist.last);
  hist.last = hist.undo.pop();
  await histApply(hist.last);
  toast('元に戻しました', 1200);
}
async function redo() {
  histCommit();
  if (!hist.redo.length) { toast('やり直せる操作がありません'); return; }
  hist.undo.push(hist.last);
  hist.last = hist.redo.pop();
  await histApply(hist.last);
  toast('やり直しました', 1200);
}

// ---------------- saving ----------------
let saveTimer = null;
function setSaveState(st) {
  const el = $('saveState');
  if (el) el.textContent = st === 'saving' ? '保存中…' : st === 'dirty' ? '変更あり' : st === 'error' ? '保存エラー' : '保存済み';
  const sb = $('btnSave'); if (sb) sb.classList.toggle('dirty', st === 'dirty' || st === 'saving' || st === 'error');
}
let previewing = false;
function saveProject() {
  if (!project || previewing) return;
  if (!hist.applying) { clearTimeout(hist.timer); hist.timer = setTimeout(histCommit, 600); updateHistBtns(); }
  project.rev = (project.rev || 0) + 1;
  setSaveState('dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 500);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (!project) return;
  project.updatedAt = Date.now();
  setSaveState('saving');
  try {
    const copy = clone(project);
    copy.tracks.forEach((t) => { delete t.cleanInfo; });
    await Store.putProject(copy);
    setSaveState('saved');
  } catch (e) { setSaveState('error'); toast('保存に失敗しました（容量を確認してください）'); }
}
function setView(v) {
  for (const id of ['home', 'studio', 'pitch']) $(id).classList.toggle('hidden', id !== v);
  if (v === 'studio') requestAnimationFrame(() => { resizeCanvases(); drawTimeline(); });
}

// ---------------- import ----------------
async function decodeFile(file) {
  const ctx = engine.ensure();
  const ab = await file.arrayBuffer();
  try { return await ctx.decodeAudioData(ab.slice(0)); } catch (e) { const w = DSP.parseWav(ab); if (w) return toAudioBuffer(w); throw e; }
}
async function importFiles(files) {
  for (const f of files) {
    if (project.tracks.length >= MAX_TRACKS) { toast(`トラックは最大${MAX_TRACKS}本までです`); break; }
    if ((await importAudio(f, files.length > 1)) === 'cancel') break;
  }
}
async function importAudio(file, multi) {
  busy('音源を読み込み中…');
  let buf;
  try { buf = await decodeFile(file); } catch (e) {
    busy(false);
    infoModal('読み込めませんでした', `「${file.name}」は読み込めませんでした。<br>対応形式：WAV / MP3 / M4A(AAC) / AIFF / CAF / FLAC / 動画（MP4・MOV）など。`);
    return 'fail';
  }
  busy(false);
  const kind = await new Promise((resolve) => {
    openModal((c, close) => {
      const pick = (k) => { resolve(k); close(); };
      const ch = (k, ic, t, sub) => h('button', { class: 'choice', onclick: () => pick(k) }, h('span', { class: 'ic' }, ic), h('div', {}, h('b', {}, t), h('small', {}, sub)));
      c.append(h('h3', {}, '何の音源ですか？'), h('p', {}, file.name + ' · ' + fmtTime(buf.duration)),
        ch('backing', '🎵', 'カラオケ・伴奏', 'キー変更もできます'),
        ch('vocal', '🎤', 'メインボーカル', 'ノイズ除去・ピッチ補正・ハモリ作成'),
        ch('harmony', '🎶', 'ハモリ', 'ハモリ用トラック'),
        h('div', { class: 'actions' }, h('button', { class: 'big-btn ghost', onclick: () => { resolve(null); close(); } }, multi ? '残りもキャンセル' : 'キャンセル')));
    }, { onClose: () => resolve(null) });
  });
  if (!kind) return 'cancel';
  const audioId = uid();
  const channels = kind !== 'backing' ? [monoOf(buf)] : buf.numberOfChannels >= 2 ? [buf.getChannelData(0).slice(), buf.getChannelData(1).slice()] : [buf.getChannelData(0).slice()];
  busy('保存中…');
  try { await Store.putAudio({ id: audioId, sr: buf.sampleRate, channels }); } catch (e) { busy(false); infoModal('保存できませんでした', '端末の空き容量が足りない可能性があります。'); return 'fail'; }
  busy(false);
  buffers.set(audioId, toAudioBuffer({ sr: buf.sampleRate, channels }));
  poolAdd(audioId);
  const tr = makeTrack(kind, audioId, file.name.replace(/\.[^.]+$/, '').slice(0, 24) || KIND_LABEL[kind]);
  tr.clips = [{ at: 0, a: 0, b: buf.duration }];
  project.tracks.push(tr);
  selectedId = tr.id;
  saveProject();
  if (project.tracks.length === 1) fitZoom();
  refreshStudio();
  if (isVox(tr)) autoLevel(tr, true);
  if (kind === 'backing') autoBpm(tr, true);
  return 'ok';
}
async function autoLevel(tr, silent) {
  const buf = tr.audioId && buffers.get(tr.audioId);
  if (!buf) return;
  try {
    const lufs = DSP.loudness([buf.getChannelData(0)], buf.sampleRate);
    if (!isFinite(lufs) || lufs <= -69) return;
    tr.clipGain = Math.max(-20, Math.min(24, Math.round((-20 - lufs) * 2) / 2));
    engine.updateTrack(project, tr);
    saveProject();
    if (!silent) toast(`入力ゲインを ${fmtDb(tr.clipGain)} にしました`);
    if (selectedId === tr.id && sheetTab === 'mix') renderSheet();
  } catch (e) { /* ignore */ }
}
async function autoBpm(tr, silent) {
  try {
    await ensureWorkerAudio(tr.audioId);
    const r = await rpc({ type: 'bpm', id: tr.audioId });
    if (r.bpm) { project.bus.bpm = r.bpm; engine.updateBus(project); saveProject(); refreshHead(); drawTimeline(); if (!silent) toast(`テンポは ${r.bpm} BPM と判定しました`); }
    return r.bpm;
  } catch (e) { return null; }
}

// ---------------- track ops ----------------
// audio is only freed from memory here; it stays saved until the project is closed so undo can bring it back
function poolAdd(id) { if (!project.audioPool) project.audioPool = []; if (id && !project.audioPool.includes(id)) project.audioPool.push(id); }
async function gcProject(p) {
  const used = new Set(p.tracks.map((t) => t.audioId).filter(Boolean));
  for (const id of p.audioPool || []) {
    if (used.has(id)) continue;
    await Store.deleteAudio(id).catch(() => {}); await Store.deleteAnalysis(id).catch(() => {});
    for (let k = -12; k <= 12; k++) if (k) Store.deleteAudio(id + '@k' + k).catch(() => {});
  }
  p.audioPool = [...used];
}
function dropAudioIfUnused(audioId) {
  if (!audioId || project.tracks.some((t) => t.audioId === audioId)) return;
  buffers.delete(audioId); analyses.delete(audioId);
  if (workerAudio.has(audioId)) { rpc({ type: 'drop', id: audioId }).catch(() => {}); workerAudio.delete(audioId); workerAnalysis.delete(audioId); }
}
async function deleteTrack(tr) {
  if (!(await confirmModal('トラックを削除', `「${tr.name}」を削除しますか？`, '削除する', true))) return;
  stopAll();
  project.tracks = project.tracks.filter((t) => t.id !== tr.id);
  processed.delete(tr.id);
  dropAudioIfUnused(tr.audioId);
  if (tr.undo) dropAudioIfUnused(tr.undo.audioId);
  selectedId = null;
  saveProject();
  refreshStudio();
}
function duplicateTrack(tr) {
  if (project.tracks.length >= MAX_TRACKS) { toast(`トラックは最大${MAX_TRACKS}本までです`); return; }
  const c = clone(tr);
  c.id = uid(); c.name = tr.name + ' 複製'; c.color = tr.kind === 'backing' ? BACKING_COLOR : nextColor(); c.solo = false;
  delete c.cleanInfo; delete c.undo;
  project.tracks.splice(project.tracks.indexOf(tr) + 1, 0, c);
  if (needsProcessing(c)) processTrack(c);
  selectedId = c.id;
  saveProject(); refreshStudio();
  toast('トラックを複製しました');
}
function copyTrack(tr) {
  trackClip = { track: clone(tr), projectId: project.id };
  delete trackClip.track.cleanInfo; delete trackClip.track.undo;
  toast(`「${tr.name}」をコピーしました（＋から貼り付け）`);
}
async function pasteTrack() {
  if (!trackClip) { toast('コピーしたトラックがありません'); return; }
  if (project.tracks.length >= MAX_TRACKS) { toast(`トラックは最大${MAX_TRACKS}本までです`); return; }
  const c = clone(trackClip.track);
  c.id = uid(); c.name = c.name + ' (コピー)'; c.solo = false;
  if (trackClip.projectId !== project.id && c.audioId) {
    busy('貼り付け中…');
    const a = await Store.getAudio(c.audioId).catch(() => null);
    if (!a) { busy(false); toast('元の音源が見つかりませんでした'); return; }
    const nid = uid();
    await Store.putAudio({ id: nid, sr: a.sr, channels: a.channels });
    const an = await Store.getAnalysis(c.audioId).catch(() => null);
    if (an) await Store.putAnalysis(Object.assign({}, an, { id: nid }));
    c.audioId = nid;
    buffers.set(nid, toAudioBuffer(a));
    poolAdd(nid);
    delete c.harmonyOf;
    busy(false);
  } else if (c.audioId && !buffers.has(c.audioId)) { toast('元の音源が見つかりませんでした'); return; }
  if (c.kind !== 'backing' && project.tracks.some((t) => t.color === c.color)) c.color = nextColor();
  migrateTrack(c);
  project.tracks.push(c);
  selectedId = c.id;
  if (needsProcessing(c)) processTrack(c);
  saveProject(); refreshStudio();
  toast('貼り付けました');
}
function moveTrack(tr, d) {
  const i = project.tracks.indexOf(tr), j = i + d;
  if (j < 0 || j >= project.tracks.length) return;
  project.tracks.splice(i, 1); project.tracks.splice(j, 0, tr);
  saveProject(); refreshStudio();
}
function setKind(tr, kind) {
  if (tr.kind === kind) return;
  const wasBacking = tr.kind === 'backing';
  tr.kind = kind;
  if (kind === 'backing') { tr.color = BACKING_COLOR; tr.fx = fxFromPreset(DEFAULT_PRESET.backing); }
  else {
    if (wasBacking) { tr.color = nextColor(); tr.keyShift = 0; tr.fx = fxFromPreset(DEFAULT_PRESET[kind]); }
    if (kind === 'vocal') delete tr.harmonyOf;
  }
  saveProject(); processTrack(tr); refreshStudio();
}

// ---------------- timeline ----------------
const TL = { pps: 30, scrollX: 0, scrollY: 0, w: 0, h: 0, rw: 0 };
const rulerCanvas = $('rulerCanvas'), laneCanvas = $('laneCanvas');
const dpr = () => Math.min(3, window.devicePixelRatio || 1);
function projectEnd() {
  let end = 0;
  for (const tr of project.tracks) if (bufferFor(tr)) end = Math.max(end, trackEnd(tr));
  return end;
}
function fitZoom() { const end = projectEnd(); const w = laneCanvas.clientWidth || 260; TL.pps = end > 0 ? Math.max(2, Math.min(200, (w - 20) / end)) : 30; }
function resizeCanvases() {
  const r = dpr();
  for (const c of [rulerCanvas, laneCanvas]) { const w = c.clientWidth, hh = c.clientHeight; if (!w || !hh) continue; c.width = Math.round(w * r); c.height = Math.round(hh * r); }
  TL.w = laneCanvas.clientWidth; TL.h = laneCanvas.clientHeight; TL.rw = rulerCanvas.clientWidth;
}
new ResizeObserver(() => { if (project) { resizeCanvases(); clampScroll(); drawTimeline(); } }).observe(laneCanvas);
function peaksOf(key, buf) {
  if (peaksCache.has(key) && peaksCache.get(key).buf === buf) return peaksCache.get(key).p;
  const per = Math.max(1, Math.floor(buf.sampleRate / 100));
  const n = Math.ceil(buf.length / per);
  const p = new Float32Array(n);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) { let m = 0; const e = Math.min(d.length, (i + 1) * per); for (let k = i * per; k < e; k += 2) { const v = d[k] < 0 ? -d[k] : d[k]; if (v > m) m = v; } if (m > p[i]) p[i] = m; }
  }
  peaksCache.set(key, { buf, p });
  return p;
}
const tracksHeight = () => project.tracks.length * LANE_H + (rec.active && !rec.punch ? LANE_H : 0);
const contentHeight = () => tracksHeight() + (project.tracks.length ? GROUPS.length * GROUP_H + 8 : 0);
function clampScroll() {
  const end = Math.max(projectEnd(), 10);
  TL.scrollX = Math.max(-1, Math.min(TL.scrollX, end - TL.w / TL.pps * 0.3));
  TL.scrollY = Math.max(0, Math.min(TL.scrollY, Math.max(0, contentHeight() - TL.h + 12)));
}
function drawTimeline() {
  if (!project || $('studio').classList.contains('hidden')) return;
  const r = dpr();
  let g = rulerCanvas.getContext('2d');
  g.setTransform(r, 0, 0, r, 0, 0);
  g.clearRect(0, 0, TL.rw, 28);
  g.fillStyle = '#12151b'; g.fillRect(0, 0, TL.rw, 28);
  const step = [0.5, 1, 2, 5, 10, 15, 30, 60].find((s) => s * TL.pps >= 46) || 60;
  g.font = '11px -apple-system, sans-serif'; g.textBaseline = 'middle';
  for (let t = Math.floor(TL.scrollX / step) * step; (t - TL.scrollX) * TL.pps < TL.rw; t += step) {
    if (t < 0) continue;
    const x = Math.round((t - TL.scrollX) * TL.pps) + 0.5;
    g.fillStyle = '#3a414e'; g.fillRect(x, 18, 1, 10);
    g.fillStyle = '#8d95a5'; g.fillText(fmtTime(t).replace(/\.0$/, ''), x + 4, 11);
  }
  const pos = engine.position;
  const px = (pos - TL.scrollX) * TL.pps;
  g.fillStyle = '#f4c95d'; g.beginPath(); g.moveTo(px - 6, 18); g.lineTo(px + 6, 18); g.lineTo(px, 28); g.fill();

  g = laneCanvas.getContext('2d');
  g.setTransform(r, 0, 0, r, 0, 0);
  g.clearRect(0, 0, TL.w, TL.h);
  const beat = 60 / (project.bus.bpm || 120);
  if (beat * TL.pps > 6) {
    for (let b = Math.max(0, Math.floor(TL.scrollX / beat)); (b * beat - TL.scrollX) * TL.pps < TL.w; b++) {
      g.fillStyle = b % 4 === 0 ? '#1b2028' : '#14171d';
      g.fillRect(Math.round((b * beat - TL.scrollX) * TL.pps) + 0.5, 0, 1, tracksHeight() - TL.scrollY);
    }
  }
  project.tracks.forEach((tr, i) => {
    const y = i * LANE_H - TL.scrollY;
    if (y > TL.h || y + LANE_H < 0) return;
    if (tr.id === selectedId) { g.fillStyle = 'rgba(255,255,255,0.035)'; g.fillRect(0, y, TL.w, LANE_H); }
    g.fillStyle = '#1d2129'; g.fillRect(0, y + LANE_H - 1, TL.w, 1);
    const buf = bufferFor(tr);
    if (buf) drawClip(g, tr, buf, peaksOf(buf === processed.get(tr.id) ? 'p:' + tr.id : 'a:' + tr.audioId, buf), y);
    else if (!tr.audioId && !(rec.active && rec.target === tr)) {
      g.strokeStyle = tr.color + '88'; g.setLineDash([4, 4]); g.lineWidth = 1;
      roundRect(g, 8, y + 6, TL.w - 16, LANE_H - 13, 7); g.stroke(); g.setLineDash([]);
      g.fillStyle = '#8d95a5'; g.font = '12px -apple-system, sans-serif';
      g.fillText(tr.id === selectedId ? '● を押すとここに録音します' : 'タップして選択 → ● で録音', 18, y + LANE_H / 2 + 4);
    }
    if (rec.active && rec.punch && rec.target === tr) drawRecPeaks(g, y);
  });
  if (rec.active && !rec.punch) {
    const y = project.tracks.length * LANE_H - TL.scrollY;
    g.fillStyle = 'rgba(255,118,86,0.08)'; g.fillRect(0, y, TL.w, LANE_H);
    drawRecPeaks(g, y);
  }
  // group lanes
  if (project.tracks.length) {
    const y0 = tracksHeight() + 8 - TL.scrollY;
    g.fillStyle = '#0b0d11'; g.fillRect(0, y0 - 8, TL.w, 8);
    GROUPS.forEach((gr, i) => {
      const y = y0 + i * GROUP_H;
      if (y > TL.h || y + GROUP_H < 0) return;
      g.fillStyle = gr.id === selectedId ? '#1b2027' : '#14171d'; g.fillRect(0, y, TL.w, GROUP_H - 1);
      const lvl = engine.playing ? Math.min(1, Math.sqrt(engine.groupLevel(gr.key))) : 0;
      g.fillStyle = gr.color + '55'; g.fillRect(0, y + GROUP_H / 2 - 4, TL.w * lvl, 8);
      const gs = project.groups[gr.key];
      g.fillStyle = '#8d95a5'; g.font = '11px -apple-system, sans-serif';
      g.fillText(`${(PRESETS[gs.fx.preset] || { name: 'カスタム' }).name} · ${fmtDb(gs.vol)}`, 8, y + GROUP_H / 2 + 4);
    });
  }
  g.fillStyle = '#f4c95d'; g.fillRect(Math.round(px), 0, 1.5, Math.min(TL.h, tracksHeight() - TL.scrollY));
  $('timeDisp').textContent = fmtTime(pos);
  if (TL.selClip >= 0) updateEditBar();
}
function drawRecPeaks(g, y) {
  const x0 = (rec.punchPos - TL.scrollX) * TL.pps;
  const dt = 4096 / engine.ctx.sampleRate;
  const skip = Math.max(0, Math.floor((rec.punchPos - rec.startPos) / dt));
  const mid = y + LANE_H / 2;
  g.fillStyle = 'rgba(255,118,86,0.18)';
  g.fillRect(x0, y + 5, Math.max(0, (engine.position - rec.punchPos) * TL.pps), LANE_H - 11);
  g.fillStyle = '#ff7656';
  for (let k = skip; k < rec.peaks.length; k++) {
    const x = x0 + (k - skip) * dt * TL.pps;
    if (x < -2 || x > TL.w) continue;
    const hh = Math.max(1, Math.min(1, rec.peaks[k]) * (LANE_H / 2 - 8));
    g.fillRect(x, mid - hh, Math.max(1, dt * TL.pps - 0.5), hh * 2);
  }
}
function drawClip(g, tr, buf, peaks, y) {
  const muted = tr.mute || (project.tracks.some((t) => t.solo) && !tr.solo);
  const top = y + 5, hh = LANE_H - 11, mid = top + hh / 2;
  const fi = tr.fade.in || 0, fo = tr.fade.out || 0, tS = trackStart(tr), tE = trackEnd(tr);
  const editSel = tr.id === selectedId && TL.selClip >= 0;
  g.globalAlpha = muted ? 0.35 : 1;
  (tr.clips || []).forEach((c, ci) => {
    const x0 = (c.at - TL.scrollX) * TL.pps, w = (c.b - c.a) * TL.pps;
    const vx0 = Math.max(0, x0), vx1 = Math.min(TL.w, x0 + w);
    if (vx1 <= vx0) return;
    const selClip = editSel && TL.selClip === ci;
    g.fillStyle = tr.color + (selClip ? '44' : '22'); roundRect(g, x0, top, w, hh, 7); g.fill();
    if (tr.id === selectedId) { g.strokeStyle = selClip ? '#f4c95d' : tr.color; g.lineWidth = selClip ? 2 : 1.5; roundRect(g, x0 + 0.75, top + 0.75, w - 1.5, hh - 1.5, 7); g.stroke(); }
    g.fillStyle = tr.color;
    for (let x = Math.floor(vx0); x < vx1; x++) {
      const ta = (x - x0) / TL.pps, tb = (x + 1 - x0) / TL.pps;
      const pa = Math.max(0, Math.floor((c.a + ta) * 100)), pb = Math.min(peaks.length, Math.ceil((c.a + tb) * 100));
      let m = 0;
      for (let k = pa; k < pb; k++) if (peaks[k] > m) m = peaks[k];
      const T = c.at + ta;
      let fl = 1;
      if (fi > 0) fl = Math.min(fl, (T - tS) / fi);
      if (fo > 0) fl = Math.min(fl, (tE - T) / fo);
      const v = Math.sqrt(Math.min(1, m)) * (hh / 2 - 3) * Math.max(0, Math.min(1, fl));
      if (v > 0.3) g.fillRect(x, mid - v, 1, v * 2);
    }
    if (selClip) {
      g.fillStyle = '#f4c95d';
      roundRect(g, x0 - 5, top + hh / 2 - 14, 10, 28, 4); g.fill();
      roundRect(g, x0 + w - 5, top + hh / 2 - 14, 10, 28, 4); g.fill();
      g.fillStyle = '#2b2105'; g.fillRect(x0 - 1, top + hh / 2 - 7, 2, 14); g.fillRect(x0 + w - 1, top + hh / 2 - 7, 2, 14);
    }
    if (ci > 0 || (tr.clips.length > 1)) { g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(x0, top, 1, hh); g.fillRect(x0 + w - 1, top, 1, hh); }
  });
  const tags = [];
  if (tr.kind === 'backing' && tr.keyShift) tags.push(`キー${tr.keyShift > 0 ? '+' : ''}${tr.keyShift}`);
  if (isVox(tr) && tr.clean.on) tags.push('ノイズ除去');
  if (isVox(tr) && tr.pitch.enabled) { if (tr.pitch.notes) tags.push('補正'); if (tr.pitch.tuneOn) tags.push('オートチューン'); }
  if (tags.length && tr.clips.length) { g.fillStyle = '#5fd4c4'; g.font = 'bold 10px -apple-system, sans-serif'; g.fillText(tags.join(' · '), Math.max(0, (tr.clips[0].at - TL.scrollX) * TL.pps) + 6, top + 12); }
  g.globalAlpha = 1;
}
function roundRect(g, x, y, w, hh, r) {
  w = Math.max(0, w); hh = Math.max(0, hh);
  r = Math.max(0, Math.min(r, w / 2, hh / 2));
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + hh, r); g.arcTo(x + w, y + hh, x, y + hh, r); g.arcTo(x, y + hh, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
function renderLaneHeads() {
  const heads = $('laneHeads');
  heads.innerHTML = '';
  const inner = h('div', { class: 'lane-heads-inner', id: 'laneHeadsInner' });
  project.tracks.forEach((tr) => {
    inner.append(h('div', { class: 'lane-head' + (tr.id === selectedId ? ' sel' : ''), style: `--c:${tr.color}`, onclick: () => { TL.selClip = -1; updateEditBar(); selectTrack(tr.id, true); drawTimeline(); } },
      h('div', { class: 'ln' }, tr.name),
      h('div', { class: 'lb' },
        h('button', { class: 'm' + (tr.mute ? ' on' : ''), onclick: (e) => { e.stopPropagation(); tr.mute = !tr.mute; engine.updateAudibility(project); saveProject(); renderLaneHeads(); drawTimeline(); } }, 'M'),
        h('button', { class: 's' + (tr.solo ? ' on' : ''), onclick: (e) => { e.stopPropagation(); tr.solo = !tr.solo; engine.updateAudibility(project); saveProject(); renderLaneHeads(); drawTimeline(); } }, 'S'),
        isVox(tr) ? h('button', { class: 'r' + (rec.active && rec.target === tr ? ' on' : ''), 'aria-label': '録音', onclick: (e) => { e.stopPropagation(); recordInto(tr); } }, '●') : null,
        h('span', { class: 'badge k-' + tr.kind }, KIND_BADGE[tr.kind]))));
  });
  if (rec.active && !rec.punch) inner.append(h('div', { class: 'lane-head', style: '--c:#ff7656' }, h('div', { class: 'ln', style: 'color:#ff7656' }, '● 録音中'), h('div', { class: 'note', style: 'font-size:11px' }, KIND_LABEL[rec.kind])));
  if (project.tracks.length) {
    inner.append(h('div', { class: 'group-sep' }));
    GROUPS.forEach((gr) => inner.append(h('div', { class: 'group-head' + (gr.id === selectedId ? ' sel' : ''), style: `--c:${gr.color}`, onclick: () => { TL.selClip = -1; updateEditBar(); selectTrack(gr.id, true); } }, h('span', { class: 'gh-dot' }), gr.name)));
  }
  heads.append(inner);
  inner.style.transform = `translateY(${-TL.scrollY}px)`;
}
function recTargetLabel() {
  const t = recTargetTrack();
  if (settings.recTarget === 'newVocal') return '新規メイン';
  if (settings.recTarget === 'newHarmony') return '新規ハモリ';
  return t ? (t.audioId ? `${t.name}に続けて` : `${t.name}に録音`) : '新規メイン';
}
function refreshHead() {
  $('btnKey').textContent = `${keyLabel(project.key)} · ${project.bus.bpm}`;
  $('btnRecTarget').textContent = '● ' + recTargetLabel();
  $('btnFollow').classList.toggle('on', settings.follow !== false);
  $('btnFollow').textContent = settings.follow !== false ? '⇥ 追尾' : '⇥ 追尾オフ';
  $('btnLyrics').classList.toggle('on', !$('lyricsPane').classList.contains('hidden'));
}
function refreshStudio() {
  $('projName').textContent = project.name;
  refreshHead();
  $('lanesEmpty').classList.toggle('hidden', project.tracks.length > 0 || rec.active);
  renderLaneHeads(); renderSheet(); renderLyrics(); resizeCanvases(); clampScroll(); drawTimeline();
}
let sheetOpen = true;
function selectTrack(id, openSheet) {
  if (openSheet) sheetOpen = true;
  if (selectedId === id) { renderSheet(); return; }
  selectedId = id; TL.selClip = -1; updateEditBar();
  renderLaneHeads(); renderSheet(); refreshHead(); drawTimeline();
}
function allIds() { return [...project.tracks.map((t) => t.id), ...GROUPS.map((g) => g.id)]; }
function stepTrack(d) {
  const ids = allIds();
  if (!ids.length) return;
  let i = ids.indexOf(selectedId);
  i = (i + d + ids.length) % ids.length;
  selectTrack(ids[i]);
  const y = i < project.tracks.length ? i * LANE_H : tracksHeight() + 8 + (i - project.tracks.length) * GROUP_H;
  if (y < TL.scrollY || y + LANE_H > TL.scrollY + TL.h) { TL.scrollY = Math.max(0, y - 10); clampScroll(); renderLaneHeads(); drawTimeline(); }
}
function idAtY(yy) {
  const y = yy + TL.scrollY;
  if (y < project.tracks.length * LANE_H) return (project.tracks[Math.floor(y / LANE_H)] || {}).id;
  const gy = y - tracksHeight() - 8;
  if (gy >= 0 && gy < GROUPS.length * GROUP_H) return GROUPS[Math.floor(gy / GROUP_H)].id;
  return null;
}
// ---------------- clip editing (DAW style: tap a clip → tools appear) ----------------
function selClipObj() { const tr = selTrack(); return tr && TL.selClip >= 0 ? tr.clips[TL.selClip] || null : null; }
function clipEndT(c) { return c.at + (c.b - c.a); }
function clipAtPlayhead(tr) {
  const T = engine.position;
  const sc = selClipObj();
  if (sc && T > sc.at + 0.01 && T < clipEndT(sc) - 0.01) return sc;
  return tr.clips.find((c) => T > c.at + 0.01 && T < clipEndT(c) - 0.01) || null;
}
function selectClip(tr, ci) {
  if (tr.id !== selectedId) { selectedId = tr.id; renderLaneHeads(); refreshHead(); }
  TL.selClip = ci;
  if (ci >= 0) sheetOpen = false;
  renderSheet(); updateEditBar(); drawTimeline();
}
function deselectClip() { if (TL.selClip < 0) return; TL.selClip = -1; updateEditBar(); drawTimeline(); }
let ebState = '';
function updateEditBar() {
  const tr = selTrack(), c = selClipObj();
  const show = !!(tr && c && !rec.active);
  const bar = $('editBar');
  if (bar.classList.contains('hidden') === show) bar.classList.toggle('hidden', !show);
  if (!show) return;
  const T = engine.position, inside = T > c.at + 0.01 && T < clipEndT(c) - 0.01;
  const next = tr.clips.some((x) => x !== c && x.at >= c.at - 1e-6 && x.at > c.at - 1e-6 && x !== c);
  const st = [inside, next, !!settings.clipSnap, c.at.toFixed(2), (c.b - c.a).toFixed(2)].join('|');
  if (st === ebState) return;
  ebState = st;
  $('ebSplit').disabled = !inside; $('ebCutL').disabled = !inside; $('ebCutR').disabled = !inside;
  $('ebJoin').disabled = !next;
  $('ebSnap').classList.toggle('on', !!settings.clipSnap);
  $('ebInfo').textContent = `${fmtTime(c.at)} 〜 ${fmtTime(clipEndT(c))}`;
}
function afterClipEdit(tr, keep) {
  fixClips(tr);
  TL.selClip = keep ? tr.clips.indexOf(keep) : -1;
  ebState = '';
  saveProject(); updateEditBar(); drawTimeline();
  if (engine.playing) playFrom(engine.position, currentPlayFilter);
}
async function clipOp(op) {
  const tr = selTrack();
  if (!tr || !tr.clips.length || rec.active) return;
  const T = engine.position;
  const sel = selClipObj();
  if (op === 'split') {
    const c = clipAtPlayhead(tr); if (!c) { toast('再生位置（黄色い線）をクリップの上に置いてください'); return; }
    const m = c.a + (T - c.at);
    const n = Object.assign({}, c, { at: T, a: m }); c.b = m;
    tr.clips.push(n); afterClipEdit(tr, n); toast('分割しました（右側を選択中）', 1300);
  } else if (op === 'cutL' || op === 'cutR') {
    const c = sel; if (!c) return;
    const s0 = c.at, e0 = clipEndT(c);
    if (!(T > s0 && T < e0)) { toast('黄色い線をクリップの上に置いてください'); return; }
    if (op === 'cutL') { c.a += T - s0; c.at = T; } else c.b -= e0 - T;
    afterClipEdit(tr, c);
    toast(op === 'cutL' ? '黄色い線より前をカットしました' : '黄色い線より後をカットしました', 1300);
  } else if (op === 'dup') {
    const c = sel; if (!c) return;
    const n = Object.assign({}, c, { at: clipEndT(c) });
    tr.clips.push(n); afterClipEdit(tr, n); toast('複製しました（すぐ後ろに配置）', 1400);
  } else if (op === 'del') {
    const c = sel; if (!c) return;
    tr.clips.splice(tr.clips.indexOf(c), 1);
    if (!tr.clips.length) { emptyTrackAfterEdit(tr); return; }
    afterClipEdit(tr, null); toast('クリップを削除しました（↶ で戻せます）', 1600);
  } else if (op === 'join') {
    const c = sel; if (!c) return;
    const rest = tr.clips.filter((x) => x !== c && x.at >= c.at).sort((x, y) => x.at - y.at);
    const n = rest[0]; if (!n) { toast('右側に結合できるクリップがありません'); return; }
    if (Math.abs(n.a - c.b) < 1e-3 && Math.abs(n.at - clipEndT(c)) < 1e-3) {
      c.b = n.b; if (n.hi != null) c.hi = Math.max(c.hi != null ? c.hi : 0, n.hi);
      tr.clips.splice(tr.clips.indexOf(n), 1); afterClipEdit(tr, c); toast('結合しました', 1200); return;
    }
    await joinClips(tr, [c, n]);
  }
}
// render several clips of one track into one new region (stored after the track's audio)
async function joinClips(tr, list) {
  const buf = buffers.get(tr.audioId); if (!buf) return;
  const sr = buf.sampleRate, d = buf.getChannelData(0);
  const t0 = Math.min(...list.map((c) => c.at)), t1 = Math.max(...list.map(clipEndT));
  const seg = new Float32Array(Math.max(1, Math.round((t1 - t0) * sr)));
  const order = list.slice().sort((x, y) => x.at - y.at);
  for (const c of order) {
    const a = Math.round(c.a * sr), b = Math.min(d.length, Math.round(c.b * sr)), o = Math.round((c.at - t0) * sr);
    for (let i = a; i < b; i++) { const j = o + i - a; if (j >= 0 && j < seg.length) seg[j] = d[i]; }
  }
  busy('結合しています…');
  const res = await appendAudio(tr, [{ data: seg, sr, carry: order.map((c) => ({ from: c.a, to: c.b, shift: (c.at - t0) - c.a })) }]);
  busy(false);
  if (!res) return;
  const a0 = res[0];
  const nc = { at: t0, a: a0, b: a0 + seg.length / sr, lo: a0, hi: a0 + seg.length / sr };
  tr.clips = tr.clips.filter((x) => !list.includes(x)); tr.clips.push(nc);
  afterClipEdit(tr, nc);
  processTrack(tr);
  toast('結合しました（↶ で戻せます）', 1400);
}
function emptyTrackAfterEdit(tr) {
  if (isVox(tr)) {
    tr.audioId = null; tr.pitch.notes = null; tr.cuts = []; tr.clips = []; tr.offset = 0;
    processed.delete(tr.id); TL.selClip = -1;
    saveProject(); refreshStudio(); updateEditBar();
    toast('トラックが空になりました（↶ で戻せます）。● でここに録音できます', 2600);
    return;
  }
  project.tracks = project.tracks.filter((t) => t !== tr);
  processed.delete(tr.id);
  selectedId = null; TL.selClip = -1;
  saveProject(); refreshStudio(); updateEditBar();
  toast('トラックが空になったので削除しました（↶ で戻せます）', 2200);
}
function snapTime(t, tr, skipClip) {
  const thr = 10 / TL.pps;
  const cands = [engine.position, 0];
  for (const o of project.tracks) for (const c of o.clips || []) { if (c === skipClip) continue; cands.push(c.at, clipEndT(c)); }
  if (settings.clipSnap) { const beat = 60 / (project.bus.bpm || 120); cands.push(Math.round(t / beat) * beat); }
  let best = t, bd = thr;
  for (const x of cands) { const d = Math.abs(x - t); if (d < bd) { bd = d; best = x; } }
  return best;
}
function trackAtY(y) {
  const id = idAtY(y);
  return id && !isGroupId(id) ? project.tracks.find((t) => t.id === id) || null : null;
}
function hitClip(x, y) {
  const tr = trackAtY(y);
  if (!tr || !tr.clips) return null;
  const T = TL.scrollX + x / TL.pps, edge = 18 / TL.pps;
  const isSel = (i) => tr.id === selectedId && TL.selClip === i;
  // the selected clip wins (its handles stick out a little)
  const order = tr.clips.map((c, i) => i).sort((i, j) => (isSel(j) ? 1 : 0) - (isSel(i) ? 1 : 0));
  for (const i of order) {
    const c = tr.clips[i], s0 = c.at, e0 = clipEndT(c);
    const pad = isSel(i) ? edge * 0.7 : 0;
    if (T >= s0 - pad && T <= e0 + pad) {
      const w = (e0 - s0) * TL.pps;
      const part = !isSel(i) ? 'move' : w < 44 ? (T < s0 + (e0 - s0) / 2 && T < s0 ? 'left' : T > e0 ? 'right' : 'move') : T < s0 + edge ? 'left' : T > e0 - edge ? 'right' : 'move';
      return { tr, ci: i, c, part };
    }
  }
  return { tr, ci: -1 };
}

(function laneGestures() {
  const pts = new Map();
  let mode = null, sx = 0, sy = 0, ssx = 0, ssy = 0, pinch0 = 0, pps0 = 0, anchorT = 0, drag = null, lp = null, hit = null;
  const startDrag = (hc) => { drag = { ...hc, at0: hc.c.at, a0: hc.c.a, b0: hc.c.b, raw: rawDur(hc.tr) }; };
  laneCanvas.addEventListener('pointerdown', (e) => {
    laneCanvas.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    clearTimeout(lp); lp = null;
    TL.dragging = true;
    if (pts.size === 1) {
      mode = 'tap'; sx = e.offsetX; sy = e.offsetY; ssx = TL.scrollX; ssy = TL.scrollY; drag = null;
      hit = rec.active ? null : hitClip(e.offsetX, e.offsetY);
      if (hit && hit.ci >= 0) {
        if (hit.tr.id === selectedId && TL.selClip === hit.ci) startDrag(hit);
        else {
          // long-press an unselected clip → select it and start moving
          lp = setTimeout(() => { if (mode === 'tap' && hit) { selectClip(hit.tr, hit.ci); startDrag(Object.assign({}, hit, { part: 'move' })); mode = 'armed'; if (navigator.vibrate) navigator.vibrate(10); } }, 380);
        }
      }
    } else if (pts.size === 2) { const [a, b] = [...pts.values()]; mode = 'pinch'; drag = null; pinch0 = Math.abs(a.x - b.x) + 1; pps0 = TL.pps; anchorT = TL.scrollX + ((a.x + b.x) / 2) / TL.pps; }
  });
  laneCanvas.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (mode === 'pinch' && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      TL.pps = Math.max(1.5, Math.min(400, pps0 * (Math.abs(a.x - b.x) + 1) / pinch0));
      TL.scrollX = anchorT - ((a.x + b.x) / 2) / TL.pps;
      clampScroll(); drawTimeline(); return;
    }
    if ((mode === 'tap' || mode === 'armed') && Math.hypot(e.offsetX - sx, e.offsetY - sy) > 7) { clearTimeout(lp); lp = null; mode = drag ? 'clip' : 'pan'; }
    if (mode === 'clip' && drag) {
      const c = drag.c, dt = (e.offsetX - sx) / TL.pps;
      const lo = c.lo != null ? c.lo : 0, hi = c.hi != null ? c.hi : (drag.raw || 1e9);
      if (drag.part === 'move') {
        let at = Math.max(0, drag.at0 + dt);
        const len = c.b - c.a, sA = snapTime(at, drag.tr, c), sB = snapTime(at + len, drag.tr, c);
        at = Math.abs(sA - at) <= Math.abs(sB - at - len) ? sA : sB - len;
        c.at = Math.max(0, at);
      } else if (drag.part === 'left') {
        const at = snapTime(drag.at0 + dt, drag.tr, c);
        const a = Math.max(lo, Math.min(drag.a0 + (at - drag.at0), drag.b0 - 0.05));
        c.a = a; c.at = Math.max(0, drag.at0 + (a - drag.a0));
      } else {
        const end = snapTime(drag.at0 + (drag.b0 - drag.a0) + dt, drag.tr, c);
        c.b = Math.max(c.a + 0.05, Math.min(hi, c.a + (end - c.at)));
      }
      ebState = ''; updateEditBar(); drawTimeline(); return;
    }
    if (mode === 'pan') {
      TL.scrollX = ssx - (e.offsetX - sx) / TL.pps; TL.scrollY = ssy - (e.offsetY - sy);
      clampScroll();
      const inner = $('laneHeadsInner'); if (inner) inner.style.transform = `translateY(${-TL.scrollY}px)`;
      drawTimeline();
    }
  });
  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    clearTimeout(lp); lp = null;
    if (mode === 'clip' && drag) { afterClipEdit(drag.tr, drag.c); drag = null; }
    else if (mode === 'armed') { drag = null; }
    else if (mode === 'tap' && e.type === 'pointerup') {
      const id = idAtY(sy);
      if (hit && hit.ci >= 0) {
        // tap a clip → select it (✕ or tapping empty space → deselect)
        selectClip(hit.tr, hit.ci);
      } else if (id && isGroupId(id)) { sheetOpen = true; TL.selClip = -1; updateEditBar(); selectTrack(id, true); }
      else {
        // empty space → move the playhead there (and pick that track for recording)
        const t = Math.max(0, TL.scrollX + sx / TL.pps);
        if (engine.playing && !rec.active) playFrom(t, currentPlayFilter); else if (!rec.active) engine.seek(t);
        TL.selClip = -1; updateEditBar();
        if (id && id !== selectedId) selectTrack(id); else drawTimeline();
      }
    }
    drag = null; hit = null;
    if (pts.size === 0) { mode = null; TL.dragging = false; } else if (mode === 'pinch') mode = 'none';
  };
  laneCanvas.addEventListener('pointerup', end);
  laneCanvas.addEventListener('pointercancel', end);
})();
(function rulerGestures() {
  let down = false;
  const seekTo = (x) => { const t = Math.max(0, TL.scrollX + x / TL.pps); if (engine.playing && !rec.active) playFrom(t, currentPlayFilter); else engine.seek(t); drawTimeline(); };
  rulerCanvas.addEventListener('pointerdown', (e) => { if (rec.active) return; down = true; rulerCanvas.setPointerCapture(e.pointerId); seekTo(e.offsetX); });
  rulerCanvas.addEventListener('pointermove', (e) => { if (down) { engine.seek(Math.max(0, TL.scrollX + e.offsetX / TL.pps)); if (!engine.playing) drawTimeline(); } });
  rulerCanvas.addEventListener('pointerup', (e) => { if (down) { down = false; seekTo(e.offsetX); } });
  rulerCanvas.addEventListener('pointercancel', () => { down = false; });
})();

// ---------------- transport ----------------
let currentPlayFilter = null;
function playbackSession() {
  try { if (!rec.active && navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback'; } catch (e) { /* ignore */ }
}
function playFrom(pos, filter) {
  bgStop();
  playbackSession();
  currentPlayFilter = filter || null;
  const proj = filter ? Object.assign({}, project, { tracks: project.tracks.filter(filter) }) : project;
  engine.play(proj, bufferFor, pos);
  updateTransportUI();
}
function togglePlay(filter) {
  engine.ensure();
  if (rec.active) { stopRecording(); return; }
  if (engine.playing) engine.stop();
  else { let pos = engine.position; if (pos >= projectEnd() - 0.05) pos = 0; playFrom(pos, filter); }
  updateTransportUI();
}
function stopAll() { if (rec.active) stopRecording(); engine.stop(); updateTransportUI(); }
// keep the screen on while playing / recording (iPhone stops the mic when the screen locks)
let wakeLock = null;
async function keepAwake() {
  const want = engine.playing || rec.active;
  try {
    if (want && !wakeLock && navigator.wakeLock && !document.hidden) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!want && wakeLock) { const w = wakeLock; wakeLock = null; await w.release(); }
  } catch (e) { wakeLock = null; }
}
function updateTransportUI() {
  keepAwake();
  $('btnPlay').classList.toggle('on', engine.playing);
  $('btnPlay').textContent = engine.playing ? '❚❚' : '▶';
  $('btnRec').classList.toggle('on', rec.active);
  $('btnRec').classList.toggle('wait', !!rec.finishing);
  if (pitchEditor) pitchEditor.updatePlayButton(engine.playing);
}
function loop() {
  requestAnimationFrame(loop);
  if (!project) return;
  if (engine.playing) {
    const pos = engine.position;
    if (!rec.active && pos > projectEnd() + 0.3) { engine.stop(); engine.seek(0); updateTransportUI(); }
    if (!$('studio').classList.contains('hidden')) {
      const px = (pos - TL.scrollX) * TL.pps;
      if (settings.follow !== false && !TL.dragging && (px > TL.w * 0.85 || px < 0)) TL.scrollX = pos - (TL.w * 0.15) / TL.pps;
      drawTimeline();
    }
    $('meterBar').style.width = Math.min(100, Math.sqrt(rec.active ? (rec.lastPeak || 0) : engine.meter()) * 100) + '%';
    if (grEl && selectedId) grEl.style.width = Math.min(100, Math.abs(engine.reduction(selectedId)) * 6) + '%';
  } else if (rec.active) drawTimeline();
  else $('meterBar').style.width = '0%';
  if (bg.playing) $('bgText').textContent = `バックグラウンド再生 ${fmtTime(bgAudio.currentTime)} / ${fmtTime(bgAudio.duration || 0)}`;
  if (pitchEditor && pitchEditor.isOpen) pitchEditor.tick(engine.position);
}

// ---------------- background playback ----------------
const bgAudio = new Audio();
bgAudio.setAttribute('playsinline', '');
const bg = { playing: false, url: null, rev: -1 };
async function bgStart() {
  if (!project.tracks.length) { toast('トラックがありません'); return; }
  playbackSession();
  const startPos = engine.position;
  stopAll();
  if (bg.rev !== project.rev || !bg.url) { bgAudio.src = URL.createObjectURL(encodeWav([new Float32Array(2205)], 44100, 16)); bgAudio.play().catch(() => {}); }
  try {
    if (bg.rev !== project.rev || !bg.url) {
      for (const tr of project.tracks) if (needsProcessing(tr) && !processed.has(tr.id)) { busy('準備中…'); await processTrack(tr); }
      busy('バックグラウンド再生の準備中…', 0);
      const out = await renderMix(project, bufferFor, engine.ensure().sampleRate, (t) => !t.mute && (!project.tracks.some((x) => x.solo) || t.solo), (p) => busy('バックグラウンド再生の準備中…', p));
      if (bg.url) URL.revokeObjectURL(bg.url);
      bg.url = URL.createObjectURL(encodeWav([out.L, out.R], out.sampleRate, 16));
      bg.rev = project.rev;
    }
    busy(false);
    bgAudio.src = bg.url;
    bgAudio.currentTime = Math.min(startPos, 1e6);
    $('bgBar').classList.remove('hidden');
    bg.playing = true;
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: project.name, artist: 'UtaMix' });
        navigator.mediaSession.setActionHandler('play', () => bgAudio.play());
        navigator.mediaSession.setActionHandler('pause', () => bgAudio.pause());
        navigator.mediaSession.setActionHandler('seekbackward', () => { bgAudio.currentTime = Math.max(0, bgAudio.currentTime - 10); });
        navigator.mediaSession.setActionHandler('seekforward', () => { bgAudio.currentTime += 10; });
      } catch (e) { /* ignore */ }
    }
    await bgAudio.play().catch(() => { toast('▶ を押すと再生が始まります'); });
  } catch (e) { busy(false); infoModal('準備できませんでした', String(e.message || e)); }
}
function bgStop() { if (!bg.playing) return; bgAudio.pause(); bg.playing = false; $('bgBar').classList.add('hidden'); }
bgAudio.addEventListener('ended', bgStop);
bgAudio.addEventListener('pause', () => { $('bgToggle').textContent = '▶'; });
bgAudio.addEventListener('play', () => { $('bgToggle').textContent = '❚❚'; });

// ---------------- recording ----------------
const rec = { active: false, chunks: [], len: 0, peaks: [], firstFrame: -1, startPos: 0, punchPos: 0, playWhen: 0, lastPeak: 0, onDone: null, target: null, punch: false, kind: 'vocal' };
let workletReady = false;
function recTargetTrack() {
  if (settings.recTarget !== 'auto' || !project) return null;
  const t = selTrack();
  if (t && isVox(t)) return t;
  // nothing (or the backing) selected: continue on the track recorded last
  const last = project.tracks.find((x) => x.id === project.lastRecId && isVox(x));
  return last || null;
}
function latencySec() {
  if (settings.latencyMode === 'bt') return settings.btMs / 1000;
  if (settings.latencyMode === 'manual') return settings.latencyMs / 1000;
  const ctx = engine.ensure();
  return Math.max(0.005, (ctx.baseLatency || 0.005) + (ctx.outputLatency || 0.012) + 0.008);
}
function recordInto(tr) {
  selectedId = tr.id;
  settings.recTarget = 'auto'; saveSettings();
  renderLaneHeads(); refreshHead();
  if (rec.active) stopRecording(); else startRecording(tr);
}
async function startRecording(forceTarget, isRetry) {
  if (rec.finishing || rec.starting) { toast('前の録音を保存しています。少し待ってから ● を押してください', 2000); return; }
  rec.starting = true;
  try { await startRecordingInner(forceTarget, isRetry); } finally { rec.starting = false; }
}
async function startRecordingInner(forceTarget, isRetry) {
  const target = forceTarget || recTargetTrack();
  if (!target && project.tracks.length >= MAX_TRACKS) { toast(`トラックは最大${MAX_TRACKS}本までです`); return; }
  bgStop();
  const ctx = engine.ensure();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { infoModal('マイクが使えません', 'https:// のアドレスで開いているか確認してください。'); return; }
  let stream;
  try { if (navigator.audioSession) navigator.audioSession.type = 'play-and-record'; } catch (e) { /* ignore */ }
  const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 };
  if (settings.micId) audio.deviceId = { exact: settings.micId };
  try { stream = await navigator.mediaDevices.getUserMedia({ audio }); }
  catch (e) {
    if (settings.micId) { settings.micId = ''; saveSettings(); try { delete audio.deviceId; stream = await navigator.mediaDevices.getUserMedia({ audio }); } catch (e2) { /* fallthrough */ } }
    if (!stream) { infoModal('マイクを使えませんでした', 'マイクへのアクセスを許可してください（iPhoneの「設定」→ Safari またはこのアプリ →「マイク」）。'); return; }
  }
  // switching the iPhone audio session can pause the audio engine for a moment → wait until it runs again
  const resumeCtx = async () => { for (let i = 0; i < 20 && ctx.state !== 'running'; i++) { try { await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 150))]); } catch (e) { /* retry */ } } };
  try { await resumeCtx(); if (!workletReady) { await ctx.audioWorklet.addModule('recorder-worklet.js'); workletReady = true; } }
  catch (e) { stream.getTracks().forEach((t) => t.stop()); infoModal('録音を開始できませんでした', 'iOSを最新にしてお試しください。'); return; }
  if (engine.playing) engine.stop();
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'uta-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const sink = ctx.createGain(); sink.gain.value = 0;
  src.connect(node); node.connect(sink); sink.connect(ctx.destination);
  let mon = null;
  if (settings.monitor) { mon = ctx.createGain(); mon.gain.value = 0.9; src.connect(mon); mon.connect(ctx.destination); }
  Object.assign(rec, { stream, src, node, sink, mon, chunks: [], len: 0, peaks: [], firstFrame: -1, lastPeak: 0, target, punch: !!target, hiddenAt: 0,
    kind: target ? target.kind : (settings.recTarget === 'newHarmony' ? 'harmony' : 'vocal') });
  node.port.onmessage = (e) => {
    const d = e.data;
    if (d.firstFrame != null) rec.firstFrame = d.firstFrame;
    if (d.pcm) { rec.chunks.push(d.pcm); rec.len += d.pcm.length; rec.peaks.push(d.peak); rec.lastPeak = d.peak; rec.lastChunkAt = performance.now(); }
    if (d.done && rec.onDone) rec.onDone();
  };
  node.port.postMessage('start');
  rec.punchPos = engine.position;
  rec.startPos = Math.max(0, rec.punchPos - (settings.preroll || 0));
  rec.active = true;
  // the target track plays during the pre-roll and stops at the punch point
  let playProj = project;
  if (target) {
    const proxy = Object.assign({}, target, { id: target.id + ':pre', fade: { in: 0, out: 0 },
      clips: (target.clips || []).map((c) => Object.assign({}, c, { b: Math.min(c.b, c.a + Math.max(0, rec.punchPos - c.at)) })).filter((c) => c.b - c.a > 0.02) });
    playProj = Object.assign({}, project, { tracks: project.tracks.map((t) => (t === target ? proxy : t)) });
  }
  const bf = (t) => (t.id.endsWith(':pre') ? bufferFor(target) : bufferFor(t));
  // light playback while recording: no effects, so the audio thread never drops samples
  rec.playWhen = engine.play(playProj, bf, rec.startPos, { lead: 0.2, light: true });
  updateTransportUI(); refreshStudio();
  if (!target) TL.scrollY = Math.max(0, (project.tracks.length + 1) * LANE_H - TL.h);
  if (project.memo && project.memo.trim() && $('lyricsPane').classList.contains('hidden')) { $('lyricsPane').classList.remove('hidden'); refreshHead(); }
  toast(target ? (target.audioId ? `「${target.name}」の${fmtTime(rec.punchPos)}から録音` : `「${target.name}」に録音中`) : '録音中…', 1800);
  keepAwake();
  // watchdog: if no sound data arrives from the mic, restart the recording once automatically
  const session = rec.session = (rec.session || 0) + 1;
  setTimeout(async () => {
    if (!rec.active || rec.session !== session || rec.len > 0) return;
    await resumeCtx();
    setTimeout(async () => {
      if (!rec.active || rec.session !== session || rec.len > 0) return;
      const tgt = rec.target, pos = rec.punchPos;
      await abortRecording();
      engine.seek(pos);
      if (!isRetry) { toast('マイクの準備をやり直しています…', 1500); startRecording(tgt, true); }
      else infoModal('マイクの音が届いていません', 'もう一度 ● を押してください。続く場合は、イヤホンを付け直すか、アプリを開き直してください（録音の設定で「使うマイク」を「自動」にすると直ることがあります）。');
    }, 1300);
  }, 1200);
}
// stop without keeping anything (used when the mic never started)
async function abortRecording() {
  if (!rec.active) return;
  try { rec.node.port.postMessage('stop'); } catch (e) { /* ignore */ }
  engine.stop();
  try { rec.src.disconnect(); rec.node.disconnect(); rec.sink.disconnect(); if (rec.mon) rec.mon.disconnect(); } catch (e) { /* ignore */ }
  rec.stream.getTracks().forEach((t) => t.stop());
  rec.active = false; rec.chunks = []; rec.peaks = []; rec.len = 0;
  updateTransportUI(); refreshStudio();
}

// if the singer started during the pre-roll, keep that part instead of cutting it off
function findEarlyStart(data, sr, preN) {
  const F = Math.round(0.01 * sr);
  const rmsAt = (i) => { let e = 0; const end = Math.min(data.length, i + F); for (let k = i; k < end; k += 2) e += data[k] * data[k]; return Math.sqrt(e / Math.max(1, (end - i) / 2)); };
  const post = [];
  for (let i = preN; i + F <= data.length && post.length < 3000; i += F) post.push(rmsAt(i));
  if (!post.length) return null;
  post.sort((x, y) => x - y);
  const loud = post[Math.floor(post.length * 0.9)];
  const thr = Math.max(0.006, loud * 0.18);
  let earliest = null, gap = 0;
  for (let i = preN - F; i >= 0; i -= F) {
    const r = rmsAt(i);
    if (r > thr) { earliest = i; gap = 0; } else if (++gap > 25) break;
  }
  return earliest != null && preN - earliest > 2 * F ? earliest : null;
}

async function stopRecording() {
  if (!rec.active || rec.finishing) return;
  rec.finishing = true;
  try { await stopRecordingInner(); }
  catch (e) { console.error(e); busy(false); infoModal('録音を保存できませんでした', String(e.message || e)); }
  finally { rec.finishing = false; updateTransportUI(); }
}
async function stopRecordingInner() {
  const ctx = engine.ctx;
  await new Promise((res) => { rec.onDone = res; rec.node.port.postMessage('stop'); setTimeout(res, 800); });
  rec.onDone = null;
  engine.stop();
  try { rec.src.disconnect(); rec.node.disconnect(); rec.sink.disconnect(); if (rec.mon) rec.mon.disconnect(); } catch (e) { /* ignore */ }
  rec.stream.getTracks().forEach((t) => t.stop());
  rec.active = false;
  const R0 = { target: rec.target, punch: rec.punch, punchPos: rec.punchPos, startPos: rec.startPos, playWhen: rec.playWhen, firstFrame: rec.firstFrame, kind: rec.kind };
  updateTransportUI();
  const sr = ctx.sampleRate;
  let data = new Float32Array(rec.len);
  let o = 0;
  for (const c of rec.chunks) { data.set(c, o); o += c.length; }
  rec.chunks = []; rec.peaks = [];
  const first = R0.firstFrame >= 0 ? R0.firstFrame / sr : R0.playWhen;
  let offset = R0.startPos + (first - R0.playWhen) - latencySec();
  let punch = R0.punchPos;
  if (offset < punch) {
    const preN = Math.round((punch - offset) * sr);
    const early = findEarlyStart(data, sr, preN);
    if (early != null) punch = Math.max(offset, offset + early / sr - 0.06);
  }
  if (offset < punch) { data = data.subarray(Math.round((punch - offset) * sr)); offset = punch; }
  if (offset < 0) { data = data.subarray(Math.round(-offset * sr)); offset = 0; }
  if (data.length < sr * 0.3) { toast('録音が短すぎたので破棄しました'); refreshStudio(); return; }
  keepAwake();
  histCommit();
  if (R0.punch && R0.target && project.tracks.includes(R0.target)) {
    project.lastRecId = R0.target.id;
    if (R0.target.audioId) await punchIn(R0.target, data.slice(), sr, offset, R0.punchPos);
    else await recordIntoEmpty(R0.target, data, sr, offset, R0.punchPos);
    return;
  }
  const audioId = uid();
  const channels = [data.slice()];
  try { await Store.putAudio({ id: audioId, sr, channels }); } catch (e) { infoModal('保存できませんでした', '端末の空き容量が足りない可能性があります。'); refreshStudio(); return; }
  buffers.set(audioId, toAudioBuffer({ sr, channels }));
  poolAdd(audioId);
  const kind = R0.kind;
  const n = project.tracks.filter((t) => t.kind === kind && !t.harmonyOf).length + 1;
  const tr = makeTrack(kind, audioId, (kind === 'harmony' ? 'ハモリ ' : 'ボーカル ') + n);
  tr.offset = offset;
  tr.clips = [{ at: offset, a: 0, b: data.length / sr }];
  project.tracks.push(tr);
  selectedId = tr.id;
  project.lastRecId = tr.id;
  settings.recTarget = 'auto'; saveSettings();
  engine.seek(R0.punchPos);
  saveProject(); refreshStudio();
  autoLevel(tr, true);
  toast('録音しました。もう一度 ● で、このトラックに続けて録音できます', 3200);
}

async function clearTake(tr) {
  if (!(await confirmModal('最初から録り直す', `「${tr.name}」の録音を消して空のトラックにします（上の ↶ で戻せます）。`, '消して録り直す', true))) return;
  histCommit();
  stopAll();
  tr.audioId = null; tr.pitch.notes = null; tr.cuts = []; tr.clips = []; tr.offset = 0;
  processed.delete(tr.id);
  project.lastRecId = tr.id;
  saveProject(); refreshStudio();
  toast('空にしました。録りたい位置で ● を押してください', 3000);
}

async function recordIntoEmpty(tr, data, sr, offset, punchPos) {
  const audioId = uid();
  const channels = [data.slice()];
  try { await Store.putAudio({ id: audioId, sr, channels }); } catch (e) { infoModal('保存できませんでした', '端末の空き容量が足りない可能性があります。'); refreshStudio(); return; }
  buffers.set(audioId, toAudioBuffer({ sr, channels }));
  poolAdd(audioId);
  tr.audioId = audioId;
  tr.offset = offset;
  tr.clips = [{ at: offset, a: 0, b: data.length / sr }];
  selectedId = tr.id;
  engine.seek(punchPos);
  saveProject(); refreshStudio();
  autoLevel(tr, true);
  toast('録音しました。もう一度 ● で続けて録音できます（↶ で取り消し）', 3000);
}

// Add audio pieces after the end of a track's recording. The old part stays exactly as it was, so
// every existing clip, note edit and cut keeps working. Returns the start time of each new piece.
async function appendAudio(tr, pieces, onProgress) {
  const old = buffers.get(tr.audioId); if (!old) return null;
  const sr = old.sampleRate, nch = old.numberOfChannels;
  const hopN = Math.round(0.01 * sr);
  const gap = Math.round(0.1 * sr);
  let pos = old.length;
  const starts = [], ranges = [];
  for (const pc of pieces) {
    const chs = Array.isArray(pc.data) ? pc.data : [pc.data];
    pos = Math.ceil((pos + gap) / hopN) * hopN;
    starts.push(pos); ranges.push([pos, pos + chs[0].length]);
    pos += chs[0].length;
  }
  const total = pos + Math.round(0.05 * sr);
  const channels = [];
  for (let c = 0; c < nch; c++) {
    const out = new Float32Array(total);
    out.set(old.getChannelData(c), 0);
    pieces.forEach((pc, k) => { const chs = Array.isArray(pc.data) ? pc.data : [pc.data]; out.set(chs[Math.min(c, chs.length - 1)], starts[k]); });
    channels.push(out);
  }
  const oldId = tr.audioId, audioId = uid();
  try { await Store.putAudio({ id: audioId, sr, channels }); }
  catch (e) { infoModal('保存できませんでした', '端末の空き容量が足りない可能性があります。'); return null; }
  buffers.set(audioId, toAudioBuffer({ sr, channels }));
  poolAdd(audioId);
  for (const c of tr.clips || []) { if (c.lo == null) c.lo = 0; if (c.hi == null) c.hi = old.duration; }
  // pitch analysis: keep the old one and only analyse the new pieces
  const needNotes = !!(tr.pitch.notes || tr.pitch.enabled);
  let oldAn = analyses.get(oldId) || null;
  if (!oldAn && needNotes) { const sv = await Store.getAnalysis(oldId).catch(() => null); if (sv) oldAn = { hop: sv.hop, f0: sv.f0, rms: sv.rms }; }
  tr.audioId = audioId;
  processed.delete(tr.id);
  if (needNotes) {
    try {
      let an;
      if (oldAn) {
        const hop = oldAn.hop, frames = Math.ceil(total / sr / hop);
        const f0 = new Float32Array(frames), rms = new Float32Array(frames);
        f0.set(oldAn.f0.subarray(0, Math.min(oldAn.f0.length, frames))); rms.set(oldAn.rms.subarray(0, Math.min(oldAn.rms.length, frames)));
        for (let k = 0; k < pieces.length; k++) {
          const tmp = audioId + '#p' + k, chs = Array.isArray(pieces[k].data) ? pieces[k].data : [pieces[k].data];
          const copy = chs.map((x) => x.slice());
          await rpc({ type: 'load', id: tmp, sr, chs: copy }, null, copy.map((x) => x.buffer));
          const r = await rpc({ type: 'analyze', id: tmp }, onProgress ? (p) => onProgress((k + p) / pieces.length) : null);
          rpc({ type: 'drop', id: tmp }).catch(() => {});
          const f = Math.round(starts[k] / sr / hop);
          for (let i = 0; i < r.an.f0.length && f + i < frames; i++) { f0[f + i] = r.an.f0[i]; rms[f + i] = r.an.rms[i]; }
        }
        an = { hop, f0, rms };
        analyses.set(audioId, an);
        Store.putAnalysis({ id: audioId, hop, f0, rms }).catch(() => {});
      } else an = await ensureAnalysis(audioId, onProgress);
      if (tr.pitch.notes) {
        const hop = an.hop, oldFrames = old.duration / hop;
        const keep = tr.pitch.notes.filter((n) => n.e <= oldFrames);
        const fresh = DSP.segmentNotes(an).map(freshNote);
        pieces.forEach((pc, k) => {
          const f0i = starts[k] / sr / hop, f1i = ranges[k][1] / sr / hop;
          if (pc.carry) {
            for (const cr of pc.carry) {
              const sh = Math.round((starts[k] / sr + cr.shift) / hop);
              for (const n of tr.pitch.notes) if (n.s >= cr.from / hop - 1 && n.e <= cr.to / hop + 1) keep.push(Object.assign({}, n, { s: n.s + sh, e: n.e + sh }));
            }
          } else for (const n of fresh) if (n.s >= f0i - 1 && n.e <= f1i + 1) keep.push(n);
        });
        tr.pitch.notes = keep.sort((x, y) => x.s - y.s);
      }
    } catch (e) { console.error(e); }
  }
  dropAudioIfUnused(oldId);
  return starts.map((n) => n / sr);
}

// recording from the yellow line into a track that already has audio:
// the old clips are cut at the start/end of the new take and the take becomes its own clip
async function punchIn(tr, take, takeSr, takeStart, punchPos) {
  busy('録音を保存中…');
  const old = buffers.get(tr.audioId);
  const sr = old.sampleRate;
  const data = takeSr === sr ? take : DSP.resample(take, takeSr, sr);
  const len = data.length / sr, nStart = takeStart, nEnd = takeStart + len;
  if (!tr.clips || !tr.clips.length) tr.clips = [{ at: tr.offset || 0, a: 0, b: old.duration }];
  const starts = await appendAudio(tr, [{ data }], (p) => busy('音程を解析中…', p));
  if (!starts) { busy(false); refreshStudio(); return; }
  const a0 = starts[0];
  const out = [];
  for (const c of tr.clips) {
    const s0 = c.at, e0 = clipEndT(c);
    if (e0 <= nStart + 1e-4 || s0 >= nEnd - 1e-4) { out.push(c); continue; }
    if (s0 < nStart) out.push(Object.assign({}, c, { b: c.a + (nStart - s0) }));
    if (e0 > nEnd) out.push(Object.assign({}, c, { at: nEnd, a: c.a + (nEnd - s0) }));
  }
  const nc = { at: nStart, a: a0, b: a0 + len, lo: a0, hi: a0 + len };
  out.push(nc);
  tr.clips = out;
  fixClips(tr);
  busy(false);
  engine.seek(punchPos);
  saveProject(); refreshStudio();
  processTrack(tr);
  const linked = project.tracks.some((t) => t.harmonyOf === tr.id);
  toast(linked ? '録音しました。ハモリは作り直してください' : `${fmtTime(Math.max(nStart, 0))}から録音しました（別のクリップになっています・↶ で取り消し）`, 3000);
}

// put another track's audio into this track (as separate clips) and remove the other track
async function mergeTracks(dst, src) {
  const sb = buffers.get(src.audioId);
  if (!sb) { toast('結合するトラックに音声がありません'); return; }
  histCommit(); stopAll();
  busy('トラックを結合しています…');
  try {
    if (!dst.audioId) {
      dst.audioId = src.audioId; dst.clips = clone(src.clips); dst.cuts = clone(src.cuts || []); dst.pitch.notes = src.pitch.notes ? clone(src.pitch.notes) : null;
    } else {
      const db = buffers.get(dst.audioId), sr = db.sampleRate;
      const pieces = (src.clips || []).map((c) => {
        const a = Math.round(c.a * sb.sampleRate), b = Math.round(Math.min(c.b, sb.duration) * sb.sampleRate);
        const chs = [];
        for (let k = 0; k < sb.numberOfChannels; k++) { const x = sb.getChannelData(k).slice(a, b); chs.push(sb.sampleRate === sr ? x : DSP.resample(x, sb.sampleRate, sr)); }
        return { data: chs, at: c.at };
      }).filter((p) => p.data[0].length > 10);
      const starts = await appendAudio(dst, pieces, (p) => busy('音程を解析中…', p));
      if (!starts) { busy(false); return; }
      pieces.forEach((p, k) => dst.clips.push({ at: p.at, a: starts[k], b: starts[k] + p.data[0].length / sr, lo: starts[k], hi: starts[k] + p.data[0].length / sr }));
    }
    fixClips(dst);
    project.tracks = project.tracks.filter((t) => t !== src);
    processed.delete(src.id);
    selectedId = dst.id;
    busy(false);
    saveProject(); refreshStudio();
    processTrack(dst);
    toast(`「${src.name}」を「${dst.name}」に結合しました（↶ で戻せます）`, 2600);
  } catch (e) { busy(false); console.error(e); infoModal('結合できませんでした', String(e.message || e)); }
}

// ---------------- track sheet ----------------
let grEl = null;
let unsubProc = null;
function tabsFor(tr) { return tr.kind === 'backing' ? ['mix', 'fx', 'key'] : ['mix', 'fx', 'clean', 'pitch', 'harm']; }
const TAB_LABEL = { mix: 'ミックス', fx: 'エフェクト', clean: 'ノイズ', pitch: 'ピッチ', harm: 'ハモリ', key: 'キー', gfx: 'エフェクト', bal: 'バランス' };
function renderSheet() {
  const sheet = $('trackSheet');
  if (unsubProc) { unsubProc(); unsubProc = null; }
  const tr = selTrack(), gr = selGroup();
  if ((!tr && !gr) || !sheetOpen) { sheet.classList.add('hidden'); grEl = null; return; }
  sheet.classList.remove('hidden');
  const tabs = tr ? tabsFor(tr) : ['gfx', 'bal'];
  if (!tabs.includes(sheetTab)) sheetTab = tabs[0];
  $('tsColor').style.background = tr ? tr.color : gr.color;
  $('tsName').textContent = tr ? tr.name : gr.name;
  $('tsKind').textContent = tr ? KIND_LABEL[tr.kind] : 'MIX';
  const nav = $('tsTabs');
  nav.innerHTML = '';
  for (const t of tabs) nav.append(h('button', { 'data-tab': t, class: t === sheetTab ? 'on' : '' }, TAB_LABEL[t]));
  const body = $('tsBody');
  const st = body.scrollTop;
  body.innerHTML = '';
  grEl = null;
  if (gr) (sheetTab === 'gfx' ? buildGroupFxTab : buildBalanceTab)(body, gr);
  else if (!tr.audioId && ['clean', 'pitch', 'harm', 'key'].includes(sheetTab)) body.append(h('p', { class: 'note', style: 'padding:16px 4px' }, 'まだ音声がありません。このトラックを選んだまま ● で録音してください。'));
  else ({ mix: buildMixTab, fx: buildFxTab, clean: buildCleanTab, pitch: buildPitchTab, harm: buildHarmTab, key: buildKeyTab })[sheetTab](body, tr);
  body.scrollTop = st;
}
function trackChanged(tr, rebuild) { engine.updateTrack(project, tr); saveProject(); if (rebuild) renderSheet(); }

function buildMixTab(body, tr) {
  if (isVox(tr)) {
    body.append(h('div', { class: 'mini-btns grid2', style: 'margin:0 0 10px' },
      h('button', { onclick: () => recordInto(tr) }, '● ここに録音'),
      h('button', { disabled: !tr.audioId, onclick: () => clearTake(tr) }, '最初から録り直す')));
  }
  body.append(
    slider({ label: '音量', min: -36, max: 6, step: 0.5, value: tr.vol, fmt: fmtDb, oninput: (v) => { tr.vol = v; trackChanged(tr); } }),
    slider({ label: 'パン', min: -1, max: 1, step: 0.05, value: tr.pan, fmt: (v) => Math.abs(v) < 0.025 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100), oninput: (v) => { tr.pan = v; trackChanged(tr); } }));
  const dur = (buffers.get(tr.audioId) || { duration: 10 }).duration;
  const tv = h('span', { class: 'val', style: 'width:auto;flex:1;text-align:center;font-size:12px' });
  const updT = () => { tv.textContent = trackStart(tr).toFixed(3) + 's'; };
  updT();
  const nudge = (d) => { d = Math.max(-trackStart(tr), d); tr.clips.forEach((c) => { c.at = Math.round((c.at + d) * 1000) / 1000; }); fixClips(tr); updT(); saveProject(); drawTimeline(); if (engine.playing) playFrom(engine.position, currentPlayFilter); };
  body.append(section('詳細', false,
    slider({ label: '入力ゲイン', min: -20, max: 24, step: 0.5, value: tr.clipGain, fmt: fmtDb, oninput: (v) => { tr.clipGain = v; trackChanged(tr); } }),
    isVox(tr) ? h('div', { class: 'mini-btns', style: 'margin:0 0 8px' }, h('button', { onclick: () => autoLevel(tr, false) }, '入力を自動で揃える')) : null,
    slider({ label: 'フェードイン', min: 0, max: Math.min(10, dur / 2), step: 0.1, value: tr.fade.in, fmt: (v) => v.toFixed(1) + ' 秒', oninput: (v) => { tr.fade.in = v; saveProject(); drawTimeline(); } }),
    slider({ label: 'フェードアウト', min: 0, max: Math.min(15, dur / 2), step: 0.1, value: tr.fade.out, fmt: (v) => v.toFixed(1) + ' 秒', oninput: (v) => { tr.fade.out = v; saveProject(); drawTimeline(); } }),
    h('div', { class: 'row' }, h('label', {}, 'タイミング(ms)'),
      h('div', { class: 'mini-btns nudge' },
        h('button', { onclick: () => nudge(-0.01) }, '−10'), h('button', { onclick: () => nudge(-0.001) }, '−1'), tv,
        h('button', { onclick: () => nudge(0.001) }, '+1'), h('button', { onclick: () => nudge(0.01) }, '+10'))),
    h('div', { class: 'lbl-line' }, '種類'),
    chips([['backing', '伴奏'], ['vocal', 'メイン'], ['harmony', 'ハモリ']], tr.kind, (k) => setKind(tr, k))));
  body.append(h('div', { class: 'mini-btns grid3', style: 'margin-top:10px' },
    h('button', { onclick: () => moveTrack(tr, -1) }, '↑ 上へ'),
    h('button', { onclick: () => moveTrack(tr, 1) }, '↓ 下へ'),
    h('button', { onclick: async () => { const n = await promptModal('トラック名', tr.name); if (n) { tr.name = n; saveProject(); refreshStudio(); } } }, '名前'),
    h('button', { onclick: () => duplicateTrack(tr) }, '複製'),
    h('button', { onclick: () => copyTrack(tr) }, 'コピー'),
    h('button', { onclick: () => mergeTrackMenu(tr) }, '⊕ 結合'),
    h('button', { class: 'danger-t', onclick: () => deleteTrack(tr) }, '削除')),
    tr.clips && tr.clips.length > 1 ? h('div', { class: 'mini-btns', style: 'margin-top:8px' }, h('button', { onclick: async () => { histCommit(); await joinClips(tr, tr.clips.slice()); } }, `クリップ${tr.clips.length}個を1つにまとめる`)) : null);
}
function mergeTrackMenu(tr) {
  const others = project.tracks.filter((t) => t !== tr && t.audioId);
  if (!others.length) { toast('結合できる他のトラックがありません'); return; }
  openModal((c, close) => {
    const list = h('div', { class: 'pick-list' });
    for (const t of others) list.append(h('button', { onclick: async () => { close(); if (await confirmModal('トラックを結合', `「${t.name}」の音声を「${tr.name}」の中に入れて、「${t.name}」のトラックはなくします。エフェクトやピッチ補正は「${tr.name}」の設定になります（↶ で戻せます）。`, '結合する')) mergeTracks(tr, t); } },
      h('span', { class: 'sw', style: `background:${t.color}` }), h('span', { style: 'flex:1' }, t.name), h('small', { class: 'note' }, KIND_LABEL[t.kind])));
    c.append(h('h3', {}, `「${tr.name}」に結合するトラック`), list, h('div', { class: 'actions' }, h('button', { class: 'big-btn ghost', onclick: close }, 'キャンセル')));
  });
}

function presetGrid(cat, current, onPick, groupFilter) {
  const grid = h('div', { class: 'preset-grid' });
  for (const [k, p] of Object.entries(PRESETS)) {
    if (p.cat !== cat || (groupFilter && p.group !== groupFilter)) continue;
    grid.append(h('button', { class: current === k ? 'on' : '', onclick: () => onPick(k) }, h('b', {}, p.name), h('small', {}, p.desc)));
  }
  if (!groupFilter || groupFilter === 'mine') {
    for (const t of getTemplates().filter((x) => x.cat === cat)) {
      grid.append(h('button', { class: 'tpl-mine' + (current === 'tpl:' + t.id ? ' on' : ''), onclick: () => onPick('tpl:' + t.id, t) }, h('b', {}, t.name), h('small', {}, '保存したテンプレ')));
    }
  }
  return grid;
}
const fxUi = { group: 'std' };
function buildFxTab(body, tr) {
  const fx = tr.fx;
  const cat = tr.kind;
  const pick = (k, t) => { tr.fx = t ? clone(t.fx) : fxFromPreset(k); tr.fx.preset = k; migrateFx(tr.fx); trackChanged(tr, true); };
  if (cat === 'vocal') {
    const groups = [...Object.entries(PRESET_GROUPS), ['mine', 'マイ']];
    body.append(chips(groups, fxUi.group, (g) => { fxUi.group = g; renderSheet(); }));
    body.append(presetGrid(cat, fx.preset, pick, fxUi.group));
  } else body.append(presetGrid(cat, fx.preset, pick));
  fxTools(body, tr.fx, cat, (nfx) => { tr.fx = nfx; trackChanged(tr, true); }, tr.name);
  fxDetail(body, fx, isVox(tr), () => trackChanged(tr), tr.kind === 'backing');
  const bus = project.bus;
  body.append(section('空間（全トラック共通）', false,
    h('div', { class: 'lbl-line' }, 'リバーブの種類'),
    chips(Object.entries(REVERB_TYPES).map(([k, v]) => [k, v.name]), bus.reverb.type, (k) => { bus.reverb.type = k; engine.updateBus(project); saveProject(); renderSheet(); }),
    h('div', { class: 'lbl-line' }, `ディレイ間隔（${bus.bpm} BPM）`),
    chips(Object.keys(DELAY_NOTES).map((k) => [k, k.replace('.', '付点')]), bus.delay.note, (k) => { bus.delay.note = k; engine.updateBus(project); saveProject(); renderSheet(); }),
    slider({ label: '繰り返し', min: 0, max: 0.75, step: 0.05, value: bus.delay.feedback, fmt: fmtPct, oninput: (v) => { bus.delay.feedback = v; engine.updateBus(project); saveProject(); } }),
    switchRow('ピンポン（左右に跳ねる）', bus.delay.pingpong, (v) => { bus.delay.pingpong = v; engine.updateBus(project); saveProject(); })));
}
function fxTools(body, fx, cat, apply, srcName) {
  const fxClip = (() => { try { return JSON.parse(localStorage.getItem('utamix.fxclip') || 'null'); } catch (e) { return null; } })();
  body.append(h('div', { class: 'mini-btns grid4', style: 'margin:10px 0' },
    h('button', { onclick: () => { saveLS('utamix.fxclip', { fx: clone(fx), name: srcName }); toast('設定をコピーしました'); renderSheet(); } }, 'コピー'),
    h('button', { disabled: !fxClip, onclick: () => { if (!fxClip) return; const n = clone(fxClip.fx); n.preset = 'custom'; migrateFx(n); apply(n); toast(`「${fxClip.name}」の設定を貼り付けました`); } }, '貼り付け'),
    h('button', { onclick: async () => { const n = await promptModal('テンプレートとして保存', '', '保存'); if (!n) return; const id = uid(); setTemplates([...getTemplates(), { id, name: n, cat, fx: clone(fx) }]); fx.preset = 'tpl:' + id; saveProject(); renderSheet(); toast('テンプレートに保存しました'); } }, '保存'),
    h('button', { onclick: () => manageTemplates(cat) }, '管理')));
}
function fxDetail(body, fx, vox, changed, backing) {
  const custom = () => { fx.preset = 'custom'; };
  const ch = () => { custom(); changed(); };
  const eqCanvas = h('canvas', { class: 'eq' });
  const drawEq = () => drawEqCurve(eqCanvas, fx);
  const ranges = [[40, 600], [150, 2500], [1000, 8000], [4000, 16000]];
  const eqSec = section('イコライザー', false, eqCanvas,
    slider({ label: 'ローカット', min: 0, max: 300, step: 5, value: fx.hpf, fmt: (v) => v < 20 ? 'オフ' : fmtHz(v), oninput: (v) => { fx.hpf = v < 20 ? 0 : v; ch(); drawEq(); } }));
  fx.eq.forEach((b, i) => {
    eqSec.append(h('div', { class: 'lbl-line' }, b.label || EQ_LABELS[i]),
      slider({ label: '量', min: -12, max: 12, step: 0.5, value: b.g, fmt: fmtDb, oninput: (v) => { b.g = v; ch(); drawEq(); } }),
      slider({ label: '周波数', min: Math.log10(ranges[i][0]), max: Math.log10(ranges[i][1]), step: 0.005, value: Math.log10(b.f), fmt: (v) => fmtHz(Math.pow(10, v)), oninput: (v) => { b.f = Math.round(Math.pow(10, v)); ch(); drawEq(); } }));
  });
  eqSec.addEventListener('toggle', drawEq);
  body.append(eqSec);
  const gr = h('div', { class: 'gr' }, h('div'));
  grEl = gr.firstChild;
  const c = fx.comp;
  body.append(section('コンプレッサー', false,
    switchRow('使う', c.on, (v) => { c.on = v; ch(); }),
    h('div', { class: 'row' }, h('label', {}, '圧縮量'), gr),
    slider({ label: 'しきい値', min: -50, max: 0, step: 1, value: c.threshold, fmt: (v) => v + ' dB', oninput: (v) => { c.threshold = v; ch(); } }),
    slider({ label: 'レシオ', min: 1, max: 12, step: 0.5, value: c.ratio, fmt: (v) => v + ':1', oninput: (v) => { c.ratio = v; ch(); } }),
    slider({ label: 'アタック', min: 1, max: 80, step: 1, value: c.attack, fmt: (v) => v + ' ms', oninput: (v) => { c.attack = v; ch(); } }),
    slider({ label: 'リリース', min: 20, max: 400, step: 5, value: c.release, fmt: (v) => v + ' ms', oninput: (v) => { c.release = v; ch(); } }),
    slider({ label: '音量補正', min: -12, max: 12, step: 0.5, value: fx.gain, fmt: fmtDb, oninput: (v) => { fx.gain = v; ch(); } })));
  if (vox) {
    const presetsDs = [['0', 'オフ'], ['0.3', '弱'], ['0.5', '中'], ['0.75', '強']];
    body.append(section('ディエッサー（サ行の刺さり）', false,
      h('p', { class: 'hint note' }, '「さしすせそ」の耳に痛いシュッという音だけを抑えます。'),
      chips(presetsDs, presetsDs.find((x) => Math.abs(+x[0] - fx.deess.amount) < 0.01) ? presetsDs.find((x) => Math.abs(+x[0] - fx.deess.amount) < 0.01)[0] : null, (v) => { fx.deess.amount = +v; ch(); renderSheet(); }),
      slider({ label: 'かかり具合', min: 0, max: 1, step: 0.05, value: fx.deess.amount, fmt: (v) => v === 0 ? 'オフ' : fmtPct(v), oninput: (v) => { fx.deess.amount = v; ch(); } }),
      slider({ label: '周波数', min: 4000, max: 10000, step: 100, value: fx.deess.f, fmt: fmtHz, oninput: (v) => { fx.deess.f = v; ch(); } }),
      h('p', { class: 'hint note' }, '女性・高い声は 7〜8kHz、男性・低い声は 5〜6kHz が目安です。')));
  }
  const col = fx.color;
  const tone = section('音色・特殊効果', false,
    slider({ label: 'サチュレーション', min: 0, max: 1, step: 0.05, value: fx.sat, fmt: fmtPct, oninput: (v) => { fx.sat = v; ch(); } }),
    !backing ? slider({ label: 'ダブラー', min: 0, max: 1, step: 0.05, value: fx.doubler, fmt: fmtPct, oninput: (v) => { fx.doubler = v; ch(); } }) : null,
    h('div', { class: 'lbl-line' }, '特殊効果'),
    chips(Object.entries(COLOR_TYPES).map(([k, v]) => [k, v.name]), col.type, (k) => { col.type = k; if (k !== 'none' && !col.mix) col.mix = 1; ch(); renderSheet(); }),
    col.type !== 'none' ? slider({ label: 'かかり具合', min: 0, max: 1, step: 0.05, value: col.mix, fmt: fmtPct, oninput: (v) => { col.mix = v; ch(); } }) : null);
  body.append(tone);
  if (!backing) {
    body.append(section('リバーブ・ディレイ量', false,
      slider({ label: 'リバーブ', min: 0, max: 1, step: 0.01, value: fx.rev, fmt: fmtPct, oninput: (v) => { fx.rev = v; ch(); } }),
      slider({ label: 'ディレイ', min: 0, max: 1, step: 0.01, value: fx.dly, fmt: fmtPct, oninput: (v) => { fx.dly = v; ch(); } })));
  }
}
function manageTemplates(cat) {
  openModal((c, close) => {
    const render = () => {
      c.innerHTML = '';
      const list = getTemplates().filter((t) => t.cat === cat);
      c.append(h('h3', {}, '保存したテンプレート'));
      if (!list.length) c.append(h('p', {}, 'まだありません。'));
      for (const t of list) {
        c.append(h('div', { class: 'list-row' }, h('span', {}, t.name),
          h('button', { class: 'pill', onclick: async () => { const n = await promptModal('名前を変更', t.name); if (n) setTemplates(getTemplates().map((x) => x.id === t.id ? Object.assign(x, { name: n }) : x)); manageTemplates(cat); } }, '名前'),
          h('button', { class: 'pill', style: 'color:#ff5d6c', onclick: () => { setTemplates(getTemplates().filter((x) => x.id !== t.id)); render(); } }, '削除')));
      }
      c.append(h('div', { class: 'actions' }, h('button', { class: 'big-btn ghost', onclick: close }, '閉じる')));
    };
    render();
  }, { onClose: () => renderSheet() });
}
function drawEqCurve(cv, fx) {
  const w = cv.clientWidth, hh = cv.clientHeight;
  if (!w) return;
  const r = dpr();
  cv.width = w * r; cv.height = hh * r;
  const g = cv.getContext('2d');
  g.setTransform(r, 0, 0, r, 0, 0);
  g.clearRect(0, 0, w, hh);
  const fx2x = (f) => (Math.log10(f) - Math.log10(30)) / (Math.log10(18000) - Math.log10(30)) * w;
  const db2y = (d) => hh / 2 - d / 15 * (hh / 2 - 8);
  g.strokeStyle = '#232833'; g.lineWidth = 1;
  for (const f of [100, 1000, 10000]) { const x = fx2x(f); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, hh); g.stroke(); }
  g.beginPath(); g.moveTo(0, hh / 2); g.lineTo(w, hh / 2); g.stroke();
  g.fillStyle = '#5d6574'; g.font = '10px -apple-system, sans-serif';
  g.fillText('100', fx2x(100) + 3, hh - 5); g.fillText('1k', fx2x(1000) + 3, hh - 5); g.fillText('10k', fx2x(10000) + 3, hh - 5);
  g.beginPath();
  for (let x = 0; x <= w; x += 2) {
    const f = Math.pow(10, Math.log10(30) + x / w * (Math.log10(18000) - Math.log10(30)));
    let db = 0;
    if (fx.hpf > 0) db += biquadDb('highpass', fx.hpf, 0, 0.707, f, 48000);
    for (const b of fx.eq) db += biquadDb(b.type, b.f, b.g, b.q, f, 48000);
    const y = db2y(Math.max(-15, Math.min(15, db)));
    if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
  }
  g.strokeStyle = '#5fd4c4'; g.lineWidth = 2; g.stroke();
}
function biquadDb(type, f0, gain, Q, f, sr) {
  const A = Math.pow(10, gain / 40), w0 = 2 * Math.PI * f0 / sr, cs = Math.cos(w0), sn = Math.sin(w0);
  let b0, b1, b2, a0, a1, a2;
  if (type === 'peaking') { const al = sn / (2 * Q); b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A; }
  else if (type === 'highshelf' || type === 'lowshelf') {
    const al = sn / 2 * Math.SQRT2, sA = 2 * Math.sqrt(A) * al;
    if (type === 'highshelf') { b0 = A * ((A + 1) + (A - 1) * cs + sA); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - sA); a0 = (A + 1) - (A - 1) * cs + sA; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - sA; }
    else { b0 = A * ((A + 1) - (A - 1) * cs + sA); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - sA); a0 = (A + 1) + (A - 1) * cs + sA; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - sA; }
  } else { const al = sn / (2 * Q); b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
  const w = 2 * Math.PI * f / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2, ni = -(b1 * s1 + b2 * s2), dr = a0 + a1 * c1 + a2 * c2, di = -(a1 * s1 + a2 * s2);
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

// ---------- group (MIX) tracks ----------
function buildGroupFxTab(body, gr) {
  const gs = project.groups[gr.key];
  const changed = () => { engine.updateGroups(project); saveProject(); drawTimeline(); };
  body.append(slider({ label: '音量', min: -24, max: 12, step: 0.5, value: gs.vol, fmt: fmtDb, oninput: (v) => { gs.vol = v; changed(); } }));
  if (gr.key === 'master') body.append(switchRow('リミッター（音割れ防止）', gs.limiter, (v) => { gs.limiter = v; changed(); }));
  body.append(presetGrid(gr.cat, gs.fx.preset, (k, t) => {
    gs.fx = t ? clone(t.fx) : fxFromPreset(k); gs.fx.preset = k; migrateFx(gs.fx);
    if (gr.key === 'master' && (k === 'gm_cd' || k === 'gm_video')) { project.exportFinal = k === 'gm_cd' ? 'cd' : 'video'; toast(k === 'gm_cd' ? '書き出しも「CD仕様」にしました' : '書き出しも「歌ってみた動画」にしました', 1800); }
    changed(); renderSheet();
  }));
  fxTools(body, gs.fx, gr.cat, (nfx) => { gs.fx = nfx; changed(); renderSheet(); }, gr.name);
  fxDetail(body, gs.fx, gr.key === 'vocal', changed, true);
}
const BALANCE_TPL = [
  { id: 'front', name: '歌を前に', desc: '歌ってみたの定番', lu: 1.5 },
  { id: 'even', name: 'バランス', desc: '歌と音源を同じくらい', lu: 0 },
  { id: 'ballad', name: 'しっとり', desc: '歌をやや前に・柔らかく', lu: 0.8 },
  { id: 'band', name: 'バンド感', desc: '音源の迫力を活かす', lu: -1.5 },
];
function buildBalanceTab(body) {
  const G = project.groups;
  const changed = () => { engine.updateGroups(project); saveProject(); drawTimeline(); };
  body.append(h('p', { class: 'note', style: 'margin:0 0 8px' }, '歌（ボーカル類）と音源の音量バランスを自動で整えます。'));
  const grid = h('div', { class: 'preset-grid' });
  for (const t of BALANCE_TPL) grid.append(h('button', { class: G.balanceTpl === t.id ? 'on' : '', onclick: async () => { await autoBalance(t.lu); G.balanceTpl = t.id; saveProject(); renderSheet(); } }, h('b', {}, t.name), h('small', {}, t.desc)));
  body.append(grid);
  body.append(section('手動で調整', true,
    slider({ label: 'ボーカル類', min: -24, max: 12, step: 0.5, value: G.vocal.vol, fmt: fmtDb, oninput: (v) => { G.vocal.vol = v; G.balanceTpl = null; changed(); } }),
    slider({ label: '音源', min: -24, max: 12, step: 0.5, value: G.backing.vol, fmt: fmtDb, oninput: (v) => { G.backing.vol = v; G.balanceTpl = null; changed(); } }),
    slider({ label: 'マスター', min: -12, max: 6, step: 0.5, value: G.master.vol, fmt: fmtDb, oninput: (v) => { G.master.vol = v; changed(); } })));
}
// Quick loudness estimate of a group, computed in plain JS on a 30 s window (no offline audio render,
// so it is instant and never blocks the iPhone). It models the parts of the effect chain that change
// loudness: high-pass, EQ, compressor (incl. the automatic make-up gain of the Web Audio compressor) and gains.
function bqCoefs(type, f0, g, q, sr) {
  f0 = Math.min(f0, sr * 0.45);
  const A = Math.pow(10, g / 40), w = 2 * Math.PI * f0 / sr, cs = Math.cos(w), sn = Math.sin(w), al = sn / (2 * (q || 0.707));
  let b0, b1, b2, a0, a1, a2;
  if (type === 'peaking') { b0 = 1 + al * A; b1 = -2 * cs; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cs; a2 = 1 - al / A; }
  else if (type === 'highshelf' || type === 'lowshelf') {
    const sA = 2 * Math.sqrt(A) * (sn / 2 * Math.SQRT2);
    if (type === 'highshelf') { b0 = A * ((A + 1) + (A - 1) * cs + sA); b1 = -2 * A * ((A - 1) + (A + 1) * cs); b2 = A * ((A + 1) + (A - 1) * cs - sA); a0 = (A + 1) - (A - 1) * cs + sA; a1 = 2 * ((A - 1) - (A + 1) * cs); a2 = (A + 1) - (A - 1) * cs - sA; }
    else { b0 = A * ((A + 1) - (A - 1) * cs + sA); b1 = 2 * A * ((A - 1) - (A + 1) * cs); b2 = A * ((A + 1) - (A - 1) * cs - sA); a0 = (A + 1) + (A - 1) * cs + sA; a1 = -2 * ((A - 1) + (A + 1) * cs); a2 = (A + 1) + (A - 1) * cs - sA; }
  } else { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; a0 = 1 + al; a1 = -2 * cs; a2 = 1 - al; }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}
function bqRun(x, c) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) { const xi = x[i], yi = c[0] * xi + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2; x2 = x1; x1 = xi; y2 = y1; y1 = yi; x[i] = yi; }
}
function compRun(x, sr, c) {
  const T = c.threshold, Rt = Math.max(1, c.ratio), K = Math.max(0, c.knee);
  const curve = (db) => { if (db < T - K / 2) return db; if (K > 0 && db < T + K / 2) { const d = db - T + K / 2; return db + (1 / Rt - 1) * d * d / (2 * K); } return T + (db - T) / Rt; };
  const makeup = -0.6 * curve(0);
  const at = Math.exp(-1 / (sr * Math.max(0.001, c.attack / 1000))), rl = Math.exp(-1 / (sr * Math.max(0.01, c.release / 1000)));
  let gr = 0;
  for (let i = 0; i < x.length; i++) {
    const lv = 20 * Math.log10(Math.abs(x[i]) + 1e-9);
    const want = curve(lv) - lv;
    gr = want < gr ? at * gr + (1 - at) * want : rl * gr + (1 - rl) * want;
    x[i] *= Math.pow(10, (gr + makeup) / 20);
  }
}
function fxModel(chs, sr, fx, gainDb) {
  for (const x of chs) {
    if (fx.hpf > 0) bqRun(x, bqCoefs('highpass', fx.hpf, 0, 0.707, sr));
    for (const b of fx.eq || []) if (b.g) bqRun(x, bqCoefs(b.type, b.f, b.g, b.q, sr));
    if (fx.comp && fx.comp.on) compRun(x, sr, fx.comp);
    const g = Math.pow(10, (gainDb + (fx.gain || 0)) / 20);
    if (g !== 1) for (let i = 0; i < x.length; i++) x[i] *= g;
  }
}
// accurate measurement: a short offline render through the real effects (12 s, low sample rate).
// If the iPhone takes too long or fails, fall back to the instant JS model so nothing ever freezes.
async function measureGroup(include, from, maxSec = 20) {
  try {
    const proj = Object.assign({}, project, { groups: clone(project.groups) });
    proj.groups.vocal.vol = 0; proj.groups.backing.vol = 0; proj.groups.master.limiter = false;
    const sr = 16000;
    const out = await Promise.race([
      renderMix(proj, bufferFor, sr, include, null, { noTail: true, from, maxSec }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
    ]);
    const v = DSP.loudness([out.L, out.R], sr);
    if (isFinite(v)) return v;
  } catch (e) { /* use the model below */ }
  return measureGroupModel(include, from, 30);
}
async function measureGroupModel(include, from, maxSec = 30) {
  await new Promise((r) => setTimeout(r, 0));
  const sr = 24000, N = Math.max(1, Math.round(maxSec * sr));
  const L = new Float32Array(N), Rt = new Float32Array(N);
  let groupKey = null;
  for (const tr of project.tracks) {
    if (!include(tr)) continue;
    const buf = bufferFor(tr);
    if (!buf) continue;
    groupKey = tr.kind === 'backing' ? 'backing' : 'vocal';
    const c0 = buf.getChannelData(0), c1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
    const xl = new Float32Array(N), xr = c1 ? new Float32Array(N) : null;
    const bsr = buf.sampleRate, step = bsr / sr;
    let any = false;
    for (const c of tr.clips || []) {
      const s0 = Math.max(from, c.at), e0 = Math.min(from + maxSec, c.at + (c.b - c.a));
      if (e0 <= s0) continue;
      any = true;
      const i0 = Math.round((s0 - from) * sr), i1 = Math.min(N, Math.round((e0 - from) * sr));
      const base = (c.a - c.at + from) * bsr;
      // box-filtered downsampling (keeps cymbals etc. from folding back and reading too loud)
      for (let i = i0; i < i1; i++) {
        const j0 = Math.floor(base + i * step), j1 = Math.max(j0 + 1, Math.floor(base + (i + 1) * step));
        if (j0 < 0 || j1 > c0.length) continue;
        let a = 0, b = 0;
        for (let j = j0; j < j1; j++) { a += c0[j]; if (c1) b += c1[j]; }
        xl[i] = a / (j1 - j0); if (xr) xr[i] = b / (j1 - j0);
      }
    }
    if (!any) continue;
    const chs = xr ? [xl, xr] : [xl];
    fxModel(chs, sr, tr.fx || {}, (tr.clipGain || 0) + (tr.vol || 0));
    const m = xr ? 1 : Math.SQRT1_2;
    for (let i = 0; i < N; i++) { L[i] += xl[i] * m; Rt[i] += (xr ? xr[i] : xl[i]) * m; }
    await new Promise((r) => setTimeout(r, 0));
  }
  if (groupKey && project.groups[groupKey]) fxModel([L, Rt], sr, project.groups[groupKey].fx || {}, 0);
  if (groupKey && project.groups.master) fxModel([L, Rt], sr, project.groups.master.fx || {}, 0);
  // small correction measured against the real effect chain (the model reads a backing track a bit louder)
  return DSP.loudness([L, Rt], sr) - (groupKey === 'backing' ? 1.4 : 0);
}
function vocalWindowStart() {
  // start of the busiest vocal part: first vocal note, a bit into the song
  let st = 1e9;
  for (const t of project.tracks) {
    if (t.kind !== 'vocal' || !t.audioId) continue;
    const an = analyses.get(t.audioId);
    const first = t.pitch.notes && t.pitch.notes.length && an ? t.pitch.notes[0].s * an.hop : 0;
    st = Math.min(st, tl(t, first));
  }
  return st < 1e9 ? Math.max(0, st) : 0;
}
async function autoBalance(targetLU, quiet) {
  const hasV = project.tracks.some((t) => isVox(t) && !t.mute && t.audioId), hasB = project.tracks.some((t) => t.kind === 'backing' && !t.mute && t.audioId);
  if (!hasV || !hasB) { if (!quiet) toast('ボーカルと音源の両方が必要です'); return; }
  try {
    const from = vocalWindowStart();
    const lv = await measureGroup((t) => isVox(t) && !t.mute, from);
    const lb = await measureGroup((t) => t.kind === 'backing' && !t.mute, from);
    if (!isFinite(lv) || !isFinite(lb) || lv < -69 || lb < -69) { if (!quiet) toast('音が小さすぎて測れませんでした'); return; }
    const G = project.groups;
    G.backing.vol = 0;
    G.vocal.vol = Math.max(-15, Math.min(15, Math.round((targetLU - (lv - lb)) * 2) / 2));
    engine.updateGroups(project);
    saveProject(); drawTimeline();
    if (!quiet) toast(`ボーカル類を ${fmtDb(G.vocal.vol)} に調整しました`);
  } catch (e) { console.error(e); toast('バランスの測定に失敗しました'); }
}

// ---------- noise tab ----------
function buildCleanTab(body, tr) {
  const c = tr.clean;
  const info = h('div', { class: 'info-line' });
  const showInfo = () => {
    const i = tr.cleanInfo;
    if (!c.on) { info.textContent = ''; return; }
    if (!i) { info.textContent = ''; return; }
    const parts = [];
    if (i.noiseDb != null) parts.push(`ノイズ ${Math.round(i.noiseDb)}dB → ${Math.round(i.reduceDb)}dB低減`);
    if (i.clicks != null) parts.push(`リップノイズ ${i.clicks}個`);
    if (i.breaths != null) parts.push(`ブレス ${i.breaths}箇所`);
    info.textContent = parts.join(' · ');
  };
  showInfo();
  unsubProc = onProcState((t, st) => { if (t === tr) { if (st === 'busy') info.textContent = '処理中…'; else showInfo(); } });
  const apply = () => { saveProject(); scheduleProcess(tr, 350); };
  body.append(switchRow('ノイズ・リップノイズを除去', c.on, (v) => { c.on = v; apply(); renderSheet(); }), info);
  if (!c.on) return;
  body.append(chips([[true, 'おまかせ'], [false, '手動']], c.auto, (v) => { c.auto = v; apply(); renderSheet(); }, 'accent'));
  if (c.auto) return;
  body.append(section('環境ノイズ', true,
    slider({ label: '低減量', min: 0, max: 30, step: 1, value: c.reduceDb, fmt: (v) => v + ' dB', oninput: (v) => { c.reduceDb = v; }, onchange: apply }),
    slider({ label: '感度', min: 0, max: 1, step: 0.05, value: c.sens, fmt: fmtPct, oninput: (v) => { c.sens = v; }, onchange: apply }),
    h('div', { class: 'note' }, c.profile ? `学習：${c.profile[0].toFixed(1)}〜${c.profile[1].toFixed(1)}秒` : '学習：自動（静かな部分）'),
    h('div', { class: 'mini-btns grid2', style: 'margin:8px 0' },
      h('button', { onclick: () => {
        const local = au(tr, engine.position), dur = (buffers.get(tr.audioId) || { duration: 0 }).duration;
        if (local < 0 || local + 0.3 > dur) { toast('再生位置を歌っていない所に合わせてください'); return; }
        c.profile = [local, Math.min(dur, local + 0.6)]; apply(); renderSheet();
      } }, '再生位置で学習'),
      h('button', { onclick: () => { c.profile = null; apply(); renderSheet(); } }, '自動に戻す'))));
  body.append(section('リップノイズ・ブレス', true,
    slider({ label: 'リップノイズ', min: 0, max: 1, step: 0.05, value: c.click, fmt: (v) => v === 0 ? 'オフ' : fmtPct(v), oninput: (v) => { c.click = v; }, onchange: apply }),
    slider({ label: 'ブレス', min: 0, max: 24, step: 1, value: c.breath, fmt: (v) => v === 0 ? 'そのまま' : '−' + v + ' dB', oninput: (v) => { c.breath = v; }, onchange: apply })));
}

// ---------- pitch tab ----------
const TUNE_STYLES = [['k', 'ケロケロ', 0, 1], ['h', 'はっきり', 12, 1], ['m', 'ほどよく', 40, 0.9], ['n', '自然', 90, 0.8]];
function tuneStyleOf(t) { return t.speedMs === 0 ? 'k' : t.speedMs <= 15 ? 'h' : t.speedMs <= 45 ? 'm' : 'n'; }
function buildPitchTab(body, tr) {
  const p = tr.pitch;
  body.append(keyBar(() => renderSheet()));
  if (!p.notes) {
    body.append(h('p', { class: 'note', html: '歌の音程を解析して、<b>1音ずつの補正</b>や<b>オートチューン</b>ができるようにします。' }),
      h('button', { class: 'big-btn primary', onclick: async () => {
        busy('音程を解析中…', 0);
        try { await ensureTrackNotes(tr, (q) => busy('音程を解析中…', q)); } catch (e) { busy(false); toast('解析に失敗しました'); return; }
        await ensureKey();
        busy(false);
        p.enabled = true; saveProject(); processTrack(tr); renderSheet(); refreshHead();
      } }, '音程を解析する'));
    return;
  }
  body.append(switchRow('ピッチ補正を使う', p.enabled, (v) => { p.enabled = v; saveProject(); processTrack(tr); renderSheet(); }));
  body.append(h('button', { class: 'big-btn primary', style: 'margin:4px 0 10px', onclick: () => openPitchEditor(tr) }, 'ピッチエディタを開く'));
  const t = p.tune;
  body.append(section('オートチューン', true,
    switchRow('オートチューンをかける', p.tuneOn, async (v) => { p.tuneOn = v; p.enabled = true; if (v) await ensureKey(); saveProject(); processTrack(tr); renderSheet(); }),
    p.tuneOn ? chips(TUNE_STYLES.map((s) => [s[0], s[1]]), tuneStyleOf(t), (v) => { const s = TUNE_STYLES.find((x) => x[0] === v); t.speedMs = s[2]; t.strength = s[3]; saveProject(); processTrack(tr); renderSheet(); }) : null,
    p.tuneOn ? slider({ label: 'スピード', min: 0, max: 200, step: 1, value: t.speedMs, fmt: (v) => v === 0 ? '最速' : v + ' ms', oninput: (v) => { t.speedMs = v; }, onchange: () => { saveProject(); processTrack(tr); } }) : null,
    p.tuneOn ? slider({ label: '強さ', min: 0, max: 1, step: 0.05, value: t.strength, fmt: fmtPct, oninput: (v) => { t.strength = v; }, onchange: () => { saveProject(); processTrack(tr); } }) : null,
    p.tuneOn ? h('p', { class: 'hint note' }, 'エディタで直した音程・タイミングの上からかかります。') : null));
  if (!tr.harmonyOf) {
    const st = { center: 0.8, drift: 0.3 };
    body.append(section('まとめて自動補正', false,
      slider({ label: '音程の補正', min: 0, max: 1, step: 0.05, value: st.center, fmt: fmtPct, oninput: (v) => { st.center = v; } }),
      slider({ label: 'ゆらぎ補正', min: 0, max: 1, step: 0.05, value: st.drift, fmt: fmtPct, oninput: (v) => { st.drift = v; } }),
      h('div', { class: 'mini-btns grid2' },
        h('button', { onclick: async () => { await autoCorrect(tr, st.center, st.drift); toast(`キー ${keyLabel(project.key)} で補正しました`); } }, '全体に適用'),
        h('button', { onclick: () => { resetPitch(tr); toast('補正をリセットしました'); } }, 'リセット'))));
  }
  body.append(section('なめらかさ', false, slider({ label: 'つながり', min: 0, max: 150, step: 5, value: p.transitionMs, fmt: (v) => v + ' ms', oninput: (v) => { p.transitionMs = v; }, onchange: () => { saveProject(); processTrack(tr); } })));
}
async function ensureKey() { if (project.key.auto && !project.key.detected) { await detectKey(true); refreshHead(); } }
export async function autoCorrect(tr, center, drift, onlyIdx, noProcess) {
  if (!tr.pitch.notes) await ensureTrackNotes(tr);
  await ensureKey();
  tr.pitch.notes.forEach((n, i) => {
    if (onlyIdx && !onlyIdx.has(i)) return;
    const cur = n.t != null ? n.t : n.c;
    const tgt = project.key.mode === 'chromatic' ? Math.round(cur) : DSP.snapToScale(cur, project.key);
    n.t = cur + (tgt - cur) * center;
    n.flat = drift;
  });
  tr.pitch.enabled = true;
  saveProject();
  if (!noProcess) scheduleProcess(tr, 10);
}
function resetPitch(tr) {
  (tr.pitch.notes || []).forEach((n) => Object.assign(n, { t: n.c, flat: 0, vib: 1, gain: 0, form: 0, mute: false, ts: 0, te: 0 }));
  tr.cuts = [];
  saveProject(); scheduleProcess(tr, 10);
}

// ---------- harmony tab ----------
const HARM_INTERVALS = [[2, '3度上'], [4, '5度上'], [5, '6度上'], [7, 'オクターブ上'], [-2, '3度下'], [-3, '4度下'], [-5, '6度下'], [-7, 'オクターブ下']];
const harmState = { mode: 'scale', sel: new Set([2]), chords: true };
function buildHarmTab(body, tr) {
  if (tr.kind === 'harmony') {
    body.append(h('p', { class: 'note' }, tr.harmonyOf ? '自動で作ったハモリ音声です。ピッチタブ・エディタで1音ずつ直せます。' : '自分で録ったハモリです。自動ハモリをお手本に音程を補正できます。'));
    const guides = project.tracks.filter((t) => t.kind === 'harmony' && t.harmonyOf && t.id !== tr.id);
    if (!tr.harmonyOf) guides.forEach((gd) => body.append(h('button', { class: 'big-btn', style: 'margin:6px 0', onclick: () => alignToGuide(tr, gd) }, `「${gd.name}」に音程を合わせる`)));
    return;
  }
  const st = harmState;
  body.append(keyBar(() => renderSheet()));
  body.append(chips([['scale', '度数を保つ'], ['smart', 'おまかせ（コード考慮）']], st.mode, (m) => { st.mode = m; renderSheet(); }, 'accent'));
  body.append(h('p', { class: 'note' }, st.mode === 'scale'
    ? 'メロディを1音ずつ読み取り、音階の中で同じ度数の間隔（例：3度上なら ド→ミ、レ→ファ）を保ったハモリ音声を新しく作ります。'
    : 'メロディを1音ずつ読み取り、伴奏のコードとぶつからない音を選んでハモリ音声を新しく作ります。'));
  if (st.mode === 'scale') {
    const box = h('div', { class: 'chips' });
    for (const [steps, label] of HARM_INTERVALS) box.append(h('button', { class: st.sel.has(steps) ? 'on' : '', onclick: () => { if (st.sel.has(steps)) st.sel.delete(steps); else st.sel.add(steps); renderSheet(); } }, label));
    body.append(box, h('button', { class: 'big-btn primary', style: 'margin-top:8px', onclick: () => {
      if (!st.sel.size) { toast('間隔を選んでください'); return; }
      generateHarmony(tr, [...st.sel].map((s) => ({ type: 'scale', steps: s })));
    } }, `ハモリを作る（${st.sel.size}本）`));
  } else {
    if (project.tracks.some((t) => t.kind === 'backing')) body.append(switchRow('伴奏のコードを参考にする', st.chords, (v) => { st.chords = v; }));
    body.append(h('div', { class: 'mini-btns grid3' },
      h('button', { onclick: () => generateHarmony(tr, [{ type: 'smart', dir: 'up' }]) }, '上ハモ'),
      h('button', { onclick: () => generateHarmony(tr, [{ type: 'smart', dir: 'down' }]) }, '下ハモ'),
      h('button', { onclick: () => generateHarmony(tr, [{ type: 'smart', dir: 'up' }, { type: 'smart', dir: 'down' }]) }, '上下両方')));
  }
}

// read the melody note by note and render a brand-new harmony voice (its own audio)
async function generateHarmony(lead, specs, quiet) {
  if (project.tracks.length + specs.length > MAX_TRACKS) { toast(`トラックは最大${MAX_TRACKS}本までです（あと${MAX_TRACKS - project.tracks.length}本）`); return; }
  busy('メロディを1音ずつ読み取り中…', 0);
  let an;
  try { an = await ensureTrackNotes(lead, (p) => busy('メロディを1音ずつ読み取り中…', p)); } catch (e) { busy(false); toast('解析に失敗しました'); return; }
  if (project.key.auto && !project.key.detected) { busy('キーを判定中…'); await detectKey(true); refreshHead(); }
  const key = project.key;
  let chords = null;
  const backing = project.tracks.find((t) => t.kind === 'backing');
  if (specs.some((s) => s.type === 'smart') && harmState.chords && backing) {
    busy('伴奏のコードを解析中…');
    try {
      const ch = await getChroma(backing.audioId);
      chords = lead.pitch.notes.map((n) => DSP.bestChord(DSP.chromaRange(ch, au(backing, tl(lead, n.s * an.hop)), au(backing, tl(lead, n.e * an.hop))), key));
    } catch (e) { chords = null; }
  }
  const leadNotes = lead.pitch.notes;
  const mel = leadNotes.map((n) => ({ t: key.mode === 'chromatic' ? Math.round(n.t != null ? n.t : n.c) : DSP.snapToScale(n.t != null ? n.t : n.c, key), s: n.s, e: n.e }));
  let ins = project.tracks.indexOf(lead) + 1;
  while (project.tracks[ins] && project.tracks[ins].harmonyOf === lead.id) ins++;
  const src = buffers.get(lead.audioId);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1; };
  for (let si = 0; si < specs.length; si++) {
    const sp = specs[si];
    busy(`ハモリ音声を作成中…（${si + 1}/${specs.length}）`, si / specs.length);
    const line = sp.type === 'scale' ? DSP.diatonicLine(mel, key, sp.steps) : DSP.harmonyLine(mel, key, chords, sp.dir, an.hop);
    const label = sp.type === 'scale' ? HARM_INTERVALS.find((x) => x[0] === sp.steps)[1] : (sp.dir === 'up' ? '上ハモ' : '下ハモ');
    const up = sp.type === 'scale' ? sp.steps > 0 : sp.dir === 'up';
    // humanise: slightly different timing and voice colour so it sounds like a separate take
    const formBase = up ? 0.25 : -0.25;
    const hn = leadNotes.map((n, i) => Object.assign(freshNote(n), {
      t: line[i], flat: Math.max(n.flat || 0, 0.4), vib: Math.min(n.vib != null ? n.vib : 1, 0.75),
      gain: n.gain || 0, mute: !!n.mute,
      form: (n.form || 0) + formBase + rnd() * 0.15,
      ts: (n.ts || 0) + rnd() * 0.012, te: (n.te || 0) + rnd() * 0.012,
    }));
    const curves = DSP.noteCurves(an, hn, { transitionMs: 45, cuts: lead.cuts, key });
    const transfer = [];
    for (const k of ['shift', 'formant', 'gain']) if (curves[k]) transfer.push(curves[k].buffer);
    let res;
    try {
      await ensureWorkerAudio(lead.audioId);
      res = await rpc({ type: 'process', id: lead.audioId, clean: lead.clean.on ? cleanParams(lead) : null, pitch: true, curves }, null, transfer);
    } catch (e) { busy(false); toast('ハモリの作成に失敗しました'); return; }
    const audioId = uid();
    await Store.putAudio({ id: audioId, sr: src.sampleRate, channels: [res.out] });
    buffers.set(audioId, toAudioBuffer({ sr: src.sampleRate, channels: [res.out] }));
    poolAdd(audioId);
    const tr = makeTrack('harmony', audioId, label + '（' + lead.name + '）');
    tr.harmonyOf = lead.id;
    tr.offset = lead.offset;
    tr.clips = clone(lead.clips);
    fixClips(tr);
    tr.vol = Math.min(lead.vol, 0) - 5;
    tr.clipGain = lead.clipGain;
    tr.pan = up ? -0.3 : 0.3;
    project.tracks.splice(ins++, 0, tr);
  }
  busy(false);
  saveProject(); refreshStudio();
  if (!quiet) toast(specs.length > 1 ? `ハモリ音声を${specs.length}本作りました` : 'ハモリ音声を作りました');
}
async function alignToGuide(tr, guide) {
  busy('音程を解析中…', 0);
  try { await ensureTrackNotes(tr, (p) => busy('音程を解析中…', p)); await ensureTrackNotes(guide); } catch (e) { busy(false); toast('解析に失敗しました'); return; }
  const gan = analyses.get(guide.audioId), tan = analyses.get(tr.audioId);
  busy(false);
  let n = 0;
  for (const nt of tr.pitch.notes) {
    const a = tl(tr, nt.s * tan.hop), b = tl(tr, nt.e * tan.hop);
    let best = null, bo = 0;
    for (const gn of guide.pitch.notes) {
      const ov = Math.min(b, tl(guide, gn.e * gan.hop)) - Math.max(a, tl(guide, gn.s * gan.hop));
      if (ov > bo) { bo = ov; best = gn; }
    }
    if (best && bo > (b - a) * 0.3) {
      let tgt = best.t != null ? best.t : best.c;
      while (tgt - nt.c > 6) tgt -= 12;
      while (nt.c - tgt > 6) tgt += 12;
      nt.t = Math.round(tgt); nt.flat = Math.max(nt.flat || 0, 0.3); n++;
    }
  }
  tr.pitch.enabled = true;
  saveProject(); processTrack(tr);
  toast(`${n}個のノートをガイドに合わせました`);
}
async function detectKey(silent) {
  const hist = new Array(12).fill(0);
  let any = false;
  for (const tr of project.tracks) {
    if (tr.kind !== 'vocal' || !tr.pitch.notes) continue;
    let tot = 0;
    for (const n of tr.pitch.notes) tot += n.e - n.s;
    for (const n of tr.pitch.notes) hist[((Math.round(n.c) % 12) + 12) % 12] += (n.e - n.s) / Math.max(1, tot);
    any = true;
  }
  const backing = project.tracks.find((t) => t.kind === 'backing');
  if (backing) {
    try {
      const ch = await getChroma(backing.audioId);
      const v = DSP.chromaRange(ch, 0, 1e9);
      let s = 0; for (const x of v) s += x;
      if (s > 0) { const k = backing.keyShift || 0; for (let i = 0; i < 12; i++) hist[(i + k + 120) % 12] += v[i] / s * 1.5; any = true; }
    } catch (e) { /* ignore */ }
  }
  if (!any) { if (!silent) toast('伴奏かボーカル（解析済み）が必要です'); return null; }
  const res = DSP.detectKey(hist);
  project.key = { tonic: res[0].tonic, mode: res[0].mode, auto: true, detected: true };
  saveProject();
  return res;
}

// ---------- backing key tab ----------
function buildKeyTab(body, tr) {
  const set = async (v) => {
    v = Math.max(-7, Math.min(7, v));
    if (v === tr.keyShift) return;
    const delta = v - tr.keyShift;
    tr.keyShift = v;
    if (project.key.detected || !project.key.auto) { project.key.tonic = ((project.key.tonic + delta) % 12 + 12) % 12; refreshHead(); }
    saveProject(); renderSheet();
    if (v !== 0 && !keyCache.has(tr.audioId + '@k' + v)) busy('伴奏のキーを変更中…', 0);
    await processTrack(tr, (p) => busy('伴奏のキーを変更中…', p));
    busy(false);
    reprocessTuned();
    toast(v === 0 ? '原曲キーに戻しました' : `キーを ${v > 0 ? '+' : ''}${v} にしました（曲のキー：${keyLabel(project.key)}）`);
  };
  body.append(h('p', { class: 'note' }, 'カラオケのキーを半音単位で変えます（テンポは変わりません）。'),
    h('div', { class: 'row', style: 'margin:14px 0' },
      h('button', { class: 'big-btn', style: 'width:72px;flex:none', onclick: () => set(tr.keyShift - 1) }, '−'),
      h('div', { class: 'key-big' }, (tr.keyShift > 0 ? '+' : '') + tr.keyShift),
      h('button', { class: 'big-btn', style: 'width:72px;flex:none', onclick: () => set(tr.keyShift + 1) }, '＋')),
    h('button', { class: 'big-btn ghost', onclick: () => set(0) }, '原曲キーに戻す'),
    h('div', { class: 'mini-btns', style: 'margin-top:12px' }, h('button', { onclick: () => autoBpm(tr, false) }, 'テンポを自動判定')));
}

// ---------------- key / tempo sheet ----------------
function keySheet() {
  openModal((c, close) => {
    const render = () => {
      c.innerHTML = '';
      const bpmVal = h('span', { class: 'key-big', style: 'font-size:24px' }, project.bus.bpm);
      const setBpm = (v) => { project.bus.bpm = Math.max(40, Math.min(240, Math.round(v))); bpmVal.textContent = project.bus.bpm; engine.updateBus(project); saveProject(); refreshHead(); drawTimeline(); };
      const backing = project.tracks.find((t) => t.kind === 'backing');
      c.append(h('h3', {}, 'キーとテンポ'), keyBar(() => render()),
        h('div', { class: 'chips', style: 'margin-top:4px' }, h('button', { class: project.key.mode === 'chromatic' ? 'on' : '', onclick: () => { project.key.mode = project.key.mode === 'chromatic' ? 'major' : 'chromatic'; project.key.auto = false; project.key.detected = true; keyChanged(); render(); } }, '全ての半音に合わせる')),
        h('h3', { style: 'margin-top:18px' }, 'テンポ（BPM）'),
        h('div', { class: 'row' }, h('div', { class: 'mini-btns' }, h('button', { onclick: () => setBpm(project.bus.bpm - 1) }, '−')), bpmVal, h('div', { class: 'mini-btns' }, h('button', { onclick: () => setBpm(project.bus.bpm + 1) }, '＋'))),
        h('div', { class: 'mini-btns grid2' },
          h('button', { onclick: (() => { let taps = []; return () => { const now = performance.now(); taps = taps.filter((t) => now - t < 3000); taps.push(now); if (taps.length >= 3) setBpm(60000 / ((taps[taps.length - 1] - taps[0]) / (taps.length - 1))); }; })() }, 'タップで測る'),
          h('button', { disabled: !backing, onclick: async () => { if (!backing) return; busy('テンポを判定中…'); await autoBpm(backing, false); busy(false); render(); } }, '伴奏から自動判定')),
        h('div', { class: 'actions' }, h('button', { class: 'big-btn ghost', onclick: close }, '閉じる')));
    };
    render();
  }, { onClose: () => renderSheet() });
}

// ---------------- lyrics / memo ----------------
function renderLyrics() {
  const b = $('lpBody');
  b.innerHTML = '';
  if (project.memo && project.memo.trim()) b.textContent = project.memo;
  else b.append(h('span', { class: 'empty' }, '✎ から歌詞やメモを入力できます。'));
}
function editMemo() {
  openModal((c, close) => {
    const ta = h('textarea', { class: 'memo', placeholder: '歌詞やメモ（録音中に表示されます）' });
    ta.value = project.memo || '';
    c.append(h('h3', {}, '歌詞・メモ'), ta, h('div', { class: 'actions' },
      h('button', { class: 'big-btn primary', onclick: () => { project.memo = ta.value; saveProject(); renderLyrics(); $('lyricsPane').classList.remove('hidden'); refreshHead(); close(); } }, '保存して表示'),
      h('button', { class: 'big-btn ghost', onclick: close }, 'キャンセル')));
  }, { sticky: true });
}

// ---------------- auto MIX ----------------
// Style templates modelled on common 歌ってみた / VTuber mix tendencies (no specific artist).
const AUTO_MIX = {
  vtuber: { name: 'VTuber王道', desc: 'キラキラ明るく、歌が主役', main: 'vtuber', harm: 'harm_bright', back: 'b_space', gv: 'gv_front', gb: 'gb_space', gm: 'gm_loud', reverb: 'plate', delay: '1/8', fb: 0.3, pp: true, center: 0.85, drift: 0.3, lu: 1.5, harmony: true },
  idol: { name: 'かわいいアイドル', desc: '軽やかで華やかなハモリ', main: 'kawaii', harm: 'harm_wide', back: 'b_bright', gv: 'gv_shine', gb: 'gb_space', gm: 'gm_clear', reverb: 'plate', delay: '1/8.', fb: 0.3, pp: true, center: 0.9, drift: 0.35, lu: 1.5, harmony: true },
  rock: { name: '歌い手ロック', desc: '芯のある力強い声とバンド感', main: 'rock', harm: 'harmony', back: 'b_glue', gv: 'gv_glue', gb: 'gb_punch', gm: 'gm_loud', reverb: 'room', delay: '1/4', fb: 0.25, pp: false, center: 0.75, drift: 0.2, lu: -0.5, harmony: false },
  ballad: { name: 'しっとりバラード', desc: '広い響きで柔らかく', main: 'ballad', harm: 'harm_far', back: 'b_flat', gv: 'gv_shine', gb: 'gb_soft', gm: 'gm_natural', reverb: 'hall', delay: '1/4', fb: 0.35, pp: false, center: 0.75, drift: 0.2, lu: 0.8, harmony: false },
  natural: { name: 'ナチュラル', desc: '生っぽさを残して整える', main: 'natural', harm: 'harmony', back: 'b_space', gv: 'gv_glue', gb: 'gb_flat', gm: 'gm_natural', reverb: 'room', delay: '1/8', fb: 0.2, pp: false, center: 0.6, drift: 0.15, lu: 0.5, harmony: false },
  band: { name: 'バンド歌ってみた', desc: 'バンド音源に負けない太い歌', main: 'band', harm: 'harmony', back: 'b_band', gv: 'gv_front', gb: 'gb_band', gm: 'gm_video', reverb: 'room', delay: '1/8', fb: 0.22, pp: false, center: 0.75, drift: 0.2, lu: 0.5, harmony: false },
  edm: { name: 'ボカロ・EDM', desc: 'ケロケロ系オートチューン', main: 'vtuber', harm: 'harm_wide', back: 'b_bright', gv: 'gv_front', gb: 'gb_punch', gm: 'gm_loud', reverb: 'plate', delay: '1/16', fb: 0.35, pp: true, center: 1, drift: 0.5, tune: { speedMs: 0, strength: 1 }, lu: 0.5, harmony: false },
};
// ---- auto MIX with live preview: tap a style → hear it → 確定 で本番の処理 ----
function mixSnapshot() {
  return { tracks: project.tracks.map((t) => ({ id: t.id, fx: clone(t.fx), vol: t.vol, pan: t.pan, clipGain: t.clipGain })), groups: clone(project.groups), bus: clone(project.bus) };
}
function mixRestore(sn) {
  for (const s0 of sn.tracks) { const t = project.tracks.find((x) => x.id === s0.id); if (t) Object.assign(t, { fx: s0.fx, vol: s0.vol, pan: s0.pan, clipGain: s0.clipGain }); }
  project.groups = sn.groups; project.bus = sn.bus;
}
async function applyMixPreview(key, sn) {
  const tpl = AUTO_MIX[key];
  mixRestore(clone(sn));
  for (const tr of project.tracks) {
    if (!tr.audioId) continue;
    if (tr.kind === 'backing') { tr.fx = fxFromPreset(tpl.back); tr.vol = 0; }
    else { tr.fx = fxFromPreset(tr.kind === 'vocal' ? tpl.main : tpl.harm); if (tr.kind === 'vocal') tr.vol = 0; }
    await autoLevel(tr, true);
  }
  project.tracks.filter((t) => t.kind === 'harmony').forEach((t, i) => { t.pan = i % 2 ? 0.35 : -0.35; t.vol = -6; });
  const G = project.groups;
  G.vocal.fx = fxFromPreset(tpl.gv); G.backing.fx = fxFromPreset(tpl.gb); G.master.fx = fxFromPreset(tpl.gm); G.master.limiter = true; G.master.vol = 0;
  project.bus.reverb.type = tpl.reverb; project.bus.delay.note = tpl.delay; project.bus.delay.feedback = tpl.fb; project.bus.delay.pingpong = tpl.pp;
  const hasB = project.tracks.some((t) => t.kind === 'backing' && t.audioId && !t.mute);
  if (hasB) {
    const from = vocalWindowStart();
    const lv = await measureGroup((t) => isVox(t) && !t.mute, from);
    const lb = await measureGroup((t) => t.kind === 'backing' && !t.mute, from);
    if (isFinite(lv) && isFinite(lb)) { G.backing.vol = 0; G.vocal.vol = Math.max(-15, Math.min(15, Math.round((tpl.lu - (lv - lb)) * 2) / 2)); }
  }
}
function autoMixSheet() {
  if (!project.tracks.some((t) => t.kind === 'vocal' && t.audioId)) { toast('メインボーカルの音声が必要です'); return; }
  stopAll(); bgStop();
  const st = { tpl: null, clean: true, pitch: true, harm: null, token: 0, loading: false };
  const snap = mixSnapshot();
  const startPos = Math.max(0, vocalWindowStart() - 1.5);
  previewing = true;
  let finished = false;
  const finish = (apply) => {
    if (finished) return; finished = true;
    st.token++;
    engine.stop(); updateTransportUI();
    mixRestore(snap);
    previewing = false;
    engine.updateBus(project); engine.updateGroups(project);
    drawTimeline();
    if (apply) runAutoMix(apply.tpl, apply.opt);
  };
  const choose = async (k, render) => {
    st.tpl = k; st.harm = null; st.loading = true; render();
    const my = ++st.token;
    try { await applyMixPreview(k, snap); } catch (e) { console.error(e); }
    if (my !== st.token) return;
    st.loading = false;
    engine.ensure();
    playFrom(engine.playing ? engine.position : startPos, null);
    render();
  };
  openModal((c, close) => {
    const render = () => {
      c.innerHTML = '';
      const tpl = st.tpl ? AUTO_MIX[st.tpl] : null;
      const harmOn = !tpl ? false : st.harm == null ? tpl.harmony && !project.tracks.some((t) => t.kind === 'harmony') : st.harm;
      const grid = h('div', { class: 'preset-grid two' });
      for (const [k, t] of Object.entries(AUTO_MIX)) grid.append(h('button', { class: st.tpl === k ? 'on' : '', onclick: () => choose(k, render) }, h('b', {}, t.name), h('small', {}, t.desc)));
      const state = st.loading ? '準備中…' : !tpl ? 'スタイルをタップすると試聴できます' : engine.playing ? `▶ 「${tpl.name}」を試聴中` : `「${tpl.name}」を選択中`;
      c.append(h('h3', {}, '✨ 自動MIX'),
        h('p', {}, 'スタイルをタップすると、その場でエフェクトとバランスを試聴できます。「確定」で、ノイズ除去・ピッチ補正・ハモリ・音圧まで本番の処理をします。'),
        grid,
        h('div', { class: 'preview-bar' },
          h('span', { class: 'pv-state' }, state),
          tpl ? h('button', { class: 'pill', onclick: () => { if (engine.playing) { engine.stop(); updateTransportUI(); } else { engine.ensure(); playFrom(startPos, null); } render(); } }, engine.playing ? '■ 停止' : '▶ 試聴') : null),
        h('p', { class: 'note' }, '試聴ではエフェクト・音量バランスの雰囲気を確認できます（ピッチ補正・ノイズ除去・ハモリ作成は確定後に反映されます）。'),
        tpl ? switchRow('ノイズ・リップノイズ除去', st.clean, (v) => { st.clean = v; }) : null,
        tpl ? switchRow(tpl.tune ? 'オートチューン（ケロケロ）' : 'ピッチ補正', st.pitch, (v) => { st.pitch = v; }) : null,
        tpl ? switchRow('ハモリも作る（3度上）', harmOn, (v) => { st.harm = v; }) : null,
        h('div', { class: 'actions' },
          h('button', { class: 'big-btn primary', disabled: !tpl || st.loading ? '' : null, onclick: () => { if (!tpl || st.loading) return; const k = st.tpl, opt = { clean: st.clean, pitch: st.pitch, harm: harmOn }; finish({ tpl: k, opt }); close(); } }, tpl ? `「${tpl.name}」で確定` : 'スタイルを選んでください'),
          h('button', { class: 'big-btn ghost', onclick: () => { close(); } }, 'キャンセル（元に戻す）')));
    };
    render();
  }, { onClose: () => finish(null) });
}
async function runAutoMix(key, opt) {
  const tpl = AUTO_MIX[key];
  stopAll(); bgStop();
  const done = [];
  try {
    const backing = project.tracks.find((t) => t.kind === 'backing');
    if (backing) { busy('テンポを判定中…', 0.02); const b = await autoBpm(backing, true); if (b) done.push(`テンポ ${b} BPM`); }
    const mains = project.tracks.filter((t) => t.kind === 'vocal' && t.audioId);
    for (let i = 0; i < mains.length; i++) {
      busy(`ボーカルを解析中…（${i + 1}/${mains.length}）`, 0.05 + 0.25 * i / mains.length);
      await ensureTrackNotes(mains[i], (p) => busy(`ボーカルを解析中…（${i + 1}/${mains.length}）`, 0.05 + 0.25 * (i + p) / mains.length));
    }
    if (project.key.auto) { busy('キーを判定中…', 0.32); await detectKey(true); refreshHead(); done.push(`キー ${keyLabel(project.key)}`); }
    for (const tr of project.tracks) {
      if (!tr.audioId) continue;
      if (tr.kind === 'backing') { tr.fx = fxFromPreset(tpl.back); tr.vol = 0; continue; }
      tr.fx = fxFromPreset(tr.kind === 'vocal' ? tpl.main : tpl.harm);
      if (opt.clean && !tr.harmonyOf) { tr.clean.on = true; tr.clean.auto = true; }
      if (tr.kind === 'vocal') {
        tr.vol = 0;
        if (opt.pitch) {
          if (tpl.tune) { tr.pitch.tuneOn = true; tr.pitch.tune = clone(tpl.tune); tr.pitch.enabled = true; }
          else { tr.pitch.tuneOn = false; await autoCorrect(tr, tpl.center, tpl.drift, null, true); }
        }
      }
      await autoLevel(tr, true);
    }
    if (opt.clean) done.push('ノイズ除去');
    if (opt.pitch) done.push(tpl.tune ? 'オートチューン' : 'ピッチ補正');
    if (opt.harm && mains[0] && project.tracks.length < MAX_TRACKS) {
      await generateHarmony(mains[0], [{ type: 'scale', steps: 2 }], true);
      project.tracks.filter((t) => t.kind === 'harmony').forEach((t) => { t.fx = fxFromPreset(tpl.harm); });
      done.push('ハモリ作成');
    }
    // harmonies: spread left / right
    project.tracks.filter((t) => t.kind === 'harmony').forEach((t, i) => { t.pan = i % 2 ? 0.35 : -0.35; t.vol = -6; });
    const G = project.groups;
    G.vocal.fx = fxFromPreset(tpl.gv); G.backing.fx = fxFromPreset(tpl.gb); G.master.fx = fxFromPreset(tpl.gm); G.master.limiter = true; G.master.vol = 0;
    project.bus.reverb.type = tpl.reverb; project.bus.delay.note = tpl.delay; project.bus.delay.feedback = tpl.fb; project.bus.delay.pingpong = tpl.pp;
    done.push('エフェクト');
    for (let i = 0; i < project.tracks.length; i++) {
      const tr = project.tracks[i];
      if (!needsProcessing(tr)) continue;
      busy(`音声を処理中…（${i + 1}/${project.tracks.length}）`, 0.45 + 0.35 * i / project.tracks.length);
      await processTrack(tr, (p) => busy(`音声を処理中…（${i + 1}/${project.tracks.length}）`, 0.45 + 0.35 * (i + p) / project.tracks.length));
    }
    await autoBalance(tpl.lu, true);
    G.balanceTpl = null;
    done.push('バランス');
    project.lastAutoMix = key;
    project.exportFinal = tpl.gm === 'gm_video' ? 'video' : 'stream';
    busy(false);
    saveProject(); refreshStudio();
    infoModal(`「${tpl.name}」でMIXしました`, `<p>${done.join(' → ')}</p><p>▶ で聴いてみてください。気になるところは各トラックや「ボーカル類」「音源」「マスター」のトラックで調整できます。書き出しは「配信向け（-14 LUFS）」がおすすめです。</p>`);
  } catch (e) {
    busy(false);
    console.error(e);
    infoModal('自動MIXを完了できませんでした', String(e.message || e));
  }
}

// ---------------- export ----------------
const FINALS = [
  { id: 'none', name: 'そのまま', target: null, ceil: -1, desc: '音量は変えずに、音割れだけ防ぎます。' },
  { id: 'stream', name: '配信向け -14', target: -14, ceil: -1, desc: 'Spotify・Apple Music などの基準（-14 LUFS）。' },
  { id: 'video', name: '歌ってみた動画 -11', target: -11, ceil: -1, desc: 'YouTube・ニコニコの歌ってみた動画で多い大きさ（-11 LUFS）。' },
  { id: 'loud', name: '大きめ -10', target: -10, ceil: -1, desc: '迫力重視（-10 LUFS）。' },
  { id: 'cd', name: 'CD仕様 -9', target: -9, ceil: -0.3, desc: 'CD向けの大きめの音圧（-9 LUFS）・44.1kHz/16bit で書き出します。' },
];
function exportSheet() {
  if (!project.tracks.length) { toast('トラックがありません'); return; }
  const st = { what: 'mix', bits: project.exportFinal === 'cd' ? 16 : 24, final: project.exportFinal || 'stream' };
  openModal((c, close) => {
    const render = () => {
      c.innerHTML = '';
      const has = (k) => project.tracks.some((t) => t.kind === k);
      const opts = [['mix', 'ミックス'], has('vocal') && ['main', 'メインだけ'], has('harmony') && ['harm', 'ハモリだけ'], (has('vocal') || has('harmony')) && ['vox', 'ボーカル全部'], has('backing') && ['back', '伴奏だけ'], selTrack() && ['sel', '選択中のトラック']].filter(Boolean);
      c.append(h('h3', {}, '書き出し'),
        h('div', { class: 'lbl-line' }, '内容'), chips(opts, st.what, (v) => { st.what = v; render(); }),
        h('div', { class: 'lbl-line' }, '音量の仕上げ'),
        chips(FINALS.map((f) => [f.id, f.name]), st.final, (v) => { st.final = v; if (v === 'cd') st.bits = 16; render(); }),
        h('p', { class: 'note', style: 'margin:2px 0 6px' }, (FINALS.find((f) => f.id === st.final) || FINALS[0]).desc),
        h('div', { class: 'lbl-line' }, '形式'),
        st.final === 'cd' ? h('p', { class: 'note' }, 'WAV 44.1kHz / 16bit（CDと同じ形式）') : chips([[24, 'WAV 24bit'], [16, 'WAV 16bit']], st.bits, (v) => { st.bits = v; render(); }),
        h('div', { class: 'actions' },
          h('button', { class: 'big-btn primary', onclick: () => { close(); doExport(st); } }, '書き出す'),
          h('button', { class: 'big-btn ghost', onclick: close }, 'キャンセル')));
    };
    render();
  });
}
async function doExport(st) {
  stopAll(); bgStop();
  const sel = selTrack();
  const anySolo = project.tracks.some((x) => x.solo);
  const include = { mix: (t) => !t.mute && (!anySolo || t.solo), main: (t) => t.kind === 'vocal' && !t.mute, harm: (t) => t.kind === 'harmony' && !t.mute,
    vox: (t) => isVox(t) && !t.mute, back: (t) => t.kind === 'backing' && !t.mute, sel: (t) => t.id === (sel && sel.id) }[st.what];
  const todo = project.tracks.filter((tr) => include(tr) && needsProcessing(tr) && !processed.has(tr.id));
  for (let i = 0; i < todo.length; i++) { busy(`音声を準備中…（${i + 1}/${todo.length}）`, i / todo.length); await processTrack(todo[i], (p) => busy(`音声を準備中…（${i + 1}/${todo.length}）`, (i + p) / todo.length)); }
  const fin = FINALS.find((f) => f.id === st.final) || FINALS[0];
  busy('書き出し中…', 0);
  const live = engine.ensure();
  try { await live.suspend(); } catch (e) { /* ignore */ }
  try {
    const sr = st.final === 'cd' ? 44100 : live.sampleRate;
    const bits = st.final === 'cd' ? 16 : st.bits;
    const out = await renderMix(project, bufferFor, sr, include, (p, sec) => busy(`書き出し中… ${Math.round(p * 100)}%（${Math.round(sec || 0)}秒）`, p * 0.85), { segment: 30 });
    const L = out.L, R = out.R;
    const target = fin.target;
    busy('音量を仕上げ中…', 0.85);
    await new Promise((r) => setTimeout(r, 30));
    let before = null, gainDb = 0;
    if (target != null) { before = DSP.loudness([L, R], sr); gainDb = Math.max(-20, Math.min(24, target - before)); }
    busy('音量を仕上げ中…', 0.9);
    await new Promise((r) => setTimeout(r, 30));
    DSP.limit([L, R], sr, fin.ceil, gainDb);
    busy('ファイルを作成中…', 0.96);
    await new Promise((r) => setTimeout(r, 30));
    const blob = encodeWav([L, R], sr, bits);
    busy(false);
    try { live.resume(); } catch (e) { /* ignore */ }
    const suffix = { mix: '', main: '_main', harm: '_harmony', vox: '_vocals', back: '_backing', sel: '_' + (sel ? sel.name : '') }[st.what];
    offerFile(blob, safeName(project.name + suffix) + '.wav', '書き出しが完了しました',
      `${fmtTime(L.length / sr)} · ${(blob.size / 1048576).toFixed(1)} MB` + (before != null ? ` · ${before.toFixed(1)} → ${target} LUFS` : ''));
  } catch (e) { busy(false); try { live.resume(); } catch (e2) { /* ignore */ } console.error(e); infoModal('書き出しに失敗しました', String(e.message || e)); }
}
function safeName(s) { return s.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || 'utamix'; }
function offerFile(blob, filename, title, sub) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  const canShare = !!(navigator.share && (!navigator.canShare || navigator.canShare({ files: [file] })));
  const download = () => {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  const share = async () => {
    if (!canShare) { download(); return; }
    try { await navigator.share({ files: [file] }); }
    catch (e) { if (e && e.name === 'AbortError') return; if (e && e.name === 'NotAllowedError') { toast('もう一度「共有」を押してください'); return; } download(); }
  };
  openModal((c, close) => {
    c.append(h('h3', {}, title), h('p', {}, filename + (sub ? ' · ' + sub : '')),
      h('div', { class: 'actions' },
        h('button', { class: 'big-btn primary', onclick: share }, canShare ? '⇪ 共有（保存・送信）' : 'ダウンロード'),
        h('p', { class: 'note', style: 'margin:0' }, canShare ? '共有メニューから「“ファイル”に保存」・LINE・AirDrop などを選べます。' : ''),
        canShare ? h('button', { class: 'big-btn ghost', onclick: download }, 'ダウンロードとして保存') : null,
        h('button', { class: 'big-btn ghost', onclick: close }, '閉じる')));
  }, { sticky: true });
  // try to open the share sheet right away (iPhone allows it only right after a tap, so the button stays as a backup)
  if (canShare && performance.now() - (window.__lastTap || 0) < 4500) navigator.share({ files: [file] }).catch(() => {});
}

// ---------------- backup ----------------
// one file containing every project (for moving to a new URL or keeping a safe copy)
async function exportAllBackup(list) {
  busy('バックアップを作成中…');
  try {
    const audios = [], parts = [];
    const seen = new Set();
    const pjs = [];
    for (const p of list) {
      const pj = clone(p);
      pj.tracks.forEach((t) => { delete t.cleanInfo; delete t.undo; });
      pjs.push(pj);
      for (const id of new Set(p.tracks.map((t) => t.audioId).filter(Boolean))) {
        if (seen.has(id)) continue;
        seen.add(id);
        const a = await Store.getAudio(id);
        if (!a) continue;
        audios.push({ id, sr: a.sr, nch: a.channels.length, len: a.channels[0].length });
        for (const ch of a.channels) parts.push(ch.buffer.byteLength === ch.length * 4 ? ch.buffer : ch.slice().buffer);
      }
    }
    const header = new TextEncoder().encode(JSON.stringify({ format: 'utamix', version: 4, projects: pjs, audios }));
    const pre = new ArrayBuffer(16), dv = new DataView(pre);
    'UTAMIX01'.split('').forEach((ch, i) => dv.setUint8(i, ch.charCodeAt(0)));
    dv.setUint32(8, header.length, true);
    const pad = (4 - ((16 + header.length) % 4)) % 4;
    dv.setUint32(12, pad, true);
    const blob = new Blob([pre, header, new Uint8Array(pad), ...parts], { type: 'application/octet-stream' });
    busy(false);
    const d = new Date();
    offerFile(blob, `UtaMix_all_${d.getMonth() + 1}-${d.getDate()}.utamix`, 'バックアップを作成しました', `${list.length}件 · ${(blob.size / 1048576).toFixed(1)} MB`);
  } catch (e) { busy(false); infoModal('バックアップに失敗しました', String(e.message || e)); }
}

async function exportBackup(p) {
  busy('バックアップを作成中…');
  try {
    const audios = [], parts = [];
    for (const id of new Set(p.tracks.map((t) => t.audioId).filter(Boolean))) {
      const a = await Store.getAudio(id);
      if (!a) continue;
      audios.push({ id, sr: a.sr, nch: a.channels.length, len: a.channels[0].length });
      for (const ch of a.channels) parts.push(ch.buffer.byteLength === ch.length * 4 ? ch.buffer : ch.slice().buffer);
    }
    const pj = clone(p);
    pj.tracks.forEach((t) => { delete t.cleanInfo; delete t.undo; });
    const header = new TextEncoder().encode(JSON.stringify({ format: 'utamix', version: 3, project: pj, audios }));
    const pre = new ArrayBuffer(16), dv = new DataView(pre);
    'UTAMIX01'.split('').forEach((ch, i) => dv.setUint8(i, ch.charCodeAt(0)));
    dv.setUint32(8, header.length, true);
    const pad = (4 - ((16 + header.length) % 4)) % 4;
    dv.setUint32(12, pad, true);
    const blob = new Blob([pre, header, new Uint8Array(pad), ...parts], { type: 'application/octet-stream' });
    busy(false);
    offerFile(blob, safeName(p.name) + '.utamix', 'バックアップを作成しました', `${(blob.size / 1048576).toFixed(1)} MB`);
  } catch (e) { busy(false); infoModal('バックアップに失敗しました', String(e.message || e)); }
}
async function importBackup(file) {
  busy('バックアップを読み込み中…');
  try {
    const ab = await file.arrayBuffer();
    const dv = new DataView(ab);
    if (String.fromCharCode(...new Uint8Array(ab, 0, 8)) !== 'UTAMIX01') throw new Error('UtaMixのバックアップファイルではありません');
    const hl = dv.getUint32(8, true), pad = dv.getUint32(12, true);
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 16, hl)));
    let o = 16 + hl + pad;
    const remap = new Map();
    for (const a of meta.audios) {
      const channels = [];
      for (let c = 0; c < a.nch; c++) { if (o + a.len * 4 > ab.byteLength) throw new Error('ファイルが壊れています'); channels.push(new Float32Array(ab.slice(o, o + a.len * 4))); o += a.len * 4; }
      const nid = uid();
      remap.set(a.id, nid);
      await Store.putAudio({ id: nid, sr: a.sr, channels });
    }
    const list = meta.projects || [meta.project];
    for (const p of list) {
      p.id = uid(); p.updatedAt = Date.now();
      const tmap = new Map();
      p.tracks.forEach((t) => { const nid = uid(); tmap.set(t.id, nid); t.id = nid; t.audioId = t.audioId ? remap.get(t.audioId) : null; delete t.undo; });
      p.tracks.forEach((t) => { if (t.harmonyOf) t.harmonyOf = tmap.get(t.harmonyOf) || null; });
      p.tracks = p.tracks.filter((t) => t.audioId !== undefined);
      p.audioPool = [...new Set(p.tracks.map((t) => t.audioId).filter(Boolean))];
      await Store.putProject(p);
    }
    busy(false); toast(`${list.length}件のプロジェクトを読み込みました`); showHome();
  } catch (e) { busy(false); infoModal('読み込めませんでした', String(e.message || e)); }
}

// ---------------- menus ----------------
function studioMenu() {
  openModal((c, close) => {
    c.append(h('h3', {}, project.name), h('div', { class: 'actions' },
      h('button', { class: 'big-btn primary', onclick: () => { close(); exportSheet(); } }, '書き出し（WAV）'),
      h('button', { class: 'big-btn', onclick: async () => { close(); const n = await promptModal('別名で保存', project.name + ' のコピー', '保存'); if (!n) return; await flushSave(); const np = await duplicateProject(project, n); if (np) openProject(np.id); } }, '別名で保存'),
      h('button', { class: 'big-btn', onclick: async () => { close(); const n = await promptModal('プロジェクト名', project.name); if (n) { project.name = n; saveProject(); refreshStudio(); } } }, '名前を変更'),
      h('button', { class: 'big-btn', onclick: () => { close(); recordSettings(); } }, '録音の設定'),
      h('button', { class: 'big-btn', onclick: () => { close(); if (bg.playing) bgStop(); else bgStart(); } }, bg.playing ? 'バックグラウンド再生を止める' : 'バックグラウンド再生（画面オフで聴く）'),
      h('button', { class: 'big-btn', onclick: async () => { close(); await flushSave(); exportBackup(project); } }, 'バックアップファイルを保存'),
      h('button', { class: 'big-btn', onclick: () => { close(); aboutModal(); } }, '使い方・安全性'),
      h('button', { class: 'big-btn ghost', onclick: close }, '閉じる')));
  });
}
function recordSettings() {
  openModal((c, close) => {
    const render = () => {
      c.innerHTML = '';
      c.append(h('h3', {}, '録音の設定'),
        h('div', { class: 'lbl-line' }, '録音先'),
        chips([['auto', '続けて録音（おすすめ）'], ['newVocal', '次は新規メイン'], ['newHarmony', '次は新規ハモリ']], settings.recTarget, (v) => { settings.recTarget = v; saveSettings(); refreshHead(); render(); }),
        h('p', { class: 'note' }, '「続けて録音」：選んでいるボーカル（選んでいなければ最後に録ったトラック）に、再生位置から録音します。トラックは増えません。「次は新規」は1回録ると自動で「続けて録音」に戻ります。'),
        h('div', { class: 'lbl-line' }, 'プリロール（録音前に戻って流す秒数）'),
        chips([[0, 'なし'], [2, '2秒'], [4, '4秒']], settings.preroll, (v) => { settings.preroll = v; saveSettings(); render(); }),
        h('div', { class: 'lbl-line' }, 'イヤホン（ズレ補正）'),
        chips([['wired', '有線'], ['bt', 'Bluetooth'], ['manual', '手動']], settings.latencyMode, (v) => { settings.latencyMode = v; saveSettings(); render(); }),
        settings.latencyMode === 'bt' ? slider({ label: 'BT遅延', min: 50, max: 400, step: 5, value: settings.btMs, fmt: (v) => v + ' ms', oninput: (v) => { settings.btMs = v; saveSettings(); } }) : null,
        settings.latencyMode === 'manual' ? slider({ label: '補正量', min: 0, max: 400, step: 1, value: settings.latencyMs, fmt: (v) => v + ' ms', oninput: (v) => { settings.latencyMs = v; saveSettings(); } }) : null,
        switchRow('自分の声をイヤホンで聴く', settings.monitor, (v) => { settings.monitor = v; saveSettings(); }),
        h('div', { class: 'lbl-line' }, '使うマイク'),
        micBox,
        h('p', { class: 'note' }, '音質のコツ：AirPodsなどBluetoothイヤホンを付けたまま録ると、iPhoneが「通話用の低音質マイク」に切り替わり、伴奏も声もこもります。有線イヤホン（またはLightning/USB-C変換）＋「iPhoneのマイク」がいちばんきれいに録れます。録音中は画面の再生処理を軽くして音飛びを防いでいます。'),
        h('div', { class: 'actions' }, h('button', { class: 'big-btn ghost', onclick: close }, '閉じる')));
    };
    const micBox = h('div', { class: 'mic-list' });
    const fillMics = async (ask) => {
      micBox.innerHTML = '';
      let devs = [];
      try {
        if (ask) { const st = await navigator.mediaDevices.getUserMedia({ audio: true }); st.getTracks().forEach((t) => t.stop()); }
        devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
      } catch (e) { devs = []; }
      const pick = (id) => { settings.micId = id; saveSettings(); fillMics(false); };
      micBox.append(h('button', { class: !settings.micId ? 'on' : '', onclick: () => pick('') }, '自動（iPhoneにおまかせ）'));
      const labeled = devs.filter((d) => d.label);
      for (const d of labeled) {
        const bt = /bluetooth|airpods|hands-?free|hfp|buds|beats/i.test(d.label);
        micBox.append(h('button', { class: settings.micId === d.deviceId ? 'on' : '', onclick: () => pick(d.deviceId) }, d.label + (bt ? '（Bluetooth：音質低め）' : '')));
      }
      if (!labeled.length) micBox.append(h('button', { onclick: () => fillMics(true) }, 'マイク一覧を読み込む…'));
    };
    render();
    fillMics(false);
  });
}
function addTrackMenu() {
  openModal((c, close) => {
    const full = project.tracks.length >= MAX_TRACKS;
    const ch = (ic, t, sub, fn, dis) => h('button', { class: 'choice', style: dis ? 'opacity:.4' : '', onclick: () => { if (dis) { toast(`トラックは最大${MAX_TRACKS}本までです`); return; } close(); fn(); } }, h('span', { class: 'ic' }, ic), h('div', {}, h('b', {}, t), h('small', {}, sub)));
    c.append(h('h3', {}, 'トラックを追加'),
      ch('📁', '音源を読み込む', 'WAV・MP3・M4A・動画など（複数可）', () => $('fileAudio').click(), full),
      ch('🎤', '新しいボーカルトラックを追加', '録音は ● を押したときだけ始まります', () => addEmptyTrack('vocal'), full),
      ch('🎶', '新しいハモリトラックを追加', '録音は ● を押したときだけ始まります', () => addEmptyTrack('harmony'), full),
      trackClip ? ch('📋', 'コピーしたトラックを貼り付け', trackClip.track.name, pasteTrack, full) : null,
      h('div', { class: 'actions' }, h('button', { class: 'big-btn ghost', onclick: close }, 'キャンセル')));
  });
}
function addEmptyTrack(kind) {
  const n = project.tracks.filter((t) => t.kind === kind && !t.harmonyOf).length + 1;
  const tr = makeTrack(kind, null, (kind === 'harmony' ? 'ハモリ ' : 'ボーカル ') + n);
  tr.offset = engine.position;
  tr.clips = [];
  project.tracks.push(tr);
  selectedId = tr.id;
  settings.recTarget = 'auto'; saveSettings();
  saveProject(); refreshStudio();
  TL.scrollY = Math.max(0, project.tracks.length * LANE_H - TL.h + 20); clampScroll(); renderLaneHeads(); drawTimeline();
  toast('トラックを追加しました。トラックの ● か下の ● で録音できます', 3000);
}

function aboutModal() {
  const standalone = window.navigator.standalone || window.matchMedia('(display-mode: standalone)').matches;
  infoModal('使い方・安全性', `
    <p><b>かんたんな流れ</b><br>① 伴奏とボーカルを読み込む／録音する → ② 上の「✨自動MIX」→ ③ 気になる所を調整 → ④ 書き出し</p>
    <p><b>続きから録音</b><br>ボーカルのトラックを選んだまま、録りたい位置で ● を押すと、そのトラックに上書きで録音します。</p>
    <p><b>安全性</b><br>録音・音源はこのiPhoneの中だけに保存されます。外部への送信、アカウント、広告、解析ツールはありません。</p>
    <p><b>バージョン</b><br>UtaMix ${APP_VERSION}（更新後は一度アプリを完全に閉じて開き直すと確実に反映されます）</p>
    <p><b>注意</b><br>${standalone ? 'ホーム画面から起動中です。' : '共有ボタン →「ホーム画面に追加」してから使ってください。'} 大切なプロジェクトは「⋯ → バックアップファイルを保存」で残せます。</p>`);
}

// ---------------- pitch editor bridge ----------------
let pitchEditor = null;
function pickTrack(title, currentId, allowNone, cb, excludeId) {
  openModal((c, close) => {
    const list = h('div', { class: 'pick-list' });
    if (allowNone) list.append(h('button', { class: !currentId ? 'on' : '', onclick: () => { close(); cb(null); } }, h('span', { class: 'sw', style: 'background:#3a414e' }), 'なし'));
    for (const t of project.tracks) {
      if (!isVox(t) || t.id === excludeId) continue;
      list.append(h('button', { class: t.id === currentId ? 'on' : '', onclick: () => { close(); cb(t); } },
        h('span', { class: 'sw', style: `background:${t.color}` }), h('span', { style: 'flex:1' }, t.name), h('small', { class: 'note' }, KIND_LABEL[t.kind])));
    }
    c.append(h('h3', {}, title), list, h('div', { class: 'actions' }, h('button', { class: 'big-btn ghost', onclick: close }, '閉じる')));
  });
}
function editorKeySheet(after) {
  openModal((c, close) => {
    c.append(h('h3', {}, 'キー'), keyBar(() => { after && after(); }), h('div', { class: 'actions' }, h('button', { class: 'big-btn ghost', onclick: close }, '閉じる')));
  }, { onClose: () => { after && after(); } });
}
async function editorOpenTrack(t) {
  engine.stop(); updateTransportUI();
  busy('音程を解析中…', 0);
  try { await ensureTrackNotes(t, (p) => busy('音程を解析中…', p)); } catch (e) { busy(false); toast('解析に失敗しました'); return; }
  busy(false);
  if (!t.pitch.enabled) { t.pitch.enabled = true; saveProject(); processTrack(t); }
  selectedId = t.id;
  setView('pitch');
  pitchEditor.open(t);
}
function openPitchEditor(tr) {
  if (!pitchEditor) {
    pitchEditor = new PitchEditor({
      root: $('pitch'), getProject: () => project, analysisOf: (t) => analyses.get(t.audioId), ensureNotes: (t) => ensureTrackNotes(t),
      schedulePitchRender: scheduleProcess, onRenderState: onProcState, saveProject, autoCorrect, noteNames: NOTE_NAMES, keyLabel,
      pickTrack, openTrack: editorOpenTrack, keySheet: editorKeySheet, ensureKey, tl, au,
      follow: () => settings.follow !== false, setFollow: (v) => { settings.follow = v; saveSettings(); refreshHead(); },
      play: (t, withBacking, from) => {
        engine.ensure();
        if (engine.playing) { engine.stop(); updateTransportUI(); return; }
        playFrom(from != null ? from : engine.position, withBacking ? (x) => x.id === t.id || x.kind === 'backing' : (x) => x.id === t.id);
      },
      stop: () => { engine.stop(); updateTransportUI(); },
      seek: (pos) => { if (engine.playing) playFrom(pos, currentPlayFilter); else engine.seek(pos); },
      isPlaying: () => engine.playing,
      close: () => { engine.stop(); updateTransportUI(); setView('studio'); renderLaneHeads(); renderSheet(); refreshHead(); drawTimeline(); },
      toast,
    });
  }
  stopAll(); bgStop();
  editorOpenTrack(tr);
}

// ---------------- wiring ----------------
$('btnNewProject').onclick = newProject;
$('appVer').textContent = 'UtaMix ' + APP_VERSION;
$('btnImportBackup').onclick = () => $('fileBackup').click();
$('btnAbout').onclick = aboutModal;
$('btnBack').onclick = () => showHome();
$('projName').onclick = async () => { const n = await promptModal('プロジェクト名', project.name); if (n) { project.name = n; saveProject(); refreshStudio(); } };
$('btnSave').onclick = async () => { await flushSave(); toast('保存しました'); };
$('btnUndo').onclick = () => { if (!rec.active) undo(); };
$('btnRedo').onclick = () => { if (!rec.active) redo(); };
$('btnFollow').onclick = () => { settings.follow = settings.follow === false; saveSettings(); refreshHead(); toast(settings.follow ? '再生位置を自動で追いかけます' : '自動追尾をオフにしました', 1400); };
$('ebDone').onclick = () => deselectClip();
$('ebJoin').onclick = () => clipOp('join');
$('ebSplit').onclick = () => clipOp('split');
$('ebCutL').onclick = () => clipOp('cutL');
$('ebCutR').onclick = () => clipOp('cutR');
$('ebDup').onclick = () => clipOp('dup');
$('ebDel').onclick = () => clipOp('del');
$('ebSnap').onclick = () => { settings.clipSnap = !settings.clipSnap; saveSettings(); ebState = ''; updateEditBar(); };
$('btnAuto').onclick = autoMixSheet;
$('btnKey').onclick = keySheet;
$('btnLyrics').onclick = () => { if (!project.memo) { editMemo(); return; } $('lyricsPane').classList.toggle('hidden'); refreshHead(); };
$('lpEdit').onclick = editMemo;
$('lpClose').onclick = () => { $('lyricsPane').classList.add('hidden'); refreshHead(); };
$('btnRecTarget').onclick = recordSettings;
$('bgToggle').onclick = () => { if (bgAudio.paused) bgAudio.play().catch(() => {}); else bgAudio.pause(); };
$('bgStop').onclick = bgStop;
$('btnMenu').onclick = studioMenu;
$('btnExport').onclick = exportSheet;
$('btnAddFirst').onclick = () => $('fileAudio').click();
$('btnAddTrack').onclick = addTrackMenu;
$('btnHome').onclick = () => { if (rec.active) return; if (engine.playing) playFrom(0, currentPlayFilter); else engine.seek(0); TL.scrollX = Math.min(TL.scrollX, 0); drawTimeline(); };
$('btnPlay').onclick = () => togglePlay();
$('btnRec').onclick = () => { if (rec.active) stopRecording(); else startRecording(); };
$('tsClose').onclick = () => { sheetOpen = false; renderSheet(); };
$('tsPrev').onclick = () => stepTrack(-1);
$('tsNext').onclick = () => stepTrack(1);
$('tsTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; sheetTab = b.dataset.tab; renderSheet(); });
$('sheetGrip').onclick = () => { $('trackSheet').classList.toggle('tall'); };
$('fileAudio').addEventListener('change', (e) => { const fs = [...e.target.files]; e.target.value = ''; if (fs.length && project) importFiles(fs); });
$('fileBackup').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importBackup(f); });
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
document.addEventListener('pointerdown', () => { window.__lastTap = performance.now(); }, true);
document.addEventListener('pointerdown', () => { if (engine.ctx && engine.ctx.state !== 'running') engine.ctx.resume().catch(() => {}); }, true);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { flushSave(); if (rec.active) rec.hiddenAt = performance.now(); return; }
  keepAwake();
  // back from the background: if iOS paused the mic, keep what was recorded
  if (rec.active && rec.hiddenAt) {
    const stalled = performance.now() - (rec.lastChunkAt || 0) > 1500 || (engine.ctx && engine.ctx.state !== 'running');
    rec.hiddenAt = 0;
    if (stalled) { stopRecording(); toast('画面ロック中にiPhoneが録音を止めたため、そこまでを保存しました', 4000); }
  }
});
window.addEventListener('pagehide', () => { flushSave(); });
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
    reg.update().catch(() => {});
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !rec.active) reg.update().catch(() => {}); });
  }).catch(() => {});
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloading) return;
    if (!project && !rec.active) { reloading = true; location.reload(); }
    else { window.__utamixUpdateReady = true; toast('新しいバージョンがあります。ホームに戻ると更新されます', 4000); }
  });
}
requestAnimationFrame(loop);
showHome();
