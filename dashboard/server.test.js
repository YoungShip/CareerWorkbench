const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const http = require('node:http');
const { createStore } = require('./store');
test('HTTP writes use IDs, reject stale snapshots; calendar retains prior events', async (t) => {
  let modelRequest;
  const upstream = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    modelRequest = {
      url: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(text),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] })
    );
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobhunt-http-'));
  const store = createStore(dir);
  const privateDir = path.join(dir, 'private');
  fs.mkdirSync(path.join(privateDir, 'secrets'), { recursive: true });
  const modelFile = path.join(privateDir, 'secrets', 'llm.json');
  fs.writeFileSync(
    modelFile,
    JSON.stringify({
      active: 'cpa',
      providers: {
        cpa: {
          base_url: 'http://127.0.0.1:8317/v1',
          model: 'fixture-model',
          api_key: 'fixture-http-secret',
        },
      },
    })
  );
  store.initialize({
    job_pool: [{ job_id: 'j1', company: 'Example', job_title: 'Test', status: 'Submitted' }],
    application_log: [],
    follow_up: [],
    sync_queue: [],
  });
  const port = 18429;
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: {
      ...process.env,
      JOBHUNT_DATA_DIR: dir,
      JOBHUNT_PORT: String(port),
      JOBMATCH_PRIVATE_DIR: privateDir,
      CPA_API_KEY: '',
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    child.kill();
    if (child.exitCode === null) await once(child, 'exit');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(() => {
      throw new Error('Server exited before ready');
    }),
  ]);
  const base = 'http://127.0.0.1:' + port;
  const snap = await (await fetch(base + '/api/snapshot')).json();
  assert.equal(snap.tables.job_pool.length, 1);
  const preview = await (await fetch(base + '/api/snapshot/preview')).json();
  assert.equal(preview.revision, snap.revision);
  assert.equal(preview.read_status.preview, true);
  async function post(route, payload, origin) {
    return fetch(base + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(payload),
    });
  }
  const settings = await (await fetch(base + '/api/model-settings')).json();
  assert.equal(settings.providers.cpa.model, 'fixture-model');
  assert.doesNotMatch(JSON.stringify(settings), /fixture-http-secret/);
  const modelPayload = {
    expected_revision: settings.revision,
    provider: 'cpa',
    base_url: 'http://127.0.0.1:' + upstream.address().port + '/v1',
    model: 'fixture-updated',
    api_key: '',
  };
  assert.equal(
    (await post('/api/model-settings', modelPayload, 'https://untrusted.example')).status,
    403
  );
  const savedSettings = await post('/api/model-settings', modelPayload);
  assert.equal(savedSettings.status, 200);
  assert.doesNotMatch(await savedSettings.text(), /fixture-http-secret/);
  assert.equal(
    JSON.parse(fs.readFileSync(modelFile, 'utf8')).providers.cpa.api_key,
    'fixture-http-secret'
  );
  const readback = await (await fetch(base + '/api/model-settings')).json();
  assert.equal(readback.providers.cpa.model, 'fixture-updated');
  const modelBytes = fs.readFileSync(modelFile, 'utf8');
  const testedSettings = await post('/api/model-settings/test', {
    ...modelPayload,
    expected_revision: readback.revision,
  });
  assert.equal(testedSettings.status, 200);
  assert.equal((await testedSettings.json()).ok, true);
  assert.equal(modelRequest.url, '/v1/chat/completions');
  assert.equal(modelRequest.authorization, 'Bearer fixture-http-secret');
  assert.equal(modelRequest.body.model, 'fixture-updated');
  assert.equal(fs.readFileSync(modelFile, 'utf8'), modelBytes);
  assert.equal((await post('/api/model-settings', modelPayload)).status, 409);
  assert.equal((await post('/api/model-settings/test', modelPayload)).status, 409);
  assert.equal((await fetch(base + '/model-settings.js')).status, 200);
  assert.equal((await fetch(base + '/data/private/secrets/llm.json')).status, 404);
  assert.equal((await (await fetch(base + '/api/snapshot')).json()).revision, snap.revision);
  let r = await post('/api/calendar/add', {
    expected_revision: snap.revision,
    job_id: 'j1',
    date: '2026-09-15',
    time: '',
    event_type: 'Interview',
    stage: '2',
    stage_status: '1',
  });
  assert.equal(r.status, 200);
  assert.equal((await fetch(base + '/api/snapshot/preview')).status, 204);
  r = await post('/api/update-status', {
    expected_revision: snap.revision,
    job_id: 'j1',
    status: 'Rejected',
  });
  assert.equal(r.status, 409);
  assert.equal(store.snapshot().tables.job_pool[0].status, 'Submitted');
  let next = store.snapshot();
  const event = next.tables.follow_up[0];
  r = await post('/api/calendar/update', {
    expected_revision: next.revision,
    job_id: 'j1',
    event_id: event.event_id,
    date: '2026-09-16',
    time: '10:00',
    event_type: 'Interview',
    stage: '2',
    stage_status: '1',
  });
  assert.equal(r.status, 200);
  assert.equal(store.snapshot().tables.follow_up[0].date, '2026-09-16');
  next = store.snapshot();
  r = await post(
    '/api/update-status',
    { expected_revision: next.revision, job_id: 'j1', status: 'Offer' },
    'https://untrusted.example'
  );
  assert.equal(r.status, 403);
  r = await post('/api/update-status', {
    expected_revision: next.revision,
    job_id: 'j1',
    status: 'Offer',
  });
  assert.equal(r.status, 200);
  assert.equal(store.snapshot().tables.job_pool[0].status, 'Offer');
  next = store.snapshot();
  const completed = await post('/api/calendar/complete', {
    expected_revision: next.revision,
    job_id: 'j1',
    event_id: event.event_id,
    date: '2026-09-12',
    time: '11:00',
    outcome: '6',
    evidence: '本人确认完成',
  });
  assert.equal(completed.status, 200);
  const final = store.snapshot();
  assert.equal(final.tables.follow_up.length, 1);
  assert.equal(final.tables.follow_up[0].status, 'Completed');
  assert.equal(final.tables.follow_up[0].stage_status, '6');
  assert.match(final.tables.follow_up[0].notes, /本人确认完成/);
  assert.equal(
    (
      await post('/api/calendar/complete', {
        expected_revision: next.revision,
        job_id: 'j1',
        event_id: event.event_id,
        date: '2026-09-12',
        outcome: '6',
        evidence: '重复',
      })
    ).status,
    409
  );
  assert.equal((await fetch(base + '/todo.js')).status, 200);
  assert.equal((await fetch(base + '/.store/journal.json')).status, 404);
  const rev = store.snapshot().revision;
  const note = '中文备注 "引号", 逗号\n第二行 <script>不能执行</script>';
  assert.equal(
    (
      await post('/api/job/notes', {
        expected_revision: rev,
        job_id: 'j1',
        notes: note,
        next_action: '等待结果',
      })
    ).status,
    200
  );
  assert.equal(store.snapshot().tables.job_pool[0].notes, note);
  assert.equal(
    (
      await post('/api/job/notes', {
        expected_revision: rev,
        job_id: 'j1',
        notes: '过期覆盖',
        next_action: '',
      })
    ).status,
    409
  );
  assert.equal(store.snapshot().tables.job_pool[0].notes, note);
});
