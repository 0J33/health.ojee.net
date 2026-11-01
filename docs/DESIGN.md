# health.ojee.net — design

The design direction for the 2026-10 overhaul. `docs/SPEC.md` says what the
product is, `docs/API.md` what the server gives; this file says how it looks,
why, and what each screen shows. Tokens live at the top of `web/css/app.css`
and must match this file.


## 2026-10-31 redesign: "Bento, clean" (read this first)

The look and the navigation below this section are the first build's; where
they differ, this section wins. The approved prototype is kept outside the
repo (`~/Downloads/ui-overhaul/final/`); the plan and its history are in
`docs/UI-OVERHAUL.md`.

- **Themes.** Light is warm paper (`--bg #F2EDE5`, cards `#FFFDF9`, ink
  `#1D1A16`); dark is true black (`#0A0908`, cards `#171513`). Theme follows
  the phone unless Me sets Light or Dark (`web/js/theme.js`).
- **Colour per family, as solid tiles.** `--tile-<family>` and
  `--on-tile-<family>` (sleep dusk blue, steps ochre, calories and workouts
  burnt orange, cardio jade, heart rose, body olive, water blue); in dark the
  tiles are deep and their marks bright (`--tile-mark-*`). Chart marks keep
  `--c-*` / `--c-*-t`. Colour is read before words; text never relies on it.
- **Type.** Instrument Sans for text and numbers (numbers semi-condensed,
  `font-stretch: var(--num-stretch)`, tabular); Newsreader for tab titles,
  sheet titles and the morning note. Self-hosted in `web/fonts/` (the CSP
  allows fonts from this origin only).
- **Icons.** One line family, 1.75 stroke, rounded (`web/js/lines.js`,
  shapes after Lucide). `ic(name)` draws the line icon when there is one,
  else the old Material glyph.
- **Navigation.** Four tabs on a phone (Today, Health, Train, People) in a
  floating bar with a sliding highlight; the round Log button beside it; Me
  is the round profile button at the top right of each tab (and a fifth rail
  entry on wide screens).
  The bar never shows without its Log button: a screen with its own round
  action puts it in that place (the routine editor's +), and a task screen
  with its own controls (`task` in main.js: recording or drawing a route,
  like the AI conversation) hides the phone bar; its back arrow leads out,
  and the recorder's Pause and Finish dock at the foot in the bar's look.
- **Glance first.** Each tab's first screen answers its question on one
  phone screen; detail is one tap deeper; nothing is removed, only moved.
  Today: the wide sleep card (time asleep, goal bar, score ring), readiness,
  resilience (Low / Balanced / Optimal, three symbols), steps, calories,
  weekly cardio, live heart rate, then the running workout (or the "was this
  a workout?" question); "More about today" below the fold holds the rest.
- **Motion** (`web/js/motion.js`, `web/css/shell.css`): screens push and pop
  sideways, tabs slide; a screen's blocks rise in on first paint, numbers
  with `data-count` count up, rings with `.fill` fill. Swipe sideways on a
  tab's first screen to change tab; swipe in from the left edge to go back
  (installed app and iPhone app; Safari has its own). Sheets follow the
  finger and spring back; banners drop from the top and flick away. All of
  it honours reduced motion.
- **Units** (Me): distance, body weight, temperature, training volume
  (t / kg / lb), water (ml / fl oz) and the clock (24-hour / 12-hour), each
  its own choice, stored in the profile (`units`), formatted by
  `web/js/format.js` (`volume`, `water`, `clock`, `hhmm`, `hourLabel`).
- **Workout card placement** (Me): on Today or on Train
  (localStorage `health.wcard`).
- **Stress and Garmin** (2026-10-31). Health's Mind tile shows a Garmin's
  7-day stress level in the mind colour (number, then its word: Rest, Low,
  Medium, High, and Body Battery beside it), else the last stress logged by
  hand as a word, else the last mood. Today keeps its first screen; "More
  about today" gains one quiet Stress line (the watch's level against the
  usual and Body Battery now, or what was logged). The stress page draws the
  watch's 0-100 line, a day's rest/low/medium/high as a split bar, and says
  under the chart what was "Logged by you" (1 to 5, words, never on the
  watch's scale). The Log sheet's Also log grid is food, weight, stress,
  mood, sleep and More (symptoms moved one tap down, to Every log type).
  Connections has Garmin under Accounts and under Devices, tracker: the
  steps to make a key, the field, how long it lasts, how much history, then
  rows for the key (last four), when it runs out, the last sync and read,
  the history and the counts, Sync now, Replace key, Disconnect (keep or
  remove what it brought); onboarding offers it under "Wear a Garmin?".
- **Icon.** A rose heart with a pulse line cut through it, on paper or
  black; the favicon SVG adapts to the browser theme; maskable PWA icons;
  the iPhone app has the iOS 18 default, dark and tinted variants.
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
a module); `--c-x-t` is the same hue for text-size use (≥ 4.5:1). Hues
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
| vitals | `--c-vitals` | `#2fd69b` | `#008a5c` | `#006e49` | breathing rate, blood oxygen, temperatures, glucose, symptoms |
| nutrition | `--c-nutrition` | `#b3bd4e` | `#737d10` | `#59620a` | food |
| water | `--c-water` | `#45c4f2` | `#0086bd` | `#006c99` | water |
| mind | `--c-mind` | `#c58af2` (text `#cf9df5`) | `#9a4fd6` | `#7f39b8` | mood |
| cycle | `--c-cycle` | `#ff7aa5` (text `#ff8fb3`) | `#d6387a` | `#b3245f` | period, ovulation tests |

The five added for "every metric" (2026-10-11) sit in the gaps of the
first eight: `vitals` is an emerald between the `active` cyan and the
`steps` lime; `nutrition` an olive, duller and warmer than lime and darker
than the `body` yellow; `water` a sky blue, lighter and greener than the
`recovery` azure; `mind` an orchid between the `sleep` violet and the
`workouts` magenta; `cycle` a rose, pinker and lighter than the `heart` red.
Contrast, measured (WCAG ratio; module = `--surface`, page = `--bg`):

| family | dark mark on module / page | dark text on module | light mark on module / page | light text on module / page |
|---|---|---|---|---|
| vitals | 9.08 / 11.21 | 9.08 | 3.93 / 4.38 | 5.66 / 6.31 |
| nutrition | 8.35 / 10.31 | 8.35 | 4.03 / 4.50 | 5.93 / 6.61 |
| water | 8.45 / 10.43 | 8.45 | 3.66 / 4.08 | 5.22 / 5.83 |
| mind | 6.72 / 8.29 | 7.94 | 4.22 / 4.70 | 5.92 / 6.60 |
| cycle | 6.95 / 8.58 | 7.97 | 4.00 / 4.46 | 5.64 / 6.30 |

**Stack tones.** The parts of a stacked bar take one of five tones the
server names, as tokens that follow the family in force: `--tone-muted`
(`--surface-3`: the part that is not the point, such as sedentary time),
then `--tone-low`, `--tone-mid`, `--tone-high` (34%, 58% and 80% of the
family's mark over the module) and `--tone-peak` (the mark itself). Classes
`.t-muted` to `.t-peak` set both `fill` and `background`, for bars and
legend swatches. Sleep stages keep their own four colours everywhere.

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
- **Metric row** `metricRow(m)` (`.mrow`) — one metric anywhere: family
  badge, name, when it was last seen (and "Calculated by this app" in words
  where it is), a spark (bars for totals, a line for levels, dots for a
  log), the latest value in the family's colour, and a pin toggle. The row
  is a link to the metric's page. It lays itself out from the width of its
  own list (a container query): two lines in a phone-wide module, one line
  with the spark between name and number from 430 px.
- **Pin toggle** `.pinbtn` — an outline pin, filled and ink when pressed
  (`aria-pressed`), 44 px.
- **Entry sheet** — one sheet for every form, built from the server's
  description of it: one-tap presets first, then the fields (a single
  choice of up to six is a row of chips, a longer one a menu; several
  choices are wrapping chips, with a search box and "Show all" when the list
  is long), then one line saying where the entry is saved.
- **Choice** `.choice` — two or three large rows in a sheet when a decision
  has named options ("Allow in Google" / "Keep on this site only").
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

Order on a phone (the order of the document), and where it goes on desktop.
A module, and a block inside one, exists only when the person has that
data; `brief.extra` says so, and a part that is `null` leaves no hole.

1. **Needs you** (full width): running workout (timer, live heart rate), a
   workout question, an illness warning, a connection problem.
2. **Verdict** (span 7): the readiness label as the headline, the sentence
   why, then its drivers as rows — HRV, resting heart rate, sleep,
   temperature — each with value, baseline, a range bar and whether it
   pushed the verdict up or down. Under the drivers, one quiet line: the
   **recovery trend** over 7 days in words ("near your usual"), what it is
   made of, "Calculated by this app", linking to its page. The verdict is
   about this morning and the trend about the week, so they do not say the
   same thing twice; it is never called stress or resilience. Then
   **next**: the one useful action.
3. **Activity so far** (span 5): the day's rings; steps against the goal
   and the usual for this weekday; hour-by-hour steps; distance and
   **floors**, each against the usual; then **calories** as the total
   against the usual for this weekday with one bar in two parts, active
   and resting, on a track that ends at the usual total (this replaces the
   plain calories stat when the two parts are known).
4. **Weekly cardio** (span 5): a ring of this week's minutes against the
   weekly target, the minutes left and last week's total, the seven days
   as bars with today marked, and one line saying what the minutes were
   counted from and that this app adds them up.
5. **Sleep** (span 7): duration against goal and against the 14-night
   average, with the app's **sleep score** out of 100 beside it against
   its usual (under it on a phone, as one line); the night as stages; each
   stage with its share against the person's own typical share; bedtime
   and wake against usual; regularity; and last, what the score is made
   of, each part as points of its maximum with a thin meter, marked
   "calculated by this app".
6. **Heart** (span 5): live or latest heart rate; resting heart rate and HRV
   over 14 days inside their baseline bands; the day's heart rate by hour
   where the device has it. Blood oxygen and temperature moved to Vitals.
7. **Vitals** (span 7): breathing rate, blood oxygen, sleep temperature
   and VO2 max, whichever there are: one line each with its badge, value
   and unit, and where it sits against the person's own usual. Each line
   links to its metric page. Neutral ink for the comparison: no good or
   bad colour on a vital.
8. **Water and food** (span 7; only with the nutrition group on): water
   against the daily goal as a meter with "250 ml", "500 ml" and "Other";
   food as kcal with the macros in one line, the entries and what was
   burned so far, and "Add food". A save updates the module in place.
9. **Pinned** (span 5): the person's pins as metric rows, in their order,
   with "Edit pins" to Browse.
10. **Worth knowing** (span 7): ranked insights from the server.
11. **This week** (span 5): each day against the same day last week;
    totals with deltas; streaks; goals.
12. **Footer**: the live-heart-rate control (one row when this browser
    cannot do it), and what the device does not report.

Desktop rows: Verdict + Activity; Sleep + Heart; Vitals + Weekly cardio;
Water and food + Pinned; Worth knowing + This week. Weekly cardio follows
Activity in the document (so on a phone it reads with it) and is moved
down a row on desktop with `order` (`.ord-N`, `today.css`), where it is
the natural partner of the vitals. The four extra modules pair up as 7 + 5
in the order vitals, cardio, water and food, pins; when one is left over
it takes the whole row (and lays its halves side by side), so there is
never a hole in the grid whatever the person has.

Phone-only people get activity → week → insights and one sentence about
what a watch would add, exactly as before: none of the new modules exists
for them. A new account sees the same empty state as before.

### Navigation: Browse is the second tab

There is no sixth tab. The tab that was "Trends" is **Browse**: it opens
on every metric the person has (`/trends`), because a tab should be named
for what a tap on it gives, and "all my data" is what people look for
there. One word, and it fits the bar at 360 px. Its glyph is the grid
(`grid_view`). The analysis views are unchanged and sit behind the same
sub-tab bar: Browse, Overview (`/trends/overview`), Sleep, Activity, Heart,
Body. Their page title is still "Trends", and every deep link from Today
("Sleep trends") works as before. A metric's page is `/metric/<id>`, with
the Browse tab lit and a back arrow; coming from Browse, that arrow is a
real step back, so the list returns with its scroll position and search.

### Browse — everything, by category

Order: a search field (filters as you type over names, categories and
everyday words such as "calories", "oxygen", "breathing", "water"; a plain
"Nothing matches" state with a way out); **Pinned** when there are pins
(two rows abreast on desktop); then one module per category in the
server's order, titled in the category's colour with its count, each
metric a hairline-separated metric row; then **No data yet**, folded away
with its count: every metric there is nothing for, grouped by category,
with a muted icon, its name and the line that says what gives it, and
"Add" where it can be logged by hand or "Turn on" where it belongs to an
optional group that is off. Never a hole, never a zero.

Phone: one column. Desktop (≥ 1100): the category modules flow in two
columns, each as tall as its rows. Someone with a phone only gets one
short module, a sentence saying this is what their devices report so far,
and the folded list; a new account gets a sentence about what will appear
and the list opened.

### Metric page — one number, worked out

Header: back, the family badge, the name, "Calculated by this app" where
it is, the pin toggle, and Add where the metric can be logged. Then the
period: Day, Week, Month, 6 months, Year, with arrows to the period before
and after and its dates.

1. **The period** (span 8): the headline (a total against its goal for a
   day; a weekly total in a ring for a metric counted by the week;
   otherwise the average a day), a delta against the period before
   (coloured only when the metric has a better direction), the server's
   reading, one-tap presets where there are any, then the chart: bars with
   the goal line and days at goal in full colour; a line inside the usual
   range with the last point emphasised; lowest-to-highest bars with a tick
   at the average; stacked bars with a legend; the day by the hour. A log
   has no chart: its entries are the content. Under the server's own
   threshold the chart is replaced by "Not enough days yet". Charts take
   the keyboard: focus one and the arrow keys read each point into the
   readout line; "Show as a table" gives the same numbers.
2. **Facts** (span 4, beside): average, total, lowest and highest with
   their days, latest, the goal, the usual range, entries, days with data.
3. **About** / **How this is worked out** (span 4): what it is and where it
   comes from; for the app's own numbers the method in words and, for the
   sleep score, the parts of the latest night as points out of their
   maximum with a meter each. What is always private says so here.
4. **Entries** (span 8, under the chart): newest first, ten at a time. A
   day's value is one line; a logged entry has its time, where it is kept,
   and edit and delete where they are allowed; what cannot be changed says
   why.

The recovery trend is said in words ("Near your usual"), never as its
number in a headline; its chart and facts are in SD and the page says what
that is.

### Optional groups — Me, Connections, "More data"

Five groups, each with its family badge, what it is, a switch, its state
in words ("On: saved to Google Health too" / "On: kept on this site only" /
"Off") and its note; when on, an "Include in summaries" switch. One line at
the top says they are always private. Turning one on that Google has not
been asked for offers "Allow in Google" or "Keep on this site only";
turning one off asks, with the choice to delete what was logged here. In
onboarding the same five are checkboxes under a closed "More data
(optional)" disclosure below the Connect button, which stays the primary
action.

### Trends — analysis

Tabs (after Browse): **Overview**, Sleep, Activity, Heart, Body. Ranges 7 d, 30 d, 90 d,
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
