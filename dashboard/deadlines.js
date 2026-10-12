/* Pure deadline summary; no IO, notifications, credentials or clock mutation. */
'use strict';
const { done, timing } = require('./todo');
const HOUR = 3600000;
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
  if (!Number.isFinite(now.getTime())) throw new Error('Invalid summary clock');
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
// 待投岗位的网申截止只写在 job_pool.deadline（自由文本，如“2026-10-25（简历接收截止）”），
// 不在 follow_up 里。取开头的日期转成截止事项，与日程一起参与会话摘要；已有同日日程的岗位不重复
const OPEN_JOB = new Set(['Pending', 'Deferred', 'Blocked']);
function jobDeadlineEvents(jobs = [], events = []) {
  const covered = new Set(
    events
      .filter((e) => !done(e))
      .map((e) => e.job_id + '|' + String(e.deadline || e.date || '').slice(0, 10))
  );
  const out = [];
  for (const job of jobs) {
    if (!OPEN_JOB.has(job.status)) continue;
    const m = String(job.deadline || '').match(
      /^\s*(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:\s*([01]?\d|2[0-3]):([0-5]\d))?/
    );
    if (!m) continue;
    const date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    if (covered.has(job.job_id + '|' + date)) continue;
    const time = m[4] ? `${m[4].padStart(2, '0')}:${m[5]}` : '';
    out.push({
      event_id: 'job-deadline:' + job.job_id,
      job_id: job.job_id,
      company: job.company,
      job_title: job.job_title,
      event_type: '网申截止（待投岗位）',
      date,
      time,
      deadline: time ? `${date} ${time}` : date,
      next_action: `截止前投递，或改为 Skipped/Deferred（当前 ${job.status}，档位 ${job.match_grade || '未评'}）`,
      status: '',
      stage_status: '',
    });
  }
  return out;
}
module.exports = { HOUR, parseInstant, deadlineOf, collectEvents, jobDeadlineEvents };
