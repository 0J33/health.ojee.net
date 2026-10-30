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
| 409 | `needs_scope` | the needed Google permission was not granted; `error` says to reconnect. From `POST /api/google/groups`: `detail.start` is where to ask for it |
| 409 | `group_off` | the optional group this metric or entry belongs to is switched off; `detail.group` on a metric page |
| 400 | `bad_entry` | an entry's field is missing or out of range; `error` says which |
| 400 | `bad_kind` | not a kind that can be logged |
| 400 | `bad_metric`, `too_many` | pins: not a metric id; a ninth pin |
| 400 | `bad_group` | not one of the five optional groups |
| 403 | `read_only` | an entry that came from Google Health cannot be changed here |
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

`groups=nutrition,cycle` (optional, comma-separated ids from `me.google.groups`)
also asks Google for those optional groups' permissions, on top of the usual
ones and of what the person already granted (incremental authorization).
Unknown ids are ignored. Groups the person has already switched on are always
asked for again, so a plain reconnect brings back exactly what they chose.
When the callback succeeds the groups named here are recorded as switched on;
a cancelled or failed consent changes nothing.

`account=new` adds another Google account (Google's account chooser is shown:
`prompt=select_account consent`); `account=<id>` (an id from
`me.googleAccounts`) reconnects that one, with its address as `login_hint`.
Without it, the main account, as before. Optional groups are only ever asked
of the main account. The callback checks who signed in before anything is
stored: the same Google account added twice is refreshed, not added
(`?google=already`), and reconnecting an account while signed in as another
is refused (`?google=error&message=...`) without revoking anything.

### `GET /auth/google/callback`

Where Google sends the browser back. Redirects to the `return` path with the
outcome in the query string:

| query | meaning |
|---|---|
| `?google=connected` | connected; the first sync has started |
| `?google=added` | another account was added; its first sync has started |
| `?google=already` | that Google account was already connected here; its connection was refreshed |
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
  "goals": { "steps": 8000, "activeMinutes": 22, "sleepMinutes": 450, "cardioWeek": 180, "waterMl": 2500 },
  "privacy": { "account": "public", "activity": true, "workouts": true, "sleep": false, "heart": false, "body": false },
  "aiShare": { "nutrition": false, "mindfulness": false, "symptoms": false, "cycle": false, "ecg": false },
  "pins": ["vo2max", "water", "resp", "weight"],
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
    "missing": [],
    "groups": [
      { "id": "nutrition", "label": "Nutrition and water", "about": "Log water and food here. Each entry is saved to Google Health too.",
        "scopes": ["nutrition.writeonly"], "chosen": true, "granted": true, "usable": true, "readOnly": false,
        "note": "What you log here is saved to Google Health too. What you log in Google's own app cannot be read by other apps." },
      { "id": "ecg", "label": "ECG and rhythm notices", "about": "Shows the ECG readings and irregular rhythm notices your watch recorded.",
        "scopes": ["ecg.readonly", "irn.readonly"], "chosen": false, "granted": false, "usable": false, "readOnly": true,
        "note": "Read only: readings are taken on the watch. The waveform itself is not kept here." }
    ]
  },
  "sync": {
    "running": false,
    "lastRun": 1760083200000,
    "lastOk": 1760083200000,
    "lastError": null,
    "nextAt": 1760084400000,
    "backoffUntil": null,
    "streams": {
      "steps": { "at": 1760083200000, "rows": 4, "error": null, "skipped": null, "unavailable": false, "message": null, "unavailableAt": null, "backTo": null },
      "hrDay": { "at": 1760083200000, "rows": 12, "error": null, "skipped": null, "unavailable": false, "message": null, "unavailableAt": null, "backTo": "2026-09-14" },
      "water": { "at": null, "rows": null, "error": null, "skipped": "group off", "unavailable": false, "message": null, "unavailableAt": null, "backTo": null }
    }
  },
  "caps": {
    "steps": true, "activeMinutes": true, "calories": true, "distance": true,
    "heartRate": true, "heartRateMinute": true, "restingHr": true, "hrv": true,
    "spo2": true, "skinTemp": true, "sleep": true, "sleepStages": true,
    "weight": true, "bodyFat": true, "exercise": true, "deviceBattery": true,
    "floors": true, "caloriesActive": true, "respiratoryRate": true, "vo2max": true, "zones": true,
    "glucose": false, "bodyTemp": false, "height": true,
    "hydration": true, "nutrition": true, "mood": false, "symptoms": false, "cycle": false, "ecg": false
  },
  "capsMeta": {
    "updatedAt": 1760083200000,
    "windowDays": 14,
    "lastSeen": { "steps": "2026-10-10", "hrv": "2026-10-10", "weight": "2026-10-09" },
    "missing": [],
    "missingMore": [ { "cap": "glucose", "text": "No glucose readings. A connected glucose meter or sensor reports them, or log one here", "group": null } ]
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
  There are five and there will stay five: nothing an optional group holds,
  nor glucose or body temperature, can be made public, so they have no switch.
- `goals.cardioWeek`: the weekly cardio-minutes target (default 150).
  `goals.waterMl`: the daily water target in ml (default 2000).
- `aiShare`: per optional group, whether a summary may read what was logged in
  it. All `false` until the person turns one on. A group is read only while
  it is both shared here and switched on; glucose and body temperature are
  never read for a summary, and free-text notes never leave the person's store.
- `pins`: the metric ids pinned to Today, in order (at most 8; see `POST /api/pins`).
- `google.state`: `"ok"` | `"needs_auth"` (never connected, or disconnected) |
  `"expired"` (Google revoked or expired the grant; show Reconnect) |
  `"unconfigured"` (the server has no OAuth client; show "not available").
  `testingExpiry: true` with `expired` means the 7-day Testing-mode expiry.
- `google.missing`: sentences for permissions the person declined, ready to
  show, for example `"Reconnect to allow saving workouts"`. Only the core
  permissions: an optional group nobody asked for is never "missing".
- `google.groups`: the five optional groups, always all five, in a fixed order:
  `nutrition`, `mindfulness`, `symptoms`, `cycle`, `ecg`. `chosen` is the
  person's own switch; `granted` is whether Google holds the group's scopes
  (false while disconnected); `usable` is both. `scopes` are short names.
  `readOnly` is true for `ecg` (nothing can be written); the other four are
  write-only at Google, which `note` says in words fit to show. To ask Google
  for a group, navigate to `/auth/google/start?groups=<id>` (each group carries
  that address as `start`). Each group also has `mode` (`"off"` | `"google"` |
  `"local"`), `canLog` and `kinds`: see `POST /api/google/groups`, which is
  how a group is switched on or off, for exactly what they mean.
- `sync.lastError.code`: `"rate_limited"`, `"network"`, `"needs_auth"`, `"http_5xx"`…
  `sync.backoffUntil` is set while Google asked this person to slow down.
  `sync.streams` keys: `steps, azm, activeMinutes, kcal, distance, floors,
  kcalActive, zones, zoneKcal, sedentary, levels, altitude, swim, rhr, hrv, spo2,
  temp, resp, respSleep, hrDay, hrZones, spo2Samples, hrvSamples, vo2, vo2Samples,
  vo2Run, sleep, exercise, weight, bodyfat, height, glucose, bodytemp, hr, device,
  water, food, ecg, irn` (a key appears once its stream has been looked at;
  docs/DATA-TYPES.md says what each reads). `skipped` is `"scope not granted"`
  for a declined permission and `"group off"` for a stream of an optional group
  the person has not switched on. `unavailable: true` means Google refused that
  one data type for this account (`message` is Google's own sentence,
  `unavailableAt` when); the rest of the sync is unaffected and the stream is
  asked again a day later. `backTo` is set on the streams that fill their
  history a fortnight at a time: the earliest civil date read so far (it stops
  moving at 90 days back).
- `caps`: which streams produced data in the last 14 days. All `false` before
  the first sync. `capsMeta.missing` is a list of
  `{ "cap": "hrv", "text": "Your device does not report HRV" }` for the ones
  that are false, in display order. It covers the sixteen original
  capabilities only. The fourteen added later (`floors` to `ecg` above) are
  listed apart, in `capsMeta.missingMore`, as `{ cap, text, group }`: `group`
  is the optional group a capability belongs to or `null`, and a group's
  capability is only listed while that group is switched on. Three of them use
  a different window: `height` is true once there is any height at all,
  `cycle` looks back 45 days and `ecg` 90.
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
  "goals": { "steps": 10000, "activeMinutes": 30, "sleepMinutes": 480, "cardioWeek": 200, "waterMl": 2500 },
  "privacy": { "account": "private", "sleep": true },
  "aiShare": { "nutrition": true } }
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
sleepMinutes 240–720, cardioWeek 30–600 (minutes a week), waterMl 500–6000
(a day); numbers are rounded to whole ones and anything outside is a 400 that
names the field (`"goals.cardioWeek must be 30-600."`). A new sleep goal
re-scores every night's sleep score. A privacy change is applied to the public
tables before the reply is sent. `privacy` has the six keys it always had;
any other key in it is ignored.

`aiShare` is one boolean per optional group (`nutrition`, `mindfulness`,
`symptoms`, `cycle`, `ecg`); only the groups named change. A key that is not a
group (`"aiShare.glucose is not a group. …"`) or a value that is not a boolean
is a 400. It takes effect at the next summary written.

Returns the full `/api/me` payload.

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

#### `extra`: what "all the data" adds to Today

`brief.extra` is always present with the same nine keys. **Each part is
`null` (or an empty list) when the person has nothing for it or has not
switched its group on**, so Today is as short as their data: a phone-only
person gets exactly

```json
{ "cardio": null, "sleepScore": null, "calories": null, "floors": null, "vitals": [], "recovery": null, "water": null, "food": null, "pinned": [] }
```

The demo person (lists cut short):

```json
{
  "cardio": { "minutes": 174, "target": 180, "pct": 97, "source": "zone minutes",
    "days": [ { "date": "2026-10-05", "minutes": 36, "light": null, "moderate": 27, "vigorous": 9 },
              { "date": "2026-10-06", "minutes": 10, "light": null, "moderate": 7, "vigorous": 3 } ],
    "weeks": [ { "week": "2026-09-28", "minutes": 129, "target": 180, "hit": false },
               { "week": "2026-10-05", "minutes": 174, "target": 180, "hit": false } ] },
  "sleepScore": { "score": 99,
    "parts": [ { "id": "duration", "label": "Duration", "points": 49.4, "max": 50, "text": "7h 25m asleep, 5 min short of your goal of 7h 30m" },
               { "id": "stages", "label": "Stages", "points": 20, "max": 20, "text": "17% deep and 27% REM of the time asleep" },
               { "id": "continuity", "label": "Time awake", "points": 15, "max": 15, "text": "Asleep for 98% of the 7h 32m in bed" },
               { "id": "regularity", "label": "Regularity", "points": 15, "max": 15, "text": "Bedtime 18 min and wake 19 min from your usual" } ],
    "basis": "duration, stages, time awake, regularity", "usual": 93, "date": "2026-10-11" },
  "calories": { "total": 1391, "active": 357, "basal": 1034, "usual": { "total": 2285, "active": 404 },
    "week": [ { "date": "2026-10-10", "total": 2329, "active": 679, "basal": 1650 }, { "date": "2026-10-11", "total": 1391, "active": 357, "basal": 1034 } ] },
  "floors": { "value": 6, "usual": 8 },
  "vitals": [ { "id": "resp", "label": "Breathing rate", "value": 14.9, "text": "14.9 br/min", "unit": "br/min", "family": "vitals", "icon": "pulmonology", "usual": 14.8, "date": "2026-10-11" },
              { "id": "spo2", "label": "Blood oxygen", "value": 95.4, "text": "95.4%", "unit": "%", "family": "vitals", "icon": "spo2", "usual": 96.5, "date": "2026-10-11" } ],
  "recovery": { "label": "near your usual",
    "text": "Your recovery signals over the last 7 days are near your usual: HRV 51.1 ms against 51.2, resting heart rate 57.6 bpm against 57.4 over the 30 days before. A trend calculated by this app from HRV and resting heart rate; it measures nothing else.",
    "z": -0.08, "parts": [ { "id": "hrv", "value": 51.1, "baseline": 51.2, "z": -0.02 }, { "id": "rhr", "value": 57.6, "baseline": 57.4, "z": -0.13 } ],
    "days": [ { "date": "2026-10-10", "z": -1.23 }, { "date": "2026-10-11", "z": -1.98 } ] },
  "water": { "ml": 1500, "target": 2500, "entries": 4 },
  "food": { "kcal": 940, "protein": 47, "carbs": 110, "fat": 30, "entries": 2 },
  "pinned": [ { "id": "vo2max", "label": "VO2 max", "category": "heart", "family": "heart", "icon": "sprint", "unit": "ml/kg/min", "kind": "state",
                "latest": { "value": 44.3, "text": "44.3 ml/kg/min", "at": null, "date": "2026-10-11" },
                "spark": [44, 44, 44.1, 44, 43.8, 44, 43.8, 44.2, 44.4, 44, 44.5, 44.6, 44.4, 44.3],
                "pinned": true, "canAdd": false, "sensitive": false, "group": null, "own": false } ]
}
```

- `cardio`: this Monday week's cardio minutes against `goals.cardioWeek`.
  **Calculated by this app** (label it "Cardio minutes"; never a product
  name). `days` is always 7, Monday first; a day that has not come or has
  nothing has `minutes: null`. `source` says what the minutes were counted
  from: `"zone minutes"` (`moderate` = minutes credited in the fat-burn zone,
  `vigorous` = credited above it, `light: null`), `"time in heart-rate zones"`
  (`light`, `moderate`, `vigorous` are minutes of time; vigorous counts double
  in `minutes`) or `"active minutes"` (`moderate` = the device's moderate and
  vigorous active minutes together; the others `null`). `weeks` is always 12,
  oldest first, the last being this week; `hit` is `minutes >= target`.
  `null` for somebody with no such data in those 12 weeks.
- `sleepScore`: the latest main night (ending today or yesterday), scored out
  of 100 **by this app**. `parts` are the ones that could be worked out, each
  with the points earned of `max` and a sentence; `basis` names them (a
  device without stages has no `stages` part, and the score is rescaled to
  what is there). `usual` is the mean score of the 14 nights before (`null`
  under 3). `date` is the morning the night ended on.
- `calories`: today so far. `basal` is `total - active`. `usual` is the mean
  of the same weekday over the last eight weeks for `total` and `active`
  (`null` under 3 of them; `usual` itself is `null` when neither is known).
  `week` is the 7 days ending today, oldest first, `null` where a day has none.
- `floors`: today's count and the usual for this weekday (`null` under 3).
- `vitals`: in this order when present: `resp`, `spo2`, `skin_temp`, `vo2max`
  (the latest value within 7 days; 45 for `vo2max`). `usual` is the mean of
  the 30 days before (`null` under 7 of them, and always for `skin_temp`,
  which already is a difference from baseline). `id` is the metric id.
- `recovery`: a 7-day trend of HRV and resting heart rate against the
  person's own 30 days before, **calculated by this app**. `label` is
  `"above your usual"` | `"near your usual"` | `"below your usual"`; `z` is
  the mean deviation in units of their own spread, up = better; `parts` has
  one row per signal the person has (`hrv`, `rhr`); `days` is always 7,
  oldest first (`z: null` for a day without a reading). It is not a stress
  score and must not be called one. `null` under 14 baseline days or under 3
  of the last 7.
- `water`, `food`: today's logged totals; `target` is `goals.waterMl`;
  macros in grams. **`null` unless the nutrition group is switched on**
  (zeros, not `null`, when it is on and nothing was logged today).
- `pinned`: the pinned metrics, in pin order, as Metric objects (see
  `GET /api/browse`), leaving out any without data or with its group off.

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

### Several Google accounts

The Google Health app takes one tracker per Google account, so a person with
two trackers connects two accounts. Each account syncs into its own store and
the two are folded into the person's own (`server/core/merge.js` says how,
rule by rule). `me.google` stays the **main** account (writes go there:
workouts, weigh-ins, logged entries; a point already saved is changed and
deleted in the account it was saved to). `me.googleAccounts` lists all of
them, `me.merge` holds the rules, and `me.sync` is the accounts together
(`lastOk` = the oldest of the connected accounts' last good syncs).

`GET /api/google/accounts` → `{ accounts, rules, primary }`, where each account is
`{ id, label, include, primary, addedAt, state, email, connectedAt, expiredAt,
testingExpiry, missing, lastOk, lastError, device }`.

`PATCH /api/google/accounts/<id>` `{ label?, include?, primary?: true }`:
rename (30 characters), leave out (`include: false`: not synced, not counted;
409 for the last one counted), or make it the main one (409 for a left-out one).
`POST /api/google/accounts/<id>/disconnect`: revokes it, keeps what it brought.
`DELETE /api/google/accounts/<id>`: revokes it and removes everything only it
brought; another account becomes the main one if need be; 409 for the only one.
`PATCH /api/google/merge` `{ activity?, overnight?, workouts? }`:

| rule | values | default |
|---|---|---|
| `activity` | `auto` (each quarter-hour counts the device that recorded more: read from Google per shared day), `sum`, `max`, `primary` | `auto` |
| `overnight` | `auto` (the device that recorded the night, the longer sleep when both did) or an account id | `auto` |
| `workouts` | `merge` (two overlapping by half or more are one; the fuller record stays) or `keep` | `merge` |

Each of these returns `{ accounts, rules, primary }` and recomputes every number.

`GET /api/data` adds `devices`: each tracker (with `account`, `accountLabel`)
when there are several, else null.

### `POST /api/weight`

Body `{ "kg": 77.4, "at": 1760083200000, "note": "morning" }` (`at` optional,
default now, not in the future, at most 30 days back; `kg` 20–400).
Writes to Google Health when it is connected with the weight permission, and
stores it locally either way (and marks the day owed to Hevy, when linked).
Without Google, or without the permission, it is kept here: `google: "local"`
and a `message` saying how to send it there too.

200 `{ "ok": true, "google": "saved" | "local", "message": null | "...", "point": { "t": 1760083200000, "kg": 77.4, "source": "app" } }`

## Every metric

Browse, the metric page, logging by hand and pins. One catalogue of metrics
(`server/catalog.js`) is behind all of it; a metric has the same `id`, `label`,
`family` and `icon` wherever it appears.

### The metrics

`kind` says what sort of number it is: `total` (adds up over a day: bars),
`state` (a level: a line), `range` (a lowest and highest per day), `stack`
(parts of a whole), `log` (entries, not a quantity), `score` (out of 100).
`family` names a colour token and `icon` a Material Symbols Rounded glyph in
snake_case; the frontend owns both. `own` = calculated by this app (its page
must say so: show `metric.ownNote`). `group` = the optional group it belongs
to; `sensitive` = always private (every group metric, plus `glucose` and
`body_temp`). `log here` = the entry kind of its form, if it has one.

| category | id | label | kind | family | icon | unit | own | group | log here |
|---|---|---|---|---|---|---|---|---|---|
| activity | `steps` | Steps | total | steps | `footprint` | steps | | | |
| activity | `distance` | Distance | total | steps | `distance` | m | | | |
| activity | `floors` | Floors climbed | total | active | `stairs` | floors | | | |
| activity | `altitude` | Elevation gained | total | active | `landscape` | m | | | |
| activity | `active` | Active minutes | total | active | `bolt` | min | | | |
| activity | `cardio_week` | Cardio minutes this week | total | active | `monitor_heart` | min | yes | | |
| activity | `calories` | Calories burned | total | energy | `local_fire_department` | kcal | | | |
| activity | `calories_active` | Active energy | total | energy | `mode_heat` | kcal | | | |
| activity | `calories_basal` | Resting energy | total | energy | `hotel` | kcal | yes | | |
| activity | `sedentary` | Sedentary time | total | active | `chair` | min | | | |
| activity | `activity_levels` | Activity levels | stack | active | `stacked_bar_chart` | min | | | |
| activity | `swim` | Swimming strokes | total | workouts | `pool` | strokes | | | |
| activity | `workouts` | Workouts | log | workouts | `fitness_center` | min | | | |
| heart | `resting_hr` | Resting heart rate | state | heart | `favorite` | bpm | | | |
| heart | `hrv` | Heart rate variability | state | recovery | `vital_signs` | ms | | | |
| heart | `heart_rate` | Heart rate | range | heart | `cardiology` | bpm | | | |
| heart | `zones` | Time in heart-rate zones | stack | heart | `speed` | min | | | |
| heart | `zone_calories` | Calories by heart-rate zone | stack | energy | `whatshot` | kcal | | | |
| heart | `vo2max` | VO2 max | state | heart | `sprint` | ml/kg/min | | | |
| heart | `recovery` | Recovery trend | state | recovery | `battery_charging_full` | SD | yes | | |
| heart | `ecg` | ECG readings | log | heart | `ecg` | bpm | | ecg | |
| heart | `irn` | Irregular rhythm notices | log | heart | `heart_check` | notices | | ecg | |
| sleep | `sleep` | Sleep | state | sleep | `bedtime` | min | | | |
| sleep | `sleep_score` | Sleep score | score | sleep | `hotel_class` | of 100 | yes | | |
| sleep | `sleep_stages` | Sleep stages | stack | sleep | `layers` | min | | | |
| sleep | `sleep_efficiency` | Sleep efficiency | state | sleep | `percent` | % | | | |
| body | `weight` | Weight | state | body | `monitor_weight` | kg | | | `weight` (own route) |
| body | `body_fat` | Body fat | state | body | `body_fat` | % | | | `bodyfat` |
| body | `height` | Height | state | body | `height` | cm | | | `height` |
| body | `bmi` | Body mass index | state | body | `accessibility_new` | kg/m2 | yes | | |
| vitals | `resp` | Breathing rate | state | vitals | `pulmonology` | br/min | | | |
| vitals | `spo2` | Blood oxygen | range | vitals | `spo2` | % | | | |
| vitals | `skin_temp` | Sleep temperature | state | vitals | `thermostat` | °C | | | |
| vitals | `body_temp` | Body temperature | state | vitals | `device_thermostat` | °C | | (private) | `bodytemp` |
| vitals | `glucose` | Blood glucose | range | vitals | `glucose` | mg/dL | | (private) | `glucose` |
| nutrition | `water` | Water | total | water | `water_drop` | ml | | nutrition | `water` |
| nutrition | `food` | Food | total | nutrition | `restaurant` | kcal | | nutrition | `food` |
| mindfulness | `mood` | Mood | log | mind | `mood` | (none) | | mindfulness | `mood` |
| cycle | `period` | Period | log | cycle | `calendar_month` | days | | cycle | `period` |
| cycle | `ovulation` | Ovulation tests | log | cycle | `science` | tests | | cycle | `ovulation` |
| other | `symptoms` | Symptoms | log | vitals | `sick` | symptoms | | symptoms | `symptom` |

Families (13): `steps`, `active`, `energy`, `heart`, `sleep`, `recovery`,
`body`, `workouts` (existing) and `vitals`, `nutrition`, `water`, `mind`,
`cycle` (new). Stack `tone`s (5): `muted`, `low`, `mid`, `high`, `peak`, a
ramp inside the metric's family colour (`muted` is the part that is not the
point: sedentary time, time awake).

Units are metric, as everywhere: `distance` and `altitude` in metres, `sleep`,
`sedentary`, `workouts` and the minute stacks in minutes (`metric.format` is
`"duration"` for the ones best shown as `7h 12m`), `height` in centimetres,
temperatures in °C, glucose in mg/dL. `skin_temp` is a difference from the
person's own baseline and is signed (`metric.signed`). `recovery` is in units
of the person's own day-to-day spread, zero being their usual; show
`latest.text` (`"near your usual"`), not the number, on a tile. `mood` has no
unit: its value is the day's feel from -1 (unpleasant) through 0 to 1
(pleasant), and `null` when no entry said how it felt.

`text` fields (`latest.text`, an entry's `text`, `reading`) are ready-made
sentences in metric units with en-GB separators, like every other sentence in
this API. Draw converted numbers from `value` where the person's units differ.

### `GET /api/browse`

Everything the person has, by category, and everything they do not.

```json
{
  "today": "2026-10-11", "tz": "Africa/Cairo",
  "categories": [
    { "id": "activity", "label": "Activity", "metrics": [
      { "id": "steps", "label": "Steps", "category": "activity", "family": "steps", "icon": "footprint", "unit": "steps", "kind": "total",
        "latest": { "value": 7085, "text": "7,085 steps", "at": null, "date": "2026-10-11" },
        "spark": [7421, 6251, 10299, 7298, 22318, 17767, 6793, 5517, 6716, 9429, 8453, 13553, 12366, 7085],
        "pinned": false, "canAdd": false, "sensitive": false, "group": null, "own": false }
    ] },
    { "id": "heart", "label": "Heart", "metrics": [
      { "id": "resting_hr", "label": "Resting heart rate", "category": "heart", "family": "heart", "icon": "favorite", "unit": "bpm", "kind": "state",
        "latest": { "value": 61, "text": "61 bpm", "at": null, "date": "2026-10-11" },
        "spark": [57, 57, 57, 57, 59, 57, 57, 57, 54, 56, 59, 56, 60, 61],
        "pinned": false, "canAdd": false, "sensitive": false, "group": null, "own": false }
    ] }
  ],
  "empty": [
    { "id": "swim", "label": "Swimming strokes", "category": "activity", "family": "workouts", "icon": "pool", "provides": "A swim-proof watch or band with swim tracking", "group": null, "groupOn": true, "canAdd": false },
    { "id": "ecg", "label": "ECG readings", "category": "heart", "family": "heart", "icon": "ecg", "provides": "A watch with an ECG app", "group": "ecg", "groupOn": false, "canAdd": false },
    { "id": "body_fat", "label": "Body fat", "category": "body", "family": "body", "icon": "body_fat", "provides": "Log it here, or use a scale that measures it", "group": null, "groupOn": true, "canAdd": true }
  ],
  "pinned": ["vo2max", "water", "resp", "weight"],
  "groups": [ { "id": "nutrition", "…": "GroupsView, as in /api/me google.groups" } ]
}
```

- `categories`: only categories with at least one metric, in the fixed order
  `activity, heart, sleep, body, vitals, nutrition, mindfulness, cycle, other`;
  inside one, the catalogue's order (the table above). Only metrics the person
  **has data for**, and whose group (if any) is switched on.
- **Metric** (the same object in `categories[].metrics`, `brief.extra.pinned`
  and, with more fields, `metric` of the metric page):
  `{ id, label, category, family, icon, unit, kind, latest, spark, pinned, canAdd, sensitive, group, own, decimals, format, signed }`.
  - `decimals`, `format` (`"duration"` | `null`) and `signed` say how the
    metric's numbers are written, so a row that converts `latest.value` to the
    person's units rounds it the way `latest.text` does.
  - `latest`: `{ value, text, at, date }`. `date` is the civil day it belongs
    to; `at` is the instant of the last entry (ms) for the kinds made of
    entries, else `null`. For a day's total it is today's value so far (or the
    last day there was any); for `cardio_week` it is this Monday week's total.
  - `spark`: numbers or `null`, oldest first. The last **14 days** ending
    today for daily metrics (a gap is `null`); the last **up to 14 entries**
    for `weight`, `body_fat`, `height`, `body_temp`, `glucose`, `mood`,
    `symptoms`, `period`, `ovulation`, `ecg`, `irn`; the last **12 weeks** for
    `cardio_week`. May be shorter than 14 for the entry kinds.
  - `canAdd`: the person can log this one here, now (see `add` below).
- `empty`: every other metric: no data yet, or its group is off.
  `provides` is one line for the "No data yet" state: which devices give it,
  or "Log it here". `groupOn: false` means the metric belongs to an optional
  group the person has not switched on: offer the switch (`groups`), not a
  form. `canAdd: true` means a form can be opened even though there is no data.
- Every metric of the catalogue is in exactly one of `categories` or `empty`.
- `pinned`: the pinned ids in order (also in `/api/me` as `pins`), including
  ones currently in `empty`.

A phone-only person gets `categories` with `steps` and `distance` and 39 rows
in `empty`; a new account gets `categories: []`.

### `GET /api/metric/<id>?range=week&end=YYYY-MM-DD&before=<ms>`

One metric over a period. `range`: `day` | `week` (default) | `month` | `6m` |
`year`. `end` is the last day shown (default and maximum: today). `before`
pages the entries.

| status | code | when |
|---|---|---|
| 404 | `not_found` | not an id of the table above |
| 409 | `group_off` | the metric's group is switched off for this person; `detail: { "group": "nutrition" }` |
| 400 | `bad_request` | `range`, `end` or `before` is not valid |

A metric the person simply has no data for is **200**, with empty `points`
and `entries`, `metric.latest: null` and a `reading` that says so.

Water over a week (the demo person):

```json
{
  "metric": {
    "id": "water", "label": "Water", "category": "nutrition", "family": "water", "icon": "water_drop", "unit": "ml", "kind": "total",
    "latest": { "value": 1500, "text": "1,500 ml", "at": 1791717900000, "date": "2026-10-11" },
    "spark": [2500, 1500, 1750, 2000, 2500, 1500, 1750, 2000, 2500, 1500, 1750, 2000, 2500, 1500],
    "pinned": true, "canAdd": true, "sensitive": true, "group": "nutrition", "own": false,
    "about": "Water you logged here, added up per day against your daily target. What you log in Google's own app cannot be read by other apps.",
    "ownNote": null, "provides": "Log it here", "betterWhen": "higher",
    "goal": 2500, "goalPer": "day", "decimals": 0, "format": null, "signed": false
  },
  "range": { "id": "week", "from": "2026-10-05", "to": "2026-10-11", "prevFrom": "2026-09-28", "prevTo": "2026-10-04",
             "prevEnd": "2026-10-04", "nextEnd": "2026-10-11", "canPrev": true, "canNext": false },
  "chart": {
    "kind": "bars", "bucket": "day",
    "points": [ { "date": "2026-10-05", "value": 2000, "days": 1, "n": 6, "goalHit": false },
                { "date": "2026-10-06", "value": 2500, "days": 1, "n": 7, "goalHit": true } ],
    "band": null, "goal": 2500, "note": null
  },
  "stats": { "avg": 1964, "min": { "value": 1500, "date": "2026-10-07" }, "max": { "value": 2500, "date": "2026-10-06" },
             "latest": { "value": 1500, "date": "2026-10-11" }, "total": 13750, "count": 7, "entries": 39 },
  "prev": { "avg": 1929, "total": 13500, "count": 7, "entries": 38, "deltaAbs": 35, "deltaPct": 1.8 },
  "reading": "Goal met on 2 of 7 days, 2% above the week before.",
  "entries": [
    { "id": "l-519e8ef9-f149-4ecf-af3d-a060b2a5ad7c", "kind": "water", "metric": "water", "t": 1791717900000, "end": null, "date": "2026-10-11",
      "text": "500 ml", "value": 500, "unit": "ml", "source": "app", "device": null, "editable": true, "deletable": true,
      "google": "saved", "error": null, "fields": { "at": 1791717900000, "ml": 500 }, "inRange": true }
  ],
  "more": true,
  "add": {
    "kind": "water", "route": "/api/entries",
    "fields": [ { "id": "ml", "label": "Amount", "type": "number", "unit": "ml", "min": 1, "max": 5000, "step": 10, "required": true },
                { "id": "at", "label": "When", "type": "datetime", "required": false, "maxAgeDays": 366 } ],
    "quick": [ { "label": "250 ml", "fields": { "ml": 250 } }, { "label": "500 ml", "fields": { "ml": 500 } } ],
    "available": true, "mode": "google",
    "note": "Saved to Google Health too. What you log in Google's own app cannot be read by other apps."
  }
}
```

**`metric`**: the Metric object of Browse plus `about` (one sentence: what it
is and where it comes from), `ownNote` (for `own` metrics: how this app
calculates it, to be shown on the page; `null` otherwise), `provides`,
`betterWhen` (`"higher"` | `"lower"` | `null`: colour a change only when not
null), `goal` (the person's target or `null`) with `goalPer` (`"day"` |
`"week"` | `null`), `decimals`, `format` (`"duration"` | `null`), `signed`.
Goals exist for `steps`, `active`, `sleep`, `water` (per day) and
`cardio_week` (per week).

**`range`**: what is shown and where the arrows go.

| range | `from` .. `to` | `chart.bucket` | the period before |
|---|---|---|---|
| `day` | `end` | `hour` when the day is drawn by the hour, else `day` | the day before |
| `week` | the 7 days ending `end` | `day` | the 7 days before |
| `month` | the 30 days ending `end` | `day` | the 30 days before |
| `6m` | 26 Monday weeks, the last containing `end` | `week` | the 26 weeks before |
| `year` | 12 calendar months, the last containing `end` | `month` | the 12 months before |

`cardio_week` is counted by the week, so its `week` is the **calendar** week
(Monday to Sunday) containing `end`, with `to` never after today.
For the previous period request `end=<prevEnd>`; for the next, `end=<nextEnd>`
(already clamped to today). `canPrev` is false once the period before lies
wholly before the first day this metric has anything; `canNext` is false when
the range already ends today. An `end` in the future is treated as today.

**`chart`**: `kind` is `bars` | `line` | `range` | `stack` | `log` | `hours`.
For `week`, `month`, `6m` and `year` it is fixed per metric (the kind the
metric's table row implies: `total` and `sleep` are `bars`; `state` and
`score` are `line`; `range` is `range`; `stack` is `stack`; `log` is `log`,
except `workouts` which is `bars` of minutes). For `day`:

- `steps` and `heart_rate`: `hours` with `bucket: "hour"`, one point per local
  hour that has started: `{ t, h, value }` (steps in that hour) or
  `{ t, h, value, lo, hi }` (average, lowest, highest bpm; hours without a
  reading are left out). Same data and same seven-day limit as `GET /api/day`.
  When the hours cannot be shown (older than a week, a device without them,
  Google not reachable) the chart falls back to the day's single value with
  `chart.note` saying why (`"The day by the hour is kept for the last week only"`).
- the kinds made of entries (`weight`, `body_fat`, `height`, `body_temp`,
  `glucose`, `water`, `food`, `mood`, `period`, `ovulation`, `symptoms`, `ecg`,
  `irn`, `workouts`): `log`, `bucket: "day"`, one point per entry of that day,
  oldest first: `{ t, value, text }`.
- everything else: its usual kind with one point (or none).

Points, oldest first, only buckets that have data (a gap is a missing point):

```
{ date, value, days,            // date = the day, or the first day of the week / month; days = days with data in the bucket
  lo?, hi?,                     // kind range (and weight): lowest and highest in the bucket
  parts?: { key: number|null }, // kind stack; also calories (active, basal) and food (protein, carbs, fat in grams)
  n?,                           // how many entries the bucket holds (kinds made of entries)
  goalHit? }                    // only when chart.goal is not null
```

How days become a week or a month: things that add up are **summed**
(`steps`, `distance`, `floors`, `altitude`, `active`, `cardio_week`, the
calories, `swim`, `workouts`, `zones`, `zone_calories`, `water`, `food`,
`symptoms`, `period` (days inside a period), `ovulation`, `irn`); states are
**averaged per day with data** (everything else, including `sedentary`,
`activity_levels` and `sleep_stages`: a week of nights is an average night);
`lo`/`hi` are the lowest and highest of the bucket.

`chart.stackKeys` is present when points carry `parts`:
`[{ key, label, tone, unit }]` in drawing order, for example sleep stages:

```json
{ "kind": "stack", "bucket": "day",
  "points": [ { "date": "2026-10-05", "value": 399, "days": 1, "parts": { "deep": 98, "rem": 67, "light": 212, "awake": 22 } } ],
  "band": null, "goal": null,
  "stackKeys": [ { "key": "deep", "label": "Deep", "tone": "high", "unit": "min" }, { "key": "rem", "label": "REM", "tone": "mid", "unit": "min" },
                 { "key": "light", "label": "Light", "tone": "low", "unit": "min" }, { "key": "awake", "label": "Awake", "tone": "muted", "unit": "min" } ],
  "note": null }
```

For `calories` and `food` the chart is `bars` and the parts are a breakdown to
draw inside or beside the bar (`food`'s parts are grams, not kcal, so they do
not add up to `value`).

`chart.band`: `{ lo, hi }`, the person's own 25th to 75th percentile of the
daily values over the 90 days before `to`, for metrics that are averaged and
are not stacks or logs; `null` under 10 such days, and always `null` for an
`hours` chart. `chart.goal`: the target line, only where it means something
for these buckets (a daily goal on daily buckets; `cardio_week`'s weekly
target on weekly buckets, i.e. `6m`); otherwise `null`, while `metric.goal`
still carries the number.

A range and an hours chart:

```json
{ "kind": "range", "bucket": "day", "points": [ { "date": "2026-09-12", "value": 96.7, "days": 1, "lo": 95.1, "hi": 98.1 } ],
  "band": { "lo": 95.9, "hi": 96.7 }, "goal": null, "note": null }
{ "kind": "hours", "bucket": "hour", "points": [ { "t": 1791694800000, "h": 8, "value": 72, "lo": 65, "hi": 81 }, { "t": 1791698400000, "h": 9, "value": 73, "lo": 65, "hi": 81 } ],
  "band": null, "goal": null, "note": null }
```

**`stats`** are always **per day** over `from`..`to`, whatever the buckets:
`avg` (of the days with data; for running totals that come from the device,
today is left out of the average while it is not over, but not out of
`total`), `min` and `max` as `{ value, date }` (for `range` metrics the lowest
`lo` and highest `hi`), `latest` `{ value, date }`, `total` (the sum for
metrics that add up, else `null`), `count` (days with data), `entries` (how
many entries, for the kinds made of entries, else `null`). Without data:
`avg`, `min`, `max`, `latest`, `total` are `null` and `count` is 0.

**`prev`**: the same over the period before: `{ avg, total, count, entries,
deltaAbs, deltaPct }` (this period's `avg` minus that one's, and as a
percentage of it; `deltaPct` is `null` when the earlier average is 0).
`null` when the period before has nothing.

**`reading`**: one plain sentence, ready to show. Real ones from the demo:

```
7,085 steps so far, 915 steps short of your goal of 8,000 steps.
Goal met on 4 of 7 days, 16% below the week before.
Goal met on 4 of 30 nights, 3% below the month before, inside your usual range.
2% above the month before, inside your usual range.
174 min of your 180 min target so far this week, 129 min in the week before.
0.04 °C below the week before, inside your usual range.
3 periods started in these six months.
17 workouts in this month, 17 in the month before.
Not enough days yet.
Nothing recorded on this day.
```

"Not enough days yet." is said under 3 days of data in a week, 7 in a month,
14 in six months and 30 in a year.

**`entries`**: newest first, **50 per page**, starting at the end of the range
and going back through the whole history (not only the range: `inRange` says
whether an entry's day is inside it). `more: true` means there are older ones:
ask again with `before=<t of the last entry>`.

```
{ id, kind, metric, t, end, date, text, value, unit,
  source,            // 'app' (made here) | 'google' (read from Google Health) | 'calculated' (an `own` metric)
  device,            // the source device's name where known, else null
  editable, deletable,
  google,            // 'saved' | 'local' | 'failed' | 'pending' | 'create_only' for an entry made here, else null
  error,             // why the last try at Google failed, or null
  fields,            // what an edit form is filled with: the same names POST /api/entries takes
  details?,          // daily metrics only: [{ label, value, unit }] of what else that day holds
  inRange }
```

- A metric of daily numbers (steps, resting heart rate, a score...) lists its
  **days** as entries: `id` `d-<metric>-<date>`, `kind: "day"`, `t` the local
  midnight of the day, `fields: {}`, never editable. `details` carries the
  rest of that day (a night's bedtime, wake, time in bed; the parts of a
  stack; a range's lowest and highest; HRV in deep sleep...).
  A `sleep_score` day also carries `parts`: what the score was made of, as
  `[{ id, label, points, max, text }]` (`duration` 50, `stages` 20,
  `continuity` 15, `regularity` 15; a part that could not be worked out is
  absent, and the score is the points as a share of the `max` that is there).
  `text` is one line in metric units, e.g. `"7h 25m asleep, at your goal of 7h 30m"`.

  ```json
  { "id": "d-sleep-2026-10-11", "kind": "day", "metric": "sleep", "t": 1791666000000, "end": null, "date": "2026-10-11", "text": "7h 25m", "value": 445, "unit": "min",
    "editable": false, "deletable": false, "google": null, "error": null, "source": "google", "device": "Fitbit Air", "fields": {},
    "details": [ { "label": "Bedtime", "value": "23:34", "unit": null }, { "label": "Woke", "value": "07:06", "unit": null },
                 { "label": "In bed", "value": 452, "unit": "min" }, { "label": "Awake", "value": 7, "unit": "min" } ], "inRange": true }
  ```
- The logged kinds list their rows: `id` is what `PATCH` and `DELETE
  /api/entries/<id>` take. Only an entry made here (`source: "app"`) is
  `editable` (and only while its group is on) and `deletable`. A reading
  Google holds from a device or another app is shown and cannot be changed.
- `weight` lists weigh-ins (`id` `w-<t>`, `fields: { at, kg, note }`),
  **never editable or deletable**: a weigh-in logged here is written to
  Google Health and its Google name is not kept, so this app cannot change or
  remove Google's copy, and says so in `add.note` instead of pretending.
- `workouts` lists sessions; `id` is the workout id of `/api/workouts/<id>`
  (`fields: { workoutId, type }`). Edit them on the Workouts page.

**`add`**: `null` when the metric cannot be logged here. Otherwise the form:

- `kind` and `route`: POST `{ kind, ...fields }` to `/api/entries`, except
  `weight`, whose `route` is `/api/weight` and takes `{ kg, at?, note? }`
  (unchanged, see above).
- `fields`: `[{ id, label, type, required, unit?, min?, max?, step?, options?, maxLength?, maxAgeDays?, maxDays? }]`.
  `type`: `number` | `text` | `select` (one of `options`) | `multi` (several
  of `options`, between `min` and `max` of them) | `datetime` (ms since the
  epoch; omitted = now; not in the future; at most `maxAgeDays` back) | `date`
  (`YYYY-MM-DD`). `options` are `[{ id, label }]`; send the `id`. Units are
  metric: convert from the person's units before sending.
- `quick`: one-tap presets, `[{ label, fields }]`, or `null` (only water has
  them: 250 ml and 500 ml).
- `available`: `false` means the form cannot be used right now and `note` says
  why (the metric's group is off; weight without Google).
- `mode`: `"google"` (the entry is saved to Google Health too), `"local"`
  (kept on this site only) or `"off"`.
- `note`: the sentence to show under the form. The ones there are:
  `"Saved to Google Health too."`,
  `"Saved to Google Health too. What you log in Google's own app cannot be read by other apps."`,
  `"Kept on this site only: Google Health is not connected."`,
  `"Kept on this site only: Google Health has not been given this permission."`,
  `"Switch on <group> to log this."`, and for weight
  `"Saved to Google Health too. A weigh-in is kept there, not here, so it cannot be changed or removed from this page: do that in the Google Health app."`,
  `"Connect Google Health to log your weight: weigh-ins are kept there."`,
  `"Reconnect Google Health and allow saving your weight to log a weigh-in here."`.

The forms, by kind (limits are the server's own; a value outside them is a 400
`bad_entry` with a sentence):

| kind | fields |
|---|---|
| `water` | `ml` 1-5000 |
| `food` | `name` (text, 120), `meal` BREAKFAST \| LUNCH \| DINNER \| SNACK, `kcal` 0-10000, optional `protein`, `carbs`, `fat` 0-1000 g |
| `mood` | `moods` (1-10 of 68 choices), optional `valence` UNPLEASANT \| BASELINE \| PLEASANT, optional `note` (500) |
| `symptom` | `symptoms` (1-20 of 64 choices), optional `note` (500) |
| `glucose` | `mgdl` 10-900, optional `timing`, `meal`, `note` (200) |
| `bodytemp` | `celsius` 30-45, optional `location` |
| `height` | `cm` 50-272 |
| `bodyfat` | `pct` 2-75 |
| `period` | `start` (date), optional `end` (date, at most 31 days), optional `note` (200); no `at` |
| `ovulation` | `result` NEGATIVE \| LUTEINIZING_HORMONE_SURGE \| ESTROGEN_SURGE \| POSITIVE \| INDETERMINATE |
| `weight` | `kg` 20-400, optional `at` (at most 30 days back), `note` (200); own route |

All but `period` also take `at`.

### `POST /api/entries`

Log one entry. Body `{ "kind": "water", "ml": 250 }` (plus `at` and the other
fields of the kind's form). At most 120 a minute.

```json
{ "entry": { "id": "l-13a5a03a-5993-4a1f-aed3-0b4d8eb0c7b1", "kind": "water", "metric": "water", "t": 1791718673000, "end": null, "date": "2026-10-11",
             "text": "250 ml", "value": 250, "unit": "ml", "source": "app", "device": null, "editable": true, "deletable": true,
             "google": "saved", "error": null, "fields": { "at": 1791718673000, "ml": 250 } },
  "google": "saved", "message": null }
```

`entry` is an entry exactly as the metric page lists it (without `inRange`).
`google` is what became of it at Google Health, and `message` is a sentence to
show when it is not simply saved:

| `google` | meaning | `message` |
|---|---|---|
| `saved` | written to Google Health; later edits and deletes go there too | `null` |
| `local` | kept on this site only: Google is not connected, or was never given this permission. It is sent by itself if that changes | `"Kept on this site only: Google Health is not connected."` or `"…has not been given this permission."` |
| `failed` | kept here; Google could not be reached or refused. Tried again at each sync (six times) | `"Saved here. Google Health did not take it (<why>); it will be tried again at the next sync."` |
| `create_only` | Google took it but gave it no name: later changes stay on this site | `"Saved to Google Health, which gave the entry no name: later changes stay on this site, and the copy in Google Health has to be changed there."` |

The entry is stored before Google is asked, so nothing typed is lost to a
timeout, and it counts in every total at once whatever `google` says.

| status | code | when |
|---|---|---|
| 400 | `bad_kind` | `kind` is not one of the ten (weight is not: it has its own route) |
| 400 | `bad_entry` | a field is missing or out of range; `error` says which, e.g. `"The amount must be between 1 and 5000 ml."` |
| 409 | `group_off` | the kind's group is not switched on, e.g. `"Switch on water tracking first."` |

After any change to entries the server recomputes `caps` and sends the
`changed` event with `["data"]`. Nothing an entry holds is ever published.

### `PATCH /api/entries/<id>`

Change an entry made here. The body names only the fields that change
(`{ "ml": 300 }`); the rest stay. The kind cannot be changed. Same reply as
POST. A saved entry is patched at Google Health; one Google could not be told
about answers `google: "failed"` and is retried at the next sync.
404 `not_found` (no such entry, or somebody else's), 403 `read_only` (it came
from Google Health: `"This came from Google Health and can only be changed there."`),
409 `group_off`, 400 `bad_entry`.

### `DELETE /api/entries/<id>`

Remove an entry made here: `{ "ok": true, "google": "saved", "message": null }`.
`google`: `saved` (removed from Google Health too), `local` (it had never
reached Google), `failed` (removed here; `message` is `"Removed here. It will
be removed from Google Health when that can be reached."`), `create_only`
(`"Removed here. The copy in Google Health has to be removed there."`).
Allowed while the entry's group is off: it is the person's own. 404, 403
`read_only` as above.

What can be changed at Google, by kind, as the code handles it:

| kind | at Google |
|---|---|
| `water`, `food`, `mood`, `symptom`, `period`, `ovulation`, `glucose`, `bodytemp`, `height`, `bodyfat` | created with a name this app proposes, so edits are patched and deletes are sent; an entry Google leaves nameless becomes `create_only` |
| `mood`, `symptom`, `period`, `ovulation` | write-only at Google: mirrored out, and the copy here is the only one that can ever be shown. A mood's or symptom's `note` stays on this site (Google has no field for it) |
| `weight` | created only; never editable or deletable from here |
| `ecg`, `irn`, and any reading that came from a device | read-only |

### `POST /api/pins`

Body `{ "id": "sleep_score", "on": true }`. Reply `{ "pinned": ["vo2max", "water", "resp", "weight", "sleep_score"] }`
(the ids in the order they were pinned; pinning one again moves it to the end).
At most **8**: a ninth is 400 `too_many` (`"At most 8 metrics can be pinned.
Unpin one first."`). 400 `bad_metric` (`"That is not a metric."`) for an id that
is not in the table above; 400 `bad_request` when `on` is not a boolean.
Any metric can be pinned, including one without data or with its group off;
`brief.extra.pinned` only carries the ones that have something to show.

### `POST /api/google/groups`

Switch an optional group on or off. Body `{ "group": "nutrition", "on": true }`,
with `"local": true` or `"purge": true` where described below. Reply:

```json
{ "group": { "id": "nutrition", "label": "Nutrition and water", "about": "Log water and food here. Each entry is saved to Google Health too.",
             "scopes": ["nutrition.writeonly"], "chosen": true, "granted": false, "usable": false, "readOnly": false,
             "note": "What you log here is saved to Google Health too. What you log in Google's own app cannot be read by other apps.",
             "mode": "local", "canLog": true, "kinds": ["water", "food"], "start": "/auth/google/start?groups=nutrition" },
  "groups": [ "…all five, as in /api/me…" ],
  "purged": 0 }
```

**GroupsView** (also `me.google.groups` and `browse.groups`), per group:
`{ id, label, about, scopes, chosen, granted, usable, readOnly, note, mode, canLog, kinds, start }`.
`mode` is the one field a page needs:

| `mode` | means |
|---|---|
| `off` | not switched on. Its metrics do not exist for this person (409 `group_off`), its kinds cannot be logged |
| `google` | on, and Google holds the permission: entries are saved to Google Health too (for `ecg`: readings are read from it) |
| `local` | on, but Google is not connected or was not given the permission: entries are **kept on this site only**, and are sent to Google by themselves if the permission is granted later |

`chosen` is the person's switch, `granted` is Google's, `usable` is both
(`mode === "google"`). `canLog` is `chosen` and not `readOnly`. `kinds` are the
entry kinds of the group. `start` is where to send the browser (a navigation,
with `&return=/some/path`) to ask Google for the group.

Switching **on**:

| situation | reply |
|---|---|
| Google already holds the group's permission | 200, `mode: "google"` |
| Google is **not connected**, a group that can be logged in (all but `ecg`) | 200, `mode: "local"`: a new account can log water, food, moods, symptoms and a cycle without ever connecting Google |
| Google is connected but was never asked for this group | **409 `needs_scope`**, `detail: { "start": "/auth/google/start?groups=nutrition", "group": "nutrition", "canLocal": true }`, nothing switched on. Either navigate to `detail.start` (the callback switches the group on), or post again with `"local": true` to switch it on in local mode |
| `ecg` without the permission | 409 `needs_scope` (connected) or 409 `needs_google` (not connected), `detail.canLocal: false`: readings only ever come from Google |

```json
{ "error": "Google Health has not been asked for nutrition and water yet. Allow it there, or keep what you log on this site only.",
  "code": "needs_scope", "detail": { "start": "/auth/google/start?groups=nutrition", "group": "nutrition", "canLocal": true } }
```

Note that `start` is inside `detail`, like every other error's extra context.

Switching **off** (`"on": false`) takes effect here at once, whatever Google
still holds: the group's streams are skipped, its entries refused, its metrics
gone from Browse, Today and pins, and it is no longer read for summaries. The
rows are **kept** (switch it on again and they are back) unless
`"purge": true`, which deletes every local row of the group's kinds for good
(`purged` is how many) and leaves Google's copies alone. To withdraw the
permission at Google too: disconnect and connect again (a reconnect asks only
for the groups still switched on).

400 `bad_group` for an unknown `group`; 400 `bad_request` when `on` is not a
boolean.

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

## Other sources and the Log sheet

Server modules: `server/hevysync.js` (+ `hevyapi.js`), `server/strava.js`,
`server/food.js`, `server/loghub.js`. Both links sync on the person's own
20-minute clock (with Google or without it); `GET /api/me` says
`hevy: { connected }`, `strava: { configured, connected }` and `xiaomi: { connected }`.

### `GET /api/log`

Everything the Log sheet shows, in one reply:

```json
{
  "today": { "date": "2026-10-29", "water": { "ml": 1500, "goal": 2500 },
             "food": { "kcal": 1150, "protein": 52, "carbs": 134, "fat": 41, "items": 4 },
             "weight": { "kg": 77.2, "at": 1792900000000 } },
  "kinds": [ { "id": "water", "label": "Water", "group": "Eat and drink", "metric": "water", "icon": "water_drop",
               "available": true, "mode": "google" | "local" | "off", "note": "…", "needs": null | "<group id>",
               "last": { "text": "500 ml", "at": 1792900000000 } }, … ],
  "recent": [ { "id": "l-…", "kind": "food", "metric": "food", "text": "…", "t": 0, "editable": true, "deletable": true, "google": "saved", "fields": {} } ],
  "hevy": true, "routines": [ { "id": "hr-1", "title": "Push day", "folder": "Main", "exercises": 3, "sets": 7 } ],
  "tzOffsetMin": 180
}
```

`kinds` order: workout, water, food, weight, bodyfat, measure, height, sleep,
mood, glucose, bodytemp, symptom, period, ovulation. `workout` carries
`running: { id, start }` instead of a form. A kind's form is its metric's
`add` (`GET /api/metric/<id>`).

### `GET /api/food/search?q=greek&online=1`

`{ q, mine: [...], common: [...], found: [...], note, source }`. `mine` is the
person's own foods (by name, most logged first, `portion` = the numbers they
used, `times`); `common` a built-in list of plain foods (`per100`, `serving
{ g, label }`); `found` Open Food Facts products (`per100`, `serving`, `brand`,
`code`). An empty `q` gives recent own foods only and calls nothing outside.
At most 30 searches a minute per person; when Open Food Facts cannot be
reached `found` is `[]` and `note` says so.

### `GET /api/food/barcode/<8-14 digits>`

`{ food }`, or 404 when the product is not in Open Food Facts.

### `GET /api/exercises/pick?q=bench&limit=40` · `GET /api/exercises/last?name=…`

The picker: the Hevy library (`templateId`, `muscle`, `equipment`, `type`,
`custom`) and names logged before (`group`, `lastAt`, `best { kg, reps }`), done
before first. `last` is the sets of the last time an exercise was done.

### Hevy

- `GET /api/hevy` — `{ connected, keySet, last4, user, connectedAt, lastSync, lastError, first, counts: { templates, workouts, routines }, settings }`.
  Never the key.
- `POST /api/hevy/connect` `{ key }` — checked against Hevy (`/v1/user/info`), sealed (AES-GCM) in the
  `secret` table, then a first sync starts. 400 `bad_key`, 409 `hevy_pro` (the API needs Hevy Pro), 502.
  A different Hevy account than before starts the history read again.
- `PATCH /api/hevy/settings` — any of `toGoogle`, `pushWorkouts`, `pullMeasures`, `pushMeasures` (booleans, all
  on by default).
- `POST /api/hevy/sync` (at most every 30 s) — `{ result, hevy }`; `result` counts `added`, `merged`, `updated`,
  `deleted`, `pushed`, `measuresIn`, `measuresOut`.
- `POST /api/hevy/disconnect` `{ keepData }` — the key is deleted; what came from Hevy stays.
- `POST /api/hevy/templates` `{ title, muscle?, equipment?, type? }` — a custom exercise in the person's Hevy
  library. `{ exercise }`.
- `GET /api/hevy/routines`, `GET /api/hevy/routines/<id>` — routines as `{ id, title, folder, exercises: [{ name,
  templateId, sets: [{ type, kg, reps, repRange }] }] }`.
- `POST /api/hevy/routines` `{ workoutId, title }` — a routine made from a workout's library exercises.

What the sync does (`hevysync.js` has the detail): the library; every workout once, then
`/v1/workouts/events` (updates and deletes); a Hevy workout overlapping one held here by half or more (or the
same start and title as a Hevy CSV import) attaches its sets to it; a new one is a workout with `source:
"hevy"`, saved to Google after 30 minutes only if Google still has nothing for that time. Strength workouts
logged here after linking, with library exercises, are created in Hevy and their edits follow (`PUT`). Body
measurements by day both ways: Hevy fills days with no weigh-in or body fat here; this site's days are sent
whole (Hevy's `PUT` replaces a day).

Exercises in a workout (`/api/workouts/log`, `PUT …/sets`) may carry `templateId` (a Hevy template id).
Workouts accept any of Google's exercise types (`type`), not only the strength ones.

### Strava

- `GET /auth/strava/start?return=/settings/connections` → Strava's consent (scopes `read,activity:read_all,
  activity:write`), state bound to the session; `GET /auth/strava/callback` → back with `?strava=connected |
  cancelled | error&message=`. A grant without `activity:read` is refused.
- `GET /api/strava` — `{ configured, connected, athlete { id, name, city }, connectedAt, lastSync, lastError,
  count, settings { toGoogle, toStrava }, scope, usage }`.
- `PATCH /api/strava/settings`, `POST /api/strava/sync` (at most every minute), `POST /api/strava/disconnect`
  (gives the grant back to Strava).
- `GET /api/strava/webhook` (Strava's check: echoes `hub.challenge` for the right `hub.verify_token`) and
  `POST /api/strava/webhook` (events; no cookie, no Origin; answered at once). Activity create/update/delete
  are applied for that athlete; `updates.authorized: "false"` disconnects. The subscription is made at start-up
  when `STRAVA_VERIFY_TOKEN` is set, or by `POST /api/admin/strava/webhook`.

A workout's detail carries `strava` (distance, moving time, elevation, heart rate, speed, power, calories,
device, id) and `route` (`{ w, h, points: [[x, y], …] }` in a unit box, drawn without map tiles), and `hevy`
(`{ id, title, routineId, missing, sent }`).

### The exercise library

- `GET /api/library?q=&group=&muscle=&equipment=&limit=40&offset=0` — `{ total, exercises: [{ id, name, group, type,
  equipment, level, mechanic, force, category, primary, secondary, images }], size, groups, muscles, equipment, source }`.
  876 exercises from free-exercise-db (public domain). Words match in any order ("incline db press"); with no `q`,
  everyday lifts first. `type`: `weight_reps` | `bodyweight_reps` | `duration` | `distance_duration`.
- `GET /api/library/<id>` — `{ exercise (with steps), last (your last sets of it), history [{ workoutId, t, topKg, reps,
  volume, sets }] }`.
- `GET /api/media/exercises/<id>/<0|1>.jpg` — its photo (start, end), fetched from the project once and kept on disk.
- `GET /api/exercises/pick` also returns library exercises after yours and Hevy's (`source: "yours" | "hevy" |
  "library"`, `libId`, `image`), and takes `group` and `equipment`.

### Routines

A routine: `{ id ("r-…"), title, folder, notes, position, exercises: [{ name, libId, templateId, muscle, type, notes,
restS, supersetId, sets: [{ type, kg, reps, repsMax, durationS, distanceM }] }], created, updated, lastUsed, uses, from }`.
`repsMax` makes `reps` a range ("8 to 12"). Kept in the person's own store (table `routine`).

- `GET /api/routines` — `{ routines (summaries: exercises, sets, estimateMin, names, muscles, lastUsed), folders, hevy
  (Hevy routines, `copied`), starters (ready-made programmes) }`.
- `POST /api/routines` (create), `GET|PUT|PATCH|DELETE /api/routines/<id>`, `POST /api/routines/<id>/duplicate` —
  each returns `{ routine (exercises with `image` and `last`), summary, history (workouts done with it) }`.
- `POST /api/routines/starter { id: ppl | upperlower | fullbody }` — the programme's routines, in a folder of its name.
- `POST /api/routines/from-workout { workoutId, title?, folder? }`, `POST /api/routines/from-hevy { id }`.
- `POST /api/routines/<id>/from-workout { workoutId }` — the routine becomes what was done (rest and notes stay).
- `PATCH /api/routines/folders { from, to }` (rename; `to: null` empties it), `POST /api/routines/order { ids }`.

### A workout logged set by set

- `POST /api/workouts/start { routineId? , log? , at? }` — `routineId` starts it from a routine (its sets filled in,
  where a weight is open from last time); `log: true` an empty one. The reply has `started` (its id). The workout
  carries `routineId` and `logging: true`; its detail has `draft { routineId, routineTitle, exercises (sets with
  `done`, each exercise with `image` and `previous`, last time's sets), restUntil }`.
- `PUT /api/workouts/<id>/draft { exercises, restUntil? }` — saved as it goes.
- `POST /api/workouts/<id>/end { keep: "done" | "all" }` (also `save`) — the ticked sets (or every filled-in one)
  become the workout's sets, once the end itself is accepted.
- `POST /api/workouts/<id>/routine { routineId | null, fill? }` — which routine it was; `fill` puts the routine's
  sets in when it has none.
- A detail also has `routine { id, title, exists }`, `differences` (from the routine, in words), and `summary {
  volumeKg, sets, reps, records, exercises, muscles [{ muscle, sets }], best [{ name, libId, kg, reps, e1rm, pr }],
  last }` (the same routine the time before). Each exercise has `libId` and `image`.

### Routes

- `POST /api/workouts/record { type, points: [[t, lat, lng, alt?, accuracy?]], pauses: [[from, to]], start, end,
  title? }` — a route recorded in the page (GPS). `type`: RUNNING, WALKING, HIKING, BIKING, MOUNTAIN_BIKE,
  ROLLERBLADING, SKIING, ROWING, SWIMMING_OPEN_WATER. Fixes worse than 60 m and impossible jumps are dropped.
  Returns `{ id, stats }`; the workout has `source: "recorded"` and `gps { distanceM, movingS, paceSPerKm,
  avgSpeedKmh }`, and goes to Google with its distance and pace.
- `POST /api/workouts/import/gpx` (the file as the body, up to 8 MB; up to ten years old) — `source: "gpx"`.
- `GET /api/workouts/<id>/route.gpx` — the route as GPX 1.1 (a pause ends a segment).
- A detail with a route has `track { distanceM, movingS, elapsedS, avgSpeedKmh, maxSpeedKmh, paceSPerKm, elevGainM,
  elevLossM, elevMinM, elevMaxM, splits [{ n, distanceM, movingS, paceSPerKm, speedKmh, elevM, partial }], efforts
  [{ label, distanceM, timeS }], series [[m, alt, kmh, s]], line [[lat, lng]], bounds }`.
- `GET /api/tiles/<z>/<x>/<y>.png` — an OpenStreetMap tile (zoom 2 to 18), fetched once and kept 30 days.

### Xiaomi scale

- `GET /api/xiaomi` — `{ connected, account ("…431"), region, profile, profiles [{ id, name, owner, n, lastAt, lastKg }], connectedAt,
  lastSync, lastError, lost, count, last { t, weightKg, fatPct, … }, settings { toGoogle }, pending }`. `pending` is the
  QR sign-in: `{ state: waiting | linked | expired | error | cancelled, qr (data: URL, while waiting), loginUrl, expiresAt,
  message }`.
- `POST /api/xiaomi/start` — a new code (Xiaomi's, proxied as a data URL); the server waits on Xiaomi's long poll and
  connects when it is scanned (SSE `changed: me`). `POST /api/xiaomi/cancel`.
- `POST /api/xiaomi/profile { profile }` — which of the scale's people is you; writes their weigh-ins. Needed when the
  scale has more than one.
- `PATCH /api/xiaomi/settings`, `POST /api/xiaomi/sync` (at most every 30 s), `POST /api/xiaomi/disconnect { keepData }`.

`/api/me` carries `xiaomi: { connected }`. Weigh-ins land as weights with `source: "scale"`, body-fat entries with
`source: "scale"`, and `bodycomp` entries (metric `body_composition`) with `details`.

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
| `GET /api/export` | – | one JSON file (`content-disposition: attachment; filename="health-<username>-<date>.json"`): profile, settings, every daily metric (the app's own `sleep_score` and `cardio_min` among them), sleep, weight, exercises, workouts with sets, summaries, public rows, records, and since 2026-10-11 `samples` (every logged entry and single reading of every kind, as `{ id, kind, t, end, date, value, text, data, source, device, google }`, without deleted ones and without sync bookkeeping), `groups`, `aiShare`, `pins`, and the new `goals`. No tokens, no keys |
| `POST /api/google/disconnect` | – | revokes the grant at Google, keeps the history, entries included. Groups that were on stay on and become `mode: "local"`: logging goes on, kept on this site. Returns `/api/me` |
| `POST /api/google/groups` | `{ group, on, local?, purge? }` | switch an optional group; see **Every metric** |
| `POST /api/account/delete-data` | `{ "confirm": "<your username>" }` | removes the person's folder (database with every entry and reading, pins, groups, Google token) and every global row (profile, public rows, records, push devices, link keys, saved key). Revokes the Google grant first. The ojee.net account and session stay. Returns `{ "ok": true }`; `/api/me` then shows a fresh profile at onboarding step `profile` (or `profile: null` if registration is closed) |

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
| `demo` | `demo` | Fitbit Air with everything: all 41 metrics. All five optional groups on with three weeks of entries; pins `vo2max`, `water`, `resp`, `weight`; cardio target 180, water target 2500; Hevy workouts imported (attached to the sessions the watch logged); detection on, one detected workout waiting for review |
| `mira` | `demo` | Pixel Watch: no skin temperature, no body fat, no swim, no glucose or thermometer; runner; groups nutrition and mindfulness on (water, food, mood) |
| `sam` | `demo` | phone only: steps and distance, nothing else; no groups. Browse is two metrics and 39 "no data yet" rows, and `brief.extra` is all `null` |
| `noor` | `demo` | Garmin: no HRV, no SpO2, sleep without stages; floors and active energy but no VO2 max, breathing rate or zones; cardio from active minutes, recovery from resting heart rate alone, a sleep score without a stages part |
| `kai` | `demo` | Fitbit; **private account** (absent from leaderboards, profile 404s for others) |
| `lena` | `demo` | Apple Watch via Apple Health; sleep and heart public; VO2 max and breathing rate but no zones or activity levels; cycle group on (three periods, an ovulation test) |
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

- 2026-10-11: all the data. Added `GET /api/browse`, `GET /api/metric/<id>` (41 metric ids, five ranges, entries paged by `before`), `POST /api/entries`, `PATCH` and `DELETE /api/entries/<id>`, `POST /api/pins`, `POST /api/google/groups`. `GET /api/brief` gains `extra` (`cardio`, `sleepScore`, `calories`, `floors`, `vitals`, `recovery`, `water`, `food`, `pinned`). `/api/me` gains `aiShare`, `pins`, `goals.cardioWeek`, `goals.waterMl`, and each `google.groups[]` entry gains `mode`, `canLog`, `kinds`, `start`. `PATCH /api/settings` accepts `goals.cardioWeek`, `goals.waterMl` and `aiShare`. The export gains `samples`, `groups`, `aiShare`, `pins`. New error codes: `group_off`, `bad_entry`, `bad_kind`, `bad_metric`, `too_many`, `bad_group`, `read_only`. The summary's numbers gain the breathing rate, VO2 max, cardio minutes and the sleep score, and what was logged in a group only when `aiShare` allows it. Nothing that was there changed shape, and nothing new is public: `/api/users`, `/api/leaderboard`, `/api/compare`, `/api/people` and `/api/admin` are unchanged.

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
