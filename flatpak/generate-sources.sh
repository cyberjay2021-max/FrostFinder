#!/usr/bin/env bash
# flatpak/generate-sources.sh
#
# Generates the two offline-source files required before submitting to Flathub:
#   flatpak/cargo-sources.json  — all Rust crates from Cargo.lock
#   flatpak/node-sources.json   — all npm packages from package-lock.json
#
# Run this once after any dependency change and commit both output files.
#
# Requirements:
#   pip install flatpak-node-generator   (node-sources)
#   pip install flatpak-cargo-generator  (cargo-sources)
#   -- or use the all-in-one container:
#   podman run --rm -v "$PWD":/app ghcr.io/flatpak/flatpak-builder-tools /app/flatpak/generate-sources.sh

set -euo pipefail
cd "$(dirname "$0")/.."   # project root

FLATPAK_DIR="flatpak"
mkdir -p "$FLATPAK_DIR"

echo "→ Generating Cargo offline sources…"
flatpak-cargo-generator \
    src-tauri/Cargo.lock \
    -o "$FLATPAK_DIR/cargo-sources.json"
echo "  written: $FLATPAK_DIR/cargo-sources.json ($(wc -l < "$FLATPAK_DIR/cargo-sources.json") lines)"

echo "→ Generating Node offline sources…"
flatpak-node-generator \
    npm \
    package-lock.json \
    -o "$FLATPAK_DIR/node-sources.json"
echo "  written: $FLATPAK_DIR/node-sources.json ($(wc -l < "$FLATPAK_DIR/node-sources.json") lines)"

echo ""
echo "Done. Commit both files before opening the Flathub PR:"
echo "  git add $FLATPAK_DIR/cargo-sources.json $FLATPAK_DIR/node-sources.json"
echo "  git commit -m 'flatpak: update offline dependency sources'"
