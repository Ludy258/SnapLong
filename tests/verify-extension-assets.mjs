import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.dirname(testsDir);
const extensionDir = path.join(projectRoot, 'edge-extension');
const manifestPath = path.join(extensionDir, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

assert.equal(manifest.manifest_version, 3);
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(manifest.action.default_popup, 'popup/popup.html');
assert.equal(manifest.background.service_worker, 'background/service-worker.js');

const referencedFiles = [
  manifest.action.default_popup,
  manifest.background.service_worker,
  'background/offscreen.html',
  'background/offscreen.js',
  ...manifest.content_scripts.flatMap(script => script.js),
  ...Object.values(manifest.action.default_icon),
  ...Object.values(manifest.icons),
];

for (const relativePath of new Set(referencedFiles)) {
  assert.ok(fs.existsSync(path.join(extensionDir, relativePath)), `Missing extension asset: ${relativePath}`);
}

console.log('Extension asset checks passed.');
