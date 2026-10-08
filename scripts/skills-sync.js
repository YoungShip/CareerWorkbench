#!/usr/bin/env node
/**
 * 三个求职技能的版本源在 CareerWorkbench/skills/，运行位置在工作区的 .agents/skills/
 * （各 AI 客户端从那里加载）。两处必须一致。
 *
 *   node scripts/skills-sync.js            只检查差异（有差异时退出码 1）
 *   node scripts/skills-sync.js --capture  把本机在用的技能收回仓库（随后提交）
 *   node scripts/skills-sync.js --install  把仓库版本装到本机运行位置
 *
 * 只处理三个技能目录，忽略 __pycache__ 与 .pyc；比较时统一换行符，避免
 * Windows 检出的 CRLF 被误报为改动。检查模式顺带核对三份 AGENTS.md 是否一致。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SKILL_NAMES = ['campus-recruitment', 'job-application-form-filling', 'offernotes-sync'];
const REPO_SKILLS = path.resolve(__dirname, '..', 'skills');
const INSTALLED =
  process.env.JOBHUNT_INSTALLED_SKILLS || path.resolve(__dirname, '..', '..', '.agents', 'skills');
const ignored = (rel) => rel.split(/[\\/]/).includes('__pycache__') || rel.endsWith('.pyc');

function listFiles(dir) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const rel of fs.readdirSync(dir, { recursive: true })) {
    const p = path.join(dir, rel);
    if (ignored(rel) || !fs.statSync(p).isFile()) continue;
    out.set(rel.split(path.sep).join('/'), p);
  }
  return out;
}
const normalized = (p) => fs.readFileSync(p).toString('utf8').replace(/\r\n/g, '\n');

function diffSkills({ repo = REPO_SKILLS, installed = INSTALLED } = {}) {
  const changed = [],
    onlyRepo = [],
    onlyInstalled = [];
  for (const name of SKILL_NAMES) {
    const a = listFiles(path.join(repo, name)),
      b = listFiles(path.join(installed, name));
    for (const [rel, p] of a) {
      const key = name + '/' + rel;
      if (!b.has(rel)) onlyRepo.push(key);
      else if (normalized(p) !== normalized(b.get(rel))) changed.push(key);
    }
    for (const rel of b.keys()) if (!a.has(rel)) onlyInstalled.push(name + '/' + rel);
  }
  return {
    in_sync: !changed.length && !onlyRepo.length && !onlyInstalled.length,
    changed,
    onlyRepo,
    onlyInstalled,
  };
}

// 三份 AGENTS.md：仓库这份是同步源，工作区根和 lapis-cv 各有一份副本（AGENTS.md 第 13 条）
const WORKSPACE = path.resolve(__dirname, '..', '..');
function diffAgents({
  source = path.resolve(__dirname, '..', 'AGENTS.md'),
  copies = [path.join(WORKSPACE, 'AGENTS.md'), path.join(WORKSPACE, 'lapis-cv', 'AGENTS.md')],
} = {}) {
  const want = normalized(source);
  const differing = [],
    missing = [];
  for (const copy of copies) {
    if (!fs.existsSync(copy)) missing.push(copy);
    else if (normalized(copy) !== want) differing.push(copy);
  }
  return { in_sync: !differing.length && !missing.length, differing, missing };
}

// 用 from 的内容覆盖 to 中的三个技能目录：复制新增与改动的文件，删除 from 中没有的文件
function copySkills(from, to) {
  const done = [];
  for (const name of SKILL_NAMES) {
    const src = listFiles(path.join(from, name)),
      dst = listFiles(path.join(to, name));
    for (const [rel, p] of src) {
      const target = path.join(to, name, rel);
      if (dst.has(rel) && normalized(p) === normalized(dst.get(rel))) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(p, target);
      done.push('写入 ' + name + '/' + rel);
    }
    for (const [rel, p] of dst)
      if (!src.has(rel)) {
        fs.rmSync(p);
        done.push('删除 ' + name + '/' + rel);
      }
  }
  return done;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--capture') || args.includes('--install')) {
    const [from, to] = args.includes('--capture')
      ? [INSTALLED, REPO_SKILLS]
      : [REPO_SKILLS, INSTALLED];
    if (!fs.existsSync(from)) throw new Error('找不到来源目录：' + from);
    const done = copySkills(from, to);
    console.log(done.length ? done.join('\n') : '两处已一致，无需改动');
  } else {
    const d = diffSkills();
    const agents = diffAgents();
    console.log(
      JSON.stringify({ repo: REPO_SKILLS, installed: INSTALLED, ...d, agents_md: agents }, null, 2)
    );
    if (!d.in_sync || !agents.in_sync) process.exitCode = 1;
  }
}

module.exports = { diffSkills, diffAgents, copySkills, SKILL_NAMES };
