// The year view: both semesters, UCT's term dates, tests and exams students added, and a revision plan. When to
// start revising is a rule of thumb, shown with its reasons: a week as a base, more when the exam is a big share of
// the mark, more when students rate the course's exams as hard.
const { termDates } = require('./week');

const DAY = 86_400_000;
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

// exams: dated events of type exam ({ code, date, time, title, confirmed }); courses: rows with exam_weight and
// difficulty (students' average, 1 to 5)
function revisionPlan(exams, courses, today) {
  return exams.map((e) => {
    const c = courses.find((x) => x.code === e.code) || {};
    const weight = c.exam_weight ?? 60;
    const hard = c.difficulty ?? 3;
    const days = Math.max(5, Math.min(18, Math.round(7 + (weight - 50) / 10 + (hard - 3) * 2.5)));
    const reasons = [`${weight}% of the mark${c.exam_weight == null ? ' (a guess: the handbook doesn\'t say)' : ''}`];
    if (c.difficulty != null) reasons.push(`students rate its exams ${Math.round(hard * 10) / 10}/5 for difficulty`);
    const start = addDays(e.date, -days);
    return { ...e, days, start, reasons, countdown: today ? daysBetween(today, e.date) : null, startIn: today ? daysBetween(today, start) : null };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

// Everything dated in the year, grouped by month: term starts and ends, vacations, tests and exams, revision starts.
function yearTimeline(year, dated, revision) {
  const items = [];
  for (const [term, label] of [['s1', 'Semester 1'], ['s2', 'Semester 2']]) {
    const t = termDates(year, term);
    if (!t) continue;
    items.push({ date: t.start, kind: 'term', text: `${label} starts` });
    const pretty = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', timeZone: 'UTC' });
    for (const [a, b] of t.breaks) items.push({ date: a, kind: 'break', text: `Vacation until ${pretty(b)}` });
    items.push({ date: t.end, kind: 'term', text: `${label} ends` });
  }
  for (const d of dated) if (d.date.startsWith(String(year))) items.push({ date: d.date, kind: d.type === 'exam' ? 'exam' : 'event', code: d.code, text: `${d.code} ${d.title}${d.confirmed ? '' : ' (not confirmed yet)'}` });
  for (const r of revision) if (r.start.startsWith(String(year))) items.push({ date: r.start, kind: 'revise', code: r.code, text: `Start revising ${r.code} (${r.days} days before the exam)` });
  items.sort((a, b) => a.date.localeCompare(b.date));
  const months = [];
  for (const it of items) {
    const key = it.date.slice(0, 7);
    let m = months.find((x) => x.key === key);
    if (!m) months.push((m = { key, items: [] }));
    m.items.push(it);
  }
  return months;
}

module.exports = { revisionPlan, yearTimeline, addDays, daysBetween };
