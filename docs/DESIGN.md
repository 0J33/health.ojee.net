# health.ojee.net — design

The design direction for the 2026-10 overhaul. `docs/SPEC.md` says what the
product is, `docs/API.md` what the server gives; this file says how it looks,
why, and what each screen shows. Tokens live at the top of `web/css/app.css`
and must match this file.

## Who this is for (the interview, answered from the spec)

Nobody could be interviewed for this pass, so these answers are derived from
`SPEC.md` and the owner's brief and are assumptions until he says otherwise.

- **Who**: ojee and a handful of friends. Mixed devices: a Fitbit Air with
  everything, a Pixel Watch, a Garmin without HRV, an Apple Watch, a bare
  phone. Not athletes, not patients: people who lift or run a few times a
  week and like to see how they are doing, and how they are doing against
  each other.
- **Where and when**: a phone, several times a day, a few seconds at a time
  (morning: how did I sleep, what kind of day is it; evening: did I make it).
  Occasionally a desktop browser, where there is time to look at a season.
- **The job**: turn numbers into a judgement. "Is this good for me?" is the
  question every screen must answer before it is asked.
- **Mode**: Operate (impeccable's term). The person is in a task; the
  interface should disappear into it. Familiarity is a feature.
- **Tone**: calm, exact, a little dry. A good instrument, not a coach. No
  cheering, no medical claims, no fake precision; when there is too little
  data it says so.
- **Anti-references**: the card wall (every fact in its own identical rounded
  box), the hero-metric template (big number, small label, nothing else),
  rainbow fitness dashboards, glass, gradients, marketing-page whitespace.
- **Kept**: the lime `#b6f23c` of the icon as the brand; system type; no
  build step; strict CSP.
- **Changed by the owner mid-way (2026-10-11)**: pure black and pure white
  grounds, a vivid colour per metric family, bold rings and rounded
  numerals, and one proper icon family.

## What was wrong (critique of the first build, 2026-10-11)

Looked at on 390 and 1440 px, light and dark, as `demo` and `sam`.

1. **Flat hierarchy.** Every fact sat in the same 18 px rounded card with the
   same 28 px number. The step ring was the only thing with a different
   shape, so the eye had one place to go and then nothing.
2. **Numbers without meaning.** "1,130 kcal · burned so far today", "64 bpm",
   "95.4 %" — none said whether that is high, low or ordinary for this
   person. Only readiness and resting heart rate carried a comparison.
3. **Too little per screen, and the wrong things first.** On a phone the
   second screenful of Today was a card explaining that this browser cannot
   use Bluetooth. Streaks were two boxes with a number. There was no week,
   no "what changed", no next step.
4. **Desktop was a stretched phone.** Two columns of the same tiles, the left
   one ending half-way down; Ranks was a 1,040 px wide list with the name on
   one edge and the number on the other.
5. **Charts without context.** One line and a dashed baseline: no average, no
   band, no best or worst, no weekday pattern, no distribution, nothing
   longer than 90 days in the UI, the same "Touch the chart to read a day"
   over every one.
6. **Workouts was an endless log.** Ten identical weeks of rows, with the
   only analysis (three numbers) at the very bottom, under "Show older".
7. **Generic styling.** Pill buttons, pill tabs, pill chips, soft cards: the
   components were correct and anonymous.

What was right and stays: the copy (plain, exact), the capability handling,
the accessibility groundwork (labels, focus, table alternatives), the
colour identity, the hand-drawn SVG charts, the no-layout-shift live tile.

## Principles

1. **Every number is shown against something.** The person's own usual, a
   goal, the previous period, or a typical range — and a few plain words
   that say which way it leans. A number alone is a bug.
2. **Glance, then depth.** The first screenful answers the question of the
   moment. Everything below it is the working-out, in the same order every
   day.
3. **Structure from type and rules, not boxes.** A module is a surface only
   when it is a unit you could pick up. Inside a module, things are
   separated by hairlines and space. No card inside a card.
4. **A colour per metric family, the brand for actions.** Steps are lime,
   the heart is red, sleep is violet, and so on (Tokens, Colour): the colour
   says which metric this is, everywhere it appears. Comparison data is ink
   or grey. Semantic colour (good, caution, bad) only where a direction has
   a real valence. Never colour alone: a label or an icon is always there.
5. **Desktop is a dashboard, not a wide phone.** Modules sit on a 12-column
   grid and each is as wide as its content deserves.
6. **Built from what the person has.** A module whose data the device does
   not produce is left out; what is missing is said once, in one place
   ("Your phone does not report sleep, heart rate …"), not as a row of
   holes.
7. **Quiet motion.** State changes ease in 160 ms. Charts do not animate in.
   Reduced motion removes the rest.

## Tokens

### Colour

The owner's direction (2026-10-11): in the manner of a phone's own health
and fitness apps, without copying one. Pure neutrals, and a colour per
metric family.

**Neutrals** are untinted. One system, used everywhere: the page is pure
white (light) or pure black (dark); modules are a barely-raised grey.

| token | light | dark | use |
|---|---|---|---|
| `--bg` | `#ffffff` | `#000000` | page ground, inputs |
| `--surface` | `#f2f2f7` | `#1c1c1e` | modules, the tab bar |
| `--surface-2` | `#e5e5ea` | `#2c2c2e` | wells, tracks, hover |
| `--surface-3` | `#d1d1d6` | `#3a3a3c` | pressed, comparison bars |
| `--raise` | `#ffffff` | `#636366` | the selected segment of a control |
| `--line` | `#dcdce1` | `#2e2e31` | hairlines |
| `--line-strong` | `#aeaeb2` | `#48484a` | control borders |
| `--ink` | `#000000` | `#ffffff` | text, comparison marks |
| `--ink-2` | `#3a3a3c` | `#d1d1d6` | secondary text |
| `--dim` | `#636366` | `#98989f` | labels, axes (5.4:1 / 5.9:1 on a module) |

**Brand**: the icon's lime, `--brand: #b6f23c`, with `--on-brand: #10140a`
on it. It fills primary buttons, the selected tab and switches in both
themes. As text (links, quiet buttons) it is `--accent`: `#b6f23c` on dark,
`#3b6b00` on light (5.7:1). It doubles as the steps colour.

**Metric families.** Each family has one hue, used for its rings, charts,
icon badge, module title and headline number. `--c-x` is the mark (≥ 3:1 on
a module); `--c-x-t` is the same hue for text-size use (≥ 4.5:1). Eight hues
spread round the wheel so neighbours differ in lightness as well as hue, and
colour is never the only signal: every use has a label or an icon beside it.

| family | token | dark (mark = text unless noted) | light mark | light text | what is in it |
|---|---|---|---|---|---|
| steps | `--c-steps` | `#b6f23c` | `#4c8a00` | `#3b6b00` | steps, distance, the activity module |
| active | `--c-active` | `#35d6d0` | `#008f8a` | `#007570` | active / zone minutes |
| energy | `--c-energy` | `#ff8f3a` | `#d85a00` | `#b04700` | calories, skin temperature |
| heart | `--c-heart` | `#ff4d5e` (text `#ff6b79`) | `#e11d3f` | `#c0152f` | heart rate, resting heart rate, zones |
| sleep | `--c-sleep` | `#8e7dff` (text `#a497ff`) | `#6a55e8` | `#5641d1` | sleep; stages `--c-deep`, `--c-light`, `--c-rem`, `--c-awake` |
| recovery | `--c-recovery` | `#4aa8ff` | `#0a76d6` | `#075fb0` | readiness, HRV, SpO2 |
| body | `--c-body` | `#ffd03b` | `#a37800` | `#7a5a00` | weight, body fat |
| workouts | `--c-workouts` | `#f25fd0` (text `#f573d7`) | `#c626a6` | `#a61d8b` | sessions, volume, records |

How it is applied: an element with `class="fam fam-heart"` sets `--mark`
and `--mark-t` (and the ramp `--m-1…4` and the soft tint `--mark-soft`)
for everything inside it. `mod({ fam })`, `ib(icon, { fam })` and the chart
classes all read `--mark`, so a chart takes its family's colour from the
module it is in. Comparison data (last week, another person, a rolling
average) stays ink or grey so the family colour always means "this metric,
you, now".

**Semantic** colours stay separate from the families and always come with
an icon or a word: `--ok` `#0f7a55` / `#4fd6a4`, `--warn` `#8a5a00` /
`#f2b84b`, `--bad` `#c0362c` / `#ff7b6e`, each with a `-soft` ground.

### Type

System stack (SF on Apple devices, Roboto on Android). Headline numerals
use `--font-num`: the system's rounded face where there is one
(`ui-rounded`), else the system face. A fixed scale (no fluid type in the
app):

| token | px | use |
|---|---|---|
| `--t-cap` | 12 | axis labels, fine print |
| `--t-s` | 13.5 | labels, secondary lines |
| `--t-m` | 16 | body, rows |
| `--t-l` | 18 | module titles |
| `--t-xl` | 22 | stat values |
| `--t-2xl` | 28 | page titles, key stats |
| `--t-3xl` | 40 | the one headline number of a module |
| `--t-4xl` | 56 | the one headline of a screen (Today's verdict figure, a running timer) |

Weights: 400 body, 550 row titles, 700 module titles and numbers, 800 page
titles. Numbers are tabular everywhere. Module titles are sentence case in
their family's colour beside the family's icon badge; the small labels
inside a module (`.sub`, ring legends) are 12 px upper-case. Tracking tightens with size (−0.01em at 18, −0.02em
at 28, −0.03em at 40+), never below −0.04em.

### Space, radius, elevation

4 px base: 4 · 8 · 12 · 16 · 20 · 24 · 32 · 48. Inside a module 16 (20 from
600 px). Between modules 12 on a phone, 16 on desktop. Between page sections
32. More space above a heading than below it.

Radii: 8 (controls inside modules), 12 (inputs, small wells), 20 (modules,
sheets), full (pills: buttons, switches, segmented controls only).

Elevation: modules are flat — told from the page by tone alone. Shadows only for things that float: sheets, toasts,
the pinned leaderboard row.

### Motion

`--ease: cubic-bezier(0.16, 1, 0.3, 1)`. 160 ms for colour and background,
220–280 ms for sheets. Progress bars and rings ease to their value once, on
first paint. Nothing loops except the live dot and skeleton shimmer.

## Components

One vocabulary; every screen is made of these.

- **Module** `.mod` — the unit of a dashboard. Header (`.mod__head`: title,
  optional note, optional link "Sleep trends ›"), body, optional footer.
  Sizes by grid span, not by padding. Variants: `--plain` (no surface, for
  lists that already are a surface), `--accent` (a question waiting),
  `--ink` (the running workout: inverted).
- **Stat** `.stat` — label, value + unit, then a *context line*: a delta chip
  and words ("12% above your usual Sunday"). Sizes `--s` (22), default (28),
  `--l` (40), `--xl` (56). Never used without its context line unless the
  value is itself a comparison.
- **Delta** `.delta` — arrow + amount. `--good` / `--bad` only when the
  metric has a better direction; otherwise neutral ink.
- **Rings** `rings([...])` — concentric goal rings with round caps, each in
  its family's colour over a soft track of the same hue: the day's goals at
  a glance (steps, active minutes, and sleep or calories). The legend
  beside them carries the numbers, so the rings never stand alone.
- **Icon badge** `ib(name)` — a filled glyph on a soft tint of its family's
  colour: module headers, driver rows, list rows.
- **Range bar** `.range` — the signature mark. A thin track; a band for the
  person's typical range (25th–75th percentile, or baseline ± 1 SD); a tick
  for the goal or the usual; a dot for today. Says "where am I against
  myself" in 6 px of height. Always has a text alternative.
- **Progress** `.meter` — value against a goal, with an optional tick for
  "where you usually are by now / by the end of this weekday".
- **Row** `.row` — list rows (settings, records, sessions). 56 px min.
- **Fact list** `.facts` — label/value pairs in a grid with hairlines, for
  the working-out under a headline (stages, averages, extremes).
- **Segmented control** `.seg` — range and mode switches. **Tabs** `.tabsub`
  — an underlined text tab bar for a screen's sub-sections (Trends: Overview,
  Sleep, Activity, Heart, Body), scrolls sideways.
- **Chips** `.chip` — filters (leaderboard metric).
- **Insight** `.insight` — icon, one sentence in bold, one line of
  working-out, optional link. Ranked; the list shows the top few.
- **Banner**, **empty state**, **skeleton**, **sheet**, **toast** — as
  before, restyled to the tokens.

## Chart language

Hand-drawn SVG, drawn at the pixel width of its box.

- **Marks**: the person's own data is its family's colour, drawn thick
  enough to read on a phone (2.5 px lines, bars two thirds of their slot). A
  rolling average or a second person is ink. A baseline is a dashed grey line; a typical range is
  a soft band behind the data. Nothing else has colour.
- **Bars** for things that add up per day (steps, minutes, sleep); days at
  goal are the full accent, others a lighter step. A 7-day average line can
  ride over them.
- **Lines** for states (resting heart rate, HRV, weight): the daily values
  thin, the smoothed line strong, the last point emphasised and labelled
  with its value. Best and worst in range are marked directly.
- **Small multiples**: weekday pattern (7 bars, Mon–Sun, the best weekday
  labelled), distribution (a histogram with the median and today marked),
  hour-of-day (24 bars), week against last week (paired bars).
- **Scatter** for sleep regularity (bedtime and wake per night on a clock
  axis with the mean and ± 1 SD band) and for relationships (sleep against
  next-day HRV), always with n and a careful sentence.
- **Heat-map** for the year; **stacked bar** for zones and muscle share.
- **Axes**: 12 px labels, at most three y ticks, 3–6 x labels, units in the
  module title. Gridlines are hairlines.
- **Reading**: a readout line above each chart shows a default summary and
  the touched day; every chart has `role="img"` with a sentence and a table
  alternative.
- **Too little data**: under 7 days a trend says "Not enough days yet (n of
  7)" in place of the chart; a relationship needs 14 pairs.

## Icons

One family: Material Symbols Rounded, weight 400 (Apache-2.0), generated
into `web/js/icons.js` by `scripts/make-icon-set.mjs`; see `docs/ICONS.md`.
Metric glyphs are filled and take their family's colour, usually on an icon
badge; actions and settings rows use the outline in the text colour; the
tab bar shows the outline and, for the selected tab, the filled drawing on
the brand colour. Nothing is hand-drawn except the app's own `pulse` mark.

## Layout

- Phone (< 700 px): one column, modules full width, 16 px gutters, bottom
  tab bar.
- Tablet (700–1099): two columns of modules.
- Desktop (≥ 1100): side rail (220 px) + a 12-column grid, 16 px gap, max
  content width 1320 px. Modules declare a span (`--4`, `--5`, `--6`, `--7`,
  `--8`, `--12`).
- Works at 360 px. Safe areas on every fixed edge.

## Screens

### Today — the daily brief

Order (phone), and where it goes on desktop:

1. **Needs you** (full width): running workout (timer, live heart rate), a
   workout question, an illness warning, a connection problem.
2. **Verdict** (span 7): the readiness label as the headline, the sentence
   why, then its drivers as rows — HRV, resting heart rate, sleep,
   temperature — each with value, baseline, a range bar and whether it
   pushed the verdict up or down. Then **next**: the one useful action
   ("2,104 steps to your goal — about a 20-minute walk").
3. **Activity so far** (span 5): steps against the goal with the tick for the
   usual for this weekday; hour-by-hour steps; distance, active minutes and
   calories each against the usual for this weekday.
4. **Sleep** (span 7): duration against goal and against the 14-night
   average; the night as stages; each stage with its share against the
   person's own typical share; bedtime and wake against usual; regularity.
5. **Heart** (span 5): live or latest heart rate; resting heart rate and HRV
   over 14 days inside their baseline bands; the day's heart rate by hour
   where the device has it; SpO2 and temperature when present.
6. **Worth knowing** (span 7): ranked insights from the server (what changed
   since yesterday, streaks at risk, records, unusual values, week pace).
7. **This week** (span 5): each day against the same day last week; totals
   with deltas; streaks with "at risk today" and what is needed; goals.
8. **Footer**: device and battery, last sync, the live-heart-rate control
   (one row when this browser cannot do it).

New: baselines for every tile, hourly shape, stage shares against typical,
what changed, week against last week, ranked insights, next action, streak
risk. Phone-only people get verdict → activity → week → insights and one
sentence about what a watch would add.

### Trends — analysis

Tabs: **Overview**, Sleep, Activity, Heart, Body. Ranges 7 d, 30 d, 90 d,
6 m, 1 y. Each metric module: the period average as the headline with a delta
against the previous period of the same length; the chart (daily marks +
7-day average + band/goal + best and worst labelled); then a fact list
(average, median, typical range, best, worst, days at goal); then weekday
pattern and distribution as small multiples.

- Overview: one row per metric the person has — average, delta, sparkline
  with band — as a scannable table, plus relationships.
- Sleep: duration; stages over time (stacked); regularity scatter with a
  score; sleep debt against the goal; weekday pattern.
- Activity: steps, active minutes, distance, calories; goal hit rate;
  weekday pattern; best days; year heat-map at 1 y.
- Heart: resting heart rate and HRV with baseline bands and out-of-band
  days marked; SpO2 range; skin temperature; relationship with sleep.
- Body: weight with raw weigh-ins, smoothed line, rate per week and change
  over the range; body fat; add a weigh-in.

### Workouts — training log

1. Running / pending, always first.
2. **This week** against a 4-week average: sessions, time, sets, volume.
3. **12 weeks**: sessions and time per week; time in heart-rate zones per
   week where traces exist.
4. **Strength** (when there are sets): volume by muscle per week (stacked),
   4-week muscle balance with days since each was trained, records set
   recently, progress per exercise (best set and estimated 1RM over time).
5. **Sessions**: recent sessions with a small heart-rate trace, zones bar,
   sets and volume; older ones paged.
6. Tools: start, log a past one, import from Hevy, detection.

Detail: summary with averages against the person's usual session; trace with
zone bands; time in zones; sets with records marked; edit tools.

### Ranks and compare

Board: a podium-free, exact standings table — rank with movement since the
previous period, name, value, a 7-day sparkline, gap to the next person.
Above it "you against the group": your value, the group median, where you
sit. Compare: head-to-head totals with who leads, and day-by-day paired
charts for the period.

### Profile

Header, then a year heat-map with totals for the year, streaks, this week
against last, a 12-week chart, records with dates, recent sessions. Only
public categories, exactly as before.

### Summary, Settings, onboarding, landing

Same vocabulary: modules, rows, tabs. Summary sections become a readable
column with the numbers it used beside it on desktop. Settings keeps its
two-pane layout on desktop. The landing page shows the real Today modules.
