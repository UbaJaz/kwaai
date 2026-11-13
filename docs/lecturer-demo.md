# Lecturer demo mode: design

Date: 12 November 2026. A design for one link that lets a UCT lecturer try every lecturer-facing feature without signing up. No code is written yet.

## The first two minutes, as designed

1. The lecturer taps the link in your email. If the app is asleep they see a short "Kwaai is waking up, about 30 seconds" page, then it forwards by itself.
2. They land on a page that says what Kwaai is, that it is built by two UCT students, that it is unofficial, and that everything in the demo is made up. One main button: "Try it as a lecturer".
3. One tap later they are inside a class of 14 fictional students with six weeks of registers, as its lecturer. No email, no password.
4. A checklist of six things to try sits at the top. A "Give feedback" button is on every page.

They meet their own tools first. Reviews come third on the checklist, after they have seen that Kwaai gives them something, and they arrive at the review page from a screen that explains how reviews are kept fair.

## Lecturer-facing features that exist today

| Feature | Where | State |
|---|---|---|
| Staff sign-in with `@uct.ac.za` | `src/universities.js:19`, `src/app.js:1383` | Works. Needs the email service. |
| Read every review and tip; cannot post or vote | `src/app.js:1201` | Works. |
| Lecturer page with scores and reviews | `src/app.js:316` | Works. Public and indexable (audit H5). No reply. |
| Report a review | `src/app.js:1327` | Works. |
| Request removal without an account | `src/app.js:1348-1371` | Works. Two problems: audit C1 (hidden text leaks) and H1 (anyone can hide anything). |
| Create a class, join link and QR code | `src/app.js:1456`, `1767` | Works. |
| Dashboard: study time against a weekly goal, "needs a nudge", "at risk" | `src/app.js:1730` | Works. |
| Class list paste (covers students not on Kwaai) | `src/app.js:1886` | **Half-built.** Fails above about 450 students (audit H4). Privacy notice does not cover it (audit C3). |
| Tut and prac groups with times, venues and tutors | `src/app.js:1944` | Works. |
| DP rule from attendance | `src/app.js:1927` | Works. |
| Register: tap names, or students scan a rotating QR code | `src/app.js:2090-2186` | Works. A scanned link can be forwarded for about a minute (audit M9). |
| Exports: students CSV, register for Excel | `src/app.js:1783`, `1798` | Works. |
| Export: Amathuba grade import | `src/app.js:1818` | **Half-built.** Never tested against Amathuba. |
| Pulse checks (anonymous one-tap questions) | `src/app.js:1580` | Works. |
| Announcements and official dates | `src/app.js:1557`, `1628` | Works. "Official" is not verified (audit H8). |
| Tutors and class reps | `src/app.js:2064`, `1847` | Works. Tutors are added without their agreement (audit M2). |
| Edit a class | `src/app.js:1833` | Works. |
| Delete or archive a class | none | **Missing.** |
| Reply to a review | none | **Missing.** Proposed in `docs/opportunities.md`, row 1. |
| Guided tour, feedback form, page for lecturers | none | **Missing.** Designed below. |

Useful starting point: the admin test tools already build a full demo class (`/admin/tools/demo-lecturer`, `src/app.js:2421-2454`) with students, a rep, a tutor, groups, six past tuts, dates, an announcement and a pulse check. Demo mode reuses those helpers.

## Design

### 1. A separate demo mode

A new environment variable, `DEMO_MODE=1`, set only on the demo's Render service. It is separate from `NODE_ENV` and from `TEST_TOOLS`.

When it is on:

- Cookies stay `Secure` and HSTS stays on (run with `NODE_ENV=production`).
- Email sign-in is switched off. `/login` explains that the demo needs no account.
- Every response carries `X-Robots-Tag: noindex`, and `robots.txt` disallows everything.
- The top bar on every page reads "Demo. Every lecturer, student, course and review here is made up."
- `DEMO_PASSWORD` is not used.

### 2. Only fictional data

The brief says never to show real reviews of real lecturers. The current sample data does not meet that: it puts made-up reviews on 14 real course codes such as MAM1021S (`scripts/seed.js:99-106`), next to the real convener's name and 1,745 real staff names. A lecturer who teaches one of those courses would see low scores on their own course.

In demo mode the database holds only a fictional catalogue:

- A new data file, `data/demo/courses.json`, with about 12 invented courses in 3 invented departments. Codes that cannot exist at UCT (a department prefix UCT does not use, for example `KWA1001F`). Realistic titles, credits, DP rules and assessment text so the planner and class tools have something to show.
- About 8 invented lecturers. Names that are plainly placeholders of the "Dr A Example" kind, so nobody wonders whether it is a colleague.
- About 60 invented reviews, a mix of good, middling and critical, plus two that sit in the moderation queue so the lecturer can see what gets held.
- `data/staff-2026.json` and the real handbooks are not loaded at all.

Side effect: the demo database seeds in well under a second, which removes most of the cold-start cost in audit H6.

### 3. One-tap entry, a private sandbox each

`GET /demo` is the landing page. `POST /demo/start` does this:

1. Creates a throwaway account, `demo-<random>@kwaai.invalid`, flagged `is_test`, role staff. That domain cannot receive mail and cannot sign in by email.
2. Builds that account its own class on a fictional course using the existing helpers: 14 students, a rep, a tutor, two tut groups and a prac, six past registers, a DP rule, three dates, two announcements, one open pulse check.
3. Signs the visitor in and sends them to the class.

Each visitor gets their own class, so one lecturer never sees another's changes or feedback. The hourly clean-up deletes demo accounts and their classes after 48 hours. Starting a sandbox is limited per IP.

Safety rules inside a sandbox:

- Anything a demo visitor types (a review, a tip, an announcement) is visible only in their own session.
- The class list accepts the paste, but demo mode shows a warning above it: "Demo only. Please paste made-up student numbers, not a real class list." Lines that look like real UCT student numbers are refused in demo mode. This is the guard for audit C3.
- The tutor form accepts only the sandbox's fictional tutor.

### 4. The student side on a phone

The best moment in the demo is scanning the register's QR code and watching a name tick over. The class page shows a second QR code labelled "Open this on your phone to be a student in your class". It signs the phone in as one of the sandbox's fictional students. They can then scan the attendance code, answer the pulse check and see the join screen that lists what a lecturer can and cannot see.

### 5. The checklist

A card at the top of the class page for demo accounts. Each item links to the right place and ticks itself when done. Progress is stored against the demo account.

1. See who needs a nudge (opens the dashboard filter).
2. Take a register: tap three names, then scan the code with your phone.
3. Ask the class a one-tap question and watch the count.
4. Add a test date and see it on a student's calendar.
5. Read how reviews work: what students can post, what gets held, how to reply or ask for removal. Then open a fictional lecturer's page.
6. Tell us what you think.

Six items because that is how many things there are to try. Each should take under a minute.

### 6. The feedback form

`/demo/feedback`, linked from every page.

- What would be useful to you?
- What worries you?
- What is missing?
- Would you try this with one tut group next semester? (Yes, maybe, no)
- Optional: name, department, email, and a tick box "You may contact me about this".

**Where it is saved.** Render's free disk is wiped on every restart, so the database alone is not enough. On submit the app does two things: writes a row to a new `demo_feedback` table, and emails the answers to `CONTACT_EMAIL` through the Brevo integration that already sends sign-in emails. If the email fails, the lecturer still sees "Thank you", the failure is logged, and the row is shown on `/mod` until the next restart. Your inbox is the durable copy. Brevo's free allowance is stated in `docs/email-setup.md` as 300 emails a day; I did not re-check it.

Privacy: the form says what happens to the answers ("read by the two students who build Kwaai, kept until launch, never published with your name"). Name and email are optional.

### 7. The page for lecturers

`/for-lecturers`, one screen, plain wording, no emoji. Linked from the demo landing page, the footer and every lecturer page.

1. **What Kwaai is.** A course review and planning site built by two UCT students, Ubayd Hattas and Jaswin Chinthala. Unofficial. Not run by, endorsed by or affiliated with UCT. Not launched yet.
2. **What students can post.** Ratings of a course as taught in one year: teaching, engagement, exam fairness, approachability, plus difficulty and workload. One short comment. One review per student per course per year. Only verified UCT student emails.
3. **What they cannot post.** Allegations, comments on appearance or personal life, private details, other people's names. Where the rules live.
4. **How anonymity works, honestly.** Readers and lecturers never see who wrote a review. Comments appear only once a course has five reviews. The two operators could technically link a review to an account; they do not, and the planned author key (audit C2) removes even that from the database.
5. **How moderation works.** Automatic screening, a report button on every review, two student moderators, a 48-hour target, a log of every decision. Say plainly that it is two people.
6. **If a review is about you.** Reply to it (once built). Report it. Ask for removal: signed-in staff requests hide the review at once while a moderator looks.
7. **What the class tools do with student data.** What a lecturer sees (student number, chosen name, time logged for that course, attendance) and what they never see (reviews, votes, marks, other courses). Students choose to join and can leave.
8. **What we are asking.** Try the demo, tell us what worries you, and say whether you would pilot registers with one tut group.
9. **Contact.**

Items 4 and 6 describe fixes that are in the implementation plan. The page must not go live before those fixes do.

### 8. The slow first load

From `docs/audit.md`:

- The fictional catalogue makes seeding near instant.
- A free keep-alive ping every 5 minutes for the weeks the link is out.
- A `/healthz` route that answers without touching the database, for the ping and the wake page.
- Optional: a static wake page on GitHub Pages as the link you send. Add it only if lecturers still report waiting.

### 9. What the lecturer should not meet in the demo

- The study game: ranks, quests, seasons, leaderboards, Wrapped. Hidden from staff navigation (UX plan N1).
- Test tools and the moderation page.
- "Lowest rated" rankings (cut in `docs/opportunities.md`).
- Student-voice copy on lecturer-facing pages (UX plan section 5).

## How you will know it worked

Count, per lecturer who opens the link: started a sandbox, ticked at least three checklist items, sent feedback. The first two are counts in the demo database, read from `/mod` before a restart wipes them; the third is in your inbox. No analytics service is needed, and none should be added without updating the privacy notice.

## Open questions for you

1. Which fixes must be live before the first lecturer gets the link? My answer: all of phase 1 in `docs/implementation-plan.md`, because the lecturer page describes them.
2. Is it acceptable that demo feedback arrives by email only if `BREVO_API_KEY` and `CONTACT_EMAIL` are set on the demo service? If not, the alternative is a free hosted database, which needs its own research.
3. Who are the first five lecturers? Starting with people who already know one of you (a tutor coordinator, a first-year convener) fits the tutors-first strategy.
