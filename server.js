const { openDb } = require('./src/db');
const { createApp } = require('./src/app');

const devMode = process.env.NODE_ENV !== 'production';
const moderators = new Set((process.env.MODERATORS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

// shortcut: no email provider yet. In dev the sign-in link is shown on screen; wire up SMTP/Resend before going live.
if (!devMode) {
  console.error('Refusing to start in production: sending sign-in emails is not implemented yet (see README).');
  process.exit(1);
}

const db = openDb();
if (!db.prepare('SELECT COUNT(*) AS n FROM courses').get().n) {
  console.log('Empty database, seeding…', require('./scripts/seed').seed(db));
}

const port = Number(process.env.PORT) || 3000;
createApp(db, { moderators, devMode }).listen(port, () => {
  console.log(`LekkerOrNah running on http://localhost:${port}`);
  if (!moderators.size) console.log('Tip: set MODERATORS=you@myuct.ac.za to get access to /mod');
});
