// Reads the majors and programmes out of the 2026 handbooks into data/programmes-2026.json: for each one, the courses
// required in each year of study, with the handbook's choices ("Either MAM1000W or both MAM1031F and MAM1032S",
// "One of: ...", "TWO of the following:"), "Plus 2 approved courses" electives and "Total credits per year".
// Faculty-wide credit rules aren't parsed: they're a handful of numbers, kept in FACULTIES below with the rule they
// come from.
// Usage (after import-handbook.js): node scripts/import-programmes.js <folder with the handbook .txt files>
const fs = require('node:fs');
const path = require('node:path');

const DATA = path.join(__dirname, '..', 'data');

// From the 2026 faculty rules. Readmission minimums are by the end of year 1, 2, 3 of registration.
const FACULTIES = {
  sci: {
    name: 'Science', degrees: ['BSc'], years: 3, totalCredits: 360, seniorCredits: 120, seniorLevel: 7,
    semesterMax: 72, yearMin: 72, readmitCredits: [72, 144, 228],
    rules: 'BSc rules FB3 (at most 72 credits a semester), FB5.1 (re-registration) and FB7 (curriculum)',
  },
  hum: {
    name: 'Humanities', degrees: ['BA', 'BSocSc'], years: 3, totalCredits: 360, seniorCredits: 120, seniorLevel: 7,
    yearRange: [[120, 144], [120, 160], [120, 180]],
    rules: 'the recommended curriculum structure for the general BA and BSocSc',
  },
  com: {
    name: 'Commerce', degrees: ['BCom', 'BBusSci'], years: 3, totalCredits: 440, seniorCredits: 120, seniorLevel: 7,
    readmitCourses: [4, 8, 15],
    rules: 'BCom rules FBE2 (440 credits, 120 at level 7) and FBE3 (re-registration). The four-year BBusSci needs 528 credits (FBB2).',
  },
  ebe: { name: 'Engineering & the Built Environment', degrees: ['BSc(Eng)', 'BAS', 'BSc'], years: 4, rules: 'each programme’s own curriculum' },
  fhs: { name: 'Health Sciences', degrees: ['MBChB', 'BSc(Med)', 'and others'], years: 4, rules: 'each programme’s own curriculum' },
  law: { name: 'Law', degrees: ['LLB'], years: 4, rules: 'the LLB curriculum' },
};

// Names the layout gets wrong, checked by hand against the handbooks. SKIP: general rules pages, not one programme.
const NAME_FIXES = {
  HB027: 'BSocSc in Philosophy, Politics and Economics', SLL06: 'French', SLL08: 'German', SLL20: 'Portuguese',
  CB004BUS28: 'BBusSci Industrial and Organisational Psychology', CB019BUS01: 'BCom Actuarial Science',
  CB019BUS09: 'BCom Actuarial Science, Quantitative Finance', CB003BUS09: 'BBusSci Actuarial Science, Quantitative Finance',
  EB012APG01: 'Bachelor of Architectural Studies (BAS)', MZ010: 'Nelson Mandela Fidel Castro Medical Training Programme',
};
const SKIP = new Set(['HB061', 'HB067']);
// Commerce augmented and extended programmes follow a standard one: CB023 is the augmented CB001, CB011 the extended one
const COMMERCE_VARIANTS = {
  CB023: ['CB001', 'augmented'], CB024: ['CB004', 'augmented'], CB025: ['CB003', 'augmented'], CB026: ['CB019', 'augmented'],
  CB011: ['CB001', 'extended'], CB015: ['CB004', 'extended'], CB018: ['CB003', 'extended'], CB020: ['CB019', 'extended'],
};
const ACRONYMS = new Set(['BA', 'BAS', 'BSC', 'BCOM', 'PPE', 'IT', 'AI', 'NMFC', 'II', 'III']);

const MARKER =/\[((?:[A-Z]{2}\d{3}|[A-Z]{2}\d{2})?[A-Z]{3}\d{2}|[A-Z]{2}\d{3})\]/;
const SECTION = /^(First|Second|Third|Fourth|Final)[- ]Year\b.*\b(courses|modules)\b/i;
const YEAR = { first: 1, second: 2, third: 3, fourth: 4, final: 4 };
const CODE = /\*?\b([A-Z]{3}\d{3}[\dx](?:[FSHWZXLP]{1,2})?(?:\/[A-Z])*)(?![A-Za-z\d])/g;
const COUNT = { one: 1, two: 2, three: 3, four: 4, five: 5 };
// "One of:", "and TWO of the following:", "Any four of the courses below, including one or both of MAM3010F and MAM3011F"
const N_OF = /^(?:and |plus )?(?:any )?(one|two|three|four|five) (?:\(\d\) )?of(?:(?: the following)?(?: courses)?:?$| the courses below\b)/i;

// "CSC1015F/S" -> both; "HST2040SF" (either semester) -> HST2040S and HST2040F
function expand(raw) {
  const [first, ...more] = raw.split('/');
  const m = /^([A-Z]{3}\d{3}[\dx])([A-Z]*)$/.exec(first);
  if (!m) return [];
  const suffixes = m[2].length === 2 && /^[FSHW]{2}$/.test(m[2]) ? [...m[2]] : [m[2] || ''];
  return [...suffixes, ...more].map((s) => m[1] + s);
}

// One line of a curriculum table: a connector word, an electives line, or course codes.
function token(line) {
  const t = line.replace(/[.…]{2,}.*$/, '').replace(/\s+/g, ' ').trim();
  const plain = t.replace(/[:*]+$/g, '').trim().toLowerCase();
  if (!t) return null;
  const total = /^Total credits per year\D*(\d{2,3})/i.exec(line.replace(/[.…]/g, ' '));
  if (total) return { type: 'total', credits: Number(total[1]) };
  if (/^(?:highly )?recommended:?$|^recommended:/i.test(t)) return { type: 'recommended' };
  if (plain === 'or') return { type: 'or' };
  if (plain === 'or both' || plain === 'both') return { type: 'orboth' };
  if (plain === 'either') return { type: 'either' };
  if (plain === 'and' || plain === 'plus' || plain === '&') return { type: 'and' };
  const n = N_OF.exec(plain);
  if (n) return { type: 'nof', n: COUNT[n[1].toLowerCase()] };
  const plus = /^Plus (\d|one|two|three|four) (?:approved |elective )+(?:courses?|modules?)/i.exec(t);
  if (plus) return { type: 'electives', count: COUNT[plus[1].toLowerCase()] || Number(plus[1]), credits: Number(/(\d{2,3})\s*$/.exec(line)?.[1]) || null };
  if (/^Note\b|if taken (in|before)|^\*\s*[^A-Z]|^\*\s*OR\b/i.test(t)) return null;
  const codes = [...t.matchAll(CODE)];
  if (!codes.length || codes[0].index > 12) return null; // a sentence that mentions a code, or a title line
  // codes in one line: "PSY1009F ... and PSY1010S" are both needed, "STA2004F or STA2030S" is a choice
  const parts = [];
  codes.forEach((m, i) => {
    const between = i ? t.slice(codes[i - 1].index + codes[i - 1][0].length, m.index) : '';
    parts.push({ codes: expand(m[1]), alt: i > 0 && /\bor\b/i.test(between) });
  });
  return { type: 'row', parts };
}

// Builds the groups for one year. A group is "pick n of these options"; an option is one or more courses taken together.
function buildYear(tokens, creditsOf) {
  const groups = [];
  const recommended = [];
  const electives = [];
  let pending = null;
  let nof = null;
  let extendable = false;
  let recommending = false;
  let total = null;
  const optionCredits = (opt) => opt.reduce((s, c) => s + (creditsOf(c) || 0), 0);
  const add = (codes) => {
    if (recommending) return void recommended.push(...codes);
    const last = groups[groups.length - 1];
    if ((pending === 'or' || pending === 'orboth') && last) {
      last.options.push(codes);
      extendable = true;
      pending = null;
      return;
    }
    if (pending === 'and' && last) {
      const opt = last.options[last.options.length - 1];
      // "Or both MAM1031F and MAM1032S"; inside "One of:", "STA3047S and STA3048S" if together they weigh as much as the
      // other options (6 + 30 = 36 credits). Otherwise "and" ends the choice and the course is simply required.
      const sameWeight = nof && last === nof && nof.options.length > 1 && optionCredits(opt) + optionCredits(codes) === optionCredits(nof.options[0]);
      if (extendable || sameWeight) {
        opt.push(...codes);
        pending = null;
        return;
      }
      nof = null;
    }
    pending = null;
    extendable = false;
    if (nof) return void nof.options.push(codes);
    groups.push({ pick: 1, options: [codes] });
  };
  for (const tk of tokens) {
    if (tk.type === 'total') total = tk.credits;
    else if (tk.type === 'recommended') recommending = true;
    else if (tk.type === 'electives') electives.push({ count: tk.count, credits: tk.credits });
    else if (tk.type === 'either') { nof = null; extendable = false; pending = null; }
    else if (tk.type === 'nof') { nof = { pick: tk.n, options: [] }; groups.push(nof); pending = null; extendable = false; }
    else if (tk.type === 'row') {
      for (const part of tk.parts) {
        if (part.alt && groups.length && !recommending) {
          for (const c of part.codes) groups[groups.length - 1].options.push([c]);
          continue;
        }
        // "CSC1015F/S" in a table means either semester: one choice, not two courses
        if (part.codes.length > 1 && part.codes.every((c) => c.slice(0, 7) === part.codes[0].slice(0, 7))) {
          add([part.codes[0]]);
          const g = recommending ? null : groups[groups.length - 1];
          if (g) for (const c of part.codes.slice(1)) g.options.push([c]);
        } else add(part.codes);
      }
    } else pending = tk.type;
  }
  // the same option or the same required course listed twice (a table and its footnote) counts once
  const seen = new Set();
  const clean = groups.map((g) => {
    const opts = [...new Map(g.options.map((o) => [o.join('+'), o])).values()];
    return { ...g, options: opts };
  }).filter((g) => {
    const key = g.options.map((o) => o.join('+')).join('|');
    if (!g.options.length || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { groups: clean, recommended: [...new Set(recommended)], electives, total };
}

function parseProgrammes(text, faculty, creditsOf) {
  const lines = text.split(/\r?\n/);
  const found = [];
  lines.forEach((line, i) => {
    const m = MARKER.exec(line);
    if (!m || /\.{5,}/.test(line)) return; // contents pages list every programme with dot leaders
    found.push({ id: m[1], at: i, name: nameFor(lines, i, line, m) });
  });
  const out = [];
  found.forEach((f, k) => {
    const end = Math.min(found[k + 1]?.at ?? lines.length, f.at + 400);
    const block = lines.slice(f.at + 1, end);
    const years = [];
    let cur = null;
    for (const line of block) {
      const s = SECTION.exec(line.trim());
      if (s) {
        cur = { year: YEAR[s[1].toLowerCase()], tokens: [] };
        years.push(cur);
        continue;
      }
      if (/^(Distinction|DEGREES OFFERED|Year \d Suggested Electives)/i.test(line.trim())) cur = null;
      // the table is over once course descriptions or ordinary paragraphs start
      if (cur && (line.length > 160 || /NQF credits at NQF level|^[A-Z]{3}\d{4}[A-Z]{1,2}(?:\/[A-Z])* [A-Z]{3,} [A-Z]{2,}/.test(line.trim()))) {
        cur = null;
        if (years.length) break;
      }
      if (!cur || /^[†‡#]/.test(line.trim())) continue;
      // "Code CSC1015F EEE1008F ..." puts every code of the year on one line: each one is required
      const flat = line.trim().replace(/^Code\s+/, '');
      const tk = token(flat);
      if (tk) cur.tokens.push(tk);
    }
    if (!years.length) return;
    const total = /not less than (\d{3}) credits/i.exec(block.slice(0, 40).join(' '))?.[1];
    // a programme printed twice (e.g. once per stream) keeps its first full table
    const merged = new Map();
    for (const y of years) {
      const built = buildYear(y.tokens, creditsOf);
      if (!built.groups.length && !built.electives.length) continue;
      if (!merged.has(y.year)) merged.set(y.year, { year: y.year, ...built });
    }
    if (!merged.size) return;
    out.push({ id: f.id, faculty, kind: /^[A-Z]{3}\d{2}$/.test(f.id) ? 'major' : 'programme', name: f.name, totalCredits: total ? Number(total) : null, years: [...merged.values()].sort((a, b) => a.year - b.year) });
  });
  return out;
}

// The name sits on the marker's line ("BSc(Engineering)(Electrical Engineering)[EB009EEE01]") or the line(s) above
// ("Major in Statistics & Data Science", "Requirements for a major in History").
function nameFor(lines, i, line, m) {
  const before = line.slice(0, m.index).trim();
  const above = [lines[i - 1], lines[i - 2]].map((x) => (x || '').trim()).find((x) => x && !/^\[|^\d+$/.test(x)) || '';
  const raw = before || above;
  return tidyName(raw
    .replace(/^(?:Requirements for a )?major in /i, '')
    .replace(/^Curriculum leading to the /i, '')
    .replace(/^Bachelor of Commerce specialising in /i, 'BCom ')
    .replace(/^Bachelor of Business Science (?:in |specialising in )?/i, 'BBusSci '));
}

// "BCom Economics with LAW*" -> "BCom Economics with Law"; "STATISTICS AND DATA SCIENCE" -> "Statistics and Data Science"
const SMALL_WORDS = new Set(['and', 'of', 'in', 'with', 'for', 'the', 'as', 'a']);
function tidyName(s) {
  return s
    .replace(/[*†]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w, i) => {
      if (!/^[A-Z][A-Z&,:'’-]+$/.test(w) || ACRONYMS.has(w.toUpperCase())) return w;
      const lower = w.toLowerCase();
      return i > 0 && SMALL_WORDS.has(lower) ? lower : lower.replace(/(^|-)([a-z])/g, (m, a, b) => a + b.toUpperCase());
    })
    .join(' ')
    .replace(/^./, (c) => c.toUpperCase());
}

// After reading every programme: hand fixes, names for augmented and extended variants, and tidier years.
function finish(list) {
  const byId = new Map(list.map((p) => [p.id, p]));
  // Humanities students can take Science majors (MAM02, STA02, CSC05...). The Science handbook's table is the
  // department's own and parses more cleanly, so it's used for both faculties.
  const science = new Map(list.filter((p) => p.faculty === 'sci').map((p) => [p.id, p]));
  return list.filter((p) => !SKIP.has(p.id)).map((p) => (p.faculty !== 'sci' && science.has(p.id) ? { ...p, years: science.get(p.id).years } : p)).map((p) => {
    let name = NAME_FIXES[p.id] || p.name;
    let variant = null;
    const cb = COMMERCE_VARIANTS[p.id.slice(0, 5)];
    if (cb) {
      const standard = byId.get(cb[0] + p.id.slice(5));
      variant = cb[1];
      name = `${standard ? NAME_FIXES[standard.id] || standard.name : name.replace(/^.*?(?:Programmes )?Bachelor of (?:Commerce|Business Science) (?:in )?/, '')} (${variant})`;
    } else if (/^EB8\d\d/.test(p.id)) {
      variant = 'extended';
      name = `${name.replace(/\s*\d-year curriculum$/i, '')} (5-year)`;
    }
    // a course already required in an earlier year isn't required again; choices don't list first-year courses in year 3
    const earlier = new Set();
    const years = p.years.map((y) => {
      const groups = y.groups
        .map((g) => ({ ...g, options: g.options.filter((o) => !(o.length === 1 && earlier.has(o[0])) && !(g.options.length > 1 && o.every((c) => Number(c[3]) < y.year - 1))) }))
        .filter((g) => g.options.length >= g.pick);
      for (const g of groups) if (g.options.length === 1) g.options[0].forEach((c) => earlier.add(c));
      return { ...y, groups };
    });
    return { ...p, name, ...(variant && { variant }), years };
  });
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node scripts/import-programmes.js <folder with handbook .txt files>');
    process.exit(1);
  }
  const credits = new Map();
  for (const f of fs.readdirSync(DATA).filter((f) => /^courses-.*\.json$/.test(f))) {
    for (const c of JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')).courses) if (!credits.has(c.code)) credits.set(c.code, c.credits);
  }
  const creditsOf = (code) => credits.get(code) ?? credits.get(code.replace(/x/, '0'));
  const HANDBOOKS = { sci: 'sci-handbook-11', hum: 'hum-handbook-9a', com: 'commerce-handbook-6a', ebe: 'ebe-handbook-7a', fhs: 'fhs-handbook-8a', law: 'law-handbook-10' };
  const programmes = [];
  const seen = new Set();
  for (const [faculty, name] of Object.entries(HANDBOOKS)) {
    const file = fs.readdirSync(dir).find((f) => f.includes(name) && f.endsWith('.txt'));
    if (!file) continue;
    for (const p of parseProgrammes(fs.readFileSync(path.join(dir, file), 'utf8'), faculty, creditsOf)) {
      if (seen.has(`${faculty}|${p.id}`)) continue;
      seen.add(`${faculty}|${p.id}`);
      programmes.push(p);
    }
  }
  const out = { source: 'UCT 2026 undergraduate handbooks, downloaded 30 Oct 2026', faculties: FACULTIES, programmes: finish(programmes) };
  fs.writeFileSync(path.join(DATA, 'programmes-2026.json'), JSON.stringify(out, null, 1) + '\n');
  const by = programmes.reduce((m, p) => ({ ...m, [p.faculty]: (m[p.faculty] || 0) + 1 }), {});
  console.log(`wrote ${programmes.length} majors and programmes`, by);
}

module.exports = { parseProgrammes, buildYear, token, expand, finish, tidyName, FACULTIES };
