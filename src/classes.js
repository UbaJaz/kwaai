// Classes for lecturers: who may do what, student numbers, QR codes, and the new-class form.
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

module.exports = { PERMISSIONS, ROLE_NAMES, can, studentNumber, qrSvg, parseClassForm, goalSoFar, needsNudge, csvRow };
