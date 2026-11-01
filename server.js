const { openDb } = require('./src/db');
const { createApp } = require('./src/app');
const { senderFromEnv } = require('./src/email');

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
if (!db.prepare('SELECT COUNT(*) AS n FROM courses').get().n) {
  console.log('Empty database, seeding…', require('./scripts/seed').seed(db, { samples: devMode }));
}
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
}).listen(port, () => {
  console.log(`Kwaai running on http://localhost:${port}${devMode ? ' (dev mode)' : ''}`);
  if (!moderators.size) console.log('Tip: set MODERATORS=you@myuct.ac.za to get access to /mod');
});
