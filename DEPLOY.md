# Deploying Todo Board on Rocky Linux 9

Zero npm dependencies. Needs only Node (you have v26.13.1, which includes `node:sqlite`).

## 1. Get the app onto the mini pc (via your private GitHub repo)

The repo must not contain `data/` or any key (`.gitignore` already excludes them).

On the mini pc (needs `git`: `sudo dnf install git`). The repo is private, so use either
HTTPS with a fine-grained read-only token, or a read-only **deploy key** (repo Settings > Deploy keys).
Use a different key from the backup key.

```bash
sudo useradd -r -m -d /var/lib/todolist -s /sbin/nologin todolist
sudo git clone <your-private-repo-url> /opt/todolist
sudo chown -R root:root /opt/todolist
command -v node        # note the path; fix ExecStart in the .service files if it is not /usr/bin/node
```

To update later: `cd /opt/todolist && sudo git pull && sudo systemctl restart todolist`.
The `.service` files are copied into `/etc/systemd/system/` and edited there, so `git pull` never conflicts.

## 2. Run the tests (optional but recommended)

```bash
cd /opt/todolist && node --test
```

## 3. Install the app service (listens ONLY on the Tailscale IP)

```bash
tailscale ip -4        # e.g. 100.101.102.103
sudo cp /opt/todolist/deploy/todolist.service /etc/systemd/system/
sudo sed -i 's/100.x.y.z/100.101.102.103/' /etc/systemd/system/todolist.service   # use YOUR ip
sudo systemctl daemon-reload
sudo systemctl enable --now todolist
systemctl status todolist
```

Open `http://<tailscale-ip>:3000` from any of your machines. Do not open port 3000 in firewalld.
Verify it is not reachable from the office LAN IP.

## 4. Backups (push to the other Linux box, write-only)

### 4a. On the mini pc: the key you already made
Use the key you generated. Put it where the service user can read it:

```bash
sudo mkdir -p /var/lib/todolist/.ssh
sudo cp /path/to/your/backup_key /var/lib/todolist/.ssh/backup_ed25519
sudo chown -R todolist:todolist /var/lib/todolist/.ssh
sudo chmod 700 /var/lib/todolist/.ssh && sudo chmod 600 /var/lib/todolist/.ssh/backup_ed25519
```

### 4b. On the backup machine: restrict the key to one folder, write-only
Check `command -v rrsync` (package `rsync`; if missing, `sudo dnf install rsync`; on some builds it is `/usr/share/doc/rsync/support/rrsync`). Append ONE line to `~backupuser/.ssh/authorized_keys` (paste the PUBLIC key at the end):

```
command="/usr/bin/rrsync -wo /path/you/created",restrict ssh-ed25519 AAAA... todolist-backup
```

`-wo` = write-only; `restrict` disables shell, port forwarding, etc.

### 4c. Install the timer on the mini pc
Edit `REMOTE=` in `deploy/todolist-backup.service` to `backupuser@<backup-host>:./`, then:

```bash
sudo cp /opt/todolist/deploy/todolist-backup.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now todolist-backup.timer
sudo -u todolist ssh -i /var/lib/todolist/.ssh/backup_ed25519 backupuser@<backup-host>   # first connect: accept host key, expect it to refuse a shell
sudo systemctl start todolist-backup.service && journalctl -u todolist-backup -n 20
```

### 4d. Prove the restrictions work (do not skip)
From the mini pc, as `todolist`, each of these should FAIL:

```bash
K=/var/lib/todolist/.ssh/backup_ed25519; R=backupuser@<backup-host>
sudo -u todolist ssh -i $K $R ls                       # no shell/command
sudo -u todolist rsync -e "ssh -i $K" $R:./ /tmp/x     # cannot read backups back
sudo -u todolist rsync -e "ssh -i $K" --delete -r /tmp/emptydir/ $R:./   # cannot delete
```

If the `--delete` test removes anything, stop and tell me; we will harden the target side
(for example a root-owned ingest script, or `chattr +i` on files after arrival).

Backups accumulate on the target; nothing deletes them. Prune there with the target's own cron if needed.

## 5. Restore

Stop the service, copy a backup over `/var/lib/todolist/todo.db`, remove any `todo.db-wal`/`todo.db-shm`, start the service.
