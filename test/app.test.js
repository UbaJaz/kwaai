const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { seed } = require('../scripts/seed');
const { screenComment } = require('../src/moderation');
const { parseReviewForm, parseVerdictForm, overallOf, semesterLoad } = require('../src/ratings');
const { analysePlan, termsOf } = require('../src/planner');
const { html } = require('../src/html');
const { titleCase, parseHandbook, expandCode, codesIn, lecturePeriods, examWeight } = require('../scripts/import-handbook');
const { UNIVERSITIES } = require('../src/universities');

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

test('verdict form validation', () => {
  const ok = { lekker: '1', year: '2026', tip: '  do the   past papers ' };
  assert.deepEqual(parseVerdictForm(ok, { currentYear: 2026 }).verdict, { lekker: 1, year: 2026, tip: 'do the past papers' });
  assert.equal(parseVerdictForm({ ...ok, lekker: '0' }, { currentYear: 2026 }).verdict.lekker, 0);
  assert.ok(parseVerdictForm({ ...ok, lekker: 'yes' }, { currentYear: 2026 }).error);
  assert.ok(parseVerdictForm({ ...ok, year: '2010' }, { currentYear: 2026 }).error);
  assert.ok(parseVerdictForm({ ...ok, tip: 'x'.repeat(141) }, { currentYear: 2026 }).error);
});

test('semester load is credit-weighted and skips courses with no reviews', () => {
  const load = semesterLoad([
    { credits: 36, n: 5, difficulty: 4, workload: 4 },
    { credits: 18, n: 3, difficulty: 1, workload: 1 },
    { credits: 18, n: 0, difficulty: null, workload: null },
  ]);
  assert.equal(load.credits, 72);
  assert.equal(load.rated, 2);
  assert.equal(load.load, 3); // (36*4 + 18*1) / 54
  assert.equal(load.label, 'Survivable');
  assert.equal(semesterLoad([{ credits: 18, n: 4, difficulty: 5, workload: 5 }]).label, 'Fully cooked');
  assert.equal(semesterLoad([{ credits: 18, n: 0 }]).load, null);
});

test('every university accent is dark enough for text on white (WCAG AA, 4.5:1)', () => {
  const lum = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const u of UNIVERSITIES) {
    assert.ok(1.05 / (lum(u.accent) + 0.05) >= 4.5, `${u.slug} accent ${u.accent}`);
    assert.ok((lum(u.soft) + 0.05) / (lum(u.accent) + 0.05) >= 4.5, `${u.slug} accent on its soft background`);
  }
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

test('handbook parsing: courses in both semesters and the details the planner uses', () => {
  const [f, s] = parseHandbook('CSC1015F/S COMPUTER SCIENCE 1015 18 NQF credits at NQF level 5 Convener: K Prag Course entry requirements: At least 70% for NSC Mathematics. '
    + 'Course outline: Python. Lecture times: 4th or 5th period daily, Tutorials: One per week, 2nd period. DP requirements: Minimum of 45% aggregate in practical work. '
    + 'Assessment: Theory tests 15%; practical tests 25%; June examination 2 hours 60%. Subminima: 45% for practicals. Second-Year Courses');
  assert.deepEqual([f.code, s.code], ['CSC1015F', 'CSC1015S']);
  assert.deepEqual(f.periods, [4, 5]);
  assert.equal(f.periodChoice, true);
  assert.equal(f.examWeight, 60);
  assert.equal(f.dp, 'Minimum of 45% aggregate in practical work.');
  assert.equal(f.entry, 'At least 70% for NSC Mathematics.');
  assert.ok(!f.assessment.includes('Second-Year'));

  assert.equal(parseHandbook('PHY1004W MATTER & INTERACTIONS Each student needs a laptop. 36 NQF credits at NQF level 5 Convener: Prof A Buffler Course outline: x')[0]?.title, 'Matter & Interactions');
  assert.deepEqual(expandCode('STA1000F/S/H'), ['STA1000F', 'STA1000S', 'STA1000H']);
  assert.deepEqual(codesIn('PHY1004W, MAM1031F & MAM1032S (or equivalent), CSC1015F/S.'), ['PHY1004W', 'MAM1031F', 'MAM1032S', 'CSC1015F', 'CSC1015S']);
  assert.deepEqual(lecturePeriods('Tuesday and Thursday, 3rd period'), { periods: [3], periodChoice: false, days: ['Tuesday', 'Thursday'] });
  assert.deepEqual(lecturePeriods('Monday - Wednesday, 1st period').days, ['Monday', 'Tuesday', 'Wednesday']);
  assert.deepEqual(lecturePeriods('By arrangement').periods, []);
  assert.equal(examWeight('Semester mark counts 33.3% and end-of-semester exam counts 66.6%.'), 67);
  assert.equal(examWeight('Class record counts 50%; one 2-hour examination counts 50%. Although a supplementary examination is 100%'), 50);
  assert.equal(examWeight('Coursework: 35% Exam: 65%'), 65);
  assert.equal(examWeight('Theory tests 15%; June examination 2 hours 60%. Subminima: 45% for practicals, 45% on weighted average of theory tests and examination.'), 60);
  assert.equal(examWeight('Class record counts 50%; one 2-hour examination in June counts 25%; one 2-hour examination in November counts 25%.'), 50);
  assert.equal(examWeight('Coursework 50% (75% assessments, 15% assignments). Exam 50% (67% written examination; 33% computer examination)'), 50);
  assert.equal(examWeight('Invigilated tests (40%) and one final exam (60%), no projects.'), 60);
  assert.equal(examWeight('Portfolio 100%'), null);
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
  for (let i = 0; i < 32; i++) statuses.push((await b.post(`/reviews/${id}/report`, { reason: 'spam' })).status);
  assert.ok(statuses.includes(429), `expected a 429, got ${statuses}`);
});

test('review limits are per student, so classmates on the same Wi-Fi are not blocked', async () => {
  const review = (course, year) => ({ lecturer_id: 'none', year: String(year), teaching: 3, engagement: 3, exams: 3, support: 3, difficulty: 3, workload: 3, agree: '1', _course: course });
  const busy = browser();
  await busy.signIn('stu001@myuct.ac.za');
  const statuses = [];
  for (const course of ['CHE1007S', 'CIV3042F']) {
    for (let year = 2020; year <= 2025; year++) statuses.push((await busy.post(`/courses/${course}/review`, review(course, year))).status);
  }
  assert.equal(statuses.at(-1), 429, `11th+ review from one student is limited: ${statuses}`);
  const classmate = browser(); // same IP
  await classmate.signIn('stu002@myuct.ac.za');
  assert.equal((await classmate.post('/courses/CHE1007S/review', review('CHE1007S', 2025))).status, 303);
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

test('kwaai-or-nah votes: one per student, result shows from 3 votes, tips can be reported', async (t) => {
  // its own server, so earlier tests haven't used up this IP's report limit
  const db = openDb(':memory:');
  seed(db, { samples: false });
  const own = createApp(db, { moderators: new Set(['mod001@myuct.ac.za']), devMode: true }).listen(0);
  t.after(() => own.close());
  await new Promise((r) => own.once('listening', r));
  const fresh = () => browser(() => `http://localhost:${own.address().port}`);
  const year = String(new Date().getFullYear());
  const voters = [];
  for (const n of [1, 2, 3]) {
    const b = fresh();
    await b.signIn(`vot00${n}@myuct.ac.za`);
    voters.push(b);
  }
  const anon = fresh();
  assert.equal((await voters[0].post('/courses/CSC2001F/verdict', { lekker: '1', year, tip: 'Tutorials are where it clicks' })).status, 303);
  assert.equal((await voters[0].post('/courses/CSC2001F/verdict', { lekker: '0', year, tip: 'Tutorials are where it clicks' })).status, 303, 'voting again changes the vote');
  let page = await anon.text('/courses/CSC2001F');
  assert.match(page, /1 vote so far/, 'one student, one vote');
  assert.doesNotMatch(page, /say kwaai/, 'no percentage from a single vote');

  await voters[1].post('/courses/CSC2001F/verdict', { lekker: '1', year });
  await voters[2].post('/courses/CSC2001F/verdict', { lekker: '1', year });
  page = await anon.text('/courses/CSC2001F');
  assert.match(page, /67%<\/strong> say kwaai/);
  assert.match(page, /Tutorials are where it clicks/);

  const id = /\/verdicts\/(\d+)\/report/.exec(page)[1];
  assert.equal((await anon.post(`/verdicts/${id}/report`, {})).status, 303);
  assert.doesNotMatch(await anon.text('/courses/CSC2001F'), /Tutorials are where it clicks/, 'reported tip is hidden');
  const mod = fresh();
  await mod.signIn('mod001@myuct.ac.za');
  assert.match(await mod.text('/mod'), /Tutorials are where it clicks/);
  assert.equal((await mod.post(`/mod/verdicts/${id}/approve`, {})).status, 303);
  assert.match(await anon.text('/courses/CSC2001F'), /Tutorials are where it clicks/);
});

test('rule-breaking tips are held, contact details rejected, votes deleted with the account', async () => {
  const b = browser();
  await b.signIn('vot009@myuct.ac.za');
  const year = String(new Date().getFullYear());
  await b.post('/courses/CSC2002S/verdict', { lekker: '1', year, tip: 'email me at x@gmail.com' });
  assert.match(await b.text('/courses/CSC2002S'), /can&#39;t be posted/);
  await b.post('/courses/CSC2002S/verdict', { lekker: '0', year, tip: 'lecturer is an idiot' });
  assert.doesNotMatch(await browser().text('/courses/CSC2002S'), /lecturer is an idiot/);
  assert.match(await b.text('/account'), /Waiting for a moderator/);
  await b.post('/account/delete', {});
  const mod = browser();
  await mod.signIn('mod001@myuct.ac.za');
  assert.doesNotMatch(await mod.text('/mod'), /lecturer is an idiot/, 'held tip went with the account');
});

test('readers see the first 2 comments until they vote once, then all of them', async (t) => {
  const db = openDb(':memory:');
  seed(db, { samples: false });
  const add = db.prepare(`INSERT INTO reviews (course, year, teaching, engagement, exams, support, difficulty, workload, overall, body, created_at)
    VALUES ('CSC2001F', 2025, 4, 4, 4, 4, 3, 3, 4, ?, ?)`);
  for (const n of [1, 2, 3, 4]) add.run(`Gate comment number ${n}`, `2025-06-0${n} 10:00:00`);
  const own = createApp(db, { devMode: true }).listen(0);
  t.after(() => own.close());
  await new Promise((r) => own.once('listening', r));
  const b = browser(() => `http://localhost:${own.address().port}`);

  let page = await b.text('/courses/CSC2001F');
  assert.match(page, /Gate comment number 4/); // newest first
  assert.match(page, /Gate comment number 3/);
  assert.doesNotMatch(page, /Gate comment number [12]/, 'hidden comments are not sent to the browser at all');
  assert.match(page, /2 more comments on this page/);
  assert.match(page, /<b>\d\.\d<\/b>/, 'scores stay public');

  await b.signIn('gat001@myuct.ac.za');
  assert.doesNotMatch(await b.text('/courses/CSC2001F'), /Gate comment number 1/, 'signing in alone is not enough');
  await b.post('/courses/MAM1020F/verdict', { lekker: '1', year: '2025' });
  page = await b.text('/courses/CSC2001F');
  for (const n of [1, 2, 3, 4]) assert.match(page, new RegExp(`Gate comment number ${n}`));
  assert.doesNotMatch(page, /more comments? on this page/);
});

test('course pages carry a link preview and a WhatsApp share link', async () => {
  const page = await (await fetch(`${base}/courses/EEE3099S`)).text();
  assert.match(page, /<meta property="og:title" content="EEE3099S [^"]+ · Kwaai">/);
  assert.match(page, /<meta property="og:description" content="EEE3099S [^"]*Workload \d\.\d\/5[^"]*">/);
  assert.match(page, new RegExp(`<meta property="og:url" content="${base}/courses/EEE3099S">`));
  assert.match(page, /href="https:\/\/wa\.me\/\?text=Is%20EEE3099S%20kwaai%20or%20nah%3F/);
  assert.match(await (await fetch(`${base}/rules`)).text(), /<meta property="og:description" content="Course ratings, workload scores/);
});

test('semester planner: add by code or search, remove, and shared links do not overwrite your plan', async () => {
  const b = browser();
  let res = await b.get('/plan?add=eee3099s');
  assert.equal(res.headers.get('location'), '/plan?c=EEE3099S');
  res = await b.get('/plan?c=EEE3099S&add=CSC1016S');
  assert.equal(res.headers.get('location'), '/plan?c=EEE3099S,CSC1016S');
  let page = await b.text('/plan?c=EEE3099S,CSC1016S');
  assert.match(page, /class="plan-label">(Chilled|Survivable|Cooked|Fully cooked)</);
  assert.match(page, /From student reviews of 2 of these courses/);
  assert.match(page, /<h2 id="term-s2">Semester 2<\/h2>/);
  assert.doesNotMatch(page, /id="term-s1"/, 'an empty semester is left out');
  assert.match(page, /href="https:\/\/wa\.me\/\?text=My%20plan%20on%20Kwaai\.%20Semester%202%3A%20EEE3099S%2C%20CSC1016S/);

  // the bug that started this: CSC1015F is written "CSC1015F/S" in the 2026 handbook
  const other = browser();
  assert.equal((await other.get('/plan?c=CSC1016S&add=csc1015f')).headers.get('location'), '/plan?c=CSC1016S,CSC1015F');
  assert.match(await other.text('/plan?c=EEE3099S&add=csc1015'), /CSC1015S/, 'a code without its semester letter lists both');

  assert.match(await b.text('/plan?c=EEE3099S&add=dynamics'), /MEC2047F/, 'a name search lists matches to pick from');
  assert.match(await b.text('/plan?add=zzzznotacourse'), /No course matches/);
  assert.equal((await b.get('/plan')).headers.get('location'), '/plan?c=EEE3099S,CSC1016S', 'the plan is remembered');

  await b.get('/plan?c=MAM1020F'); // a friend's link
  assert.equal((await b.get('/plan')).headers.get('location'), '/plan?c=EEE3099S,CSC1016S', 'viewing a shared plan keeps yours');

  assert.equal((await b.get('/plan?c=EEE3099S,CSC1016S&remove=EEE3099S')).headers.get('location'), '/plan?c=CSC1016S');
  page = await b.text('/plan?c=APG4001S');
  assert.match(page, /Shows once students review these courses/, 'no made-up score for courses nobody reviewed');
  page = await b.text('/plan?c=CSC1016S,CSC1015S');
  assert.match(page, /CSC1016S lists CSC1015S in its entry requirements, but CSC1015S isn't finished before CSC1016S starts/);
  page = await b.text('/plan?c=CSC1016S,CSC1015S,CSC1015F');
  assert.doesNotMatch(page, /isn't finished before/, 'CSC1015F in semester 1 meets the requirement');
  assert.match(page, /Same course twice/);
  assert.match(page, /Entry requirement in your plan: CSC1015F/);
  assert.match(page, /Minimum of 45% aggregate in practical work/, 'DP rules from the handbook');
  assert.match(await b.text('/plan?c='), /Your plan is empty/);
});

test('planner checks: semesters, lecture clashes, which group to pick, exam share', () => {
  const course = (code, periods, extra = {}) => ({ code, credits: 18, n: 0, periods, period_choice: periods.includes('|') ? 1 : 0, days: 'Monday|Tuesday|Wednesday|Thursday|Friday', entry: '', exam_weight: null, ...extra });
  assert.deepEqual(['CSC1015F', 'CSC1016S', 'MAM1000W', 'STA1000L'].map(termsOf), [['s1'], ['s2'], ['s1', 's2'], []]);

  // CSC1015F can go 4th or 5th; MAM1031F is fixed at 4th, so the student must pick 5th for CSC1015F
  let p = analysePlan([course('CSC1015F', '4|5', { exam_weight: 60 }), course('MAM1031F', '4', { exam_weight: 70 }), course('MAM1000W', '', { credits: 36 })]);
  const s1 = p.terms[0];
  assert.equal(s1.timetable.fits, true);
  assert.deepEqual(s1.timetable.picks, [{ code: 'CSC1015F', periods: [5] }]);
  assert.deepEqual(s1.timetable.untimed, ['MAM1000W']);
  assert.equal(s1.credits, 54, 'a year course is half of each semester');
  assert.equal(s1.examShare, 65);
  assert.equal(p.terms[1].credits, 18);

  // two fixed courses in the same slot clash; on different days they don't
  p = analysePlan([course('AAA1000F', '2'), course('BBB1000F', '2')]);
  assert.deepEqual(p.terms[0].timetable.clashes, [{ a: 'AAA1000F', b: 'BBB1000F', periods: [2] }]);
  p = analysePlan([course('AAA1000F', '2', { days: 'Monday' }), course('BBB1000F', '2', { days: 'Tuesday' })]);
  assert.equal(p.terms[0].timetable.fits, true);

  // "passed or taken concurrently" allows the same semester; a plain requirement doesn't
  const together = 'MAM1031F & MAM1032S must have been passed or be taken concurrently.';
  p = analysePlan([course('PHY1004W', '', { entry: together }), course('MAM1031F', ''), course('MAM1032S', '')]);
  assert.deepEqual(p.entry.PHY1004W.tooLate, []);
  p = analysePlan([course('MAM1032S', '', { entry: 'MAM1031F' }), course('MAM1031S', '')]);
  assert.deepEqual(p.entry.MAM1032S.tooLate, ['MAM1031S']);
});

test('a demo password keeps every page private until it is given', async (t) => {
  const db = openDb(':memory:');
  seed(db, { samples: false });
  const demo = createApp(db, { demoPassword: 'lekker-demo' }).listen(0);
  t.after(() => demo.close());
  await new Promise((r) => demo.once('listening', r));
  const url = `http://localhost:${demo.address().port}/courses`;
  const basic = (pw) => ({ authorization: `Basic ${Buffer.from(`anyone:${pw}`).toString('base64')}` });
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: basic('wrong') })).status, 401);
  assert.equal((await fetch(url, { headers: basic('lekker-demo') })).status, 200);
});

test('pages carry the university accent, and /universities lists who is live', async () => {
  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /<body style="--uni:#0b3c5d;--uni-soft:#e3ecf2">/);
  assert.match(home, /class="uni-chip"[^>]*>.*UCT<\/a>/s);
  const page = await (await fetch(`${base}/universities`)).text();
  assert.match(page, /University of Cape Town[\s\S]*Browse \d+ courses/);
  assert.match(page, /University of the Witwatersrand[\s\S]*Coming soon/);
  assert.doesNotMatch(home + page, /LekkerOrNah/);
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
