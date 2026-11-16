const { test } = require('node:test');
const assert = require('node:assert/strict');
const Srs = require('../src/srs');

const TODAY = '2026-11-16';

test('a new card is due today with the starting ease', () => {
  assert.deepEqual(Srs.newCard(TODAY), { due: TODAY, interval: 0, ease: 2.5, reps: 0, lapses: 0 });
});

test('good answers stretch the gap: 1 day, 6 days, then multiplied by the ease', () => {
  const a = Srs.review(Srs.newCard(TODAY), 'good', TODAY);
  assert.deepEqual([a.interval, a.due, a.reps], [1, '2026-11-17', 1]);
  const b = Srs.review(a, 'good', '2026-11-17');
  assert.deepEqual([b.interval, b.due], [6, '2026-11-23']);
  const c = Srs.review(b, 'good', '2026-11-23');
  assert.equal(c.interval, 15); // 6 * 2.5
});

test('again resets the run, counts a lapse, lowers the ease but never under 1.3, and is due tomorrow', () => {
  let card = Srs.review(Srs.review(Srs.newCard(TODAY), 'good', TODAY), 'good', TODAY);
  card = Srs.review(card, 'again', TODAY);
  assert.deepEqual([card.reps, card.lapses, card.interval, card.due, card.ease], [0, 1, 1, '2026-11-17', 2.3]);
  for (let i = 0; i < 20; i++) card = Srs.review(card, 'again', TODAY);
  assert.equal(card.ease, 1.3);
});

test('hard is shorter than good and easy is longer, and the gap always grows on a pass', () => {
  const seasoned = { due: TODAY, interval: 10, ease: 2.5, reps: 4, lapses: 0 };
  const [hard, good, easy] = ['hard', 'good', 'easy'].map((g) => Srs.review(seasoned, g, TODAY).interval);
  assert.ok(hard < good && good < easy, `${hard} < ${good} < ${easy}`);
  assert.ok(hard > seasoned.interval);
});

test('an unknown grade is refused', () => {
  assert.throws(() => Srs.review(Srs.newCard(TODAY), 'meh', TODAY), /unknown grade/);
});

test('nothing is scheduled on or after the exam day', () => {
  const far = { due: '2026-12-20', interval: 30, ease: 2.5, reps: 5, lapses: 0 };
  assert.equal(Srs.capAtExam(far, '2026-11-25').due, '2026-11-24');
  assert.equal(Srs.capAtExam({ ...far, due: '2026-11-20' }, '2026-11-25').due, '2026-11-20');
  assert.equal(Srs.capAtExam(far, null).due, '2026-12-20', 'no exam date: left alone');
});
