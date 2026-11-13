const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const crypto = require('node:crypto');
const { studentNumber } = require('./classes');

// Attendance marks, one per student per session, by student number so students who aren't on Kwaai can be marked.
// user_id is set when the student is on Kwaai. No row means absent. how: 'qr' (they scanned) or 'tutor' (tapped on the
// register). device: a random id from the phone that scanned, so the register can flag one phone checking in two people.
const ATTENDANCE_TABLE = `CREATE TABLE IF NOT EXISTS attendance (
  session_id INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  marked_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'late', 'excused')),
  how TEXT NOT NULL CHECK (how IN ('qr', 'tutor')),
  device TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (session_id, number)
);`;

// What students write, and what they report, never holds their user id. It holds an author key instead:
// akey(course, user id), an HMAC with AUTHOR_KEY, a secret kept outside the database (see openDb). The key is
// different for each course, so even someone with the database can't group one student's reviews across courses and
// match them to the courses that study_sessions or class_members tie to that student. Kwaai computes the key when it
// needs it: one review per course, "my reviews", deleting an account, banning an author.
// Dates on these tables are days, not times, so they can't be matched to a sign-in or a request in a host's logs.
const KEYED = {
  reviews: `CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  course TEXT NOT NULL REFERENCES courses(code),
  lecturer_id INTEGER REFERENCES lecturers(id),
  year INTEGER NOT NULL,
  author_key TEXT,
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
  created_at TEXT NOT NULL DEFAULT (date('now'))
);`,
  verdicts: `CREATE TABLE IF NOT EXISTS verdicts (
  id INTEGER PRIMARY KEY,
  course TEXT NOT NULL REFERENCES courses(code),
  author_key TEXT NOT NULL,
  year INTEGER NOT NULL,
  lekker INTEGER NOT NULL CHECK (lekker IN (0, 1)),
  tip TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'held', 'removed')),
  flags TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (date('now')),
  UNIQUE (author_key, course)
);`,
  verdict_reports: `CREATE TABLE IF NOT EXISTS verdict_reports (
  verdict_id INTEGER NOT NULL REFERENCES verdicts(id) ON DELETE CASCADE,
  reporter_key TEXT NOT NULL,
  PRIMARY KEY (verdict_id, reporter_key)
);`,
  // reporter_key: akey(the review's course, reporter), so one student's reports count once. day_key:
  // akey('day:' + the date, reporter), for the cap on serious reports a day; it links one person's reports within a day.
  reports: `CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES reviews(id),
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (date('now')),
  reporter_key TEXT,
  day_key TEXT
);`,
  course_facts: `CREATE TABLE IF NOT EXISTS course_facts (
  id INTEGER PRIMARY KEY,
  course TEXT NOT NULL REFERENCES courses(code),
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  data TEXT NOT NULL,
  author_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published',
  created_at TEXT NOT NULL DEFAULT (date('now')),
  UNIQUE (course, key, author_key)
);`,
  fact_reports: `CREATE TABLE IF NOT EXISTS fact_reports (
  course TEXT NOT NULL,
  key TEXT NOT NULL,
  reporter_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (date('now')),
  PRIMARY KEY (course, key, reporter_key)
);`,
};

// How rows from before author keys move over: the new columns, and the SELECT that fills them from the old table.
const REKEY = {
  reviews: ['id, course, lecturer_id, year, author_key, teaching, engagement, exams, support, difficulty, workload, overall, tags, body, status, flags, is_sample, created_at',
    'id, course, lecturer_id, year, CASE WHEN user_id IS NULL THEN NULL ELSE akey(course, user_id) END, teaching, engagement, exams, support, difficulty, workload, overall, tags, body, status, flags, is_sample, date(created_at)'],
  verdicts: ['id, course, author_key, year, lekker, tip, status, flags, created_at',
    'id, course, akey(course, user_id), year, lekker, tip, status, flags, date(created_at)'],
  verdict_reports: ['verdict_id, reporter_key',
    'verdict_id, akey((SELECT course FROM verdicts v WHERE v.id = verdict_id), user_id)'],
  reports: ['id, review_id, reason, details, resolved, created_at, reporter_key, day_key',
    "id, review_id, reason, details, resolved, date(created_at), CASE WHEN user_id IS NULL THEN NULL ELSE akey((SELECT course FROM reviews r WHERE r.id = review_id), user_id) END, CASE WHEN user_id IS NULL THEN NULL ELSE akey('day:' || date(created_at), user_id) END"],
  course_facts: ['id, course, kind, key, data, author_key, status, created_at',
    'id, course, kind, key, data, akey(course, user_id), status, date(created_at)'],
  fact_reports: ['course, key, reporter_key, created_at',
    'course, key, akey(course, user_id), date(created_at)'],
};

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
${KEYED.reviews}
-- the quick "lekker or nah?" vote: one per student per course, with an optional one-line tip
${KEYED.verdicts}
-- who reported which tip, so one student's reports count once and tips are hidden by different readers, not one
${KEYED.verdict_reports}
${KEYED.reports}
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
${KEYED.course_facts}
${KEYED.fact_reports}
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
CREATE INDEX IF NOT EXISTS study_by_course ON study_sessions (course, day);
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
-- Classes: a lecturer's group for one course and year, joined by its code. role in class_members is lecturer, tutor,
-- rep or student (what each may do is in can() in src/classes.js). name is what classmates see; anonymous hides it
-- from them. Lecturers and tutors always see the student number (from the student's myuct address).
CREATE TABLE IF NOT EXISTS classes (
  id INTEGER PRIMARY KEY,
  uni TEXT NOT NULL,
  course TEXT NOT NULL,
  year INTEGER NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  goal_week_min INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS class_members (
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('lecturer', 'tutor', 'rep', 'student')),
  name TEXT NOT NULL DEFAULT '',
  anonymous INTEGER NOT NULL DEFAULT 0,
  consent_at TEXT,
  joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (class_id, user_id)
);
CREATE INDEX IF NOT EXISTS classes_by_member ON class_members (user_id);
-- Test, prac, assignment and exam dates a class's lecturer, tutors or reps add. They're the course's official dates,
-- so they reach everyone with the course in their plan (Today, the year, calendar feeds), not only class members.
CREATE TABLE IF NOT EXISTS class_dates (
  id INTEGER PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  course TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('test', 'prac', 'assignment', 'exam')),
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL DEFAULT '',
  added_by INTEGER REFERENCES users(id),
  added_role TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS class_dates_by_course ON class_dates (course, date);
-- Tut and prac attendance: a tutor or the lecturer opens a session and shows a QR code; students scan it and confirm.
-- how is 'qr' (they scanned) or 'tutor' (added by student number, for someone without a phone).
CREATE TABLE IF NOT EXISTS attendance_sessions (
  id INTEGER PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  started_by INTEGER REFERENCES users(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
${ATTENDANCE_TABLE}
-- Short notes from a class's lecturer, tutors or reps, like "Prac 3 moved to Thursday". poster_name is the name shown
-- with it, kept as it was when posted. hidden = 1 once enough members report it, until a moderator looks.
CREATE TABLE IF NOT EXISTS class_announcements (
  id INTEGER PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  posted_by INTEGER REFERENCES users(id),
  poster_name TEXT NOT NULL,
  poster_role TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS class_announcements_by_class ON class_announcements (class_id, created_at);
-- who has seen an announcement (it leaves their Today), and who reported one (each member counts once)
CREATE TABLE IF NOT EXISTS announcement_reads (
  announcement_id INTEGER NOT NULL REFERENCES class_announcements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (announcement_id, user_id)
);
CREATE TABLE IF NOT EXISTS announcement_reports (
  announcement_id INTEGER NOT NULL REFERENCES class_announcements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (announcement_id, user_id)
);
-- Pulse checks: a one-tap question to the class. Answers are anonymous to everyone, the lecturer included: the row
-- keeps only a count per option (counts is a JSON array in the same order as options), and pulse_answered records
-- that a member answered, never what they chose. A pulse closes when closed_at is set or closes_at passes.
CREATE TABLE IF NOT EXISTS class_pulses (
  id INTEGER PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  options TEXT NOT NULL,
  counts TEXT NOT NULL,
  asked_by INTEGER REFERENCES users(id),
  asked_at INTEGER NOT NULL,
  closes_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS class_pulses_by_class ON class_pulses (class_id, asked_at);
CREATE TABLE IF NOT EXISTS pulse_answered (
  pulse_id INTEGER NOT NULL REFERENCES class_pulses(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (pulse_id, user_id)
);
-- The class list: everyone the lecturer pasted from the official list (source 'list') and everyone who joined on Kwaai
-- (source 'joined'), by student number, so registers and DP cover students who aren't on Kwaai. tut_group and
-- prac_group name the student's groups. Pasted rows are deleted 30 days after the class's year ends.
CREATE TABLE IF NOT EXISTS class_roster (
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  number TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  tut_group TEXT NOT NULL DEFAULT '',
  prac_group TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'list' CHECK (source IN ('list', 'joined')),
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (class_id, number)
);
-- Tut and prac groups in a class: when and where they meet, and who tutors them. Students are in a group by name
-- (class_roster.tut_group and prac_group), from the lecturer's list or their own pick.
CREATE TABLE IF NOT EXISTS class_groups (
  id INTEGER PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('tut', 'prac')),
  name TEXT NOT NULL,
  day TEXT NOT NULL DEFAULT '',
  starts TEXT NOT NULL DEFAULT '',
  ends TEXT NOT NULL DEFAULT '',
  venue TEXT NOT NULL DEFAULT '',
  tutor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (class_id, kind, name)
);
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


// A lecturer's role from the handbook's department staff list ("Senior Lecturer"); '' for conveners not on a list.
const LECTURER_DETAILS = { role: "TEXT NOT NULL DEFAULT ''" };

// When the student ticked "I'm 18 or older and agree to the terms" (shown on /account and in their data export).
// uni is the university the student's email belongs to (see uniForEmail in src/universities.js).
// is_admin: the password-only admin account (see src/admin.js). is_test: accounts used for testing (the admin and the
// fake students the test tools make); they're left out of every figure other students see.
const USER_DETAILS = { agreed_at: 'TEXT', uni: "TEXT NOT NULL DEFAULT 'uct'", is_admin: 'INTEGER NOT NULL DEFAULT 0', is_test: 'INTEGER NOT NULL DEFAULT 0', role: "TEXT NOT NULL DEFAULT 'student'", rank_seen: 'INTEGER', season_seen: 'TEXT', quests_seen: 'TEXT' }; // role: student or staff, from the email domain. rank_seen and season_seen: the last rank celebrated (src/ranks.js newRank); quests_seen: the quests the student was told are done (src/quests.js newlyDone)

function addMissingColumns(db, table, columns) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const [name, type] of Object.entries(columns)) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}

// Attendance used to be one row per Kwaai user. It's rebuilt by student number, keeping every mark.
function migrateAttendance(db) {
  if (db.prepare('PRAGMA table_info(attendance)').all().some((c) => c.name === 'number')) return;
  db.exec('BEGIN');
  try {
    db.exec('ALTER TABLE attendance RENAME TO attendance_by_user');
    db.exec(ATTENDANCE_TABLE);
    const put = db.prepare(`INSERT OR IGNORE INTO attendance (session_id, number, user_id, marked_at, status, how) VALUES (?, ?, ?, ?, 'present', ?)`);
    for (const r of db.prepare('SELECT a.*, u.email FROM attendance_by_user a LEFT JOIN users u ON u.id = a.user_id').all()) {
      put.run(r.session_id, studentNumber(r.email || '') || `U${r.user_id}`, r.user_id, r.marked_at, r.how);
    }
    db.exec('DROP TABLE attendance_by_user');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Tables from before author keys still have user_id: rebuild each one with keys in its place (SQLite's own steps
// for changing a table: foreign keys off, new table, copy, drop, rename, check). Renaming the old table out of the way
// instead would leave reports and takedowns pointing at the renamed one.
function migrateAuthorKeys(db, keyGiven) {
  const columns = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  // a table needs rebuilding if it lacks its key column. A very old reports table has neither that nor user_id: give
  // it an empty user_id first, so it goes through the same rebuild with no reporter.
  const old = Object.keys(KEYED).filter((t) => !columns(t).some((c) => c === 'author_key' || c === 'reporter_key'));
  if (!old.length) return;
  // without the real key the rows would get keys nobody can match again, so refuse (changing nothing) rather than lose them
  if (!keyGiven && old.some((t) => columns(t).includes('user_id') && db.prepare(`SELECT 1 FROM ${t} WHERE user_id IS NOT NULL LIMIT 1`).get())) {
    throw new Error('This database has reviews or votes from before author keys. Open it with AUTHOR_KEY set to migrate it.');
  }
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    for (const t of old) if (!columns(t).includes('user_id')) db.exec(`ALTER TABLE ${t} ADD COLUMN user_id INTEGER`);
    for (const t of old) {
      db.exec(KEYED[t].replace(`CREATE TABLE IF NOT EXISTS ${t} (`, `CREATE TABLE ${t}_new (`));
      db.exec(`INSERT INTO ${t}_new (${REKEY[t][0]}) SELECT ${REKEY[t][1]} FROM ${t}`);
      db.exec(`DROP TABLE ${t}`);
      db.exec(`ALTER TABLE ${t}_new RENAME TO ${t}`);
    }
    // only the rebuilt tables and takedowns (which points at reviews): an old problem elsewhere mustn't stop the start
    for (const t of [...old, 'takedowns']) if (db.prepare(`PRAGMA foreign_key_check(${t})`).all().length) throw new Error(`author key migration broke a foreign key in ${t}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

// Used when no AUTHOR_KEY is given: tests and a laptop. Production refuses to start without a real one (server.js).
const DEV_AUTHOR_KEY = 'kwaai-dev-only-author-key-not-secret-0000';

// authorKey: the AUTHOR_KEY secret. It lives only in this closure and the akey() SQL function, never in a table.
function openDb(file = process.env.DB_FILE || path.join(__dirname, '..', 'lekker.db'), { authorKey } = {}) {
  const db = new DatabaseSync(file);
  const secret = authorKey || DEV_AUTHOR_KEY;
  const hmac = (text) => crypto.createHmac('sha256', secret).update(text).digest('hex');
  db.function('akey', { deterministic: true }, (scope, userId) => (userId == null ? null : hmac(`${scope}:${userId}`)));
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  try {
    migrateAuthorKeys(db, !!authorKey);
    // A different key would quietly orphan every review from its author, so a database remembers which key it uses
    // (as an HMAC of a fixed text, which reveals nothing about the key) and refuses any other.
    const check = hmac('kwaai-author-key-check');
    const seen = db.prepare("SELECT value FROM meta WHERE key = 'author_key_check'").get()?.value;
    if (seen && seen !== check) throw new Error('AUTHOR_KEY is not the key this database was made with. Use the original key.');
    if (!seen) db.prepare("INSERT INTO meta (key, value) VALUES ('author_key_check', ?)").run(check);
  } catch (err) {
    db.close(); // refused: don't leave the file open
    throw err;
  }
  // one review per student per (course, lecturer, year); NULL lecturer means "not listed"
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS one_review_each ON reviews (author_key, course, year, IFNULL(lecturer_id, 0));
    CREATE UNIQUE INDEX IF NOT EXISTS one_report_each ON reports (review_id, reporter_key);
    CREATE INDEX IF NOT EXISTS course_facts_course ON course_facts (course, status);`);
  addMissingColumns(db, 'courses', COURSE_DETAILS);
  addMissingColumns(db, 'login_tokens', LOGIN_DETAILS);
  addMissingColumns(db, 'lecturers', LECTURER_DETAILS);
  addMissingColumns(db, 'users', USER_DETAILS);
  addMissingColumns(db, 'profiles', { name_fx: "TEXT NOT NULL DEFAULT ''" }); // the name style picked, from src/ranks.js NAME_FX ('' is plain)
  addMissingColumns(db, 'classes', { roster_confirmed_at: 'TEXT' }); // when the lecturer confirmed they may use the class list
  // the class's DP rule for attendance: how many tuts and pracs it will hold, the % a student must attend, and whether
  // late counts as attended (0 planned means no rule for that kind)
  addMissingColumns(db, 'classes', { dp_tut_planned: 'INTEGER NOT NULL DEFAULT 0', dp_tut_pct: 'INTEGER NOT NULL DEFAULT 0', dp_prac_planned: 'INTEGER NOT NULL DEFAULT 0', dp_prac_pct: 'INTEGER NOT NULL DEFAULT 0', dp_late_counts: 'INTEGER NOT NULL DEFAULT 1' });
  addMissingColumns(db, 'class_members', { number: "TEXT NOT NULL DEFAULT ''" }); // the member's student number, from their email
  // which group a register is for (null: the whole class), and whether it counts as a tut, a prac or neither for DP
  addMissingColumns(db, 'attendance_sessions', { group_id: 'INTEGER REFERENCES class_groups(id) ON DELETE SET NULL', kind: "TEXT NOT NULL DEFAULT 'other'" });
  migrateAttendance(db);
  db.exec('CREATE INDEX IF NOT EXISTS test_users ON users (id) WHERE is_test = 1'); // the few test accounts, for leaving them out of figures
  return db;
}

module.exports = { openDb };
