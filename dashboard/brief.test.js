const test = require('node:test'),
  assert = require('node:assert/strict'),
  crypto = require('node:crypto');
const { currentSection, checkPolicy, buildBrief } = require('./brief');
const text = '# 档案\n## 选岗规则\nC 档不投；需本人确认。\n## 历史公司\n旧计划';
const policy = {
  schema_version: 1,
  mode: 'review_only',
  source_relative: 'rules.md',
  source_heading: '选岗规则',
  section_sha256: crypto.createHash('sha256').update('C 档不投；需本人确认。').digest('hex'),
  review_rules: [{ id: 'C-review', statuses: ['Pending'], grades: ['C'], reason: '需复核' }],
};
const now = new Date('2026-09-20T12:00:00+08:00');
function snap() {
  return {
    revision: 'same-overall-revision',
    warnings: [],
    tables: {
      job_pool: [
        {
          job_id: 'j1',
          company: '虚构',
          job_title: '岗位',
          status: 'Pending',
          match_grade: 'C',
          job_description: 'long jd not to expose',
        },
        {
          job_id: 'j2',
          company: '虚构2',
          job_title: '岗位2',
          status: 'Submitted',
          match_grade: 'C',
        },
      ],
      follow_up: [
        {
          event_id: 'e1',
          job_id: 'j1',
          event_type: '邀请收到（无截止时间）',
          deadline: '',
          date: '2026-09-10',
          time: '01:49',
        },
      ],
      sync_queue: [
        { job_id: 'j1', state: 'pending' },
        { job_id: 'j2', state: 'synced' },
      ],
    },
  };
}
test('brief flags only unsubmitted C-grade plans and never mutates records', () => {
  const input = snap(),
    before = JSON.stringify(input),
    r = buildBrief(input, { policy, policyText: text, now });
  assert.equal(r.pending_review.total, 1);
  assert.equal(r.pending_review.items[0].job_id, 'j1');
  assert.equal(r.revision, input.revision);
  assert.equal(JSON.stringify(input), before);
  assert.equal(JSON.stringify(r).includes('long jd'), false);
  assert.equal(r.read_only, true);
});
test('missing or changed policy never silently means no conflicts', () => {
  assert.equal(checkPolicy(undefined, text).status, 'missing');
  assert.equal(checkPolicy(policy, text.replace('C 档不投', '重新考虑 C 档')).status, 'stale');
  const r = buildBrief(snap(), { policy, policyText: text + '\n追加历史记录', now });
  assert.equal(r.policy.status, 'current');
  const stale = buildBrief(snap(), {
    policy,
    policyText: text.replace('需本人确认', '条件变化'),
    now,
  });
  assert.equal(stale.policy.status, 'stale');
  assert.equal(stale.requires_user_confirmation, true);
});
test('unknown deadlines and sync backlog are explicitly visible', () => {
  const r = buildBrief(snap(), { policy, policyText: text, now });
  assert.equal(r.time_needs_confirmation.total, 1);
  assert.equal(r.urgent.total, 0);
  assert.equal(r.overdue_followup.total, 0);
  assert.equal(r.counts.sync_queue.pending, 1);
  assert.equal(r.sync_attention.total, 1);
  assert.match(r.next_steps.join('\\n'), /待同步/);
});
test('limits show truncation with total counts; no hidden eligibility decisions', () => {
  const s = snap();
  s.tables.job_pool.push({ ...s.tables.job_pool[0], job_id: 'j3' });
  const r = buildBrief(s, { policy, policyText: text, now, limit: 1 });
  assert.equal(r.pending_review.total, 2);
  assert.equal(r.pending_review.items.length, 1);
  assert.equal(r.pending_review.truncated, true);
  for (const limit of [0, 101, NaN, 1.2]) assert.throws(() => buildBrief(s, { limit }), /limit/);
});
test('policy source extraction excludes historical indices and supports CRLF', () => {
  assert.equal(currentSection(text.replace(/\n/g, '\r\n')), 'C 档不投；需本人确认。');
  assert.equal(currentSection('no heading'), null);
  assert.equal(
    checkPolicy({ ...policy, review_rules: [{ statuses: null }] }, text).status,
    'invalid'
  );
});
test('brief includes near-deadline discovery signals without turning them into authorization', () => {
  const discovery = {
    counts: { leads: 2, states: { discovered: 2 } },
    deadline_attention: {
      total: 1,
      items: [
        { lead_id: 'lead-1', company: '临期公司', confirmed: false, source: 'text_candidate' },
      ],
      truncated: false,
    },
  };
  const r = buildBrief(snap(), { policy, policyText: text, now, discovery });
  assert.equal(r.discovery_deadlines.total, 1);
  assert.equal(r.discovery_deadlines.items[0].confirmed, false);
  assert.match(r.next_steps.join('\n'), /临近截止/);
  assert.equal(r.requires_user_confirmation, true);
});

test('brief lists application deadlines of Pending jobs as urgent', () => {
  const s = snap();
  s.tables.job_pool[0].deadline = '2026-09-21（官方公告）';
  const brief = buildBrief(s, { policy, policyText: text, now });
  const item = brief.urgent.items.find((x) => x.job_id === 'j1');
  assert.ok(item, JSON.stringify(brief.urgent));
  assert.equal(item.event, '网申截止（待投岗位）');
});
