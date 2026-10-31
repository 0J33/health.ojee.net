# health.ojee.net

A health tracker for ojee and friends. Sign in with your ojee.net account (the
one mtg.ojee.net and dnd.ojee.net use), connect Google Health or a Garmin watch, and get your own
dashboard, workouts, an optional AI summary, and a public leaderboard and
profile. It installs as a home-screen web app with opt-in notifications.

What it shows: everything Google Health holds for the person (activity with
floors and calories, heart with zones and VO2 max, sleep, body, vitals), the
app's own calculated numbers (a readiness label, a sleep score, weekly cardio
minutes, a recovery trend), and, in optional groups that are off by default and
always private, what is logged by hand (water and food, mood, symptoms, cycle)
and ECG readings. Today is the daily brief of all of it, Browse lists every
metric, and each metric has its own page.

It is the multi-user sibling of the console's single-user health module
(`ojee-health`); `server/core/` is that module's code, copied in and adapted so
that everything is per person and per time zone.

- `docs/SPEC.md` — what it is and why (the owner's decisions).
- `docs/API.md` — the exact HTTP contract (frontend, and the console-module link).

## Layout

```
server/            the API and static server (node:http; deps: mongodb, bcryptjs, web-push)
  index.js         the process: env, Mongo or the demo stand-ins, listen
  app.js           every route
  config.js        environment → config
  accounts.js      the shared ojee.net login (users, sessions in mtg's Mongo)
  worlds.js        one UserWorld per person (their sqlite, Google token, poller, workouts), in an LRU
  scheduler.js     everybody's sync, on one clock
  appdb.js         the global sqlite: profiles, public rows, records, push devices, link keys, secrets
  social.js        public rows, leaderboards, profiles, compare, records, streaks
  views.js         the payloads of a person's own routes
  history.js       this app's workouts + Google's exercises as one list
  hevy.js          Hevy CSV import          muscles.js   exercise name → muscle group
  garmin.js        Garmin's Personal API: the key swapped for a token, the reads, the field mapping
  garminsync.js    what a Garmin pass writes, into the person's Garmin store
  zen.js           summaries by OpenCode Zen, with the person's own key
  notify.js        Web Push and in-app notifications
  link.js          two-way sync with the console's health module
  live.js          live heart rate: in memory only, relayed to the person's own tabs
  caps.js          what a person's device actually reports
  secrets.js       AES-256-GCM vault, link key hashing
  demo.js          demo mode: seeded people over a fake Mongo and a fake Google
  fake-mongo.js    the in-memory Mongo stand-in (demo and tests)
  core/            from ojee-health: google, sync, parse, metrics, insight, detect, workouts, alerts, util, db, demo
web/               the frontend (no build step)
tests/             node --test; no network, no real Mongo
deploy/            systemd unit, nginx site, deploy.sh, install-root.sh, .env.example
data/              gitignored: app.sqlite, users/<id>/health.sqlite, users/<id>/google.json, users/<id>/src/*.sqlite
```

## Run it

```sh
npm install
npm test          # everything, offline
npm run demo      # http://localhost:5020, nothing real is touched
```

The demo seeds seven people with different devices and privacy settings and
90 days of history, through the real code paths (registered, connected through
the OAuth exchange, filled by the real poller, published by the real social
code). Only the far ends are fake: an in-memory Mongo and a synthetic Google.
The logins are printed on start (`demo` / `demo` is the main one); `data/demo`
is wiped on every start.

For the real thing: `cp deploy/.env.example .env`, fill it in, `npm start`.

## How it holds together

**Accounts.** One login for three sites. This server reads and writes only
`users` (`username`, `password`, `createdAt`, `lastLogin`) and `sessions` in
mtg's database, with mtg's rules and messages, and sets the same `ojeeSession`
cookie on `.ojee.net`. A health profile is made the first time a person
arrives here. An admin can close registration: no new accounts from this site
and no new health profiles; existing people carry on.

**Per-person worlds.** Each person has a folder, `data/users/<mongo id>/`,
holding their own sqlite database and their own Google refresh token (0600).
A route gets the signed-in person's world and no other; there is no code path
that opens somebody else's. Worlds are opened on demand and kept in an LRU.

**What other people see** comes only from the global tables. After a person's
sync, their numbers are copied into `daily_public` (and `public_workout`,
`records`), minus every category they keep private; a private account has no
rows. Leaderboards and profiles read those tables and nothing else, and check
the privacy flags again on the way out. Periods are each person's own: their
civil day, their Monday.

**Devices differ.** Nothing is assumed about what a person wears. After each
sync `caps` records which streams actually produced data in the last 14 days;
the frontend hides or explains the rest, readiness uses what there is and says
which signals it used, and workout detection is only offered with minute-level
heart rate.

**Garmin.** A Garmin can be read directly instead of (or as well as) through
Google: the person pastes a Personal API key made on their own Garmin Connect
account, and stress and Body Battery come too. See docs/DATA-TYPES.md,
"Garmin" (what is read, the field mapping, what is unverified without a real
key, and how Google and Garmin are put together).

**Google.** One OAuth web client, PKCE, the attempt bound to the session that
started it. A declined permission costs only what it covers ("Reconnect to
allow saving workouts"). A revoked or expired grant marks that person
`expired` and tells them once; a 429 backs off that person only.

**Workouts** are detected (opt-in), started and ended by hand, logged after
the fact, imported from Hevy, or mirrored read-only from Google Health. The
detection rules and every edge case are the module's, with its tests.

**Summaries.** The numbers are computed here, deterministically. The prose
comes from OpenCode Zen with the person's own key (stored encrypted, never
returned), trying free zero-retention models first and never the families
that log or train on prompts. Anything going wrong falls back to the same
numbers written up by rules, labelled "Written without AI" with the reason.

**The console-module link** keeps ojee's own module in step: records with a
stable `uid`, last write wins, tombstones, and a Google data point name
derived from the `uid` so the two sides can never upload a workout twice.
While the link is healthy, this app is the one that detects and asks.

## Environment

| variable | |
|---|---|
| `PUBLIC_ORIGIN` | the site's origin, `https://health.ojee.net`. Required. The Google redirect URI is `PUBLIC_ORIGIN/auth/google/callback` |
| `MONGODB_URI` | the accounts database, default `mongodb://localhost:27017/mtg` |
| `COOKIE_DOMAIN` | `.ojee.net` in production, so mtg, dnd and this site share the session |
| `APP_SECRET` | encrypts saved OpenCode keys. Required to save keys; keep it stable |
| `GOOGLE_HEALTH_CLIENT_ID`, `GOOGLE_HEALTH_CLIENT_SECRET` | the OAuth web client |
| `ADMIN_USERS` | comma-separated usernames, default `ojee` |
| `PORT`, `HOST` | default `5020`, `127.0.0.1` |
| `DATA_DIR` | default `./data` |
| `ZEN_MODELS` | override the model order (logging/training families are dropped whatever it says) |
| `VAPID_SUBJECT` | contact for the push services, default `mailto:health@ojee.net` |
| `DEFAULT_TZ` | zone for a profile made without one, default `Africa/Cairo` |
| `SYNC_MINUTES`, `SYNC_CONCURRENCY`, `WORLD_CACHE` | 20, 3, 40 |
| `ALLOWED_ORIGINS` | extra origins allowed to make state-changing requests (normally none) |
| `TRUST_PROXY` | `false` if the port is ever exposed directly (the visitor address is otherwise read from `CF-Connecting-IP` / `X-Forwarded-For`) |
| `HEALTH_DEMO` | `1` = demo mode (what `npm run demo` sets) |
| `GARMIN_API_URL`, `GARMIN_GAP_MS` | Garmin's Personal API, default `https://personal.connectapi.garmin.com`, and the spacing between its calls, default 1000 ms |
| `GARMIN_DEBUG` | `1` logs the keys (never the values) of a Garmin answer shaped otherwise than expected |

VAPID keys for Web Push are generated on first start and kept in
`data/app.sqlite`. Back up `data/`: it is everything.

### Google Cloud, once

Enable the **Google Health API**, publish the OAuth consent screen (left in
Testing, Google expires every refresh token after 7 days), add the six
`googlehealth.*` scopes the Connections page lists, and add the redirect URI
`https://health.ojee.net/auth/google/callback` to the web client. Unverified,
the app is capped at 100 users and shows Google's "unverified app" screen.

## Deploy

Hosted on disinteg: one Node process on `127.0.0.1:5020` behind nginx and the
cloudflared tunnel.

```sh
cp deploy/deploy.local.env.example deploy/deploy.local.env   # once; gitignored
./deploy/deploy.sh
```

`deploy.sh` runs the tests, rsyncs the repo to `~/health-server` (never
touching `data/` or `.env` there), runs `npm ci --omit=dev` with the box's
node, restarts `health.service` without root (it kills the main process;
`Restart=on-failure` brings it back) and health-checks the live site.

The first time only, on the box, with root:

```sh
cd ~/health-server && cp deploy/.env.example .env && chmod 600 .env   # fill it in
sudo bash deploy/install-root.sh
```

That installs the nginx site, adds `health.ojee.net` to the tunnel's ingress
(with a backup), installs and enables the systemd unit, and reloads nginx and
cloudflared. The DNS record is one more command, printed at the end.

`deploy/health.service` and `deploy/nginx-health.conf` are records of what is
installed on the box: editing them changes nothing until copied there.

## Tests

`npm test` covers: the shared login against a fake Mongo (rules, messages,
cookie, only the allowed fields touched, rate limits, Origin, closed
registration); per-person isolation through every route; privacy flags at
write time and at read time; leaderboard periods across time zones; Hevy
parsing, dedupe and merge; Garmin (the token swap, the readers on good and odd
answers, a pass into its tables, history, 429s, a refused key, Google and Garmin
together, the routes, the key never leaving) and stress logged by hand; the link (last write wins, tombstones, cursor, no
double upload, who asks); workout detection (every case from the module);
capabilities per device; OAuth binding, token refresh, revocation, 403 and 429
handling; the scheduler; summaries and the key vault; notifications; static
serving and headers; live heart rate (both kinds of caller, validation, the
off-skin zero, expiry, delivery to that person only, the rate limit, nothing
on disk, and the Bluetooth measurement parser); and the demo process booting
for real.
