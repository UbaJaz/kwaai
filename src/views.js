const { html } = require('./html');
const { QUALITY, SCALES, TAGS, MAX_TAGS, MAX_BODY, MIN_FOR_RANKING, RANKINGS } = require('./ratings');
const { REPORT_REASONS, HIDE_AFTER_REPORTS } = require('./moderation');

const fmt = (n) => (n == null ? '–' : Number(n).toFixed(1));
const tone = (n) => (n == null ? 'none' : n >= 4 ? 'good' : n >= 3 ? 'mid' : 'low');
const month = (iso) => new Date(iso.replace(' ', 'T') + 'Z').toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' });
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------- layout ----------

function layout({ title, user, isMod, flash }, body) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title ? `${title} · LekkerOrNah` : 'LekkerOrNah: is your course lekker or nah?'}</title>
<meta name="description" content="Unofficial course and lecturer reviews by UCT students. Not affiliated with the University of Cape Town.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,800&display=swap">
<link rel="stylesheet" href="/style.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🤙</text></svg>">
<script src="/app.js" defer></script>
</head>
<body>
<div class="notice">Unofficial student project · not affiliated with UCT · reviews marked <span class="badge sample">Sample</span> are demo data</div>
<header class="site-header">
  <div class="wrap header-row">
    <a class="logo" href="/"><span class="logo-mark">🤙</span><span>lekker<em>or nah?</em></span></a>
    <nav class="nav">
      <a href="/courses">Courses</a>
      <a href="/rankings">Rankings</a>
      <a href="/rules">Rules</a>
      ${isMod ? html`<a href="/mod" class="nav-mod">Moderation</a>` : ''}
      ${user
        ? html`<form method="post" action="/logout" class="inline"><button class="link-btn" title="${user.email}">Sign out</button></form>`
        : html`<a class="btn btn-small" href="/login">Sign in</a>`}
    </nav>
  </div>
</header>
<main class="wrap">
${flash ? html`<div class="flash flash-${flash.type}" role="status">${flash.text}</div>` : ''}
${body}
</main>
<footer class="site-footer">
  <div class="wrap footer-row">
    <p><strong>LekkerOrNah</strong> is an independent, student-run site. It is not affiliated with, endorsed by or run by the University of Cape Town. Reviews are students' personal opinions.</p>
    <p><a href="/rules">House rules</a> · <a href="/rules#takedown">Report or request removal</a> · <a href="/rules#privacy">Privacy</a></p>
  </div>
</footer>
</body>
</html>`;
}

// ---------- small components ----------

const stars = (n) => html`<span class="stars" style="--v:${n == null ? 0 : n}" role="img" aria-label="${n == null ? 'No rating yet' : `${fmt(n)} out of 5`}"></span>`;
const chip = (n, big) => html`<span class="score ${big ? 'score-big' : ''} tone-${tone(n)}">${fmt(n)}</span>`;
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

function reviewCard(r, { user, lecturerLink = true, courseLink = false } = {}) {
  const tags = r.tags ? r.tags.split('|') : [];
  const mine = user && r.user_id === user.id;
  return html`<article class="card review" id="review-${r.id}">
    <div class="review-head">
      ${chip(r.overall, true)}
      <div>
        ${stars(r.overall)}
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
    ${r.body ? html`<p class="review-body">${r.body}</p>` : ''}
    <div class="review-foot">
      <span class="muted">Anonymous UCT student · ${month(r.created_at)}</span>
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

function rankList(rows, kind, rank) {
  if (!rows.length) return html`<p class="empty">Not enough reviews yet. Things need at least ${MIN_FOR_RANKING} reviews to be ranked.</p>`;
  return html`<ol class="rank-list">
    ${rows.map((r, i) => html`<li>
      <span class="rank-pos">${i + 1}</span>
      <a href="${kind === 'course' ? `/courses/${r.code}` : `/lecturers/${r.id}`}" class="rank-name">
        ${kind === 'course' ? html`<span class="code">${r.code}</span> ${r.title}` : r.name}
        ${sampleBadge(r.is_sample)}
        <span class="meta">${r.dept_name} · ${plural(r.n, 'review')}</span>
      </a>
      <span class="rank-score">${rank.column === 'overall' || QUALITY.some((q) => q.key === rank.column) ? chip(r.score) : html`<span class="score tone-none">${fmt(r.score)}/5</span>`}</span>
    </li>`)}
  </ol>`;
}

// ---------- pages ----------

function home(ctx, { counts, topCourses, funniest, hardest, depts }) {
  return layout(ctx, html`
  <section class="hero">
    <p class="eyebrow">For UCT students, by UCT students</p>
    <h1>Is your course <span class="hl">lekker</span>… or nah?</h1>
    <p class="lede">Honest, anonymous ratings of UCT courses and the lecturers who teach them. Pick electives with your eyes open, and find out who sets the brutal exams before you're writing one.</p>
    <form class="search" action="/courses" role="search">
      <input type="search" name="q" placeholder="Try MEC2047F or “dynamics”" aria-label="Search courses">
      <button class="btn">Search</button>
    </form>
    <p class="stats">${plural(counts.courses, 'course')} · ${plural(counts.lecturers, 'lecturer')} · ${plural(counts.reviews, 'review')}</p>
  </section>

  <section class="grid-3">
    <div class="card panel">
      <h2>🏆 Top rated courses</h2>
      ${rankList(topCourses, 'course', RANKINGS[0])}
      <a class="more" href="/rankings?cat=best&kind=course">All rankings →</a>
    </div>
    <div class="card panel">
      <h2>😂 Funniest lecturers</h2>
      ${rankList(funniest, 'lecturer', RANKINGS[1])}
      <a class="more" href="/rankings?cat=funniest&kind=lecturer">All rankings →</a>
    </div>
    <div class="card panel">
      <h2>💀 Hardest exams</h2>
      ${rankList(hardest, 'course', RANKINGS[2])}
      <a class="more" href="/rankings?cat=hardest&kind=course">All rankings →</a>
    </div>
  </section>

  <section>
    <h2 class="section-title">Browse by department</h2>
    <div class="dept-grid">
      ${depts.map((d) => html`<a class="card dept" href="/courses?dept=${d.code}"><span class="dept-code">${d.code}</span><span>${d.name}</span><span class="meta">${plural(d.courses, 'course')}</span></a>`)}
    </div>
  </section>

  <section class="card how">
    <div><h3>⭐ Rate what matters</h3><p>Teaching, how fun the lectures are, how fair the exams are and how approachable the lecturer is. Difficulty and workload are rated separately, because hard isn't the same as bad.</p></div>
    <div><h3>🕶️ Anonymous, but real</h3><p>You sign in with your <strong>@myuct.ac.za</strong> email so every review comes from a real student. Your name and email are never shown.</p></div>
    <div><h3>🛡️ Keep it about the teaching</h3><p>No personal attacks and no allegations. Anyone can report a review and serious reports hide it immediately. <a href="/rules">Read the rules</a>.</p></div>
  </section>`);
}

function courses(ctx, { list, depts, q, dept }) {
  return layout({ ...ctx, title: 'Courses' }, html`
  <h1 class="page-title">Courses</h1>
  <form class="search search-inline" action="/courses" role="search">
    <input type="search" name="q" value="${q}" placeholder="Search code or name" aria-label="Search courses">
    ${dept ? html`<input type="hidden" name="dept" value="${dept}">` : ''}
    <button class="btn">Search</button>
  </form>
  <div class="chips">
    <a class="chip ${dept ? '' : 'on'}" href="/courses${q ? `?q=${encodeURIComponent(q)}` : ''}">All</a>
    ${depts.map((d) => html`<a class="chip ${dept === d.code ? 'on' : ''}" href="/courses?dept=${d.code}${q ? `&q=${encodeURIComponent(q)}` : ''}" title="${d.name}">${d.code}</a>`)}
  </div>
  <p class="meta">${plural(list.length, 'course')}${dept ? ` in ${depts.find((d) => d.code === dept)?.name || dept}` : ''}${q ? ` matching “${q}”` : ''}</p>
  ${list.length ? html`<div class="course-grid">${list.map(courseCard)}</div>` : html`<p class="empty">No courses found. Is it in another faculty? So far we've only imported the 2026 EBE handbook.</p>`}`);
}

function course(ctx, { c, stats, offerings, reviews, topTags, myHeld }) {
  return layout({ ...ctx, title: `${c.code} ${c.title}` }, html`
  <nav class="crumbs"><a href="/courses">Courses</a> / <a href="/courses?dept=${c.dept}">${c.dept_name}</a> / ${c.code}</nav>
  <section class="course-hero">
    <div>
      <span class="code code-big">${c.code}</span>
      <h1>${c.title}</h1>
      <p class="meta">${c.dept_name}${c.credits ? ` · ${c.credits} NQF credits` : ''}${c.nqf ? ` · NQF level ${c.nqf}` : ''}</p>
      ${c.conveners ? html`<p class="meta">Convener: ${c.conveners.split('|').join(', ')} <span class="src">(source: ${c.source})</span></p>` : ''}
    </div>
    <a class="btn btn-big" href="/courses/${c.code}/review">Rate this course</a>
  </section>

  ${myHeld ? html`<div class="flash flash-info">Your review for this course is waiting for a moderator. We check comments that might break the rules before they go live.</div>` : ''}

  <section class="course-layout">
    <aside class="card score-panel">
      ${stats.n
        ? html`<div class="overall">${chip(stats.overall, true)}<div>${stars(stats.overall)}<div class="meta">${plural(stats.n, 'review')} ${sampleBadge(stats.has_sample)}</div></div></div>
          ${bars(stats)}
          ${topTags.length ? html`<div class="tags">${topTags.map(([t, n]) => html`<span class="tag">${t} <b>${n}</b></span>`)}</div>` : ''}`
        : html`<div class="empty-score"><p class="big-emoji">🫥</p><p>No reviews yet.</p><a class="btn" href="/courses/${c.code}/review">Be the first</a></div>`}
      ${offerings.length ? html`<h3>Who taught it</h3>
        <table class="offerings"><thead><tr><th>Lecturer</th><th>Year</th><th>Rating</th></tr></thead><tbody>
        ${offerings.map((o) => html`<tr><td>${o.lecturer_id ? html`<a href="/lecturers/${o.lecturer_id}">${o.lecturer_name}</a>` : html`<span class="muted">Not listed</span>`}</td><td>${o.year}</td><td>${chip(o.overall)} <span class="meta">(${o.n})</span></td></tr>`)}
        </tbody></table>` : ''}
    </aside>
    <div class="reviews">
      <h2 class="section-title">Reviews</h2>
      ${reviews.length ? reviews.map((r) => reviewCard(r, ctx)) : html`<p class="empty">Nothing here yet. Took ${c.code}? Tell the next class what it's really like.</p>`}
    </div>
  </section>`);
}

function reviewForm(ctx, { c, conveners, others, years, values = {}, error }) {
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
        <span class="hint">Lecturers often change between blocks. Pick the one you mostly had.</span>
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
    <label class="check"><input type="checkbox" name="agree" value="1" required> My review is my honest opinion, follows the house rules, and is about my own experience of this course.</label>
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

function lecturer(ctx, { l, stats, courses: taught, reviews }) {
  return layout({ ...ctx, title: l.name }, html`
  <nav class="crumbs"><a href="/rankings?kind=lecturer">Lecturers</a> / ${l.name}</nav>
  <section class="course-hero">
    <div>
      <span class="code code-big">${l.dept}</span>
      <h1>${l.name} ${sampleBadge(l.is_sample)}</h1>
      <p class="meta">${l.dept_name}</p>
      ${l.is_sample ? html`<p class="meta">This is a made-up lecturer used to demo the site. Not a real person.</p>` : ''}
    </div>
  </section>
  <section class="course-layout">
    <aside class="card score-panel">
      ${stats.n
        ? html`<div class="overall">${chip(stats.overall, true)}<div>${stars(stats.overall)}<div class="meta">${plural(stats.n, 'review')}</div></div></div>${bars(stats)}`
        : html`<div class="empty-score"><p class="big-emoji">🫥</p><p>No reviews yet.</p></div>`}
      ${taught.length ? html`<h3>Courses</h3><ul class="plain">${taught.map((c) => html`<li><a href="/courses/${c.code}"><span class="code">${c.code}</span> ${c.title}</a> ${c.n ? html`<span class="meta">${chip(c.overall)} (${c.n})</span>` : ''}</li>`)}</ul>` : ''}
    </aside>
    <div class="reviews">
      <h2 class="section-title">Reviews</h2>
      ${reviews.length ? reviews.map((r) => reviewCard(r, { ...ctx, lecturerLink: false, courseLink: true })) : html`<p class="empty">No reviews yet.</p>`}
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
    ${rankList(rows, kind, rank)}
  </div>`);
}

function rules(ctx) {
  return layout({ ...ctx, title: 'House rules' }, html`
  <article class="prose">
  <h1 class="page-title">House rules</h1>
  <p class="lede small">LekkerOrNah exists to help students choose courses and prepare for them. Roasting a course is fine. Attacking a person isn't.</p>

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
  <ul>
    <li>We store your @myuct.ac.za email only to confirm you're a UCT student and to enforce bans. It is never shown next to your reviews or shared.</li>
    <li>Lecturer names come from public UCT handbooks and course pages, and only in connection with the courses they teach.</li>
    <li>You can delete your own reviews at any time. To have your account removed, use the <a href="/takedown">contact form</a>.</li>
    <li>We follow the Protection of Personal Information Act (POPIA). Send any objection or request through the same form.</li>
  </ul>
  </article>`);
}

function login(ctx, { error, email = '' } = {}) {
  return layout({ ...ctx, title: 'Sign in' }, html`
  <section class="narrow">
    <h1 class="page-title">Sign in with your UCT email</h1>
    <p class="lede small">We'll email a one-time sign-in link to your <strong>@myuct.ac.za</strong> address. There's no password to remember. Your reviews stay anonymous.</p>
    ${error ? html`<div class="flash flash-error" role="alert">${error}</div>` : ''}
    <form method="post" action="/login" class="card form">
      <label>Student email
        <input type="email" name="email" value="${email}" required autocomplete="email" placeholder="abcxyz001@myuct.ac.za" pattern="[A-Za-z0-9._%+-]+@myuct\\.ac\\.za">
      </label>
      <button class="btn btn-big">Email me a sign-in link</button>
    </form>
  </section>`);
}

function checkEmail(ctx, { email, devLink }) {
  return layout({ ...ctx, title: 'Check your email' }, html`
  <section class="narrow center">
    <p class="big-emoji">📬</p>
    <h1 class="page-title">Check your inbox</h1>
    <p>We sent a sign-in link to <strong>${email}</strong>. It expires in 15 minutes.</p>
    ${devLink ? html`<div class="card dev"><p><span class="badge">Dev mode</span> Email sending isn't set up yet, so here's the link:</p><a class="btn" href="${devLink}">Sign in now</a></div>` : ''}
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

function mod(ctx, { held, takedowns, log }) {
  return layout({ ...ctx, title: 'Moderation' }, html`
  <h1 class="page-title">Moderation</h1>
  <p class="lede small">Hidden reviews wait here. <strong>Approve</strong> puts a review back up and clears its reports. <strong>Remove</strong> takes it down for good.</p>

  <h2 class="section-title">Removal requests <span class="count">${takedowns.length}</span></h2>
  ${takedowns.length ? takedowns.map((t) => html`<div class="card mod-item">
    <div class="mod-meta"><strong>${t.name}</strong> &lt;${t.email}&gt; · ${t.relation} · ${month(t.created_at)}${t.review_id ? html` · <a href="#held-${t.review_id}">review #${t.review_id}</a>` : ''}</div>
    <p>${t.details}</p>
    <form method="post" action="/mod/takedowns/${t.id}/close" class="inline"><button class="btn btn-small btn-quiet">Mark handled</button></form>
  </div>`) : html`<p class="empty">No open requests. 🎉</p>`}

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

  <h2 class="section-title">Recent decisions</h2>
  ${log.length ? html`<table class="log"><thead><tr><th>When</th><th>Review</th><th>Action</th><th>Note</th><th>By</th></tr></thead><tbody>
  ${log.map((l) => html`<tr><td>${l.created_at}</td><td>${l.review_id ? `#${l.review_id}` : '–'}</td><td>${l.action}</td><td>${l.note}</td><td>${l.moderator}</td></tr>`)}
  </tbody></table>` : html`<p class="empty">No decisions yet.</p>`}`);
}

module.exports = { home, courses, course, reviewForm, lecturer, rankings, rules, login, checkEmail, takedown, message, mod };
