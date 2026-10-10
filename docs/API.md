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

### `GET /api/trends?days=90`

For the Trends tabs. `days` one of 7, 30, 90, 365 (anything else → 30).

```json
{
  "today": "2026-10-10", "tz": "Africa/Cairo", "days": 90, "from": "2026-07-13",
  "series": [ { "date": "2026-07-13", "steps": 8123, "distanceM": 6010, "azm": 24, "activeMin": null, "kcal": 2290,
                "rhr": 57, "rhrBase": 57.2, "rhrSd": 1.2, "hrv": 52.1, "hrvBase": 51.9, "hrvSd": 3.0,
                "spo2": 96.3, "spo2Lo": 94.7, "spo2Hi": 97.7, "tempDev": 0.05, "tempSd": 0.21, "sleepMin": 431, "bodyFat": null } ],
  "weeks": [ { "week": "2026-10-05", "days": 6, "steps": 51230, "stepsAvg": 8538, "distanceM": 38400, "activeMinutes": 141,
               "kcalAvg": 2310, "sleepAvgMin": 438, "rhrAvg": 58.2, "hrvAvg": 50.4, "workouts": 3, "workoutMin": 171 } ],
  "sleep": {
    "nights": [ { "id": "users/me/dataTypes/sleep/dataPoints/abc", "date": "2026-10-10", "main": true, "startMs": 0, "endMs": 0, "startOff": 10800, "endOff": 10800,
                  "asleepMin": 452, "awakeMin": 19, "periodMin": 471, "stages": [], "summary": { "stages": {} } } ],
    "consistency": { "nights": 62, "bedtime": "23:29", "bedtimeSd": 36, "wake": "07:01", "wakeSd": 40, "asleep": 433, "asleepSd": 39 }
  },
  "weight": { "latest": { "date": "2026-10-09", "avg7": 77.08 }, "change30": -0.61, "trend": [], "points": [] },
  "activity": { "stepTarget": 8000, "azmTarget": 22, "sleepTarget": 450, "streak": { "steps": 4, "azm": 3 } },
  "caps": { "steps": true }
}
```

`series` rows are the same shape as in `/api/data`. `weeks` are Monday weeks,
oldest first (`days` = days of that week with any data). `sleep.nights` has
every night in range; the per-segment `stages` array is filled only when
`days` ≤ 30 (otherwise `[]`; `summary.stages` minutes are always there).

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
  "updatedAt": 1760026900000
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
      "sets": [ { "index": 0, "type": "normal", "kg": 70, "reps": 8, "distanceM": null, "durationS": null, "rpe": 8 } ]
    }
  ]
}
```

`trace` rows are `[minuteStartMs, avgBpm | null, steps]`, covering the workout
with 20 minutes either side, oldest first. When there is none, `trace` is `[]`
and `traceReason` says why (`"Your device does not report minute-by-minute
heart rate"`, `"Heart rate for this period is no longer available"`, …).
`set.type`: `"normal"` | `"warmup"` | `"dropset"` | `"failure"`.

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
  "entries": [
    { "rank": 1, "username": "mira", "displayName": "Mira", "accent": "#e2574c",
      "value": 61230, "previous": 54100, "trend": 13, "me": false, "detail": null },
    { "rank": 2, "username": "demo", "displayName": "Demo", "accent": "#2fbf71",
      "value": 51230, "previous": 55020, "trend": -7, "me": true, "detail": null }
  ],
  "me": { "rank": 2, "value": 51230, "previous": 55020, "trend": -7, "listed": true, "reason": null }
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
    { "kind": "best_day_steps", "label": "Most steps in a day", "value": 24180, "unit": "steps", "date": "2026-09-12" },
    { "kind": "best_week_steps", "label": "Most steps in a week", "value": 82400, "unit": "steps", "date": "2026-09-07" },
    { "kind": "longest_workout", "label": "Longest workout", "value": 96, "unit": "min", "date": "2026-08-30" },
    { "kind": "most_workouts_week", "label": "Most workouts in a week", "value": 5, "unit": "workouts", "date": "2026-09-14" }
  ],
  "recentWorkouts": [ { "date": "2026-10-09", "start": 1760022600000, "durationMin": 58, "title": "Push Day", "type": "STRENGTH_TRAINING" } ],
  "heatmap": [ { "date": "2025-10-11", "level": 0, "steps": null, "workouts": 0 }, { "date": "2026-10-10", "level": 3, "steps": 9120, "workouts": 1 } ],
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
  or the Monday of the week, the record was set.

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
  ]
}
```

A value is `null` when that person keeps the category private or has no data
(`a`, your own side, is `null` for a category you keep private too: the
comparison only ever shows what is public on both sides of the table).

## Notifications (Web Push)

### `GET /api/push`

```json
{
  "publicKey": "BJ3x…",
  "types": [
    { "id": "workout_start", "label": "Workout started?", "description": "Asks once when your heart rate looks like a workout has begun.", "default": true },
    { "id": "workout_end", "label": "Workout ended?", "description": "Asks once when a workout looks finished, so you can save it.", "default": true },
    { "id": "morning", "label": "Morning readiness", "description": "Your readiness and last night's sleep, once a morning.", "default": true },
    { "id": "weekly", "label": "Weekly summary", "description": "The week's headline and next steps, once a week.", "default": true },
    { "id": "step_goal", "label": "Step goal reached", "description": "When you reach your step goal for the day.", "default": true },
    { "id": "leaderboard", "label": "Passed on the leaderboard", "description": "When someone passes you on this week's steps.", "default": false },
    { "id": "record", "label": "New personal record", "description": "When you set a new best.", "default": true },
    { "id": "battery", "label": "Device battery low", "description": "When your tracker is at 20% or less.", "default": true },
    { "id": "connection", "label": "Google connection needs attention", "description": "When Google stops accepting the connection and syncing has stopped.", "default": true }
  ],
  "prefs": {
    "types": { "workout_start": true, "workout_end": true, "morning": true, "weekly": true, "step_goal": true, "leaderboard": false, "record": true, "battery": true, "connection": true },
    "quiet": { "from": "22:30", "to": "07:00" },
    "morningAt": "07:30",
    "weeklyAt": { "day": "sun", "time": "18:00" }
  },
  "devices": [
    { "id": "d_4f1a9c", "label": "iPhone", "enabled": true, "types": null, "createdAt": 1760000000000, "lastOkAt": 1760080000000, "lastError": null }
  ]
}
```

- `prefs.types` are the person's switches; a device is sent a notification
  when the type is on, the device is `enabled`, and the device's own `types`
  (a partial map, or `null` = follow the account) does not switch it off.
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
| `PUT /api/push/prefs` | any of `types` (partial), `quiet`, `morningAt`, `weeklyAt` | `GET /api/push` payload |
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
