'use strict';

const fs = require('node:fs');
const path = require('node:path');

function args(argv) {
  const out = {
    root: path.resolve(__dirname, '..', 'data', 'private', 'site-knowledge'),
    asOf: null,
    json: false,
    match: null,
  };
  for (const arg of argv) {
    if (arg === '--json') out.json = true;
    else if (arg.startsWith('--root=')) out.root = path.resolve(arg.slice(7));
    else if (arg.startsWith('--as-of=')) out.asOf = arg.slice(8);
    else if (arg.startsWith('--match=')) out.match = arg.slice(8).toLowerCase();
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function parseDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return null;
  const [y, m, d] = value.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const dt = new Date(ms);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
    ? ms
    : null;
}

function metadata(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s*([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (m) out[m[1].toLowerCase()] = m[2];
  }
  return out;
}

function inspect(file, asOfMs) {
  const meta = metadata(fs.readFileSync(file, 'utf8'));
  const errors = [];
  const status = (meta.knowledge_status || '').toLowerCase();
  if (!['verified', 'candidate', 'historical'].includes(status))
    errors.push('knowledge_status must be verified, candidate, or historical');
  let ageDays = null;
  let staleAfterDays = null;
  let freshness = status || 'invalid';
  const lastMs = meta.last_verified ? parseDateOnly(meta.last_verified) : null;
  if (status === 'verified') {
    if (lastMs === null) errors.push('verified entry requires valid last_verified=YYYY-MM-DD');
    staleAfterDays = Number(meta.stale_after_days);
    if (!Number.isInteger(staleAfterDays) || staleAfterDays <= 0)
      errors.push('verified entry requires positive integer stale_after_days');
    if (!errors.length) {
      ageDays = Math.floor((asOfMs - lastMs) / 86400000);
      freshness = ageDays > staleAfterDays ? 'stale' : 'fresh';
    }
  } else if (status === 'candidate') freshness = 'candidate';
  else if (status === 'historical') freshness = 'historical';
  return {
    file: path.basename(file),
    knowledge_status: status || null,
    last_verified: meta.last_verified || null,
    stale_after_days: Number.isInteger(staleAfterDays) ? staleAfterDays : null,
    age_days: ageDays,
    freshness: errors.length ? 'invalid' : freshness,
    errors,
  };
}

function main() {
  const opt = args(process.argv.slice(2));
  const asOf = opt.asOf || new Date().toISOString().slice(0, 10);
  const asOfMs = parseDateOnly(asOf);
  if (asOfMs === null) throw new Error('--as-of must be YYYY-MM-DD');
  if (!fs.existsSync(opt.root)) throw new Error(`site-knowledge root not found: ${opt.root}`);
  let files = fs
    .readdirSync(opt.root)
    .filter((x) => x.endsWith('.md'))
    .sort();
  if (opt.match) files = files.filter((x) => x.toLowerCase().includes(opt.match));
  const entries = files.map((name) => inspect(path.join(opt.root, name), asOfMs));
  const summary = {
    total: entries.length,
    fresh: 0,
    stale: 0,
    candidate: 0,
    historical: 0,
    invalid: 0,
  };
  for (const entry of entries) summary[entry.freshness] = (summary[entry.freshness] || 0) + 1;
  const result = { as_of: asOf, root: opt.root, summary, entries };
  if (opt.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(
      `site-knowledge: fresh=${summary.fresh} stale=${summary.stale} candidate=${summary.candidate} historical=${summary.historical} invalid=${summary.invalid}`
    );
    for (const e of entries.filter((x) => x.freshness !== 'fresh'))
      console.log(
        `- ${e.file}: ${e.freshness}${e.errors.length ? ` (${e.errors.join('; ')})` : ''}`
      );
  }
  if (summary.invalid) process.exitCode = 1;
}

try {
  main();
} catch (e) {
  console.error(`site-knowledge-status: ${e.message}`);
  process.exitCode = 1;
}
