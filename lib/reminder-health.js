'use strict';
// 提醒任务的运行状态：最近一次运行、最近一次微信推送成功、最近一次错误。
// remind.js 写入，行动摘要读取；计划任务的控制台输出看不见，靠它发现推送长期失败。
const fs = require('node:fs');
const path = require('node:path');

const HOUR = 3600000;

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function record(file, patch, now = new Date()) {
  try {
    const next = { ...read(file), ...patch, updated_at: new Date(now).toISOString() };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', 'utf8');
  } catch {}
}

// 没有任何记录时不报警（新环境或从未发送过）；有记录且 24 小时内没有成功推送才提示
function assess(health, now = new Date()) {
  const okAt = Date.parse(health.last_wechat_ok_at || '');
  const hours = Number.isFinite(okAt) ? Math.round((new Date(now) - okAt) / HOUR) : null;
  const warnings = [];
  if (health.last_run_at && (hours === null || hours > 24))
    warnings.push(hours === null ? '微信推送从未成功' : `微信推送已 ${hours} 小时没有成功`);
  if (health.last_error && Date.parse(health.last_error.at) > (okAt || 0))
    warnings.push(`提醒任务最近一次出错：${health.last_error.message}`);
  return {
    last_run_at: health.last_run_at || null,
    last_wechat_ok_at: health.last_wechat_ok_at || null,
    hours_since_wechat_ok: hours,
    last_error: health.last_error || null,
    status: warnings.length ? 'attention' : health.last_run_at ? 'ok' : 'unknown',
    warnings,
  };
}

module.exports = { read, record, assess };
