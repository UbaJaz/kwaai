const { test } = require('node:test');
const assert = require('node:assert/strict');
const Ranks = require('../src/ranks');

const H = 60;

test('lifetime rank: unranked under an hour, then each division at its hours', () => {
  assert.equal(Ranks.rankOf(0).label, 'Unranked');
  assert.equal(Ranks.rankOf(59).label, 'Unranked');
  assert.equal(Ranks.rankOf(59).toNextMin, 1);
  assert.equal(Ranks.rankOf(59).next.label, 'Bronze I');
  assert.equal(Ranks.rankOf(60).label, 'Bronze I');
  assert.equal(Ranks.rankOf(5 * H - 1).label, 'Bronze I');
  assert.equal(Ranks.rankOf(5 * H).label, 'Bronze II');
  assert.equal(Ranks.rankOf(20 * H).label, 'Silver I');
  assert.equal(Ranks.rankOf(75 * H).label, 'Gold I');
  assert.equal(Ranks.rankOf(350 * H).label, 'Platinum III');
  assert.equal(Ranks.rankOf(750 * H).label, 'Diamond III');
  assert.equal(Ranks.rankOf(1000 * H).label, 'Kwaai');
  assert.equal(Ranks.rankOf(1000 * H).tier, 'kwaai');
  assert.equal(Ranks.rankOf(1000 * H).division, null);
});

test('lifetime rank: progress towards the next step, and the top has nowhere further', () => {
  const r = Ranks.rankOf(85 * H); // Gold I is 75 h, Gold II 100 h
  assert.equal(r.label, 'Gold I');
  assert.equal(r.next.label, 'Gold II');
  assert.equal(r.toNextMin, 15 * H);
  assert.equal(r.progress, 0.4);
  const top = Ranks.rankOf(5000 * H);
  assert.equal(top.next, null);
  assert.equal(top.toNextMin, 0);
  assert.equal(top.progress, 1);
  assert.equal(Ranks.rankOf(-5).label, 'Unranked', 'nothing below zero');
  assert.equal(Ranks.rankOf(undefined).minutes, 0);
});

test('season rank uses its own lower ladder', () => {
  assert.equal(Ranks.rankOf(30 * H, Ranks.SEASON).label, 'Gold I');
  assert.equal(Ranks.rankOf(225 * H, Ranks.SEASON).label, 'Kwaai');
  assert.equal(Ranks.rankOf(224 * H, Ranks.SEASON).label, 'Diamond III');
});

test('seasons: semester 1 from new year, semester 2 from its start date', () => {
  const terms = { 2026: { s2: { start: '2026-07-27' } } };
  assert.deepEqual(Ranks.seasonOf('2026-01-01', terms), { key: '2026-s1', name: 'Semester 1 2026', from: '2026-01-01', to: '2026-07-26' });
  assert.equal(Ranks.seasonOf('2026-07-26', terms).key, '2026-s1');
  assert.equal(Ranks.seasonOf('2026-07-27', terms).key, '2026-s2');
  assert.deepEqual(Ranks.seasonOf('2026-12-31', terms), { key: '2026-s2', name: 'Semester 2 2026', from: '2026-07-27', to: '2026-12-31' });
  assert.equal(Ranks.seasonOf('2030-07-14').key, '2030-s1', 'years without term dates split on 15 July');
  assert.equal(Ranks.seasonOf('2030-07-15').key, '2030-s2');
  assert.equal(Ranks.previousSeason(Ranks.seasonOf('2027-01-05', terms), terms).key, '2026-s2');
  assert.equal(Ranks.previousSeason(Ranks.seasonOf('2026-08-01', terms), terms).key, '2026-s1');
});

test('name styles unlock with the lifetime tier and keep the ones below', () => {
  assert.deepEqual(Ranks.unlockedFx(null), []);
  assert.deepEqual(Ranks.unlockedFx('bronze'), []);
  assert.deepEqual(Ranks.unlockedFx('gold'), ['silver', 'gold']);
  assert.deepEqual(Ranks.unlockedFx('kwaai'), ['silver', 'gold', 'platinum', 'diamond', 'kwaai']);
  assert.ok(Ranks.fxAllowed('', null), 'plain is always allowed');
  assert.ok(Ranks.fxAllowed('silver', 'gold'));
  assert.ok(!Ranks.fxAllowed('diamond', 'gold'));
  assert.ok(!Ranks.fxAllowed('made-up', 'kwaai'));
});

test('a rank-up is a move to a higher step', () => {
  assert.ok(Ranks.rankedUp(Ranks.rankOf(59), Ranks.rankOf(60)));
  assert.ok(!Ranks.rankedUp(Ranks.rankOf(61), Ranks.rankOf(120)));
});
