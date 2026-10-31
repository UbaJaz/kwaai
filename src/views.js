const { html } = require('./html');
const { QUALITY, SCALES, TAGS, MAX_TAGS, MAX_BODY, MAX_TIP, MIN_FOR_RANKING, FREE_COMMENTS, RANKINGS } = require('./ratings');
const { REPORT_REASONS, HIDE_AFTER_REPORTS } = require('./moderation');
const { ordinal, entryStatus } = require('./planner');

const fmt = (n) => (n == null ? '–' : Number(n).toFixed(1));
const month = (iso) => new Date(iso.replace(' ', 'T') + 'Z').toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------- layout ----------

const DEFAULT_DESCRIPTION = 'Course ratings, workload scores and tips from South African university students, starting at UCT. Unofficial and not affiliated with any university.';

// Sign-in links remember the page you were on, so you land back there afterwards.
const loginHref = (back) => (back && back !== '/' && !back.startsWith('/login') && !back.startsWith('/auth') ? `/login?next=${encodeURIComponent(back)}` : '/login');

const NAV = [['/courses', 'Courses'], ['/plan', 'Planner'], ['/rankings', 'Rankings']];

// description and path feed the link preview WhatsApp and other apps show when someone pastes a link.
// uni sets the accent colour for the university being browsed; the Kwaai brand colours never change.
function layout({ title, user, isMod, flash, site = {}, uni, here = '', description = DEFAULT_DESCRIPTION, path }, body) {
  const fullTitle = title ? `${title} · Kwaai` : 'Kwaai: find out if a course is kwaai before you register';
  const on = (href) => (here === href || here.startsWith(`${href}/`) ? 'page' : null);
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${fullTitle}</title>
<meta name="description" content="${description}">
<meta property="og:site_name" content="Kwaai">
<meta property="og:type" content="website">
<meta property="og:locale" content="en_ZA">
<meta property="og:title" content="${fullTitle}">
<meta property="og:description" content="${description}">
${path && site.origin ? html`<meta property="og:url" content="${site.origin}${path}"><link rel="canonical" href="${site.origin}${path}">` : ''}
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#151d2b">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&family=Inter:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/style.css">
<link rel="icon" href="/kwaai-icon.svg" type="image/svg+xml">
<script src="/app.js" defer></script>
</head>
<body${uni ? html` style="--uni:${uni.accent};--uni-soft:${uni.soft}"` : ''}>
<a class="skip" href="#main">Skip to content</a>
<div class="notice">Unofficial student project, not affiliated with any university. Reviews marked <span class="badge sample">Sample</span> are demo data.</div>
<header class="site-header">
  <div class="wrap header-row">
    <a class="logo" href="/"><img src="/kwaai-icon.svg" alt="" width="30" height="30"><span>kwaai</span></a>
    <nav class="nav" aria-label="Main">
      ${NAV.map(([href, label]) => html`<a href="${href}" ${on(href) ? html`aria-current="page"` : ''}>${label}</a>`)}
      ${user ? html`<a href="/account" ${on('/account') ? html`aria-current="page"` : ''}>My reviews</a>` : ''}
      ${isMod ? html`<a href="/mod" class="nav-mod">Moderation</a>` : ''}
    </nav>
    <div class="header-end">
      ${uni ? html`<a class="uni-chip" href="/universities" aria-label="${uni.name}. Change university"><i aria-hidden="true"></i>${uni.short}</a>` : ''}
      ${user
        ? html`<form method="post" action="/logout" class="inline"><button class="link-btn" title="${user.email}">Sign out</button></form>`
        : html`<a class="btn btn-small btn-outline" href="${loginHref(here)}">Sign in</a>`}
    </div>
  </div>
</header>
<div class="uni-band"></div>
<main class="wrap" id="main">
${flash ? html`<div class="flash flash-${flash.type}" role="status">${flash.text}</div>` : ''}
${body}
</main>
<footer class="site-footer">
  <div class="wrap footer-row">
    <p class="footer-brand"><img src="/kwaai-icon.svg" alt="" width="22" height="22"> kwaai</p>
    <p>Kwaai is an independent, student-run site. It isn't affiliated with, endorsed by or run by any university. Reviews are students' personal opinions.</p>
    <p><a href="/universities">Universities</a> · <a href="/rules">House rules</a> · <a href="/takedown">Report or request removal</a> · <a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>
  </div>
</footer>
</body>
</html>`;
}

// ---------- small components ----------

// A score is always a number with five small bars filled to the nearest half point.
const segs = (n) => {
  const v = Math.round(n * 2) / 2;
  return html`<span class="seg" aria-hidden="true">${[1, 2, 3, 4, 5].map((i) => html`<i class="${v >= i ? 'f' : v >= i - 0.5 ? 'h' : ''}"></i>`)}</span>`;
};
const chip = (n, big) => html`<span class="score ${big ? 'score-big' : ''}" role="img" aria-label="${n == null ? 'No rating yet' : `${fmt(n)} out of 5`}"><b>${fmt(n)}</b>${n == null ? '' : segs(n)}</span>`;
const sampleBadge = (on) => (on ? html`<span class="badge sample" title="Demo data, not a real student's review">Sample</span>` : '');

function bars(stats) {
  return html`<div class="bars">
    ${QUALITY.map((c) => html`<div class="bar-row"><span class="bar-label">${c.label}</span><span class="bar"><span style="width:${(stats[c.key] || 0) * 20}%"></span></span><span class="bar-num">${fmt(stats[c.key])}</span></div>`)}
    ${SCALES.map((c) => html`<div class="bar-row scale"><span class="bar-label">${c.label}</span><span class="bar"><span style="width:${(stats[c.key] || 0) * 20}%"></span></span><span class="bar-num">${stats[c.key] == null ? '–' : `${fmt(stats[c.key])}/5`}</span></div>`)}
  </div>`;
}

function courseCard(c) {
  return html`<a class="card course-card" href="/courses/${c.code}">
    <div class="course-card-top"><span class="code">${c.code}</span><span>${sampleBadge(c.has_sample)} ${chip(c.overall)}</span></div>
    <div class="course-title">${c.title}</div>
    <div class="meta">${c.dept_name}${c.credits ? ` · ${c.credits} credits` : ''} · ${c.n ? plural(c.n, 'review') : 'No reviews yet'}</div>
  </a>`;
}

function reviewCard(r, { user, uni, lecturerLink = true, courseLink = false, hideBody = false } = {}) {
  const tags = r.tags ? r.tags.split('|') : [];
  const mine = user && r.user_id === user.id;
  return html`<article class="card review" id="review-${r.id}">
    <div class="review-head">
      ${chip(r.overall, true)}
      <div>
        <div class="review-who">
          ${courseLink ? html`<a href="/courses/${r.course}">${r.course}</a> · ` : ''}
          ${r.lecturer_id
            ? lecturerLink ? html`<a href="/lecturers/${r.lecturer_id}">${r.lecturer_name}</a>` : r.lecturer_name
            : html`<span class="muted">Lecturer not listed</span>`}
          · ${r.year}
        </div>
      </div>
      ${sampleBadge(r.is_sample)}
    </div>
    <dl class="mini">
      ${QUALITY.map((c) => html`<div><dt>${c.label}</dt><dd>${r[c.key]}</dd></div>`)}
      ${SCALES.map((c) => html`<div class="scale"><dt>${c.label}</dt><dd>${r[c.key]}/5</dd></div>`)}
    </dl>
    ${tags.length ? html`<div class="tags">${tags.map((t) => html`<span class="tag">${t}</span>`)}</div>` : ''}
    ${r.body ? hideBody ? html`<p class="review-body locked">🔒 Comment hidden. <a href="#gate">How to read it</a></p>` : html`<p class="review-body">${r.body}</p>` : ''}
    <div class="review-foot">
      <span class="muted">Anonymous ${uni?.short ?? 'UCT'} student · ${month(r.created_at)}</span>
      <span class="review-actions">
        ${mine ? html`<form method="post" action="/reviews/${r.id}/delete" class="inline" data-confirm="Delete your review? This can't be undone."><button class="link-btn">Delete mine</button></form>` : ''}
        <details class="report">
          <summary>⚑ Report</summary>
          <form method="post" action="/reviews/${r.id}/report" class="report-form">
            <p class="report-title">What's wrong with this review?</p>
            ${REPORT_REASONS.map((x, i) => html`<label class="radio"><input type="radio" name="reason" value="${x.key}" ${i === 0 ? 'required' : ''}> ${x.label}</label>`)}
            <textarea name="details" maxlength="500" rows="2" placeholder="Anything we should know? (optional)"></textarea>
            <button class="btn btn-small">Send report</button>
            <p class="fine">Serious reports hide the review straight away until a moderator checks it. Are you the person this is about? <a href="/takedown?review=${r.id}">Request removal</a>.</p>
          </form>
        </details>
      </span>
    </div>
  </article>`;
}

// Percent of students who voted kwaai, once there are enough votes to mean something.
const kwaaiPct = (votes) => (votes.n >= MIN_FOR_RANKING ? Math.round((votes.lekker / votes.n) * 100) : null);

// One line with the numbers, used for the link preview.
function courseSummary(c, stats, votes) {
  const pct = kwaaiPct(votes);
  const parts = [];
  if (pct != null) parts.push(`${pct}% of ${votes.n} students say kwaai`);
  if (stats.n) parts.push(`Exam difficulty ${fmt(stats.difficulty)}/5`, `Workload ${fmt(stats.workload)}/5`, plural(stats.n, 'review'));
  if (!parts.length) parts.push("No votes yet. Took it? Say if it's kwaai or nah");
  return `${c.code} ${c.title}. ${parts.join(' · ')}.`;
}

function whatsappLink(c, votes, origin) {
  const pct = kwaaiPct(votes);
  const text = pct != null
    ? `Is ${c.code} kwaai or nah? ${pct}% of students say kwaai. ${origin}/courses/${c.code}`
    : `Is ${c.code} kwaai or nah? Took it? Vote here: ${origin}/courses/${c.code}`;
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

function verdictBox(ctx, { c, votes, myVerdict, years }) {
  const pct = kwaaiPct(votes);
  const mine = myVerdict && myVerdict.status !== 'removed' ? myVerdict : null;
  return html`<section class="card verdict-box" id="verdict">
    <div class="verdict-head">
      <h2>Took ${c.code}? Kwaai or nah?</h2>
      ${pct != null
        ? html`<p class="verdict-result"><strong>${pct}%</strong> say kwaai <span class="meta">from ${plural(votes.n, 'vote')}</span></p>`
        : html`<p class="meta">${votes.n ? `${plural(votes.n, 'vote')} so far. The result shows from ${MIN_FOR_RANKING} votes.` : 'No votes yet.'}</p>`}
    </div>
    ${ctx.user
      ? html`${mine ? html`<p class="meta">You voted <strong>${mine.lekker ? 'kwaai' : 'nah'}</strong> (${mine.year}).${mine.status === 'held' ? ' It counts once a moderator has checked your tip.' : ''} Vote again to change it.</p>` : ''}
        <form method="post" action="/courses/${c.code}/verdict" class="verdict-form">
          <div class="form-row two">
            <label>Tip for next year's class <span class="hint">Optional, max ${MAX_TIP} characters</span>
              <input name="tip" maxlength="${MAX_TIP}" value="${mine?.tip ?? ''}" placeholder="e.g. Start the assignments the day they come out">
            </label>
            <label>Year you took it
              <select name="year">${years.map((y) => html`<option ${String(mine?.year ?? years[0]) === String(y) ? 'selected' : ''}>${y}</option>`)}</select>
            </label>
          </div>
          <div class="verdict-buttons">
            <button class="btn btn-big btn-kwaai" name="lekker" value="1">Kwaai</button>
            <button class="btn btn-big btn-nah" name="lekker" value="0">Nah</button>
          </div>
          <p class="fine">Votes are anonymous. Tips follow the <a href="/rules">house rules</a>, and any that might break them wait for a moderator. Want to say more? <a href="/courses/${c.code}/review">Write a full review</a>.</p>
        </form>
        ${mine ? html`<form method="post" action="/verdicts/${mine.id}/delete" class="inline" data-confirm="Delete your vote on ${c.code}?"><button class="link-btn fine">Delete my vote</button></form>` : ''}`
      : html`<div class="verdict-buttons">
          <a class="btn btn-big btn-kwaai" href="${loginHref(`/courses/${c.code}#verdict`)}">Kwaai</a>
          <a class="btn btn-big btn-nah" href="${loginHref(`/courses/${c.code}#verdict`)}">Nah</a>
        </div>
        <p class="fine">Sign in with your @myuct.ac.za email to vote. Votes are anonymous.</p>`}
  </section>`;
}

function tipList(tips, locked) {
  return html`<ul class="tips">${tips.map((t, i) => locked && i >= FREE_COMMENTS
    ? html`<li class="card tip"><span class="tip-verdict ${t.lekker ? 'yes' : 'no'}">${t.lekker ? 'Kwaai' : 'Nah'}</span><p class="tip-text locked">🔒 Tip hidden. <a href="#gate">How to read it</a></p></li>`
    : html`<li class="card tip" id="tip-${t.id}">
    <span class="tip-verdict ${t.lekker ? 'yes' : 'no'}">${t.lekker ? 'Kwaai' : 'Nah'}</span>
    <div>
      <p class="tip-text">${t.tip}</p>
      <div class="review-foot tip-foot">
        <span class="muted">Took it in ${t.year}</span>
        <form method="post" action="/verdicts/${t.id}/report" class="inline" data-confirm="Report this tip? It will be hidden until a moderator checks it."><button class="link-btn">⚑ Report</button></form>
      </div>
    </div>
  </li>`)}</ul>`;
}

// Marks which review comments a reader who hasn't contributed can't see: everything after the first few.
function hideAfterFree(reviews, locked) {
  let shown = 0;
  return reviews.map((r) => {
    if (!r.body || !locked) return { r, hideBody: false };
    shown += 1;
    return { r, hideBody: shown > FREE_COMMENTS };
  });
}

function gateNotice(ctx, hidden) {
  if (!hidden) return '';
  return html`<div class="card gate" id="gate">
    <p><strong>${plural(hidden, 'more comment')} on this page.</strong> Vote kwaai or nah on any course you've taken and you can read every comment on the site. It takes about ten seconds.</p>
    ${ctx.user ? html`<a class="btn" href="/courses">Find a course you've taken</a>` : html`<a class="btn" href="${loginHref(ctx.here)}">Sign in with your student email</a>`}
  </div>`;
}

function rankList(rows, kind) {
  if (!rows.length) return html`<p class="empty">Not enough reviews yet. Things need at least ${MIN_FOR_RANKING} reviews to be ranked.</p>`;
  return html`<ol class="rank-list">
    ${rows.map((r, i) => html`<li>
      <span class="rank-pos">${i + 1}</span>
      <a href="${kind === 'course' ? `/courses/${r.code}` : `/lecturers/${r.id}`}" class="rank-name">
        ${kind === 'course' ? html`<span class="code">${r.code}</span> ${r.title}` : r.name}
        ${sampleBadge(r.is_sample)}
        <span class="meta">${r.dept_name} · ${plural(r.n, 'review')}</span>
      </a>
      <span class="rank-score">${chip(r.score)}</span>
    </li>`)}
  </ol>`;
}

// ---------- pages ----------

// The two things to do on Kwaai. Rating comes first from the end of exams until registration opens in January
// (that's when 2026 courses are fresh in students' minds); planning comes first the rest of the year.
function homePaths(ctx, ratingSeason) {
  const rate = {
    href: ctx.user ? '/courses' : '/login?next=%2Fcourses',
    when: 'Took a course this year?',
    title: 'Rate it kwaai or nah',
    text: "One tap and an optional tip for next year's class. It takes ten seconds, and you can then read every comment and tip on the site.",
    action: ctx.user ? 'Find a course you took' : 'Sign in with your student email',
  };
  const planner = {
    href: '/plan',
    when: 'Choosing courses for next year?',
    title: 'Plan your semesters',
    text: 'Add the courses you are considering. Kwaai flags lecture clashes, checks entry requirements and shows how much of your mark rides on exams.',
    action: 'Open the planner',
  };
  return ratingSeason ? [rate, planner] : [planner, rate];
}

function home(ctx, { counts, topCourses, heaviest, ratingSeason = false }) {
  const { uni } = ctx;
  const n = (v) => v.toLocaleString('en-ZA');
  return layout({ ...ctx, path: '/' }, html`
  <section class="hero">
    <div class="hero-main">
      <p class="eyebrow"><b>${uni.name}</b> · ${plural(counts.courses, 'course')}</p>
      <h1>Find out if a course is <em class="hl">kwaai</em> before you register.</h1>
      <p class="lede">Ratings, workload scores and one-line tips from students who already took it, plus a planner that checks your semester against the handbook.</p>
      <form class="search" action="/courses" role="search">
        <input type="search" name="q" placeholder="Code or name, e.g. CSC1015F" aria-label="Search courses" autocomplete="off" data-suggest="go">
        <button class="btn btn-ink">Search</button>
      </form>
    </div>
    <aside class="pulse" aria-labelledby="pulse-title">
      <h2 class="label" id="pulse-title">So far at ${uni.short}</h2>
      <dl>
        <div><dt>Courses listed</dt><dd>${n(counts.courses)}</dd></div>
        ${counts.reviews ? html`<div><dt>Full reviews</dt><dd>${n(counts.reviews)}</dd></div>` : ''}
        ${counts.votes ? html`<div><dt>Kwaai-or-nah votes</dt><dd>${n(counts.votes)}</dd></div>` : ''}
        ${counts.tips ? html`<div><dt>Tips shared</dt><dd>${n(counts.tips)}</dd></div>` : ''}
      </dl>
    </aside>
  </section>

  <section class="paths" aria-label="What you can do">
    ${homePaths(ctx, ratingSeason).map((p) => html`<a class="card path" href="${p.href}">
      <span class="label">${p.when}</span>
      <h2>${p.title}</h2>
      <p>${p.text}</p>
      <span class="path-go">${p.action} →</span>
    </a>`)}
  </section>

  <section class="lists">
    <div>
      <h2 class="label">Highest rated</h2>
      ${rankList(topCourses, 'course')}
      <a class="more" href="/rankings?cat=best&kind=course">All rankings →</a>
    </div>
    <div>
      <h2 class="label">Heaviest workload</h2>
      ${rankList(heaviest, 'course')}
      <a class="more" href="/rankings?cat=workload&kind=course">All rankings →</a>
    </div>
  </section>

  <p class="browse-all"><a class="btn btn-quiet" href="/courses">Browse all ${n(counts.courses)} courses by department</a></p>

  <section class="how">
    <div><h3>Rate what matters</h3><p>Four scores make up a rating: teaching, how engaging the lectures are, exam fairness and how approachable the lecturer is. Difficulty and workload are scored separately, because a hard course isn't a bad course.</p></div>
    <div><h3>Real students, no names</h3><p>You sign in with your student email, so every review comes from a real student. Your name and email never appear next to anything you post.</p></div>
    <div><h3>About the course, not the person</h3><p>No personal attacks and no allegations. Anyone can report a review, and serious reports hide it straight away. <a href="/rules">Read the house rules</a>.</p></div>
  </section>`);
}

function courses(ctx, { list, total, depts, q, dept }) {
  return layout({ ...ctx, title: 'Courses' }, html`
  <h1 class="page-title">Courses</h1>
  <form class="search search-inline course-filter" action="/courses" role="search">
    <input type="search" name="q" value="${q}" placeholder="Search code or name" aria-label="Search courses" autocomplete="off" data-suggest="go">
    <select name="dept" aria-label="Department" data-autosubmit>
      <option value="">All departments</option>
      ${depts.map((d) => html`<option value="${d.code}" ${dept === d.code ? 'selected' : ''}>${d.name} (${d.code})</option>`)}
    </select>
    <button class="btn">Search</button>
  </form>
  <p class="meta">${total > list.length ? `Showing ${list.length} of ${total} courses. Search or pick a department to see the rest.` : plural(total, 'course')}${dept ? ` in ${depts.find((d) => d.code === dept)?.name || dept}` : ''}${q ? ` matching “${q}”` : ''}</p>
  ${list.length ? html`<div class="course-grid">${list.map(courseCard)}</div>` : html`<p class="empty">No courses found. Try the course code from your handbook, like CSC1015F, or part of the name.</p>`}`);
}

const personLink = (l) => (l.id ? html`<a href="/lecturers/${l.id}">${l.name}</a>` : l.name);

function course(ctx, { c, stats, offerings, reviews, topTags, myHeld, votes, tips, myVerdict, years, locked, conveners = [], staff = [] }) {
  const cards = hideAfterFree(reviews, locked);
  const hidden = cards.filter((x) => x.hideBody).length + (locked ? Math.max(0, tips.length - FREE_COMMENTS) : 0);
  return layout({ ...ctx, title: `${c.code} ${c.title}`, description: courseSummary(c, stats, votes), path: `/courses/${c.code}` }, html`
  <nav class="crumbs"><a href="/courses">Courses</a> / <a href="/courses?dept=${c.dept}">${c.dept_name}</a> / ${c.code}</nav>
  <section class="course-hero">
    <div>
      <span class="code code-big">${c.code}</span>
      <h1>${c.title}</h1>
      <p class="meta">${c.dept_name}${c.credits ? ` · ${c.credits} NQF credits` : ''}${c.nqf ? ` · NQF level ${c.nqf}` : ''}</p>
      ${conveners.length ? html`<p class="meta">${conveners.length > 1 ? 'Conveners' : 'Convener'}: ${conveners.map((l, i) => html`${i ? ', ' : ''}${personLink(l)}`)} <span class="src">(source: ${c.source})</span></p>` : ''}
      ${staff.length ? html`<details class="dept-staff">
        <summary>Teaching staff in ${c.dept_name} (${staff.length})</summary>
        <p class="meta">From the 2026 handbook's staff list. The handbook names only the convener for each course, so these are people in the department, not necessarily lecturers on ${c.code}.</p>
        <ul class="plain">${staff.map((l) => html`<li>${personLink(l)} <span class="meta">${l.role}</span></li>`)}</ul>
      </details>` : ''}
    </div>
    <div class="hero-actions">
      <a class="btn btn-quiet" href="/plan?add=${c.code}">Add to my semester plan</a>
      <a class="btn btn-quiet" href="${whatsappLink(c, votes, ctx.site.origin)}" target="_blank" rel="noopener">Share on WhatsApp</a>
      <a class="btn btn-quiet" href="/courses/${c.code}/review">Write a full review</a>
    </div>
  </section>

  ${verdictBox(ctx, { c, votes, myVerdict, years })}

  ${myHeld ? html`<div class="flash flash-info">Your review for this course is waiting for a moderator. We check comments that might break the rules before they go live.</div>` : ''}

  <section class="course-layout">
    <aside class="card score-panel">
      ${stats.n
        ? html`<div class="overall">${chip(stats.overall, true)}<div class="meta">${plural(stats.n, 'review')} ${sampleBadge(stats.has_sample)}</div></div>
          ${bars(stats)}
          ${topTags.length ? html`<div class="tags">${topTags.map(([t, n]) => html`<span class="tag">${t} <b>${n}</b></span>`)}</div>` : ''}`
        : html`<div class="empty-score"><p class="big-emoji">🫥</p><p>No full reviews yet.</p><a class="btn" href="/courses/${c.code}/review">Write the first one</a></div>`}
      ${offerings.length ? html`<h3>Who taught it</h3>
        <table class="offerings"><thead><tr><th>Lecturer</th><th>Year</th><th>Rating</th></tr></thead><tbody>
        ${offerings.map((o) => html`<tr><td>${o.lecturer_id ? html`<a href="/lecturers/${o.lecturer_id}">${o.lecturer_name}</a>` : html`<span class="muted">Not listed</span>`}</td><td>${o.year}</td><td>${chip(o.overall)} <span class="meta">(${o.n})</span></td></tr>`)}
        </tbody></table>` : ''}
      ${handbookFacts(c)}
    </aside>
    <div class="reviews">
      ${gateNotice(ctx, hidden)}
      ${tips.length ? html`<h2 class="section-title" id="tips">Tips from students who took it</h2>${tipList(tips, locked)}` : ''}
      <h2 class="section-title">Reviews</h2>
      ${reviews.length ? cards.map(({ r, hideBody }) => reviewCard(r, { ...ctx, hideBody })) : html`<p class="empty">Nothing here yet. Took ${c.code}? Tell the next class what it's really like.</p>`}
    </div>
  </section>`);
}

function handbookFacts(c) {
  const status = html`${c.not_offered ? html`<p class="plan-note">The handbook says ${c.code} is not offered in ${c.not_offered}.</p>` : ''}
    ${c.table_only ? html`<p class="meta">The 2026 handbooks list ${c.code} in degree tables but don't describe it. Check with the department.</p>` : ''}`;
  if (!c.outline && !c.entry && !c.dp && !c.assessment && !c.lectures) return c.not_offered || c.table_only ? html`<h3>From the 2026 handbook</h3>${status}` : '';
  return html`<h3>From the 2026 handbook</h3>
    ${status}
    <dl class="handbook">
      ${c.outline ? html`<dt>What it covers</dt><dd>${c.outline}</dd>` : ''}
      ${c.entry ? html`<dt>Entry requirements</dt><dd>${c.entry}</dd>` : ''}
      ${c.lectures ? html`<dt>Lecture times</dt><dd>${c.lectures}</dd>` : ''}
      ${c.dp ? html`<dt>DP (to be allowed to write the exam)</dt><dd>${c.dp}</dd>` : ''}
      ${c.assessment ? html`<dt>Assessment</dt><dd>${c.exam_weight != null ? html`<strong>About ${c.exam_weight}% final exam.</strong> ` : ''}${c.assessment}</dd>` : ''}
    </dl>`;
}

function reviewForm(ctx,{ c, conveners, others, years, values = {}, error }) {
  const v = (k, d) => values[k] ?? d;
  const pickedTags = [values.tags ?? []].flat();
  return layout({ ...ctx, title: `Rate ${c.code}` }, html`
  <nav class="crumbs"><a href="/courses/${c.code}">${c.code}</a> / Rate</nav>
  <h1 class="page-title">Rate ${c.code}: ${c.title}</h1>
  <p class="lede small">You're rating the course <em>as taught by</em> one lecturer in one year. Took it more than once? Leave one review per lecturer per year.</p>
  ${error ? html`<div class="flash flash-error" role="alert">${error}</div>` : ''}
  <form method="post" class="card form review-form" action="/courses/${c.code}/review">
    <div class="form-row two">
      <label>Lecturer
        <select name="lecturer_id" required>
          <option value="">Choose…</option>
          ${conveners.length ? html`<optgroup label="Course convener (handbook)">${conveners.map((l) => html`<option value="${l.id}" ${String(v('lecturer_id')) === String(l.id) ? 'selected' : ''}>${l.name}</option>`)}</optgroup>` : ''}
          ${others.length ? html`<optgroup label="Others in ${c.dept_name}">${others.map((l) => html`<option value="${l.id}" ${String(v('lecturer_id')) === String(l.id) ? 'selected' : ''}>${l.name}${l.is_sample ? ' (sample)' : ''}</option>`)}</optgroup>` : ''}
          <option value="none" ${v('lecturer_id') === 'none' ? 'selected' : ''}>Not listed / not sure</option>
        </select>
        <span class="hint">Lecturers often change between blocks. Pick the one you mostly had. Not in the list? <a href="/courses/${c.code}/suggest-lecturer">Suggest a lecturer</a>.</span>
      </label>
      <label>Year you took it
        <select name="year" required>${years.map((y) => html`<option ${String(v('year', years[0])) === String(y) ? 'selected' : ''}>${y}</option>`)}</select>
      </label>
    </div>

    <fieldset>
      <legend>The star rating <span class="hint">These four make up the overall score</span></legend>
      ${QUALITY.map((c2) => slider(c2.key, c2.label, c2.hint, 'Poor', 'Excellent', v(c2.key, 3)))}
    </fieldset>
    <fieldset>
      <legend>What to expect <span class="hint">Not counted in the stars</span></legend>
      ${SCALES.map((s) => slider(s.key, s.label, '', s.low, s.high, v(s.key, 3)))}
    </fieldset>

    <fieldset>
      <legend>Tags <span class="hint">Pick up to ${MAX_TAGS}</span></legend>
      <div class="tag-picker" data-max="${MAX_TAGS}">
        ${TAGS.map((t) => html`<label class="tag-option"><input type="checkbox" name="tags" value="${t}" ${pickedTags.includes(t) ? 'checked' : ''}><span>${t}</span></label>`)}
      </div>
    </fieldset>

    <label>Short comment <span class="hint">Optional · max ${MAX_BODY} characters</span>
      <textarea name="body" maxlength="${MAX_BODY}" rows="3" data-counter placeholder="What should next year's class know? e.g. 'Do every past paper. Tuts are where it clicks.'">${v('body', '')}</textarea>
      <span class="counter" aria-live="polite"></span>
    </label>
    <div class="rules-box">
      <strong>Before you post:</strong> keep it about the teaching, the course and the exams. No insults, nothing about looks or personal life, no allegations (report those to UCT's proper channels instead), and no names of students. Comments that might break these rules wait for a moderator. <a href="/rules" target="_blank">Full rules</a>
    </div>
    <label class="check"><input type="checkbox" name="agree" value="1" required> My review is my honest opinion, follows the <a href="/rules" target="_blank">house rules</a> and <a href="/terms" target="_blank">terms</a>, and is about my own experience of this course.</label>
    <button class="btn btn-big">Post review</button>
  </form>`);
}

function slider(key, label, hint, low, high, value) {
  return html`<div class="slider">
    <div class="slider-top"><label for="f-${key}">${label}</label><output for="f-${key}" class="slider-val">${value}</output></div>
    ${hint ? html`<span class="hint">${hint}</span>` : ''}
    <input id="f-${key}" type="range" name="${key}" min="1" max="5" step="1" value="${value}">
    <div class="slider-ends"><span>${low}</span><span>${high}</span></div>
  </div>`;
}

function lecturer(ctx, { l, stats, courses: taught, reviews, locked }) {
  const cards = hideAfterFree(reviews, locked);
  return layout({ ...ctx, title: l.name }, html`
  <nav class="crumbs"><a href="/rankings?kind=lecturer">Lecturers</a> / ${l.name}</nav>
  <section class="course-hero">
    <div>
      <span class="code code-big">${l.dept}</span>
      <h1>${l.name} ${sampleBadge(l.is_sample)}</h1>
      <p class="meta">${l.role ? `${l.role}, ` : ''}${l.dept_name}</p>
      ${l.is_sample ? html`<p class="meta">This is a made-up lecturer used to demo the site. Not a real person.</p>` : ''}
    </div>
  </section>
  <section class="course-layout">
    <aside class="card score-panel">
      ${stats.n
        ? html`<div class="overall">${chip(stats.overall, true)}<div class="meta">${plural(stats.n, 'review')}</div></div>${bars(stats)}`
        : html`<div class="empty-score"><p class="big-emoji">🫥</p><p>No reviews yet.</p></div>`}
      ${taught.length ? html`<h3>Courses</h3><ul class="plain">${taught.map((c) => html`<li><a href="/courses/${c.code}"><span class="code">${c.code}</span> ${c.title}</a> ${c.n ? html`<span class="meta">${chip(c.overall)} (${c.n})</span>` : ''}</li>`)}</ul>` : ''}
    </aside>
    <div class="reviews">
      ${gateNotice(ctx, cards.filter((x) => x.hideBody).length)}
      <h2 class="section-title">Reviews</h2>
      ${reviews.length ? cards.map(({ r, hideBody }) => reviewCard(r, { ...ctx, lecturerLink: false, courseLink: true, hideBody })) : html`<p class="empty">No reviews yet.</p>`}
    </div>
  </section>`);
}

function rankings(ctx, { rows, depts, dept, rank, kind }) {
  const link = (o) => {
    const p = new URLSearchParams({ cat: rank.key, kind, ...(dept ? { dept } : {}), ...o });
    return `/rankings?${p}`;
  };
  return layout({ ...ctx, title: 'Rankings' }, html`
  <h1 class="page-title">Rankings</h1>
  <p class="lede small">Only courses and lecturers with at least ${MIN_FOR_RANKING} reviews are ranked, so one bad day can't sink anyone.</p>
  <div class="toggle">
    <a class="${kind === 'course' ? 'on' : ''}" href="${link({ kind: 'course' })}">Courses</a>
    <a class="${kind === 'lecturer' ? 'on' : ''}" href="${link({ kind: 'lecturer' })}">Lecturers</a>
  </div>
  <div class="chips">${RANKINGS.map((r) => html`<a class="chip ${r.key === rank.key ? 'on' : ''}" href="${link({ cat: r.key })}">${r.label}</a>`)}</div>
  <form class="dept-filter" action="/rankings">
    <input type="hidden" name="cat" value="${rank.key}"><input type="hidden" name="kind" value="${kind}">
    <label>Department
      <select name="dept" data-autosubmit>
        <option value="">All departments</option>
        ${depts.map((d) => html`<option value="${d.code}" ${dept === d.code ? 'selected' : ''}>${d.name}</option>`)}
      </select>
    </label>
    <noscript><button class="btn btn-small">Go</button></noscript>
  </form>
  <div class="card panel">
    <h2>${rank.label} · ${kind === 'course' ? 'Courses' : 'Lecturers'}${dept ? ` · ${depts.find((d) => d.code === dept)?.name || dept}` : ''}</h2>
    ${rankList(rows, kind)}
  </div>`);
}

const PERIOD_TIMES = { 0: '13:00', 1: '08:00', 2: '09:00', 3: '10:00', 4: '11:00', 5: '12:00', 6: '14:00', 7: '15:00', 8: '16:00', 9: '17:00' };
const periodName = (p) => (p === 0 ? 'meridian' : `${ordinal(p)} period`);
const periodList = (ps, joiner = 'or') => ps.map((p) => `${periodName(p)} (${PERIOD_TIMES[p]})`).join(` ${joiner} `);

// The whole semester in one line, for WhatsApp and link previews.
function planSummary(plan) {
  const parts = plan.terms.filter((t) => t.courses.length).map((t) => `${t.label}: ${t.courses.map((c) => c.code).join(', ')}${t.load.load != null ? ` (${t.load.label.toLowerCase()}, ${fmt(t.load.load)}/5)` : ''}`);
  return parts.join('. ');
}

function planWarnings(plan) {
  const items = [];
  for (const t of plan.terms) {
    for (const x of t.timetable.clashes) items.push(html`<li><strong>${t.label} clash:</strong> ${x.a} and ${x.b} both lecture in the ${periodList(x.periods, 'and')}, and neither has another lecture group.</li>`);
    if (t.timetable.squeezed?.length) items.push(html`<li><strong>${t.label}:</strong> ${t.timetable.squeezed.join(', ')} can't all fit. Whichever lecture groups you pick, two of them overlap.</li>`);
  }
  for (const [code, e] of Object.entries(plan.entry)) for (const r of e.tooLate) items.push(html`<li><strong>Order:</strong> ${code} lists ${r} in its entry requirements, but ${r} isn't finished before ${code} starts in your plan.</li>`);
  for (const [a, b] of plan.twice) items.push(html`<li><strong>Same course twice:</strong> ${a} and ${b} are the same course in different semesters. You only need one.</li>`);
  for (const c of plan.notOffered) items.push(html`<li><strong>Not running:</strong> the handbook says ${c.code} is not offered in ${c.not_offered}.</li>`);
  for (const code of plan.alreadyPassed) items.push(html`<li><strong>Already passed:</strong> you said you've passed ${code} (or the same course in another semester).</li>`);
  for (const [code, e] of Object.entries(plan.entry)) if (e.noneMet) items.push(html`<li><strong>Entry:</strong> ${code}'s entry requirements mention ${e.refs.slice(0, 5).join(', ')}${e.refs.length > 5 ? '…' : ''}. None of them is in your passed courses or earlier in your plan.</li>`);
  return items;
}

function planCourse(c, entry, picks, link) {
  const pct = kwaaiPct({ n: c.votes || 0, lekker: c.lekker || 0 });
  const pick = picks.find((p) => p.code === c.code);
  const facts = [
    c.periodList.length ? `Lectures ${c.period_choice ? periodList(c.periodList) : periodList(c.periodList, 'and')}` : 'Lecture time not in the handbook',
    c.exam_weight != null ? `about ${c.exam_weight}% final exam` : null,
    c.credits ? `${c.credits} credits` : null,
  ].filter(Boolean);
  return html`<li class="plan-course">
    <div class="plan-course-head">
      <a href="/courses/${c.code}" class="plan-course-name"><span class="code">${c.code}</span> ${c.title}</a>
      <a class="plan-remove" href="${link({ remove: c.code })}" aria-label="Remove ${c.code} from the plan">Remove</a>
    </div>
    <p class="plan-facts">${facts.join(' · ')}</p>
    <p class="plan-facts">
      ${c.n ? html`Students rate the workload <strong>${fmt(c.workload)}/5</strong> and exams <strong>${fmt(c.difficulty)}/5</strong> ${sampleBadge(c.has_sample)}` : html`<span class="muted">No full reviews yet</span>`}
      ${pct != null ? html` · <strong>${pct}%</strong> say kwaai` : ''}
      ${c.tips ? html` · <a href="/courses/${c.code}#tips">${plural(c.tips, 'tip')} from students</a>` : ''}
    </p>
    ${pick ? html`<p class="plan-note ok">Pick the ${periodList(pick.periods)} lecture group so it doesn't clash with the rest of your semester.</p>` : ''}
    ${entry.inPlan.length ? html`<p class="plan-note ok">Entry requirement in your plan: ${entry.inPlan.join(', ')}.</p>` : ''}
    ${entry.met.length ? html`<p class="plan-note ok">Entry requirement passed: ${entry.met.join(', ')}.</p>` : ''}
    ${c.entry || c.dp || c.assessment ? html`<details class="plan-details">
      <summary>Entry requirements, DP and assessment</summary>
      <dl>
        ${c.entry ? html`<dt>Entry requirements</dt><dd>${c.entry}</dd>` : ''}
        ${c.corequisites ? html`<dt>Take at the same time</dt><dd>${c.corequisites}</dd>` : ''}
        ${c.dp ? html`<dt>DP (to be allowed to write the exam)</dt><dd>${c.dp}</dd>` : ''}
        ${c.assessment ? html`<dt>Assessment</dt><dd>${c.assessment}</dd>` : ''}
        ${c.lectures ? html`<dt>Lecture times</dt><dd>${c.lectures}</dd>` : ''}
      </dl>
    </details>` : ''}
  </li>`;
}

function planTerm(t, plan, link) {
  const tt = t.timetable;
  const clashCount = tt.clashes.length + (tt.squeezed?.length ? 1 : 0);
  return html`<section class="card plan-term" aria-labelledby="term-${t.key}">
    <header class="plan-term-head">
      <div>
        <h2 id="term-${t.key}">${t.label}</h2>
        <p class="meta">${t.when} · ${plural(t.courses.length, 'course')} · ${t.credits} credits</p>
      </div>
      ${t.load.load != null ? html`<p class="plan-label">${t.load.label}</p>` : ''}
    </header>
    <dl class="plan-stats">
      <div><dt>Workload and exam difficulty</dt><dd>${t.load.load != null ? html`${fmt(t.load.load)}<small>/5</small>` : html`<span class="muted">No reviews yet</span>`}</dd>
        <p class="meta">${t.load.load != null ? `${t.load.advice} From student reviews of ${t.load.rated} of these courses.` : 'Shows once students review these courses.'}</p></div>
      <div><dt>Marks from final exams</dt><dd>${t.examShare != null ? html`${t.examShare}<small>%</small>` : html`<span class="muted">Unknown</span>`}</dd>
        <p class="meta">${t.examShare != null ? `Weighted by credits, from the handbook's assessment rules for ${t.examKnown} of these courses.` : "The handbook doesn't give exam weights for these courses."}</p></div>
      <div><dt>Lecture clashes</dt><dd>${tt.timed < 2 ? html`<span class="muted">Can't check</span>` : clashCount ? html`<span class="bad">${clashCount}</span>` : 'None'}</dd>
        <p class="meta">${tt.timed < 2 ? 'Needs lecture periods for at least two courses.' : `Checked ${tt.timed} courses with lecture periods in the handbook.`}${tt.untimed.length ? ` No period listed for ${tt.untimed.join(', ')}: check the timetable.` : ''}</p></div>
    </dl>
    <ul class="plan-courses">${t.courses.map((c) => planCourse(c, plan.entry[c.code], tt.picks, link))}</ul>
  </section>`;
}

const YEARS = ['1st', '2nd', '3rd', '4th', '5th'];
const termName = (code) => ({ F: 'Semester 1', S: 'Semester 2', W: 'whole year', H: 'whole year' })[code.slice(-1)] || 'other term';

// "About you": faculty, majors, year and passed courses. Everything is optional; the answers live in the plan's link.
function profileCard(profile, { programmeOptions, facultyOptions, needs, state, known }) {
  const set = profile.faculty || profile.majors.length || profile.year || profile.done.length;
  const majorName = (key) => programmeOptions.flatMap((f) => f.items).find((i) => i.key === key)?.name;
  // courses from the chosen majors' earlier years, to tick off instead of typing
  const earlier = profile.year ? [...new Set(needs.flatMap((n) => n.years.filter((y) => y.year < profile.year).flatMap((y) => y.groups.flatMap((g) => g.options.flatMap((o) => o.codes)))))].filter((c) => !c.includes('x') && known.has(c)) : [];
  const typed = profile.done.filter((c) => !earlier.includes(c));
  const select = (name, value, label, optional) => html`<label>${label}
    <select name="${name}">
      <option value="">${optional ? 'None' : 'Pick one'}</option>
      ${programmeOptions.map((f) => html`<optgroup label="${f.name}">${f.items.map((i) => html`<option value="${i.key}" ${value === i.key ? 'selected' : ''}>${i.name}</option>`)}</optgroup>`)}
    </select></label>`;
  return html`<details class="card panel plan-about" ${set ? '' : 'open'}>
    <summary>
      <strong>About you</strong>
      <span class="meta">${set
        ? [profile.year ? `${YEARS[profile.year - 1]} year` : null, profile.faculty && facultyOptions.find((f) => f.key === profile.faculty)?.name, ...profile.majors.map(majorName), profile.done.length ? `${plural(profile.done.length, 'course')} passed` : null].filter(Boolean).join(' · ')
        : 'Tell us your faculty, major and year to see credit checks and what your major still needs.'}</span>
    </summary>
    <form action="/plan" class="form plan-about-form">
      <input type="hidden" name="about" value="1">
      <input type="hidden" name="c" value="${state.c || ''}">
      <div class="form-row two">
        <label>Faculty
          <select name="f">
            <option value="">Pick one</option>
            ${facultyOptions.map((f) => html`<option value="${f.key}" ${profile.faculty === f.key ? 'selected' : ''}>${f.name}</option>`)}
          </select></label>
        <label>Year you're planning
          <select name="y">
            <option value="">Pick one</option>
            ${YEARS.map((y, i) => html`<option value="${i + 1}" ${profile.year === i + 1 ? 'selected' : ''}>${y} year</option>`)}
          </select></label>
      </div>
      <div class="form-row two">
        ${select('m1', profile.majors[0], 'Major or programme')}
        ${select('m2', profile.majors[1], 'Second major (optional)', true)}
      </div>
      ${earlier.length ? html`<fieldset class="plan-passed">
        <legend>Which of these have you passed?</legend>
        ${earlier.map((c) => html`<label class="check"><input type="checkbox" name="done" value="${c}" ${profile.done.includes(c) ? 'checked' : ''}> <span class="code">${c}</span> ${known.get(c).title}</label>`)}
      </fieldset>` : ''}
      <label>${earlier.length ? 'Other courses you\'ve passed' : 'Courses you\'ve passed'}
        <input type="text" name="more" value="${typed.join(', ')}" placeholder="e.g. CSC1015F, MAM1031F" autocomplete="off">
        <span class="meta">Course codes, separated by commas. They count towards entry requirements and credits.</span>
      </label>
      <div class="form-actions">
        <button class="btn btn-ink">Save</button>
        ${set ? html`<a class="btn btn-quiet" href="/plan?${new URLSearchParams({ c: state.c || '', about: 'clear' })}">Clear my answers</a>` : ''}
      </div>
      <p class="fine">Saved on this device and in the plan's link. Nothing is linked to your account.</p>
    </form>
  </details>`;
}

// One course the student could add for their major: semester, credits, entry status and an Add link.
function neededCourse(c, { known, passed, codes, link }) {
  const row = known.get(c);
  if (!row) return html`<li><span class="code">${c}</span> <span class="muted">not in the 2026 handbooks</span></li>`;
  const e = entryStatus(row.entry, passed);
  const inPlan = codes.includes(c);
  return html`<li class="need-course">
    <a href="/courses/${c}"><span class="code">${c}</span> ${row.title}</a>
    <span class="meta">${termName(c)}${row.credits ? ` · ${row.credits} credits` : ''}${row.not_offered ? ` · not offered in ${row.not_offered}` : ''}</span>
    ${e.met.length ? html`<span class="meta ok-text">Entry: you've passed ${e.met.join(', ')}</span>` : e.refs.length ? html`<span class="meta">Entry mentions ${e.refs.slice(0, 4).join(', ')}${e.refs.length > 4 ? '…' : ''}</span>` : ''}
    ${inPlan ? html`<span class="badge">In your plan</span>` : html`<a class="btn btn-small" href="${link({ add: c })}" aria-label="Add ${c} to the plan">Add</a>`}
  </li>`;
}

const PICK = ['', 'one', 'two', 'three', 'four', 'five'];
function majorCard(n, ctx) {
  const { profile, expanded } = ctx;
  const upTo = profile.year || 1;
  const optionText = (o) => o.codes.map((c) => (c.includes('x') ? `any ${c.slice(0, 7)} course` : c)).join(' and ');
  return html`<section class="card plan-major" aria-labelledby="major-${n.key}">
    <h3 id="major-${n.key}">${n.name}</h3>
    ${!n.open.length
      ? html`<p class="plan-note ok">Everything ${n.name} lists up to ${YEARS[Math.min(upTo, 4) - 1]} year is passed or in your plan.</p>`
      : html`<p class="meta">Still needed up to ${YEARS[Math.min(upTo, 4) - 1]} year, from the 2026 handbook's table:</p>
      <ul class="plain need-groups">${n.open.map((g) => html`<li>
        <p class="need-label"><strong>Year ${g.year}${g.options.length > 1 ? `: ${PICK[g.pick] || g.pick} of` : ''}</strong>
          ${g.options.length > 1 ? html` <span class="meta">${[...new Set(g.options.map(optionText))].join(' / ')}</span>` : ''}</p>
        <ul class="plain">${g.options.filter((o) => o.state === 'todo').flatMap((o) => o.codes.filter((c) => !profile.done.includes(c)))
          .flatMap((c) => (c.includes('x') ? (expanded[c] || []).slice(0, 6).map((x) => x.code) : [c]))
          .map((c) => neededCourse(c, ctx))}</ul>
      </li>`)}</ul>`}
    ${n.years.flatMap((y) => y.electives.map((e) => html`<p class="meta">Year ${y.year} also has ${plural(e.count, 'approved elective')}${e.credits ? ` (${e.credits} credits)` : ''}.</p>`))}
    ${n.years.flatMap((y) => (y.recommended.length ? [html`<p class="meta">Recommended in year ${y.year}: ${y.recommended.join(', ')}.</p>`] : []))}
  </section>`;
}

// Credits for the year against the programme or faculty rules, re-registration minimums and progress to the degree.
function creditCard(a) {
  if (!a) return '';
  const items = [];
  if (a.target) {
    const range = a.target.min === a.target.max ? `${a.target.min}` : `${a.target.min} to ${a.target.max}`;
    if (!a.plannedCredits) items.push(html`<li>Add courses to see how your ${YEARS[a.year - 1]} year compares with the ${range} credits from ${a.target.from}.</li>`);
    else items.push(html`<li class="${a.load === 'ok' ? 'ok-text' : 'bad'}"><strong>${a.load === 'under' ? 'Under-loaded' : a.load === 'over' ? 'Overloaded' : 'Full load'}:</strong> ${a.plannedCredits} credits planned for ${YEARS[a.year - 1]} year. The expected load is ${range} credits (${a.target.from}).${a.load === 'under' ? ' Add a course or an elective.' : a.load === 'over' ? ' Check that you can carry this, and whether the faculty needs to approve it.' : ''}</li>`);
  }
  for (const s of a.semesters.filter((x) => x.over)) items.push(html`<li class="bad"><strong>${s.label}:</strong> ${s.credits} credits. ${a.faculty.name} allows at most ${a.faculty.semesterMax} credits a semester unless the faculty agrees to more.</li>`);
  if (a.readmit) {
    const short = a.readmit.have < a.readmit.need;
    items.push(html`<li class="${short ? 'bad' : 'ok-text'}"><strong>Re-registration:</strong> you need ${a.readmit.need} ${a.readmit.unit} by the end of year ${a.year} to carry on. Passed plus planned: ${a.readmit.have}.${short ? ' You\'re short even if you pass everything planned.' : ''}</li>`);
  }
  if (a.total) items.push(html`<li><strong>Degree:</strong> ${a.passedCredits} of ${a.total} credits passed${a.plannedCredits ? `, ${a.plannedCredits} more planned` : ''}.${a.senior != null && a.faculty.seniorCredits ? ` At level ${a.faculty.seniorLevel} or higher: ${a.senior} of the ${a.faculty.seniorCredits} you need, counting this plan.` : ''}</li>`);
  return html`<section class="card plan-credits" aria-labelledby="credits-head">
    <h2 id="credits-head">Credits</h2>
    <ul class="plain">${items}</ul>
    <p class="fine">From the 2026 <a href="${a.faculty.handbook}">${a.faculty.name} handbook</a>: ${a.faculty.rules}. Passed credits only count the courses you listed.</p>
  </section>`;
}

function plan(ctx, { courses: list, plan: p, matches, add, codes, profile, needs, advice, known, expanded, passed, programmeOptions, facultyOptions, state }) {
  const link = (o) => `/plan?${new URLSearchParams({ ...state, ...o })}`;
  const url = `${ctx.site.origin}/plan?c=${codes.join(',')}`;
  const summary = planSummary(p);
  const warnings = planWarnings(p);
  const description = list.length
    ? `${summary || codes.join(', ')}. Plan your own semester on Kwaai.`
    : 'Plan your UCT semesters: lecture clashes, entry requirements, exam weight and how heavy students say each course is.';
  return layout({ ...ctx, title: 'Semester planner', here: '/plan', description, path: codes.length ? `/plan?c=${codes.join(',')}` : '/plan' }, html`
  <h1 class="page-title">Plan your semesters</h1>
  <p class="lede small">Add the courses you're thinking of taking. Kwaai checks them against the 2026 handbook and what students say, and splits them into Semester 1 and Semester 2.</p>

  ${profileCard(profile, { programmeOptions, facultyOptions, needs, state, known })}

  <form class="search search-inline plan-add" action="/plan" role="search">
    ${Object.entries({ c: '', ...state }).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
    <input type="search" name="add" value="${add}" placeholder="Code or name, e.g. CSC1015F" aria-label="Add a course by code or name" autocomplete="off" required data-suggest="fill">
    <button class="btn btn-ink">Add</button>
  </form>
  ${matches ? matches.length
    ? html`<div class="card panel plan-matches"><p class="meta">Pick the course you mean:</p><ul class="plain">${matches.map((m) => html`<li><a href="${link({ add: m.code })}"><span class="code">${m.code}</span> ${m.title}</a></li>`)}</ul></div>`
    : html`<p class="flash flash-error" role="alert">No course matches “${add}”. Try the course code from your handbook, like MAM1031F.</p>` : ''}

  ${advice || needs.length ? html`<div class="plan-degree">
    ${creditCard(advice)}
    ${needs.map((n) => majorCard(n, { profile, expanded, known, passed: profile.done, codes, link }))}
  </div>` : ''}

  ${list.length ? html`
  ${warnings.length ? html`<section class="card plan-warnings" role="status"><h2>Check these before you register</h2><ul>${warnings}</ul></section>` : ''}
  <div class="plan-terms">
    ${p.terms.filter((t) => t.courses.length).map((t) => planTerm(t, p, link))}
  </div>
  ${p.other.length ? html`<section class="card plan-term"><h2>Other terms</h2><p class="meta">Summer, winter or non-standard courses. They're not counted in either semester.</p>
    <ul class="plan-courses">${p.other.map((c) => planCourse(c, p.entry[c.code], [], link))}</ul></section>` : ''}
  <div class="plan-share">
    <a class="btn btn-quiet" href="https://wa.me/?text=${encodeURIComponent(`My plan on Kwaai. ${summary}. How cooked is yours? ${url}`)}" target="_blank" rel="noopener">Share on WhatsApp</a>
    <span class="meta">Your plan is saved on this device. The link works for anyone you send it to.</span>
  </div>
  <p class="fine">Lecture periods, entry requirements and assessment come from UCT's 2026 handbooks and can change. Check the official timetable before you register. Student scores average every review of the course, across lecturers and years.</p>`
  : html`<div class="card panel plan-empty">
      <p><strong>Your plan is empty.</strong> Add the courses you're considering for next year, from both semesters. You'll see:</p>
      <ul>
        <li>lecture clashes, and which lecture group to pick to avoid them</li>
        <li>entry requirements, and whether you've planned them in the right order</li>
        <li>how much of each semester's marks ride on final exams</li>
        <li>what it takes to get DP for each course</li>
        <li>how heavy students say each semester is</li>
        <li>with your faculty, major and year filled in above: whether your credits are under or over the load, what you need to re-register, and which courses your major still needs</li>
      </ul>
      <p class="meta">Try it with <a href="/plan?c=CSC1015F,MAM1031F,STA1000F,CSC1016S,MAM1032S">a first-year computer science plan</a>.</p>
    </div>`}`);
}

function universities(ctx, { universities: list, liveCourses }) {
  return layout({ ...ctx, title: 'Universities', here: '/universities', path: '/universities' }, html`
  <h1 class="page-title">Universities</h1>
  <p class="lede small">Kwaai started at UCT. More South African universities are next.</p>
  <ul class="uni-list">
    ${list.map((u) => html`<li style="--uni:${u.accent};--uni-soft:${u.soft}">
      <span class="uni-dot" aria-hidden="true"></span>
      <div><strong>${u.name}</strong><span class="meta">${u.city}</span></div>
      ${u.live ? html`<a class="btn btn-small" href="/courses">Browse ${plural(liveCourses, 'course')}</a>` : html`<span class="status">Coming soon</span>`}
    </li>`)}
  </ul>
  <p class="fine">The colour next to each university is our own pick, chosen to echo the campus. Kwaai isn't affiliated with any of these universities.</p>`);
}

function rules(ctx) {
  return layout({ ...ctx, title: 'House rules' }, html`
  <article class="prose">
  <h1 class="page-title">House rules</h1>
  <p class="lede small">Kwaai exists to help students choose courses and prepare for them. Roasting a course is fine. Attacking a person isn't.</p>

  <h2>✅ Do</h2>
  <ul>
    <li>Rate the <strong>teaching, the course and the assessments</strong> from your own experience.</li>
    <li>Be specific and useful. "Tutorials explain far more than lectures" helps the next person. "Worst lecturer ever" doesn't.</li>
    <li>Give an honest opinion. Opinions are allowed to be negative.</li>
  </ul>

  <h2>🚫 Don't</h2>
  <ul>
    <li><strong>No allegations.</strong> Don't accuse anyone of harassment, discrimination, misconduct or a crime here. If something serious happened, report it to UCT's Office for Inclusivity &amp; Change, the Ombud or SAPS. They can act on it. A review site can't.</li>
    <li><strong>No personal attacks.</strong> Leave out looks, accent, age, family, religion, identity and personal life.</li>
    <li><strong>No private information.</strong> No phone numbers, emails, addresses or students' names.</li>
    <li><strong>No fake reviews</strong> or reviews of courses you didn't take.</li>
    <li><strong>No exam leaks</strong> or answers to assessments that are still running.</li>
  </ul>

  <h2 id="moderation">🛡️ How moderation works</h2>
  <ol>
    <li>Every comment is screened automatically. Contact details and links are blocked. Comments that look like allegations, insults or remarks about identity or personal life wait for a moderator before they appear.</li>
    <li>Every review has a <strong>⚑ Report</strong> button. Reports of false claims, private information or discrimination <strong>hide the review immediately</strong>. Other reports hide it after ${HIDE_AFTER_REPORTS} reports.</li>
    <li>A moderator then either restores the review or removes it for good. We aim to act within <strong>48 hours</strong>. Every decision is logged.</li>
    <li>Students who repeatedly break the rules are banned.</li>
  </ol>

  <h2 id="takedown">📮 Are you the person a review is about?</h2>
  <p>Lecturers and staff don't need an account. Use the <a href="/takedown">removal request form</a>, or the "Request removal" link on any review. The review is hidden while we look at it.</p>

  <h2 id="privacy">🔒 Privacy</h2>
  <p>Your email is never shown next to your reviews. You can delete your reviews or your whole account from <a href="/account">My reviews</a>. The full details are in the <a href="/privacy">privacy notice</a>.</p>
  </article>`);
}

function privacy(ctx) {
  const { operator, contactEmail } = ctx.site;
  const contact = contactEmail ? html`<a href="mailto:${contactEmail}">${contactEmail}</a>` : html`the <a href="/takedown">contact form</a>`;
  return layout({ ...ctx, title: 'Privacy notice' }, html`
  <article class="prose">
  <h1 class="page-title">Privacy notice</h1>
  <p class="lede small">How Kwaai handles personal information under South Africa's Protection of Personal Information Act (POPIA).</p>

  <h2>Who is responsible</h2>
  <p>Kwaai is run by ${operator}, an independent student project. It is not run by or affiliated with any university, including the University of Cape Town. The responsible party and information officer is ${operator}, reachable at ${contact}.</p>

  <h2>What we collect, and why</h2>
  <ul>
    <li><strong>Your @myuct.ac.za email</strong>, to check you're a UCT student, send sign-in links, and enforce bans. It is never shown publicly.</li>
    <li><strong>Your reviews and votes</strong> (ratings, tags, comment, kwaai-or-nah vote, tip, course, lecturer, year). They are published without your name or email.</li>
    <li><strong>Cookies</strong> that are strictly necessary: one to keep you signed in, one to protect forms against forgery (CSRF), a short-lived one for on-screen messages, and one that remembers the course codes in your semester plan for 180 days. No advertising or tracking cookies.</li>
    <li><strong>Your IP address</strong>, held briefly in memory to limit abuse (for example, too many reports). It isn't written to our database.</li>
    <li><strong>Removal requests:</strong> the name, email and details you give us, used only to deal with that request.</li>
    <li><strong>Lecturers' names</strong> come from UCT's public handbooks and course pages, and are shown only in connection with the courses they teach.</li>
  </ul>
  <p>We process this information for our legitimate interest, and our users', in running a fair course-review service (POPIA section 11(1)(f)), and with your consent when you sign up.</p>

  <h2>Who else sees it</h2>
  <ul>
    <li>Volunteer moderators, who can see hidden reviews and removal requests but not which student wrote a review.</li>
    <li>Our email provider (Resend), which sends sign-in emails and may process your email address outside South Africa under its own data-protection terms.</li>
    <li>Our hosting provider, which stores the database.</li>
  </ul>
  <p>We never sell personal information and never share it with UCT unless a court or the law requires us to.</p>

  <h2>How long we keep it</h2>
  <ul>
    <li>Your account, reviews and votes stay until you delete them.</li>
    <li>Sign-in links expire after 15 minutes and sessions after 30 days. Both are then deleted.</li>
    <li>Reviews and tips removed by moderators, and handled removal requests, are deleted after 12 months.</li>
  </ul>

  <h2>Your rights</h2>
  <ul>
    <li>See or delete your reviews, or delete your whole account, at <a href="/account">My reviews</a>.</li>
    <li>Ask what information we hold about you, ask for corrections, or object to processing, via ${contact}.</li>
    <li>Lecturers can object to a review through the <a href="/takedown">removal request form</a>.</li>
    <li>If you're unhappy with how we've handled your information, you can complain to the <a href="https://inforegulator.org.za" rel="noopener">Information Regulator</a>.</li>
  </ul>
  </article>`);
}

function terms(ctx) {
  return layout({ ...ctx, title: 'Terms of use' }, html`
  <article class="prose">
  <h1 class="page-title">Terms of use</h1>
  <p class="lede small">The short version: be honest, be fair, and remember these are students' opinions.</p>
  <ol>
    <li><strong>Unofficial.</strong> Kwaai is an independent student project. It is not affiliated with, endorsed by or run by any university, including the University of Cape Town. Course information comes from UCT's public handbooks and may be out of date.</li>
    <li><strong>Who can post.</strong> You need a current @myuct.ac.za email. One account per person. Don't share your sign-in link.</li>
    <li><strong>Your reviews.</strong> You're responsible for what you post. It must be your honest opinion of a course you took, and it must follow the <a href="/rules">house rules</a>. Don't post allegations, private information, or anything defamatory, discriminatory or harassing.</li>
    <li><strong>Permission to show your review.</strong> By posting, you let Kwaai display your review on this site. You can delete it at any time.</li>
    <li><strong>Moderation.</strong> We may hide or remove any review, and suspend any account, that breaks these terms or the house rules, or that we reasonably think could harm someone. Reviews may be hidden while a report or removal request is looked at.</li>
    <li><strong>Opinions, not facts.</strong> Reviews are the personal opinions of individual students, not statements by Kwaai. Ratings are averages of those opinions.</li>
    <li><strong>No guarantees.</strong> The site is provided as is, for free. We don't guarantee it will always be available or accurate, and to the extent the law allows we're not liable for decisions you make using it.</li>
    <li><strong>Changes.</strong> We may update these terms. Material changes will be announced on the site.</li>
    <li><strong>Law.</strong> These terms are governed by South African law.</li>
  </ol>
  <p>Questions or complaints: use the <a href="/takedown">contact form</a>.</p>
  </article>`);
}

function account(ctx, { reviews, verdicts }) {
  const label = { published: ['Live', 'tone-good'], held: ['Waiting for a moderator', 'tone-mid'], removed: ['Removed by a moderator', 'tone-low'] };
  return layout({ ...ctx, title: 'My reviews' }, html`
  <h1 class="page-title">My reviews</h1>
  <p class="lede small">Signed in as <strong>${ctx.user.email}</strong>. Only you can see this page. Your email is never shown next to your reviews.</p>
  <h2 class="section-title">My votes</h2>
  ${verdicts.length ? html`<div class="my-reviews">${verdicts.map((v) => html`<div class="card mod-item">
    <div class="mod-meta"><a href="/courses/${v.course}"><span class="code">${v.course}</span></a> · ${v.year} · <strong>${v.lekker ? 'Kwaai' : 'Nah'}</strong> · <span class="status ${label[v.status][1]}">${label[v.status][0]}</span></div>
    ${v.tip ? html`<p>“${v.tip}”</p>` : ''}
    <form method="post" action="/verdicts/${v.id}/delete" class="inline" data-confirm="Delete this vote? This can't be undone."><input type="hidden" name="back" value="account"><button class="btn btn-small btn-quiet">Delete</button></form>
  </div>`)}</div>` : html`<p class="empty">No votes yet.</p>`}

  <h2 class="section-title">My full reviews</h2>
  ${reviews.length ? html`<div class="my-reviews">${reviews.map((r) => html`<div class="card mod-item">
    <div class="mod-meta"><a href="/courses/${r.course}"><span class="code">${r.course}</span></a> · ${r.lecturer_name || 'Lecturer not listed'} · ${r.year} · <span class="status ${label[r.status][1]}">${label[r.status][0]}</span></div>
    <p>${chip(r.overall)} ${r.body ? html`“${r.body}”` : html`<span class="muted">(rating only)</span>`}</p>
    <form method="post" action="/reviews/${r.id}/delete" class="inline" data-confirm="Delete this review? This can't be undone."><button class="btn btn-small btn-quiet">Delete</button></form>
  </div>`)}</div>` : html`<p class="empty">You haven't reviewed anything yet. <a href="/courses">Find a course</a>.</p>`}

  <h2 class="section-title">Delete my account</h2>
  <div class="card panel danger-zone">
    <p>This permanently deletes your account, your email address and <strong>all your votes, tips and reviews</strong>.</p>
    <form method="post" action="/account/delete" data-confirm="Delete your account with all your votes and reviews? This can't be undone."><button class="btn btn-danger">Delete my account</button></form>
  </div>`);
}

function login(ctx, { error, email = '', next = '/' } = {}) {
  return layout({ ...ctx, title: 'Sign in' }, html`
  <section class="narrow">
    <h1 class="page-title">Sign in with your UCT email</h1>
    <p class="lede small">We'll email a 6-digit code to your <strong>@myuct.ac.za</strong> address. No password, and nothing you post shows your name.</p>
    ${error ? html`<div class="flash flash-error" role="alert">${error}</div>` : ''}
    <form method="post" action="/login" class="card form">
      <input type="hidden" name="next" value="${next}">
      <label>Student email
        <input type="email" name="email" value="${email}" required autocomplete="email" inputmode="email" placeholder="abcxyz001@myuct.ac.za" pattern="[A-Za-z0-9._%+\\-]+@myuct\\.ac\\.za">
      </label>
      <button class="btn btn-big">Email me a code</button>
      <p class="fine">By signing in you agree to the <a href="/terms">terms of use</a> and the <a href="/privacy">privacy notice</a>.</p>
    </form>
  </section>`);
}

function checkEmail(ctx, { email, devLink, devCode, error }) {
  return layout({ ...ctx, title: 'Enter your code' }, html`
  <section class="narrow">
    <h1 class="page-title">Check your inbox</h1>
    <p class="lede small">We sent a 6-digit code to <strong>${email}</strong>. Type it below, or tap the button in the email. Both expire in 15 minutes.</p>
    ${error ? html`<div class="flash flash-error" role="alert">${error}</div>` : ''}
    <form method="post" action="/login/code" class="card form">
      <input type="hidden" name="email" value="${email}">
      <label>Sign-in code
        <input class="code-input" name="code" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" placeholder="123456" autofocus>
      </label>
      <button class="btn btn-big">Sign in</button>
      <p class="fine">Nothing after a minute or two? Check your junk or "Other" folder for an email from Kwaai. <a href="/login">Send a new code</a></p>
    </form>
    ${devLink ? html`<div class="card dev"><p><span class="badge">Demo</span> Email isn't set up on this site, so here's what the email would say. Code: <strong>${devCode}</strong></p><a class="btn" href="${devLink}">Open the sign-in link</a></div>` : ''}
  </section>`);
}

function confirmSignIn(ctx, { email, token }) {
  return layout({ ...ctx, title: 'Sign in' }, html`
  <section class="narrow">
    <h1 class="page-title">Sign in to Kwaai</h1>
    <p class="lede small">You're signing in as <strong>${email}</strong>.</p>
    <form method="post" action="/auth/${token}" class="card form">
      <button class="btn btn-big">Sign in</button>
      <p class="fine">Didn't ask to sign in? Close this page and nothing happens.</p>
    </form>
  </section>`);
}

function takedown(ctx, { review, error, values = {} }) {
  const v = (k) => values[k] ?? '';
  return layout({ ...ctx, title: 'Request removal' }, html`
  <section class="narrow">
    <h1 class="page-title">Request a review's removal</h1>
    <p class="lede small">For lecturers, staff or anyone a review is about. No account needed. If you name a specific review, it's hidden straight away while a moderator looks at it.</p>
    ${error ? html`<div class="flash flash-error" role="alert">${error}</div>` : ''}
    ${review ? html`<div class="card quote"><p class="meta">Review #${review.id} on ${review.course}</p>${review.body ? html`<p>“${review.body}”</p>` : html`<p class="muted">(rating only, no comment)</p>`}</div>` : ''}
    <form method="post" action="/takedown" class="card form">
      ${review ? html`<input type="hidden" name="review_id" value="${review.id}">` : html`<label>Link to the review or its number <span class="hint">Optional</span><input name="review_ref" value="${v('review_ref')}" placeholder="e.g. 42 or https://…/courses/MEC2047F#review-42"></label>`}
      <div class="form-row two">
        <label>Your name<input name="name" value="${v('name')}" required maxlength="100"></label>
        <label>Email we can reply to<input type="email" name="email" value="${v('email')}" required maxlength="200"></label>
      </div>
      <label>You are…
        <select name="relation" required>
          ${['The lecturer or staff member it is about', 'Acting for the person it is about', 'A student', 'Someone else'].map((o) => html`<option ${v('relation') === o ? 'selected' : ''}>${o}</option>`)}
        </select>
      </label>
      <label>What's the problem?<textarea name="details" rows="4" required maxlength="2000">${v('details')}</textarea></label>
      <button class="btn btn-big">Send request</button>
      <p class="fine">We use these details only to deal with this request.</p>
    </form>
  </section>`);
}

function message(ctx, { title, emoji = '👍', text, link }) {
  return layout({ ...ctx, title }, html`
  <section class="narrow center">
    <p class="big-emoji">${emoji}</p>
    <h1 class="page-title">${title}</h1>
    <p>${text}</p>
    ${link ? html`<p><a class="btn" href="${link.href}">${link.label}</a></p>` : ''}
  </section>`);
}

function suggestLecturer(ctx, { c, error, values = {} }) {
  return layout({ ...ctx, title: 'Suggest a lecturer' }, html`
  <section class="narrow">
    <nav class="crumbs"><a href="/courses/${c.code}">${c.code}</a> / Suggest a lecturer</nav>
    <h1 class="page-title">Suggest a lecturer for ${c.code}</h1>
    <p class="lede small">A moderator checks every name against UCT's public staff pages before it appears, so please use the name as UCT writes it.</p>
    ${error ? html`<div class="flash flash-error" role="alert">${error}</div>` : ''}
    <form method="post" action="/courses/${c.code}/suggest-lecturer" class="card form">
      <div class="form-row two">
        <label>Title
          <select name="title" required>${['Prof', 'Associate Professor', 'Dr', 'Mr', 'Ms', 'Mrs', 'Mx'].map((t) => html`<option ${values.title === t ? 'selected' : ''}>${t}</option>`)}</select>
        </label>
        <label>Name<input name="name" value="${values.name ?? ''}" required maxlength="60" placeholder="e.g. J Smith"></label>
      </div>
      <button class="btn btn-big">Send suggestion</button>
    </form>
  </section>`);
}

function mod(ctx, { held, heldTips, takedowns, suggestions, log }) {
  return layout({ ...ctx, title: 'Moderation' }, html`
  <h1 class="page-title">Moderation</h1>
  <p class="lede small">Hidden reviews wait here. <strong>Approve</strong> puts a review back up and clears its reports. <strong>Remove</strong> takes it down for good.</p>

  <h2 class="section-title">Removal requests <span class="count">${takedowns.length}</span></h2>
  ${takedowns.length ? takedowns.map((t) => html`<div class="card mod-item">
    <div class="mod-meta"><strong>${t.name}</strong> &lt;${t.email}&gt; · ${t.relation} · ${month(t.created_at)}${t.review_id ? html` · <a href="#held-${t.review_id}">review #${t.review_id}</a>` : ''}</div>
    <p>${t.details}</p>
    <form method="post" action="/mod/takedowns/${t.id}/close" class="inline"><button class="btn btn-small btn-quiet">Mark handled</button></form>
  </div>`) : html`<p class="empty">No open requests. 🎉</p>`}

  <h2 class="section-title">Lecturer suggestions <span class="count">${suggestions.length}</span></h2>
  ${suggestions.length ? suggestions.map((x) => html`<div class="card mod-item">
    <div class="mod-meta">For <a href="/courses/${x.course}">${x.course}</a> · ${x.dept_name} · ${month(x.created_at)}</div>
    <p><strong>${x.name}</strong></p>
    <div class="mod-actions">
      <form method="post" action="/mod/suggestions/${x.id}/approve" class="inline"><button class="btn btn-small btn-ok">Add lecturer</button></form>
      <form method="post" action="/mod/suggestions/${x.id}/reject" class="inline"><button class="btn btn-small btn-quiet">Reject</button></form>
    </div>
  </div>`) : html`<p class="empty">No suggestions waiting.</p>`}

  <h2 class="section-title">Hidden reviews <span class="count">${held.length}</span></h2>
  ${held.length ? held.map((r) => html`<div class="card mod-item" id="held-${r.id}">
    <div class="mod-meta"><a href="/courses/${r.course}">${r.course}</a> · ${r.lecturer_name || 'Lecturer not listed'} · ${r.year} · overall ${fmt(r.overall)} · #${r.id}</div>
    <div class="flags">${r.flags.split('|').filter(Boolean).map((f) => html`<span class="flag">${f}</span>`)}</div>
    ${r.body ? html`<p class="review-body">“${r.body}”</p>` : html`<p class="muted">(no comment)</p>`}
    ${r.report_details ? html`<p class="fine">Reporter notes: ${r.report_details}</p>` : ''}
    <div class="mod-actions">
      <form method="post" action="/mod/reviews/${r.id}/approve" class="inline"><button class="btn btn-small btn-ok">Approve</button></form>
      <form method="post" action="/mod/reviews/${r.id}/remove" class="inline"><input name="note" placeholder="Reason (logged)" maxlength="200"><button class="btn btn-small btn-danger">Remove</button></form>
      ${r.user_id ? html`<form method="post" action="/mod/reviews/${r.id}/ban" class="inline" data-confirm="Remove this review and ban its author?"><button class="btn btn-small btn-quiet">Remove + ban author</button></form>` : ''}
    </div>
  </div>`) : html`<p class="empty">Nothing waiting. 🎉</p>`}

  <h2 class="section-title">Hidden tips <span class="count">${heldTips.length}</span></h2>
  ${heldTips.length ? heldTips.map((v) => html`<div class="card mod-item">
    <div class="mod-meta"><a href="/courses/${v.course}">${v.course}</a> · ${v.year} · voted ${v.lekker ? 'kwaai' : 'nah'} · tip #${v.id}</div>
    <div class="flags">${v.flags.split('|').filter(Boolean).map((f) => html`<span class="flag">${f}</span>`)}</div>
    <p class="review-body">“${v.tip}”</p>
    <div class="mod-actions">
      <form method="post" action="/mod/verdicts/${v.id}/approve" class="inline"><button class="btn btn-small btn-ok">Approve</button></form>
      <form method="post" action="/mod/verdicts/${v.id}/remove" class="inline"><button class="btn btn-small btn-danger">Remove</button></form>
      <form method="post" action="/mod/verdicts/${v.id}/ban" class="inline" data-confirm="Remove this tip and ban its author?"><button class="btn btn-small btn-quiet">Remove + ban author</button></form>
    </div>
  </div>`) : html`<p class="empty">Nothing waiting. 🎉</p>`}

  <h2 class="section-title">Recent decisions</h2>
  ${log.length ? html`<table class="log"><thead><tr><th>When</th><th>Review</th><th>Action</th><th>Note</th><th>By</th></tr></thead><tbody>
  ${log.map((l) => html`<tr><td>${l.created_at}</td><td>${l.review_id ? `#${l.review_id}` : '–'}</td><td>${l.action}</td><td>${l.note}</td><td>${l.moderator}</td></tr>`)}
  </tbody></table>` : html`<p class="empty">No decisions yet.</p>`}`);
}

module.exports = { universities, plan, home, courses, course, reviewForm, lecturer, rankings, rules, login, checkEmail, confirmSignIn, takedown, message, mod, suggestLecturer, privacy, terms, account };
