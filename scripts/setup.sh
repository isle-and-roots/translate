#!/usr/bin/env bash
# Fetch the pinned Sokuji sources and install what the extension build needs.
#
#   npm run setup            # extension only (no Electron download, no native rebuild)
#   npm run setup:desktop    # also prepare the macOS desktop app build
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

DESKTOP=0
for arg in "$@"; do
  case "$arg" in
    --desktop) DESKTOP=1 ;;
    *) die "unknown option: $arg" ;;
  esac
done

cd "$ROOT"
log "Sokuji サブモジュールを取得中（pin: v$(expected_sokuji_version)）"
git submodule update --init --depth 1 sokuji
if [ "$DESKTOP" = 1 ]; then
  # BlackHole (nested submodule) is only needed for the macOS installer.
  git -C sokuji submodule update --init --depth 1
fi
check_sokuji_version

cd "$SOKUJI_DIR"
if [ "$DESKTOP" = 1 ]; then
  # Full install: postinstall runs electron-rebuild and copies the ORT WASM.
  log "npm ci（デスクトップ用・Electron ネイティブ再ビルドを含む）"
  npm ci
else
  # Skip electron-rebuild (downloads Electron, compiles natives) — the
  # extension bundle never touches it. Only the ORT WASM copy is needed.
  log "npm ci --ignore-scripts（拡張用）"
  npm ci --ignore-scripts
  bash scripts/copy-ort-wasm.sh
fi

log "extension の依存をインストール"
cd "$SOKUJI_DIR/extension"
npm ci --ignore-scripts

if [ "$DESKTOP" = 1 ]; then
  log "準備完了。次: npm run build:extension / npm run build:desktop"
else
  log "準備完了。次: npm run build:extension"
fi
