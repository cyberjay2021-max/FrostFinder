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

## Current Features (as of v1.0.1-RC2 / R1 / 2026-03-28)
- Light/Dark/System theme switcher (applyTheme(), ff_theme in localStorage, data-theme on <html>, live system-preference tracking)
- Icon Theme controls accessible from Settings → Customisation (Open Icon Theme Picker button)
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
- Preview panel toggle (Ctrl+P), resize via drag handle (180-800px), state saved to localStorage
- Metadata editor (Ctrl+i) — Edit EXIF for images, audio tags, PDF metadata
- Audio metadata search (in metadata editor) — Search MusicBrainz database, fetch album covers
- Multi-window title disambiguation (BroadcastChannel numbering)
- Undo (Ctrl+Z) + Undo History Panel (Ctrl+Shift+Z)
- Tabs (Ctrl+T) — multiple tabs with independent state
- Trash folder hides .trashinfo metadata files automatically
- WebDAV mounts persisted across restarts
- SMB and WebDAV mounts shown in sidebar with disconnect button

## Code Stats (v1.0.1-RC2-R39 / 2026-04-12)
- main.rs: 12792 lines
- tags.rs: 567 lines
- trash.rs: 227 lines
- search.rs: 591 lines
- main.js: 8121 lines
- views.js: 5099 lines
- utils.js: 450 lines
- undo.js: 173 lines
- settings.js: 67 lines
- network.js: 518 lines
- plugins.js: 562 lines
- camera.js: 317 lines
- ql-window.js: 1236 lines  (CodeMirror editor, find bar, editor toolbar)
- search.worker.js: 71 lines
- style.css: 2620 lines

## Translations
- English (en) — canonical, src/locales/en.json
- Spanish (es) — src/locales/es.json
- French (fr) — src/locales/fr.json
- German (de) — src/locales/de.json
- Chinese Simplified (zh) — src/locales/zh.json
- Japanese (ja) — src/locales/ja.json
- Arabic (ar) — src/locales/ar.json  [RTL]

All locale files have 386 keys matching en.json exactly.
Language auto-detected from navigator.language; overridden by ff_locale in localStorage.
Falls back to en.json if the requested locale fails to load.
RTL languages (ar, he, fa, ur, yi, dv, ps) automatically set html[dir=rtl] in initI18n().

## Packaging
- Flatpak manifest: com.frostfinder.desktop.json  (tag: v1.0.0)
- Homebrew cask: packaging/homebrew/frostfinder.rb  (version: 1.0.0)
- Winget manifest: packaging/winget/FrostFinder.FrostFinder.yaml  (PackageVersion: 1.0.0)
- macOS entitlements: src-tauri/entitlements/macos.entitlements
- AUR PKGBUILD: PKGBUILD  (pkgver: 1.0.0)
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
| `get_audio_cover(path)` | Returns base64-encoded cover art or null |
| `search_music_metadata(query)` | Searches MusicBrainz API, returns title/artist/album/year/cover_url |
| `fetch_album_art(musicbrainz_id)` | Fetches cover image URL from Cover Art Archive |
| `get_exif_tags(path)` | Returns `{DateTimeOriginal,Make,Model,Orientation,GPSLatitude,GPSLongitude,GPSAltitude}` via kamadak-exif — no exiftool |
| `write_exif_tags(path, fields)` | Writes EXIF to JPEG/PNG natively; supports DateTimeOriginal, Make, Model, GPS |
| `get_pdf_meta(path)` | Returns `{Title,Author,Subject,Keywords}` via lopdf — no exiftool |
| `write_pdf_meta(path, fields)` | Writes PDF metadata natively via lopdf |
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
- All 15 Orca checklist items implemented and covered by automated tests in a11y.test.js (completed r71)


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
- Date: 2026-03-29 (v1.0.1-RC2-R3) — Audio metadata search + album covers + preview panel improvements
- R3 (RC2): (1) Added MusicBrainz search in audio tag editor - search for songs online and auto-fill metadata; (2) Album cover embedding - downloads cover from Cover Art Archive and embeds into audio file; (3) Album cover display - Gallery View shows embedded cover instead of music icon; (4) Added Ctrl+P to toggle preview panel; (5) Preview panel resize with drag handle (180-800px); (6) Added reqwest, urlencoding, base64 to Cargo.toml; (7) Updated AGENTS.md backup command to include build.rs, capabilities, gen, icons
- Date: 2026-03-28 (v1.0.1-RC2-R3) — Native EXIF and PDF metadata (no exiftool)
- R3 (RC2): EXIF and PDF metadata editors now use native Rust — kamadak-exif for EXIF reading, lopdf for PDF read/write; new commands: get_exif_tags, write_exif_tags, get_pdf_meta, write_pdf_meta; JS updated to call new commands; error messages no longer mention exiftool; kamadak-exif and lopdf added to Cargo.toml
- Date: 2026-03-28 (v1.0.1-RC2-R2) — Add missing build.rs
- R2 (RC2): build.rs was absent from archive — tauri::generate_context!() requires tauri_build::build() to run first; added src-tauri/build.rs with the single required call
- Date: 2026-03-28 (v1.0.1-RC2-R1) — List view sort & selection fixes, context menu edge clamping
- R1 (RC2): 5 QoL bugs fixed: (1) keyboard nav in list view now reads sel._e (list-sorted) instead of getCurrentEntries() (global-sorted) — ArrowUp/Down now move to the visually correct row; (2) sort header click clears sel + selIdx before re-render so selection doesn't jump to wrong file; (3) sel._e updated to list-sorted entries immediately after sort in renderListView() — fixes getSelectedEntries(), context menu, Open With, drag-and-drop; (4) view mode switch Column→List remaps savedSelIdx from global-sort to list-sort position via path lookup; (5) context menu clamped to all four viewport edges (was only right+bottom)
- Date: 2026-03-27 (v1.0.1-rc1, r2) — Fix Settings → Shortcuts display
- r2 (RC1): (1) flex-shrink:0 added to .stg-group in style.css — shortcut category groups were compressing to ≤1 visible row because stg-content is a fixed-height flex column and groups defaulted to flex-shrink:1; now each group holds its natural height and stg-content scrolls; (2) _keysLabel() special-key map rewritten to use plain ASCII text only (Bksp/Del/Up/Down/Left/Right) — Unicode arrows and ⌫ do not render in the app's WebView font, showing as ⊠ instead
- Date: 2026-03-27 (v1.0.1-rc1, r1) — Missing UI additions
- r1 (RC1): (1) applyTheme() added to main.js — reads ff_theme (dark/light/system), sets data-theme on <html>, wires prefers-color-scheme MediaQueryList; (2) html[data-theme="light"] CSS block added to style.css with full light-mode variable set; (3) Theme selector group added to Settings → Appearance; (4) Icon Theme group added to Settings → Customisation wired to showIconThemePicker(); (5) ff_theme and ff_locale selects now apply immediately on change; (6) toast.no_clipboard_history added to all 11 non-English locale files (all 12 locales now 293 keys); (7) settings.js header comment corrected — no longer falsely lists showSettings as an export
- Date: 2026-03-22 (v1.0.0, r34) — Full codebase audit: all bugs fixed
- r34 (v1.0.0): Audit pass — (1) showSftpDialog body was missing from network.js after extraction (only signature remained); reconstructed complete SFTP connect dialog with host/port/username/password/key/remote-path fields; (2) search.rs: DeepSearchResult/IndexEntry/IndexSearchResult/SearchResultV2 lacked pub + #[derive]; all 7 exported fns lacked pub; search_files return type fixed to crate::SearchResult; std::fs import added; (3) search.rs: SEARCH_INDEX static referenced but defined in main.rs — moved into search.rs (correct owner), removed orphan from main.rs; OnceLock added to search.rs imports; (4) trash.rs: TrashConflict/RestoreInstruction lacked pub + #[derive]; all 5 command fns lacked pub; (5) main.rs: use std::sync::Mutex as StdMutex shadowed already-imported Mutex — alias removed, rclone RC code uses Mutex directly; (6) All 176 Rust commands registered verified; all 12 locale files valid JSON (292 keys each); all module exports verified; init() wiring order confirmed correct
- Date: 2026-03-22 (v1.0.0, r33) — Phase 6: Community & Quality — STABLE RELEASE
- r33 (v1.0): Phase 6 complete — P6.1: 6 existing locales updated to 71-73% (all above 70% gate); 5 new locales created (pt/ko/hi/nl/ru at 21-22%, advisory-only via NEW_LOCALES set); check-locales.js updated with isNew flag; fill-locales.js script created; P6.2: src-tauri/tests/e2e/main.rs created (20 journey skeletons gated behind e2e Cargo feature); tauri-driver dev-dep added; E2E CI job added (xvfb, release binary build, tauri-driver); P6.3: docs/ VitePress site — .vitepress/config.js (11-page nav), guide/getting-started.md, guide/good-first-issues.md, architecture/overview.md (module table with line counts); .github/workflows/docs.yml (GitHub Pages deploy on docs/** changes); docs:dev/build/preview scripts in package.json; P6.4: v1.0.0 stable release — plugin-schema-v1.json (JSON Schema for plugin objects, semver-stable); AGENTS.md stability note; all version files bumped from beta 6.0.32 to stable 1.0.0
- Date: 2026-03-22 (Beta 6, r32) — Phase 5: Platform Expansion
- r32 (B6): Phase 5 complete — P5.1: aarch64-unknown-linux-gnu added to CI crosscheck + release matrix (.deb + .AppImage); ARM cross toolchain (gcc-aarch64-linux-gnu); --target flag in release build step; P5.2: aarch64-pc-windows-msvc added to CI crosscheck; P5.3: rclone RC daemon (start_rclone_rc/stop_rclone_rc/rclone_rc_list/rclone_rc_copy); RCLONE_RC_PROCESS static; ensureRcloneRc/rcloneRcList/rcloneRcCopy JS helpers in network.js; rclone_rc dep in check_optional_deps; P5.4: macos.entitlements updated for App Sandbox compliance (app-sandbox, allow-jit, files.all, bookmarks); .github/workflows/mas-submit.yml created (certificate import, provisioning profile, universal build, altool upload)
- Date: 2026-03-22 (Beta 6, r31) — Phase 4: Fill the Finder Parity Gap
- r31 (B6): Phase 4 complete — P4.1: OFFICE_EXTS expanded (pptx/ppt/odt/odp/ods/odg); pptx_to_text/odt_to_text Rust extractors; office_to_pdf_cached via LibreOffice headless; get_office_preview command; ql-window.js OFFICE_EXTS branch with PDF/text/install_nudge modes; P4.2: MTP/Android/camera support — detect_mtp_devices/mount_mtp/unmount_mtp Rust (gio/lsusb); MtpDevice struct; _mtpDevices state; 5s poll in init(); Devices sidebar section with mount/eject buttons; mtp type in driveIcon/driveColor; P4.3: cloud sync-state — get_cloud_sync_state(local_dir, cloud_remote) via rclone lsf; check_cloud_remote_reachable; SyncState/FileSyncState structs; P4.4: community plugin registry — pm-community details section in Plugin Manager; GitHub raw JSON fetch; preview/install UI with dedup check; caps auto-detected on install
- Date: 2026-03-22 (Beta 6, r30) — Phase 3: UX & Power-User Polish
- r30 (B6): Phase 3 — P3.1: persistent undo history (save_undo_history/load_undo_history/clear_undo_history Rust; persistUndoHistory/restoreUndoHistory/clearUndoHistory JS in undo.js; cap raised 50→200; auto-persist on pushUndo; restore on init(); clear from Settings→Advanced); P3.2: redo for create now works (isDir flag stored in create undo item; redo calls create_directory/create_file_cmd with srcDir+newName); P3.3: desktop notifications (tauri-plugin-notification dep; notification:default capability; notifyOpComplete() JS helper; fires on copy/move/trash completion when window not focused); P3.4: check-locales.js blocks CI at <70% translated (advisory above threshold, still shows %); P3.5: already done r27 (✓); P2.3 final: search_by_tag_v2 backed by SQLite; all 3 remaining v1 search_by_tag callers updated to v2
- Date: 2026-03-22 (Beta 6, r29) — Phase 2 continued: JS + Rust module splits complete
- r29 (B6): P2.1 complete — undo stubs removed from main.js; settings.js (64L: loadPersistentSettings/persistSettings/patchLocalStorage); network.js (455L: showSftpDialog/showFtpDialog/showVaultDialog/showCloudDialog/CLOUD_PROVIDERS); plugins.js (499L: full plugin system incl. trust/run/export-import/_pluginDetectCapabilities, getPlugins/setPlugins accessors, leftover matchesGlob fragment cleaned); P2.2 stage 2+3 — trash.rs (125L: TrashItem/TrashConflict/RestoreInstruction structs + 5 commands); search.rs (274L: DeepSearchResult/IndexEntry/SearchResultV2 structs + deep_search/index_*/ search_advanced/search_files); main.rs now declares pub mod search; pub mod trash; alongside pub mod tags; all re-exported via pub use; main.js −978L (6300), main.rs −659L (7666)
- Date: 2026-03-22 (Beta 6, r28) — Phase 2: Architecture Refactor
- r28 (B6): Phase 2 (P2.1 stage 1, P2.2 stage 1, P2.3 complete, P2.4 complete): P2.3 — tag_colors table added to SQLite, get_tags_with_colors_v2/set_tag_color_v2/get_all_tags_v2/migrate_tags_to_sqlite Rust commands, all JS callers updated to v2, migration runs silently at 15s startup alongside cleanup_tag_db; P2.4 — scripts/generate-types.js parses main.rs, emits 141-command src/types/tauri-commands.d.ts with per-command typed invoke() overloads, npm run gen-types/gen-types:check added; P2.1 stage 1 — src/undo.js extracted (129 lines, initUndoDeps wired in init()); P2.2 stage 1 — src-tauri/src/tags.rs extracted (416 lines), pub mod tags declared in main.rs, 28 duplicate fn blocks removed from main.rs, main.rs reduced by 285 lines
- Date: 2026-03-22 (Beta 6, r27) — Phase 1: Security & Stability Foundations
- r27 (B6): Phase 1 complete — P1.1: shell injection fixed; all {path}/{name}/{dir}/{ext} variables now single-quote escaped via _sq() before passing to sh -c; dry-run preview button in Plugin Manager shows expanded command with example path before saving; P1.2: _pluginDetectCapabilities() auto-detects shell/network/files:write/elevated from command string; capabilities stored on plugin object; trust dialog shows capability list; plugin list rows show capability badges; Revoke Trust button per-plugin; revoke_plugin_trust Rust command; trust auto-revoked on plugin delete; Export/Import buttons in Plugin Manager header (JSON, merge with dedup by id, re-detect capabilities on import); P1.3: localStorage vs sessionStorage contract documented in AGENTS.md with full key table and contributor rule; P1.4: stale "Known gaps" note in MEMORY.md corrected — all 15 Orca items were closed in r71
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
