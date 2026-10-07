/* Pure reminder decisions; no IO, notifications, credentials or clock mutation. */
'use strict';
const { done, timing } = require('../dashboard/todo');
const crypto = require('node:crypto');
const HOUR = 3600000;
const PRIORITY = Object.freeze({ CRITICAL: 100, HIGH: 80, MEDIUM: 60, ROUTINE: 40 });
const THRESHOLDS = Object.freeze([
  { id: '2h', hours: 2, priority: 100, title: '2 小时内到期' },
  { id: '24h', hours: 24, priority: 80, title: '24 小时内到期' },
]);
function parseInstant(raw) {
  const text = String(raw || '').trim();
  const m = text.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(\.\d{1,3})?)?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)?)?$/
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, s, ms, zone] = m;
  const day = new Date(Date.UTC(+y, +mo - 1, +d));
  if (
    +y < 1900 ||
    day.getUTCFullYear() !== +y ||
    day.getUTCMonth() !== +mo - 1 ||
    day.getUTCDate() !== +d
  )
    return null;
  if (zone && /14:(?!00)/.test(zone)) return null;
  const at = new Date(
    `${y}-${mo}-${d}T${h ?? '23'}:${mi ?? '59'}:${s ?? '00'}${ms || ''}${zone || '+08:00'}`
  );
  return Number.isFinite(at.getTime())
    ? { at, precision: h === undefined ? 'date' : 'minute', source: text }
    : null;
}
function deadlineOf(event) {
  const t = timing(event);
  if (t.kind === '时间未知') return null;
  if (t.kind === '固定安排' && !event.time && !event.deadline) return null;
  const parsed = parseInstant(t.at);
  if (!parsed) return null;
  return { ...parsed, kind: t.kind, assumed_time: parsed.precision === 'date' };
}
function collectEvents(events, now = new Date()) {
  now = new Date(now);
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid reminder clock');
  const result = {
    overdue: [],
    soon: [],
    noDeadline: [],
    later_count: 0,
    nowText: now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
  };
  for (const event of events) {
    if (done(event)) continue;
    const dl = deadlineOf(event);
    const item = {
      company: event.company,
      title: event.job_title,
      event: event.event_type,
      date: event.date,
      time: event.time,
      deadline: event.deadline || '',
      next: event.next_action || '',
      job_id: event.job_id,
      event_id: event.event_id,
    };
    if (!dl) {
      const t = timing(event);
      item.reason = t.at ? 'invalid_or_incomplete_time' : 'time_unknown';
      result.noDeadline.push(item);
      continue;
    }
    const remaining = dl.at.getTime() - now.getTime();
    Object.assign(item, {
      remaining_ms: remaining,
      diffH: Math.round((remaining / HOUR) * 10) / 10,
      at: dl.at.toISOString(),
      atText: dl.at.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }),
      timing_kind: dl.kind,
      precision: dl.precision,
      assumed_time: dl.assumed_time,
    });
    if (remaining < 0) result.overdue.push(item);
    else if (remaining <= 72 * HOUR) result.soon.push(item);
    else result.later_count++;
  }
  for (const key of ['overdue', 'soon'])
    result[key].sort((a, b) => a.remaining_ms - b.remaining_ms);
  return result;
}
function receiptKey(item, threshold) {
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([item.event_id || [item.job_id, item.company, item.event], item.at, threshold])
    )
    .digest('hex');
}
function normalizeState(input) {
  // Old fired timestamps preceded sending and cannot prove delivery.
  if (input && input.version !== undefined && input.version !== 2)
    throw new Error('Unsupported reminder state version');
  const valid = input && input.version === 2;
  if (
    valid &&
    (!input.delivered || typeof input.delivered !== 'object' || Array.isArray(input.delivered))
  )
    throw new Error('Invalid reminder receipts');
  if (valid)
    for (const records of Object.values(input.delivered)) {
      if (
        !records ||
        typeof records !== 'object' ||
        Array.isArray(records) ||
        Object.values(records).some(
          (v) => !v || typeof v !== 'object' || !Number.isFinite(Date.parse(v.sent_at))
        )
      )
        throw new Error('Invalid reminder receipt entry');
    }
  return { version: 2, delivered: valid ? JSON.parse(JSON.stringify(input.delivered)) : {} };
}
function planDue(report, state, channel) {
  const normalized = normalizeState(state),
    receipts = normalized.delivered[channel] || {};
  const groups = new Map();
  function add(item, threshold) {
    const key = receiptKey(item, threshold.id);
    if (receipts[key]) return;
    if (!groups.has(threshold.id)) groups.set(threshold.id, { ...threshold, items: [] });
    groups.get(threshold.id).items.push({ ...item, receipt_key: key });
  }
  for (const item of report.soon) {
    const threshold = THRESHOLDS.find(
      (t) => item.remaining_ms >= 0 && item.remaining_ms <= t.hours * HOUR
    );
    if (threshold) add(item, threshold);
  }
  for (const item of report.overdue) {
    if (item.remaining_ms >= -30 * 24 * HOUR && String(item.next || '').trim())
      add(item, { id: 'overdue', priority: 60, title: '已过期待补救' });
  }
  return [...groups.values()].sort((a, b) => b.priority - a.priority);
}
function acknowledge(state, channel, group, now = new Date()) {
  const next = normalizeState(state);
  if (!['wechat', 'toast'].includes(channel)) throw new Error('Unsupported delivery channel');
  if (!next.delivered[channel]) next.delivered[channel] = {};
  const receipts = next.delivered[channel];
  for (const item of group.items) {
    const value = {
      sent_at: new Date(now).toISOString(),
      due_at: item.at,
      event_id: item.event_id || '',
      threshold: group.id,
    };
    receipts[receiptKey(item, group.id)] = value;
    if (group.id === '2h')
      receipts[receiptKey(item, '24h')] = { ...value, threshold: '24h', subsumed_by: '2h' };
  }
  for (const records of Object.values(next.delivered))
    for (const [key, value] of Object.entries(records)) {
      const stamp = Date.parse(value.sent_at);
      if (Number.isFinite(stamp) && new Date(now).getTime() - stamp > 31 * 24 * HOUR)
        delete records[key];
    }
  return next;
}
function deliverySucceeded(channel, response) {
  return channel === 'toast'
    ? /^TOAST_OK\b/.test(String(response))
    : /^WECHAT_OK(?:\b|（)/.test(String(response)) || response === 'WECHAT_ALREADY_SENT';
}
async function deliverDue(report, inputState, options) {
  let state = normalizeState(inputState);
  const results = [];
  for (const channel of options.channels) {
    if (!['wechat', 'toast'].includes(channel)) throw new Error('Unsupported delivery channel');
    for (const group of planDue(report, state, channel)) {
      let response;
      if (options.dryRun) response = 'DRY_RUN';
      else {
        try {
          response = await options.send(channel, group);
        } catch {
          response = 'DELIVERY_FAILED';
        }
        if (deliverySucceeded(channel, response)) {
          state = acknowledge(state, channel, group, options.now);
          await options.persist(state);
        }
      }
      results.push({ channel, threshold: group.id, count: group.items.length, response });
    }
  }
  return { state, results };
}
module.exports = {
  HOUR,
  PRIORITY,
  THRESHOLDS,
  parseInstant,
  deadlineOf,
  collectEvents,
  receiptKey,
  normalizeState,
  planDue,
  acknowledge,
  deliverySucceeded,
  deliverDue,
};
