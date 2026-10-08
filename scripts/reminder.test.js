const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { execFileSync } = require('node:child_process');
const core = require('./reminder-core');
const now = new Date('2026-09-20T12:00:00+08:00');
const event = (changes = {}) => ({
  event_id: 'event-1',
  job_id: 'job-1',
  company: '虚构公司',
  job_title: '虚构岗位',
  event_type: '测评截止',
  deadline: '2026-09-20 13:00',
  status: 'Scheduled',
  stage_status: '1',
  ...changes,
});
test('unknown deadline never falls back to invitation date', () => {
  const r = core.collectEvents(
    [
      event({
        event_type: '邀请收到（无截止时间）',
        deadline: '',
        date: '2026-09-10',
        time: '01:49',
      }),
    ],
    now
  );
  assert.equal(r.noDeadline.length, 1);
  assert.equal(r.overdue.length, 0);
});
test('explicit unknown marker overrides a stale deadline', () => {
  assert.equal(core.deadlineOf(event({ notes: '[时间口径：时间未知]' })), null);
});
test('ISO offsets, midnight and date-only precision are preserved', () => {
  assert.equal(
    core.parseInstant('2026-09-20T04:00:00Z').at.toISOString(),
    '2026-09-20T04:00:00.000Z'
  );
  assert.equal(core.parseInstant('2026-09-20 00:00').at.toISOString(), '2026-09-19T16:00:00.000Z');
  const dl = core.deadlineOf(event({ deadline: '2026-09-20' }));
  assert.equal(dl.assumed_time, true);
});
test('impossible or malformed dates are not silently normalized', () => {
  for (const raw of [
    '2026-02-30',
    '2026-13-01',
    '2026-09-20 24:00',
    '2026-09-20T13:00+14:30',
    '2026-09-20 junk',
  ])
    assert.equal(core.parseInstant(raw), null, raw);
});
test('fixed appointment and estimated cutoff retain their kinds', () => {
  assert.equal(
    core.deadlineOf(
      event({ deadline: '', event_type: '视频面试', date: '2026-09-20', time: '13:00' })
    ).kind,
    '固定安排'
  );
  assert.equal(
    core.deadlineOf(event({ event_type: '测评截止参考上限（待核实）' })).kind,
    '估算截止'
  );
  assert.equal(
    core.deadlineOf(event({ deadline: '', event_type: '视频面试', date: '2026-09-20', time: '' })),
    null
  );
});
test('completed events do not become reminders', () => {
  assert.equal(
    core.collectEvents([event({ status: 'Completed' }), event({ stage_status: '5' })], now).soon
      .length,
    0
  );
});
test('2h is selected before 24h, exact boundaries not rounded', () => {
  const r = core.collectEvents([event()], now);
  assert.equal(core.planDue(r, {}, 'wechat')[0].id, '2h');
  const at = new Date('2026-09-20T13:00:00+08:00');
  assert.equal(
    core.planDue(core.collectEvents([event()], new Date(at - 2 * core.HOUR)), {}, 'toast')[0].id,
    '2h'
  );
  assert.equal(
    core.planDue(core.collectEvents([event()], new Date(at - 2 * core.HOUR - 1)), {}, 'toast')[0]
      .id,
    '24h'
  );
  assert.equal(
    core.planDue(core.collectEvents([event()], new Date(at - 24 * core.HOUR - 1)), {}, 'toast')
      .length,
    0
  );
});
test('24h receipt does not suppress 2h; 2h subsumes a later 24h check', () => {
  const far = core.collectEvents([event()], new Date('2026-09-20T08:00:00+08:00'));
  let state = core.acknowledge({}, 'toast', core.planDue(far, {}, 'toast')[0], now);
  const close = core.collectEvents([event()], now);
  assert.equal(core.planDue(close, state, 'toast')[0].id, '2h');
  state = core.acknowledge(state, 'toast', core.planDue(close, state, 'toast')[0], now);
  assert.equal(core.planDue(close, state, 'toast').length, 0);
  assert.equal(core.planDue(far, state, 'toast').length, 0);
});
test('failed WeChat stays retryable while successful toast is acknowledged', async () => {
  const report = core.collectEvents([event()], now),
    saved = [];
  const a = await core.deliverDue(
    report,
    {},
    {
      channels: ['wechat', 'toast'],
      now,
      send: async (c) => (c === 'wechat' ? 'WECHAT_FAIL: offline' : 'TOAST_OK'),
      persist: (s) => saved.push(s),
    }
  );
  assert.equal(saved.length, 1);
  assert.equal(core.planDue(report, a.state, 'wechat').length, 1);
  assert.equal(core.planDue(report, a.state, 'toast').length, 0);
  const b = await core.deliverDue(report, a.state, {
    channels: ['wechat'],
    now,
    send: async () => 'WECHAT_OK（已发送）',
    persist: (s) => saved.push(s),
  });
  assert.equal(core.planDue(report, b.state, 'wechat').length, 0);
});
test('quota skip or missing credentials is not delivery success', async () => {
  for (const response of [
    'WECHAT_SKIP: quota',
    'WECHAT_SKIP: 未配置凭据',
    'WECHAT_FAIL: timeout',
  ]) {
    let writes = 0;
    const r = await core.deliverDue(
      core.collectEvents([event()], now),
      {},
      { channels: ['wechat'], now, send: async () => response, persist: () => writes++ }
    );
    assert.equal(writes, 0);
    assert.deepEqual(r.state, { version: 2, delivered: {} });
  }
});
test('dry-run never sends or acknowledges', async () => {
  const r = await core.deliverDue(
    core.collectEvents([event()], now),
    {},
    {
      channels: ['wechat', 'toast'],
      now,
      dryRun: true,
      send: () => assert.fail('send'),
      persist: () => assert.fail('write'),
    }
  );
  assert.equal(r.results.length, 2);
  assert.deepEqual(r.state, { version: 2, delivered: {} });
});
test('changed deadline re-arms reminders, old fired entries are not proof', () => {
  const report = core.collectEvents([event()], now);
  const old = { fired: { 'event-1#2h': now.toISOString() } };
  assert.equal(core.planDue(report, old, 'toast').length, 1);
  const state = core.acknowledge({}, 'toast', core.planDue(report, {}, 'toast')[0], now);
  const moved = core.collectEvents([event({ deadline: '2026-09-20 13:30' })], now);
  assert.equal(core.planDue(moved, state, 'toast').length, 1);
});
test('overdue follow-up needs an action and is not sent forever', () => {
  const report = core.collectEvents(
    [
      event({ deadline: '2026-09-19', next_action: '' }),
      event({ event_id: 'e2', deadline: '2026-09-19', next_action: '联系HR核实' }),
      event({ event_id: 'e3', deadline: '2026-07-01', next_action: '旧事项' }),
    ],
    now
  );
  assert.equal(core.planDue(report, {}, 'toast')[0].items.length, 1);
});
test('persistence failures are surfaced rather than reported as success', async () => {
  await assert.rejects(
    core.deliverDue(
      core.collectEvents([event()], now),
      {},
      {
        channels: ['toast'],
        now,
        send: async () => 'TOAST_OK',
        persist: () => {
          throw Error('disk error');
        },
      }
    ),
    /disk error/
  );
});
test('clock behavior is independent of host time zone', () => {
  const source = `const c=require(${JSON.stringify(require.resolve('./reminder-core'))});console.log(c.collectEvents([${JSON.stringify(event())}],new Date('${now.toISOString()}')).soon[0].remaining_ms)`;
  for (const TZ of ['UTC', 'America/Los_Angeles', 'Asia/Shanghai'])
    assert.equal(
      Number(
        execFileSync(process.execPath, ['-e', source], {
          env: { ...process.env, TZ },
          encoding: 'utf8',
        })
      ),
      core.HOUR
    );
});
test('real CLI JSON and due dry-run are side-effect-free in isolated data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-cli-'));
  try {
    const project = path.join(root, 'CareerWorkbench');
    for (const rel of [
      'scripts/remind.js',
      'scripts/reminder-core.js',
      'dashboard/store.js',
      'dashboard/todo.js',
      'discovery/research.js',
      'lib/python-runtime.js',
    ]) {
      const target = path.join(project, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(__dirname, '..', rel), target);
    }
    const data = path.join(root, 'data');
    fs.mkdirSync(data);
    fs.writeFileSync(
      path.join(data, 'follow_up.csv'),
      'event_id,job_id,company,job_title,event_type,date,time,deadline,status,stage_status,next_action\r\ne1,j1,Fictional,Role,邀请收到（无截止时间）,2026-09-10,01:49,,Scheduled,,\r\n'
    );
    const cli = path.join(project, 'scripts/remind.js'),
      env = { ...process.env, JOBHUNT_DATA_DIR: data };
    const r = JSON.parse(
      execFileSync(process.execPath, [cli, '--json'], { env, encoding: 'utf8' })
    );
    assert.equal(r.noDeadline.length, 1);
    assert.equal(r.overdue.length, 0);
    const due = new Date(Date.now() + 3600000).toISOString();
    fs.writeFileSync(
      path.join(data, 'follow_up.csv'),
      `event_id,job_id,company,job_title,event_type,deadline,status,stage_status,next_action\r\ne1,j1,Fictional,Role,测评截止,${due},Scheduled,1,完成测评\r\n`
    );
    execFileSync(process.execPath, [cli, '--due', '--all', '--dry-run'], { env, encoding: 'utf8' });
    execFileSync(process.execPath, [cli, '--all', '--dry-run'], { env, encoding: 'utf8' });
    assert.equal(fs.existsSync(path.join(project, 'tmp')), false);
    assert.equal(fs.existsSync(path.join(project, 'logs')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('corrupt v2 receipts fail closed instead of being treated as fresh state', () => {
  for (const state of [
    { version: 2, delivered: [] },
    { version: 2, delivered: { toast: [] } },
    { version: 2, delivered: { toast: { key: true } } },
    { version: 3 },
  ]) {
    assert.throws(() => core.normalizeState(state));
  }
});

test('open jobs with a deadline become reminder events; closed jobs and covered dates do not', () => {
  const jobs = [
    {
      job_id: 'p1',
      company: '甲',
      job_title: 'A岗',
      status: 'Pending',
      match_grade: 'A',
      deadline: '2026-09-21',
    },
    {
      job_id: 'p2',
      company: '乙',
      job_title: 'B岗',
      status: 'Deferred',
      deadline: '2026/9/25 18:00（官方）',
    },
    {
      job_id: 'p3',
      company: '丙',
      job_title: 'C岗',
      status: 'Pending',
      deadline: '2026-09-21（简历接收截止）',
    },
    { job_id: 's1', company: '丁', job_title: '已投', status: 'Submitted', deadline: '2026-09-21' },
    { job_id: 'n1', company: '戊', job_title: '无日期', status: 'Pending', deadline: '滚动招聘' },
  ];
  const events = [event({ job_id: 'p3', deadline: '2026-09-21 10:00' })];
  const extra = core.jobDeadlineEvents(jobs, events);
  assert.deepEqual(
    extra.map((e) => [e.job_id, e.deadline]),
    [
      ['p1', '2026-09-21'],
      ['p2', '2026-09-25 18:00'],
    ]
  );
  const r = core.collectEvents([...events, ...extra], now);
  const p1 = r.soon.find((x) => x.job_id === 'p1');
  assert.equal(p1.atText.startsWith('2026/9/21 23:59'), true);
  assert.match(p1.next, /当前 Pending，档位 A/);
  assert.equal(
    core.planDue(core.collectEvents(extra, new Date('2026-09-21T22:00:00+08:00')), {}, 'toast')[0]
      .id,
    '2h'
  );
});
