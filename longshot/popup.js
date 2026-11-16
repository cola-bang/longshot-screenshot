/* LongShot · popup
 * 首帧零阻塞渲染：不在首屏同步读取 localStorage 或等待后台，首帧绘制后再异步同步设置并预热后台。
 */
'use strict';

const DEFAULTS = { hideSticky: true, preload: true };
const STORAGE_KEY = 'ls:settings';
const LEGACY_LS_KEY = 'ls-popup-settings';
const START_TIMEOUT = 8000;

const BLOCKED_SCHEME = /^(chrome|edge|brave|opera|vivaldi|about|devtools|view-source|chrome-extension|moz-extension|edge-extension|chrome-untrusted):/i;
const BLOCKED_HOST = /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|addons\.mozilla\.org|microsoftedge\.microsoft\.com\/addons)/i;

const $ = (id) => document.getElementById(id);

let currentTab = null;
let starting = false;
let userToggled = false;

function blockedReason(url) {
  const u = String(url || '');
  if (BLOCKED_SCHEME.test(u)) return '浏览器内置页面（设置、扩展商店等）不允许注入脚本，请切换到普通网页。';
  if (BLOCKED_HOST.test(u)) return '浏览器扩展商店页面受保护，无法截图。';
  return null;
}

function readFormSettings() {
  return {
    hideSticky: $('hideSticky').checked,
    preload: $('preload').checked
  };
}

function applySettings(settings) {
  $('hideSticky').checked = settings.hideSticky !== false;
  $('preload').checked = settings.preload !== false;
}

function storageGet(key) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.get(key, (res) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(res || {});
      });
    } catch (e) {
      reject(e);
    }
  });
}

function saveSettings(obj) {
  try {
    chrome.storage.local.set({ [STORAGE_KEY]: obj }, () => void chrome.runtime.lastError);
  } catch (e) {
    /* 忽略：隐私模式或上下文异常时 */
  }
}

function showAlert(text) {
  const el = $('alert');
  el.textContent = text;
  el.hidden = !text;
}

function setBusy(flag) {
  document.querySelectorAll('[data-mode]').forEach((b) => {
    b.disabled = flag;
  });
}

function sendOnce(msg, timeout) {
  const call = new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (res) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(res);
    });
  });
  if (!timeout) return call;
  return Promise.race([
    call,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('后台没有响应，请到扩展管理页点一次「重新加载」')), timeout)
    )
  ]);
}

// Service Worker 冷启动期间第一条消息可能直接失败（Receiving end does not exist），
// 这类错误重试即可恢复；超时类错误不重试，避免重复触发截图。
const RETRYABLE = /Receiving end does not exist|message port closed|Could not establish connection|Extension context invalidated/i;

async function send(msg, timeout, attempts = 5) {
  let lastErr = null;
  for (let i = 0; i < (attempts || 1); i += 1) {
    try {
      return await sendOnce(msg, timeout);
    } catch (e) {
      lastErr = e;
      if (!RETRYABLE.test(e.message || '')) throw e;
      await new Promise((r) => setTimeout(r, 140 * (i + 1)));
    }
  }
  throw lastErr;
}

async function queryActiveTabDirect() {
  try {
    const tabs = await new Promise((resolve, reject) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (res) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(res);
      });
    });
    const tab = tabs && tabs[0];
    if (tab && tab.id != null) {
      return {
        ok: true,
        tabId: tab.id,
        title: tab.title,
        url: tab.url,
        error: blockedReason(tab.url)
      };
    }
  } catch (e) {
    /* 回退到后台查询 */
  }
  return send({ type: 'GET_ACTIVE_TAB' }, 4000);
}

async function start(mode, btn) {
  if (starting) return;
  starting = true;

  const label = btn.querySelector('strong') || btn.querySelector('span');
  const prevText = label ? label.textContent : '';
  if (label) label.textContent = '启动中…';
  btn.classList.add('busy');
  setBusy(true);
  showAlert('');

  try {
    const payload = readFormSettings();
    saveSettings(payload);

    const res = await send(
      { type: 'START_CAPTURE', tabId: currentTab && currentTab.tabId, mode, settings: payload },
      START_TIMEOUT
    );

    if (!res || res.ok === false) throw new Error((res && res.error) || '启动失败');
    window.close();
  } catch (e) {
    starting = false;
    btn.classList.remove('busy');
    if (label) label.textContent = prevText;
    setBusy(false);
    showAlert(e.message || String(e));
  }
}

function migrateLegacySettings() {
  let legacy = null;
  try {
    const raw = localStorage.getItem(LEGACY_LS_KEY);
    if (raw) legacy = JSON.parse(raw);
    localStorage.removeItem(LEGACY_LS_KEY);
  } catch (e) {
    /* 忽略：旧存储不可读或非 JSON */
  }
  const merged = Object.assign({}, DEFAULTS, legacy && typeof legacy === 'object' ? legacy : null);
  if (!userToggled) {
    applySettings(merged);
  }
  saveSettings(userToggled ? readFormSettings() : merged);
}

async function hydrateSettings() {
  try {
    const res = await storageGet(STORAGE_KEY);
    const saved = res && res[STORAGE_KEY];
    if (saved && typeof saved === 'object') {
      if (!userToggled) {
        applySettings(Object.assign({}, DEFAULTS, saved));
      }
      return;
    }
  } catch (e) {
    /* 忽略读取失败，尝试迁移动作 */
  }
  setTimeout(migrateLegacySettings, 120);
}

async function hydrateActiveTab() {
  try {
    const info = await queryActiveTabDirect();
    if (info && info.ok !== false) {
      currentTab = info;
      let host = '';
      try {
        host = info.url ? new URL(info.url).hostname.replace(/^www\./, '') : '';
      } catch (e) {
        host = '';
      }
      $('pageTitle').textContent = host || '本地处理 · 不上传';
      $('pageTitle').title = info.url || '';
      if (info.error) {
        showAlert(info.error);
      }
    } else {
      showAlert('后台尚未就绪，点击模式会自动重试');
    }
  } catch (e) {
    console.warn('[LongShot] popup tab query failed:', e && e.message);
  }
}

function hydrateAfterPaint() {
  // 若当前标签页正在截图中，再次点击扩展图标直接停止并保存已截内容
  try {
    chrome.runtime.sendMessage({ type: 'STOP_IF_CAPTURING' }, (res) => {
      if (!chrome.runtime.lastError && res && res.stopped) {
        window.close();
      }
    });
  } catch (e) {
    /* ignore */
  }
  hydrateSettings();
  hydrateActiveTab();
  // 首帧弹出后再温和唤醒 Service Worker，避免点击图标瞬间与首屏渲染抢占 CPU
  setTimeout(() => {
    try {
      chrome.runtime.sendMessage({ type: 'PING' }, () => void chrome.runtime.lastError);
    } catch (e) {
      /* ignore */
    }
  }, 60);
}

function init() {
  const verEl = document.querySelector('.ver');
  if (verEl) {
    const nextVer = 'v' + chrome.runtime.getManifest().version.split('.').slice(0, 2).join('.');
    if (verEl.textContent !== nextVer) verEl.textContent = nextVer;
  }

  document.querySelectorAll('[data-mode]').forEach((b) => {
    b.addEventListener('click', () => start(b.dataset.mode, b));
  });
  const onOptionChange = () => {
    userToggled = true;
    saveSettings(readFormSettings());
  };
  $('hideSticky').addEventListener('change', onOptionChange);
  $('preload').addEventListener('change', onOptionChange);

  requestAnimationFrame(() => setTimeout(hydrateAfterPaint, 0));
}

init();
