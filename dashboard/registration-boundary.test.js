'use strict';
// Regression coverage for the trusted registration runtime and source provenance.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createStore } = require('./store');
const { defaultRuntime } = require('../discovery/research');
const { writeV2Fixture } = require('../discovery/v2-fixture');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobhunt-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data'),
    research = path.join(root, 'research');
  const matching = writeV2Fixture(research);
  const matchingFile = path.join(research, 'matching.json');
  fs.writeFileSync(matchingFile, JSON.stringify(matching));
  const runtime = { ...defaultRuntime() },
    store = createStore(data, { runtime });
  store.initialize({});
  const operation = {
    type: 'job.add',
    job_id: 'role-1',
    registration: 'research',
    selected_position_id: 'role-1',
    record: {
      company: 'Fixture Company',
      job_title: 'Fixture QA Engineer',
      status: 'Pending',
      matching_file: matchingFile,
    },
  };
  return { root, data, research, matching, matchingFile, runtime, store, operation };
}
function fakeVerifier(f) {
  const marker = path.join(f.root, 'untrusted-ran.txt'),
    file = path.join(f.root, 'untrusted.py');
  const report = {
    passed: true,
    mechanical_passed: true,
    readiness: {
      status: 'ready',
      can_register_selected_position: true,
      selected_position_id: 'role-1',
      registerable_position_ids: ['role-1'],
    },
    checks: {},
  };
  fs.writeFileSync(
    file,
    [
      'import json,sys',
      'from pathlib import Path',
      `Path(${JSON.stringify(marker)}).write_text('executed', encoding='utf-8')`,
      `report = json.loads(${JSON.stringify(JSON.stringify(report))})`,
      "Path(sys.argv[-1]).with_name('matching-verification.json').write_text(json.dumps(report), encoding='utf-8')",
    ].join('\n')
  );
  return { file, marker };
}
test('registration boundary: operation cannot choose its own verifier', (t) => {
  const f = fixture(t),
    fake = fakeVerifier(f),
    before = f.store.snapshot().revision;
  f.matching.positions[0].jd_source.quotes[0].text = 'Not in the JD snapshot';
  fs.writeFileSync(f.matchingFile, JSON.stringify(f.matching));
  const op = { ...f.operation, runtime: { ...f.runtime, verifier: fake.file } };
  const plan = JSON.parse(JSON.stringify({ expected_revision: before, operations: [op] }));
  for (const dryRun of [true, false])
    assert.throws(() => f.store.commit(plan, dryRun), /runtime.*trusted|trusted.*runtime/i);
  assert.equal(fs.existsSync(fake.marker), false);
  assert.equal(f.store.snapshot().revision, before);
  assert.equal(f.store.snapshot().tables.job_pool.length, 0);
});
test('registration boundary: runtime fields are rejected at every plan input level', (t) => {
  const f = fixture(t),
    before = f.store.snapshot().revision;
  const manual = {
    type: 'job.add',
    job_id: 'm1',
    registration: 'manual',
    registration_reason: 'Synthetic manual fixture',
    record: { company: 'Fixture', job_title: 'Role', status: 'Pending' },
  };
  for (const level of ['plan', 'operation', 'record'])
    for (const value of [null, {}, { verifier: 'untrusted.py' }]) {
      const plan = JSON.parse(JSON.stringify({ expected_revision: before, operations: [manual] }));
      const target =
        level === 'plan'
          ? plan
          : level === 'operation'
            ? plan.operations[0]
            : plan.operations[0].record;
      target.runtime = value;
      for (const dryRun of [true, false])
        assert.throws(() => f.store.commit(plan, dryRun), /runtime.*trusted|trusted.*runtime/i);
      assert.equal(f.store.snapshot().revision, before);
    }
});
test('registration boundary: store runtime is copied before caller mutation', (t) => {
  const f = fixture(t),
    fake = fakeVerifier(f),
    before = f.store.snapshot().revision;
  f.runtime.verifier = fake.file;
  f.matching.positions[0].jd_source.quotes[0].text = 'Not in the JD snapshot';
  fs.writeFileSync(f.matchingFile, JSON.stringify(f.matching));
  assert.throws(
    () => f.store.commit({ expected_revision: before, operations: [f.operation] }),
    /verified matching record/
  );
  assert.equal(fs.existsSync(fake.marker), false);
  assert.equal(f.store.snapshot().revision, before);
});
test('registration provenance: manual source and reason both survive CSV roundtrip', (t) => {
  const f = fixture(t),
    source = 'Official entry "quoted", original\nsecond line';
  const before = f.store.snapshot().revision;
  const op = {
    type: 'job.add',
    job_id: 'manual-1',
    registration: 'manual',
    registration_reason: 'User-approved synthetic correction',
    record: { company: 'Fixture', job_title: 'Role', status: 'Pending', source },
  };
  const plan = { expected_revision: before, operations: [op] };
  f.store.commit(plan, true);
  assert.equal(f.store.snapshot().revision, before);
  f.store.commit(plan);
  const stored = f.store.snapshot().tables.job_pool[0];
  assert.equal(stored.source, source + '\nmanual: User-approved synthetic correction');
  assert.equal(stored.registration, undefined);
});
test('registration provenance: research source keeps the verified position trail', (t) => {
  const f = fixture(t),
    source = 'Official catalog\nOriginal source retained';
  f.operation.record.source = source;
  const plan = { expected_revision: f.store.snapshot().revision, operations: [f.operation] };
  f.store.commit(plan, true);
  f.store.commit(plan);
  const row = f.store.snapshot().tables.job_pool[0];
  assert.ok(row.source.startsWith(source + '\nresearch: matching=' + f.matchingFile));
  assert.match(row.source, /position=role-1 readiness=/);
  assert.equal(row.runtime, undefined);
});
test('registration boundary: trusted factory injection remains available to tests', (t) => {
  const f = fixture(t),
    marker = path.join(f.root, 'trusted-ran.txt'),
    wrapper = path.join(f.root, 'trusted-wrapper.py');
  fs.writeFileSync(
    wrapper,
    [
      'import runpy,sys',
      'from pathlib import Path',
      `Path(${JSON.stringify(marker)}).write_text('trusted', encoding='utf-8')`,
      `sys.argv[0] = ${JSON.stringify(f.runtime.verifier)}`,
      'runpy.run_path(sys.argv[0], run_name="__main__")',
    ].join('\n')
  );
  const store = createStore(f.data, { runtime: { ...f.runtime, verifier: wrapper } });
  const plan = { expected_revision: store.snapshot().revision, operations: [f.operation] };
  store.commit(plan, true);
  store.commit(plan);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'trusted');
  assert.equal(store.snapshot().tables.job_pool.length, 1);
});
test('registration boundary: actual CLI refuses a forged runtime without writing', (t) => {
  const f = fixture(t),
    fake = fakeVerifier(f),
    before = f.store.snapshot().revision;
  f.operation.runtime = { ...f.runtime, verifier: fake.file };
  const file = path.join(f.root, 'plan.json');
  fs.writeFileSync(file, JSON.stringify({ expected_revision: before, operations: [f.operation] }));
  for (const command of ['preview', 'apply']) {
    const result = spawnSync(
      process.execPath,
      [path.join(__dirname, 'tracker-cli.js'), command, file],
      {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
        env: {
          ...process.env,
          JOBHUNT_DATA_DIR: f.data,
          JOBHUNT_PYTHON: f.runtime.python,
          JOBHUNT_VERIFIER: f.runtime.verifier,
        },
      }
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /runtime.*trusted|trusted.*runtime/i);
    assert.equal(fs.existsSync(fake.marker), false);
    assert.equal(f.store.snapshot().revision, before);
  }
});
