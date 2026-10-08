/* Read-only action summary. A policy finding is a review request, never a write plan. */
'use strict';
const crypto = require('node:crypto');
const { collectEvents, jobDeadlineEvents } = require('../scripts/reminder-core');
function currentSection(text, heading = '选岗规则') {
  const lines = String(text)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const start = lines.findIndex((line) => line.trim() === '## ' + heading);
  if (start < 0) return null;
  const tail = lines.slice(start + 1),
    end = tail.findIndex((line) => /^##\s/.test(line));
  return (end < 0 ? tail : tail.slice(0, end)).join('\n').trim();
}
function checkPolicy(policy, text) {
  if (!policy) return { status: 'missing', rules: [] };
  const section = currentSection(text, policy.source_heading);
  const hash =
    section === null ? null : crypto.createHash('sha256').update(section, 'utf8').digest('hex');
  const valid =
    policy.schema_version === 1 &&
    policy.mode === 'review_only' &&
    Array.isArray(policy.review_rules) &&
    policy.review_rules.every(
      (r) =>
        r &&
        typeof r.id === 'string' &&
        typeof r.reason === 'string' &&
        Array.isArray(r.statuses) &&
        Array.isArray(r.grades) &&
        r.statuses.every((x) => typeof x === 'string') &&
        r.grades.every((x) => typeof x === 'string')
    );
  if (!valid) return { status: 'invalid', section_sha256: hash, rules: [] };
  if (!hash || hash !== policy.section_sha256)
    return { status: 'stale', section_sha256: hash, rules: [] };
  return {
    status: 'current',
    section_sha256: hash,
    source: policy.source_relative,
    rules: policy.review_rules,
  };
}
function buildBrief(
  snapshot,
  {
    policy,
    policyText = '',
    now = new Date(),
    limit = 8,
    discovery = null,
    extraWarnings = [],
    reminderHealth = null,
  } = {}
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw Error('limit must be an integer from 1 to 100');
  const tables = snapshot.tables,
    jobs = tables.job_pool,
    report = collectEvents(
      [...tables.follow_up, ...jobDeadlineEvents(jobs, tables.follow_up)],
      now
    );
  const active = checkPolicy(policy, policyText),
    findings = [];
  for (const job of jobs)
    for (const rule of active.rules) {
      if (
        rule.statuses.includes(job.status) &&
        rule.grades.includes(
          String(job.match_grade || '')
            .trim()
            .toUpperCase()
        )
      )
        findings.push({
          job_id: job.job_id,
          company: job.company,
          job_title: job.job_title,
          status: job.status,
          grade: job.match_grade,
          rule_id: rule.id,
          reason: rule.reason,
        });
    }
  const grouped = (rows) => ({
    total: rows.length,
    items: rows.slice(0, limit),
    truncated: rows.length > limit,
  });
  const count = (rows, field) =>
    rows.reduce(
      (r, x) => ((r[x[field] || 'unknown'] = (r[x[field] || 'unknown'] || 0) + 1), r),
      {}
    );
  const pending = jobs.filter((j) => j.status === 'Pending'),
    jobsById = new Map(jobs.map((job) => [job.job_id, job]));
  const syncRows = tables.sync_queue
    .filter((row) => row.state !== 'synced')
    .map((row) => {
      const job = jobsById.get(row.job_id) || {};
      return {
        job_id: row.job_id,
        company: job.company || '',
        job_title: job.job_title || '',
        state: row.state,
        updated_at: row.updated_at || '',
        error: row.error || '',
      };
    });
  const discoveryDeadlines = discovery?.deadline_attention || grouped([]);
  const nextSteps = [];
  if (report.soon.length) nextSteps.push('先处理可行动的临期事项');
  if (discoveryDeadlines.total)
    nextSteps.push('复核尚未研究但临近截止的公司线索；文本提取日期必须回官方来源确认');
  if (findings.length) nextSteps.push('确认待投规则冲突，不自动取消或提交');
  if (syncRows.length) nextSteps.push(`处理 ${syncRows.length} 条待同步/错误队列并完成线上读回`);
  if (reminderHealth?.status === 'attention')
    nextSteps.push(
      '提醒通道异常：' + reminderHealth.warnings.join('；') + '（见 logs/remind.log）'
    );
  nextSteps.push('需要详情再按job_id query；写入前snapshot/preview/apply/读回');
  return {
    revision: snapshot.revision,
    generated_at: new Date(now).toISOString(),
    read_only: true,
    counts: {
      jobs: jobs.length,
      statuses: count(jobs, 'status'),
      pending_grades: count(pending, 'match_grade'),
      sync_queue: count(tables.sync_queue, 'state'),
      discovery: discovery?.counts || null,
    },
    urgent: grouped(report.soon),
    overdue_followup: grouped(report.overdue.filter((x) => String(x.next || '').trim())),
    overdue_without_action_count: report.overdue.filter((x) => !String(x.next || '').trim()).length,
    time_needs_confirmation: grouped(report.noDeadline),
    discovery_deadlines: discoveryDeadlines,
    sync_attention: grouped(syncRows),
    reminder_health: reminderHealth,
    policy: {
      ...active,
      rules: undefined,
      review_only: true,
      message:
        active.status === 'current'
          ? '复核清单不修改岗位，不授权投递'
          : '规则来源已变化或未配置；先人工复核派生筛查规则，不能当作无冲突',
    },
    pending_review: grouped(findings),
    requires_user_confirmation: true,
    next_steps: nextSteps,
    warnings: [...(snapshot.warnings || []), ...extraWarnings],
  };
}
module.exports = { currentSection, checkPolicy, buildBrief };
