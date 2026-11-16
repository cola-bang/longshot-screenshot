/* LongShot · content.js
 * 采集引擎：滚动 → 逐帧截屏 → 记录每帧在成图中的偏移 → 交给预览页合成。
 * 设计要点：
 *  1) 编排写在页面脚本里（生命周期稳定），background 只提供 captureVisibleTab。
 *  2) 采集期间隐藏所有注入 UI，避免被拍进图片。
 *  3) 第 2 帧起隐藏 position:fixed / sticky 元素，避免导航栏反复出现。
 */
'use strict';

(() => {
  if (window.__LONGSHOT__) return;
  window.__LONGSHOT__ = true;

  const MAX_CSS_HEIGHT = 20000; // 单张成图最大高度（CSS px）
  const MAX_FRAMES = 90;
  const UI_ATTR = 'data-longshot-ui';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

  let busy = false;

  /* ---------------------------------------------------------------- 通信 */

  function msg(payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(payload, (res) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        if (!res) return reject(new Error('后台无响应'));
        if (res.ok === false) return reject(new Error(res.error || '未知错误'));
        resolve(res);
      });
    });
  }

  function notify(text) {
    try {
      chrome.runtime.sendMessage({ type: 'CAPTURE_PROGRESS', text }, () => void chrome.runtime.lastError);
    } catch (e) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ UI */

  const ui = (() => {
    let host = null;
    let root = null;
    let card = null;
    let titleEl = null;
    let subEl = null;
    let barEl = null;
    let fillEl = null;
    let toastEl = null;
    let toastTimer = 0;
    let destroyTimer = 0;

    const CSS = `
      :host { all: initial; }
      * { box-sizing: border-box; }
      .wrap {
        position: fixed; top: 16px; left: 50%; transform: translateX(-50%) translateY(-10px);
        opacity: 0; transition: opacity .16s ease, transform .16s ease; pointer-events: none;
      }
      .wrap.on { opacity: 1; transform: translateX(-50%) translateY(0); pointer-events: auto; }
      .card {
        display: flex; align-items: center; gap: 11px;
        min-width: 268px; max-width: 380px;
        padding: 11px 13px;
        border-radius: 14px;
        background: rgba(15, 18, 25, .97);
        border: 1px solid rgba(255, 255, 255, .10);
        box-shadow: 0 14px 40px rgba(0, 0, 0, .38), 0 2px 6px rgba(0, 0, 0, .2);
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        color: #e8edf7;
      }
      .mark {
        flex: 0 0 auto; width: 27px; height: 27px; border-radius: 9px;
        background: linear-gradient(135deg, #3b82f6, #22d3ee);
        display: flex; align-items: center; justify-content: center;
        box-shadow: inset 0 1px 0 rgba(255,255,255,.35);
      }
      .mark svg { width: 15px; height: 15px; display: block; }
      .txt { flex: 1 1 auto; min-width: 0; }
      .t { font-weight: 600; letter-spacing: .2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .s { margin-top: 2px; font-size: 11.5px; color: #97a3b6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .bar { margin-top: 8px; height: 3px; border-radius: 3px; background: rgba(255,255,255,.13); overflow: hidden; }
      .bar i { display: block; height: 100%; width: 0; border-radius: 3px; background: linear-gradient(90deg, #3b82f6, #22d3ee); transition: width .22s ease; }
      .esc {
        flex: 0 0 auto; font-size: 11px; color: #8c98ab; border: 1px solid rgba(255,255,255,.14);
        border-radius: 6px; padding: 3px 6px; cursor: pointer; user-select: none; background: rgba(255,255,255,.04);
      }
      .esc:hover { color: #fff; border-color: rgba(255,255,255,.3); }
      .toast {
        position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%) translateY(8px);
        opacity: 0; transition: opacity .18s ease, transform .18s ease;
        max-width: 460px; padding: 10px 15px; border-radius: 11px;
        background: rgba(15, 18, 25, .97); color: #eef3ff;
        border: 1px solid rgba(255,255,255,.10); box-shadow: 0 12px 34px rgba(0,0,0,.4);
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        text-align: center;
      }
      .toast.on { opacity: 1; transform: translateX(-50%) translateY(0); }
      .toast.err { border-color: rgba(255, 106, 106, .45); }
    `;

    function destroy() {
      clearTimeout(toastTimer);
      clearTimeout(destroyTimer);
      toastTimer = 0;
      destroyTimer = 0;
      if (host) host.remove();
      host = root = card = titleEl = subEl = barEl = fillEl = toastEl = null;
    }

    function ensure() {
      clearTimeout(destroyTimer);
      destroyTimer = 0;
      if (host && host.isConnected) return;
      host = document.createElement('div');
      host.setAttribute(UI_ATTR, '1');
      host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
      root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>${CSS}</style>
        <div class="wrap" id="wrap">
          <div class="card">
            <div class="mark">
              <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">
                <path d="M4 7V5a1 1 0 0 1 1-1h2M17 4h2a1 1 0 0 1 1 1v2M20 17v2a1 1 0 0 1-1 1h-2M7 20H5a1 1 0 0 1-1-1v-2"/>
                <path d="M12 8v8M9 13l3 3 3-3"/>
              </svg>
            </div>
            <div class="txt">
              <div class="t" id="t">正在截图</div>
              <div class="s" id="s">请保持标签页在前台</div>
              <div class="bar" id="bar" hidden><i id="fill"></i></div>
            </div>
            <div class="esc" id="esc">Esc</div>
          </div>
        </div>
        <div class="toast" id="toast"></div>
      `;
      (document.body || document.documentElement).appendChild(host);
      card = root.getElementById('wrap');
      titleEl = root.getElementById('t');
      subEl = root.getElementById('s');
      barEl = root.getElementById('bar');
      fillEl = root.getElementById('fill');
      toastEl = root.getElementById('toast');
      root.getElementById('esc').addEventListener('click', () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
    }

    return {
      show(t, s) {
        ensure();
        titleEl.textContent = t || '正在截图';
        subEl.textContent = s || '';
        barEl.hidden = true;
        card.classList.add('on');
      },
      update(t, s, ratio) {
        ensure();
        if (t != null) titleEl.textContent = t;
        if (s != null) subEl.textContent = s;
        if (ratio != null) {
          barEl.hidden = false;
          fillEl.style.width = Math.max(0, Math.min(1, ratio)) * 100 + '%';
        }
      },
      hide() {
        if (card) card.classList.remove('on');
      },
      setHidden(flag) {
        ensure();
        host.style.display = flag ? 'none' : '';
      },
      toast(text, isError, ms) {
        ensure();
        toastEl.textContent = text;
        toastEl.className = 'toast on' + (isError ? ' err' : '');
        clearTimeout(toastTimer);
        clearTimeout(destroyTimer);
        toastTimer = setTimeout(() => {
          if (toastEl) toastEl.classList.remove('on');
          destroyTimer = setTimeout(() => {
            if (!busy) destroy();
          }, 300);
        }, ms || 2600);
      },
      destroy
    };
  })();

  /* ------------------------------------------------------- 区域 / 元素拾取 */

  const PICK_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .layer { position: fixed; inset: 0; cursor: crosshair; }
    .mask { position: absolute; inset: 0; background: rgba(9, 12, 18, .42); }
    .sel { position: absolute; border: 1px solid #5ea6ff; border-radius: 2px;
           box-shadow: 0 0 0 100vmax rgba(9, 12, 18, .42); background: transparent; display: none; }
    .size { position: absolute; display: none; padding: 3px 7px; border-radius: 6px;
            background: rgba(15, 18, 25, .95); color: #eaf1ff; border: 1px solid rgba(255,255,255,.14);
            font: 11.5px/1.3 ui-monospace, Menlo, Consolas, monospace; white-space: nowrap; }
    .hint { position: fixed; top: 18px; left: 50%; transform: translateX(-50%);
            padding: 8px 14px; border-radius: 10px; background: rgba(15, 18, 25, .94); color: #e9eff9;
            border: 1px solid rgba(255,255,255,.1); box-shadow: 0 10px 30px rgba(0,0,0,.4);
            font: 12.5px/1.4 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; white-space: nowrap; }
    .hint b { color: #7fb6ff; font-weight: 600; }
    .hl { position: fixed; display: none; border: 1.5px solid #5ea6ff; border-radius: 3px;
          background: rgba(94, 166, 255, .10); pointer-events: none; }
    .tag { position: absolute; top: -22px; left: -1px; padding: 2px 7px; border-radius: 5px;
           background: #2f6bff; color: #fff; white-space: nowrap;
           font: 11px/1.4 ui-monospace, Menlo, Consolas, monospace; }
  `;

  function makePickHost() {
    const host = document.createElement('div');
    host.setAttribute(UI_ATTR, '1');
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${PICK_CSS}</style>`;
    (document.body || document.documentElement).appendChild(host);
    return { host, root };
  }

  function pickRegion() {
    return new Promise((resolve) => {
      const { host, root } = makePickHost();
      const layer = document.createElement('div');
      layer.className = 'layer';
      layer.innerHTML = `<div class="mask"></div><div class="sel"></div><div class="size"></div>
        <div class="hint">拖拽框选；拖到屏幕上下边缘会自动滚动 · <b>Esc</b> 取消</div>`;
      root.appendChild(layer);
      const sel = root.querySelector('.sel');
      const size = root.querySelector('.size');
      const mask = root.querySelector('.mask');

      const vw = () => window.innerWidth;
      const vh = () => window.innerHeight;
      const clampX = (v) => Math.max(0, Math.min(vw(), v));

      let anchor = null; // { x: 视口坐标, y: 页面坐标 }
      let cur = null;
      let last = { x: 0, y: 0 };
      let dragging = false;
      let rafId = 0;
      let drawRaf = 0;
      let autoDir = 0;

      const draw = () => {
        if (!anchor || !cur) return;
        const left = Math.min(anchor.x, cur.x);
        const right = Math.max(anchor.x, cur.x);
        const top = Math.min(anchor.y, cur.y) - window.scrollY;
        const bottom = Math.max(anchor.y, cur.y) - window.scrollY;
        const vTop = Math.max(0, top);
        const vBottom = Math.min(vh(), bottom);
        const w = Math.max(0, right - left);
        const h = Math.max(0, vBottom - vTop);
        const visible = w > 1 && h > 1;
        sel.style.display = visible ? 'block' : 'none';
        if (visible) {
          sel.style.left = left + 'px';
          sel.style.top = vTop + 'px';
          sel.style.width = w + 'px';
          sel.style.height = h + 'px';
        }
        const totalH = Math.abs(cur.y - anchor.y);
        const showSize = w > 16 && totalH > 16;
        size.style.display = showSize ? 'block' : 'none';
        if (showSize) {
          const arrow = autoDir > 0 ? '  ↓ 自动滚动' : autoDir < 0 ? '  ↑ 自动滚动' : '';
          size.textContent = `${Math.round(w)} × ${Math.round(totalH)}${arrow}`;
          const labelTop = vTop > 28 ? vTop - 24 : vBottom + 6;
          size.style.left = Math.max(4, Math.min(left, vw() - 200)) + 'px';
          size.style.top = Math.max(4, Math.min(vh() - 26, labelTop)) + 'px';
        }
      };

      const scheduleDraw = () => {
        if (drawRaf) return;
        drawRaf = requestAnimationFrame(() => {
          drawRaf = 0;
          if (dragging) draw();
        });
      };

      // 拖到上下边缘时自动滚页：选区按页面坐标记，滚多少就延伸多少
      const tick = () => {
        if (!dragging) return;
        const edge = 48;
        const y = Math.max(0, Math.min(vh() - 1, last.y));
        let v = 0;
        if (last.y > vh() - edge) v = Math.min(30, 6 + (last.y - (vh() - edge)) * 0.6);
        else if (last.y < edge) v = -Math.min(30, 6 + (edge - last.y) * 0.6);
        autoDir = v === 0 ? 0 : Math.sign(v);
        if (v) {
          const before = window.scrollY;
          window.scrollTo(0, before + v);
          if (Math.round(window.scrollY) !== Math.round(before)) {
            cur.y = y + window.scrollY;
            draw();
          }
        }
        rafId = requestAnimationFrame(tick);
      };

      const cleanup = (value) => {
        dragging = false;
        cancelAnimationFrame(rafId);
        cancelAnimationFrame(drawRaf);
        drawRaf = 0;
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('scroll', onScroll, true);
        host.remove();
        resolve(value);
      };

      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cleanup(null);
        }
      };
      const onScroll = () => {
        if (dragging) scheduleDraw();
      };

      layer.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        layer.setPointerCapture(e.pointerId);
        mask.style.display = 'none';
        dragging = true;
        anchor = { x: clampX(e.clientX), y: e.clientY + window.scrollY };
        cur = { x: anchor.x, y: anchor.y };
        last = { x: e.clientX, y: e.clientY };
        draw();
        cancelAnimationFrame(rafId);
        rafId = requestAnimationFrame(tick);
      });

      layer.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        last = { x: e.clientX, y: e.clientY };
        cur = {
          x: clampX(e.clientX),
          y: Math.max(0, Math.min(vh(), e.clientY)) + window.scrollY
        };
        scheduleDraw();
      });

      const release = () => {
        if (!dragging) return;
        dragging = false;
        cancelAnimationFrame(rafId);
        cancelAnimationFrame(drawRaf);
        drawRaf = 0;
        autoDir = 0;
        const x1 = Math.min(anchor.x, cur.x);
        const y1 = Math.min(anchor.y, cur.y);
        const w = Math.abs(cur.x - anchor.x);
        const h = Math.abs(cur.y - anchor.y);
        if (w < 6 || h < 6) {
          cleanup(null);
          return;
        }
        cleanup({
          x: Math.round(x1),
          y: Math.round(Math.max(0, y1)),
          w: Math.round(w),
          h: Math.round(h)
        });
      };

      layer.addEventListener('pointerup', release);
      layer.addEventListener('pointercancel', () => cleanup(null));

      window.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', onScroll, true);
    });
  }

  function pickElement() {
    return new Promise((resolve) => {
      const { host, root } = makePickHost();
      host.style.pointerEvents = 'none';
      const layer = document.createElement('div');
      layer.className = 'layer';
      layer.style.pointerEvents = 'none';
      layer.innerHTML = `<div class="hl"><div class="tag"></div></div>
        <div class="hint">移动到目标区域后点击 · <b>Esc</b> 取消</div>`;
      root.appendChild(layer);
      const hl = root.querySelector('.hl');
      const tag = root.querySelector('.tag');
      let target = null;
      let moveRaf = 0;
      let lastPos = null;

      const describe = (el) => {
        const id = el.id ? '#' + el.id : '';
        const cls = (el.className && typeof el.className === 'string')
          ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
          : '';
        return `${el.tagName.toLowerCase()}${id}${cls}`.slice(0, 48);
      };

      const resolveTarget = (x, y) => {
        const el = document.elementFromPoint(x, y);
        if (!el || el === host || host.contains(el) || el.hasAttribute(UI_ATTR)) return null;
        return el;
      };

      const paint = () => {
        if (!target) return;
        const r = target.getBoundingClientRect();
        hl.style.display = 'block';
        hl.style.left = r.left + 'px';
        hl.style.top = r.top + 'px';
        hl.style.width = r.width + 'px';
        hl.style.height = r.height + 'px';
        tag.textContent = `${describe(target)}  ${Math.round(r.width)}×${Math.round(r.height)}`;
      };

      const onMove = (e) => {
        lastPos = { x: e.clientX, y: e.clientY };
        if (moveRaf) return;
        moveRaf = requestAnimationFrame(() => {
          moveRaf = 0;
          if (!lastPos) return;
          const el = resolveTarget(lastPos.x, lastPos.y);
          if (!el || el === target) return;
          target = el;
          paint();
        });
      };

      const cleanup = (value) => {
        cancelAnimationFrame(moveRaf);
        moveRaf = 0;
        window.removeEventListener('mousemove', onMove, true);
        window.removeEventListener('click', onClick, true);
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('wheel', stop, true);
        host.remove();
        resolve(value);
      };

      const onClick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const hit = resolveTarget(e.clientX, e.clientY);
        if (hit) target = hit;
        if (!target) {
          cleanup(null);
          return;
        }
        cleanup(target);
      };

      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cleanup(null);
        }
      };
      const stop = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };

      window.addEventListener('mousemove', onMove, true);
      window.addEventListener('click', onClick, true);
      window.addEventListener('keydown', onKey, true);
      window.addEventListener('wheel', stop, { passive: false, capture: true });
    });
  }

  /* ---------------------------------------------------------- 页面预处理 */

  function applyPrepStyles() {
    const st = document.createElement('style');
    st.id = 'longshot-prep';
    st.textContent = `
      html, body, * { scroll-behavior: auto !important; }
      html::-webkit-scrollbar, body::-webkit-scrollbar, *::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important; }
      html, body, * { scrollbar-width: none !important; }
    `;
    (document.head || document.documentElement).appendChild(st);
    return () => st.remove();
  }

  function preferEagerImages() {
    const changed = [];
    document.querySelectorAll('img[loading="lazy"], iframe[loading="lazy"]').forEach((el) => {
      changed.push([el, el.getAttribute('loading')]);
      el.setAttribute('loading', 'eager');
    });
    return () => {
      for (const [el, v] of changed) {
        if (v == null) el.removeAttribute('loading');
        else el.setAttribute('loading', v);
      }
    };
  }

  async function preloadPass(settings) {
    const se = document.scrollingElement || document.documentElement;
    const vh = document.documentElement.clientHeight || window.innerHeight;
    const max = Math.min(se.scrollHeight, MAX_CSS_HEIGHT);
    if (max <= vh + 8) return;
    const stepSize = Math.max(220, Math.floor(vh * 0.85));
    let steps = 0;
    for (let y = 0; y < max && steps < 40; y += stepSize) {
      window.scrollTo(0, y);
      await sleep(settings.preloadDelay == null ? 70 : settings.preloadDelay);
      steps += 1;
    }
    window.scrollTo(0, 0);
    await sleep(180);
  }

  function findScroller() {
    let best = null;
    let bestArea = 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const nodes = document.querySelectorAll('main, section, article, div, ul, ol');
    for (const el of nodes) {
      if (el.scrollHeight - el.clientHeight < 40) continue;
      const r = el.getBoundingClientRect();
      if (r.width < vw * 0.3 || r.height < vh * 0.3) continue;
      const cs = getComputedStyle(el);
      if (!/auto|scroll|overlay/.test(cs.overflowY)) continue;
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = el;
      }
    }
    return best;
  }

  const SKIP_TAGS = new Set(['HEAD', 'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE']);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function hideFloating(rootEl, exclude) {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const toHide = [];
    let visited = 0;
    let inViewport = 0;

    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_ELEMENT, {
      acceptNode(el) {
        if (el.hasAttribute(UI_ATTR)) return NodeFilter.FILTER_REJECT;
        if (exclude && el === exclude) return NodeFilter.FILTER_SKIP;
        if (SKIP_TAGS.has(el.tagName)) return NodeFilter.FILTER_REJECT;
        if (el.namespaceURI === SVG_NS && el.localName !== 'svg') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    // 第一阶段：只读收集，避免循环内读写交替引发强制同步回流
    let el;
    while ((el = walker.nextNode())) {
      if (visited >= 15000 || inViewport >= 5000 || toHide.length >= 300) break;
      visited += 1;
      const tag = el.tagName;
      if (tag === 'HTML' || tag === 'BODY') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.bottom < 0 || r.top > vh || r.right < 0 || r.left > vw) continue;
      inViewport += 1;
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
      toHide.push(el);
    }

    // 第二阶段：批量写入样式
    const saved = [];
    for (const node of toHide) {
      saved.push([node, node.style.getPropertyValue('visibility'), node.style.getPropertyPriority('visibility')]);
      node.style.setProperty('visibility', 'hidden', 'important');
    }

    return () => {
      for (const [node, v, prio] of saved) {
        if (v) node.style.setProperty('visibility', v, prio);
        else node.style.removeProperty('visibility');
      }
    };
  }

  /* ------------------------------------------------------------ 采集核心 */

  function docViewport() {
    const de = document.documentElement;
    return {
      w: Math.round(de.clientWidth || window.innerWidth), // 内容宽度（不含滚动条）
      h: Math.round(de.clientHeight || window.innerHeight),
      iw: Math.round(window.innerWidth) // 画面宽度（含滚动条），用于反算缩放比
    };
  }

  function setScroll(scroller, isDoc, y) {
    if (isDoc) window.scrollTo(0, Math.round(y));
    else scroller.scrollTop = Math.round(y);
  }

  function getScroll(scroller, isDoc) {
    return Math.round(isDoc ? window.scrollY : scroller.scrollTop);
  }

  async function settle(settings) {
    await nextFrame();
    await sleep(settings.settle == null ? 130 : settings.settle);
  }

  async function captureAndStoreFrame(id, index, dy, src) {
    if (document.visibilityState !== 'visible') {
      throw new Error('标签页切到后台，截图已中断');
    }
    await msg({ type: 'CAPTURE_FRAME', id, index, dy, src });
  }

  function elementClientRect(el) {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + el.clientLeft),
      y: Math.round(r.top + el.clientTop),
      w: Math.round(el.clientWidth),
      h: Math.round(el.clientHeight)
    };
  }

  /**
   * 滚动采集
   * @param {string} id  采集会话 id
   * @param {object} settings
   * @param {Element} scroller 滚动容器（文档时为 scrollingElement）
   * @param {boolean} isDoc 是否文档级滚动
   * @param {{x,y,w,h}} crop 每帧从视口裁切的矩形（CSS px）
   * @param {boolean} hideFromStart 是否第一帧就隐藏浮层
   */
  async function runScrollCapture(id, settings, scroller, isDoc, crop, hideFromStart) {
    const vp = docViewport();
    const step = Math.max(80, Math.round(crop.h));
    const limit = Math.min(scroller.scrollHeight, MAX_CSS_HEIGHT);
    const ys = [];
    for (let y = 0; y < limit; y += step) ys.push(Math.min(y, Math.max(0, limit - step)));
    if (!ys.length) ys.push(0);

    let unhide = null;
    let index = 0;
    let total = limit;
    let baseOffset = null;
    let outH = 0;
    let cancelled = false;

    const onKey = (e) => {
      if (e.key === 'Escape') cancelled = true;
    };
    window.addEventListener('keydown', onKey, true);

    ui.setHidden(true);
    try {
      if (hideFromStart && settings.hideSticky !== false) {
        unhide = hideFloating(document.documentElement, isDoc ? null : scroller);
      }

      while (index < ys.length) {
        if (cancelled) throw new Error('已取消截图');
        if (index >= MAX_FRAMES) break;

        setScroll(scroller, isDoc, ys[index]);
        await settle(settings);

        const actual = getScroll(scroller, isDoc);
        if (baseOffset == null) baseOffset = actual;
        const dy = Math.max(0, actual - baseOffset);

        notify(`${Math.min(index + 1, ys.length)}/${ys.length}`);
        ui.update(`正在截取 ${index + 1}/${ys.length}`, '请勿切换标签页', (index + 1) / ys.length);

        await captureAndStoreFrame(id, index, dy, { x: crop.x, y: crop.y, w: crop.w, h: crop.h });

        outH = Math.max(outH, dy + crop.h);
        index += 1;

        // 懒加载可能让页面继续变长
        const now = Math.min(scroller.scrollHeight, MAX_CSS_HEIGHT);
        if (now > total + 8 && index < MAX_FRAMES) {
          for (let y = total; y < now; y += step) {
            const clamped = Math.min(y, Math.max(0, now - step));
            if (!ys.includes(clamped)) ys.push(clamped);
          }
          total = now;
        }

        if (index === 1 && !hideFromStart && settings.hideSticky !== false) {
          unhide = hideFloating(document.documentElement, isDoc ? null : scroller);
        }
      }
    } finally {
      window.removeEventListener('keydown', onKey, true);
      if (unhide) unhide();
      ui.setHidden(false);
      ui.hide();
    }

    return { pages: index, outW: crop.w, outH: Math.round(Math.min(outH, total)), frameW: vp.iw };
  }

  async function finish(id, mode, result) {
    const meta = {
      id,
      mode,
      title: (document.title || '').slice(0, 120),
      url: location.href,
      outW: Math.round(result.outW),
      outH: Math.round(result.outH),
      frameW: result.frameW,
      pages: result.pages,
      ts: Date.now()
    };
    if (meta.outW < 2 || meta.outH < 2) throw new Error('截图区域无效');
    await msg({ type: 'CAPTURE_COMPLETE', id, meta });
  }

  /* ------------------------------------------------------------ 模式入口 */

  async function captureFullPage(id, settings, saved) {
    ui.show('正在准备页面', settings.preload === false ? '即将开始逐帧截取' : '预加载页面内容…');
    const restoreStyle = applyPrepStyles();
    const restoreEager = preferEagerImages();
    try {
      if (settings.preload !== false) {
        await preloadPass(settings);
        ui.update('页面已就绪', '正在逐帧截取');
      }

      const se = document.scrollingElement || document.documentElement;
      if (se.scrollHeight - se.clientHeight < 8 || se.scrollHeight < window.innerHeight + 8) {
        const inner = findScroller();
        if (inner) {
          ui.update('检测到内层滚动容器', '正在截取该区域');
          inner.scrollIntoView({ block: 'center', inline: 'nearest' });
          await settle(settings);
          const rect = elementClientRect(inner);
          if (rect.h > docViewport().h - 4) throw new Error('页面使用了内层滚动容器，且容器高于可视区域，请缩小页面缩放后重试。');
          const res = await runScrollCapture(id, settings, inner, false, rect, false);
          return res;
        }
      }

      window.scrollTo(0, 0);
      await settle(settings);
      const vp = docViewport();
      const res = await runScrollCapture(id, settings, se, true, { x: 0, y: 0, w: vp.w, h: vp.h }, false);
      if (res.outH >= MAX_CSS_HEIGHT - 2) {
        ui.toast('页面超过 20000px，已截取前 20000px', false, 3600);
      }
      return res;
    } finally {
      restoreEager();
      restoreStyle();
      if (saved) window.scrollTo(saved.x, saved.y);
    }
  }

  async function captureElementArea(id, settings, el, saved) {
    const restoreStyle = applyPrepStyles();
    const restoreEager = preferEagerImages();
    try {
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      await settle(settings);
      const rect = elementClientRect(el);
      const vp = docViewport();
      if (rect.h > vp.h - 4) throw new Error('该元素高于可视区域，请先按 Ctrl + 减号 缩小页面，再试一次。');

      const scrollable = el.scrollHeight > el.clientHeight + 8;
      if (!scrollable) {
        ui.show('正在截取元素', '该元素不可滚动，截取当前可视部分');
        const res = await captureSingleFrame(id, settings, rect);
        return res;
      }
      ui.show('正在截取元素', '逐帧滚动容器内容');
      return await runScrollCapture(id, settings, el, false, rect, true);
    } finally {
      restoreEager();
      restoreStyle();
      if (saved) window.scrollTo(saved.x, saved.y);
    }
  }

  async function captureSingleFrame(id, settings, crop) {
    const vp = docViewport();
    // 裁掉右侧滚动条区域
    const x = Math.max(0, Math.min(crop.x, vp.w - 1));
    const y = Math.max(0, Math.min(crop.y, vp.h - 1));
    const w = Math.max(1, Math.min(crop.w, vp.w - x));
    const h = Math.max(1, Math.min(crop.h, vp.h - y));
    const rect = { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
    ui.setHidden(true);
    try {
      await settle(settings);
      notify('1/1');
      await captureAndStoreFrame(id, 0, 0, rect);
      return { pages: 1, outW: rect.w, outH: rect.h, frameW: vp.iw };
    } finally {
      ui.setHidden(false);
      ui.hide();
    }
  }

  /**
   * 框选长图：选区按页面坐标记录，纵向可以远超一屏。
   * sel.x / sel.w 为视口横向范围，sel.y / sel.h 为页面纵向范围。
   */
  async function captureBand(id, settings, sel, saved) {
    const restoreStyle = applyPrepStyles();
    const restoreEager = preferEagerImages();
    const se = document.scrollingElement || document.documentElement;
    let vp = docViewport();
    let vh = vp.h;
    let scrollH = se.scrollHeight;

    const x = Math.max(0, Math.min(sel.x, vp.w - 1));
    const w = Math.max(4, Math.min(sel.w, vp.w - x));
    const top = Math.max(0, Math.min(sel.y, Math.max(0, scrollH - 1)));
    const limit = Math.min(scrollH, MAX_CSS_HEIGHT);
    const height = Math.max(4, Math.min(sel.h, limit - top));

    let unhide = null;
    let cancelled = false;
    const onKey = (e) => {
      if (e.key === 'Escape') cancelled = true;
    };

    ui.show('正在截取选区', `${Math.round(w)} × ${Math.round(height)}`);
    ui.setHidden(true);
    window.addEventListener('keydown', onKey, true);
    try {
      if (height > vh * 1.3 && settings.preload !== false) await preloadPass(settings);
      vp = docViewport();
      vh = vp.h;
      scrollH = se.scrollHeight;
      if (settings.hideSticky !== false) unhide = hideFloating(document.documentElement, null);

      const maxScroll = Math.max(0, scrollH - vh);
      const end = top + height;
      let scroll = Math.min(top, maxScroll);
      let index = 0;

      for (let guard = 0; guard < MAX_FRAMES; guard += 1) {
        if (cancelled) throw new Error('已取消截图');
        setScroll(se, true, scroll);
        await settle(settings);

        const actual = Math.round(window.scrollY);
        const sTop = Math.max(actual, top);
        const sBottom = Math.min(actual + vh, end);
        if (sBottom - sTop < 2) break;

        const src = {
          x: Math.round(x),
          y: Math.round(sTop - actual),
          w: Math.round(w),
          h: Math.round(sBottom - sTop)
        };
        notify(`截取中 ${index + 1}`);
        await captureAndStoreFrame(id, index, Math.round(sTop - top), src);
        index += 1;

        if (sBottom >= end) break;
        const next = Math.min(sBottom, maxScroll);
        if (next <= actual) break;
        scroll = next;
      }

      if (!index) throw new Error('选区没有取到画面');
      return { pages: index, outW: Math.round(w), outH: Math.round(height), frameW: vp.iw };
    } finally {
      window.removeEventListener('keydown', onKey, true);
      if (unhide) unhide();
      ui.setHidden(false);
      ui.hide();
      restoreEager();
      restoreStyle();
      if (saved) window.scrollTo(saved.x, saved.y);
    }
  }

  async function run(mode, settings) {
    const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const saved = { x: window.scrollX, y: window.scrollY };
    ui.destroy();
    try {
      // 每次开始前由后台直接清空 IndexedDB 残留帧数据
      await msg({ type: 'CAPTURE_INIT', id });

      let result = null;
      if (mode === 'visible') {
        const vp = docViewport();
        result = await captureSingleFrame(id, settings, { x: 0, y: 0, w: vp.w, h: vp.h });
        await finish(id, 'visible', result);
      } else if (mode === 'region') {
        ui.toast('拖拽框选；拖到屏幕上下边缘可自动滚动', false, 3200);
        const sel = await pickRegion();
        if (!sel) {
          ui.toast('已取消');
          return { ok: true, cancelled: true };
        }
        await nextFrame();
        result = await captureBand(id, settings, sel, saved);
        await finish(id, 'region', result);
      } else if (mode === 'element') {
        ui.toast('点击要截取的区域（可滚动容器会自动拼接）');
        const el = await pickElement();
        if (!el) {
          ui.toast('已取消');
          return { ok: true, cancelled: true };
        }
        await nextFrame();
        result = await captureElementArea(id, settings, el, saved);
        await finish(id, 'element', result);
      } else {
        result = await captureFullPage(id, settings, saved);
        await finish(id, 'full', result);
      }

      notify('');
      ui.toast('截图完成，正在打开预览…', false, 1800);
      return { ok: true, id, pages: result && result.pages };
    } catch (e) {
      notify('');
      ui.setHidden(false);
      ui.hide();
      const raw = (e && e.message) || '截图失败';
      const friendly = /activeTab|<all_urls>/i.test(raw)
        ? '当前页面未授权截图，请点击一次工具栏上的扩展图标后重试。'
        : /Cannot access contents|Cannot access/i.test(raw)
          ? '无法访问该页面（浏览器内置页或扩展商店不支持截图）。'
          : raw;
      ui.toast(friendly, true, 4200);
      try {
        chrome.runtime.sendMessage({ type: 'CAPTURE_FAILED', id }, () => void chrome.runtime.lastError);
      } catch (_) {
        /* ignore */
      }
      return { ok: false, error: (e && e.message) || String(e) };
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message) return undefined;
    if (message.type === 'LS_PING') {
      sendResponse({ ok: true, busy });
      return undefined;
    }
    if (message.type !== 'LS_START') return undefined;
    if (busy) {
      sendResponse({ ok: false, error: '正在截图，请稍候' });
      return undefined;
    }
    busy = true;
    run(message.mode || 'full', message.settings || {})
      .then((res) => sendResponse(res))
      .catch((e) => sendResponse({ ok: false, error: (e && e.message) || String(e) }))
      .finally(() => {
        busy = false;
      });
    return true;
  });
})();
