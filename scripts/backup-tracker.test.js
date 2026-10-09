const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createStore } = require('../dashboard/store');
// 默认不镜像本机证据目录；证据镜像单独测试
process.env.JOBHUNT_EVIDENCE_DIR = path.join(os.tmpdir(), 'cw-no-evidence-' + process.pid);
process.env.JOBHUNT_DISCOVERY_DIR = path.join(os.tmpdir(), 'cw-no-discovery-' + process.pid);
process.env.JOBHUNT_WORKSPACE_DIR = path.join(os.tmpdir(), 'cw-no-workspace-' + process.pid);
const {
  backup,
  redact,
  findLeaks,
  isIdCard,
  evidenceFiles,
  referencedTmpEntries,
} = require('./backup-tracker');

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
  assert.match(out, /exam\.example\.com\/REDACTED/);
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
  assert.match(out, /https:\/\/acme\.ceping\.com\/REDACTED/);
  assert.match(out, /https:\/\/foo\.ceping\.com\/REDACTED/);
  assert.match(out, /candidateName=REDACTED/);
  assert.match(out, /通行证REDACTED，准考证号：REDACTED/);
  assert.match(out, /jobAdId=1234-5678&locale=zh/);
  assert.doesNotMatch(out, /abcdef0123|Zx9y8w|12260515152671|AB123456/);
});

// [输入, 输出里不能再出现的片段]。所有样例都是编造的，不要换成真实数据：本仓库公开
const MUST_HIDE = [
  [
    '测评链接为私人专属地址勿转发：https://c.duomian.com/jump/route/test/a1b2c3/token9xyz，截止10-31',
    'token9xyz',
  ],
  ['在 https://acmcoder.cn/abc1234 预约', 'abc1234'],
  ['笔试 https://www.showmebug.com/written_pads/ABCDEF 已推迟', 'ABCDEF'],
  ['笔试链接 www.showmebug.com/written_pads/QWERTY', 'QWERTY'],
  ['HTTPS://c.duomian.com/jump/tok9abc', 'tok9abc'],
  ['https://demo.ceping.com:443/pc?foo=Q1W2E3', 'Q1W2E3'],
  ['https://demo.ceping.com/测评/Elink9abc?ald=1', 'Elink9abc'],
  ['面试 https://meet.example.com/interview/room-8f3k2 进入', 'room-8f3k2'],
  ['https://app.mokahr.com/m/candidate/acme#/interview/xyz123/detail', 'xyz123'],
  ['https://x.example.com/exam?eid=Q1W2E3R4', 'Q1W2E3R4'],
  ['https://zoom.us/j/81234567890?pwd=AbCdEf', '81234567890'],
  ['https://x.hotjob.cn/wt/a!list?brandCode=1&operational=d7d0a1b2c3fb', 'd7d0a1b2c3fb'],
  ['https://x.example.com/a?accessToken=eyJhbGciOi', 'eyJhbGciOi'],
  ['https://x.example.com/a?x-token=abc123def', 'abc123def'],
  ['https://x.example.com/login?mobile=13800001111', '00001111'],
  ['https://x.example.com/a;jsessionid=ABCDEF0123', 'ABCDEF0123'],
  ['笔试账号：user2026 密码：Xy12ab!c', 'Xy12ab'],
  ['短信验证码：384920', '384920'],
  ['candidateId=1000001；resumeId=1000002；apply_id=1000003', '1000002'],
  ['Candidate ID: 1000004', '1000004'],
  ['POST /api/delivery/submit?idJobObjective=1000005 返回', '1000005'],
  ['简历编号100006，申请ID 1000007，申请编号为100000000008', '1000007'],
  ['帐号：user2026；用户名 user_01', 'user2026'],
  ['准考证号：2026 0001 0009', '0001 0009'],
  ['candidateId＝1000010', '1000010'],
  ['HR微信：zhang_hr2026；微信号 wxid_ab12cd34ef', 'wxid_ab12cd34ef'],
  ['HR QQ：123456789', '123456789'],
  ['HR 联系方式：王某某 +8613800002222（两封邮件一致）', '00002222'],
  ['手机 1380 000 3333 或 138.0000.3333', '000 3333'],
  ['手机１３８０００００４４４', '00004444'],
  ['发件邮箱 alice2000@qq.com，HR zhangsan@example-corp.com', 'alice2000'],
  ['HR 邮箱 hr.lisi@example-corp.com', 'lisi'],
  ['身份证号：110105199901011230', '110105199901011230'],
  ['身份证 110105********123X', '110105'],
  ['身份证 110105 19491231 002X', '19491231'],
  ['现住址：某省某市某某路88号', '某某路88号'],
  ['大使推荐+AB12CDE', 'AB12CDE'],
];

// 恢复主表需要的公开信息必须原样保留
const MUST_KEEP = [
  'https://www.nowcoder.com/jobs/detail/123456?source=1',
  'https://www.nowcoder.com/exam/oj/ta?tpId=408',
  'http://redcampus.acmcoder.com/cand/login，120分钟',
  'https://acme.jobs.feishu.cn/campus/position/7000000000000000001/detail',
  'https://jobs.example.com/position/13912345678/detail 编号保留',
  'https://www.example.com/join/recruit/test/140.html',
  'https://example.com/employ/campus/interviewguide/index.html',
  '投递邮箱 hr@example.com、acmezhaopin@online.example.com、acmehr@mail.joinus.cc、acme-no-reply@mail.mokahr.com、campus@example.com',
  '校招实际邮箱投递abc@example.com',
  '用账号 Playwright 自动化；验证码由本人完成；账号及密码在预约后可见',
  'OfferNotes 记录 abcqqxyz1234567',
  '岗位编号A0001；QQ邮箱登录',
];

test('redact hides exam links, credentials, account IDs and personal contacts', () => {
  for (const [input, secret] of MUST_HIDE) {
    const out = redact(input);
    assert.ok(!out.includes(secret), `${input} -> ${out}`);
    assert.equal(redact(out), out, 'idempotent: ' + input);
  }
  assert.match(redact('HR 联系方式：王某某 +8613800002222'), /王某 \+86138\*{8}/);
  assert.match(
    redact('https://c.duomian.com/jump/x1y2z3，截止10-31'),
    /^https:\/\/c\.duomian\.com\/REDACTED，截止10-31$/
  );
  assert.match(
    redact('评估中;choice_id=100011，apply_id=100012，2026-10-02 08:35'),
    /choice_id=REDACTED，apply_id=REDACTED，2026-10-02 08:35/
  );
  assert.match(
    redact('https://x.com/a?code=ABC123，截止10-31日前'),
    /code=REDACTED，截止10-31日前/
  );
});

test('redact keeps public job links, recruiting mailboxes and ordinary notes', () => {
  for (const text of MUST_KEEP) assert.equal(redact(text), text);
});

test('redact stays fast on long lines without separators', () => {
  const started = Date.now();
  for (const s of [
    'a'.repeat(200000),
    'a.'.repeat(100000),
    '1'.repeat(200000),
    '账号' + 'a1'.repeat(100000),
  ])
    redact(s);
  assert.ok(Date.now() - started < 2000);
});

test('findLeaks flags what redaction must never let through', () => {
  assert.deepEqual(findLeaks(redact(MUST_HIDE.map(([input]) => input).join('\n'))), []);
  assert.deepEqual(findLeaks('https://acmcoder.cn/abc1234'), ['测评链接']);
  assert.deepEqual(findLeaks('?operational=d7d0a1'), ['链接凭据']);
  assert.deepEqual(findLeaks('alice2000@qq.com'), ['个人邮箱']);
  assert.deepEqual(findLeaks('电话 13800005555'), ['手机号']);
  assert.deepEqual(findLeaks('11010519491231002X'), ['身份证号']);
  assert.deepEqual(findLeaks('https://jobs.example.com/position/13912345678/detail'), []);
});

function trackerData(root, row = {}) {
  const data = path.join(root, 'data');
  createStore(data).initialize({
    job_pool: [
      {
        job_id: 'j1',
        company: 'Co',
        job_title: 'T',
        status: 'Pending',
        job_url: 'https://x/?token=abc',
        ...row,
      },
    ],
    application_log: [],
    follow_up: [],
    sync_queue: [],
  });
  return data;
}
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
function ident(cwd) {
  sh(cwd, 'config', 'user.email', 't@example.com');
  sh(cwd, 'config', 'user.name', 't');
}
// origin（裸仓库）+ 本人的 lapis-cv 克隆
function remoteSetup(root) {
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
  return { origin, mine };
}

test('backup commits only tracker-backup in its own worktree and leaves the user tree alone', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-backup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = trackerData(root);
  const repo = path.join(root, 'repo'),
    worktree = path.join(root, 'wt');
  fs.mkdirSync(repo);
  sh(repo, 'init', '-q');
  ident(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'cv');
  sh(repo, 'add', 'README.md');
  sh(repo, 'commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'wip');
  sh(repo, 'add', 'unrelated.txt'); // staged work must stay exactly as it is

  const first = backup({ data, repo, worktree, redactTracker: true });
  assert.equal(first.committed, true);
  const files = sh(worktree, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n');
  assert.ok(
    files.every((f) => f.startsWith('tracker-backup/')),
    files.join(',')
  );
  assert.match(
    fs.readFileSync(path.join(worktree, 'tracker-backup/job_pool.csv'), 'utf8'),
    /token=REDACTED/
  );
  assert.equal(sh(repo, 'status', '--short'), 'A  unrelated.txt\n');
  assert.equal(fs.existsSync(path.join(repo, 'tracker-backup')), false);
  assert.equal(backup({ data, repo, worktree, redactTracker: true }).committed, false);
  // 默认原样备份：同一份主表不再打码，生成一次新提交
  assert.equal(backup({ data, repo, worktree }).committed, true);
  assert.doesNotMatch(
    fs.readFileSync(path.join(worktree, 'tracker-backup/job_pool.csv'), 'utf8'),
    /REDACTED/
  );
});

test('backup skips quietly when the backup repository is missing', () => {
  const r = backup({ repo: path.join(os.tmpdir(), 'cw-no-such-repo-' + process.pid) });
  assert.match(r.skipped, /not found/);
});

test('backup push lands on top of newer remote commits without touching a dirty user tree', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-backup-remote-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { origin, mine } = remoteSetup(root);
  // another session pushes research and edits the same shared file the user is editing
  const other = path.join(root, 'other');
  sh(root, 'clone', '-q', origin, other);
  ident(other);
  fs.writeFileSync(path.join(other, 'research.md'), 'new research');
  fs.writeFileSync(path.join(other, 'README.md'), 'cv from another session');
  sh(other, 'add', '.');
  sh(other, 'commit', '-q', '-m', 'research');
  sh(other, 'push', '-q', 'origin', 'main');
  fs.writeFileSync(path.join(mine, 'README.md'), 'cv edited locally');

  const data = trackerData(root);
  const worktree = path.join(root, 'wt');
  const r = backup({ data, repo: mine, worktree, push: true, proxy: '' });
  assert.equal(r.committed, true);
  assert.equal(r.pushed, 'direct');
  const log = sh(origin, 'log', '--format=%s', 'main');
  assert.match(log, /主表备份/);
  assert.match(log, /research/);
  // the user's tree is untouched: no stash, no merge, no conflict markers
  assert.equal(fs.readFileSync(path.join(mine, 'README.md'), 'utf8'), 'cv edited locally');
  assert.equal(sh(mine, 'stash', 'list'), '');
  assert.equal(sh(mine, 'status', '--short'), ' M README.md\n');
  // a second run with nothing new is a no-op
  const again = backup({ data, repo: mine, worktree, push: true, proxy: '' });
  assert.deepEqual([again.committed, again.pushed], [false, 'up-to-date']);
});

test('backup rebuilds its snapshot when the remote moved after its last commit', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-backup-moved-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { origin, mine } = remoteSetup(root);
  const worktree = path.join(root, 'wt');
  backup({ data: trackerData(root), repo: mine, worktree, push: true, proxy: '' });
  const other = path.join(root, 'other');
  sh(root, 'clone', '-q', origin, other);
  ident(other);
  fs.writeFileSync(path.join(other, 'later.md'), 'later');
  sh(other, 'add', '.');
  sh(other, 'commit', '-q', '-m', 'later');
  sh(other, 'push', '-q', 'origin', 'main');
  fs.rmSync(path.join(root, 'data'), { recursive: true });
  const r = backup({
    data: trackerData(root, { status: 'Submitted' }),
    repo: mine,
    worktree,
    push: true,
    proxy: '',
  });
  assert.equal(r.pushed, 'direct');
  const subjects = sh(origin, 'log', '--format=%s', 'main').trim().split('\n');
  assert.match(subjects[0], /主表备份/);
  assert.equal(subjects[1], 'later');
  assert.match(sh(origin, 'show', 'main:tracker-backup/job_pool.csv'), /Submitted/);
});

test('backup retries once on top of the new remote when its push is rejected', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-backup-race-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { origin, mine } = remoteSetup(root);
  // the first push is rejected, as if another session had just pushed
  const marker = path.join(root, 'rejected-once');
  const hook = path.join(origin, 'hooks', 'pre-receive');
  fs.writeFileSync(
    hook,
    `#!/bin/sh\nif [ ! -f "${marker}" ]; then touch "${marker}"; echo busy >&2; exit 1; fi\nexit 0\n`
  );
  fs.chmodSync(hook, 0o755);
  const r = backup({
    data: trackerData(root),
    repo: mine,
    worktree: path.join(root, 'wt'),
    push: true,
    proxy: '',
  });
  assert.equal(r.pushed, 'direct');
  assert.ok(fs.existsSync(marker));
  assert.match(sh(origin, 'log', '-1', '--format=%s', 'main'), /主表备份/);
});

test('private evidence is mirrored unredacted, with exclusions and deletions', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-backup-evidence-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = trackerData(root);
  const evidence = path.join(root, 'private');
  const put = (rel, text = 'x') => {
    fs.mkdirSync(path.dirname(path.join(evidence, rel)), { recursive: true });
    fs.writeFileSync(path.join(evidence, rel), text);
  };
  // 合成数据
  put(
    'applications/job_1/submission-evidence.md',
    '测评链接 https://exam.example.com/t/abc 原样保留'
  );
  put('site-knowledge/example-ats.md', 'notes');
  put('reassessments/run/__pycache__/x.pyc');
  put('reassessments/run/result.json', '{}');
  put('playwright-application/chrome-profile/Cookies', 'secret');
  put('secrets/key.json', 'secret');
  put('publication-20260930/wheel/a.py');
  put('backup-worktree/tracker-backup/job_pool.csv');
  put('README.md', 'top-level file');
  put('applications/' + 'd'.repeat(160) + '/f.txt');
  assert.deepEqual(evidenceFiles(evidence).files.sort(), [
    'applications/job_1/submission-evidence.md',
    'reassessments/run/result.json',
    'site-knowledge/example-ats.md',
  ]);
  assert.equal(evidenceFiles(evidence).skipped.length, 1);

  const repo = path.join(root, 'repo'),
    worktree = path.join(root, 'wt');
  fs.mkdirSync(repo);
  sh(repo, 'init', '-q');
  ident(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'cv');
  sh(repo, 'add', 'README.md');
  sh(repo, 'commit', '-q', '-m', 'init');

  const first = backup({ data, repo, worktree, evidence });
  assert.equal(first.committed, true);
  assert.equal(first.evidence.files, 3);
  const tracked = sh(worktree, 'ls-files').trim().split('\n');
  assert.ok(tracked.includes('private-evidence/applications/job_1/submission-evidence.md'));
  assert.ok(!tracked.some((f) => /playwright|secrets|publication|backup-worktree|pyc/.test(f)));
  assert.match(
    fs.readFileSync(
      path.join(worktree, 'private-evidence/applications/job_1/submission-evidence.md'),
      'utf8'
    ),
    /exam\.example\.com\/t\/abc/
  );
  assert.equal(backup({ data, repo, worktree, evidence }).committed, false);

  fs.rmSync(path.join(evidence, 'site-knowledge'), { recursive: true });
  put('applications/job_1/submission-evidence.md', 'updated');
  assert.equal(backup({ data, repo, worktree, evidence }).committed, true);
  const after = sh(worktree, 'ls-files').trim().split('\n');
  assert.ok(!after.some((f) => f.startsWith('private-evidence/site-knowledge')));
  assert.equal(fs.existsSync(path.join(worktree, 'private-evidence/site-knowledge')), false);
  assert.match(sh(worktree, 'log', '-1', '--format=%s'), /含私有证据/);
});

test('local-only workspace data is mirrored: discovery, referenced lapis-cv tmp dirs, root files', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-backup-local-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const put = (rel, text = 'x') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  // 合成数据
  const data = trackerData(root, {
    matching_file: 'D:\\ws\\lapis-cv\\tmp\\acme-20260912\\matching.json',
    research_file: 'D:/ws/lapis-cv/tmp/report-acme.md',
  });
  assert.deepEqual([...referencedTmpEntries(createStore(data).snapshot().tables.job_pool)].sort(), [
    'acme-20260912',
    'report-acme.md',
  ]);
  put('ws/discovery/leads.json', '[]');
  put('ws/discovery/runs/r1/log.txt');
  put('ws/tmp/acme-20260912/matching.json', '{}');
  put('ws/tmp/acme-20260912/jd/1.txt');
  put('ws/tmp/report-acme.md');
  put('ws/tmp/unreferenced-20260901/big.json');
  put('ws/root/工作日志.md', 'log');
  put('ws/root/.mcp.json', '{}');
  put('ws/root/project/src.c');

  const repo = path.join(root, 'repo'),
    worktree = path.join(root, 'wt');
  fs.mkdirSync(repo);
  sh(repo, 'init', '-q');
  ident(repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'cv');
  sh(repo, 'add', 'README.md');
  sh(repo, 'commit', '-q', '-m', 'init');

  const opts = {
    data,
    repo,
    worktree,
    discovery: path.join(root, 'ws/discovery'),
    lapisTmp: path.join(root, 'ws/tmp'),
    workspace: path.join(root, 'ws/root'),
  };
  const r = backup(opts);
  assert.equal(r.committed, true);
  assert.deepEqual(Object.fromEntries(Object.entries(r.local).map(([k, v]) => [k, v.files])), {
    discovery: 2,
    'lapis-cv-tmp': 3,
    'workspace-root': 1,
  });
  const tracked = sh(worktree, '-c', 'core.quotepath=false', 'ls-files', 'local-backup')
    .trim()
    .split('\n')
    .sort();
  assert.deepEqual(tracked, [
    'local-backup/discovery/leads.json',
    'local-backup/discovery/runs/r1/log.txt',
    'local-backup/lapis-cv-tmp/acme-20260912/jd/1.txt',
    'local-backup/lapis-cv-tmp/acme-20260912/matching.json',
    'local-backup/lapis-cv-tmp/report-acme.md',
    'local-backup/workspace-root/工作日志.md',
  ]);
  assert.equal(backup(opts).committed, false);
});
