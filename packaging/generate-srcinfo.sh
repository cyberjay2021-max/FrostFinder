#!/usr/bin/env bash
# packaging/generate-srcinfo.sh
#
# Generates the .SRCINFO file required by AUR from PKGBUILD.
# Run this after every pkgver/pkgrel bump and commit .SRCINFO to the AUR git repo.
#
# Usage:
#   bash packaging/generate-srcinfo.sh
#
# Requirements:
#   pacman/makepkg (Arch Linux or an Arch container)
#
# In CI / non-Arch environments, use the Docker image:
#   docker run --rm -v "$PWD":/pkg archlinux:latest \
#     sh -c "cd /pkg && makepkg --printsrcinfo > .SRCINFO"

set -euo pipefail
cd "$(dirname "$0")/.."   # project root

if ! command -v makepkg &>/dev/null; then
  echo "Error: makepkg not found. Run on Arch Linux or use the Docker method above." >&2
  exit 1
fi

makepkg --printsrcinfo > .SRCINFO
echo "Written: .SRCINFO"
echo ""
echo "Next steps:"
echo "  1. Copy PKGBUILD and .SRCINFO to your AUR clone:"
echo "       git clone ssh://aur@aur.archlinux.org/frostfinder.git aur-frostfinder"
echo "       cp PKGBUILD .SRCINFO aur-frostfinder/"
echo "  2. cd aur-frostfinder && git add PKGBUILD .SRCINFO"
echo "  3. git commit -m 'upgpkg: frostfinder \$(grep pkgver PKGBUILD | cut -d= -f2)-\$(grep pkgrel PKGBUILD | cut -d= -f2)'"
echo "  4. git push"
