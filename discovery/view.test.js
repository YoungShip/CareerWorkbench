const test = require('node:test'),
  assert = require('node:assert/strict');
const { parseDeadline, deadlineForLead, buildDiscoveryNext, queryDiscovery } = require('./view');
const snapshot = {
  revision: 'rev',
  active_run_id: 'r1',
  runs: [
    {
      run_id: 'r1',
      status: 'paused',
      checkpoint: 'saved',
      next_steps: ['resume'],
      updated_at: '2026-09-20T00:00:00Z',
    },
  ],
  leads: [
    {
      lead_id: 'official',
      company: 'Official Co',
      aliases: [],
      source_urls: ['https://example.com'],
      official_url: 'https://example.com/jobs',
      state: 'discovered',
      evidence_summary: 'Official page',
      open_questions: [],
      deadline: '2026-09-20 18:00',
      deadline_source_url: 'https://example.com/jobs',
      deadline_confidence: 'official',
      last_checked_at: '2026-09-20T01:00:00Z',
    },
    {
      lead_id: 'candidate',
      company: 'Candidate Co',
      aliases: [],
      source_urls: ['https://example.org'],
      official_url: '',
      state: 'discovered',
      evidence_summary: '第三方公告：网申至 2026-09-21',
      open_questions: ['官方截止待核'],
      last_checked_at: '2026-09-19T01:00:00Z',
    },
    {
      lead_id: 'done',
      company: 'Done Co',
      aliases: [],
      source_urls: ['https://done.example'],
      official_url: '',
      state: 'researched',
      evidence_summary: '截止 2026-09-20',
      open_questions: [],
      last_checked_at: '2026-09-18T01:00:00Z',
    },
  ],
};

test('strict deadline parsing preserves date-only and rejects impossible dates', () => {
  assert.equal(parseDeadline('2026-09-20').assumed_time, true);
  assert.equal(parseDeadline('2026-09-20 18:00').precision, 'minute');
  assert.equal(parseDeadline('2026-02-30'), null);
  assert.equal(parseDeadline('09-20'), null);
});

test('structured deadline outranks text candidate and carries provenance', () => {
  const structured = deadlineForLead(snapshot.leads[0]);
  assert.equal(structured.source, 'structured');
  assert.equal(structured.confirmed, true);
  assert.equal(structured.confidence, 'official');
  const candidate = deadlineForLead(snapshot.leads[1]);
  assert.equal(candidate.source, 'text_candidate');
  assert.equal(candidate.confirmed, false);
  assert.match(candidate.excerpt, /网申至/);
});

test('next view surfaces near-deadline unresearched leads without treating text as confirmed', () => {
  const view = buildDiscoveryNext(snapshot, {
    now: new Date('2026-09-20T08:00:00+08:00'),
    limit: 10,
    horizonHours: 72,
  });
  assert.equal(view.deadline_attention.total, 2);
  assert.equal(view.deadline_attention.items[0].lead_id, 'official');
  assert.equal(view.deadline_attention.items[1].confirmed, false);
  assert.equal(view.requires_confirmation, true);
  assert.equal(view.active_run.run_id, 'r1');
  assert.equal(view.counts.states.researched, 1);
});

test('query filters and projects without returning the full state', () => {
  const result = queryDiscovery(snapshot, {
    states: ['discovered'],
    fields: ['lead_id', 'company', 'deadline_info'],
    limit: 1,
  });
  assert.equal(result.counts.matched, 2);
  assert.equal(result.leads.length, 1);
  assert.equal(result.meta.truncated, true);
  assert.deepEqual(Object.keys(result.leads[0]), ['lead_id', 'company', 'deadline_info']);
  assert.throws(
    () => queryDiscovery(snapshot, { fields: ['private_unknown'] }),
    /Unknown lead field/
  );
});
test('text extraction ignores dates next to explicitly unknown deadlines', () => {
  const lead = {
    evidence_summary: '公告发布 2026-09-16，截止待核；下一步回官方确认',
    open_questions: [],
  };
  assert.equal(deadlineForLead(lead), null);
});
