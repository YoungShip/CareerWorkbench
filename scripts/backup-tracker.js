#!/usr/bin/env node
/**
 * 把投递主表（八份 CSV）快照备份到私有仓库 lapis-cv/tracker-backup/ 并提交。
 *
 *   node scripts/backup-tracker.js          写入快照并在独立工作目录里提交（不推送）
 *   node scripts/backup-tracker.js --push   基于远程最新版本提交并推送；直连失败时改走本机代理重试
 *
 * 提交和推送都在 lapis-cv 的独立 git worktree（默认 CareerWorkbench/data/private/backup-worktree，
 * 可用 JOBHUNT_BACKUP_WORKTREE 改）里进行，本人的 lapis-cv 工作目录不被暂存、合并或改写；
 * 备份推送后本人那份 lapis-cv 需要 git pull 才能看到新快照。
 *
 * 读取在主表锁内进行，拿到的是一个完整版本，不会备份到写了一半的事务。
 * 备份前打码：测评/笔试/面试平台与短链的整条路径、其他链接里的令牌与个人参数、密码和验证码、
 * 考试账号与简历/申请编号、微信/QQ 号、手机号、个人邮箱的用户名、联系人姓名、住址、推荐码，
 * 以及身份证号。打码后再用一套独立的检查扫描，仍检出敏感内容时不写入、不提交。
 * 主表本身不改动。只提交 tracker-backup/ 目录。
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
const WORKTREE =
  process.env.JOBHUNT_BACKUP_WORKTREE ||
  path.join(ROOT, 'CareerWorkbench/data/private/backup-worktree');
const SUBDIR = 'tracker-backup';

// 全角数字、字母和 ＠＝ 先转成半角，后面的规则只需处理一种写法
const toHalfWidth = (s) =>
  s.replace(/[０-９Ａ-Ｚａ-ｚ＠＝]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));

// 测评、笔试、视频面试平台与短链：链接本身就是个人专属入口，凭据常在路径里，整条只留域名
const EXAM_HOST =
  /(^|\.)(ceping\.com|duomian\.com|acmcoder\.(cn|com)|showmebug\.com|meeting\.tencent\.com|(vc|meetings)\.feishu\.cn|zoom\.(us|com\.cn)|meet\.google\.com|t\.cn|url\.cn|dwz\.cn|suo\.im|tinyurl\.com|bit\.ly)$|(^|\.)(exams?|assess(ment)?|kaoshi|ceping|bishi|mianshi)[.-]/i;
// 这些平台的通用登录页不含个人信息，保留
const EXAM_PUBLIC_PATH = /^\/?(cand\/)?(login\/?)?$/i;
// 其他站点：这些路径段后面跟着带数字的令牌时，从该段起都是专属凭据（如 /exam/test/71234567、#/interview/ab12cd）
const EXAM_PATH =
  /\/(written_pads?|exams?|assessments?|interviews?|invite)(?:\/[a-z]+)?\/(?=[\w-]*\d)[\w-]{5,}/i;
// 以这些段结尾、直接带参数的入口（如 /exam?eid=…）：参数整体打码
const EXAM_ENDPOINT = /\/(?:written_pads?|exams?|assessments?|interviews?)\/?[?#]/i;
const STOP = '\\s",，。；、（）【】()<>\\[\\]';
// 带协议的链接：host 之后一直取到空白或全角标点，打码时连同紧跟的中文路径一起去掉
const URL = new RegExp(`(https?:\\/\\/)([^/?#${STOP}]+)([^${STOP}]*)`, 'gi');
// 不带协议的测评平台链接，如 www.showmebug.com/written_pads/xxx
const BARE_EXAM_LINK = new RegExp(
  `(?<![\\w@./:%-])((?:[a-z0-9-]+\\.)*(?:ceping\\.com|duomian\\.com|acmcoder\\.(?:cn|com)|showmebug\\.com))\\/(?!REDACTED)[^${STOP}]+`,
  'gi'
);
// 链接范围（只取 ASCII），手机号、邮箱规则不进入链接内部，避免误伤路径里的岗位编号
const URL_SPAN = /(https?:\/\/[^\s",\u0080-￿]+)/i;

// 链接参数名统一成小写、去掉 - 和 _ 后判断
const SECRET_PARAM_EXACT =
  /^(token|ticket|code|authcode|sign|signature|auth|uid|sid|ald|elink|operational|pwd|passwd|password|passcode|otp|captcha|vcode|verifycode|smscode|mobile|phone|tel|email|mail|idcard|openid|unionid|realname)$/;
const SECRET_PARAM_AFFIX =
  /(token|ticket|secret|signature|session\w*|password|captcha|verifycode|smscode|authcode|openid|unionid|userid|personid|resumeid|resumeno|applyid|applyno|applicationid|applicationno|choiceid|deliveryid|jobobjective\w*|(api|access|secret|auth)key|mobile|phone|email|idcard)$|^(invite|exam|candidate|j?session)/;
const isSecretParam = (name) => {
  const n = name.toLowerCase().replace(/[-_]/g, '');
  return SECRET_PARAM_EXACT.test(n) || SECRET_PARAM_AFFIX.test(n);
};

const SEP = '\\s*(?:[:：=]|为|是)?\\s*';
// 密码、验证码：值只取 ASCII，避免误伤“账号及密码”“验证码由本人完成”这类说明
const SECRET_TEXT = new RegExp(
  `((?:密码|口令|验证码|校验码|动态码|短信码)${SEP}|(?<![A-Za-z])(?:password|passcode|pwd|otp)\\s*[:：=]\\s*)([A-Za-z0-9!@#$%^&*._+=-]{3,})`,
  'gi'
);
// 测评/考试账号与招聘系统里的个人编号；值里须有数字或 @，避免把“账号 Playwright”这类说明当成编号
const ACCOUNT_ID = new RegExp(
  `((?:通行证号?|准考证号?|考生(?:编)?号|考号|报名(?:编)?号|账号|帐号|账户|帐户|用户名|登录名|会员号|简历(?:编号|ID|号)|申请(?:编号|号|ID)|投递(?:编号|ID)|应聘编号|候选人(?:编号|ID))${SEP})(?=[A-Za-z0-9._@+-]*[\\d@.])([A-Za-z0-9][A-Za-z0-9._@+-]{3,}(?:[ -]\\d{2,})*)`,
  'gi'
);
// 正文里写出的申请/候选人编号，如 candidateId=…、Candidate ID: …、idJobObjective=…
const PLAIN_ID =
  /(?<![A-Za-z])((?:candidate|resume|apply|application|choice|delivery|user|person)[ _-]?(?:id|no)|uid|idJobObjective|jobObjectiveId)(\s*[=:：]\s*|\s+)(?!\d{4}-\d{2}-\d{2})(?=[\w-]*\d)([\w-]{4,})/gi;
const IM_ID =
  /((?:微信号?|企鹅号|(?<![A-Za-z0-9])QQ号?)\s*(?:[:：=]|为|是)?\s*|(?<![A-Za-z])(?:wechat|weixin|wx|vx)\s*[:：=]\s*)([A-Za-z0-9_-]{5,20})/gi;
const ID_LABELLED = new RegExp(
  `((?:身份证(?:号码?)?|证件号(?:码)?|公民身份号码)${SEP})([0-9Xx*][0-9Xx* -]{13,22}[0-9Xx*])`,
  'g'
);
const REFERRAL =
  /((?:推荐码|内推码|邀请码|大使推荐\s*[+＋]|第三方推荐码)\s*[:：=]?\s*)([A-Z0-9]{5,12})(?![A-Za-z0-9])/g;
const ADDRESS =
  /((?:现住址|家庭住址|住址|家庭地址|通讯地址|现居住地|居住地址|户籍地址|收件地址)\s*[:：]?\s*)([^\s，。；;,"]{4,60})/g;
// HR 等联系人姓名紧跟电话或邮箱时，只留姓
const CONTACT_NAME =
  /((?:HR|联系人|招聘专员|招聘负责人|招聘老师|对接人)[ \t]*(?:联系方式|电话|手机|微信|邮箱)?[ \t]*[:：]?[ \t]*)(?!联系方式|电话|手机|微信|邮箱)([一-龥]{2,4})(?=[ \t]*(?:\+?\d|1\d{2}\*|[A-Za-z0-9._%+*-]+@))/g;
const PHONE = /(?<![\dA-Za-z])(\+?86[-. ]?)?(1[3-9]\d)(?:[-. ]?\d){8}(?![\dA-Za-z])/g;
// 本地部分从一段字符的开头匹配，避免长串无 @ 文本上的回溯
const EMAIL =
  /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})(?![A-Za-z0-9-])/g;
// 招聘通用邮箱与招聘系统发信地址保留；个人邮箱（候选人或 HR 个人）只留首字母，公共邮箱服务一律打码
const MAILBOX_WORD =
  '(?:zhaopin|xiaozhao|recruit(?:ment|ing)?|careers?|talent|campus|no-?reply|notice|notify|service|system|exams?|hr|hrzp|hrbp|jobs?)';
// 整个本地部分只由“可选的公司缩写 + 招聘通用词”组成才算通用邮箱，如 acmezhaopin、acmehr、acme-no-reply；hr.zhangsan 这类个人邮箱不算
const GENERIC_MAILBOX = new RegExp(
  `^(?:[a-z]{0,6}[._-]?)?${MAILBOX_WORD}(?:[._-]?${MAILBOX_WORD})*\\d*$`,
  'i'
);
const ATS_MAIL_DOMAIN =
  /(^|\.)(mokahr\.com|joinus\.cc|hotjob\.cn|zhiye\.com|feishu\.cn|beisen\.com|dayee\.com)$/i;
const WEBMAIL =
  /^(qq|foxmail|163|126|yeah|gmail|outlook|hotmail|live|sina|sohu|139|aliyun|icloud)\./i;
// JD 里写明的投递邮箱是公开信息
const PUBLIC_MAIL_CONTEXT = /(投递|发送至|发送到|投递至|投递邮箱|咨询邮箱)[:：]?\s*$/;

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

// 只替换链接以外的正文
function outsideUrls(text, re, fn) {
  return text
    .split(URL_SPAN)
    .map((part, i) => (i % 2 ? part : part.replace(re, fn)))
    .join('');
}

function redactLink(all, scheme, host, rest) {
  const h = host.replace(/^.*@/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  if (EXAM_HOST.test(h)) return EXAM_PUBLIC_PATH.test(rest) ? all : scheme + h + '/REDACTED';

  const m = EXAM_PATH.exec(rest);
  if (m) return scheme + host + rest.slice(0, m.index) + '/' + m[1] + '/REDACTED';
  const q = EXAM_ENDPOINT.exec(rest);
  return q ? scheme + host + rest.slice(0, q.index) + q[0] + 'REDACTED' : all;
}

function redact(text) {
  let out = toHalfWidth(text)
    .replace(URL, redactLink)
    .replace(BARE_EXAM_LINK, (all, host) => host + '/REDACTED')
    .replace(/([?&#;])([A-Za-z_][\w-]*)=([^&#\s",，。；、（）【】]+)/g, (all, sep, name) =>
      isSecretParam(name) ? `${sep}${name}=REDACTED` : all
    )
    .replace(SECRET_TEXT, (all, label) => label + 'REDACTED')
    .replace(ACCOUNT_ID, (all, label) => label + 'REDACTED')
    .replace(PLAIN_ID, (all, name, sep) => name + sep + 'REDACTED')
    .replace(IM_ID, (all, label) => label + 'REDACTED')
    .replace(ID_LABELLED, (all, label) => label + 'REDACTED')
    .replace(REFERRAL, (all, label) => label + 'REDACTED')
    .replace(ADDRESS, (all, label) => label + 'REDACTED');
  out = outsideUrls(out, PHONE, (all, cc = '', head) => cc + head + '********');
  out = outsideUrls(out, EMAIL, (all, user, domain, offset, str) => {
    const keep =
      !WEBMAIL.test(domain) &&
      (GENERIC_MAILBOX.test(user) ||
        ATS_MAIL_DOMAIN.test(domain) ||
        PUBLIC_MAIL_CONTEXT.test(str.slice(Math.max(0, offset - 12), offset)));
    return keep ? all : user[0] + '***@' + domain;
  });
  return out
    .replace(CONTACT_NAME, (all, label, name) => label + name[0] + '某')
    .replace(/(?<![\dA-Za-z])\d{6}[ -]?\d{8}[ -]?\d{3}[\dXx](?![\dA-Za-z])/g, (m) => {
      const id = m.replace(/[ -]/g, '');
      return isIdCard(id) ? id.slice(0, 4) + '**********' + id.slice(14) : m;
    });
}

// 提交前的独立检查（AGENTS.md 第 13 条：推送前扫描）：与 redact 的规则分开写，打码有遗漏时拒绝提交
const LEAK_CHECKS = [
  [
    '测评链接',
    /(?:ceping\.com|duomian\.com|acmcoder\.(?:cn|com)|showmebug\.com)\/(?!REDACTED|cand\/login\b|login\b)[^\s",]/i,
  ],
  ['链接凭据', /[?&;](?:operational|ald|elink|token|ticket|password|pwd)=(?!REDACTED)[^&\s",]/i],
  [
    '个人邮箱',
    /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{2,}@(?:qq|foxmail|163|126|gmail|outlook|hotmail|sina)\./i,
  ],
  ['密码', /(?:密码|验证码)\s*(?:[:：=]|为|是)?\s*(?!REDACTED)[A-Za-z0-9!@#$%^&*._+=-]{3,}/],
];
function findLeaks(text) {
  const kinds = LEAK_CHECKS.filter(([, re]) => re.test(text)).map(([kind]) => kind);
  const plain = text
    .split(URL_SPAN)
    .filter((_, i) => i % 2 === 0)
    .join(' ');
  if (/(?<![\dA-Za-z])1[3-9]\d(?:[-. ]?\d){8}(?![\dA-Za-z])/.test(plain)) kinds.push('手机号');
  if ((text.match(/(?<![\dA-Za-z])\d{17}[\dXx](?![\dA-Za-z])/g) || []).some(isIdCard))
    kinds.push('身份证号');
  return kinds;
}

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: opts.cwd || REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 180000,
    // 后台运行时不能弹出凭据输入框，否则会一直挂住
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
}

// 备份在 lapis-cv 的一个独立 git worktree 里提交和推送，不碰本人的工作目录：
// 本人或其他会话在 lapis-cv 里有未提交改动、正在合并时，都不会被暂存、合并或写入冲突标记。
function backup({
  data = DATA,
  repo = REPO,
  worktree = WORKTREE,
  push = false,
  proxy = PROXY,
} = {}) {
  if (!fs.existsSync(path.join(repo, '.git'))) return { skipped: 'backup repo not found: ' + repo };
  const { revision, files } = createStore(data).exportCsv();
  const redacted = Object.entries(files).map(([name, text]) => [name, redact(text)]);
  const leaks = redacted.flatMap(([name, next]) =>
    findLeaks(next).map((kind) => name + ' ' + kind)
  );
  if (leaks.length) throw new Error('打码后仍检出敏感内容，备份未写入：' + leaks.join('；'));

  const inRepo = (args) => git(args, { cwd: repo });
  const inTree = (args) => git(args, { cwd: worktree });
  // 直连失败时改走本机代理重试一次
  const remote = (args, cwd) => {
    try {
      git(args, { cwd });
      return 'direct';
    } catch (e) {
      if (!proxy) throw e;
      git(['-c', 'http.proxy=' + proxy, ...args], { cwd });
      return 'proxy';
    }
  };
  let upstream = null;
  try {
    upstream = inRepo(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).trim();
  } catch {}
  if (push && upstream) remote(['fetch', '-q', 'origin'], repo);
  const base = upstream || inRepo(['rev-parse', 'HEAD']).trim();

  // worktree 停在 base 或 base 之后自己的备份提交上；base 前进到别处（远程有新提交）时重置到 base
  function prepare() {
    if (!fs.existsSync(path.join(worktree, '.git'))) {
      inRepo(['worktree', 'prune']);
      fs.mkdirSync(path.dirname(worktree), { recursive: true });
      inRepo(['worktree', 'add', '-q', '--detach', worktree, base]);
      return;
    }
    try {
      inTree(['merge-base', '--is-ancestor', base, 'HEAD']);
    } catch {
      inTree(['reset', '-q', '--hard', base]);
    }
  }
  function snapshot() {
    const dir = path.join(worktree, SUBDIR);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, next] of redacted) {
      const target = path.join(dir, name);
      if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== next)
        fs.writeFileSync(target, next, 'utf8');
    }
    inTree(['add', '--', SUBDIR]);
    if (!inTree(['diff', '--cached', '--name-only', '--', SUBDIR]).trim()) return false;
    const day = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    inTree([
      'commit',
      '-q',
      '-m',
      `主表备份 ${day}（revision ${revision.slice(0, 12)}）`,
      '--',
      SUBDIR,
    ]);
    return true;
  }

  prepare();
  let committed = snapshot();
  let pushed = null;
  if (push) {
    if (!upstream) {
      pushed = 'no-upstream';
    } else {
      const branch = upstream.replace(/^[^/]+\//, '');
      for (let attempt = 1; ; attempt++) {
        if (inTree(['rev-list', '--count', upstream + '..HEAD']).trim() === '0') {
          pushed = 'up-to-date';
          break;
        }
        try {
          pushed = remote(['push', '-q', 'origin', 'HEAD:' + branch], worktree);
          break;
        } catch (e) {
          if (attempt >= 2) throw e;
          // 推送期间别的会话推了新提交：取最新远程，在其上重新生成本次快照
          remote(['fetch', '-q', 'origin'], repo);
          inTree(['reset', '-q', '--hard', upstream]);
          committed = snapshot() || committed;
        }
      }
    }
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

module.exports = { backup, redact, findLeaks, isIdCard };
