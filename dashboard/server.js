// Local dashboard; the CLI and web UI share one transactional CSV store.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createStore } = require('./store');
const TodoRules = require('./todo');
const store = createStore(process.env.JOBHUNT_DATA_DIR || __dirname);
const PORT = Number(process.env.JOBHUNT_PORT || 8420);
function send(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}
async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 2e6) throw new Error('Request too large');
  }
  return JSON.parse(text);
}
const server = http.createServer(async (req, res) => {
  try {
    if (!['127.0.0.1:' + PORT, 'localhost:' + PORT].includes(req.headers.host))
      return send(res, 403, { error: 'Invalid host' });
    const url = new URL(req.url, 'http://' + req.headers.host);
    if (req.method === 'GET' && url.pathname === '/api/health')
      return send(res, 200, { application: 'career-workbench', pid: process.pid, root: __dirname });
    if (req.method === 'GET' && url.pathname === '/api/snapshot')
      return send(res, 200, store.snapshot());
    const assets = {
      '/todo.js': 'application/javascript',
      '/todo-ui.js': 'application/javascript',
      '/workbench.js': 'application/javascript',
      '/workbench-model.js': 'application/javascript',
      '/workbench.css': 'text/css',
    };
    if (req.method === 'GET' && Object.hasOwn(assets, url.pathname)) {
      res.writeHead(200, {
        'Content-Type': assets[url.pathname] + '; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(fs.readFileSync(path.join(__dirname, url.pathname.slice(1))));
    }
    if (req.method === 'GET' && ['/', '/dashboard.html'].includes(url.pathname)) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      return res.end(fs.readFileSync(path.join(__dirname, 'dashboard.html')));
    }
    if (req.method !== 'POST') return send(res, 404, { error: 'Not found' });
    if (!String(req.headers['content-type']).startsWith('application/json'))
      return send(res, 415, { error: 'JSON required' });
    if (
      req.headers.origin &&
      !['http://localhost:' + PORT, 'http://127.0.0.1:' + PORT].includes(req.headers.origin)
    )
      return send(res, 403, { error: 'Cross-origin write denied' });
    const p = await body(req);
    let operations;
    if (url.pathname === '/api/calendar/complete') {
      const snapshot = store.snapshot();
      if (snapshot.revision !== p.expected_revision)
        return send(res, 409, { error: '数据已更新，请刷新后重新登记' });
      operations = TodoRules.completion(snapshot, p);
    } else if (url.pathname === '/api/job/notes') {
      if (typeof p.notes !== 'string' || typeof p.next_action !== 'string')
        return send(res, 400, { error: '备注和下一步必须为文本' });
      operations = [
        {
          type: 'job.patch',
          job_id: p.job_id,
          patch: { notes: p.notes, next_action: p.next_action },
        },
      ];
    } else if (url.pathname === '/api/update-status') {
      if (!['Offer', 'Rejected', 'Ended', 'Skipped', 'Deferred', 'Pending'].includes(p.status))
        return send(res, 400, { error: 'Unsupported status' });
      operations = [{ type: 'job.patch', job_id: p.job_id, patch: { status: p.status } }];
    } else if (url.pathname === '/api/calendar/add' || url.pathname === '/api/calendar/update') {
      operations = [
        {
          type: url.pathname.endsWith('/add') ? 'event.add' : 'event.patch',
          job_id: p.job_id,
          event_id: p.event_id,
          record: {
            date: p.date,
            time: p.time,
            event_type: p.event_type,
            stage: p.stage || '',
            stage_status: p.stage_status || '',
            status: p.status || 'Scheduled',
            ...(p.notes !== undefined ? { notes: p.notes } : {}),
            ...(p.deadline !== undefined ? { deadline: p.deadline } : {}),
          },
        },
      ];
    } else if (url.pathname === '/api/calendar/delete')
      operations = [{ type: 'event.delete', job_id: p.job_id, event_id: p.event_id }];
    else return send(res, 404, { error: 'Not found' });
    return send(res, 200, {
      ok: true,
      ...store.commit({ expected_revision: p.expected_revision, operations }),
    });
  } catch (e) {
    send(res, e.httpStatus || 400, { ok: false, error: e.message });
  }
});
server.listen(PORT, '127.0.0.1', () =>
  console.log('CareerWorkbench: http://localhost:' + PORT + '/dashboard.html')
);
