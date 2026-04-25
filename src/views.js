// ============================================================
// views.js — View renderers: column, list, icon, gallery, preview, audio viz
// ============================================================
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow as _getAppWindow } from '@tauri-apps/api/window';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
let appWindow; // set lazily by injectDeps() after Tauri context ready
import { emit, once, listen } from '@tauri-apps/api/event';
import {
  I, IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS, DOC_EXTS, OFFICE_EXTS, BOOK_EXTS, PDF_EXTS, ARCHIVE_EXTS, ISO_EXTS, HTML_EXTS, DMG_EXTS, FONT_EXTS,
  fileColor, fileIcon, mimeLabel, fmtSize, fmtDate, escHtml
} from './utils.js';

// Fuzzy match: chars appear in order (gaps allowed)
function _fuzzyMatch(name, query) {
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  for (let i = 0; i < n.length && qi < q.length; i++) {
    if (n[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

// Audio cover cache
const _audioCoverCache = {};

async function _getAudioCover(path) {
  if (_audioCoverCache[path] === 'loading') return null;
  if (_audioCoverCache[path]) return _audioCoverCache[path];
  _audioCoverCache[path] = 'loading';
  try {
    const cover = await invoke('get_audio_cover', { path });
    _audioCoverCache[path] = cover || null;
    return cover || null;
  } catch {
    _audioCoverCache[path] = null;
    return null;
  }
}

// Injected by main.js
let _deps = {};
export function injectDeps(deps){ 
  _deps = deps; 
  appWindow = deps.appWindow || _getAppWindow(); 
  _initPreviewPanel();
}
const d = () => _deps;

// ── Preview Panel: Resize & Collapse ───────────────────────────────────────────
function _initPreviewPanel() {
  const panel = document.getElementById('preview-panel');
  if (!panel) return;
  
  // Restore collapsed state
  try {
    const collapsed = localStorage.getItem('ff_preview_hidden') === '1';
    if (collapsed) panel.style.display = 'none';
  } catch {}
  
  // Add resize handle
  let resizeHandle = document.getElementById('preview-resize-handle');
  if (!resizeHandle) {
    resizeHandle = document.createElement('div');
    resizeHandle.id = 'preview-resize-handle';
    panel.appendChild(resizeHandle);
  }
  
  // Restore width
  try {
    const savedWidth = localStorage.getItem('ff_preview_width');
    if (savedWidth) {
      document.documentElement.style.setProperty('--preview-w', savedWidth + 'px');
    }
  } catch {}
  
  let isDragging = false;
  let startX = 0;
  let startWidth = 0;
  
  resizeHandle.addEventListener('mousedown', (e) => {
    isDragging = true;
    startX = e.clientX;
    startWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--preview-w')) || 240;
    resizeHandle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const newWidth = Math.max(180, Math.min(800, startWidth + dx));
    document.documentElement.style.setProperty('--preview-w', newWidth + 'px');
  });
  
  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    resizeHandle.classList.remove('dragging');
    document.body.style.cursor = '';
    // Save width
    const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--preview-w')) || 240;
    try { localStorage.setItem('ff_preview_width', w); } catch {}
  });
}

// ── Keyboard shortcuts for new features ────────────────────────────────────────
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', async (e) => {
    // Ctrl+P: Toggle Preview Panel
    if (e.ctrlKey && (e.key === 'p' || e.key === 'P')) {
      e.preventDefault();
      const panel = document.getElementById('preview-panel');
      if (panel) {
        const isVisible = panel.style.display !== 'none';
        panel.style.display = isVisible ? 'none' : '';
        document.documentElement.style.setProperty('--preview-hidden', isVisible ? '1' : '0');
        // r22c: keep resize handle non-interactive when panel is hidden
        const _rh = document.getElementById('preview-resize-handle');
        if (_rh) _rh.style.pointerEvents = isVisible ? 'none' : 'auto';
        try { localStorage.setItem('ff_preview_hidden', isVisible ? '1' : '0'); } catch {}
        d().render?.();
      }
      return;
    }

    // Ctrl+I: Properties (Edit EXIF/PDF/audio metadata)
    if (e.ctrlKey && (e.key === 'i' || e.key === 'I')) {
      e.preventDefault();
      const { sel, state, getVisibleEntries } = d();
      const entries = getVisibleEntries();
      const selectedEntries = sel.size > 0 
        ? sel.arr.map(i => entries[i]).filter(Boolean)
        : (state.selIdx >= 0 ? [entries[state.selIdx]].filter(Boolean) : []);
      if (selectedEntries.length !== 1) {
        d().showToast(t('toast.select_single_file'), 'info');
        return;
      }
      const entry = selectedEntries[0];
      if (entry.is_dir) {
        d().showToast(d().t('toast.no_metadata_for_folders'), 'info');
        return;
      }
      const ext = (entry.extension || '').toLowerCase();
      const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'tiff', 'tif', 'webp', 'heic', 'heif', 'gif', 'bmp'];
      const PDF_EXTS = ['pdf'];
      const AUDIO_EXTS = ['mp3', 'flac', 'ogg', 'wav', 'aac', 'm4a', 'opus', 'weba'];
      if (IMAGE_EXTS.includes(ext)) {
        _showExifEditor(entry, null);
      } else if (PDF_EXTS.includes(ext)) {
        _showPdfMetaEditor(entry, null);
      } else if (AUDIO_EXTS.includes(ext)) {
        _showAudioTagEditor(entry, null);
      } else {
        d().showToast(d().t('toast.no_metadata_editor', {ext}), 'info');
      }
      return;
    }

    if (!e.ctrlKey || !e.shiftKey) return;
    const { sel, state, showToast, getVisibleEntries } = d();
    
    // Ctrl+Shift+R: Batch Rename
    if (e.key === 'R') {
      e.preventDefault();
      const entries = getVisibleEntries();
      const selectedEntries = sel.size > 0 
        ? sel.arr.map(i => entries[i]).filter(Boolean)
        : (state.selIdx >= 0 ? [entries[state.selIdx]].filter(Boolean) : []);
      const paths = selectedEntries.map(en => en.path);
      if (paths.length > 0) {
        showBatchRenameDialog(paths);
      } else {
        showToast(t('toast.select_files_first'), 'info');
      }
    }
    
    // Ctrl+Shift+S: SMB Connect
    if (e.key === 'S') {
      e.preventDefault();
      showSmbConnectDialog();
    }
    
    // Ctrl+Shift+O: Cloud (O for OwnCloud/Online)
    if (e.key === 'O') {
      e.preventDefault();
      showCloudMountDialog();
    }
  });
}

// ── Video player ─────────────────────────────────────────────────────────────
// In-app preview: native <video> element served by the local HTTP media server.
//   Works natively on Wayland (no XWayland, no wl_surface* cross-process hacks).
//   WEBKIT_DISABLE_DMABUF_RENDERER=1 (set in main.rs) prevents black frames on
//   VA-API hardware decode. GStreamer handles H.265/HEVC, AV1, VP9 with VA-API.
//
// External: mpv_open_external spawns a standalone mpv window (no --wid needed).

// Mount a native <video> element into `slot` via the local HTTP media server.
// Port is fetched once and cached. "Open with mpv" button available in toolbar.
// Pass autoplay=true to skip the click-to-play overlay (used by Quick Look).
let _mediaPort = null;

// ── Per-slot video player cleanup ────────────────────────────────────────────
// Cleanup fn is stored directly on the slot element as slot._mpvCleanup.
// No cross-slot global state — gallery and preview are fully independent.
// Mutual audio exclusion is handled by a single capture-phase 'play' listener:
// when any video starts playing, all OTHER videos are immediately paused.
let _mutualExclusionBound = false;
function _ensureMutualExclusion() {
  if (_mutualExclusionBound) return;
  _mutualExclusionBound = true;
  document.addEventListener('play', e => {
    if (!(e.target instanceof HTMLVideoElement)) return;
    document.querySelectorAll('video').forEach(v => { if (v !== e.target) v.pause(); });
  }, true); // capture phase — fires before the element's own handlers
}

// Stop and clean up any player mounted in a slot element.
function _stopSlot(slot) {
  if (!slot) return;
  if (typeof slot._mpvCleanup === 'function') { slot._mpvCleanup(); return; }
  slot.querySelectorAll('video').forEach(v => { v.pause(); v.src = ''; });
}

// Extensions that WebKit2GTK + GStreamer reliably cannot play in-process,
// even with gst-plugins-bad installed. Skip the <video> element entirely
// for these and hand straight off to mpv.
// NOTE: mkv is intentionally excluded — WebKit can play H.264/VP9 MKV.
// HEVC MKV falls through to the stall-detection timer which shows the mpv button.
const WEBKIT_SKIP_EXTS = new Set(['avi','m4v','ogv']);

// Show the "now playing in mpv" placeholder panel and auto-launch mpv.
function _autoMpv(slot, path, fsBtn) {
  const filename = path.split('/').pop();
  slot.innerHTML = '';
  const panel = document.createElement('div');
  panel.style.cssText = `
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    gap:14px;height:100%;width:100%;background:#111113;color:#94a3b8;
    font-size:13px;text-align:center;padding:24px;box-sizing:border-box;
  `;
  panel.innerHTML = `
    <svg viewBox="0 0 24 24" fill="currentColor" style="width:48px;height:48px;color:#5b8dd9;opacity:.8">
      <path d="M8 5v14l11-7z"/>
    </svg>
    <div style="color:#e2e8f0;font-size:14px;font-weight:500;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(filename)}</div>
    <div style="color:#636368;font-size:12px">Opening in mpv…</div>
    <button id="auto-mpv-fs" style="margin-top:4px;padding:5px 14px;font-size:12px;background:rgba(91,141,217,.2);color:#5b8dd9;border:1px solid rgba(91,141,217,.35);border-radius:6px;cursor:pointer;">⛶  Full screen in mpv</button>
  `;
  slot.appendChild(panel);
  if (fsBtn) slot.appendChild(fsBtn);
  panel.querySelector('#auto-mpv-fs')?.addEventListener('click', () => {
    invoke('mpv_open_external', { path, startTime: null, fullscreen: true }).catch(() => {});
  });
  invoke('mpv_open_external', { path, startTime: null, fullscreen: false }).catch(err => {
    const msg = panel.querySelector('div:last-of-type');
    if (msg) msg.textContent = 'mpv failed: ' + err;
  });
}

async function _mountMpvPlayer(slot, path, { autoplay = false } = {}) {
  // Snapshot mount intent — if selection changes before await resolves, abort
  const _mountId = Symbol();
  slot._pendingMountId = _mountId;

  if (_mediaPort === null) {
    try { _mediaPort = await invoke('get_media_port'); }
    catch(e) { _mediaPort = 0; }
  }

  // Slot was claimed by a newer mount call while we were awaiting — bail
  if (slot._pendingMountId !== _mountId) return;

  const ext = (path.split('.').pop() || '').toLowerCase();

  // ── Known WebKit2GTK-incompatible containers → skip <video>, auto-open mpv ─
  if (WEBKIT_SKIP_EXTS.has(ext)) {
    // Build the fullscreen button first (same as normal path) so _autoMpv
    // can append it after overwriting innerHTML.
    const fsBtn = document.createElement('button');
    fsBtn.title = 'Fullscreen in mpv (F)';
    fsBtn.style.cssText = `
      position:absolute;top:10px;right:10px;z-index:10;
      background:rgba(0,0,0,0.55);border:none;border-radius:5px;
      color:#fff;cursor:pointer;padding:5px 7px;line-height:1;
      font-size:14px;opacity:0.85;
    `;
    fsBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      style="width:16px;height:16px;display:block">
      <polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/>
      <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
    </svg>`;
    fsBtn.addEventListener('click', () => {
      invoke('mpv_open_external', { path, startTime: null, fullscreen: true }).catch(() => {});
    });
    // Wire F key
    const _fsKey = (e) => { if (e.key === 'f' || e.key === 'F') { invoke('mpv_open_external', { path, startTime: null, fullscreen: true }).catch(() => {}); } };
    document.addEventListener('keydown', _fsKey);
    slot.style.position = 'relative';
    slot.dataset.mpvActive = '1';
    slot._mpvCleanup = () => {
      document.removeEventListener('keydown', _fsKey);
      delete slot.dataset.mpvActive;
    };
    _autoMpv(slot, path, fsBtn);
    return;
  }

  if (!_mediaPort) {
    slot.innerHTML = `<div class="video-err-panel">
      <span class="video-err-msg">Media server unavailable.</span>
      <button class="video-err-open">Open with mpv</button>
    </div>`;
    slot.querySelector('.video-err-open')?.addEventListener('click', () => {
      invoke('mpv_open_external', {path, startTime: null, fullscreen: false}).catch(() => {});
    });
    return;
  }

  // The media server uses the URL path directly as the filesystem path.
  // path already starts with '/', so this becomes e.g. http://127.0.0.1:PORT/home/user/video.mkv
  const url = `http://127.0.0.1:${_mediaPort}${path.split('/').map(encodeURIComponent).join('/')}`;
  const video = document.createElement('video');
  video.src = url;
  video.controls = false;   // We build custom controls below
  video.preload = 'none'; // 'metadata' caused GStreamer to open range requests immediately on highlight — no IO until user plays
  video.autoplay = autoplay;
  video.disablePictureInPicture = true;
  video.playsInline = true;  // prevent WebKit detaching the renderer on some builds
  video.style.cssText = 'width:100%;height:100%;object-fit:contain;background:#000;display:block;cursor:pointer;';

  // ── Fullscreen launcher (hands off to mpv on Wayland) ───────────────────
  // Stop any existing player in this slot before mounting a new one.
  _stopSlot(slot);
  _ensureMutualExclusion();

  let _fsActive = false;
  const _launchFullscreen = () => {
    if (_fsActive) return; _fsActive = true;
    const t = video.currentTime; video.pause(); appWindow.minimize();
    invoke('mpv_open_external', { path, startTime: t, fullscreen: true })
      .then(() => {
        const poll = setInterval(async () => {
          try {
            const running = await invoke('mpv_is_running');
            if (!running) { clearInterval(poll); _fsActive=false; appWindow.unminimize(); appWindow.setFocus(); }
          } catch { clearInterval(poll); _fsActive=false; appWindow.unminimize(); }
        }, 500);
      })
      .catch(err => { _fsActive=false; appWindow.unminimize(); d().showToast(t('error.mpv',{err}),'error'); });
  };

  // Only F-key fullscreen on document (global is fine — it's not disruptive)
  const _fsKey = e => { if (e.key==='f'||e.key==='F') _launchFullscreen(); };
  document.addEventListener('keydown', _fsKey);

  const _interceptFs = () => { _launchFullscreen(); return Promise.resolve(); };
  video.requestFullscreen = _interceptFs; video.webkitRequestFullscreen = _interceptFs;
  video.webkitEnterFullscreen = _interceptFs; video.mozRequestFullScreen = _interceptFs;
  const _onFsChange = () => {
    const fsEl = document.fullscreenElement||document.webkitFullscreenElement; if(!fsEl) return;
    (document.exitFullscreen?.bind(document)||document.webkitExitFullscreen?.bind(document))?.().catch(()=>{});
    _launchFullscreen();
  };
  document.addEventListener('fullscreenchange', _onFsChange);
  document.addEventListener('webkitfullscreenchange', _onFsChange);

  // ── Wrapper + custom controls bar ─────────────────────────────────────────
  const wrapper = document.createElement('div');
  // tabIndex lets the wrapper receive keyboard events on focus
  // will-change:transform isolates this subtree on its own GPU layer — prevents
  // seek-bar repaints from triggering a full-page composite on WebKit2GTK.
  wrapper.style.cssText = 'position:relative;width:100%;height:100%;background:#000;overflow:hidden;outline:none;will-change:transform;transform:translateZ(0);contain:layout style;';
  wrapper.tabIndex = -1;

  let _userStarted = autoplay;  // true once user clicks play (or autoplay=true)

  const fmt = s => {
    if (!isFinite(s)) return '0:00'; s=Math.floor(s);
    const h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;
    return h?`${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`:`${m}:${String(sec).padStart(2,'0')}`;
  };

  const bar = document.createElement('div');
  bar.className = 'vc-bar';
  bar.innerHTML = `
    <div class="vc-seek-row">
      <div class="vc-seek-track">
        <div class="vc-seek-buf"></div>
        <div class="vc-seek-fill"></div>
      </div>
    </div>
    <div class="vc-btn-row">
      <button class="vc-btn vc-play" title="Play/Pause (Space)">
        <svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>
      </button>
      <span class="vc-time">0:00 / 0:00</span>
      <div class="vc-spacer"></div>
      <button class="vc-btn vc-mute" title="Mute (M)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polygon points="11,5 6,9 2,9 2,15 6,15 11,19"/>
          <path class="vc-vol-waves" d="M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14"/>
        </svg>
      </button>
      <div class="vc-vol-wrap">
        <input class="vc-vol" type="range" min="0" max="100" value="100" step="1">
      </div>
      <button class="vc-btn vc-fs" title="Fullscreen in mpv (F)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15,3 21,3 21,9"/><polyline points="9,21 3,21 3,15"/>
          <line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>
        </svg>
      </button>
    </div>`;

  const elPlay  = bar.querySelector('.vc-play');
  const elTrack = bar.querySelector('.vc-seek-track');
  const elFill  = bar.querySelector('.vc-seek-fill'), elBuf = bar.querySelector('.vc-seek-buf');
  const elTime  = bar.querySelector('.vc-time'), elMute = bar.querySelector('.vc-mute');
  const elVol   = bar.querySelector('.vc-vol'), elVolW = bar.querySelector('.vc-vol-waves');
  const elFs    = bar.querySelector('.vc-fs');

  // Play/pause
  const _updPlay = () => { elPlay.innerHTML = video.paused
    ? `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6,4 20,12 6,20"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="4" width="4" height="16"/><rect x="15" y="4" width="4" height="16"/></svg>`; };
  elPlay.addEventListener('click', () => {
    if (video.paused) {
      if (!_userStarted) { _userStarted = true; _armStallTimer(); }
      video.play();
    } else {
      video.pause();
    }
  });
  video.addEventListener('click', ()=>{ video.paused?video.play():video.pause(); });
  video.addEventListener('play',  _updPlay); video.addEventListener('pause', _updPlay);

  // Seek — direct pointer tracking on the track element.
  // No range input — avoids the z-index/pointer-event overlap issue in WebKit
  // where a transparent input intercepts clicks on the button row below.
  // Live mode (Infinity duration = transcode pipe): track dims, seeking disabled.
  let _seeking = false, _seekLive = false;

  const _setLiveMode = (live) => {
    _seekLive = live;
    elTrack.style.cursor = live ? 'default' : 'pointer';
    elFill.style.opacity = live ? '0.35' : '1';
  };

  const _seekFrac = (e) => {
    const r = elTrack.getBoundingClientRect();
    if (!r.width) return 0;  // not yet laid out — avoid Infinity/NaN
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
  };
  elTrack.style.cursor = 'pointer';
  elTrack.addEventListener('pointerdown', e => {
    if (_seekLive || !isFinite(video.duration)) return;
    e.preventDefault();
    _seeking = true;
    elTrack.setPointerCapture(e.pointerId);
    const p = _seekFrac(e);
    elFill.style.transform = `scaleX(${p.toFixed(4)})`;
    elTime.textContent = `${fmt(video.duration * p)} / ${fmt(video.duration)}`;
  });
  elTrack.addEventListener('pointermove', e => {
    if (!_seeking) return;
    const p = _seekFrac(e);
    elFill.style.transform = `scaleX(${p.toFixed(4)})`;
    if (isFinite(video.duration)) elTime.textContent = `${fmt(video.duration * p)} / ${fmt(video.duration)}`;
  });
  elTrack.addEventListener('pointerup', e => {
    if (!_seeking) return;
    _seeking = false;
    elTrack.releasePointerCapture(e.pointerId);
    if (isFinite(video.duration)) video.currentTime = _seekFrac(e) * video.duration;
  });

  const _updSeek = () => {
    if (_seeking) return;
    if (!isFinite(video.duration)) {
      elTime.textContent = fmt(video.currentTime);
      return;
    }
    const p = video.duration ? video.currentTime / video.duration : 0;
    elFill.style.transform = `scaleX(${p.toFixed(4)})`;
    elTime.textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
  };
  // Throttle timeupdate via rAF — fires up to 60fps on some GStreamer builds,
  // but we only need to repaint at ~4fps max. rAF batches DOM writes and skips
  // frames when the window is hidden, preventing needless layout recalculations.
  let _rafSeek = null;
  video.addEventListener('timeupdate', () => {
    if (_rafSeek) return;
    _rafSeek = requestAnimationFrame(() => { _rafSeek = null; _updSeek(); });
  });
  video.addEventListener('loadedmetadata', () => {
    const live = !isFinite(video.duration);
    _setLiveMode(live);
    elTime.textContent = live ? '0:00' : `0:00 / ${fmt(video.duration)}`;
  });
  video.addEventListener('durationchange', () => {
    const live = !isFinite(video.duration);
    _setLiveMode(live);
    if (!live) elTime.textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
  });
  video.addEventListener('progress', () => {
    if (!video.duration || !isFinite(video.duration) || !video.buffered.length) return;
    elBuf.style.transform = `scaleX(${(video.buffered.end(video.buffered.length - 1) / video.duration).toFixed(4)})`;
  });

  // Volume
  const _updVol = () => { const m=video.muted||video.volume===0; elVolW.style.display=m?'none':''; elMute.title=m?'Unmute (M)':'Mute (M)'; };
  elMute.addEventListener('click', ()=>{ video.muted=!video.muted; _updVol(); });
  elVol.addEventListener('input', ()=>{ video.volume=elVol.value/100; video.muted=video.volume===0; _updVol(); });
  video.addEventListener('volumechange', ()=>{ elVol.value=Math.round(video.volume*100); _updVol(); });

  // Fullscreen button
  elFs.addEventListener('click', _launchFullscreen);

  // ── Keyboard shortcuts scoped to this wrapper ───────────────────────────
  // All non-fullscreen shortcuts are handled on the wrapper (tabIndex=-1) so
  // they only fire when this player has focus — prevents gallery+preview fighting.
  wrapper.addEventListener('keydown', e => {
    if (e.code === 'Space') { e.preventDefault(); video.paused?video.play():video.pause(); }
    if (e.key === 'ArrowLeft')  { e.preventDefault(); video.currentTime=Math.max(0,video.currentTime-5); }
    if (e.key === 'ArrowRight') { e.preventDefault(); video.currentTime=Math.min(video.duration||0,video.currentTime+5); }
    if (e.key === 'm' || e.key === 'M') { video.muted=!video.muted; _updVol(); }
  });
  // Focus wrapper when clicking video or bar so keys work immediately
  video.addEventListener('click', ()=>wrapper.focus());
  bar.addEventListener('mousedown', ()=>wrapper.focus());

  // Auto-hide controls (always visible while paused)
  // Debounce via rAF: mousemove fires 60+ times/sec during panning;
  // the old code cleared+set a 2s timer on every event = constant GC pressure.
  let _hideTimer=null, _showPending=false;
  const _showBar = () => {
    if (_showPending) return;
    _showPending = true;
    requestAnimationFrame(() => {
      _showPending = false;
      if (wrapper._dead) return;  // slot was torn down while rAF was pending
      bar.style.opacity='1'; bar.style.pointerEvents='auto';
      clearTimeout(_hideTimer);
      if (!video.paused) _hideTimer=setTimeout(()=>{ bar.style.opacity='0'; bar.style.pointerEvents='none'; }, 2500);
    });
  };
  const _stayVis = () => { clearTimeout(_hideTimer); bar.style.opacity='1'; bar.style.pointerEvents='auto'; };
  wrapper.addEventListener('mousemove', _showBar);
  wrapper.addEventListener('mouseenter', _showBar);
  wrapper.addEventListener('mouseleave', ()=>{ if(!video.paused){ bar.style.opacity='0'; bar.style.pointerEvents='none'; } });
  bar.addEventListener('mouseenter', _stayVis);
  bar.addEventListener('mouseleave', _showBar);
  video.addEventListener('play', _showBar);
  video.addEventListener('pause', _stayVis);

  wrapper.appendChild(video);
  wrapper.appendChild(bar);

  // overlay ref — also used by stall timer to auto-dismiss on transcode
  let _overlay = null;
  if (!autoplay) {
    _overlay = document.createElement('div');
    const overlay = _overlay;
    overlay.style.cssText = `
      position:absolute;inset:0;display:flex;flex-direction:column;
      align-items:center;justify-content:center;gap:10px;
      background:rgba(0,0,0,0.45);cursor:pointer;z-index:2;
    `;
    const filename = path.split('/').pop();
    overlay.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor" style="width:52px;height:52px;color:#fff;opacity:.9;filter:drop-shadow(0 2px 6px rgba(0,0,0,.6))">
        <circle cx="12" cy="12" r="11" fill="rgba(0,0,0,.4)"/>
        <polygon points="10,8 18,12 10,16" fill="#fff"/>
      </svg>
      <span style="color:#fff;font-size:12px;opacity:.7;max-width:90%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${filename}</span>
      <button style="margin-top:4px;padding:4px 12px;font-size:11px;background:rgba(255,255,255,.15);color:#fff;border:1px solid rgba(255,255,255,.3);border-radius:5px;cursor:pointer" class="ext-open-btn">Open with mpv</button>
    `;
    overlay.addEventListener('click', e => {
      if (e.target.classList.contains('ext-open-btn')) {
        invoke('mpv_open_external', { path, startTime: null, fullscreen: false }).catch(() => {});
        return;
      }
      overlay.remove();
      _overlay = null;
      _userStarted = true;
      _armStallTimer(); // start stall detection now that user explicitly clicked play
      video.play().catch(() => {});
    });
    wrapper.appendChild(overlay);
  }

  video.addEventListener('error', () => {
    clearTimeout(_stallTimer);
    if (!_isActive()) return;  // orphaned — discard
    if (!video.dataset.transcoding) {
      video.dataset.transcoding = '1';
      const {getTranscodeUrl} = d();
      video.src = getTranscodeUrl(path);
      video.load();
      if (_userStarted) video.play().catch(()=>{});
      _stallTimer = setTimeout(() => {
        if (_isActive() && video.readyState < 3 && !video.dataset.transcoded) _showTranscodeError();
      }, 15000);
    } else { _showTranscodeError(); }
  });

  const _showTranscodeError = () => {
    clearTimeout(_stallTimer);
    slot.innerHTML = `<div class="video-err-panel">
      <span class="video-err-msg">Codec error — transcoding also failed.<br>
        <small>Ensure <code>ffmpeg</code> is installed: <code>sudo pacman -S ffmpeg</code><br>
        For H.265: install <code>gst-libav gst-plugin-va</code> and rebuild.</small></span>
      <button class="video-err-open">Open with mpv</button>
    </div>`;
    slot.querySelector('.video-err-open')?.addEventListener('click', () => {
      invoke('mpv_open_external', { path, startTime: null, fullscreen: false }).catch(() => {});
    });
  };

  // ── Silent stall detection (HEVC/H.265, 10-bit, etc.) ────────────────────
  // WebKit2GTK + GStreamer silently stalls at readyState=0 for unsupported
  // codecs. After 5 s with no canplay/playing event, automatically switch to
  // the /transcode/ endpoint — ffmpeg VAAPI→H.264 proxy. This avoids the
  // error panel entirely for HEVC content when ffmpeg is installed.
  // Orphan guard: stall/transcode callbacks bail if this wrapper was replaced
  const _isActive = () => !wrapper._dead && wrapper.isConnected;

  // ── Stall detection ──────────────────────────────────────────────────────────
  // DO NOT start the timer at mount time. With preload='none', readyState stays 0
  // until play() is called, so an unconditional 5-second timer would ALWAYS trigger
  // transcoding for every highlighted video — launching background ffmpeg on every
  // 4K MKV the user merely selects. _armStallTimer() is called explicitly from the
  // overlay click and play button handlers, ensuring stall detection is only active
  // while the user has actually initiated playback.
  // For the autoplay=true path (Quick Look), _armStallTimer() is called at mount.
  let _stallTimer = null;
  const _armStallTimer = () => {
    clearTimeout(_stallTimer);
    _stallTimer = setTimeout(() => {
      if (!_isActive()) return;
      if (video.readyState < 3 && !video.error && !video.dataset.transcoding) {
        video.dataset.transcoding = '1';
        const {getTranscodeUrl} = d();
        // Auto-dismiss the click-to-play overlay — transcode will start playing automatically
        if (_overlay) { _overlay.remove(); _overlay = null; }
        _showBar(); // ensure controls are visible when transcode starts
        elTime.textContent = '⚡ Transcoding…';
        elTime.title = 'Stream is being transcoded via ffmpeg (seeking unavailable)';
        video.src = getTranscodeUrl(path);
        video.load();
        // Auto-play as soon as transcode stream has buffered enough
        const _startOnReady = () => {
          _userStarted = true;
          video.play().catch(() => {});
        };
        video.addEventListener('canplay', _startOnReady, { once: true });
        _stallTimer = setTimeout(() => {
          video.removeEventListener('canplay', _startOnReady);
          if (_isActive() && video.readyState < 3) _showTranscodeError();
        }, 20000);
      }
    }, 5000);
  };
  video.addEventListener('canplay', () => { clearTimeout(_stallTimer); }, { once: true });
  video.addEventListener('playing', () => { clearTimeout(_stallTimer); }, { once: true });

  slot.innerHTML = '';
  slot.appendChild(wrapper);
  // Mark the SLOT (not the video element) so _mpvStop can find it with
  // querySelector('[data-mpv-active]') and call slot._mpvCleanup correctly.
  slot.dataset.mpvActive = '1';

  // ── Adjacent video preload — prime the GStreamer pipeline for the next file ──
  // After mount, silently probe the prev/next video in the gallery strip so
  // GStreamer has its decoder ready before the user presses ← or →.
  // Uses preload='metadata' (just container headers, no significant IO) and is
  // discarded after 3 s — well before the user is likely to navigate away.
  let _preloadVids = [];
  let _preloadCleanTimer = null;
  const _cancelPreloads = () => {
    clearTimeout(_preloadCleanTimer);
    _preloadVids.forEach(p => { p.src = ''; p.remove(); });
    _preloadVids = [];
  };
  setTimeout(() => {
    if (!_isActive() || !_mediaPort) return;
    try {
      const {getVisibleEntries, state: _st} = d();
      const _entries = getVisibleEntries?.() ?? [];
      const _curIdx = _st?.gallerySelIdx ?? -1;
      const _neighbors = [-1, 1].map(offset => _entries[_curIdx + offset]).filter(
        e => e && !e.is_dir && VIDEO_EXTS.includes((e.extension||'').toLowerCase())
          && !WEBKIT_SKIP_EXTS.has((e.extension||'').toLowerCase())
      );
      _preloadVids = _neighbors.map(e => {
        const _pv = document.createElement('video');
        _pv.preload = 'metadata';
        _pv.muted = true;
        _pv.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;';
        _pv.src = `http://127.0.0.1:${_mediaPort}${e.path.split('/').map(encodeURIComponent).join('/')}`;
        document.body.appendChild(_pv);
        return _pv;
      });
      // Discard after 3 s — we only needed to open the GStreamer demuxer
      _preloadCleanTimer = setTimeout(_cancelPreloads, 3000);
    } catch(_) {}
  }, 800); // delay until after our own video.load() has started

  // For the autoplay=true path (Quick Look), arm stall detection immediately and
  // trigger play explicitly — with preload='none' the autoplay HTML attribute may
  // not fire on WebKit2GTK without an explicit play() call.
  if (autoplay) {
    _armStallTimer();
    video.play().catch(() => {});
  }
  const _cleanup = () => {
    clearTimeout(_stallTimer);
    clearTimeout(_hideTimer);
    if (_rafSeek) { cancelAnimationFrame(_rafSeek); _rafSeek = null; }
    _cancelPreloads();  // eagerly remove preload video elements from document.body
    wrapper._dead = true;  // signals _isActive() → stall/error callbacks bail
    document.removeEventListener('keydown', _fsKey);
    document.removeEventListener('fullscreenchange', _onFsChange);
    document.removeEventListener('webkitfullscreenchange', _onFsChange);
    video.pause();
    video.src = '';
    if (slot.contains(wrapper)) wrapper.remove();
    delete slot.dataset.mpvActive;
    slot._mpvCleanup = null;
  };
  slot._mpvCleanup = _cleanup;
}

// Stop in-app video playback and clean up.
// Searches for the slot marked data-mpv-active and calls its _mpvCleanup.
// NOTE: data-mpv-active is on the SLOT element (not the video child) so this
// querySelector correctly returns the element that has _mpvCleanup attached.
function _mpvStop(host) {
  if (!host) return;
  // data-mpv-active is on the slot element itself — check host, then descendants
  const slot = host.dataset?.mpvActive ? host : host.querySelector('[data-mpv-active]');
  _stopSlot(slot);
}

// Helper to get tag color — uses stored color from state, falls back to palette
function tagColor(tag){
  const stored=d().state?._tagColors?.[tag];
  if(stored)return stored;
  const palette=['#f87171','#fb923c','#fbbf24','#34d399','#60a5fa','#a78bfa','#94a3b8'];
  let h=0;for(let i=0;i<tag.length;i++){h=(h*31+tag.charCodeAt(i))&0xffff;}
  return palette[h%palette.length];
}

// ── View dispatcher ───────────────────────────────────────────────────────────
export function renderView(){
  const host=document.getElementById('view-host'); if(!host)return;
  const {state}=d();
  // Search results render in the CURRENT view mode where possible.
  // List view uses renderListView (getVisibleEntries() already returns searchResults).
  // Column view falls back to renderFlatList — it requires a real directory tree.
  if(state.searchMode){
    if(state.viewMode==='icon') renderIconView(host);
    else if(state.viewMode==='gallery') renderGalleryView(host);
    else if(state.viewMode==='list') renderListView(host);
    else {
      // Column view can't search in-place — insert a one-line notice then render flat.
      const _bn=document.createElement('div');
      _bn.id='ff-col-search-notice';
      _bn.style.cssText='padding:5px 14px;font-size:11px;color:#98989f;background:rgba(255,255,255,.04);'+
        'border-bottom:1px solid rgba(255,255,255,.07);display:flex;align-items:center;gap:6px;flex-shrink:0;';
      _bn.innerHTML='<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" style="width:12px;height:12px;opacity:.6"><circle cx="6.5" cy="6.5" r="4"/><line x1="10" y1="10" x2="13" y2="13"/></svg>'+
        'Search results shown as flat list \u2014 column view requires a directory tree. Switch to List view to keep sort columns.';
      host.innerHTML='';
      host.style.display='flex';
      host.style.flexDirection='column';
      host.appendChild(_bn);
      const _wrap=document.createElement('div');
      _wrap.style.cssText='flex:1;overflow:auto;min-height:0;';
      host.appendChild(_wrap);
      renderFlatList(_wrap,state.searchResults);
    }
    return;
  }
  if(state.viewMode==='column') renderColumnView(host);
  else if(state.viewMode==='list') renderListView(host);
  else if(state.viewMode==='icon') renderIconView(host);
  else if(state.viewMode==='gallery') renderGalleryView(host);
}

// ── Column view ───────────────────────────────────────────────────────────────
// Module-level set of directory paths already submitted to preload_dir.
// Persists across renders so we never double-invoke for the same path in a session.
// Watcher evictions (dir-changed) don't need to clear this — preload_dir is a
// no-op when the path is already in the Rust cache, and after an eviction the
// next mouseover will re-submit the path (it won't be in the Rust cache anymore,
// but it WILL still be in _preloadedPaths — that's fine: the navigate() call that
// follows will miss the Rust cache and do a fresh FS read anyway).
const _preloadedPaths = new Set();
// Fix 1: sequence counter — lets renderColumnView detect and skip stale calls
// that arrive during rapid navigation (multiple renders queued in one RAF tick).
let _colRenderSeq = 0;
// Debounce: skip renders if a more recent one is already pending
let _colRenderPending = null;
export function renderColumnView(host){
  const _mySeq = ++_colRenderSeq;
  // Skip if a more recent render is already scheduled
  if (_colRenderPending !== null && _mySeq < _colRenderPending) return;
  // Schedule this render with 16ms debounce to coalesce rapid calls
  clearTimeout(_colRenderPending);
  _colRenderPending = _mySeq;
  setTimeout(() => {
    if (_mySeq !== _colRenderPending) return; // superseded
    _colRenderPending = null;
    _doRenderColumn(host, _mySeq);
  }, 16);
}

function _doRenderColumn(host, _mySeq) {
  window.FF?.log('RENDER_COL',{cols:window._state?.columns?.length,paths:window._state?.columns?.map(c=>c.path?.split('/').pop())});
  const {state,sel,sortEntries,setupDragDrop,setupDropTarget,
         showContextMenu,buildFileCtxMenu,buildBgCtxMenu,
         loadPreview,navigate,render}=d();

  // Reset any flex layout injected by the column-search banner path
  host.style.display='';
  host.style.flexDirection='';

  if(!host.querySelector('.cols-wrap'))
    host.innerHTML='<div class="cols-wrap"><div class="cols-container" id="cols"></div></div>';
  const container=document.getElementById('cols');

  // ── Incremental column reconciliation ────────────────────────────────────────
  // Instead of container.innerHTML='' (full rebuild every render), we keep DOM
  // elements for columns whose path hasn't changed. This eliminates the flash
  // caused by the two renders during streaming: first-chunk render builds 60-entry
  // column, then the full-entry render would wipe and rebuild it, causing a blank
  // frame. With reconciliation, the full-entry render just updates the spacer height
  // and repaints visible rows in-place — zero DOM teardown.
  //
  // Each .col element stores its path in dataset.colPath and a _patchEntries()
  // callback so subsequent renders can update entries without rebuilding listeners.
  const newPaths = state.columns.map(c => c.path);

  // Helper: disconnect a column element's ResizeObserver + rubber-band document
  // listeners before removing it from the DOM. Without this, every removed column
  // leaves a live ResizeObserver observing a detached element and dead document
  // mousemove/mouseup handlers from rubber-band — both accumulate across deep
  // navigation and cause cascading repaints / performance degradation.
  const _cleanupColEl = (el) => {
    el._colRO?.disconnect();
    el._rbCleanup?.();
  };

  // Fix 2: track whether columns were removed so Fix 3 can clamp scrollLeft
  let _colsRemoved = false;

  // Remove trailing columns that are no longer in state.columns
  while (container.children.length > state.columns.length) {
    _cleanupColEl(container.lastChild);
    container.lastChild.remove();
    _colsRemoved = true;
  }
  // Remove any column whose path no longer matches its position
  let domValid = true;
  for (let i = 0; i < container.children.length; i++) {
    if (container.children[i]?.dataset?.colPath !== newPaths[i]) {
      domValid = false;
      break;
    }
  }
  if (!domValid) {
    // Full reconciliation needed — remove all and rebuild
    while (container.lastChild) {
      _cleanupColEl(container.lastChild);
      container.lastChild.remove();
    }
    _colsRemoved = true;
  }
  // Now container has only the valid prefix of columns that can be reused.

  let _newColAppended = false; // tracks if any column was newly built (vs patched)
  state.columns.forEach((col,ci)=>{
  // If this column already exists in the DOM with the right path, patch it in-place.
  const existingColEl = container.children[ci];
  if (existingColEl && existingColEl.dataset.colPath === col.path && existingColEl._patchEntries) {
    existingColEl._patchEntries(col.entries, col.selIdx);
    return; // reused — skip full rebuild
  }
  // Otherwise fall through and build a new column element.
  _newColAppended = true;
    const colEl=document.createElement('div');
    colEl.className='col';
    const w=state.colWidths[ci]||220;
    colEl.style.cssText=`width:${w}px;min-width:${w}px;flex-shrink:0;`;

    let entries=col.entries;
    if(!state.showHidden) entries=entries.filter(e=>!e.is_hidden);
    if(state.search&&ci===state.columns.length-1){
      const q=state.search.toLowerCase();
      entries=entries.filter(e=>{
        const n=e.name.toLowerCase();
        // Fuzzy: match if exact, prefix, substring, or fuzzy chars in order
        if(n.includes(q))return true;
        if(_fuzzyMatch(n,q))return true;
        return false;
      });
    }
    // Store a cheap fingerprint of the RAW (pre-sort) filtered entries.
    // _patchEntries uses this to skip the expensive sort when directory is unchanged.
    // Format: "count|firstName|lastName" — O(1) to compute and compare.
    // Order-independent fingerprint: min/max name via single O(n) pass.
    // IPC returns entries in arbitrary filesystem order — arr[0]/arr[-1] would
    // give different results on successive calls for the same directory.
    // Using alphabetical min/max ensures the same fp regardless of IPC order.
    const _fp = arr => {
      if (!arr.length) return '0||';
      let min = arr[0].name, max = arr[0].name;
      for (let i = 1; i < arr.length; i++) {
        const n = arr[i].name;
        if (n < min) min = n; else if (n > max) max = n;
      }
      return arr.length + '|' + min + '|' + max;
    };
    let _rawFp = _fp(entries);  // fingerprint of raw filtered entries before sorting
    entries=sortEntries(entries);
    if(ci===state.columns.length-1) sel._e=entries;

    const colList=document.createElement('div');
    colList.className='col-list';
    colList.setAttribute('role','listbox');
    colList.setAttribute('aria-multiselectable','true');
    colList.setAttribute('aria-label',`${col.path.split('/').pop()||col.path} contents`);

    // ── Virtual scroll for column list ────────────────────────────────────────
    // ROW_H=28 enforced by CSS: .col-list .frow { height:28px; margin:0; box-sizing:border-box }
    // Rows are position:absolute; event delegation replaces per-row addEventListener.
    const CROW_H = 28, CROW_OVERSCAN = 6;

    // Spacer div establishes the full scrollable height without rendering all rows.
    const _colSpacer = document.createElement('div');
    _colSpacer.style.cssText = `pointer-events:none;height:${entries.length * CROW_H}px;`;
    colList.appendChild(_colSpacer);

    const _makeColRow = (e, ei) => {
      const _rowTags = state._fileTags?.[e.path] || [];
      const _rowTag  = _rowTags[0];
      // isSel — active selection driven by sel._paths (multi-select aware).
      // isTrail — this column is NOT the last one AND this row is the folder the
      //   user navigated through (col.selIdx). Shown with a muted blue trail
      //   highlight so the full navigation path is always visible, distinct from
      //   the bright active selection in the rightmost column.
      //
      // IMPORTANT: use live DOM index for isTrail, NOT the closure-captured
      // build-time `ci`. Same class of bug fixed in _patchEntries (r7): build-time
      // ci goes stale once columns are added/removed. _paintColList is called from
      // scroll events and ResizeObserver at any point after the column was built,
      // at which time state.columns.length may differ from its build-time value.
      const _rowLiveCI = colEl.parentElement
        ? Array.from(colEl.parentElement.children).indexOf(colEl)
        : ci; // fallback to build-time ci if somehow detached (should not happen)
      const isSel   = sel.hasp(e.path);
      const isTrail = !isSel && (_rowLiveCI !== -1) && (_rowLiveCI < state.columns.length - 1) && col.selIdx === ei;
      const isCut   = state.clipboard.op === 'cut' && state.clipboard.entries?.some(x => x.path === e.path);
      const row = document.createElement('div');
      row.className = `frow${isSel ? ' sel' : ''}${isTrail ? ' trail' : ''}${e.is_hidden ? ' hid' : ''}${isCut ? ' cut-item' : ''}`;
      row.dataset.col = ci; row.dataset.idx = ei; row.dataset.path = e.path; row.dataset.dir = e.is_dir;
      row.setAttribute('role','option'); row.setAttribute('aria-selected',isSel?'true':'false'); row.setAttribute('aria-label',e.name+(e.is_dir?', folder':''));
      row.title = e.name; // tooltip for truncated names
      row.style.cssText = `position:absolute;left:0;right:0;top:${ei * CROW_H}px;`;
      if (!isSel && !isTrail && _rowTag) row.style.background = `${tagColor(_rowTag)}33`;
      row.innerHTML = `<span class="fico" style="color:${fileColor(e)}">${fileIcon(e)}</span><span class="fname" data-path="${e.path.replace(/"/g,'&quot;')}">${escHtml(e.name)}${e.is_symlink ? '<span class="sym-arrow">\u2192</span>' : ''}</span>${e.is_dir ? `<span class="fchev">${I.chev}</span>` : `<span class="fsize">${e.size != null ? fmtSize(e.size) : ''}</span>`}${_rowTags.map(t => `<span class="frow-tag" style="background:${tagColor(t)}"></span>`).join('')}${d().gitBadgeHtml?.(e.path)??''}` ;
      // Async: replace audio file icon with album cover thumbnail
      if (AUDIO_EXTS.includes((e.extension||'').toLowerCase())) {
        const _applyColCover = (coverUrl) => {
          const ico = row.querySelector('.fico');
          if (!ico || !row.isConnected) return;
          const img = document.createElement('img');
          img.src = coverUrl;
          img.style.cssText = 'width:16px;height:16px;object-fit:cover;border-radius:3px;flex-shrink:0;display:block;';
          ico.replaceWith(img);
        };
        if (_audioCoverCache[e.path] && _audioCoverCache[e.path] !== 'loading') {
          _applyColCover(_audioCoverCache[e.path]);
        } else {
          _getAudioCover(e.path).then(cover => { if (cover) _applyColCover(cover); });
        }
      }
      return row;
    };

    let _cPainted = {start:-1, end:-1};
    const _paintColList = () => {
      // Empty state
      const _emptyEl = colList.querySelector('.col-empty-state');
      if(entries.length === 0){
        if(!_emptyEl){
          const em = document.createElement('div');
          em.className = 'col-empty-state';
          em.innerHTML = '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5" style="width:32px;height:32px;opacity:.25"><rect x="8" y="6" width="32" height="36" rx="3"/><line x1="14" y1="16" x2="34" y2="16"/><line x1="14" y1="22" x2="28" y2="22"/><line x1="14" y1="28" x2="24" y2="28"/></svg><span>Empty folder</span>';
          colList.appendChild(em);
        }
        return;
      } else if(_emptyEl){ _emptyEl.remove(); }
      const scrollTop = colList.scrollTop;
      const VH = colList.clientHeight || 400;
      const start = Math.max(0, Math.floor(scrollTop / CROW_H) - CROW_OVERSCAN);
      const end   = Math.min(entries.length - 1, Math.ceil((scrollTop + VH) / CROW_H) + CROW_OVERSCAN);
      if (start === _cPainted.start && end === _cPainted.end) return;
      _cPainted = {start, end};
      for (const ch of [...colList.children]) {
        if (ch === _colSpacer) continue;
        const idx = +ch.dataset.idx;
        if (idx < start || idx > end) ch.remove();
      }
      const existing = new Set([...colList.children].filter(c => c !== _colSpacer).map(c => +c.dataset.idx));
      for (let ei = start; ei <= end; ei++) {
        if (existing.has(ei)) continue;
        const e = entries[ei];
        const row = _makeColRow(e, ei);
        colList.appendChild(row);
        setupDragDrop(row, e, entries);
        if (e.is_dir) setupDropTarget(row, e.path);
      }
    };

    // Event delegation — one listener set covers all rows past, present, and future.
    colList.addEventListener('click', async ev => {
      // ── Guard: bail if this column's DOM element was removed by reconciliation ──
      // Rapid navigation can remove a column from the DOM while a queued click
      // event is still pending in the event loop. Using the stale closure-captured
      // `ci` would splice state.columns at the wrong index and corrupt column state.
      if (!colList.isConnected) return;

      const row = ev.target.closest('.frow');
      if (!row || row.closest('.col-list') !== colList) return;
      const ei = +row.dataset.idx; const entry = entries[ei]; if (!entry) return;
      const isMulti = ev.ctrlKey || ev.metaKey || ev.shiftKey;

      // ── Derive live column index from DOM position ─────────────────────────────
      // Use colEl's position among its siblings — this is always unambiguous and
      // immune to duplicate-path confusion (same directory open in two columns).
      // findIndex by path can match the wrong column if state was rebuilt.
      // Array.from(parent.children).indexOf(colEl) is O(n) but n is always small (≤8).
      const container = colEl.parentElement;
      if (!container) return; // colEl detached between isConnected check and here
      const liveCI = Array.from(container.children).indexOf(colEl);
      if (liveCI === -1) return; // not found — stale colEl, bail
      // Validate the column at this DOM position matches what we expect
      if (liveCI >= state.columns.length) return; // state.columns was truncated, bail

      // CRITICAL: point sel._e at THIS column's entries before any sel operation.
      sel._e = entries;
      if (ev.shiftKey && sel.last >= 0) { sel.range(sel.last, ei); }
      else if (ev.ctrlKey || ev.metaKey) { sel.toggle(ei); }
      else { sel.set(ei); }
      state.selIdx = ei; col.selIdx = ei;
      window.FF?.log('CLICK_ROW', {ci: liveCI, ei, name:entry.name, is_dir:entry.is_dir, selSize:sel.size, isMulti});
      const _sc = {}; document.querySelectorAll('.col-list').forEach((c, i) => _sc[i] = c.scrollTop);
      state.columns.splice(liveCI + 1); state.currentPath = state.columns[liveCI]?.path || col.path;
      const rst = () => requestAnimationFrame(() => document.querySelectorAll('.col-list').forEach((c, i) => { if (_sc[i]) c.scrollTop = _sc[i]; }));
      if (entry.is_dir && sel.size === 1 && !isMulti) {
        window.FF?.log('CLICK_WILL_NAV', {ci: liveCI, name:entry.name, path:entry.path});
        state.previewEntry = entry; state.previewData = null;
        // ── Trail fix (definitive): clear sel._paths BEFORE navigate ────────────
        // The click handler sets sel._paths = {entry.path} above. If we leave it
        // set during navigate(), every streaming render() (first chunk, done chunk,
        // watcher events) sees isSel=true → isTrail=false → the row shows bright
        // .sel instead of muted .trail for the whole duration of the navigation.
        // Deleting entry.path now means ALL renders inside navigate() already see
        // isSel=false, so isTrail fires correctly from the very first streaming frame.
        // col.selIdx (set above) still tracks which row index gets .trail.
        sel._paths.delete(entry.path);
        state.selIdx = -1;
        await navigate(entry.path, liveCI + 1, false);
        rst();
      } else {
        window.FF?.log('CLICK_NO_NAV', {ci: liveCI, name:entry.name, is_dir:entry.is_dir, selSize:sel.size, isMulti});
        await loadPreview(entry); render(); rst();
      }
    });
    colList.addEventListener('auxclick', ev => {
      if(ev.button!==1) return; // middle mouse only
      if (!colList.isConnected) return;
      const row = ev.target.closest('.frow'); if (!row) return;
      const ei=+row.dataset.idx; const e=entries[ei]; if(!e||!e.is_dir) return;
      ev.preventDefault();
      d().newTab?.(e.path);
    });
    colList.addEventListener('dblclick', ev => {
      if (!colList.isConnected) return;
      const row = ev.target.closest('.frow'); if (!row) return;
      const entry = entries[+row.dataset.idx];
      if (entry && !entry.is_dir) invoke('open_file', {path: entry.path}).catch(() => {});
    });
    colList.addEventListener('contextmenu', ev => {
      if (!colList.isConnected) return;
      const row = ev.target.closest('.frow');
      if (!row) {
        // Right-click on empty column space → background context menu
        ev.preventDefault();
        const {sel,render,showContextMenu,buildBgCtxMenu} = d();
        sel.clear(); render();
        showContextMenu(ev.clientX, ev.clientY, buildBgCtxMenu());
        return;
      }
      ev.preventDefault();
      const ei = +row.dataset.idx; const entry = entries[ei]; if (!entry) return;
      const _sc = {}; document.querySelectorAll('.col-list').forEach((c, i) => _sc[i] = c.scrollTop);
      if (!sel.has(ei)) sel.set(ei); state.selIdx = ei; render();
      requestAnimationFrame(() => document.querySelectorAll('.col-list').forEach((c, i) => { if (_sc[i] != null) c.scrollTop = _sc[i]; }));
      showContextMenu(ev.clientX, ev.clientY, buildFileCtxMenu(entry));
    });

    // ── Predictive preloading on directory hover ───────────────────────────────
    // When the user hovers a directory row, fire a background preload_dir so the
    // Rust DIR_CACHE is warm by the time they click (~120–250ms later).
    // Uses a session-level Set to avoid re-invoking on paths already requested.
    // The Rust side also short-circuits immediately on cache hits, so duplicate
    // invokes are harmless but wasteful; the Set prevents them on the JS side.
    colList.addEventListener('mouseover', ev => {
      const row = ev.target.closest('.frow'); if (!row) return;
      if (row.dataset.dir !== 'true') return; // only preload directories
      const path = row.dataset.path; if (!path) return;
      if (_preloadedPaths.has(path)) return; // already warm or already requested
      _preloadedPaths.add(path);
      invoke('preload_dir', {path}).catch(() => {});
    }, {passive: true});

    colList.addEventListener('scroll', _paintColList, {passive: true});
    const _colRO = new ResizeObserver(() => { _cPainted = {start:-1, end:-1}; _paintColList(); });
    // NOTE: _colRO.observe() and the initial-paint double-RAF are registered AFTER
    // container.appendChild(colEl) below, so colList is already in the live DOM
    // when they fire. Observing a detached element causes WebKit2GTK to miss the
    // first size-change notification; the double-RAF with clientHeight=0 paints rows
    // that are clipped invisible by contain:paint on the zero-height parent column.

    // ── Sort indicator header ─────────────────────────────────────────────────
    // Shown on every column so the sort label is always visible.
    colEl.appendChild(colList);
    // ── Sort indicator header — inserted AFTER colEl.appendChild(colList) ──────
    // colEl.insertBefore(sortHdr, colList) requires colList to already be a child
    // of colEl. Calling it before appendChild throws a DOMException, crashing
    // renderColumnView and leaving the column blank with status "Loading...".
    if(true){
      const {sortState} = d();
      const sortLabel = sortState
        ? `${sortState.col==='name'?'Name':sortState.col==='date'?'Date':sortState.col==='size'?'Size':'Kind'} ${sortState.dir>0?'↑':'↓'}`
        : 'Name ↑';
      const sortHdr = document.createElement('div');
      sortHdr.className = 'col-sort-hdr';
      sortHdr.textContent = sortLabel;
      sortHdr.title = 'Click to cycle sort: Name → Date → Size → Kind';
      sortHdr.addEventListener('click', () => {
        const {sortState, saveSortState, render} = d();
        if(!sortState) return;
        const cols = ['name','date','size','kind'];
        const ci2 = cols.indexOf(sortState.col);
        if(ci2 >= 0 && ci2 < cols.length - 1){
          sortState.col = cols[ci2 + 1]; sortState.dir = 1;
        } else if(ci2 === cols.length - 1 && sortState.dir > 0){
          sortState.dir = -1;
        } else {
          sortState.col = 'name'; sortState.dir = 1;
        }
        // FIX: force full column rebuild so the new sort order is applied.
        // Without this, _patchEntries() takes the fingerprint fast-path (same
        // files → same fingerprint) and skips sortEntries() entirely — the
        // column stays in the old order even though sortState just changed.
        colEl.dataset.colPath = '';
        saveSortState?.(); render?.();
      });
      colEl.insertBefore(sortHdr, colList);
    }
    // ── Stable identity for incremental reconciliation ────────────────────
    colEl.dataset.colPath = col.path;
    // _patchEntries: called on subsequent renders when this column's path is unchanged.
    // Updates entries in-place — adjusts spacer height, evicts stale rows,
    // repaints the visible window, and scrolls to selection if needed.
    colEl._patchEntries = (newEntries, newSelIdx) => {
      // ── Live column index — never use closure-captured ci here ────────────────
      // ci is the index at column BUILD time. By the time _patchEntries is called,
      // the user may have navigated deeper (adding columns) or back (removing them),
      // so ci is stale. The glitch on column 5+: ci=4 is retained but
      // state.columns.length may now be 5 (user clicked back), making
      // `4 === 4` fire sel._e and search-filter on the wrong column.
      // Fix: derive live index from colEl's actual DOM position — always unambiguous.
      const liveCI = colEl.parentElement
        ? Array.from(colEl.parentElement.children).indexOf(colEl)
        : ci; // fallback to build-time ci if somehow detached (should not happen)
      const isLast = liveCI !== -1 && liveCI === state.columns.length - 1;

      let pEntries = newEntries;
      if (!state.showHidden) pEntries = pEntries.filter(e => !e.is_hidden);
      if (state.search && isLast) {
        const q = state.search.toLowerCase();
        pEntries = pEntries.filter(e => {
          const n = e.name.toLowerCase();
          if (n.includes(q)) return true;
          if (_fuzzyMatch(n, q)) return true;
          return false;
        });
      }

      // ── Pre-sort fingerprint fast-path ───────────────────────────────────────────────────────────────────────
      // Compare the raw (pre-sort) entry fingerprint against the last accepted one.
      // If count + first + last filename are identical the directory listing hasn't
      // changed — no files added, removed, or renamed to/from boundary positions.
      // Skip sortEntries() entirely; only sync .sel/.cut-item/tag-tint on visible rows.
      //
      // ROOT CAUSE FIX for Downloads/Music freeze:
      // Previously sortEntries() ran on EVERY column on EVERY watcher fire, even for
      // completely unchanged directories. localeCompare({sensitivity:'base'}) on 542
      // Music entries cost ~250ms per call. 13 watcher fires in 8 seconds =
      // ~3.25 seconds of blocked JS main thread = 42% UI unresponsiveness.
      // With this check, unchanged dirs cost ~0.1ms regardless of entry count.
      const newFp = _fp(pEntries);
      if (newFp === _rawFp) {
        if (isLast) sel._e = entries;
        colList.querySelectorAll('.frow').forEach(row => {
          const e = entries[+row.dataset.idx]; if (!e) return;
          const isSel   = sel.hasp(e.path);
          const isTrail = !isSel && !isLast && (+row.dataset.idx === newSelIdx);
          const isCut   = state.clipboard.op === 'cut' &&
                          state.clipboard.entries?.some(x => x.path === e.path);
          row.classList.toggle('sel',      isSel);
          row.classList.toggle('trail',    isTrail);
          row.classList.toggle('cut-item', isCut);
          const _rowAllTags = state._fileTags?.[e.path] || [];
          const _tag = _rowAllTags[0];
          row.style.background = (!isSel && !isTrail && _tag) ? `${tagColor(_tag)}33` : '';
          // FIX: sync tag-dot spans — the fast-path skips _makeColRow so the
          // frow-tag indicators never update when tags are applied/removed.
          const _newTagKey = _rowAllTags.join('\x00');
          if (row.dataset.tagKey !== _newTagKey) {
            row.dataset.tagKey = _newTagKey;
            row.querySelectorAll('.frow-tag').forEach(s => s.remove());
            const _ref = row.querySelector('.fchev, .fsize');
            const _insertBefore = _ref ? _ref.nextSibling : null;
            _rowAllTags.forEach(t => {
              const s = document.createElement('span');
              s.className = 'frow-tag'; s.style.background = tagColor(t);
              row.insertBefore(s, _insertBefore);
            });
          }
        });
        // Scroll new selection into view even when listing is unchanged.
        // Without this, ↑/↓ arrow key updates the .sel class but the column
        // never scrolls, so the highlighted row disappears off-screen.
        if (newSelIdx >= 0 && newSelIdx < entries.length) {
          const targetTop = newSelIdx * CROW_H;
          const VH = colList.clientHeight || 400;
          if (targetTop < colList.scrollTop || targetTop + CROW_H > colList.scrollTop + VH) {
            colList.scrollTop = Math.max(0, targetTop - Math.floor(VH / 2));
            _cPainted = {start: -1, end: -1};
            _paintColList();
          }
        }
        return false; // no listing change — caller should not trigger a full render
      }
      // Fingerprint changed — update it, then sort and proceed to full update
      _rawFp = newFp;
      pEntries = sortEntries(pEntries);

      // ── Post-sort identical check (catches renames of middle entries) ─────────────
      // If sorted result matches existing sorted entries (same files, just IPC
      // returned them in different filesystem order), sync sel only.
      if (pEntries.length === entries.length && entries.length > 0 &&
          pEntries[0].path === entries[0].path &&
          pEntries[pEntries.length - 1].path === entries[pEntries.length - 1].path) {
        if (isLast) sel._e = entries;
        colList.querySelectorAll('.frow').forEach(row => {
          const e = entries[+row.dataset.idx]; if (!e) return;
          const isSel   = sel.hasp(e.path);
          const isTrail = !isSel && !isLast && (+row.dataset.idx === newSelIdx);
          const isCut   = state.clipboard.op === 'cut' &&
                          state.clipboard.entries?.some(x => x.path === e.path);
          row.classList.toggle('sel',      isSel);
          row.classList.toggle('trail',    isTrail);
          row.classList.toggle('cut-item', isCut);
          const _rowAllTags = state._fileTags?.[e.path] || [];
          const _tag = _rowAllTags[0];
          row.style.background = (!isSel && !isTrail && _tag) ? `${tagColor(_tag)}33` : '';
          // FIX: sync tag-dot spans (same fix as pre-sort fast-path above)
          const _newTagKey = _rowAllTags.join('\x00');
          if (row.dataset.tagKey !== _newTagKey) {
            row.dataset.tagKey = _newTagKey;
            row.querySelectorAll('.frow-tag').forEach(s => s.remove());
            const _ref = row.querySelector('.fchev, .fsize');
            const _insertBefore = _ref ? _ref.nextSibling : null;
            _rowAllTags.forEach(t => {
              const s = document.createElement('span');
              s.className = 'frow-tag'; s.style.background = tagColor(t);
              row.insertBefore(s, _insertBefore);
            });
          }
        });
        // Scroll new selection into view (same fix as pre-sort fast-path above)
        if (newSelIdx >= 0 && newSelIdx < entries.length) {
          const targetTop = newSelIdx * CROW_H;
          const VH = colList.clientHeight || 400;
          if (targetTop < colList.scrollTop || targetTop + CROW_H > colList.scrollTop + VH) {
            colList.scrollTop = Math.max(0, targetTop - Math.floor(VH / 2));
            _cPainted = {start: -1, end: -1};
            _paintColList();
          }
        }
        return false; // no listing change — caller should not trigger a full render
      }

      if (isLast) sel._e = pEntries;
      entries = pEntries; // update closure — getEntries() getter now returns this
      _colSpacer.style.height = `${entries.length * CROW_H}px`;

      // ── Clamp selIdx ──────────────────────────────────────────────────────
      // A streaming first-chunk may produce selIdx ≥ entry count; clamp it so
      // the scroll calculation stays within actual list bounds.
      if (newSelIdx >= entries.length) newSelIdx = -1;

      // ── Scroll BEFORE paint ───────────────────────────────────────────────
      // Update colList.scrollTop before evicting rows and calling _paintColList().
      // Painting first then scrolling produces one blank frame (painted rows are
      // position:absolute at the old scroll offset and scroll off-screen before
      // the scroll listener fires _paintColList again). Scroll first so paint
      // reads the final scroll position and emits the correct rows immediately.
      if (newSelIdx >= 0) {
        const targetTop = newSelIdx * CROW_H;
        const VH = colList.clientHeight || 400;
        if (targetTop < colList.scrollTop || targetTop + CROW_H > colList.scrollTop + VH)
          colList.scrollTop = Math.max(0, targetTop - Math.floor(VH / 2));
      }

      // ── Evict stale rows and repaint ──────────────────────────────────────
      _cPainted = {start: -1, end: -1};
      [...colList.children].forEach(ch => { if (ch !== _colSpacer) ch.remove(); });
      _paintColList();
    };
    // ── Click-and-hold drag selection on this column ──────────────────────
    // Pass a getter so attachDragSelect always reads the current entries array.
    // _patchEntries reassigns `entries` in this closure; passing the array directly
    // would leave attachDragSelect holding a stale reference to the first-chunk array
    // (60 items) after the patch render fills in all 893 entries.
    attachDragSelect(colList, () => entries, sel, col, state, render);
    // ── Rubber-band drag selection on this column (empty-space drag) ──────
    // Store the cleanup function returned by attachRubberBand so the reconciliation
    // loop can remove the document mousemove/mouseup listeners when this column is
    // removed. Without this, every column visit permanently adds two document-level
    // handlers that fire on every mouse movement (they exit immediately via !armed,
    // but accumulate to 20+ handlers after deep navigation, causing visible lag).
    colEl._rbCleanup = attachRubberBand(colList, () => {
      const out = [];
      colList.querySelectorAll('.frow').forEach(row => {
        const idx = +row.dataset.idx;
        const r   = row.getBoundingClientRect();
        const lr  = colList.getBoundingClientRect();
        const top  = r.top  - lr.top  + colList.scrollTop;
        const left = r.left - lr.left + colList.scrollLeft;
        out.push({ idx, rect: { left, top, right: left + r.width, bottom: top + r.height } });
      });
      return out;
    }, (hitSet, additive, preview) => {
      if (hitSet.size === 0 && !preview) {
        if (!additive) { sel.clear(); state.selIdx = -1; render(); }
        return;
      }
      const curEntries = entries; // read live entries (updated by _patchEntries)
      sel._e = curEntries;
      if (!additive) sel.clear();
      for (const idx of hitSet) {
        const e = curEntries[idx]; if (!e) continue;
        sel._paths.add(e.path);
        sel.last = idx;
      }
      if (hitSet.size > 0) { state.selIdx = [...hitSet][hitSet.size - 1]; col.selIdx = state.selIdx; }
      // Update row highlight classes live during drag
      colList.querySelectorAll('.frow').forEach(row => {
        const e = curEntries[+row.dataset.idx]; if (!e) return;
        row.classList.toggle('sel', sel.hasp(e.path));
      });
      if (!preview) render();
    });
    const resizeHandle=document.createElement('div');
    resizeHandle.className='col-resize-handle'; resizeHandle.dataset.col=ci;
    resizeHandle.innerHTML='<div class="col-resize-pill"><div class="col-resize-dots"></div></div>';
    resizeHandle.addEventListener('mousedown',e=>startColResize(e,state));
    colEl.appendChild(resizeHandle);
    // Animate new columns: slide-in-right for forward nav, slide-in-left for back
    const _existingCount = container.children.length;
    const _isNewCol = !container.querySelector(`[data-col-path="${CSS.escape(col.path)}"]`);
    if (_isNewCol && _existingCount > 0) {
      const _goingBack = (ci < _existingCount); // fewer cols than current DOM = back-nav
      colEl.classList.add(_goingBack ? 'col-slide-in-left' : 'col-slide-in');
      colEl.addEventListener('animationend', () => {
        colEl.classList.remove('col-slide-in', 'col-slide-in-left');
      }, {once: true});
    }
    container.appendChild(colEl);
    setupDropTarget(colList,col.path);

    // ── ResizeObserver + initial paint — registered HERE, after colEl is in the DOM ──
    // colList.clientHeight is 0 for any detached element. Registering before
    // container.appendChild gives the double-RAF a stale zero height, causing
    // _paintColList to use the 400px fallback and paint rows that are immediately
    // clipped invisible by `contain:paint` on the zero-height parent .col.
    // WebKit2GTK's ResizeObserver also silently misses the initial size notification
    // when observe() is called on an element that isn't yet connected to the DOM.
    // Registering both here — after the element has its real layout dimensions —
    // ensures _paintColList sees the correct clientHeight on first call.
    colEl._colRO = _colRO;
    _colRO.observe(colList);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!colList.isConnected) return; // column removed before first paint
      // _patchEntries (done:true streamer chunk) resets _cPainted and repaints.
      // If it already ran, bail here to avoid a double-repaint at the wrong offset.
      if (_cPainted.start !== -1) return;
      if (col.selIdx >= 0) {
        const targetTop = col.selIdx * CROW_H;
        const VH = colList.clientHeight || 400;
        if (targetTop < colList.scrollTop || targetTop + CROW_H > colList.scrollTop + VH) {
          colList.scrollTop = Math.max(0, targetTop - Math.floor(VH / 2));
        }
      }
      _paintColList();
    }));
  }); // end state.columns.forEach

  // Attach container-level listeners only ONCE — they accumulate across renders otherwise.
  if(!container._listenersAttached){
    container._listenersAttached=true;
    container.addEventListener('contextmenu',e=>{
      // Re-read deps on each event (closures here would capture stale state)
      const {state:s,sel:sl,render:rn,showContextMenu:scm,buildBgCtxMenu:bgm}=d();
      if(!e.target.closest('.frow')){e.preventDefault();sl.clear();rn();scm(e.clientX,e.clientY,bgm());}
    });
    container.addEventListener('mousedown',e=>{
      const {state:s,sel:sl,render:rn}=d();
      if(e.button!==0)return;
      if(e.target.closest('.frow'))return;
      if(!e.ctrlKey&&!e.metaKey&&!e.shiftKey){sl.clear();s.selIdx=-1;rn();}
    });
  }
  // Always scroll to show new column (this was causing jiggle, but removing it breaks visibility)
  // Fix 3a: scroll right to show new column — guarded by sequence counter so a
  // stale rAF callback from a superseded render never hijacks the scroll position.
  // Use two rAFs: first ensures DOM is painted, second ensures layout is computed.
  if(_newColAppended){
    requestAnimationFrame(()=>{
      if(_colRenderSeq !== _mySeq) return; // superseded — don't touch scroll
      // Force layout flush by reading offsetWidth
      const w=host.querySelector('.cols-wrap');
      if(w) { void w.offsetWidth; }
      requestAnimationFrame(()=>{
        if(_colRenderSeq !== _mySeq) return;
        const w=host.querySelector('.cols-wrap');
        if(w) {
          // Force layout flush
          void w.offsetWidth;
          // Scroll to end using max scroll position
          w.scrollLeft = w.scrollWidth;
        }
      });
    });
  }
  // Fix 3b: clamp scrollLeft when columns were removed (navigating back / up).
  // Without this the viewport sits past the last column showing blank grey space.
  if(_colsRemoved){
    requestAnimationFrame(()=>{
      const w=host.querySelector('.cols-wrap');
      if(w) {
        // Force layout flush
        void w.offsetWidth;
        // Clamp scroll position to valid range
        const maxScroll = w.scrollWidth - w.clientWidth;
        if(w.scrollLeft > maxScroll){
          w.scrollLeft = Math.max(0, maxScroll);
        }
      }
    });
  }
}

function startColResize(e,state){
  const ci=+e.currentTarget.dataset.col; const colEl=e.currentTarget.parentElement;
  state.colResizing={idx:ci,startX:e.clientX,startW:colEl.offsetWidth}; e.preventDefault();
  const onMove=ev=>{
    const dx=ev.clientX-state.colResizing.startX;
    const newW=Math.max(120,state.colResizing.startW+dx);
    state.colWidths[state.colResizing.idx]=newW;
    const cols=document.querySelectorAll('.col');
    if(cols[ci]){cols[ci].style.width=newW+'px';cols[ci].style.minWidth=newW+'px';}
  };
  const onUp=()=>{state.colResizing=null;document.removeEventListener('mousemove',onMove);document.removeEventListener('mouseup',onUp);};
  document.addEventListener('mousemove',onMove); document.addEventListener('mouseup',onUp);
}

// ── Drag-select (click-and-hold to highlight rows) ────────────────────────────
// Used in column view: long-hold (600ms) to activate range-select.
//
// DnD vs selection disambiguation — final architecture:
//
//   The 200ms timer approach (r5) was wrong: users who pause briefly before
//   dragging (very common) had their 200ms expire, selection activated,
//   draggable=false, DnD silently failed. Every drag attempt felt broken.
//
//   Correct model — dragstart is the final arbiter:
//     1. mousedown → arm + start 600ms timer
//     2. Pointer moves >5px before timer fires → disarm immediately.
//        DnD proceeds normally (draggable stays true, dragstart fires on the row).
//     3. dragstart fires (capture phase):
//        a. wantSelection=true (timer fired, user held 600ms) →
//           preventDefault + stopPropagation → DnD cancelled → selection proceeds.
//        b. wantSelection=false → disarm → let DnD row handler run.
//     4. Timer fires (600ms, no movement > 5px) → wantSelection=true, activate.
//        Subsequent mousemove drives range selection.
//     5. mouseup → disarm, restore draggable=true.
//
//   With this model, any drag where the user moves within 600ms of mousedown
//   (i.e. every normal drag) works. Selection requires an explicit 600ms hold.
function attachDragSelect(colList, getEntries, sel, col, state, render) {
  let armed         = false;
  let active        = false;
  let wantSelection = false; // timer fired; next dragstart should be cancelled
  let holdTimer     = null;
  let startX = 0, startY = 0;
  let anchorIdx     = -1;
  let lastIdx       = -1;
  let _rafPending   = false;

  const HOLD_MS = 600; // must hold this long without moving to activate selection
  const MOVE_PX = 5;   // movement before timer fires → disarm, DnD proceeds

  const rowIdxAt = (ev) => {
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const row = el ? el.closest('.frow') : null;
    if (!row || row.closest('.col-list') !== colList) return -1;
    return +row.dataset.idx;
  };

  const applyRange = (curIdx) => {
    const entries = getEntries();
    const lo = Math.min(anchorIdx, curIdx);
    const hi = Math.max(anchorIdx, curIdx);
    sel._paths.clear();
    for (let i = lo; i <= hi; i++) {
      if (entries[i]) sel._paths.add(entries[i].path);
    }
    sel.last     = curIdx;
    state.selIdx = curIdx;
    col.selIdx   = curIdx;
  };

  const syncClasses = () => {
    if (_rafPending) return;
    _rafPending = true;
    requestAnimationFrame(() => {
      _rafPending = false;
      const entries = getEntries();
      colList.querySelectorAll('.frow').forEach(r => {
        const e = entries[+r.dataset.idx]; if (!e) return;
        r.classList.toggle('sel', sel.hasp(e.path));
      });
    });
  };

  const activate = () => {
    holdTimer     = null;
    wantSelection = true;
    active        = true;
    if (!sel._e) sel._e = getEntries();
    applyRange(anchorIdx);
    syncClasses();
    document.body.style.userSelect = 'none';
  };

  const disarm = (doRender) => {
    const wasActive = active;
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    armed = false; active = false; wantSelection = false;
    anchorIdx = -1; lastIdx = -1; _rafPending = false;
    // Always restore draggable — may have been set false during selection
    colList.querySelectorAll('.frow').forEach(r => { r.draggable = true; });
    document.body.style.userSelect = '';
    if (wasActive && doRender) render();
  };

  // Capture-phase dragstart — runs before setupDragDrop's bubble-phase handler.
  const onDragStart = (ev) => {
    if (wantSelection) {
      // User held 600ms — cancel DnD, let selection proceed.
      // Now safe to set draggable=false; dragstart is already being cancelled.
      ev.preventDefault();
      ev.stopPropagation();
      colList.querySelectorAll('.frow').forEach(r => { r.draggable = false; });
    } else {
      // User dragged before timer fired — DnD wins; get out of the way.
      disarm(false);
      // Don't preventDefault — let the event reach setupDragDrop's handler.
    }
  };
  colList.addEventListener('dragstart', onDragStart, { capture: true });

  const onDown = (ev) => {
    if (ev.button !== 0) return;
    const row = ev.target.closest('.frow');
    if (!row) {
      // Clicked column background — clear selection
      if (!ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
        const {sel,state,render} = d();
        if (sel.size > 0) { sel.clear(); state.selIdx = -1; render(); }
      }
      return;
    }
    if (ev.target.closest('button,a,input')) return;
    armed         = true;
    active        = false;
    wantSelection = false;
    startX        = ev.clientX;
    startY        = ev.clientY;
    anchorIdx     = +row.dataset.idx;
    lastIdx       = anchorIdx;
    holdTimer     = setTimeout(activate, HOLD_MS);
  };

  const onMove = (ev) => {
    if (!armed && !active) return;

    // Armed but selection not yet active: abort if moved too much
    if (armed && !active) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > MOVE_PX) {
        disarm(false); // DnD proceeds; dragstart will fire on the row
      }
      return;
    }

    // Selection active — drive range at 60fps
    ev.preventDefault();
    const curIdx = rowIdxAt(ev);
    if (curIdx < 0 || curIdx === lastIdx) return;
    lastIdx = curIdx;
    applyRange(curIdx);
    syncClasses();
  };

  const onUp = () => { disarm(true); };

  colList.addEventListener('mousedown', onDown);
  document.addEventListener('mousemove', onMove, { passive: false });
  document.addEventListener('mouseup',   onUp);

  // ── Cleanup: remove document listeners when this column is removed ────────
  // document.addEventListener leaks across column rebuilds — every navigation
  // adds new onMove/onUp to document and the old ones are never removed.
  // After ~20 navigations: 20+ stale handlers on every mousemove event.
  // MutationObserver watches for colList removal and tears them down.
  const _cleanupDragSelect = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup',   onUp);
    _mo.disconnect();
  };
  const _mo = new MutationObserver(() => {
    if (!colList.isConnected) _cleanupDragSelect();
  });
  _mo.observe(document.body, { childList: true, subtree: true });
}
// ── Rubber-band (drag) selection ──────────────────────────────────────────────
// Call attachRubberBand(scrollContainer, getItemRects, onDone) on any view.
// getItemRects() → [{idx, rect:{left,top,right,bottom} in scroll-space}]
// onDone(idxSet, additive, preview)
//   preview=true  → called during drag (highlight only, no navigate)
//   preview=false → called on mouseup (commit selection)
//
export function attachRubberBand(container, getItemRects, onDone) {
  let band = null;
  let startX=0, startY=0;
  let active=false, armed=false;

  const onDown = (ev) => {
    if (ev.button !== 0) return;
    // Don't start rubber-band when clicking on actual items or buttons
    if (ev.target.closest('button,a,input,.icon-item,.list-row,.frow,.gthumb,[draggable="true"]')) return;
    armed=true; active=false;
    const r=container.getBoundingClientRect();
    startX=ev.clientX-r.left+container.scrollLeft;
    startY=ev.clientY-r.top +container.scrollTop;
    ev.preventDefault();
  };

  const onMove = (ev) => {
    if (!armed) return;
    const r=container.getBoundingClientRect();
    const curX=ev.clientX-r.left+container.scrollLeft;
    const curY=ev.clientY-r.top +container.scrollTop;
    const dx=curX-startX, dy=curY-startY;
    if (!active && Math.hypot(dx,dy)<5) return;

    if (!active) {
      active=true;
      band=document.createElement('div');band.id='rubber-band';
      band.style.cssText='position:absolute;pointer-events:none;z-index:9998;border:1.5px solid rgba(91,141,217,0.85);background:rgba(91,141,217,0.1);border-radius:3px;';
      container.style.userSelect='none';
      container.appendChild(band);
    }

    const x1=Math.min(startX,curX), y1=Math.min(startY,curY);
    const x2=Math.max(startX,curX), y2=Math.max(startY,curY);
    band.style.left=x1+'px'; band.style.top=y1+'px';
    band.style.width=(x2-x1)+'px'; band.style.height=(y2-y1)+'px';

    const hit=_hitTest(x1,y1,x2,y2,getItemRects());
    onDone(hit, ev.ctrlKey||ev.metaKey, true);
  };

  const onUp = (ev) => {
    if (!armed) return;
    armed=false;
    if (active) {
      active=false;
      band?.remove(); band=null;
      container.style.userSelect='';
      const r=container.getBoundingClientRect();
      const curX=ev.clientX-r.left+container.scrollLeft;
      const curY=ev.clientY-r.top +container.scrollTop;
      const x1=Math.min(startX,curX), y1=Math.min(startY,curY);
      const x2=Math.max(startX,curX), y2=Math.max(startY,curY);
      const hit=_hitTest(x1,y1,x2,y2,getItemRects());
      onDone(hit, ev.ctrlKey||ev.metaKey, false);
    }
  };

  container.addEventListener('mousedown', onDown);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup',   onUp);
  return ()=>{
    container.removeEventListener('mousedown',onDown);
    document.removeEventListener('mousemove',onMove);
    document.removeEventListener('mouseup',onUp);
    band?.remove();
  };
}

function _hitTest(x1,y1,x2,y2,rects){
  const hit=new Set();
  for(const {idx,rect} of rects){
    if(rect.right>=x1&&rect.left<=x2&&rect.bottom>=y1&&rect.top<=y2) hit.add(idx);
  }
  return hit;
}

// ── Icon view — Pure virtual DOM (no canvas, works in WebKitGTK) ─────────────
// Only renders ~40 visible item divs at a time. SVG icons via innerHTML = instant.
// Thumbnails loaded via object URLs into <img> tags.

const _thumbCache   = new Map(); // path → HTTP URL string
const _thumbPending = new Set();
const MAX_THUMB     = 600;

function _thumbEvict() {
  if (_thumbCache.size < MAX_THUMB) return;
  // Evict oldest 20% in one pass
  let evict = Math.floor(MAX_THUMB * 0.2);
  for (const key of _thumbCache.keys()) {
    _thumbCache.delete(key);
    if (--evict <= 0) break;
  }
}

export function renderIconView(host) {
  const {state,sel,getVisibleEntries,setupDropTarget,showContextMenu,
         buildFileCtxMenu,buildBgCtxMenu,handleEntryClick,navigate}=d();
  const entries = getVisibleEntries();

  // Empty state for icon view
  if(!entries.length){
    host.innerHTML = '<div class="view-empty-state"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="8" y="6" width="32" height="36" rx="3"/><line x1="14" y1="16" x2="34" y2="16"/><line x1="14" y1="22" x2="28" y2="22"/><line x1="14" y1="28" x2="24" y2="28"/></svg><span>Empty folder</span></div>';
    host.addEventListener('contextmenu', ev=>{ev.preventDefault();showContextMenu(ev.clientX,ev.clientY,buildBgCtxMenu());},{once:true});
    return;
  }
  const iconSz  = state.iconSizeIcon || state.iconSize || 80; // r25: per-view size
  const ITEM_W  = iconSz * 2 + 16;
  const ITEM_H  = iconSz + 78;
  const GAP     = 10;
  const ROW_H   = ITEM_H + GAP;
  const OVERSCAN= 2;

  // ── Incremental repaint: same directory/size/count — update selection + tag tint in-place ─
  const existingWrap = host.querySelector('#iv-wrap');
  const meta = host._ivMeta;
  if (existingWrap && meta &&
      meta.path === state.currentPath &&
      meta.iconSz === iconSz &&
      meta.count === entries.length) {
    // Walk only the currently-rendered items and toggle sel + tint in-place.
    // IMPORTANT: do NOT set item.style.background — the CSS rule
    //   background: var(--tag-tint, transparent) !important
    // on .icon-item uses !important which beats any inline style.background.
    // The only correct way is to set/clear the --tag-tint CSS custom property.
    existingWrap.querySelectorAll('.icon-item[data-idx]').forEach(item => {
      const e = entries[+item.dataset.idx];
      if (!e) return;
      const isSel  = sel.hasp(e.path);
      const wasSel = item.classList.contains('sel');
      const _tag   = !isSel ? (state._fileTags?.[e.path]||[])[0] : null;
      const wantTint = isSel
        ? 'rgba(91,141,217,0.28)'
        : (_tag ? tagColor(_tag)+'33' : '');
      const curTint = item.style.getPropertyValue('--tag-tint');
      const selChanged  = isSel !== wasSel;
      const tintChanged = wantTint !== curTint;
      if (!selChanged && !tintChanged) return;

      item.classList.toggle('sel', isSel);
      // Drive background through --tag-tint so the !important CSS rule picks it up
      if (wantTint) {
        item.style.setProperty('--tag-tint', wantTint);
      } else {
        item.style.removeProperty('--tag-tint');
      }
      item.style.outline       = isSel ? '1.5px solid rgba(91,141,217,0.7)' : '';
      item.style.outlineOffset = isSel ? '-1px' : '';
      const lbl = item.lastElementChild;
      if (lbl) lbl.style.color = isSel ? '#fff' : '#e2e8f0';
    });
    return; // No DOM rebuild — no flash
  }

  host.innerHTML ='\n    <div id="iv-wrap" style="height:100%;overflow-y:auto;overflow-x:hidden;position:relative;padding:' + (GAP) + 'px;overscroll-behavior:none;">\n      <div id="iv-spacer" style="pointer-events:none;position:absolute;top:0;left:0;width:1px;"></div>\n      <div id="iv-rows" style="position:relative;"></div>\n    </div>';

  // Stamp meta so incremental path can identify this render
  host._ivMeta = { path: state.currentPath, iconSz, count: entries.length };

  const wrap  = host.querySelector('#iv-wrap');
  const rowsEl= host.querySelector('#iv-rows');
  const spacer= host.querySelector('#iv-spacer');

  setupDropTarget(host, state.currentPath);

  let cols = 1, totalRows = 1;
  let _rendered = {start: -1, end: -1};
  let _scrollTimer = null;

  // ── Thumbnail batch loader ────────────────────────────────────────────────
  // Uses get_thumbnail_url_batch: Rust generates/caches thumbnails, returns
  // filesystem paths. JS loads them via the HTTP media server — zero IPC bytes.
  let _batchQ = new Set(), _batchTimer = null;
  const _queueThumb = paths => {
    paths.forEach(p => { if(!_thumbCache.has(p) && !_thumbPending.has(p)) _batchQ.add(p); });
    clearTimeout(_batchTimer);
    _batchTimer = setTimeout(() => {
      const batch = [..._batchQ]; _batchQ.clear();
      if (!batch.length) return;
      batch.forEach(p => _thumbPending.add(p));
      invoke('get_thumbnail_url_batch', {paths: batch}).then(cachePaths => {
        const {getMediaUrl} = d();
        cachePaths.forEach((cachePath, i) => {
          _thumbPending.delete(batch[i]);
          if (!cachePath) return;
          _thumbEvict();
          // Load via HTTP media server — the cache file is already on disk
          const url = getMediaUrl(cachePath);
          _thumbCache.set(batch[i], url);
          // Update any live img element for this path
          const img = rowsEl.querySelector(`img[data-path="${CSS.escape(batch[i])}"]`);
          if (img) { img.src = url; img.style.display = ''; }
        });
        // Trigger a repaint so newly loaded thumbs appear
        if (cachePaths.some(Boolean)) paint();
      }).catch(() => batch.forEach(p => _thumbPending.delete(p)));
    }, 40);
  };

  // ── Build one item div ────────────────────────────────────────────────────
  const makeItem = (e, idx) => {
    const isSel = sel.hasp(e.path);
    const isCut = state.clipboard.op === 'cut' && state.clipboard.entries?.some(x => x.path === e.path);
    const ext   = (e.extension || '').toLowerCase();
    const isImg   = IMAGE_EXTS.includes(ext);
    const isVideo  = VIDEO_EXTS.includes(ext);
    const thumbUrl = (isImg || isVideo) ? _thumbCache.get(e.path) : null;
    const color = fileColor(e);

    const div = document.createElement('div');
    div.className = `icon-item${isSel ? ' sel' : ''}${e.is_hidden ? ' hid' : ''}${isCut ? ' cut-item' : ''}`;
    div.dataset.idx = idx;
    div.dataset.path = e.path;
    div.setAttribute('role','option'); div.setAttribute('aria-selected', isSel ? 'true' : 'false'); div.setAttribute('aria-label', e.name + (e.is_dir ? ', folder' : ''));
    div.title = e.name;
    const _iconTag = !isSel ? (state._fileTags?.[e.path]||[])[0] : null;
    div.style.cssText = `
      position:absolute;
      width:${ITEM_W}px; height:${ITEM_H}px;
      display:flex; flex-direction:column; align-items:center;
      border-radius:10px; cursor:default; user-select:none;
      padding:6px 4px 4px;
      box-sizing:border-box;
      transition:background 0.1s;
      ${isSel ? '--tag-tint:rgba(91,141,217,0.28);outline:1.5px solid rgba(91,141,217,0.7);outline-offset:-1px;' : (_iconTag ? `--tag-tint:${tagColor(_iconTag)}33;` : '')}
      ${e.is_hidden ? 'opacity:0.45;' : ''}
    `;

    // Icon box
    const box = document.createElement('div');
    box.style.cssText = `
      width:${iconSz}px; height:${iconSz}px;
      border-radius:8px;
      display:flex; align-items:center; justify-content:center;
      flex-shrink:0; overflow:hidden; position:relative;
      background:transparent;
    `;

    if (thumbUrl) {
      const img = document.createElement('img');
      img.src = thumbUrl;
      img.dataset.path = e.path;
      img.style.cssText = `width:100%;height:100%;object-fit:cover;border-radius:7px;display:block;`;
      box.appendChild(img);
      // Play indicator overlay for video thumbnails
      if (isVideo) {
        const play = document.createElement('div');
        play.style.cssText = `position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;`;
        play.innerHTML = `<div style="width:28px;height:28px;background:rgba(0,0,0,0.55);border-radius:50%;display:flex;align-items:center;justify-content:center;"><svg width="12" height="14" viewBox="0 0 12 14" fill="white"><polygon points="1,1 11,7 1,13"/></svg></div>`;
        box.appendChild(play);
      }
    } else {
      // SVG icon — direct innerHTML, guaranteed to render in WebKitGTK
      const iconWrap = document.createElement('div');
      const spSz = Math.round(iconSz * 0.54);
      iconWrap.style.cssText = `width:${spSz}px;height:${spSz}px;color:${color};display:flex;`;
      const rawSvg = fileIcon(e);
      iconWrap.innerHTML = rawSvg;
      const svg = iconWrap.querySelector('svg');
      if (svg) { svg.style.width = spSz+'px'; svg.style.height = spSz+'px'; svg.style.display = 'block'; }
      box.appendChild(iconWrap);
      if (isImg || isVideo) {
        // Hidden placeholder img/video-thumb; will be shown when thumb loads
        const img = document.createElement('img');
        img.dataset.path = e.path;
        img.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:7px;display:none;`;
        img.onload = () => {
          img.style.display = 'block';
          iconWrap.style.display = 'none';
          // Add play overlay once thumbnail is visible
          if (isVideo && !box.querySelector('.play-overlay')) {
            const play = document.createElement('div');
            play.className = 'play-overlay';
            play.style.cssText = `position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;`;
            play.innerHTML = `<div style="width:28px;height:28px;background:rgba(0,0,0,0.55);border-radius:50%;display:flex;align-items:center;justify-content:center;"><svg width="12" height="14" viewBox="0 0 12 14" fill="white"><polygon points="1,1 11,7 1,13"/></svg></div>`;
            box.appendChild(play);
          }
        };
        box.appendChild(img);
      }
    }

    // Tag dots
    const tags = (state._fileTags?.[e.path] || []);
    if (tags.length) {
      const tagRow = document.createElement('div');
      tagRow.style.cssText = 'position:absolute;bottom:5px;right:6px;display:flex;gap:3px;';
      tags.slice(0,5).forEach(t => {
        const dot = document.createElement('span');
        dot.style.cssText = `width:7px;height:7px;border-radius:50%;background:${tagColor(t)};display:block;`;
        tagRow.appendChild(dot);
      });
      box.appendChild(tagRow);
    }

    // Folder item-count badge (mirrors gallery strip badge)
    if (e.is_dir) {
      const ivBadge = document.createElement('span');
      ivBadge.className = 'iv-dir-count';
      ivBadge.style.display = 'none';
      box.appendChild(ivBadge);
      invoke('list_directory_fast', {path: e.path}).then(res => {
        if (!div.isConnected) return;
        const count = res?.entries?.length ?? 0;
        if (count === 0) return;
        ivBadge.textContent = count > 999 ? '999+' : count;
        const tint = count >= 500 ? 'rgba(139,92,246,.55)'
                   : count >= 100 ? 'rgba(59,130,246,.55)'
                   : count >=  10 ? 'rgba(56,189,248,.45)'
                   :                'rgba(148,163,184,.35)';
        ivBadge.style.background = tint;
        ivBadge.style.display = 'flex';
      }).catch(() => {});
    }

    // Label
    const lbl = document.createElement('span');
    lbl.style.cssText = `
      margin-top:5px; font-size:${Math.max(11, state.fontSize||12)}px;
      color:${isSel ? '#fff' : '#e2e8f0'}; text-align:center;
      line-height:1.3; word-break:break-word;
      max-height:3.9em; overflow:hidden;
      width:100%; padding:0 3px; box-sizing:border-box;
      display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:3;
      text-shadow: 0 1px 3px rgba(0,0,0,0.7);
    `;
    lbl.className = 'ico-lbl';
    lbl.dataset.path = e.path; // r25: needed by startRename for element lookup
    lbl.textContent = e.name;

    div.appendChild(box);
    div.appendChild(lbl);
    return div;
  };

  // ── Virtual render: only paint visible rows ───────────────────────────────
  const paint = () => {
    const W = wrap.clientWidth - GAP * 2;
    if (!W) return;
    cols = Math.max(1, Math.floor((W + GAP) / (ITEM_W + GAP)));
    state._iconCols = cols;
    totalRows = Math.ceil(entries.length / cols);
    const totalH = totalRows * ROW_H;
    spacer.style.height = totalH + 'px';
    rowsEl.style.height = totalH + 'px';

    const scrollTop = wrap.scrollTop;
    const VH = wrap.clientHeight || 400;
    const startRow = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    const endRow   = Math.min(totalRows - 1, Math.ceil((scrollTop + VH) / ROW_H) + OVERSCAN);

    if (startRow === _rendered.start && endRow === _rendered.end) return;
    _rendered = {start: startRow, end: endRow};

    // Remove items outside window
    for (const ch of [...rowsEl.children]) {
      const i = +ch.dataset.idx;
      const r = Math.floor(i / cols);
      if (r < startRow || r > endRow) ch.remove();
    }

    // Add missing items
    const existing = new Set([...rowsEl.children].map(c => +c.dataset.idx));
    const needThumb = [];

    for (let row = startRow; row <= endRow; row++) {
      for (let col = 0; col < cols; col++) {
        const idx = row * cols + col;
        if (idx >= entries.length) break;
        if (existing.has(idx)) continue;

        const e = entries[idx];
        const item = makeItem(e, idx);
        item.style.left = (GAP + col * (ITEM_W + GAP)) + 'px';
        item.style.top  = (row * ROW_H) + 'px';

        // Events
        item.addEventListener('click', async ev => {
          // Snapshot scroll NOW — handleEntryClick→render() will destroy iv-wrap
          state._iconScroll = {path: state.currentPath, top: wrap.scrollTop};
          // Slow double-click on label (already selected item) → inline rename
          const lbl = ev.target.closest('.ico-lbl');
          if(lbl && sel.has(idx) && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey){
            // Already selected — start rename timer (macOS Finder behaviour)
            clearTimeout(item._renameTimer);
            item._renameTimer = setTimeout(() => {
              const {startRename} = d();
              if(startRename) startRename(e);
            }, 600);
            return;
          }
          clearTimeout(item._renameTimer);
          await handleEntryClick(e, idx, ev); paint();
        });
        item.addEventListener('mousedown', () => { clearTimeout(item._renameTimer); });
        item.addEventListener('dblclick', () => {
          if (e.is_dir) navigate(e.path, 0);
          else invoke('open_file', {path: e.path}).catch(() => {});
        });
        item.addEventListener('contextmenu', ev => {
          ev.preventDefault();
          if (!sel.has(idx)) sel.set(idx);
          state.selIdx = idx; d().render();
          showContextMenu(ev.clientX, ev.clientY, buildFileCtxMenu(e));
        });

        rowsEl.appendChild(item);

        const ext = (e.extension || '').toLowerCase();
        if ((IMAGE_EXTS.includes(ext) || VIDEO_EXTS.includes(ext)) && !_thumbCache.has(e.path)) needThumb.push(e.path);
        // Load audio cover and swap it into the icon box
        if (AUDIO_EXTS.includes(ext)) {
          const _applyAudioCoverToItem = (coverUrl) => {
            const box = item.querySelector('div'); // icon box is first child div
            if (!box || !box.isConnected) return;
            const iconWrap = box.querySelector('div'); // inner icon wrap
            if (!iconWrap) return;
            const coverImg = document.createElement('img');
            coverImg.src = coverUrl;
            coverImg.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:7px;display:block;';
            iconWrap.replaceWith(coverImg);
          };
          if (_audioCoverCache[e.path] && _audioCoverCache[e.path] !== 'loading') {
            _applyAudioCoverToItem(_audioCoverCache[e.path]);
          } else {
            _getAudioCover(e.path).then(cover => { if (cover) _applyAudioCoverToItem(cover); });
          }
        }
      }
    }

    if (needThumb.length) _queueThumb(needThumb);
  };

  wrap.addEventListener('mousedown', ev => {
    if (ev.button !== 0) return;
    if (!ev.target.closest('.icon-item')) {
      if (!ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
        const {sel,state,render} = d();
        if (sel.size > 0) { sel.clear(); state.selIdx = -1; render(); }
      }
    }
  });
  wrap.addEventListener('contextmenu', ev => {
    if (!ev.target.closest('.icon-item')) {
      ev.preventDefault(); sel.clear(); d().render();
      showContextMenu(ev.clientX, ev.clientY, buildBgCtxMenu());
    }
  });

  wrap.addEventListener('scroll', () => {
    if (!wrap._scrolling) { wrap._scrolling = true; document.body.classList.add('is-scrolling'); }
    clearTimeout(_scrollTimer);
    _scrollTimer = setTimeout(() => { wrap._scrolling = false; document.body.classList.remove('is-scrolling'); }, 100);
    paint();
  }, {passive: true});

  const ro = new ResizeObserver(() => { _rendered = {start:-1,end:-1}; paint(); });
  ro.observe(wrap);

  // ── Rubber-band drag selection ─────────────────────────────────────────────
  const getRects = () => {
    const out = [];
    for (const item of rowsEl.children) {
      const idx = +item.dataset.idx;
      const left  = parseFloat(item.style.left);
      const top   = parseFloat(item.style.top);
      out.push({ idx, rect: { left, top, right: left+ITEM_W, bottom: top+ITEM_H } });
    }
    return out;
  };
  attachRubberBand(wrap, getRects, (hitSet, additive, preview) => {
    // Empty drag on non-additive mouseup → deselect all (drag to blank space)
    if (hitSet.size === 0 && !preview) { if (!additive) { sel.clear(); state.selIdx=-1; d().render(); } return; }
    if (!additive) sel.clear();
    for (const idx of hitSet) {
      const e = entries[idx]; if (!e) continue;
      sel._paths.add(e.path);
      sel.last = idx;
    }
    if (hitSet.size > 0) state.selIdx = [...hitSet][hitSet.size-1];
    paint();
    if (!preview) d().render();
  });

  // Click on empty space (no drag) → deselect all.
  // Use mousedown so it fires before rubber-band and before any item click.
  // Only fires when the target is the wrap or rowsEl/spacer itself (not an item).
  wrap.addEventListener('mousedown', ev => {
    if (ev.button !== 0) return;
    if (ev.target.closest('.icon-item')) return; // clicking an item — handled by item listener
    // Will be a click or start of rubber-band drag. Either way clear immediately.
    // If the drag goes on to select items the rubber-band callback restores selection.
    // NOTE: must call d().render(), NOT paint(). paint() has an early-return guard:
    //   if (startRow === _rendered.start && endRow === _rendered.end) return;
    // which fires here because scroll position hasn't changed — so paint() does nothing
    // and the items never lose their .sel class visually. d().render() goes through
    // renderIconView's incremental path which correctly walks all .icon-item elements
    // and toggles .sel.
    if (!ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
      sel.clear(); state.selIdx = -1; d().render();
    }
  });

  // First paint after layout resolves; restore scroll if same directory
  const _savedScroll = (state._iconScroll?.path === state.currentPath) ? (state._iconScroll.top||0) : 0;
  requestAnimationFrame(() => {
    if (_savedScroll) {
      // Pre-compute spacer height (same formula as paint()) BEFORE setting scrollTop
      // so the browser never sees a frame at scrollTop=0 during the restore.
      const W = wrap.clientWidth - GAP * 2;
      const c = Math.max(1, Math.floor((W + GAP) / (ITEM_W + GAP)));
      const rows = Math.ceil(entries.length / c);
      const h = rows * ROW_H;
      spacer.style.height = h + 'px';
      rowsEl.style.height  = h + 'px';
      wrap.scrollTop = _savedScroll;
    }
    paint();
  });
}


// ── List view ─────────────────────────────────────────────────────────────────
export function renderListView(host){
  const {state,sel,getVisibleEntries,sortState,setupDragDrop,setupDropTarget,
         showContextMenu,buildFileCtxMenu,buildBgCtxMenu,handleEntryClick,navigate,render}=d();

  // List view manages its own per-column sort (state.listSort) independently of
  // the global sort picker (sortState/sortEntries, used by column/icon/gallery views).
  // sortEntries() no longer overwrites state.listSort, so header clicks actually work.
  const raw = getVisibleEntries();
  const {col, dir:sd} = state.listSort;
  const ff = sortState?.foldersFirst ?? true;
  const entries = [...raw].sort((a,b)=>{
    if(ff && a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    if(col==='date') return sd*((a.modified||0)-(b.modified||0)) || a.name.localeCompare(b.name);
    if(col==='size') return sd*((a.size||0)-(b.size||0))         || a.name.localeCompare(b.name);
    if(col==='kind'){
      const ka=a.is_dir?'Folder':(a.extension||''); const kb=b.is_dir?'Folder':(b.extension||'');
      return sd*ka.localeCompare(kb) || a.name.localeCompare(b.name);
    }
    if(col==='loc'){
      const la=a.path.slice(0,a.path.lastIndexOf('/')||1);
      const lb=b.path.slice(0,b.path.lastIndexOf('/')||1);
      return sd*la.localeCompare(lb) || a.name.localeCompare(b.name);
    }
    return sd*a.name.localeCompare(b.name,undefined,{sensitivity:'base'});
  });
  // FIX (RC2-R1 Bug 1+3): point sel._e at the list-sorted array immediately so
  // ALL subsequent operations — keyboard nav, getSelectedEntries(), context menu,
  // Open With, etc. — resolve indices against the correct visual order rather than
  // the global sortEntries() order that getVisibleEntries() left in sel._e.
  sel._e = entries;
  const arrow=c=>col===c?`<span class="sort-arrow">${sd>0?'↑':'↓'}</span>`:'';

  // ── Virtual list view ────────────────────────────────────────────────────
  // Table-spacer approach: keep real <table> for column alignment; only the visible
  // rows are in the DOM. Two sentinel <tr> spacers hold the total scroll height.
  // LV_ROW_H is measured from the first rendered row so it always matches CSS exactly.
  let LV_ROW_H = 29; // initial estimate; overwritten after first paint
  const LV_OVERSCAN = 6;

  // Empty state
  if(!entries.length){
    host.innerHTML = '<div class="view-empty-state"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="8" y="6" width="32" height="36" rx="3"/><line x1="14" y1="16" x2="34" y2="16"/><line x1="14" y1="22" x2="28" y2="22"/><line x1="14" y1="28" x2="24" y2="28"/></svg><span>Empty folder</span></div>';
    host.addEventListener('contextmenu', ev=>{ev.preventDefault();showContextMenu(ev.clientX,ev.clientY,buildBgCtxMenu());},{once:true});
    return;
  }
  const _inSearch = state.searchMode;
  host.innerHTML=`<div class="list-wrap" id="lv-wrap">
    <table class="list-table">
      <colgroup>
        <col id="col-name" style="width:${state.colWidths['l-name']||300}px">
        ${_inSearch?`<col id="col-loc" style="width:${state.colWidths['l-loc']||200}px">`:''}
        <col id="col-date" style="width:${state.colWidths['l-date']||180}px">
        <col id="col-size" style="width:${state.colWidths['l-size']||90}px">
        <col id="col-kind" style="width:${state.colWidths['l-kind']||100}px">
      </colgroup>
      <thead class="list-head"><tr>
        <th data-col="name" class="${col==='name'?'sorted':''}">Name ${arrow('name')}<div class="th-resize" data-col="l-name"></div></th>
        ${_inSearch?`<th data-col="loc" class="${col==='loc'?'sorted':''}">Location ${arrow('loc')}<div class="th-resize" data-col="l-loc"></div></th>`:''}
        <th data-col="date" class="${col==='date'?'sorted':''}">Date Modified ${arrow('date')}<div class="th-resize" data-col="l-date"></div></th>
        <th data-col="size" class="${col==='size'?'sorted':''}">Size ${arrow('size')}<div class="th-resize" data-col="l-size"></div></th>
        <th data-col="kind" class="${col==='kind'?'sorted':''}">Kind ${arrow('kind')}</th>
      </tr></thead>
      <tbody id="lv-body">
        <tr class="lv-spacer" id="lv-top"><td colspan="${_inSearch?5:4}" style="padding:0;border:0;height:0"></td></tr>
        <tr class="lv-spacer" id="lv-bot"><td colspan="${_inSearch?5:4}" style="padding:0;border:0;height:0"></td></tr>
      </tbody>
    </table>
  </div>`;

  host.querySelectorAll('.list-head th').forEach(th=>{
    th.addEventListener('click',ev=>{
      if(ev.target.closest('.th-resize'))return;
      const c=th.dataset.col;
      if(state.listSort.col===c)state.listSort.dir*=-1;else{state.listSort.col=c;state.listSort.dir=1;}
      // FIX (RC2-R1 Bug 2): clear selection when sort column changes so stale
      // selIdx doesn't highlight the wrong file after rows reorder.
      sel.clear(); state.selIdx=-1;
      renderListView(host);
    });
  });
  host.querySelectorAll('.th-resize').forEach(handle=>{
    handle.addEventListener('mousedown',e=>{
      e.stopPropagation();
      const colKey=handle.dataset.col,startX=e.clientX,startW=state.colWidths[colKey]||300;
      const onMove=ev=>{state.colWidths[colKey]=Math.max(60,startW+(ev.clientX-startX));const colEl=host.querySelector(`#col-${colKey.replace('l-','')}`);if(colEl)colEl.style.width=state.colWidths[colKey]+'px';};
      const onUp=()=>{document.removeEventListener('mousemove',onMove);document.removeEventListener('mouseup',onUp);};
      document.addEventListener('mousemove',onMove);document.addEventListener('mouseup',onUp);
    });
  });
  setupDropTarget(host,state.currentPath);

  const lvWrap  = host.querySelector('#lv-wrap');
  const lvBody  = host.querySelector('#lv-body');
  const lvTopTd = host.querySelector('#lv-top td');
  const lvBotTd = host.querySelector('#lv-bot td');
  const lvBotTr = host.querySelector('#lv-bot');

  // Build a single list-view table row as a <tr> element
  const _makeLvRow = (e, i) => {
    const isSel = sel.hasp(e.path);
    const isCut = state.clipboard.op==='cut' && state.clipboard.entries.some(x=>x.path===e.path);
    const _rowTag = !isSel?(state._fileTags?.[e.path]||[])[0]:null;
    const tdBg = _rowTag?` style="background:${tagColor(_rowTag)}33"`:'' ;
    const tr = document.createElement('tr');
    tr.className = `list-row${isSel?' sel':''}${e.is_hidden?' hid':''}${isCut?' cut-item':''}`;
    tr.dataset.idx = i; tr.dataset.path = e.path; tr.dataset.dir = e.is_dir;
    tr.setAttribute('role','row'); tr.setAttribute('aria-selected',isSel?'true':'false'); tr.setAttribute('aria-label',e.name+(e.is_dir?', folder':''));
    tr.title = e.name;
    tr.innerHTML = `
      <td class="cell-name"${tdBg}>
        <span class="fico" style="color:${fileColor(e)};width:16px;height:16px;display:inline-flex;align-items:center;flex-shrink:0">${fileIcon(e)}</span>
        <span class="cell-name-text" data-path="${e.path.replace(/"/g,'&quot;')}">${escHtml(e.name)}${e.is_symlink?'<span class="sym-arrow">\u2192</span>':''}</span>
        ${(state._fileTags?.[e.path]||[]).map(t=>`<span class="row-tag" style="background:${tagColor(t)}22;color:${tagColor(t)};border:1px solid ${tagColor(t)}44">${t}</span>`).join('')}${d().gitBadgeHtml?.(e.path)??''}
      </td>
      ${_inSearch?`<td class="cell-meta" title="${escHtml(e.path.slice(0,e.path.lastIndexOf('/')||1))}"${tdBg} style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;opacity:.75">${escHtml(e.path.slice(0,e.path.lastIndexOf('/')||1)||'/')}</td>`:''}
      <td class="cell-meta"${tdBg}>${fmtDate(e.modified)}</td>
      <td class="cell-meta"${tdBg}>${e.is_dir?'--':fmtSize(e.size)}</td>
      <td class="cell-meta"${tdBg}>${e.is_dir?'Folder':(e.extension?e.extension.toUpperCase()+' file':'File')}</td>`;
    // Async: replace audio file icon with album cover thumbnail
    if (AUDIO_EXTS.includes((e.extension||'').toLowerCase())) {
      const _applyLvCover = (coverUrl) => {
        const ico = tr.querySelector('.fico');
        if (!ico || !tr.isConnected) return;
        const img = document.createElement('img');
        img.src = coverUrl;
        img.style.cssText = 'width:16px;height:16px;object-fit:cover;border-radius:3px;flex-shrink:0;display:block;';
        ico.replaceWith(img);
      };
      if (_audioCoverCache[e.path] && _audioCoverCache[e.path] !== 'loading') {
        _applyLvCover(_audioCoverCache[e.path]);
      } else {
        _getAudioCover(e.path).then(cover => { if (cover) _applyLvCover(cover); });
      }
    }
    return tr;
  };

  let _lvPainted = {start:-1, end:-1};
  const _paintLv = () => {
    if (!lvWrap) return;
    const scrollTop = lvWrap.scrollTop;
    const VH = lvWrap.clientHeight || 600;
    const start = Math.max(0, Math.floor(scrollTop / LV_ROW_H) - LV_OVERSCAN);
    const end   = Math.min(entries.length - 1, Math.ceil((scrollTop + VH) / LV_ROW_H) + LV_OVERSCAN);
    if (start === _lvPainted.start && end === _lvPainted.end) return;
    _lvPainted = {start, end};

    lvTopTd.style.height = (start * LV_ROW_H) + 'px';
    lvBotTd.style.height = Math.max(0, (entries.length - 1 - end) * LV_ROW_H) + 'px';

    // Remove rows outside window
    for (const tr of [...lvBody.querySelectorAll('.list-row')]) {
      const i = +tr.dataset.idx;
      if (i < start || i > end) tr.remove();
    }

    // Insert missing rows in correct order (maintain ascending idx between spacers)
    const existing = new Set([...lvBody.querySelectorAll('.list-row')].map(r => +r.dataset.idx));
    for (let i = start; i <= end; i++) {
      if (existing.has(i)) continue;
      const e = entries[i];
      const tr = _makeLvRow(e, i);
      // Insert before the first existing row whose idx > i, or before botSpacer
      const after = [...lvBody.querySelectorAll('.list-row')].find(r => +r.dataset.idx > i);
      lvBody.insertBefore(tr, after || lvBotTr);
      setupDragDrop(tr, e, entries);
      if (e.is_dir) setupDropTarget(tr, e.path);
    }
  };

  // Event delegation on lvWrap — one listener set for all rows
  lvWrap?.addEventListener('contextmenu', e => {
    if (!e.target.closest('.list-row')) { e.preventDefault(); sel.clear(); render(); showContextMenu(e.clientX, e.clientY, buildBgCtxMenu()); }
  });
  lvWrap?.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.target.closest('.list-row')) return;
    if (!e.ctrlKey && !e.metaKey && !e.shiftKey) { sel.clear(); state.selIdx = -1; render(); }
  });
  lvWrap?.addEventListener('click', async ev => {
    const row = ev.target.closest('.list-row'); if (!row) return;
    const i = +row.dataset.idx; const entry = entries[i]; if (!entry) return;
    const sv = lvWrap.scrollTop;
    // CRITICAL: point sel._e at sorted entries before handleEntryClick.
    // handleEntryClick uses sel._e[idx] for range/toggle/set operations.
    sel._e = entries;
    await handleEntryClick(entry, i, ev);
    // After handleEntryClick→render()→renderListView(), host.innerHTML is rebuilt
    // and the captured `lvWrap` is detached — setting scrollTop on a detached
    // element is silently ignored. Use a fresh querySelector on `host` (which is
    // the stable #view-host element, untouched by the rebuild) to find the new
    // #lv-wrap and restore its scroll position.
    requestAnimationFrame(() => { const lw = host.querySelector('#lv-wrap'); if (lw) lw.scrollTop = sv; });
  });
  lvWrap?.addEventListener('auxclick', ev => {
    if(ev.button!==1) return;
    const row = ev.target.closest('.list-row'); if(!row) return;
    const entry = entries[+row.dataset.idx]; if(!entry||!entry.is_dir) return;
    ev.preventDefault(); d().newTab?.(entry.path);
  });
  lvWrap?.addEventListener('dblclick', ev => {
    const row = ev.target.closest('.list-row'); if (!row) return;
    const entry = entries[+row.dataset.idx]; if (!entry) return;
    if (entry.is_dir) navigate(entry.path, 0);
    else invoke('open_file', {path: entry.path}).catch(() => {});
  });
  lvWrap?.addEventListener('contextmenu', ev => {
    const row = ev.target.closest('.list-row'); if (!row) return;
    ev.preventDefault();
    const i = +row.dataset.idx; const entry = entries[i]; if (!entry) return;
    const sv = lvWrap.scrollTop;
    sel._e = entries;
    if (!sel.has(i)) sel.set(i); state.selIdx = i;
    render();
    // Same detached-reference fix as the click handler above.
    requestAnimationFrame(() => { const lw = host.querySelector('#lv-wrap'); if (lw) lw.scrollTop = sv; });
    showContextMenu(ev.clientX, ev.clientY, buildFileCtxMenu(entry));
  });

  lvWrap?.addEventListener('scroll', _paintLv, {passive: true});
  new ResizeObserver(() => { _lvPainted = {start:-1, end:-1}; _paintLv(); }).observe(lvWrap);
  requestAnimationFrame(() => {
    _paintLv(); // initial paint with estimated LV_ROW_H
    // Measure the actual row height from the first rendered row and repaint if it differs.
    const firstRow = lvBody?.querySelector('.list-row');
    if (firstRow) {
      const measured = firstRow.getBoundingClientRect().height;
      if (measured > 0 && Math.round(measured) !== LV_ROW_H) {
        LV_ROW_H = Math.round(measured);
        _lvPainted = {start:-1, end:-1};
        _paintLv();
      }
    }
  });


  // ── Rubber-band drag selection on list ──────────────────────────────────
  const listWrap = host.querySelector('.list-wrap');
  if (listWrap) {
    const getListRects = () => {
      const out = [];
      host.querySelectorAll('.list-row').forEach(row => {
        const idx = +row.dataset.idx;
        const r = row.getBoundingClientRect();
        const wr = listWrap.getBoundingClientRect();
        const top    = r.top  - wr.top  + listWrap.scrollTop;
        const left   = r.left - wr.left + listWrap.scrollLeft;
        out.push({ idx, rect: { left, top, right: left+r.width, bottom: top+r.height } });
      });
      return out;
    };
    attachRubberBand(listWrap, getListRects, (hitSet, additive, preview) => {
      if (hitSet.size === 0 && !preview) {
        if (!additive) { sel.clear(); state.selIdx = -1; render(); }
        return;
      }
      if (!additive) sel.clear();
      for (const idx of hitSet) {
        const e = entries[idx]; if (!e) continue;
        sel._paths.add(e.path);
        sel.last = idx;
      }
      if (hitSet.size > 0) state.selIdx = [...hitSet][hitSet.size-1];
      // Update row highlight classes live during drag
      host.querySelectorAll('.list-row').forEach(row => {
        const e = entries[+row.dataset.idx];
        if (!e) return;
        row.classList.toggle('sel', sel.hasp(e.path));
      });
      if (!preview) render();
    });
  }
}


// Highlight matching substring in search results
function _hlMatch(name, query) {
  if(!query) return escHtml(name);
  // Strip regex: prefix and use raw query for highlight
  const q = query.startsWith('regex: ') ? '' : query;
  if(!q) return escHtml(name);
  try {
    const re = new RegExp('('+q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+')', 'gi');
    return escHtml(name).replace(re, '<mark class="search-hl">$1</mark>');
  } catch(_) { return escHtml(name); }
}

function _wireFilterBar(host, render) {
  const {state} = d();
  if (!host.querySelector('.sr-csel')) return;
  const apply = () => render();

  // Custom selects — close all popups then toggle the clicked one
  const closeAll = () => host.querySelectorAll('.sr-csel.open').forEach(el => el.classList.remove('open'));
  host.querySelectorAll('.sr-csel').forEach(csel => {
    csel.querySelector('.sr-csel-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      const wasOpen = csel.classList.contains('open');
      closeAll();
      if (!wasOpen) csel.classList.add('open');
    });
    csel.querySelectorAll('.sr-csel-opt').forEach(opt => {
      opt.addEventListener('click', e => {
        e.stopPropagation();
        const val = opt.dataset.val;
        const id = csel.id;
        csel.querySelector('.sr-csel-label').textContent = opt.textContent;
        csel.querySelectorAll('.sr-csel-opt').forEach(o => o.classList.toggle('active', o === opt));
        if (id === 'sr-ftype') state._srFilter.type = val;
        if (id === 'sr-fdate') state._srFilter.date = val;
        closeAll();
        apply();
      });
    });
  });
  // Close on outside click
  document.addEventListener('click', closeAll, {once: true, capture: true});

  let _sft=null;
  host.querySelector('#sr-fmin')?.addEventListener('input', e => { clearTimeout(_sft); _sft=setTimeout(()=>{state._srFilter.minSize=e.target.value;apply();},400); });
  host.querySelector('#sr-fmax')?.addEventListener('input', e => { clearTimeout(_sft); _sft=setTimeout(()=>{state._srFilter.maxSize=e.target.value;apply();},400); });
  host.querySelector('#sr-fclr')?.addEventListener('click', () => { state._srFilter={type:'',minSize:'',maxSize:'',date:''}; apply(); });
}

export function renderFlatList(host,entries){
  const {state,sel,handleEntryClick,navigate,render,showContextMenu,
         buildFileCtxMenu,buildBgCtxMenu,setupDragDrop,setupDropTarget}=d();
  if(state.loading){host.innerHTML='<div class="search-loading"><div class="spinner"></div><span>Searching all drives...</span></div>';return;}

  // Apply hidden-file filter
  if(!state.showHidden) entries=entries.filter(x=>!x.is_hidden);

  // ── Search filters ─────────────────────────────────────────────────────────
  // Persistent per-session filter state on state (not tab-persisted — intentional)
  if(!state._srFilter) state._srFilter={type:'',minSize:'',maxSize:'',date:''};
  const sf=state._srFilter;
  // Apply filters client-side
  let filtered=entries;
  if(sf.type==='folder') filtered=filtered.filter(e=>e.is_dir);
  else if(sf.type) filtered=filtered.filter(e=>!e.is_dir&&(e.extension||'').toLowerCase()===sf.type);
  if(sf.minSize){const mb=parseFloat(sf.minSize)*1024*1024;filtered=filtered.filter(e=>!e.is_dir&&(e.size||0)>=mb);}
  if(sf.maxSize){const mb=parseFloat(sf.maxSize)*1024*1024;filtered=filtered.filter(e=>!e.is_dir&&(e.size||0)<=mb);}
  if(sf.date){
    const cutoff=Date.now()-({'1d':86400,'7d':7*86400,'30d':30*86400}[sf.date]||0)*1000;
    filtered=filtered.filter(e=>(e.modified||0)*1000>=cutoff);
  }

  // Collect distinct file types for the type dropdown
  const typeSet=new Set(entries.filter(e=>!e.is_dir&&e.extension).map(e=>(e.extension||'').toLowerCase()));
  const hasFolder=entries.some(e=>e.is_dir);
  const typeLabel=sf.type===''?'All types':sf.type==='folder'?'Folders':sf.type.toUpperCase();
  const dateLabel={'':'Any date','1d':'Today','7d':'Last 7 days','30d':'Last 30 days'}[sf.date]||'Any date';
  const _chev=`<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
  const typeOptHtml=[
    `<div class="sr-csel-opt${sf.type===''?' active':''}" data-val="">All types</div>`,
    hasFolder?`<div class="sr-csel-opt${sf.type==='folder'?' active':''}" data-val="folder">Folders</div>`:'',
    ...[...typeSet].sort().map(t=>`<div class="sr-csel-opt${sf.type===t?' active':''}" data-val="${escHtml(t)}">${t.toUpperCase()}</div>`)
  ].join('');
  const dateOptHtml=[
    `<div class="sr-csel-opt${sf.date===''?' active':''}" data-val="">Any date</div>`,
    `<div class="sr-csel-opt${sf.date==='1d'?' active':''}" data-val="1d">Today</div>`,
    `<div class="sr-csel-opt${sf.date==='7d'?' active':''}" data-val="7d">Last 7 days</div>`,
    `<div class="sr-csel-opt${sf.date==='30d'?' active':''}" data-val="30d">Last 30 days</div>`,
  ].join('');

  const activeFilters=sf.type||sf.minSize||sf.maxSize||sf.date;
  const filterBarHtml=`<div class="sr-filter-bar">
    <div class="sr-csel" id="sr-ftype">
      <button class="sr-csel-btn" type="button"><span class="sr-csel-label">${escHtml(typeLabel)}</span>${_chev}</button>
      <div class="sr-csel-popup">${typeOptHtml}</div>
    </div>
    <div class="sr-csel" id="sr-fdate">
      <button class="sr-csel-btn" type="button"><span class="sr-csel-label">${escHtml(dateLabel)}</span>${_chev}</button>
      <div class="sr-csel-popup">${dateOptHtml}</div>
    </div>
    <div class="sr-filter-size">
      <input class="sr-filter-input" id="sr-fmin" type="number" placeholder="Min MB" min="0" value="${escHtml(sf.minSize)}" title="Min size in MB">
      <span class="sr-filter-sep">–</span>
      <input class="sr-filter-input" id="sr-fmax" type="number" placeholder="Max MB" min="0" value="${escHtml(sf.maxSize)}" title="Max size in MB">
      <span class="sr-filter-unit">MB</span>
    </div>
    ${activeFilters?'<button class="sr-filter-clear" id="sr-fclr">Clear filters</button>':''}
    <span class="sr-filter-count">${filtered.length} / ${entries.length}</span>
  </div>`;

  if(!filtered.length){
    host.innerHTML=filterBarHtml+'<div class="search-empty">'+(activeFilters?'No results match the active filters — try clearing them.':'No results for "'+escHtml(state.searchQuery)+'"')+'</div>';
    _wireFilterBar(host,render);
    return;
  }
  entries=filtered;

  // Per-column widths stored in state.colWidths under 'sr-*' keys
  const W={name:state.colWidths['sr-name']||260,loc:state.colWidths['sr-loc']||220,
            date:state.colWidths['sr-date']||160,size:state.colWidths['sr-size']||80,kind:state.colWidths['sr-kind']||90};

  // Sort state stored separately so it doesn't collide with list view sort
  if(!state.searchSort) state.searchSort={col:'name',dir:1};
  const {col:sc,dir:sd}=state.searchSort;
  const sorted=[...entries].sort((a,b)=>{
    if(sc==='date') return sd*((a.modified||0)-(b.modified||0));
    if(sc==='size') return sd*((a.size||0)-(b.size||0));
    if(sc==='kind'){const ka=a.is_dir?'Folder':(a.extension||'');const kb=b.is_dir?'Folder':(b.extension||'');return sd*ka.localeCompare(kb);}
    if(sc==='loc'){const la=a.path.slice(0,a.path.lastIndexOf('/')||1);const lb=b.path.slice(0,b.path.lastIndexOf('/')||1);return sd*la.localeCompare(lb);}
    return sd*a.name.localeCompare(b.name);
  });
  const arrow=c=>sc===c?`<span class="sort-arrow">${sd>0?'↑':'↓'}</span>`:'';

  host.innerHTML=filterBarHtml+`<div class="list-wrap"><table class="list-table">
    <colgroup>
      <col id="sr-col-name" style="width:${W.name}px">
      <col id="sr-col-loc"  style="width:${W.loc}px">
      <col id="sr-col-date" style="width:${W.date}px">
      <col id="sr-col-size" style="width:${W.size}px">
      <col id="sr-col-kind" style="width:${W.kind}px">
    </colgroup>
    <thead class="list-head"><tr>
      <th data-col="name" class="${sc==='name'?'sorted':''}">Name ${arrow('name')}<div class="th-resize" data-col="sr-name"></div></th>
      <th data-col="loc"  class="${sc==='loc' ?'sorted':''}">Location ${arrow('loc')}<div class="th-resize" data-col="sr-loc"></div></th>
      <th data-col="date" class="${sc==='date'?'sorted':''}">Date Modified ${arrow('date')}<div class="th-resize" data-col="sr-date"></div></th>
      <th data-col="size" class="${sc==='size'?'sorted':''}">Size ${arrow('size')}<div class="th-resize" data-col="sr-size"></div></th>
      <th data-col="kind" class="${sc==='kind'?'sorted':''}">Kind ${arrow('kind')}</th>
    </tr></thead>
    <tbody>
      ${sorted.map((e,i)=>{
        const isCut=state.clipboard.op==='cut'&&state.clipboard.entries?.some(x=>x.path===e.path);
        const loc=e.path.slice(0,e.path.lastIndexOf('/')||1)||'/';
        const isSel2=sel.hasp(e.path);
        const _rowTag2=!isSel2?(state._fileTags?.[e.path]||[])[0]:null;
        const tdBg2=_rowTag2?` style="background:${tagColor(_rowTag2)}33"`:'';        return `<tr class="list-row${isSel2?' sel':''}${e.is_hidden?' hid':''}${isCut?' cut-item':''}"
                    data-idx="${i}" data-path="${e.path.replace(/"/g,'&quot;')}" data-dir="${e.is_dir}">
          <td class="cell-name"${tdBg2}>
            <span class="fico" style="color:${fileColor(e)};width:16px;height:16px;display:inline-flex;align-items:center;flex-shrink:0">${fileIcon(e)}</span>
            <span class="cell-name-text">${_hlMatch(e.name,state.searchQuery)}${e.is_symlink?'<span class="sym-arrow">→</span>':''}</span>
          </td>
          <td class="cell-meta"${tdBg2}>${escHtml(loc)}</td>
          <td class="cell-meta"${tdBg2}>${fmtDate(e.modified)}</td>
          <td class="cell-meta"${tdBg2}>${e.is_dir?'--':fmtSize(e.size)}</td>
          <td class="cell-meta"${tdBg2}>${e.is_dir?'Folder':(e.extension?e.extension.toUpperCase()+' file':'File')}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table></div>`;

  // ── Column sort ─────────────────────────────────────────────────────────────
  host.querySelectorAll('.list-head th').forEach(th=>{
    th.addEventListener('click',ev=>{
      if(ev.target.closest('.th-resize'))return;
      const c=th.dataset.col;
      if(state.searchSort.col===c)state.searchSort.dir*=-1;
      else{state.searchSort.col=c;state.searchSort.dir=1;}
      renderFlatList(host,entries);
    });
  });

  // ── Column resize ───────────────────────────────────────────────────────────
  const colMap={'sr-name':'sr-col-name','sr-loc':'sr-col-loc','sr-date':'sr-col-date','sr-size':'sr-col-size'};
  host.querySelectorAll('.th-resize').forEach(handle=>{
    handle.addEventListener('mousedown',e=>{
      e.stopPropagation();
      const key=handle.dataset.col;
      const startX=e.clientX,startW=state.colWidths[key]||260;
      const colEl=host.querySelector(`#${colMap[key]}`);
      const onMove=ev=>{
        const w=Math.max(60,startW+(ev.clientX-startX));
        state.colWidths[key]=w;
        if(colEl)colEl.style.width=w+'px';
      };
      const onUp=()=>{document.removeEventListener('mousemove',onMove);document.removeEventListener('mouseup',onUp);};
      document.addEventListener('mousemove',onMove);
      document.addEventListener('mouseup',onUp);
    });
  });

  // ── Row events ──────────────────────────────────────────────────────────────
  // CRITICAL: point sel._e at sorted[] before any sel operation.
  // handleEntryClick uses sel._e[idx] for range/toggle/set — idx is an index
  // into sorted[], so sel._e must match sorted[] or wrong paths get selected.
  sel._e = sorted;
  setupDropTarget(host,state.currentPath);
  host.querySelector('.list-wrap')?.addEventListener('contextmenu',e=>{
    if(!e.target.closest('.list-row')){e.preventDefault();sel.clear();render();showContextMenu(e.clientX,e.clientY,buildBgCtxMenu());}
  });
  host.querySelector('.list-wrap')?.addEventListener('mousedown',e=>{
    if(e.button!==0||e.target.closest('.list-row'))return;
    if(!e.ctrlKey&&!e.metaKey&&!e.shiftKey){sel.clear();state.selIdx=-1;render();}
  });

  host.querySelectorAll('.list-row').forEach(row=>{
    const i=+row.dataset.idx; const entry=sorted[i]; if(!entry)return;
    setupDragDrop(row,entry,sorted);
    if(entry.is_dir) setupDropTarget(row,entry.path);
    row.addEventListener('click',async ev=>{
      const lw=host.querySelector('.list-wrap');const sv=lw?lw.scrollTop:0;
      await handleEntryClick(entry,i,ev);
      requestAnimationFrame(()=>{const w=host.querySelector('.list-wrap');if(w)w.scrollTop=sv;});
    });
    row.addEventListener('dblclick',()=>{
      if(!entry.is_dir)invoke('open_file',{path:entry.path}).catch(()=>{});
      else navigate(entry.path,0);
    });
    row.addEventListener('contextmenu',ev=>{
      ev.preventDefault();
      const lw=host.querySelector('.list-wrap');const sv=lw?lw.scrollTop:0;
      if(!sel.has(i))sel.set(i);state.selIdx=i;
      render();
      requestAnimationFrame(()=>{const w=host.querySelector('.list-wrap');if(w)w.scrollTop=sv;});
      showContextMenu(ev.clientX,ev.clientY,buildFileCtxMenu(entry));
    });
  });
}



// ── Font install controller ────────────────────────────────────────────────
function _wireFontInstall(fontPath, panel) {
  const btn       = () => panel.querySelector('#pv-font-install-btn');
  const statusEl  = () => panel.querySelector('#pv-font-status');
  const progWrap  = () => panel.querySelector('#pv-font-progress-wrap');
  const progBar   = () => panel.querySelector('#pv-font-progress-bar');
  const filename  = fontPath.split('/').pop();

  // Check if already installed
  invoke('is_font_installed', {filename}).then(installed => {
    if (!btn()) return;
    if (installed) {
      btn().disabled = true;
      btn().textContent = '✓ Already Installed';
      btn().classList.add('pv-font-installed');
    }
  }).catch(() => {});

  btn()?.addEventListener('click', async () => {
    const b = btn(); if (!b || b.disabled) return;
    b.disabled = true;
    const s = statusEl(); const pw = progWrap(); const pb = progBar();
    if (s) s.textContent = 'Installing…';
    if (pw) pw.style.display = '';
    // Animate indeterminate progress bar
    if (pb) { pb.style.transition = 'none'; pb.style.width = '0%';
      requestAnimationFrame(() => { pb.style.transition = 'width 1.2s ease'; pb.style.width = '85%'; }); }
    try {
      await invoke('install_font', {path: fontPath});
      if (pb) { pb.style.transition = 'width .2s ease'; pb.style.width = '100%'; pb.classList.add('green'); }
      if (s) { s.textContent = '✓ Installed'; s.style.color = '#34d399'; }
      if (b) { b.textContent = '✓ Installed'; b.classList.add('pv-font-installed'); }
      setTimeout(() => { if (pw) pw.style.display = 'none'; }, 1200);
      d().showToast(t('toast.font_installed',{name:filename}),'success');
    } catch(err) {
      if (pb) { pb.style.width = '100%'; pb.classList.add('red'); }
      if (s) { s.textContent = String(err); s.style.color = '#f87171'; }
      b.disabled = false;
      setTimeout(() => { if (pw) pw.style.display = 'none'; if (pb) pb.classList.remove('red'); }, 3000);
    }
  });
}

// ── Gallery view ──────────────────────────────────────────────────────────────
// Virtual-scroller constants — must match style.css .gallery-strip / .gthumb
// GTHUMB_W is a function so it reads the live iconSizeGallery preference on
// every call rather than being frozen to whatever d() returned at module load
// time (which was null, so it always defaulted to 128).
function _gthumbW() {
  return Math.round(Math.max(64, (d()?.state?.iconSizeGallery ?? 128) * 0.67));
}
const STRIP_GAP     = 6;    // .gallery-strip { gap: 6px }
const STRIP_PAD     = 16;   // .gallery-strip { padding: 8px 16px } — left/right only
const STRIP_TOP     = 9;    // vertical offset inside strip-wrap (8px pad-top + 1px optical)
const STRIP_OVERSCAN = 6;   // extra items rendered beyond visible edge on each side

// Absolute left offset of item i inside the virtual strip
function _thumbLeft(i) { const W = _gthumbW(); return STRIP_PAD + i * (W + STRIP_GAP); }
// Total scroll-content width for n items
function _stripTotalW(n) {
  const W = _gthumbW(); const stride = W + STRIP_GAP;
  return n === 0 ? STRIP_PAD * 2 : STRIP_PAD + n * stride - STRIP_GAP + STRIP_PAD;
}

// Build a single gthumb DOM element (no innerHTML string concat)
function _makeGthumb(e, i, selIdx, state) {
  const isSel  = i === selIdx;
  const ext    = (e.extension || '').toLowerCase();
  const isMedia = IMAGE_EXTS.includes(ext) || VIDEO_EXTS.includes(ext);
  const isAudio = AUDIO_EXTS.includes(ext);
  const color  = fileColor(e);
  const iconSvg = fileIcon(e).replace('<svg', '<svg style="width:28px;height:28px"');
  const _tag   = !isSel ? (state._fileTags?.[e.path] || [])[0] : null;
  const el     = document.createElement('div');
  el.className = `gthumb${isSel ? ' sel' : ''}${e.is_hidden ? ' hid' : ''}`;
  el.dataset.idx  = i;
  el.dataset.path = e.path;
  el.dataset.dir  = String(e.is_dir);
  if (isMedia || isAudio) el.dataset.thumbPath = e.path;
  el.style.cssText = `position:absolute;left:${_thumbLeft(i)}px;top:${STRIP_TOP}px;`;
  el.setAttribute('role', 'option');
  el.setAttribute('aria-selected', isSel ? 'true' : 'false');
  el.setAttribute('aria-label', e.name + (e.is_dir ? ', folder' : ''));
  if (_tag) el.style.setProperty('--tag-tint', tagColor(_tag) + '33');
  
  // For audio files with covers, show cover thumbnail
  if (isAudio && _audioCoverCache[e.path]) {
    el.innerHTML = `<img src="${_audioCoverCache[e.path]}" class="gthumb-audio-cover" style="width:60px;height:60px;object-fit:cover;border-radius:6px;flex-shrink:0;display:block;"><span class="gthumb-lbl">${escHtml(e.name)}</span>`;
    el.dataset.thumbLoaded = '1'; // prevent _loadGthumb from inserting a second cover
  } else if (isAudio) {
    // Show music icon initially - _loadGthumb will replace with cover if available
    el.innerHTML = `<span class="gthumb-icon gthumb-shimmer" style="color:${color}">${iconSvg}</span><span class="gthumb-lbl">${escHtml(e.name)}</span>`;
  } else if (e.is_dir) {
    el.innerHTML = `<span class="gthumb-icon" style="color:${color};position:relative;">${iconSvg}<span class="gthumb-dir-count" style="display:none;"></span></span><span class="gthumb-lbl">${escHtml(e.name)}</span>`;
    // Async: count direct children and show as a styled pill badge
    invoke('list_directory_fast', {path: e.path}).then(res => {
      if (!el.isConnected) return;
      const count = res?.entries?.length ?? 0;
      const badge = el.querySelector('.gthumb-dir-count');
      if (!badge) return;
      if (count === 0) { badge.style.display = 'none'; return; }
      badge.textContent = count > 999 ? '999+' : count;
      // Tint: cool blue for small, vivid blue for medium, purple for large
      const tint = count >= 500 ? 'rgba(139,92,246,.55)'   // purple
                 : count >= 100 ? 'rgba(59,130,246,.55)'    // blue
                 : count >=  10 ? 'rgba(56,189,248,.45)'    // sky
                 :                'rgba(148,163,184,.35)';   // slate (small)
      badge.style.background = tint;
      badge.style.border = '1px solid rgba(255,255,255,.22)';
      badge.style.display = 'flex';
    }).catch(() => {});
  } else {
    const needsShimmer = isMedia;
    el.innerHTML = `<span class="gthumb-icon${needsShimmer?' gthumb-shimmer':''}" style="color:${color}">${iconSvg}</span><span class="gthumb-lbl">${escHtml(e.name)}</span>`;
    // Extension badge for office/document files (e.g. DOCX, XLSX, PDF)
    if (ext && (OFFICE_EXTS.includes(ext) || PDF_EXTS.includes(ext) || ARCHIVE_EXTS.includes(ext))) {
      const docBadge = document.createElement('span');
      docBadge.className = 'gthumb-doc-badge';
      docBadge.textContent = ext.toUpperCase();
      el.querySelector('.gthumb-icon').appendChild(docBadge);
    }
  }
  return el;
}

// Render only the visible window of the virtual strip.
// Removes out-of-range items, adds missing items, attaches thumb observer.
function _paintStrip(stripWrap, strip, entries, selIdx, state) {
  const scrollLeft   = stripWrap.scrollLeft;
  const viewW        = stripWrap.clientWidth || 900;
  const firstVisible = Math.max(0,
    Math.floor((scrollLeft - STRIP_PAD) / (_gthumbW() + STRIP_GAP)) - STRIP_OVERSCAN);
  const lastVisible  = Math.min(entries.length - 1,
    Math.ceil((scrollLeft + viewW - STRIP_PAD) / (_gthumbW() + STRIP_GAP)) + STRIP_OVERSCAN);

  // Evict out-of-range items
  for (const ch of [...strip.children]) {
    const i = +ch.dataset.idx;
    if (i < firstVisible || i > lastVisible) {
      if (thumbObserver) thumbObserver.unobserve(ch);
      ch.remove();
    }
  }

  // Add missing items in range
  const existing = new Set([...strip.children].map(c => +c.dataset.idx));
  for (let i = firstVisible; i <= lastVisible; i++) {
    if (existing.has(i)) continue;
    const el = _makeGthumb(entries[i], i, selIdx, state);
    strip.appendChild(el);
    if (thumbObserver && el.dataset.thumbPath) thumbObserver.observe(el);
  }
}

// Scroll the strip-wrap to center selIdx, then repaint the visible window.
function _scrollToSel(stripWrap, strip, entries, selIdx, state, behavior = 'smooth') {
  if (selIdx < 0 || selIdx >= entries.length) return;
  const itemCenter = _thumbLeft(selIdx) + _gthumbW() / 2;
  const targetLeft = Math.max(0, itemCenter - (stripWrap.clientWidth || 900) / 2);
  stripWrap.scrollTo({ left: targetLeft, behavior });
  _paintStrip(stripWrap, strip, entries, selIdx, state);
}



let thumbObserver = null;

export async function renderGalleryView(host){
  const {state,sel,getVisibleEntries,loadPreview,navigate,getMediaUrl,getHeicJpegUrl,sortState}=d();
  const entries=getVisibleEntries();
  const selIdx=state.gallerySelIdx>=0?state.gallerySelIdx:0;
  const sel_e=entries[selIdx]||null;

  // Reset zoom only when the selected file actually changes
  if(state._galleryZoomPath!==sel_e?.path){ state._galleryZoom=1; state._galleryZoomPath=sel_e?.path; }
  const zoom=state._galleryZoom||1;
  const canZoom=sel_e&&!sel_e.is_dir;
  const zoomPct=Math.round(zoom*100);

  // ── Build main-area HTML ─────────────────────────────────────────────────────
  const _buildMainHtml=()=>{
    if(!sel_e) return `<div class="gallery-empty-hint">Select an item</div>`;
    const ext=sel_e.extension||'';
    if(IMAGE_EXTS.includes(ext)&&ext!=='xcf')
      return `<div class="gallery-media-slot" id="gallery-img-slot"><div class="gallery-loading-thumb"><div class="spinner"></div></div></div>`;
    if(VIDEO_EXTS.includes(ext))
      return `<div class="gallery-media-slot" id="gallery-media-slot"><div class="media-loading"><div class="spinner"></div><span>Loading video...</span></div></div>`;
    if(AUDIO_EXTS.includes(ext))
      return `<div class="gallery-audio-outer" id="gallery-audio-outer"><div class="gallery-media-slot gallery-audio-slot" id="gallery-media-slot"><div class="media-loading"><div class="spinner"></div><span>Loading audio...</span></div></div><canvas id="gallery-viz-canvas" class="gallery-viz-canvas"></canvas></div>`;
    if(PDF_EXTS.includes(ext))
      return `<div class="gallery-media-slot" id="gallery-pdf-slot"><iframe class="gallery-pdf" src="${getMediaUrl(sel_e.path)}" title="PDF Preview"></iframe></div>`;
    if(HTML_EXTS.includes(ext))
      return `<div class="gallery-media-slot" id="gallery-html-slot"><iframe class="gallery-html" src="${getMediaUrl(sel_e.path)}" title="HTML Preview" sandbox="allow-scripts allow-same-origin"></iframe></div>`;
    if(ext==='xcf')
      return `<div class="gallery-dir-preview"><span style="color:${fileColor(sel_e)}">${fileIcon(sel_e).replace('<svg','<svg style="width:80px;height:80px"')}</span><div class="gallery-preview-name">${escHtml(sel_e.name)}</div><div class="gallery-preview-meta">GIMP Image · Cannot preview inline</div></div>`;
    if(DMG_EXTS.includes(ext))
      return `<div class="gallery-dir-preview"><span style="color:${fileColor(sel_e)}">${fileIcon(sel_e).replace('<svg','<svg style="width:80px;height:80px"')}</span><div class="gallery-preview-name">${escHtml(sel_e.name)}</div><div class="gallery-preview-meta">Apple Disk Image · ${fmtSize(sel_e.size)}</div></div>`;
    if(DOC_EXTS.includes(ext)||OFFICE_EXTS.includes(ext)||BOOK_EXTS.includes(ext))
      return `<div id="gallery-doc-slot" class="gallery-media-slot"><div class="gallery-loading-thumb"><div class="spinner"></div></div></div>`;
    if(sel_e.is_dir)
      return `<div class="gallery-dir-preview"><span style="color:${fileColor(sel_e)}">${fileIcon(sel_e).replace('<svg','<svg style="width:80px;height:80px"')}</span><div class="gallery-preview-name">${escHtml(sel_e.name)}</div><div class="gallery-preview-meta">Folder</div></div>`;
    return `<div class="gallery-dir-preview"><span style="color:${fileColor(sel_e)}">${fileIcon(sel_e).replace('<svg','<svg style="width:80px;height:80px"')}</span><div class="gallery-preview-name">${escHtml(sel_e.name)}</div><div class="gallery-preview-meta">${sel_e.extension?sel_e.extension.toUpperCase()+' \xb7 ':''} ${fmtSize(sel_e.size)}</div></div>`;
  };

  // ── Build toolbar-bar HTML ───────────────────────────────────────────────────
  // Fit-to-window toggle: when on, image fills the container; zoom controls disabled
  if(state._galleryFit===undefined) state._galleryFit=false;
  const isFit=!!state._galleryFit;
  if(state._galSlideshow===undefined) state._galSlideshow=false;
  const _isSS=!!state._galSlideshow;
  const _isAudioSel = sel_e && AUDIO_EXTS.includes(sel_e.extension||'');
  const _selCount = sel ? [...(sel._paths||[])].length : 0;
  const _totalCount = entries.length;
  const _curVizMode = getVizMode();
  const _vizModes = [{k:'bars',label:'▊▊',title:'Bars'},{k:'wave',label:'〜',title:'Wave'},{k:'mirror',label:'╪',title:'Mirror'},{k:'ring',label:'◎',title:'Ring'}];

  let _buildBarHtml=()=>`
    <div class="gallery-ss-bar-wrap" style="display:${_isSS?'block':'none'}"><div id="gallery-ss-bar" class="gallery-ss-bar"></div></div>
    <div style="display:flex;align-items:center;gap:6px;">
      ${state.currentPath&&state.currentPath!=='/'?`<button class="gallery-open-btn" id="gallery-go-up" title="Go to parent folder (⌫)" style="font-size:14px;padding:0 8px;min-width:0;">↑</button>`:''}
      ${sel_e&&!sel_e.is_dir?`<button class="gallery-open-btn" id="gallery-open">${I.openExt} Open</button>`:'<span></span>'}
      ${sel_e&&!sel_e.is_dir?`<button class="gallery-open-btn" id="gallery-copy-to" title="Copy to folder…" style="font-size:11px;padding:0 9px;">${I.copy} Copy to…</button>`:''}
      ${sel_e&&!sel_e.is_dir?`<button class="gallery-open-btn" id="gallery-move-to" title="Move to folder…" style="font-size:11px;padding:0 9px;">${I.scissors} Move to…</button>`:''}
      <button class="gallery-open-btn${_isSS?' gallery-ss-active':''}" id="gallery-slideshow" title="Slideshow (S)" style="font-size:11px;padding:0 10px;${_isSS?'background:var(--accent-blue);color:#fff;border-color:var(--accent-blue);':''}">
        ${_isSS?'⏹ Stop':'▶ Slideshow'}
      </button>
      ${_isSS?`<div class="gallery-ss-interval-wrap" title="Slide interval">
        <span style="font-size:10px;color:var(--text-tertiary);">⏱</span>
        <input type="range" id="gallery-ss-interval" class="gallery-ss-slider" min="1" max="10" step="0.5" value="${state._galSSInterval||3}" style="width:60px;">
        <span id="gallery-ss-interval-lbl" style="font-size:10px;color:var(--text-tertiary);min-width:22px;">${(state._galSSInterval||3)}s</span>
      </div>`:''}
      <button class="gallery-open-btn" id="gallery-sort-btn" title="Sort" style="font-size:11px;padding:0 9px;min-width:0;"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;margin-right:3px"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="15" y2="12"/><line x1="3" y1="18" x2="9" y2="18"/></svg>${sortState.col[0].toUpperCase()+sortState.col.slice(1)} ${sortState.dir>0?'↑':'↓'}</button>
      <button class="gallery-open-btn gallery-sel-btn" id="gallery-select-all" title="Select all / deselect all" style="font-size:11px;padding:0 9px;min-width:0;">
        ${_selCount>1?`✓ ${_selCount} selected`:'☐ Select all'}
      </button>
    </div>
    ${_isAudioSel?`<div class="gallery-viz-mode-bar" id="gallery-viz-mode-bar" title="Press V to cycle visualizer modes">
      ${_vizModes.map(m=>`<button class="gvm-btn${_curVizMode===m.k?' gvm-active':''}" data-mode="${m.k}" title="${m.title} (V to cycle)">${m.label}</button>`).join('')}
      <span style="font-size:9px;color:var(--text-tertiary);padding:0 4px;opacity:.6;pointer-events:none;">V</span>
    </div>`:''}
    ${canZoom&&!VIDEO_EXTS.includes(sel_e?.extension||'')?`<div class="gallery-zoom-bar">
      <button class="gallery-zoom-btn${isFit?' active':''}" id="gz-fit" title="Fit to window (F)" style="font-size:10px;padding:0 8px;${isFit?'background:var(--accent-blue);color:#fff;':''}">Fit</button>
      <button class="gallery-zoom-btn" id="gz-out" title="Zoom Out (-)" ${isFit?'disabled style="opacity:.35;pointer-events:none"':''}>&#x2212;</button>
      <span class="gallery-zoom-pct" id="gz-pct">${isFit?'fit':zoomPct+'%'}</span>
      <button class="gallery-zoom-btn" id="gz-in" title="Zoom In (+)" ${isFit?'disabled style="opacity:.35;pointer-events:none"':''}>+</button>
      <button class="gallery-zoom-btn" id="gz-reset" title="Reset Zoom (0)" style="font-size:10px;padding:0 6px">&#x27F3;</button>
      <button class="gallery-zoom-btn" id="gz-scroll-sel" title="Scroll strip to selected (⊙)" style="font-size:13px;padding:0 5px;line-height:1;">⊙</button>
    </div>`:''}
`;

  // ── Load media content into already-inserted DOM slots ───────────────────────
  const _loadContent=()=>{
    if(!sel_e)return;
    const ext=sel_e.extension||'';
    const gUrl=getMediaUrl(sel_e.path);
    const imgSlot=document.getElementById('gallery-img-slot');
    if(imgSlot&&IMAGE_EXTS.includes(ext)&&ext!=='xcf'){
      const isHeic = ext==='heic'||ext==='heif';
      const imgSrc = isHeic ? getHeicJpegUrl(sel_e.path) : gUrl;
      const img=document.createElement('img');
      img.className='gallery-main-img';img.alt=sel_e.name;img.style.cursor='zoom-in';
      img.onclick=()=>openLightboxUrl(sel_e,imgSrc);
      img.onerror=()=>{invoke('get_thumbnail',{path:sel_e.path}).then(thumbPath=>{const s=document.getElementById('gallery-img-slot');if(s){const {getMediaUrl}=d();const i2=document.createElement('img');i2.className='gallery-main-img';i2.decoding='async';i2.src=getMediaUrl(thumbPath);s.innerHTML='';s.appendChild(i2);}}).catch(()=>{});};
      img.src=imgSrc;imgSlot.innerHTML='';imgSlot.appendChild(img);
    }
    const gSlot=document.getElementById('gallery-media-slot');
    if(gSlot){
      if(VIDEO_EXTS.includes(ext)){
        // Clean up old video: removes document keydown listener, pauses, clears src.
        // Without this, every item switch leaks a _fsKey listener and the old
        // video keeps playing audio in the background.
        _stopSlot(gSlot);
        gSlot.innerHTML='';
        _mountMpvPlayer(gSlot, sel_e.path).catch(err=>{
          if(gSlot.dataset.mpvActive) return; // another mount already took over
          gSlot.innerHTML=`<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:10px;color:#f87171;font-size:13px;opacity:.8;"><svg width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><span>Could not play video</span><span style="font-size:11px;opacity:.6;">${escHtml(String(err).slice(0,80))}</span></div>`;
        });
      }else if(AUDIO_EXTS.includes(ext)){
        const _fc=fileColor(sel_e);const _fi=fileIcon(sel_e).replace('<svg','<svg style="width:90px;height:90px"');
        gSlot.innerHTML='<div class="gallery-audio-inner"><span class="gallery-audio-icon-wrap" style="color:'+_fc+';filter:drop-shadow(0 0 24px '+_fc+'50)">'+_fi+'</span><div class="gallery-audio-name">'+escHtml(sel_e.name)+'</div><audio class="gallery-main-audio" id="gallery-audio-el" data-file-path="'+sel_e.path+'" crossorigin="anonymous" controls preload="none"></audio></div>';
        // Wire WebAudio graph BEFORE setting src — element is idle, zero interruption risk
        const audioEl=document.getElementById('gallery-audio-el');
        const canvas=document.getElementById('gallery-viz-canvas');
        if(audioEl&&canvas){
          startAudioVisualizer(audioEl,canvas);
          audioEl.src=gUrl; // set src AFTER wiring
        }
        // Replace icon with album cover if available
        const _replaceGalleryIcon = (coverUrl) => {
          const iconWrap = gSlot.querySelector('.gallery-audio-icon-wrap');
          if (!iconWrap || !iconWrap.isConnected) return;
          const coverImg = document.createElement('img');
          coverImg.src = coverUrl;
          coverImg.style.cssText = 'width:160px;height:160px;object-fit:cover;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.5);display:block;flex-shrink:0;';
          iconWrap.replaceWith(coverImg);
        };
        if (_audioCoverCache[sel_e.path] && _audioCoverCache[sel_e.path] !== 'loading') {
          _replaceGalleryIcon(_audioCoverCache[sel_e.path]);
        } else {
          _getAudioCover(sel_e.path).then(cover => { if (cover) _replaceGalleryIcon(cover); });
        }
      }
    }
    if(DOC_EXTS.includes(ext)||OFFICE_EXTS.includes(ext)||BOOK_EXTS.includes(ext)){
      const ds=document.getElementById('gallery-doc-slot');
      if(ds){
        invoke('get_file_preview',{path:sel_e.path}).then(pd=>{
          const s=document.getElementById('gallery-doc-slot');if(!s)return;
          if(pd?.content!=null){s.innerHTML='<pre class="gallery-text-preview">'+escHtml(pd.content.slice(0,8000))+'</pre>';}
          else{const _fi2=fileIcon(sel_e).replace('<svg','<svg style="width:60px;height:60px"');s.innerHTML='<div class="gallery-dir-preview"><span style="color:'+fileColor(sel_e)+'">'+_fi2+'</span><div class="gallery-preview-name">'+escHtml(sel_e.name)+'</div></div>';}
        }).catch(()=>{});
        // If office file, upgrade to PDF preview when LibreOffice is available
        if(OFFICE_EXTS.includes(ext)){
          invoke('get_office_preview',{path:sel_e.path}).then(res=>{
            const s=document.getElementById('gallery-doc-slot');if(!s)return;
            if(res?.mode==='pdf'&&res?.pdf_path){
              s.innerHTML='<iframe class="gallery-office-pdf" src="'+getMediaUrl(res.pdf_path)+'" title="Document Preview" style="width:100%;height:100%;border:none;border-radius:8px;"></iframe>';
            }
          }).catch(()=>{});
        }
      }
    }
  };

  // ── Wire up zoom controls ────────────────────────────────────────────────────
  const _applyZoom=()=>{
    const z=state._galleryZoom||1;
    const slot=host.querySelector('#gallery-img-slot,#gallery-doc-slot,#gallery-pdf-slot,#gallery-html-slot,#gallery-media-slot');
    if(slot){slot.style.zoom=z;slot.style.transform='';}
    const pctEl=document.getElementById('gz-pct');
    if(pctEl)pctEl.textContent=Math.round(z*100)+'%';
  };
  const _applyFit=()=>{
    const imgEl=document.querySelector('#gallery-img-slot img.gallery-main-img');
    if(!imgEl)return;
    if(state._galleryFit){
      imgEl.style.cssText='width:100%;height:100%;object-fit:contain;cursor:default;max-width:unset;max-height:unset;';
    } else {
      imgEl.style.cssText='';
      _applyZoom();
    }
  };
  const _rebuildBar=()=>{
    const barEl=host.querySelector('.gallery-bar');
    if(barEl){barEl.innerHTML=_buildBarHtml();_bindZoom();}
  };
  const _bindZoom=()=>{
    document.getElementById('gallery-go-up')?.addEventListener('click',()=>{
      const cur=d().state?.currentPath||'';
      const parent=cur.includes('/')?cur.slice(0,cur.lastIndexOf('/'))||'/':'/';
      d().navigate?.(parent,0);
    });
    document.getElementById('gallery-open')?.addEventListener('click',()=>{
      if(sel_e) invoke('open_file',{path:sel_e.path}).catch(()=>{});
    });
    document.getElementById('gallery-copy-to')?.addEventListener('click',()=>{
      const entries=d().getVisibleEntries?.()??[];
      const idx=entries.indexOf(sel_e);
      if(idx>=0){d().sel?.set(idx);d().state&&(d().state.selIdx=idx);}
      d().ctxAction?.('copy-to');
    });
    document.getElementById('gallery-move-to')?.addEventListener('click',()=>{
      const entries=d().getVisibleEntries?.()??[];
      const idx=entries.indexOf(sel_e);
      if(idx>=0){d().sel?.set(idx);d().state&&(d().state.selIdx=idx);}
      d().ctxAction?.('move-to');
    });
    document.getElementById('gallery-sort-btn')?.addEventListener('click', e => {
    const {showSortMenu} = d();
    if (showSortMenu) showSortMenu(e.currentTarget);
  });
  host.querySelector('#gallery-select-all')?.addEventListener('click',()=>{
      const ents=d().getVisibleEntries?.()??[];
      if(sel && [...(sel._paths||[])].length > 1){
        sel.clear(); state.selIdx = state.gallerySelIdx;
      } else {
        sel.clear();
        ents.forEach((e,i) => { sel._paths.add(e.path); sel.last=i; });
      }
      _rebuildBar(); d().render?.();
    });
    // Viz mode buttons
    host.querySelectorAll('.gvm-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        setVizMode(btn.dataset.mode);
        _rebuildBar();
        // Restart visualizer so it picks up the new mode immediately
        const audioEl = document.getElementById('gallery-audio-el');
        const canvas = document.getElementById('gallery-viz-canvas');
        if (audioEl && canvas) startAudioVisualizer(audioEl, canvas);
      });
    });
    document.getElementById('gallery-slideshow')?.addEventListener('click',()=>{
      state._galSlideshow=!state._galSlideshow;
      _rebuildBar();
      // Wire interval slider if it just appeared
      const slider=document.getElementById('gallery-ss-interval');
      if(slider){
        slider.addEventListener('input',()=>{
          state._galSSInterval=parseFloat(slider.value);
          const lbl=document.getElementById('gallery-ss-interval-lbl');
          if(lbl) lbl.textContent=state._galSSInterval+'s';
          // Reset the progress bar animation to match new interval
          const ssBar=document.getElementById('gallery-ss-bar');
          if(ssBar){ssBar.style.transition='none';ssBar.style.width='0%';requestAnimationFrame(()=>{ssBar.style.transition=`width ${state._galSSInterval*1000}ms linear`;ssBar.style.width='100%';});}
        });
      }
      if(state._galSlideshow){
        // Start slideshow — advance every 3s
        clearInterval(state._galSSTimer);
        const _startSSBar=()=>{const el=document.getElementById('gallery-ss-bar');if(!el)return;el.style.transition='none';el.style.width='0%';requestAnimationFrame(()=>{el.style.transition=`width ${(state._galSSInterval||3)*1000}ms linear`;el.style.width='100%';});};
        _startSSBar();
        state._galSSTimer=setInterval(async()=>{
          const ents=d().getVisibleEntries?.()??[];
          const nonDir=ents.filter(e=>!e.is_dir);
          if(!nonDir.length) return;
          const cur=state.gallerySelIdx>=0?state.gallerySelIdx:0;
          const curNonDir=nonDir.findIndex(e=>ents[cur]?.path===e.path);
          const nextNonDir=(curNonDir+1)%nonDir.length;
          const nextIdx=ents.indexOf(nonDir[nextNonDir]);
          state.gallerySelIdx=nextIdx>=0?nextIdx:0;
          state.selIdx=state.gallerySelIdx;
          await renderGalleryView(host);
          await d().loadPreview?.(ents[state.gallerySelIdx]);
          _startSSBar();
        }, (state._galSSInterval||3)*1000);
      } else {
        clearInterval(state._galSSTimer);
        state._galSSTimer=null;
      }
    });
    document.getElementById('gz-fit')?.addEventListener('click',()=>{
      state._galleryFit=!state._galleryFit;
      if(state._galleryFit)state._galleryZoom=1;
      _rebuildBar(); _applyFit();
    });
    document.getElementById('gz-in')?.addEventListener('click',()=>{if(state._galleryFit)return;state._galleryZoom=Math.min((state._galleryZoom||1)+0.25,5);_applyZoom();});
    document.getElementById('gz-out')?.addEventListener('click',()=>{if(state._galleryFit)return;state._galleryZoom=Math.max((state._galleryZoom||1)-0.25,0.25);_applyZoom();});
    document.getElementById('gz-reset')?.addEventListener('click',()=>{state._galleryFit=false;state._galleryZoom=1;_rebuildBar();_applyZoom();});
    document.getElementById('gz-scroll-sel')?.addEventListener('click',()=>{
      const sw=host.querySelector('.gallery-strip-wrap');
      const s=host.querySelector('#gallery-strip');
      if(sw&&s) _scrollToSel(sw,s,d().getVisibleEntries?.()??[],state.gallerySelIdx>=0?state.gallerySelIdx:0,state,'smooth');
    });
    if(!host._gzKeyBound){
      host._gzKeyBound=true;
      // Store the listener so the full-rebuild path can remove it before re-adding,
      // preventing one new listener from accumulating on every directory navigation.
      host._gzKeyFn = (e) => {
        if(state._galleryZoomPath==null)return;
        if(document.activeElement?.tagName?.toLowerCase()==='input')return;
        if(e.key==='+'||e.key==='='){state._galleryZoom=Math.min((state._galleryZoom||1)+0.25,5);_applyZoom();}
        else if(e.key==='-'){state._galleryZoom=Math.max((state._galleryZoom||1)-0.25,0.25);_applyZoom();}
        else if(e.key==='0'){state._galleryZoom=1;_applyZoom();}
      };
      document.addEventListener('keydown', host._gzKeyFn);
    }
  };

  // ── INCREMENTAL UPDATE — same directory, same entry count ─────────────────
  // Only swap main area + bar + update selection on already-rendered strip items.
  // Strip DOM, thumb images, and virtual scroll position are completely untouched.
  const meta=host._galleryMeta;
  // CRITICAL: host._galleryMeta is a JS property that survives host.innerHTML
  // reassignment by other views (column/list/icon all clobber gallery DOM via
  // host.innerHTML). Without the querySelector guard, switching Column→Gallery
  // matches the stale meta, takes the incremental path, finds no #gallery-strip
  // (null), renders no thumbnail strip, and adds no click listener — broken gallery.
  if(meta&&meta.path===state.currentPath&&meta.count===entries.length&&host.querySelector('.gallery-wrap')){
    const mainEl=host.querySelector('#gallery-main');
    if(mainEl) mainEl.innerHTML=_buildMainHtml();
    const barEl=host.querySelector('.gallery-bar');
    if(barEl) barEl.innerHTML=_buildBarHtml();

    // Update sel + tag-tint only on currently-rendered (visible) thumbs
    host.querySelectorAll('.gthumb').forEach(el=>{
      const i=+el.dataset.idx;
      const isSel=i===selIdx;
      const wasSelCls=el.classList.contains('sel');
      const _tag=!isSel?(state._fileTags?.[entries[i]?.path]||[])[0]:null;
      if(isSel!==wasSelCls){
        el.classList.toggle('sel',isSel);
        el.setAttribute('aria-selected', isSel ? 'true' : 'false');
        if(_tag) el.style.setProperty('--tag-tint',tagColor(_tag)+'33');
        else el.style.removeProperty('--tag-tint');
      }
    });

    // Scroll to the selected item (handles keyboard navigation to off-screen items)
    // and repaint the virtual strip for the new scroll position.
    const stripWrap=host.querySelector('.gallery-strip-wrap');
    const strip=host.querySelector('#gallery-strip');
    if(stripWrap&&strip){
      requestAnimationFrame(()=>_scrollToSel(stripWrap,strip,entries,selIdx,state,'smooth'));
    }

    _loadContent();
    _bindZoom();
    _applyZoom();
    return;
  }

  // ── FULL REBUILD — new directory or first render ───────────────────────────
  host.innerHTML=`<div class="gallery-wrap">
    <div class="gallery-main" id="gallery-main">${_buildMainHtml()}</div>
    <div class="gallery-bar">${_buildBarHtml()}</div>
    <div class="gallery-strip-wrap"><div class="gallery-strip-resize-handle" id="gallery-strip-rh"></div><div class="gallery-strip" id="gallery-strip"></div></div>
  </div>`;
  // Wire strip resize handle
  const _rh = host.querySelector('#gallery-strip-rh');
  const _sw = host.querySelector('.gallery-strip-wrap');
  if(_rh && _sw && !_sw._resizeWired){
    _sw._resizeWired = true;
    const _savedH = parseInt(localStorage.getItem('ff_strip_h')||'136');
    if(_savedH !== 136) document.documentElement.style.setProperty('--gallery-strip-h', _savedH+'px');
    _rh.addEventListener('mousedown', ev => {
      ev.preventDefault();
      const startY = ev.clientY, startH = _sw.offsetHeight;
      const onMove = mv => {
        const newH = Math.min(280, Math.max(72, startH - (mv.clientY - startY)));
        document.documentElement.style.setProperty('--gallery-strip-h', newH+'px');
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        try{localStorage.setItem('ff_strip_h', _sw.offsetHeight);}catch{}
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
  // Capture previous path BEFORE stamping new meta so the slideshow check below
  // can compare old vs new. Stamping first made meta.path === currentPath always
  // true, so the slideshow never stopped on directory navigation.
  // r24: empty folder state — matches column/list/icon behaviour
  if(!entries.length){
    host._galleryMeta = null;
    host.innerHTML='<div class="empty-folder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" style="width:56px;height:56px;color:#3a3d47"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/></svg><div class="empty-folder-label">Empty folder</div></div>';
    return;
  }
  const _prevGalleryPath = host._galleryMeta?.path;
  // Stamp meta so incremental path can identify this render
  host._galleryMeta={path:state.currentPath,count:entries.length};
  // Stop slideshow if we navigated to a different directory
  if(state._galSlideshow && _prevGalleryPath !== state.currentPath){
    clearInterval(state._galSSTimer); state._galSSTimer=null; state._galSlideshow=false;
  }
  // Remove any previous zoom keydown listener before the new one is wired up in _bindZoom()
  if(host._gzKeyFn){document.removeEventListener('keydown',host._gzKeyFn);host._gzKeyFn=null;}
  host._gzKeyBound=false;

  const strip=host.querySelector('#gallery-strip');
  const stripWrap=host.querySelector('.gallery-strip-wrap');
  // Make strip a scrollable canvas: position:relative + explicit total width
  strip.style.cssText=`position:relative;width:${_stripTotalW(entries.length)}px;height:100%;`;

  // IMPORTANT: set up thumbObserver BEFORE _paintStrip — _paintStrip calls thumbObserver.observe()
  _setupThumbObserver(host,stripWrap);

  // Initial paint of the visible window
  _paintStrip(stripWrap,strip,entries,selIdx,state);

  // Repaint on scroll (virtual strip: add/remove items as user scrolls)
  stripWrap.addEventListener('scroll',()=>{
    _paintStrip(stripWrap,strip,entries,state.gallerySelIdx>=0?state.gallerySelIdx:0,state);
  },{passive:true});

  // Scroll to the initially selected item (instant on first open)
  requestAnimationFrame(()=>_scrollToSel(stripWrap,strip,entries,selIdx,state,'instant'));

  // Event delegation on strip — one listener per full build, covers all current and future thumbs
  strip.addEventListener('click',async e=>{
    const el=e.target.closest('.gthumb');
    if(!el){
      // Clicked between thumbnails — deselect
      if(!e.ctrlKey&&!e.metaKey&&!e.shiftKey){const {sel,state,render}=d();sel.clear();state.selIdx=-1;state.gallerySelIdx=-1;render();}
      return;
    }
    const i=+el.dataset.idx;
    if(state.gallerySelIdx===i&&el.dataset.dir==='true'){await navigate(el.dataset.path,0);return;}
    state.gallerySelIdx=i;state.selIdx=i;
    // CRITICAL: point sel._e at gallery entries before sel.set(). Without this,
    // sel._e still points at column-view entries and sel.set(i) resolves the
    // wrong path (or undefined), breaking multi-select and context menus.
    sel._e=entries;
    sel.set(i);
    const entry=entries[i];if(entry)await loadPreview(entry);
    await renderGalleryView(host);
  });
  strip.addEventListener('dblclick',async e=>{
    const el=e.target.closest('.gthumb');if(!el)return;
    if(el.dataset.dir==='true')await navigate(el.dataset.path,0);
    else invoke('open_file',{path:el.dataset.path}).catch(()=>{});
  });
  strip.addEventListener('contextmenu', e => {
    const el = e.target.closest('.gthumb'); if (!el) return;
    e.preventDefault();
    const {showContextMenu, buildFileCtxMenu, sel, state: st} = d();
    const i = +el.dataset.idx;
    const entry = entries[i]; if (!entry) return;
    // Ensure the item is selected so context menu actions target it
    if (!sel.hasp(entry.path)) { sel._e = entries; sel.set(i); st.selIdx = i; st.gallerySelIdx = i; }
    const items = el.dataset.dir === 'true'
      ? [{label:'Open',action:'open',icon:I.openExt},{label:'Open in New Tab',action:'open-new-tab',icon:I.folder},'-',{label:'Copy Path',action:'copy-path',icon:I.copy},{label:'Add to Sidebar',action:'add-sidebar',icon:'+'}]
      : buildFileCtxMenu(entry);
    showContextMenu(e.clientX, e.clientY, items);
  });

  // ── Rubber-band drag selection on gallery strip ───────────────────────────
  const _stripWrapEl = host.querySelector('.gallery-strip-wrap');
  if (_stripWrapEl) {
    attachRubberBand(_stripWrapEl, () => {
      const out = [];
      host.querySelectorAll('.gthumb').forEach(el => {
        const i  = +el.dataset.idx;
        const r  = el.getBoundingClientRect();
        const wr = _stripWrapEl.getBoundingClientRect();
        const top  = r.top  - wr.top  + _stripWrapEl.scrollTop;
        const left = r.left - wr.left + _stripWrapEl.scrollLeft;
        out.push({ idx: i, rect: { left, top, right: left + r.width, bottom: top + r.height } });
      });
      return out;
    }, (hitSet, additive, preview) => {
      if (hitSet.size === 0 && !preview) {
        if (!additive) { sel.clear(); state.selIdx = -1; state.gallerySelIdx = -1; d().render(); }
        return;
      }
      if (!additive) sel.clear();
      sel._e = entries; // point at gallery entries so sel.has(idx) resolves correctly
      for (const idx of hitSet) {
        const e = entries[idx]; if (!e) continue;
        sel._paths.add(e.path); sel.last = idx;
      }
      const lastIdx = hitSet.size > 0 ? [...hitSet][hitSet.size - 1] : -1;
      if (lastIdx >= 0) { state.selIdx = lastIdx; state.gallerySelIdx = lastIdx; }
      // Live highlight during drag
      host.querySelectorAll('.gthumb').forEach(el => {
        el.classList.toggle('sel', sel.has(+el.dataset.idx));
      });
      if (!preview) d().render();
    });
  }
  _loadContent();
  _bindZoom();
  _applyZoom();

  // Ctrl+wheel zoom on gallery main area
  const galleryMain = host.querySelector('#gallery-main');
  if (galleryMain && !galleryMain._wheelZoomWired) {
    galleryMain._wheelZoomWired = true;
    galleryMain.addEventListener('wheel', e => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (state._galleryFit) return;
      const delta = e.deltaY < 0 ? 0.15 : -0.15;
      state._galleryZoom = Math.min(5, Math.max(0.25, (state._galleryZoom || 1) + delta));
      _applyZoom();
    }, { passive: false });
  }
}
function _setupThumbObserver(host,stripWrap){
  if(thumbObserver)thumbObserver.disconnect();
  // stripWrap passed directly from caller — avoids a redundant querySelector
  const sw=stripWrap||host.querySelector('.gallery-strip-wrap');
  thumbObserver=new IntersectionObserver(entries=>{
    for(const obs of entries){
      if(!obs.isIntersecting)continue;
      _loadGthumb(obs.target);
      thumbObserver.unobserve(obs.target);
    }
  // root:sw scopes intersection to the strip-wrap viewport; rootMargin pre-loads
  // items slightly before they scroll into view for seamless thumbnail reveal.
  },{root:sw,rootMargin:'200px',threshold:0});
  // NOTE: No scroll fallback needed here. The virtual strip's own scroll listener
  // calls _paintStrip which adds new items and immediately observes them.
  // The IntersectionObserver fires for every observed item inside rootMargin — that
  // covers all rendered items automatically without a second scroll listener.
}
function _loadGthumb(el){
  const path=el.dataset.thumbPath;
  if(!path||el.dataset.thumbLoaded)return;
  el.dataset.thumbLoaded='1';
  const {getMediaUrl}=d();
  const ext = (path.split('.').pop() || '').toLowerCase();
  const isAudio = AUDIO_EXTS.includes(ext);
  
  // Handle audio covers
  if (isAudio) {
    if (_audioCoverCache[path]) {
      _showAudioCover(el, _audioCoverCache[path]);
      return;
    }
    _getAudioCover(path).then(cover => {
      if (cover) _showAudioCover(el, cover);
    });
    return;
  }
  
  const showThumb=(url)=>{
    if(!el.isConnected)return;
    const existing=el.querySelector('.gthumb-icon,.gthumb-media-icon');
    const img=document.createElement('img');
    img.decoding='async';img.loading='lazy';img.className='gthumb-img';
    img.style.cssText='width:100%;height:60px;object-fit:cover;border-radius:4px 4px 0 0;display:block;flex-shrink:0;opacity:0;transition:opacity .15s ease-out;';
    const isVid = VIDEO_EXTS.includes(ext);
    img.onload=()=>{
      img.style.opacity='1';
      // Remove shimmer once image is loaded
      el.querySelector('.gthumb-shimmer')?.classList.remove('gthumb-shimmer');
      // Play indicator for video thumbnails in the gallery strip
      if (isVid && !el.querySelector('.gthumb-play')) {
        const play = document.createElement('div');
        play.className = 'gthumb-play';
        play.style.cssText = 'position:absolute;top:2px;right:3px;pointer-events:none;';
        play.innerHTML = '<div style="width:16px;height:16px;background:rgba(0,0,0,0.6);border-radius:50%;display:flex;align-items:center;justify-content:center;"><svg width="6" height="8" viewBox="0 0 6 8" fill="white"><polygon points="0,0 6,4 0,8"/></svg></div>';
        el.appendChild(play);
      }
    };
    img.src=url;
    if(existing)existing.replaceWith(img);else el.prepend(img);
  };
  if(_thumbCache.has(path)){showThumb(_thumbCache.get(path));return;}
  invoke('get_thumbnail',{path}).then(thumbPath=>{
    const url=getMediaUrl(thumbPath);
    _thumbCache.set(path,url);
    showThumb(url);
  }).catch(()=>{});
}

function _showAudioCover(el, coverUrl) {
  if (!el.isConnected) return;
  // Replace only the icon, keep the label
  const iconEl = el.querySelector('.gthumb-icon');
  const img = document.createElement('img');
  img.decoding = 'async';
  img.className = 'gthumb-audio-cover';
  img.style.cssText = 'width:60px;height:60px;object-fit:cover;border-radius:6px;display:block;';
  img.src = coverUrl;
  img.onload = () => el.querySelector('.gthumb-shimmer')?.classList.remove('gthumb-shimmer');
  if (iconEl) iconEl.replaceWith(img);
  else el.prepend(img);
}

function openLightboxUrl(entry,url){
  document.getElementById('lightbox')?.remove();
  const lb=document.createElement('div');lb.id='lightbox';lb.tabIndex=0;
  lb.innerHTML='<div class="lb-backdrop" id="lb-bd"></div><div class="lb-content"><img src="'+url+'" class="lb-img"/><div class="lb-caption">'+escHtml(entry.name)+' \xb7 '+fmtSize(entry.size)+'</div><button class="lb-close" id="lb-close">'+I.x+'</button></div>';
  document.body.appendChild(lb);lb.focus();
  const close=()=>lb.remove();
  lb.querySelector('#lb-close')?.addEventListener('click',close);
  lb.querySelector('#lb-bd')?.addEventListener('click',close);
  lb.addEventListener('keydown',ev=>{if(ev.key==='Escape')close();});
}

// ── Preview panel ─────────────────────────────────────────────────────────────
export function renderPreview(){
  const {state,getMediaUrl,getHeicJpegUrl}=d();
  const panel=document.getElementById('preview-panel');if(!panel)return;
  const e=state.previewEntry;
  const ext2prev = panel.dataset.previewExt || '';
  const newExt = (e?.extension||'').toLowerCase();

  // Short-circuit: same video, player still alive → only refresh tags section
  const _prevSlot = document.getElementById('media-preview-slot');
  const sameVideo = e && VIDEO_EXTS.includes(newExt)
    && panel.dataset.previewPath === e.path
    && _prevSlot?._mpvCleanup;
  if (sameVideo) {
    const tagsEl = panel.querySelector('#preview-tags-section');
    if (tagsEl) { tagsEl.outerHTML = renderTagsUI(e, state); attachTagHandlers(panel, e, state); }
    return;
  }

  // Short-circuit: same image still displayed → only refresh tags.
  // Without this guard, every render() triggered by a watcher event (even for
  // an unchanged directory) tears down the <img> element and recreates it,
  // causing a visible reload flicker on the preview panel every ~300ms when
  // a browser download is active or any file in the watched dir is modified.
  // Condition: same path, same extension (not video/audio — those have their
  // own logic), and the <img> element is still connected to the DOM.
  const _previewImg = document.getElementById('preview-img');
  const sameImage = e && IMAGE_EXTS.includes(newExt)
    && panel.dataset.previewPath === e.path
    && panel.dataset.previewExt  === newExt
    && _previewImg?.isConnected;
  if (sameImage) {
    const tagsEl = panel.querySelector('#preview-tags-section');
    if (tagsEl) { tagsEl.outerHTML = renderTagsUI(e, state); attachTagHandlers(panel, e, state); }
    return;
  }

  // Stop the current preview player BEFORE panel.innerHTML tears down the slot.
  // If we wait until after innerHTML, slot._mpvCleanup is gone and video keeps running.
  if (_prevSlot) _stopSlot(_prevSlot);
  if(!e){panel.innerHTML='<div class="preview-empty">Select a file to preview</div>';return;}
  if(e.is_dir){
    // toLocaleString (not toLocaleDateString) correctly formats date+time together
    const fmtLong = ts => !ts ? '--' : new Date(ts*1000).toLocaleString('en-GB',{day:'numeric',month:'long',year:'numeric',hour:'numeric',minute:'2-digit'});
    const renderFolderPanel = (sizeStr, countStr) => {
      panel.innerHTML=`
      <div class="preview-header pv-folder-header">
        <span class="preview-icon pv-folder-icon" style="color:${fileColor(e)}">${fileIcon(e).replace('<svg','<svg style="width:80px;height:80px"')}</span>
        <div class="preview-name">${escHtml(e.name)}</div>
        <div class="preview-kind">Folder${countStr?' · '+countStr:''}${sizeStr?' · '+sizeStr:''}</div>
      </div>
      <div class="pv-folder-scroll">
        <div class="preview-meta pv-info-section">
          <div class="pv-section-title">Information</div>
          ${e.created!=null?`<div class="preview-row"><span>Created</span><span>${fmtLong(e.created)}</span></div>`:''}
          <div class="preview-row"><span>Modified</span><span>${fmtLong(e.modified)}</span></div>
          ${e.accessed!=null?`<div class="preview-row"><span>Last opened</span><span>${fmtLong(e.accessed)}</span></div>`:''}
          <div class="preview-row"><span>Permissions</span><span class="mono">${e.permissions||'--'}</span></div>
        </div>
        ${renderTagsUI(e,state)}
      </div>`;
      attachTagHandlers(panel,e,state);
    };
    renderFolderPanel(null, null);
    // Fetch item count and size concurrently
    Promise.all([
      invoke('list_directory_fast',{path:e.path}).then(r=>(r?.entries?.length??0)).catch(()=>null),
      invoke('get_dir_size_fast',{path:e.path}).then(b=>b>0?fmtSize(b):null).catch(()=>null),
    ]).then(([count, sizeStr]) => {
      if(state.previewEntry!==e) return;
      const countStr = count!=null ? `${count} item${count!==1?'s':''}` : null;
      renderFolderPanel(sizeStr, countStr);
    });
    return;
  }
  if(state.previewLoading){
    panel.innerHTML='<div class="preview-header"><span class="preview-icon" style="color:' + (fileColor(e)) + '">' + (fileIcon(e).replace('<svg','<svg style="width:48px;height:48px"')) + '</span><div class="preview-name">' + escHtml(e.name) + '</div></div><div class="preview-loading"><div class="spinner"></div></div>';return;
  }
  // r23: show styled error state when preview fetch failed (previewData===null after load)
  if(state.previewError && !state.previewLoading){
    panel.innerHTML=`
      <div class="preview-header">
        <span class="preview-icon" style="color:${fileColor(e)}">${fileIcon(e).replace('<svg','<svg style="width:48px;height:48px"')}</span>
        <div class="preview-name">${escHtml(e.name)}</div>
      </div>
      <div class="pv-error-state">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#f87171" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r="0.8" fill="#f87171" stroke="none"/></svg>
        <div class="pv-error-msg">Preview unavailable</div>
        <div class="pv-error-sub">This file type cannot be previewed</div>
      </div>`;
    return;
  }
  const d2=state.previewData,ext2=e.extension||'';
  let content='';
  if(PDF_EXTS.includes(ext2)){
    content=`<div class="preview-pdf-wrap"><iframe class="preview-pdf" src="${getMediaUrl(e.path)}" title="PDF Preview"></iframe></div>`;
  }else if(VIDEO_EXTS.includes(ext2)){
    content=`<div class="preview-media-wrap" id="media-preview-slot"><div class="media-loading"><div class="spinner"></div><span>Loading video...</span></div></div>`;
  }else if(AUDIO_EXTS.includes(ext2)){
    content=`<div class="preview-audio-wrap" id="media-preview-slot"><canvas id="viz-canvas" class="viz-canvas"></canvas></div>`;
  }else if(IMAGE_EXTS.includes(ext2)){
    // HEIC/HEIF: WebKit2GTK cannot decode these natively; route through the
    // /heic-jpeg/ ffmpeg proxy so the browser receives a standard JPEG.
    const isHeic = ext2==='heic'||ext2==='heif';
    const imgUrl = isHeic ? getHeicJpegUrl(e.path) : getMediaUrl(e.path);
    const thumbUrl=d2?.thumb_path?getMediaUrl(d2.thumb_path):null;
    const src=thumbUrl||imgUrl;
  content=`<div class="preview-image-wrap">
    <img src="${src}" decoding="async" loading="lazy" class="preview-img" id="preview-img"
      ${thumbUrl?'data-full="' + (imgUrl) + '"':''}/>
    <div style="display:flex;gap:6px;align-items:center;flex-shrink:0;">
      <div class="preview-img-hint">Click for fullscreen</div>
      <button id="pv-copy-img" title="Copy image to clipboard" style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:6px;color:var(--text-tertiary);font-size:10px;cursor:pointer;padding:2px 8px;font-family:var(--font);transition:background .1s;">⎘ Copy</button>
    </div>
  </div>`;
  }else if(ARCHIVE_EXTS.includes(ext2)||['zip','tar','gz','bz2','xz','zst','7z','rar','tgz','tbz2','txz'].includes(ext2)){
    // ── Archive content preview ──────────────────────────────────────────────
    content=`<div class="preview-archive-wrap" id="archive-preview-wrap">
      <div class="archive-header">
        <span style="color:${fileColor(e)}">${fileIcon(e).replace('<svg','<svg style="width:36px;height:36px"')}</span>
        <div>
          <div class="archive-name">${escHtml(e.name)}</div>
          <div class="archive-size">${e.size!=null?fmtSize(e.size):''}</div>
        </div>
      </div>
      <div class="archive-contents" id="archive-contents">
        <div class="archive-loading"><div class="spinner" style="width:14px;height:14px"></div><span>Reading archive…</span></div>
      </div>
    </div>`;
    // Load archive contents async after panel renders
    requestAnimationFrame(()=>{
      const contEl=document.getElementById('archive-contents');
      if(!contEl)return;
      invoke('get_archive_contents',{path:e.path}).then(items=>{
        if(!contEl.isConnected)return;
        if(!items||!items.length){contEl.innerHTML='<div class="archive-empty">Archive is empty</div>';return;}
        const dirs=new Set();
        items.forEach(it=>{
          const parts=it.name.split('/');
          for(let i=1;i<parts.length;i++)dirs.add(parts.slice(0,i).join('/'));
        });
        const files=items.filter(it=>!it.name.endsWith('/'));
        const totalSize=files.reduce((a,b)=>a+(b.size||0),0);
        contEl.innerHTML=`<div class="archive-stats">${files.length} file${files.length!==1?'s':''} · ${dirs.size} folder${dirs.size!==1?'s':''} · ${fmtSize(totalSize)} uncompressed</div>`+
          items.slice(0,80).map(it=>{
            const isDir=it.name.endsWith('/');
            const depth=(it.name.split('/').length-1)-(isDir?1:0);
            const nm=it.name.split('/').filter(Boolean).pop()||it.name;
            return `<div class="archive-item" style="padding-left:${8+depth*14}px">
              <span class="archive-item-icon">${isDir?I.folder.replace('<svg','<svg style="width:12px;height:12px"'):''}</span>
              <span class="archive-item-name">${escHtml(nm)}</span>
              ${!isDir&&it.size?`<span class="archive-item-size">${fmtSize(it.size)}</span>`:''}
            </div>`;
          }).join('')+(items.length>80?`<div class="archive-more">…and ${items.length-80} more items</div>`:'');
      }).catch(err=>{
        if(contEl.isConnected)contEl.innerHTML=`<div class="archive-error">Cannot read archive: ${escHtml(String(err))}</div>`;
      });
    });
  }else if(ISO_EXTS.includes(ext2)){
    // ── ISO disc image preview ──────────────────────────────────────────────
    // Shows mount/unmount and write-to-USB controls. Mount state is determined
    // async by checking losetup for an existing loop device backing this file.
    content=`<div class="preview-iso-wrap" id="iso-preview-wrap">
      <div class="iso-disc-icon" style="color:${fileColor(e)}">${I.disc.replace('<svg','<svg style="width:72px;height:72px"')}</div>
      <div class="iso-size-label">${fmtSize(e.size)}</div>
      <div id="iso-status" class="iso-status">Checking mount status…</div>
      <div id="iso-actions" class="iso-actions">
        <button class="iso-btn iso-btn-primary" id="iso-mount-btn">${I.mount.replace('<svg','<svg style="width:14px;height:14px"')} Mount ISO</button>
        <button class="iso-btn iso-btn-secondary" id="iso-unmount-btn" style="display:none">${I.unmount.replace('<svg','<svg style="width:14px;height:14px"')} Unmount</button>
        <button class="iso-btn iso-btn-burn" id="iso-burn-btn">${I.burn.replace('<svg','<svg style="width:14px;height:14px"')} Write to USB Drive…</button>
      </div>
      <div id="iso-burn-progress-wrap" style="display:none">
        <div class="iso-progress-bar-bg"><div class="iso-progress-bar" id="iso-progress-bar" style="width:0%"></div></div>
        <div class="iso-progress-label" id="iso-progress-label">Preparing…</div>
        <button class="iso-btn iso-btn-secondary" id="iso-burn-cancel" style="margin-top:6px">Cancel</button>
      </div>
    </div>`;
  }else if(FONT_EXTS.includes(ext2)){
    // ── Font preview — live specimen rendered via @font-face data URL ────────
    // The font file is served via the media port so WebKit can load it as a
    // web font. The specimen shows the full alphabet + numerals in the font itself.
    const fontUrl = getMediaUrl(e.path);
    const fontId  = 'ff-pv-font-' + Math.random().toString(36).slice(2);
    content = `<div class="preview-font-wrap" id="preview-font-wrap">
      <style>@font-face{font-family:'${fontId}';src:url('${fontUrl}')}</style>
      <div class="preview-font-specimen" style="font-family:'${fontId}',serif">
        <div class="pf-display">Aa Bb Cc</div>
        <div class="pf-alpha">ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz</div>
        <div class="pf-nums">0123456789 !@#$%&amp;*()_+-=[]{}|;:',./&lt;&gt;?</div>
        <div class="pf-sentence">The quick brown fox jumps over the lazy dog.</div>
        <div class="pf-sentence pf-sm">Pack my box with five dozen liquor jugs.</div>
      </div>
      <div class="preview-font-actions">
        <button class="preview-font-install-btn" id="pv-font-install-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" style="width:14px;height:14px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Install Font
        </button>
        <div class="pv-font-status" id="pv-font-status"></div>
        <div class="pv-font-progress-wrap" id="pv-font-progress-wrap" style="display:none">
          <div class="pv-font-progress-bar" id="pv-font-progress-bar"></div>
        </div>
      </div>
    </div>`;
  }else if(HTML_EXTS.includes(ext2)){
    // ── HTML file preview — sandboxed iframe via media port ──────────────────
    content=`<div class="preview-html-wrap"><iframe class="preview-html" src="${getMediaUrl(e.path)}" title="HTML Preview" sandbox="allow-scripts allow-same-origin"></iframe></div>`;
  }else if(ext2==='xcf'){
    // ── XCF (GIMP) — browser cannot render natively; show open-in-app nudge ─
    content=`<div class="preview-binary preview-xcf"><span style="color:${fileColor(e)}">${fileIcon(e).replace('<svg','<svg style="width:64px;height:64px"')}</span><span class="xcf-label">GIMP Image</span><span class="xcf-hint">XCF files cannot be rendered inline.<br>Open in GIMP to view or edit.</span></div>`;
  }else if(OFFICE_EXTS.includes(ext2)&&d2?._office_pdf){
    // ── Office file: LibreOffice converted to PDF — show as iframe ───────────
    const pdfUrl=getMediaUrl(d2._office_pdf);
    content=`<div class="preview-pdf-wrap"><iframe class="preview-pdf" src="${pdfUrl}" title="Document Preview"></iframe></div>`;
  }else if(OFFICE_EXTS.includes(ext2)&&d2?.content!=null){
    // ── Office file: text extraction fallback (no LibreOffice) ──────────────
    const docLabel={'docx':'Word Document','doc':'Word Document','xlsx':'Spreadsheet','xls':'Spreadsheet','pptx':'Presentation','ppt':'Presentation','odt':'Document','ods':'Spreadsheet','odp':'Presentation','odg':'Drawing'}[ext2]||ext2.toUpperCase();
    content=`<div class="preview-office-text"><div class="preview-office-banner"><span style="color:${fileColor(e)}">${fileIcon(e).replace('<svg','<svg style="width:18px;height:18px"')}</span><span class="preview-office-label">${escHtml(docLabel)} — text preview</span><span class="preview-office-hint">Install LibreOffice for full preview</span></div><pre class="preview-code preview-office-pre">${escHtml(d2.content.slice(0,32768))}</pre></div>`;
  }else if(d2?.is_text&&d2?.content!=null){
    content=`<pre class="preview-code">${escHtml(d2.content)}</pre>`;
  }else if(d2){
    content=`<div class="preview-binary"><span style="color:${fileColor(e)}">${fileIcon(e).replace('<svg','<svg style="width:40px;height:40px"')}</span><span>${mimeLabel(d2.mime_type)}</span></div>`;
  }
  const extLabel=(e.extension||'').toUpperCase();
  // r125-r138: determine which meta editors apply to this file
  const _isImg   = IMAGE_EXTS.includes(ext2);
  const _isAudio = AUDIO_EXTS.includes(ext2);
  const _isPdf   = ext2 === 'pdf';
  const _hasMetaEditor = _isImg || _isAudio || _isPdf;

  panel.innerHTML='\n    <div class="preview-header">\n      <span class="preview-icon" style="color:' + (fileColor(e)) + '">' + (fileIcon(e).replace('<svg','<svg style="width:48px;height:48px"')) + '</span>\n      <div class="preview-name">' + escHtml(e.name) + '</div>\n      <div class="preview-kind">' + (extLabel?extLabel+' · ':'') + (d2?mimeLabel(d2.mime_type):'') + '</div>\n    </div>\n    <div class="pv-scroll-body">\n    ' + (content) + '\n    ' + (renderTagsUI(e,state)) + '\n    <div class="preview-meta">\n      <div class="preview-row"><span>Size</span><span>' + (fmtSize(e.size)) + '</span></div>\n      <div class="preview-row"><span>Modified</span><span>' + (fmtDate(e.modified)) + '</span></div>\n      <div class="preview-row"><span>Permissions</span><span class="mono">' + (e.permissions||'--') + '</span></div>\n      ' + (d2?.line_count!=null?'<div class="preview-row"><span>Lines</span><span>' + (d2.line_count.toLocaleString()) + '</span></div>':'') + '\n      <div class="preview-row" id="pv-checksum-row">\n        <span>Checksum</span>\n        <button class="pv-checksum-reveal" id="pv-checksum-btn" style="background:none;border:none;color:var(--accent-blue);font-size:10px;cursor:pointer;padding:0;">Reveal</button>\n      </div>\n    </div>\n    </div>\n    ' + (_hasMetaEditor ? '<button class="preview-open-btn pv-edit-meta-btn" id="pv-edit-meta-btn" style="margin-top:0">✏ Edit Metadata</button>' : '') + '\n    <button class="preview-open-btn" id="preview-open">' + (I.openExt) + ' Open with default app</button>';

  document.getElementById('preview-open')?.addEventListener('click',()=>invoke('open_file',{path:e.path}).catch(()=>{}));
  // Copy image to clipboard
  document.getElementById('pv-copy-img')?.addEventListener('click', async () => {
    const btn = document.getElementById('pv-copy-img');
    const imgEl = document.getElementById('preview-img');
    const src = imgEl?.dataset.full || imgEl?.src || getMediaUrl(e.path);
    try {
      if (!src) throw new Error('no src');
      const res = await fetch(src);
      const blob = await res.blob();
      const item = new ClipboardItem({[blob.type]: blob});
      await navigator.clipboard.write([item]);
      if (btn) { btn.textContent = '✓ Copied'; setTimeout(() => { if(btn.isConnected) btn.textContent = '⎘ Copy'; }, 1800); }
    } catch {
      // Fallback: copy URL
      navigator.clipboard.writeText(src).catch(()=>{});
      if (btn) { btn.textContent = '✓ URL copied'; setTimeout(() => { if(btn.isConnected) btn.textContent = '⎘ Copy'; }, 1800); }
    }
  });
  // Track file currently shown in preview (used for same-file guard on next render)
  panel.dataset.previewExt = ext2;
  panel.dataset.previewPath = e.path;
  document.getElementById('preview-img')?.addEventListener('click',ev=>{
    const imgEl=ev.currentTarget;
    // Use full-res HTTP URL (data-full attr) or current src
    const fullSrc=imgEl.dataset.full||imgEl.src||getMediaUrl(e.path);
    document.getElementById('lightbox')?.remove();
    const lb=document.createElement('div');lb.id='lightbox';lb.tabIndex=0;
    lb.innerHTML='<div class="lb-backdrop" id="lb-bd"></div><div class="lb-content"><img src="' + (fullSrc) + '" class="lb-img" decoding="async"/><div class="lb-caption">' + (escHtml(e.name)) + ' · ' + (fmtSize(e.size)) + '</div><button class="lb-close" id="lb-close">' + (I.x) + '</button></div>';
    document.body.appendChild(lb);lb.focus();
    const close=()=>lb.remove();
    lb.querySelector('#lb-close')?.addEventListener('click',close);
    lb.querySelector('#lb-bd')?.addEventListener('click',close);
    lb.addEventListener('keydown',ev2=>{if(ev2.key==='Escape')close();});
  });
  attachTagHandlers(panel,e,state);

  // Media (video/audio slot)
  const slot=document.getElementById('media-preview-slot');
  if(slot){
    const mediaUrl=getMediaUrl(e.path);
    if(VIDEO_EXTS.includes(ext2)){
      // Slot was already stopped before panel.innerHTML; just mount fresh player
      _mountMpvPlayer(slot, e.path).catch(()=>{});
      // r42: codec badge
      injectVideoCodecBadge(panel, e.path);
    }else if(AUDIO_EXTS.includes(ext2)){
      // Reuse existing audio element if it's the same file — avoids double createMediaElementSource
      const existing=slot.querySelector('audio');
      const isSame=existing&&(existing.dataset.filePath===e.path);
      if(!isSame){
        // Use DOM methods so the canvas inside the wrap is preserved (innerHTML would destroy it)
        const canvas=slot.querySelector('#viz-canvas');
        [...slot.childNodes].forEach(n=>{if(n!==canvas)n.remove();});
        const iconEl=document.createElement('span');
        iconEl.className='preview-audio-icon';
        iconEl.style.color=fileColor(e);
        iconEl.innerHTML=fileIcon(e).replace('<svg','<svg style="width:56px;height:56px"');
        const aud=document.createElement('audio');
        aud.className='preview-audio';aud.id='preview-audio-el';
        aud.dataset.filePath=e.path;aud.crossOrigin='anonymous';
        aud.controls=true;aud.preload='none';
        // Insert into DOM first so canvas is still last child
        slot.insertBefore(iconEl,canvas||null);
        slot.insertBefore(aud,canvas||null);
        // Wire WebAudio graph BEFORE setting src — element is idle, no interruption possible
        if(canvas) startAudioVisualizer(aud,canvas);
        // Set src after graph is wired — preload=none means no data fetch starts yet
        aud.src=mediaUrl;
        // Replace icon with album cover if available
        const _replacePvIcon = (coverUrl) => {
          const icon = slot.querySelector('.preview-audio-icon');
          if (!icon || !icon.isConnected) return;
          const coverImg = document.createElement('img');
          coverImg.src = coverUrl;
          coverImg.style.cssText = 'width:80px;height:80px;object-fit:cover;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,0.4);display:block;flex-shrink:0;';
          icon.replaceWith(coverImg);
        };
        if (_audioCoverCache[e.path] && _audioCoverCache[e.path] !== 'loading') {
          _replacePvIcon(_audioCoverCache[e.path]);
        } else {
          _getAudioCover(e.path).then(cover => { if (cover) _replacePvIcon(cover); });
        }
      } else {
        // Same file reselected — just reattach visualizer to existing canvas
        const audioEl=existing;
        const cvs=slot.querySelector('#viz-canvas');
        if(audioEl&&cvs&&!audioEl._vizSetup) startAudioVisualizer(audioEl,cvs);
      }
    }
  }

  // ── Font install wiring ───────────────────────────────────────────────────
  if (FONT_EXTS.includes(ext2)) {
    _wireFontInstall(e.path, panel);
  }

  // ── ISO preview wiring ────────────────────────────────────────────────────
  // Runs only when an ISO file is selected. Checks current mount state async,
  // then wires Mount / Unmount / Burn buttons inside the preview panel.
  if (ISO_EXTS.includes(ext2)) {
    _wireIsoPreview(e.path, panel);
  }

  // ── r135: Checksum reveal ─────────────────────────────────────────────────
  document.getElementById('pv-checksum-btn')?.addEventListener('click', async () => {
    const row = document.getElementById('pv-checksum-row');
    if (!row || !panel.isConnected) return;
    row.innerHTML = '<span>Checksum</span><span style="color:var(--text-tertiary);font-size:10px">Computing…</span>';
    try {
      const h = await invoke('get_file_checksums', {path: e.path});
      if (!row.isConnected) return;
      const fmt = (label, val) =>
        `<div class="pv-hash-row"><span class="pv-hash-label">${label}</span>`
        + `<span class="pv-hash-val" title="${val}">${val.slice(0,16)}…</span>`
        + `<button class="pv-hash-copy" data-hash="${val}" title="Copy ${label}">⎘</button></div>`;
      row.innerHTML = '<span style="color:var(--text-tertiary)">Checksum</span>'
        + `<div class="pv-hash-block">${fmt('MD5',h.md5)}${fmt('SHA-1',h.sha1)}${fmt('SHA-256',h.sha256)}</div>`;
      row.querySelectorAll('.pv-hash-copy').forEach(btn =>
        btn.addEventListener('click', () =>
          navigator.clipboard.writeText(btn.dataset.hash)
            .then(() => { btn.textContent = '✓'; setTimeout(() => btn.textContent = '⎘', 1500); })
            .catch(() => {})
        )
      );
    } catch(err) {
      if (row.isConnected) row.innerHTML = '<span>Checksum</span><span style="color:#f87171;font-size:10px">Failed</span>';
    }
  });

  // ── r125/r128/r136: Edit Metadata wiring ─────────────────────────────────
  document.getElementById('pv-edit-meta-btn')?.addEventListener('click', () => {
    if (_isImg)   _showExifEditor(e, panel);
    else if (_isAudio) _showAudioTagEditor(e, panel);
    else if (_isPdf)   _showPdfMetaEditor(e, panel);
  });
}

// ── ISO preview controller ─────────────────────────────────────────────────
// Separated so renderPreview stays readable. Called once per ISO selection.
function _wireIsoPreview(isoPath, panel) {
  const wrap      = () => panel.querySelector('#iso-preview-wrap');
  const statusEl  = () => panel.querySelector('#iso-status');
  const mountBtn  = () => panel.querySelector('#iso-mount-btn');
  const unmountBtn= () => panel.querySelector('#iso-unmount-btn');
  const burnBtn   = () => panel.querySelector('#iso-burn-btn');
  const progressWrap = () => panel.querySelector('#iso-burn-progress-wrap');
  const actionsWrap  = () => panel.querySelector('#iso-actions');
  const progressBar  = () => panel.querySelector('#iso-progress-bar');
  const progressLbl  = () => panel.querySelector('#iso-progress-label');

  // Stores the loop device (/dev/loopN) while ISO is mounted
  let _loopDev = '';
  let _burnUnlisten = null; // Tauri event unlisten handle

  const setStatus = (msg, isMounted) => {
    const s = statusEl(); if (!s) return;
    s.textContent = msg;
    s.className = `iso-status${isMounted ? ' iso-status-mounted' : ''}`;
    const mb = mountBtn();   if (mb)  mb.style.display   = isMounted ? 'none' : '';
    const ub = unmountBtn(); if (ub)  ub.style.display   = isMounted ? ''     : 'none';
  };

  const setError = (msg) => {
    const s = statusEl(); if (!s) return;
    s.textContent = msg;
    s.className = 'iso-status iso-status-error';
  };

  // Check if this ISO is already mounted via a loop device
  invoke('get_iso_loop_device', {isoPath}).then(dev => {
    if (!wrap()) return; // panel was replaced before response
    if (dev) {
      _loopDev = dev;
      setStatus(`Mounted as ${dev}`, true);
    } else {
      setStatus('Not mounted', false);
    }
  }).catch(() => {
    if (statusEl()) setStatus('Not mounted', false);
  });

  // Mount button
  mountBtn()?.addEventListener('click', async () => {
    const btn = mountBtn(); if (!btn) return;
    btn.disabled = true;
    setStatus('Mounting…', false);
    try {
      const mountpoint = await invoke('mount_iso', {path: isoPath});
      _loopDev = await invoke('get_iso_loop_device', {isoPath});
      setStatus(`Mounted at ${mountpoint}`, true);
      const {showToast, navigate} = d();
      showToast(t('toast.iso_mounted',{path:mountpoint}),'success');
      // Navigate into the mounted ISO automatically
      if (mountpoint) navigate(mountpoint, 0);
    } catch(err) {
      setError(`Mount failed: ${err}`);
    } finally {
      if (mountBtn()) mountBtn().disabled = false;
    }
  });

  // Unmount button
  unmountBtn()?.addEventListener('click', async () => {
    const btn = unmountBtn(); if (!btn) return;
    btn.disabled = true;
    setStatus('Unmounting…', true);
    try {
      const dev = _loopDev || await invoke('get_iso_loop_device', {isoPath});
      if (!dev) { setStatus('Not mounted', false); return; }
      await invoke('unmount_iso', {loopDev: dev});
      _loopDev = '';
      setStatus('Not mounted', false);
      d().showToast(t('toast.iso_unmounted'),'success');
    } catch(err) {
      setError(`Unmount failed: ${err}`);
    } finally {
      if (unmountBtn()) unmountBtn().disabled = false;
    }
  });

  // Burn button — shows optical drive picker then starts burn
  burnBtn()?.addEventListener('click', async () => {
    let drives;
    try { drives = await invoke('list_usb_drives'); }
    catch(e) { setError(`Cannot list drives: ${e}`); return; }

    if (!drives || drives.length === 0) {
      setError('No removable USB drives detected.\nPlug in a USB drive (at least as large as the ISO) and try again.');
      return;
    }
    _showIsoBurnDialog(isoPath, drives, panel);
  });
}

// ── ISO burn dialog ────────────────────────────────────────────────────────
function _showIsoBurnDialog(isoPath, drives, panel) {
  document.getElementById('ff-iso-burn-dialog')?.remove();
  const dlg = document.createElement('div');
  dlg.id = 'ff-iso-burn-dialog';
  dlg.style.cssText = 'position:fixed;inset:0;z-index:9200;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);';
  dlg.innerHTML = `
    <div style="background:#1e1e21;border:1px solid rgba(255,255,255,.13);border-radius:14px;padding:28px 28px 22px;min-width:360px;max-width:440px;box-shadow:0 16px 48px rgba(0,0,0,.75);">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;">
        <span style="color:#ef4444;line-height:0">${I.burn.replace('<svg','<svg style="width:22px;height:22px"')}</span>
        <div>
          <div style="font-size:14px;font-weight:600;color:#f1f5f9">Write ISO to USB Drive</div>
          <div style="font-size:11px;color:#636368;margin-top:2px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(isoPath.split('/').pop())}</div>
        </div>
      </div>
      <label style="display:block;font-size:11px;color:#98989f;margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;">Optical Drive</label>
      <select id="ff-burn-device" style="width:100%;box-sizing:border-box;padding:9px 11px;background:#2a2a2d;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#f1f5f9;font-size:13px;outline:none;font-family:inherit;cursor:pointer;">
        ${drives.map(([dev, label, size]) => { const sz = size ? ` (${size >= 1073741824 ? (size/1073741824).toFixed(1)+'GB' : (size/1048576).toFixed(0)+'MB'})` : ''; return `<option value="${escHtml(dev)}">${escHtml(dev)} — ${escHtml(label)}${sz}</option>`; }).join('')}
      </select>
      <div style="margin-top:12px;padding:10px 12px;background:rgba(244,114,182,.07);border:1px solid rgba(244,114,182,.2);border-radius:8px;font-size:11px;color:#98989f;line-height:1.6;">
        ⚠ This will <strong style="color:#f87171">permanently overwrite</strong> all data on the disc.<br>
        ⚠ <strong style="color:#f87171">All data on the drive will be permanently erased.</strong><br>Requires a USB drive at least as large as the ISO.
      </div>
      <div id="ff-burn-err" style="color:#f87171;font-size:11px;margin-top:8px;min-height:16px;"></div>
      <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end;">
        <button id="ff-burn-cancel-btn" style="padding:7px 16px;background:rgba(255,255,255,.07);border:none;border-radius:7px;color:#98989f;font-size:13px;cursor:pointer;">Cancel</button>
        <button id="ff-burn-ok-btn" style="padding:7px 18px;background:#dc2626;border:none;border-radius:7px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:7px;">${I.burn.replace('<svg','<svg style="width:14px;height:14px"')} Burn</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);

  const cancel = () => dlg.remove();
  dlg.querySelector('#ff-burn-cancel-btn').addEventListener('click', cancel);
  dlg.addEventListener('click', ev => { if (ev.target === dlg) cancel(); });
  // Wire burn device ff-csel
  const _burnCsel = dlg.querySelector('.ff-csel');
  if (_burnCsel) {
    const _closeBurn = () => _burnCsel.classList.remove('open');
    _burnCsel.querySelector('.ff-csel-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      _burnCsel.classList.toggle('open');
    });
    _burnCsel.querySelectorAll('.ff-csel-opt').forEach(opt => {
      opt.addEventListener('click', e => {
        e.stopPropagation();
        _burnCsel.querySelector('.ff-csel-label').textContent = opt.textContent;
        _burnCsel.querySelectorAll('.ff-csel-opt').forEach(o => o.classList.toggle('active', o === opt));
        _burnCsel.querySelector('#ff-burn-device').value = opt.dataset.val;
        _closeBurn();
      });
    });
    document.addEventListener('click', _closeBurn, {once:true, capture:true});
  }

  dlg.querySelector('#ff-burn-ok-btn').addEventListener('click', async () => {
    const device = dlg.querySelector('#ff-burn-device').value;
    if (!device) return;

    // Swap dialog to progress view
    dlg.querySelector('#ff-burn-ok-btn').disabled = true;
    dlg.querySelector('#ff-burn-cancel-btn').disabled = true;
    dlg.querySelector('#ff-burn-err').textContent = '';

    // Show progress bar inside dialog
    const progressArea = document.createElement('div');
    progressArea.style.cssText = 'margin-top:14px;';
    progressArea.innerHTML = `
      <div style="height:6px;background:rgba(255,255,255,.08);border-radius:3px;overflow:hidden;margin-bottom:8px;">
        <div id="ff-dlg-bar" style="height:100%;background:#be185d;width:0%;transition:width .4s ease;border-radius:3px;"></div>
      </div>
      <div id="ff-dlg-label" style="font-size:11px;color:#98989f;line-height:1.5;word-break:break-all;max-height:60px;overflow:hidden;">Starting burn…</div>`;
    dlg.querySelector('div').appendChild(progressArea);

    const bar  = () => document.getElementById('ff-dlg-bar');
    const lbl  = () => document.getElementById('ff-dlg-label');

    // Listen for progress events from the Rust burn command
    let unlisten;
    try {
      // listen is statically imported at the top of views.js
      unlisten = await listen('iso-burn-progress', ev => {
        const {percent, line, done, error} = ev.payload;
        if (bar())  bar().style.width = `${percent}%`;
        if (lbl() && line) lbl().textContent = line;
        if (done || error) {
          unlisten?.();
          if (error) {
            if (lbl()) lbl().style.color = '#f87171';
            if (lbl()) lbl().textContent = error;
            dlg.querySelector('#ff-burn-cancel-btn').disabled = false;
            dlg.querySelector('#ff-burn-cancel-btn').textContent = 'Close';
          } else {
            if (bar()) bar().style.background = '#22c55e';
            if (lbl()) { lbl().style.color = '#34d399'; lbl().textContent = 'Write complete — safe to remove the drive.'; }
            setTimeout(() => dlg.remove(), 2000);
          }
        }
      });
    } catch(e) {
      dlg.querySelector('#ff-burn-err').textContent = `Event listener failed: ${e}`;
      return;
    }

    // Fire the burn command (long-running — resolves when done)
    invoke('write_iso_to_usb', {isoPath, device}).catch(err => {
      unlisten?.();
      if (lbl()) { lbl().style.color = '#f87171'; lbl().textContent = String(err); }
      dlg.querySelector('#ff-burn-cancel-btn').disabled = false;
      dlg.querySelector('#ff-burn-cancel-btn').textContent = 'Close';
    });
  });
}

// ── Tags UI ───────────────────────────────────────────────────────────────────
const TAG_PALETTE=[
  {name:'Red',color:'#f87171'},{name:'Orange',color:'#fb923c'},
  {name:'Yellow',color:'#fbbf24'},{name:'Green',color:'#34d399'},
  {name:'Blue',color:'#60a5fa'},{name:'Purple',color:'#a78bfa'},
  {name:'Gray',color:'#94a3b8'},
];

function renderTagsUI(e,state){
  const tags=state._fileTags?.[e.path]||[];
  const allTags=state._allTags||[];
  // Don't render the section at all when there are no tags anywhere
  if(tags.length===0 && allTags.length===0) return '';
  const swatches=TAG_PALETTE.map(p=>{
    const active=tags.includes(p.name);
    return `<button class="tag-swatch${active?' tag-swatch-active':''}" data-tag="${p.name}" data-color="${p.color}"
      style="--sw-color:${p.color};" title="${p.name}${active?' (click to remove)':''}">${active?'<svg viewBox="0 0 10 10" fill="none" stroke="white" stroke-width="2"><polyline points="1.5,5 4,7.5 8.5,2"/></svg>':''}</button>`;
  }).join('');
  const allTagsManage = (state._allTags||[]).length > 0 ? `
    <div class="preview-tags-manage" id="preview-tags-manage">
      ${(state._allTags||[]).map(t=>`<span class="manage-tag-pill" style="background:${tagColor(t)}22;color:${tagColor(t)};border:1px solid ${tagColor(t)}44">
        ${escHtml(t)}
        <button class="manage-tag-del" data-tag="${escHtml(t)}" title="Delete tag">×</button>
      </span>`).join('')}
    </div>` : '';
  return `<div class="preview-tags" id="preview-tags-section">
    <div class="preview-tags-header">
      <span class="preview-tags-label">${I.tag} Tags</span>
      <button class="tags-manage-btn" id="tags-manage-toggle" title="Manage tags" style="background:none;border:none;color:#636368;font-size:10px;cursor:pointer;padding:2px 6px;border-radius:4px;">Manage</button>
    </div>
    ${allTagsManage}
    <div class="preview-tag-swatches" id="preview-tag-swatches">${swatches}</div>
    ${tags.length?'<div class="preview-tags-list" id="preview-tags-list">\n      ' + (tags.map(t=>`<span class="preview-tag" style="background:${tagColor(t)}22;color:${tagColor(t)};border:1px solid ${tagColor(t)}55">${t}</span>`).join('')) + '\n    </div>':''}
  </div>`;
}

function attachTagHandlers(panel,e,state){
  // Tags manage toggle
  panel.querySelector('#tags-manage-toggle')?.addEventListener('click',()=>{
    const m=panel.querySelector('#preview-tags-manage');
    if(m) m.style.display = m.style.display==='none'?'flex':'none';
  });
  // Delete a tag entirely (from all files)
  panel.querySelectorAll('.manage-tag-del').forEach(btn=>{
    btn.addEventListener('click',async ev=>{
      ev.stopPropagation();
      const tag=btn.dataset.tag;
      if(!confirm(`Delete tag "${tag}" from all files? This cannot be undone.`))return;
      try{
        // Remove tag from all files that have it
        const results=await invoke('search_by_tag_v2',{tag});
        await Promise.all(results.map(async r=>{
          const cur=await invoke('get_file_tags_v2',{path:r.path}).catch(()=>[]);
          await invoke('set_file_tags_v2',{path:r.path,tags:cur.filter(t=>t!==tag)}).catch(()=>{});
        }));
        // Clear from local state
        if(state._allTags)state._allTags=state._allTags.filter(t=>t!==tag);
        if(state._fileTags){
          Object.keys(state._fileTags).forEach(p=>{
            state._fileTags[p]=(state._fileTags[p]||[]).filter(t=>t!==tag);
          });
        }
        const {render,renderSidebar}=d();
        render?.();renderSidebar?.();
      }catch(err){const {showToast}=d();showToast?.('Delete tag failed: '+err,'error');}
    });
  });
  panel.querySelectorAll('.tag-swatch').forEach(btn=>{
    btn.addEventListener('click',async()=>{
      const tag=btn.dataset.tag, color=btn.dataset.color;
      const cur=state._fileTags?.[e.path]||[];
      const newTags=cur.includes(tag)?cur.filter(t=>t!==tag):[...cur,tag];
      await invoke('set_tag_color_v2',{tag,color});
      await invoke('set_file_tags_v2',{path:e.path,tags:newTags});
      if(!state._fileTags)state._fileTags={};
      state._fileTags[e.path]=newTags;
      if(!state._tagColors)state._tagColors={};
      state._tagColors[tag]=color;
      state._allTags=[...new Set([...state._allTags,tag])];
      const {render,refreshTagColors}=d();
      render(); if(refreshTagColors)refreshTagColors();
    });
  });
}


// ── Audio Visualizer ──────────────────────────────────────────────────────────
// Global AudioContext — one per page avoids "too many AudioContexts" errors
let _sharedAC=null;
function getAC(){
  if(!_sharedAC||_sharedAC.state==='closed'){
    const AC=window.AudioContext||window.webkitAudioContext;
    if(!AC)return null;
    _sharedAC=new AC({latencyHint:'interactive'});
  }
  return _sharedAC;
}

let _vizAnimId=null;
// Persisted visualizer mode — shared across all instances
let _vizMode = (() => { try { return localStorage.getItem('ff_viz_mode')||'bars'; } catch { return 'bars'; } })();
export function setVizMode(m){ _vizMode=m; try{localStorage.setItem('ff_viz_mode',m);}catch{} }
export function getVizMode(){ return _vizMode; }

export function startAudioVisualizer(audioEl,canvas){
  if(!audioEl||!canvas)return;

  if(_vizAnimId){cancelAnimationFrame(_vizAnimId);_vizAnimId=null;}

  // ── Draw loop ─────────────────────────────────────────────────────────────
  const draw=()=>{
    if(!canvas.isConnected||!audioEl.isConnected){_vizAnimId=null;return;}
    _vizAnimId=requestAnimationFrame(draw);
    const W=canvas.offsetWidth||240,H=canvas.offsetHeight||56;
    if(canvas.width!==W||canvas.height!==H){canvas.width=W;canvas.height=H;}
    const g=canvas.getContext('2d');
    g.clearRect(0,0,W,H);
    const mode = _vizMode;

    if(audioEl.paused||!audioEl._vizAnalyser){
      // Idle state — draw subtle flat bars for all modes
      g.fillStyle='rgba(100,130,160,0.2)';
      if(mode==='ring'){
        const cx=W/2,cy=H/2,r=Math.min(W,H)*0.3;
        g.beginPath();g.arc(cx,cy,r,0,Math.PI*2);g.strokeStyle='rgba(100,130,160,0.2)';g.lineWidth=2;g.stroke();
      } else {
        const bars=60,barW=W/bars;
        for(let i=0;i<bars;i++){
          g.beginPath();g.roundRect(i*barW+0.5,H-2,barW-1.5,2,1);g.fill();
        }
      }
      return;
    }
    const analyser=audioEl._vizAnalyser;
    const bufLen=analyser.frequencyBinCount;
    const freqArr=new Uint8Array(bufLen);
    const timeArr=new Uint8Array(bufLen);
    analyser.getByteFrequencyData(freqArr);
    analyser.getByteTimeDomainData(timeArr);

    if(mode==='bars'){
      // Classic upward frequency bars with gradient colour
      const bars=Math.min(bufLen,72),barW=W/bars;
      for(let i=0;i<bars;i++){
        const v=freqArr[i]/255,h=Math.max(2,v*H);
        g.fillStyle=`hsla(${195+v*120},${60+v*30}%,60%,0.9)`;
        g.beginPath();g.roundRect(i*barW+0.5,H-h,barW-1.5,h,2);g.fill();
      }
    } else if(mode==='wave'){
      // Smooth waveform line
      g.beginPath();
      const sliceW=W/bufLen;
      let x=0;
      for(let i=0;i<bufLen;i++){
        const v=(timeArr[i]/128)-1;
        const y=H/2+v*(H*0.45);
        i===0?g.moveTo(x,y):g.lineTo(x,y);
        x+=sliceW;
      }
      const grad=g.createLinearGradient(0,0,W,0);
      grad.addColorStop(0,'hsla(195,70%,65%,0.9)');
      grad.addColorStop(0.5,'hsla(270,70%,75%,0.9)');
      grad.addColorStop(1,'hsla(315,70%,65%,0.9)');
      g.strokeStyle=grad;g.lineWidth=2;g.lineJoin='round';g.stroke();
      // Glow
      g.strokeStyle=grad;g.lineWidth=5;g.globalAlpha=0.15;g.stroke();
      g.globalAlpha=1;
    } else if(mode==='mirror'){
      // Mirrored bars — grow from centre vertically
      const bars=Math.min(bufLen,72),barW=W/bars;
      for(let i=0;i<bars;i++){
        const v=freqArr[i]/255,half=Math.max(1,v*H*0.5);
        const hue=195+v*120;
        g.fillStyle=`hsla(${hue},${60+v*30}%,60%,0.85)`;
        g.beginPath();g.roundRect(i*barW+0.5,H/2-half,barW-1.5,half*2,2);g.fill();
      }
      // Centre line
      g.fillStyle='rgba(150,170,200,0.25)';
      g.fillRect(0,H/2-0.5,W,1);
    } else if(mode==='ring'){
      // Circular frequency ring
      const cx=W/2,cy=H/2;
      const baseR=Math.min(W,H)*0.28;
      const bars=64;
      const step=bufLen/bars;
      for(let i=0;i<bars;i++){
        const v=freqArr[Math.floor(i*step)]/255;
        const angle=(i/bars)*Math.PI*2-Math.PI/2;
        const r1=baseR;
        const r2=baseR+v*(Math.min(W,H)*0.22);
        const hue=195+v*120+i*2;
        g.strokeStyle=`hsla(${hue},${60+v*30}%,65%,${0.5+v*0.5})`;
        g.lineWidth=Math.max(1,(W/bars)*0.7);
        g.lineCap='round';
        g.beginPath();
        g.moveTo(cx+Math.cos(angle)*r1,cy+Math.sin(angle)*r1);
        g.lineTo(cx+Math.cos(angle)*r2,cy+Math.sin(angle)*r2);
        g.stroke();
      }
      // Inner circle
      g.beginPath();g.arc(cx,cy,baseR*0.55,0,Math.PI*2);
      g.strokeStyle='rgba(150,170,210,0.15)';g.lineWidth=1;g.stroke();
    }
  };

  // ── Wire WebAudio graph immediately (element must be idle, no src yet) ────
  if(!audioEl._vizSetup){
    try{
      const ctx=getAC();
      if(ctx){
        const src=ctx.createMediaElementSource(audioEl);
        const analyser=ctx.createAnalyser();
        analyser.fftSize=512;
        analyser.smoothingTimeConstant=0.8;
        src.connect(analyser);
        analyser.connect(ctx.destination);
        audioEl._vizCtx=ctx;
        audioEl._vizAnalyser=analyser;
        audioEl._vizSetup=true;
      }
    }catch(err){console.warn('Audio viz setup failed:',err);}
  }

  // ── Document-level gesture unlock (belt-and-suspenders for WebKit2GTK) ──────
  if(!window._vizACUnlockWired){
    window._vizACUnlockWired=true;
    const _unlock=()=>{
      if(_sharedAC&&_sharedAC.state==='suspended')_sharedAC.resume().catch(()=>{});
    };
    document.addEventListener('click',_unlock,{capture:true,passive:true});
    document.addEventListener('keydown',_unlock,{capture:true,passive:true});
    document.addEventListener('pointerdown',_unlock,{capture:true,passive:true});
  }

  // ── Event listeners (once per element) ────────────────────────────────────
  if(!audioEl._vizListeners){
    audioEl._vizListeners=true;
    audioEl.addEventListener('play',()=>{
      const c=audioEl._vizCtx;
      if(c&&c.state==='suspended')c.resume().catch(()=>{});
      if(!_vizAnimId)draw();
    });
    audioEl.addEventListener('pause',()=>{/* keep loop — shows idle bars */});
    audioEl.addEventListener('ended',()=>{if(_vizAnimId){cancelAnimationFrame(_vizAnimId);_vizAnimId=null;}});
  }

  draw();
}

// ── Quick Look — floating peer window ────────────────────────────────────────
// openQuickLook(entry, allEntries, startIdx, iconCols)

function _qlBody(entry, getMediaUrl, getHeicJpegUrl){
  const ext=entry.extension||'';
  const isHeic = ext==='heic'||ext==='heif';
  const url = isHeic ? getHeicJpegUrl(entry.path) : getMediaUrl(entry.path);
  const isImg=IMAGE_EXTS.includes(ext),isVid=VIDEO_EXTS.includes(ext);
  const isAud=AUDIO_EXTS.includes(ext),isPdf=PDF_EXTS.includes(ext),isDoc=DOC_EXTS.includes(ext)||OFFICE_EXTS.includes(ext)||BOOK_EXTS.includes(ext);
  if(isImg) return {html:`<img class="ql-img" src="${url}" alt="${escHtml(entry.name)}"/>`, isAud:false, isDoc:false, isVid:false};
  if(isVid) return {
    // Placeholder only — actual video element is mounted by renderContent
    // using _mountMpvPlayer (libmpv — hardware accelerated, all codecs).
    html:`<div class="ql-video-wrap" id="ql-video-slot" style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#111113;position:relative;"></div>`,
    isAud:false, isDoc:false, isVid:true, vidPath:entry.path
  };
  if(isAud) return {html:`<div class="ql-audio-wrap"><span style="font-size:64px;color:${fileColor(entry)}">${fileIcon(entry).replace('<svg','<svg style="width:72px;height:72px"')}</span><div style="margin:12px 0;font-size:15px;color:#e2e8f0">${escHtml(entry.name)}</div><audio class="ql-audio" id="ql-audio-el" crossorigin="anonymous" controls autoplay src="${url}"></audio><canvas id="ql-viz-canvas" class="viz-canvas" style="margin-top:12px;width:100%"></canvas></div>`, isAud:true, isDoc:false, isVid:false};
  if(isPdf) return {html:`<iframe class="ql-pdf" src="${url}" title="PDF"></iframe>`, isAud:false, isDoc:false, isVid:false};
  if(isDoc) return {html:`<div class="ql-doc-loading"><div class="spinner"></div></div>`, isAud:false, isDoc:true, isVid:false};
  return {html:`<div class="ql-unknown"><span style="font-size:64px;color:${fileColor(entry)}">${fileIcon(entry).replace('<svg','<svg style="width:64px;height:64px"')}</span><div style="margin-top:16px;font-size:14px;color:#94a3b8">${escHtml(entry.name)}</div><div style="font-size:12px;color:#636368">${fmtSize(entry.size)}</div></div>`, isAud:false, isDoc:false, isVid:false};
}
//   allEntries — ALL entries (dirs + files); startIdx is index in that array.
//   iconCols   — live grid column count for 2-D arrow navigation in icon view.
//
// Design principles:
//   • QL is a floating div that looks and behaves like an independent OS window.
//   • It NEVER steals focus — all arrow-key navigation stays in main.js so the
//     icon grid highlight follows every keypress.
//   • If QL is already open when called again (arrow navigation), only the body
//     content and title bar text are updated in-place; the window keeps its
//     position, size, and the user doesn't see a flash or reset.

// ── Quick Look — pre-warmed native OS window ─────────────────────────────────
//
// The first call to new WebviewWindow() spawns a new OS WebKit process, which
// takes 400–700ms cold. To make QL feel instant, we pre-create the window at
// app startup with visible:false. When Space is pressed we just show() it.
// When dismissed we hide() it — never destroy it until the app quits.
//
// _qlVisible tracks whether the window is logically "open" from the user's POV.
// _qlReady  is true once the pre-warm window has finished loading ql.html.
//
let _qlWin        = null;  // WebviewWindow instance — created once at init
let _qlVisible    = false; // true while the user sees the QL window
let _qlReady      = false; // true once ql.html has fired 'ql-ready'
let _qlPendingPayload = null; // payload set before _qlReady; sent on ready

export async function initQuickLook() {
  if (_qlWin) return; // already initialised — guard against double-call

  // ── FIX: register listeners BEFORE creating the window ───────────────────
  // listen() is async — it does a round-trip to the Tauri backend to subscribe.
  // If we called new WebviewWindow() first, ql.html could fire 'ql-ready'
  // before the await resolved, the event would land in nothing, _qlReady would
  // stay false forever, and the window would show blank content every time.
  // Awaiting both listeners first guarantees they are live before any event fires.
  await listen('ql-ready', async () => {
    window.FF?.log('QL_READY_FIRED', { hadPending: !!_qlPendingPayload });
    _qlReady = true;
    if (_qlPendingPayload) {
      await invoke('set_ql_payload', { payload: JSON.stringify(_qlPendingPayload) }).catch(() => {});
      emit('ql-update', {}).catch(() => {});
      _qlPendingPayload = null;
    }
  });

  // ql.html emits ql-closed when the user clicks × or presses Escape.
  // We hide the window rather than close it so it stays warm.
  await listen('ql-closed', () => {
    window.FF?.log('QL_CLOSED_FIRED', {});
    _qlVisible = false;
    _qlWin?.hide().catch(() => {});
  });

  // Create the window hidden so WebKit initialises in the background.
  // ql.html fires 'ql-ready' when it has called get_ql_payload() and is ready.
  // Listeners above are guaranteed registered before this window can emit anything.
  _qlWin = new WebviewWindow('quicklook', {
    url:         'ql.html',
    title:       'Quick Look',
    width:       860,
    height:      660,
    minWidth:    360,
    minHeight:   280,
    decorations: false,
    transparent: true,
    resizable:   true,
    center:      true,
    visible:     false,   // pre-warm hidden — user doesn't see this
    focus:       false,
    alwaysOnTop: false,
    skipTaskbar: true,
  });

  // If somehow the OS destroys the window (crash, force-close), reset state.
  _qlWin.once('tauri://destroyed', () => {
    _qlWin = null; _qlReady = false; _qlVisible = false;
  });
}

export async function openQuickLook(entry, allEntries, startIdx, iconCols) {
  const navEntries = (allEntries || []).filter(e => !e.is_dir);
  let curIdx = navEntries.findIndex(e => e.path === entry.path);
  if (curIdx < 0) curIdx = 0;

  const payload = { entries: navEntries, curIdx };

  window.FF?.log('QL_OPEN_ENTER', { entry: entry?.name, qlWin: !!_qlWin, qlReady: _qlReady, qlVisible: _qlVisible, navCount: navEntries.length, curIdx });

  if (!_qlWin) {
    // Fallback: pre-warm somehow failed — create synchronously.
    window.FF?.log('QL_OPEN_REINIT', {});
    await initQuickLook();
  }

  if (_qlReady) {
    // Window already loaded — update content then show.
    window.FF?.log('QL_OPEN_READY_PATH', {});
    await invoke('set_ql_payload', { payload: JSON.stringify(payload) }).catch(() => {});
    emit('ql-update', {}).catch(() => {});
  } else {
    // Window still loading — store payload; ql-ready listener will flush it.
    window.FF?.log('QL_OPEN_PENDING_PATH', {});
    _qlPendingPayload = payload;
    // Also prime Rust-side so get_ql_payload() works when ql.html calls it.
    await invoke('set_ql_payload', { payload: JSON.stringify(payload) }).catch(() => {});
  }

  if (!_qlVisible) {
    // setFocus only on first show — not on arrow-key updates, which would steal
    // keyboard focus from the main window and break navigation.
    window.FF?.log('QL_OPEN_SHOW', {});
    _qlVisible = true;
    await _qlWin.show().catch((e) => { window.FF?.log('QL_SHOW_ERR', { err: String(e) }); });
    await _qlWin.setFocus().catch(() => {});
    // Belt-and-suspenders: re-emit ql-update after show() so ql.html always
    // receives the payload regardless of whether ql-ready was caught in time.
    // By the time show() resolves, ql.html's listen('ql-update') is registered
    // (it registers it before emitting ql-ready), so this is always safe.
    emit('ql-update', {}).catch(() => {});
    window.FF?.log('QL_POST_SHOW_UPDATE_SENT', {});
  } else {
    window.FF?.log('QL_OPEN_ALREADY_VISIBLE', {});
  }
   // Do NOT call setFocus() on subsequent calls (arrow key updates).
}

// Returns true if the QL window is currently visible to the user.
export function isQLOpen() {
  return _qlVisible;
}

// Hide the QL window from outside (e.g. Space/Escape in main window).
// Do NOT emit 'ql-closed' here — that event flows ql→main only (from closeWindow in ql-window.js).
// Emitting it from main would bounce through the initQuickLook listener for a redundant second hide.
export function closeQuickLook() {
  if (!_qlVisible) return;
  _qlVisible = false;
  _qlWin?.hide().catch(() => {});
}

export function renderStatus(){
  const {state,sel,getCurrentEntries,sortEntries,isPaneBFocused,_paneB}=d();

  // Gap fix: when pane B is focused, show pane B stats instead of main pane
  if(isPaneBFocused?.() && _paneB?.active){
    const pbEntries = _paneB.entries || [];
    const pbCount = pbEntries.length;
    const pbSelEntry = _paneB.selIdx >= 0 ? pbEntries[_paneB.selIdx] : null;
    const pbFolder = (_paneB.path||'').split('/').filter(Boolean).pop() || _paneB.path || '';
    let txt = pbSelEntry
      ? `${pbCount} item${pbCount!==1?'s':''} · ${pbSelEntry.name}${pbSelEntry.is_dir?` (folder) · ${fmtDate(pbSelEntry.modified)}`:` · ${fmtSize(pbSelEntry.size)} · ${fmtDate(pbSelEntry.modified)}`}`
      : `${pbCount} item${pbCount!==1?'s':''}`;
    txt += `  ·  Pane B: ${pbFolder}`;
    document.getElementById('status').textContent=txt;
    return;
  }

  const entries=getCurrentEntries();
  let count=entries.length,selEntry=null;
  if(state.viewMode==='column'&&!state.searchMode){
    const last=state.columns[state.columns.length-1];
    if(last){
      // Sort entries to match the sorted display order — selIdx is a display index,
      // not a raw filesystem index. Without sorting, the status bar showed the
      // wrong filename whenever the directory wasn't already in sort order on disk.
      let e=last.entries;
      if(!state.showHidden)e=e.filter(x=>!x.is_hidden);
      e=sortEntries(e);
      count=e.length;
      if(last.selIdx>=0)selEntry=e[last.selIdx];
    }
  }else{selEntry=state.selIdx>=0?entries[state.selIdx]:null;}
  const multiSel=sel.size>1;
  const hints={icon:'Icon',list:'List',column:'Column',gallery:'Gallery'};
  // Total size of multi-selection (only files that have size populated)
  const selEntries = multiSel ? sel.arr.map(i=>entries[i]).filter(Boolean) : [];
  const selTotalSize = multiSel ? selEntries.reduce((a,e)=>a+(e.size||0),0) : 0;
  let txt=state.searchMode
    ? (count) + ' result' + (count!==1?'s':'') + (state.searchQuery ? ` for "${state.searchQuery}"` : '')
    :multiSel?`${sel.size} selected of ${count} · ${fmtSize(selTotalSize)}`:`${count} item${count!==1?'s':''}`;
  if(!multiSel&&selEntry)txt+=selEntry.is_dir?` · ${selEntry.name} (folder) · ${fmtDate(selEntry.modified)}`:` · ${selEntry.name} · ${fmtSize(selEntry.size)} · ${fmtDate(selEntry.modified)}`;
  if(state.clipboard.entries.length)txt+=` · ${state.clipboard.entries.length} in clipboard (${state.clipboard.op})`;
  if(!state.searchMode)txt+=`  ·  ${hints[state.viewMode]||''} View`;
  document.getElementById('status').textContent=txt;
}

// ── Batch Rename Dialog ─────────────────────────────────────────────────────────
export function showBatchRenameDialog(paths) {
  document.getElementById('ff-batch-rename-dialog')?.remove();
  const dlg = document.createElement('div');
  dlg.id = 'ff-batch-rename-dialog';
  dlg.style.cssText = 'position:fixed;inset:0;z-index:9200;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);';
  dlg.innerHTML = `
    <div style="background:#1e1e21;border:1px solid rgba(255,255,255,.13);border-radius:14px;padding:28px 28px 22px;min-width:420px;max-width:500px;box-shadow:0 16px 48px rgba(0,0,0,.75);">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;">
        <span style="color:#3b82f6;line-height:0">${I.edit.replace('<svg','<svg style="width:22px;height:22px"')}</span>
        <div>
          <div style="font-size:14px;font-weight:600;color:#f1f5f9">Batch Rename</div>
          <div style="font-size:11px;color:#636368;margin-top:2px;">${paths.length} file${paths.length!==1?'s':''} selected</div>
        </div>
      </div>
      <div style="margin-bottom:16px;">
        <label style="display:block;font-size:11px;color:#98989f;margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;">Rename Mode</label>
        <div class="ff-csel" style="width:100%">
          <button class="ff-csel-btn" type="button" style="font-size:13px;padding:9px 12px"><span class="ff-csel-label">Find &amp; Replace</span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
          <div class="ff-csel-popup">
            <div class="ff-csel-opt active" data-val="find_replace" style="font-size:13px">Find &amp; Replace</div>
            <div class="ff-csel-opt" data-val="prefix" style="font-size:13px">Add Prefix</div>
            <div class="ff-csel-opt" data-val="suffix" style="font-size:13px">Add Suffix</div>
            <div class="ff-csel-opt" data-val="number" style="font-size:13px">Numbering</div>
            <div class="ff-csel-opt" data-val="case" style="font-size:13px">Change Case</div>
          </div>
          <input type="hidden" id="ff-rename-mode" value="find_replace">
        </div>
      </div>
      <div id="ff-rename-options">
        <div id="ff-opt-find-replace" class="rename-opt">
          <input id="ff-find-text" placeholder="Find..." style="width:100%;box-sizing:border-box;padding:9px 11px;background:#2a2a2d;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#f1f5f9;font-size:13px;outline:none;font-family:inherit;margin-bottom:8px;">
          <input id="ff-replace-text" placeholder="Replace with..." style="width:100%;box-sizing:border-box;padding:9px 11px;background:#2a2a2d;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#f1f5f9;font-size:13px;outline:none;font-family:inherit;">
        </div>
        <div id="ff-opt-prefix" class="rename-opt" style="display:none;">
          <input id="ff-prefix-text" placeholder="Prefix text..." style="width:100%;box-sizing:border-box;padding:9px 11px;background:#2a2a2d;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#f1f5f9;font-size:13px;outline:none;font-family:inherit;">
        </div>
        <div id="ff-opt-suffix" class="rename-opt" style="display:none;">
          <input id="ff-suffix-text" placeholder="Suffix text..." style="width:100%;box-sizing:border-box;padding:9px 11px;background:#2a2a2d;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#f1f5f9;font-size:13px;outline:none;font-family:inherit;">
        </div>
        <div id="ff-opt-number" class="rename-opt" style="display:none;">
          <div style="display:flex;gap:8px;">
            <div style="flex:1;">
              <label style="display:block;font-size:10px;color:#98989f;margin-bottom:4px;">Start #</label>
              <div class="ff-stepper" style="width:100%"><button class="ff-step-btn ff-step-dec" type="button">−</button><div class="ff-step-sep"></div><input id="ff-start-num" type="number" value="1" min="0" style="flex:1;text-align:center"><div class="ff-step-sep"></div><button class="ff-step-btn ff-step-inc" type="button">+</button></div>
            </div>
            <div style="flex:1;">
              <label style="display:block;font-size:10px;color:#98989f;margin-bottom:4px;">Padding</label>
              <div class="ff-stepper" style="width:100%"><button class="ff-step-btn ff-step-dec" type="button">−</button><div class="ff-step-sep"></div><input id="ff-num-padding" type="number" value="1" min="1" max="10" style="flex:1;text-align:center"><div class="ff-step-sep"></div><button class="ff-step-btn ff-step-inc" type="button">+</button></div>
            </div>
          </div>
          <div style="display:flex;gap:8px;margin-top:8px;">
            <input id="ff-num-prefix" placeholder="Prefix (optional)" style="flex:1;box-sizing:border-box;padding:9px 11px;background:#2a2a2d;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#f1f5f9;font-size:13px;outline:none;font-family:inherit;">
            <input id="ff-num-suffix" placeholder="Suffix (optional)" style="flex:1;box-sizing:border-box;padding:9px 11px;background:#2a2a2d;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#f1f5f9;font-size:13px;outline:none;font-family:inherit;">
          </div>
        </div>
        <div id="ff-opt-case" class="rename-opt" style="display:none;">
          <div class="ff-csel" style="width:100%">
            <button class="ff-csel-btn" type="button" style="font-size:13px;padding:9px 12px"><span class="ff-csel-label">lowercase</span><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button>
            <div class="ff-csel-popup">
              <div class="ff-csel-opt active" data-val="lower" style="font-size:13px">lowercase</div>
              <div class="ff-csel-opt" data-val="upper" style="font-size:13px">UPPERCASE</div>
              <div class="ff-csel-opt" data-val="title" style="font-size:13px">Title Case</div>
            </div>
            <input type="hidden" id="ff-case-mode" value="lower">
          </div>
        </div>
      </div>
      <div id="ff-rename-preview-wrap" style="margin-top:12px;display:none;border:1px solid rgba(255,255,255,.08);border-radius:8px;overflow:hidden;">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 12px;background:rgba(255,255,255,.03);border-bottom:1px solid rgba(255,255,255,.06);">
          <span style="font-size:10px;color:#636368;text-transform:uppercase;letter-spacing:.06em;">Preview</span>
          <span id="ff-rename-preview-count" style="font-size:10px;color:#636368;"></span>
        </div>
        <div id="ff-rename-preview" style="max-height:220px;overflow-y:auto;background:#111113;"></div>
      </div>
      <div id="ff-rename-err" style="color:#f87171;font-size:11px;margin-top:8px;min-height:16px;"></div>
      <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end;">
        <button id="ff-rename-cancel-btn" style="padding:7px 16px;background:rgba(255,255,255,.07);border:none;border-radius:7px;color:#98989f;font-size:13px;cursor:pointer;">Cancel</button>
        <button id="ff-rename-preview-btn" style="padding:7px 16px;background:rgba(59,130,246,.2);border:1px solid #3b82f6;border-radius:7px;color:#3b82f6;font-size:13px;cursor:pointer;">Preview</button>
        <button id="ff-rename-ok-btn" style="padding:7px 18px;background:#3b82f6;border:none;border-radius:7px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;">Rename</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);

  const cancel = () => dlg.remove();
  dlg.querySelector('#ff-rename-cancel-btn').addEventListener('click', cancel);
  dlg.addEventListener('click', ev => { if (ev.target === dlg) cancel(); });

  const modeSelect = dlg.querySelector('#ff-rename-mode'); // now type=hidden
  // Wire ff-csel custom dropdowns in rename dialog
  const _closeDlgCsel = () => dlg.querySelectorAll('.ff-csel.open').forEach(el => el.classList.remove('open'));
  dlg.querySelectorAll('.ff-csel').forEach(csel => {
    csel.querySelector('.ff-csel-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      const wasOpen = csel.classList.contains('open');
      _closeDlgCsel();
      if (!wasOpen) csel.classList.add('open');
    });
    csel.querySelectorAll('.ff-csel-opt').forEach(opt => {
      opt.addEventListener('click', e => {
        e.stopPropagation();
        csel.querySelector('.ff-csel-label').textContent = opt.textContent;
        csel.querySelectorAll('.ff-csel-opt').forEach(o => o.classList.toggle('active', o === opt));
        const hidden = csel.querySelector('input[type=hidden]');
        if (hidden) {
          hidden.value = opt.dataset.val;
          hidden.dispatchEvent(new Event('change', {bubbles:true}));
        }
        _closeDlgCsel();
      });
    });
  });
  document.addEventListener('click', _closeDlgCsel, {once:true, capture:true});
  // Wire ff-stepper +/- buttons in rename dialog
  dlg.querySelectorAll('.ff-stepper').forEach(stepper => {
    const inp = stepper.querySelector('input[type=number]');
    if (!inp) return;
    const clamp = v => Math.min(+(inp.max||Infinity), Math.max(+(inp.min||-Infinity), v));
    stepper.querySelector('.ff-step-dec')?.addEventListener('click', () => { inp.value = clamp(+(inp.value||0)-1); _schedulePreview(); });
    stepper.querySelector('.ff-step-inc')?.addEventListener('click', () => { inp.value = clamp(+(inp.value||0)+1); _schedulePreview(); });
  });
  const _livePreview = async () => {
    const opts = getOptions();
    if (!opts) return;
    // Don't preview if no input has been provided
    const hasInput = (opts.mode==='find_replace'&&(opts.find||opts.replace)) ||
      (opts.mode==='prefix'&&opts.prefix) || (opts.mode==='suffix'&&opts.suffix) ||
      opts.mode==='number' || opts.mode==='case';
    if (!hasInput) return;
    try {
      const results = await invoke('batch_rename', { paths, options: { ...opts, dry_run: true } });
      const previewWrap = dlg.querySelector('#ff-rename-preview-wrap');
      const preview = dlg.querySelector('#ff-rename-preview');
      const previewCount = dlg.querySelector('#ff-rename-preview-count');
      previewWrap.style.display = 'block';
      const errors = results.filter(r => r.startsWith('ERROR'));
      const successes = results.filter(r => !r.startsWith('ERROR'));
      if(previewCount) previewCount.textContent = `${successes.length} file${successes.length!==1?'s':''} will be renamed${errors.length?' · '+errors.length+' error(s)':''}`;
      preview.innerHTML = `<table style="width:100%;border-collapse:collapse;font-size:11.5px;">
        <thead><tr style="position:sticky;top:0;background:#1a1a1d;border-bottom:1px solid rgba(255,255,255,.08);">
          <th style="padding:6px 12px;text-align:left;font-weight:500;color:#636368;width:50%;">Before</th>
          <th style="padding:6px 4px;color:#636368;width:16px;">→</th>
          <th style="padding:6px 12px;text-align:left;font-weight:500;color:#636368;width:50%;">After</th>
        </tr></thead>
        <tbody>${results.map((r,i) => {
          if(r.startsWith('ERROR')) return `<tr style="background:rgba(248,113,113,.06);">
            <td style="padding:4px 12px;color:#636368;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:0;">\${escHtml(paths[i]?.split('/').pop()||'')}</td>
            <td></td>
            <td style="padding:4px 12px;color:#f87171;font-size:10.5px;">\${escHtml(r.replace('ERROR: ',''))}</td>
          </tr>`;
          const newName = r.split('/').pop();
          const origName = paths[i]?.split('/').pop() || '';
          const changed = newName !== origName;
          return `<tr style="border-bottom:1px solid rgba(255,255,255,.04);\${changed?'':'opacity:.4'}">
            <td style="padding:4px 12px;color:\${changed?'#94a3b8':'#636368'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:0;" title="\${escHtml(origName)}">\${escHtml(origName)}</td>
            <td style="padding:4px;color:#636368;font-size:10px;">\${changed?'→':'='}</td>
            <td style="padding:4px 12px;color:\${changed?'#34d399':'#636368'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:0;font-weight:\${changed?500:400};" title="\${escHtml(newName)}">\${escHtml(newName)}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
    } catch (e) {
      dlg.querySelector('#ff-rename-err').textContent = e.toString();
    }
  };
  // Debounced live preview on every keystroke
  let _previewTimer = null;
  const _schedulePreview = () => { clearTimeout(_previewTimer); _previewTimer = setTimeout(_livePreview, 300); };
  dlg.addEventListener('input', _schedulePreview);

  modeSelect.addEventListener('change', () => {
    dlg.querySelectorAll('.rename-opt').forEach(el => el.style.display = 'none');
    dlg.querySelector(`#ff-opt-${modeSelect.value}`)?.style.setProperty('display','block');
    _schedulePreview();
  });

  dlg.querySelector('#ff-rename-preview-btn').addEventListener('click', async () => {
    const opts = getOptions();
    if (!opts) return;
    try {
      const results = await invoke('batch_rename', { paths, options: { ...opts, dry_run: true } });
      const preview = dlg.querySelector('#ff-rename-preview');
      preview.style.display = 'block';
      preview.innerHTML = results.slice(0, 10).map(r => {
        if (r.startsWith('ERROR')) return `<div style="color:#f87171;">${escHtml(r)}</div>`;
        return `<div style="color:#34d399;">${escHtml(r.split('/').pop())}</div>`;
      }).join('') + (results.length > 10 ? `<div style="color:#636368;">...and ${results.length - 10} more</div>` : '');
    } catch (e) {
      dlg.querySelector('#ff-rename-err').textContent = e.toString();
    }
  });

  function getOptions() {
    const mode = modeSelect.value;
    const opts = { mode };
    if (mode === 'find_replace') {
      opts.find = dlg.querySelector('#ff-find-text').value;
      opts.replace = dlg.querySelector('#ff-replace-text').value;
    } else if (mode === 'prefix') {
      opts.prefix = dlg.querySelector('#ff-prefix-text').value;
    } else if (mode === 'suffix') {
      opts.suffix = dlg.querySelector('#ff-suffix-text').value;
    } else if (mode === 'number') {
      opts.start_num = parseInt(dlg.querySelector('#ff-start-num').value) || 1;
      opts.padding = parseInt(dlg.querySelector('#ff-num-padding').value) || 1;
      opts.prefix = dlg.querySelector('#ff-num-prefix').value;
      opts.suffix = dlg.querySelector('#ff-num-suffix').value;
    } else if (mode === 'case') {
      opts.case_mode = dlg.querySelector('#ff-case-mode').value;
    }
    return opts;
  }

  dlg.querySelector('#ff-rename-ok-btn').addEventListener('click', async () => {
    const opts = getOptions();
    if (!opts) return;
    try {
      const newPaths = await invoke('batch_rename', { paths, options: opts });
      // Build undo items: each {oldPath:paths[i], newPath:newPaths[i], oldName, newName}
      const { pushUndo } = d();
      const undoItems = paths
        .map((oldPath, i) => ({
          oldPath,
          newPath: newPaths[i],
          oldName: oldPath.split('/').pop(),
          newName: (newPaths[i] || oldPath).split('/').pop(),
        }))
        .filter(item => item.oldPath !== item.newPath && !item.newPath?.startsWith('ERROR'));
      if (undoItems.length) pushUndo({op:'batchRename', items: undoItems});
      const { render } = d();
      render();
      cancel();
    } catch (e) {
      dlg.querySelector('#ff-rename-err').textContent = e.toString();
    }
  });
}

// ── SMB Connect Dialog ─────────────────────────────────────────────────────────
export function showSmbConnectDialog() {
  document.getElementById('ff-smb-dialog')?.remove();
  const dlg = document.createElement('div');
  dlg.id = 'ff-smb-dialog';
  dlg.style.cssText = 'position:fixed;inset:0;z-index:9200;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);';
  dlg.innerHTML = `
    <div style="background:#1e1e21;border:1px solid rgba(255,255,255,.13);border-radius:14px;padding:28px 28px 22px;min-width:380px;max-width:440px;box-shadow:0 16px 48px rgba(0,0,0,.75);">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;">
        <span style="color:#f59e0b;line-height:0">${I.server.replace('<svg','<svg style="width:22px;height:22px"')}</span>
        <div>
          <div style="font-size:14px;font-weight:600;color:#f1f5f9">Connect to SMB/Network Share</div>
          <div style="font-size:11px;color:#636368;margin-top:2px;">Mount a Windows/Samba network share</div>
        </div>
      </div>
      <div style="margin-bottom:12px;">
        <label style="display:block;font-size:11px;color:#98989f;margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;">Server Address</label>
        <input id="ff-smb-server" placeholder="e.g. 192.168.1.100 or smb://server" style="width:100%;box-sizing:border-box;padding:9px 11px;background:#2a2a2d;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#f1f5f9;font-size:13px;outline:none;font-family:inherit;">
      </div>
      <div style="margin-bottom:12px;">
        <label style="display:block;font-size:11px;color:#98989f;margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;">Share Name</label>
        <input id="ff-smb-share" placeholder="e.g. sharedfolder" style="width:100%;box-sizing:border-box;padding:9px 11px;background:#2a2a2d;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#f1f5f9;font-size:13px;outline:none;font-family:inherit;">
      </div>
      <div style="display:flex;gap:12px;margin-bottom:12px;">
        <div style="flex:1;">
          <label style="display:block;font-size:11px;color:#98989f;margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;">Username</label>
          <input id="ff-smb-user" placeholder="(optional)" style="width:100%;box-sizing:border-box;padding:9px 11px;background:#2a2a2d;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#f1f5f9;font-size:13px;outline:none;font-family:inherit;">
        </div>
        <div style="flex:1;">
          <label style="display:block;font-size:11px;color:#98989f;margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;">Password</label>
          <input id="ff-smb-pass" type="password" placeholder="(optional)" style="width:100%;box-sizing:border-box;padding:9px 11px;background:#2a2a2d;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#f1f5f9;font-size:13px;outline:none;font-family:inherit;">
        </div>
      </div>
      <div id="ff-smb-err" style="color:#f87171;font-size:11px;margin-top:8px;min-height:16px;"></div>
      <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end;">
        <button id="ff-smb-cancel-btn" style="padding:7px 16px;background:rgba(255,255,255,.07);border:none;border-radius:7px;color:#98989f;font-size:13px;cursor:pointer;">Cancel</button>
        <button id="ff-smb-connect-btn" style="padding:7px 18px;background:#f59e0b;border:none;border-radius:7px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:7px;">${I.server.replace('<svg','<svg style="width:14px;height:14px"')} Connect</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);

  const cancel = () => dlg.remove();
  dlg.querySelector('#ff-smb-cancel-btn').addEventListener('click', cancel);
  dlg.addEventListener('click', ev => { if (ev.target === dlg) cancel(); });

  dlg.querySelector('#ff-smb-connect-btn').addEventListener('click', async () => {
    const server = dlg.querySelector('#ff-smb-server').value.trim();
    const share = dlg.querySelector('#ff-smb-share').value.trim();
    const username = dlg.querySelector('#ff-smb-user').value.trim() || null;
    const password = dlg.querySelector('#ff-smb-pass').value || null;

    if (!server || !share) {
      dlg.querySelector('#ff-smb-err').textContent = 'Server and share are required';
      return;
    }

    dlg.querySelector('#ff-smb-connect-btn').disabled = true;
    try {
      const mountPoint = await invoke('mount_smb', { server, share, username, password });
      const { navigate, showToast } = d();
      await navigate(mountPoint);
      showToast(t('toast.smb_connected',{server,share}),'success');
      cancel();
    } catch (e) {
      dlg.querySelector('#ff-smb-err').textContent = e.toString();
      dlg.querySelector('#ff-smb-connect-btn').disabled = false;
    }
  });
}

// ── Cloud Mount Dialog ─────────────────────────────────────────────────────────
export function showCloudMountDialog() {
  document.getElementById('ff-cloud-dialog')?.remove();
  const dlg = document.createElement('div');
  dlg.id = 'ff-cloud-dialog';
  dlg.style.cssText = 'position:fixed;inset:0;z-index:9200;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);';
  dlg.innerHTML = `
    <div style="background:#1e1e21;border:1px solid rgba(255,255,255,.13);border-radius:14px;padding:28px 28px 22px;min-width:420px;max-width:480px;box-shadow:0 16px 48px rgba(0,0,0,.75);">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;">
        <span style="color:#8b5cf6;line-height:0">${I.cloud.replace('<svg','<svg style="width:22px;height:22px"')}</span>
        <div>
          <div style="font-size:14px;font-weight:600;color:#f1f5f9">Mount Cloud Storage</div>
          <div style="font-size:11px;color:#636368;margin-top:2px;">Connect to WebDAV (Nextcloud, Synology, etc.)</div>
        </div>
      </div>
      <div style="margin-bottom:12px;">
        <label style="display:block;font-size:11px;color:#98989f;margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;">Connection Name</label>
        <input id="ff-cloud-name" placeholder="e.g. My Nextcloud" style="width:100%;box-sizing:border-box;padding:9px 11px;background:#2a2a2d;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#f1f5f9;font-size:13px;outline:none;font-family:inherit;">
      </div>
      <div style="margin-bottom:12px;">
        <label style="display:block;font-size:11px;color:#98989f;margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;">WebDAV URL</label>
        <input id="ff-cloud-url" placeholder="https://nextcloud.example.com/remote.php/dav/files/user/" style="width:100%;box-sizing:border-box;padding:9px 11px;background:#2a2a2d;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#f1f5f9;font-size:13px;outline:none;font-family:inherit;">
      </div>
      <div style="display:flex;gap:12px;margin-bottom:12px;">
        <div style="flex:1;">
          <label style="display:block;font-size:11px;color:#98989f;margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;">Username</label>
          <input id="ff-cloud-user" placeholder="(optional)" style="width:100%;box-sizing:border-box;padding:9px 11px;background:#2a2a2d;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#f1f5f9;font-size:13px;outline:none;font-family:inherit;">
        </div>
        <div style="flex:1;">
          <label style="display:block;font-size:11px;color:#98989f;margin-bottom:6px;text-transform:uppercase;letter-spacing:.06em;">Password</label>
          <input id="ff-cloud-pass" type="password" placeholder="(optional)" style="width:100%;box-sizing:border-box;padding:9px 11px;background:#2a2a2d;border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#f1f5f9;font-size:13px;outline:none;font-family:inherit;">
        </div>
      </div>
      <div style="padding:10px 12px;background:rgba(139,92,246,.07);border:1px solid rgba(139,92,246,.2);border-radius:8px;font-size:11px;color:#98989f;line-height:1.6;">
        ℹ Requires <strong style="color:#c4b5fd">davfs2</strong> installed (<code>sudo apt install davfs2</code> on Ubuntu)
      </div>
      <div id="ff-cloud-err" style="color:#f87171;font-size:11px;margin-top:8px;min-height:16px;"></div>
      <div style="display:flex;gap:8px;margin-top:16px;justify-content:flex-end;">
        <button id="ff-cloud-cancel-btn" style="padding:7px 16px;background:rgba(255,255,255,.07);border:none;border-radius:7px;color:#98989f;font-size:13px;cursor:pointer;">Cancel</button>
        <button id="ff-cloud-mount-btn" style="padding:7px 18px;background:#8b5cf6;border:none;border-radius:7px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:7px;">${I.cloud.replace('<svg','<svg style="width:14px;height:14px"')} Mount</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);

  const cancel = () => dlg.remove();
  dlg.querySelector('#ff-cloud-cancel-btn').addEventListener('click', cancel);
  dlg.addEventListener('click', ev => { if (ev.target === dlg) cancel(); });

  dlg.querySelector('#ff-cloud-mount-btn').addEventListener('click', async () => {
    const name = dlg.querySelector('#ff-cloud-name').value.trim() || 'Cloud';
    const url = dlg.querySelector('#ff-cloud-url').value.trim();
    const username = dlg.querySelector('#ff-cloud-user').value.trim() || null;
    const password = dlg.querySelector('#ff-cloud-pass').value || null;

    if (!url) {
      dlg.querySelector('#ff-cloud-err').textContent = 'WebDAV URL is required';
      return;
    }

    dlg.querySelector('#ff-cloud-mount-btn').disabled = true;
    try {
      const mountPoint = await invoke('mount_webdav', { name, url, username, password });
      const { navigate, showToast } = d();
      await navigate(mountPoint);
      showToast(t('toast.webdav_mounted',{name}),'success');
      cancel();
    } catch (e) {
      dlg.querySelector('#ff-cloud-err').textContent = e.toString();
      dlg.querySelector('#ff-cloud-mount-btn').disabled = false;
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// r42 VIEWS ADDITIONS
// ═══════════════════════════════════════════════════════════════════════════

// ── Video codec badge ─────────────────────────────────────────────────────────
export async function injectVideoCodecBadge(container, path) {
  const ext = (path.split('.').pop()||'').toLowerCase();
  const VIDEO_EXTS_SET = new Set(['mp4','mkv','avi','mov','webm','flv','wmv','m4v','ts','vob','ogv','3gp']);
  if (!VIDEO_EXTS_SET.has(ext)) return;
  container.querySelector('.video-codec-row')?.remove();
  const placeholder = document.createElement('div');
  placeholder.className = 'video-codec-row video-codec-loading';
  placeholder.innerHTML = '<span class="spinner-xs"></span> Reading codec…';
  container.appendChild(placeholder);
  try {
    const info = await invoke('probe_video_codec', {path});
    placeholder.remove();
    if (!info) return;
    const badges = [];
    if (info.codec_name) badges.push(`<span class="codec-badge codec-name">${info.codec_name.toUpperCase()}</span>`);
    if (info.width && info.height) {
      const p = Math.min(info.width, info.height);
      const lbl = p>=2160?'4K':p>=1440?'2K':p>=1080?'1080p':p>=720?'720p':p>=480?'480p':`${p}p`;
      badges.push(`<span class="codec-badge codec-res">${lbl} <span class="codec-dim">${info.width}×${info.height}</span></span>`);
    }
    if (info.fps) badges.push(`<span class="codec-badge codec-fps">${parseFloat(info.fps).toFixed(2)} fps</span>`);
    if (info.duration_secs) {
      const s=Math.floor(info.duration_secs); const h=Math.floor(s/3600); const m=Math.floor((s%3600)/60); const sec=s%60;
      const dur = h>0?`${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`:`${m}:${String(sec).padStart(2,'0')}`;
      badges.push(`<span class="codec-badge codec-dur">${dur}</span>`);
    }
    if (info.bit_rate_kbps) badges.push(`<span class="codec-badge codec-br">${info.bit_rate_kbps} kbps</span>`);
    if (info.audio_codec) badges.push(`<span class="codec-badge codec-audio">${info.audio_codec.toUpperCase()}</span>`);
    if (!badges.length) return;
    const row = document.createElement('div'); row.className = 'video-codec-row'; row.innerHTML = badges.join('');
    container.appendChild(row);
  } catch (_) { placeholder.remove(); }
}

// ── Accessibility helpers ─────────────────────────────────────────────────────
export function trapFocus(dialogEl) {
  const focusable = () => [...dialogEl.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])')];
  function handler(e) {
    if (e.key !== 'Tab') return;
    const els = focusable(); if (!els.length) return;
    const first = els[0]; const last = els[els.length-1];
    if (e.shiftKey) { if (document.activeElement===first) { e.preventDefault(); last.focus(); } }
    else { if (document.activeElement===last) { e.preventDefault(); first.focus(); } }
  }
  dialogEl.addEventListener('keydown', handler);
}



// ═══════════════════════════════════════════════════════════════════════════════
// Phase 5 — Metadata editors (r125–r138)
// Each opens a modal sheet, loads current tags via exiftool, and saves on Apply.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Shared helper: metadata editor overlay shell ──────────────────────────────
function _metaEditorOverlay(title, bodyHtml, onApply) {
  document.getElementById('ff-meta-editor')?.remove();
  const ov = document.createElement('div');
  ov.id = 'ff-meta-editor';
  ov.style.cssText = 'position:fixed;inset:0;z-index:9600;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.65);backdrop-filter:blur(7px);';
  ov.innerHTML = `
    <div class="meta-editor-box">
      <div class="meta-editor-header">
        <span class="meta-editor-title">${escHtml(title)}</span>
        <button class="meta-editor-close" id="meta-ed-close">✕</button>
      </div>
      <div class="meta-editor-body" id="meta-ed-body">${bodyHtml}</div>
      <div class="meta-editor-footer">
        <div class="meta-ed-status" id="meta-ed-status"></div>
        <button class="stg-btn" id="meta-ed-cancel">Cancel</button>
        <button class="stg-btn meta-ed-apply-btn" id="meta-ed-apply">Apply</button>
      </div>
    </div>`;
  document.body.appendChild(ov);
  const close = () => ov.remove();
  ov.querySelector('#meta-ed-close').addEventListener('click', close);
  ov.querySelector('#meta-ed-cancel').addEventListener('click', close);
  ov.addEventListener('click', ev => { if (ev.target === ov) close(); });
  ov.querySelector('#meta-ed-apply').addEventListener('click', () => onApply(ov, close));
  return ov;
}

// ── r125: EXIF editor (images) ────────────────────────────────────────────────
async function _showExifEditor(entry, panel) {
  const statusEl = document.createElement('div');
  statusEl.style.cssText = 'padding:24px;text-align:center;color:var(--text-tertiary)';
  statusEl.textContent = 'Loading EXIF…';
  const ov = _metaEditorOverlay('Edit EXIF — ' + entry.name, statusEl.outerHTML, async (ov, close) => {
    const fields = [];
    const statusDiv = ov.querySelector('#meta-ed-status');
    // Collect editable fields
    [
      ['DateTimeOriginal', '#exif-date'],
      ['Make',             '#exif-make'],
      ['Model',            '#exif-model'],
    ].forEach(([tag, sel]) => {
      const el = ov.querySelector(sel);
      if (el && el.value.trim()) fields.push([tag, el.value.trim()]);
    });
    // GPS clear
    if (ov.querySelector('#exif-clear-gps')?.checked) {
      fields.push(['GPSLatitude', ''], ['GPSLongitude', ''], ['GPSAltitude', '']);
    }
    if (!fields.length) { close(); return; }
    if (statusDiv) statusDiv.textContent = 'Saving…';
    ov.querySelector('#meta-ed-apply').disabled = true;
    try {
      await invoke('write_exif_tags', {path: entry.path, fields});
      if (statusDiv) { statusDiv.style.color = '#34d399'; statusDiv.textContent = 'Saved!'; }
      setTimeout(close, 900);
    } catch(err) {
      if (statusDiv) { statusDiv.style.color = '#f87171'; statusDiv.textContent = String(err); }
      ov.querySelector('#meta-ed-apply').disabled = false;
    }
  });

  // Load current EXIF
  try {
    const meta = await invoke('get_exif_tags', {path: entry.path});
    const body = ov.querySelector('#meta-ed-body');
    if (!body || !ov.isConnected) return;
    const row = (id, label, val, placeholder='') =>
      `<div class="meta-ed-row">
        <label class="meta-ed-label" for="${id}">${label}</label>
        <input class="meta-ed-input" id="${id}" value="${escHtml(val||'')}" placeholder="${placeholder}">
      </div>`;
    body.innerHTML =
      row('exif-date',   'Date taken',  meta.DateTimeOriginal||meta.CreateDate||'', 'YYYY:MM:DD HH:MM:SS') +
      row('exif-make',   'Camera make', meta.Make||'') +
      row('exif-model',  'Model',       meta.Model||'') +
      `<div class="meta-ed-row meta-ed-check-row">
        <label class="meta-ed-label">GPS</label>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--text-secondary)">
          <input type="checkbox" id="exif-clear-gps"> Clear GPS coordinates
        </label>
      </div>` +
      (meta.GPSLatitude ? `<div class="meta-ed-hint">Current: ${Number(meta.GPSLatitude).toFixed(5)}, ${Number(meta.GPSLongitude||0).toFixed(5)}</div>` : '');
  } catch(err) {
    const body = ov.querySelector('#meta-ed-body');
    if (body) body.innerHTML = `<div style="padding:16px;color:#f87171;font-size:12px">Could not load EXIF: ${escHtml(String(err))}</div>`;
  }
  // Wire ff-csel in exif editor
  const _exifBody = ov.querySelector('#meta-ed-body');
  if (_exifBody) {
    const _closeExifCsel = () => _exifBody.querySelectorAll('.ff-csel.open').forEach(el => el.classList.remove('open'));
    _exifBody.querySelectorAll('.ff-csel').forEach(csel => {
      csel.querySelector('.ff-csel-btn')?.addEventListener('click', e => {
        e.stopPropagation(); const wasOpen=csel.classList.contains('open'); _closeExifCsel(); if(!wasOpen) csel.classList.add('open');
      });
      csel.querySelectorAll('.ff-csel-opt').forEach(opt => {
        opt.addEventListener('click', e => {
          e.stopPropagation();
          csel.querySelector('.ff-csel-label').textContent = opt.textContent;
          csel.querySelectorAll('.ff-csel-opt').forEach(o => o.classList.toggle('active', o===opt));
          const hidden = csel.querySelector('input[type=hidden]');
          if (hidden) hidden.value = opt.dataset.val;
          _closeExifCsel();
        });
      });
    });
  }
}

// ── r128/r25: Audio tag editor — uses native lofty backend (no exiftool) ────
async function _showAudioTagEditor(entry, panel) {
  let selectedCoverUrl = null;
  
  const ov = _metaEditorOverlay('Edit Tags — ' + entry.name,
    '<div style="padding:24px;text-align:center;color:var(--text-tertiary)">Loading tags…</div>',
    async (ov, close) => {
      const statusDiv = ov.querySelector('#meta-ed-status');
      const get = id => ov.querySelector(id)?.value?.trim() ?? '';
      const orig = id => ov.querySelector(id)?.dataset?.orig ?? '';
      // Only send fields that actually changed
      const tags = {};
      const fields = [
        ['title',   '#aud-title'],
        ['artist',  '#aud-artist'],
        ['album',   '#aud-album'],
        ['year',    '#aud-year'],
        ['track',   '#aud-track'],
        ['genre',   '#aud-genre'],
        ['comment', '#aud-comment'],
      ];
      let changed = false;
      for (const [key, sel] of fields) {
        const val = get(sel);
        if (val !== orig(sel)) { tags[key] = val; changed = true; }
      }
      // Include cover URL if one was selected from search
      if (selectedCoverUrl) {
        tags.cover_url = selectedCoverUrl;
        changed = true;
      }
      if (!changed) { close(); return; }
      if (statusDiv) statusDiv.textContent = selectedCoverUrl ? 'Saving with cover...' : 'Saving...';
      ov.querySelector('#meta-ed-apply').disabled = true;
      try {
        await invoke('write_audio_tags', { path: entry.path, tags });
        if (statusDiv) { statusDiv.style.color = '#34d399'; statusDiv.textContent = selectedCoverUrl ? 'Saved with cover!' : 'Saved!'; }
        setTimeout(close, 900);
      } catch(err) {
        if (statusDiv) { statusDiv.style.color = '#f87171'; statusDiv.textContent = String(err); }
        ov.querySelector('#meta-ed-apply').disabled = false;
      }
    }
  );

  try {
    const meta = await invoke('get_audio_tags', { path: entry.path });
    const body = ov.querySelector('#meta-ed-body');
    if (!body || !ov.isConnected) return;
    const row = (id, label, val, placeholder='') => {
      const v = escHtml(String(val ?? ''));
      return `<div class="meta-ed-row">
        <label class="meta-ed-label" for="${id}">${label}</label>
        <input class="meta-ed-input" id="${id}" value="${v}" data-orig="${v}" placeholder="${escHtml(placeholder)}">
      </div>`;
    };
    
    // Build search query from existing metadata
    const searchQuery = [meta.title, meta.artist, meta.album].filter(Boolean).join(' ') || entry.name.replace(/\.[^.]+$/, '');
    
    body.innerHTML = 
      `<div class="aud-search-row" style="display:flex;gap:8px;margin-bottom:12px;align-items:center;">
        <input class="meta-ed-input" id="aud-search" value="${escHtml(searchQuery)}" placeholder="Search online..." style="flex:1;">
        <button class="stg-btn" id="aud-search-btn" style="padding:6px 12px;font-size:11px;">Search</button>
      </div>
      <div id="aud-search-results" style="max-height:180px;overflow-y:auto;display:none;border:1px solid var(--border);border-radius:8px;margin-bottom:12px;"></div>` +
      row('aud-title',   'Title',   meta.title,   'Song title') +
      row('aud-artist',  'Artist',  meta.artist,  'Artist name') +
      row('aud-album',   'Album',   meta.album,   'Album name') +
      row('aud-year',    'Year',    meta.year,    'YYYY') +
      row('aud-track',   'Track #', meta.track,   '1') +
      row('aud-genre',   'Genre',   meta.genre,   'e.g. Pop') +
      row('aud-comment', 'Comment', meta.comment, '');
    
    // Wire search button
    const searchInput = body.querySelector('#aud-search');
    const searchBtn = body.querySelector('#aud-search-btn');
    const resultsDiv = body.querySelector('#aud-search-results');
    
    const doSearch = async () => {
      const query = searchInput.value.trim();
      if (!query) return;
      searchBtn.disabled = true;
      searchBtn.textContent = 'Searching...';
      resultsDiv.style.display = 'block';
      resultsDiv.innerHTML = '<div style="padding:12px;color:var(--text-tertiary)">Searching...</div>';
      
      try {
        const results = await invoke('search_music_metadata', { query });
        if (!results || results.length === 0) {
          resultsDiv.innerHTML = '<div style="padding:12px;color:var(--text-tertiary)">No results found</div>';
          return;
        }
        resultsDiv.innerHTML = results.map((r, i) => `
          <div class="aud-result-item" data-idx="${i}" style="padding:8px 12px;cursor:pointer;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;">
            <div style="width:40px;height:40px;background:var(--bg-hover);border-radius:4px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
              ${r.cover_url ? `<img src="${escHtml(r.cover_url)}" style="width:40px;height:40px;object-fit:cover;border-radius:4px;" onerror="this.parentElement.innerHTML='🎵'">` : '🎵'}
            </div>
            <div style="flex:1;min-width:0;">
              <div style="font-size:12px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(r.title)}</div>
              <div style="font-size:10px;color:var(--text-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(r.artist)}${r.album ? ' — ' + escHtml(r.album) : ''}</div>
            </div>
          </div>
        `).join('');
        
        // Wire click to apply
        resultsDiv.querySelectorAll('.aud-result-item').forEach(item => {
          item.addEventListener('click', () => {
            const idx = parseInt(item.dataset.idx);
            const r = results[idx];
            if (r.title) { body.querySelector('#aud-title').value = r.title; }
            if (r.artist) { body.querySelector('#aud-artist').value = r.artist; }
            if (r.album) { body.querySelector('#aud-album').value = r.album; }
            if (r.year) { body.querySelector('#aud-year').value = r.year; }
            // Store cover URL for embedding when saving
            selectedCoverUrl = r.cover_url || null;
            resultsDiv.style.display = 'none';
            d().showToast(selectedCoverUrl ? d().t('toast.music_applied_cover', {title: r.title}) : d().t('toast.music_applied', {title: r.title}), 'success');
          });
        });
      } catch(err) {
        resultsDiv.innerHTML = `<div style="padding:12px;color:#f87171;font-size:11px;">Search failed: ${escHtml(String(err))}</div>`;
      } finally {
        searchBtn.disabled = false;
        searchBtn.textContent = 'Search';
      }
    };
    
    searchBtn.addEventListener('click', doSearch);
    searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
    
  } catch(err) {
    const body = ov.querySelector('#meta-ed-body');
    if (body) body.innerHTML = `<div style="padding:16px;color:#f87171;font-size:12px">Could not load tags: ${escHtml(String(err))}</div>`;
  }
}

// ── r136: PDF metadata editor ─────────────────────────────────────────────────
async function _showPdfMetaEditor(entry, panel) {
  const ov = _metaEditorOverlay('Edit PDF Metadata — ' + entry.name,
    '<div style="padding:24px;text-align:center;color:var(--text-tertiary)">Loading…</div>',
    async (ov, close) => {
      const fields = [];
      const statusDiv = ov.querySelector('#meta-ed-status');
      [
        ['Title',    '#pdf-title'],
        ['Author',   '#pdf-author'],
        ['Subject',  '#pdf-subject'],
        ['Keywords', '#pdf-keywords'],
      ].forEach(([tag, sel]) => {
        const el = ov.querySelector(sel);
        if (el && el.value.trim() !== (el.dataset.orig||'')) fields.push([tag, el.value.trim()]);
      });
      if (!fields.length) { close(); return; }
      if (statusDiv) statusDiv.textContent = 'Saving…';
      ov.querySelector('#meta-ed-apply').disabled = true;
      try {
        await invoke('write_pdf_meta', {path: entry.path, fields});
        if (statusDiv) { statusDiv.style.color = '#34d399'; statusDiv.textContent = 'Saved!'; }
        setTimeout(close, 900);
      } catch(err) {
        if (statusDiv) { statusDiv.style.color = '#f87171'; statusDiv.textContent = String(err); }
        ov.querySelector('#meta-ed-apply').disabled = false;
      }
    }
  );

  try {
    const meta = await invoke('get_pdf_meta', {path: entry.path});
    const body = ov.querySelector('#meta-ed-body');
    if (!body || !ov.isConnected) return;
    const row = (id, label, val) => {
      const v = escHtml(String(val||''));
      return `<div class="meta-ed-row">
        <label class="meta-ed-label" for="${id}">${label}</label>
        <input class="meta-ed-input" id="${id}" value="${v}" data-orig="${v}">
      </div>`;
    };
    body.innerHTML =
      row('pdf-title',    'Title',    meta.Title||'') +
      row('pdf-author',   'Author',   meta.Author||meta.Creator||'') +
      row('pdf-subject',  'Subject',  meta.Subject||'') +
      row('pdf-keywords', 'Keywords', meta.Keywords||'');
  } catch(err) {
    const body = ov.querySelector('#meta-ed-body');
    if (body) body.innerHTML = `<div style="padding:16px;color:#f87171;font-size:12px">Could not load metadata: ${escHtml(String(err))}</div>`;
  }
}

export function announceA11y(message) {
  let el = document.getElementById('a11y-announce');
  if (!el) {
    el = document.createElement('div'); el.id = 'a11y-announce';
    el.setAttribute('role','status'); el.setAttribute('aria-live','polite'); el.setAttribute('aria-atomic','true');
    el.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);';
    document.body.appendChild(el);
  }
  el.textContent = ''; requestAnimationFrame(() => { el.textContent = message; });
}
