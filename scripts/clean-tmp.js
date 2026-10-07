#!/usr/bin/env node
/**
 * 清理 CareerWorkbench/tmp 里过期的临时文件。
 *
 *   node scripts/clean-tmp.js            只列出会删除的文件（默认，不改动任何东西）
 *   node scripts/clean-tmp.js --apply    实际删除
 *   node scripts/clean-tmp.js --days=N   改变过期天数（默认 14）
 *
 * tmp 里主要是 AI 会话留下的一次性脚本、截图和主表快照。最后修改时间早于
 * N 天的文件会被删除；提醒脚本的状态文件不论新旧都保留；不跟随链接或 Junction。
 * 只有原本有内容、且内容全部被删掉的目录才会被移除。每晚的 remind.js --all 会自动调用。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const TMP = path.resolve(__dirname, '../tmp');
// 提醒脚本的门槛去重、微信额度和发送锁，删掉会导致重复推送或额度失控
const KEEP = new Set(['remind-state.json', 'wechat-quota.json', 'reminder-delivery.lock']);
const DAY = 86400000;

function cleanTmp({ dir = TMP, maxAgeDays = 14, now = Date.now(), apply = false } = {}) {
  const cutoff = now - maxAgeDays * DAY;
  const stale = [];
  let bytes = 0;
  // 返回目录是否已被清空（原本有内容且全部删除）
  function walk(d, top) {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    let kept = 0;
    for (const e of entries) {
      const p = path.join(d, e.name);
      if ((top && KEEP.has(e.name)) || e.isSymbolicLink()) {
        kept++;
        continue;
      }
      if (e.isDirectory()) {
        if (walk(p, false) && apply) fs.rmdirSync(p);
        else kept++;
        continue;
      }
      const st = fs.statSync(p);
      if (st.mtimeMs < cutoff) {
        stale.push(p);
        bytes += st.size;
        if (apply) fs.rmSync(p, { force: true });
      } else kept++;
    }
    return entries.length > 0 && kept === 0;
  }
  if (fs.existsSync(dir)) walk(dir, true);
  return { stale, bytes, removed: apply ? stale.length : 0 };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const daysArg = args.find((a) => a.startsWith('--days='));
  const maxAgeDays = daysArg ? Number(daysArg.slice(7)) : 14;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 1)
    throw new Error('--days 必须是不小于 1 的数字');
  const r = cleanTmp({ apply, maxAgeDays });
  const mb = (r.bytes / 1048576).toFixed(1);
  console.log(
    apply
      ? `已删除 ${r.removed} 个超过 ${maxAgeDays} 天的临时文件，共 ${mb}MB`
      : `将删除 ${r.stale.length} 个超过 ${maxAgeDays} 天的临时文件，共 ${mb}MB（加 --apply 才实际删除）`
  );
}

module.exports = { cleanTmp, KEEP };
