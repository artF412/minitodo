// Daily backup: consistent snapshot via VACUUM INTO, then push with rsync.
// Env: DB_PATH, BACKUP_DIR (local staging), REMOTE (user@host:./), SSH_KEY, KEEP_LOCAL_DAYS
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const DB_PATH = process.env.DB_PATH || '/var/lib/todolist/todo.db';
const BACKUP_DIR = process.env.BACKUP_DIR || '/var/lib/todolist/backups';
const REMOTE = process.env.REMOTE; // e.g. backup@192.168.1.50:./
const SSH_KEY = process.env.SSH_KEY || '/var/lib/todolist/.ssh/backup_ed25519';
const KEEP_LOCAL_DAYS = Number(process.env.KEEP_LOCAL_DAYS || 14);

if (!REMOTE) {
  console.error('REMOTE is not set (expected user@host:./)');
  process.exit(2);
}

mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '_'); // 20261117_020000
const file = join(BACKUP_DIR, `todo-${stamp}.db`);

const db = new DatabaseSync(DB_PATH, { readOnly: true });
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
db.close();
console.log(`snapshot written: ${file}`);

// --ignore-existing: never overwrite a file already on the remote. No --delete, ever.
const r = spawnSync(
  'rsync',
  ['-t', '--ignore-existing', '-e', `ssh -i ${SSH_KEY} -o BatchMode=yes -o IdentitiesOnly=yes`, file, REMOTE],
  { stdio: 'inherit' }
);
if (r.status !== 0) {
  console.error(`rsync failed (exit ${r.status}); local snapshot kept at ${file}`);
  process.exit(1);
}
console.log('pushed to remote');

// Prune only the LOCAL staging copies (the remote is never touched).
const cutoff = Date.now() - KEEP_LOCAL_DAYS * 86400000;
for (const f of readdirSync(BACKUP_DIR)) {
  if (!/^todo-\d{8}_\d{6}\.db$/.test(f)) continue;
  const p = join(BACKUP_DIR, f);
  if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
}
