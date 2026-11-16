# Study copilot: plan

Idea (16 November 2026): upload lecture PDFs and past papers; Kwaai builds flashcards, worked solutions and a spaced-repetition schedule.

## The honest weakness

- It is a fifth product. `docs/opportunities.md` already says Kwaai is four products kept alive by two students, and recommends no new work on the study side until reviews have real content. Student hub first (courses, planner) was the direction chosen on 14 November.
- Every upload costs money (model tokens) and carries risk: lecture slides and past papers are UCT or lecturer copyright, and student uploads are personal information sent to a processor probably outside South Africa (POPIA cross-border transfer).
- Worked solutions to past papers are often wrong when there is no memo. A confident wrong answer before an exam does harm.

So the proposal is the **smallest private version, under Study, not a new tab**: opt-in, each student's cards visible only to them, nothing shared, nothing about the feature on the home page until it works.

## Rules

1. Uploaded PDFs are **not stored**. Process in the request, keep only the cards made from them.
2. Cards and uploads are private to the account. No sharing, no leaderboards, no "popular decks".
3. Worked solutions carry a visible "AI-generated, may be wrong. Check against your memo" label. Say plainly when there is no memo to check against.
4. Student accounts only (`requireStudent`). Link lives in the phone More sheet's Study group and on `/study`.
5. Hard limits: file size, page count, per-student daily generation cap, and the existing `limit()` rate limiter. A global daily cap like `EMAIL_DAILY_CAP` stops a bill surprise.
6. No API key means the feature says it is unavailable. Production needs its own `ANTHROPIC_API_KEY` on Fly. Do not use the `ANTHROPIC_BASE_URL` in the harness shell.
7. `/privacy` and `/terms` change before launch: what is sent, to whom, how long, and that it can be deleted.

## Build order (one commit each, tests green)

1. **Scheduler** (`src/srs.js`, `test/srs.test.js`): SM-2, pure. Done in this branch.
2. **Cards, manual only**: table `cards (id, user_id, course, front, back, due, interval, ease, reps, lapses, created_at)`, add/review/delete routes, review queue one card at a time with Again, Hard, Good and Easy buttons (no JavaScript needed), due count on `/today` and `/study`. Wire the table into every deletion path: account delete (`src/app.js` near `DELETE FROM study_sessions`), the test-user list in `src/db.js` `cleanUp`, test tools clear, and the "download everything we hold" export. Use `Study.saDay` and `Study.addDay` for days. Cap due dates at the course's exam date with `Srs.capAtExam`.
3. **Generation**, behind an injected generator: pass it as a `createApp` option (like `sendLoginEmail`), build it in `server.js` only when the key is set, stub it in tests. Load the `claude-api` skill first; Claude takes PDFs directly as document input, so no PDF parser dependency. Upload route: no multipart parser is installed, so either add `busboy` or accept `express.raw({ type: 'application/pdf', limit })`. CSRF reads `_csrf` from the form body, so a raw upload needs the token in a header for that route.
4. **Worked solutions** for past-paper questions, with the label in rule 3.

## Decisions for Jaswin and Ubayd before step 3

- Who pays for the model calls, and the monthly cap?
- Is a student allowed to upload a lecturer's slides? Needs a line in the terms, and ideally an answer from a lecturer who would use it.
- Keep it opt-in behind a setting until the first 20 students have tried it.
