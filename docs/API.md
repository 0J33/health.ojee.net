# health.ojee.net — HTTP API

The exact contract between `server/` and `web/` (and, for the last section,
between this app and the console's health module). The backend keeps this file
in step with the code; contract changes are listed under **Changes** at the
bottom.

Run it locally with `npm run demo` (port 5020, fake Mongo, fake Google, seeded
people). Seed logins are printed on start; `demo` / `demo` is the main one.

## Conventions

- Same origin for everything: `/api/*`, `/auth/*`, and the static app. No CORS.
- Bodies and replies are JSON (`content-type: application/json`) unless a route
  says otherwise. Request bodies are capped at 64 KB (Hevy CSV: 5 MB).
- **Time**: instants are integer **milliseconds since the epoch**. Civil dates
  are `"YYYY-MM-DD"` strings in the person's own time zone (`profile.tz`).
  Clock times are `"HH:MM"` (24 h) in that zone.
- **Units in the API are always metric**, whatever `units` says: distance in
  **metres** (`…M`), weight in **kg**, temperature in **°C**, durations in
  **minutes** (`…Min`) unless the name says `…Ms` or `…S`. The frontend converts
  for display and for input using `me.units`, where each unit is its own
  choice (distance, weight, temperature).
- A metric the person's device does not produce is `null` (never `0`). Check
  `caps` before drawing a panel.
- **Auth** is the shared ojee.net cookie `ojeeSession` (httpOnly). Send
  requests with `credentials: 'same-origin'` (the default for same-origin
  `fetch`). The link routes use a bearer key instead.
- **Every non-GET request must carry an `Origin` header equal to the site's
  origin.** Browsers add it on their own for `fetch` POST/PUT/PATCH/DELETE.
  With curl: `-H 'Origin: http://localhost:5020'`. (Link routes with a bearer
  key are exempt, and so is `POST /api/live/hr` when it carries one.)

### Errors

Any non-2xx reply is:

```json
{ "error": "A workout cannot start in the future.", "code": "bad_request", "detail": null }
```

`error` is a sentence fit to show the person. `code` is stable and machine
readable. `detail` is optional extra context (string or object) and is often
absent.

| status | code | when |
|---|---|---|
| 400 | `bad_request` | validation failed; `error` says which rule |
| 401 | `not_logged_in` | no valid session (`error`: `"Not logged in"`) |
| 401 | `bad_login` | `"Wrong username or password"` |
| 401 | `bad_key` | link key missing, unknown or revoked |
| 403 | `bad_origin` | `Origin` missing or not this site, on a state-changing route |
| 403 | `closed` | `"Registration is closed"`: no health profile and sign-up is closed |
| 403 | `forbidden` | not an admin |
| 404 | `not_found` | no such thing, **or** a profile that is private |
| 409 | `conflict` | the state does not allow it (overlapping workout, already answered…) |
| 409 | `needs_google` | Google is not connected, or the grant expired |
| 409 | `needs_scope` | the needed Google permission was not granted; `error` says to reconnect |
| 413 | `too_large` | body over the limit |
| 429 | `rate_limited` | too many attempts; `Retry-After` header (seconds) and `detail.retryAfter` |
| 502 | `upstream` | Google or OpenCode failed; `error` says what to do |
| 503 | `server_error` | the server is not set up for this (for example no `APP_SECRET`, so keys cannot be saved); `error` says so |
| 500 | `server_error` | a bug |

## Auth (`/auth/*`)

Accounts are shared with mtg.ojee.net and dnd.ojee.net. Rules and messages are
theirs: username 2–24 characters, unique ignoring case; password 4+.

### `POST /auth/register`

Body `{ "username": "sam", "password": "secret", "tz": "Europe/London" }`
(`tz` optional: the browser's `Intl.DateTimeFormat().resolvedOptions().timeZone`;
it seeds the health profile).

200 `{ "user": { "id": "6707a1…", "username": "sam" } }` and the cookie.

400 messages: `"Username and password required"`, `"Username must be 2-24 characters"`,
`"Password must be at least 4 characters"`, `"That username is taken"`.
403 `closed` when registration is closed. 429 after 5 registrations per hour per address.

### `POST /auth/login`

Body `{ "username", "password", "tz"? }`. 200 `{ "user": { "id", "username" } }`.
401 `"Wrong username or password"`. 429 after 10 failures in 10 minutes per
address or 5 per username.

Signing in always works for an existing ojee.net account. Whether the person
gets a health profile is a separate question: see `me.profile` and `closed`.

### `POST /auth/logout`

200 `{ "success": true }`. Signs out of mtg and dnd too (one session).

### `GET /auth/me`

200 `{ "user": { "id", "username" } }` or `{ "user": null }`. Cheap; use
`/api/me` for everything else.

### `GET /auth/google/start`  (a navigation, not a fetch)

`location.href = '/auth/google/start?return=/settings/connections'`.
Redirects to Google's consent screen. `return` is a path on this site
(default `/settings/connections`); anything else is ignored.

### `GET /auth/google/callback`

Where Google sends the browser back. Redirects to the `return` path with the
outcome in the query string:

| query | meaning |
|---|---|
| `?google=connected` | connected; the first sync has started |
| `?google=cancelled` | the person pressed Cancel at Google |
| `?google=error&message=<text>` | anything else; `message` is fit to show |

Read it, show it, then `history.replaceState` it away. If the person declined
some permissions the connection still succeeds: see `me.google.missing`.

## The person

### `GET /api/me`

Never 401. `?tz=<IANA zone>` is optional: it seeds the profile's zone when the
profile is first made (someone arriving already signed in from mtg or dnd, who
never passed through this site's login form). It is ignored afterwards; use
`PATCH /api/profile` to change the zone. Signed out:

```json
{ "user": null, "demo": true, "version": "1.0.0", "registrationOpen": true,
  "push": { "publicKey": "BJ3x…" } }
```

Signed in with no health profile while registration is closed: `user` is set,
`profile` is `null`, and every other `/api/*` route answers 403 `closed`.

Signed in:

```json
{
  "user": { "id": "6707a1d2c3b4a5968778695a", "username": "demo", "admin": false },
  "demo": true,
  "version": "1.0.0",
  "registrationOpen": true,
  "profile": {
    "username": "demo",
    "displayName": "Demo",
    "bio": "Lifting three days a week.",
    "accent": "#2fbf71",
    "tz": "Africa/Cairo",
    "joinedAt": 1752300000000,
    "onboarding": "done",
    "notes": "Desk job. Gym 3 days a week."
  },
  "units": { "distance": "km", "weight": "kg", "temp": "c" },
  "unitSystem": "metric",
  "goals": { "steps": 8000, "activeMinutes": 22, "sleepMinutes": 450 },
  "privacy": { "account": "public", "activity": true, "workouts": true, "sleep": false, "heart": false, "body": false },
  "google": {
    "state": "ok",
    "email": "demo@example.com",
    "connectedAt": 1752300000000,
    "lastRefreshAt": 1760083200000,
    "expiredAt": null,
    "testingExpiry": false,
    "refreshError": null,
    "scopes": [
      { "scope": "activity_and_fitness.readonly", "granted": true, "label": "Steps, active minutes, calories, distance, exercise" },
      { "scope": "health_metrics_and_measurements.readonly", "granted": true, "label": "Heart rate, HRV, SpO2, temperature, weight, body fat" },
      { "scope": "sleep.readonly", "granted": true, "label": "Sleep and sleep stages" },
      { "scope": "settings.readonly", "granted": true, "label": "Paired devices: battery and last sync" },
      { "scope": "health_metrics_and_measurements.writeonly", "granted": true, "label": "Saving a weigh-in" },
      { "scope": "activity_and_fitness.writeonly", "granted": true, "label": "Saving workouts" }
    ],
    "canWriteWeight": true,
    "canWriteWorkouts": true,
    "missing": []
  },
  "sync": {
    "running": false,
    "lastRun": 1760083200000,
    "lastOk": 1760083200000,
    "lastError": null,
    "nextAt": 1760084400000,
    "backoffUntil": null,
    "streams": {
      "steps": { "at": 1760083200000, "rows": 4, "error": null, "skipped": null },
      "hrv": { "at": 1760083200000, "rows": 4, "error": null, "skipped": null }
    }
  },
  "caps": {
    "steps": true, "activeMinutes": true, "calories": true, "distance": true,
    "heartRate": true, "heartRateMinute": true, "restingHr": true, "hrv": true,
    "spo2": true, "skinTemp": true, "sleep": true, "sleepStages": true,
    "weight": true, "bodyFat": true, "exercise": true, "deviceBattery": true
  },
  "capsMeta": {
    "updatedAt": 1760083200000,
    "windowDays": 14,
    "lastSeen": { "steps": "2026-10-10", "hrv": "2026-10-10", "weight": "2026-10-09" },
    "missing": []
  },
  "device": { "name": "Fitbit Air", "type": "TRACKER", "battery": 64, "batteryStatus": "Medium", "lastSync": 1760082120000 },
  "ai": { "keySet": false, "last4": null },
  "push": { "publicKey": "BJ3x…", "devices": 0 },
  "link": { "keys": 0, "active": false, "prompter": "web" },
  "workout": { "running": null, "pending": 1 }
}
```

Field notes:

- `profile.onboarding`: the step the person is on: `"profile"`, `"google"`,
  `"install"`, `"notifications"`, `"privacy"`, `"ai"`, `"done"`. The backend
  only stores it; the frontend advances it with `PATCH /api/profile`.
- `profile.accent`: `"#rrggbb"` or `null` (use the app's own accent).
- `profile.notes`: the person's own context for the summary (max 4000 chars).
  Private; never in public profiles.
- `privacy.account`: `"public"` or `"private"`. The five category flags are
  `true` = public. Defaults: activity and workouts public; sleep, heart, body private.
- `google.state`: `"ok"` | `"needs_auth"` (never connected, or disconnected) |
  `"expired"` (Google revoked or expired the grant; show Reconnect) |
  `"unconfigured"` (the server has no OAuth client; show "not available").
  `testingExpiry: true` with `expired` means the 7-day Testing-mode expiry.
- `google.missing`: sentences for permissions the person declined, ready to
  show, for example `"Reconnect to allow saving workouts"`.
- `sync.lastError.code`: `"rate_limited"`, `"network"`, `"needs_auth"`, `"http_5xx"`…
  `sync.backoffUntil` is set while Google asked this person to slow down.
  `sync.streams` keys: `steps, azm, activeMinutes, kcal, distance, rhr, hrv, spo2,
  temp, sleep, exercise, weight, bodyfat, hr, device`. `skipped` is
  `"scope not granted"` for a declined permission.
- `caps`: which streams produced data in the last 14 days. All `false` before
  the first sync. `capsMeta.missing` is a list of
  `{ "cap": "hrv", "text": "Your device does not report HRV" }` for the ones
  that are false, in display order.
- `device`: the paired tracker, or `null` (phone only, or `settings` not granted).
- `link.active`: the console module polled within the last 10 minutes.
  `link.prompter` is always `"web"`: this app is the one that detects and
  asks, linked or not (the module mirrors it).
- `workout`: enough for a tab badge.

### `PATCH /api/profile`

Any of `{ "displayName", "bio", "accent", "tz", "notes", "onboarding" }`.
`displayName` 1–40 chars, `bio` ≤ 200, `accent` `#rrggbb` or `null`, `tz` an
IANA zone the server's `Intl` knows. Returns the full `/api/me` payload.

### `PATCH /api/settings`

Any of:

```json
{ "units": { "distance": "mi", "weight": "lb", "temp": "f" },
  "goals": { "steps": 10000, "activeMinutes": 30, "sleepMinutes": 480 },
  "privacy": { "account": "private", "sleep": true } }
```

Partial objects merge.

`units` is one independent choice per unit: `distance` `"km"` | `"mi"`,
`weight` `"kg"` | `"lb"`, `temp` `"c"` | `"f"`. Send only the one that changed
(`{ "units": { "weight": "lb" } }`) and the others stay. Any other value is a
400. Units only change what the frontend displays and how it reads input;
every value in the API stays metric. For one version the old single switch is
still accepted, `{ "units": "metric" }` or `{ "units": "imperial" }`, and sets
all three (metric: km, kg, c; imperial: mi, lb, f). `me.unitSystem` is the same
idea read back, for anything that still wants one value: `"metric"`,
`"imperial"`, or `"mixed"` when the choices differ. New code should read
`me.units`.

Bounds: steps 1000–50000, activeMinutes 5–240,
sleepMinutes 240–720. A privacy change is applied to the public tables before
the reply is sent. Returns the full `/api/me` payload.

### `GET /api/events` (Server-Sent Events)

`new EventSource('/api/events')`. One stream per signed-in tab; a comment line
(`: beat`) every 25 s. Events (each `data` is JSON):

| event | data | meaning |
|---|---|---|
| `hello` | `{ "at": ms }` | connected |
| `changed` | `{ "what": ["data","workouts"], "at": ms }` | refetch. `what` holds any of `data`, `workouts`, `me`, `social`, `push`, `link` |
| `sync` | `{ "running": true, "at": ms }` | a sync started or finished |
| `summary` | `{ "window": 7, "at": ms }` | a summary finished (or failed over to rules); refetch `/api/summary` |
| `notify` | `{ "type": "workout_end", "title", "body", "tag", "url", "at": ms }` | the same notification the push service got, for an open tab |
| `live` | `{ "bpm": 132, "t": ms, "source": "pulse" }`, or `{ "bpm": null, "t": ms, "source": null }` | live heart rate: a new reading, or its end. See **Live heart rate** |

401 (as JSON) when signed out.

## Data

### `GET /api/data?days=30`

Everything Today and the small charts draw. `days` 7–90, default 30.

```json
{
  "today": "2026-10-10",
  "tz": "Africa/Cairo",
  "days": 30,
  "connected": true,
  "empty": false,
  "verdictDay": "2026-10-10",
  "stale": 0,
  "readiness": {
    "date": "2026-10-10",
    "level": "easy",
    "label": "Easy day",
    "score": -2,
    "text": "HRV −12% vs baseline, resting HR +3 bpm: easy day",
    "used": ["hrv", "rhr", "sleep"],
    "usedText": "Based on HRV, resting heart rate and sleep",
    "parts": [
      { "key": "hrv", "pts": -1, "value": 45.4, "base": 51.7, "delta": -12.2, "text": "HRV −12% vs baseline" },
      { "key": "rhr", "pts": -1, "value": 61, "base": 57.6, "delta": 3.4, "text": "resting HR +3 bpm" },
      { "key": "sleep", "pts": 1, "value": 452, "text": "slept 7h 32m" }
    ]
  },
  "illness": { "flag": false, "reasons": [], "text": null },
  "series": [
    {
      "date": "2026-10-10",
      "steps": 5210, "distanceM": 3890, "azm": 12, "activeMin": null, "kcal": 1320,
      "rhr": 61, "rhrBase": 57.6, "rhrSd": 1.31,
      "hrv": 45.4, "hrvBase": 51.7, "hrvSd": 3.12,
      "spo2": 96.4, "spo2Lo": 94.8, "spo2Hi": 97.8,
      "tempDev": 0.12, "tempSd": 0.21,
      "sleepMin": 452, "bodyFat": 19.5
    }
  ],
  "sleep": {
    "lastNight": {
      "date": "2026-10-10", "asleepMin": 452, "periodMin": 471,
      "stages": { "AWAKE": 19, "LIGHT": 236, "DEEP": 88, "REM": 128 },
      "startMs": 1760042040000, "endMs": 1760070300000, "startOff": 10800, "endOff": 10800
    },
    "consistency": { "nights": 14, "bedtime": "23:31", "bedtimeSd": 34, "wake": "07:02", "wakeSd": 41, "asleep": 431, "asleepSd": 38 },
    "nights": [
      {
        "id": "users/me/dataTypes/sleep/dataPoints/abc", "date": "2026-10-10", "main": true,
        "startMs": 1760042040000, "endMs": 1760070300000, "startOff": 10800, "endOff": 10800,
        "asleepMin": 452, "awakeMin": 19, "periodMin": 471,
        "stages": [ { "s": 1760042040000, "e": 1760042400000, "t": "AWAKE" }, { "s": 1760042400000, "e": 1760044200000, "t": "LIGHT" } ],
        "summary": { "stages": { "AWAKE": 19, "LIGHT": 236, "DEEP": 88, "REM": 128 }, "toFallAsleep": 6, "type": "STAGES", "processed": true, "nap": false }
      }
    ]
  },
  "activity": {
    "stepTarget": 8000, "azmTarget": 22, "sleepTarget": 450,
    "streak": { "steps": 4, "azm": 3 },
    "today": { "steps": 5210, "distanceM": 3890, "azm": 12, "activeMin": null, "activeMinutes": 12, "kcal": 1320 },
    "exercises": [
      { "id": "users/me/dataTypes/exercise/dataPoints/202610091", "date": "2026-10-09", "startMs": 1760022600000, "endMs": 1760026080000,
        "type": "WEIGHTLIFTING", "name": "Weights", "kcal": 310, "azm": 14, "avgHr": 108, "steps": 420, "distanceM": null }
    ]
  },
  "weight": {
    "latest": { "date": "2026-10-09", "avg7": 77.08 },
    "change30": -0.61,
    "trend": [ { "date": "2026-10-09", "kg": 77.3, "avg7": 77.08 } ],
    "points": [ { "t": 1760000000000, "kg": 77.3, "source": "google" } ]
  },
  "hr": { "t": 1760081700000, "bpm": 64 },
  "live": { "bpm": 132, "t": 1760086801000, "source": "pulse" },
  "device": { "name": "Fitbit Air", "type": "TRACKER", "battery": 64, "batteryStatus": "Medium", "lastSync": 1760082120000 },
  "caps": { "steps": true, "hrv": true },
  "workout": { "running": null, "pending": 1 }
}
```

Notes:

- `connected: false` → Google is not connected: show the connect prompt.
  `empty: true` → there is no data at all yet (never connected, or connected
  and the first sync has not produced anything: show skeletons / "first sync
  running"). After a disconnect the history is kept, so `connected: false`
  with `empty: false` is normal: show the data and a "reconnect" banner.
- `activity.exercises` are Google's own exercise sessions of the last 14
  days (for the Today list); the Workouts tab uses `/api/workouts`.
- `series` has exactly `days` rows, oldest first, one per civil date, `null`
  where there is no reading. `rhrBase`/`hrvBase` are the trailing 30-day mean,
  `…Sd` its spread (`null` until 7 days exist).
- `azm` is Fitbit-style active zone minutes; `activeMin` is Google's plain
  active minutes (moderate + vigorous) for devices without zones.
  `activity.today.activeMinutes` is whichever of the two exists (use this for
  the ring; the goal is `azmTarget`).
- `readiness.level`: `"push"` | `"normal"` | `"easy"` | `"rest"` | `"learning"`
  (still building a baseline; `text` says how far) | `"unavailable"` (the
  device gives none of sleep, HRV, resting HR; `text` says so). `used` lists
  the signals that went into it: any of `hrv`, `rhr`, `sleep`, `temp`.
  `score` is `null` for `learning` and `unavailable`.
- `stale`: days between `verdictDay` and `today` (0 = this morning's numbers).
- Sleep stage types: `AWAKE`, `RESTLESS`, `LIGHT`, `DEEP`, `REM`, `ASLEEP`
  (a device with no stages reports one `ASLEEP` block or none at all; check
  `caps.sleepStages`). `startOff`/`endOff` are UTC offsets in **seconds**: add
  to the instant to draw local clock time without a zone database.
  `sleep.nights` covers the last 14 nights.
- `weight.trend` has one row per day of the range (`kg` that day's mean
  weigh-in or `null`, `avg7` the trailing 7-day mean or `null`).
- `hr`: the latest heart-rate sample if under 3 h old at the last sync, else `null`.
- `live`: the live heart-rate reading (see **Live heart rate**) or `null`. Memory only; it is not part of the synced data and is absent from the export.

### `GET /api/brief`

Today in context, for the Today screen: every number against the person's
own usual, the week against last week, streaks, what changed, a ranked list
of things worth saying and the one next step. Built from the store only
(no Google call), so it is cheap to ask for after every sync.

```json
{
  "today": "2026-10-11", "tz": "Africa/Cairo", "weekday": "Sunday", "verdictDay": "2026-10-11",
  "metrics": {
    "steps": { "value": 5896, "yesterday": 12366, "usual": 8088, "usualKind": "weekday", "usualN": 8,
               "lo": 6806, "hi": 10635, "delta": -2192, "deltaPct": -27.1, "goal": 8000 },
    "rhr":   { "value": 61, "yesterday": 60, "usual": 57.5, "usualKind": "baseline", "usualN": 30,
               "lo": 56.1, "hi": 59, "delta": 3.5, "deltaPct": 6.1, "goal": null }
  },
  "week": {
    "start": "2026-10-05",
    "days": [ { "date": "2026-10-05", "future": false, "steps": 5517, "lastSteps": 7421, "activeMinutes": 36, "lastActiveMinutes": 23, "sleepMin": 377, "lastSleepMin": 492 } ],
    "totals": {
      "steps": { "value": 62041, "previous": 78147, "deltaPct": -20.6 },
      "activeMinutes": { "value": 171, "previous": 129, "deltaPct": 32.6 },
      "distanceM": { "value": 46900, "previous": 59252, "deltaPct": -20.8 },
      "sleepAvgMin": { "value": 425, "previous": 439, "deltaPct": -3.2 },
      "workouts": { "value": 4, "previous": 4, "deltaPct": 0 },
      "workoutMin": { "value": 210, "previous": 210, "deltaPct": 0 }
    }
  },
  "streaks": [
    { "id": "steps", "label": "Step goal", "current": 4, "best": 11, "unit": "days", "atRisk": true, "need": "2,104 steps to go today" },
    { "id": "workout_weeks", "label": "Weeks with a workout", "current": 13, "best": 13, "unit": "weeks", "atRisk": false, "need": null }
  ],
  "sleep": {
    "nights": 14, "avgMin14": 432, "lastVsAvgMin": 13,
    "bedtime": { "last": "23:34", "usual": "23:36", "deltaMin": -2 },
    "wake": { "last": "07:06", "usual": "07:04", "deltaMin": 2 },
    "stages": { "DEEP": { "min": 76, "pct": 16.8, "usualPct": 20.9 }, "REM": { "min": 121, "pct": 26.8, "usualPct": 24.2 },
                "LIGHT": { "min": 248, "pct": 54.9, "usualPct": 51.3 }, "AWAKE": { "min": 7, "pct": 1.5, "usualPct": 3.6 } },
    "debt7Min": 211, "regularity": 58
  },
  "changes": [
    { "key": "hrv", "label": "HRV", "from": 48.9, "to": 45.4, "delta": -3.5, "unit": "ms", "good": false, "text": "HRV is 7% lower than yesterday" }
  ],
  "insights": [
    { "id": "band_rhr", "kind": "band", "score": 67, "tone": "warn", "icon": "heart",
      "title": "Resting heart rate has been 3 bpm above your 30-day average for 2 days",
      "text": "Latest 61 bpm against an average of 57.5 bpm.", "href": "/trends/heart" }
  ],
  "next": { "kind": "steps", "text": "2,104 steps to your goal, about a 20 minute walk", "href": "/trends/activity" },
  "missing": [ { "cap": "bodyFat", "text": "No body fat readings" } ]
}
```

- `metrics` has a key only for what the person has: the capability is true,
  or there is a value. Keys, in this order: `steps`, `activeMinutes` (zone
  minutes, else plain active minutes), `kcal`, `distanceM`, `sleepMin`, `rhr`,
  `hrv`, `spo2`, `tempDev`. Every entry has all ten fields; any of them can be
  `null`.
  - Activity (`steps`, `activeMinutes`, `kcal`, `distanceM`): `value` is today
    so far, `yesterday` the full day before. `usualKind: "weekday"`: `usual`
    is the mean of the same weekday over the previous 8 weeks (`usualN` of
    them had data; `null` under 3). `lo`/`hi` are the 25th and 75th
    percentile of the previous 28 days (`null` under 4 days).
  - Vitals (`sleepMin`, `rhr`, `hrv`, `spo2`, `tempDev`): `value` is the
    reading of `verdictDay` (as in `/api/data`: today once this morning's
    numbers are in, else the latest day that has them), `yesterday` the day
    before that. `usualKind: "baseline"`: `usual` is the mean of the 30 days
    before, `lo`/`hi` that mean ∓ 1 SD, `usualN` the days it was made from
    (`usual` is `null` under 7).
  - `delta` = `value − usual`; `deltaPct` the same as a percentage of
    `usual`, one decimal (`null` when either is missing, when `usual` is 0,
    and always for `tempDev`, which is already a deviation).
  - `goal` for `steps`, `activeMinutes` and `sleepMin`; `null` for the rest.
- `week`: the Monday week `today` is in. `days` always has 7 rows; a day
  after today is `future: true` with its own values `null` (the `last…`
  values, the same weekday a week earlier, are still there). `totals` always
  has all six keys; `previous` is last week **up to the same weekday**, so
  the two are comparable on a Wednesday. `sleepAvgMin` is a mean, the others
  sums. `value`/`previous` are `null` without data (`workouts` and
  `workoutMin` are counts, never `null`); `deltaPct` is `null` when either
  is missing or `previous` is 0.
- `streaks`: only those the person can have (a phone gets `steps` alone).
  `id`: `steps`, `active`, `sleep` (nights at or above the sleep goal; `unit`
  is still `"days"`) and `workout_weeks` (consecutive Monday weeks with at
  least one confirmed workout). `current` counts up to today if today
  already made it, else up to yesterday; `best` is the longest in the last
  400 days. `atRisk`: there is a streak and today has not reached the goal
  yet (for `workout_weeks`: no workout this week yet); `need` then says what
  it takes, else `null`. A night that came in under the sleep goal ends the
  sleep streak at once (`current: 0`), since it cannot be made up.
- `sleep` is `null` without a main sleep in the last 14 days. `nights`:
  how many there were. `lastVsAvgMin`: the last night against `avgMin14`.
  `bedtime`/`wake`: `last` and `usual` are `"HH:MM"`, `usual` the mean of the
  other nights (`null`, with `deltaMin`, under 3 of them); `deltaMin`
  positive = later. `stages` is `null` when the device gives none; `pct` is
  the share of the night, `usualPct` the mean share over the previous 14
  nights with stages (`null` under 3). `debt7Min`: what the last 7 nights
  fell short of the sleep goal, summed (nights without data ignored; `null`
  with none). `regularity`: 0–100 from the spread of bedtime and of wake
  time over those nights (100 = no spread, 0 = an SD of two hours or more;
  the mean of the two; `null` under 3 nights).
- `changes`: `verdictDay` against the day before for `rhr`, `hrv`,
  `sleepMin`, `tempDev`; yesterday against the day before it for `steps` and
  `activeMinutes`. Only real changes are listed (2 bpm, 5% HRV, 20 min
  sleep, 0.3 °C, 15% steps or active minutes). `delta` = `to − from` in
  `unit` (`bpm`, `ms`, `min`, `°C`, `steps`). `good`: `true`/`false` where a
  direction is better, `null` for temperature. `text` is a sentence.
- `insights`: at most 8, strongest first (`score` 0–100), one per subject.
  `kind`: `band` (a vital outside its baseline ± 1 SD for 2 or more days
  running), `usual` (yesterday, or today so far, against the usual for that
  weekday), `week` (pace against last week), `streak_risk`, `milestone`
  (a streak at 7, 14, 21, 30, 50, 75, 100…), `best` (a record day in the last
  7), `debt` (2 h or more of sleep debt), `bedtime` (the last 3 bedtimes 40
  min or more later than usual), `goal_rate`, `weight`. `tone`: `good` |
  `warn` | `info`. `icon` is one of the icon names: `steps`, `moon`, `heart`,
  `pulse`, `bolt`, `flame`, `scale`, `trophy`, `clock`, `alert`, `up`,
  `down`, `flat`, `workouts`. `title` is the sentence, `text` its
  working-out, `href` an in-app path. `id` is stable for the same insight
  from one day to the next (use it as a key).
- `next` is never `null` and `href` is always a path. `kind`, by priority:
  `workout` (a detected workout is waiting for an answer), `connect` /
  `sync` (no data yet), `rest` (a rest or easy day), `steps` (the goal is
  within 5,000 steps), `streak`, `sleep` (after 20:00 with an hour or more of
  sleep debt: when to turn the lights out), `done`, `none`.
- `missing`: what the device does not report, as in `me.capsMeta.missing`.
  Empty before the first sync.
- Sentences (`text`, `title`, `need`) are in metric units and are not
  converted; numbers use en-GB separators.

A person with no data gets `metrics: {}`, `streaks: []`, `sleep: null`,
`changes: []`, `insights: []` and a `next` that says to connect.

### `GET /api/day?date=YYYY-MM-DD`

The shape of one day, hour by hour. `date` defaults to today and may be at
most 6 days back (400 otherwise, and for a date in the future or one that is
not a date).

```json
{
  "date": "2026-10-11", "tz": "Africa/Cairo",
  "hours": [
    { "h": 0, "future": false, "steps": 0, "hrAvg": 58, "hrMin": 52, "hrMax": 66 },
    { "h": 13, "future": true, "steps": null, "hrAvg": null, "hrMin": null, "hrMax": null }
  ],
  "steps": { "available": true, "reason": null },
  "hr": { "available": false, "reason": "Your device does not report minute-by-minute heart rate" },
  "peakHour": 11, "activeHours": 7,
  "at": 1760180400000
}
```

- `hours` always has 24 rows, `h` 0–23 in the person's zone. An hour that
  has not started is `future: true` with every number `null`. In a past hour
  `steps` is a count (0 for a still hour) when `steps.available`, else
  `null`; the three heart-rate numbers are `null` for an hour without
  samples.
- `steps.available` / `hr.available` say whether that stream can be drawn;
  when `false`, `reason` is a sentence to show in its place: Google is not
  connected, the device has no minute-by-minute heart rate
  (`caps.heartRateMinute`), Google has only a daily step total, nothing was
  recorded, or Google could not be reached. **A Google failure is a 200 with
  a reason, never a 502.**
- `peakHour`: the hour with the most steps (`null` without any).
  `activeHours`: hours with 250 steps or more (`null` when steps are not
  available).
- `at`: when this was read from Google. The answer is kept: 10 minutes for
  today, for good for a day that is over (kept days are dropped after 8
  days). A failed read is not kept.

### `GET /api/trends?days=90`

For the Trends tabs. `days` one of 7, 30, 90, 180, 365 (anything else → 30).

```json
{
  "today": "2026-10-10", "tz": "Africa/Cairo", "days": 90, "from": "2026-07-13",
  "series": [ { "date": "2026-07-13", "steps": 8123, "distanceM": 6010, "azm": 24, "activeMin": null, "kcal": 2290,
                "rhr": 57, "rhrBase": 57.2, "rhrSd": 1.2, "hrv": 52.1, "hrvBase": 51.9, "hrvSd": 3.0,
                "spo2": 96.3, "spo2Lo": 94.7, "spo2Hi": 97.7, "tempDev": 0.05, "tempSd": 0.21, "sleepMin": 431, "bodyFat": null,
                "stepsAvg7": 8975, "sleepAvg7": 422, "rhrAvg7": 57, "hrvAvg7": 52.7, "activeMinutes": 24, "activeAvg7": 25 } ],
  "weeks": [ { "week": "2026-10-05", "days": 6, "steps": 51230, "stepsAvg": 8538, "distanceM": 38400, "activeMinutes": 141,
               "kcalAvg": 2310, "sleepAvgMin": 438, "rhrAvg": 58.2, "hrvAvg": 50.4, "workouts": 3, "workoutMin": 171 } ],
  "months": [ { "month": "2026-10-01", "days": 10, "stepsAvg": 11021, "activeMinutesAvg": 23, "sleepAvgMin": 430,
                "rhrAvg": 57.5, "hrvAvg": 51.3, "workouts": 6, "workoutMin": 304, "weightKg": 77.24 } ],
  "analysis": {
    "steps": {
      "n": 89, "avg": 9614, "median": 9025, "p25": 7083, "p75": 10991,
      "min": { "value": 1398, "date": "2026-08-17" }, "max": { "value": 22318, "date": "2026-10-02" },
      "prevAvg": 9120, "delta": 494, "deltaPct": 5.4,
      "weekday": [ { "dow": 0, "avg": 7945, "n": 12 } ],
      "histogram": [ { "lo": 0, "hi": 2500, "n": 2 }, { "lo": 2500, "hi": 5000, "n": 5 } ],
      "goal": 8000, "goalDays": 54, "goalRate": 0.61, "outOfBand": null
    }
  },
  "relations": [
    { "id": "sleep_hrv", "xLabel": "Sleep", "yLabel": "HRV that morning", "xUnit": "min", "yUnit": "ms", "n": 62, "enough": true, "r": 0.41,
      "text": "On nights you slept longer, next-morning HRV tended to be higher (r = 0.41 over 62 days). A pattern, not a cause.",
      "points": [ [431, 52.1] ] }
  ],
  "sleep": {
    "nights": [ { "id": "users/me/dataTypes/sleep/dataPoints/abc", "date": "2026-10-10", "main": true, "startMs": 0, "endMs": 0, "startOff": 10800, "endOff": 10800,
                  "asleepMin": 452, "awakeMin": 19, "periodMin": 471, "stages": [], "summary": { "stages": {} } } ],
    "consistency": { "nights": 62, "bedtime": "23:29", "bedtimeSd": 36, "wake": "07:01", "wakeSd": 40, "asleep": 433, "asleepSd": 39 },
    "regularity": { "score": 59, "bedMean": 339, "bedSd": 40, "wakeMean": 406, "wakeSd": 59,
                    "nights": [ { "date": "2026-10-10", "bedMin": 373, "wakeMin": 468, "asleepMin": 431 } ] },
    "stagesAvg": { "DEEP": { "min": 92, "pct": 21.7 }, "REM": { "min": 103, "pct": 24.1 }, "LIGHT": { "min": 218, "pct": 51 }, "AWAKE": { "min": 13, "pct": 3.2 } },
    "debtMin": 3852, "goalNights": 18
  },
  "weight": { "latest": { "date": "2026-10-09", "avg7": 77.08 }, "change30": -0.61, "trend": [], "points": [],
              "ratePerWeekKg": -0.17, "rangeChangeKg": -1.29, "min": { "kg": 76.81, "date": "2026-10-04" }, "max": { "kg": 79.45, "date": "2026-07-25" } },
  "activity": { "stepTarget": 8000, "azmTarget": 22, "sleepTarget": 450, "streak": { "steps": 4, "azm": 3 } },
  "caps": { "steps": true }
}
```

`series` rows are the same shape as in `/api/data`, plus `activeMinutes`
(`azm`, else `activeMin`) and the trailing 7-day means `stepsAvg7`,
`sleepAvg7`, `rhrAvg7`, `hrvAvg7`, `activeAvg7` (the day itself and the six
before it; `null` with fewer than 4 values). `weeks` are Monday weeks,
oldest first (`days` = days of that week with any data). `sleep.nights` has
every night in range; the per-segment `stages` array is filled only when
`days` ≤ 30 (otherwise `[]`; `summary.stages` minutes are always there).

- `months`: the calendar months the range touches, oldest first, for every
  range. Only days inside the range are counted (`days` = how many of them
  had data), so the first month of a range is usually a part month. Today
  is left out of `stepsAvg` and `activeMinutesAvg`. `weightKg` is the mean
  of that month's weigh-ins.
- `analysis` has a key for each of `steps`, `activeMinutes`, `kcal`,
  `distanceM`, `sleepMin`, `rhr`, `hrv`, `spo2`, `tempDev`, `bodyFat` that
  has **any value in the range** (a phone gets `steps` and `distanceM`).
  Every entry has the same fields. `n`: days with a value. `p25`/`p75`: the
  typical range. `min`/`max` with the date they fell on. `prevAvg`: the mean
  of the same number of days just before the range; `delta`, `deltaPct`
  against it (`null` without one). `weekday`: always 7 rows, `dow` 0 =
  Monday … 6 = Sunday (`avg` `null` where `n` is 0). `histogram`: at most 10
  bins with round edges, each `lo` ≤ value < `hi` (the last one includes its
  `hi`); the `n` add up to `n`. `goal`, `goalDays`, `goalRate` (0–1, of the
  days with a value) for `steps`, `activeMinutes`, `sleepMin`; `null` for
  the rest. `outOfBand`: for `rhr` and `hrv`, the days more than 1.5 SD from
  that day's baseline; `null` for the rest. Today is not over, so it is
  left out of the four activity metrics here (their `n` is at most
  `days − 1`).
- `relations`: `sleep_hrv` (a night's sleep → that morning's HRV),
  `sleep_next_steps` (a night's sleep → the steps of the day that follows
  it), `steps_sleep` (a day's steps → the sleep of the night after). One is
  left out when the person does not have both metrics. `n`: pairs of days;
  `enough`: `n` ≥ 14; `r`: Pearson's, two decimals, `null` when not enough
  (or when one side never varies). `text` is the sentence to show and is
  always there. `points` are `[x, y]`, oldest first, the latest 200.
- `sleep.regularity`: over the main sleeps in range. `bedMin` is **minutes
  after 18:00** local on the evening before (23:30 → 330, 00:30 → 390), so
  bedtimes either side of midnight sit next to each other; `wakeMin` is
  **minutes after 00:00** local. `bedMean`/`wakeMean` and their SDs are in
  the same two scales. `score` as in `/api/brief` (`null`, with the means,
  under 3 nights; `nights` is then whatever there is).
  `sleep.stagesAvg`: mean minutes and share per stage over the nights that
  have stages, or `null`. `sleep.debtMin`: what the nights in range fell
  short of the sleep goal, summed (`null` without any night);
  `sleep.goalNights`: nights at or above it.
- `weight.ratePerWeekKg`: the slope of `avg7` over the last 28 days, per
  week (`null` under 5 days with a value; the same whatever `days` is).
  `weight.rangeChangeKg`: the last `avg7` in range minus the first.
  `weight.min` / `weight.max`: the lightest and heaviest day (that day's
  mean weigh-in) in range, `{ kg, date }` or `null`.

### `POST /api/sync`

Sync this person now. At most once a minute (429 otherwise). 409 `needs_google`
when not connected.

200 `{ "result": { "ok": true, "code": null, "message": null, "wrote": 42 }, "sync": { …as in /api/me… } }`

### `POST /api/weight`

Body `{ "kg": 77.4, "at": 1760083200000, "note": "morning" }` (`at` optional,
default now, not in the future, at most 30 days back; `kg` 20–400).
Writes to Google Health, then stores it locally. 409 `needs_scope` with
`"Reconnect to allow saving your weight"` when the write permission is missing.

200 `{ "ok": true, "point": { "t": 1760083200000, "kg": 77.4, "source": "app" } }`

## Live heart rate

Heart rate from Google is minutes old. The only real-time source is a device
that broadcasts the Bluetooth Heart Rate Service (0x180D), read either by the
person's own browser (Web Bluetooth, `web/js/live.js`), by the Health iPhone
app (the same file, through the app's Bluetooth; it posts with the session
cookie and `source: "browser"` like any browser), or by another of their
devices (the Ojee Pulse overlay) and posted here. The server only relays it to
that person's own open tabs.

**Live state is in memory only.** It is never written to a database or a file,
never reaches `daily_public`, the export or a profile, and is only ever handed
back to the person it belongs to. A restart forgets it. Per person it is the
latest reading plus the readings of the last 120 seconds. It **ends 10 seconds
after the last reading arrived**, or at once on a `bpm: 0`.

### `POST /api/live/hr`

```json
{ "samples": [ { "t": 1760086800000, "bpm": 132 }, { "t": 1760086801000, "bpm": 133 } ], "source": "pulse" }
```

or the short form, meaning "now":

```json
{ "bpm": 132 }
```

- **Auth, either of:**
  - the signed-in session (cookie, with the usual `Origin` check); or
  - `Authorization: Bearer <link key>`: the same `hlk_…` keys as
    `/api/link/changes`, made in Settings → Connections. No cookie and no
    `Origin` needed. A missing, unknown or revoked key is **401 `bad_key`**.
    When the header is present it decides: a cookie beside a bad key does not
    rescue the request.
- `samples`: 1–20 readings. `t` is ms since the epoch (omitted: now); `bpm` is
  a whole number.
  - `bpm` 25–250 is a reading.
  - `bpm` 0 means "sensor off the skin, or stopped": the live state (the
    reading and its history) is cleared at once.
  - Anything else, a body that is neither form, or more than 20 samples, is
    400 `bad_request`.
- A sample **older than 60 s or more than 5 s in the future is ignored**; the
  reply is still 200. The rest of the batch is used.
- `source` (optional): `"pulse"`, `"browser"`, or another short name (lower
  case, at most 24 characters of `a-z 0-9 . _ -` and space). Default `"pulse"`
  with a key, `"browser"` with a session.
- Reply: `200 { "ok": true }`.
- **Rate limit: 10 requests a second per person** (both kinds of caller
  together), then 429 `rate_limited` with `Retry-After: 1`. One request a
  second carrying that second's readings is what a client should send.
- The newest sample of a batch becomes the latest reading; an older one only
  joins the history. A link key's "last used" time is refreshed at most once a
  minute by this route.

### `GET /api/live`

Session auth. What is live for the signed-in person right now:

```json
{ "bpm": 132, "t": 1760086801000, "source": "pulse", "recent": [ [1760086800000, 131], [1760086801000, 132] ] }
```

`bpm`, `t` and `source` are `null` when nothing is live. `recent` is the last
120 seconds, oldest first; after a reading ends by itself it stays until it
ages out (so a short gap does not empty the sparkline), and a `bpm: 0` empties
it.

### The `live` event

On that person's own `/api/events` streams only:

| data | meaning |
|---|---|
| `{ "bpm": 132, "t": ms, "source": "pulse" }` | a new latest reading. At most about one a second per person: readings arriving faster are coalesced, and the newest goes out when the second is up |
| `{ "bpm": null, "t": ms, "source": null }` | it ended (10 s of silence, or a `bpm: 0`). Sent once |

A client that opens its stream late calls `GET /api/live` once (the frontend
does so on every `hello`). `GET /api/data` also carries `live` (below), so a
freshly opened Today shows it without waiting for the next event.

### Workouts

Live samples are **not** added to a workout's heart-rate trace. The trace is
minute-level data read from Google and is rewritten by detection and by saving
a workout; mixing in-memory, per-second readings into it would touch that path
and the Google write beside it. A running workout shows the live number next to
its timer and nothing is stored.

## Workouts

A workout object, as it appears in every list:

```json
{
  "id": "12",
  "uid": "0b1c6d4e-6f0a-4c59-9a55-3a1d3c1f7e21",
  "source": "detected",
  "status": "done",
  "start": 1760022600000,
  "end": 1760026080000,
  "durationMin": 58,
  "title": "Workout",
  "type": "STRENGTH_TRAINING",
  "notes": null,
  "avgHr": 118, "maxHr": 146, "steps": 420, "kcal": 312.5, "activeMin": 49,
  "google": { "state": "saved", "name": "users/me/dataTypes/exercise/dataPoints/ojee-w-0b1c6d4e-6f0a-4c59-9a55-3a1d3c1f7e21", "error": null, "dirty": false },
  "sets": { "exercises": 5, "sets": 17, "volumeKg": 6420 },
  "readOnly": false,
  "prompts": { "start": 1760023200000, "end": 1760026800000 },
  "lastEnd": 1760026080000,
  "autoClosed": null,
  "updatedAt": 1760026900000,
  "spark": [96, 118, 124, 131, 127, 140, 133, 121],
  "zonesMin": [14, 22, 15, 6, 1],
  "prCount": 1
}
```

- `id` is a string. Workouts this app holds have numeric ids (`"12"`);
  exercises that exist only in Google Health have `"g-<tail>"` and
  `readOnly: true` (they can be opened, not edited or deleted).
- `source`: `"detected"` | `"manual"` (started by hand) | `"logged"` (a past
  one, typed in) | `"hevy"` | `"google"` (read-only mirror).
- `status`: `"ongoing"` (detected, still going, "did you start a workout?"),
  `"running"` (started by hand, or a detection the person confirmed),
  `"review"` (over, waiting for "save", "did it end at …?"), `"done"`,
  `"dismissed"`. Lists never contain other statuses.
- `end` is `null` while `ongoing`/`running`; `lastEnd` is how far the detected
  effort reaches so far.
- `google.state`: `"saved"` | `"pending"` (will be uploaded shortly) |
  `"failed"` (`error` says why; `POST …/retry`) | `"needs_scope"` ("Reconnect
  to allow saving workouts") | `"local"` (kept here only: a Hevy import the
  person did not ask to upload) | `"remote"` (the console module will upload
  it) | `"foreign"` (Google already had this session from the device or
  another app) | `null` (not applicable yet).
- `sets` is `null` when no sets are attached.
- `autoClosed`: `"calm"` or `"no raised heart rate seen"` when a forgotten
  hand-started workout was closed for review.
- `type` is a Google Health `exerciseType` enum value.
- `spark`: the heart rate **inside** the workout (start to end, not the 20
  minutes either side) as at most 32 means, oldest first, in bpm. `zonesMin`:
  minutes in each of the five zones of `training.zones`, lowest first. Both
  are `null` when this app holds no trace for the workout. They come only
  from traces already kept here (a detected workout's own, or one fetched
  when its detail was opened): the list never asks Google for one, so a
  workout that has never been opened may be `null` and fill in once it has.
- `prCount`: how many records were set in it (see `training.prs`); `0` for a
  workout without sets, for a Google mirror, and while it is not `done`.

### `GET /api/workouts?limit=40&before=<ms>`

```json
{
  "running": null,
  "pending": [ { "…workout, status ongoing or review…": 0 } ],
  "history": [ { "…workout, status done…": 0 } ],
  "more": false,
  "detection": {
    "available": true,
    "reason": null,
    "settings": { "enabled": false, "plusBpm": 35, "minStartMin": 10, "minTotalMin": 20, "calmMin": 10, "walkSteps": 60, "autoCloseMin": 60 },
    "bounds": { "plusBpm": [10, 60], "minStartMin": [5, 30], "minTotalMin": [10, 90], "calmMin": [5, 30], "walkSteps": [30, 140], "autoCloseMin": [30, 240] },
    "rest": 58,
    "threshold": 93,
    "last": { "checkedAt": 1760083200000, "asOf": 1760082900000, "error": null }
  },
  "exerciseType": "STRENGTH_TRAINING",
  "exerciseTypes": [ { "id": "STRENGTH_TRAINING", "label": "Strength training" }, { "id": "WEIGHT_MACHINES", "label": "Weight machines" } ],
  "canWrite": true,
  "needsReconnect": false,
  "unsaved": 0,
  "strength": {
    "muscles": ["chest", "back", "shoulders", "arms", "legs", "core", "other"],
    "weeks": [ { "week": "2026-10-05", "sets": 34, "volumeKg": 12840, "workouts": 3,
                 "byMuscle": { "chest": 4100, "back": 3900, "shoulders": 1200, "arms": 900, "legs": 2400, "core": 340, "other": 0 } } ],
    "setsPerWeek": 31.5,
    "exercises": [ { "name": "Bench Press (Barbell)", "muscle": "chest", "sets": 48, "bestKg": 80, "lastAt": 1760022600000 } ]
  },
  "training": {
    "week": { "start": "2026-10-05", "workouts": 3, "minutes": 171, "sets": 34, "volumeKg": 12840,
              "avg4": { "workouts": 3.5, "minutes": 204, "sets": 31.5, "volumeKg": 11920 } },
    "weeks": [ { "week": "2026-10-05", "workouts": 3, "minutes": 171, "sets": 34, "volumeKg": 12840,
                 "byMuscle": { "chest": 4100, "back": 3900, "shoulders": 1200, "arms": 900, "legs": 2400, "core": 340, "other": 0 },
                 "zonesMin": [41, 62, 38, 12, 2] } ],
    "weekday": [ { "dow": 0, "workouts": 9 }, { "dow": 1, "workouts": 2 } ],
    "hours": [0, 0, 0, 0, 0, 0, 1, 4, 0, 0, 0, 0, 0, 0, 0, 0, 2, 11, 14, 3, 0, 0, 0, 0],
    "zones": { "rest": 58, "max": 182, "bounds": [120, 132, 145, 157],
               "labels": ["Easy", "Light", "Moderate", "Hard", "Peak"],
               "note": "Zones are estimated from your resting heart rate and the highest heart rate recorded in your workouts" },
    "balance": [ { "muscle": "chest", "sets4w": 38, "volumeKg4w": 15200, "sharePct": 29.2, "lastAt": 1760022600000, "daysSince": 1 } ],
    "prs": [ { "exercise": "Bench Press (Barbell)", "muscle": "chest", "kind": "weight", "value": 82.5, "previous": 80,
               "date": "2026-10-09", "at": 1760022600000, "workoutId": "12" } ],
    "exercises": [ { "name": "Bench Press (Barbell)", "muscle": "chest",
                     "sessions": [ { "date": "2026-10-09", "t": 1760022600000, "topKg": 82.5, "topReps": 5, "e1rm": 96.3, "volumeKg": 2410, "sets": 5 } ],
                     "bestKg": 82.5, "bestE1rm": 96.3, "changePct": 6.4 } ],
    "usual": { "durationMin": 58, "avgHr": 118, "volumeKg": 6100 }
  }
}
```

- `history` is newest first: this app's `done` workouts merged with Google's
  own exercises (deduplicated). `limit` 1–100, default 40. `before` pages
  backwards (pass the `start` of the last item); `more` says whether to.
- `detection.available` is `false` when `caps.heartRateMinute` is false;
  `reason` is then a sentence (for example `"Workout detection needs
  minute-by-minute heart rate, which your device does not report"`). The
  toggle should be disabled.
- Detection is **off by default** (`settings.enabled: false`): it is opt-in.
- `rest` is the resting heart rate detection measures against (mean of the
  last 30 days, 70 until there is one); `threshold` = `rest + plusBpm`.
- `strength.weeks`: the last 12 Monday weeks, oldest first; `volumeKg` =
  Σ kg × reps. `setsPerWeek` is the mean over the last 4 complete weeks.

`training` is the person's own training log. It is always there, for
somebody with no workouts too (zeros, empty lists and `null`s, as marked).
Weeks are Monday weeks and dates are civil dates in the person's own zone.

- `week`: this week so far. `avg4` is the mean of the **4 complete weeks
  before it** (`workouts` and `sets` to one decimal, `minutes` and
  `volumeKg` whole). `sets` and `volumeKg` (Σ kg × reps) count every set,
  warm-ups included, exactly as `strength.weeks` does.
- `weeks`: always 12, oldest first, the last being this week. `byMuscle` is
  volume in kg per group, every group of `strength.muscles` present.
  `zonesMin` is the week's minutes in the five zones, summed over the
  sessions this app holds a trace for; `null` when it holds none that week
  (so a week's zone minutes can be less than its `minutes`).
- `weekday`: always 7, `dow` 0 = Monday … 6 = Sunday, sessions started on
  that weekday in those 12 weeks. `hours`: always 24, sessions by the hour
  they started (the person's clock), same 12 weeks.
- `zones`: how heart rate is cut into five zones, by heart-rate reserve.
  `rest` is `detection.rest`. `max` is the highest minute of heart rate in
  any workout trace this app holds from the last 180 days, never under 170
  nor over 205, and 190 when it holds none. `bounds` are `rest` + 50, 60, 70
  and 80% of (`max` − `rest`), rounded: zone 1 is under `bounds[0]`, zone 2
  from `bounds[0]`, … zone 5 from `bounds[3]`. Under `bounds[0]` counts as
  zone 1 only inside a workout. `labels` name the five. `note` is the
  sentence to show beside them.
- `balance`: every group of `strength.muscles`, in that order. `sets4w` and
  `volumeKg4w` are the last 28 days; `sharePct` is the group's share of
  those sets (one decimal; they add up to 100, or are all 0). `lastAt` is
  the last time the group was trained **at all**, not only in the 28 days,
  and `daysSince` the civil days since; both `null` when it never was.
- `prs`: records set in the last 30 days, newest first, at most 12. `kind`
  is `"weight"` (the heaviest set, `value`/`previous` in kg) or `"e1rm"`
  (the best estimated one-rep max, kg to one decimal). A record needs a best
  from an **earlier session** to beat: a first-ever lift is not one, and a
  session sets at most one of each kind per exercise. `workoutId` is the
  workout's `id`, or `null` for a set from the console module's own log.
- `exercises`: the 12 exercises trained in the most sessions in the last
  180 days. `sessions` are oldest first, the latest 24: `topKg`/`topReps`
  is the heaviest set (more reps wins a tie), `e1rm` the session's best,
  both `null` when no set counted; `volumeKg` and `sets` count every set.
  `bestKg` and `bestE1rm` are the best **ever**, not of the 180 days.
  `changePct` is the mean `e1rm` of the last 3 listed sessions against the
  first 3 (one decimal), `null` with fewer than 6 that have one.
- `usual`: medians over the sessions of those 12 weeks, each `null` when
  unknown (`volumeKg` is over sessions that have sets).
- Estimated one-rep max is Epley, kg × (1 + reps / 30), for sets of 1 to 12
  reps with a weight. Warm-up sets (`type: "warmup"`) never count towards a
  top set, an `e1rm` or a record.

### `GET /api/workouts/:id`

The workout object plus:

```json
{
  "trace": [ [1760022600000, 96, 12], [1760022660000, 121, 3], [1760022720000, null, 0] ],
  "traceReason": null,
  "threshold": 93,
  "exercises": [
    {
      "name": "Bench Press (Barbell)", "muscle": "chest", "notes": null, "supersetId": null,
      "previous": { "date": "2026-10-02", "topKg": 67.5, "topReps": 8 },
      "sets": [ { "index": 0, "type": "normal", "kg": 70, "reps": 8, "distanceM": null, "durationS": null, "rpe": 8, "pr": true } ]
    }
  ],
  "zones": { "minutes": [14, 22, 15, 6, 1], "bounds": [120, 132, 145, 157],
             "labels": ["Easy", "Light", "Moderate", "Hard", "Peak"], "rest": 58, "max": 182,
             "note": "Zones are estimated from your resting heart rate and the highest heart rate recorded in your workouts" },
  "usual": { "durationMin": 58, "avgHr": 118, "volumeKg": 6100 }
}
```

`trace` rows are `[minuteStartMs, avgBpm | null, steps]`, covering the workout
with 20 minutes either side, oldest first. When there is none, `trace` is `[]`
and `traceReason` says why (`"Your device does not report minute-by-minute
heart rate"`, `"Heart rate for this period is no longer available"`, …).
`set.type`: `"normal"` | `"warmup"` | `"dropset"` | `"failure"`.

- `zones`: minutes in the five zones, counted from the `trace` in this very
  reply, between the workout's start and end; `bounds`, `labels`, `rest`,
  `max` and `note` as in `training.zones` of the list. `null` when there is
  no heart rate inside the workout (`trace` empty, or only its margins).
- `usual`: the same object as `training.usual`, to set this session against.
- Every set has `pr` (always a boolean): `true` on the set that set a weight
  or estimated-1RM record for its exercise at the time, under the rules of
  `training.prs` (the first set to reach the session's best; at most one set
  per kind). Each exercise has `previous`: the heaviest set of the last
  earlier session of that exercise, or `null` when this was the first.
- The workout object's own `spark`/`zonesMin`/`prCount` are **not** on the
  detail: it has the whole `trace`, `zones.minutes` and `pr` per set.

### Actions

All return the full `GET /api/workouts` payload (so the page re-renders from
one reply) unless noted. Times are ms. Every route with an `:id` answers 409
`conflict` for a `g-…` id ("This workout lives in Google Health and cannot be
changed here") and 404 for an id that is not the person's.

| route | body | does |
|---|---|---|
| `POST /api/workouts/start` | `{ "at"? }` | start one by hand, now or at `at`. 409 if one is running |
| `POST /api/workouts/log` | `{ "start", "end", "title"?, "notes"?, "type"?, "exercises"? }` | log a past workout (5 min – 6 h, within 30 days, not overlapping another). `exercises` as in `PUT …/sets` |
| `POST /api/workouts/:id/confirm` | `{ "start"? }` | "yes, I am working out" (answers an `ongoing` one) |
| `POST /api/workouts/:id/end` | `{ "at"? }` | end a running one now (or at `at`) and save it |
| `POST /api/workouts/:id/save` | `{ "start"?, "end"? }` | confirm a `review` one, optionally adjusting the times; also edits a saved one's times |
| `POST /api/workouts/:id/dismiss` | – | "not a workout" (or throw away a running one) |
| `POST /api/workouts/:id/retry` | – | try the Google upload again |
| `PATCH /api/workouts/:id` | `{ "title"?, "notes"?, "type"? }` | rename, annotate, change the exercise type |
| `PUT /api/workouts/:id/sets` | `{ "exercises": [ … ] }` | replace the workout's exercises and sets (below) |
| `DELETE /api/workouts/:id` | – | delete it here and, if this app saved it, from Google Health. A `running` / `ongoing` / `review` one is dismissed instead |
| `POST /api/workouts/settings` | any of the `detection.settings` keys, `"exerciseType"` | detection on/off and thresholds (clamped to `bounds`) |
| `POST /api/workouts/check` | – | read Google and judge it now (429 inside 30 s) |

`PUT …/sets` body:

```json
{ "exercises": [
  { "name": "Bench Press (Barbell)", "muscle": "chest", "notes": "paused reps",
    "sets": [ { "kg": 70, "reps": 8, "type": "normal", "rpe": 8 }, { "kg": 70, "reps": 7 } ] }
] }
```

`muscle` is optional: one of `chest, back, shoulders, arms, legs, core, other`;
left out, it is guessed from the name. `kg` 0–1000, `reps` 0–500,
`distanceM`/`durationS` optional. At most 60 exercises and 400 sets. Returns
the `GET /api/workouts/:id` payload.

### `POST /api/workouts/import/hevy?upload=0&dryRun=0`

The CSV from Hevy → Settings → Export, sent **as the raw request body**
(`content-type: text/csv`), up to 5 MB. `upload=1` also saves the imported
workouts to Google Health (only those with no overlapping Google exercise).
`dryRun=1` parses and reports without storing anything.

```json
{
  "ok": true,
  "dryRun": false,
  "found": 42,
  "imported": 38,
  "merged": 3,
  "skipped": 1,
  "toUpload": 0,
  "sets": 612,
  "unknownExercises": ["Sled Push"],
  "errors": [],
  "items": [
    { "title": "Push Day", "start": 1760022600000, "end": 1760026200000, "sets": 17,
      "result": "imported", "id": "31", "mergedInto": null }
  ]
}
```

`result`: `"imported"` (a new workout), `"merged"` (its sets were attached to
an existing workout that overlaps it by half or more; `mergedInto` is that
id), `"skipped"` (already imported: same start time and title). `errors` are
row-level problems (`"Row 14: could not read the date \"…\""`); a file with no
usable rows is a 400. Importing the same file again reports everything as
`skipped` and changes nothing. `unknownExercises` are names whose muscle group
could not be guessed (they count under `other`).

## Summary

### `GET /api/summary`

```json
{
  "windows": ["night", 7, 30, 90],
  "running": null,
  "ai": { "keySet": true, "last4": "9f2c", "models": ["space-bunny-free", "longcat-2.5-preview-free"] },
  "notes": "Desk job. Gym 3 days a week.",
  "latest": {
    "7": {
      "window": 7,
      "at": 1760083200000,
      "ms": 4210,
      "source": "model",
      "model": "space-bunny-free",
      "why": null,
      "summary": {
        "headline": "7h 12m sleep · 8,412 steps/day · easy day",
        "sections": [
          { "id": "sleep", "title": "Sleep", "text": "Seven nights averaging 7h 12m…" },
          { "id": "heart", "title": "Heart", "text": "…" },
          { "id": "activity", "title": "Activity", "text": "…" },
          { "id": "weight", "title": "Weight", "text": "…" },
          { "id": "readiness", "title": "Readiness", "text": "…" }
        ],
        "nextSteps": ["Bring lights-out forward 30 minutes.", "Book the third gym day."],
        "caveats": []
      }
    }
  }
}
```

- `latest` is keyed by window (`"night"`, `"7"`, `"30"`, `"90"`); a window
  never summarised is absent.
- `source`: `"model"` (written by `model`) or `"rules"`. For `rules`, show
  **"Written without AI"** followed by `why`: `"No OpenCode key saved"`,
  `"OpenCode rejected the key"`, `"The free models are at their limit right
  now"`, `"OpenCode could not be reached"`, `"Every free model refused or
  failed"`.
- `running`: `{ "window": 7, "startedAt": ms }` while one is being written.
- Sections for data the person's device does not produce are left out.

### `POST /api/summary`

Body `{ "window": "night" | 7 | 30 | 90 }`. Answers within 2.5 s with either
200 (done; same payload as GET) or 202 (still writing; same payload with
`running` set; wait for the `summary` SSE event, then GET). One at a time per
person. 409 `needs_google` when there is no data to summarise.

### OpenCode key

| route | body | reply |
|---|---|---|
| `PUT /api/ai/key` | `{ "key": "sk-…" }` | `{ "keySet": true, "last4": "9f2c" }`. Stored encrypted; never returned |
| `DELETE /api/ai/key` | – | `{ "keySet": false, "last4": null }` |
| `POST /api/ai/test` | `{ "key"? }` | tests the given key, or the saved one |

`POST /api/ai/test` (at most once every 5 seconds, 429 otherwise) → 200 either way:
`{ "ok": true, "model": "space-bunny-free", "ms": 812 }` or
`{ "ok": false, "reason": "OpenCode rejected the key", "tried": [ { "model": "space-bunny-free", "why": "HTTP 401" } ] }`.
400 when there is no key to test.

## Social

Everything here is built from the public tables only. Privacy is applied when
those tables are written and again when they are read.

### `GET /api/leaderboard?metric=steps&period=week`

Signed-in only (401 otherwise).

`metric`: `steps` | `active_minutes` | `workouts` | `workout_time` | `distance`
| `sleep_consistency`. `period`: `today` | `week` | `month` | `all`.

```json
{
  "metric": "steps", "period": "week", "unit": "steps", "higherIsBetter": true,
  "label": "Steps", "periodLabel": "This week",
  "total": 5,
  "group": { "n": 5, "median": 48100, "mean": 46840, "total": 234200, "best": 61230 },
  "entries": [
    { "rank": 1, "username": "mira", "displayName": "Mira", "accent": "#e2574c",
      "value": 61230, "previous": 54100, "trend": 13, "me": false, "detail": null,
      "spark": [9120, 8840, 11020, 7400, 10210, 9980, 4660], "prevRank": 2, "move": 1, "gapToNext": null },
    { "rank": 2, "username": "demo", "displayName": "Demo", "accent": "#2fbf71",
      "value": 51230, "previous": 55020, "trend": -7, "me": true, "detail": null,
      "spark": [8100, 7750, null, 9020, 8800, 7300, 3900], "prevRank": 1, "move": -1, "gapToNext": 10000 }
  ],
  "me": { "rank": 2, "value": 51230, "previous": 55020, "trend": -7, "listed": true, "reason": null,
          "vsMedianPct": 7,
          "ahead": { "username": "mira", "displayName": "Mira", "by": 10000 },
          "behind": { "username": "sam", "displayName": "Sam", "by": 3130 } }
}
```

- Each person's period is in **their own time zone**: `today` is their civil
  day, `week` starts on their Monday, `month` on the 1st. `all` is everything
  the app has (from their first synced day).
- `previous` is the same number of days of the previous period (week to date
  vs last week to the same weekday; `today` vs yesterday's full day); `null`
  for `all` or when there is none. `trend` is the percent change, rounded
  (`null` when `previous` is `null` or 0).
- Units: `steps`, `min` (active minutes, workout time), `workouts`, `m`
  (distance), `score` (sleep consistency, 0–100, higher is steadier; `detail`
  is `{ "nights": 6, "bedtimeSdMin": 22, "wakeSdMin": 31 }`). Sleep
  consistency needs 3 nights in the period; for `today` it is judged over the
  last 7 nights.
- People with no value for the metric in the period are not listed. Ties
  share a rank.
- `entries` is the whole board (it is small). `me` is your own row even when
  you are not in `entries`: `listed: false` with `reason` one of
  `"Your account is private"`, `"Your activity is private"`, `"Your workouts
  are private"`, `"Your sleep is private"`, `"Nothing yet for this period"`.
- `spark`: that person's last 7 civil days of the metric, oldest first,
  ending on their own today (whatever the `period`); a day with no number is
  `null`. `null` altogether for `sleep_consistency`, which has no daily value.
- `prevRank`: the rank the entry would have had on `previous`, **among the
  people listed now** (ties share it); `null` when its `previous` is `null`,
  so always `null` for `all`. `move` = `prevRank` − `rank`: positive is up,
  `null` when `prevRank` is.
- `gapToNext`: how far behind the nearest **higher** value, in the metric's
  unit; `null` for everybody at rank 1. People tied with each other have the
  same gap, to the person above them both.
- `group`, over the listed values: `n`, `median` and `mean` (rounded),
  `total`, `best`. With nobody listed: `{ n: 0, median: null, mean: null,
  total: 0, best: null }`.
- `me.vsMedianPct`: your value against `group.median`, in percent, rounded.
  `me.ahead`: the nearest person with a higher value and `by` how much;
  `me.behind`: the nearest with a lower one. Somebody level with you is
  neither. All three are `null` when you are not listed, and each is `null`
  when there is nobody there. Only people on the board can be named: a
  private account, or one keeping the category private, never is.

### `GET /api/people`

Signed-in only. The public directory, for the compare picker.

`{ "people": [ { "username": "mira", "displayName": "Mira", "accent": "#e2574c", "joinedAt": 1752300000000, "me": false } ] }`

### `GET /api/users/:username`

Public: works signed out. **404 for an unknown user and for a private account
alike** (unless it is your own).

```json
{
  "username": "mira", "displayName": "Mira", "bio": "Runs on Saturdays.", "accent": "#e2574c",
  "joinedAt": 1752300000000, "me": false, "private": false,
  "sections": { "activity": true, "workouts": true, "sleep": false, "heart": false, "body": false },
  "device": "Pixel Watch 4",
  "streaks": { "stepGoal": { "current": 6, "best": 21 }, "workoutWeeks": { "current": 9, "best": 9 } },
  "week": {
    "thisWeek": { "steps": 61230, "activeMinutes": 188, "distanceM": 46100, "kcal": 16400, "workouts": 4, "workoutMin": 212 },
    "lastWeek": { "steps": 70410, "activeMinutes": 201, "distanceM": 52800, "kcal": 16900, "workouts": 4, "workoutMin": 230 }
  },
  "records": [
    { "kind": "best_day_steps", "label": "Most steps in a day", "value": 24180, "unit": "steps", "date": "2026-09-12", "daysAgo": 28 },
    { "kind": "best_week_steps", "label": "Most steps in a week", "value": 82400, "unit": "steps", "date": "2026-09-07", "daysAgo": 33 },
    { "kind": "longest_workout", "label": "Longest workout", "value": 96, "unit": "min", "date": "2026-08-30", "daysAgo": 41 },
    { "kind": "most_workouts_week", "label": "Most workouts in a week", "value": 5, "unit": "workouts", "date": "2026-09-14", "daysAgo": 26 }
  ],
  "recentWorkouts": [ { "date": "2026-10-09", "start": 1760022600000, "durationMin": 58, "title": "Push Day", "type": "STRENGTH_TRAINING" } ],
  "heatmap": [ { "date": "2025-10-11", "level": 0, "steps": null, "workouts": 0 }, { "date": "2026-10-10", "level": 3, "steps": 9120, "workouts": 1 } ],
  "year": { "activeDays": 341, "steps": 3184200, "distanceM": 2390100, "workouts": 187, "workoutMin": 10420,
            "bestMonth": { "month": "2026-05", "steps": 301200 } },
  "weeks": [ { "week": "2026-10-05", "steps": 61230, "activeMinutes": 188, "workouts": 4, "workoutMin": 212 } ],
  "weekday": [9100, 8700, 9400, 8800, 7900, 12300, 6100],
  "sleep": null,
  "heart": null,
  "body": null
}
```

- A section whose category is private is `null` (or `[]` for lists) and its
  flag in `sections` is `false`: `streaks.stepGoal`, `week` step fields,
  `device` and step records belong to **activity**; `streaks.workoutWeeks`,
  workout fields of `week`, workout records and `recentWorkouts` to
  **workouts**. In `week`, fields of a private category are `null`.
- `heatmap`: 365 days ending today (their zone), oldest first. `level` 0–4
  combines steps against their goal and workouts; computed only from public
  categories.
- When public: `sleep` = `{ "avgMin7": 431, "consistency": 82 }`, `heart` =
  `{ "restingHr": 58, "hrv": 51 }`, `body` = `{ "weightKg": 77.1, "bodyFatPct": 19.4 }`
  (any field `null` if unknown).
- Your own profile (`me: true`) is returned even when your account is private,
  with `private: true`, showing what others **would** see if it were public.
- A week is Monday-based in that person's zone. `records[].date` is the day,
  or the Monday of the week, the record was set; `daysAgo` is the civil days
  from that date to their today.
- `year`: the same 365 days as `heatmap`. `activeDays` (days with any
  steps), `steps`, `distanceM` and `bestMonth` (`"YYYY-MM"`, the month with
  the most steps; `null` when there are none) belong to **activity**;
  `workouts` and `workoutMin` to **workouts**. A field is `null` when its
  category is private and a number (0 when nothing was recorded) when it is
  shared.
- `weeks`: always 12 Monday weeks, oldest first, the last being this week so
  far. `steps`/`activeMinutes` are **activity**, `workouts`/`workoutMin`
  **workouts**; `null` when private, a number (0 for an empty week) when
  shared.
- `weekday`: 7 numbers, Monday first: their mean steps on that weekday over
  those 12 weeks, today left out because it is not over; an entry is `null`
  when there was no such day with steps. The whole of it is `null` when
  activity is private.

### `GET /api/compare?with=<username>&period=week`

Signed-in only. `period` as for the leaderboard. 404 when the other person is
unknown or private.

```json
{
  "period": "week", "periodLabel": "This week",
  "a": { "username": "demo", "displayName": "Demo", "accent": "#2fbf71" },
  "b": { "username": "mira", "displayName": "Mira", "accent": "#e2574c" },
  "metrics": [
    { "metric": "steps", "label": "Steps", "unit": "steps", "higherIsBetter": true, "a": 51230, "b": 61230 },
    { "metric": "active_minutes", "label": "Active minutes", "unit": "min", "higherIsBetter": true, "a": 141, "b": 188 },
    { "metric": "workouts", "label": "Workouts", "unit": "workouts", "higherIsBetter": true, "a": 3, "b": 4 },
    { "metric": "workout_time", "label": "Workout time", "unit": "min", "higherIsBetter": true, "a": 171, "b": 212 },
    { "metric": "distance", "label": "Distance", "unit": "m", "higherIsBetter": true, "a": 38400, "b": 46100 },
    { "metric": "sleep_consistency", "label": "Sleep consistency", "unit": "score", "higherIsBetter": true, "a": null, "b": null }
  ],
  "score": { "a": 0, "b": 5, "ties": 0 },
  "series": {
    "steps": { "labels": ["2026-10-05", "2026-10-06", "2026-10-07"], "a": [8100, 7750, null], "b": [9120, 8840, 11020] },
    "active_minutes": { "labels": ["2026-10-05", "2026-10-06", "2026-10-07"], "a": [22, 31, 18], "b": [35, 28, 41] },
    "distance": { "labels": ["2026-10-05", "2026-10-06", "2026-10-07"], "a": [6100, 5800, null], "b": [6900, 6600, 8300] },
    "workout_time": { "labels": ["2026-10-05", "2026-10-06", "2026-10-07"], "a": null, "b": [58, null, 61] }
  }
}
```

A value is `null` when that person keeps the category private or has no data
(`a`, your own side, is `null` for a category you keep private too: the
comparison only ever shows what is public on both sides of the table).

- `score`: how many `metrics` each side leads, counting only those where
  **both** sides have a value; `ties` are the ones that are level.
- `series`: the period day by day, for `steps`, `active_minutes`, `distance`
  and `workout_time` (always these four keys). `today`: the last 7 days;
  `week`: Monday up to today; `month`: the 1st up to today; `all`: the last
  12 Monday weeks, **one summed value per week**. `a`, `b` and `labels` have
  the same length.
- A side (`a` or `b`) is `null`, not an array, when that person keeps the
  metric's category private: the same rule as the totals, yours included.
  Inside an array a day (or week) with no number is `null`.
- Each side is that person's **own** days in their own zone: position 0 is
  the first day of their period. `labels` are side `a`'s dates (the Mondays
  for `all`). When the two are on different civil days the shorter side is
  padded with `null` at the end, and `labels` runs on to cover the longer.

## Notifications (Web Push)

### `GET /api/push`

```json
{
  "publicKey": "BJ3x…",
  "types": [
    { "id": "workout_start", "label": "Workout started?", "description": "Asks once when your heart rate looks like a workout has begun.", "default": true },
    { "id": "workout_end", "label": "Workout ended?", "description": "Asks once when a workout looks finished, so you can save it.", "default": true },
    { "id": "morning", "label": "Morning readiness", "description": "Your readiness and last night's sleep, once a morning.", "default": true },
    { "id": "illness", "label": "Illness early warning", "description": "Once a day when your resting heart rate or sleep temperature has stayed above your usual.", "default": true, "available": true, "reason": null },
    { "id": "weekly", "label": "Weekly summary", "description": "The week's headline and next steps, once a week.", "default": true },
    { "id": "step_goal", "label": "Step goal reached", "description": "When you reach your step goal for the day.", "default": true },
    { "id": "sitting", "label": "Sitting nudge", "description": "During the hours you choose, when you have taken few steps in the last hour. At most once an hour.", "default": false, "available": false, "reason": "Needs steps through the day, and your device only reports a daily total" },
    { "id": "leaderboard", "label": "Passed on the leaderboard", "description": "When someone passes you on this week's steps.", "default": false },
    { "id": "record", "label": "New personal record", "description": "When you set a new best.", "default": true },
    { "id": "battery", "label": "Device battery low", "description": "When your tracker is at 20% or less.", "default": true },
    { "id": "connection", "label": "Google connection needs attention", "description": "When Google stops accepting the connection and syncing has stopped.", "default": true }
  ],
  "prefs": {
    "types": { "workout_start": true, "workout_end": true, "morning": true, "illness": true, "weekly": true, "step_goal": true, "sitting": false, "leaderboard": false, "record": true, "battery": true, "connection": true },
    "quiet": { "from": "22:30", "to": "07:00" },
    "morningAt": "07:30",
    "weeklyAt": { "day": "sun", "time": "18:00" },
    "sitting": { "from": "09:00", "to": "18:00", "days": ["mon", "tue", "wed", "thu", "fri"], "threshold": 250 }
  },
  "limits": { "sitting": { "threshold": { "min": 50, "max": 2000, "step": 50 } } },
  "status": { "sitting": { "state": "low", "steps": 80, "asOf": 1760080000000, "note": null, "checkedAt": 1760080300000 } },
  "devices": [
    { "id": "d_4f1a9c", "label": "iPhone", "enabled": true, "types": null, "createdAt": 1760000000000, "lastOkAt": 1760080000000, "lastError": null }
  ]
}
```

- `prefs.types` are the person's switches; a device is sent a notification
  when the type is on, the device is `enabled`, and the device's own `types`
  (a partial map, or `null` = follow the account) does not switch it off.
- Every entry of `types` carries `available` and `reason` (every type has
  both; the examples above leave them out where they are always `true` and
  `null`). Two types depend on what the person's device reports: `illness`
  needs at least one of the capabilities `restingHr`, `hrv`, `skinTemp`;
  `sitting` needs `steps` and steps through the day rather than a daily total.
  When `available` is false, show the switch disabled with `reason` (a
  sentence without its full stop) under it. Switching an unavailable type on
  is refused with 409 `conflict` and the same reason as the message.
- `illness` (default on): once per day the flag in `GET /api/data`
  (`illness.flag`) is raised, from that day's `illness.reasons`. Opens `/`.
- `sitting` (default **off**, opt-in): during `prefs.sitting.from` to `to` on
  `prefs.sitting.days` (the person's zone), when their steps in the last hour
  are under `prefs.sitting.threshold`. At most once an hour; never in quiet
  hours (not even as an in-app `notify`), never while a workout is running,
  not in the first hour of the window, and never when the newest step data is
  more than 20 minutes old. Opens `/`.
  - `prefs.sitting`: `from` and `to` are `HH:MM` with `from` earlier than `to`
    (the window does not cross midnight); `days` is a non-empty list of `sun`,
    `mon`, `tue`, `wed`, `thu`, `fri`, `sat`; `threshold` is a whole number
    within `limits.sitting.threshold`. `PUT /api/push/prefs` takes any subset
    as `"sitting": { … }`; anything else is a 400 and changes nothing.
  - `status.sitting.state` says what the nudge is doing, for a line under its
    controls: `off`, `unavailable`, `outside` (not the person's hours or
    days), `quiet`, `workout`, `waiting` (no step reading yet), `stale`,
    `warming` (first hour), `ok`, `low` (under the threshold). `steps` is the
    last hour's count up to `asOf` (ms) for `ok` and `low`, else `null`.
  - The first time it is switched on the server asks Google whether steps
    arrive through the day (one call); if they do not, the reply is the 409
    above and `available` stays false for a day.
- `prefs.quiet`: nothing is pushed between `from` and `to` (their zone);
  `null` = no quiet hours. In-app `notify` events still arrive.
- To know which listed device is this browser, compare the browser's
  `PushSubscription.endpoint` with the `endpoint` you sent: the reply to
  `subscribe` returns `deviceId`.

| route | body | reply |
|---|---|---|
| `POST /api/push/subscribe` | `{ "subscription": <PushSubscription.toJSON()>, "label"? }` | `GET /api/push` payload plus `"deviceId": "d_4f1a9c"`. Subscribing the same endpoint again updates it |
| `PATCH /api/push/devices/:id` | `{ "enabled"?, "types"?, "label"? }` | `GET /api/push` payload |
| `DELETE /api/push/devices/:id` | – | `GET /api/push` payload |
| `POST /api/push/unsubscribe` | `{ "endpoint" }` | `GET /api/push` payload (for a browser that lost its device id) |
| `PUT /api/push/prefs` | any of `types` (partial), `quiet`, `morningAt`, `weeklyAt`, `sitting` (partial) | `GET /api/push` payload. 409 `conflict` when it switches on a type that is not `available` |
| `POST /api/push/test` | `{ "deviceId"? }` | `{ "sent": 1, "failed": 0, "removed": 0, "errors": [] }` (all devices when no id). 409 when there is no device |

`subscription` must be `{ "endpoint": "https://…", "keys": { "p256dh": "…", "auth": "…" } }`.
Use `publicKey` (base64url, the VAPID application server key) with
`pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })`.

### What the service worker receives

`event.data.json()`:

```json
{ "type": "workout_end", "title": "Workout ended?", "body": "Workout 18:10 to 19:08 (58 min). Tap to save.",
  "tag": "workout:12", "url": "/workouts/12", "at": 1760026800000 }
```

Show it with `tag` (so a newer one replaces an older one) and open `url` on
click. `url` is always a path on this site: `/`, `/workouts`, `/workouts/<id>`,
`/summary`, `/ranks`, `/u/<username>`, `/settings/connections`.

## Console-module link

For the person, in Settings → Connections:

| route | body | reply |
|---|---|---|
| `GET /api/link` | – | `{ "keys": [ { "id": "k_91ab", "label": "HP box", "last4": "x7Qd", "createdAt": ms, "lastSeenAt": ms \| null, "moduleVersion": "1.3.0" \| null } ], "active": false, "prompter": "web", "url": "https://health.ojee.net" }` |
| `POST /api/link/keys` | `{ "label"? }` | the `GET /api/link` payload plus `"key": "hlk_…"`. **The only time the key is shown.** |
| `DELETE /api/link/keys/:id` | – | `GET /api/link` payload. The module gets 401 from then on |

### The sync protocol (for whoever implements the module side)

The module is configured with `HEALTH_WEB_URL` (for example
`https://health.ojee.net`) and `HEALTH_WEB_KEY` (the `hlk_…` key). Every
request carries `Authorization: Bearer <key>`. No cookie, no `Origin` needed.
401 `bad_key` means the key was revoked: stop polling and say so.

Poll once a minute:

1. `POST /api/link/changes` with everything of yours that changed since your
   last successful POST (may be an empty list).
2. `GET /api/link/changes?since=<cursor>` and apply what comes back.
   Store the returned `cursor` only after applying.

**Who detects and asks.** While the link is healthy, **this app does**: it
runs the workout detection and sends the "workout started?" / "workout
ended?" notifications, exactly as it does for anyone (when the person has
switched detection on here). Every link reply says so with
`"prompter": "web"`. A module that sees that must stop its own detection and
its own workout prompts, and mirror this app's `ongoing` / `running` /
`review` / `done` / `dismissed` workouts instead, so its Workouts page stays
right and an answer given on either side settles both. The module falls back
to detecting and asking by itself only when the link has been **failing for
30 minutes** (no 2xx reply; judge with your own clock from the last good
reply, and use `serverTime` from that reply to spot clock skew), and hands
back as soon as a reply with `prompter: "web"` arrives. Every reply also
carries `detection`, so the module can tell the person when detection is
switched off on this side (`enabled: false`) or the device cannot support it
(`available: false`, with `reason`): in those cases nobody is detecting, and
the module should say so rather than quietly take over.

#### `GET /api/link/changes?since=<cursor>`

`since` is the opaque cursor from the previous GET; omit it (or send `0`) for
everything. Records applied from your own POSTs are **not** echoed back.

```json
{
  "cursor": "184",
  "serverTime": 1760083200000,
  "prompter": "web",
  "detection": { "enabled": true, "available": true, "reason": null },
  "tz": "Africa/Cairo",
  "workouts": [ { "…workout record…": 0 } ],
  "sets": [ { "…set record…": 0 } ],
  "more": false
}
```

At most 200 records per reply; when `more` is `true`, GET again with the new
cursor straight away.

#### `POST /api/link/changes`

```json
{
  "module": { "version": "1.3.0", "fallback": false },
  "workouts": [ { "…workout record…": 0 } ],
  "sets": [ { "…set record…": 0 } ]
}
```

Reply:

```json
{
  "ok": true,
  "serverTime": 1760083200000,
  "prompter": "web",
  "detection": { "enabled": true, "available": true, "reason": null },
  "applied": 2,
  "ignored": 1,
  "results": [
    { "uid": "0b1c6d4e-…", "kind": "workout", "result": "applied" },
    { "uid": "5a0e77c1-…", "kind": "workout", "result": "stale" },
    { "uid": "bad", "kind": "set", "result": "invalid", "error": "start is required" }
  ]
}
```

`result`: `"applied"`, `"stale"` (ours is newer or the same; you will get, or
already got, ours through GET), `"invalid"` (dropped; fix and resend). Up to
500 records per POST, 2 MB.

`module` is optional and informational: `version` is shown on the Connections
page; `fallback: true` says the module is currently detecting by itself after
a link outage (workouts it detected in that time arrive as ordinary records
and are merged by `uid`; this app does not ask about them again, because
their `prompts` keys are already set).

#### Workout record

```json
{
  "uid": "0b1c6d4e-6f0a-4c59-9a55-3a1d3c1f7e21",
  "updatedAt": 1760026900000,
  "deleted": false,
  "status": "done",
  "source": "detected",
  "start": 1760022600000,
  "end": 1760026080000,
  "lastEnd": 1760026080000,
  "title": "Workout",
  "notes": null,
  "exerciseType": "WEIGHT_MACHINES",
  "avgHr": 118, "maxHr": 146, "steps": 420, "kcal": 312.5, "activeMin": 49,
  "threshold": 107,
  "startEdited": false, "endEdited": false,
  "autoClosed": null,
  "prompts": { "start": 1760023200000, "end": 1760026800000 },
  "google": { "name": "users/me/dataTypes/exercise/dataPoints/ojee-w-0b1c6d4e-6f0a-4c59-9a55-3a1d3c1f7e21", "state": "saved" },
  "exercises": [
    { "name": "Chest Press (Machine)", "muscle": "chest", "notes": null, "supersetId": null,
      "sets": [ { "index": 0, "type": "normal", "kg": 50, "reps": 10, "distanceM": null, "durationS": null, "rpe": null } ] }
  ]
}
```

| field | type | rules |
|---|---|---|
| `uid` | string, 8–64 chars of `[A-Za-z0-9_-]` | **stable for the life of the workout, on both sides.** Whoever creates the workout mints it (a UUID v4). The module's existing rows need one minted and stored once |
| `updatedAt` | ms | when the record last changed on the side that changed it. **Last write wins**: a record is applied only if its `updatedAt` is greater than the stored one. Keep the sender's `updatedAt` when storing (do not replace it with your own clock), so both sides converge on the same value |
| `deleted` | bool | a tombstone. Keep the row (status `deleted`) so a late copy cannot resurrect it. A tombstone needs only `uid`, `updatedAt`, `deleted: true` (and `google` if a point was deleted) |
| `status` | string | `ongoing`, `running`, `review`, `done`, `dismissed`. The module's other terminal statuses (`cancelled`, `discarded`, `superseded`, `merged`) are accepted and stored as they are; this app hides them. `deleted` is expressed with `deleted: true` |
| `source` | string | `detected`, `manual`, `logged`, `hevy` |
| `start` | ms | required unless `deleted` |
| `end` | ms or `null` | `null` while `ongoing` / `running` |
| `lastEnd` | ms or `null` | how far a detected effort reaches |
| `title`, `notes` | string or `null` | ≤ 80 / ≤ 2000 chars |
| `exerciseType` | string or `null` | a Google Health `exerciseType` enum value; `null` = the receiver's default |
| `avgHr`, `maxHr`, `steps`, `kcal`, `activeMin`, `threshold` | number or `null` | bpm, bpm, count, kcal, minutes, bpm |
| `startEdited`, `endEdited` | bool | the person moved that time by hand (a detector must not move it back) |
| `autoClosed` | `"calm"`, `"no raised heart rate seen"` or `null` | |
| `prompts` | object | `{ "start": ms \| string, "end": ms \| string }`: when each question was asked, or why it was not (`"skipped: night"`, `"off"`). Present keys mean "already handled: do not ask again" on either side |
| `google` | object or `null` | below |
| `exercises` | array or absent | the workout's whole exercise and set list. **Present = replaces the stored list; absent = leave the stored list alone.** `[]` clears it |

`google`:

- `name`: the Google Health data point name, when one exists.
- `state`: `"saved"` (the point exists under `name`), `"pending"` (the
  **sender** is going to upload it), `"deleted"` (the sender deleted the point),
  `"foreign"` (the session is already in Google from a device or another app:
  nobody uploads), `"local"` (the person chose not to upload it).

**No double upload**, two rules, both required:

1. The side on which the workout became `done` uploads it. It sends the record
   with `google.state: "pending"` until the upload lands, then again with
   `"saved"` and the `name`. The receiving side stores `pending` records as
   "the other side uploads" and never uploads them itself.
2. As a safety net against races (both sides seeing `done` at once), the data
   point name is derived from the `uid`, never from a local id or clock:
   `users/me/dataTypes/exercise/dataPoints/ojee-w-<uid>`. Google rejects a
   second create with the same name with 409; treat that 409 as "already
   saved under this name". Both sides use the same OAuth client, so either
   may PATCH or batchDelete the point.

A record that already carries a `name` from before the link existed (the
module's `ojee-workout-<id>-<t>` points) keeps that name.

Deleting: the side where the person pressed delete removes the point from
Google first, then sends the tombstone with `google: { "name": "…", "state": "deleted" }`.
The receiver marks its row deleted and does not call Google.

Answering a prompt on either side is just a status change: `ongoing` →
`running` (confirmed), `review` → `done` (saved, maybe with edited `start` /
`end`), anything → `dismissed`. The other side applies it by `updatedAt` and
stops asking.

#### Set record (the module's free-standing strength log)

```json
{ "uid": "s-7c1d0c52", "updatedAt": 1760026900000, "deleted": false,
  "date": "2026-10-09", "t": 1760022600000,
  "exercise": "Bench press", "muscle": "chest", "kg": 72.5, "reps": 8, "sets": 4, "note": null }
```

`date` is the civil date of the session, `t` an instant used for ordering,
`sets` the number of identical sets this row stands for (≥ 1), `muscle` one of
`chest, back, shoulders, arms, legs, core, other`. Same `uid` / `updatedAt` /
`deleted` rules as workouts. These are sets not attached to a workout; sets
that belong to a workout travel inside its `exercises`. This app counts both
in strength totals and never creates free-standing sets of its own.

## Account and data

| route | body | reply |
|---|---|---|
| `GET /api/export` | – | one JSON file (`content-disposition: attachment; filename="health-<username>-<date>.json"`): profile, settings, every daily metric, sleep, weight, exercises, workouts with sets, summaries, public rows, records. No tokens, no keys |
| `POST /api/google/disconnect` | – | revokes the grant at Google, keeps the history. Returns `/api/me` |
| `POST /api/account/delete-data` | `{ "confirm": "<your username>" }` | removes the person's folder (database, Google token) and every global row (profile, public rows, records, push devices, link keys, saved key). Revokes the Google grant first. The ojee.net account and session stay. Returns `{ "ok": true }`; `/api/me` then shows a fresh profile at onboarding step `profile` (or `profile: null` if registration is closed) |

## Admin

Admins are the usernames in `ADMIN_USERS` (default `ojee`). 403 `forbidden` otherwise.

### `GET /api/admin`

```json
{
  "registrationOpen": true,
  "people": [
    { "id": "6707a1…", "username": "demo", "displayName": "Demo", "joinedAt": 1752300000000, "lastSeenAt": 1760083000000,
      "private": false, "google": "ok", "lastSyncAt": 1760083200000, "syncError": null, "nextSyncAt": 1760084400000,
      "pushDevices": 1, "linkKeys": 0, "aiKey": false, "detection": true }
  ],
  "server": {
    "version": "1.0.0", "node": "v22.22.2", "startedAt": 1760000000000, "uptimeS": 83200, "demo": false,
    "memoryMb": 92, "worlds": { "open": 4, "max": 40 },
    "scheduler": { "inFlight": 0, "maxInFlight": 3, "runs": 412, "failures": 2, "lastRunAt": 1760083200000 },
    "google": { "configured": true, "redirectUri": "https://health.ojee.net/auth/google/callback" },
    "push": { "configured": true }, "mongo": { "ok": true }
  }
}
```

`people[].google`: `ok` | `needs_auth` | `expired`. No health data is ever in
this payload.

### `POST /api/admin/registration`

Body `{ "open": false }`. Returns the `GET /api/admin` payload. Closing blocks
new accounts from this site and new health profiles; existing people carry on.

## Service

### `GET /api/health`

No auth. `{ "ok": true, "version": "1.0.0", "demo": false, "uptimeS": 83200 }`

## Static files and headers

- Everything in `web/` is served from `/`. A path with no file extension that
  is not `/api/*` or `/auth/*` gets `index.html` (so `/u/mira`, `/workouts/12`,
  `/settings/privacy` load the app). A missing file **with** an extension is a
  404 (so a missing script never comes back as HTML).
- `index.html` and `/sw.js`: `cache-control: no-store`. `/sw.js` also gets
  `Service-Worker-Allowed: /`. `*.webmanifest` is `application/manifest+json`.
  Other files: `cache-control: no-cache` with an `ETag` (revalidated each
  load, 304 when unchanged), so there is no cache-busting to manage.
- Content-Security-Policy on every reply:
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`.
  So: **no inline `<script>`, no `on…=` attributes, no external hosts** (fonts,
  CDNs, analytics). Inline `style=""` attributes and `<style>` are allowed.
- Also sent: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`,
  `X-Frame-Options: DENY`.

## Demo mode

`npm run demo` → `http://localhost:5020`, nothing real is touched (in-memory
accounts, a fake Google, data under `data/demo/`, wiped on every start).

| username | password | what they are |
|---|---|---|
| `demo` | `demo` | Fitbit Air with everything; Hevy workouts imported (attached to the sessions the watch logged); detection on, one detected workout waiting for review |
| `mira` | `demo` | Pixel Watch: no skin temperature, no body fat; runner |
| `sam` | `demo` | phone only: steps and distance, nothing else |
| `noor` | `demo` | Garmin: no HRV, no SpO2, sleep without stages |
| `kai` | `demo` | Fitbit; **private account** (absent from leaderboards, profile 404s for others) |
| `lena` | `demo` | Apple Watch via Apple Health; sleep and heart public |
| `ojee` | `demo` | admin; Fitbit Air; saves workouts as `WEIGHT_MACHINES` |

In demo mode: registering works (the account lives until restart);
"Connect Google" on a new account goes through a stand-in consent step
(`/demo/google/consent`, an instant redirect) and connects a full Fitbit
persona at once, with the first sync done a second later; Web Push is real
(a real browser subscription gets real notifications; `POST /api/push/test`
is the quick way to see one); OpenCode calls are real if you save a real key,
otherwise the summary falls back to rules with the reason. The session cookie
is `SameSite=Lax` without `Secure` on `http://localhost` (in production it is
`Secure; SameSite=None; Domain=.ojee.net`, as on mtg and dnd). Rate limits are
20 times looser. The scheduler runs: data re-syncs every 20 minutes and
"today" grows through the day.

## Changes

- 2026-10-11: numbers in context. Added `GET /api/brief` (Today: each metric against the person's usual for the weekday or their 30-day baseline, the week against last week, streaks with `best`/`atRisk`/`need`, sleep against the 14-night usual, `changes`, ranked `insights`, `next`, `missing`) and `GET /api/day?date=` (steps and heart rate per local hour, read from Google and kept; a stream that cannot be shown is `available: false` with a `reason`, never a 502). `GET /api/trends` accepts `days=180` and gained `analysis`, `months`, `relations`, six fields on every `series` row (`stepsAvg7`, `sleepAvg7`, `rhrAvg7`, `hrvAvg7`, `activeMinutes`, `activeAvg7`), `sleep.regularity`, `sleep.stagesAvg`, `sleep.debtMin`, `sleep.goalNights`, and `weight.ratePerWeekKg`, `weight.rangeChangeKg`, `weight.min`, `weight.max`. All additions; nothing that was there changed shape.

- 2026-10-11: a training log and livelier boards. All additions; nothing that was there changed shape. `GET /api/workouts` has `training` (`week` against `avg4`, 12 `weeks` with `zonesMin`, `weekday`, `hours`, `zones`, `balance`, `prs`, `exercises`, `usual`), and every workout in `running`/`pending`/`history` has `spark`, `zonesMin` and `prCount`. `GET /api/workouts/:id` has `zones` and `usual`, `pr` on every set and `previous` on every exercise. Heart-rate zones are by heart-rate reserve from the resting heart rate and the highest heart rate in the workouts' own traces; zone minutes come only from traces this app already holds, and the list never asks Google for one. `GET /api/leaderboard` has `group`, per entry `spark`, `prevRank`, `move` and `gapToNext`, and `me.vsMedianPct`, `me.ahead`, `me.behind`. `GET /api/compare` has `score` and `series`. `GET /api/users/:username` has `year`, `weeks` and `weekday`, and `daysAgo` on each record. The social additions read the public tables only, under the same category flags as everything beside them: what is private is `null`, your own side of a comparison included.

- 2026-10-11: two notification types, `illness` (default on) and `sitting` (default off, opt-in). `GET /api/push`: every `types[]` entry gains `available` and `reason`; added `prefs.sitting` (`{ from, to, days, threshold }`), `limits.sitting.threshold` and `status.sitting`. `PUT /api/push/prefs` takes `sitting` (any subset, validated: 400) and answers 409 `conflict` when a type that is not available is switched on. Per-device `types` accepts the two new ids. Both open `/`. Nothing else in the payload changed shape.

- 2026-10-10: live heart rate. Added `POST /api/live/hr` (session, or `Authorization: Bearer <link key>`; `{ samples: [{ t, bpm }] }` or `{ bpm }`; `bpm: 0` ends it; 10 requests a second per person), `GET /api/live`, the `live` event on `/api/events`, and `live` in `GET /api/data`. In memory only: nothing is stored, nothing is public, and it ends 10 s after the last reading. Workout traces do not take live samples.

- 2026-10-10: summaries no longer need a key. `ai.free` (boolean, wherever `ai: { keySet, last4 }` appears) says the server can ask OpenCode's free models itself (env `OPENCODE_URL`, an `opencode serve` on loopback; see `server/core/writer.js`). Order: the person's own key if saved, then the free models, then rules. `model` in a summary is the bare model id either way.

- 2026-10-10: first version.
- 2026-10-10: console-module link: this app is now the one that detects and
  asks while a link is active (owner decision). Removed the module's
  `detector: true` flag and everything that hung off it (`me.link.detector`,
  `detection.suppressedByLink`, `keys[].detector`). Added `prompter: "web"`
  and `detection` to both link replies (`serverTime` was already there);
  `me.link` is now `{ keys, active, prompter }`; `POST /api/link/changes`
  takes an optional `module: { version, fallback }`.
- 2026-10-10: units are one choice per unit. `me.units` keeps its shape
  (`{ distance, weight, temp }`) and each key is set by itself through
  `PATCH /api/settings`. Added `me.unitSystem` (`"metric"` | `"imperial"` |
  `"mixed"`). `PATCH /api/settings` still accepts the old single
  `"units": "metric" | "imperial"` for one version. Profiles stored with the
  single switch are rewritten when the server starts (metric: km, kg, c;
  imperial: mi, lb, f); nothing else in a profile changes.
