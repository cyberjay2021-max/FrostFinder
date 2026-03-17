// ql-window.js — Runs inside the native Quick Look WebviewWindow.
// Receives file data from the main window via Tauri events.
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow as _getAppWindow } from '@tauri-apps/api/window';
const appWindow = _getAppWindow();
import { listen, emit } from '@tauri-apps/api/event';
import { IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS, PDF_EXTS, DOC_EXTS, OFFICE_EXTS, BOOK_EXTS, HTML_EXTS, DMG_EXTS, FONT_EXTS, fmtSize, escHtml, fileIcon, fileColor } from './utils.js';

// ── State ────────────────────────────────────────────────────────────────────
let _navEntries = [];   // flat list of non-dir entries for prev/next
let _curIdx     = 0;
let _mediaPort  = null;

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
  const isDoc  = DOC_EXTS.includes(ext) || OFFICE_EXTS.includes(ext) || BOOK_EXTS.includes(ext);

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

  } else if (isDoc) {
    qlBody.innerHTML = '<span class="ql-loading">Loading…</span>';
    invoke('get_file_preview', { path: entry.path }).then(pd => {
      qlBody.innerHTML = '';
      if (pd?.content != null) {
        const pre = document.createElement('pre');
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

// ── Navigation ────────────────────────────────────────────────────────────────
qlPrev.addEventListener('click', () => {
  if (_curIdx > 0) {
    _curIdx--;
    renderEntry(_navEntries[_curIdx]);
    // Notify main window so its selection syncs
    emit('ql-nav', { idx: _curIdx }).catch(() => {});
  }
});
qlNext.addEventListener('click', () => {
  if (_curIdx < _navEntries.length - 1) {
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
  stopAllMedia();                    // ← stop audio before hiding — fixes ghost audio in hidden window
  emit('ql-closed', {}).catch(() => {});
  appWindow.hide().catch(() => {});  // hide, not close — keep process warm for next Space press
}
qlClose.addEventListener('click', closeWindow);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { e.preventDefault(); closeWindow(); return; }
  if (e.key === ' ') {
    // Space always dismisses the QL window (stopAllMedia inside closeWindow handles pausing).
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
