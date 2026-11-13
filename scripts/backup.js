// Writes a consistent copy of the live database to backups/lekker-<timestamp>.db (safe while the server runs).
// In production the server calls backupIfDue every hour, so there's a fresh copy each day; `npm run backup` makes one
// now. Both copies sit on the same disk as the database, so also keep copies somewhere off the server.
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups');
const DAY = 24 * 60 * 60 * 1000;
// Backups older than 30 days are deleted, as the privacy notice promises: a deleted account is gone from every
// backup within 30 days.
const KEEP_DAYS = 30;
const backups = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^lekker-.*\.db$/.test(f)).map((f) => path.join(dir, f)) : []);

function backup(db, dir = DEFAULT_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `lekker-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  for (const old of backups(dir)) if (Date.now() - fs.statSync(old).mtimeMs > KEEP_DAYS * DAY) fs.unlinkSync(old);
  return file;
}

// a backup, unless one was made in the last 23 hours (so restarts and deploys don't skip or double a day)
function backupIfDue(db, dir = DEFAULT_DIR) {
  const newest = Math.max(0, ...backups(dir).map((f) => fs.statSync(f).mtimeMs));
  return Date.now() - newest > 23 * 60 * 60 * 1000 ? backup(db, dir) : null;
}

module.exports = { backup, backupIfDue, KEEP_DAYS };

if (require.main === module) console.log('backed up to', backup(require('../src/db').openDb(undefined, { authorKey: process.env.AUTHOR_KEY })));
