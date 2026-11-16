import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const EXT = path.join(ROOT, 'longshot');
const OUT = path.join(ROOT, 'test', 'out');
const WIN_CHROME = path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe');
const CHROME = [
  WIN_CHROME,
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Helium.app/Contents/MacOS/Helium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
]
  .filter(Boolean)
  .find((p) => fs.existsSync(p));
const PORT = 8788;

fs.mkdirSync(OUT, { recursive: true });

/* ------------------------------ static server ------------------------------ */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'demo.html';
  const file = path.join(ROOT, 'test', rel);
  if (!file.startsWith(path.join(ROOT, 'test'))) {
    res.writeHead(403).end('no');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

/* ------------------------------- launch ---------------------------------- */
const profile = path.join(ROOT, 'test', '.profile');
fs.rmSync(profile, { recursive: true, force: true });

// 测试副本：正式包只依赖 activeTab（需要用户点击图标才授权），
// 自动化里没有这个手势，因此为测试副本补上本地 host 权限，其余代码完全一致。
const TEST_EXT = path.join(ROOT, 'test', '.ext');
fs.rmSync(TEST_EXT, { recursive: true, force: true });
fs.cpSync(EXT, TEST_EXT, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(TEST_EXT, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['<all_urls>'];
fs.writeFileSync(path.join(TEST_EXT, 'manifest.json'), JSON.stringify(manifest, null, 2));

const context = await chromium.launchPersistentContext(profile, {
  ...(CHROME ? { executablePath: CHROME } : {}),
  headless: true,
  viewport: { width: 1000, height: 800 },
  args: [
    '--headless=new',
    `--disable-extensions-except=${TEST_EXT}`,
    `--load-extension=${TEST_EXT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate'
  ]
});

const log = (...a) => console.log('[test]', ...a);
const fail = (msg) => {
  console.error('[FAIL]', msg);
  process.exitCode = 1;
};

let sw = context.serviceWorkers()[0];
if (!sw) {
  sw = await context.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
}
if (!sw) {
  fail('扩展未加载（service worker 未启动）');
  await context.close();
  server.close();
  process.exit(1);
}
const extId = new URL(sw.url()).host;
log('扩展已加载:', extId);

const page = await context.newPage();
await page.goto(`http://127.0.0.1:${PORT}/demo.html`, { waitUntil: 'load' });
await page.waitForTimeout(800);
for (const p of context.pages()) {
  if (p !== page) await p.close().catch(() => {});
}
await page.bringToFront();

const info = await page.evaluate(() => ({
  h: document.documentElement.scrollHeight,
  vh: document.documentElement.clientHeight,
  sections: window.__sections
}));
log(`测试页高度 ${info.h}px, 视口 ${info.vh}px, 区块 ${info.sections.length} 个`);

const tabId = await sw.evaluate(async (urlPrefix) => {
  const all = await chrome.tabs.query({});
  const hit = all.find((t) => t.url && t.url.startsWith(urlPrefix));
  return hit ? hit.id : (all[0] && all[0].id);
}, `http://127.0.0.1:${PORT}/`);
if (tabId == null) throw new Error('找不到目标 tabId');
log('目标 tabId =', tabId);

async function trigger(mode, settings = {}) {
  await page.bringToFront();
  const viewerPromise = context.waitForEvent('page', { timeout: 150000 });
  const startPromise = sw
    .evaluate(
      async ({ tabId, mode, settings }) => {
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
        return await new Promise((resolve) => {
          chrome.tabs.sendMessage(tabId, { type: 'LS_START', mode, settings }, (res) => {
            const err = chrome.runtime.lastError;
            if (err) resolve({ ok: false, error: err.message });
            else resolve(res || { ok: false, error: 'LS_START 无响应' });
          });
        });
      },
      { tabId, mode, settings }
    )
    .catch((e) => ({ ok: false, error: e && e.message ? e.message : String(e) }));

  const failFast = startPromise.then((res) => {
    if (!res || res.ok === false) {
      throw new Error(`LS_START(${mode}) 失败: ${(res && res.error) || '未知错误'}`);
    }
    return new Promise(() => {});
  });

  let viewer;
  try {
    viewer = await Promise.race([viewerPromise, failFast]);
  } catch (e) {
    viewerPromise.catch(() => {});
    throw e;
  }
  await viewer.waitForLoadState('domcontentloaded');
  await viewer.waitForFunction(() => window.__longshot && window.__longshot.base, null, { timeout: 120000 });
  return viewer;
}

async function saveBase(viewer, name) {
  const dataUrl = await viewer.evaluate(() => window.__longshot.base.toDataURL('image/png'));
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  log('已保存拼接结果:', file, `${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
  return file;
}

/* ------------------------------- 1. 整页 ---------------------------------- */
log('— 整页长截图 —');
const t0 = Date.now();
const v1 = await trigger('full', { fmt: 'png', hideSticky: true, preload: true });
log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const r1 = await v1.evaluate((expected) => {
  const s = window.__longshot;
  const ctx = s.base.getContext('2d');
  const k = s.baseW / s.meta.outW;
  const px = (x, y) => {
    const d = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
    return [d[0], d[1], d[2]];
  };
  const hex2rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const samples = expected.map((sec) => {
    const got = px(18 * k, (sec.top + sec.height / 2) * k);
    const want = hex2rgb(sec.color);
    const diff = Math.max(...got.map((v, i) => Math.abs(v - want[i])));
    return { i: sec.i, want, got, diff };
  });
  return {
    baseW: s.baseW,
    baseH: s.baseH,
    outW: s.meta.outW,
    outH: s.meta.outH,
    pages: s.meta.pages,
    downscaled: s.downscaled,
    samples
  };
}, info.sections);

log(`输出尺寸 ${r1.baseW}×${r1.baseH} (CSS ${r1.outW}×${r1.outH}), 帧数 ${r1.pages}, 降采样 ${r1.downscaled.toFixed(2)}`);
const bad = r1.samples.filter((s) => s.diff > 8);
if (bad.length) {
  fail(`色带采样不匹配 ${bad.length}/${r1.samples.length}: ` + JSON.stringify(bad.slice(0, 4)));
} else {
  log(`色带采样全部匹配 (${r1.samples.length}/${r1.samples.length})`);
}
const expectH = Math.round(info.h * (r1.baseH / r1.outH));
if (Math.abs(r1.baseH - expectH) > 6) fail(`高度不符: 拼接 ${r1.baseH} vs 预期 ${expectH}`);
else log(`高度校验通过 (${r1.baseH} ≈ ${expectH})`);

/* ------------------------- 1.2 性能不变量校验 ------------------------- */
{
  const storageKeys = await sw.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all).filter((k) => k.startsWith('ls:f:') || k.startsWith('ls:meta:'));
  });
  if (storageKeys.length) fail(`chrome.storage.local 仍有残留帧/元数据键: ${storageKeys.length}`);
  else log('storage.local 零帧残留校验通过');

  const perfCheck = await v1.evaluate(async () => {
    const singleCanvas = document.getElementById('view') === window.__longshot.base;
    const loadingDisplay = getComputedStyle(document.getElementById('loading')).display;
    const idbFrameCount = await new Promise((resolve, reject) => {
      const req = indexedDB.open('longshot-db', 1);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction(['frames'], 'readonly');
        const cntReq = tx.objectStore('frames').count();
        cntReq.onsuccess = () => {
          db.close();
          resolve(cntReq.result);
        };
        cntReq.onerror = () => reject(cntReq.error);
      };
      req.onerror = () => reject(req.error);
    });
    return { singleCanvas, loadingDisplay, idbFrameCount };
  });
  if (perfCheck.idbFrameCount !== 0) fail(`IndexedDB frames 表未清空，残留 ${perfCheck.idbFrameCount} 条`);
  else log('IndexedDB 帧数据即刻释放校验通过');
  if (!perfCheck.singleCanvas) fail('未裁剪态预览画布未直接复用 base（存在重复画布内存）');
  else log('单画布零冗余内存校验通过');
  if (perfCheck.loadingDisplay !== 'none') fail(`loading 遮罩完成后 display=${perfCheck.loadingDisplay}，可能存在后台动画空转`);
  else log('loading 遮罩停止渲染校验通过');
}

await saveBase(v1, 'full.png');
await v1.screenshot({ path: path.join(OUT, 'viewer.png') });

/* ------------------------- 1.4 预览页滚动 ------------------------- */
{
  const pos0 = await v1.evaluate(() => document.getElementById('stage').scrollTop);
  await v1.mouse.move(500, 300);
  await v1.mouse.wheel(0, 900);
  await v1.waitForTimeout(400);
  const pos1 = await v1.evaluate(() => ({
    top: document.getElementById('stage').scrollTop,
    h: document.getElementById('stage').clientHeight,
    sh: document.getElementById('stage').scrollHeight
  }));
  log(`预览页滚动：scrollTop ${pos0} -> ${pos1.top}（可视高 ${pos1.h}，内容高 ${pos1.sh}）`);
  if (pos1.top <= pos0) fail('预览页无法滚动（scrollTop 没有变化）');

  // 鼠标停在底部悬浮工具栏上时，滚轮也应该能滚动
  const dock = await v1.evaluate(() => {
    const r = document.getElementById('dock').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  const base = await v1.evaluate(() => document.getElementById('stage').scrollTop);
  await v1.mouse.move(dock.x, dock.y);
  await v1.mouse.wheel(0, 600);
  await v1.waitForTimeout(300);
  const afterDock = await v1.evaluate(() => document.getElementById('stage').scrollTop);
  log(`悬浮工具栏上的滚轮：${base} -> ${afterDock}`);
  if (afterDock <= base) fail('鼠标停在悬浮工具栏上时无法滚动');
}

/* ------------------------- 1.4 预览页滚动 ------------------------- */
{
  const pos0 = await v1.evaluate(() => document.getElementById('stage').scrollTop);
  await v1.mouse.move(500, 300);
  await v1.mouse.wheel(0, 900);
  await v1.waitForTimeout(400);
  const pos1 = await v1.evaluate(() => ({
    top: document.getElementById('stage').scrollTop,
    h: document.getElementById('stage').clientHeight,
    sh: document.getElementById('stage').scrollHeight
  }));
  log(`预览页滚动：scrollTop ${pos0} -> ${pos1.top}（可视高 ${pos1.h}，内容高 ${pos1.sh}）`);
  if (pos1.top <= pos0) fail('预览页无法滚动（scrollTop 没有变化）');

  // 鼠标停在底部悬浮工具栏上时，滚轮也应该能滚动
  const dock = await v1.evaluate(() => {
    const r = document.getElementById('dock').getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  const base = await v1.evaluate(() => document.getElementById('stage').scrollTop);
  await v1.mouse.move(dock.x, dock.y);
  await v1.mouse.wheel(0, 600);
  await v1.waitForTimeout(300);
  const afterDock = await v1.evaluate(() => document.getElementById('stage').scrollTop);
  log(`悬浮工具栏上的滚轮：${base} -> ${afterDock}`);
  if (afterDock <= base) fail('鼠标停在悬浮工具栏上时无法滚动');
}

/* ------------------------- 1.5 预览页 Ctrl+C 复制 ------------------------- */
log('— 预览页 Ctrl+C 复制 —');
await v1.bringToFront();
await v1.waitForTimeout(300);

// 记录传给剪贴板的 blob（headless 下系统剪贴板不可用，但可以验证图片确实被构造并写入）
await v1.evaluate(() => {
  window.__clip = null;
  const Orig = window.ClipboardItem;
  window.ClipboardItem = function (data) {
    const blob = data['image/png'];
    window.__clip = { types: Object.keys(data), size: blob ? blob.size : 0 };
    return new Orig(data);
  };
});

const tCopy = Date.now();
await v1.keyboard.press('Control+c');
await v1.waitForTimeout(2800);
const toastText = await v1.evaluate(() => document.getElementById('toast').textContent);
const clip = await v1.evaluate(() => window.__clip);
log(`Ctrl+C 提示（${((Date.now() - tCopy) / 1000).toFixed(1)}s）：${toastText}`);
log(`写入剪贴板的数据：${JSON.stringify(clip)}`);
if (!/已复制|复制失败/.test(toastText)) fail('Ctrl+C 没有触发复制流程');
if (!clip || !clip.types.includes('image/png') || clip.size < 1000) fail('没有把 PNG 图片写入剪贴板');

/* ------------------------------ 2. 元素 ---------------------------------- */
log('— 元素长截图（内层滚动容器）—');
await page.bringToFront();
await page.evaluate(() => document.getElementById('scroller').scrollIntoView({ block: 'center' }));
await page.waitForTimeout(400);
const box = await page.evaluate(() => {
  const el = document.getElementById('scroller');
  const r = el.getBoundingClientRect();
  return { x: r.left + 4, y: r.top + r.height / 2, w: r.width, h: r.height };
});
const v2p = context.waitForEvent('page', { timeout: 150000 });
await sw.evaluate(
  async ({ tabId }) => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    chrome.tabs.sendMessage(tabId, { type: 'LS_START', mode: 'element', settings: {} });
  },
  { tabId }
);
await page.waitForTimeout(700);
await page.mouse.move(box.x, box.y);
await page.mouse.click(box.x, box.y);
const v2 = await v2p;
await v2.waitForLoadState('domcontentloaded');
await v2.waitForFunction(() => window.__longshot && window.__longshot.base, null, { timeout: 120000 });
const r2 = await v2.evaluate(() => {
  const s = window.__longshot;
  return { baseW: s.baseW, baseH: s.baseH, outW: s.meta.outW, outH: s.meta.outH, pages: s.meta.pages, mode: s.meta.mode };
});
log(`元素输出 ${r2.baseW}×${r2.baseH} (CSS ${r2.outW}×${r2.outH}), 帧数 ${r2.pages}, mode=${r2.mode}`);
if (r2.mode !== 'element') fail('mode 不是 element');
if (r2.outW < 500 || r2.outW > 700) fail(`元素宽度异常: ${r2.outW}`);
if (r2.outH < 900) fail(`元素高度异常: ${r2.outH}`);
await saveBase(v2, 'element.png');
await v2.close();

/* ------------------------------ 3. 区域 ---------------------------------- */
log('— 区域截图 —');
await page.bringToFront();
const v3p = context.waitForEvent('page', { timeout: 120000 });
await sw.evaluate(
  async ({ tabId }) => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    chrome.tabs.sendMessage(tabId, { type: 'LS_START', mode: 'region', settings: {} });
  },
  { tabId }
);
await page.waitForTimeout(400);
await page.mouse.move(120, 140);
await page.mouse.down();
await page.mouse.move(520, 460, { steps: 8 });
await page.mouse.up();
const v3 = await v3p;
await v3.waitForLoadState('domcontentloaded');
await v3.waitForFunction(() => window.__longshot && window.__longshot.base, null, { timeout: 60000 });
const r3 = await v3.evaluate(() => {
  const s = window.__longshot;
  return { outW: s.meta.outW, outH: s.meta.outH, baseW: s.baseW, mode: s.meta.mode };
});
log(`区域输出 CSS ${r3.outW}×${r3.outH}, 物理 ${r3.baseW}, mode=${r3.mode}`);
if (Math.abs(r3.outW - 400) > 4 || Math.abs(r3.outH - 320) > 4) fail(`区域尺寸偏差过大: ${r3.outW}×${r3.outH}`);
await saveBase(v3, 'region.png');
await v3.close();

/* ------------------------------ 3.5 可视区域 ------------------------------ */
log('— 可视区域 —');
await page.bringToFront();
await page.evaluate(() => window.scrollTo(0, 1400));
await page.waitForTimeout(250);
const v4p = context.waitForEvent('page', { timeout: 120000 });
await sw.evaluate(
  async ({ tabId }) => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    chrome.tabs.sendMessage(tabId, { type: 'LS_START', mode: 'visible', settings: {} });
  },
  { tabId }
);
const v4 = await v4p;
await v4.waitForLoadState('domcontentloaded');
await v4.waitForFunction(() => window.__longshot && window.__longshot.base, null, { timeout: 60000 });
const r4 = await v4.evaluate(() => {
  const s = window.__longshot;
  return { w: s.baseW, h: s.baseH, outW: s.meta.outW, outH: s.meta.outH, mode: s.meta.mode };
});
log(`可视区域物理 ${r4.w}×${r4.h} (CSS ${r4.outW}×${r4.outH}), mode=${r4.mode}`);
if (Math.abs(r4.outW - 1000) > 20 || Math.abs(r4.outH - 800) > 20) fail(`可视区域尺寸异常: ${r4.outW}×${r4.outH}`);
await saveBase(v4, 'visible.png');
await v4.close();
await page.evaluate(() => window.scrollTo(0, 0));

/* --------------------------- 3.6 框选长图（自动滚动） --------------------------- */
log('— 框选长图（拖到边缘自动滚动）—');
await page.bringToFront();
await page.evaluate(() => window.scrollTo(0, 400));
await page.waitForTimeout(300);
const v5p = context.waitForEvent('page', { timeout: 120000 });
await sw.evaluate(
  async ({ tabId }) => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    chrome.tabs.sendMessage(tabId, { type: 'LS_START', mode: 'region', settings: {} });
  },
  { tabId }
);
await page.waitForTimeout(700);
await page.mouse.move(180, 220);
await page.mouse.down();
await page.mouse.move(620, 600, { steps: 8 });
await page.mouse.move(620, 792, { steps: 6 });
await page.waitForTimeout(3200);
const scrolled = await page.evaluate(() => Math.round(window.scrollY));
await page.mouse.up();
log(`自动滚动到 scrollY=${scrolled}`);
const v5 = await v5p;
await v5.waitForLoadState('domcontentloaded');
await v5.waitForFunction(() => window.__longshot && window.__longshot.base, null, { timeout: 120000 });
const r5 = await v5.evaluate(() => {
  const s = window.__longshot;
  return { w: s.baseW, h: s.baseH, outW: s.meta.outW, outH: s.meta.outH, pages: s.meta.pages, mode: s.meta.mode };
});
log(`框选长图 ${r5.w}×${r5.h} (CSS ${r5.outW}×${r5.outH}), 帧数 ${r5.pages}, mode=${r5.mode}`);
if (r5.mode !== 'region') fail('mode 不是 region');
if (r5.outH <= 900) fail(`选区没有延伸出屏幕: 高度仅 ${r5.outH}`);
if (Math.abs(r5.outW - 440) > 6) fail(`选区宽度异常: ${r5.outW}`);
await saveBase(v5, 'region-long.png');
await v5.close();
await page.evaluate(() => window.scrollTo(0, 0));

/* ------------------------------ 4. popup --------------------------------- */
log('— popup 面板渲染 —');
const popup = await context.newPage();
await popup.setViewportSize({ width: 360, height: 660 });
await popup.goto(`chrome-extension://${extId}/popup.html`);
await popup.waitForTimeout(500);
await popup.evaluate(() => {
  const a = document.getElementById('alert');
  if (a) a.hidden = true;
});
await popup.screenshot({ path: path.join(OUT, 'popup.png'), fullPage: true });
log('popup 截图已保存');

{
  const uiMeta = await popup.evaluate(() => ({
    kbd: document.querySelector('#btnFull kbd')?.textContent?.trim(),
    ver: document.querySelector('.ver')?.textContent?.trim()
  }));
  if (uiMeta.kbd !== 'Alt+Shift+S') fail(`popup 快捷键文本异常: ${uiMeta.kbd}`);
  if (uiMeta.ver !== 'v1.2') fail(`popup 版本文本异常: ${uiMeta.ver}`);

  await popup.locator('label.switch').first().click();
  await popup.waitForTimeout(200);
  const storageCheck = await popup.evaluate(async () => {
    const legacy = localStorage.getItem('ls-popup-settings');
    const asyncSaved = await new Promise((resolve) => {
      chrome.storage.local.get('ls:settings', (res) => resolve(res && res['ls:settings']));
    });
    return { legacy, asyncSaved };
  });
  if (storageCheck.legacy !== null) fail(`popup 仍写入了同步 localStorage: ${storageCheck.legacy}`);
  if (!storageCheck.asyncSaved || storageCheck.asyncSaved.hideSticky !== false) {
    fail(`popup 异步设置未写入 chrome.storage.local: ${JSON.stringify(storageCheck.asyncSaved)}`);
  } else {
    log('popup 零阻塞渲染与异步设置存储校验通过');
  }
}

/* ------------------------------ teardown --------------------------------- */
await context.close();
server.close();
log(process.exitCode ? '存在失败项' : '全部通过');
