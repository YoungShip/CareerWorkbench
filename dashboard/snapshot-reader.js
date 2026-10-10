'use strict';
const { execFile } = require('node:child_process');
const path = require('node:path');

// Only cache results produced by a normal read-after-sync. No extra CSV data source.
function createSnapshotReader(read = readSnapshot) {
  let cached = null,
    pending = null,
    generation = 0;
  return {
    preview() {
      return cached ? { ...cached, read_status: { ...cached.read_status, preview: true } } : null;
    },
    refresh() {
      if (pending) return pending;
      const version = generation;
      const request = Promise.resolve()
        .then(read)
        .then((snapshot) => {
          if (version === generation) cached = snapshot;
          return snapshot;
        })
        .finally(() => {
          if (pending === request) pending = null;
        });
      pending = request;
      return request;
    },
    invalidate() {
      generation++;
      cached = null;
      pending = null;
    },
  };
}

// Git is synchronous inside the existing CLI; a child keeps HTTP/asset serving responsive.
function readSnapshot() {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(__dirname, 'tracker-cli.js'), 'snapshot'],
      {
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) return reject(error);
        try {
          const snapshot = JSON.parse(stdout);
          resolve({
            ...snapshot,
            read_status: {
              preview: false,
              state: stderr.includes('警告：') ? 'local-fallback' : 'synced',
              checked_at: new Date().toISOString(),
            },
          });
        } catch (error) {
          reject(error);
        }
      }
    );
  });
}
module.exports = { createSnapshotReader };
