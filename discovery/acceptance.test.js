'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createDiscoveryStore } = require('./store');

// Real CLI processes and validator, using a separate workspace and synthetic data.
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobhunt-acceptance-'));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const project = path.join(root, 'CareerWorkbench'),
    docs = path.join(root, 'lapis-cv', '秋招');
  const validatorDir = path.join(root, '.agents', 'skills', 'campus-recruitment', 'scripts');
  fs.mkdirSync(validatorDir, { recursive: true });
  fs.copyFileSync(
    path.resolve(__dirname, '../../.agents/skills/campus-recruitment/scripts/verify-matching.py'),
    path.join(validatorDir, 'verify-matching.py')
  );
  fs.mkdirSync(path.join(project, 'discovery'), { recursive: true });
  fs.mkdirSync(path.join(project, 'dashboard'), { recursive: true });
  fs.mkdirSync(path.join(project, 'lib'), { recursive: true });
  fs.mkdirSync(docs, { recursive: true });
  for (const name of ['cli.js', 'store.js', 'research.js', 'view.js', 'v2-fixture.js'])
    fs.copyFileSync(path.join(__dirname, name), path.join(project, 'discovery', name));
  for (const name of ['json-output.js', 'artifact-paths.js', 'python-runtime.js', 'offernotes.js'])
    fs.copyFileSync(path.resolve(__dirname, '../lib', name), path.join(project, 'lib', name));
  for (const name of ['store.js', 'todo.js'])
    fs.copyFileSync(
      path.join(__dirname, '../dashboard', name),
      path.join(project, 'dashboard', name)
    );
  for (const name of ['求职档案.md', '公司调研占用表.md', '后续公司优先池.md'])
    fs.writeFileSync(path.join(docs, name), '# Acceptance fixture\n');
  const cli = path.join(project, 'discovery', 'cli.js');
  function invoke(command, input, env = {}) {
    const args = [cli, command];
    if (input !== undefined) {
      const file = path.join(root, 'input.json');
      fs.writeFileSync(file, JSON.stringify(input));
      args.push(file);
    }
    const result = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, ...env },
      timeout: 15000,
    });
    assert.ifError(result.error);
    return result;
  }
  function call(command, input, env) {
    const r = invoke(command, input, env);
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  }
  const snapshot = () => call('snapshot');
  const plan = (operations) => ({ expected_revision: snapshot().revision, operations });
  const apply = (operations) => call('apply', plan(operations));
  const lead = {
    lead_id: 'example',
    company: 'Example',
    aliases: ['Example Ltd'],
    source_urls: ['https://example.com/jobs'],
    official_url: 'https://example.com/jobs',
    state: 'discovered',
    evidence_summary: 'Synthetic official catalog',
    open_questions: ['Read JD'],
  };
  return { root, project, docs, invoke, call, snapshot, plan, apply, lead };
}
test('CLI discovery, pause/restart, source failure, validation repair, completion and repeat discovery', (t) => {
  const f = workspace(t),
    run_id = 'round1';
  const p = f.plan([
    { type: 'run.start', run_id },
    { type: 'lead.upsert', run_id, lead: f.lead },
    { type: 'run.pause', run_id, summary: 'Catalog found; JD pending', next_steps: ['Read JD'] },
  ]);
  const before = f.snapshot().revision;
  f.call('preview', p);
  assert.equal(f.snapshot().revision, before);
  f.call('apply', p);
  assert.equal(f.snapshot().runs[0].status, 'paused'); // Every call starts a fresh process.
  assert.notEqual(f.invoke('apply', f.plan([{ type: 'run.start', run_id: 'overlap' }])).status, 0);
  f.apply([{ type: 'run.resume', run_id }]);
  const failure = {
    type: 'source.record',
    run_id,
    url: 'https://example.com/unavailable',
    outcome: 'error',
    summary: 'Simulated source unavailable',
  };
  f.apply([failure, failure]);
  const failedRevision = f.snapshot().revision;
  assert.match(f.invoke('apply', f.plan([failure])).stderr, /retry limit/);
  assert.equal(f.snapshot().revision, failedRevision);
  f.apply([
    {
      type: 'source.record',
      run_id,
      url: 'https://example.com/jobs',
      outcome: 'ok',
      summary: 'Alternate source available',
    },
  ]);
  const dir = path.join(f.root, 'research');
  fs.mkdirSync(dir);
  const matching_file = path.join(dir, 'matching.json'),
    research_file = path.join(dir, 'report.md');
  fs.writeFileSync(research_file, 'Example 2026-01-01');
  // 合法 schema-v2 记录（与 Python 侧 valid_record 同构），成功路径不得再用旧式 matching
  const { writeV2Fixture } = require('./v2-fixture');
  const matching = writeV2Fixture(dir, { company: 'Example' });
  const complete = () => ({
    type: 'research.complete',
    run_id,
    lead_id: 'example',
    matching_file,
    research_file,
    expected_hashes: f.call('research-inspect', { matching_file, research_file }).expected_hashes,
    evidence_summary: 'Full research complete',
    open_questions: ['Quota unknown'],
  });
  // 未逐岗核对证据的 v2 记录（positions 为空）必须被拒绝，且不得改变状态
  fs.writeFileSync(matching_file, JSON.stringify({ ...matching, positions: [] }));
  const invalid = f.plan([complete()]);
  assert.match(f.invoke('apply', invalid).stderr, /validation failed/);
  assert.equal(f.snapshot().revision, invalid.expected_revision);
  assert.equal(f.snapshot().leads[0].state, 'discovered');
  // 补齐合法逐岗证据后可以完成研究
  fs.writeFileSync(matching_file, JSON.stringify(matching));
  const finishPlan = f.plan([
    complete(),
    { type: 'run.finish', run_id, summary: 'Research complete', next_steps: ['User selects job'] },
  ]);
  assert.match(
    f.invoke('apply', finishPlan, { JOBHUNT_PYTHON: path.join(f.root, 'missing-python.exe') })
      .stderr,
    /validation failed/
  );
  assert.equal(f.snapshot().revision, finishPlan.expected_revision);
  f.call('preview', finishPlan);
  f.call('apply', finishPlan);
  const done = f.snapshot();
  assert.equal(done.leads[0].state, 'researched');
  assert.equal(done.runs[0].research_count, 1);
  assert.deepEqual(done.leads[0].open_questions, ['Quota unknown']);
  // Lost response after commit: identical plan is rejected, saved completion is read back.
  assert.match(f.invoke('apply', finishPlan).stderr, /Revision conflict/);
  assert.equal(f.snapshot().revision, done.revision);
  fs.appendFileSync(path.join(f.docs, '求职档案.md'), '| Example | Research complete |\n');
  f.apply([
    { type: 'run.start', run_id: 'round2' },
    {
      type: 'lead.upsert',
      run_id: 'round2',
      lead: { ...f.lead, lead_id: 'alternate-id', company: 'Example Ltd' },
    },
    { type: 'run.finish', run_id: 'round2', summary: 'Known company skipped', next_steps: [] },
  ]);
  const repeat = f.snapshot();
  assert.equal(repeat.leads.length, 1);
  assert.equal(repeat.leads[0].state, 'researched');
  assert.equal(repeat.runs[1].decisions[0].decision, 'known_company');
  assert.equal(repeat.runs[1].new_count, 0);
  const dashboard = require('../dashboard/store')
    .createStore(path.join(f.project, 'dashboard'))
    .snapshot();
  assert.ok(Object.values(dashboard.tables).every((rows) => rows.length === 0));
});

test('hard process death before replacement preserves checkpoint; new process recovers stale lock', (t) => {
  const f = workspace(t),
    root = path.join(f.project, 'data/company-discovery'),
    store = createDiscoveryStore(root);
  store.execute({
    expected_revision: store.snapshot().revision,
    operations: [{ type: 'run.start', run_id: 'crash' }],
  });
  const before = store.snapshot();
  const plan = {
    expected_revision: before.revision,
    operations: [{ type: 'lead.upsert', run_id: 'crash', lead: f.lead }],
  };
  const worker = path.join(f.root, 'crash-worker.cjs');
  fs.writeFileSync(
    worker,
    `const {createDiscoveryStore}=require(${JSON.stringify(path.join(__dirname, 'store.js'))});createDiscoveryStore(${JSON.stringify(root)},{beforeReplace:()=>process.kill(process.pid,'SIGKILL')}).execute(${JSON.stringify(plan)});`
  );
  const r = spawnSync(process.execPath, [worker], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
  });
  assert.ifError(r.error);
  assert.notEqual(r.status, 0);
  assert.ok(fs.existsSync(path.join(root, '.lock')));
  const recovered = f.snapshot();
  assert.equal(recovered.revision, before.revision);
  assert.equal(recovered.active_run_id, 'crash');
  assert.equal(recovered.leads.length, 0);
  f.call('apply', plan);
  assert.equal(f.snapshot().leads.length, 1);
  assert.equal(fs.existsSync(path.join(root, '.lock')), false);
});
