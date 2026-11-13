# Kwaai UI and UX cleanup plan

Date: 12 November 2026. Based on reading the templates in `src/views.js` and the stylesheet `public/style.css`.

**Limit of this review:** no page was opened in a browser. Spacing, wrapping and overflow at phone width are judged from the CSS, not seen. The first task in the UI phase of `docs/implementation-plan.md` is a screenshot pass at 375 px and 1280 px to confirm or correct what is below. The student planner, week, year, marks and study templates were not read line by line.

**Figma:** the Figma connector is available in this session. Nothing has been put in Figma yet, on purpose: the badge concept in `docs/brand.md` needs your pick first, and the badges are part of the component set. Task U2 in the implementation plan builds the Figma file (tokens, components, six key screens) for your review before any CSS changes.

## What is already good

Keep these. They are better than most first versions.

- A real token block at the top of `public/style.css` (ink, lime, paper, good, mid, low, radius, three font stacks).
- Two self-hosted fonts with a clear split: Bricolage Grotesque for headings, Inter for the rest.
- A visible focus ring on everything (`:focus-visible`, line 47), a skip link, `sr-only` text, and `prefers-reduced-motion` handled in 18 places.
- Phone tab bar with 50 px targets, and tables that collapse to labelled rows (`data-label`).
- Scores always show a number next to the bars, so colour is never the only signal.

## 1. Design tokens

The stylesheet starts with tokens and then drifts. Counted in `public/style.css`: about 60 distinct hex colours outside the token block, font sizes in more than a dozen ad hoc `rem` values (.66, .7, .76, .78, .8, .82, .86, .88, .9, .93, 1.05, 1.08, 1.15, 1.35, 1.45), body text at 15.5 px, and paddings that follow no grid (6px 12px, 10px 16px, 13px 22px, 20px 22px).

Proposed set. Small on purpose.

### Colour roles

| Token | Value | Role |
|---|---|---|
| `--ink` | `#151d2b` | Text, dark surfaces, primary dark button |
| `--ink-2` | `#2a3446` | Hover on ink |
| `--paper` | `#f7f7f2` | Page background |
| `--surface` | `#ffffff` | Cards, inputs |
| `--muted` | `#5c6575` | Secondary text (5.5:1 on paper by my calculation, passes AA) |
| `--line`, `--line-strong` | `#e4e4dc`, `#cfd0c6` | Borders |
| `--lime`, `--lime-soft` | `#c8f169`, `#eef9d4` | Brand fill behind ink text only, never text |
| `--good`, `--mid`, `--low` plus `-soft` | existing values | Status: success, caution, danger |
| `--info`, `--info-soft` | reuse `--uni`, `--uni-soft` | Neutral notices |
| `--tier-*` | existing six | Rank badges only |

Rule: every other hex in the file maps to one of these or is deleted. `--sample` stays only while sample data exists.

### Spacing (4 and 8 grid)

`--s-1: 4px`, `--s-2: 8px`, `--s-3: 12px`, `--s-4: 16px`, `--s-5: 24px`, `--s-6: 32px`, `--s-7: 48px`, `--s-8: 64px`. Every margin, padding and gap uses one of these.

### Type scale

Body moves from 15.5 px to 16 px (also stops iOS zooming into inputs).

| Token | Size / line height | Use |
|---|---|---|
| `--t-xs` | 12 / 16 | Badges, fine print. Nothing smaller (`.badge` is about 10 px today). |
| `--t-sm` | 14 / 20 | Meta text, table cells, small buttons |
| `--t-md` | 16 / 24 | Body, inputs, buttons |
| `--t-lg` | 20 / 28 | Card titles, lede |
| `--t-xl` | 24 / 28 | Section titles |
| `--t-2xl` | 32 / 36 | Page titles on phones |
| `--t-3xl` | 40 / 44 | Page titles on desktop, hero |

### Radius, borders, elevation

`--r-sm: 4px` (badges, codes), `--r-md: 8px` (buttons, inputs), `--r-lg: 12px` (cards), `--r-pill: 999px`. One border weight (1 px). One shadow token for the sticky header, the More sheet and the install banner; cards stay flat.

## 2. Components and their states

| Component | Today | Missing | Change |
|---|---|---|---|
| Button | `btn` with `small`, `big`, `ink`, `outline`, `quiet`, `ok`, `danger`. Hover and active exist. | Disabled, loading. `btn-small` is about 30 px tall. `link-btn` has no padding at all. | Three sizes on the grid (36, 44, 52 px). On touch screens nothing under 44 px. Add `[disabled]` and `[aria-busy]` styles; forms set busy on submit so a slow Render reply is not a dead button. |
| Text input, select, textarea | Default and focus. | Error state. Errors appear only as one box at the top of the form. | Add `aria-invalid` styling and a message under the field, linked with `aria-describedby`. Keep the top summary. |
| Card | `card`, `panel`. | Nothing. | Padding from tokens. |
| Badge, status pill, chip, toggle | Several near-duplicates (`badge`, `status`, `tag`, `chip`, `dp-chip`, `flag`). | Shared sizing. | One pill component with tone variants. |
| Flash message | `ok`, `info`, `error`. | Icon or word that says which, for readers who cannot rely on colour. | Prefix with "Done", "Note" or "Problem" for screen readers; errors use `role="alert"` everywhere (some already do). |
| Empty state | Text, sometimes an emoji (`🫥`, `src/views.js:808`). | A consistent block. | One component: a small brand illustration (see `docs/brand.md`), one sentence, one action. |
| Data table | `dash-table` with sort links. | Sort state for screen readers uses `aria-current="true"`. | Use `aria-sort` on the header cell. Sticky first column on phones. |
| Confirm | `data-confirm` uses the browser's pop-up. | Styling, and a safer pattern for destructive actions. | Keep the browser pop-up for small things. For "Delete my account" and "Delete class" use a page that asks the person to type the name. |
| Rank badge | Inline SVG `emblem()`. | Being replaced. | See `docs/brand.md`. |
| Score | Number and five bars. | Nothing. | Keep. |
| Loading | None. | Whole-page waits on cold start. | Busy state on buttons, plus the wake page in `docs/audit.md`. |

## 3. Navigation and flows

| # | Problem | Where | Fix |
|---|---|---|---|
| N1 | A lecturer signs in and lands on the student home page: streaks, "Start studying", the planner pitch. | `src/app.js:2539` redirects to `next` or `/` | Staff accounts land on `/classes`. Their header shows Classes, Courses, About, Account. Student-only tabs (Today, Study, Week, Marks, Planner) are hidden for staff. |
| N2 | The account page is called "My reviews", and staff cannot review. | `src/views.js:100`, `2505` | Rename to "Account" for everyone. |
| N3 | The lecturer's class page is one long page with nine sections: dashboard, join, class list, DP rule, groups, attendance, pulse checks, tutors, edit. On a phone that is a very long scroll. | `src/views.js:1770-1957` | Four tabs: **Students** (totals and table), **Attendance** (start a register, past sessions, exports), **Class** (announcements, dates, pulse checks), **Setup** (join link, class list, groups, DP rule, tutors, edit, delete). |
| N4 | One class has two addresses with two looks: `/classes/12` ("lecturer view") and `/c/ABCD2345` ("class page"). The link between them is a small quiet button. | `src/views.js:1805`, `2015` | Keep both URLs. Give staff the tabbed page and make "See it as students do" one of the tabs' links, not a separate destination. |
| N5 | The phone "More" sheet holds up to 13 links. | `src/views.js:41-47` | Group into three headed lists: Study, Courses, Account. |
| N6 | Review sliders start at 3, so doing nothing submits a middle rating. | `src/views.js:876`, `880` | Start with no value. Require a tap on each. This also makes the data more honest. |
| N7 | "Request removal" is inside the Report drop-down on each review. A lecturer looking at their own page will not find it. | `src/views.js:196` | On lecturer pages, put a visible line under the name: "Is this you? Reply or ask for a review to be removed." |
| N8 | The first thing on every page is a notice bar about sample data. | `src/views.js:94` | In production, shorten to "Unofficial student project. Not affiliated with UCT." In the demo, replace with the demo banner. |
| N9 | The join screen is a consent screen but looks like any other form. | `src/views.js:1960` | Keep the content (it is good). Give it the two-column "They see / They don't see" layout at every width and put the join button after it, never above. |
| N10 | Sign-in on a cold Render service means two slow page loads before the code form. | sign-in flow | Busy state on "Email me a code". Not much else to do here. |

## 4. Accessibility

Target: WCAG 2.1 AA.

| # | Issue | Where | Fix |
|---|---|---|---|
| A1 | Tap targets under 44 px: small buttons (about 30 px), text-only buttons (`link-btn`: Report, Delete mine, Remove), the Report summary. | `public/style.css:94`, `106` | Minimum 44 px hit area on touch screens, using padding rather than bigger text. |
| A2 | Text below 12 px: badges at .66rem, tab labels at .7rem. | `public/style.css:139`, `556` | Floor of 12 px. |
| A3 | The More sheet is marked `role="menu"` with `menuitem` links but has no arrow-key behaviour. Screen readers announce a menu that does not act like one. | `src/views.js:54-55` | Remove the roles. A list of links is correct. |
| A4 | Form errors are only at the top of the form. | all forms | See the input component above. |
| A5 | Emoji carry meaning in headings and messages (`✅ Do`, `🚫 Don't`, `🛡️`, `🔒`, the page emoji on message screens). Screen readers read them aloud, sometimes oddly. | `src/views.js:2366-2393`, `2739` | Mark decorative emoji `aria-hidden` and make sure the words alone carry the meaning. Better: replace with the icon set from `docs/brand.md`. |
| A6 | Rank and tier are partly carried by colour (bronze, silver and gold share one shield shape). | `src/views.js:387` | The new badges change silhouette per tier. See `docs/brand.md`. |
| A7 | Contrast of tier colours used as fills behind white marks (silver `#9aa5b1`, gold `#e0aa1e`) is likely under 3:1. Not measured. | `public/style.css:968-969`, `978` | Check each pair when the badges are redrawn. Use ink marks on light tiers. |
| A8 | Keyboard: `details` elements are used for menus and edit forms, which works. The register's tap-to-cycle buttons have full labels. Not tested by hand. | | A keyboard-only pass of the lecturer flow is in the plan. |
| A9 | Light theme only (`color-scheme: light`). | `public/style.css:34` | Leave. Not worth the work before launch. |

## 5. Copy

The student voice (kwaai or nah, lekker, the emoji) fits the student pages and should stay there. The problem is that the same voice reaches lecturers, on pages about them and in system messages.

**Rule:** any page a lecturer can land on uses plain, neutral wording and no emoji. That covers the lecturer page, rankings, takedown, house rules, about, privacy, terms, sign-in, every class page, and all error and status screens.

| Where | Now | Suggested | Why |
|---|---|---|---|
| `src/views.js:2364` | "Roasting a course is fine. Attacking a person isn't." | "Criticising a course is fine. Attacking a person isn't." | "Roasting" reads as an invitation, and a lecturer hears their course is their work. |
| `src/app.js:2680` | "Something broke 🫠" | "Something went wrong. That was our fault. Please try again." | Tone. |
| `src/app.js:132` | "Slow down 🐢" | "Too many requests. Please wait a minute and try again." | Tone. |
| `src/app.js:170` | "Not found 🤷" | "Page not found" | Tone. |
| `src/app.js:1235` | "Thanks! Your review is live. 🤙" | Keep for students. | Student page. |
| `src/ratings.js:5` | "Fun & interactive: Keeps lectures lively, actually funny" | "Engaging: keeps lectures interactive and interesting" | Rating someone on being funny is the kind of thing RateMyProfessors was criticised for (see `docs/opportunities.md`). |
| `src/ratings.js:16` | Tag "Funny" | "Engaging lectures" | Same. |
| `src/ratings.js:10` | "Chilled" to "Brutal" | "Manageable" to "Very hard" | Shown on lecturer pages. |
| `src/ratings.js:75-78` | Load labels "Cooked", "Fully cooked" | Keep. | Planner is student-only. |
| `src/ratings.js:35` | "Lowest rated" | Remove for lecturers. | See audit H5. |
| `src/views.js:945` | "so one bad day can't sink anyone" | "so a single review cannot decide a ranking" | Plainer. |
| `src/views.js:186` | "Anonymous UCT student" | "A UCT student, verified by email" | Says the useful thing: this is a real student. |
| `src/views.js:2715` | "For lecturers, staff or anyone a review is about. No account needed." | Add: "We reply within 48 hours. Signed-in staff requests hide the review at once." | Matches the H1 fix. |
| `src/views.js:2459` | "but not which student wrote a review" | See audit C2 for honest wording. | Accuracy. |
| `src/views.js:2408` | "American students have RateMyProfessors..." | Lead with what Kwaai is for: choosing courses with better information. Mention RateMyProfessors second, with how Kwaai differs. | For a lecturer, RateMyProfessors is a warning, not a selling point. |
| `src/views.js:1972` | "...and your streak" | Remove. | Audit M8. |
| `src/views.js:1811` | "Need a nudge" | Keep. | Clear and kind. |
| `src/views.js:107` | Sign out button with the email only in a tooltip | Show "Signed in as abc...@uct.ac.za" in the account menu | Phones have no tooltips. |

## 6. Screens to check in the browser pass

Phone (375 px) first, then desktop (1280 px), signed out, as a student and as staff:

1. Home (new visitor and returning student)
2. Course page with reviews, and one with none
3. Lecturer page
4. Review form
5. Sign-in, code entry, confirm
6. Takedown form
7. Classes list, new class form
8. Lecturer class page (all sections), register screen with 60 names, QR open
9. Student join screen, class page, check-in
10. House rules, about, privacy, terms
11. Moderation page
12. Today, Study, Week, Planner, Marks (student side, lighter check)

For each: horizontal scroll, text under 12 px, targets under 44 px, clipped tables, sticky header overlap with anchors (`#roster`, `#dp`), and what the page looks like while a form is submitting.
