#!/usr/bin/env node
'use strict';
// CareerWorkbench local service lifecycle. A matching health identity is required before stop.
const fs = require('node:fs'),
  path = require('node:path'),
  http = require('node:http');
const { spawn } = require('node:child_process');
const root = __dirname,
  port = Number(process.env.JOBHUNT_PORT || 8420),
  run = path.join(root, '.store', 'run');
const page = 'http://localhost:' + port + '/dashboard.html',
  log = path.join(run, 'server.log');
function health() {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:' + port + '/api/health', (res) => {
      let text = '';
      res.on('data', (c) => {
        text += c;
        if (text.length > 4096) req.destroy();
      });
      res.on('end', () => {
        try {
          const p = JSON.parse(text);
          resolve({
            occupied: true,
            owned:
              p.application === 'career-workbench' &&
              path.resolve(p.root || '.') === root &&
              Number.isInteger(p.pid),
            pid: p.pid,
          });
        } catch {
          resolve({ occupied: true, owned: false });
        }
      });
    });
    req.setTimeout(1000, () => req.destroy());
    req.on('error', () => resolve({ occupied: false, owned: false }));
  });
}
async function waitReady() {
  for (let n = 0; n < 30; n++) {
    const h = await health();
    if (h.owned) return h;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw Error('服务启动后未通过身份检查，请查看 ' + log);
}
function openPage() {
  const exe =
    process.platform === 'win32' ? 'rundll32' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', page] : [page];
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}
async function main() {
  const args = process.argv.slice(2),
    command = args.find((x) => !x.startsWith('--')) || 'status',
    h = await health();
  if (command === 'status') {
    console.log(
      JSON.stringify({
        application: 'career-workbench',
        page,
        listening: h.occupied,
        owned: h.owned,
        pid: h.owned ? h.pid : null,
        log_file: log,
      })
    );
    process.exitCode = h.owned ? 0 : 1;
    return;
  }
  if (command === 'stop') {
    if (!h.occupied) {
      console.log('工作台服务未运行。');
      return;
    }
    if (!h.owned) throw Error('该端口上的服务身份不符，未停止任何进程。');
    process.kill(h.pid, 'SIGTERM');
    for (let n = 0; n < 20; n++) {
      if (!(await health()).owned) {
        console.log('工作台服务已停止。');
        return;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    throw Error('停止请求已发出，但服务仍在响应。');
  }
  if (!['start', 'hold'].includes(command))
    throw Error('用法：node serve.js status|start|hold|stop [--open]');
  if (h.occupied) {
    if (!h.owned) throw Error('端口被其他服务占用，未启动工作台。');
    if (args.includes('--open')) openPage();
    console.log('工作台已运行：' + page);
    return;
  }
  fs.mkdirSync(run, { recursive: true });
  if (command === 'hold') {
    require('./server');
    await waitReady();
    if (args.includes('--open')) openPage();
    console.log('工作台正在后台运行：' + page);
    return;
  }
  const fd = fs.openSync(log, 'a'),
    child = spawn(process.execPath, [path.join(root, 'server.js')], {
      cwd: root,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
  fs.closeSync(fd);
  child.on('error', (e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
  child.unref();
  await waitReady();
  if (args.includes('--open')) openPage();
  console.log('工作台已启动：' + page);
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
