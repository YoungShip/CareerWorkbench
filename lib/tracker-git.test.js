'use strict';
// 主表放在私有仓库 tracker/ 时的同步：用本地裸仓库模拟 GitHub，两个工作区模拟本机和云端。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { locate, createTrackerGit, TrackerSyncError } = require('./tracker-git');
const { createTrackerService } = require('./tracker-service');
const { createStore } = require('../dashboard/store');

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tracker-git-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = path.join(root, 'seed');
  git(root, 'clone', '-q', remote, seed);
  git(seed, 'config', 'user.email', 't@example.com');
  git(seed, 'config', 'user.name', 't');
  const store = createStore(path.join(seed, 'tracker'));
  store.initialize({
    job_pool: [{ job_id: 'j1', company: 'Company', job_title: 'Title', status: 'Pending' }],
    application_log: [],
    follow_up: [],
    sync_queue: [],
  });
  fs.writeFileSync(path.join(seed, 'tracker', '.gitignore'), '.store/\n');
  fs.writeFileSync(path.join(seed, 'README.md'), 'resume\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  // 两个工作区：resume/{CareerWorkbench,lapis-cv}
  const workspace = (name) => {
    const ws = path.join(root, name);
    fs.mkdirSync(path.join(ws, 'CareerWorkbench'), { recursive: true });
    git(ws, 'clone', '-q', remote, 'lapis-cv');
    git(path.join(ws, 'lapis-cv'), 'config', 'user.email', name + '@example.com');
    git(path.join(ws, 'lapis-cv'), 'config', 'user.name', name);
    const env = { JOBHUNT_GIT_PROXY: '' };
    const service = () =>
      createTrackerService({
        projectDir: path.join(ws, 'CareerWorkbench'),
        workspaceDir: ws,
        env,
      });
    return { ws, env, service };
  };
  return { root, remote, seed, workspace };
}

const patch = (service, notes) => {
  const snap = service.store.snapshot();
  return service.commitPlan({
    expected_revision: snap.revision,
    operations: [{ type: 'job.patch', job_id: 'j1', patch: { notes } }],
  });
};

test('locate prefers JOBHUNT_DATA_DIR, then the private repo, then dashboard/', (t) => {
  const { workspace } = setup(t);
  const { ws } = workspace('a');
  const project = path.join(ws, 'CareerWorkbench');
  assert.equal(locate({ project, workspace: ws, env: { JOBHUNT_DATA_DIR: '/x' } }).git, null);
  const repo = locate({ project, workspace: ws, env: {} });
  assert.equal(repo.dataDir, path.join(project, 'data', 'private', 'tracker-worktree', 'tracker'));
  assert.equal(repo.git.repo, path.join(ws, 'lapis-cv'));
  const off = locate({ project, workspace: ws, env: { JOBHUNT_TRACKER_GIT: '0' } });
  assert.equal(off.dataDir, path.join(project, 'dashboard'));
});

test('a write in one workspace is pushed and seen by the other; user checkout untouched', (t) => {
  const { workspace, remote } = setup(t);
  const a = workspace('a'),
    b = workspace('b');
  const sa = a.service();
  const result = patch(sa, 'from a');
  assert.equal(result.git.push, 'pushed');
  assert.match(git(remote, 'log', '-1', '--format=%s', 'main'), /^主表：job\.patch，1 个岗位/);
  const sb = b.service();
  sb.sync({ strict: true });
  assert.equal(sb.store.query({ job_ids: ['j1'], fields: ['notes'] }).jobs[0].notes, 'from a');
  assert.equal(sb.store.snapshot().revision, sa.store.snapshot().revision);
  // 本人的 lapis-cv 工作目录不被修改
  assert.equal(git(path.join(a.ws, 'lapis-cv'), 'status', '--porcelain'), '');
  assert.equal(git(path.join(a.ws, 'lapis-cv'), 'log', '-1', '--format=%s').trim(), 'seed');
});

test('a write planned on a stale revision is refused after the pull', (t) => {
  const { workspace } = setup(t);
  const sa = workspace('a').service(),
    sb = workspace('b').service();
  const stale = sb.store.snapshot().revision;
  patch(sa, 'from a');
  assert.throws(
    () =>
      sb.commitPlan({
        expected_revision: stale,
        operations: [{ type: 'job.patch', job_id: 'j1', patch: { notes: 'from b' } }],
      }),
    /revision|Revision|changed/
  );
  assert.equal(sb.store.query({ job_ids: ['j1'], fields: ['notes'] }).jobs[0].notes, 'from a');
});

test('push race on tracker/ shelves the local write as a patch instead of merging CSV text', (t) => {
  const { workspace, remote } = setup(t);
  const a = workspace('a'),
    b = workspace('b');
  const sa = a.service(),
    sb = b.service();
  // b 已经在最新版本上写盘，推送前 a 抢先推了 tracker/ 的改动
  sb.sync({ strict: true });
  const snap = sb.store.snapshot();
  sb.store.commit({
    expected_revision: snap.revision,
    operations: [{ type: 'job.patch', job_id: 'j1', patch: { notes: 'from b' } }],
  });
  patch(sa, 'from a');
  assert.throws(() => sb.publish('主表：b'), TrackerSyncError);
  const shelved = path.join(sb.paths.dataDir, '.store', 'unpushed');
  assert.equal(fs.readdirSync(shelved).length, 1);
  assert.equal(sb.store.query({ job_ids: ['j1'], fields: ['notes'] }).jobs[0].notes, 'from a');
  assert.match(git(remote, 'log', '-1', '--format=%s', 'main'), /job\.patch/);
});

test('push race on other paths rebases and pushes', (t) => {
  const { workspace, seed, remote } = setup(t);
  const sa = workspace('a').service();
  sa.sync({ strict: true });
  const snap = sa.store.snapshot();
  sa.store.commit({
    expected_revision: snap.revision,
    operations: [{ type: 'job.patch', job_id: 'j1', patch: { notes: 'from a' } }],
  });
  fs.writeFileSync(path.join(seed, 'README.md'), 'resume v2\n');
  git(seed, 'commit', '-q', '-am', 'resume edit');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  assert.equal(sa.publish('主表：a').push, 'pushed');
  const files = git(remote, 'show', '--name-only', '--format=', 'main');
  assert.match(files, /tracker\/job_pool\.csv/);
  assert.equal(git(remote, 'show', 'main:README.md'), 'resume v2\n');
});

test('network failure keeps the commit locally and the next command pushes it', (t) => {
  const { workspace, remote, root } = setup(t);
  const a = workspace('a');
  const sa = a.service();
  const repo = path.join(a.ws, 'lapis-cv');
  git(repo, 'remote', 'set-url', 'origin', path.join(root, 'missing.git'));
  // 拉取失败时严格模式拒绝写入
  assert.throws(() => patch(sa, 'offline'), TrackerSyncError);
  // 只读命令只给警告
  assert.match(sa.sync({ strict: false }).warnings[0], /拉取主表失败/);
  // 已经写盘、提交后推送失败：保留本地提交
  const snap = sa.store.snapshot();
  sa.store.commit({
    expected_revision: snap.revision,
    operations: [{ type: 'job.patch', job_id: 'j1', patch: { notes: 'later' } }],
  });
  assert.match(sa.publish('主表：离线').push, /^pending/);
  git(repo, 'remote', 'set-url', 'origin', remote);
  sa.sync({ strict: true });
  assert.match(git(remote, 'log', '-1', '--format=%s', 'main'), /离线/);
});

test('remind-style reader without the worktree creates it from the remote', (t) => {
  const { workspace } = setup(t);
  const a = workspace('a');
  const loc = locate({ project: path.join(a.ws, 'CareerWorkbench'), workspace: a.ws, env: a.env });
  const r = createTrackerGit(loc.git).refresh({ strict: false });
  assert.deepEqual(r.warnings, []);
  assert.ok(fs.existsSync(path.join(loc.dataDir, 'follow_up.csv')));
});
