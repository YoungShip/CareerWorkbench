const { test } = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { fetchZhiye, normalizeFeishu, writeCatalog, jdText } = require('./fetchers');
const { parseArgs } = require('./fetch-catalog');

// 合成数据，不含真实岗位
function zhiyeItem(n) {
  return {
    JobAdId: 900000 + n,
    JobAdName: `示例岗位${n}(J${n})`,
    LocNames: ['某省·某市'],
    ClassificationOne: '研发类',
    Degree: '硕士研究生',
    PostDate: '2026-09-01T10:00:00',
    Duty: '1. 职责一\r\n2. 职责二',
    Require: '熟悉 Python',
  };
}
function zhiyeServer(total, { pageCount = total } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const start = body.PageIndex * body.PageSize;
    const n = Math.max(0, Math.min(body.PageSize, pageCount - start));
    const Data = Array.from({ length: n }, (_, i) => zhiyeItem(start + i));
    return { json: async () => ({ Code: 200, Count: total, Data }) };
  };
  return { calls, fetchImpl };
}
function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobhunt-fetchers-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('zhiye pages until the official count and writes raw, jd and summary', async (t) => {
  const { calls, fetchImpl } = zhiyeServer(45);
  const result = await fetchZhiye({ host: 'example.zhiye.com', fetchImpl });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://example.zhiye.com/api/Jobad/GetJobAdPageList');
  assert.deepEqual(
    calls.map((c) => c.body.PageIndex),
    [0, 1, 2]
  );
  assert.deepEqual(calls[0].body.Category, ['2']);
  assert.equal(result.items.length, 45);

  const out = tmp(t);
  const summary = writeCatalog(result, out, new Date('2026-10-08T00:00:00Z'));
  assert.deepEqual(summary.raw_catalog, {
    file: 'raw/api-catalog.json',
    format: 'json',
    records_path: '/items',
    id_path: '/JobAdId',
    total_positions: 45,
  });
  assert.equal(summary.positions.length, 45);
  assert.equal(summary.positions[0].description, undefined);
  const raw = JSON.parse(fs.readFileSync(path.join(out, 'raw', 'api-catalog.json'), 'utf8'));
  assert.equal(raw.count, 45);
  assert.equal(raw.items[0].JobAdId, 900000);
  assert.equal(raw.fetched_at, '2026-10-08T00:00:00.000Z');
  assert.deepEqual(fs.readdirSync(path.join(out, 'raw')).sort(), [
    'api-catalog.json',
    'page-000.json',
    'page-001.json',
    'page-002.json',
  ]);
  assert.equal(fs.readdirSync(path.join(out, 'jd')).length, 45);
  const jd = fs.readFileSync(path.join(out, 'jd', '900001.txt'), 'utf8');
  assert.match(jd, /^岗位：示例岗位1\(J1\)\n岗位ID：900001\n/);
  assert.match(jd, /职位描述：\n1\. 职责一\n2\. 职责二\n职位要求：\n熟悉 Python\n$/);
});

test('zhiye stops on an empty page and refuses a short catalog', async (t) => {
  const { calls, fetchImpl } = zhiyeServer(30, { pageCount: 25 });
  const result = await fetchZhiye({ host: 'example.zhiye.com', fetchImpl });
  assert.equal(calls.length, 3);
  assert.equal(result.items.length, 25);
  const out = tmp(t);
  assert.throws(
    () => writeCatalog(result, out),
    /collected 25 positions but the official count is 30/
  );
  assert.equal(fs.existsSync(path.join(out, 'raw')), false);
});

test('zhiye surfaces API errors', async () => {
  const fetchImpl = async () => ({ json: async () => ({ Code: 500, Message: 'busy' }) });
  await assert.rejects(fetchZhiye({ host: 'h', fetchImpl }), /zhiye page 0: busy/);
});

test('writeCatalog rejects duplicate ids', (t) => {
  const items = [zhiyeItem(1), zhiyeItem(1)];
  assert.throws(
    () => writeCatalog({ ats: 'zhiye', source: 's', count: 2, pages: [], items }, tmp(t)),
    /duplicate ids: 1/
  );
});

test('feishu items normalize with category fallback and subject', (t) => {
  const item = {
    id: '7000000000000000001',
    title: '示例算法工程师',
    description: '负责模型训练',
    requirement: '熟悉 PyTorch',
    job_category: null,
    job_function: { name: '软件类' },
    job_subject: { name: { zh_cn: '2027届校园招聘' } },
    city_list: [{ name: '某市' }, { name: '另一市' }],
    publish_time: Date.UTC(2026, 7, 18),
  };
  const n = normalizeFeishu(item);
  assert.deepEqual(n, {
    id: '7000000000000000001',
    title: '示例算法工程师',
    cities: ['某市', '另一市'],
    category: '软件类',
    degree: '',
    posted: '2026-08-18T00:00:00.000Z',
    description: '负责模型训练',
    requirement: '熟悉 PyTorch',
    subject: '2027届校园招聘',
  });
  assert.match(
    jdText(n, 'src'),
    /工作地点：某市、另一市\n职位类别：软件类\n招聘项目：2027届校园招聘\n/
  );
  const summary = writeCatalog(
    { ats: 'feishu', source: 'src', count: 1, pages: [{}], items: [item] },
    tmp(t)
  );
  assert.equal(summary.raw_catalog.id_path, '/id');
});

test('fetch-catalog argument parsing', () => {
  assert.deepEqual(parseArgs(['zhiye', 'h', 'out', '--category', '1', '--page-size', '50']), {
    pos: ['zhiye', 'h', 'out'],
    opt: { category: '1', 'page-size': '50' },
  });
});
