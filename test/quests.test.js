const { test } = require('node:test');
const assert = require('node:assert/strict');
const Q = require('../src/quests');

// a done session on a day, starting at an hour (South African time), for some minutes
const at = (day, hour, minutes, course = '') => ({ day, started_at: Date.parse(`${day}T${String(hour - 2).padStart(2, '0')}:00:00Z`), credited_sec: minutes * 60, course });
const MONDAY = '2026-11-02';

test('a week in numbers: days with 30 minutes, long and early sessions, twice in a day, and minutes per course', () => {
  const w = Q.weekStats([
    at('2026-11-02', 8, 55, 'CSC1015F'), at('2026-11-02', 14, 20), at('2026-11-03', 11, 29),
    at('2026-11-04', 9, 5), at('2026-11-08', 20, 40, 'CSC1015F'), at('2026-11-09', 8, 300), // next Monday: another week
  ], MONDAY);
  assert.equal(w.minutes, 55 + 20 + 29 + 5 + 40);
  assert.equal(w.days30, 2, 'Monday (75 min) and Sunday (40); Tuesday has 29');
  assert.equal(w.long, 1);
  assert.equal(w.early, 1, 'the 5-minute session at 09:00 is too short to count');
  assert.equal(w.mostInADay, 2);
  assert.deepEqual(w.byCourse, { CSC1015F: 95, '': 54 });
});

test('three quests a week, the same all week, different for different students and weeks', () => {
  const a = Q.weekQuests({ userId: 1, monday: MONDAY, sessions: [] });
  assert.equal(a.length, 3);
  assert.equal(new Set(a.map((x) => x.key)).size, 3, 'no repeats');
  assert.deepEqual(Q.weekQuests({ userId: 1, monday: MONDAY, sessions: [at(MONDAY, 9, 60, 'CSC1015F')] }).map((x) => x.key), a.map((x) => x.key), 'progress this week never changes which quests');
  const others = [2, 3, 4, 5, 6].map((u) => Q.weekQuests({ userId: u, monday: MONDAY, sessions: [] }).map((x) => x.key).join());
  assert.ok(new Set([a.map((x) => x.key).join(), ...others]).size > 1, 'students get different sets');
  const weeks = ['2026-11-09', '2026-11-16', '2026-11-23'].map((m) => Q.weekQuests({ userId: 1, monday: m, sessions: [] }).map((x) => x.key).join());
  assert.ok(new Set([a.map((x) => x.key).join(), ...weeks]).size > 1, 'weeks change');
  for (let u = 1; u < 40; u++) assert.ok(!Q.weekQuests({ userId: u, monday: MONDAY, sessions: [at('2026-10-27', 9, 60, 'CSC1015F')] }).some((x) => x.key === 'course'), 'one recent course: nothing to compare, no course quest');
});

test('quest progress, capped at the target, and the course studied least last week', () => {
  const sessions = [at('2026-10-27', 9, 120, 'MAM1031F'), at('2026-10-28', 9, 10, 'CSC1015F'), at('2026-09-28', 9, 60, 'STA1006S'), at(MONDAY, 9, 45, 'CSC1015F'), at('2026-11-03', 9, 400)];
  for (let u = 1; u < 60; u++) {
    const qs = Q.weekQuests({ userId: u, monday: MONDAY, sessions });
    for (const x of qs) {
      assert.ok(x.value <= x.target);
      if (x.key === 'hours5') assert.deepEqual([x.value, x.done, x.unit], [300, true, 'min'], '445 minutes is capped at 300');
      if (x.key === 'course') assert.deepEqual([x.course, x.value, x.done], ['CSC1015F', 45, false], 'CSC1015F had 10 min last week, MAM1031F 120; STA1006S is from more than four weeks ago');
      if (x.key === 'days3') assert.deepEqual([x.value, x.done], [2, false]);
      if (x.key === 'long') assert.equal(x.done, true);
    }
  }
});

test('the comeback quest: only after a week with no study, by someone who studied before', () => {
  const quiet = [at('2026-10-20', 9, 60)]; // two weeks back, nothing last week
  const qs = Q.weekQuests({ userId: 7, monday: MONDAY, sessions: quiet });
  assert.equal(qs[0].key, 'comeback');
  assert.equal(qs.length, 3);
  assert.ok(!Q.weekQuests({ userId: 7, monday: MONDAY, sessions: [] }).some((x) => x.key === 'comeback'), 'a new student gets no comeback');
  assert.ok(!Q.weekQuests({ userId: 7, monday: MONDAY, sessions: [...quiet, at('2026-10-29', 9, 30)] }).some((x) => x.key === 'comeback'), 'studied last week');
});

test('history counts finished quests and full weeks from the first week with study', () => {
  const sessions = [];
  // three weeks of a lot of study: every quest a week can draw is done, apart from the comeback (never drawn here)
  for (const m of ['2026-10-19', '2026-10-26', MONDAY]) for (let d = 0; d < 4; d++) sessions.push(at(addDays(m, d), 8, 90, 'CSC1015F'), at(addDays(m, d), 15, 70, 'MAM1031F'));
  const h = Q.questHistory({ userId: 3, monday: MONDAY, sessions });
  assert.deepEqual(h, { done: 9, fullWeeks: 3 });
  assert.deepEqual(Q.questHistory({ userId: 3, monday: MONDAY, sessions: [] }), { done: 0, fullWeeks: 0 });
});

test('news: newly finished quests, once, and nothing the first time', () => {
  const qs = [{ key: 'a', done: true }, { key: 'b', done: true }, { key: 'c', done: false }];
  assert.deepEqual(Q.newlyDone(qs, MONDAY, null), { news: [], seen: `${MONDAY}:a,b` });
  assert.deepEqual(Q.newlyDone(qs, MONDAY, `${MONDAY}:a`).news.map((x) => x.key), ['b']);
  assert.deepEqual(Q.newlyDone(qs, MONDAY, `${MONDAY}:a,b`).news, []);
  assert.deepEqual(Q.newlyDone(qs, MONDAY, '2026-10-26:a,b,c').news.map((x) => x.key), ['a', 'b'], 'a new week starts fresh');
});

function addDays(day, n) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}
