'use strict';
(() => {
  const $ = (id) => document.getElementById(id),
    M = WorkbenchModel;
  let snapshot = null,
    view = 'overview',
    loading = false,
    writable = false;
  const el = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const btn = (text, fn, cls = 'btn') => {
    const b = el('button', text, cls);
    b.type = 'button';
    b.onclick = fn;
    return b;
  };
  const empty = (host, text) => host.append(el('p', text, 'empty'));
  const tag = (text, kind = '') => el('span', text, 'tag ' + kind);
  const eventTitle = (event) =>
    String(event.event_type || '')
      .replace(/\s*\[时间口径：(准确截止|估算截止|时间未知|固定安排)\]/g, '')
      .trim();
  const timingTag = (timing) =>
    tag(
      timing.kind,
      timing.kind === '估算截止' ? 'warning' : timing.kind === '时间未知' ? 'neutral' : ''
    );
  const jobs = () => snapshot?.tables.job_pool || [];
  const events = () => snapshot?.tables.follow_up || [];
  const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  function navigate(next) {
    if (!['overview', 'jobs', 'schedule'].includes(next)) next = 'overview';
    view = next;
    for (const name of ['overview', 'jobs', 'schedule']) $(name + '-view').hidden = name !== view;
    document.querySelectorAll('.nav-item').forEach((b) => {
      b.classList.toggle('active', b.dataset.view === view);
      b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false');
    });
    $('page-title').textContent = {
      overview: '把下一步，放在眼前。',
      jobs: '每一个机会，都有记录。',
      schedule: '按自己的节奏，向前一步。',
    }[view];
    history.replaceState(null, '', '#' + view);
  }
  function statusTag(job) {
    return tag(
      M.labels[job.status] || job.status || '状态未记录',
      M.group(job) === 'closed' ? 'neutral' : job.status === 'Blocked' ? 'warning' : ''
    );
  }
  function fillOptions(id, values, label) {
    const select = $(id),
      old = select.value;
    select.replaceChildren();
    const all = el('option', label);
    all.value = '';
    select.append(all);
    for (const value of [...new Set(values.filter(Boolean))].sort()) {
      const o = el('option', value);
      o.value = value;
      select.append(o);
    }
    if (values.includes(old)) select.value = old;
  }
  function displaySnapshot(result) {
    snapshot = result;
    $('load-status').hidden = true;
    $('last-updated').textContent =
      '最近读取 ' +
      new Date(result.read_status?.checked_at || Date.now()).toLocaleTimeString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
      });
    $('warnings').replaceChildren();
    for (const warning of snapshot.warnings || [])
      $('warnings').append(
        el(
          'p',
          [warning.company, warning.job_title, warning.message].filter(Boolean).join(' · '),
          'notice todo-warning'
        )
      );
    fillOptions(
      'job-family',
      jobs().map((j) => j.role_family),
      '全部方向'
    );
    fillOptions(
      'job-city',
      jobs().map((j) => j.location),
      '全部城市'
    );
    renderOverview();
    renderJobs();
    renderEvents();
    $('save-status').textContent = '本地已保存';
    TodoUI.render(snapshot, openEvent, reload, () => writable);
  }
  async function reload() {
    if (loading) return;
    loading = true;
    writable = false;
    $('refresh-btn').disabled = true;
    try {
      if (!snapshot) {
        try {
          const preview = await fetch('/api/snapshot/preview', { cache: 'no-store' });
          if (preview.status === 200) displaySnapshot(await preview.json());
        } catch {} // The normal read remains the authoritative path.
      }
      $('load-status').hidden = false;
      $('load-status').classList.remove('error');
      $('load-status').textContent = snapshot
        ? '已显示上次读取的副本，正在同步仓库；暂时只读…'
        : '正在同步并读取工作台…';
      $('save-status').textContent = '同步中，暂时只读';
      const response = await fetch('/api/snapshot', { cache: 'no-store' }),
        result = await response.json();
      if (!response.ok) throw Error(result.error || '读取失败');
      writable = result.read_status?.state !== 'local-fallback';
      displaySnapshot(result);
      if (!writable) {
        $('load-status').hidden = false;
        $('load-status').textContent = '仓库同步未完成，当前显示本地副本；请稍后刷新。';
        $('save-status').textContent = '本地副本，暂时只读';
      }
    } catch (error) {
      $('load-status').hidden = false;
      $('load-status').classList.add('error');
      $('load-status').textContent =
        (snapshot ? '刷新失败，当前仍显示上次数据：' : '读取失败：') + error.message;
    } finally {
      loading = false;
      $('refresh-btn').disabled = false;
    }
  }
  function renderOverview() {
    const counts = M.counts(jobs()),
      pending = TodoRules.sorted(events());
    $('stats').replaceChildren();
    for (const spec of [
      ['已投递', counts.active, '进行中的申请', 'active'],
      ['未投递', counts.waiting, '待投、暂缓与待确认', 'waiting'],
      ['已结束', counts.closed, 'Offer、被拒与已结束', 'closed'],
      ['未完成事项', pending.length, '测评、面试与其他安排', 'schedule'],
    ]) {
      const card = btn(
        '',
        () => {
          if (spec[3] === 'schedule') navigate('schedule');
          else {
            $('job-status').value = spec[3];
            renderJobs();
            navigate('jobs');
          }
        },
        'stat' + (spec[3] === 'schedule' ? ' emphasis' : '')
      );
      card.append(
        el('span', spec[0], 'label'),
        el('span', String(spec[1]), 'value'),
        el('small', spec[2])
      );
      $('stats').append(card);
    }
    $('nav-job-count').textContent = counts.all;
    $('nav-task-count').textContent = pending.length;
    $('action-list').replaceChildren();
    const upcoming = pending.filter((e) => M.timingParts(TodoRules.timing(e).at).day >= today());
    const older = pending
      .filter((e) => {
        const day = M.timingParts(TodoRules.timing(e).at).day;
        return day && day < today();
      })
      .reverse();
    const unknown = pending.filter((e) => !TodoRules.timing(e).at);
    for (const event of [...upcoming, ...older, ...unknown].slice(0, 5)) {
      const row = el('div', undefined, 'action-row'),
        main = el('div', undefined, 'row-main'),
        timing = TodoRules.timing(event);
      const heading = el('div', undefined, 'action-heading'),
        title = el('p', eventTitle(event), 'action-title'),
        meta = el('div', undefined, 'action-meta');
      title.title = event.event_type;
      heading.append(el('strong', event.company), timingTag(timing));
      const moment = M.timingParts(timing.at);
      meta.append(
        el(
          'span',
          moment.day ? [moment.day, moment.clock].filter(Boolean).join(' ') : '时间待确认',
          'event-date'
        ),
        btn('查看安排 →', () => navigate('schedule'), 'text-button')
      );
      main.append(heading, title, meta);
      row.append(main);
      $('action-list').append(row);
    }
    if (!pending.length) empty($('action-list'), '目前没有未完成事项。');
    $('week-list').replaceChildren();
    const begin = new Date(today() + 'T00:00:00+08:00');
    for (let n = 0; n < 7; n++) {
      const d = new Date(begin.getTime() + n * 86400000),
        date = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
      const row = el('div', undefined, 'week-day'),
        label = el('div', undefined, 'day-date'),
        items = el('div');
      label.append(
        el('strong', date.slice(8)),
        el(
          'span',
          n === 0
            ? '今天'
            : d.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'short' })
        )
      );
      const assigned = events().filter(
        (e) => !TodoRules.done(e) && M.timingParts(TodoRules.timing(e).at).day === date
      );
      for (const event of assigned) {
        const timing = TodoRules.timing(event),
          clock = M.timingParts(timing.at).clock,
          entry = el('div', undefined, 'day-event'),
          heading = el('div', undefined, 'day-event-heading'),
          title = el('p', eventTitle(event), 'day-event-title');
        title.title = event.event_type;
        heading.append(
          el('strong', event.company),
          el('span', clock || '未注明时刻', 'event-date')
        );
        entry.append(heading, title, el('span', timing.kind, 'day-event-kind'));
        items.append(entry);
      }
      if (assigned.length) row.classList.add('has-events');
      if (n === 0) row.classList.add('is-today');
      if (!assigned.length) items.append(el('span', '暂无安排', 'muted'));
      row.append(label, items);
      $('week-list').append(row);
    }
    $('recent-jobs').replaceChildren();
    const recent = jobs()
      .filter((j) => j.status === 'Submitted')
      .slice()
      .sort((a, b) =>
        M.submittedDate(b, snapshot.tables.application_log).localeCompare(
          M.submittedDate(a, snapshot.tables.application_log)
        )
      )
      .slice(0, 5);
    for (const job of recent) {
      const row = el('div', undefined, 'recent-row'),
        main = el('div', undefined, 'row-main');
      main.append(
        btn(job.company + ' · ' + job.job_title, () => openJob(job), 'row-link'),
        el('p', job.next_action || job.current_stage || '暂无下一步记录')
      );
      row.append(
        main,
        tag(M.submittedDate(job, snapshot.tables.application_log) || '日期未记录', 'neutral')
      );
      $('recent-jobs').append(row);
    }
    if (!recent.length) empty($('recent-jobs'), '尚无进行中的投递。');
  }
  function renderJobs() {
    if (!snapshot) return;
    const filtered = M.filter(jobs(), {
      query: $('job-search').value,
      status: $('job-status').value,
      family: $('job-family').value,
      city: $('job-city').value,
    });
    $('result-count').textContent = filtered.length + ' / ' + jobs().length + ' 个岗位';
    $('job-rows').replaceChildren();
    for (const job of filtered) {
      const row = el('tr'),
        identity = el('td'),
        status = el('td'),
        place = el('td'),
        next = el('td'),
        date = el('td');
      identity.append(
        btn(job.company, () => openJob(job), 'row-link'),
        el('p', job.job_title)
      );
      status.append(statusTag(job));
      place.append(el('span', job.location || '未记录'), el('p', job.role_family || '未分类'));
      next.append(el('div', job.next_action || job.current_stage || '暂无记录', 'clamp'));
      date.textContent = M.submittedDate(job, snapshot.tables.application_log) || '—';
      row.append(identity, status, place, next, date);
      $('job-rows').append(row);
    }
    if (!filtered.length) {
      const row = el('tr'),
        cell = el('td', '没有符合筛选条件的岗位。');
      cell.colSpan = 5;
      row.append(cell);
      $('job-rows').append(row);
    }
  }
  function section(host, title, value) {
    const box = el('section', undefined, 'detail-section');
    box.append(el('h3', title), el('pre', value || '未记录'));
    host.append(box);
  }
  function openJob(job) {
    $('detail-title').textContent = job.company + ' · ' + job.job_title;
    const body = $('detail-body');
    body.replaceChildren();
    const actions = el('div', undefined, 'detail-actions');
    actions.append(
      statusTag(job),
      btn('编辑备注 / 下一步', () => openNotes(job)),
      btn('更新进度', () => openStatus(job))
    );
    const link = M.safeLink(job.job_url);
    if (link) {
      const a = el('a', '岗位官网', 'btn');
      a.href = link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      actions.append(a);
    }
    body.append(actions);
    const grid = el('div', undefined, 'detail-grid');
    for (const [label, value] of [
      ['地点', job.location],
      ['岗位方向', job.role_family],
      ['投递日期', M.submittedDate(job, snapshot.tables.application_log)],
      ['简历版本', job.resume_variant],
      ['匹配等级', job.match_grade],
      ['证据匹配度（非录用率）', job.match_estimate],
      ['额度说明', job.application_limit],
      ['志愿顺序', job.preference_order],
    ]) {
      const cell = el('div', undefined, 'detail-field');
      cell.append(el('span', label), el('div', value || '未记录'));
      grid.append(cell);
    }
    body.append(grid);
    section(body, '下一步', job.next_action);
    section(body, '备注', job.notes);
    section(body, '完整岗位说明', job.job_description);
    const related = events()
      .filter((e) => TodoRules.jobIds(e).includes(job.job_id))
      .sort((a, b) => a.date.localeCompare(b.date));
    section(
      body,
      '日程记录',
      related
        .map((e) =>
          [e.date, e.time, e.event_type, TodoRules.done(e) ? '已结束' : '未完成', e.notes]
            .filter(Boolean)
            .join(' · ')
        )
        .join('\n\n')
    );
    section(
      body,
      '申请记录',
      snapshot.tables.application_log
        .filter((l) => l.job_id === job.job_id)
        .map((l) =>
          [l.attempt_date, l.status, l.submission_evidence, l.notes].filter(Boolean).join(' · ')
        )
        .join('\n\n')
    );
    if (!$('detail-dialog').open) $('detail-dialog').showModal();
  }
  function field(label, name, value = '', type = 'text', options) {
    const wrapper = el('label', label),
      input = el(options ? 'select' : type === 'textarea' ? 'textarea' : 'input');
    input.name = name;
    if (options) {
      for (const [v, t] of options) {
        const o = el('option', t);
        o.value = v;
        input.append(o);
      }
    } else if (type === 'textarea') input.rows = 5;
    else input.type = type;
    input.value = value || '';
    wrapper.append(input);
    $('editor-fields').append(wrapper);
    return input;
  }
  function editor(title, build, save) {
    if (loading || !writable) {
      $('load-status').hidden = false;
      $('load-status').textContent = '请先完成仓库同步，再修改记录。';
      return;
    }
    const revision = snapshot.revision;
    $('editor-title').textContent = title;
    $('editor-fields').replaceChildren();
    $('editor-error').textContent = '';
    $('editor-save').disabled = false;
    build();
    $('editor-form').onsubmit = async (e) => {
      e.preventDefault();
      $('editor-save').disabled = true;
      try {
        await save(new FormData($('editor-form')), revision);
        $('editor-dialog').close();
        $('detail-dialog').close();
        await reload();
      } catch (error) {
        $('editor-error').textContent = error.message;
        $('editor-save').disabled = false;
      }
    };
    if (!$('editor-dialog').open) $('editor-dialog').showModal();
  }
  async function post(route, payload) {
    if (loading || !writable) throw Error('请先完成仓库同步，再保存记录。');
    const response = await fetch(route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
      result = await response.json();
    if (!response.ok)
      throw Error(
        response.status === 409
          ? '数据已在别处更新。本次输入已保留；请核对最新记录后重新编辑。'
          : result.error || '保存失败'
      );
    return result;
  }
  function openNotes(job) {
    editor(
      '编辑备注 / 下一步',
      () => {
        field('备注', 'notes', job.notes, 'textarea');
        field('下一步', 'next_action', job.next_action, 'textarea');
      },
      (f, revision) =>
        post('/api/job/notes', {
          job_id: job.job_id,
          expected_revision: revision,
          notes: f.get('notes'),
          next_action: f.get('next_action'),
        })
    );
  }
  function openStatus(job) {
    editor(
      '登记岗位进度',
      () => {
        $('editor-fields').append(
          el('p', '请按已经确认的实际结果登记。提交成功由助手核对凭据后记录。', 'muted')
        );
        field('状态', 'status', '', null, [
          ['', '请选择实际状态'],
          ...['Offer', 'Rejected', 'Ended', 'Skipped', 'Deferred', 'Pending'].map((v) => [
            v,
            M.labels[v],
          ]),
        ]).required = true;
      },
      (f, revision) =>
        post('/api/update-status', {
          job_id: job.job_id,
          expected_revision: revision,
          status: f.get('status'),
        })
    );
  }
  function openEvent(event = null) {
    if (!snapshot) return;
    editor(
      event ? '编辑日程' : '添加日程',
      () => {
        const job = field('关联岗位', 'job_id', event?.job_id || '', null, [
          ['', '选择一个已有岗位'],
          ...jobs().map((j) => [j.job_id, j.company + ' · ' + j.job_title]),
        ]);
        job.required = true;
        if (event) job.disabled = true;
        field(
          '日期（日程日期；时间未知时为收到邀请的日期）',
          'date',
          event?.date || today(),
          'date'
        ).required = true;
        field('时间（可留空）', 'time', event?.time || '', 'time');
        field('事件内容', 'event_type', event?.event_type || '').required = true;
        field(
          '时间口径',
          'timing',
          event ? TodoRules.timing(event).kind : '固定安排',
          null,
          ['固定安排', '准确截止', '估算截止', '时间未知'].map((v) => [v, v])
        );
        field('截止时间（按来源填写，可留空）', 'deadline', event?.deadline || '').placeholder =
          '例如 2026-09-30 19:00';
        field('对应环节', 'stage', event?.stage ?? '', null, [
          ['', '普通日程'],
          ['0', '投递'],
          ['1', '笔试 / 测评'],
          ['2', '一面'],
          ['3', '二面'],
          ['4', '三面'],
          ['5', 'Offer'],
        ]);
        field('环节状态', 'stage_status', event?.stage_status || '1', null, [
          ['1', '待参加'],
          ['6', '已完成，待通知'],
          ['4', '已通过'],
          ['5', '被拒'],
          ['3', '放弃'],
          ['2', '已完成，无后续反馈'],
        ]);
        field('安排及来源说明', 'notes', event?.notes || '', 'textarea');
      },
      (f, revision) => {
        const stage = f.get('stage'),
          notes = String(f.get('notes'))
            .replace(/\[时间口径：(准确截止|估算截止|时间未知|固定安排)\]/g, '')
            .trim();
        return post(event ? '/api/calendar/update' : '/api/calendar/add', {
          expected_revision: revision,
          job_id: event?.job_id || f.get('job_id'),
          ...(event ? { event_id: event.event_id } : {}),
          date: f.get('date'),
          time: f.get('time'),
          event_type: f.get('event_type'),
          stage,
          stage_status: stage ? f.get('stage_status') : '',
          status: event?.status || 'Scheduled',
          deadline: f.get('deadline'),
          notes: [notes, '[时间口径：' + f.get('timing') + ']'].filter(Boolean).join('\n'),
        });
      }
    );
  }
  function renderEvents() {
    $('event-list').replaceChildren();
    for (const event of events()
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date))) {
      const row = el('div', undefined, 'event-row'),
        text = el('div', undefined, 'row-main'),
        actions = el('div', undefined, 'event-actions');
      text.append(
        el('strong', event.company + ' · ' + event.event_type),
        el(
          'p',
          [event.date, event.time, TodoRules.timing(event).kind].filter(Boolean).join(' · '),
          'muted'
        )
      );
      actions.append(
        btn('编辑', () => openEvent(event)),
        btn('删除', () =>
          editor(
            '删除日程',
            () => {
              $('editor-fields').append(
                el(
                  'p',
                  '确认删除「' +
                    event.company +
                    ' · ' +
                    event.event_type +
                    '」这条日程？此操作只调整日程记录。'
                )
              );
            },
            (_, revision) =>
              post('/api/calendar/delete', {
                expected_revision: revision,
                job_id: event.job_id,
                event_id: event.event_id,
              })
          )
        )
      );
      row.append(text, actions);
      $('event-list').append(row);
    }
    if (!events().length) empty($('event-list'), '暂无日程。');
  }
  for (const b of document.querySelectorAll('[data-view]'))
    b.onclick = () => navigate(b.dataset.view);
  for (const b of document.querySelectorAll('[data-close]'))
    b.onclick = () => b.closest('dialog').close();
  for (const id of ['job-search', 'job-status', 'job-family', 'job-city'])
    $(id).addEventListener(id === 'job-search' ? 'input' : 'change', renderJobs);
  $('refresh-btn').onclick = reload;
  $('add-event').onclick = () => openEvent();
  $('overview-add-event').onclick = () => openEvent();
  $('today').textContent = new Date().toLocaleDateString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
  });
  try {
    document.documentElement.dataset.theme =
      localStorage.getItem('career-workbench-theme') ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  } catch {}
  $('theme-toggle').onclick = () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('career-workbench-theme', next);
    } catch {}
  };
  window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));
  navigate(location.hash.slice(1));
  reload();
})();
