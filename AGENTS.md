# FrostFinder Development Guide

## Build Commands

### Frontend (JavaScript/Vite)
```bash
npm run dev        # development server
npm run build      # production build
npm run preview    # preview production build
```

### Backend (Rust/Tauri)
```bash
npm run tauri dev           # development (hot reload)
npm run tauri build         # production build
cd src-tauri && cargo check # fast compilation check
cd src-tauri && cargo clippy
cd src-tauri && cargo test
cd src-tauri && cargo test test_name_here
# Run a specific test group
cd src-tauri && cargo test search_          # all search tests
cd src-tauri && cargo test batch_rename_   # all batch rename tests
cd src-tauri && cargo fmt
```

## Project Structure

```
FrostFinder/
├── src/                        # Frontend JavaScript
│   ├── main.js                # Main entry point (~7150 lines)
│   ├── views.js               # View renderers (~4270 lines)
│   ├── utils.js               # Utilities, icons, constants
│   ├── ql-window.js           # Quick Look window
│   ├── search.worker.js       # Search web worker
│   ├── style.css              # All styles
│   └── locales/               # i18n string catalogues
│       └── en.json            # English (canonical)
├── src-tauri/                  # Rust backend
│   ├── src/main.rs            # All Rust code (~8210 lines)
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── capabilities/
│       └── main.json          # Tauri capability declarations
├── index.html
├── ql.html
├── package.json
├── RELEASE.md
├── README.md
├── AGENTS.md
└── BUILD.md
```

## Code Style Guidelines

### JavaScript (Vanilla — No Framework)

**Imports:**
```javascript
import { invoke }           from '@tauri-apps/api/core';
import { listen }           from '@tauri-apps/api/event';
import { I, fmtSize, escHtml } from './utils.js';
import { renderColumnView, renderPreview } from './views.js';
```

**Naming:**
- Variables/functions: camelCase `getVisibleEntries`
- Constants: UPPER_SNAKE `MAX_PREVIEW_SIZE`
- Private vars: underscore prefix `_preloadedPaths`
- DOM element refs: suffix `$` or descriptive noun `colList`

**Functions:** Arrow functions for callbacks; declarations for top-level. Keep under 50 lines; extract helpers.

**Error handling:**
```javascript
try {
  await invoke('some_command', { param });
} catch (err) {
  showToast(t('error.unknown', { err }), 'error');
}
```

**i18n:** Use `t('key', { vars })` for all user-visible strings. Never hardcode English in new UI code. The `t()` function falls back gracefully if a key is missing.

**Accessibility:** Every new interactive element needs:
- `role` if it's not a native semantic element
- `aria-label` or `aria-labelledby`
- `tabindex="0"` if it should be keyboard-reachable
- Call `announceA11y(message)` after significant state changes

### Rust

**Imports:**
```rust
use std::fs;
use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use tauri::{Window, Manager, Emitter};
```

**Naming:** snake_case functions, PascalCase structs/enums, UPPER_SNAKE constants.

**Error handling:** `Result<T, String>` for fallible commands. Return descriptive errors.

**Commands:** Mark with `#[tauri::command]`. Keep focused and under 100 lines. Emit progress events for long operations.

## Architecture Notes

### State model
Each browser tab owns a `TabState` object containing:
- `path` — current folder
- `selection` — selected entries
- `viewMode` — 'column' | 'list' | 'icon' | 'gallery'
- `sortKey`, `sortAsc`
- `history[]`, `historyIdx`
- `clipboard`
- `undoStack[]`
- `paneState[2]` — per-pane path/viewMode/scrollTop for dual-pane
- `paneSplit` — divider fraction (0.15–0.85)
- `dualPane` — whether dual-pane was active

### Tag storage
Tags are written to xattr (`user.frostfinder.tags`) first. If xattr fails (FAT32, exFAT, network mounts), they fall back to `~/.local/share/frostfinder/tags.db` (SQLite). Always use `get_file_tags_v2` / `set_file_tags_v2` — never the old v1 commands.

### i18n
All user-visible strings go through `t('key', { vars })`. String catalogue is in `src/locales/en.json`. To add a language, copy `en.json` to `src/locales/{lang}.json` and translate. Missing keys fall back to English, then to the raw key name.

### Date formatting
`fmtDate` in `utils.js` uses `_dateLocale` set by `setDateLocale(lang)`. This is wired into `initI18n()` — always call `setDateLocale()` when the locale changes.

### Icon themes
`getIcon(key)` checks `_diskIcons[key]` first, then falls back to the built-in SVG set `I[key]`. Disk themes are loaded via `loadDiskTheme(folderPath)` which calls the Rust `scan_icon_folder` command. The SVG map is cached in `localStorage` as `ff_diskThemeSvgs`.

### Plugin system
Custom actions live in `~/.local/share/frostfinder/plugins.json`. Each plugin has a glob pattern; `pluginsForEntry(entry)` returns applicable plugins for a given file. Commands run via `sh -c` with `{path}`, `{name}`, `{dir}`, `{ext}` substitution.

### Network mounts
All mount types (SMB, WebDAV, SFTP, FTP) follow the same pattern:
1. FUSE mount to `/tmp/frostfinder-{type}/{uuid}`
2. Registry JSON at `~/.local/share/frostfinder/{type}_mounts.json`
3. On startup: load registry, cross-check against `/proc/mounts`, discard stale

### Dual-pane
`panes[2]` holds independent state for each pane. `activePane` (0 or 1) tracks focus. `navigate(path, paneIndex)` routes to the right container. Tab switching restores full pane state from the outgoing tab object.

## Common Patterns

### Adding a new feature (frontend)
1. Add UI in `views.js` or a dialog function in `main.js`
2. Use `t('key')` for all labels; add keys to `src/locales/en.json`
3. Add ARIA attributes to new interactive elements
4. Add keyboard shortcut if applicable; document it in `README.md`
5. Call `invoke('command_name', { params })` for Rust backend

### Adding a new Rust command
1. Add function in `main.rs` with `#[tauri::command]`
2. Register in `invoke_handler!` macro
3. Return `Result<T, String>`
4. For long operations: emit progress events, unlisten in `finally`

### Adding a translation
1. Copy `src/locales/en.json` → `src/locales/{lang}.json`
2. Translate values (do not change keys)
3. Add the language option to the locale selector in the Settings dialog

## Dependencies

### Frontend
- `@tauri-apps/api` — Tauri v2 JS APIs
- Vite — bundler

### Backend (Rust)
- `tauri v2` — desktop framework
- `image` — image processing
- `zip` — archive handling
- `notify` — filesystem watching
- `sha2` / `rand` — security (secure delete, duplicates)
- `rusqlite` (bundled) — SQLite for tag fallback DB
- `xattr` — extended attribute read/write
- `lofty` — native audio tag read/write (MP3/ID3, FLAC, OGG, Opus, M4A, WAV)
- `regex` — advanced search
- `libc` — chmod/chown
- `once_cell` — lazy statics (mount registries)
- `serde_json` — JSON serialisation
- `dirs` — XDG directory resolution

## Version Updates
1. Update `VERSION` — `VERSION`, `REVISION`, `DATE`, `BUILD_NAME`
2. Update `package.json` — `version`
3. Update `Cargo.toml` — `version`
4. Update `src-tauri/tauri.conf.json` — `version`
5. Update `PKGBUILD` — `pkgver`
6. Update `packaging/homebrew/frostfinder.rb` — `version`
7. Update `packaging/winget/FrostFinder.FrostFinder.yaml` — `PackageVersion` + installer URLs
8. Prepend new `<release>` entry to `packaging/com.frostfinder.desktop.metainfo.xml`
9. Prepend new section to `RELEASE.md`
10. Update `MEMORY.md` — current version header + Last Audit entry
11. Update `AGENTS.md` — backup command example if major version changed
12. Update `README.md` roadmap checkboxes if needed
13. Run `node scripts/gen-shortcuts-readme.js` if any shortcuts changed

## Tauri Capabilities
Required entries in `src-tauri/capabilities/main.json`:
```json
"window:allow-create",
"window:allow-start-dragging",
"webviewWindow:allow-create"
```

## Backups
Create tar backup before major changes:
```bash
tar czf FrostFinder-beta-6-r21_2026-03-22.tar.gz \
  src/ src-tauri/src/ src-tauri/Cargo.toml src-tauri/tauri.conf.json \
  *.md *.html *.js package.json VERSION
```
