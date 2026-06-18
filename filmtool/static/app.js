'use strict';
const $ = s => document.querySelector(s);
const api = (p, o) => fetch(p, o);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

let S = {
  dir: '',             // current input dir (relative to allowed root)
  path: null,          // selected file path (relative to allowed root)
  name: null,          // basename of the selected file
  info: null, auto: null,
  vcrop: [0, 1],       // global top/bottom base-margin trim (display-y fractions)
  picking: null,       // 'neutral' | 'base'
  frameMode: 'even',   // 'even' (equal-split cut lines) | 'ratio' (locked boxes)
  ratio: null,         // {along, across} when frameMode === 'ratio'
  bounds: [], meta: [],// even mode: N+1 cut positions + N per-frame meta
  boxes: [],           // ratio mode: [{cu, rotation, flip_h, flip_v, params}]
  sel: -1,
  active: null,        // {type:'cut'|'box'|'trim', idx} for arrow-key nudge
  zoom: 1,
};

// ---------------------------------------------------------------- directory
async function loadFiles(dir) {
  S.dir = dir || '';
  $('#curDir').textContent = '/' + S.dir;
  let files = [];
  try { files = await (await api('/api/files?dir=' + encodeURIComponent(S.dir))).json(); }
  catch (e) { files = []; }
  if (!Array.isArray(files)) files = [];
  const box = $('#files'); box.innerHTML = '';
  $('#dirEmpty').classList.toggle('hidden', files.length > 0);
  files.forEach(f => {
    const b = document.createElement('button');
    b.textContent = f.error ? `${f.name} ⚠` : f.name;
    b.disabled = !!f.error;
    b.onclick = () => {
      document.querySelectorAll('.files button').forEach(x => x.classList.remove('active'));
      b.classList.add('active'); loadStrip(f.path);
    };
    box.appendChild(b);
  });
  return files.length;
}

function parentOf(rel) { if (!rel) return ''; const p = rel.split('/'); p.pop(); return p.join('/'); }

async function openDirBrowser(path) {
  const d = await (await api('/api/dirs?path=' + encodeURIComponent(path || ''))).json();
  const box = $('#dirBrowser'); box.classList.remove('hidden'); box.innerHTML = '';
  const head = document.createElement('div'); head.className = 'dbHead';
  const crumb = document.createElement('span'); crumb.className = 'crumbs'; crumb.textContent = '/' + d.cwd;
  head.appendChild(crumb);
  const sel = document.createElement('button'); sel.className = 'primary';
  sel.textContent = `选择此目录 (${d.fff} 个 .fff)`; sel.onclick = () => chooseDir(d.cwd);
  head.appendChild(sel);
  if (!d.at_root) {
    const up = document.createElement('button'); up.textContent = '⬆ 上级';
    up.onclick = () => openDirBrowser(parentOf(d.cwd)); head.appendChild(up);
  }
  const close = document.createElement('button'); close.textContent = '关闭';
  close.onclick = () => box.classList.add('hidden'); head.appendChild(close);
  box.appendChild(head);
  const list = document.createElement('div'); list.className = 'dbList';
  d.dirs.forEach(sub => {
    const b = document.createElement('button'); b.className = 'dbDir';
    b.innerHTML = `📁 ${sub.name} <small>${sub.fff}</small>`;
    b.onclick = () => openDirBrowser(sub.path); list.appendChild(b);
  });
  if (!d.dirs.length) { const e = document.createElement('span'); e.className = 'hint'; e.textContent = '（无子目录）'; list.appendChild(e); }
  box.appendChild(list);
}
function chooseDir(rel) {
  localStorage.setItem('filmtool.dir', rel);
  $('#dirBrowser').classList.add('hidden'); loadFiles(rel);
}
$('#btnPickDir').onclick = () => openDirBrowser(S.dir);

// ---------------------------------------------------------------- strip
async function loadStrip(path) {
  S.path = path; S.name = path.split('/').pop();
  toast('载入 ' + S.name + ' …');
  const a = await (await api('/api/analyze?path=' + encodeURIComponent(path))).json();
  S.info = a; S.auto = a.params;
  S.vcrop = (a.vcrop && a.vcrop.length === 2) ? a.vcrop.slice() : [0, 1];
  $('#stripTitle').textContent = `${S.name}  ${a.width}×${a.height}  ${a.mode === 'negative' ? '负片' : '正片'}`;
  $('#mode').value = a.params.mode;
  $('#stripImg').src = '/api/strip?path=' + encodeURIComponent(path) + '&t=' + Date.now();
  $('#stripPane').classList.remove('hidden');
  $('#editPane').classList.remove('hidden');
  // fresh file -> drop the previous file's frames/meta (rotation, flips, colour)
  // so editing carries over per-frame, never across files.
  S.bounds = []; S.meta = []; S.boxes = []; S.sel = -1;
  applyRatioSelection($('#ratio').value);
  toast('已载入');
}

function frameCountInput() { return parseInt($('#frameCount').value) || 6; }
function nFrames() { return S.frameMode === 'ratio' ? S.boxes.length : S.meta.length; }
function frameMetaAt(i) { return S.frameMode === 'ratio' ? S.boxes[i] : S.meta[i]; }
function defaultMeta() { return { rotation: 90, flip_h: false, flip_v: false, params: structuredClone(S.auto) }; }

// box width along the strip (u), locked by ratio and the top/bottom lines.
// Native strip is (H rows = u axis, W cols = across-film v axis); square scan
// pixels => du = (along/across) * dv * (W/H).
function boxWidthU() {
  if (!S.ratio || !S.info) return 0.1;
  const dv = S.vcrop[1] - S.vcrop[0];
  return (S.ratio.along / S.ratio.across) * dv * (S.info.width / S.info.height);
}
function clampCu(cu) { const du = boxWidthU(); return du >= 1 ? 0.5 : clamp(cu, du / 2, 1 - du / 2); }
function frameSpan(i) {
  if (S.frameMode === 'ratio') { const cu = S.boxes[i].cu, du = boxWidthU(); return [cu - du / 2, cu + du / 2]; }
  return [S.bounds[i], S.bounds[i + 1]];
}

// ---------------------------------------------------------------- framing: ratio mode
function applyRatioSelection(val) {
  localStorage.setItem('filmtool.ratio', val);
  $('#customRatio').classList.toggle('hidden', val !== 'custom');
  $('#ratio').value = val;
  if (val === 'free') { S.frameMode = 'even'; S.ratio = null; evenSplit(frameCountInput()); updateHint(); return; }
  let along, across;
  if (val === 'custom') { along = parseFloat($('#ratA').value) || 1; across = parseFloat($('#ratB').value) || 1; }
  else { const p = val.split(':').map(Number); along = p[0]; across = p[1]; }
  S.ratio = { along, across };
  const wasRatio = S.frameMode === 'ratio';
  S.frameMode = 'ratio';
  if (wasRatio && S.boxes.length) {
    S.boxes.forEach(b => b.cu = clampCu(b.cu)); renderOverlay();
    selectFrame(Math.min(Math.max(S.sel, 0), S.boxes.length - 1));
  } else placeBoxesEven(frameCountInput());
  updateHint();
}
function placeBoxesEven(n) {
  S.boxes = Array.from({ length: n }, (_, i) => Object.assign({ cu: clampCu((i + 0.5) / n) }, defaultMeta()));
  S.sel = 0; renderOverlay(); selectFrame(0);
}
function detectBoxes() {
  const cuts = (S.info.cuts_u || []).filter(u => u > 0.01 && u < 0.99);
  const edges = [0, ...cuts, 1].sort((a, b) => a - b);
  S.boxes = [];
  for (let i = 0; i < edges.length - 1; i++)
    S.boxes.push(Object.assign({ cu: clampCu((edges[i] + edges[i + 1]) / 2) }, defaultMeta()));
  S.sel = 0; renderOverlay(); selectFrame(0);
  toast(`检测 → ${S.boxes.length} 框`);
}
function addBox(u) {
  const b = Object.assign({ cu: clampCu(u) }, defaultMeta());
  b.params = structuredClone(S.boxes[S.sel] ? S.boxes[S.sel].params : S.auto);
  S.boxes.push(b); S.boxes.sort((a, b) => a.cu - b.cu);
  renderOverlay(); selectFrame(S.boxes.indexOf(b));
}
function removeBox(i) {
  if (S.boxes.length <= 1) return;
  S.boxes.splice(i, 1);
  if (S.sel >= S.boxes.length) S.sel = S.boxes.length - 1;
  renderOverlay(); selectFrame(S.sel);
}

// ---------------------------------------------------------------- framing: even mode
function evenSplit(n) {
  S.bounds = Array.from({ length: n + 1 }, (_, i) => i / n);
  S.meta = Array.from({ length: n }, defaultMeta);
  S.sel = 0; renderOverlay(); selectFrame(0);
}
function detectGaps() {
  const cuts = (S.info.cuts_u || []).filter(u => u > 0.01 && u < 0.99);
  S.bounds = [0, ...cuts, 1].sort((a, b) => a - b);
  S.meta = Array.from({ length: S.bounds.length - 1 }, defaultMeta);
  S.sel = 0; renderOverlay(); selectFrame(0);
  toast(`检测到 ${cuts.length} 条间隙 → ${S.meta.length} 帧`);
}
function addBound(u) {
  let i = S.bounds.findIndex((b, k) => k < S.bounds.length - 1 && u > b && u < S.bounds[k + 1]);
  if (i < 0) return;
  S.bounds.splice(i + 1, 0, u);
  S.meta.splice(i + 1, 0, structuredClone(S.meta[i]));
  renderOverlay(); selectFrame(i);
}
function removeBound(k) {
  if (k <= 0 || k >= S.bounds.length - 1) return;
  S.bounds.splice(k, 1); S.meta.splice(k, 1);
  if (S.sel >= S.meta.length) S.sel = S.meta.length - 1;
  renderOverlay(); selectFrame(S.sel);
}

// ---------------------------------------------------------------- overlay render
function renderOverlay() {
  const ov = $('#overlay'); if (!ov || !S.info) return;
  ov.innerHTML = '';
  const W = ov.clientWidth, Hh = ov.clientHeight;
  // global top/bottom trim lines (both modes; in ratio mode they set box height)
  S.vcrop.forEach((v, idx) => {
    const t = document.createElement('div'); t.className = 'trim';
    t.style.top = (v * Hh) + 'px';
    t.title = idx === 0 ? '上裁切（也定义画幅短边）' : '下裁切（也定义画幅短边）';
    t.onpointerdown = e => startVDrag(e, idx); ov.appendChild(t);
  });
  if (S.frameMode === 'ratio') renderBoxes(ov, W, Hh); else renderCuts(ov, W, Hh);
}

function renderCuts(ov, W, Hh) {
  if (S.sel >= 0 && S.sel < S.meta.length) {
    const band = document.createElement('div'); band.className = 'fsel';
    band.style.left = (S.bounds[S.sel] * W) + 'px';
    band.style.width = ((S.bounds[S.sel + 1] - S.bounds[S.sel]) * W) + 'px';
    ov.appendChild(band);
  }
  for (let i = 0; i < S.meta.length; i++) {
    const lab = document.createElement('div'); lab.className = 'flabel';
    lab.textContent = (i + 1);
    lab.style.left = ((S.bounds[i] + S.bounds[i + 1]) / 2 * W) + 'px';
    ov.appendChild(lab);
  }
  S.bounds.forEach((u, k) => {
    const c = document.createElement('div');
    c.className = 'cut' + (k === 0 || k === S.bounds.length - 1 ? ' end' : '');
    c.style.left = (u * W) + 'px';
    if (k > 0 && k < S.bounds.length - 1) {
      const x = document.createElement('div'); x.className = 'x'; x.textContent = '×';
      x.onclick = e => { e.stopPropagation(); removeBound(k); };
      c.appendChild(x);
    }
    c.onpointerdown = e => startDrag(e, k); ov.appendChild(c);
  });
}

function renderBoxes(ov, W, Hh) {
  const du = boxWidthU();
  const top = S.vcrop[0] * Hh, h = (S.vcrop[1] - S.vcrop[0]) * Hh;
  S.boxes.forEach((b, i) => {
    const el = document.createElement('div'); el.className = 'rbox' + (i === S.sel ? ' sel' : '');
    el.style.left = ((b.cu - du / 2) * W) + 'px'; el.style.width = (du * W) + 'px';
    el.style.top = top + 'px'; el.style.height = h + 'px';
    const lab = document.createElement('div'); lab.className = 'rlabel'; lab.textContent = (i + 1); el.appendChild(lab);
    const x = document.createElement('div'); x.className = 'x'; x.textContent = '×';
    x.onclick = e => { e.stopPropagation(); removeBox(i); }; el.appendChild(x);
    el.onpointerdown = e => startBoxDrag(e, i); ov.appendChild(el);
  });
}

// ---------------------------------------------------------------- drag (relative + fine)
function startDrag(e, k) {
  e.preventDefault(); e.stopPropagation();
  S.active = { type: 'cut', idx: k };
  const rect = $('#overlay').getBoundingClientRect();
  const startX = e.clientX, startU = S.bounds[k];
  const move = ev => {
    const f = (ev.shiftKey || ev.altKey) ? 0.2 : 1;
    let u = startU + (ev.clientX - startX) / rect.width * f;
    const lo = k > 0 ? S.bounds[k - 1] + 0.003 : 0;
    const hi = k < S.bounds.length - 1 ? S.bounds[k + 1] - 0.003 : 1;
    S.bounds[k] = clamp(u, lo, hi); renderOverlay();
  };
  const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); selectFrame(Math.min(S.sel, S.meta.length - 1)); };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
}

function startBoxDrag(e, i) {
  e.preventDefault(); e.stopPropagation();
  selectFrame(i);
  const rect = $('#overlay').getBoundingClientRect();
  const startX = e.clientX, startCu = S.boxes[i].cu;
  const move = ev => {
    const f = (ev.shiftKey || ev.altKey) ? 0.2 : 1;
    S.boxes[i].cu = clampCu(startCu + (ev.clientX - startX) / rect.width * f);
    renderOverlay();
  };
  const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); refreshFrame(); };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
}

function startVDrag(e, idx) {
  e.preventDefault(); e.stopPropagation();
  S.active = { type: 'trim', idx };
  const rect = $('#overlay').getBoundingClientRect();
  const startY = e.clientY, startV = S.vcrop[idx];
  const move = ev => {
    const f = (ev.shiftKey || ev.altKey) ? 0.2 : 1;
    let v = clamp(startV + (ev.clientY - startY) / rect.height * f, 0, 1);
    if (idx === 0) v = Math.min(v, S.vcrop[1] - 0.01); else v = Math.max(v, S.vcrop[0] + 0.01);
    S.vcrop[idx] = v;
    if (S.frameMode === 'ratio') S.boxes.forEach(b => b.cu = clampCu(b.cu));
    renderOverlay();
  };
  const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); refreshFrame(); };
  document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
}

$('#overlay').addEventListener('dblclick', e => {
  if (!S.info) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const u = (e.clientX - rect.left) / rect.width;
  if (S.frameMode === 'ratio') addBox(u); else addBound(u);
});
$('#overlay').addEventListener('click', e => {
  if (!S.info) return;
  const t = e.target;
  if (t.classList.contains('cut') || t.classList.contains('x') || t.classList.contains('rbox') || t.classList.contains('trim')) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const u = (e.clientX - rect.left) / rect.width;
  if (S.frameMode === 'ratio') {
    const du = boxWidthU();
    const i = S.boxes.findIndex(b => u >= b.cu - du / 2 && u <= b.cu + du / 2);
    if (i >= 0) selectFrame(i);
  } else {
    const i = S.bounds.findIndex((b, k) => k < S.bounds.length - 1 && u >= b && u < S.bounds[k + 1]);
    if (i >= 0) selectFrame(i);
  }
});

// arrow-key nudge of the last-touched element (precision)
document.addEventListener('keydown', e => {
  if (!S.info) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  const step = e.shiftKey ? 0.005 : 0.001;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    if (S.frameMode === 'ratio' && S.sel >= 0) {
      S.boxes[S.sel].cu = clampCu(S.boxes[S.sel].cu + dir * step);
    } else if (S.active && S.active.type === 'cut') {
      const k = S.active.idx;
      const lo = k > 0 ? S.bounds[k - 1] + 0.003 : 0;
      const hi = k < S.bounds.length - 1 ? S.bounds[k + 1] - 0.003 : 1;
      S.bounds[k] = clamp(S.bounds[k] + dir * step, lo, hi);
    } else return;
    e.preventDefault(); renderOverlay(); debouncedRefresh();
  } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    if (!(S.active && S.active.type === 'trim')) return;
    const idx = S.active.idx, dir = e.key === 'ArrowDown' ? 1 : -1;
    let v = clamp(S.vcrop[idx] + dir * step, 0, 1);
    if (idx === 0) v = Math.min(v, S.vcrop[1] - 0.01); else v = Math.max(v, S.vcrop[0] + 0.01);
    S.vcrop[idx] = v;
    if (S.frameMode === 'ratio') S.boxes.forEach(b => b.cu = clampCu(b.cu));
    e.preventDefault(); renderOverlay(); debouncedRefresh();
  }
});

// zoom (horizontal precision)
$('#zoom').addEventListener('input', e => {
  S.zoom = parseFloat(e.target.value);
  $('#oZoom').textContent = S.zoom + '×';
  $('#stripZoom').style.width = (S.zoom * 100) + '%';
  renderOverlay();
});

function updateHint() {
  $('#stripHint').textContent = S.frameMode === 'ratio'
    ? '拖框对齐画面 · 双击加框 · × 删 · Shift 细调 · ←→ 微调 · 上下线定短边'
    : '双击加切线 · 拖动调整 · × 删 · Shift 细调 · ←→ 微调（先点中切线）';
}

// ---------------------------------------------------------------- frame preview + controls
let previewSeq = 0;
function selectFrame(i) {
  const n = nFrames();
  if (i < 0 || i >= n) return;
  S.sel = i;
  if (S.frameMode === 'ratio') S.active = { type: 'box', idx: i };
  renderOverlay();
  const m = frameMetaAt(i);
  $('#frameLabel').textContent = `帧 ${i + 1} / ${n}`;
  loadParamsToUI(m.params);
  refreshFrame();
}

function loadParamsToUI(p) {
  $('#mode').value = p.mode;
  $('#exposure').value = p.exposure; $('#oExposure').textContent = (+p.exposure).toFixed(2);
  $('#contrast').value = p.contrast; $('#oContrast').textContent = (+p.contrast).toFixed(2);
  $('#gamma').value = p.gamma; $('#oGamma').textContent = (+p.gamma).toFixed(2);
  $('#black').value = p.black; $('#oBlack').textContent = (+p.black).toFixed(3);
  const wb = p.wb_gain || [1, 1, 1];
  $('#wbVal').textContent = wb.map(x => (+x).toFixed(2)).join(' / ');
}

function curFrameReq(extra) {
  const [u0, u1] = frameSpan(S.sel); const m = frameMetaAt(S.sel);
  return Object.assign({
    path: S.path, u0, u1, v0: S.vcrop[0], v1: S.vcrop[1],
    rotation: m.rotation, flip_h: m.flip_h, flip_v: m.flip_v, params: m.params,
  }, extra || {});
}

async function refreshFrame() {
  if (S.sel < 0 || S.sel >= nFrames()) return;
  const seq = ++previewSeq;
  $('#frameImg').classList.add('spin');
  const body = JSON.stringify(curFrameReq());
  try {
    const r = await api('/api/frame', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (seq !== previewSeq) return;
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const img = $('#frameImg');
    if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
    img.dataset.url = url; img.src = url; img.classList.remove('spin');
  } catch (e) { toast('预览失败: ' + e); }
}
const debouncedRefresh = debounce(refreshFrame, 180);

function bindSlider(id, key, out, dec) {
  $(id).addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    $(out).textContent = v.toFixed(dec);
    frameMetaAt(S.sel).params[key] = v; debouncedRefresh();
  });
}
bindSlider('#exposure', 'exposure', '#oExposure', 2);
bindSlider('#contrast', 'contrast', '#oContrast', 2);
bindSlider('#gamma', 'gamma', '#oGamma', 2);
bindSlider('#black', 'black', '#oBlack', 3);
$('#mode').addEventListener('change', e => { frameMetaAt(S.sel).params.mode = e.target.value; refreshFrame(); });

document.querySelectorAll('[data-rot]').forEach(b => b.onclick = () => {
  const m = frameMetaAt(S.sel); m.rotation = ((m.rotation + parseInt(b.dataset.rot)) % 360 + 360) % 360; refreshFrame();
});
$('#btnFlipH').onclick = () => { const m = frameMetaAt(S.sel); m.flip_h = !m.flip_h; refreshFrame(); };
$('#btnFlipV').onclick = () => { const m = frameMetaAt(S.sel); m.flip_v = !m.flip_v; refreshFrame(); };
$('#btnResetWb').onclick = () => { frameMetaAt(S.sel).params.wb_gain = structuredClone(S.auto.wb_gain); loadParamsToUI(frameMetaAt(S.sel).params); refreshFrame(); };

$('#btnApplyAll').onclick = () => {
  const src = frameMetaAt(S.sel).params;
  for (let i = 0; i < nFrames(); i++) frameMetaAt(i).params = structuredClone(src);
  toast('已应用到全部 ' + nFrames() + ' 帧'); refreshFrame();
};

$('#btnEven').onclick = () => { const n = frameCountInput(); if (S.frameMode === 'ratio') placeBoxesEven(n); else evenSplit(n); };
$('#btnDetect').onclick = () => { if (S.frameMode === 'ratio') detectBoxes(); else detectGaps(); };
$('#ratio').addEventListener('change', e => applyRatioSelection(e.target.value));
$('#ratA').addEventListener('change', () => { if ($('#ratio').value === 'custom') applyRatioSelection('custom'); });
$('#ratB').addEventListener('change', () => { if ($('#ratio').value === 'custom') applyRatioSelection('custom'); });

// ---------------------------------------------------------------- pickers
function setPick(kind) {
  S.picking = S.picking === kind ? null : kind;
  $('#btnPickN').classList.toggle('on', S.picking === 'neutral');
  $('#btnPickB').classList.toggle('on', S.picking === 'base');
  $('#frameImgWrap').classList.toggle('picking', !!S.picking);
  $('#pickHint').classList.toggle('hidden', !S.picking);
  $('#pickHint').textContent = S.picking === 'neutral' ? '点击应为中性灰/白的区域' : '点击片基（帧间橙色清片）';
}
$('#btnPickN').onclick = () => setPick('neutral');
$('#btnPickB').onclick = () => setPick('base');

$('#frameImg').addEventListener('click', async e => {
  if (!S.picking) return;
  const img = e.target; const rect = img.getBoundingClientRect();
  const fx = (e.clientX - rect.left) / rect.width;
  const fy = (e.clientY - rect.top) / rect.height;
  const body = JSON.stringify(curFrameReq({ fx, fy, kind: S.picking }));
  const r = await (await api('/api/sample', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })).json();
  if (S.picking === 'neutral' && r.wb_gain) {
    frameMetaAt(S.sel).params.wb_gain = r.wb_gain;
  } else if (S.picking === 'base') {
    S.auto = r.params;
    frameMetaAt(S.sel).params.dmax = r.params.dmax;
    frameMetaAt(S.sel).params.wb_gain = r.params.wb_gain;
  }
  const was = S.picking;
  loadParamsToUI(frameMetaAt(S.sel).params);
  setPick(S.picking); // toggle off
  refreshFrame();
  toast(was === 'neutral' ? '白平衡已更新' : '片基已更新');
});

// ---------------------------------------------------------------- export
$('#btnExport').onclick = async () => {
  const formats = [];
  if ($('#fmtJpg').checked) formats.push('jpg');
  if ($('#fmtTiff').checked) formats.push('tiff');
  if (!formats.length) return toast('请选择至少一种格式');
  const stem = S.name.replace(/\.fff$/i, '');
  const frames = [];
  for (let i = 0; i < nFrames(); i++) {
    const [u0, u1] = frameSpan(i); const m = frameMetaAt(i);
    frames.push({
      u0, u1, v0: S.vcrop[0], v1: S.vcrop[1],
      rotation: m.rotation, flip_h: m.flip_h, flip_v: m.flip_v,
      params: m.params, out_name: `${stem}-${String(i + 1).padStart(2, '0')}`,
    });
  }
  $('#exportStatus').textContent = `导出 ${frames.length} 帧（全分辨率）…`;
  $('#btnExport').disabled = true;
  try {
    const r = await (await api('/api/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: S.path, frames, formats }),
    })).json();
    $('#exportStatus').textContent = `✓ 已导出 ${r.files.length} 个文件到\n${r.out_dir}`;
  } catch (e) { $('#exportStatus').textContent = '导出失败: ' + e; }
  $('#btnExport').disabled = false;
};

// un-graded export: raw cropped negative (no invert/WB/tone), margin of film base
$('#btnExportRaw').onclick = async () => {
  if (S.sel < 0 || !nFrames()) return toast('请先选文件并分帧');
  const stem = S.name.replace(/\.fff$/i, '');
  const frames = [];
  for (let i = 0; i < nFrames(); i++) {
    const [u0, u1] = frameSpan(i); const m = frameMetaAt(i);
    frames.push({
      u0, u1, v0: S.vcrop[0], v1: S.vcrop[1],
      rotation: m.rotation, flip_h: m.flip_h, flip_v: m.flip_v,
      params: m.params, out_name: `${stem}-${String(i + 1).padStart(2, '0')}-raw`,
    });
  }
  $('#exportRawStatus').textContent = `导出 ${frames.length} 帧未调色原片…`;
  $('#btnExportRaw').disabled = true;
  try {
    const r = await (await api('/api/export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: S.path, frames, formats: ['tiff'], raw: true }),
    })).json();
    $('#exportRawStatus').textContent = `✓ 已导出 ${r.files.length} 个原片到\n${r.out_dir}`;
  } catch (e) { $('#exportRawStatus').textContent = '导出失败: ' + e; }
  $('#btnExportRaw').disabled = false;
};

// ---------------------------------------------------------------- utils + init
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
let toastT;
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.add('hidden'), 1800); }
$('#stripImg').addEventListener('load', renderOverlay);
window.addEventListener('resize', debounce(renderOverlay, 150));

(function init() {
  const savedRatio = localStorage.getItem('filmtool.ratio') || 'free';
  $('#ratio').value = savedRatio;
  $('#customRatio').classList.toggle('hidden', savedRatio !== 'custom');
  S.frameMode = savedRatio === 'free' ? 'even' : 'ratio';
  if (savedRatio !== 'free' && savedRatio !== 'custom') {
    const p = savedRatio.split(':').map(Number); S.ratio = { along: p[0], across: p[1] };
  } else if (savedRatio === 'custom') {
    S.ratio = { along: parseFloat($('#ratA').value) || 1, across: parseFloat($('#ratB').value) || 1 };
  }
  const dir = localStorage.getItem('filmtool.dir') || '';
  loadFiles(dir).then(n => { if (!n) openDirBrowser(dir); });
})();
