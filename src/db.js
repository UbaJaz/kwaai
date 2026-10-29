const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const SCHEMA = `
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
CREATE TABLE IF NOT EXISTS mod_log (
  id INTEGER PRIMARY KEY,
  review_id INTEGER,
  action TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  moderator TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`;

function openDb(file = process.env.DB_FILE || path.join(__dirname, '..', 'lekker.db')) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

module.exports = { openDb };
