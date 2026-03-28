/**
 * undo.js — Undo/Redo stack and history panel
 *
 * r28 P2.1 Stage 1: Extracted from main.js.
 * Depends on: invoke (Tauri), state (global), showToast, t, refreshColumns
 *
 * Exports: pushUndo, undoLastOp, redoLastOp, undoToIndex,
 *          toggleUndoPanel, renderUndoPanel
 *
 * Called by: main.js (keyboard handler, context menu, drag-drop, batch-rename,
 *            tags, chmod, plugin runs, ql-file-saved event)
 */

import { invoke } from '@tauri-apps/api/core';

// These are injected by main.js after init so circular imports are avoided.
let _state, _showToast, _t, _refreshColumns, _escHtml;

export function initUndoDeps({ state, showToast, t, refreshColumns, escHtml }) {
  _state     = state;
  _showToast = showToast;
  _t         = t;
  _refreshColumns = refreshColumns;
  _escHtml   = escHtml;
}

// ── Persistent undo history (r30 P3.1) ───────────────────────────────────────

const UNDO_HISTORY_CAP = 200;

/** Persist the current undo stack to disk via Rust. Fire-and-forget. */
export function persistUndoHistory() {
  // Serialize only the stack for the active tab — items must be JSON-safe
  // (all items are plain objects with string/number/array fields).
  if (!_state) return;
  try {
    invoke('save_undo_history', { history: JSON.parse(JSON.stringify(_state._undoStack)) })
      .catch(() => {}); // non-fatal
  } catch (_) {}
}

/** Load the saved undo history from disk and merge into the current stack. */
export async function restoreUndoHistory() {
  if (!_state) return;
  try {
    const saved = await invoke('load_undo_history');
    if (Array.isArray(saved) && saved.length > 0) {
      // Merge: prepend saved history, cap at UNDO_HISTORY_CAP
      _state._undoStack = [...saved, ..._state._undoStack].slice(-UNDO_HISTORY_CAP);
    }
  } catch (_) {} // non-fatal — no history file on first launch
}

/** Clear the on-disk undo history (called from Settings → Advanced). */
export async function clearUndoHistory() {
  try { await invoke('clear_undo_history'); } catch (_) {}
  if (_state) _state._undoStack = [];
}

// ── Core stack operations ─────────────────────────────────────────────────────

export function pushUndo(op) {
  _state._undoStack.push(op);
  // r30 P3.1: cap raised to 200 (persisted), was 50 (in-memory only)
  if (_state._undoStack.length > UNDO_HISTORY_CAP) _state._undoStack.shift();
  _state._redoStack = [];
  persistUndoHistory();
}

export async function undoLastOp() {
  const op = _state._undoStack.pop();
  if (!op) { _showToast(_t('toast.nothing_to_undo'), 'info'); return; }
  _state._redoStack.push(op);
  try {
    for (const item of [...op.items].reverse()) {
      if (op.op === 'move')        { await invoke('move_file',     { src: item.dst, destDir: item.srcDir }); }
      else if (op.op === 'copy')   { await invoke('delete_items',  { paths: [item.dst] }); }
      else if (op.op === 'delete') {
        const trashPaths  = op.items.map(i => i.trashPath || i.src);
        const conflicts   = await invoke('check_trash_restore_conflicts', { paths: trashPaths });
        const instructions = trashPaths.map(p => {
          const c = conflicts.find(x => x.trash_path === p);
          return { path: p, resolution: c ? 'rename' : 'restore' };
        });
        await invoke('trash_restore_with_resolution', { instructions });
      }
      else if (op.op === 'rename')      { await invoke('rename_file',    { oldPath: item.dst, newName: item.oldName }); }
      else if (op.op === 'tags')        { await invoke('set_file_tags_v2', { path: item.path, tags: item.before }); }
      else if (op.op === 'chmod')       { await invoke('chmod_entry', { path: item.path, mode: item.oldMode }); await invoke('chown_entry', { path: item.path, owner: item.oldOwner, group: item.oldGroup }); }
      else if (op.op === 'batchRename') { await invoke('rename_file',    { oldPath: item.newPath, newName: item.oldName }); }
      else if (op.op === 'create')      { await invoke('delete_items',   { paths: [item.dst] }); }
    }
    _showToast(_t('toast.undone'), 'success');
    await _refreshColumns();
  } catch (err) { _showToast(_t('error.undo', { err }), 'error', 'undo'); }
}

export async function redoLastOp() {
  const op = _state._redoStack.pop();
  if (!op) { _showToast(_t('toast.nothing_to_redo'), 'info'); return; }
  _state._undoStack.push(op);
  try {
    for (const item of op.items) {
      if (op.op === 'move')        { await invoke('move_file',          { src: item.src, destDir: item.dstDir }); }
      else if (op.op === 'copy')   { await invoke('copy_file',          { src: item.src, destDir: item.dstDir }); }
      else if (op.op === 'rename') { await invoke('rename_file',        { oldPath: item.src, newName: item.newName }); }
      else if (op.op === 'delete') {
        const paths = op.items.map(i => i.src);
        await invoke('delete_items_stream', { paths, trash: true });
      }
      else if (op.op === 'tags')        { await invoke('set_file_tags_v2', { path: item.path, tags: item.after }); }
      else if (op.op === 'chmod')       { await invoke('chmod_entry', { path: item.path, mode: item.newMode }); await invoke('chown_entry', { path: item.path, owner: item.newOwner, group: item.newGroup }); }
      else if (op.op === 'batchRename') { await invoke('rename_file',    { oldPath: item.oldPath, newName: item.newName }); }
      else if (op.op === 'create') {
        // r30 P3.2: redo create — re-create the file/folder using stored srcDir+newName
        try {
          if (item.isDir) {
            await invoke('create_directory', { path: item.srcDir, name: item.newName });
          } else {
            await invoke('create_file_cmd', { path: item.srcDir, name: item.newName });
          }
        } catch (_) { _showToast(_t('toast.cannot_redo_create'), 'warning'); return; }
      }
    }
    _showToast(_t('toast.redone'), 'success');
    await _refreshColumns();
  } catch (err) { _showToast(_t('error.redo', { err }), 'error', 'redo'); }
}

// ── Undo history panel ────────────────────────────────────────────────────────

export function toggleUndoPanel() {
  const ex = document.getElementById('undo-panel');
  if (ex) { ex.remove(); return; }
  renderUndoPanel();
}

export function renderUndoPanel() {
  let panel = document.getElementById('undo-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'undo-panel';
    panel.className = 'side-panel undo-panel';
    document.body.appendChild(panel);
  }
  const stack = _state._undoStack ?? [];
  const icons = { move:'↔', copy:'⊕', rename:'✏', delete:'🗑', create:'✚', tags:'🏷', chmod:'🔒', batchRename:'✏✏' };
  const labels = { move:'Move', copy:'Copy', rename:'Rename', delete:'Trash', create:'Create', tags:'Tag change', chmod:'Permissions', batchRename:'Batch rename' };
  const rows = stack.length === 0
    ? '<div class="undo-empty">Nothing to undo</div>'
    : [...stack].reverse().map((op, i) =>
        `<div class="undo-row${i === 0 ? ' undo-next' : ''}" title="Undo to here" onclick="undoToIndex(${stack.length - 1 - i})">
          <span class="undo-icon">${icons[op.op] ?? '↩'}</span>
          <span class="undo-label">${_escHtml((labels[op.op] || op.op) + (op.items ? ` (${op.items.length})` : ''))}</span>
          ${i === 0 ? '<span class="undo-badge">next</span>' : ''}
        </div>`
      ).join('');

  panel.innerHTML = `
    <div class="side-panel-header">
      <span class="side-panel-title">Undo History</span>
      <span class="undo-count">${stack.length} step${stack.length !== 1 ? 's' : ''}</span>
      <button class="btn-icon" onclick="document.getElementById('undo-panel').remove()">✕</button>
    </div>
    <div class="undo-list">${rows}</div>
    <div class="side-panel-footer">
      <button class="btn-ghost btn-sm" onclick="state._undoStack=[];renderUndoPanel();showToast(t('toast.history_cleared'),'info');" ${stack.length === 0 ? 'disabled' : ''}>Clear History</button>
    </div>`;
}

export async function undoToIndex(targetIdx) {
  while ((_state._undoStack?.length ?? 0) > targetIdx) await undoLastOp();
}
