'use strict';
// tracker-cli 与 MCP server 共用的只读入口：路径解析、rules、brief、validate 只在这里实现一份。
const fs = require('node:fs'),
  path = require('node:path');
const { createStore } = require('../dashboard/store');
const { locate, createTrackerGit } = require('./tracker-git');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function createTrackerService(options = {}) {
  const project = path.resolve(options.projectDir || path.resolve(__dirname, '..'));
  const workspace = path.resolve(options.workspaceDir || path.dirname(project));
  // 主表位置：显式 dataDir > JOBHUNT_DATA_DIR > 私有仓库 lapis-cv 的 tracker/（专用 worktree）> dashboard/
  const location = options.dataDir
    ? { dataDir: path.resolve(options.dataDir), git: null }
    : locate({ project, workspace, env: options.env || process.env });
  const dataDir = location.dataDir;
  const tracker = location.git ? createTrackerGit(location.git) : null;
  if (tracker && !options.store) tracker.ensure();
  const discoveryRoot = path.resolve(
    options.discoveryDir ||
      process.env.JOBHUNT_DISCOVERY_DIR ||
      path.join(project, 'data', 'company-discovery')
  );
  const policyFile = path.resolve(
    options.policyFile || path.join(project, 'data', 'private', 'policy-review.json')
  );
  const rulesFile = path.resolve(
    options.rulesFile || path.join(workspace, 'lapis-cv', '秋招', '求职档案.md')
  );
  const store = options.store || createStore(dataDir);
  // 主表在仓库里时：读前拉取（strict=false 只警告），写后提交推送。不在仓库里时都是空操作。
  function sync({ strict = false } = {}) {
    const result = tracker ? tracker.refresh({ strict }) : { warnings: [] };
    if (tracker && !fs.existsSync(path.join(dataDir, 'job_pool.csv')))
      throw Error('主表不存在：' + path.join(dataDir, 'job_pool.csv'));
    return result;
  }
  function publish(message) {
    return tracker ? tracker.publish(message) : null;
  }
  // 所有写入口（CLI、MCP、本地看板）共用：写前严格拉取，写后提交推送
  function commitPlan(plan, dryRun = false) {
    sync({ strict: true });
    const result = store.commit(plan, dryRun);
    if (dryRun || !tracker) return result;
    const types = [...new Set((plan.operations || []).map((op) => op.type))].join(', ');
    const jobs = (result.changed_jobs || []).length;
    const git = publish(
      `主表：${types || '写入'}，${jobs} 个岗位（revision ${String(result.revision || '').slice(0, 12)}）`
    );
    return { ...result, git };
  }

  function policyText() {
    try {
      return fs.readFileSync(rulesFile, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      return '';
    }
  }
  function rules() {
    const { currentSection } = require('../dashboard/brief'),
      text = policyText();
    if (!text) throw Error('Current rules source is missing');
    return {
      source: 'lapis-cv/秋招/求职档案.md',
      read_only: true,
      selection_rules: currentSection(text, '选岗规则'),
      evidence_boundaries: currentSection(text, '经历与表述边界'),
      note: '只提取当前规则与经历边界；公司历史和个人字段按需另读，不以本输出证明任何岗位在招。',
    };
  }
  function brief({ limit = 8 } = {}) {
    const { buildBrief } = require('../dashboard/brief');
    let policy;
    try {
      policy = readJson(policyFile);
    } catch (e) {
      if (e.code !== 'ENOENT') policy = { invalid: true };
    }
    let discovery = null;
    const extraWarnings = [];
    try {
      const { createDiscoveryStore } = require('../discovery/store'),
        { buildDiscoveryNext } = require('../discovery/view');
      discovery = buildDiscoveryNext(createDiscoveryStore(discoveryRoot).snapshot(), {
        limit,
        now: new Date(),
      });
    } catch (error) {
      extraWarnings.push('Discovery summary unavailable: ' + error.message);
    }
    const reminderHealth = require('./reminder-health');
    return buildBrief(store.snapshot(), {
      policy,
      policyText: policyText(),
      limit,
      discovery,
      extraWarnings,
      reminderHealth: reminderHealth.assess(
        reminderHealth.read(path.join(project, 'logs', 'reminder-health.json'))
      ),
    });
  }
  function validate() {
    const snap = store.snapshot();
    return {
      revision: snap.revision,
      counts: Object.fromEntries(Object.entries(snap.tables).map(([k, v]) => [k, v.length])),
      warnings: snap.warnings,
    };
  }
  return {
    store,
    rules,
    brief,
    validate,
    sync,
    publish,
    commitPlan,
    gitBacked: Boolean(tracker),
    paths: { project, workspace, dataDir, discoveryRoot },
  };
}

module.exports = { createTrackerService, readJson };
