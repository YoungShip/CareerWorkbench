const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { diffSkills, copySkills, SKILL_NAMES } = require('./skills-sync');

test('repository skills/ holds all three skills and the trusted matching validator', () => {
  const root = path.join(__dirname, '..', 'skills');
  for (const name of SKILL_NAMES) assert.ok(fs.existsSync(path.join(root, name, 'SKILL.md')), name);
  assert.ok(fs.existsSync(path.join(root, 'campus-recruitment/scripts/verify-matching.py')));
});

test('skills sync detects drift, ignores CRLF and caches, and copies both ways', (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-skills-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, 'repo'),
    installed = path.join(base, 'installed');
  const put = (root, rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  for (const name of SKILL_NAMES) {
    put(repo, name + '/SKILL.md', 'a\nb\n');
    put(installed, name + '/SKILL.md', 'a\r\nb\r\n');
  }
  put(installed, 'campus-recruitment/scripts/__pycache__/x.pyc', 'bin');
  assert.equal(diffSkills({ repo, installed }).in_sync, true);

  put(installed, 'offernotes-sync/SKILL.md', 'a\nchanged\n');
  put(installed, 'offernotes-sync/references/new.md', 'n');
  put(repo, 'job-application-form-filling/old.md', 'o');
  const d = diffSkills({ repo, installed });
  assert.deepEqual(d.changed, ['offernotes-sync/SKILL.md']);
  assert.deepEqual(d.onlyInstalled, ['offernotes-sync/references/new.md']);
  assert.deepEqual(d.onlyRepo, ['job-application-form-filling/old.md']);

  copySkills(installed, repo); // capture
  assert.equal(diffSkills({ repo, installed }).in_sync, true);
  assert.equal(fs.existsSync(path.join(repo, 'job-application-form-filling/old.md')), false);
  assert.equal(fs.existsSync(path.join(repo, 'campus-recruitment/scripts/__pycache__')), false);
});

test('diffAgents flags missing or differing AGENTS.md copies and ignores CRLF', () => {
  const { diffAgents } = require('./skills-sync');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-copies-'));
  try {
    const src = path.join(dir, 'src.md'),
      same = path.join(dir, 'same.md'),
      other = path.join(dir, 'other.md');
    fs.writeFileSync(src, '# 规则\n第一条\n');
    fs.writeFileSync(same, '# 规则\r\n第一条\r\n');
    fs.writeFileSync(other, '# 规则\n旧条文\n');
    assert.deepEqual(diffAgents({ source: src, copies: [same] }), {
      in_sync: true,
      differing: [],
      missing: [],
    });
    const d = diffAgents({ source: src, copies: [same, other, path.join(dir, 'none.md')] });
    assert.equal(d.in_sync, false);
    assert.deepEqual(d.differing, [other]);
    assert.equal(d.missing.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
