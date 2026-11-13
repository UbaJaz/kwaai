# Kwaai audit

Date: 12 November 2026. Commit audited: `9e3c3f4` on `main`. Report only, no code changed.

## How this was done

- Read in full: `server.js`, `src/app.js`, `src/db.js`, `src/classes.js`, `src/moderation.js`, `src/admin.js`, `src/email.js`, `src/ranks.js`, `src/ratings.js`, `src/universities.js`, `src/html.js`, `scripts/seed.js`, `public/sw.js`, `Dockerfile`, `fly.toml`, `README.md`, `docs/email-setup.md`.
- Read in part: `src/views.js` (layout, review and course pages, home, lecturer page, every class and attendance page, rules, about, privacy, terms, account, sign-in, takedown, moderation). `public/style.css` (first 150 lines plus counts of colours and sizes).
- Not read line by line: the planner, week, year, marks, study and leaderboard templates in `src/views.js` (lines 967 to 1737), `src/planner.js`, `src/week.js`, `src/year.js`, `src/facts.js`, `src/quests.js`, `src/study.js`, `src/testdata.js`, the import scripts, most of `public/app.js` (searched for risky calls only) and most of `test/app.test.js` (test names only). Findings in those areas may be missing.
- Ran: `npm test` (145 of 145 pass, about 125 seconds) and `npm audit --omit=dev` (0 vulnerabilities).
- Reproduced four findings with a script against a throwaway database (marked **Reproduced** below). The script lives outside the repo.
- Not done: no page was opened in a browser, and nothing was tested on the live Render service.

## Summary

| Severity | Count | Worst of them |
|---|---|---|
| Critical | 3 | A hidden review's text is readable by anyone at `/takedown?review=N` |
| High | 8 | Anyone can hide any review with the takedown form, no account needed |
| Medium | 10 | Keyword screening is the only thing between a comment and the page |
| Low | 8 | |

What is in good shape: every template value is escaped (`src/html.js`), the Content-Security-Policy blocks inline scripts, SQL uses parameters throughout, forms carry CSRF tokens, sign-in codes and sessions are stored as hashes, students cannot reach lecturer, moderator or admin routes (each class route checks membership and role, and returns 404), the app writes no request logs and has no analytics, and no secret is committed (`.env` is ignored and was not read).

## Critical

### C1. Hidden reviews are readable through the takedown page. Reproduced.
- **Where:** `src/app.js:1349`, `src/views.js:2717`.
- **What:** `/takedown?review=N` loads any review whose status is not `removed` and prints its comment. That includes `held` reviews: the ones hidden because they were reported as defamatory or caught by the screen. No sign-in is needed and review numbers count up from 1, so anyone can read every hidden comment by trying numbers.
- **Why it matters:** the whole point of hiding a review is that nobody can read it while a moderator decides. This is the text most likely to be defamatory. It also skips the "vote to read more" gate.
- **Fix:** only quote the review when `status = 'published'`. Otherwise show "Review #N on COURSE" with no text. Add a test.

### C2. Reviews are tied to the student's email by a plain column, and the privacy notice says otherwise.
- **Where:** `src/db.js:65` (`reviews.user_id`), `src/db.js:86` (`verdicts.user_id`), `src/db.js:136` (`course_facts.user_id`), `REPORT_DETAILS` at `src/db.js:374`. Claim at `src/views.js:2459`.
- **What:** one join from `reviews` to `users` gives the email, and a myuct email is the student number. Anyone holding the database file, a backup from `scripts/backup.js`, or the Render account can list who wrote what. A copy (`lekker.db`) sits on a laptop. The privacy notice says moderators can see hidden reviews "but not which student wrote a review". That is true of the `/mod` page and false of the people who run the site, who are the moderators.
- **Why it matters:** anonymity is the product's promise. A lost laptop or one leaked backup breaks it for every student at once.
- **Fix, two parts:**
  1. Now: reword the promise to what is true. "Readers, lecturers and UCT never see who wrote a review. The two people who run Kwaai could work it out from the database. We don't, and here is when the law could force us to."
  2. Before launch: replace `user_id` on `reviews`, `verdicts`, `reports` and `course_facts` with `author_key = HMAC-SHA256(AUTHOR_KEY, user id)`, where `AUTHOR_KEY` is an environment variable that is never in the database or its backups. One review per student, "my reviews", delete-my-account and banning all still work (compute the key for the signed-in student; for a ban, compute the key for each user until one matches). A leaked database then links nothing. There are no real reviews yet, so the change needs no data migration worth worrying about.

### C3. The class features collect personal information the privacy notice does not mention.
- **Where:** `src/views.js:2438-2453` (what the notice lists), `src/app.js:1886` (class list paste), `src/db.js:311` (`class_roster`), `src/db.js:8` (`attendance`), `src/app.js:2177` (`kdev` device cookie).
- **What:** the notice covers reviews, the timer, leaderboards and groups. It says nothing about staff accounts, classes, student numbers shown to lecturers and tutors, attendance registers, DP status, announcements, pulse checks, the device cookie or the calendar cookie. It says of study sessions "Nobody else sees them" (`src/views.js:2445`), which stops being true the moment a student joins a class. The same bullet is also written twice (lines 2445 and 2446). The class list feature stores student numbers and names of students who never signed up, pasted in by a lecturer.
- **Why it matters:** under POPIA people must be told what is collected and why. A lecturer pasting a UCT class list into an unofficial site is also a decision UCT may not allow, and that is their data, not the lecturer's.
- **Fix:** rewrite the notice to cover classes before any real lecturer uses them. In the lecturer demo, accept only fictional class lists (see `docs/lecturer-demo.md`). Before a real pilot, ask UCT (or the lawyer already on the launch checklist) whether a lecturer may upload a class list.

## High

### H1. Anyone can hide any review, instantly, without an account.
- **Where:** `src/app.js:1353-1365`, limit at `src/app.js:155`.
- **What:** the takedown form hides the named review as soon as it is submitted. The only checks are a name, something shaped like an email and some text. The limit is 10 an hour per IP address, held in memory.
- **Why it matters:** one person can blank every negative review on the site in an afternoon, and two moderators cannot keep up. It also teaches lecturers that one form removes criticism.
- **Fix:** hide straight away only when the request is verified: the person is signed in with a `@uct.ac.za` address, or confirms a code emailed to the address they typed. Unverified requests go to the moderator queue and the review stays up.

### H2. Small classes are not anonymous.
- **Where:** `src/app.js:289` (reviews listed from the first one), `src/app.js:287` (per lecturer and year table).
- **What:** a review shows its course, lecturer and year as soon as it is posted. 1,884 of the 3,160 courses are NQF level 8 or higher (counted from the seeded database), and many have a handful of students. One review of an honours course with six students tells the lecturer who wrote it, more so if the lecturer also runs that class on Kwaai and can see its members.
- **Why it matters:** this is the realistic way a student gets identified, and it needs no database access.
- **Fix:** show written comments and the per-lecturer breakdown only once a course has 5 reviews (the same number already used for "Time it takes", `Study.HOURS_MIN_STUDENTS`). Below that, count the ratings towards the course score and say "4 more reviews until comments show". Apply the same rule to tips.

### H3. A class rep or tutor who added a class date cannot delete their account. Reproduced.
- **Where:** `src/db.js:248` (`class_dates.added_by` references `users`), `src/app.js:1153-1185` (the delete, which never clears it).
- **What:** the final `DELETE FROM users` fails with "FOREIGN KEY constraint failed", the transaction rolls back and the student sees "Something broke".
- **Why it matters:** the privacy notice promises deletion. This breaks it for exactly the students most involved in a class.
- **Fix:** add `UPDATE class_dates SET added_by = NULL WHERE added_by = ?` to the delete, and a test that a rep with a date can delete their account.

### H4. A class list over about 450 students is rejected. Reproduced.
- **Where:** `src/app.js:80` (form bodies capped at 20 KB), `src/classes.js:90` (`ROSTER_MAX = 3000`).
- **What:** 450 lines of "number, name, tut, prac" come to 20.2 KB and get HTTP 413 with the message "That request didn't work".
- **Why it matters:** first-year courses are the ones with the DP and register problem, and they are the largest. A lecturer trying the demo with a big list hits a dead end.
- **Fix:** a larger limit (300 KB) on the class list route only, and a 413 message that says the list is too long.

### H5. Lecturer pages are public, can be indexed, and feed a "lowest rated" list. Reproduced.
- **Where:** `src/app.js:316` (no sign-in), no `robots.txt` in `public/`, no `X-Robots-Tag` header, `src/ratings.js:35`, `src/app.js:327`.
- **What:** 1,745 real staff names are in the database, each with a public page. Nothing tells search engines to stay away. `/rankings?cat=lowest&kind=lecturer` ranks named people from the bottom.
- **Why it matters:** "Dr X, 1.8 out of 5" appearing on Google under someone's name is the fastest route to a legal letter and to UCT staff turning against the project.
- **Fix:** add `robots.txt`, send `X-Robots-Tag: noindex` on lecturer pages and lecturer rankings, send it on every page of the demo, and remove the "Lowest rated" category for lecturers. See `docs/opportunities.md` for the case for dropping lecturer rankings altogether.

### H6. Every cold start rebuilds the whole database.
- **Where:** `server.js:39-42`.
- **What:** Render's free plan has no disk, so the database is empty on each start and the server seeds 3,160 courses and 1,759 lecturers before it listens. That took 8.4 seconds on this laptop. It comes on top of Render's own start-up of about a minute. Render's free CPU is smaller than a laptop's, so expect longer; this was not measured on Render.
- **Fix:** see "Performance and hosting" below.

### H7. The demo setup lets anyone sign in as any UCT address, staff included.
- **Where:** `src/app.js:1415-1416`, `README.md` step 3 of the Render section.
- **What:** with `NODE_ENV=development` and no email key, the sign-in code is printed on the page. The README says to keep `DEMO_PASSWORD` set in that case. In the same mode cookies are not marked `Secure` and HSTS is off (`src/app.js:55`, `101`, `2538`).
- **Why it matters:** a lecturer demo needs no-friction entry, which pulls towards removing the password. Without it, a visitor can type a colleague's address and act as them.
- **Fix:** a separate `DEMO_MODE` that never touches real addresses (throwaway `@kwaai.invalid` accounts) and keeps production cookie settings. Details in `docs/lecturer-demo.md`.

### H8. Any staff address can post "official" dates for any course.
- **Where:** `src/app.js:1456` (class creation needs only a staff address), `src/app.js:458-460` and `1564` (class dates reach everyone with the course in their plan, labelled "From the lecturer").
- **What:** nothing checks that the person teaches the course. Tutors and class reps, who are students, can add dates too, and theirs also win over student-added dates.
- **Why it matters:** a wrong test date marked official, in every student's calendar, is real harm. Not a demo issue, a launch issue.
- **Fix:** until a moderator has confirmed a class (or its owner's name matches the handbook convener), show its dates only to class members and label them "From a class on Kwaai".

## Medium

| # | Where | What is wrong | Fix |
|---|---|---|---|
| M1 | `src/moderation.js` | Screening is keyword lists. It holds harmless text ("black box", "hot topic", "male", "man") and misses anything spelled creatively. It cannot spot a named person: a review can name a tutor or a classmate. | For the first weeks after launch, hold every written comment for a moderator. Ratings and tags publish at once. Revisit when volume is known. |
| M2 | `src/app.js:2064-2079` | A lecturer can make any student a tutor without the student agreeing; `consent_at` is stamped anyway. The error "hasn't signed in to Kwaai yet" tells the lecturer whether a given student has an account. | Send an invitation the tutor accepts. Give one message whether or not the account exists. |
| M3 | `src/app.js:1389` | The sign-in form says "This account has been suspended" for any address typed, before the person proves it is theirs. Anyone can check whether a classmate was banned. | Always show "check your inbox". Put the suspension message in the email or after the code is entered. |
| M4 | `server.js:45-56`, `src/app.js:1686` | Pasted class lists are deleted "30 days after the year ends" only if someone opens the class after that date. Attendance, study sessions and idle accounts are never deleted and the notice gives no period for them. | Move the class list deletion into the hourly clean-up. Decide and publish a period for attendance and for accounts unused for, say, 24 months. |
| M5 | `src/app.js:123-135`, `1382` | Rate limits live in memory and the daily email count lives in a database that the free plan wipes. On free Render both reset every time the app sleeps (15 idle minutes). | Accept for the demo. Solved by the paid disk already planned for launch; then move limits into SQLite. |
| M6 | `src/classes.js:13`, no route | The permissions table says a lecturer can delete a class. There is no delete or archive route and no button. The only way out is deleting the account. | Add delete (with a typed confirmation) and "archive at year end". |
| M7 | `src/app.js:1815-1817`, `src/views.js:1910` | The Amathuba grade file has never been tried against Amathuba. The page says so. | Test with one real course admin, or hide the link until then. |
| M8 | `src/views.js:1972` | The join screen says the lecturer sees "your streak". The dashboard shows no streak. Consent text must match what is shown. | Remove "and your streak", or show it. |
| M9 | `src/classes.js:253-254` | A scanned attendance link works for about a minute, so a student can send it to a friend who is not in the room. The same-phone flag does not catch that. | Say so plainly to lecturers. Keep the tap register as the record and the QR as a convenience. |
| M10 | `src/app.js:45-52` | `DEMO_PASSWORD` uses the browser's password pop-up on every request. That blocks WhatsApp link previews, calendar subscriptions and installing the app, and it is the first thing a lecturer would see. | Do not use it for the lecturer demo. Use the demo mode in `docs/lecturer-demo.md` with `noindex`. |

## Low

| # | Where | What is wrong | Fix |
|---|---|---|---|
| L1 | `src/app.js:1425` | Admin sign-in pauses for everyone after 20 tries a day, counted globally. Anyone can lock the admin out daily. | Count per IP only, and keep the 5 per 15 minutes. |
| L2 | `src/app.js:380`, `523` | A link can change this device's saved plan: `/plan?c=...&adopt` and `/week?c=...&term=s1` save whatever courses the link carries. | Make "Make this my plan" a POST. Ignore `c` on setting-change links. |
| L3 | `src/app.js:2563` | The sign-in token is in the URL path, so it lands in the host's request log. It is single use and lasts 15 minutes. | Acceptable. Note it in the privacy notice's hosting paragraph. |
| L4 | `.gitignore` | `resources/` (ten handbook PDFs) and two logo PNGs in `public/` are untracked and not ignored. One `git add .` commits them. | Add `resources/` to `.gitignore`. Decide whether the PNGs are used (nothing references them) and delete or commit them. |
| L5 | `src/views.js:94` | The bar at the top of every page mentions "Sample" demo data, in production too, where there is none. | Show that sentence only when samples exist. |
| L6 | repo root | No CI. Tests run only when someone remembers. | A GitHub Actions workflow that runs `npm test` on each pull request. Check the free minutes for private repositories on GitHub's pricing page first. |
| L7 | `src/views.js` (2,843 lines), `src/app.js` (2,686), `test/app.test.js` (3,089) | Three very large files. The test run takes about two minutes. | Do not refactor for its own sake. When the demo work touches classes, move class routes and class templates into their own files in that pull request. |
| L8 | `src/views.js:2440`, `2490` | Terms and privacy say accounts need a `@myuct.ac.za` address. Staff accounts exist now. | Fold into the C3 rewrite. |

## Anonymity: can a review be traced to a student?

| Route | Result |
|---|---|
| Database join | Yes. See C2. |
| Backups | Yes, same data, kept 30 days. See C2. |
| Application logs | No. The app logs only errors and email failures, with no user or review identifiers. |
| Host request logs | Paths and IPs are logged by Render, not by the app. A `POST /courses/CSC1015F/review` line with an IP and a time, next to the review's stored `created_at` (to the second), would let someone with both the logs and the database match them. The author key in C2 does not remove this; storing `created_at` to the day would. |
| IDs in pages and API responses | Review numbers are sequential and visible (`#review-12`). They leak posting order, not identity. `user_id` is loaded with each review but never printed. |
| Timestamps on the page | Month and year only (`src/views.js:186`). Good. |
| Analytics and trackers | None. |
| Small classes | Yes. See H2. |
| Lecturer tools | A lecturer sees class members' student numbers and study times, never reviews. The risk is the combination with H2. |
| Moderation page | Shows review text and flags, no author. Leaderboard name reports show "Student #12" (`src/views.js:2772`), which is a user id but not a review link. |
| Report and takedown forms | Reports are tied to the reporter's account (so one person counts once) and are not shown to anyone but moderators. |

## Moderation and legal exposure

- **What exists:** automatic screening, a report button on every review and tip, instant hide for serious reasons, the takedown form, a moderator queue with a log, bans, house rules, terms and a privacy notice. That is more than most student projects have.
- **Gaps:** C1 (hidden text leaks), H1 (takedown abuse), M1 (keywords only), H5 (indexing and a shaming list). No way for a lecturer to reply. No message to the student when their review is removed. The 48-hour promise depends on two people checking `/mod` daily, and nothing emails them when the queue is not empty.
- **POPIA summary of what is stored:** email (which contains the student number), the 18+ confirmation time, reviews and votes, study sessions, optional leaderboard profile, group and class memberships with a chosen name, attendance marks, class lists pasted by lecturers, takedown requesters' names and emails. Purposes and periods are in the notice for the first half of that list and missing for the class half (C3, M4).
- **Not legal advice.** The lawyer review on the README's launch checklist should happen before real reviews of real people are published.

## Correctness

- H3 and H4 above are the two real bugs found.
- Empty and error states are handled on every page that was read. Loading states do not apply much: pages are rendered on the server.
- Not checked: the planner, week, year, marks and study flows, beyond their tests passing.

## Performance and hosting

Facts from Render's free plan page, read on 12 November 2026 ([render.com/docs/free](https://render.com/docs/free)):

- A free web service spins down after 15 minutes without inbound traffic. Starting again "takes about one minute".
- Each workspace gets 750 free instance hours a month.
- Free services have no persistent disk, and "Render might restart a Free web service at any time".

| Option | Cost | What it fixes | What it does not fix |
|---|---|---|---|
| A. Build the seeded database into the Docker image, copy it into place at start | Free | Removes the seed from every start (8.4 s here, more on Render). | Render's own one-minute start. |
| B. Keep-alive ping every 5 minutes during the demo weeks | Free. UptimeRobot's free plan checks every 5 minutes ([pricing file](https://uptimerobot.com/pricing.md), read 12 November 2026). | The lecturer almost never meets a sleeping app. A 31-day month is 744 hours, inside the 750. | Only one free service per workspace can stay awake all month. Restarts and deploys still wipe data. |
| C. A static "Kwaai is waking up" page on a free static host, which pings the app and forwards when it answers | Free on GitHub Pages. Not verified for other hosts. | A slow start becomes a friendly ten-second explanation instead of a blank tab. | Adds a second place to deploy. |
| D. Move the frontend to Vercel | n/a | Kwaai renders pages on the server and keeps SQLite on local disk. There is no separate frontend to move, and the README already notes Vercel cannot hold the database. | |
| E. Another free host with a disk | Unknown | Not researched far enough to recommend. `fly.toml` exists, but Fly's current free allowance was not verified. | |
| F. Render's paid disk | About $7 a month per the README. Not re-checked. | Everything, including data loss. | Already the plan for launch (see the hosting note in memory). |

**Recommendation:** A and B for the demo, both free. Add C only if a lecturer still reports a slow first load. Keep F for the pilot, as already decided. Because the free disk is wiped, demo feedback must leave the server the moment it is submitted (emailed through Brevo), which `docs/lecturer-demo.md` covers.

## Code health

- **Tests on critical paths:** good on sign-in, CSRF, reviews, moderation and every class feature. Missing: a test for C1, for H3, for H4 and for "a held review never appears on any public URL".
- **Dead or duplicate code:** the duplicated privacy bullet (C3). `public/Kwaai.png` and `public/kwaai-logo-preview.png` are referenced nowhere. The `num` helper at `src/app.js:1930` takes a `max` argument it ignores. Nothing else stood out in the files read.
- **Inconsistent patterns:** two URL schemes for one class (`/classes/:id` for staff, `/c/:code` for members). Raw hex colours in `public/style.css` beyond the tokens at the top (about 60 distinct values). Both are picked up in `docs/ux-plan.md`.
- **Dependencies:** two (`express`, `qrcode-generator`). `npm audit` reports nothing.
