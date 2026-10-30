// Second pass over the handbooks, after import-handbook.js has written data/courses-*.json:
// 1. Undergraduate courses that only appear in curriculum tables ("PHI2043S Business Ethics ........ 18 6") and have no
//    description in any handbook. They go to data/courses-tables-2026.json, marked tableOnly.
// 2. Old codes the handbooks say were replaced, to data/replaced-2026.json:
//    "PSY1009F (previously PSY1004F)", "Either MAM1000W or both MAM1031F and MAM1032S", and a table-only code with the
//    same title as a described course in the same department and year (PSY1005S and PSY1010S, both "Introduction to
//    Psychology Part 2").
// Usage: node scripts/import-tables.js <folder with the handbook .txt files>
const fs = require('node:fs');
const path = require('node:path');
const { expandCode } = require('./import-handbook');

const DATA = path.join(__dirname, '..', 'data');
const ROW = /\b([A-Z]{3}\d{4}[A-Z](?:\/[A-Z])*)\*? ([A-Z][^.…*]{2,90}?)\s*\*?\s*[.…]{3,}[\s.…]*(\d{1,3})\b(?: ([5-7])\b)?/g;
const NOT_TAUGHT = /dissertation|thesis|research (essay|report|project)|^course nqf/i;
const PREVIOUSLY = /\b([A-Z]{3}\d{4}[A-Z])\s*\((?:previously|formerly)\s+([A-Z]{3}\d{4}[A-Z](?:\/[A-Z])*)\)/gi;
const TAKEN_BEFORE = /\b([A-Z]{3}\d{4}[A-Z])\b[^()]{0,80}\(or ([A-Z]{3}\d{4}[A-Z]) if taken before \d{4}\)/g;
const EITHER_BOTH =/\bEither \*?([A-Z]{3}\d{4}[A-Z]) or both \*?([A-Z]{3}\d{4}[A-Z]) and \*?([A-Z]{3}\d{4}[A-Z])\b/g;

function scan(texts, described) {
  const tableOnly = new Map();
  const replaced = new Map();
  const replace = (old, by) => { if (!described.has(old) && by.every((c) => described.has(c))) replaced.set(old, by); };
  for (const text of texts) {
    const flat = text.replace(/\s+/g, ' ');
    for (const m of flat.matchAll(PREVIOUSLY)) for (const old of expandCode(m[2])) replace(old, [m[1]]);
    for (const m of flat.matchAll(TAKEN_BEFORE)) replace(m[2], [m[1]]);
    for (const m of flat.matchAll(EITHER_BOTH)) replace(m[1], [m[2], m[3]]);
    for (const m of flat.matchAll(ROW)) {
      // "(a) MUZ1322F (b) MUZ1201H Course NQF Credits African Music I": a broken table row, so the title isn't this code's
      if (/[A-Z]{3}\d{4}[A-Z]|^Course NQF/.test(m[2])) continue;
      const notOffered = /\s*\(Not offered in (\d{4})\)/i.exec(m[2]);
      const title = m[2].replace(/\s*\d*\s*\(Not offered in \d{4}\)/i, '').replace(/\s+(?:or|and)$/i, '').trim();
      for (const code of expandCode(m[1])) {
        if (described.has(code) || tableOnly.has(code) || !/^[1-3]$/.test(code[3]) || NOT_TAUGHT.test(title) || title.length < 4) continue;
        tableOnly.set(code, {
          code, title, credits: Number(m[3]), nqf: m[4] ? Number(m[4]) : Number(code[3]) + 4, conveners: [], tableOnly: true,
          ...(notOffered && { notOffered: Number(notOffered[1]) }),
        });
      }
    }
  }
  // same title, same department and year, different course number: the table lists the old code. Skipped when two
  // described courses share the title (PSY1006F and PSY1009F are both "Introduction to Psychology Part 1").
  const byTitle = new Map();
  for (const c of described.values()) {
    const key = `${c.code.slice(0, 4)}|${c.title.toLowerCase()}`;
    const codes = byTitle.get(key) || new Set();
    byTitle.set(key, codes.add(c.code.slice(0, 7)));
  }
  for (const c of tableOnly.values()) {
    const now = [...(byTitle.get(`${c.code.slice(0, 4)}|${c.title.toLowerCase()}`) || [])];
    const match = now.length === 1 && [...described.keys()].find((k) => k.startsWith(now[0]) && k.slice(0, 7) !== c.code.slice(0, 7));
    if (match && !replaced.has(c.code)) replaced.set(c.code, [match]);
  }
  for (const old of replaced.keys()) tableOnly.delete(old);
  return { tableOnly: [...tableOnly.values()].sort((a, b) => a.code.localeCompare(b.code)), replaced: Object.fromEntries([...replaced].sort()) };
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node scripts/import-tables.js <folder with handbook .txt files>');
    process.exit(1);
  }
  const described = new Map();
  for (const f of fs.readdirSync(DATA).filter((f) => /^courses-.*\.json$/.test(f) && f !== 'courses-tables-2026.json')) {
    for (const c of JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')).courses) described.set(c.code, c);
  }
  const texts = fs.readdirSync(dir).filter((f) => f.endsWith('.txt')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8'));
  const { tableOnly, replaced } = scan(texts, described);
  const source = 'UCT 2026 handbooks, curriculum tables (no course description)';
  fs.writeFileSync(path.join(DATA, 'courses-tables-2026.json'), JSON.stringify({ source, courses: tableOnly }, null, 2) + '\n');
  fs.writeFileSync(path.join(DATA, 'replaced-2026.json'), JSON.stringify({ source: 'UCT 2026 handbooks', replaced }, null, 2) + '\n');
  console.log(`wrote ${tableOnly.length} table-only courses and ${Object.keys(replaced).length} replaced codes`);
}

module.exports = { scan };
