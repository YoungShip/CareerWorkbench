#!/usr/bin/env node
'use strict';
// 为测试准备受信任校验器：把固定版本的公共技能仓库检出到 <workspace>/.agents/skills。
// 已存在校验器时不做任何改动，避免覆盖作者本机的真实技能目录。
// 固定提交须与 .github/workflows/test.yml 中的 ref 保持一致。
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO = 'https://github.com/YoungShip/job-application-workflow-skills.git';
const REF = '78bfad127ee641edb02f8d4112a5cf96cd0cf41b';
const workspace = path.resolve(__dirname, '..', '..');
const skills = path.join(workspace, '.agents', 'skills');
const verifier = path.join(skills, 'campus-recruitment', 'scripts', 'verify-matching.py');

if (fs.existsSync(verifier)) {
  console.log(`校验器已存在，跳过：${verifier}`);
  process.exit(0);
}
if (fs.existsSync(skills) && fs.readdirSync(skills).length) {
  console.error(`${skills} 已存在但缺少校验器；请手动检查，不自动覆盖。`);
  process.exit(1);
}
const git = (...args) => {
  const r = spawnSync('git', args, { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
};
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-skills-'));
try {
  git('init', '-q', temp);
  git('-C', temp, 'fetch', '-q', '--depth=1', REPO, REF);
  git('-C', temp, 'checkout', '-q', 'FETCH_HEAD');
  fs.mkdirSync(path.dirname(skills), { recursive: true });
  fs.cpSync(path.join(temp, 'skills'), skills, { recursive: true });
  console.log(`已检出 ${REF.slice(0, 12)} 到 ${skills}`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
