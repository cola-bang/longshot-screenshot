/* LongShot · popup */
'use strict';

const DEFAULTS = { fmt: 'png', quality: 0.92, hideSticky: true, preload: true };
const $ = (id) => document.getElementById(id);

let currentTab = null;
let settings = Object.assign({}, DEFAULTS);

function showAlert(text) {
  const el = $('alert');
  el.textContent = text;
  el.hidden = false;
}

function setBusy(flag) {
  document.querySelectorAll('[data-mode]').forEach((b) => {
    b.disabled = flag;
  });
}

function syncFormatUI() {
  document.querySelectorAll('#fmtSeg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.fmt === settings.fmt);
  });
  $('qualityRow').hidden = settings.fmt !== 'jpg';
  $('quality').value = String(settings.quality);
  $('qVal').textContent = Math.round(settings.quality * 100) + '%';
}

function readSettings() {
  return {
    fmt: settings.fmt,
    quality: settings.quality,
    hideSticky: $('hideSticky').checked,
    preload: $('preload').checked
  };
}

async function persist() {
  settings = Object.assign({}, settings, readSettings());
  try {
    await chrome.storage.local.set({ settings });
  } catch (e) {
    /* 忽略写入失败 */
  }
}

async function start(mode) {
  if (!currentTab || currentTab.tabId == null) return;
  setBusy(true);
  const payload = readSettings();
  await persist();

  let res = null;
  try {
    res = await chrome.runtime.sendMessage({
      type: 'START_CAPTURE',
      tabId: currentTab.tabId,
      mode,
      settings: payload
    });
  } catch (e) {
    res = { ok: false, error: e.message || '扩展内部错误' };
  }

  if (!res || res.ok === false) {
    setBusy(false);
    showAlert((res && res.error) || '启动截图失败，请刷新页面后重试');
    return;
  }
  window.close();
}

async function init() {
  const verEl = document.querySelector('.ver');
  if (verEl) verEl.textContent = 'v' + chrome.runtime.getManifest().version.split('.').slice(0, 2).join('.');

  try {
    const stored = await chrome.storage.local.get('settings');
    settings = Object.assign({}, DEFAULTS, stored.settings || {});
  } catch (e) {
    /* 用默认值 */
  }
  syncFormatUI();
  $('hideSticky').checked = settings.hideSticky !== false;
  $('preload').checked = settings.preload !== false;

  document.querySelectorAll('#fmtSeg button').forEach((b) => {
    b.addEventListener('click', () => {
      settings.fmt = b.dataset.fmt;
      syncFormatUI();
      persist();
    });
  });
  $('quality').addEventListener('input', (e) => {
    settings.quality = Number(e.target.value);
    $('qVal').textContent = Math.round(settings.quality * 100) + '%';
  });
  $('quality').addEventListener('change', persist);
  $('hideSticky').addEventListener('change', persist);
  $('preload').addEventListener('change', persist);

  document.querySelectorAll('[data-mode]').forEach((b) => {
    b.addEventListener('click', () => start(b.dataset.mode));
  });

  try {
    const info = await chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB' });
    if (!info || info.ok === false) {
      showAlert((info && info.error) || '无法读取当前标签页');
      setBusy(true);
      return;
    }
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
      setBusy(true);
    }
  } catch (e) {
    showAlert('扩展后台尚未就绪，请重新打开面板');
    setBusy(true);
  }
}

init();
