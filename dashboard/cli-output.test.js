const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { execFileSync } = require('node:child_process');
const { atomicWriteJson } = require('../lib/json-output');
const { createStore } = require('./store');
const CLI = path.join(__dirname, 'tracker-cli.js');

test('atomic JSON output replaces complete files and leaves no temp artifacts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobhunt-json-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'result.json');
  atomicWriteJson(file, { value: '旧' });
  atomicWriteJson(file, { value: '新' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { value: '新' });
  assert.deepEqual(fs.readdirSync(root), ['result.json']);
});

test('tracker validate writes strict UTF-8 through --out', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobhunt-tracker-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  createStore(root).initialize({});
  const out = path.join(root, 'validate.json'),
    env = {
      ...process.env,
      JOBHUNT_DATA_DIR: root,
      JOBHUNT_DISCOVERY_DIR: path.join(root, 'discovery'),
    };
  const receipt = JSON.parse(
    execFileSync(process.execPath, [CLI, 'validate', '--out=' + out], { env, encoding: 'utf8' })
  );
  assert.equal(path.resolve(receipt.file), path.resolve(out));
  const bytes = fs.readFileSync(out);
  assert.notEqual(bytes[0], 0xef);
  const value = JSON.parse(bytes.toString('utf8'));
  assert.equal(typeof value.revision, 'string');
  assert.equal(value.counts.job_pool, 0);
});
