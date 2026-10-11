# Frontend notes

Written by the frontend build. The contract is `docs/API.md`; nothing here
changes it. This file records how `web/` is put together, and what the
frontend would like from the backend one day.

## Layout of `web/`

```
index.html              shell; no inline script or handler (strict CSP)
manifest.webmanifest    PWA manifest
sw.js                   service worker: offline shell, push, update prompt
css/app.css             tokens, base, shell, controls, the older screens
css/kit.css             the dashboard vocabulary: grid, module, stat, range bar, rings, chart marks
css/today.css · trends.css · workouts.css · social.css   one screen's own layout each
css/browse.css          Browse, the metric page, the metric row, the entry sheet, the optional groups
js/theme.js             classic script in <head>: applies the saved theme before paint
js/main.js              boot, history routing, shell, pull to refresh, SSE, update prompt
js/app.js               shared state (/api/me), navigation, the SSE event bus
js/api.js               fetch wrapper; throws ApiError with the server's sentence
js/ui.js                templating (escaped by default), sheets, toasts, skeletons, forms
js/icons.js             the icon set (GENERATED from Material Symbols; see docs/ICONS.md)
js/kit.js               module, stat, delta, range bar, rings, facts, insight, sub-tabs (docs/DESIGN.md)
js/viz.js               the analysis charts: trend, spark, hours, cats, histogram, scatter, regularity, stacked, duel
js/format.js            units, durations, dates in the person's time zone
js/metrics.js           every metric: the server's icon names as our glyphs, numbers in the person's units, the metric row and its spark, search words
js/entry.js             logging by hand: the entry sheet built from the server's form, one-tap presets, edit, delete, the pin toggle
js/groups.js            the optional groups: on, off, "Allow in Google" or "Keep on this site only", the More data module, the onboarding picker
js/charts.js            hand-drawn SVG charts (bars, lines, sleep, HR trace, ring, heat-map)
js/pwa.js               install state, service worker registration, Web Push
js/live.js              live heart rate: the store, the Web Bluetooth client, posting, wake lock (no DOM)
js/views/*.js           one module per screen, loaded on demand
js/views/browse.js      Browse (/trends): search, pinned, categories, "No data yet"
js/views/metric.js      one metric (/metric/<id>): period, headline, chart by kind, facts, how it is worked out, entries
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
`/trends` (Browse), `/trends/overview|sleep|activity|heart|body` (the
analysis views), `/metric/<id>[?range=day|week|month|6m|year&end=YYYY-MM-DD]`, `/workouts`, `/workouts/<id>`,
`/workouts/import`, `/workouts/detection`, `/summary`, `/ranks`,
`/compare[?with=<username>]`, `/u/<username>`, `/settings[/<section>]`
(sections: `account`, `connections`, `privacy`, `notifications`, `goals`,
`data`, `admin`). The "Me" tab is `/settings`.

Google is started with `return=/welcome/google` (onboarding), `return=/`
(Today banner), `return=/workouts`, `return=/workouts/<id>`,
`return=/trends/body` and `return=/settings/connections`; each of those
screens reads `?google=…`, shows it, and removes it from the address.

## Every metric (Browse, the metric page, logging)

The second tab is labelled Browse and still lives at `/trends` (its key in
`main.js` is still `trends`). `views/shared.js sectionTabs()` builds the one
sub-tab bar Browse and the analysis views share.

Pieces meant to be reused (Today uses them in the next phase):

- `metrics.js`: `metricRow(m, { pin, today })` inside `<ul class="mrows">`
  (add `mrows--wide` for two abreast on desktop); `metricSpark(m, { h })`;
  `latestParts(m)` → `{ v, u, words }`; `when(m, today)`; `metricIcon(m)`;
  `unitOf(m)`, `val(m, v)`, `num(m, v)`, `text(m, v)`, `shown(m, cv, { short })`
  for numbers in the person's units; `entryText(m, e)`; `pinButton(m)`;
  `ownTag()`; `matches(m, query, categoryLabel)`.
- `entry.js`: `entrySheet({ metric, add, entry, onSaved })`;
  `addEntry(metricId, { onSaved })` (fetches the form, opens the sheet, or
  offers to turn the group on); `quickButtons(add)` + `quickAdd(add, preset,
  { label })`; `deleteEntry(metric, entry)`; `togglePin(id, on)`;
  `bindPins(root, { changed })`; `reportSaved(reply, done)`.
- `groups.js`: `turnOnGroup(id, { ret })`, `turnOffGroup(id)`,
  `groupsModule(pane, { ret, changed })`, `groupsPicker()` +
  `pickedGroups(root)`, `groupOf(id)`, `groupState(g)`, `GROUP_LOOK`,
  `ALWAYS_PRIVATE`.
- `views/metric.js`: `cardioRing({ minutes, target, fam, size, stroke })`.
- `viz.js`: `spans()` (lowest-to-highest bars), `sparkDots()`; `trend()`
  takes `xText`, `readDate`, `readExtra`; `stacked()` takes `readLabels`.

State: Browse keeps its last payload in memory (per signed-in user) so
coming back paints at once, and keeps the search text and the open "No data
yet" list in `history.state`. `main.js` records `from` (the path left) in
every pushed state; the metric page's back arrow is `history.back()` when
that is `/trends`. The metric page keeps the last range in
`sessionStorage` (`health.metric.range`) and the range and end day in the
URL. Google is started with `return=/trends` and `return=/metric/<id>` as
well; both read `?google=…`.

The server's sentences (`reading`, an entry's `text`) are shown as they
are, in metric units; numbers the frontend draws itself follow the
person's km / mi, kg / lb and °C / °F. Water stays in ml, glucose in mg/dL,
height in cm.

## Design

`docs/DESIGN.md` is the source of truth (direction, tokens, components,
chart language, the plan per screen) and `docs/ICONS.md` covers the icon
family. In short: a pure white or pure black page with barely-raised
modules; a colour per metric family, set with `mod({ fam })` or
`class="fam fam-heart"` and read by every mark inside as `--mark`; the
icon's lime `#b6f23c` as the brand (primary buttons, the selected tab);
semantic colours kept apart and never alone. The dark token block appears
twice in `css/app.css` (system preference and manual override) and the two
must stay identical.

`scripts/make-icons.py` regenerates the app icon from `docs/heart-rate.svg`;
`scripts/make-icon-set.mjs` regenerates `web/js/icons.js`.

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
