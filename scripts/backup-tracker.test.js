const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createStore } = require('../dashboard/store');
const { backup, redact, findLeaks, isIdCard } = require('./backup-tracker');

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
