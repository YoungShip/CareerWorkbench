'use strict';
// MCP 工具的业务实现：不依赖 SDK，便于单测；server.js 只负责 schema 与注册。
const crypto = require('node:crypto');
const { createTrackerService } = require('../lib/tracker-service');
const { createDiscoveryStore } = require('../discovery/store');
const { queryDiscovery, buildDiscoveryNext } = require('../discovery/view');

// 这些操作需要浏览器侧证据或本人明确指令，只允许走 CLI 与对应 Skill，不经 MCP 暴露。
const BLOCKED_OPERATIONS = {
  'job.delete': '删除岗位须本人明确要求并先处理线上记录，请走 CLI 流程',
  'sync.ack': '同步回执必须来自 OfferNotes 写后读回结果，请用 tracker-cli sync-ack',
};
const TOKEN_TTL_MS = 10 * 60 * 1000;

// 键排序后的稳定序列化：同一计划无论字段顺序如何，摘要一致。
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .filter((k) => value[k] !== undefined)
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}

function createPreviewTokens({
  secret = crypto.randomBytes(32),
  now = () => Date.now(),
  ttlMs = TOKEN_TTL_MS,
} = {}) {
  const sign = (issued, plan) =>
    crypto
      .createHmac('sha256', secret)
      .update(issued + '\n' + canonical(plan))
      .digest('hex');
  return {
    issue(plan) {
      const issued = String(now());
      return issued + '.' + sign(issued, plan);
    },
    // 令牌绑定完整计划（含 expected_revision）：计划被改、主表已变或超时都会失效。
    verify(token, plan) {
      const m = /^(\d+)\.([0-9a-f]{64})$/.exec(String(token || ''));
      if (!m)
        throw Error(
          'Missing or malformed preview_token: call tracker_preview with this exact plan first'
        );
      const age = now() - Number(m[1]);
      if (age < 0 || age > ttlMs) throw Error('preview_token expired: preview the plan again');
      const expected = Buffer.from(sign(m[1], plan), 'hex'),
        actual = Buffer.from(m[2], 'hex');
      if (!crypto.timingSafeEqual(expected, actual))
        throw Error(
          'preview_token does not match this plan: the plan changed after preview, preview it again'
        );
    },
  };
}

function assertAllowed(plan) {
  for (const op of plan.operations || []) {
    if (BLOCKED_OPERATIONS[op.type])
      throw Error(op.type + ' is not available via MCP: ' + BLOCKED_OPERATIONS[op.type]);
  }
}

// 读回本次改动字段：job.patch / job.add 涉及的字段加上身份字段，避免只看到默认投影。
function readbackFields(plan) {
  const fields = new Set(['job_id', 'company', 'job_title', 'status']);
  for (const op of plan.operations || []) {
    const changed = op.type === 'job.patch' ? op.patch : op.type === 'job.add' ? op.record : null;
    for (const key of Object.keys(changed || {})) fields.add(key);
  }
  return [...fields];
}

function createToolHandlers(options = {}) {
  const service = options.service || createTrackerService(options),
    store = service.store;
  const tokens = options.tokens || createPreviewTokens(options);
  const discovery = () => createDiscoveryStore(service.paths.discoveryRoot).snapshot();
  return {
    brief: ({ limit = 8 } = {}) => service.brief({ limit }),
    rules: () => service.rules(),
    validate: () => service.validate(),
    query: (args = {}) =>
      store.query({
        job_ids: args.job_ids || [],
        fields: args.fields || [],
        company: args.company,
        status: args.status,
        include_description: !!args.include_description,
        with_events: args.with_events !== false,
      }),
    discoveryNext: ({ limit = 8, horizon_hours = 168 } = {}) =>
      buildDiscoveryNext(discovery(), { limit, horizonHours: horizon_hours }),
    discoveryQuery: (args = {}) =>
      queryDiscovery(discovery(), {
        lead_ids: args.lead_ids || [],
        states: args.states || [],
        fields: args.fields || [],
        company: args.company,
        limit: args.limit,
      }),
    preview({ plan }) {
      assertAllowed(plan);
      const result = store.commit(plan, true);
      return {
        ...result,
        preview_token: tokens.issue(plan),
        token_ttl_seconds: TOKEN_TTL_MS / 1000,
        next: '核对 changed_jobs 与 warnings 后，把同一个 plan 与 preview_token 交给 tracker_apply；计划有任何改动都要重新预览',
      };
    },
    apply({ plan, preview_token }) {
      assertAllowed(plan);
      tokens.verify(preview_token, plan);
      const result = store.commit(plan);
      const readback = result.changed_jobs.length
        ? store.query({ job_ids: result.changed_jobs, fields: readbackFields(plan) })
        : null;
      return {
        ...result,
        readback,
        sync: result.changed_jobs.length
          ? '改动已进入 sync_queue（pending），线上 OfferNotes 尚未同步，需按 offernotes-sync 处理'
          : '本次未改变岗位记录，未新增岗位同步项；既有队列状态仍以完整核查为准',
      };
    },
  };
}

module.exports = {
  createToolHandlers,
  createPreviewTokens,
  canonical,
  BLOCKED_OPERATIONS,
  TOKEN_TTL_MS,
};
