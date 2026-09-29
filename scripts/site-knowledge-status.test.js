'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, 'site-knowledge-status.js');

function run(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'site-knowledge-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name), body, 'utf8');
  const r = spawnSync(process.execPath, [script, `--root=${root}`, '--as-of=2026-10-22', '--json'], { encoding: 'utf8' });
  return { ...r, json: r.stdout ? JSON.parse(r.stdout) : null };
}

test('classifies fresh, stale and historical knowledge', () => {
  const r = run({
    'fresh.md': '- knowledge_status: verified\n- last_verified: 2026-10-01\n- stale_after_days: 30\n',
    'stale.md': '- knowledge_status: verified\n- last_verified: 2026-09-01\n- stale_after_days: 30\n',
    'history.md': '- knowledge_status: historical\n- last_verified: 2026-09-01\n- stale_after_days: 30\n'
  });
  assert.equal(r.status, 0);
  assert.deepEqual(r.json.summary, { total: 3, fresh: 1, stale: 1, candidate: 0, historical: 1, invalid: 0 });
});

test('candidate knowledge is visible but does not fail metadata validation', () => {
  const r = run({ 'candidate.md': '- knowledge_status: candidate\n' });
  assert.equal(r.status, 0);
  assert.equal(r.json.entries[0].freshness, 'candidate');
});

test('verified knowledge fails closed when expiry metadata is missing', () => {
  const r = run({ 'bad.md': '- knowledge_status: verified\n- last_verified: 2026-10-01\n' });
  assert.equal(r.status, 1);
  assert.equal(r.json.summary.invalid, 1);
  assert.match(r.json.entries[0].errors.join(' '), /stale_after_days/);
});
