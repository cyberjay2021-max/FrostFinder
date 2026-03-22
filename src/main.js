import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow as _getAppWindow } from '@tauri-apps/api/window';
let appWindow; // initialised inside init() after Tauri IPC is ready
import { listen } from '@tauri-apps/api/event';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import {
  I, IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS, DOC_EXTS, OFFICE_EXTS, BOOK_EXTS, PDF_EXTS, ARCHIVE_EXTS, ISO_EXTS,
  fileColor, fileIcon, driveIcon, driveColor, favIcon, favColor, fmtDriveSpace,
  fmtSize, fmtDate, fmtDateAbsolute, escHtml, mimeLabel,
  setRenderCallback, setIconTheme, loadDiskTheme, showIconThemePicker,
  getCurrentThemeName, isUsingDiskTheme, getCurrentThemePath,
  setDateLocale, driveTypeBadge,
  getBookmarks, addBookmark, removeBookmark, isBookmarked
} from './utils.js';
import {
  injectDeps, renderView, renderColumnView, renderListView, renderIconView,
  renderGalleryView, renderFlatList, renderPreview, renderStatus,
  startAudioVisualizer, openQuickLook, isQLOpen, closeQuickLook, initQuickLook,
  announceA11y
} from './views.js';

// ── Sidebar operation progress bar ──────────────────────────────────────────────
// r103: Job queue — shows up to 3 concurrent ops, each with cancel button.
// Legacy _sbProgress.start/update/finish/error API still works unchanged;
// it routes to a single auto-named job so all existing callers need no changes.
//
// New named-job API (for future callers):
//   const id = _sbProgress.addJob(label, total, cancelFn?)
//   _sbProgress.updateJob(id, done, total, label?)
//   _sbProgress.finishJob(id, success, msg?)
const _sbProgress = (() => {
  let _jobs = [];   // [{id, label, pct, state:'running'|'done'|'error'|'gone', cancelFn}]
  let _idSeq = 0;
  let _renderTimer = null;

  function _getContainer() { return document.getElementById('sb-ops-progress'); }

  function _scheduleRender() {
    if (_renderTimer) return;
    _renderTimer = requestAnimationFrame(() => { _renderTimer = null; _renderQueue(); });
  }

  function _esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  function _renderQueue() {
    const container = _getContainer();
    if (!container) return;
    const visible = _jobs.filter(j => j.state !== 'gone');
    if (!visible.length) {
      container.classList.remove('visible');
      setTimeout(() => { if (container) container.style.display = 'none'; }, 220);
      return;
    }
    container.style.display = '';
    requestAnimationFrame(() => container.classList.add('visible'));

    // Show up to 3 most-recent active/finishing jobs
    const shown = visible.slice(-3);
    container.innerHTML = shown.map(j => {
      const barClass = j.state === 'done' ? 'green' : j.state === 'error' ? 'red' : '';
      const pct = j.pct ?? 0;
      const cancelBtn = (j.cancelFn && j.state === 'running')
        ? `<button class="sb-job-cancel" data-job="${j.id}" title="Cancel" style="margin-left:6px;background:none;border:none;color:#9c9a92;cursor:pointer;font-size:13px;padding:0 3px;line-height:1;">✕</button>`
        : '';
      return `<div class="sb-job-row" data-job="${j.id}">
        <div class="sb-ops-row">
          <span class="sb-ops-label" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(j.label)}</span>
          <span class="sb-ops-pct">${pct}%</span>${cancelBtn}
        </div>
        <div class="sb-ops-track"><div class="sb-ops-bar ${barClass}" style="width:${pct}%"></div></div>
      </div>`;
    }).join('');

    container.querySelectorAll('.sb-job-cancel').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const job = _jobs.find(j => j.id === +btn.dataset.job);
        if (job && job.cancelFn) { job.cancelFn(); }
        if (job) { job.state = 'error'; job.label = 'Cancelled'; _scheduleRender(); _autoGone(job, 1800); }
      });
    });
  }

  function _autoGone(job, delay) {
    setTimeout(() => {
      job.state = 'gone';
      if (!_jobs.some(j => j.state === 'running')) {
        const c = _getContainer();
        if (c) { c.classList.remove('visible'); setTimeout(() => { if(c) c.style.display='none'; }, 220); }
      }
      if (_jobs.filter(j => j.state === 'gone').length > 8)
        _jobs = _jobs.filter(j => j.state !== 'gone');
      _scheduleRender();
    }, delay);
  }

  // ── Named job API ──────────────────────────────────────────────────────────
  function addJob(label, total = 0, cancelFn = null) {
    const id = ++_idSeq;
    _jobs.push({ id, label, total, pct: 0, state: 'running', cancelFn });
    _scheduleRender();
    return id;
  }
  function updateJob(id, done, total, label) {
    const job = _jobs.find(j => j.id === id); if (!job) return;
    job.pct = total > 0 ? Math.round((done / total) * 100) : 0;
    if (total) job.total = total;
    if (label) job.label = label;
    _scheduleRender();
  }
  function finishJob(id, success = true, msg = '') {
    const job = _jobs.find(j => j.id === id); if (!job) return;
    job.pct = 100; job.state = success ? 'done' : 'error';
    if (msg) job.label = msg;
    _scheduleRender();
    _autoGone(job, success ? 1400 : 2800);
  }

  // ── Legacy single-job API ──────────────────────────────────────────────────
  let _defId = null;
  return {
    addJob, updateJob, finishJob,
    start(label, total) {
      if (_defId !== null) finishJob(_defId, true);
      _defId = addJob(label, total);
    },
    update(done, total, label) {
      if (_defId === null) _defId = addJob(label || 'Working…', total);
      updateJob(_defId, done, total, label);
    },
    finish(success = true, msg = '') {
      if (_defId === null) return;
      finishJob(_defId, success, msg); _defId = null;
    },
    error(msg) {
      if (_defId !== null) { finishJob(_defId, false, msg); _defId = null; }
      else { const id = addJob(msg, 0); finishJob(id, false, msg); }
    },
  };
})();



// ══════════════════════════════════════════════════════════════════════════════
// FF — FrostFinder Debug Logger
// Usage: FF.log('EVENT_NAME', {key: value})
// Open overlay: FF.show() / Close: FF.hide()
// Download log: FF.download()
// Auto-opens if URL has ?debug or localStorage has ff_debug=1
// ══════════════════════════════════════════════════════════════════════════════
const FF = (() => {
  const MAX = 2000;          // max log entries kept in memory
  const entries = [];
  let _panel = null, _list = null, _paused = false, _filter = '';
  let _startTime = Date.now();

  // ── Core logger// ─────────────────────────────────────────────────────────────
  function log(event, data={}) {
    const ts = Date.now() - _startTime;
    const entry = { ts, event, data };
    entries.push(entry);
    if (entries.length > MAX) entries.shift();

    // Console always
    const tag = `[FF +${(ts/1000).toFixed(3)}s]`;
    const style = eventStyle(event);
    console.log(`%c${tag} ${event}%c`, style, 'color:inherit', data);

    // Panel live update
    if (_panel && !_paused) _appendRow(entry);
  }

  function eventStyle(e) {
    if (e.startsWith('NAV_')) return 'color:#4af;font-weight:bold';
    if (e.startsWith('CLICK_')) return 'color:#fa4;font-weight:bold';
    if (e.startsWith('IPC_')) return 'color:#a4f;font-weight:bold';
    if (e.startsWith('RENDER_')) return 'color:#4fa;font-weight:bold';
    if (e.includes('ERROR') || e.includes('FAIL')) return 'color:#f44;font-weight:bold';
    if (e.includes('WARN')) return 'color:#fa0';
    return 'color:#aaa';
  }

  function eventColor(e) {
    if (e.startsWith('NAV_')) return '#4af';
    if (e.startsWith('CLICK_')) return '#fa4';
    if (e.startsWith('IPC_')) return '#a4f';
    if (e.startsWith('RENDER_')) return '#4fa';
    if (e.includes('ERROR') || e.includes('FAIL')) return '#f44';
    if (e.includes('WARN')) return '#fa0';
    return '#888';
  }

  // ── Panel UI ─────────────────────────────────────────────────────────────────
  function buildPanel() {
    if (_panel) return;
    _panel = document.createElement('div');
    _panel.id = 'ff-log-panel';
    _panel.style.cssText = `
      position:fixed; bottom:0; right:0; width:520px; height:320px;
      background:#111; color:#ddd; font:11px/1.4 monospace;
      border-top:2px solid #333; border-left:2px solid #333;
      z-index:99999; display:flex; flex-direction:column;
      box-shadow:-4px -4px 20px rgba(0,0,0,0.6);
      resize:both; overflow:hidden;
    `;

    // Header
    const hdr = document.createElement('div');
    hdr.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 8px;background:#1a1a1a;border-bottom:1px solid #333;flex-shrink:0';
    hdr.innerHTML ='\n      <span style="color:#4af;font-weight:bold;font-size:12px">FF Log</span>\n      <input id="ff-filter" placeholder="filter events..." style="flex:1;background:#222;border:1px solid #444;color:#ddd;padding:2px 6px;font:11px monospace;border-radius:3px"/>\n      <button id="ff-pause" style="background:#2a2a2a;border:1px solid #444;color:#ddd;padding:2px 8px;cursor:pointer;border-radius:3px;font:11px monospace">⏸</button>\n      <button id="ff-clear" style="background:#2a2a2a;border:1px solid #444;color:#ddd;padding:2px 8px;cursor:pointer;border-radius:3px;font:11px monospace">🗑</button>\n      <button id="ff-dl" style="background:#2a2a2a;border:1px solid #444;color:#ddd;padding:2px 8px;cursor:pointer;border-radius:3px;font:11px monospace">💾</button>\n      <button id="ff-errors" style="background:#2a2a2a;border:1px solid #f83;color:#f83;padding:2px 8px;cursor:pointer;border-radius:3px;font:11px monospace" title="Error log">⚠</button>\
      <button id="ff-copy-report" style="background:#2a2a2a;border:1px solid #444;color:#ddd;padding:2px 8px;cursor:pointer;border-radius:3px;font:11px monospace" title="Copy report to clipboard">📋</button>\
      <button id="ff-close" style="background:#2a2a2a;border:1px solid #444;color:#f44;padding:2px 8px;cursor:pointer;border-radius:3px;font:11px monospace">✕</button>\n    ';
    _panel.appendChild(hdr);

    // Log list
    _list = document.createElement('div');
    _list.style.cssText = 'flex:1;overflow-y:auto;padding:4px 0;';
    _panel.appendChild(_list);

    // Status bar
    const sb = document.createElement('div');
    sb.id = 'ff-sb';
    sb.style.cssText = 'padding:2px 8px;background:#1a1a1a;border-top:1px solid #333;color:#666;font-size:10px;flex-shrink:0';
    sb.textContent = 'FrostFinder Debug Logger · Ctrl+Shift+L to toggle';
    _panel.appendChild(sb);

    document.body.appendChild(_panel);

    // Wire controls
    document.getElementById('ff-close').onclick = () => hide();
    document.getElementById('ff-clear').onclick = () => { entries.length=0; _list.innerHTML=''; };
    document.getElementById('ff-pause').onclick = (e) => {
      _paused = !_paused;
      e.target.textContent = _paused ? '▶' : '⏸';
      if (!_paused) _rebuildList();
    };
    document.getElementById('ff-dl').onclick = () => download();
    document.getElementById('ff-filter').oninput = (e) => {
      _filter = e.target.value.toLowerCase();
      _rebuildList();
    };

    // Hotkey
    document.addEventListener('keydown', e => {
      if (e.ctrlKey && e.shiftKey && e.key === 'L') { e.preventDefault(); toggle(); }
    });

    // Populate existing entries
    _rebuildList();
  }

  function _appendRow(entry) {
    if (!_list) return;
    if (_filter && !entry.event.toLowerCase().includes(_filter) &&
        !JSON.stringify(entry.data).toLowerCase().includes(_filter)) return;

    const row = document.createElement('div');
    row.style.cssText = `padding:1px 8px;border-bottom:1px solid #1a1a1a;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;
    row.innerHTML ='<span style="color:#555">+' + ((entry.ts/1000).toFixed(3)) + 's</span> ' +
      `<span style="color:${eventColor(entry.event)};font-weight:bold">${entry.event}</span> ` +
      `<span style="color:#999">${_fmtData(entry.data)}</span>`;
    row.title = JSON.stringify(entry.data, null, 2);
    _list.appendChild(row);
    // Auto-scroll to bottom
    _list.scrollTop = _list.scrollHeight;

    // Update status bar
    const sb = document.getElementById('ff-sb');
    if (sb) sb.textContent = `${entries.length} events · +${(entry.ts/1000).toFixed(2)}s · Ctrl+Shift+L to toggle`;
  }

  function _rebuildList() {
    if (!_list) return;
    _list.innerHTML = '';
    const filtered = _filter
      ? entries.filter(e => e.event.toLowerCase().includes(_filter) ||
          JSON.stringify(e.data).toLowerCase().includes(_filter))
      : entries;
    filtered.forEach(e => _appendRow(e));
  }

  function _fmtData(d) {
    if (!d || Object.keys(d).length === 0) return '';
    return Object.entries(d).map(([k,v]) => {
      if (typeof v === 'string' && v.length > 50) v = v.slice(0,47)+'...';
      return `${k}=${JSON.stringify(v)}`;
    }).join(' ');
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  function show() {
    if (!_panel) buildPanel();
    _panel.style.display = 'flex';
    localStorage.setItem('ff_debug', '1');
  }

  function hide() {
    if (_panel) _panel.style.display = 'none';
    localStorage.removeItem('ff_debug');
  }

  function toggle() {
    if (!_panel || _panel.style.display === 'none') show();
    else hide();
  }

  async function download() {
    const lines = entries.map(e =>
      `[+${(e.ts/1000).toFixed(3)}s] ${e.event} ${JSON.stringify(e.data)}`
    );
    lines.unshift(`FrostFinder Debug Log — ${new Date().toISOString()}`);
    lines.unshift(`FrostFinder Beta Build — Session start: ${new Date(_startTime).toISOString()}`);
    const text = lines.join('\n');
    try {
      const filePath = await saveDialog({
        defaultPath: `frostfinder-debug-${Date.now()}.log`,
        filters: [
          { name: 'Log files', extensions: ['log'] },
          { name: 'Text files', extensions: ['txt'] },
          { name: 'All files',  extensions: ['*']   }
        ]
      });
      if (filePath) await writeTextFile(filePath, text);
    } catch (err) {
      console.error('FF log save failed:', err);
    }
  }

  // Auto-open if debug flag set
  window.addEventListener('DOMContentLoaded', () => {
    if (new URLSearchParams(location.search).has('debug') ||
        localStorage.getItem('ff_debug') === '1') {
      setTimeout(show, 500);
    }
  });


  // ── Errors tab ──────────────────────────────────────────────────────────────
  function _showErrorsTab() {
    if (!_panel) buildPanel();
    show();
    // Replace log list with error log content from Rust
    if (!_list) return;
    _list.innerHTML = '<div style="padding:6px 8px;color:#f83;font-size:11px">Loading error log…</div>';
    // _errorRing is defined in the outer scope after FF object
    setTimeout(() => {
      const ring = window._errorRing || [];
      if (!ring.length) {
        _list.innerHTML = '<div style="padding:8px;color:#888">No errors recorded this session.</div>';
        return;
      }
      _list.innerHTML = ring.slice().reverse().map(line =>
        `<div style="padding:2px 8px;border-bottom:1px solid #1a1a1a;color:#f83;font-size:10px;font-family:monospace;white-space:pre-wrap;word-break:break-all">${escHtml ? escHtml(line) : line.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</div>`
      ).join('');
    }, 0);
  }

  function _copyErrorReport() {
    const ring = window._errorRing || [];
    const version = document.title || 'FrostFinder';
    const ua = navigator.userAgent || '';
    const lines = [
      `FrostFinder error report`,
      `Date: ${new Date().toISOString()}`,
      `Version: ${version}`,
      `UA: ${ua}`,
      `Errors (${ring.length}):`,
      ...ring,
    ];
    const text = lines.join('\n');
    navigator.clipboard?.writeText(text)
      .then(() => { if (typeof showToast === 'function') showToast(t('toast.error_report_copied'),'success'); })
      .catch(() => { if (typeof showToast === 'function') showToast(t('toast.clipboard_unavailable'),'error'); });
  }

  return { log, show, hide, toggle, download, showErrors: _showErrorsTab, copyReport: _copyErrorReport };
})();

window.FF = FF; // expose to console: FF.show(), FF.download()


// ── Centralised error capture ─────────────────────────────────────────────────
// logError(msg, context) should be called from EVERY catch block instead of
// bare showToast. It:
//   1. logs to FF.log (visible in the debug panel)
//   2. appends to the persistent ~/.local/share/frostfinder/error.log via Rust
//   3. keeps an in-memory ring buffer for the copy-to-clipboard report button
const _errorRing = [];
window._errorRing = _errorRing;   // exposed so FF panel can read it
const _ERROR_RING_MAX = 200;

function logError(msg, context = '') {
  const ts = new Date().toISOString();
  const line = `${ts}  ${context ? '[' + context + '] ' : ''}${msg}`;

  // In-memory ring (for copy-report)
  _errorRing.push(line);
  if (_errorRing.length > _ERROR_RING_MAX) _errorRing.shift();

  // FF debug log panel
  FF.log('ERROR', { msg, context });

  // Persistent file (fire-and-forget — never block UI on a log write)
  invoke('append_error_log', { message: line }).catch(() => {});
}

// Patched showToast: 'error' type automatically goes through logError
function showToast(msg, type = 'info', context = '') {
  if (type === 'error') logError(msg, context);
  _origShowToast(msg, type);
  // Announce to screen reader live region so toasts aren't only visual
  if (typeof announceA11y === 'function') announceA11y(msg);
}



// ── Web Worker (search/sort off main thread) ──────────────────────────────────
const _worker = new Worker(new URL('./search.worker.js', import.meta.url), { type: 'module' });
let _workerReqId = 0;
const _workerPending = new Map();
_worker.onmessage = e => {
  const cb = _workerPending.get(e.data.id);
  if (cb) { _workerPending.delete(e.data.id); cb(e.data.results); }
};
function workerRequest(type, payload) {
  return new Promise(resolve => {
    const id = ++_workerReqId;
    _workerPending.set(id, resolve);
    _worker.postMessage({ id, type, payload });
  });
}

// ── RAF-batched render (never paint more than once per frame) ─────────────────
let _rafPending = false;
function scheduleRender() {
  if (_rafPending) return;
  _rafPending = true;
  requestAnimationFrame(() => {
    _rafPending = false;
    _doRender();
  });
}

// ── Media server URL builder ──────────────────────────────────────────────────
let _mediaPort=0;
async function initMediaPort(){ _mediaPort=await invoke('get_media_port'); }
function getMediaUrl(path){
  const encoded=encodeURIComponent(path).replace(/%2F/gi,'/');
  return 'http://127.0.0.1:'+_mediaPort+'/'+(encoded.startsWith('/')?encoded.slice(1):encoded);
}
function getTranscodeUrl(path){
  // Routes through the /transcode/ endpoint — ffmpeg VAAPI→H.264 proxy
  const encoded=encodeURIComponent(path).replace(/%2F/gi,'/');
  const p=encoded.startsWith('/')?encoded.slice(1):encoded;
  return 'http://127.0.0.1:'+_mediaPort+'/transcode/'+p;
}
function getHeicJpegUrl(path){
  // Routes through the /heic-jpeg/ endpoint — ffmpeg HEIC→JPEG proxy.
  // Used for any HEIC/HEIF file displayed as an <img> in preview or gallery,
  // since WebKit2GTK cannot decode HEIC natively on most Linux systems and the
  // `image` crate used for thumbnails has no HEIC decoder either.
  const encoded=encodeURIComponent(path).replace(/%2F/gi,'/');
  const p=encoded.startsWith('/')?encoded.slice(1):encoded;
  return 'http://127.0.0.1:'+_mediaPort+'/heic-jpeg/'+p;
}
// ── Tab system ────────────────────────────────────────────────────────────────
function makeTabState(path=''){
  return {
    columns:[],activeSb:null,showHidden:false,search:'',
    viewMode:localStorage.getItem('ff_viewMode')||'column',
    listSort:{col:'name',dir:1},
    currentPath:path,selIdx:-1,gallerySelIdx:-1,
    loading:false,history:path?[path]:[],historyIdx:path?0:-1,
    searchMode:false,searchResults:[],searchQuery:'',searchSort:{col:'name',dir:1},
    previewEntry:null,previewData:null,previewLoading:false,
    colWidths:{},colResizing:null,thumbCache:{},
    galleryTextZoom:1.0,
    _fileTags:{},_allTags:[],_tagColors:{},activeTag:null,
    _undoStack:[],_redoStack:[],
    clipboard:{entries:[],op:'copy'},
  };
}
const tabs=[{id:1,label:'New Tab',state:makeTabState()}];
let activeTabId=1,_tabIdCounter=1;
function getActiveTab(){return tabs.find(t=>t.id===activeTabId)||tabs[0];}

function newTab(path=''){
  _tabIdCounter++;
  tabs.push({id:_tabIdCounter,label:'New Tab',state:makeTabState(path)});
  switchTab(_tabIdCounter);
  if(path)navigate(path,0,true).catch(()=>{});
  else invoke('get_home_dir').then(h=>navigate(h,0,true)).catch(()=>{});
}
function closeTab(id){
  if(tabs.length===1){newTab();tabs.splice(tabs.findIndex(t=>t.id===id),1);renderTabs();return;}
  const idx=tabs.findIndex(t=>t.id===id);if(idx<0)return;
  tabs.splice(idx,1);
  if(activeTabId===id)switchTab(tabs[Math.min(idx,tabs.length-1)].id,false);
  else renderTabs();
}
function switchTab(id,doRender=true){
  activeTabId=id;
  const ts=getActiveTab().state;
  Object.assign(state,ts);
  _tbFp=''; // force toolbar rebuild on tab switch — path/view/etc all change
  if(doRender){renderTabs();render();}
}
function syncState(){
  const ts=getActiveTab().state;
  const keys=['columns','activeSb','showHidden','search','viewMode','listSort',
    'currentPath','selIdx','gallerySelIdx','loading','history','historyIdx',
    'searchMode','searchResults','searchQuery','searchSort','previewEntry','previewData',
    'previewLoading','colWidths','colResizing','thumbCache','galleryTextZoom',
    '_fileTags','_allTags','_tagColors','activeTag','_undoStack','_redoStack','clipboard'];
  for(const k of keys)ts[k]=state[k];
  const tab=getActiveTab();
  tab.label=state.currentPath?state.currentPath.split('/').filter(Boolean).pop()||state.currentPath:'New Tab';
  saveSession();
}

// ── r89: Session persistence ───────────────────────────────────────────────
// Serialises open tabs to localStorage so they survive restart.
// Called from syncState() — fires on every render cycle.
function saveSession(){
  try{
    const data={
      activeTabId,
      tabs: tabs.map(t=>({
        id:t.id,
        label:t.label,
        path:t.state.currentPath||'',
        viewMode:t.state.viewMode||'column',
        showHidden:t.state.showHidden||false,
        // Persist column scroll positions per path
        colScrolls:Object.fromEntries(
          (t.state.columns||[]).map((c,i)=>{
            const el=document.querySelectorAll('.col-list')[i];
            return [c.path||'', el?el.scrollTop:0];
          })
        ),
        // Persist list-view scroll offset
        listScroll:(()=>{const el=document.querySelector('.list-wrap');return el?el.scrollTop:0;})(),
        // Persist column widths
        colWidths:t.state.colWidths||{},
        // Persist selection index
        selIdx:t.state.selIdx,
      })),
    };
    localStorage.setItem('ff_session', JSON.stringify(data));
  }catch(_){}
}

// r90: Restore tabs from ff_session.
// Returns true if a session was restored (skip default home nav).
// Graceful degradation: paths that no longer exist fall back to home.
async function restoreSession(home){
  let saved;
  try{ saved=JSON.parse(localStorage.getItem('ff_session')||'null'); }catch(_){ return false; }
  if(!saved||!Array.isArray(saved.tabs)||!saved.tabs.length) return false;

  // Rebuild tabs array from session data
  tabs.length=0;
  _tabIdCounter=0;
  for(const t of saved.tabs){
    _tabIdCounter++;
    const ts=makeTabState(t.path||home);
    ts.viewMode=t.viewMode||'column';
    ts.showHidden=t.showHidden||false;
    ts.colWidths=t.colWidths||{};
    ts.selIdx=t.selIdx??-1;
    tabs.push({id:_tabIdCounter, label:t.label||'New Tab', state:ts,
               _restoreColScrolls:t.colScrolls||{}, _restoreListScroll:t.listScroll||0});
  }

  // Try to restore the previously active tab; fall back to first
  const savedActiveIdx=tabs.findIndex(t=>{
    const orig=saved.tabs.find((_,i)=>i===tabs.indexOf(t));
    return orig&&orig.id===saved.activeTabId;
  });
  activeTabId=tabs[savedActiveIdx>=0?savedActiveIdx:0].id;

  // Navigate each tab to its saved path; fall back to home on missing path
  for(const tab of tabs){
    const targetPath=tab.state.currentPath||home;
    switchTab(tab.id, false);
    try{
      await navigate(targetPath, 0, true);
    }catch(_){
      // r91: graceful degradation — path gone, use home dir
      showToast(t('toast.tab_restored_missing'),'info');
      await navigate(home, 0, true);
    }
    // r92: restore scroll positions after paint via rAF
    const colScrolls=tab._restoreColScrolls||{};
    const listScroll=tab._restoreListScroll||0;
    requestAnimationFrame(()=>{
      document.querySelectorAll('.col-list').forEach((el,i)=>{
        const col=(tab.state.columns||[])[i];
        if(col&&colScrolls[col.path]!=null) el.scrollTop=colScrolls[col.path];
      });
      const lw=document.querySelector('.list-wrap');
      if(lw&&listScroll) lw.scrollTop=listScroll;
    });
  }

  // Switch back to the active tab
  switchTab(activeTabId, false);
  return true;
}

function renderTabs(){
  const bar=document.getElementById('tab-bar');if(!bar)return;
  bar.innerHTML='';
  tabs.forEach(tab=>{
    const el=document.createElement('div');el.className='tab'+(tab.id===activeTabId?' active':'');el.dataset.id=tab.id;
    const lbl=document.createElement('span');lbl.className='tab-label';lbl.textContent=tab.label||'New Tab';
    const cls=document.createElement('button');cls.className='tab-close';cls.innerHTML='<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>';
    cls.addEventListener('click',ev=>{ev.stopPropagation();closeTab(tab.id);});
    el.appendChild(lbl);el.appendChild(cls);
    el.addEventListener('click',()=>{if(activeTabId!==tab.id)switchTab(tab.id);});
    bar.appendChild(el);
  });
  const addBtn=document.createElement('button');addBtn.className='tab-new-btn';addBtn.title='New tab (Ctrl+T)';
  addBtn.innerHTML='<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="6" y1="1" x2="6" y2="11"/><line x1="1" y1="6" x2="11" y2="6"/></svg>';
  addBtn.addEventListener('click',()=>newTab());
  bar.appendChild(addBtn);
}

// ── Global state ──────────────────────────────────────────────────────────────
const state={
  columns:[],activeSb:null,showHidden:false,search:'',
  viewMode:localStorage.getItem('ff_viewMode')||'column',
  listSort:{col:'name',dir:1},
  currentPath:'',selIdx:-1,gallerySelIdx:-1,
  sidebarData:{favorites:[],drives:[]},
  loading:false,history:[],historyIdx:-1,
  searchMode:false,searchResults:[],searchQuery:'',searchSort:{col:'name',dir:1},
  previewEntry:null,previewData:null,previewLoading:false,
  clipboard:{entries:[],op:'copy'},
  _undoStack:[],  // [{op:'move'|'copy'|'delete', items:[{src,dst}]}]
  _redoStack:[],
  colWidths:{},colResizing:null,thumbCache:{},
  galleryTextZoom:1.0,
  iconSize:parseInt(localStorage.getItem('ff_iconSize')||'112'),
  fontSize:parseInt(localStorage.getItem('ff_fontSize')||'13'),
  sidebarScale:parseFloat(localStorage.getItem('ff_sb_scale')||'1'),
  _fileTags:{},_allTags:[],_tagColors:{},activeTag:null,
  _deps:{},
  _platform:'linux',
};

function applyScale(){
  const listIconSize=Math.round(Math.max(14,state.iconSize*0.38));
  const rowPad=Math.round(Math.max(2,(state.iconSize-44)*0.08));
  document.documentElement.style.setProperty('--icon-size',state.iconSize+'px');
  document.documentElement.style.setProperty('--font-size-ui',state.fontSize+'px');
  document.documentElement.style.setProperty('--list-icon-size',listIconSize+'px');
  document.documentElement.style.setProperty('--row-padding',rowPad+'px');
  localStorage.setItem('ff_iconSize',state.iconSize);
  localStorage.setItem('ff_fontSize',state.fontSize);
  applySidebarScale();
}
function applySidebarScale(){
  const s=Math.max(0.75,Math.min(1.4,state.sidebarScale));
  state.sidebarScale=s;
  document.documentElement.style.setProperty('--sb-scale',s);
  localStorage.setItem('ff_sb_scale',s);
}

// ── Sort system ───────────────────────────────────────────────────────────────
const sortState={col:localStorage.getItem('ff_sort_col')||'name',dir:+(localStorage.getItem('ff_sort_dir')||1),foldersFirst:localStorage.getItem('ff_sort_ff')!=='false'};
function saveSortState(){localStorage.setItem('ff_sort_col',sortState.col);localStorage.setItem('ff_sort_dir',sortState.dir);localStorage.setItem('ff_sort_ff',sortState.foldersFirst);}
// p8: per-folder sort prefs — map of path→{col,dir,foldersFirst}, capped at 200 entries
const _SORT_PREFS_KEY='ff_sort_prefs';
function _getSortPrefs(){try{return JSON.parse(localStorage.getItem(_SORT_PREFS_KEY)||'{}');}catch{return {};}}
function _saveSortPrefForPath(path){
  const prefs=_getSortPrefs();
  prefs[path]={col:sortState.col,dir:sortState.dir,foldersFirst:sortState.foldersFirst};
  const keys=Object.keys(prefs);
  if(keys.length>200){delete prefs[keys[0]];} // evict oldest
  localStorage.setItem(_SORT_PREFS_KEY,JSON.stringify(prefs));
}
function _applySortPrefForPath(path){
  const p=_getSortPrefs()[path];
  if(p){sortState.col=p.col;sortState.dir=p.dir;sortState.foldersFirst=p.foldersFirst;}
}
// Fast O(n) order-independent fingerprint of a raw entry array.
// Uses count + alphabetically-min + alphabetically-max name, all computed in
// a single pass. Order-independent: IPC returns entries in arbitrary filesystem
// order which varies between calls for the same directory. Using arr[0]/arr[-1]
// (filesystem order first/last) gave false mismatches → fast-path never fired.
// Using min/max gives the same result regardless of IPC return order.
// NOTE: this is a boundary check only; a rename of a middle entry may not be
// detected here. The full sort+compare in the post-sort check catches that case.
function _colFp(entries) {
  if (!entries.length) return '0||';
  let min = entries[0].name, max = entries[0].name;
  for (let i = 1; i < entries.length; i++) {
    const n = entries[i].name;
    if (n < min) min = n;
    else if (n > max) max = n;
  }
  return entries.length + '|' + min + '|' + max;
}

// Full name-set fingerprint: sorts all names and joins them.
// O(n log n) but uses plain string sort (no ICU) — fast.
// Used in refreshColumns to reliably detect "nothing changed" before
// assigning col.entries and calling render(). Catches all rename cases.
function _colFpFull(entries) {
  if (!entries.length) return ' ';
  const names = new Array(entries.length);
  for (let i = 0; i < entries.length; i++) names[i] = entries[i].name;
  names.sort(); // plain string sort — O(n log n), no ICU
  return names.join(' ');
}

function sortEntries(entries){
  // NOTE: does NOT write state.listSort — list view manages its own sort state.
  const{col,dir,foldersFirst}=sortState;
  if(col==='name'||col==='default'||!col){
    // Schwartzian transform: pre-compute lowercase key once per entry (O(n)),
    // then sort with plain string compare (O(n log n) fast ops).
    // This is 50-100× faster than localeCompare(b,undefined,{sensitivity:'base'})
    // which invokes the ICU collation library on every comparison (~0.05ms each).
    // For 542 Music entries: old≈250ms per sort, new≈5ms per sort.
    const keyed=entries.map(e=>({e,k:e.name.toLowerCase()}));
    keyed.sort((a,b)=>{
      if(foldersFirst&&a.e.is_dir!==b.e.is_dir)return a.e.is_dir?-1:1;
      return dir*(a.k<b.k?-1:a.k>b.k?1:0);
    });
    return keyed.map(x=>x.e);
  }
  return[...entries].sort((a,b)=>{
    if(foldersFirst&&a.is_dir!==b.is_dir)return a.is_dir?-1:1;
    switch(col){
      case 'size':return dir*((a.size||0)-(b.size||0))||a.name.localeCompare(b.name);
      case 'date':return dir*((a.modified||0)-(b.modified||0))||a.name.localeCompare(b.name);
      case 'type':{const ea=(a.is_dir?'':a.extension||'zzz').toLowerCase(),eb=(b.is_dir?'':b.extension||'zzz').toLowerCase();return dir*ea.localeCompare(eb)||a.name.localeCompare(b.name);}
      default:return dir*a.name.localeCompare(b.name);
    }
  });
}
async function sortEntriesAsync(entries){
  if(entries.length<500)return sortEntries(entries);
  return workerRequest('sort',{entries,col:sortState.col,dir:sortState.dir,foldersFirst:sortState.foldersFirst});
}

function showSortMenu(anchor){
  document.getElementById('sort-popup')?.remove();
  const ITEMS=[{col:'name',label:'Name'},{col:'date',label:'Date Modified'},{col:'size',label:'Size'},{col:'type',label:'Type (extension)'}];
  const pop=document.createElement('div');pop.id='sort-popup';pop.className='sort-popup';
  const r=anchor.getBoundingClientRect();
  pop.style.cssText=`position:fixed;top:${r.bottom+4}px;right:${window.innerWidth-r.right}px;z-index:8000;`;
  pop.innerHTML='<div class="sort-popup-title">Sort by</div>'
    +ITEMS.map(it=>`<button class="sort-popup-item${sortState.col===it.col?' active':''}" data-col="${it.col}"><span class="sort-popup-check">${sortState.col===it.col?(sortState.dir>0?'↑':'↓'):''}</span>${it.label}</button>`).join('')
    +`<div class="sort-popup-sep"></div><button class="sort-popup-item${sortState.foldersFirst?' active':''}" data-action="ff"><span class="sort-popup-check">${sortState.foldersFirst?'✓':''}</span>Folders first</button>`;
  document.body.appendChild(pop);
  pop.querySelectorAll('button').forEach(btn=>btn.addEventListener('click',e=>{
    e.stopPropagation();
    if(btn.dataset.action==='ff')sortState.foldersFirst=!sortState.foldersFirst;
    else if(btn.dataset.col){if(sortState.col===btn.dataset.col)sortState.dir*=-1;else{sortState.col=btn.dataset.col;sortState.dir=1;}}
    saveSortState();_saveSortPrefForPath(state.currentPath);_tbFp='';pop.remove();render();
  }));
  setTimeout(()=>document.addEventListener('click',()=>pop.remove(),{once:true}),0);
}

// ── Navigation ────────────────────────────────────────────────────────────────
async function listDirectory(path){ return invoke('list_directory_fast',{path}); }
async function listDirectoryFull(path){
  // Streaming variant — replaces the old single-shot invoke('list_directory').
  // list_directory serialised the entire Vec<FileEntry> in one IPC response;
  // on a large Downloads folder (1500+ files) WebKit would block 1-2s parsing
  // the blob.  list_directory_full_streamed emits dir-full-chunk events in
  // 100-entry batches so the main thread never stalls on one big deserialise.
  const requestId = (++_streamReqId) & 0x7FFFFFFF;
  return new Promise(async (resolve, reject) => {
    const all = []; let parent = null, unlisten;
    unlisten = await listen('dir-full-chunk', ev => {
      const p = ev.payload;
      if (p.request_id !== requestId) return;
      if (p.parent) parent = p.parent;
      if (p.entries?.length) all.push(...p.entries);
      if (p.done) {
        unlisten();
        resolve({ path, entries: all, parent });
      }
    });
    invoke('list_directory_full_streamed', { path, requestId })
      .catch(err => { unlisten(); reject(err); });
  });
}

// perf: streaming version with per-chunk callback for progressive rendering.
// The callback fires on every chunk so list/gallery/icon views can show partial
// results immediately instead of waiting for all entries to arrive.
async function listDirectoryFullStreamed(path, onChunk){
  const requestId=(++_streamReqId)&0x7FFFFFFF;
  return new Promise(async(resolve,reject)=>{
    const all=[]; let parent=null,unlisten,firstFired=false;
    unlisten=await listen('dir-full-chunk',ev=>{
      const p=ev.payload;
      if(p.request_id!==requestId)return;
      if(p.parent)parent=p.parent;
      if(p.entries?.length){
        all.push(...p.entries);
        if(onChunk&&!firstFired){firstFired=true;onChunk([...all]);}
        else if(onChunk)onChunk([...all]);
      }
      if(p.done){unlisten();resolve({path,entries:all,parent});}
    });
    invoke('list_directory_full_streamed',{path,requestId})
      .catch(err=>{unlisten();reject(err);});
  });
}

let _navDebounceTimer=null;
function navigateDebounced(path,colIdx,addHistory){
  clearTimeout(_navDebounceTimer);
  return new Promise(resolve=>{
    _navDebounceTimer=setTimeout(async()=>{ resolve(await navigate(path,colIdx,addHistory)); },80);
  });
}

// ── JS-side directory listing cache ─────────────────────────────────────────
// Stores raw FileEntryFast[] from the most recent successful read of each path.
// On a cache hit, navigate() skips invoke() entirely — zero IPC round-trips.
// Each Tauri IPC crossing costs ~5-7ms (WebKit bridge); skipping both
// invoke+emit saves ~15ms per revisit.
//
// The Rust-side cache (r31) handles refreshColumns IPC calls.
// This JS cache handles navigate() — the user-facing hot path.
//
// Invalidation: dir-changed watcher event evicts the affected path.
// Capacity: 30 paths LRU.
const _JS_DIR_CACHE = new Map();          // path → FileEntryFast[]
const _JS_DIR_CACHE_ORDER = [];           // LRU order for eviction
const _JS_DIR_CACHE_MAX = 30;

function _jsCacheGet(path) { return _JS_DIR_CACHE.get(path) ?? null; }

function _jsCacheSet(path, entries) {
  if (_JS_DIR_CACHE.has(path)) {
    // Move to back of LRU queue
    const i = _JS_DIR_CACHE_ORDER.indexOf(path);
    if (i >= 0) _JS_DIR_CACHE_ORDER.splice(i, 1);
  } else if (_JS_DIR_CACHE.size >= _JS_DIR_CACHE_MAX) {
    const oldest = _JS_DIR_CACHE_ORDER.shift();
    if (oldest) _JS_DIR_CACHE.delete(oldest);
  }
  _JS_DIR_CACHE.set(path, entries);
  _JS_DIR_CACHE_ORDER.push(path);
}

function _jsCacheEvict(path) {
  if (_JS_DIR_CACHE.delete(path)) {
    const i = _JS_DIR_CACHE_ORDER.indexOf(path);
    if (i >= 0) _JS_DIR_CACHE_ORDER.splice(i, 1);
  }
}

let _navSeq=0;       // increments on every navigate() call — stale-result guard
let _streamReqId=0;  // unique id per streaming request — filters cross-stream events

// _streamDir: wraps list_directory_streamed into a Promise.
// Calls onFirstChunk(partialEntries) as soon as the first ~60 entries arrive so
// the column can render immediately without waiting for the full directory.
// Resolves with {path, entries, parent} when done:true received.
// Resolves with null if a newer navigate() started (stale guard via mySeq).
async function _streamDir(path, mySeq, onFirstChunk){
  const requestId=(++_streamReqId)&0x7FFFFFFF;
  return new Promise(async(resolve,reject)=>{
    const all=[]; let parent=null, firstFired=false, unlisten;
    unlisten=await listen('dir-chunk',ev=>{
      const p=ev.payload;
      if(p.request_id!==requestId)return; // belongs to a different stream
      if(p.parent)parent=p.parent;
      if(p.entries?.length)all.push(...p.entries);

      // Stale guard: a newer navigate() started — this stream's column is no longer
      // the active nav target. Do NOT call onFirstChunk or applyNavState.
      // But crucially: do NOT abandon mid-stream. Keep draining until done:true so
      // the Rust side can finish and store the result in cache. Once done, silently
      // patch the column in-place (it may still be visible as a parent column) and
      // resolve null so navigate() knows it lost the race.
      if(mySeq!==_navSeq){
        if(p.done){
          unlisten();
          // Patch this column's entries silently — it may be visible as col[N-1]
          // while the user has already navigated into a subfolder as col[N].
          // Without this patch, a column navigated-through-quickly stays frozen at
          // its first-paint chunk (60 entries) until the user revisits it.
          const col=window._state?.columns?.find(c=>c.path===path);
          if(col && all.length > (col.entries?.length||0)){
            col.entries=all;
            col._fp=_colFpFull(all);
            _jsCacheSet(path, all);
            // Patch the live DOM column without a full render()
            const colEl=document.querySelector(`[data-col-path="${CSS.escape(path)}"]`);
            colEl?._patchEntries?.(all, col.selIdx??-1);
          }
          resolve(null);
        }
        return;
      }

      if(!firstFired&&all.length>0){
        firstFired=true;
        onFirstChunk?.([...all]); // early paint with partial entries
      }
      if(p.done){unlisten();resolve({path,entries:all,parent});}
    });
    invoke('list_directory_streamed',{path,requestId})
      .catch(err=>{unlisten();reject(err);});
  });
}

async function navigate(path, colIdx=0, addHistory=true){
  // Warn if cut files will be lost — cut entries only survive a single paste
  if(state.clipboard.op==='cut'&&state.clipboard.entries.length>0&&path!==state.currentPath){
    const n=state.clipboard.entries.length;
    if(!confirm(`You have ${n} cut file${n>1?'s':''} pending. Navigating away will clear the clipboard.\n\nContinue?`)){
      return;
    }
    state.clipboard={entries:[],op:'copy'};
  }
  const mySeq=++_navSeq;
  const t0=performance.now();
  FF.log('NAV_START',{seq:mySeq,path,colIdx,viewMode:state.viewMode,cols:state.columns.length,loading:state.loading});

  // Stop watching the previous directory before starting a new nav
  invoke('unwatch_dir').catch(()=>{});

  state.loading=true; state.searchMode=false;
  // Immediate visual feedback — show loading spinner before any await
  renderToolbar();

  try{
    FF.log('NAV_INVOKE',{seq:mySeq,path});

    if(state.viewMode==='column'){
      // ── Streaming path ──────────────────────────────────────────────────────
      // list_directory_streamed (async Rust, spawn_blocking) emits 60-entry chunks.
      // onFirstChunk fires ~3ms after invoke for large dirs (Music: 893 entries)
      // vs waiting 25ms for the full batch. The column renders with partial data
      // then updates silently when done arrives.
      let historyDone=false;
      const applyNavState=(entries)=>{
        state.currentPath=path;_recordPathHistory(path);_applySortPrefForPath(path); state.selIdx=-1; state.gallerySelIdx=-1;
        announceA11y(`${path.split('/').pop()||path}`);
        refreshGitStatus(path).catch(()=>{});
        if(addHistory&&!historyDone){
          historyDone=true;
          state.history.splice(state.historyIdx+1);
          state.history.push(path);
          state.historyIdx=state.history.length-1;
        }
        state.columns.splice(colIdx);
        state.columns.push({path,entries,selIdx:-1,_fp:_colFpFull(entries)});
      };

      // ── JS cache fast-path ──────────────────────────────────────────────────
      // Serve from JS memory on revisit — zero IPC, zero filesystem reads.
      // Tauri invoke+emit costs ~15ms each way (WebKit bridge). Skipping both
      // saves ~15ms per revisit, bringing cache-hit navs from ~20ms to ~3ms.
      // The watcher evicts this entry when the directory actually changes.
      const jsCached = _jsCacheGet(path);
      if (jsCached) {
        state.loading = false;
        applyNavState(jsCached);
        FF.log('NAV_FIRST_CHUNK',{seq:mySeq,path,count:jsCached.length,ms:Math.round(performance.now()-t0),cached:true});
        FF.log('NAV_RESOLVED',{seq:mySeq,path,elapsed:Math.round(performance.now()-t0),count:jsCached.length,cached:true});
        FF.log('NAV_RENDER',{seq:mySeq,path,cols:state.columns.length,entries:jsCached.length});
        // Fire a background validation to detect changes. If something changed,
        // update the cache and re-render the column. Uses fire-and-forget so the
        // column is visible before the background IPC resolves.
        _streamDir(path, mySeq, null).then(result => {
          if (!result || mySeq !== _navSeq) return;
          const changed = result.entries.length !== jsCached.length ||
            result.entries[0]?.path !== jsCached[0]?.path ||
            result.entries[result.entries.length-1]?.path !== jsCached[jsCached.length-1]?.path;
          _jsCacheSet(path, result.entries);
          if (changed) {
            const col = state.columns.find(c => c.path === path);
            if (col) { col.entries = result.entries; render(); }
          }
        }).catch(()=>{});
        return; // finally block still runs: watch_dir, syncState, render
      }

      const result=await _streamDir(path, mySeq, (firstEntries)=>{
        // First-chunk paint: column visible immediately with partial entries
        state.loading=false;
        applyNavState(firstEntries);
        render();
        FF.log('NAV_FIRST_CHUNK',{seq:mySeq,path,count:firstEntries.length,ms:Math.round(performance.now()-t0)});
      });

      if(!result)return; // stale — a newer navigate() took over

      FF.log('NAV_RESOLVED',{seq:mySeq,path,elapsed:Math.round(performance.now()-t0),count:result.entries.length});

      // Store in JS cache for zero-IPC revisits
      _jsCacheSet(path, result.entries);

      // Patch full entry list into existing column (covers empty-first-chunk case too)
      const col=state.columns.find(c=>c.path===path);
      if(col){col.entries=result.entries;col._fp=_colFpFull(result.entries);}
      else{applyNavState(result.entries);} // first chunk never fired (empty dir)

      FF.log('NAV_RENDER',{seq:mySeq,path,cols:state.columns.length,entries:result.entries.length});

    } else {
      // perf: stream list/gallery/icon views progressively — first chunk renders
      // immediately so the UI is responsive even for 10k+ entry directories.
      let historyApplied=false;
      const applyNav=(entries,isFirst)=>{
        state.currentPath=path; state.selIdx=-1; state.gallerySelIdx=-1;
        if(addHistory&&!historyApplied){
          historyApplied=true;
          state.history.splice(state.historyIdx+1);
          state.history.push(path);
          state.historyIdx=state.history.length-1;
        }
        state.columns=[{path,entries,selIdx:-1,_fp:_colFpFull(entries)}];
        if(isFirst){
          state.loading=false; render();
          announceA11y(`${path.split('/').pop()||path}`);
          refreshGitStatus(path).catch(()=>{});
        }
        loadTagsForEntries(entries).catch(()=>{});
      };
      const result=await listDirectoryFullStreamed(path,(partial)=>{
        if(mySeq!==_navSeq)return;
        applyNav(partial,true);
        FF.log('NAV_FIRST_CHUNK',{seq:mySeq,path,count:partial.length,ms:Math.round(performance.now()-t0)});
      });
      if(mySeq!==_navSeq){FF.log('NAV_STALE',{seq:mySeq,path,currentSeq:_navSeq});return;}
      const elapsed=Math.round(performance.now()-t0);
      FF.log('NAV_RESOLVED',{seq:mySeq,path,elapsed,count:result.entries?.length});
      let entries=result.entries;
      if(entries.length>500) entries=await sortEntriesAsync(entries);
      applyNav(entries,false);
      FF.log('NAV_RENDER',{seq:mySeq,path,cols:state.columns.length,entries:entries.length});
    }

  }catch(e){
    FF.log('NAV_ERROR',{seq:mySeq,path,error:String(e)});logError(String(e),'navigate:'+path);
    const errStr=String(e);
    if(errStr.includes('PERMISSION_DENIED')||errStr.includes('Permission denied'))
      showPermissionDialog(path);
    else showToast(t('error.unknown',{err:e}),'error');
  } finally {
    state.loading=false; syncState(); render();
    // Only watch the path that won the race — stale navigates must not clobber the watcher.
    if(mySeq===_navSeq){
      invoke('watch_dir', {paths: [...new Set([...state.columns.map(c=>c.path), path])]})
        .then(()=>_updateWatchIndicator())
        .catch(()=>{});
      // Update window title to current folder name so multiple windows are identifiable
      const folderName = path.split('/').filter(Boolean).pop() || '/';
      // Add window number when multiple windows are open (tracked via BroadcastChannel)
      const _wNum = parseInt(sessionStorage.getItem('ff_win_num')||'1');
      const _wLabel = _wNum > 1 ? ` [${_wNum}]` : '';
      appWindow.setTitle('FrostFinder — ' + folderName + _wLabel).catch(()=>{});
    }
    FF.log('NAV_DONE',{seq:mySeq,path,totalMs:Math.round(performance.now()-t0)});
  }
}

async function refreshCurrent(){await navigate(state.currentPath,0,false);}

// Refresh all open columns in-place, preserving the column stack.
// Used after drag-and-drop in column view so the column layout isn't destroyed.
let _watcherRefreshPending = false; // prevents stacked watcher refreshes
async function refreshColumns(changedPath = null){
  // If called from the watcher (changedPath provided) and a refresh is already
  // in-flight, skip — the in-flight call will render the latest state anyway.
  // File-operation callers (changedPath=null) always run and refresh all columns.
  if (changedPath !== null && _watcherRefreshPending) return;
  if (changedPath !== null) _watcherRefreshPending = true;

  if(state.viewMode!=='column'||!state.columns.length){await refreshCurrent();
    _watcherRefreshPending = false; return;}
  let anyChanged = false;
  try{
    const colsToRefresh = changedPath
      ? state.columns.filter(col => col.path === changedPath)
      : state.columns;
    await Promise.all(colsToRefresh.map(async(col)=>{
      // Use list_directory_fast (name+type only, zero stat syscalls, tiny IPC payload)
      // instead of list_directory (full FileEntry with stat metadata).
      // refreshColumns only needs names for the fingerprint check and name/type for
      // column display — it never shows size/mtime/permissions until an entry is selected.
      // list_directory on Downloads (1500 files) was serialising a ~300KB FileEntry blob
      // per watcher event (debounced 300ms), freezing WebKit on every browser-download rename.
      // list_directory_fast returns ~40KB and involves zero stat() calls (DirEntry.file_type
      // is free on Linux from dirent d_type).
      const r = await invoke('list_directory_fast', {path: col.path});
      // ── Full name-set fingerprint gate ──────────────────────────────────────
      // Compute _colFpFull (O(n log n) sort + join of all names) and compare
      // against the fp stored on this column at navigate/last-refresh time.
      //
      // If identical: directory contents haven't changed. Skip col.entries
      // assignment AND mark not-changed so we can avoid render() entirely.
      // This is the PRIMARY fix for the remaining watcher slowdown:
      //   - render() calls renderToolbar() which does toolbar.innerHTML rebuild
      //   - Even at 1-3ms, this triggers browser layout/repaint — visible as
      //     a toolbar/breadcrumb flicker on every watcher event
      //   - By skipping render() when nothing changed, zero visual updates occur
      //
      // For watcher-triggered refreshes (changedPath provided): compare fp
      // For file-op refreshes (changedPath=null): always update (correct behavior)
      if (changedPath !== null) {
        const newFp = _colFpFull(r.entries);
        if (col._fp !== undefined && newFp === col._fp) return; // nothing changed
        col._fp = newFp;
      }
      col.entries = r.entries;
      anyChanged = true;
    }));
  }catch(e){showToast(t('error.refresh',{err:e}),'error'); anyChanged = true;}
  finally { if (changedPath !== null) _watcherRefreshPending = false; }
  state.loading = false;
  if (anyChanged) render();
}

async function loadTagsForEntries(entries){
  // Non-column only, sequential (never concurrent) to avoid IPC flooding
  if(state.viewMode==='column')return;
  try{
    const tagsWithColors=await invoke('get_tags_with_colors');
    state._allTags=tagsWithColors.map(t=>t.name);
    if(!state._tagColors)state._tagColors={};
    for(const t of tagsWithColors)state._tagColors[t.name]=t.color;
    if(!tagsWithColors.length)return;
    if(!state._fileTags)state._fileTags={};
    const pathSet=new Set(entries.map(e=>e.path));
    for(const t of tagsWithColors){
      if(state.viewMode==='column')return;
      try{
        const results=await invoke('search_by_tag',{tag:t.name});
        for(const ft of results){
          if(pathSet.has(ft.path)){
            if(!state._fileTags[ft.path])state._fileTags[ft.path]=[];
            if(!state._fileTags[ft.path].includes(t.name))state._fileTags[ft.path].push(t.name);
          }
        }
      }catch(_e){logError(String(_e),'silent');}
    }
    // Tags are now populated — force a full view rebuild so tinting appears.
    // Bust the incremental-render cache keys so renderIconView / renderGalleryView
    // don't skip straight to the fast path and miss the new tint data.
    const host=document.getElementById('view-host');
    if(host){ host._ivMeta=null; host._galleryMeta=null; }
    renderSidebar(); render();
  }catch(e){}
}

async function refreshTagColors(){
  try{
    const tagsWithColors=await invoke('get_tags_with_colors');
    state._allTags=tagsWithColors.map(t=>t.name);
    if(!state._tagColors)state._tagColors={};
    for(const t of tagsWithColors)state._tagColors[t.name]=t.color;
    renderSidebar(); render();
  }catch(e){}
}



function showPermissionDialog(path){
  const existing=document.getElementById('perm-dialog');if(existing)existing.remove();
  const d=document.createElement('div');d.id='perm-dialog';
  d.innerHTML='<div class="perm-backdrop"></div><div class="perm-box">\n    <div class="perm-title">Permission Required</div>\n    <div class="perm-msg">Access denied:<br><code>' + escHtml(path) + '</code></div>\n    <div class="perm-btns">\n      <button class="perm-cancel" id="perm-cancel">Cancel</button>\n      <button class="perm-ok" id="perm-ok">Open as Root (pkexec)</button>\n    </div></div>';
  document.body.appendChild(d);
  document.getElementById('perm-cancel')?.addEventListener('click',()=>d.remove());
  if (state._platform === 'linux') {
    document.getElementById('perm-ok')?.addEventListener('click',()=>{d.remove();invoke('open_as_root',{path}).catch(err=>showToast(t('error.root_access',{err}),'error'));});
  } else {
    document.getElementById('perm-ok')?.remove();
  }
}

// ── Visible entries ───────────────────────────────────────────────────────────
const sel={
  _paths:new Set(),_e:[],last:-1,
  clear(){this._paths.clear();this.last=-1;},
  toggle(i){const p=this._e[i]?.path;if(!p)return;this._paths.has(p)?this._paths.delete(p):this._paths.add(p);this.last=i;},
  range(a,b){const lo=Math.min(a,b),hi=Math.max(a,b);for(let i=lo;i<=hi;i++){const p=this._e[i]?.path;if(p)this._paths.add(p);}this.last=b;},
  set(i){this._paths.clear();const p=this._e[i]?.path;if(p)this._paths.add(p);this.last=i;},
  has(i){return this._paths.has(this._e[i]?.path);},
  hasp(p){return this._paths.has(p);},
  get arr(){const s=new Set();this._e.forEach((e,i)=>{if(this._paths.has(e.path))s.add(i);});return[...s].sort((a,b)=>a-b);},
  get size(){return this._paths.size;},
};

function getVisibleEntries(){
  if(state.searchMode){let e=state.searchResults;if(!state.showHidden)e=e.filter(x=>!x.is_hidden);sel._e=e;return e;}
  for(let i=state.columns.length-1;i>=0;i--){
    if(state.columns[i].path===state.currentPath){
      let e=state.columns[i].entries;
      if(!state.showHidden)e=e.filter(x=>!x.is_hidden);
      // Hide .trashinfo metadata files when browsing the Trash
      if(state.currentPath&&state.currentPath.includes('/.local/share/Trash'))
        e=e.filter(x=>!x.name.endsWith('.trashinfo'));
      if(state.search){const q=state.search.toLowerCase();e=e.filter(x=>x.name.toLowerCase().includes(q));}
      const s=sortEntries(e);sel._e=s;return s;
    }
  }
  sel._e=[];return[];
}
const getCurrentEntries=getVisibleEntries;

// ── Clipboard ─────────────────────────────────────────────────────────────────
function clipboardCopy(entries){state.clipboard={entries:[...entries],op:'copy'};showToast(t('toast.copied',{n:entries.length}),'info');}
function clipboardCut(entries){state.clipboard={entries:[...entries],op:'cut'};showToast(t('toast.cut',{n:entries.length}),'info');}
async function clipboardPaste(){
  if(!state.clipboard.entries.length)return;
  const dest=state.currentPath;
  const op=state.clipboard.op;
  let srcs=state.clipboard.entries.map(e=>e.path);
  const total=srcs.length;

  // ── Progress toast ────────────────────────────────────────────────────────
  // For a single file skip the bar — it'll finish before the user notices.
  let unlisten=null;
  const opLabel = op==='cut' ? 'Moving' : 'Copying';
  _sbProgress.start(opLabel + ' 0 / ' + total, total);

  // ── Listen for progress events from Rust ─────────────────────────────────
  const errors=[];
  const undoItems=[];
  const entries=state.clipboard.entries;

  // ── Register event listener BEFORE firing the batch command.
  // listen() is async — if we called invoke() first, Rust could emit
  // finished:true before the listener is registered, and done would never resolve.
  let _pasteUnlisten;   // declared BEFORE new Promise — avoids TDZ ReferenceError
  const done=new Promise(resolve=>{
    _pasteUnlisten=resolve; // will be called by the listener below
  });
  const _opStartTime = Date.now();
  unlisten=await listen('file-op-progress', ev=>{
    const {done:d,total:t,name,error,finished,bytes_done,bytes_total}=ev.payload;
    const entry=entries[d-1];
    if(!error && entry){
      const dstPath=dest+'/'+entry.name;
      undoItems.push({src:entry.path,dst:dstPath,
        srcDir:entry.path.substring(0,entry.path.lastIndexOf('/')),dstDir:dest});
    }
    if(error) errors.push(`${name}: ${error}`);
    let label=(op==='cut'?'Moving':'Copying')+' '+d+' / '+t;
    if(bytes_total&&bytes_total>0){
      const elapsed=(Date.now()-_opStartTime)/1000;
      const speed=elapsed>0.5?bytes_done/elapsed:0;
      const eta=speed>0?(bytes_total-bytes_done)/speed:0;
      label+=' · '+fmtSize(bytes_done)+' / '+fmtSize(bytes_total);
      if(speed>0) label+=' · '+fmtSize(speed)+'/s';
      if(eta>1) label+=' · '+(eta<60?Math.round(eta)+'s':Math.round(eta/60)+'m')+' left';
      _sbProgress.update(bytes_done,bytes_total,label);
    } else {
      _sbProgress.update(d,t,label);
    }
    if(finished) _pasteUnlisten();
  });

  // ── Conflict check before firing batch command ──────────────────────────
  if(op==='copy'){  // only check conflicts for copy — moves remove the source so no conflict
    const conflicts = await _checkConflicts(srcs, dest);
    if(conflicts.length > 0){
      const action = await _showConflictDialog(conflicts);
      if(action === 'cancel'){ if(unlisten) unlisten(); _sbProgress.finish(false,'Cancelled'); return; }
      if(action === 'skip'){
        // Filter out conflicting files
        const conflictSet = new Set(conflicts);
        srcs = srcs.filter(s => !conflictSet.has(s.split('/').pop()));
        if(!srcs.length){ if(unlisten) unlisten(); _sbProgress.finish(true,'All skipped'); return; }
      }
      // 'replace' → proceed with all srcs
    }
  }
  // ── Fire the batch command (returns immediately; work happens in Rust thread)
  const cmd=op==='cut'?'move_files_batch':'copy_files_batch';
  invoke(cmd,{srcs,destDir:dest}).catch(err=>showToast(t('error.batch_op',{err}),'error'));

  await done;
  if(unlisten) unlisten();

  // ── Finish sidebar progress bar ─────────────────────────────────────────
  const hadErrors = errors.length > 0;
  _sbProgress.finish(!hadErrors, hadErrors ? errors[0] : (op==='cut'?'Move':'Copy')+' complete');

  if(undoItems.length) pushUndo({op:op==='cut'?'move':'copy',items:undoItems});
  if(op==='cut') state.clipboard={entries:[],op:'copy'};

  if(errors.length) errors.forEach(e=>showToast(t('error.generic',{err:e}),'error'));
  const ok=total-errors.length;
  if(ok>0) showToast(op==='cut'?t('toast.moved',{n:ok}):t('toast.copied',{n:ok}),'success');
  await refreshColumns();
}

// ── Context menu ──────────────────────────────────────────────────────────────
function showContextMenu(x,y,items){
  closeContextMenu();
  const menu=document.createElement('div');menu.id='ctx-menu';
  menu.setAttribute('role','menu');
  menu.setAttribute('aria-label','Context menu');
  menu.style.cssText=`position:fixed;left:${x}px;top:${y}px;z-index:9000;`;
  for(const item of items){
    if(item==='-'){const sep=document.createElement('div');sep.className='ctx-sep';sep.setAttribute('role','separator');menu.appendChild(sep);continue;}
    if(item.type==='color-tags'){
      const row=document.createElement('div');row.className='ctx-color-tags-row';
      const lbl=document.createElement('span');lbl.className='ctx-color-label';lbl.textContent='Tag';row.appendChild(lbl);
      const dots=document.createElement('div');dots.className='ctx-color-dots';
      for(const p of item.palette){
        const dot=document.createElement('button');
        dot.className='ctx-color-dot'+(item.currentTags.includes(p.name)?' active':'');
        dot.title=p.name;dot.style.setProperty('--dot-color',p.color);
        dot.dataset.tagname=p.name;dot.dataset.tagcolor=p.color;
        dots.appendChild(dot);
      }
      row.appendChild(dots);menu.appendChild(row);
      dots.querySelectorAll('.ctx-color-dot').forEach(dot=>{
        dot.addEventListener('click',async()=>{
          const tag=dot.dataset.tagname,color=dot.dataset.tagcolor;
          await invoke('set_tag_color',{tag,color});
          if(!state._tagColors)state._tagColors={};
          state._tagColors[tag]=color;
          if(!state._allTags)state._allTags=[];
          state._allTags=[...new Set([...state._allTags,tag])];
          if(!state._fileTags)state._fileTags={};
          // r97: batch tagging — apply to every selected entry when sel.size > 1
          const targets=sel.size>1?getSelectedEntries():[item.entry];
          const undoItems=[];
          for(const _te of targets){
            const curTags=state._fileTags[_te.path]||[];
            const newTags=curTags.includes(tag)?curTags.filter(t=>t!==tag):[...curTags,tag];
            undoItems.push({path:_te.path,before:[...curTags],after:newTags});
            await invoke('set_file_tags_v2',{path:_te.path,tags:newTags});
            state._fileTags[_te.path]=newTags;
          }
          pushUndo({op:'tags',items:undoItems});
          // Bust incremental-render caches so icon/gallery view fully rebuilds
          // with updated tinting rather than skipping via the fast path.
          const _vh=document.getElementById('view-host');
          if(_vh){_vh._ivMeta=null;_vh._galleryMeta=null;}
          closeContextMenu();render();renderSidebar();
        });
      });
      continue;
    }
    const el=document.createElement('div');
    el.className='ctx-item'+(item.disabled?' disabled':'');el.setAttribute('role','menuitem');if(item.disabled)el.setAttribute('aria-disabled','true');
    el.dataset.action=item.action||'';
    const iconHtml=item.icon?('<span class="ctx-icon">'+item.icon+'</span>'):'<span class="ctx-icon-spacer"></span>';
    const shortHtml=item.shortcut?('<span class="ctx-shortcut">'+item.shortcut+'</span>'):'';
    el.innerHTML=iconHtml+'<span class="ctx-label">'+item.label+'</span>'+shortHtml;
    if(!item.disabled)el.addEventListener('click',()=>{closeContextMenu();ctxAction(el.dataset.action);});
    menu.appendChild(el);
  }
  document.body.appendChild(menu);
  const r=menu.getBoundingClientRect();
  if(r.right>window.innerWidth)menu.style.left=(x-r.width)+'px';
  if(r.bottom>window.innerHeight)menu.style.top=(y-r.height)+'px';
  setTimeout(()=>document.addEventListener('mousedown',closeContextMenuOutside),0);
}
function closeContextMenu(){document.getElementById('ctx-menu')?.remove();document.removeEventListener('mousedown',closeContextMenuOutside);}
function closeContextMenuOutside(e){if(!e.target.closest('#ctx-menu'))closeContextMenu();}

async function ctxAction(action){
  // Route pane-B specific actions to the pane-B context handler
  if(action.startsWith('pb-') && window._pbCtxAction){
    const fn = window._pbCtxAction;
    window._pbCtxAction = null;
    fn(action);
    return;
  }
  switch(action){
    case 'open':{const e=getSelectedEntry();if(e){if(e.is_dir)navigate(e.path,0);else invoke('open_file',{path:e.path}).catch(()=>{});}break;}
    case 'open-new-tab':{const e=getSelectedEntry();if(e&&e.is_dir)newTab(e.path);break;}
    case 'copy':{const es=getSelectedEntries();if(es.length)clipboardCopy(es);break;}
    case 'cut':{const es=getSelectedEntries();if(es.length)clipboardCut(es);break;}
    case 'copy-current-path':
      navigator.clipboard.writeText(state.currentPath||'').then(()=>showToast(t('toast.path_copied'),'success')).catch(()=>{});
      break;
    case 'paste':clipboardPaste();break;
    case 'rename':{const e=getSelectedEntry();if(e)startRename(e);break;}
    case 'delete':{const es=getSelectedEntries();if(es.length)deleteEntries(es);break;}
    case 'new-folder':promptCreate('folder');break;
    case 'new-file':promptCreate('file');break;
    case 'new-md':promptCreateDoc('markdown','.md');break;
    case 'new-html':promptCreateDoc('html','.html');break;
    case 'new-rs':promptCreateDoc('rust','.rs');break;
    case 'new-py':promptCreateDoc('python','.py');break;
    case 'new-sh':promptCreateDoc('shell','.sh');break;
    case 'copy-path':{const e=getSelectedEntry();if(e)navigator.clipboard.writeText(e.path).then(()=>showToast(t('toast.path_copied'),'info')).catch(()=>showToast(e.path,'info'));break;}
    case 'add-sidebar':{const e=getSelectedEntry();if(e&&e.is_dir)addSidebarFav(e.path,e.name);break;}
    case 'open-terminal':{const e=getSelectedEntry();const p=e?.is_dir?e.path:state.currentPath;invoke('open_terminal',{path:p}).catch(err=>showToast(t('error.terminal',{err}),'error'));break;}
    case 'open-editor':{const e=getSelectedEntry();if(e&&!e.is_dir)invoke('open_in_editor',{path:e.path}).catch(err=>showToast(t('error.editor',{err}),'error'));break;}
    case 'open-with':{
      const _owe=getSelectedEntry();
      if(!_owe||_owe.is_dir)break;
      // r99: pass all selected paths when multi-extension-match is active
      const _owPaths=sel.size>1?getSelectedEntries().map(e=>e.path):null;
      showOpenWithDialog(_owe,_owPaths);
      break;
    }
    // New: Bookmarks
    case 'add-bookmark':{
      const e=getSelectedEntry();
      if(e&&e.is_dir){
        addBookmark(e.path,e.name);
        showToast(t('toast.bookmark_added'),'success');
        render();
      }
      break;
    }
    case 'remove-bookmark':{
      const e=getSelectedEntry();
      if(e&&e.is_dir){
        removeBookmark(e.path);
        showToast(t('toast.bookmark_removed'),'info');
        render();
      }
      break;
    }
    // New: Find Duplicates
    case 'find-duplicates':{
      const e=getSelectedEntry();
      if(e&&e.is_dir){
        showToast(t('toast.scanning_duplicates',{name:e.name}),'info');
        invoke('find_duplicates',{rootPath:e.path,recursive:true})
          .then(dups=>_showDuplicatesPanel(dups,e.name))
          .catch(err=>showToast(t('error.find_duplicates',{err}),'error'));
      }
      break;
    }
    // New: Secure Delete
    case 'secure-delete':{
      const e=getSelectedEntry();
      if(e&&!e.is_dir){
        if(!confirm('SECURE DELETE: This file will be permanently overwritten and cannot be recovered!\n\nFile: '+e.name+'\n\nAre you sure?'))break;
        const passes=3;
        _sbProgress.start('Securely deleting '+e.name+'…', passes);
        let sdUnlisten;
        try {
          sdUnlisten = await listen('secure-delete-progress', ev => {
            const {pass, total_passes, file, finished} = ev.payload;
            if (finished) {
              _sbProgress.finish(true, 'Securely deleted');
            } else {
              _sbProgress.update(pass, total_passes, 'Pass '+pass+' / '+total_passes+' — overwriting '+file);
            }
          });
          await invoke('secure_delete',{paths:[e.path],passes});
          showToast(t('toast.secure_delete_success'),'success');
          await refreshColumns();
        } catch(err) {
          _sbProgress.error('Secure delete failed: '+err);
          showToast(t('error.secure_delete',{err}),'error');
        } finally {
          sdUnlisten?.();
        }
      }
      break;
    }
    case 'compare-files':{
      const es=getSelectedEntries().filter(e=>!e.is_dir);
      if(es.length===2) _showFileDiff(es[0].path, es[1].path);
      else showToast(t('toast.select_2_files'),'info');
      break;
    }
    case 'compare-dirs':{
      // r141: directory comparison
      const es=getSelectedEntries().filter(e=>e.is_dir);
      if(es.length===2) _showDirDiff(es[0].path, es[1].path);
      else showToast(t('toast.select_2_folders'),'info');
      break;
    }
    case 'move-to':{_showMoveToDialog('move');break;}
    case 'copy-to':{_showMoveToDialog('copy');break;}
    case 'compress':{const es=getSelectedEntries();if(es.length)compressEntries(es);break;}
    case 'extract':{const e=getSelectedEntry();if(e)extractArchive(e);break;}
    case 'mount-iso':{
      const e=getSelectedEntry();
      if(e){
        showToast(t('toast.mounting',{name:e.name}),'info');
        invoke('mount_iso',{path:e.path})
          .then(mp=>{
            showToast(t('toast.mounted_at',{path:mp}),'success');
            invoke('get_drives').then(d=>{state.sidebarData.drives=d;renderSidebar();});
            if(mp)navigate(mp,0);
          })
          .catch(err=>showToast(t('toast.mount_failed',{err}),'error'));
      }
      break;
    }
    case 'burn-iso':{
      const e=getSelectedEntry();
      if(e){
        invoke('list_usb_drives').then(drives=>{
          if(!drives||drives.length===0){showToast(t('toast.no_removable_drives'),'error');return;}
          // Select preview and let _showIsoBurnDialog (in views.js) handle it via loadPreview
          state.previewEntry=e;state.previewData=null;
          render();
          // Brief delay so preview panel renders, then trigger burn dialog
          setTimeout(()=>{
            const panel=document.getElementById('preview-panel');
            if(panel){
              const burnBtn=panel.querySelector('#iso-burn-btn');
              if(burnBtn)burnBtn.click();
            }
          },150);
        }).catch(err=>showToast(t('toast.drive_list_failed',{err}),'error'));
      }
      break;
    }
    case 'empty-trash':{
      if(!confirm('Permanently delete all items in Trash? This cannot be undone.'))break;
      _emptyTrashWithProgress().catch(err=>showToast(t('toast.trash_empty_failed',{err}),'error'));
      break;
    }
  }
}

// ── Open With dialog ─────────────────────────────────────────────────────────

// ── Duplicates results panel ──────────────────────────────────────────────────
function _showDuplicatesPanel(dups, dirName) {
  document.getElementById('ff-dups-overlay')?.remove();
  if (!dups || dups.length === 0) { showToast(t('toast.duplicates_found',{dir:dirName}),'info'); return; }
  // Flatten to count total wasted bytes
  let wastedBytes = 0;
  dups.forEach(group => {
    if (group.length < 2) return;
    // Size of all but the first (keeper) × count of duplicates
    // We don't have size here — show count
    wastedBytes += group.length - 1;
  });
  const overlay = document.createElement('div');
  overlay.id = 'ff-dups-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9300;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.65);backdrop-filter:blur(6px);';
  overlay.innerHTML = `
    <div style="background:#1a1a1d;border:1px solid rgba(255,255,255,.13);border-radius:16px;width:min(680px,92vw);max-height:80vh;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,.8);">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:20px 24px 16px;border-bottom:1px solid rgba(255,255,255,.07);">
        <div>
          <div style="font-size:15px;font-weight:600;color:#f1f5f9">Duplicate Files</div>
          <div style="font-size:11px;color:#636368;margin-top:3px">${dups.length} group${dups.length!==1?'s':''} · ${wastedBytes} redundant file${wastedBytes!==1?'s':''} in ${escHtml(dirName)}</div>
        </div>
        <button id="ff-dups-close" style="background:rgba(255,255,255,.07);border:none;border-radius:8px;color:#98989f;font-size:18px;width:32px;height:32px;cursor:pointer;display:flex;align-items:center;justify-content:center;">×</button>
      </div>
      <div id="ff-dups-list" style="overflow-y:auto;padding:12px 16px;flex:1;display:flex;flex-direction:column;gap:10px;"></div>
      <div style="padding:14px 24px;border-top:1px solid rgba(255,255,255,.07);display:flex;justify-content:flex-end;gap:8px;">
        <button id="ff-dups-close2" style="padding:7px 18px;background:rgba(255,255,255,.07);border:none;border-radius:8px;color:#98989f;font-size:13px;cursor:pointer;">Close</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('#ff-dups-close').addEventListener('click', close);
  overlay.querySelector('#ff-dups-close2').addEventListener('click', close);
  overlay.addEventListener('click', ev => { if (ev.target === overlay) close(); });

  const list = overlay.querySelector('#ff-dups-list');
  dups.forEach((group, gi) => {
    if (group.length < 2) return;
    const card = document.createElement('div');
    card.style.cssText = 'background:#111113;border:1px solid rgba(255,255,255,.08);border-radius:10px;overflow:hidden;';
    const header = document.createElement('div');
    header.style.cssText = 'padding:8px 12px;background:rgba(255,255,255,.03);font-size:10px;color:#636368;text-transform:uppercase;letter-spacing:.06em;display:flex;justify-content:space-between;align-items:center;';
    header.innerHTML = `<span>Group ${gi+1} · ${group.length} identical files</span><span style="color:#f87171">${group.length-1} duplicate${group.length-1!==1?'s':''}</span>`;
    card.appendChild(header);
    group.forEach((fpath, fi) => {
      const fname = fpath.split('/').pop();
      const fdir  = fpath.slice(0, fpath.lastIndexOf('/')) || '/';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:7px 12px;border-top:1px solid rgba(255,255,255,.05);';
      const keepBadge = fi === 0 ? '<span style="font-size:9px;padding:1px 5px;background:#059669;color:#fff;border-radius:4px;flex-shrink:0;">keep</span>' : '<span style="font-size:9px;padding:1px 5px;background:rgba(248,113,113,.2);color:#f87171;border-radius:4px;flex-shrink:0;">dup</span>';
      row.innerHTML = `
        ${keepBadge}
        <div style="flex:1;min-width:0;">
          <div style="font-size:12px;color:#e2e8f0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(fname)}</div>
          <div style="font-size:10px;color:#636368;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;">${escHtml(fdir)}</div>
        </div>
        ${fi > 0 ? '<button class="ff-dup-del-btn" data-path="'+escHtml(fpath)+'" style="padding:4px 10px;background:rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.3);border-radius:6px;color:#f87171;font-size:11px;cursor:pointer;flex-shrink:0;">Delete</button>' : ''}
        <button class="ff-dup-show-btn" data-path="${escHtml(fdir)}" style="padding:4px 10px;background:rgba(255,255,255,.06);border:none;border-radius:6px;color:#94a3b8;font-size:11px;cursor:pointer;flex-shrink:0;">Show</button>
      `;
      card.appendChild(row);
    });
    list.appendChild(card);
  });

  // Wire delete buttons
  list.querySelectorAll('.ff-dup-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const path = btn.dataset.path;
      if (!confirm('Delete duplicate:\n'+path+'\n\nThis cannot be undone.')) return;
      try {
        await invoke('delete_items', {paths: [path]});
        btn.closest('div[style*="border-top"]').remove();
        showToast(t('toast.deleted'),'success');
        await refreshColumns();
      } catch(err) { showToast(t('error.delete',{err}),'error','delete'); }
    });
  });

  // Wire show buttons - navigate to folder
  list.querySelectorAll('.ff-dup-show-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      close();
      navigate(btn.dataset.path, 0);
    });
  });
}


// ── Keyboard shortcut cheatsheet ─────────────────────────────────────────────
function _showShortcutCheatsheet() {
  document.getElementById('ff-cheatsheet')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'ff-cheatsheet';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9500;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.65);backdrop-filter:blur(6px);';
  const shortcuts = [
    ['Navigation',''],
    ['↑ ↓ ← →', 'Move selection / navigate columns'],
    ['Ctrl+\\', 'Toggle split pane'],
    ['Enter', 'Open selected'],
    ['Backspace', 'Go back'],
    ['Ctrl+L', 'Edit path in breadcrumb'],
    ['Right-click breadcrumb', 'Recent locations'],
    ['',''],
    ['Files',''],
    ['Ctrl+C', 'Copy'],
    ['Ctrl+X', 'Cut'],
    ['Ctrl+V', 'Paste'],
    ['Delete / F8', 'Move to Trash'],
    ['F2 / Enter on name', 'Rename'],
    ['Space', 'Quick Look'],
    ['Ctrl+A', 'Select all'],
    ['Type letters', 'Jump to file by name'],
    ['',''],
    ['View',''],
    ['Ctrl+T', 'New tab (current folder)'],
    ['Ctrl+W', 'Close tab'],
    ['Ctrl+Tab', 'Next tab'],
    ['Ctrl+F', 'Search'],
    ['Ctrl+H', 'Show/hide hidden files'],
    ['Ctrl+Shift+R', 'Batch rename'],
    ['',''],
    ['Gallery',''],
    ['+ / -', 'Zoom in/out'],
    ['0', 'Reset zoom'],
    ['F', 'Fit to window'],
    ['',''],
    ['App',''],
    ['Ctrl+Z / Ctrl+Y', 'Undo / Redo'],
    ['Ctrl+Shift+F', 'Advanced search (regex, content)'],
    ['Ctrl+Shift+P', 'Plugin manager'],
    ['Ctrl+,', 'Settings'],
    ['Ctrl+?', 'This cheatsheet'],
    ['F5', 'Refresh'],
    ['',''],
    ['Network',''],
    ['Ctrl+Shift+S', 'Connect SMB share'],
    ['Ctrl+Shift+O', 'Mount WebDAV / cloud'],
    ['Ctrl+Shift+G', 'Connect cloud storage (Drive, Dropbox, OneDrive)'],
    ['Ctrl+Shift+V', 'Encrypted vaults'],
    ['Ctrl+Shift+H', 'Connect SFTP'],
    ['Ctrl+Shift+J', 'Connect FTP'],
    ['',''],
    ['System',''],
    ['Ctrl+N', 'New window'],
    ['Ctrl+I', 'File permissions'],
    ['Ctrl+Alt+T', 'Open terminal here'],
    ['Ctrl+Shift+U', 'Disk usage'],
    ['Ctrl+Shift+Z', 'Undo history panel'],
    ['Shift+Delete', 'Permanently delete file'],
    ['F3', 'Toggle dual-pane view'],
    ['F5 (dual-pane)', 'Copy to other pane'],
    ['F6 (dual-pane)', 'Move to other pane'],
  ];
  const rows = shortcuts.map(([k,v]) => {
    if(!k && !v) return '<div style="height:8px"></div>';
    if(!v) return `<div style="font-size:10px;color:#636368;text-transform:uppercase;letter-spacing:.06em;padding:4px 0 2px;margin-top:2px;">${k}</div>`;
    return `<div style="display:flex;justify-content:space-between;gap:16px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04);">
      <kbd style="font-family:monospace;font-size:11px;color:#a78bfa;background:rgba(167,139,250,.1);padding:1px 6px;border-radius:4px;white-space:nowrap;">${escHtml(k)}</kbd>
      <span style="font-size:11.5px;color:#94a3b8;text-align:right;">${escHtml(v)}</span>
    </div>`;
  }).join('');
  overlay.innerHTML = `<div style="background:#1a1a1d;border:1px solid rgba(255,255,255,.13);border-radius:16px;width:min(480px,90vw);max-height:85vh;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,.8);">
    <div style="display:flex;justify-content:space-between;align-items:center;padding:18px 22px 14px;border-bottom:1px solid rgba(255,255,255,.07);">
      <span style="font-size:15px;font-weight:600;color:#f1f5f9;">Keyboard Shortcuts</span>
      <button id="ff-cs-close" style="background:rgba(255,255,255,.07);border:none;border-radius:8px;color:#98989f;font-size:18px;width:30px;height:30px;cursor:pointer;">×</button>
    </div>
    <div style="overflow-y:auto;padding:14px 22px 18px;flex:1;">${rows}</div>
  </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#ff-cs-close').addEventListener('click', close);
  overlay.addEventListener('click', ev => { if(ev.target===overlay) close(); });
  overlay.addEventListener('keydown', ev => { if(ev.key==='Escape') close(); });
}

// ── Copy/move conflict dialog ─────────────────────────────────────────────────
// Called before batch copy/move when destination files already exist.
// Returns 'replace' | 'skip' | 'cancel'
async function _showConflictDialog(conflicting) {
  return new Promise(resolve => {
    document.getElementById('ff-conflict-dlg')?.remove();
    const dlg = document.createElement('div');
    dlg.id = 'ff-conflict-dlg';
    dlg.style.cssText = 'position:fixed;inset:0;z-index:9400;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);';
    const names = conflicting.slice(0,5).map(n=>`<div style="font-size:11px;color:#94a3b8;padding:1px 0;">• ${escHtml(n)}</div>`).join('');
    const more = conflicting.length > 5 ? `<div style="font-size:11px;color:#636368;">…and ${conflicting.length-5} more</div>` : '';
    dlg.innerHTML = `<div style="background:#1e1e21;border:1px solid rgba(255,255,255,.13);border-radius:14px;padding:26px 26px 20px;min-width:360px;max-width:460px;box-shadow:0 16px 48px rgba(0,0,0,.75);">
      <div style="font-size:14px;font-weight:600;color:#f1f5f9;margin-bottom:8px;">⚠ File Conflict</div>
      <div style="font-size:12px;color:#94a3b8;margin-bottom:10px;">${conflicting.length} file${conflicting.length>1?'s':''} already exist at the destination:</div>
      <div style="background:#111113;border-radius:8px;padding:8px 12px;margin-bottom:16px;">${names}${more}</div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="ff-cf-cancel" style="padding:7px 14px;background:rgba(255,255,255,.07);border:none;border-radius:8px;color:#98989f;font-size:13px;cursor:pointer;">Cancel</button>
        <button id="ff-cf-skip" style="padding:7px 14px;background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.3);border-radius:8px;color:#fbbf24;font-size:13px;cursor:pointer;">Skip existing</button>
        <button id="ff-cf-replace" style="padding:7px 16px;background:#ef4444;border:none;border-radius:8px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;">Replace all</button>
      </div>
    </div>`;
    document.body.appendChild(dlg);
    dlg.querySelector('#ff-cf-cancel').addEventListener('click', () => { dlg.remove(); resolve('cancel'); });
    dlg.querySelector('#ff-cf-skip').addEventListener('click', () => { dlg.remove(); resolve('skip'); });
    dlg.querySelector('#ff-cf-replace').addEventListener('click', () => { dlg.remove(); resolve('replace'); });
    dlg.addEventListener('click', ev => { if(ev.target===dlg){ dlg.remove(); resolve('cancel'); } });
  });
}

// Check which source files would conflict with the destination directory.
// Uses get_entry_meta to probe whether dest/filename exists — one IPC per file.
// For large batches, caps at 20 checks to avoid blocking too long.
async function _checkConflicts(srcs, destDir) {
  const conflicting = [];
  // Performance cap: only check the first 20 sources to avoid flooding IPC.
  // When pasting more than 20 files, files beyond the cap are assumed conflict-free.
  // A warning toast is shown to the user so the behaviour is not silent.
  const CAP = 20;
  if (srcs.length > CAP) {
    showToast(t('toast.conflict_cap',{cap:CAP,total:srcs.length}),'info');
  }
  const toCheck = srcs.slice(0, CAP);
  await Promise.all(toCheck.map(async src => {
    const name = src.split('/').pop();
    const destPath = destDir + '/' + name;
    try {
      await invoke('get_entry_meta', {path: destPath});
      conflicting.push(name); // get_entry_meta succeeded → file exists
    } catch(_) { /* doesn't exist — no conflict */ }
  }));
  return conflicting;
}


// ── Advanced Search ───────────────────────────────────────────────────────────
// ── r53: Saved searches ──────────────────────────────────────────────────────
const FF_SAVED_KEY = 'ff_saved_searches';
function _getSavedSearches() {
  try { return JSON.parse(localStorage.getItem(FF_SAVED_KEY)||'[]'); } catch{ return []; }
}
function _setSavedSearches(arr) { localStorage.setItem(FF_SAVED_KEY, JSON.stringify(arr)); }
function _deleteSavedSearch(idx) {
  const arr = _getSavedSearches(); arr.splice(idx,1); _setSavedSearches(arr); renderSidebar();
}
function _runSavedSearch(s) {
  state.searchMode=true; state.searchQuery=(s.useRegex?'regex: ':'')+s.query;
  state.searchResults=[]; state.selIdx=-1; sel.clear();
  state.loading=true; render();
  invoke('search_advanced',{query:s.query,rootPath:s.rootPath||state.currentPath,recursive:true,useRegex:!!s.useRegex,searchContents:!!s.searchContents,includeHidden:!!s.includeHidden})
    .then(r=>{state.searchResults=r;}).catch(err=>showToast(t('error.search',{err}),'error'))
    .finally(()=>{state.loading=false;render();});
}

function _showAdvancedSearch() {
  document.getElementById('ff-advsearch')?.remove();
  const dlg = document.createElement('div');
  dlg.id = 'ff-advsearch';
  dlg.style.cssText = 'position:fixed;inset:0;z-index:9400;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);';
  dlg.innerHTML = `<div style="background:#1e1e21;border:1px solid rgba(255,255,255,.13);border-radius:14px;padding:24px 26px 20px;min-width:420px;max-width:520px;box-shadow:0 16px 48px rgba(0,0,0,.75);">
    <div style="font-size:14px;font-weight:600;color:#f1f5f9;margin-bottom:16px;">Advanced Search</div>
    <label style="display:block;font-size:11px;color:#98989f;margin-bottom:5px;text-transform:uppercase;letter-spacing:.06em;">Query</label>
    <input id="adv-query" style="width:100%;box-sizing:border-box;padding:9px 11px;background:#2a2a2d;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#f1f5f9;font-size:13px;outline:none;font-family:inherit;margin-bottom:12px;" placeholder="Search term or regex…" value="${escHtml(state.searchQuery||'')}"/>
    <div style="display:flex;gap:12px;margin-bottom:12px;flex-wrap:wrap;">
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#94a3b8;cursor:pointer;">
        <input type="checkbox" id="adv-regex" style="cursor:pointer;"> Use regex
      </label>
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#94a3b8;cursor:pointer;">
        <input type="checkbox" id="adv-contents" style="cursor:pointer;"> Search file contents
      </label>
      <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:#94a3b8;cursor:pointer;">
        <input type="checkbox" id="adv-hidden" style="cursor:pointer;" ${state.showHidden?'checked':''}> Include hidden
      </label>
    </div>
    <label style="display:block;font-size:11px;color:#98989f;margin-bottom:5px;text-transform:uppercase;letter-spacing:.06em;">Search in</label>
    <input id="adv-root" style="width:100%;box-sizing:border-box;padding:9px 11px;background:#2a2a2d;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#f1f5f9;font-size:13px;outline:none;font-family:inherit;margin-bottom:16px;" value="${escHtml(state.columns[0]?.path||state.currentPath||'')}"/>
    <div id="adv-err" style="color:#f87171;font-size:11px;min-height:14px;margin-bottom:8px;"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button id="adv-cancel" style="padding:7px 16px;background:rgba(255,255,255,.07);border:none;border-radius:8px;color:#98989f;font-size:13px;cursor:pointer;">Cancel</button>
      <button id="adv-save" style="padding:7px 16px;background:rgba(255,255,255,.07);border:none;border-radius:8px;color:#a78bfa;font-size:13px;cursor:pointer;">Save…</button>
      <button id="adv-ok" style="padding:7px 18px;background:#5b8dd9;border:none;border-radius:8px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;">Search</button>
    </div>
  </div>`;
  document.body.appendChild(dlg);
  const close = () => dlg.remove();
  dlg.querySelector('#adv-cancel').addEventListener('click', close);
  dlg.querySelector('#adv-save').addEventListener('click', () => {
    const query = dlg.querySelector('#adv-query').value.trim();
    if(!query){ dlg.querySelector('#adv-err').textContent='Enter a query to save'; return; }
    const name = prompt('Save search as:', query);
    if(!name) return;
    const arr = _getSavedSearches();
    arr.push({
      name,
      query,
      useRegex: dlg.querySelector('#adv-regex').checked,
      searchContents: dlg.querySelector('#adv-contents').checked,
      includeHidden: dlg.querySelector('#adv-hidden').checked,
      rootPath: dlg.querySelector('#adv-root').value.trim() || state.currentPath,
    });
    _setSavedSearches(arr);
    renderSidebar();
    showToast(t('toast.search_saved',{name}),'success');
  });
  dlg.addEventListener('click', ev => { if(ev.target===dlg) close(); });
  const queryEl = dlg.querySelector('#adv-query');
  queryEl.focus(); queryEl.select();
  const doSearch = async () => {
    const query = queryEl.value.trim();
    if(!query){ dlg.querySelector('#adv-err').textContent='Enter a search query'; return; }
    const useRegex = dlg.querySelector('#adv-regex').checked;
    const searchContents = dlg.querySelector('#adv-contents').checked;
    const includeHidden = dlg.querySelector('#adv-hidden').checked;
    const rootPath = dlg.querySelector('#adv-root').value.trim() || state.currentPath;
    close();
    state.searchMode=true; state.searchQuery=(useRegex?'regex: ':'')+query;
    state.searchResults=[]; state.selIdx=-1; sel.clear();
    state.loading=true; render();
    try{
      const results = await invoke('search_advanced',{query, rootPath, recursive:true, useRegex, searchContents, includeHidden});
      state.searchResults = results;
      announceA11y(`Search returned ${results.length} result${results.length===1?'':'s'}`);
    }catch(err){showToast(t('error.search',{err}),'error','search');}
    finally{state.loading=false; render();}
  };
  dlg.querySelector('#adv-ok').addEventListener('click', doSearch);
  queryEl.addEventListener('keydown', e=>{ if(e.key==='Enter') doSearch(); if(e.key==='Escape') close(); });
}


// ── Move to / Copy to folder picker ──────────────────────────────────────────
async function _showMoveToDialog(op) {
  const entries = getSelectedEntries();
  if(!entries.length){ showToast(t('toast.select_files_first'),'info'); return; }
  document.getElementById('ff-moveto-dlg')?.remove();
  const dlg = document.createElement('div');
  dlg.id = 'ff-moveto-dlg';
  dlg.style.cssText = 'position:fixed;inset:0;z-index:9400;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);';
  const label = op==='copy' ? 'Copy' : 'Move';
  // Build recent paths as quick picks
  const recent = _getPathHistory().slice(0,8);
  const recentHtml = recent.length ? '<div style="margin-bottom:8px;"><div style="font-size:10px;color:#636368;text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px;">Recent locations</div>'+
    recent.map(p=>`<div class="moveto-recent" data-path="${p.replace(/"/g,'&quot;')}" style="padding:5px 8px;border-radius:6px;cursor:pointer;font-size:12px;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${p.replace(/"/g,'&quot;')}">${p.split('/').filter(Boolean).slice(-2).join('/')}</div>`).join('')+'</div>' : '';
  dlg.innerHTML = `<div style="background:#1e1e21;border:1px solid rgba(255,255,255,.13);border-radius:14px;padding:24px 26px 20px;min-width:440px;max-width:540px;box-shadow:0 16px 48px rgba(0,0,0,.75);">
    <div style="font-size:14px;font-weight:600;color:#f1f5f9;margin-bottom:16px;">${label} ${entries.length} item${entries.length!==1?'s':''} to…</div>
    ${recentHtml}
    <label style="display:block;font-size:11px;color:#98989f;margin-bottom:5px;text-transform:uppercase;letter-spacing:.06em;">Destination path</label>
    <input id="moveto-path" style="width:100%;box-sizing:border-box;padding:9px 11px;background:#2a2a2d;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#f1f5f9;font-size:13px;outline:none;font-family:inherit;margin-bottom:6px;" placeholder="/home/user/destination" value="${escHtml(state.currentPath)}"/>
    <div id="moveto-err" style="color:#f87171;font-size:11px;min-height:14px;margin-bottom:12px;"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button id="moveto-cancel" style="padding:7px 16px;background:rgba(255,255,255,.07);border:none;border-radius:8px;color:#98989f;font-size:13px;cursor:pointer;">Cancel</button>
      <button id="moveto-ok" style="padding:7px 18px;background:${op==='copy'?'#059669':'#5b8dd9'};border:none;border-radius:8px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;">${label} here</button>
    </div>
  </div>`;
  document.body.appendChild(dlg);
  const pathEl = dlg.querySelector('#moveto-path');
  const errEl = dlg.querySelector('#moveto-err');
  const close = () => dlg.remove();
  dlg.querySelector('#moveto-cancel').addEventListener('click', close);
  dlg.addEventListener('click', ev => { if(ev.target===dlg) close(); });
  // Recent path clicks
  dlg.querySelectorAll('.moveto-recent').forEach(el => {
    el.addEventListener('mouseenter', () => el.style.background='rgba(255,255,255,.07)');
    el.addEventListener('mouseleave', () => el.style.background='');
    el.addEventListener('click', () => { pathEl.value = el.dataset.path; pathEl.focus(); });
  });
  const doMove = async () => {
    const destDir = pathEl.value.trim();
    if(!destDir){ errEl.textContent='Enter a destination path'; return; }
    const srcs = entries.map(e=>e.path);
    // Conflict check for copy
    if(op==='copy'){
      const conflicts = await _checkConflicts(srcs, destDir);
      if(conflicts.length){
        const action = await _showConflictDialog(conflicts);
        if(action==='cancel') return;
        if(action==='skip'){
          const cs = new Set(conflicts);
          srcs.splice(0, srcs.length, ...srcs.filter(s=>!cs.has(s.split('/').pop())));
          if(!srcs.length){ close(); return; }
        }
      }
    }
    close();
    const total = srcs.length;
    const cmd = op==='copy' ? 'copy_files_batch' : 'move_files_batch';
    _sbProgress.start((op==='copy'?'Copying':'Moving')+' 0 / '+total, total);
    let errors=0, undoItems=[];
    let _res; const done = new Promise(r=>{ _res=r; });
    const ul = await listen('file-op-progress', ev => {
      const {done:d,total:t,error,finished}=ev.payload;
      if(error) errors++;
      else { const s=srcs[d-1]; if(s) undoItems.push({src:s,dst:destDir+'/'+s.split('/').pop(),srcDir:s.substring(0,s.lastIndexOf('/')),dstDir:destDir}); }
      _sbProgress.update(d,t,(op==='copy'?'Copying':'Moving')+' '+d+' / '+t);
      if(finished) _res();
    });
    invoke(cmd,{srcs,destDir}).catch(err=>{showToast(label+' failed: '+err,'error');_res();});
    await done; ul();
    _sbProgress.finish(errors===0, errors>0?errors+' error(s)':(op==='copy'?'Copy':'Move')+' complete');
    const ok=total-errors;
    if(ok>0){ showToast(ok+' item'+(ok>1?'s':'')+' '+(op==='copy'?'copied':'moved'),'success'); if(undoItems.length) pushUndo({op,items:undoItems}); }
    if(errors>0) showToast(errors+' item'+(errors>1?'s':'')+' failed','error');
    await refreshColumns();
  };
  dlg.querySelector('#moveto-ok').addEventListener('click', doMove);
  pathEl.addEventListener('keydown', e=>{ if(e.key==='Enter') doMove(); if(e.key==='Escape') close(); });
  setTimeout(()=>{ pathEl.focus(); pathEl.setSelectionRange(pathEl.value.length,pathEl.value.length); }, 50);
}


// ── Plugin Management UI ──────────────────────────────────────────────────────
async function _showPluginManager() {
  document.getElementById('ff-plugins-dlg')?.remove();
  let plugins = [];
  try { plugins = await invoke('load_plugins'); } catch {}

  const render = () => {
    const dlg = document.getElementById('ff-plugins-dlg');
    const list = dlg?.querySelector('#pm-list');
    if(!list) return;
    if(!plugins.length){
      list.innerHTML = '<div style="color:#636368;font-size:12px;padding:12px 0;text-align:center;">No plugins installed.<br>Add a plugin below.</div>';
      return;
    }
    list.innerHTML = plugins.map((p,i) => `
      <div class="pm-row" data-idx="${i}">
        <div style="flex:1;min-width:0;">
          <div style="font-size:13px;color:#f1f5f9;font-weight:500;">${escHtml(p.name)}</div>
          <div style="font-size:10.5px;color:#636368;margin-top:2px;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(p.command)}">${escHtml(p.command)}</div>
          ${p.match&&p.match!=='*'?`<div style="font-size:10px;color:#a78bfa;margin-top:1px;">match: ${escHtml(p.match)}</div>`:''}
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-shrink:0;">
          <button class="pm-del" data-idx="${i}" style="background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.25);border-radius:6px;color:#f87171;font-size:11px;padding:3px 8px;cursor:pointer;">Remove</button>
        </div>
      </div>`).join('');
    list.querySelectorAll('.pm-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        plugins.splice(+btn.dataset.idx, 1);
        await invoke('save_plugins', {plugins});
        _plugins = plugins.slice();
        render();
      });
    });
  };

  const overlay = document.createElement('div');
  overlay.id = 'ff-plugins-dlg';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9400;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.65);backdrop-filter:blur(6px);';
  overlay.innerHTML = `<div style="background:#1a1a1d;border:1px solid rgba(255,255,255,.13);border-radius:16px;width:min(580px,92vw);max-height:80vh;display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,.8);">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 22px 14px;border-bottom:1px solid rgba(255,255,255,.07);">
      <span style="font-size:15px;font-weight:600;color:#f1f5f9;">Plugins</span>
      <button id="pm-close" style="background:rgba(255,255,255,.07);border:none;border-radius:8px;color:#98989f;font-size:18px;width:30px;height:30px;cursor:pointer;">×</button>
    </div>
    <div id="pm-list" style="overflow-y:auto;padding:10px 16px;flex:1;display:flex;flex-direction:column;gap:8px;"></div>
    <!-- r178: Starter plugin discovery -->
    <div style="padding:8px 16px 0;border-top:1px solid rgba(255,255,255,.07);">
      <details id="pm-discover">
        <summary style="font-size:11px;color:#636368;text-transform:uppercase;letter-spacing:.06em;cursor:pointer;padding:4px 0;list-style:none;display:flex;align-items:center;gap:6px;">
          <span>&#9656;</span> Starter plugins
        </summary>
        <div id="pm-starter-list" style="display:flex;flex-direction:column;gap:5px;margin-top:8px;max-height:200px;overflow-y:auto;padding-bottom:8px;"></div>
      </details>
    </div>
    <div style="padding:14px 22px;border-top:1px solid rgba(255,255,255,.07);">
      <div style="font-size:11px;color:#636368;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px;">Add plugin</div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        <input id="pm-name" placeholder="Name (e.g. Compress with zstd)" style="padding:7px 10px;background:#2a2a2d;border:1px solid rgba(255,255,255,.1);border-radius:7px;color:#f1f5f9;font-size:12px;outline:none;font-family:inherit;"/>
        <input id="pm-cmd" placeholder="Command (use {path}, {name}, {dir}, {ext})" style="padding:7px 10px;background:#2a2a2d;border:1px solid rgba(255,255,255,.1);border-radius:7px;color:#f1f5f9;font-size:12px;outline:none;font-family:monospace;"/>
        <div style="display:flex;gap:8px;">
          <input id="pm-match" placeholder="File match (e.g. *.mp4 or *)" style="flex:1;padding:7px 10px;background:#2a2a2d;border:1px solid rgba(255,255,255,.1);border-radius:7px;color:#f1f5f9;font-size:12px;outline:none;font-family:monospace;"/>
          <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:#94a3b8;cursor:pointer;white-space:nowrap;"><input type="checkbox" id="pm-multi"> Multi-file</label>
          <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:#94a3b8;cursor:pointer;white-space:nowrap;"><input type="checkbox" id="pm-confirm" checked> Confirm</label>
        </div>
        <div id="pm-err" style="color:#f87171;font-size:11px;min-height:12px;"></div>
        <details style="font-size:11px;color:#636368;margin-top:2px;">
          <summary style="cursor:pointer;padding:2px 0;">Parameters (optional — shown before execution)</summary>
          <div style="margin-top:6px;">
            <div style="font-size:10.5px;color:#636368;margin-bottom:4px;">One per line: <code style="color:#a78bfa;">name|Label|placeholder|default</code></div>
            <textarea id="pm-params" rows="3" placeholder="e.g. quality|JPEG quality|1-100|85" style="width:100%;box-sizing:border-box;padding:7px 10px;background:#2a2a2d;border:1px solid rgba(255,255,255,.1);border-radius:7px;color:#f1f5f9;font-size:11px;outline:none;font-family:monospace;resize:vertical;"></textarea>
          </div>
        </details>
        <button id="pm-add" style="padding:7px 16px;background:#5b8dd9;border:none;border-radius:8px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;align-self:flex-end;">Add Plugin</button>
      </div>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  render();

  // r178: Starter plugins — load lazily on expand
  const _STARTER_PLUGINS = [
    {name:'Convert to MP4 (ffmpeg)',    command:'ffmpeg -i {path} -c:v libx264 -crf 23 "{dir}/{name}.mp4"', match:'*.{mkv,avi,mov,webm}', icon:'🎬'},
    {name:'Resize image 50% (mogrify)', command:'mogrify -resize 50% {path}',     match:'*.{jpg,jpeg,png}',           icon:'🖼'},
    {name:'Optimize PNG (optipng)',     command:'optipng -o5 {path}',             match:'*.png',                      icon:'🗜'},
    {name:'Convert to WebP',            command:'cwebp -q 80 {path} -o "{dir}/{name}.webp"', match:'*.{jpg,jpeg,png}',icon:'🔄'},
    {name:'Git log (this dir)',         command:'git -C {dir} log --oneline -20', match:'*',                         icon:'📜', notify:false},
    {name:'Git status',                 command:'git -C {dir} status',            match:'*',                         icon:'🌿', notify:false},
    {name:'Word count',                 command:'wc -w {path}',                   match:'*.{txt,md}',                icon:'🔢', notify:false},
    {name:'PDF page count',             command:'pdfinfo {path} | grep Pages',    match:'*.pdf',                     icon:'📄', notify:false},
    {name:'Strip EXIF data',            command:'exiftool -all= {path}',          match:'*.{jpg,jpeg,png,tiff}',     icon:'🔒'},
    {name:'Compress to ZIP',            command:'zip -j "{dir}/{name}.zip" {path}',match:'*',                        icon:'📦'},
  ];

  overlay.querySelector('#pm-discover')?.addEventListener('toggle', ev => {
    if(!ev.target.open) return;
    const list = overlay.querySelector('#pm-starter-list');
    if(!list || list.dataset.loaded) return;
    list.dataset.loaded = '1';
    list.innerHTML = _STARTER_PLUGINS.map((sp,i) =>
      `<div style="display:flex;align-items:center;gap:8px;padding:5px 8px;background:rgba(255,255,255,.03);border-radius:6px;">
        <span style="font-size:14px;flex-shrink:0;">${sp.icon||'▶'}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:12px;color:#f1f5f9;font-weight:500;">${escHtml(sp.name)}</div>
          <div style="font-size:10px;color:#636368;font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(sp.match)}</div>
        </div>
        <button class="pm-starter-add" data-idx="${i}" style="padding:3px 10px;background:#5b8dd9;border:none;border-radius:6px;color:#fff;font-size:11px;font-weight:600;cursor:pointer;">+ Add</button>
      </div>`
    ).join('');
    list.querySelectorAll('.pm-starter-add').forEach(btn => {
      btn.addEventListener('click', async () => {
        const sp = _STARTER_PLUGINS[+btn.dataset.idx];
        const id = 'plugin_' + Date.now();
        plugins.push({id, name:sp.name, command:sp.command, match:sp.match||'*',
          multi:false, confirm:false, notify:sp.notify??true});
        try {
          await invoke('save_plugins', {plugins});
          _plugins = plugins.slice();
          btn.textContent = '✓ Added'; btn.disabled = true;
          render();
          showToast(t('toast.plugin_added',{name:sp.name}),'success');
        } catch(e) { showToast(t('toast.save_failed',{err:e}),'error'); }
      });
    });
  });

  const close = () => overlay.remove();
  overlay.querySelector('#pm-close').addEventListener('click', close);
  overlay.addEventListener('click', ev => { if(ev.target===overlay) close(); });

  overlay.querySelector('#pm-add').addEventListener('click', async () => {
    const name = overlay.querySelector('#pm-name').value.trim();
    const cmd  = overlay.querySelector('#pm-cmd').value.trim();
    const match = overlay.querySelector('#pm-match').value.trim() || '*';
    const multi = overlay.querySelector('#pm-multi').checked;
    const confirm_ = overlay.querySelector('#pm-confirm').checked;
    const errEl = overlay.querySelector('#pm-err');
    if(!name){ errEl.textContent='Name required'; return; }
    if(!cmd){  errEl.textContent='Command required'; return; }
    errEl.textContent='';
    const id = 'plugin_'+Date.now();
    // r177: parse optional params textarea
    const paramsRaw = overlay.querySelector('#pm-params')?.value.trim() || '';
    const params = paramsRaw ? paramsRaw.split('\n').filter(Boolean).map(line => {
      const parts = line.split('|');
      return { name:(parts[0]||'').trim()||'param', label:(parts[1]||parts[0]||'').trim()||'Value',
               placeholder:(parts[2]||'').trim()||undefined, default:(parts[3]||'').trim()||undefined };
    }).filter(p=>p.name) : undefined;
    plugins.push({id,name,command:cmd,match,multi,confirm:confirm_,notify:true,...(params&&params.length?{params}:{})});
    try{ await invoke('save_plugins',{plugins}); _plugins=plugins.slice(); }
    catch(e){ errEl.textContent='Save failed: '+e; return; }
    overlay.querySelector('#pm-name').value='';
    overlay.querySelector('#pm-cmd').value='';
    overlay.querySelector('#pm-match').value='';
    render();
    showToast(t('toast.plugin_added',{name}),'success');
  });
}


// ── File comparison / diff ────────────────────────────────────────────────────
async function _showFileDiff(pathA, pathB) {
  document.getElementById('ff-diff-dlg')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'ff-diff-dlg';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9400;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);backdrop-filter:blur(6px);';
  const nameA = pathA.split('/').pop();
  const nameB = pathB.split('/').pop();
  overlay.innerHTML = `<div style="background:#1a1a1d;border:1px solid rgba(255,255,255,.13);border-radius:16px;width:min(860px,96vw);height:min(680px,90vh);display:flex;flex-direction:column;box-shadow:0 24px 64px rgba(0,0,0,.85);">
    <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px 12px;border-bottom:1px solid rgba(255,255,255,.07);flex-shrink:0;">
      <div>
        <div style="font-size:14px;font-weight:600;color:#f1f5f9;">File Comparison</div>
        <div style="font-size:11px;color:#636368;margin-top:2px;font-family:monospace;">${escHtml(nameA)} <span style="color:#5b8dd9;">↔</span> ${escHtml(nameB)}</div>
      </div>
      <button id="diff-close" style="background:rgba(255,255,255,.07);border:none;border-radius:8px;color:#98989f;font-size:18px;width:30px;height:30px;cursor:pointer;">×</button>
    </div>
    <div id="diff-body" style="flex:1;overflow:auto;padding:12px 16px;font-family:monospace;font-size:12px;line-height:1.6;">
      <div style="display:flex;align-items:center;gap:10px;color:#636368;"><div class="spinner" style="width:14px;height:14px;"></div> Computing diff…</div>
    </div>
    <div id="diff-footer" style="padding:10px 20px;border-top:1px solid rgba(255,255,255,.07);font-size:11px;color:#636368;flex-shrink:0;"></div>
  </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector('#diff-close').addEventListener('click', close);
  overlay.addEventListener('click', ev => { if(ev.target===overlay) close(); });
  overlay.addEventListener('keydown', ev => { if(ev.key==='Escape') close(); });

  try {
    const result = await invoke('diff_files', {pathA, pathB});
    const body = overlay.querySelector('#diff-body');
    const footer = overlay.querySelector('#diff-footer');

    if(result.binary) {
      body.innerHTML = '<div style="color:#f87171;padding:20px 0;">Binary files cannot be diffed as text.</div>';
      return;
    }
    if(!result.unified.trim()) {
      body.innerHTML = '<div style="color:#34d399;padding:20px 0;display:flex;align-items:center;gap:8px;"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;"><polyline points="2,8 6,12 14,4"/></svg> Files are identical.</div>';
      footer.textContent = 'No differences found.';
      return;
    }

    footer.innerHTML = `<span style="color:#34d399;">+${result.additions} addition${result.additions!==1?'s':''}</span>  <span style="color:#f87171;">−${result.deletions} deletion${result.deletions!==1?'s':''}</span>`;

    // Render unified diff with syntax colouring
    const lines = result.unified.split('\n');
    body.innerHTML = lines.map(line => {
      let color = 'var(--text-primary)';
      let bg = 'transparent';
      if(line.startsWith('+++') || line.startsWith('---')) { color='#636368'; }
      else if(line.startsWith('@@')) { color='#a78bfa'; bg='rgba(167,139,250,.07)'; }
      else if(line.startsWith('+')) { color='#34d399'; bg='rgba(52,211,153,.08)'; }
      else if(line.startsWith('-')) { color='#f87171'; bg='rgba(248,113,113,.08)'; }
      return `<div style="color:${color};background:${bg};padding:0 6px;white-space:pre;border-radius:2px;">${escHtml(line)||'\u00a0'}</div>`;
    }).join('');
  } catch(err) {
    overlay.querySelector('#diff-body').innerHTML = `<div style="color:#f87171;">Diff failed: ${escHtml(String(err))}</div>`;
  }
}


// ── r142: Directory diff panel ────────────────────────────────────────────────
// Three-column layout: left-only (red) | both (green/yellow) | right-only (blue).
// Clicking any row navigates to that file in the main or pane-B pane.
// Sync buttons copy missing files in either direction.
async function _showDirDiff(pathLeft, pathRight) {
  document.getElementById('ff-dir-diff')?.remove();
  const nameL = pathLeft.split('/').filter(Boolean).pop() || pathLeft;
  const nameR = pathRight.split('/').filter(Boolean).pop() || pathRight;

  const ov = document.createElement('div');
  ov.id = 'ff-dir-diff';
  ov.style.cssText = 'position:fixed;inset:0;z-index:9450;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.65);backdrop-filter:blur(7px);';
  ov.innerHTML = `
    <div class="dir-diff-box">
      <div class="dir-diff-header">
        <div class="dir-diff-title">
          <span>Directory Comparison</span>
          <span class="dir-diff-paths">
            <span class="dir-diff-path dir-diff-path-l" title="${escHtml(pathLeft)}">${escHtml(nameL)}</span>
            <span style="opacity:.4;margin:0 6px;">↔</span>
            <span class="dir-diff-path dir-diff-path-r" title="${escHtml(pathRight)}">${escHtml(nameR)}</span>
          </span>
        </div>
        <button class="dir-diff-close" id="dirdiff-close">✕</button>
      </div>
      <div class="dir-diff-stats" id="dirdiff-stats">
        <div class="spinner" style="width:14px;height:14px;margin-right:8px;"></div> Comparing…
      </div>
      <div class="dir-diff-cols-header">
        <div class="dir-diff-col-hdr dir-diff-col-l">Only in <strong>${escHtml(nameL)}</strong></div>
        <div class="dir-diff-col-hdr dir-diff-col-m">In both</div>
        <div class="dir-diff-col-hdr dir-diff-col-r">Only in <strong>${escHtml(nameR)}</strong></div>
      </div>
      <div class="dir-diff-cols" id="dirdiff-cols">
        <div class="dir-diff-col dir-diff-col-l" id="dirdiff-left"></div>
        <div class="dir-diff-col dir-diff-col-m" id="dirdiff-mid"></div>
        <div class="dir-diff-col dir-diff-col-r" id="dirdiff-right"></div>
      </div>
      <div class="dir-diff-footer" id="dirdiff-footer">
        <button class="dir-diff-sync-btn" id="dirdiff-sync-lr" disabled title="Copy missing files from ${escHtml(nameL)} → ${escHtml(nameR)}">
          ← Copy missing to ${escHtml(nameR)}
        </button>
        <button class="dir-diff-sync-btn" id="dirdiff-sync-rl" disabled title="Copy missing files from ${escHtml(nameR)} → ${escHtml(nameL)}">
          Copy missing to ${escHtml(nameL)} →
        </button>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const close = () => ov.remove();
  ov.querySelector('#dirdiff-close').addEventListener('click', close);
  ov.addEventListener('click', ev => { if(ev.target === ov) close(); });
  ov.addEventListener('keydown', ev => { if(ev.key === 'Escape') close(); });

  let _diffResult = null;

  // ── Load diff ──────────────────────────────────────────────────────────────
  try {
    _diffResult = await invoke('compare_dirs', {pathLeft, pathRight});
  } catch(err) {
    ov.querySelector('#dirdiff-stats').innerHTML =
      `<span style="color:#f87171;">Compare failed: ${escHtml(String(err))}</span>`;
    return;
  }

  const { entries, only_left, only_right, same, different } = _diffResult;

  // ── Stats bar ─────────────────────────────────────────────────────────────
  ov.querySelector('#dirdiff-stats').innerHTML =
    `<span class="dds-chip dds-l">${only_left} only in ${escHtml(nameL)}</span>`
    + `<span class="dds-chip dds-m">${same} same · ${different} differ</span>`
    + `<span class="dds-chip dds-r">${only_right} only in ${escHtml(nameR)}</span>`;

  // ── Render entries into three columns ────────────────────────────────────
  const makeRow = (entry, side) => {
    const icon = entry.is_dir ? '📁' : '📄';
    const size = (!entry.is_dir && side === 'l' && entry.size_left != null) ? fmtSize(entry.size_left)
               : (!entry.is_dir && side === 'r' && entry.size_right != null) ? fmtSize(entry.size_right)
               : (!entry.is_dir && entry.size_left != null) ? fmtSize(entry.size_left) : '';
    const diffBadge = (side === 'm' && entry.status === 'Different')
      ? '<span class="ddr-diff-badge">differs</span>' : '';
    return `<div class="ddr" data-rel="${escHtml(entry.rel_path)}" data-side="${side}" data-isdir="${entry.is_dir}">
      <span class="ddr-icon">${icon}</span>
      <span class="ddr-name" title="${escHtml(entry.rel_path)}">${escHtml(entry.name)}</span>
      ${size ? `<span class="ddr-size">${size}</span>` : ''}
      ${diffBadge}
    </div>`;
  };

  const colL   = ov.querySelector('#dirdiff-left');
  const colM   = ov.querySelector('#dirdiff-mid');
  const colR   = ov.querySelector('#dirdiff-right');

  const rowsL = entries.filter(e => e.status === 'OnlyLeft');
  const rowsM = entries.filter(e => e.status === 'Same' || e.status === 'Different');
  const rowsR = entries.filter(e => e.status === 'OnlyRight');

  colL.innerHTML = rowsL.length ? rowsL.map(e => makeRow(e,'l')).join('') : '<div class="ddr-empty">Nothing</div>';
  colM.innerHTML = rowsM.length ? rowsM.map(e => makeRow(e,'m')).join('') : '<div class="ddr-empty">Nothing</div>';
  colR.innerHTML = rowsR.length ? rowsR.map(e => makeRow(e,'r')).join('') : '<div class="ddr-empty">Nothing</div>';

  // ── Row click: navigate to the file ──────────────────────────────────────
  ov.querySelectorAll('.ddr[data-rel]').forEach(row => {
    row.addEventListener('click', () => {
      const rel  = row.dataset.rel;
      const side = row.dataset.side;
      const isDir = row.dataset.isdir === 'true';
      // Derive absolute path for the side clicked
      const absPath = side === 'r'
        ? pathRight + '/' + rel
        : pathLeft  + '/' + rel;
      const parentPath = absPath.substring(0, absPath.lastIndexOf('/'));
      close();
      if(isDir) { navigate(absPath, 0); }
      else       { navigate(parentPath, 0); }
    });
  });

  // ── T4 Sync buttons ───────────────────────────────────────────────────────
  const btnLR = ov.querySelector('#dirdiff-sync-lr');
  const btnRL = ov.querySelector('#dirdiff-sync-rl');

  if(only_left > 0)  btnLR.disabled = false;
  if(only_right > 0) btnRL.disabled = false;

  const doSync = async (srcs, destDir, label) => {
    close();
    const jobId = _sbProgress.addJob(label + ' 0 / ' + srcs.length, srcs.length, null);
    let ul;
    try {
      let _res; const done = new Promise(r => { _res = r; });
      ul = await listen('file-op-progress', ev => {
        const { done: d, total: t, finished } = ev.payload;
        _sbProgress.updateJob(jobId, d, t, `${label} ${d} / ${t}`);
        if(finished) _res();
      });
      await invoke('copy_files_batch', { srcs, destDir });
      await done;
      _sbProgress.finishJob(jobId, true, `${label} — done`);
      showToast(t('toast.copied',{n:srcs.length}),'success');
      refreshColumns();
    } catch(err) {
      _sbProgress.finishJob(jobId, false, 'Copy failed');
      showToast(t('error.drop_failed',{err}),'error');
    } finally { ul?.(); }
  };

  btnLR.addEventListener('click', async () => {
    // Copy files only_left → pathRight
    const missing = rowsL.filter(e => !e.is_dir).map(e => pathLeft + '/' + e.rel_path);
    if(!missing.length) { showToast(t('toast.no_files_to_copy'),'info'); return; }
    await doSync(missing, pathRight, `Copying to ${nameR}`);
  });

  btnRL.addEventListener('click', async () => {
    // Copy files only_right → pathLeft
    const missing = rowsR.filter(e => !e.is_dir).map(e => pathRight + '/' + e.rel_path);
    if(!missing.length) { showToast(t('toast.no_files_to_copy'),'info'); return; }
    await doSync(missing, pathLeft, `Copying to ${nameL}`);
  });
}

// ── Split-pane ────────────────────────────────────────────────────────────────
// r107: extended pane B state — viewMode, search, entries cache
const _paneB = {
  active: false, path: '', columns: [], entries: [],
  viewMode: localStorage.getItem('ff_pb_viewMode') || 'list',
  showHidden: false, history: [], historyIdx: -1,
  selIdx: -1, loading: false, _focused: false,
  search: '', _searchQuery: '',
};

function isPaneBFocused() { return _paneB.active && _paneB._focused; }

function _toggleSplitPane() {
  _paneB.active = !_paneB.active;
  const paneB = document.getElementById('pane-b');
  const divider = document.getElementById('split-divider');
  if(!paneB || !divider) return;
  if(_paneB.active) {
    paneB.style.display = '';
    divider.style.display = '';
    _initSplitDivider();
    if(!_paneB.path) {
      _paneB.path = state.currentPath || '';
      _paneB.history = _paneB.path ? [_paneB.path] : [];
      _paneB.historyIdx = _paneB.path ? 0 : -1;
    }
    // r23: navigate to populate columns — calling _renderPaneB() directly left
    // _paneB.columns empty, which triggered the empty-state guard and showed blank.
    if(_paneB.path) _navigatePaneB(_paneB.path);
    else _renderPaneB();
  } else {
    paneB.style.display = 'none';
    divider.style.display = 'none';
    _paneB._focused = false;
    // r24: clear inline flex override so view-host snaps back to full width
    const viewHost = document.getElementById('view-host');
    if(viewHost) viewHost.style.flex = '';
  }
  sessionStorage.setItem('ff_split_active', _paneB.active ? '1' : '0'); // r21: per-window
  renderToolbar();
}

function _initSplitDivider() {
  const divider = document.getElementById('split-divider');
  const wrap = document.getElementById('split-wrap');
  if(!divider || !wrap || divider._bound) return;
  divider._bound = true;
  let dragging = false;
  let frac = parseFloat(localStorage.getItem('ff_pane_split') || '0.5');
  const applyFrac = f => {
    frac = Math.min(0.8, Math.max(0.2, f));
    const pA = document.getElementById('view-host');
    const pB = document.getElementById('pane-b');
    if(pA) pA.style.flex = `0 0 ${frac * 100}%`;
    if(pB) pB.style.flex = `0 0 ${(1-frac) * 100}%`;
  };
  applyFrac(frac);
  divider.addEventListener('mousedown', e => {
    if(e.button !== 0) return;
    dragging = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if(!dragging) return;
    const r = wrap.getBoundingClientRect();
    applyFrac((e.clientX - r.left) / r.width);
  });
  document.addEventListener('mouseup', () => {
    if(!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    localStorage.setItem('ff_pane_split', String(frac));
  });
  divider.addEventListener('dblclick', () => { applyFrac(0.5); localStorage.setItem('ff_pane_split', '0.5'); });
}

async function _navigatePaneB(path) {
  _paneB.loading = true; _paneB._searchQuery = ''; _renderPaneB();
  try {
    const result = await listDirectoryFullStreamed(path, (partial)=>{
      _paneB.columns=[{path,entries:partial,selIdx:-1}];
      _paneB.entries=partial;
      _paneB.loading=false; _renderPaneB();
    });
    _paneB.columns = [{path, entries: result.entries, selIdx: -1}];
    _paneB.entries = result.entries;
    _paneB.path = path;
    _paneB.selIdx = -1;
    if(_paneB.history[_paneB.historyIdx] !== path) {
      _paneB.history = _paneB.history.slice(0, _paneB.historyIdx + 1);
      _paneB.history.push(path); _paneB.historyIdx = _paneB.history.length - 1;
    }
  } catch(e) { showToast(t('error.pane_b',{err:e}),'error'); }
  _paneB.loading = false; _renderPaneB();
}

// r107-r124: rewritten _renderPaneB — shared renderer, real icons, full toolbar
function _renderPaneB() {
  const host = document.getElementById('pane-b');
  if(!host || !_paneB.active) return;

  if(_paneB.loading) {
    host.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;gap:10px;color:var(--text-tertiary);font-size:13px"><div class="spinner"></div>Loading…</div>';
    return;
  }
  if(!_paneB.path || !_paneB.columns.length) {
    host.innerHTML = '<div class="view-empty-state"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" style="width:36px;height:36px;opacity:.25"><rect x="6" y="10" width="36" height="30" rx="3"/><path d="M6 18h36"/><path d="M6 10l8-4h20l8 4"/></svg><div>Empty</div></div>';
    return;
  }

  // ── r107: Shared entry-list renderer ──────────────────────────────────────
  // renderPane(host, paneState) can be called for either pane with its own
  // state object — this is the extracted shared renderer the roadmap calls for.
  const col  = _paneB.columns[_paneB.columns.length - 1];
  let allEntries = (col.entries || []).filter(e => _paneB.showHidden || !e.is_hidden);

  // ── r109: Apply inline search filter ──────────────────────────────────────
  const q = (_paneB._searchQuery || '').toLowerCase().trim();
  const entries = q ? allEntries.filter(e => e.name.toLowerCase().includes(q)) : allEntries;

  const canBack = _paneB.historyIdx > 0;
  const canFwd  = _paneB.historyIdx < _paneB.history.length - 1;

  // ── r108: Breadcrumb trail ─────────────────────────────────────────────────
  const parts = _paneB.path.split('/').filter(Boolean);
  const crumbs = parts.map((seg, i) => {
    const crumbPath = '/' + parts.slice(0, i + 1).join('/');
    return `<span class="pb-crumb" data-path="${escHtml(crumbPath)}" title="${escHtml(crumbPath)}">${escHtml(seg)}</span>`;
  }).join('<span class="pb-crumb-sep">/</span>');

  // ── r108: View mode buttons ────────────────────────────────────────────────
  const vmBtns = ['list','icon'].map(vm =>
    `<button class="pb-nav-btn pb-vm-btn${_paneB.viewMode===vm?' pb-vm-active':''}" data-vm="${vm}" title="${vm[0].toUpperCase()+vm.slice(1)} view">${vm==='list'?'☰':'⊞'}</button>`
  ).join('');

  // ── r109: Build entry rows — list or icon view ─────────────────────────────
  let listHTML = '';
  if(_paneB.viewMode === 'list') {
    // r110: Real file icons + size + date columns
    listHTML = entries.length ? entries.map((e, i) => {
      const isSel = _paneB.selIdx === i;
      const iconSvg = fileIcon(e);
      const iconColor = fileColor(e);
      const sizeStr = e.is_dir ? '—' : fmtSize(e.size);
      const dateStr = fmtDate(e.modified);
      const dateTitle = fmtDateAbsolute(e.modified);
      return `<div class="pb-list-row${isSel?' sel':''}" data-idx="${i}">
        <span class="pb-list-icon" style="color:${iconColor}">${iconSvg}</span>
        <span class="pb-list-name">${escHtml(e.name)}</span>
        <span class="pb-list-size">${sizeStr}</span>
        <span class="pb-list-date" title="${dateTitle}">${dateStr}</span>
      </div>`;
    }).join('')
    : '<div class="col-empty-state" style="padding:24px 0;text-align:center;color:var(--text-tertiary);font-size:12px;">' + (q ? 'No matches' : 'Empty folder') + '</div>';
  } else {
    // Icon view
    listHTML = entries.length ? entries.map((e, i) => {
      const isSel = _paneB.selIdx === i;
      const iconSvg = fileIcon(e);
      const iconColor = fileColor(e);
      return `<div class="pb-icon-item${isSel?' sel':''}" data-idx="${i}">
        <span class="pb-icon-glyph" style="color:${iconColor}">${iconSvg}</span>
        <span class="pb-icon-name">${escHtml(e.name)}</span>
      </div>`;
    }).join('')
    : '<div class="col-empty-state" style="padding:24px 0;text-align:center;color:var(--text-tertiary);font-size:12px;">' + (q ? 'No matches' : 'Empty folder') + '</div>';
  }

  host.innerHTML = `
    <div class="pb-toolbar">
      <button class="pb-nav-btn" id="pb-back" ${canBack?'':'disabled'} title="Back (Alt+←)">&#x2039;</button>
      <button class="pb-nav-btn" id="pb-fwd"  ${canFwd?'':'disabled'} title="Forward (Alt+→)">&#x203a;</button>
      <div class="pb-breadcrumb" id="pb-breadcrumb">${crumbs||'<span class="pb-crumb">/</span>'}</div>
      ${vmBtns}
      <button class="pb-nav-btn" id="pb-hid" title="Toggle hidden files" style="opacity:${_paneB.showHidden?'1':'.4'}">&#x1F441;</button>
      <button class="pb-nav-btn" id="pb-sync" title="Sync to main pane">&#x21c4;</button>
      ${_paneB.path && state.currentPath && _paneB.path !== state.currentPath
        ? '<button class="pb-nav-btn pb-compare-btn" id="pb-compare" title="Compare directories (Ctrl+D)" style="font-size:11px;padding:0 6px;">⚖</button>'
        : ''}
    </div>
    <div class="pb-search-bar" id="pb-search-bar">
      <input class="pb-search-input" id="pb-search-in" placeholder="Filter…" value="${escHtml(_paneB._searchQuery||'')}" autocomplete="off" spellcheck="false">
      ${_paneB._searchQuery?'<button class="pb-search-clear" id="pb-search-clear">&#x2715;</button>':''}
    </div>
    <div id="pb-list" class="pb-entry-list pb-${_paneB.viewMode}-view">${listHTML}</div>`;

  // ── Wire toolbar ───────────────────────────────────────────────────────────
  host.querySelector('#pb-back')?.addEventListener('click', () => { if(canBack){_paneB.historyIdx--;_navigatePaneB(_paneB.history[_paneB.historyIdx]);} });
  host.querySelector('#pb-fwd')?.addEventListener('click',  () => { if(canFwd) {_paneB.historyIdx++;_navigatePaneB(_paneB.history[_paneB.historyIdx]);} });
  host.querySelector('#pb-sync')?.addEventListener('click', () => _navigatePaneB(state.currentPath));
  host.querySelector('#pb-compare')?.addEventListener('click', () => {
    if(_paneB.path && state.currentPath) _showDirDiff(state.currentPath, _paneB.path);
  });
  host.querySelector('#pb-hid')?.addEventListener('click',  () => { _paneB.showHidden=!_paneB.showHidden; _renderPaneB(); });

  // View mode switcher
  host.querySelectorAll('.pb-vm-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _paneB.viewMode = btn.dataset.vm;
      localStorage.setItem('ff_pb_viewMode', _paneB.viewMode);
      _renderPaneB();
    });
  });

  // r108: Breadcrumb navigation
  host.querySelectorAll('.pb-crumb[data-path]').forEach(crumb => {
    crumb.style.cursor = 'pointer';
    crumb.addEventListener('click', () => _navigatePaneB(crumb.dataset.path));
  });

  // r109: Search input
  const searchIn = host.querySelector('#pb-search-in');
  if(searchIn) {
    let _pbSearchTimer = null;
    searchIn.addEventListener('input', () => {
      clearTimeout(_pbSearchTimer);
      _pbSearchTimer = setTimeout(() => { _paneB._searchQuery = searchIn.value; _renderPaneB(); }, 180);
    });
    searchIn.addEventListener('keydown', e => { if(e.key === 'Escape') { _paneB._searchQuery=''; _renderPaneB(); } });
  }
  host.querySelector('#pb-search-clear')?.addEventListener('click', () => { _paneB._searchQuery=''; _renderPaneB(); });

  // ── Wire entry rows ────────────────────────────────────────────────────────
  const rowSelector = _paneB.viewMode === 'list' ? '.pb-list-row' : '.pb-icon-item';
  host.querySelectorAll(rowSelector).forEach(row => {
    const entry = entries[+row.dataset.idx];
    if(!entry) return;

    row.addEventListener('click', () => { _paneB.selIdx=+row.dataset.idx; _paneB._focused=true; _renderPaneB(); });
    row.addEventListener('dblclick', () => {
      if(entry.is_dir) _navigatePaneB(entry.path);
      else invoke('open_file',{path:entry.path}).catch(()=>{});
    });

    // ── Drag from pane B into main pane ────────────────────────────────────
    row.setAttribute('draggable','true');
    row.addEventListener('dragstart', ev => {
      dragState = { entries: [entry], srcPath: _paneB.path };
      ev.dataTransfer.effectAllowed = 'copyMove';
      _dragBadge = document.createElement('div');
      _dragBadge.id = 'drag-op-badge';
      _dragBadge.textContent = 'Move';
      _dragBadge.style.cssText = 'position:fixed;top:-100px;left:-100px;padding:3px 8px;background:#5b8dd9;color:#fff;border-radius:6px;font-size:12px;pointer-events:none;z-index:9999;';
      document.body.appendChild(_dragBadge);
      ev.dataTransfer.setDragImage(_dragBadge, -10, -10);
    });
    row.addEventListener('dragend', () => {
      dragState = {entries:[],srcPath:''};
      if(_dragBadge){_dragBadge.style.transition='opacity .4s';_dragBadge.style.opacity='0';setTimeout(()=>{_dragBadge?.remove();_dragBadge=null;},450);}
    });

    // ── Drop into pane B folder rows ────────────────────────────────────────
    if(entry.is_dir) setupDropTarget(row, entry.path);

    // ── Context menu ────────────────────────────────────────────────────────
    row.addEventListener('contextmenu', ev => {
      ev.preventDefault(); ev.stopPropagation();
      _paneB.selIdx = +row.dataset.idx; _paneB._focused = true; _renderPaneB();
      const items = [
        {label:'Open', action:'pb-open'},
        entry.is_dir ? {label:'Open in Main Pane', action:'pb-open-main'} : null,
        '-',
        {label:'Copy to Main Pane', action:'pb-copy-main'},
        {label:'Move to Main Pane', action:'pb-move-main'},
        '-',
        {label:'Copy Path', action:'pb-copy-path'},
        '-',
        {label:'Delete', action:'pb-delete'},
      ].filter(Boolean);
      window._pbCtxAction = async action => {
        switch(action) {
          case 'pb-open':
            if(entry.is_dir) _navigatePaneB(entry.path);
            else invoke('open_file',{path:entry.path}).catch(()=>{});
            break;
          case 'pb-open-main':
            navigate(entry.path, 0); break;
          case 'pb-copy-main':
          case 'pb-move-main': {
            const op = action==='pb-copy-main' ? 'copy_files_batch' : 'move_files_batch';
            const dest = state.currentPath;
            if(!dest){showToast(t('toast.no_main_pane'),'error');break;}
            _sbProgress.start((op==='copy_files_batch'?'Copying':'Moving')+' to main…', 1);
            let ul;
            try {
              let res; const done = new Promise(r=>{res=r;});
              ul = await listen('file-op-progress', ev2=>{
                const {done:d,total:t,finished}=ev2.payload;
                _sbProgress.update(d,t);
                if(finished) res();
              });
              await invoke(op, {srcs:[entry.path], destDir:dest});
              await done;
              _sbProgress.finish(true,'Done');
              showToast(entry.name+' '+(op==='copy_files_batch'?'copied':'moved')+' to main pane','success');
              await refreshColumns();
              if(action==='pb-move-main') await _navigatePaneB(_paneB.path);
            } catch(e){_sbProgress.error('Failed: '+e);showToast(t('error.generic',{err:e}),'error');}
            finally{ul?.();}
            break;
          }
          case 'pb-copy-path':
            navigator.clipboard.writeText(entry.path).then(()=>showToast(t('toast.path_copied'),'success')).catch(()=>{});
            break;
          case 'pb-delete':
            if(!confirm('Move to Trash: '+entry.name+'?')) break;
            try{
              await invoke('delete_items',{paths:[entry.path]});
              showToast(entry.name+' moved to Trash','success');
              await _navigatePaneB(_paneB.path);
            }catch(e){showToast(t('error.delete',{err:e}),'error','delete');}
            break;
        }
      };
      window._pbCtxMenuActive = true;
      showContextMenu(ev.clientX, ev.clientY, items);
    });
  });

  // ── Pane B itself is a drop target ─────────────────────────────────────────
  setupDropTarget(host, _paneB.path);
  host.addEventListener('mousedown', () => { _paneB._focused=true; });
}


// r21: use sessionStorage so split-pane state is per-window (localStorage is shared across all windows)
if(sessionStorage.getItem('ff_split_active')==='1') setTimeout(()=>_toggleSplitPane(),400);


// ── Settings panel ─────────────────────────────────────────────────────────────
function _showSettings() {
  document.getElementById('ff-settings')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'ff-settings';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9500;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.65);backdrop-filter:blur(7px);';

  // Read current values
  const get = (k, def) => localStorage.getItem(k) ?? def;

  const sections = [
    { id:'general', label:'General', icon:'⚙' },
    { id:'appearance', label:'Appearance', icon:'🎨' },
    { id:'search', label:'Search', icon:'🔍' },
    { id:'network', label:'Network', icon:'🌐' },
    { id:'customisation', label:'Customisation', icon:'🔌' },
    { id:'shortcuts', label:'Shortcuts', icon:'⌨' },
    { id:'advanced', label:'Advanced', icon:'🛠' },
  ];

  let activeSection = 'general';

  const renderContent = () => {
    const c = overlay.querySelector('#settings-content');
    if(!c) return;
    switch(activeSection) {
      case 'general': c.innerHTML = `
        <div class="stg-group">
          <div class="stg-label">File opening</div>
          <label class="stg-row"><span>Single-click to open files</span>
            <input type="checkbox" class="stg-check" data-key="ff_single_click" ${get('ff_single_click','0')==='1'?'checked':''}></label>
          <label class="stg-row"><span>Show hidden files by default</span>
            <input type="checkbox" class="stg-check" data-key="ff_show_hidden" ${get('ff_show_hidden','0')==='1'?'checked':''}></label>
          <label class="stg-row"><span>Confirm before deleting</span>
            <input type="checkbox" class="stg-check" data-key="ff_confirm_delete" ${get('ff_confirm_delete','1')!=='0'?'checked':''}></label>
        </div>
        <div class="stg-group">
          <div class="stg-label">Icon view</div>
          <label class="stg-row"><span>Default icon size</span>
            <select class="stg-select" data-key="ff_icon_size">
              <option value="60" ${get('ff_icon_size','80')==='60'?'selected':''}>Small</option>
              <option value="80" ${get('ff_icon_size','80')==='80'?'selected':''}>Medium</option>
              <option value="112" ${get('ff_icon_size','80')==='112'?'selected':''}>Large</option>
            </select></label>
        </div>`; break;
      case 'appearance': c.innerHTML = `
        <div class="stg-group">
          <div class="stg-label">Layout</div>
          <label class="stg-row"><span>Sidebar width (px)</span>
            <input type="number" class="stg-num" data-cssvar="--sidebar-w" min="140" max="400" value="${parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'))||200}"></label>
          <label class="stg-row"><span>Preview panel width (px)</span>
            <input type="number" class="stg-num" data-key="ff_preview_w" data-cssvar="--preview-w" min="160" max="600" value="${get('ff_preview_w','280')}"></label>
          <label class="stg-row"><span>Slideshow interval (seconds)</span>
            <input type="number" class="stg-num" data-key="ff_ss_interval" min="1" max="30" value="${get('ff_ss_interval','3')}"></label>
        </div>
        <div class="stg-group">
          <div class="stg-label">Language</div>
          <label class="stg-row"><span>Interface language</span>
            <select class="stg-select" data-key="ff_locale">
              <option value="en" ${get('ff_locale','en')==='en'?'selected':''}>English</option>
              <option value="de" ${get('ff_locale','en')==='de'?'selected':''}>Deutsch</option>
              <option value="es" ${get('ff_locale','en')==='es'?'selected':''}>Español</option>
              <option value="fr" ${get('ff_locale','en')==='fr'?'selected':''}>Français</option>
              <option value="zh" ${get('ff_locale','en')==='zh'?'selected':''}>中文（简体）</option>
              <option value="ja" ${get('ff_locale','en')==='ja'?'selected':''}>日本語</option>
              <option value="ar" dir="rtl" ${get('ff_locale','en')==='ar'?'selected':''}>العربية</option>
            </select></label>
        </div>`; break;
      case 'search': c.innerHTML = `
        <div class="stg-group">
          <div class="stg-label">Search behaviour</div>
          <label class="stg-row"><span>Include hidden files by default</span>
            <input type="checkbox" class="stg-check" data-key="ff_search_hidden" ${get('ff_search_hidden','0')==='1'?'checked':''}></label>
          <label class="stg-row"><span>Max results shown</span>
            <input type="number" class="stg-num" data-key="ff_search_max" min="50" max="5000" value="${get('ff_search_max','500')}"></label>
        </div>`; break;
      case 'network': c.innerHTML = `
        <div class="stg-group">
          <div class="stg-label">SFTP</div>
          <label class="stg-row"><span>Connection timeout (seconds)</span>
            <input type="number" class="stg-num" data-key="ff_sftp_timeout" min="5" max="120" value="${get('ff_sftp_timeout','30')}"></label>
        </div>
        <div class="stg-group">
          <div class="stg-label">FTP</div>
          <label class="stg-row"><span>Passive mode by default</span>
            <input type="checkbox" class="stg-check" data-key="ff_ftp_passive" ${get('ff_ftp_passive','1')!=='0'?'checked':''}></label>
        </div>`; break;
      case 'advanced': c.innerHTML = `
        <div class="stg-group">
          <div class="stg-label">Reset</div>
          <div class="stg-row"><span>Show onboarding again on next launch</span>
            <button class="stg-btn" id="stg-reset-onboard">Reset</button></div>
          <div class="stg-row"><span>Clear path history (${JSON.parse(get('ff_path_history','[]')).length} entries)</span>
            <button class="stg-btn" id="stg-clear-history">Clear</button></div>
          <div class="stg-row"><span>Clear thumbnail cache</span>
            <button class="stg-btn" id="stg-clear-thumbs">Clear</button></div>
          <div class="stg-row"><span id="stg-tag-db-label">Tag database</span>
            <div style="display:flex;gap:6px">
              <button class="stg-btn" id="stg-tag-db-audit">Audit</button>
              <button class="stg-btn" id="stg-tag-db-clean">Clean up</button>
            </div></div>
        </div>
        <div class="stg-group">
          <div class="stg-label">Debug</div>
          <label class="stg-row"><span>Enable verbose console logging</span>
            <input type="checkbox" class="stg-check" data-key="ff_verbose_log" ${get('ff_verbose_log','0')==='1'?'checked':''}></label>
          <div class="stg-row"><span>Error log (${window._errorRing?.length||0} this session)</span>
            <div style="display:flex;gap:6px">
              <button class="stg-btn" id="stg-view-errors">View</button>
              <button class="stg-btn" id="stg-copy-report">Copy report</button>
              <button class="stg-btn" id="stg-clear-errors">Clear</button>
            </div></div>
        </div>`; break;
      case 'shortcuts': {
        // r162+r163: Shortcut editor — list all remappable actions, click to remap
        const _kb = _getKeybindings();
        let overrides = {};
        try { overrides = JSON.parse(localStorage.getItem('ff_keybindings') || '{}'); } catch(_) {}
        const categories = [...new Set(_KB_DEFAULTS.map(b => b.category))];
        let html = '';
        for (const cat of categories) {
          const rows = _KB_DEFAULTS.filter(b => b.category === cat);
          html += `<div class="stg-group">
            <div class="stg-label">${cat}</div>`;
          for (const def of rows) {
            const cur = _kb[def.id].keys;
            const isCustom = !!overrides[def.id];
            html += `<div class="stg-row kb-row" data-kb-id="${def.id}" style="cursor:pointer;">
              <span style="flex:1">${def.label}</span>
              <span class="kb-chip${isCustom?' kb-chip-custom':''}" id="kb-chip-${def.id}">${_keysLabel(cur)}</span>
              ${isCustom ? `<button class="kb-reset-btn" data-kb-id="${def.id}" title="Reset to default" style="background:none;border:none;color:var(--text-tertiary);cursor:pointer;font-size:11px;padding:0 4px;">↺</button>` : '<span style="width:22px;display:inline-block"></span>'}
            </div>`;
          }
          html += '</div>';
        }
        html += `<div class="stg-group"><div class="stg-row"><span>Reset all shortcuts to defaults</span>
          <button class="stg-btn" id="kb-reset-all">Reset all</button></div></div>`;
        c.innerHTML = html;

        // Wire: click row → capture mode
        c.querySelectorAll('.kb-row[data-kb-id]').forEach(row => {
          row.addEventListener('click', ev => {
            if(ev.target.classList.contains('kb-reset-btn')) return; // handled separately
            const id = row.dataset.kbId;
            const chip = c.querySelector('#kb-chip-' + id);
            if(!chip) return;
            const origLabel = chip.textContent;
            chip.textContent = 'Press keys…';
            chip.style.background = 'rgba(91,141,217,.25)';
            chip.style.color = '#5b8dd9';

            let _errTimeout;
            const onKey = ev2 => {
              // Ignore bare modifier presses
              if(['Control','Meta','Alt','Shift'].includes(ev2.key)) return;
              ev2.preventDefault(); ev2.stopPropagation();
              const newKeys = {
                ctrl:  ev2.ctrlKey || ev2.metaKey || undefined,
                shift: ev2.shiftKey || undefined,
                alt:   ev2.altKey || undefined,
                key:   ev2.key,
              };
              // Clean up undefined
              Object.keys(newKeys).forEach(k => { if(!newKeys[k]) delete newKeys[k]; });

              // r163: guard-rail check
              if(_isGuardedCombo(newKeys)) {
                chip.textContent = _keysLabel(newKeys) + ' (reserved)';
                chip.style.color = '#f87171';
                chip.style.background = 'rgba(248,113,113,.12)';
                clearTimeout(_errTimeout);
                _errTimeout = setTimeout(() => { chip.textContent = origLabel; chip.style.color=''; chip.style.background=''; }, 1800);
                document.removeEventListener('keydown', onKey, true);
                return;
              }

              // r163: conflict check
              const conflict = _findConflict(newKeys, id);
              if(conflict) {
                chip.textContent = _keysLabel(newKeys) + ' — conflicts with "' + conflict.label + '"';
                chip.style.color = '#fb923c';
                chip.style.background = 'rgba(251,146,60,.12)';
                // Highlight conflicting row
                const confRow = c.querySelector('[data-kb-id="' + conflict.id + '"]');
                if(confRow){ confRow.style.outline='1px solid #fb923c'; setTimeout(()=>confRow.style.outline='',2000); }
                clearTimeout(_errTimeout);
                _errTimeout = setTimeout(() => { chip.textContent = origLabel; chip.style.color=''; chip.style.background=''; }, 2400);
                document.removeEventListener('keydown', onKey, true);
                return;
              }

              // Save
              _saveKeybinding(id, newKeys);
              chip.textContent = _keysLabel(newKeys);
              chip.style.color = '#a78bfa';
              chip.style.background = 'rgba(167,139,250,.15)';
              chip.classList.add('kb-chip-custom');
              document.removeEventListener('keydown', onKey, true);
              // Re-render the section to show reset button
              setTimeout(() => { activeSection = 'shortcuts'; renderContent(); }, 300);
            };
            document.addEventListener('keydown', onKey, true);

            // Cancel on click elsewhere
            setTimeout(() => {
              const cancel = () => {
                document.removeEventListener('keydown', onKey, true);
                if(chip.textContent === 'Press keys…'){ chip.textContent = origLabel; chip.style.color=''; chip.style.background=''; }
                document.removeEventListener('click', cancel, true);
              };
              document.addEventListener('click', cancel, {once:true, capture:true});
            }, 100);
          });
        });

        // Wire: reset individual
        c.querySelectorAll('.kb-reset-btn').forEach(btn => {
          btn.addEventListener('click', ev => {
            ev.stopPropagation();
            _resetKeybinding(btn.dataset.kbId);
            renderContent();
            showToast(t('toast.shortcuts_reset'),'info');
          });
        });

        // Wire: reset all
        c.querySelector('#kb-reset-all')?.addEventListener('click', () => {
          if(confirm('Reset all keyboard shortcuts to defaults?')){ _resetAllKeybindings(); renderContent(); showToast(t('toast.shortcuts_all_reset'),'success'); }
        });
        break;
      }
      case 'customisation': c.innerHTML = `
        <div class="stg-group">
          <div class="stg-label">Plugins</div>
          <div class="stg-row" style="flex-direction:column;align-items:flex-start;gap:6px;">
            <span style="font-size:12px;color:#9c9a92;">Plugins extend FrostFinder with custom commands accessible via the right-click context menu. You can also open the plugin manager with <code>Ctrl+Shift+P</code>.</span>
            <button class="stg-btn" id="stg-open-plugins" style="margin-top:4px;">Open Plugin Manager</button>
          </div>
        </div>`; break;
    }
    // Wire error log buttons in Advanced section
    // Tag DB audit/cleanup buttons (Settings → Advanced → Reset)
    c.querySelector('#stg-tag-db-audit')?.addEventListener('click', async () => {
      const lbl = c.querySelector('#stg-tag-db-label');
      if (lbl) lbl.textContent = 'Scanning…';
      try {
        const stats = await invoke('tag_db_stats');
        const msg = `Tag DB: ${stats.total} tagged file${stats.total !== 1 ? 's' : ''}, ${stats.orphans} orphan${stats.orphans !== 1 ? 's' : ''}`;
        if (lbl) lbl.textContent = msg;
        if (stats.orphans === 0) showToast(t('toast.tag_db_clean'),'success');
        else showToast(t('toast.orphans_found',{n:stats.orphans}),'info');
      } catch(e) { if (lbl) lbl.textContent = 'Tag database'; showToast(t('toast.tag_audit_failed',{err:e}),'error','tag-audit'); }
    });
    c.querySelector('#stg-tag-db-clean')?.addEventListener('click', async () => {
      const lbl = c.querySelector('#stg-tag-db-label');
      if (lbl) lbl.textContent = 'Cleaning…';
      try {
        const removed = await invoke('cleanup_tag_db');
        const msg = removed > 0
          ? `Tag DB: removed ${removed} orphan${removed !== 1 ? 's' : ''}`
          : 'Tag database is clean';
        if (lbl) lbl.textContent = msg;
        showToast(removed > 0 ? `Removed ${removed} orphaned tag entr${removed !== 1 ? 'ies' : 'y'}` : 'Tag database is already clean', 'success');
      } catch(e) { if (lbl) lbl.textContent = 'Tag database'; showToast(t('toast.tag_cleanup_failed',{err:e}),'error','tag-cleanup'); }
    });
    c.querySelector('#stg-view-errors')?.addEventListener('click', () => { FF.showErrors?.(); });
    c.querySelector('#stg-copy-report')?.addEventListener('click', () => { FF.copyReport?.(); });
    c.querySelector('#stg-clear-errors')?.addEventListener('click', async () => {
      try { await invoke('clear_error_log'); _errorRing.length=0; showToast(t('toast.error_log_cleared'),'success'); renderContent(); }
      catch(e) { showToast(t('toast.clear_failed',{err:e}),'error','settings'); }
    });
    // Wire checkboxes — also apply live where it makes sense
    c.querySelectorAll('.stg-check[data-key]').forEach(el => {
      el.addEventListener('change', () => {
        localStorage.setItem(el.dataset.key, el.checked?'1':'0');
        // r83: ff_show_hidden applies immediately
        if(el.dataset.key==='ff_show_hidden'){
          state.showHidden=el.checked;
          getActiveTab().state.showHidden=el.checked;
          render();
        }
      });
    });
    // Wire number inputs
    c.querySelectorAll('.stg-num[data-key]').forEach(el => {
      el.addEventListener('change', () => {
        localStorage.setItem(el.dataset.key, el.value);
        if(el.dataset.cssvar) document.documentElement.style.setProperty(el.dataset.cssvar, el.value+'px');
      });
    });
    // Wire CSS var inputs (no localStorage key, just CSS)
    c.querySelectorAll('.stg-num[data-cssvar]:not([data-key])').forEach(el => {
      el.addEventListener('change', () => document.documentElement.style.setProperty(el.dataset.cssvar, el.value+'px'));
    });
    // Wire selects
    c.querySelectorAll('.stg-select[data-key]').forEach(el => {
      el.addEventListener('change', () => {
        localStorage.setItem(el.dataset.key, el.value);
        // r86: icon size applies immediately without requiring a restart
        if(el.dataset.key==='ff_icon_size'){
          state.iconSize=+el.value;
          state.fontSize=Math.round(10+(state.iconSize-28)*(6/52));
          applyScale();renderView();
        }
      });
    });
    // Wire advanced buttons
    c.querySelector('#stg-open-plugins')?.addEventListener('click', () => {
      overlay.remove(); _showPluginManager();
    });
    c.querySelector('#stg-reset-onboard')?.addEventListener('click', () => {
      localStorage.removeItem('ff_onboarded'); showToast(t('toast.onboarding_reset'),'info');
    });
    c.querySelector('#stg-clear-history')?.addEventListener('click', () => {
      localStorage.removeItem('ff_path_history'); showToast(t('toast.path_history_cleared'),'success'); renderContent();
    });
    c.querySelector('#stg-clear-thumbs')?.addEventListener('click', () => {
      invoke('gc_thumbnail_cache').then(n => showToast(t('toast.thumbnails_cleared',{n}),'success')).catch(e => showToast(t('error.generic',{err:e}),'error'));
    });
  };

  overlay.innerHTML = `<div class="stg-dialog">
    <div class="stg-sidebar">
      <div class="stg-sidebar-title">Settings</div>
      ${sections.map(s=>`<button class="stg-nav-btn${s.id===activeSection?' active':''}" data-sec="${s.id}">${s.icon} ${s.label}</button>`).join('')}
    </div>
    <div class="stg-main">
      <div class="stg-header">
        <span class="stg-header-title">${sections.find(s=>s.id===activeSection)?.label}</span>
        <button id="stg-close" class="stg-close-btn">×</button>
      </div>
      <div id="settings-content" class="stg-content"></div>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  renderContent();

  overlay.querySelectorAll('.stg-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeSection = btn.dataset.sec;
      overlay.querySelectorAll('.stg-nav-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.sec === activeSection);
      });
      // Update header title
      overlay.querySelector('.stg-header-title').textContent = sections.find(s=>s.id===activeSection)?.label||'';
      renderContent();
    });
  });

  const close = () => overlay.remove();
  overlay.querySelector('#stg-close').addEventListener('click', close);
  overlay.addEventListener('click', ev => { if(ev.target===overlay) close(); });
  overlay.addEventListener('keydown', ev => { if(ev.key==='Escape') close(); });
}

async function showOpenWithDialog(entry,extraPaths=null){
  // Remove any existing dialog
  document.getElementById('open-with-overlay')?.remove();

  const overlay=document.createElement('div');
  overlay.id='open-with-overlay';
  overlay.innerHTML=`
    <div class="ow-backdrop"></div>
    <div class="ow-panel" role="dialog" aria-label="Open With">
      <div class="ow-header">
        <span class="ow-title">Open With</span>
        <span class="ow-filename">${escHtml(entry.name)}</span>
        <button class="ow-close" id="ow-close">&#x2715;</button>
      </div>
      <div class="ow-search-wrap">
        <input class="ow-search" id="ow-search" placeholder="Filter applications…" autocomplete="off" spellcheck="false"/>
      </div>
      <div class="ow-list" id="ow-list">
        <div class="ow-loading"><div class="spinner"></div><span>Loading apps…</span></div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const close=()=>overlay.remove();
  overlay.querySelector('.ow-backdrop').addEventListener('click',close);
  overlay.querySelector('#ow-close').addEventListener('click',close);
  overlay.addEventListener('keydown',e=>{if(e.key==='Escape')close();});

  let allApps=[];
  try{allApps=await invoke('list_apps_for_file',{path:entry.path});}
  catch(err){showToast(t('error.list_apps',{err}),'error');close();return;}

  // Sort: last-used app for this extension floats to top
  const ext=(entry.extension||'').toLowerCase();
  const lastUsedKey='ff_open_with_'+ext;
  const lastUsed=localStorage.getItem(lastUsedKey)||'';
  if(lastUsed){
    const i=allApps.findIndex(a=>a.name===lastUsed);
    if(i>0){const [app]=allApps.splice(i,1);allApps.unshift(app);}
  }

  const listEl=overlay.querySelector('#ow-list');
  const render=filter=>{
    const q=(filter||'').toLowerCase().trim();
    const shown=q?allApps.filter(a=>a.name.toLowerCase().includes(q)):allApps;
    if(!shown.length){listEl.innerHTML='<div class="ow-empty">No applications found</div>';return;}
    listEl.innerHTML='';
    for(const app of shown){
      const row=document.createElement('div');
      row.className='ow-row'+(app.name===lastUsed?' ow-row-last':'');
      row.innerHTML=`<span class="ow-app-icon">${buildAppIconHtml(app.icon)}</span><span class="ow-app-name">${escHtml(app.name)}</span>${app.name===lastUsed?'<span class="ow-last-badge">last used</span>':''}`;
      row.addEventListener('click',async()=>{
        localStorage.setItem(lastUsedKey, app.name);
        close();
        // r99: open all matched paths; single path when extraPaths is null
        const _owPaths=extraPaths&&extraPaths.length?extraPaths:[entry.path];
        try{for(const _op of _owPaths)await invoke('open_with_app',{path:_op,exec:app.exec});}
        catch(err){showToast(t('error.open_file',{err}),'error');}
      });
      listEl.appendChild(row);
    }
  };
  render('');
  const searchEl=overlay.querySelector('#ow-search');
  searchEl.addEventListener('input',()=>render(searchEl.value));
  // Focus search after paint
  requestAnimationFrame(()=>searchEl.focus());
}

function buildAppIconHtml(icon){
  if(!icon) return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="width:20px;height:20px"><rect x="3" y="3" width="18" height="18" rx="3"/></svg>';
  // Absolute path to icon file
  if(icon.startsWith('/')){
    return `<img src="asset://localhost${icon}" style="width:20px;height:20px;object-fit:contain" onerror="this.style.display='none'"/>`;
  }
  // Named icon — try common paths
  const exts=['png','svg','xpm'];
  const sizes=['48','32','24','scalable'];
  // Fallback: just show first letter
  return `<span style="width:20px;height:20px;display:flex;align-items:center;justify-content:center;background:var(--accent-blue);border-radius:4px;font-size:11px;font-weight:700;color:#fff">${escHtml(icon[0]?.toUpperCase()||'?')}</span>`;
}

function getSelectedEntry(){const entries=getVisibleEntries();const idx=sel.arr[0]??state.selIdx;return entries[idx]??null;}
function getSelectedEntries(){const entries=getVisibleEntries();const idxs=sel.size>0?sel.arr:[state.selIdx].filter(i=>i>=0);return idxs.map(i=>entries[i]).filter(Boolean);}

// Scroll the first selected item into view after a view-mode switch.
function scrollSelectionIntoView(){
  const idx=sel.arr[0]??state.selIdx;
  if(idx<0)return;
  const vm=state.viewMode;
  if(vm==='list'||vm==='flat'){
    const row=document.querySelector(`.list-row[data-idx="${idx}"],.frow[data-idx="${idx}"]`);
    row?.scrollIntoView({block:'center',behavior:'smooth'});
  }else if(vm==='icon'){
    const item=document.querySelector(`.icon-item[data-idx="${idx}"]`);
    if(item){item.scrollIntoView({block:'center',behavior:'smooth'});}
    else{
      // Item not yet rendered (virtual scroll) — compute scroll position manually
      const wrap=document.getElementById('iv-wrap');
      if(wrap){
        const cols=Math.max(1,Math.floor((wrap.clientWidth-10)/(state.iconSize*2+26)));
        const ROW_H=(state.iconSize+44)+10;
        const targetRow=Math.floor(idx/cols);
        const targetY=targetRow*ROW_H;
        wrap.scrollTo({top:Math.max(0,targetY-wrap.clientHeight/2+ROW_H/2),behavior:'smooth'});
      }
    }
  }else if(vm==='column'){
    const row=document.querySelector(`.frow[data-idx="${idx}"]`);
    row?.scrollIntoView({block:'center',behavior:'smooth'});
  }else if(vm==='gallery'){
    const thumb=document.querySelector(`.gthumb[data-idx="${idx}"]`);
    thumb?.scrollIntoView({block:'center',behavior:'smooth',inline:'center'});
  }
}


function buildFileCtxMenu(entry){
  const multi=sel.size>1;
  const ext=entry.extension||'';
  // Check compound extensions (tar.gz, tar.bz2 etc.) as well as single ext
  const nameLower=(entry.name||'').toLowerCase();
  const isArchive=ARCHIVE_EXTS.includes(ext)||ARCHIVE_EXTS.some(ae=>nameLower.endsWith('.'+ae));
  // Build tag color swatches row — macOS-style
  const PALETTE=[
    {name:'Red',color:'#f87171'},{name:'Orange',color:'#fb923c'},
    {name:'Yellow',color:'#fbbf24'},{name:'Green',color:'#34d399'},
    {name:'Blue',color:'#60a5fa'},{name:'Purple',color:'#a78bfa'},
    {name:'Gray',color:'#94a3b8'},
  ];
  const curTags=state._fileTags?.[entry.path]||[];
  const items=[
    {label:multi?`Open ${sel.size} items`:'Open',action:'open',icon:I.openExt},
    ...((!multi&&entry.is_dir)?[{label:'Open in New Tab',action:'open-new-tab',icon:I.folder}]:[]),
        ...((!entry.is_dir && state._platform === 'linux')?(()=>{
      // r99: show Open With for multi-select when all selected share one extension
      // Linux-only: list_apps_for_file uses xdg-open / desktop file scanning
      const _owExts=sel.size>1?[...new Set(getSelectedEntries().map(e=>(e.extension||'').toLowerCase()))]:null;
      const _owMulti=_owExts&&_owExts.length===1;
      return (!multi||_owMulti)?[{label:_owMulti?`Open ${sel.size} items with…`:'Open With…',
        action:'open-with',icon:I.openExt,entry,_owMulti}]:[];
    })():[]),
    '-',
    {label:'Cut',action:'cut',icon:I.scissors,shortcut:'Ctrl+X'},
    {label:'Copy',action:'copy',icon:I.copy,shortcut:'Ctrl+C'},
    {label:'Copy Current Path',action:'copy-current-path',icon:I.copy},
    {label:'Paste',action:'paste',icon:I.paste,shortcut:'Ctrl+V',disabled:!state.clipboard.entries.length},'-',
    {label:'Rename',action:'rename',icon:I.edit,disabled:multi},
    {label:'Move to Trash',action:'delete',icon:I.trash,shortcut:'Del'},'-',
    // Color tag row — rendered specially by showContextMenu
    {label:'Tags',type:'color-tags',palette:PALETTE,currentTags:curTags,entry},
    '-',
    {label:'Compress to ZIP',action:'compress',icon:I.compress},
  ];
  if(isArchive&&!multi)items.push({label:'Extract Here',action:'extract',icon:I.extract});
  // ISO disc image actions
  const isIso = ISO_EXTS.includes(ext) && !multi;
  if(isIso){
    items.push('-');
    items.push({label:'Mount ISO',action:'mount-iso',icon:I.mount});
    items.push({label:'Write to USB…',action:'burn-iso',icon:I.burn});
  }
  items.push('-');
  if(multi && sel.size===2){
    const _selEntries2 = getSelectedEntries();
    const _bothDirs = _selEntries2.every(e => e.is_dir);
    const _bothFiles = _selEntries2.every(e => !e.is_dir);
    if(_bothFiles) items.push({label:'Compare files…', action:'compare-files', icon:I.copy});
    if(_bothDirs)  items.push({label:'Compare directories…', action:'compare-dirs', icon:I.copy});
  }
  items.push({label:'Move to…',action:'move-to',icon:I.scissors});
  items.push({label:'Copy to…',action:'copy-to',icon:I.copy});
  items.push('-',{label:'Open in Terminal',action:'open-terminal',icon:I.terminal});
  if(!entry.is_dir&&!multi)items.push({label:'Open in Editor',action:'open-editor',icon:I.edit});
  items.push('-',{label:'Copy Path',action:'copy-path',icon:I.copy});
  if(entry.is_dir&&!multi)items.push({label:'Add to Sidebar',action:'add-sidebar',icon:'+'});
  // New: Bookmarks
  if(entry.is_dir&&!multi){
    const bookmarked=isBookmarked(entry.path);
    items.push('-');
    items.push({label:bookmarked?'Remove Bookmark':'Add Bookmark',action:bookmarked?'remove-bookmark':'add-bookmark',icon:I.star});
  }
  // New: Find Duplicates (for directories)
  if(entry.is_dir&&!multi){
    items.push({label:'Find Duplicates',action:'find-duplicates',icon:I.doc});
  }
  // New: Secure Delete (for files only, not directories)
  if(!entry.is_dir&&!multi){
    items.push('-');
    items.push({label:'Secure Delete',action:'secure-delete',icon:I.trash,color:'#f87171'});
  }
  return items;
}
function buildBgCtxMenu(){
  const items=[
    {label:'New Folder',action:'new-folder',icon:I.folderPlus},
    {label:'New File',action:'new-file',icon:I.filePlus},'-',
    {label:'New Markdown',action:'new-md',icon:I.doc},
    {label:'New HTML',action:'new-html',icon:I.code},
    {label:'New Python',action:'new-py',icon:I.code},
    {label:'New Shell Script',action:'new-sh',icon:I.code},'-',
    {label:'Open Terminal Here',action:'open-terminal',icon:I.terminal},
    {label:'Paste',action:'paste',icon:I.paste,shortcut:'Ctrl+V',disabled:!state.clipboard.entries.length},
  ];
  // Show "Empty Trash" when viewing the Trash folder
  const isTrash=state.currentPath.includes('/.local/share/Trash');
  if(isTrash)items.push('-',{label:'Empty Trash',action:'empty-trash',icon:I.trash});
  return items;
}

// ── CRUD ──────────────────────────────────────────────────────────────────────
async function deleteEntries(entries){
  // r84: honour ff_confirm_delete preference (default on)
  if(localStorage.getItem('ff_confirm_delete')!=='0'&&!confirm(`Move ${entries.length} item${entries.length>1?'s':''} to Trash?`))return;
  const total=entries.length;
  const paths=entries.map(e=>e.path);
  const errors=[];

  _sbProgress.start(`Moving to Trash\u2026 0 / ${total}`, total);

  // ── Register listener BEFORE invoke (same pattern as clipboardPaste) ─────
  // listen() is async — if we called invoke first, Rust could emit finished:true
  // before the listener is registered and deleteDone would hang forever.
  let _deleteResolve;
  const deleteDone = new Promise(resolve => { _deleteResolve = resolve; });
  const deleteUnlisten = await listen('delete-progress', ev => {
    const {done, total: t, finished, error} = ev.payload;
    if (error) errors.push(error);
    if (finished) { _deleteResolve(); return; }
    _sbProgress.update(done, t, `Moving to Trash ${done} / ${t}`);
  });

  try {
    await invoke('delete_items_stream', {paths, trash:true});
  } catch(err) {
    errors.push(String(err));
    _deleteResolve(); // prevent deadlock if invoke throws before finished fires
  }

  await deleteDone;
  deleteUnlisten();

  // Build undo list from entries that weren't errored
  const deleted = [];
  for(const e of entries){
    if(!errors.some(er => er.includes(e.name)))
      deleted.push({src:e.path, oldName:e.name,
        srcDir:e.path.substring(0,e.path.lastIndexOf('/'))});
  }

  const ok = total - errors.length;
  const hadErrors = errors.length > 0;
  _sbProgress.finish(!hadErrors, hadErrors ? errors[0] : `${ok} item${ok!==1?'s':''} moved to Trash`);
  if(hadErrors) errors.forEach(e=>showToast(t('error.generic',{err:e}),'error'));

  sel.clear(); state.selIdx=-1;
  if(deleted.length) pushUndo({op:'delete', items:deleted});
  await refreshColumns();
}

function promptCreate(type){
  const name=prompt(type==='folder'?'New folder name:':'New file name:',type==='folder'?'New Folder':'untitled.txt');
  if(!name)return;
  const cmd=type==='folder'?'create_directory':'create_file_cmd';
  const destPath=state.currentPath+'/'+name;
  invoke(cmd,{path:state.currentPath,name}).then(()=>{
    showToast(t('toast.created',{name}),'success');
    pushUndo({op:'create',items:[{dst:destPath,
      srcDir:state.currentPath, newName:name}]});
    refreshColumns();
  }).catch(e=>showToast(t('error.unknown',{err:e}),'error'));
}
function promptCreateDoc(docType,ext){
  const name=prompt(`New ${docType} file:`,'untitled'+ext);
  if(!name)return;
  const finalName=name.endsWith(ext)?name:name+ext;
  const destPath=state.currentPath+'/'+finalName;
  invoke('create_new_document',{path:state.currentPath,name:finalName,docType}).then(()=>{
    showToast(t('toast.created',{name:finalName}),'success');
    pushUndo({op:'create',items:[{dst:destPath,
      srcDir:state.currentPath, newName:finalName}]});
    refreshColumns();
  }).catch(e=>showToast(t('error.unknown',{err:e}),'error'));
}

function startRename(entry){
  const selector=`.frow[data-path="${CSS.escape(entry.path)}"] .fname, .list-row[data-path="${CSS.escape(entry.path)}"] .cell-name-text, .icon-item[data-path="${CSS.escape(entry.path)}"] .ico-lbl`;
  const el=document.querySelector(selector);
  if(!el){
    const name=prompt('Rename to:',entry.name);
    if(name&&name!==entry.name){
      const dst=entry.path.substring(0,entry.path.lastIndexOf('/'))+'/'+name;
      invoke('rename_file',{oldPath:entry.path,newName:name}).then(()=>{
        pushUndo({op:'rename',items:[{src:entry.path,dst,oldName:entry.name,newName:name}]});
        refreshColumns();
      }).catch(e=>showToast(t('error.rename',{err:e}),'error'));
    }
    return;
  }
  const oldText=el.textContent;el.contentEditable='true';el.spellcheck=false;
  el.style.cssText='outline:1px solid var(--accent-blue);border-radius:3px;padding:1px 3px;background:var(--bg-window);color:var(--text-primary);min-width:60px;';
  el.focus();
  const range=document.createRange();range.selectNodeContents(el);const s=window.getSelection();s.removeAllRanges();s.addRange(range);
  const finish=async(save)=>{
    el.contentEditable='false';el.style.cssText='';
    if(save){const newName=el.textContent.trim();if(newName&&newName!==entry.name){try{
      const dst=entry.path.substring(0,entry.path.lastIndexOf('/'))+'/'+newName;
      await invoke('rename_file',{oldPath:entry.path,newName});
      pushUndo({op:'rename',items:[{src:entry.path,dst,oldName:entry.name,newName}]});
      await refreshColumns();
    }catch(e){showToast(t('error.rename_inline',{err:e}),'error','rename');el.textContent=oldText;}}else{el.textContent=oldText;}}else{el.textContent=oldText;}
  };
  el.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();finish(true);}if(e.key==='Escape'){e.preventDefault();finish(false);}e.stopPropagation();});
  el.addEventListener('blur',()=>finish(true),{once:true});
}

// ── Compression / Extraction ──────────────────────────────────────────────────
async function compressEntries(entries){
  // Format picker dialog
  const baseName=entries.length===1?entries[0].name:'archive';
  await new Promise(resolve=>{
    document.getElementById('ff-compress-dlg')?.remove();
    const dlg=document.createElement('div');
    dlg.id='ff-compress-dlg';
    dlg.style.cssText='position:fixed;inset:0;z-index:9400;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);';
    const formats=[
      {ext:'zip',label:'ZIP',desc:'Universal, no extra tools needed'},
      {ext:'tar.gz',label:'TAR.GZ',desc:'Standard Unix archive + gzip'},
      {ext:'tar.bz2',label:'TAR.BZ2',desc:'Better compression, slower'},
      {ext:'tar.xz',label:'TAR.XZ',desc:'Best compression, slowest'},
    ];
    dlg.innerHTML=`<div style="background:#1e1e21;border:1px solid rgba(255,255,255,.13);border-radius:14px;padding:24px 26px 20px;min-width:380px;box-shadow:0 16px 48px rgba(0,0,0,.75);">
      <div style="font-size:14px;font-weight:600;color:#f1f5f9;margin-bottom:14px;">Compress ${escHtml(entries.length===1?entries[0].name:entries.length+' items')}</div>
      <label style="display:block;font-size:11px;color:#98989f;margin-bottom:5px;text-transform:uppercase;letter-spacing:.06em;">File name</label>
      <input id="cmp-name" style="width:100%;box-sizing:border-box;padding:9px 11px;background:#2a2a2d;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#f1f5f9;font-size:13px;outline:none;font-family:inherit;margin-bottom:12px;" value="${escHtml(baseName)}"/>
      <label style="display:block;font-size:11px;color:#98989f;margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;">Format</label>
      <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:16px;">
        ${formats.map((f,i)=>`<label style="display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;border:1px solid ${i===0?'var(--accent-blue)':'rgba(255,255,255,.07)'};cursor:pointer;background:${i===0?'rgba(91,141,217,.08)':'rgba(255,255,255,.02)'};">
          <input type="radio" name="cmp-fmt" value="${f.ext}" ${i===0?'checked':''} style="accent-color:var(--accent-blue);">
          <div><div style="font-size:12px;font-weight:600;color:#f1f5f9;">${f.label}</div><div style="font-size:11px;color:#636368;">${f.desc}</div></div>
        </label>`).join('')}
      </div>
      <div style="margin-bottom:14px;">
        <label style="display:block;font-size:10px;color:#98989f;margin-bottom:8px;text-transform:uppercase;letter-spacing:.06em;">Compression Level</label>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;">
          <label style="display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px 6px;border-radius:8px;border:1px solid rgba(255,255,255,.07);cursor:pointer;background:rgba(255,255,255,.02);" id="cmp-lvl-fast">
            <input type="radio" name="cmp-level" value="1" style="display:none;">
            <span style="font-size:18px;">🐇</span>
            <span style="font-size:11px;font-weight:600;color:#f1f5f9;">Fast</span>
            <span style="font-size:10px;color:#636368;">Larger file</span>
          </label>
          <label style="display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px 6px;border-radius:8px;border:1px solid var(--accent-blue);cursor:pointer;background:rgba(91,141,217,.08);" id="cmp-lvl-balanced">
            <input type="radio" name="cmp-level" value="5" checked style="display:none;">
            <span style="font-size:18px;">⚖️</span>
            <span style="font-size:11px;font-weight:600;color:#f1f5f9;">Balanced</span>
            <span style="font-size:10px;color:#636368;">Default</span>
          </label>
          <label style="display:flex;flex-direction:column;align-items:center;gap:4px;padding:8px 6px;border-radius:8px;border:1px solid rgba(255,255,255,.07);cursor:pointer;background:rgba(255,255,255,.02);" id="cmp-lvl-small">
            <input type="radio" name="cmp-level" value="9" style="display:none;">
            <span style="font-size:18px;">📦</span>
            <span style="font-size:11px;font-weight:600;color:#f1f5f9;">Small</span>
            <span style="font-size:10px;color:#636368;">Slower</span>
          </label>
        </div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="cmp-cancel" style="padding:7px 16px;background:rgba(255,255,255,.07);border:none;border-radius:8px;color:#98989f;font-size:13px;cursor:pointer;font-family:inherit;">Cancel</button>
        <button id="cmp-ok" style="padding:7px 18px;background:#5b8dd9;border:none;border-radius:8px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">Compress</button>
      </div>
    </div>`;
    document.body.appendChild(dlg);
    // Highlight selected format row
    dlg.querySelectorAll('input[name="cmp-fmt"]').forEach(radio=>{
      radio.addEventListener('change',()=>{
        dlg.querySelectorAll('label').forEach(l=>{const r=l.querySelector('input[name="cmp-fmt"]');if(!r)return;l.style.border=r.checked?'1px solid var(--accent-blue)':'1px solid rgba(255,255,255,.07)';l.style.background=r.checked?'rgba(91,141,217,.08)':'rgba(255,255,255,.02)';});
      });
    });
    // p8: compression level toggle highlight
    dlg.querySelectorAll('input[name="cmp-level"]').forEach(radio=>{
      radio.addEventListener('change',()=>{
        ['fast','balanced','small'].forEach(k=>{
          const lbl=dlg.querySelector('#cmp-lvl-'+k);
          const r=lbl?.querySelector('input');
          if(!lbl||!r)return;
          lbl.style.border=r.checked?'1px solid var(--accent-blue)':'1px solid rgba(255,255,255,.07)';
          lbl.style.background=r.checked?'rgba(91,141,217,.08)':'rgba(255,255,255,.02)';
        });
      });
    });
    const close=(go)=>{dlg.remove();resolve(go);};
    dlg.querySelector('#cmp-cancel').addEventListener('click',()=>close(null));
    dlg.addEventListener('click',ev=>{if(ev.target===dlg)close(null);});
    dlg.querySelector('#cmp-ok').addEventListener('click',()=>{
      const name=dlg.querySelector('#cmp-name').value.trim();
      const fmt=dlg.querySelector('input[name="cmp-fmt"]:checked')?.value||'zip';
      if(!name)return;
      close({name,fmt});
    });
    dlg.querySelector('#cmp-name').addEventListener('keydown',e=>{if(e.key==='Enter')dlg.querySelector('#cmp-ok').click();if(e.key==='Escape')close(null);});
    setTimeout(()=>dlg.querySelector('#cmp-name').select(),50);
  }).then(async result=>{
    if(!result)return;
    const {name,fmt}=result;
    const finalExt=fmt==='zip'?'.zip':fmt==='tar.gz'?'.tar.gz':fmt==='tar.bz2'?'.tar.bz2':'.tar.xz';
    const finalName=name.endsWith(finalExt)?name:name+finalExt;
    const outputPath=state.currentPath+'/'+finalName;
  let unlisten;
  try{
    _sbProgress.start('Compressing…', entries.length);
    unlisten = await listen('compress-progress', ev => {
      const {done, total, finished} = ev.payload;
      if (finished) {
        _sbProgress.finish(true, 'Compressed ' + done + ' file' + (done===1?'':'s'));
      } else if (total > 0) {
        _sbProgress.update(done, total, 'Compressing… ' + done + ' / ' + total);
      }
    });
    const level = parseInt(dlg.querySelector('input[name="cmp-level"]:checked')?.value??'5');
    const result=await invoke('compress_files',{paths:entries.map(e=>e.path),outputPath,compressionLevel:level});
    showToast(t('toast.compressed_files',{n:result.file_count,name:finalName}),'success');
    await refreshColumns();
  }catch(e){
    _sbProgress.error('Compress failed: '+e);
    showToast(t('error.compress',{err:e}),'error');
  }finally{
    unlisten?.();
  }
  });
}
async function extractArchive(entry){
  // Auto-derive destination name by stripping archive extension(s):
  // "project.tar.gz" → "project",  "data.zip" → "data"
  const stripExts=n=>{
    const l=n.toLowerCase();
    for(const c of['.tar.gz','.tar.bz2','.tar.xz','.tar.zst','.tgz','.tbz2','.txz'])
      if(l.endsWith(c))return n.slice(0,-c.length);
    const d=n.lastIndexOf('.');return d>0?n.slice(0,d):n;
  };
  const destDir=prompt('Extract to directory:',state.currentPath+'/'+stripExts(entry.name));
  if(!destDir)return;
  let unlisten;
  try{
    _sbProgress.start('Extracting \u2026', 0);
    let isIndeterminate = false;
    unlisten = await listen('extract-progress', ev => {
      const {done, total, finished, name} = ev.payload;
      if (finished) {
        _sbProgress.finish(true, 'Extracted ' + done + ' item' + (done===1?'':'s'));
      } else if (total > 0) {
        // ZIP: deterministic progress
        _sbProgress.update(done, total, 'Extracting\u2026 ' + done + ' / ' + total);
      } else {
        // tar: indeterminate — animate the bar with a marquee pulse
        if (!isIndeterminate) {
          isIndeterminate = true;
          const b = document.getElementById('sb-ops-bar');
          if (b) { b.style.width = '60%'; b.style.transition = 'none'; }
        }
      }
    });
    const count=await invoke('extract_archive',{archivePath:entry.path,destDir});
    showToast(t('toast.extracted_items',{n:count,dest:destDir.split('/').pop()}),'success');
    await refreshColumns();
  }catch(e){
    _sbProgress.error('Extract failed: '+e);
    showToast(t('error.extract',{err:e}),'error');
  }finally{
    unlisten?.();
    // Restore bar transition
    const b = document.getElementById('sb-ops-bar');
    if (b) b.style.transition = '';
  }
}
// ── Drag & Drop ───────────────────────────────────────────────────────────────
let dragState={entries:[],srcPath:''};
// Track Ctrl key state for copy-vs-move in internal Tauri drops (where e.ctrlKey is unavailable).
// Also drives the drag-operation badge (Move / Copy).
let _dragCtrl = false;
let _dragBadge = null; // floating "Move" / "Copy" label shown while dragging

function _updateDragBadge() {
  if (!_dragBadge) return;
  _dragBadge.textContent = _dragCtrl ? 'Copy' : 'Move';
  _dragBadge.style.background = _dragCtrl ? '#059669' : 'var(--accent-blue)';
}

document.addEventListener('keydown', e => {
  if (e.key === 'Control') { _dragCtrl = true; _updateDragBadge(); }
});
document.addEventListener('keyup', e => {
  if (e.key === 'Control') { _dragCtrl = false; _updateDragBadge(); }
});
// Track badge position on every dragover
document.addEventListener('dragover', e => {
  if (!_dragBadge) return;
  _dragBadge.style.left = (e.clientX + 14) + 'px';
  _dragBadge.style.top  = (e.clientY + 14) + 'px';
}, { passive: true });

function setupDragDrop(el,entry,entries){
  el.draggable=true;
  el.addEventListener('dragstart',e=>{
    const dragging=sel.size>0&&sel.has(+el.dataset.idx)?getSelectedEntries():[entry];
    const firstEntry=dragging[0]||entry;
    const srcDir=firstEntry.path.includes('/')?firstEntry.path.slice(0,firstEntry.path.lastIndexOf('/'))||'/':'/';
    window.FF?.log('DRAG_START',{name:entry.name,count:dragging.length,srcDir});
    console.log('[DD] dragstart:', entry.name, 'srcDir:', srcDir, 'selected:', dragging.length);
    dragState={entries:dragging,srcPath:srcDir};
    e.dataTransfer.effectAllowed='copyMove';
    // Set text/plain for basic path transfer
    e.dataTransfer.setData('text/plain',dragging.map(x=>x.path).join('\n'));
    // Set text/uri-list with file:// URIs for better compatibility with other apps
    const uriList = dragging.map(x => 'file://' + x.path).join('\r\n');
    e.dataTransfer.setData('text/uri-list', uriList);
    el.classList.add('dragging');
    // Floating Move/Copy badge
    _dragBadge = document.createElement('div');
    _dragBadge.id = 'drag-op-badge';
    _dragBadge.style.cssText = 'position:fixed;z-index:9999;pointer-events:none;padding:3px 9px;border-radius:8px;font-size:11px;font-weight:600;color:#fff;letter-spacing:.03em;box-shadow:0 2px 8px rgba(0,0,0,.4);transition:background .1s;';
    _updateDragBadge();
    _dragBadge.style.left = (e.clientX + 14) + 'px';
    _dragBadge.style.top  = (e.clientY + 14) + 'px';
    document.body.appendChild(_dragBadge);
    if(dragging.length>1){const g=document.createElement('div');g.className='drag-ghost';g.textContent=`${dragging.length} items`;document.body.appendChild(g);e.dataTransfer.setDragImage(g,0,0);requestAnimationFrame(()=>g.remove());}
  });
  el.addEventListener('dragend',()=>{
    el.classList.remove('dragging');
    dragState = { entries: [], srcPath: '' };
    document.querySelectorAll('.drop-over').forEach(el => el.classList.remove('drop-over'));
    // Flash the badge briefly to confirm the drop, then fade out
    if(_dragBadge){
      _dragBadge.style.transition='opacity .4s';
      _dragBadge.style.opacity='0';
      setTimeout(()=>{ _dragBadge?.remove(); _dragBadge=null; }, 420);
    }
  });
}
function setupDropTarget(el,destPath){
  console.log('[DD] setupDropTarget called for:', destPath);
  el.addEventListener('dragover',e=>{e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect=e.ctrlKey?'copy':'move';el.classList.add('drop-over');});
  // Only remove drop-over when the cursor actually leaves this element — not when
  // it moves into a child node (.fico, .fname, .fchev etc. inside a frow).
  // Without this check, every span boundary fires dragleave and the highlight flickers
  // making it impossible to reliably drop onto directory rows or column lists.
  el.addEventListener('dragleave',e=>{
    if(!e.relatedTarget||!el.contains(e.relatedTarget)) el.classList.remove('drop-over');
  });
  el.addEventListener('drop',async e=>{
    console.log('[DD] drop event fired on:', destPath, 'dragState:', dragState);
    e.preventDefault();e.stopPropagation();el.classList.remove('drop-over');
    
    // Check for external file drops (from other apps like Nautilus, Dolphin, etc.)
    let externalPaths = [];
    const uriList = e.dataTransfer.getData('text/uri-list');
    const plainText = e.dataTransfer.getData('text/plain');
    const hasExternalFiles = e.dataTransfer.files?.length > 0;
    
    if (uriList || plainText) {
      try {
        const textData = uriList || plainText;
        externalPaths = await invoke('parse_dropped_paths', { uriList: textData });
      } catch (err) {
        console.warn('Failed to parse dropped paths:', err);
      }
    }
    
    // Determine if this is an internal FrostFinder drag or external
    const isInternalDrag = dragState.entries.length > 0;
    const isExternalDrop = externalPaths.length > 0 || (hasExternalFiles && !isInternalDrag);
    
    // If neither internal nor external, nothing to do
    if (!isInternalDrag && !isExternalDrop) return;
    
    window.FF?.log('DROP',{destPath,internal:isInternalDrag,external:isExternalDrop,op:e.ctrlKey?'copy':'move'});
    
    const op = e.ctrlKey ? 'copy' : 'move';
    let srcs = [];
    let srcPath = '';
    
    if (isInternalDrag) {
      // Internal FrostFinder drag
      srcPath = dragState.srcPath;
      // Prevent dropping onto the exact same directory the files came from
      if (destPath === srcPath) return;
      // Prevent dropping a dragged FOLDER into itself or any of its own descendants.
      if (dragState.entries.some(en => en.is_dir && (destPath === en.path || destPath.startsWith(en.path + '/')))) return;
      srcs = dragState.entries.map(en => en.path);
    } else if (isExternalDrop) {
      // External drop from another application
      srcs = externalPaths;
      // For external drops, determine source directory for validation
      if (srcs.length > 0) {
        const firstSrc = srcs[0];
        srcPath = firstSrc.includes('/') ? firstSrc.slice(0, firstSrc.lastIndexOf('/')) : '/';
        // Prevent dropping onto the same directory
        if (destPath === srcPath) return;
      }
    }
    
    const total = srcs.length;
    dragState = { entries: [], srcPath: '' };
    // r_p6: conflict check for copy operations
    if (op === 'copy') {
      const conflicts = await _checkConflicts(srcs, destPath);
      if (conflicts.length) {
        const action = await _showConflictDialog(conflicts);
        if (action === 'cancel') { dragState = { entries: [], srcPath: '' }; return; }
        if (action === 'skip') {
          const cs = new Set(conflicts);
          srcs = srcs.filter(s => !cs.has(s.split('/').pop()));
          if (!srcs.length) return;
        }
      }
    }
    const cmd = op === 'copy' ? 'copy_files_batch' : 'move_files_batch';
    // p7: pass cancelFn so the status-bar ✕ button calls cancel_file_op
    const jobId = _sbProgress.addJob(
      (op === 'copy' ? 'Copying' : 'Moving') + ' 0 / ' + total, total,
      () => invoke('cancel_file_op').catch(() => {})
    );
    // ── Single listener handles both progress display AND undo tracking ──────────
    // Combining into one listener avoids a second IPC round-trip and ensures
    // undo items are built atomically with the progress update.
    let ddErrors = 0;
    const ddUndoItems = [];
    let _ddResolve;
    const ddDone = new Promise(resolve => { _ddResolve = resolve; });
    const ddUnlisten = await listen('file-op-progress', ev => {
      const { done: d, total: t, name, error, finished } = ev.payload;
      if (error) { ddErrors++; }
      else {
        // Track destination for undo (index d-1 = 0-based file index)
        const src = srcs[d - 1];
        if (src) {
          ddUndoItems.push({
            src,
            dst: destPath + '/' + src.split('/').pop(),
            srcDir: src.substring(0, src.lastIndexOf('/')),
            dstDir: destPath
          });
        }
      }
      _sbProgress.updateJob(jobId, d, t, (op === 'copy' ? 'Copying' : 'Moving') + ' ' + d + ' / ' + t);
      if (finished) _ddResolve();
    });
    invoke(cmd, { srcs, destDir: destPath }).catch(err => { showToast(t('error.drop_failed',{err}),'error'); _ddResolve(); });
    await ddDone;
    ddUnlisten();
    _sbProgress.finishJob(jobId, ddErrors === 0, ddErrors > 0 ? ddErrors + ' error(s)' : (op === 'copy' ? 'Copy' : 'Move') + ' complete');
    const ok = total - ddErrors;
    if (ok > 0) {
      showToast(op==='copy'?t('toast.copied',{n:ok}):t('toast.moved',{n:ok}),'success');
      if (ddUndoItems.length) pushUndo({ op: op === 'copy' ? 'copy' : 'move', items: ddUndoItems });
    }
    if (ddErrors > 0) showToast(t('toast.items_failed',{n:ddErrors}),'error');
    await refreshColumns();
  });
}

// ── Search ────────────────────────────────────────────────────────────────────
let searchDebounce=null;
// Update just the breadcrumb text + spinner without rebuilding the toolbar.
// This keeps the search input focused while the user types.
function _updateSearchLabel(query, searching){
  const rail=document.getElementById('bc-rail');
  if(rail){
    const cnt=state.searchResults.length;
    rail.innerHTML='<span class="bc-search-label">Results for "<strong>'+escHtml(query)+'</strong>"'+(searching?' <span class="search-deep-badge">searching…</span>':'— '+cnt+' item'+(cnt!==1?'s':''))+'</span><div class="bc-deadspace" id="bc-deadspace"></div>';
    document.getElementById('bc-deadspace')?.addEventListener('click',e=>{e.stopPropagation();enterBcEditMode();});
  }
  const spinner=document.querySelector('.tb-spinner');
  if(searching&&!spinner){
    const wrap=document.querySelector('.tb-actions');
    if(wrap){const s=document.createElement('span');s.className='tb-spinner';s.innerHTML='<div class="spinner" style="width:14px;height:14px;border-width:1.5px"></div>';wrap.prepend(s);}
  }else if(!searching&&spinner){spinner.remove();}
}

let _searchGen=0;
async function doGlobalSearch(query){
  if(!query.trim()){state.searchMode=false;render();return;}

  // Cancel if a newer search has already started
  const thisGen=++_searchGen;

  state.searchMode=true;state.searchQuery=query;state.loading=true;
  state.searchResults=[];state.selIdx=-1;sel.clear();
  state.previewEntry=null;state.previewData=null;
  _updateSearchLabel(query, true);

  // Search root = the top-level folder you navigated to (first column / sidebar selection),
  // NOT state.currentPath which goes deep into subfolders in column view.
  const searchRoot = state.columns[0]?.path || state.currentPath || '/';
  try{
    // p7: filename-only queries use the fast in-memory index; content searches use deep_search
  const isContentSearch = query.startsWith('content:') || query.startsWith('regex:');
  const result = isContentSearch
    ? await invoke('deep_search', { root: searchRoot, query: query.replace(/^content:|^regex:/, '').trim(), includeHidden: state.showHidden, maxResults: 2000 })
    : await invoke('search_index_query', { query, maxResults: 2000 })
        .then(r => ({ entries: r, searched: r.length, truncated: false }))
        .catch(() => invoke('deep_search', { root: searchRoot, query, includeHidden: state.showHidden, maxResults: 2000 }));
    if(thisGen!==_searchGen)return; // superseded by a newer keystroke
    // Deduplicate by path (parallel search can return same file from multiple top-dirs)
    const seen=new Set();
    state.searchResults=result.entries.filter(e=>seen.has(e.path)?false:(seen.add(e.path),true));
    // Note: results are pre-sorted by name in Rust — no JS re-sort needed
    if(result.truncated)showToast(t('toast.search_truncated'),'info');
  }catch(e){if(thisGen===_searchGen)showToast(t('error.search_error',{err:e}),'error','search');}
  finally{
    if(thisGen===_searchGen){
      state.loading=false;syncState();
      _updateSearchLabel(query, false);
      // Render view WITHOUT touching toolbar — preserve focus completely
      const host=document.getElementById('view-host');
      if(host)renderFlatList(host,state.searchResults);
      renderStatus();
      // Restore caret position in search box
      const si=document.getElementById('search-in');
      if(si&&document.activeElement!==si){
        const pos=si.value.length;
        si.focus();si.setSelectionRange(pos,pos);
      }
    }
  }
}


// ── Preview ───────────────────────────────────────────────────────────────────
async function loadPreview(entry){
  if(!entry||entry.is_dir){
    // Column view returns FileEntryFast — enrich with full stat before showing folder info panel.
    if(entry&&entry.modified==null){
      try{const m=await invoke('get_entry_meta',{path:entry.path});if(m)entry=m;}catch(e){}
    }
    state.previewEntry=entry;state.previewData=null;renderPreview();return;
  }
  // Enrich file entry if it came from a fast listing (missing size/modified/permissions).
  if(entry.modified==null){
    try{const m=await invoke('get_entry_meta',{path:entry.path});if(m)entry=m;}catch(e){}
  }
  const ext2=(entry.extension||'').toLowerCase();
  const isMedia=VIDEO_EXTS.includes(ext2)||AUDIO_EXTS.includes(ext2)||PDF_EXTS.includes(ext2);
  const isImg=IMAGE_EXTS.includes(ext2);
  // Images and media: skip IPC entirely — renderPreview uses HTTP media server URL directly
  if(isMedia||isImg){state.previewEntry=entry;state.previewData=null;state.previewLoading=false;renderPreview();return;}
  state.previewEntry=entry;state.previewLoading=true;renderPreview();
  try{state.previewData=await invoke('get_file_preview',{path:entry.path});}catch(e){state.previewData=null;}
  state.previewLoading=false;renderPreview();
}

async function handleEntryClick(entry,idx,e){
  if(e?.shiftKey&&sel.last>=0)sel.range(sel.last,idx);
  else if(e?.ctrlKey||e?.metaKey)sel.toggle(idx);
  else sel.set(idx);
  state.selIdx=idx;
  if(state.viewMode==='column'){const last=state.columns[state.columns.length-1];if(last)last.selIdx=idx;}
  const isMulti=e?.ctrlKey||e?.metaKey||e?.shiftKey;
  if(entry.is_dir){
    state.previewEntry=entry;state.previewData=null;renderPreview();
    // Column view: single-click navigates (that's the column paradigm).
    // Icon/list/flat: single-click only selects — navigate on dblclick instead,
    // unless ff_single_click is enabled, in which case any single-click navigates.
    const _singleClickPref = localStorage.getItem('ff_single_click') === '1';
    if((state.viewMode==='column'||_singleClickPref)&&sel.size===1&&!isMulti){
      await navigate(entry.path,state.columns.length);
    }
  } else {
    await loadPreview(entry);
  }
  render();
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
async function loadSidebar(){
  try{state.sidebarData=await invoke('get_sidebar_data');}catch(e){logError(String(e),'caught');console.error(e);}
  renderSidebar();
}
async function pollDrives(){
  try{
    const drives=await invoke('get_drives');
    if(JSON.stringify(drives)!==JSON.stringify(state.sidebarData.drives)){
      state.sidebarData.drives=drives;renderSidebar();
    }
  }catch(e){}
}

function getSidebarFavs(){try{return JSON.parse(localStorage.getItem('ff_sb_favs')||'[]');}catch(e){return[];}}
function saveSidebarFavs(favs){localStorage.setItem('ff_sb_favs',JSON.stringify(favs));}
function addSidebarFav(path,name){
  const favs=getSidebarFavs();
  if(favs.find(f=>f.path===path)){showToast(t('toast.already_in_sidebar'),'info');return;}
  const label=name||(path.split('/').filter(Boolean).pop()||path);
  favs.push({name:label,path});saveSidebarFavs(favs);renderSidebar();showToast(t('toast.added_to_sidebar',{name:label}),'success');
}
function removeSidebarFav(path){saveSidebarFavs(getSidebarFavs().filter(f=>f.path!==path));renderSidebar();}


// Empty trash with sidebar progress bar — replaces plain invoke('empty_trash')
async function _emptyTrashWithProgress() {
  // listen is statically imported at the top of main.js — no dynamic import needed
  _sbProgress.start('Preparing to empty trash…', 1);
  let unlisten;
  try {
    unlisten = await listen('trash-progress', ev => {
      const {done, total, finished} = ev.payload;
      if (finished) {
        _sbProgress.finish(true, `Trash emptied (${done} items)`);
      } else if (total > 0) {
        _sbProgress.update(done, total, `Emptying trash… ${done} / ${total}`);
      }
    });
    const n = await invoke('empty_trash_stream');
    showToast(t('toast.trash_emptied',{n}),'success');
    await refreshColumns();
  } catch(err) {
    _sbProgress.error('Empty trash failed: ' + err);
    throw err;
  } finally {
    unlisten?.();
  }
}

// ── Sidebar section collapse state ───────────────────────────────────────────
// Persisted as JSON array of collapsed section names in localStorage ff_sb_collapsed.
function _getSbCollapsed() {
  try { return new Set(JSON.parse(localStorage.getItem('ff_sb_collapsed') || '[]')); }
  catch { return new Set(); }
}
function _setSbCollapsed(set) {
  localStorage.setItem('ff_sb_collapsed', JSON.stringify([...set]));
}
function _toggleSbSection(name) {
  const s = _getSbCollapsed();
  s.has(name) ? s.delete(name) : s.add(name);
  _setSbCollapsed(s);
  renderSidebar();
}


function renderSidebar(){
  const el=document.getElementById('sidebar');
  const{favorites,drives}=state.sidebarData;
  const custom=getSidebarFavs();
  const seen=new Set();
  const allFavs=[
    ...favorites.filter(f=>f.exists).map(f=>({name:f.name,path:f.path,icon:f.icon,builtin:true})),
    ...custom.map(f=>({name:f.name,path:f.path,icon:'folder',builtin:false})),
  ].filter(f=>{if(seen.has(f.path))return false;seen.add(f.path);return true;});

  // ── Recent Locations section ──────────────────────────────────────────────
  const recentPaths = _getPathHistory().slice(0, 8);
  const recentSectionHtml = recentPaths.length ? `
    <div class="sb-section">
      <div class="sb-title">Recent</div>
      ${recentPaths.map(p => {
        const label = p.split('/').filter(Boolean).pop() || '/';
        const active = state.currentPath === p;
        return `<div class="sb-item ${active?'active':''}" data-path="${p.replace(/"/g,'&quot;')}" title="${p.replace(/"/g,'&quot;')}">
          <span class="sb-ico" style="color:${active?'#fff':'#60a5fa'}">${I.folder.replace('<svg','<svg style="width:14px;height:14px"')}</span>
          <span class="sb-lbl" style="font-size:11.5px">${label}</span>
        </div>`;
      }).join('')}
    </div>` : '';

  // ── Tags section ─────────────────────────────────────────────────────────
  const tagsWithColors = (state._allTags||[]).map(t=>({name:t,color:state._tagColors?.[t]||'#60a5fa'}));
  const tagsSectionHtml = tagsWithColors.length ? `
    <div class="sb-section">
      <div class="sb-title">Tags</div>
      ${tagsWithColors.map(t=>`
        <div class="sb-item sb-tag-item ${state.activeTag===t.name?'active':''}" data-tag="${t.name}">
          <span class="sb-tag-dot" style="background:${t.color};"></span>
          <span class="sb-lbl">${t.name}</span>
        </div>`).join('')}
    </div>` : '';

  // ── r53: Saved searches section ─────────────────────────────────────────
  const savedSearches = _getSavedSearches();
  const savedSearchesSectionHtml = savedSearches.length ? `
    <div class="sb-section">
      <div class="sb-title">Saved Searches</div>
      ${savedSearches.map((s,i)=>`
        <div class="sb-item sb-saved-search" data-ss-idx="${i}" title="${s.rootPath||''}">
          <span class="sb-ico" style="color:#a78bfa"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:13px;height:13px"><circle cx="6.5" cy="6.5" r="4"/><path d="M10 10l3 3"/></svg></span>
          <span class="sb-lbl">${s.name}</span>
          <button class="sb-rm-btn" data-ss-del="${i}" title="Delete saved search">×</button>
        </div>`).join('')}
    </div>` : '';

  // Pre-build drives HTML to avoid nested backtick issues
  const drivesHtml = drives.length ? (()=>{
    const HIDDEN_MOUNTS=new Set(['/','/home','/boot','/boot/efi','/var','/var/log','/var/tmp','/tmp','/usr','/opt','/srv','/snap','/run']);
    const rows = drives.filter(d=>!HIDDEN_MOUNTS.has(d.path)).map(d=>{
      const badge = driveTypeBadge(d);
      const isEjectable = d.is_mounted;
      const bClr = {'usb':'#34d399','nvme':'#a78bfa','ssd':'#60a5fa','hdd':'#94a3b8','network':'#60a5fa','optical':'#f472b6'}[d.drive_type]||'#94a3b8';
      const safePath = d.path.replace(/"/g,'&quot;');
      const safeDevice = d.device.replace(/"/g,'&quot;');
      const subLbl = d.is_mounted && d.total_bytes
        ? '<span class="sb-sublbl">'+fmtDriveSpace(d)+'</span>'
        : !d.is_mounted
          ? '<span class="sb-sublbl sb-sublbl-unmounted">Not mounted — click to mount</span>'
          : '';
      const badgeHtml = badge ? '<span class="sb-drive-badge" style="background:'+bClr+'22;color:'+bClr+';border-color:'+bClr+'44">'+badge+'</span>' : '';
      const ejectHtml = isEjectable ? '<button class="eject-btn" data-device="'+safeDevice+'" data-mountpoint="'+safePath+'" title="Eject"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px"><polyline points="17 11 12 6 7 11"/><line x1="17" y1="18" x2="7" y2="18"/></svg></button>' : '';
      // LUKS unlock uses udisksctl — Linux only
      const isEncrypted = (state._platform === 'linux') &&
        (d.filesystem==='crypto_LUKS'||d.filesystem==='crypto_BITLK'||d.filesystem==='BitLocker');
      const lockIcon = isEncrypted ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;margin-right:2px"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>' : '';
      const mountHtml = !d.is_mounted ? '<button class="mount-btn" data-device="'+safeDevice+'" data-encrypted="'+isEncrypted+'" data-name="'+d.name.replace(/"/g,'&quot;')+'" title="'+(isEncrypted?'Unlock &amp; mount (encrypted)':'Mount drive')+'">'+lockIcon+'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px"><polyline points="7 13 12 18 17 13"/><line x1="12" y1="18" x2="12" y2="6"/><line x1="5" y1="6" x2="19" y2="6"/></svg></button>' : '';
      const barHtml = d.is_mounted && d.total_bytes ? '<div class="drive-bar-wrap"><div class="drive-bar" style="width:'+Math.round((d.total_bytes-d.free_bytes)/d.total_bytes*100)+'%"></div></div>' : '';
      const activeClass = state.activeSb===d.path && d.is_mounted ? 'active' : '';
      const unmountedClass = !d.is_mounted ? ' sb-drive-unmounted' : '';
      const icoColor = activeClass ? '#fff' : driveColor(d);
      return '<div class="sb-item sb-drive '+activeClass+unmountedClass+'" data-path="'+safePath+'" data-device="'+safeDevice+'" data-mounted="'+d.is_mounted+'" title="'+fmtDriveSpace(d)+'&#10;'+d.filesystem+'">'
        +'<span class="sb-ico" style="color:'+icoColor+'">'+driveIcon(d)+'</span>'
        +'<span class="sb-lbl-wrap"><span class="sb-lbl">'+d.name+'</span>'+subLbl+'</span>'
        +badgeHtml+ejectHtml+mountHtml
        +'</div>'+barHtml;
    });
    return '<div class="sb-section"><div class="sb-title">Locations</div>'+rows.join('')+'</div>';
  })() : '';
    el.innerHTML='\n    ' + (recentSectionHtml) + '\n    <div class="sb-section">\n      <div class="sb-title">Favorites<div class="sb-size-ctrl"><button class="sb-size-btn" id="sb-size-dec" title="Smaller icons"><svg viewBox="0 0 10 2" fill="currentColor" style="width:10px;height:10px"><rect x="0" y="0" width="10" height="2" rx="1"/></svg></button><button class="sb-size-btn" id="sb-size-inc" title="Larger icons"><svg viewBox="0 0 10 10" fill="currentColor" style="width:10px;height:10px"><rect x="4" y="0" width="2" height="10" rx="1"/><rect x="0" y="4" width="10" height="2" rx="1"/></svg></button></div></div>\n      ' + (allFavs.map((f,i)=>`
        <div class="sb-item ${state.activeSb===f.path?'active':''}" data-path="${f.path.replace(/"/g,'&quot;')}" data-fav-idx="${i}" draggable="${!f.builtin}">
          ${!f.builtin?'<span class="sb-drag-handle" title="Drag to reorder">⠿</span>':''}
          <span class="sb-ico" style="color:${state.activeSb===f.path?'#fff':favColor(f.icon)}">${favIcon(f.icon)}</span>
          <span class="sb-lbl">${f.name}</span>
          ${!f.builtin?`<button class="sb-rm-btn" data-rmpath="${f.path.replace(/"/g,'&quot;')}" title="Remove">×</button>`:''}
        </div>`).join('')) + '\n    </div>\n    ' + (drivesHtml) + '\n    ' + (tagsSectionHtml) + '\n    ' + (savedSearchesSectionHtml);

  // p8: settings button pinned at bottom of sidebar
  const sbFoot = document.createElement('div');
  sbFoot.className = 'sb-footer';
  sbFoot.innerHTML = `
    <div class="sb-footer-row">
      <button class="sb-settings-btn" title="Settings (Ctrl+,)">
        <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="3"/>
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
        </svg>
        <span>Settings</span>
      </button>
      <button class="sb-cheatsheet-btn" title="Keyboard shortcuts (Ctrl+?)">
        <svg width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
          <rect x="2" y="4" width="20" height="16" rx="3"/>
          <rect x="5" y="8" width="3" height="2.5" rx="0.6" fill="currentColor" stroke="none"/>
          <rect x="10.5" y="8" width="3" height="2.5" rx="0.6" fill="currentColor" stroke="none"/>
          <rect x="16" y="8" width="3" height="2.5" rx="0.6" fill="currentColor" stroke="none"/>
          <rect x="5" y="12.5" width="3" height="2.5" rx="0.6" fill="currentColor" stroke="none"/>
          <rect x="10.5" y="12.5" width="3" height="2.5" rx="0.6" fill="currentColor" stroke="none"/>
          <rect x="16" y="12.5" width="3" height="2.5" rx="0.6" fill="currentColor" stroke="none"/>
        </svg>
      </button>
    </div>`;
  sbFoot.querySelector('.sb-settings-btn').addEventListener('click', () => _showSettings());
  sbFoot.querySelector('.sb-cheatsheet-btn').addEventListener('click', () => showCheatSheet());
  el.appendChild(sbFoot);

  // ── Collapsible section wiring ─────────────────────────────────────────────
  const _sbCollapsed = _getSbCollapsed();
  el.querySelectorAll('.sb-section').forEach(sec => {
    const titleEl = sec.querySelector('.sb-title');
    if (!titleEl) return;
    // Use the text content as the section key (strip any child element text)
    const name = titleEl.childNodes[0]?.textContent?.trim() || titleEl.textContent.trim();
    const collapsed = _sbCollapsed.has(name);

    // Add chevron if not already present
    if (!titleEl.querySelector('.sb-chevron')) {
      const chev = document.createElement('span');
      chev.className = 'sb-chevron';
      chev.textContent = collapsed ? '▸' : '▾';
      chev.style.cssText = 'margin-left:auto;font-size:9px;opacity:0.5;transition:transform .15s;flex-shrink:0;';
      titleEl.style.cursor = 'pointer';
      titleEl.style.display = titleEl.style.display || 'flex';
      titleEl.style.alignItems = 'center';
      titleEl.appendChild(chev);
    }

    // Hide/show items (everything after the title in the section)
    Array.from(sec.children).forEach(child => {
      if (child === titleEl) return;
      child.style.display = collapsed ? 'none' : '';
    });

    // Mark section so CSS can react if needed
    sec.dataset.sbSection = name;
    sec.dataset.collapsed = collapsed ? '1' : '';

    // Click handler on title
    titleEl.addEventListener('click', e => {
      // Don't fire when clicking child buttons (size +/-, remove, etc.)
      if (e.target.closest('button, .sb-size-ctrl')) return;
      _toggleSbSection(name);
    });
  });

  document.getElementById('sb-size-inc')?.addEventListener('click',e=>{
    e.stopPropagation();state.sidebarScale=Math.min(1.4,state.sidebarScale+0.1);applySidebarScale();
  });
  document.getElementById('sb-size-dec')?.addEventListener('click',e=>{
    e.stopPropagation();state.sidebarScale=Math.max(0.75,state.sidebarScale-0.1);applySidebarScale();
  });
  el.querySelectorAll('.sb-rm-btn').forEach(btn=>{btn.addEventListener('click',e=>{e.stopPropagation();if(btn.dataset.rmpath)removeSidebarFav(btn.dataset.rmpath);if(btn.dataset.ssDel!==undefined)_deleteSavedSearch(+btn.dataset.ssDel);});});
  el.querySelectorAll('.sb-saved-search').forEach(item=>{item.addEventListener('click',e=>{if(e.target.closest('.sb-rm-btn'))return;_runSavedSearch(_getSavedSearches()[+item.dataset.ssIdx]);});});
  el.querySelectorAll('.eject-btn').forEach(btn=>{
    btn.addEventListener('click',async e=>{
      e.stopPropagation();
      try{await invoke('eject_drive',{mountpoint:btn.dataset.mountpoint,device:btn.dataset.device});showToast(t('toast.ejected'),'success');setTimeout(()=>invoke('get_drives').then(d=>{state.sidebarData.drives=d;renderSidebar();}),800);}
      catch(err){showToast(t('toast.eject_failed',{err}),'error');}
    });
  });
  el.querySelectorAll('.mount-btn').forEach(btn=>{
    btn.addEventListener('click',async e=>{
      e.stopPropagation();
      const device = btn.dataset.device;
      const isEncrypted = btn.dataset.encrypted === 'true';
      const driveName = btn.dataset.name || device;

      if (isEncrypted) {
        // Show password dialog for LUKS/BitLocker encrypted drives
        _showUnlockDialog(device, driveName);
        return;
      }

      showToast(t('toast.mounting_device',{device}),'info');
      try{
        const mountpoint=await invoke('mount_drive',{device});
        showToast(t('toast.mounted_at',{path:mountpoint}),'success');
        const drives=await invoke('get_drives');
        state.sidebarData.drives=drives;
        state.activeSb=mountpoint;
        renderSidebar();
        if(mountpoint)navigate(mountpoint,0);
      }catch(err){showToast(t('toast.mount_failed',{err}),'error');}
    });
  });

  function _showUnlockDialog(device, driveName) {
    document.getElementById('ff-unlock-dialog')?.remove();
    const dlg = document.createElement('div');
    dlg.id = 'ff-unlock-dialog';
    dlg.style.cssText = 'position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);backdrop-filter:blur(4px);';
    dlg.innerHTML = `
      <div style="background:#1e1e21;border:1px solid rgba(255,255,255,.12);border-radius:14px;padding:28px 28px 22px;min-width:340px;max-width:420px;box-shadow:0 16px 48px rgba(0,0,0,.7);">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:18px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2" style="width:22px;height:22px;flex-shrink:0">
            <rect x="3" y="11" width="18" height="11" rx="2"/>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
          </svg>
          <div>
            <div style="font-size:14px;font-weight:600;color:#f1f5f9">Encrypted Drive</div>
            <div style="font-size:11px;color:#636368;margin-top:2px;max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${driveName}</div>
          </div>
        </div>
        <label style="display:block;font-size:11px;color:#98989f;margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;">Passphrase</label>
        <div style="position:relative;">
          <input id="ff-unlock-pw" type="password" autocomplete="current-password"
            placeholder="Enter passphrase…"
            style="width:100%;box-sizing:border-box;padding:9px 36px 9px 11px;background:#2a2a2d;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#f1f5f9;font-size:13px;outline:none;font-family:inherit;"
          />
          <button id="ff-unlock-toggle" tabindex="-1" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;color:#636368;cursor:pointer;padding:2px;line-height:0;" title="Show/hide">
            <svg id="ff-eye-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
            </svg>
          </button>
        </div>
        <div id="ff-unlock-err" style="color:#f87171;font-size:11px;margin-top:6px;min-height:16px;"></div>
        <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end;">
          <button id="ff-unlock-cancel" style="padding:7px 16px;background:rgba(255,255,255,.07);border:none;border-radius:7px;color:#98989f;font-size:13px;cursor:pointer;">Cancel</button>
          <button id="ff-unlock-ok" style="padding:7px 18px;background:#7c3aed;border:none;border-radius:7px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;">Unlock</button>
        </div>
      </div>`;
    document.body.appendChild(dlg);

    const pwInput = dlg.querySelector('#ff-unlock-pw');
    const errEl   = dlg.querySelector('#ff-unlock-err');
    const okBtn   = dlg.querySelector('#ff-unlock-ok');
    const cancelBtn = dlg.querySelector('#ff-unlock-cancel');
    const toggleBtn = dlg.querySelector('#ff-unlock-toggle');
    const eyeIcon = dlg.querySelector('#ff-eye-icon');

    // Focus input
    setTimeout(()=>pwInput.focus(), 50);

    // Show/hide password toggle
    toggleBtn.addEventListener('click', () => {
      const show = pwInput.type === 'password';
      pwInput.type = show ? 'text' : 'password';
      eyeIcon.innerHTML = show
        ? '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>'
        : '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
    });

    const doUnlock = async () => {
      const passphrase = pwInput.value;
      if (!passphrase) { errEl.textContent = 'Please enter a passphrase.'; pwInput.focus(); return; }
      okBtn.disabled = true; okBtn.textContent = 'Unlocking…';
      errEl.textContent = '';
      try {
        const mountpoint = await invoke('unlock_and_mount_encrypted', { device, passphrase });
        dlg.remove();
        showToast(t('toast.unlock_mounted',{path:mountpoint||device}),'success');
        const drives = await invoke('get_drives');
        state.sidebarData.drives = drives;
        state.activeSb = mountpoint;
        renderSidebar();
        if (mountpoint) navigate(mountpoint, 0);
      } catch(err) {
        errEl.textContent = String(err);
        okBtn.disabled = false; okBtn.textContent = 'Unlock';
        pwInput.select(); pwInput.focus();
      }
    };

    okBtn.addEventListener('click', doUnlock);
    pwInput.addEventListener('keydown', e => { if (e.key==='Enter') doUnlock(); if (e.key==='Escape') dlg.remove(); });
    cancelBtn.addEventListener('click', () => dlg.remove());
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.remove(); });
  }
  el.querySelectorAll('.sb-tag-item').forEach(item=>{
    item.addEventListener('click',async ()=>{
      const tag=item.dataset.tag;
      if(state.activeTag===tag){
        // Toggle off — go back to current folder
        state.activeTag=null;state.searchMode=false;state.searchResults=[];
        sel.clear();render();renderSidebar();return;
      }
      state.activeTag=tag;state.activeSb=null;
      state.searchMode=true;state.searchQuery='tag:'+tag;
      state.loading=true;sel.clear();
      state.previewEntry=null;state.previewData=null;
      renderToolbar();renderView();renderStatus();
      try{
        const results=await invoke('search_by_tag',{tag});
        state.searchResults=results.map(r=>({
          path:r.path,name:r.path.split('/').pop(),is_dir:false,
          extension:r.path.includes('.')?r.path.split('.').pop().toLowerCase():'',
          is_hidden:false,is_symlink:false,size:0,modified:0,permissions:''
        }));
        // Enrich with full metadata
        state.searchResults=await Promise.all(state.searchResults.map(async e=>{
          try{const m=await invoke('get_entry_meta',{path:e.path});return m||e;}catch{return e;}
        }));
        state.searchResults=state.searchResults.filter(Boolean);
      }catch(err){showToast(t('error.tag_search',{err}),'error');}
      finally{state.loading=false;syncState();render();renderSidebar();}
    });
  });
  el.querySelectorAll('.sb-item:not(.sb-tag-item)').forEach(item=>{
    setupDropTarget(item,item.dataset.path);
  });
  // Drag folder onto Favorites title → add to sidebar
  const favTitle = el.querySelector('.sb-section .sb-title');
  if(favTitle){
    favTitle.style.cursor='copy';
    favTitle.addEventListener('dragover', e => {
      if(dragState.entries.length>0&&dragState.entries.every(en=>en.is_dir)){
        e.preventDefault(); e.stopPropagation();
        favTitle.style.background='rgba(91,141,217,.2)';
      }
    });
    favTitle.addEventListener('dragleave', () => { favTitle.style.background=''; });
    favTitle.addEventListener('drop', e => {
      e.preventDefault(); e.stopPropagation();
      favTitle.style.background='';
      dragState.entries.filter(en=>en.is_dir).forEach(en=>addSidebarFav(en.path,en.name));
    });
  }
  // Use a single delegated listener on the sidebar container — avoids duplicate
  // listeners that accumulate when renderSidebar() is called multiple times while
  // a click event is already queued in the browser event pipeline.
  el._sbNavHandler && el.removeEventListener('click', el._sbNavHandler);
  el._sbNavHandler = (ev)=>{
    const item=ev.target.closest('.sb-item:not(.sb-tag-item)');
    if(!item||!item.dataset.path)return;
    if(ev.target.closest('.sb-rm-btn,.eject-btn,.mount-btn'))return;
    // Unmounted drives: clicking is handled by .mount-btn; ignore body clicks
    if(item.dataset.mounted==='false')return;
    const path=item.dataset.path;
    if(!path)return;
    state.activeSb=path;state.activeTag=null;state.columns=[];state.searchMode=false;
    state.search='';sel.clear();const si=document.getElementById('search-in');if(si)si.value='';
    FF.log('CLICK_SIDEBAR',{path});
    navigate(path,0);renderSidebar();
  };
  el.addEventListener('click', el._sbNavHandler);

  // ── Favorites drag-to-reorder ─────────────────────────────────────────────
  let _dragFavIdx = -1;
  el.querySelectorAll('.sb-item[data-fav-idx][draggable="true"]').forEach(item => {
    item.addEventListener('dragstart', e => {
      _dragFavIdx = +item.dataset.favIdx;
      e.dataTransfer.effectAllowed = 'move';
      item.style.opacity = '0.5';
    });
    item.addEventListener('dragend', () => { item.style.opacity=''; _dragFavIdx=-1; });
    item.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect='move'; item.style.background='rgba(91,141,217,.15)'; });
    item.addEventListener('dragleave', () => { item.style.background=''; });
    item.addEventListener('drop', e => {
      e.preventDefault(); item.style.background='';
      const toIdx = +item.dataset.favIdx;
      if(_dragFavIdx<0 || _dragFavIdx===toIdx) return;
      const favs = getSidebarFavs();
      // allFavs includes builtin items; only custom ones are draggable
      // favIdx is the index in allFavs; custom favs start after builtins
      const builtinCount = allFavs.length - favs.length;
      const fromCustom = _dragFavIdx - builtinCount;
      const toCustom   = toIdx - builtinCount;
      if(fromCustom<0||toCustom<0||fromCustom>=favs.length||toCustom>=favs.length) return;
      const [moved] = favs.splice(fromCustom, 1);
      favs.splice(toCustom, 0, moved);
      saveSidebarFavs(favs);
      renderSidebar();
    });
  });

  // ── r42: SFTP mounts in sidebar ──────────────────────────────────────────
  invoke('get_sftp_mounts').then(mounts => {
    if (!mounts || !mounts.length) return;
    const net = document.createElement('div');
    net.className = 'sb-section';
    net.innerHTML = '<div class="sb-title">SFTP</div>' +
      mounts.map(m => `<div class="sb-item${state.currentPath?.startsWith(m.mount_path)?' active':''}" data-path="${m.mount_path}" data-sftp-id="${m.id}">
        <span class="sb-ico">⇌</span><span class="sb-lbl">${m.label}</span>
        <button class="sb-reconnect-btn" data-sftp-reconnect="${m.id}" data-sftp-host="${m.host}" data-sftp-port="${m.port}" data-sftp-user="${m.username}" data-sftp-remote="${m.remote_path}" data-sftp-key="${m.key_path||''}" title="Reconnect">↻</button>
        <button class="sb-rm-btn" data-sftp-disconnect="${m.id}" title="Disconnect">✕</button>
      </div>`).join('');
    document.getElementById('sidebar')?.appendChild(net);
    net.querySelectorAll('[data-sftp-reconnect]').forEach(btn=>{
      // Password-auth mounts (no stored key) can't silently reconnect.
      // Replace ↻ with ↗ that opens the dialog pre-filled with host/user.
      if (!btn.dataset.sftpKey) {
        const link = document.createElement('button');
        link.className = 'sb-reconnect-btn'; link.title = 'Reconnect (opens dialog)'; link.textContent = '↗1';
        link.addEventListener('click', e => {
          e.stopPropagation();
          showSftpDialog({ host:btn.dataset.sftpHost, port:btn.dataset.sftpPort,
            username:btn.dataset.sftpUser, remotePath:btn.dataset.sftpRemote });
        });
        btn.replaceWith(link); return;
      }
      btn.addEventListener('click',async e=>{
        e.stopPropagation(); btn.textContent='…'; btn.disabled=true;
        try{
          const mp=await invoke('mount_sftp',{
            host:btn.dataset.sftpHost,
            port:parseInt(btn.dataset.sftpPort)||22,
            username:btn.dataset.sftpUser,
            password:'',
            keyPath:btn.dataset.sftpKey||'',
            remotePath:btn.dataset.sftpRemote||'/'
          });
          showToast(t('toast.sftp_reconnected'),'success');renderSidebar();navigate(mp,0);
        }catch(err){
          showToast(t('error.reconnect',{err}),'error');
          btn.textContent='↻';btn.disabled=false;
        }
      });
    });
    net.querySelectorAll('[data-sftp-disconnect]').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        await invoke('unmount_sftp', {id: btn.dataset.sftpDisconnect}).catch(err => showToast(t('error.unmount',{err}),'error'));
        showToast(t('toast.sftp_disconnected'),'info'); renderSidebar();
      });
    });
    net.querySelectorAll('.sb-item[data-path]').forEach(item => {
      item.addEventListener('click', () => { if(!item.querySelector('[data-sftp-disconnect]:hover')) navigate(item.dataset.path, 0); });
    });
  }).catch(() => {});

  // ── r42: FTP mounts in sidebar ────────────────────────────────────────────
  invoke('get_ftp_mounts').then(mounts => {
    if (!mounts || !mounts.length) return;
    const net = document.createElement('div');
    net.className = 'sb-section';
    net.innerHTML = '<div class="sb-title">FTP</div>' +
      mounts.map(m => `<div class="sb-item${state.currentPath?.startsWith(m.mount_path)?' active':''}" data-path="${m.mount_path}" data-ftp-id="${m.id}">
        <span class="sb-ico">🖧</span><span class="sb-lbl">${m.label}</span>
        <button class="sb-rm-btn" data-ftp-disconnect="${m.id}" title="Disconnect">✕</button>
      </div>`).join('');
    document.getElementById('sidebar')?.appendChild(net);
    net.querySelectorAll('[data-ftp-disconnect]').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        await invoke('unmount_ftp', {id: btn.dataset.ftpDisconnect}).catch(err => showToast(t('error.unmount',{err}),'error'));
        showToast(t('toast.ftp_disconnected'),'info'); renderSidebar();
      });
    });
    net.querySelectorAll('.sb-item[data-path]').forEach(item => {
      item.addEventListener('click', () => { if(!item.querySelector('[data-ftp-disconnect]:hover')) navigate(item.dataset.path, 0); });
    });
  }).catch(() => {});

  // ── r53: SMB mounts in sidebar ───────────────────────────────────────────
  invoke('get_smb_mounts').then(mounts => {
    if (!mounts || !mounts.length) return;
    const net = document.createElement('div');
    net.className = 'sb-section';
    net.innerHTML = '<div class="sb-title">SMB</div>' +
      mounts.map(m => {
        const label = m.share ? `${m.server}/${m.share}` : m.server;
        const active = state.currentPath?.startsWith(m.mount_point) ? ' active' : '';
        const safeMp = (m.mount_point||'').replace(/"/g,'&quot;');
        const safeServer = (m.server||'').replace(/"/g,'&quot;');
        const safeShare  = (m.share||'').replace(/"/g,'&quot;');
        return `<div class="sb-item${active}" data-path="${safeMp}">
          <span class="sb-ico" style="color:#60a5fa">⇌</span>
          <span class="sb-lbl">${label}</span>
          <button class="sb-rm-btn" data-smb-server="${safeServer}" data-smb-share="${safeShare}" title="Disconnect">✕</button>
        </div>`;
      }).join('');
    document.getElementById('sidebar')?.appendChild(net);
    net.querySelectorAll('[data-smb-server]').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        await invoke('unmount_smb', {server: btn.dataset.smbServer, share: btn.dataset.smbShare}).catch(err => showToast(t('error.unmount',{err}),'error'));
        showToast(t('toast.smb_disconnected'),'info'); renderSidebar();
      });
    });
    net.querySelectorAll('.sb-item[data-path]').forEach(item => {
      item.addEventListener('click', () => { if(!item.querySelector('[data-smb-disconnect]:hover')) navigate(item.dataset.path, 0); });
    });
  }).catch(() => {});

  // ── r53: WebDAV/Cloud mounts in sidebar ──────────────────────────────────
  invoke('get_cloud_mounts').then(mounts => {
    if (!mounts || !mounts.length) return;
    const net = document.createElement('div');
    net.className = 'sb-section';
    net.innerHTML = '<div class="sb-title">Cloud</div>' +
      mounts.map(m => {
        const active = state.currentPath?.startsWith(m.mount_point) ? ' active' : '';
        const safeMp = (m.mount_point||'').replace(/"/g,'&quot;');
        return `<div class="sb-item${active}" data-path="${safeMp}">
          <span class="sb-ico" style="color:#8b5cf6">☁</span>
          <span class="sb-lbl">${m.name||m.id}</span>
          <button class="sb-rm-btn" data-cloud-disconnect="${m.id}" title="Disconnect">✕</button>
        </div>`;
      }).join('');
    document.getElementById('sidebar')?.appendChild(net);
    net.querySelectorAll('[data-cloud-disconnect]').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        await invoke('unmount_cloud', {cloudId: btn.dataset.cloudDisconnect}).catch(err => showToast(t('error.unmount',{err}),'error'));
        showToast(t('toast.cloud_disconnected'),'info'); renderSidebar();
      });
    });
    net.querySelectorAll('.sb-item[data-path]').forEach(item => {
      item.addEventListener('click', () => { if(!item.querySelector('[data-cloud-disconnect]:hover')) navigate(item.dataset.path, 0); });
    });
  }).catch(() => {});
} // end renderSidebar()

// ── Nautilus-style breadcrumb rail ────────────────────────────────────────────

// Home icon SVG
const HOME_ICON=`<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5L1.5 7H3v7h4v-4h2v4h4V7h1.5L8 1.5z"/></svg>`;

function buildBreadcrumbHtml(state, parts){
  if(state._bcEditMode) return '<div class="bc-input-wrap"><input class="bc-path-input" id="bc-input" type="text" spellcheck="false" autocomplete="off"/><button class="bc-input-clear" id="bc-input-clear" tabindex="-1">&#x2715;</button></div>';
  if(state.searchMode) return `<span class="bc-search-label">Results for "<strong>${escHtml(state.searchQuery)}</strong>" — ${state.searchResults.length} item${state.searchResults.length!==1?'s':''}${state.loading?' <span class="search-deep-badge">searching…</span>':''}</span><div class="bc-deadspace" id="bc-deadspace"></div>`;

  // Build full pill list
  // parts = ['home','user','Documents','Projects'] for /home/user/Documents/Projects
  // We allow max N visible pills before eliding with …
  const MAX_PILLS = 5; // show at most 5 segments before eliding (root + 4)
  let pills = [];
  // Root pill — home icon
  pills.push({label:'', icon:HOME_ICON, path:'/', title:'Root (/)'});
  parts.forEach((p,i)=>{
    pills.push({label:p, icon:null, path:'/'+parts.slice(0,i+1).join('/'), title:'/'+parts.slice(0,i+1).join('/')});
  });

  // Elide middle if too many
  let html='';
  if(pills.length > MAX_PILLS){
    const head = pills.slice(0,1);
    const tail = pills.slice(-(MAX_PILLS-2));
    const hiddenCount = pills.length - MAX_PILLS + 1;
    // render head
    for(const p of head){
      html += _pillHtml(p, false);
      html += '<span class="bc-chevron">/</span>';
    }
    // ellipsis
    html += `<span class="bc-ellipsis" id="bc-ellipsis" title="${hiddenCount} hidden folders">…</span>`;
    html += '<span class="bc-chevron">/</span>';
    // render tail
    for(let i=0;i<tail.length;i++){
      const isLast=i===tail.length-1;
      html += _pillHtml(tail[i], isLast);
      if(!isLast) html += '<span class="bc-chevron">/</span>';
    }
  } else {
    for(let i=0;i<pills.length;i++){
      const isLast=i===pills.length-1;
      html += _pillHtml(pills[i], isLast);
      if(!isLast) html += '<span class="bc-chevron">/</span>';
    }
  }
  html += '<div class="bc-deadspace" id="bc-deadspace"></div>';
  return html;
}

function _pillHtml(p, isActive){
  const cls='bc-pill'+(isActive?' active':'');
  const icon=p.icon?`<span>${p.icon}</span>`:'';
  return `<span class="${cls}" data-path="${p.path}" title="${escHtml(p.title||p.label)}">${icon}${escHtml(p.label)}</span>`;
}

function enterBcEditMode(){
  state._bcEditMode=true;
  // Rebuild just the rail contents without full toolbar re-render (avoids focus steal)
  const rail=document.getElementById('bc-rail');
  if(!rail)return;
  const parts=(state.currentPath||'').split('/').filter(Boolean);
  rail.innerHTML=buildBreadcrumbHtml(state,parts);
  const input=document.getElementById('bc-input');
  if(input){
    input.value=state.currentPath||'/';
    input.focus();
    input.select();
    document.getElementById('bc-input-clear')?.addEventListener('mousedown',e=>{
      e.preventDefault(); // don't blur input
      input.value='';input.focus();
    });
    // Esc → exit without navigating
    input.addEventListener('keydown',async e=>{
      if(e.key==='Escape'){e.preventDefault();exitBcEditMode();return;}
      if(e.key==='Enter'){
        e.preventDefault();
        const val=input.value.trim();
        if(!val)return exitBcEditMode();
        if(val.startsWith('/')){
          // Absolute path — navigate directly
          exitBcEditMode();
          navigate(val,0);
        } else {
          // No leading slash — treat as search query
          exitBcEditMode();
          const si=document.getElementById('search-in');
          if(si){si.value=val;si.dispatchEvent(new Event('input',{bubbles:true}));}
        }
        return;
      }
    });
    // Click-away → exit
    const onOutside=ev=>{
      if(!ev.target.closest('#bc-rail')){exitBcEditMode();document.removeEventListener('mousedown',onOutside,true);}
    };
    // Use capture so it fires before anything else
    setTimeout(()=>document.addEventListener('mousedown',onOutside,true),0);
  }
}

function exitBcEditMode(){
  state._bcEditMode=false;
  const rail=document.getElementById('bc-rail');
  if(!rail)return;
  const parts=(state.currentPath||'').split('/').filter(Boolean);
  rail.innerHTML=buildBreadcrumbHtml(state,parts);
  setupBreadcrumbRail();
}


// ── Path history ─────────────────────────────────────────────────────────────
// Stores the last 25 unique absolute paths visited, newest first.
// Used by the breadcrumb rail to show a "recent paths" dropdown on click.
const _PATH_HISTORY_KEY = 'ff_path_history';
function _getPathHistory() {
  try { return JSON.parse(localStorage.getItem(_PATH_HISTORY_KEY)||'[]'); } catch { return []; }
}
function _recordPathHistory(path) {
  if (!path) return;
  let h = _getPathHistory().filter(p => p !== path);
  h.unshift(path);
  if (h.length > 25) h = h.slice(0, 25);
  localStorage.setItem(_PATH_HISTORY_KEY, JSON.stringify(h));
}

function setupBreadcrumbRail(){
  // Pill clicks → navigate
  document.querySelectorAll('.bc-pill').forEach(el=>{
    el.addEventListener('click',e=>{
      e.stopPropagation();
      const tp=el.dataset.path;
      if(!tp)return;
      if(state.viewMode==='column'){
        const idx=state.columns.findIndex(c=>c.path===tp);
        if(idx>=0){state.columns.splice(idx+1);state.currentPath=tp;render();return;}
      }
      navigate(tp,0);
    });
  });
  // Clicking anywhere on the rail that isn't a pill/chevron/ellipsis → edit mode.
  // This covers the deadspace and any gaps between pills.
  document.getElementById('bc-rail')?.addEventListener('click',e=>{
    if(state._bcEditMode)return;
    if(e.target.closest('.bc-pill,.bc-ellipsis'))return;
    e.stopPropagation();
    enterBcEditMode();
  });
  // History dropdown on the breadcrumb area (right-click or long-press)
  document.getElementById('bc-rail')?.addEventListener('contextmenu', e => {
    e.preventDefault(); e.stopPropagation();
    _showPathHistoryMenu(e.clientX, e.clientY);
  });
  // Keep explicit deadspace handler too for pointer-events fallback
  document.getElementById('bc-deadspace')?.addEventListener('click',e=>{
    e.stopPropagation();
    enterBcEditMode();
  });
  // Ellipsis click → show hidden folders as a small menu
  document.getElementById('bc-ellipsis')?.addEventListener('click',e=>{
    e.stopPropagation();
    _showEllipsisMenu(e.currentTarget);
  });
}

function _showEllipsisMenu(anchor){
  document.getElementById('bc-ell-menu')?.remove();
  const path=state.currentPath||'';
  const parts=path.split('/').filter(Boolean);
  const pills=[];
  parts.forEach((p,i)=>{pills.push({label:p,path:'/'+parts.slice(0,i+1).join('/')});});
  // The "hidden" ones are 1..pills.length-4
  const MAX_PILLS=5;
  if(pills.length<=MAX_PILLS)return;
  const hidden=pills.slice(1,pills.length-(MAX_PILLS-2));
  if(!hidden.length)return;
  const menu=document.createElement('div');
  menu.id='bc-ell-menu';
  const r=anchor.getBoundingClientRect();
  menu.style.cssText=`position:fixed;left:${r.left}px;top:${r.bottom+4}px;background:#2c2c2f;border:1px solid var(--border);border-radius:8px;padding:4px;min-width:180px;box-shadow:0 8px 24px rgba(0,0,0,.55);z-index:9000;`;
  for(const p of hidden){
    const row=document.createElement('div');
    row.style.cssText='padding:5px 10px;border-radius:5px;cursor:pointer;font-size:11.5px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background .08s;';
    row.textContent=p.label;
    row.title=p.path;
    row.onmouseenter=()=>row.style.background='var(--accent-blue)';
    row.onmouseleave=()=>row.style.background='';
    row.addEventListener('click',()=>{
      menu.remove();
      navigate(p.path,0);
    });
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  const close=ev=>{if(!ev.target.closest('#bc-ell-menu')){menu.remove();document.removeEventListener('mousedown',close,true);}};
  setTimeout(()=>document.addEventListener('mousedown',close,true),0);
}

function _showPathHistoryMenu(x, y) {
  document.getElementById('bc-hist-menu')?.remove();
  const history = _getPathHistory();
  if (!history.length) return;
  const menu = document.createElement('div');
  menu.id = 'bc-hist-menu';
  menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;background:#2c2c2f;border:1px solid var(--border);border-radius:10px;padding:4px;min-width:260px;max-width:360px;box-shadow:0 8px 28px rgba(0,0,0,.6);z-index:9000;`;
  const title = document.createElement('div');
  title.style.cssText = 'padding:4px 10px 6px;font-size:10px;color:#636368;text-transform:uppercase;letter-spacing:.06em;';
  title.textContent = 'Recent Locations';
  menu.appendChild(title);
  for (const p of history.slice(0, 20)) {
    const row = document.createElement('div');
    row.style.cssText = 'padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12px;color:var(--text-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:background .08s;';
    // Show home-relative path for readability
    const home = state.currentPath.split('/').slice(0,3).join('/');
    row.textContent = p.startsWith(home) ? '~'+p.slice(home.length) : p;
    row.title = p;
    row.onmouseenter = () => row.style.background = 'var(--accent-blue)';
    row.onmouseleave = () => row.style.background = '';
    row.addEventListener('click', () => { menu.remove(); navigate(p, 0); });
    menu.appendChild(row);
  }
  document.body.appendChild(menu);
  // Flip up if near bottom
  const r = menu.getBoundingClientRect();
  if (r.bottom > window.innerHeight) menu.style.top = (y - r.height) + 'px';
  if (r.right > window.innerWidth) menu.style.left = (x - r.width) + 'px';
  const close = ev => { if (!ev.target.closest('#bc-hist-menu')) { menu.remove(); document.removeEventListener('mousedown', close, true); } };
  setTimeout(() => document.addEventListener('mousedown', close, true), 0);
}



// ── Toolbar ───────────────────────────────────────────────────────────────────
// Last fingerprint that produced the current toolbar DOM.
// If the fingerprint matches, skip the full innerHTML rebuild — saves 15-20ms
// per render() call, which is the entire chunk→resolved gap during streaming.
let _tbFp = '';
function _toolbarFp() {
  return state.currentPath + '|' + state.historyIdx + '|' + state.history.length +
    '|' + state.loading + '|' + state.viewMode + '|' + state.showHidden +
    '|' + state.searchMode + '|' + state.searchQuery + '|' + state.search +
    '|' + (state._bcEditMode || false);
}

function renderToolbar(){
  const path=state.currentPath||'';
  const parts=path.split('/').filter(Boolean);
  const canBack=state.historyIdx>0,canFwd=state.historyIdx<state.history.length-1;
  // Skip full rebuild if nothing toolbar-relevant has changed.
  // This is the primary fix for the chunk→resolved IPC queue delay:
  // renderToolbar() was blocking the JS event loop for 15-20ms on every render(),
  // including the first-chunk render during streaming, preventing the Rust
  // done:true message from being dequeued until the render finished.
  const fp = _toolbarFp();
  if (fp === _tbFp) {
    // Loading spinner is the only thing that can change independently.
    // Update it in-place without touching the rest of the DOM.
    const spinner = document.querySelector('.tb-spinner');
    if (state.loading && !spinner) {
      const wrap = document.querySelector('.tb-actions');
      if (wrap) { const s=document.createElement('span'); s.className='tb-spinner'; s.innerHTML='<div class="spinner" style="width:14px;height:14px;border-width:1.5px"></div>'; wrap.prepend(s); }
    } else if (!state.loading && spinner) {
      spinner.remove();
    }
    return;
  }
  _tbFp = fp;
  document.getElementById('toolbar').innerHTML='\n    <button class="nav-btn ' + (canBack?'':'dim') + '" id="btn-back">' + (I.back) + '</button>\n    <button class="nav-btn ' + (canFwd?'':'dim') + '" id="btn-fwd">' + (I.fwd) + '</button>\n    <div class="breadcrumb" id="bc-rail">' + buildBreadcrumbHtml(state,parts) + '</div>' +
    (gitBranchHtml() ? '<div class="git-branch-wrap">' + gitBranchHtml() + '</div>' : '') +
    '\n    <div class="tb-actions"><button class="tb-btn" title="Debug Log (Ctrl+Shift+L)" onclick="FF.toggle()" style="font-size:10px;opacity:0.6">🪲</button>\n      ' + (state.loading?`<span class="tb-spinner"><div class="spinner" style="width:14px;height:14px;border-width:1.5px"></div></span>`:'') + '\n      <div class="tb-new-wrap">\n        <button class="tb-btn" id="btn-new" title="New...">' + (I.plus) + '</button>\n        <div class="tb-new-dropdown" id="new-dropdown" style="display:none">\n          <div class="nd-item" data-action="new-folder">' + (I.folderPlus) + ' New Folder</div>\n          <div class="nd-item" data-action="new-file">' + (I.filePlus) + ' New Empty File</div>\n          <div class="nd-sep"></div>\n          <div class="nd-item" data-action="new-md">' + (I.doc) + ' Markdown (.md)</div>\n          <div class="nd-item" data-action="new-html">' + (I.code) + ' HTML (.html)</div>\n          <div class="nd-item" data-action="new-py">' + (I.code) + ' Python (.py)</div>\n          <div class="nd-item" data-action="new-sh">' + (I.code) + ' Shell (.sh)</div>\n        </div>\n      </div>\n      <button class="tb-btn" id="btn-terminal" title="Open Terminal Here">' + (I.terminal) + '</button>\n      <div class="view-switcher">\n        ' + ([{id:'icon',icon:I.iconView},{id:'list',icon:I.listView},{id:'column',icon:I.colView},{id:'gallery',icon:I.galleryView}]
          .map(v=>`<button class="vbtn ${state.viewMode===v.id?'active':''}" data-view="${v.id}">${v.icon}</button>`).join('')) + '\n        <button class="vbtn vbtn-split' + (_paneB.active?' active':'') + '" id="btn-split-pane" title="Split pane (Ctrl+\\\\)"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:13px;height:13px"><rect x=\"1\" y=\"2\" width=\"14\" height=\"12\" rx=\"1.5\"/><line x1=\"8\" y1=\"2\" x2=\"8\" y2=\"14\"/></svg></button>\n      </div>\n      <div class="size-slider-wrap" title="Icon & text size">\n        <svg viewBox="0 0 16 16" fill="currentColor" style="width:10px;height:10px;opacity:.5"><rect x="2" y="5" width="6" height="6" rx="1"/></svg>\n        <input type="range" class="size-slider" id="size-slider" min="28" max="120" value="' + (state.iconSize) + '"/>\n        <svg viewBox="0 0 16 16" fill="currentColor" style="width:15px;height:15px;opacity:.5"><rect x="1" y="2" width="10" height="10" rx="1.5"/></svg>\n      </div>\n      <button class="tb-btn" id="btn-sort" title="Sort options"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" style="width:14px;height:14px"><line x1="2" y1="4" x2="13" y2="4"/><line x1="2" y1="8" x2="9" y2="8"/><line x1="2" y1="12" x2="5" y2="12"/></svg></button>\n      <button class="tb-btn" id="btn-icon-theme" title="Icon theme"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px"><circle cx="5" cy="8" r="2.5"/><circle cx="11" cy="5" r="2"/><circle cx="11" cy="11" r="2"/><line x1="7.5" y1="8" x2="9" y2="5.8"/><line x1="7.5" y1="8" x2="9" y2="10.2"/></svg></button>\n      <button class="tb-btn ' + (state.showHidden?'active':'') + '" id="btn-eye">' + (I.eye) + '</button>\n      <div class="search-wrap">\n        <span class="search-ico">' + (I.search) + '</span>\n        <input class="search-input" id="search-in" placeholder="Search everywhere..." value="' + (state.searchMode?state.searchQuery:state.search) + '"/>\n        <button class="search-clear-btn" id="search-clear" title="Clear search">&#x2715;</button>\n      </div>\n    </div>';

  // Wiring
  const btnNew=document.getElementById('btn-new');
  const dropdown=document.getElementById('new-dropdown');
  let _newDropOpen=false;
  const _closeNewDrop=()=>{if(dropdown)dropdown.style.display='none';_newDropOpen=false;};
  btnNew?.addEventListener('click',e=>{
    e.stopPropagation();
    _newDropOpen=!_newDropOpen;
    dropdown.style.display=_newDropOpen?'flex':'none';
    if(_newDropOpen){
      setTimeout(()=>document.addEventListener('click',_closeNewDrop,{once:true,capture:true}),0);
    }
  });
  dropdown?.querySelectorAll('.nd-item').forEach(item=>{
    item.addEventListener('click',e=>{e.stopPropagation();_closeNewDrop();ctxAction(item.dataset.action);});
  });

  document.getElementById('btn-terminal')?.addEventListener('click',()=>{
    invoke('open_terminal',{path:state.currentPath}).catch(err=>showToast(t('error.terminal',{err}),'error'));
  });
  document.getElementById('btn-back')?.addEventListener('click',async()=>{if(canBack){state.historyIdx--;state.columns=[];await navigate(state.history[state.historyIdx],0,false);}});
  document.getElementById('btn-fwd')?.addEventListener('click',async()=>{if(canFwd){state.historyIdx++;state.columns=[];await navigate(state.history[state.historyIdx],0,false);}});
  document.getElementById('size-slider')?.addEventListener('input',e=>{
    state.iconSize=+e.target.value;state.fontSize=Math.round(10+(state.iconSize-28)*(6/52));applyScale();renderView();
  });
  document.getElementById('btn-sort')?.addEventListener('click',e=>{e.stopPropagation();showSortMenu(e.currentTarget);});
  document.getElementById('btn-icon-theme')?.addEventListener('click',e=>{e.stopPropagation();showIconThemePicker();});
  document.getElementById('btn-eye')?.addEventListener('click',()=>{
    state.showHidden=!state.showHidden;
    render();
  });
  const si=document.getElementById('search-in');
  // Search input listeners are attached once via setupSearch() in init() using
  // event delegation on #toolbar — no re-attachment needed on re-render.
  setupBreadcrumbRail();
  document.querySelectorAll('.vbtn').forEach(btn=>{
    if(btn.id==='btn-split-pane'){btn.addEventListener('click',()=>_toggleSplitPane());return;}
    btn.addEventListener('click',async()=>{
      const m=btn.dataset.view;if(m===state.viewMode)return;
      // Preserve selection & focused item — only clear gallerySelIdx
      const savedPaths=[...sel._paths];
      const savedSelIdx=state.selIdx>=0?state.selIdx:(sel.last>=0?sel.last:-1);
      state.viewMode=m;state.gallerySelIdx=-1;localStorage.setItem('ff_viewMode',m);
      announceA11y(({'column':'Column view','list':'List view','icon':'Icon view','gallery':'Gallery view'}[m]||m));
      if(m==='column'){state.columns=[];await navigate(state.currentPath,0,false);}
      else{
        if(!state.columns.length||state.columns[state.columns.length-1].path!==state.currentPath){
          state.loading=true;render();
          try{
            await listDirectoryFullStreamed(state.currentPath,(partial)=>{
              state.columns=[{path:state.currentPath,entries:partial,selIdx:-1}];
              state.loading=false;render();
            });
          }catch(e){}
        }
        render();
      }
      // Re-apply saved selection after view switch, then scroll item into view center
      if(savedPaths.length){
        savedPaths.forEach(p=>sel._paths.add(p));
      }
      if(savedSelIdx>=0){
        sel.last=savedSelIdx;
        state.selIdx=savedSelIdx;
        if(m==='gallery') state.gallerySelIdx=savedSelIdx;
      }
      render();
      // Two rAFs: first lets the DOM paint, second lets virtual scroll measure
      requestAnimationFrame(()=>requestAnimationFrame(()=>scrollSelectionIntoView()));
    });
  });
  const vh=document.getElementById('view-host');
  if(vh)setupDropTarget(vh,state.currentPath);

  // ── Phase 4: Unlocked vault mounts in sidebar ────────────────────────────
  invoke('list_vaults').then(vaults => {
    const unlocked = vaults.filter(v => v.mounted);
    if (!unlocked.length) return;
    let vaultSection = Array.from(document.querySelectorAll('.sb-section'))
      .find(s => s.querySelector('.sb-title')?.textContent === 'Vaults');
    if (!vaultSection) {
      vaultSection = document.createElement('div');
      vaultSection.className = 'sb-section';
      vaultSection.innerHTML = '<div class="sb-title">Vaults</div>';
      document.getElementById('sidebar')?.appendChild(vaultSection);
    }
    unlocked.forEach(v => {
      const active = (window.state?.currentPath ?? '').startsWith(v.mount_point) ? ' active' : '';
      const item = document.createElement('div');
      item.className = `sb-item${active}`;
      item.dataset.path = v.mount_point;
      item.innerHTML = `<span class="sb-ico vault-lock-icon">🔓</span>
        <span class="sb-lbl">${escHtml(v.name)}</span>
        <button class="sb-rm-btn" data-vault-lock="${escHtml(v.id)}" title="Lock vault">🔒</button>`;
      vaultSection.appendChild(item);
      item.addEventListener('click', () => {
        if (!item.querySelector('[data-vault-lock]:hover')) navigate(v.mount_point, 0);
      });
      item.querySelector('[data-vault-lock]')?.addEventListener('click', async e => {
        e.stopPropagation();
        try {
          await invoke('lock_vault', { vaultId: v.id });
          showToast(t('toast.vault_locked',{name:v.name}),'info');
          renderSidebar();
        } catch (err) { showToast(String(err), 'error'); }
      });
    });
  }).catch(() => {});

  // ── Phase 3: rclone cloud provider mounts in sidebar ─────────────────────
  invoke('list_rclone_remotes').then(remotes => {
    if (!remotes || !remotes.length) return;
    const mounted = remotes.filter(r => r.mounted);
    if (!mounted.length) return;

    const providerIcons = { gdrive: '🔵', dropbox: '🟦', onedrive: '🪟' };
    const existingCloud = document.querySelector('.sb-section .sb-title');
    // Append to existing Cloud section if present, else create new one
    let cloudSection = Array.from(document.querySelectorAll('.sb-section'))
      .find(s => s.querySelector('.sb-title')?.textContent === 'Cloud');

    if (!cloudSection) {
      cloudSection = document.createElement('div');
      cloudSection.className = 'sb-section';
      cloudSection.innerHTML = '<div class="sb-title">Cloud</div>';
      document.getElementById('sidebar')?.appendChild(cloudSection);
    }

    mounted.forEach(r => {
      const icon = providerIcons[r.provider] ?? '☁';
      const active = (window.state?.currentPath ?? '').startsWith(r.mount_point) ? ' active' : '';
      const safeMp = (r.mount_point || '').replace(/"/g, '&quot;');
      const item = document.createElement('div');
      item.className = `sb-item${active}`;
      item.dataset.path = r.mount_point;
      item.innerHTML = `<span class="sb-ico">${icon}</span>
        <span class="sb-lbl">${escHtml(r.label)}</span>
        <button class="sb-rm-btn" data-cloud-provider-disconnect="${escHtml(r.id)}" title="Unmount">✕</button>`;
      cloudSection.appendChild(item);

      item.addEventListener('click', () => {
        if (!item.querySelector('[data-cloud-provider-disconnect]:hover')) navigate(r.mount_point, 0);
      });
      item.querySelector('[data-cloud-provider-disconnect]')?.addEventListener('click', async e => {
        e.stopPropagation();
        try {
          await invoke('unmount_cloud_provider', { remoteName: r.id });
          showToast(t('toast.disconnected'),'info');
          renderSidebar();
        } catch (err) { showToast(String(err), 'error'); }
      });
    });
  }).catch(() => {});



  // ── Preview panel resize handle ────────────────────────────────────────────
  _initPreviewResize();
}

function _initPreviewResize(){
  const panel=document.getElementById('preview-panel');
  if(!panel||panel._resizeBound) return;
  panel._resizeBound=true;
  // Insert a drag handle at the left edge of the preview panel
  const handle=document.createElement('div');
  handle.id='preview-resize-handle';
  handle.style.cssText='position:absolute;left:0;top:0;width:5px;height:100%;cursor:col-resize;z-index:10;';
  panel.style.position='relative';
  panel.insertBefore(handle,panel.firstChild);
  let dragging=false;
  const saved=localStorage.getItem('ff_preview_w');
  if(saved){document.documentElement.style.setProperty('--preview-w',saved+'px');}
  handle.addEventListener('mousedown',e=>{if(e.button!==0)return;dragging=true;document.body.style.cursor='col-resize';document.body.style.userSelect='none';});
  document.addEventListener('mousemove',e=>{
    if(!dragging)return;
    const content=document.querySelector('.content');
    if(!content)return;
    const r=content.getBoundingClientRect();
    const newW=Math.min(600,Math.max(160,r.right-e.clientX));
    document.documentElement.style.setProperty('--preview-w',newW+'px');
  });
  document.addEventListener('mouseup',()=>{
    if(!dragging)return;
    dragging=false;
    document.body.style.cursor='';document.body.style.userSelect='';
    const w=getComputedStyle(document.documentElement).getPropertyValue('--preview-w').trim();
    localStorage.setItem('ff_preview_w',parseInt(w)||280);
  });
  handle.addEventListener('dblclick',()=>{document.documentElement.style.setProperty('--preview-w','280px');localStorage.setItem('ff_preview_w',280);});
}

// ── Toast ─────────────────────────────────────────────────────────────────────
function _origShowToast(msg,type='info'){
  const t=document.createElement('div');t.className=`toast toast-${type}`;t.textContent=msg;
  document.getElementById('toast-container')?.appendChild(t);
  setTimeout(()=>t.classList.add('show'),10);
  setTimeout(()=>{t.classList.remove('show');setTimeout(()=>t.remove(),300);},3500);
}

// ── Window controls ───────────────────────────────────────────────────────────
async function setupWindowControls(){
  document.getElementById('wm-close')?.addEventListener('click',()=>invoke('window_close'));
  document.getElementById('wm-min')?.addEventListener('click',()=>invoke('window_minimize'));
  document.getElementById('wm-max')?.addEventListener('click',()=>invoke('window_maximize'));
  document.querySelector('.titlebar')?.addEventListener('mousedown',e=>{if(e.target.closest('.wm-btns'))return;appWindow.startDrag();});
  document.querySelector('.titlebar')?.addEventListener('dblclick',e=>{if(e.target.closest('.wm-btns'))return;invoke('window_maximize');});
}

// ── Keyboard ──────────────────────────────────────────────────────────────────
// ── Undo / Redo ───────────────────────────────────────────────────────────────
function pushUndo(op){ state._undoStack.push(op); if(state._undoStack.length>50)state._undoStack.shift(); state._redoStack=[]; }
async function undoLastOp(){
  const op=state._undoStack.pop(); if(!op){showToast(t('toast.nothing_to_undo'),'info');return;}
  state._redoStack.push(op);
  try{
    for(const item of [...op.items].reverse()){
      if(op.op==='move'){ await invoke('move_file',{src:item.dst,destDir:item.srcDir}); }
      else if(op.op==='copy'){ await invoke('delete_items',{paths:[item.dst]}); }
      else if(op.op==='delete'){
        const trashPaths = op.items.map(item => item.trashPath || item.src);
        const conflicts = await invoke('check_trash_restore_conflicts',{paths:trashPaths});
        const instructions = trashPaths.map(p => {
          const c = conflicts.find(x => x.trash_path===p);
          return {path:p, resolution: c ? 'rename' : 'restore'};
        });
        await invoke('trash_restore_with_resolution',{instructions});
      }
      else if(op.op==='rename'){ await invoke('rename_file',{oldPath:item.dst,newName:item.oldName}); }
      else if(op.op==='tags'){ await invoke('set_file_tags_v2',{path:item.path, tags:item.before}); }
      else if(op.op==='chmod'){ await invoke('chmod_entry',{path:item.path, mode:item.oldMode}); await invoke('chown_entry',{path:item.path, owner:item.oldOwner, group:item.oldGroup}); }
      else if(op.op==='batchRename'){ await invoke('rename_file',{oldPath:item.newPath, newName:item.oldName}); }
      else if(op.op==='create'){ await invoke('delete_items',{paths:[item.dst]}); }
    }
    showToast(t('toast.undone'),'success'); await refreshColumns();
  }catch(err){showToast(t('error.undo',{err}),'error','undo');}
}
async function redoLastOp(){
  const op=state._redoStack.pop(); if(!op){showToast(t('toast.nothing_to_redo'),'info');return;}
  state._undoStack.push(op);
  try{
    for(const item of op.items){
      if(op.op==='move'){ await invoke('move_file',{src:item.src,destDir:item.dstDir}); }
      else if(op.op==='copy'){ await invoke('copy_file',{src:item.src,destDir:item.dstDir}); }
      else if(op.op==='rename'){ await invoke('rename_file',{oldPath:item.src,newName:item.newName}); }
      else if(op.op==='delete'){
        const paths = op.items.map(item => item.src);
        await invoke('delete_items_stream',{paths, trash:true});
      }
      else if(op.op==='tags'){ await invoke('set_file_tags_v2',{path:item.path, tags:item.after}); }
      else if(op.op==='chmod'){ await invoke('chmod_entry',{path:item.path, mode:item.newMode}); await invoke('chown_entry',{path:item.path, owner:item.newOwner, group:item.newGroup}); }
      else if(op.op==='batchRename'){ await invoke('rename_file',{oldPath:item.oldPath, newName:item.newName}); }
      else if(op.op==='create'){ /* re-create not supported */ showToast(t('toast.cannot_redo_create'),'warning'); return; }
    }
    showToast(t('toast.redone'),'success'); await refreshColumns();
  }catch(err){showToast(t('error.redo',{err}),'error','redo');}
}


// ═══════════════════════════════════════════════════════════════════════════════
// Phase 7 — Keyboard shortcut customisation (r161-r175)
// ═══════════════════════════════════════════════════════════════════════════════

// r161: Keybinding table — canonical list of all remappable actions.
// keys: {ctrl?, shift?, alt?, key} where key is the exact e.key value.
// noInputBlock: true = fires even when an <input> is focused.
// guarded: true = cannot be remapped (system/browser-level).
const _KB_DEFAULTS = [
  // ── Navigation ──────────────────────────────────────────────────────────────
  { id:'go-back',         label:'Go back',                 category:'Navigation', keys:{key:'Backspace'} },
  { id:'omnibar',          label:'Go to path (omnibar)',     category:'Navigation', keys:{ctrl:true,key:'k'},            noInputBlock:true },
  { id:'open-recent',      label:'Open recent location',     category:'Navigation', keys:{ctrl:true,shift:true,key:'E'}, noInputBlock:true },
  { id:'breadcrumb-edit', label:'Edit path (breadcrumb)',  category:'Navigation', keys:{ctrl:true,key:'l'} },
  { id:'split-pane',      label:'Toggle split pane',       category:'Navigation', keys:{ctrl:true,key:'\\'} },
  { id:'compare-dirs',    label:'Compare directories',     category:'Navigation', keys:{ctrl:true,key:'d'} },
  // ── Files ───────────────────────────────────────────────────────────────────
  { id:'copy',            label:'Copy',                    category:'Files',      keys:{ctrl:true,key:'c'} },
  { id:'cut',             label:'Cut',                     category:'Files',      keys:{ctrl:true,key:'x'} },
  { id:'paste',           label:'Paste',                   category:'Files',      keys:{ctrl:true,key:'v'} },
  { id:'delete',          label:'Move to Trash',           category:'Files',      keys:{key:'Delete'} },
  { id:'select-all',      label:'Select all',              category:'Files',      keys:{ctrl:true,key:'a'} },
  { id:'quick-look',      label:'Quick Look',              category:'Files',      keys:{key:' '} },
  { id:'permissions',     label:'File permissions',        category:'Files',      keys:{ctrl:true,key:'i'} },
  { id:'refresh',         label:'Refresh',                 category:'Files',      keys:{key:'F5'} },
  // ── View ────────────────────────────────────────────────────────────────────
  { id:'new-tab',         label:'New tab',                 category:'View',       keys:{ctrl:true,key:'t'},         noInputBlock:true },
  { id:'close-tab',       label:'Close tab',               category:'View',       keys:{ctrl:true,key:'w'},         noInputBlock:true },
  { id:'search-focus',    label:'Search',                  category:'View',       keys:{ctrl:true,key:'f'},         noInputBlock:true },
  { id:'adv-search',      label:'Advanced search',         category:'View',       keys:{ctrl:true,shift:true,key:'F'}, noInputBlock:true },
  { id:'settings',        label:'Settings',                category:'View',       keys:{ctrl:true,key:','} },
  { id:'cheatsheet',      label:'Keyboard shortcuts',      category:'View',       keys:{ctrl:true,key:'/'},       noInputBlock:true },
  // ── Edit ────────────────────────────────────────────────────────────────────
  { id:'undo',            label:'Undo',                    category:'Edit',       keys:{ctrl:true,key:'z'} },
  { id:'redo',            label:'Redo',                    category:'Edit',       keys:{ctrl:true,key:'y'} },
  { id:'undo-panel',      label:'Undo history panel',      category:'Edit',       keys:{ctrl:true,shift:true,key:'Z'} },
  // ── App ─────────────────────────────────────────────────────────────────────
  { id:'plugin-manager',  label:'Plugin manager',          category:'App',        keys:{ctrl:true,shift:true,key:'P'}, noInputBlock:true },
  { id:'new-window',      label:'New window',              category:'App',        keys:{ctrl:true,key:'n'} },
  { id:'terminal',        label:'Open terminal here',      category:'App',        keys:{ctrl:true,alt:true,key:'t'} },
  { id:'disk-usage',      label:'Disk usage',              category:'App',        keys:{ctrl:true,shift:true,key:'U'} },
  { id:'show-errors',     label:'Error log',               category:'App',        keys:{ctrl:true,shift:true,key:'E'} },
  // ── Network ─────────────────────────────────────────────────────────────────
  { id:'sftp',            label:'Connect SFTP',            category:'Network',    keys:{ctrl:true,shift:true,key:'H'} },
  { id:'ftp',             label:'Connect FTP',             category:'Network',    keys:{ctrl:true,shift:true,key:'J'} },
  { id:'cloud',           label:'Cloud storage',           category:'Network',    keys:{ctrl:true,shift:true,key:'G'} },
  { id:'vault',           label:'Encrypted vaults',        category:'Network',    keys:{ctrl:true,shift:true,key:'V'} },
];

// r161: Merge user customisations from localStorage with defaults.
// Returns a map id → {keys, label, category, noInputBlock, guarded}
function _getKeybindings() {
  let overrides = {};
  try { overrides = JSON.parse(localStorage.getItem('ff_keybindings') || '{}'); } catch(_) {}
  const result = {};
  for (const def of _KB_DEFAULTS) {
    result[def.id] = { ...def, keys: overrides[def.id] || def.keys };
  }
  return result;
}

// Save a single binding override to localStorage
function _saveKeybinding(id, keys) {
  let overrides = {};
  try { overrides = JSON.parse(localStorage.getItem('ff_keybindings') || '{}'); } catch(_) {}
  overrides[id] = keys;
  localStorage.setItem('ff_keybindings', JSON.stringify(overrides));
}

// Reset a single binding to its default
function _resetKeybinding(id) {
  let overrides = {};
  try { overrides = JSON.parse(localStorage.getItem('ff_keybindings') || '{}'); } catch(_) {}
  delete overrides[id];
  localStorage.setItem('ff_keybindings', JSON.stringify(overrides));
}

// Reset all bindings
function _resetAllKeybindings() {
  localStorage.removeItem('ff_keybindings');
}

// r161: Check if a KeyboardEvent matches a keybinding descriptor
function _matchKey(e, keys) {
  if (keys.key !== e.key) return false;
  if (!!keys.ctrl !== (e.ctrlKey || e.metaKey)) return false;
  if (!!keys.shift !== !!e.shiftKey) return false;
  if (!!keys.alt !== !!e.altKey) return false;
  return true;
}

// r161: Pretty-print a keys descriptor → "Ctrl+Shift+F"
function _keysLabel(keys) {
  const parts = [];
  if (keys.ctrl)  parts.push('Ctrl');
  if (keys.alt)   parts.push('Alt');
  if (keys.shift) parts.push('Shift');
  const k = keys.key;
  // Pretty-print special keys
  const special = {' ':'Space','Backspace':'⌫','Delete':'Del',
    'ArrowUp':'↑','ArrowDown':'↓','ArrowLeft':'←','ArrowRight':'→',
    'Enter':'Enter','Escape':'Esc','\\':'\\', '?':'?', ',':','};
  parts.push(special[k] || k.toUpperCase());
  return parts.join('+');
}

// r163: Conflict detection — returns the binding that already uses these keys, or null
function _findConflict(keys, excludeId) {
  const bindings = _getKeybindings();
  for (const [id, b] of Object.entries(bindings)) {
    if (id === excludeId) continue;
    if (b.keys.key === keys.key &&
        !!b.keys.ctrl  === !!keys.ctrl &&
        !!b.keys.shift === !!keys.shift &&
        !!b.keys.alt   === !!keys.alt) return b;
  }
  return null;
}

// r163: Guard-railed combos that cannot be used (browser/OS reserved)
const _KB_GUARDED = new Set([
  'Ctrl+Tab', 'Ctrl+Shift+Tab', 'Ctrl+Q',
  'Ctrl+R',  // browser reload (only F5 for refresh)
]);

function _isGuardedCombo(keys) {
  return _KB_GUARDED.has(_keysLabel(keys));
}

function setupKeyboard(){
  document.addEventListener('keydown',async e=>{
    const tag=document.activeElement?.tagName?.toLowerCase();
    const isInput=tag==='input'||tag==='textarea'||document.activeElement?.contentEditable==='true';
    // r161: keybinding table dispatch for noInputBlock actions
    {
      const _kb = _getKeybindings();
      const _dispatched = await _dispatchKbAction(e, _kb, true, {state,sel,entries:null,getSelectedEntries,isInput});
      if(_dispatched) return;
    }
    if(e.key==='Escape'){
      if(document.getElementById('lightbox')){document.getElementById('lightbox')?.remove();return;}
      if(isQLOpen()){closeQuickLook();return;}
      if(state._bcEditMode){exitBcEditMode();return;}
      closeContextMenu();
      if(state.searchMode||state.search){state.search='';state.searchMode=false;state.searchResults=[];const si=document.getElementById('search-in');if(si)si.value='';sel.clear();render();}
      return;
    }
    if(isInput)return;
    const entries=getCurrentEntries();
    const curIdx=state.selIdx>=0?state.selIdx:(sel.last>=0?sel.last:-1);

    // ── Gallery: intercept ALL arrow keys before generic handler ────────────
    if((e.key==='ArrowLeft'||e.key==='ArrowRight'||e.key==='ArrowUp'||e.key==='ArrowDown')&&state.viewMode==='gallery'){
      e.preventDefault();
      const gE=getCurrentEntries();
      const cur=state.gallerySelIdx>=0?state.gallerySelIdx:0;
      const dir=(e.key==='ArrowRight'||e.key==='ArrowDown')?1:-1;
      const next=Math.min(Math.max(cur+dir,0),gE.length-1);
      if(next!==cur){
        state.gallerySelIdx=next;state.selIdx=next;
        const host=document.getElementById('view-host');if(host)await renderGalleryView(host);
        const ne=gE[next];
        if(isQLOpen()&&ne&&!ne.is_dir){
          openQuickLook(ne,gE,next,1);
          await loadPreview(ne);
        }else{await loadPreview(ne);}
        renderStatus();
      }
      return;
    }

    // ── Column view: intercept Left/Right before generic handler ──────────
    if(state.viewMode==='column'&&(e.key==='ArrowRight'||e.key==='ArrowLeft')){
      e.preventDefault();
      if(e.key==='ArrowRight'){
        // Right arrow: navigate INTO selected folder → opens next column to the right
        const last=state.columns[state.columns.length-1];
        if(last&&last.selIdx>=0){
          const vis=sortEntries(last.entries.filter(x=>state.showHidden||!x.is_hidden));
          const en=vis[last.selIdx];
          if(en?.is_dir){
            // Trail fix: clear sel._paths BEFORE navigate so all streaming renders
            // inside navigate() see isSel=false → isTrail=true immediately.
            // Same fix as the click handler (r19). Without this, keyboard-nav into
            // a folder still shows the bright .sel highlight during streaming instead
            // of the correct muted .trail highlight.
            sel._paths.delete(en.path);
            state.selIdx=-1;
            await navigateDebounced(en.path,state.columns.length,false);
          }
        }
      } else {
        // Left arrow: go back to parent column, restoring its selection
        if(state.columns.length>1){
          state.columns.pop();
          const parent=state.columns[state.columns.length-1];
          // CRITICAL: update currentPath so getVisibleEntries() can find this column's entries
          state.currentPath=parent.path;
          if(parent.selIdx>=0){
            state.selIdx=parent.selIdx;
            sel._e=sortEntries(parent.entries.filter(x=>state.showHidden||!x.is_hidden));
            sel.set(parent.selIdx);
          }
          render();
          // Scroll the restored selection into view
          requestAnimationFrame(()=>{
            document.querySelector('.frow.sel')?.scrollIntoView({block:'nearest'});
          });
          // Update QL with the restored parent selection (Left arrow should follow QL like all other views)
          if(isQLOpen()&&parent.selIdx>=0){
            const parentEntries=getCurrentEntries();
            const ne=parentEntries[parent.selIdx];
            if(ne&&!ne.is_dir){ openQuickLook(ne,parentEntries,parent.selIdx,1); await loadPreview(ne); }
          }
        }
      }
      return;
    }

    if(e.key==='ArrowDown'||e.key==='ArrowUp'||e.key==='ArrowLeft'||e.key==='ArrowRight'){
      e.preventDefault();
      let next=curIdx<0?0:curIdx;

      if(state.viewMode==='icon'){
        // Grid navigation using live column count
        const cols=state._iconCols||1;
        if(e.key==='ArrowRight') next=Math.min(curIdx+1,entries.length-1);
        else if(e.key==='ArrowLeft') next=Math.max(curIdx-1,0);
        else if(e.key==='ArrowDown') next=Math.min(curIdx+cols,entries.length-1);
        else if(e.key==='ArrowUp') next=Math.max(curIdx-cols,0);
      } else {
        if(e.key==='ArrowDown') next=Math.min(curIdx+1,entries.length-1);
        else if(e.key==='ArrowUp') next=Math.max(curIdx-1,0);
        else next=curIdx; // Left/Right handled below for column/gallery
      }

      if(e.shiftKey){sel.range(sel.last>=0?sel.last:next,next);}else{sel.set(next);}
      state.selIdx=next;
      if(state.viewMode==='column'){const last=state.columns[state.columns.length-1];if(last)last.selIdx=next;}
      const _sc={};document.querySelectorAll('.col-list').forEach((c,i)=>_sc[i]=c.scrollTop);
      const _lvs=document.querySelector('.list-wrap')?.scrollTop||0;
      render();
      requestAnimationFrame(()=>{
        // Restore other columns' scroll positions first
        document.querySelectorAll('.col-list').forEach((c,i)=>{if(_sc[i]!=null)c.scrollTop=_sc[i];});
        const lv2=document.querySelector('.list-wrap');if(lv2)lv2.scrollTop=_lvs;
        // Then scroll the newly selected item into view (overrides the col-list restore
        // only for the col-list that contains the selected row — other cols unaffected)
        const selRow=document.querySelector('.frow.sel,.list-row.sel,.icon-item.sel');
        if(selRow)selRow.scrollIntoView({block:'nearest',behavior:'smooth'});
      });
      const ne=entries[next];
      if(isQLOpen()&&ne&&!ne.is_dir){
        openQuickLook(ne, entries, next, state.viewMode==='icon'?(state._iconCols||1):1);
        await loadPreview(ne); // keep preview panel in sync with QL
      }else{await loadPreview(ne);}
      return;
    }
    // column Left/Right handled before generic block
    if(e.key==='Enter'){e.preventDefault();const entry=curIdx>=0?entries[curIdx]:null;if(entry){if(e.ctrlKey||e.metaKey){if(entry.is_dir)newTab(entry.path);}else if(entry.is_dir)await navigate(entry.path,0);else invoke('open_file',{path:entry.path}).catch(()=>{});}return;}
    if(e.key===' '){
      e.preventDefault();
      const ql=isQLOpen();
      FF.log('SPACE_PRESS',{qlOpen:ql,curIdx,entryName:entries[curIdx]?.name,entryIsDir:entries[curIdx]?.is_dir,entriesLen:entries.length,selIdx:state.selIdx});
      if(ql){closeQuickLook();return;}  // toggle off
      const entry=curIdx>=0?entries[curIdx]:null;
      if(entry&&!entry.is_dir){
        openQuickLook(entry, entries, curIdx, state.viewMode==='icon'?(state._iconCols||1):1);
        await loadPreview(entry); // show same file in preview panel
      }
      return;
    }
    // r161: table-driven dispatch for all named actions
    {
      const _kb = _getKeybindings();
      const _dispatched = await _dispatchKbAction(e, _kb, false, {state,sel,entries,getSelectedEntries,isInput});
      if(_dispatched) return;
    }
    // ── r40-r42 shortcuts (not in keybinding table — depend on dualPaneEnabled state) ─
    if(e.key==='F3'){e.preventDefault();toggleDualPane();return;}
    if(e.key==='F5'&&dualPaneEnabled){e.preventDefault();crossPaneCopy();return;}
    if(e.key==='F6'&&dualPaneEnabled){e.preventDefault();crossPaneMove();return;}
    if(dualPaneEnabled&&e.key==='Tab'&&!isInput){e.preventDefault();focusPane(activePane===0?1:0);return;}
  // ── Type-to-select ────────────────────────────────────────────────────────
  // A single printable character (no modifier) jumps to the first entry whose
  // name starts with the typed string. A 600ms idle resets the buffer so the
  // user can type a multi-character prefix (e.g. "pro" to land on "Projects").
  if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){
    clearTimeout(state._ttsTimer);
    state._ttsBuf=(state._ttsBuf||'')+e.key.toLowerCase();
    state._ttsTimer=setTimeout(()=>{state._ttsBuf='';},600);
    const buf=state._ttsBuf;
    const all=getCurrentEntries();
    let idx=all.findIndex(en=>en.name.toLowerCase().startsWith(buf));
    if(idx<0&&buf.length>1){
      // Full prefix failed — fall back to first-char match so a typo doesn't get stuck
      idx=all.findIndex(en=>en.name.toLowerCase().startsWith(buf[0]));
    }
    if(idx>=0){
      sel.set(idx);state.selIdx=idx;
      if(state.viewMode==='column'){const last=state.columns[state.columns.length-1];if(last)last.selIdx=idx;}
      render();
      requestAnimationFrame(()=>{
        document.querySelector('.frow.sel,.list-row.sel,.icon-item.sel')
          ?.scrollIntoView({block:'nearest',behavior:'smooth'});
      });
      await loadPreview(all[idx]);
    }
    return;
  }
  });
}

// r161: Action dispatch for keybinding table — called from setupKeyboard.
// noInputOnly=true → only fires noInputBlock:true bindings (early in handler).
// noInputOnly=false → fires all other bindings (after isInput guard).
async function _dispatchKbAction(e, kb, noInputOnly, ctx) {
  const { state, sel, entries, getSelectedEntries, isInput } = ctx;
  for (const [id, binding] of Object.entries(kb)) {
    if (!_matchKey(e, binding.keys)) continue;
    if (noInputOnly && !binding.noInputBlock) continue;
    if (!noInputOnly && binding.noInputBlock) continue;
    e.preventDefault();
    switch(id) {
      // ── noInputBlock actions ────────────────────────────────────────────────
      case 'new-tab':        newTab(e.shiftKey?'':state.currentPath); break;
      case 'close-tab':      closeTab(activeTabId); break;
      case 'search-focus':   document.getElementById('search-in')?.focus(); break;
      case 'adv-search':     _showAdvancedSearch(); break;
      case 'plugin-manager': _showPluginManager(); break;
      // ── Standard actions ────────────────────────────────────────────────────
      case 'go-back':
        if(state.historyIdx>0){state.historyIdx--;state.columns=[];await navigate(state.history[state.historyIdx],0,false);}
        break;
      case 'refresh':        await refreshCurrent(); break;
      case 'delete':         { const es=getSelectedEntries(); if(es.length) deleteEntries(es); break; }
      case 'copy':           clipboardCopy(getSelectedEntries()); break;
      case 'cut':            clipboardCut(getSelectedEntries()); break;
      case 'paste':          await clipboardPaste(); break;
      case 'undo':           await undoLastOp(); break;
      case 'redo':           await redoLastOp(); break;
      case 'select-all':
        sel._paths.clear(); entries.forEach(en=>sel._paths.add(en.path));
        sel.last=entries.length-1; state.selIdx=entries.length-1; render(); break;
      case 'cheatsheet':     showCheatSheet(); break;
      case 'omnibar':        _showOmnibar(); break;
      case 'open-recent':    _showOpenRecent(); break;
      case 'settings':       _showSettings(); break;
      case 'split-pane':     _toggleSplitPane(); break;
      case 'breadcrumb-edit':enterBcEditMode(); break;
      case 'quick-look': {
        const ql=isQLOpen();
        if(ql){closeQuickLook();}
        else{const en=entries[state.selIdx>=0?state.selIdx:0];if(en&&!en.is_dir){openQuickLook(en,entries,state.selIdx>=0?state.selIdx:0,1);await loadPreview(en);}}
        break;
      }
      case 'compare-dirs': {
        const _dirs=getSelectedEntries().filter(en=>en.is_dir);
        if(_dirs.length===2){ _showDirDiff(_dirs[0].path,_dirs[1].path); }
        else if(_paneB.active&&_paneB.path&&state.currentPath&&_paneB.path!==state.currentPath){
          _showDirDiff(state.currentPath,_paneB.path);
        } else { showToast(t('toast.select_split_pane'),'info'); }
        break;
      }
      case 'undo-panel':     toggleUndoPanel(); break;
      case 'new-window':     openNewWindow(state.currentPath); break;
      case 'permissions':    showPermissionsDialog(getSelectedEntries()[0]); break;
      case 'terminal':       invoke('open_terminal',{path:state.currentPath}).catch(err=>showToast(t('error.terminal',{err}),'error')); break;
      case 'disk-usage':     showDiskUsage(); break;
      case 'show-errors':    FF.showErrors?.(); break;
      case 'sftp':           showSftpDialog(); break;
      case 'ftp':            showFtpDialog(); break;
      case 'cloud':          showCloudDialog(); break;
      case 'vault':          showVaultDialog(); break;
      default: continue; // unrecognised id — keep looping
    }
    return true; // action fired
  }
  return false;
}

// ── p8: Ctrl+K omnibar ──────────────────────────────────────────────────────────────────────────
function _showOmnibar() {
  document.getElementById('ff-omnibar')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'ff-omnibar';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9800;display:flex;align-items:flex-start;justify-content:center;padding-top:18vh;background:rgba(0,0,0,.55);backdrop-filter:blur(6px);';
  overlay.innerHTML = `
    <div style="width:min(580px,90vw);background:#1c1e24;border:1px solid rgba(255,255,255,.14);border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,.8);overflow:hidden;">
      <div style="display:flex;align-items:center;gap:10px;padding:13px 16px;border-bottom:1px solid rgba(255,255,255,.07);">
        <svg width="16" height="16" fill="none" stroke="#636368" stroke-width="2" viewBox="0 0 24 24"><path d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z"/></svg>
        <input id="ff-omnibar-input" placeholder="Go to path or recent location…" autocomplete="off" spellcheck="false"
          style="flex:1;background:none;border:none;outline:none;color:#f1f5f9;font-size:14px;font-family:inherit;caret-color:#5b8dd9;">
        <kbd style="font-size:10px;color:#4a5568;background:#111;border:1px solid #2d2d2d;border-radius:4px;padding:2px 6px;">Esc</kbd>
      </div>
      <div id="ff-omnibar-results" style="max-height:340px;overflow-y:auto;padding:4px 0;"></div>
    </div>`;
  document.body.appendChild(overlay);
  const input = overlay.querySelector('#ff-omnibar-input');
  const resultsEl = overlay.querySelector('#ff-omnibar-results');
  let _selIdx = -1, _items = [];
  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
  function _render(items) {
    _items = items; _selIdx = items.length ? 0 : -1;
    resultsEl.innerHTML = items.slice(0,12).map((item,i) =>
      `<div class="ff-omni-row${i===0?' omni-sel':''}" data-idx="${i}"
        style="display:flex;align-items:center;gap:10px;padding:9px 16px;cursor:pointer;font-size:13px;background:${i===0?'rgba(91,141,217,.15)':''};">
        <svg width="14" height="14" fill="none" stroke="${item.is_dir?'#5b8dd9':'#636368'}" stroke-width="2" viewBox="0 0 24 24">
          ${item.is_dir?'<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>':'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>'}
        </svg>
        <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${item.is_dir?'#d1d5db':'#9ca3af'}">${escHtml(item.path)}</span>
        <span style="font-size:10px;color:#374151;flex-shrink:0">${item.source||''}</span>
      </div>`
    ).join('');
    resultsEl.querySelectorAll('.ff-omni-row').forEach(row => {
      row.addEventListener('mouseenter', () => _highlight(+row.dataset.idx));
      row.addEventListener('click', () => _go(_items[+row.dataset.idx]));
    });
  }
  function _highlight(idx) {
    _selIdx = idx;
    resultsEl.querySelectorAll('.ff-omni-row').forEach((r,i) => { r.style.background = i===idx?'rgba(91,141,217,.15)':''; });
  }
  function _go(item) { if(!item) return; close(); navigate(item.path, 0); }
  input.addEventListener('keydown', e => {
    if (e.key==='ArrowDown') { e.preventDefault(); _highlight(Math.min(_selIdx+1,_items.length-1)); }
    else if (e.key==='ArrowUp') { e.preventDefault(); _highlight(Math.max(_selIdx-1,0)); }
    else if (e.key==='Enter') { e.preventDefault(); _go(_items[_selIdx]); }
    else if (e.key==='Tab') { e.preventDefault();
      const item=_items[_selIdx]; if(item?.is_dir){input.value=item.path+'/';input.dispatchEvent(new Event('input'));} }
  });
  let _debounce=null;
  input.addEventListener('input', () => {
    clearTimeout(_debounce);
    _debounce = setTimeout(async () => {
      const q = input.value.trim();
      const recent = _getPathHistory().filter(p=>!q||p.toLowerCase().includes(q.toLowerCase()))
        .slice(0,5).map(p=>({path:p,is_dir:true,source:'recent'}));
      if (!q) { _render(recent); return; }
      try {
        const indexed = await invoke('search_index_query',{query:q,maxResults:20});
        const dirs = indexed.filter(r=>r.is_dir).slice(0,8).map(r=>({path:r.path,is_dir:true,source:'index'}));
        const seen = new Set(recent.map(r=>r.path));
        _render([...recent,...dirs.filter(d=>!seen.has(d.path))]);
      } catch { _render(recent); }
    }, 120);
  });
  setTimeout(()=>{input.focus();input.dispatchEvent(new Event('input'));},30);
}

// ── p8: Ctrl+Shift+E Open Recent ────────────────────────────────────────────────────────────────────────────
function _showOpenRecent() {
  document.getElementById('ff-open-recent')?.remove();
  const recent = _getPathHistory().slice(0,15);
  if (!recent.length) { showToast('No recent locations','info'); return; }
  const overlay = document.createElement('div');
  overlay.id = 'ff-open-recent';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9700;display:flex;align-items:flex-start;justify-content:center;padding-top:14vh;background:rgba(0,0,0,.45);backdrop-filter:blur(4px);';
  overlay.innerHTML = `
    <div style="width:min(480px,88vw);background:#1c1e24;border:1px solid rgba(255,255,255,.13);border-radius:12px;box-shadow:0 20px 56px rgba(0,0,0,.75);overflow:hidden;">
      <div style="padding:11px 16px;border-bottom:1px solid rgba(255,255,255,.07);font-size:11px;color:#636368;text-transform:uppercase;letter-spacing:.07em;display:flex;justify-content:space-between;align-items:center;">
        <span>Recent Locations</span><kbd style="font-size:10px;color:#4a5568;background:#111;border:1px solid #2d2d2d;border-radius:4px;padding:2px 6px;">Esc</kbd>
      </div>
      ${recent.map((p,i) => {
        const name = p.split('/').filter(Boolean).pop()||p;
        return `<div class="ff-recent-row" data-path="${escHtml(p)}" style="display:flex;align-items:center;gap:10px;padding:9px 16px;cursor:pointer;font-size:13px;${i===0?'background:rgba(91,141,217,.1);':''}">
          <svg width="14" height="14" fill="none" stroke="#5b8dd9" stroke-width="2" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg>
          <div style="flex:1;min-width:0;">
            <div style="color:#d1d5db;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(name)}</div>
            <div style="font-size:10px;color:#374151;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(p)}</div>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target===overlay) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key==='Escape'){close();document.removeEventListener('keydown',esc);}
  });
  overlay.querySelectorAll('.ff-recent-row').forEach(row => {
    row.addEventListener('mouseenter', ()=>row.style.background='rgba(91,141,217,.15)');
    row.addEventListener('mouseleave', ()=>row.style.background='');
    row.addEventListener('click', ()=>{close();navigate(row.dataset.path,0);});
  });
}

// ─────────────────────────────────────────────────────────────
function renderTrashBanner(){
  const banner=document.getElementById('trash-banner');
  if(!banner)return;
  // Show banner for any path under the Trash tree
  const trashRoot=(state.currentPath||'').includes('/.local/share/Trash');
  if(!trashRoot){banner.style.display='none';return;}
  banner.style.display='flex';
  invoke('trash_item_count').then(n=>{
    announceA11y(n === 0 ? 'Trash is empty' : `Trash contains ${n} item${n !== 1 ? 's' : ''}`);
    banner.innerHTML=
      '<span class="trash-banner-msg">Trash contains '+n+' item'+(n!==1?'s':'')+' — permanently deleted when emptied.</span>'+
      '<div style="display:flex;gap:6px">'+
      '<button class="trash-banner-btn trash-banner-btn-sec" id="btn-restore-trash">Restore selected</button>'+
      '<button class="trash-banner-btn" id="btn-empty-trash">Empty Trash</button>'+
      '</div>';
    document.getElementById('btn-empty-trash')?.addEventListener('click',()=>{
      if(!confirm('Permanently delete all items in Trash? This cannot be undone.'))return;
      _emptyTrashWithProgress().catch(err=>showToast(t('toast.trash_empty_failed',{err}),'error'));
    });
    document.getElementById('btn-restore-trash')?.addEventListener('click',async()=>{
      const selected = getSelectedEntries();
      if(!selected.length){showToast(t('toast.select_items_to_restore'),'info');return;}
      // Map display paths to trash paths via trash_list
      try{
        const trashItems = await invoke('trash_list');
        const toRestore = selected.map(e=>{
          const ti = trashItems.find(t=>t.name===e.name||t.trash_path===e.path||t.original_path===e.path);
          return ti?.trash_path||e.path;
        }).filter(Boolean);
        if(!toRestore.length){showToast(t('toast.trash_entries_missing'),'error');return;}
        const conflicts = await invoke('check_trash_restore_conflicts',{paths:toRestore});
        const instructions = toRestore.map(p=>{
          const conflict = conflicts.find(c=>c.trash_path===p);
          return {path:p, resolution: conflict?'rename':'restore'};
        });
        await invoke('trash_restore_with_resolution',{instructions});
        showToast(t('toast.restored',{n:toRestore.length}),'success');
        await refreshColumns();
      }catch(err){showToast(t('error.restore',{err}),'error','restore');}
    });
  }).catch(()=>{
    banner.innerHTML=
      '<span class="trash-banner-msg">Items in Trash will be permanently deleted when Trash is emptied.</span>'+
      '<button class="trash-banner-btn" id="btn-empty-trash">Empty Trash</button>';
    document.getElementById('btn-empty-trash')?.addEventListener('click',()=>{
      if(!confirm('Permanently delete all items in Trash? This cannot be undone.'))return;
      _emptyTrashWithProgress().catch(err=>showToast(t('toast.trash_empty_failed',{err}),'error'));
    });
  });
}

function _doRender(){
  // Preserve icon-view scroll position across renders (clicking a file rebuilds host.innerHTML)
  if(state.viewMode==='icon'){
    const ivWrap=document.getElementById('iv-wrap');
    if(ivWrap&&ivWrap.scrollTop>0)state._iconScroll={path:state.currentPath,top:ivWrap.scrollTop};
  }
  // Invalidate incremental caches when changing directory
  {
    const host=document.getElementById('view-host');
    if(host){
      if(host._ivMeta&&host._ivMeta.path!==state.currentPath) host._ivMeta=null;
      if(host._galleryMeta&&host._galleryMeta.path!==state.currentPath) host._galleryMeta=null;
    }
  }
  FF.log('RENDER',{view:state.viewMode,cols:state.columns.length,loading:state.loading,path:state.currentPath?.split('/').pop()||'/'});
  syncState();renderTabs();renderTrashBanner();
  // Don't rebuild toolbar while user is typing in search — would steal focus
  const si=document.getElementById('search-in');
  const searchFocused=document.activeElement===si;
  if(!searchFocused)renderToolbar();
  renderView();renderPreview();renderStatus();
}
function render(){ scheduleRender(); }

// ── Boot ──────────────────────────────────────────────────────────────────────
// Wire up view injection
injectDeps({
  state,sel,sortEntries,sortState,getVisibleEntries,getCurrentEntries,
  setupDragDrop,setupDropTarget,startRename,
  showContextMenu,buildFileCtxMenu,buildBgCtxMenu,
  loadPreview,handleEntryClick,getMediaUrl,getTranscodeUrl,getHeicJpegUrl,navigate,navigateDebounced,render,showToast,refreshTagColors,doGlobalSearch,newTab,
  pushUndo,
  gitBadgeHtml, gitBranchHtml, getGitStatus: () => _gitStatus,
});
setRenderCallback(()=>{ render(); renderSidebar(); });

function setupSearch(){
  // Use event delegation on #toolbar so listeners survive renderToolbar() rebuilds
  const toolbar = document.getElementById('toolbar');
  if(!toolbar) return;
  toolbar.addEventListener('click', e=>{
    if(e.target.id !== 'search-clear') return;
    clearTimeout(searchDebounce); _searchGen++;
    state.search='';state.searchMode=false;state.searchResults=[];sel.clear();
    const si=document.getElementById('search-in');
    if(si){si.value='';si.focus();}
    render();
  });
  toolbar.addEventListener('input', e=>{
    if(e.target.id !== 'search-in') return;
    const q = e.target.value;
    clearTimeout(searchDebounce);
    if(!q.trim()){
      _searchGen++;
      state.search='';state.searchMode=false;state.searchResults=[];sel.clear();
      render(); return;
    }
    state.search=q;
    _updateSearchLabel(q, true);
    searchDebounce=setTimeout(()=>doGlobalSearch(q), 350);
  });
  toolbar.addEventListener('keydown', e=>{
    if(e.target.id !== 'search-in') return;
    if(e.key==='Enter' && e.target.value.trim()){
      clearTimeout(searchDebounce); doGlobalSearch(e.target.value);
    }
    if(e.key==='Escape'){
      clearTimeout(searchDebounce); _searchGen++;
      state.search='';state.searchMode=false;state.searchResults=[];sel.clear();
      e.target.value=''; render();
    }
  });
}

function setupSidebarResize(){
  const handle=document.getElementById('sb-resize');
  const sidebar=document.getElementById('sidebar');
  if(!handle||!sidebar)return;
  // Restore saved width
  const saved=localStorage.getItem('ff_sb_w');
  if(saved){
    const w=parseInt(saved);
    if(w>=120&&w<=400){
      document.documentElement.style.setProperty('--sidebar-w',w+'px');
      sidebar.style.width=w+'px';
    }
  }
  handle.addEventListener('mousedown',e=>{
    e.preventDefault();
    handle.classList.add('dragging');
    document.body.style.cursor='col-resize';
    document.body.style.userSelect='none';
    const startX=e.clientX;
    const startW=sidebar.getBoundingClientRect().width;
    const onMove=ev=>{
      const w=Math.max(120,Math.min(400,startW+(ev.clientX-startX)));
      sidebar.style.width=w+'px';
      document.documentElement.style.setProperty('--sidebar-w',w+'px');
    };
    const onUp=()=>{
      handle.classList.remove('dragging');
      document.body.style.cursor='';
      document.body.style.userSelect='';
      localStorage.setItem('ff_sb_w',Math.round(sidebar.getBoundingClientRect().width));
      document.removeEventListener('mousemove',onMove);
      document.removeEventListener('mouseup',onUp);
    };
    document.addEventListener('mousemove',onMove);
    document.addEventListener('mouseup',onUp);
  });
}

async function init(){
  appWindow = _getAppWindow(); // must be called after Tauri context is ready
  // Re-inject deps now that appWindow is initialised (first injectDeps call at
  // module level ran before Tauri context was ready, so appWindow was undefined)
  injectDeps({ appWindow,
    state,sel,sortEntries,sortState,getVisibleEntries,getCurrentEntries,
    setupDragDrop,setupDropTarget,startRename,
    showContextMenu,buildFileCtxMenu,buildBgCtxMenu,
    loadPreview,handleEntryClick,getMediaUrl,getTranscodeUrl,getHeicJpegUrl,navigate,navigateDebounced,render,showToast,refreshTagColors,doGlobalSearch,newTab,
  });
  window._state = state; // expose for FF logger
  invoke('get_platform').then(p => { state._platform = p; }).catch(() => {});
  invoke('check_optional_deps').then(deps => { state._deps = deps; }).catch(() => {});
  await initMediaPort();
  // Run thumbnail GC after 8s — evicts cache entries older than 30 days.
  // Fire-and-forget so it never blocks startup.
  setTimeout(()=>invoke('gc_thumbnail_cache').then(n=>{if(n>0)console.log('[FF] GC: removed',n,'stale thumbnails');}).catch(()=>{}), 8000);
  // Background tag DB sweep — runs 15s after startup, silently removes orphaned rows.
  // Uses cleanup_tag_db which deletes rows for files that no longer exist.
  setTimeout(async () => {
    try {
      const removed = await invoke('cleanup_tag_db');
      if (removed > 0) {
        FF.log('TAG_DB_GC', { removed });
        logError(`Tag DB sweep: removed ${removed} orphaned row${removed === 1 ? '' : 's'}`, 'startup');
      }
    } catch (e) { /* non-fatal */ }
  }, 15000);

  // Restore cloud provider (rclone) mounts from the previous session silently.
  // Fire-and-forget — a missing rclone or offline provider should never block startup.
  invoke('restore_cloud_mounts').then(mounted => {
    if (mounted && mounted.length) {
      renderSidebar();
    }
  }).catch(() => {});

  // Pre-warm QL window in the background while sidebar/files load.
  // initQuickLook() creates a hidden WebviewWindow so the WebKit process is
  // already running when the user first presses Space — eliminates cold-start lag.
  initQuickLook().catch(()=>{});
  await loadSidebar();
  const home=await invoke('get_home_dir');
  state.currentPath=home;state.activeSb=home;
  getActiveTab().state.currentPath=home;
  // r83: apply ff_show_hidden before the first render so hidden files are
  // shown/hidden on startup according to the user's saved preference.
  state.showHidden = localStorage.getItem('ff_show_hidden') === '1';
  getActiveTab().state.showHidden = state.showHidden;

  // r89-r92: attempt session restore; fall back to home if no session saved
  // r21: skip session restore in new windows — they have their own __initialPath
  //      and must not inherit the main window's tab set via shared localStorage.
  const _isNewWindow = !!window.__initialPath;
  const _sessionRestored = _isNewWindow ? false : await restoreSession(home);
  if(!_sessionRestored && !_isNewWindow){
    await navigate(home,0,true);
  }
  renderSidebar();renderTabs();
  setupKeyboard();
  setupSearch();
  setupSidebarResize();
  setupBreadcrumbRail();

  // ── r42 boot: window initial path support ─────────────────────────────────
  if (window.__initialPath && window.__initialPath !== home) {
    state.currentPath = window.__initialPath;
    getActiveTab().state.currentPath = window.__initialPath;
    await navigate(window.__initialPath, 0, true);
    renderSidebar(); renderTabs();
  }
    await setupWindowControls();
  applyScale();
  setInterval(pollDrives,30000); // Fallback polling — Tauri 'drives-changed' event handles real-time hot-plug
  // ── Tauri event: instant USB hot-plug detection ───────────────────────────
  try{
    listen('drives-changed', ({payload:drives})=>{
      const prev=state.sidebarData.drives||[];
      if(JSON.stringify(drives)!==JSON.stringify(prev)){
        const usbPrev=prev.filter(d=>d.drive_type==='usb').length;
        const usbNew=drives.filter(d=>d.drive_type==='usb').length;
        state.sidebarData.drives=drives;
        renderSidebar();
        if(usbNew>usbPrev)showToast(t('toast.usb_connected'),'success');
        else if(usbNew<usbPrev)showToast(t('toast.usb_removed'),'info');
      }
    });
    // ── Tauri event: real filesystem change detection (inotify via notify crate) ─
    // Rust watches the current directory with inotify/kqueue and emits 'dir-changed'
    // (debounced 300ms) when any create/modify/delete/rename happens. No mtime
    // polling — zero spurious renders on navigate.
    // -- Single-file delete progress (from delete_file command) ----
    listen('delete-progress', ({payload})=>{
      const {name,done,total,finished,error}=payload;
      if(done===0&&!finished) _sbProgress.start('Moving to Trash...', total);
      else if(finished)       _sbProgress.finish(true, 'Moved to Trash');
      else if(error)          _sbProgress.error('Failed: '+name+': '+error);
      else                    _sbProgress.update(done, total, 'Moving '+name);
    });
    // JS-side per-path debounce map for dir-changed events.
    // The Rust watcher has a 300ms debounce, but a busy home dir (~/.bash_history,
    // ~/.cache writes) can still emit multiple events per second for separate files.
    // Without this, rapid-fire refreshColumns() calls remove+repaint rows every ~67ms,
    // swallowing click events that land mid-repaint and breaking column view navigation.
    const _dirChangedTimers = new Map();
    listen('dir-changed', ({payload:changedPath})=>{
      // Drop watcher events while navigate() is in progress — its finally block
      // calls watch_dir + render() anyway, so a concurrent watcher refresh is redundant.
      if(state.loading) return;
      // Coalesce rapid bursts for the same path into a single refresh (150ms window).
      if(_dirChangedTimers.has(changedPath)) clearTimeout(_dirChangedTimers.get(changedPath));
      _dirChangedTimers.set(changedPath, setTimeout(()=>{
        _dirChangedTimers.delete(changedPath);
        if(state.loading) return; // re-check after delay
        if(state.viewMode==='column'){
          // Column view: only refresh the affected column
          const isOpenColumn = state.columns.some(col => col.path === changedPath);
          if(isOpenColumn){
            _jsCacheEvict(changedPath);
            refreshColumns(changedPath);
          }
        } else {
          // List / icon / gallery: the single directory displayed is state.currentPath
          if(changedPath===state.currentPath){
            refreshCurrent();
          }
        }
      }, 150));
    });
    // ── Tauri event: Quick Look navigation from QL window ────────────────────────
    // When user presses arrow keys in QL window, it emits 'ql-nav' with the new index.
    // This syncs the main window's selection to match.
    listen('ql-nav', ({payload}) => {
      const { idx } = payload;
      const entries = getVisibleEntries();
      if (entries && idx >= 0 && idx < entries.length) {
        const entry = entries[idx];
        if (entry && !entry.is_dir) {
          sel.set(idx);
          state.selIdx = idx;
          if (state.viewMode === 'column') {
            const last = state.columns[state.columns.length - 1];
            if (last) last.selIdx = idx;
          }
          render();
          loadPreview(entry);
        }
      }
    });

    // ── QL editor: file saved event — push undo entry ────────────────────────────
    // When the inline text editor saves, it emits ql-file-saved so the main window
    // can push an undo entry, allowing Ctrl+Z to revert the edit.
    listen('ql-file-saved', async ({payload}) => {
      const { path } = payload;
      try {
        const before = await invoke('read_text_file', { path });
        // We only have the new content (just written), so store the pre-save snapshot
        // that read_text_file returns — this is the current disk state after save.
        // On undo we'd need the previous snapshot; for now we push an info entry
        // so the undo history panel shows the save happened.
        pushUndo({ op: 'editFile', src: path, oldContent: null, newContent: null,
                   label: `Edit ${path.split('/').pop()}` });
      } catch (_) {}
    }).catch(() => {});

    // ── Tauri event: file drag & drop from external apps ──────────────────────────
    // When files are dropped onto the FrostFinder window, Tauri v2 intercepts them
    // and emits 'tauri://drag-drop' event with the file paths.
    listen('tauri://drag-drop', async (event) => {
      const { paths, position } = event.payload;
      if (!paths || paths.length === 0) return;
      window.FF?.log('TAURI_DROP', { paths, position });

      // Clean up any lingering drop-over highlights immediately on drop
      document.querySelectorAll('.drop-over').forEach(el => el.classList.remove('drop-over'));

      // Resolve drop target from the pointer position Tauri provides.
      // Priority: directory frow (data-dir="true") > column strip (data-col-path) > currentPath
      const el = document.elementFromPoint(position.x, position.y);
      const frow = el?.closest('.frow');
      const colEl = el?.closest('.col');

      let destPath = state.currentPath;
      // Priority: directory frow > column path > currentPath
      if (frow?.dataset.dir === 'true' && frow.dataset.path) {
        destPath = frow.dataset.path;
      } else if (colEl?.dataset.colPath) {
        destPath = colEl.dataset.colPath;
      }

      if (dragState.entries.length > 0) {
        // ── Internal FrostFinder drag (column→column, column→folder, etc.) ───────
        // Tauri v2 intercepts ALL drops and fires tauri://drag-drop, which means the
        // HTML5 `drop` event in setupDropTarget NEVER fires for internal drags.
        // We must handle the drop right here using the position-derived destPath above.
        const op = _dragCtrl ? 'copy' : 'move';
        const srcPath = dragState.srcPath;

        // Guards — same as setupDropTarget's drop handler
        if (destPath === srcPath) { dragState = { entries: [], srcPath: '' }; return; }
        if (dragState.entries.some(en => en.is_dir && (destPath === en.path || destPath.startsWith(en.path + '/')))) {
          dragState = { entries: [], srcPath: '' }; return;
        }

        const srcs = dragState.entries.map(en => en.path);
        const total = srcs.length;
        dragState = { entries: [], srcPath: '' };

        window.FF?.log('DROP_INTERNAL', { destPath, op, count: total });

        // r_p6: conflict check for copy operations
        if (op === 'copy') {
          const conflicts = await _checkConflicts(srcs, destPath);
          if (conflicts.length) {
            const action = await _showConflictDialog(conflicts);
            if (action === 'cancel') return;
            if (action === 'skip') {
              const cs = new Set(conflicts);
              const filtered = srcs.filter(s => !cs.has(s.split('/').pop()));
              if (!filtered.length) return;
              srcs.length = 0; filtered.forEach(s => srcs.push(s));
            }
          }
        }
        const cmd = op === 'copy' ? 'copy_files_batch' : 'move_files_batch';
        // p7: cancelFn for tauri drag path
        const jobId2 = _sbProgress.addJob(
          (op === 'copy' ? 'Copying' : 'Moving') + ' 0 / ' + total, total,
          () => invoke('cancel_file_op').catch(() => {})
        );
        const ddUndoItems = [];
        let _ddResolve2;
        const ddDone2 = new Promise(resolve => { _ddResolve2 = resolve; });
        let ddErrors2 = 0;
        const ddUnlisten2 = await listen('file-op-progress', ev => {
          const { done: d, total: t, error, finished } = ev.payload;
          if (error) { ddErrors2++; }
          else {
            const src = srcs[d - 1];
            if (src) ddUndoItems.push({ src, dst: destPath + '/' + src.split('/').pop(), srcDir: src.substring(0, src.lastIndexOf('/')), dstDir: destPath });
          }
          _sbProgress.updateJob(jobId2, d, t, (op === 'copy' ? 'Copying' : 'Moving') + ' ' + d + ' / ' + t);
          if (finished) _ddResolve2();
        });
        invoke(cmd, { srcs, destDir: destPath }).catch(err => { showToast(t('error.drop_failed',{err}),'error'); _ddResolve2(); });
        await ddDone2;
        ddUnlisten2();
        _sbProgress.finishJob(jobId2, ddErrors2 === 0, ddErrors2 > 0 ? ddErrors2 + ' error(s)' : (op === 'copy' ? 'Copy' : 'Move') + ' complete');
        const ok2 = total - ddErrors2;
        if (ok2 > 0) {
          showToast(op==='copy'?t('toast.copied',{n:ok2}):t('toast.moved',{n:ok2}),'success');
          if (ddUndoItems.length) pushUndo({ op, items: ddUndoItems });
        }
        if (ddErrors2 > 0) showToast(t('toast.items_failed',{n:ddErrors2}),'error');
        await refreshColumns();
        return;
      }
      
      // ── External drop (files from Nautilus, Dolphin, desktop, etc.) ─────────
      const cmd = 'copy_files_batch';
      const total = paths.length;
      _sbProgress.start('Copying 0 / ' + total, total);
      
      let ddErrors = 0;
      const ddUndoItems = [];
      let _ddResolve;
      const ddDone = new Promise(resolve => { _ddResolve = resolve; });
      const ddUnlisten = await listen('file-op-progress', ev => {
        const { done: d, total: t, error, finished } = ev.payload;
        if (error) { ddErrors++; }
        else {
          const src = paths[d - 1];
          if (src) ddUndoItems.push({ src, dst: destPath + '/' + src.split('/').pop(), srcDir: src.substring(0, src.lastIndexOf('/')), dstDir: destPath });
        }
        _sbProgress.update(d, t, 'Copying ' + d + ' / ' + t);
        if (finished) _ddResolve();
      });
      
      invoke(cmd, { srcs: paths, destDir: destPath }).catch(err => {
        showToast(t('error.drop_failed',{err}),'error');
        _ddResolve();
      });
      
      await ddDone;
      ddUnlisten();
      _sbProgress.finish(ddErrors === 0, ddErrors > 0 ? ddErrors + ' error(s)' : 'Copy complete');
      
      const okExt = total - ddErrors;
      if (okExt > 0) {
        showToast(t('toast.copied',{n:okExt}),'success');
        if (ddUndoItems.length) pushUndo({ op: 'copy', items: ddUndoItems });
      }
      if (ddErrors > 0) showToast(t('toast.items_failed',{n:ddErrors}),'error');
      await refreshColumns();
    });
  }catch(e){console.warn('Tauri event listener failed:',e);}

// ── Onboarding (first launch) ─────────────────────────────────────────────────
function _showOnboarding() {
  if(localStorage.getItem('ff_onboarded')) return;
  setTimeout(() => {
    document.getElementById('ff-onboarding')?.remove();
    const ov = document.createElement('div');
    ov.id = 'ff-onboarding';
    ov.style.cssText = 'position:fixed;inset:0;z-index:9600;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.72);backdrop-filter:blur(8px);';
    const tips = [
      { icon: '\u2328', title: 'Keyboard first',
        body: 'Arrow keys navigate columns. Space opens Quick Look. F2 renames. Delete moves to Trash. Type letters to jump to a file by name.' },
      { icon: '\uD83D\uDDB1', title: 'Middle-click & drag',
        body: 'Middle-click any folder to open it in a new tab. Drag files between columns or onto sidebar favorites. Drag a folder onto the Favorites title to bookmark it.' },
      { icon: '\uD83D\uDD0D', title: 'Search',
        body: 'Ctrl+F for instant search. Ctrl+Shift+F for advanced search \u2014 regex, file contents, hidden files. Results are filterable by type, size, and date.' },
      { icon: '\u26A1', title: 'Power features',
        body: 'Ctrl+\\ toggles a split pane. Select 2 files and right-click \u2192 Compare to diff them. Ctrl+Shift+P manages plugins. Ctrl+? shows all shortcuts.' },
    ];
    let page = 0;
    const redraw = () => {
      const t = tips[page];
      const dots = tips.map((_,i) =>
        '<div style="width:6px;height:6px;border-radius:50%;background:' +
        (i===page ? '#5b8dd9' : 'rgba(255,255,255,.2)') + ';"></div>'
      ).join('');
      const backBtn = page > 0
        ? '<button id="ob-back" style="padding:7px 16px;background:rgba(255,255,255,.07);border:none;border-radius:8px;color:#98989f;font-size:13px;cursor:pointer;font-family:inherit;">Back</button>'
        : '';
      const fwdBtn = page < tips.length - 1
        ? '<button id="ob-next" style="padding:7px 20px;background:#5b8dd9;border:none;border-radius:8px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">Next</button>'
        : '<button id="ob-done" style="padding:7px 20px;background:#5b8dd9;border:none;border-radius:8px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;">Get started</button>';
      ov.innerHTML =
        '<div style="background:#1a1a1d;border:1px solid rgba(255,255,255,.13);border-radius:18px;width:min(460px,90vw);padding:32px 36px 24px;box-shadow:0 32px 80px rgba(0,0,0,.9);display:flex;flex-direction:column;gap:20px;">' +
          '<div style="display:flex;align-items:flex-start;gap:16px;">' +
            '<div style="font-size:32px;flex-shrink:0;line-height:1;">' + t.icon + '</div>' +
            '<div>' +
              '<div style="font-size:17px;font-weight:700;color:#f1f5f9;margin-bottom:6px;">' + escHtml(t.title) + '</div>' +
              '<div style="font-size:13px;color:#94a3b8;line-height:1.7;">' + escHtml(t.body) + '</div>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;align-items:center;justify-content:space-between;">' +
            '<div style="display:flex;gap:6px;">' + dots + '</div>' +
            '<div style="display:flex;gap:8px;">' + backBtn + fwdBtn + '</div>' +
          '</div>' +
        '</div>';
      ov.querySelector('#ob-back')?.addEventListener('click', () => { page--; redraw(); });
      ov.querySelector('#ob-next')?.addEventListener('click', () => { page++; redraw(); });
      ov.querySelector('#ob-done')?.addEventListener('click', () => {
        localStorage.setItem('ff_onboarded', '1');
        ov.style.opacity = '0'; ov.style.transition = 'opacity .3s';
        setTimeout(() => ov.remove(), 320);
      });
    };
    redraw();
    document.body.appendChild(ov);
    ov.addEventListener('keydown', ev => {
      if(ev.key==='ArrowRight'||ev.key==='Enter') {
        if(page<tips.length-1){page++;redraw();} else ov.querySelector('#ob-done')?.click();
      }
      if(ev.key==='ArrowLeft'){if(page>0){page--;redraw();}}
      if(ev.key==='Escape') ov.querySelector('#ob-done')?.click();
    });
    ov.setAttribute('tabindex','0'); ov.focus();
  }, 900);
}

  // Assign a window number so multiple windows can be told apart in the titlebar
  try {
    const _wc = new BroadcastChannel('ff_windows');
    let _wn = 1;
    const _existing = [];
    _wc.onmessage = ev => { if(ev.data?.type==='hello') _existing.push(ev.data.num); };
    _wc.postMessage({type:'hello', num: 0});
    await new Promise(r=>setTimeout(r,80));
    _wn = (_existing.length ? Math.max(..._existing) : 0) + 1;
    sessionStorage.setItem('ff_win_num', String(_wn));
    _wc.postMessage({type:'hello', num: _wn});
    _wc.close();
  } catch(_e){logError(String(_e),'silent');}
  _showOnboarding();
}
init().catch(err => {
  console.error('[FrostFinder] init() failed:', err);
  // Show visible error so a blank screen is diagnosable without devtools
  document.body.insertAdjacentHTML('beforeend',
    '<div style="position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;background:#1a1a1d;color:#f87171;font-family:monospace;font-size:12px;' +
    'padding:40px;gap:12px;z-index:99999;">' +
    '<div style="font-size:15px;font-weight:600;margin-bottom:4px;">FrostFinder failed to start</div>' +
    '<div style="max-width:600px;word-break:break-all;text-align:center;color:#fca5a5;">' +
    String(err) + '</div>' +
    '<div style="color:#636368;margin-top:8px;">Open devtools (Ctrl+Shift+L) for full stack trace.</div>' +
    '</div>');
});

// ═══════════════════════════════════════════════════════════════════════════
// r40-r42 NEW FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

// ── Dual-pane ────────────────────────────────────────────────────────────────
const panes = [
  { id: 'pane-0', path: null, viewMode: 'column' },
  { id: 'pane-1', path: null, viewMode: 'column' },
];
let activePane = 0;
let dualPaneEnabled = false;

function focusPane(idx) {
  activePane = idx;
  document.querySelectorAll('.pane-container').forEach((el, i) => {
    el.classList.toggle('pane-active', i === idx);
  });
  const panePath = panes[idx]?.path || state.currentPath || '';
  const paneName = panePath.split('/').filter(Boolean).pop() || (idx === 0 ? 'Main pane' : 'Second pane');
  announceA11y(`${idx === 0 ? 'Main pane' : 'Second pane'}: ${paneName}`);
}

function toggleDualPane() {
  dualPaneEnabled = !dualPaneEnabled;
  const root = document.getElementById('content-area') ?? document.querySelector('.main-content') ?? document.getElementById('view-host')?.parentElement;
  if (!root) return;
  if (dualPaneEnabled) {
    root.classList.add('dual-pane');
    if (!document.getElementById('pane-1')) {
      const p1 = document.createElement('div');
      p1.id = 'pane-1'; p1.className = 'pane-container'; p1.tabIndex = 0;
      p1.addEventListener('mousedown', () => focusPane(1));
      root.appendChild(p1);
    }
    const p0 = document.getElementById('pane-0') ?? document.getElementById('view-host');
    if (p0) { p0.id = 'pane-0'; p0.classList.add('pane-container'); p0.tabIndex = 0; p0.addEventListener('mousedown', () => focusPane(0)); }
    panes[1].path = state.currentPath;
    initPaneDivider();
    focusPane(0);
  } else {
    root.classList.remove('dual-pane');
    document.getElementById('pane-1')?.remove();
    document.getElementById('pane-divider')?.remove();
    root.style.gridTemplateColumns = '';
  }
}

function initPaneDivider() {
  document.getElementById('pane-divider')?.remove();
  const root = document.getElementById('pane-0')?.parentElement;
  if (!root) return;
  const div = document.createElement('div');
  div.id = 'pane-divider'; div.className = 'pane-divider'; div.tabIndex = 0;
  const p1 = document.getElementById('pane-1');
  if (p1) root.insertBefore(div, p1);
  let frac = parseFloat(localStorage.getItem('ff_pane_split') || '0.5');
  const applyFrac = f => {
    frac = Math.max(0.15, Math.min(0.85, f));
    root.style.gridTemplateColumns = `${(frac*100).toFixed(2)}% 4px 1fr`;
  };
  applyFrac(frac);
  let dragging = false;
  div.addEventListener('mousedown', e => { e.preventDefault(); dragging = true; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; });
  window.addEventListener('mousemove', e => { if (!dragging) return; const r = root.getBoundingClientRect(); applyFrac((e.clientX - r.left) / r.width); });
  window.addEventListener('mouseup', () => { if (!dragging) return; dragging = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; localStorage.setItem('ff_pane_split', String(frac)); });
  div.addEventListener('dblclick', () => { applyFrac(0.5); localStorage.setItem('ff_pane_split', '0.5'); });
  div.addEventListener('keydown', e => { if (e.key==='ArrowLeft') applyFrac(frac-0.05); if (e.key==='ArrowRight') applyFrac(frac+0.05); if (e.key==='Enter'||e.key===' ') applyFrac(0.5); localStorage.setItem('ff_pane_split', String(frac)); });
}

async function crossPaneCopy() {
  const sel = getSelectedEntries();
  const dest = panes[activePane === 0 ? 1 : 0].path ?? state.currentPath;
  if (!sel.length || !dest) return;
  // r_p6: conflict check before cross-pane copy
  let srcs = sel.map(e => e.path);
  const conflicts = await _checkConflicts(srcs, dest).catch(() => []);
  if (conflicts.length) {
    const action = await _showConflictDialog(conflicts);
    if (action === 'cancel') return;
    if (action === 'skip') {
      const cs = new Set(conflicts);
      srcs = srcs.filter(s => !cs.has(s.split('/').pop()));
      if (!srcs.length) return;
    }
  }
  try { await invoke('copy_files_batch', {srcs, destDir: dest}); showToast(t('toast.copied',{n:srcs.length}),'success'); await refreshCurrent(); } catch(err) { showToast(t('error.copy_clipboard',{err}),'error','clipboard'); }
}

async function crossPaneMove() {
  const sel = getSelectedEntries();
  const dest = panes[activePane === 0 ? 1 : 0].path ?? state.currentPath;
  if (!sel.length || !dest) return;
  try { await invoke('move_files_batch', {srcs: sel.map(e=>e.path), destDir: dest}); showToast(t('toast.moved',{n:sel.length}),'success'); await refreshCurrent(); } catch(err) { showToast(t('error.move_clipboard',{err}),'error','clipboard'); }
}

// ── Multiple windows ──────────────────────────────────────────────────────────
async function openNewWindow(path = state.currentPath) {
  try { await invoke('open_new_window', {path}); } catch(err) { showToast(t('toast.new_window',{err}),'error'); }
}

// ── Disk usage ────────────────────────────────────────────────────────────────
async function showDiskUsage(rootPath = state.currentPath) {
  document.getElementById('disk-usage-dialog')?.remove();
  const dlg = document.createElement('div');
  dlg.id = 'disk-usage-dialog'; dlg.className = 'modal-overlay';
  dlg.innerHTML = `<div class="modal-box" style="width:620px;max-height:80vh;display:flex;flex-direction:column">
    <div class="modal-header"><span class="modal-title">Disk Usage — ${_escHtml(rootPath)}</span>
      <button class="btn-icon" onclick="document.getElementById('disk-usage-dialog').remove()">✕</button></div>
    <div class="modal-body" id="du-body"><div style="padding:40px;text-align:center;color:var(--text-muted)">Scanning…</div></div></div>`;
  document.body.appendChild(dlg);
  try {
    const entries = await invoke('scan_dir_sizes', {path: rootPath});
    const body = document.getElementById('du-body');
    if (!body) return;
    if (!entries.length) { body.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">No subdirectories found.</div>'; return; }
    const sorted = [...entries].sort((a,b)=>b.size-a.size);
    const total = sorted.reduce((s,e)=>s+e.size,0);
    const COLORS = ['#4C9BE8','#E8834C','#5DBE6E','#C15CE8','#E8C74C','#4CE8D6','#E84C6B','#8BE84C','#E8994C','#4C6BE8'];
    const bars = sorted.slice(0,20).map((e,i)=>{
      const name = e.path.split('/').pop()||e.path;
      const pct = ((e.size/total)*100).toFixed(1);
      return `<div class="du-bar-row" onclick="document.getElementById('disk-usage-dialog').remove();navigate('${_escHtml(e.path)}',0);" title="${_escHtml(e.path)}">
        <span class="du-bar-swatch" style="background:${COLORS[i%COLORS.length]}"></span>
        <span class="du-bar-name">${_escHtml(name)}</span>
        <div class="du-bar-track"><div class="du-bar-fill" style="width:${pct}%;background:${COLORS[i%COLORS.length]}"></div></div>
        <span class="du-bar-size">${fmtSize(e.size)}</span>
        <span class="du-bar-pct">${pct}%</span></div>`;
    }).join('');
    body.innerHTML = `<div class="du-total" style="margin-bottom:8px;font-size:13px;color:var(--text-muted)">Total: <strong>${fmtSize(total)}</strong></div><div class="du-bar-list">${bars}</div>`;
  } catch(err) {
    const b = document.getElementById('du-body');
    if (b) b.innerHTML = `<div style="color:var(--color-error);padding:20px">${_escHtml(String(err))}</div>`;
  }
}
function _escHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── Permissions dialog ────────────────────────────────────────────────────────
async function showPermissionsDialog(entry) {
  // r98: capture multi-selection before overwriting entry
  const _batchEntries = (!entry && sel.size > 1) ? getSelectedEntries() : null;
  if (!entry) { const sel = getSelectedEntries(); if (!sel.length) return; entry = sel[0]; }
  let info;
  try { info = await invoke('get_file_permissions', {path: entry.path}); } catch(err) { showToast(t('error.permissions',{err}),'error','permissions'); return; }
  document.getElementById('perms-dialog')?.remove();
  const mode = info.mode;
  const bit = (n,b) => !!(n & b);
  const row = (label, rb, wb, xb) => `<tr><td style="padding:3px 10px 3px 0;font-weight:500">${label}</td>
    <td><input type="checkbox" class="perm-cb" data-bit="${rb}" ${bit(mode,rb)?'checked':''}></td>
    <td><input type="checkbox" class="perm-cb" data-bit="${wb}" ${bit(mode,wb)?'checked':''}></td>
    <td><input type="checkbox" class="perm-cb" data-bit="${xb}" ${bit(mode,xb)?'checked':''}></td></tr>`;
  const octal = (mode & 0o777).toString(8).padStart(3,'0');
  const dlg = document.createElement('div');
  dlg.id = 'perms-dialog'; dlg.className = 'modal-overlay';
  dlg.innerHTML = `<div class="modal-box" style="width:430px"><div class="modal-header">
    <span class="modal-title">Properties — ${_escHtml(info.name)}</span>
    <button class="btn-icon" onclick="document.getElementById('perms-dialog').remove()">✕</button></div>
    <div class="modal-body" style="display:flex;flex-direction:column;gap:12px">
      <div class="perms-meta">
        <div><span class="meta-key">Path</span><span class="meta-val">${_escHtml(info.path)}</span></div>
        <div><span class="meta-key">Kind</span><span class="meta-val">${info.is_dir?'Folder':info.mime_hint??'File'}</span></div>
        <div><span class="meta-key">Size</span><span class="meta-val">${fmtSize(info.size)}</span></div>
        <div><span class="meta-key">Modified</span><span class="meta-val">${new Date(info.modified*1000).toLocaleString()}</span></div>
      </div>
      <div><div style="font-weight:600;margin-bottom:6px">Permissions</div>
        <table style="border-collapse:collapse;font-size:13px"><thead><tr><th></th>
          <th style="padding:0 8px;color:var(--text-muted)">Read</th>
          <th style="padding:0 8px;color:var(--text-muted)">Write</th>
          <th style="padding:0 8px;color:var(--text-muted)">Execute</th></tr></thead>
          <tbody>${row('Owner',0o400,0o200,0o100)}${row('Group',0o040,0o020,0o010)}${row('Others',0o004,0o002,0o001)}</tbody></table>
        <div style="margin-top:8px;display:flex;align-items:center;gap:8px">
          <label style="font-size:13px">Octal</label>
          <input id="perms-octal" class="text-input" style="width:60px;font-family:monospace" value="${octal}" maxlength="4"></div></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <label class="field-label">Owner<input id="perms-owner" class="text-input" value="${_escHtml(info.owner)}"></label>
        <label class="field-label">Group<input id="perms-group" class="text-input" value="${_escHtml(info.group)}"></label></div>
      <div id="perms-error" style="color:var(--color-error,#e53e3e);font-size:13px;display:none"></div></div>
    <div class="modal-footer">
      <button class="btn-ghost" onclick="document.getElementById('perms-dialog').remove()">Cancel</button>
      <button class="btn-primary" id="perms-apply-btn">Apply</button></div></div>`;
  document.body.appendChild(dlg);
  dlg.querySelectorAll('.perm-cb').forEach(cb => cb.addEventListener('change', () => {
    let m = 0; dlg.querySelectorAll('.perm-cb').forEach(c => { if(c.checked) m |= parseInt(c.dataset.bit); });
    document.getElementById('perms-octal').value = (m & 0o777).toString(8).padStart(3,'0');
  }));
  document.getElementById('perms-octal').addEventListener('input', e => {
    const val = parseInt(e.target.value, 8); if (isNaN(val)) return;
    dlg.querySelectorAll('.perm-cb').forEach(cb => { cb.checked = !!(val & parseInt(cb.dataset.bit)); });
  });
  document.getElementById('perms-apply-btn').addEventListener('click', async () => {
    const octalVal = document.getElementById('perms-octal').value.trim();
    const modeVal = parseInt(octalVal, 8);
    const owner = document.getElementById('perms-owner').value.trim();
    const group = document.getElementById('perms-group').value.trim();
    const errEl = document.getElementById('perms-error');
    errEl.style.display = 'none';
    if (isNaN(modeVal) || modeVal < 0 || modeVal > 0o777) { errEl.textContent = 'Invalid octal (000–777)'; errEl.style.display = 'block'; return; }
    try {
      // Capture old values for undo before applying
      const oldMode = mode;
      const oldOwner = document.getElementById('perms-owner').defaultValue || owner;
      const oldGroup = document.getElementById('perms-group').defaultValue || group;
      if(_batchEntries && _batchEntries.length > 1){
        // r98: apply same mode/owner/group to all selected files with progress
        const total=_batchEntries.length;
        _sbProgress.start(`Applying permissions… 0 / ${total}`,total);
        const undoItems=[]; let done=0,hadErr=false;
        for(const _be of _batchEntries){
          try{
            undoItems.push({path:_be.path,oldMode:mode,oldOwner,oldGroup,
              newMode:modeVal,newOwner:owner,newGroup:group});
            await invoke('chmod_entry',{path:_be.path,mode:modeVal});
            await invoke('chown_entry',{path:_be.path,owner,group});
          }catch(bErr){showToast(t('error.chmod',{name:_be.name,err:bErr}),'error');hadErr=true;}
          done++;
          _sbProgress.update(done,total,`Applying permissions… ${done} / ${total}`);
        }
        pushUndo({op:'chmod',items:undoItems});
        _sbProgress.finish(!hadErr,hadErr?'Completed with errors':`Permissions applied to ${done} items`);
        document.getElementById('perms-dialog').remove();
      } else {
        pushUndo({op:'chmod', items:[{
          path: entry.path,
          oldMode, oldOwner, oldGroup,
          newMode: modeVal, newOwner: owner, newGroup: group,
        }]});
        await invoke('chmod_entry', {path: entry.path, mode: modeVal});
        await invoke('chown_entry', {path: entry.path, owner, group});
        showToast(t('toast.permissions_updated'),'success');
        document.getElementById('perms-dialog').remove();
      }
    } catch(err) { errEl.textContent = String(err); errEl.style.display = 'block'; }
  });
}

// ── Undo history panel ────────────────────────────────────────────────────────
function toggleUndoPanel() {
  const ex = document.getElementById('undo-panel'); if (ex) { ex.remove(); return; }
  renderUndoPanel();
}
function renderUndoPanel() {
  let panel = document.getElementById('undo-panel');
  if (!panel) { panel = document.createElement('div'); panel.id = 'undo-panel'; panel.className = 'side-panel undo-panel'; document.body.appendChild(panel); }
  const stack = state._undoStack ?? [];
  const icons = {move:'↔',copy:'⊕',rename:'✏',delete:'🗑',create:'✚',tags:'🏷',chmod:'🔒',batchRename:'✏✏'};
  const rows = stack.length === 0 ? '<div class="undo-empty">Nothing to undo</div>' :
    [...stack].reverse().map((op, i) => `<div class="undo-row${i===0?' undo-next':''}" title="Undo to here" onclick="undoToIndex(${stack.length-1-i})">
      <span class="undo-icon">${icons[op.op]??'↩'}</span>
      <span class="undo-label">${_escHtml(({'move':'Move','copy':'Copy','rename':'Rename','delete':'Trash','create':'Create','tags':'Tag change','chmod':'Permissions','batchRename':'Batch rename'}[op.op]||op.op)+(op.items?` (${op.items.length})`:' '))}</span>
      ${i===0?'<span class="undo-badge">next</span>':''}</div>`).join('');
  panel.innerHTML = `<div class="side-panel-header"><span class="side-panel-title">Undo History</span>
    <span class="undo-count">${stack.length} step${stack.length!==1?'s':''}</span>
    <button class="btn-icon" onclick="document.getElementById('undo-panel').remove()">✕</button></div>
    <div class="undo-list">${rows}</div>
    <div class="side-panel-footer"><button class="btn-ghost btn-sm" onclick="state._undoStack=[];renderUndoPanel();showToast(t('toast.history_cleared'),'info');" ${stack.length===0?'disabled':''}>Clear History</button></div>`;
}
async function undoToIndex(targetIdx) {
  while ((state._undoStack?.length ?? 0) > targetIdx) await undoLastOp();
  if (document.getElementById('undo-panel')) renderUndoPanel();
}

// ── SFTP dialog ───────────────────────────────────────────────────────────────
async function showSftpDialog(prefill = {}) {
  document.getElementById('sftp-dialog')?.remove();
  const dlg = document.createElement('div'); dlg.id = 'sftp-dialog'; dlg.className = 'modal-overlay';
  dlg.innerHTML = `<div class="modal-box" style="width:400px"><div class="modal-header">
    <span class="modal-title">Connect to SFTP Server</span>
    <button class="btn-icon" onclick="document.getElementById('sftp-dialog').remove()">✕</button></div>
    <div class="modal-body" style="display:flex;flex-direction:column;gap:10px">
      <label class="field-label">Host<input id="sftp-host" class="text-input" placeholder="hostname or IP" autocomplete="off"></label>
      <label class="field-label">Port<input id="sftp-port" class="text-input" value="22" style="width:80px"></label>
      <label class="field-label">Username<input id="sftp-user" class="text-input" autocomplete="off"></label>
      <fieldset style="border:1px solid var(--border-subtle,rgba(0,0,0,.12));border-radius:6px;padding:8px">
        <legend style="font-size:12px;padding:0 4px">Authentication</legend>
        <label style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><input type="radio" name="sftp-auth" value="password" id="sftp-auth-pw" checked> Password</label>
        <label style="display:flex;align-items:center;gap:8px"><input type="radio" name="sftp-auth" value="key" id="sftp-auth-key"> SSH Key</label>
        <div id="sftp-pw-wrap" style="margin-top:8px"><input id="sftp-password" class="text-input" type="password" placeholder="Password"></div>
        <div id="sftp-key-wrap" style="display:none;margin-top:8px"><input id="sftp-keypath" class="text-input" placeholder="~/.ssh/id_rsa"></div>
      </fieldset>
      <label class="field-label">Remote path<input id="sftp-remote-path" class="text-input" placeholder="/"></label>
      <div id="sftp-error" style="color:var(--color-error,#e53e3e);font-size:13px;display:none"></div></div>
    <div class="modal-footer">
      <button class="btn-ghost" onclick="document.getElementById('sftp-dialog').remove()">Cancel</button>
      <button class="btn-primary" id="sftp-connect-btn">Connect</button></div></div>`;
  document.body.appendChild(dlg);
  dlg.querySelectorAll('input[name="sftp-auth"]').forEach(r => r.addEventListener('change', () => {
    const isPw = document.getElementById('sftp-auth-pw').checked;
    document.getElementById('sftp-pw-wrap').style.display = isPw?'block':'none';
    document.getElementById('sftp-key-wrap').style.display = isPw?'none':'block';
  }));
  document.getElementById('sftp-connect-btn').addEventListener('click', async () => {
    const host = document.getElementById('sftp-host').value.trim();
    const port = parseInt(document.getElementById('sftp-port').value)||22;
    const username = document.getElementById('sftp-user').value.trim();
    const useKey = document.getElementById('sftp-auth-key').checked;
    const password = useKey?'':document.getElementById('sftp-password').value;
    const keyPath = useKey?document.getElementById('sftp-keypath').value.trim():'';
    const remotePath = document.getElementById('sftp-remote-path').value.trim()||'/';
    const errEl = document.getElementById('sftp-error'); errEl.style.display='none';
    if (!host) { errEl.textContent='Host required'; errEl.style.display='block'; return; }
    const btn = document.getElementById('sftp-connect-btn'); btn.disabled=true; btn.textContent='Connecting…';
    try {
      const mp = await invoke('mount_sftp', {host, port, username, password, keyPath, remotePath});
      dlg.remove(); showToast(t('toast.connected_sftp',{user:username,host}),'success'); renderSidebar(); navigate(mp,0);
    } catch(err) {
      const msg = String(err);
      let hint = '';
      if (msg.includes('Connection refused')) hint = ' Check that the server is running and the port is correct.';
      else if (msg.includes('Authentication failed') || msg.includes('Permission denied')) hint = ' Check your username and password or try using SSH key authentication.';
      else if (msg.includes('Host key verification failed')) hint = ' The server\'s host key has changed. Remove the old entry from ~/.ssh/known_hosts if needed.';
      else if (msg.includes('No route to host') || msg.includes('Network is unreachable')) hint = ' Check your network connection.';
      else if (msg.includes('sshfs')) hint = ' Make sure sshfs is installed: sudo apt install sshfs';
      errEl.innerHTML = msg + (hint ? `<br><small style="color:var(--text-secondary)">${hint}</small>` : '');
      errEl.style.display='block'; btn.disabled=false; btn.textContent='Connect';
    }
  });
  // Apply explicit prefill first (from sidebar password-auth reconnect link)
  if (prefill.host)       { const el=document.getElementById('sftp-host');        if(el) el.value=prefill.host; }
  if (prefill.port)       { const el=document.getElementById('sftp-port');        if(el) el.value=prefill.port; }
  if (prefill.username)   { const el=document.getElementById('sftp-user');        if(el) el.value=prefill.username; }
  if (prefill.remotePath) { const el=document.getElementById('sftp-remote-path'); if(el) el.value=prefill.remotePath; }

  invoke('get_sftp_mounts').then(mounts=>{
    if(!mounts||!mounts.length)return;
    const last=mounts[mounts.length-1];
    const h=document.getElementById('sftp-host');
    const p=document.getElementById('sftp-port');
    const u=document.getElementById('sftp-user');
    const r=document.getElementById('sftp-remote-path');
    if(h&&!h.value)h.value=last.host||'';
    if(p)p.value=last.port||22;
    if(u&&!u.value)u.value=last.username||'';
    if(r&&!r.value)r.value=last.remote_path||'/';
    if(last.key_path){
      const kr=document.getElementById('sftp-auth-key');
      const ki=document.getElementById('sftp-keypath');
      const pw=document.getElementById('sftp-pw-wrap');
      const kw=document.getElementById('sftp-key-wrap');
      if(kr)kr.checked=true;
      if(ki)ki.value=last.key_path;
      if(pw)pw.style.display='none';
      if(kw)kw.style.display='';
    }
  }).catch(()=>{});
  document.getElementById('sftp-host').focus();
}

// ── FTP dialog ────────────────────────────────────────────────────────────────
async function showFtpDialog() {
  document.getElementById('ftp-dialog')?.remove();
  const dlg = document.createElement('div'); dlg.id = 'ftp-dialog'; dlg.className = 'modal-overlay';
  dlg.innerHTML = `<div class="modal-box" style="width:400px"><div class="modal-header">
    <span class="modal-title">Connect to FTP Server</span>
    <button class="btn-icon" onclick="document.getElementById('ftp-dialog').remove()">✕</button></div>
    <div class="modal-body" style="display:flex;flex-direction:column;gap:10px">
      <label class="field-label">Host<input id="ftp-host" class="text-input" placeholder="ftp.example.com" autocomplete="off"></label>
      <label class="field-label">Port<input id="ftp-port" class="text-input" value="21" style="width:80px"></label>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px"><input type="checkbox" id="ftp-anon"> Anonymous login</label>
      <div id="ftp-creds-wrap" style="display:flex;flex-direction:column;gap:10px">
        <label class="field-label">Username<input id="ftp-user" class="text-input"></label>
        <label class="field-label">Password<input id="ftp-pass" class="text-input" type="password"></label></div>
      <label class="field-label">Remote path<input id="ftp-remote-path" class="text-input" placeholder="/"></label>
      <div style="display:flex;gap:16px">
        <label style="display:flex;align-items:center;gap:6px;font-size:13px"><input type="checkbox" id="ftp-passive" ${localStorage.getItem('ff_ftp_passive')!=='0'?'checked':''} > Passive</label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px"><input type="checkbox" id="ftp-tls"> FTPS</label></div>
      <div id="ftp-error" style="color:var(--color-error,#e53e3e);font-size:13px;display:none"></div></div>
    <div class="modal-footer">
      <button class="btn-ghost" onclick="document.getElementById('ftp-dialog').remove()">Cancel</button>
      <button class="btn-primary" id="ftp-connect-btn">Connect</button></div></div>`;
  document.body.appendChild(dlg);
  document.getElementById('ftp-anon').addEventListener('change', e => {
    document.getElementById('ftp-creds-wrap').style.display = e.target.checked?'none':'flex';
  });
  document.getElementById('ftp-connect-btn').addEventListener('click', async () => {
    const host = document.getElementById('ftp-host').value.trim();
    const port = parseInt(document.getElementById('ftp-port').value)||21;
    const anon = document.getElementById('ftp-anon').checked;
    const username = anon?'anonymous':document.getElementById('ftp-user').value.trim();
    const password = anon?'guest@':document.getElementById('ftp-pass').value;
    const remotePath = document.getElementById('ftp-remote-path').value.trim()||'/';
    const passive = document.getElementById('ftp-passive').checked;
    const tls = document.getElementById('ftp-tls').checked;
    const errEl = document.getElementById('ftp-error'); errEl.style.display='none';
    if (!host) { errEl.textContent='Host required'; errEl.style.display='block'; return; }
    const btn = document.getElementById('ftp-connect-btn'); btn.disabled=true; btn.textContent='Connecting…';
    try {
      const mp = await invoke('mount_ftp', {host, port, username, password, remotePath, passive, tls});
      dlg.remove(); showToast(t('toast.connected_host',{host}),'success'); renderSidebar(); navigate(mp,0);
    } catch(err) { errEl.textContent=String(err); errEl.style.display='block'; btn.disabled=false; btn.textContent='Connect'; }
  });
  invoke('get_ftp_mounts').then(mounts=>{
    if(!mounts||!mounts.length)return;
    const last=mounts[mounts.length-1];
    const h=document.getElementById('ftp-host');
    const p=document.getElementById('ftp-port');
    const u=document.getElementById('ftp-user');
    const r=document.getElementById('ftp-remote');
    if(h&&!h.value)h.value=last.host||'';
    if(p)p.value=last.port||21;
    if(u&&!u.value)u.value=last.username||'';
    if(r&&!r.value)r.value=last.remote_path||'/';
  }).catch(()=>{});
  document.getElementById('ftp-host').focus();
}

// ── Plugin system ─────────────────────────────────────────────────────────────
let _plugins = [];
// ── Phase 3: Cloud storage connect dialog ────────────────────────────────────

// ── Phase 4: Git status badge module ─────────────────────────────────────────
// Maintains a per-directory git status map. Views read _gitStatus to decorate
// file rows with coloured dots. Status is refreshed on every navigate() and
// when dir-changed fires (which already calls refreshColumns).

let _gitStatus = null;      // GitStatus | null
let _gitRoot   = null;      // current repo root | null

async function refreshGitStatus(path) {
  if (!path) { _gitStatus = null; _gitRoot = null; return; }
  // Check if git is enabled in settings
  if (state._settings?.gitBadges === false) { _gitStatus = null; _gitRoot = null; return; }
  try {
    const status = await invoke('get_git_status', { path });
    _gitStatus = status ?? null;
    _gitRoot   = status ? (await invoke('find_git_root', { path })) : null;
  } catch (_) {
    _gitStatus = null; _gitRoot = null;
  }
}

/** Return the CSS colour for a git status code, or '' if unknown/none. */
function gitStatusColor(code) {
  switch (code) {
    case 'M': return '#f59e0b';  // amber  — modified (worktree)
    case 'S': return '#34d399';  // green  — staged
    case 'U': return '#94a3b8';  // grey   — untracked
    case 'C': return '#f87171';  // red    — conflict
    case 'A': return '#34d399';  // green  — added
    case 'D': return '#f87171';  // red    — deleted
    default:  return '';
  }
}

/** Return a 6px dot HTML string for a file path, or '' if no status. */
function gitBadgeHtml(filePath) {
  if (!_gitStatus) return '';
  const code = _gitStatus.files[filePath];
  if (!code) {
    // Check if any child of this directory has a status (for folder badges)
    if (!filePath.endsWith('/')) filePath += '/';
    const hasChild = Object.keys(_gitStatus.files).some(p => p.startsWith(filePath));
    if (!hasChild) return '';
    return `<span class="git-badge" style="background:#f59e0b" title="Contains changes"></span>`;
  }
  const color = gitStatusColor(code);
  if (!color) return '';
  const titles = { M:'Modified', S:'Staged', U:'Untracked', C:'Conflict', A:'Added', D:'Deleted' };
  return `<span class="git-badge" style="background:${color}" title="${titles[code]??code}"></span>`;
}

/** Return branch display HTML for the path bar (branch + dirty dot). */
function gitBranchHtml() {
  if (!_gitStatus) return '';
  const dirty = _gitStatus.dirty ? '<span style="color:#f59e0b;font-size:8px;vertical-align:middle"> ●</span>' : '';
  return `<span class="git-branch-pill"><svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" style="width:10px;height:10px;flex-shrink:0"><circle cx="3" cy="3" r="1.5"/><circle cx="3" cy="9" r="1.5"/><circle cx="9" cy="3" r="1.5"/><path d="M3 4.5v3M3 4.5C3 6 9 6 9 4.5"/></svg>${escHtml(_gitStatus.branch)}${dirty}</span>`;
}


const CLOUD_PROVIDERS = [
  { id: 'gdrive',   name: 'Google Drive',  icon: '🔵', color: '#4285f4' },
  { id: 'dropbox',  name: 'Dropbox',       icon: '🟦', color: '#0061fe' },
  { id: 'onedrive', name: 'OneDrive',      icon: '🪟', color: '#0078d4' },
];

// ── Phase 4: Encrypted vault dialog ──────────────────────────────────────────

async function showVaultDialog() {
  document.getElementById('vault-dialog')?.remove();

  // Check gocryptfs availability
  let gcVer = '';
  try {
    gcVer = await invoke('check_gocryptfs');
  } catch (err) {
    const dlg = document.createElement('div');
    dlg.id = 'vault-dialog'; dlg.className = 'modal-overlay';
    dlg.innerHTML = `<div class="modal-box" style="width:420px">
      <div class="modal-header">
        <span class="modal-title">Encrypted Vaults</span>
        <button class="btn-icon" onclick="document.getElementById('vault-dialog').remove()">✕</button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:14px">
        <div style="background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.25);border-radius:8px;padding:14px;font-size:13px;color:#fca5a5;line-height:1.6">
          <strong>gocryptfs not found.</strong><br>
          Encrypted vaults require gocryptfs. Install with:<br>
          <code style="display:block;margin-top:8px;padding:6px 10px;background:rgba(0,0,0,.3);border-radius:5px;font-size:11.5px;user-select:all">sudo apt install gocryptfs</code>
          <code style="display:block;margin-top:4px;padding:6px 10px;background:rgba(0,0,0,.3);border-radius:5px;font-size:11.5px;user-select:all">sudo pacman -S gocryptfs</code>
        </div>
        <button class="modal-primary-btn" onclick="document.getElementById('vault-dialog').remove()">OK</button>
      </div>
    </div>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.remove(); });
    return;
  }

  const vaults = await invoke('list_vaults').catch(() => []);

  const dlg = document.createElement('div');
  dlg.id = 'vault-dialog'; dlg.className = 'modal-overlay';
  dlg.innerHTML = `<div class="modal-box" style="width:460px">
    <div class="modal-header">
      <span class="modal-title">🔒 Encrypted Vaults</span>
      <button class="btn-icon" onclick="document.getElementById('vault-dialog').remove()">✕</button>
    </div>
    <div class="modal-body" style="display:flex;flex-direction:column;gap:16px">

      ${vaults.length ? `<div>
        <div style="font-size:11px;color:#636368;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Your Vaults</div>
        <div id="vault-list" style="display:flex;flex-direction:column;gap:6px">
          ${vaults.map(v => `
          <div style="display:flex;align-items:center;gap:10px;padding:9px 12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px">
            <span style="font-size:20px">${v.mounted ? '🔓' : '🔒'}</span>
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:500;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(v.name)}</div>
              <div style="font-size:11px;color:#636368;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(v.encrypted_dir)}</div>
            </div>
            <button class="vault-action-btn" data-vault-id="${escHtml(v.id)}" data-mounted="${v.mounted}"
              style="padding:4px 10px;border-radius:6px;font-size:11px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);color:${v.mounted ? '#f87171' : '#34d399'};cursor:pointer">
              ${v.mounted ? 'Lock' : 'Unlock'}
            </button>
            <button class="vault-remove-btn" data-vault-id="${escHtml(v.id)}" title="Remove vault" style="color:#636368;background:none;border:none;cursor:pointer;font-size:14px;padding:4px">✕</button>
          </div>`).join('')}
        </div>
      </div>` : `<div style="text-align:center;padding:24px 0;color:#636368;font-size:13px">
        No vaults yet. Create one below.
      </div>`}

      <div style="border-top:1px solid rgba(255,255,255,.06);padding-top:14px">
        <div style="font-size:11px;color:#636368;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">Create New Vault</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <label class="field-label">Vault name
            <input id="vault-name" class="text-input" placeholder="e.g. Private Documents" autocomplete="off">
          </label>
          <label class="field-label">Encrypted directory (will be created)
            <div style="display:flex;gap:6px">
              <input id="vault-dir" class="text-input" style="flex:1" placeholder="${escHtml((state.currentPath||'~') + '/MyVault')}" autocomplete="off">
              <button id="vault-dir-browse" style="padding:4px 10px;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:#94a3b8;cursor:pointer;font-size:11.5px;white-space:nowrap">Browse…</button>
            </div>
          </label>
          <label class="field-label">Password
            <input id="vault-pw" class="text-input" type="password" placeholder="Choose a strong password" autocomplete="new-password">
          </label>
          <label class="field-label">Confirm password
            <input id="vault-pw2" class="text-input" type="password" placeholder="Repeat password" autocomplete="new-password">
          </label>
          <div style="font-size:11px;color:#636368;line-height:1.6">
            ⚠ FrostFinder does not store your password. If you forget it, the vault cannot be recovered.
          </div>
          <button id="vault-create-btn" class="modal-primary-btn">Create Vault</button>
        </div>
      </div>

      <div style="font-size:11px;color:#3d6080;text-align:center">${escHtml(gcVer)}</div>
    </div>
  </div>`;

  document.body.appendChild(dlg);
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.remove(); });

  // Wire unlock/lock buttons
  dlg.querySelectorAll('.vault-action-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const vaultId = btn.dataset.vaultId;
      const mounted = btn.dataset.mounted === 'true';
      if (mounted) {
        btn.disabled = true; btn.textContent = 'Locking…';
        try {
          await invoke('lock_vault', { vaultId });
          showToast(t('toast.vault_locked'),'info');
          dlg.remove(); renderSidebar();
        } catch (err) { showToast(String(err), 'error'); btn.disabled = false; btn.textContent = 'Lock'; }
      } else {
        const pw = prompt('Enter vault password:');
        if (!pw) return;
        btn.disabled = true; btn.textContent = 'Unlocking…';
        try {
          const mp = await invoke('unlock_vault', { vaultId, password: pw });
          showToast(t('toast.vault_unlocked'),'info');
          dlg.remove();
          renderSidebar();
          navigate(mp, 0);
        } catch (err) { showToast(String(err), 'error'); btn.disabled = false; btn.textContent = 'Unlock'; }
      }
    });
  });

  // Wire remove buttons
  dlg.querySelectorAll('.vault-remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this vault from FrostFinder? The encrypted files will NOT be deleted.')) return;
      btn.disabled = true;
      try {
        await invoke('remove_vault', { vaultId: btn.dataset.vaultId });
        showToast(t('toast.vault_removed'),'info');
        dlg.remove(); renderSidebar();
      } catch (err) { showToast(String(err), 'error'); btn.disabled = false; }
    });
  });

  // Browse button
  document.getElementById('vault-dir-browse')?.addEventListener('click', async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const dir = await open({ directory: true, title: 'Choose vault location' });
      if (dir) {
        const name = document.getElementById('vault-name')?.value.trim().replace(/[^\w\-]/g,'_') || 'Vault';
        document.getElementById('vault-dir').value = dir + '/' + name;
      }
    } catch (_) {}
  });

  // Create vault
  document.getElementById('vault-create-btn')?.addEventListener('click', async () => {
    const name  = document.getElementById('vault-name')?.value.trim();
    const encDir = document.getElementById('vault-dir')?.value.trim();
    const pw    = document.getElementById('vault-pw')?.value;
    const pw2   = document.getElementById('vault-pw2')?.value;
    if (!name)   { showToast(t('toast.enter_vault_name'),'error'); return; }
    if (!encDir) { showToast(t('toast.choose_directory'),'error'); return; }
    if (!pw)     { showToast(t('toast.enter_password'),'error'); return; }
    if (pw !== pw2) { showToast(t('toast.passwords_mismatch'),'error'); return; }
    const btn = document.getElementById('vault-create-btn');
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      const entry = await invoke('create_vault', { name, encryptedDir: encDir, password: pw });
      // Auto-unlock after creation
      const mp = await invoke('unlock_vault', { vaultId: entry.id, password: pw });
      showToast(t('toast.vault_created'),'info');
      dlg.remove();
      renderSidebar();
      navigate(mp, 0);
    } catch (err) {
      showToast(String(err), 'error');
      btn.disabled = false; btn.textContent = 'Create Vault';
    }
  });
}


async function showCloudDialog() {
  document.getElementById('cloud-dialog')?.remove();

  // Check rclone availability first
  let rcloneVer = '';
  try {
    rcloneVer = await invoke('check_rclone');
  } catch (err) {
    const dlg = document.createElement('div');
    dlg.id = 'cloud-dialog'; dlg.className = 'modal-overlay';
    dlg.innerHTML = `<div class="modal-box" style="width:420px">
      <div class="modal-header">
        <span class="modal-title">Connect Cloud Storage</span>
        <button class="btn-icon" onclick="document.getElementById('cloud-dialog').remove()">✕</button>
      </div>
      <div class="modal-body" style="display:flex;flex-direction:column;gap:14px">
        <div style="background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.25);border-radius:8px;padding:14px;font-size:13px;color:#fca5a5;line-height:1.6">
          <strong>rclone not found.</strong><br>
          Cloud storage requires rclone. Install it with:<br>
          <code style="display:block;margin-top:8px;padding:6px 10px;background:rgba(0,0,0,.3);border-radius:5px;font-size:11.5px;user-select:all">sudo apt install rclone</code>
          <code style="display:block;margin-top:4px;padding:6px 10px;background:rgba(0,0,0,.3);border-radius:5px;font-size:11.5px;user-select:all">curl https://rclone.org/install.sh | sudo bash</code>
        </div>
        <button class="modal-primary-btn" onclick="document.getElementById('cloud-dialog').remove()">OK</button>
      </div>
    </div>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('click', e => { if (e.target === dlg) dlg.remove(); });
    return;
  }

  // Load existing remotes
  let existingRemotes = [];
  try { existingRemotes = await invoke('list_rclone_remotes'); } catch (_) {}

  const dlg = document.createElement('div');
  dlg.id = 'cloud-dialog'; dlg.className = 'modal-overlay';
  dlg.innerHTML = `<div class="modal-box" style="width:460px">
    <div class="modal-header">
      <span class="modal-title">Connect Cloud Storage</span>
      <button class="btn-icon" onclick="document.getElementById('cloud-dialog').remove()">✕</button>
    </div>
    <div class="modal-body" style="display:flex;flex-direction:column;gap:16px">

      ${existingRemotes.length ? `
      <div>
        <div style="font-size:11px;color:#636368;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px">Connected Accounts</div>
        <div id="cloud-existing-list" style="display:flex;flex-direction:column;gap:6px">
          ${existingRemotes.map(r => {
            const p = CLOUD_PROVIDERS.find(p => p.id === r.provider) || { icon: '☁', color: '#8b5cf6', name: r.provider };
            return `<div style="display:flex;align-items:center;gap:10px;padding:9px 12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:8px">
              <span style="font-size:18px">${p.icon}</span>
              <div style="flex:1;min-width:0">
                <div style="font-size:13px;font-weight:500;color:#e2e8f0">${escHtml(r.label)}</div>
                <div style="font-size:11px;color:#636368">${p.name} · ${r.mounted ? '🟢 Mounted' : '⚫ Not mounted'}</div>
              </div>
              <button class="cloud-mount-btn sb-rm-btn" data-remote="${escHtml(r.id)}" data-mounted="${r.mounted}" style="padding:4px 10px;border-radius:6px;font-size:11px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.06);color:#94a3b8;cursor:pointer">
                ${r.mounted ? 'Unmount' : 'Mount'}
              </button>
              <button class="cloud-remove-btn sb-rm-btn" data-remote="${escHtml(r.id)}" title="Remove account" style="color:#f87171;background:none;border:none;cursor:pointer;padding:4px;font-size:14px">✕</button>
            </div>`;
          }).join('')}
        </div>
      </div>
      <div style="border-top:1px solid rgba(255,255,255,.06);padding-top:14px">` : ''}

      <div>
        <div style="font-size:11px;color:#636368;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">Add Account</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${CLOUD_PROVIDERS.map(p => `
          <button class="cloud-add-provider-btn" data-provider="${p.id}" style="display:flex;align-items:center;gap:12px;padding:11px 14px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.09);border-radius:9px;cursor:pointer;transition:background .15s;text-align:left;width:100%">
            <span style="font-size:22px;flex-shrink:0">${p.icon}</span>
            <div style="flex:1">
              <div style="font-size:13px;font-weight:600;color:#e2e8f0">${p.name}</div>
              <div style="font-size:11px;color:#636368;margin-top:1px">Opens browser for sign-in</div>
            </div>
            <span style="color:#636368;font-size:16px">›</span>
          </button>`).join('')}
        </div>
      </div>

      ${existingRemotes.length ? '</div>' : ''}

      <div style="font-size:11px;color:#3d6080;text-align:center">
        Powered by <a href="#" style="color:#5b8dd9" onclick="event.preventDefault()">rclone</a> ${escHtml(rcloneVer)} · Files stay in your account
      </div>
    </div>
  </div>`;

  document.body.appendChild(dlg);
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.remove(); });

  // Wire mount/unmount buttons on existing accounts
  dlg.querySelectorAll('.cloud-mount-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const remote = btn.dataset.remote;
      const mounted = btn.dataset.mounted === 'true';
      btn.disabled = true; btn.textContent = '…';
      try {
        if (mounted) {
          await invoke('unmount_cloud_provider', { remoteName: remote });
          showToast(t('toast.disconnected'),'info');
        } else {
          await invoke('mount_cloud_provider', { remoteName: remote });
          showToast(t('toast.mount_success'),'info');
        }
        dlg.remove(); renderSidebar();
      } catch (err) {
        const msg = String(err);
        btn.disabled = false; btn.textContent = mounted ? 'Unmount' : 'Mount';
        // Inline error + recovery actions instead of a raw dismissible toast
        let errEl = btn.closest('div[style]')?.querySelector('.cloud-err');
        if (!errEl) {
          errEl = Object.assign(document.createElement('div'), { className: 'cloud-err' });
          errEl.style.cssText = 'font-size:11.5px;color:#f87171;margin-top:6px;display:flex;flex-direction:column;gap:5px';
          btn.closest('div[style]')?.appendChild(errEl);
        }
        const isOAuth = msg.includes('OAuth') || msg.includes('token') || msg.includes('auth');
        const isRclone = msg.includes('rclone not found');
        errEl.innerHTML = `<span>${escHtml(isRclone ? 'rclone not found — install with: sudo apt install rclone' : msg)}</span>`
          + (isOAuth ? `<button class="cloud-reauth-btn" style="width:fit-content;font-size:11px;padding:3px 10px;`
            + `background:rgba(91,141,217,.15);color:#5b8dd9;border:1px solid rgba(91,141,217,.3);border-radius:5px;cursor:pointer"`
            + `>Re-authenticate →</button>` : '')
          + (!isOAuth && !isRclone ? `<button class="cloud-retry-btn" style="width:fit-content;font-size:11px;padding:3px 10px;`
            + `background:rgba(91,141,217,.15);color:#5b8dd9;border:1px solid rgba(91,141,217,.3);border-radius:5px;cursor:pointer"`
            + `>Try again</button>` : '');
        errEl.querySelector('.cloud-retry-btn')?.addEventListener('click', async () => {
          errEl.innerHTML = '<span style="color:#94a3b8">Retrying…</span>';
          try { await invoke('mount_cloud_provider',{remoteName:remote}); showToast(t('toast.mount_success'),'info'); dlg.remove(); renderSidebar(); }
          catch(e2) { errEl.innerHTML = `<span>${escHtml(String(e2))}</span>`; }
        });
        errEl.querySelector('.cloud-reauth-btn')?.addEventListener('click', () => { dlg.remove(); showCloudDialog(); });
      }
    });
  });

  // Wire remove buttons
  dlg.querySelectorAll('.cloud-remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const remote = btn.dataset.remote;
      if (!confirm(`Remove ${remote.replace('ff_','')} account? This revokes FrostFinder's access but does NOT delete your cloud files.`)) return;
      btn.disabled = true;
      try {
        await invoke('remove_cloud_provider', { remoteName: remote });
        showToast(t('toast.account_removed'),'info');
        dlg.remove();
        renderSidebar();
      } catch (err) {
        showToast(String(err), 'error');
        btn.disabled = false;
      }
    });
  });

  // Wire add-provider buttons
  dlg.querySelectorAll('.cloud-add-provider-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const provider = btn.dataset.provider;
      const pName = CLOUD_PROVIDERS.find(p => p.id === provider)?.name ?? provider;

      // Ask for a label
      const label = prompt(`Name this ${pName} account (e.g. "Work" or "Personal"):`, pName);
      if (!label?.trim()) return;

      // Show progress state
      btn.disabled = true;
      const orig = btn.innerHTML;
      btn.innerHTML = `<span style="font-size:22px;flex-shrink:0">⏳</span><div style="flex:1"><div style="font-size:13px;font-weight:600;color:#e2e8f0">Opening browser…</div><div style="font-size:11px;color:#636368;margin-top:1px">Complete sign-in in your browser, then return here</div></div>`;

      try {
        const remoteName = await invoke('add_cloud_provider', { provider, label: label.trim() });
        // Auto-mount after auth
        await invoke('mount_cloud_provider', { remoteName });
        showToast(t('toast.cloud_mounted',{name:pName}),'info');
        dlg.remove();
        renderSidebar();
      } catch (err) {
        showToast(String(err), 'error');
        btn.disabled = false; btn.innerHTML = orig;
      }
    });
  });
}


async function loadPlugins() { try { _plugins = await invoke('load_plugins'); } catch { _plugins = []; } }
function matchesGlob(name, pattern) {
  if (!pattern || pattern === '*') return true;
  const bm = pattern.match(/^(.*)\{([^}]+)\}(.*)$/);
  if (bm) return bm[2].split(',').some(a => matchesGlob(name, bm[1]+a.trim()+bm[3]));
  const re = new RegExp('^'+pattern.replace(/[.+^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*').replace(/\?/g,'.')+'$','i');
  return re.test(name);
}
function pluginsForEntry(entry) { return _plugins.filter(p => matchesGlob(entry.name, p.match ?? '*')); }
async function runPlugin(plugin, entries) {
  // r177: resolve param placeholders before confirm or execution
  let resolvedCommand = plugin.command || '';
  if (plugin.params && plugin.params.length) {
    const paramValues = await _showPluginParamDialog(plugin);
    if (!paramValues) return; // user cancelled
    for (const [k, v] of Object.entries(paramValues)) {
      resolvedCommand = resolvedCommand.replace(new RegExp('\\{' + k + '\\}', 'g'), v);
    }
  }

  if (plugin.confirm) {
    if (!confirm(`Run "${plugin.name}" on ${entries.map(e=>e.name).join(', ')}?`)) return;
  }

  // p9: trust-on-first-use
  try {
    const trust = await invoke('check_plugin_trust', { pluginId: plugin.id, command: resolvedCommand });
    if (!trust.trusted) {
      const msg = trust.first_run
        ? `Allow plugin "${plugin.name}" to run shell commands?`
        : `Plugin "${plugin.name}" command has changed since last approved. Allow?`;
      if (!confirm(msg + '\n\n' + resolvedCommand)) return;
      await invoke('approve_plugin', { pluginId: plugin.id, command: resolvedCommand }).catch(() => {});
    }
  } catch (_) {}

  const targets = plugin.multi ? entries : [entries[0]];
  const jobId = _sbProgress.addJob(`${plugin.name}\u2026`, targets.length);

  // r179: listen for PROGRESS:n/total events emitted by run_plugin_command
  let _progUnlisten = null;
  try {
    _progUnlisten = await listen('plugin-progress', ev => {
      const { done, total, finished, exit_code } = ev.payload;
      if (finished) {
        _sbProgress.finishJob(jobId, exit_code === 0,
          exit_code === 0 ? `${plugin.name} done` : `${plugin.name} failed (${exit_code})`);
        _progUnlisten?.(); _progUnlisten = null;
      } else if (total > 0) {
        _sbProgress.updateJob(jobId, done, total, `${plugin.name} ${done}/${total}`);
      }
    });
  } catch(_) {}

  let allOutput = '';
  let lastExitCode = 0;

  for (const entry of targets) {
    const cmd = resolvedCommand
      .replace(/\{path\}/g,   entry.path)
      .replace(/\{name\}/g,   entry.name)
      .replace(/\{dir\}/g,    entry.path.replace('/'+entry.name,''))
      .replace(/\{ext\}/g,    entry.name.includes('.')?entry.name.split('.').pop():'');
    try {
      const res = await invoke('run_plugin_command', {command: cmd, workDir: state.currentPath});
      lastExitCode = res.exit_code;
      if (res.stdout) allOutput += (allOutput ? '\n' : '') + res.stdout;
    } catch(err) {
      showToast(t('toast.plugin_error',{err}),'error');
      _progUnlisten?.(); _progUnlisten = null;
      _sbProgress.finishJob(jobId, false, 'Plugin error');
      return;
    }
  }

  _progUnlisten?.(); _progUnlisten = null;
  _sbProgress.finishJob(jobId, lastExitCode === 0,
    lastExitCode === 0 ? `${plugin.name} done` : `${plugin.name} failed (${lastExitCode})`);

  if (lastExitCode === 0) await refreshCurrent();

  // r176: show output panel if stdout is non-empty and <= 4KB
  if (allOutput && allOutput.length <= 4096) {
    _showPluginOutput(plugin.name, allOutput);
  } else if (plugin.notify !== false) {
    showToast(lastExitCode===0?t('toast.plugin_ran',{name:plugin.name}):t('toast.plugin_failed',{name:plugin.name,code:lastExitCode}),
      lastExitCode===0?'success':'error');
  }
}

// r176: Plugin output panel — plain text or JSON table
function _showPluginOutput(pluginName, output) {
  document.getElementById('ff-plugin-output')?.remove();
  const ov = document.createElement('div');
  ov.id = 'ff-plugin-output';
  ov.style.cssText = 'position:fixed;inset:0;z-index:9450;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);backdrop-filter:blur(6px);';

  let bodyHtml = '';
  try {
    const parsed = JSON.parse(output.trim());
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    if (rows.length && typeof rows[0] === 'object' && rows[0] !== null) {
      const cols = Object.keys(rows[0]);
      bodyHtml = `<div class="pout-table-wrap"><table class="pout-table">
        <thead><tr>${cols.map(c=>`<th>${escHtml(c)}</th>`).join('')}</tr></thead>
        <tbody>${rows.slice(0,200).map(row=>
          `<tr>${cols.map(c=>`<td>${escHtml(String(row[c]??''))}</td>`).join('')}</tr>`
        ).join('')}</tbody>
      </table>${rows.length>200?`<div class="pout-truncated">Showing 200 of ${rows.length} rows</div>`:''}</div>`;
    } else {
      bodyHtml = `<pre class="pout-pre">${escHtml(output)}</pre>`;
    }
  } catch(_) {
    bodyHtml = `<pre class="pout-pre">${escHtml(output)}</pre>`;
  }

  ov.innerHTML = `
    <div class="pout-box">
      <div class="pout-header">
        <span class="pout-title">${escHtml(pluginName)} \u2014 Output</span>
        <div style="display:flex;gap:6px;">
          <button class="pout-copy" id="pout-copy" title="Copy to clipboard">\u2398</button>
          <button class="pout-close" id="pout-close">\u2715</button>
        </div>
      </div>
      <div class="pout-body">${bodyHtml}</div>
    </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('#pout-close').addEventListener('click', close);
  ov.addEventListener('click', ev => { if(ev.target===ov) close(); });
  ov.addEventListener('keydown', ev => { if(ev.key==='Escape') close(); });
  ov.querySelector('#pout-copy').addEventListener('click', () =>
    navigator.clipboard.writeText(output)
      .then(() => showToast(t('toast.output_copied'),'success'))
      .catch(() => {})
  );
}

// r177: Plugin parameter dialog
function _showPluginParamDialog(plugin) {
  return new Promise(resolve => {
    document.getElementById('ff-plugin-params')?.remove();
    const ov = document.createElement('div');
    ov.id = 'ff-plugin-params';
    ov.style.cssText = 'position:fixed;inset:0;z-index:9500;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.65);backdrop-filter:blur(7px);';
    const fields = (plugin.params || []).map((p, i) =>
      `<div style="display:flex;flex-direction:column;gap:4px;margin-bottom:10px;">
        <label style="font-size:12px;color:var(--text-secondary);">${escHtml(p.label||p.name)}</label>
        <input class="pp-field" data-name="${escHtml(p.name)}" id="pp-field-${i}"
          placeholder="${escHtml(p.placeholder||'')}" value="${escHtml(p.default||'')}"
          style="padding:7px 10px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:7px;color:var(--text-primary);font-size:12px;outline:none;font-family:inherit;">
      </div>`
    ).join('');
    ov.innerHTML = `
      <div style="background:#1a1a1d;border:1px solid rgba(255,255,255,.13);border-radius:14px;width:min(420px,92vw);padding:22px 24px;box-shadow:0 24px 64px rgba(0,0,0,.8);">
        <div style="font-size:14px;font-weight:600;color:#f1f5f9;margin-bottom:16px;">${escHtml(plugin.name)}</div>
        ${fields}
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:4px;">
          <button id="pp-cancel" style="padding:6px 14px;background:rgba(255,255,255,.07);border:none;border-radius:7px;color:#94a3b8;cursor:pointer;">Cancel</button>
          <button id="pp-run" style="padding:6px 14px;background:#5b8dd9;border:none;border-radius:7px;color:#fff;font-weight:600;cursor:pointer;">Run</button>
        </div>
      </div>`;
    document.body.appendChild(ov);
    ov.querySelector('#pp-cancel').addEventListener('click', () => { ov.remove(); resolve(null); });
    ov.querySelector('#pp-run').addEventListener('click', () => {
      const vals = {};
      ov.querySelectorAll('.pp-field').forEach(el => { vals[el.dataset.name] = el.value; });
      ov.remove(); resolve(vals);
    });
    ov.addEventListener('keydown', ev => {
      if(ev.key==='Escape'){ ov.remove(); resolve(null); }
      if(ev.key==='Enter'){ ov.querySelector('#pp-run')?.click(); }
    });
    requestAnimationFrame(() => ov.querySelector('.pp-field')?.focus());
  });
}
async function showPluginManager() {
  document.getElementById('plugin-manager')?.remove();
  const dlg = document.createElement('div'); dlg.id = 'plugin-manager'; dlg.className = 'modal-overlay';
  const renderRows = () => _plugins.map((p,i) => `<div class="plugin-row">
    <span class="plugin-icon">${_escHtml(p.icon??'▶')}</span>
    <div class="plugin-info"><div class="plugin-name">${_escHtml(p.name)}</div>
      <div class="plugin-cmd">${_escHtml(p.command)}</div>
      <div class="plugin-match">Matches: ${_escHtml(p.match??'*')}</div></div>
    <div class="plugin-actions">
      <button class="btn-ghost btn-sm" onclick="_editPlugin(${i})">Edit</button>
      <button class="btn-ghost btn-sm btn-danger-ghost" onclick="_deletePlugin(${i})">Delete</button></div></div>`).join('');
  dlg.innerHTML = `<div class="modal-box" style="width:560px;max-height:80vh;display:flex;flex-direction:column">
    <div class="modal-header"><span class="modal-title">Custom Actions</span>
      <button class="btn-icon" onclick="document.getElementById('plugin-manager').remove()">✕</button></div>
    <div class="modal-body" style="flex:1;overflow-y:auto">
      <div id="plugin-list">${renderRows()}</div>
      <button class="btn-primary btn-sm" style="margin-top:12px" onclick="_editPlugin(null)">+ Add Action</button></div>
    <div class="modal-footer"><button class="btn-ghost" onclick="document.getElementById('plugin-manager').remove()">Close</button></div></div>`;
  document.body.appendChild(dlg);
}
window._editPlugin = (idx) => {
  const p = idx !== null ? _plugins[idx] : {name:'',icon:'▶',match:'*',command:'',multi:false,confirm:false,notify:true};
  document.getElementById('plugin-editor')?.remove();
  const ed = document.createElement('div'); ed.id = 'plugin-editor'; ed.className = 'modal-overlay';
  ed.innerHTML = `<div class="modal-box" style="width:460px"><div class="modal-header">
    <span class="modal-title">${idx!==null?'Edit':'New'} Action</span>
    <button class="btn-icon" onclick="document.getElementById('plugin-editor').remove()">✕</button></div>
    <div class="modal-body" style="display:flex;flex-direction:column;gap:10px">
      <div style="display:grid;grid-template-columns:60px 1fr;gap:10px">
        <label class="field-label">Icon<input id="pe-icon" class="text-input" value="${_escHtml(p.icon??'▶')}" maxlength="4"></label>
        <label class="field-label">Name<input id="pe-name" class="text-input" value="${_escHtml(p.name)}"></label></div>
      <label class="field-label">Command<input id="pe-cmd" class="text-input" value="${_escHtml(p.command)}" placeholder="e.g. zstd {path}">
        <div class="field-hint">Variables: {path} {name} {dir} {ext}</div></label>
      <label class="field-label">File pattern<input id="pe-match" class="text-input" value="${_escHtml(p.match??'*')}" placeholder="* for all files"></label>
      <div style="display:flex;flex-wrap:wrap;gap:14px">
        <label style="display:flex;align-items:center;gap:6px;font-size:13px"><input type="checkbox" id="pe-multi" ${p.multi?'checked':''}> Run per file</label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px"><input type="checkbox" id="pe-confirm" ${p.confirm?'checked':''}> Confirm first</label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px"><input type="checkbox" id="pe-notify" ${p.notify!==false?'checked':''}> Show toast</label></div>
      <div id="pe-error" style="color:var(--color-error);font-size:13px;display:none"></div></div>
    <div class="modal-footer">
      <button class="btn-ghost" onclick="document.getElementById('plugin-editor').remove()">Cancel</button>
      <button class="btn-primary" onclick="_savePlugin(${idx})">Save</button></div></div>`;
  document.body.appendChild(ed);
  document.getElementById('pe-name').focus();
};
window._savePlugin = async (idx) => {
  const name = document.getElementById('pe-name').value.trim();
  const command = document.getElementById('pe-cmd').value.trim();
  const errEl = document.getElementById('pe-error'); errEl.style.display='none';
  if (!name) { errEl.textContent='Name required'; errEl.style.display='block'; return; }
  if (!command) { errEl.textContent='Command required'; errEl.style.display='block'; return; }
  const plugin = { id: idx!==null?_plugins[idx].id:crypto.randomUUID(), name, icon: document.getElementById('pe-icon').value.trim()||'▶', match: document.getElementById('pe-match').value.trim()||'*', command, multi: document.getElementById('pe-multi').checked, confirm: document.getElementById('pe-confirm').checked, notify: document.getElementById('pe-notify').checked };
  if (idx!==null) _plugins[idx]=plugin; else _plugins.push(plugin);
  await invoke('save_plugins', {plugins: _plugins});
  document.getElementById('plugin-editor').remove();
  document.getElementById('plugin-manager').remove();
  showPluginManager();
};
window._deletePlugin = async (idx) => {
  _plugins.splice(idx,1);
  await invoke('save_plugins', {plugins: _plugins});
  document.getElementById('plugin-manager').remove();
  showPluginManager();
};

// ── Persistent settings ───────────────────────────────────────────────────────
// On startup, load settings from ~/.config/frostfinder/settings.json via Rust.
// On every write, flush back via set_settings(). This replaces localStorage for
// all ff_* keys so settings survive WebView profile resets and reinstalls.
// localStorage is used as a fast synchronous read-cache; Rust is the source of truth.

let _settingsLoaded = false;

async function loadPersistentSettings() {
  try {
    const saved = await invoke('get_settings');
    if (saved && typeof saved === 'object') {
      if (saved._reset === true) {
        setTimeout(() => showToast(t('toast.settings_reset'), 'warn'), 1200);
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

async function persistSettings() {
  if (!_settingsLoaded) return; // don't overwrite with empty on startup race
  try {
    // Collect all ff_* keys from localStorage into one object
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

// Patch localStorage.setItem to auto-persist any ff_* key change
(function patchLocalStorage() {
  const _orig = localStorage.setItem.bind(localStorage);
  localStorage.setItem = function (k, v) {
    _orig(k, v);
    if (_settingsLoaded && k.startsWith('ff_')) {
      persistSettings();
    }
  };
})();


// ── Watch mode status indicator ───────────────────────────────────────────────
// Queries get_watch_mode after every watch_dir call and updates a small
// indicator in the status bar. "inotify" = live, "polling" = FUSE/network,
// "off" = no watcher.
let _watchMode = 'off';
async function _updateWatchIndicator() {
  try {
    _watchMode = await invoke('get_watch_mode');
  } catch { _watchMode = 'off'; }
  _renderWatchIndicator();
}
function _renderWatchIndicator() {
  let el = document.getElementById('watch-indicator');
  if (!el) {
    const status = document.getElementById('status');
    if (!status) return;
    el = document.createElement('span');
    el.id = 'watch-indicator';
    el.style.cssText = 'margin-left:10px;font-size:11px;opacity:0.55;font-family:var(--font-mono,monospace);';
    status.parentNode?.insertBefore(el, status.nextSibling);
  }
  const labels = {inotify:'● live', polling:'⏱ polling', off:''};
  el.textContent = labels[_watchMode] || '';
  el.title = _watchMode === 'polling'
    ? 'Network/FUSE mount — directory listing refreshes every 3 seconds'
    : _watchMode === 'inotify'
    ? 'Local filesystem — changes appear instantly via inotify'
    : '';
}


// ── Cheat sheet ──────────────────────────────────────────────────────────────
function showCheatSheet() {
  document.getElementById('ff-cheatsheet')?.remove();
  const kb = _getKeybindings();
  const categories = [...new Set(Object.values(kb).map(b => b.category))];
  
  let html = '';
  for (const cat of categories) {
    const rows = Object.values(kb).filter(b => b.category === cat);
    if (!rows.length) continue;
    html += `<div class="cs-category">
      <div class="cs-cat-title">${cat}</div>`;
    for (const def of rows) {
      const label = _keysLabel(def.keys);
      if (!label) continue;
      html += `<div class="cs-row">
        <span class="cs-label">${def.label}</span>
        <kbd class="cs-key">${label}</kbd>
      </div>`;
    }
    html += '</div>';
  }
  
  const overlay = document.createElement('div');
  overlay.id = 'ff-cheatsheet';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:9600;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7);backdrop-filter:blur(6px);';
  overlay.innerHTML = `
    <div style="background:#1a1a1d;border:1px solid rgba(255,255,255,.13);border-radius:16px;width:min(720px,94vw);max-height:88vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.85);">
      <div style="padding:18px 24px 14px;border-bottom:1px solid rgba(255,255,255,.07);display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">
        <div style="display:flex;align-items:center;gap:10px;">
          <svg viewBox="0 0 24 24" fill="none" stroke="#5b8dd9" stroke-width="2" style="width:20px;height:20px;">
            <rect x="2" y="4" width="20" height="16" rx="2"/>
            <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 16h8"/>
          </svg>
          <span style="font-size:15px;font-weight:600;color:#f1f5f9;">Keyboard Shortcuts</span>
        </div>
        <button id="cs-close" style="background:rgba(255,255,255,.07);border:none;border-radius:8px;color:#98989f;font-size:18px;width:30px;height:30px;cursor:pointer;display:flex;align-items:center;justify-content:center;">×</button>
      </div>
      <div style="overflow-y:auto;padding:16px 24px;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;">
        ${html}
      </div>
      <div style="padding:12px 24px;border-top:1px solid rgba(255,255,255,.07);font-size:11px;color:#636368;text-align:center;flex-shrink:0;">
        Press <kbd style="background:rgba(255,255,255,.1);padding:2px 6px;border-radius:4px;margin:0 2px;">Ctrl+/</kbd> to toggle · Customize in Settings
      </div>
    </div>`;
  document.body.appendChild(overlay);
  
  overlay.querySelector('#cs-close').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.addEventListener('keydown', e => { if (e.key === 'Escape') overlay.remove(); });
}

// Cheat sheet shortcut (Ctrl+/) is handled via _dispatchKbAction in setupKeyboard()

// ── i18n (lightweight) ───────────────────────────────────────────────────────
const RTL_LANGS = new Set(['ar', 'he', 'fa', 'ur', 'yi', 'dv', 'ps']);
let _locale = {};
async function initI18n() {
  const lang = (localStorage.getItem('ff_locale') ?? navigator.language ?? 'en').split('-')[0].toLowerCase();
  try { const r = await fetch(`/locales/${lang}.json`); if (r.ok) _locale = await r.json(); } catch {}
  if (!Object.keys(_locale).length) { try { const r = await fetch('/locales/en.json'); if (r.ok) _locale = await r.json(); } catch {} }
  // Propagate resolved locale to date formatter in utils.js
  setDateLocale(lang);
  // Apply RTL direction for right-to-left languages
  document.documentElement.dir = RTL_LANGS.has(lang) ? 'rtl' : 'ltr';
}
function t(key, vars = {}) {
  let k = key;
  if (('count' in vars || 'n' in vars) && _locale[key+'_plural']) { const n = vars.count ?? vars.n; if (n !== 1) k = key+'_plural'; }
  let s = _locale[k] ?? _locale[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_,v) => v in vars ? String(vars[v]) : `{${v}}`);
}

// ── Boot: load plugins ────────────────────────────────────────────────────────
loadPlugins();
