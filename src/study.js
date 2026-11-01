// The study timer's rules. Only timed study counts: the server notes the start, the open page sends a heartbeat about
// once a minute, and each heartbeat credits the time since the last one. Gaps longer than MAX_GAP_SEC (the tab was
// closed, the phone went offline) earn nothing. A session can't earn more than its planned length plus GRACE_MIN, and
// a day can't count more than DAY_CAP_MIN, so a tab left open all night can't top a leaderboard.
const PRESETS = [25, 50, 90];
const MIN_SESSION_MIN = 5;
const MAX_SESSION_MIN = 120;
const GRACE_MIN = 5;
const MAX_GAP_SEC = 300;
const DAY_CAP_MIN = 14 * 60;
const SA_OFFSET = 2 * 60 * 60 * 1000; // South Africa is UTC+2 all year

const saDay = (ms) => new Date(ms + SA_OFFSET).toISOString().slice(0, 10);

// the start form: a course code from the plan (or '' for general study) and a length in minutes
function parseStart(body, knownCourse) {
  const course = String(body.course || '').trim().toUpperCase();
  const minutes = Number(body.minutes);
  if (course && !knownCourse(course)) return { error: "That course isn't in Kwaai. Pick one from the list." };
  if (!Number.isInteger(minutes) || minutes < MIN_SESSION_MIN || minutes > MAX_SESSION_MIN) return { error: `Pick a length between ${MIN_SESSION_MIN} and ${MAX_SESSION_MIN} minutes.` };
  return { course, minutes };
}

const capSec = (s) => (s.planned_min + GRACE_MIN) * 60;

// a heartbeat at `now`: the session's new credited time and last heartbeat
function beat(s, now) {
  const gap = Math.max(0, Math.round((now - s.last_beat) / 1000));
  const credited = Math.min(capSec(s), s.credited_sec + (gap <= MAX_GAP_SEC ? gap : 0));
  return { credited_sec: credited, last_beat: Math.max(now, s.last_beat) };
}

// a running session nobody is timing any more: no heartbeat for a while, or past its planned length plus grace
const isStale = (s, now) => now - s.last_beat > MAX_GAP_SEC * 1000 || now - s.started_at > capSec(s) * 1000;

// minutes per South African day, and per course within the day, each day capped at DAY_CAP_MIN
function dayTotals(sessions) {
  const days = new Map();
  for (const s of sessions) {
    const d = days.get(s.day) || { day: s.day, minutes: 0, courses: {} };
    const min = Math.floor(s.credited_sec / 60);
    d.minutes += min;
    d.courses[s.course || ''] = (d.courses[s.course || ''] || 0) + min;
    days.set(s.day, d);
  }
  for (const d of days.values()) d.minutes = Math.min(d.minutes, DAY_CAP_MIN);
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

// "1 h 5 min", "45 min"
const hoursText = (min) => (min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}` : `${min} min`);

// ---- the dashboard: heatmap, totals, goals ----
const DAY = 86_400_000;
const addDay = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const weekdayOf = (d) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday 0 ... Sunday 6
// heatmap shade: none, under 30 min, 30 min (a streak day), an hour, two hours or more
const LEVELS = [[0, 'No study'], [1, 'Under 30 min'], [30, '30 min to 1 h'], [60, '1 to 2 h'], [120, '2 h or more']];
const levelOf = (min) => (min >= 120 ? 4 : min >= 60 ? 3 : min >= 30 ? 2 : min > 0 ? 1 : 0);

// the last 52 weeks up to today, GitHub style: one column per week, Monday at the top; days outside the range are null
function heatmap(totals, today) {
  const by = new Map(totals.map((t) => [t.day, t.minutes]));
  const from = addDay(today, -weekdayOf(today) - 51 * 7);
  const weeks = [];
  for (let d = from; d <= today;) {
    const week = [];
    for (let i = 0; i < 7; i++, d = addDay(d, 1)) week.push(d > today ? null : { day: d, minutes: by.get(d) || 0, level: levelOf(by.get(d) || 0) });
    weeks.push(week);
  }
  return weeks;
}

// minutes today, this week (Monday to today) and this month, and this week's minutes per course
function summary(totals, today) {
  const monday = addDay(today, -weekdayOf(today));
  const sum = (keep) => totals.filter(keep).reduce((s, t) => s + t.minutes, 0);
  const weekCourses = {};
  for (const t of totals) if (t.day >= monday && t.day <= today) for (const [c, m] of Object.entries(t.courses)) weekCourses[c] = (weekCourses[c] || 0) + m;
  return { today: sum((t) => t.day === today), week: sum((t) => t.day >= monday && t.day <= today), month: sum((t) => t.day.startsWith(today.slice(0, 7))), weekCourses };
}

// a course's hours a week by the handbook's credits: one credit is 10 hours of work (NQF), spread over its teaching
// weeks. Year courses (W, H) spread over both semesters. Lectures, tuts and pracs are part of these hours.
function weeklyGoal(course, weeksOf) {
  if (!course.credits) return null;
  const last = course.code.slice(-1);
  const weeks = last === 'S' ? weeksOf('s2') : last === 'W' || last === 'H' ? weeksOf('s1') + weeksOf('s2') : weeksOf('s1');
  return Math.round((course.credits * 10) / weeks);
}

// ---- streaks ----
// A day keeps the streak going with STREAK_MIN minutes of timed study. Vacations pause it: a vacation day without
// study is skipped, and a vacation day with study still adds one. Vacations are the breaks inside each semester, the
// gap between the semesters, and the time between the end of the year and the next year's first term. Years with
// no term dates have no vacations, so every day counts.
const STREAK_MIN = 30;

// terms: { 2027: { s1: { start, end, breaks: [[from, to]] }, s2: {...} } }, as in data/terms.json
function isVacation(day, terms) {
  const t = terms[day.slice(0, 4)];
  if (!t?.s1 || !t?.s2) return false;
  if (day < t.s1.start || day > t.s2.end) return true; // the long holiday around new year
  if (day > t.s1.end && day < t.s2.start) return true;
  return [...t.s1.breaks, ...t.s2.breaks].some(([a, b]) => day >= a && day <= b);
}

// totals from dayTotals(); today's date. If today hasn't reached STREAK_MIN yet the streak still stands (from
// yesterday) and `needed` says how many minutes would keep it.
function streak(totals, today, terms) {
  const minutes = new Map(totals.map((t) => [t.day, t.minutes]));
  const counts = (d) => (minutes.get(d) || 0) >= STREAK_MIN;
  const todayMin = minutes.get(today) || 0;
  let current = 0;
  const earliest = totals.length ? totals[0].day : today;
  for (let d = counts(today) ? today : addDay(today, -1); d >= earliest; d = addDay(d, -1)) {
    if (counts(d)) current++;
    else if (!isVacation(d, terms)) break;
  }
  // the best run in the history, by the same rule
  let best = 0;
  let run = 0;
  for (let d = earliest; d <= today; d = addDay(d, 1)) {
    if (counts(d)) best = Math.max(best, ++run);
    else if (!isVacation(d, terms) && d !== today) run = 0;
  }
  return { current, best, todayDone: counts(today), needed: Math.max(0, STREAK_MIN - todayMin), vacation: isVacation(today, terms) };
}

// ---- leaderboards ----
const PERIODS = { day: 'Today', week: 'This week', month: 'This month' };
const BOARD_SIZE = 50;

// the days a board covers, in South African dates: today, Monday to today, or the 1st of the month to today
function periodRange(period, today) {
  if (period === 'week') return [addDay(today, -weekdayOf(today)), today];
  if (period === 'month') return [`${today.slice(0, 7)}-01`, today];
  return [today, today];
}

// rows: [{ user_id, minutes }]. Ranks by minutes, and students on the same minutes share a rank (1, 2, 2, 4). The top
// BOARD_SIZE are listed; `me` is the viewer's own row when it's further down.
function rankBoard(rows, meId) {
  const sorted = rows.filter((r) => r.minutes > 0).sort((a, b) => b.minutes - a.minutes || a.user_id - b.user_id);
  let rank = 0;
  const ranked = sorted.map((r, i) => ({ ...r, rank: i && r.minutes === sorted[i - 1].minutes ? rank : (rank = i + 1) }));
  const top = ranked.slice(0, BOARD_SIZE);
  return { rows: top, me: top.some((r) => r.user_id === meId) ? null : ranked.find((r) => r.user_id === meId) || null, total: ranked.length };
}

// the "Join the leaderboards" form. Nobody is on a board without ticking the box; unticking it means leaving.
// known: { faculty(key), major(faculty, key) } say which faculties and majors exist; screen(text) is screenComment.
function parseProfileForm(body, known, screen) {
  if (body.join !== '1') return { leave: true };
  const showName = body.show === 'name';
  const name = String(body.display_name || '').replace(/\s+/g, ' ').trim();
  if (showName && (name.length < 2 || name.length > 30)) return { error: 'Add a display name of 2 to 30 characters, or choose to appear anonymously.' };
  if (name && screen(name).action !== 'publish') return { error: "That name can't be used. Pick another one: no contact details, insults or anyone else's name." };
  const faculty = known.faculty(body.faculty) ? body.faculty : '';
  const major = faculty && known.major(faculty, body.major) ? body.major : '';
  const year = Number(body.year);
  return { profile: { display_name: name.slice(0, 30), show_name: showName ? 1 : 0, faculty, major, year: Number.isInteger(year) && year >= 1 && year <= 6 ? year : null } };
}

module.exports = { PERIODS, BOARD_SIZE, periodRange, rankBoard, parseProfileForm, PRESETS, MIN_SESSION_MIN, MAX_SESSION_MIN, GRACE_MIN, MAX_GAP_SEC, DAY_CAP_MIN, STREAK_MIN, saDay, parseStart, beat, isStale, dayTotals, hoursText, addDay, weekdayOf, LEVELS, levelOf, heatmap, summary, weeklyGoal, isVacation, streak };
