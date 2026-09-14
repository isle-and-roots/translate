#!/usr/bin/env bash
# Build the Sokuji Chrome/Edge extension from the pinned sources.
#
# Output:
#   dist/extension/                       unpacked (chrome://extensions → 「パッケージ化されていない拡張機能を読み込む」)
#   dist/sokuji-extension-<version>.zip   same content, for keeping / copying to another Mac
#
# Production mode = the same flags upstream uses for store releases:
# analytics off (no PostHog key), Kizuna-managed providers off, so the
# build only offers bring-your-own-key providers such as OpenAI.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

check_sokuji_version
VERSION="$(expected_sokuji_version)"

[ -d "$SOKUJI_DIR/node_modules" ] && [ -d "$SOKUJI_DIR/extension/node_modules" ] \
  || die "依存が未インストールです。先に \`npm run setup\` を実行してください。"
[ -d "$SOKUJI_DIR/public/wasm/ort" ] || bash "$SOKUJI_DIR/scripts/copy-ort-wasm.sh"

log "拡張をビルド（production, Sokuji v$VERSION）"
cd "$SOKUJI_DIR/extension"
rm -rf dist
# Explicitly pin the flags so a stray sokuji/.env cannot switch analytics or
# managed providers back on.
POSTHOG_KEY="" \
VITE_ENABLE_KIZUNA_AI="false" \
VITE_ENABLE_KIZUNA_SONIOX="false" \
VITE_ENABLE_KIZUNA_OPENAI_TRANSLATE="false" \
VITE_ENABLE_KIZUNA_VOLCENGINE_AST2="false" \
NODE_ENV=production npx vite build --mode production

[ -f dist/manifest.json ] || die "ビルド成果物 (extension/dist/manifest.json) がありません。"

OUT_UNPACKED="$DIST_DIR/extension"
OUT_ZIP="$DIST_DIR/sokuji-extension-$VERSION.zip"
mkdir -p "$DIST_DIR"
rm -rf "$OUT_UNPACKED" "$OUT_ZIP"
cp -R dist "$OUT_UNPACKED"
(cd "$OUT_UNPACKED" && zip -qr -X "$OUT_ZIP" .)

bash "$ROOT/scripts/check.sh" --built

log "完了"
log "  unpacked: $OUT_UNPACKED"
log "  zip:      $OUT_ZIP ($(du -h "$OUT_ZIP" | cut -f1))"
log "Chrome → chrome://extensions → デベロッパーモード → 「パッケージ化されていない拡張機能を読み込む」→ dist/extension"
