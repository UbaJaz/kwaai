// Weekly quests: three small goals each week, new every Monday (South African time). They're worked out from the
// timer's sessions, so nothing about them is stored except which finished ones the student has been told about.
// Quests only earn a tick and a count on the rank page; they never add hours.
const { addDay, weekdayOf, DAY_CAP_MIN, STREAK_MIN } = require('./study');

const SA_OFFSET = 2 * 60 * 60 * 1000;
const hourOf = (ms) => new Date(ms + SA_OFFSET).getUTCHours();
const PER_WEEK = 3;
const EARLY_HOUR = 10; // "before 10:00"
const MIN_COUNTED = 10; // a session counts for the early and twice-a-day quests from 10 minutes

// FNV-1a: the same text always gives the same number, so a student's quests stay put all week
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const mondayOf = (day) => addDay(day, -weekdayOf(day));

// one week of sessions in numbers. sessions: [{ day, started_at, credited_sec, course }], done ones only
function weekStats(sessions, monday) {
  const end = addDay(monday, 6);
  const byDay = new Map();
  const countByDay = new Map();
  const byCourse = {};
  let long = 0;
  let early = 0;
  for (const s of sessions) {
    if (s.day < monday || s.day > end) continue;
    const min = Math.floor(s.credited_sec / 60);
    byDay.set(s.day, (byDay.get(s.day) || 0) + min);
    byCourse[s.course || ''] = (byCourse[s.course || ''] || 0) + min;
    if (min >= 50) long++;
    if (min >= MIN_COUNTED) {
      countByDay.set(s.day, (countByDay.get(s.day) || 0) + 1);
      if (hourOf(s.started_at) < EARLY_HOUR) early++;
    }
  }
  const days = [...byDay.values()];
  return {
    minutes: days.reduce((sum, m) => sum + Math.min(m, DAY_CAP_MIN), 0),
    days30: days.filter((m) => m >= STREAK_MIN).length,
    long,
    early,
    mostInADay: Math.max(0, ...countByDay.values()),
    byCourse,
  };
}

// the quests a week can draw from; `course` is the course the student studied least last week, of the ones they timed
// in the four weeks before this one
const POOL = [
  { key: 'days3', title: () => 'Study 30 minutes on 3 different days', target: 3, value: (w) => w.days30 },
  { key: 'hours5', title: () => 'Time 5 hours of study this week', target: 300, unit: 'min', value: (w) => w.minutes },
  { key: 'long', title: () => 'Finish a session of 50 minutes or more', target: 1, value: (w) => w.long },
  { key: 'early', title: () => 'Start a session before 10:00', target: 1, value: (w) => w.early },
  { key: 'twice', title: () => 'Study twice in one day', target: 2, value: (w) => w.mostInADay },
  { key: 'course', title: (c) => `Spend an hour on ${c}, the course you studied least last week`, target: 60, unit: 'min', value: (w, c) => w.byCourse[c] || 0 },
];
// after a week with no study at all: an easy way back in, always one of the three
const COMEBACK = { key: 'comeback', title: () => 'Welcome back: study 30 minutes on 2 days', target: 2, value: (w) => w.days30 };

// One week's three quests with progress. userId and monday pick them; sessions are the student's done sessions
// (this week, the four weeks before, and anything earlier, to know if last week was quiet). Everything comes from the
// sessions, so the quests are the same on every device.
function weekQuests({ userId, monday, sessions }) {
  const week = weekStats(sessions, monday);
  const last = weekStats(sessions, addDay(monday, -7));
  const comeback = last.minutes === 0 && sessions.some((s) => s.day < addDay(monday, -7));
  const recent = [...new Set(sessions.filter((s) => s.course && s.day >= addDay(monday, -28) && s.day < monday).map((s) => s.course))];
  const course = recent.length > 1 ? recent.sort((a, b) => (last.byCourse[a] || 0) - (last.byCourse[b] || 0) || a.localeCompare(b))[0] : null;
  const pool = POOL.filter((p) => p.key !== 'course' || course)
    .map((p) => [hash(`${userId}:${monday}:${p.key}`), p]).sort((a, b) => a[0] - b[0]).map(([, p]) => p);
  const picked = comeback ? [COMEBACK, ...pool.slice(0, PER_WEEK - 1)] : pool.slice(0, PER_WEEK);
  return picked.map((p) => {
    const value = Math.min(p.target, p.value(week, course));
    return { key: p.key, title: p.title(course), target: p.target, value, done: value >= p.target, unit: p.unit || 'count', course: p.key === 'course' ? course : null };
  });
}

// Quests finished and full weeks (all three done), from the first week with any study up to this one
function questHistory({ userId, monday, sessions }) {
  if (!sessions.length) return { done: 0, fullWeeks: 0 };
  const first = mondayOf(sessions.reduce((min, s) => (s.day < min ? s.day : min), sessions[0].day));
  let done = 0;
  let fullWeeks = 0;
  for (let m = first; m <= monday; m = addDay(m, 7)) {
    const quests = weekQuests({ userId, monday: m, sessions });
    const n = quests.filter((x) => x.done).length;
    done += n;
    if (n === quests.length) fullWeeks++;
  }
  return { done, fullWeeks };
}

// Quests finished since the student was last told: seen is 'monday:key,key' or null. Returns the newly finished
// quests (none the first time, so nobody gets a pile of old news) and the new value to remember.
function newlyDone(quests, monday, seen) {
  const doneKeys = quests.filter((x) => x.done).map((x) => x.key);
  const next = `${monday}:${doneKeys.join(',')}`;
  if (seen == null) return { news: [], seen: next };
  const before = seen.startsWith(`${monday}:`) ? seen.slice(monday.length + 1).split(',').filter(Boolean) : [];
  return { news: quests.filter((x) => x.done && !before.includes(x.key)), seen: next };
}

module.exports = { PER_WEEK, POOL, COMEBACK, hash, mondayOf, weekStats, weekQuests, questHistory, newlyDone };
