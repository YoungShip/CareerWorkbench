'use strict';
// 常见招聘系统的校招目录抓取：只读公开接口，不登录、不提交。
// 输出保持接口原文（raw/api-catalog.json），另为每个岗位写一份 JD 文本快照（jd/<id>.txt），
// 供 campus-recruitment 的 matching v2 直接引用：raw_catalog.records_path=/items，id_path 见 ID_PATH。
const fs = require('node:fs');
const path = require('node:path');

const ID_PATH = { zhiye: '/JobAdId', feishu: '/id' };

// ---------- 北森 zhiye：公开接口直接分页 ----------
async function fetchZhiye({
  host,
  category = '2',
  pageSize = 20,
  fetchImpl = fetch,
  maxPages = 200,
}) {
  const url = `https://${host}/api/Jobad/GetJobAdPageList`;
  const pages = [],
    items = [];
  let count = null;
  for (let i = 0; i < maxPages; i++) {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        PageIndex: i,
        PageSize: pageSize,
        Category: [String(category)],
        KeyWords: '',
        SpecialType: 0,
        PortalId: '',
        DisplayFields: ['Category', 'LocId', 'PostDate', 'Degree', 'ClassificationOne'],
      }),
    });
    const page = await res.json();
    if (page.Code !== 200) throw Error(`zhiye page ${i}: ${page.Message || page.Code}`);
    pages.push(page);
    count = page.Count;
    items.push(...(page.Data || []));
    if (!(page.Data || []).length || items.length >= count) break;
  }
  return {
    ats: 'zhiye',
    source: `POST ${url} (Category=${category}, PageSize=${pageSize})`,
    count,
    pages,
    items,
  };
}

function normalizeZhiye(x) {
  return {
    id: String(x.JobAdId),
    title: x.JobAdName,
    cities: x.LocNames || [],
    category: x.ClassificationOne || '',
    degree: x.Degree || '',
    posted: x.PostDate || '',
    description: x.Duty || '',
    requirement: x.Require || '',
  };
}

// ---------- 飞书招聘：页面带会话签名，在浏览器页面里调同一接口翻页 ----------
// page 为 Playwright Page；portalUrl 形如 https://xxx.jobs.feishu.cn/campus/ 或 .../<tenant>/
async function fetchFeishu({ page, portalUrl, pageSize = 20, maxPages = 200 }) {
  // 页面首个请求可能在 CSRF 令牌就绪前发出（头里是字符串 "undefined"），取最后一次
  let searchReq = null;
  page.on('request', (r) => {
    if (/api\/v1\/search\/job\/posts/.test(r.url()) && r.method() === 'POST')
      searchReq = { url: r.url(), headers: r.headers(), post: r.postData() };
  });
  await page.goto(portalUrl.replace(/\/?$/, '/') + 'position', {
    waitUntil: 'networkidle',
    timeout: 60000,
  });
  await page.waitForTimeout(2000);
  if (!searchReq) throw Error('feishu: search request not observed on ' + portalUrl);
  const body0 = JSON.parse(searchReq.post);
  const pages = [],
    items = [];
  let count = null;
  for (let i = 0, offset = 0; i < maxPages; i++, offset += pageSize) {
    const u = searchReq.url
      .replace(/limit=\d+/, 'limit=' + pageSize)
      .replace(/offset=\d+/, 'offset=' + offset);
    const text = await page.evaluate(
      async ({ u, h, body }) => {
        const keep = [
          'content-type',
          'x-csrf-token',
          'portal-channel',
          'portal-platform',
          'website-path',
          'accept-language',
          'env',
        ];
        const headers = {};
        for (const k of keep) if (h[k] && h[k] !== 'undefined') headers[k] = h[k];
        const r = await fetch(u, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          credentials: 'include',
        });
        return `${r.status}\n${await r.text()}`;
      },
      { u, h: searchReq.headers, body: { ...body0, limit: pageSize, offset } }
    );
    const [status, ...rest] = text.split('\n');
    let j = null;
    try {
      j = JSON.parse(rest.join('\n'));
    } catch {}
    if (!j || j.code !== 0)
      throw Error(`feishu offset ${offset}: HTTP ${status} ${rest.join('\n').slice(0, 200)}`);
    pages.push(j);
    count = j.data.count;
    items.push(...j.data.job_post_list);
    if (!j.data.job_post_list.length || items.length >= count) break;
  }
  return { ats: 'feishu', source: `${portalUrl} (api/v1/search/job/posts)`, count, pages, items };
}

function normalizeFeishu(x) {
  return {
    id: String(x.id),
    title: x.title,
    cities: (x.city_list || []).map((c) => c.name),
    category: x.job_category?.name || x.job_function?.name || '',
    degree: '',
    posted: x.publish_time ? new Date(x.publish_time).toISOString() : '',
    description: x.description || '',
    requirement: x.requirement || '',
    subject: x.job_subject?.name?.zh_cn || '',
  };
}

const NORMALIZE = { zhiye: normalizeZhiye, feishu: normalizeFeishu };

function jdText(n, source) {
  const lines = (s) =>
    String(s || '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  return (
    [
      `岗位：${n.title}`,
      `岗位ID：${n.id}`,
      `工作地点：${n.cities.join('、')}`,
      `职位类别：${n.category}`,
      ...(n.subject ? [`招聘项目：${n.subject}`] : []),
      ...(n.degree ? [`学历：${n.degree}`] : []),
      `发布时间：${n.posted}`,
      `来源：${source}（公开接口原文）`,
      '职位描述：',
      ...lines(n.description),
      '职位要求：',
      ...lines(n.requirement),
    ].join('\n') + '\n'
  );
}

// 写出 raw/、jd/ 和便于划定研究范围的 catalog-summary.json；ID 重复或数量与官方总数不符时报错
function writeCatalog(result, outDir, now = new Date()) {
  const normalize = NORMALIZE[result.ats];
  const normalized = result.items.map(normalize);
  const ids = normalized.map((n) => n.id);
  const unique = new Set(ids).size;
  if (unique !== ids.length) throw Error(`duplicate ids: ${ids.length - unique}`);
  if (result.count !== ids.length)
    throw Error(`collected ${ids.length} positions but the official count is ${result.count}`);
  const raw = path.join(outDir, 'raw'),
    jd = path.join(outDir, 'jd');
  fs.mkdirSync(raw, { recursive: true });
  fs.mkdirSync(jd, { recursive: true });
  const fetched_at = new Date(now).toISOString();
  result.pages.forEach((p, i) =>
    fs.writeFileSync(
      path.join(raw, `page-${String(i).padStart(3, '0')}.json`),
      JSON.stringify(p, null, 1)
    )
  );
  fs.writeFileSync(
    path.join(raw, 'api-catalog.json'),
    JSON.stringify(
      {
        ats: result.ats,
        source: result.source,
        fetched_at,
        count: result.count,
        items: result.items,
      },
      null,
      1
    )
  );
  for (const n of normalized)
    fs.writeFileSync(path.join(jd, n.id + '.txt'), jdText(n, result.source));
  const summary = {
    ats: result.ats,
    source: result.source,
    fetched_at,
    count: result.count,
    raw_catalog: {
      file: 'raw/api-catalog.json',
      format: 'json',
      records_path: '/items',
      id_path: ID_PATH[result.ats],
      total_positions: ids.length,
    },
    positions: normalized.map(({ description, requirement, ...rest }) => rest),
  };
  fs.writeFileSync(path.join(outDir, 'catalog-summary.json'), JSON.stringify(summary, null, 1));
  return summary;
}

module.exports = {
  fetchZhiye,
  fetchFeishu,
  normalizeZhiye,
  normalizeFeishu,
  jdText,
  writeCatalog,
  ID_PATH,
};
