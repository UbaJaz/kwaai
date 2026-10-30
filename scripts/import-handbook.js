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
const WORD = "[A-Z0-9][A-Z0-9,&:()'’\\-\\/–.]*";
const HEADING = new RegExp(`\\b([A-Z]{3}\\d{4}[A-Z](?:\\/[A-Z])*) ((?:${WORD} )*?${WORD})(?= (?:\\+ )?\\d+ NQF credits| [A-Z][a-z]| \\([A-Z][a-z]| [A-Z]{3}\\d{4}[A-Z] [a-z])`, 'g');
const NOT_A_COURSE = /thesis|dissertation|departments in the faculty|research (paper|report|project)$/i;
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
    const after = shared.replace(/^.*?(?=\b\d+ NQF credits)/, (lead) => (lead.length > 600 ? lead.slice(-600) : lead));
    const credits = /^.{0,600}?(\d+) NQF credits at NQF level (\d+)/.exec(after);
    if (!credits || NOT_A_COURSE.test(m[2]) || /[A-Z]{3}\d{4}/.test(m[2])) return; // a title with a code in it is a table row
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
      dp: clip(parts['DP requirements'], 400),
      assessment,
      examWeight: examWeight(assessment),
    };
    for (const code of expandCode(m[1])) {
      if (courses.has(code)) continue;
      courses.set(code, {
        code,
        // drop a page number/header or a "NOTE:" glued on the end
        title: titleCase(m[2].replace(/ (NOTES?|NB):( \d\))?$/, '').replace(/(,? SCHOOL OF)? \d{2,3}$/, '').trim()),
        credits: Number(credits[1]),
        nqf: Number(credits[2]),
        conveners: splitConveners(convener?.[1] || ''),
        ...details,
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
  if (!group) return { periods: [], periodChoice: false, days: [] };
  const periods = [...new Set([...group[1].matchAll(/(\d)(?:st|nd|rd|th)/g)].map((x) => Number(x[1])))];
  const day = (d) => DAYS.findIndex((x) => x.slice(0, 3).toLowerCase() === d.slice(0, 3).toLowerCase());
  const range = /\b(Mon|Tue|Wed|Thu|Fri)\w*\s*(?:-|–|to)\s*(Mon|Tue|Wed|Thu|Fri)\w*/i.exec(lect);
  let days;
  if (/daily|every day/i.test(lect)) days = DAYS;
  else if (range) days = DAYS.slice(day(range[1]), day(range[2]) + 1);
  else days = DAYS.filter((d) => new RegExp(`\\b${d.slice(0, 3)}`, 'i').test(lect));
  return { periods, periodChoice: periods.length > 1 && /\bor\b/i.test(group[1]), days: days.length ? days : DAYS };
}

// The share of the final mark that comes from exams, e.g. "Class mark 40%, June examination 2 hours 60%" -> 60.
// Each part of the list is read on its own, using the % that follows the word "exam". Subminima and supplementary
// exams don't count. It's a rough guide (a year course with two exams shows the bigger one), so pages show the
// handbook's own wording next to it.
function examWeight(assessment) {
  let best = null;
  for (const part of String(assessment || '').split(/[;,]|\.(?!\d)/)) {
    const at = part.search(/exam/i);
    if (at < 0 || /sub-?minim|at least|minimum|must obtain|pass mark|coursework exam|supplementary/i.test(part)) continue;
    const pcts = [...part.matchAll(/(\d{1,3}(?:\.\d+)?)\s*%/g)].filter((x) => Number(x[1]) > 0 && Number(x[1]) <= 100);
    const pick = pcts.find((x) => x.index > at) || pcts[pcts.length - 1];
    if (pick) best = Math.max(best ?? 0, Math.round(Number(pick[1])));
  }
  return best;
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
      if (/^(i|ii|iii|iv|v|vi|\d+[a-z]|i{1,3}[ab])$/.test(w) || (/^[ab]$/.test(w) && (i === all.length - 1 || SMALL.has(all[i + 1])))) return w.toUpperCase();
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

module.exports = { parseHandbook, splitConveners, titleCase, expandCode, codesIn, lecturePeriods, examWeight };
