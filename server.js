const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { openDb, cleanUp } = require('./src/db');
const { createApp } = require('./src/app');
const { senderFromEnv } = require('./src/email');

// a .env file next to this one, when there is one (on a laptop); variables the host already set are kept
if (fs.existsSync(path.join(__dirname, '.env'))) process.loadEnvFile(path.join(__dirname, '.env'));

const env = process.env;
const devMode = env.NODE_ENV !== 'production';
const moderators = new Set((env.MODERATORS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

if (!devMode) {
  const missing = ['BASE_URL', 'EMAIL_FROM', 'MODERATORS', 'CONTACT_EMAIL'].filter((k) => !env[k]);
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

const db = openDb();
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
// Hourly clean-up: expired sign-in links and sessions, plus the retention promised in /privacy (src/db.js).
const sweep = () => cleanUp(db);
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
