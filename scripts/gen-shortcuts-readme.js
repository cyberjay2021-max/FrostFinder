#!/usr/bin/env node
/**
 * scripts/gen-shortcuts-readme.js
 *
 * Reads the _KB_DEFAULTS array from src/main.js and regenerates the
 * "## Keyboard Shortcuts" section of README.md.
 *
 * Usage:
 *   node scripts/gen-shortcuts-readme.js           # overwrite README.md
 *   node scripts/gen-shortcuts-readme.js --check   # exit 1 if README would change (for CI)
 *
 * This keeps the README shortcut table in sync with the actual keybindings
 * without manual maintenance. Run before every release or add to CI:
 *
 *   # In .github/workflows/ci.yml:
 *   - run: node scripts/gen-shortcuts-readme.js --check
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir  = dirname(fileURLToPath(import.meta.url));
const ROOT   = resolve(__dir, '..');
const CHECK  = process.argv.includes('--check');

// ── 1. Parse _KB_DEFAULTS from main.js ───────────────────────────────────────
// We use a regex rather than evaluating the file to avoid running Tauri imports.

const mainJs = readFileSync(resolve(ROOT, 'src/main.js'), 'utf8');

// Extract the _KB_DEFAULTS array as a raw string
const arrayMatch = mainJs.match(/const _KB_DEFAULTS\s*=\s*(\[[\s\S]*?\n\];)/);
if (!arrayMatch) {
  console.error('ERROR: Could not find _KB_DEFAULTS in src/main.js');
  process.exit(1);
}

// Parse each entry with a line-by-line regex
// Format: { id:'...', label:'...', category:'...', keys:{...}, ... }
const entryRe = /\{\s*id:'([^']+)',\s*label:'([^']+)',\s*category:'([^']+)',\s*keys:\{([^}]+)\}/g;

const defaults = [];
let m;
while ((m = entryRe.exec(arrayMatch[1])) !== null) {
  const [, id, label, category, keysStr] = m;

  // Parse keys object: { ctrl:true, shift:true, alt:true, key:'X' }
  const keys = {};
  const kvRe = /(\w+):(true|'[^']*')/g;
  let kv;
  while ((kv = kvRe.exec(keysStr)) !== null) {
    const [, k, v] = kv;
    keys[k] = v === 'true' ? true : v.slice(1, -1); // strip quotes
  }

  defaults.push({ id, label, category, keys });
}

if (defaults.length === 0) {
  console.error('ERROR: Parsed 0 shortcuts from _KB_DEFAULTS — regex may need updating');
  process.exit(1);
}

// ── 2. Format a human-readable shortcut string from a keys object ─────────────
function formatKeys(keys) {
  const parts = [];
  if (keys.ctrl)  parts.push('Ctrl');
  if (keys.alt)   parts.push('Alt');
  if (keys.shift) parts.push('Shift');
  if (keys.key) {
    const k = keys.key;
    // Pretty-print special keys
    const special = {
      ' ': 'Space', 'Delete': 'Delete', 'Backspace': 'Backspace',
      'Escape': 'Escape', 'Enter': 'Enter', 'Tab': 'Tab',
      'F1':'F1','F2':'F2','F3':'F3','F4':'F4','F5':'F5','F6':'F6',
      'F7':'F7','F8':'F8','F9':'F9','F10':'F10','F11':'F11','F12':'F12',
      '/': '?',  // Ctrl+/ renders as Ctrl+?
      ',': ',', '\\': '\\',
    };
    parts.push(special[k] ?? k.toUpperCase());
  }
  return parts.join('+');
}

// ── 3. Build the markdown table ───────────────────────────────────────────────
const categories = [...new Set(defaults.map(d => d.category))];

let table = '| Shortcut | Action |\n|----------|--------|\n';

for (const cat of categories) {
  table += `| **${cat}** | |\n`;
  for (const def of defaults.filter(d => d.category === cat)) {
    const shortcut = formatKeys(def.keys);
    if (!shortcut) continue;
    table += `| \`${shortcut}\` | ${def.label} |\n`;
  }
}

// ── 4. Build the full replacement section ─────────────────────────────────────
const newSection =
  '## Keyboard Shortcuts\n\n' +
  '> The in-app cheatsheet (`Ctrl+?`) is generated from the same `_KB_DEFAULTS` array\n' +
  '> that drives this table. To update: edit `_KB_DEFAULTS` in `src/main.js`, then run\n' +
  '> `node scripts/gen-shortcuts-readme.js`. Shortcuts are fully remappable in Settings → Keyboard.\n\n' +
  table;

// ── 5. Splice into README.md ──────────────────────────────────────────────────
const readmePath = resolve(ROOT, 'README.md');
const readme = readFileSync(readmePath, 'utf8');

// Match from "## Keyboard Shortcuts" to just before "## License"
const sectionRe = /## Keyboard Shortcuts[\s\S]*?(?=\n## )/;
if (!sectionRe.test(readme)) {
  console.error('ERROR: Could not find "## Keyboard Shortcuts" section in README.md');
  process.exit(1);
}

const updated = readme.replace(sectionRe, newSection.trimEnd());

// ── 6. Write or check ─────────────────────────────────────────────────────────
if (CHECK) {
  if (updated === readme) {
    console.log(`✓ README.md shortcuts are up to date (${defaults.length} shortcuts, ${categories.length} categories)`);
    process.exit(0);
  } else {
    console.error('✗ README.md shortcut table is out of sync with _KB_DEFAULTS.');
    console.error('  Run: node scripts/gen-shortcuts-readme.js');
    // Show a diff summary
    const oldLines = readme.split('\n');
    const newLines = updated.split('\n');
    const added   = newLines.filter(l => !oldLines.includes(l) && l.trim()).length;
    const removed = oldLines.filter(l => !newLines.includes(l) && l.trim()).length;
    console.error(`  +${added} lines / -${removed} lines`);
    process.exit(1);
  }
} else {
  writeFileSync(readmePath, updated, 'utf8');
  console.log(`✓ README.md updated — ${defaults.length} shortcuts across ${categories.length} categories`);
}
