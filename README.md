# FrostFinder

A macOS Finder-inspired file manager for Linux/Windows/macOS, built with Tauri v2.

**Version:** 1.0.1-RC2-R7 | **Status:** Release Candidate

## Screenshots

| Column View | Gallery View |
|-------------|--------------|
| ![Column View](https://raw.githubusercontent.com/cyberjay2021-max/FrostFinder/main/SCREENSHOTS/screenshot_2026-03-17_10-48-57.png) | ![Gallery View](https://raw.githubusercontent.com/cyberjay2021-max/FrostFinder/main/SCREENSHOTS/screenshot_2026-03-17_10-50-17.png) |

| Dual Pane | Quick Look |
|-----------|------------|
| ![Dual Pane](https://raw.githubusercontent.com/cyberjay2021-max/FrostFinder/main/SCREENSHOTS/screenshot_2026-03-17_10-49-59.png) | ![Quick Look](https://raw.githubusercontent.com/cyberjay2021-max/FrostFinder/main/SCREENSHOTS/screenshot_2026-03-17_10-50-58.png) |

## What We Want to Achieve

FrostFinder aims to bring the elegant, intuitive file management experience from macOS to Linux desktop users. We believe file management should be:

- **Beautiful** — Clean, modern UI inspired by macOS Finder
- **Fast** — Native performance with instant navigation
- **Powerful** — Advanced features without complexity
- **Accessible** — Usable by everyone, including keyboard and screen reader users
- **Extensible** — Customisable via plugins and a growing feature set

## Features

### Core Views
- **Column View** — Browse directories in a cascading column layout like macOS Finder
- **List, Icon, Gallery Views** — Multiple ways to see your files
- **Dual-Pane View** (`F3`) — Side-by-side file browsing with resizable divider; `F5` copy across panes, `F6` move across panes
- **Quick Look** — Preview files with Space bar (images, videos, documents, archives)

### File Operations
- **Trash / Recycle Bin** — Delete sends files to `~/.local/share/Trash/`; restore individually or in bulk; conflict resolution on restore
- **Secure Delete** (`Shift+Delete`) — Permanently overwrite files before deletion
- **Find Duplicates** — SHA-256 hashing with a results panel and per-duplicate delete/show buttons
- **Batch Rename** (`Ctrl+Shift+R`) — Find & replace, prefix/suffix, numbering, case change — with live preview
- **Undo** (`Ctrl+Z`) — Tracks paste, copy, and drag-and-drop operations; **Undo History Panel** (`Ctrl+Shift+Z`) shows the full stack

### Navigation
- **Tabs** (`Ctrl+T`) — Multiple tabs with independent state; each remembers its dual-pane layout
- **Multiple Windows** (`Ctrl+N`) — Independent windows, each tracking its own path in the title bar
- **Recent Locations** — Sidebar section + right-click breadcrumb menu
- **Bookmarks / Favorites** — Drag folders onto the Favorites section header to bookmark them
- **Type-to-select** — Type a name prefix to jump to the first matching entry

### Search
- **Full-text content search** — Searches inside file text, not just filenames
- **Regex mode** — Treat the query as a regular expression
- **Scope control** — Current folder / subfolders / everywhere
- **Hidden files** toggle
- **Saved searches** — Name and persist any query + filter combination; one-click recall from sidebar

### Remote & Network
- **SMB/CIFS** (`Ctrl+Shift+S`) — Mount Windows/Samba shares
- **WebDAV / Cloud** (`Ctrl+Shift+G`) — Nextcloud, ownCloud, Synology etc.
- **SFTP** (`Ctrl+Shift+H`) — SSH-based remote filesystems via sshfs
- **FTP / FTPS** (`Ctrl+Shift+J`) — Plain FTP and explicit TLS via curlftpfs
- All network mounts persist across restarts

### Organisation
- **Tags & Colors** — Color-coded file tagging stored in xattr with automatic SQLite fallback for FAT32/exFAT/network filesystems
- **Audio Metadata Search** — Search MusicBrainz database from audio tag editor; auto-fills title, artist, album, year
- **Album Cover Embedding** — Download cover from Cover Art Archive and embed into audio file; displays in Gallery View
- **Compression** — Create and extract ZIP, 7z, tar archives
- **Archive preview** — See contents of ZIP/tar/7z without extracting

### System Integration
- **Terminal** (`Ctrl+Alt+T`) — Opens preferred terminal at current folder; also in right-click menu
- **File Permissions** (`Ctrl+I`) — Properties dialog with `chmod`/`chown`, rwx checkboxes + octal input
- **Metadata Editor** (`Ctrl+I`) — Edit EXIF for images, audio tags, and PDF metadata natively (no exiftool needed)
- **Preview Panel** (`Ctrl+P`) — Collapsible/resizable preview panel (180-800px drag resize)
- **Disk Usage** (`Ctrl+Shift+U`) — Squarified treemap + bar list; click to navigate
- **Mount/Unmount** — ISO images, USB drives, DMG files
- **Video codec badges** — Codec, resolution, fps, duration, bitrate shown in preview panel (requires ffprobe)
- **Open With** — Remembers last-used app per file extension
- **Thumbnail cache GC** — Automatic cleanup of stale thumbnails on startup

### Customisation
- **Custom Actions / Plugins** — Define shell commands that appear in the right-click menu; glob-based file matching; `{path}`, `{name}`, `{dir}`, `{ext}` variables
- **Theme Switcher** — Light/Dark/System theme in Settings → Appearance
- **Icon Themes** — Load custom SVG icon themes from folder
- **Localization (i18n)** — String catalogue in `src/locales/{lang}.json`; ships English; auto-detected from system locale; overridable in Settings
- **Keyboard shortcut cheatsheet** (`Ctrl+?`)

### Accessibility
- Full ARIA roles and labels across all views (`role="listbox"`, `role="option"`, `role="dialog"`, etc.)
- Screen reader live region — navigation, search results, and file operations announced automatically
- Full keyboard navigation with focus management and focus trapping in dialogs
- Visible focus indicators for keyboard users

## Downloads

### Linux

| Format | Distribution | Command |
|--------|--------------|---------|
| [`.deb`](https://github.com/cyberjay2021-max/FrostFinder/releases/tag/v1.0.1-RC2-R7) | Debian/Ubuntu | `sudo dpkg -i FrostFinder_*.deb` |
| [`.rpm`](https://github.com/cyberjay2021-max/FrostFinder/releases/tag/v1.0.1-RC2-R7) | Fedora/RHEL | `sudo rpm -i FrostFinder-*.rpm` |
| Flatpak | Flathub | `flatpak install flathub com.frostfinder.desktop` |
| AUR | Arch/Manjaro | `yay -S frostfinder` |

### macOS

| Format | Method | Command |
|--------|--------|---------|
| `.dmg` | Direct | Download and drag `FrostFinder.app` to Applications |
| Homebrew | Cask | `brew install --cask frostfinder` |

> **Minimum:** macOS 10.15 Catalina. Apple Silicon (M1+) and Intel builds provided.

### Windows

| Format | Method | Command |
|--------|--------|---------|
| `.msi` | MSI installer | Run the installer wizard |
| `.exe` | NSIS installer | Run the installer wizard |
| Winget | Package manager | `winget install FrostFinder.FrostFinder` |

> **Minimum:** Windows 10 (1809+). x64 only.

## Building from Source

### Prerequisites

**Ubuntu/Debian:**
```bash
sudo apt install -y libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf libssl-dev \
  curl gcc g++ make sshfs sshpass curlftpfs
```

**Fedora:**
```bash
sudo dnf install -y webkit2gtk4.1-devel gtk3-devel librsvg2-devel patchelf openssl-devel \
  curl gcc gcc-c++ make fuse-sshfs sshpass curlftpfs
```

**Arch Linux:**
```bash
sudo pacman -S --needed webkitgtk-6.0 gtk3 librsvg patchelf openssl curl gcc make \
  sshfs sshpass curlftpfs
```

### Build

```bash
npm install
npm run tauri dev      # development
npm run tauri build    # production
```

## Tech Stack

- **Frontend:** Vanilla JavaScript, Vite
- **Backend:** Rust, Tauri v2
- **UI:** Custom CSS (no framework)
- **Database:** SQLite (rusqlite, bundled) — tag fallback storage

## Latest Release (v1.0.1-RC2-R7)

### New in R7
- **Native EXIF metadata** — Read/write EXIF tags for JPEG/PNG without exiftool (kamadak-exif)
- **Native PDF metadata** — Read/write PDF metadata without exiftool (lopdf)
- **Audio metadata search** — Search MusicBrainz database from audio tag editor
- **Album cover embedding** — Download and embed cover art into audio files
- **Preview panel** — Collapsible/resizable (Ctrl+P toggle, drag handle 180-800px)
- **Theme switcher** — Light/Dark/System theme options

### Previous Releases
- v1.0.1-RC2-R3: Native EXIF/PDF metadata (no exiftool dependency)
- v1.0.1-RC2-R2: Add missing build.rs
- v1.0.1-RC2-R1: List view sort & selection fixes, context menu edge clamping

## Keyboard Shortcuts

> The in-app cheatsheet (`Ctrl+?`) is generated from the same `_KB_DEFAULTS` array
> that drives this table. To update: edit `_KB_DEFAULTS` in `src/main.js`, then run
> `node scripts/gen-shortcuts-readme.js`. Shortcuts are fully remappable in Settings → Keyboard.

| Shortcut | Action |
|----------|--------|
| **Navigation** | |
| `Backspace` | Go back |
| `Ctrl+L` | Edit path (breadcrumb) |
| `Ctrl+\\` | Toggle split pane |
| `Ctrl+D` | Compare directories |
| **Files** | |
| `Ctrl+C` | Copy |
| `Ctrl+X` | Cut |
| `Ctrl+V` | Paste |
| `Delete` | Move to Trash |
| `Ctrl+A` | Select all |
| `Space` | Quick Look |
| `Ctrl+I` | File permissions |
| `F5` | Refresh |
| **View** | |
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close tab |
| `Ctrl+F` | Search |
| `Ctrl+Shift+F` | Advanced search |
| `Ctrl+,` | Settings |
| `Ctrl+?` | Keyboard shortcuts |
| **Edit** | |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` | Redo |
| `Ctrl+Shift+Z` | Undo history panel |
| **App** | |
| `Ctrl+Shift+P` | Plugin manager |
| `Ctrl+N` | New window |
| `Ctrl+Alt+T` | Open terminal here |
| `Ctrl+Shift+U` | Disk usage |
| `Ctrl+Shift+E` | Error log |
| **Network** | |
| `Ctrl+Shift+H` | Connect SFTP |
| `Ctrl+Shift+J` | Connect FTP |
| `Ctrl+Shift+G` | Cloud storage |
| `Ctrl+Shift+V` | Encrypted vaults |
| `Ctrl+P` | Toggle preview panel |
| **Navigation** | |
| `Ctrl+Tab` | Next tab |
| `Ctrl+Shift+Tab` | Previous tab |

## Roadmap

### In Progress
- [ ] Cloud storage sync (Google Drive, Dropbox, OneDrive via rclone)
- [ ] Metadata templates (apply saved metadata to multiple files)

### Planned
- [ ] File sharing server (share folders via HTTP locally)
- [ ] Folder sync/backup jobs (schedule folder synchronization)
- [ ] Advanced batch operations (resize images, convert formats)
- [ ] Custom/saved views (save and recall view configurations)
- [ ] Recent files history panel
- [ ] File format preview plugins (extendable preview handlers)
- [ ] Disk cleanup tool (find large files, temp files, duplicates across folders)
- [ ] Media organization (auto-sort photos by date, organize by EXIF)

### Ideas
- [ ] Cloud backup integration (Borg, Restic)
- [ ] Password-protected archives
- [ ] File versioning/history
- [ ] Diff tool for folders
- [ ] Command palette (Ctrl+Shift+P) for quick actions
- [ ] Tab groups/workspace saving
- [ ] Fuzzy search everywhere

## License

GPL-3.0 — See LICENSE file

## Contributing
