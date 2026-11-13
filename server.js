const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDb } = require('./src/db');
const { createApp } = require('./src/app');
const { senderFromEnv } = require('./src/email');

// a .env file next to this one, when there is one (on a laptop); variables the host already set are kept
if (fs.existsSync(path.join(__dirname, '.env'))) process.loadEnvFile(path.join(__dirname, '.env'));

const env = process.env;
const devMode = env.NODE_ENV !== 'production';
const moderators = new Set((env.MODERATORS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

if (!devMode) {
  const missing = ['BASE_URL', 'EMAIL_FROM', 'MODERATORS', 'CONTACT_EMAIL', 'AUTHOR_KEY'].filter((k) => !env[k]);
  if (!env.BREVO_API_KEY && !env.RESEND_API_KEY) missing.push('BREVO_API_KEY or RESEND_API_KEY');
  if (missing.length) {
    console.error(`Refusing to start in production. Missing env vars: ${missing.join(', ')} (see README).`);
    process.exit(1);
  }
}

// Real emails, even on a dev-mode demo, need the sender and a fixed site address. Without BASE_URL the sign-in link
// would be built from the request's Host header, which anyone can fake to send a student a link to their own site.
if ((env.BREVO_API_KEY || env.RESEND_API_KEY) && (!env.EMAIL_FROM || !env.BASE_URL)) {
  console.error('An email API key is set, so EMAIL_FROM and BASE_URL are needed too (see README).');
  process.exit(1);
}

// AUTHOR_KEY links reviews to their authors (see KEYED in src/db.js). Anywhere real students can sign in (production,
// or any site sending real sign-in emails) needs a real one: at least 32 characters, kept out of the database and in
// both operators' password managers. Losing it means old reviews can't be deleted or banned by author.
if (!devMode || env.BREVO_API_KEY || env.RESEND_API_KEY) {
  if (!env.AUTHOR_KEY || env.AUTHOR_KEY.length < 32) {
    console.error('AUTHOR_KEY must be set to a secret of at least 32 characters here. Make one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
  }
} else if (!env.AUTHOR_KEY) console.log('No AUTHOR_KEY set: using the development key. Fine on a laptop, never on a real site.');
const db = openDb(undefined, { authorKey: env.AUTHOR_KEY });
// Seed an empty database, and re-seed (upserts only, no sample reviews) whenever the handbook data files change, so a
// redeploy with new courses or staff reaches a database that already holds students' reviews.
const dataDir = path.join(__dirname, 'data');
const hasher = crypto.createHash('sha1');
for (const f of fs.readdirSync(dataDir).sort()) hasher.update(f).update(fs.readFileSync(path.join(dataDir, f)));
const dataHash = hasher.digest('hex');
const seenHash = db.prepare("SELECT value FROM meta WHERE key = 'data_hash'").get()?.value;
const empty = !db.prepare('SELECT COUNT(*) AS n FROM courses').get().n;
if (empty || seenHash !== dataHash) {
  console.log(empty ? 'Empty database, seeding…' : 'Handbook data changed, updating courses…', require('./scripts/seed').seed(db, { samples: devMode }));
}
db.prepare("INSERT INTO meta (key, value) VALUES ('data_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(dataHash);
// Hourly clean-up: expired sign-in links and sessions, plus the 12-month retention promised in /privacy.
const sweep = () => {
  db.prepare('DELETE FROM login_tokens WHERE expires < ?').run(Date.now());
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  db.exec(`DELETE FROM reports WHERE review_id IN (SELECT id FROM reviews WHERE status = 'removed' AND created_at < datetime('now', '-12 months'));
    UPDATE takedowns SET review_id = NULL WHERE review_id IN (SELECT id FROM reviews WHERE status = 'removed' AND created_at < datetime('now', '-12 months'));
    DELETE FROM reviews WHERE status = 'removed' AND created_at < datetime('now', '-12 months');
    DELETE FROM verdicts WHERE status = 'removed' AND created_at < datetime('now', '-12 months');
    DELETE FROM takedowns WHERE status = 'closed' AND created_at < datetime('now', '-12 months');
    DELETE FROM lecturer_suggestions WHERE status != 'open' AND created_at < datetime('now', '-12 months');
    DELETE FROM mod_log WHERE created_at < datetime('now', '-12 months');
    DELETE FROM calendars WHERE IFNULL(fetched_at, created_at) < datetime('now', '-12 months');`);
};
sweep();
setInterval(sweep, 60 * 60 * 1000).unref();

const port = Number(env.PORT) || 3000;
createApp(db, {
  moderators,
  devMode,
  baseUrl: env.BASE_URL?.replace(/\/$/, ''),
  trustProxy: env.TRUST_PROXY,
  sendLoginEmail: senderFromEnv(env),
  contactEmail: env.CONTACT_EMAIL,
  operator: env.OPERATOR || undefined,
  informationOfficer: env.INFORMATION_OFFICER || undefined,
  emailDailyCap: Number(env.EMAIL_DAILY_CAP) || undefined,
  demoPassword: env.DEMO_PASSWORD || undefined,
  adminUsername: env.ADMIN_USERNAME || undefined,
  adminPasswordHash: env.ADMIN_PASSWORD_HASH || undefined,
  testTools: env.TEST_TOOLS === '1',
}).listen(port, () => {
  console.log(`Kwaai running on http://localhost:${port}${devMode ? ' (dev mode)' : ''}`);
  if (!moderators.size) console.log('Tip: set MODERATORS=you@myuct.ac.za to get access to /mod');
  if (env.ADMIN_PASSWORD_HASH && !require('./src/admin').isValidHash(env.ADMIN_PASSWORD_HASH)) console.log('ADMIN_PASSWORD_HASH is not a hash from `npm run admin-hash`, so admin sign-in is off.');
  if (env.TEST_TOOLS === '1') console.log('Test tools are on (/admin/tools). Turn TEST_TOOLS off before launch.');
});
