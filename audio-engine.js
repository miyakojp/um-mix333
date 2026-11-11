// UtaMix audio engine — Web Audio effects chain, group buses, master, playback and offline rendering.

const dbToGain = (db) => Math.pow(10, db / 20);
export { dbToGain };

export const EQ_LABELS = ['こもり', '鼻づまり', '抜け', '空気感'];
const EQ_LABELS_BACK = ['低音', '中低音', '中高音', '高音'];

function eqBands(a, b, c, d) {
  return [
    { type: 'peaking', f: a[0], g: a[1], q: 1.0, label: EQ_LABELS[0] },
    { type: 'peaking', f: b[0], g: b[1], q: 1.4, label: EQ_LABELS[1] },
    { type: 'peaking', f: c[0], g: c[1], q: 0.9, label: EQ_LABELS[2] },
    { type: 'highshelf', f: d[0], g: d[1], q: 0.7, label: EQ_LABELS[3] },
  ];
}
function eqBack(a, b, c, d) {
  return [
    { type: 'lowshelf', f: a[0], g: a[1], q: 0.7, label: EQ_LABELS_BACK[0] },
    { type: 'peaking', f: b[0], g: b[1], q: 1.0, label: EQ_LABELS_BACK[1] },
    { type: 'peaking', f: c[0], g: c[1], q: 1.2, label: EQ_LABELS_BACK[2] },
    { type: 'highshelf', f: d[0], g: d[1], q: 0.7, label: EQ_LABELS_BACK[3] },
  ];
}
const COMP_OFF = { on: false, threshold: -20, ratio: 2, attack: 20, release: 150, knee: 8 };
const comp = (threshold, ratio, attack, release, knee) => ({ on: true, threshold, ratio, attack, release, knee });
const NOCOLOR = { type: 'none', mix: 0 };
const V = (o) => Object.assign({ cat: 'vocal', group: 'std', gain: 0, sat: 0, doubler: 0, rev: 0.2, dly: 0.05, deess: { f: 6500, amount: 0.4 }, color: NOCOLOR }, o);
const HM = (o) => Object.assign({ cat: 'harmony', group: 'std', gain: 0, sat: 0, doubler: 0.2, rev: 0.34, dly: 0.1, deess: { f: 6200, amount: 0.7 }, color: NOCOLOR }, o);
const B = (o) => Object.assign({ cat: 'backing', group: 'std', gain: 0, sat: 0, doubler: 0, rev: 0, dly: 0, deess: { f: 6500, amount: 0 }, comp: COMP_OFF, color: NOCOLOR }, o);
const G = (cat, o) => Object.assign({ cat, group: 'std', gain: 0, sat: 0, doubler: 0, rev: 0, dly: 0, deess: { f: 6500, amount: 0 }, comp: COMP_OFF, color: NOCOLOR, hpf: 0 }, o);

// Vocal values follow common vocal-mix guidance: high-pass ~80-150 Hz, cut boxiness ~250-400 Hz,
// presence ~2.5-5 kHz, air shelf ~10-12 kHz, de-ess ~5-8 kHz, compressor ~2:1-4:1, 10-30 ms attack, 50-150 ms release.
export const PRESETS = {
  // ---- main vocal: 定番
  natural: V({ name: 'ナチュラル', desc: '素直にきれいに', hpf: 90, eq: eqBands([300, -2], [1000, 0], [3500, 2], [11000, 2]), deess: { f: 6500, amount: 0.35 }, comp: comp(-20, 3, 15, 120, 8), rev: 0.18 }),
  pop: V({ name: 'ポップ', desc: '明るく前に出る', hpf: 110, eq: eqBands([350, -3], [900, -1], [3200, 3], [12000, 4]), deess: { f: 6800, amount: 0.5 }, comp: comp(-24, 4, 10, 80, 6), sat: 0.1, doubler: 0.15, rev: 0.22, dly: 0.12 }),
  vtuber: V({ name: 'キラキラ', desc: 'VTuber系の明るい抜け', hpf: 120, eq: eqBands([320, -3], [1000, -1.5], [4000, 3], [12500, 5]), deess: { f: 7000, amount: 0.6 }, comp: comp(-26, 4, 8, 80, 6), sat: 0.08, doubler: 0.2, rev: 0.26, dly: 0.16 }),
  kawaii: V({ name: 'かわいい', desc: '軽やかで高域キラッ', hpf: 130, eq: eqBands([300, -2.5], [1000, -1], [4200, 2.5], [12500, 4.5]), deess: { f: 7200, amount: 0.55 }, comp: comp(-24, 3.5, 10, 90, 6), sat: 0.05, doubler: 0.1, rev: 0.25, dly: 0.14 }),
  ballad: V({ name: 'バラード', desc: '柔らかく広い響き', hpf: 80, eq: eqBands([250, -2], [1000, 0], [2500, 1.5], [10000, 3]), deess: { f: 6000, amount: 0.35 }, comp: comp(-20, 2.5, 25, 150, 10), rev: 0.36, dly: 0.16 }),
  band: V({ name: 'バンドボーカル', desc: 'バンドに負けない太さと抜け', hpf: 110, eq: eqBands([350, -2.5], [1200, 1.5], [3000, 3], [10000, 2]), deess: { f: 6800, amount: 0.5 }, comp: comp(-27, 4.5, 5, 70, 4), sat: 0.22, doubler: 0.12, rev: 0.16, dly: 0.12 }),
  rock: V({ name: 'ロック', desc: '芯のある力強い声', hpf: 120, eq: eqBands([400, -2], [1200, 1], [2200, 3.5], [9000, 1.5]), comp: comp(-26, 5, 6, 60, 4), sat: 0.35, doubler: 0.1, rev: 0.12, dly: 0.1 }),
  whisper: V({ name: 'ウィスパー', desc: '息っぽく近い', hpf: 100, eq: eqBands([300, -1], [800, -1.5], [4500, 2], [13000, 5]), deess: { f: 7200, amount: 0.6 }, comp: comp(-28, 3.5, 12, 100, 8), rev: 0.15, dly: 0.04 }),
  flat: V({ name: 'なし', desc: 'エフェクトなし', hpf: 0, eq: eqBands([300, 0], [1000, 0], [3500, 0], [11000, 0]), deess: { f: 6500, amount: 0 }, comp: COMP_OFF, rev: 0, dly: 0 }),
  // ---- main vocal: キャラ（よく使われる質感）
  cool: V({ group: 'char', name: 'クール', desc: '低めで落ち着いた艶', hpf: 90, eq: eqBands([250, -1], [800, -1], [3000, 1.5], [10000, 2.5]), comp: comp(-22, 3, 15, 120, 8), sat: 0.15, rev: 0.3, dly: 0.12 }),
  band_emo: V({ group: 'char', name: 'エモ・パワー', desc: '熱量のあるバンド歌唱', hpf: 120, eq: eqBands([400, -3], [1500, 2], [2800, 3.5], [9500, 2]), deess: { f: 7000, amount: 0.55 }, comp: comp(-30, 6, 3, 60, 3), sat: 0.4, doubler: 0.25, rev: 0.18, dly: 0.14 }),
  shout: V({ group: 'char', name: 'シャウト', desc: '歪んだ叫び声', hpf: 150, eq: eqBands([400, -3], [1500, 2], [2800, 4], [9000, 0]), comp: comp(-30, 8, 3, 50, 2), sat: 0.85, rev: 0.12, dly: 0.08 }),
  echo: V({ group: 'char', name: 'エコー', desc: '山びこのような反復', hpf: 120, eq: eqBands([300, -2], [1000, 0], [3500, 2], [11000, 2]), comp: comp(-22, 3, 12, 100, 8), rev: 0.3, dly: 0.5 }),
  bighall: V({ group: 'char', name: '大ホール', desc: 'ライブ会場の残響', hpf: 100, eq: eqBands([300, -2], [1000, 0], [3000, 1.5], [11000, 2]), comp: comp(-22, 3, 15, 120, 8), rev: 0.6, dly: 0.12 }),
  wide: V({ group: 'char', name: 'ワイド', desc: '左右いっぱいの広がり', hpf: 110, eq: eqBands([300, -2], [1000, -1], [3500, 2], [12000, 3]), comp: comp(-24, 4, 10, 90, 6), doubler: 0.7, rev: 0.25, dly: 0.15 }),
  // ---- main vocal: 特殊
  phone: V({ group: 'sfx', name: '電話', desc: '受話器ごしの声', hpf: 100, eq: eqBands([300, 0], [1000, 2], [3500, 0], [11000, -6]), comp: comp(-24, 4, 10, 80, 6), rev: 0.05, dly: 0, color: { type: 'phone', mix: 1 } }),
  radio: V({ group: 'sfx', name: 'ラジオ', desc: '古いラジオ風', hpf: 100, eq: eqBands([300, 0], [1000, 1], [3500, 0], [11000, -4]), comp: comp(-24, 4, 10, 80, 6), rev: 0.08, dly: 0, color: { type: 'radio', mix: 1 } }),
  megaphone: V({ group: 'sfx', name: 'メガホン', desc: '拡声器の割れた声', hpf: 200, eq: eqBands([300, 0], [1200, 3], [3500, 0], [11000, -6]), comp: comp(-26, 6, 5, 60, 4), rev: 0.1, dly: 0.05, color: { type: 'megaphone', mix: 1 } }),
  robot: V({ group: 'sfx', name: 'ロボット', desc: '機械っぽい金属声', hpf: 100, eq: eqBands([300, -2], [1000, 0], [3500, 2], [11000, 2]), comp: comp(-24, 4, 10, 80, 6), rev: 0.15, dly: 0.1, color: { type: 'robot', mix: 0.85 } }),
  lofi: V({ group: 'sfx', name: 'ローファイ', desc: 'ざらついた懐かしい音', hpf: 150, eq: eqBands([300, 1], [1000, 1], [3500, -1], [11000, -6]), comp: comp(-24, 4, 10, 80, 6), rev: 0.15, dly: 0.08, color: { type: 'lofi', mix: 1 } }),
  // ---- harmony
  harmony: HM({ name: '馴染ませ', desc: 'メインの後ろに溶け込む', hpf: 160, eq: eqBands([300, -3], [1000, -1], [3000, -2], [12000, 2]), comp: comp(-24, 4, 15, 100, 8) }),
  harm_bright: HM({ name: '明るめ', desc: 'ハモリもはっきり', hpf: 150, eq: eqBands([300, -2.5], [1000, -0.5], [3500, 0.5], [12000, 3]), deess: { f: 6500, amount: 0.65 }, comp: comp(-24, 4, 12, 90, 6), doubler: 0.1, rev: 0.28 }),
  harm_wide: HM({ name: 'コーラス', desc: '左右に広がる厚み', hpf: 170, eq: eqBands([300, -3], [900, -1.5], [3000, -1.5], [11000, 2]), deess: { f: 6200, amount: 0.75 }, comp: comp(-26, 4, 15, 110, 8), doubler: 0.55, rev: 0.4, dly: 0.12 }),
  harm_far: HM({ name: '遠め', desc: '奥で控えめに', hpf: 200, eq: eqBands([300, -3], [1000, -1], [3500, -3], [9000, -1]), deess: { f: 6000, amount: 0.75 }, comp: comp(-22, 3, 20, 120, 10), doubler: 0.25, rev: 0.5, dly: 0.14 }),
  harm_flat: HM({ name: 'なし', desc: 'エフェクトなし', hpf: 0, eq: eqBands([300, 0], [1000, 0], [3500, 0], [11000, 0]), deess: { f: 6500, amount: 0 }, comp: COMP_OFF, doubler: 0, rev: 0, dly: 0 }),
  // ---- backing (karaoke)
  b_flat: B({ name: 'なし', desc: 'そのまま', hpf: 0, eq: eqBack([100, 0], [400, 0], [2800, 0], [10000, 0]) }),
  b_space: B({ name: '歌の居場所', desc: '声の帯域を空ける', hpf: 30, eq: eqBack([100, 0], [400, -1], [2800, -2.5], [10000, 0]) }),
  b_clean: B({ name: '低音すっきり', desc: 'モコモコを整理', hpf: 40, eq: eqBack([110, -2], [300, -1.5], [2800, 0], [10000, 0.5]) }),
  b_bright: B({ name: '明るく', desc: 'キラキラ感を足す', hpf: 30, eq: eqBack([100, 0.5], [400, -0.5], [3000, 1], [10000, 2.5]) }),
  b_band: B({ name: 'バンド', desc: 'ドラム・ベースの迫力を残して歌の場所を空ける', hpf: 30, eq: eqBack([90, 1.5], [400, -1.5], [2800, -2], [10000, 1.5]), comp: comp(-16, 2.5, 25, 180, 8), sat: 0.08 }),
  b_live: B({ name: 'ライブバンド', desc: 'ライブハウスの勢いと厚み', hpf: 30, eq: eqBack([80, 2], [400, -2], [2600, -1.5], [9000, 1]), comp: comp(-18, 3, 20, 150, 6), sat: 0.14, rev: 0.06 }),
  b_acoustic: B({ name: 'アコースティック', desc: 'ギター・ピアノを自然に', hpf: 40, eq: eqBack([110, -1], [350, -1], [2800, -1], [11000, 1.5]), comp: comp(-14, 1.8, 30, 220, 10) }),
  b_glue: B({ name: 'まとまり', desc: '軽いコンプで一体感', hpf: 30, eq: eqBack([100, 0], [400, 0], [2800, -1.5], [10000, 0.5]), comp: comp(-18, 2, 30, 200, 10) }),
  // ---- group buses
  gv_flat: G('gvocal', { name: 'なし', desc: '素通し', eq: eqBands([300, 0], [1000, 0], [3500, 0], [11000, 0]) }),
  gv_glue: G('gvocal', { name: 'まとめる', desc: 'メインとハモリを馴染ませる', eq: eqBands([300, -1], [1000, 0], [3500, 0.5], [11000, 1]), comp: comp(-18, 2, 20, 150, 10) }),
  gv_front: G('gvocal', { name: '前に出す', desc: '歌をくっきり聴かせる', eq: eqBands([300, -1.5], [1000, 0], [3200, 1.5], [12000, 1.5]), comp: comp(-20, 3, 15, 120, 8) }),
  gv_shine: G('gvocal', { name: '艶', desc: '空気感とツヤを足す', eq: eqBands([300, -1], [1000, -0.5], [4000, 1], [12500, 2.5]), comp: comp(-18, 2, 20, 150, 10), sat: 0.1 }),
  gb_flat: G('gbacking', { name: 'なし', desc: '素通し', eq: eqBack([100, 0], [400, 0], [2800, 0], [10000, 0]) }),
  gb_space: G('gbacking', { name: '歌の居場所', desc: '2〜4kHzを少し空ける', eq: eqBack([100, 0], [400, -0.5], [2800, -2], [10000, 0]) }),
  gb_punch: G('gbacking', { name: '迫力', desc: '低音と一体感を足す', eq: eqBack([90, 1.5], [400, -1], [2800, -1], [10000, 1]), comp: comp(-16, 2, 30, 200, 10) }),
  gb_band: G('gbacking', { name: 'バンドの迫力', desc: 'キックとベースを太く', eq: eqBack([80, 2], [400, -1.5], [2800, -1.5], [10000, 1]), comp: comp(-17, 2.5, 25, 180, 8), sat: 0.1 }),
  gb_soft: G('gbacking', { name: '控えめ', desc: '伴奏を少し引っ込める', eq: eqBack([100, -1], [400, 0], [2800, -1.5], [10000, -1]) }),
  gm_flat: G('gmaster', { name: 'なし', desc: '素通し', eq: eqBack([100, 0], [400, 0], [2800, 0], [10000, 0]) }),
  gm_natural: G('gmaster', { name: 'ナチュラル', desc: '軽くまとめる', eq: eqBack([100, 0], [400, 0], [2800, 0], [11000, 0.5]), comp: comp(-12, 1.5, 30, 200, 10) }),
  gm_loud: G('gmaster', { name: '音圧', desc: '迫力のある仕上がり', eq: eqBack([90, 1], [400, -0.5], [2800, 0], [11000, 1]), comp: comp(-16, 2.5, 20, 150, 8), sat: 0.12 }),
  gm_video: G('gmaster', { name: '歌ってみた動画', desc: 'YouTube・ニコニコ向け。明るく前に出る', eq: eqBack([90, 1], [350, -1], [3000, 1], [12000, 2]), comp: comp(-15, 2.2, 20, 160, 8), sat: 0.08 }),
  gm_cd: G('gmaster', { name: 'CD仕様', desc: '44.1kHz/16bit・大きめの音圧で仕上げる', eq: eqBack([80, 1.5], [400, -0.5], [2800, 0.5], [11000, 1.5]), comp: comp(-18, 3, 15, 140, 6), sat: 0.15 }),
  gm_clear: G('gmaster', { name: 'クリア', desc: '抜けよく明るく', eq: eqBack([100, -0.5], [350, -1], [3000, 0.5], [12000, 2]), comp: comp(-12, 1.5, 30, 200, 10) }),
};
export const PRESET_GROUPS = { std: '定番', char: 'キャラ', sfx: '特殊' };
export const DEFAULT_PRESET = { vocal: 'natural', harmony: 'harmony', backing: 'b_flat', gvocal: 'gv_glue', gbacking: 'gb_flat', gmaster: 'gm_natural' };

export function fxFromPreset(key) {
  const p = PRESETS[key] || PRESETS.natural;
  const c = JSON.parse(JSON.stringify(p));
  delete c.name; delete c.desc; delete c.cat; delete c.group;
  c.preset = key;
  return c;
}
export function migrateFx(fx) {
  if (!fx.color) fx.color = { type: 'none', mix: 0 };
  if (fx.eq) fx.eq.forEach((b, i) => { if (!b.label) b.label = EQ_LABELS[i]; });
  return fx;
}

export const REVERB_TYPES = {
  room: { name: 'ルーム', decay: 0.9, damp: 0.55, pre: 10 },
  plate: { name: 'プレート', decay: 1.7, damp: 0.35, pre: 20 },
  hall: { name: 'ホール', decay: 2.8, damp: 0.5, pre: 30 },
};
export const DELAY_NOTES = { '1/4': 1, '1/8': 0.5, '1/8.': 0.75, '1/16': 0.25 };
export const COLOR_TYPES = {
  none: { name: 'なし' },
  phone: { name: '電話', hp: 450, lp: 3200, q: 0.9, drive: 0.45 },
  radio: { name: 'ラジオ', hp: 280, lp: 4500, q: 0.8, drive: 0.25, bits: 9 },
  megaphone: { name: 'メガホン', hp: 750, lp: 2600, q: 2.2, drive: 0.95 },
  robot: { name: 'ロボット', hp: 70, lp: 9000, q: 0.7, drive: 0.12, ring: 55 },
  lofi: { name: 'ローファイ', hp: 180, lp: 3800, q: 0.7, drive: 0.2, bits: 6 },
};

export function defaultBus() {
  return { reverb: { type: 'plate' }, delay: { note: '1/8', feedback: 0.3, pingpong: false }, bpm: 120, master: { vol: 0, limiter: true } };
}
export function defaultGroups() {
  return {
    vocal: { vol: 0, fx: fxFromPreset(DEFAULT_PRESET.gvocal) },
    backing: { vol: 0, fx: fxFromPreset(DEFAULT_PRESET.gbacking) },
    master: { vol: 0, fx: fxFromPreset(DEFAULT_PRESET.gmaster), limiter: true },
  };
}

function makeIR(ctx, type) {
  const t = REVERB_TYPES[type] || REVERB_TYPES.plate;
  const sr = ctx.sampleRate;
  const pre = Math.round(sr * t.pre / 1000);
  const len = pre + Math.round(sr * t.decay * 0.85);
  const buf = ctx.createBuffer(2, len, sr);
  let seed = 12345 + type.length * 777;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const tt = (i - pre) / sr;
      const env = Math.exp(-6.9 * tt / t.decay);
      const a = Math.min(0.95, t.damp * (0.15 + tt / t.decay));
      lp = lp * a + rnd() * (1 - a);
      let er = 0;
      if (tt < 0.08) er = (Math.abs(rnd()) > 0.985 ? rnd() * 2.5 : 0);
      d[i] = (lp * 1.6 + er) * env;
    }
  }
  return buf;
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
const ABS_CURVE = (() => { const n = 1024, c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = Math.abs(i / (n - 1) * 2 - 1); return c; })();

// One channel strip. cfg: {fx, vol, pan, clipGain}. sends: Bus or null. dest: AudioNode.
class Strip {
  constructor(ctx, cfg, sends, dest, meter) {
    this.ctx = ctx;
    const g = () => ctx.createGain();
    const bq = (type, f, q) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q) b.Q.value = q; return b; };
    this.input = g();
    this.hpf = bq('highpass', 20, 0.707);
    this.eq = [0, 1, 2, 3].map(() => bq('peaking', 1000, 1));
    this.dsLo1 = bq('lowpass', 6500, 0.7071); this.dsLo2 = bq('lowpass', 6500, 0.7071);
    this.dsHi1 = bq('highpass', 6500, 0.7071); this.dsHi2 = bq('highpass', 6500, 0.7071);
    this.dsHiGain = g();
    this.dsAbs = ctx.createWaveShaper(); this.dsAbs.curve = ABS_CURVE;
    this.dsEnv = bq('lowpass', 40, 0.5);
    this.dsMap = ctx.createWaveShaper();
    this.dsSum = g();
    this.preComp = g();
    this.comp = ctx.createDynamicsCompressor();
    this.makeup = g();
    this.satDry = g(); this.satWet = g();
    this.sat = ctx.createWaveShaper(); this.sat.oversample = '2x';
    this.satOut = g();
    // special colour stage
    this.colDry = g(); this.colWet = g();
    this.colHp = bq('highpass', 100, 0.7); this.colLp = bq('lowpass', 8000, 0.7);
    this.colShape = ctx.createWaveShaper();
    this.ring = g();
    this.ringOsc = null;
    this.ringDepth = g(); this.ringDepth.gain.value = 0;
    this.ringDepth.connect(this.ring.gain);
    this.fader = g();
    this.mute = g();
    this.pan = ctx.createStereoPanner();
    this.out = g();
    this.dbIn = g();
    this.dbHp = bq('highpass', 250, 0.7);
    this.dbL = ctx.createDelay(0.1); this.dbR = ctx.createDelay(0.1);
    this.dbL.delayTime.value = 0.011; this.dbR.delayTime.value = 0.017;
    this.dbPanL = ctx.createStereoPanner(); this.dbPanL.pan.value = -0.8;
    this.dbPanR = ctx.createStereoPanner(); this.dbPanR.pan.value = 0.8;
    this.dbGain = g();
    this.oscs = [];
    this.dblOscOn = false;
    this.revSend = g(); this.dlySend = g();

    this.eqOut = g();
    this.eqChain = null;
    // de-esser split (switched in only when used)
    this.dsLo1.connect(this.dsLo2); this.dsLo2.connect(this.dsSum);
    this.dsHi1.connect(this.dsHi2); this.dsHi2.connect(this.dsHiGain); this.dsHiGain.connect(this.dsSum);
    this.dsHi2.connect(this.dsAbs); this.dsAbs.connect(this.dsEnv); this.dsEnv.connect(this.dsMap); this.dsMap.connect(this.dsHiGain.gain);
    this.makeup.connect(this.satDry); this.sat.connect(this.satWet);
    this.satDry.connect(this.satOut);
    this.autoDry = g();
    this.satOut.connect(this.colDry); this.colDry.connect(this.autoDry); this.autoDry.connect(this.fader);
    this.colHp.connect(this.colLp); this.colLp.connect(this.colShape);
    this.colShape.connect(this.ring); this.ring.connect(this.colWet);
    this.fader.connect(this.mute);
    this.mute.connect(this.pan); this.pan.connect(this.out);
    this.dbIn.connect(this.dbHp);
    this.dbHp.connect(this.dbL); this.dbHp.connect(this.dbR);
    this.dbL.connect(this.dbPanL); this.dbR.connect(this.dbPanR);
    this.dbPanL.connect(this.dbGain); this.dbPanR.connect(this.dbGain);
    if (sends) { this.revSend.connect(sends.revIn); this.dlySend.connect(sends.dlyIn); }
    this.hasSends = !!sends;
    this.out.connect(dest);
    if (meter) { this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 512; this.out.connect(this.analyser); }
    this._satAmt = -1; this._dsAmt = -1; this._col = '';
    this.routes = {};
    this.update(cfg);
  }

  // connect costly processing only while it is actually used (keeps phones fast)
  route(name, on) {
    if (!!this.routes[name] === on) return;
    this.routes[name] = on;
    const pairs = {
      deess: [[this.eqOut, this.dsLo1], [this.eqOut, this.dsHi1], [this.dsSum, this.preComp]],
      direct: [[this.eqOut, this.preComp]],
      comp: [[this.preComp, this.comp], [this.comp, this.makeup]],
      nocomp: [[this.preComp, this.makeup]],
      sat: [[this.makeup, this.sat], [this.satWet, this.satOut]],
      color: [[this.satOut, this.colHp], [this.colWet, this.fader]],
      dbl: [[this.mute, this.dbIn], [this.dbGain, this.out]],
    }[name];
    if (on && name === 'color' && !this.ringOsc) {
      this.ringOsc = this.ctx.createOscillator(); this.ringOsc.frequency.value = (COLOR_TYPES.robot.ring || 55);
      this.ringOsc.connect(this.ringDepth); this.ringOsc.start(); this.oscs.push(this.ringOsc);
    }
    if (on && name === 'dbl' && !this.dblOscOn) {
      this.dblOscOn = true;
      [[this.dbL, 0.31], [this.dbR, 0.43]].forEach(([dl, rate]) => {
        const o = this.ctx.createOscillator(); o.frequency.value = rate;
        const og = this.ctx.createGain(); og.gain.value = 0.0015;
        o.connect(og); og.connect(dl.delayTime); o.start();
        this.oscs.push(o);
      });
    }
    for (const [a, b] of pairs) { try { if (on) a.connect(b); else a.disconnect(b); } catch (e) { /* ignore */ } }
  }

  // only filters that actually change the sound are wired in
  eqRoute(fx) {
    const act = [];
    if (fx.hpf > 0) act.push(this.hpf);
    fx.eq.forEach((b, i) => { if (Math.abs(b.g) > 0.05) act.push(this.eq[i]); });
    const key = act.map((f) => (f === this.hpf ? 'h' : this.eq.indexOf(f))).join(',');
    if (key === this.eqChain) return;
    this.eqChain = key;
    try { this.input.disconnect(); } catch (e) { /* ignore */ }
    for (const f of [this.hpf, ...this.eq]) { try { f.disconnect(); } catch (e) { /* ignore */ } }
    let n = this.input;
    for (const f of act) { n.connect(f); n = f; }
    n.connect(this.eqOut);
  }

  update(cfg) {
    const fx = cfg.fx;
    const t = this.ctx.currentTime;
    const set = (p, v) => { try { p.setTargetAtTime(v, t, 0.015); } catch (e) { p.value = v; } };
    this.eqRoute(fx);
    set(this.hpf.frequency, fx.hpf > 0 ? fx.hpf : 10);
    fx.eq.forEach((b, i) => {
      const f = this.eq[i];
      if (f.type !== b.type) f.type = b.type;
      set(f.frequency, b.f); set(f.gain, b.g); set(f.Q, b.q);
    });
    const useDs = fx.deess.amount > 0;
    this.route('deess', useDs); this.route('direct', !useDs);
    [this.dsLo1, this.dsLo2, this.dsHi1, this.dsHi2].forEach((f) => set(f.frequency, fx.deess.f));
    if (this._dsAmt !== fx.deess.amount) { this.dsMap.curve = deessCurve(fx.deess.amount); this._dsAmt = fx.deess.amount; }
    const c = fx.comp;
    this.route('comp', !!c.on); this.route('nocomp', !c.on);
    if (c.on) {
      set(this.comp.threshold, c.threshold); set(this.comp.ratio, c.ratio); set(this.comp.knee, c.knee);
      set(this.comp.attack, c.attack / 1000); set(this.comp.release, c.release / 1000);
    } else {
      set(this.comp.threshold, 0); set(this.comp.ratio, 1); set(this.comp.knee, 0);
    }
    set(this.makeup.gain, dbToGain(fx.gain || 0));
    if (this._satAmt !== fx.sat) { this.sat.curve = satCurve(fx.sat); this.sat.oversample = fx.sat > 0.3 ? '2x' : 'none'; this._satAmt = fx.sat; }
    this.route('sat', fx.sat > 0);
    set(this.satWet.gain, fx.sat * 0.6); set(this.satDry.gain, 1 - fx.sat * 0.45);
    const col = fx.color || { type: 'none', mix: 0 };
    const ct = COLOR_TYPES[col.type] || COLOR_TYPES.none;
    this.route('color', col.type !== 'none' && col.mix > 0);
    const key = col.type;
    if (this._col !== key) {
      this._col = key;
      if (col.type !== 'none') {
        this.colHp.frequency.value = ct.hp; this.colHp.Q.value = ct.q;
        this.colLp.frequency.value = ct.lp; this.colLp.Q.value = ct.q;
        this.colShape.curve = satCurve(ct.drive, ct.bits);
        if (this.ringOsc) this.ringOsc.frequency.value = ct.ring || 55;
      }
    }
    const isRing = col.type === 'robot';
    set(this.ring.gain, isRing ? 0 : 1);
    set(this.ringDepth.gain, isRing ? 1 : 0);
    const mix = col.type === 'none' ? 0 : col.mix;
    set(this.colWet.gain, mix * (isRing ? 1.4 : 1.1)); set(this.colDry.gain, 1 - mix);
    set(this.dbGain.gain, (fx.doubler || 0) * 0.55);
    this.route('dbl', (fx.doubler || 0) > 0);
    set(this.revSend.gain, fx.rev || 0); set(this.dlySend.gain, fx.dly || 0);
    if (this.hasSends) {
      const r = (fx.rev || 0) > 0, d = (fx.dly || 0) > 0;
      if (!!this.routes.rev !== r) { this.routes.rev = r; try { if (r) this.mute.connect(this.revSend); else this.mute.disconnect(this.revSend); } catch (e) { /* ignore */ } }
      if (!!this.routes.dly !== d) { this.routes.dly = d; try { if (d) this.mute.connect(this.dlySend); else this.mute.disconnect(this.dlySend); } catch (e) { /* ignore */ } }
    }
    set(this.fader.gain, dbToGain(cfg.vol || 0));
    set(this.input.gain, dbToGain(cfg.clipGain || 0));
    set(this.pan.pan, cfg.pan || 0);
  }

  setAudible(on) { this.mute.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01); }
  // per-clip effects ("部分エフェクト"): extra nodes whose values follow a time curve
  applyAuto(plan, sends, when, from) {
    if (!plan) return;
    const ctx = this.ctx, g = () => ctx.createGain();
    const sched = (param, keys) => {
      const at = (T) => when + (T - from);
      const v0 = curveAt(keys, from);
      try { param.cancelScheduledValues(0); } catch (e) { /* ignore */ }
      param.value = v0; param.setValueAtTime(v0, when);
      for (const [T, v] of keys) if (T > from) param.linearRampToValueAtTime(v, at(T));
    };
    if (plan.lp || plan.vol) {
      this.fader.disconnect(this.mute);
      let n = this.fader;
      if (plan.lp) { this.autoLp = ctx.createBiquadFilter(); this.autoLp.type = 'lowpass'; this.autoLp.Q.value = 0.7; n.connect(this.autoLp); n = this.autoLp; sched(this.autoLp.frequency, plan.lp.map(([t, v]) => [t, Math.min(v, ctx.sampleRate / 2)])); }
      if (plan.vol) { this.autoVol = g(); n.connect(this.autoVol); n = this.autoVol; sched(this.autoVol.gain, plan.vol); }
      n.connect(this.mute);
    }
    if (sends && plan.rev) { this.autoRev = g(); this.mute.connect(this.autoRev); this.autoRev.connect(sends.revIn); sched(this.autoRev.gain, plan.rev); }
    if (sends && plan.dly) { this.autoDly = g(); this.mute.connect(this.autoDly); this.autoDly.connect(sends.dlyIn); sched(this.autoDly.gain, plan.dly); }
    if (plan.dry) sched(this.autoDry.gain, plan.dry);
    for (const [type, keys] of Object.entries(plan.col || {})) {
      const ct = COLOR_TYPES[type]; if (!ct) continue;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = ct.hp; hp.Q.value = ct.q;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = ct.lp; lp.Q.value = ct.q;
      const sh = ctx.createWaveShaper(); sh.curve = satCurve(ct.drive, ct.bits);
      const ring = g(), wet = g();
      this.satOut.connect(hp); hp.connect(lp); lp.connect(sh); sh.connect(ring); ring.connect(wet); wet.connect(this.fader);
      if (type === 'robot') {
        ring.gain.value = 0;
        const o = ctx.createOscillator(); o.frequency.value = ct.ring || 55; o.connect(ring.gain); o.start(); this.oscs.push(o);
      }
      sched(wet.gain, keys);
    }
  }
  get reduction() { const r = this.comp.reduction; return typeof r === 'number' ? r : (r && r.value) || 0; }
  level() {
    if (!this.analyser) return 0;
    const d = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(d);
    let m = 0;
    for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
    return m;
  }
  dispose() {
    this.oscs.forEach((o) => { try { o.stop(); } catch (e) { /* ignore */ } });
    try { this.out.disconnect(); this.revSend.disconnect(); this.dlySend.disconnect(); } catch (e) { /* ignore */ }
  }
}

// reverb + delay sends (returns go into the vocal group, after its processing)
class Sends {
  constructor(ctx, cfg, ret) {
    this.ctx = ctx;
    const g = () => ctx.createGain();
    this.revIn = g(); this.dlyIn = g();
    // mono sends: stereo-IR reverb from a mono feed = 2 convolutions instead of 4
    for (const n of [this.revIn, this.dlyIn]) { n.channelCount = 1; n.channelCountMode = 'explicit'; n.channelInterpretation = 'speakers'; }
    this.preDelay = ctx.createDelay(0.2);
    this.conv = ctx.createConvolver();
    this.revHp = ctx.createBiquadFilter(); this.revHp.type = 'highpass'; this.revHp.frequency.value = 220;
    this.revLp = ctx.createBiquadFilter(); this.revLp.type = 'lowpass'; this.revLp.frequency.value = 9000;
    this.revOut = g(); this.revOut.gain.value = 0.9;
    this.revIn.connect(this.preDelay); this.preDelay.connect(this.conv); this.conv.connect(this.revHp);
    this.revHp.connect(this.revLp); this.revLp.connect(this.revOut); this.revOut.connect(ret);
    // ping-pong capable delay: L then R alternately (centred when ping-pong is off)
    this.dlyHp = ctx.createBiquadFilter(); this.dlyHp.type = 'highpass'; this.dlyHp.frequency.value = 350;
    this.dlyLp = ctx.createBiquadFilter(); this.dlyLp.type = 'lowpass'; this.dlyLp.frequency.value = 4500;
    this.dL = ctx.createDelay(2.0); this.dR = ctx.createDelay(2.0);
    this.fbA = g(); this.fbB = g();
    this.panL = ctx.createStereoPanner(); this.panR = ctx.createStereoPanner();
    this.dlyOut = g();
    this.dlyIn.connect(this.dlyHp); this.dlyHp.connect(this.dlyLp); this.dlyLp.connect(this.dL);
    this.dL.connect(this.panL); this.panL.connect(this.dlyOut);
    this.dL.connect(this.fbA); this.fbA.connect(this.dR);
    this.dR.connect(this.panR); this.panR.connect(this.dlyOut);
    this.dR.connect(this.fbB); this.fbB.connect(this.dlyHp);
    this.dlyOut.connect(ret);
    this.dlyOut.connect(this.revIn);
    this._rt = null;
    this.update(cfg);
  }
  update(cfg) {
    if (this._rt !== cfg.reverb.type) { this.conv.buffer = makeIR(this.ctx, cfg.reverb.type); this._rt = cfg.reverb.type; }
    const t = this.ctx.currentTime;
    const rt = REVERB_TYPES[cfg.reverb.type] || REVERB_TYPES.plate;
    this.preDelay.delayTime.setValueAtTime(rt.pre / 1000 + 0.015, t);
    const beat = 60 / Math.max(40, Math.min(240, cfg.bpm || 120));
    const dt = Math.min(1.9, beat * (DELAY_NOTES[cfg.delay.note] || 0.5));
    this.dL.delayTime.setValueAtTime(dt, t); this.dR.delayTime.setValueAtTime(dt, t);
    const fb = Math.min(0.8, cfg.delay.feedback);
    this.fbA.gain.setValueAtTime(fb, t); this.fbB.gain.setValueAtTime(fb, t);
    const pp = cfg.delay.pingpong ? 0.85 : 0;
    this.panL.pan.setValueAtTime(-pp, t); this.panR.pan.setValueAtTime(pp, t);
  }
}

class LightStrip {
  constructor(ctx, cfg, dest) {
    this.ctx = ctx;
    this.input = ctx.createGain(); this.mute = ctx.createGain(); this.pan = ctx.createStereoPanner();
    this.input.connect(this.mute); this.mute.connect(this.pan); this.pan.connect(dest);
    this.update(cfg);
  }
  update(cfg) { this.input.gain.value = dbToGain((cfg.clipGain || 0) + (cfg.vol || 0)); this.pan.pan.value = cfg.pan || 0; }
  setAudible(on) { this.mute.gain.value = on ? 1 : 0; }
  get reduction() { return 0; }
  level() { return 0; }
  dispose() { try { this.pan.disconnect(); } catch (e) { /* ignore */ } }
}
function buildLightGraph(ctx, project) {
  const out = ctx.createGain();
  const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
  out.connect(ctx.destination); out.connect(analyser);
  const chains = new Map();
  const anySolo = project.tracks.some((t) => t.solo);
  for (const tr of project.tracks) { const ch = new LightStrip(ctx, tr, out); ch.setAudible(!tr.mute && (!anySolo || tr.solo)); chains.set(tr.id, ch); }
  const dummy = { update() {}, dispose() {}, level() { return 0; }, reduction: 0 };
  return { light: true, master: dummy, gv: dummy, gb: dummy, sends: null, chains, analyser, trim: out, limiter: null };
}

function buildGraph(ctx, project, only, live) {
  const groups = project.groups;
  const master = new Strip(ctx, { fx: groups.master.fx, vol: groups.master.vol }, null, ctx.createGain(), live);
  // master -> limiter -> trim -> out
  master.out.disconnect();
  if (master.analyser) master.out.connect(master.analyser);
  const limiter = ctx.createDynamicsCompressor();
  const trim = ctx.createGain(); trim.gain.value = dbToGain(-0.8);
  const analyser = live ? ctx.createAnalyser() : null;
  master.out.connect(limiter); limiter.connect(trim); trim.connect(ctx.destination);
  if (analyser) { analyser.fftSize = 1024; trim.connect(analyser); }
  const gv = new Strip(ctx, { fx: groups.vocal.fx, vol: groups.vocal.vol }, null, master.input, live);
  const gb = new Strip(ctx, { fx: groups.backing.fx, vol: groups.backing.vol }, null, master.input, live);
  const needSends = live || project.tracks.some((t) => (!only || only(t)) && t.fx && ((t.fx.rev || 0) > 0 || (t.fx.dly || 0) > 0 || (t.clips || []).some((c) => c.fx && (c.fx.echo > 0 || c.fx.reverb > 0))));
  const sends = needSends ? new Sends(ctx, project.bus, gv.fader) : null;
  const chains = new Map();
  const anySolo = project.tracks.some((t) => t.solo);
  for (const tr of project.tracks) {
    if (only && !only(tr)) continue;
    const ch = new Strip(ctx, tr, sends, tr.kind === 'backing' ? gb.input : gv.input, false);
    ch.setAudible(!tr.mute && (!anySolo || tr.solo));
    chains.set(tr.id, ch);
  }
  const graph = { master, limiter, trim, analyser, gv, gb, sends, chains };
  setLimiter(graph, groups.master.limiter, ctx.currentTime);
  return graph;
}
function setLimiter(graph, on, t) {
  const l = graph.limiter;
  if (on) { l.threshold.setValueAtTime(-1.5, t); l.ratio.setValueAtTime(20, t); l.knee.setValueAtTime(0, t); l.attack.setValueAtTime(0.002, t); l.release.setValueAtTime(0.12, t); }
  else { l.threshold.setValueAtTime(0, t); l.ratio.setValueAtTime(1, t); l.knee.setValueAtTime(0, t); }
}

// ---- per-clip effects → time curves ([[time, value], ...], linear in between) ----
export function curveAt(keys, t) {
  if (!keys.length) return 0;
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) if (t <= keys[i][0]) { const [t0, v0] = keys[i - 1], [t1, v1] = keys[i]; return t1 > t0 ? v0 + (v1 - v0) * (t - t0) / (t1 - t0) : v1; }
  return keys[keys.length - 1][1];
}
export const CLIP_FX_DEFAULT = { echo: 0, reverb: 0, tail: false, voice: 'none', voiceMix: 0.8, vol: 0, muffle: 0 };
export function clipHasFx(fx) { return !!fx && ((fx.echo || 0) > 0 || (fx.reverb || 0) > 0 || (fx.vol || 0) !== 0 || (fx.muffle || 0) > 0 || (fx.voice && fx.voice !== 'none' && (fx.voiceMix || 0) > 0)); }
export function autoPlan(tr) {
  const clips = (tr.clips || []).filter((c) => clipHasFx(c.fx));
  if (!clips.length) return null;
  const regs = { rev: [], dly: [], vol: [], lp: [], dry: [], col: {} };
  const X = 0.03, S = 0.06;
  for (const c of clips) {
    const fx = c.fx, s = c.at, e = c.at + (c.b - c.a);
    const ss = fx.tail ? Math.max(s, e - 0.8) : s;
    // sends: start sending, stop at the clip end — the echo / reverb keeps ringing after it
    if (fx.echo > 0) regs.dly.push([ss, ss + S, e, e + S, fx.echo * 0.9]);
    if (fx.reverb > 0) regs.rev.push([ss, ss + S, e, e + S, fx.reverb * 0.8]);
    if (fx.vol) regs.vol.push([s - X, s + X, e - X, e + X, fx.vol]);
    if (fx.muffle > 0) regs.lp.push([s - X, s + X, e - X, e + X, fx.muffle]);
    if (fx.voice && fx.voice !== 'none' && fx.voiceMix > 0) {
      (regs.col[fx.voice] = regs.col[fx.voice] || []).push([s - X, s + X, e - X, e + X, fx.voiceMix * (fx.voice === 'robot' ? 1.4 : 1.1)]);
      regs.dry.push([s - X, s + X, e - X, e + X, fx.voiceMix]);
    }
  }
  const w = (r, t) => (t <= r[0] || t >= r[3]) ? 0 : t < r[1] ? (t - r[0]) / (r[1] - r[0]) : t <= r[2] ? 1 : (r[3] - t) / (r[3] - r[2]);
  const build = (list, map) => {
    if (!list.length) return null;
    const ts = [...new Set(list.flatMap((r) => r.slice(0, 4)).map((t) => Math.max(0, Math.round(t * 1000) / 1000)))].sort((a, b) => a - b);
    return ts.map((t) => [t, map(list.reduce((acc, r) => acc + w(r, t) * r[4], 0))]);
  };
  const plan = {
    rev: build(regs.rev, (v) => v), dly: build(regs.dly, (v) => v),
    vol: build(regs.vol, (db) => Math.pow(10, db / 20)),
    lp: build(regs.lp, (m) => 24000 * Math.pow(350 / 24000, Math.min(1, m))),
    dry: build(regs.dry, (m) => Math.max(0, 1 - m)), col: {},
  };
  for (const [k, list] of Object.entries(regs.col)) plan.col[k] = build(list, (v) => v);
  return plan;
}

// track clips: [{at (timeline sec), a, b (sec inside the track's audio)}]
export function clipsOf(tr, buf) {
  const cs = tr.clips && tr.clips.length ? tr.clips : (buf ? [{ at: tr.offset || 0, a: 0, b: buf.duration }] : []);
  return cs;
}
function startSources(ctx, project, graph, bufferFor, when, from) {
  const sources = [];
  for (const tr of project.tracks) {
    const ch = graph.chains.get(tr.id);
    if (!ch) continue;
    const buf = bufferFor(tr);
    if (!buf) continue;
    const clips = clipsOf(tr, buf);
    if (!clips.length) continue;
    let tStart = Infinity, tEnd = -Infinity;
    for (const c of clips) { tStart = Math.min(tStart, c.at); tEnd = Math.max(tEnd, c.at + (Math.min(c.b, buf.duration) - c.a)); }
    const fi = (tr.fade && tr.fade.in) || 0, fo = (tr.fade && tr.fade.out) || 0;
    for (const c of clips) {
      const b = Math.min(c.b, buf.duration);
      if (b - c.a < 0.005) continue;
      const cs = c.at, ce = c.at + (b - c.a);
      if (from >= ce) continue;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const fg = ctx.createGain();
      src.connect(fg); fg.connect(ch.input);
      const t0 = Math.max(from, cs);
      const ctxAt = (T) => when + (T - from);
      // envelope: 4 ms clip edges + track fades (all linear pieces)
      const edge = 0.004;
      const env = (T) => Math.max(0, Math.min(1, (T - cs) / edge, (ce - T) / edge, fi > 0 ? (T - tStart) / fi : 1, fo > 0 ? (tEnd - T) / fo : 1));
      const pts = [t0, cs + edge, ce - edge, ce, fi > 0 ? tStart + fi : null, fo > 0 ? tEnd - fo : null]
        .filter((T) => T != null && T >= t0 && T <= ce).sort((x, y) => x - y);
      fg.gain.setValueAtTime(env(t0), ctxAt(t0));
      for (const T of pts) if (T > t0) fg.gain.linearRampToValueAtTime(env(T), ctxAt(T));
      const off = c.a + (t0 - cs);
      src.start(ctxAt(t0), off, b - off);
      sources.push(src);
    }
  }
  return sources;
}

export class Engine {
  constructor() {
    this.ctx = null; this.graph = null; this.sources = [];
    this.playing = false; this.startCtxTime = 0; this.startPos = 0;
  }
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
    }
    try { if (navigator.audioSession && navigator.audioSession.type !== 'play-and-record') navigator.audioSession.type = 'playback'; } catch (e) { /* ignore */ }
    if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
    return this.ctx;
  }
  get sampleRate() { return this.ensure().sampleRate; }
  get position() {
    if (!this.playing) return this.startPos;
    return this.startPos + Math.max(0, this.ctx.currentTime - this.startCtxTime);
  }
  disposeGraph() {
    if (!this.graph) return;
    for (const ch of this.graph.chains.values()) ch.dispose();
    [this.graph.gv, this.graph.gb, this.graph.master].forEach((s) => s.dispose());
    try { this.graph.trim.disconnect(); } catch (e) { /* ignore */ }
    this.graph = null;
  }
  play(project, bufferFor, from, opts = {}) {
    this.ensure();
    this.stop(true);
    this.disposeGraph();
    this.graph = opts.light ? buildLightGraph(this.ctx, project) : buildGraph(this.ctx, project, null, true);
    const when = this.ctx.currentTime + (opts.lead || 0.06);
    this.sources = startSources(this.ctx, project, this.graph, bufferFor, when, from);
    if (!opts.light) for (const tr of project.tracks) { const ch = this.graph.chains.get(tr.id); if (ch) ch.applyAuto(autoPlan(tr), this.graph.sends, when, from); }
    this.startCtxTime = when; this.startPos = from; this.playing = true;
    return when;
  }
  stop() {
    for (const s of this.sources) { try { s.stop(); } catch (e) { /* ignore */ } try { s.disconnect(); } catch (e) { /* ignore */ } }
    this.sources = [];
    if (this.playing) this.startPos = this.position;
    this.playing = false;
  }
  seek(pos) { this.startPos = Math.max(0, pos); }
  updateTrack(project, track) {
    if (!this.graph) return;
    const ch = this.graph.chains.get(track.id);
    if (ch) ch.update(track);
    this.updateAudibility(project);
  }
  updateAudibility(project) {
    if (!this.graph) return;
    const anySolo = project.tracks.some((t) => t.solo);
    for (const tr of project.tracks) { const ch = this.graph.chains.get(tr.id); if (ch) ch.setAudible(!tr.mute && (!anySolo || tr.solo)); }
  }
  updateBus(project) { if (this.graph && this.graph.sends) this.graph.sends.update(project.bus); }
  updateGroups(project) {
    if (!this.graph) return;
    if (this.graph.light) return;
    const G = project.groups;
    this.graph.gv.update({ fx: G.vocal.fx, vol: G.vocal.vol });
    this.graph.gb.update({ fx: G.backing.fx, vol: G.backing.vol });
    this.graph.master.update({ fx: G.master.fx, vol: G.master.vol });
    setLimiter(this.graph, G.master.limiter, this.ctx.currentTime);
  }
  reduction(trackId) {
    if (!this.graph) return 0;
    const s = trackId === 'g:vocal' ? this.graph.gv : trackId === 'g:backing' ? this.graph.gb : trackId === 'g:master' ? this.graph.master : this.graph.chains.get(trackId);
    return s ? s.reduction : 0;
  }
  groupLevel(name) {
    if (!this.graph) return 0;
    return (name === 'vocal' ? this.graph.gv : name === 'backing' ? this.graph.gb : this.graph.master).level();
  }
  meter() {
    if (!this.graph) return 0;
    const a = this.graph.analyser, d = new Float32Array(a.fftSize);
    a.getFloatTimeDomainData(d);
    let m = 0;
    for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
    return m;
  }
}

// Offline mixdown. include(track) decides which tracks to render.
function renderWithTimeout(ctx, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('書き出し処理が止まってしまいました。アプリを開き直して、もう一度お試しください。')), ms);
    ctx.startRendering().then((b) => { clearTimeout(t); resolve(b); }, (e) => { clearTimeout(t); reject(e); });
  });
}
// Offline mixdown. include(track) decides which tracks to render.
// Long songs are rendered in short pieces (each with a few seconds of warm-up so compressors,
// reverb and delay continue naturally, joined with a short crossfade). This keeps memory low and
// shows real progress on iPhone instead of one huge render that can stall.
export async function renderMix(project, bufferFor, sampleRate, include, onProgress, opts = {}) {
  let end = 0;
  for (const tr of project.tracks) {
    if (include && !include(tr)) continue;
    const b = bufferFor(tr);
    if (b) for (const c of clipsOf(tr, b)) end = Math.max(end, c.at + (Math.min(c.b, b.duration) - c.a));
  }
  if (end <= 0) throw new Error('書き出す音がありません');
  const sr = sampleRate;
  const from = Math.max(0, Math.min(opts.from || 0, end - 1));
  let span = end - from;
  if (opts.maxSec) span = Math.min(span, opts.maxSec);
  const tail = opts.noTail ? 0.2 : 3.0;
  const total = Math.ceil((span + tail) * sr);
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const proj = Object.assign({}, project, { tracks: project.tracks.map((t) => Object.assign({}, t, { solo: false, mute: include ? !include(t) : t.mute })) });
  const segN = Math.round((opts.segment || 1e9) * sr), warmN = Math.round(4 * sr), xf = Math.round(0.05 * sr);
  const fromN = Math.round(from * sr);
  let L, R;
  if (total <= segN + 2 * sr) {
    const ctx = new OAC(2, total, sr);
    const graph = buildGraph(ctx, proj, include, false);
    startSources(ctx, proj, graph, bufferFor, 0, from);
    for (const tr of proj.tracks) { const ch = graph.chains.get(tr.id); if (ch) ch.applyAuto(autoPlan(tr), graph.sends, 0, from); }
    let timer = null;
    const t0 = performance.now();
    if (onProgress) timer = setInterval(() => { try { onProgress(Math.min(0.99, ctx.currentTime / (total / sr)), (performance.now() - t0) / 1000); } catch (e) { /* ignore */ } }, 250);
    try { const out = await renderWithTimeout(ctx, Math.max(120000, span * 4000)); L = out.getChannelData(0); R = out.getChannelData(1); }
    finally { if (timer) clearInterval(timer); }
  } else {
    L = new Float32Array(total); R = new Float32Array(total);
    const t0 = performance.now();
    for (let s0 = 0; s0 < total; s0 += segN) {
      const absN = fromN + s0;
      const startN = Math.max(0, absN - warmN), pre = absN - startN;
      const last = s0 + segN >= total;
      const segLen = Math.min(segN, total - s0) + (last ? 0 : xf);
      const ctx = new OAC(2, pre + segLen, sr);
      const graph = buildGraph(ctx, proj, include, false);
      startSources(ctx, proj, graph, bufferFor, 0, startN / sr);
      const out = await renderWithTimeout(ctx, 90000);
      const a = out.getChannelData(0), b = out.getChannelData(1);
      for (let i = 0; i < segLen && s0 + i < total; i++) {
        const j = s0 + i;
        if (s0 > 0 && i < xf) { const w = i / xf; L[j] = L[j] * (1 - w) + a[pre + i] * w; R[j] = R[j] * (1 - w) + b[pre + i] * w; }
        else { L[j] = a[pre + i]; R[j] = b[pre + i]; }
      }
      if (onProgress) onProgress(Math.min(0.99, (s0 + segLen) / total), (performance.now() - t0) / 1000);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  let lastI = L.length - 1;
  while (lastI > (span * sr) && Math.abs(L[lastI]) < 1e-4 && Math.abs(R[lastI]) < 1e-4) lastI--;
  return { L: L.subarray(0, lastI + 1), R: R.subarray(0, lastI + 1), sampleRate: sr };
}

// writes the WAV in small parts so no single huge allocation is needed
export function encodeWav(channels, sampleRate, bits) {
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
}
