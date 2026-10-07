/* Shared display and completion rules; all writes still pass through store.js. */
(function (root) {
  'use strict';
  const outcomes = { '6': '已完成，等待结果', '4': '本环节已通过', '2': '已完成，无后续反馈' };
  function jobIds(e) {
    const related = e.related_job_ids ? JSON.parse(e.related_job_ids) : [];
    if (
      !Array.isArray(related) ||
      related.some((id) => typeof id !== 'string' || !id) ||
      new Set(related).size !== related.length ||
      related.includes(e.job_id)
    )
      throw Error('共享岗位关联格式无效');
    return [e.job_id, ...related];
  }
  function done(e) {
    return e.status === 'Completed' || ['2', '3', '4', '5', '6'].includes(String(e.stage_status));
  }
  function timing(e) {
    const text = [e.event_type, e.notes].join('\n');
    const explicit = [
      ...text.matchAll(/\[时间口径：(准确截止|估算截止|时间未知|固定安排)\]/g),
    ].pop()?.[1];
    const type = String(e.event_type || '');
    const unknown =
      /无(?:明确)?截止|未(?:明确|公布|提供|给出).*截止|截止.*(?:未知|未明确|未公布|无)|邀请收到/.test(
        type
      );
    const kind =
      explicit ||
      (/参考上限|估算/.test(type)
        ? '估算截止'
        : e.deadline
          ? '准确截止'
          : unknown
            ? '时间未知'
            : /截止/.test(type)
              ? '准确截止'
              : '固定安排');
    return {
      kind,
      at: kind === '时间未知' ? '' : e.deadline || [e.date, e.time].filter(Boolean).join(' '),
    };
  }
  function sorted(events) {
    return events
      .filter((e) => !done(e))
      .slice()
      .sort((a, b) => {
        const x = timing(a).at,
          y = timing(b).at;
        return !x ? (!y ? 0 : 1) : !y ? -1 : x.localeCompare(y);
      });
  }
  function completion(s, p) {
    const e = s.tables.follow_up.find((e) => e.event_id === p.event_id && e.job_id === p.job_id);
    if (!e) throw Error('找不到对应日程，请刷新');
    if (done(e)) throw Error('该事项已完成，请刷新查看');
    if (!outcomes[p.outcome]) throw Error('请选择完成结果');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.date || '') || Number.isNaN(Date.parse(p.date)))
      throw Error('请填写实际完成日期');
    if (p.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(p.time)) throw Error('完成时间格式不正确');
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    if (p.date > today) throw Error('完成日期不能在未来');
    if (!String(p.evidence || '').trim()) throw Error('请填写完成凭据或本人确认说明');
    const notes = [
      e.notes,
      '原安排：' + e.date + ' ' + (e.time || '') + '；' + e.event_type,
      '完成登记：' + p.date + ' ' + (p.time || '时间未记录') + '；' + outcomes[p.outcome],
      '凭据／本人说明：' + p.evidence.trim(),
    ]
      .filter(Boolean)
      .join('\n');
    const record = {
      date: p.date,
      time: p.time || '',
      event_type: e.event_type,
      notes,
      status: 'Completed',
      stage: e.stage || '',
      stage_status: e.stage ? p.outcome : '',
      deadline: e.deadline || '',
    };
    const ops = [{ type: 'event.patch', job_id: e.job_id, event_id: e.event_id, record }];
    const shared = jobIds(e).length > 1;
    for (const id of jobIds(e)) {
      const job = s.tables.job_pool.find((j) => j.job_id === id);
      if (!job) throw Error('关联岗位不存在，请刷新');
      if (job.status !== 'Submitted') continue;
      const others = s.tables.follow_up.filter(
        (x) => x.event_id !== e.event_id && jobIds(x).includes(id)
      );
      const pending = sorted(others),
        hasStage = e.stage !== '' && e.stage != null;
      const later =
        hasStage &&
        others.some((x) => x.stage !== '' && x.stage != null && Number(x.stage) > Number(e.stage));
      const patch = {
        notes: [
          job.notes,
          (shared ? '共享事项 ' : '事项 ') +
            e.event_id +
            '：' +
            p.date +
            ' ' +
            outcomes[p.outcome] +
            '；凭据／本人说明：' +
            p.evidence.trim(),
        ]
          .filter(Boolean)
          .join('\n'),
      };
      // Ordinary reminders do not define a recruitment stage; older completions
      // must not overwrite summaries of an already recorded later round.
      if (hasStage && !later) {
        const label = ['投递', '测评', '一面', '二面', '三面', 'Offer'][Number(e.stage)];
        patch.current_stage = (shared ? '共享' : '') + label + '：' + outcomes[p.outcome];
        patch.next_action = pending.length ? '处理：' + pending[0].event_type : outcomes[p.outcome];
      }
      ops.push({ type: 'job.patch', job_id: id, patch });
    }
    return ops;
  }
  const api = { jobIds, done, timing, sorted, completion, outcomes };
  if (typeof module !== 'undefined') module.exports = api;
  else root.TodoRules = api;
})(typeof window !== 'undefined' ? window : this);
