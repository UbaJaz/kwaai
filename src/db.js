const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS email_count (day TEXT PRIMARY KEY, n INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS departments (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS courses (
  code TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  dept TEXT NOT NULL REFERENCES departments(code),
  credits INTEGER,
  nqf INTEGER,
  conveners TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL
  -- plus the handbook details in COURSE_DETAILS below
);
CREATE TABLE IF NOT EXISTS lecturers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  dept TEXT NOT NULL REFERENCES departments(code),
  is_sample INTEGER NOT NULL DEFAULT 0,
  UNIQUE (name, dept)
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  banned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS login_tokens (
  hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires INTEGER NOT NULL
  -- plus the columns in LOGIN_DETAILS below
);
CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  course TEXT NOT NULL REFERENCES courses(code),
  lecturer_id INTEGER REFERENCES lecturers(id),
  year INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id),
  teaching INTEGER NOT NULL CHECK (teaching BETWEEN 1 AND 5),
  engagement INTEGER NOT NULL CHECK (engagement BETWEEN 1 AND 5),
  exams INTEGER NOT NULL CHECK (exams BETWEEN 1 AND 5),
  support INTEGER NOT NULL CHECK (support BETWEEN 1 AND 5),
  difficulty INTEGER NOT NULL CHECK (difficulty BETWEEN 1 AND 5),
  workload INTEGER NOT NULL CHECK (workload BETWEEN 1 AND 5),
  overall REAL NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'held', 'removed')),
  flags TEXT NOT NULL DEFAULT '',
  is_sample INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- one review per student per (course, lecturer, year); NULL lecturer means "not listed"
CREATE UNIQUE INDEX IF NOT EXISTS one_review_each ON reviews (user_id, course, year, IFNULL(lecturer_id, 0));
-- the quick "lekker or nah?" vote: one per student per course, with an optional one-line tip
CREATE TABLE IF NOT EXISTS verdicts (
  id INTEGER PRIMARY KEY,
  course TEXT NOT NULL REFERENCES courses(code),
  user_id INTEGER NOT NULL REFERENCES users(id),
  year INTEGER NOT NULL,
  lekker INTEGER NOT NULL CHECK (lekker IN (0, 1)),
  tip TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'held', 'removed')),
  flags TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, course)
);
-- who reported which tip, so one student's reports count once and tips are hidden by different readers, not one
CREATE TABLE IF NOT EXISTS verdict_reports (
  verdict_id INTEGER NOT NULL REFERENCES verdicts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (verdict_id, user_id)
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES reviews(id),
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS takedowns (
  id INTEGER PRIMARY KEY,
  review_id INTEGER REFERENCES reviews(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  relation TEXT NOT NULL,
  details TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS lecturer_suggestions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  dept TEXT NOT NULL REFERENCES departments(code),
  course TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
-- Course details students add (src/facts.js): a lecture/tut/prac time, a week's topic, or a dated event. The same key
-- from another student is a confirmation. status: published, held (screened or reported) or removed.
CREATE TABLE IF NOT EXISTS course_facts (
  id INTEGER PRIMARY KEY,
  course TEXT NOT NULL REFERENCES courses(code),
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  data TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'published',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (course, key, user_id)
);
CREATE INDEX IF NOT EXISTS course_facts_course ON course_facts (course, status);
CREATE TABLE IF NOT EXISTS fact_reports (
  course TEXT NOT NULL,
  key TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (course, key, user_id)
);
-- A subscribed week calendar: a random id in the URL that calendar apps fetch, and the plan's course codes and week
-- settings (no names, emails or "about you" answers). Deleted after 12 months without a fetch.
CREATE TABLE IF NOT EXISTS calendars (
  id TEXT PRIMARY KEY,
  query TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  fetched_at TEXT
);
-- Study timer sessions. The server records the start, and credited_sec only grows from the page's heartbeats, so
-- leaderboards count timed study, never typed-in hours. day is the South African date the session started.
CREATE TABLE IF NOT EXISTS study_sessions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  uni TEXT NOT NULL,
  course TEXT NOT NULL DEFAULT '',
  day TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  last_beat INTEGER NOT NULL,
  planned_min INTEGER NOT NULL,
  credited_sec INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done'))
);
CREATE INDEX IF NOT EXISTS study_by_user ON study_sessions (user_id, day);
CREATE INDEX IF NOT EXISTS study_by_day ON study_sessions (uni, day);
CREATE UNIQUE INDEX IF NOT EXISTS one_running_timer ON study_sessions (user_id) WHERE status = 'running';
-- Leaderboard profiles. A row exists only while the student has chosen to be on the leaderboards (boards_agreed_at
-- records when). show_name = 0 shows the anonymous label ("2nd-year Computer Science student") instead of the name.
-- name_held = 1 after enough reports: the name is hidden until a moderator looks at it.
CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  uni TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  show_name INTEGER NOT NULL DEFAULT 0,
  faculty TEXT NOT NULL DEFAULT '',
  major TEXT NOT NULL DEFAULT '',
  year INTEGER,
  name_held INTEGER NOT NULL DEFAULT 0,
  boards_agreed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS name_reports (
  user_id INTEGER NOT NULL REFERENCES users(id),
  target_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, target_id)
);
-- Study groups: friends, a residence, a tut group. Anyone with the join code can join; members see each other's
-- group name and study minutes. name in group_members is what that member is called in that group.
CREATE TABLE IF NOT EXISTS study_groups (
  id INTEGER PRIMARY KEY,
  uni TEXT NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS groups_by_member ON group_members (user_id);
CREATE TABLE IF NOT EXISTS mod_log (
  id INTEGER PRIMARY KEY,
  review_id INTEGER,
  action TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  moderator TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

// What the handbook says about each course, used by the course page and the planner.
// Added as columns after launch, so openDb adds any that an older database is missing.
// periods and days are '|'-separated ("4|5", "Monday|Tuesday"); period_choice = 1 means "4th or 5th", one group each.
const COURSE_DETAILS = {
  outline: "TEXT NOT NULL DEFAULT ''",
  entry: "TEXT NOT NULL DEFAULT ''",
  corequisites: "TEXT NOT NULL DEFAULT ''",
  lectures: "TEXT NOT NULL DEFAULT ''",
  periods: "TEXT NOT NULL DEFAULT ''",
  period_choice: 'INTEGER NOT NULL DEFAULT 0',
  days: "TEXT NOT NULL DEFAULT ''",
  dp: "TEXT NOT NULL DEFAULT ''",
  assessment: "TEXT NOT NULL DEFAULT ''",
  exam_weight: 'INTEGER',
  not_offered: 'INTEGER', // the year the handbook says it isn't offered, e.g. 2026
  table_only: 'INTEGER NOT NULL DEFAULT 0', // listed in a curriculum table, but no course description in any handbook
  sessions: "TEXT NOT NULL DEFAULT ''", // tutorials and practicals as JSON, from sessionsOf() in scripts/import-handbook.js
  topics: "TEXT NOT NULL DEFAULT ''", // a rough week-by-week topic draft as JSON, from draftTopics() in src/facts.js
};

// A sign-in email carries a link and a 6-digit code (for reading the email on your phone and signing in on a laptop).
// code_hash is a hash of email + code; attempts counts wrong codes; next is the page to go back to afterwards.
const LOGIN_DETAILS = {
  code_hash: "TEXT NOT NULL DEFAULT ''",
  attempts: 'INTEGER NOT NULL DEFAULT 0',
  next: "TEXT NOT NULL DEFAULT '/'",
};

// Who sent a review report, so one student's reports count once. Reports from before this column existed stay anonymous.
const REPORT_DETAILS = { user_id: 'INTEGER' };

// A lecturer's role from the handbook's department staff list ("Senior Lecturer"); '' for conveners not on a list.
const LECTURER_DETAILS = { role: "TEXT NOT NULL DEFAULT ''" };

// When the student ticked "I'm 18 or older and agree to the terms" (shown on /account and in their data export).
// uni is the university the student's email belongs to (see uniForEmail in src/universities.js).
const USER_DETAILS = { agreed_at: 'TEXT', uni: "TEXT NOT NULL DEFAULT 'uct'" };

function addMissingColumns(db, table, columns) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, type] of Object.entries(columns)) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}

function openDb(file = process.env.DB_FILE || path.join(__dirname, '..', 'lekker.db')) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  addMissingColumns(db, 'courses', COURSE_DETAILS);
  addMissingColumns(db, 'login_tokens', LOGIN_DETAILS);
  addMissingColumns(db, 'reports', REPORT_DETAILS);
  addMissingColumns(db, 'lecturers', LECTURER_DETAILS);
  addMissingColumns(db, 'users', USER_DETAILS);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS one_report_each ON reports (review_id, user_id)');
  return db;
}

module.exports = { openDb };
