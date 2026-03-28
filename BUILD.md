# FrostFinder — Build Instructions

## Quick Start

```bash
npm install
npm run tauri build
```

> **Tauri v2** — this build requires `@tauri-apps/cli ^2.0`, `webkit2gtk-4.1`, and Rust ≥ 1.77.
> **License:** GPL-3.0

Produces all enabled targets in `src-tauri/target/release/bundle/`.

---

## Build Targets

| Target    | Output file                                    | Distro |
|-----------|------------------------------------------------|--------|
| `.deb`    | `bundle/deb/frostfinder_*.deb`                | Ubuntu / Debian |
| `.rpm`    | `bundle/rpm/frostfinder-*.rpm`                | Fedora / RHEL / openSUSE |
| `.AppImage` | `bundle/appimage/frostfinder_*.AppImage`    | Any Linux (portable) |
| Flatpak   | Use `flatpak-builder` with `com.frostfinder.desktop.json` | Any Linux (Flathub) |

---

## System Dependencies

### Ubuntu / Debian (build deps)
```bash
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf \
  libssl-dev \
  curl \
  build-essential
```

### Ubuntu (runtime deps — already bundled in .deb)
```
libwebkit2gtk-4.1-0
libgtk-3-0
libayatana-appindicator3-1
udisks2
```

### Fedora (build deps)
```bash
sudo dnf install -y \
  webkit2gtk4.1-devel \
  gtk3-devel \
  librsvg2-devel \
  patchelf \
  openssl-devel \
  curl \
  gcc \
  make
```

### Arch / CachyOS (build deps)
```bash
sudo pacman -S --needed \
  webkit2gtk-4.1 \
  gtk3 \
  libayatana-appindicator \
  librsvg \
  patchelf \
  openssl \
  curl \
  base-devel
```

---

## Rust + Node

Install Rust (if not already):
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source ~/.cargo/env
```

Install Node.js 18+:
- Ubuntu: `sudo apt install nodejs npm`
- Fedora: `sudo dnf install nodejs npm`
- Arch: `sudo pacman -S nodejs npm`

---

## Build for Ubuntu `.deb`

```bash
npm install
npm run tauri build -- --bundles deb
```

Install:
```bash
sudo dpkg -i src-tauri/target/release/bundle/deb/frostfinder_*.deb
```

---

## Build for Fedora `.rpm`

```bash
npm install
npm run tauri build -- --bundles rpm
```

> **Fedora 43 note:** Requires `webkit2gtk-4.1` (provided by the `webkit2gtk-4.1` package).

Install:
```bash
sudo rpm -i src-tauri/target/release/bundle/rpm/frostfinder-*.rpm
# or:
sudo dnf install src-tauri/target/release/bundle/rpm/frostfinder-*.rpm
```

---

## Build portable `.AppImage`

```bash
npm install
npm run tauri build -- --bundles appimage
```

Run:
```bash
chmod +x src-tauri/target/release/bundle/appimage/frostfinder_*.AppImage
./src-tauri/target/release/bundle/appimage/frostfinder_*.AppImage
```

> **Arch / CachyOS note:** `APPIMAGE_EXTRACT_AND_RUN=1` and `NO_STRIP=1` are set in
> `.cargo/config.toml` to work around FUSE mount issues and eu-strip DWARF errors.
> No extra steps needed.

> **Fedora / Ubuntu note:** AppImage requires `fuse` (not `fuse3`) to run. If missing:
> - Ubuntu: `sudo apt install fuse`
> **Note:** Tauri v2 requires Ubuntu 22.04+ (Jammy) — `libwebkit2gtk-4.1` is not available on 20.04 Focal.
> - Fedora: `sudo dnf install fuse`
>
> Or run the AppImage without FUSE:
> ```bash
> ./frostfinder_*.AppImage --appimage-extract-and-run
> ```

---

## AUR (Arch User Repository)

A `PKGBUILD` is included in the project root. To build and install locally:

```bash
# Install base-devel if not already
sudo pacman -S --needed base-devel

# From the project root:
makepkg -si
```

This runs the full `npm run tauri build` inside a clean PKGBUILD environment,
installs the binary to `/usr/bin/frostfinder`, icons to the hicolor theme tree,
and the `.desktop` file to `/usr/share/applications/`.

---

## Icon Installation (manual / for packagers)

Icons are at `src-tauri/icons/`. All hicolor sizes are included:

```
16x16.png   32x32.png   48x48.png   64x64.png
128x128.png  256x256.png  512x512.png
```

Install to the standard XDG hicolor path:
```bash
for size in 16 32 48 64 128 256 512; do
  install -Dm644 src-tauri/icons/${size}x${size}.png \
    /usr/share/icons/hicolor/${size}x${size}/apps/frostfinder.png
done
gtk-update-icon-cache /usr/share/icons/hicolor/ 2>/dev/null || true
```

The `.desktop` file lives at `packaging/frostfinder.desktop`:
```bash
install -Dm644 packaging/frostfinder.desktop \
  /usr/share/applications/frostfinder.desktop
```

---

## Optional Runtime Tools

These are not required but unlock extra features:

| Package | Feature |
|---------|---------|
| `ffmpeg` | Video transcoding fallback for HEVC/H.265, HEIC preview |
| `libheif` (heif-convert) | Better HEIC color accuracy (primary decoder) |
| `mpv` | External fullscreen video player |
| `udisks2` | One-click ISO/DMG/USB mount without sudo |
| `fuse2` | Run the .AppImage bundle directly |

---

## Build Flatpak

### Prerequisites
```bash
# Install Flatpak and Flathub (if not already)
sudo apt install flatpak
flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo

# Install the required SDKs
flatpak install -y flathub org.freedesktop.Platform//23.08 org.freedesktop.Sdk//23.08
flatpak install -y flathub org.freedesktop.Sdk.Extension.rust-stable//23.08
flatpak install -y flathub org.freedesktop.Sdk.Extension.node20//23.08
```

### Build the Flatpak
```bash
# From the project root:
flatpak-builder --user --install build-flatpak com.frostfinder.desktop.json
```

### Run the Flatpak
```bash
flatpak run com.frostfinder.desktop
```

### Publish to Flathub (optional)
Submit the manifest to [Flathub](https://github.com/flathub/io.github.frostfinder/frostfinder) for distribution.

---

## All Targets at Once

```bash
npm install
npm run tauri build
```

Builds `.deb`, `.rpm`, and `.AppImage` in one pass.
The binary is also at `src-tauri/target/release/frostfinder`.
