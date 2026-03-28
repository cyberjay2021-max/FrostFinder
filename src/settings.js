/**
 * settings.js — Settings persistence helpers
 *
 * r29 P2.1 Stage 3: Extracted from main.js.
 * Exports: loadPersistentSettings, persistSettings, patchLocalStorage,
 *          isSettingsLoaded, setSettingsLoaded
 *
 * Note: the Settings UI dialog (_showSettings) lives in main.js where it has
 * access to the full application state, render(), initI18n(), applyTheme(), etc.
 *
 * Dependencies injected via initSettingsDeps():
 *   showToast, t
 */

import { invoke } from '@tauri-apps/api/core';

let _deps = {};
let _settingsLoaded = false;

export function initSettingsDeps(deps) { _deps = deps; }
export function isSettingsLoaded() { return _settingsLoaded; }
export function setSettingsLoaded(v) { _settingsLoaded = v; }

// ── Persistent settings ───────────────────────────────────────────────────────

export async function loadPersistentSettings() {
  try {
    const saved = await invoke('get_settings');
    if (saved && typeof saved === 'object') {
      if (saved._reset === true) {
        setTimeout(() => _deps.showToast(_deps.t('toast.settings_reset'), 'warn'), 1200);
      }
      for (const [k, v] of Object.entries(saved)) {
        if (k === '_reset') continue;
        if (localStorage.getItem(k) === null) {
          localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
        }
      }
    }
  } catch (e) {
    console.warn('loadPersistentSettings:', e);
  }
  _settingsLoaded = true;
}

export async function persistSettings() {
  if (!_settingsLoaded) return;
  try {
    const obj = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('ff_')) obj[k] = localStorage.getItem(k);
    }
    await invoke('set_settings', { settings: obj });
  } catch (e) {
    console.warn('persistSettings:', e);
  }
}

/** Patch localStorage.setItem to auto-persist any ff_* key change. */
export function patchLocalStorage() {
  const _orig = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function (k, v) {
    _orig(k, v);
    if (_settingsLoaded && k.startsWith('ff_')) persistSettings();
  };
}
