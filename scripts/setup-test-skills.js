#!/usr/bin/env node
'use strict';
// 为测试准备受信任校验器：把仓库自带的 skills/ 复制到 <workspace>/.agents/skills。
// 已存在校验器时不做任何改动，避免覆盖作者本机的真实技能目录。
const fs = require('node:fs'),
  path = require('node:path');

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
fs.mkdirSync(skills, { recursive: true });
const done = require('./skills-sync').copySkills(path.join(__dirname, '..', 'skills'), skills);
console.log(`已从仓库 skills/ 复制 ${done.length} 个文件到 ${skills}`);
