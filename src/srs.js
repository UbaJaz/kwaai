// Spaced repetition for flashcards: SM-2, the scheduler Anki's classic mode uses. Pure functions, no database, so it
// is easy to test. Days are 'YYYY-MM-DD' in South African time, the same as the rest of Kwaai (src/study.js).
const { addDay } = require('./study');

const START_EASE = 2.5;
const MIN_EASE = 1.3;
const GRADES = ['again', 'hard', 'good', 'easy'];

// A new card starts with no history. due = the day it first shows up.
const newCard = (today) => ({ due: today, interval: 0, ease: START_EASE, reps: 0, lapses: 0 });

// The card after one review. 'again' sends it back to tomorrow-ish (a lapse); the others stretch the gap.
function review(card, grade, today) {
  if (!GRADES.includes(grade)) throw new Error(`unknown grade: ${grade}`);
  let { interval, ease, reps, lapses } = card;
  if (grade === 'again') {
    reps = 0; lapses += 1; interval = 1; ease = Math.max(MIN_EASE, ease - 0.2);
  } else {
    if (grade === 'hard') ease = Math.max(MIN_EASE, ease - 0.15);
    if (grade === 'easy') ease += 0.15;
    reps += 1;
    if (reps === 1) interval = grade === 'easy' ? 4 : 1;
    else if (reps === 2) interval = grade === 'easy' ? 8 : grade === 'hard' ? 3 : 6;
    else interval = Math.max(interval + 1, Math.round(interval * ease * (grade === 'hard' ? 0.8 : grade === 'easy' ? 1.3 : 1)));
  }
  return { due: addDay(today, interval), interval, ease: Math.round(ease * 100) / 100, reps, lapses };
}

// Spread the work before an exam: nothing is scheduled past the exam day, and a card due later is pulled in to the
// day before it, so every card has been seen at least once by then.
const capAtExam = (card, examDay) => (examDay && card.due >= examDay ? { ...card, due: addDay(examDay, -1) } : card);

module.exports = { START_EASE, MIN_EASE, GRADES, newCard, review, capAtExam };
