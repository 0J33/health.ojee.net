# Goals, events and ranks

Three things that make circles competitive (v143): **goals** the whole circle
chases together, **events** members start (races or done together), and a
personal **rank** that moves every week. Code: `server/challenges.js`,
`server/rating.js`, `web/js/challenges.js`; pages in `web/js/views/circles.js`.

## 1. Circle goals

Every circle has two at once, made by the minute tick (or on first read):

| goal | dates | measure, in turn | stretch |
|------|-------|------------------|---------|
| weekly | the shared week (Friday 12:00 UTC to the next) | steps, distance, active minutes, gym time, weight lifted | 1.25 |
| monthly ("the big one") | the calendar month | distance, steps, active minutes | 1.35 |

Weight lifted is skipped when nobody in the circle logged sets in the four
weeks before.

- **Target**: what the counted members did a day over the 28 days before it
  starts, times the goal's days, times the stretch, rounded up to two
  figures. Never under a floor a member a day (6,000 steps, 4.5 km, 20 active
  minutes, 8 min of gym, 800 kg lifted). Fixed when it starts.
- **Counted**: members whose audience for that kind takes in circles, as on
  its boards. A member who is not counted is told why on their own view.
- **Trophies**: 50% bronze, 75% silver, 100% gold, 150% platinum. The highest
  reached is the circle's when the goal closes.
- **Top contributors**: the three who gave most (ties share a place).
- **Closing**: the day after its last date at 12:00 UTC, two hours on for late
  syncs. Totals and each part are kept in `circle_goal` / `circle_goal_part`
  and never worked out again. Everyone who gave something is told.

## 2. Events

Any member starts one, for 7, 14 or 28 days, starting today or tomorrow. At
most three on at once in a circle. Whoever started it, or the owner, can call
it off while it runs.

| event | legs |
|-------|------|
| 10K, half marathon, marathon | run 10 / 21.1 / 42.2 km |
| Hybrid race (Hyrox style) | run 8 km, 60 min of gym work |
| Sprint / Olympic triathlon | swim 750 m / 1.5 km, ride 20 / 40 km, run 5 / 10 km |
| Half / full iron distance | swim 1.9 / 3.8 km, ride 90 / 180 km, run 21.1 / 42.2 km |
| Century ride | ride 161 km |

- **Race**: each person does every leg. Finishers rank by the day they
  finished; the first three get gold, silver and bronze. Everyone else is
  ranked by how much of it they did.
- **Together**: the legs once for each person in it, pooled. Finishing wins
  the circle a trophy, and the three who carried most get medals.
- Progress comes from the public daily table (`run_m`, `ride_m`, `swim_m`
  (new in v143), `gym_min`), so only workouts shared with circles count, and
  only people who share them can join.

## 3. Rank

Each shared week scores four things, each 400 points at par and at most 800
at twice it (its max: past that it earns nothing more, and the page says by
how much it went over). The most a week can earn is 3,200: twice par in all
four, an athlete's week.

| thing | par a week | what |
|-------|-----------|------|
| Steps | 70,000 | moving through the day |
| Active minutes | 300 | heart up, as the device counts it |
| Endurance | 25 km run-equivalent | run km, ride km ÷ 3, swim km × 4; walks and hikes left out |
| Training | 4 h | every workout but walks and hikes (`daily_public.train_min`, v164) |

Fair to what is measured (v164):

- A day counts when it has steps. A week with fewer than four such days does
  not count (the rating stays); four to six are scaled up to seven, for the
  steps and active minutes. Workouts are never scaled: one can be logged.
- A device that does not count active minutes (no number on most days with
  steps) is given the steps' points for them, never past par, so the top
  ranks need all four measured.
- Walking all day (work on your feet) fills the steps and the active minutes;
  endurance and training need real sessions.

The rating starts at the first counted week's score and then moves 30% of the
way to each week's score, at least a point, so weeks at the cap do reach
3,200. Two counted weeks place a person.

Tiers sit closer low down and further apart at the top:

| tier | rating |
|------|--------|
| Bronze | 0 |
| Silver | 300 |
| Gold | 600 |
| Platinum | 950 |
| Diamond | 1,350 |
| Master | 1,800 |
| Grandmaster | 2,300 |
| Legend | 2,750 |
| Champion | 3,200 (every week at the cap in all four) |

Each tier below Champion has three divisions, I to III (one, two, three
chevrons). The profile shows rank, rating, last week's move, the way to the
next step and this week's pace; the circle page lists members by rank.
Shown to whoever may see the
person's activity.

## 4. Where it shows

- **Circle page**: what it has won (trophies, medals given), both goals with
  the trophy road, events on, ranks.
- **Hall of fame**: medals given (gold, silver, bronze, total) and a medal
  table with each person's total.
- **Profile**: rank card; circle honours (trophies helped win, top-contributor
  medals, events finished and their places). A circle is named only to
  viewers in it.

## API

| method | path | what |
|--------|------|------|
| GET | `/api/circles/:id` | adds `goals`, `events`, `cabinet`, `pastEvents`, `ranks` for members |
| GET | `/api/circles/:id/goals?past=` | current goals, past ones, the trophy cabinet |
| GET | `/api/circles/:id/events` | `{ open, past, kinds, max }` |
| POST | `/api/circles/:id/events` | `{ kind, mode: race \| team, days: 7 \| 14 \| 28, start: today \| tomorrow }` |
| GET | `/api/circles/:id/events/:eid` | one event |
| POST | `/api/circles/:id/events/:eid/join`, `/leave` | take part, or stop |
| DELETE | `/api/circles/:id/events/:eid` | call it off (starter or owner) |
| GET | `/api/rank/ladder` | tiers and what counts |
| GET | `/api/users/:username` | adds `rank` and `honours` |
