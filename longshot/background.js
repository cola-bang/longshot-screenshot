/* LongShot · background service worker
 * 职责保持极轻：注入脚本、逐帧截屏、开预览页、清理存储。
 * 真正的滚动与坐标计算在 content script 里做（页面生命周期稳定，不会被 SW 回收打断）。
 */
'use strict';

const FRAME_MIN_INTERVAL = 620; // Chrome 限制 captureVisibleTab 每秒 2 次，留出余量
let lastFrameAt = 0;

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

const BLOCKED_SCHEME = /^(chrome|edge|brave|opera|vivaldi|about|devtools|view-source|chrome-extension|moz-extension|edge-extension|chrome-untrusted):/i;
const BLOCKED_HOST = /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|addons\.mozilla\.org|microsoftedge\.microsoft\.com\/addons)/i;

function blockedReason(url) {
  const u = String(url || '');
  if (BLOCKED_SCHEME.test(u)) return '浏览器内置页面（设置、扩展商店等）不允许注入脚本，请切换到普通网页。';
  if (BLOCKED_HOST.test(u)) return '浏览器扩展商店页面受保护，无法截图。';
  return null;
}

async function setBadge(text) {
  try {
    await p(chrome.action, 'setBadgeText', { text: text || '' });
    if (text) await p(chrome.action, 'setBadgeBackgroundColor', { color: '#2f6bff' });
  } catch (e) {
    /* 忽略：部分环境不支持 badge */
  }
}

async function captureFrame(tabId) {
  const tab = await p(chrome.tabs, 'get', tabId);
  if (!tab) throw new Error('标签页已关闭');

  // captureVisibleTab 只能拍窗口内处于激活状态的标签页；用户切走时直接中断，不强行切回
  if (!tab.active) throw new Error('标签页已切到后台，截图已中断');

  const gap = FRAME_MIN_INTERVAL - (Date.now() - lastFrameAt);
  if (gap > 0) await sleep(gap);

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

  await p(chrome.tabs, 'update', tabId, { active: true });
  // 注入失败要立刻反馈给 popup（此时 popup 还开着），注入成功后就不再阻塞等待
  await injectContent(tabId);
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

  if (type === 'CAPTURE_FRAME') {
    const tabId = (sender.tab && sender.tab.id) || msg.tabId;
    captureFrame(tabId)
      .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
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
        await p(chrome.storage.local, 'set', { ['ls:meta:' + msg.id]: msg.meta });
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
    await startCapture(tab.id, mode, {});
  } catch (e) {
    await setBadge('!');
  }
});

async function purgeStale() {
  try {
    const all = await p(chrome.storage.local, 'get', null);
    const keys = Object.keys(all).filter((k) => k.startsWith('ls:f:') || k.startsWith('ls:meta:'));
    if (keys.length) await p(chrome.storage.local, 'remove', keys);
  } catch (e) {
    /* ignore */
  }
}

chrome.runtime.onStartup.addListener(purgeStale);
chrome.runtime.onInstalled.addListener(purgeStale);
