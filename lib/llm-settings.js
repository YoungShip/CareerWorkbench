'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const providers = {
  deepseek: {
    base_url: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    env: 'DEEPSEEK_API_KEY',
  },
  qwen: {
    base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    env: 'DASHSCOPE_API_KEY',
  },
  cpa: { base_url: 'http://127.0.0.1:8317/v1', model: '', env: 'CPA_API_KEY' },
};
function fail(message, httpStatus = 400) {
  throw Object.assign(new Error(message), { httpStatus });
}
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function createLlmSettings({
  projectDir = path.resolve(__dirname, '..'),
  env = process.env,
  request = fetch,
} = {}) {
  const file = path.join(
    env.JOBMATCH_PRIVATE_DIR || path.join(env.JOBHUNT_PROJECT_DIR || projectDir, 'data', 'private'),
    'secrets',
    'llm.json'
  );
  function read() {
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    let data;
    try {
      data = text ? JSON.parse(text.replace(/^\uFEFF/, '')) : {};
    } catch {
      fail('模型配置文件不是有效 JSON，请先修复文件。');
    }
    if (!object(data) || (data.providers !== undefined && !object(data.providers)))
      fail('模型配置文件格式有误。');
    return { data, revision: hash(text) };
  }
  function view(state = read()) {
    const active = state.data.active || 'deepseek';
    if (!Object.hasOwn(providers, active)) fail('当前服务项不受支持。');
    return {
      revision: state.revision,
      active,
      providers: Object.fromEntries(
        Object.entries(providers).map(([name, defaults]) => {
          const item = state.data.providers?.[name] || {};
          if (!object(item)) fail('模型服务配置格式有误。');
          return [
            name,
            {
              base_url: item.base_url || defaults.base_url,
              model: item.model || defaults.model,
              has_api_key: typeof item.api_key === 'string' && Boolean(item.api_key.trim()),
              key_source: env[defaults.env] ? 'environment' : item.api_key ? 'file' : 'missing',
              key_env: defaults.env,
            },
          ];
        })
      ),
    };
  }
  function prepare(input) {
    const state = read();
    if (input.expected_revision !== state.revision)
      fail('配置已被其他程序修改，请关闭设置后重新打开。', 409);
    if (!Object.hasOwn(providers, input.provider)) fail('请选择支持的模型服务。');
    const { provider } = input;
    for (const name of ['base_url', 'model', 'api_key'])
      if (typeof input[name] !== 'string') fail('接口地址、模型和密钥必须为文本。');
    const base_url = input.base_url.trim().replace(/\/+$/, ''),
      model = input.model.trim();
    if (base_url.length > 2048 || /[\x00-\x20\x7f]/.test(base_url))
      fail('接口地址不能包含空格或控制字符。');
    let url;
    try {
      url = new URL(base_url);
    } catch {
      fail('请输入完整的 HTTP 或 HTTPS 接口基础地址。');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      fail('接口地址须为 HTTP 或 HTTPS 基础地址，不包含账号、查询参数或片段。');
    if (/\/(chat\/completions|responses)\/?$/.test(url.pathname))
      fail('请填写基础地址，不要追加 /chat/completions 或 /responses。');
    if (!model || model.length > 256 || /[\x00-\x1f\x7f]/.test(model))
      fail('请填写有效的模型 ID。');
    const api_key = input.api_key.trim();
    if (api_key.length > 8192 || /[\x00-\x1f\x7f]/.test(api_key)) fail('密钥格式有误。');
    const previous = state.data.providers?.[provider] || {};
    if (!object(previous)) fail('模型服务配置格式有误。');
    const key = env[providers[provider].env] || api_key || previous.api_key;
    if (typeof key !== 'string' || !key.trim()) fail('请填写 API 密钥，或设置对应环境变量。');
    return { ...state, provider, base_url, model, api_key, key: key.trim(), previous };
  }
  function save(input) {
    const state = prepare(input),
      data = state.data;
    data.active = state.provider;
    data.providers = {
      ...data.providers,
      [state.provider]: {
        ...state.previous,
        base_url: state.base_url,
        model: state.model,
        ...(state.api_key ? { api_key: state.api_key } : {}),
      },
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + crypto.randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
      if (read().revision !== state.revision) fail('配置已更新，请重新打开设置。', 409);
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    return { ok: true, ...view() };
  }
  async function test(input) {
    const state = prepare(input),
      started = Date.now();
    let response;
    try {
      response = await request(state.base_url + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + state.key },
        body: JSON.stringify({
          model: state.model,
          messages: [{ role: 'user', content: '只返回 JSON：{"ok":true}' }],
          temperature: 0,
          max_tokens: 128,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
    } catch (error) {
      if (['TimeoutError', 'AbortError'].includes(error.name))
        fail('连接测试超时，请检查接口地址和服务状态。', 504);
      fail('无法连接模型服务，请检查地址、网络和服务状态。', 502);
    }
    if (!response.ok)
      fail('模型接口返回 HTTP ' + response.status + '，请检查地址、密钥、模型权限或额度。', 502);
    let valid = false;
    try {
      const reply = await response.json(),
        choice = reply.choices?.[0];
      valid =
        choice?.finish_reason !== 'length' && JSON.parse(choice?.message?.content)?.ok === true;
    } catch {}
    if (!valid) fail('接口已响应，但未返回预期的 JSON 测试结果，请检查接口和模型是否兼容。', 502);
    return { ok: true, elapsed_ms: Date.now() - started };
  }
  return { view, save, test };
}
module.exports = { createLlmSettings };
