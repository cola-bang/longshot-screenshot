/* LongShot · viewer
 * 从 storage 取出逐帧截图，按记录的偏移合成一张长图，并提供裁剪 / 复制 / 下载 / 打印。
 * 快捷键：Ctrl(⌘)+C 复制图片、Ctrl(⌘)+S 下载、Esc 退出裁剪。
 */
'use strict';

const $ = (id) => document.getElementById(id);
const sessionId = new URLSearchParams(location.search).get('id');

const MAX_PIXELS = 46e6; // 单张位图上限，超出则等比降采样（避免浏览器 OOM）
const MAX_DIM = 32000;

const state = {
  meta: null,
  base: null,
  baseW: 0,
  baseH: 0,
  crop: null,
  fmt: 'png',
  quality: 0.92,
  zoom: 'fit',
  downscaled: 1
};

// 便于排查问题：在控制台可查看 window.__longshot
window.__longshot = state;

let busy = false;

/* ---------------------------------------------------------------- utils */

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片数据损坏'));
    img.src = url;
  });
}

function fitFactor(w, h) {
  let k = 1;
  k = Math.min(k, Math.sqrt(MAX_PIXELS / (w * h)));
  k = Math.min(k, MAX_DIM / Math.max(w, h));
  return Math.max(0.08, k);
}

function setProgress(ratio, text) {
  $('loadingBar').style.width = Math.max(0, Math.min(1, ratio)) * 100 + '%';
  if (text) $('loadingText').textContent = text;
}

function fail(message) {
  const box = $('loading');
  box.classList.remove('done');
  box.classList.add('error');
  $('loadingText').textContent = message;
  const btn = document.createElement('button');
  btn.textContent = '关闭此标签页';
  btn.style.marginTop = '4px';
  btn.onclick = () => window.close();
  (box.querySelector('.lcard') || box).appendChild(btn);
}

let toastTimer = 0;
function toast(text, type, ms) {
  const el = $('toast');
  el.textContent = text;
  el.className = 'toast on' + (type === 'ok' ? ' ok' : type === 'err' ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = 'toast';
  }, ms || 2400);
}

/* --------------------------------------------------------------- stitch */

async function boot() {
  if (!sessionId) return fail('缺少截图会话参数，请重新截图。');

  let all = {};
  try {
    all = await chrome.storage.local.get(null);
  } catch (e) {
    return fail('读取截图数据失败：' + e.message);
  }

  const meta = all['ls:meta:' + sessionId];
  if (!meta) return fail('找不到本次截图的数据。可能是扩展被重新加载，请重新截图。');

  const keys = Object.keys(all)
    .filter((k) => k.startsWith('ls:f:' + sessionId + ':'))
    .sort((a, b) => Number(a.split(':').pop()) - Number(b.split(':').pop()));
  const frames = keys.map((k) => all[k]).filter((f) => f && f.url);
  if (!frames.length) return fail('没有采集到画面，请重新截图。');

  state.meta = meta;
  $('title').textContent = meta.title || '长截图';
  $('sub').textContent = meta.url || '';
  $('sub').title = meta.url || '';

  try {
    setProgress(0.05, '正在解码画面…');
    const first = await loadImage(frames[0].url);
    const scale = first.naturalWidth / (meta.frameW || first.naturalWidth);

    const rawW = Math.max(1, Math.round(meta.outW * scale));
    const rawH = Math.max(1, Math.round(meta.outH * scale));
    const k = fitFactor(rawW, rawH);
    state.downscaled = k;

    const outW = Math.max(1, Math.round(rawW * k));
    const outH = Math.max(1, Math.round(rawH * k));

    const canvas = document.createElement('canvas');
    canvas.width = outW;
    canvas.height = outH;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('无法创建画布（图片可能过大）');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outW, outH);

    const ds = scale * k;
    const paint = (img, f) => {
      const sx = f.src.x * scale;
      const sy = f.src.y * scale;
      const sw = Math.max(1, f.src.w * scale);
      const sh = Math.max(1, f.src.h * scale);
      ctx.drawImage(img, sx, sy, sw, sh, 0, f.dy * ds, sw * k, sh * k);
    };

    paint(first, frames[0]);
    first.src = '';

    for (let i = 1; i < frames.length; i += 1) {
      setProgress(0.1 + (i / frames.length) * 0.85, `正在合成 ${i + 1}/${frames.length} 帧…`);
      // 让出主线程，保证进度条与动画不卡死
      if (i % 2 === 0) await new Promise((r) => setTimeout(r, 0));
      const img = await loadImage(frames[i].url);
      paint(img, frames[i]);
      img.src = '';
    }

    state.base = canvas;
    state.baseW = outW;
    state.baseH = outH;
    state.crop = { x: 0, y: 0, w: outW, h: outH };

    setProgress(1, '完成');
    $('loading').classList.add('done');
    render();
    window.focus();
  } catch (e) {
    fail('合成失败：' + (e.message || e));
  }
}

/* --------------------------------------------------------------- render */

function render() {
  const { base, crop } = state;
  if (!base || !crop) return;
  const view = $('view');
  const stage = $('stage');

  const avail = Math.max(240, stage.clientWidth - 44);
  const cssW = state.zoom === 'fit' ? Math.min(avail, crop.w) : crop.w;

  const intrinsicW = Math.max(1, Math.min(crop.w, 1800));
  const ratio = intrinsicW / crop.w;
  const intrinsicH = Math.max(1, Math.round(crop.h * ratio));

  view.width = intrinsicW;
  view.height = intrinsicH;
  const ctx = view.getContext('2d', { alpha: false });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(base, crop.x, crop.y, crop.w, crop.h, 0, 0, intrinsicW, intrinsicH);
  view.style.width = Math.round(cssW) + 'px';

  const chips = [`${crop.w} × ${crop.h}`];
  if (state.meta && state.meta.pages) chips.push(state.meta.pages + ' 帧');
  if (state.downscaled < 0.98) chips.push('输出 ' + Math.round(state.downscaled * 100) + '%');
  $('stats').innerHTML = chips.map((t) => `<span>${t}</span>`).join('');

  updateZoomLabel();
}

function updateZoomLabel() {
  $('zoomLabel').textContent = state.zoom === 'fit' ? '适应宽度' : '100%';
  $('btnZoom').classList.toggle('on', state.zoom === 'actual');
}

/* ----------------------------------------------------------------- crop */

let cropping = false;

function enterCrop() {
  if (!state.base) return;
  cropping = true;
  $('cropLayer').hidden = false;
  $('btnCrop').classList.add('on');
  document.body.style.cursor = 'crosshair';
  toast('拖拽框选要保留的区域，松开即裁剪 · Esc 取消', null, 3000);
}

function exitCrop() {
  cropping = false;
  $('cropLayer').hidden = true;
  $('btnCrop').classList.remove('on');
  $('cropBox').style.display = 'none';
  document.body.style.cursor = '';
}

function toImagePoint(clientX, clientY) {
  const r = $('view').getBoundingClientRect();
  const { crop } = state;
  const fx = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
  const fy = Math.min(1, Math.max(0, (clientY - r.top) / Math.max(1, r.height)));
  return { x: crop.x + fx * crop.w, y: crop.y + fy * crop.h };
}

function bindCrop() {
  const layer = $('cropLayer');
  const box = $('cropBox');
  let start = null;

  const paintBox = (a, b) => {
    const r = layer.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = Math.min(a.x, b.x) - r.left + 'px';
    box.style.top = Math.min(a.y, b.y) - r.top + 'px';
    box.style.width = Math.abs(a.x - b.x) + 'px';
    box.style.height = Math.abs(a.y - b.y) + 'px';
  };

  layer.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    layer.setPointerCapture(e.pointerId);
    start = { x: e.clientX, y: e.clientY };
    paintBox(start, start);
  });

  layer.addEventListener('pointermove', (e) => {
    if (!start) return;
    paintBox(start, { x: e.clientX, y: e.clientY });
  });

  layer.addEventListener('pointerup', (e) => {
    if (!start) return;
    const a = toImagePoint(start.x, start.y);
    const b = toImagePoint(e.clientX, e.clientY);
    start = null;
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    if (w < 8 || h < 8) {
      exitCrop();
      return;
    }
    state.crop = {
      x: Math.round(Math.min(a.x, b.x)),
      y: Math.round(Math.min(a.y, b.y)),
      w: Math.round(w),
      h: Math.round(h)
    };
    exitCrop();
    render();
    toast(`已裁剪到 ${state.crop.w} × ${state.crop.h}`, 'ok');
  });

  layer.addEventListener('pointercancel', () => {
    start = null;
    exitCrop();
  });
}

/* --------------------------------------------------------------- export */

async function makeBlob(fmt) {
  const { base, crop } = state;
  const useFmt = fmt || state.fmt;
  const k = fitFactor(crop.w, crop.h);
  const W = Math.max(1, Math.round(crop.w * k));
  const H = Math.max(1, Math.round(crop.h * k));

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { alpha: useFmt === 'png' });
  if (useFmt === 'jpg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(base, crop.x, crop.y, crop.w, crop.h, 0, 0, W, H);

  const blob = await new Promise((resolve) => {
    c.toBlob(resolve, useFmt === 'jpg' ? 'image/jpeg' : 'image/png', useFmt === 'jpg' ? state.quality : undefined);
  });
  c.width = 0;
  c.height = 0;
  if (!blob) throw new Error('图片尺寸过大，请先裁剪再试');
  return blob;
}

function buildFilename(ext) {
  let host = 'page';
  try {
    host = new URL(state.meta.url).hostname.replace(/^www\./, '') || 'page';
  } catch (e) {
    /* ignore */
  }
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `LongShot_${host}_${ts}.${ext}`;
}

async function download() {
  if (busy) return;
  const btn = $('btnDownload');
  const label = btn.querySelector('span');
  busy = true;
  btn.disabled = true;
  label.textContent = '生成中…';
  try {
    const blob = await makeBlob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = buildFilename(state.fmt === 'jpg' ? 'jpg' : 'png');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    toast('已保存到下载目录：' + a.download, 'ok', 3200);
  } catch (e) {
    toast('导出失败：' + (e.message || e), 'err', 4200);
  } finally {
    label.textContent = '下载图片';
    btn.disabled = false;
    busy = false;
  }
}

async function copyImage() {
  const btn = $('btnCopy');
  const label = btn.querySelector('span');
  if (busy) {
    toast('正在处理，请稍候…');
    return;
  }
  if (!navigator.clipboard || !window.ClipboardItem) {
    toast('当前浏览器不支持写入图片剪贴板，请改用下载', 'err', 4200);
    return;
  }
  busy = true;
  btn.disabled = true;
  label.textContent = '复制中…';
  try {
    const blob = await makeBlob('png');
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    label.textContent = '已复制';
    btn.classList.add('on');
    toast(`已复制 ${state.crop.w} × ${state.crop.h}，可直接粘贴`, 'ok');
    setTimeout(() => {
      label.textContent = '复制';
      btn.classList.remove('on');
    }, 1600);
  } catch (e) {
    label.textContent = '复制';
    const msg = /denied|not allowed|Write permission/i.test(e.message || '')
      ? '浏览器拒绝了剪贴板写入，请点页面空白处后重试，或改用下载'
      : '复制失败：' + (e.message || e) + '，可改用下载';
    toast(msg, 'err', 4600);
  } finally {
    btn.disabled = false;
    busy = false;
  }
}

/* ------------------------------------------------------------ pan / nav */

function bindPan() {
  const stage = $('stage');
  const toTop = $('toTop');
  let pan = null;

  stage.addEventListener('pointerdown', (e) => {
    if (cropping || e.button !== 0) return;
    if (e.target.closest('#cropLayer')) return;
    pan = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
    try {
      stage.setPointerCapture(e.pointerId);
    } catch (err) {
      /* ignore */
    }
    stage.classList.add('grabbing');
  });

  stage.addEventListener('pointermove', (e) => {
    if (!pan) return;
    stage.scrollLeft = pan.left - (e.clientX - pan.x);
    stage.scrollTop = pan.top - (e.clientY - pan.y);
  });

  const endPan = () => {
    pan = null;
    stage.classList.remove('grabbing');
  };
  stage.addEventListener('pointerup', endPan);
  stage.addEventListener('pointercancel', endPan);

  // 鼠标停在悬浮工具栏上时，滚轮也应该滚动图片
  const dock = $('dock');
  if (dock) {
    dock.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        stage.scrollTop += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      },
      { passive: false }
    );
  }

  stage.addEventListener(
    'scroll',
    () => {
      toTop.hidden = stage.scrollTop < 300;
    },
    { passive: true }
  );
  toTop.addEventListener('click', () => stage.scrollTo({ top: 0, behavior: 'smooth' }));
}

/* ----------------------------------------------------------------- init */

function bindUI() {
  $('btnDownload').addEventListener('click', download);
  $('btnCopy').addEventListener('click', copyImage);
  $('btnPrint').addEventListener('click', () => window.print());

  $('btnCrop').addEventListener('click', () => (cropping ? exitCrop() : enterCrop()));
  $('btnReset').addEventListener('click', () => {
    if (!state.base) return;
    state.crop = { x: 0, y: 0, w: state.baseW, h: state.baseH };
    render();
    toast('已恢复完整画面', 'ok', 1800);
  });
  $('btnZoom').addEventListener('click', () => {
    state.zoom = state.zoom === 'fit' ? 'actual' : 'fit';
    render();
    $('stage').scrollTop = 0;
  });

  document.querySelectorAll('#fmtSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      state.fmt = b.dataset.fmt;
      document.querySelectorAll('#fmtSeg button').forEach((x) => x.classList.toggle('on', x === b));
      $('qWrap').hidden = state.fmt !== 'jpg';
    });
  });
  $('quality').addEventListener('input', (e) => {
    state.quality = Number(e.target.value);
    $('qVal').textContent = Math.round(state.quality * 100) + '%';
  });

  window.addEventListener('keydown', (e) => {
    const meta = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      if (cropping) {
        e.preventDefault();
        exitCrop();
      }
      return;
    }
    const stage = $('stage');
    if (!meta) {
      const page = Math.round(stage.clientHeight * 0.9);
      if (e.key === 'PageDown') {
        e.preventDefault();
        stage.scrollTop += page;
        return;
      }
      if (e.key === 'PageUp') {
        e.preventDefault();
        stage.scrollTop -= page;
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        stage.scrollTop = 0;
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        stage.scrollTop = stage.scrollHeight;
        return;
      }
    }
    if (!meta) return;
    const key = (e.key || '').toLowerCase();
    if (key === 'c') {
      const sel = window.getSelection();
      if (sel && String(sel).trim()) return; // 选中了文字就交给浏览器复制
      e.preventDefault();
      copyImage();
    } else if (key === 's') {
      e.preventDefault();
      download();
    }
  });

  let rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if (state.base) render();
      if (cropping) exitCrop();
    }, 160);
  });

  bindCrop();
  bindPan();
  updateZoomLabel();
}

bindUI();
boot();
