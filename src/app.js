const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const views = require('./views');
const { RANKINGS, MIN_FOR_RANKING, PLAN_MAX, parseReviewForm, parseVerdictForm, semesterLoad } = require('./ratings');
const { screenComment, REPORT_REASONS, HIDE_AFTER_REPORTS } = require('./moderation');

const STUDENT_EMAIL = /^[a-z0-9._%+-]+@myuct\.ac\.za$/;
const TOKEN_TTL = 15 * 60 * 1000;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const parseFlash = (v) => { try { return v ? JSON.parse(decodeURIComponent(v)) : null; } catch { return null; } };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const STATS = `COUNT(*) AS n, AVG(overall) AS overall, AVG(teaching) AS teaching, AVG(engagement) AS engagement,
  AVG(exams) AS exams, AVG(support) AS support, AVG(difficulty) AS difficulty, AVG(workload) AS workload, MAX(is_sample) AS has_sample`;
const REVIEW_COLS = `r.*, l.name AS lecturer_name`;
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

function createApp(db, { moderators = new Set(), devMode = true, sendLoginEmail, baseUrl, trustProxy, contactEmail, operator = 'the LekkerOrNah team' } = {}) {
  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', trustProxy); // so req.ip is the student's IP behind a host's proxy
  app.use((req, res, next) => {
    res.set({ 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' });
    if (!devMode) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.use(express.static(path.join(__dirname, '..', 'public')));
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
    req.ctx = { user: req.user, isMod: !!req.user && moderators.has(req.user.email), flash: parseFlash(flash),
      // origin for share links and link previews; production always has BASE_URL
      site: { contactEmail, operator, origin: baseUrl || `${req.protocol}://${req.get('host')}` } };
    // CSRF: double-submit token, added to every POST form on its way out
    let csrf = /(?:^|;\s*)csrf=([a-f0-9]{32})/.exec(req.headers.cookie || '')?.[1];
    if (!csrf) {
      csrf = crypto.randomBytes(16).toString('hex');
      res.cookie('csrf', csrf, { httpOnly: true, sameSite: 'lax', secure: !devMode });
    }
    req.ctx.csrf = csrf;
    res.page = (page) => res.send(String(page).replace(/<form method="post"([^>]*)>/g, `<form method="post"$1><input type="hidden" name="_csrf" value="${csrf}">`));
    next();
  });
  app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const sent = String(req.body._csrf || '');
    if (sent.length === 32 && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(req.ctx.csrf))) return next();
    res.status(403).page(views.message(req.ctx, { title: 'Form expired', emoji: '🔄', text: 'Please go back, refresh the page and try again.' }));
  });

  // shortcut: in-memory counters, fine for one server process; move them to SQLite or Redis if you ever run several
  function limit(max, windowMs, keyOf = (req) => req.ip) {
    const hits = new Map();
    return (req, res, next) => {
      const now = Date.now();
      const key = keyOf(req);
      let h = hits.get(key);
      if (!h || h.reset < now) hits.set(key, (h = { n: 0, reset: now + windowMs }));
      if (hits.size > 50_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      if (++h.n > max) return res.status(429).page(views.message(req.ctx, { title: 'Slow down', emoji: '🐢', text: 'Too many requests from you. Please wait a while and try again.' }));
      next();
    };
  }
  const MIN = 60_000;
  // Campus Wi-Fi and mobile networks put many students behind one IP, so signed-in actions are limited per account
  // and per-IP limits stay generous. Anonymous reports and takedowns can only be limited per IP.
  const byUser = (req) => `user:${req.user.id}`;
  const limits = {
    login: limit(100, 15 * MIN),
    loginEmail: limit(3, 15 * MIN, (req) => String(req.body.email || '').trim().toLowerCase()), // stops someone spamming a student's inbox
    review: limit(10, 60 * MIN, byUser),
    verdict: limit(30, 60 * MIN, byUser),
    suggest: limit(5, 60 * MIN, byUser),
    report: limit(30, 60 * MIN),
    takedown: limit(10, 60 * MIN),
  };
  const flashRedirect = (res, to, type, text) => {
    res.cookie('flash', JSON.stringify({ type, text }), { httpOnly: true, sameSite: 'lax', maxAge: 60_000 });
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
    const counts = q(`SELECT (SELECT COUNT(*) FROM courses) AS courses, (SELECT COUNT(*) FROM lecturers) AS lecturers, (SELECT COUNT(*) FROM reviews WHERE status = 'published') AS reviews`).get();
    res.page((views.home(req.ctx, {
      counts,
      topCourses: ranking('course', RANKINGS[0], null, 5),
      funniest: ranking('lecturer', RANKINGS[1], null, 5),
      hardest: ranking('course', RANKINGS[2], null, 5),
      depts: depts(),
    })));
  });

  app.get('/courses', (req, res) => {
    const text = String(req.query.q || '').trim().slice(0, 80);
    const dept = String(req.query.dept || '').toUpperCase().slice(0, 3);
    const where = [];
    const params = [];
    if (text) { where.push('(c.code LIKE ? OR c.title LIKE ?)'); params.push(`%${text}%`, `%${text}%`); }
    if (dept) { where.push('c.dept = ?'); params.push(dept); }
    const max = where.length ? 500 : 60; // the unfiltered list shows reviewed courses first, then a taste of the rest
    const list = courseList(where.length ? `WHERE ${where.join(' AND ')}` : '', params, 's.n IS NULL, s.n DESC, c.code', max);
    const total = q(`SELECT COUNT(*) AS n FROM courses c ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).get(...params).n;
    res.page(views.courses(req.ctx, { list, total, depts: depts(), q: text, dept }));
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
    res.page((views.course(req.ctx, { c, stats, offerings, reviews, topTags, myHeld, votes, tips, myVerdict, years: years(), locked: !canReadAll(req) })));
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
  // The plan lives in the URL so it can be shared, and in a cookie so it's still there next visit.
  // Opening someone else's link only shows their plan; it changes yours only once you add or remove a course.
  const COURSE_CODE = /^[A-Z]{3}\d{4}[A-Z]$/;
  const planCodes = (s) => [...new Set(String(s || '').toUpperCase().split(/[\s,]+/).filter((x) => COURSE_CODE.test(x)))].slice(0, PLAN_MAX);
  const planUrl = (codes) => (codes.length ? `/plan?c=${codes.join(',')}` : '/plan');
  const savePlan = (res, codes) => res.cookie('plan', codes.join(','), { httpOnly: true, sameSite: 'lax', secure: !devMode, maxAge: 180 * 24 * 60 * 60 * 1000 });

  app.get('/plan', (req, res) => {
    const saved = /(?:^|;\s*)plan=([A-Za-z0-9,%]*)/.exec(req.headers.cookie || '')?.[1];
    const fromUrl = req.query.c != null;
    let codes = planCodes(fromUrl ? req.query.c : decodeURIComponent(saved || ''));
    const remove = String(req.query.remove || '').toUpperCase();
    const add = String(req.query.add || '').trim().slice(0, 80);
    if (remove) {
      codes = codes.filter((x) => x !== remove);
      savePlan(res, codes);
      return res.redirect(303, planUrl(codes));
    }
    let matches = null;
    if (add) {
      const exact = getCourse(add.replace(/\s+/g, ''));
      if (exact) {
        if (!codes.includes(exact.code) && codes.length >= PLAN_MAX) return flashRedirect(res, planUrl(codes), 'error', `A plan can hold ${PLAN_MAX} courses. Remove one first.`);
        if (!codes.includes(exact.code)) codes.push(exact.code);
        savePlan(res, codes);
        return res.redirect(303, planUrl(codes));
      }
      matches = q(`SELECT code, title FROM courses WHERE code LIKE ? OR title LIKE ? ORDER BY code LIMIT 12`).all(`%${add}%`, `%${add}%`);
    }
    if (!fromUrl && codes.length && !matches) return res.redirect(303, planUrl(codes));
    const rows = codes.length ? q(`SELECT c.code, c.title, c.credits, s.n, s.difficulty, s.workload, s.has_sample, v.votes, v.lekker FROM courses c
      LEFT JOIN (SELECT course, COUNT(*) AS n, AVG(difficulty) AS difficulty, AVG(workload) AS workload, MAX(is_sample) AS has_sample FROM reviews WHERE status = 'published' GROUP BY course) s ON s.course = c.code
      LEFT JOIN (SELECT course, COUNT(*) AS votes, SUM(lekker) AS lekker FROM verdicts WHERE status = 'published' GROUP BY course) v ON v.course = c.code
      WHERE c.code IN (${codes.map(() => '?').join(',')})`).all(...codes) : [];
    const courses = codes.map((code) => rows.find((r) => r.code === code)).filter(Boolean);
    res.page(views.plan(req.ctx, { courses, load: semesterLoad(courses), matches, add, codes: courses.map((c) => c.code) }));
  });

  app.get('/privacy', (req, res) => res.page(views.privacy(req.ctx)));
  app.get('/terms', (req, res) => res.page(views.terms(req.ctx)));

  // ---- your account (POPIA: see and delete what we hold about you) ----
  app.get('/account', requireUser, (req, res) => {
    const reviews = q(`SELECT ${REVIEW_COLS} FROM reviews r LEFT JOIN lecturers l ON l.id = r.lecturer_id WHERE r.user_id = ? ORDER BY r.created_at DESC`).all(req.user.id);
    const verdicts = q(`SELECT * FROM verdicts WHERE user_id = ? ORDER BY created_at DESC`).all(req.user.id);
    res.page(views.account(req.ctx, { reviews, verdicts }));
  });

  app.post('/account/delete', requireUser, (req, res) => {
    const id = req.user.id;
    db.exec('BEGIN');
    try {
      q(`DELETE FROM reports WHERE review_id IN (SELECT id FROM reviews WHERE user_id = ?)`).run(id);
      q(`UPDATE takedowns SET review_id = NULL WHERE review_id IN (SELECT id FROM reviews WHERE user_id = ?)`).run(id);
      q(`DELETE FROM reviews WHERE user_id = ?`).run(id);
      q(`DELETE FROM verdicts WHERE user_id = ?`).run(id);
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
    const old = q(`SELECT status FROM verdicts WHERE course = ? AND user_id = ?`).get(c.code, req.user.id);
    if (old?.status === 'removed') return flashRedirect(res, back, 'error', "A moderator removed your vote on this course, so you can't vote on it again.");
    const screen = screenComment(verdict.tip);
    if (screen.action === 'reject') return flashRedirect(res, back, 'error', `Your tip can't be posted as written: ${screen.reasons.join(', ').toLowerCase()}. Please remove it and try again.`);
    const status = screen.action === 'hold' ? 'held' : 'published';
    q(`INSERT INTO verdicts (course, user_id, year, lekker, tip, status, flags) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, course) DO UPDATE SET year = excluded.year, lekker = excluded.lekker, tip = excluded.tip, status = excluded.status, flags = excluded.flags`)
      .run(c.code, req.user.id, verdict.year, verdict.lekker, verdict.tip, status, screen.reasons.join('|'));
    flashRedirect(res, back, status === 'held' ? 'info' : 'ok',
      status === 'held' ? 'Thanks! Your vote counts once a moderator has checked your tip.' : `Thanks! You voted ${verdict.lekker ? 'lekker 🤙' : 'nah 👎'}.`);
  });

  app.post('/verdicts/:id/delete', requireUser, (req, res) => {
    const v = q(`SELECT * FROM verdicts WHERE id = ? AND user_id = ?`).get(Number(req.params.id) || 0, req.user.id);
    if (!v) return res.status(404).page(notFound(req));
    q(`DELETE FROM verdicts WHERE id = ?`).run(v.id);
    flashRedirect(res, req.body.back === 'account' ? '/account' : `/courses/${v.course}`, 'ok', 'Your vote was deleted.');
  });

  // Tips are one line about the course, so any report hides one until a moderator looks.
  app.post('/verdicts/:id/report', limits.report, (req, res) => {
    const v = q(`SELECT * FROM verdicts WHERE id = ? AND status = 'published' AND tip != ''`).get(Number(req.params.id) || 0);
    if (!v) return flashRedirect(res, '/', 'error', 'That tip was already hidden or removed.');
    q(`UPDATE verdicts SET status = 'held', flags = 'Reported by a reader' WHERE id = ?`).run(v.id);
    flashRedirect(res, `/courses/${v.course}#tips`, 'ok', 'Thanks. That tip is hidden until a moderator checks it.');
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

  // Hides a review pending moderation and records why.
  const hold = (id, why) => q(`UPDATE reviews SET status = 'held', flags = CASE WHEN flags = '' THEN ? ELSE flags || '|' || ? END WHERE id = ? AND status = 'published'`).run(why, why, id);

  app.post('/reviews/:id/report', limits.report, (req, res) => {
    const r = q(`SELECT * FROM reviews WHERE id = ? AND status != 'removed'`).get(Number(req.params.id) || 0);
    const reason = REPORT_REASONS.find((x) => x.key === req.body.reason);
    if (!r || !reason) return flashRedirect(res, r ? `/courses/${r.course}` : '/', 'error', 'Please pick a reason for the report.');
    q(`INSERT INTO reports (review_id, reason, details) VALUES (?, ?, ?)`).run(r.id, reason.key, String(req.body.details || '').slice(0, 500));
    const open = q(`SELECT COUNT(*) AS n FROM reports WHERE review_id = ? AND resolved = 0`).get(r.id).n;
    if (reason.hideNow || open >= HIDE_AFTER_REPORTS) hold(r.id, `Reported: ${reason.label}`);
    flashRedirect(res, `/courses/${r.course}`, 'ok', reason.hideNow || open >= HIDE_AFTER_REPORTS
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
    if (review) hold(review.id, 'Removal requested');
    res.page((views.message(req.ctx, {
      title: 'Request received', emoji: '📮',
      text: review ? 'The review is now hidden while a moderator looks at it. We aim to reply within 48 hours.' : 'A moderator will look at your request and reply by email, usually within 48 hours.',
      link: { href: '/', label: 'Back to LekkerOrNah' },
    })));
  });

  // ---- sign in with a one-time email link ----
  app.get('/login', (req, res) => res.page((views.login(req.ctx))));

  app.post('/login', limits.login, limits.loginEmail, async (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!STUDENT_EMAIL.test(email)) return res.status(400).page((views.login(req.ctx, { email, error: 'Use your @myuct.ac.za student email.' })));
    if (q(`SELECT 1 FROM users WHERE email = ? AND banned = 1`).get(email)) return res.status(403).page((views.login(req.ctx, { email, error: 'This account has been suspended for breaking the house rules.' })));
    const token = crypto.randomBytes(32).toString('hex');
    q(`DELETE FROM login_tokens WHERE expires < ?`).run(Date.now());
    q(`INSERT INTO login_tokens (hash, email, expires) VALUES (?, ?, ?)`).run(sha(token), email, Date.now() + TOKEN_TTL);
    // in production the link must use the configured BASE_URL, never the request's Host header
    const link = `${baseUrl || `${req.protocol}://${req.get('host')}`}/auth/${token}`;
    if (sendLoginEmail) {
      try {
        await sendLoginEmail(email, link);
      } catch (e) {
        console.error('login email failed:', e.message);
        q(`DELETE FROM login_tokens WHERE hash = ?`).run(sha(token));
        return res.status(502).page(views.login(req.ctx, { email, error: "We couldn't send the email just now. Please try again in a minute." }));
      }
    }
    res.page((views.checkEmail(req.ctx, { email, devLink: devMode ? link : null })));
  });

  app.get('/auth/:token', (req, res) => {
    const row = q(`SELECT * FROM login_tokens WHERE hash = ? AND expires > ?`).get(sha(String(req.params.token)), Date.now());
    if (!row) return res.status(400).page((views.message(req.ctx, { title: 'Link expired', emoji: '⌛', text: 'That sign-in link is invalid or has expired.', link: { href: '/login', label: 'Get a new link' } })));
    q(`DELETE FROM login_tokens WHERE hash = ?`).run(row.hash);
    q(`INSERT INTO users (email) VALUES (?) ON CONFLICT(email) DO NOTHING`).run(row.email);
    const user = q(`SELECT * FROM users WHERE email = ?`).get(row.email);
    if (user.banned) return res.status(403).page((views.message(req.ctx, { title: 'Account suspended', emoji: '🚫', text: 'This account has been suspended for breaking the house rules.' })));
    const sid = crypto.randomBytes(32).toString('hex');
    q(`INSERT INTO sessions (hash, user_id, expires) VALUES (?, ?, ?)`).run(sha(sid), user.id, Date.now() + SESSION_TTL);
    res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', secure: !devMode, maxAge: SESSION_TTL });
    flashRedirect(res, '/', 'ok', "You're signed in. Your reviews are shown anonymously.");
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
    q(`INSERT INTO mod_log (action, note, moderator) VALUES (?, ?, ?)`).run(`${action} tip`, `tip #${v.id} on ${v.course}: ${v.tip}`.slice(0, 200), req.user.email);
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
    q(`INSERT INTO mod_log (review_id, action, note, moderator) VALUES (?, 'close request', ?, ?)`).run(t.review_id, `request #${t.id} from ${t.name}`, req.user.email);
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
