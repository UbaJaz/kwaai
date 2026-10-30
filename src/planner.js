// The semester planner's checks. Everything here is worked out from the handbook details stored with each course
// (semester, lecture period, entry requirements, assessment) plus students' workload ratings.
const { codesIn } = require('../scripts/import-handbook');
const { semesterLoad } = require('./ratings');

// Old codes the 2026 handbooks say were replaced, e.g. MAM1000W -> MAM1031F + MAM1032S (scripts/import-tables.js)
const REPLACED = require('../data/replaced-2026.json').replaced;
// Majors, programmes and faculty credit rules (scripts/import-programmes.js). Keys look like "sci:STA13": the same
// major code can appear in two faculties.
const { faculties: FACULTIES, programmes: PROGRAMME_LIST } = require('../data/programmes-2026.json');
const PROGRAMMES = new Map(PROGRAMME_LIST.map((p) => [`${p.faculty}:${p.id}`, p]));

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
// Courses an entry requirement mentions, minus the one being registered for: "students with 70% for MAM1010F may
// register for MAM2010F" names MAM2010F as the course, not a requirement.
const entryRefs = (entry) => [...new Set(codesIn(String(entry || '').replace(/register for [A-Z]{3}\d{4}[A-Z](?:\/[A-Z])*/g, '')))];
// passed: courses the student has already passed. Those count as met, and if none of the courses an entry
// requirement mentions are passed or planned in time, the course is flagged (only when we know what was passed).
function entryChecks(list, passed = new Set()) {
  const out = {};
  const passedBases = new Set([...passed].map(base));
  for (const c of list) {
    const sentences = String(c.entry || '').split(/\.\s+|;\s*/);
    const refs = entryRefs(c.entry).filter((r) => base(r) !== base(c.code));
    const together = new Set(sentences.filter((s) => CONCURRENT.test(s)).flatMap(codesIn).map(base));
    const inPlan = [];
    const tooLate = [];
    const met = [];
    for (const r of [...new Set(refs.map(base))]) {
      if (passedBases.has(r)) {
        met.push([...passed].find((p) => base(p) === r));
        continue;
      }
      const planned = list.filter((x) => base(x.code) === r);
      if (!planned.length) continue;
      const inTime = (p) => !p.terms.length || !c.terms.length || (together.has(r)
        ? ORDER[p.terms[0]] <= ORDER[c.terms[c.terms.length - 1]]
        : ORDER[p.terms[p.terms.length - 1]] < ORDER[c.terms[0]]);
      const first = planned.find(inTime);
      if (first) inPlan.push(first.code);
      else tooLate.push(planned[0].code);
    }
    const noneMet = passed.size > 0 && refs.length > 0 && !met.length && !inPlan.length && !tooLate.length;
    out[c.code] = { refs, inPlan, tooLate, met, noneMet };
  }
  return out;
}

// courses: rows from the courses table plus review averages (n, difficulty, workload) and vote counts.
// passed: codes the student says they've passed.
function analysePlan(courses, passed = new Set()) {
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
  const entry = entryChecks(list, passed);
  const twice = list.filter((c, i) => list.findIndex((x) => base(x.code) === base(c.code)) !== i).map((c) => [list.find((x) => base(x.code) === base(c.code)).code, c.code]);
  const passedBases = new Set([...passed].map(base));
  const alreadyPassed = list.filter((c) => passedBases.has(base(c.code))).map((c) => c.code);
  return { terms, other: list.filter((c) => !c.terms.length), entry, twice, notOffered: list.filter((c) => c.not_offered), alreadyPassed };
}

// ---- about you: faculty, majors, year of study, courses passed ----

const CODE = /^[A-Z]{3}\d{4}[A-Z]$/;
const codeList = (s, max) => [...new Set([s].flat().join(',').toUpperCase().split(/[\s,]+/).filter((x) => CODE.test(x)))].slice(0, max);
const PASSED_MAX = 80;

// From the query string: f=sci, m=sci:STA13,sci:CSC05, y=2, done=CSC1015F,MAM1031F
function parseProfile(q = {}) {
  const majors = [...new Set(String([q.m ?? ''].flat().join(',')).split(',').map((x) => x.trim()).filter((k) => PROGRAMMES.has(k)))].slice(0, 2);
  const faculty = FACULTIES[q.f] ? q.f : majors.length ? PROGRAMMES.get(majors[0]).faculty : '';
  const year = Number(q.y);
  return { faculty, majors, year: Number.isInteger(year) && year >= 1 && year <= 5 ? year : null, done: codeList(q.done ?? '', PASSED_MAX) };
}
const hasProfile = (p) => Boolean(p.faculty || p.majors.length || p.year || p.done.length);
function profileParams(p) {
  return Object.fromEntries(Object.entries({ f: p.faculty, m: p.majors.join(','), y: p.year ?? '', done: p.done.join(',') }).filter(([, v]) => v !== ''));
}

// "STA100xF" in a major's table means any course STA1000F to STA1009F
const matchesCode = (pattern, code) => (pattern.includes('x') ? new RegExp(`^${pattern.replace(/x/g, '\\d')}$`).test(code) : pattern === code);
const anyMatch = (codes, pattern) => codes.some((c) => matchesCode(pattern, c));

// What each chosen major still needs up to the student's year: each group with its options marked passed / planned / to do.
function majorNeeds(profile, planned) {
  const passed = profile.done;
  const upTo = profile.year || 1;
  return profile.majors.map((key) => {
    const p = PROGRAMMES.get(key);
    const years = p.years.filter((y) => y.year <= Math.min(upTo, 4)).map((y) => {
      const groups = y.groups.map((g) => {
        const options = g.options.map((codes) => {
          const state = codes.every((c) => anyMatch(passed, c)) ? 'passed' : codes.every((c) => anyMatch(passed, c) || anyMatch(planned, c)) ? 'planned' : 'todo';
          return { codes, state };
        });
        const have = options.filter((o) => o.state !== 'todo').length;
        return { pick: g.pick, options, done: have >= g.pick, passed: options.filter((o) => o.state === 'passed').length >= g.pick };
      });
      return { year: y.year, groups, electives: y.electives, total: y.total, recommended: y.recommended };
    });
    const open = years.flatMap((y) => y.groups.filter((g) => !g.done).map((g) => ({ ...g, year: y.year })));
    return { key, id: p.id, name: p.name, faculty: p.faculty, kind: p.kind, variant: p.variant, totalCredits: p.totalCredits, years, open };
  });
}

// Credit advice: this year's load against the programme's credits for the year or the faculty's rules, the Science
// cap of 72 credits a semester, re-registration minimums, and progress to the degree total.
// planned and passed are course rows ({ code, credits, nqf }); plan is analysePlan's result.
function creditAdvice(profile, plan, planned, passed, needs) {
  const programme = needs.find((n) => n.kind === 'programme') || needs[0];
  const base = FACULTIES[profile.faculty];
  if (!base) return null;
  // the BBusSci has its own totals and re-registration rules inside Commerce
  const fac = { ...base, ...(programme && base.byPrefix?.[programme.id.slice(0, 5)]) };
  const sum = (rows) => rows.reduce((s, c) => s + (c.credits || 0), 0);
  const year = profile.year || 1;
  const plannedCredits = sum(planned);
  const passedCredits = sum(passed);
  const programmeYear = programme && PROGRAMMES.get(programme.key).years.find((y) => y.year === year);
  // the year's target: the programme's own "Total credits per year", else the faculty's guidance
  let target = null;
  if (programmeYear?.total) target = { min: programmeYear.total, max: programmeYear.total, from: `${programme.name}, year ${year} in the handbook` };
  else if (fac.yearRange?.[year - 1]) target = { min: fac.yearRange[year - 1][0], max: fac.yearRange[year - 1][1], from: `the ${fac.name} faculty's recommended load for year ${year}` };
  else if (fac.semesterMax) target = { min: fac.yearMin, max: fac.semesterMax * 2, from: `${fac.name} rules: at least ${fac.yearMin} credits a year to re-register, at most ${fac.semesterMax} a semester` };
  const load = !plannedCredits || !target ? null : plannedCredits < target.min * 0.9 ? 'under' : plannedCredits > target.max * 1.1 ? 'over' : 'ok';
  const semesters = fac.semesterMax ? plan.terms.map((t) => ({ label: t.label, credits: t.credits, over: t.credits > fac.semesterMax })) : [];
  const level = (c) => c.nqf || Number(c.code[3]) + 4;
  const total = programme?.totalCredits || fac.totalCredits || null;
  const senior = fac.seniorCredits ? sum([...passed, ...planned].filter((c) => level(c) >= fac.seniorLevel)) : null;
  // re-registration: Science counts credits, Commerce counts semester courses (a year course counts as two)
  let readmit = null;
  if (fac.readmitCredits?.[year - 1]) readmit = { need: fac.readmitCredits[year - 1], have: passedCredits + plannedCredits, unit: 'credits' };
  else if (fac.readmitCourses?.[year - 1]) {
    const courses = (rows) => rows.reduce((s, c) => s + (/[WH]$/.test(c.code) ? 2 : 1), 0);
    readmit = { need: fac.readmitCourses[year - 1], have: courses(passed) + courses(planned), unit: 'semester courses' };
  }
  return { faculty: fac, year, plannedCredits, passedCredits, target, load, semesters, total, senior, readmit };
}

// For a course the student might add: which courses its entry requirements mention, and which of those they've passed.
function entryStatus(entry, passed) {
  const refs = entryRefs(entry);
  const passedBases = new Set(passed.map(base));
  return { refs, met: refs.filter((r) => passedBases.has(base(r))) };
}

const facultyOptions = () => Object.entries(FACULTIES).map(([key, f]) => ({ key, name: f.name }));
// majors and programmes for the picker, grouped by faculty, standard programmes before extended and augmented ones
function programmeOptions() {
  return facultyOptions().map((f) => ({
    ...f,
    items: PROGRAMME_LIST.filter((p) => p.faculty === f.key)
      .sort((a, b) => Boolean(a.variant) - Boolean(b.variant) || a.name.localeCompare(b.name))
      .map((p) => ({ key: `${p.faculty}:${p.id}`, name: p.name, kind: p.kind })),
  })).filter((f) => f.items.length);
}

module.exports = {
  analysePlan, termsOf, fitTimetable, ordinal, TERMS, REPLACED, FACULTIES, PROGRAMMES,
  parseProfile, hasProfile, profileParams, majorNeeds, creditAdvice, matchesCode, programmeOptions, facultyOptions, entryStatus,
};
