import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const DONE_VISIBLE_DAYS = 30; // Done column shows tasks finished within this many days
export const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000; // note editable for 24h after posting

export const STATUSES = ['todo', 'doing', 'done'];
export const STATUS_LABEL = { todo: 'To do', doing: 'Doing', done: 'Done' };
export const PRIORITIES = ['high', 'medium', 'low'];

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','doing','done')),
      priority    TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('high','medium','low')),
      due_date    TEXT,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      done_at     TEXT
    );
    CREATE TABLE IF NOT EXISTS updates (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL CHECK (kind IN ('note','status')),
      body       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      edited_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_updates_task ON updates(task_id, id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, done_at);
  `);
  return db;
}

const nowIso = () => new Date().toISOString();

const LAST_UPDATE_COLS = `
  (SELECT body FROM updates u WHERE u.task_id = t.id ORDER BY u.id DESC LIMIT 1) AS last_update,
  (SELECT created_at FROM updates u WHERE u.task_id = t.id ORDER BY u.id DESC LIMIT 1) AS last_update_at
`;

const ORDER = `
  ORDER BY CASE t.priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
           t.due_date IS NULL, t.due_date, t.created_at
`;

export function makeStore(db) {
  const cutoff = () => new Date(Date.now() - DONE_VISIBLE_DAYS * 86400000).toISOString();

  return {
    board() {
      return db
        .prepare(
          `SELECT t.*, ${LAST_UPDATE_COLS} FROM tasks t
           WHERE t.status != 'done' OR t.done_at >= ? ${ORDER}`
        )
        .all(cutoff());
    },

    archive(q = '') {
      const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      return db
        .prepare(
          `SELECT t.*, ${LAST_UPDATE_COLS} FROM tasks t
           WHERE t.status = 'done' AND t.done_at < ?
             AND (t.title LIKE ? ESCAPE '\\' OR t.description LIKE ? ESCAPE '\\')
           ORDER BY t.done_at DESC`
        )
        .all(cutoff(), like, like);
    },

    get(id) {
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      if (!task) return null;
      task.updates = db
        .prepare('SELECT * FROM updates WHERE task_id = ? ORDER BY id DESC')
        .all(id);
      return task;
    },

    create({ title, description, priority, due_date, status }) {
      const ts = nowIso();
      const st = status || 'todo';
      const res = db
        .prepare(
          `INSERT INTO tasks (title, description, status, priority, due_date, created_at, updated_at, done_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(title, description || '', st, priority || 'medium', due_date || null, ts, ts, st === 'done' ? ts : null);
      const id = Number(res.lastInsertRowid);
      db.prepare('INSERT INTO updates (task_id, kind, body, created_at) VALUES (?, ?, ?, ?)').run(
        id, 'status', `Created in ${STATUS_LABEL[st]}`, ts
      );
      return this.get(id);
    },

    update(id, fields) {
      const cur = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      if (!cur) return null;
      const ts = nowIso();
      const next = { ...cur, ...fields };
      let doneAt = cur.done_at;
      if (next.status !== cur.status) doneAt = next.status === 'done' ? ts : null;
      db.prepare(
        `UPDATE tasks SET title=?, description=?, status=?, priority=?, due_date=?, updated_at=?, done_at=? WHERE id=?`
      ).run(next.title, next.description, next.status, next.priority, next.due_date ?? null, ts, doneAt, id);
      if (next.status !== cur.status) {
        db.prepare('INSERT INTO updates (task_id, kind, body, created_at) VALUES (?, ?, ?, ?)').run(
          id, 'status', `${STATUS_LABEL[cur.status]} → ${STATUS_LABEL[next.status]}`, ts
        );
      }
      return this.get(id);
    },

    remove(id) {
      return db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0;
    },

    addNote(taskId, body) {
      if (!db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId)) return null;
      const ts = nowIso();
      db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(ts, taskId);
      const res = db
        .prepare('INSERT INTO updates (task_id, kind, body, created_at) VALUES (?, ?, ?, ?)')
        .run(taskId, 'note', body, ts);
      return db.prepare('SELECT * FROM updates WHERE id = ?').get(Number(res.lastInsertRowid));
    },

    editNote(updateId, body) {
      const u = db.prepare('SELECT * FROM updates WHERE id = ?').get(updateId);
      if (!u) return { error: 'not_found' };
      if (u.kind !== 'note') return { error: 'not_editable' };
      if (Date.now() - Date.parse(u.created_at) > EDIT_WINDOW_MS) return { error: 'expired' };
      db.prepare('UPDATE updates SET body = ?, edited_at = ? WHERE id = ?').run(body, nowIso(), updateId);
      return { update: db.prepare('SELECT * FROM updates WHERE id = ?').get(updateId) };
    },

    exportAll() {
      return {
        exported_at: nowIso(),
        tasks: db.prepare('SELECT * FROM tasks ORDER BY id').all(),
        updates: db.prepare('SELECT * FROM updates ORDER BY id').all(),
      };
    },
  };
}
