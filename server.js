import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname, sep } from 'node:path';
import { openDb, makeStore, STATUSES, PRIORITIES } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

async function readJson(req) {
  // Requiring a JSON content type forces a CORS preflight for cross-site pages,
  // so other websites open in the browser cannot silently write to this API.
  if (!(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100_000) throw new HttpError(413, 'Body too large');
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// Returns only the fields that are present and valid. `partial` allows missing title.
function validateTask(input, partial) {
  const out = {};
  if ('title' in input || !partial) {
    const t = typeof input.title === 'string' ? input.title.trim() : '';
    if (!t || t.length > 200) throw new HttpError(400, 'title is required (max 200 chars)');
    out.title = t;
  }
  if ('description' in input) {
    if (typeof input.description !== 'string' || input.description.length > 5000)
      throw new HttpError(400, 'description must be a string (max 5000 chars)');
    out.description = input.description;
  }
  if ('status' in input) {
    if (!STATUSES.includes(input.status)) throw new HttpError(400, 'invalid status');
    out.status = input.status;
  }
  if ('priority' in input) {
    if (!PRIORITIES.includes(input.priority)) throw new HttpError(400, 'invalid priority');
    out.priority = input.priority;
  }
  if ('due_date' in input) {
    if (input.due_date === null || input.due_date === '') out.due_date = null;
    else if (typeof input.due_date === 'string' && validDate(input.due_date)) out.due_date = input.due_date;
    else throw new HttpError(400, 'due_date must be YYYY-MM-DD');
  }
  return out;
}

function validateNote(input) {
  const b = typeof input.body === 'string' ? input.body.trim() : '';
  if (!b || b.length > 5000) throw new HttpError(400, 'body is required (max 5000 chars)');
  return b;
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const full = normalize(join(PUBLIC_DIR, rel));
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + sep)) throw new HttpError(404, 'Not found');
  try {
    const data = await readFile(full);
    res.writeHead(200, {
      'Content-Type': MIME[extname(full)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    throw new HttpError(404, 'Not found');
  }
}

export function buildServer(db) {
  const store = makeStore(db);

  async function handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const method = req.method;
    const id = parts[2] !== undefined ? Number(parts[2]) : null;
    if (parts[2] !== undefined && (!Number.isInteger(id) || id < 1)) throw new HttpError(404, 'Not found');

    // /api/tasks
    if (parts[1] === 'tasks' && parts.length === 2) {
      if (method === 'GET') {
        const view = url.searchParams.get('view');
        return send(res, 200, view === 'archive' ? store.archive(url.searchParams.get('q') || '') : store.board());
      }
      if (method === 'POST') {
        const task = store.create(validateTask(await readJson(req), false));
        return send(res, 201, task);
      }
    }

    // /api/tasks/:id
    if (parts[1] === 'tasks' && parts.length === 3) {
      if (method === 'GET') {
        const t = store.get(id);
        if (!t) throw new HttpError(404, 'Task not found');
        return send(res, 200, t);
      }
      if (method === 'PATCH') {
        const t = store.update(id, validateTask(await readJson(req), true));
        if (!t) throw new HttpError(404, 'Task not found');
        return send(res, 200, t);
      }
      if (method === 'DELETE') {
        if (!store.remove(id)) throw new HttpError(404, 'Task not found');
        return send(res, 200, { ok: true });
      }
    }

    // /api/tasks/:id/updates
    if (parts[1] === 'tasks' && parts[3] === 'updates' && parts.length === 4 && method === 'POST') {
      const u = store.addNote(id, validateNote(await readJson(req)));
      if (!u) throw new HttpError(404, 'Task not found');
      return send(res, 201, u);
    }

    // /api/updates/:id
    if (parts[1] === 'updates' && parts.length === 3 && method === 'PATCH') {
      const r = store.editNote(id, validateNote(await readJson(req)));
      if (r.error === 'not_found') throw new HttpError(404, 'Update not found');
      if (r.error === 'not_editable') throw new HttpError(403, 'Only notes can be edited');
      if (r.error === 'expired') throw new HttpError(403, 'Notes can only be edited within 24 hours of posting');
      return send(res, 200, r.update);
    }

    // /api/updates/:id/history
    if (parts[1] === 'updates' && parts[3] === 'history' && parts.length === 4 && method === 'GET') {
      const h = store.history(id);
      if (!h) throw new HttpError(404, 'Update not found');
      return send(res, 200, h);
    }

    // /api/export
    if (parts[1] === 'export' && parts.length === 2 && method === 'GET') {
      const date = new Date().toISOString().slice(0, 10);
      return send(res, 200, store.exportAll(), {
        'Content-Disposition': `attachment; filename="todolist-export-${date}.json"`,
      });
    }

    throw new HttpError(404, 'Not found');
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
      return await serveStatic(req, res, decodeURIComponent(url.pathname));
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err);
      return send(res, 500, { error: 'Internal server error' });
    }
  });
}

// Start only when run directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const HOST = process.env.HOST || '127.0.0.1'; // set to the Tailscale IP in production
  const PORT = Number(process.env.PORT || 3000);
  const DB_PATH = process.env.DB_PATH || join(__dirname, 'data', 'todo.db');
  const server = buildServer(openDb(DB_PATH));
  server.listen(PORT, HOST, () => console.log(`todolist listening on http://${HOST}:${PORT} (db: ${DB_PATH})`));
}
