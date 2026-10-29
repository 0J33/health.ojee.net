# health.ojee.net — build spec

A health tracker for ojee and friends. Each person signs in with their shared
ojee.net account, connects their Google account (Google Health API), and gets
their own dashboard, workouts, an optional AI summary, and a public leaderboard
and profile. Installed as a home-screen web app with opt-in notifications.

It is the multi-user, standalone sibling of the console's health module
(`/media/ojee/NVME/Code/[GIT]/ojee-health`, private repo, single user, stdlib
Node 22 + node:sqlite). Reuse that module's code wherever it fits: copy the
files in, do not import across repos.

Owner decisions (2026-10-10), not to be re-litigated:

- Hosted on **disinteg** (`disinteg@100.118.201.77`), Node v22.22.2, behind
  nginx :80 and the existing cloudflared tunnel. App port **5020**.
- **Shared ojee.net login**: the `ojeeSession` cookie on `.ojee.net`, users and
  sessions in the **mtg** Mongo database (`mongodb://localhost:27017/mtg`,
  collections `users`, `sessions`). Same rules and messages as
  `mtg.ojee.net/server/routes/auth.js` + `middleware/auth.js`: bcryptjs cost 10,
  uuid v4 session token, 30-day session, username 2–24 chars case-insensitive
  unique, password 4+, "That username is taken", "Wrong username or password".
  Cookie: httpOnly, secure, sameSite none, domain from `COOKIE_DOMAIN`.
  Registering here creates the account for mtg and dnd too. Never touch any
  other field or collection in that database.
- **Sign-up is open**, with an admin switch to close registration later
  (closing it blocks creating NEW health profiles and new accounts from this
  site; existing people keep working). Admins: `ADMIN_USERS` env, default `ojee`.
- Data source is **only the Google Health API** (v4, `health.googleapis.com`).
  People are told to link their other apps and devices inside the Google Health
  app. Devices vary (Fitbit, Pixel Watch, Garmin, Apple Watch via Apple Health,
  Samsung and other Android watches via Health Connect, or just a phone), so
  every metric is optional and the app adapts to what actually arrives.
- AI summaries use the person's **own OpenCode Zen API key** (free models),
  called directly over HTTPS. No key → the rule-based summary, labelled
  "Written without AI".
- No co-author trailer in commits. Do not push or create a GitHub repo.
- No emojis anywhere in the product. Icons are inline SVG.
- Use agent-browser for all browser testing, never Playwright.

## Architecture

One Node process (ES modules, `node >= 22.13`), serving the API and the static
frontend from the same origin, so there is no CORS and one cookie.

```
health.ojee.net/
  server/            src of the API (stdlib http; deps allowed: mongodb, bcryptjs, web-push)
    core/            copied + adapted from ojee-health/src (google, sync, parse, metrics,
                     insight, detect, workouts, alerts, util, db, demo)
  web/               the frontend, no build step (ES modules, one CSS)
  tests/             node --test
  docs/              SPEC.md (this), API.md (the exact contract, kept current by the backend)
  deploy/            nginx record, systemd unit record, deploy.sh, install-root.sh
  data/              gitignored: app.sqlite, users/<id>/health.sqlite, users/<id>/google.json
```

### Per-user worlds

The module's classes (`openDb`, `GoogleHealth`, `Sync`, `Workouts`, `Alerts`)
are instantiated **per user** in a `UserWorld` held in an LRU map:

- `data/users/<mongoUserId>/health.sqlite` — the module's own schema, unchanged
  where possible, plus what this app adds (Hevy sets on workouts, etc.).
- `data/users/<mongoUserId>/google.json` — that person's refresh token, 0600.
- Every function that used `process.env.TZ` takes the user's time zone instead.

A global `data/app.sqlite` holds what crosses users:

- `profile` — userId, username (mirrors Mongo), displayName, bio, accent colour,
  tz, units (metric/imperial), joinedAt, onboarding step, privacy flags.
- `daily_public` — one row per user per civil date with the numbers leaderboards
  and profiles need (steps, active minutes, kcal, distance, sleep minutes,
  resting HR, workouts count, workout minutes). Rewritten after every sync.
  This is the ONLY table leaderboards read: they never open another person's
  private database.
- `records` — personal bests per user (most steps in a day, longest workout…).
- `push_sub` — Web Push subscriptions per user per device.
- `link_key` — hashed keys for the console-module link (below).
- `secret` — per-user encrypted values (the OpenCode key), AES-256-GCM with a
  key derived from `APP_SECRET`.
- `app_meta` — registration open/closed, VAPID keys, etc.

### Scheduler

For each person with Google connected: sync every 20 minutes (staggered, with
jitter, at most N in flight), then recompute `daily_public`, records, and
alerts. People who have not opened the app for 14 days drop to once every
6 hours. Workout detection runs only for people who opted in.

### Google

One OAuth web client (the owner's existing project). Redirect URI
`${PUBLIC_ORIGIN}/auth/google/callback`. PKCE + state bound to the session.
Scopes: the module's read scopes plus the two write scopes (weight, exercise);
a person who declines a write scope keeps everything else, and the app says
what is unavailable ("Reconnect to allow saving workouts").

Handle, per person: revoked grants, expired refresh tokens (7 days if the Cloud
project is still in Testing), 403 on a scope they did not grant, rate limits
(429 → back off that person only), and a source that returns nothing for a
data type.

### Several Google accounts (added 2026-10-16)

The Google Health app takes one tracker per Google account; a friend wears one
at home and one at work. So a person may connect several Google accounts.
Each syncs on its own (its own Sync, token file `google-<id>.json`, store
`src/<id>.sqlite`; the first is `main`, keeping `google.json`), and
`core/merge.js` folds the stores into the person's own `health.sqlite`, which
every page keeps reading unchanged. A store from before this was copied once
to `src/main.sqlite` and trimmed to what its sync wrote.

The fold: activity totals by quarter-hour (each quarter-hour counts the device
that recorded more, read from Google for days two devices share; added up until
then), or added / higher / main only; one resting burn plus both devices'
active energy; minutes in levels capped at a day; overnight readings from the
device that recorded the night (or a chosen account); sleep and workouts
recorded by both kept once (overlap of half or more), a night split across two
added up; near-identical weigh-ins and readings from one scale kept once; the
main account's number for one-a-day readings. Leaving an account out or
removing it takes away what only it brought. Writes go to the main account;
battery and connection notices are per account.

### Devices and capabilities

After each sync compute `caps`: which streams have data in the last 14 days
(steps, activeMinutes, calories, distance, heartRate, heartRateMinute,
restingHr, hrv, spo2, skinTemp, sleep, sleepStages, weight, bodyFat,
exercise, deviceBattery). The frontend hides or explains what is missing
("Your device does not report HRV"). Readiness uses whatever of sleep / HRV /
resting HR exists and says which it used.

Workout detection needs minute-level heart rate (and uses minute steps when
present). Without `heartRateMinute` the toggle is disabled with the reason.
Keep the module's lessons: resting + 35 bpm default threshold, ignore
exercises under a minute (the Air's 3-second phantom "Swim"), a walk before
the gym does not hide the session after it, do not ask about something the
person already logged, ask once at the start and once at the end, auto-close a
forgotten manual workout after 60 calm minutes. All thresholds are per-person
settings. The exercise type written to Google is a per-person setting
(default `WEIGHT_MACHINES` for ojee's own account, `WORKOUT`/generic strength
for new people: pick the closest valid enum).

### Workouts

Sources: detected, manual (start/end now, or log a past one), Hevy import
(CSV) and the live Hevy link, Strava, and exercises already in Google
(read-only mirror, shown in history).

Hevy import: upload the CSV from Hevy → Settings → Export. Columns include
`title, start_time, end_time, description, exercise_title, superset_id,
exercise_notes, set_index, set_type, weight_kg|weight_lbs, reps,
distance_km|distance_miles, duration_seconds, rpe`. Parse dates like
`9 Oct 2026, 15:10` in the person's time zone. Each Hevy workout becomes one
workout with exercises and sets. Re-importing the same file changes nothing
(dedupe on start time + title). A Hevy workout that overlaps an existing one
by half or more is merged into it (the sets attach to the existing workout).
Importing never writes to Google unless the person ticks "Also save these to
Google Health", and then only the ones with no overlapping Google exercise.
Strength totals (volume by muscle group where the exercise name is
recognisable, sets per week) feed the profile and the summary.

### Console-module link (ojee's own two-way sync)

Settings → Connections → "Console health module" makes a link key (shown once,
stored hashed). The module on the HP box is given `HEALTH_WEB_URL` and
`HEALTH_WEB_KEY` and polls every minute:

- `GET  /api/link/changes?since=<cursor>` → workouts (and strength sets)
  changed since the cursor, including tombstones, plus a new cursor.
- `POST /api/link/changes` → the module's own changes, same shape.

Records carry a stable `uid`, `updatedAt` (ms) and `deleted`; last write wins.
A workout carries the name of its Google data point when one side has already
uploaded it, so the other side never uploads a duplicate.

**While a link is active, this app is the one that asks** (owner decision,
2026-10-10, replacing the earlier "the console asks"). This app runs the
detection and sends the "workout started?" / "workout ended?" notifications;
the console module stops running its own detection and stops sending its own
workout prompts for as long as the link is healthy, and mirrors this app's
workout state (ongoing / running / review / done / dismissed) so its Workouts
page stays correct and answering on either side settles both. The link
response says so explicitly (`prompter: "web"`), and the module falls back to
detecting and asking by itself only after the link has been failing for 30
minutes, so a site outage does not silently lose a workout.

### Live heart rate (added 2026-10-10)

Heart rate from Google is minutes old. Real-time heart rate comes only from a
device that broadcasts the standard Bluetooth Heart Rate Service (Fitbit Air
with "Share heart rate" on, most Garmins with "Broadcast heart rate", Polar,
chest straps; not Apple Watch). It reaches the app two ways: read in the
browser with Web Bluetooth (Chrome or Edge on Android and desktop; never on
iPhone or iPad), or posted to `POST /api/live/hr` by another of the person's
devices with a link key (the Ojee Pulse overlay) and relayed to their open
tabs. It is held in memory only, shown only to that person, never saved, and
ends 10 seconds after the last reading. The browser client is built to stay
connected: it remembers the sensor, gets it back without a tap where the
browser allows, and retries for as long as the app is open. `docs/API.md` has
the contract.

**iPhone (added 2026-10-10).** Apple allows no web page to use Bluetooth, so
there is a native shell for it: the private repo `0J33/ojee-health-app`
(Capacitor 8, bundle id `net.ojee.health`, sideloaded). It shows this very
site and injects `window.Capacitor`; `web/js/live.js` then reaches the sensor
through the app (`window.Capacitor.Plugins.BluetoothLe`, the raw object of
`@capacitor-community/bluetooth-le`) instead of Web Bluetooth. Both sit behind
one small interface (a transport) and everything above it is shared, so the
remembered sensor, reconnecting and posting behave the same. In the app,
readings carry on with the screen locked. `platform.native` in `web/js/pwa.js`
is the one switch for what else differs there: Google sign-in is sent to
Safari (Google refuses an embedded web view), Web Push is replaced by one line
(notifications stay with the Home Screen web app), the export goes to the
share sheet, and the Add to Home Screen steps are not shown. There is no
service worker inside the app. The transport is tested in a browser against
`tests/fake-capacitor-ble.js`, a stand-in for the raw plugin; it is not
shipped.

### Notifications (Web Push, opt-in per type and per device)

VAPID keys generated once into `app_meta`. iOS only delivers to a web app
added to the Home Screen, so the opt-in screen explains that first.
Types (each a switch, sensible defaults): workout started?, workout ended?,
morning readiness, illness early warning, weekly summary, step goal reached,
sitting nudge, passed on the leaderboard, new personal record, device battery
low, Google connection needs attention. Quiet hours per person. A 410 from the
push service removes that device.

Two types depend on the device, and are shown switched off with the reason
when it cannot carry them (as workout detection is):

- **Illness early warning** (on by default): once per day the early-warning
  flag on Today is raised. Needs at least one of resting heart rate, HRV or
  sleep temperature. The words say what changed and suggest an easy day; they
  name no condition. Opens Today.
- **Sitting nudge** (opt-in): during the person's own hours and days (their
  time zone; 09:00 to 18:00, Monday to Friday unless they change it), when
  their steps in the last hour are under their threshold (250 unless they
  change it; 50 to 2,000). At most once an hour; never in quiet hours, never
  while a workout is running, not in the first hour of the window, and never
  from stale data: if the newest step data is more than 20 minutes old it
  cannot know, so it says nothing. Needs steps through the day, not only a
  daily total (Google is asked once, when the switch is turned on). This is the
  one type that needs fresher data than the 20-minute sync: for people who
  switched it on, and only while it may speak and there is a device or open
  tab to tell, the scheduler reads their last two hours of steps (two Google
  calls) about every 15 minutes: staggered, inside the same in-flight limit,
  and waiting out that person's own 429 like their sync does. Everyone else
  costs nothing extra.

### All the data (added 2026-10-11)

Owner's goal: show all the health data that can be had, as well as it can be
shown. Three parts: read more, let people log what cannot be read, and work
out a few numbers of the app's own. `docs/DATA-TYPES.md` has the decision for
each of the Google Health API's 42 data types; `docs/API.md`, "Every metric",
has the payloads.

**Coverage.** Of the 42 types, 35 are synced, 4 are written only and 3 are
skipped (two lookup tables, and resting energy, which is derived). They
surface as 41 metrics in one catalogue (`server/catalog.js`), in nine
categories: activity, heart, sleep, body, vitals, nutrition, mindfulness,
cycle, other. A test fails if the sync stores a number no metric shows.
Browse lists what a person has and, apart, what they do not have with who or
what would provide it; nothing is assumed about a device. Every metric has
one page: a day (by the hour for steps and heart rate), a week, a month, six
months, a year; the period before; the person's own 25th to 75th percentile
over the last 90 days; a goal where one exists; one plain sentence; and the
entries behind it.

**Optional groups.** Five groups are off until a person switches one on, each
with its own Google permission asked for only then: nutrition (water, food),
mindfulness (mood), symptoms, cycle (periods, ovulation tests), ECG (ECG
readings and irregular rhythm notices, read only). Google lets the first four
be written but not read back, so what is logged here is saved to Google Health
too and is the only copy that can be shown here; what is logged in Google's
own app cannot be read by this or any other app, and the pages say so. A group
works without Google as well: its entries are then kept on this site, and are
sent if the permission is granted later. Switching a group off takes effect
here at once; its rows stay unless the person asks for them to be deleted.

**Always private.** Everything in those five groups, and also blood glucose
and body temperature, is never public: not in `daily_public`,
`public_workout` or `records`, not in a profile, a leaderboard or a
comparison, not on the admin page, and there is no privacy switch for it
because there is nothing to switch. This is structural, not a filter: such
data lives only in the per-person `sample` table, and the code that publishes
reads the `daily` table and named columns of it. The other new metrics
(floors, energy, VO2 max, breathing rate, zones) are not sensitive but are
not published either: nothing new became public with this change. A summary
reads a group's entries only when the person has switched that group on in
"what a summary may read" (`aiShare`, off by default, per group) and still has
the group on; glucose, body temperature and every free-text note are never
read for a summary. `tests/privacy.test.js` proves it with an entry of every
sensitive kind carrying a value that exists nowhere else, searched for in
every public, social and admin reply, in every other person's own replies, in
every row and byte of the global database, and in the text sent to a model.

**The app's own numbers** (`server/core/derived.js`). Google Health has scores
under product names; this app reads none and imitates none. Each of these is
labelled as calculated by this app, names its inputs on its page, and is
stored per day after each sync (and once over the whole history for a database
from before them).

- *Sleep score*, per night, out of 100. Duration, 50 points: time asleep over
  the person's sleep goal, linear up to the goal; more than 90 minutes past it
  loses a point per 10 minutes, never below 40. Stages, 20 points, only for a
  night with stages: 10 for deep sleep as a share of time asleep (none at 5%,
  all at 13%) and 10 for REM (none at 8%, all at 20%). Time awake, 15 points:
  time asleep over time in bed, none at 75%, all at 90%. Regularity, 15
  points, only with five or more main nights in the 14 days before: bedtime
  and wake each against the person's own median, all within 30 minutes, none
  at two hours, the two averaged. A part that cannot be worked out is left
  out and the score is the points earned over the points possible, times 100;
  the page says which parts it stands on.
- *Cardio minutes*, per day, added up over a Monday-to-Sunday week against a
  weekly target (default 150, the person's own choice from 30 to 600). A day
  counts, from the first of these it has: the device's zone minutes; else
  minutes in the moderate heart-rate zone plus twice the minutes in the
  vigorous and peak zones; else moderate and vigorous active minutes. The
  page says which.
- *Recovery trend*: each of the last 7 days of HRV and of resting heart rate
  as a deviation from the mean of the 30 days before those 7, in units of the
  person's own spread (never taken as less than 2 ms or 1 bpm), turned so that
  up is better; the two are averaged per day and over the week. At or above
  +0.5 it reads "above your usual", at or below -0.5 "below your usual",
  otherwise "near your usual". It needs 14 baseline days of at least one
  signal and 3 of the last 7 days. It is a trend of two signals. No stress
  score is made up, and it is never called one.
- *Resting energy*: a day's total calories minus its active energy, never
  below zero, for a day that has both.
- *Body mass index*: weight in kilograms over height in metres squared, for
  each day with a weigh-in, using the latest height.

### The all-in-one release (added 2026-10-29)

Owner's brief: make this the all-in-one app. Link Hevy (its new API) and
Strava, one Log button for anything, look things up (food, calories,
glucose, water, everything Google Health keeps), and every chart readable
point by point, great on desktop and on a phone.

**Hevy, live** (`server/hevysync.js`, `hevyapi.js`). Each person links their
own Hevy API key (Hevy Pro; Hevy → Settings → Developer), sealed in `secret`.
Hevy has no webhooks, so it is read on the person's 20-minute clock: the
exercise library (real muscle groups for every set), every workout once and
then the changes feed (edits and deletes follow), routines, body
measurements. A Hevy session that overlaps one held here is the same session
(its sets attach); a Hevy CSV import and the live link never double. Out to
Hevy: strength workouts logged here after linking, with library exercises,
and their edits; weigh-ins, body fat and tape measurements by day (a day is
sent whole). Switches: to Google, send workouts, read and send measurements.

**Strava** (`server/strava.js`). One Strava API app for the site
(`STRAVA_CLIENT_ID/SECRET`, callback domain this host); each person connects
with Strava's OAuth. Activities since 90 days before connecting, then the
webhook (`STRAVA_VERIFY_TOKEN`) for instant changes, with the sync as the
backstop; a revoked grant on Strava disconnects here. Activities keep their
own Google exercise type (181 accepted), distance, pace, climb, heart rate,
calories (from the details) and the route, drawn from its polyline without
map tiles. Off by default: workouts from here to Strava (Hevy or a watch
usually posts there already). The app shares one rate budget (200 per 15
minutes, 2,000 a day) and keeps a margin. A new Strava app serves one
athlete until the owner raises it (10 without review).

**Google stays the hub.** A workout from Hevy or Strava goes to Google Health
30 minutes after it ended, and only if Google still has no session for that
time (Hevy and Strava often send it there themselves via Health Connect);
switchable per source.

**The Log button** (`web/js/log.js`, `GET /api/log`). On every screen: a
floating button on phones, the first item of the side rail on desktop, `L`
on a keyboard. One sheet: a filter ("What do you want to log?"), water in one
tap with today's total against the goal, the workout (start, log one, from a
Hevy routine), food today, then every kind as a tile with its last entry
(grouped: Move, Eat and drink, Body, Rest, Mind, Vitals, Cycle) and what was
logged lately (to fix or delete). Kinds whose group is off say so and turn it
on. Weight no longer needs Google (kept here, sent to Hevy).

**Food lookup** (`server/food.js`). Google lets no write-only caller read its
food database, so: the person's own foods first, a built-in list of plain
foods per 100 g, then Open Food Facts by name (search.openfoodfacts.org) and
by barcode (the camera where the browser can read codes, typed digits
everywhere). A portion is weighed out in servings or grams, with the meal,
before it is saved.

**New kinds.** Sleep logged by hand: an optional group `sleeplog` asking for
`sleep.writeonly` only when switched on; a night shows with the device's
nights (its own `sleep` row and the night's numbers when no device recorded
it) and is shown once when Google's copy comes back. Tape measurements
(`measure`): no Google type exists, so they are kept here and sent to Hevy;
the Body measurements metric charts the waist. Blood pressure has no Google
Health data type, so it is not offered.

**Charts, point by point** (`web/js/scrub.js`). Every chart: hover on a
desktop (a crosshair, a dot on the line, a label beside the point, the
readout line above); tap and drag sideways on a phone (the page still
scrolls); left, right, Home, End and Enter on a keyboard. A point leads
somewhere where it can: a day to its day, a week or month bucket to that
week or month (`data-go`), opened with a click, a second tap, or the label's
Open.

### Social

- **Leaderboard** (public to signed-in people; public profiles are also
  viewable signed out): metric (steps, active minutes, workouts, workout time,
  distance, sleep consistency) × period (today, this week, this month, all
  time). Weeks start Monday in each person's own time zone; "today" is each
  person's own civil day. Shows rank, value, trend vs the previous period,
  and your own row pinned if you are off-screen.
- **Profile** `/u/<username>`: display name, accent, joined date, device,
  current streaks, this week vs last, personal records, recent workouts, a
  year heat-map of activity. Each section appears only if its category is
  public.
- **Compare**: you against one other person, same metrics side by side.
- **Privacy**, per person: the whole account private (not on leaderboards, no
  profile), or per category: activity (steps, active minutes, distance,
  calories), workouts, sleep, heart (resting HR, HRV), body (weight, body
  fat). Defaults: activity + workouts public; sleep, heart, body private.
  Private data never reaches `daily_public`.
- Records and streaks: step-goal streak, workout weeks streak, best day,
  best week, longest workout, most workouts in a week.

### Account and data

- Export everything as one JSON file.
- Disconnect Google (revokes the grant, keeps history) and "Delete my health
  data" (removes the per-user folder and every global row; the shared ojee.net
  account itself stays, since mtg and dnd use it).
- Units: km/mi, kg/lb, °C/°F. Goals: steps, active minutes, sleep.

## Frontend

A phone-first web app that also works on desktop. No framework, no build:
ES modules, one stylesheet, hash-free history routing with a server fallback
to `index.html`. PWA: manifest, service worker (push, offline shell, update
prompt), `display: standalone`, safe-area insets, theme colour.

Design brief (use the impeccable skill): a modern, simple, "OEM+" health app,
the kind that could ship on a phone. Calm, clean, legible; not flashy. System
font stack. Light and dark, following the system, with a manual override.
Numbers are the content: tabular figures, generous but not wasteful spacing,
one accent colour (the icon's), semantic colours kept separate. Charts drawn
in SVG/canvas by hand (the module's `ui/charts.js` is a starting point): rings,
bars, sleep stages, lines with an emphasised endpoint. Motion is small and
purposeful; respect reduced motion. Bottom tab bar on phones (Today, Trends,
Workouts, Ranks, Me), a side rail on wide screens. Skeletons while loading,
real empty states that say what will appear and how to make it appear, errors
that say what to do. Every screen works at 360px wide.

Screens: landing (signed out), sign in / register, onboarding (profile →
connect Google, with per-device tips → add to Home Screen → notifications →
privacy → optional OpenCode key), Today, Trends (Sleep, Activity, Heart,
Body), Workouts (running timer, questions waiting, history, detail with
heart-rate trace and sets, log a past one, Hevy import, detection settings),
Summary, Ranks (leaderboard, compare), profile, Settings (Account,
Connections, Privacy, Notifications, Goals & units, Data, Admin).

Icons: favicon.svg, favicon.ico, apple-touch-icon.png (180), icon-192.png,
icon-512.png (maskable), made from `docs/heart-rate.svg` in the family style
of the other ojee sites: the glyph in one flat colour, centred at 55.6% of a
flat black square canvas (see `ojee-console/scripts/make-icons.py`; teg uses
#c084fc, storage #00ffff, the console white). Pick a colour that is none of
those and suits health, and use it as the app's accent.

## Quality bar

- `npm test` covers: the app's own calculated metrics part by part, the
  metric catalogue (nothing synced is left undisplayable), Browse and every
  metric over every range, logging through the routes against a fake Google,
  the always-private rule (searched for, not assumed), auth against a fake Mongo, per-user isolation (one
  person can never read another's private data through any route), privacy
  flags vs `daily_public`, leaderboard periods across time zones, Hevy parsing
  and merge/dedupe, link sync (last-write-wins, tombstones, no double upload),
  detection edge cases (ported from the module's tests), capability detection,
  token refresh/revocation handling.
- A demo mode (`npm run demo`) seeds a handful of fake people with different
  devices and privacy settings and a fake Google, so every screen can be seen
  without real accounts.
- Security: every state-changing route checks `Origin`; rate-limit login and
  register; uploads capped (Hevy CSV ≤ 5 MB); no secret ever returned by the
  API or written to a log; strict CSP; cookies as above.
