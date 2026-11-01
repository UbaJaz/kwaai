// The week view: a student's plan turned into a Monday-to-Friday timetable (lectures, tutorials, practicals, their own
// blocks and suggested study time), and the same week as a calendar file for each semester's dates.
// Lecture periods and tut/prac options come from the 2026 handbooks; anything the handbook doesn't say is left for the
// student to place, never guessed.
const crypto = require('node:crypto');
const { termsOf, fitTimetable } = require('./planner');
const { PERIOD_START } = require('../scripts/import-handbook');
const TERMS = require('../data/terms.json');

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
const KIND_KEY = { lecture: 'L', tut: 'T', prac: 'P' };
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const toTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const periodEnd = (start) => toTime(toMin(start) + 45); // a period is 45 minutes from the hour

// ---- the week's settings, kept in the plan's link and cookie ----
// t=s1|s2 (semester), pk=CSC1015F.L5,CEM1000W.P1 (chosen lecture period / tut or prac option),
// bl=0~1400~1600~Gym (own blocks: day index, start, end, label), st=1 (show suggested study time)
const PICK = /^([A-Z]{3}\d{4}[A-Z])\.([LTP])(\d{1,2})$/;
const BLOCK = /^([0-4])~(\d{4})~(\d{4})~([A-Za-z0-9 &'.:-]{0,30})$/;
const MAX_BLOCKS = 20;
function parseWeek(q = {}) {
  const picks = {};
  for (const p of String(q.pk || '').split(',').slice(0, 60)) {
    const m = PICK.exec(p.trim());
    if (m) picks[`${m[1]}.${m[2]}`] = Number(m[3]);
  }
  const blocks = String(q.bl || '').split(',').map((b) => BLOCK.exec(b.trim())).filter(Boolean)
    .map((m) => ({ day: DAYS[Number(m[1])], start: `${m[2].slice(0, 2)}:${m[2].slice(2)}`, end: `${m[3].slice(0, 2)}:${m[3].slice(2)}`, label: m[4].trim() }))
    .filter((b) => validSpan(b.start, b.end))
    .slice(0, MAX_BLOCKS);
  return { t: q.t === 's1' || q.t === 's2' ? q.t : '', picks, blocks, study: q.st === '1' };
}
const validSpan = (start, end) => /^([01]\d|2[0-3]):[0-5]\d$/.test(start) && /^([01]\d|2[0-3]):[0-5]\d$/.test(end) && toMin(end) > toMin(start) && toMin(end) - toMin(start) <= 8 * 60;
const blockParam = (b) => `${DAYS.indexOf(b.day)}~${b.start.replace(':', '')}~${b.end.replace(':', '')}~${b.label}`;
function weekParams(w) {
  return Object.fromEntries(Object.entries({
    t: w.t,
    pk: Object.entries(w.picks).map(([k, v]) => `${k}${v}`).join(','),
    bl: w.blocks.map(blockParam).join(','),
    st: w.study ? '1' : '',
  }).filter(([, v]) => v));
}

// ---- term dates ----
// From November the planner is about next year; before that, this year.
function planYear(now = new Date()) {
  const want = now.getMonth() >= 9 ? now.getFullYear() + 1 : now.getFullYear();
  const years = Object.keys(TERMS.years).map(Number).sort();
  return years.includes(want) ? want : years[years.length - 1];
}
const termDates = (year, term) => TERMS.years[year]?.[term];
// teaching weeks in a semester: its span minus its breaks
function semesterWeeks(year, term) {
  const t = termDates(year, term);
  if (!t) return 16;
  const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 86_400_000 + 1;
  return Math.round((days(t.start, t.end) - t.breaks.reduce((s, [a, b]) => s + days(a, b), 0)) / 7);
}

// ---- building the week ----
// courses: rows with code, title, credits, periods ('4|5'), days, period_choice, sessions (JSON), workload (review average)
function buildWeek(courses, week, { year = planYear() } = {}) {
  const term = week.t || (courses.some((c) => termsOf(c.code).includes('s1')) || !courses.length ? 's1' : 's2');
  const inTerm = courses.filter((c) => termsOf(c.code).includes(term));
  const events = [];
  const unplaced = [];
  const choices = [];

  // lectures: the student's chosen group, else a group that doesn't clash (fitTimetable), else the first one
  const asList = inTerm.map((c) => {
    const periodList = c.periods ? String(c.periods).split('|').map(Number) : [];
    const chosen = week.picks[`${c.code}.L`];
    const fixed = c.period_choice && periodList.includes(chosen);
    return { ...c, periodList: fixed ? [chosen] : periodList, period_choice: fixed ? 0 : c.period_choice, dayList: c.days ? c.days.split('|') : DAYS, allPeriods: periodList };
  });
  const fit = fitTimetable(asList);
  for (const c of asList) {
    if (!c.periodList.length) {
      unplaced.push({ code: c.code, kind: 'lecture', text: c.lectures || "The handbook doesn't give lecture times." });
      continue;
    }
    const suggested = fit.picks.find((p) => p.code === c.code)?.periods;
    const periods = c.period_choice ? [suggested?.[0] ?? c.periodList[0]] : c.periodList;
    if (c.allPeriods.length > 1 && (c.period_choice || week.picks[`${c.code}.L`] != null)) {
      choices.push({ code: c.code, kind: 'lecture', key: 'L', options: c.allPeriods.map((p) => ({ value: p, label: `${PERIOD_START[p]} (${p === 0 ? 'meridian' : `period ${p}`})` })), chosen: periods[0], picked: week.picks[`${c.code}.L`] != null });
    }
    for (const p of periods) for (const day of c.dayList) events.push(event(c, 'lecture', day, PERIOD_START[p], periodEnd(PERIOD_START[p]), 'handbook'));
  }

  // own blocks first, so suggested tut and prac groups avoid them
  for (const b of week.blocks) {
    const course = inTerm.find((c) => b.label.toUpperCase().startsWith(c.code));
    events.push({ day: b.day, start: b.start, end: b.end, kind: course ? 'set' : 'own', code: course?.code || '', title: course ? course.title : b.label, label: b.label, source: 'you' });
  }

  // tutorials and practicals: fixed ones go straight in; with a choice, the student's pick, else the first option
  // that doesn't clash, shown as a suggestion; with no times, the student places it
  for (const c of inTerm) {
    let sessions = [];
    try { sessions = c.sessions ? JSON.parse(c.sessions) : []; } catch { sessions = []; }
    for (const s of sessions) {
      const key = KIND_KEY[s.kind];
      if (!s.options.length) {
        if (!events.some((e) => e.code === c.code && e.kind === 'set' && e.label.toLowerCase().includes(s.kind))) unplaced.push({ code: c.code, kind: s.kind, text: s.text });
        continue;
      }
      if (!s.choice) {
        for (const o of s.options) events.push(event(c, s.kind, o.day, o.start, o.end, 'handbook'));
        continue;
      }
      const picked = week.picks[`${c.code}.${key}`];
      const idx = s.options[picked] ? picked : s.options.findIndex((o) => !events.some((e) => overlaps(e, o)));
      const use = idx >= 0 ? idx : 0;
      choices.push({ code: c.code, kind: s.kind, key, options: s.options.map((o, i) => ({ value: i, label: `${o.day.slice(0, 3)} ${o.start}–${o.end}` })), chosen: use, picked: s.options[picked] != null });
      events.push({ ...event(c, s.kind, s.options[use].day, s.options[use].start, s.options[use].end, 'handbook'), suggested: s.options[picked] == null });
    }
  }

  const clashes = [];
  for (const day of DAYS) {
    const today = events.filter((e) => e.day === day);
    today.forEach((a, i) => today.slice(i + 1).forEach((b) => { if (overlaps(a, b)) clashes.push([a, b]); }));
  }

  // hours: an NQF credit is 10 hours of work, spread over the semester's weeks; a year course is half per semester
  const weeks = semesterWeeks(year, term);
  const share = (c) => (c.credits || 0) / (termsOf(c.code).length || 1);
  const contact = (code) => events.filter((e) => e.code === code && e.kind !== 'own').reduce((s, e) => s + (toMin(e.end) - toMin(e.start)) / 60, 0);
  const perCourse = inTerm.map((c) => {
    const total = (share(c) * 10) / weeks;
    const own = Math.max(0, total - contact(c.code));
    // students' workload rating (1 to 5) nudges it: a 5/5 course gets more of the study time than a 2/5 one
    const nudge = c.workload ? Math.min(1.4, Math.max(0.7, c.workload / 3)) : 1;
    return { code: c.code, title: c.title, total, contact: contact(c.code), study: Math.round(own * nudge) };
  });
  const hours = { weeks, total: Math.round(perCourse.reduce((s, x) => s + x.total, 0)), contact: Math.round(perCourse.reduce((s, x) => s + x.contact, 0)), perCourse };
  const study = week.study ? placeStudy(events, perCourse) : { events: [], left: 0 };

  return { year, term, dates: termDates(year, term), courses: inTerm, events: [...events, ...study.events], unplaced, choices, clashes, hours, studyLeft: study.left };
}

function event(c, kind, day, start, end, source) {
  return { day, start, end, kind, code: c.code, title: c.title, source };
}
const overlaps = (a, b) => a.day === b.day && toMin(a.start) < toMin(b.end) && toMin(b.start) < toMin(a.end);

// Study time in free hours between 08:00 and 17:00, at most two hours of one course a day, courses with the most
// left to place first. Whatever doesn't fit is reported as evening or weekend time.
function placeStudy(events, perCourse) {
  const need = new Map(perCourse.filter((p) => p.study > 0).map((p) => [p.code, p.study]));
  const placed = [];
  const perDay = new Map();
  for (const day of DAYS) {
    for (let h = 8; h < 17; h++) {
      const slot = { day, start: toTime(h * 60), end: toTime(h * 60 + 60) };
      if (events.some((e) => overlaps(e, slot)) || ![...need.values()].some((n) => n > 0)) continue;
      const next = [...need.entries()].filter(([code, n]) => n > 0 && (perDay.get(`${day}|${code}`) || 0) < 2).sort((a, b) => b[1] - a[1])[0];
      if (!next) continue;
      const [code] = next;
      need.set(code, need.get(code) - 1);
      perDay.set(`${day}|${code}`, (perDay.get(`${day}|${code}`) || 0) + 1);
      placed.push({ ...slot, kind: 'study', code, title: perCourse.find((p) => p.code === code).title, source: 'suggested' });
    }
  }
  return { events: placed, left: [...need.values()].reduce((s, n) => s + n, 0) };
}

// ---- calendar file (RFC 5545) ----
// Both semesters, weekly from the first teaching day to the end of the term, with the vacations left out. South
// Africa has no daylight saving, so local times are written as UTC (two hours earlier).
const pad = (n) => String(n).padStart(2, '0');
const utc = (date, time) => {
  const d = new Date(`${date}T${time}:00+02:00`);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00Z`;
};
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const escapeText = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// lines longer than 75 bytes continue on the next line after a space
function fold(line) {
  const out = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch) > (out.length ? 74 : 75)) { out.push(cur); cur = ''; }
    cur += ch;
  }
  out.push(cur);
  return out.join('\r\n ');
}
const KIND_NAME = { lecture: 'lecture', tut: 'tutorial', prac: 'practical', set: '', own: '', study: 'study' };
function icsFor(courses, week, { year = planYear(), origin = '' } = {}) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Kwaai//Week planner//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:Kwaai ${year}`, 'X-WR-TIMEZONE:Africa/Johannesburg'];
  const stamp = utc(new Date().toISOString().slice(0, 10), '00:00');
  for (const term of ['s1', 's2']) {
    const dates = termDates(year, term);
    if (!dates) continue;
    const w = buildWeek(courses, { ...week, t: term }, { year });
    for (const e of w.events) {
      if (e.kind === 'study' && !week.study) continue;
      // first teaching day on that weekday, then weekly; vacation days are skipped
      const offset = (DAYS.indexOf(e.day) - (new Date(`${dates.start}T00:00:00Z`).getUTCDay() + 6) % 7 + 7) % 7;
      const first = addDays(dates.start, offset);
      const skip = [];
      for (const [a, b] of dates.breaks) for (let d = first; d <= dates.end; d = addDays(d, 7)) if (d >= a && d <= b) skip.push(utc(d, e.start));
      const name = e.kind === 'own' ? e.label : e.kind === 'set' ? e.label : `${e.code} ${KIND_NAME[e.kind]}`;
      const uid = crypto.createHash('sha1').update([year, term, e.code, e.kind, e.day, e.start, e.label || ''].join('|')).digest('hex').slice(0, 20);
      lines.push('BEGIN:VEVENT', `UID:${uid}@kwaai`, `DTSTAMP:${stamp}`, `DTSTART:${utc(first, e.start)}`, `DTEND:${utc(first, e.end)}`,
        `RRULE:FREQ=WEEKLY;UNTIL=${utc(dates.end, '23:59')}`, ...(skip.length ? [`EXDATE:${skip.join(',')}`] : []),
        `SUMMARY:${escapeText(e.kind === 'study' ? `Study: ${e.code}` : name)}`,
        `DESCRIPTION:${escapeText(`${e.title || ''}${e.suggested ? ' (suggested group: pick yours in Kwaai)' : ''}\nFrom ${e.source === 'handbook' ? "UCT's 2026 handbook" : e.source === 'you' ? 'your Kwaai week' : 'Kwaai'}. Check your official timetable.${origin ? `\n${origin}/week` : ''}`)}`,
        'END:VEVENT');
    }
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

module.exports = { parseWeek, weekParams, buildWeek, icsFor, planYear, termDates, semesterWeeks, DAYS, toMin, TERMS };
