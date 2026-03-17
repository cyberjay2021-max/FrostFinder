# FrostFinder Development Guide

## Build Commands

### Frontend (JavaScript/Vite)
```bash
npm run dev          # Start Vite dev server (http://localhost:5173)
npm run build        # Build frontend to dist/
npm run preview      # Preview production build
```

### Tauri (Rust Desktop App)
```bash
npm run tauri dev    # Run app in development mode (hot reload)
npm run tauri build  # Build production release (.deb, .rpm, .AppImage)
```

### Rust Only
```bash
cd src-tauri

# Development
cargo check          # Fast syntax/type check (no linking)
cargo build          # Debug build
cargo build --release # Release build

# Testing
cargo test           # Run all tests
cargo test <name>   # Run single test by exact name

# Linting & Formatting
cargo clippy         # Lint with Clippy (catches common mistakes)
cargo fmt            # Format code (run before committing)
cargo fmt -- --check # Check formatting without modifying files
```

### Running a Single Test
```bash
# Rust: use cargo test with exact test name
cargo test test_function_name

# JavaScript: no test framework currently (add Jest/Vitest if needed)
```

## Code Style Guidelines

### JavaScript (ES Modules)

**File Organization**
- One top-level export per file, or a few closely related exports
- Group exports at the bottom: `export { func1, func2, const1 }`
- Use IIFE for private state modules (see main.js `_sbProgress`, `FF` patterns)

**Naming Conventions**
- Functions: `camelCase` (e.g., `navigate`, `renderColumnView`)
- Constants: `SCREAMING_SNAKE_CASE` (e.g., `FIRST_CHUNK`, `MAX_ENTRIES`)
- Private variables: `_prefix` (e.g., `_jsCacheGet`, `_navSeq`)
- DOM elements: `$` suffix or `_el` prefix (e.g., `wrap`, `barEl`)

**Imports**
- Group by source: Tauri API, then local modules, then utilities
- Use named imports: `import { invoke } from '@tauri-apps/api/core'`
- Avoid default imports from Tauri (version-specific paths change between v1/v2)

**Code Organization**
```javascript
// 1. Imports
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { helperFunc } from './utils.js';

// 2. Private state (IIFE or module-level)
const _privateState = (() => {
  const cache = new Map();
  // ... return public API
})();

// 3. Public exports
export function publicFunc() { ... }
export const PUBLIC_CONST = 42;
```

**Formatting**
- 2-space indentation (no tabs)
- No trailing commas
- Use semicolons
- Max line length ~100 chars (soft limit for readability)
- Braces: same-line opening brace

**Error Handling**
- Use try/catch for async IPC calls to Tauri backend
- Always `.catch()` or await promises from `invoke()`
- Log errors with `FF.log()` for debugging
- Show user-friendly errors via `showToast()`

**Performance Patterns**
- Use `requestAnimationFrame` batched renders (see `scheduleRender`)
- Debounce navigation: `navigateDebounced()`
- Use LRU caches with eviction limits (see `_JS_DIR_CACHE`)
- Run heavy computation off main thread via Web Workers
- Use `spawn_blocking` for filesystem I/O in Rust

### Rust (Tauri Backend)

**Naming Conventions**
- Functions: `snake_case` (e.g., `list_directory_streamed`)
- Structs/Enums: `PascalCase` (e.g., `FileEntry`, `DriveInfo`)
- Modules: `snake_case` (e.g., `mod watcher`)
- Private fields: `_prefix` not required, use `pub(crate)` for internal visibility

**Imports**
- Group: std, external crates, tauri, local modules
- Use `use` for commonly called functions
- Prefer absolute paths within crate: `use crate::utils::helper;`

**Error Handling**
- Use `Result<T, String>` for Tauri commands (converted to JS errors)
- Use `?` for propagating errors
- Provide meaningful error messages: `Err(format!("PERMISSION_DENIED:{}",path))`

**Code Organization**
```rust
// 1. Imports
use std::fs;
use serde::{Deserialize, Serialize};
use tauri::{Window, Manager, Emitter};

// 2. Static state (OnceLock, Mutex, etc.)
static DIR_CACHE: RwLock<Option<DirCache>> = RwLock::new(None);

// 3. Helper functions (private)
fn helper_func() -> Type { ... }

// 4. Structs
#[derive(Debug, Serialize, Deserialize)]
pub struct FileEntry { ... }

// 5. Tauri commands
#[tauri::command]
async fn tauri_command() -> Result<(), String> { ... }
```

**Performance Patterns**
- Use `RwLock` for concurrent reads (cache)
- Use `tauri::async_runtime::spawn_blocking` for blocking I/O
- Use `rayon::par_iter()` for parallel file operations
- Cache hot paths (directory listings, thumbnails)

### Tauri v2 Migration Notes

**Import Changes**
- Window: `getCurrentWindow` from `@tauri-apps/api/window`
- WebviewWindow: from `@tauri-apps/api/webviewWindow` (not window)
- Events: `listen`, `emit`, `once` from `@tauri-apps/api/event`

**Permissions**
- Add capabilities in `src-tauri/capabilities/main.json`
- Required: `core:webview:allow-create-webview-window` for Quick Look
- Check Tauri v2 docs for updated permission names

### Project Structure
```
FrostFinder/
├── src/                    # Frontend JavaScript
│   ├── main.js            # Main app, navigation, state
│   ├── views.js           # View renderers (column, list, icon, gallery)
│   ├── utils.js           # Utilities, file type constants
│   ├── ql-window.js       # Quick Look window logic
│   └── search.worker.js   # Web Worker for search/sort
├── src-tauri/
│   ├── src/main.rs        # Rust backend, all Tauri commands
│   ├── capabilities/      # Permission configuration
│   ├── tauri.conf.json    # Tauri build config
│   └── Cargo.toml         # Rust dependencies
├── package.json           # npm dependencies
└── VERSION                # Build version
```

### Version Management
For each release:
1. Update `VERSION` file (increment REVISION)
2. Update `version` in `package.json`
3. Update `version` in `src-tauri/tauri.conf.json`
4. Update `version` in `src-tauri/Cargo.toml`
5. Create backup: `tar -cvzf BACKUP/FrostFinder-beta-5-r{REVISION}-{DATE}.tar.gz --exclude='node_modules' --exclude='.git' --exclude='src-tauri/target' --exclude='.flatpak-builder' --exclude='build-flatpak' .`
6. Push to GitHub and create release

### Debugging
- Use `FF.log('EVENT', data)` for frontend logging
- Open debug panel: `FF.show()` or press `Ctrl+Shift+L`
- Check browser console (F12)
- Enable `?debug` in URL to auto-open debug panel
- View Rust logs in terminal when running `npm run tauri dev`

### Best Practices
1. **Always create backup** before code changes
2. **Test on large directories** (1000+ files) to catch performance issues
3. **Use streaming** for directory reads to avoid UI blocking
4. **Cache aggressively** but evict on filesystem changes (inotify)
5. **Avoid main-thread blocking** - offload to workers/Rust threads
6. **Run cargo fmt before committing** - keeps code consistent
7. **Run cargo clippy before committing** - catches common mistakes
