// Writes a consistent copy of the live database to backups/lekker-<timestamp>.db (safe while the server runs).
// Run it daily from cron or your host's scheduler, and copy the file somewhere off the server.
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../src/db');

const dir = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `lekker-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
openDb().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
console.log('backed up to', file);

// Backups older than 30 days are deleted, as the privacy notice promises: a deleted account is gone from every
// backup within 30 days.
const KEEP_DAYS = 30;
for (const f of fs.readdirSync(dir).filter((f) => /^lekker-.*\.db$/.test(f))) {
  const full = path.join(dir, f);
  if (Date.now() - fs.statSync(full).mtimeMs > KEEP_DAYS * 24 * 60 * 60 * 1000) {
    fs.unlinkSync(full);
    console.log('deleted old backup', f);
  }
}
