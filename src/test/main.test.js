// src/test/main.test.js
// Unit tests for logic extracted from main.js:
//   - pushUndo / undoLastOp / redoLastOp  (stack mechanics + IPC calls)
//   - loadPersistentSettings / persistSettings  (settings persistence)
//   - t() translation helper (key lookup, plurals, interpolation)
//   - Search result filter helpers (type / date / size)
//
// Strategy: rather than importing the monolithic main.js (which runs side-
// effects at module scope and requires a live Tauri context), this file:
//   1. Copies the pure logic functions verbatim and tests them in isolation.
//   2. Tests the IPC-dependent functions by mocking `invoke` from the stub
//      that setup.js already installs, and exercising the shared `state`
//      object that the functions close over.
//
// This gives us deterministic, fast tests with zero Tauri process needed.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

// ── Helpers shared across suites ──────────────────────────────────────────────

function makeEntry(name, is_dir = false, ext = null) {
  const extension = ext ?? (is_dir ? null : (name.includes('.') ? name.split('.').pop() : null));
  return {
    name,
    path: `/home/user/${name}`,
    is_dir,
    is_hidden: name.startsWith('.'),
    is_symlink: false,
    extension,
    size: is_dir ? 0 : 2048,
    modified: 1742515200, // 2026-03-21
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// t() — translation helper (verbatim copy from main.js)
// ─────────────────────────────────────────────────────────────────────────────

// Inline the function so we can test it without importing main.js's side-effects.
function makeT(locale) {
  return function t(key, vars = {}) {
    let k = key;
    if (('count' in vars || 'n' in vars) && locale[key + '_plural']) {
      const n = vars.count ?? vars.n;
      if (n !== 1) k = key + '_plural';
    }
    let s = locale[k] ?? locale[key] ?? key;
    return s.replace(/\{(\w+)\}/g, (_, v) => (v in vars ? String(vars[v]) : `{${v}}`));
  };
}

describe('t() — translation helper', () => {
  const locale = {
    'toast.bookmark_added':   'Bookmark added',
    'toast.copied':           'Copied {n} item',
    'toast.copied_plural':    'Copied {n} items',
    'toast.mounted_at':       'Mounted at {path}',
    'error.unknown':          'An error occurred: {err}',
    'toast.settings_reset':   'Settings file was corrupted and reset to defaults.',
  };
  const t = makeT(locale);

  it('returns the string for an exact key', () => {
    expect(t('toast.bookmark_added')).toBe('Bookmark added');
  });

  it('falls back to the raw key when the key is missing', () => {
    expect(t('nonexistent.key')).toBe('nonexistent.key');
  });

  it('interpolates {var} placeholders', () => {
    expect(t('toast.mounted_at', { path: '/mnt/usb' })).toBe('Mounted at /mnt/usb');
  });

  it('leaves {var} intact when the variable is not supplied', () => {
    expect(t('toast.mounted_at', {})).toBe('Mounted at {path}');
  });

  it('interpolates {err} for error messages', () => {
    expect(t('error.unknown', { err: 'ENOENT' })).toBe('An error occurred: ENOENT');
  });

  it('uses singular form when n === 1', () => {
    expect(t('toast.copied', { n: 1 })).toBe('Copied 1 item');
  });

  it('uses plural form when n !== 1', () => {
    expect(t('toast.copied', { n: 0 })).toBe('Copied 0 items');
    expect(t('toast.copied', { n: 2 })).toBe('Copied 2 items');
    expect(t('toast.copied', { n: 100 })).toBe('Copied 100 items');
  });

  it('uses singular when count === 1 (count alias)', () => {
    expect(t('toast.copied', { count: 1 })).toBe('Copied 1 item');
  });

  it('uses plural when count !== 1 (count alias)', () => {
    expect(t('toast.copied', { count: 5 })).toBe('Copied 5 items');
  });

  it('returns a key that has no plural unchanged when n > 1', () => {
    // settings_reset has no _plural variant — must return as-is
    expect(t('toast.settings_reset', { n: 5 })).toBe(
      'Settings file was corrupted and reset to defaults.'
    );
  });

  it('coerces numeric vars to strings', () => {
    expect(t('toast.copied', { n: 3 })).toBe('Copied 3 items');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// pushUndo / undoLastOp / redoLastOp — stack mechanics
// ─────────────────────────────────────────────────────────────────────────────
//
// We replicate the minimal state + function logic rather than importing main.js,
// then verify that the correct IPC commands are called with the right arguments.

function makeUndoState() {
  return {
    _undoStack: [],
    _redoStack: [],
  };
}

function makePushUndo(state) {
  return function pushUndo(op) {
    state._undoStack.push(op);
    if (state._undoStack.length > 50) state._undoStack.shift();
    state._redoStack = [];
  };
}

function makeUndoLastOp(state, showToastMock, refreshMock) {
  return async function undoLastOp() {
    const op = state._undoStack.pop();
    if (!op) { showToastMock('nothing_to_undo'); return; }
    state._redoStack.push(op);
    for (const item of [...op.items].reverse()) {
      if (op.op === 'move')        await invoke('move_file',   { src: item.dst, destDir: item.srcDir });
      else if (op.op === 'copy')   await invoke('delete_items', { paths: [item.dst] });
      else if (op.op === 'rename') await invoke('rename_file',  { oldPath: item.dst, newName: item.oldName });
      else if (op.op === 'tags')   await invoke('set_file_tags_v2', { path: item.path, tags: item.before });
      else if (op.op === 'batchRename') await invoke('rename_file', { oldPath: item.newPath, newName: item.oldName });
      else if (op.op === 'create') await invoke('delete_items', { paths: [item.dst] });
    }
    showToastMock('undone');
    await refreshMock();
  };
}

function makeRedoLastOp(state, showToastMock, refreshMock) {
  return async function redoLastOp() {
    const op = state._redoStack.pop();
    if (!op) { showToastMock('nothing_to_redo'); return; }
    state._undoStack.push(op);
    for (const item of op.items) {
      if (op.op === 'move')        await invoke('move_file',   { src: item.src, destDir: item.dstDir });
      else if (op.op === 'copy')   await invoke('copy_file',   { src: item.src, destDir: item.dstDir });
      else if (op.op === 'rename') await invoke('rename_file', { oldPath: item.src, newName: item.newName });
      else if (op.op === 'tags')   await invoke('set_file_tags_v2', { path: item.path, tags: item.after });
      else if (op.op === 'batchRename') await invoke('rename_file', { oldPath: item.oldPath, newName: item.newName });
      else if (op.op === 'create') { showToastMock('cannot_redo_create'); return; }
    }
    showToastMock('redone');
    await refreshMock();
  };
}

describe('pushUndo — stack management', () => {
  let state, pushUndo;

  beforeEach(() => {
    state    = makeUndoState();
    pushUndo = makePushUndo(state);
  });

  it('adds an op to the undo stack', () => {
    pushUndo({ op: 'move', items: [{ src: '/a', dst: '/b', srcDir: '/', dstDir: '/' }] });
    expect(state._undoStack).toHaveLength(1);
    expect(state._undoStack[0].op).toBe('move');
  });

  it('clears the redo stack on every new push', () => {
    state._redoStack = [{ op: 'copy', items: [] }];
    pushUndo({ op: 'rename', items: [] });
    expect(state._redoStack).toHaveLength(0);
  });

  it('enforces a 50-entry limit by dropping the oldest entry', () => {
    for (let i = 0; i < 52; i++) {
      pushUndo({ op: 'move', items: [{ src: `/file${i}` }] });
    }
    expect(state._undoStack).toHaveLength(50);
    // Oldest two dropped; newest is file51
    expect(state._undoStack[49].items[0].src).toBe('/file51');
  });

  it('stores different op types without error', () => {
    ['move', 'copy', 'rename', 'delete', 'create', 'batchRename', 'tags', 'chmod'].forEach(op => {
      pushUndo({ op, items: [] });
    });
    expect(state._undoStack).toHaveLength(8);
  });
});

describe('undoLastOp — IPC calls', () => {
  let state, pushUndo, undoLastOp, toastCalls, refreshMock;

  beforeEach(() => {
    state       = makeUndoState();
    pushUndo    = makePushUndo(state);
    toastCalls  = [];
    refreshMock = vi.fn().mockResolvedValue(undefined);
    undoLastOp  = makeUndoLastOp(state, (msg) => toastCalls.push(msg), refreshMock);
    vi.mocked(invoke).mockResolvedValue(null);
  });

  it('shows nothing_to_undo when stack is empty', async () => {
    await undoLastOp();
    expect(toastCalls).toContain('nothing_to_undo');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('calls move_file with reversed src/dst for a move op', async () => {
    pushUndo({ op: 'move', items: [{ src: '/home/a.txt', dst: '/tmp/a.txt', srcDir: '/home', dstDir: '/tmp' }] });
    await undoLastOp();
    expect(invoke).toHaveBeenCalledWith('move_file', { src: '/tmp/a.txt', destDir: '/home' });
  });

  it('calls delete_items on the destination for a copy op', async () => {
    pushUndo({ op: 'copy', items: [{ src: '/home/a.txt', dst: '/tmp/a.txt' }] });
    await undoLastOp();
    expect(invoke).toHaveBeenCalledWith('delete_items', { paths: ['/tmp/a.txt'] });
  });

  it('calls rename_file with the old name for a rename op', async () => {
    pushUndo({ op: 'rename', items: [{ src: '/home/old.txt', dst: '/home/new.txt', oldName: 'old.txt', newName: 'new.txt' }] });
    await undoLastOp();
    expect(invoke).toHaveBeenCalledWith('rename_file', { oldPath: '/home/new.txt', newName: 'old.txt' });
  });

  it('calls set_file_tags_v2 with before[] for a tags op', async () => {
    pushUndo({ op: 'tags', items: [{ path: '/home/file.txt', before: ['red'], after: ['blue'] }] });
    await undoLastOp();
    expect(invoke).toHaveBeenCalledWith('set_file_tags_v2', { path: '/home/file.txt', tags: ['red'] });
  });

  it('reverses item order for multi-item ops', async () => {
    const calls = [];
    vi.mocked(invoke).mockImplementation(async (cmd, args) => { calls.push(args.src ?? args.paths?.[0]); });
    pushUndo({ op: 'move', items: [
      { src: '/a', dst: '/x', srcDir: '/', dstDir: '/t' },
      { src: '/b', dst: '/y', srcDir: '/', dstDir: '/t' },
    ]});
    await undoLastOp();
    // Reversed: /y first, /x second
    expect(calls).toEqual(['/y', '/x']);
  });

  it('moves op to redo stack after successful undo', async () => {
    pushUndo({ op: 'move', items: [{ src: '/a', dst: '/b', srcDir: '/', dstDir: '/' }] });
    await undoLastOp();
    expect(state._undoStack).toHaveLength(0);
    expect(state._redoStack).toHaveLength(1);
  });

  it('calls refresh after successful undo', async () => {
    pushUndo({ op: 'rename', items: [{ src: '/f', dst: '/g', oldName: 'f', newName: 'g' }] });
    await undoLastOp();
    expect(refreshMock).toHaveBeenCalledOnce();
    expect(toastCalls).toContain('undone');
  });

  it('processes all items in a batchRename op individually', async () => {
    pushUndo({ op: 'batchRename', items: [
      { oldPath: '/dir/file1_new.txt', newPath: '/dir/file1_new.txt', oldName: 'file1.txt' },
      { oldPath: '/dir/file2_new.txt', newPath: '/dir/file2_new.txt', oldName: 'file2.txt' },
    ]});
    await undoLastOp();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(invoke).toHaveBeenCalledWith('rename_file', { oldPath: '/dir/file2_new.txt', newName: 'file2.txt' });
    expect(invoke).toHaveBeenCalledWith('rename_file', { oldPath: '/dir/file1_new.txt', newName: 'file1.txt' });
  });
});

describe('redoLastOp — IPC calls', () => {
  let state, pushUndo, undoLastOp, redoLastOp, toastCalls, refreshMock;

  beforeEach(() => {
    state       = makeUndoState();
    pushUndo    = makePushUndo(state);
    toastCalls  = [];
    refreshMock = vi.fn().mockResolvedValue(undefined);
    undoLastOp  = makeUndoLastOp(state, (msg) => toastCalls.push(msg), refreshMock);
    redoLastOp  = makeRedoLastOp(state, (msg) => toastCalls.push(msg), refreshMock);
    vi.mocked(invoke).mockResolvedValue(null);
  });

  it('shows nothing_to_redo when redo stack is empty', async () => {
    await redoLastOp();
    expect(toastCalls).toContain('nothing_to_redo');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('can undo then redo a move op', async () => {
    pushUndo({ op: 'move', items: [{ src: '/home/a.txt', dst: '/tmp/a.txt', srcDir: '/home', dstDir: '/tmp' }] });
    await undoLastOp();
    vi.mocked(invoke).mockClear();
    await redoLastOp();
    expect(invoke).toHaveBeenCalledWith('move_file', { src: '/home/a.txt', destDir: '/tmp' });
    expect(toastCalls).toContain('redone');
  });

  it('can undo then redo a copy op', async () => {
    pushUndo({ op: 'copy', items: [{ src: '/home/a.txt', dst: '/tmp/a.txt', srcDir: '/home', dstDir: '/tmp' }] });
    await undoLastOp();
    vi.mocked(invoke).mockClear();
    await redoLastOp();
    expect(invoke).toHaveBeenCalledWith('copy_file', { src: '/home/a.txt', destDir: '/tmp' });
  });

  it('can undo then redo a rename op', async () => {
    pushUndo({ op: 'rename', items: [{ src: '/home/old.txt', dst: '/home/new.txt', oldName: 'old.txt', newName: 'new.txt' }] });
    await undoLastOp();
    vi.mocked(invoke).mockClear();
    await redoLastOp();
    expect(invoke).toHaveBeenCalledWith('rename_file', { oldPath: '/home/old.txt', newName: 'new.txt' });
  });

  it('can undo then redo a tags op', async () => {
    pushUndo({ op: 'tags', items: [{ path: '/f.txt', before: ['red'], after: ['blue'] }] });
    await undoLastOp();
    vi.mocked(invoke).mockClear();
    await redoLastOp();
    expect(invoke).toHaveBeenCalledWith('set_file_tags_v2', { path: '/f.txt', tags: ['blue'] });
  });

  it('redo of create shows cannot_redo_create and does not invoke', async () => {
    // Create redo directly (undo of delete not covered here — just the redo guard)
    state._redoStack.push({ op: 'create', items: [{ dst: '/home/newfile.txt' }] });
    await redoLastOp();
    expect(toastCalls).toContain('cannot_redo_create');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('moves op back to undo stack after redo', async () => {
    pushUndo({ op: 'rename', items: [{ src: '/f', dst: '/g', oldName: 'f', newName: 'g' }] });
    await undoLastOp();
    expect(state._redoStack).toHaveLength(1);
    await redoLastOp();
    expect(state._redoStack).toHaveLength(0);
    expect(state._undoStack).toHaveLength(1);
  });

  it('multiple sequential undo/redo roundtrips stay consistent', async () => {
    const ops = [
      { op: 'move',   items: [{ src: '/a', dst: '/b', srcDir: '/', dstDir: '/' }] },
      { op: 'rename', items: [{ src: '/c', dst: '/d', oldName: 'c', newName: 'd' }] },
    ];
    ops.forEach(o => pushUndo(o));
    await undoLastOp(); // undo rename
    await undoLastOp(); // undo move
    expect(state._undoStack).toHaveLength(0);
    expect(state._redoStack).toHaveLength(2);
    await redoLastOp(); // redo move
    await redoLastOp(); // redo rename
    expect(state._redoStack).toHaveLength(0);
    expect(state._undoStack).toHaveLength(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings persistence — loadPersistentSettings / persistSettings
// ─────────────────────────────────────────────────────────────────────────────

function makeSettingsFns() {
  let _settingsLoaded = false;
  const toastCalls = [];

  async function loadPersistentSettings() {
    try {
      const saved = await invoke('get_settings');
      if (saved && typeof saved === 'object') {
        if (saved._reset === true) {
          toastCalls.push('settings_reset');
        }
        for (const [k, v] of Object.entries(saved)) {
          if (k === '_reset') continue;
          if (localStorage.getItem(k) === null) {
            localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
          }
        }
      }
    } catch (e) {
      // non-fatal
    }
    _settingsLoaded = true;
  }

  async function persistSettings() {
    if (!_settingsLoaded) return;
    const obj = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('ff_')) obj[k] = localStorage.getItem(k);
    }
    await invoke('set_settings', { settings: obj });
  }

  return { loadPersistentSettings, persistSettings, toastCalls, getLoaded: () => _settingsLoaded };
}

describe('loadPersistentSettings', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(invoke).mockReset();
  });

  it('populates localStorage from the get_settings response', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ ff_viewMode: 'list', ff_iconSize: '96', _v: 1 });
    const { loadPersistentSettings } = makeSettingsFns();
    await loadPersistentSettings();
    expect(localStorage.getItem('ff_viewMode')).toBe('list');
    expect(localStorage.getItem('ff_iconSize')).toBe('96');
  });

  it('does not overwrite keys already present in localStorage', async () => {
    localStorage.setItem('ff_viewMode', 'column'); // in-session write
    vi.mocked(invoke).mockResolvedValueOnce({ ff_viewMode: 'list', _v: 1 });
    const { loadPersistentSettings } = makeSettingsFns();
    await loadPersistentSettings();
    expect(localStorage.getItem('ff_viewMode')).toBe('column'); // unchanged
  });

  it('does not store the _reset flag in localStorage', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ _reset: true, _v: 1 });
    const { loadPersistentSettings } = makeSettingsFns();
    await loadPersistentSettings();
    expect(localStorage.getItem('_reset')).toBeNull();
  });

  it('queues a toast when _reset is true', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ _reset: true, _v: 1 });
    const { loadPersistentSettings, toastCalls } = makeSettingsFns();
    await loadPersistentSettings();
    expect(toastCalls).toContain('settings_reset');
  });

  it('does not queue a toast when _reset is absent', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ ff_theme: 'dark', _v: 1 });
    const { loadPersistentSettings, toastCalls } = makeSettingsFns();
    await loadPersistentSettings();
    expect(toastCalls).toHaveLength(0);
  });

  it('marks settings as loaded even when get_settings throws', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('IPC error'));
    const { loadPersistentSettings, getLoaded } = makeSettingsFns();
    await loadPersistentSettings();
    expect(getLoaded()).toBe(true);
  });

  it('serialises non-string values as JSON', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ ff_colWidths: { name: 200 }, _v: 1 });
    const { loadPersistentSettings } = makeSettingsFns();
    await loadPersistentSettings();
    expect(localStorage.getItem('ff_colWidths')).toBe('{"name":200}');
  });
});

describe('persistSettings', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(invoke).mockReset().mockResolvedValue(null);
  });

  it('collects all ff_* keys and calls set_settings', async () => {
    localStorage.setItem('ff_viewMode', 'gallery');
    localStorage.setItem('ff_iconSize', '128');
    localStorage.setItem('other_key',   'ignored'); // non-ff_ key
    const { loadPersistentSettings, persistSettings } = makeSettingsFns();
    vi.mocked(invoke).mockResolvedValueOnce({ _v: 1 }); // for get_settings
    await loadPersistentSettings();
    vi.mocked(invoke).mockClear();
    await persistSettings();
    expect(invoke).toHaveBeenCalledWith('set_settings', {
      settings: { ff_viewMode: 'gallery', ff_iconSize: '128' },
    });
  });

  it('does not call set_settings before loadPersistentSettings has run', async () => {
    const { persistSettings } = makeSettingsFns();
    await persistSettings();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('excludes non-ff_ keys from the payload', async () => {
    localStorage.setItem('ff_locale', 'fr');
    localStorage.setItem('unrelated', 'value');
    const { loadPersistentSettings, persistSettings } = makeSettingsFns();
    vi.mocked(invoke).mockResolvedValueOnce({ _v: 1 });
    await loadPersistentSettings();
    vi.mocked(invoke).mockClear();
    await persistSettings();
    const [, args] = vi.mocked(invoke).mock.calls[0];
    expect(Object.keys(args.settings)).toEqual(['ff_locale']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Search result filtering — type / size / date filter helpers
// ─────────────────────────────────────────────────────────────────────────────
//
// The filter logic lives inline in the search UI handler. We extract and test
// the predicate logic independently.

function makeFilterEntry(overrides = {}) {
  return {
    name: 'report.pdf',
    path: '/home/user/report.pdf',
    is_dir: false,
    extension: 'pdf',
    size: 512 * 1024, // 512 KB
    modified: 1742515200, // 2026-03-21 UTC
    ...overrides,
  };
}

// Replicate the filter predicates from main.js search UI
function applyFilters(entries, { typeFilter, minSize, maxSize, after, before }) {
  return entries.filter(e => {
    if (typeFilter && typeFilter !== 'all') {
      const imageExts  = ['png','jpg','jpeg','gif','webp','bmp','svg','ico','tiff','heic'];
      const videoExts  = ['mp4','mkv','webm','avi','mov','ogv','m4v'];
      const audioExts  = ['mp3','flac','ogg','wav','aac','m4a','opus'];
      const docExts    = ['txt','md','pdf','doc','docx','xls','xlsx','rtf','epub'];
      const archiveExts= ['zip','tar','gz','7z','rar','bz2','xz'];
      const ext = (e.extension || '').toLowerCase();
      if (typeFilter === 'folder'  && !e.is_dir)             return false;
      if (typeFilter === 'image'   && !imageExts.includes(ext))  return false;
      if (typeFilter === 'video'   && !videoExts.includes(ext))  return false;
      if (typeFilter === 'audio'   && !audioExts.includes(ext))  return false;
      if (typeFilter === 'doc'     && !docExts.includes(ext))    return false;
      if (typeFilter === 'archive' && !archiveExts.includes(ext)) return false;
    }
    if (minSize !== null && minSize !== undefined && e.size < minSize) return false;
    if (maxSize !== null && maxSize !== undefined && e.size > maxSize) return false;
    if (after  && e.modified < after)  return false;
    if (before && e.modified > before) return false;
    return true;
  });
}

describe('search filters — type', () => {
  const entries = [
    makeFilterEntry({ name: 'photo.jpg',   extension: 'jpg',  is_dir: false }),
    makeFilterEntry({ name: 'clip.mp4',    extension: 'mp4',  is_dir: false }),
    makeFilterEntry({ name: 'song.mp3',    extension: 'mp3',  is_dir: false }),
    makeFilterEntry({ name: 'report.pdf',  extension: 'pdf',  is_dir: false }),
    makeFilterEntry({ name: 'archive.zip', extension: 'zip',  is_dir: false }),
    makeFilterEntry({ name: 'Documents',   extension: null,   is_dir: true  }),
  ];

  it('type=all returns every entry', () => {
    expect(applyFilters(entries, { typeFilter: 'all' })).toHaveLength(6);
  });

  it('type=folder returns only directories', () => {
    const res = applyFilters(entries, { typeFilter: 'folder' });
    expect(res.every(e => e.is_dir)).toBe(true);
    expect(res).toHaveLength(1);
  });

  it('type=image returns only image extensions', () => {
    const res = applyFilters(entries, { typeFilter: 'image' });
    expect(res.map(e => e.extension)).toEqual(['jpg']);
  });

  it('type=video returns only video extensions', () => {
    const res = applyFilters(entries, { typeFilter: 'video' });
    expect(res.map(e => e.extension)).toEqual(['mp4']);
  });

  it('type=audio returns only audio extensions', () => {
    const res = applyFilters(entries, { typeFilter: 'audio' });
    expect(res.map(e => e.extension)).toEqual(['mp3']);
  });

  it('type=doc returns only document extensions', () => {
    const res = applyFilters(entries, { typeFilter: 'doc' });
    expect(res.map(e => e.extension)).toEqual(['pdf']);
  });

  it('type=archive returns only archive extensions', () => {
    const res = applyFilters(entries, { typeFilter: 'archive' });
    expect(res.map(e => e.extension)).toEqual(['zip']);
  });

  it('no typeFilter (undefined) returns all entries', () => {
    expect(applyFilters(entries, {})).toHaveLength(6);
  });
});

describe('search filters — size', () => {
  const entries = [
    makeFilterEntry({ name: 'tiny.txt',   size: 100 }),
    makeFilterEntry({ name: 'small.txt',  size: 50 * 1024 }),
    makeFilterEntry({ name: 'medium.pdf', size: 5  * 1024 * 1024 }),
    makeFilterEntry({ name: 'large.mkv',  size: 500 * 1024 * 1024 }),
  ];

  it('minSize filters out entries below threshold', () => {
    const res = applyFilters(entries, { minSize: 1024 * 1024 });
    expect(res.map(e => e.name)).toEqual(['medium.pdf', 'large.mkv']);
  });

  it('maxSize filters out entries above threshold', () => {
    const res = applyFilters(entries, { maxSize: 1024 * 1024 });
    expect(res.map(e => e.name)).toEqual(['tiny.txt', 'small.txt']);
  });

  it('minSize + maxSize gives a range', () => {
    const res = applyFilters(entries, { minSize: 1024, maxSize: 10 * 1024 * 1024 });
    expect(res.map(e => e.name)).toEqual(['small.txt', 'medium.pdf']);
  });

  it('null size limits do not filter anything', () => {
    expect(applyFilters(entries, { minSize: null, maxSize: null })).toHaveLength(4);
  });
});

describe('search filters — date', () => {
  const base = 1742515200; // 2026-03-21
  const entries = [
    makeFilterEntry({ name: 'old.txt',   modified: base - 86400 * 30 }),  // 30 days ago
    makeFilterEntry({ name: 'week.txt',  modified: base - 86400 * 7 }),   // 7 days ago
    makeFilterEntry({ name: 'today.txt', modified: base }),
  ];

  it('after filter excludes entries older than the threshold', () => {
    const res = applyFilters(entries, { after: base - 86400 * 10 });
    expect(res.map(e => e.name)).toEqual(['week.txt', 'today.txt']);
  });

  it('before filter excludes entries newer than the threshold', () => {
    const res = applyFilters(entries, { before: base - 86400 * 10 });
    expect(res.map(e => e.name)).toEqual(['old.txt']);
  });

  it('after + before gives a date range', () => {
    const res = applyFilters(entries, { after: base - 86400 * 20, before: base - 86400 * 3 });
    expect(res.map(e => e.name)).toEqual(['week.txt']);
  });

  it('undefined date limits do not filter anything', () => {
    expect(applyFilters(entries, {})).toHaveLength(3);
  });
});

describe('search filters — combined', () => {
  const entries = [
    makeFilterEntry({ name: 'photo.jpg',   extension: 'jpg', size: 2 * 1024 * 1024, modified: 1742515200 }),
    makeFilterEntry({ name: 'old_photo.jpg', extension: 'jpg', size: 500 * 1024,    modified: 1742515200 - 86400 * 60 }),
    makeFilterEntry({ name: 'clip.mp4',    extension: 'mp4', size: 100 * 1024 * 1024, modified: 1742515200 }),
  ];

  it('type + minSize narrows to matching entries', () => {
    const res = applyFilters(entries, { typeFilter: 'image', minSize: 1024 * 1024 });
    expect(res.map(e => e.name)).toEqual(['photo.jpg']);
  });

  it('type + date range works together', () => {
    const base = 1742515200;
    const res = applyFilters(entries, { typeFilter: 'image', after: base - 86400 * 10 });
    expect(res.map(e => e.name)).toEqual(['photo.jpg']);
  });

  it('clearing all filters restores full result set', () => {
    // Apply narrow filter first
    let res = applyFilters(entries, { typeFilter: 'image', minSize: 5 * 1024 * 1024 });
    expect(res).toHaveLength(0);
    // Clear filters
    res = applyFilters(entries, {});
    expect(res).toHaveLength(3);
  });
});
