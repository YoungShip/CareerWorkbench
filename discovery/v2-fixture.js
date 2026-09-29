'use strict';
// 共享的合法 schema-v2 虚构 fixture 构造器。
// 与 skills/campus-recruitment/scripts/test_verify_matching.py 的 valid_record 同构，
// 供 discovery 的 Node 用例复用，避免各处再手写旧式 matching。
// 非 .test.js，不会被测试运行器当作测试收集。
const fs = require('node:fs');
const path = require('node:path');

function summaryFor(requirements) {
  const categories = { hard_qualification: 0, core_capability: 0, plus: 0, ambiguous: 0 };
  const supports = { direct_support: 0, transferable: 0, no_evidence: 0, conflict: 0 };
  const conclusions = { satisfied: 0, not_satisfied: 0, pending: 0 };
  for (const r of requirements) { categories[r.category]++; supports[r.support]++; conclusions[r.conclusion]++; }
  return {
    requirements_total: requirements.length, ...categories,
    core_total: categories.hard_qualification + categories.core_capability,
    ...supports, ...conclusions,
  };
}

// 写入证据快照与原始目录，返回合法 v2 记录对象（相对路径指向同目录文件）。
function writeV2Fixture(root, { company = 'Fixture Company', roleId = 'role-1', date = '2026-01-01' } = {}) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, `${roleId}-jd.txt`), '本科或以上学历。\n独立完成自动化测试。\n有相关行业经验。\n', 'utf8');
  fs.writeFileSync(path.join(root, `${roleId}-candidate.txt`), '已取得本科或以上学历。\n独立维护自动化测试。\n', 'utf8');
  fs.writeFileSync(path.join(root, 'catalog.json'), JSON.stringify([{ id: roleId, title: 'Fixture QA Engineer' }]), 'utf8');
  const requirements = [
    { requirement_id: `${roleId}-req-1`, text: '本科或以上学历', category: 'hard_qualification', category_basis_quote_ids: ['jd-q1'], jd_quote_ids: ['jd-q1'], candidate_evidence_ids: ['ev-1'], support: 'direct_support', conclusion: 'satisfied', judgment: '候选人证据直接覆盖该学历要求。' },
    { requirement_id: `${roleId}-req-2`, text: '独立完成自动化测试', category: 'core_capability', category_basis_quote_ids: ['jd-q2'], jd_quote_ids: ['jd-q2'], candidate_evidence_ids: ['ev-2'], support: 'direct_support', conclusion: 'satisfied', judgment: '候选人证据直接覆盖自动化测试能力。' },
    { requirement_id: `${roleId}-req-3`, text: '有相关行业经验', category: 'plus', category_basis_quote_ids: ['jd-q3'], jd_quote_ids: ['jd-q3'], candidate_evidence_ids: [], support: 'no_evidence', conclusion: 'pending', judgment: '档案中没有该加分项的直接证据，暂不据此排除。' },
  ];
  return {
    schema_version: 2, company, date, scope: 'Fictional fixture only', selected_position_id: roleId,
    coverage: { capture_status: 'complete', official_total: 1, last_page_reached: true, human_attested: true },
    raw_catalog: { file: 'catalog.json', format: 'json', records_path: '', id_path: '/id', total_positions: 1 },
    catalog_index: [{ id: roleId, title: 'Fixture QA Engineer', city: 'Fixture City', in_scope: true }],
    positions: [{
      id: roleId, title: 'Fixture QA Engineer', city: 'Fixture City',
      jd_source: {
        position_id: roleId, url: 'https://example.invalid/jobs/fixture-qa', read_at: '2026-01-01T00:00:00Z',
        snapshot_file: `${roleId}-jd.txt`,
        quotes: [
          { id: 'jd-q1', text: '本科或以上学历。', locator: { line_start: 1, line_end: 1 } },
          { id: 'jd-q2', text: '独立完成自动化测试。', locator: { line_start: 2, line_end: 2 } },
          { id: 'jd-q3', text: '有相关行业经验。', locator: { line_start: 3, line_end: 3 } },
        ],
      },
      candidate_source: {
        profile_version: 'fixture-profile-v1', snapshot_file: `${roleId}-candidate.txt`,
        evidence: [
          { id: 'ev-1', text: '已取得本科或以上学历。', locator: { line_start: 1, line_end: 1 } },
          { id: 'ev-2', text: '独立维护自动化测试。', locator: { line_start: 2, line_end: 2 } },
        ],
      },
      requirements, requirement_summary: summaryFor(requirements),
      decision: { state: 'recommended', basis: 'requirement_summary', reason: '硬资格和核心能力均有直接证据，加分项缺证据但不构成排除。' },
    }],
  };
}

// 旧式 schema-1 记录：用于确认它不会被升级为已验证。
function legacyRecord() {
  return {
    company: 'Fixture Company', date: '2026-01-01', scope: 'All',
    raw_catalog: { file: 'catalog.json', total_positions: 1 },
    catalog_index: [{ id: 'job1', title: 'Developer', city: '苏州', in_scope: true }],
    positions: [{ id: 'job1', title: 'Developer', city: '苏州', jd_evidence: ['Develop test software'], grade: 'A' }],
  };
}

module.exports = { writeV2Fixture, legacyRecord, summaryFor };
