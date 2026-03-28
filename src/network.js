/**
 * network.js — Network mount dialogs: SFTP, FTP, Vault (gocryptfs), Cloud (rclone)
 *
 * r29 P2.1 Stage 4: Extracted from main.js.
 * Exports: showSftpDialog, showFtpDialog, showVaultDialog, showCloudDialog, CLOUD_PROVIDERS
 *
 * All dialogs self-contained: they call invoke() directly and use showToast/t from deps.
 */

import { invoke } from '@tauri-apps/api/core';

// Dependencies injected by main.js
let _showToast, _t, _renderSidebar;
export function initNetworkDeps({ showToast, t, renderSidebar }) {
  _showToast = showToast; _t = t; _renderSidebar = renderSidebar;
}

// Internal helpers used inside dialogs (reference the injected deps)
function showToast(m, type) { _showToast?.(m, type); }
function t(k, v) { return _t?.(k, v) ?? k; }
function renderSidebar() { _renderSidebar?.(); }

const CLOUD_PROVIDERS = [
  { id: 'gdrive',   name: 'Google Drive',  icon: '🔵', color: '#4285f4' },
  { id: 'dropbox',  name: 'Dropbox',       icon: '🟦', color: '#0061fe' },
  { id: 'onedrive', name: 'OneDrive',      icon: '🪟', color: '#0078d4' },
];


// ── SFTP dialog ───────────────────────────────────────────────────────────────
export async function showSftpDialog(prefill = {}) {
  document.getElementById('sftp-dialog')?.remove();
  const dlg = document.createElement('div'); dlg.id = 'sftp-dialog'; dlg.className = 'modal-overlay';
  dlg.innerHTML = `<div class="modal-box" style="width:400px"><div class="modal-header">
    <span class="modal-title">Connect to SFTP Server</span>
    <button class="btn-icon" onclick="document.getElementById('sftp-dialog').remove()">✕</button></div>
    <div class="modal-body" style="display:flex;flex-direction:column;gap:10px">
      <label class="field-label">Host<input id="sftp-host" class="text-input" placeholder="hostname or IP" autocomplete="off" value="${String(prefill.host||'')}"></label>
      <label class="field-label">Port<input id="sftp-port" class="text-input" value="${prefill.port||22}" style="width:80px"></label>
      <label class="field-label">Username<input id="sftp-user" class="text-input" value="${String(prefill.username||'')}"></label>
      <label class="field-label">Password (leave blank to use SSH key)<input id="sftp-pass" class="text-input" type="password"></label>
      <label class="field-label">SSH key path (optional)<input id="sftp-key" class="text-input" placeholder="~/.ssh/id_rsa"></label>
      <label class="field-label">Remote path<input id="sftp-remote-path" class="text-input" placeholder="/home/user" value="${String(prefill.remotePath||'')}"></label>
      <div id="sftp-error" style="color:var(--color-error,#e53e3e);font-size:13px;display:none"></div></div>
    <div class="modal-footer">
      <button class="btn-ghost" onclick="document.getElementById('sftp-dialog').remove()">Cancel</button>
      <button class="btn-primary" id="sftp-connect-btn">Connect</button></div></div>`;
  document.body.appendChild(dlg);
  document.getElementById('sftp-connect-btn').addEventListener('click', async () => {
    const host       = document.getElementById('sftp-host').value.trim();
    const port       = parseInt(document.getElementById('sftp-port').value) || 22;
    const username   = document.getElementById('sftp-user').value.trim();
    const password   = document.getElementById('sftp-pass').value;
    const keyPath    = document.getElementById('sftp-key').value.trim();
    const remotePath = document.getElementById('sftp-remote-path').value.trim() || '/';
    const errEl = document.getElementById('sftp-error'); errEl.style.display = 'none';
    if (!host) { errEl.textContent = 'Host required'; errEl.style.display = 'block'; return; }
    const btn = document.getElementById('sftp-connect-btn'); btn.disabled = true; btn.textContent = 'Connecting…';
    try {
      const { invoke: _inv } = await import('@tauri-apps/api/core');
      const mp = await _inv('mount_sftp', { host, port, username, password, keyPath, remotePath });
      dlg.remove();
      showToast('Connected to ' + host, 'success');
      renderSidebar();
    } catch(err) { errEl.textContent = String(err); errEl.style.display = 'block'; btn.disabled = false; btn.textContent = 'Connect'; }
  });
  document.getElementById('sftp-host').focus();
}


// ── FTP dialog ────────────────────────────────────────────────────────────────
export async function showFtpDialog() {
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


// ── Phase 4: Encrypted vault dialog ──────────────────────────────────────────

export async function showVaultDialog() {
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



// r32 P5.3: rclone RC API state — tracks whether the no-FUSE daemon is running
let _rcloneRcUrl = null;

export async function ensureRcloneRc() {
  if (_rcloneRcUrl) return _rcloneRcUrl;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    _rcloneRcUrl = await invoke('start_rclone_rc');
    return _rcloneRcUrl;
  } catch(e) {
    console.warn('[rclone-rc] failed to start:', e);
    return null;
  }
}

export async function rcloneRcList(remote, path = '') {
  await ensureRcloneRc();
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('rclone_rc_list', { remote, path });
}

export async function rcloneRcCopy(srcFs, srcPath, dstFs, dstPath) {
  await ensureRcloneRc();
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke('rclone_rc_copy', { srcFs, srcPath, dstFs, dstPath });
}

export async function showCloudDialog() {
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



