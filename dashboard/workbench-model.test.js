'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  M = require('./workbench-model');
test('filters keep unknown states visible and combine search, location and direction', () => {
  const jobs = [
    {
      job_id: 'a',
      status: 'Submitted',
      company: 'Example',
      job_title: 'Agent',
      location: '上海',
      role_family: 'AI',
    },
    {
      job_id: 'b',
      status: 'Blocked',
      company: 'Other',
      job_title: 'C++',
      location: '苏州',
      next_action: '核对额度',
    },
    { job_id: 'c', status: 'Imported', company: 'Legacy' },
  ];
  assert.deepEqual(M.counts(jobs), { all: 3, active: 1, waiting: 1, closed: 0, other: 1 });
  assert.equal(M.filter(jobs).length, 3);
  assert.deepEqual(
    M.filter(jobs, { query: 'agent', city: '上海', family: 'AI' }).map((j) => j.job_id),
    ['a']
  );
  assert.deepEqual(
    M.filter(jobs, { query: '额度', status: 'waiting' }).map((j) => j.job_id),
    ['b']
  );
});
test('external job links reject executable and local schemes', () => {
  for (const link of ['javascript:alert(1)', 'data:text/html,x', 'file:///C:/private', 'bad'])
    assert.equal(M.safeLink(link), null);
  assert.equal(M.safeLink('https://example.com/jobs/1'), 'https://example.com/jobs/1');
});
test('submission date uses the stable job identity, not another same-company record', () => {
  const logs = [
    { job_id: 'a', attempt_date: '2026-09-12' },
    { job_id: 'b', attempt_date: '2026-09-20' },
    { job_id: 'a', attempt_date: '2026-09-13' },
  ];
  assert.equal(
    M.submittedDate({ job_id: 'a', application_date: '2026-09-11' }, logs),
    '2026-09-13'
  );
  assert.equal(
    M.submittedDate({ job_id: 'c', application_date: '2026-09-10' }, logs),
    '2026-09-10'
  );
  assert.equal(M.submittedDate({ job_id: 'd' }, logs), '');
});
test('calendar clock comes from the selected deadline and converts explicit zones to Beijing', () => {
  const Todo = require('./todo');
  const event = {
    date: '2026-09-28',
    time: '16:54',
    deadline: '2026-09-30 19:00',
    event_type: '笔试',
  };
  assert.deepEqual(M.timingParts(Todo.timing(event).at), { day: '2026-09-30', clock: '19:00' });
  assert.deepEqual(M.timingParts('2026-09-30T18:00:00Z'), { day: '2026-10-01', clock: '02:00' });
  assert.deepEqual(M.timingParts(''), { day: '', clock: '' });
  assert.deepEqual(M.timingParts('2026-09-30'), { day: '2026-09-30', clock: '' });
});
