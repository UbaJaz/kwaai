// Study ranks. A rank comes from hours of timed study (the timer's rules and caps in src/study.js), so nobody can type
// their way up. There are two ladders:
//   - lifetime: every hour ever timed. It never goes down.
//   - season: the hours in one semester. It starts again at each semester, like ranked play in games.
// Five metal tiers with three divisions each, then one top tier, Kwaai. Ranks only unlock looks (a badge, name
// styles, a card frame); they never add hours.
const { addDay } = require('./study');

const TIERS = ['bronze', 'silver', 'gold', 'platinum', 'diamond', 'kwaai'];
const TIER_NAMES = { bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum', diamond: 'Diamond', kwaai: 'Kwaai' };
const DIVISIONS = ['I', 'II', 'III'];

// hours to reach each step, lowest first: [tier, division (0 to 2, or null for Kwaai), hours]
const ladder = (hours) => TIERS.flatMap((tier, t) => (tier === 'kwaai'
  ? [[tier, null, hours[15]]]
  : [0, 1, 2].map((d) => [tier, d, hours[t * 3 + d]])));
const LIFETIME = ladder([1, 5, 10, 20, 35, 50, 75, 100, 150, 200, 275, 350, 450, 600, 750, 1000]);
const SEASON = ladder([1, 3, 6, 10, 15, 20, 30, 40, 55, 70, 90, 110, 135, 160, 190, 225]);

const stepLabel = ([tier, division]) => (division == null ? TIER_NAMES[tier] : `${TIER_NAMES[tier]} ${DIVISIONS[division]}`);

// minutes of timed study on one ladder: the step reached, the next one, and how far along the way to it
function rankOf(minutes, steps = LIFETIME) {
  const min = Math.max(0, Math.floor(minutes || 0));
  let at = -1;
  while (at + 1 < steps.length && min >= steps[at + 1][2] * 60) at++;
  const step = steps[at] || null;
  const next = steps[at + 1] || null;
  const from = step ? step[2] * 60 : 0;
  return {
    minutes: min,
    step: at, // -1 is unranked
    tier: step ? step[0] : null,
    division: step ? step[1] : null,
    label: step ? stepLabel(step) : 'Unranked',
    next: next ? { tier: next[0], label: stepLabel(next), minutes: next[2] * 60 } : null,
    toNextMin: next ? next[2] * 60 - min : 0,
    progress: next ? (min - from) / (next[2] * 60 - from) : 1,
  };
}

// the semester a day falls in, as a season: semester 1 runs from 1 January to the day before semester 2 starts, and
// semester 2 to 31 December. Years without term dates split on 15 July.
function seasonOf(day, terms = {}) {
  const year = day.slice(0, 4);
  const s2 = terms[year]?.s2?.start ?? `${year}-07-15`;
  return day < s2
    ? { key: `${year}-s1`, name: `Semester 1 ${year}`, from: `${year}-01-01`, to: addDay(s2, -1) }
    : { key: `${year}-s2`, name: `Semester 2 ${year}`, from: s2, to: `${year}-12-31` };
}

// the season before this one
const previousSeason = (season, terms) => seasonOf(addDay(season.from, -1), terms);

// name styles, in the order they unlock: each tier unlocks its own style and keeps the ones below it
const NAME_FX = {
  bronze: 'Bronze badge',
  silver: 'Silver name',
  gold: 'Gold gradient',
  platinum: 'Platinum shimmer',
  diamond: 'Diamond glint',
  kwaai: 'Kwaai glow',
};
// the styles a lifetime tier has unlocked (the bronze badge shows for everyone ranked, so it isn't a pickable style)
const unlockedFx = (tier) => (tier ? TIERS.slice(1, TIERS.indexOf(tier) + 1) : []);
const fxAllowed = (fx, tier) => !fx || unlockedFx(tier).includes(fx);

// did a session move someone up? before and after are rankOf() results
const rankedUp = (before, after) => after.step > before.step;

module.exports = { TIERS, TIER_NAMES, DIVISIONS, LIFETIME, SEASON, NAME_FX, rankOf, seasonOf, previousSeason, unlockedFx, fxAllowed, rankedUp, stepLabel };
