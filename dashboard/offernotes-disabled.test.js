// OfferNotes 同步默认停用：写入不入 sync_queue，摘要不提示同步，删除不要求先删线上记录
delete process.env.JOBHUNT_OFFERNOTES_SYNC;
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('./store');
const { buildBrief } = require('./brief');
const { offernotesSyncEnabled } = require('../lib/offernotes');

function fixture(t, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobhunt-offernotes-off-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createStore(dir, options);
  store.initialize({
    job_pool: [
      {
        job_id: 'j1',
        company: 'Company',
        job_title: 'Title',
        status: 'Pending',
        offernotes_id: 'remote-1',
      },
    ],
    application_log: [],
    follow_up: [],
    sync_queue: [{ job_id: 'j1', change_id: 'old', state: 'pending' }],
  });
  return store;
}
const patch = (store) =>
  store.commit({
    expected_revision: store.snapshot().revision,
    operations: [{ type: 'job.patch', job_id: 'j1', patch: { notes: 'edited' } }],
  });

test('sync is off unless JOBHUNT_OFFERNOTES_SYNC=1', () => {
  assert.equal(offernotesSyncEnabled({}), false);
  assert.equal(offernotesSyncEnabled({ JOBHUNT_OFFERNOTES_SYNC: '0' }), false);
  assert.equal(offernotesSyncEnabled({ JOBHUNT_OFFERNOTES_SYNC: '1' }), true);
});

test('writes leave the sync queue untouched when disabled', (t) => {
  const store = fixture(t);
  const result = patch(store);
  assert.deepEqual(result.changed_jobs, ['j1']);
  assert.deepEqual(
    store.snapshot().tables.sync_queue.map((r) => [r.job_id, r.change_id, r.state]),
    [['j1', 'old', 'pending']]
  );
  const enabled = fixture(t, { offernotesSync: true });
  patch(enabled);
  assert.notEqual(enabled.snapshot().tables.sync_queue[0].change_id, 'old');
});

test('deleting a job with an OfferNotes id needs no remote deletion when disabled', (t) => {
  const op = { type: 'job.delete', job_id: 'j1', reason: 'User explicitly requested deletion' };
  const enabled = fixture(t, { offernotesSync: true });
  assert.throws(
    () => enabled.commit({ expected_revision: enabled.snapshot().revision, operations: [op] }),
    /Verified remote deletion ID/
  );
  const store = fixture(t);
  store.commit({ expected_revision: store.snapshot().revision, operations: [op] });
  assert.equal(store.snapshot().tables.job_pool.length, 0);
});

test('brief hides the sync backlog when disabled', () => {
  const snapshot = {
    revision: 'r',
    warnings: [],
    tables: {
      job_pool: [{ job_id: 'j1', company: 'C', job_title: 'T', status: 'Pending' }],
      follow_up: [],
      sync_queue: [{ job_id: 'j1', state: 'error', error: 'old failure' }],
    },
  };
  const now = new Date('2026-10-09T12:00:00+08:00');
  const off = buildBrief(snapshot, { now });
  assert.equal(off.counts.sync_queue, 'disabled');
  assert.equal(off.sync_attention.total, 0);
  assert.ok(!off.next_steps.some((s) => s.includes('同步')));
  const on = buildBrief(snapshot, { now, offernotesSync: true });
  assert.equal(on.sync_attention.total, 1);
  assert.ok(on.next_steps.some((s) => s.includes('待同步')));
});
