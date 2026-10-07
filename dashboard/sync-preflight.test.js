const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  vm = require('node:vm'),
  fs = require('node:fs');
async function run({
  dryRun = false,
  link = 'https://example.com/job',
  status = 'Pending',
  notes = '',
  corruptRead = false,
} = {}) {
  const db = { progress: [], progress_stages: [] },
    writes = [];
  const ctx = {
    window: {
      localStorage: {
        getItem: () => JSON.stringify({ record: { id: 'u' }, token: 'fixture-only' }),
      },
    },
    fetch: async (url, opt) => {
      const m = url.match(/collections\/(\w+)\/records(?:\/([^?]+))?/),
        rows = db[m[1]];
      let result;
      if (opt.method === 'GET')
        result = m[2]
          ? {
              ...rows.find((r) => r.id === m[2]),
              ...(corruptRead && m[1] === 'progress' ? { city: 'wrong' } : {}),
            }
          : { items: rows, totalPages: 1 };
      else {
        result = { id: m[1] + rows.length, ...JSON.parse(opt.body) };
        rows.push(result);
        writes.push(m[1]);
      }
      return { ok: true, json: async () => structuredClone(result) };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(require.resolve('./offernotes-reconcile'), 'utf8'), ctx);
  const result = await ctx.reconcileOfferNotes({
    dryRun,
    entries: [
      {
        change_id: 'c',
        job: {
          job_id: 'j',
          company: 'Fixture',
          job_title: 'Role',
          location: '杭州',
          status,
          job_url: link,
          notes,
        },
        events: [],
      },
    ],
  });
  return { result: result.results[0], db, writes };
}
test('new job invalid link fails in preview and execution before any write', async () => {
  for (const dryRun of [true, false]) {
    const r = await run({ dryRun, link: 'https://example.com/' + 'x'.repeat(220) });
    assert.match(r.result.error, /200-character/);
    assert.deepEqual(r.writes, []);
  }
});
test('valid creation previews stages and writes verified record plus stage', async () => {
  const preview = await run({ dryRun: true });
  assert.equal(preview.result.error, undefined);
  assert.deepEqual(Array.from(preview.result.actions), ['create', 'create-stage-0']);
  assert.deepEqual(preview.writes, []);
  const r = await run();
  assert.equal(r.result.error, undefined);
  assert.deepEqual(r.writes, ['progress', 'progress_stages']);
});
test('new detail readback mismatch prevents stage write', async () => {
  const r = await run({ corruptRead: true });
  assert.match(r.result.error, /Created detail verification/);
  assert.deepEqual(r.writes, ['progress']);
});
test('deferred reason is preserved without inventing B version', async () => {
  const r = await run({ status: 'Deferred', notes: '等岗位额度核实' });
  assert.equal(r.result.error, undefined);
  assert.match(r.db.progress[0].job_note, /等岗位额度核实/);
  assert.doesNotMatch(r.db.progress[0].job_note, /等B/);
  assert.doesNotMatch(r.db.progress_stages[0].note_text, /等B/);
});
