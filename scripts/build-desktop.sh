#!/usr/bin/env bash
# Build the Sokuji macOS desktop app (needed for the Zoom *desktop* app:
# the browser extension cannot inject a virtual microphone into a native app).
#
# Runs only on macOS. Produces an unsigned local build:
#   dist/Sokuji-<version>-<arch>.pkg
#
# For daily use the signed installer from the upstream release page is the
# simpler choice (docs/setup.md). Use this script when you need a build from
# the exact pinned sources.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[ "$(uname -s)" = "Darwin" ] || die "デスクトップアプリのビルドは macOS 上でのみ行えます（electron-builder --mac）。"
check_sokuji_version
VERSION="$(expected_sokuji_version)"

[ -d "$SOKUJI_DIR/node_modules/electron" ] \
  || die "Electron が未インストールです。先に \`npm run setup:desktop\` を実行してください。"
# The macOS virtual audio driver (BlackHole-derived) ships prebuilt in
# sokuji/resources/drivers and is installed by the pkg postinstall script.
[ -d "$SOKUJI_DIR/resources/drivers/SokujiVirtualAudio.driver" ] \
  || die "resources/drivers/SokujiVirtualAudio.driver がありません。サブモジュールの取得を確認してください。"

case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) die "unsupported arch: $(uname -m)" ;;
esac

log "デスクトップアプリをビルド（Sokuji v$VERSION, $ARCH, 未署名）"
cd "$SOKUJI_DIR"
npm run build
# CSC_IDENTITY_AUTO_DISCOVERY=false: never pick up a random signing identity
# from the keychain for a local build.
CSC_IDENTITY_AUTO_DISCOVERY=false \
  npx electron-builder --mac pkg --"$ARCH" --publish never -c.directories.output=out/make-mac

mkdir -p "$DIST_DIR"
PKG="$(find out/make-mac -maxdepth 1 -name "*.pkg" | head -1)"
[ -n "$PKG" ] || die "pkg が生成されませんでした（out/make-mac を確認）。"
cp "$PKG" "$DIST_DIR/"
log "完了: $DIST_DIR/$(basename "$PKG")"
log "未署名のため初回起動時は Finder で右クリック → 開く、または システム設定 > プライバシーとセキュリティ で許可が必要です。"
