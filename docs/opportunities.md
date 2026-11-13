# Competitors and highest-return opportunities

Date: 12 November 2026.

## How far the research got

Every claim below is tagged.

- **Opened:** I fetched the page and read it on 12 November 2026.
- **Snippet:** I saw it only in a search result summary. Treat as a lead.
- **Unverified:** I could not open a source. Reddit blocks this tool, and WhatsApp groups have no public page. These lines are assumptions that you, as a UCT student, are better placed to confirm than I am.

The thinnest part is how UCT students choose courses today. I found no public evidence either way. Five short conversations with students would be worth more than this section.

## Competitors

### RateMyProfessors

| | |
|---|---|
| What it does well | Scale and habit: its name is the verb. Lecturers with an institutional email can post replies to comments, and the site ran "Professors Strike Back" videos. (Opened: [Wikipedia](https://en.wikipedia.org/wiki/RateMyProfessors)) |
| Biggest weaknesses | No proof a reviewer is a student or took the course: the site "does not require users to create an account, non-students or even professors themselves can post ratings". People can rate one professor many times. Ratings track how easy a lecturer is thought to be. The "hotness" score was removed on 28 June 2018 after academics said it fed sexism. (Opened: same Wikipedia page) |
| Evidence of bias | A PLOS ONE study of 14 million reviews found students two to three times more likely to call male professors "brilliant" or "genius". A 2006 study found the highest ratings went to professors seen as easy graders or good-looking. (Opened: [Times Higher Education](https://www.timeshighereducation.com/news/large-rate-my-professor-study-finds-gender-bias-comments)) |
| Coverage | American, Canadian and United Kingdom institutions. (Opened: Wikipedia.) Whether it lists UCT at all: not confirmed. My search did not find a UCT page. |
| Why students still use it | Unverified, my reading: it is the only place with any signal about a lecturer before registration, and one data point beats none. |

### AcademicJobs "Rate My Professor" pages for South African universities

| | |
|---|---|
| What it is | A jobs site with a rating page per university, including UCT, Wits and Stellenbosch. (Snippet. The UCT page returned HTTP 403 when I tried to open it: [academicjobs.com/rate-my-professor/uct/12637](https://www.academicjobs.com/rate-my-professor/uct/12637)) |
| Weakness | The search summary quotes the UCT page as "No Ratings for UCT Yet!". It reads as search-engine filler. (Snippet) |
| Why it matters | It will outrank Kwaai on "rate my professor UCT" for a while. That is fine: Kwaai should not chase that search term (see cut 1 below). |

### iAgora and EDUopinions

University-level reviews, mostly by exchange students, with little about individual courses. (Snippet: [iAgora UCT reviews](https://www.iagora.com/studies/uni/University_of_Cape_Town/reviews?offset=1), [EDUopinions UCT](https://www.eduopinions.com/universities/universities-in-south-africa/cape-town/university-of-cape-town-uct/biological-sciences-reviews/)). No overlap with Kwaai.

### Reddit (r/UCT) and WhatsApp class groups

Unverified. I could not read Reddit, and group chats are private. Assumptions to test with students:

- Advice lives in "which elective is easy?" threads and in what seniors say in residence and course groups.
- Strength: the answer comes from someone you can ask a follow-up question.
- Weakness: it is gone in a week, it depends on who you know, and first-years know nobody.

If those hold, WhatsApp is Kwaai's real competitor and its real distribution channel.

### UCT's own tools

- **Handbooks.** Public PDFs with entry requirements, DP rules and assessment. Kwaai already reads them ([handbooks page](https://uct.ac.za/students/study-uct-handbooks/handbooks), cited in the README). Their weakness is being several hundred pages long with no clash checking.
- **Official course evaluations.** Unverified: I did not find a public page on whether results are shared with students. If they are not, that gap is the honest reason Kwaai exists, and it is worth one sentence on the lecturer page.
- **Amathuba and PeopleSoft.** Where lecturers already post dates and keep class lists. Kwaai's class tools duplicate part of that. A lecturer will ask "why not Amathuba?" and the answer has to be specific: a tap register on a phone, DP warnings for students, and class reps adding dates.

### Study timers with leaderboards

Forest, YPT and similar apps. Unverified, not researched. They matter because a third of Kwaai's code is a study timer with ranks, quests and seasons, and those apps do only that.

## Where Kwaai is weaker today

1. **It is empty.** RateMyProfessors has millions of ratings and a WhatsApp group has a senior who answers tonight. Kwaai has sample data. Nothing else on this list matters as much.
2. **It is four products.** Reviews, a semester planner, a study game (timer, streaks, ranks, quests, seasons, leaderboards, groups, Wrapped) and class management for lecturers (lists, registers, DP, pulse checks, announcements). Two students maintain all of it. Each one alone has a stronger competitor.
3. **Lecturers have no voice.** They can ask for removal and nothing else. RateMyProfessors at least lets them reply.
4. **The first load is slow** (see `docs/audit.md`).
5. **Sign-in costs an email round trip**, and under-18s are excluded, which removes part of first year.
6. **The anonymity promise is stronger in the copy than in the database** (audit C2).

Where Kwaai is already ahead of RateMyProfessors: verified student email, one review per student per course and year, ratings about the course as taught, difficulty kept apart from quality, a minimum of 3 reviews before ranking, screening, reports and a takedown route.

## Proposed improvements, highest return first

| # | Improvement | Problem it solves | Evidence | Effort | Expected impact | Monetisation later |
|---|---|---|---|---|---|---|
| 1 | **Lecturer reply and course note.** A verified staff account can post one short reply under a review of their course, and one note at the top of the course page ("The 2027 course has a new textbook and weekly quizzes"). | Lecturers feel ambushed and have no recourse except removal. | RateMyProfessors offers replies to professors with an institutional email (Opened: Wikipedia). | M | High for lecturer goodwill, which decides whether UCT tolerates the site. | No |
| 2 | **Comments show from 5 reviews.** Ratings count at once; written comments and the per-lecturer table wait for five. | Students in small classes can be identified (audit H2). | 1,884 of 3,160 courses are NQF 8 or higher (counted in the seeded database). | S | High. It is the anonymity promise made true. | No |
| 3 | **Structured tips in place of free text.** Three prompts with short answers: "Do this from week 1", "Best resource", "What surprised me". | Free text is where defamation and moderation load come from, and it is where RateMyProfessors' bias shows. | The gender-bias findings are about free-text comments (Opened: Times Higher Education). | M | Medium to high: more useful to the reader and less for two moderators to check. | No |
| 4 | **Class reps as the way in.** One rep adds the semester's test dates; everyone with the course in their plan gets them in their calendar. Build a short rep onboarding and a "share to the class group" message. | Empty site, and dates buried in group chats (unverified). | The feature exists and is tested (`test/app.test.js`, class dates and class reps). | S | High if the WhatsApp assumption holds: every rep brings a class. | No |
| 5 | **Tut and prac registers for tutors, done properly.** Fix the class list limit, test the Amathuba file with one course admin, add class archive and delete. | The lecturer-side reason to say yes. This matches the lecturer strategy already chosen: tuts, pracs and DP, tutors first. | Audit H4, M6, M7. | M | Medium now, high for a pilot. | Possibly: a department licence. Only after a pilot shows use. |
| 6 | **Show how much to trust a score.** Number of reviews, which years they cover, and "based on 3 reviews, treat with care" under 10. | A score from three students looks as solid as one from sixty. | "Little reason to think that the ratings accurately reflect the quality of the professors rated" is the standard criticism (Opened: Wikipedia). | S | Medium. Cheap, and it is the first thing a statistics lecturer will ask about. | No |
| 7 | **Exam-season rating drive.** The home page already switches to "rate first" from November to January (`src/app.js:198`). Add a share card per course and a count of how many more votes a course needs. | Empty site. | None beyond the obvious: no content, no readers. | S | High, and it has a deadline: 2026 courses are fresh now and registration opens in January. | No |
| 8 | **Pre-registration planner link.** Make "check my semester for clashes" the thing students share in January. | Gives a reason to visit before any reviews exist. | The planner works without reviews and reads all ten handbooks. | S | Medium. | No |

Monetisation in general: nothing here should carry ads or charge students, and nothing should ever let anyone pay to remove or bury a review. The only plausible paid product is the class tooling in row 5, sold to departments, and only after a pilot. Budget is R0, so none of the eight needs a paid service.

## What to cut, bluntly

1. **Lecturer rankings, and "lowest rated" above all.** A public league table of named staff is the feature most likely to end the project, and it is the least useful to a student choosing a course. Rank courses. Show a lecturer's scores only on the course they taught.
2. **Rating lecturers on being funny.** Rename the dimension to "engaging" and drop the "Funny" tag (wording in `docs/ux-plan.md`).
3. **Freeze the study game.** Keep the timer and the streak. Stop building ranks, name styles, seasons, quests, leaderboards and Wrapped until the review side has real content. I am not suggesting deleting working, tested code. I am suggesting no new work there, and hiding it from the lecturer demo. The badge redesign in `docs/brand.md` is the one exception you asked for.
4. **The "coming soon" universities page.** Four universities with no data and no date. It promises work two people cannot do. Remove the page and the header chip until a second university is real.
5. **The comment gate while the site is thin.** Hiding all but two comments per page until a visitor votes makes an empty site look emptier. Turn it on per course once that course has, say, 10 comments.
6. **`DEMO_PASSWORD` for the lecturer demo.** Replaced by the demo mode in `docs/lecturer-demo.md`.

## Decisions I need

Tick the rows you approve from the table (1 to 8) and the cuts (1 to 6). Approved items go into the last section of `docs/implementation-plan.md`. Row 2 is already in the plan's first phase because it is an anonymity fix.
