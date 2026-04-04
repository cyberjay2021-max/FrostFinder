#!/usr/bin/env bash
# ── FrostFinder build packager ─────────────────────────────────────────────────
# Usage:
#   ./PACK.sh                  → uses VERSION file values
#   ./PACK.sh --revision 2     → override revision
#   ./PACK.sh --status beta    → override status
#   ./PACK.sh --version 13     → override version number
#
# Output: FrostFinder-{status}-{version}-r{revision}-{date}.zip
# ──────────────────────────────────────────────────────────────────────────────

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# VERSION file lives inside the project root (same dir as PACK.sh)
VERSION_FILE="$SCRIPT_DIR/VERSION"

# Load defaults from VERSION file
if [ -f "$VERSION_FILE" ]; then
  # shellcheck source=/dev/null
  source "$VERSION_FILE"
else
  PROJECT="FrostFinder"
  STATUS="beta"
  VERSION="4"
  REVISION="33"
fi

DATE=$(date +%Y-%m-%d)

# Override from args
while [[ "$#" -gt 0 ]]; do
  case $1 in
    --status)   STATUS="$2";   shift ;;
    --version)  VERSION="$2";  shift ;;
    --revision) REVISION="$2"; shift ;;
    --date)     DATE="$2";     shift ;;
    *)          echo "Unknown arg: $1"; exit 1 ;;
  esac
  shift
done

BUILD_NAME="${PROJECT}-${STATUS}-${VERSION}-r${REVISION}-${DATE}"
# Releases output goes inside the project tree
OUT_DIR="$SCRIPT_DIR/releases"
mkdir -p "$OUT_DIR"
OUT_ZIP="${OUT_DIR}/${BUILD_NAME}.zip"

echo "📦 Packing: $BUILD_NAME"

# ── Update RELEASE.md table header ──────────────────────────────────────────
# sed -i syntax differs: GNU (Linux) needs no suffix; BSD/macOS needs -i ''
_sedi() {
  if sed --version 2>/dev/null | grep -q GNU; then
    sed -i "$@"
  else
    sed -i '' "$@"
  fi
}

_sedi "s/| \*\*Build\*\*.*/| **Build**  | ${BUILD_NAME} |/" "$SCRIPT_DIR/RELEASE.md"
_sedi "s/| \*\*Status\*\*.*/| **Status** | ${STATUS^} |/"   "$SCRIPT_DIR/RELEASE.md"
_sedi "s/| \*\*Version\*\*.*/| **Version**| ${VERSION} |/"  "$SCRIPT_DIR/RELEASE.md"
_sedi "s/| \*\*Revision\*\*.*/| **Revision**| ${REVISION} |/" "$SCRIPT_DIR/RELEASE.md"
_sedi "s/| \*\*Date\*\*.*/| **Date**   | ${DATE} |/"        "$SCRIPT_DIR/RELEASE.md"

# ── Sync semver to tauri.conf.json, Cargo.toml, package.json ─────────────────
# Encodes as MAJOR.MINOR.PATCH where MAJOR=version, MINOR=0, PATCH=revision
# so that e.g. beta-5-r7 → 5.0.7. Keeps all version surfaces consistent.
SEMVER="${VERSION}.0.${REVISION}"

# tauri.conf.json — "version" under [package]
_sedi "s/\"version\": \"[^\"]*\"/\"version\": \"${SEMVER}\"/" "$SCRIPT_DIR/src-tauri/tauri.conf.json"

# Cargo.toml — only the first occurrence (package version, not dependency versions)
if sed --version 2>/dev/null | grep -q GNU; then
  sed -i "0,/^version = \"[^\"]*\"/s//version = \"${SEMVER}\"/" "$SCRIPT_DIR/src-tauri/Cargo.toml"
else
  # BSD sed (macOS) has no address-range 0,/pattern/ — use perl instead
  perl -i -0pe "s/^version = \"[^\"]*\"/version = \"${SEMVER}\"/m" "$SCRIPT_DIR/src-tauri/Cargo.toml"
fi

# package.json — "version" field
_sedi "s/\"version\": \"[^\"]*\"/\"version\": \"${SEMVER}\"/" "$SCRIPT_DIR/package.json"

# ── Update VERSION file ──────────────────────────────────────────────────────
cat > "$VERSION_FILE" << VEOF
PROJECT=${PROJECT}
STATUS=${STATUS}
VERSION=${VERSION}
REVISION=${REVISION}
DATE=${DATE}
BUILD_NAME=${BUILD_NAME}
VEOF

# ── Build zip ────────────────────────────────────────────────────────────────
cd "$SCRIPT_DIR"

# Collect optional extras that may not exist
OPTIONAL_FILES=()
[ -f "frostfinder-hyprland.conf" ] && OPTIONAL_FILES+=("frostfinder-hyprland.conf")

zip -r "$OUT_ZIP" \
  src/ \
  src-tauri/ \
  index.html \
  ql.html \
  package.json \
  vite.config.js \
  PACK.sh \
  VERSION \
  RELEASE.md \
  BUILD.md \
  PKGBUILD \
  "packaging/" \
  "${OPTIONAL_FILES[@]}" \
  --exclude "*/node_modules/*" \
  --exclude "*/.git/*" \
  --exclude "*/target/*" \
  --exclude "*/dist/*" \
  --exclude "*/releases/*" \
  --exclude "*.bak"

SIZE=$(du -sh "$OUT_ZIP" | cut -f1)
echo "✅ Done: $OUT_ZIP ($SIZE)"
echo ""
echo "Next revision: ./PACK.sh --revision $((REVISION + 1))"
echo "Next version:  ./PACK.sh --version $((VERSION + 1)) --revision 1"
