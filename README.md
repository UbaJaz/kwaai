# Kwaai

**Find out if a course is kwaai before you register.** Unofficial course ratings, workload scores and tips from South African university students, starting at UCT.

Not affiliated with any university. "Kwaai" is South African slang that means both "cool" and "strict", which covers a great course and a brutal exam. The brand avoids "RateMyProfessor" (a US trademark) and never uses a university's name, crest or logo as part of it.

## Brand

- **Colours:** ink `#151d2b`, lime `#c8f169` (only ever a fill behind ink text), paper `#f7f7f2`. Defined at the top of `public/style.css`.
- **Type:** Bricolage Grotesque for headings, Inter for everything else.
- **Logo:** `public/kwaai-icon.svg`; the wordmark is live text, lowercase `kwaai`.
- **Universities:** each one gets an accent colour in `src/universities.js`, used only for the band under the header, the university picker, labels and course codes. The Kwaai colours never change. Accents are our own picks, not official brand values, and a test checks they're dark enough to read.

## What it does

- **Courses first.** Each review is for one *(course, lecturer, year)*, because big courses rotate lecturers.
- **Structured ratings.** Four sliders (teaching, fun & interactive, exam fairness, approachable) make up the star score. Exam difficulty and workload are shown separately, because hard isn't the same as bad. Reviewers add up to 3 tags and an optional comment of 280 characters or less.
- **Rankings** per department and category: highest rated, funniest, hardest exams, fairest exams, heaviest workload, lowest rated. Anything needs at least 3 reviews to be ranked.
- **UCT-only sign-in** with no passwords: we email a 6-digit code and a link to an `@myuct.ac.za` address, and either one works once within 15 minutes. Opening the link shows a **Sign in** button rather than signing in straight away, because Microsoft 365 (which runs myuct mail) opens links to scan them. Five wrong codes and the code stops working. Reviews never show who wrote them.
- **Moderation built in:**
  - Comments are screened. Contact details and links are rejected. Possible allegations, insults, and remarks about appearance or identity are *held* for a moderator.
  - Every review has a **⚑ Report** button. Reports of defamation, private info or discrimination hide the review **immediately**. Other reasons hide it after 2 reports.
  - `/takedown` lets lecturers (no account needed) request removal, which hides the review straight away.
  - Students can suggest a missing lecturer. It only appears once a moderator approves it.
  - `/mod` lets moderators approve, remove, or remove and ban the author. Every decision goes into an audit log.
- **Your semester, planned:**
  - `/plan` checks a course list against the handbooks: clashes, entry requirements, credits and what your major still needs.
  - `/week` turns it into a timetable with lectures, tut and prac groups, your own blocks and study time, plus a calendar link that follows your plan.
  - `/year` shows both semesters, UCT's term dates, exams and when to start revising.
- **Filled in by students:** each course page has "This course's week", where students add times, weekly topics and test and exam dates. A detail is confirmed once two students agree, and then reaches everyone's timetable and calendar.
- **Marks and DP** (`/marks`): handbook weights, DP minimum and exam subminimum, then the exam mark you need to pass, get a 2:1 or a first. Marks stay in the student's browser. `/today` is the daily view, with today's classes, the next two weeks and DP alerts.
- **Study timer** (`/study`): pick a course and a length (25, 50 or 90 minutes), and the open page sends a heartbeat about once a minute. Only heartbeat time counts, capped at the planned length plus 5 minutes and 14 hours a day, so nobody can type hours in. Rules are in `src/study.js`. Signed in, the page shows a GitHub-style heatmap of the last 12 months, totals for today, this week and this month, and this week's time per course next to the hours its credits suggest. A day with 30 minutes keeps a streak going; UCT vacations pause it (missing a vacation day never ends it, studying on one still counts), and /week can add a daily "Study for 30 minutes" reminder to the calendar feed.
- **Study leaderboards** (`/study/leaderboards`): today, this week and this month, for the whole university or one faculty. Opt-in only: a student ticks "Put me on the leaderboards" in `/account/profile` and picks a display name or an anonymous label ("2nd-year Computer Science student"). Two reports hide a name until a moderator allows or removes it. Leaving deletes the profile at once.
- **Installable:** a web app manifest and service worker (`public/sw.js`) let students add Kwaai to their home screen. Today, the week, the year and Marks work offline. Sign-in, account and moderation pages are never cached.
- **Your data, your call:** `/account` lists your reviews and lets you delete any of them or your whole account. `/privacy` is a POPIA notice and `/terms` the terms of use.
- **Hardening:** CSRF tokens on every form, a strict Content-Security-Policy and other security headers, per-IP rate limits (sign-in, reviews, reports, takedowns, suggestions), at most 3 sign-in emails per address per 15 minutes, and sign-in links built from `BASE_URL`, never the request's Host header.

## Data

About 3,160 courses, undergraduate and postgraduate, from UCT's ten 2026 handbooks, downloaded from [uct.ac.za/students/study-uct-handbooks/handbooks](https://uct.ac.za/students/study-uct-handbooks/handbooks) on 30 Oct 2026:

| File | Handbook |
|---|---|
| `data/courses-com-2026.json` | Commerce undergraduate (6A) |
| `data/courses-com-pg-2026.json` | Commerce postgraduate (6B) |
| `data/courses-ebe-2026.json` | Engineering & the Built Environment undergraduate (7A) |
| `data/courses-ebe-pg-2026.json` | Engineering & the Built Environment postgraduate (7B) |
| `data/courses-fhs-2026.json` | Health Sciences undergraduate (8A) |
| `data/courses-fhs-pg-2026.json` | Health Sciences postgraduate (8B) |
| `data/courses-hum-2026.json` | Humanities undergraduate (9A) |
| `data/courses-hum-pg-2026.json` | Humanities postgraduate (9B) |
| `data/courses-law-2026.json` | Law (10) |
| `data/courses-sci-2026.json` | Science (11) |
| `data/courses-tables-2026.json` | Undergraduate courses that only appear in curriculum tables, with no description (e.g. PHI2043S) |
| `data/replaced-2026.json` | Old codes the handbooks say were replaced (MAM1000W by MAM1031F and MAM1032S) |
| `data/staff-2026.json` | About 1,060 teaching staff (professors and lecturers) from each department's staff list. The handbooks don't say who teaches which course, so staff are linked to their department and shown as "in the department"; only conveners are linked to a course. |
| `data/terms.json` | UCT's 2026 and 2027 semester dates and vacations, from [uct.ac.za/students/calendar/terms](https://uct.ac.za/students/calendar/terms) (read 1 Nov 2026), for the week view's calendar file. |
| `data/programmes-2026.json` | 156 majors and programmes with the courses required each year, read from the curriculum tables, plus each faculty's credit rules (typed in by hand, with the rule number) |

For each course the importer keeps the official conveners plus what the handbook says about entry requirements, lecture times (and the lecture period, when one is given), DP requirements, assessment, roughly how much of the mark is the final exam, and whether it's "not offered in 2026". A course written `CSC1015F/S` becomes two courses, CSC1015F and CSC1015S. Dissertations and theses are left out: they aren't taught courses.

The PDFs and their text aren't committed. To add or update a handbook:

```bash
pdftotext -enc UTF-8 handbook.pdf handbooks/handbook.txt
node scripts/import-handbook.js handbooks/handbook.txt law-2026 "UCT 2026 Law handbook (10)"
node scripts/import-tables.js handbooks/   # after all handbooks: table-only courses and replaced codes
node scripts/import-programmes.js handbooks/   # majors and programmes per year, into data/programmes-2026.json
node scripts/import-staff.js handbooks/        # department teaching staff, into data/staff-2026.json
npm run seed
```

`npm run seed` is safe to re-run on a live site. Once real reviews exist it never deletes them: it only adds or updates courses and swaps the demo data.

**Sample data:** in dev, the seed adds made-up lecturers ("Prof Sample Alpha"…) and reviews on 14 real courses so the site looks alive. They're flagged `is_sample` and carry a purple **SAMPLE** badge everywhere a score shows. Production never seeds them. `SAMPLES=0 npm run seed` removes them from an existing database.

## Run it locally

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

## Deploy

It's one Node process with one SQLite file, so it needs a host with a **persistent disk**: Fly.io (volume), Railway (volume), Render (paid disk) or any small VPS. Serverless hosts like Vercel won't keep the database.

The `Dockerfile` stores the database at `/data/lekker.db` (the old name is kept so existing volumes keep working), so mount a volume at `/data`.

### Free private demo on Render

For showing the site to people before launch. Render's free plan has no persistent disk, so the database resets whenever the app restarts or sleeps (after 15 minutes idle). It rebuilds with all courses and the sample reviews each time, which is what a demo needs.

1. On render.com: **New → Web Service**, connect the GitHub repo. Render finds the `Dockerfile`. Pick the **Free** instance type.
2. Add environment variables:
   - `NODE_ENV` = `development`: dev mode, so sample data is seeded.
   - `DEMO_PASSWORD` = a password you give only to the people you're demoing to. Every page asks for it (any username works).
   - `MODERATORS` = your @myuct.ac.za email, so you can show `/mod`.
3. To send real sign-in emails (recommended, see below), also set `BREVO_API_KEY`, `EMAIL_FROM` and `BASE_URL` = `https://kwaai.onrender.com`. Without them the sign-in code and link show on screen, so **anyone could sign in as any student**: keep `DEMO_PASSWORD` set in that case.
4. Deploy. The first visit after it sleeps takes about a minute.

#### Sign-in emails with Brevo (free, no domain needed)

Render's free plan blocks SMTP, so emails go through Brevo's HTTP API. The free plan sends 300 emails a day.

1. Sign up at [brevo.com](https://www.brevo.com) (free plan).
2. In Brevo's settings, find **Senders** and add one: an address you can open, e.g. a Gmail you make for Kwaai. Click the link Brevo emails you to verify it.
3. In the settings, find **SMTP & API → API keys** and generate a key. Copy it straight away; Brevo only shows it once.
4. On Render, set `BREVO_API_KEY` to that key, `EMAIL_FROM` to `Kwaai <the-sender-you-verified>` and `BASE_URL` to `https://kwaai.onrender.com`.
5. Sign in with your own myuct address to test. The first emails may land in **Junk** or **Other**: mark them "Not junk". A sender on your own domain (later, with Resend or Brevo) lands in the inbox more reliably.

Don't use this for real reviews: they'd be lost on the next restart.

### Fly.io

`fly.toml` is set up for one machine in Johannesburg (`jnb`) with a 1 GB volume. Keep it at one machine: SQLite and the rate limits can't be shared between two.

```bash
fly launch --no-deploy --copy-config      # pick a free app name if lekker-or-nah is taken
fly volumes create lekker_data --region jnb --size 1
fly secrets set BASE_URL=https://… BREVO_API_KEY=… EMAIL_FROM="Kwaai <signin@…>" MODERATORS=… CONTACT_EMAIL=…
fly deploy
```

Backups: `fly ssh console -C "npm run backup"`, then `fly ssh sftp get /data/backups/<file>` to copy one off the server.

### Environment variables

| Variable | Required in production | What it is |
|---|---|---|
| `NODE_ENV` | yes | `production` (set by the Dockerfile) |
| `BASE_URL` | yes, and whenever an email key is set | Public URL, e.g. `https://kwaai.onrender.com`. Sign-in links use it. |
| `BREVO_API_KEY` | this or `RESEND_API_KEY` | From [brevo.com](https://www.brevo.com). Free, and works with one verified sender address, no domain. Used first if both are set. |
| `RESEND_API_KEY` | this or `BREVO_API_KEY` | From [resend.com](https://resend.com). Needs a verified domain to email students. |
| `EMAIL_FROM` | yes, and whenever an email key is set | e.g. `Kwaai <kwaai.signin@gmail.com>`. Must be the sender verified in Brevo, or on the domain verified in Resend. |
| `MODERATORS` | yes | Comma-separated @myuct.ac.za emails that can use `/mod`. |
| `CONTACT_EMAIL` | yes | Shown in the privacy notice for POPIA requests. |
| `OPERATOR` | no | Who runs the site (the POPIA responsible party), shown in the privacy notice. Defaults to "Ubayd Hattas and Jaswin Chinthala". |
| `INFORMATION_OFFICER` | before launch | The one person named as POPIA information officer. Defaults to `OPERATOR`. |
| `EMAIL_DAILY_CAP` | no | Sign-in emails per day before the site pauses sending. Defaults to 280, under Brevo's free 300. |
| `TRUST_PROXY` | set by Dockerfile | `1` = trust one proxy hop, so rate limits see the real client IP. Set it to `0` only if nothing sits in front of the app. |
| `DB_FILE`, `BACKUP_DIR`, `PORT` | no | Paths and port. |

The server refuses to start in production if a required variable is missing.

### Backups

```bash
npm run backup
```

This writes a consistent copy to `backups/` (or `BACKUP_DIR`) while the site runs, and deletes backups older than 30 days (the privacy notice promises deleted data is gone from backups within 30 days). Schedule it daily and copy the files off the server.

### Housekeeping the server does itself

Every hour it deletes expired sign-in links and sessions, plus moderator-removed reviews, handled takedown requests, closed lecturer suggestions and moderation-log entries older than 12 months, as the privacy notice promises.

### Abuse limits

- Only the newest sign-in code for an address works.
- An address gets at most 20 code guesses an hour across all IPs. After that, codes pause for an hour, but the link in the email still signs the student in.
- Each IP can request 30 sign-in emails an hour, and sending stops at `EMAIL_DAILY_CAP` a day.
- A student's report for a serious reason (false allegation, private details) hides a review straight away, up to 3 times a day. After that it waits for a second reporter.
- Once a moderator approves a review, later reports and removal requests go to the queue without hiding it again.

Limits are kept in memory, so they reset when the app restarts.

## Launch checklist (things only you can do)

Step-by-step email, contact and POPIA setup: [`docs/email-setup.md`](docs/email-setup.md).

- [ ] **Persistent database.** Render's free plan wipes it on sleep. Move to a plan with a disk (about $7 a month) before inviting real students.
- [ ] **Get a lawyer to read `/privacy`, `/terms` and `/rules`.** They're careful drafts, not legal advice. UCT's Law Clinic or a POPIA-focused attorney is a cheap place to start.
- [ ] **Name the information officer** (`INFORMATION_OFFICER`) and register them with the Information Regulator if the lawyer confirms it applies.
- [ ] **Domain, Brevo and contact address**, following `docs/email-setup.md`. Send test sign-ins to a few myuct addresses.
- [ ] **Switch to production:** `NODE_ENV=production`, remove `DEMO_PASSWORD`, check `TRUST_PROXY`.
- [ ] **Moderators:** check `/mod` daily, so removal requests get handled within the 48 hours the rules promise.
- [ ] **Schedule `npm run backup`.**
