// Runs only inside an authenticated https://offernotes.cn page. Never returns credentials.
async function reconcileOfferNotes(payload) {
  const auth = JSON.parse(window.localStorage.getItem('pocketbase_auth') || 'null');
  const user = auth?.record?.id || auth?.model?.id,
    token = auth?.token;
  if (!user || !token) throw new Error('OfferNotes login required');
  const norm = (s) =>
    String(s || '')
      .trim()
      .replace(/\s*[-–—]\s*/g, '-')
      .replace(/\s+/g, ' ');
  const same = (a, b) => norm(a) === norm(b);
  const titleKey = (s) =>
    norm(s)
      .replace(/[-（(]?2027(?:届|校园招聘)[）)]?/g, '')
      .trim();
  // Checksum detects accidental edits inside the managed region; it is not an authentication mechanism.
  function noteHash(text) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }
  // Historical blocks remain readable; new writes use the current project name.
  const reservedMarker = /\[\/?(?:CareerWorkbench|JobHuntBot):/;
  function noteOwner(text) {
    const match = String(text || '').match(
      /\[(?:CareerWorkbench|JobHuntBot):v1:([^:\]\r\n]+):[a-f0-9]+\]/
    );
    if (match) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return '__invalid__';
      }
    }
    return reservedMarker.test(text || '') ? '__invalid__' : '';
  }
  function mergeNote(old, note, jobId) {
    old = String(old || '');
    if (reservedMarker.test(note))
      throw new Error('Local note contains reserved managed-note markers');
    const block =
      '[CareerWorkbench:v1:' +
      encodeURIComponent(jobId) +
      ':' +
      noteHash(note) +
      ']\n' +
      note +
      '\n[/CareerWorkbench:v1]';
    if (!noteOwner(old)) return !old || old === note ? block : old + '\n\n' + block;
    const matches = [
      ...old.matchAll(
        /\[(CareerWorkbench|JobHuntBot):v1:([^:\]\r\n]+):([a-f0-9]+)\]\n([\s\S]*?)\n\[\/\1:v1\]/g
      ),
    ];
    if (matches.length !== 1)
      throw new Error('Malformed or duplicate managed-note blocks require review');
    const m = matches[0],
      before = old.slice(0, m.index),
      after = old.slice(m.index + m[0].length);
    if (reservedMarker.test(before + after) || decodeURIComponent(m[2]) !== jobId)
      throw new Error('Managed-note identity conflict requires review');
    if (noteHash(m[4]) !== m[3])
      throw new Error('Managed note was edited online; preserve edits and review before syncing');
    return before + block + after;
  }
  function stageLink(link) {
    if (link.length <= 200) return link;
    let shorter = link;
    try {
      shorter = decodeURI(link);
    } catch {}
    if (shorter.length > 200)
      throw new Error(
        'Official link exceeds OfferNotes 200-character stage limit; keep full link in job_note and review'
      );
    return shorter;
  }
  async function request(collection, suffix = '', method = 'GET', body) {
    const response = await fetch('/api/collections/' + collection + '/records' + suffix, {
      method,
      headers: { Authorization: token, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let data;
    try {
      data = await response.json();
    } catch {
      // Some writes return an empty 2xx body. Verify the stored fields once;
      // do not infer success from 200 and do not repeat an ambiguous write.
      if (response.ok && method === 'PATCH' && /^\/[^/?]+$/.test(suffix)) {
        const check = await request(collection, suffix);
        if (
          Object.entries(body || {}).every(
            ([key, value]) => String(check[key] ?? '') === String(value ?? '')
          )
        )
          return check;
        throw new Error(
          'OfferNotes empty PATCH response; read-back differs from requested fields. Keep queue and review field lengths/content.'
        );
      }
      throw new Error(
        'OfferNotes ' + method + ' returned an empty/non-JSON response; not verified'
      );
    }
    if (!response.ok)
      throw new Error(
        'OfferNotes HTTP ' +
          response.status +
          ' ' +
          (data.message || '') +
          ' ' +
          JSON.stringify(data.data || {})
      );
    return data;
  }
  async function all(collection) {
    let result = [];
    for (let page = 1; page <= 100; page++) {
      const data = await request(
        collection,
        '?perPage=500&page=' + page + '&filter=' + encodeURIComponent("user='" + user + "'")
      );
      if (!Array.isArray(data.items)) throw new Error('Invalid list response');
      result.push(...data.items.filter((r) => r.user === user));
      if (page >= data.totalPages) break;
    }
    return result;
  }
  let progress = await all('progress'),
    stages = await all('progress_stages');
  const results = [];
  const identities = payload.identity_index || payload.entries.map((e) => e.job),
    claimed = new Map();
  for (const j of identities)
    if (j.offernotes_id) {
      if (claimed.has(j.offernotes_id) && claimed.get(j.offernotes_id) !== j.job_id)
        throw new Error('Duplicate local OfferNotes bindings require review');
      claimed.set(j.offernotes_id, j.job_id);
    }
  for (const entry of payload.entries) {
    const { job, events, change_id } = entry;
    const result = { job_id: job.job_id, change_id, actions: [] };
    try {
      if (!job.job_id) throw new Error('Stable job_id required');
      if (
        !job.offernotes_id &&
        progress.some(
          (r) =>
            same(r.company, job.company) &&
            titleKey(r.department) === titleKey(job.job_title) &&
            noteOwner(r.job_note) === '__invalid__'
        )
      )
        throw new Error('Malformed managed-note identity requires review before matching');
      const available = progress.filter(
        (r) => (!claimed.has(r.id) || claimed.get(r.id) === job.job_id) && !noteOwner(r.job_note)
      );
      let candidates = progress.filter((r) =>
        job.offernotes_id ? r.id === job.offernotes_id : noteOwner(r.job_note) === job.job_id
      );
      if (!candidates.length && !job.offernotes_id)
        candidates = available.filter(
          (r) => same(r.company, job.company) && same(r.department, job.job_title)
        );
      if (!candidates.length && !job.offernotes_id) {
        const companyRows = available.filter((r) => same(r.company, job.company));
        candidates = companyRows.filter(
          (r) =>
            titleKey(r.department) === titleKey(job.job_title) ||
            (job.job_url &&
              ((r.job_note || '').includes(job.job_url) ||
                (r.job_description || '') === job.job_url ||
                stages.some((s) => s.progress === r.id && s.todo_text === job.job_url)))
        );
      }
      if (candidates.length > 1) throw new Error('Duplicate remote records require review');
      let remote = candidates[0];
      if (job.offernotes_id && !remote)
        throw new Error('Stored OfferNotes ID is missing or not owned by this user');
      if (remote && claimed.has(remote.id) && claimed.get(remote.id) !== job.job_id)
        throw new Error('Remote record is bound to another local job');
      if (remote && noteOwner(remote.job_note) && noteOwner(remote.job_note) !== job.job_id)
        throw new Error('Remote managed-note identity does not match local job');
      if (
        remote &&
        !job.offernotes_id &&
        !noteOwner(remote.job_note) &&
        identities.some(
          (j) =>
            j.job_id !== job.job_id &&
            same(j.company, job.company) &&
            titleKey(j.job_title) === titleKey(job.job_title)
        )
      )
        throw new Error(
          'Same-title local jobs require explicit OfferNotes ID mapping for legacy records'
        );
      const description = (job.job_description || '').trim();
      const deferredNote = '延后，暂不投递'; // Actual reasons remain in the local notes; never infer B-version readiness.
      const note = [
        job.status === 'Deferred' ? deferredNote : '',
        job.notes,
        job.resume_variant ? '简历：' + job.resume_variant : '',
        job.match_grade ? '等级：' + job.match_grade : '',
        job.match_estimate ? '匹配度：' + job.match_estimate : '',
        job.job_url ? 'JD：' + job.job_url : '',
      ]
        .filter(Boolean)
        .join('\n');
      const mergedNote = mergeNote(remote?.job_note, note, job.job_id);
      const isNew = !remote;
      if (!remote) {
        if (!['Pending', 'Deferred', 'Submitted'].includes(job.status))
          throw new Error('No remote match; uncertain/ended record not created automatically');
        remote = {
          id: null,
          user,
          company: job.company,
          department: job.job_title,
          city: job.location,
          job_description: description,
          job_note: mergedNote,
        };
      }
      result.offernotes_id = remote.id;
      if (!isNew) claimed.set(remote.id, job.job_id);
      const own = stages.filter((r) => r.progress === remote.id && r.user === user);
      for (const stage of new Set(own.map((s) => s.stage)))
        if (own.filter((r) => r.stage === stage).length > 1)
          throw new Error('Duplicate remote stages require review');
      const patch = {};
      for (const [key, val] of Object.entries({
        ...(job.offernotes_id ? { company: job.company, department: job.job_title } : {}),
        city: job.location,
        job_note: mergedNote,
        ...(description ? { job_description: description } : {}),
      }))
        if (val && remote[key] !== val) patch[key] = val;
      const intended = [];
      const stage0 = own.find((r) => Number(r.stage) === 0);
      if (['Submitted', 'Pending', 'Deferred'].includes(job.status)) {
        const isSubmitted = job.status === 'Submitted';
        if (
          !isSubmitted &&
          own.some((s) => Number(s.stage) > 0 || [3, 4, 5, 6].includes(Number(s.status)))
        )
          throw new Error('Remote has progressed; local unsubmitted status requires review');
        let target = isSubmitted ? 6 : 1;
        if (isSubmitted && stage0 && [3, 4, 5].includes(Number(stage0.status)))
          target = Number(stage0.status);
        // Do not reinterpret legacy completed stages or stages with later progress.
        if (
          isSubmitted &&
          stage0 &&
          (Number(stage0.status) === 2 || own.some((s) => Number(s.stage) > 0))
        )
          target = Number(stage0.status);
        const stageDate = isSubmitted ? stage0?.stage_date || job.application_date : '';
        // Stage-0 note is machine-managed: refresh our own labels when the local status changes,
        // but never overwrite a human-written note.
        const machineStageNotes = ['待投', '已投递，等待筛选'];
        const desiredStageNote =
          job.status === 'Deferred' ? deferredNote : isSubmitted ? '已投递，等待筛选' : '待投';
        const keepStageNote =
          stage0?.note_text && !machineStageNotes.includes(String(stage0.note_text).trim());
        intended.push({
          stage: 0,
          status: target,
          ...(stageDate
            ? { stage_date: stageDate }
            : !isSubmitted && stage0?.stage_date
              ? { stage_date: '' }
              : {}),
          todo_text: stageLink(job.job_url || stage0?.todo_text || ''),
          note_text: keepStageNote ? stage0.note_text : desiredStageNote,
        });
      } else if (job.status === 'Offer') intended.push({ stage: 5, status: 4 });
      else if (job.status === 'Rejected' || job.status === 'Skipped') {
        if (!own.length) throw new Error('Result stage is unknown; requires review');
        const last = own.reduce((a, b) => (Number(a.stage) > Number(b.stage) ? a : b));
        intended.push({ stage: Number(last.stage), status: job.status === 'Rejected' ? 5 : 3 });
      }
      for (const ev of events || []) {
        if (ev.stage === '' || ev.stage == null || !ev.stage_status) continue;
        const stage = Number(ev.stage),
          status = Number(ev.stage_status),
          existing = own.find((s) => Number(s.stage) === stage);
        const finalResult = ['Rejected', 'Skipped', 'Offer'].includes(job.status)
          ? intended.find((s) => [3, 4, 5].includes(s.status))
          : null;
        if (finalResult && stage > finalResult.stage)
          throw new Error('Event is later than the result stage; requires review');
        const planned = intended.find((s) => s.stage === stage);
        // Resolve against this run's result, not just the previous remote state.
        const terminal =
          planned && [3, 4, 5].includes(planned.status)
            ? planned
            : existing && [3, 4, 5].includes(Number(existing.status))
              ? existing
              : null;
        if (terminal && Number(terminal.status) !== status) {
          if ([1, 2, 6].includes(status)) continue;
          throw new Error('Conflicting terminal stage results require review: stage ' + stage);
        }
        // Unknown time remains date-only (midnight CST); no synthetic scheduled hour.
        const datetime = ev.date
          ? new Date(ev.date + 'T' + (ev.time || '00:00') + ':00+08:00').toISOString()
          : '';
        const item = {
          stage,
          status,
          ...(datetime ? { stage_date: datetime } : {}),
          note_text: [ev.event_type, ev.notes, !ev.time ? '具体时间未记录' : '']
            .filter(Boolean)
            .join('\n'),
        };
        const idx = intended.findIndex((s) => s.stage === stage);
        if (idx >= 0) intended[idx] = { ...intended[idx], ...item };
        else intended.push(item);
      }
      // Complete conflict checks before mutating an existing remote record.
      if (isNew) {
        result.actions.push(payload.dryRun ? 'create' : 'created');
        if (!payload.dryRun) {
          const values = {
            user,
            company: job.company,
            department: job.job_title,
            city: job.location,
            job_description: description,
            job_note: mergedNote,
            batch: '秋招',
            publish_delay: 100000,
          };
          const saved = await request('progress', '', 'POST', values);
          if (!saved.id || saved.user !== user) throw new Error('Ownership verification failed');
          result.offernotes_id = saved.id;
          const check = await request('progress', '/' + saved.id);
          if (Object.entries(values).some(([k, v]) => String(check[k] ?? '') !== String(v ?? '')))
            throw new Error('Created detail verification failed');
          remote = check;
          progress.push(remote);
          claimed.set(remote.id, job.job_id);
        } else result.offernotes_id = '';
      }
      if (Object.keys(patch).length) {
        result.actions.push('update-details');
        if (!payload.dryRun) {
          await request('progress', '/' + remote.id, 'PATCH', patch);
          const check = await request('progress', '/' + remote.id);
          if (check.user !== user || Object.entries(patch).some(([k, v]) => check[k] !== v))
            throw new Error('Detail verification failed');
          Object.assign(remote, check);
        }
      }
      for (const target of intended) {
        const existing = own.find((r) => Number(r.stage) === target.stage);
        const delta = {};
        for (const [k, v] of Object.entries(target)) {
          const equal =
            k === 'stage_date'
              ? existing?.[k] && new Date(existing[k]).getTime() === new Date(v).getTime()
              : String(existing?.[k] ?? '') === String(v);
          if (!equal) delta[k] = v;
        }
        if (!Object.keys(delta).length) continue;
        result.actions.push((existing ? 'update' : 'create') + '-stage-' + target.stage);
        if (!payload.dryRun) {
          const saved = existing
            ? await request('progress_stages', '/' + existing.id, 'PATCH', delta)
            : await request('progress_stages', '', 'POST', {
                user,
                progress: remote.id,
                ...target,
              });
          const check = await request('progress_stages', '/' + saved.id);
          if (check.user !== user || check.progress !== remote.id)
            throw new Error('Stage ownership verification failed');
          for (const [key, value] of Object.entries(target)) {
            const equal =
              key === 'stage_date' && value
                ? new Date(check[key]).getTime() === new Date(value).getTime()
                : String(check[key] ?? '') === String(value);
            if (!equal) throw new Error('Stage verification failed: ' + key);
          }
        }
      }
    } catch (e) {
      result.error = e.message;
    }
    results.push(result);
  }
  return { dryRun: !!payload.dryRun, results };
}
if (typeof module !== 'undefined') module.exports = { reconcileOfferNotes };
