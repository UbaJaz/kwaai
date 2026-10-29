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
