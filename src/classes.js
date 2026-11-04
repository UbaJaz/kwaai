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
// Staff addresses have no student number.
const studentNumber = (email, studentDomain = 'myuct.ac.za') => {
  const [local, domain] = String(email).toLowerCase().split('@');
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

module.exports = { PERMISSIONS, ROLE_NAMES, can, studentNumber, qrSvg, parseClassForm, goalSoFar, needsNudge, csvRow, DATE_TYPES, parseClassDate, ANNOUNCE_MAX, ANNOUNCE_DAYS, parseAnnouncement, PULSE_DAYS, PULSE_PRESET, parsePulse, SLOT_MS, slotAt, attendanceKey, keyIsCurrent };
