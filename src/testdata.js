// Made-up study data for the admin's test tools (/admin/tools, only with TEST_TOOLS=1). Every function takes a
// random() so tests can pass a seeded one. Days are South African dates, as everywhere else in src/study.js.
const { addDay } = require('./study');

// a repeatable random() for tests: the same seed gives the same numbers
function seeded(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const between = (random, lo, hi) => lo + Math.floor(random() * (hi - lo + 1));

// n days in a row ending on `end`, each with enough study to count for the streak (30 to 95 minutes)
function streakDays(n, end, random = Math.random) {
  return Array.from({ length: n }, (_, i) => ({ day: addDay(end, i - n + 1), minutes: between(random, 30, 95) }));
}

// about six months up to `today`: most days some study, some days none, the odd long day, like a real semester
function historyDays(today, days = 182, random = Math.random) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const r = random();
    if (r < 0.3) continue;
    out.push({ day: addDay(today, -i), minutes: r > 0.93 ? between(random, 150, 300) : between(random, 10, 120) });
  }
  return out;
}

// one finished timer session for a day and length, as the study_sessions table stores it (started 09:00 SA time)
function sessionRow(userId, uni, course, day, minutes) {
  const startedAt = Date.parse(`${day}T07:00:00Z`);
  return { user_id: userId, uni, course, day, started_at: startedAt, last_beat: startedAt + minutes * 60_000, planned_min: Math.max(5, Math.min(120, minutes)), credited_sec: minutes * 60 };
}

module.exports = { seeded, streakDays, historyDays, sessionRow };
