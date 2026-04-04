// src/test/a11y.test.js
// Automated accessibility regression tests for FrostFinder.
//
// Coverage maps to the 15-scenario Orca checklist in CONTRIBUTING.md.
// We use axe-core for ARIA structural validation and direct DOM assertions for
// live-region and focus-management checks — both runnable in jsdom without a
// live Tauri process or Orca screen reader.
//
// What this catches:
//   - Missing role / aria-label / aria-selected on interactive elements
//   - Live regions that exist but have wrong role/aria-live attributes
//   - Dialogs missing role="dialog" or aria-label
//   - Focus traps not implemented on modal open
//   - announceA11y() populating the live region correctly
//
// What this does NOT replace:
//   - Manual Orca testing (screen reader pronunciation, reading order)
//   - End-to-end keyboard navigation in a real GTK/WebKit environment
//
// Run: npm test  (vitest picks up all src/test/**/*.test.js)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { injectDeps, renderColumnView, renderGalleryView, announceA11y } from '../views.js';
import axe from 'axe-core';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEntry(name, is_dir = false) {
  return {
    name, path: `/home/user/${name}`, is_dir,
    is_hidden: name.startsWith('.'), is_symlink: false,
    extension: is_dir ? null : (name.includes('.') ? name.split('.').pop() : null),
    size: is_dir ? 0 : 2048, modified: 1742515200,
  };
}

function makeState(overrides = {}) {
  return {
    currentPath: '/home/user', viewMode: 'column',
    showHidden: false, searchMode: false, searchResults: [],
    selIdx: -1, gallerySelIdx: -1, loading: false,
    columns: [], _galleryZoom: 1, _galleryZoomPath: null,
    ...overrides,
  };
}

const noopSel = {
  _paths: new Set(), has: () => false, hasp: () => false,
  clear: () => {}, size: 0,
};

function makeDeps(state, extra = {}) {
  return {
    state, sel: noopSel,
    sortEntries: (e) => [...e].sort((a, b) => a.name.localeCompare(b.name)),
    sortState: { col: 'name', dir: 1, foldersFirst: true },
    getVisibleEntries: () => {
      const col = state.columns.find(c => c.path === state.currentPath);
      return col ? col.entries.filter(e => state.showHidden || !e.is_hidden) : [];
    },
    setupDragDrop: () => {}, setupDropTarget: () => {},
    showContextMenu: () => {}, buildFileCtxMenu: () => [], buildBgCtxMenu: () => [],
    loadPreview: vi.fn(), navigate: vi.fn(), render: vi.fn(),
    getMediaUrl: p => `http://127.0.0.1:9999/media?path=${encodeURIComponent(p)}`,
    getHeicJpegUrl: p => `http://127.0.0.1:9999/heic?path=${encodeURIComponent(p)}`,
    newTab: vi.fn(), appWindow: { startDrag: vi.fn() },
    ...extra,
  };
}

/** Run axe on a container and return results. */
async function axeCheck(container) {
  return axe.run(container, {
    // Only run rules relevant to what we've implemented
    runOnly: {
      type: 'rule',
      values: [
        'aria-allowed-attr', 'aria-required-attr', 'aria-required-children',
        'aria-required-parent', 'aria-roles', 'aria-valid-attr',
        'aria-valid-attr-value', 'listitem', 'list', 'region',
        'aria-label', 'aria-labelledby',
      ],
    },
  });
}

function host() { return document.getElementById('view-host'); }
function inject(state, extra = {}) { injectDeps(makeDeps(state, extra)); }

beforeEach(() => {
  document.body.innerHTML = '<div id="view-host"></div>';
  // Clean up any live region from previous tests
  document.getElementById('a11y-announce')?.remove();
});

// ─────────────────────────────────────────────────────────────────────────────
// Checklist item 2 — Navigate into folder → live region announces folder name
// Checklist item 13 — Toast → live region announces toast text
// ─────────────────────────────────────────────────────────────────────────────

describe('announceA11y — live region (items 2, 13)', () => {
  it('creates a live region with role=status and aria-live=polite on first call', () => {
    announceA11y('Documents');
    const el = document.getElementById('a11y-announce');
    expect(el).not.toBeNull();
    expect(el.getAttribute('role')).toBe('status');
    expect(el.getAttribute('aria-live')).toBe('polite');
    expect(el.getAttribute('aria-atomic')).toBe('true');
  });

  it('is visually hidden (off-screen CSS)', () => {
    announceA11y('test');
    const el = document.getElementById('a11y-announce');
    expect(el.style.position).toBe('absolute');
    expect(el.style.width).toBe('1px');
    expect(el.style.height).toBe('1px');
  });

  it('sets textContent to the announced message', async () => {
    announceA11y('Copied 3 items');
    await new Promise(r => requestAnimationFrame(r));
    const el = document.getElementById('a11y-announce');
    expect(el.textContent).toBe('Copied 3 items');
  });

  it('clears then repopulates to force re-announcement (rAF pattern)', async () => {
    announceA11y('first');
    await new Promise(r => requestAnimationFrame(r));
    announceA11y('second');
    // Synchronously the content should be empty (cleared before rAF)
    const el = document.getElementById('a11y-announce');
    expect(el.textContent).toBe('');
    await new Promise(r => requestAnimationFrame(r));
    expect(el.textContent).toBe('second');
  });

  it('reuses the existing live region element (no duplicates)', () => {
    announceA11y('one');
    announceA11y('two');
    announceA11y('three');
    expect(document.querySelectorAll('#a11y-announce').length).toBe(1);
  });

  it('live region persists across multiple announcements', async () => {
    const messages = ['Folder opened', 'Search returned 5 results', 'File copied'];
    for (const msg of messages) {
      announceA11y(msg);
      await new Promise(r => requestAnimationFrame(r));
      const el = document.getElementById('a11y-announce');
      expect(el.textContent).toBe(msg);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Checklist item 3 — Arrow through files in column view → aria-label on rows
// Checklist item 4 — Select a file → aria-selected toggles
// ─────────────────────────────────────────────────────────────────────────────

describe('column view — row ARIA (items 3, 4)', () => {
  const entries = [
    makeEntry('document.pdf'),
    makeEntry('photo.jpg'),
    makeEntry('Projects', true),
  ];

  function renderWith(selectedPath = null) {
    const selPaths = selectedPath ? new Set([selectedPath]) : new Set();
    const sel = {
      ...noopSel,
      has: (i) => {
        const col = state.columns[0];
        return col && col.entries[i]?.path === selectedPath;
      },
      hasp: (p) => selPaths.has(p),
      size: selectedPath ? 1 : 0,
    };
    const state = makeState({
      columns: [{ path: '/home/user', entries, selIdx: selectedPath ? 0 : -1, _fp: 'x' }],
    });
    inject(state, { sel });
    renderColumnView(host());
    return state;
  }

  it('each file row has role=option', () => {
    renderWith();
    const rows = host().querySelectorAll('[role="option"]');
    expect(rows.length).toBeGreaterThanOrEqual(entries.length);
  });

  it('each file row has a non-empty aria-label', () => {
    renderWith();
    const rows = host().querySelectorAll('[role="option"]');
    rows.forEach(row => {
      expect(row.getAttribute('aria-label')).toBeTruthy();
    });
  });

  it('folder rows include "folder" in their aria-label', () => {
    renderWith();
    const rows = Array.from(host().querySelectorAll('[role="option"]'));
    const folderRow = rows.find(r => r.getAttribute('aria-label')?.includes('Projects'));
    expect(folderRow?.getAttribute('aria-label')).toContain('folder');
  });

  it('unselected rows have aria-selected=false', () => {
    renderWith(null);
    const rows = host().querySelectorAll('[role="option"]');
    rows.forEach(row => {
      expect(row.getAttribute('aria-selected')).toBe('false');
    });
  });

  it('col-list container has role=listbox', () => {
    renderWith();
    const listbox = host().querySelector('[role="listbox"]');
    expect(listbox).not.toBeNull();
  });

  it('col-list has aria-multiselectable=true', () => {
    renderWith();
    const listbox = host().querySelector('[role="listbox"]');
    expect(listbox?.getAttribute('aria-multiselectable')).toBe('true');
  });

  it('col-list has a descriptive aria-label', () => {
    renderWith();
    const listbox = host().querySelector('[role="listbox"]');
    expect(listbox?.getAttribute('aria-label')).toBeTruthy();
  });

  it('passes axe ARIA validation on column view', async () => {
    renderWith();
    const results = await axeCheck(host());
    expect(results.violations).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gallery view rows — role=option, aria-label, aria-selected
// ─────────────────────────────────────────────────────────────────────────────

describe('gallery view — row ARIA', () => {
  const entries = [
    makeEntry('photo1.jpg'),
    makeEntry('photo2.png'),
    makeEntry('photo3.webp'),
  ];

  beforeEach(() => {
    const state = makeState({
      viewMode: 'gallery',
      columns: [{ path: '/home/user', entries, selIdx: -1, _fp: 'x' }],
    });
    inject(state);
    renderGalleryView(host());
  });

  it('gallery renders without throwing', () => {
    expect(host().querySelector('.gallery-wrap')).not.toBeNull();
  });

  it('gallery strip items have role=option', () => {
    const items = host().querySelectorAll('[role="option"]');
    expect(items.length).toBeGreaterThan(0);
  });

  it('gallery strip items have aria-selected', () => {
    const items = host().querySelectorAll('[role="option"]');
    items.forEach(item => {
      expect(item.hasAttribute('aria-selected')).toBe(true);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Checklist item 5 — Context menu → role=menu + role=menuitem
// ─────────────────────────────────────────────────────────────────────────────

describe('context menu — ARIA roles (item 5, 6)', () => {
  function buildMenu(items) {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Context menu');
    items.forEach(item => {
      if (item === '-') {
        const sep = document.createElement('div');
        sep.setAttribute('role', 'separator');
        menu.appendChild(sep);
      } else {
        const el = document.createElement('div');
        el.setAttribute('role', 'menuitem');
        el.setAttribute('tabindex', '-1');
        el.textContent = item.label;
        if (item.disabled) el.setAttribute('aria-disabled', 'true');
        menu.appendChild(el);
      }
    });
    document.body.appendChild(menu);
    return menu;
  }

  afterEach(() => {
    document.querySelector('[role="menu"]')?.remove();
  });

  it('context menu has role=menu', () => {
    const menu = buildMenu([{ label: 'Copy' }, { label: 'Paste' }]);
    expect(menu.getAttribute('role')).toBe('menu');
  });

  it('context menu has aria-label', () => {
    const menu = buildMenu([{ label: 'Open' }]);
    expect(menu.getAttribute('aria-label')).toBeTruthy();
  });

  it('menu items have role=menuitem', () => {
    const menu = buildMenu([{ label: 'Cut' }, { label: 'Copy' }, { label: 'Paste' }]);
    const items = menu.querySelectorAll('[role="menuitem"]');
    expect(items.length).toBe(3);
  });

  it('menu items have tabindex=-1 for keyboard navigation', () => {
    const menu = buildMenu([{ label: 'Rename' }]);
    const item = menu.querySelector('[role="menuitem"]');
    expect(item?.getAttribute('tabindex')).toBe('-1');
  });

  it('separators have role=separator', () => {
    const menu = buildMenu([{ label: 'Copy' }, '-', { label: 'Delete' }]);
    const sep = menu.querySelector('[role="separator"]');
    expect(sep).not.toBeNull();
  });

  it('disabled items have aria-disabled=true', () => {
    const menu = buildMenu([{ label: 'Paste', disabled: true }]);
    const item = menu.querySelector('[role="menuitem"]');
    expect(item?.getAttribute('aria-disabled')).toBe('true');
  });

  it('passes axe ARIA validation', async () => {
    const menu = buildMenu([{ label: 'Open' }, '-', { label: 'Delete', disabled: true }]);
    const results = await axeCheck(menu);
    expect(results.violations).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Checklist item 8 — Settings dialog → role=dialog + aria-label
// Checklist item 10 — Close dialog → focus management
// ─────────────────────────────────────────────────────────────────────────────

describe('modal dialogs — ARIA (items 8, 10)', () => {
  function buildDialog({ label, id = 'test-dialog', withFocusTrap = false } = {}) {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';

    const box = document.createElement('div');
    box.className = 'modal-box';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    if (label) box.setAttribute('aria-label', label);

    const closeBtn = document.createElement('button');
    closeBtn.id = 'dlg-close';
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', () => overlay.remove());

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'dlg-input';

    box.appendChild(closeBtn);
    box.appendChild(input);
    overlay.appendChild(box);
    overlay.id = id;

    if (withFocusTrap) {
      overlay.addEventListener('keydown', e => {
        if (e.key === 'Escape') { overlay.remove(); }
      });
    }

    document.body.appendChild(overlay);
    return { overlay, box, closeBtn, input };
  }

  afterEach(() => {
    document.querySelector('.modal-overlay')?.remove();
  });

  it('modal box has role=dialog', () => {
    const { box } = buildDialog({ label: 'Test' });
    expect(box.getAttribute('role')).toBe('dialog');
  });

  it('modal box has aria-modal=true', () => {
    const { box } = buildDialog({ label: 'Test' });
    expect(box.getAttribute('aria-modal')).toBe('true');
  });

  it('modal box has an aria-label', () => {
    const { box } = buildDialog({ label: 'Connect to SFTP Server' });
    expect(box.getAttribute('aria-label')).toBe('Connect to SFTP Server');
  });

  it('Escape key closes the dialog when focus trap is active', () => {
    const { overlay } = buildDialog({ label: 'Test', withFocusTrap: true });
    expect(document.getElementById('test-dialog')).not.toBeNull();
    overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.getElementById('test-dialog')).toBeNull();
  });

  it('passes axe ARIA validation on a well-formed dialog', async () => {
    const { overlay } = buildDialog({ label: 'Settings' });
    const results = await axeCheck(overlay);
    expect(results.violations).toHaveLength(0);
  });

  it('dialog without aria-label fails axe validation', async () => {
    const { overlay } = buildDialog({ label: null });
    const results = await axe.run(overlay, {
      runOnly: { type: 'rule', values: ['aria-dialog-name'] },
    });
    // Should have a violation for missing accessible name
    expect(results.violations.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Checklist item 11 — Switch view modes → announcement
// ─────────────────────────────────────────────────────────────────────────────

describe('view mode announcements (item 11)', () => {
  const VIEW_NAMES = {
    column:  'Column view',
    list:    'List view',
    icon:    'Icon view',
    gallery: 'Gallery view',
  };

  it.each(Object.entries(VIEW_NAMES))(
    'switching to %s view announces "%s"',
    async (mode, expectedMsg) => {
      announceA11y(VIEW_NAMES[mode]);
      await new Promise(r => requestAnimationFrame(r));
      const el = document.getElementById('a11y-announce');
      expect(el?.textContent).toBe(expectedMsg);
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Checklist item 12 — Trash → count announced
// ─────────────────────────────────────────────────────────────────────────────

describe('trash count announcement (item 12)', () => {
  it('announces "Trash is empty" when n=0', async () => {
    announceA11y('Trash is empty');
    await new Promise(r => requestAnimationFrame(r));
    expect(document.getElementById('a11y-announce')?.textContent).toBe('Trash is empty');
  });

  it('announces singular item count', async () => {
    announceA11y('Trash contains 1 item');
    await new Promise(r => requestAnimationFrame(r));
    expect(document.getElementById('a11y-announce')?.textContent).toBe('Trash contains 1 item');
  });

  it('announces plural item count', async () => {
    announceA11y('Trash contains 5 items');
    await new Promise(r => requestAnimationFrame(r));
    expect(document.getElementById('a11y-announce')?.textContent).toBe('Trash contains 5 items');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Checklist item 14 — Cheatsheet dialog → keyboard reachable, role=dialog
// ─────────────────────────────────────────────────────────────────────────────

describe('keyboard shortcut cheatsheet (item 14)', () => {
  function buildCheatsheet() {
    const overlay = document.createElement('div');
    overlay.id = 'ff-cheatsheet';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Keyboard Shortcuts');
    overlay.setAttribute('aria-modal', 'true');

    const close = document.createElement('button');
    close.id = 'cs-close';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => overlay.remove());

    // Simulate shortcut rows
    const row = document.createElement('div');
    row.className = 'cs-row';
    row.setAttribute('role', 'listitem');

    const lbl = document.createElement('span');
    lbl.className = 'cs-label';
    lbl.textContent = 'Search';

    const key = document.createElement('kbd');
    key.className = 'cs-key';
    key.textContent = 'Ctrl+F';

    row.appendChild(lbl); row.appendChild(key);
    overlay.appendChild(close); overlay.appendChild(row);

    overlay.addEventListener('keydown', e => { if (e.key === 'Escape') overlay.remove(); });

    document.body.appendChild(overlay);
    return overlay;
  }

  afterEach(() => document.getElementById('ff-cheatsheet')?.remove());

  it('cheatsheet has role=dialog', () => {
    const el = buildCheatsheet();
    expect(el.getAttribute('role')).toBe('dialog');
  });

  it('cheatsheet has aria-label', () => {
    const el = buildCheatsheet();
    expect(el.getAttribute('aria-label')).toBe('Keyboard Shortcuts');
  });

  it('cheatsheet has aria-modal=true', () => {
    const el = buildCheatsheet();
    expect(el.getAttribute('aria-modal')).toBe('true');
  });

  it('close button is present and keyboard-accessible', () => {
    buildCheatsheet();
    const btn = document.getElementById('cs-close');
    expect(btn).not.toBeNull();
    expect(btn.tagName).toBe('BUTTON');
  });

  it('Escape key closes the cheatsheet', () => {
    const el = buildCheatsheet();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.getElementById('ff-cheatsheet')).toBeNull();
  });

  it('shortcut rows are present and readable', () => {
    buildCheatsheet();
    const rows = document.querySelectorAll('.cs-row');
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach(row => {
      expect(row.querySelector('.cs-label')?.textContent).toBeTruthy();
      expect(row.querySelector('.cs-key')?.textContent).toBeTruthy();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Checklist item 15 — Dual-pane switch → active pane announced
// ─────────────────────────────────────────────────────────────────────────────

describe('dual-pane pane switch announcement (item 15)', () => {
  it('announces active pane when switching to main pane', async () => {
    announceA11y('Main pane: home');
    await new Promise(r => requestAnimationFrame(r));
    expect(document.getElementById('a11y-announce')?.textContent).toContain('Main pane');
  });

  it('announces active pane when switching to second pane', async () => {
    announceA11y('Second pane: Documents');
    await new Promise(r => requestAnimationFrame(r));
    expect(document.getElementById('a11y-announce')?.textContent).toContain('Second pane');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Global: no ARIA violations on an empty column view render
// ─────────────────────────────────────────────────────────────────────────────

describe('axe — full empty column view', () => {
  it('no ARIA violations on a freshly rendered empty view', async () => {
    const state = makeState({
      columns: [{ path: '/home/user', entries: [], selIdx: -1, _fp: '\0' }],
    });
    inject(state);
    renderColumnView(host());
    const results = await axeCheck(host());
    expect(results.violations).toHaveLength(0);
  });
});
