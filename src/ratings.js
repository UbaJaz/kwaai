// The four "quality" categories make up the overall star score.
// Difficulty and workload are shown separately: a hard course isn't a bad course.
const QUALITY = [
  { key: 'teaching', label: 'Teaching', hint: 'Explains clearly, good notes and slides' },
  { key: 'engagement', label: 'Fun & interactive', hint: 'Keeps lectures lively, actually funny' },
  { key: 'exams', label: 'Exam fairness', hint: 'Tests what was taught, marks fairly' },
  { key: 'support', label: 'Approachable', hint: 'Answers questions, helpful in consults' },
];
const SCALES = [
  { key: 'difficulty', label: 'Exam difficulty', low: 'Chilled', high: 'Brutal' },
  { key: 'workload', label: 'Workload', low: 'Light', high: 'Heavy' },
];
const ALL_KEYS = [...QUALITY, ...SCALES].map((c) => c.key);

const TAGS = [
  'Great notes', 'Funny', 'Past papers are gold', 'Attendance matters', 'Tuts are essential',
  'Tough tests', 'Clear marking', 'Lots of group work', 'Would take again', 'Self-study heavy',
];
const MAX_TAGS = 3;
const MAX_BODY = 280;
const MAX_TIP = 140;
// A lecturer or course needs this many reviews before it can appear in a ranking,
// so one angry review can't put someone at the bottom of a list.
const MIN_FOR_RANKING = 3;
// Anyone can read this many written comments and tips per page. The rest open up once
// you've voted on or reviewed one course yourself, so readers become contributors.
const FREE_COMMENTS = 2;

const RANKINGS = [
  { key: 'best', label: 'Highest rated', column: 'overall', order: 'DESC' },
  { key: 'funniest', label: 'Funniest & most interactive', column: 'engagement', order: 'DESC' },
  { key: 'hardest', label: 'Hardest exams', column: 'difficulty', order: 'DESC' },
  { key: 'fairest', label: 'Fairest exams', column: 'exams', order: 'DESC' },
  { key: 'workload', label: 'Heaviest workload', column: 'workload', order: 'DESC' },
  { key: 'lowest', label: 'Lowest rated', column: 'overall', order: 'ASC' },
];

function overallOf(r) {
  return Math.round((QUALITY.reduce((s, c) => s + r[c.key], 0) / QUALITY.length) * 10) / 10;
}

// Validates a submitted review form. Returns { review } or { error }.
function parseReviewForm(form, { currentYear = new Date().getFullYear() } = {}) {
  const review = {};
  for (const key of ALL_KEYS) {
    const n = Number(form[key]);
    if (!Number.isInteger(n) || n < 1 || n > 5) return { error: 'Please rate every category from 1 to 5.' };
    review[key] = n;
  }
  const year = Number(form.year);
  if (!Number.isInteger(year) || year < currentYear - 6 || year > currentYear) return { error: 'Pick the year you took the course.' };
  review.year = year;
  const tags = [form.tags ?? []].flat().filter((t) => TAGS.includes(t));
  if (tags.length > MAX_TAGS) return { error: `Pick at most ${MAX_TAGS} tags.` };
  review.tags = [...new Set(tags)].join('|');
  review.body = String(form.body ?? '').trim().replace(/\s+/g, ' ');
  if (review.body.length > MAX_BODY) return { error: `Keep the comment under ${MAX_BODY} characters.` };
  review.overall = overallOf(review);
  return { review };
}

// Validates the quick lekker-or-nah vote. Returns { verdict } or { error }.
function parseVerdictForm(form, { currentYear = new Date().getFullYear() } = {}) {
  if (form.lekker !== '1' && form.lekker !== '0') return { error: 'Pick lekker or nah.' };
  const year = Number(form.year);
  if (!Number.isInteger(year) || year < currentYear - 6 || year > currentYear) return { error: 'Pick the year you took the course.' };
  const tip = String(form.tip ?? '').trim().replace(/\s+/g, ' ');
  if (tip.length > MAX_TIP) return { error: `Keep the tip under ${MAX_TIP} characters.` };
  return { verdict: { lekker: Number(form.lekker), year, tip } };
}

module.exports = { QUALITY, SCALES, ALL_KEYS, TAGS, MAX_TAGS, MAX_BODY, MAX_TIP, MIN_FOR_RANKING, FREE_COMMENTS, RANKINGS, overallOf, parseReviewForm, parseVerdictForm };
