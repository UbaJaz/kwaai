// Classes for lecturers: who may do what, student numbers, QR codes, and the new-class form.
const crypto = require('node:crypto');
const qrcode = require('qrcode-generator');

// What each role in a class may do. Lecturers and tutors see student numbers and progress; reps help run the class
// but see what students see; students see the class page and ranking.
const PERMISSIONS = {
  dashboard: ['lecturer', 'tutor'], // student numbers, progress, the CSV
  attendance: ['lecturer', 'tutor'],
  pulse: ['lecturer', 'tutor'],
  dates: ['lecturer', 'tutor', 'rep'],
  announce: ['lecturer', 'tutor', 'rep'],
  manage: ['lecturer'], // edit the class, give roles, remove members, delete it
};
const can = (member, action) => !!member && (PERMISSIONS[action] || []).includes(member.role);
const ROLE_NAMES = { lecturer: 'Lecturer', tutor: 'Tutor', rep: 'Class rep', student: 'Student' };

// A UCT student number is the part of the myuct address before the @ (ABCXYZ001@myuct.ac.za is ABCXYZ001).
// Staff addresses have no student number. The test tools' made-up students (test-student-3@kwaai.invalid) get TEST003,
// so demo classes look like real ones; that domain can't sign in, so no real account ever matches it.
const studentNumber = (email, studentDomain = 'myuct.ac.za') => {
  const [local, domain] = String(email).toLowerCase().split('@');
  if (domain === 'kwaai.invalid') {
    if (local === 'admin') return 'TEST000'; // the admin, when trying a class as a student
    const n = /^test-student-(\d+)$/.exec(local);
    return n ? `TEST${n[1].padStart(3, '0')}` : '';
  }
  return domain === studentDomain ? local.toUpperCase() : '';
};

// a QR code for a link, as an SVG that scales to its box
function qrSvg(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}

// The new-class form. known.course(code) says if a course exists; cleanName and screen are from src/study.js and
// src/moderation.js; goalFor(code) is the credit-hours goal used when the lecturer leaves the goal empty.
function parseClassForm(body, { course: courseExists, cleanName, screen, goalFor, thisYear }) {
  const course = String(body.course || '').trim().toUpperCase().replace(/\s+/g, '');
  if (!courseExists(course)) return { error: 'Pick a course that is in Kwaai, like CSC1015F.' };
  const year = Number(body.year) || thisYear;
  if (year < thisYear - 1 || year > thisYear + 1) return { error: `Pick ${thisYear - 1}, ${thisYear} or ${thisYear + 1}.` };
  const name = cleanName(body.name || `${course} ${year}`, 60, screen);
  if (name.error) return { error: `Class name: ${name.error}` };
  const hours = body.goal === '' || body.goal == null ? goalFor(course) : Number(body.goal);
  if (!(hours >= 1 && hours <= 40)) return { error: 'Set a weekly goal of 1 to 40 hours.' };
  return { cls: { course, year, name: name.name, goalWeekMin: Math.round(hours * 60) } };
}

// The goal so far this week: the weekly goal spread over the days gone, Monday counting as one day.
const goalSoFar = (goalWeekMin, dayOfWeek) => Math.round((goalWeekMin * (dayOfWeek + 1)) / 7);

// "Needs a nudge": well behind this week (under a quarter of the goal so far) or no study of the course for 7 days.
// dayOfWeek is 0 on Monday; lastDay is the last day they studied the course, or null; today is a South African date.
function needsNudge({ weekMin, lastDay }, goalWeekMin, dayOfWeek, today) {
  if (!lastDay) return true;
  const idle = Math.round((Date.parse(today) - Date.parse(lastDay)) / 86_400_000);
  return idle >= 7 || weekMin < goalSoFar(goalWeekMin, dayOfWeek) / 4;
}

// One CSV line. Quotes where needed, and a value a spreadsheet would run as a formula (=, +, -, @) gets a leading '
// so a student's name can't become a formula in the lecturer's Excel.
const csvRow = (cells) => cells.map((v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(',');

// A class date: a type, a title, a day within a year either side of today, and an optional time.
const DATE_TYPES = { test: 'Test', prac: 'Prac', assignment: 'Assignment due', exam: 'Exam' };
function parseClassDate(body, today, { cleanName, screen }) {
  const type = DATE_TYPES[body.type] ? body.type : null;
  if (!type) return { error: 'Pick what it is: a test, prac, assignment or exam.' };
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) && !Number.isNaN(Date.parse(body.date)) ? body.date : null;
  const yearOff = (d, n) => `${Number(d.slice(0, 4)) + n}${d.slice(4)}`;
  if (!date || date < yearOff(today, -1) || date > yearOff(today, 1)) return { error: 'Pick a date within a year of today.' };
  const time = String(body.time || '').trim();
  if (time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { error: 'Give the time like 14:00, or leave it empty.' };
  const title = cleanName(body.title || DATE_TYPES[type], 60, screen);
  if (title.error) return { error: `Title: ${title.error}` };
  return { date: { type, date, time, title: title.name } };
}

// A class list pasted from Excel or PeopleSoft (tab-separated) or a CSV: student number, then optionally the name, the
// tut group and the prac group. Lines without a student number in the first column (headers, blank lines) are skipped;
// skipped counts only the ones that had digits in them, so a header row isn't reported as a problem.
const ROSTER_MAX = 3000;
function splitCsvLine(line) {
  const out = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === ';') { out.push(cell); cell = ''; } else cell += ch;
  }
  out.push(cell);
  return out;
}
function parseRoster(text) {
  const byNumber = new Map();
  const skipped = [];
  String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    const cells = (line.includes('\t') ? line.split('\t') : splitCsvLine(line)).map((c) => c.replace(/\s+/g, ' ').trim());
    const number = (cells[0] || '').toUpperCase();
    if (!/^[A-Z0-9]{3,20}$/.test(number) || !/\d/.test(number)) {
      if (/\d/.test(line)) skipped.push(i + 1);
      return;
    }
    byNumber.set(number, { number, name: (cells[1] || '').slice(0, 80), tut: (cells[2] || '').slice(0, 30), prac: (cells[3] || '').slice(0, 30) });
  });
  if (byNumber.size > ROSTER_MAX) return { error: `That's ${byNumber.size} students. A class list can have up to ${ROSTER_MAX}.` };
  if (!byNumber.size) return { error: 'No student numbers found. Paste one student per line, starting with their student number.' };
  return { rows: [...byNumber.values()], skipped };
}

// A tut or prac group: a name like "Tut 3", and if known a weekday, start and end time (07:00 to 21:00) and venue.
const GROUP_KINDS = { tut: 'Tut', prac: 'Prac' };
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
function parseGroup(body) {
  const kind = GROUP_KINDS[body.kind] ? body.kind : null;
  if (!kind) return { error: 'Pick tut or prac.' };
  const name = String(body.name || '').replace(/\s+/g, ' ').trim();
  if (name.length < 1 || name.length > 30) return { error: 'Give the group a name of up to 30 characters, like Tut 3.' };
  const day = String(body.day || '');
  const starts = String(body.starts || '').trim();
  const ends = String(body.ends || '').trim();
  const venue = String(body.venue || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (day || starts || ends) {
    const time = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!WEEKDAYS.includes(day) || !time.test(starts) || !time.test(ends) || ends <= starts) return { error: 'Pick a weekday, and an end time after the start time (or leave all three empty).' };
    if (starts < '07:00' || ends > '21:00') return { error: 'Groups meet between 07:00 and 21:00.' };
  }
  return { group: { kind, name, day, starts, ends, venue } };
}

// "Wed 5 Nov" for a moment in South African time, for naming a register
const shortDay = (ms) => {
  const d = new Date(ms + 2 * 3_600_000);
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`;
};

// The register: each student is absent (no mark), present, late or excused. Tapping a name moves it to the next one.
const MARKS = ['absent', 'present', 'late', 'excused'];
const MARK_NAMES = { absent: 'Absent', present: 'Present', late: 'Late', excused: 'Excused' };
const nextMark = (status) => MARKS[(Math.max(0, MARKS.indexOf(status)) + 1) % MARKS.length];
// the sessions that count for a student (a class roster row): whole-class ones, and their own tut and prac groups'
function sessionsFor(row, sessions, groupsById) {
  return sessions.filter((s) => {
    if (!s.group_id) return true;
    const g = groupsById.get(s.group_id);
    return !!g && (g.kind === 'tut' ? row.tut_group : row.prac_group) === g.name;
  });
}
// a student's attendance, oldest first. marks: Map of "sessionId|number" to status. A session that's still open and
// has no mark for them yet doesn't count against them.
function attendanceOf(row, sessions, groupsById, marks) {
  const history = sessionsFor(row, sessions, groupsById).slice().sort((a, b) => a.started_at - b.started_at)
    .map((s) => ({ id: s.id, label: s.label, kind: s.kind, open: !s.ended_at, status: marks.get(`${s.id}|${row.number}`) || 'absent' }));
  const counted = history.filter((h) => !(h.open && h.status === 'absent'));
  const n = (status) => counted.filter((h) => h.status === status).length;
  return { history, held: counted.length, present: n('present'), late: n('late'), excused: n('excused'), absent: n('absent') };
}
// register order: surname (the last word of the name), then the full name, then the student number
const surname = (name) => String(name || '').trim().split(/\s+/).pop().toLowerCase();
const bySurname = (a, b) => surname(a.name).localeCompare(surname(b.name)) || String(a.name).localeCompare(String(b.name)) || a.number.localeCompare(b.number);

// DP from attendance, for one kind (tuts or pracs). planned: sessions the course will hold (at least the ones held so
// far); pct: the share a student must attend. Excused sessions come off what's planned, the way a leave of absence works.
// canMiss: how many more they can miss and keep DP. warn once they've missed some and can't miss another (warning earlier flagged nearly every student in a real class).
function dpStatus({ planned, held, attended, excused, pct }) {
  const total = Math.max(planned, held) - excused;
  const required = Math.ceil((pct / 100) * total - 1e-9);
  const missed = held - excused - attended;
  const canMiss = total - required - missed;
  const state = canMiss < 0 ? 'lost' : missed > 0 && canMiss === 0 ? 'warn' : 'ok';
  return { state, canMiss: Math.max(0, canMiss), required, missed, attended, total };
}
// a class's DP rule for a kind, or null if it has none
const dpRule = (cls, kind) => (cls[`dp_${kind}_planned`] > 0 && cls[`dp_${kind}_pct`] > 0 ? { planned: cls[`dp_${kind}_planned`], pct: cls[`dp_${kind}_pct`], lateCounts: !!cls.dp_late_counts } : null);
// DP for one kind from a student's attendance history (Classes.attendanceOf); open sessions they aren't marked in yet don't count
function dpFor(history, rule, kind) {
  const counted = history.filter((h) => h.kind === kind && !(h.open && h.status === 'absent'));
  const n = (status) => counted.filter((h) => h.status === status).length;
  return dpStatus({ planned: rule.planned, held: counted.length, attended: n('present') + (rule.lateCounts ? n('late') : 0), excused: n('excused'), pct: rule.pct });
}
// Why a student might need a hand, in plain words: two missed sessions in a row, DP at risk or lost, or no study of
// the course for 14 days (only for students on Kwaai, whose study we can see)
function riskFlags({ history, dp = {}, onKwaai = false, days14 = 0, course = '' }) {
  const flags = [];
  const counted = history.filter((h) => !(h.open && h.status === 'absent'));
  const last2 = counted.slice(-2);
  if (last2.length === 2 && last2.every((h) => h.status === 'absent')) flags.push({ key: 'missed2', text: last2[0].label === last2[1].label ? 'Missed the last two sessions' : `Missed ${last2[0].label} and ${last2[1].label}` });
  for (const [kind, d] of Object.entries(dp)) {
    if (d.state === 'lost') flags.push({ key: `dp-${kind}`, text: `Can't reach ${kind} DP` });
    else if (d.state === 'warn') flags.push({ key: `dp-${kind}`, text: d.canMiss ? `Can miss 1 more ${kind} for DP` : `Can't miss another ${kind}` });
  }
  if (onKwaai && !days14) flags.push({ key: 'nostudy', text: `No ${course} study in 14 days` });
  return flags;
}

// Attendance as a percentage, for exports: of the sessions held (of one kind, or all when kind is empty), how many the
// student attended. Excused ones are left out; late counts if the class says so. pct is null when nothing is held yet.
function attendancePercent(history, kind = '', lateCounts = true) {
  const counted = history.filter((h) => (!kind || h.kind === kind) && h.status !== 'excused' && !(h.open && h.status === 'absent'));
  const attended = counted.filter((h) => h.status === 'present' || (lateCounts && h.status === 'late')).length;
  return { attended, held: counted.length, pct: counted.length ? Math.round((attended / counted.length) * 100) : null };
}
// one letter per session for the register spreadsheet; empty for a session that's still open without a mark
const REGISTER_LETTER = { present: 'P', late: 'L', excused: 'E', absent: 'A' };
const registerLetter = (h) => (!h ? '' : h.open && h.status === 'absent' ? '' : REGISTER_LETTER[h.status]);

// Announcements: up to ANNOUNCE_MAX characters, screened like review comments (no contact details, links, insults or
// allegations). Anything the screen would hold for a moderator is refused instead, with the reason, so the poster can
// reword it: an announcement is only useful if it goes out now. They stay on members' Today for ANNOUNCE_DAYS.
const ANNOUNCE_MAX = 280;
const ANNOUNCE_DAYS = 7;
function parseAnnouncement(body, screen) {
  const text = String(body || '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 3) return { error: 'Write the announcement first.' };
  if (text.length > ANNOUNCE_MAX) return { error: `Keep it to ${ANNOUNCE_MAX} characters. That one is ${text.length}.` };
  const s = screen(text);
  if (s.action !== 'publish') return { error: `Reword it and post again: ${s.reasons.join(', ').toLowerCase()}.` };
  return { text };
}

// Pulse checks: a question of 5 to 120 characters with 2 to 4 different answers of up to 40 characters each, all
// screened like comments. They close by themselves after PULSE_DAYS. PULSE_PRESET fills the form the first time.
const PULSE_DAYS = 7;
const PULSE_PRESET = { question: "How's the pace this week?", options: ['Too slow', 'About right', 'Too fast'] };
function parsePulse(body, screen) {
  const tidy = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const question = tidy(body.question);
  if (question.length < 5 || question.length > 120) return { error: 'Ask a question of 5 to 120 characters.' };
  const options = [1, 2, 3, 4].map((n) => tidy(body[`option${n}`])).filter(Boolean);
  if (options.length < 2) return { error: 'Give at least two answers to pick from.' };
  if (options.some((o) => o.length > 40)) return { error: 'Keep each answer to 40 characters.' };
  if (new Set(options.map((o) => o.toLowerCase())).size < options.length) return { error: 'Make each answer different.' };
  const s = screen([question, ...options].join('\n'));
  if (s.action !== 'publish') return { error: `Reword it and ask again: ${s.reasons.join(', ').toLowerCase()}.` };
  return { question, options };
}

// Attendance QR codes. The code in the QR changes every SLOT_MS: it is an HMAC of the session and the time slot,
// so a photo of it stops working within a minute. A scan is accepted for the current slot and the two before it
// (up to about a minute), which covers a slow phone and the tap to confirm.
const SLOT_MS = 20_000;
const SLOTS_ACCEPTED = 3;
const slotAt = (now) => Math.floor(now / SLOT_MS);
const attendanceKey = (secret, sessionId, slot) => crypto.createHmac('sha256', secret).update(`${sessionId}:${slot}`).digest('base64url').slice(0, 12);
function keyIsCurrent(secret, sessionId, key, now) {
  const sent = Buffer.from(String(key || ''));
  for (let back = 0; back < SLOTS_ACCEPTED; back++) {
    const want = Buffer.from(attendanceKey(secret, sessionId, slotAt(now) - back));
    if (sent.length === want.length && crypto.timingSafeEqual(sent, want)) return true;
  }
  return false;
}

module.exports = { PERMISSIONS, ROLE_NAMES, can, studentNumber, qrSvg, parseClassForm, goalSoFar, needsNudge, csvRow, DATE_TYPES, parseClassDate, ROSTER_MAX, parseRoster, GROUP_KINDS, WEEKDAYS, parseGroup, shortDay, MARKS, MARK_NAMES, nextMark, sessionsFor, attendanceOf, bySurname, dpStatus, dpRule, dpFor, riskFlags, attendancePercent, registerLetter, ANNOUNCE_MAX, ANNOUNCE_DAYS, parseAnnouncement, PULSE_DAYS, PULSE_PRESET, parsePulse, SLOT_MS, slotAt, attendanceKey, keyIsCurrent };
