import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
  assert.ok(!pkg[field] || Object.keys(pkg[field]).length === 0, `${field} must remain empty`);
}
assert.equal(fs.existsSync(path.join(root, "node_modules")), false, "Repository must not contain node_modules");
assert.equal(fs.existsSync(path.join(root, "package-lock.json")), false, "Repository must not require a lockfile");

const vendorDir = path.join(root, "vendor", "acorn");
const vendorPackage = JSON.parse(fs.readFileSync(path.join(vendorDir, "package.json"), "utf8"));
assert.equal(vendorPackage.name, "acorn");
assert.equal(vendorPackage.version, "8.15.0");
assert.equal(vendorPackage.license, "MIT");
assert.match(String(vendorPackage.repository?.url || ""), /github\.com\/acornjs\/acorn/);

const parserBytes = fs.readFileSync(path.join(vendorDir, "acorn.mjs"));
const parserHash = crypto.createHash("sha256").update(parserBytes).digest("hex");
assert.equal(parserHash, "b4c8c70200e72bae33cf1085e0ecb1e792c1b6924ed50cab817caf14f51bb249");
assert.match(fs.readFileSync(path.join(vendorDir, "LICENSE"), "utf8"), /Permission is hereby granted, free of charge/i);
assert.match(fs.readFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8"), /Acorn 8\.15\.0/);

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
assert.equal(manifest.content_security_policy.extension_pages.includes("'self'"), true);
assert.equal(/https?:\/\//.test(manifest.content_security_policy.extension_pages), false);

const sourceFiles = [
  "background/tools/script-parser.js",
  "background/tools/execute-script.js",
  "background/tools/debugger-session.js"
];
for (const relative of sourceFiles) {
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  assert.doesNotMatch(source, /from\s+["']https?:\/\//, `${relative} must not import remote code`);
}

console.log("Zero-dependency packaging tests passed: no node_modules, no dependency fields, pinned local Acorn 8.15.0, MIT license, provenance, checksum, and self-only extension CSP.");
