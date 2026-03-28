# Contributing to FrostFinder

Thank you for taking the time to contribute. FrostFinder is a GPL-3.0 project built with Rust (Tauri) and Vanilla JavaScript. All contributions are welcome — bug fixes, translations, accessibility testing, packaging, and new features.

---

## Quick start

```bash
git clone https://github.com/frostfinder/frostfinder.git
cd frostfinder
npm install
npm run tauri dev        # hot-reload dev build
```

Full build requirements are in [BUILD.md](BUILD.md).

---

## Ways to contribute

### Bug reports

Open an issue and include:
- FrostFinder version (`Help → About` or `cat VERSION`)
- Linux distribution and desktop environment
- Steps to reproduce
- What you expected vs what happened
- Any relevant output from `journalctl --user -f` while reproducing

### Feature requests

Open an issue tagged `enhancement`. Describe the use case, not just the feature. If you have a design in mind, a rough sketch or mockup is very welcome.

### Code changes

1. Fork the repository and create a branch: `git checkout -b fix/my-bug`
2. Make your changes. Follow the code style in [AGENTS.md](AGENTS.md).
3. Run the test suites before committing:
   ```bash
   cd src-tauri && cargo test --locked && cd ..
   npm test
# Test files: src/test/utils.test.js, src/test/views.test.js, src/test/main.test.js, src/test/a11y.test.js
   ```
4. Run the linters:
   ```bash
   cd src-tauri && cargo clippy -- -D warnings && cargo fmt --check
   ```
5. Open a pull request. The CI pipeline will run automatically.

**Keep pull requests focused.** One logical change per PR makes review faster and rebasing easier.

### Accessibility testing

FrostFinder aims for full Orca screen reader support. ARIA structural tests run automatically in CI via `npm test` (see `src/test/a11y.test.js`). Items marked **automated** have regression guards — any PR that breaks them will fail CI.

If you can test with Orca on GNOME, please:

1. Enable Orca: `orca &` or toggle with `Super+Alt+S`
2. Work through the [Orca test checklist](#orca-test-checklist) below
3. File issues for anything that is silent, misread, or unreachable by keyboard

---

## Translation guide

FrostFinder ships string catalogues in `src/locales/{lang}.json`. Adding or improving a translation requires no build tools — just a text editor and a JSON validator.

### Adding a new language

1. Copy the canonical English file:
   ```bash
   cp src/locales/en.json src/locales/{lang}.json
   ```
   Use the ISO 639-1 two-letter code (`pt`, `ko`, `ar`, `hi`, `nl`, …).

2. Translate every **value** — never change the **keys**:
   ```json
   "op.copy": "Copiar"   ✓
   "op.kopieren": "Copy" ✗  (key changed — will silently fall back to English)
   ```

3. Preserve placeholders exactly: `{count}`, `{name}`, `{path}`, `{n}`, `{total}`.
   ```json
   "trash.confirm_empty": "¿Eliminar permanentemente {count} {itemWord} de la Papelera?"
   ```

4. Validate your file:
   ```bash
   python3 -c "
   import json
   with open('src/locales/{lang}.json') as f: data = json.load(f)
   with open('src/locales/en.json')     as f: en   = json.load(f)
   missing = set(en) - set(data)
   extra   = set(data) - set(en)
   print('Missing:', sorted(missing) or 'none')
   print('Extra:',   sorted(extra)   or 'none')
   print(f'Keys: {len(data)} / {len(en)}')
   "
   ```

5. Add the language option to the Settings → Appearance picker in `src/main.js`.
   Find the `<select data-key="ff_locale">` block and add one line:
   ```html
   <option value="{lang}" ${get('ff_locale','en')==='{lang}'?'selected':''}>Your Language Name</option>
   ```

6. Test it:
   ```bash
   # In the dev build, open Settings → Appearance, change language, restart
   npm run tauri dev
   ```

7. Open a pull request with the new locale file and the `main.js` change.

### Improving an existing translation

Open `src/locales/{lang}.json`, fix the values, validate (step 4 above), and open a pull request. Even fixing one or two awkward strings is welcome.

### Current language status

| Code | Language | Status |
|------|----------|--------|
| `en` | English | Canonical — do not translate |
| `es` | Spanish | Machine-translated draft — needs native review |
| `fr` | French | Machine-translated draft — needs native review |
| `de` | German | Machine-translated draft — needs native review |
| `zh` | Chinese (Simplified) | Machine-translated draft — needs native review |
| `ja` | Japanese | Machine-translated draft — needs native review |
| `ar` | Arabic | Machine-translated draft — needs native review (RTL) |

All six non-English files were generated from `en.json` and need a fluent speaker to review for natural phrasing, especially the longer strings in `trash.confirm_empty`, `error.terminal_not_found`, and the `rename.*` group.

---

## Orca test checklist

Work through these scenarios with Orca running. File an issue for each item that fails, marking it `a11y`.

Items marked **implemented** have ARIA attributes in the source. Items marked **needs testing** have the infrastructure but require Orca verification. Items marked **gap** are known missing and tracked as issues.

| # | Scenario | Expected announcement | Status |
|---|----------|-----------------------|--------|
| 1 | Launch app | "FrostFinder" window announced | needs testing |
| 2 | Navigate into a folder (Enter or double-click) | Folder name announced via live region | **automated** |
| 3 | Arrow up/down through files in column view | Each file name + type (`aria-label` on rows) | **automated** |
| 4 | Select a file (click or Space) | `aria-selected` toggles on the row | **automated** |
| 5 | Open context menu (right-click or Menu key) | "Context menu" (`role=menu`, `aria-label`) | **automated** |
| 6 | Arrow through context menu items | Each item label (`role=menuitem`) | **automated** |
| 7 | Open Search (Ctrl+F), type a query | Results count via `announceA11y` | needs testing |
| 8 | Open Settings (Ctrl+,) | "Settings dialog" (`role=dialog` present) | **automated** |
| 9 | Tab through all Settings controls | Each control label and current value | needs testing |
| 10 | Close any dialog with Escape | Focus returns to the file list | **automated** |
| 11 | Switch view modes (Ctrl+1–4) | View name announced | **automated** |
| 12 | Open Trash (sidebar) | "Trash is Empty" or item count | **automated** |
| 13 | Trigger a toast notification (copy a file) | Toast text read by live region | **automated** |
| 14 | Keyboard shortcut cheatsheet (Ctrl+?) | Dialog announced, all shortcuts reachable | **automated** |
| 15 | Dual-pane mode (F3), Tab to switch pane | Active pane path announced | **automated** |

---

## Code style

See [AGENTS.md](AGENTS.md) for the full style guide. Short version:

- **JavaScript:** camelCase, ES6 imports, `try/catch` around every `invoke()` call. All user-visible strings through `t('key')` — never hardcode English in new UI code.
- **Rust:** snake_case functions, PascalCase structs, `Result<T, String>` for Tauri commands.
- **ARIA:** every new interactive element needs a `role`, an `aria-label` or `aria-labelledby`, `tabindex="0"` if keyboard-reachable, and a call to `announceA11y()` after significant state changes.

---

## Commit message format

```
type(scope): short description

Longer explanation if needed. Wrap at 72 chars.
```

Types: `fix`, `feat`, `docs`, `test`, `refactor`, `chore`, `a11y`, `i18n`

Examples:
```
fix(column-view): restore insertBefore order after colEl.appendChild
feat(i18n): add Portuguese translation
a11y(context-menu): add role=menu and role=menuitem
```

---

## Licence

By contributing you agree that your contributions will be licensed under the GPL-3.0 licence that covers this project.
