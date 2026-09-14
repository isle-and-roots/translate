#!/usr/bin/env node
import * as esbuild from "esbuild";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "extension", "dist");

const brokerUrl =
  process.env.BROKER_BASE_URL ?? "https://YOUR-BROKER.workers.dev";
const extensionKey = process.env.EXTENSION_KEY; // optional PEM for stable ID

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const entryPoints = [
  "background.ts",
  "offscreen.ts",
  "popup.ts",
  "setup.ts",
  "control.ts",
].map((name) => join(root, "extension", "src", name));

await esbuild.build({
  entryPoints,
  bundle: true,
  outdir: outDir,
  format: "esm",
  platform: "browser",
  target: ["chrome116"],
  sourcemap: true,
  logLevel: "info",
});

for (const file of [
  "popup.html",
  "setup.html",
  "control.html",
  "offscreen.html",
]) {
  copyFileSync(join(root, "extension", file), join(outDir, file));
}

cpSync(join(root, "extension", "styles"), join(outDir, "styles"), {
  recursive: true,
});
cpSync(join(root, "extension", "icons"), join(outDir, "icons"), {
  recursive: true,
});

// Keep in sync with detectTabPlatform() in shared/platform.ts.
const meetingHostPermissions = [
  "https://meet.google.com/*",
  "https://zoom.us/*",
  "https://*.zoom.us/*",
  "https://zoom.com/*",
  "https://*.zoom.com/*",
  "https://zoomgov.com/*",
  "https://*.zoomgov.com/*",
];

const manifest = {
  manifest_version: 3,
  name: "Meet Interpreter",
  description:
    "Google Meet / Zoom English↔Japanese bidirectional interpreter via OpenAI realtime translate",
  version: "0.2.0",
  minimum_chrome_version: "116",
  permissions: ["activeTab", "tabCapture", "offscreen", "storage"],
  host_permissions: [
    ...meetingHostPermissions,
    `${brokerUrl.replace(/\/$/, "")}/*`,
    "https://api.openai.com/*",
  ],
  background: {
    service_worker: "background.js",
    type: "module",
  },
  action: {
    default_popup: "popup.html",
    default_title: "Meet Interpreter",
    default_icon: {
      16: "icons/icon16.png",
      32: "icons/icon32.png",
      48: "icons/icon48.png",
      128: "icons/icon128.png",
    },
  },
  options_page: "setup.html",
  icons: {
    16: "icons/icon16.png",
    32: "icons/icon32.png",
    48: "icons/icon48.png",
    128: "icons/icon128.png",
  },
  content_security_policy: {
    extension_pages:
      `script-src 'self'; object-src 'self'; connect-src https://api.openai.com ${brokerUrl.replace(/\/$/, "")}`,
  },
};

if (extensionKey) {
  manifest.key = extensionKey;
}

writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// Rewrite HTML script paths are already relative to dist root.
console.log(`Built extension to ${outDir}`);
console.log(`Broker URL: ${brokerUrl}`);
