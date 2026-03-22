# FrostFinder Developer Memory

## ⚠️ Important: Update MD Files
After ANY code changes, always update relevant MD files:
- **RELEASE.md** - Add new features/changes to "What's in [version]" section at top
- **MEMORY.md** - Update current features, preferences, patterns
- **AGENTS.md** - Update build commands, dependencies if changed

## Build Commands
```bash
# Development
npm run tauri dev

# Production build
npm run tauri build

# Rust checks
cd src-tauri && cargo check
cd src-tauri && cargo clippy
cd src-tauri && cargo test
```

```bash
# JS tests
npm test
npm run test:watch
```

## Project Structure
- Frontend: Vanilla JS (src/main.js, src/views.js, src/utils.js)
- Backend: Rust (src-tauri/src/main.rs)
- Tauri v2, WebKit2GTK 4.1

## Code Style
- JavaScript: camelCase, ES6 imports, arrow functions for callbacks
- Rust: snake_case functions, PascalCase structs, Result<T, String> for errors
- Always use try/catch for Tauri invoke() calls

## Common Patterns
- Frontend state: `state` object, `sel` for selection
- Rendering: `render()` called after state changes
- IPC: `invoke('command_name')` for Rust calls, `listen()` for events
- Directory listing: `_streamDir()` for column view (`dir-chunk`), `listDirectoryFull()` for list/gallery/icon (`dir-full-chunk`)
- Tag storage: always use `get_file_tags_v2` / `set_file_tags_v2` — never the old v1 commands
- Quick Look editor: `read_text_file` / `write_text_file`
- Platform guards: xattr gated on `#[cfg(not(target_os = "windows"))]`; FUSE/mount detection in is_fuse_path() has Linux/macOS/Windows impls; always check cfg guards before adding OS-specific code
- Cloud providers: all use `ff_` prefix in rclone config; `list_rclone_remotes` only shows `ff_` remotes; mounts go to `get_cloud_mounts_dir()/ff_<label>` Tauri commands; `renderTextEditor(entry, rawContent)` in ql-window.js; editor state in `_cmView`, `_editorDirty`, `_editMode`, `_currentEntry`
- Network mounts: all follow the same FUSE + JSON registry + `/proc/mounts` restore pattern

## Preferences
- Run cargo check/clippy after Rust changes
- Test frontend build with `npm run build` before committing
- Update RELEASE.md with changelog for new features
- Check both frontend and Rust compile successfully
- Use `t('key', { vars })` for ALL user-visible strings — never hardcode English in new UI code

## Current Features (as of r26 / 6.0.26 / 2026-03-22)
- Column/List/Icon/Gallery views with streaming directory listing
- Quick Look (Space bar) — images, video, audio, documents, archives
- Tags and colors (xattr + SQLite fallback for FAT32/exFAT/network)
- Compression — ZIP, TAR.GZ, TAR.BZ2, TAR.XZ with format picker dialog
- Secure delete, Find duplicates (SHA-256)
- Bookmarks / Favorites
- SMB/Network shares, Cloud/WebDAV (persisted across restarts)
- SFTP/SSH (sshfs, persisted)
- FTP/FTPS (curlftpfs, persisted)
- Git status badges in Column/List views (modified=amber, staged=green, untracked=grey, conflict=red); branch pill in toolbar; 3s cache per repo root
- Encrypted vaults via gocryptfs (optional, Ctrl+Shift+V): create/unlock/lock/remove; sidebar Vaults section; JSON registry in ~/.config/frostfinder/vaults.json
- Cloud storage: Google Drive, Dropbox, OneDrive via rclone FUSE (optional dep, Ctrl+Shift+G, persisted)
- Batch rename with full preview table (before/after columns, all files)
- Drag & drop to/from external apps
- Trash / Recycle Bin (restore individually or in bulk, conflict resolution)
- Dual-pane view (F3) — drag between panes, context menu, F5/F6 copy/move across panes
- Disk usage visualization (squarified treemap)
- File permissions UI (chmod/chown, rwx checkboxes + octal)
- Terminal integration (Ctrl+Alt+T)
- Plugin / Custom Actions system
- macOS build: .app + .dmg (Apple Silicon + Intel); minimum macOS 10.15
- Windows build: .msi + NSIS installer; Winget manifest; minimum Windows 10 1809 (glob-based, {path}/{name}/{dir}/{ext} vars)
- Localization (i18n) — 7 languages: en, es, fr, de, zh, ja, ar (all locale files present; 292 keys each)
- Date formatting respects user locale (setDateLocale() wired into initI18n())
- Icon theme system supports disk-loaded SVG themes; picker has Load from folder + Reload; getIcon() falls back to built-in for partial themes
- Language picker in Settings → Appearance (writes ff_locale to localStorage)
- Accessibility / ARIA (roles, live regions, full keyboard nav)
- Saved searches (Advanced Search → Save…, sidebar section)
- Find-in-file in Quick Look (Ctrl+F → CM search panel for text; DOM highlight bar for other content)
- Settings panel (Ctrl+,) — General / Appearance / Search / Network / Advanced
- Split-pane dual-panel mode (F3) with independent state per pane
- File comparison / diff (select 2 files → right-click → Compare files…)
- Onboarding overlay (first launch, 4 pages, guarded by ff_onboarded)
- Inline text editor in Quick Look (CodeMirror 6, read-only by default, Edit/Save/Discard, Ctrl+S)
- Copy path (right-click → Copy Path / Copy Current Path)
- Gallery slideshow progress bar
- Column view sort indicator (click cycles Name/Date/Size/Kind)
- Preview panel drag-to-resize (5px handle, saves ff_preview_w)
- Multi-window title disambiguation (BroadcastChannel numbering)
- Undo (Ctrl+Z) + Undo History Panel (Ctrl+Shift+Z)
- Tabs (Ctrl+T) — multiple tabs with independent state
- Trash folder hides .trashinfo metadata files automatically
- WebDAV mounts persisted across restarts
- SMB and WebDAV mounts shown in sidebar with disconnect button

## Code Stats (r26 / 2026-03-22)
- main.rs: 8209 lines
- main.js: 7149 lines
- views.js: 4269 lines
- utils.js: 439 lines
- ql-window.js: ~950 lines (Phase 2 additions: CodeMirror editor, find bar, editor toolbar)
- search.worker.js: 35 lines
- style.css: 1661 lines

## Translations
- English (en) — canonical, src/locales/en.json
- Spanish (es) — src/locales/es.json
- French (fr) — src/locales/fr.json
- German (de) — src/locales/de.json
- Chinese Simplified (zh) — src/locales/zh.json
- Japanese (ja) — src/locales/ja.json
- Arabic (ar) — src/locales/ar.json  [RTL]

All locale files have 292 keys matching en.json exactly.
Language auto-detected from navigator.language; overridden by ff_locale in localStorage.
Falls back to en.json if the requested locale fails to load.
RTL languages (ar, he, fa, ur, yi, dv, ps) automatically set html[dir=rtl] in initI18n().

## Packaging
- Flatpak manifest: com.frostfinder.desktop.json  (tag: v6.0.26)
- Homebrew cask: packaging/homebrew/frostfinder.rb  (version: 6.0.26)
- Winget manifest: packaging/winget/FrostFinder.FrostFinder.yaml  (PackageVersion: 6.0.26)
- macOS entitlements: src-tauri/entitlements/macos.entitlements
- AUR PKGBUILD: PKGBUILD  (pkgver: 6.0.26)
- Desktop file: packaging/frostfinder.desktop
- .SRCINFO generator: packaging/generate-srcinfo.sh
- Locale validator: scripts/check-locales.js  (run: node scripts/check-locales.js)
- Translation guide: TRANSLATION.md

## Streaming Directory Listing
Both halves are fully implemented and wired (complete since ~r35):
- Column view: `_streamDir(path, mySeq, onFirstChunk)` → `list_directory_streamed` → `dir-chunk` events
  - First-paint: 60 entries; tail: TAIL_CHUNK batches; cache hit: one shot
- List/Gallery/Icon: `listDirectoryFull(path)` → `list_directory_full_streamed` → `dir-full-chunk` events (100-entry batches)
- Stale guard via `_navSeq`/`mySeq`; JS cache (`_JS_DIR_CACHE`) for zero-IPC revisits

## Video thumbnails (r72)

`make_thumbnail` handles video via ffmpeg (optional runtime dep):
- Extensions: `mp4 mkv webm avi mov ogv m4v flv ts wmv 3gp`
- Command: `ffmpeg -ss 00:00:03 -i <path> -vframes 1 -q:v 5 -vf scale=256:-1 -f image2pipe -vcodec mjpeg pipe:1`
- JPEG magic bytes validated before caching; retries from 0:00 if 3s seek empty
- Same `thumb_cache_put/get` as images — no separate cache
- `Err("ffmpeg not found")` if binary absent — caller shows generic icon

JS changes:
- Icon view: `isVideo`, `thumbUrl` covers video, `needThumb` queues `VIDEO_EXTS`, play overlay `▶` (28px) on icon box
- Gallery strip: `isMedia` already included `VIDEO_EXTS`; play badge (16px) added in `_loadGthumb` `onload`


## Tag database integrity (r70)

Two storage systems exist (both are active for compatibility):
- **SQLite `tags.db`** (`tag_db()`) — v2 system, used by `get_file_tags_v2` / `set_file_tags_v2`
- **JSON `tags.json`** (`load_tags_db()`) — v1 legacy, used by `get_all_tags`, `get_tags_with_colors`

Orphan management targets the SQLite store (most tags are written there via v2 API).

| Command | What it does |
|---|---|
| `get_audio_tags(path)` | Returns `{title,artist,album,year,track,genre,comment}` via lofty — no exiftool |
| `write_audio_tags(path, tags)` | Writes changed audio tags natively; creates tag block if absent |
| `audit_tag_db()` | Returns paths in `file_tags` where `Path::exists()` is false — read-only |
| `cleanup_tag_db()` | Deletes those rows, returns count |
| `tag_db_stats()` | Returns `{total, orphans}` — used by Settings UI |

Background sweep runs 15s after startup via `setTimeout`. Silent unless rows are removed.


## Error log infrastructure (r69)

**JS side:**
- `logError(msg, context)` — captures to `_errorRing[]`, `FF.log('ERROR')`, and `append_error_log` (async)
- `window._errorRing` — ring buffer, max 200 entries, survives navigate() calls
- `showToast` patched — `type='error'` auto-routes through `logError`
- `Ctrl+Shift+E` — opens error tab in FF debug panel
- Settings → Advanced → Debug — View / Copy report / Clear buttons

**Rust side:**
- `error_log_path()` → `~/.local/share/frostfinder/error.log`
- `append_error_log(message)` — appends line, rotates at 512 KB
- `get_error_log()` — returns full log as String
- `clear_error_log()` — truncates file


## Watch mode (r68)

`watch_dir` now detects FUSE/network paths via `is_fuse_path()`:

| Filesystem type | Detection | Watch mode |
|---|---|---|
| Local (ext4, btrfs, xfs, …) | Not in FUSE list | inotify — real-time |
| sshfs / fuse.sshfs | fstype contains "fuse" | polling — 3s |
| curlftpfs / fuse.curlftpfs | fstype contains "fuse" | polling — 3s |
| cifs / SMB | fstype == "cifs" or "smb3" | polling — 3s |
| NFS / NFS4 | fstype == "nfs" or "nfs4" | polling — 3s |
| WebDAV / davfs2 | fstype contains "davfs" | polling — 3s |

Both modes emit the same `dir-changed` event to JS. The 150ms JS-side debounce and `refreshColumns()` path are unchanged.

`get_watch_mode()` Tauri command returns `"inotify"` / `"polling"` / `"off"`.
JS `_updateWatchIndicator()` renders `● live` or `⏱ polling` next to the status bar.
`_poll_stop: Arc<AtomicBool>` on `DirWatcher` signals poll thread exit via `unwatch_dir()`.


## Undo stack — supported operations (r67)

| Op key | Triggered by | Undo action | Redo action |
|---|---|---|---|
| `move` | drag-drop move, Ctrl+X paste | `move_file` reversed | `move_file` forward |
| `copy` | drag-drop copy, Ctrl+C paste | `delete_items` dst | `copy_file` |
| `rename` | inline rename, F2 | `rename_file` reversed | `rename_file` forward |
| `delete` | Delete key, Move to Trash | `check_conflicts` + `trash_restore_with_resolution` | `delete_items_stream` |
| `create` | New Folder, New File | `delete_items` | not supported |
| `batchRename` | Batch Rename dialog | `rename_file` each reversed | `rename_file` each forward |
| `tags` | color-tag toggle in context menu | `set_file_tags_v2` with before[] | `set_file_tags_v2` with after[] |
| `chmod` | Permissions dialog apply | `chmod_entry` + `chown_entry` old values | re-apply new values |

Stack limit: 50 entries per tab. Redo stack cleared on new action.


## ARIA implementation status (r66)
Interactive elements now have proper roles:
- Context menu: `role=menu`, `aria-label`, items `role=menuitem`, separators `role=separator`, disabled `aria-disabled`
- Column view list: `role=listbox`, `aria-multiselectable`, `aria-label`
- Column view rows (frow): `role=option`, `aria-selected`, `aria-label` (name + type)
- List view rows: `role=row`, `aria-selected`, `aria-label`
- Icon view items: `role=option`, `aria-selected`, `aria-label`
- `announceA11y()` called on navigate (folder name) — live region already in views.js
- Known gaps (tracked): view mode switches, trash count, toast live region, dual-pane pane switch


## IPC Event Reference
| Event | Emitted by | Consumer |
|---|---|---|
| `dir-chunk` | `list_directory_streamed` | `_streamDir()` |
| `dir-full-chunk` | `list_directory_full_streamed` | `listDirectoryFull()` |
| `dir-changed` | inotify watcher | 150ms debounce → `refreshColumns()` |
| `drives-changed` | udisks2 watcher | sidebar refresh |
| `delete-progress` | `delete_items_stream` | `_sbProgress()` |
| `tauri://drag-drop` | Tauri runtime | drag-drop handler |

## Community files
- `CONTRIBUTING.md` — setup, translation guide, Orca test checklist, code style, commit format
- `CODE_OF_CONDUCT.md` — Contributor Covenant v2.1
- `SECURITY.md` — threat model, in-scope vulnerabilities, private reporting instructions


## Testing

### Rust
```bash
cd src-tauri && cargo test -- --test-threads=4
```
Covers: DirCache LRU eviction, DB tag roundtrip, SMB/Cloud/SFTP/FTP registry serde,
file copy/move, FileOpProgress serialisation, FileEntryFast serde,
search_advanced (11), batch_rename all 5 modes (9), migrate_settings (4).
Total: 52 test functions.
Test file: appended `#[cfg(test)] mod tests` at end of `src-tauri/src/main.rs`.
Dev dependency: `tempfile = "3"` in `src-tauri/Cargo.toml`.

### JavaScript
```bash
npm test           # single run
npm run test:watch # watch mode
```
Config: `vitest.config.js` (jsdom environment, globals, src/test/setup.js).
Setup: `src/test/setup.js` — stubs all Tauri IPC mocks, resets localStorage.
Files: `src/test/utils.test.js` (fmtSize, fmtDate, escHtml, fileColor, fileIcon,
  mimeLabel, extension lists, bookmarks), `src/test/views.test.js` (column view DOM,
  r59 insertBefore regression, r58 gallery stale-meta regression),
  `src/test/main.test.js` (t() helper, undo/redo stack, settings persistence, search filters),
  `src/test/a11y.test.js` (42 cases: all 15 Orca checklist items, axe-core ARIA validation).
Total: 196 test cases across 38 suites.

### CI
`.github/workflows/ci.yml` runs on every push/PR to main:
- `rust` job: fmt check + clippy + cargo test
- `js` job: npm ci + build + vitest
- `release` job (tags only): builds .deb/.rpm/.AppImage + attaches to GitHub Release


## Last Audit
- Date: 2026-03-22 (Beta 6, r26) — r25 lofty compile fixes
- r26 (B6): Compile fixes for r25 lofty integration: lofty::tag::items::ItemKey → lofty::prelude::ItemKey (correct module path in both get_audio_tags and write_audio_tags); AudioFile trait added to write_audio_tags imports so save_to_path is in scope (E0433 × 2, E0599 × 1)
- Date: 2026-03-22 (Beta 6, r25) — Phase 17: Native audio tag editing (no exiftool)
- r25 (B6): Phase 17 — Audio tag editor now uses native Rust lofty crate (v0.22) instead of exiftool; new Tauri commands get_audio_tags / write_audio_tags return/accept {title,artist,album,year,track,genre,comment}; lofty auto-detects format and uses correct tag type (ID3v2 for MP3, VorbisComment for FLAC/OGG, iTunes atoms for M4A, etc.); _showAudioTagEditor in views.js updated to call new commands, adds Comment field, removes exiftool dependency message from error; lofty = "0.22" added to Cargo.toml; Cargo recompile required
- Date: 2026-03-22 (Beta 6, r24) — Phase 16: Bug Fixes (split-pane restore, icon scan, settings UI)
- r24 (B6): Phase 16 — 3 bugs fixed from screenshot audit: (1) _toggleSplitPane close branch now clears view-host inline flex so it snaps back to full width; (2) scan_icon_folder Rust command rewritten to walk directory tree recursively (depth-guard 8) with first-match-wins dedup, so icon packs stored in subdirectories work; (3) Settings dialog fully redesigned — inline styles replaced with CSS classes (stg-dialog, stg-sidebar, stg-main, stg-header, stg-content, stg-close-btn, stg-nav-btn, stg-header-title); stg-row text #94a3b8→#c8d0dc, controls padded to 5px, min-width 140px on select, stg-num 80px, group rows min-height 42px, border-radius 11px cards, sidebar 168px
- Date: 2026-03-22 (Beta 6, r23) — Phase 15: Bug Fixes (icon theme dialog, split pane, toolbar, progress bar)
- r23 (B6): Phase 15 — 4 bugs fixed: dialog:allow-save replaced with dialog:default in capabilities/main.json (fixes "Load from folder" permission error shown in UI); _toggleSplitPane now calls _navigatePaneB(_paneB.path) instead of _renderPaneB() so split pane actually loads directory entries instead of showing blank; vbtn-split-pane button added to view-switcher in renderToolbar (visually separated by left border, blue highlight when active); progress bar bottom changed from 0 to 52px with translateY(calc(100%+52px)) so it slides up above the footer and never overlaps Settings/Cheatsheet buttons
- Date: 2026-03-22 (Beta 6, r22) — Phase 14: Bug Fixes (UI/UX from screenshots)
- r22 (B6): Phase 14 — 4 bugs fixed from user screenshots: new window no longer inherits main-window session (restoreSession skipped when __initialPath set); split-pane state moved from localStorage to sessionStorage so each window has independent split-pane memory; sb-footer rebuilt with flex row — cheatsheet keyboard button (⌨) added beside Settings, wired to showCheatSheet(); icon theme picker gains red ✕ remove button on active disk theme row that calls setIconTheme('builtin') and closes dialog
- Date: 2026-03-22 (Beta 6, r21) — Phase 13: Bug Fixes & Extension Parity
- r21 (B6): Phase 13 — Full line-by-line audit; 4 code bugs fixed: afterEach missing from vitest import in utils.test.js and a11y.test.js (ReferenceError broke 11+ test cases each); VIDEO_EXTS in utils.js extended with flv/wmv/3gp to match Rust make_thumbnail list; views.js codec badge VIDEO_EXTS_SET also gains 3gp; CONTRIBUTING.md: a11y.test.js added to test file list, Arabic row added to language table; all packaging versions bumped to 6.0.21; metainfo.xml gets 6.0.20 release entry
- Date: 2026-03-22 (Beta 6, r18) — Phase 10: Security Hardening Round 2
- r18 (B6): Phase 10 — safe_join_zip() replaces weak replace("..",_) for ZIP extraction (absolute-path escape fix); SMB mount_smb + list_smb_shares use 0600 temp credentials files instead of password= on CLI; mount_webdav writes ~/.davfs2/secrets (0600) and uses real uid/gid via libc::getuid/getgid; unmount_cloud strips secrets entry on disconnect
- r19 (B6): Phase 11 — Mutex/RwLock poisoning: 28 production lock().unwrap() sites replaced with unwrap_or_else(|e| e.into_inner()) across ACTIVE_WATCHER/DIR_CACHE/search_index_store/tag_db/SFTP_MOUNTS/FTP_MOUNTS; inline regex in mount_webdav cached via OnceLock; batch rename start_num.saturating_add(i as u32)
- r20 (B6): Phase 12 — Test coverage: 8 new suites in utils.test.js; fmtDate all 6 branches with vi.useFakeTimers(); fmtDateAbsolute, setDateLocale, fmtDriveSpace, driveColor, driveTypeBadge, favColor fully covered; total 196 JS cases / 52 Rust tests
- Date: 2026-03-21 (Beta 6, r13) — Phase 5: Accessibility Automation
- r13 (B6): Phase 5 — a11y.test.js added (42 test cases, all 15 Orca checklist items, axe-core ARIA validation); gen-shortcuts-readme.js script generates README shortcut table from _KB_DEFAULTS (--check mode for CI); README shortcuts regenerated (30 shortcuts, 6 categories); axe-core added to devDependencies
- Date: 2026-03-21 (Beta 6, r12) — Phase 4: UX Gaps
- r12 (B6): Phase 4 — fmtDate uses setDateLocale() wired from initI18n() (no longer hardcodes en-US); icon theme picker rebuilt: loadDiskTheme() scans folder for SVG files matching 47 known keys, caches in ff_diskThemeSvgs, getIcon() checks disk map first; scan_icon_folder Rust command added; 9 new theme.* locale keys (292 total)
- Date: 2026-03-21 (Beta 6, r11) — Phase 3: Test Coverage
- r11 (B6): Phase 3 — JS main.test.js added (61 new cases: t(), undo/redo stack, settings persistence, search filters); Rust +24 tests (search_advanced ×11, batch_rename ×9, migrate_settings ×4); futures dev-dep added; totals: 120 JS cases / 52 Rust tests
- Date: 2026-03-21 (Beta 6, r10) — Phase 2: Silent Failure Fixes
- r10 (B6): Phase 2 — state._platform + state._deps populated at init(); "Open With…", "Open as Root", LUKS unlock gated on linux; settings corruption shows toast; SFTP pw-auth ↻→↗ pre-filled dialog link; showSftpDialog(prefill); cloud dialog inline error+recovery UI; 2 new locale keys (283 total)
- Date: 2026-03-21 (Beta 6, r9) — Phase 1: i18n + docs fixes
- r9 (B6): Phase 1 — 156 raw showToast() calls wired through t(); 63 new locale keys (all 7 locales at 281 keys); README keyboard shortcut table rewritten from _KB_DEFAULTS (43 entries, 7 categories)
- r1 (B6): Critical bug fix — renderSidebar() closing brace 127 lines too early; network mount sections never refreshed; fixed
- Date: 2026-03-21 (r82, last Beta 5)
- r64: Phase 1 blockers resolved — streaming docs corrected, 5 locale files added,
  language picker wired into Settings, packaging files created (frostfinder.desktop,
  com.frostfinder.desktop.json, PKGBUILD), MEMORY.md synced to r62
- r63-r64: Phase 2 — 20 Rust unit tests, JS Vitest suite (utils + views), persistent settings (get_settings/set_settings), GitHub Actions CI (.github/workflows/ci.yml)
- r65: Phase 3 — Flatpak manifest (production-ready), AppStream metainfo, .desktop Actions=, PKGBUILD check(), CI matrix release + flatpak-lint job
- r66: Phase 4 — CONTRIBUTING.md (translation guide, Orca checklist), CODE_OF_CONDUCT.md, SECURITY.md, ARIA fixes (role=menu/menuitem/listbox/option/row + aria-selected/label/disabled on all view rows and context menus, announceA11y wired into navigate), npm audit in CI
- r67: Phase 5 — undo completeness: delete/Trash undo wired to trash_restore_with_resolution, redo re-trashes; batch rename pushUndo added to views.js apply button (pushUndo injected into deps); tag toggle pushUndo; chmod/chown pushUndo; undo panel labels humanised with icons for all 8 op types
- r68: Phase 6 — FUSE mount live refresh: is_fuse_path helper reads /proc/mounts; watch_dir branches on FUSE detection — polling (3s mtime+count snapshot, AtomicBool stop signal) vs inotify; unwatch_dir signals poll thread; get_watch_mode command; JS watch-indicator shows ● live / ⏱ polling in status bar
- r69: Phase 7 — Error visibility: append_error_log/get_error_log/clear_error_log Rust commands; logError() wrapper + showToast monkey-patch captures all 'error' type toasts; _errorRing (200 entry ring buffer on window); FF panel ⚠/📋 buttons; Settings Advanced error log row; Ctrl+Shift+E shortcut; 15 silent catch blocks hardened
- r70: Phase 8 — Tag DB integrity: audit_tag_db/cleanup_tag_db/tag_db_stats Rust commands; background startup sweep at 15s; Settings → Advanced audit/clean buttons; 3 unit tests
- r71: Phase 9 — Orca gaps closed: announceA11y imported + duplicate removed; Gap 11 view mode switch; Gap 13 all toasts → live region; Gap 15 pane focus; Gap 12 Trash count; CONTRIBUTING.md checklist all items implemented
- r72: Phase 10 — Video thumbnails: make_thumbnail video branch (ffmpeg, -ss 3s, retry, JPEG validation, graceful fallback); isVideo in icon view; needThumb queues VIDEO_EXTS; play overlay (icon + gallery strip); gallery _loadGthumb flows through unchanged
- r73: Build fixes — duplicate showToast (renamed original to _origShowToast); E0308 in audit/cleanup/stats query_map (use match instead of unwrap_or_else Box); unused mpsc import removed
- r82: Phase 5 — Cross-platform: xattr conditional (#[cfg(not(windows))], SQLite fallback on Windows); is_fuse_path three-way: Linux /proc/mounts, macOS libc::statfs, Windows UNC; Windows drive listing via wmic; tauri.conf.json bundle targets +dmg+app+msi+nsis; macOS entitlements; rust-crosscheck CI job (macos-14 + windows-2022 cargo check); release matrix 3 OSes x 7 bundles; Homebrew cask; Winget manifest; README downloads table cross-platform
- r81: Phase 4 — Git badges: find_git_root/get_git_status/invalidate_git_cache Rust (git CLI, 3s cache); refreshGitStatus() in navigate(); gitBadgeHtml() + gitBranchHtml() injected into deps; badges in column+list rows; branch pill in toolbar; Vault commands: check_gocryptfs/list_vaults/create_vault/unlock_vault/lock_vault/remove_vault; showVaultDialog() JS; vault sidebar section; Ctrl+Shift+V; 15 locale keys (git.*+vault.*); locales 139→154 keys
- r80: Phase 3 — Cloud storage: check_rclone/list_rclone_remotes/add_cloud_provider/mount_cloud_provider/unmount_cloud_provider/remove_cloud_provider/restore_cloud_mounts Rust commands; showCloudDialog() JS (provider tiles, connected accounts list, rclone-missing error card); cloud sidebar section in renderSidebar(); restore_cloud_mounts in init() startup; 13 cloud.* locale keys in all 7 files (126→139 keys); rclone added to PKGBUILD optdepends; Ctrl+Shift+G keybinding
- r79: Phase 2 — Inline editor: read_text_file/write_text_file Rust commands (atomic write, 2 MB cap); CodeMirror 6 lazy-loaded in ql-window.js (10 lang packages, one-dark theme); renderTextEditor() replaces plain <pre> for TEXT_EXTS (40 extensions); editor toolbar (#ql-editor-bar) with Edit/Save/Discard; dirty-state guards on navigation and close; Ctrl+F → CM search panel or DOM highlight find bar; Ctrl+S saves; Escape state machine (find → CM panel → edit mode → close); ql-file-saved event pushes undo entry to main window; 5 new Rust tests; TEXT_EXTS exported from utils.js
- r74-r78: Phase 1 distribution — Flatpak + AUR packaging files updated to v5.0.78; metainfo.xml name tag bug fixed (<n> was malformed); full release history added to metainfo; PKGBUILD pkgver bumped; AUR .SRCINFO generator script (packaging/generate-srcinfo.sh); locale CI job (scripts/check-locales.js, checks all locales match en.json key-for-key); Arabic locale (src/locales/ar.json, 126 keys, full RTL); RTL CSS block in style.css (html[dir=rtl] layout mirroring); RTL direction wired into initI18n() for ar/he/fa/ur/yi/dv/ps; Arabic added to Settings language picker; TRANSLATION.md guide; aur-notify CI job on tag releases

## Backup Process
When user requests backup:
1. Update MD files first (RELEASE.md, MEMORY.md, AGENTS.md)
2. Create backup:
```bash
tar -czvf BACKUP/FrostFinder-beta-6-rXX_YYYY-MM-DD.tar.gz \
  --exclude='target' --exclude='.cargo' --exclude='.git' \
  src/ src-tauri/ package.json package-lock.json \
  index.html ql.html vite.config.js \
  AGENTS.md BUILD.md README.md RELEASE.md MEMORY.md VERSION \
  PKGBUILD com.frostfinder.desktop.json packaging/
```
Always include MEMORY.md and packaging/ in backups.
