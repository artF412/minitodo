import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../db.js';
import { buildServer } from '../server.js';

let server, base, db;

before(async () => {
  db = openDb(':memory:');
  server = buildServer(db);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json() };
};

test('create requires a title and validates fields', async () => {
  assert.equal((await call('POST', '/api/tasks', { title: '  ' })).status, 400);
  assert.equal((await call('POST', '/api/tasks', { title: 'x', priority: 'urgent' })).status, 400);
  assert.equal((await call('POST', '/api/tasks', { title: 'x', due_date: '2026-13-40' })).status, 400);
});

test('rejects non-JSON content type', async () => {
  const res = await fetch(base + '/api/tasks', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"title":"x"}' });
  assert.equal(res.status, 415);
});

test('status change is logged to the timeline and sets done_at', async () => {
  const { data: t } = await call('POST', '/api/tasks', { title: 'Write report', due_date: '2026-12-01' });
  assert.equal(t.status, 'todo');
  const { data: moved } = await call('PATCH', `/api/tasks/${t.id}`, { status: 'doing' });
  assert.equal(moved.updates[0].body, 'To do → Doing');
  const { data: done } = await call('PATCH', `/api/tasks/${t.id}`, { status: 'done' });
  assert.ok(done.done_at);
  const { data: reopened } = await call('PATCH', `/api/tasks/${t.id}`, { status: 'todo' });
  assert.equal(reopened.done_at, null);
});

test('notes can be added and edited within 24h, not after', async () => {
  const { data: t } = await call('POST', '/api/tasks', { title: 'Notes' });
  const { data: n } = await call('POST', `/api/tasks/${t.id}/updates`, { body: 'first' });
  assert.equal((await call('PATCH', `/api/updates/${n.id}`, { body: 'fixed' })).status, 200);
  db.prepare('UPDATE updates SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 25 * 3600e3).toISOString(), n.id);
  assert.equal((await call('PATCH', `/api/updates/${n.id}`, { body: 'too late' })).status, 403);
  const system = (await call('GET', `/api/tasks/${t.id}`)).data.updates.find((u) => u.kind === 'status');
  assert.equal((await call('PATCH', `/api/updates/${system.id}`, { body: 'hack' })).status, 403);
});

test('done tasks older than 30 days move to archive; search works; reopen works', async () => {
  const { data: t } = await call('POST', '/api/tasks', { title: 'Old finished thing', status: 'done' });
  db.prepare('UPDATE tasks SET done_at = ? WHERE id = ?').run(new Date(Date.now() - 31 * 86400e3).toISOString(), t.id);
  const board = (await call('GET', '/api/tasks')).data;
  assert.ok(!board.some((x) => x.id === t.id));
  const arch = (await call('GET', '/api/tasks?view=archive&q=finished')).data;
  assert.ok(arch.some((x) => x.id === t.id));
  assert.equal((await call('GET', '/api/tasks?view=archive&q=zzz')).data.length, 0);
  await call('PATCH', `/api/tasks/${t.id}`, { status: 'todo' });
  assert.ok((await call('GET', '/api/tasks')).data.some((x) => x.id === t.id));
});

test('delete removes task and its timeline; export works', async () => {
  const { data: t } = await call('POST', '/api/tasks', { title: 'Delete me' });
  assert.equal((await call('DELETE', `/api/tasks/${t.id}`)).status, 200);
  assert.equal((await call('GET', `/api/tasks/${t.id}`)).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM updates WHERE task_id = ?').get(t.id).c, 0);
  const ex = (await call('GET', '/api/export')).data;
  assert.ok(Array.isArray(ex.tasks) && Array.isArray(ex.updates));
});

test('path traversal on static files is blocked', async () => {
  const res = await fetch(base + '/..%2Fserver.js');
  assert.equal(res.status, 404);
});

test('note edit history keeps previous versions', async () => {
  const { data: t } = await call('POST', '/api/tasks', { title: 'H' });
  const { data: n } = await call('POST', `/api/tasks/${t.id}/updates`, { body: 'v1' });
  await call('PATCH', `/api/updates/${n.id}`, { body: 'v2' });
  await call('PATCH', `/api/updates/${n.id}`, { body: 'v3' });
  const { data: h } = await call('GET', `/api/updates/${n.id}/history`);
  assert.deepEqual(h.map((v) => v.body), ['v3', 'v2', 'v1']);
  assert.equal(h[0].current, true);
});
