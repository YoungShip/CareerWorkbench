'use strict';
// 客户端无关的只读预检。不启动 agent，不测试浏览器实际访问，不做任何写入。
//
// 用法: node CareerWorkbench/scripts/trae-preflight.js [客户端名]
//   客户端名省略时自动探测（扫描工作区内已接线技能的客户端目录）。
//   文件名沿用历史（trae-preflight）；自 2026-09-16 起不再限定 trae/zcode/claude。
//   .agents 是真身（单一来源），不作为客户端参与探测。
//
// 边界：本脚本只能检查文件系统与本地端口。
//   ①日常 Chrome 插件连接、②内置浏览器属客户端运行时能力，脚本无法探测；
//   ③A Playwright 专用 profile 与 ③B Raw CDP 专用通道可检查本地工具链/端口。
//   实际登录态和页面可操作性仍须执行任务的 AI 打开页面核实（见 AGENTS.md ## 0）。
const fs = require('node:fs'),
  path = require('node:path');
const { defaultPython } = require('../lib/python-runtime');
const { spawnSync } = require('node:child_process');
const http = require('node:http');
const { targetSkillsRoot } = require('../lib/skill-paths');

const project = path.resolve(__dirname, '..'),
  workspace = path.dirname(project);
const skills = path.join(workspace, '.agents', 'skills');
const SKILL_NAMES = ['campus-recruitment', 'job-application-form-filling', 'offernotes-sync'];
const python = defaultPython();
const checks = [];

function file(name, p) {
  checks.push({ name, ok: fs.existsSync(p), path: p });
}
// 仓库 skills/ 是版本源，.agents/skills 是运行位置；有差异只提示，不阻断预检
function skillsSource() {
  try {
    const d = require('./skills-sync').diffSkills();
    return d.in_sync
      ? { in_sync: true }
      : {
          in_sync: false,
          changed: d.changed,
          only_repo: d.onlyRepo,
          only_installed: d.onlyInstalled,
          fix: '本机改过技能：npm run skills:capture 后提交；仓库更新未安装：npm run skills:install',
        };
  } catch (e) {
    return { in_sync: null, error: e.message };
  }
}
function real(p) {
  try {
    return fs.realpathSync(p).toLowerCase();
  } catch {
    return null;
  }
}
function invoke(name, exe, args, parse) {
  const r = spawnSync(exe, args, {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    cwd: project,
  });
  let ok = !r.error && r.status === 0,
    detail;
  if (ok && parse) {
    try {
      detail = parse(JSON.parse(r.stdout));
    } catch {
      ok = false;
    }
  }
  checks.push({
    name,
    ok,
    ...(detail ? { detail } : {}),
    ...(!ok
      ? { error: r.error?.message || 'Command failed; inspect this command separately.' }
      : {}),
  });
}

// 1. 扫描工作区各客户端的技能接线（不限定客户端名称；.agents 为真身，排除）
const clientDirs = [];
for (const entry of fs.readdirSync(workspace, { withFileTypes: true })) {
  if (
    !entry.isDirectory() ||
    !entry.name.startsWith('.') ||
    entry.name === '.git' ||
    entry.name === '.agents'
  )
    continue;
  const client = entry.name.slice(1);
  const skillsDir = path.join(workspace, entry.name, 'skills');
  let hasSkillsDir = false;
  try {
    hasSkillsDir = fs.existsSync(skillsDir) && fs.statSync(skillsDir).isDirectory();
  } catch {}
  const linked = [];
  if (hasSkillsDir)
    for (const name of SKILL_NAMES) {
      const p = path.join(skillsDir, name);
      if (fs.existsSync(path.join(p, 'SKILL.md')))
        linked.push({ name, single_source: real(p) === real(path.join(skills, name)) });
    }
  clientDirs.push({
    client,
    dir: entry.name,
    has_skills_dir: hasSkillsDir,
    wired: linked.length === SKILL_NAMES.length,
    skills: linked,
  });
}
const wiredClients = clientDirs.filter((c) => c.wired).map((c) => c.client);

// skills 目录存在但技能读不到 = 该客户端无法加载技能。
// 已实测：junction 在本机该环境下创建正常、reparse 数据正确，但整体无法穿透；
// 指向普通目录的新 junction 同样失败，故不是单个链接损坏。
// skills 目录存在但技能读不到 = 本执行上下文（进程）无法穿透 reparse 点。
// 已实测：该 Junction 在普通终端可正常读取，故通常不是链接损坏，而是本进程文件访问层的限制；
// 同一客户端的原生进程可能不受影响。故此处只作诊断提示，不代表客户端本身一定失败。
const clientNotes = clientDirs
  .filter((c) => c.has_skills_dir && c.skills.length === 0)
  .map(
    (c) =>
      c.dir +
      '/skills 存在，但本进程读不到其中 ' +
      SKILL_NAMES.length +
      ' 个技能：无法穿透指向 .agents/skills 的 Junction/reparse 点。该 Junction 在普通终端可正常读取，因此更可能是本进程文件访问层的限制而非链接损坏；同一客户端的原生进程可能不受影响。真身可读，可用 AGENTS.md 的绝对路径兜底。'
  );

// 客户端技能可读性计入 local_ok：目录在但读不到是真故障，必须显式失败，不能静默放过
for (const c of clientDirs) {
  if (!c.has_skills_dir) continue;
  checks.push({
    name: c.dir + '-skills-readable',
    ok: c.skills.length === SKILL_NAMES.length,
    detail: {
      dir: c.dir + '/skills',
      readable: c.skills.map((s) => s.name),
      expected: SKILL_NAMES.length,
    },
  });
}

// 2. 解析目标客户端：显式参数优先，其次自动探测
const argvClient = process.argv[2] || null;
let executor, executorSource;
if (argvClient) {
  executor = argvClient;
  executorSource = 'argv';
} else if (wiredClients.length === 1) {
  executor = wiredClients[0];
  executorSource = 'auto-single';
} else if (wiredClients.length > 1) {
  executor = '(ambiguous)';
  executorSource = 'auto-ambiguous';
} else {
  executor = '(none)';
  executorSource = 'auto-none';
}
const targets =
  executorSource === 'argv' || executorSource === 'auto-single' ? [executor] : wiredClients;
const targetSkillRoots = Object.fromEntries(
  targets.map((cli) => [cli, targetSkillsRoot(workspace, cli)])
);

// 3. 技能原件与本次目标的单源一致性
for (const name of SKILL_NAMES) file(name, path.join(skills, name, 'SKILL.md'));
for (const cli of targets) {
  for (const name of SKILL_NAMES) {
    const entry = path.join(targetSkillRoots[cli].root, name);
    file(cli + '-' + name, path.join(entry, 'SKILL.md'));
    checks.push({
      name: cli + '-single-source-' + name,
      ok: real(entry) === real(path.join(skills, name)),
    });
  }
}

// 4. 权威数据与本地工具（保持原有检查项）
for (const name of ['求职档案.md', '公司调研占用表.md', '后续公司优先池.md'])
  file(name, path.join(workspace, 'lapis-cv', '秋招', name));
file('discovery-state', path.join(project, 'data', 'company-discovery', 'leads.json'));
file(
  'matching-validator',
  path.join(skills, 'campus-recruitment', 'scripts', 'verify-matching.py')
);
invoke('python', python, ['--version']);
invoke('tracker-validate', process.execPath, [
  path.join(project, 'dashboard', 'tracker-cli.js'),
  'validate',
]);
// 声明了个人母表的实际工作区才核对材料；独立源码演示不需要个人资料。
const canonicalProfile = path.join(workspace, 'lapis-cv', '秋招', '网申档案.json');
if (fs.existsSync(canonicalProfile)) {
  const agentPython =
    process.platform === 'win32'
      ? path.join(project, 'agent', '.venv', 'Scripts', 'python.exe')
      : path.join(project, 'agent', '.venv', 'bin', 'python');
  invoke(
    'materials-consistency',
    fs.existsSync(agentPython) ? agentPython : python,
    [path.join(project, 'scripts', 'check-workspace-materials.py')],
    (s) => ({
      status: s.status,
      project_count: s.project_count,
      resumes: s.resumes?.map((r) => ({
        variant: r.variant,
        project_ids: r.project_ids,
        pages: r.pages,
      })),
      errors: s.errors,
      warnings: s.warnings,
    })
  );
}
// query 内部仍读取并校验完整状态，只投影一条，避免大型历史 snapshot 撑爆 stdout 缓冲区。
invoke(
  'discovery-validated-query',
  process.execPath,
  [
    path.join(project, 'discovery', 'cli.js'),
    'query',
    '--fields=lead_id,company,state',
    '--limit=1',
  ],
  (s) => ({ revision: s.revision, active_run_id: s.active_run_id || null, leads: s.counts.total })
);
invoke(
  'site-knowledge-status',
  process.execPath,
  [path.join(project, 'scripts', 'site-knowledge-status.js'), '--json'],
  (s) => ({
    summary: s.summary,
    attention:
      s.entries
        ?.filter((e) => e.freshness !== 'fresh')
        .map((e) => ({ file: e.file, status: e.knowledge_status, freshness: e.freshness })) || [],
  })
);

// 5. 第 3 级本地浏览器通道（只读；不计入 local_ok，因为属于可选执行能力）
const playwrightDir = path.join(project, 'data', 'private', 'playwright-application');
const playwrightRuntime = path.join(
  playwrightDir,
  'runtime',
  'node_modules',
  'playwright-core',
  'package.json'
);
const playwrightFiles = ['launch-run.js', 'probe.js', 'close.js'];
const playwrightMissing = playwrightFiles.filter(
  (f) => !fs.existsSync(path.join(playwrightDir, f))
);
const playwrightProfile = path.join(playwrightDir, 'chrome-profile');
let playwrightVersion = null;
try {
  playwrightVersion = JSON.parse(fs.readFileSync(playwrightRuntime, 'utf8')).version || null;
} catch {}

const cdpDir = path.join(project, 'data', 'private', 'offernotes-cdp');
const cdpFiles = [
  'launch-run.js',
  'launch-config.json',
  'cdp-probe.js',
  'cdp-sync.js',
  'cdp-list-progress.js',
  'cdp-close.js',
];
const cdpMissing = cdpFiles.filter((f) => !fs.existsSync(path.join(cdpDir, f)));
const cdpProfile = path.join(cdpDir, 'chrome-profile');
const playwrightDirPosix = playwrightDir.replace(/\\/g, '/');
const cdpDirPosix = cdpDir.replace(/\\/g, '/');

function probePort(port) {
  return new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 1500 }, (r) => {
      let d = '';
      r.on('data', (c) => {
        d += c;
      });
      r.on('end', () => res({ state: 'listening', httpStatus: r.statusCode }));
    });
    req.on('timeout', () => {
      req.destroy();
      res({ state: 'not_listening', reason: 'timeout' });
    });
    req.on('error', (e) => res({ state: 'not_listening', reason: e.code || e.message }));
  });
}

(async () => {
  const [playwrightPort, cdpPort] = await Promise.all([probePort(9333), probePort(9222)]);

  const unverified = [];
  for (const cli of targets.length ? targets : ['(未指定客户端)'])
    unverified.push(cli + ' skill loading', cli + ' search', cli + ' browser and login');
  unverified.push(
    'Playwright ATS page execution',
    'OfferNotes page execution',
    'unattended continuation'
  );

  const channelAdvice = {
    cannot_detect:
      '①日常 Chrome 插件连接与②内置浏览器属客户端运行时能力，本脚本无法探测；登录态和网页实际可操作性也必须打开目标页核实。',
    level3A_playwright: {
      purpose: '网申页面、上传、解析纠错、表单填写与读回；最终提交另受授权模式控制',
      dir: playwrightDir,
      runtime: { present: !!playwrightVersion, version: playwrightVersion },
      toolchain: { missing: playwrightMissing, present: playwrightMissing.length === 0 },
      profile: { path: playwrightProfile, present: fs.existsSync(playwrightProfile) },
      port_9333: playwrightPort,
      commands: {
        launch: 'node ' + playwrightDirPosix + '/launch-run.js <URL>',
        probe: 'node ' + playwrightDirPosix + '/probe.js',
        close: 'node ' + playwrightDirPosix + '/close.js',
      },
    },
    level3B_raw_cdp: {
      purpose: 'OfferNotes 同步和只读诊断；不作为普通 ATS 填表首选',
      dir: cdpDir,
      toolchain: { missing: cdpMissing, present: cdpMissing.length === 0 },
      profile: { path: cdpProfile, present: fs.existsSync(cdpProfile) },
      port_9222: cdpPort,
      commands: [
        'node ' + cdpDirPosix + '/launch-run.js',
        'node ' + cdpDirPosix + '/cdp-probe.js',
        'node ' +
          cdpDirPosix +
          '/cdp-sync.js <payload绝对路径> CareerWorkbench/dashboard/offernotes-reconcile.js <out绝对路径>',
        'node ' + cdpDirPosix + '/cdp-list-progress.js <公司关键词>',
        'node ' + cdpDirPosix + '/cdp-close.js',
      ],
    },
    note: '若 ①/② 不存在或不可靠，网申优先③A Playwright；OfferNotes/API 同步按需③B Raw CDP。端口未监听只表示专用实例未启动，不等于登录失效。禁止 remote-debug 用户默认 Chrome profile。',
    excluded:
      'agent-browser 对 OfferNotes 必然 403（独立 Chromium profile，无登录态），已排除，不要再提议。',
    reference: 'AGENTS.md ## 0/7/8 与 job-application-form-filling / offernotes-sync skills',
  };

  console.log(
    JSON.stringify(
      {
        local_ok: checks.every((c) => c.ok),
        executor,
        executor_source: executorSource,
        wired_clients: wiredClients,
        client_dirs: clientDirs,
        client_notes: clientNotes,
        target_skill_roots: targetSkillRoots,
        skills_source: skillsSource(),
        python,
        node: process.execPath,
        checks,
        channel_advice: channelAdvice,
        unverified,
        starts_agent: false,
      },
      null,
      2
    )
  );
  if (checks.some((c) => !c.ok)) process.exitCode = 1;
})().catch((e) => {
  console.log(JSON.stringify({ fatal: e.message, starts_agent: false }, null, 2));
  process.exitCode = 1;
});
