const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, relativePath), "utf8"));
}

const manifest = readJson("manifest.json");
const packageJson = readJson("package.json");

assert.equal(manifest.manifest_version, 3, "manifest.json must remain Manifest V3");
assert.equal(
  packageJson.version,
  manifest.version,
  "package.json and manifest.json versions must match"
);

const referencedFiles = [
  manifest.action?.default_popup,
  ...(manifest.background?.scripts || []),
  ...manifest.content_scripts.flatMap(entry => [...(entry.js || []), ...(entry.css || [])])
].filter(Boolean);

for (const relativePath of referencedFiles) {
  assert.ok(
    fs.existsSync(path.join(projectRoot, relativePath)),
    `manifest.json references a missing file: ${relativePath}`
  );
}

console.log(`Validated Manifest V${manifest.manifest_version} release ${manifest.version}.`);

