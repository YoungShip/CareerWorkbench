const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const core = require('./deadlines');
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
test('completed events do not appear in the summary', () => {
  assert.equal(
    core.collectEvents([event({ status: 'Completed' }), event({ stage_status: '5' })], now).soon
      .length,
    0
  );
});
test('clock behavior is independent of host time zone', () => {
  const source = `const c=require(${JSON.stringify(require.resolve('./deadlines'))});console.log(c.collectEvents([${JSON.stringify(event())}],new Date('${now.toISOString()}')).soon[0].remaining_ms)`;
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
test('open jobs with a deadline become deadline events; closed jobs and covered dates do not', () => {
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
});
