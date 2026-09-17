import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'rex-harness-guide.html'), 'utf8');

for (const id of ['effective', 'modules', 'control', 'tdd', 'usage', 'aios', 'checklist']) {
  assert.match(html, new RegExp(`id=["']${id}["']`, 'u'), `missing section: ${id}`);
}

for (const file of [
  'rex-harness-architecture.svg',
  'rex-harness-control-loop.svg',
  'rex-harness-tdd-workflow.svg',
]) {
  const asset = path.join(root, 'assets', file);
  assert.ok(fs.existsSync(asset), `missing asset: ${file}`);
  assert.match(html, new RegExp(`assets/${file.replace('.', '\\.')}`, 'u'), `HTML does not use ${file}`);
  const svg = fs.readFileSync(asset, 'utf8');
  assert.match(svg, /data-generator="fireworks-tech-graph"/u, `${file} lacks semantic generator metadata`);
  assert.match(svg, /data-graph-role="edge"/u, `${file} lacks semantic edges`);
  assert.match(svg, /data-graph-role="node"/u, `${file} lacks semantic nodes`);
}

assert.doesNotMatch(html, /(?:src|href)=["']https?:\/\//u, 'guide must remain offline');
console.log('guide check: passed');
