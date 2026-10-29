// Turns a UCT faculty handbook into data/courses-<name>.json.
// Usage: pdftotext -enc UTF-8 handbook.pdf handbook.txt
//        node scripts/import-handbook.js handbook.txt ebe-2026 "2026 EBE undergraduate handbook"
const fs = require('node:fs');
const path = require('node:path');

function parseHandbook(text) {
  const flat = text.replace(/\s+/g, ' ');
  // Course descriptions look like: "MEC2047F ENGINEERING DYNAMICS 16 NQF credits at NQF level 6 Convener: Professor M Ngoepe Course outline: ..."
  const re = /\b([A-Z]{3}\d{4}[A-Z])\s+([A-Z][A-Z0-9 ,&:()'\-\/]+?)\s+(\d+)\s+NQF credits at NQF level (\d+)\s*(?:Convener:\s*(.+?)\s*)?(?=Course outline|Course entry|Co-requisites|Objective)/g;
  const courses = new Map();
  for (const m of flat.matchAll(re)) {
    if (courses.has(m[1])) continue;
    courses.set(m[1], {
      code: m[1],
      title: titleCase(m[2].trim()),
      credits: Number(m[3]),
      nqf: Number(m[4]),
      conveners: splitConveners(m[5] || ''),
    });
  }
  return [...courses.values()].sort((a, b) => a.code.localeCompare(b.code));
}

function splitConveners(s) {
  return s
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
      // roman numerals and part letters: "II", "1A", "IB", trailing "A"
      if (/^(i|ii|iii|iv|v|vi|\d+[a-z]|i{1,3}[ab])$/.test(w) || (i === all.length - 1 && /^[ab]$/.test(w))) return w.toUpperCase();
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
