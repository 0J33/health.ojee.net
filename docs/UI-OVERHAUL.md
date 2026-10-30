# UI overhaul plan

Status: built 2026-10-31 in the "Bento, clean" direction chosen after three rounds of
prototypes (see the redesign section at the top of docs/DESIGN.md, which supersedes
the sketches and open questions below).

## Goal

Glance first, detail on demand. Every tab answers its main question on one
phone screen (iPhone 15/16: about 690 px of content between the status bar
and the tab bar) with no scrolling. Everything else is one tap away, in
pages that stay readable: a headline, what it means, a chart, then the
details.

## Rules for every screen

- One screen, one job. A tab's first screen never scrolls on a phone.
- One way to do each thing. Start workout, water and food each get one home
  (the Log sheet) plus the place they belong (Train, Nutrition), not four.
- One AI entry per page: a spark button in the header that asks about what
  the page is showing. No Ask AI buttons on every card.
- Numbers first, words second, charts third. A tile shows one number, its
  unit, and a one-word state (High, Low, On track), and nothing else.
- Taps go deeper, never sideways. A ring opens its metric, a tile opens its
  score, a category opens its category page.
- Colour means family (steps green, sleep violet ...), status uses the ok,
  warn and bad colours. Nothing decorative competes with them.

## Global

- Tabs: **Today · Health · Train · People · Me** (Workouts becomes Train,
  Ranks becomes People). Glass tab bar.
- **Log** button (bottom right) opens the Log sheet. Its first row is
  **Start activity** (empty, route, routines), then water, food, weight,
  mood and the rest.
- **Live heart rate** pill (bottom left): the corner button as built on
  2026-10-30. Connected and pinned, it moves into the Today header as a
  live chip instead of a big card.
- Battery: only a warning chip in the Today header when a tracker is low.
  Full status lives in Me, Devices.

## Today: no scroll

```
┌──────────────────────────────────┐
│ Fri 30 Oct      ♥ 72 live   ✦    │  header: date, live chip, AI
├──────────────────────────────────┤
│        ◎◎◎◎         Steps  8,214 │  one cluster of four concentric
│       ◎    ◎        / 10,000     │  rings, legend beside it:
│       ◎    ◎        Sleep 7h 17m │  steps, sleep, weekly cardio,
│        ◎◎◎◎         Cardio 64/150│  calories burned
│                     Burned 2,140 │
├──────────────────────────────────┤
│ Sleep 97 │ Ready 70 │ Resil Bal. │  three score tiles
├──────────────────────────────────┤
│ ✦ Best sleep of the week. Aim... │  morning AI line (tap: full)
├──────────────────────────────────┤
│ [ Was 19:42-20:50 a workout? ]   │  one action slot, only when needed
└──────────────────────────────────┘                        [+ Log]
```

Taps: each ring opens its metric page; each score opens its page (sleep
night, readiness drivers, resilience); the AI line opens the AI sheet.

Moves off Today: steps-by-hour, sleep stages, heart detail, vitals, Worth
knowing and This week go to Health; water and food to the Log sheet and
Health, Nutrition; battery to Me; pinned metrics to Health.

## Health: categories at a glance

- Top: an Insights strip, two or three cards sideways (today's Worth
  knowing and the week).
- Then a 2×3 grid of category tiles: Sleep, Heart, Activity, Body, Vitals,
  plus Nutrition, Mind and Cycle when they are on. Each tile has one key
  number, a 7-day spark and a status colour.
- Search and pins in the header.
- **Category page** (replaces both Browse and Trends): hero chart of its key
  metric with the range control, the analyses that used to be Trends (sleep
  regularity and stages; heart RHR, HRV and scatter ...), then every metric
  in that category as rows.
- **Metric page**: as now, tightened. Headline and meaning, chart, This
  week facts, then entries and About.

## Train: start fast, see progress

First screen:
- Start row: Empty, Record route, then your top three routines as chips.
- This week: sessions, time and volume against your usual, in one card.
- Last three sessions.
- Rows: Routines · Exercises · Progress · History.

Progress page: records, strength volume, muscle balance, zones, by
exercise. Import and Detection move to Me, Connections. The logger and the
recorder become full-screen focus modes with large targets and a live heart
rate ring.

## People

First screen: your position for the chosen metric (rank, who is just ahead
and behind, the gap), metric and period chips, then the standings. Compare
and profiles from the header.

## Me

Already a list; it stays one. A profile card, then rows with badges
(Devices with battery, Accounts, Privacy, Notifications, Goals and units,
Data, About with Check for updates).

## Look and motion

- Dark first, light kept. Rings in the family colours with a soft glow, an
  end cap and a gradient along the stroke.
- Rings fill and numbers count up on first paint (staggered, under 600 ms).
  Never again on a repaint.
- A tile grows into its page (View Transitions API: Safari 18 and Chrome),
  and back.
- Sheets spring and follow the finger (drag-to-close exists).
- The live heart rate chip beats with the real bpm.
- All of it honours reduced motion.

## Skills used for the build

- **impeccable** (installed) leads: shape, critique, polish, animate, live
  mode.
- **dataviz** (built in): rings and charts.
- **Emil Kowalski's skills** (to install): emil-design-eng, animate,
  mobile-native, review-animations. For motion and a native feel.
- **design-taste-frontend** (to install): only for the visual direction.
- **apple-design** and **ui-skills** baseline-ui: a final QA pass.

## Order of work

0. Direction: three Today variants as a clickable prototype in the demo.
   Pick one.
1. Tokens, rings, tiles, the header chip, the tab bar.
2. Today.
3. Health with category pages (merges Browse and Trends).
4. Train and the focus modes.
5. People and Me.
6. Motion and transitions everywhere, then a QA pass.

## Open questions

- Rings: one concentric cluster (Apple Activity style), or four separate
  rings in a 2×2?
- Tab names: Train and People, or keep Workouts and Ranks?
- Water and food: keep them off Today (Log sheet only)?
- Dark first, or follow the phone's setting?
