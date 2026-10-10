# Frontend notes

Written by the frontend build. The contract is `docs/API.md`; nothing here
changes it. This file records how `web/` is put together, and what the
frontend would like from the backend one day.

## Layout of `web/`

```
index.html              shell; no inline script or handler (strict CSP)
manifest.webmanifest    PWA manifest
sw.js                   service worker: offline shell, push, update prompt
css/app.css             the one stylesheet (tokens, components, screens)
js/theme.js             classic script in <head>: applies the saved theme before paint
js/main.js              boot, history routing, shell, pull to refresh, SSE, update prompt
js/app.js               shared state (/api/me), navigation, the SSE event bus
js/api.js               fetch wrapper; throws ApiError with the server's sentence
js/ui.js                templating (escaped by default), sheets, toasts, skeletons, forms
js/icons.js             the inline SVG icon set
js/format.js            units, durations, dates in the person's time zone
js/charts.js            hand-drawn SVG charts (bars, lines, sleep, HR trace, ring, heat-map)
js/pwa.js               install state, service worker registration, Web Push
js/live.js              live heart rate: the store, the Web Bluetooth client, posting, wake lock (no DOM)
js/views/*.js           one module per screen, loaded on demand
js/views/liveui.js      live heart rate on screen: Today's tile, the control, the workout number, the help sheet
```

## Live heart rate

`js/live.js` is started by `main.js` once somebody is signed in and lives
outside every screen, so navigation never touches the Bluetooth connection.
It holds one store (`get()`, `subscribe()`) fed from two places: this
browser's own sensor (Web Bluetooth, Heart Rate Service) and the `live` event
on `/api/events` (another device posting, such as Ojee Pulse). While this
browser's sensor is delivering it is the source and the server's echo is
ignored. Readings read here are posted to `/api/live/hr` about once a second,
from the notification itself rather than a timer (timers are throttled in a
background tab); up to 20 wait across a network drop.

Staying connected: the sensor's id and name, and the intent to stay connected,
are kept in `localStorage` (`health.live.device`, `health.live.want`; the
wake-lock switch is `health.live.awake`). On load, with the intent set, the
sensor is looked up in `navigator.bluetooth.getDevices()`, watched with
`watchAdvertisements()` where that exists, and connected as soon as it is seen;
where the browser cannot do that the control shows one "Reconnect" button. A
drop is retried after 1 s, 2 s, 5 s, then every 10 to 15 s without end, and at
once when the tab becomes visible, the network returns, or the page comes back
from the back/forward cache. "Connected" with no notification for 15 s is torn
down and made again. Only Disconnect clears the intent; the sensor stays
remembered.

On screen nothing moves when a reading starts or stops: the heart tile lays
its synced and its live version in the same grid cell (one invisible), the
control reserves room for its longest state, and the workout card always has
the slot beside the timer.

Routes: `/` (landing or Today), `/signin`, `/register`, `/welcome[/<step>]`,
`/trends[/sleep|activity|heart|body]`, `/workouts`, `/workouts/<id>`,
`/workouts/import`, `/workouts/detection`, `/summary`, `/ranks`,
`/compare[?with=<username>]`, `/u/<username>`, `/settings[/<section>]`
(sections: `account`, `connections`, `privacy`, `notifications`, `goals`,
`data`, `admin`). The "Me" tab is `/settings`.

Google is started with `return=/welcome/google` (onboarding), `return=/`
(Today banner), `return=/workouts`, `return=/workouts/<id>`,
`return=/trends/body` and `return=/settings/connections`; each of those
screens reads `?google=…`, shows it, and removes it from the address.

## Design

Accent `#b6f23c` (the icon's lime) on the dark theme. On the light theme the
same hue is carried deeper so it still reads: `#44700a` for text and buttons
(5.9:1 on white), `#5f8f0e` for chart marks (3.5:1 on the page ground).
Semantic colours (`--ok`, `--warn`, `--bad`) are separate and always come
with an icon or a word. Tokens are at the top of `css/app.css`; the dark
block appears twice (system preference and manual override) and the two must
stay identical.

`scripts/make-icons.py` regenerates the icon set from `docs/heart-rate.svg`;
its `FG` and the dark `--accent` are the same value.

## Service worker

`VERSION` in `sw.js` names the cache. Static files are network-first (the
server's ETags make that a 304), with the cache as the offline fallback, so a
deploy needs no cache-busting. Bump `VERSION` when a file is added to or
removed from `SHELL`. `/api/` and `/auth/` are never touched by the worker.

## Frontend requests

Things that would make the frontend simpler or better. None is blocking; the
current build works with the contract as it is.

1. **Workout objects in `/api/data`.** Today shows the running workout and the
   waiting questions, but `/api/data` and `/api/me` only carry counts
   (`workout: { running, pending }`). Today therefore also calls
   `GET /api/workouts?limit=1` whenever a count is non-zero. Including
   `running` and `pending` (the workout objects) in `/api/data` would save
   the second request.
2. **A light way to read detection and exercise types.** The workout detail
   and the detection screen call `GET /api/workouts?limit=1` only to get
   `detection`, `exerciseType`, `exerciseTypes` and `canWrite`. A small
   `GET /api/workouts/settings` would do.
3. **Password change.** Settings → Account says the username and password
   belong to the ojee.net account and cannot be changed here, because there
   is no route for it. If mtg grows one, link to it.
4. **Device name per push device.** The frontend sends `label` from the user
   agent ("iPhone", "Android phone", "Mac"…). Two iPhones look the same in
   the list. Letting `PATCH /api/push/devices/:id` rename is already in the
   contract; the UI does not offer it yet.
5. **`previous` label for trends.** `trend` on the leaderboard is described in
   words by the frontend ("vs last week"); a `previousLabel` field would keep
   that wording in one place.
6. **Sleep stages per night beyond 30 days.** `/api/trends?days=90` leaves
   `stages` empty, so the bedtime chart draws plain blocks for the 14 nights
   it shows when the range is 90 days. Filling `stages` for the latest 14
   nights at any range would keep the chart the same across ranges.
7. **`web/dev/` is served like any other static file.** `web/dev/serve.mjs`
   is a fixtures server for UI work without the backend
   (`node web/dev/serve.mjs`, port 5021; `PERSONA=sam` or `PERSONA=new`). The
   app never loads it, but the static handler will hand it out at
   `/dev/serve.mjs`. It holds no secrets; excluding `web/dev/` in
   `deploy.sh` (or the static handler) would be tidier.

## What was checked

With agent-browser against the real demo backend (`HEALTH_DEMO=1`, a private
copy on port 5030), signed in as `demo`, `sam` (phone only), `ojee` (admin),
a freshly registered account, and signed out:

- Every route at 360, 390 and 1440 px: no horizontal overflow, no console
  errors, no CSP violations; axe-core reports no violations on Today, Trends,
  Workouts, Ranks and Notifications.
- Flows: sign in (wrong and right password), register, all six onboarding
  steps including the stand-in Google connect, save / adjust / dismiss a
  waiting workout, start and discard a running one, log a past one (the
  server's overlap error shows in the sheet), Hevy dry run and import, add
  weight, write a summary, goals and units, privacy toggles and preview, the
  OpenCode key test, making a link key, notification type switches, delete
  my health data, the admin page, a private profile's 404, a public profile
  signed out, the service worker's offline shell, and a live `notify` event.

Not exercised for real: Web Push delivery (headless Chrome grants no
notification permission), the Android install prompt and iOS Home Screen
paths (state detection only), the update-available prompt (needs two
deploys), and Google's real consent screen and error returns.
