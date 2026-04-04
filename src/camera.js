/**
 * FrostFinder — Camera / Video Recording View
 * Opens when a camera device is clicked in the sidebar.
 * Uses the browser MediaRecorder API (WebRTC) — no native plugin required.
 * Saves via Tauri's dialog.save + fs.writeFile to avoid WebKit2GTK anchor-click freeze.
 */

(function () {
  'use strict';

  let _stream = null;
  let _recorder = null;
  let _chunks = [];
  let _timerInterval = null;
  let _seconds = 0;
  let _overlay = null;

  /* ── helpers ─────────────────────────────────────────────── */

  function fmtTime(s) {
    const m = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${m}:${ss}`;
  }

  function stopStream() {
    if (_stream) { _stream.getTracks().forEach(t => t.stop()); _stream = null; }
  }

  function stopTimer() {
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
    _seconds = 0;
  }

  function closeOverlay() {
    stopTimer();
    if (_recorder && _recorder.state !== 'inactive') _recorder.stop();
    stopStream();
    if (_overlay && _overlay.parentNode) _overlay.parentNode.removeChild(_overlay);
    _overlay = null;
    _recorder = null;
    _chunks = [];
  }

  function showToastLocal(msg, type = 'info') {
    if (typeof window.showToast === 'function') {
      window.showToast(msg, type);
    } else {
      const t = document.createElement('div');
      t.textContent = msg;
      t.style.cssText = `position:fixed;bottom:24px;left:50%;transform:translateX(-50%);
        background:rgba(30,30,35,.95);color:#e2e8f0;padding:8px 18px;border-radius:8px;
        font-size:13px;z-index:99999;pointer-events:none;`;
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 3000);
    }
  }

  /**
   * Save a Blob using Tauri's native save dialog + fs.writeFile.
   * This avoids the WebKit2GTK anchor-click freeze that occurs when a
   * programmatic <a download>.click() triggers the webview's download
   * interception handler.
   */
  async function saveRecording(blob, defaultName) {
    try {
      const tauri = window.__TAURI__;
      if (!tauri) throw new Error('Tauri globals not available');

      // Show native save-file dialog
      const savePath = await tauri.dialog.save({
        defaultPath: defaultName,
        filters: [{ name: 'WebM Video', extensions: ['webm'] }],
        title: 'Save Recording',
      });

      if (!savePath) return; // user cancelled

      // Convert blob → Uint8Array and write via fs plugin
      const buf = await blob.arrayBuffer();
      await tauri.fs.writeFile(savePath, new Uint8Array(buf));
      showToastLocal(`Saved: ${savePath.split('/').pop()}`, 'success');

    } catch (err) {
      // Fallback: try objectURL download (may freeze on some WebKit builds,
      // but better than silently losing the recording)
      console.error('Tauri save failed, falling back to anchor download:', err);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = defaultName;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 3000);
      showToastLocal(`Saved: ${defaultName}`, 'success');
    }
  }

  /* ── main entry ──────────────────────────────────────────── */

  window._openCameraView = async function (deviceId, deviceName) {
    if (_overlay) { closeOverlay(); return; }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (err) {
      showToastLocal('Camera access denied: ' + err.message, 'error');
      return;
    }
    _stream = stream;
    _chunks = [];

    /* ── build overlay ──────────────────────────────────────── */
    const ov = document.createElement('div');
    ov.id = 'ff-camera-overlay';
    ov.style.cssText = `
      position: fixed; inset: 0; z-index: 9000;
      background: rgba(0,0,0,.72);
      display: flex; align-items: center; justify-content: center;
      backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    `;

    ov.innerHTML = `
      <div id="ff-cam-modal" style="
        background: rgba(28,28,32,.97);
        border: 1px solid rgba(255,255,255,.10);
        border-radius: 16px;
        box-shadow: 0 32px 80px rgba(0,0,0,.7);
        width: min(780px, 92vw);
        display: flex; flex-direction: column;
        overflow: hidden;
        font-family: var(--ff-font, 'Inter', sans-serif);
      ">

        <!-- title bar -->
        <div style="
          display:flex; align-items:center; justify-content:space-between;
          padding: 14px 18px 12px;
          border-bottom: 1px solid rgba(255,255,255,.07);
          background: rgba(255,255,255,.03);
        ">
          <div style="display:flex;align-items:center;gap:9px;">
            <svg viewBox="0 0 24 24" fill="none" stroke="#34d399" stroke-width="1.7"
                 style="width:17px;height:17px;flex-shrink:0">
              <path d="M15 10l4.553-2.069A1 1 0 0121 8.82v6.36a1 1 0 01-1.447.89L15 14"/>
              <rect x="3" y="6" width="12" height="12" rx="2"/>
            </svg>
            <span style="color:#e2e8f0;font-size:13.5px;font-weight:500;">
              ${deviceName || 'Camera'}
            </span>
          </div>
          <div style="display:flex;align-items:center;gap:10px;">
            <div id="ff-cam-rec-badge" style="
              display:none; align-items:center; gap:6px;
              background:rgba(239,68,68,.15); border:1px solid rgba(239,68,68,.3);
              border-radius:20px; padding:3px 10px;
            ">
              <div id="ff-cam-dot" style="
                width:8px;height:8px;border-radius:50%;
                background:#ef4444; animation: ff-cam-pulse 1s infinite;
              "></div>
              <span id="ff-cam-timer" style="color:#ef4444;font-size:11px;font-weight:600;
                letter-spacing:.04em;font-variant-numeric:tabular-nums;">00:00</span>
            </div>
            <button id="ff-cam-close" title="Close" style="
              background:none;border:none;cursor:pointer;
              color:#636368;font-size:18px;line-height:1;
              padding:2px 5px;border-radius:6px;
              transition:color .15s, background .15s;
            " onmouseover="this.style.color='#e2e8f0';this.style.background='rgba(255,255,255,.08)'"
               onmouseout="this.style.color='#636368';this.style.background='none'">✕</button>
          </div>
        </div>

        <!-- video preview -->
        <div style="position:relative;background:#000;line-height:0;">
          <video id="ff-cam-video" autoplay muted playsinline style="
            width:100%; max-height:440px; object-fit:cover; display:block;
          "></video>
          <div id="ff-cam-standby" style="
            position:absolute;inset:0;
            background:rgba(0,0,0,.25);
            display:flex;align-items:center;justify-content:center;
            pointer-events:none;
          ">
            <span style="color:rgba(255,255,255,.25);font-size:12px;letter-spacing:.06em;
              text-transform:uppercase;">Live Preview</span>
          </div>
        </div>

        <!-- controls bar -->
        <div style="
          display:flex; align-items:center; justify-content:space-between;
          padding: 14px 20px;
          border-top: 1px solid rgba(255,255,255,.06);
          background: rgba(255,255,255,.02);
          gap: 12px;
        ">
          <div style="font-size:11px;color:#636368;letter-spacing:.04em;">WebM · VP8</div>

          <div style="display:flex;align-items:center;gap:14px;">
            <button id="ff-cam-rec-btn" title="Start Recording" style="
              width:52px;height:52px;border-radius:50%;
              background:rgba(239,68,68,.9);
              border:3px solid rgba(255,255,255,.18);
              cursor:pointer;
              display:flex;align-items:center;justify-content:center;
              transition: transform .12s, box-shadow .12s;
            "
            onmouseover="this.style.transform='scale(1.06)'"
            onmouseout="this.style.transform='scale(1)'">
              <div id="ff-cam-rec-icon" style="
                width:20px;height:20px;border-radius:50%;background:#fff;
                transition:border-radius .18s, width .18s, height .18s;
              "></div>
            </button>
          </div>

          <div id="ff-cam-saving" style="font-size:11px;color:#636368;text-align:right;letter-spacing:.02em;">
            Save dialog on stop
          </div>
        </div>

      </div>

      <style>
        @keyframes ff-cam-pulse {
          0%,100% { opacity:1; }
          50%      { opacity:.3; }
        }
      </style>
    `;

    document.body.appendChild(ov);
    _overlay = ov;

    const video = ov.querySelector('#ff-cam-video');
    video.srcObject = stream;

    ov.querySelector('#ff-cam-close').addEventListener('click', closeOverlay);
    ov.addEventListener('click', e => { if (e.target === ov) closeOverlay(); });
    document.addEventListener('keydown', function escHandler(e) {
      if (e.key === 'Escape') { closeOverlay(); document.removeEventListener('keydown', escHandler); }
    });

    /* ── record / stop ────────────────────────────────────── */
    const recBtn     = ov.querySelector('#ff-cam-rec-btn');
    const recIcon    = ov.querySelector('#ff-cam-rec-icon');
    const recBadge   = ov.querySelector('#ff-cam-rec-badge');
    const timerEl    = ov.querySelector('#ff-cam-timer');
    const standby    = ov.querySelector('#ff-cam-standby');
    const savingEl   = ov.querySelector('#ff-cam-saving');

    let recording = false;

    recBtn.addEventListener('click', () => {
      if (!recording) {
        // — START —
        _chunks = [];
        const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
          ? 'video/webm;codecs=vp9,opus'
          : 'video/webm';
        _recorder = new MediaRecorder(_stream, { mimeType });
        _recorder.ondataavailable = e => { if (e.data.size > 0) _chunks.push(e.data); };

        _recorder.onstop = async () => {
          stopTimer();

          // Reset UI immediately so the app feels responsive
          recording = false;
          recIcon.style.borderRadius = '50%';
          recIcon.style.width = '20px';
          recIcon.style.height = '20px';
          recBtn.style.background = 'rgba(239,68,68,.9)';
          recBtn.title = 'Start Recording';
          recBadge.style.display = 'none';
          standby.style.display = 'flex';
          savingEl.textContent = 'Saving…';

          const blob  = new Blob(_chunks, { type: 'video/webm' });
          const ts    = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
          const fname = `FrostFinder-Recording-${ts}.webm`;
          _chunks = [];

          await saveRecording(blob, fname);
          savingEl.textContent = 'Save dialog on stop';
        };

        _recorder.start(250);
        recording = true;

        _seconds = 0;
        timerEl.textContent = '00:00';
        _timerInterval = setInterval(() => {
          _seconds++;
          timerEl.textContent = fmtTime(_seconds);
        }, 1000);

        recIcon.style.borderRadius = '3px';
        recIcon.style.width = '16px';
        recIcon.style.height = '16px';
        recBtn.style.background = 'rgba(239,68,68,1)';
        recBtn.title = 'Stop Recording';
        recBadge.style.display = 'flex';
        standby.style.display = 'none';

      } else {
        // — STOP — UI resets inside onstop after async save
        recBtn.disabled = true;
        recBtn.style.opacity = '0.5';
        setTimeout(() => { recBtn.disabled = false; recBtn.style.opacity = '1'; }, 3000);
        if (_recorder && _recorder.state !== 'inactive') _recorder.stop();
      }
    });
  };

})();
