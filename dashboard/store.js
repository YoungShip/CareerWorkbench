// Shared transactional CSV store for the CLI and the local dashboard.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { jobIds: eventJobIds } = require('./todo');
const { validateMatchingArtifact, defaultRuntime } = require('../discovery/research');
const { offernotesSyncEnabled } = require('../lib/offernotes');
const TABLES = [
  'job_pool',
  'application_log',
  'follow_up',
  'daily_dashboard',
  'blocker_queue',
  'resume_rules',
  'automation_rules',
  'sync_queue',
];
const HEADERS = {
  blocker_queue: [
    'date',
    'company',
    'job_title',
    'blocker_type',
    'details',
    'retry_strategy',
    'user_action_needed',
    'status',
  ],
  resume_rules: [
    'role_family',
    'resume_file_path',
    'use_for_titles',
    'avoid_for_titles',
    'tailor_threshold',
    'notes',
  ],
  automation_rules: [
    'date',
    'rule_category',
    'rule',
    'reason',
    'source_blocker_or_lesson',
    'status',
  ],
  job_pool: [
    'job_id',
    'company',
    'job_title',
    'status',
    'application_date',
    'job_url',
    'location',
    'resume_variant',
    'role_family',
    'priority',
    'match_grade',
    'match_estimate',
    'deadline',
    'application_limit',
    'preference_order',
    'next_action',
    'notes',
    'job_description',
    'research_file',
    'matching_file',
    'cohort_match_status',
    'current_stage',
    'source',
    'date_found',
    'skip_reason',
    'blocker',
    'legacy_row',
    'legacy_status',
    'legacy_record',
    'offernotes_id',
  ],
  application_log: [
    'log_id',
    'job_id',
    'attempt_date',
    'company',
    'job_title',
    'job_url',
    'platform',
    'status',
    'submission_evidence',
    'resume_used',
    'answers_used',
    'confirmation_url',
    'confirmation_text',
    'notes',
    'job_description',
  ],
  follow_up: [
    'event_id',
    'job_id',
    'related_job_ids',
    'date',
    'time',
    'company',
    'job_title',
    'event_type',
    'stage',
    'stage_status',
    'contact',
    'channel',
    'deadline',
    'next_action',
    'status',
    'notes',
  ],
  sync_queue: ['job_id', 'change_id', 'state', 'updated_at', 'synced_at', 'error'],
  daily_dashboard: [
    'date',
    'found_count',
    'submitted_count',
    'skipped_count',
    'blocked_count',
    'needs_user_count',
    'pending_count',
    'deferred_count',
    'ended_count',
    'top_sources',
    'summary',
    'user_actions_needed',
  ],
};
const STATUSES = [
  'Submitted',
  'Pending',
  'Deferred',
  'Needs user',
  'Blocked',
  'Skipped',
  'Ended',
  'Offer',
  'Rejected',
];
function fail(message, status = 400) {
  const e = new Error(message);
  e.httpStatus = status;
  throw e;
}
function parseCSV(text) {
  const rows = [];
  let row = [],
    field = '',
    quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') field += c;
  }
  if (quoted) fail('CSV contains an unclosed quote');
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift() || [];
  if (new Set(header).size !== header.length) fail('Duplicate CSV headers');
  return {
    header,
    rows: rows
      .filter((r) => r.length !== 1 || r[0] !== '')
      .map((r) => {
        if (r.length !== header.length) fail('CSV column count mismatch');
        return Object.fromEntries(header.map((k, i) => [k, r[i]]));
      }),
  };
}
function csv(table) {
  return (
    [table.header, ...table.rows.map((r) => table.header.map((k) => r[k] ?? ''))]
      .map((row) => row.map((v) => '"' + String(v).replace(/"/g, '""') + '"').join(','))
      .join('\r\n') + '\r\n'
  );
}
function atomic(file, content) {
  const temp = file + '.tmp-' + crypto.randomUUID();
  try {
    fs.writeFileSync(temp, content);
    fs.renameSync(temp, file);
  } catch (error) {
    try {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    } catch {}
    throw error;
  }
}
function id(prefix) {
  return prefix + '_' + crypto.randomUUID();
}

// 登记相关的元数据字段：只用于本次校验与留痕，不是 job_pool 的列，
// 写入前必须剥离，否则会触发 "Unknown job field"。
const REGISTRATION_META = [
  'registration',
  'registration_reason',
  'selected_position_id',
  'position_job_map',
];

// 研究岗位登记许可（薄层校验，复用 discovery 的受信任校验器，不新建一套校验器）。
//
// 背景：通用 job.add 只检查身份、字段和初始状态，任何调用方都能把没有 matching_file
// 的岗位登记为 Pending。这里对"新研究岗位 → 待投"这条标准路径补上可执行约束。
//
// 两类明确路径，必须显式区分、可追溯，不做静默兜底：
//   1) research：带 matching_file 的研究岗位。必须真实验证通过，且用户选中的
//      position_id 位于该记录的 readiness.registerable_position_ids。
//   2) manual：人工直接登记（新线索、历史补录）。必须显式声明 registration:'manual'
//      并给出 registration_reason，写入 source 以便审计。
// 历史岗位的备注/测评/面试/提交证据维护走 job.patch、log.add、event.*，不经过这里，
// 因此不受影响。
// 主表只接受 UTF-8：Excel 在中文系统上另存为 CSV 会变成 GBK，按 UTF-8 宽松读取会把中文静默变成乱码，
// 下一次写入和每晚备份会把乱码固化下来。读到非法字节就停下，提示用 UTF-8 重新保存。
const UTF8 = new TextDecoder('utf-8', { fatal: true });
function readUtf8(file) {
  try {
    return UTF8.decode(fs.readFileSync(file));
  } catch (e) {
    if (e instanceof TypeError)
      throw Error(
        `${path.basename(file)} is not valid UTF-8 (saved by Excel as GBK?); re-save it as UTF-8 CSV`
      );
    throw e;
  }
}
// 项目里的 tmp/ 是临时目录，登记证据放进去会随清理丢失（2026-10-07 的自动清理删过一次）
const SCRATCH_DIR = /[\\/](?:CareerWorkbench|lapis-cv|JobHuntBot)[\\/]tmp[\\/]/i;
function checkRegistration(op, runtime) {
  const record = op.record || {};
  // Runtime belongs to trusted startup code, never to the plan being checked.
  if (
    Object.prototype.hasOwnProperty.call(op, 'runtime') ||
    Object.prototype.hasOwnProperty.call(record, 'runtime')
  ) {
    fail('runtime is trusted startup configuration; it is not allowed in operations or records');
  }
  const kind = op.registration ?? record.registration;
  if (kind === undefined || kind === null || kind === '') {
    fail(
      'New research positions require registration:"research" with a verified matching_file, or an explicit registration:"manual" with a reason'
    );
  }
  if (!['research', 'manual'].includes(kind)) fail('Unknown registration kind: ' + kind);

  if (kind === 'manual') {
    const reason = String(op.registration_reason ?? record.registration_reason ?? '').trim();
    if (!reason) fail('Manual registration requires an explicit registration_reason');
    if (record.matching_file)
      fail(
        'Manual registration must not claim a matching_file; use registration:"research" so it is verified'
      );
    return `manual: ${reason}`;
  }

  // --- research 路径 ---
  const matchingFile = record.matching_file;
  if (!matchingFile) fail('Research registration requires matching_file');
  if (!path.isAbsolute(matchingFile)) fail('matching_file must be an absolute path');
  if (SCRATCH_DIR.test(matchingFile))
    fail(
      'matching_file must not live in a project tmp/ scratch directory; move the research record to its permanent location first'
    );
  const selected = op.selected_position_id ?? record.selected_position_id;
  if (typeof selected !== 'string' || !selected.trim())
    fail('Research registration requires the user-selected selected_position_id');
  // 明确 position_id 与主表 job_id 的映射：不假设两个 ID 天然相同。
  // 研究侧用 position_id，主表用 job_id；只有显式声明映射时才允许不一致。
  const mapped = op.position_job_map ?? record.position_job_map;
  const expectedJobId = (mapped && typeof mapped === 'object' && mapped[selected]) || selected;
  if (expectedJobId !== op.job_id)
    fail(
      `job_id must map to the selected position_id (expected ${expectedJobId}, got ${op.job_id})`
    );

  let outcome;
  try {
    outcome = validateMatchingArtifact({ matching_file: matchingFile }, runtime);
  } catch (error) {
    const summary = error.validation_summary;
    const detail = summary ? `readiness=${summary.readiness?.status || 'unknown'}` : '';
    fail(
      `Research registration requires a verified matching record${detail ? ` (${detail})` : ''}: ${error.message}`
    );
  }
  const readiness = outcome.summary.readiness || {};
  // 不能把 pipeline 退出码 0 / status=completed 当作匹配通过：只认 readiness 的登记许可。
  if (readiness.can_register_selected_position !== true)
    fail('Matching record does not permit registering the selected position');
  const allowed = Array.isArray(readiness.registerable_position_ids)
    ? readiness.registerable_position_ids
    : [];
  if (!allowed.includes(selected))
    fail(`selected_position_id ${selected} is not in registerable_position_ids`);
  return `research: matching=${matchingFile} position=${selected} readiness=${readiness.status}`;
}

function createStore(root = __dirname, options = {}) {
  // Capture a copy once. Only the trusted caller may configure the verifier.
  const registrationRuntime = Object.freeze({ ...defaultRuntime(), ...(options.runtime || {}) });
  const internal = path.join(root, '.store'),
    lock = path.join(internal, 'lock'),
    journal = path.join(internal, 'journal.json'),
    backupKeepDays = options.backupKeepDays ?? 30,
    offernotesSync = options.offernotesSync ?? offernotesSyncEnabled();
  fs.mkdirSync(internal, { recursive: true });
  function locked(fn) {
    try {
      fs.mkdirSync(lock);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner;
      try {
        owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
      } catch {
        fail('Store lock is being acquired; retry shortly', 409);
      }
      try {
        process.kill(owner.pid, 0);
        fail('Another process is updating the tracker; retry shortly', 409);
      } catch (e2) {
        if (e2.code !== 'ESRCH') throw e2;
      }
      fs.rmSync(lock, { recursive: true });
      fs.mkdirSync(lock);
    }
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
    try {
      recover();
      return fn();
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }
  function recover() {
    if (!fs.existsSync(journal)) return;
    const j = JSON.parse(fs.readFileSync(journal, 'utf8'));
    for (const name of TABLES) {
      const p = path.join(j.backup, name + '.csv'),
        target = path.join(root, name + '.csv');
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p);
        if (!fs.existsSync(target) || !fs.readFileSync(target).equals(content))
          atomic(target, content);
      } else if (fs.existsSync(target)) fs.unlinkSync(target);
    }
    fs.unlinkSync(journal);
  }
  function raw() {
    const state = {};
    for (const name of TABLES) {
      const p = path.join(root, name + '.csv');
      state[name] = fs.existsSync(p)
        ? parseCSV(readUtf8(p))
        : { header: HEADERS[name] || [], rows: [] };
    }
    return state;
  }
  function revision(s) {
    return crypto
      .createHash('sha256')
      .update(TABLES.map((n) => n + '\n' + csv(s[n])).join('\n'))
      .digest('hex');
  }
  function validate(s) {
    const jobs = s.job_pool.rows,
      remoteIds = new Set(),
      jobIds = new Set();
    for (const r of jobs) {
      if (!r.job_id || jobIds.has(r.job_id)) fail('Missing/duplicate job_id');
      jobIds.add(r.job_id);
      if (!r.company || !r.job_title) fail('Company and job title required');
      if (!STATUSES.includes(r.status)) fail('Unknown status: ' + r.status);
      if (r.offernotes_id) {
        if (remoteIds.has(r.offernotes_id)) fail('Duplicate OfferNotes ID');
        remoteIds.add(r.offernotes_id);
      }
    }
    for (const [name, key] of [
      ['application_log', 'log_id'],
      ['follow_up', 'event_id'],
      ['sync_queue', 'job_id'],
    ]) {
      const ids = new Set();
      for (const r of s[name].rows) {
        if (!r[key] || ids.has(r[key])) fail('Missing/duplicate ' + key + ' in ' + name);
        ids.add(r[key]);
        if (!jobIds.has(r.job_id)) fail('Orphan job_id in ' + name);
      }
    }
    for (const r of s.application_log.rows)
      if (
        r.status === 'Submitted' &&
        !r.submission_evidence &&
        !r.confirmation_url &&
        !r.confirmation_text
      )
        fail('Submission evidence required');
    for (const r of s.follow_up.rows) {
      for (const linked of eventJobIds(r)) {
        const target = jobs.find((j) => j.job_id === linked);
        if (!target) fail('Unknown shared job_id');
        if (target.company !== jobs.find((j) => j.job_id === r.job_id).company)
          fail('Shared event must link jobs in the same company');
      }
      if (r.date && !validDate(r.date)) fail('Invalid event date');
      if (r.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time)) fail('Invalid event time');
      if (r.stage && !/^[0-5]$/.test(r.stage)) fail('Invalid stage');
      if (r.stage_status && !/^[1-6]$/.test(r.stage_status)) fail('Invalid stage status');
    }
  }
  function save(s, oldRevision) {
    validate(s);
    const previous = raw();
    if (revision(previous) !== oldRevision)
      fail('Files changed outside the store; reload before writing', 409);
    const backup = path.join(
      internal,
      'backups',
      new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomUUID()
    );
    fs.mkdirSync(backup, { recursive: true });
    for (const n of TABLES) {
      const p = path.join(root, n + '.csv');
      if (fs.existsSync(p)) fs.copyFileSync(p, path.join(backup, n + '.csv'));
    }
    atomic(journal, JSON.stringify({ backup }));
    try {
      for (const n of TABLES) {
        const target = path.join(root, n + '.csv');
        if (!fs.existsSync(target) || csv(previous[n]) !== csv(s[n])) atomic(target, csv(s[n]));
      }
      const reread = raw();
      validate(reread);
      if (revision(reread) !== revision(s)) fail('Write verification failed');
      fs.unlinkSync(journal);
    } catch (e) {
      recover();
      throw e;
    }
    try {
      pruneBackups();
    } catch {}
    return { revision: revision(s), backup };
  }
  // Every commit snapshots all tables, so backups grow without bound. Keep every
  // snapshot from the last backupKeepDays days and, for older days, only the last
  // snapshot of each day. Runs after the journal is gone, inside the write lock.
  function pruneBackups(now = Date.now()) {
    const dir = path.join(internal, 'backups');
    if (!fs.existsSync(dir)) return [];
    const names = fs
      .readdirSync(dir)
      .filter((n) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/.test(n))
      .sort();
    const lastOfDay = new Map(names.map((n) => [n.slice(0, 10), n]));
    const keep = new Set(lastOfDay.values());
    const cutoff = now - backupKeepDays * 86400000;
    const removed = [];
    for (const n of names) {
      const at = Date.parse(n.slice(0, 10) + 'T' + n.slice(11, 19).replace(/-/g, ':') + 'Z');
      if (keep.has(n) || !(at < cutoff)) continue;
      fs.rmSync(path.join(dir, n), { recursive: true, force: true });
      removed.push(n);
    }
    return removed;
  }
  function warnings(s) {
    const groups = new Map();
    for (const job of s.job_pool.rows) {
      const key = JSON.stringify([job.company.trim(), job.job_title.trim()]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(job);
    }
    return [...groups.values()]
      .filter((jobs) => jobs.length > 1)
      .map((jobs) => ({
        code: 'possible_duplicate_jobs',
        job_ids: jobs.map((j) => j.job_id),
        message:
          '同公司同名岗位，请依据官方岗位编号、部门及批次核实；城市或链接不同不能单独证明是不同申请。',
        company: jobs[0].company,
        job_title: jobs[0].job_title,
      }));
  }
  function snapshot() {
    return locked(() => {
      const s = raw();
      validate(s);
      return {
        revision: revision(s),
        tables: Object.fromEntries(TABLES.map((n) => [n, s[n].rows])),
        warnings: warnings(s),
        offernotes_sync: offernotesSync,
      };
    });
  }

  // Consistent CSV text of every table under the store lock, for off-site backups.
  function exportCsv() {
    return locked(() => {
      const s = raw();
      validate(s);
      return {
        revision: revision(s),
        files: Object.fromEntries(TABLES.map((n) => [n + '.csv', csv(s[n])])),
      };
    });
  }

  // 精简字段投影：常规维护只需身份、状态、待办与排期，不需要完整 JD 和历史字段。
  // job_description（约 14 万字符）、legacy_record、legacy_row、notes 默认不返回。
  const SLIM_FIELDS = [
    'job_id',
    'company',
    'job_title',
    'status',
    'application_date',
    'deadline',
    'next_action',
    'location',
    'match_grade',
    'role_family',
    'resume_variant',
    'current_stage',
    'cohort_match_status',
    'offernotes_id',
    'job_url',
  ];
  const HEAVY_FIELDS = ['job_description', 'legacy_record', 'legacy_row', 'notes'];

  // 按 job_id / 公司查询并做字段投影。内部仍读取并校验**完整状态**，
  // 因此 revision 与全量 snapshot 完全一致（同一个整体 revision 语义）；
  // 减少的只是返回给调用方的内容，不减少写入前的校验。
  // 需要 JD 时用 include_description:true 或读取全量 snapshot。
  function query(options = {}) {
    return locked(() => {
      const s = raw();
      validate(s);
      const rev = revision(s);
      const all = s.job_pool.rows;
      let jobs = all;
      if (Array.isArray(options.job_ids) && options.job_ids.length)
        jobs = jobs.filter((j) => options.job_ids.includes(j.job_id));
      if (options.company) jobs = jobs.filter((j) => j.company === options.company);
      if (options.status) jobs = jobs.filter((j) => j.status === options.status);
      const fields =
        Array.isArray(options.fields) && options.fields.length ? options.fields : SLIM_FIELDS;
      for (const f of fields) if (!s.job_pool.header.includes(f)) fail('Unknown job field: ' + f);
      const keep = new Set(fields);
      if (options.include_description)
        for (const f of HEAVY_FIELDS) if (s.job_pool.header.includes(f)) keep.add(f);
      const projected = jobs.map((j) =>
        Object.fromEntries(Object.entries(j).filter(([k]) => keep.has(k)))
      );
      // 必要关联事件：主关联与 related_job_ids 附加关联都算，保证共享测评不被漏掉
      let events = [];
      if (options.with_events !== false) {
        const selected = new Set(jobs.map((j) => j.job_id));
        events = s.follow_up.rows
          .filter((e) => eventJobIds(e).some((id) => selected.has(id)))
          .map((e) =>
            options.include_description
              ? e
              : Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'notes'))
          );
      }
      const payload = {
        revision: rev,
        jobs: projected,
        events,
        counts: { matched: jobs.length, total: all.length, events: events.length },
      };
      const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
      payload.meta = {
        utf8_bytes: bytes,
        fields: [...keep],
        truncated: jobs.length < all.length || !options.include_description,
      };
      return payload;
    });
  }
  function summary(s) {
    const counts = {};
    for (const r of s.job_pool.rows) counts[r.status] = (counts[r.status] || 0) + 1;
    const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    const row = {
      date,
      found_count: String(s.job_pool.rows.length),
      submitted_count: String(counts.Submitted || 0),
      skipped_count: String(counts.Skipped || 0),
      blocked_count: String(counts.Blocked || 0),
      needs_user_count: String(counts['Needs user'] || 0),
      pending_count: String(counts.Pending || 0),
      deferred_count: String(counts.Deferred || 0),
      ended_count: String((counts.Ended || 0) + (counts.Offer || 0) + (counts.Rejected || 0)),
      summary: '当前岗位池快照（非当日新增数）',
    };
    s.daily_dashboard.header = [
      ...new Set([...s.daily_dashboard.header, ...HEADERS.daily_dashboard]),
    ];
    const i = s.daily_dashboard.rows.findIndex((r) => r.date === date);
    if (i < 0) s.daily_dashboard.rows.push(row);
    else s.daily_dashboard.rows[i] = { ...s.daily_dashboard.rows[i], ...row };
  }
  function commit(plan, dryRun = false) {
    return locked(() => {
      if (Object.prototype.hasOwnProperty.call(plan, 'runtime'))
        fail('runtime is trusted startup configuration; it is not allowed in plans');
      const s = raw(),
        before = revision(s);
      validate(s);
      if (plan.expected_revision !== before)
        fail('Revision conflict: reload and preview again', 409);
      const changes = new Set();
      for (const op of plan.operations || []) {
        if (op.type === 'table.upsert') {
          if (!['automation_rules', 'resume_rules', 'blocker_queue'].includes(op.table))
            fail('Unsupported auxiliary table');
          const table = s[op.table],
            match = op.match || {},
            record = op.record || {};
          if (!Object.keys(match).length) fail('An explicit unique match is required');
          for (const key of [...Object.keys(match), ...Object.keys(record)])
            if (!table.header.includes(key)) fail('Unknown auxiliary field: ' + key);
          const matches = table.rows.filter((r) =>
            Object.entries(match).every(([k, v]) => r[k] === v)
          );
          if (matches.length > 1) fail('Ambiguous auxiliary record', 409);
          if (matches.length) Object.assign(matches[0], record);
          else table.rows.push({ ...match, ...record });
          continue;
        }
        const job = s.job_pool.rows.find((r) => r.job_id === op.job_id);
        if (op.type === 'sync.ack') {
          const q = s.sync_queue.rows.find((r) => r.job_id === op.job_id);
          if (!q || q.change_id !== op.change_id) fail('Sync change is stale', 409);
          q.state = op.error ? 'error' : 'synced';
          q.error = op.error || '';
          q.synced_at = op.error ? '' : new Date().toISOString();
          if (op.offernotes_id && job) job.offernotes_id = op.offernotes_id;
          continue;
        }
        if (op.type === 'job.add') {
          if (job) fail('job_id already exists');
          if (!op.job_id) fail('Stable job_id required');
          if (
            !['Pending', 'Deferred', 'Needs user', 'Blocked', 'Skipped'].includes(op.record?.status)
          )
            fail('New leads must start as unsubmitted');
          // 先做登记许可校验，再校验字段：许可不通过时不应留下任何写入。
          const provenance = checkRegistration(op, registrationRuntime);
          const cleaned = { ...op.record };
          for (const key of REGISTRATION_META) delete cleaned[key];
          for (const key of Object.keys(cleaned))
            if (!s.job_pool.header.includes(key)) fail('Unknown job field: ' + key);
          s.job_pool.rows.push({
            ...cleaned,
            job_id: op.job_id,
            source: cleaned.source ? String(cleaned.source) + '\n' + provenance : provenance,
          });
          changes.add(op.job_id);
          continue;
        }
        if (!job) fail('Unknown job_id');
        if (op.type === 'job.delete') {
          if (
            s.follow_up.rows.some(
              (e) => e.job_id !== job.job_id && eventJobIds(e).includes(job.job_id)
            )
          )
            fail('Job is linked to a shared event; unlink it first');
          if (!op.reason) fail('A deletion reason is required');
          const logs = s.application_log.rows.filter((r) => r.job_id === job.job_id),
            events = s.follow_up.rows.filter((r) => r.job_id === job.job_id);
          if (logs.length || events.length) {
            const exact = (actual, expected) =>
              Array.isArray(expected) &&
              expected.length === actual.length &&
              new Set(expected).size === expected.length &&
              actual.every((id) => expected.includes(id));
            if (
              op.archive_history !== true ||
              !exact(
                logs.map((r) => r.log_id),
                op.expected_log_ids
              ) ||
              !exact(
                events.map((r) => r.event_id),
                op.expected_event_ids
              )
            )
              fail(
                'Cannot delete a job with application history or events without explicit exact history archive'
              );
          }
          if (offernotesSync && job.offernotes_id && op.deleted_offernotes_id !== job.offernotes_id)
            fail('Verified remote deletion ID is required');
          s.application_log.rows = s.application_log.rows.filter((r) => r.job_id !== job.job_id);
          s.follow_up.rows = s.follow_up.rows.filter((r) => r.job_id !== job.job_id);
          s.job_pool.rows = s.job_pool.rows.filter((r) => r.job_id !== job.job_id);
          s.sync_queue.rows = s.sync_queue.rows.filter((r) => r.job_id !== job.job_id);
          changes.delete(job.job_id);
          continue;
        } else if (op.type === 'job.patch') {
          const patch = op.patch || {};
          for (const key of Object.keys(patch))
            if (!s.job_pool.header.includes(key) || key === 'job_id' || key === 'legacy_record')
              fail('Invalid patch field: ' + key);
          if (
            patch.status === 'Submitted' &&
            job.status !== 'Submitted' &&
            !(plan.operations || []).some(
              (x) =>
                x.type === 'log.add' &&
                x.job_id === job.job_id &&
                x.record?.status === 'Submitted' &&
                (x.record.submission_evidence ||
                  x.record.confirmation_url ||
                  x.record.confirmation_text)
            )
          )
            fail('A submission transition requires a log with evidence');
          Object.assign(job, patch);
          for (const table of ['application_log', 'follow_up'])
            for (const r of s[table].rows)
              if (r.job_id === job.job_id) {
                r.company = job.company;
                r.job_title = job.job_title;
              }
        } else if (op.type === 'log.add') {
          const record = op.record || {};
          for (const key of Object.keys(record))
            if (!s.application_log.header.includes(key)) fail('Unknown log field: ' + key);
          s.application_log.rows.push({
            ...record,
            log_id: op.log_id || id('log'),
            job_id: job.job_id,
            company: job.company,
            job_title: job.job_title,
          });
        } else if (['event.add', 'event.patch', 'event.delete'].includes(op.type)) {
          const table = s.follow_up;
          if (!table.header.includes('related_job_ids')) table.header.push('related_job_ids');
          const event = table.rows.find(
            (r) => r.event_id === op.event_id && r.job_id === job.job_id
          );
          if (op.type !== 'event.add' && !event) fail('Unknown event_id', 409);
          if (event) for (const linked of eventJobIds(event)) changes.add(linked);
          if (op.type === 'event.delete') table.rows = table.rows.filter((r) => r !== event);
          else {
            const record = op.record || {};
            for (const key of Object.keys(record))
              if (!table.header.includes(key) || ['event_id', 'job_id'].includes(key))
                fail('Invalid event field: ' + key);
            if (!record.date || !validDate(record.date)) fail('A valid event date is required');
            if (!record.event_type) fail('Event content required');
            if (op.type === 'event.add')
              table.rows.push({
                ...record,
                event_id: op.event_id || id('event'),
                job_id: job.job_id,
                company: job.company,
                job_title: job.job_title,
              });
            else Object.assign(event, record);
            for (const linked of eventJobIds(event || table.rows[table.rows.length - 1]))
              changes.add(linked);
          }
        } else fail('Unknown operation: ' + op.type);
        changes.add(job.job_id);
      }
      for (const jobId of offernotesSync ? changes : []) {
        const q = {
          job_id: jobId,
          change_id: id('change'),
          state: 'pending',
          updated_at: new Date().toISOString(),
          synced_at: '',
          error: '',
        };
        const i = s.sync_queue.rows.findIndex((r) => r.job_id === jobId);
        if (i < 0) s.sync_queue.rows.push(q);
        else s.sync_queue.rows[i] = q;
      }
      if ((plan.operations || []).some((op) => op.type !== 'table.upsert')) summary(s);
      validate(s);
      const result = {
        changed_jobs: [...changes],
        counts: Object.fromEntries(TABLES.map((n) => [n, s[n].rows.length])),
        warnings: warnings(s),
      };
      if (dryRun) return { ...result, expected_revision: before, preview: plan.operations || [] };
      return { ...result, ...save(s, before) };
    });
  }
  function initialize(tables) {
    return locked(() => {
      if (fs.existsSync(path.join(internal, 'initialized.json')))
        fail('Already migrated; Excel cannot overwrite the main store', 409);
      const before = revision(raw()),
        s = raw();
      for (const n of TABLES) {
        if (tables[n]) {
          s[n].rows = tables[n];
          s[n].header = [
            ...new Set([
              ...(HEADERS[n] || s[n].header),
              ...tables[n].flatMap((r) => Object.keys(r)),
            ]),
          ];
        }
      }
      summary(s);
      const result = save(s, before);
      atomic(
        path.join(internal, 'initialized.json'),
        JSON.stringify({ date: new Date().toISOString(), ...result })
      );
      return result;
    });
  }
  return { snapshot, query, commit, initialize, exportCsv, offernotesSync };
}
function validDate(value) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value
  );
}
module.exports = { createStore, parseCSV, csv, HEADERS, TABLES, STATUSES };
