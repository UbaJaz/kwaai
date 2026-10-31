const crypto = require('node:crypto');
const path = require('node:path');
const zlib = require('node:zlib');
const express = require('express');
const views = require('./views');
const { RANKINGS, MIN_FOR_RANKING, PLAN_MAX, parseReviewForm, parseVerdictForm } = require('./ratings');
const { analysePlan, REPLACED, parseProfile, hasProfile, profileParams, majorNeeds, creditAdvice, programmeOptions, facultyOptions } = require('./planner');
const { screenComment, REPORT_REASONS, HIDE_AFTER_REPORTS } = require('./moderation');
const { UNIVERSITIES, CURRENT } = require('./universities');

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
  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
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
    // sign-in emails per IP, kept high enough for a computer lab or residence Wi-Fi
    loginSend: limit(30, 60 * MIN, (req) => `send:${req.ip}`),
    review: limit(10, 60 * MIN, byUser),
    verdict: limit(30, 60 * MIN, byUser),
    suggest: limit(5, 60 * MIN, byUser),
    report: limit(30, 60 * MIN, byUser),
    takedown: limit(10, 60 * MIN),
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
    res.page((views.course(req.ctx, { c, stats, offerings, reviews, topTags, myHeld, votes, tips, myVerdict, years: years(), locked: !canReadAll(req), conveners, staff })));
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
  const planQuery = (codes, profile = parseProfile()) => Object.entries({ ...(codes.length && { c: codes.join(',') }), ...profileParams(profile) })
    .map(([k, v]) => `${k}=${keepCommas(String(v))}`).join('&');
  const planUrl = (codes, profile) => {
    const qs = planQuery(codes, profile);
    return qs ? `/plan?${qs}` : '/plan';
  };
  const savePlan = (res, codes, profile) => res.cookie('plan', planQuery(codes, profile), { httpOnly: true, sameSite: 'lax', secure: !devMode, maxAge: 180 * 24 * 60 * 60 * 1000 });
  const PLAN_KEYS = ['c', 'f', 'm', 'y', 'done'];

  app.get('/plan', (req, res) => {
    // the cookie holds the query string; older ones hold only the course codes
    let savedRaw = '';
    try { savedRaw = decodeURIComponent(/(?:^|;\s*)plan=([^;]*)/.exec(req.headers.cookie || '')?.[1] || ''); } catch { /* a mangled cookie is just an empty plan */ }
    const saved = savedRaw.includes('=') ? Object.fromEntries(new URLSearchParams(savedRaw)) : { c: savedRaw };
    const fromUrl = PLAN_KEYS.some((k) => req.query[k] != null);
    const state = fromUrl ? req.query : saved;
    let codes = planCodes(state.c);
    let profile = parseProfile(state);
    // the "about you" form: majors come from two selects, passed courses from ticked boxes plus a free text box
    if (req.query.about != null) {
      profile = req.query.about === 'clear' ? parseProfile() : parseProfile({
        f: req.query.f, y: req.query.y, m: [req.query.m1, req.query.m2].filter(Boolean).join(','), done: [req.query.done ?? [], req.query.more ?? ''].flat().join(','),
      });
      savePlan(res, codes, profile);
      return res.redirect(303, planUrl(codes, profile));
    }
    const remove = String(req.query.remove || '').toUpperCase();
    const add = String(req.query.add || '').trim().slice(0, 80);
    if (remove) {
      codes = codes.filter((x) => x !== remove);
      savePlan(res, codes, profile);
      return res.redirect(303, planUrl(codes, profile));
    }
    let matches = null;
    if (add) {
      // "csc1015f", "CSC 1015F" and "csc1015" all work; a code that matches one course adds it straight away
      const squashed = add.replace(/\s+/g, '').toUpperCase();
      // an old code like MAM1000W adds the courses that replaced it
      const newer = REPLACED[squashed]?.filter((x) => !codes.includes(x));
      if (newer) {
        if (codes.length + newer.length > PLAN_MAX) return flashRedirect(res, planUrl(codes, profile), 'error', `A plan can hold ${PLAN_MAX} courses. Remove one first.`);
        codes.push(...newer);
        savePlan(res, codes, profile);
        return flashRedirect(res, planUrl(codes, profile), 'ok', `${squashed} has been replaced by ${REPLACED[squashed].join(' and ')}, so ${newer.length ? 'those are in your plan now' : 'your plan already has it covered'}.`);
      }
      const byCode = /^[A-Z]{3}\d{1,4}[A-Z]?$/.test(squashed) ? q(`SELECT code FROM courses WHERE code LIKE ? ORDER BY code LIMIT 13`).all(`${squashed}%`) : [];
      const exact = getCourse(squashed) || (byCode.length === 1 ? getCourse(byCode[0].code) : null);
      if (exact) {
        if (!codes.includes(exact.code) && codes.length >= PLAN_MAX) return flashRedirect(res, planUrl(codes, profile), 'error', `A plan can hold ${PLAN_MAX} courses. Remove one first.`);
        if (!codes.includes(exact.code)) codes.push(exact.code);
        savePlan(res, codes, profile);
        return res.redirect(303, planUrl(codes, profile));
      }
      matches = q(`SELECT code, title FROM courses WHERE code LIKE ? OR title LIKE ? ORDER BY (code LIKE ?) DESC, (nqf IS NULL OR nqf <= 7) DESC, code LIMIT 12`)
        .all(`%${squashed}%`, `%${add}%`, `${squashed}%`);
    }
    if (!fromUrl && (codes.length || hasProfile(profile)) && !matches) return res.redirect(303, planUrl(codes, profile));
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
      state: Object.fromEntries(new URLSearchParams(planQuery(courses.map((c) => c.code), profile))),
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
    q(`INSERT INTO users (email) VALUES (?) ON CONFLICT(email) DO NOTHING`).run(email);
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
    res.page(views.mod(req.ctx, { held, heldTips, takedowns, suggestions, log }));
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
