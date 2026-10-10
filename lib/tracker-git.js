'use strict';
// 主表放在私有仓库 lapis-cv（GitHub 上叫 yxp-cv）的 tracker/ 目录，所有环境都在同一份上读写。
// 读写都在 CareerWorkbench/data/private/tracker-worktree 这个专用 git worktree 里进行，
// 不碰本人的 lapis-cv 工作目录。每次读之前拉取，每次写入后提交并推送到 main。
// 推送被拒且远程的 tracker/ 也变了（别处刚写过）时，不做文本合并：本次写入存成补丁后撤回，
// 由调用方按最新主表重新 preview → apply。
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SUBDIR = 'tracker';
const BRANCH = 'main';

function locate({ project, workspace, env = process.env }) {
  if (env.JOBHUNT_DATA_DIR) return { dataDir: path.resolve(env.JOBHUNT_DATA_DIR), git: null };
  const repo = path.join(workspace, 'lapis-cv');
  if (env.JOBHUNT_TRACKER_GIT !== '0' && fs.existsSync(path.join(repo, '.git'))) {
    const worktree = path.resolve(
      env.JOBHUNT_TRACKER_WORKTREE || path.join(project, 'data', 'private', 'tracker-worktree')
    );
    return {
      dataDir: path.join(worktree, SUBDIR),
      git: { repo, worktree, proxy: env.JOBHUNT_GIT_PROXY ?? 'http://127.0.0.1:7890' },
    };
  }
  return { dataDir: path.join(project, 'dashboard'), git: null };
}

class TrackerSyncError extends Error {}

function run(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 180000,
    // 后台运行时不能弹出凭据输入框，否则会一直挂住
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
}

function createTrackerGit(git) {
  const { repo, worktree, proxy } = git;
  // 锁放在 worktree 外面：worktree 还没建好时也能加锁
  const lockDir = worktree + '.lock';
  const inTree = (args) => run(args, worktree);
  // 本机直连 GitHub 不稳定：失败时改走本机代理重试一次
  function remote(args) {
    try {
      run(args, worktree);
    } catch (e) {
      if (!proxy) throw e;
      run(['-c', 'http.proxy=' + proxy, ...args], worktree);
    }
  }
  function ensure() {
    if (fs.existsSync(path.join(worktree, '.git'))) return;
    run(['worktree', 'prune'], repo);
    try {
      run(['fetch', '-q', 'origin', BRANCH], repo);
    } catch (e) {
      if (!proxy) throw e;
      run(['-c', 'http.proxy=' + proxy, 'fetch', '-q', 'origin', BRANCH], repo);
    }
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    run(['worktree', 'add', '-q', '--detach', worktree, 'origin/' + BRANCH], repo);
    if (!fs.existsSync(path.join(worktree, SUBDIR, 'job_pool.csv')))
      throw new TrackerSyncError(
        `远程 ${BRANCH} 分支里没有 ${SUBDIR}/job_pool.csv，主表还没迁进仓库`
      );
  }
  function withLock(fn, { wait = false } = {}) {
    fs.mkdirSync(path.dirname(lockDir), { recursive: true });
    const deadline = Date.now() + (wait ? 60000 : 0);
    for (;;) {
      try {
        fs.mkdirSync(lockDir);
        break;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let pid = null;
        try {
          pid = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8')).pid;
        } catch {}
        let alive = false;
        try {
          if (pid) (process.kill(pid, 0), (alive = true));
        } catch {}
        if (pid && !alive) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= deadline) return { busy: true };
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      }
    }
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid }));
    try {
      return fn();
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }
  const head = () => inTree(['rev-parse', 'HEAD']).trim();
  const dirty = () => inTree(['status', '--porcelain', '--', SUBDIR]).trim() !== '';
  const ahead = () => Number(inTree(['rev-list', '--count', 'origin/' + BRANCH + '..HEAD']).trim());
  // 远程的 tracker/ 相对本地提交的基点是否变过
  function remoteTrackerChanged() {
    const base = inTree(['merge-base', 'HEAD', 'origin/' + BRANCH]).trim();
    try {
      inTree(['diff', '--quiet', base, 'origin/' + BRANCH, '--', SUBDIR]);
      return false;
    } catch {
      return true;
    }
  }
  // 本地未推送的写入和远程冲突：存成补丁后撤回，绝不做 CSV 文本合并
  function shelve(reason) {
    const patchDir = path.join(worktree, SUBDIR, '.store', 'unpushed');
    fs.mkdirSync(patchDir, { recursive: true });
    const file = path.join(patchDir, new Date().toISOString().replace(/[:.]/g, '-') + '.patch');
    fs.writeFileSync(file, inTree(['format-patch', '--stdout', 'origin/' + BRANCH + '..HEAD']));
    inTree(['checkout', '-q', '--detach', 'origin/' + BRANCH]);
    throw new TrackerSyncError(
      `${reason}：别处刚改过主表，本次写入已撤回（原改动存于 ${file}）。请重新读取主表，再 preview → apply。`
    );
  }
  function pushPending() {
    if (!ahead()) return 'none';
    try {
      remote(['push', '-q', 'origin', 'HEAD:' + BRANCH]);
      return 'pushed';
    } catch (e) {
      const reason = () =>
        'pending: ' +
        String(e.stderr || e.message)
          .trim()
          .split('\n')
          .pop();
      try {
        remote(['fetch', '-q', 'origin', BRANCH]);
      } catch {
        // 连拉取都失败：网络问题，保留本地提交，下次再推
        return reason();
      }
      if (!ahead()) return 'none';
      try {
        inTree(['merge-base', '--is-ancestor', 'origin/' + BRANCH, 'HEAD']);
        // 远程没前进，说明是网络问题：保留本地提交，下次再推
        return reason();
      } catch {}
      if (remoteTrackerChanged()) shelve('推送被拒');
      inTree(['rebase', '-q', 'origin/' + BRANCH]);
      remote(['push', '-q', 'origin', 'HEAD:' + BRANCH]);
      return 'pushed';
    }
  }
  // 读写前与远程对齐。strict=false 时（只读、提醒）网络失败只给警告，继续用本地数据。
  function refresh({ strict = true } = {}) {
    const warnings = [];
    const body = () => {
      ensure();
      if (dirty()) {
        if (fs.existsSync(path.join(worktree, SUBDIR, '.store', 'journal.json')))
          throw new TrackerSyncError('主表有未完成的写入事务，先让下一次写入完成恢复');
        inTree(['add', '-A', '--', SUBDIR]);
        inTree(['commit', '-q', '-m', '主表：补提交上次未提交的写入']);
      }
      try {
        remote(['fetch', '-q', 'origin', BRANCH]);
      } catch (e) {
        throw new TrackerSyncError('拉取主表失败：' + String(e.stderr || e.message).trim());
      }
      const pushed = pushPending();
      if (pushed.startsWith('pending'))
        throw new TrackerSyncError('补推本地主表提交失败：' + pushed);
      if (!ahead() && head() !== inTree(['rev-parse', 'origin/' + BRANCH]).trim())
        inTree(['checkout', '-q', '--detach', 'origin/' + BRANCH]);
    };
    try {
      const r = withLock(body, { wait: strict });
      if (r && r.busy) {
        if (strict) throw new TrackerSyncError('另一个进程正在同步主表，稍后重试');
        warnings.push('另一个进程正在同步主表，本次读取未拉取最新版本');
      }
    } catch (e) {
      if (strict || !(e instanceof TrackerSyncError || e.status !== undefined)) throw e;
      warnings.push(e.message + '；本次使用本地已有的主表');
    }
    return { warnings };
  }
  // 写入后提交并推送。推送因网络失败时保留本地提交，返回 pending，下次任何主表命令会补推。
  function publish(message) {
    const r = withLock(
      () => {
        if (!dirty()) return { commit: null, push: 'nothing to commit' };
        inTree(['add', '-A', '--', SUBDIR]);
        inTree(['commit', '-q', '-m', message]);
        const commit = head().slice(0, 7);
        return { commit, push: pushPending() };
      },
      { wait: true }
    );
    if (r.busy)
      throw new TrackerSyncError('另一个进程正在同步主表，写入已落盘但未提交，下次命令会补提交');
    return r;
  }
  return { refresh, publish, withLock, ensure };
}

module.exports = { locate, createTrackerGit, TrackerSyncError, SUBDIR };
