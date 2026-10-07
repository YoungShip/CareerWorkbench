const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
async function run({
  job,
  status = 1,
  dryRun = false,
  foreign = false,
  events = [],
  emptyPatch = false,
  savePatch = true,
}) {
  const writes = [];
  const p = {
    id: 'p1',
    user: 'u1',
    company: '公司',
    department: '岗位',
    job_note: '已有备注',
    city: '上海',
  };
  const stage = {
    id: 's1',
    user: 'u1',
    progress: 'p1',
    stage: 0,
    status,
    stage_date: '2026-09-12 00:00:00.000Z',
    todo_text: 'https://example.com/job',
    note_text: '已有阶段备注',
  };
  const db = {
    progress: [p, ...(foreign ? [{ ...p, id: 'foreign', user: 'other' }] : [])],
    progress_stages: [stage],
  };
  const context = {
    window: {
      localStorage: { getItem: () => JSON.stringify({ record: { id: 'u1' }, token: 'test-only' }) },
    },
    fetch: async (url, options) => {
      const m = url.match(/collections\/(\w+)\/records(?:\/([^?]+))?/);
      const rows = db[m[1]];
      let result;
      if (options.method === 'GET') {
        result = m[2] ? rows.find((r) => r.id === m[2]) : { items: rows, totalPages: 1 };
      } else {
        writes.push({ url, method: options.method });
        const values = JSON.parse(options.body);
        if (m[2]) {
          result = rows.find((r) => r.id === m[2]);
          if (savePatch) Object.assign(result, values);
        } else {
          result = { id: 'new' + rows.length, ...values };
          rows.push(result);
        }
      }
      return {
        ok: true,
        json: async () => {
          if (emptyPatch && options.method === 'PATCH') throw Error('Unexpected end of JSON input');
          return JSON.parse(JSON.stringify(result));
        },
      };
    },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('./offernotes-reconcile'), 'utf8'), context);
  const result = await context.reconcileOfferNotes({
    dryRun,
    entries: [
      {
        job: {
          job_id: 'j1',
          company: '公司',
          job_title: '岗位',
          status: 'Submitted',
          location: '上海',
          job_url: 'https://example.com/job',
          notes: '新增备注',
          ...job,
        },
        change_id: 'c1',
        events,
      },
    ],
  });
  return { result, writes, db };
}
test('dry run performs no writes and ownership prevents foreign duplicate', async () => {
  const r = await run({ dryRun: true, foreign: true });
  assert.equal(r.writes.length, 0);
  assert.equal(r.result.results[0].offernotes_id, 'p1');
  assert.equal(r.result.results[0].error, undefined);
});
test('submitted defaults to awaiting result and preserves terminal/legacy completion', async () => {
  let r = await run({});
  assert.equal(r.db.progress_stages[0].status, 6);
  for (const status of [2, 3, 4, 5]) {
    r = await run({ status });
    assert.equal(r.db.progress_stages[0].status, status);
  }
});
test('pending does not roll back remote progressed state', async () => {
  const r = await run({ job: { status: 'Pending' }, status: 6 });
  assert.match(r.result.results[0].error, /progressed/);
  assert.equal(r.db.progress_stages[0].status, 6);
});
test('unsubmitted stage clears legacy date but keeps actual assessment schedule', async () => {
  for (const status of ['Pending', 'Deferred']) {
    const r = await run({
      job: { status },
      events: [
        {
          stage: '1',
          stage_status: '1',
          date: '2026-09-15',
          time: '10:00',
          event_type: '测评安排',
        },
      ],
    });
    assert.equal(r.result.results[0].error, undefined);
    assert.equal(r.db.progress_stages[0].stage_date, '');
    assert.equal(r.db.progress_stages[0].status, 1);
    assert.equal(r.db.progress_stages[1].stage_date, '2026-09-15T02:00:00.000Z');
  }
});
test('missing local description preserves online content; verify keeps old notes', async () => {
  const r = await run({});
  assert.match(r.db.progress[0].job_note, /已有备注/);
  assert.match(r.db.progress[0].job_note, /新增备注/);
  assert.equal(r.result.results[0].error, undefined);
});

test('completed assessment syncs actual date and evidence without inventing next round', async () => {
  const r = await run({
    events: [
      {
        stage: '1',
        stage_status: '6',
        date: '2026-09-12',
        time: '',
        event_type: '测评完成截止',
        notes: '完成凭据：本人确认',
      },
    ],
  });
  assert.equal(r.result.results[0].error, undefined);
  const e = r.db.progress_stages.find((s) => s.stage === 1);
  assert.equal(e.status, 6);
  assert.equal(e.stage_date, '2026-09-11T16:00:00.000Z');
  assert.match(e.note_text, /本人确认/);
  assert.match(e.note_text, /具体时间未记录/);
  assert.equal(r.db.progress_stages.length, 2);
});
test('retry after server accepted create but response was lost does not duplicate jobs or stages', async () => {
  const db = { progress: [], progress_stages: [] };
  let lose = true;
  const ctx = {
    window: {
      localStorage: { getItem: () => JSON.stringify({ record: { id: 'u' }, token: 'test-only' }) },
    },
    fetch: async (url, opt) => {
      const m = url.match(/collections\/(\w+)\/records(?:\/([^?]+))?/),
        rows = db[m[1]];
      let result;
      if (opt.method === 'GET')
        result = m[2] ? rows.find((r) => r.id === m[2]) : { items: rows, totalPages: 1 };
      else if (opt.method === 'POST') {
        result = { id: 'id' + rows.length, ...JSON.parse(opt.body) };
        rows.push(result);
        if (lose) {
          lose = false;
          throw Error('Response lost after creation');
        }
      } else {
        result = rows.find((r) => r.id === m[2]);
        Object.assign(result, JSON.parse(opt.body));
      }
      return { ok: true, json: async () => JSON.parse(JSON.stringify(result)) };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(require.resolve('./offernotes-reconcile'), 'utf8'), ctx);
  const payload = {
    dryRun: false,
    entries: [
      {
        change_id: 'c',
        job: {
          job_id: 'j',
          company: 'Retry',
          job_title: 'Role',
          status: 'Submitted',
          application_date: '2026-09-12',
          job_url: 'https://example.com/job',
        },
        events: [],
      },
    ],
  };
  assert.match((await ctx.reconcileOfferNotes(payload)).results[0].error, /Response lost/);
  assert.equal((await ctx.reconcileOfferNotes(payload)).results[0].error, undefined);
  assert.equal((await ctx.reconcileOfferNotes(payload)).results[0].actions.length, 0);
  assert.equal(db.progress.length, 1);
  assert.equal(db.progress_stages.length, 1);
});

test('new pending entry stays private with canonical server value and no invented date', async () => {
  const r = await run({ job: { company: 'New private company', status: 'Pending' } });
  assert.equal(r.result.results[0].error, undefined);
  const created = r.db.progress.find((x) => x.company === 'New private company');
  assert.equal(created.publish_delay, 100000);
  const stage = r.db.progress_stages.find((x) => x.progress === created.id);
  assert.equal(stage.status, 1);
  assert.equal(stage.stage_date, undefined);
});

test('empty successful PATCH body is accepted only after exact read-back', async () => {
  const r = await run({ emptyPatch: true });
  assert.equal(r.result.results[0].error, undefined);
  assert.match(r.db.progress[0].job_note, /新增备注/);
  assert.equal(r.db.progress_stages[0].status, 6);
});
test('empty PATCH body without persisted fields remains an error without repeated write', async () => {
  const r = await run({ emptyPatch: true, savePatch: false });
  assert.match(r.result.results[0].error, /read-back differs/);
  assert.equal(r.writes.length, 1);
  assert.equal(r.db.progress[0].job_note, '已有备注');
  assert.equal(r.db.progress_stages[0].status, 1);
});
