/* LongShot · popup
 * 打开即渲染（同步读 localStorage），不等待后台；点击后用超时保护给出明确反馈。
 */
'use strict';

const DEFAULTS = { hideSticky: true, preload: true };
const LS_KEY = 'ls-popup-settings';
const START_TIMEOUT = 6000;

const $ = (id) => document.getElementById(id);

let currentTab = null;
let starting = false;

function loadSettings() {
  try {
    return Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(LS_KEY) || '{}'));
  } catch (e) {
    return Object.assign({}, DEFAULTS);
  }
}

function saveSettings(obj) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(obj));
  } catch (e) {
    /* 忽略：隐私模式下可能不可写 */
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

async function send(msg, timeout, attempts = 3) {
  let lastErr = null;
  for (let i = 0; i < (attempts || 1); i += 1) {
    try {
      return await sendOnce(msg, timeout);
    } catch (e) {
      lastErr = e;
      if (!RETRYABLE.test(e.message || '')) throw e;
      await new Promise((r) => setTimeout(r, 120 * (i + 1)));
    }
  }
  throw lastErr;
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
    const payload = {
      hideSticky: $('hideSticky').checked,
      preload: $('preload').checked
    };
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

async function init() {
  const settings = loadSettings();
  $('hideSticky').checked = settings.hideSticky !== false;
  $('preload').checked = settings.preload !== false;

  const verEl = document.querySelector('.ver');
  if (verEl) {
    verEl.textContent = 'v' + chrome.runtime.getManifest().version.split('.').slice(0, 2).join('.');
  }

  document.querySelectorAll('[data-mode]').forEach((b) => {
    b.addEventListener('click', () => start(b.dataset.mode, b));
  });
  $('hideSticky').addEventListener('change', () =>
    saveSettings({ hideSticky: $('hideSticky').checked, preload: $('preload').checked })
  );
  $('preload').addEventListener('change', () =>
    saveSettings({ hideSticky: $('hideSticky').checked, preload: $('preload').checked })
  );

  // 提前唤醒 Service Worker，点击时就不用等冷启动
  try {
    chrome.runtime.sendMessage({ type: 'PING' }, () => void chrome.runtime.lastError);
  } catch (e) {
    /* ignore */
  }

  try {
    const info = await send({ type: 'GET_ACTIVE_TAB' }, 4000);
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
    console.warn('[LongShot] popup init failed:', e && e.message);
    $('pageTitle').textContent = '后台尚未就绪';
  }
}

init();
