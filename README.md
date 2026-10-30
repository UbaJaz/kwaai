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
- **UCT-only sign-in** by a one-time emailed link to an `@myuct.ac.za` address, with no passwords. Reviews never show who wrote them.
- **Moderation built in:**
  - Comments are screened. Contact details and links are rejected. Possible allegations, insults, and remarks about appearance or identity are *held* for a moderator.
  - Every review has a **⚑ Report** button. Reports of defamation, private info or discrimination hide the review **immediately**. Other reasons hide it after 2 reports.
  - `/takedown` lets lecturers (no account needed) request removal, which hides the review straight away.
  - Students can suggest a missing lecturer. It only appears once a moderator approves it.
  - `/mod` lets moderators approve, remove, or remove and ban the author. Every decision goes into an audit log.
- **Your data, your call:** `/account` lists your reviews and lets you delete any of them or your whole account. `/privacy` is a POPIA notice and `/terms` the terms of use.
- **Hardening:** CSRF tokens on every form, a strict Content-Security-Policy and other security headers, per-IP rate limits (sign-in, reviews, reports, takedowns, suggestions), at most 3 sign-in emails per address per 15 minutes, and sign-in links built from `BASE_URL`, never the request's Host header.

## Data

About 1,360 courses from UCT's 2026 handbooks, downloaded from [uct.ac.za/students/study-uct-handbooks/handbooks](https://uct.ac.za/students/study-uct-handbooks/handbooks) on 30 Oct 2026:

| File | Handbook |
|---|---|
| `data/courses-ebe-2026.json` | Engineering & the Built Environment (7A) |
| `data/courses-sci-2026.json` | Science (11) |
| `data/courses-com-2026.json` | Commerce (6A) |
| `data/courses-hum-2026.json` | Humanities (9A) |
| `data/courses-fhs-2026.json` | Health Sciences (8A) |
| `data/courses-law-2026.json` | Law (10) |

For each course the importer keeps the official conveners plus what the handbook says about entry requirements, lecture times (and the lecture period, when one is given), DP requirements, assessment, and roughly how much of the mark is the final exam. A course written `CSC1015F/S` becomes two courses, CSC1015F and CSC1015S.

The PDFs and their text aren't committed. To add or update a handbook:

```bash
pdftotext -enc UTF-8 handbook.pdf handbook.txt
node scripts/import-handbook.js handbook.txt law-2026 "UCT 2026 Law handbook (10)"
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
   - `NODE_ENV` = `development`: dev mode, so sample data is seeded and sign-in links show on screen instead of being emailed. No Resend or domain needed.
   - `DEMO_PASSWORD` = a password you give only to the people you're demoing to. Every page asks for it (any username works). **Always set this in dev mode**: without it anyone with the link could sign in as any student.
   - `MODERATORS` = your @myuct.ac.za email, so you can show `/mod`.
3. Deploy. The first visit after it sleeps takes about a minute.

Don't use this for real reviews: they'd be lost on the next restart.

### Fly.io

`fly.toml` is set up for one machine in Johannesburg (`jnb`) with a 1 GB volume. Keep it at one machine: SQLite and the rate limits can't be shared between two.

```bash
fly launch --no-deploy --copy-config      # pick a free app name if lekker-or-nah is taken
fly volumes create lekker_data --region jnb --size 1
fly secrets set BASE_URL=https://… RESEND_API_KEY=… EMAIL_FROM="Kwaai <signin@…>" MODERATORS=… CONTACT_EMAIL=…
fly deploy
```

Backups: `fly ssh console -C "npm run backup"`, then `fly ssh sftp get /data/backups/<file>` to copy one off the server.

### Environment variables

| Variable | Required in production | What it is |
|---|---|---|
| `NODE_ENV` | yes | `production` (set by the Dockerfile) |
| `BASE_URL` | yes | Public URL, e.g. `https://kwaai.co.za`. Sign-in links use it. |
| `RESEND_API_KEY` | yes | From [resend.com](https://resend.com), which has a free tier. |
| `EMAIL_FROM` | yes | e.g. `Kwaai <signin@kwaai.co.za>`. The domain must be verified in Resend. |
| `MODERATORS` | yes | Comma-separated @myuct.ac.za emails that can use `/mod`. |
| `CONTACT_EMAIL` | yes | Shown in the privacy notice for POPIA requests. |
| `OPERATOR` | no | Who runs the site, shown in the privacy notice. Defaults to "the Kwaai team". |
| `TRUST_PROXY` | set by Dockerfile | `1` = trust one proxy hop, so rate limits see the real client IP. Set it to `0` only if nothing sits in front of the app. |
| `DB_FILE`, `BACKUP_DIR`, `PORT` | no | Paths and port. |

The server refuses to start in production if a required variable is missing.

### Backups

```bash
npm run backup
```

This writes a consistent copy to `backups/` (or `BACKUP_DIR`) while the site runs. Schedule it daily and copy the files off the server.

### Housekeeping the server does itself

Every hour it deletes expired sign-in links and sessions, plus moderator-removed reviews, handled takedown requests and closed lecturer suggestions older than 12 months, as the privacy notice promises.

## Launch checklist (things only you can do)

- [ ] **Get a lawyer to read `/privacy`, `/terms` and `/rules`.** They're careful drafts, not legal advice. UCT's Law Clinic or a POPIA-focused attorney is a cheap place to start.
- [ ] **Pick the operator details** (`OPERATOR`, `CONTACT_EMAIL`). Under POPIA, whoever runs the site is the responsible party.
- [ ] **Register a domain** and verify it in Resend. New sending domains often land in junk at first, so send yourself a few test sign-ins on a myuct address.
- [ ] **Create the hosting account**, a volume, and set the env vars.
- [ ] **Recruit 2–3 moderators** you trust, so takedowns get handled within the 48 hours the rules promise.
- [ ] **Schedule `npm run backup`.**
