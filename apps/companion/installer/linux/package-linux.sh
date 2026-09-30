#!/usr/bin/env bash
# Package the Flutter companion Linux release bundle into:
#   1. Portable tarball (.tar.gz)
#   2. Standalone AppImage (.AppImage)
#   3. Debian package (.deb)
#   4. RPM package (.rpm)
set -euo pipefail

BUNDLE_DIR=""
VERSION=""
DEST_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bundle)
      BUNDLE_DIR="$2"
      shift 2
      ;;
    --version)
      VERSION="$2"
      shift 2
      ;;
    --dest)
      DEST_DIR="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$BUNDLE_DIR" || -z "$VERSION" || -z "$DEST_DIR" ]]; then
  echo "Usage: package-linux.sh --bundle <bundle-dir> --version <version> --dest <dest-dir>" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPANION_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUNDLE_DIR="$(cd "$BUNDLE_DIR" && pwd)"
mkdir -p "$DEST_DIR"
DEST_DIR="$(cd "$DEST_DIR" && pwd)"

echo "=== Packaging Talon Companion Linux v${VERSION} ==="
echo "Bundle: $BUNDLE_DIR"
echo "Dest:   $DEST_DIR"

# 1. Portable tarball
TARBALL="$DEST_DIR/talon-companion-linux-$VERSION.tar.gz"
echo "Creating portable tarball: $TARBALL"
tar -czf "$TARBALL" -C "$BUNDLE_DIR" .

STAGING_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$STAGING_DIR"
}
trap cleanup EXIT

# 2. Debian (.deb) & RPM (.rpm) via nfpm
echo "Creating .deb and .rpm packages..."
NFPM_BIN=""
if command -v nfpm >/dev/null 2>&1; then
  NFPM_BIN="nfpm"
else
  NFPM_VER="2.41.3"
  NFPM_CACHE="${RUNNER_TEMP:-/tmp}/nfpm-bin-$NFPM_VER"
  if [[ ! -x "$NFPM_CACHE/nfpm" ]]; then
    mkdir -p "$NFPM_CACHE"
    curl -fsSL "https://github.com/goreleaser/nfpm/releases/download/v${NFPM_VER}/nfpm_${NFPM_VER}_Linux_x86_64.tar.gz" | tar -xz -C "$NFPM_CACHE" nfpm
  fi
  NFPM_BIN="$NFPM_CACHE/nfpm"
fi

mkdir -p "$STAGING_DIR/bundle"
cp -r "$BUNDLE_DIR"/* "$STAGING_DIR/bundle/"

RESOLVED_NFPM="$STAGING_DIR/nfpm.yaml"
# Replace path placeholders in nfpm.yaml
TEMPLATE="$SCRIPT_DIR/nfpm.yaml" \
STAGING_BUNDLE="$STAGING_DIR/bundle" \
LINUX_INSTALLER_DIR="$SCRIPT_DIR" \
COMPANION_ASSETS_DIR="$COMPANION_ROOT/assets" \
OUTPUT_FILE="$RESOLVED_NFPM" \
node -e '
const fs = require("fs");
let c = fs.readFileSync(process.env.TEMPLATE, "utf8");
c = c.replace(/\${STAGING_BUNDLE}/g, process.env.STAGING_BUNDLE);
c = c.replace(/\${LINUX_INSTALLER_DIR}/g, process.env.LINUX_INSTALLER_DIR);
c = c.replace(/\${COMPANION_ASSETS_DIR}/g, process.env.COMPANION_ASSETS_DIR);
fs.writeFileSync(process.env.OUTPUT_FILE, c);
'

DEB_OUT="$DEST_DIR/talon-companion_${VERSION}_amd64.deb"
RPM_OUT="$DEST_DIR/talon-companion-${VERSION}-1.x86_64.rpm"

ARCH=amd64 VERSION="$VERSION" "$NFPM_BIN" package -f "$RESOLVED_NFPM" -p deb -t "$DEB_OUT"
ARCH=amd64 VERSION="$VERSION" "$NFPM_BIN" package -f "$RESOLVED_NFPM" -p rpm -t "$RPM_OUT"

# Provide convenience aliases matching platform naming pattern
cp "$DEB_OUT" "$DEST_DIR/talon-companion-linux-$VERSION.deb"
cp "$RPM_OUT" "$DEST_DIR/talon-companion-linux-$VERSION.rpm"

# 3. Standalone AppImage
echo "Creating AppImage..."
APPDIR="$STAGING_DIR/AppDir"
mkdir -p "$APPDIR/usr/bin"
mkdir -p "$APPDIR/usr/lib"
mkdir -p "$APPDIR/usr/share/applications"
mkdir -p "$APPDIR/usr/share/icons/hicolor/256x256/apps"
mkdir -p "$APPDIR/usr/share/icons/hicolor/scalable/apps"
mkdir -p "$APPDIR/usr/share/metainfo"

# Copy flutter bundle into AppDir
cp -r "$BUNDLE_DIR"/* "$APPDIR/usr/bin/"
# Move libraries to usr/lib if present
if [[ -d "$APPDIR/usr/bin/lib" ]]; then
  cp -r "$APPDIR/usr/bin/lib"/* "$APPDIR/usr/lib/" 2>/dev/null || true
fi

# AppRun
cat << 'EOF' > "$APPDIR/AppRun"
#!/bin/sh
set -e
HERE="$(dirname "$(readlink -f "${0}")")"
export PATH="${HERE}/usr/bin:${PATH}"
export LD_LIBRARY_PATH="${HERE}/usr/lib:${HERE}/usr/bin/lib:${LD_LIBRARY_PATH}"
exec "${HERE}/usr/bin/talon_companion" "$@"
EOF
chmod +x "$APPDIR/AppRun"

# Desktop file
cp "$SCRIPT_DIR/talon-companion.desktop" "$APPDIR/talon-companion.desktop"
cp "$SCRIPT_DIR/talon-companion.desktop" "$APPDIR/usr/share/applications/talon-companion.desktop"

# Icons
cp "$SCRIPT_DIR/talon-companion.png" "$APPDIR/talon-companion.png"
ln -sf talon-companion.png "$APPDIR/.DirIcon"
cp "$SCRIPT_DIR/talon-companion.png" "$APPDIR/usr/share/icons/hicolor/256x256/apps/talon-companion.png"
if [[ -f "$COMPANION_ROOT/assets/icon/talon_icon.svg" ]]; then
  cp "$COMPANION_ROOT/assets/icon/talon_icon.svg" "$APPDIR/usr/share/icons/hicolor/scalable/apps/talon-companion.svg"
fi

# AppStream metadata
if [[ -f "$COMPANION_ROOT/flatpak/io.github.thefalconry.TalonCompanion.metainfo.xml" ]]; then
  cp "$COMPANION_ROOT/flatpak/io.github.thefalconry.TalonCompanion.metainfo.xml" "$APPDIR/usr/share/metainfo/talon-companion.metainfo.xml"
fi

APPIMAGETOOL=""
if command -v appimagetool >/dev/null 2>&1; then
  APPIMAGETOOL="appimagetool"
else
  TOOL_CACHE="${RUNNER_TEMP:-/tmp}/appimagetool-x86_64.AppImage"
  if [[ ! -x "$TOOL_CACHE" ]]; then
    curl -fsSL -o "$TOOL_CACHE" "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage"
    chmod +x "$TOOL_CACHE"
  fi
  APPIMAGETOOL="$TOOL_CACHE"
fi

APPIMAGE_OUT="$DEST_DIR/talon-companion-linux-$VERSION.AppImage"
ARCH=x86_64 "$APPIMAGETOOL" --appimage-extract-and-run "$APPDIR" "$APPIMAGE_OUT"

echo "=== Linux packaging complete ==="
ls -lh "$DEST_DIR"
