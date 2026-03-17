// search.worker.js — runs on a separate CPU thread
// Handles fuzzy/glob search filtering so the UI thread stays at 144fps

self.onmessage = function(e) {
  const { id, type, payload } = e.data;

  if (type === 'filter') {
    // Local in-memory filter (current directory entries)
    const { entries, query, showHidden } = payload;
    const q = query.toLowerCase();
    const results = entries.filter(entry => {
      if (!showHidden && entry.is_hidden) return false;
      return entry.name.toLowerCase().includes(q);
    });
    self.postMessage({ id, type: 'filter_result', results });

  } else if (type === 'sort') {
    const { entries, col, dir, foldersFirst } = payload;
    const sorted = [...entries].sort((a, b) => {
      if (foldersFirst && a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      switch (col) {
        case 'name': return dir * a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        case 'size': return dir * (a.size - b.size) || a.name.localeCompare(b.name);
        case 'date': return dir * (a.modified - b.modified) || a.name.localeCompare(b.name);
        case 'type': {
          const ea = (a.is_dir ? '' : a.extension || 'zzz').toLowerCase();
          const eb = (b.is_dir ? '' : b.extension || 'zzz').toLowerCase();
          return dir * ea.localeCompare(eb) || a.name.localeCompare(b.name);
        }
        default: return dir * a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      }
    });
    self.postMessage({ id, type: 'sort_result', results: sorted });
  }
};
