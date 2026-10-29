// Rebuilds the database from data/*.json.
// Real data: courses and conveners from UCT handbooks. Demo data: made-up "Sample" lecturers and reviews,
// flagged is_sample=1 and badged in the UI. Run with SAMPLES=0 to leave them out (do this before launch).
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../src/db');
const { overallOf } = require('../src/ratings');

const DEPARTMENTS = {
  ACC: 'Accounting', APG: 'Architecture, Planning & Geomatics', BIO: 'Biological Sciences', CEM: 'Chemistry',
  CHE: 'Chemical Engineering', CIV: 'Civil Engineering', CML: 'Commercial Law', CON: 'Construction Economics & Management',
  CSC: 'Computer Science', EEE: 'Electrical Engineering', EGS: 'Environmental & Geographical Science',
  END: 'EBE Faculty (cross-department)', GEO: 'Geological Sciences', MAM: 'Mathematics & Applied Mathematics',
  MEC: 'Mechanical Engineering', PHY: 'Physics', STA: 'Statistical Sciences',
};

function seed(db, { samples = true } = {}) {
  db.exec('DELETE FROM reports; DELETE FROM takedowns; DELETE FROM mod_log; DELETE FROM reviews; DELETE FROM lecturers; DELETE FROM courses; DELETE FROM departments;');
  const dataDir = path.join(__dirname, '..', 'data');
  const files = fs.readdirSync(dataDir).filter((f) => /^courses-.*\.json$/.test(f));
  const addDept = db.prepare('INSERT OR IGNORE INTO departments (code, name) VALUES (?, ?)');
  const addCourse = db.prepare('INSERT OR IGNORE INTO courses (code, title, dept, credits, nqf, conveners, source) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const addLecturer = db.prepare('INSERT OR IGNORE INTO lecturers (name, dept, is_sample) VALUES (?, ?, ?)');
  for (const f of files) {
    const { source, courses } = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
    for (const c of courses) {
      const dept = c.code.slice(0, 3);
      addDept.run(dept, DEPARTMENTS[dept] || dept);
      addCourse.run(c.code, c.title, dept, c.credits, c.nqf, c.conveners.join('|'), source);
      for (const name of c.conveners) addLecturer.run(name, dept, 0);
    }
  }
  if (samples) addSamples(db);
  const n = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
  return { courses: n('courses'), lecturers: n('lecturers'), reviews: n('reviews') };
}

// ---- demo data ----
const SAMPLE_COURSES = {
  // code: [teaching, engagement, exams, support, difficulty, workload] "personality" the random reviews wobble around
  MAM1020F: [3.4, 2.8, 3.0, 3.6, 4.2, 4.0], MAM1021S: [3.0, 2.6, 2.5, 3.2, 4.6, 4.4], PHY1012F: [4.1, 4.4, 3.4, 4.0, 4.0, 3.6],
  MEC1009F: [3.8, 3.5, 3.8, 3.9, 3.4, 3.4], MEC2047F: [3.2, 3.0, 2.6, 3.0, 4.7, 4.3], MEC1007F: [4.3, 3.9, 4.4, 4.5, 2.4, 3.8],
  MEC3077F: [3.6, 3.2, 3.1, 3.5, 4.3, 4.1], EEE1008F: [4.4, 4.6, 4.0, 4.3, 3.0, 3.0], EEE2046F: [4.0, 4.1, 3.6, 4.2, 3.7, 4.5],
  EEE3096S: [3.7, 3.8, 3.3, 3.6, 4.1, 4.7], EEE3099S: [4.5, 4.2, 4.3, 4.4, 3.2, 4.6], CSC1016S: [4.2, 3.7, 3.9, 4.1, 3.3, 3.5],
  CHE1007S: [3.3, 2.9, 3.4, 3.8, 3.9, 3.9], CIV3042F: [3.9, 3.4, 3.7, 3.5, 3.8, 3.5],
};
const SAMPLE_NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot', 'Golf', 'Hotel'];
const BODIES = {
  good: [
    'Lectures are genuinely fun and the notes are excellent. Go to every single one.',
    'Explains the hard stuff slowly and properly. Consults are super helpful.',
    'Exam was exactly what we practised in tuts. No surprises.',
    'One of the best courses I have done. Would take again.',
  ],
  mid: [
    'Content is fine but the pace picks up a lot after the first test.',
    'Do every past paper. The tutorials are where it actually clicks.',
    'Decent course, just a lot of work in the last block.',
    'Lectures are a bit dry, but the slides are good for self-study.',
  ],
  low: [
    'Tests felt much harder than the tutorial problems. Start studying early.',
    'Hard to follow in lectures. YouTube and the textbook carried me.',
    'Heavy workload and the marking is strict. Ask for help early.',
  ],
};
const TAG_POOL = {
  good: ['Great notes', 'Funny', 'Clear marking', 'Would take again'],
  mid: ['Past papers are gold', 'Tuts are essential', 'Attendance matters', 'Lots of group work'],
  low: ['Tough tests', 'Self-study heavy', 'Past papers are gold'],
};

function addSamples(db) {
  let seed = 42;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const clamp = (x) => Math.max(1, Math.min(5, Math.round(x)));
  const addLecturer = db.prepare('INSERT OR IGNORE INTO lecturers (name, dept, is_sample) VALUES (?, ?, 1)');
  const addReview = db.prepare(`INSERT INTO reviews (course, lecturer_id, year, teaching, engagement, exams, support, difficulty, workload, overall, tags, body, is_sample, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`);
  const year = new Date().getFullYear();
  // two made-up lecturers per department; each course mostly has one of them
  const byDept = {};
  let named = 0;
  const lecturersIn = (dept) => (byDept[dept] ??= ['Prof', 'Dr'].map((title) => {
    const name = `${title} Sample ${SAMPLE_NAMES[named++ % SAMPLE_NAMES.length]}`;
    addLecturer.run(name, dept);
    return db.prepare('SELECT id FROM lecturers WHERE name = ? AND dept = ?').get(name, dept).id;
  }));
  Object.entries(SAMPLE_COURSES).forEach(([code, base], courseIdx) => {
    const dept = code.slice(0, 3);
    if (!db.prepare('SELECT 1 FROM courses WHERE code = ?').get(code)) return;
    const [main, other] = courseIdx % 2 ? lecturersIn(dept).toReversed() : lecturersIn(dept);
    const count = 4 + Math.floor(rand() * 6);
    for (let i = 0; i < count; i++) {
      const [teaching, engagement, exams, support, difficulty, workload] = base.map((b) => clamp(b + (rand() - 0.5) * 2));
      const r = { teaching, engagement, exams, support, difficulty, workload };
      r.overall = overallOf(r);
      const mood = r.overall >= 4 ? 'good' : r.overall >= 3 ? 'mid' : 'low';
      const tags = [...new Set([pick(TAG_POOL[mood]), pick(TAG_POOL[mood])])].slice(0, 1 + Math.floor(rand() * 2));
      const took = year - Math.floor(rand() * 2);
      const start = Date.UTC(took, 4, 1); // posted some time after the course started
      const created = new Date(start + rand() * (Date.now() - start)).toISOString().slice(0, 19).replace('T', ' ');
      addReview.run(code, rand() < 0.8 ? main : other, took, r.teaching, r.engagement, r.exams, r.support, r.difficulty, r.workload,
        r.overall, tags.join('|'), rand() < 0.75 ? pick(BODIES[mood]) : '', created);
    }
  });
}

if (require.main === module) {
  const db = openDb();
  console.log('seeded', seed(db, { samples: process.env.SAMPLES !== '0' }));
}

module.exports = { seed };
