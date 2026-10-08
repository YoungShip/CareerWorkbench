#!/usr/bin/env node
/**
 * 秋招到期提醒 —— 读 CareerWorkbench follow_up.csv，输出 3 天内到期 / 已过期未处理事项。
 *
 * 用法:
 *   node remind.js            文本输出（供人工查看 / 会话检查）
 *   node remind.js --notify   额外弹 Windows 桌面通知（供计划任务调用）
 *   node remind.js --wechat   额外推送微信（Server酱，供计划任务调用）
 *   node remind.js --all      桌面通知 + 微信推送
 *   node remind.js --due      只对"刚跨过 24h / 2h 门槛"的事项提醒一次（供每小时任务调用）
 *   node remind.js --json     输出 JSON
 *
 * 只读主表；--due 模式会写一个去重状态文件 CareerWorkbench/tmp/remind-state.json，
 * 用于保证同一事项在同一门槛上只提醒一次。
 * 微信推送凭据在 CareerWorkbench/data/private/secrets/serverchan.json，缺失或留空则自动跳过。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const core = require('./reminder-core');
const { parseCSV } = require('../dashboard/store');
const DATA = process.env.JOBHUNT_DATA_DIR || path.join(ROOT, 'CareerWorkbench/dashboard');
const FU = path.join(DATA, 'follow_up.csv');
const JOBS = path.join(DATA, 'job_pool.csv');
const STATE = path.join(ROOT, 'CareerWorkbench/tmp/remind-state.json');
const SECRET = path.join(ROOT, 'CareerWorkbench/data/private/secrets/serverchan.json');
const LOG = path.join(ROOT, 'CareerWorkbench/logs/remind.log');

// 计划任务运行时看不到控制台输出，因此把每次运行结果追加到日志，便于事后排查
// "到底提醒了没有"。日志只记结果与计数，不记凭据。
function logRun(line) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    fs.appendFileSync(LOG, `[${ts}] ${line}\n`, 'utf8');
  } catch {}
}

// Parsing is shared with the transactional tracker; do not maintain a second CSV parser.
function parseCsv(text) {
  return parseCSV(text).rows;
}
function collect(now = new Date()) {
  const events = parseCsv(fs.readFileSync(FU, 'utf8'));
  // 待投岗位的网申截止一起提醒；job_pool 读不到时只用日程，不影响原有提醒
  let jobs = [];
  try {
    jobs = parseCsv(fs.readFileSync(JOBS, 'utf8'));
  } catch {}
  return core.collectEvents([...events, ...core.jobDeadlineEvents(jobs, events)], now);
}

function fmtItem(it, withAt) {
  const label =
    it.timing_kind === '固定安排' ? '安排' : it.timing_kind === '估算截止' ? '参考截止' : '截止';
  const due = withAt
    ? `${label} ${it.atText}${it.assumed_time ? '（仅日期，按当日结束提醒；非官方精确时刻）' : ''}`
    : it.deadline || it.date || '时间未知';
  const rel =
    it.diffH != null
      ? it.diffH < 0
        ? `已过期 ${Math.abs(Math.round((it.diffH / 24) * 10) / 10)} 天`
        : `剩 ${Math.round(it.diffH)} 小时`
      : '';
  return `· ${it.company} — ${it.event}\n    ${due}${rel ? '（' + rel + '）' : ''}${it.next ? '\n    下一步：' + it.next : ''}`;
}

function buildText(r) {
  const L = [];
  L.push(`【秋招提醒】${r.nowText}（北京时间）`);
  if (r.overdue.length) {
    L.push('');
    L.push(`⚠ 已过期未处理 ${r.overdue.length} 项：`);
    r.overdue.forEach((it) => L.push(fmtItem(it, true)));
  }
  if (r.soon.length) {
    L.push('');
    L.push(`🔔 72 小时内到期 ${r.soon.length} 项：`);
    r.soon.forEach((it) => L.push(fmtItem(it, true)));
  }
  if (!r.overdue.length && !r.soon.length) {
    L.push('');
    L.push('✓ 没有已过期或 72 小时内到期的事项。');
  }
  if (r.noDeadline.length) {
    L.push('');
    L.push(
      `（另有 ${r.noDeadline.length} 项无明确截止：${r.noDeadline.map((x) => x.company).join('、')}）`
    );
  }
  return L.join('\n');
}

// ---------- Windows 桌面通知 ----------
function notify(title, message) {
  // 用 PowerShell 的 BurntToast 不可靠；改用 msg 命令 / 气泡脚本。
  // 最稳的方式：写一个临时 ps1 调用 Windows.UI.Notifications（Toast）。
  const ps = `
$ErrorActionPreference='Stop'
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null
  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null
  $payload = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify({ title, message }), 'utf8').toString('base64')}')) | ConvertFrom-Json
  $t = [System.Security.SecurityElement]::Escape($payload.title)
  $m = [System.Security.SecurityElement]::Escape($payload.message)
  $xml = "<toast><visual><binding template='ToastGeneric'><text>$t</text><text>$m</text></binding></visual></toast>"
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('秋招提醒').Show($toast)
  Write-Output 'TOAST_OK'
} catch {
  Write-Output ('TOAST_FAIL: ' + $_.Exception.Message)
}
`;
  const tmp = path.join(ROOT, 'CareerWorkbench/tmp/_toast-' + process.pid + '.ps1');
  // 必须带 UTF-8 BOM：Windows PowerShell 5.1 对无 BOM 的 .ps1 按 ANSI(GBK) 解码，
  // 中文会被拆成乱码并破坏字符串引号，导致 ParserError（实测踩过）。
  fs.writeFileSync(tmp, '\uFEFF' + ps, 'utf8');
  try {
    const shell = process.platform === 'win32' ? 'powershell' : 'pwsh';
    // powershell.exe 是控制台子系统程序：即使宿主 node 已经隐藏，它自己仍会申请一个
    // 控制台窗口。有事项时用户会看到第二个黑窗（实测 2026-09-27）。两条都要给：
    // -WindowStyle Hidden 管窗口显示，windowsHide 管 CreateProcess 不新建控制台。
    const out = execFileSync(
      shell,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', tmp],
      { encoding: 'utf8', timeout: 30000, windowsHide: true }
    );
    return out.trim();
  } catch (e) {
    return 'TOAST_ERR: ' + e.message;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {}
  }
}

// ---------- 微信推送（Server酱 Turbo） ----------
// 凭据文件缺失 / sendkey 为空 / 文件损坏，都只返回 SKIP，不影响主流程与退出码。
function loadSendkey() {
  try {
    const cfg = JSON.parse(fs.readFileSync(SECRET, 'utf8'));
    const k = String(cfg.sendkey || '').trim();
    return k || null;
  } catch {
    return null;
  }
}

// 微信每日发送预算：Server酱免费版实测每天上限 5 条（超出返回 code=40001
// "[AUTH]超过当天的发送次数限制[5]"）。这里自己记账，把额度优先留给真正紧急的推送，
// 避免"登录检查 + 汇总 + 门槛"把额度烧光后，最关键的临期提醒反而发不出去。
const WX_QUOTA_FILE = path.join(ROOT, 'CareerWorkbench/tmp/wechat-quota.json');
const WX_DAILY_LIMIT = 5;

// ---------- 5 条额度的分配策略 ----------
// 额度稀缺，所以按"这条推送能改变什么"排序，而不是按事件类型平铺：
//
//   优先级            价值                              可用上限
//   CRITICAL(100) 2h 内截止——还来得及做，错过就没了        5（可用全部）
//   HIGH(80)      24h 内截止——需要安排时间                4（留 1 条给 CRITICAL）
//   MEDIUM(60)    刚过期但**仍有补救动作**（如联系 HR/点拒绝顺延） 4（留 1 条给 CRITICAL）
//   ROUTINE(40)   每日汇总 / 登录检查——信息性，非紧急       3（留 2 条给上面两类）
//
// 这样设计的原因：例行汇总内容再多也只是"通知你"，而 2h 提醒是"再不点就没了"。
// 额度紧张时必须牺牲前者。另外"已过期且无补救动作"的事项不再单独占额度
// （已过期 9 天、next_action 为空的事项，推了也不能改变什么），只在汇总里列出。
const P = { CRITICAL: 100, HIGH: 80, MEDIUM: 60, ROUTINE: 40 };
const CAP = { [P.CRITICAL]: 5, [P.HIGH]: 4, [P.MEDIUM]: 4, [P.ROUTINE]: 3 };
const TIER_NAME = {
  [P.CRITICAL]: '紧急',
  [P.HIGH]: '重要',
  [P.MEDIUM]: '补救',
  [P.ROUTINE]: '例行',
};
function capFor(priority) {
  const keys = Object.keys(CAP)
    .map(Number)
    .sort((a, b) => b - a);
  for (const k of keys) if (priority >= k) return CAP[k];
  return CAP[P.ROUTINE];
}

// --dry-run：走完额度与去重判断，但不真正发请求（用于验证逻辑、避免烧额度）
const DRY_RUN = process.argv.slice(2).includes('--dry-run');

function todayKey() {
  return new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }).replace(/\//g, '-');
}
function readQuota() {
  try {
    const q = JSON.parse(fs.readFileSync(WX_QUOTA_FILE, 'utf8'));
    if (q.date === todayKey()) {
      if (
        !Number.isInteger(q.used) ||
        q.used < 0 ||
        !q.sent ||
        typeof q.sent !== 'object' ||
        Array.isArray(q.sent)
      )
        throw new Error('Invalid quota state');
      return q;
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error('Quota state unreadable; sending stopped');
  }
  return { date: todayKey(), used: 0, sent: {}, skipped: [] };
}
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + require('node:crypto').randomUUID();
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
function writeQuota(q) {
  atomicJson(WX_QUOTA_FILE, q);
}
// 记录因额度不足被丢弃的推送，便于事后发现"该提醒却没提醒"
function recordSkip(q, title, reason) {
  if (!Array.isArray(q.skipped)) q.skipped = [];
  q.skipped.push({ at: new Date().toISOString(), title, reason });
  q.skipped = q.skipped.slice(-50);
  writeQuota(q);
}

// 内容去重：同一批事项当天只推一次。
// 注意不能直接哈希正文——正文含"剩 X 小时"这类相对时间，每小时都变，
// 会导致"登录检查"和"每日汇总"内容不同而重复推送、烧掉额度。
// 因此用稳定签名：标题前缀 + 各事项的 公司|事件|绝对截止时间。
function contentHash(title, desp, sig) {
  const basis = sig || title + '\n' + desp;
  return require('crypto').createHash('sha1').update(basis).digest('hex').slice(0, 16);
}

// 由提醒结果生成稳定签名
function sigOf(r) {
  const items = [...r.soon, ...r.overdue].map((x) => `${x.company}|${x.event}|${x.atText}`).sort();
  return 'digest\n' + items.join('\n');
}

// priority 决定这条推送能用多少额度：越紧急可用额度越高，例行推送被压低。
function pushWechat(title, desp, sig, priority = P.ROUTINE) {
  const q = readQuota();
  const h = contentHash(title, desp, sig);
  const cap = capFor(priority);
  const tier = TIER_NAME[priority] || '例行';

  if (q.sent[h]) return 'WECHAT_ALREADY_SENT';
  if (q.used >= cap) {
    const why =
      `当天额度已用到 ${Math.min(q.used, cap)}/${WX_DAILY_LIMIT}，` +
      `${tier}级推送上限为 ${cap} 条（须给更高优先级留额度）`;
    if (!DRY_RUN) recordSkip(q, title, why);
    return `WECHAT_SKIP: ${why}，内容未推送`;
  }
  if (DRY_RUN) {
    return `WECHAT_DRYRUN: 将推送「${title}」（${tier}级，已用 ${q.used}/${cap}，签名 ${h}）`;
  }

  const key = loadSendkey();
  if (!key) return 'WECHAT_SKIP: 未配置凭据';

  const body = new URLSearchParams({ title: title.slice(0, 32), desp }).toString();
  const handle = (raw, route) => {
    const via = route === 'proxy' ? '，经代理' : '';
    try {
      const j = JSON.parse(raw);
      if (j.code === 0 && j.data && j.data.errno === 0) {
        // 只有真正发送成功才记账，失败不占用额度
        q.used += 1;
        q.sent[h] = new Date().toISOString();
        writeQuota(q);
        return `WECHAT_OK（今日已用 ${q.used}/${WX_DAILY_LIMIT}${via}）`;
      }
      const err = `${j.message || ''} ${(j.data && j.data.error) || ''}`;
      // 服务端说超额（40001）时，把本地计数直接拉满，避免后续每次运行都白打一次接口
      if (String(j.code) === '40001' || /发送次数限制/.test(err)) {
        q.used = WX_DAILY_LIMIT;
        writeQuota(q);
      }
      return `WECHAT_FAIL: code=${j.code} ${err.trim()}`;
    } catch {
      return 'WECHAT_FAIL: 响应无法解析';
    }
  };
  // Server酱是国内服务：先直连（不读环境代理设置），本机代理没开时也能送达；
  // 只有连接都没建立起来时才按环境代理重试一次，已发出的请求不重试，避免重复推送
  return postForm(key, body, true).then(({ raw, error }) => {
    if (raw !== undefined) return handle(raw, 'direct');
    if (!NOT_CONNECTED.has(error.code)) return 'WECHAT_FAIL: ' + error.message;
    return postForm(key, body, false).then((retry) =>
      retry.raw !== undefined
        ? handle(retry.raw, 'proxy')
        : `WECHAT_FAIL: 直连 ${error.code}；按环境代理重试 ${retry.error.message}`
    );
  });
}

const NOT_CONNECTED = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);
// direct=true 时给请求一个独立的 Agent，不经过 NODE_USE_ENV_PROXY 打开的环境代理
function postForm(key, body, direct) {
  const https = require('https');
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'sctapi.ftqq.com',
        path: `/${encodeURIComponent(key)}.send`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 30000,
        ...(direct ? { agent: new https.Agent() } : {}),
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ raw }));
      }
    );
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', (error) => resolve({ error }));
    req.write(body);
    req.end();
  });
}

// ---------- 微信正文（Markdown） ----------
// 设计取舍：72h 内到期的逐条详列（可行动）；已过期的只列名称+截止（每条在"刚过期"时
// 已单独详列推送过一次，这里避免每天重复长文把人逼到关通知）。
function buildWechatMarkdown(r) {
  const md = [];
  if (r.soon.length) {
    md.push('## 🔔 即将到期');
    r.soon.forEach((x) =>
      md.push(
        `**${x.company}** — ${x.event}\n\n> 截止 ${x.atText}（剩 ${Math.round(x.diffH)} 小时）` +
          `${x.next ? '\n\n> 下一步：' + x.next : ''}`
      )
    );
  }
  if (r.overdue.length) {
    md.push(`## ⚠ 已过期未处理（${r.overdue.length} 项）`);
    r.overdue
      .slice(0, 8)
      .forEach((x) => md.push(`**${x.company}** — ${x.event}\n\n> 截止 ${x.atText}`));
    if (r.overdue.length > 8) md.push(`…另有 ${r.overdue.length - 8} 项，见主表 follow_up.csv`);
  }
  return md.join('\n\n');
}

// ---------- CLI ----------
const args = process.argv.slice(2);

// ---------- --due：门槛跨越提醒，带去重与优先级分档 ----------
// 设计：每小时跑一次，只在事项"刚跨过"某个门槛时提醒一次，避免整点刷屏。
// 状态文件按 事件ID#门槛 记录已提醒；事项被处理掉后自动清理对应记录。
//
// 分档推送（而不是把所有命中塞进一条）：不同档的动作语义不同——
//   2h  = 现在就得去做（还来得及）
//   24h = 今天内安排时间
//   刚过期但有补救动作 = 赶紧联系/补救
// 分开推才能让人一眼看出"哪件现在必须动"。已过期且无补救动作的不单独推，
// 只在每日汇总里列出（推了也改变不了结果，不值得占用额度）。
// Each channel acknowledges only after its own successful delivery.
async function runDue(wantWechat) {
  const report = collect();
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error('Reminder state unreadable; kept unchanged');
  }
  const result = await core.deliverDue(report, state, {
    channels: wantWechat ? ['wechat', 'toast'] : ['toast'],
    dryRun: DRY_RUN,
    now: new Date(),
    persist: (next) => atomicJson(STATE, next),
    send: async (channel, group) => {
      const title = `${group.title}（${group.items.length} 项）`;
      const text = group.items.map((it) => fmtItem(it, true)).join('\n\n');
      const sig =
        `due-${group.id}\n` +
        group.items
          .map((it) => it.receipt_key)
          .sort()
          .join('\n');
      if (channel === 'wechat') return pushWechat(title, text, sig, group.priority);
      return notify(title, group.items.map((it) => `${it.company}: ${it.event}`).join(' / '));
    },
  });
  if (!result.results.length) console.log('【门槛提醒】无待发送事项。');
  for (const item of result.results)
    console.log(`[${item.channel}] ${item.threshold}: ${item.count} 项 ${item.response}`);
  if (!DRY_RUN)
    logRun(
      'due: ' +
        result.results.map((x) => `${x.channel}/${x.threshold}/${x.count}:${x.response}`).join('; ')
    );
  return result;
}

async function runCli() {
  const WANT_WECHAT = args.includes('--wechat') || args.includes('--all');
  const WANT_TOAST = args.includes('--notify') || args.includes('--all');

  if (args.includes('--due')) {
    await runDue(WANT_WECHAT);
    return;
  }

  const r = collect();

  if (args.includes('--json')) {
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  // --quota：查看今天微信额度使用与被跳过的推送（排查"该提醒却没提醒"）
  if (args.includes('--quota')) {
    const q = readQuota();
    console.log(`微信推送额度（${q.date}）：已用 ${q.used}/${WX_DAILY_LIMIT}`);
    console.log('分档上限：紧急(2h)=5 重要(24h)=4 补救(已过期有动作)=4 例行(汇总)=3');
    console.log('（例行被压低是为了把额度留给更紧急的档）');
    const skipped = q.skipped || [];
    if (skipped.length) {
      console.log(`\n⚠ 当天被跳过的推送 ${skipped.length} 条：`);
      skipped.forEach((s) => console.log(`· ${s.title} —— ${s.reason}`));
    } else {
      console.log('\n没有被跳过的推送。');
    }
    const sent = Object.keys(q.sent || {}).length;
    console.log(`\n已成功推送内容数：${sent}`);
    return;
  }

  const text = buildText(r);
  console.log(text);

  const n = r.overdue.length + r.soon.length;
  let toastRes = '-',
    wxRes = '-';
  if (WANT_TOAST && !DRY_RUN) {
    if (n === 0) {
      console.log('\n[无到期事项，跳过桌面通知]');
      toastRes = 'skip(无事项)';
    } else {
      const lines = [];
      if (r.overdue.length)
        lines.push(`已过期 ${r.overdue.length} 项：` + r.overdue.map((x) => x.company).join('、'));
      if (r.soon.length)
        lines.push(
          `即将到期 ${r.soon.length} 项：` +
            r.soon.map((x) => `${x.company}(${Math.round(x.diffH)}h)`).join('、')
        );
      toastRes = notify('秋招提醒', lines.join(' / '));
      console.log('\n[通知] ' + toastRes);
    }
  }

  if (WANT_WECHAT) {
    if (n === 0) {
      console.log('[微信] 无到期事项，跳过推送');
      wxRes = 'skip(无事项)';
    } else {
      const parts = [];
      if (r.soon.length) parts.push(`即将到期 ${r.soon.length} 项`);
      if (r.overdue.length) parts.push(`已过期 ${r.overdue.length} 项`);
      wxRes = await pushWechat(
        `秋招提醒：${parts.join('，')}`,
        buildWechatMarkdown(r),
        sigOf(r),
        P.ROUTINE
      );
      console.log('[微信] ' + wxRes);
    }
  }

  if (!DRY_RUN && (WANT_TOAST || WANT_WECHAT))
    logRun(`汇总: 过期=${r.overdue.length} 即将=${r.soon.length} toast=${toastRes} wx=${wxRes}`);

  // 退出码：默认 0（计划任务不因"有过期项"被标记为失败）；--strict 时有过期项返回 1，
  // 供会话检查 / 脚本判断使用。放在异步流程末尾，避免提前 process.exit 掐断微信推送。
  process.exitCode = args.includes('--strict') && r.overdue.length ? 1 : 0;
}

function acquireDeliveryLock() {
  const file = path.join(ROOT, 'CareerWorkbench/tmp/reminder-delivery.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }), 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        try {
          if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file);
        } catch {}
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner;
      try {
        owner = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return null;
      }
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) return null;
      try {
        process.kill(owner.pid, 0);
        return null;
      } catch (err) {
        if (err.code !== 'ESRCH') return null;
      }
      // Only a dead recorded owner permits recovery; never break a live lock.
      try {
        fs.unlinkSync(file);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
    }
  }
  return null;
}
async function main() {
  const allowed = new Set([
    '--notify',
    '--wechat',
    '--all',
    '--due',
    '--json',
    '--quota',
    '--strict',
    '--dry-run',
  ]);
  for (const flag of args) if (!allowed.has(flag)) throw new Error('Unknown reminder option');
  if (args.includes('--json') && args.includes('--due')) {
    const report = collect();
    console.log(
      JSON.stringify({ preview: true, groups: core.planDue(report, {}, 'toast') }, null, 2)
    );
    return;
  }
  const sends =
    !DRY_RUN &&
    !args.includes('--json') &&
    !args.includes('--quota') &&
    args.some((f) => ['--notify', '--wechat', '--all', '--due'].includes(f));
  if (!sends) return runCli();
  const release = acquireDeliveryLock();
  if (!release) {
    console.log('REMINDER_BUSY: another delivery is active; nothing acknowledged');
    return;
  }
  try {
    return await runCli();
  } finally {
    release();
    // tmp 自动清理已停用：tmp 里有投递记录和调研报告引用的证据，按修改时间删除会丢证据
    if (args.includes('--all')) startTrackerBackup();
  }
}
// 每晚汇总和登录检查顺带把主表快照备份到 lapis-cv 并推送。推送可能慢，
// 放到独立的后台进程里，不拖慢提醒；结果写 logs/backup.log
function startTrackerBackup() {
  try {
    require('node:child_process')
      .spawn(process.execPath, [path.join(__dirname, 'backup-tracker.js'), '--push'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      .unref();
  } catch (e) {
    logRun('主表备份启动失败：' + e.message);
  }
}
if (require.main === module)
  main().catch((e) => {
    console.error('REMINDER_ERROR: ' + e.message);
    process.exitCode = 1;
  });
module.exports = { collect, parseCsv, runDue, fmtItem, buildText, acquireDeliveryLock, pushWechat };
