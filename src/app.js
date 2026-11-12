const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const zlib = require('node:zlib');
const express = require('express');
const views = require('./views');
const { RANKINGS, MIN_FOR_RANKING, PLAN_MAX, parseReviewForm, parseVerdictForm } = require('./ratings');
const { analysePlan, REPLACED, parseProfile, hasProfile, profileParams, majorNeeds, creditAdvice, programmeOptions, facultyOptions, FACULTIES, PROGRAMMES, ordinal } = require('./planner');
const { parseWeek, weekParams, buildWeek, icsFor, DAYS, termDates, planYear, semesterWeeks, TERMS } = require('./week');
const Marks = require('../public/marks-math');
const { revisionPlan, yearTimeline } = require('./year');
const { parseFact, screenFact, groupFacts, weekTopics, crowdSlots } = require('./facts');
const { screenComment, REPORT_REASONS, HIDE_AFTER_REPORTS } = require('./moderation');
const { UNIVERSITIES, CURRENT, accountFor } = require('./universities');
const Study = require('./study');
const Ranks = require('./ranks');
const Quests = require('./quests');
const Admin = require('./admin');
const TestData = require('./testdata');
const Classes = require('./classes');

// a plain address; accountFor then decides whether it's a UCT student (@myuct.ac.za) or staff (@uct.ac.za) one
const EMAIL_SHAPE = /^[a-z0-9._%+-]+@[a-z0-9.-]+$/;
// "a+1@myuct.ac.za" and "a+2@myuct.ac.za" reach the same inbox, so they must be the same account:
// otherwise one student gets many votes and a banned one comes back.
const normEmail = (s) => String(s || '').trim().toLowerCase().replace(/\+[^@]*(?=@)/, '');
const TOKEN_TTL = 15 * 60 * 1000;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const parseFlash = (v) => { try { return v ? JSON.parse(decodeURIComponent(v)) : null; } catch { return null; } };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const STATS = `COUNT(*) AS n, AVG(overall) AS overall, AVG(teaching) AS teaching, AVG(engagement) AS engagement,
  AVG(exams) AS exams, AVG(support) AS support, AVG(difficulty) AS difficulty, AVG(workload) AS workload, MAX(is_sample) AS has_sample`;
const REVIEW_COLS = `r.*, l.name AS lecturer_name`;
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

function createApp(db, { moderators = new Set(), devMode = true, sendLoginEmail, baseUrl, trustProxy, contactEmail, operator = 'Ubayd Hattas and Jaswin Chinthala', informationOfficer = operator, demoPassword, emailDailyCap = 280, adminUsername = 'kwaai', adminPasswordHash, testTools = false } = {}) {
  const app = express();
  const mods = new Set([...moderators].map(normEmail));
  app.disable('x-powered-by');
  // so req.ip is the student's IP behind a host's proxy. Env vars are strings, and Express reads the string "1" as an
  // IP list rather than a hop count, so a plain number must be turned into a Number.
  if (trustProxy) app.set('trust proxy', /^\d+$/.test(String(trustProxy)) ? Number(trustProxy) : trustProxy);
  // Private demos: with DEMO_PASSWORD set, the browser asks for it before showing any page (any username works).
  if (demoPassword) {
    const want = sha(demoPassword);
    app.use((req, res, next) => {
      const sent = Buffer.from(/^Basic (.+)$/.exec(req.headers.authorization || '')?.[1] || '', 'base64').toString().split(':').slice(1).join(':');
      if (crypto.timingSafeEqual(Buffer.from(sha(sent)), Buffer.from(want))) return next();
      res.set('WWW-Authenticate', 'Basic realm="Kwaai demo"').status(401).send('This Kwaai demo is private. Ask the team for the password.');
    });
  }
  app.use((req, res, next) => {
    res.set({ 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
    if (!devMode) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  // Our own CSS and JS, gzipped (a fifth of the size on mobile data). Each file is compressed once and kept until it
  // changes on disk. Everything else, and browsers that don't take gzip, fall through to the static server below.
  const GZIP_TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json' };
  const gzipped = new Map();
  app.use((req, res, next) => {
    const type = GZIP_TYPES[path.extname(req.path)];
    if (req.method !== 'GET' || !type || req.path.includes('..') || !/gzip/.test(req.headers['accept-encoding'] || '')) return next();
    const publicDir = path.join(__dirname, '..', 'public');
    const file = path.join(publicDir, req.path);
    if (!file.startsWith(publicDir + path.sep)) return next();
    let stat;
    try { stat = fs.statSync(file); } catch { return next(); }
    const tag = `"${stat.size.toString(36)}-${stat.mtimeMs.toString(36)}-gz"`;
    let hit = gzipped.get(file);
    if (!hit || hit.tag !== tag) gzipped.set(file, (hit = { tag, body: zlib.gzipSync(fs.readFileSync(file)) }));
    res.set({ 'Content-Type': type, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', ETag: tag, 'Cache-Control': req.path === '/sw.js' ? 'no-cache' : 'public, max-age=3600' });
    if (req.headers['if-none-match'] === tag) return res.status(304).end();
    res.send(hit.body);
  });
  // an hour of caching: the files aren't fingerprinted, so a longer cache would show old styles after a deploy
  // the service worker is checked on every visit so an update reaches installed copies straight away
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h', setHeaders: (res, file) => { if (file.endsWith('sw.js')) res.setHeader('Cache-Control', 'no-cache'); } }));
  app.use(express.urlencoded({ extended: false, limit: '20kb' }));
  app.use((req, res, next) => { req.body ??= {}; next(); }); // Express 5 leaves it undefined for empty POSTs

  const q = (sql) => db.prepare(sql);
  const depts = () => q(`SELECT d.code, d.name, COUNT(c.code) AS courses FROM departments d JOIN courses c ON c.dept = d.code GROUP BY d.code ORDER BY d.name`).all();

  // ---- session ----
  app.use((req, res, next) => {
    const sid = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
    if (sid) {
      req.user = q(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ? AND s.expires > ? AND u.banned = 0`).get(sha(sid), Date.now());
    }
    const flash = /(?:^|;\s*)flash=([^;]+)/.exec(req.headers.cookie || '')?.[1];
    if (flash) res.clearCookie('flash');
    req.ctx = { user: req.user, isMod: !!req.user && (mods.has(req.user.email) || !!req.user.is_admin), isAdmin: !!req.user?.is_admin, testTools, flash: parseFlash(flash), uni: CURRENT, here: req.path,
      // origin for share links and link previews; production always has BASE_URL
      site: { contactEmail, operator, informationOfficer, origin: baseUrl || `${req.protocol}://${req.get('host')}` } };
    // CSRF: double-submit token, added to every POST form on its way out
    let csrf = /(?:^|;\s*)csrf=([a-f0-9]{32})/.exec(req.headers.cookie || '')?.[1];
    if (!csrf) {
      csrf = crypto.randomBytes(16).toString('hex');
      res.cookie('csrf', csrf, { httpOnly: true, sameSite: 'lax', secure: !devMode });
    }
    req.ctx.csrf = csrf;
    res.page = (page) => {
      const body = String(page).replace(/<form method="post"([^>]*)>/g, `<form method="post"$1><input type="hidden" name="_csrf" value="${csrf}">`);
      res.vary('Accept-Encoding');
      // pages are 5-45 KB of repetitive HTML; gzip cuts them to a fifth, which matters on student mobile data
      const canGzip = body.length >= 1024 && /gzip/.test(req.headers['accept-encoding'] || '');
      if (!canGzip) return res.send(body);
      res.set('Content-Encoding', 'gzip').type('html').send(zlib.gzipSync(body));
    };
    next();
  });
  app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    // compare bytes, not characters: a multi-byte value of the right length would make timingSafeEqual throw
    const sent = Buffer.from(String(req.body._csrf || ''));
    const want = Buffer.from(req.ctx.csrf);
    if (sent.length === want.length && crypto.timingSafeEqual(sent, want)) return next();
    res.status(403).page(views.message(req.ctx, { title: 'Form expired', emoji: '🔄', text: 'Please go back, refresh the page and try again.' }));
  });

  // shortcut: in-memory counters, fine for one server process; move them to SQLite or Redis if you ever run several
  function limit(max, windowMs, keyOf = (req) => req.ip, text = 'Too many requests from you. Please wait a while and try again.') {
    const hits = new Map();
    return (req, res, next) => {
      const now = Date.now();
      const key = keyOf(req);
      let h = hits.get(key);
      if (!h || h.reset < now) hits.set(key, (h = { n: 0, reset: now + windowMs }));
      if (hits.size > 50_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      if (++h.n > max) return res.status(429).page(views.message(req.ctx, { title: 'Slow down', emoji: '🐢', text }));
      next();
    };
  }
  const MIN = 60_000;
  // Campus Wi-Fi and mobile networks put many students behind one IP, so signed-in actions are limited per account
  // and per-IP limits stay generous. Anonymous reports and takedowns can only be limited per IP.
  const byUser = (req) => `user:${req.user.id}`;
  const limits = {
    login: limit(100, 15 * MIN),
    // keyed by IP too, so a stranger using up an address's quota can't stop that student signing in
    loginEmail: limit(3, 15 * MIN, (req) => `${req.ip}|${normEmail(req.body.email)}`), // stops someone spamming a student's inbox
    loginCode: limit(8, 15 * MIN, (req) => `${req.ip}|${normEmail(req.body.email)}`), // caps guesses at the 6-digit code
    // and across all IPs: with only the newest code valid, that's 20 guesses an hour at one in a million. Going over
    // only pauses codes for that address; the link in the email still works, so nobody can be locked out.
    loginCodeEmail: limit(20, 60 * MIN, (req) => `code:${normEmail(req.body.email)}`, 'Too many codes have been tried for this address. Use the "Sign in to Kwaai" button in the email instead, or try a code again in an hour.'),
    // sign-in emails per IP, kept high enough for a computer lab or residence Wi-Fi. It guards the email quota and
    // inboxes, so it only counts when an email really goes out (not when dev mode shows the code on screen).
    loginSend: ((sends) => (req, res, next) => (sendLoginEmail ? sends(req, res, next) : next()))(limit(30, 60 * MIN, (req) => `send:${req.ip}`)),
    review: limit(10, 60 * MIN, byUser),
    verdict: limit(30, 60 * MIN, byUser),
    suggest: limit(5, 60 * MIN, byUser),
    report: limit(30, 60 * MIN, byUser),
    takedown: limit(10, 60 * MIN),
    fact: limit(40, 60 * MIN, byUser),
    study: limit(40, 60 * MIN, byUser),
    profile: limit(20, 60 * MIN, byUser),
    group: limit(30, 60 * MIN, byUser),
    classes: limit(60, 60 * MIN, byUser),
    register: limit(2000, 60 * MIN, byUser), // taps on a register: a whole tut, many times over
    studyBeat: limit(150, 60 * MIN, byUser), // one a minute while a timer runs, with room for reloads
  };
  const flashRedirect = (res, to, type, text) => {
    res.cookie('flash', JSON.stringify({ type, text }), { httpOnly: true, sameSite: 'lax', secure: !devMode, maxAge: 60_000 });
    res.redirect(303, to);
  };
  const requireUser = (req, res, next) => (req.user ? next() : res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`));
  const requireMod = (req, res, next) => (req.ctx.isMod ? next() : res.status(404).page((notFound(req))));
  const notFound = (req) => views.message(req.ctx, { title: 'Not found', emoji: '🤷', text: "That page doesn't exist (or was removed).", link: { href: '/', label: 'Go home' } });

  // ---- browsing ----
  const courseList = (where, params, order = 'c.code', limit = 500) => q(`
    SELECT c.*, d.name AS dept_name, s.n, s.overall, s.has_sample FROM courses c JOIN departments d ON d.code = c.dept
    LEFT JOIN (SELECT course, COUNT(*) AS n, AVG(overall) AS overall, MAX(is_sample) AS has_sample FROM reviews WHERE status = 'published' GROUP BY course) s ON s.course = c.code
    ${where} ORDER BY ${order} LIMIT ${limit}`).all(...params);

  function ranking(kind, rank, dept, limit = 10) {
    const [join, key, cols, deptCol] = kind === 'course'
      ? ['JOIN courses c ON c.code = r.course JOIN departments d ON d.code = c.dept', 'c.code', 'c.code, c.title', 'c.dept']
      : ['JOIN lecturers l ON l.id = r.lecturer_id JOIN departments d ON d.code = l.dept', 'l.id', 'l.id, l.name', 'l.dept'];
    // rank.column comes from the fixed RANKINGS list, never from the request
    return q(`SELECT ${cols}, MAX(r.is_sample) AS is_sample, d.name AS dept_name, COUNT(*) AS n, AVG(r.${rank.column}) AS score FROM reviews r ${join}
      WHERE r.status = 'published' ${dept ? `AND ${deptCol} = ?` : ''}
      GROUP BY ${key} HAVING n >= ${MIN_FOR_RANKING} ORDER BY score ${rank.order}, n DESC LIMIT ${limit}`).all(...(dept ? [dept] : []));
  }

  app.get('/', (req, res) => {
    const counts = q(`SELECT (SELECT COUNT(*) FROM courses) AS courses, (SELECT COUNT(*) FROM reviews WHERE status = 'published') AS reviews,
      (SELECT COUNT(*) FROM verdicts WHERE status = 'published') AS votes, (SELECT COUNT(*) FROM verdicts WHERE status = 'published' AND tip != '') AS tips`).get();
    const byKey = (key) => RANKINGS.find((r) => r.key === key);
    const studying = liveStudents(req.user, `uni = ?`, req.user?.uni ?? CURRENT.slug);
    res.page((views.home(req.ctx, {
      counts,
      topCourses: ranking('course', byKey('best'), null, 5),
      heaviest: ranking('course', byKey('workload'), null, 5),
      // November to January: exams are done and registration hasn't opened, the best time to ask for ratings
      ratingSeason: [10, 11, 0].includes(new Date().getMonth()),
      // a returning student with a plan on this device gets a way straight into their day
      today: (() => {
        const { codes, week } = readPlan(req, {}); // the home page has no plan in its link: only this device's plan
        if (!codes.length) return null;
        const t = todayFor(codes, week);
        return { classes: t.classes.length, next: t.classes.find((e) => e.start >= new Date(Date.now() + 2 * 3_600_000).toISOString().slice(11, 16)), soon: t.upcoming[0], weekend: t.weekend };
      })(),
      streak: req.user ? streakFor(req.user.id) : null,
      rank: rankWithUp(req.user),
      studyingNow: studying >= Study.MIN_LIVE_SHOWN ? studying : 0,
      // only each course's newest tip, in the course page's order, so it's always one of the free ones there
      recentTips: q(`SELECT t.id, t.course, t.lekker, t.tip, c.title FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY course ORDER BY created_at DESC, id DESC) AS k
        FROM verdicts WHERE status = 'published' AND tip != '') t JOIN courses c ON c.code = t.course WHERE t.k = 1 ORDER BY t.created_at DESC, t.id DESC LIMIT 4`).all(),
    })));
  });

  // ---- browse: faculty -> department -> year ----
  // Which faculty a course belongs to comes from the handbook it was imported from. The curriculum-table courses
  // have no handbook of their own, so they take the faculty most of their department's courses belong to.
  const FACULTY_BY_NAME = { Commerce: 'com', EBE: 'ebe', 'Health Sciences': 'fhs', Humanities: 'hum', Law: 'law', Science: 'sci' };
  const browse = (() => {
    const rows = q('SELECT code, title, credits, nqf, dept, source FROM courses').all();
    const own = (r) => FACULTY_BY_NAME[/^UCT 2026 (.+?) (?:undergraduate |postgraduate )?handbook/.exec(r.source)?.[1]] || null;
    const tally = {};
    for (const r of rows) if (own(r)) ((tally[r.dept] ??= {})[own(r)] = (tally[r.dept][own(r)] || 0) + 1);
    const home = (d) => Object.entries(tally[d] || {}).sort((x, y) => y[1] - x[1])[0]?.[0] || null;
    const byFaculty = {};
    for (const r of rows) {
      const f = own(r) || home(r.dept);
      if (f) ((byFaculty[f] ??= {})[r.dept] ??= []).push({ ...r, faculty: f });
    }
    return byFaculty;
  })();
  const YEAR_GROUPS = [[1, '1st year'], [2, '2nd year'], [3, '3rd year'], [4, '4th year and honours'], [5, 'Postgraduate']];
  const yearOf = (code) => Math.min(5, Math.max(1, Number(code[3]) || 1));

  app.get('/courses', (req, res) => {
    const text = String(req.query.q || '').trim().slice(0, 80);
    const dept = String(req.query.dept || '').toUpperCase().slice(0, 3);
    const faculty = Object.hasOwn(browse, req.query.faculty) ? req.query.faculty : '';
    const names = Object.fromEntries(facultyOptions().map((f) => [f.key, f.name]));
    if (text) {
      const list = courseList('WHERE (c.code LIKE ? OR c.title LIKE ?)', [`%${text}%`, `%${text}%`], 's.n IS NULL, s.n DESC, c.code', 500);
      return res.page(views.courses(req.ctx, { mode: 'search', list, q: text }));
    }
    if (dept) {
      // a department can teach in several faculties; with a faculty chosen, only that faculty's courses show
      const pools = faculty ? [browse[faculty]?.[dept]] : Object.values(browse).map((f) => f[dept]);
      const all = pools.flat().filter(Boolean);
      if (!all.length) return res.status(404).page(notFound(req));
      const reviewed = new Map(q(`SELECT course, COUNT(*) AS n, AVG(overall) AS overall, MAX(is_sample) AS has_sample FROM reviews WHERE status = 'published' AND course LIKE ? GROUP BY course`).all(`${dept}%`).map((r) => [r.course, r]));
      const years = YEAR_GROUPS.map(([n, label]) => ({ n, label, list: all.filter((c) => yearOf(c.code) === n).sort((x, y) => x.code.localeCompare(y.code)).map((c) => ({ ...c, ...reviewed.get(c.code) })) })).filter((y) => y.list.length);
      const deptName = q('SELECT name FROM departments WHERE code = ?').get(dept)?.name || dept;
      return res.page(views.courses(req.ctx, { mode: 'dept', dept, deptName, faculty, facultyName: names[faculty] || '', years, total: all.length }));
    }
    if (faculty) {
      const deptNames = Object.fromEntries(depts().map((d) => [d.code, d.name]));
      const list = Object.entries(browse[faculty]).map(([code, cs]) => ({ code, name: deptNames[code] || code, courses: cs.length })).sort((x, y) => x.name.localeCompare(y.name));
      return res.page(views.courses(req.ctx, { mode: 'faculty', faculty, facultyName: names[faculty], list }));
    }
    const list = facultyOptions().filter((f) => browse[f.key]).map((f) => ({ ...f, depts: Object.keys(browse[f.key]).length, courses: Object.values(browse[f.key]).flat().length }));
    res.page(views.courses(req.ctx, { mode: 'faculties', list, popular: courseList('WHERE s.n > 0', [], 's.n DESC, c.code', 6) }));
  });

  // Suggestions as you type in a course search box (public/app.js). Codes that start with what you typed come
  // first ("csc1" -> CSC1010H, CSC1015F, ...), then undergraduate courses, then title matches.
  app.get('/api/courses', (req, res) => {
    const text = String(req.query.q || '').trim().slice(0, 60);
    const squashed = text.replace(/\s+/g, '').toUpperCase();
    if (text.length < 2) return res.json([]);
    const rows = q(`SELECT c.code, c.title, c.credits, d.name AS dept_name, (SELECT COUNT(*) FROM reviews r WHERE r.course = c.code AND r.status = 'published') AS reviews
      FROM courses c JOIN departments d ON d.code = c.dept
      WHERE c.code LIKE ? OR c.title LIKE ?
      ORDER BY (c.code LIKE ?) DESC, (c.nqf IS NULL OR c.nqf <= 7) DESC, (c.title LIKE ?) DESC, c.code LIMIT 8`)
      .all(`%${squashed}%`, `%${text}%`, `${squashed}%`, `${text}%`);
    res.set('Cache-Control', 'private, max-age=60').json(rows);
  });

  // Has this reader voted on or reviewed anything? If not, most comments stay hidden (see FREE_COMMENTS).
  const canReadAll = (req) => req.ctx.isMod || (!!req.user && !!q(`SELECT 1 FROM verdicts WHERE user_id = ? AND status != 'removed'
    UNION ALL SELECT 1 FROM reviews WHERE user_id = ? AND status != 'removed' LIMIT 1`).get(req.user.id, req.user.id));
  const verdictStats = (code) => q(`SELECT COUNT(*) AS n, COALESCE(SUM(lekker), 0) AS lekker FROM verdicts WHERE course = ? AND status = 'published'`).get(code);
  const getCourse = (code) => q(`SELECT c.*, d.name AS dept_name FROM courses c JOIN departments d ON d.code = c.dept WHERE c.code = ?`).get(String(code).toUpperCase());

  app.get('/courses/:code', (req, res) => {
    const c = getCourse(req.params.code);
    if (!c) return res.status(404).page((notFound(req)));
    const stats = q(`SELECT ${STATS} FROM reviews WHERE course = ? AND status = 'published'`).get(c.code);
    const offerings = q(`SELECT r.lecturer_id, l.name AS lecturer_name, r.year, COUNT(*) AS n, AVG(r.overall) AS overall FROM reviews r LEFT JOIN lecturers l ON l.id = r.lecturer_id
      WHERE r.course = ? AND r.status = 'published' GROUP BY r.lecturer_id, r.year ORDER BY r.year DESC, n DESC`).all(c.code);
    const reviews = q(`SELECT ${REVIEW_COLS} FROM reviews r LEFT JOIN lecturers l ON l.id = r.lecturer_id WHERE r.course = ? AND r.status = 'published' ORDER BY r.created_at DESC, r.id DESC`).all(c.code);
    const tagCounts = {};
    for (const r of reviews) for (const t of r.tags.split('|').filter(Boolean)) tagCounts[t] = (tagCounts[t] || 0) + 1;
    const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const myHeld = req.user && q(`SELECT 1 FROM reviews WHERE course = ? AND user_id = ? AND status = 'held'`).get(c.code, req.user.id);
    const votes = verdictStats(c.code);
    const tips = q(`SELECT id, year, lekker, tip, created_at FROM verdicts WHERE course = ? AND status = 'published' AND tip != '' ORDER BY created_at DESC, id DESC LIMIT 30`).all(c.code);
    const myVerdict = req.user && q(`SELECT * FROM verdicts WHERE course = ? AND user_id = ?`).get(c.code, req.user.id);
    // the convener is the handbook's link between a person and this course; the rest of the department's teaching
    // staff are listed as "in the department", never as teaching this course
    const inDept = q(`SELECT id, name, role FROM lecturers WHERE dept = ? AND is_sample = 0 ORDER BY name`).all(c.dept);
    const convNames = c.conveners.split('|').filter(Boolean);
    const conveners = convNames.map((name) => inDept.find((l) => l.name === name) || { name });
    const RANK = { Professor: 1, 'Associate Professor': 2, 'Senior Lecturer': 3, Lecturer: 4 };
    const staff = inDept.filter((l) => l.role && !convNames.includes(l.name)).sort((a, b) => (RANK[a.role] || 9) - (RANK[b.role] || 9) || a.name.localeCompare(b.name));
    const facts = factsFor([c.code], req.user?.id)[c.code] || { lecture: [], tut: [], prac: [], topic: [], event: [] };
    let draft = [];
    try { draft = c.topics ? JSON.parse(c.topics) : []; } catch { draft = []; }
    const studying = liveStudents(req.user, `course = ?`, c.code);
    // real study time from students who time this course, next to what its credits suggest
    const today = Study.saDay(Date.now());
    const realHours = Study.courseHours(q(`SELECT user_id, day, SUM(credited_sec / 60) AS minutes FROM study_sessions
      WHERE course = ? AND status = 'done' AND day >= ? ${realOnly(req.user)} GROUP BY user_id, day`).all(c.code, Study.addDay(today, -Study.HOURS_WINDOW_DAYS)), today);
    const creditHours = Study.weeklyGoal(c, (t) => semesterWeeks(planYear(), t));
    res.page((views.course(req.ctx, { c, stats, offerings, reviews, topTags, myHeld, votes, tips, myVerdict, years: years(), locked: !canReadAll(req), conveners, staff, facts, weekTopics: weekTopics(draft, facts.topic), studyingNow: studying >= Study.MIN_LIVE_SHOWN ? studying : 0, realHours, creditHours, officialDates: classDatesFor([c.code]).filter((d) => d.date >= today) })));
  });

  app.get('/lecturers/:id', (req, res) => {
    const l = q(`SELECT l.*, d.name AS dept_name FROM lecturers l JOIN departments d ON d.code = l.dept WHERE l.id = ?`).get(Number(req.params.id) || 0);
    if (!l) return res.status(404).page((notFound(req)));
    const stats = q(`SELECT ${STATS} FROM reviews WHERE lecturer_id = ? AND status = 'published'`).get(l.id);
    const taught = q(`SELECT c.code, c.title, s.n, s.overall FROM courses c
      LEFT JOIN (SELECT course, COUNT(*) AS n, AVG(overall) AS overall FROM reviews WHERE lecturer_id = ? AND status = 'published' GROUP BY course) s ON s.course = c.code
      WHERE s.n > 0 OR ('|' || c.conveners || '|') LIKE ? ORDER BY c.code`).all(l.id, `%|${l.name}|%`);
    const reviews = q(`SELECT ${REVIEW_COLS} FROM reviews r LEFT JOIN lecturers l ON l.id = r.lecturer_id WHERE r.lecturer_id = ? AND r.status = 'published' ORDER BY r.created_at DESC, r.id DESC`).all(l.id);
    // a named person's scores shouldn't be what comes up when someone searches their name
    res.set('X-Robots-Tag', 'noindex').page((views.lecturer(req.ctx, { l, stats, courses: taught, reviews, locked: !canReadAll(req) })));
  });

  app.get('/rankings', (req, res) => {
    const rank = RANKINGS.find((r) => r.key === req.query.cat) || RANKINGS[0];
    const kind = req.query.kind === 'lecturer' ? 'lecturer' : 'course';
    const all = depts();
    const dept = all.some((d) => d.code === req.query.dept) ? req.query.dept : '';
    res.page((views.rankings(req.ctx, { rows: ranking(kind, rank, dept, 25), depts: all, dept, rank, kind })));
  });

  // ---- semester planner ----
  // The plan and the "about you" answers (faculty, majors, year, courses passed) live in the URL so they can be
  // shared, and in a cookie so they're still there next visit. Opening someone else's link only shows their plan;
  // it changes yours only once you add or remove a course or save your answers.
  const COURSE_CODE = /^[A-Z]{3}\d{4}[A-Z]$/;
  const planCodes = (s) => [...new Set(String(s || '').toUpperCase().split(/[\s,]+/).filter((x) => COURSE_CODE.test(x)))].slice(0, PLAN_MAX);
  const keepCommas = (s) => encodeURIComponent(s).replace(/%2C/g, ',').replace(/%3A/g, ':');
  // The week view's settings (semester, chosen groups, own blocks, study time) ride along in the same query string.
  const planQuery = (codes, profile = parseProfile(), week = parseWeek()) => Object.entries({ ...(codes.length && { c: codes.join(',') }), ...profileParams(profile), ...weekParams(week) })
    .map(([k, v]) => `${k}=${keepCommas(String(v))}`).join('&');
  const planUrl = (codes, profile, week, page = '/plan') => {
    const qs = planQuery(codes, profile, week);
    return qs ? `${page}?${qs}` : page;
  };
  // A subscribed calendar follows the plan saved on this device: it holds the course codes and week settings only,
  // never the "about you" answers.
  const calendarQuery = (codes, week) => planQuery(codes, parseProfile(), week);
  const savePlan = (req, res, codes, profile, week = parseWeek()) => {
    res.cookie('plan', planQuery(codes, profile, week), { httpOnly: true, sameSite: 'lax', secure: !devMode, maxAge: 180 * 24 * 60 * 60 * 1000 });
    const cal = /(?:^|;\s*)cal=([A-Za-z0-9_-]{22})/.exec(req.headers.cookie || '')?.[1];
    if (cal) q(`UPDATE calendars SET query = ? WHERE id = ?`).run(calendarQuery(codes, week), cal);
  };
  const PLAN_KEYS = ['c', 'f', 'm', 'y', 'done', 't', 'pk', 'bl', 'st', 'sr'];
  // the plan from the link if it has one, else from this device's cookie (which holds the query string; older ones
  // hold only the course codes)
  function readPlan(req, query = req.query) {
    let savedRaw = '';
    try { savedRaw = decodeURIComponent(/(?:^|;\s*)plan=([^;]*)/.exec(req.headers.cookie || '')?.[1] || ''); } catch { /* a mangled cookie is just an empty plan */ }
    const saved = savedRaw.includes('=') ? Object.fromEntries(new URLSearchParams(savedRaw)) : { c: savedRaw };
    const fromUrl = PLAN_KEYS.some((k) => query[k] != null);
    // A link with courses in it (c) is a whole plan: your own or a friend's. A link without them (a semester tab, one
    // setting) is a change to this device's plan, so the saved courses carry over.
    const state = !fromUrl ? saved : query.c != null ? query : { ...saved, ...query };
    const codes = planCodes(state.c);
    const savedCodes = planCodes(saved.c);
    // a plan link whose courses aren't this device's saved plan: the planner offers to make it yours
    const shared = fromUrl && query.c != null && codes.join() !== savedCodes.join();
    return { fromUrl, shared, codes, profile: parseProfile(state), week: parseWeek(state) };
  }

  app.get('/plan', (req, res) => {
    const saved = readPlan(req);
    const { fromUrl, week } = saved;
    let { codes, profile } = saved;
    // "Make this my plan" on a plan someone shared: save it on this device, so Week, Today and Study use it
    if (req.query.adopt != null) {
      savePlan(req, res, codes, profile, week);
      return flashRedirect(res, planUrl(codes, profile, week), 'ok', 'This is your plan now. Your week, Today and Study use it.');
    }
    // the "about you" form: majors come from two selects, passed courses from ticked boxes plus a free text box
    if (req.query.about != null) {
      profile = req.query.about === 'clear' ? parseProfile() : parseProfile({
        f: req.query.f, y: req.query.y, m: [req.query.m1, req.query.m2].filter(Boolean).join(','), done: [req.query.done ?? [], req.query.more ?? ''].flat().join(','),
      });
      savePlan(req, res, codes, profile, week);
      return res.redirect(303, planUrl(codes, profile, week));
    }
    const remove = String(req.query.remove || '').toUpperCase();
    const add = String(req.query.add || '').trim().slice(0, 80);
    if (remove) {
      codes = codes.filter((x) => x !== remove);
      savePlan(req, res, codes, profile, week);
      return res.redirect(303, planUrl(codes, profile, week));
    }
    let matches = null;
    if (add) {
      // "csc1015f", "CSC 1015F" and "csc1015" all work; a code that matches one course adds it straight away
      const squashed = add.replace(/\s+/g, '').toUpperCase();
      // an old code like MAM1000W adds the courses that replaced it
      const newer = REPLACED[squashed]?.filter((x) => !codes.includes(x));
      if (newer) {
        if (codes.length + newer.length > PLAN_MAX) return flashRedirect(res, planUrl(codes, profile, week), 'error', `A plan can hold ${PLAN_MAX} courses. Remove one first.`);
        codes.push(...newer);
        savePlan(req, res, codes, profile, week);
        return flashRedirect(res, planUrl(codes, profile, week), 'ok', `${squashed} has been replaced by ${REPLACED[squashed].join(' and ')}, so ${newer.length ? 'those are in your plan now' : 'your plan already has it covered'}.`);
      }
      const byCode = /^[A-Z]{3}\d{1,4}[A-Z]?$/.test(squashed) ? q(`SELECT code FROM courses WHERE code LIKE ? ORDER BY code LIMIT 13`).all(`${squashed}%`) : [];
      const exact = getCourse(squashed) || (byCode.length === 1 ? getCourse(byCode[0].code) : null);
      if (exact) {
        if (!codes.includes(exact.code) && codes.length >= PLAN_MAX) return flashRedirect(res, planUrl(codes, profile, week), 'error', `A plan can hold ${PLAN_MAX} courses. Remove one first.`);
        if (!codes.includes(exact.code)) codes.push(exact.code);
        savePlan(req, res, codes, profile, week);
        return res.redirect(303, planUrl(codes, profile, week));
      }
      matches = q(`SELECT code, title FROM courses WHERE code LIKE ? OR title LIKE ? ORDER BY (code LIKE ?) DESC, (nqf IS NULL OR nqf <= 7) DESC, code LIMIT 12`)
        .all(`%${squashed}%`, `%${add}%`, `${squashed}%`);
    }
    if (!fromUrl && (codes.length || hasProfile(profile)) && !matches) return res.redirect(303, planUrl(codes, profile, week));
    const rows = codes.length ? q(`SELECT c.code, c.title, c.credits, c.nqf, c.entry, c.corequisites, c.lectures, c.periods, c.period_choice, c.days, c.dp, c.assessment, c.exam_weight, c.not_offered,
      s.n, s.difficulty, s.workload, s.has_sample, v.votes, v.lekker, v.tips FROM courses c
      LEFT JOIN (SELECT course, COUNT(*) AS n, AVG(difficulty) AS difficulty, AVG(workload) AS workload, MAX(is_sample) AS has_sample FROM reviews WHERE status = 'published' GROUP BY course) s ON s.course = c.code
      LEFT JOIN (SELECT course, COUNT(*) AS votes, SUM(lekker) AS lekker, SUM(tip != '') AS tips FROM verdicts WHERE status = 'published' GROUP BY course) v ON v.course = c.code
      WHERE c.code IN (${codes.map(() => '?').join(',')})`).all(...codes) : [];
    const courses = codes.map((code) => rows.find((r) => r.code === code)).filter(Boolean);
    const plan = analysePlan(courses, new Set(profile.done));
    // about you: what the majors still need, and the credit advice
    const needs = majorNeeds(profile, courses.map((c) => c.code));
    const lookup = (list) => (list.length ? q(`SELECT code, title, credits, nqf, entry, not_offered FROM courses WHERE code IN (${list.map(() => '?').join(',')})`).all(...list) : []);
    const passed = lookup(profile.done);
    // course details for everything the majors mention; "STA100xF" stands for any matching course
    const mentioned = [...new Set(needs.flatMap((n) => n.years.flatMap((y) => y.groups.flatMap((g) => g.options.flatMap((o) => o.codes)))))];
    const wildcards = mentioned.filter((c) => c.includes('x'));
    const known = new Map(lookup(mentioned.filter((c) => !c.includes('x'))).map((c) => [c.code, c]));
    const expanded = Object.fromEntries(wildcards.map((w) => [w, q(`SELECT code, title, credits, nqf, entry, not_offered FROM courses WHERE code LIKE ? ORDER BY code`).all(w.replace(/x/g, '_'))]));
    for (const list of Object.values(expanded)) for (const c of list) known.set(c.code, c);
    const advice = creditAdvice(profile, plan, courses, passed, needs);
    res.page(views.plan(req.ctx, {
      courses, plan, matches, add, codes: courses.map((c) => c.code), shared: saved.shared,
      profile, needs, advice, known, expanded, passed, programmeOptions: programmeOptions(), facultyOptions: facultyOptions(),
      state: Object.fromEntries(new URLSearchParams(planQuery(courses.map((c) => c.code), profile, week))),
    }));
  });

  // ---- course details from students (src/facts.js) ----
  // Grouped facts per course: each distinct fact with how many students added it, and whether this student did.
  function factsFor(codes, userId = 0) {
    if (!codes.length) return {};
    return groupFacts(q(`SELECT course, kind, key, MIN(data) AS data, COUNT(DISTINCT user_id) AS n, MAX(user_id = ?) AS mine FROM course_facts
      WHERE status = 'published' AND course IN (${codes.map(() => '?').join(',')}) GROUP BY course, key`).all(userId || 0, ...codes));
  }
  const datedFor = (facts) => Object.entries(facts).flatMap(([code, f]) => f.event.map((e) => ({ code, ...e }))).sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''));
  // Dates a class's lecturer, tutors or reps added for these courses. They're the official ones: confirmed, labelled
  // with who added them, and they win over a student-added date of the same kind on the same day.
  const classDatesFor = (codes) => (codes.length ? q(`SELECT d.*, m.name AS by_name FROM class_dates d
    LEFT JOIN class_members m ON m.class_id = d.class_id AND m.user_id = d.added_by WHERE d.course IN (${codes.map(() => '?').join(',')})`).all(...codes) : [])
    .map((d) => ({ id: `class-${d.id}`, code: d.course, type: d.type, title: d.title, date: d.date, time: d.time, confirmed: true, official: d.added_role === 'rep' ? 'class rep' : d.added_role, by: d.by_name }));
  const datedWithClasses = (facts, codes) => {
    const official = classDatesFor(codes);
    const taken = new Set(official.map((d) => `${d.code}|${d.date}|${d.type}`));
    return [...official, ...datedFor(facts).filter((d) => !taken.has(`${d.code}|${d.date}|${d.type}`))]
      .sort((x, y) => x.date.localeCompare(y.date) || (x.time || '').localeCompare(y.time || ''));
  };
  // for calendar files: student times, dated events, and a "start revising" day before each exam
  const crowdFor = (codes) => {
    const facts = factsFor(codes);
    const dated = datedWithClasses(facts, codes);
    return { crowd: crowdSlots(facts), dated, revision: revisionPlan(dated.filter((d) => d.type === 'exam'), weekRows(codes)) };
  };
  const backTo = (code) => `/courses/${code}#course-week`;

  // add a fact, or confirm one by sending the same fact
  app.post('/courses/:code/facts', requireUser, limits.fact, (req, res) => {
    const c = getCourse(req.params.code);
    if (!c) return res.status(404).page(notFound(req));
    const fact = parseFact(req.body);
    if (fact.error) return flashRedirect(res, backTo(c.code), 'error', fact.error);
    const screen = screenFact(fact);
    if (screen.action === 'reject') return flashRedirect(res, backTo(c.code), 'error', `That can't go up: ${screen.reasons.join(', ')}.`);
    // one topic per student per week: a new one replaces their old one
    if (fact.kind === 'topic') q(`DELETE FROM course_facts WHERE course = ? AND user_id = ? AND kind = 'topic' AND key LIKE ?`).run(c.code, req.user.id, `topic|${fact.data.week}|%`);
    const status = screen.action === 'hold' || q(`SELECT 1 FROM course_facts WHERE course = ? AND key = ? AND status != 'published'`).get(c.code, fact.key) ? 'held' : 'published';
    q(`INSERT OR IGNORE INTO course_facts (course, kind, key, data, user_id, status) VALUES (?, ?, ?, ?, ?, ?)`).run(c.code, fact.kind, fact.key, JSON.stringify(fact.data), req.user.id, status);
    flashRedirect(res, backTo(c.code), 'ok', status === 'held' ? 'Thanks. A moderator will check it before it shows.' : 'Thanks, that helps everyone in this course.');
  });

  app.post('/courses/:code/facts/withdraw', requireUser, (req, res) => {
    const code = String(req.params.code).toUpperCase();
    q(`DELETE FROM course_facts WHERE course = ? AND key = ? AND user_id = ?`).run(code, String(req.body.key || ''), req.user.id);
    flashRedirect(res, backTo(code), 'ok', 'Removed.');
  });

  // two reports from different students hide a fact until a moderator looks
  app.post('/courses/:code/facts/report', requireUser, limits.report, (req, res) => {
    const code = String(req.params.code).toUpperCase();
    const key = String(req.body.key || '').slice(0, 200);
    if (!q(`SELECT 1 FROM course_facts WHERE course = ? AND key = ?`).get(code, key)) return res.status(404).page(notFound(req));
    q(`INSERT OR IGNORE INTO fact_reports (course, key, user_id) VALUES (?, ?, ?)`).run(code, key, req.user.id);
    const n = q(`SELECT COUNT(*) AS n FROM fact_reports WHERE course = ? AND key = ?`).get(code, key).n;
    if (n >= HIDE_AFTER_REPORTS) q(`UPDATE course_facts SET status = 'held' WHERE course = ? AND key = ? AND status = 'published'`).run(code, key);
    flashRedirect(res, backTo(code), 'ok', n >= HIDE_AFTER_REPORTS ? 'Thanks. It\'s hidden until a moderator checks it.' : 'Thanks. A moderator will take a look.');
  });

  // ---- the week view ----
  // The plan as a Monday-to-Friday timetable. Choosing a tut group, adding a block or turning on study time works
  // like the planner: plain links and forms that update the plan's link and this device's cookie.
  const weekRows = (codes) => (codes.length ? q(`SELECT c.code, c.title, c.credits, c.periods, c.days, c.period_choice, c.sessions, c.lectures, c.exam_weight, s.workload, s.difficulty FROM courses c
    LEFT JOIN (SELECT course, AVG(workload) AS workload, AVG(difficulty) AS difficulty FROM reviews WHERE status = 'published' GROUP BY course) s ON s.course = c.code
    WHERE c.code IN (${codes.map(() => '?').join(',')})`).all(...codes) : []);
  const calCookie = (req) => /(?:^|;\s*)cal=([A-Za-z0-9_-]{22})/.exec(req.headers.cookie || '')?.[1];
  const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

  app.get('/week', (req, res) => {
    const { fromUrl, codes, profile, week } = readPlan(req);
    const save = (msg) => {
      savePlan(req, res, codes, profile, week);
      const to = planUrl(codes, profile, week, '/week');
      return msg ? flashRedirect(res, to, msg[0], msg[1]) : res.redirect(303, to);
    };
    if (req.query.term === 's1' || req.query.term === 's2') { week.t = req.query.term; return save(); }
    if (req.query.study === '1' || req.query.study === '0') { week.study = req.query.study === '1'; return save(); }
    const pick = /^([A-Z]{3}\d{4}[A-Z])\.([LTP])$/.exec(String(req.query.pick || ''));
    if (pick && /^\d{1,2}$/.test(String(req.query.opt))) { week.picks[`${pick[1]}.${pick[2]}`] = Number(req.query.opt); return save(); }
    if (req.query.rm_block != null) { week.blocks.splice(Number(req.query.rm_block) || 0, 1); return save(); }
    if (req.query.add_block != null) {
      const day = DAYS[Number(req.query.day)];
      const start = String(req.query.start || '');
      const end = String(req.query.end || '');
      const label = String(req.query.label || '').replace(/[^A-Za-z0-9 &'.:-]/g, '').trim().slice(0, 30);
      if (!day || !TIME.test(start) || !TIME.test(end) || end <= start) return save(['error', 'Pick a day, and an end time after the start time.']);
      if (week.blocks.length >= 20) return save(['error', 'You can add up to 20 of your own blocks.']);
      week.blocks.push({ day, start, end, label: label || 'Busy' });
      return save();
    }
    if (!fromUrl && (codes.length || week.blocks.length)) return res.redirect(303, planUrl(codes, profile, week, '/week'));
    const rows = weekRows(codes);
    const facts = factsFor(codes);
    const wk = buildWeek(codes.map((c) => rows.find((r) => r.code === c)).filter(Boolean), week, { crowd: crowdSlots(facts), official: classSlotsFor(req.user) });
    const upcoming = datedWithClasses(facts, codes).filter((d) => d.date >= new Date().toISOString().slice(0, 10)).slice(0, 12);
    const cal = calCookie(req);
    const origin = baseUrl || `${req.protocol}://${req.get('host')}`;
    res.page(views.week(req.ctx, {
      wk, week, codes, upcoming,
      state: Object.fromEntries(new URLSearchParams(planQuery(codes, profile, week))),
      calendar: cal && q(`SELECT id FROM calendars WHERE id = ?`).get(cal) ? `${origin}/cal/${cal}.ics` : null,
    }));
  });

  // the whole year as a calendar file, from the link's plan
  app.get('/week.ics', (req, res) => {
    const { codes, week } = readPlan(req);
    const rows = weekRows(codes);
    res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="kwaai-week.ics"' })
      .send(icsFor(codes.map((c) => rows.find((r) => r.code === c)).filter(Boolean), week, { origin: baseUrl || '', ...crowdFor(codes), official: classSlotsFor(req.user) }));
  });

  // A calendar that keeps itself up to date: Google, Apple or Outlook fetch /cal/<id>.ics every few hours, and it
  // follows the plan saved on this device.
  app.post('/week/subscribe', (req, res) => {
    const { codes, week } = readPlan(req);
    let id = calCookie(req);
    if (!id || !q(`SELECT 1 FROM calendars WHERE id = ?`).get(id)) {
      id = crypto.randomBytes(16).toString('base64url');
      q(`INSERT INTO calendars (id, query) VALUES (?, ?)`).run(id, calendarQuery(codes, week));
    }
    res.cookie('cal', id, { httpOnly: true, sameSite: 'lax', secure: !devMode, maxAge: 2 * 365 * 24 * 60 * 60 * 1000 });
    flashRedirect(res, '/week#calendar', 'ok', 'Your calendar link is ready. Add it to your phone below.');
  });

  app.post('/week/unsubscribe', (req, res) => {
    const id = calCookie(req);
    if (id) q(`DELETE FROM calendars WHERE id = ?`).run(id);
    res.clearCookie('cal');
    flashRedirect(res, '/week', 'ok', 'Calendar link deleted. Calendars that used it will stop updating.');
  });

  app.get('/cal/:file', (req, res) => {
    const id = /^([A-Za-z0-9_-]{22})\.ics$/.exec(req.params.file)?.[1];
    const row = id && q(`SELECT query FROM calendars WHERE id = ?`).get(id);
    if (!row) return res.status(404).type('text/plain').send('This calendar link was deleted or never existed.');
    q(`UPDATE calendars SET fetched_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
    const state = Object.fromEntries(new URLSearchParams(row.query));
    const codes = planCodes(state.c);
    const rows = weekRows(codes);
    res.set({ 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-cache' })
      .send(icsFor(codes.map((c) => rows.find((r) => r.code === c)).filter(Boolean), parseWeek(state), { origin: baseUrl || '', ...crowdFor(codes) }));
  });

  // ---- marks and DP tracker ----
  // Marks stay on the student's device: the page saves them in the browser (public/app.js). Without JavaScript the
  // form posts here, the server works the answer out from the posted numbers and stores nothing.
  const GENERIC = [{ name: 'Class mark', weight: 40, exam: false }, { name: 'Final exam', weight: 60, exam: true }];
  function marksCourses(codes) {
    const rows = codes.length ? q(`SELECT code, title, assessment, dp, exam_weight FROM courses WHERE code IN (${codes.map(() => '?').join(',')})`).all(...codes) : [];
    return codes.map((code) => rows.find((r) => r.code === code)).filter(Boolean).map((c) => {
      const items = Marks.parseAssessment(c.assessment, c.exam_weight);
      return { ...c, items: items.length ? items : GENERIC, fromHandbook: items.length > 0, dpMin: Marks.dpMinimum(c.dp), examSub: Marks.examSubminimum(c.assessment) };
    });
  }
  const anyCourse = () => ({ code: '', title: 'Any course', assessment: '', dp: '', items: GENERIC, fromHandbook: false, dpMin: null, examSub: null });

  app.get('/marks', (req, res) => {
    const { codes, profile, week } = readPlan(req);
    const courses = marksCourses(codes);
    res.page(views.marks(req.ctx, { courses: courses.length ? courses : [anyCourse()], planLink: planUrl(codes, profile, week), hasPlan: courses.length > 0 }));
  });

  app.post('/marks', (req, res) => {
    const { codes, profile, week } = readPlan(req);
    const courses = marksCourses(codes);
    const list = courses.length ? courses : [anyCourse()];
    const code = String(req.body.code || '');
    const b = req.body;
    // the posted rows replace that course's rows, so edited names and weights are used as typed
    const items = [];
    const marks = [];
    for (let i = 0; i < 12; i++) {
      const weight = Number(b[`w${i}`]);
      if (b[`n${i}`] == null || !(weight > 0) || weight > 100) continue;
      items.push({ name: String(b[`n${i}`]).slice(0, 40) || `Part ${i + 1}`, weight, exam: b[`e${i}`] === '1' });
      const m = String(b[`m${i}`] ?? '').trim();
      marks.push(m === '' || Number.isNaN(Number(m)) ? '' : Math.max(0, Math.min(100, Number(m))));
    }
    const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Math.max(0, Math.min(100, Number(v))));
    const opts = { dpMin: num(b.dp), examSub: num(b.sub) };
    const result = items.length ? Marks.compute(items, marks, opts) : null;
    const posted = list.map((c) => (c.code === code ? { ...c, items: items.length ? items : c.items, marks, dpMin: opts.dpMin, examSub: opts.examSub, result } : c));
    res.set('Cache-Control', 'no-store').page(views.marks(req.ctx, { courses: posted, planLink: planUrl(codes, profile, week), hasPlan: courses.length > 0 }));
  });

  // ---- today ----
  // Today's classes from the week, what's coming up in the next two weeks, a tip for a course you have today, and DP
  // alerts worked out in the browser from the marks saved on this device.
  const saDate = () => new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10); // South Africa is UTC+2
  function todayFor(codes, week, official = {}) {
    const date = saDate();
    const year = Number(date.slice(0, 4));
    const dates = termDates(year, 's1') && termDates(year, 's2') ? { s1: termDates(year, 's1'), s2: termDates(year, 's2') } : null;
    let term = 's1';
    let note = null;
    if (dates) {
      if (date >= dates.s1.start && date <= dates.s1.end) term = 's1';
      else if (date >= dates.s2.start && date <= dates.s2.end) term = 's2';
      else {
        term = date < dates.s1.start ? 's1' : date < dates.s2.start ? 's2' : 's1';
        note = date > dates.s2.end ? 'The year is over. Your plan for next year shows from the first day of term.' : `Classes start on ${dates[term].start}.`;
      }
      const inBreak = dates[term].breaks.find(([a, b]) => date >= a && date <= b);
      if (inBreak && !note) note = `It's the vacation, until ${inBreak[1]}.`;
    }
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0 Sunday
    const dayName = DAYS[weekday >= 1 && weekday <= 5 ? weekday - 1 : 0];
    const rows = weekRows(codes);
    const facts = factsFor(codes);
    const wk = buildWeek(codes.map((c) => rows.find((r) => r.code === c)).filter(Boolean), { ...week, t: term }, { year, crowd: crowdSlots(facts), official });
    const classes = wk.events.filter((e) => e.day === dayName).sort((a, b) => a.start.localeCompare(b.start));
    const soon = new Date(Date.parse(`${date}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10);
    const upcoming = datedWithClasses(facts, codes).filter((d) => d.date >= date && d.date <= soon);
    const todays = [...new Set(classes.map((e) => e.code).filter(Boolean))];
    const tip = todays.length ? q(`SELECT course, tip FROM verdicts WHERE status = 'published' AND tip != '' AND course IN (${todays.map(() => '?').join(',')}) ORDER BY RANDOM() LIMIT 1`).get(...todays) : null;
    return { date, term, note, weekend: weekday === 0 || weekday === 6, dayName, classes, upcoming, tip, marks: marksCourses(wk.courses.map((c) => c.code)),
      // courses to start a study timer for: this term's, or the whole plan between terms
      study: wk.courses.length ? wk.courses.map((c) => c.code) : codes };
  }

  app.get('/today', (req, res) => {
    const { codes, profile, week } = readPlan(req);
    res.set('Cache-Control', 'no-store').page(views.today(req.ctx, { today: codes.length ? todayFor(codes, week, classSlotsFor(req.user)) : null, weekLink: planUrl(codes, profile, week, '/week'), streak: req.user ? streakFor(req.user.id) : null, rank: rankWithUp(req.user), quests: req.user ? questsFor(req.user, { announce: true }) : null, classes: req.user ? myClasses(req.user) : [], announcements: req.user ? announcementsFor(req.user) : [], pulses: req.user ? pulsesFor(req.user) : [], dpAlerts: dpAlertsFor(req.user) }));
  });

  // ---- study timer ----
  // The rules (what a heartbeat earns, the caps) live in src/study.js. The page sends a heartbeat about once a minute
  // while the timer runs; a session nobody is timing any more is closed with what it had earned.
  // Test accounts (the admin and the test tools' fake students) are left out of every figure students see. An admin
  // sees them, so the boards and counts can be tested. Goes in a WHERE on a table with a user_id column.
  const realOnly = (viewer) => (viewer?.is_admin ? '' : 'AND user_id NOT IN (SELECT id FROM users WHERE is_test = 1)');
  // students with a timer running right now (a heartbeat in the last two minutes), counted over a filter
  function liveStudents(viewer, where, ...args) {
    return q(`SELECT COUNT(DISTINCT user_id) AS n FROM study_sessions WHERE status = 'running' AND last_beat >= ? AND ${where} ${realOnly(viewer)}`).get(Study.liveSince(Date.now()), ...args).n;
  }
  const runningSession = (userId) => q(`SELECT * FROM study_sessions WHERE user_id = ? AND status = 'running'`).get(userId);
  const closeStale = (userId, now = Date.now()) => {
    const s = runningSession(userId);
    if (s && Study.isStale(s, now)) q(`UPDATE study_sessions SET status = 'done' WHERE id = ?`).run(s.id);
  };
  const wantsJson = (req) => /json/.test(req.get('accept') || '');
  const sessionState = (s) => (s ? { running: s.status === 'running', course: s.course, startedAt: s.started_at, plannedMin: s.planned_min, creditedSec: s.credited_sec, now: Date.now() } : { running: false });
  const courseExists = (code) => !!q(`SELECT 1 FROM courses WHERE code = ?`).get(code);
  const loggedText = (s) => `Logged ${Study.hoursText(Math.floor(s.credited_sec / 60))}${s.course ? ` of ${s.course}` : ''}.`;

  app.get('/study', (req, res) => {
    const { codes } = readPlan(req);
    const pick = String(req.query.course || '').trim().toUpperCase();
    let current = null;
    let sessions = [];
    if (req.user) {
      closeStale(req.user.id);
      current = runningSession(req.user.id);
      sessions = q(`SELECT course, credited_sec, status, started_at, planned_min, day FROM study_sessions WHERE user_id = ? AND day = ? ORDER BY started_at`).all(req.user.id, Study.saDay(Date.now()));
    }
    // the plan's courses, plus the one asked for (?course=, from a course page or Today) and the one being timed
    const wanted = [...new Set([...codes, ...[pick, current?.course].filter((c) => c && courseExists(c))])];
    const courses = wanted.length ? q(`SELECT code, title FROM courses WHERE code IN (${wanted.map(() => '?').join(',')}) ORDER BY code`).all(...wanted) : [];
    res.set('Cache-Control', 'no-store').page(views.study(req.ctx, {
      courses, pick: current?.course || (courses.some((c) => c.code === pick) ? pick : ''), current: current && sessionState(current),
      today: Study.dayTotals(sessions.filter((s) => s.status === 'done'))[0] || null, sessions: sessions.filter((s) => s.status === 'done'),
      board: req.user ? studyBoard(req.user, codes, req.query.day) : null,
      rank: rankWithUp(req.user),
      quests: req.user ? questsFor(req.user, { announce: true }) : null,
      studyingNow: liveStudents(req.user, `uni = ?`, req.user?.uni ?? CURRENT.slug),
    }));
  });

  // the signed-in dashboard: a year of days for the heatmap, this week by course against the handbook's hours, and
  // one day's detail when a heatmap day is opened (?day=2027-03-01)
  // a student's minutes per day for the last year (enough for the heatmap and for streaks)
  function studyTotals(userId, today) {
    return Study.dayTotals(q(`SELECT course, credited_sec, day FROM study_sessions WHERE user_id = ? AND status = 'done' AND day >= ?`).all(userId, Study.addDay(today, -371)));
  }
  // the streak, or null for a student who has never timed a session (nothing to show yet)
  function streakFor(userId) {
    const today = Study.saDay(Date.now());
    const totals = studyTotals(userId, today);
    return totals.length ? Study.streak(totals, today, TERMS.years) : null;
  }

  // ---- weekly quests (src/quests.js) ----
  // This week's quests. announce: also say which quests were finished since the student last opened Study or Today
  // (users.quests_seen remembers). history: count every quest finished so far, for the rank page.
  function questsFor(user, { announce = false, history = false } = {}) {
    const monday = Quests.mondayOf(Study.saDay(Date.now()));
    const sessions = q(`SELECT day, started_at, credited_sec, course FROM study_sessions WHERE user_id = ? AND status = 'done' AND day >= ?`)
      .all(user.id, Study.addDay(monday, -7 * (history ? 52 : 5)));
    const quests = Quests.weekQuests({ userId: user.id, monday, sessions });
    let news = [];
    if (announce) {
      const n = Quests.newlyDone(quests, monday, user.quests_seen ?? null);
      if (n.seen !== user.quests_seen) q(`UPDATE users SET quests_seen = ? WHERE id = ?`).run(n.seen, user.id);
      news = n.news;
    }
    return { monday, quests, news, history: history ? Quests.questHistory({ userId: user.id, monday, sessions }) : null };
  }

  // ---- ranks (the ladders are in src/ranks.js) ----
  // How names look on boards, groups and classes: the lifetime rank badge and the name style a student picked. Only
  // for students on the leaderboards (a profiles row): others see plain names. A student always sees their own rank.
  // The style is checked against the rank again here, so a style saved earlier never shows above the rank.
  // ids: user ids; viewerId: the student looking. Returns a Map of id to { badge (the rank, or null), fx }.
  function nameLooks(ids, viewerId) {
    const out = new Map();
    if (!ids.length) return out;
    const profiles = new Map(q(`SELECT user_id, name_fx, show_name, display_name, name_held FROM profiles WHERE user_id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((p) => [p.user_id, p]));
    const minutes = lifetimeMinutes(ids);
    for (const id of ids) {
      const p = profiles.get(id);
      if (!p && id !== viewerId) continue;
      const rank = Ranks.rankOf(minutes.get(id));
      const named = p && p.show_name && p.display_name && !p.name_held;
      out.set(id, { badge: rank.tier ? rank : null, fx: named && Ranks.fxAllowed(p.name_fx, rank.tier) ? p.name_fx || '' : '' });
    }
    return out;
  }
  const myLifetime = (userId) => Ranks.rankOf(lifetimeMinutes([userId]).get(userId));
  const withLooks = (rows, viewerId, hide = () => false) => {
    const looks = nameLooks(rows.map((r) => r.id), viewerId);
    return rows.map((r) => (hide(r) ? r : { ...r, ...looks.get(r.id) }));
  };
  // A rank-up is shown once, on the next Study, Today or home page the student opens, however the session ended (the
  // timer ran out, Stop, or a closed tab). users.rank_seen and season_seen remember what was last celebrated.
  function celebrateRank(user, rank) {
    const { up, seen } = Ranks.newRank(rank, { lifetime: user.rank_seen, season: user.season_seen });
    if (seen.lifetime !== user.rank_seen || seen.season !== user.season_seen) q(`UPDATE users SET rank_seen = ?, season_seen = ? WHERE id = ?`).run(seen.lifetime, seen.season, user.id);
    return up;
  }
  // the rank for a page that can celebrate it: rank.up is the new rank to show, or null
  function rankWithUp(user) {
    if (!user) return null;
    const rank = rankFor(user.id);
    return { ...rank, up: celebrateRank(user, rank) };
  }
  // every minute each student ever timed, with each day capped as in Study.dayTotals; a Map of user id to minutes
  function lifetimeMinutes(ids) {
    const out = new Map(ids.map((id) => [id, 0]));
    if (!ids.length) return out;
    const rows = q(`SELECT user_id, SUM(MIN(m, ${Study.DAY_CAP_MIN})) AS minutes FROM (SELECT user_id, day, SUM(credited_sec / 60) AS m FROM study_sessions
      WHERE status = 'done' AND user_id IN (${ids.map(() => '?').join(',')}) GROUP BY user_id, day) GROUP BY user_id`).all(...ids);
    for (const r of rows) out.set(r.user_id, r.minutes);
    return out;
  }
  // a student's lifetime rank, this semester's season rank and how last season ended. totals (from studyTotals)
  // covers the last 371 days, which always includes this season and the one before.
  function rankFor(userId, totals = null) {
    const today = Study.saDay(Date.now());
    const days = totals || studyTotals(userId, today);
    const minutesIn = (s) => days.filter((t) => t.day >= s.from && t.day <= s.to).reduce((sum, t) => sum + t.minutes, 0);
    const season = Ranks.seasonOf(today, TERMS.years);
    const last = Ranks.previousSeason(season, TERMS.years);
    const lastMin = minutesIn(last);
    return {
      lifetime: Ranks.rankOf(lifetimeMinutes([userId]).get(userId)),
      season: { ...season, ...Ranks.rankOf(minutesIn(season), Ranks.SEASON), daysLeft: Math.round((Date.parse(season.to) - Date.parse(today)) / 86_400_000) },
      lastSeason: lastMin ? { ...last, ...Ranks.rankOf(lastMin, Ranks.SEASON) } : null,
    };
  }

  function studyBoard(user, codes, askedDay) {
    const today = Study.saDay(Date.now());
    const totals = studyTotals(user.id, today);
    const recap = Study.weekRecap(totals, today);
    if (recap) recap.ranks = ranksFor(user, recap.from, recap.to);
    const sum = Study.summary(totals, today);
    // this semester's courses from the plan (by date: from the second semester's start it's S courses), plus any
    // course studied this week
    const year = Number(today.slice(0, 4));
    const term = (termDates(year, 's2')?.start ?? `${year}-07-15`) <= today ? 's2' : 's1';
    const inTerm = codes.filter((c) => (term === 's1' ? !c.endsWith('S') : !c.endsWith('F')));
    const goalCodes = [...new Set([...inTerm, ...Object.keys(sum.weekCourses).filter(Boolean)])];
    const goalRows = goalCodes.length ? q(`SELECT code, title, credits FROM courses WHERE code IN (${goalCodes.map(() => '?').join(',')})`).all(...goalCodes) : [];
    const weeksOf = (t) => semesterWeeks(termDates(year, t) ? year : planYear(), t);
    const goals = goalRows.map((c) => ({ code: c.code, title: c.title, goal: Study.weeklyGoal(c, weeksOf), minutes: sum.weekCourses[c.code] || 0 }))
      .sort((x, y) => y.minutes - x.minutes || x.code.localeCompare(y.code));
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(askedDay || '')) ? askedDay : null;
    return {
      today, weeks: Study.heatmap(totals, today), summary: sum, goals, general: sum.weekCourses[''] || 0, streak: Study.streak(totals, today, TERMS.years),
      dayDetail: day ? totals.find((t) => t.day === day) || { day, minutes: 0, courses: {} } : null,
      days: totals.filter((t) => t.minutes > 0).reverse(), recap,
    };
  }

  // Wrapped: a semester in numbers on one card, sized for a phone screenshot. Defaults to the semester running now,
  // or the last one that started; ?year=2027&term=s1 picks another that has started.
  const semestersSoFar = (today) => Object.keys(TERMS.years).sort().flatMap((y) => ['s1', 's2'].map((t) => ({ year: Number(y), term: t, ...termDates(y, t) })))
    .filter((s) => s.start && s.start <= today);
  app.get('/study/wrapped', requireUser, (req, res) => {
    const today = Study.saDay(Date.now());
    const all = semestersSoFar(today);
    const sem = all.find((s) => String(s.year) === req.query.year && s.term === req.query.term) || all[all.length - 1];
    if (!sem) return res.status(404).page(notFound(req));
    const to = sem.end < today ? sem.end : today;
    const totals = studyTotals(req.user.id, today);
    const w = Study.wrapped(totals, sem.start, to, TERMS.years);
    // the season this semester falls in, up to the card's last day
    const se = Ranks.seasonOf(sem.start, TERMS.years);
    const seasonMin = totals.filter((t) => t.day >= se.from && t.day <= (se.to < to ? se.to : to)).reduce((sum, t) => sum + t.minutes, 0);
    const codes = w.courses.map((c) => c.code).filter(Boolean);
    const titles = codes.length ? Object.fromEntries(q(`SELECT code, title FROM courses WHERE code IN (${codes.map(() => '?').join(',')})`).all(...codes).map((c) => [c.code, c.title])) : {};
    res.set('Cache-Control', 'no-store').page(views.wrapped(req.ctx, {
      sem: { ...sem, to, running: sem.end >= today }, w: { ...w, courses: w.courses.slice(0, 3).map((c) => ({ ...c, title: titles[c.code] ?? '' })) },
      ranks: ranksFor(req.user, sem.start, to), season: Ranks.rankOf(seasonMin, Ranks.SEASON), others: all.slice(-4).reverse(),
    }));
  });

  // the rank in full: all time, this season, last season and the ladder
  app.get('/study/rank', requireUser, (req, res) => {
    const today = Study.saDay(Date.now());
    const totals = studyTotals(req.user.id, today);
    res.set('Cache-Control', 'no-store').page(views.rankPage(req.ctx, { rank: rankFor(req.user.id, totals), streak: totals.length ? Study.streak(totals, today, TERMS.years) : null, quests: questsFor(req.user, { history: true }) }));
  });

  // the rank card for a screenshot: the display name only if the student picked one for the boards
  app.get('/study/rank/card', requireUser, (req, res) => {
    const today = Study.saDay(Date.now());
    const totals = studyTotals(req.user.id, today);
    const p = profileOf(req.user.id);
    res.set('Cache-Control', 'no-store').page(views.rankShareCard(req.ctx, {
      rank: rankFor(req.user.id, totals), name: p?.show_name && p.display_name && !p.name_held ? p.display_name : `A ${req.ctx.uni.short} student`,
      streak: totals.length ? Study.streak(totals, today, TERMS.years) : null, quests: questsFor(req.user, { history: true }),
    }));
  });

  app.post('/study/start', requireUser, limits.study, (req, res) => {
    const parsed = Study.parseStart(req.body, courseExists);
    const fail = (status, text) => (wantsJson(req) ? res.status(status).json({ error: text }) : flashRedirect(res, '/study', 'error', text));
    if (parsed.error) return fail(400, parsed.error);
    closeStale(req.user.id);
    if (runningSession(req.user.id)) return fail(409, 'You already have a timer running. Stop it before starting another.');
    const now = Date.now();
    q(`INSERT INTO study_sessions (user_id, uni, course, day, started_at, last_beat, planned_min) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(req.user.id, req.user.uni, parsed.course, Study.saDay(now), now, now, parsed.minutes);
    if (wantsJson(req)) return res.json(sessionState(runningSession(req.user.id)));
    res.redirect(303, '/study');
  });

  // credits the time since the last heartbeat, and closes the session once it's past its planned length plus grace
  app.post('/study/beat', requireUser, limits.studyBeat, (req, res) => {
    const s = runningSession(req.user.id);
    if (!s) return res.json({ running: false });
    const now = Date.now();
    const next = { ...s, ...Study.beat(s, now) };
    next.status = Study.isStale(next, now) ? 'done' : 'running';
    q(`UPDATE study_sessions SET credited_sec = ?, last_beat = ?, status = ? WHERE id = ?`).run(next.credited_sec, next.last_beat, next.status, s.id);
    res.json(sessionState(next));
  });

  app.post('/study/stop', requireUser, limits.study, (req, res) => {
    const s = runningSession(req.user.id);
    if (!s) return wantsJson(req) ? res.json({ running: false }) : res.redirect(303, '/study');
    const done = { ...s, ...Study.beat(s, Date.now()), status: 'done' };
    q(`UPDATE study_sessions SET credited_sec = ?, last_beat = ?, status = 'done' WHERE id = ?`).run(done.credited_sec, done.last_beat, s.id);
    if (wantsJson(req)) return res.json({ ...sessionState(done), message: loggedText(done) });
    flashRedirect(res, '/study', 'ok', loggedText(done));
  });

  // ---- leaderboards ----
  // Opt-in only: a student is on the boards while they have a profiles row. Boards are shown to signed-in students.
  const NAME_HIDE_AFTER = 2; // reports from different students before a name is hidden for a moderator
  const knownProfile = { faculty: (f) => !!FACULTIES[f], major: (f, m) => PROGRAMMES.has(`${f}:${m}`) };
  const profileOf = (userId) => q(`SELECT * FROM profiles WHERE user_id = ?`).get(userId) || null;
  // what other students see: the name if shown and not held, else "2nd-year Computer Science student"
  const boardName = (p) => {
    if (p.show_name && p.display_name && !p.name_held) return p.display_name;
    const what = PROGRAMMES.get(`${p.faculty}:${p.major}`)?.name || FACULTIES[p.faculty]?.name;
    const label = [p.year ? `${ordinal(p.year)}-year` : null, what].filter(Boolean).join(' ');
    return label ? `${label} student` : `${CURRENT.short} student`;
  };

  app.get('/account/profile', requireUser, (req, res) => {
    res.page(views.profile(req.ctx, { profile: profileOf(req.user.id), faculties: facultyOptions(), programmes: programmeOptions(), rank: myLifetime(req.user.id) }));
  });

  app.post('/account/profile', requireUser, limits.profile, (req, res) => {
    const rank = myLifetime(req.user.id);
    const parsed = Study.parseProfileForm(req.body, { ...knownProfile, fx: (fx) => Ranks.fxAllowed(fx, rank.tier) }, screenComment);
    const id = req.user.id;
    if (parsed.leave) {
      q(`DELETE FROM profiles WHERE user_id = ?`).run(id);
      q(`DELETE FROM name_reports WHERE target_id = ?`).run(id);
      return flashRedirect(res, '/account/profile', 'ok', "You've left the leaderboards. Your study time is still yours on the Study page.");
    }
    if (parsed.error) return res.status(400).page(views.profile(req.ctx, { profile: { ...req.body, show_name: req.body.show === 'name' ? 1 : 0 }, faculties: facultyOptions(), programmes: programmeOptions(), rank, error: parsed.error }));
    const p = parsed.profile;
    const before = profileOf(id);
    // a new name gets a fresh start: earlier reports were about the old one
    if (before && before.display_name !== p.display_name) q(`DELETE FROM name_reports WHERE target_id = ?`).run(id);
    q(`INSERT INTO profiles (user_id, uni, display_name, show_name, faculty, major, year, name_fx) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, show_name = excluded.show_name, faculty = excluded.faculty, major = excluded.major, year = excluded.year, name_fx = excluded.name_fx,
        name_held = CASE WHEN profiles.display_name = excluded.display_name THEN profiles.name_held ELSE 0 END`)
      .run(id, req.user.uni, p.display_name, p.show_name, p.faculty, p.major, p.year, p.name_fx);
    flashRedirect(res, '/study/leaderboards', 'ok', before ? 'Saved.' : "You're on the leaderboards.");
  });

  // minutes per leaderboard member over a span of days, each day capped like everywhere else; faculty narrows it
  function boardRows(uni, from, to, faculty = null, viewer = null) {
    return q(`SELECT p.*, SUM(x.m) AS minutes FROM profiles p JOIN (
        SELECT user_id, day, MIN(SUM(credited_sec / 60), ${Study.DAY_CAP_MIN}) AS m FROM study_sessions
        WHERE status = 'done' AND uni = ? AND day BETWEEN ? AND ? ${realOnly(viewer)} GROUP BY user_id, day
      ) x ON x.user_id = p.user_id WHERE p.uni = ? ${faculty ? 'AND p.faculty = ?' : ''} GROUP BY p.user_id`)
      .all(...[uni, from, to, uni, ...(faculty ? [faculty] : [])]);
  }
  // the student's rank over a span at their university and in their faculty, or null if they're not on the boards
  function ranksFor(user, from, to) {
    const me = profileOf(user.id);
    if (!me) return null;
    const rankIn = (rows) => { const b = Study.rankBoard(rows, user.id); return (b.rows.find((r) => r.user_id === user.id) || b.me)?.rank ?? null; };
    return { uni: rankIn(boardRows(user.uni, from, to, null, user)), faculty: me.faculty ? rankIn(boardRows(user.uni, from, to, me.faculty, user)) : null, facultyName: FACULTIES[me.faculty]?.name ?? null };
  }

  app.get('/study/leaderboards', requireUser, (req, res) => {
    const me = profileOf(req.user.id);
    const period = Study.PERIODS[req.query.period] ? req.query.period : 'week';
    const scope = req.query.scope === 'faculty' ? 'faculty' : 'uni';
    const faculty = FACULTIES[req.query.f] ? req.query.f : me?.faculty || 'sci';
    const [from, to] = Study.periodRange(period, Study.saDay(Date.now()));
    const rows = boardRows(req.user.uni, from, to, scope === 'faculty' ? faculty : null, req.user);
    const board = Study.rankBoard(rows, req.user.id);
    const show = (r) => ({ rank: r.rank, minutes: r.minutes, name: boardName(r), you: r.user_id === req.user.id, id: r.user_id, reportable: !!(r.show_name && r.display_name && !r.name_held) && r.user_id !== req.user.id });
    res.set('Cache-Control', 'no-store').page(views.leaderboard(req.ctx, {
      joined: !!me, period, scope, faculty, faculties: facultyOptions(), rows: withLooks(board.rows.map(show), req.user.id), me: board.me && withLooks([show(board.me)], req.user.id)[0], total: board.total,
    }));
  });

  app.post('/study/report-name', requireUser, limits.report, (req, res) => {
    const target = Number(req.body.user);
    const back = String(req.body.back || '').startsWith('/study/leaderboards') ? req.body.back : '/study/leaderboards';
    const p = Number.isInteger(target) && target !== req.user.id ? profileOf(target) : null;
    if (!p || !p.show_name || !p.display_name) return res.status(404).page(notFound(req));
    q(`INSERT INTO name_reports (user_id, target_id) VALUES (?, ?) ON CONFLICT DO NOTHING`).run(req.user.id, target);
    if (q(`SELECT COUNT(*) AS n FROM name_reports WHERE target_id = ?`).get(target).n >= NAME_HIDE_AFTER) q(`UPDATE profiles SET name_held = 1 WHERE user_id = ?`).run(target);
    flashRedirect(res, back, 'ok', 'Thanks. A moderator will look at that name.');
  });

  // ---- study groups ----
  // Friends, a residence, a tut group: anyone with the join code can join, and members see each other's group name
  // and study minutes. The owner can remove members or delete the group.
  const groupByCode = (code) => {
    const c = String(code || '').trim().toUpperCase();
    return /^[A-HJ-NP-Z2-9]{8}$/.test(c) ? q(`SELECT * FROM study_groups WHERE code = ?`).get(c) || null : null;
  };
  const memberOf = (groupId, userId) => q(`SELECT * FROM group_members WHERE group_id = ? AND user_id = ?`).get(groupId, userId) || null;
  const memberCount = (groupId) => q(`SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?`).get(groupId).n;
  const groupsOf = (userId) => q(`SELECT g.*, m.name AS my_name, (SELECT COUNT(*) FROM group_members x WHERE x.group_id = g.id) AS members
    FROM study_groups g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ? ORDER BY g.name`).all(userId);
  // the group goes with its last member; if the owner leaves, the longest-standing member takes over
  function leaveGroup(g, userId) {
    q(`DELETE FROM group_members WHERE group_id = ? AND user_id = ?`).run(g.id, userId);
    const next = q(`SELECT user_id FROM group_members WHERE group_id = ? ORDER BY joined_at, user_id LIMIT 1`).get(g.id);
    if (!next) q(`DELETE FROM study_groups WHERE id = ?`).run(g.id);
    else if (g.owner_id === userId) q(`UPDATE study_groups SET owner_id = ? WHERE id = ?`).run(next.user_id, g.id);
  }
  const nameSuggestion = (userId) => profileOf(userId)?.display_name || '';
  const groupsPage = (req, extra = {}) => views.groups(req.ctx, { groups: groupsOf(req.user.id), me: nameSuggestion(req.user.id), ...extra });

  app.get('/groups', requireUser, (req, res) => res.page(groupsPage(req)));

  app.post('/groups', requireUser, limits.group, (req, res) => {
    const name = Study.cleanName(req.body.name, 40, screenComment);
    const me = Study.cleanName(req.body.me, 30, screenComment);
    const fail = (error) => res.status(400).page(groupsPage(req, { me: req.body.me, groupName: req.body.name, error }));
    if (name.error) return fail(`Group name: ${name.error}`);
    if (me.error) return fail(`Your name in the group: ${me.error}`);
    if (groupsOf(req.user.id).length >= Study.MAX_GROUPS) return fail(`You can be in ${Study.MAX_GROUPS} groups at most. Leave one first.`);
    let code;
    do code = Study.groupCode(crypto.randomBytes(8)); while (q(`SELECT 1 FROM study_groups WHERE code = ?`).get(code));
    const { lastInsertRowid } = q(`INSERT INTO study_groups (uni, name, code, owner_id) VALUES (?, ?, ?, ?)`).run(req.user.uni, name.name, code, req.user.id);
    q(`INSERT INTO group_members (group_id, user_id, name) VALUES (?, ?, ?)`).run(lastInsertRowid, req.user.id, me.name);
    flashRedirect(res, `/g/${code}`, 'ok', 'Group made. Send the invite link to the people you study with.');
  });

  // the "join with a code" box on /groups
  app.get('/groups/join', requireUser, (req, res) => {
    const g = groupByCode(req.query.code);
    if (!g) return flashRedirect(res, '/groups', 'error', 'No group has that code. Check it and try again.');
    res.redirect(303, `/g/${g.code}`);
  });

  app.get('/g/:code', requireUser, (req, res) => {
    const g = groupByCode(req.params.code);
    if (!g) return res.status(404).page(notFound(req));
    if (!memberOf(g.id, req.user.id)) return res.page(views.groupJoin(req.ctx, { group: g, members: memberCount(g.id), me: nameSuggestion(req.user.id) }));
    const period = Study.PERIODS[req.query.period] ? req.query.period : 'week';
    const [from, to] = Study.periodRange(period, Study.saDay(Date.now()));
    const rows = q(`SELECT m.user_id, m.name, COALESCE(SUM(x.m), 0) AS minutes FROM group_members m LEFT JOIN (
        SELECT user_id, day, MIN(SUM(credited_sec / 60), ${Study.DAY_CAP_MIN}) AS m FROM study_sessions
        WHERE status = 'done' AND day BETWEEN ? AND ? GROUP BY user_id, day
      ) x ON x.user_id = m.user_id WHERE m.group_id = ? GROUP BY m.user_id ORDER BY m.name`).all(from, to, g.id);
    const show = (r) => ({ id: r.user_id, name: r.name, minutes: r.minutes, rank: r.rank, you: r.user_id === req.user.id });
    // members with a timer running now, what they're studying and for how long so far
    const now = Date.now();
    const live = q(`SELECT m.name, s.course, s.started_at, m.user_id FROM study_sessions s JOIN group_members m ON m.user_id = s.user_id AND m.group_id = ?
      WHERE s.status = 'running' AND s.last_beat >= ? ORDER BY s.started_at`).all(g.id, Study.liveSince(now))
      .map((s) => ({ name: s.name, course: s.course, minutes: Math.max(1, Math.round((now - s.started_at) / 60_000)), you: s.user_id === req.user.id }));
    res.set('Cache-Control', 'no-store').page(views.group(req.ctx, {
      group: g, owner: g.owner_id === req.user.id, period, live, invite: `${req.ctx.site.origin}/g/${g.code}`,
      rows: withLooks(Study.rankBoard(rows, req.user.id, Study.MAX_MEMBERS).rows.map(show), req.user.id), idle: rows.filter((r) => !r.minutes).map(show),
    }));
  });

  app.post('/g/:code/join', requireUser, limits.group, (req, res) => {
    const g = groupByCode(req.params.code);
    if (!g) return res.status(404).page(notFound(req));
    if (memberOf(g.id, req.user.id)) return res.redirect(303, `/g/${g.code}`);
    const me = Study.cleanName(req.body.me, 30, screenComment);
    const fail = (error) => res.status(400).page(views.groupJoin(req.ctx, { group: g, members: memberCount(g.id), me: req.body.me, error }));
    if (me.error) return fail(`Your name in the group: ${me.error}`);
    if (memberCount(g.id) >= Study.MAX_MEMBERS) return fail(`This group is full (${Study.MAX_MEMBERS} members).`);
    if (groupsOf(req.user.id).length >= Study.MAX_GROUPS) return fail(`You can be in ${Study.MAX_GROUPS} groups at most. Leave one first.`);
    q(`INSERT INTO group_members (group_id, user_id, name) VALUES (?, ?, ?)`).run(g.id, req.user.id, me.name);
    flashRedirect(res, `/g/${g.code}`, 'ok', `You're in ${g.name}.`);
  });

  app.post('/g/:code/leave', requireUser, (req, res) => {
    const g = groupByCode(req.params.code);
    if (!g || !memberOf(g.id, req.user.id)) return res.status(404).page(notFound(req));
    leaveGroup(g, req.user.id);
    flashRedirect(res, '/groups', 'ok', `You've left ${g.name}.`);
  });

  app.post('/g/:code/remove', requireUser, (req, res) => {
    const g = groupByCode(req.params.code);
    const who = Number(req.body.user);
    if (!g || g.owner_id !== req.user.id || who === req.user.id || !memberOf(g.id, who)) return res.status(404).page(notFound(req));
    leaveGroup(g, who);
    flashRedirect(res, `/g/${g.code}`, 'ok', 'Removed from the group.');
  });

  app.post('/g/:code/delete', requireUser, (req, res) => {
    const g = groupByCode(req.params.code);
    if (!g || g.owner_id !== req.user.id) return res.status(404).page(notFound(req));
    q(`DELETE FROM study_groups WHERE id = ?`).run(g.id);
    flashRedirect(res, '/groups', 'ok', `${g.name} is deleted.`);
  });

  // ---- the year ----
  // Both semesters side by side with their load, UCT's term dates, the tests and exams students added, and when to
  // start revising for each exam.
  app.get('/year', (req, res) => {
    const { fromUrl, codes, profile, week } = readPlan(req);
    if (!fromUrl && codes.length) return res.redirect(303, planUrl(codes, profile, week, '/year'));
    const rows = weekRows(codes);
    const list = codes.map((c) => rows.find((r) => r.code === c)).filter(Boolean);
    const facts = factsFor(codes);
    const dated = datedWithClasses(facts, codes);
    const year = planYear();
    const today = saDate();
    const semesters = ['s1', 's2'].map((t) => {
      const wk = buildWeek(list, { ...week, t }, { year, crowd: crowdSlots(facts) });
      const credits = Math.round(wk.courses.reduce((s, c) => s + (c.credits || 0) / (/[WH]$/.test(c.code) ? 2 : 1), 0));
      return { term: t, dates: wk.dates, courses: wk.courses, credits, hours: wk.hours.total, weeks: wk.hours.weeks };
    });
    const exams = dated.filter((d) => d.type === 'exam' && d.date.startsWith(String(year)));
    const revision = revisionPlan(exams, list, today);
    const noExamDate = list.filter((c) => c.exam_weight !== 0 && !exams.some((e) => e.code === c.code));
    res.page(views.year(req.ctx, {
      year, today, semesters, revision, noExamDate, months: yearTimeline(year, dated, revision), codes,
      state: Object.fromEntries(new URLSearchParams(planQuery(codes, profile, week))),
    }));
  });

  app.get('/universities', (req, res) => {
    const courses = q(`SELECT COUNT(*) AS n FROM courses`).get().n;
    res.page(views.universities(req.ctx, { universities: UNIVERSITIES, liveCourses: courses }));
  });

  app.get('/about', (req, res) => res.page(views.about(req.ctx, { courses: q(`SELECT COUNT(*) AS n FROM courses`).get().n })));
  app.get('/privacy', (req, res) => res.page(views.privacy(req.ctx)));
  app.get('/terms', (req, res) => res.page(views.terms(req.ctx)));

  // ---- your account (POPIA: see and delete what we hold about you) ----
  app.get('/account', requireUser, (req, res) => {
    const reviews = q(`SELECT ${REVIEW_COLS} FROM reviews r LEFT JOIN lecturers l ON l.id = r.lecturer_id WHERE r.user_id = ? ORDER BY r.created_at DESC`).all(req.user.id);
    const verdicts = q(`SELECT * FROM verdicts WHERE user_id = ? ORDER BY created_at DESC`).all(req.user.id);
    res.page(views.account(req.ctx, { reviews, verdicts }));
  });

  // POPIA right of access: everything held about the signed-in student, as a file they can keep
  app.get('/account/data', requireUser, (req, res) => {
    const id = req.user.id;
    const data = {
      exported_at: new Date().toISOString(),
      account: q(`SELECT email, created_at, agreed_at FROM users WHERE id = ?`).get(id),
      reviews: q(`SELECT r.course, l.name AS lecturer, r.year, r.teaching, r.engagement, r.exams, r.support, r.difficulty, r.workload, r.overall, r.tags, r.body, r.status, r.created_at
        FROM reviews r LEFT JOIN lecturers l ON l.id = r.lecturer_id WHERE r.user_id = ? ORDER BY r.created_at`).all(id),
      votes: q(`SELECT course, year, lekker, tip, status, created_at FROM verdicts WHERE user_id = ? ORDER BY created_at`).all(id),
      reports_you_made: q(`SELECT review_id, reason, details, created_at FROM reports WHERE user_id = ? ORDER BY created_at`).all(id),
      tips_you_reported: q(`SELECT verdict_id FROM verdict_reports WHERE user_id = ?`).all(id),
      lecturer_suggestions: q(`SELECT name, course, status, created_at FROM lecturer_suggestions WHERE user_id = ? ORDER BY created_at`).all(id),
      attendance: q(`SELECT c.name AS class, s.label, a.status, a.how, a.marked_at FROM attendance a JOIN attendance_sessions s ON s.id = a.session_id JOIN classes c ON c.id = s.class_id WHERE a.user_id = ? ORDER BY a.marked_at`).all(id),
      classes: q(`SELECT c.course, c.year, c.name, m.role, m.name AS your_name_there, m.anonymous, m.consent_at, m.joined_at FROM class_members m JOIN classes c ON c.id = m.class_id WHERE m.user_id = ?`).all(id),
      pulse_checks_you_answered: q(`SELECT c.name AS class, p.question FROM pulse_answered a JOIN class_pulses p ON p.id = a.pulse_id JOIN classes c ON c.id = p.class_id WHERE a.user_id = ?`).all(id),
      class_announcements_you_posted: q(`SELECT c.course, c.name AS class, a.body, a.poster_name, a.poster_role, a.created_at FROM class_announcements a JOIN classes c ON c.id = a.class_id WHERE a.posted_by = ? ORDER BY a.created_at`).all(id),
      study_groups: q(`SELECT g.name, m.name AS your_name_there, m.joined_at, g.owner_id = ? AS you_own_it FROM group_members m JOIN study_groups g ON g.id = m.group_id WHERE m.user_id = ?`).all(id, id),
      leaderboard_profile: q(`SELECT display_name, show_name, faculty, major, year, boards_agreed_at FROM profiles WHERE user_id = ?`).get(id) || null,
      study_sessions: q(`SELECT course, day, started_at, planned_min, credited_sec, status FROM study_sessions WHERE user_id = ? ORDER BY started_at`).all(id),
      course_details_you_added: q(`SELECT course, kind, data, status, created_at FROM course_facts WHERE user_id = ? ORDER BY created_at`).all(id).map((f) => ({ ...f, data: JSON.parse(f.data) })),
      note: 'Your semester plan and "about you" answers are kept only in a cookie on your device and in the plan link, not on our server. Sign-in codes, links and sessions are stored as one-way hashes and deleted when they expire.',
    };
    res.set({ 'Content-Disposition': 'attachment; filename="kwaai-my-data.json"', 'Cache-Control': 'no-store' }).json(data);
  });

  app.post('/account/delete', requireUser, (req, res) => {
    const id = req.user.id;
    db.exec('BEGIN');
    try {
      q(`DELETE FROM reports WHERE review_id IN (SELECT id FROM reviews WHERE user_id = ?)`).run(id);
      q(`UPDATE takedowns SET review_id = NULL WHERE review_id IN (SELECT id FROM reviews WHERE user_id = ?)`).run(id);
      q(`DELETE FROM reviews WHERE user_id = ?`).run(id);
      q(`DELETE FROM verdicts WHERE user_id = ?`).run(id);
      q(`DELETE FROM course_facts WHERE user_id = ?`).run(id);
      q(`DELETE FROM study_sessions WHERE user_id = ?`).run(id);
      q(`DELETE FROM name_reports WHERE user_id = ? OR target_id = ?`).run(id, id);
      q(`DELETE FROM profiles WHERE user_id = ?`).run(id);
      for (const g of q(`SELECT g.* FROM study_groups g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ?`).all(id)) leaveGroup(g, id);
      q(`DELETE FROM pulse_answered WHERE user_id = ?`).run(id); // the counts stay: they were never linked to anyone
      q(`UPDATE class_pulses SET asked_by = NULL WHERE asked_by = ?`).run(id);
      q(`DELETE FROM class_announcements WHERE posted_by = ?`).run(id);
      q(`DELETE FROM announcement_reads WHERE user_id = ?`).run(id);
      q(`DELETE FROM announcement_reports WHERE user_id = ?`).run(id);
      q(`DELETE FROM classes WHERE owner_id = ?`).run(id); // a lecturer's own classes go with them (members cascade)
      q(`DELETE FROM attendance WHERE user_id = ?`).run(id);
      q(`UPDATE attendance_sessions SET started_by = NULL WHERE started_by = ?`).run(id);
      q(`DELETE FROM class_members WHERE user_id = ?`).run(id);
      q(`DELETE FROM fact_reports WHERE user_id = ?`).run(id);
      q(`DELETE FROM verdict_reports WHERE user_id = ?`).run(id);
      q(`UPDATE reports SET user_id = NULL WHERE user_id = ?`).run(id);
      q(`UPDATE lecturer_suggestions SET user_id = NULL WHERE user_id = ?`).run(id);
      q(`DELETE FROM sessions WHERE user_id = ?`).run(id);
      q(`DELETE FROM users WHERE id = ?`).run(id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    res.clearCookie('sid');
    flashRedirect(res, '/', 'ok', 'Your account and all your reviews have been deleted.');
  });

  app.get('/rules', (req, res) => res.page((views.rules(req.ctx))));

  // ---- reviewing ----
  const years = () => { const y = new Date().getFullYear(); return Array.from({ length: 7 }, (_, i) => y - i); };
  function formData(c) {
    const inDept = q(`SELECT * FROM lecturers WHERE dept = ? ORDER BY is_sample, name`).all(c.dept);
    const conv = new Set(c.conveners.split('|').filter(Boolean));
    return { c, conveners: inDept.filter((l) => conv.has(l.name)), others: inDept.filter((l) => !conv.has(l.name)), years: years() };
  }

  // Ratings, votes and tips are students' voice, so staff accounts can read them but not post them.
  const requireStudent = (req, res, next) => (req.user.role === 'staff'
    ? res.status(403).page(views.message(req.ctx, { title: 'Ratings are for students', emoji: '🎓', text: 'Staff accounts can read every review and tip, but only students can rate courses and vote. Lecturers can set up a class for their course instead.', link: { href: '/classes', label: 'Your classes' } }))
    : next());

  app.get('/courses/:code/review', requireUser, requireStudent, (req, res) => {
    const c = getCourse(req.params.code);
    if (!c) return res.status(404).page((notFound(req)));
    res.page((views.reviewForm(req.ctx, formData(c))));
  });

  app.post('/courses/:code/review', requireUser, requireStudent, limits.review, (req, res) => {
    const c = getCourse(req.params.code);
    if (!c) return res.status(404).page((notFound(req)));
    const fail = (error) => res.status(400).page((views.reviewForm(req.ctx, { ...formData(c), values: req.body, error })));
    if (!req.body.agree) return fail('Please confirm your review follows the house rules.');
    const { review, error } = parseReviewForm(req.body);
    if (error) return fail(error);
    let lecturerId = null;
    if (req.body.lecturer_id !== 'none') {
      lecturerId = Number(req.body.lecturer_id);
      if (!q(`SELECT 1 FROM lecturers WHERE id = ? AND dept = ?`).get(lecturerId || 0, c.dept)) return fail('Pick a lecturer from the list, or "Not listed".');
    }
    const screen = screenComment(review.body);
    if (screen.action === 'reject') return fail(`Your comment can't be posted as written: ${screen.reasons.join(', ').toLowerCase()}. Please remove it and try again.`);
    const status = screen.action === 'hold' ? 'held' : 'published';
    try {
      q(`INSERT INTO reviews (course, lecturer_id, year, user_id, teaching, engagement, exams, support, difficulty, workload, overall, tags, body, status, flags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(c.code, lecturerId, review.year, req.user.id, review.teaching, review.engagement, review.exams,
        review.support, review.difficulty, review.workload, review.overall, review.tags, review.body, status, screen.reasons.join('|'));
    } catch (e) {
      if (/UNIQUE/.test(e.message)) return fail("You've already reviewed this lecturer for that year. Delete your old review first if you want to redo it.");
      throw e;
    }
    flashRedirect(res, `/courses/${c.code}`, status === 'held' ? 'info' : 'ok',
      status === 'held' ? 'Thanks! A moderator will check your comment before it goes live.' : 'Thanks! Your review is live. 🤙');
  });

  app.post('/courses/:code/verdict', requireUser, requireStudent, limits.verdict, (req, res) => {
    const c = getCourse(req.params.code);
    if (!c) return res.status(404).page(notFound(req));
    const back = `/courses/${c.code}#verdict`;
    const { verdict, error } = parseVerdictForm(req.body);
    if (error) return flashRedirect(res, back, 'error', error);
    const old = q(`SELECT status, tip, flags FROM verdicts WHERE course = ? AND user_id = ?`).get(c.code, req.user.id);
    if (old?.status === 'removed') return flashRedirect(res, back, 'error', "A moderator removed your vote on this course, so you can't vote on it again.");
    const screen = screenComment(verdict.tip);
    if (screen.action === 'reject') return flashRedirect(res, back, 'error', `Your tip can't be posted as written: ${screen.reasons.join(', ').toLowerCase()}. Please remove it and try again.`);
    // A held tip stays held until a moderator looks at it: resubmitting the same words must not put it back up.
    // Changing the words sends it through screening again.
    const stuck = old?.status === 'held' && old.tip === verdict.tip;
    const status = stuck || screen.action === 'hold' ? 'held' : 'published';
    q(`INSERT INTO verdicts (course, user_id, year, lekker, tip, status, flags) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, course) DO UPDATE SET year = excluded.year, lekker = excluded.lekker, tip = excluded.tip, status = excluded.status, flags = excluded.flags`)
      .run(c.code, req.user.id, verdict.year, verdict.lekker, verdict.tip, status, stuck ? old.flags : screen.reasons.join('|'));
    if (!stuck) q(`DELETE FROM verdict_reports WHERE verdict_id = (SELECT id FROM verdicts WHERE course = ? AND user_id = ?)`).run(c.code, req.user.id);
    flashRedirect(res, back, status === 'held' ? 'info' : 'ok',
      status === 'held' ? 'Thanks! Your vote counts once a moderator has checked your tip.' : `Thanks! You voted ${verdict.lekker ? 'lekker 🤙' : 'nah 👎'}.`);
  });

  app.post('/verdicts/:id/delete', requireUser, (req, res) => {
    const v = q(`SELECT * FROM verdicts WHERE id = ? AND user_id = ?`).get(Number(req.params.id) || 0, req.user.id);
    if (!v) return res.status(404).page(notFound(req));
    // otherwise a removed vote could be deleted and cast again, dodging the block. Deleting the whole account still erases it.
    if (v.status === 'removed') return flashRedirect(res, req.body.back === 'account' ? '/account' : `/courses/${v.course}`, 'error', "A moderator removed this vote, so it can't be deleted or cast again. Deleting your account erases it.");
    q(`DELETE FROM verdicts WHERE id = ?`).run(v.id);
    flashRedirect(res, req.body.back === 'account' ? '/account' : `/courses/${v.course}`, 'ok', 'Your vote was deleted.');
  });

  // Reports come from signed-in students (still anonymous to readers) so one person can't hide everything with a loop.
  // Table names are constants, never user input.
  const signInToReport = (table) => (req, res, next) => {
    if (req.user) return next();
    const course = q(`SELECT course FROM ${table} WHERE id = ?`).get(Number(req.params.id) || 0)?.course;
    flashRedirect(res, `/login?next=${encodeURIComponent(course ? `/courses/${course}` : '/')}`, 'info', 'Sign in to report. Your report stays anonymous.');
  };

  // A tip is one line about the course: it's hidden once ${HIDE_AFTER_REPORTS} different students report it.
  app.post('/verdicts/:id/report', signInToReport('verdicts'), limits.report, (req, res) => {
    const v = q(`SELECT * FROM verdicts WHERE id = ? AND status = 'published' AND tip != ''`).get(Number(req.params.id) || 0);
    if (!v) return flashRedirect(res, '/', 'error', 'That tip was already hidden or removed.');
    const back = `/courses/${v.course}#tips`;
    if (v.user_id === req.user.id) return flashRedirect(res, back, 'error', "That's your own tip. You can delete it from your account.");
    q(`INSERT OR IGNORE INTO verdict_reports (verdict_id, user_id) VALUES (?, ?)`).run(v.id, req.user.id);
    const n = q(`SELECT COUNT(*) AS n FROM verdict_reports WHERE verdict_id = ?`).get(v.id).n;
    if (n >= HIDE_AFTER_REPORTS) q(`UPDATE verdicts SET status = 'held', flags = 'Reported by readers' WHERE id = ?`).run(v.id);
    flashRedirect(res, back, 'ok', n >= HIDE_AFTER_REPORTS ? 'Thanks. That tip is hidden until a moderator checks it.' : 'Thanks. A moderator will take a look.');
  });

  app.get('/courses/:code/suggest-lecturer', requireUser, (req, res) => {
    const c = getCourse(req.params.code);
    if (!c) return res.status(404).page(notFound(req));
    res.page(views.suggestLecturer(req.ctx, { c }));
  });

  app.post('/courses/:code/suggest-lecturer', requireUser, limits.suggest, (req, res) => {
    const c = getCourse(req.params.code);
    if (!c) return res.status(404).page(notFound(req));
    const title = ['Prof', 'Associate Professor', 'Dr', 'Mr', 'Ms', 'Mrs', 'Mx'].find((t) => t === req.body.title);
    const name = String(req.body.name || '').trim().replace(/\s+/g, ' ');
    if (!title || !/^[A-Z][A-Za-z.'’ -]{1,59}$/.test(name)) {
      return res.status(400).page(views.suggestLecturer(req.ctx, { c, values: req.body, error: 'Use initials and surname, letters only, e.g. "J Smith".' }));
    }
    const full = `${title} ${name}`;
    if (q(`SELECT 1 FROM lecturers WHERE dept = ? AND lower(name) = lower(?)`).get(c.dept, full)) {
      return flashRedirect(res, `/courses/${c.code}/review`, 'info', `${full} is already in the list.`);
    }
    q(`INSERT INTO lecturer_suggestions (name, dept, course, user_id) VALUES (?, ?, ?, ?)`).run(full, c.dept, c.code, req.user.id);
    flashRedirect(res, `/courses/${c.code}`, 'ok', 'Thanks! A moderator will check the name and add it, usually within a day or two.');
  });

  app.post('/reviews/:id/delete', requireUser, (req, res) => {
    const r = q(`SELECT * FROM reviews WHERE id = ? AND user_id = ?`).get(Number(req.params.id) || 0, req.user.id);
    if (!r) return res.status(404).page((notFound(req)));
    q(`DELETE FROM reports WHERE review_id = ?`).run(r.id);
    q(`UPDATE takedowns SET review_id = NULL WHERE review_id = ?`).run(r.id);
    q(`DELETE FROM reviews WHERE id = ?`).run(r.id);
    flashRedirect(res, `/courses/${r.course}`, 'ok', 'Your review was deleted.');
  });

  const INSTANT_HIDES_PER_DAY = 3;
  // Approved after a report or removal request: later reports and requests go to the moderator queue without hiding
  // it again, so the same request can't keep a checked review offline.
  const modApproved = (id) => !!q(`SELECT 1 FROM mod_log WHERE review_id = ? AND action = 'approve'`).get(id);
  // Hides a review pending moderation and records why.
  const hold =(id, why) => q(`UPDATE reviews SET status = 'held', flags = CASE WHEN flags = '' THEN ? ELSE flags || '|' || ? END WHERE id = ? AND status = 'published'`).run(why, why, id);

  app.post('/reviews/:id/report', signInToReport('reviews'), limits.report, (req, res) => {
    const r = q(`SELECT * FROM reviews WHERE id = ? AND status != 'removed'`).get(Number(req.params.id) || 0);
    const reason = REPORT_REASONS.find((x) => x.key === req.body.reason);
    if (!r || !reason) return flashRedirect(res, r ? `/courses/${r.course}` : '/', 'error', 'Please pick a reason for the report.');
    if (r.user_id === req.user.id) return flashRedirect(res, `/courses/${r.course}`, 'error', "That's your own review. You can delete it from your account.");
    if (q(`SELECT 1 FROM reports WHERE review_id = ? AND user_id = ?`).get(r.id, req.user.id)) return flashRedirect(res, `/courses/${r.course}`, 'info', 'You already reported this review. A moderator will take a look.');
    q(`INSERT INTO reports (review_id, reason, details, user_id) VALUES (?, ?, ?, ?)`).run(r.id, reason.key, String(req.body.details || '').slice(0, 500), req.user.id);
    const open = q(`SELECT COUNT(*) AS n FROM reports WHERE review_id = ? AND resolved = 0`).get(r.id).n;
    // Serious reasons (a false allegation, private details) hide a review straight away, but one student gets three
    // of those a day; after that a serious report needs a second reporter, like any other.
    const seriousKeys = REPORT_REASONS.filter((x) => x.hideNow).map((x) => x.key);
    const seriousToday = q(`SELECT COUNT(*) AS n FROM reports WHERE user_id = ? AND reason IN (${seriousKeys.map(() => '?').join(',')}) AND created_at > datetime('now', '-1 day')`).get(req.user.id, ...seriousKeys).n;
    const hideNow = (reason.hideNow && seriousToday <= INSTANT_HIDES_PER_DAY) || open >= HIDE_AFTER_REPORTS;
    // a review a moderator already checked and put back stays up until a moderator looks again
    if (hideNow && !modApproved(r.id)) hold(r.id, `Reported: ${reason.label}`);
    flashRedirect(res, `/courses/${r.course}`, 'ok', hideNow && !modApproved(r.id)
      ? 'Thanks. That review is hidden until a moderator checks it.'
      : 'Thanks. A moderator will take a look.');
  });

  // ---- takedown requests (no account needed) ----
  app.get('/takedown', (req, res) => {
    const review = req.query.review ? q(`SELECT * FROM reviews WHERE id = ? AND status != 'removed'`).get(Number(req.query.review) || 0) : null;
    res.page((views.takedown(req.ctx, { review })));
  });

  app.post('/takedown', limits.takedown, (req, res) => {
    const b = req.body;
    const ref = b.review_id || /(?:review-|#|^)(\d+)\s*$/.exec(String(b.review_ref || '').trim())?.[1];
    const review = ref ? q(`SELECT * FROM reviews WHERE id = ?`).get(Number(ref)) : null;
    const name = String(b.name || '').trim().slice(0, 100);
    const email = String(b.email || '').trim().slice(0, 200);
    const details = String(b.details || '').trim().slice(0, 2000);
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || !details) {
      return res.status(400).page((views.takedown(req.ctx, { review, values: b, error: 'Please fill in your name, a valid email and what the problem is.' })));
    }
    q(`INSERT INTO takedowns (review_id, name, email, relation, details) VALUES (?, ?, ?, ?, ?)`).run(review?.id ?? null, name, email, String(b.relation || '').slice(0, 100), details);
    const hidden = review && !modApproved(review.id);
    if (hidden) hold(review.id, 'Removal requested');
    res.page((views.message(req.ctx, {
      title: 'Request received', emoji: '📮',
      text: hidden ? 'The review is now hidden while a moderator looks at it. We aim to reply within 48 hours.' : 'A moderator will look at your request and reply by email, usually within 48 hours.',
      link: { href: '/', label: 'Back to Kwaai' },
    })));
  });

  // ---- sign in: we email a 6-digit code and a link, both one-time ----
  // Only same-site paths are allowed as the page to return to, so a sign-in link can't send anyone elsewhere.
  const safeNext = (s) => (typeof s === 'string' && /^\/(?![/\\])/.test(s) && s.length <= 300 ? s : '/');
  const codeHash = (email, code) => sha(`${email}:${code}`);

  app.get('/login', (req, res) => res.page(views.login(req.ctx, { next: safeNext(req.query.next) })));

  // Brevo's free plan sends 300 emails a day. Stop below that so sign-ins fail with a clear message, not silently.
  // The count lives in the database so a restart (Render's free plan sleeps) doesn't reset it.
  const sentTodayCount = (day) => q('SELECT n FROM email_count WHERE day = ?').get(day)?.n ?? 0;
  app.post('/login', limits.login, limits.loginEmail, limits.loginSend, async (req, res) => {
    const email = normEmail(req.body.email);
    const next = safeNext(req.body.next);
    if (!EMAIL_SHAPE.test(email) || !accountFor(email)) return res.status(400).page(views.login(req.ctx, { email, next, error: 'That isn\'t a UCT email. Students use their @myuct.ac.za address, staff their @uct.ac.za one.' }));
    // POPIA: children's information needs a guardian's consent, so accounts are for students 18 and older
    if (req.body.agree !== '1') return res.status(400).page(views.login(req.ctx, { email, next, error: 'Tick the box to confirm you\'re 18 or older and agree to the terms, house rules and privacy notice.' }));
    if (q(`SELECT 1 FROM users WHERE email = ? AND banned = 1`).get(email)) return res.status(403).page(views.login(req.ctx, { email, next, error: 'This account has been suspended for breaking the house rules.' }));
    const token = crypto.randomBytes(32).toString('hex');
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    const today = new Date().toISOString().slice(0, 10);
    if (sendLoginEmail && sentTodayCount(today) >= emailDailyCap) {
      console.error(`sign-in emails paused: ${emailDailyCap} sent today`);
      return res.status(503).page(views.login(req.ctx, { email, next, error: "Kwaai has sent today's limit of sign-in emails. Please try again tomorrow. If you already have a code from today, it still works." }));
    }
    q(`DELETE FROM login_tokens WHERE expires < ?`).run(Date.now());
    // only the newest code works (older emails' links still do), so guessers face one code at a time
    q(`UPDATE login_tokens SET code_hash = '' WHERE email = ?`).run(email);
    q(`INSERT INTO login_tokens (hash, email, expires, code_hash, next) VALUES (?, ?, ?, ?, ?)`).run(sha(token), email, Date.now() + TOKEN_TTL, codeHash(email, code), next);
    // the link must use the configured BASE_URL whenever real emails go out, never the request's Host header
    const link = `${baseUrl || `${req.protocol}://${req.get('host')}`}/auth/${token}`;
    if (sendLoginEmail) {
      try {
        q('DELETE FROM email_count WHERE day < ?').run(today);
        q('INSERT INTO email_count (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1').run(today);
        await sendLoginEmail(email, { link, code });
      } catch (e) {
        console.error('login email failed:', e.message);
        q(`DELETE FROM login_tokens WHERE hash = ?`).run(sha(token));
        return res.status(502).page(views.login(req.ctx, { email, next, error: "We couldn't send the email just now. Please try again in a minute." }));
      }
    }
    // without an email service (local dev, or a demo with no key) the code and link are shown on screen instead
    const shown = !sendLoginEmail && devMode;
    res.page(views.checkEmail(req.ctx, { email, devLink: shown ? link : null, devCode: shown ? code : null }));
  });

  // ---- the admin account ----
  // One password-only account for testing and moderating, on only when ADMIN_PASSWORD_HASH holds a valid hash (see
  // src/admin.js). It signs in as admin@kwaai.invalid, an address that can't receive mail, so the email sign-in can
  // never reach it. It's a test account: left out of every figure other students see.
  const ADMIN_EMAIL = 'admin@kwaai.invalid';
  const adminOn = Admin.isValidHash(adminPasswordHash);
  const adminLimits = [limit(5, 15 * MIN), limit(20, 24 * 60 * MIN, () => 'admin-login', 'Admin sign-in is paused for today after too many tries.')];
  app.get('/admin/login', (req, res) => (adminOn ? res.page(views.adminLogin(req.ctx, {})) : res.status(404).page(notFound(req))));
  app.post('/admin/login', ...adminLimits, (req, res) => {
    if (!adminOn) return res.status(404).page(notFound(req));
    const sent = Buffer.from(sha(String(req.body.username || '').trim().toLowerCase()));
    const userOk = crypto.timingSafeEqual(sent, Buffer.from(sha(adminUsername.toLowerCase())));
    const passOk = Admin.checkPassword(String(req.body.password || ''), adminPasswordHash); // checked either way, so timing says nothing
    if (!userOk || !passOk) return res.status(401).page(views.adminLogin(req.ctx, { error: "That username and password don't match." }));
    q(`INSERT INTO users (email, uni, is_admin, is_test, agreed_at) VALUES (?, ?, 1, 1, CURRENT_TIMESTAMP) ON CONFLICT(email) DO UPDATE SET is_admin = 1, is_test = 1`).run(ADMIN_EMAIL, CURRENT.slug);
    startSession(req, res, ADMIN_EMAIL, '/study');
  });

  // ---- classes (for lecturers) ----
  // A lecturer (a staff account) creates a class for a course; students join with its code. What each role may do is
  // in can() in src/classes.js. Anyone outside a class, or without the right role, gets a 404, not a hint it exists.
  const classById = (id) => q(`SELECT * FROM classes WHERE id = ?`).get(Number(id) || 0) || null;
  const classByCode = (code) => {
    const c = String(code || '').trim().toUpperCase();
    return /^[A-HJ-NP-Z2-9]{8}$/.test(c) ? q(`SELECT * FROM classes WHERE code = ?`).get(c) || null : null;
  };
  const classMember = (classId, userId) => (userId ? q(`SELECT * FROM class_members WHERE class_id = ? AND user_id = ?`).get(classId, userId) || null : null);
  const classesOf = (userId) => q(`SELECT c.*, m.role, (SELECT COUNT(*) FROM class_members x WHERE x.class_id = c.id AND x.role = 'student') AS students, co.title
    FROM classes c JOIN class_members m ON m.class_id = c.id LEFT JOIN courses co ON co.code = c.course WHERE m.user_id = ? ORDER BY c.year DESC, c.course`).all(userId);
  const joinUrl = (req, cls) => `${req.ctx.site.origin}/c/${cls.code}`;
  const goalFor = (code) => Study.weeklyGoal(getCourse(code) || { code, credits: null }, (t) => semesterWeeks(planYear(), t)) || 6;
  const classForm = (req, extra = {}) => views.classes(req.ctx, { classes: classesOf(req.user.id), staff: req.user.role === 'staff', thisYear: planYear(),
    myGroups: q(`SELECT g.*, c.name AS class_name FROM class_groups g JOIN classes c ON c.id = g.class_id JOIN class_members m ON m.class_id = g.class_id AND m.user_id = g.tutor_id
      WHERE g.tutor_id = ? AND m.role IN ('lecturer', 'tutor') ORDER BY c.name, g.kind DESC, g.name`).all(req.user.id), ...extra });

  app.get('/classes', requireUser, (req, res) => res.page(classForm(req)));

  app.post('/classes', requireUser, limits.classes, (req, res) => {
    if (req.user.role !== 'staff') return res.status(403).page(views.message(req.ctx, { title: 'For lecturers', emoji: '🎓', text: 'Classes are made by lecturers signed in with a @uct.ac.za staff email. Ask your lecturer for the class link to join one.' }));
    const parsed = Classes.parseClassForm(req.body, { course: courseExists, cleanName: Study.cleanName, screen: screenComment, goalFor, thisYear: planYear() });
    const me = Study.cleanName(req.body.me, 60, screenComment);
    const fail = (error) => res.status(400).page(classForm(req, { error, form: req.body }));
    if (parsed.error) return fail(parsed.error);
    if (me.error) return fail(`Your name as students see it: ${me.error}`);
    let code;
    do code = Study.groupCode(crypto.randomBytes(8)); while (q(`SELECT 1 FROM classes WHERE code = ?`).get(code));
    const c = parsed.cls;
    const { lastInsertRowid: id } = q(`INSERT INTO classes (uni, course, year, name, code, owner_id, goal_week_min) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(req.user.uni, c.course, c.year, c.name, code, req.user.id, c.goalWeekMin);
    q(`INSERT INTO class_members (class_id, user_id, role, name, consent_at) VALUES (?, ?, 'lecturer', ?, CURRENT_TIMESTAMP)`).run(id, req.user.id, me.name);
    flashRedirect(res, `/classes/${id}`, 'ok', 'Class made. Share the link or QR code with your students.');
  });

  // ---- joining a class ----
  // /c/CODE: a member sees the class page; anyone else signed in sees what joining shares, then decides. Joining also
  // puts the course in the student's plan, so Today, the week and the timer pick it up.
  const classLecturer = (cls) => q(`SELECT name FROM class_members WHERE class_id = ? AND role = 'lecturer' ORDER BY joined_at LIMIT 1`).get(cls.id)?.name || 'your lecturer';
  const classJoinPage = (req, cls, extra = {}) => views.classJoin(req.ctx, {
    cls, course: getCourse(cls.course), lecturer: classLecturer(cls), staff: req.user.role === 'staff',
    number: Classes.studentNumber(req.user.email), name: profileOf(req.user.id)?.display_name || '', ...extra,
  });

  // minutes each student (and rep) timed for the class's course over a span, each day capped as everywhere else
  function classMinutes(cls, from, to) {
    return q(`SELECT m.user_id, m.name, m.anonymous, m.role, COALESCE(SUM(x.m), 0) AS minutes FROM class_members m LEFT JOIN (
        SELECT user_id, day, MIN(SUM(credited_sec / 60), ${Study.DAY_CAP_MIN}) AS m FROM study_sessions
        WHERE status = 'done' AND course = ? AND day BETWEEN ? AND ? GROUP BY user_id, day
      ) x ON x.user_id = m.user_id WHERE m.class_id = ? AND m.role IN ('student', 'rep') GROUP BY m.user_id`).all(cls.course, from, to, cls.id);
  }
  // Today's "Your classes": each class you're in as a student or rep, with this week's minutes against its goal
  function myClasses(user) {
    const [from, to] = Study.periodRange('week', Study.saDay(Date.now()));
    return q(`SELECT c.* FROM classes c JOIN class_members m ON m.class_id = c.id WHERE m.user_id = ? AND m.role IN ('student', 'rep') ORDER BY c.course`).all(user.id)
      .map((c) => ({ ...c, weekMin: classMinutes(c, from, to).find((r) => r.user_id === user.id)?.minutes || 0 }));
  }

  // Today's announcements: from your classes in the last ANNOUNCE_DAYS days, not yours, and not yet read
  function announcementsFor(user) {
    const since = Date.now() - Classes.ANNOUNCE_DAYS * 24 * 60 * MIN;
    return q(`SELECT a.*, c.code, c.name AS class_name FROM class_announcements a JOIN class_members m ON m.class_id = a.class_id AND m.user_id = ?
      JOIN classes c ON c.id = a.class_id WHERE a.hidden = 0 AND a.created_at > ? AND a.posted_by IS NOT ?
      AND NOT EXISTS (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id AND r.user_id = ?) ORDER BY a.created_at DESC LIMIT 5`).all(user.id, since, user.id, user.id);
  }

  // pulse checks are open until closed or Classes.PULSE_DAYS have passed; options and counts are stored as JSON
  const pulseOpen = (p, now) => !p.closed_at && p.closes_at > now;
  const pulseView = (p, now = Date.now()) => ({ ...p, options: JSON.parse(p.options), counts: JSON.parse(p.counts), open: pulseOpen(p, now) });
  // Today's questions: open, in classes you're in as a student or rep, and not answered yet
  function pulsesFor(user) {
    return q(`SELECT p.*, c.code, c.name AS class_name FROM class_pulses p JOIN class_members m ON m.class_id = p.class_id AND m.user_id = ? AND m.role IN ('student', 'rep')
      JOIN classes c ON c.id = p.class_id WHERE p.closed_at IS NULL AND p.closes_at > ?
      AND NOT EXISTS (SELECT 1 FROM pulse_answered a WHERE a.pulse_id = p.id AND a.user_id = ?) ORDER BY p.asked_at DESC LIMIT 3`).all(user.id, Date.now(), user.id).map((p) => pulseView(p));
  }

  app.get('/c/:code', requireUser, (req, res) => {
    const cls = classByCode(req.params.code);
    if (!cls) return res.status(404).page(notFound(req));
    const me = classMember(cls.id, req.user.id);
    if (!me) return res.page(classJoinPage(req, cls));
    syncRoster(cls);
    Object.assign(me, classMember(cls.id, req.user.id));
    const period = Study.PERIODS[req.query.period] ? req.query.period : 'week';
    const [from, to] = Study.periodRange(period, Study.saDay(Date.now()));
    const shown = (r) => ({ id: r.user_id, rank: r.rank, minutes: r.minutes, you: r.user_id === req.user.id, role: r.role, anon: !!r.anonymous && r.user_id !== req.user.id, name: r.anonymous && r.user_id !== req.user.id ? 'Anonymous' : r.name || 'Anonymous' });
    const rows = classMinutes(cls, from, to);
    const weekMin = classMinutes(cls, ...Study.periodRange('week', Study.saDay(Date.now()))).find((r) => r.user_id === req.user.id)?.minutes || 0;
    const announcements = q(`SELECT * FROM class_announcements WHERE class_id = ? AND hidden = 0 ORDER BY created_at DESC LIMIT 20`).all(cls.id);
    q(`INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id) SELECT id, ? FROM class_announcements WHERE class_id = ? AND hidden = 0`).run(req.user.id, cls.id);
    res.set('Cache-Control', 'no-store').page(views.classPage(req.ctx, {
      cls, me, course: getCourse(cls.course), lecturer: classLecturer(cls), canRun: Classes.can(me, 'dashboard'), period, weekMin,
      ranking: withLooks(Study.rankBoard(rows, req.user.id, 500).rows.map(shown), req.user.id, (r) => r.anon), idle: rows.filter((r) => !r.minutes).length,
      dates: q(`SELECT d.*, m.name AS by_name FROM class_dates d LEFT JOIN class_members m ON m.class_id = d.class_id AND m.user_id = d.added_by WHERE d.class_id = ? AND d.date >= ? ORDER BY d.date, d.time`).all(cls.id, Study.saDay(Date.now())),
      canDates: Classes.can(me, 'dates'), canManage: Classes.can(me, 'manage'), today: Study.saDay(Date.now()),
      announcements, canAnnounce: Classes.can(me, 'announce'),
      groups: q(`SELECT * FROM class_groups WHERE class_id = ? ORDER BY kind DESC, name`).all(cls.id),
      myRow: me.number ? q(`SELECT * FROM class_roster WHERE class_id = ? AND number = ?`).get(cls.id, me.number) || null : null,
      pulses: q(`SELECT p.*, EXISTS (SELECT 1 FROM pulse_answered a WHERE a.pulse_id = p.id AND a.user_id = ?) AS answered FROM class_pulses p
        WHERE p.class_id = ? AND p.closed_at IS NULL AND p.closes_at > ? ORDER BY p.asked_at DESC`).all(req.user.id, cls.id, Date.now()).map((p) => pulseView(p)),
      dpRules: { tut: Classes.dpRule(cls, 'tut'), prac: Classes.dpRule(cls, 'prac') },
      attendance: me.number ? classAttendance(cls.id).of(q(`SELECT * FROM class_roster WHERE class_id = ? AND number = ?`).get(cls.id, me.number) || { number: me.number, tut_group: '', prac_group: '' }) : null,
    }));
  });

  app.post('/c/:code/join', requireUser, limits.classes, (req, res) => {
    const cls = classByCode(req.params.code);
    if (!cls) return res.status(404).page(notFound(req));
    if (classMember(cls.id, req.user.id)) return res.redirect(303, `/c/${cls.code}`);
    if (req.user.role === 'staff') return res.status(403).page(classJoinPage(req, cls));
    const anonymous = req.body.show === 'anon';
    const name = Study.cleanName(req.body.name, 40, screenComment);
    if (!anonymous && name.error) return res.status(400).page(classJoinPage(req, cls, { error: `Your name: ${name.error}`, name: req.body.name }));
    q(`INSERT INTO class_members (class_id, user_id, role, name, anonymous, consent_at) VALUES (?, ?, 'student', ?, ?, CURRENT_TIMESTAMP)`).run(cls.id, req.user.id, name.name || '', anonymous ? 1 : 0);
    syncRoster(cls);
    const { codes, profile, week } = readPlan(req, {});
    if (!codes.includes(cls.course)) savePlan(req, res, [...codes, cls.course], profile, week);
    flashRedirect(res, `/c/${cls.code}`, 'ok', `You're in ${cls.name}.`);
  });

  // class dates: the lecturer, tutors and reps add them; whoever added one, or the lecturer, can remove it
  app.post('/c/:code/dates', requireUser, limits.classes, (req, res) => {
    const cls = classByCode(req.params.code);
    const me = cls && classMember(cls.id, req.user.id);
    if (!Classes.can(me, 'dates')) return res.status(404).page(notFound(req));
    const parsed = Classes.parseClassDate(req.body, Study.saDay(Date.now()), { cleanName: Study.cleanName, screen: screenComment });
    if (parsed.error) return flashRedirect(res, `/c/${cls.code}#dates`, 'error', parsed.error);
    const d = parsed.date;
    q(`INSERT INTO class_dates (class_id, course, type, title, date, time, added_by, added_role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(cls.id, cls.course, d.type, d.title, d.date, d.time, req.user.id, me.role);
    flashRedirect(res, `/c/${cls.code}#dates`, 'ok', `Added: ${d.title} on ${d.date}. Everyone with ${cls.course} in their plan sees it.`);
  });

  app.post('/c/:code/dates/:id/delete', requireUser, limits.classes, (req, res) => {
    const cls = classByCode(req.params.code);
    const me = cls && classMember(cls.id, req.user.id);
    const d = me && q(`SELECT * FROM class_dates WHERE id = ? AND class_id = ?`).get(Number(req.params.id) || 0, cls.id);
    if (!d || !Classes.can(me, 'dates') || (d.added_by !== req.user.id && !Classes.can(me, 'manage'))) return res.status(404).page(notFound(req));
    q(`DELETE FROM class_dates WHERE id = ?`).run(d.id);
    flashRedirect(res, `/c/${cls.code}#dates`, 'ok', 'Removed.');
  });

  // ---- pulse checks ----
  // The lecturer or a tutor asks; students and reps answer once each. Only the counts are kept, so nobody (the
  // lecturer included) can see who chose what. A pulse closes when they close it or after Classes.PULSE_DAYS.
  app.post('/classes/:id/pulse', requireUser, limits.classes, (req, res) => {
    const found = classForRunners(req, 'pulse');
    if (!found) return res.status(404).page(notFound(req));
    const back = (type, text) => flashRedirect(res, `/classes/${found.cls.id}#pulse`, type, text);
    const parsed = Classes.parsePulse(req.body, screenComment);
    if (parsed.error) return back('error', parsed.error);
    const now = Date.now();
    q(`INSERT INTO class_pulses (class_id, question, options, counts, asked_by, asked_at, closes_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(found.cls.id, parsed.question, JSON.stringify(parsed.options), JSON.stringify(parsed.options.map(() => 0)), req.user.id, now, now + Classes.PULSE_DAYS * 24 * 60 * MIN);
    back('ok', `Asked. Students see it on the class page and on Today. It closes by itself in ${Classes.PULSE_DAYS} days.`);
  });

  app.post('/classes/:id/pulse/:pid/close', requireUser, limits.classes, (req, res) => {
    const found = classForRunners(req, 'pulse');
    const p = found && q(`SELECT * FROM class_pulses WHERE id = ? AND class_id = ?`).get(Number(req.params.pid) || 0, found.cls.id);
    if (!p) return res.status(404).page(notFound(req));
    q(`UPDATE class_pulses SET closed_at = COALESCE(closed_at, ?) WHERE id = ?`).run(Date.now(), p.id);
    flashRedirect(res, `/classes/${found.cls.id}#pulse`, 'ok', 'Closed. The results stay here.');
  });

  app.post('/c/:code/pulse/:pid', requireUser, limits.classes, (req, res) => {
    const cls = classByCode(req.params.code);
    const me = cls && classMember(cls.id, req.user.id);
    const p = me && ['student', 'rep'].includes(me.role) && q(`SELECT * FROM class_pulses WHERE id = ? AND class_id = ?`).get(Number(req.params.pid) || 0, cls.id);
    if (!p) return res.status(404).page(notFound(req));
    const back = req.body.back === 'today' ? '/today' : `/c/${cls.code}#pulse`;
    const counts = JSON.parse(p.counts);
    const choice = Number(req.body.choice);
    if (!Number.isInteger(choice) || choice < 0 || choice >= counts.length) return flashRedirect(res, back, 'error', 'Pick one of the answers.');
    if (!pulseOpen(p, Date.now())) return flashRedirect(res, back, 'error', 'That question has closed.');
    db.exec('BEGIN');
    try {
      const { changes } = q(`INSERT OR IGNORE INTO pulse_answered (pulse_id, user_id) VALUES (?, ?)`).run(p.id, req.user.id);
      if (changes) {
        counts[choice] += 1;
        q(`UPDATE class_pulses SET counts = ? WHERE id = ?`).run(JSON.stringify(counts), p.id);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    flashRedirect(res, back, 'ok', 'Thanks. Your answer is counted, and nobody can see which one you picked.');
  });

  // ---- class announcements ----
  // The lecturer, tutors and reps post them. The poster or the lecturer can delete one. Any other member can report
  // one, and HIDE_AFTER_REPORTS reports from different members hide it until a moderator looks.
  app.post('/c/:code/announcements', requireUser, limits.classes, (req, res) => {
    const cls = classByCode(req.params.code);
    const me = cls && classMember(cls.id, req.user.id);
    if (!Classes.can(me, 'announce')) return res.status(404).page(notFound(req));
    const parsed = Classes.parseAnnouncement(req.body.body, screenComment);
    if (parsed.error) return flashRedirect(res, `/c/${cls.code}#announcements`, 'error', parsed.error);
    q(`INSERT INTO class_announcements (class_id, body, posted_by, poster_name, poster_role, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(cls.id, parsed.text, req.user.id, me.name || Classes.ROLE_NAMES[me.role], me.role, Date.now());
    flashRedirect(res, `/c/${cls.code}#announcements`, 'ok', `Posted. Members see it here and on their Today page for ${Classes.ANNOUNCE_DAYS} days.`);
  });

  app.post('/c/:code/announcements/:id/delete', requireUser, limits.classes, (req, res) => {
    const cls = classByCode(req.params.code);
    const me = cls && classMember(cls.id, req.user.id);
    const a = me && q(`SELECT * FROM class_announcements WHERE id = ? AND class_id = ?`).get(Number(req.params.id) || 0, cls.id);
    if (!a || (a.posted_by !== req.user.id && !Classes.can(me, 'manage'))) return res.status(404).page(notFound(req));
    q(`DELETE FROM class_announcements WHERE id = ?`).run(a.id);
    flashRedirect(res, `/c/${cls.code}#announcements`, 'ok', 'Announcement deleted.');
  });

  // "Got it" on Today: the announcement leaves your Today (opening the class page does the same)
  app.post('/announcements/:id/read', requireUser, (req, res) => {
    const a = q(`SELECT * FROM class_announcements WHERE id = ?`).get(Number(req.params.id) || 0);
    if (!a || !classMember(a.class_id, req.user.id)) return res.status(404).page(notFound(req));
    q(`INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id) VALUES (?, ?)`).run(a.id, req.user.id);
    res.redirect(303, '/today');
  });

  app.post('/announcements/:id/report', requireUser, limits.report, (req, res) => {
    const a = q(`SELECT a.*, c.code FROM class_announcements a JOIN classes c ON c.id = a.class_id WHERE a.id = ? AND a.hidden = 0`).get(Number(req.params.id) || 0);
    if (!a || !classMember(a.class_id, req.user.id)) return res.status(404).page(notFound(req));
    const back = `/c/${a.code}#announcements`;
    if (a.posted_by === req.user.id) return flashRedirect(res, back, 'error', "That's your own announcement. You can delete it instead.");
    q(`INSERT OR IGNORE INTO announcement_reports (announcement_id, user_id) VALUES (?, ?)`).run(a.id, req.user.id);
    const n = q(`SELECT COUNT(*) AS n FROM announcement_reports WHERE announcement_id = ?`).get(a.id).n;
    if (n >= HIDE_AFTER_REPORTS) q(`UPDATE class_announcements SET hidden = 1 WHERE id = ?`).run(a.id);
    flashRedirect(res, back, 'ok', n >= HIDE_AFTER_REPORTS ? 'Thanks. That announcement is hidden until a moderator checks it.' : 'Thanks. A moderator will take a look.');
  });

  app.post('/c/:code/leave', requireUser, (req, res) => {
    const cls = classByCode(req.params.code);
    const me = cls && classMember(cls.id, req.user.id);
    if (!me || me.role === 'lecturer') return res.status(404).page(notFound(req));
    dropFromRoster(cls.id, req.user.id);
    q(`DELETE FROM class_members WHERE class_id = ? AND user_id = ?`).run(cls.id, req.user.id);
    flashRedirect(res, '/classes', 'ok', `You've left ${cls.name}. Your lecturer no longer sees you in it.`);
  });

  // Every student (and rep) in a class with their progress on the course: minutes this week and month, the goal %,
  // when they last studied it, how many of the last 14 days, and whether they need a nudge. Only that course counts.
  // ---- the class list ----
  // Everyone on the lecturer's pasted list plus everyone who joined, by student number. A member gets a row of their
  // own (source 'joined') if they aren't on the list, so registers and DP cover the whole class either way.
  function syncRoster(cls) {
    for (const m of q(`SELECT m.user_id, u.email FROM class_members m JOIN users u ON u.id = m.user_id WHERE m.class_id = ? AND m.number = ''`).all(cls.id)) {
      const number = Classes.studentNumber(m.email);
      if (number) q(`UPDATE class_members SET number = ? WHERE class_id = ? AND user_id = ?`).run(number, cls.id, m.user_id);
    }
    // a pasted list is kept until 30 days after the class's year ends
    if (Study.saDay(Date.now()) >= `${cls.year + 1}-01-31`) q(`DELETE FROM class_roster WHERE class_id = ? AND source = 'list'`).run(cls.id);
    q(`INSERT OR IGNORE INTO class_roster (class_id, number, name, source) SELECT class_id, number, name, 'joined' FROM class_members
      WHERE class_id = ? AND number != '' AND role IN ('student', 'rep')`).run(cls.id);
  }
  // when a member leaves or is removed, their row goes too, unless it came from the lecturer's list
  const dropFromRoster = (classId, userId) => q(`DELETE FROM class_roster WHERE class_id = ? AND source = 'joined'
    AND number = (SELECT number FROM class_members WHERE class_id = ? AND user_id = ?)`).run(classId, classId, userId);

  // everyone's attendance in a class, from its sessions, groups and marks (the rules are Classes.attendanceOf)
  function classAttendance(classId) {
    const sessions = q(`SELECT id, group_id, kind, label, started_at, ended_at FROM attendance_sessions WHERE class_id = ?`).all(classId);
    const groups = new Map(q(`SELECT id, kind, name FROM class_groups WHERE class_id = ?`).all(classId).map((g) => [g.id, g]));
    const marks = new Map(q(`SELECT a.session_id, a.number, a.status FROM attendance a JOIN attendance_sessions s ON s.id = a.session_id WHERE s.class_id = ?`).all(classId)
      .map((m) => [`${m.session_id}|${m.number}`, m.status]));
    return { sessions, of: (row) => Classes.attendanceOf(row, sessions, groups, marks) };
  }

  // a student's DP for each kind the class has a rule for, from their attendance history
  function classDp(cls, history) {
    const dp = {};
    for (const kind of ['tut', 'prac']) {
      const rule = Classes.dpRule(cls, kind);
      if (rule) dp[kind] = Classes.dpFor(history, rule, kind);
    }
    return dp;
  }
  // Today's warnings: classes you're in as a student where your attendance puts DP at risk or out of reach
  function dpAlertsFor(user) {
    if (!user) return [];
    const out = [];
    for (const cls of q(`SELECT c.*, m.number FROM classes c JOIN class_members m ON m.class_id = c.id WHERE m.user_id = ? AND m.role IN ('student', 'rep') AND m.number != ''
        AND (c.dp_tut_planned > 0 OR c.dp_prac_planned > 0)`).all(user.id)) {
      const row = q(`SELECT * FROM class_roster WHERE class_id = ? AND number = ?`).get(cls.id, cls.number);
      if (!row) continue;
      for (const [kind, d] of Object.entries(classDp(cls, classAttendance(cls.id).of(row).history))) if (d.state !== 'ok') out.push({ code: cls.code, name: cls.name, kind, ...d });
    }
    return out;
  }
  const DASH_SORTS = {
    week: (a, b) => b.week - a.week,
    name: (a, b) => a.name.localeCompare(b.name),
    number: (a, b) => a.number.localeCompare(b.number),
    last: (a, b) => (b.last || '').localeCompare(a.last || ''),
  };
  function classDashboard(cls, sort = 'week') {
    syncRoster(cls);
    const today = Study.saDay(Date.now());
    const minutesIn = (period) => new Map(classMinutes(cls, ...Study.periodRange(period, today)).map((r) => [r.user_id, r.minutes]));
    const week = minutesIn('week');
    const month = minutesIn('month');
    const activity = new Map(q(`SELECT user_id, MAX(day) AS last, COUNT(DISTINCT CASE WHEN day >= ? THEN day END) AS days14 FROM study_sessions
      WHERE status = 'done' AND course = ? AND credited_sec >= 60 AND user_id IN (SELECT user_id FROM class_members WHERE class_id = ?) GROUP BY user_id`)
      .all(Study.addDay(today, -13), cls.course, cls.id).map((r) => [r.user_id, r]));
    const dow = Study.weekdayOf(today);
    const att = classAttendance(cls.id);
    const rows = q(`SELECT r.number, r.name AS list_name, r.tut_group, r.prac_group, r.source, m.user_id, m.name, m.anonymous, m.role
      FROM class_roster r LEFT JOIN class_members m ON m.class_id = r.class_id AND m.number = r.number AND m.role IN ('student', 'rep') WHERE r.class_id = ?`).all(cls.id)
      .map((m) => {
        const onKwaai = m.user_id != null;
        const a = att.of({ number: m.number, tut_group: m.tut_group, prac_group: m.prac_group });
        const dp = classDp(cls, a.history);
        const r = { id: m.user_id, number: m.number, name: (onKwaai ? m.name : m.list_name) || '(no name)', onKwaai, onList: m.source === 'list', anonymous: !!m.anonymous, role: m.role || 'student',
          tut: m.tut_group, prac: m.prac_group,
          week: week.get(m.user_id) || 0, month: month.get(m.user_id) || 0, last: activity.get(m.user_id)?.last || null, days14: activity.get(m.user_id)?.days14 || 0,
          attended: a.present + a.late, excused: a.excused, sessions: a.held, history: a.history };
        return { ...r, pct: Math.round((r.week / cls.goal_week_min) * 100), nudge: onKwaai && Classes.needsNudge({ weekMin: r.week, lastDay: r.last }, cls.goal_week_min, dow, today),
          dp, flags: Classes.riskFlags({ history: a.history, dp, onKwaai, days14: r.days14, course: cls.course }) };
      })
      .sort(DASH_SORTS[sort] || DASH_SORTS.week);
    const weeks = rows.filter((r) => r.onKwaai).map((r) => r.week).sort((a, b) => a - b);
    const median = weeks.length ? (weeks.length % 2 ? weeks[weeks.length >> 1] : Math.round((weeks[weeks.length / 2 - 1] + weeks[weeks.length / 2]) / 2)) : 0;
    const soFar = Classes.goalSoFar(cls.goal_week_min, dow);
    return { rows, totals: { sessions: att.sessions.length, students: rows.length, onKwaai: rows.filter((r) => r.onKwaai).length, listed: rows.filter((r) => r.onList).length, median, onTrack: rows.filter((r) => r.onKwaai && r.week >= soFar).length, nudge: rows.filter((r) => r.nudge).length, atRisk: rows.filter((r) => r.flags.length).length, soFar } };
  }
  const classForRunners = (req, action = 'dashboard') => {
    const cls = classById(req.params.id);
    const me = cls && classMember(cls.id, req.user.id);
    return Classes.can(me, action) ? { cls, me } : null;
  };

  // the class's page for the people who run it: how students join, and the dashboard
  app.get('/classes/:id', requireUser, (req, res) => {
    const found = classForRunners(req);
    if (!found) return res.status(404).page(notFound(req));
    const { cls, me } = found;
    const link = joinUrl(req, cls);
    const sort = DASH_SORTS[req.query.sort] ? req.query.sort : 'week';
    res.set('Cache-Control', 'no-store').page(views.classAdmin(req.ctx, {
      cls, me, course: getCourse(cls.course), link, qr: Classes.qrSvg(link), sort, onlyNudge: req.query.filter === 'nudge', onlyRisk: req.query.filter === 'risk', manage: Classes.can(me, 'manage'), ...classDashboard(cls, sort),
      tutors: q(`SELECT m.user_id, m.name, u.email FROM class_members m JOIN users u ON u.id = m.user_id WHERE m.class_id = ? AND m.role = 'tutor' ORDER BY m.name`).all(cls.id),
      sessions: q(`SELECT s.*, (SELECT COUNT(*) FROM attendance a WHERE a.session_id = s.id AND a.status IN ('present', 'late')) AS present FROM attendance_sessions s WHERE s.class_id = ? ORDER BY s.started_at DESC LIMIT 12`).all(cls.id),
      canPulse: Classes.can(me, 'pulse'), pulsePreset: Classes.PULSE_PRESET,
      groups: groupAttendance(cls.id, classGroupsOf(cls.id)), staff: q(`SELECT user_id, name, role FROM class_members WHERE class_id = ? AND role IN ('lecturer', 'tutor') ORDER BY role, name`).all(cls.id),
      pulses: q(`SELECT * FROM class_pulses WHERE class_id = ? ORDER BY asked_at DESC LIMIT 10`).all(cls.id).map((p) => pulseView(p)),
    }));
  });

  app.get('/classes/:id/students.csv', requireUser, (req, res) => {
    const found = classForRunners(req);
    if (!found) return res.status(404).page(notFound(req));
    const { cls } = found;
    const { rows } = classDashboard(cls, 'number');
    const lines = [Classes.csvRow(['student_number', 'name', 'anonymous_to_classmates', 'role', 'minutes_this_week', 'minutes_this_month', 'goal_percent_this_week', 'last_studied', 'days_studied_last_14', 'needs_a_nudge', 'sessions_attended', 'sessions_held', 'on_kwaai', 'on_class_list', 'sessions_excused', 'tut_dp', 'prac_dp', 'flags'])]
      .concat(rows.map((r) => Classes.csvRow((r.onKwaai
        ? [r.number, r.name, r.anonymous ? 'yes' : 'no', r.role, r.week, r.month, r.pct, r.last || '', r.days14, r.nudge ? 'yes' : 'no', r.attended, r.sessions, 'yes', r.onList ? 'yes' : 'no']
        : [r.number, r.name, '', r.role, '', '', '', '', '', '', r.attended, r.sessions, 'no', 'yes'])
        .concat([r.excused, r.dp.tut?.state || '', r.dp.prac?.state || '', r.flags.map((x) => x.text).join('; ')]))));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${cls.course}-${cls.year}-students.csv"`, 'Cache-Control': 'no-store' }).send(lines.join('\r\n') + '\r\n');
  });

  // The register for Excel: a row per student, a column per session (P present, L late, E excused, A absent; empty if
  // the session wasn't for their group or is still open), then totals and DP.
  app.get('/classes/:id/register.csv', requireUser, (req, res) => {
    const found = classForRunners(req);
    if (!found) return res.status(404).page(notFound(req));
    const { cls } = found;
    const { rows } = classDashboard(cls, 'number');
    const sessions = classAttendance(cls.id).sessions.slice().sort((a, b) => a.started_at - b.started_at);
    const lines = [Classes.csvRow(['student_number', 'name', 'tut_group', 'prac_group', ...sessions.map((s) => `${s.label} (${Study.saDay(s.started_at)})`),
      'attended', 'held', 'attendance_percent', 'excused', 'tut_dp', 'prac_dp'])];
    for (const r of rows) {
      const byId = new Map(r.history.map((h) => [h.id, h]));
      const all = Classes.attendancePercent(r.history, '', !!cls.dp_late_counts);
      lines.push(Classes.csvRow([r.number, r.name, r.tut || '', r.prac || '', ...sessions.map((s) => Classes.registerLetter(byId.get(s.id))),
        all.attended, all.held, all.pct ?? '', r.excused, r.dp.tut?.state || '', r.dp.prac?.state || '']));
    }
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${cls.course}-${cls.year}-register.csv"`, 'Cache-Control': 'no-store' }).send(lines.join('\r\n') + '\r\n');
  });

  // Tut attendance as a grade to import into Amathuba (Brightspace): its grade import columns, with the student number
  // as the user. The course needs a numeric grade item called "Tut attendance" out of 100. Pracs are used when the class
  // has no tuts. Not yet confirmed against UCT's Amathuba: the button says to check with the course admin.
  app.get('/classes/:id/amathuba.csv', requireUser, (req, res) => {
    const found = classForRunners(req);
    if (!found) return res.status(404).page(notFound(req));
    const { cls } = found;
    const { rows } = classDashboard(cls, 'number');
    const hasTuts = classAttendance(cls.id).sessions.some((s) => s.kind === 'tut');
    const item = hasTuts ? 'Tut attendance' : 'Prac attendance';
    const lines = [Classes.csvRow(['OrgDefinedId', 'Username', `${item} Points Grade <Numeric MaxPoints:100>`, 'End-of-Line Indicator'])];
    for (const r of rows) {
      const { pct } = Classes.attendancePercent(r.history, hasTuts ? 'tut' : 'prac', !!cls.dp_late_counts);
      lines.push(Classes.csvRow([`#${r.number}`, `#${r.number.toLowerCase()}`, pct ?? '', '#']));
    }
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${cls.course}-${cls.year}-amathuba-grades.csv"`, 'Cache-Control': 'no-store' }).send(lines.join('\r\n') + '\r\n');
  });

  app.post('/classes/:id/edit', requireUser, limits.classes, (req, res) => {
    const found = classForRunners(req, 'manage');
    if (!found) return res.status(404).page(notFound(req));
    const { cls } = found;
    const name = Study.cleanName(req.body.name, 60, screenComment);
    const hours = Number(req.body.goal);
    if (name.error) return flashRedirect(res, `/classes/${cls.id}`, 'error', `Class name: ${name.error}`);
    if (!(hours >= 1 && hours <= 40)) return flashRedirect(res, `/classes/${cls.id}`, 'error', 'Set a weekly goal of 1 to 40 hours.');
    q(`UPDATE classes SET name = ?, goal_week_min = ? WHERE id = ?`).run(name.name, Math.round(hours * 60), cls.id);
    flashRedirect(res, `/classes/${cls.id}`, 'ok', 'Saved.');
  });

  // A class rep shows their full name with a badge, can post announcements and add dates, but never sees student
  // numbers or the dashboard. The lecturer appoints them with their full name, which turns anonymous off in this class.
  app.post('/classes/:id/rep', requireUser, limits.classes, (req, res) => {
    const found = classForRunners(req, 'manage');
    const who = found && classMember(found.cls.id, Number(req.body.user));
    if (!who || !['student', 'rep'].includes(who.role)) return res.status(404).page(notFound(req));
    const back = (type, text) => flashRedirect(res, `/classes/${found.cls.id}`, type, text);
    if (req.body.make !== '1') {
      q(`UPDATE class_members SET role = 'student' WHERE class_id = ? AND user_id = ?`).run(found.cls.id, who.user_id);
      return back('ok', `${who.name} is no longer the class rep.`);
    }
    const name = Study.cleanName(req.body.name, 60, screenComment);
    if (name.error || name.name.split(' ').length < 2) return back('error', 'A class rep shows their full name: give a first name and a surname.');
    q(`UPDATE class_members SET role = 'rep', name = ?, anonymous = 0 WHERE class_id = ? AND user_id = ?`).run(name.name, found.cls.id, who.user_id);
    back('ok', `${name.name} is the class rep now.`);
  });

  // ---- tut and prac groups ----
  // a student's own groups in the classes they're in, for their week, Today and calendar file
  function classSlotsFor(user) {
    const out = {};
    if (!user) return out;
    for (const g of q(`SELECT c.course, g.kind, g.name, g.day, g.starts, g.ends, g.venue FROM class_members m JOIN classes c ON c.id = m.class_id
        JOIN class_roster r ON r.class_id = m.class_id AND r.number = m.number
        JOIN class_groups g ON g.class_id = m.class_id AND ((g.kind = 'tut' AND g.name = r.tut_group) OR (g.kind = 'prac' AND g.name = r.prac_group))
        WHERE m.user_id = ? AND m.role IN ('student', 'rep')`).all(user.id)) (out[g.course] ||= {})[g.kind] = g;
    return out;
  }
  // a class's groups with their tutor's name and how many students are in each
  const classGroupsOf = (classId) => q(`SELECT g.*, m.name AS tutor_name,
      (SELECT COUNT(*) FROM class_roster r WHERE r.class_id = g.class_id AND ((g.kind = 'tut' AND r.tut_group = g.name) OR (g.kind = 'prac' AND r.prac_group = g.name))) AS students
    FROM class_groups g LEFT JOIN class_members m ON m.class_id = g.class_id AND m.user_id = g.tutor_id WHERE g.class_id = ? ORDER BY g.kind DESC, g.name`).all(classId);
  // groups named on the class list are made for the lecturer, who then only adds their times and venues
  function groupsFromRoster(classId) {
    q(`INSERT OR IGNORE INTO class_groups (class_id, kind, name) SELECT DISTINCT class_id, 'tut', tut_group FROM class_roster WHERE class_id = ? AND tut_group != ''`).run(classId);
    q(`INSERT OR IGNORE INTO class_groups (class_id, kind, name) SELECT DISTINCT class_id, 'prac', prac_group FROM class_roster WHERE class_id = ? AND prac_group != ''`).run(classId);
  }
  const GROUP_COLUMN = { tut: 'tut_group', prac: 'prac_group' };

  // the lecturer pastes the class list; "replace" swaps the old list for this one, "add" adds to it. The first paste
  // needs a tick: they run the course and may use its list for registers.
  app.post('/classes/:id/roster', requireUser, limits.classes, (req, res) => {
    const found = classForRunners(req, 'manage');
    if (!found) return res.status(404).page(notFound(req));
    const { cls } = found;
    const back = (type, text) => flashRedirect(res, `/classes/${cls.id}#roster`, type, text);
    if (!cls.roster_confirmed_at && req.body.confirm !== '1') return back('error', 'Tick the box to confirm you run this course and may use its class list for registers.');
    const parsed = Classes.parseRoster(req.body.list);
    if (parsed.error) return back('error', parsed.error);
    db.exec('BEGIN');
    try {
      if (!cls.roster_confirmed_at) q(`UPDATE classes SET roster_confirmed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(cls.id);
      if (req.body.mode === 'replace') q(`DELETE FROM class_roster WHERE class_id = ? AND source = 'list'`).run(cls.id);
      const put = q(`INSERT INTO class_roster (class_id, number, name, tut_group, prac_group, source) VALUES (?, ?, ?, ?, ?, 'list')
        ON CONFLICT (class_id, number) DO UPDATE SET name = excluded.name, source = 'list',
          tut_group = CASE WHEN excluded.tut_group != '' THEN excluded.tut_group ELSE class_roster.tut_group END,
          prac_group = CASE WHEN excluded.prac_group != '' THEN excluded.prac_group ELSE class_roster.prac_group END`);
      for (const r of parsed.rows) put.run(cls.id, r.number, r.name, r.tut, r.prac);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    syncRoster(cls);
    groupsFromRoster(cls.id);
    const onKwaai = q(`SELECT COUNT(*) AS n FROM class_roster r JOIN class_members m ON m.class_id = r.class_id AND m.number = r.number WHERE r.class_id = ? AND r.source = 'list'`).get(cls.id).n;
    const skipped = parsed.skipped.length ? ` Skipped line${parsed.skipped.length === 1 ? '' : 's'} ${parsed.skipped.slice(0, 5).join(', ')}${parsed.skipped.length > 5 ? ' and more' : ''}: no student number at the start.` : '';
    back('ok', `${parsed.rows.length} students saved to the class list. ${onKwaai} of the list ${onKwaai === 1 ? 'is' : 'are'} on Kwaai.${skipped}`);
  });

  // each group's attendance: of the places in its sessions (sessions x students), how many were present or late
  function groupAttendance(classId, groups) {
    const held = new Map(q(`SELECT s.group_id, COUNT(*) AS n, (SELECT COUNT(*) FROM attendance a JOIN attendance_sessions x ON x.id = a.session_id
        WHERE x.class_id = s.class_id AND x.group_id = s.group_id AND a.status IN ('present', 'late')) AS here
      FROM attendance_sessions s WHERE s.class_id = ? AND s.group_id IS NOT NULL GROUP BY s.group_id`).all(classId).map((r) => [r.group_id, r]));
    return groups.map((g) => {
      const h = held.get(g.id);
      return { ...g, sessionsHeld: h?.n || 0, rate: h && g.students ? Math.round((h.here / (h.n * g.students)) * 100) : null };
    });
  }

  // the lecturer sets the DP rule for attendance
  app.post('/classes/:id/dp', requireUser, limits.classes, (req, res) => {
    const found = classForRunners(req, 'manage');
    if (!found) return res.status(404).page(notFound(req));
    const num = (v, max) => Math.round(Number(v));
    const fields = { tut_planned: [req.body.tut_planned, 60], tut_pct: [req.body.tut_pct, 100], prac_planned: [req.body.prac_planned, 60], prac_pct: [req.body.prac_pct, 100] };
    const v = {};
    for (const [k, [raw, max]] of Object.entries(fields)) {
      const n = num(raw === '' || raw == null ? 0 : raw, max);
      if (!Number.isInteger(n) || n < 0 || n > max) return flashRedirect(res, `/classes/${found.cls.id}#dp`, 'error', `Use whole numbers: up to ${max} for ${k.includes('pct') ? 'a percentage' : 'sessions'}.`);
      v[k] = n;
    }
    q(`UPDATE classes SET dp_tut_planned = ?, dp_tut_pct = ?, dp_prac_planned = ?, dp_prac_pct = ?, dp_late_counts = ? WHERE id = ?`)
      .run(v.tut_planned, v.tut_pct, v.prac_planned, v.prac_pct, req.body.late === '1' ? 1 : 0, found.cls.id);
    flashRedirect(res, `/classes/${found.cls.id}#dp`, 'ok', 'DP rule saved. Students see where they stand on their class page and on Today.');
  });

  // the lecturer adds a group, or edits one (renaming it moves its students along; its kind stays)
  app.post('/classes/:id/groups', requireUser, limits.classes, (req, res) => {
    const found = classForRunners(req, 'manage');
    if (!found) return res.status(404).page(notFound(req));
    const { cls } = found;
    const back = (type, text) => flashRedirect(res, `/classes/${cls.id}#groups`, type, text);
    const old = req.body.group ? q(`SELECT * FROM class_groups WHERE id = ? AND class_id = ?`).get(Number(req.body.group) || 0, cls.id) : null;
    if (req.body.group && !old) return res.status(404).page(notFound(req));
    const parsed = Classes.parseGroup({ ...req.body, kind: old ? old.kind : req.body.kind });
    if (parsed.error) return back('error', parsed.error);
    const g = parsed.group;
    const tutor = Number(req.body.tutor) || null;
    if (tutor && !['tutor', 'lecturer'].includes(classMember(cls.id, tutor)?.role)) return back('error', 'Pick one of the class tutors, or nobody.');
    const same = q(`SELECT id FROM class_groups WHERE class_id = ? AND kind = ? AND name = ?`).get(cls.id, g.kind, g.name);
    if (same && same.id !== old?.id) return back('error', `There's already a ${g.kind} group called ${g.name}.`);
    if (old) {
      q(`UPDATE class_groups SET name = ?, day = ?, starts = ?, ends = ?, venue = ?, tutor_id = ? WHERE id = ?`).run(g.name, g.day, g.starts, g.ends, g.venue, tutor, old.id);
      if (old.name !== g.name) q(`UPDATE class_roster SET ${GROUP_COLUMN[old.kind]} = ? WHERE class_id = ? AND ${GROUP_COLUMN[old.kind]} = ?`).run(g.name, cls.id, old.name);
    } else {
      q(`INSERT INTO class_groups (class_id, kind, name, day, starts, ends, venue, tutor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(cls.id, g.kind, g.name, g.day, g.starts, g.ends, g.venue, tutor);
    }
    back('ok', `${g.name} ${old ? 'saved' : 'added'}.${g.day ? '' : ' Add its day and time so it shows on students\' timetables.'}`);
  });

  app.post('/classes/:id/groups/:gid/delete', requireUser, limits.classes, (req, res) => {
    const found = classForRunners(req, 'manage');
    const g = found && q(`SELECT * FROM class_groups WHERE id = ? AND class_id = ?`).get(Number(req.params.gid) || 0, found.cls.id);
    if (!g) return res.status(404).page(notFound(req));
    q(`UPDATE class_roster SET ${GROUP_COLUMN[g.kind]} = '' WHERE class_id = ? AND ${GROUP_COLUMN[g.kind]} = ?`).run(g.class_id, g.name);
    q(`DELETE FROM class_groups WHERE id = ?`).run(g.id);
    flashRedirect(res, `/classes/${g.class_id}#groups`, 'ok', `${g.name} deleted. Its students have no ${g.kind} group now.`);
  });

  // a student picks their own group, unless the lecturer's list already puts them in one
  app.post('/c/:code/group', requireUser, limits.classes, (req, res) => {
    const cls = classByCode(req.params.code);
    const me = cls && classMember(cls.id, req.user.id);
    if (!me || !['student', 'rep'].includes(me.role) || !GROUP_COLUMN[req.body.kind]) return res.status(404).page(notFound(req));
    syncRoster(cls);
    const number = classMember(cls.id, req.user.id).number;
    const row = q(`SELECT * FROM class_roster WHERE class_id = ? AND number = ?`).get(cls.id, number);
    const col = GROUP_COLUMN[req.body.kind];
    const back = (type, text) => flashRedirect(res, `/c/${cls.code}#groups`, type, text);
    if (!row) return back('error', 'Your account has no student number, so you can\'t be in a group.');
    if (row.source === 'list' && row[col]) return back('error', `Your lecturer's list puts you in ${row[col]}. Ask them if that's wrong.`);
    const g = req.body.group ? q(`SELECT * FROM class_groups WHERE id = ? AND class_id = ? AND kind = ?`).get(Number(req.body.group) || 0, cls.id, req.body.kind) : null;
    if (req.body.group && !g) return back('error', 'Pick one of the groups.');
    q(`UPDATE class_roster SET ${col} = ? WHERE class_id = ? AND number = ?`).run(g ? g.name : '', cls.id, number);
    back('ok', g ? `You're in ${g.name}. It's on your week${g.day ? '' : ' once the lecturer adds its time'}.` : `You're not in a ${req.body.kind} group now.`);
  });

  app.post('/classes/:id/roster/remove', requireUser, limits.classes, (req, res) => {
    const found = classForRunners(req, 'manage');
    if (!found) return res.status(404).page(notFound(req));
    const number = String(req.body.number || '').toUpperCase();
    q(`DELETE FROM class_roster WHERE class_id = ? AND number = ? AND source = 'list'`).run(found.cls.id, number);
    syncRoster(found.cls);
    flashRedirect(res, `/classes/${found.cls.id}#roster`, 'ok', `${number} is off the class list.`);
  });

  app.post('/classes/:id/roster/clear', requireUser, limits.classes, (req, res) => {
    const found = classForRunners(req, 'manage');
    if (!found) return res.status(404).page(notFound(req));
    q(`DELETE FROM class_roster WHERE class_id = ? AND source = 'list'`).run(found.cls.id);
    syncRoster(found.cls);
    flashRedirect(res, `/classes/${found.cls.id}#roster`, 'ok', 'The class list is cleared. Students who joined on Kwaai stay.');
  });

  app.post('/classes/:id/remove', requireUser, limits.classes, (req, res) => {
    const found = classForRunners(req, 'manage');
    const who = found && classMember(found.cls.id, Number(req.body.user));
    if (!who || who.role === 'lecturer') return res.status(404).page(notFound(req));
    dropFromRoster(found.cls.id, who.user_id);
    q(`DELETE FROM class_members WHERE class_id = ? AND user_id = ?`).run(found.cls.id, who.user_id);
    flashRedirect(res, `/classes/${found.cls.id}`, 'ok', 'Removed from the class.');
  });

  // ---- tutors and attendance ----
  // The lecturer adds tutors by email (they need to have signed in once). A tutor or the lecturer starts an attendance
  // session: their phone shows a QR code that changes every 20 seconds; students scan it with their own camera, then
  // tap to confirm (so a link preview can't mark anyone). A tutor can also add someone by student number.
  const attendanceSecret = (() => {
    let s = q(`SELECT value FROM meta WHERE key = 'attendance_secret'`).get()?.value;
    if (!s) {
      s = crypto.randomBytes(32).toString('hex');
      q(`INSERT INTO meta (key, value) VALUES ('attendance_secret', ?)`).run(s);
    }
    return s;
  })();
  const sessionById = (id) => q(`SELECT s.*, c.code, c.name AS class_name, c.course FROM attendance_sessions s JOIN classes c ON c.id = s.class_id WHERE s.id = ?`).get(Number(id) || 0) || null;
  const attendanceUrl = (req, s) => `${req.ctx.site.origin}/a/${s.id}?k=${Classes.attendanceKey(attendanceSecret, s.id, Classes.slotAt(Date.now()))}`;
  const sessionCount = (id) => q(`SELECT COUNT(*) AS n FROM attendance WHERE session_id = ? AND status IN ('present', 'late')`).get(id).n;
  const recentMarks = (id) => q(`SELECT COALESCE(NULLIF(m.name, ''), NULLIF(r.name, ''), a.number) AS name, a.how FROM attendance a JOIN attendance_sessions s ON s.id = a.session_id
    LEFT JOIN class_members m ON m.class_id = s.class_id AND m.number = a.number LEFT JOIN class_roster r ON r.class_id = s.class_id AND r.number = a.number
    WHERE a.session_id = ? AND a.status IN ('present', 'late') ORDER BY a.marked_at DESC LIMIT 8`).all(id);
  // The register for a session: everyone it's for (the whole class, or the group's students), in surname order, with
  // their mark. Anyone marked who isn't in the group (they scanned another group's code) is listed too. A phone that
  // checked in more than one student is flagged on each of them.
  function registerFor(s) {
    syncRoster(classById(s.class_id));
    const group = s.group_id ? q(`SELECT * FROM class_groups WHERE id = ?`).get(s.group_id) : null;
    const rows = q(`SELECT r.number, COALESCE(NULLIF(m.name, ''), NULLIF(r.name, ''), r.number) AS name, a.status, a.how, a.device
      FROM class_roster r LEFT JOIN class_members m ON m.class_id = r.class_id AND m.number = r.number LEFT JOIN attendance a ON a.session_id = ? AND a.number = r.number
      WHERE r.class_id = ? AND (a.number IS NOT NULL OR ${group ? `r.${GROUP_COLUMN[group.kind]} = ?` : '1'})`).all(s.id, s.class_id, ...(group ? [group.name] : []))
      .map((r) => ({ number: r.number, name: r.name, status: r.status || 'absent', how: r.how || '', device: r.device || '' }))
      .sort(Classes.bySurname);
    const byDevice = new Map();
    for (const r of rows) if (r.device) byDevice.set(r.device, [...(byDevice.get(r.device) || []), r.number]);
    for (const r of rows) r.sharedWith = r.device ? byDevice.get(r.device).filter((n) => n !== r.number) : [];
    return { group, rows };
  }
  // one mark on the register; absent removes it
  function setMark(s, number, status, how, userId = null, device = '') {
    if (status === 'absent') return q(`DELETE FROM attendance WHERE session_id = ? AND number = ?`).run(s.id, number);
    q(`INSERT INTO attendance (session_id, number, user_id, marked_at, status, how, device)
      VALUES (?, ?, COALESCE(?, (SELECT user_id FROM class_members WHERE class_id = ? AND number = ?)), ?, ?, ?, ?)
      ON CONFLICT (session_id, number) DO UPDATE SET status = excluded.status, how = excluded.how, marked_at = excluded.marked_at`)
      .run(s.id, number, userId, s.class_id, number, Date.now(), status, how, device);
  }
  const onRegister = (s, number) => !!q(`SELECT 1 FROM class_roster WHERE class_id = ? AND number = ?`).get(s.class_id, number);

  app.post('/classes/:id/tutors', requireUser, limits.classes, (req, res) => {
    const found = classForRunners(req, 'manage');
    if (!found) return res.status(404).page(notFound(req));
    const { cls } = found;
    const email = normEmail(req.body.email);
    const name = Study.cleanName(req.body.name, 60, screenComment);
    const back = (type, text) => flashRedirect(res, `/classes/${cls.id}#tutors`, type, text);
    if (!accountFor(email)) return back('error', 'Use their UCT email (@myuct.ac.za or @uct.ac.za).');
    if (name.error) return back('error', `Their name: ${name.error}`);
    const user = q(`SELECT id FROM users WHERE email = ?`).get(email);
    if (!user) return back('error', `${email} hasn't signed in to Kwaai yet. Ask them to sign in once, then add them again.`);
    const now = classMember(cls.id, user.id);
    if (now?.role === 'lecturer') return back('error', "That's you.");
    if (now) q(`UPDATE class_members SET role = 'tutor', name = ?, anonymous = 0 WHERE class_id = ? AND user_id = ?`).run(name.name, cls.id, user.id);
    else q(`INSERT INTO class_members (class_id, user_id, role, name, consent_at) VALUES (?, ?, 'tutor', ?, CURRENT_TIMESTAMP)`).run(cls.id, user.id, name.name);
    back('ok', `${name.name} is a tutor in this class now.`);
  });

  app.post('/classes/:id/tutors/remove', requireUser, limits.classes, (req, res) => {
    const found = classForRunners(req, 'manage');
    const who = found && classMember(found.cls.id, Number(req.body.user));
    if (!who || who.role !== 'tutor') return res.status(404).page(notFound(req));
    q(`DELETE FROM class_members WHERE class_id = ? AND user_id = ?`).run(found.cls.id, who.user_id);
    flashRedirect(res, `/classes/${found.cls.id}#tutors`, 'ok', 'No longer a tutor in this class.');
  });

  app.post('/classes/:id/attendance', requireUser, limits.classes, (req, res) => {
    const found = classForRunners(req, 'attendance');
    if (!found) return res.status(404).page(notFound(req));
    const group = req.body.group ? q(`SELECT * FROM class_groups WHERE id = ? AND class_id = ?`).get(Number(req.body.group) || 0, found.cls.id) : null;
    if (req.body.group && !group) return res.status(404).page(notFound(req));
    const kind = group ? group.kind : Classes.GROUP_KINDS[req.body.kind] ? req.body.kind : 'other';
    const label = Study.cleanName(req.body.label || `${group ? group.name : Classes.GROUP_KINDS[kind] || 'Class'}, ${Classes.shortDay(Date.now())}`, 60, screenComment);
    if (label.error) return flashRedirect(res, `/classes/${found.cls.id}#attendance`, 'error', `Session name: ${label.error}`);
    const { lastInsertRowid: id } = q(`INSERT INTO attendance_sessions (class_id, label, started_by, started_at, group_id, kind) VALUES (?, ?, ?, ?, ?, ?)`).run(found.cls.id, label.name, req.user.id, Date.now(), group?.id ?? null, kind);
    res.redirect(303, `/attend/${id}`);
  });

  // the tutor's screen: the QR code, the count so far, the newest names, add by student number, and End
  const sessionForRunners = (req) => {
    const s = sessionById(req.params.id);
    const me = s && classMember(s.class_id, req.user.id);
    return Classes.can(me, 'attendance') ? s : null;
  };
  app.get('/attend/:id', requireUser, (req, res) => {
    const s = sessionForRunners(req);
    if (!s) return res.status(404).page(notFound(req));
    const url = attendanceUrl(req, s);
    const { group, rows } = registerFor(s);
    res.set('Cache-Control', 'no-store').page(views.attendanceScreen(req.ctx, { s, group, rows, qr: s.ended_at ? '' : Classes.qrSvg(url), count: sessionCount(s.id), recent: recentMarks(s.id) }));
  });
  app.get('/attend/:id/live', requireUser, (req, res) => {
    const s = sessionForRunners(req);
    if (!s) return res.status(404).json({ error: 'not found' });
    const marks = Object.fromEntries(registerFor(s).rows.map((r) => [r.number, r.status]));
    res.set('Cache-Control', 'no-store').json({ open: !s.ended_at, qr: s.ended_at ? '' : Classes.qrSvg(attendanceUrl(req, s)), count: sessionCount(s.id), recent: recentMarks(s.id).map((r) => r.name || 'A student'), marks });
  });
  // a tap on the register: the name's new mark (present, late, excused or absent). Answers in JSON for the page's
  // script, or goes back to the register without it. Works on a closed session too, to correct it later.
  app.post('/attend/:id/mark', requireUser, limits.register, (req, res) => {
    const s = sessionForRunners(req);
    if (!s) return res.status(404).page(notFound(req));
    const number = String(req.body.number || '').trim().toUpperCase();
    const status = Classes.MARKS.includes(req.body.status) ? req.body.status : null;
    const json = (req.get('accept') || '').includes('application/json');
    if (!status || !onRegister(s, number)) return json ? res.status(400).json({ error: 'Not on this class list.' }) : flashRedirect(res, `/attend/${s.id}`, 'error', `${number || 'That student'} isn't on this class list.`);
    setMark(s, number, status, 'tutor');
    if (json) return res.json({ number, status, count: sessionCount(s.id) });
    res.redirect(303, `/attend/${s.id}#r-${number}`);
  });
  // everyone on the register who isn't marked yet is marked present, then the tutor taps the few who aren't there
  app.post('/attend/:id/all', requireUser, limits.register, (req, res) => {
    const s = sessionForRunners(req);
    if (!s) return res.status(404).page(notFound(req));
    const todo = registerFor(s).rows.filter((r) => r.status === 'absent');
    for (const r of todo) setMark(s, r.number, 'present', 'tutor');
    flashRedirect(res, `/attend/${s.id}`, 'ok', `${todo.length} ${todo.length === 1 ? 'student' : 'students'} marked present. Tap anyone who isn't here.`);
  });
  app.post('/attend/:id/add', requireUser, limits.register, (req, res) => {
    const s = sessionForRunners(req);
    if (!s) return res.status(404).page(notFound(req));
    const number = String(req.body.number || '').trim().toUpperCase();
    syncRoster(classById(s.class_id));
    if (!/^[A-Z0-9]{3,20}$/.test(number) || !onRegister(s, number)) return flashRedirect(res, `/attend/${s.id}`, 'error', `${number || 'That student'} isn't on this class list. Add them to the list, or they can join with the class link.`);
    setMark(s, number, 'present', 'tutor');
    flashRedirect(res, `/attend/${s.id}`, 'ok', `${number} is marked present.`);
  });
  app.post('/attend/:id/end', requireUser, (req, res) => {
    const s = sessionForRunners(req);
    if (!s) return res.status(404).page(notFound(req));
    q(`UPDATE attendance_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL`).run(Date.now(), s.id);
    flashRedirect(res, `/classes/${s.class_id}#attendance`, 'ok', `${s.label} closed: ${sessionCount(s.id)} present.`);
  });

  // the student's side: the scanned link opens a confirm page; the tap marks them present
  const deviceOf = (req) => /(?:^|;\s*)kdev=([a-f0-9]{32})/.exec(req.headers.cookie || '')?.[1] || '';
  const scanCheck = (req) => {
    const s = sessionById(req.params.id);
    if (!s) return { status: 404 };
    if (s.ended_at) return { s, problem: 'This attendance session has closed.' };
    const key = String(req.query.k ?? req.body.k ?? '');
    if (!Classes.keyIsCurrent(attendanceSecret, s.id, key, Date.now())) return { s, problem: 'That code has expired. Scan the QR code on the screen again.' };
    if (!classMember(s.class_id, req.user.id)) return { s, problem: 'join' };
    syncRoster(classById(s.class_id));
    const me = classMember(s.class_id, req.user.id);
    if (!me.number || !['student', 'rep'].includes(me.role)) return { s, problem: 'Only students check in. Tutors and lecturers run the register.' };
    return { s, me, key };
  };
  app.get('/a/:id', requireUser, (req, res) => {
    const r = scanCheck(req);
    if (r.status) return res.status(404).page(notFound(req));
    const already = r.me && q(`SELECT 1 FROM attendance WHERE session_id = ? AND number = ? AND status IN ('present', 'late')`).get(r.s.id, r.me.number);
    // a random id for this phone, so the register can flag one phone checking in two students
    if (!deviceOf(req)) res.cookie('kdev', crypto.randomBytes(16).toString('hex'), { httpOnly: true, sameSite: 'lax', secure: !devMode, maxAge: 365 * 24 * 60 * MIN });
    res.set('Cache-Control', 'no-store').page(views.attendanceCheckIn(req.ctx, { s: r.s, problem: r.problem, key: r.key, already: !!already }));
  });
  app.post('/a/:id', requireUser, limits.classes, (req, res) => {
    const r = scanCheck(req);
    if (r.status) return res.status(404).page(notFound(req));
    if (r.problem) return res.status(400).page(views.attendanceCheckIn(req.ctx, { s: r.s, problem: r.problem }));
    if (!q(`SELECT 1 FROM attendance WHERE session_id = ? AND number = ?`).get(r.s.id, r.me.number)) setMark(r.s, r.me.number, 'present', 'qr', req.user.id, deviceOf(req));
    res.page(views.attendanceCheckIn(req.ctx, { s: r.s, done: true }));
  });

  // ---- test tools (admin only, and only with TEST_TOOLS=1) ----
  // Fake study data for trying the heatmap, streaks, boards and groups. Everything they make belongs to test accounts,
  // which students never see (realOnly). Turn TEST_TOOLS off at launch and the pages are gone.
  const requireTools = (req, res, next) => (testTools && req.user?.is_admin ? next() : res.status(404).page(notFound(req)));
  const addSessions = (userId, uni, days, course = () => '') => {
    const insert = q(`INSERT INTO study_sessions (user_id, uni, course, day, started_at, last_beat, planned_min, credited_sec, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'done')`);
    for (const d of days) {
      const r = TestData.sessionRow(userId, uni, course(d), d.day, d.minutes);
      insert.run(r.user_id, r.uni, r.course, r.day, r.started_at, r.last_beat, r.planned_min, r.credited_sec);
    }
  };
  const TOOL_COURSES = ['CSC1015F', 'MAM1031F', 'STA1006S', ''];
  const pickCourse = () => TOOL_COURSES[Math.floor(Math.random() * TOOL_COURSES.length)];

  app.get('/admin/tools', requireUser, requireTools, (req, res) => {
    const today = Study.saDay(Date.now());
    const totals = studyTotals(req.user.id, today);
    res.set('Cache-Control', 'no-store').page(views.adminTools(req.ctx, {
      today, streak: Study.streak(totals, today, TERMS.years), days: totals.filter((t) => t.minutes > 0).length, minutes: totals.reduce((s, t) => s + t.minutes, 0),
      rank: rankFor(req.user.id, totals), role: req.user.role, demo: adminDemo(req),
      testStudents: TestData.FAKE_STUDENTS.map((s, i) => ({ i, name: s.name || 'Anonymous', number: Classes.studentNumber(TestData.fakeEmail(i)) })),
    }));
  });
  // the demo classes, if made, and a link that checks you in to the open tut in the class you're a student in
  function adminDemo(req) {
    const run = demoClassOf(req.user.email, DEMO_RUN);
    const joined = demoClassOf(DEMO_LECTURER, DEMO_JOINED);
    const open = joined && classMember(joined.id, req.user.id) && q(`SELECT * FROM attendance_sessions WHERE class_id = ? AND ended_at IS NULL ORDER BY started_at DESC`).get(joined.id);
    return { run, joined: joined && classMember(joined.id, req.user.id) ? joined : null, checkIn: open ? attendanceUrl(req, open) : null };
  }

  // one finished session on any day in the last year
  app.post('/admin/tools/study', requireUser, requireTools, (req, res) => {
    const today = Study.saDay(Date.now());
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.day || '')) ? req.body.day : today;
    const minutes = Math.round(Number(req.body.minutes));
    const course = String(req.body.course || '').trim().toUpperCase();
    if (day > today || day < Study.addDay(today, -365)) return flashRedirect(res, '/admin/tools', 'error', 'Pick a day in the last year, up to today.');
    if (!(minutes >= 1 && minutes <= Study.DAY_CAP_MIN)) return flashRedirect(res, '/admin/tools', 'error', `Minutes must be 1 to ${Study.DAY_CAP_MIN}.`);
    if (course && !courseExists(course)) return flashRedirect(res, '/admin/tools', 'error', `${course} isn't a course in Kwaai.`);
    addSessions(req.user.id, req.user.uni, [{ day, minutes }], () => course);
    flashRedirect(res, '/admin/tools', 'ok', `Added ${Study.hoursText(minutes)}${course ? ` of ${course}` : ''} on ${day}.`);
  });

  // a streak of n days ending today (shows "today counts") or yesterday (shows "study 30 more minutes to keep it"):
  // the run is rebuilt from scratch with an empty day before it. If that day falls in a vacation, older study can
  // still join on, as it would for a student.
  app.post('/admin/tools/streak', requireUser, requireTools, (req, res) => {
    const n = Math.round(Number(req.body.days));
    if (!(n >= 1 && n <= 365)) return flashRedirect(res, '/admin/tools', 'error', 'Pick 1 to 365 days.');
    const today = Study.saDay(Date.now());
    const end = req.body.ends === 'yesterday' ? Study.addDay(today, -1) : today;
    const days = TestData.streakDays(n, end);
    q(`DELETE FROM study_sessions WHERE user_id = ? AND day >= ?`).run(req.user.id, Study.addDay(days[0].day, -1));
    addSessions(req.user.id, req.user.uni, days, pickCourse);
    flashRedirect(res, '/study', 'ok', `Added ${n} ${n === 1 ? 'day' : 'days'} of study in a row, ending ${end === today ? 'today' : 'yesterday'}.`);
  });

  app.post('/admin/tools/history', requireUser, requireTools, (req, res) => {
    addSessions(req.user.id, req.user.uni, TestData.historyDays(Study.saDay(Date.now())), pickCourse);
    flashRedirect(res, '/study', 'ok', 'Added about six months of study history.');
  });

  // study on days more than a year ago, at most 12 h a day: it counts for the lifetime rank and stays off the heatmap,
  // the season and every board
  function bankHours(userId, uni, minutes) {
    const today = Study.saDay(Date.now());
    const days = [];
    for (let i = 0; minutes > 0; i++, minutes -= 720) days.push({ day: Study.addDay(today, -400 - i), minutes: Math.min(720, minutes) });
    addSessions(userId, uni, days, () => '');
  }

  // this week's quests, all done: sessions that tick every quest a week can draw (3 days, 5 h, a 50-minute and an
  // early session, two in a day, and an hour on each course timed lately). Early in the week some days are ahead.
  app.post('/admin/tools/quests', requireUser, requireTools, (req, res) => {
    const monday = Quests.mondayOf(Study.saDay(Date.now()));
    const recent = q(`SELECT DISTINCT course FROM study_sessions WHERE user_id = ? AND course != '' AND day >= ? AND day < ?`).all(req.user.id, Study.addDay(monday, -28), monday).map((r) => r.course);
    const course = recent[0] || 'CSC1015F';
    addSessions(req.user.id, req.user.uni, [{ day: monday, minutes: 120 }], () => course);
    for (const c of recent.slice(1)) addSessions(req.user.id, req.user.uni, [{ day: monday, minutes: 60 }], () => c);
    addSessions(req.user.id, req.user.uni, [{ day: Study.addDay(monday, 1), minutes: 100 }, { day: Study.addDay(monday, 2), minutes: 80 }, { day: Study.addDay(monday, 2), minutes: 15 }], pickCourse);
    res.redirect(303, '/study#quests');
  });

  // last week with no study at all, so this week offers the comeback quest
  app.post('/admin/tools/quiet-week', requireUser, requireTools, (req, res) => {
    const monday = Quests.mondayOf(Study.saDay(Date.now()));
    q(`DELETE FROM study_sessions WHERE user_id = ? AND day BETWEEN ? AND ?`).run(req.user.id, Study.addDay(monday, -7), Study.addDay(monday, -1));
    if (!q(`SELECT 1 FROM study_sessions WHERE user_id = ? AND day < ?`).get(req.user.id, Study.addDay(monday, -7))) addSessions(req.user.id, req.user.uni, [{ day: Study.addDay(monday, -10), minutes: 45 }], pickCourse);
    flashRedirect(res, '/study#quests', 'ok', 'Last week is empty now. If this week has no quest done yet, the comeback quest is one of the three.');
  });

  app.get('/admin/tools/ranks', requireUser, requireTools, (req, res) => res.page(views.rankGallery(req.ctx)));

  // plays the admin's rank-up card again: the next Study page shows the current rank as new (or the first look at
  // ranks, for the intro)
  app.post('/admin/tools/rank-up', requireUser, requireTools, (req, res) => {
    const intro = req.body.kind === 'intro';
    const step = Ranks.rankOf(lifetimeMinutes([req.user.id]).get(req.user.id)).step;
    if (step < 0) return flashRedirect(res, '/admin/tools#ranks', 'error', 'You need a rank first: set one above.');
    q(`UPDATE users SET rank_seen = ?, season_seen = NULL WHERE id = ?`).run(intro ? null : step - 1, req.user.id);
    res.redirect(303, '/study');
  });

  // the admin's lifetime rank set to one step, or 10 minutes short of it to try a rank-up
  app.post('/admin/tools/rank', requireUser, requireTools, (req, res) => {
    const step = Ranks.LIFETIME[Number(req.body.step)];
    if (!step || req.body.step === '') return flashRedirect(res, '/admin/tools#ranks', 'error', 'Pick a rank.');
    const under = req.body.under === '1';
    const label = Ranks.stepLabel(step);
    q(`DELETE FROM study_sessions WHERE user_id = ? AND day < ?`).run(req.user.id, Study.addDay(Study.saDay(Date.now()), -371));
    const have = lifetimeMinutes([req.user.id]).get(req.user.id);
    const target = step[2] * 60 - (under ? 10 : 0);
    if (have > target) return flashRedirect(res, '/admin/tools#ranks', 'error', `Your last year already has ${Study.hoursText(have)} of study, more than ${label} needs. Clear your study data first.`);
    bankHours(req.user.id, req.user.uni, target - have);
    // 10 minutes short: the step below counts as celebrated, so the session that crosses the line gets the moment
    if (under) q(`UPDATE users SET rank_seen = ? WHERE id = ?`).run(Ranks.rankOf(target).step, req.user.id);
    flashRedirect(res, '/study', 'ok', under ? `You're 10 minutes short of ${label}. Time a 10-minute session to rank up.` : `You're ${label} now.`);
  });

  app.post('/admin/tools/clear-mine', requireUser, requireTools, (req, res) => {
    q(`DELETE FROM study_sessions WHERE user_id = ?`).run(req.user.id);
    q(`UPDATE users SET rank_seen = NULL, season_seen = NULL, quests_seen = NULL WHERE id = ?`).run(req.user.id);
    flashRedirect(res, '/admin/tools', 'ok', 'Your study data is cleared.');
  });

  // the fake students' accounts, made the first time they're needed
  function fakeStudentIds(uni) {
    return TestData.FAKE_STUDENTS.map((_, i) => {
      q(`INSERT INTO users (email, uni, is_test, agreed_at) VALUES (?, ?, 1, CURRENT_TIMESTAMP) ON CONFLICT(email) DO UPDATE SET is_test = 1`).run(TestData.fakeEmail(i), uni);
      return q(`SELECT id FROM users WHERE email = ?`).get(TestData.fakeEmail(i)).id;
    });
  }

  // 15 students on the boards with study this week and the three before, a "Test group" with the admin and eight of
  // them, and four of them "studying now" for the next two hours
  app.post('/admin/tools/students', requireUser, requireTools, (req, res) => {
    const today = Study.saDay(Date.now());
    const ids = fakeStudentIds(req.user.uni);
    const now = Date.now();
    ids.forEach((id, i) => {
      const s = TestData.FAKE_STUDENTS[i];
      // the named ones wear the best name style their rank unlocks, so every style shows on the boards
      const step = Ranks.LIFETIME[Math.round((i * 15) / 14)];
      q(`INSERT OR REPLACE INTO profiles (user_id, uni, display_name, show_name, faculty, major, year, name_fx) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, req.user.uni, s.name, s.name ? 1 : 0, s.faculty, s.major, s.year, Ranks.unlockedFx(step[0]).at(-1) || '');
      q(`DELETE FROM study_sessions WHERE user_id = ?`).run(id);
      // four weeks of history, plus some study today so every board (today, this week, this month) has them
      addSessions(id, req.user.uni, [...TestData.historyDays(today, 28).filter((d) => d.day !== today), { day: today, minutes: 20 + ((i * 37) % 130) }], pickCourse);
      // older study, so the 15 are spread from Bronze I to Kwaai
      bankHours(id, req.user.uni, step[2] * 60);
      if (i < 4) {
        q(`INSERT INTO study_sessions (user_id, uni, course, day, started_at, last_beat, planned_min, status) VALUES (?, ?, ?, ?, ?, ?, 120, 'running')`)
          .run(id, req.user.uni, TOOL_COURSES[i % TOOL_COURSES.length], today, now - (i + 1) * 9 * 60_000, now + 2 * 60 * 60_000); // keeps beating for two hours
      }
    });
    let g = q(`SELECT * FROM study_groups WHERE owner_id = ? AND name = 'Test group'`).get(req.user.id);
    if (!g) {
      let code;
      do code = Study.groupCode(crypto.randomBytes(8)); while (q(`SELECT 1 FROM study_groups WHERE code = ?`).get(code));
      q(`INSERT INTO study_groups (uni, name, code, owner_id) VALUES (?, 'Test group', ?, ?)`).run(req.user.uni, code, req.user.id);
      g = q(`SELECT * FROM study_groups WHERE code = ?`).get(code);
    }
    q(`INSERT OR IGNORE INTO group_members (group_id, user_id, name) VALUES (?, ?, 'You')`).run(g.id, req.user.id);
    ids.slice(0, 8).forEach((id, i) => q(`INSERT OR IGNORE INTO group_members (group_id, user_id, name) VALUES (?, ?, ?)`).run(g.id, id, TestData.FAKE_STUDENTS[i].name || `Student ${i + 1}`));
    flashRedirect(res, `/g/${g.code}`, 'ok', '15 test students are on the boards, from Bronze I to Kwaai, 8 are in this group, and 4 are studying now.');
  });

  // six of the fake students timing one course over the last four weeks, so its page shows "Time it takes"
  app.post('/admin/tools/course-hours', requireUser, requireTools, (req, res) => {
    const course = String(req.body.course || '').trim().toUpperCase();
    if (!courseExists(course)) return flashRedirect(res, '/admin/tools', 'error', 'Pick a course code that is in Kwaai.');
    const today = Study.saDay(Date.now());
    fakeStudentIds(req.user.uni).slice(0, 6).forEach((id) => {
      q(`DELETE FROM study_sessions WHERE user_id = ? AND course = ?`).run(id, course);
      addSessions(id, req.user.uni, TestData.historyDays(today, 28).filter((d) => d.minutes <= 120), () => course);
    });
    flashRedirect(res, `/courses/${course}`, 'ok', `Six test students have timed ${course} for four weeks.`);
  });

  // ---- test tools: classes ----
  // Two demo classes for trying the lecturer and student sides with the 15 test students: one the admin runs, and one
  // run by a test lecturer that the admin is in as a student. Running a tool again rebuilds its class from scratch.
  const DEMO_LECTURER = 'test-lecturer@kwaai.invalid';
  const DEMO_RUN = 'CSC1015F demo';
  const DEMO_JOINED = 'MAM1031F demo';
  const DAY_MS = 24 * 60 * MIN;
  const demoClassOf = (ownerEmail, name) => q(`SELECT c.* FROM classes c JOIN users u ON u.id = c.owner_id WHERE u.email = ? AND c.name = ?`).get(ownerEmail, name) || null;
  function freshDemoClass(ownerId, ownerName, name, course) {
    q(`DELETE FROM classes WHERE owner_id = ? AND name = ?`).run(ownerId, name); // members, dates, sessions, posts and pulses cascade
    let code;
    do code = Study.groupCode(crypto.randomBytes(8)); while (q(`SELECT 1 FROM classes WHERE code = ?`).get(code));
    const { lastInsertRowid: id } = q(`INSERT INTO classes (uni, course, year, name, code, owner_id, goal_week_min) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(CURRENT.slug, course, planYear(), name, code, ownerId, Math.round(goalFor(course) * 60));
    q(`INSERT INTO class_members (class_id, user_id, role, name, consent_at) VALUES (?, ?, 'lecturer', ?, CURRENT_TIMESTAMP)`).run(id, ownerId, ownerName);
    return classById(id);
  }
  // the test students join: named ones by name, the rest anonymously; each gets four weeks of the course, some far less
  function demoStudents(cls, ids, today, uni) {
    ids.forEach((id, i) => {
      const s = TestData.FAKE_STUDENTS[i];
      q(`INSERT OR REPLACE INTO class_members (class_id, user_id, role, name, anonymous, consent_at) VALUES (?, ?, 'student', ?, ?, CURRENT_TIMESTAMP)`)
        .run(cls.id, id, s.name || `Student ${i + 1}`, s.name ? 0 : 1);
      q(`DELETE FROM study_sessions WHERE user_id = ? AND course = ?`).run(id, cls.course);
      const behind = i % 5 === 4; // a few who stopped studying a while ago, so "Needs a nudge" has rows
      const days = TestData.historyDays(today, 28).filter((d) => d.minutes <= 150 && (!behind || d.day < Study.addDay(today, -10)));
      addSessions(id, uni, days, () => cls.course);
    });
  }
  // past weekly tuts: most come, a couple of students skip the last few
  function demoAttendance(cls, ids, runnerId, weeks) {
    const now = Date.now();
    for (let w = weeks; w >= 1; w--) {
      const started = now - w * 7 * DAY_MS;
      const { lastInsertRowid: sid } = q(`INSERT INTO attendance_sessions (class_id, label, started_by, started_at, ended_at, kind) VALUES (?, ?, ?, ?, ?, 'tut')`)
        .run(cls.id, `Tut ${weeks - w + 1}`, runnerId, started, started + 90 * MIN);
      ids.forEach((id, i) => {
        const skipper = (i === 3 || i === 8) && w <= 3;
        if (skipper || (i + w) % 6 === 0) return;
        const status = (i + w) % 7 === 0 ? 'late' : (i + w) % 11 === 0 ? 'excused' : 'present';
        q(`INSERT INTO attendance (session_id, number, user_id, marked_at, status, how) VALUES (?, ?, ?, ?, ?, ?)`).run(sid, Classes.studentNumber(TestData.fakeEmail(i)), id, started + (5 + i) * MIN, status, i % 4 ? 'qr' : 'tutor');
      });
    }
  }

  // view Kwaai as a student or as staff (a lecturer); staff can make classes but not rate courses
  app.post('/admin/tools/role', requireUser, requireTools, (req, res) => {
    const role = req.body.role === 'staff' ? 'staff' : 'student';
    q(`UPDATE users SET role = ? WHERE id = ?`).run(role, req.user.id);
    flashRedirect(res, '/admin/tools#classes', 'ok', role === 'staff' ? "You're a lecturer now: make a class from Classes." : "You're a student again.");
  });

  // a class you run, with the test students, a rep and a tutor, study, past tuts, dates, an announcement and a pulse check
  app.post('/admin/tools/demo-lecturer', requireUser, requireTools, (req, res) => {
    const today = Study.saDay(Date.now());
    const now = Date.now();
    const ids = fakeStudentIds(req.user.uni);
    q(`UPDATE users SET role = 'staff' WHERE id = ?`).run(req.user.id);
    const cls = freshDemoClass(req.user.id, 'You (demo lecturer)', DEMO_RUN, 'CSC1015F');
    const students = ids.slice(0, 14);
    demoStudents(cls, students, today, req.user.uni);
    q(`UPDATE class_members SET role = 'rep', name = 'Thandi Mokoena', anonymous = 0 WHERE class_id = ? AND user_id = ?`).run(cls.id, ids[0]);
    q(`INSERT OR REPLACE INTO class_members (class_id, user_id, role, name, consent_at) VALUES (?, ?, 'tutor', 'Sam Tutor', CURRENT_TIMESTAMP)`).run(cls.id, ids[14]);
    // four students on the class list who aren't on Kwaai, so the list, registers and DP include them
    q(`UPDATE classes SET roster_confirmed_at = CURRENT_TIMESTAMP, dp_tut_planned = 10, dp_tut_pct = 80 WHERE id = ?`).run(cls.id); // DP: 80% of 10 tuts
    [['TEST101', 'Lindiwe Dube'], ['TEST102', 'Pieter van Wyk'], ['TEST103', 'Ayesha Patel'], ['TEST104', 'Kagiso Molefe']]
      .forEach(([number, name]) => q(`INSERT INTO class_roster (class_id, number, name, source) VALUES (?, ?, ?, 'list')`).run(cls.id, number, name));
    // two tuts and a prac with times, venues and tutors; the class list puts everyone in one of each
    syncRoster(cls);
    const addGroup = q(`INSERT INTO class_groups (class_id, kind, name, day, starts, ends, venue, tutor_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    addGroup.run(cls.id, 'tut', 'Tut 1', 'Tuesday', '14:00', '15:45', 'Menzies 10', ids[14]);
    addGroup.run(cls.id, 'tut', 'Tut 2', 'Thursday', '10:00', '11:45', 'PD Hahn 3', req.user.id);
    addGroup.run(cls.id, 'prac', 'Prac A', 'Wednesday', '14:00', '17:00', 'Shuttleworth lab', ids[14]);
    q(`UPDATE class_roster SET tut_group = CASE WHEN rowid % 2 THEN 'Tut 1' ELSE 'Tut 2' END, prac_group = 'Prac A' WHERE class_id = ?`).run(cls.id);
    demoAttendance(cls, students, req.user.id, 6);
    const date = q(`INSERT INTO class_dates (class_id, course, type, title, date, time, added_by, added_role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    date.run(cls.id, cls.course, 'prac', 'Prac 5', Study.addDay(today, 2), '23:59', req.user.id, 'lecturer');
    date.run(cls.id, cls.course, 'test', 'Test 2', Study.addDay(today, 6), '18:00', req.user.id, 'lecturer');
    date.run(cls.id, cls.course, 'assignment', 'Assignment 3', Study.addDay(today, 11), '', ids[0], 'rep');
    const post = q(`INSERT INTO class_announcements (class_id, body, posted_by, poster_name, poster_role, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
    post.run(cls.id, 'Test 2 is in LT1 on the day. Bring your student card.', req.user.id, 'You (demo lecturer)', 'lecturer', now - 2 * DAY_MS);
    post.run(cls.id, 'Study group for Test 2 on Thursday at 16:00 in the library, all welcome.', ids[0], 'Thandi Mokoena', 'rep', now - 3 * 60 * MIN);
    const { lastInsertRowid: pid } = q(`INSERT INTO class_pulses (class_id, question, options, counts, asked_by, asked_at, closes_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(cls.id, Classes.PULSE_PRESET.question, JSON.stringify(Classes.PULSE_PRESET.options), JSON.stringify([2, 7, 4]), req.user.id, now - DAY_MS, now + 6 * DAY_MS);
    students.slice(0, 13).forEach((id) => q(`INSERT INTO pulse_answered (pulse_id, user_id) VALUES (?, ?)`).run(pid, id));
    flashRedirect(res, `/classes/${cls.id}`, 'ok', `${DEMO_RUN}: you're the lecturer, with 14 test students, a rep, a tutor and 6 past tuts.`);
  });

  // a class run by a test lecturer, with you in it as a student: an unread announcement, an open pulse and an open tut
  app.post('/admin/tools/demo-student', requireUser, requireTools, (req, res) => {
    const today = Study.saDay(Date.now());
    const now = Date.now();
    const ids = fakeStudentIds(req.user.uni);
    q(`INSERT INTO users (email, uni, role, is_test, agreed_at) VALUES (?, ?, 'staff', 1, CURRENT_TIMESTAMP) ON CONFLICT(email) DO UPDATE SET is_test = 1, role = 'staff'`).run(DEMO_LECTURER, req.user.uni);
    const lecturerId = q(`SELECT id FROM users WHERE email = ?`).get(DEMO_LECTURER).id;
    const cls = freshDemoClass(lecturerId, 'Dr T Test', DEMO_JOINED, 'MAM1031F');
    demoStudents(cls, ids.slice(0, 10), today, req.user.uni);
    q(`INSERT INTO class_members (class_id, user_id, role, name, consent_at) VALUES (?, ?, 'student', 'You', CURRENT_TIMESTAMP)`).run(cls.id, req.user.id);
    // everyone in one tut group, so its time and venue show on your week and Today (with MAM1031F in your plan)
    syncRoster(cls);
    q(`INSERT INTO class_groups (class_id, kind, name, day, starts, ends, venue, tutor_id) VALUES (?, 'tut', 'Tut B', 'Friday', '12:00', '13:45', 'Leslie Social LT2', ?)`).run(cls.id, lecturerId);
    q(`UPDATE class_roster SET tut_group = 'Tut B' WHERE class_id = ?`).run(cls.id);
    demoAttendance(cls, ids.slice(0, 10), lecturerId, 3);
    // DP: 75% of 6 tuts. You (the admin) weren't at the 3 held so far, so Today warns you
    q(`UPDATE classes SET dp_tut_planned = 6, dp_tut_pct = 75 WHERE id = ?`).run(cls.id);
    q(`INSERT INTO class_dates (class_id, course, type, title, date, time, added_by, added_role) VALUES (?, ?, 'test', 'Class test 2', ?, '14:00', ?, 'lecturer')`).run(cls.id, cls.course, Study.addDay(today, 4), lecturerId);
    q(`INSERT INTO class_announcements (class_id, body, posted_by, poster_name, poster_role, created_at) VALUES (?, ?, ?, 'Dr T Test', 'lecturer', ?)`)
      .run(cls.id, 'Tutorial 4 moves to Thursday this week. Same venue.', lecturerId, now - 60 * MIN);
    q(`INSERT INTO class_pulses (class_id, question, options, counts, asked_by, asked_at, closes_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(cls.id, 'Was this week\'s tutorial useful?', JSON.stringify(['Yes', 'Somewhat', 'No']), JSON.stringify([4, 3, 1]), lecturerId, now - 3 * 60 * MIN, now + 7 * DAY_MS);
    q(`INSERT INTO attendance_sessions (class_id, label, started_by, started_at, kind) VALUES (?, 'Tut 4, today', ?, ?, 'tut')`).run(cls.id, lecturerId, now);
    flashRedirect(res, `/c/${cls.code}`, 'ok', `${DEMO_JOINED}: you're a student. Today shows the announcement and the question. Check in to today's tut from the test tools.`);
  });

  // sign in as one of the test students, to try the student side on a second device (like scanning the QR on a phone).
  // Only test students, and there is no way back to admin without the admin password.
  app.post('/admin/tools/become', requireUser, requireTools, (req, res) => {
    const i = Number(req.body.student);
    if (!Number.isInteger(i) || i < 0 || i >= TestData.FAKE_STUDENTS.length) return flashRedirect(res, '/admin/tools#classes', 'error', 'Pick one of the test students.');
    fakeStudentIds(req.user.uni);
    const email = TestData.fakeEmail(i);
    if (!q(`SELECT 1 FROM users WHERE email = ? AND is_test = 1 AND is_admin = 0`).get(email)) return res.status(404).page(notFound(req));
    startSession(req, res, email, '/classes');
  });

  // everything the test tools made: the fake students and all they own, test groups, and the admin's study data
  app.post('/admin/tools/clear-all', requireUser, requireTools, (req, res) => {
    const fakes = q(`SELECT id FROM users WHERE is_test = 1 AND is_admin = 0`).all().map((u) => u.id);
    const testOwned = `IN (SELECT id FROM users WHERE is_test = 1)`;
    db.exec('BEGIN');
    try {
      q(`DELETE FROM study_groups WHERE owner_id ${testOwned}`).run();
      q(`DELETE FROM group_members WHERE user_id ${testOwned}`).run();
      q(`DELETE FROM study_sessions WHERE user_id ${testOwned}`).run();
      q(`DELETE FROM name_reports WHERE user_id ${testOwned} OR target_id ${testOwned}`).run();
      q(`DELETE FROM profiles WHERE user_id ${testOwned}`).run();
      // classes test accounts run (the demo classes) go with their members, dates, tuts, posts and pulses; then anything
      // test accounts left in real classes
      q(`DELETE FROM classes WHERE owner_id ${testOwned}`).run();
      q(`DELETE FROM attendance WHERE user_id ${testOwned}`).run();
      q(`DELETE FROM pulse_answered WHERE user_id ${testOwned}`).run();
      q(`DELETE FROM announcement_reads WHERE user_id ${testOwned}`).run();
      q(`DELETE FROM announcement_reports WHERE user_id ${testOwned}`).run();
      q(`DELETE FROM class_announcements WHERE posted_by ${testOwned}`).run();
      q(`UPDATE class_pulses SET asked_by = NULL WHERE asked_by ${testOwned}`).run();
      q(`DELETE FROM class_dates WHERE added_by ${testOwned}`).run();
      q(`UPDATE attendance_sessions SET started_by = NULL WHERE started_by ${testOwned}`).run();
      q(`DELETE FROM class_members WHERE user_id ${testOwned}`).run();
      q(`UPDATE users SET role = 'student' WHERE id = ?`).run(req.user.id);
      for (const id of fakes) {
        q(`DELETE FROM sessions WHERE user_id = ?`).run(id);
        q(`DELETE FROM users WHERE id = ?`).run(id);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    flashRedirect(res, '/admin/tools', 'ok', `Cleared: ${fakes.length} test accounts, their groups and demo classes, and all test study data. You're a student again.`);
  });

  function startSession(req, res, email, next) {
    const account = accountFor(email);
    q(`INSERT INTO users (email, uni, role) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING`).run(email, (account?.uni || CURRENT).slug, account?.role || 'student');
    // every sign-in starts at the form with the 18+ and terms box, so this records when the account first agreed
    q(`UPDATE users SET agreed_at = CURRENT_TIMESTAMP WHERE email = ? AND agreed_at IS NULL`).run(email);
    const user = q(`SELECT * FROM users WHERE email = ?`).get(email);
    if (user.banned) return res.status(403).page(views.message(req.ctx, { title: 'Account suspended', emoji: '🚫', text: 'This account has been suspended for breaking the house rules.' }));
    const sid = crypto.randomBytes(32).toString('hex');
    q(`INSERT INTO sessions (hash, user_id, expires) VALUES (?, ?, ?)`).run(sha(sid), user.id, Date.now() + SESSION_TTL);
    res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', secure: !devMode, maxAge: SESSION_TTL });
    flashRedirect(res, safeNext(next), 'ok', "You're signed in. Anything you post shows without your name.");
  }

  app.post('/login/code', limits.login, limits.loginCode, limits.loginCodeEmail, (req, res) => {
    const email = normEmail(req.body.email);
    const code = String(req.body.code || '').replace(/\D/g, '');
    const rows = q(`SELECT * FROM login_tokens WHERE email = ? AND expires > ?`).all(email, Date.now());
    const row = code.length === 6 && rows.find((r) => r.code_hash && crypto.timingSafeEqual(Buffer.from(r.code_hash), Buffer.from(codeHash(email, code))));
    if (!row) {
      // Guesses are capped per IP and address (limits.loginCode) instead of deleting the address's codes, which
      // would let a stranger's wrong guesses lock the real student out.
      return res.status(400).page(views.checkEmail(req.ctx, {
        email,
        error: "That code doesn't match or has expired. Check the latest email from Kwaai, or go back and ask for a new one.",
      }));
    }
    q(`DELETE FROM login_tokens WHERE hash = ?`).run(row.hash);
    startSession(req, res, row.email, row.next);
  });

  // Opening the link only shows a button. Signing in happens on the POST, because email scanners (Microsoft 365,
  // which runs myuct mail, is one) open links to check them and would use up a one-time link before the student does.
  const linkRow = (token) => q(`SELECT * FROM login_tokens WHERE hash = ? AND expires > ?`).get(sha(String(token)), Date.now());
  const expired = (req, res) => res.status(400).page(views.message(req.ctx, { title: 'Link expired', emoji: '⌛', text: 'That sign-in link has expired or was already used.', link: { href: '/login', label: 'Get a new link' } }));
  app.get('/auth/:token', (req, res) => {
    const row = linkRow(req.params.token);
    if (!row) return expired(req, res);
    res.page(views.confirmSignIn(req.ctx, { email: row.email, token: req.params.token }));
  });
  app.post('/auth/:token', limits.login, (req, res) => {
    const row = linkRow(req.params.token);
    if (!row) return expired(req, res);
    q(`DELETE FROM login_tokens WHERE hash = ?`).run(row.hash);
    startSession(req, res, row.email, row.next);
  });

  app.post('/logout', (req, res) => {
    const sid = /(?:^|;\s*)sid=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
    if (sid) q(`DELETE FROM sessions WHERE hash = ?`).run(sha(sid));
    res.clearCookie('sid');
    res.redirect(303, '/');
  });

  // ---- moderation ----
  app.get('/mod', requireUser, requireMod, (req, res) => {
    const held = q(`SELECT ${REVIEW_COLS}, (SELECT GROUP_CONCAT(NULLIF(details, ''), ' / ') FROM reports WHERE review_id = r.id AND resolved = 0) AS report_details
      FROM reviews r LEFT JOIN lecturers l ON l.id = r.lecturer_id WHERE r.status = 'held' ORDER BY r.created_at`).all();
    const takedowns = q(`SELECT * FROM takedowns WHERE status = 'open' ORDER BY created_at`).all();
    const suggestions = q(`SELECT s.*, d.name AS dept_name FROM lecturer_suggestions s JOIN departments d ON d.code = s.dept WHERE s.status = 'open' ORDER BY s.created_at`).all();
    const heldTips = q(`SELECT * FROM verdicts WHERE status = 'held' ORDER BY created_at`).all();
    const log = q(`SELECT * FROM mod_log ORDER BY id DESC LIMIT 30`).all();
    const heldFacts = q(`SELECT course, kind, key, MIN(data) AS data, COUNT(DISTINCT user_id) AS n, (SELECT COUNT(*) FROM fact_reports r WHERE r.course = f.course AND r.key = f.key) AS reports
      FROM course_facts f WHERE status = 'held' GROUP BY course, key ORDER BY MIN(created_at)`).all().map((f) => ({ ...f, data: JSON.parse(f.data) }));
    const heldNames = q(`SELECT p.user_id, p.display_name, (SELECT COUNT(*) FROM name_reports r WHERE r.target_id = p.user_id) AS reports FROM profiles p WHERE p.name_held = 1 ORDER BY p.user_id`).all();
    const heldAnnouncements = q(`SELECT a.*, c.code, c.name AS class_name, (SELECT COUNT(*) FROM announcement_reports r WHERE r.announcement_id = a.id) AS reports
      FROM class_announcements a JOIN classes c ON c.id = a.class_id WHERE a.hidden = 1 ORDER BY a.created_at`).all();
    res.page(views.mod(req.ctx, { held, heldTips, takedowns, suggestions, log, heldFacts, heldNames, heldAnnouncements }));
  });

  // a held course detail: approve puts it back and clears its reports; remove takes it down for good
  app.post('/mod/facts/:action', requireUser, requireMod, (req, res) => {
    const { action } = req.params;
    const course = String(req.body.course || '').toUpperCase();
    const key = String(req.body.key || '');
    if (!['approve', 'remove'].includes(action) || !q(`SELECT 1 FROM course_facts WHERE course = ? AND key = ?`).get(course, key)) return res.status(404).page(notFound(req));
    q(`UPDATE course_facts SET status = ? WHERE course = ? AND key = ?`).run(action === 'approve' ? 'published' : 'removed', course, key);
    q(`DELETE FROM fact_reports WHERE course = ? AND key = ?`).run(course, key);
    q(`INSERT INTO mod_log (action, note, moderator) VALUES (?, ?, ?)`).run(`${action} course detail`, `${course} ${key.split('|')[0]}`, req.user.email);
    flashRedirect(res, '/mod', 'ok', `${course}: ${action === 'approve' ? 'back up' : 'removed'}.`);
  });

  // a reported leaderboard name: allow puts it back; reset removes it, so the student shows anonymously until they pick another
  app.post('/mod/names/:id/:action', requireUser, requireMod, (req, res) => {
    const { action } = req.params;
    const p = q(`SELECT * FROM profiles WHERE user_id = ?`).get(Number(req.params.id));
    if (!['allow', 'reset'].includes(action) || !p) return res.status(404).page(notFound(req));
    if (action === 'allow') q(`UPDATE profiles SET name_held = 0 WHERE user_id = ?`).run(p.user_id);
    else q(`UPDATE profiles SET display_name = '', show_name = 0, name_held = 0 WHERE user_id = ?`).run(p.user_id);
    q(`DELETE FROM name_reports WHERE target_id = ?`).run(p.user_id);
    q(`INSERT INTO mod_log (action, note, moderator) VALUES (?, ?, ?)`).run(`${action} leaderboard name`, `student #${p.user_id}`, req.user.email);
    flashRedirect(res, '/mod', 'ok', action === 'allow' ? 'Name back up.' : 'Name removed.');
  });

  // a reported class announcement: allow puts it back and clears its reports; remove deletes it
  app.post('/mod/announcements/:id/:action', requireUser, requireMod, (req, res) => {
    const { action } = req.params;
    const a = q(`SELECT * FROM class_announcements WHERE id = ?`).get(Number(req.params.id) || 0);
    if (!['allow', 'remove'].includes(action) || !a) return res.status(404).page(notFound(req));
    if (action === 'allow') {
      q(`UPDATE class_announcements SET hidden = 0 WHERE id = ?`).run(a.id);
      q(`DELETE FROM announcement_reports WHERE announcement_id = ?`).run(a.id);
    } else q(`DELETE FROM class_announcements WHERE id = ?`).run(a.id);
    q(`INSERT INTO mod_log (action, note, moderator) VALUES (?, ?, ?)`).run(`${action} class announcement`, `announcement #${a.id}`, req.user.email);
    flashRedirect(res, '/mod', 'ok', action === 'allow' ? 'Announcement back up.' : 'Announcement removed.');
  });

  app.post('/mod/reviews/:id/:action', requireUser, requireMod, (req, res) => {
    const r = q(`SELECT * FROM reviews WHERE id = ?`).get(Number(req.params.id) || 0);
    const action = req.params.action;
    if (!r || !['approve', 'remove', 'ban'].includes(action)) return res.status(404).page((notFound(req)));
    q(`UPDATE reviews SET status = ?, flags = CASE WHEN ? = 'approve' THEN '' ELSE flags END WHERE id = ?`).run(action === 'approve' ? 'published' : 'removed', action, r.id);
    q(`UPDATE reports SET resolved = 1 WHERE review_id = ?`).run(r.id);
    if (action === 'ban' && r.user_id) q(`UPDATE users SET banned = 1 WHERE id = ?`).run(r.user_id);
    q(`INSERT INTO mod_log (review_id, action, note, moderator) VALUES (?, ?, ?, ?)`).run(r.id, action, String(req.body.note || '').slice(0, 200), req.user.email);
    flashRedirect(res, '/mod', 'ok', `Review #${r.id}: ${action === 'approve' ? 'approved and back up' : action === 'ban' ? 'removed, author banned' : 'removed'}.`);
  });

  app.post('/mod/verdicts/:id/:action', requireUser, requireMod, (req, res) => {
    const v = q(`SELECT * FROM verdicts WHERE id = ?`).get(Number(req.params.id) || 0);
    const action = req.params.action;
    if (!v || !['approve', 'remove', 'ban'].includes(action)) return res.status(404).page(notFound(req));
    q(`UPDATE verdicts SET status = ?, flags = CASE WHEN ? = 'approve' THEN '' ELSE flags END WHERE id = ?`).run(action === 'approve' ? 'published' : 'removed', action, v.id);
    if (action === 'ban') q(`UPDATE users SET banned = 1 WHERE id = ?`).run(v.user_id);
    q(`INSERT INTO mod_log (action, note, moderator) VALUES (?, ?, ?)`).run(`${action} tip`, `tip #${v.id} on ${v.course}`, req.user.email); // no tip text: the log outlives deleted accounts
    flashRedirect(res, '/mod', 'ok', `Tip #${v.id}: ${action === 'approve' ? 'approved and back up' : action === 'ban' ? 'removed, author banned' : 'removed'}.`);
  });

  app.post('/mod/suggestions/:id/:action', requireUser, requireMod, (req, res) => {
    const s = q(`SELECT * FROM lecturer_suggestions WHERE id = ? AND status = 'open'`).get(Number(req.params.id) || 0);
    const action = req.params.action;
    if (!s || !['approve', 'reject'].includes(action)) return res.status(404).page(notFound(req));
    if (action === 'approve') q(`INSERT OR IGNORE INTO lecturers (name, dept) VALUES (?, ?)`).run(s.name, s.dept);
    q(`UPDATE lecturer_suggestions SET status = ? WHERE id = ?`).run(action === 'approve' ? 'approved' : 'rejected', s.id);
    q(`INSERT INTO mod_log (action, note, moderator) VALUES (?, ?, ?)`).run(`${action} lecturer`, `${s.name} (${s.dept}, ${s.course})`, req.user.email);
    flashRedirect(res, '/mod', 'ok', action === 'approve' ? `${s.name} added.` : 'Suggestion rejected.');
  });

  app.post('/mod/takedowns/:id/close', requireUser, requireMod, (req, res) => {
    const t = q(`SELECT * FROM takedowns WHERE id = ?`).get(Number(req.params.id) || 0);
    if (!t) return res.status(404).page((notFound(req)));
    q(`UPDATE takedowns SET status = 'closed' WHERE id = ?`).run(t.id);
    q(`INSERT INTO mod_log (review_id, action, note, moderator) VALUES (?, 'close request', ?, ?)`).run(t.review_id, `request #${t.id}`, req.user.email);
    flashRedirect(res, '/mod', 'ok', 'Request marked as handled.');
  });

  app.use((req, res) => res.status(404).page((notFound(req))));
  app.use((err, req, res, next) => {
    const status = err.status >= 400 && err.status < 500 ? err.status : 500; // e.g. 413 for an oversized form
    if (status === 500) console.error(err);
    // errors from the body parser happen before the session middleware, so res.page may not exist yet
    res.status(status).send(String(views.message(req.ctx || {}, status === 500
      ? { title: 'Something broke', emoji: '🫠', text: 'Sorry, that was our fault. Please try again.' }
      : { title: 'That request didn\'t work', emoji: '🤔', text: 'Please go back and try again.' })));
  });
  return app;
}

module.exports = { createApp };
