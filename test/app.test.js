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

const form = (o) => new URLSearchParams(o);
async function signIn(email) {
  const page = await (await fetch(`${base}/login`, { method: 'POST', body: form({ email }) })).text();
  const link = /href="(http[^"]+\/auth\/[a-f0-9]+)"/.exec(page)[1];
  const res = await fetch(link, { redirect: 'manual' });
  return res.headers.getSetCookie().find((c) => c.startsWith('sid=')).split(';')[0];
}

test('only @myuct.ac.za emails can sign in', async () => {
  const res = await fetch(`${base}/login`, { method: 'POST', body: form({ email: 'someone@gmail.com' }) });
  assert.equal(res.status, 400);
});

test('student reviews, report hides it, moderator restores it', async () => {
  const student = await signIn('abcxyz001@myuct.ac.za');
  const post = (body) => fetch(`${base}/courses/PHY1012F/review`, { method: 'POST', body: form(body), headers: { cookie: student }, redirect: 'manual' });
  const good = { lecturer_id: 'none', year: String(new Date().getFullYear()), teaching: 5, engagement: 5, exams: 4, support: 5, difficulty: 3, workload: 3, body: 'Demos in lectures are the best part', agree: '1' };

  assert.equal((await post(good)).status, 303);
  assert.equal((await post(good)).status, 400, 'second review for same lecturer/year is refused');

  let page = await (await fetch(`${base}/courses/PHY1012F`)).text();
  assert.match(page, /Demos in lectures are the best part/);
  assert.doesNotMatch(page, /abcxyz001/, 'author email never shown');
  const id = /id="review-(\d+)"[\s\S]*?Demos in lectures/.exec(page)[1];

  const report = await fetch(`${base}/reviews/${id}/report`, { method: 'POST', body: form({ reason: 'defamation' }), redirect: 'manual' });
  assert.equal(report.status, 303);
  page = await (await fetch(`${base}/courses/PHY1012F`)).text();
  assert.doesNotMatch(page, /Demos in lectures/, 'serious report hides the review immediately');

  assert.equal((await fetch(`${base}/mod`, { headers: { cookie: student } })).status, 404, 'students cannot moderate');
  const mod = await signIn('mod001@myuct.ac.za');
  assert.match(await (await fetch(`${base}/mod`, { headers: { cookie: mod } })).text(), /Demos in lectures/);
  assert.equal((await fetch(`${base}/mod/reviews/${id}/approve`, { method: 'POST', headers: { cookie: mod }, redirect: 'manual' })).status, 303);
  page = await (await fetch(`${base}/courses/PHY1012F`)).text();
  assert.match(page, /Demos in lectures/);
});

test('rule-breaking comments are held, contact details rejected', async () => {
  const student = await signIn('def001@myuct.ac.za');
  const post = (body) => fetch(`${base}/courses/MEC2047F/review`, { method: 'POST', body: form(body), headers: { cookie: student }, redirect: 'manual' });
  const base2 = { lecturer_id: 'none', teaching: 2, engagement: 2, exams: 2, support: 2, difficulty: 5, workload: 5, agree: '1' };
  assert.equal((await post({ ...base2, year: '2025', body: 'whatsapp me 0821234567' })).status, 400);
  assert.equal((await post({ ...base2, year: '2025', body: 'he is an idiot honestly' })).status, 303);
  const page = await (await fetch(`${base}/courses/MEC2047F`, { headers: { cookie: student } })).text();
  assert.doesNotMatch(page, /idiot/);
  assert.match(page, /waiting for a moderator/);
});

test('takedown request hides the review without needing an account', async () => {
  const page = await (await fetch(`${base}/courses/MAM1020F`)).text();
  const id = /id="review-(\d+)"/.exec(page)[1];
  const res = await fetch(`${base}/takedown`, { method: 'POST', body: form({ review_id: id, name: 'A Lecturer', email: 'lect@uct.ac.za', relation: 'The lecturer or staff member it is about', details: 'Not accurate' }) });
  assert.equal(res.status, 200);
  assert.doesNotMatch(await (await fetch(`${base}/courses/MAM1020F`)).text(), new RegExp(`id="review-${id}"`));
});

test('pages render', async () => {
  for (const p of ['/', '/courses', '/courses?dept=MEC&q=dyn', '/rankings?cat=hardest&kind=lecturer&dept=EEE', '/rules', '/takedown', '/lecturers/1']) {
    assert.equal((await fetch(base + p)).status, 200, p);
  }
  assert.equal((await fetch(`${base}/courses/NOPE123X`)).status, 404);
});
