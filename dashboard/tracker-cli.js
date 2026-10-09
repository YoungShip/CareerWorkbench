#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { extractOut, emitJson } = require('../lib/json-output');
const { createTrackerService, readJson } = require('../lib/tracker-service');
const service = createTrackerService({ projectDir: path.resolve(__dirname, '..') }),
  store = service.store;
function parseQueryArgs(argv) {
  const options = { job_ids: [], fields: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error('Unexpected query argument: ' + token);
    let key = token.slice(2),
      value;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) value = argv[++i];
    if (key === 'job_id') options.job_ids.push(value);
    else if (key === 'job_ids')
      options.job_ids.push(
        ...String(value)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      );
    else if (key === 'fields')
      options.fields.push(
        ...String(value)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      );
    else if (key === 'company' || key === 'status') options[key] = value;
    else if (key === 'include_description' || key === 'with_events')
      options[key] = !(value === 'false' || value === '0');
    else if (key === 'no_events') options.with_events = false;
    else throw new Error('Unknown query option: --' + key);
  }
  return options;
}
// 主表里登记证据的路径字段：文件不存在时列出来（只读，不改主表）
function checkArtifacts(snap) {
  const { resolveArtifactPath } = require('../lib/artifact-paths');
  const fs = require('node:fs');
  const missing = [];
  let checked = 0;
  for (const job of snap.tables.job_pool)
    for (const field of ['matching_file', 'research_file']) {
      const value = String(job[field] || '').trim();
      if (!value) continue;
      checked++;
      const resolved = resolveArtifactPath(value);
      if (!fs.existsSync(resolved))
        missing.push({
          job_id: job.job_id,
          company: job.company,
          job_title: job.job_title,
          status: job.status,
          field,
          path: value,
        });
    }
  return {
    revision: snap.revision,
    read_only: true,
    checked,
    missing_count: missing.length,
    missing,
  };
}
try {
  const parsed = extractOut(process.argv.slice(2)),
    args = parsed.args,
    out = parsed.out;
  const [command, file, ...rest] = args;
  let result;
  // 主表在仓库里时，读命令先拉取（失败只警告），写命令在 commitPlan 里严格拉取并在写后推送
  if (['snapshot', 'validate', 'query', 'brief', 'check-artifacts'].includes(command))
    for (const w of service.sync({ strict: false }).warnings) console.error('警告：' + w);
  if (command === 'snapshot' || command === 'validate') {
    if (file !== undefined) throw Error(command + ' takes no options except --out');
    result = command === 'validate' ? service.validate() : store.snapshot();
  } else if (command === 'query')
    result = store.query(parseQueryArgs([file, ...rest].filter((x) => x !== undefined)));
  else if (command === 'brief' || command === 'rules') {
    const argv = [file, ...rest].filter((x) => x !== undefined);
    let limit = 8;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i].startsWith('--limit=')) limit = Number(argv[i].slice(8));
      else if (argv[i] === '--limit') limit = Number(argv[++i]);
      else throw Error('Unknown ' + command + ' option: ' + argv[i]);
    }
    if (command === 'rules') {
      if (argv.length) throw Error('rules takes no options');
      result = service.rules();
    } else result = service.brief({ limit });
  } else if (command === 'check-artifacts') {
    if (file !== undefined) throw Error('check-artifacts takes no options except --out');
    result = checkArtifacts(store.snapshot());
  } else if (command === 'preview' || command === 'apply') {
    if (!file || rest.length) throw Error(command + ' requires exactly one plan JSON file');
    result = service.commitPlan(readJson(file), command === 'preview');
  } else if (command === 'initialize') {
    if (!file || rest.length) throw Error('initialize requires exactly one migration JSON file');
    if (service.gitBacked) throw Error('主表已在仓库里，不能再 initialize');
    result = store.initialize(readJson(file));
  } else
    throw new Error(
      'Usage: node tracker-cli.js snapshot|validate|check-artifacts|rules|brief [--limit=8]|query [--job_id=X] [--company=X] [--status=X] [--fields=a,b] [--include_description] [--no_events]|preview plan.json|apply plan.json|initialize migration.json [--out=file.json]'
    );
  emitJson(result, out);
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
