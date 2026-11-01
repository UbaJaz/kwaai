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
const { UNIVERSITIES, CURRENT, uniForEmail } = require('./universities');
const Study = require('./study');

const STUDENT_EMAIL = /^[a-z0-9._%+-]+@myuct\.ac\.za$/;
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
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

function createApp(db, { moderators = new Set(), devMode = true, sendLoginEmail, baseUrl, trustProxy, contactEmail, operator = 'Ubayd Hattas and Jaswin Chinthala', informationOfficer = operator, demoPassword, emailDailyCap = 280 } = {}) {
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
    req.ctx = { user: req.user, isMod: !!req.user && mods.has(req.user.email), flash: parseFlash(flash), uni: CURRENT, here: req.path,
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
    res.page(views.courses(req.ctx, { mode: 'faculties', list }));
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
    const studying = liveStudents(`course = ?`, c.code);
    res.page((views.course(req.ctx, { c, stats, offerings, reviews, topTags, myHeld, votes, tips, myVerdict, years: years(), locked: !canReadAll(req), conveners, staff, facts, weekTopics: weekTopics(draft, facts.topic), studyingNow: studying >= Study.MIN_LIVE_SHOWN ? studying : 0 })));
  });

  app.get('/lecturers/:id', (req, res) => {
    const l = q(`SELECT l.*, d.name AS dept_name FROM lecturers l JOIN departments d ON d.code = l.dept WHERE l.id = ?`).get(Number(req.params.id) || 0);
    if (!l) return res.status(404).page((notFound(req)));
    const stats = q(`SELECT ${STATS} FROM reviews WHERE lecturer_id = ? AND status = 'published'`).get(l.id);
    const taught = q(`SELECT c.code, c.title, s.n, s.overall FROM courses c
      LEFT JOIN (SELECT course, COUNT(*) AS n, AVG(overall) AS overall FROM reviews WHERE lecturer_id = ? AND status = 'published' GROUP BY course) s ON s.course = c.code
      WHERE s.n > 0 OR ('|' || c.conveners || '|') LIKE ? ORDER BY c.code`).all(l.id, `%|${l.name}|%`);
    const reviews = q(`SELECT ${REVIEW_COLS} FROM reviews r LEFT JOIN lecturers l ON l.id = r.lecturer_id WHERE r.lecturer_id = ? AND r.status = 'published' ORDER BY r.created_at DESC, r.id DESC`).all(l.id);
    res.page((views.lecturer(req.ctx, { l, stats, courses: taught, reviews, locked: !canReadAll(req) })));
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
    const state = fromUrl ? query : saved;
    return { fromUrl, codes: planCodes(state.c), profile: parseProfile(state), week: parseWeek(state) };
  }

  app.get('/plan', (req, res) => {
    const saved = readPlan(req);
    const { fromUrl, week } = saved;
    let { codes, profile } = saved;
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
      courses, plan, matches, add, codes: courses.map((c) => c.code),
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
  // for calendar files: student times, dated events, and a "start revising" day before each exam
  const crowdFor = (codes) => {
    const facts = factsFor(codes);
    const dated = datedFor(facts);
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
    const wk = buildWeek(codes.map((c) => rows.find((r) => r.code === c)).filter(Boolean), week, { crowd: crowdSlots(facts) });
    const upcoming = datedFor(facts).filter((d) => d.date >= new Date().toISOString().slice(0, 10)).slice(0, 12);
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
      .send(icsFor(codes.map((c) => rows.find((r) => r.code === c)).filter(Boolean), week, { origin: baseUrl || '', ...crowdFor(codes) }));
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
  function todayFor(codes, week) {
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
    const wk = buildWeek(codes.map((c) => rows.find((r) => r.code === c)).filter(Boolean), { ...week, t: term }, { year, crowd: crowdSlots(facts) });
    const classes = wk.events.filter((e) => e.day === dayName).sort((a, b) => a.start.localeCompare(b.start));
    const soon = new Date(Date.parse(`${date}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10);
    const upcoming = datedFor(facts).filter((d) => d.date >= date && d.date <= soon);
    const todays = [...new Set(classes.map((e) => e.code).filter(Boolean))];
    const tip = todays.length ? q(`SELECT course, tip FROM verdicts WHERE status = 'published' AND tip != '' AND course IN (${todays.map(() => '?').join(',')}) ORDER BY RANDOM() LIMIT 1`).get(...todays) : null;
    return { date, term, note, weekend: weekday === 0 || weekday === 6, dayName, classes, upcoming, tip, marks: marksCourses(wk.courses.map((c) => c.code)),
      // courses to start a study timer for: this term's, or the whole plan between terms
      study: wk.courses.length ? wk.courses.map((c) => c.code) : codes };
  }

  app.get('/today', (req, res) => {
    const { codes, profile, week } = readPlan(req);
    res.set('Cache-Control', 'no-store').page(views.today(req.ctx, { today: codes.length ? todayFor(codes, week) : null, weekLink: planUrl(codes, profile, week, '/week'), streak: req.user ? streakFor(req.user.id) : null }));
  });

  // ---- study timer ----
  // The rules (what a heartbeat earns, the caps) live in src/study.js. The page sends a heartbeat about once a minute
  // while the timer runs; a session nobody is timing any more is closed with what it had earned.
  // students with a timer running right now (a heartbeat in the last two minutes), counted over a filter
  function liveStudents(where, ...args) {
    return q(`SELECT COUNT(DISTINCT user_id) AS n FROM study_sessions WHERE status = 'running' AND last_beat >= ? AND ${where}`).get(Study.liveSince(Date.now()), ...args).n;
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
      board: req.user ? studyBoard(req.user.id, codes, req.query.day) : null,
      studyingNow: liveStudents(`uni = ?`, req.user?.uni ?? CURRENT.slug),
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

  function studyBoard(userId, codes, askedDay) {
    const today = Study.saDay(Date.now());
    const totals = studyTotals(userId, today);
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
      days: totals.filter((t) => t.minutes > 0).reverse(),
    };
  }

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
    res.page(views.profile(req.ctx, { profile: profileOf(req.user.id), faculties: facultyOptions(), programmes: programmeOptions() }));
  });

  app.post('/account/profile', requireUser, limits.profile, (req, res) => {
    const parsed = Study.parseProfileForm(req.body, knownProfile, screenComment);
    const id = req.user.id;
    if (parsed.leave) {
      q(`DELETE FROM profiles WHERE user_id = ?`).run(id);
      q(`DELETE FROM name_reports WHERE target_id = ?`).run(id);
      return flashRedirect(res, '/account/profile', 'ok', "You've left the leaderboards. Your study time is still yours on the Study page.");
    }
    if (parsed.error) return res.status(400).page(views.profile(req.ctx, { profile: { ...req.body, show_name: req.body.show === 'name' ? 1 : 0 }, faculties: facultyOptions(), programmes: programmeOptions(), error: parsed.error }));
    const p = parsed.profile;
    const before = profileOf(id);
    // a new name gets a fresh start: earlier reports were about the old one
    if (before && before.display_name !== p.display_name) q(`DELETE FROM name_reports WHERE target_id = ?`).run(id);
    q(`INSERT INTO profiles (user_id, uni, display_name, show_name, faculty, major, year) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, show_name = excluded.show_name, faculty = excluded.faculty, major = excluded.major, year = excluded.year,
        name_held = CASE WHEN profiles.display_name = excluded.display_name THEN profiles.name_held ELSE 0 END`)
      .run(id, req.user.uni, p.display_name, p.show_name, p.faculty, p.major, p.year);
    flashRedirect(res, '/study/leaderboards', 'ok', before ? 'Saved.' : "You're on the leaderboards.");
  });

  app.get('/study/leaderboards', requireUser, (req, res) => {
    const me = profileOf(req.user.id);
    const period = Study.PERIODS[req.query.period] ? req.query.period : 'week';
    const scope = req.query.scope === 'faculty' ? 'faculty' : 'uni';
    const faculty = FACULTIES[req.query.f] ? req.query.f : me?.faculty || 'sci';
    const [from, to] = Study.periodRange(period, Study.saDay(Date.now()));
    // minutes per student over the period, each day capped like everywhere else
    const rows = q(`SELECT p.*, SUM(x.m) AS minutes FROM profiles p JOIN (
        SELECT user_id, day, MIN(SUM(credited_sec / 60), ${Study.DAY_CAP_MIN}) AS m FROM study_sessions
        WHERE status = 'done' AND uni = ? AND day BETWEEN ? AND ? GROUP BY user_id, day
      ) x ON x.user_id = p.user_id WHERE p.uni = ? ${scope === 'faculty' ? 'AND p.faculty = ?' : ''} GROUP BY p.user_id`)
      .all(...[req.user.uni, from, to, req.user.uni, ...(scope === 'faculty' ? [faculty] : [])]);
    const board = Study.rankBoard(rows, req.user.id);
    const show = (r) => ({ rank: r.rank, minutes: r.minutes, name: boardName(r), you: r.user_id === req.user.id, id: r.user_id, reportable: !!(r.show_name && r.display_name && !r.name_held) && r.user_id !== req.user.id });
    res.set('Cache-Control', 'no-store').page(views.leaderboard(req.ctx, {
      joined: !!me, period, scope, faculty, faculties: facultyOptions(), rows: board.rows.map(show), me: board.me && show(board.me), total: board.total,
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
      rows: Study.rankBoard(rows, req.user.id, Study.MAX_MEMBERS).rows.map(show), idle: rows.filter((r) => !r.minutes).map(show),
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
    const dated = datedFor(facts);
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

  app.get('/courses/:code/review', requireUser, (req, res) => {
    const c = getCourse(req.params.code);
    if (!c) return res.status(404).page((notFound(req)));
    res.page((views.reviewForm(req.ctx, formData(c))));
  });

  app.post('/courses/:code/review', requireUser, limits.review, (req, res) => {
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

  app.post('/courses/:code/verdict', requireUser, limits.verdict, (req, res) => {
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
    if (!STUDENT_EMAIL.test(email)) return res.status(400).page(views.login(req.ctx, { email, next, error: 'That isn\'t a student email. Use your @myuct.ac.za address.' }));
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

  function startSession(req, res, email, next) {
    q(`INSERT INTO users (email, uni) VALUES (?, ?) ON CONFLICT(email) DO NOTHING`).run(email, (uniForEmail(email) || CURRENT).slug);
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
    res.page(views.mod(req.ctx, { held, heldTips, takedowns, suggestions, log, heldFacts, heldNames }));
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
