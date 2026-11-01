const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { seed } = require('../scripts/seed');
const { screenComment } = require('../src/moderation');
const { parseReviewForm, parseVerdictForm, overallOf, semesterLoad } = require('../src/ratings');
const { analysePlan, termsOf, parseProfile, majorNeeds, creditAdvice } = require('../src/planner');
const { html } = require('../src/html');
const { titleCase, parseHandbook, expandCode, codesIn, lecturePeriods, examWeight, sessionsOf } = require('../scripts/import-handbook');
const { buildWeek, parseWeek, weekParams, icsFor } = require('../src/week');
const { UNIVERSITIES } = require('../src/universities');
const { scan: scanTables } = require('../scripts/import-tables');
const { parseProgrammes, tidyName } = require('../scripts/import-programmes');
const { parseStaff } = require('../scripts/import-staff');

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

test('handbook parsing: headings the first importer missed', () => {
  const one = (s) => parseHandbook(s)[0];
  // a note starting "A student cannot..." straight after the title (STA1006S was missing because of this)
  assert.equal(one('STA1006S MATHEMATICAL STATISTICS I A student cannot obtain credits for more than one of STA1000F/S. 18 NQF credits at NQF level 5 Convener: S Salau Course outline: x')?.title, 'Mathematical Statistics I');
  assert.equal(one('MAM2010F ADVANCED CALCULUS (2AC) 12 NQF credits at NQF level 6 Convener: Dr F Ebobisse-Bille Course outline: x')?.title, 'Advanced Calculus (2AC)');
  assert.equal(one('CSC3024S INTRODUCTION TO C++ PROGRAMMING 18 NQF credits at NQF level 7 Convener: P Marais Course outline: x')?.title, 'Introduction to C++ Programming');
  assert.equal(one('ASL2300F UNDERSTANDING LANGUAGE – MEANING AND STRUCTURE A 20 NQF credits at NQF level 6 Convener: TBA Course outline: x')?.code, 'ASL2300F');
  // a bare code in front of the heading, and a page header caught in the title
  assert.equal(one('MAM4000W MAM4001W APPLIED MATHEMATICS HONOURS Since the code will not carry credits. 160 NQF credits at NQF level 8; Convener: Dr F E Course outline: x')?.code, 'MAM4001W');
  assert.equal(one('CIV4045F STRUCTURAL DESIGN II DEPARTMENTS IN THE FACULTY AND COURSES OFFERED 114 18 NQF credits at NQF level 8 Convener: Professor P Moyo Course outline: x')?.title, 'Structural Design II');
  const off = one('CML4503F COPYRIGHT & PATENTS (not offered in 2026) Final Level, half course. 9 NQF credits at NQF level 8 Convener: A B Course outline: x');
  assert.equal(off.title, 'Copyright & Patents');
  assert.equal(off.notOffered, 2026);
  // a programme table is not a course
  assert.deepEqual(parseHandbook('CSC1016S CB004/ CB024 Economics By end of year 1 ECO1010 at least 120 credits at NQF level 7'), []);
});

test('curriculum tables: courses with no description, and replaced codes', () => {
  const described = new Map(['MAM1031F', 'MAM1032S', 'PSY1009F', 'PSY1010S'].map((code) => [code, { code, title: 'x' }]));
  const { tableOnly, replaced } = scanTables([
    'Either MAM1000W or both MAM1031F and MAM1032S',
    'PHI2043S Business Ethics ............................ 18 6 PSY1010S Introduction to Psychology Part 2 (or PSY1005S if taken before 2026).......... 15',
    'Entry: PSY1009F (previously PSY1004F). ECO5066W Minor Dissertation ......... 120 9 (a) MUZ1322F (b) MUZ1201H Course NQF Credits African Music I ....... 15',
  ], described);
  assert.deepEqual(replaced, { MAM1000W: ['MAM1031F', 'MAM1032S'], PSY1004F: ['PSY1009F'], PSY1005S: ['PSY1010S'] });
  assert.deepEqual(tableOnly.map((c) => [c.code, c.title, c.credits, c.nqf]), [['PHI2043S', 'Business Ethics', 18, 6]], 'no dissertations, broken rows or postgrad');
});

test('majors: required courses per year, with the handbook\'s choices', () => {
  const credits = { STA3047S: 6, STA3048S: 30, STA3022F: 36, STA3036S: 36, MAM2012S: 12, MAM2013S: 12, MAM2014S: 12, MAM2040F: 12 };
  const text = [
    'Major in Statistics & Data Science', '[STA13]', 'First Year Core Courses', 'Code', 'Either', '...........',
    'MAM1000W Mathematics 1000 ............ 36', 'Or both', '..........', 'MAM1031F Mathematics 1031 ........ 18', 'and',
    'MAM1032S Mathematics 1032 ........ 18', 'CSC1015F/S Computer Science 1015 ......... 18',
    'Second Year Core Courses', 'STA2004F Statistical Theory ...... 24', 'or', 'STA2030S Statistical Theory ...... 24',
    'And two of', 'MAM2012S Differential Equations ... 12', 'MAM2013S Introductory Algebra ... 12', 'MAM2014S Real Analysis ... 12',
    'and', 'MAM2040F Ordinary Differential Equations ... 12', 'Recommended:', 'MAM2041F Numerical Analysis ... 12',
    'Third Year Core Courses', 'One of:', 'STA3022F Applied Multivariate ...... 36', 'STA3036S Operational Research ...... 36',
    'STA3047S Introduction to Machine Learning ...... 6', 'and', 'STA3048S Statistical Modelling ...... 30',
    'Note: STA3047S and STA3048S must be taken together',
    'STA3022F APPLIED MULTIVARIATE DATA ANALYSIS 36 NQF credits at NQF level 7 Convener: X',
  ].join('\n');
  const [p] = parseProgrammes(text, 'sci', (c) => credits[c] || 18);
  const show = (y) => p.years[y - 1].groups.map((g) => `${g.pick}:${g.options.map((o) => o.join('+')).join('|')}`);
  assert.equal(p.name, 'Statistics & Data Science');
  assert.equal(p.kind, 'major');
  assert.deepEqual(show(1), ['1:MAM1000W|MAM1031F+MAM1032S', '1:CSC1015F|CSC1015S']);
  // "and" after "two of" ends the choice when the weights don't match (12 + 12 isn't 12)
  assert.deepEqual(show(2), ['1:STA2004F|STA2030S', '2:MAM2012S|MAM2013S|MAM2014S', '1:MAM2040F']);
  assert.deepEqual(p.years[1].recommended, ['MAM2041F']);
  // inside "One of:", "STA3047S and STA3048S" is one option because 6 + 30 = 36 like the others
  assert.deepEqual(show(3), ['1:STA3022F|STA3036S|STA3047S+STA3048S']);
  assert.equal(tidyName('BCom Economics with LAW*'), 'BCom Economics with Law');
  assert.equal(tidyName('BCom Financial ACCOUNTING: General Accounting'), 'BCom Financial Accounting: General Accounting');
});

test('department staff lists: teaching staff only, titles from the role and degrees', () => {
  const text = 'DEPARTMENT OF ASTRONOMY Professors: R Deane, MSc Cape Town DPhil Oxford P A Woudt, MSc Groningen PhD Cape Town '
    + 'Emeritus Professor: X Y Old, PhD Cantab Senior Lecturers HE Delport, B.Arch Port Elizabeth *J Franco, BA LLB UCT Attorney '
    + 'Adjunct Senior Lecturer: B Frank, PhD Cape Town Lecturer: J Delhaize, MSc Perth Administrative Officer: Q Smith, BA '
    + 'AST1000F INTRODUCTION TO ASTRONOMY 18 NQF credits at NQF level 5 AST2002S ASTROPHYSICS 24 NQF';
  assert.deepEqual(parseStaff(text).map((s) => [s.dept, s.name, s.role]), [
    ['AST', 'Professor R Deane', 'Professor'], ['AST', 'Professor P A Woudt', 'Professor'],
    ['AST', 'HE Delport', 'Senior Lecturer'], ['AST', 'J Franco', 'Senior Lecturer'], ['AST', 'J Delhaize', 'Lecturer'],
  ]);
});

test('week view: tuts and pracs from the handbook, picks, own blocks, study time, calendar file', () => {
  // tutorials and practicals
  const cem = sessionsOf('Monday to Wednesday and Friday, 2nd or 4th period. Tutorials: Thursday 2nd or 4th period. Practicals: Tuesday, Thursday or Friday, 14h00 - 17h00.');
  assert.deepEqual(cem.map((s) => [s.kind, s.choice, s.options.length]), [['tut', true, 2], ['prac', true, 3]]);
  assert.deepEqual(cem[0].options[0], { day: 'Thursday', start: '09:00', end: '09:45' });
  const csc = sessionsOf('4th or 5th period once per week, Tutorials: One per week, replacing one lecture, Practicals: One per week, Monday, Tuesday, Wednesday or Thursday 14h00 - 16h00 or 16h00 18h00');
  assert.deepEqual(csc.map((s) => [s.kind, s.options.length]), [['tut', 0], ['prac', 8]], 'a tut with no time is left for the student to place');
  assert.deepEqual(lecturePeriods('Monday to Wednesday and Friday, 2nd period').days, ['Monday', 'Tuesday', 'Wednesday', 'Friday']);

  const course = (code, extra) => ({ code, title: code, credits: 18, periods: '', days: '', period_choice: 0, sessions: '', lectures: '', ...extra });
  const courses = [
    course('CEM1000W', { credits: 36, periods: '2|4', period_choice: 1, days: 'Monday|Tuesday|Wednesday|Friday', sessions: JSON.stringify(cem) }),
    course('MAM1031F', { periods: '2', days: 'Monday|Tuesday|Wednesday|Thursday|Friday' }),
    course('STA1000F', { lectures: 'One lecture per week' }),
    course('CSC1016S', { periods: '3', days: 'Monday' }), // second semester: not in a semester 1 week
  ];
  // MAM1031F is fixed at 2nd period, so CEM1000W's lecture group is 4th; the gym on Tuesday afternoon pushes the prac to Thursday
  let w = buildWeek(courses, parseWeek({ bl: '1~1300~1800~Gym', st: '1' }), { year: 2027 });
  const at = (code, kind) => w.events.filter((e) => e.code === code && e.kind === kind).map((e) => `${e.day.slice(0, 3)} ${e.start}`);
  assert.equal(w.term, 's1');
  assert.deepEqual(at('CEM1000W', 'lecture'), ['Mon 11:00', 'Tue 11:00', 'Wed 11:00', 'Fri 11:00']);
  assert.deepEqual(at('CEM1000W', 'prac'), ['Thu 14:00']);
  assert.ok(w.events.find((e) => e.kind === 'prac').suggested);
  assert.deepEqual(w.unplaced.map((u) => `${u.code} ${u.kind}`), ['STA1000F lecture']);
  assert.ok(!w.courses.some((c) => c.code === 'CSC1016S'));
  assert.equal(w.clashes.length, 0);
  const real = w.events.filter((e) => e.kind !== 'study');
  assert.ok(w.events.filter((e) => e.kind === 'study').every((s) => !real.some((e) => e.day === s.day && e.start < s.end && s.start < e.end)), 'study time never overlaps a class or block');
  assert.equal(w.hours.weeks, 16, '8 Feb to 7 Jun 2027 minus the March vacation');

  // the student's own pick wins over the suggestion
  w = buildWeek(courses, parseWeek({ pk: 'CEM1000W.P0,CEM1000W.L2' }), { year: 2027 });
  assert.deepEqual(at('CEM1000W', 'prac'), ['Tue 14:00']);
  assert.ok(w.clashes.some(([a, b]) => [a.code, b.code].sort().join() === 'CEM1000W,MAM1031F'), 'picking 2nd period for CEM1000W clashes with MAM1031F');
  assert.deepEqual(weekParams(parseWeek({ t: 's2', pk: 'CEM1000W.P0,bad', bl: '4~0900~1000~Job,9~x', st: '1' })), { t: 's2', pk: 'CEM1000W.P0', bl: '4~0900~1000~Job', st: '1' });

  // calendar file: weekly from the first teaching day, vacation skipped, times in UTC (South Africa is UTC+2)
  const ics = icsFor([courses[1]], parseWeek({}), { year: 2027 });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART:20270208T070000Z/, 'first Monday of semester 1, 09:00 local');
  assert.match(ics, /RRULE:FREQ=WEEKLY;UNTIL=20270607T215900Z/);
  assert.match(ics, /EXDATE:20270322T070000Z,20270329T070000Z/, 'the March vacation Mondays');
  assert.ok(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75), 'lines are folded at 75 bytes');
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 5);
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
  const post = async (p, body, { csrf = true, headers = {} } = {}) => {
    if (!jar.csrf) await get('/');
    // the sign-in form's "I'm 18 or older and agree" box is ticked, like a real student would; tests can untick it
    const data = new URLSearchParams(Object.entries({ ...(p === '/login' ? { agree: '1' } : {}), ...body, ...(csrf ? { _csrf: jar.csrf } : {}) }).filter(([, v]) => v !== undefined));
    return remember(await fetch(root() + p, { method: 'POST', body: data, headers: { cookie: cookie(), ...headers }, redirect: 'manual' }));
  };
  const text = async (p) => (await get(p)).text();
  // dev mode shows the emailed link on screen; opening it shows a button, and pressing it signs you in
  const signIn = async (email) => {
    const page = await (await post('/login', { email })).text();
    const path = new URL(/href="(http[^"]+\/auth\/[a-f0-9]+)"/.exec(page)[1]).pathname;
    await get(path);
    return post(path, {});
  };
  return { get, post, text, signIn, jar };
}

test('only @myuct.ac.za emails can sign in', async () => {
  assert.equal((await browser().post('/login', { email: 'someone@gmail.com' })).status, 400);
  const unticked = await browser().post('/login', { email: 'age001@myuct.ac.za', agree: undefined });
  assert.equal(unticked.status, 400, 'signing in needs the 18+ and terms box ticked');
  assert.match(await unticked.text(), /18 or older/);
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

  const loggedOut = await anon.post(`/reviews/${id}/report`, { reason: 'defamation' });
  assert.match(loggedOut.headers.get('location'), /^\/login\?next=%2Fcourses%2FPHY1012F/, 'reporting needs a sign-in');
  assert.match(await anon.text('/courses/PHY1012F'), /Demos in lectures/, 'an anonymous report hides nothing');
  const reader = browser();
  await reader.signIn('rep001@myuct.ac.za');
  assert.equal((await reader.post(`/reviews/${id}/report`, { reason: 'defamation' })).status, 303);
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

test('reports are rate limited per student', async () => {
  const b = browser();
  await b.signIn('rep002@myuct.ac.za');
  const id = /id="review-(\d+)"/.exec(await b.text('/courses/EEE3099S'))[1];
  const statuses = [];
  for (let i = 0; i < 32; i++) statuses.push((await b.post(`/reviews/${id}/report`, { reason: 'spam' })).status);
  assert.ok(statuses.includes(429), `expected a 429, got ${statuses}`);
});

test('TRUST_PROXY from the environment is a hop count, not an address list', () => {
  const trust = (v) => createApp(openDb(':memory:'), { trustProxy: v }).get('trust proxy');
  assert.equal(trust('1'), 1);
  assert.equal(trust('0'), 0);
  assert.equal(trust('loopback'), 'loopback');
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
  const prod = createApp(db, { devMode: false, baseUrl: 'https://lekker.example', sendLoginEmail: async (to, { link, code }) => sent.push({ to, link, code }) }).listen(0);
  await new Promise((r) => prod.once('listening', r));
  const b = browser(() => `http://localhost:${prod.address().port}`);
  const page = await (await b.post('/login', { email: 'ghi001@myuct.ac.za' })).text();
  assert.equal(sent.length, 1);
  assert.match(sent[0].link, /^https:\/\/lekker\.example\/auth\/[a-f0-9]{64}$/);
  assert.match(sent[0].code, /^\d{6}$/);
  assert.doesNotMatch(page, /\/auth\//, 'link is not shown on the page');
  assert.ok(!page.includes(sent[0].code), 'code is not shown on the page');
  prod.close();
});

test('demo with an email service set up sends real emails and shows nothing on screen', async (t) => {
  const sent = [];
  const db = openDb(':memory:');
  seed(db, { samples: false });
  const demo = createApp(db, { devMode: true, baseUrl: 'https://demo.example', sendLoginEmail: async (to, d) => sent.push(d) }).listen(0);
  t.after(() => demo.close());
  await new Promise((r) => demo.once('listening', r));
  const b = browser(() => `http://localhost:${demo.address().port}`);
  const page = await (await b.post('/login', { email: 'dem001@myuct.ac.za' })).text();
  assert.equal(sent.length, 1);
  assert.doesNotMatch(page, /\/auth\/|class="card dev"/);
});

test('launch safety: one live code per address, guess cap across IPs, daily email cap, report and takedown abuse', async (t) => {
  const sent = [];
  const db = openDb(':memory:');
  seed(db, { samples: true });
  const app = createApp(db, { devMode: true, trustProxy: '1', baseUrl: 'https://kwaai.example', emailDailyCap: 3, moderators: new Set(['mod009@myuct.ac.za']), sendLoginEmail: async (to, d) => sent.push(d) }).listen(0);
  t.after(() => app.close());
  await new Promise((r) => app.once('listening', r));
  const root = () => `http://localhost:${app.address().port}`;

  // asking again replaces the code: the first email's code stops working, its link doesn't
  const b = browser(root);
  await b.post('/login', { email: 'one001@myuct.ac.za' });
  await b.post('/login', { email: 'one001@myuct.ac.za' });
  const [first, second] = sent;
  assert.equal((await b.post('/login/code', { email: 'one001@myuct.ac.za', code: first.code === second.code ? '999999' : first.code })).status, 400, 'old code is dead');
  const firstPath = new URL(first.link).pathname;
  assert.equal((await browser(root).get(firstPath)).status, 200, 'old link still works');
  assert.equal((await b.post('/login/code', { email: 'one001@myuct.ac.za', code: second.code })).status, 303);

  // 20 wrong guesses an hour per address across every IP; then codes pause but the link still signs you in
  const victim = browser(root);
  await victim.post('/login', { email: 'vic001@myuct.ac.za' });
  const real = sent.at(-1);
  const wrong = real.code === '000000' ? '111111' : '000000';
  const statuses = [];
  // each guess from a different IP, so only the per-address cap can stop them
  const from = (i) => ({ headers: { 'x-forwarded-for': `10.0.${Math.floor(i / 250)}.${i % 250}` } });
  for (let i = 0; i < 21; i++) statuses.push((await browser(root).post('/login/code', { email: 'vic001@myuct.ac.za', code: wrong }, from(i))).status);
  assert.deepEqual([statuses.slice(0, 20).every((s) => s === 400), statuses[20]], [true, 429], String(statuses));
  const paused = await browser(root).post('/login/code', { email: 'vic001@myuct.ac.za', code: real.code }, from(99));
  assert.match(await paused.text(), /Use the &quot;Sign in to Kwaai&quot; button|Use the "Sign in to Kwaai" button/);
  const linkPath = new URL(real.link).pathname;
  await victim.get(linkPath);
  assert.equal((await victim.post(linkPath, {})).status, 303, 'the link still signs the student in');

  // the daily cap (3 here, 280 by default) stops sending with a clear message
  const capped = await browser(root).post('/login', { email: 'cap001@myuct.ac.za' });
  assert.equal(capped.status, 503);
  assert.match(await capped.text(), /today&#39;s limit|today's limit/);
  assert.equal(sent.length, 3);

  // three instant hides a day per student, then serious reports wait for a second reporter
  const ids = db.prepare(`SELECT id FROM reviews WHERE status = 'published' ORDER BY id LIMIT 5`).all().map((r) => r.id);
  const reporter = browser(root);
  db.prepare(`INSERT INTO users (email) VALUES ('rep001@myuct.ac.za')`).run();
  const uid = db.prepare(`SELECT id FROM users WHERE email = 'rep001@myuct.ac.za'`).get().id;
  const sid = 'ab'.repeat(32); // a session made directly, since today's emails are used up
  db.prepare(`INSERT INTO sessions (hash, user_id, expires) VALUES (?, ?, ?)`).run(require('node:crypto').createHash('sha256').update(sid).digest('hex'), uid, Date.now() + 3_600_000);
  reporter.jar.sid = sid;
  for (const id of ids.slice(0, 4)) await reporter.post(`/reviews/${id}/report`, { reason: 'defamation' });
  const status = (id) => db.prepare('SELECT status FROM reviews WHERE id = ?').get(id).status;
  assert.deepEqual(ids.slice(0, 4).map(status), ['held', 'held', 'held', 'published']);

  // once a moderator puts a review back, a takedown request doesn't hide it again
  db.prepare(`INSERT INTO mod_log (review_id, action, moderator) VALUES (?, 'approve', 'mod009@myuct.ac.za')`).run(ids[4]);
  const td = await browser(root).post('/takedown', { review_id: String(ids[4]), name: 'A Person', email: 'a@example.com', details: 'Please remove' });
  assert.match(await td.text(), /A moderator will look at your request/);
  assert.equal(status(ids[4]), 'published');
});

test('sign in with the emailed code, back to the page you came from', async () => {
  const b = browser();
  const page = await (await b.post('/login', { email: 'cod001@myuct.ac.za', next: '/courses/CSC1015F#verdict' })).text();
  const code = /Code: <strong>(\d{6})<\/strong>/.exec(page)[1];
  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal((await b.post('/login/code', { email: 'cod001@myuct.ac.za', code: wrong })).status, 400);
  const res = await b.post('/login/code', { email: 'cod001@myuct.ac.za', code: code.slice(0, 3) + ' ' + code.slice(3) });
  assert.equal(res.headers.get('location'), '/courses/CSC1015F#verdict');
  assert.match(await b.text('/account'), /cod001@myuct\.ac\.za|My reviews/);
  assert.equal((await b.post('/login/code', { email: 'cod001@myuct.ac.za', code })).status, 400, 'a code works once');

  // somewhere off-site is never a place to go back to
  const other = browser();
  const p2 = await (await other.post('/login', { email: 'cod002@myuct.ac.za', next: '//evil.example' })).text();
  const c2 = /Code: <strong>(\d{6})<\/strong>/.exec(p2)[1];
  assert.equal((await other.post('/login/code', { email: 'cod002@myuct.ac.za', code: c2 })).headers.get('location'), '/');
});

test('wrong guesses are capped per IP and never burn the real code, and opening the link alone does not sign you in', async () => {
  const b = browser();
  const page = await (await b.post('/login', { email: 'cod003@myuct.ac.za' })).text();
  const code = /Code: <strong>(\d{6})<\/strong>/.exec(page)[1];
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 6; i++) assert.equal((await b.post('/login/code', { email: 'cod003@myuct.ac.za', code: wrong })).status, 400);
  assert.equal((await b.post('/login/code', { email: 'cod003@myuct.ac.za', code })).status, 303, "someone else's wrong guesses don't kill the right code");

  const guesser = browser();
  await guesser.post('/login', { email: 'cod005@myuct.ac.za' });
  const statuses = [];
  for (let i = 0; i < 10; i++) statuses.push((await guesser.post('/login/code', { email: 'cod005@myuct.ac.za', code: '000000' })).status);
  assert.equal(statuses.at(-1), 429, `guessing is capped: ${statuses}`);

  const scanner = browser();
  const p2 = await (await scanner.post('/login', { email: 'cod004@myuct.ac.za' })).text();
  const path = new URL(/href="(http[^"]+\/auth\/[a-f0-9]+)"/.exec(p2)[1]).pathname;
  const first = await scanner.get(path); // what a mail scanner does
  assert.equal(first.status, 200);
  assert.ok(!(first.headers.get('set-cookie') || '').includes('sid='), 'opening the link sets no session');
  assert.match(await (await scanner.get(path)).text(), /signing in as <strong>cod004@myuct\.ac\.za/, 'the link still works after being opened');
  assert.equal((await scanner.post(path, {})).status, 303);
});

test('mangled plan and csrf values give a normal page, not a crash', async () => {
  const b = browser();
  await b.get('/');
  const plan = await fetch(`${base}/plan`, { headers: { cookie: 'plan=%E0%A4%A' }, redirect: 'manual' });
  assert.equal(plan.status, 200);
  // 16 two-byte characters: 32 characters long, 48 bytes
  const res = await fetch(`${base}/takedown`, { method: 'POST', redirect: 'manual', headers: { cookie: `csrf=${b.jar.csrf}`, 'content-type': 'application/x-www-form-urlencoded' }, body: `_csrf=${encodeURIComponent('é'.repeat(32))}` });
  assert.equal(res.status, 403);
});

test('plus-addresses are the same student, so they get one vote', async (t) => {
  const db = openDb(':memory:');
  seed(db, { samples: false });
  const own = createApp(db, { devMode: true, moderators: new Set(['Mod+x@myuct.ac.za']) }).listen(0);
  t.after(() => own.close());
  await new Promise((r) => own.once('listening', r));
  const fresh = () => browser(() => `http://localhost:${own.address().port}`);
  const year = String(new Date().getFullYear());
  const one = fresh();
  await one.signIn('plu001+one@myuct.ac.za');
  const two = fresh();
  await two.signIn('plu001+two@myuct.ac.za');
  await one.post('/courses/CSC2001F/verdict', { lekker: '1', year });
  await two.post('/courses/CSC2001F/verdict', { lekker: '0', year });
  assert.match(await fresh().text('/courses/CSC2001F'), /1 vote so far/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1);
  const mod = fresh();
  await mod.signIn('mod@myuct.ac.za');
  assert.equal((await mod.get('/mod')).status, 200, 'a moderator listed with a +tag still counts');
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
  // first, download everything we hold
  const file = await student.get('/account/data');
  assert.match(file.headers.get('content-disposition'), /attachment/);
  const data = await file.json();
  assert.equal(data.account.email, 'mno001@myuct.ac.za');
  assert.ok(data.account.agreed_at, 'when they agreed to the terms is recorded');
  assert.equal(data.reviews[0].body, 'Delete-me marker review');
  assert.equal((await browser().get('/account/data')).status, 303, 'signed out: no data');
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
  assert.match((await anon.post(`/verdicts/${id}/report`, {})).headers.get('location'), /^\/login/, 'reporting needs a sign-in');
  await voters[0].post(`/verdicts/${id}/report`, {});
  assert.match(await anon.text('/courses/CSC2001F'), /Tutorials are where it clicks/, "a student can't report their own tip");
  await voters[1].post(`/verdicts/${id}/report`, {});
  await voters[1].post(`/verdicts/${id}/report`, {});
  assert.match(await anon.text('/courses/CSC2001F'), /Tutorials are where it clicks/, 'one student reporting twice counts once');
  await voters[2].post(`/verdicts/${id}/report`, {});
  assert.doesNotMatch(await anon.text('/courses/CSC2001F'), /Tutorials are where it clicks/, 'two different students hide the tip');
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

test('a held tip stays held when resubmitted, and a removed vote cannot be deleted and recast', async (t) => {
  const db = openDb(':memory:');
  seed(db, { samples: false });
  const own = createApp(db, { moderators: new Set(['mod001@myuct.ac.za']), devMode: true }).listen(0);
  t.after(() => own.close());
  await new Promise((r) => own.once('listening', r));
  const fresh = () => browser(() => `http://localhost:${own.address().port}`);
  const year = String(new Date().getFullYear());
  const author = fresh();
  await author.signIn('stk001@myuct.ac.za');
  const vote = { lekker: '1', year, tip: 'Sticky tip text' };
  await author.post('/courses/CSC2002S/verdict', vote);
  const anon = fresh();
  const id = /\/verdicts\/(\d+)\/report/.exec(await anon.text('/courses/CSC2002S'))[1];
  for (const n of [1, 2]) {
    const reader = fresh();
    await reader.signIn(`stk00${n + 1}@myuct.ac.za`);
    await reader.post(`/verdicts/${id}/report`, {});
  }
  assert.doesNotMatch(await anon.text('/courses/CSC2002S'), /Sticky tip text/, 'two reports hide it');
  await author.post('/courses/CSC2002S/verdict', vote);
  assert.doesNotMatch(await anon.text('/courses/CSC2002S'), /Sticky tip text/, 'resubmitting the same words does not bring it back');

  const mod = fresh();
  await mod.signIn('mod001@myuct.ac.za');
  await mod.post(`/mod/verdicts/${id}/remove`, {});
  await author.post(`/verdicts/${id}/delete`, {});
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM verdicts WHERE id = ?').get(id).n, 1, 'a removed vote cannot be deleted');
  await author.post('/courses/CSC2002S/verdict', { lekker: '0', year });
  assert.match(await author.text('/courses/CSC2002S'), /removed your vote|can&#39;t vote on it again/, 'and cannot be cast again');
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

  // old codes add what replaced them; courses not running in 2026 are flagged
  res = await b.get('/plan?c=CSC1015F&add=mam1000w');
  assert.equal(res.headers.get('location'), '/plan?c=CSC1015F,MAM1031F,MAM1032S');
  assert.match(await b.text('/plan?c=CSC1015F,MAM1031F,MAM1032S'), /MAM1000W has been replaced by MAM1031F and MAM1032S/);
  assert.match(await b.text('/plan?c=CML4503F'), /the handbook says CML4503F is not offered in 2026/);
  assert.match(await b.text('/courses/PHI2043S'), /list PHI2043S in degree tables but don&#39;t describe it|list PHI2043S in degree tables but don't describe it/);
  // suggestions as you type: codes that start with what you typed come first
  const found = await (await b.get('/api/courses?q=csc1')).json();
  assert.ok(found.length > 3 && found.length <= 8);
  assert.ok(found.every((c) => c.code.startsWith('CSC1')), found.map((c) => c.code).join());
  assert.ok(found.some((c) => c.code === 'CSC1015F'));
  assert.deepEqual(Object.keys(found[0]).sort(), ['code', 'credits', 'dept_name', 'reviews', 'title']);
  assert.ok((await (await b.get('/api/courses?q=mathematical%20stat')).json()).some((c) => c.code === 'STA1006S'), 'title search');
  assert.deepEqual(await (await b.get('/api/courses?q=c')).json(), [], 'one letter is too short');
  assert.match(await b.text('/'), /data-suggest="go"/);
  // layered browse: faculties, then departments, then year folders
  const top = await b.text('/courses');
  assert.match(top, /layer-card/);
  assert.doesNotMatch(top, /course-card|year-folder/, 'the first layer lists faculties, not courses');
  assert.match(await b.text('/courses?faculty=ebe'), /href="\/courses\?faculty=ebe&dept=EEE"/);
  const eee = await b.text('/courses?faculty=ebe&dept=EEE');
  assert.match(eee, /<details class="year-folder" open>/);
  assert.match(eee, /2nd year/);
  assert.match(eee, /href="\/courses\/EEE3099S"/);
  assert.equal((await b.get('/courses?dept=ZZZ')).status, 404);
  assert.match(await b.text('/courses?faculty=nope'), /layer-card/, 'an unknown faculty falls back to the top');
  const sta = await b.text('/courses/STA1006S');
  assert.match(sta, /Mathematical Statistics I/);
  assert.match(sta, /Convener: <a href="\/lecturers\/\d+">S Salau<\/a>/);
  assert.match(sta, /Teaching staff in Statistical Sciences \(\d+\)/);
  assert.match(sta, /not necessarily lecturers on STA1006S/);
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

test('about you: what the major still needs, credit checks, passed courses count', async () => {
  // a 1st-year Science student planning year 2 of Statistics & Data Science
  const p = parseProfile({ f: 'sci', m: 'sci:STA13,nope:XXX99', y: '2', done: 'csc1015f, CSC1016S,MAM1031F,junk' });
  assert.deepEqual(p, { faculty: 'sci', majors: ['sci:STA13'], year: 2, done: ['CSC1015F', 'CSC1016S', 'MAM1031F'] });
  const [needs] = majorNeeds(p, ['MAM1032S', 'STA2004F']);
  const open = needs.open.map((g) => `${g.year}:${g.pick}:${g.options.map((o) => o.codes.join('+')).join('|')}`);
  assert.ok(!open.some((g) => g.startsWith('1:1:CSC1015F')), 'CSC1015F passed');
  assert.ok(open.includes('1:1:STA100xF|STA100xS'), 'any first-year STA course still needed');
  assert.ok(!open.some((g) => g.includes('STA2004F|STA2030S')), 'STA2004F planned covers the choice');
  assert.ok(open.includes('2:1:MAM2010F'));

  // Science: at most 72 credits a semester, 144 credits by the end of year 2 to re-register
  const row = (code, credits, nqf = 6) => ({ code, credits, nqf, entry: '', periods: '', days: '' });
  const planned = ['STA2004F', 'MAM2010F', 'MAM2011F', 'CSC2001F', 'XXX2001F'].map((c) => row(c, 24)).concat(row('STA2005S', 24));
  const plan = analysePlan(planned);
  const passed = [row('CSC1015F', 18, 5), row('CSC1016S', 18, 5)];
  const a = creditAdvice(p, plan, planned, passed, [needs]);
  assert.equal(a.semesters[0].over, true, '120 credits in semester 1 is over 72');
  assert.deepEqual(a.readmit, { need: 144, have: 36 + 144, unit: 'credits' });
  assert.equal(a.load, 'ok', '144 for the year is within 72 to 144; the semester split is the problem');

  // BBusSci counts semester courses and needs 528 credits
  const b = creditAdvice(parseProfile({ m: 'com:CB004STA13', y: '1' }), analysePlan([]), [], [], majorNeeds(parseProfile({ m: 'com:CB004STA13', y: '1' }), []));
  assert.equal(b.total, 528);
  assert.equal(b.readmit.unit, 'semester courses');

  // passed courses meet entry requirements; none of the mentioned courses passed or planned is flagged
  const e = analysePlan([row('CSC2001F', 24), { ...row('PHY2004W', 48), entry: 'PHY1004W and MAM1031F' }], new Set(['CSC1015F', 'CSC1016S']));
  assert.equal(e.entry.PHY2004W.noneMet, true);
  const f = analysePlan([{ ...row('CSC2001F', 24), entry: 'CSC1015F and CSC1016S' }, row('CSC1015S', 18)], new Set(['CSC1015F', 'CSC1016S']));
  assert.deepEqual(f.entry.CSC2001F.met, ['CSC1015F', 'CSC1016S']);
  assert.deepEqual(f.alreadyPassed, ['CSC1015S']);
  // "may register for MAM2010F" isn't a requirement for MAM2011F
  assert.deepEqual(analysePlan([{ ...row('MAM2011F', 12), entry: 'MAM1031F. Students with 70% for MAM1010F may register for MAM2010F.' }, row('MAM2010F', 12)]).entry.MAM2011F.tooLate, []);
  assert.deepEqual(lecturePeriods('Mondays, Thursdays and some Wednesdays in 5th period.').days, ['Monday', 'Thursday']);

  // end to end: the form saves the answers into the plan's link and the cookie
  const br = browser();
  const res = await br.get('/plan?about=1&c=STA2004F&f=sci&y=2&m1=sci:STA13&m2=&done=CSC1015F&more=csc1016s, MAM1031F');
  assert.equal(res.headers.get('location'), '/plan?c=STA2004F&f=sci&m=sci:STA13&y=2&done=CSC1015F,CSC1016S,MAM1031F');
  assert.equal((await br.get('/plan')).headers.get('location'), '/plan?c=STA2004F&f=sci&m=sci:STA13&y=2&done=CSC1015F,CSC1016S,MAM1031F', 'remembered');
  assert.equal((await br.get('/plan?c=STA2004F&f=sci&m=sci:STA13&y=2&done=CSC1015F&add=MAM2010F')).headers.get('location'), '/plan?c=STA2004F,MAM2010F&f=sci&m=sci:STA13&y=2&done=CSC1015F', 'adding keeps the answers');
  const page = await br.text('/plan?c=STA2004F&f=sci&m=sci:STA13&y=2&done=CSC1015F,CSC1016S,MAM1031F');
  assert.match(page, /2nd year · Science · Statistics &amp; Data Science · 3 courses passed/);
  assert.match(page, /you need 144 credits by the end of year 2/);
  assert.match(page, /Still needed up to 2nd year/);
  assert.match(page, /aria-label="Add MAM1032S to the plan"/);
  assert.match(page, /name="done" value="CSC1015F" checked/, 'first-year courses of the major can be ticked off');
  assert.equal((await br.get('/plan?c=STA2004F&about=clear')).headers.get('location'), '/plan?c=STA2004F');
});

test('week view end to end: pick a group, add a block, subscribe, the calendar follows the plan, delete it', async () => {
  const b = browser();
  let res = await b.get('/week?c=CEM1000W,MAM1031F&pick=CEM1000W.P&opt=2');
  assert.equal(res.headers.get('location'), '/week?c=CEM1000W,MAM1031F&pk=CEM1000W.P2');
  res = await b.get('/week?c=CEM1000W,MAM1031F&pk=CEM1000W.P2&add_block=1&day=1&start=16:00&end=18:00&label=Soccer!');
  assert.equal(res.headers.get('location'), '/week?c=CEM1000W,MAM1031F&pk=CEM1000W.P2&bl=1~1600~1800~Soccer');
  assert.equal((await b.get('/week?c=CEM1000W,MAM1031F&pk=CEM1000W.P2&bl=1~1600~1800~Soccer&add_block=1&day=1&start=18:00&end=16:00')).status, 303, 'a backwards time is refused with a message');
  assert.equal((await b.get('/week')).headers.get('location'), '/week?c=CEM1000W,MAM1031F&pk=CEM1000W.P2&bl=1~1600~1800~Soccer', 'the week is remembered');
  const page = await b.text('/week?c=CEM1000W,MAM1031F&pk=CEM1000W.P2&bl=1~1600~1800~Soccer');
  assert.match(page, /About \d+ hours of work a week/);
  assert.match(page, /Pick your groups/);
  assert.match(page, /Fri 14:00–17:00/);
  assert.match(page, /Soccer/);
  assert.match(await b.text('/plan?c=CEM1000W'), /href="\/week\?c=CEM1000W"/, 'the planner links to the week');

  // subscribe: a random link that serves the year and follows changes to this device's plan
  assert.equal((await b.post('/week/subscribe', {})).status, 303);
  const withLink = await b.text('/week?c=CEM1000W,MAM1031F&pk=CEM1000W.P2&bl=1~1600~1800~Soccer');
  const calUrl = /value="(http[^"]+\/cal\/[A-Za-z0-9_-]{22}\.ics)"/.exec(withLink)[1];
  assert.match(withLink, /calendar\.google\.com\/calendar\/render\?cid=webcal/);
  const cal = await (await fetch(calUrl)).text();
  assert.match(cal, /SUMMARY:CEM1000W practical/);
  assert.match(cal, /SUMMARY:Soccer/);
  assert.doesNotMatch(cal, /STA1006S/);
  await b.get('/plan?c=CEM1000W,MAM1031F&pk=CEM1000W.P2&bl=1~1600~1800~Soccer&add=STA1006S');
  assert.match(await (await fetch(calUrl)).text(), /SUMMARY:STA1006S lecture/, 'adding a course updates the subscribed calendar');
  assert.equal((await b.post('/week/unsubscribe', {})).status, 303);
  assert.equal((await fetch(calUrl)).status, 404);
  assert.equal((await fetch(`${base}/cal/nope.ics`)).status, 404);
  const ics = await fetch(`${base}/week.ics?c=MAM1031F`);
  assert.match(ics.headers.get('content-type'), /text\/calendar/);
  assert.match(await b.text('/week?c='), /Your plan is empty/);
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

test('home page offers the two paths: rate a course and plan a semester', async () => {
  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /Rate it kwaai or nah/);
  assert.match(home, /href="\/plan"[^>]*>[\s\S]*?Plan your semesters/);
  assert.match(home, /href="\/login\?next=%2Fcourses"/, 'signed out, rating starts with sign-in and comes back to courses');
});

test('privacy, terms and about pages render, and every page says who makes Kwaai', async () => {
  for (const p of ['/privacy', '/terms', '/about']) assert.equal((await fetch(base + p)).status, 200, p);
  const about = await (await fetch(`${base}/about`)).text();
  assert.match(about, /<a href="https:\/\/ubayd\.me">Ubayd Hattas<\/a>/);
  assert.match(about, /<a href="https:\/\/jaswin\.me">Jaswin Chinthala<\/a>/);
  assert.match(about, /RateMyProfessors/);
  const home = await (await fetch(`${base}/`)).text();
  assert.match(home, /made by two UCT students/);
  assert.match(home, /isn't affiliated with, endorsed by or run by any university/, 'the disclaimer stays');
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

test('re-seeding after a handbook update keeps students\' reviews and votes', () => {
  const db = openDb(':memory:');
  seed(db, { samples: true });
  db.prepare(`INSERT INTO users (email) VALUES ('keep001@myuct.ac.za')`).run();
  const uid = db.prepare(`SELECT id FROM users WHERE email = 'keep001@myuct.ac.za'`).get().id;
  db.prepare(`INSERT INTO reviews (user_id, course, year, teaching, engagement, exams, support, difficulty, workload, overall, tags, body, is_sample)
    VALUES (?, 'CSC1015F', 2026, 4, 4, 4, 4, 3, 3, 4, '', 'A real review that must survive.', 0)`).run(uid);
  seed(db, { samples: true });
  seed(db, { samples: false });
  const n = (sql) => db.prepare(sql).get().n;
  assert.equal(n(`SELECT COUNT(*) AS n FROM reviews WHERE is_sample = 0`), 1);
  assert.equal(n(`SELECT COUNT(*) AS n FROM reviews WHERE body = 'A real review that must survive.'`), 1);
  assert.equal(n(`SELECT COUNT(*) AS n FROM reviews WHERE is_sample = 1`), 0, 'a production re-seed drops the samples');
});
