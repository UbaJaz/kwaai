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

module.exports = { PRESETS, MIN_SESSION_MIN, MAX_SESSION_MIN, GRACE_MIN, MAX_GAP_SEC, DAY_CAP_MIN, saDay, parseStart, beat, isStale, dayTotals, hoursText };
