const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createStore } = require('../dashboard/store');
const { backup, redact, isIdCard } = require('./backup-tracker');

test('redact masks secret URL params and valid ID numbers but keeps job links and IDs', () => {
  const id = '11010519491231002X'; // public GB 11643 sample number
  assert.equal(isIdCard(id), true);
  assert.equal(isIdCard('617123456789012349'), false);
  const text = [
    'https://app.mokahr.com/apply/acme/123#/job/abc?token=s3cret&lang=zh',
    'https://exam.example.com/start?inviteCode=XYZ123&id=42',
    'job 617123456789012349',
    'id ' + id,
  ].join('\n');
  const out = redact(text);
  assert.match(out, /token=REDACTED&lang=zh/);
  assert.match(out, /inviteCode=REDACTED&id=42/);
  assert.match(out, /job 617123456789012349/);
  assert.doesNotMatch(out, /s3cret|XYZ123|11010519491231002X/);
  assert.match(out, /1101\*{10}002X/);
});

test('backup commits only tracker-backup and is a no-op when nothing changed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const repo = path.join(root, 'repo');
  const store = createStore(data);
  store.initialize({
    job_pool: [
      {
        job_id: 'j1',
        company: 'Co',
        job_title: 'T',
        status: 'Pending',
        job_url: 'https://x/?token=abc',
      },
    ],
    application_log: [],
    follow_up: [],
    sync_queue: [],
  });
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  fs.mkdirSync(repo);
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'wip');
  git('add', 'unrelated.txt'); // staged work that must not be swept into the backup commit

  const first = backup({ data, repo });
  assert.equal(first.committed, true);
  const files = git('show', '--name-only', '--format=', 'HEAD').trim().split('\n');
  assert.ok(
    files.every((f) => f.startsWith('tracker-backup/')),
    files.join(',')
  );
  assert.ok(files.includes('tracker-backup/job_pool.csv'));
  const saved = fs.readFileSync(path.join(repo, 'tracker-backup/job_pool.csv'), 'utf8');
  assert.match(saved, /token=REDACTED/);
  assert.match(git('status', '--short'), /^A  unrelated\.txt/m);

  assert.equal(backup({ data, repo }).committed, false);
});

test('backup skips quietly when the backup repository is missing', () => {
  const r = backup({ repo: path.join(os.tmpdir(), 'cw-no-such-repo-' + process.pid) });
  assert.match(r.skipped, /not found/);
});
