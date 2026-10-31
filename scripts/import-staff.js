// Teaching staff from each department's staff list in the 2026 handbooks, e.g.
//   "Professors: R Deane, MSc Cape Town DPhil Oxford P A Woudt, MSc Groningen PhD Cape Town Senior Lecturers: ..."
// The handbook doesn't say who teaches which course (only the convener), so staff are linked to a department, which
// is where students pick "who taught you" when they review a course. Emeritus, honorary, adjunct, research and
// support staff are left out.
// Usage (after import-handbook.js): node scripts/import-staff.js <folder with the handbook .txt files>
const fs = require('node:fs');
const path = require('node:path');

const { DEPARTMENTS } = require('./seed');

const DATA = path.join(__dirname, '..', 'data');
// role labels as the handbooks write them; the role ends at the next "Something:" label
// "Senior Lecturers: F Adams, ..." (Science, Law) or "Associate Professors S Hull, ..." (EBE, no colon). The word
// before the role rules out "Emeritus Professors", "Adjunct Senior Lecturer" and the like.
const ROLE = /(?:(\S+)\s)?\b(Associate Professors?|Senior Lecturers?|Professors?|Lecturers?):?\s(?=\*?(?:[A-Z]\.?\s?){1,4}[A-Z]?[a-z]*[A-Za-z'’-]*,)/g;
const NOT_TEACHING = /^(Emeritus|Emerita|Honorary|Adjunct|Visiting|Extraordinary|Research|Retired|Part-time|Hon|Distinguished)$/i;
// any staff label, teaching or not, ends the list before it
const ANY_LABEL = /\b(?:(?:Emeritus|Emerita|Honorary|Adjunct|Visiting|Extraordinary|Research|Part-time)\s)?(?:Associate Professors?|Senior Lecturers?|Professors?|Lecturers?|[A-Z][a-z]+ (?:Officers?|Assistants?|Managers?|Staff|Fellows?|Scientists?|Associates?|Affiliates?|Co-ordinators?|Coordinators?|Administrators?|Secretary|Technicians?))\b:?\s/g;
// "P A Woudt, MSc ..." / "M. Vaccari, ..." / "HE Delport, ..." / "A. L. Campbell, ..." / "S van der Merwe, ..." /
// "K. Ramesh Kanjee, ..." / "*J Franco, ..." (Law marks some staff with a star). The qualifications run to the next name.
// Initials are one or two letters ("BAS", "UCT" and "LSE" are degrees and universities), and a surname has lowercase
// letters ("SL Gabriel", not "UJ SL Gabriel").
const PERSON = "\\*?(?:[A-Z]{1,2}\\.?\\s)(?:[A-Z]\\.?\\s){0,3}(?:(?:de|du|van|von|der|den|le|la|da|dos|el|al|ten|ter)\\s){0,3}[A-Z][a-z'’][a-zA-Z'’-]*(?:[ -][A-Z][a-z][a-zA-Z'’-]+)?";
const NAME = new RegExp(`(?<=^|\\s)(${PERSON}),\\s*([^,]*?)(?=\\s${PERSON},|$)`, 'g');
const HEADING = /\b([A-Z]{3})\d{4}[A-Z](?:\/[A-Z])* [A-Z]{3,}/g;

function title(role, quals) {
  if (/^associate professor/i.test(role)) return 'Associate Professor';
  if (/^professor/i.test(role)) return 'Professor';
  return /\b(PhD|DPhil|DSc|MD|DLitt|LLD|DEng|DBA|DCom|DEd)\b/.test(quals) ? 'Dr' : '';
}

// staff lists sit at the top of each department's section; the courses that follow say which department it is
// An uppercase section heading like "DEPARTMENT OF PUBLIC LAW" just before a staff list wins over the courses that
// follow: the Law handbook lists all three departments' staff before any of their courses.
// deptNames: { CML: 'Commercial Law', ... }
function parseStaff(text, deptNames = {}) {
  const flat = text.replace(/\s+/g, ' ');
  const heads = [...flat.matchAll(HEADING)].map((m) => ({ at: m.index, dept: m[1] }));
  const byName = new Map(Object.entries(deptNames).map(([code, name]) => [name.toUpperCase(), code]));
  const sections = [...flat.matchAll(/DEPARTMENT OF ([A-Z][A-Z &,'’-]+?)(?= [A-Z][a-z]| \d|$)/g)]
    .map((m) => ({ at: m.index, dept: byName.get(m[1].trim()) })).filter((s) => s.dept);
  const ends = [...flat.matchAll(ANY_LABEL)].map((m) => m.index + (m[0].startsWith(' ') ? 1 : 0));
  const out = [];
  for (const m of flat.matchAll(ROLE)) {
    if (m[1] && NOT_TEACHING.test(m[1])) continue;
    const role = m[2];
    const start = m.index + m[0].length;
    const end = Math.min(ends.find((e) => e >= start) ?? Infinity, start + 2500);
    const body = flat.slice(start, end);
    const next = heads.filter((h) => h.at > m.index).slice(0, 12);
    if (!next.length || next[0].at - m.index > 30000) continue; // not a department section
    const counts = next.reduce((acc, h) => acc.set(h.dept, (acc.get(h.dept) || 0) + 1), new Map());
    const section = sections.filter((s) => s.at < m.index && m.index - s.at < 8000).pop();
    const dept = section?.dept || [...counts].sort((a, b) => b[1] - a[1])[0][0];
    for (const n of body.matchAll(NAME)) {
      const t = title(role, n[2]);
      out.push({ dept, name: `${t ? t + ' ' : ''}${n[1].replace(/[.*]/g, '').replace(/\s+/g, ' ').trim()}`, role: role.replace(/s$/, '') });
    }
  }
  return out;
}

// "Dr H Wiggins" and "H Wiggins" are the same person
const bareName = (name) => name.replace(/^(?:Emeritus |Adjunct )?(?:Associate Professor|A\/Prof|Professor|Prof|Doctor|Dr|Mr|Ms|Mrs)\.?\s+/i, '').replace(/\./g, '').replace(/\s+/g, ' ').trim().toLowerCase();

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node scripts/import-staff.js <folder with handbook .txt files>');
    process.exit(1);
  }
  const files = fs.readdirSync(dir).filter((f) => /^2026-.*\.txt$/.test(f) && !/-[6-9]b-/.test(f)); // undergraduate handbooks
  const seen = new Map();
  for (const f of files) {
    // only Law needs the section headings; elsewhere a nearby "DEPARTMENT OF ..." can belong to the section before
    for (const s of parseStaff(fs.readFileSync(path.join(dir, f), 'utf8'), f.includes('law-handbook') ? DEPARTMENTS : {})) {
      const key = `${s.dept}|${bareName(s.name)}`;
      if (!seen.has(key)) seen.set(key, s);
    }
  }
  const staff = [...seen.values()].sort((a, b) => a.dept.localeCompare(b.dept) || a.name.localeCompare(b.name));
  fs.writeFileSync(path.join(DATA, 'staff-2026.json'), JSON.stringify({ source: 'UCT 2026 undergraduate handbooks, department staff lists', staff }, null, 1) + '\n');
  console.log(`wrote ${staff.length} teaching staff in ${new Set(staff.map((s) => s.dept)).size} departments`);
}

module.exports = { parseStaff, bareName };
