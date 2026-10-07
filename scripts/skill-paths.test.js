'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { targetSkillsRoot } = require('../lib/skill-paths');

test('Codex canonical workspace source needs no invented client junction', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-source-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, '.agents', 'skills'), { recursive: true });
  const result = targetSkillsRoot(root, 'codex');
  assert.equal(result.root, path.join(root, '.agents', 'skills'));
  assert.equal(result.runtime_loading, 'unverified');
  assert.equal(fs.existsSync(path.join(root, '.codex')), false);
});

test('explicit client skills directory is preserved and unrelated clients do not silently fall back', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-configured-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, '.codex', 'skills'), { recursive: true });
  assert.equal(targetSkillsRoot(root, 'codex').root, path.join(root, '.codex', 'skills'));
  assert.equal(
    targetSkillsRoot(root, 'another-client').root,
    path.join(root, '.another-client', 'skills')
  );
});
