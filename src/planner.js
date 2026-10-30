// The semester planner's checks. Everything here is worked out from the handbook details stored with each course
// (semester, lecture period, entry requirements, assessment) plus students' workload ratings.
const { codesIn } = require('../scripts/import-handbook');
const { semesterLoad } = require('./ratings');

// Old codes the 2026 handbooks say were replaced, e.g. MAM1000W -> MAM1031F + MAM1032S (scripts/import-tables.js)
const REPLACED = require('../data/replaced-2026.json').replaced;

const TERMS = [
  { key: 's1', label: 'Semester 1', when: 'February to June' },
  { key: 's2', label: 'Semester 2', when: 'July to November' },
];
const ORDER = { s1: 1, s2: 2 };

// UCT's last letter says when a course runs: F = first semester, S = second, W and H = the whole year.
// Anything else (summer and winter terms, Z for unusual dates) has no fixed semester.
function termsOf(code) {
  const s = code.slice(-1);
  if (s === 'F') return ['s1'];
  if (s === 'S') return ['s2'];
  if (s === 'W' || s === 'H') return ['s1', 's2'];
  return [];
}

const base = (code) => code.slice(0, 7); // CSC1015F and CSC1015S are the same course in different semesters
const ordinal = (n) => `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`;

// Lecture options for one course. "4th or 5th period" means you're in one group: two options.
// "1st and 2nd period" means both: one option covering two periods.
function lectureOptions(c) {
  if (!c.periodList.length) return null;
  return c.period_choice ? c.periodList.map((p) => [p]) : [c.periodList];
}
const clash = (a, aOpt, b, bOpt) => aOpt.some((p) => bOpt.includes(p)) && a.dayList.some((d) => b.dayList.includes(d));

// Finds every way to pick lecture groups so nothing overlaps (at most a few thousand for a full plan).
function fitTimetable(list) {
  const timed = list.map((c) => ({ c, options: lectureOptions(c) })).filter((x) => x.options);
  const valid = [];
  const walk = (i, picked) => {
    if (i === timed.length) return void valid.push([...picked]);
    for (const opt of timed[i].options) {
      if (picked.every((p, j) => !clash(timed[j].c, p, timed[i].c, opt))) {
        picked.push(opt);
        walk(i + 1, picked);
        picked.pop();
      }
    }
  };
  walk(0, []);
  const untimed = list.filter((c) => !lectureOptions(c)).map((c) => c.code);
  if (valid.length) {
    // a course with groups where only some of them fit: tell the student which group to pick
    const picks = timed.flatMap(({ c, options }, i) => {
      const usable = options.filter((o) => valid.some((v) => v[i] === o));
      return options.length > 1 && usable.length < options.length ? [{ code: c.code, periods: usable.flat() }] : [];
    });
    return { fits: true, picks, clashes: [], timed: timed.length, untimed };
  }
  // no way to fit them all: report the pairs that can never both fit, or the whole group if it's a three-way squeeze
  const clashes = [];
  timed.forEach((a, i) => timed.slice(i + 1).forEach((b) => {
    if (a.options.every((x) => b.options.every((y) => clash(a.c, x, b.c, y)))) clashes.push({ a: a.c.code, b: b.c.code, periods: [...new Set(a.options.flat().filter((p) => b.options.flat().includes(p)))] });
  }));
  return { fits: false, picks: [], clashes, squeezed: clashes.length ? [] : timed.map((x) => x.c.code), timed: timed.length, untimed };
}

// Entry requirements, checked against the order of the plan. Handbook rules are full of "or" and percentages, so this
// only flags what's certain from the plan itself: a course listed as an entry requirement that comes in the same or
// a later semester. A sentence like "must have been passed or be taken concurrently" allows the same semester.
// Everything else is shown as the handbook wrote it.
const CONCURRENT = /concurrent|co-?requisite|simultaneous|at the same time|same semester/i;
function entryChecks(list) {
  const out = {};
  for (const c of list) {
    const sentences = String(c.entry || '').split(/\.\s+|;\s*/);
    const refs = codesIn(c.entry).filter((r) => base(r) !== base(c.code));
    const together = new Set(sentences.filter((s) => CONCURRENT.test(s)).flatMap(codesIn).map(base));
    const inPlan = [];
    const tooLate = [];
    for (const r of [...new Set(refs.map(base))]) {
      const planned = list.filter((x) => base(x.code) === r);
      if (!planned.length) continue;
      const inTime = (p) => !p.terms.length || !c.terms.length || (together.has(r)
        ? ORDER[p.terms[0]] <= ORDER[c.terms[c.terms.length - 1]]
        : ORDER[p.terms[p.terms.length - 1]] < ORDER[c.terms[0]]);
      const first = planned.find(inTime);
      if (first) inPlan.push(first.code);
      else tooLate.push(planned[0].code);
    }
    out[c.code] = { refs, inPlan, tooLate };
  }
  return out;
}

// courses: rows from the courses table plus review averages (n, difficulty, workload) and vote counts.
function analysePlan(courses) {
  const list = courses.map((c) => ({
    ...c,
    terms: termsOf(c.code),
    periodList: c.periods ? String(c.periods).split('|').map(Number) : [],
    dayList: c.days ? c.days.split('|') : [],
  }));
  const terms = TERMS.map((t) => {
    const inTerm = list.filter((c) => c.terms.includes(t.key));
    // a year course is half of each semester's work
    const share = (c) => (c.credits || 0) / c.terms.length;
    const withExam = inTerm.filter((c) => c.exam_weight != null && c.credits);
    const examShare = withExam.length
      ? Math.round(withExam.reduce((s, c) => s + c.exam_weight * share(c), 0) / withExam.reduce((s, c) => s + share(c), 0))
      : null;
    return {
      ...t,
      courses: inTerm,
      credits: Math.round(inTerm.reduce((s, c) => s + share(c), 0)),
      load: semesterLoad(inTerm.map((c) => ({ ...c, credits: share(c) }))),
      examShare,
      examKnown: withExam.length,
      timetable: fitTimetable(inTerm),
    };
  });
  const entry = entryChecks(list);
  const twice = list.filter((c, i) => list.findIndex((x) => base(x.code) === base(c.code)) !== i).map((c) => [list.find((x) => base(x.code) === base(c.code)).code, c.code]);
  return { terms, other: list.filter((c) => !c.terms.length), entry, twice, notOffered: list.filter((c) => c.not_offered) };
}

module.exports = { analysePlan, termsOf, fitTimetable, ordinal, TERMS, REPLACED };
