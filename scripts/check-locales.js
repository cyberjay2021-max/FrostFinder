#!/usr/bin/env node
// scripts/check-locales.js
//
// Validates that every locale file in src/locales/ has exactly the same keys
// as the canonical en.json. Exits with code 1 if any mismatch is found.
//
// Usage:  node scripts/check-locales.js
// CI:     called by the `locales` job in .github/workflows/ci.yml

import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = join(__dirname, '..', 'src', 'locales');

const enRaw  = readFileSync(join(LOCALES_DIR, 'en.json'), 'utf8');
const en     = JSON.parse(enRaw);
const enKeys = Object.keys(en).sort();

const files  = readdirSync(LOCALES_DIR).filter(f => f.endsWith('.json') && f !== 'en.json');

let allOk = true;

for (const file of files.sort()) {
  const lang = file.replace('.json', '');
  let locale;
  try {
    locale = JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8'));
  } catch (e) {
    console.error(`✗ ${lang}: JSON parse error — ${e.message}`);
    allOk = false;
    continue;
  }

  const localeKeys    = Object.keys(locale).sort();
  const missing       = enKeys.filter(k => !localeKeys.includes(k));
  const extra         = localeKeys.filter(k => !enKeys.includes(k));
  const untranslated  = enKeys.filter(k => locale[k] === en[k]);
  const problems      = [];

  if (missing.length) problems.push(`missing keys: ${missing.join(', ')}`);
  if (extra.length)   problems.push(`extra keys: ${extra.join(', ')}`);

  if (problems.length > 0) {
    console.error(`✗ ${lang} (${localeKeys.length} keys):`);
    for (const p of problems) console.error(`    ${p}`);
    allOk = false;
  } else {
    const pct = Math.round(((enKeys.length - untranslated.length) / enKeys.length) * 100);
    const filled = Math.round(pct / 5);
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    console.log(`✓ ${lang.padEnd(5)} ${bar} ${pct}%  (${localeKeys.length} keys, ${untranslated.length} untranslated)`);
  }
}

console.log('');
if (!allOk) {
  console.error('Locale check FAILED. Fix the errors above before merging.');
  process.exit(1);
} else {
  console.log(`All ${files.length} locale files match en.json (${enKeys.length} keys).`);
}
