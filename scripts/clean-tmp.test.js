const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanTmp } = require('./clean-tmp');

test('clean-tmp removes only stale scratch files and keeps reminder state', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-tmp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const old = (Date.now() - 20 * 86400000) / 1000;
  const write = (rel, stale) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x');
    if (stale) fs.utimesSync(p, old, old);
  };
  write('old-script.js', true);
  write('fresh-snapshot.json', false);
  write('remind-state.json', true);
  write('wechat-quota.json', true);
  write('old-run/a.png', true);
  write('mixed-run/old.json', true);
  write('mixed-run/new.json', false);
  fs.mkdirSync(path.join(dir, 'empty-active'));

  const preview = cleanTmp({ dir });
  assert.equal(preview.stale.length, 3);
  assert.ok(fs.existsSync(path.join(dir, 'old-script.js')), 'dry run deletes nothing');

  const r = cleanTmp({ dir, apply: true });
  assert.equal(r.removed, 3);
  const left = (rel) => fs.existsSync(path.join(dir, rel));
  assert.equal(left('old-script.js'), false);
  assert.equal(left('old-run'), false);
  assert.equal(left('mixed-run/old.json'), false);
  for (const rel of [
    'fresh-snapshot.json',
    'remind-state.json',
    'wechat-quota.json',
    'mixed-run/new.json',
    'empty-active',
  ])
    assert.ok(left(rel), rel + ' kept');
});
