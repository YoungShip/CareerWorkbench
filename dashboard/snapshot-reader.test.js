const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSnapshotReader } = require('./snapshot-reader');

test('a slow refresh leaves the previous validated snapshot available and shares the read', async () => {
  let release,
    calls = 0;
  const reader = createSnapshotReader(() => {
    calls++;
    return calls === 1
      ? { revision: 'old', read_status: { state: 'synced' } }
      : new Promise((resolve) => {
          release = resolve;
        });
  });
  assert.equal(reader.preview(), null);
  await reader.refresh();
  const pending = reader.refresh();
  assert.equal(reader.refresh(), pending);
  await Promise.resolve();
  assert.equal(reader.preview().revision, 'old');
  assert.equal(reader.preview().read_status.preview, true);
  release({ revision: 'new', read_status: { state: 'synced' } });
  await pending;
  assert.equal(reader.preview().revision, 'new');
  assert.equal(calls, 2);
});

test('a write invalidation prevents a late older read from repopulating the preview', async () => {
  let release;
  const reader = createSnapshotReader(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const pending = reader.refresh();
  await Promise.resolve();
  reader.invalidate();
  release({ revision: 'before-write' });
  await pending;
  assert.equal(reader.preview(), null);
});

test('a failed refresh retains the last snapshot and can be retried', async () => {
  let calls = 0;
  const reader = createSnapshotReader(() => {
    if (++calls === 2) throw Error('offline');
    return { revision: String(calls) };
  });
  await reader.refresh();
  await assert.rejects(reader.refresh(), /offline/);
  assert.equal(reader.preview().revision, '1');
  await reader.refresh();
  assert.equal(reader.preview().revision, '3');
});
