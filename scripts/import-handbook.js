// Turns a UCT faculty handbook into data/courses-<name>.json.
// Usage: pdftotext -enc UTF-8 handbook.pdf handbook.txt
//        node scripts/import-handbook.js handbook.txt ebe-2026 "2026 EBE undergraduate handbook"
const fs = require('node:fs');
const path = require('node:path');

// Course descriptions look like:
//   "MEC2047F ENGINEERING DYNAMICS 16 NQF credits at NQF level 6 Convener: Professor M Ngoepe Course outline: ..."
// Some faculties put a note between the title and the credits, so find the UPPERCASE heading first,
// then look for credits and convener in the text before the next heading.
// Courses that run in more than one semester are written "CSC1015F/S": that's two courses, CSC1015F and CSC1015S.
// Title words are UPPERCASE and may hold brackets, "C++", "A+:", "CITIZENS?:" or accents ("NÉGRITUDE"). "&", "-" and "–"
// can stand on their own: "MATTER & INTERACTIONS", "LANGUAGE – MEANING". The title ends where ordinary text starts:
// "Five lectures", "A student cannot...", "X courses:", "(offered during winter term)", "[Note:", "APG2021F/S versions".
// A course code is never a title word, so "MAM4000W MAM4001W APPLIED MATHEMATICS HONOURS" finds the MAM4001W heading.
const WORD = "(?:(?![A-Z]{3}\\d{4}[A-Z]\\b)\\(?[A-Z0-9À-Þ][A-Z0-9À-Þ,&:()'’+?\\-\\/–.]*|&|-|–)";
const HEADING = new RegExp(`\\b([A-Z]{3}\\d{4}[A-Z](?:\\/[A-Z])*) ((?:${WORD} )*?${WORD})(?= (?:\\+ )?\\d+ (?:NQF )?credits| [A-Z][a-z]| [A-Z] [a-z]| \\([A-Za-z][a-z]| \\[| (?:NB|NOTE): [a-z]| [A-Z]{3}\\d{4}[A-Z](?:\\/[A-Z])* [a-z])`, 'g');
const NOT_A_COURSE = /thesis|dissertation|research (paper|report|project)$/i;
// a running page header caught inside a heading: "STRUCTURAL DESIGN II DEPARTMENTS IN THE FACULTY AND COURSES OFFERED 114"
// or "INFORMATION & COMMUNICATION TECHNOLOGIES 180 DEPARTMENT OF INFORMATION SYSTEMS"
const HEADER_IN_TITLE = /\s*(?:DEPARTMENTS IN (?:THE|OTHER) FACULT(?:Y|IES)(?: AND COURSES OFFERED)?(?: \d+)?|\d{2,3} (?:DEPARTMENT|SCHOOL|GRADUATE SCHOOL|FACULTY)\b.*)$/;
const NOT_OFFERED = /\bnot (?:on )?offered in (\d{4})/i;
const CODES = /\b([A-Z]{3}\d{4})([A-Z](?:\/[A-Z])*)/g;

// The labelled parts of a course description, roughly in the order the handbooks use them.
const LABELS = ['Course entry requirements', 'Entry requirements', 'Prerequisites', 'Co-requisites', 'Course outline', 'Objective', 'Lecture times', 'DP requirements', 'Assessment'];
const LABEL = new RegExp(`(?:${LABELS.join('|')}):`, 'g');
// a running page header glued into the text, like "96 DEPARTMENTS IN THE FACULTY" or "166 SCHOOL OF ECONOMICS"
const PAGE_HEADER = /\s+(?:\d{1,3} [A-Z][A-Z&,'’ ]{5,}(?=\s|$)|(?:First|Second|Third|Fourth|Final)[- ]Year Courses|(?:Postgraduate|Undergraduate|Honours) Courses).*$/;

function parseHandbook(text) {
  const flat = text.replace(/\s+/g, ' ');
  const heads = [...flat.matchAll(HEADING)];
  const courses = new Map();
  heads.forEach((m, i) => {
    // "STA1000F INTRODUCTORY STATISTICS ... STA1000S INTRODUCTORY STATISTICS ... STA1000P/L ... 18 NQF credits ...":
    // headings for the same course in a row share the description under the last one.
    let end = i + 1;
    while (heads[end] && heads[end][1].slice(0, 7) === m[1].slice(0, 7)) end++;
    const own = flat.slice(m.index + m[0].length, Math.min(heads[i + 1]?.index ?? flat.length, m.index + 6000));
    const shared = end > i + 1 && !/NQF credits/.test(own) ? flat.slice(m.index + m[0].length, Math.min(heads[end]?.index ?? flat.length, m.index + 8000)) : own;
    const after = shared.replace(/^.*?(?=\b\d+ (?:NQF )?credits at)/, (lead) => (lead.length > 600 ? lead.slice(-600) : lead));
    const credits = /^.{0,600}?(\d+) (?:NQF )?credits at NQF level (\d+)/.exec(after);
    const rawTitle = m[2].replace(HEADER_IN_TITLE, '');
    // a title with a code in it, or with no real word ("CB004/ CB024", "IT"), is a table row
    if (!credits || !/[A-ZÀ-Þ]{3}/.test(rawTitle) || NOT_A_COURSE.test(rawTitle) || /[A-Z]{3}\d{4}/.test(rawTitle)) return;
    // "(Not offered in 2026)" sits in the title or in the note before the credits
    const notOffered = NOT_OFFERED.exec(rawTitle + ' ' + after.slice(0, credits.index + credits[0].length));
    const convener = /Conveners?:\s*(.+?)(?=\s*(?:Course outline|Course entry|Entry requirements|Co-requisites|Prerequisites|Objective|Lecture times|DP requirements|Assessment))/.exec(after);
    const parts = sections(after);
    const lectures = clip(parts['Lecture times'], 240);
    const assessment = clip(parts.Assessment, 500);
    const details = {
      outline: clip(parts['Course outline'] || parts.Objective, 600),
      entry: clip(parts['Course entry requirements'] || parts['Entry requirements'] || parts.Prerequisites, 400),
      corequisites: clip(parts['Co-requisites'], 200),
      lectures,
      ...lecturePeriods(lectures),
      sessions: sessionsOf(String(parts['Lecture times'] || '').replace(PAGE_HEADER, '').slice(0, 600)),
      dp: clip(parts['DP requirements'], 400),
      assessment,
      examWeight: examWeight(assessment),
    };
    for (const code of expandCode(m[1])) {
      if (courses.has(code)) continue;
      courses.set(code, {
        code,
        // drop a page number/header or a "NOTE:" glued on the end
        title: titleCase(rawTitle.replace(/ \(NOT (?:ON )?OFFERED IN \d{4}\)/, '').replace(/ (NOTES?|NB):( \d\))?$/, '').replace(/(,? SCHOOL OF)? \d{2,3}$/, '').trim()),
        credits: Number(credits[1]),
        nqf: Number(credits[2]),
        conveners: splitConveners(convener?.[1] || ''),
        ...details,
        ...(notOffered && { notOffered: Number(notOffered[1]) }),
      });
    }
  });
  return [...courses.values()].sort((a, b) => a.code.localeCompare(b.code));
}

// "CSC1015F/S" -> ["CSC1015F", "CSC1015S"]
function expandCode(s) {
  const [first, ...more] = s.split('/');
  return [first, ...more.map((x) => first.slice(0, -1) + x)];
}

// every course code mentioned in a piece of text, with "F/S" expanded
function codesIn(s) {
  return [...new Set([...String(s || '').matchAll(CODES)].flatMap((m) => expandCode(m[1] + m[2])))];
}

function sections(text) {
  const marks = [...text.matchAll(LABEL)];
  const out = {};
  marks.forEach((m, i) => {
    const name = m[0].slice(0, -1);
    if (!(name in out)) out[name] = text.slice(m.index + m[0].length, marks[i + 1]?.index ?? text.length).trim();
  });
  return out;
}

// Keep a section readable: cut a glued page header, then cut at a sentence end near the limit.
function clip(s, max) {
  if (!s) return '';
  const t = s.replace(PAGE_HEADER, '').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = cut.lastIndexOf('. ');
  return end > max / 2 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '…';
}

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
// "Monday - Friday, 2nd period" -> { periods: [2], periodChoice: false, days: all five }
// "4th or 5th period daily" -> { periods: [4, 5], periodChoice: true }: students are put in one of the groups
function lecturePeriods(lectures) {
  const lect = String(lectures || '').split(/Tutorials?|Practicals?|Workshops?|Seminars?|Labs?\b/i)[0];
  const group = /((?:\d(?:st|nd|rd|th)\s*(?:,|or|and|&|\/)?\s*)+)periods?\b/i.exec(lect);
  const meridian = /\bmeridian\b/i.test(lect); // the lunch slot, 13:00 to 14:00, stored as period 0
  if (!group && !meridian) return { periods: [], periodChoice: false, days: [] };
  const periods = [...new Set([...(group?.[1] ?? '').matchAll(/(\d)(?:st|nd|rd|th)/g)].map((x) => Number(x[1])).concat(meridian ? [0] : []))];
  const choice = periods.length > 1 && /\bor\b/i.test(group && !meridian ? group[1] : lect);
  const days = /daily|every day/i.test(lect) ? DAYS : daysIn(lect);
  return { periods, periodChoice: choice, days: days.length ? days : DAYS };
}

// "Monday to Wednesday and Friday" -> Monday, Tuesday, Wednesday, Friday: a range plus any other named days.
// "Tuesdays, Fridays and some Wednesdays": the occasional day doesn't make a weekly clash.
function daysIn(text) {
  const day = (d) => DAYS.findIndex((x) => x.slice(0, 3).toLowerCase() === d.slice(0, 3).toLowerCase());
  const range = /\b(Mon|Tue|Wed|Thu|Fri)\w*\s*(?:-|–|to)\s*(Mon|Tue|Wed|Thu|Fri)\w*/i.exec(text);
  const inRange = range ? DAYS.slice(day(range[1]), day(range[2]) + 1) : [];
  return DAYS.filter((d) => inRange.includes(d) || new RegExp(`(?<!some )\\b${d.slice(0, 3)}`, 'i').test(text));
}

// Tutorials and practicals from the "Lecture times" text, for the week view:
//   "Tutorials: Thursday 2nd or 4th period. Practicals: Tuesday, Thursday or Friday, 14h00 - 17h00."
//   -> [{ kind: 'tut', count: 1, choice: true, options: [{ day: 'Thursday', start: '10:00', end: '10:45' }, ...] },
//       { kind: 'prac', count: 1, choice: true, options: [{ day: 'Tuesday', start: '14:00', end: '17:00' }, ...] }]
// "Tutorials: One per week" with no day or time gives a session with no options: the student places it themselves.
// A period is 45 minutes from the hour (1st period 08:00, meridian 13:00).
const SESSION_LABEL = /\b(Tutorials?|Tuts?|Practicals?|Pracs?|Laborator(?:y|ies)|Labs?|Workshops?|Seminars?)\b\s*(?:sessions?)?\s*:?/gi;
const PERIOD_START = { 0: '13:00', 1: '08:00', 2: '09:00', 3: '10:00', 4: '11:00', 5: '12:00', 6: '14:00', 7: '15:00', 8: '16:00', 9: '17:00' };
const COUNT_WORDS = { one: 1, once: 1, two: 2, twice: 2, three: 3, four: 4 };
const pad = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
function sessionsOf(text) {
  const marks = [...String(text || '').matchAll(SESSION_LABEL)];
  const out = [];
  marks.forEach((m, i) => {
    const seg = text.slice(m.index + m[0].length, marks[i + 1]?.index ?? text.length).split(/\.\s|Lecture/)[0];
    const kind = /^(Prac|Lab)/i.test(m[1]) ? 'prac' : 'tut';
    const days = /\bdaily\b/i.test(seg) ? DAYS : daysIn(seg);
    // times: "14h00 - 17h00" / "14:00-16:00", or periods ("2nd or 4th period")
    const times = [...seg.matchAll(/\b(\d{1,2})[h:](\d{2})\s*(?:-|–|to)?\s*(\d{1,2})[h:](\d{2})/g)].map((t) => ({ start: pad(t[1], t[2]), end: pad(t[3], t[4]) }));
    if (!times.length) {
      const group = /((?:\d(?:st|nd|rd|th)\s*(?:,|or|and|&|\/)?\s*)+)periods?\b/i.exec(seg);
      for (const p of [...(group?.[1] ?? '').matchAll(/(\d)(?:st|nd|rd|th)/g)].map((x) => Number(x[1]))) {
        if (PERIOD_START[p]) times.push({ start: PERIOD_START[p], end: `${PERIOD_START[p].slice(0, 2)}:45` });
      }
      if (/\bmeridian\b/i.test(seg)) times.push({ start: '13:00', end: '13:45' });
    }
    const n = /\b(one|once|two|twice|three|four|\d)\b\s*(?:\w+\s){0,2}?(?:per|a|each)\s+week/i.exec(seg);
    const choice = /\bor\b/i.test(seg) || times.length > 1;
    const options = days.length && times.length ? days.flatMap((day) => times.map((t) => ({ day, ...t }))) : [];
    out.push({
      kind,
      count: n ? COUNT_WORDS[n[1].toLowerCase()] || Number(n[1]) : choice || !options.length ? 1 : options.length,
      choice: choice && options.length > 1,
      options,
      text: seg.trim().replace(/[,;\s]+$/, '').slice(0, 160),
    });
  });
  // "Tutorials: ... Tutorials: ..." twice in one text is the same session
  return out.filter((s, i) => out.findIndex((x) => x.kind === s.kind) === i);
}

// The share of the final mark that comes from exams, e.g. "Class mark 40%, June examination 2 hours 60%" -> 60.
// Each part of the list is read on its own, using the % that follows the word "exam". Subminima, supplementary
// exams and breakdowns in brackets like "Exam 50% (67% written examination; 33% computer examination)" don't count.
// It's a rough guide, so pages show the handbook's own wording next to it.
const SITTING = /\b(June|July|October|November)\b/i;
function examWeight(assessment) {
  const picks = [];
  const text = String(assessment || '').replace(/\bSub-?minim.*$/is, '').replace(/\(([^()]*)\)/g, (all, inner) => (/exam/i.test(inner) && /%/.test(inner) ? ' ' : all));
  for (const part of text.split(/[;,]|\.(?!\d)/)) {
    const at = part.search(/exam/i);
    if (at < 0 || /sub-?minim|at least|minimum|must obtain|pass mark|coursework exam|supplementary/i.test(part)) continue;
    const pcts = [...part.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)].filter((x) => Number(x[1]) > 0 && Number(x[1]) <= 100);
    const pick = pcts.find((x) => x.index > at) || pcts[pcts.length - 1];
    if (pick) picks.push({ pct: Math.round(Number(pick[1])), sitting: SITTING.exec(part)?.[1].toLowerCase().slice(0, 3) });
  }
  if (!picks.length) return null;
  // add up exams in different sittings (June and November); otherwise a total is often followed by its breakdown
  const sittings = new Map(picks.filter((p) => p.sitting).map((p) => [p.sitting === 'jul' ? 'jun' : p.sitting === 'oct' ? 'nov' : p.sitting, p.pct]));
  const best = Math.max(...picks.map((p) => p.pct));
  return sittings.size > 1 ? Math.min(100, Math.max(best, [...sittings.values()].reduce((s, x) => s + x, 0))) : best;
}

function splitConveners(s) {
  return s
    .replace(/\s+(\d+|[A-Z]{4,})\b.*$/, '') // cut off running page headers like "166 SCHOOL OF ECONOMICS"
    .replace(/^Doctor\b/, 'Dr')
    .split(/\s*(?:,| and |&|\/)\s*/)
    .map((x) => x.replace(/\s*\(.*?\)/g, '').trim()) // drop notes like "(Semester 2)"
    .filter((x) => !/to be advised/i.test(x))
    .filter((x) => /^(Prof(essor)?|Associate Professor|A\/Prof|Dr|Mr|Ms|Mrs)?\s*[A-Z]/.test(x) && x.length > 3 && x.length < 60);
}

const SMALL = new Set(['and', 'of', 'for', 'in', 'the', 'to', 'a', 'an', 'on', 'with', '&']);
function titleCase(s) {
  return s
    .toLowerCase()
    .split(' ')
    .map((w, i, all) => {
      // roman numerals and part letters: "II", "1A", "IB", and "A"/"B" at the end or before a small word ("Physics A for Engineers")
      if (/^(i|ii|iii|iv|v|vi|\d+[a-z]|i{1,3}[ab]|\(\d[a-z]{1,3}\))$/.test(w) || (/^[ab]$/.test(w) && (i === all.length - 1 || SMALL.has(all[i + 1])))) return w.toUpperCase();
      if (i > 0 && SMALL.has(w)) return w;
      return w.replace(/^[a-z(]/, (c) => c.toUpperCase()).replace(/-([a-z])/g, (_, c) => '-' + c.toUpperCase());
    })
    .join(' ')
    .replace(/:\s*([a-z])/g, (_, c) => ': ' + c.toUpperCase());
}

if (require.main === module) {
  const [txtPath, name, sourceLabel] = process.argv.slice(2);
  if (!txtPath || !name || !sourceLabel) {
    console.error('usage: node scripts/import-handbook.js <handbook.txt> <name> "<source label>"');
    process.exit(1);
  }
  const courses = parseHandbook(fs.readFileSync(txtPath, 'utf8'));
  const out = path.join(__dirname, '..', 'data', `courses-${name}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ source: sourceLabel, courses }, null, 2) + '\n');
  console.log(`wrote ${courses.length} courses to ${out}`);
}

module.exports = { HEADING, parseHandbook, splitConveners, titleCase, expandCode, codesIn, lecturePeriods, examWeight, sessionsOf, PERIOD_START };
