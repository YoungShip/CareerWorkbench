(function () {
  'use strict';
  const el = (tag, text) => {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const labels = { pending: '待同步', error: '同步失败', synced: '已同步' };
  function render(s, edit, reload) {
    let host = document.getElementById('todo-home');
    if (!host) {
      host = el('section');
      host.id = 'todo-home';
      host.className = 'calendar-section';
      document.getElementById('sync-status').after(host);
    }
    host.replaceChildren();
    host.append(el('h2', '测评与面试待办'));
    const tasks = TodoRules.sorted(s.tables.follow_up),
      jobs = s.tables.job_pool;
    host.append(
      el(
        'p',
        tasks.length + ' 项未完成 · 时间均为北京时间。截止时间不是开考时间；未知期限事项单独列出。'
      )
    );
    if (!tasks.length) host.append(el('p', '目前没有未完成事项。'));
    for (const e of tasks) {
      const card = el('article');
      card.className = 'todo-card';
      const t = TodoRules.timing(e);
      card.append(el('h3', e.company + ' · ' + e.event_type));
      card.append(
        el(
          'p',
          TodoRules.jobIds(e)
            .map((id) => jobs.find((j) => j.job_id === id)?.job_title || id)
            .join(' ／ ')
        )
      );
      if (TodoRules.jobIds(e).length > 1)
        card.append(
          el('p', '已关联 ' + TodoRules.jobIds(e).length + ' 个岗位 · 登记完成将同时更新关联岗位')
        );
      const line = el('p', t.kind + (t.at ? '：' + t.at : '，请核实邀请原文'));
      const cutoff =
        t.at &&
        Date.parse(
          t.at.replace(' ', 'T') +
            (t.at.length === 10 ? 'T23:59:59+08:00' : t.at.length === 16 ? ':00+08:00' : '+08:00')
        );
      if (cutoff && cutoff < Date.now()) {
        line.append(
          ' · ' + (t.kind === '估算截止' ? '参考时间已过，需核实' : '时间已过，完成情况待登记')
        );
        line.className = 'todo-warning';
      }
      card.append(line);
      if (/共享|共用|两岗.*一次/.test(e.event_type + ' ' + e.notes))
        card.append(el('p', '共享测评：此事项只登记一次，其他岗位共用成绩的说明见下方原记录。'));
      const details = el('details');
      details.append(el('summary', '查看安排与来源说明'), el('pre', e.notes || '暂无补充说明'));
      card.append(details);
      const row = el('div');
      row.className = 'form-actions';
      const complete = el('button', '登记完成');
      complete.className = 'btn btn-primary';
      complete.onclick = () => showCompletion(e, s, card, reload);
      const change = el('button', '编辑安排');
      change.className = 'btn';
      change.onclick = () => edit(e);
      row.append(complete, change);
      card.append(row);
      host.append(card);
    }
    const history = el('details');
    history.append(
      el(
        'summary',
        '已完成 / 已结束事项（' + s.tables.follow_up.filter(TodoRules.done).length + '）'
      )
    );
    for (const e of s.tables.follow_up
      .filter(TodoRules.done)
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date))) {
      const item = el('details');
      item.append(
        el(
          'summary',
          e.company + ' · ' + e.date + ' · ' + (TodoRules.outcomes[e.stage_status] || '已结束')
        ),
        el('pre', e.notes || e.event_type)
      );
      history.append(item);
    }
    host.append(history);
    if (s.offernotes_sync === false) return;
    const sync = el('details');
    sync.id = 'sync-details';
    sync.append(el('summary', 'OfferNotes 同步明细'));
    sync.append(
      el('p', '网页修改先保存到本地；有登录态的 AI 会话处理待同步项。刷新可读取最新回执。')
    );
    const rows = s.tables.sync_queue
      .slice()
      .sort((a, b) => (a.state === 'synced') - (b.state === 'synced'));
    for (const q of rows) {
      const j = jobs.find((j) => j.job_id === q.job_id);
      sync.append(
        el(
          'p',
          (j ? j.company + ' · ' + j.job_title : q.job_id) +
            '：' +
            (labels[q.state] || q.state) +
            (q.error ? ' — ' + q.error : '') +
            (q.synced_at
              ? ' · 最近成功 ' +
                new Date(q.synced_at).toLocaleString('zh-CN', {
                  timeZone: 'Asia/Shanghai',
                  hour12: false,
                })
              : '')
        )
      );
    }
    host.append(sync);
  }
  function showCompletion(e, s, card, reload) {
    if (card.querySelector('form')) return;
    const form = el('form');
    form.className = 'calendar-form';
    form.append(el('h4', '登记实际完成情况'));
    if (TodoRules.jobIds(e).length > 1)
      form.append(
        el(
          'p',
          '本次完成登记同时关联：' +
            TodoRules.jobIds(e)
              .map((id) => s.tables.job_pool.find((j) => j.job_id === id)?.job_title || id)
              .join('、')
        )
      );
    function field(label, type, name) {
      const l = el('label', label),
        i = el('input');
      i.type = type;
      i.name = name;
      l.append(i);
      form.append(l);
      return i;
    }
    const date = field('实际完成日期', 'date', 'date');
    date.required = true;
    date.max = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const time = field('完成时间（不确定可留空）', 'time', 'time');
    const label = el('label', '本环节结果'),
      select = el('select');
    for (const [value, text] of Object.entries(TodoRules.outcomes)) {
      const option = el('option', text);
      option.value = value;
      select.append(option);
    }
    select.value = '6';
    label.append(select);
    form.append(label);
    const proof = el('label', '完成凭据或本人确认说明'),
      evidence = el('textarea');
    evidence.required = true;
    evidence.rows = 3;
    evidence.placeholder = '例如：本人确认于上述日期完成，或完成页截图的本地路径';
    proof.append(evidence);
    form.append(proof);
    const error = el('p');
    error.setAttribute('role', 'alert');
    form.append(error);
    const save = el('button', '保存完成记录');
    save.type = 'submit';
    save.className = 'btn btn-primary';
    const cancel = el('button', '取消');
    cancel.type = 'button';
    cancel.className = 'btn';
    cancel.onclick = () => form.remove();
    form.append(save, cancel);
    form.onsubmit = async (ev) => {
      ev.preventDefault();
      save.disabled = true;
      try {
        const response = await fetch('/api/calendar/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            job_id: e.job_id,
            event_id: e.event_id,
            expected_revision: s.revision,
            date: date.value,
            time: time.value,
            outcome: select.value,
            evidence: evidence.value,
          }),
        });
        const r = await response.json();
        if (!response.ok) throw Error(r.error || '保存失败');
        await reload();
      } catch (err) {
        error.textContent = err.message;
        save.disabled = false;
      }
    };
    card.append(form);
    date.focus();
  }
  window.TodoUI = { render };
})();
