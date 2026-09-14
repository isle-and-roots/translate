#!/usr/bin/env bash
# Sanity checks: pinned version consistency, and (with --built) that the
# extension bundle in dist/extension targets Google Meet and Zoom and carries
# the Sokuji virtual microphone / tab-capture plumbing we rely on.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BUILT=0
for arg in "$@"; do
  case "$arg" in
    --built) BUILT=1 ;;
    *) die "unknown option: $arg" ;;
  esac
done

check_sokuji_version
log "pin OK: sokuji v$(expected_sokuji_version) ($(git -C "$SOKUJI_DIR" rev-parse --short HEAD))"

[ "$BUILT" = 1 ] || exit 0

MANIFEST="$DIST_DIR/extension/manifest.json"
[ -f "$MANIFEST" ] || die "dist/extension/manifest.json がありません。\`npm run build:extension\` を先に実行してください。"

node - "$MANIFEST" "$(expected_sokuji_version)" <<'EOF'
const fs = require("node:fs");
const path = require("node:path");
const [manifestPath, expectedVersion] = process.argv.slice(2);
const dist = path.dirname(manifestPath);
const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const problems = [];

if (m.manifest_version !== 3) problems.push(`manifest_version=${m.manifest_version}`);
if (m.version !== expectedVersion) problems.push(`manifest version ${m.version} != ${expectedVersion}`);

const matches = (m.content_scripts ?? []).flatMap((cs) => cs.matches ?? []);
for (const host of ["https://meet.google.com/*", "https://app.zoom.us/*"]) {
  if (!matches.includes(host)) problems.push(`content_scripts に ${host} がありません`);
}
const perms = m.permissions ?? [];
for (const p of ["tabCapture", "sidePanel", "storage"]) {
  if (!perms.includes(p)) problems.push(`permission ${p} がありません`);
}
for (const file of ["background.js", "content.js", "zoom-content.js", "popup.html", "fullpage.html"]) {
  if (!fs.existsSync(path.join(dist, file))) problems.push(`${file} がありません`);
}
// Analytics must be off in our build: production mode leaves the key empty.
const bundle = fs.readdirSync(path.join(dist, "assets")).filter((f) => f.endsWith(".js"));
const posthogKeyPattern = /phc_[A-Za-z0-9]{20,}/;
for (const f of bundle) {
  if (posthogKeyPattern.test(fs.readFileSync(path.join(dist, "assets", f), "utf8"))) {
    problems.push(`assets/${f} に PostHog キーが埋め込まれています（analytics が無効になっていません）`);
  }
}

if (problems.length) {
  console.error("[translate] 検査に失敗:\n - " + problems.join("\n - "));
  process.exit(1);
}
console.log(`[translate] bundle OK: v${m.version}, Meet/Zoom content scripts, tabCapture, analytics off`);
EOF
