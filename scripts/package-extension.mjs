#!/usr/bin/env node
/**
 * Zip extension/dist into dist/<name>-<version>.zip for distribution
 * (chrome://extensions "load unpacked" after unzip, or Chrome Web Store upload).
 * Run `npm run build` first.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = join(root, "extension", "dist");
const outDir = join(root, "dist");

const manifestPath = join(distDir, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error("extension/dist/manifest.json not found. Run `npm run build` first.");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const brokerHost = (manifest.host_permissions ?? []).find((p) =>
  /workers\.dev|YOUR-BROKER/.test(p),
);
if (!brokerHost || brokerHost.includes("YOUR-BROKER")) {
  console.error(
    "Broker URL is still the placeholder. Rebuild with BROKER_BASE_URL=https://<your>.workers.dev before packaging.",
  );
  process.exit(1);
}

const slug = String(manifest.name).toLowerCase().replace(/[^a-z0-9]+/g, "-");
const zipPath = join(outDir, `${slug}-${manifest.version}.zip`);

mkdirSync(outDir, { recursive: true });
rmSync(zipPath, { force: true });

const result = spawnSync("zip", ["-r", "-X", zipPath, ".", "-x", "*.map"], {
  cwd: distDir,
  stdio: "inherit",
});
if (result.error || result.status !== 0) {
  console.error("zip failed. Install the `zip` CLI (preinstalled on macOS).");
  process.exit(result.status ?? 1);
}

console.log(`Packaged ${zipPath}`);
