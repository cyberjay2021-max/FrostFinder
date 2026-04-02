# FrostFinder — Translation Guide

Thank you for helping translate FrostFinder! This guide covers everything you need to add or improve a translation.

## Quick start

1. **Copy** `src/locales/en.json` to `src/locales/{lang}.json`  
   (use the [ISO 639-1 code](https://en.wikipedia.org/wiki/List_of_ISO_639-1_codes) — `pt`, `ko`, `ru`, `it`, `ar`, …)
2. **Translate** every value. Do **not** change the keys.
3. **Run** `node scripts/check-locales.js` to verify your file has all 292 keys and valid JSON.
4. **Open a pull request** with just your locale file added.

## File format

Each locale file is a flat JSON object: every key maps to a translated string.

```json
{
  "nav.back": "Back",
  "nav.forward": "Forward"
}
```

Keys use dot-notation to group related strings (`nav.*`, `op.*`, `sidebar.*`, etc.) but the file is flat — there is no nesting.

## Variables and plurals

Some strings contain `{var}` placeholders — keep them exactly as-is:

```json
"toast.copied": "Copied {n} item",
"toast.copied_plural": "Copied {n} items"
```

> **Never translate variable names.** `{n}`, `{count}`, `{name}`, `{path}`, `{err}` must stay unchanged.

### Plural forms

Keys ending in `_plural` are shown when the count is ≠ 1 (English grammar). If your language has more than two plural forms (e.g. Arabic, Russian, Polish), add the most common plural form for the `_plural` key — the app currently only supports one plural variant per key.

## RTL languages

Arabic (`ar`), Hebrew (`he`), Farsi (`fa`), and Urdu (`ur`) are supported automatically. When one of these locales is active, FrostFinder sets `<html dir="rtl">` and applies RTL-mirrored layout. You do not need to do anything special in the JSON file — the CSS handles the rest.

If you spot a layout issue in RTL mode, please file a bug with a screenshot.

## Validation

After editing your file, run:

```bash
node scripts/check-locales.js
```

Expected output:
```
✓ ar    ████████████████████ 100%  (292 keys, 0 untranslated)
✓ de    ████████████████████ 100%  (292 keys, 0 untranslated)
...
All 7 locale files match en.json (292 keys).
```

The script will tell you if you have:
- **Missing keys** — keys in `en.json` not in your file (the app would fall back to English for those strings)
- **Extra keys** — keys in your file not in `en.json` (typos, stale keys)
- **Untranslated strings** — values identical to English (shown as a percentage, not an error)

CI runs this check on every pull request. A PR with missing keys will not be merged.

## Adding your locale to the language picker

Once your file is in `src/locales/`, add an `<option>` to the language picker in `src/main.js`. Search for the `ff_locale` settings block:

```js
<option value="ja" …>日本語</option>
// add your line here:
<option value="pt" …>Português</option>
```

For RTL languages, add `dir="rtl"` to the `<option>`:

```js
<option value="ar" dir="rtl" …>العربية</option>
```

## Locale file inventory

| Code | Language             | Status     |
|------|----------------------|------------|
| `en` | English              | ✅ Canonical |
| `de` | German / Deutsch     | ✅ Complete |
| `es` | Spanish / Español    | ✅ Complete |
| `fr` | French / Français    | ✅ Complete |
| `zh` | Chinese (Simplified) | ✅ Complete |
| `ja` | Japanese / 日本語     | ✅ Complete |
| `ar` | Arabic / العربية     | ✅ Complete |
| `pt` | Portuguese           | 🙋 Wanted  |
| `ko` | Korean               | 🙋 Wanted  |
| `ru` | Russian              | 🙋 Wanted  |
| `it` | Italian              | 🙋 Wanted  |

If you are working on a language marked 🙋 Wanted, please comment on the relevant GitHub issue so duplicate effort can be avoided.

## Tips for good translations

- **Use the app first.** Install FrostFinder and navigate around so you understand the context of each string before translating.
- **Prefer natural phrasing** over literal translation. `"Move to Trash"` in English is idiomatic — your language probably has an equivalent idiom.
- **Keep UI strings short.** Button labels (`btn.*`) and toolbar items (`nav.*`) appear in tight spaces. Aim for the same approximate length as English.
- **Leave technical terms untranslated** where there is no standard equivalent (e.g. `WebDAV`, `SFTP`, `SHA-256`, `regex`).
- **Test with your locale active.** Set `ff_locale` in localStorage via the browser console or Settings → Appearance → Language, then exercise the features to check that strings fit their context.

## Asking for help

Open a [GitHub Discussion](https://github.com/frostfinder/frostfinder/discussions) or comment on the translation tracking issue if you have questions about context, phrasing, or technical constraints.
