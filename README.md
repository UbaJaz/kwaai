# LekkerOrNah 🤙

**Is your course lekker… or nah?** Unofficial, anonymous course and lecturer reviews by UCT students.

Not affiliated with the University of Cape Town. The name deliberately avoids "RateMyProfessor" (a US trademark) and doesn't put "UCT" or the UCT crest in the brand. "Lekker" is a South African word, so it's local, memorable and fun without making a specific lecturer the joke.

## What it does

- **Courses first.** Each review is for one *(course, lecturer, year)*, because big courses rotate lecturers.
- **Structured ratings.** Four sliders (teaching, fun & interactive, exam fairness, approachable) make up the star score. Exam difficulty and workload are shown separately, because hard isn't the same as bad. Reviewers add up to 3 tags and an optional comment of 280 characters or less.
- **Rankings** per department and category: highest rated, funniest, hardest exams, fairest exams, heaviest workload, lowest rated. Anything needs at least 3 reviews to be ranked.
- **UCT-only sign-in** by a one-time link to an `@myuct.ac.za` email, with no passwords. Reviews never show who wrote them.
- **Moderation built in:**
  - Comments are screened. Contact details and links are rejected. Possible allegations, insults, and remarks about appearance or identity are *held* for a moderator.
  - Every review has a **⚑ Report** button. Reports of defamation, private info or discrimination hide the review **immediately**. Other reasons hide it after 2 reports.
  - `/takedown` lets lecturers (no account needed) request removal, which hides the review straight away.
  - `/mod` lets moderators approve, remove, or remove and ban the author. Every decision goes into an audit log.
  - Students can delete their own reviews.
- **House rules, privacy and takedown info** are at `/rules`.

## Data

- `data/courses-ebe-2026.json` holds 219 courses parsed from the **UCT 2026 EBE undergraduate handbook (7A)**, including official course conveners. To add another faculty:
  ```bash
  pdftotext -enc UTF-8 handbook.pdf handbook.txt
  node scripts/import-handbook.js handbook.txt sci-2026 "UCT 2026 Science handbook"
  npm run seed
  ```
- `data/courses-extra.json` holds courses outside that handbook, such as PHY1012F.
- **Sample data:** the seed adds made-up lecturers ("Prof Sample Alpha"…) and reviews on 14 real courses so the site looks alive. They're flagged `is_sample` and carry a purple **SAMPLE** badge. Run `SAMPLES=0 npm run seed` before going live. No sample review is attached to a real person.

## Run it

Needs Node 22.13+ (it uses the built-in `node:sqlite`).

```bash
npm install
npm run seed
MODERATORS=you@myuct.ac.za npm run dev
```

Open http://localhost:3000. In dev mode the sign-in link is shown on screen instead of emailed.

```bash
npm test
```

## Before launch (not done yet)

- **Email sending.** The server refuses to start with `NODE_ENV=production` until sign-in emails are wired up (Resend, SES or SMTP) in `server.js`.
- **Hosting and backups.** It's a single SQLite file, `lekker.db`. Back it up.
- **CSRF tokens.** Right now this relies on `SameSite=Lax` cookies.
- **Rate limits** on sign-in, reports and takedown requests.
- **More handbooks** (Science, Commerce, Humanities…), and a way to suggest a missing lecturer that a moderator approves.
- **Legal read-through** of `/rules` (POPIA notice, takedown policy). UCT's Law Clinic is a cheap place to start.
- `SAMPLES=0` reseed.
