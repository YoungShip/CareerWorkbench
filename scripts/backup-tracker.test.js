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
  assert.match(out, /exam\.example\.com\/start\?REDACTED/);
  assert.match(out, /job 617123456789012349/);
  assert.doesNotMatch(out, /s3cret|XYZ123|11010519491231002X/);
  assert.match(out, /1101\*{10}002X/);
});

test('redact hides assessment links, ATS candidate params and exam account numbers', () => {
  const text = [
    '测评链接为专属地址勿转发：https://acme.ceping.com/Login/Index?ald=abcdef0123456789&x=1',
    '专属链接：https://foo.ceping.com/m/login?elink=Zx9y8w7v6u5t4s3r2q1p',
    '申请页 https://app.mokahr.com/apply/acme/1#/candidateHome?candidateName=%E6%9D%A8',
    '通行证12260515152671，准考证号：AB123456',
    '岗位 https://job.example.com/detail?jobAdId=1234-5678&locale=zh',
  ].join('\n');
  const out = redact(text);
  assert.match(out, /https:\/\/acme\.ceping\.com\/Login\/Index\?REDACTED/);
  assert.match(out, /https:\/\/foo\.ceping\.com\/m\/login\?REDACTED/);
  assert.match(out, /candidateName=REDACTED/);
  assert.match(out, /通行证REDACTED，准考证号：REDACTED/);
  assert.match(out, /jobAdId=1234-5678&locale=zh/);
  assert.doesNotMatch(out, /abcdef0123|Zx9y8w|12260515152671|AB123456/);
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

test('backup push first replays local commits on top of newer remote commits', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-backup-remote-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
  const ident = (cwd) => {
    sh(cwd, 'config', 'user.email', 't@example.com');
    sh(cwd, 'config', 'user.name', 't');
  };
  const origin = path.join(root, 'origin.git');
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const mine = path.join(root, 'mine');
  sh(root, 'clone', '-q', origin, mine);
  ident(mine);
  sh(mine, 'switch', '-q', '-c', 'main');
  fs.writeFileSync(path.join(mine, 'README.md'), 'cv');
  sh(mine, 'add', 'README.md');
  sh(mine, 'commit', '-q', '-m', 'init');
  sh(mine, 'push', '-q', '-u', 'origin', 'main');
  // another tool pushes research to the same repository
  const other = path.join(root, 'other');
  sh(root, 'clone', '-q', origin, other);
  ident(other);
  fs.writeFileSync(path.join(other, 'research.md'), 'new research');
  sh(other, 'add', 'research.md');
  sh(other, 'commit', '-q', '-m', 'research');
  sh(other, 'push', '-q', 'origin', 'main');
  // uncommitted local work must survive the rebase
  fs.writeFileSync(path.join(mine, 'README.md'), 'cv edited');

  const data = path.join(root, 'data');
  createStore(data).initialize({
    job_pool: [{ job_id: 'j1', company: 'Co', job_title: 'T', status: 'Pending' }],
    application_log: [],
    follow_up: [],
    sync_queue: [],
  });
  const r = backup({ data, repo: mine, push: true, proxy: '' });
  assert.equal(r.committed, true);
  assert.equal(r.pushed, 'direct');
  const log = sh(origin, 'log', '--format=%s', 'main');
  assert.match(log, /主表备份/);
  assert.match(log, /research/);
  assert.equal(fs.readFileSync(path.join(mine, 'research.md'), 'utf8'), 'new research');
  assert.equal(fs.readFileSync(path.join(mine, 'README.md'), 'utf8'), 'cv edited');
});
