import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow as _getAppWindow } from '@tauri-apps/api/window';
const appWindow = _getAppWindow();
import { listen } from '@tauri-apps/api/event';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { writeTextFile } from '@tauri-apps/plugin-fs';
import {
  I, IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS, DOC_EXTS, OFFICE_EXTS, BOOK_EXTS, PDF_EXTS, ARCHIVE_EXTS, ISO_EXTS,
  fileColor, fileIcon, driveIcon, driveColor, favIcon, favColor, fmtDriveSpace,
  fmtSize, fmtDate, escHtml, mimeLabel,
  setRenderCallback, setIconTheme, showIconThemePicker, driveTypeBadge,
  getBookmarks, addBookmark, removeBookmark, isBookmarked
} from './utils.js';
import {
  injectDeps, renderView, renderColumnView, renderListView, renderIconView,
  renderGalleryView, renderFlatList, renderPreview, renderStatus,
  startAudioVisualizer, openQuickLook, quickLookNavigate, isQLOpen, closeQuickLook, initQuickLook
} from './views.js';

// ── Sidebar operation progress bar ────────────────────────────────────────────
// A single shared progress indicator anchored to the bottom of the sidebar.
// Replaces the old per-operation toast bars for copy/move/paste/empty-trash.
// Usage:
//   _sbProgress.start('Copying', total)   — show bar, set label
//   _sbProgress.update(done, total, label) — advance bar + percentage
//   _sbProgress.finish(success)           — flash green/red, then hide
const _sbProgress = (() => {
  const _wrap  = () => document.getElementById('sb-ops-progress');
  const _bar   = () => document.getElementById('sb-ops-bar');
  const _label = () => document.getElementById('sb-ops-label');
  const _pct   = () => document.getElementById('sb-ops-pct');
  let _hideTimer = null;

  function show() {
    const w = _wrap(); if (!w) return;
    clearTimeout(_hideTimer);
    _bar()?.classList.remove('green', 'red');
    w.style.display = '';
    requestAnimationFrame(() => w.classList.add('visible'));
  }

  function hide(delay = 1200) {
    const w = _wrap(); if (!w) return;
    clearTimeout(_hideTimer);
    _hideTimer = setTimeout(() => {
      w.classList.remove('visible');
      // Wait for transition before hiding completely
      setTimeout(() => { if (w) w.style.display = 'none'; }, 220);
    }, delay);
  }

  return {
    start(label, total) {
      show();
      const l = _label(); if (l) l.textContent = label;
      const b = _bar();   if (b) b.style.width = '0%';
      const p = _pct();   if (p) p.textContent = '0%';
    },

    update(done, total, label) {
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      const b = _bar();   if (b) b.style.width = pct + '%';
      const p = _pct();   if (p) p.textContent = pct + '%';
      if (label) { const l = _label(); if (l) l.textContent = label; }
    },

    finish(success = true, msg = '') {
      const b = _bar(); if (b) { b.style.width = '100%'; b.classList.add(success ? 'green' : 'red'); }
      const p = _pct(); if (p) p.textContent = '100%';
      if (msg) { const l = _label(); if (l) l.textContent = msg; }
      hide(success ? 1400 : 2800);
    },

    error(msg) {
      const l = _label(); if (l) l.textContent = msg;
      const b = _bar(); if (b) b.classList.add('red');
      hide(3000);
    }
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

  // ── Core logger ─────────────────────────────────────────────────────────────
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
    hdr.innerHTML ='\n      <span style="color:#4af;font-weight:bold;font-size:12px">FF Log</span>\n      <input id="ff-filter" placeholder="filter events..." style="flex:1;background:#222;border:1px solid #444;color:#ddd;padding:2px 6px;font:11px monospace;border-radius:3px"/>\n      <button id="ff-pause" style="background:#2a2a2a;border:1px solid #444;color:#ddd;padding:2px 8px;cursor:pointer;border-radius:3px;font:11px monospace">⏸</button>\n      <button id="ff-clear" style="background:#2a2a2a;border:1px solid #444;color:#ddd;padding:2px 8px;cursor:pointer;border-radius:3px;font:11px monospace">🗑</button>\n      <button id="ff-dl" style="background:#2a2a2a;border:1px solid #444;color:#ddd;padding:2px 8px;cursor:pointer;border-radius:3px;font:11px monospace">💾</button>\n      <button id="ff-close" style="background:#2a2a2a;border:1px solid #444;color:#f44;padding:2px 8px;cursor:pointer;border-radius:3px;font:11px monospace">✕</button>\n    ';
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

  return { log, show, hide, toggle, download };
})();

window.FF = FF; // expose to console: FF.show(), FF.download()


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
    '_fileTags','_allTags','_tagColors','activeTag','_undoStack','_redoStack'];
  for(const k of keys)ts[k]=state[k];
  const tab=getActiveTab();
  tab.label=state.currentPath?state.currentPath.split('/').filter(Boolean).pop()||state.currentPath:'New Tab';
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
    saveSortState();_tbFp='';pop.remove();render();
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
        state.currentPath=path; state.selIdx=-1; state.gallerySelIdx=-1;
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
      // ── Non-streaming path (list/gallery/icon need full stat metadata) ──────
      const result=await listDirectoryFull(path);
      const elapsed=Math.round(performance.now()-t0);

      if(mySeq!==_navSeq){FF.log('NAV_STALE',{seq:mySeq,path,elapsed,currentSeq:_navSeq});return;}
      FF.log('NAV_RESOLVED',{seq:mySeq,path,elapsed,count:result.entries?.length});

      state.currentPath=path; state.selIdx=-1; state.gallerySelIdx=-1;
      if(addHistory){
        state.history.splice(state.historyIdx+1);
        state.history.push(path);
        state.historyIdx=state.history.length-1;
      }
      let entries=result.entries;
      if(entries.length>500) entries=await sortEntriesAsync(entries);
      state.columns=[{path,entries,selIdx:-1,_fp:_colFpFull(entries)}];
      loadTagsForEntries(entries).catch(()=>{});
      FF.log('NAV_RENDER',{seq:mySeq,path,cols:state.columns.length,entries:entries.length});
    }

  }catch(e){
    FF.log('NAV_ERROR',{seq:mySeq,path,error:String(e)});
    const errStr=String(e);
    if(errStr.includes('PERMISSION_DENIED')||errStr.includes('Permission denied'))
      showPermissionDialog(path);
    else showToast('Error: '+e,'error');
  } finally {
    state.loading=false; syncState(); render();
    // Only watch the path that won the race — stale navigates must not clobber the watcher.
    if(mySeq===_navSeq) invoke('watch_dir', {paths: [...new Set([...state.columns.map(c=>c.path), path])]}).catch(()=>{});
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
  }catch(e){showToast('Refresh failed: '+e,'error'); anyChanged = true;}
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
      }catch(_){}
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
  document.getElementById('perm-ok')?.addEventListener('click',()=>{d.remove();invoke('open_as_root',{path}).catch(err=>showToast('Root access failed: '+err,'error'));});
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
      if(state.search){const q=state.search.toLowerCase();e=e.filter(x=>x.name.toLowerCase().includes(q));}
      const s=sortEntries(e);sel._e=s;return s;
    }
  }
  sel._e=[];return[];
}
const getCurrentEntries=getVisibleEntries;

// ── Clipboard ─────────────────────────────────────────────────────────────────
function clipboardCopy(entries){state.clipboard={entries:[...entries],op:'copy'};showToast(`${entries.length} item${entries.length>1?'s':''} copied`,'info');}
function clipboardCut(entries){state.clipboard={entries:[...entries],op:'cut'};showToast(`${entries.length} item${entries.length>1?'s':''} cut`,'info');}
async function clipboardPaste(){
  if(!state.clipboard.entries.length)return;
  const dest=state.currentPath;
  const op=state.clipboard.op;
  const srcs=state.clipboard.entries.map(e=>e.path);
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
  unlisten=await listen('file-op-progress', ev=>{
    const {done:d,total:t,name,error,finished}=ev.payload;
    const entry=entries[d-1];
    if(!error && entry){
      const dstPath=dest+'/'+entry.name;
      undoItems.push({src:entry.path,dst:dstPath,
        srcDir:entry.path.substring(0,entry.path.lastIndexOf('/')),dstDir:dest});
    }
    if(error) errors.push(`${name}: ${error}`);
    _sbProgress.update(d, t, (op==='cut'?'Moving':'Copying') + ' ' + d + ' / ' + t);
    if(finished) _pasteUnlisten();
  });

  // ── Fire the batch command (returns immediately; work happens in Rust thread)
  const cmd=op==='cut'?'move_files_batch':'copy_files_batch';
  invoke(cmd,{srcs,destDir:dest}).catch(err=>showToast('Batch op failed: '+err,'error'));

  await done;
  if(unlisten) unlisten();

  // ── Finish sidebar progress bar ─────────────────────────────────────────
  const hadErrors = errors.length > 0;
  _sbProgress.finish(!hadErrors, hadErrors ? errors[0] : (op==='cut'?'Move':'Copy')+' complete');

  if(undoItems.length) pushUndo({op:op==='cut'?'move':'copy',items:undoItems});
  if(op==='cut') state.clipboard={entries:[],op:'copy'};

  if(errors.length) errors.forEach(e=>showToast(`Failed: ${e}`,'error'));
  const ok=total-errors.length;
  if(ok>0) showToast(`${ok} item${ok>1?'s':''} ${op==='cut'?'moved':'copied'}`,'success');
  await refreshColumns();
}

// ── Context menu ──────────────────────────────────────────────────────────────
function showContextMenu(x,y,items){
  closeContextMenu();
  const menu=document.createElement('div');menu.id='ctx-menu';
  menu.style.cssText=`position:fixed;left:${x}px;top:${y}px;z-index:9000;`;
  for(const item of items){
    if(item==='-'){const sep=document.createElement('div');sep.className='ctx-sep';menu.appendChild(sep);continue;}
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
          const entry=item.entry;
          const curTags=state._fileTags?.[entry.path]||[];
          const newTags=curTags.includes(tag)?curTags.filter(t=>t!==tag):[...curTags,tag];
          await invoke('set_tag_color',{tag,color});
          await invoke('set_file_tags',{path:entry.path,tags:newTags});
          if(!state._fileTags)state._fileTags={};
          state._fileTags[entry.path]=newTags;
          if(!state._tagColors)state._tagColors={};
          state._tagColors[tag]=color;
          state._allTags=[...new Set([...state._allTags,tag])];
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
    el.className='ctx-item'+(item.disabled?' disabled':'');
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
  switch(action){
    case 'open':{const e=getSelectedEntry();if(e){if(e.is_dir)navigate(e.path,0);else invoke('open_file',{path:e.path}).catch(()=>{});}break;}
    case 'copy':{const es=getSelectedEntries();if(es.length)clipboardCopy(es);break;}
    case 'cut':{const es=getSelectedEntries();if(es.length)clipboardCut(es);break;}
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
    case 'copy-path':{const e=getSelectedEntry();if(e)navigator.clipboard.writeText(e.path).then(()=>showToast('Path copied','info')).catch(()=>showToast(e.path,'info'));break;}
    case 'add-sidebar':{const e=getSelectedEntry();if(e&&e.is_dir)addSidebarFav(e.path,e.name);break;}
    case 'open-terminal':{const e=getSelectedEntry();const p=e?.is_dir?e.path:state.currentPath;invoke('open_terminal',{path:p}).catch(err=>showToast('Terminal: '+err,'error'));break;}
    case 'open-editor':{const e=getSelectedEntry();if(e&&!e.is_dir)invoke('open_in_editor',{path:e.path}).catch(err=>showToast('Editor: '+err,'error'));break;}
    case 'open-with':{const e=getSelectedEntry();if(e&&!e.is_dir)showOpenWithDialog(e);break;}
    // New: Bookmarks
    case 'add-bookmark':{
      const e=getSelectedEntry();
      if(e&&e.is_dir){
        addBookmark(e.path,e.name);
        showToast('Bookmark added','success');
        render();
      }
      break;
    }
    case 'remove-bookmark':{
      const e=getSelectedEntry();
      if(e&&e.is_dir){
        removeBookmark(e.path);
        showToast('Bookmark removed','info');
        render();
      }
      break;
    }
    // New: Find Duplicates
    case 'find-duplicates':{
      const e=getSelectedEntry();
      if(e&&e.is_dir){
        showToast('Scanning for duplicates in '+e.name+'…','info');
        invoke('find_duplicates',{rootPath:e.path,recursive:true})
          .then(dups=>{
            if(!dups||dups.length===0){
              showToast('No duplicates found','info');
            }else{
              showToast('Found '+dups.length+' sets of duplicates','success');
              console.log('Duplicates:',dups);
              // TODO: Show duplicates in a results panel
            }
          })
          .catch(err=>showToast('Find duplicates failed: '+err,'error'));
      }
      break;
    }
    // New: Secure Delete
    case 'secure-delete':{
      const e=getSelectedEntry();
      if(e&&!e.is_dir){
        if(!confirm('SECURE DELETE: This file will be permanently overwritten and cannot be recovered!\n\nFile: '+e.name+'\n\nAre you sure?'))break;
        const passes=3;
        showToast('Securely deleting '+e.name+'…','warn');
        invoke('secure_delete',{paths:[e.path],passes})
          .then(()=>{
            showToast('File securely deleted','success');
            refreshColumns();
          })
          .catch(err=>showToast('Secure delete failed: '+err,'error'));
      }
      break;
    }
    case 'compress':{const es=getSelectedEntries();if(es.length)compressEntries(es);break;}
    case 'extract':{const e=getSelectedEntry();if(e)extractArchive(e);break;}
    case 'mount-iso':{
      const e=getSelectedEntry();
      if(e){
        showToast('Mounting '+e.name+'…','info');
        invoke('mount_iso',{path:e.path})
          .then(mp=>{
            showToast('Mounted at '+mp,'success');
            invoke('get_drives').then(d=>{state.sidebarData.drives=d;renderSidebar();});
            if(mp)navigate(mp,0);
          })
          .catch(err=>showToast('Mount failed: '+err,'error'));
      }
      break;
    }
    case 'burn-iso':{
      const e=getSelectedEntry();
      if(e){
        invoke('list_usb_drives').then(drives=>{
          if(!drives||drives.length===0){showToast('No removable USB drives detected. Plug in a USB drive.','error');return;}
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
        }).catch(err=>showToast('Cannot list drives: '+err,'error'));
      }
      break;
    }
    case 'empty-trash':{
      if(!confirm('Permanently delete all items in Trash? This cannot be undone.'))break;
      _emptyTrashWithProgress().catch(err=>showToast('Empty Trash failed: '+err,'error'));
      break;
    }
  }
}

// ── Open With dialog ─────────────────────────────────────────────────────────
async function showOpenWithDialog(entry){
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
  catch(err){showToast('Could not list apps: '+err,'error');close();return;}

  const listEl=overlay.querySelector('#ow-list');
  const render=filter=>{
    const q=(filter||'').toLowerCase().trim();
    const shown=q?allApps.filter(a=>a.name.toLowerCase().includes(q)):allApps;
    if(!shown.length){listEl.innerHTML='<div class="ow-empty">No applications found</div>';return;}
    listEl.innerHTML='';
    for(const app of shown){
      const row=document.createElement('div');
      row.className='ow-row';
      row.innerHTML=`<span class="ow-app-icon">${buildAppIconHtml(app.icon)}</span><span class="ow-app-name">${escHtml(app.name)}</span>`;
      row.addEventListener('click',async()=>{
        close();
        try{await invoke('open_with_app',{path:entry.path,exec:app.exec});}
        catch(err){showToast('Failed to open: '+err,'error');}
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
    ...((!multi&&!entry.is_dir)?[{label:'Open With…',action:'open-with',icon:I.openExt,entry}]:[]),
    '-',
    {label:'Cut',action:'cut',icon:I.scissors,shortcut:'Ctrl+X'},
    {label:'Copy',action:'copy',icon:I.copy,shortcut:'Ctrl+C'},
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
  if(!confirm(`Move ${entries.length} item${entries.length>1?'s':''} to Trash?`))return;
  const total=entries.length;
  const paths=entries.map(e=>e.path);
  const deleted=[];
  const errors=[];

  // Wire delete-progress -> sidebar progress bar before firing command
  let _delUnlisten;
  _sbProgress.start(`Moving to Trash\u2026 0 / ${total}`, total);
  _delUnlisten = await listen('delete-progress', ev=>{
    const {name,done,total:t,finished,error}=ev.payload;
    if(error) errors.push(`${name}: ${error}`);
    if(finished){ _delUnlisten?.(); return; }
    _sbProgress.update(done, t, `Moving to Trash ${done} / ${t}`);
  });

  try {
    await invoke('delete_items_stream', {paths, trash:true});
  } catch(err) {
    errors.push(String(err));
  }
  _delUnlisten?.();

  // Build undo list from entries that weren't errored
  for(const e of entries){
    if(!errors.some(er=>er.startsWith(e.name+':')))
      deleted.push({src:e.path, oldName:e.name,
        srcDir:e.path.substring(0,e.path.lastIndexOf('/'))});
  }

  const ok = total - errors.length;
  const hadErrors = errors.length > 0;
  _sbProgress.finish(!hadErrors, hadErrors ? errors[0] : `${ok} item${ok!==1?'s':''} moved to Trash`);
  if(hadErrors) errors.forEach(e=>showToast(`Failed: ${e}`,'error'));

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
    showToast(`Created: ${name}`,'success');
    pushUndo({op:'create',items:[{dst:destPath,
      srcDir:state.currentPath, newName:name}]});
    refreshColumns();
  }).catch(e=>showToast('Error: '+e,'error'));
}
function promptCreateDoc(docType,ext){
  const name=prompt(`New ${docType} file:`,'untitled'+ext);
  if(!name)return;
  const finalName=name.endsWith(ext)?name:name+ext;
  const destPath=state.currentPath+'/'+finalName;
  invoke('create_new_document',{path:state.currentPath,name:finalName,docType}).then(()=>{
    showToast(`Created: ${finalName}`,'success');
    pushUndo({op:'create',items:[{dst:destPath,
      srcDir:state.currentPath, newName:finalName}]});
    refreshColumns();
  }).catch(e=>showToast('Error: '+e,'error'));
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
      }).catch(e=>showToast('Rename failed: '+e,'error'));
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
    }catch(e){showToast('Rename: '+e,'error');el.textContent=oldText;}}else{el.textContent=oldText;}}else{el.textContent=oldText;}
  };
  el.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();finish(true);}if(e.key==='Escape'){e.preventDefault();finish(false);}e.stopPropagation();});
  el.addEventListener('blur',()=>finish(true),{once:true});
}

// ── Compression / Extraction ──────────────────────────────────────────────────
async function compressEntries(entries){
  const name=prompt('ZIP file name:',entries.length===1?entries[0].name+'.zip':'archive.zip');
  if(!name)return;
  const finalName=name.endsWith('.zip')?name:name+'.zip';
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
    const result=await invoke('compress_files',{paths:entries.map(e=>e.path),outputPath});
    showToast('Compressed ' + result.file_count + ' file' + (result.file_count===1?'':'s') + ' → ' + finalName,'success');
    await refreshColumns();
  }catch(e){
    _sbProgress.error('Compress failed: '+e);
    showToast('Compress failed: '+e,'error');
  }finally{
    unlisten?.();
  }
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
    showToast('Extracted ' + count + ' item' + (count===1?'':'s') + ' \u2192 ' + destDir.split('/').pop(),'success');
    await refreshColumns();
  }catch(e){
    _sbProgress.error('Extract failed: '+e);
    showToast('Extract failed: '+e,'error');
  }finally{
    unlisten?.();
    // Restore bar transition
    const b = document.getElementById('sb-ops-bar');
    if (b) b.style.transition = '';
  }
}
// ── Drag & Drop ───────────────────────────────────────────────────────────────
let dragState={entries:[],srcPath:''};
function setupDragDrop(el,entry,entries){
  el.draggable=true;
  el.addEventListener('dragstart',e=>{
    const dragging=sel.size>0&&sel.has(+el.dataset.idx)?getSelectedEntries():[entry];
    const firstEntry=dragging[0]||entry;
    const srcDir=firstEntry.path.includes('/')?firstEntry.path.slice(0,firstEntry.path.lastIndexOf('/'))||'/':'/';
    window.FF?.log('DRAG_START',{name:entry.name,count:dragging.length,srcDir});
    dragState={entries:dragging,srcPath:srcDir};
    e.dataTransfer.effectAllowed='copyMove';
    e.dataTransfer.setData('text/plain',dragging.map(x=>x.path).join('\n'));
    el.classList.add('dragging');
    if(dragging.length>1){const g=document.createElement('div');g.className='drag-ghost';g.textContent=`${dragging.length} items`;document.body.appendChild(g);e.dataTransfer.setDragImage(g,0,0);requestAnimationFrame(()=>g.remove());}
  });
  el.addEventListener('dragend',()=>el.classList.remove('dragging'));
}
function setupDropTarget(el,destPath){
  el.addEventListener('dragover',e=>{e.preventDefault();e.stopPropagation();e.dataTransfer.dropEffect=e.altKey?'copy':'move';el.classList.add('drop-over');});
  // Only remove drop-over when the cursor actually leaves this element — not when
  // it moves into a child node (.fico, .fname, .fchev etc. inside a frow).
  // Without this check, every span boundary fires dragleave and the highlight flickers
  // making it impossible to reliably drop onto directory rows or column lists.
  el.addEventListener('dragleave',e=>{
    if(!e.relatedTarget||!el.contains(e.relatedTarget)) el.classList.remove('drop-over');
  });
  el.addEventListener('drop',async e=>{
    e.preventDefault();e.stopPropagation();el.classList.remove('drop-over');
    window.FF?.log('DROP',{destPath,count:dragState.entries.length,op:e.altKey?'copy':'move'});
    if(!dragState.entries.length)return;
    // Prevent dropping onto the exact same directory the files came from
    const srcPath=dragState.srcPath;
    if(destPath===srcPath)return;
    // Prevent dropping a dragged FOLDER into itself or any of its own descendants.
    // IMPORTANT: do NOT compare destPath against srcPath with startsWith — srcPath is
    // the parent directory of the dragged file, so that check would block every drop
    // onto a sibling subfolder (e.g. dragging Documents/file.txt into Documents/Projects/).
    if(dragState.entries.some(en=>en.is_dir&&(destPath===en.path||destPath.startsWith(en.path+'/'))))return;
    const op=e.altKey?'copy':'move';
    const srcs=dragState.entries.map(en=>en.path);
    const total=srcs.length;
    dragState={entries:[],srcPath:''};
    const cmd=op==='copy'?'copy_files_batch':'move_files_batch';
    _sbProgress.start((op==='copy'?'Copying':'Moving')+' 0 / '+total, total);
    // ── Single listener handles both progress display AND undo tracking ──────────
    // Combining into one listener avoids a second IPC round-trip and ensures
    // undo items are built atomically with the progress update.
    let ddErrors=0;
    const ddUndoItems=[];
    let _ddResolve;
    const ddDone=new Promise(resolve=>{_ddResolve=resolve;});
    const ddUnlisten=await listen('file-op-progress',ev=>{
      const {done:d,total:t,name,error,finished}=ev.payload;
      if(error){ ddErrors++; }
      else {
        // Track destination for undo (index d-1 = 0-based file index)
        const src=srcs[d-1];
        if(src){
          ddUndoItems.push({src,dst:destPath+'/'+src.split('/').pop(),
            srcDir:src.substring(0,src.lastIndexOf('/')),dstDir:destPath});
        }
      }
      _sbProgress.update(d,t,(op==='copy'?'Copying':'Moving')+' '+d+' / '+t);
      if(finished)_ddResolve();
    });
    invoke(cmd,{srcs,destDir:destPath}).catch(err=>{showToast('Drop failed: '+err,'error');_ddResolve();});
    await ddDone;
    ddUnlisten();
    _sbProgress.finish(ddErrors===0,ddErrors>0?ddErrors+' error(s)':(op==='copy'?'Copy':'Move')+' complete');
    const ok=total-ddErrors;
    if(ok>0){
      showToast(`${ok} item${ok>1?'s':''} ${op==='copy'?'copied':'moved'}`,'success');
      if(ddUndoItems.length) pushUndo({op:op==='copy'?'copy':'move',items:ddUndoItems});
    }
    if(ddErrors>0)showToast(`${ddErrors} item${ddErrors>1?'s':''} failed`,'error');
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
    const result=await invoke('deep_search',{
      root:searchRoot, query, includeHidden:state.showHidden, maxResults:2000
    });
    if(thisGen!==_searchGen)return; // superseded by a newer keystroke
    // Deduplicate by path (parallel search can return same file from multiple top-dirs)
    const seen=new Set();
    state.searchResults=result.entries.filter(e=>seen.has(e.path)?false:(seen.add(e.path),true));
    // Note: results are pre-sorted by name in Rust — no JS re-sort needed
    if(result.truncated)showToast(`Showing first 2000 of many results`,'info');
  }catch(e){if(thisGen===_searchGen)showToast('Search error: '+e,'error');}
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
    // Icon/list/flat: single-click only selects — navigate on dblclick instead.
    if(state.viewMode==='column'&&sel.size===1&&!isMulti){
      await navigate(entry.path,state.columns.length);
    }
  } else {
    await loadPreview(entry);
  }
  render();
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
async function loadSidebar(){
  try{state.sidebarData=await invoke('get_sidebar_data');}catch(e){console.error(e);}
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
  if(favs.find(f=>f.path===path)){showToast('Already in sidebar','info');return;}
  const label=name||(path.split('/').filter(Boolean).pop()||path);
  favs.push({name:label,path});saveSidebarFavs(favs);renderSidebar();showToast(`"${label}" added to sidebar`,'success');
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
    showToast(`Trash emptied (${n} item${n===1?'':'s'} deleted)`, 'success');
    await refreshColumns();
  } catch(err) {
    _sbProgress.error('Empty trash failed: ' + err);
    throw err;
  } finally {
    unlisten?.();
  }
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
      const isEncrypted = d.filesystem==='crypto_LUKS'||d.filesystem==='crypto_BITLK'||d.filesystem==='BitLocker';
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
    el.innerHTML='\n    <div class="sb-section">\n      <div class="sb-title">Favorites<div class="sb-size-ctrl"><button class="sb-size-btn" id="sb-size-dec" title="Smaller">−</button><button class="sb-size-btn" id="sb-size-inc" title="Larger">+</button></div></div>\n      ' + (allFavs.map(f=>`
        <div class="sb-item ${state.activeSb===f.path?'active':''}" data-path="${f.path.replace(/"/g,'&quot;')}">
          <span class="sb-ico" style="color:${state.activeSb===f.path?'#fff':favColor(f.icon)}">${favIcon(f.icon)}</span>
          <span class="sb-lbl">${f.name}</span>
          ${!f.builtin?`<button class="sb-rm-btn" data-rmpath="${f.path.replace(/"/g,'&quot;')}" title="Remove">×</button>`:''}
        </div>`).join('')) + '\n    </div>\n    ' + (drivesHtml) + '\n    ' + (tagsSectionHtml);

  document.getElementById('sb-size-inc')?.addEventListener('click',e=>{
    e.stopPropagation();state.sidebarScale=Math.min(1.4,state.sidebarScale+0.1);applySidebarScale();
  });
  document.getElementById('sb-size-dec')?.addEventListener('click',e=>{
    e.stopPropagation();state.sidebarScale=Math.max(0.75,state.sidebarScale-0.1);applySidebarScale();
  });
  el.querySelectorAll('.sb-rm-btn').forEach(btn=>{btn.addEventListener('click',e=>{e.stopPropagation();removeSidebarFav(btn.dataset.rmpath);});});
  el.querySelectorAll('.eject-btn').forEach(btn=>{
    btn.addEventListener('click',async e=>{
      e.stopPropagation();
      try{await invoke('eject_drive',{mountpoint:btn.dataset.mountpoint,device:btn.dataset.device});showToast('Ejected','success');setTimeout(()=>invoke('get_drives').then(d=>{state.sidebarData.drives=d;renderSidebar();}),800);}
      catch(err){showToast('Eject failed: '+err,'error');}
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

      showToast('Mounting '+device+'…','info');
      try{
        const mountpoint=await invoke('mount_drive',{device});
        showToast('Mounted at '+mountpoint,'success');
        const drives=await invoke('get_drives');
        state.sidebarData.drives=drives;
        state.activeSb=mountpoint;
        renderSidebar();
        if(mountpoint)navigate(mountpoint,0);
      }catch(err){showToast('Mount failed: '+err,'error');}
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
        showToast('Unlocked & mounted at ' + (mountpoint||device), 'success');
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
      }catch(err){showToast('Tag search failed: '+err,'error');}
      finally{state.loading=false;syncState();render();renderSidebar();}
    });
  });
  el.querySelectorAll('.sb-item:not(.sb-tag-item)').forEach(item=>{
    setupDropTarget(item,item.dataset.path);
  });
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
}

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
  document.getElementById('toolbar').innerHTML='\n    <button class="nav-btn ' + (canBack?'':'dim') + '" id="btn-back">' + (I.back) + '</button>\n    <button class="nav-btn ' + (canFwd?'':'dim') + '" id="btn-fwd">' + (I.fwd) + '</button>\n    <div class="breadcrumb" id="bc-rail">' + buildBreadcrumbHtml(state,parts) + '</div>\n    <div class="tb-actions"><button class="tb-btn" title="Debug Log (Ctrl+Shift+L)" onclick="FF.toggle()" style="font-size:10px;opacity:0.6">🪲</button>\n      ' + (state.loading?`<span class="tb-spinner"><div class="spinner" style="width:14px;height:14px;border-width:1.5px"></div></span>`:'') + '\n      <div class="tb-new-wrap">\n        <button class="tb-btn" id="btn-new" title="New...">' + (I.plus) + '</button>\n        <div class="tb-new-dropdown" id="new-dropdown" style="display:none">\n          <div class="nd-item" data-action="new-folder">' + (I.folderPlus) + ' New Folder</div>\n          <div class="nd-item" data-action="new-file">' + (I.filePlus) + ' New Empty File</div>\n          <div class="nd-sep"></div>\n          <div class="nd-item" data-action="new-md">' + (I.doc) + ' Markdown (.md)</div>\n          <div class="nd-item" data-action="new-html">' + (I.code) + ' HTML (.html)</div>\n          <div class="nd-item" data-action="new-py">' + (I.code) + ' Python (.py)</div>\n          <div class="nd-item" data-action="new-sh">' + (I.code) + ' Shell (.sh)</div>\n        </div>\n      </div>\n      <button class="tb-btn" id="btn-terminal" title="Open Terminal Here">' + (I.terminal) + '</button>\n      <div class="view-switcher">\n        ' + ([{id:'icon',icon:I.iconView},{id:'list',icon:I.listView},{id:'column',icon:I.colView},{id:'gallery',icon:I.galleryView}]
          .map(v=>`<button class="vbtn ${state.viewMode===v.id?'active':''}" data-view="${v.id}">${v.icon}</button>`).join('')) + '\n      </div>\n      <div class="size-slider-wrap" title="Icon & text size">\n        <svg viewBox="0 0 16 16" fill="currentColor" style="width:10px;height:10px;opacity:.5"><rect x="2" y="5" width="6" height="6" rx="1"/></svg>\n        <input type="range" class="size-slider" id="size-slider" min="28" max="120" value="' + (state.iconSize) + '"/>\n        <svg viewBox="0 0 16 16" fill="currentColor" style="width:15px;height:15px;opacity:.5"><rect x="1" y="2" width="10" height="10" rx="1.5"/></svg>\n      </div>\n      <button class="tb-btn" id="btn-sort" title="Sort options"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" style="width:14px;height:14px"><line x1="2" y1="4" x2="13" y2="4"/><line x1="2" y1="8" x2="9" y2="8"/><line x1="2" y1="12" x2="5" y2="12"/></svg></button>\n      <button class="tb-btn" id="btn-icon-theme" title="Icon theme"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:14px;height:14px"><circle cx="5" cy="8" r="2.5"/><circle cx="11" cy="5" r="2"/><circle cx="11" cy="11" r="2"/><line x1="7.5" y1="8" x2="9" y2="5.8"/><line x1="7.5" y1="8" x2="9" y2="10.2"/></svg></button>\n      <button class="tb-btn ' + (state.showHidden?'active':'') + '" id="btn-eye">' + (I.eye) + '</button>\n      <div class="search-wrap">\n        <span class="search-ico">' + (I.search) + '</span>\n        <input class="search-input" id="search-in" placeholder="Search everywhere..." value="' + (state.searchMode?state.searchQuery:state.search) + '"/>\n        <button class="search-clear-btn" id="search-clear" title="Clear search">&#x2715;</button>\n      </div>\n    </div>';

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
    invoke('open_terminal',{path:state.currentPath}).catch(err=>showToast('Terminal: '+err,'error'));
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
    btn.addEventListener('click',async()=>{
      const m=btn.dataset.view;if(m===state.viewMode)return;
      // Preserve selection & focused item — only clear gallerySelIdx
      const savedPaths=[...sel._paths];
      const savedSelIdx=state.selIdx>=0?state.selIdx:(sel.last>=0?sel.last:-1);
      state.viewMode=m;state.gallerySelIdx=-1;localStorage.setItem('ff_viewMode',m);
      if(m==='column'){state.columns=[];await navigate(state.currentPath,0,false);}
      else{
        if(!state.columns.length||state.columns[state.columns.length-1].path!==state.currentPath){
          try{const r=await listDirectoryFull(state.currentPath);state.columns=[{path:state.currentPath,entries:r.entries,selIdx:-1}];}catch(e){}
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

}

// ── Toast ─────────────────────────────────────────────────────────────────────
function showToast(msg,type='info'){
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
  document.querySelector('.titlebar')?.addEventListener('mousedown',e=>{if(e.target.closest('.wm-btns'))return;appWindow.startDragging();});
  document.querySelector('.titlebar')?.addEventListener('dblclick',e=>{if(e.target.closest('.wm-btns'))return;invoke('window_maximize');});
}

// ── Keyboard ──────────────────────────────────────────────────────────────────
// ── Undo / Redo ───────────────────────────────────────────────────────────────
function pushUndo(op){ state._undoStack.push(op); if(state._undoStack.length>50)state._undoStack.shift(); state._redoStack=[]; }
async function undoLastOp(){
  const op=state._undoStack.pop(); if(!op){showToast('Nothing to undo','info');return;}
  state._redoStack.push(op);
  try{
    for(const item of [...op.items].reverse()){
      if(op.op==='move'){ await invoke('move_file',{src:item.dst,destDir:item.srcDir}); }
      else if(op.op==='copy'){ await invoke('delete_items',{paths:[item.dst]}); }
      else if(op.op==='delete'){ /* can't undelete from trash easily — show message */ showToast('Cannot undo delete','warning'); return; }
      else if(op.op==='rename'){ await invoke('rename_file',{oldPath:item.dst,newName:item.oldName}); }
      else if(op.op==='create'){ await invoke('delete_items',{paths:[item.dst]}); }
    }
    showToast('Undone','success'); await refreshColumns();
  }catch(err){showToast('Undo failed: '+err,'error');}
}
async function redoLastOp(){
  const op=state._redoStack.pop(); if(!op){showToast('Nothing to redo','info');return;}
  state._undoStack.push(op);
  try{
    for(const item of op.items){
      if(op.op==='move'){ await invoke('move_file',{src:item.src,destDir:item.dstDir}); }
      else if(op.op==='copy'){ await invoke('copy_file',{src:item.src,destDir:item.dstDir}); }
      else if(op.op==='rename'){ await invoke('rename_file',{oldPath:item.src,newName:item.newName}); }
      else if(op.op==='create'){ /* re-create not supported */ showToast('Cannot redo create','warning'); return; }
    }
    showToast('Redone','success'); await refreshColumns();
  }catch(err){showToast('Redo failed: '+err,'error');}
}

function setupKeyboard(){
  document.addEventListener('keydown',async e=>{
    const tag=document.activeElement?.tagName?.toLowerCase();
    const isInput=tag==='input'||tag==='textarea'||document.activeElement?.contentEditable==='true';
    if((e.ctrlKey||e.metaKey)&&e.key==='t'){e.preventDefault();newTab();return;}
    if((e.ctrlKey||e.metaKey)&&e.key==='w'){e.preventDefault();closeTab(activeTabId);return;}
    if((e.ctrlKey||e.metaKey)&&e.key==='Tab'){e.preventDefault();const idx=tabs.findIndex(t=>t.id===activeTabId);switchTab(tabs[e.shiftKey?(idx-1+tabs.length)%tabs.length:(idx+1)%tabs.length].id);return;}
    if((e.ctrlKey||e.metaKey)&&e.key==='f'){e.preventDefault();document.getElementById('search-in')?.focus();return;}
    if((e.ctrlKey||e.metaKey)&&e.key==='l'){e.preventDefault();enterBcEditMode();return;}
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
    if(e.key==='Enter'){e.preventDefault();const entry=curIdx>=0?entries[curIdx]:null;if(entry){if(entry.is_dir)await navigate(entry.path,0);else invoke('open_file',{path:entry.path}).catch(()=>{});}return;}
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
    if(e.key==='Backspace'){e.preventDefault();if(state.historyIdx>0){state.historyIdx--;state.columns=[];await navigate(state.history[state.historyIdx],0,false);}return;}
    if(e.key==='F5'||(e.metaKey&&e.key==='r')){e.preventDefault();await refreshCurrent();return;}
    if(e.key==='Delete'||e.key==='F8'){e.preventDefault();const es=getSelectedEntries();if(es.length)deleteEntries(es);return;}
    if((e.ctrlKey||e.metaKey)&&e.key==='c'){clipboardCopy(getSelectedEntries());return;}
    if((e.ctrlKey||e.metaKey)&&e.key==='x'){clipboardCut(getSelectedEntries());return;}
    if((e.ctrlKey||e.metaKey)&&e.key==='v'){await clipboardPaste();return;}
    if((e.ctrlKey||e.metaKey)&&e.key==='z'&&!e.shiftKey){e.preventDefault();await undoLastOp();return;}
    if((e.ctrlKey||e.metaKey)&&(e.key==='y'||(e.key==='z'&&e.shiftKey))){e.preventDefault();await redoLastOp();return;}
    if((e.ctrlKey||e.metaKey)&&e.key==='a'){e.preventDefault();sel._paths.clear();entries.forEach(e=>sel._paths.add(e.path));sel.last=entries.length-1;state.selIdx=entries.length-1;render();return;}
  });
}

// ── Master render ─────────────────────────────────────────────────────────────
function renderTrashBanner(){
  const banner=document.getElementById('trash-banner');
  if(!banner)return;
  // Show banner for any path under the Trash tree
  const trashRoot=(state.currentPath||'').includes('/.local/share/Trash');
  if(!trashRoot){banner.style.display='none';return;}
  banner.style.display='flex';
  banner.innerHTML=
    '<span class="trash-banner-msg">Items in Trash will be permanently deleted when Trash is emptied.</span>'+
    '<button class="trash-banner-btn" id="btn-empty-trash">Empty Trash</button>';
  document.getElementById('btn-empty-trash')?.addEventListener('click',()=>{
    if(!confirm('Permanently delete all items in Trash? This cannot be undone.'))return;
    _emptyTrashWithProgress().catch(err=>showToast('Empty Trash failed: '+err,'error'));
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
  loadPreview,handleEntryClick,getMediaUrl,getTranscodeUrl,getHeicJpegUrl,navigate,navigateDebounced,render,showToast,refreshTagColors,doGlobalSearch,
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
  window._state = state; // expose for FF logger
  await initMediaPort();
  // Pre-warm QL window in the background while sidebar/files load.
  // initQuickLook() creates a hidden WebviewWindow so the WebKit process is
  // already running when the user first presses Space — eliminates cold-start lag.
  initQuickLook().catch(()=>{});
  await loadSidebar();
  const home=await invoke('get_home_dir');
  state.currentPath=home;state.activeSb=home;
  getActiveTab().state.currentPath=home;
  await navigate(home,0,true);
  renderSidebar();renderTabs();
  setupKeyboard();
  setupSearch();
  setupSidebarResize();
  setupBreadcrumbRail();
  await setupWindowControls();
  applyScale();
  setInterval(pollDrives,30000); // Fallback polling — Tauri 'drives-changed' event handles real-time hot-plug
  // ── Tauri event: instant USB hot-plug detection ───────────────────────────
  try{
    appWindow.listen('drives-changed', ({payload:drives})=>{
      const prev=state.sidebarData.drives||[];
      if(JSON.stringify(drives)!==JSON.stringify(prev)){
        const usbPrev=prev.filter(d=>d.drive_type==='usb').length;
        const usbNew=drives.filter(d=>d.drive_type==='usb').length;
        state.sidebarData.drives=drives;
        renderSidebar();
        if(usbNew>usbPrev)showToast('USB drive connected','success');
        else if(usbNew<usbPrev)showToast('USB drive removed','info');
      }
    });
    // ── Tauri event: real filesystem change detection (inotify via notify crate) ─
    // Rust watches the current directory with inotify/kqueue and emits 'dir-changed'
    // (debounced 300ms) when any create/modify/delete/rename happens. No mtime
    // polling — zero spurious renders on navigate.
    // -- Single-file delete progress (from delete_file command) ----
    appWindow.listen('delete-progress', ({payload})=>{
      const {name,done,total,finished,error}=payload;
      if(done===0&&!finished) _sbProgress.start('Moving to Trash...', total);
      else if(finished)       _sbProgress.finish(true, 'Moved to Trash');
      else if(error)          _sbProgress.error('Failed: '+name+': '+error);
      else                    _sbProgress.update(done, total, 'Moving '+name);
    });
    appWindow.listen('dir-changed', ({payload:changedPath})=>{
      // Refresh only if the changed directory is one of the currently open columns.
      const isOpenColumn = state.columns.some(col => col.path === changedPath);
      if(isOpenColumn) {
        _jsCacheEvict(changedPath); // stale — watcher confirmed listing changed
        refreshColumns(changedPath);
      }
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
  }catch(e){console.warn('Tauri event listener failed:',e);}
}
init().catch(console.error);
