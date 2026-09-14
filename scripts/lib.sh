#!/usr/bin/env bash
# Shared helpers for the wrapper scripts. Source, do not execute.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOKUJI_DIR="$ROOT/sokuji"
DIST_DIR="$ROOT/dist"

log() { printf '\033[1;34m[translate]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[translate] %s\033[0m\n' "$*" >&2; exit 1; }

json_field() {
  # json_field <file> <key>  — top-level string field, no jq dependency
  node -e 'const p=require(process.argv[1]);const v=p[process.argv[2]];if(v===undefined)process.exit(2);console.log(v)' "$1" "$2"
}

expected_sokuji_version() { json_field "$ROOT/package.json" sokujiVersion; }

require_submodule() {
  [ -f "$SOKUJI_DIR/package.json" ] || die "sokuji/ が空です。先に \`npm run setup\` を実行してください。"
}

check_sokuji_version() {
  require_submodule
  local expected actual
  expected="$(expected_sokuji_version)"
  actual="$(json_field "$SOKUJI_DIR/package.json" version)"
  [ "$expected" = "$actual" ] || die "sokuji の版がずれています: package.json の sokujiVersion=$expected, sokuji/package.json=$actual。docs/upgrade.md の手順で揃えてください。"
  local ext
  ext="$(json_field "$SOKUJI_DIR/extension/manifest.json" version)"
  [ "$expected" = "$ext" ] || die "sokuji/extension/manifest.json の版 ($ext) が $expected と一致しません。"
}
