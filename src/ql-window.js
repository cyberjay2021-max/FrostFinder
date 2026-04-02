// ql-window.js — Runs inside the native Quick Look WebviewWindow.
// Receives file data from the main window via Tauri events.
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow as _getAppWindow } from '@tauri-apps/api/window';
const appWindow = _getAppWindow();
import { listen, emit } from '@tauri-apps/api/event';
import { IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS, PDF_EXTS, TEXT_EXTS, DOC_EXTS, OFFICE_EXTS, BOOK_EXTS, HTML_EXTS, DMG_EXTS, FONT_EXTS, fmtSize, escHtml, fileIcon, fileColor } from './utils.js';

// ── CodeMirror 6 — lazy imports so non-text previews pay zero cost ────────────
let _cmModules = null;
async function getCM() {
  if (_cmModules) return _cmModules;
  const [
    { EditorView, keymap, highlightActiveLine, lineNumbers, highlightActiveLineGutter, drawSelection },
    { EditorState },
    { defaultKeymap, history, historyKeymap, undo, redo },
    { searchKeymap, openSearchPanel, closeSearchPanel, search, SearchCursor },
    { indentOnInput, syntaxHighlighting, defaultHighlightStyle, bracketMatching },
    { javascript }    ,
    { python }        ,
    { rust }          ,
    { css }           ,
    { html }          ,
    { json }          ,
    { markdown }      ,
    { xml }           ,
    { oneDark }       ,
    legacyModes
  ] = await Promise.all([
    import('@codemirror/view'),
    import('@codemirror/state'),
    import('@codemirror/commands'),
    import('@codemirror/search'),
    import('@codemirror/language'),
    import('@codemirror/lang-javascript'),
    import('@codemirror/lang-python'),
    import('@codemirror/lang-rust'),
    import('@codemirror/lang-css'),
    import('@codemirror/lang-html'),
    import('@codemirror/lang-json'),
    import('@codemirror/lang-markdown'),
    import('@codemirror/lang-xml'),
    import('@codemirror/theme-one-dark'),
    import('@codemirror/legacy-modes/mode/toml').catch(() => null),
  ]);
  _cmModules = {
    EditorView, EditorState, keymap, highlightActiveLine, lineNumbers,
    highlightActiveLineGutter, drawSelection,
    defaultKeymap, history, historyKeymap, undo, redo,
    searchKeymap, openSearchPanel, closeSearchPanel, search, SearchCursor,
    indentOnInput, syntaxHighlighting, defaultHighlightStyle, bracketMatching,
    javascript, python, rust, css, html, json, markdown, xml, oneDark,
    toml: legacyModes?.toml ?? null,
  };
  return _cmModules;
}

// Map file extension → CodeMirror language extension factory
function cmLangFor(ext) {
  return async () => {
    const cm = await getCM();
    switch (ext) {
      case 'js': case 'jsx': case 'mjs': case 'cjs':
        return cm.javascript({ jsx: ext === 'jsx' });
      case 'ts': case 'tsx':
        return cm.javascript({ typescript: true, jsx: ext === 'tsx' });
      case 'py': return cm.python();
      case 'rs': return cm.rust();
      case 'css': case 'scss': case 'less': return cm.css();
      case 'html': case 'htm': return cm.html();
      case 'json': return cm.json();
      case 'md': return cm.markdown();
      case 'xml': case 'svg': return cm.xml();
      case 'toml': {
        if (cm.toml) {
          const { StreamLanguage } = await import('@codemirror/language');
          return StreamLanguage.define(cm.toml);
        }
        return null;
      }
      default: return null;
    }
  };
}

// ── State ────────────────────────────────────────────────────────────────────
let _navEntries = [];   // flat list of non-dir entries for prev/next
let _curIdx     = 0;
let _mediaPort  = null;

// ── Editor state ──────────────────────────────────────────────────────────────
let _cmView     = null;   // active CodeMirror EditorView (null when not in text mode)
let _editorDirty = false; // unsaved changes flag
let _editMode    = false; // true = editable, false = read-only
let _currentEntry = null; // entry currently shown (needed by Save)

// ── Audio Visualizer ─────────────────────────────────────────────────────────
let _vizAnimId = null;
let _vizAC     = null;

function startAudioVisualizer(audioEl, canvas) {
  if (!audioEl || !canvas) return;
  if (_vizAnimId) { cancelAnimationFrame(_vizAnimId); _vizAnimId = null; }

  // ── Draw loop ─────────────────────────────────────────────────────────────
  const draw = () => {
    if (!canvas.isConnected || !audioEl.isConnected) { _vizAnimId = null; return; }
    _vizAnimId = requestAnimationFrame(draw);
    const W = canvas.offsetWidth || 280, H = canvas.offsetHeight || 56;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const g = canvas.getContext('2d');
    g.clearRect(0, 0, W, H);
    if (audioEl.paused || !audioEl._vizAnalyser) {
      const bars = 60, barW = W / bars;
      for (let i = 0; i < bars; i++) {
        g.fillStyle = 'rgba(100,130,160,0.22)';
        g.beginPath(); g.roundRect(i * barW + 0.5, H - 2, barW - 1.5, 2, 1); g.fill();
      }
      return;
    }
    const analyser = audioEl._vizAnalyser;
    const bufLen = analyser.frequencyBinCount, dataArr = new Uint8Array(bufLen);
    analyser.getByteFrequencyData(dataArr);
    const bars = Math.min(bufLen, 72), barW = W / bars;
    for (let i = 0; i < bars; i++) {
      const v = dataArr[i] / 255, h = Math.max(2, v * H);
      g.fillStyle = `hsla(${195 + v * 120},${60 + v * 30}%,60%,0.9)`;
      g.beginPath(); g.roundRect(i * barW + 0.5, H - h, barW - 1.5, h, 2); g.fill();
    }
  };

  // ── Wire WebAudio graph immediately (element must be idle, src not set yet) ─
  // Caller sets src AFTER this call so createMediaElementSource never runs
  // mid-stream and there is zero audio interruption.
  if (!audioEl._vizSetup) {
    try {
      if (!_vizAC || _vizAC.state === 'closed') {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (AC) _vizAC = new AC({ latencyHint: 'interactive' });
      }
      if (_vizAC) {
        const src      = _vizAC.createMediaElementSource(audioEl);
        const analyser = _vizAC.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.8;
        src.connect(analyser);
        analyser.connect(_vizAC.destination);
        audioEl._vizAnalyser = analyser;
        audioEl._vizSetup    = true;
      }
    } catch (err) { console.warn('QL audio viz setup failed:', err); }
  }

  // ── Document-level gesture unlock (belt-and-suspenders for WebKit2GTK) ──────
  // Capture-phase listener ensures _vizAC.resume() is called on the very first
  // user gesture (click, keydown, pointerdown) — before `play` fires.
  if(!window._qlACUnlockWired){
    window._qlACUnlockWired=true;
    const _unlock=()=>{
      if(_vizAC&&_vizAC.state==='suspended')_vizAC.resume().catch(()=>{});
    };
    document.addEventListener('click',_unlock,{capture:true,passive:true});
    document.addEventListener('keydown',_unlock,{capture:true,passive:true});
    document.addEventListener('pointerdown',_unlock,{capture:true,passive:true});
  }

  // ── Event listeners (once per element) ────────────────────────────────────
  if (!audioEl._vizListeners) {
    audioEl._vizListeners = true;
    // resume() in play handler as primary path; document listener above as fallback
    audioEl.addEventListener('play', () => {
      if (_vizAC && _vizAC.state === 'suspended') _vizAC.resume().catch(() => {});
      if (!_vizAnimId) draw();
    });
    audioEl.addEventListener('ended', () => {
      if (_vizAnimId) { cancelAnimationFrame(_vizAnimId); _vizAnimId = null; }
    });
  }

  draw();
}

// Extensions that WebKit2GTK cannot play in-process even with gst-plugins-bad.
// mkv excluded intentionally — WebKit can play H.264/VP9 MKV in-browser.
const WEBKIT_SKIP_EXTS = new Set(['avi','m4v','ogv']);

function getMediaUrl(path) {
  const encoded = encodeURIComponent(path).replace(/%2F/gi, '/');
  return 'http://127.0.0.1:' + _mediaPort + '/' + (encoded.startsWith('/') ? encoded.slice(1) : encoded);
}

function getTranscodeUrl(path) {
  const encoded = encodeURIComponent(path).replace(/%2F/gi, '/');
  const p = encoded.startsWith('/') ? encoded.slice(1) : encoded;
  return 'http://127.0.0.1:' + _mediaPort + '/transcode/' + p;
}

function getHeicJpegUrl(path) {
  const encoded = encodeURIComponent(path).replace(/%2F/gi, '/');
  const p = encoded.startsWith('/') ? encoded.slice(1) : encoded;
  return 'http://127.0.0.1:' + _mediaPort + '/heic-jpeg/' + p;
}

// ── Text editor helpers ──────────────────────────────────────────────────────

/** Destroy the active CodeMirror instance and hide the editor toolbar. */
function destroyCM() {
  if (_cmView) { _cmView.destroy(); _cmView = null; }
  _editorDirty = false;
  _editMode = false;
  document.getElementById('ql-editor-bar')?.classList.remove('visible');
}

/** Set dirty state and update toolbar save button appearance. */
function setDirty(dirty) {
  _editorDirty = dirty;
  const saveBtn = document.getElementById('ql-save-btn');
  if (saveBtn) {
    saveBtn.disabled = !dirty;
    saveBtn.classList.toggle('dirty', dirty);
  }
}

// ── Editor autosave / crash-recovery draft ───────────────────────────────────
// Writes editor content to localStorage every 5 s while dirty.
// Key: ff_draft_<djb2 hash of path>  (avoids slashes/special chars in keys).

function _draftKey(path) {
  // djb2 hash — fast, no crypto API needed
  let h = 5381;
  for (let i = 0; i < path.length; i++) h = ((h << 5) + h) ^ path.charCodeAt(i);
  return 'ff_draft_' + (h >>> 0).toString(36);
}

let _draftTimer = null;

function _draftSave() {
  if (!_editorDirty || !_cmView || !_currentEntry) return;
  try {
    const key = _draftKey(_currentEntry.path);
    localStorage.setItem(key, JSON.stringify({
      path: _currentEntry.path,
      content: _cmView.state.doc.toString(),
      ts: Date.now(),
    }));
  } catch (_) { /* localStorage full — non-fatal */ }
}

function _draftClear(path) {
  try { localStorage.removeItem(_draftKey(path || _currentEntry?.path || '')); } catch (_) {}
}

function _draftSchedule() {
  clearTimeout(_draftTimer);
  _draftTimer = setTimeout(_draftSave, 5000);
}

/** Called when opening a text file. If a newer draft exists, show a restore banner. */
function _draftRestore(entry) {
  try {
    const raw = localStorage.getItem(_draftKey(entry.path));
    if (!raw) return;
    const saved = JSON.parse(raw);
    // Only offer restore if draft is newer than file mtime (entry.modified is seconds-since-epoch)
    const draftMs = saved.ts || 0;
    const fileMs  = (entry.modified || 0) * 1000;
    if (draftMs <= fileMs) { _draftClear(entry.path); return; }
    // Show banner
    const banner = document.createElement('div');
    banner.id = 'ql-draft-banner';
    banner.style.cssText = [
      'position:absolute;top:0;left:0;right:0;z-index:200',
      'background:#1e3a5f;border-bottom:1px solid #2d5a8e',
      'color:#93c5fd;font-size:12px;padding:6px 12px',
      'display:flex;align-items:center;gap:10px',
    ].join(';');
    const age = Math.round((Date.now() - draftMs) / 60000);
    const ageStr = age < 1 ? 'just now' : age === 1 ? '1 minute ago' : age + ' minutes ago';
    banner.innerHTML = `<span>📄 Unsaved draft found (${ageStr})</span>
      <button id="ql-draft-restore" style="padding:2px 10px;border-radius:5px;background:#2563eb;color:#fff;border:none;cursor:pointer;font-size:11px">Restore</button>
      <button id="ql-draft-dismiss" style="padding:2px 10px;border-radius:5px;background:#374151;color:#d1d5db;border:none;cursor:pointer;font-size:11px">Dismiss</button>`;
    qlBody.style.position = 'relative';
    qlBody.prepend(banner);
    banner.querySelector('#ql-draft-restore').addEventListener('click', () => {
      if (_cmView) {
        _cmView.dispatch({ changes: { from: 0, to: _cmView.state.doc.length, insert: saved.content } });
        _editMode = true;
        setEditorReadOnly(false);
        updateEditorBarMode();
        setDirty(true);
      }
      banner.remove();
    });
    banner.querySelector('#ql-draft-dismiss').addEventListener('click', () => {
      _draftClear(entry.path);
      banner.remove();
    });
  } catch (_) {}
}

/** Evict drafts older than 7 days. Called once at startup. */
function _draftGC() {
  try {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (!k?.startsWith('ff_draft_')) continue;
      try {
        const val = JSON.parse(localStorage.getItem(k));
        if ((val?.ts || 0) < cutoff) localStorage.removeItem(k);
      } catch (_) { localStorage.removeItem(k); }
    }
  } catch (_) {}
}
_draftGC();


/**
 * Render a text or code file using CodeMirror 6.
 * Loads the appropriate language extension, creates the editor in read-only
 * mode, and shows the editor toolbar.
 */
async function renderTextEditor(entry, rawContent) {
  destroyCM();
  _currentEntry = entry;

  const cm = await getCM();
  const ext = entry.name.includes('.') ? entry.name.split('.').pop().toLowerCase() : '';

  // Resolve language extension (may be null for unknown types)
  const langFactory = cmLangFor(ext);
  const langExt = langFactory ? await langFactory() : null;

  // Build extension list
  const extensions = [
    cm.oneDark,
    cm.lineNumbers(),
    cm.highlightActiveLineGutter(),
    cm.highlightActiveLine(),
    cm.drawSelection(),
    cm.bracketMatching(),
    cm.indentOnInput(),
    cm.syntaxHighlighting(cm.defaultHighlightStyle, { fallback: true }),
    cm.history(),
    cm.keymap.of([
      ...cm.defaultKeymap,
      ...cm.historyKeymap,
      ...cm.searchKeymap,
    ]),
    cm.search({ top: false }),
    cm.EditorView.lineWrapping,
    cm.EditorView.theme({
      '&': { height: '100%', fontSize: '12.5px', fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code',monospace" },
      '.cm-scroller': { overflow: 'auto', lineHeight: '1.6' },
      '.cm-content': { padding: '12px 0' },
      '.cm-line': { paddingLeft: '4px' },
    }),
    cm.EditorState.readOnly.of(true),   // start read-only; toggled by Edit button
    cm.EditorView.updateListener.of(update => {
      if (update.docChanged && _editMode) {
        setDirty(true);
        _draftSchedule();
      }
    }),
  ];

  if (langExt) extensions.push(langExt);

  const state = cm.EditorState.create({ doc: rawContent, extensions });
  const host = document.createElement('div');
  host.style.cssText = 'width:100%;height:100%;overflow:hidden;';
  qlBody.innerHTML = '';
  qlBody.appendChild(host);

  _cmView = new cm.EditorView({ state, parent: host });

  // Show editor toolbar
  const bar = document.getElementById('ql-editor-bar');
  if (bar) bar.classList.add('visible');

  updateEditorBarMode();
  // Offer draft restore if a newer crash-recovery draft exists
  _draftRestore(entry);
}

/** Sync the Edit/Save/Discard button states to current mode. */
function updateEditorBarMode() {
  const editBtn    = document.getElementById('ql-edit-btn');
  const saveBtn    = document.getElementById('ql-save-btn');
  const discardBtn = document.getElementById('ql-discard-btn');
  const modeLabel  = document.getElementById('ql-editor-mode');
  if (!editBtn) return;

  if (_editMode) {
    editBtn.style.display    = 'none';
    saveBtn.style.display    = '';
    discardBtn.style.display = '';
    if (modeLabel) modeLabel.textContent = 'Editing';
  } else {
    editBtn.style.display    = '';
    saveBtn.style.display    = 'none';
    discardBtn.style.display = 'none';
    if (modeLabel) modeLabel.textContent = 'Read-only';
  }
  setDirty(_editorDirty);
}

/** Switch the active CodeMirror view between read-only and editable. */
function setEditorReadOnly(readOnly) {
  if (!_cmView) return;
  const cm = _cmModules;
  if (!cm) return;
  _cmView.dispatch({
    effects: cm.EditorState.readOnly.reconfigure(readOnly),
  });
}

// ── Find bar helpers ──────────────────────────────────────────────────────────

let _findBarVisible = false;

function showFindBar() {
  // For CodeMirror text files, delegate to CM's built-in search panel
  if (_cmView && _cmModules) {
    cm_openSearch();
    return;
  }
  // For other content (pre-rendered docs, archive listings)
  const bar = document.getElementById('ql-find-bar');
  if (!bar || _findBarVisible) return;
  _findBarVisible = true;
  bar.classList.add('visible');
  const inp = document.getElementById('ql-find-input');
  if (inp) { inp.value = ''; inp.focus(); }
  document.getElementById('ql-find-count').textContent = '';
  _findHighlights = [];
  _findIdx = -1;
}

function hideFindBar() {
  if (_cmView && _cmModules) {
    _cmModules.closeSearchPanel(_cmView);
    return;
  }
  _findBarVisible = false;
  const bar = document.getElementById('ql-find-bar');
  bar?.classList.remove('visible');
  clearFindHighlights();
}

function cm_openSearch() {
  if (_cmView && _cmModules) {
    _cmModules.openSearchPanel(_cmView);
    // Focus the CM search input (it's inside the editor DOM)
    setTimeout(() => {
      _cmView.dom.querySelector('.cm-search input[name=search]')?.focus();
    }, 30);
  }
}

// Simple DOM text search for non-CM content (pre / archive views)
let _findHighlights = [];
let _findIdx = -1;

function clearFindHighlights() {
  _findHighlights.forEach(m => {
    if (m.parentNode) m.outerHTML = m.dataset.orig ?? m.textContent;
  });
  _findHighlights = [];
  _findIdx = -1;
}

function runFindInPre(query) {
  clearFindHighlights();
  if (!query) { document.getElementById('ql-find-count').textContent = ''; return; }
  const pre = qlBody.querySelector('pre');
  if (!pre) return;

  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, 'gi');
  // Collect text node matches
  const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let n;
  while ((n = walker.nextNode())) nodes.push(n);

  let count = 0;
  for (const node of nodes) {
    const text = node.textContent;
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement('mark');
      mark.className = 'ql-find-match';
      mark.dataset.orig = m[0];
      mark.textContent = m[0];
      frag.appendChild(mark);
      _findHighlights.push(mark);
      count++;
      last = re.lastIndex;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.replaceWith(frag);
  }

  const countEl = document.getElementById('ql-find-count');
  if (countEl) countEl.textContent = count ? `${count} match${count === 1 ? '' : 'es'}` : 'No matches';
  if (_findHighlights.length) scrollToMatch(0);
}

function scrollToMatch(idx) {
  if (!_findHighlights.length) return;
  _findIdx = ((idx % _findHighlights.length) + _findHighlights.length) % _findHighlights.length;
  _findHighlights.forEach((m, i) => m.classList.toggle('ql-find-current', i === _findIdx));
  _findHighlights[_findIdx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const countEl = document.getElementById('ql-find-count');
  if (countEl) countEl.textContent = `${_findIdx + 1} / ${_findHighlights.length}`;
}

// ── DOM refs ─────────────────────────────────────────────────────────────────
const qlName  = document.getElementById('ql-name');
const qlMeta  = document.getElementById('ql-meta');
const qlBody  = document.getElementById('ql-body');
const qlPrev  = document.getElementById('ql-prev');
const qlNext  = document.getElementById('ql-next');
const qlOpen  = document.getElementById('ql-open');
const qlClose = document.getElementById('ql-close');

// Set titlebar as Tauri drag region so dragging it moves the native window
document.getElementById('ql-titlebar').setAttribute('data-tauri-drag-region', '');

// ── Render ───────────────────────────────────────────────────────────────────
async function renderEntry(entry) {
  // Set title bar
  qlName.textContent  = entry.name;
  qlMeta.textContent  = fmtSize(entry.size);
  appWindow.setTitle(entry.name);

  // Update nav buttons
  const hasPrev = _curIdx > 0;
  const hasNext = _curIdx < _navEntries.length - 1;
  qlPrev.classList.toggle('disabled', !hasPrev);
  qlNext.classList.toggle('disabled', !hasNext);
  if (_navEntries.length > 1) {
    qlMeta.textContent = fmtSize(entry.size) + ' · ' + (_curIdx + 1) + '/' + _navEntries.length;
  }

  // Wire open-externally button
  qlOpen.onclick = () => invoke('open_file', { path: entry.path }).catch(() => {});

  // Open With… button — lists installed apps, picks one, opens
  const qlOpenWith = document.getElementById('ql-open-with');
  if(qlOpenWith){
    qlOpenWith.onclick = async () => {
      try{
        const apps = await invoke('list_apps_for_file', {path: entry.path});
        if(!apps || !apps.length){ alert('No applications found for this file type.'); return; }
        // Build a quick picker overlay
        const ow = document.createElement('div');
        ow.style.cssText='position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);';
        ow.innerHTML='<div style="background:#1e1e21;border:1px solid rgba(255,255,255,.13);border-radius:12px;padding:16px;min-width:280px;max-width:360px;max-height:60vh;display:flex;flex-direction:column;gap:8px;box-shadow:0 16px 48px rgba(0,0,0,.75);">' +
          '<div style="font-size:13px;font-weight:600;color:#f1f5f9;margin-bottom:4px;">Open With</div>' +
          apps.slice(0,15).map(a=>'<div class="ql-ow-row" data-exec="'+a.exec.replace(/"/g,'&quot;')+'" style="padding:7px 10px;border-radius:7px;cursor:pointer;font-size:12px;color:#e2e8f0;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);">'+a.name+'</div>').join('') +
          '</div>';
        document.body.appendChild(ow);
        ow.querySelectorAll('.ql-ow-row').forEach(row=>{
          row.addEventListener('mouseenter',()=>row.style.background='rgba(91,141,217,.18)');
          row.addEventListener('mouseleave',()=>row.style.background='rgba(255,255,255,.03)');
          row.addEventListener('click',async()=>{
            ow.remove();
            try{ await invoke('open_with_app',{path:entry.path, exec:row.dataset.exec}); }
            catch(e){ console.error('Open with failed:',e); }
          });
        });
        ow.addEventListener('click',ev=>{ if(ev.target===ow) ow.remove(); });
      }catch(e){ console.error('list_apps_for_file failed:',e); }
    };
  }

  // Build body content
  const ext = entry.name.includes('.')
    ? entry.name.split('.').pop().toLowerCase()
    : '';
  const isImg  = IMAGE_EXTS.includes(ext) && ext !== 'xcf';
  const isXcf  = ext === 'xcf';
  const isVid  = VIDEO_EXTS.includes(ext);
  const isAud  = AUDIO_EXTS.includes(ext);
  const isPdf  = PDF_EXTS.includes(ext);
  const isHtml = HTML_EXTS.includes(ext);
  const isFont = FONT_EXTS.includes(ext);
  const isText  = TEXT_EXTS.includes(ext);
  const isDoc   = DOC_EXTS.includes(ext) || OFFICE_EXTS.includes(ext) || BOOK_EXTS.includes(ext);

  // Ensure media port is loaded before rendering media
  if ((isImg || isVid || isAud || isPdf || isHtml || isFont) && _mediaPort === null) {
    try { _mediaPort = await invoke('get_media_port'); }
    catch { _mediaPort = 0; }
  }

  // Stop any media that was playing for the previous entry before rebuilding the body.
  // qlBody.innerHTML = '' destroys DOM nodes but does NOT pause media; the browser
  // keeps playing detached audio/video elements. Calling stopAllMedia() first ensures
  // the old decoder is flushed before we clear the DOM.
  stopAllMedia();
  destroyCM();
  qlBody.innerHTML = '';

  if (isImg) {
    const img = document.createElement('img');
    const isHeic = ext === 'heic' || ext === 'heif';
    img.src = _mediaPort ? (isHeic ? getHeicJpegUrl(entry.path) : getMediaUrl(entry.path)) : '';
    img.alt = entry.name;
    qlBody.appendChild(img);

  } else if (isVid) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#000;';

    // Fullscreen button — created first so _showMpvFallback can safely re-append it
    const fsBtn = document.createElement('button');
    fsBtn.className = 'ql-fs-btn';
    fsBtn.textContent = '⛶  Full screen';
    fsBtn.title = 'Open fullscreen in mpv (F)';
    fsBtn.addEventListener('click', () => launchMpvFullscreen(entry.path));

    // ── Known WebKit2GTK-incompatible containers → auto-open in mpv ────────
    if (WEBKIT_SKIP_EXTS.has(ext)) {
      wrap.innerHTML = `
        <div style="display:flex;flex-direction:column;align-items:center;gap:14px;color:#94a3b8;font-size:13px;text-align:center;padding:24px;">
          <svg viewBox="0 0 24 24" fill="currentColor" style="width:48px;height:48px;color:#5b8dd9;opacity:.8"><path d="M8 5v14l11-7z"/></svg>
          <div style="color:#e2e8f0;font-size:14px;font-weight:500;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(entry.name)}</div>
          <div style="color:#636368;font-size:12px">Opening in mpv…</div>
        </div>`;
      wrap.appendChild(fsBtn);
      qlBody.appendChild(wrap);
      invoke('mpv_open_external', { path: entry.path, startTime: null, fullscreen: false }).catch(err => {
        const hint = wrap.querySelector('div > div:last-of-type');
        if (hint) hint.textContent = 'mpv failed: ' + err;
      });
      return;
    }

    const _showMpvFallback = (msg) => {
      wrap.innerHTML = `<div style="color:#94a3b8;font-size:13px;text-align:center;padding:24px;line-height:1.6;">
        ${msg}<br>
        <button id="ql-mpv-open" style="margin-top:14px;padding:6px 14px;background:#5b8dd9;border:none;border-radius:7px;color:#fff;cursor:pointer;font-size:12px;">Open with mpv</button>
      </div>`;
      wrap.querySelector('#ql-mpv-open')?.addEventListener('click', () => {
        invoke('mpv_open_external', { path: entry.path, startTime: null, fullscreen: false }).catch(() => {});
      });
      // Re-append fsBtn which got wiped by innerHTML reset
      wrap.appendChild(fsBtn);
    };

    if (_mediaPort) {
      const vid = document.createElement('video');
      vid.controls = true;
      vid.autoplay = true;
      vid.style.cssText = 'max-width:100%;max-height:100%;';
      vid.src = getMediaUrl(entry.path);

      // ── Silent stall detection + ffmpeg transcode fallback ───────────────
      // WebKit2GTK stalls silently at readyState=0 for HEVC/4K MKV.
      // After 5s: switch to ffmpeg transcode proxy (same as main player).
      // After another 20s with transcode still stalled: show mpv fallback.
      let _transcoding = false;
      let _stallTimer = setTimeout(() => {
        if (vid._ff_stopped) return;   // window closed while timer was pending
        if (vid.readyState < 3 && !vid.error && !_transcoding) {
          _transcoding = true;
          vid.src = getTranscodeUrl(entry.path);
          vid.load();
          vid.play().catch(() => {});
          // Show subtle transcoding hint
          const hint = document.createElement('div');
          hint.style.cssText = 'position:absolute;bottom:10px;left:50%;transform:translateX(-50%);color:rgba(255,255,255,.5);font-size:11px;pointer-events:none;white-space:nowrap;background:rgba(0,0,0,.5);padding:3px 8px;border-radius:4px;';
          hint.textContent = '⚡ Transcoding via ffmpeg…';
          wrap.appendChild(hint);
          _stallTimer = setTimeout(() => {
            if (vid._ff_stopped) return;   // window closed while transcoding
            if (vid.readyState < 3) {
              hint.remove();
              _showMpvFallback('Transcoding failed.<br><small>Ensure <code>ffmpeg</code> is installed: <code>sudo pacman -S ffmpeg</code></small>');
            }
          }, 20000);
        }
      }, 5000);
      vid.addEventListener('canplay', () => clearTimeout(_stallTimer), { once: true });
      vid.addEventListener('playing', () => clearTimeout(_stallTimer), { once: true });
      vid.addEventListener('error', () => {
        if (vid._ff_stopped) return;   // src cleared by stopAllMedia — not a real error
        clearTimeout(_stallTimer);
        if (!_transcoding) {
          _transcoding = true;
          vid.src = getTranscodeUrl(entry.path);
          vid.load();
          vid.play().catch(() => {});
          _stallTimer = setTimeout(() => {
            if (vid._ff_stopped) return;   // window closed while error-path transcode was pending
            if (vid.readyState < 3) _showMpvFallback('Codec error — transcoding also failed.<br><small>Install <code>ffmpeg</code>: <code>sudo pacman -S ffmpeg</code></small>');
          }, 20000);
        } else {
          _showMpvFallback('Codec error in WebKit/GStreamer + ffmpeg transcoding failed.<br><small>Try opening with mpv directly.</small>');
        }
      });

      wrap.appendChild(vid);
    } else {
      wrap.innerHTML = `<div style="color:#94a3b8;font-size:13px;text-align:center;padding:24px;">
        Media server unavailable.<br>
        <button id="ql-mpv-open" style="margin-top:12px;padding:6px 14px;background:#5b8dd9;border:none;border-radius:7px;color:#fff;cursor:pointer;font-size:12px;">Open with mpv</button>
      </div>`;
      wrap.querySelector('#ql-mpv-open')?.addEventListener('click', () => {
        invoke('mpv_open_external', { path: entry.path, startTime: null, fullscreen: false }).catch(() => {});
      });
    }
    wrap.appendChild(fsBtn);
    qlBody.appendChild(wrap);

  } else if (isAud) {
    const wrap = document.createElement('div');
    wrap.className = 'ql-audio-wrap';
    const iconSvg = fileIcon(entry).replace('<svg', '<svg style="width:72px;height:72px"');
    wrap.innerHTML = `<span style="font-size:64px;color:${fileColor(entry)}">${iconSvg}</span>
      <div style="font-size:15px;color:#e2e8f0">${escHtml(entry.name)}</div>`;
    if (_mediaPort) {
      const aud = document.createElement('audio');
      aud.controls = true;
      aud.crossOrigin = 'anonymous';
      aud.preload = 'auto';
      aud.autoplay = true;
      aud.style.width = '320px';
      const cvs = document.createElement('canvas');
      cvs.className = 'ql-viz-canvas';
      wrap.appendChild(aud);
      wrap.appendChild(cvs);
      qlBody.appendChild(wrap);
      // Wire graph BEFORE setting src — element is idle, no interruption possible
      startAudioVisualizer(aud, cvs);
      aud.src = getMediaUrl(entry.path); // set src AFTER wiring
      return; // already appended
    }
    qlBody.appendChild(wrap);

  } else if (isPdf) {
    const frame = document.createElement('iframe');
    frame.src   = _mediaPort ? getMediaUrl(entry.path) : '';
    frame.title = 'PDF';
    qlBody.appendChild(frame);

  } else if (isFont) {
    // ── Font preview — live @font-face specimen + Install button ────────────
    const fontUrl  = _mediaPort ? getMediaUrl(entry.path) : '';
    const fontId   = 'ql-font-' + Math.random().toString(36).slice(2);
    const filename = entry.path.split('/').pop();

    // Inject @font-face into the QL window's own document
    const styleEl = document.createElement('style');
    styleEl.textContent = `@font-face{font-family:'${fontId}';src:url('${fontUrl}')}`;
    document.head.appendChild(styleEl);

    const wrap = document.createElement('div');
    wrap.className = 'ql-font-wrap';
    wrap.innerHTML = `
      <div class="ql-font-specimen" style="font-family:'${fontId}',serif">
        <div class="qlf-display">Aa Bb Cc</div>
        <div class="qlf-alpha">ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz</div>
        <div class="qlf-nums">0123456789 !@#$%&amp;*()-+=[]{}|;:',./&lt;&gt;?</div>
        <div class="qlf-sentence">The quick brown fox jumps over the lazy dog.</div>
        <div class="qlf-sentence qlf-sm">Pack my box with five dozen liquor jugs.</div>
      </div>
      <div class="ql-font-actions">
        <button id="ql-font-install" class="ql-font-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:13px;height:13px;flex-shrink:0"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Install Font
        </button>
        <div id="ql-font-status" class="ql-font-status"></div>
        <div id="ql-font-progwrap" class="ql-font-progwrap" style="display:none">
          <div id="ql-font-progbar" class="ql-font-progbar"></div>
        </div>
      </div>`;
    qlBody.appendChild(wrap);

    // Check if already installed
    invoke('is_font_installed', {filename}).then(installed => {
      const btn = document.getElementById('ql-font-install');
      if (!btn) return;
      if (installed) {
        btn.disabled = true;
        btn.textContent = '✓ Already Installed';
        btn.classList.add('ql-font-installed');
      }
    }).catch(() => {});

    document.getElementById('ql-font-install')?.addEventListener('click', async () => {
      const btn = document.getElementById('ql-font-install');
      const statusEl = document.getElementById('ql-font-status');
      const progWrap = document.getElementById('ql-font-progwrap');
      const progBar  = document.getElementById('ql-font-progbar');
      if (!btn || btn.disabled) return;
      btn.disabled = true;
      if (statusEl) statusEl.textContent = 'Installing…';
      if (progWrap) progWrap.style.display = '';
      if (progBar)  {
        progBar.style.transition = 'none'; progBar.style.width = '0%';
        requestAnimationFrame(() => {
          progBar.style.transition = 'width 1.2s ease'; progBar.style.width = '85%';
        });
      }
      try {
        await invoke('install_font', {path: entry.path});
        if (progBar) { progBar.style.transition = 'width .2s ease'; progBar.style.width = '100%'; progBar.classList.add('green'); }
        if (statusEl) { statusEl.textContent = '✓ Installed'; statusEl.style.color = '#34d399'; }
        if (btn) { btn.textContent = '✓ Installed'; btn.classList.add('ql-font-installed'); }
        setTimeout(() => { if (progWrap) progWrap.style.display = 'none'; }, 1200);
      } catch(err) {
        if (progBar) { progBar.style.width = '100%'; progBar.classList.add('red'); }
        if (statusEl) { statusEl.textContent = String(err); statusEl.style.color = '#f87171'; }
        btn.disabled = false;
        setTimeout(() => { if (progWrap) progWrap.style.display = 'none'; if (progBar) progBar.classList.remove('red'); }, 3000);
      }
    });

  } else if (isHtml) {
    // ── HTML file — sandboxed iframe via media port ─────────────────────────
    const frame = document.createElement('iframe');
    frame.src        = _mediaPort ? getMediaUrl(entry.path) : '';
    frame.title      = 'HTML Preview';
    frame.sandbox    = 'allow-scripts allow-same-origin';
    frame.className  = 'ql-html-frame';
    qlBody.appendChild(frame);

  } else if (isXcf) {
    // ── XCF (GIMP) — not renderable in browser ──────────────────────────────
    const wrap = document.createElement('div');
    wrap.className = 'ql-unknown';
    const iconSvg = fileIcon(entry).replace('<svg', '<svg style="width:64px;height:64px"');
    wrap.innerHTML = `<span style="color:${fileColor(entry)}">${iconSvg}</span>
      <div style="font-size:14px;color:#e2e8f0">${escHtml(entry.name)}</div>
      <div style="font-size:12px;color:#94a3b8;margin-top:4px">GIMP Image</div>
      <div style="font-size:11px;color:#636368;margin-top:2px">XCF files cannot be rendered inline.<br>Open in GIMP to view or edit.</div>
      <div style="font-size:12px;color:#636368;margin-top:6px">${fmtSize(entry.size)}</div>`;
    qlBody.appendChild(wrap);

  } else if (TEXT_EXTS.includes(ext) || entry.name.toLowerCase() === 'makefile' || entry.name.toLowerCase() === 'dockerfile' || entry.name.startsWith('.')) {
    // ── Inline editor for text / code files ──────────────────────────────
    qlBody.innerHTML = '<span class="ql-loading">Loading…</span>';
    invoke('read_text_file', { path: entry.path })
      .then(rawContent => renderTextEditor(entry, rawContent))
      .catch(err => {
        // Oversized file or binary — fall back to get_file_preview text extract
        invoke('get_file_preview', { path: entry.path }).then(pd => {
          qlBody.innerHTML = '';
          destroyCM();
          if (pd?.content != null) {
            const pre = document.createElement('pre');
            pre.className = 'ql-pre-readonly';
            pre.textContent = pd.content;
            const note = document.createElement('div');
            note.className = 'ql-size-note';
            note.textContent = String(err);
            qlBody.prepend(note);
            qlBody.appendChild(pre);
          } else {
            renderUnknown(entry);
          }
        }).catch(() => renderUnknown(entry));
      });

  } else if (OFFICE_EXTS.includes(ext)) {
    // ── r31 P4.1: Office preview — PDF via LibreOffice or text extraction ────
    qlBody.innerHTML = '<span class="ql-loading">Loading…</span>';
    invoke('get_office_preview', { path: entry.path }).then(result => {
      qlBody.innerHTML = '';
      if (result?.mode === 'pdf') {
        // LibreOffice converted it — show via PDF viewer (media port)
        const iframe = document.createElement('iframe');
        iframe.src   = _mediaPort ? `http://localhost:${_mediaPort}/file?path=${encodeURIComponent(result.pdf_path)}` : '';
        iframe.title = 'Office Preview';
        iframe.className = 'ql-pdf';
        qlBody.appendChild(iframe);
      } else if (result?.mode === 'text') {
        const pre = document.createElement('pre');
        pre.className = 'ql-pre-readonly';
        pre.textContent = result.content;
        qlBody.appendChild(pre);
      } else {
        // install_nudge — LibreOffice not found
        const wrap = document.createElement('div');
        wrap.className = 'ql-unknown';
        const iconSvg = fileIcon(entry).replace('<svg', '<svg style="width:64px;height:64px"');
        wrap.innerHTML = `<span style="color:${fileColor(entry)}">${iconSvg}</span>
          <div style="font-size:14px;color:#e2e8f0;margin-top:12px">${escHtml(entry.name)}</div>
          <div style="font-size:12px;color:#94a3b8;margin-top:6px">Install LibreOffice for rich previews</div>
          <div style="font-size:11px;color:#636368;margin-top:2px">sudo apt install libreoffice  ·  sudo pacman -S libreoffice</div>`;
        qlBody.appendChild(wrap);
      }
    }).catch(() => renderUnknown(entry));

  } else if (DOC_EXTS.includes(ext) && !TEXT_EXTS.includes(ext)) {
    // ── Office/book document — text extraction via Rust ───────────────────
    qlBody.innerHTML = '<span class="ql-loading">Loading…</span>';
    invoke('get_file_preview', { path: entry.path }).then(pd => {
      qlBody.innerHTML = '';
      destroyCM();
      if (pd?.content != null) {
        const pre = document.createElement('pre');
        pre.className = 'ql-pre-readonly';
        pre.textContent = pd.content;
        qlBody.appendChild(pre);
      } else {
        renderUnknown(entry);
      }
    }).catch(() => renderUnknown(entry));

  } else {
    renderUnknown(entry);
  }
}

function renderUnknown(entry) {
  qlBody.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'ql-unknown';
  const iconSvg = fileIcon(entry).replace('<svg', '<svg style="width:64px;height:64px"');
  wrap.innerHTML = `<span style="font-size:64px;color:${fileColor(entry)}">${iconSvg}</span>
    <div style="font-size:14px;color:#94a3b8">${escHtml(entry.name)}</div>
    <div style="font-size:12px;color:#636368">${fmtSize(entry.size)}</div>`;
  qlBody.appendChild(wrap);
}

// ── mpv fullscreen launch ─────────────────────────────────────────────────────
let _fsActive = false; // guard against double-invocation (button + intercepted requestFullscreen)

function launchMpvFullscreen(path) {
  if (_fsActive) return;
  _fsActive = true;
  const vid = qlBody.querySelector('video');
  const t   = vid ? vid.currentTime : 0;
  if (vid) vid.pause();

  appWindow.minimize();

  invoke('mpv_open_external', { path, startTime: t, fullscreen: true })
    .then(() => {
      const poll = setInterval(async () => {
        try {
          const running = await invoke('mpv_is_running');
          if (!running) {
            clearInterval(poll);
            _fsActive = false;
            appWindow.unminimize();
            appWindow.setFocus();
            if (vid && vid.isConnected) vid.play().catch(() => {});
          }
        } catch { clearInterval(poll); _fsActive = false; appWindow.unminimize(); }
      }, 500);
    })
    .catch(err => {
      _fsActive = false;
      appWindow.unminimize();
      if (vid && vid.isConnected) vid.play().catch(() => {});
      console.error('mpv failed:', err);
    });
}

// ── Editor bar button wiring ─────────────────────────────────────────────────

document.getElementById('ql-edit-btn')?.addEventListener('click', () => {
  if (!_cmView) return;
  _editMode = true;
  setEditorReadOnly(false);
  updateEditorBarMode();
  _cmView.focus();
});

document.getElementById('ql-save-btn')?.addEventListener('click', async () => {
  if (!_cmView || !_currentEntry || !_editorDirty) return;
  const content = _cmView.state.doc.toString();
  const saveBtn = document.getElementById('ql-save-btn');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
  try {
    await invoke('write_text_file', { path: _currentEntry.path, content });
    // Push undo entry to the main window so Ctrl+Z can revert the save
    emit('ql-file-saved', { path: _currentEntry.path }).catch(() => {});
    _draftClear(_currentEntry.path);
    clearTimeout(_draftTimer);
    setDirty(false);
    const modeLabel = document.getElementById('ql-editor-mode');
    if (modeLabel) { modeLabel.textContent = 'Saved ✓'; setTimeout(() => { if (modeLabel) modeLabel.textContent = 'Editing'; }, 1500); }
  } catch (err) {
    alert('Save failed: ' + err);
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  }
});

document.getElementById('ql-discard-btn')?.addEventListener('click', () => {
  if (!_currentEntry) return;
  if (_editorDirty && !confirm('Discard unsaved changes?')) return;
  _draftClear(_currentEntry.path);
  clearTimeout(_draftTimer);
  _editMode = false;
  // Reload original content from disk
  invoke('read_text_file', { path: _currentEntry.path })
    .then(raw => renderTextEditor(_currentEntry, raw))
    .catch(() => {});
});

// ── Navigation ────────────────────────────────────────────────────────────────
function guardDirty() {
  if (_editorDirty) return confirm('You have unsaved changes. Leave anyway?');
  return true;
}

qlPrev.addEventListener('click', () => {
  if (_curIdx > 0 && guardDirty()) {
    _curIdx--;
    renderEntry(_navEntries[_curIdx]);
    emit('ql-nav', { idx: _curIdx }).catch(() => {});
  }
});
qlNext.addEventListener('click', () => {
  if (_curIdx < _navEntries.length - 1 && guardDirty()) {
    _curIdx++;
    renderEntry(_navEntries[_curIdx]);
    emit('ql-nav', { idx: _curIdx }).catch(() => {});
  }
});

// ── Media teardown helper ─────────────────────────────────────────────────────
// Stops all audio/video elements currently in the QL body.
// Called before hiding the window AND before rendering a new entry, so audio
// never leaks into hidden-window playback.
function stopAllMedia() {
  qlBody.querySelectorAll('audio, video').forEach(el => {
    try {
      el._ff_stopped = true;   // ← guard: tells all error/stall handlers to bail out
      el.pause();
      el.src = '';
      el.load();               // flush decoder buffers immediately
    } catch (_) { /* ignore */ }
  });
  if (_vizAnimId) { cancelAnimationFrame(_vizAnimId); _vizAnimId = null; }
}

// ── Close ─────────────────────────────────────────────────────────────────────
function closeWindow() {
  if (_editorDirty && !confirm('You have unsaved changes. Close anyway?')) return;
  if (_currentEntry) { _draftClear(_currentEntry.path); clearTimeout(_draftTimer); }
  stopAllMedia();
  destroyCM();
  emit('ql-closed', {}).catch(() => {});
  appWindow.hide().catch(() => {});  // hide, not close — keep process warm for next Space press
}
qlClose.addEventListener('click', closeWindow);
document.addEventListener('keydown', e => {
  // While the editor is in edit mode, let CodeMirror handle most keys naturally.
  // Only intercept Escape (to exit edit mode or close) and Ctrl+F (find).
  const inEditor = _editMode && _cmView;

  if (e.key === 'Escape') {
    e.preventDefault();
    if (_findBarVisible) { hideFindBar(); return; }
    // If CM search panel is open, close it instead of the window
    if (_cmView && _cmModules) {
      const panel = _cmView.dom.querySelector('.cm-search');
      if (panel) { _cmModules.closeSearchPanel(_cmView); return; }
    }
    if (_editMode) {
      // Exit edit mode (prompt if dirty)
      if (_editorDirty && !confirm('Discard unsaved changes?')) return;
      _editMode = false;
      setEditorReadOnly(true);
      setDirty(false);
      updateEditorBarMode();
      return;
    }
    closeWindow();
    return;
  }

  // Ctrl+F / Cmd+F — open find bar or CM search
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault();
    showFindBar();
    return;
  }

  // Ctrl+S — save from anywhere while in edit mode
  if ((e.ctrlKey || e.metaKey) && e.key === 's' && _editMode) {
    e.preventDefault();
    document.getElementById('ql-save-btn')?.click();
    return;
  }

  // Block Space and arrows from navigating while editor is focused
  if (inEditor) return;

  if (e.key === ' ') {
    // Space dismisses the QL window (stopAllMedia inside closeWindow handles pausing).
    e.preventDefault();
    closeWindow();
    return;
  }
  if (e.key === 'ArrowLeft')  { qlPrev.click(); }
  if (e.key === 'ArrowRight') { qlNext.click(); }
  if (e.key === 'f' || e.key === 'F') {
    const entry = _navEntries[_curIdx];
    const ext = entry?.name.split('.').pop().toLowerCase();
    if (entry && VIDEO_EXTS.includes(ext)) launchMpvFullscreen(entry.path);
  }
});

// ── Find bar (for non-CM content) DOM event wiring ───────────────────────────
document.getElementById('ql-find-input')?.addEventListener('input', e => {
  runFindInPre(e.target.value.trim());
});
document.getElementById('ql-find-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    scrollToMatch(e.shiftKey ? _findIdx - 1 : _findIdx + 1);
  }
  if (e.key === 'Escape') { e.preventDefault(); hideFindBar(); }
});
document.getElementById('ql-find-bar-btn')?.addEventListener('click', () => showFindBar());
document.getElementById('ql-find-prev')?.addEventListener('click', () => scrollToMatch(_findIdx - 1));
document.getElementById('ql-find-next')?.addEventListener('click', () => scrollToMatch(_findIdx + 1));
document.getElementById('ql-find-close')?.addEventListener('click', hideFindBar);

// ── Bootstrap ────────────────────────────────────────────────────────────────
// Initial data is loaded by calling get_ql_payload() — the main window stored
// it Rust-side via set_ql_payload() before creating this window. No events,
// no timing races, no "Loading…" forever.
//
// Navigation updates after load come via the ql-update event (safe: by the
// time the user presses an arrow key, this window is fully initialised).
async function init() {
  // Pull initial payload from Rust store (set by main window before we opened)
  const raw = await invoke('get_ql_payload');
  if (raw) {
    try {
      const { entries, curIdx } = JSON.parse(raw);
      _navEntries = entries || [];
      _curIdx     = (curIdx >= 0 && curIdx < _navEntries.length) ? curIdx : 0;
      if (_navEntries.length > 0) renderEntry(_navEntries[_curIdx]);
    } catch(e) {
      console.error('QL: failed to parse payload', e);
    }
  }

  // Register ql-update listener BEFORE emitting ql-ready.
  // Main's ql-ready handler may fire ql-update immediately (to flush a pending
  // payload that arrived during pre-warm); if we haven't listened yet, we miss it.
  await listen('ql-update', async () => {
    const raw2 = await invoke('get_ql_payload');
    if (!raw2) return;
    try {
      const { entries, curIdx } = JSON.parse(raw2);
      _navEntries = entries || [];
      _curIdx     = (curIdx >= 0 && curIdx < _navEntries.length) ? curIdx : 0;
      if (_navEntries.length > 0) renderEntry(_navEntries[_curIdx]);
    } catch(e) { console.error('QL update parse error', e); }
  });

  // Tell main window we're warm and ready.
  // This must come AFTER listen('ql-update') is registered (see above).
  await emit('ql-ready', {}).catch(() => {});
}

init().catch(console.error);
