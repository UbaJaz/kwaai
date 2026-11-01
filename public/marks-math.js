// Marks maths for the marks and DP tracker. Runs in the browser (window.KwaaiMarks) and in Node (require), so the
// page, its no-JavaScript fallback and the tests all use the same sums. Marks never leave the student's device:
// this file only does arithmetic.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KwaaiMarks = factory();
}(typeof self !== 'undefined' ? self : this, () => {
  const round1 = (n) => Math.round(n * 10) / 10;
  // "one 3-hour examination in June counts for" -> "Examination"; "June examination 2 hours" -> "June examination";
  // "Two-hour written examination" -> "Written examination"
  const clean = (s) => s
    .trim()
    .replace(/\s*\d+(?:\.\d+)?\s*hours?\s*$/i, '')
    .replace(/\b(?:\d+(?:\.\d+)?|one|two|three|four)[- ](?:hours?|minutes?)\b/gi, '')
    .replace(/^\s*(?:hours?|minutes?)\b/i, '')
    .replace(/\s*\b(?:counts?|counting|contributes|will be|is worth)\b.*$/i, '')
    .replace(/\s+(?:written|in (?:June|July|October|November|the)|at the end)\b.*$/i, '')
    .replace(/\s+(?:of|worth|is|are|weighted|for)\s*$/i, '')
    .replace(/^(?:(?:and|plus|a|an|one|the|\d+\s*x)\s+)+/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s:=,–-]+$/, '')
    .trim();

  // "Class record 30% and a 3-hour exam counting 70%" -> [{ name: 'Class record', weight: 30 }, { name: 'Exam', weight: 70, exam: true }]
  // Returns [] when the parts don't add up to about 100%, so the student starts from an honest blank, not a guess.
  function parseAssessment(text, examWeight) {
    const body = String(text || '').replace(/\bSub-?minim.*$/is, '').replace(/\(([^()]*)\)/g, (all, inner) => (/%/.test(inner) ? ' ' : all));
    const items = [];
    for (const m of body.matchAll(/([A-Za-z][A-Za-z0-9 ,&/'-]{2,60}?)\s*(?:counts?|counting|of|:|=|-|–|worth|weighted at)?\s*(\d{1,3}(?:\.\d+)?)\s*%/g)) {
      const name = clean(m[1].split(/[;.]|\band\b(?=[^;.]*$)/).pop());
      const weight = Number(m[2]);
      if (name.length < 3 || weight <= 0 || weight > 100 || /sub-?minim|at least|minimum|pass|DP\b/i.test(name)) continue;
      items.push({ name: name.charAt(0).toUpperCase() + name.slice(1), weight, exam: /exam/i.test(name) && !/class|coursework|semester mark|continuous/i.test(name) });
    }
    const total = items.reduce((s, i) => s + i.weight, 0);
    if (items.length >= 2 && Math.abs(total - 100) <= 1) return items;
    // the handbook's exam share alone still gives a two-part split
    if (examWeight != null && examWeight > 0 && examWeight < 100) return [{ name: 'Class mark', weight: 100 - examWeight, exam: false }, { name: 'Final exam', weight: examWeight, exam: true }];
    return [];
  }

  // "a subminimum of 40% for the final examination" / "Subminima of 40% are required in practical and theory examination"
  function examSubminimum(text) {
    const m = /sub-?minim\w*\s*(?:of\s*)?(\d{1,3})\s*%[^.;]{0,60}?exam/i.exec(String(text || '')) || /(\d{1,3})\s*%\s*sub-?minim\w*[^.;]{0,40}?exam/i.exec(String(text || ''));
    return m ? Number(m[1]) : null;
  }

  // "Class record of at least 35%" / "an average of 30% in marked class work" / "minimum of 40% for class tests"
  function dpMinimum(text) {
    const t = String(text || '');
    const m = /(?:class (?:record|mark|work)|year mark|coursework|course mark|average(?: mark)?)[^.;%]{0,40}?(?:at least|minimum(?: of)?|of)\s*(\d{1,3})\s*%/i.exec(t)
      || /(?:at least|minimum(?: of)?|average of)\s*(\d{1,3})\s*%\s*(?:for|in|on)\s*(?:the\s*)?(?:class|course|year|marked|tests|coursework)/i.exec(t);
    return m ? Number(m[1]) : null;
  }

  // items: [{ name, weight, exam }], marks: same order, a number or '' for not yet known.
  // Unmarked class work is assumed to go like the marked work so far (said on the page).
  function compute(items, marks, { examSub = null, dpMin = null, targets = [50, 60, 70, 75] } = {}) {
    const classItems = items.map((it, i) => ({ ...it, mark: marks[i] })).filter((it) => !it.exam);
    const examItems = items.map((it, i) => ({ ...it, mark: marks[i] })).filter((it) => it.exam);
    const classWeight = classItems.reduce((s, i) => s + i.weight, 0);
    const examWeight = examItems.reduce((s, i) => s + i.weight, 0);
    const known = classItems.filter((i) => i.mark !== '' && i.mark != null && !Number.isNaN(Number(i.mark)));
    const knownWeight = known.reduce((s, i) => s + i.weight, 0);
    const classSoFar = knownWeight ? known.reduce((s, i) => s + Number(i.mark) * i.weight, 0) / knownWeight : null;
    const out = { classWeight, examWeight, classSoFar: classSoFar == null ? null : round1(classSoFar), markedShare: classWeight ? round1((knownWeight / classWeight) * 100) : 0, examSub, dpMin };
    out.dp = dpMin == null || classSoFar == null ? null : classSoFar >= dpMin ? 'ok' : 'below';
    // a course with no exam: the class mark is the final mark
    if (!examWeight) {
      out.final = classSoFar == null ? null : round1(classSoFar);
      out.needed = [];
      return out;
    }
    if (classSoFar == null) { out.needed = []; return out; }
    out.needed = targets.map((target) => {
      const raw = (target - (classSoFar * classWeight) / 100) / (examWeight / 100);
      const need = Math.max(raw, examSub || 0, 0);
      return { target, need: round1(need), possible: need <= 100, subBites: examSub != null && raw < examSub };
    });
    return out;
  }

  // The result as sentences, the same in the browser and on the no-JavaScript page.
  // UCT's bands: 50 pass, 60 second class (2:2), 70 upper second (2:1), 75 first.
  const BAND = { 50: 'To pass', 60: 'For a 2:2', 70: 'For a 2:1', 75: 'For a first' };
  function describe(r) {
    if (!r || r.classSoFar == null) return [{ tone: '', text: 'Type in the marks you have back so far to see where you stand.' }];
    const lines = [{ tone: '', text: `Class mark so far: ${r.classSoFar}%${r.markedShare < 100 ? ` (from ${r.markedShare}% of the class work; the rest is assumed to go the same way)` : ''}.` }];
    if (r.dp === 'ok') lines.push({ tone: 'ok', text: `On track for DP: the handbook asks for ${r.dpMin}% and you have ${r.classSoFar}%.` });
    if (r.dp === 'below') lines.push({ tone: 'bad', text: `Below the ${r.dpMin}% DP minimum. Without DP you can't write the exam, so talk to your lecturer or tutor now.` });
    if (!r.examWeight) {
      lines.push({ tone: '', text: `This course has no final exam, so your final mark would be about ${r.final}%.` });
      return lines;
    }
    for (const n of r.needed) {
      const label = BAND[n.target] || `For ${n.target}%`;
      if (!n.possible) lines.push({ tone: 'bad', text: `${label}: out of reach. You'd need ${n.need}% in the exam.` });
      else if (n.need <= 0) lines.push({ tone: 'ok', text: `${label}: you're already there.` });
      else lines.push({ tone: n.target === 50 ? 'ok' : '', text: `${label}: you need ${n.need}% in the exam${n.subBites ? ` (that's the ${r.examSub}% exam subminimum)` : ''}.` });
    }
    return lines;
  }

  return { parseAssessment, examSubminimum, dpMinimum, compute, describe };
}));
