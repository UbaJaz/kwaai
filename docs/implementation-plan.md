# Kwaai implementation plan

Date: 12 November 2026. Built from `docs/audit.md`, `docs/lecturer-demo.md`, `docs/brand.md`, `docs/ux-plan.md` and `docs/opportunities.md`. No code is written until you approve this.

## How to use this

- One task is one pull request on its own branch, named in the task.
- Every task ends with `npm test` passing, and the reviewer checks each acceptance line.
- Sizes: S is under half a day, M is one to two days, L is more than two days.
- Order: phase 1 (security and anonymity), phase 2 (demo), phase 3 (badges and UI), phase 4 (opportunities you approve). Inside a phase, top to bottom.

## Commits

You asked for more commits, within reason. Each task lists the commits it naturally breaks into. The rule: a commit is one step that could be reviewed and reverted by itself, and the tests pass after it.

- Typical split: the failing test, the fix, then copy or docs. Two to five commits per task.
- Merge pull requests with a merge commit, not a squash, so each commit stays in the history.
- Do not split a change to raise the count: no one-line-per-commit, no committing a rename apart from its use, no empty or whitespace commits. A reviewer or recruiter who opens the history should find that every commit means something.

The plan below comes to about 135 commits across 42 tasks if every optional item is approved (107 commits across 32 tasks without phase 4). That is the honest number for this much work.

## Phase 1: security and anonymity

All of phase 1 ships before any lecturer gets a link.

### S1. Stop hidden reviews leaking through the takedown page (audit C1)
- **Branch:** `fix/takedown-hidden-text`
- **Files:** `src/app.js` (takedown GET, about line 1349), `src/views.js` (`takedown`), `test/app.test.js`
- **Acceptance:** `/takedown?review=N` shows the comment only when the review is published. For a held review it shows the number and course, no text. A removed or unknown number shows the plain form. New test covers held, removed and published.
- **Commits (3):** test that a held review's text is not on the page; the fix; the same check for the POST error re-render.
- **Size:** S

### S2. Verified takedowns (audit H1)
- **Branch:** `fix/verified-takedown`
- **Files:** `src/app.js` (takedown POST), `src/views.js` (`takedown`, `rules`), `test/app.test.js`
- **Acceptance:** a request from a signed-in staff account hides the review at once. A request from anyone else is queued and the review stays up; the confirmation page says so. The existing instant-hide test is updated, not deleted. House rules and the form's wording match the behaviour.
- **Commits (4):** test for staff request; test for anonymous request; the change; copy on the form and rules page.
- **Size:** M
- **Decision needed:** email-code verification for people without a staff address is left out. Say if you want it.

### S3. Account deletion for reps and tutors (audit H3)
- **Branch:** `fix/delete-account-class-dates`
- **Files:** `src/app.js` (account delete), `test/app.test.js`
- **Acceptance:** a class rep who added a date can delete their account; the date stays, shown as "from the class". Test fails before the fix and passes after.
- **Commits (2):** failing test; fix.
- **Size:** S

### S4. Comments show from five reviews (audit H2)
- **Branch:** `feat/comment-threshold`
- **Files:** `src/ratings.js` (new constant), `src/app.js` (course and lecturer pages), `src/views.js` (`course`, `lecturer`, `reviewCard`), `test/app.test.js`
- **Acceptance:** with fewer than 5 published reviews, a course page shows the averaged scores and "N more reviews until comments show", and no comments, tags per review, or per-lecturer table. Tips follow the same rule. From 5, the page is as today. The author still sees their own review on `/account`.
- **Commits (4):** constant and unit test; course page; lecturer page and tips; copy.
- **Size:** M

### S5. Search engines and the lecturer league table (audit H5)
- **Branch:** `fix/noindex-lecturers`
- **Files:** `public/robots.txt` (new), `src/app.js` (headers, rankings), `src/ratings.js`, `src/views.js` (`rankings`), `test/app.test.js`
- **Acceptance:** `/robots.txt` exists. Lecturer pages and lecturer rankings send `X-Robots-Tag: noindex`. "Lowest rated" is not offered when ranking lecturers. Course rankings unchanged.
- **Commits (3):** robots file and header with test; remove the category for lecturers; copy on the rankings page.
- **Size:** S
- **Decision needed:** opportunities cut 1 removes lecturer rankings altogether. If approved, this task does that instead.

### S6. Honest anonymity wording (audit C2, part 1)
- **Branch:** `docs/anonymity-wording`
- **Files:** `src/views.js` (`privacy`, `rules`, `home`, `about`, sign-in flash text in `src/app.js`)
- **Acceptance:** no page says or implies that the operators cannot link a review to an account. The privacy notice states who can, and when it would happen. The duplicated study-sessions bullet is merged.
- **Commits (2):** privacy notice; the other pages.
- **Size:** S

### S7. Author keys in place of user ids (audit C2, part 2)
- **Branch:** `feat/author-key`
- **Files:** `src/db.js` (columns, migration), `src/app.js` (every query on `reviews.user_id`, `verdicts.user_id`, `reports.user_id`, `course_facts.user_id`, the account export, delete, ban), `server.js` (require `AUTHOR_KEY` in production), `.env.example`, `README.md`, `test/app.test.js`
- **Acceptance:** those four tables hold no user id. One review per student per course and year still holds. "My reviews", export, delete-account and ban-author still work. A test opens the database and confirms no column in those tables equals a user id. The server refuses to start in production without `AUTHOR_KEY`. An existing database migrates on start.
- **Commits (6):** key helper with unit tests; reviews; votes and tips; reports and course details; ban and export; env docs.
- **Size:** L
- **Send to the `architect` agent first:** a wrong design here is expensive. Open questions for it: storing `created_at` to the day, and what happens if the key is lost.

### S8. Privacy notice and terms cover staff and classes (audit C3, L8, M8)
- **Branch:** `docs/privacy-classes`
- **Files:** `src/views.js` (`privacy`, `terms`, `classJoin`)
- **Acceptance:** the notice lists staff accounts, class membership, what lecturers and tutors see, attendance, class lists pasted by lecturers, announcements, pulse checks, the device cookie and the calendar cookie, each with a purpose and a retention period. The join screen no longer mentions a streak. Terms mention staff accounts.
- **Commits (3):** notice; terms; join screen.
- **Size:** S
- **Not covered:** this is a careful draft. The lawyer review on the README checklist still stands.

### S9. Class list size limit (audit H4)
- **Branch:** `fix/roster-size`
- **Files:** `src/app.js` (body parser for the class list route, error handler message), `test/app.test.js`
- **Acceptance:** a 3,000-line list saves. A longer one gets a message that names the limit. Other forms keep the 20 KB limit.
- **Commits (2):** failing test with 1,000 students; fix and message.
- **Size:** S

### S10. Smaller fixes
- **Branch:** `fix/audit-small`
- **Files:** `src/app.js`, `server.js`, `.gitignore`, `src/views.js`, `test/app.test.js`
- **Acceptance, one commit each (6):** sign-in no longer reveals a suspended account before the code is entered (M3); class lists past their date are deleted by the hourly clean-up (M4); admin sign-in lockout is per IP (L1); "Make this my plan" is a POST and setting links ignore `c` (L2); `resources/` is ignored by git (L4); the sample-data sentence shows only when samples exist (L5).
- **Size:** M

### S11. Tutor invitations (audit M2)
- **Branch:** `feat/tutor-invite`
- **Files:** `src/db.js`, `src/app.js`, `src/views.js` (`classAdmin`, `classes`), `test/app.test.js`
- **Acceptance:** adding a tutor creates a pending invitation. The person sees it on `/classes` and accepts or declines; consent is recorded only on accept. The lecturer gets the same message whether or not the address has an account.
- **Commits (4):** table; invite; accept and decline; tests.
- **Size:** M
- **Can wait until the pilot** if phase 1 is running long. The demo uses fictional tutors.

### S12. CI
- **Branch:** `chore/ci`
- **Files:** `.github/workflows/test.yml` (new)
- **Acceptance:** `npm test` runs on every pull request and the result shows on the PR.
- **Commits (1).**
- **Size:** S
- **Before starting:** check the free Actions minutes for private repositories on GitHub's pricing page. Read any third-party Action's code before adding it; `actions/checkout` and `actions/setup-node` are GitHub's own.

## Phase 2: lecturer demo

Design in `docs/lecturer-demo.md`.

### D1. Demo mode switch
- **Branch:** `feat/demo-mode`
- **Files:** `server.js`, `src/app.js`, `.env.example`, `README.md`, `test/app.test.js`
- **Acceptance:** with `DEMO_MODE=1`: every response has `X-Robots-Tag: noindex`; `/robots.txt` disallows all; the top bar shows the demo sentence; `/login` explains no account is needed; `/healthz` returns 200 without a database query. Without it, nothing changes.
- **Commits (4):** flag and plumbing; headers and robots; banner and sign-in page; health route.
- **Size:** M

### D2. Fictional catalogue
- **Branch:** `feat/demo-data`
- **Files:** `data/demo/courses.json` (new), `scripts/seed.js`, `server.js`, `test/app.test.js`
- **Acceptance:** in demo mode the database contains only the fictional courses, lecturers and reviews. A test asserts that no name from `data/staff-2026.json` and no real course code is present. Two reviews sit in the moderation queue. Seeding takes under one second (the test prints the time).
- **Commits (4):** data file; seed path; held examples; tests.
- **Size:** M

### D3. One-tap sandbox
- **Branch:** `feat/demo-sandbox`
- **Files:** `src/app.js` (move the demo class helpers out of the test-tools block, new `/demo` routes), `src/views.js` (landing page), `server.js` (clean-up), `test/app.test.js`
- **Acceptance:** `POST /demo/start` creates a throwaway staff account with its own seeded class and signs in. Two visitors do not see each other's class. Demo accounts older than 48 hours are deleted by the clean-up. Starting is rate limited. The routes return 404 when demo mode is off.
- **Commits (5):** extract helpers with no behaviour change; landing page; start route; clean-up; tests.
- **Size:** L

### D4. Sandbox safety rules
- **Branch:** `feat/demo-guards`
- **Files:** `src/app.js`, `src/views.js` (`classAdmin`), `src/classes.js`, `test/app.test.js`
- **Acceptance:** in demo mode a class list containing a real-looking UCT student number is refused with an explanation. Text typed by a demo visitor is visible only to that visitor. The tutor form accepts only the sandbox tutor.
- **Commits (3):** class list guard; visibility; tutor guard.
- **Size:** M

### D5. Student phone link
- **Branch:** `feat/demo-phone`
- **Files:** `src/app.js`, `src/views.js` (`classAdmin`), `test/app.test.js`
- **Acceptance:** the demo class page shows a QR code that signs a phone in as a fictional student of that sandbox. That student can check in to an open register and answer the pulse check.
- **Commits (3):** link and token; page section; test.
- **Size:** M

### D6. Checklist
- **Branch:** `feat/demo-checklist`
- **Files:** `src/db.js`, `src/app.js`, `src/views.js`, `public/style.css`, `test/app.test.js`
- **Acceptance:** six items as designed, each linked, each ticking itself when its action happens. Works without JavaScript. Hidden outside demo mode.
- **Commits (4):** storage; card; ticks wired to actions; tests.
- **Size:** M

### D7. Feedback form
- **Branch:** `feat/demo-feedback`
- **Files:** `src/db.js`, `src/app.js`, `src/email.js`, `src/views.js` (`mod`, new form), `test/app.test.js`
- **Acceptance:** the form saves a row and emails `CONTACT_EMAIL`. If the email fails the visitor still gets a thank-you, the error is logged without the answers, and the row shows on `/mod`. Name and email are optional. Rate limited.
- **Commits (4):** table and form; email; moderation view; tests.
- **Size:** M

### D8. Page for lecturers
- **Branch:** `feat/for-lecturers`
- **Files:** `src/app.js`, `src/views.js` (new page, footer, `lecturer`)
- **Acceptance:** `/for-lecturers` has the nine sections in the design, with no emoji and nothing it says is untrue of the deployed code. Linked from the footer, the demo landing page and each lecturer page. Load the writing-style skill before writing it.
- **Commits (2):** page; links.
- **Size:** S

### D9. Class delete and archive (audit M6)
- **Branch:** `feat/class-delete`
- **Files:** `src/app.js`, `src/views.js` (`classAdmin`), `test/app.test.js`
- **Acceptance:** the lecturer can delete a class after typing its name. Members, registers and dates go with it.
- **Commits (3):** route; confirmation page; test.
- **Size:** S

### D10. Deploy the demo
- **Branch:** `chore/demo-deploy`
- **Files:** `Dockerfile` (seed at build time), `README.md`
- **Acceptance:** the image contains a seeded database and the server copies it into place when `DB_FILE` is missing. README has the demo service's environment variables and the keep-alive set-up steps.
- **Commits (2):** Dockerfile; README.
- **Size:** S
- **Yours to do, not Claude's:** create the Render service, set the variables, set up the UptimeRobot monitor. I will not deploy.

## Phase 3: badges and UI

### U1. Screenshot pass
- **Branch:** none (report only)
- **Acceptance:** each screen listed in `docs/ux-plan.md` section 6 captured at 375 px and 1280 px, with problems added to `docs/ux-plan.md`.
- **Commits (1):** the updated plan.
- **Size:** M

### U2. Figma file
- **Acceptance:** one Figma file with the tokens as variables, the component set with every state, the chosen badge family at 24, 40, 64 and 128 px, and six key screens (home, course, lecturer page, class dashboard, register, join screen) at phone and desktop width. You review it before U3 starts.
- **Commits:** none.
- **Size:** L
- **Blocked on:** your pick of badge concept and logo in `docs/brand.md`.

### U3. Tokens in CSS
- **Branch:** `refactor/design-tokens`
- **Files:** `public/style.css`, `public/sw.js` (version bump)
- **Acceptance:** the token block from the UX plan exists. No hex colour appears outside it, except in the tier block. Every font size, radius and spacing value uses a token. Screenshots before and after are compared and attached to the PR.
- **Commits (5):** add tokens; colours; type; spacing and radius; service worker version.
- **Size:** L

### U4. Component states
- **Branch:** `feat/component-states`
- **Files:** `public/style.css`, `public/app.js`, `src/views.js`
- **Acceptance:** buttons have disabled and busy states and forms set busy on submit. Inputs have an error state with a message tied to the field. No touch target is under 44 px. No text is under 12 px.
- **Commits (4):** buttons; inputs and field errors; targets; text floor.
- **Size:** M

### U5. Badge family
- **Branch:** `feat/rank-badges`
- **Files:** `src/views.js` (`emblem` and callers), `public/style.css` (tier block), `test/app.test.js`
- **Acceptance:** six tiers and three divisions drawn per the chosen concept, each tier with its own silhouette, readable at 24 px in the test tools gallery. Mark-on-fill contrast is at least 3:1 for every tier, with the numbers in the PR. Every use in the swap list of `docs/brand.md` shows the new badge.
- **Commits (5):** shapes; divisions; small-size variant; CSS; tests.
- **Size:** L

### U6. Icons, empty states and the rank-up moment
- **Branch:** `feat/brand-assets`
- **Files:** `src/views.js`, `src/app.js` (message calls), `public/style.css`, `public/app.js`, `public/manifest.webmanifest`, `scripts/og-card.html`, `public/og-card.png`
- **Acceptance:** message screens, empty states and the streak use drawn icons, with no emoji left on lecturer-facing pages. A maskable icon is in the manifest. The share image is redrawn and a lecturer-preview card exists. The rank-up animation respects reduced motion.
- **Commits (5):** icon set; message screens; empty states and streak; manifest and share images; animation.
- **Size:** L

### U7. Staff navigation and the tabbed class page (UX plan N1 to N5, N7)
- **Branch:** `feat/staff-nav`
- **Files:** `src/views.js` (`layout`, `tabBar`, `classAdmin`, `lecturer`), `src/app.js` (landing after sign-in), `public/style.css`, `test/app.test.js`
- **Acceptance:** a staff account lands on `/classes` and sees no student-only tabs. The class page has four tabs that work without JavaScript and keep their anchors. "My reviews" is "Account". Lecturer pages show the "Is this you?" line.
- **Commits (5):** landing and nav; rename; tabs; lecturer page line; tests.
- **Size:** L

### U8. Lecturer-facing copy (UX plan section 5)
- **Branch:** `docs/lecturer-copy`
- **Files:** `src/views.js`, `src/app.js`, `src/ratings.js`, `test/app.test.js` (strings in assertions)
- **Acceptance:** every row of the copy table is applied or you have rejected it. The engagement dimension and tag are renamed without changing stored data.
- **Commits (3):** system messages; rating labels and tags; rules and about.
- **Size:** S

### U9. Accessibility fixes (UX plan section 4)
- **Branch:** `fix/a11y`
- **Files:** `src/views.js`, `public/style.css`
- **Acceptance:** menu roles removed from the More sheet. Sorted columns use `aria-sort`. Decorative emoji that remain are hidden from screen readers. A keyboard-only run through sign-in, the class page and a register is written up in the PR.
- **Commits (3):** roles and sort; emoji; fixes found in the keyboard run.
- **Size:** M

### U10. Review sliders start empty (UX plan N6)
- **Branch:** `fix/review-defaults`
- **Files:** `src/views.js` (`reviewForm`, `slider`), `public/app.js`, `test/app.test.js`
- **Acceptance:** a review cannot be submitted until each of the six ratings has been chosen. Works without JavaScript.
- **Commits (2):** form; test.
- **Size:** S

## Phase 4: opportunities, only the ones you approve

Listed in the order of `docs/opportunities.md`. Each needs a yes.

| Task | Branch | Files | Acceptance | Commits | Size |
|---|---|---|---|---|---|
| O1. Lecturer reply and course note | `feat/lecturer-reply` | `src/db.js`, `src/app.js`, `src/views.js`, `src/moderation.js`, tests | A verified staff account that a moderator has linked to a lecturer record can post one reply per review and one note per course; both are screened and reportable. | 5 | L |
| O3. Structured tips | `feat/structured-tips` | `src/ratings.js`, `src/db.js`, `src/app.js`, `src/views.js`, tests | The three prompts replace the free-text tip for new votes; old tips still show. | 4 | M |
| O4. Class rep onboarding | `feat/rep-onboarding` | `src/views.js`, `src/app.js`, tests | A rep sees a three-step start card and a share message for the class group. | 3 | S |
| O5. Amathuba file check | `fix/amathuba-export` | `src/app.js`, `src/views.js`, tests | The file imports cleanly in one real course, confirmed by a course admin, or the link is hidden. Needs a person at UCT. | 2 | S |
| O6. Trust signals on scores | `feat/score-confidence` | `src/views.js`, tests | Each score shows review count, years covered and a caution under 10. | 3 | S |
| O7. Exam-season rating drive | `feat/rating-drive` | `src/views.js`, `scripts/og-card.html`, tests | Course pages show votes still needed and a share card. Has a deadline: before January registration. | 3 | S |
| O8. Planner share link | `feat/plan-share` | `src/views.js`, tests | The planner has a share action with a clear preview. | 2 | S |
| Cut 1. Remove lecturer rankings | `refactor/course-rankings-only` | `src/app.js`, `src/views.js`, tests | `/rankings` ranks courses only. | 2 | S |
| Cut 4. Remove the universities page | `refactor/remove-universities-page` | `src/app.js`, `src/views.js`, tests | Page and header chip gone; `src/universities.js` stays. | 2 | S |
| Cut 5. Comment gate per course | `feat/gate-threshold` | `src/ratings.js`, `src/app.js`, tests | The gate applies only to courses with 10 or more comments. | 2 | S |

## Critical path to sending the link

S1, S2, S3, S4, S5, S6, S8, S9, then D1 to D8 and D10, then U7 and U8. S7 (author keys) should also land first if the lecturer page is to describe it as done; otherwise that page must say "planned". Badges and the rest of phase 3 do not block the demo.

## What you need to decide before work starts

1. Badge concept, logo and tier names (`docs/brand.md`).
2. Which opportunities and cuts to approve (`docs/opportunities.md`).
3. S2: staff-only instant hide, or add email-code verification for others.
4. S5: remove "lowest rated" for lecturers only, or lecturer rankings altogether.
5. Whether S7 must be finished before the first lecturer sees the demo.
6. Demo feedback by email through Brevo: acceptable, or research a free database.
