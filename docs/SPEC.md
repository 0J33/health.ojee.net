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

Sources: detected, manual (start/end now, or log a past one), Hevy import,
and exercises already in Google (read-only mirror, shown in history).

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

### Notifications (Web Push, opt-in per type and per device)

VAPID keys generated once into `app_meta`. iOS only delivers to a web app
added to the Home Screen, so the opt-in screen explains that first.
Types (each a switch, sensible defaults): workout started?, workout ended?,
morning readiness, weekly summary, step goal reached, passed on the
leaderboard, new personal record, device battery low, Google connection needs
attention. Quiet hours per person. A 410 from the push service removes that
device.

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

- `npm test` covers: auth against a fake Mongo, per-user isolation (one
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
