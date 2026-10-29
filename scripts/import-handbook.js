// Turns a UCT faculty handbook into data/courses-<name>.json.
// Usage: pdftotext -enc UTF-8 handbook.pdf handbook.txt
//        node scripts/import-handbook.js handbook.txt ebe-2026 "2026 EBE undergraduate handbook"
const fs = require('node:fs');
const path = require('node:path');

// Course descriptions look like:
//   "MEC2047F ENGINEERING DYNAMICS 16 NQF credits at NQF level 6 Convener: Professor M Ngoepe Course outline: ..."
// Some faculties put a note between the title and the credits, so find the UPPERCASE heading first,
// then look for credits and convener in the text before the next heading.
const WORD = "[A-Z0-9][A-Z0-9,&:()'’\\-\\/–.]*";
const HEADING = new RegExp(`\\b([A-Z]{3}\\d{4}[A-Z]) ((?:${WORD} )*?${WORD})(?= (?:\\+ )?\\d+ NQF credits| [A-Z][a-z])`, 'g');
const NOT_A_COURSE = /thesis|dissertation|departments in the faculty|research (paper|report|project)$/i;

function parseHandbook(text) {
  const flat = text.replace(/\s+/g, ' ');
  const heads = [...flat.matchAll(HEADING)];
  const courses = new Map();
  heads.forEach((m, i) => {
    const after = flat.slice(m.index + m[0].length, Math.min(heads[i + 1]?.index ?? flat.length, m.index + 4000));
    const credits = /^.{0,600}?(\d+) NQF credits at NQF level (\d+)/.exec(after);
    if (!credits || courses.has(m[1]) || NOT_A_COURSE.test(m[2])) return;
    const convener = /Conveners?:\s*(.+?)(?=\s*(?:Course outline|Course entry|Entry requirements|Co-requisites|Prerequisites|Objective|Lecture times|DP requirements|Assessment))/.exec(after);
    courses.set(m[1], {
      code: m[1],
      // drop a page number/header or a "NOTE:" glued on the end
      title: titleCase(m[2].replace(/ (NOTES?|NB):( \d\))?$/, '').replace(/(,? SCHOOL OF)? \d{2,3}$/, '').trim()),
      credits: Number(credits[1]),
      nqf: Number(credits[2]),
      conveners: splitConveners(convener?.[1] || ''),
    });
  });
  return [...courses.values()].sort((a, b) => a.code.localeCompare(b.code));
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

module.exports = { parseHandbook, splitConveners, titleCase };
