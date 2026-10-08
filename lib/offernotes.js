'use strict';
// OfferNotes 线上同步自 2026-10-09 起停用：进度只在本地主表和 AI/电脑端查看。
// 设 JOBHUNT_OFFERNOTES_SYNC=1 可恢复（变更重新入 sync_queue、摘要提示同步、删除前要求先删线上记录）。
function offernotesSyncEnabled(env = process.env) {
  return env.JOBHUNT_OFFERNOTES_SYNC === '1';
}
module.exports = { offernotesSyncEnabled };
