# FrostFinder

A macOS Finder-inspired file manager for Linux, built with Tauri.

## What We Want to Achieve

FrostFinder aims to bring the elegant, intuitive file management experience from macOS to Linux desktop users. We believe file management should be:

- **Beautiful** — Clean, modern UI inspired by macOS Finder
- **Fast** — Native performance with instant navigation
- **Powerful** — Advanced features without complexity

## Features

### Core
- **Column View** — Browse directories in a cascading column layout like macOS Finder
- **Multiple Views** — Column, List, Icon, and Gallery views
- **Quick Look** — Preview files with Space bar (images, videos, documents, archives)
- **Tags & Colors** — Organize files with color-coded tags
- **Compression** — Create and extract ZIP, 7z, tar archives

### File Operations
- **Secure Delete** — Permanently overwrite files with random data before deletion
- **Find Duplicates** — Scan directories to locate duplicate files using SHA-256 hashing
- **Bookmarks** — Save favorite folders for quick access

### System Integration
- **Mount/Unmount** — Support for ISO images, USB drives, and DMG files
- **Tags/Colors** — File tagging system stored in extended attributes
- **Desktop Integration** — Native file manager features

## Downloads

Pre-built packages for major Linux distributions:

| Format | Distribution | Command |
|--------|--------------|---------|
| `.deb` | Debian/Ubuntu | `sudo dpkg -i FrostFinder_*.deb` |
| `.rpm` | Fedora/RHEL | `sudo rpm -i FrostFinder-*.rpm` |
| `.AppImage` | Any Linux | `./FrostFinder_*.AppImage` |

## Building from Source

### Prerequisites

**Ubuntu/Debian:**
```bash
sudo apt install -y libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf libssl-dev curl gcc g++ make
```

**Fedora:**
```bash
sudo dnf install -y webkit2gtk4.1-devel gtk3-devel librsvg2-devel patchelf openssl-devel curl gcc gcc-c++ make
```

**Arch Linux:**
```bash
sudo pacman -S --needed webkitgtk-6.0 gtk3 librsvg patchelf openssl curl gcc make
```

### Build

```bash
# Install dependencies
npm install

# Development
npm run tauri dev

# Production build
npm run tauri build
```

## Tech Stack

- **Frontend:** Vanilla JavaScript, Vite
- **Backend:** Rust, Tauri v2
- **UI:** Custom CSS (no framework)

## License

GPL-3.0 — See LICENSE file

## Contributing

Contributions welcome! Please check our GitHub issues for features to implement.

## Roadmap

- [ ] Batch rename
- [ ] Multiple windows/tabs
- [ ] SMB/Samba network shares
- [ ] Advanced search filters
- [ ] Cloud storage integration
