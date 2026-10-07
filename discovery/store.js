'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { parseDeadline, DEADLINE_CONFIDENCE } = require('./view');
const states = ['discovered', 'researching', 'researched', 'blocked', 'excluded'];
const norm = (s) =>
  String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s·（）()]/g, '');
const names = (l) => [l.company, ...(l.aliases || [])].map(norm).filter(Boolean);
const overlaps = (a, b) => names(a).some((n) => names(b).includes(n));
function mentions(text, name) {
  const n = norm(name);
  if (/^[a-z0-9]+$/.test(n))
    return new RegExp('(^|[^a-z0-9])' + n + '($|[^a-z0-9])').test(
      String(text).normalize('NFKC').toLowerCase()
    );
  return norm(text).includes(n);
}
const url = (s) => {
  try {
    return ['https:', 'http:'].includes(new URL(s).protocol);
  } catch {
    return false;
  }
};
function validate(s) {
  if (!Array.isArray(s.leads) || !Array.isArray(s.runs)) throw Error('Invalid discovery state');
  const ids = new Set();
  for (const l of s.leads) {
    if (!l.lead_id || ids.has(l.lead_id) || !l.company || !states.includes(l.state))
      throw Error('Invalid or duplicate lead identity/state');
    ids.add(l.lead_id);
    if (
      !Array.isArray(l.aliases) ||
      !Array.isArray(l.source_urls) ||
      !l.source_urls.length ||
      !l.source_urls.every(url) ||
      !Array.isArray(l.open_questions) ||
      !l.evidence_summary
    )
      throw Error('Lead needs source URLs, aliases, evidence and open questions');
    if (l.official_url && !url(l.official_url)) throw Error('Invalid official URL');
    if (l.deadline !== undefined && l.deadline !== '' && !parseDeadline(l.deadline))
      throw Error('Invalid discovery deadline');
    if (l.deadline_source_url && !url(l.deadline_source_url))
      throw Error('Invalid deadline source URL');
    if (
      l.deadline_confidence !== undefined &&
      l.deadline_confidence !== '' &&
      !DEADLINE_CONFIDENCE.has(l.deadline_confidence)
    )
      throw Error('Invalid deadline confidence');
    if (l.deadline_note !== undefined && typeof l.deadline_note !== 'string')
      throw Error('Invalid deadline note');
  }
  for (let i = 0; i < s.leads.length; i++)
    for (let j = i + 1; j < s.leads.length; j++)
      if (overlaps(s.leads[i], s.leads[j])) throw Error('Ambiguous company aliases require review');
  const runs = new Set();
  for (const r of s.runs) {
    if (!r.run_id || runs.has(r.run_id) || !['running', 'paused', 'completed'].includes(r.status))
      throw Error('Invalid run');
    runs.add(r.run_id);
  }
  const active = s.runs.filter((r) => r.status !== 'completed');
  if (active.length > 1 || (active[0]?.run_id || '') !== s.active_run_id)
    throw Error('Invalid active run');
}
function createDiscoveryStore(
  root,
  { knownMatches = () => [], beforeReplace = () => {}, researchValidator } = {}
) {
  const file = path.join(root, 'leads.json'),
    lock = path.join(root, '.lock');
  fs.mkdirSync(root, { recursive: true });
  function read() {
    const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const s = raw ? JSON.parse(raw.replace(/^\uFEFF/, '')) : { schema_version: 1, leads: [] };
    s.runs ??= [];
    s.active_run_id ??= '';
    validate(s);
    return { s, raw, revision: crypto.createHash('sha256').update(raw).digest('hex') };
  }
  function locked(fn) {
    try {
      fs.mkdirSync(lock);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner;
      try {
        owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
      } catch {
        throw Error('Discovery lock acquisition incomplete; inspect before recovery');
      }
      try {
        process.kill(owner.pid, 0);
      } catch (err) {
        if (err.code === 'ESRCH') {
          fs.rmSync(lock, { recursive: true });
          return locked(fn);
        }
        throw err;
      }
      throw Error('Another discovery writer is active');
    }
    try {
      fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
      return fn();
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }
  function snapshot() {
    return locked(() => {
      const { s, revision } = read();
      return { revision, ...s };
    });
  }
  function execute(plan, preview = false) {
    return locked(() => {
      const { s, raw, revision } = read();
      if (plan.expected_revision !== revision) throw Error('Revision conflict: reload checkpoint');
      const now = new Date().toISOString(),
        decisions = [];
      let run = s.runs.find((r) => r.run_id === s.active_run_id);
      for (const op of plan.operations || []) {
        if (op.type === 'run.start') {
          if (run) throw Error('Unfinished run exists; inspect and resume that run');
          if (!op.run_id || s.runs.some((r) => r.run_id === op.run_id))
            throw Error('A new run_id is required');
          run = {
            run_id: op.run_id,
            status: 'running',
            started_at: now,
            updated_at: now,
            finished_at: '',
            new_count: 0,
            research_count: 0,
            sources: [],
            decisions: [],
            checkpoint: '',
            next_steps: [],
          };
          s.runs.push(run);
          s.active_run_id = run.run_id;
          continue;
        }
        if (!run || op.run_id !== run.run_id) throw Error('Active run_id required');
        if (op.type === 'run.resume') {
          if (run.status !== 'paused') throw Error('Run must be paused before resuming');
          run.status = 'running';
          continue;
        }
        if (run.status !== 'running') throw Error('Run is paused');
        if (op.type === 'lead.upsert') {
          const lead = op.lead;
          if (!lead?.company || !lead.lead_id) throw Error('Lead identity required');
          const matches = s.leads.filter((l) => l.lead_id === lead.lead_id || overlaps(l, lead));
          if (matches.length > 1) throw Error('Ambiguous lead identity');
          const existing = matches[0];
          if (existing && existing.lead_id === lead.lead_id && !overlaps(existing, lead))
            throw Error('Lead ID cannot be reused for another company');
          const hits = knownMatches(
            existing
              ? {
                  ...lead,
                  company: existing.company,
                  aliases: [
                    ...new Set([...existing.aliases, lead.company, ...(lead.aliases || [])]),
                  ],
                }
              : lead
          );
          if (hits.length) {
            const d = { company: lead.company, decision: 'known_company', evidence: hits, at: now };
            run.decisions.push(d);
            decisions.push(d);
            continue;
          }
          if (!['discovered', 'blocked', 'excluded'].includes(lead.state))
            throw Error(
              'Discovery only records leads; research outcomes require the campus research workflow'
            );
          if (!existing && run.new_count >= 10) throw Error('New lead limit reached (10)');
          if (existing && ['researching', 'researched', 'excluded'].includes(existing.state)) {
            if (lead.state !== 'discovered')
              throw Error('Existing research/disposition must be reviewed, not reset by discovery');
            const d = {
              lead_id: existing.lead_id,
              company: existing.company,
              decision: 'existing_disposition',
              state: existing.state,
              at: now,
            };
            run.decisions.push(d);
            decisions.push(d);
            continue;
          }
          const next = {
            ...existing,
            ...lead,
            lead_id: existing?.lead_id || lead.lead_id,
            company: existing?.company || lead.company,
            aliases: [
              ...new Set([
                ...(existing?.aliases || []),
                ...(lead.aliases || []),
                ...(existing && existing.company !== lead.company ? [lead.company] : []),
              ]),
            ],
            source_urls: [
              ...new Set([...(existing?.source_urls || []), ...(lead.source_urls || [])]),
            ],
            discovered_at: existing?.discovered_at || now,
            last_checked_at: now,
          };
          if (existing) Object.assign(existing, next);
          else {
            s.leads.push(next);
            run.new_count++;
          }
          const d = {
            lead_id: next.lead_id,
            company: next.company,
            decision: existing ? 'updated_existing' : 'added',
            at: now,
          };
          run.decisions.push(d);
          decisions.push(d);
        } else if (op.type === 'research.complete' || op.type === 'research.register') {
          let lead = s.leads.find((l) => l.lead_id === op.lead_id),
            registration;
          if (op.type === 'research.register') {
            const input = op.lead;
            if (!input?.company || !input.lead_id || input.lead_id !== op.lead_id)
              throw Error('Registration requires matching lead identity');
            const matches = s.leads.filter(
              (l) => l.lead_id === input.lead_id || overlaps(l, input)
            );
            if (
              matches.length > 1 ||
              matches.some((l) => l.lead_id !== input.lead_id || !overlaps(l, input))
            )
              throw Error('Registration identity conflict; use existing fixed lead_id');
            if (lead) throw Error('Lead already exists; use research.complete');
            if (!op.registration_reason?.trim()) throw Error('Registration reason required');
            lead = {
              lead_id: input.lead_id,
              company: input.company,
              aliases: input.aliases,
              source_urls: input.source_urls,
              official_url: input.official_url || '',
              state: 'discovered',
              discovered_at: now,
              last_checked_at: now,
              evidence_summary: op.evidence_summary,
              open_questions: op.open_questions,
            };
            registration = {
              reason: op.registration_reason,
              known_matches: knownMatches(lead),
              registered_at: now,
            };
          }
          if (!lead || lead.state === 'excluded')
            throw Error('Existing non-excluded lead required');
          if (
            !op.evidence_summary ||
            !Array.isArray(op.open_questions) ||
            !op.open_questions.every((q) => typeof q === 'string')
          )
            throw Error('Research summary and open questions required');
          if (!researchValidator) throw Error('Research validator is not configured');
          const evidence = researchValidator(op, lead);
          const already = run.decisions.some(
            (d) => d.decision === 'research_completed' && d.lead_id === lead.lead_id
          );
          if (!already && run.research_count >= 2) throw Error('Research limit reached (2)');
          if (registration) {
            lead.research_registration = registration;
            s.leads.push(lead);
          }
          Object.assign(lead, {
            state: 'researched',
            research_file: evidence.files.research_file,
            matching_file: evidence.files.matching_file,
            research_evidence: evidence,
            evidence_summary: op.evidence_summary,
            open_questions: op.open_questions,
            last_checked_at: now,
          });
          if (!already) run.research_count++;
          const d = {
            lead_id: lead.lead_id,
            company: lead.company,
            decision: 'research_completed',
            at: now,
            hashes: evidence.hashes,
            counts: evidence.validation.counts,
            readiness:
              evidence.validation_summary?.readiness || evidence.validation?.readiness || null,
          };
          run.decisions.push(d);
          decisions.push(d);
        } else if (op.type === 'source.record') {
          if (!url(op.url) || !['ok', 'error'].includes(op.outcome) || !op.summary)
            throw Error('Source URL, outcome and summary required');
          const recent = run.sources.filter((x) => x.url === op.url).slice(-2);
          if (recent.length === 2 && recent.every((x) => x.outcome === 'error'))
            throw Error('Source retry limit reached; use another source or checkpoint the blocker');
          run.sources.push({
            url: op.url,
            outcome: op.outcome,
            summary: op.summary,
            checked_at: now,
          });
        } else if (['run.checkpoint', 'run.pause', 'run.finish'].includes(op.type)) {
          if (!op.summary || !Array.isArray(op.next_steps))
            throw Error('Checkpoint summary and next_steps required');
          run.checkpoint = op.summary;
          run.next_steps = op.next_steps;
          if (op.type === 'run.pause') run.status = 'paused';
          if (op.type === 'run.finish') {
            run.status = 'completed';
            run.finished_at = now;
            s.active_run_id = '';
            run = null;
          }
        } else throw Error('Unsupported discovery operation');
        if (run) run.updated_at = now;
      }
      s.schema_version = 2;
      s.updated_at = now;
      validate(s);
      if (preview)
        return {
          preview: true,
          decisions,
          active_run_id: s.active_run_id,
          lead_count: s.leads.length,
        };
      if (read().revision !== revision) throw Error('Discovery file changed outside store');
      const backupDir = path.join(root, 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      const backup = raw ? path.join(backupDir, crypto.randomUUID() + '.json') : '';
      if (raw) fs.writeFileSync(backup, raw);
      const temp = file + '.tmp-' + crypto.randomUUID(),
        encoded = JSON.stringify(s, null, 2) + '\n';
      try {
        fs.writeFileSync(temp, encoded);
        validate(JSON.parse(fs.readFileSync(temp, 'utf8')));
        beforeReplace();
        fs.renameSync(temp, file);
      } finally {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
      }
      const saved = read();
      if (saved.raw !== encoded) throw Error('Discovery readback mismatch');
      return {
        revision: saved.revision,
        backup,
        decisions,
        active_run_id: s.active_run_id,
        lead_count: s.leads.length,
      };
    });
  }
  return { snapshot, execute };
}
module.exports = { createDiscoveryStore, norm, names, mentions };
