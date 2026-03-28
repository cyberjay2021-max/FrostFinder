// src/test/setup.js
// Stub the Tauri IPC bridge so utils.js and views.js can be imported in jsdom
// without a live Tauri process.

import '@testing-library/jest-dom';

// ── Tauri API stubs ───────────────────────────────────────────────────────────
// utils.js / views.js do not import Tauri directly, but main.js does.
// The module stubs below satisfy any transitive require during test collection.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
  emit:   vi.fn().mockResolvedValue(null),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn().mockReturnValue({
    listen:       vi.fn().mockResolvedValue(() => {}),
    emit:         vi.fn().mockResolvedValue(null),
    startDrag:    vi.fn().mockResolvedValue(null),
    setTitle:     vi.fn().mockResolvedValue(null),
  }),
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save:  vi.fn().mockResolvedValue(null),
  open:  vi.fn().mockResolvedValue(null),
}));
vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: vi.fn().mockResolvedValue(null),
  readTextFile:  vi.fn().mockResolvedValue(''),
}));
vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: { create: vi.fn() },
}));

// ── localStorage stub (jsdom provides one but reset between tests) ────────────
beforeEach(() => {
  localStorage.clear();
});
