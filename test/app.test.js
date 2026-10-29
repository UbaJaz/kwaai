const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { seed } = require('../scripts/seed');
const { screenComment } = require('../src/moderation');
const { parseReviewForm, overallOf } = require('../src/ratings');
const { html } = require('../src/html');
const { titleCase, parseHandbook } = require('../scripts/import-handbook');

// ---- unit ----

test('html escapes interpolated values but not nested html', () => {
  assert.equal(String(html`<p>${'<script>'}</p>`), '<p>&lt;script&gt;</p>');
  assert.equal(String(html`<p>${html`<b>${'&'}</b>`}</p>`), '<p><b>&amp;</b></p>');
});

test('comment screening', () => {
  assert.equal(screenComment('Great notes, do the past papers').action, 'publish');
  assert.equal(screenComment('Tuts are where it clicks').action, 'publish');
  assert.equal(screenComment('email me at abc@gmail.com').action, 'reject');
  assert.equal(screenComment('call 082 123 4567').action, 'reject');
  assert.equal(screenComment('he is racist').action, 'hold');
  assert.equal(screenComment('she is so ugly').action, 'hold');
  assert.equal(screenComment('absolute kak lecturer').action, 'hold');
  assert.equal(screenComment('uses the whiteboard well').action, 'publish');
});

test('overall is the mean of the four quality scores, not difficulty or workload', () => {
  assert.equal(overallOf({ teaching: 5, engagement: 4, exams: 3, support: 4, difficulty: 1, workload: 1 }), 4);
});

test('review form validation', () => {
  const ok = { teaching: '4', engagement: '5', exams: '3', support: '4', difficulty: '5', workload: '2', year: '2025', tags: ['Funny', 'Great notes'], body: '  hi  there ' };
  const { review } = parseReviewForm(ok, { currentYear: 2026 });
  assert.equal(review.overall, 4);
  assert.equal(review.tags, 'Funny|Great notes');
  assert.equal(review.body, 'hi there');
  assert.ok(parseReviewForm({ ...ok, teaching: '6' }).error);
  assert.ok(parseReviewForm({ ...ok, year: '1999' }).error);
  assert.ok(parseReviewForm({ ...ok, tags: ['Funny', 'Great notes', 'Clear marking', 'Tough tests'] }).error);
  assert.ok(parseReviewForm({ ...ok, body: 'x'.repeat(281) }).error);
  assert.equal(parseReviewForm({ ...ok, tags: 'Not a real tag' }).review.tags, '');
});

test('handbook parsing', () => {
  const text = 'MEC2047F ENGINEERING DYNAMICS 16 NQF credits at NQF level 6 Convener: Professor M Ngoepe Course outline: blah\n'
    + 'MAM1020F MATHEMATICS 1A FOR ENGINEERS 18 NQF credits at NQF level 5 Convener: Dr B Mongwane and Dr X Y Course entry requirements: none';
  const courses = parseHandbook(text);
  assert.deepEqual(courses.map((c) => [c.code, c.title, c.credits, c.conveners]), [
    ['MAM1020F', 'Mathematics 1A for Engineers', 18, ['Dr B Mongwane', 'Dr X Y']],
    ['MEC2047F', 'Engineering Dynamics', 16, ['Professor M Ngoepe']],
  ]);
  assert.equal(titleCase('CHEMICAL ENGINEERING IB'), 'Chemical Engineering IB');
  assert.equal(titleCase('PHYSICS A FOR ENGINEERS'), 'Physics A for Engineers');
  assert.equal(titleCase('TOWARDS A DECOLONISED SCIENCE'), 'Towards a Decolonised Science');

  // other faculties: a note between title and credits, a "+", page headers glued to the convener
  const other = parseHandbook('AST1000S INTRODUCTION TO ASTRONOMY Two practical sessions are required. 18 NQF credits at NQF level 5 Convener: Dr A Smith 166 SCHOOL OF PHYSICS Course outline: x\n'
    + 'ASL1202S REPRESENTATIONS OF AFRICA + 10 NQF credits at NQF level 5 Convener: Ms B Jones Course entry requirements: none\n'
    + 'PHY6000W PHYSICS THESIS 120 NQF credits at NQF level 8 Convener: Dr C Course outline: x');
  assert.deepEqual(other.map((c) => [c.code, c.title, c.conveners]), [
    ['ASL1202S', 'Representations of Africa', ['Ms B Jones']],
    ['AST1000S', 'Introduction to Astronomy', ['Dr A Smith']],
  ]);
});

// ---- end to end: sign in, review, report, moderate ----

let server;
let base;
before(async () => {
  const db = openDb(':memory:');
  seed(db, { samples: true });
  server = createApp(db, { moderators: new Set(['mod001@myuct.ac.za']), devMode: true }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

// A tiny browser: keeps cookies and adds the CSRF token to every POST, like the real forms do.
function browser(root = () => base) {
  const jar = {};
  const remember = (res) => { for (const c of res.headers.getSetCookie()) { const [kv] = c.split(';'); const [k, v] = kv.split('='); jar[k] = v; } return res; };
  const cookie = () => Object.entries(jar).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
  const get = async (p) => remember(await fetch(root() + p, { headers: { cookie: cookie() }, redirect: 'manual' }));
  const post = async (p, body, { csrf = true } = {}) => {
    if (!jar.csrf) await get('/');
    const data = new URLSearchParams({ ...body, ...(csrf ? { _csrf: jar.csrf } : {}) });
    return remember(await fetch(root() + p, { method: 'POST', body: data, headers: { cookie: cookie() }, redirect: 'manual' }));
  };
  const text = async (p) => (await get(p)).text();
  const signIn = async (email) => {
    const page = await (await post('/login', { email })).text();
    await get(new URL(/href="(http[^"]+\/auth\/[a-f0-9]+)"/.exec(page)[1]).pathname);
  };
  return { get, post, text, signIn, jar };
}

test('only @myuct.ac.za emails can sign in', async () => {
  assert.equal((await browser().post('/login', { email: 'someone@gmail.com' })).status, 400);
});

test('posts without a valid CSRF token are refused', async () => {
  const b = browser();
  assert.equal((await b.post('/takedown', { name: 'x', email: 'x@y.z', details: 'x' }, { csrf: false })).status, 403);
  assert.match(await b.text('/rules'), /x/); // sanity: normal pages still work
  const page = await b.text('/takedown');
  assert.match(page, new RegExp(`name="_csrf" value="${b.jar.csrf}"`), 'forms carry the token');
  // real browsers send other cookies first
  const res = await fetch(base + '/takedown', { method: 'POST', redirect: 'manual', headers: { cookie: `other=1; csrf=${b.jar.csrf}` },
    body: new URLSearchParams({ _csrf: b.jar.csrf, name: 'x', email: 'bad', details: 'x' }) });
  assert.equal(res.status, 400, 'token accepted when csrf is not the first cookie (400 = form validation, not 403)');
});

test('security headers are set', async () => {
  const res = await fetch(base + '/');
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('student reviews, report hides it, moderator restores it', async () => {
  const student = browser();
  await student.signIn('abcxyz001@myuct.ac.za');
  const good = { lecturer_id: 'none', year: String(new Date().getFullYear()), teaching: 5, engagement: 5, exams: 4, support: 5, difficulty: 3, workload: 3, body: 'Demos in lectures are the best part', agree: '1' };

  assert.equal((await student.post('/courses/PHY1012F/review', good)).status, 303);
  assert.equal((await student.post('/courses/PHY1012F/review', good)).status, 400, 'second review for same lecturer/year is refused');

  const anon = browser();
  let page = await anon.text('/courses/PHY1012F');
  assert.match(page, /Demos in lectures are the best part/);
  assert.doesNotMatch(page, /abcxyz001/, 'author email never shown');
  const id = /id="review-(\d+)"[\s\S]*?Demos in lectures/.exec(page)[1];

  assert.equal((await anon.post(`/reviews/${id}/report`, { reason: 'defamation' })).status, 303);
  assert.doesNotMatch(await anon.text('/courses/PHY1012F'), /Demos in lectures/, 'serious report hides the review immediately');

  assert.equal((await student.get('/mod')).status, 404, 'students cannot moderate');
  const mod = browser();
  await mod.signIn('mod001@myuct.ac.za');
  assert.match(await mod.text('/mod'), /Demos in lectures/);
  assert.equal((await mod.post(`/mod/reviews/${id}/approve`, {})).status, 303);
  assert.match(await anon.text('/courses/PHY1012F'), /Demos in lectures/);
});

test('rule-breaking comments are held, contact details rejected', async () => {
  const student = browser();
  await student.signIn('def001@myuct.ac.za');
  const review = { lecturer_id: 'none', teaching: 2, engagement: 2, exams: 2, support: 2, difficulty: 5, workload: 5, agree: '1', year: '2025' };
  assert.equal((await student.post('/courses/MEC2047F/review', { ...review, body: 'whatsapp me 0821234567' })).status, 400);
  assert.equal((await student.post('/courses/MEC2047F/review', { ...review, body: 'he is an idiot honestly' })).status, 303);
  const page = await student.text('/courses/MEC2047F');
  assert.doesNotMatch(page, /idiot/);
  assert.match(page, /waiting for a moderator/);
});

test('takedown request hides the review without needing an account', async () => {
  const b = browser();
  const id = /id="review-(\d+)"/.exec(await b.text('/courses/MAM1020F'))[1];
  const res = await b.post('/takedown', { review_id: id, name: 'A Lecturer', email: 'lect@uct.ac.za', relation: 'The lecturer or staff member it is about', details: 'Not accurate' });
  assert.equal(res.status, 200);
  assert.doesNotMatch(await b.text('/courses/MAM1020F'), new RegExp(`id="review-${id}"`));
});

test('pages render', async () => {
  for (const p of ['/', '/courses', '/courses?dept=MEC&q=dyn', '/rankings?cat=hardest&kind=lecturer&dept=EEE', '/rules', '/takedown', '/lecturers/1']) {
    assert.equal((await fetch(base + p)).status, 200, p);
  }
  assert.equal((await fetch(`${base}/courses/NOPE123X`)).status, 404);
});

test('scores built from sample reviews are badged wherever they appear', async () => {
  for (const p of ['/courses?q=EEE3099S', '/courses/EEE3099S', '/rankings?cat=best&kind=course']) {
    assert.match(await (await fetch(base + p)).text(), /class="badge sample"/, p);
  }
  // a course with no sample reviews gets no badge on its card
  assert.doesNotMatch(await (await fetch(`${base}/courses?q=APG4001S`)).text(), /<main[\s\S]*class="badge sample"/);
});

test('reports are rate limited per IP', async () => {
  const b = browser();
  const id = /id="review-(\d+)"/.exec(await b.text('/courses/EEE3099S'))[1];
  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await b.post(`/reviews/${id}/report`, { reason: 'spam' })).status);
  assert.ok(statuses.includes(429), `expected a 429, got ${statuses}`);
});

test('production sign-in emails the link built from BASE_URL and never shows it', async () => {
  const sent = [];
  const db = openDb(':memory:');
  seed(db, { samples: false });
  const prod = createApp(db, { devMode: false, baseUrl: 'https://lekker.example', sendLoginEmail: async (to, link) => sent.push({ to, link }) }).listen(0);
  await new Promise((r) => prod.once('listening', r));
  const b = browser(() => `http://localhost:${prod.address().port}`);
  const page = await (await b.post('/login', { email: 'ghi001@myuct.ac.za' })).text();
  assert.equal(sent.length, 1);
  assert.match(sent[0].link, /^https:\/\/lekker\.example\/auth\/[a-f0-9]{64}$/);
  assert.doesNotMatch(page, /\/auth\//, 'link is not shown on the page');
  prod.close();
});

test('suggested lecturers only appear after a moderator approves them', async () => {
  const student = browser();
  await student.signIn('jkl001@myuct.ac.za');
  assert.equal((await student.post('/courses/MEC2047F/suggest-lecturer', { title: 'Dr', name: '<script>' })).status, 400);
  assert.equal((await student.post('/courses/MEC2047F/suggest-lecturer', { title: 'Dr', name: 'Q Newperson' })).status, 303);
  assert.doesNotMatch(await student.text('/courses/MEC2047F/review'), /Dr Q Newperson/);

  const mod = browser();
  await mod.signIn('mod001@myuct.ac.za');
  const id = /\/mod\/suggestions\/(\d+)\/approve/.exec(await mod.text('/mod'))[1];
  assert.equal((await mod.post(`/mod/suggestions/${id}/approve`, {})).status, 303);
  assert.match(await student.text('/courses/MEC2047F/review'), /Dr Q Newperson/);
});

test('students can delete their account and all their reviews', async () => {
  const student = browser();
  await student.signIn('mno001@myuct.ac.za');
  await student.post('/courses/CSC1016S/review', { lecturer_id: 'none', year: '2025', teaching: 4, engagement: 4, exams: 4, support: 4, difficulty: 3, workload: 3, body: 'Delete-me marker review', agree: '1' });
  assert.match(await student.text('/account'), /Delete-me marker review/);
  assert.equal((await student.post('/account/delete', {})).status, 303);
  assert.doesNotMatch(await student.text('/courses/CSC1016S'), /Delete-me marker/);
  assert.equal((await student.get('/account')).status, 303, 'signed out afterwards');
});

test('privacy and terms pages render', async () => {
  for (const p of ['/privacy', '/terms']) assert.equal((await fetch(base + p)).status, 200, p);
});

test('re-running the seed keeps real reviews and only swaps demo data', () => {
  const db = openDb(':memory:');
  seed(db, { samples: true });
  db.prepare("INSERT INTO users (email) VALUES ('pqr001@myuct.ac.za')").run();
  db.prepare(`INSERT INTO reviews (course, year, user_id, teaching, engagement, exams, support, difficulty, workload, overall)
    VALUES ('MEC2047F', 2025, 1, 4, 4, 4, 4, 4, 4, 4)`).run();
  seed(db, { samples: false });
  const count = (sql) => db.prepare(sql).get().n;
  assert.equal(count('SELECT COUNT(*) AS n FROM reviews WHERE is_sample = 0'), 1);
  assert.equal(count('SELECT COUNT(*) AS n FROM reviews WHERE is_sample = 1'), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM lecturers WHERE is_sample = 1'), 0);
  assert.ok(count('SELECT COUNT(*) AS n FROM courses') > 900);
});
