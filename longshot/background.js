/* LongShot · background service worker
 * 职责保持极轻：注入脚本、逐帧截屏直存 IndexedDB、开预览页、清理存储。
 * 真正的滚动与坐标计算在 content script 里做（页面生命周期稳定，不会被 SW 回收打断）。
 */
'use strict';

const FRAME_MIN_INTERVAL = 620; // Chrome 限制 captureVisibleTab 每秒 2 次，留出余量
const DB_NAME = 'longshot-db';
const DB_VERSION = 1;

let lastFrameAt = 0;
let dbPromise = null;
let badgeColored = false;
let lastBadgeText = '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 注意：必须保留调用时的 this（chrome.storage.local 之类的方法脱离对象调用会抛 Illegal invocation） */
function p(obj, method, ...args) {
  return new Promise((resolve, reject) => {
    obj[method](...args, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(res);
    });
  });
}

/* ---------------------------------------------------------- IndexedDB */

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('frames')) {
        db.createObjectStore('frames', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error || new Error('无法打开截图缓存数据库'));
    };
    req.onblocked = () => {
      dbPromise = null;
      reject(new Error('截图缓存数据库被阻塞'));
    };
  });
  return dbPromise;
}

async function runIdbTx(storeNames, mode, fn) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(storeNames, mode);
        let result;
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || new Error('数据库写入失败'));
        tx.onabort = () => reject(tx.error || new Error('数据库事务被中止'));
        result = fn(tx);
      });
    } catch (e) {
      dbPromise = null;
      if (attempt === 1) throw e;
    }
  }
  return undefined;
}

function idbPut(storeName, value) {
  return runIdbTx([storeName], 'readwrite', (tx) => {
    tx.objectStore(storeName).put(value);
  });
}

function idbClearAll() {
  return runIdbTx(['sessions', 'frames'], 'readwrite', (tx) => {
    tx.objectStore('sessions').clear();
    tx.objectStore('frames').clear();
  });
}

async function dataUrlToBlob(dataUrl) {
  try {
    const res = await fetch(dataUrl);
    return await res.blob();
  } catch (e) {
    const comma = dataUrl.indexOf(',');
    const header = comma >= 0 ? dataUrl.slice(0, comma) : '';
    const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
    const m = /data:([^;]+)/i.exec(header);
    const mime = (m && m[1]) || 'image/png';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
}

/* ---------------------------------------------------------- 页面 / 截屏 */

const BLOCKED_SCHEME = /^(chrome|edge|brave|opera|vivaldi|about|devtools|view-source|chrome-extension|moz-extension|edge-extension|chrome-untrusted):/i;
const BLOCKED_HOST = /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|addons\.mozilla\.org|microsoftedge\.microsoft\.com\/addons)/i;

function blockedReason(url) {
  const u = String(url || '');
  if (BLOCKED_SCHEME.test(u)) return '浏览器内置页面（设置、扩展商店等）不允许注入脚本，请切换到普通网页。';
  if (BLOCKED_HOST.test(u)) return '浏览器扩展商店页面受保护，无法截图。';
  return null;
}

async function setBadge(text) {
  const nextText = text || '';
  if (nextText === lastBadgeText) return;
  lastBadgeText = nextText;
  try {
    await p(chrome.action, 'setBadgeText', { text: nextText });
    if (nextText && !badgeColored) {
      await p(chrome.action, 'setBadgeBackgroundColor', { color: '#2f6bff' });
      badgeColored = true;
    }
  } catch (e) {
    lastBadgeText = '';
    /* 忽略：部分环境不支持 badge */
  }
}

async function captureFrame(tabId) {
  const gap = FRAME_MIN_INTERVAL - (Date.now() - lastFrameAt);
  if (gap > 0) await sleep(gap);

  const tab = await p(chrome.tabs, 'get', tabId);
  if (!tab) throw new Error('标签页已关闭');

  // captureVisibleTab 只能拍窗口内处于激活状态的标签页；用户切走时直接中断，不强行切回
  if (!tab.active) throw new Error('标签页已切到后台，截图已中断');

  let lastErr = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const dataUrl = await p(chrome.tabs, 'captureVisibleTab', tab.windowId, { format: 'png' });
      lastFrameAt = Date.now();
      return dataUrl;
    } catch (e) {
      lastErr = e;
      if (/quota|MAX_CAPTURE|too many/i.test(e.message || '')) {
        await sleep(500 + attempt * 400);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('截屏失败');
}

async function injectContent(tabId) {
  try {
    await p(chrome.scripting, 'executeScript', { target: { tabId }, files: ['content.js'] });
  } catch (e) {
    throw new Error('无法在该页面运行脚本：' + e.message);
  }
}

async function startCapture(tabId, mode, settings) {
  // popup 拿不到 tabId 时（后台刚被唤醒 / 查询超时），自己再取一次当前标签页
  if (tabId == null) {
    const tabs = await p(chrome.tabs, 'query', { active: true, lastFocusedWindow: true }).catch(() => []);
    tabId = tabs && tabs[0] ? tabs[0].id : null;
  }
  if (tabId == null) throw new Error('找不到当前标签页，请刷新页面后重试');

  const tab = await p(chrome.tabs, 'get', tabId).catch(() => null);
  if (!tab) throw new Error('找不到目标标签页');
  const reason = blockedReason(tab.url);
  if (reason) throw new Error(reason);

  if (!tab.active) {
    await p(chrome.tabs, 'update', tabId, { active: true });
  }

  // 已注入过 content.js 的页面直接复用，避免重复读取和编译 36KB 脚本
  let injected = false;
  try {
    const pong = await p(chrome.tabs, 'sendMessage', tabId, { type: 'LS_PING' });
    if (pong && pong.ok) {
      if (pong.busy) throw new Error('正在截图，请稍候');
      injected = true;
    }
  } catch (e) {
    if (e && e.message === '正在截图，请稍候') throw e;
    injected = false;
  }

  // 注入失败要立刻反馈给 popup（此时 popup 还开着），注入成功后就不再阻塞等待
  if (!injected) {
    await injectContent(tabId);
  }
  p(chrome.tabs, 'sendMessage', tabId, { type: 'LS_START', mode, settings: settings || {} }).catch(() => {});
  return { ok: true, accepted: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg && msg.type;
  if (!type) return undefined;

  if (type === 'PING') {
    // popup 打开时先发一次，把 Service Worker 提前唤醒，避免点击后等冷启动
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return undefined;
  }

  if (type === 'CAPTURE_INIT') {
    idbClearAll()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (type === 'CAPTURE_FRAME') {
    const tabId = (sender.tab && sender.tab.id) || msg.tabId;
    (async () => {
      const dataUrl = await captureFrame(tabId);
      if (msg.id != null && msg.index != null) {
        const blob = await dataUrlToBlob(dataUrl);
        await idbPut('frames', {
          key: `${msg.id}:${msg.index}`,
          sessionId: msg.id,
          index: msg.index,
          dy: msg.dy,
          src: msg.src,
          blob
        });
        return { ok: true };
      }
      return { ok: true, dataUrl };
    })()
      .then((res) => sendResponse(res))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (type === 'CAPTURE_PROGRESS') {
    setBadge(msg.text || '');
    sendResponse({ ok: true });
    return undefined;
  }

  if (type === 'CAPTURE_COMPLETE') {
    (async () => {
      try {
        await idbPut('sessions', msg.meta);
        await setBadge('');
        await p(chrome.tabs, 'create', {
          url: chrome.runtime.getURL('viewer.html?id=' + encodeURIComponent(msg.id)),
          active: true
        });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (type === 'CAPTURE_FAILED') {
    setBadge('');
    idbClearAll().catch(() => {});
    sendResponse({ ok: true });
    return undefined;
  }

  if (type === 'START_CAPTURE') {
    startCapture(msg.tabId, msg.mode || 'full', msg.settings)
      .then((res) => sendResponse(res))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (type === 'GET_ACTIVE_TAB') {
    p(chrome.tabs, 'query', { active: true, currentWindow: true })
      .then((tabs) => {
        const tab = tabs && tabs[0];
        sendResponse({
          ok: true,
          tabId: tab && tab.id,
          title: tab && tab.title,
          url: tab && tab.url,
          error: blockedReason(tab && tab.url)
        });
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  return undefined;
});

chrome.commands.onCommand.addListener(async (command) => {
  const mode = command === 'capture-region' ? 'region' : 'full';
  try {
    const tabs = await p(chrome.tabs, 'query', { active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || tab.id == null) return;
    let settings = {};
    try {
      const stored = await p(chrome.storage.local, 'get', 'ls:settings');
      if (stored && stored['ls:settings']) settings = stored['ls:settings'];
    } catch (e) {
      /* ignore */
    }
    await startCapture(tab.id, mode, settings);
  } catch (e) {
    await setBadge('!');
  }
});

async function purgeStale() {
  try {
    await idbClearAll();
  } catch (e) {
    /* ignore */
  }
  try {
    if (typeof chrome.storage.local.getKeys === 'function') {
      const allKeys = await p(chrome.storage.local, 'getKeys');
      const stale = (allKeys || []).filter((k) => k.startsWith('ls:f:') || k.startsWith('ls:meta:'));
      if (stale.length) await p(chrome.storage.local, 'remove', stale);
    } else {
      const saved = await p(chrome.storage.local, 'get', 'ls:settings').catch(() => ({}));
      await p(chrome.storage.local, 'clear');
      if (saved && saved['ls:settings']) {
        await p(chrome.storage.local, 'set', { 'ls:settings': saved['ls:settings'] });
      }
    }
  } catch (e) {
    /* ignore */
  }
}

chrome.runtime.onStartup.addListener(purgeStale);
chrome.runtime.onInstalled.addListener(purgeStale);
