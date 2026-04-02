// search.worker.js — runs on a separate CPU thread
// Handles fuzzy/glob search filtering so the UI thread stays at 144fps

// Fuzzy match: checks if query chars appear in order (with gaps allowed)
function fuzzyMatch(name, query) {
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  for (let i = 0; i < n.length && qi < q.length; i++) {
    if (n[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

// Score for fuzzy match (lower = better match)
function fuzzyScore(name, query) {
  const n = name.toLowerCase();
  const q = query.toLowerCase();
  if (n === q) return 0; // exact match
  if (n.startsWith(q)) return 1; // prefix match
  if (n.includes(q)) return 2; // substring match
  if (fuzzyMatch(n, q)) return 3; // fuzzy match
  return Infinity;
}

self.onmessage = function(e) {
  const { id, type, payload } = e.data;

  if (type === 'filter') {
    // Local in-memory filter (current directory entries)
    const { entries, query, showHidden, fuzzy } = payload;
    const q = query.toLowerCase();
    const results = entries.filter(entry => {
      if (!showHidden && entry.is_hidden) return false;
      const name = entry.name.toLowerCase();
      // Exact substring match first
      if (name.includes(q)) return true;
      // Fuzzy match if enabled
      if (fuzzy && fuzzyMatch(name, q)) return true;
      return false;
    });
    // Sort results: exact match > prefix > substring > fuzzy
    if (fuzzy && query.length > 0) {
      results.sort((a, b) => {
        const sa = fuzzyScore(a.name, query);
        const sb = fuzzyScore(b.name, query);
        if (sa !== sb) return sa - sb;
        return a.name.localeCompare(b.name);
      });
    }
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
