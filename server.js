const { openDb } = require('./src/db');
const { createApp } = require('./src/app');
const { resendSender } = require('./src/email');

const env = process.env;
const devMode = env.NODE_ENV !== 'production';
const moderators = new Set((env.MODERATORS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

if (!devMode) {
  const missing = ['BASE_URL', 'RESEND_API_KEY', 'EMAIL_FROM', 'MODERATORS', 'CONTACT_EMAIL'].filter((k) => !env[k]);
  if (missing.length) {
    console.error(`Refusing to start in production. Missing env vars: ${missing.join(', ')} (see README).`);
    process.exit(1);
  }
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
    DELETE FROM lecturer_suggestions WHERE status != 'open' AND created_at < datetime('now', '-12 months');`);
};
sweep();
setInterval(sweep, 60 * 60 * 1000).unref();

const port = Number(env.PORT) || 3000;
createApp(db, {
  moderators,
  devMode,
  baseUrl: env.BASE_URL?.replace(/\/$/, ''),
  trustProxy: env.TRUST_PROXY,
  sendLoginEmail: env.RESEND_API_KEY ? resendSender({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM }) : null,
  contactEmail: env.CONTACT_EMAIL,
  operator: env.OPERATOR || undefined,
  demoPassword: env.DEMO_PASSWORD || undefined,
}).listen(port, () => {
  console.log(`LekkerOrNah running on http://localhost:${port}${devMode ? ' (dev mode)' : ''}`);
  if (!moderators.size) console.log('Tip: set MODERATORS=you@myuct.ac.za to get access to /mod');
});
