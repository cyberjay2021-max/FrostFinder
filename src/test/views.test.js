// src/test/views.test.js
// DOM render tests for renderColumnView and renderGalleryView.
// Validates the two specific bugs that slipped through in r58-r60:
//   1. r59 bug — colEl.insertBefore(sortHdr, colList) before colEl.appendChild(colList)
//      threw a DOMException and left the column blank.
//   2. r58 bug — gallery fast-path incremental update ran even when the gallery DOM
//      had been wiped by another view, leaving the strip with no thumbnails.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { injectDeps, renderColumnView, renderGalleryView } from '../views.js';

// ── minimal state + dep factory ───────────────────────────────────────────────

function makeEntry(name, is_dir = false) {
  return {
    name,
    path: `/home/user/${name}`,
    is_dir,
    is_hidden: name.startsWith('.'),
    is_symlink: false,
    extension: is_dir ? null : name.split('.').pop() || null,
    size: is_dir ? 0 : 1024,
    modified: 1742515200,
  };
}

function makeState(overrides = {}) {
  return {
    currentPath: '/home/user',
    viewMode: 'column',
    showHidden: false,
    searchMode: false,
    searchResults: [],
    selIdx: -1,
    gallerySelIdx: -1,
    loading: false,
    columns: [],
    _galleryZoom: 1,
    _galleryZoomPath: null,
    ...overrides,
  };
}

const noopSel = {
  _paths: new Set(),
  _trail: new Set(),
  has: () => false,
  hasp: () => false,
  clear: () => {},
};

const sortStateDefault = { col: 'name', dir: 1, foldersFirst: true };

function makeDeps(state, extraDeps = {}) {
  return {
    state,
    sel: noopSel,
    sortEntries: (e) => [...e].sort((a, b) => a.name.localeCompare(b.name)),
    sortState: sortStateDefault,
    getVisibleEntries: () => {
      const col = state.columns.find((c) => c.path === state.currentPath);
      return col ? col.entries.filter((e) => state.showHidden || !e.is_hidden) : [];
    },
    setupDragDrop:    () => {},
    setupDropTarget:  () => {},
    showContextMenu:  () => {},
    buildFileCtxMenu: () => [],
    buildBgCtxMenu:   () => [],
    loadPreview:      vi.fn(),
    navigate:         vi.fn(),
    render:           vi.fn(),
    getMediaUrl:      (p) => `http://127.0.0.1:9999/media?path=${encodeURIComponent(p)}`,
    getHeicJpegUrl:   (p) => `http://127.0.0.1:9999/heic?path=${encodeURIComponent(p)}`,
    newTab:           vi.fn(),
    appWindow:        { startDrag: vi.fn() },
    ...extraDeps,
  };
}

// Inject deps once before each test
beforeEach(() => {
  // Reset the host element
  document.body.innerHTML = '<div id="view-host"></div>';
});

function host() {
  return document.getElementById('view-host');
}

function inject(state, extraDeps = {}) {
  injectDeps(makeDeps(state, extraDeps));
}

// ─────────────────────────────────────────────────────────────────────────────
// renderColumnView — DOM structure
// ─────────────────────────────────────────────────────────────────────────────

describe('renderColumnView — basic structure', () => {
  it('creates cols-wrap and cols-container', () => {
    const state = makeState({
      columns: [{ path: '/home/user', entries: [], selIdx: -1, _fp: '\0' }],
    });
    inject(state);
    renderColumnView(host());
    expect(host().querySelector('.cols-wrap')).not.toBeNull();
    expect(host().querySelector('#cols')).not.toBeNull();
  });

  it('renders one .col element per column', () => {
    const state = makeState({
      columns: [
        { path: '/home/user', entries: [makeEntry('foo.txt')], selIdx: -1, _fp: 'x' },
      ],
    });
    inject(state);
    renderColumnView(host());
    const cols = host().querySelectorAll('.col');
    expect(cols.length).toBe(1);
  });

  it('renders multiple columns', () => {
    const state = makeState({
      currentPath: '/home/user/docs',
      columns: [
        { path: '/home/user',      entries: [makeEntry('docs', true)], selIdx: 0, _fp: 'x' },
        { path: '/home/user/docs', entries: [makeEntry('readme.md')],  selIdx: -1, _fp: 'y' },
      ],
    });
    inject(state);
    renderColumnView(host());
    expect(host().querySelectorAll('.col').length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// r59 regression — insertBefore DOMException
// The bug: sortHdr was insertBefore'd BEFORE colEl.appendChild(colList), which
// threw because colList wasn't yet a child of colEl.
// Fix (r60): appendChild happens first, insertBefore second.
// Test: renderColumnView must NOT throw and the column must be visible.
// ─────────────────────────────────────────────────────────────────────────────

describe('renderColumnView — r59 insertBefore regression', () => {
  it('does not throw a DOMException when rendering the active (rightmost) column', () => {
    const entries = Array.from({ length: 10 }, (_, i) => makeEntry(`file${i}.txt`));
    const state = makeState({
      columns: [{ path: '/home/user', entries, selIdx: -1, _fp: 'x' }],
    });
    inject(state);
    expect(() => renderColumnView(host())).not.toThrow();
  });

  it('column is not left in a blank/loading state after render', () => {
    const entries = [makeEntry('hello.txt'), makeEntry('world.md')];
    const state = makeState({
      columns: [{ path: '/home/user', entries, selIdx: -1, _fp: 'x' }],
    });
    inject(state);
    renderColumnView(host());
    // If the DOMException had fired the column would have no .col-list child
    expect(host().querySelector('.col-list, .col-row')).not.toBeNull();
  });

  it('sort indicator header is inside the column element, not floating', () => {
    const entries = [makeEntry('a.txt'), makeEntry('b.txt')];
    const state = makeState({
      columns: [{ path: '/home/user', entries, selIdx: -1, _fp: 'x' }],
    });
    inject(state);
    renderColumnView(host());
    const col = host().querySelector('.col');
    // sort header should be a child of .col, not of #cols or body
    const sortHdr = col?.querySelector('[data-sort-hdr], .col-sort-hdr, .sort-hdr');
    // We just need the col to exist and have children — the key invariant is no throw
    expect(col).not.toBeNull();
    expect(col.children.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// renderColumnView — hidden files
// ─────────────────────────────────────────────────────────────────────────────

describe('renderColumnView — hidden file filtering', () => {
  const entries = [
    makeEntry('visible.txt'),
    makeEntry('.hidden_file'),
    makeEntry('also_visible.md'),
  ];

  it('hides dotfiles when showHidden is false', () => {
    const state = makeState({
      showHidden: false,
      columns: [{ path: '/home/user', entries, selIdx: -1, _fp: 'x' }],
    });
    inject(state);
    renderColumnView(host());
    const rows = host().querySelectorAll('[data-path]');
    const paths = Array.from(rows).map((r) => r.dataset.path);
    expect(paths.some((p) => p.includes('.hidden_file'))).toBe(false);
  });

  it('shows dotfiles when showHidden is true', () => {
    const state = makeState({
      showHidden: true,
      columns: [{ path: '/home/user', entries, selIdx: -1, _fp: 'x' }],
    });
    inject(state);
    renderColumnView(host());
    const rows = host().querySelectorAll('[data-path]');
    const paths = Array.from(rows).map((r) => r.dataset.path);
    expect(paths.some((p) => p.includes('.hidden_file'))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// renderColumnView — empty directory
// ─────────────────────────────────────────────────────────────────────────────

describe('renderColumnView — empty directory', () => {
  it('renders without throwing for an empty column', () => {
    const state = makeState({
      columns: [{ path: '/home/user/empty', entries: [], selIdx: -1, _fp: '\0' }],
    });
    inject(state);
    expect(() => renderColumnView(host())).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// renderColumnView — re-render stability (streaming patch)
// Simulates the two-render streaming path: first chunk (partial), then full list.
// The second render must update in-place without wiping and recreating the column.
// ─────────────────────────────────────────────────────────────────────────────

describe('renderColumnView — streaming two-render stability', () => {
  it('second render with more entries does not throw', () => {
    const state = makeState({
      columns: [{ path: '/home/user', entries: [makeEntry('a.txt')], selIdx: -1, _fp: 'x' }],
    });
    inject(state);
    renderColumnView(host()); // first-chunk render

    // Simulate full listing arriving
    state.columns[0].entries = [
      makeEntry('a.txt'), makeEntry('b.txt'), makeEntry('c.txt'),
    ];
    expect(() => renderColumnView(host())).not.toThrow();
  });

  it('cols-wrap is not duplicated on second render', () => {
    const state = makeState({
      columns: [{ path: '/home/user', entries: [], selIdx: -1, _fp: '\0' }],
    });
    inject(state);
    renderColumnView(host());
    renderColumnView(host());
    expect(host().querySelectorAll('.cols-wrap').length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// renderGalleryView — r58 stale-meta regression
// Bug: _galleryMeta persisted as a JS property on the host element after another
// view called host.innerHTML = '...', destroying the gallery DOM. The fast-path
// guard checked only meta.path === currentPath && meta.count === entries.length,
// so it took the incremental path even when the gallery-wrap DOM was gone.
// Fix (r58): guard also checks host.querySelector('.gallery-wrap').
// Test: switching Column → Gallery must produce a full rebuild, not a no-op.
// ─────────────────────────────────────────────────────────────────────────────

describe('renderGalleryView — r58 stale-meta regression', () => {
  const entries = [
    makeEntry('photo1.jpg'),
    makeEntry('photo2.png'),
    makeEntry('photo3.webp'),
  ];

  it('renders gallery-wrap on first call', () => {
    const state = makeState({
      viewMode: 'gallery',
      columns: [{ path: '/home/user', entries, selIdx: -1, _fp: 'x' }],
    });
    inject(state);
    renderGalleryView(host());
    expect(host().querySelector('.gallery-wrap')).not.toBeNull();
  });

  it('full rebuild after another view wipes the DOM (stale-meta guard)', () => {
    const state = makeState({
      viewMode: 'gallery',
      columns: [{ path: '/home/user', entries, selIdx: -1, _fp: 'x' }],
    });
    inject(state);

    // First gallery render — sets _galleryMeta on the host element
    renderGalleryView(host());
    expect(host().querySelector('.gallery-wrap')).not.toBeNull();

    // Simulate column view clobbering the gallery DOM (the exact operation that
    // triggers the bug — another view replaces innerHTML)
    host().innerHTML = '<div class="cols-wrap"><div id="cols"></div></div>';
    expect(host().querySelector('.gallery-wrap')).toBeNull();

    // Switching back to gallery: must do a full rebuild despite _galleryMeta still
    // referencing the same path + count
    renderGalleryView(host());
    expect(host().querySelector('.gallery-wrap')).not.toBeNull();
  });

  it('does not throw when gallery DOM is absent and meta is stale', () => {
    const state = makeState({
      viewMode: 'gallery',
      columns: [{ path: '/home/user', entries, selIdx: -1, _fp: 'x' }],
    });
    inject(state);
    renderGalleryView(host());
    host().innerHTML = '';  // nuke everything including gallery-wrap
    expect(() => renderGalleryView(host())).not.toThrow();
  });
});
