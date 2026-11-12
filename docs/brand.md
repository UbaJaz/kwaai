# Kwaai brand identity and rank badges

Date: 12 November 2026. Three concepts to choose from. Nothing is drawn yet: pick one and it gets developed in Figma, then built as SVG.

## Where the brand stands

**What exists and should stay**

- The name. "Kwaai" means both cool and strict, which is the product in one word.
- Ink `#151d2b`, lime `#c8f169`, paper `#f7f7f2`. Lime only ever as a fill behind ink.
- The icon: a lime rounded square with a geometric K made of one upright bar and one chevron (`public/kwaai-icon.svg`).
- Bricolage Grotesque for headings, Inter for text.

**What is generic**

- The rank emblems (`src/views.js:381-397`): a shield, a crest, a gem and a star with chevrons. Any game could use them.
- The tier names: Bronze, Silver, Gold, Platinum, Diamond. Only the top one, Kwaai, is ours.
- Emoji standing in for illustrations: the empty score (`🫥`), the streak flame (`🔥`), every message screen.

**One inconsistency to settle first**

`public/kwaai-logo-preview.png` (untracked, used nowhere) shows a different logo from the live one: a thinner chevron on the K, and the wordmark in a rounded geometric typeface. The live site uses `kwaai-icon.svg` with the wordmark as text in Bricolage Grotesque. Decide which is the logo. My recommendation: keep the live one. It is already in the icon files, the share image and the email, and the heavier chevron survives at 16 px.

## Audience and tone

UCT students first, on phones, in Cape Town. Direct, a little dry, local without being a tourist poster. Lecturers also see these badges on class rankings, so they should look like part of a tool and never like a slot machine.

Constraints from the brief: SVG, readable at 24 px, one family with a clear progression, no stock icons, no trophies or star clip art, no UCT logo or crest.

## Three concepts

### Concept A: Chevron stack (recommended)

**Rationale:** the logo's K is a bar and a chevron, so the chevron is already Kwaai's own mark; ranks are built from it and nothing else.

- **Shape language:** the lime tile's rounded square is the frame. Inside it, the chevron from the K repeats.
- **Progression:** each tier adds or rearranges chevrons into a new silhouette, so two tiers never share a shape. Tier 1: one chevron. Tier 2: two, stacked. Tier 3: three, stacked. Tier 4: chevrons mirrored into a diamond. Tier 5: four chevrons rotated into a pinwheel. Kwaai: the full K (bar plus chevron) inside a ring of chevrons, the only badge that contains the logo.
- **Divisions (I, II, III):** one to three short ticks along the bottom edge of the frame.
- **At 24 px:** two flat colours, strokes of at least 2 px, no gradients. The silhouette is readable before the colour is.
- **Rank-up animation:** the new chevron slides in and locks into place.
- **Risk:** stacked chevrons can read as military rank. Rounded joins, the tile frame and the non-military tiers 4 to 6 keep it away from that.

### Concept B: Timer ring

**Rationale:** ranks come only from timed study, so the badge is the study timer's ring, filling up.

- **Shape language:** a circle with 12 tick marks, like the timer already on `/study`.
- **Progression:** more of the ring is filled per tier, and the centre glyph changes: a dot, a bar, the K bar, the K.
- **Divisions:** one to three filled ticks at the top.
- **At 24 px:** weak. Six rings with slightly different fills look alike when small. That is the main reason it is not the recommendation.
- **Rank-up animation:** the ring sweeps round. This is the best animation of the three.

### Concept C: Strata

**Rationale:** Cape Town's mountain is flat layers of sandstone, and study hours pile up the same way: one layer at a time.

- **Shape language:** horizontal bands inside a flat-topped outline.
- **Progression:** each tier adds a band and the outline grows taller. The top tier gets the cloud "tablecloth" as a lime cap.
- **Divisions:** notches on the top band.
- **At 24 px:** good. Bands are simple.
- **Risk:** it ties the brand to one city while `src/universities.js` plans for Wits, Pretoria, Johannesburg and Stellenbosch. A flat-topped mountain is also the most used image in Cape Town. That is why it is third.

### Comparison

| | A. Chevron stack | B. Timer ring | C. Strata |
|---|---|---|---|
| Belongs to Kwaai and nothing else | Strong (comes from the logo) | Medium | Medium |
| Readable at 24 px | Strong | Weak | Strong |
| Each tier has its own shape | Yes | Barely | Partly |
| Works at other universities | Yes | Yes | No |
| Animation | Good | Best | Good |

**Recommendation: A.** If you like B's animation, borrow it: the rank-up moment can play a ring sweep around an A badge.

## Tier names: a decision for you and Jaswin

The metal names are the most generic part of the system, and a new badge with "Gold II" under it is still a game rank. Two options:

1. **Keep the names.** No work. Students already understand the ladder.
2. **Rename the five lower tiers.** Kwaai stays on top. The names should be plain, work at any university, and avoid slang that dates. I do not have a set I would defend yet. If you want this, it is a short naming session with Jaswin, and a planning document is the wrong place to guess.

Cost of option 2: `src/ranks.js:9-10` (names), `src/views.js:430-437` (the text for what each tier gives), CSS class names `tier-bronze` and so on (`public/style.css:966-972`, can stay as internal names), `test/ranks.test.js`, and 16 lines in `test/app.test.js` that mention tiers or emblems.

My recommendation: option 1 for now. Change the look first and see whether the names still bother you.

## Badge system specification (applies to whichever concept wins)

- **Grid:** 48 by 48 viewBox, 4 px safe margin, drawn on the 4 px grid. Exported sizes: 24, 40, 64, 128.
- **Colour:** at most two colours per badge: the tier colour and ink or white. Tier colours stay as CSS variables (`--tier`) so badges theme from CSS. Check 3:1 contrast between mark and fill for every tier (silver and gold look too pale behind white marks today; not measured).
- **Unranked:** the empty frame with a dashed outline, as now.
- **Delivery:** one function that returns inline SVG (as `emblem()` does today), so there are no image requests and the 24 px version can drop detail with a `size` argument.
- **Accessibility:** the SVG stays `aria-hidden`; the rank is always written next to it in text (already the case).
- **Motion:** one rank-up animation under 800 ms, disabled under `prefers-reduced-motion` (already the case).

## The same identity on other assets

| Asset | Today | Change |
|---|---|---|
| Favicon and app icons | `kwaai-icon.svg`, PNG at 180, 192, 512 | Keep. Add a maskable 512 icon with safe padding for Android (the manifest has `purpose: any` only). |
| Social share image | `public/og-card.png`, built from `scripts/og-card.html` | Redraw with the chevron as a repeating edge pattern. Add a second card for the lecturer demo link that says "Lecturer preview", so the WhatsApp preview is not the student pitch. |
| Empty states | Text, sometimes `🫥` | Small line illustrations in ink and lime made from the same shapes: no reviews yet, no classes yet, nothing waiting. |
| Message screens | A large emoji per screen | One small ink icon per kind: done, problem, not found, wait. |
| Streak | `🔥` | A chevron-flame in lime and ink, drawn once. |
| Rank-up moment | Card, emblem pop and confetti | Keep the card. Replace the confetti with the badge animation. |
| Rank card and Wrapped | 9:16 cards with the emblem | Same layout, new badge, chevron pattern in the frame. |
| Email | Lime button, ink code | Add the icon at the top. No other change. |
| QR codes | Plain | Leave plain. A logo in the middle costs scan reliability. |

## Where the old emblems are used: swap list

Definitions:

- `src/views.js:381-387` shapes and tier-to-shape table
- `src/views.js:388-397` `emblem()`
- `public/style.css:964-981` tier colours and emblem styles, `998` extra-large size, `1005` greyed-out ladder rows, `1013` hidden in Wrapped chips, `1020-1023` rank-up pop, `1028` on board names, `1070` share card glow

Every place a badge is drawn:

| Line in `src/views.js` | Screen |
|---|---|
| 399 `rankChip` | Small chip: home "your day", Study rank card season row, rank page, Wrapped |
| 410 | Study page rank card |
| 447, 459 | Rank page: all-time and season |
| 476 | Rank page: the ladder of every tier |
| 497 | Rank-up card (home, Today, Study) |
| 513 `nameTag` | Leaderboards, study groups, class rankings |
| 526 | Rank share card |
| 550 | Test tools rank gallery |
| 2276 | Wrapped card |

Related, and part of the same swap:

- `src/views.js:340` streak flame emoji
- `src/views.js:808`, `927` empty-score emoji
- `src/views.js:2739` and every `views.message(...)` call in `src/app.js` (emoji argument)
- `src/views.js:81` share image, `87`, `97`, `120` icon, `89`, `126` PNG icons
- `public/manifest.webmanifest:12-24`, `public/sw.js:8` (bump `VERSION` when icons change)
- `scripts/og-card.html` (source of the share image)
- `src/email.js:9-13`
- `test/app.test.js`: 16 lines match `emblem` or `tier-`. Read them before changing markup; tests should assert the rank text and leave the SVG paths alone.
- `public/Kwaai.png`, `public/kwaai-logo-preview.png`: delete or adopt (see the inconsistency above).

## What I need from you

1. Concept A, B or C.
2. Which logo is the logo (live icon or the preview PNG).
3. Tier names: keep or rename.
