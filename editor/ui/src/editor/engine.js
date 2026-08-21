"use strict";
/* Demo-video editor engine: canvas preview + timeline renderers, resolve/EMA
   math mirrored from compositor.py, per-segment undo history, edit ops.
   Vue components bind to `ui` (reactive) and call the exported ops; the draw
   paths and playback loop stay off the reactivity graph. */
import { reactive } from "vue";

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

const PULSE_COLOR = [10, 10, 12];
const CUR_PATH = [[6.4,2],[6.4,18.9],[10.4,15.1],[12.9,20.9],[15.7,19.7],[13.2,13.9],[18.6,13.9]];
const TIP = [6.4, 2];

export const KNOB_DEFAULTS = {
  PANEL_SCALE: 1, PANEL_BASE_W: 1460, MARGIN: 80, RAD: 20,
  ZOOM_EMA: 0.11, PAN_EMA: 0.13, END_EXTRA: 95,
  GRAD: [[0,[238,242,255]],[0.5,[237,233,254]],[1,[250,232,255]]],
  SHADOW_ALPHA: 120, SHADOW_BLUR: 34, CURSOR_CSS_H: 34, PULSE_N: 18,
  KEY_H: 46, KEY_INSET: 34, KEY_N: 58, CAP_H: 46, CRF: 18,
};

export const BG_PRESETS = [
  { name: "Indigo", grad: [[0,[238,242,255]],[0.5,[237,233,254]],[1,[250,232,255]]] },
  { name: "Slate", grad: [[0,[15,23,42]],[0.5,[30,41,59]],[1,[51,65,85]]] },
  { name: "Sunset", grad: [[0,[254,240,215]],[0.5,[253,219,189]],[1,[251,207,232]]] },
  { name: "Forest", grad: [[0,[240,253,244]],[0.5,[220,252,231]],[1,[187,247,208]]] },
  { name: "Mono dark", grad: [[0,[23,23,27]],[0.5,[39,39,45]],[1,[63,63,70]]] },
  { name: "Paper light", grad: [[0,[250,250,249]],[0.5,[245,245,244]],[1,[231,229,228]]] },
];
export const ZOOM_STOPS = [["Wide", 1], ["Slight", 1.2], ["Medium", 1.5], ["Close", 1.8]];
export const SIMPLE = [
  { id: "padding", label: "Padding", card: "style", keys: ["MARGIN"], visual: true,
    opts: [["None", [0]], ["S", [36]], ["M", [80]], ["L", [120]]] },
  { id: "corners", label: "Corners", card: "style", keys: ["RAD"], visual: true,
    opts: [["Small", [10]], ["Medium", [20]], ["Large", [32]]] },
  { id: "shadow", label: "Shadow", card: "style", keys: ["SHADOW_ALPHA", "SHADOW_BLUR"], visual: true,
    opts: [["None", [0, 0]], ["Subtle", [70, 24]], ["Soft", [120, 34]]],
    match: (k, v) => (v[0] === 0 ? k.SHADOW_ALPHA === 0 : k.SHADOW_ALPHA === v[0] && k.SHADOW_BLUR === v[1]) },
  { id: "feel", label: "Camera feel", card: "camera", keys: ["ZOOM_EMA", "PAN_EMA"], path: true, wide: true,
    opts: [["Snappy", [0.2, 0.24]], ["Smooth", [0.11, 0.13]], ["Cinematic", [0.06, 0.08]]] },
  { id: "hold", label: "Ending hold", card: "pacing", keys: ["END_EXTRA"], path: true,
    opts: [["Short", [40]], ["Medium", [95]], ["Long", [160]]] },
  { id: "cursor", label: "Cursor size", card: "cursor", keys: ["CURSOR_CSS_H"], visual: true,
    opts: [["Hide", [0]], ["S", [26]], ["M", [34]], ["L", [44]]] },
  { id: "keyson", label: "Keycap hints", card: "cursor", keys: ["KEY_N"], visual: true,
    opts: [["On", [58]], ["Off", [0]]],
    match: (k, v) => (v[0] === 0) === (k.KEY_N === 0) },
  { id: "keysize", label: "Hint size", card: "cursor", keys: ["KEY_H"], visual: true,
    opts: [["S", [36]], ["M", [46]], ["L", [58]]] },
  { id: "quality", label: "Quality", card: "export", keys: ["CRF"],
    opts: [["Good", [20]], ["High", [18]]] },
  { id: "res", label: "Resolution", card: "export", keys: ["PANEL_SCALE"], visual: true,
    opts: [["Standard", [1]], ["Retina", [2]]] },
];

export const state = {
  segStates: new Map(),          // name -> {meta, knobs, origReps, undo, redo, lastSaved}
  meta: null, knobs: null,
  playhead: 0, playing: false, playDir: 1,
  res: null, path: null, eStarts: null, eTotal: 0,
  tl: { pxpf: 0, scroll0: 0 },
  lastGeom: null, lastBitmap: null,
};

export const ui = reactive({
  rev: 0,
  segments: [], order: [], seg: null,
  sel: null,
  playing: false,
  timeCur: "0:00.0", timeTotal: "0:00.0",
  dirty: false, saveLabel: "",
  canUndo: false, canRedo: false,
  render: { status: "idle", lines: [], progress: null, open: false,
            segments: [], outputs: [], error: null },
  ctxOptions: [],
  prompt: null,
  shortcuts: false,
});

const bump = () => { ui.rev++; };
const segState = () => state.segStates.get(ui.seg);

if (typeof window !== "undefined") window.__editor = { state, ui, segState };

/* ---------- knobs ---------- */
export function knobsFromSaved(k) {
  const out = { ...KNOB_DEFAULTS, ...k };
  const ps = out.PANEL_SCALE || 1;
  if (k.MARGIN !== undefined) out.MARGIN = k.MARGIN / ps;
  if (k.RAD !== undefined) out.RAD = k.RAD / ps;
  return out;
}
export function knobsForSave(k) {
  return { ...k, MARGIN: Math.round(k.MARGIN * k.PANEL_SCALE), RAD: Math.round(k.RAD * k.PANEL_SCALE) };
}
export const rgbHex = (c) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
export const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/* ---------- history ---------- */
const HISTORY_MAX = 100;
let gesture = null;
const snapshot = () => JSON.stringify({ meta: state.meta, knobs: state.knobs });

function syncHistoryUI() {
  const st = segState();
  ui.canUndo = !!st && st.undo.length > 0;
  ui.canRedo = !!st && st.redo.length > 0;
  ui.dirty = !!st && snapshot() !== st.lastSaved;
  ui.saveLabel = ui.dirty ? "unsaved changes" : ui.saveLabel === "saved" ? "saved" : "";
}
export function beginGesture() {
  if (!gesture && state.meta) gesture = { snap: snapshot() };
}
export function commitGesture() {
  if (!gesture) return;
  const st = segState();
  if (st && snapshot() !== gesture.snap) {
    st.undo.push(gesture.snap);
    if (st.undo.length > HISTORY_MAX) st.undo.shift();
    st.redo.length = 0;
  }
  gesture = null;
  syncHistoryUI();
}
export function applyEdit(fn) {
  if (gesture) { fn(); return; }
  beginGesture();
  fn();
  commitGesture();
}
function restore(snap) {
  const st = segState();
  const data = JSON.parse(snap);
  st.meta = state.meta = data.meta;
  st.knobs = state.knobs = data.knobs;
  validateSel();
  bgKey = "";
  rebuild();
  bump();
  syncHistoryUI();
  schedule("preview"); schedule("timeline");
}
export function undo() {
  commitGesture();
  const st = segState();
  if (!st || !st.undo.length) return;
  const cur = snapshot();
  st.redo.push(cur);
  restore(st.undo.pop());
}
export function redo() {
  commitGesture();
  const st = segState();
  if (!st || !st.redo.length) return;
  st.undo.push(snapshot());
  restore(st.redo.pop());
}
function validateSel() {
  const sel = ui.sel, m = state.meta;
  if (!sel || !m) return;
  const bad =
    (sel.type === "cam" && !blockContaining(sel.entry)) ||
    (sel.type === "still" && !(sel.entry < m.frames.length && (m.frames[sel.entry].repeat ?? 1) > 1)) ||
    (sel.type === "speed" && !(m.speed || [])[sel.idx]) ||
    (sel.type === "click" && !(m.clicks || [])[sel.idx]) ||
    (sel.type === "key" && !(m.keys || [])[sel.idx]) ||
    (sel.type === "caption" && !(m.captions || [])[sel.idx]);
  if (bad) ui.sel = null;
}

/* ---------- resolve (mirror of server.resolve_meta) ---------- */
export const RAMP_DEFAULT = 0.6;

// Mirror of server.smooth_mults: raised-cosine easing of speed changes in log
// space, replicate-padded; the 1e-6 rounding collapses libm-vs-V8 ulp drift so
// both sides resample identical numbers. Uniform input is returned untouched.
export function smoothMults(mults, fps, ramp) {
  const n = mults.length;
  if (n === 0 || mults.every((v) => v === mults[0])) return mults;
  const w = Math.floor(fps * Math.max(ramp, 0) + 0.5) | 1;
  if (w <= 1) return mults;
  const half = (w - 1) >> 1;
  const ker = [];
  for (let d = -half; d <= half; d++) ker.push(1 + Math.cos((Math.PI * d) / (half + 1)));
  const ksum = ker.reduce((a, b) => a + b, 0);
  const logs = mults.map((v) => Math.log(v));
  const out = [];
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let d = -half; d <= half; d++) {
      const j = Math.min(Math.max(i + d, 0), n - 1);
      acc += ker[d + half] * logs[j];
    }
    out.push(Math.floor(Math.exp(acc / ksum) * 1e6 + 0.5) / 1e6);
  }
  return out;
}

export function resolveMeta(m) {
  const n = m.frames.length;
  const trim = m.trim || {};
  const tin = trim.in ?? 0, tout = Math.min(trim.out ?? n - 1, n - 1);
  let reps = m.frames.map((f) => f.repeat ?? 1);
  for (let i = 0; i < n; i++) if (i < tin || i > tout) reps[i] = 0;
  const pace = m.pace > 0 ? m.pace : 1;
  let mults = new Array(n).fill(pace);
  for (const sp of m.speed || []) {
    if (!(sp.mult > 0)) continue;
    for (let i = Math.max(0, sp.from); i < Math.min(n, sp.to); i++) mults[i] *= sp.mult;
  }
  mults = smoothMults(mults, m.fps || 60, m.speedRamp ?? RAMP_DEFAULT);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    if (!reps[i]) continue;
    if (mults[i] === 1) { acc = 0; continue; }
    acc += reps[i] / mults[i];
    const q = Math.floor(acc); acc -= q; reps[i] = q;
  }
  let last = 0;
  for (let i = 0; i < n; i++) if (reps[i] > 0) last = i;
  const frames = m.frames.slice(0, last + 1);
  reps = reps.slice(0, last + 1);
  const kept = [];
  for (let i = 0; i < frames.length; i++) if (reps[i] > 0) kept.push(i);
  const snap = (i) => { for (const q of kept) if (q >= i) return q; return kept.length ? kept[kept.length - 1] : null; };
  const remap = (ev) => (ev || []).map((e) => ({ ...e, i: snap(e.i) })).filter((e) => e.i !== null);
  const hideCur = new Uint8Array(frames.length);
  for (const r of m.cursorHide || [])
    for (let i = Math.max(0, r.from); i < Math.min(frames.length, r.to); i++) hideCur[i] = 1;
  const capText = new Array(frames.length).fill(null); // later regions win, like resolve.py
  for (const c of m.captions || [])
    for (let i = Math.max(0, c.from); i < Math.min(frames.length, c.to); i++) capText[i] = c.text;
  return { frames, reps, kept, hideCur, capText, clicks: remap(m.clicks), keys: remap(m.keys) };
}

export function rebuild() {
  const m = state.meta, k = state.knobs;
  const res = (state.res = resolveMeta(m));
  const { frames, reps } = res;
  const starts = new Int32Array(frames.length);
  let pf = 0;
  for (let i = 0; i < frames.length; i++) { starts[i] = reps[i] > 0 ? pf : -1; pf += reps[i]; }
  const total = pf + k.END_EXTRA;
  const srcEntry = new Int32Array(total), Z = new Float64Array(total),
        FX = new Float64Array(total), FY = new Float64Array(total);
  const clip = m.clip, dsf = m.dsf;
  const fpx = (f) => [(f.cx - clip.x) * dsf, (f.cy - clip.y) * dsf];
  let zc = frames[0].z, [fx, fy] = fpx(frames[0]), n = 0;
  const step = (i, f) => {
    zc += (f.z - zc) * k.ZOOM_EMA;
    const [tx, ty] = fpx(f);
    fx += (tx - fx) * k.PAN_EMA; fy += (ty - fy) * k.PAN_EMA;
    srcEntry[n] = i; Z[n] = zc; FX[n] = fx; FY[n] = fy; n++;
  };
  for (let i = 0; i < frames.length; i++) for (let q = 0; q < reps[i]; q++) step(i, frames[i]);
  for (let q = 0; q < k.END_EXTRA; q++) step(frames.length - 1, frames[frames.length - 1]);
  state.path = { srcEntry, Z, FX, FY, total, bodyLen: pf, starts };

  const em = m.frames, eStarts = new Int32Array(em.length);
  let e = 0;
  for (let i = 0; i < em.length; i++) { eStarts[i] = e; e += em[i].repeat ?? 1; }
  state.eStarts = eStarts; state.eTotal = e;
  state.playhead = clamp(state.playhead, 0, total - 1);
}

export function geom() {
  const { clip, dsf } = state.meta, k = state.knobs, PS = k.PANEL_SCALE;
  const SW = clip.width * dsf, SH = clip.height * dsf;
  let PW = Math.min(k.PANEL_BASE_W * PS, SW); PW -= PW % 2;
  let PH = Math.round((PW * SH) / SW); PH -= PH % 2;
  const M = Math.round(k.MARGIN * PS);
  let BW = PW + 2 * M; BW -= BW % 2;
  let BH = PH + 2 * M; BH -= BH % 2;
  return { SW, SH, PW, PH, M, BW, BH, PS };
}

/* ---------- edited <-> resolved playhead mapping ---------- */
export function entryAtPf(epf) {
  const s = state.eStarts;
  epf = clamp(epf, 0, state.eTotal - 1);
  let lo = 0, hi = s.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (s[mid] <= epf) lo = mid; else hi = mid - 1; }
  return lo;
}
export function editedToResolved(epf) {
  const i = entryAtPf(epf), off = epf - state.eStarts[i];
  const { starts } = state.path, { reps, kept } = state.res;
  if (i < reps.length && reps[i] > 0) return starts[i] + Math.min(off, reps[i] - 1);
  for (const q of kept) if (q >= i) return starts[q];
  return kept.length ? starts[kept[kept.length - 1]] : 0;
}
export function resolvedToEdited(pf) {
  pf = clamp(pf, 0, state.path.total - 1);
  const i = state.path.srcEntry[pf];
  const off = pf - state.path.starts[i];
  return state.eStarts[i] + Math.min(Math.max(off, 0), (state.meta.frames[i].repeat ?? 1) - 1);
}

/* ---------- bitmap cache ---------- */
const cache = new Map(), pendingSet = new Set();
let fetchQueue = [], inflight = 0, wantedEntry = -1;
// decoded frames are huge (a DSF-2 capture is ~19MB each): cap the cache by a
// byte budget scaled to device RAM, not a fixed count
const CACHE_BUDGET = ((navigator.deviceMemory || 8) >= 8 ? 600
                      : (navigator.deviceMemory || 8) >= 4 ? 300 : 150) * 1e6;
function cacheCap() {
  const m = state.meta;
  if (!m) return 24;
  const bytes = m.clip.width * m.dsf * m.clip.height * m.dsf * 4;
  return Math.max(12, Math.min(260, Math.floor(CACHE_BUDGET / bytes)));
}
const frameURL = (i) => `/api/segment/${encodeURIComponent(ui.seg)}/frame/${i}`;
function requestFrame(i, urgent) {
  if (cache.has(i) || pendingSet.has(i)) return;
  pendingSet.add(i);
  if (urgent) fetchQueue.unshift(i); else fetchQueue.push(i);
  pumpFetch();
}
function pumpFetch() {
  while (inflight < 6 && fetchQueue.length) {
    const i = fetchQueue.shift(), seg = ui.seg;
    inflight++;
    fetch(frameURL(i))
      .then((r) => { if (!r.ok) throw new Error(); return r.blob(); })
      .then((b) => createImageBitmap(b))
      .then((bm) => {
        if (seg !== ui.seg) { bm.close(); return; }
        cache.set(i, bm);
        const cap = cacheCap();
        while (cache.size > cap) { const k = cache.keys().next().value; cache.get(k).close(); cache.delete(k); }
        if (i === wantedEntry) schedule("preview");
      })
      .catch(() => {})
      .finally(() => { pendingSet.delete(i); inflight--; pumpFetch(); });
  }
}
function getBitmap(i) {
  const b = cache.get(i);
  if (b) { cache.delete(i); cache.set(i, b); }
  return b;
}
function clearCache() {
  for (const b of cache.values()) b.close();
  cache.clear(); pendingSet.clear(); fetchQueue = [];
}
function prefetch(entry) {
  const { kept } = state.res;
  let pos = kept.indexOf(entry);
  if (pos < 0) pos = 0;
  for (let d = 1; d <= 30; d++) {
    const q = kept[pos + d * state.playDir];
    if (q !== undefined) requestFrame(q);
  }
  for (let d = 1; d <= 4; d++) {
    const q = kept[pos - d * state.playDir];
    if (q !== undefined) requestFrame(q);
  }
}

/* ---------- canvases (registered by Vue components) ---------- */
const cvs = { preview: null, previewWrap: null, timeline: null, timelineWrap: null };
export function registerCanvases(map) {
  Object.assign(cvs, map);
  for (const key of ["previewWrap", "timelineWrap"]) {
    if (map[key]) new ResizeObserver(() => { schedule("preview"); schedule("timeline"); }).observe(map[key]);
  }
  schedule("preview"); schedule("timeline");
}

/* ---------- background (gradient + central lift) ---------- */
let bgCanvas = null, bgKey = "";
function bgFor(g, K) {
  const key = JSON.stringify([g.BW, g.BH, K, state.knobs.GRAD]);
  if (bgKey === key) return bgCanvas;
  bgKey = key;
  const W = Math.round(g.BW * K), H = Math.round(g.BH * K);
  bgCanvas = new OffscreenCanvas(W, H);
  const c = bgCanvas.getContext("2d");
  const d = W + H;
  const lg = c.createLinearGradient(0, 0, d / 2, d / 2);
  for (const [t, col] of state.knobs.GRAD) lg.addColorStop(clamp(t, 0, 1), rgbHex(col));
  c.fillStyle = lg; c.fillRect(0, 0, W, H);
  c.save();
  c.translate(W / 2, H / 2); c.scale(1, H / W);
  const rg = c.createRadialGradient(0, 0, 0, 0, 0, W * 0.78);
  rg.addColorStop(0, "rgba(255,255,255,0.157)");
  rg.addColorStop(0.85, "rgba(255,255,255,0.14)");
  rg.addColorStop(1, "rgba(255,255,255,0.09)");
  c.fillStyle = rg;
  c.fillRect(-W / 2, (-H / 2) * (W / H), W, H * (W / H));
  c.restore();
  return bgCanvas;
}

/* ---------- preview ---------- */
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, Math.max(0.5, r));
}
function drawPreview() {
  const m = state.meta;
  if (!m || !cvs.preview || !cvs.previewWrap) return;
  const g = geom(), cv = cvs.preview, wrap = cvs.previewWrap;
  const availW = wrap.clientWidth - 28, availH = wrap.clientHeight - 28;
  if (availW < 50 || availH < 50) return;
  const fit = Math.min(availW / g.BW, availH / g.BH);
  const cssW = Math.round(g.BW * fit), cssH = Math.round(g.BH * fit);
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
    cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
    cv.style.width = cssW + "px"; cv.style.height = cssH + "px";
  }
  const K = cv.width / g.BW;
  const ctx = cv.getContext("2d");
  const pf = clamp(Math.round(state.playhead), 0, state.path.total - 1);
  const entry = state.path.srcEntry[pf];
  wantedEntry = entry;
  let bmp = getBitmap(entry);
  if (!bmp) { requestFrame(entry, true); bmp = state.lastBitmap; }
  else state.lastBitmap = bmp;
  prefetch(entry);

  const k = state.knobs, clip = m.clip, dsf = m.dsf;
  const z = state.path.Z[pf], fx = state.path.FX[pf], fy = state.path.FY[pf];
  const s = (g.PW * z) / g.SW, pw = g.PW * z, ph = g.PH * z;
  const place = (want, span, bound) => {
    let lo = g.M, hi = bound - g.M - span;
    if (lo > hi) [lo, hi] = [hi, lo];
    return clamp(want, lo, hi);
  };
  const ox = place(g.BW / 2 - fx * s, pw, g.BW), oy = place(g.BH / 2 - fy * s, ph, g.BH);
  state.lastGeom = { ox, oy, s, K, g };

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(bgFor(g, K), 0, 0, cv.width, cv.height);

  const rad = Math.max(1, k.RAD * g.PS * z);
  ctx.save();
  ctx.shadowColor = `rgba(15,23,42,${(k.SHADOW_ALPHA / 255).toFixed(3)})`;
  ctx.shadowBlur = 2 * k.SHADOW_BLUR * g.PS * K;
  ctx.shadowOffsetY = 10 * g.PS * z * K;
  ctx.fillStyle = "#0f172a";
  roundRect(ctx, ox * K, oy * K, pw * K, ph * K, rad * K);
  ctx.fill();
  ctx.restore();

  ctx.save();
  roundRect(ctx, ox * K, oy * K, pw * K, ph * K, rad * K);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if (bmp) ctx.drawImage(bmp, ox * K, oy * K, pw * K, ph * K);
  else { ctx.fillStyle = "#111"; ctx.fillRect(ox * K, oy * K, pw * K, ph * K); }

  const size = Math.max(8, Math.round(k.CURSOR_CSS_H * dsf * s));
  for (const c of (k.CURSOR_CSS_H > 0 ? state.res.clicks : [])) {
    const start = state.path.starts[c.i];
    if (start < 0) continue;
    const age = pf - start;
    if (age < 0 || age >= k.PULSE_N) continue;
    const t = age / k.PULSE_N;
    const r = size * (0.42 + 1.15 * (1 - (1 - t) ** 2)), a = (170 * (1 - t)) / 255;
    if (a <= 0 || r < 2) continue;
    ctx.beginPath();
    ctx.arc((ox + (c.x - clip.x) * dsf * s) * K, (oy + (c.y - clip.y) * dsf * s) * K, r * K, 0, 7);
    ctx.strokeStyle = `rgba(${PULSE_COLOR},${a.toFixed(3)})`;
    ctx.lineWidth = Math.max(1, size * 0.1 * (1 - 0.4 * t)) * K;
    ctx.stroke();
  }
  const fr = state.res.frames[entry];
  if (k.CURSOR_CSS_H > 0 && fr && fr.mx !== undefined && fr.mx !== null && !state.res.hideCur[entry]) {
    const px = (ox + (fr.mx - clip.x) * dsf * s) * K, py = (oy + (fr.my - clip.y) * dsf * s) * K;
    const u = (size / 24) * K;
    ctx.save();
    ctx.translate(px - TIP[0] * u, py - TIP[1] * u);
    ctx.beginPath();
    for (let i = 0; i < CUR_PATH.length; i++) {
      const [x, y] = CUR_PATH[i];
      i ? ctx.lineTo(x * u, y * u) : ctx.moveTo(x * u, y * u);
    }
    ctx.closePath();
    ctx.shadowColor = "rgba(15,23,42,0.43)";
    ctx.shadowBlur = 5 * u; ctx.shadowOffsetY = 2 * u;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2.2 * u;
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.shadowColor = "transparent";
    ctx.fillStyle = "rgb(10,10,12)";
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();

  const capH = drawCaptionHud(ctx, pf, g, K);
  drawKeyHud(ctx, pf, g, K, capH ? capH + 10 * g.PS * K : 0);
  updateTransport(pf);
}

// mirrors compositor.py cap_sprite/draw_caption: rounded ink bar, wrapped
// centered text, fade in/out over the caption run, slight rise on entry
function drawCaptionHud(ctx, pf, g, K) {
  const k = state.knobs, capText = state.res.capText;
  if (!capText || k.CAP_H === 0) return 0;
  const e = state.path.srcEntry[clamp(Math.round(pf), 0, state.path.total - 1)];
  const text = capText[e];
  if (!text) return 0;
  let i0 = e, i1 = e;
  while (i0 > 0 && capText[i0 - 1] === text) i0--;
  while (i1 < capText.length - 1 && capText[i1 + 1] === text) i1++;
  let startPf = -1;
  for (let i = i0; i <= i1 && startPf < 0; i++) startPf = state.path.starts[i];
  let endPf = state.path.total;
  for (let j = i1 + 1; j < capText.length; j++)
    if (state.path.starts[j] >= 0) { endPf = state.path.starts[j]; break; }
  if (startPf < 0) return 0;
  const age = pf - startPf, remain = endPf - pf;
  const a = Math.min(1, age / 8) * Math.min(1, remain / 8);
  if (a <= 0) return 0;
  const lh = Math.round(k.CAP_H * g.PS) * K;
  ctx.save();
  ctx.globalAlpha = a;
  ctx.font = `600 ${lh * 0.5}px -apple-system, "SF Pro Text", sans-serif`;
  ctx.textBaseline = "middle"; ctx.textAlign = "center";
  const maxw = g.BW * K * 0.72;
  const lines = [];
  let cur = "";
  for (const word of text.split(/\s+/)) {
    const t = (cur + " " + word).trim();
    if (cur && ctx.measureText(t).width > maxw) { lines.push(cur); cur = word; }
    else cur = t;
  }
  if (cur) lines.push(cur);
  const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
  const padX = lh * 0.55, padY = lh * 0.24, gap = lh * 0.08;
  const w = tw + 2 * padX, h = lines.length * lh + (lines.length - 1) * gap + 2 * padY;
  const rise = (1 - Math.min(1, age / 9)) * 10 * g.PS * K;
  const x = (g.BW * K - w) / 2;
  const y = g.BH * K - k.KEY_INSET * g.PS * K - h + rise;
  ctx.shadowColor = "rgba(15,23,42,0.55)";
  ctx.shadowBlur = lh * 0.3; ctx.shadowOffsetY = lh * 0.1;
  ctx.fillStyle = "rgba(15,23,42,0.92)";
  roundRect(ctx, x, y, w, h, lh * 0.42);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.fillStyle = "#fff";
  lines.forEach((l, i) =>
    ctx.fillText(l, g.BW * K / 2, y + padY + i * (lh + gap) + lh / 2 + lh * 0.02));
  ctx.restore();
  return h;
}

function drawKeyHud(ctx, pf, g, K, lift = 0) {
  const k = state.knobs;
  let best = null;
  for (const ke of state.res.keys) {
    const start = state.path.starts[ke.i];
    if (start < 0) continue;
    const age = pf - start;
    if (age < 0 || age >= k.KEY_N) continue;
    if (!best || start >= best.start) best = { text: ke.text, age, start };
  }
  if (!best) return;
  const a = Math.min(1, best.age / 5) * Math.min(1, (k.KEY_N - best.age) / 12);
  if (a <= 0) return;
  const h = Math.round(k.KEY_H * g.PS) * K;
  const pad = h * 0.34, gap = h * 0.18, rad = h * 0.27;
  ctx.save();
  ctx.globalAlpha = a;
  // deliberately SF, not the UI font: mirrors compositor.py's rendered keycaps
  ctx.font = `600 ${h * 0.42}px -apple-system, "SF Pro Text", sans-serif`;
  ctx.textBaseline = "middle"; ctx.textAlign = "center";
  const caps = best.text.split("+").map((c) => c.trim()).filter(Boolean);
  const ws = caps.map((c) => Math.max(h, ctx.measureText(c).width + 2 * pad));
  const totalW = ws.reduce((x, y) => x + y, 0) + gap * (caps.length - 1);
  const rise = (1 - Math.min(1, best.age / 9)) * 12 * g.PS * K;
  let x = (g.BW * K - totalW) / 2;
  const y = g.BH * K - k.KEY_INSET * g.PS * K - h + rise - lift;
  ctx.shadowColor = "rgba(15,23,42,0.55)";
  ctx.shadowBlur = h * 0.3; ctx.shadowOffsetY = h * 0.1;
  for (let i = 0; i < caps.length; i++) {
    ctx.fillStyle = "rgba(15,23,42,0.94)";
    roundRect(ctx, x, y, ws[i], h, rad);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.fillStyle = "#fff";
    ctx.fillText(caps[i], x + ws[i] / 2, y + h / 2 + h * 0.02);
    ctx.shadowColor = "rgba(15,23,42,0.55)";
    x += ws[i] + gap;
  }
  ctx.restore();
}

/* ---------- transport + playback ---------- */
function fmtTime(pf, fps) {
  const t = pf / fps, m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, "0")}`;
}
// Canonical duration is the body without the END_EXTRA hold tail; the tail
// shows as a hatched extension past the end marker instead of extra seconds.
function updateTransport(pf) {
  const fps = state.meta.fps || 60;
  ui.timeCur = fmtTime(Math.min(pf, state.path.bodyLen), fps);
  ui.timeTotal = fmtTime(state.path.bodyLen, fps);
}
export function setPlayhead(pf, fromPlay) {
  state.playhead = clamp(pf, 0, state.path.total - 1);
  schedule("preview"); schedule("timeline");
  if (!fromPlay && state.playing) stopPlayback();
}
let playT0 = 0, playPf0 = 0, rafId = null;
export function startPlayback() {
  state.playing = ui.playing = true;
  state.playDir = 1;
  playT0 = performance.now();
  playPf0 = state.playhead >= state.path.total - 1 ? 0 : state.playhead;
  const tick = (ts) => {
    if (!state.playing) return;
    const fps = state.meta.fps || 60;
    let pf = playPf0 + ((ts - playT0) / 1000) * fps;
    if (pf >= state.path.total) { playT0 = ts; playPf0 = 0; pf = 0; }
    setPlayhead(Math.floor(pf), true);
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}
export function stopPlayback() {
  state.playing = ui.playing = false;
  if (rafId) cancelAnimationFrame(rafId);
}
export function togglePlay() { state.playing ? stopPlayback() : startPlayback(); }
export function stepFrame(d) {
  state.playDir = d > 0 ? 1 : -1;
  setPlayhead(state.playhead + d);
}
export function scrubTo(v) { setPlayhead(Math.round(v)); }

/* ---------- timeline ---------- */
// Row layout (CSS px from the top of the timeline canvas). The Vue gutter
// column aligns its transport + track labels to these same offsets.
export const TL = { RUL: 32, CAM: [40, 40], TIM: [88, 40], EVT: [136, 24] };
export const TL_TRACKS = [
  { label: "Camera", row: TL.CAM },
  { label: "Holds", row: TL.TIM },
  { label: "Events", row: TL.EVT },
];
export const TL_MIN_H = 176;
export const TL_MAX_H = 420;

// Panel resize: lanes share the extra height (base 40/40/24 at 176px total),
// arrays mutate in place so TL_TRACKS row references stay valid.
export function setTimelineHeight(total) {
  const f = Math.max(104, total - 72) / 104;
  const h1 = Math.round(40 * f), h2 = Math.round(40 * f), h3 = Math.round(24 * f);
  TL.CAM[1] = h1;
  TL.TIM[0] = TL.CAM[0] + h1 + 8; TL.TIM[1] = h2;
  TL.EVT[0] = TL.TIM[0] + h2 + 8; TL.EVT[1] = h3;
  schedule("timeline");
}

/* Chrome colors come from frappe-ui's semantic CSS vars so both themes work;
   re-read after data-theme flips (themeChanged). The chip radius and font
   family resolve from CSS too, so canvas text/shapes track the DOM styling. */
let pal = null;
function palette() {
  if (pal) return pal;
  const cs = getComputedStyle(document.documentElement);
  const v = (name) => cs.getPropertyValue(name).trim();
  pal = {
    base: v("--surface-base"), lane: v("--surface-gray-1"),
    chip: v("--surface-gray-3"), pill: v("--surface-gray-4"),
    strong: v("--surface-gray-9"), strongInk: v("--surface-base"),
    line: v("--outline-gray-1"), edge: v("--outline-gray-2"), tick: v("--outline-gray-3"),
    ink: v("--ink-gray-9"), ink7: v("--ink-gray-7"), ink6: v("--ink-gray-6"), ink5: v("--ink-gray-5"),
    chipR: parseFloat(v("--chip-radius")) || 4,
    speedTint: v("--speed-tint") || "#3b82f6", speedInk: v("--speed-ink") || "#1d4ed8",
    font: getComputedStyle(document.body).fontFamily,
  };
  return pal;
}
// text-2xs equivalent of the app font; chip labels get a medium weight
const tlFont = (px, weight = 420) => `${weight} ${px}px ${palette().font}`;
// every timeline chip shares --chip-radius, clamped so tiny shapes stay sane
function chipRect(ctx, x, y, w, h) {
  const r = Math.max(0.5, Math.min(palette().chipR, w / 2, h / 2));
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}
export function themeChanged() {
  pal = null; hatch = null; speedHatch = null;
  schedule("preview"); schedule("timeline");
}
// tokens may resolve to hex or solid oklch depending on the frappe-ui version
function withAlpha(color, a) {
  const ok = color.match(/^oklch\(([^/)]+)\)$/);
  if (ok) return `oklch(${ok[1].trim()} / ${a})`;
  if (color.startsWith("#")) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    return `rgba(${r},${g},${b},${a})`;
  }
  return color;
}
let hatch = null;
let speedHatch = null;
function speedHatchFor(ctx) {
  if (speedHatch) return speedHatch;
  const t = new OffscreenCanvas(7, 7), c = t.getContext("2d");
  c.strokeStyle = withAlpha(palette().speedTint, 0.32);
  c.lineWidth = 1.25;
  c.beginPath(); c.moveTo(-2, 9); c.lineTo(9, -2); c.stroke();
  speedHatch = ctx.createPattern(t, "repeat");
  return speedHatch;
}

function hatchFor(ctx) {
  if (hatch) return hatch;
  const t = new OffscreenCanvas(7, 7), c = t.getContext("2d");
  c.strokeStyle = withAlpha(palette().ink, 0.14);
  c.lineWidth = 1.25;
  c.beginPath(); c.moveTo(-2, 9); c.lineTo(9, -2); c.stroke();
  hatch = ctx.createPattern(t, "repeat");
  return hatch;
}
const fmtZoom = (z) => ((+z).toFixed(2).replace(/\.?0+$/, "") || "1") + "×";

export function camBlocks() {
  const fr = state.meta.frames, blocks = [];
  let cur = null;
  for (let i = 0; i < fr.length; i++) {
    const f = fr[i];
    if (cur && !f.cut && f.z === cur.z && f.cx === cur.cx && f.cy === cur.cy) cur.i1 = i;
    else { cur = { i0: i, i1: i, z: f.z, cx: f.cx, cy: f.cy }; blocks.push(cur); }
  }
  return blocks;
}
export function blockContaining(entry) {
  return camBlocks().find((b) => entry >= b.i0 && entry <= b.i1) || null;
}
const tlX = (epf) => (epf - state.tl.scroll0) * state.tl.pxpf;
const tlPf = (x) => state.tl.scroll0 + x / state.tl.pxpf;
const entryEndPf = (i) => state.eStarts[i] + (state.meta.frames[i].repeat ?? 1);
function trimXs() {
  const m = state.meta, trim = m.trim || {};
  const tin = trim.in ?? 0, tout = trim.out ?? m.frames.length - 1;
  const xin = tlX(state.eStarts[clamp(tin, 0, m.frames.length - 1)]);
  const xout = tlX(tout >= m.frames.length - 1 ? state.eTotal : entryEndPf(tout));
  return { xin, xout };
}
// x for a resolved (playback) frame; tail frames extend past the end marker
function resolvedPfX(pf) {
  if (pf > state.path.bodyLen - 1)
    return trimXs().xout + (pf - (state.path.bodyLen - 1)) * state.tl.pxpf;
  return tlX(resolvedToEdited(pf));
}
function playheadX() {
  return resolvedPfX(clamp(Math.round(state.playhead), 0, state.path.total - 1));
}

const laneBot = () => TL.EVT[0] + TL.EVT[1];

function drawTimeline() {
  if (!cvs.timeline || !cvs.timelineWrap) return;
  const cv = cvs.timeline, wrap = cvs.timelineWrap;
  const dpr = window.devicePixelRatio || 1;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !H) return;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const P = palette();
  ctx.fillStyle = P.base; ctx.fillRect(0, 0, W, H);
  if (!state.meta) return;
  if (!state.tl.pxpf)
    state.tl.pxpf = Math.max(0.02, (W - 24) / Math.max(1, state.eTotal + state.knobs.END_EXTRA));

  ctx.textBaseline = "middle";
  drawRuler(ctx, W, P);
  ctx.save();
  ctx.beginPath(); ctx.rect(0, TL.RUL, W, H - TL.RUL); ctx.clip();
  ctx.fillStyle = P.lane;
  for (const [y, h] of [TL.CAM, TL.TIM, TL.EVT]) ctx.fillRect(0, y, W, h);
  drawCameraRow(ctx, W, P);
  drawHoldsRow(ctx, W, P);
  drawEventsRow(ctx, W, P);
  drawTrimAndTail(ctx, W, P);
  ctx.restore();
  drawTrimHandles(ctx, P);
  drawPlayhead(ctx, P);
}

// Ticks are playback seconds (what the transport and rail count), mapped into
// edited-space x, so they compress through sped-up sections instead of lying.
function drawRuler(ctx, W, P) {
  const fps = state.meta.fps || 60;
  const bodySecs = Math.max(state.path.bodyLen / fps, 1 / fps);
  const pxSec = (resolvedPfX(state.path.bodyLen - 1) - resolvedPfX(0)) / bodySecs;
  const step = pxSec > 70 ? 1 : pxSec > 30 ? 2 : pxSec > 12 ? 5 : 10;
  ctx.strokeStyle = P.line;
  ctx.beginPath(); ctx.moveTo(0, TL.RUL - 0.5); ctx.lineTo(W, TL.RUL - 0.5); ctx.stroke();
  ctx.font = tlFont(11);
  const lastSec = Math.ceil((state.path.total - 1) / fps);
  for (let s = 0; s <= lastSec; s += step) {
    const x = Math.round(resolvedPfX(Math.min(s * fps, state.path.total - 1))) + 0.5;
    if (x < -20) continue;
    if (x > W) break;
    ctx.strokeStyle = P.tick;
    ctx.beginPath(); ctx.moveTo(x, TL.RUL - 7); ctx.lineTo(x, TL.RUL - 1); ctx.stroke();
    ctx.strokeStyle = withAlpha(P.ink, 0.05);
    ctx.beginPath(); ctx.moveTo(x, TL.RUL); ctx.lineTo(x, laneBot()); ctx.stroke();
    ctx.fillStyle = P.ink6;
    ctx.fillText(`${s}s`, x + 4, 13);
  }
}

function drawCameraRow(ctx, W, P) {
  const sel = ui.sel;
  const y = TL.CAM[0] + 4, h = TL.CAM[1] - 8;
  ctx.font = tlFont(11, 500);
  for (const b of camBlocks()) {
    const x0 = tlX(state.eStarts[b.i0]), x1 = tlX(entryEndPf(b.i1));
    if (x1 < 0 || x0 > W) continue;
    const selHere = sel && sel.type === "cam" && sel.entry >= b.i0 && sel.entry <= b.i1;
    const zoomed = b.z !== 1;
    chipRect(ctx, x0 + 1, y, Math.max(2, x1 - x0 - 2), h);
    ctx.fillStyle = zoomed ? P.strong : P.chip;
    ctx.fill();
    if (!zoomed) { ctx.strokeStyle = P.edge; ctx.lineWidth = 1; ctx.stroke(); }
    if (selHere) { ctx.strokeStyle = P.ink; ctx.lineWidth = 1.5; ctx.stroke(); }
    if (x1 - x0 > 34) {
      ctx.fillStyle = zoomed ? P.strongInk : P.ink6;
      ctx.fillText(fmtZoom(b.z), x0 + 8, TL.CAM[0] + TL.CAM[1] / 2 + 0.5);
    }
  }
}

function drawHoldsRow(ctx, W, P) {
  const m = state.meta, sel = ui.sel, fps = m.fps || 60;
  const entryX = (e) =>
    tlX(e >= m.frames.length ? state.eTotal : state.eStarts[clamp(e, 0, m.frames.length - 1)]);
  // feather half-width mirrors smoothMults' kernel reach on each side of a boundary
  const halfE = ((Math.floor(fps * Math.max(m.speedRamp ?? RAMP_DEFAULT, 0) + 0.5) | 1) - 1) >> 1;
  for (let si = 0; si < (m.speed || []).length; si++) {
    const sp = m.speed[si];
    if (sp.to <= 0 || sp.from >= m.frames.length) continue;
    const x0 = entryX(sp.from), x1 = entryX(sp.to);
    const selHere = sel && sel.type === "speed" && sel.idx === si;
    const fwL = clamp(entryX(sp.from + halfE) - x0, 0, (x1 - x0) / 2);
    const fwR = clamp(x1 - entryX(sp.to - halfE), 0, (x1 - x0) / 2);
    drawSpeedRegion(ctx, P, x0, x1, fwL, fwR, selHere);
    if (x1 - x0 > 34) {
      ctx.font = tlFont(11, 500);
      const label = `${sp.mult}×`, w = ctx.measureText(label).width;
      ctx.fillStyle = withAlpha(P.base, 0.85);
      chipRect(ctx, x0 + 5, TL.TIM[0] + 5, w + 10, 16);
      ctx.fill();
      ctx.fillStyle = P.speedInk;
      ctx.fillText(label, x0 + 10, TL.TIM[0] + 13.5);
    }
  }
  const y = TL.TIM[0] + 8, h = TL.TIM[1] - 16;
  for (let i = 0; i < m.frames.length; i++) {
    const rep = m.frames[i].repeat ?? 1;
    if (rep <= 1) continue;
    const x0 = tlX(state.eStarts[i]), x1 = tlX(state.eStarts[i] + rep);
    if (x1 < 0 || x0 > W) continue;
    const selHere = sel && sel.type === "still" && sel.entry === i;
    chipRect(ctx, x0 + 1, y, Math.max(2, x1 - x0 - 2), h);
    ctx.fillStyle = P.pill;
    ctx.fill();
    if (selHere) { ctx.strokeStyle = P.ink; ctx.lineWidth = 1.5; ctx.stroke(); }
    ctx.fillStyle = P.ink5;
    chipRect(ctx, x1 - 6, y + 6, 2.5, h - 12);
    ctx.fill();
    if (x1 - x0 > 40) {
      ctx.font = tlFont(11, 500);
      ctx.fillStyle = P.ink7;
      ctx.fillText(`${(rep / fps).toFixed(1)}s`, x0 + 10, TL.TIM[0] + TL.TIM[1] / 2 + 0.5);
    }
  }
  if (drag && drag.mode === "speedsel") {
    const a = tlX(state.eStarts[Math.min(drag.a, drag.b)]);
    const b2 = tlX(entryEndPf(Math.max(drag.a, drag.b)));
    chipRect(ctx, a + 0.5, TL.TIM[0] + 0.5, b2 - a - 1, TL.TIM[1] - 1);
    ctx.fillStyle = withAlpha(P.ink, 0.08);
    ctx.fill();
    ctx.save();
    ctx.strokeStyle = P.ink5; ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.restore();
  }
}

// Hatched speed overlay whose left/right edges fade over the ramp width, so
// the chip itself suggests the eased transition instead of a hard cut.
function drawSpeedRegion(ctx, P, x0, x1, fwL, fwR, selHere) {
  const y = TL.TIM[0] + 1, h = TL.TIM[1] - 2, w = x1 - x0;
  const tint = withAlpha(P.speedTint, selHere ? 0.16 : 0.1);
  ctx.save();
  chipRect(ctx, x0, y, w, h);
  ctx.clip();
  if (fwL < 1 && fwR < 1) {
    ctx.fillStyle = tint;
    ctx.fillRect(x0, y, w, h);
    ctx.fillStyle = speedHatchFor(ctx);
    ctx.fillRect(x0, y, w, h);
  } else {
    const grad = ctx.createLinearGradient(x0, 0, x1, 0);
    grad.addColorStop(0, withAlpha(P.speedTint, 0));
    grad.addColorStop(clamp(fwL / w, 0, 1), tint);
    grad.addColorStop(clamp(1 - fwR / w, 0, 1), tint);
    grad.addColorStop(1, withAlpha(P.speedTint, 0));
    ctx.fillStyle = grad;
    ctx.fillRect(x0, y, w, h);
    ctx.fillStyle = speedHatchFor(ctx);
    const step = 3;
    for (let x = 0; x < fwL; x += step) {
      const sw = Math.min(step, fwL - x);
      ctx.globalAlpha = (x + sw / 2) / fwL;
      ctx.fillRect(x0 + x, y, sw, h);
    }
    for (let x = 0; x < fwR; x += step) {
      const sw = Math.min(step, fwR - x);
      ctx.globalAlpha = (x + sw / 2) / fwR;
      ctx.fillRect(x1 - x - sw, y, sw, h);
    }
    ctx.globalAlpha = 1;
    ctx.fillRect(x0 + fwL, y, Math.max(0, w - fwL - fwR), h);
  }
  ctx.restore();
  if (selHere) {
    chipRect(ctx, x0, y, w, h);
    ctx.strokeStyle = P.ink;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

function drawEventsRow(ctx, W, P) {
  const m = state.meta, sel = ui.sel;
  const evy = TL.EVT[0] + TL.EVT[1] / 2;
  const entryX = (e) =>
    tlX(e >= m.frames.length ? state.eTotal : state.eStarts[clamp(e, 0, m.frames.length - 1)]);
  for (let ci = 0; ci < (m.captions || []).length; ci++) {
    const cp = m.captions[ci];
    const a = entryX(cp.from), b2 = entryX(cp.to);
    if (b2 < 0 || a > W) continue;
    const selHere = sel && sel.type === "caption" && sel.idx === ci;
    const bw = Math.max(b2 - a, 14);
    chipRect(ctx, a, evy - 8, bw, 16);
    ctx.fillStyle = withAlpha(P.ink5, selHere ? 0.28 : 0.14);
    ctx.fill();
    ctx.strokeStyle = selHere ? P.ink : withAlpha(P.ink5, 0.55);
    ctx.lineWidth = selHere ? 1.5 : 1;
    ctx.stroke();
    ctx.save();
    ctx.beginPath(); ctx.rect(a + 4, evy - 8, bw - 8, 16); ctx.clip();
    ctx.font = tlFont(11, 500);
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillStyle = P.ink7;
    ctx.fillText(`“${cp.text}”`, a + 6, evy + 0.5);
    ctx.restore();
  }
  ctx.save();
  ctx.strokeStyle = withAlpha(P.ink5, 0.35);
  ctx.setLineDash([2, 3]);
  for (const r of m.cursorHide || []) {
    const a = entryX(r.from), b2 = entryX(r.to);
    if (b2 < 0 || a > W) continue;
    ctx.beginPath(); ctx.moveTo(a, evy); ctx.lineTo(b2, evy); ctx.stroke();
  }
  ctx.restore();
  for (const r of m.cursorHide || []) {
    const a = entryX(r.from), b2 = entryX(r.to);
    if (b2 < 0 || a > W) continue;
    drawHiddenCursorGlyph(ctx, P, a + 7, evy);
    if (b2 - a > 64) drawHiddenCursorGlyph(ctx, P, (a + b2) / 2, evy);
  }
  for (let ci = 0; ci < (m.clicks || []).length; ci++) {
    const c = m.clicks[ci], x = tlX(state.eStarts[clamp(c.i, 0, m.frames.length - 1)]);
    if (x < -8 || x > W + 8) continue;
    const selHere = sel && sel.type === "click" && sel.idx === ci;
    ctx.beginPath(); ctx.arc(x, evy, selHere ? 5.5 : 4, 0, 7);
    ctx.fillStyle = selHere ? P.ink : P.ink6;
    ctx.fill();
    if (selHere) { ctx.strokeStyle = P.base; ctx.lineWidth = 1.5; ctx.stroke(); }
  }
  ctx.font = tlFont(11, 500);
  for (let ki = 0; ki < (m.keys || []).length; ki++) {
    const kv = m.keys[ki], x = tlX(state.eStarts[clamp(kv.i, 0, m.frames.length - 1)]);
    if (x < -40 || x > W + 40) continue;
    const selHere = sel && sel.type === "key" && sel.idx === ki;
    const label = kv.text.length > 9 ? kv.text.slice(0, 8) + "…" : kv.text;
    const w = ctx.measureText(label).width + 12;
    chipRect(ctx, x - 2, evy - 8, w, 16);
    ctx.fillStyle = P.base; ctx.fill();
    ctx.strokeStyle = selHere ? P.ink : P.tick;
    ctx.lineWidth = selHere ? 1.5 : 1;
    ctx.stroke();
    ctx.fillStyle = P.ink7;
    ctx.fillText(label, x + 4, evy + 0.5);
  }
}

// ~10px arrow cursor with a diagonal slash: marks a cursor-hidden range. The
// lane-colored under-stroke cuts the slash out of the arrow so it stays legible.
function drawHiddenCursorGlyph(ctx, P, x, y) {
  const u = 10 / 22;
  ctx.save();
  ctx.translate(x - 12.5 * u, y - 11.5 * u);
  ctx.scale(u, u);
  ctx.beginPath();
  for (let i = 0; i < CUR_PATH.length; i++) {
    const [px, py] = CUR_PATH[i];
    i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = P.ink5;
  ctx.fill();
  ctx.lineCap = "round";
  for (const [color, width] of [[P.lane, 5], [P.ink5, 2.2]]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath(); ctx.moveTo(4, 1); ctx.lineTo(21, 22); ctx.stroke();
  }
  ctx.restore();
}

function drawTrimAndTail(ctx, W, P) {
  const { xin, xout } = trimXs();
  ctx.fillStyle = withAlpha(P.base, 0.6);
  if (xin > 0) ctx.fillRect(0, TL.RUL, xin, laneBot() - TL.RUL);
  if (xout < W) ctx.fillRect(xout, TL.RUL, W - xout, laneBot() - TL.RUL);
  const tailW = state.knobs.END_EXTRA * state.tl.pxpf;
  ctx.fillStyle = withAlpha(P.strong, 0.04);
  ctx.fillRect(xout, TL.RUL, tailW, laneBot() - TL.RUL);
  ctx.fillStyle = hatchFor(ctx);
  ctx.fillRect(xout, TL.RUL, tailW, laneBot() - TL.RUL);
}

function drawTrimHandles(ctx, P) {
  const { xin, xout } = trimXs();
  ctx.fillStyle = P.ink7;
  for (const [x, dir] of [[xin, 1], [xout, -1]]) {
    ctx.fillRect(x - (dir === 1 ? 0 : 2), 10, 2, laneBot() - 10);
    chipRect(ctx, x - (dir === 1 ? 0 : 7), 10, 7, 13);
    ctx.fill();
  }
}

function drawPlayhead(ctx, P) {
  const px = playheadX();
  ctx.fillStyle = P.ink;
  ctx.fillRect(px - 0.75, 4, 1.5, laneBot() - 4);
  chipRect(ctx, px - 3.5, 2, 7, 11);
  ctx.fill();
}

/* ---------- timeline interaction ---------- */
let drag = null;
const MUTATING_MODES = new Set(["trimin", "trimout", "camedge", "stillresize", "clickdrag",
                                "keydrag", "speedsel", "capdrag", "capedgeL", "capedgeR"]);
function tlHit(x, y) {
  const m = state.meta;
  const inRow = (row) => y >= row[0] && y <= row[0] + row[1];
  const trim = m.trim || {};
  const tin = trim.in ?? 0, tout = trim.out ?? m.frames.length - 1;
  const xin = tlX(state.eStarts[clamp(tin, 0, m.frames.length - 1)]);
  const xout = tlX(tout >= m.frames.length - 1 ? state.eTotal : entryEndPf(tout));
  if (y < TL.CAM[0]) {
    if (Math.abs(x - xin) < 7) return { mode: "trimin" };
    if (Math.abs(x - xout) < 7) return { mode: "trimout" };
    return { mode: "scrub" };
  }
  if (inRow(TL.CAM)) {
    const blocks = camBlocks();
    for (let i = 0; i < blocks.length - 1; i++) {
      const bx = tlX(state.eStarts[blocks[i + 1].i0]);
      if (Math.abs(x - bx) < 5) return { mode: "camedge", left: blocks[i], right: blocks[i + 1] };
    }
    const pf = tlPf(x);
    const b = blocks.find((b2) => pf >= state.eStarts[b2.i0] && pf < entryEndPf(b2.i1));
    if (b) return { mode: "camsel", block: b };
    return { mode: "scrub" };
  }
  if (inRow(TL.TIM)) {
    for (let i = 0; i < m.frames.length; i++) {
      const rep = m.frames[i].repeat ?? 1;
      if (rep <= 1) continue;
      const x1 = tlX(state.eStarts[i] + rep);
      if (Math.abs(x - x1) < 6) return { mode: "stillresize", entry: i };
    }
    const pf = tlPf(x), en = entryAtPf(pf);
    if ((m.frames[en].repeat ?? 1) > 1) return { mode: "stillsel", entry: en };
    for (let si = 0; si < (m.speed || []).length; si++) {
      const sp = m.speed[si];
      if (en >= sp.from && en < sp.to) return { mode: "speedsel-existing", idx: si };
    }
    return { mode: "speedsel", a: en, b: en };
  }
  if (inRow(TL.EVT)) {
    const evy = TL.EVT[0] + TL.EVT[1] / 2;
    for (let ki = (m.keys || []).length - 1; ki >= 0; ki--) {
      const kx = tlX(state.eStarts[clamp(m.keys[ki].i, 0, m.frames.length - 1)]);
      if (x >= kx - 6 && x <= kx + 44 && Math.abs(y - evy) < 10) return { mode: "keydrag", idx: ki };
    }
    for (let ci = (m.clicks || []).length - 1; ci >= 0; ci--) {
      const cx = tlX(state.eStarts[clamp(m.clicks[ci].i, 0, m.frames.length - 1)]);
      if (Math.hypot(x - cx, y - evy) < 8) return { mode: "clickdrag", idx: ci };
    }
    const capX = (e) =>
      tlX(e >= m.frames.length ? state.eTotal : state.eStarts[clamp(e, 0, m.frames.length - 1)]);
    for (let ci = (m.captions || []).length - 1; ci >= 0; ci--) {
      const cp = m.captions[ci];
      const a = capX(cp.from), b2 = capX(cp.to);
      if (Math.abs(y - evy) > 10) continue;
      if (Math.abs(x - a) < 5) return { mode: "capedgeL", idx: ci };
      if (Math.abs(x - b2) < 5) return { mode: "capedgeR", idx: ci };
      if (x >= a && x <= b2)
        return { mode: "capdrag", idx: ci, e0: entryAtPf(tlPf(x)), from0: cp.from, to0: cp.to };
    }
    return { mode: "scrub" };
  }
  return { mode: "scrub" };
}

export function tlPointerDown(ev) {
  if (ev.button !== 0 || !state.meta) return;
  const rect = cvs.timeline.getBoundingClientRect();
  const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
  const hit = tlHit(x, y);
  drag = { ...hit, x0: x, y0: y, moved: false };
  if (MUTATING_MODES.has(hit.mode)) beginGesture();
  cvs.timeline.setPointerCapture(ev.pointerId);
  if (hit.mode === "scrub") applyScrub(x);
}
export function tlPointerMove(ev) {
  if (!drag) return;
  const rect = cvs.timeline.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  if (Math.abs(x - drag.x0) > 3) drag.moved = true;
  const m = state.meta;
  const pf = tlPf(x), en = () => clamp(entryAtPf(pf), 0, m.frames.length - 1);
  switch (drag.mode) {
    case "scrub": applyScrub(x); break;
    case "trimin": {
      m.trim = m.trim || {};
      m.trim.in = clamp(en(), 0, (m.trim.out ?? m.frames.length - 1) - 1);
      metaEdited(); break;
    }
    case "trimout": {
      m.trim = m.trim || {};
      m.trim.out = clamp(en(), (m.trim.in ?? 0) + 1, m.frames.length - 1);
      metaEdited(); break;
    }
    case "camedge": {
      const j = clamp(en(), drag.left.i0 + 1, drag.right.i1);
      for (let i = drag.left.i0; i < j; i++) Object.assign(m.frames[i], { z: drag.left.z, cx: drag.left.cx, cy: drag.left.cy });
      for (let i = j; i <= drag.right.i1; i++) Object.assign(m.frames[i], { z: drag.right.z, cx: drag.right.cx, cy: drag.right.cy });
      metaEdited(); break;
    }
    case "stillresize": {
      const start = state.eStarts[drag.entry];
      m.frames[drag.entry].repeat = Math.max(1, Math.round(pf - start));
      metaEdited(); break;
    }
    case "speedsel": drag.b = en(); schedule("timeline"); break;
    case "clickdrag": if (drag.moved) { m.clicks[drag.idx].i = en(); metaEdited(); } break;
    case "keydrag": if (drag.moved) { m.keys[drag.idx].i = en(); metaEdited(); } break;
    case "capdrag": {
      if (!drag.moved) break;
      const cp = m.captions[drag.idx], len = drag.to0 - drag.from0;
      cp.from = clamp(drag.from0 + en() - drag.e0, 0, m.frames.length - len);
      cp.to = cp.from + len;
      metaEdited(); break;
    }
    case "capedgeL": {
      const cp = m.captions[drag.idx];
      cp.from = clamp(en(), 0, cp.to - 1);
      metaEdited(); break;
    }
    case "capedgeR": {
      const cp = m.captions[drag.idx];
      cp.to = clamp(en() + 1, cp.from + 1, m.frames.length);
      metaEdited(); break;
    }
  }
}
export function tlPointerUp() {
  if (!drag) return;
  const m = state.meta;
  switch (drag.mode) {
    case "camsel": select({ type: "cam", entry: drag.block.i0 }); break;
    case "stillsel": case "stillresize": select({ type: "still", entry: drag.entry }); break;
    case "speedsel-existing": select({ type: "speed", idx: drag.idx }); break;
    case "clickdrag": select({ type: "click", idx: drag.idx }); break;
    case "keydrag": select({ type: "key", idx: drag.idx }); break;
    case "capdrag": case "capedgeL": case "capedgeR": select({ type: "caption", idx: drag.idx }); break;
    case "speedsel": {
      const a = Math.min(drag.a, drag.b), b = Math.max(drag.a, drag.b);
      if (drag.moved && b - a >= 1) {
        m.speed = m.speed || [];
        m.speed.push({ from: a, to: b + 1, mult: 2 });
        select({ type: "speed", idx: m.speed.length - 1 });
        metaEdited();
      } else select(null);
      break;
    }
  }
  drag = null;
  commitGesture();
  schedule("timeline");
}
function applyScrub(x) {
  const epf = tlPf(x);
  const { xout } = trimXs();
  if (x > xout) {
    const tail = Math.min(Math.round((x - xout) / state.tl.pxpf), state.knobs.END_EXTRA);
    setPlayhead(state.path.bodyLen - 1 + tail);
    return;
  }
  setPlayhead(editedToResolved(Math.round(epf)));
}
export function tlWheel(ev) {
  ev.preventDefault();
  const rect = cvs.timeline.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
    state.tl.scroll0 = clamp(state.tl.scroll0 + ev.deltaX / state.tl.pxpf, 0, Math.max(0, state.eTotal - 10));
  } else {
    const pfAt = tlPf(x);
    state.tl.pxpf = clamp(state.tl.pxpf * Math.exp(-ev.deltaY * 0.002), 0.01, 30);
    state.tl.scroll0 = clamp(pfAt - x / state.tl.pxpf, 0, Math.max(0, state.eTotal - 10));
  }
  schedule("timeline");
}

/* ---------- selection + edit bookkeeping ---------- */
export function select(sel) {
  ui.sel = sel;
  schedule("timeline");
}
export function metaEdited() {
  rebuild();
  validateSel();
  bump();
  syncHistoryUI();
  schedule("preview"); schedule("timeline");
}
export function knobsEdited(visual) {
  if (visual) { bgKey = ""; schedule("preview"); }
  bump();
  syncHistoryUI();
}
export function pathKnobsEdited() {
  rebuild();
  bump();
  syncHistoryUI();
  schedule("preview"); schedule("timeline");
}

/* ---------- preview interaction ---------- */
export function previewPointerDown(ev) {
  const sel = ui.sel;
  if (!sel || sel.type !== "cam" || !state.lastGeom) return;
  const b = blockContaining(sel.entry);
  if (!b) return;
  const rect = cvs.preview.getBoundingClientRect();
  const X = ((ev.clientX - rect.left) / rect.width) * cvs.preview.width;
  const Y = ((ev.clientY - rect.top) / rect.height) * cvs.preview.height;
  const { ox, oy, s, K } = state.lastGeom;
  const clip = state.meta.clip, dsf = state.meta.dsf;
  const cx = (X / K - ox) / s / dsf + clip.x;
  const cy = (Y / K - oy) / s / dsf + clip.y;
  applyEdit(() => {
    for (let i = b.i0; i <= b.i1; i++)
      Object.assign(state.meta.frames[i], { cx: Math.round(cx * 10) / 10, cy: Math.round(cy * 10) / 10 });
    metaEdited();
  });
}
let wheelTimer = null;
export function previewWheel(ev) {
  const sel = ui.sel;
  if (!sel || sel.type !== "cam") return;
  ev.preventDefault();
  const b = blockContaining(sel.entry);
  if (!b) return;
  beginGesture();
  let z = b.z * Math.exp(-ev.deltaY * 0.0015);
  z = clamp(z, 1, 4);
  if (Math.abs(z - 1) < 0.02) z = 1;
  z = Math.round(z * 100) / 100;
  for (let i = b.i0; i <= b.i1; i++) state.meta.frames[i].z = z;
  metaEdited();
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(commitGesture, 500);
}

/* ---------- edit ops (UI entry points; all through history) ---------- */
export function applySimple(c, vals) {
  applyEdit(() => {
    c.keys.forEach((key, j) => (state.knobs[key] = vals[j]));
    c.path ? pathKnobsEdited() : knobsEdited(c.visual);
  });
}
export function matchSimple(c) {
  const k = state.knobs;
  return c.opts.findIndex(([, v]) =>
    c.match ? c.match(k, v) : c.keys.every((key, j) => Math.abs(k[key] - v[j]) < 1e-9));
}
export function applyBgPreset(i) {
  applyEdit(() => {
    state.knobs.GRAD = BG_PRESETS[i].grad.map(([t, c]) => [t, [...c]]);
    knobsEdited(true);
  });
}
export function bgPresetIndex() {
  const key = (g) => JSON.stringify(g.map(([t, c]) => [+t, c.map(Number)]));
  return BG_PRESETS.findIndex((p) => key(p.grad) === key(state.knobs.GRAD));
}
export function setKnob(key, v, kind) {
  if (!isFinite(v)) return;
  if ((key === "ZOOM_EMA" || key === "PAN_EMA") && v <= 0) return;
  if (v < 0) return;
  if (kind === "path") { state.knobs[key] = key === "END_EXTRA" ? Math.round(v) : v; pathKnobsEdited(); }
  else { state.knobs[key] = v; knobsEdited(kind === "visual"); }
}
export function setGradStop(i, hex) {
  state.knobs.GRAD[i][1] = hexRgb(hex);
  knobsEdited(true);
}
export function setSpeedRamp(v) {
  if (!isFinite(v) || v < 0) return;
  state.meta.speedRamp = Math.round(v * 100) / 100;
  metaEdited();
}
export function setCamValue(field, v) {
  const sel = ui.sel;
  if (!sel || sel.type !== "cam" || !isFinite(v)) return;
  const b = blockContaining(sel.entry);
  if (!b) return;
  for (let i = b.i0; i <= b.i1; i++) state.meta.frames[i][field] = v;
  metaEdited();
}
export function setCamZoomStop(z) {
  applyEdit(() => setCamValue("z", z));
}
export function setStillRepeat(entry, rep) {
  if (!isFinite(rep)) return;
  state.meta.frames[entry].repeat = Math.max(1, Math.round(rep));
  metaEdited();
}
export function setSpeedField(idx, field, v) {
  const sp = (state.meta.speed || [])[idx];
  if (!sp || !isFinite(v)) return;
  if (field === "from") sp.from = clamp(Math.round(v), 0, state.meta.frames.length - 1);
  if (field === "to") sp.to = clamp(Math.round(v), sp.from + 1, state.meta.frames.length);
  if (field === "mult" && v > 0) sp.mult = v;
  metaEdited();
}
export function setEventField(sel, field, v) {
  const list = sel.type === "click" ? state.meta.clicks : state.meta.keys;
  const e = list[sel.idx];
  if (!e) return;
  if (field === "i" && isFinite(v)) e.i = clamp(Math.round(v), 0, state.meta.frames.length - 1);
  else if (field === "text") e.text = v;
  else if ((field === "x" || field === "y") && isFinite(v)) e[field] = v;
  metaEdited();
}
export function setTrim(field, v) {
  const m = state.meta;
  if (!isFinite(v)) return;
  m.trim = m.trim || {};
  if (field === "in") m.trim.in = clamp(Math.round(v), 0, m.frames.length - 2);
  else m.trim.out = clamp(Math.round(v), (m.trim.in ?? 0) + 1, m.frames.length - 1);
  metaEdited();
}
export function deleteSelected() {
  const sel = ui.sel, m = state.meta;
  if (!sel) return;
  if (sel.type === "cam") {
    const blocks = camBlocks();
    const bi = blocks.findIndex((b) => sel.entry >= b.i0 && sel.entry <= b.i1);
    if (bi >= 0 && blocks.length > 1) mergeCamBlock(blocks[bi], blocks[bi - 1] || blocks[bi + 1]);
    return;
  }
  if (sel.type === "still") {
    applyEdit(() => setStillRepeat(sel.entry, 1));
    return;
  }
  applyEdit(() => {
    if (sel.type === "speed") m.speed.splice(sel.idx, 1);
    else if (sel.type === "click") m.clicks.splice(sel.idx, 1);
    else if (sel.type === "key") m.keys.splice(sel.idx, 1);
    else if (sel.type === "caption") m.captions.splice(sel.idx, 1);
    else return;
    select(null);
    metaEdited();
  });
}
export function addClickAt(entry) {
  const m = state.meta, f = m.frames[entry], clip = m.clip;
  applyEdit(() => {
    m.clicks = m.clicks || [];
    m.clicks.push({ i: entry, x: f.mx ?? clip.x + clip.width / 2, y: f.my ?? clip.y + clip.height / 2 });
    select({ type: "click", idx: m.clicks.length - 1 });
    metaEdited();
  });
}
export function addKeyAt(entry, text) {
  const m = state.meta;
  applyEdit(() => {
    m.keys = m.keys || [];
    m.keys.push({ i: entry, text });
    select({ type: "key", idx: m.keys.length - 1 });
    metaEdited();
  });
}
export function addCaptionAt(entry, text) {
  const m = state.meta, fps = m.fps || 60;
  applyEdit(() => {
    m.captions = m.captions || [];
    let to = entry;
    const target = state.eStarts[entry] + 2.5 * fps; // default span ~2.5s
    while (to < m.frames.length - 1
           && (state.eStarts[to + 1] < 0 || state.eStarts[to + 1] < target)) to++;
    m.captions.push({ from: entry, to: to + 1, text });
    select({ type: "caption", idx: m.captions.length - 1 });
    metaEdited();
  });
}
export function playheadEntry() {
  return state.path.srcEntry[clamp(Math.round(state.playhead), 0, state.path.total - 1)];
}

/* camera block ops (context menu) */
export function splitCamAtPlayhead(block) {
  const j = entryAtPf(resolvedToEdited(Math.round(state.playhead)));
  if (j <= block.i0 || j > block.i1) return;
  applyEdit(() => {
    state.meta.frames[j].cut = true;
    metaEdited();
  });
}
export function splitAtPlayhead() {
  const b = blockContaining(playheadEntry());
  if (b) splitCamAtPlayhead(b);
}
export function trimAtPlayhead(field) {
  applyEdit(() => setTrim(field, playheadEntry()));
}
export function mergeCamBlock(block, into) {
  applyEdit(() => {
    const m = state.meta;
    for (let i = block.i0; i <= block.i1; i++)
      Object.assign(m.frames[i], { z: into.z, cx: into.cx, cy: into.cy });
    delete m.frames[block.i0].cut;
    if (into.i0 > block.i1) delete m.frames[into.i0].cut;
    select(null);
    metaEdited();
  });
}

/* ---------- context menu ---------- */
function prompt(opts) {
  return new Promise((resolve) => { ui.prompt = { ...opts, resolve }; });
}
export function resolvePrompt(value) {
  const p = ui.prompt;
  ui.prompt = null;
  if (p) p.resolve(value);
}
export function buildContextMenu(ev) {
  if (!state.meta) { ui.ctxOptions = []; return; }
  const rect = cvs.timeline.getBoundingClientRect();
  const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
  const m = state.meta, fps = m.fps || 60;
  const pf = Math.round(tlPf(x));
  const entry = clamp(entryAtPf(pf), 0, m.frames.length - 1);
  const hit = tlHit(x, y);
  const items = [];

  if (hit.mode === "camsel" || hit.mode === "camedge") {
    const b = hit.block || hit.left;
    select({ type: "cam", entry: b.i0 });
    const blocks = camBlocks();
    const bi = blocks.findIndex((q) => q.i0 === b.i0);
    const phEntry = entryAtPf(resolvedToEdited(Math.round(state.playhead)));
    items.push({
      label: "Set zoom",
      icon: "lucide-zoom-in",
      submenu: [
        ...ZOOM_STOPS.map(([l, z]) => ({ label: `${l} ×${z}`, onClick: () => setCamZoomStop(z) })),
        { label: "Reset to ×1", onClick: () => setCamZoomStop(1) },
      ],
    });
    const spanSpeed = (mult) => () => applyEdit(() => {
      m.speed = (m.speed || []).filter((sp) => sp.to <= b.i0 || sp.from > b.i1);
      if (mult !== 1) {
        m.speed.push({ from: b.i0, to: b.i1 + 1, mult });
        select({ type: "speed", idx: m.speed.length - 1 });
      }
      metaEdited();
    });
    items.push({
      label: "Set speed",
      icon: "lucide-gauge",
      submenu: [
        ...[2, 4, 8].map((mult) => ({ label: `${mult}× faster`, onClick: spanSpeed(mult) })),
        { label: "0.5× (slow motion)", onClick: spanSpeed(0.5) },
        { label: "Normal 1×", onClick: spanSpeed(1) },
      ],
    });
    const hides = m.cursorHide || [];
    const covered = hides.some((r) => r.from <= b.i0 && r.to >= b.i1 + 1);
    items.push({
      label: covered ? "Show cursor in this clip" : "Hide cursor in this clip",
      icon: covered ? "lucide-mouse-pointer-2" : "lucide-mouse-pointer-ban",
      disabled: state.knobs.CURSOR_CSS_H === 0,
      onClick: () => applyEdit(() => {
        m.cursorHide = (m.cursorHide || []).filter((r) => r.to <= b.i0 || r.from > b.i1);
        if (!covered) m.cursorHide.push({ from: b.i0, to: b.i1 + 1 });
        if (!m.cursorHide.length) delete m.cursorHide;
        metaEdited();
      }),
    });
    items.push({
      label: "Split at playhead",
      icon: "lucide-scissors",
      disabled: !(phEntry > b.i0 && phEntry <= b.i1),
      onClick: () => splitCamAtPlayhead(b),
    });
    items.push({
      label: "Merge into previous",
      icon: "lucide-merge",
      disabled: bi <= 0,
      onClick: () => mergeCamBlock(b, blocks[bi - 1]),
    });
    items.push({
      label: "Delete (merge into neighbor)",
      icon: "lucide-trash-2",
      disabled: blocks.length < 2,
      onClick: () => mergeCamBlock(b, blocks[bi - 1] || blocks[bi + 1]),
    });
  } else if (hit.mode === "stillsel" || hit.mode === "stillresize") {
    const e = hit.entry;
    select({ type: "still", entry: e });
    const orig = segState()?.origReps?.[e] ?? 1;
    items.push({
      label: "Set hold",
      icon: "lucide-timer",
      submenu: [
        ...[0.5, 1, 2, 4].map((s) => ({
          label: `${s}s`,
          onClick: () => applyEdit(() => setStillRepeat(e, Math.round(s * fps))),
        })),
        {
          label: "Custom…",
          onClick: async () => {
            const v = await prompt({ title: "Custom hold", label: "Seconds", type: "number", value: +((m.frames[e].repeat ?? 1) / fps).toFixed(1) });
            if (v !== null && isFinite(parseFloat(v))) applyEdit(() => setStillRepeat(e, parseFloat(v) * fps));
          },
        },
      ],
    });
    items.push({ label: `Reset to captured length (${(orig / fps).toFixed(1)}s)`, icon: "lucide-timer-reset", onClick: () => applyEdit(() => setStillRepeat(e, orig)) });
    items.push({ label: "Remove hold", icon: "lucide-timer-off", onClick: () => applyEdit(() => setStillRepeat(e, 1)) });
  } else if (hit.mode === "speedsel-existing") {
    const idx = hit.idx;
    select({ type: "speed", idx });
    items.push({
      label: "Edit speed…",
      icon: "lucide-gauge",
      onClick: async () => {
        const v = await prompt({ title: "Section speed", label: "Speed (2 = twice as fast)", type: "number", value: m.speed[idx].mult });
        if (v !== null && parseFloat(v) > 0) applyEdit(() => setSpeedField(idx, "mult", parseFloat(v)));
      },
    });
    items.push({
      label: "Remove speed-up",
      icon: "lucide-trash-2",
      onClick: () => applyEdit(() => { m.speed.splice(idx, 1); select(null); metaEdited(); }),
    });
  } else if (hit.mode === "speedsel") {
    let a = entry, b = entry + 1;
    while (a > 0 && (m.frames[a - 1].repeat ?? 1) <= 1) a--;
    while (b < m.frames.length && (m.frames[b].repeat ?? 1) <= 1) b++;
    const mkSpeed = (mult) => () => applyEdit(() => {
      m.speed = m.speed || [];
      m.speed.push({ from: a, to: b, mult });
      select({ type: "speed", idx: m.speed.length - 1 });
      metaEdited();
    });
    items.push({
      label: "Speed up this section",
      icon: "lucide-gauge",
      submenu: [
        ...[2, 4, 8].map((mult) => ({ label: `${mult}× faster`, onClick: mkSpeed(mult) })),
        { label: "0.5× (slow motion)", onClick: mkSpeed(0.5) },
      ],
    });
  } else if (hit.mode === "clickdrag") {
    select({ type: "click", idx: hit.idx });
    items.push({ label: "Delete click pulse", icon: "lucide-trash-2", onClick: () => applyEdit(() => { m.clicks.splice(hit.idx, 1); select(null); metaEdited(); }) });
  } else if (hit.mode === "capdrag" || hit.mode === "capedgeL" || hit.mode === "capedgeR") {
    select({ type: "caption", idx: hit.idx });
    items.push({
      label: "Edit caption…",
      icon: "lucide-pencil",
      onClick: async () => {
        const v = await prompt({ title: "Caption", label: "Text", type: "text", value: m.captions[hit.idx].text });
        if (v !== null && v !== "") applyEdit(() => { m.captions[hit.idx].text = v; metaEdited(); });
      },
    });
    items.push({ label: "Delete caption", icon: "lucide-trash-2", onClick: () => applyEdit(() => { m.captions.splice(hit.idx, 1); select(null); metaEdited(); }) });
  } else if (hit.mode === "keydrag") {
    select({ type: "key", idx: hit.idx });
    items.push({
      label: "Edit text…",
      icon: "lucide-pencil",
      onClick: async () => {
        const v = await prompt({ title: "Keycap hint", label: "Text (e.g. ⌘+Enter)", type: "text", value: m.keys[hit.idx].text });
        if (v !== null && v !== "") applyEdit(() => setEventField({ type: "key", idx: hit.idx }, "text", v));
      },
    });
    items.push({ label: "Delete keycap", icon: "lucide-trash-2", onClick: () => applyEdit(() => { m.keys.splice(hit.idx, 1); select(null); metaEdited(); }) });
  } else if (y >= TL.EVT[0] && y <= TL.EVT[0] + TL.EVT[1]) {
    items.push({ label: "Add click pulse at this time", icon: "lucide-mouse-pointer-click", onClick: () => addClickAt(entry) });
    items.push({
      label: "Add keycap at this time…",
      icon: "lucide-keyboard",
      onClick: async () => {
        const v = await prompt({ title: "Add keycap hint", label: "Text (e.g. ⌘+Enter)", type: "text", value: "⌘+Enter" });
        if (v !== null && v !== "") addKeyAt(entry, v);
      },
    });
    items.push({
      label: "Add caption at this time…",
      icon: "lucide-captions",
      onClick: async () => {
        const v = await prompt({ title: "Add caption", label: "Text", type: "text", value: "" });
        if (v !== null && v !== "") addCaptionAt(entry, v);
      },
    });
  }

  ui.ctxOptions = [
    ...items,
    {
      group: "Timeline",
      options: [
        { label: "Trim start here", icon: "lucide-arrow-right-to-line", onClick: () => applyEdit(() => setTrim("in", entry)) },
        { label: "Trim end here", icon: "lucide-arrow-left-to-line", onClick: () => applyEdit(() => setTrim("out", entry)) },
        { label: "Move playhead here", icon: "lucide-flag", onClick: () => setPlayhead(editedToResolved(pf)) },
      ],
    },
  ];
}

/* ---------- segments ---------- */
export async function loadSegment(name) {
  stopPlayback();
  if (name === ui.seg) return;
  commitGesture();
  ui.seg = name;
  clearCache();
  state.lastBitmap = null;
  let st = state.segStates.get(name);
  if (!st) {
    const data = await (await fetch(`/api/segment/${encodeURIComponent(name)}/meta`)).json();
    const meta = data.edited || {
      ...data.meta,
      frames: data.meta.frames.map((f) => ({ ...f })),
      clicks: (data.meta.clicks || []).map((c) => ({ ...c })),
      keys: (data.meta.keys || []).map((k2) => ({ ...k2 })),
      captions: (data.meta.captions || []).map((c) => ({ ...c })),
      speed: [], trim: { in: 0, out: data.meta.frames.length - 1 },
    };
    meta.speed = meta.speed || [];
    meta.captions = meta.captions || [];
    meta.trim = meta.trim || { in: 0, out: meta.frames.length - 1 };
    meta.speedRamp = meta.speedRamp ?? RAMP_DEFAULT;
    st = {
      meta,
      knobs: data.knobs ? knobsFromSaved(data.knobs) : { ...KNOB_DEFAULTS, GRAD: KNOB_DEFAULTS.GRAD.map(([t, c]) => [t, [...c]]) },
      origReps: data.meta.frames.map((f) => f.repeat ?? 1),
      undo: [], redo: [], lastSaved: null,
    };
    state.segStates.set(name, st);
    state.meta = st.meta; state.knobs = st.knobs;
    if (st.lastSaved === null) st.lastSaved = snapshot();
  } else {
    state.meta = st.meta; state.knobs = st.knobs;
  }
  ui.sel = null;
  state.playhead = 0;
  state.tl.pxpf = 0; state.tl.scroll0 = 0;
  bgKey = "";
  rebuild();
  bump();
  syncHistoryUI();
  ui.saveLabel = ui.dirty ? "unsaved changes" : "";
  requestFrame(state.res.kept[0] ?? 0, true);
  schedule("preview"); schedule("timeline");
}

export async function saveSegment(name) {
  name = name || ui.seg;
  const st = state.segStates.get(name);
  if (!st) return;
  await fetch(`/api/segment/${encodeURIComponent(name)}/save`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ meta: st.meta, knobs: knobsForSave(st.knobs) }),
  });
  st.lastSaved = JSON.stringify({ meta: st.meta, knobs: st.knobs });
  const info = ui.segments.find((s) => s.name === name);
  if (info) {
    info.hasEdits = true;
    info.label = st.meta.label ?? null;
    info.playFrames = resolveMeta(st.meta).reps.reduce((a, b) => a + b, 0);
  }
  if (name === ui.seg) {
    ui.saveLabel = "saved";
    syncHistoryUI();
  }
}

/* display name: `label` from the segment's meta, falling back to the dir name
   (the dir name stays the canonical id in every API call) */
export function segLabel(name) {
  ui.rev;
  const st = state.segStates.get(name);
  if (st) return st.meta.label || name;
  const info = ui.segments.find((s) => s.name === name);
  return info?.label || name;
}

export async function renameSegment(name) {
  if (name && name !== ui.seg) await loadSegment(name);
  const v = await prompt({ title: "Rename segment", label: "Name", type: "text",
                           value: state.meta.label || ui.seg });
  if (v === null) return;
  const label = v.trim();
  applyEdit(() => {
    if (label && label !== ui.seg) state.meta.label = label;
    else delete state.meta.label;
    metaEdited();
  });
}

/* ---------- render ---------- */
let renderCursor = 0;
export async function startRender(segments, concat) {
  for (const [name, st] of state.segStates) {
    const cur = JSON.stringify({ meta: st.meta, knobs: st.knobs });
    if (cur !== st.lastSaved) await saveSegment(name);
  }
  const r = await fetch("/api/render", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ segments, concat }),
  });
  if (!r.ok) { ui.render.status = "error"; ui.render.error = "A render is already running"; return false; }
  renderCursor = 0;
  Object.assign(ui.render, { open: true, status: "running", lines: [], progress: 0,
                             segments: [], outputs: [], error: null });
  pollRender();
  return true;
}
function renderPct(segs) {
  if (!segs.length) return 0;
  const per = segs.map((s) =>
    s.state === "done" ? 1 : s.total ? Math.min(1, s.frames / s.total) : 0);
  return Math.round((per.reduce((a, b) => a + b, 0) / segs.length) * 100);
}
async function pollRender() {
  const st = await (await fetch(`/api/render/status?since=${renderCursor}`)).json();
  renderCursor = st.cursor;
  if (st.lines.length) {
    ui.render.lines.push(...st.lines);
    if (ui.render.lines.length > 200) ui.render.lines.splice(0, ui.render.lines.length - 200);
  }
  ui.render.segments = st.segments || [];
  ui.render.outputs = st.outputs || [];
  ui.render.error = st.error;
  ui.render.progress = renderPct(ui.render.segments);
  if (st.status === "running") setTimeout(pollRender, 500);
  else {
    ui.render.status = st.status;
    if (st.status === "done") ui.render.progress = 100;
  }
}

/* ---------- draw scheduling ---------- */
const dirtyFlags = new Set();
let scheduled = false;
export function schedule(what) {
  dirtyFlags.add(what);
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    if (dirtyFlags.has("preview")) drawPreview();
    if (dirtyFlags.has("timeline")) drawTimeline();
    dirtyFlags.clear();
  });
}

/* ---------- init ---------- */
// keyboard shortcuts live in shortcuts.js (useShortcut, registered by App.vue)
let segListJson = "";
async function refreshSegments() {
  let list;
  try { list = await (await fetch("/api/segments")).json(); } catch { return; }
  const s = JSON.stringify(list);
  if (s === segListJson) return;   // keep array identity stable between polls
  segListJson = s;
  ui.segments = list;
  const names = list.map((x) => x.name);
  ui.order = [...ui.order.filter((n) => names.includes(n)),
              ...names.filter((n) => !ui.order.includes(n))];
  if (!ui.seg && ui.order.length) await loadSegment(ui.order[0]);
}

export async function init() {
  ui.segments = await (await fetch("/api/segments")).json();
  segListJson = JSON.stringify(ui.segments);
  const names = ui.segments.map((s) => s.name);
  let order = [];
  try { order = JSON.parse(localStorage.getItem("demo-editor-order") || "[]"); } catch {}
  ui.order = [...order.filter((n) => names.includes(n)), ...names.filter((n) => !order.includes(n))];
  if (ui.order.length) await loadSegment(ui.order[0]);
  setInterval(refreshSegments, 3000);   // recordings imported mid-session join the rail
}

export function setOrder(order) {
  ui.order = order;
  localStorage.setItem("demo-editor-order", JSON.stringify(order));
}
