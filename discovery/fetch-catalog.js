#!/usr/bin/env node
'use strict';
// 用法：
//   node discovery/fetch-catalog.js zhiye <host> <outDir> [--category 2] [--page-size 20]
//   node discovery/fetch-catalog.js feishu <portalUrl> <outDir> [--page-size 20]
// 只读公开目录；输出 raw/、jd/ 和 catalog-summary.json，摘要打印到 stdout。
// Moka 的列表接口返回加密数据，暂不支持，按 data-acquisition.md 走 Layer 2/3。
const fs = require('node:fs');
const path = require('node:path');
const { fetchZhiye, fetchFeishu, writeCatalog } = require('./fetchers');

const project = path.resolve(__dirname, '..');

function loadPlaywright() {
  const candidates = [
    'playwright',
    'playwright-core',
    path.join(
      project,
      'data',
      'private',
      'playwright-application',
      'runtime',
      'node_modules',
      'playwright-core'
    ),
  ];
  for (const c of candidates) {
    try {
      return require(c);
    } catch {}
  }
  throw Error('feishu 需要 playwright-core：npm i playwright-core 或先运行本地 Playwright 安装');
}

function launchOptions() {
  if (process.env.JOBHUNT_CHROMIUM) return { executablePath: process.env.JOBHUNT_CHROMIUM };
  const bundled = '/opt/pw-browsers';
  if (fs.existsSync(bundled)) {
    const dir = fs.readdirSync(bundled).find((d) => /^chromium-\d+$/.test(d));
    const exe = dir && path.join(bundled, dir, 'chrome-linux', 'chrome');
    if (exe && fs.existsSync(exe)) return { executablePath: exe };
  }
  return { channel: 'chrome' };
}

function parseArgs(argv) {
  const pos = [],
    opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[++i];
    else pos.push(argv[i]);
  }
  return { pos, opt };
}

async function main(argv) {
  const { pos, opt } = parseArgs(argv);
  const [ats, target, outDir] = pos;
  if (!ats || !target || !outDir || !['zhiye', 'feishu'].includes(ats)) {
    console.error(
      'usage: fetch-catalog.js zhiye <host> <outDir> [--category 2] | feishu <portalUrl> <outDir>'
    );
    return 2;
  }
  const pageSize = opt['page-size'] ? Number(opt['page-size']) : 20;
  let result;
  if (ats === 'zhiye') {
    const host = target.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    result = await fetchZhiye({ host, category: opt.category || '2', pageSize });
  } else {
    const { chromium } = loadPlaywright();
    const browser = await chromium.launch({ headless: true, ...launchOptions() });
    try {
      const page = await browser.newPage();
      result = await fetchFeishu({ page, portalUrl: target, pageSize });
    } finally {
      await browser.close();
    }
  }
  const summary = writeCatalog(result, outDir);
  const { positions, ...head } = summary;
  console.log(JSON.stringify({ ...head, out_dir: path.resolve(outDir) }, null, 1));
  return 0;
}

if (require.main === module)
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (e) => {
      console.error(e.message);
      process.exitCode = 1;
    }
  );

module.exports = { main, parseArgs, launchOptions };
