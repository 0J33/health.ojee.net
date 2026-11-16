# Your data, from your own code and your AI

rep. (rep.ojee.net) gives you everything it knows about you through an
API: the same one the site itself uses. Read it from a script, a spreadsheet or
your own app. Connect it to an AI assistant (Claude, Cursor, VS Code,
anything that speaks MCP). Log water, food, mood or a weigh-in from a
shortcut on your phone.

There are three ways in:

| | For | Address |
|---|---|---|
| **REST API** | scripts, apps, dashboards, automations | `https://rep.ojee.net/api/...` |
| **MCP server** | AI assistants and agents | `https://rep.ojee.net/mcp` |
| **Export** | one file with everything, any time | `GET /api/export`, or Me, Account, Download your data |

All three need a **personal API key**, and all three only ever show *your*
data, plus what your friends already share with you on the site.

The site used to be at `health.ojee.net`. That address still answers
`/api/...` and `/mcp`, so a script or assistant set up with it keeps
working; use `rep.ojee.net` for anything new.

- [The full API reference](/developers/api): every endpoint and every field.
- [The OpenAPI description](/developers/openapi.json): import it into
  Postman, Insomnia, a ChatGPT GPT's actions, or a code generator.

## Get a key

1. Sign in and open **Me, Settings, API and AI** (`/settings/api`).
2. Name the key after what it is for ("Claude", "Sheets", "iPhone
   Shortcuts") and pick its access:

   | Access | What it can do |
   |---|---|
   | **Read** | Read all of your data: every metric, every day, sleep, workouts, routines, trends, your profile and settings. |
   | **Read and write** | Read, and also log: entries (water, food, mood, stress, symptoms, glucose, temperature, body fat, measurements, a night's sleep), weigh-ins, workouts and their sets, routines, pins, and ask for a sync. |

3. Copy the key. It starts `hak_` and is shown **once**; the site keeps
   only a fingerprint of it. Lost it? Remove it and make another.

You can have 10 keys. Each one shows when it was last used and how many
times; remove one and it stops working at once.

**No key can ever** change your password or delete your account, make or
see keys, connect or disconnect Google, Garmin, Strava, WHOOP or anything else,
post, comment, cheer or add friends, change notifications, or use the AI
chat (which costs money). Those stay on the site, with you signed in.

**Nothing from Strava** comes through a key: Strava's terms keep its data to
your own screens and away from AI tools. A run your watch also sent to Google
Health is there as the watch's own record (its `g-…` id, Google's distance,
route and heart rate), even when Strava's copy of it is what your own screens
show. A workout only Strava has is left out everywhere a key reads (one asked
for by id is 404), and a workout Strava only added to comes without Strava's
numbers, title, route or track. Best times, medals and achievements, the feed,
summaries and the export are worked out the same way, so a run has one id and
one set of numbers in every answer. Strava's own status (`/api/strava`) is not
read with a key.

> A key reads everything the site shows you, including the optional groups
> you switched on (cycle, mood, symptoms, nutrition). Treat it like a
> password: keep it out of shared code and screenshots. Prefer a read key
> unless the tool really needs to log things.

## The REST API

Send the key in the `Authorization` header:

```bash
curl https://rep.ojee.net/api/browse \
  -H "Authorization: Bearer hak_your_key_here"
```

### What you will use most

| Endpoint | What you get |
|---|---|
| `GET /api/me` | You: username, time zone, units, goals, connected sources and their last sync. |
| `GET /api/browse` | Every metric you have data for, with its latest value and where it sits in its reference range. |
| `GET /api/metric/<id>?range=week&end=YYYY-MM-DD` | One metric over a period (`day`, `week`, `month`, `6m`, `year`): stats, the period before, the chart's points, the reference range, entries. Ids: `steps`, `distance`, `active`, `cardio_week`, `calories`, `resting_hr`, `hrv`, `vo2max`, `sleep`, `sleep_score`, `sleep_stages`, `readiness`, `resilience`, `weight`, `body_fat`, `spo2`, `resp`, `skin_temp`, `water`, `food`, `mood`, `stress`... `GET /api/browse` lists yours. |
| `GET /api/day?date=YYYY-MM-DD` | One day in full: totals, the night before with its stages, heart rate through the day, workouts, what you logged. |
| `GET /api/data?days=30` | Day by day for 7 to 90 days, with your usual ranges and today so far. |
| `GET /api/trends?days=90` | Averages and patterns over 7, 30, 90, 180 or 365 days. |
| `GET /api/workouts?limit=40&before=<ms>&kind=run` | Workouts, newest first; `kind` is `strength`, `run`, `walk`, `ride` or an exercise type such as `YOGA` (`kinds` lists yours). `GET /api/workouts/<id>` for one, with every set, and a run's `track` (splits, best efforts, ~300 samples along the route). |
| `GET /api/routines` | Your routines and programmes. |
| `GET /api/best-times` | Best times over the standard distances for running, cycling and walking. |
| `GET /api/export` | Everything, as one JSON file. |
| `POST /api/entries` | Log something (write key). Body `{ "kind": "water", "ml": 250 }`. |
| `POST /api/weight` | Log a weigh-in (write key). Body `{ "kg": 74.2 }`. |
| `POST /api/sync` | Fetch the newest from Google now (write key; once a minute). |

Every other endpoint in [the reference](/developers/api) works the same
way with a key, as long as it is one a key may use (above).

### Conventions

- **JSON** in and out, UTF-8. Send `Content-Type: application/json` with a body.
- **Units** are metric: kg, km and metres, minutes, °C, kcal, ml. Sleep is
  in minutes. Your chosen display units only change the site, never the API.
- **Dates** (`YYYY-MM-DD`) are civil days in your time zone (`GET /api/me`,
  `profile.tz`). **Times** are milliseconds since 1970 (UTC).
- **"Own" numbers** (`own: true`: sleep score, readiness, resilience, cardio
  minutes, body score...) are worked out by this site to match Google's,
  not given by Google. Their `about` says how.
- **Errors** are `{ "error": "A sentence for a person", "code": "machine_code" }`
  with the HTTP status:

  | Status | `code` | Meaning |
  |---|---|---|
  | 400 | `bad_request` | Something in the request is wrong; `error` says what. |
  | 401 | `bad_key` | No key, a wrong key, or a removed one. |
  | 403 | `not_allowed` | The key may not do this (a read key writing, or something keys never do). |
  | 404 | `not_found` | No such thing. |
  | 409 | `group_off`, `needs_google`... | Not possible right now: `error` says what to switch on or connect. |
  | 429 | `rate_limited` | Too many: wait for `Retry-After` seconds. |

- **Limits**: 300 requests a minute per key; logging 120 entries a minute;
  a sync once a minute. Data arrives from Google every few minutes to an
  hour, so polling faster than every 5 minutes gains nothing.
- **From a web page**: the API answers any origin when the request carries
  a key (CORS `*`, no cookies). Never put a key in a page other people can
  load: anybody could read it there.
- **Changes**: the API is the site's own and grows with it. Fields are added,
  not renamed or removed without a note under Changes in [the reference](/developers/api).

### Examples

**Python**: your resting heart rate, day by day for the last month.

```python
import requests

KEY = "hak_your_key_here"
api = requests.Session()
api.headers["Authorization"] = f"Bearer {KEY}"

m = api.get("https://rep.ojee.net/api/metric/resting_hr", params={"range": "month"}).json()
print(m["reading"])
for p in m["chart"]["points"]:
    print(p["date"], p["value"])
```

**JavaScript** (Node 18+, Deno, Bun): yesterday in full.

```js
const KEY = process.env.HEALTH_KEY;
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const res = await fetch(`https://rep.ojee.net/api/day?date=${yesterday}`, {
  headers: { Authorization: `Bearer ${KEY}` },
});
if (!res.ok) throw new Error((await res.json()).error);
console.log(await res.json());
```

**Logging** (a write key): 330 ml of water, from anything that can make an
HTTP request, such as an iPhone Shortcut ("Get contents of URL", method
POST, a header and a JSON body).

```bash
curl https://rep.ojee.net/api/entries \
  -H "Authorization: Bearer hak_your_write_key" \
  -H "Content-Type: application/json" \
  -d '{ "kind": "water", "ml": 330 }'
```

The kinds and their fields: `water` `{ml}`; `food` `{kcal, protein?, carbs?,
fat?, name?}`; `mood` `{moods: [ids], note?}`; `stress` `{level: 1-5, note?}`;
`symptom` `{symptoms: [ids], note?}`; `glucose` `{mgdl}`; `bodytemp`
`{celsius}`; `height` `{cm}`; `bodyfat` `{pct}`; `sleep` `{minutes, awake?}`;
`measure` (waist, hips... in cm); `period` `{days}`. Add `at` (ms) for a time
other than now. Water and food need Nutrition switched on in the app, mood
Mindfulness, symptoms Symptoms, period Cycle: until then the answer is 409
`group_off`, saying so.

**Google Sheets** (Extensions, Apps Script): steps a day into a sheet.

```js
function steps() {
  const key = PropertiesService.getScriptProperties().getProperty('HEALTH_KEY');
  const r = UrlFetchApp.fetch('https://rep.ojee.net/api/metric/steps?range=month',
    { headers: { Authorization: 'Bearer ' + key } });
  const pts = JSON.parse(r.getContentText()).chart.points;
  SpreadsheetApp.getActiveSheet().getRange(1, 1, pts.length, 2)
    .setValues(pts.map((p) => [p.date, p.value]));
}
```

## The MCP server (for AI)

`https://rep.ojee.net/mcp` is a Model Context Protocol server
(Streamable HTTP). An AI assistant connected to it can look at your data
when you ask it something ("how did I sleep this week compared to last?",
"am I training too much?", "log 500 ml of water"). It answers from your
actual numbers instead of guessing.

Connect it with a key in the `Authorization` header. A read key gives the
assistant the reading tools; a write key also lets it log things for you.

### Tools

| Tool | Key | What it does |
|---|---|---|
| `get_profile` | read | Who you are here: time zone, units, goals, connected sources. |
| `list_metrics` | read | Every metric you have, with its latest value and range. Start here. |
| `get_metric` | read | One metric over a day, week, month, 6 months or a year. |
| `get_day` | read | One day in full. |
| `get_overview` | read | The last 7 to 90 days at a glance. |
| `get_trends` | read | Averages and patterns over up to a year (every night of sleep with `include: ["nights"]`). |
| `list_workouts` | read | Workouts, newest first, filtered by `from`/`to` dates and `type`, with local dates and seconds. |
| `get_workout` | read | One workout with every set; a run, walk or ride analysed on the server (moving time, pace, heart rate, metres per beat, cardiac drift, stops, walk breaks, GPS jumps). Route points and minute-by-minute heart rate with `include`. |
| `get_run_trends` | read | Runs (or walks, rides) over a period, each analysed, and week by week; with `hr_band`, the pace at a heart rate. |
| `get_naps` | read | Naps over 7–365 days (sleeps the device marked as naps, never part of a night's numbers): each one, how many and how long, the usual time, the night after a nap against nights without, and `insights` in sentences. |
| `list_routines` | read | Your routines and programmes. |
| `get_best_times` | read | Best times by distance. |
| `api_get` | read | Any other read of the API (the reference has them all). |
| `log_entry` | write | Log water, food, mood, stress, symptoms, glucose, temperature... |
| `log_weight` | write | Log a weigh-in. |
| `sync_now` | write | Fetch the newest from Google now. |
| `api_request` | write | Any other change a write key may make. |

The tools return what the API returns, made lighter where an assistant
gains nothing (a night's minute-by-minute stages, sparklines, map tracks),
with a few things added so a model need not work them out:

- **Times where you live.** Every workout from `list_workouts` and
  `get_workout` carries `localDate`, `startLocal` and `endLocal` (ISO 8601
  with your zone's offset) and `durationS`, beside the API's milliseconds.
- **Filters.** `list_workouts` takes `from` and `to` (dates in your zone,
  inclusive), `type` (`run`, `walk`, `ride`, `strength`, or one exercise type
  such as `RUNNING` or `YOGA`) and `limit` up to 200. The strength summary
  (exercises, records, muscle balance) is left out unless asked with
  `include: ["strength"]`.
- **One moving time.** A run with a GPS track has one moving time, the
  track's: `list_workouts` (`movingS`, `paceFrom: "track"`), `get_workout`'s
  analysis, its splits and `get_run_trends` all use it, and pace is distance
  over it. A run with no track has the watch's pace (`paceFrom: "watch"`).
- **A run read closely.** `get_workout` on a run, walk or ride adds
  `analysis`: `distanceM` (and `distanceSources`, the watch's and the GPS
  track's), `elapsedS`, `movingS`, `paceSPerKm` (`avgSpeedKmh` for a ride),
  `avgHr` (the watch's, as the list has it; `hrSources` gives the trace's
  too), `maxHr`, `metresPerBeat`, `cardiacDriftPct` (speed per beat in the
  second half against the first, only for an even effort: the halves' pace
  within 10 %, else null with `uneven_effort` in `notes`; `driftHalves` gives
  both halves and a `confidence`, `low` with the reasons in `why` when the
  halves' pace differs by over 5 %, walking is over 15 % of the moving time, or
  there was a walk of 3 minutes or more), `firstKm` and `restAfterFirstKm`, `stops` (`totalS` is
  elapsed less moving exactly: `listedS` the stops of 10 s or more, `shortS`
  the rest), `walkBreaks` (`{ count, totalS, by, list }`: 150 or more steps a
  minute is running whatever the speed; under 6.5 km/h, or 80 % of the run's
  median speed if lower, is walking; under 130 steps a minute below 7 km/h is
  walking too (the watch counts steps a minute at a time, so a minute of
  walking and jogging reads 100-130); gaps in the GPS and missing speeds are not
  walking; 15 s or more), `longestRunning`, `gpsSpikes` and `gpsSpikeList` (faster than
  the sport goes, or a short burst at twice the run's median speed, 1.5 times
  just after a stop), `bestEfforts` (the track's, leaving out any across a GPS
  jump; `get_best_times` leaves out the same), `elevation`, `flags` (`no_distance`, `impossible_pace`,
  `mostly_stopped`, `gps_spikes` when jumps cover over 5 % of the time) and
  `notes`. With `hr_band: [140, 150]` it also has `inHrBand`: distance over
  time while running with the heart rate in that band (`excludesWalking`:
  walk breaks, stops, GPS gaps and jumps are left out). The workout's `zones` keep the
  bounds they were first measured with (`boundsSetAt`), so the same run gives
  the same zone minutes on every call. The bulky
  parts are left out unless asked with `include`: `series` (about 300
  samples along the route: metres, elevation, km/h, seconds from the start,
  bpm), `route` (the line and its bounds), `trace` (heart rate minute by
  minute).
- **Runs over time.** `get_run_trends` (`sport`, `from`, `to`, `hr_band`;
  by default runs over the last 12 weeks) analyses each run as above and
  adds them up by ISO week from the runs' own totals (pace is total distance
  over total moving time, the band's pace total distance over total time in
  the band, not an average of averages): runs, distance, moving time, pace,
  heart rate, cardiac drift, and with `hr_band` the pace in the band. Flagged runs are
  listed in `flagged` and left out of the weeks.
- **Nights.** `get_trends` leaves out the list of every night of sleep
  unless asked with `include: ["nights"]`.

An answer over 200,000 characters is cut, with a note to ask for a shorter
period.

### Claude Code

```bash
claude mcp add --transport http health https://rep.ojee.net/mcp \
  --header "Authorization: Bearer hak_your_key_here"
```

### Claude Desktop

Settings, Developer, Edit Config, and add (needs Node.js; `mcp-remote`
bridges a remote server with a header):

```json
{
  "mcpServers": {
    "health": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://rep.ojee.net/mcp", "--header", "Authorization:${HEALTH_AUTH}"],
      "env": { "HEALTH_AUTH": "Bearer hak_your_key_here" }
    }
  }
}
```

Restart Claude Desktop; "health" appears under the tools button.

### Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "health": {
      "url": "https://rep.ojee.net/mcp",
      "headers": { "Authorization": "Bearer hak_your_key_here" }
    }
  }
}
```

### VS Code (Copilot agent mode)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "health": {
      "type": "http",
      "url": "https://rep.ojee.net/mcp",
      "headers": { "Authorization": "Bearer ${input:health-key}" }
    }
  },
  "inputs": [{ "id": "health-key", "type": "promptString", "description": "rep.ojee.net API key", "password": true }]
}
```

### Your own agent, with the Claude API

The Messages API can reach the server itself (the MCP connector):

```python
import anthropic

client = anthropic.Anthropic()
reply = client.beta.messages.create(
    model="claude-opus-5-5",
    max_tokens=4096,
    betas=["mcp-client-2025-11-20"],
    mcp_servers=[{
        "type": "url",
        "url": "https://rep.ojee.net/mcp",
        "name": "health",
        "authorization_token": "hak_your_key_here",
    }],
    tools=[{"type": "mcp_toolset", "mcp_server_name": "health"}],
    messages=[{"role": "user", "content": "How has my sleep been this month, and what stands out?"}],
)
print("".join(b.text for b in reply.content if b.type == "text"))
```

Other assistants and frameworks connect the same way: the URL above, and
an `Authorization: Bearer hak_...` header.

**Not yet:** apps that only connect to MCP servers through a sign-in
(OAuth), such as claude.ai's and ChatGPT's own connector settings, cannot
use this server yet, because it takes a key, not a sign-in. Use one of the
clients above, or a GPT with Actions from [the OpenAPI
description](/developers/openapi.json) (authentication: API key, Bearer).

### For MCP client authors

- `POST /mcp` with one JSON-RPC 2.0 message or a batch (up to 20). The
  answer is `application/json`; there is no event stream and no session
  (`GET /mcp` is 405). Notifications get 202.
- Protocol versions `2025-06-18`, `2025-03-26` and `2024-11-05`; the
  server answers with the one you ask for, else the newest.
- `initialize`, `ping`, `tools/list`, `tools/call`; `resources/list`,
  `resources/templates/list` and `prompts/list` are empty. A tool's answer is
  JSON as text, and also as `structuredContent`.
- A tool the API refuses comes back as a result with `isError: true` and
  the API's own sentence, so the model can tell you what to do.
- 401 with `WWW-Authenticate: Bearer` without a valid key.

## Privacy

- A key is yours: it only ever reads your account, plus what friends
  already share with you on the site.
- The site keeps a fingerprint (SHA-256) of each key, its name, when it
  was made, last used and how often. Not what was asked.
- Whatever you connect a key to (an AI assistant, a spreadsheet) gets the
  data you let it read, under that service's own terms. Remove the key in
  Settings, API and AI to cut it off.
- Health data, not medical advice: that goes for what an assistant says
  about it too.
