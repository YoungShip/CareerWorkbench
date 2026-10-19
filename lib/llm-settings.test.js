'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLlmSettings } = require('./llm-settings');

function setup(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobmatch-settings-'));
  const file = path.join(dir, 'secrets', 'llm.json');
  fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(
    file,
    '\uFEFF' +
      JSON.stringify({
        active: 'cpa',
        custom: { preserve: true },
        providers: {
          cpa: {
            base_url: 'http://127.0.0.1:8317/v1',
            model: 'fixture-model',
            api_key: 'fixture-cpa-secret',
            max_output_tokens: 16384,
            price_per_million_tokens_cny: { input: 1, output: 2 },
          },
          qwen: { model: 'fixture-qwen-model', api_key: 'fixture-qwen-secret' },
        },
      })
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { JOBMATCH_PRIVATE_DIR: dir, ...extra.env };
  const service = createLlmSettings({ ...extra, env });
  const input = (changes = {}) => ({
    expected_revision: service.view().revision,
    provider: 'cpa',
    base_url: 'https://example.invalid/v1',
    model: 'new-fixture-model',
    api_key: '',
    ...changes,
  });
  return {
    file,
    service,
    input,
    read: () => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')),
  };
}

test('settings never return stored keys; blank keys and unrelated options survive a save', (t) => {
  const { file, service, input, read } = setup(t);
  const initial = read(),
    before = service.view();
  assert.equal(before.providers.cpa.key_source, 'file');
  assert.equal(before.providers.cpa.has_api_key, true);
  assert.equal(before.providers.deepseek.base_url, 'https://api.deepseek.com');
  assert.doesNotMatch(JSON.stringify(before), /fixture-cpa-secret|fixture-qwen-secret/);
  const payload = input(),
    saved = service.save(payload);
  assert.equal(saved.active, 'cpa');
  assert.equal(saved.providers.cpa.model, 'new-fixture-model');
  assert.doesNotMatch(JSON.stringify(saved), /fixture-cpa-secret|fixture-qwen-secret/);
  assert.deepEqual(read(), {
    ...initial,
    providers: {
      ...initial.providers,
      cpa: {
        ...initial.providers.cpa,
        base_url: payload.base_url,
        model: payload.model,
      },
    },
  });
  assert.notEqual(saved.revision, before.revision);
  const bytes = fs.readFileSync(file, 'utf8');
  assert.throws(() => service.save(payload), { httpStatus: 409 });
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  const switched = service.save(input({ provider: 'qwen', model: 'other-model' }));
  assert.equal(switched.active, 'qwen');
  assert.equal(read().providers.qwen.api_key, 'fixture-qwen-secret');
});

test('connection test uses unsaved fields and environment key precedence without saving', async (t) => {
  let captured;
  const { file, service, input, read } = setup(t, {
    env: { CPA_API_KEY: 'fixture-environment-secret' },
    request: async (url, options) => {
      captured = { url, options };
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
        }),
      };
    },
  });
  assert.equal(service.view().providers.cpa.key_source, 'environment');
  const bytes = fs.readFileSync(file, 'utf8');
  const payload = input({ api_key: 'replacement-fixture-secret' });
  const result = await service.test(payload);
  assert.equal(result.ok, true);
  assert.equal(captured.url, 'https://example.invalid/v1/chat/completions');
  assert.equal(captured.options.headers.Authorization, 'Bearer fixture-environment-secret');
  assert.equal(captured.options.redirect, 'error');
  assert.equal(JSON.parse(captured.options.body).model, 'new-fixture-model');
  assert.deepEqual(JSON.parse(captured.options.body).messages, [
    { role: 'user', content: '只返回 JSON：{"ok":true}' },
  ]);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  service.save(payload);
  assert.equal(read().providers.cpa.api_key, 'replacement-fixture-secret');
  assert.equal(service.view().providers.cpa.key_source, 'environment');
  assert.doesNotMatch(
    JSON.stringify(service.view()),
    /replacement-fixture-secret|fixture-environment-secret/
  );
});

test('invalid configuration is rejected before any file mutation or model call', async (t) => {
  const { file, service, input } = setup(t, { request: () => assert.fail('unexpected API call') });
  const bytes = fs.readFileSync(file, 'utf8');
  for (const invalid of [
    { provider: 'unknown' },
    { base_url: 'not a URL' },
    { base_url: 'file:///tmp/config' },
    { base_url: 'https://user:pass@example.invalid/v1' },
    { base_url: 'https://example.invalid/v1?token=fixture' },
    { base_url: 'https://example.invalid/v1/chat/completions' },
    { model: '' },
    { api_key: 'abc\ndef' },
  ]) {
    assert.throws(() => service.save(input(invalid)), { httpStatus: 400 });
    await assert.rejects(service.test(input(invalid)), { httpStatus: 400 });
  }
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});

test('connection failures do not expose upstream bodies, keys or exception messages', async (t) => {
  for (const request of [
    async () => ({ ok: false, status: 401, json: () => assert.fail('must not read error body') }),
    async () => {
      throw Error('fixture-cpa-secret');
    },
    async () => ({ ok: true, json: async () => ({ error: 'fixture-cpa-secret' }) }),
    async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'length' }],
      }),
    }),
  ]) {
    const { service, input } = setup(t, { request });
    await assert.rejects(service.test(input()), (error) => {
      assert.equal(error.httpStatus, 502);
      assert.doesNotMatch(error.message, /fixture-cpa-secret/);
      return true;
    });
  }
});

test('missing configuration can be created with a key; missing keys and corrupt JSON remain explicit errors', (t) => {
  const { file, service, input, read } = setup(t);
  fs.unlinkSync(file);
  assert.equal(service.view().active, 'deepseek');
  assert.throws(() => service.save(input()), /密钥/);
  service.save(input({ api_key: 'new-fixture-key' }));
  assert.equal(read().providers.cpa.api_key, 'new-fixture-key');
  fs.writeFileSync(file, 'invalid fixture-cpa-secret');
  assert.throws(() => service.view(), /不是有效 JSON/);
});
