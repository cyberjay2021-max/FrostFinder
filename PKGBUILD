# Maintainer: FrostFinder <your@email.com>
# AUR package for FrostFinder — build from source
#
# HOW TO USE:
#   Install build deps once: sudo pacman -S rust nodejs npm webkit2gtk-4.1 gtk3 \
#                                          base-devel libayatana-appindicator
#   Then: makepkg -si
#
# Tauri v2 note: requires webkit2gtk-4.1 (replaces webkit2gtk / webkit2gtk-4.0).
# Requires Rust >= 1.77 and Node.js >= 18.
#
# The build runs "npm run tauri build" which produces:
#   .deb      → src-tauri/target/release/bundle/deb/
#   .rpm      → src-tauri/target/release/bundle/rpm/
#   .AppImage → src-tauri/target/release/bundle/appimage/
#   The plain binary → src-tauri/target/release/frostfinder

pkgname=frostfinder
pkgver=5.0.27
pkgrel=1
pkgdesc="A fast, modern column-based file manager inspired by macOS Finder"
arch=('x86_64')
url="https://github.com/frostfinder/frostfinder"
license=('GPL3')

# Runtime dependencies (Tauri v2 — webkit2gtk-4.1)
depends=(
    'webkit2gtk-4.1'
    'gtk3'
    'libayatana-appindicator'
    'udisks2'
    'hicolor-icon-theme'
)

# Build-time dependencies
makedepends=(
    'rust'
    'cargo'
    'nodejs'
    'npm'
    'base-devel'
    'webkit2gtk-4.1'
)

# Optional runtime extras (not required, but improve functionality)
optdepends=(
    'ffmpeg: video transcoding + HEIC image support via heif-convert'
    'libheif: HEIC/HEIF image preview (heif-convert command)'
    'mpv: external fullscreen video player'
    'udisks2: one-click mount/unmount of ISO, DMG, USB drives'
    'fuse2: required to run the .AppImage bundle'
)

# ── Source ──────────────────────────────────────────────────────────────────
# Replace the source line with a real tarball URL or git clone once published.
# For local development, comment out source/sha256sums and uncomment the
# local path variant below.
source=("$pkgname-$pkgver.tar.gz::https://github.com/yourusername/frostfinder/archive/refs/tags/v$pkgver.tar.gz")
sha256sums=('SKIP')

# ── Local development variant ────────────────────────────────────────────────
# Uncomment these and comment out source/sha256sums above to build from
# the directory containing this PKGBUILD (useful during development):
#
# source=()
# sha256sums=()
# prepare() { cp -r "$startdir/." "$srcdir/$pkgname-$pkgver/" 2>/dev/null || true; }

prepare() {
    cd "$srcdir/$pkgname-$pkgver"
    # Install JS dependencies (runs offline if node_modules already exists)
    npm install --prefer-offline 2>/dev/null || npm install
}

build() {
    cd "$srcdir/$pkgname-$pkgver"
    npm run tauri build
}

package() {
    cd "$srcdir/$pkgname-$pkgver"

    # ── Binary ────────────────────────────────────────────────────────────────
    install -Dm755 "src-tauri/target/release/frostfinder" \
        "$pkgdir/usr/bin/frostfinder"

    # ── Desktop entry ─────────────────────────────────────────────────────────
    install -Dm644 "packaging/frostfinder.desktop" \
        "$pkgdir/usr/share/applications/frostfinder.desktop"

    # ── Icons (hicolor theme sizes) ───────────────────────────────────────────
    for size in 16 32 48 64 128 256 512; do
        install -Dm644 "src-tauri/icons/${size}x${size}.png" \
            "$pkgdir/usr/share/icons/hicolor/${size}x${size}/apps/frostfinder.png"
    done

    # ── License ───────────────────────────────────────────────────────────────
    install -Dm644 "LICENSE" "$pkgdir/usr/share/licenses/$pkgname/LICENSE" \
        2>/dev/null || true
}
