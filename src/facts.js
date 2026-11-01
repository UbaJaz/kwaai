// Course details students add where the handbook is silent: when lectures, tuts and pracs happen, what each week
// covers, and dated events (class tests, assignments, exams). Each student adds a fact once; the same fact from
// another student counts as a confirmation. A fact is "confirmed" from AGREE students and only then changes other
// students' timetables. Facts are about the course, never about people, and text goes through the same screening as
// comments.
const { screenComment } = require('./moderation');

const AGREE = 2;
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const SLOT_KINDS = ['lecture', 'tut', 'prac'];
const EVENT_TYPES = { test: 'Class test', assignment: 'Assignment due', prac: 'Prac or lab due', exam: 'Exam', other: 'Other' };
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKS = 14;
const tidy = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// From a submitted form to { kind, key, data } or { error }. The key decides which facts are "the same".
function parseFact(body, { year = new Date().getFullYear() } = {}) {
  const kind = String(body.kind || '');
  if (SLOT_KINDS.includes(kind)) {
    const day = DAYS.includes(body.day) ? body.day : null;
    const { start, end } = body;
    if (!day || !TIME.test(start || '') || !TIME.test(end || '') || end <= start) return { error: 'Pick a day, and an end time after the start time.' };
    if (start < '07:00' || end > '21:00') return { error: 'Classes run between 07:00 and 21:00.' };
    return { kind, key: `${kind}|${day}|${start}|${end}`, data: { day, start, end } };
  }
  if (kind === 'topic') {
    const week = Number(body.week);
    const text = tidy(body.text, 80);
    if (!Number.isInteger(week) || week < 1 || week > WEEKS || text.length < 3) return { error: `Pick a week from 1 to ${WEEKS} and say what it covers.` };
    return { kind, key: `topic|${week}|${norm(text)}`, data: { week, text } };
  }
  if (kind === 'event') {
    const type = EVENT_TYPES[body.type] ? body.type : null;
    const title = tidy(body.title, 60) || (type ? EVENT_TYPES[type] : '');
    const date = String(body.date || '');
    const time = body.time && TIME.test(body.time) ? body.time : '';
    const y = Number(date.slice(0, 4));
    if (!type || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || y < year - 1 || y > year + 1) return { error: 'Pick what it is and a date this year.' };
    return { kind, key: `event|${date}|${type}|${norm(title)}`, data: { type, title, date, time } };
  }
  return { error: 'That kind of detail isn\'t supported.' };
}

// Screens the text parts (topic text, event title) like a comment.
function screenFact(fact) {
  const text = fact.data.text || fact.data.title || '';
  return text ? screenComment(text) : { action: 'publish', reasons: [] };
}

// rows: course_facts grouped by course and key, with n (students) and mine (1 if this student added it)
function groupFacts(rows) {
  const out = {};
  for (const r of rows) {
    const c = (out[r.course] ??= { lecture: [], tut: [], prac: [], topic: [], event: [] });
    const fact = { key: r.key, n: r.n, mine: !!r.mine, confirmed: r.n >= AGREE, ...JSON.parse(r.data) };
    c[r.kind].push(fact);
  }
  for (const c of Object.values(out)) {
    for (const k of SLOT_KINDS) c[k].sort((a, b) => b.n - a.n || DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || a.start.localeCompare(b.start));
    c.event.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || '') || b.n - a.n);
    c.topic.sort((a, b) => a.week - b.week || b.n - a.n);
  }
  return out;
}

// Week by week: what students say (the most-agreed text per week), else the rough draft from the handbook's topic
// list (draftTopics, stored with each course by the importer).
function weekTopics(draft = [], studentTopics = []) {
  const weeks = [];
  for (let w = 1; w <= WEEKS; w++) {
    const said = studentTopics.filter((t) => t.week === w).sort((a, b) => b.n - a.n)[0];
    const rough = draft.filter((d) => d.week === w).map((d) => d.text);
    if (said) weeks.push({ week: w, text: said.text, n: said.n, confirmed: said.confirmed, key: said.key, mine: said.mine, source: 'students' });
    else if (rough.length) weeks.push({ week: w, text: rough.join('; '), source: 'handbook' });
  }
  return weeks;
}

function draftTopics(outline) {
  const text = String(outline || '').replace(/^\s*\d{1,3}\s+(?:DEPARTMENT|SCHOOL)[A-Z ,&]+/, '');
  // only an explicit list ("Topics covered include: a; b; c.") is drafted; a prose outline isn't a weekly plan
  const listed = /(?:topics?|content|syllabus)[^:.]{0,40}:\s*([^]+)/i.exec(text)?.[1];
  if (!listed) return [];
  const parts = listed
    .split(/;\s*|\.\s+|,\s+(?=[A-Z])/)
    .map((s) => s.replace(/^(?:and|the course (?:covers|includes))\s+/i, '').replace(/[.;,]+$/, '').trim())
    .filter((s) => s.length >= 4 && s.length <= 140)
    .slice(0, 12);
  if (parts.length < 2) return [];
  return parts.map((t, i) => ({ week: Math.floor((i * 12) / parts.length) + 1, text: t.charAt(0).toUpperCase() + t.slice(1) }));
}

// Confirmed slots per course, for the week view: { CSC1015F: { lecture: [...], tut: [...], prac: [...] } }
function crowdSlots(grouped) {
  return Object.fromEntries(Object.entries(grouped).map(([code, c]) => [code, Object.fromEntries(SLOT_KINDS.map((k) => [k, c[k]]))]));
}

module.exports = { parseFact, screenFact, groupFacts, weekTopics, draftTopics, crowdSlots, AGREE, EVENT_TYPES, SLOT_KINDS, DAYS, WEEKS };
