#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";

const token = randomBytes(32).toString("base64url");
const hash = createHash("sha256").update(token).digest("hex");

console.log("Pairing token (enter in extension setup; keep secret):");
console.log(token);
console.log("");
console.log("SHA-256 for Cloudflare Worker secret PAIRING_TOKEN_SHA256:");
console.log(hash);
