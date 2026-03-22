# Maintainer: FrostFinder contributors <https://github.com/frostfinder/frostfinder>
pkgname=frostfinder
pkgver=6.0.26
pkgrel=1
pkgdesc="A fast, modern file manager for Linux inspired by macOS Finder"
arch=('x86_64')
url="https://github.com/frostfinder/frostfinder"
license=('GPL3')
depends=(
    'webkit2gtk-4.1'
    'gtk3'
    'libayatana-appindicator'
    'librsvg'
    'udisks2'
)
makedepends=(
    'rust'
    'cargo'
    'nodejs'
    'npm'
    'patchelf'
    'openssl'
    'base-devel'
)
optdepends=(
    'ffmpeg: video transcoding fallback for HEVC/H.265 and HEIC preview'
    'libheif: better HEIC colour accuracy (primary decoder)'
    'mpv: external fullscreen video player'
    'sshfs: SFTP remote filesystem support (Ctrl+Shift+F)'
    'curlftpfs: FTP/FTPS remote filesystem support (Ctrl+Shift+P)'
    'cifs-utils: SMB/CIFS network share support (Ctrl+Shift+S)'
    'fuse2: required to run the .AppImage bundle directly'
    'gocryptfs: encrypted vault support'
    'rclone: Google Drive, Dropbox, OneDrive cloud storage (Ctrl+Shift+G)'
)
source=("$pkgname-$pkgver.tar.gz::https://github.com/frostfinder/frostfinder/archive/refs/tags/v$pkgver.tar.gz")
sha256sums=('SKIP')   # TODO before publishing: replace with output of: sha256sum frostfinder-5.0.77.tar.gz

prepare() {
    cd "$pkgname-$pkgver"

    export CARGO_HOME="$srcdir/cargo-home"
    export npm_config_cache="$srcdir/npm-cache"

    npm ci
    cargo fetch --locked --manifest-path src-tauri/Cargo.toml
}

build() {
    cd "$pkgname-$pkgver"

    export CARGO_HOME="$srcdir/cargo-home"
    export npm_config_cache="$srcdir/npm-cache"

    # Suppress AppImage FUSE and eu-strip errors on Arch/CachyOS
    export APPIMAGE_EXTRACT_AND_RUN=1
    export NO_STRIP=1

    npm run tauri build -- --bundles none
}

check() {
    cd "$pkgname-$pkgver"

    export CARGO_HOME="$srcdir/cargo-home"

    # Rust unit tests
    cargo test --locked \
        --manifest-path src-tauri/Cargo.toml \
        -- --test-threads=4

    # JS tests (requires the frontend build from build())
    export npm_config_cache="$srcdir/npm-cache"
    npm test
}

package() {
    cd "$pkgname-$pkgver"

    # Binary
    install -Dm755 "src-tauri/target/release/$pkgname" \
        "$pkgdir/usr/bin/$pkgname"

    # Desktop entry
    install -Dm644 "packaging/frostfinder.desktop" \
        "$pkgdir/usr/share/applications/frostfinder.desktop"

    # AppStream metainfo
    install -Dm644 "packaging/com.frostfinder.desktop.metainfo.xml" \
        "$pkgdir/usr/share/metainfo/com.frostfinder.desktop.metainfo.xml"

    # Icons — all hicolor sizes
    for size in 16 32 48 64 128 256 512; do
        install -Dm644 "src-tauri/icons/${size}x${size}.png" \
            "$pkgdir/usr/share/icons/hicolor/${size}x${size}/apps/frostfinder.png"
    done

    # Scalable SVG icon
    install -Dm644 "src-tauri/icons/icon.svg" \
        "$pkgdir/usr/share/icons/hicolor/scalable/apps/frostfinder.svg"

    # Licence
    install -Dm644 LICENSE \
        "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
}
