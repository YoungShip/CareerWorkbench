#!/usr/bin/env node
/**
 * 把投递主表（八份 CSV）快照备份到私有仓库 lapis-cv/tracker-backup/ 并提交。
 *
 *   node scripts/backup-tracker.js          写入快照并在 lapis-cv 提交（不推送）
 *   node scripts/backup-tracker.js --push   提交后推送：先拉取远程新提交并把本地提交叠在其后；直连失败时改走本机代理重试
 *
 * 读取在主表锁内进行，拿到的是一个完整版本，不会备份到写了一半的事务。
 * 备份前打码：链接里 token/ticket/code/invite 等参数的值，以及通过校验的身份证号。
 * 主表本身不改动。只提交 tracker-backup/ 目录，不碰 lapis-cv 里的其他改动。
 * 每晚汇总与登录检查（remind.js --all）会在后台调用 --push。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createStore } = require('../dashboard/store');

const ROOT = path.resolve(__dirname, '../..');
const DATA = process.env.JOBHUNT_DATA_DIR || path.join(ROOT, 'CareerWorkbench/dashboard');
const REPO = process.env.JOBHUNT_BACKUP_REPO || path.join(ROOT, 'lapis-cv');
const PROXY = process.env.JOBHUNT_BACKUP_PROXY ?? 'http://127.0.0.1:7890';
const SUBDIR = 'tracker-backup';

const SECRET_PARAM =
  /^(token|access_token|ticket|code|authcode|key|sign|signature|auth|uid|sid|session\w*|invite\w*|exam\w*|ald|elink|candidate\w*)$/i;
// 测评/考试平台的链接本身就是个人专属入口，整段参数都打码
const EXAM_HOST = /(^|\.)ceping\.com$|(^|\.)(exams?|assess(ment)?|kaoshi)\./i;
/(^|\.)(ceping\.com|[\w-]*exam[\w-]*\.[\w.]+|[\w-]*assess[\w-]*\.[\w.]+|kaoshi\.[\w.]+)$/i;
// 测评/考试账号：通行证、准考证号、账号后面的编号
const ACCOUNT_ID = /((?:通行证|准考证号?|考生号|账号)\s*[:：]?\s*)([A-Za-z0-9_-]{6,})/g;

// GB 11643：出生日期合法且第 18 位校验码正确才视为身份证号，避免误伤岗位 ID
function isIdCard(s) {
  if (!/^\d{17}[\dXx]$/.test(s)) return false;
  const y = +s.slice(6, 10),
    m = +s.slice(10, 12),
    d = +s.slice(12, 14);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (y < 1900 || y > 2100 || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return false;
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const sum = w.reduce((a, wi, i) => a + wi * +s[i], 0);
  return '10X98765432'[sum % 11] === s[17].toUpperCase();
}

function redact(text) {
  return text
    .replace(/(https?:\/\/([^/?#\s",]+)[^?#\s",]*)([?#][^\s",]*)/g, (all, base, host) =>
      EXAM_HOST.test(host) ? base + '?REDACTED' : all
    )
    .replace(ACCOUNT_ID, (all, label) => label + 'REDACTED')
    .replace(/([?&#;])([A-Za-z_]\w*)=([^&#\s",]+)/g, (all, sep, name) =>
      SECRET_PARAM.test(name) ? `${sep}${name}=REDACTED` : all
    )
    .replace(/(?<![\dA-Za-z])\d{17}[\dXx](?![\dA-Za-z])/g, (m) =>
      isIdCard(m) ? m.slice(0, 4) + '**********' + m.slice(14) : m
    );
}

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: opts.cwd || REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
}

function backup({ data = DATA, repo = REPO, push = false, proxy = PROXY } = {}) {
  if (!fs.existsSync(path.join(repo, '.git'))) return { skipped: 'backup repo not found: ' + repo };
  const { revision, files } = createStore(data).exportCsv();
  const dir = path.join(repo, SUBDIR);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    const target = path.join(dir, name);
    const next = redact(text);
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== next)
      fs.writeFileSync(target, next, 'utf8');
  }
  const run = (args) => git(args, { cwd: repo });
  run(['add', '--', SUBDIR]);
  const changed = run(['diff', '--cached', '--name-only', '--', SUBDIR]).trim();
  let committed = false;
  if (changed) {
    const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    run([
      'commit',
      '-q',
      '-m',
      `主表备份 ${day}（revision ${revision.slice(0, 12)}）`,
      '--',
      SUBDIR,
    ]);
    committed = true;
  }
  let pushed = null;
  if (push) {
    // 直连失败时改走本机代理重试一次
    const remote = (args) => {
      try {
        run(args);
        return 'direct';
      } catch (e) {
        if (!proxy) throw e;
        run(['-c', 'http.proxy=' + proxy, ...args]);
        return 'proxy';
      }
    };
    let upstream = true;
    try {
      run(['rev-parse', '--abbrev-ref', '@{u}']);
    } catch {
      upstream = false; // 还没有上游分支：直接推送
    }
    if (upstream) {
      // 其他会话或工具可能已向 lapis-cv 推送：先把本地提交叠到远程最新版本之后
      remote(['fetch', '-q', 'origin']);
      if (run(['rev-list', '--count', 'HEAD..@{u}']).trim() !== '0') {
        try {
          run(['rebase', '-q', '--autostash', '@{u}']);
        } catch (e) {
          try {
            run(['rebase', '--abort']);
          } catch {}
          throw new Error(
            '远程有新提交且与本地冲突，备份只留在本地：' + String(e.stderr || e.message).trim()
          );
        }
      }
    }
    const ahead = upstream ? run(['rev-list', '--count', '@{u}..HEAD']).trim() : null;
    pushed = ahead === '0' ? 'up-to-date' : remote(['push', '-q', 'origin', 'HEAD']);
  }
  return { revision, committed, pushed };
}

if (require.main === module) {
  const push = process.argv.includes('--push');
  const log = path.join(ROOT, 'CareerWorkbench/logs/backup.log');
  const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  let line;
  try {
    const r = backup({ push });
    line = r.skipped
      ? '跳过：' + r.skipped
      : `revision ${r.revision.slice(0, 12)}，${r.committed ? '已提交新快照' : '无变化'}` +
        (push ? `，推送：${r.pushed}` : '');
  } catch (e) {
    line =
      '失败：' +
      String(e.stderr || e.message)
        .trim()
        .split('\n')[0];
    process.exitCode = 1;
  }
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.appendFileSync(log, `[${ts}] ${line}\n`, 'utf8');
  } catch {}
}

module.exports = { backup, redact, isIdCard };
