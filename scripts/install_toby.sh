#!/usr/bin/env bash
set -euo pipefail

# Toby 2.0 (Linux Light) resmi paketini indirip kurar.
INSTALL_DIR="${TOBY_INSTALL_DIR:-$HOME/toby-engine}"
MANIFEST_URL="https://toby.tribychess.org/toby_manifest.json"

echo "Toby 2.0 manifest kontrol ediliyor..."
FILENAME=$(curl -fsSL "$MANIFEST_URL" | python3 -c "import sys, json; print(json.load(sys.stdin)['linux']['light']['fichier'])")
URL="https://toby.tribychess.org/${FILENAME}"

mkdir -p "$INSTALL_DIR"
echo "İndiriliyor: $URL -> $INSTALL_DIR"
curl -fL --progress-bar "$URL" -o "$INSTALL_DIR/toby-linux-light.zip"
unzip -q -o "$INSTALL_DIR/toby-linux-light.zip" -d "$INSTALL_DIR"
rm -f "$INSTALL_DIR/toby-linux-light.zip"
chmod +x "$INSTALL_DIR/Toby/toby"

echo "Kurulum tamamlandı: $INSTALL_DIR/Toby/toby"
