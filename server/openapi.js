/* ============================================================
   health.ojee.net — the OpenAPI 3.1 description of the API a personal
   key may use (apikeys.js), at /developers/openapi.json: for Postman,
   code generators and a ChatGPT GPT's actions. The answers are the
   site's own, described in full in docs/API.md (/developers/api);
   here each is named and summed up, not typed field by field.
   ============================================================ */

const obj = (description) => ({ description, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } });
const ERR = { $ref: '#/components/responses/Error' };
const errs = { 400: ERR, 401: ERR, 403: ERR, 404: ERR, 409: ERR, 429: ERR };
const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', example: '2026-11-05' };
const q = (name, schema, description, required = false) => ({ name, in: 'query', required, description, schema });
const path = (name, description, schema = { type: 'string' }) => ({ name, in: 'path', required: true, description, schema });

const read = (operationId, summary, description, parameters = [], tag = 'Your data') => ({
  get: { operationId, summary, description, tags: [tag], parameters, responses: { 200: obj(summary), ...errs } },
});
const write = (method, operationId, summary, description, schema, example, tag = 'Logging') => ({
  [method]: {
    operationId, summary, description, tags: [tag],
    'x-scope': 'write',
    requestBody: { required: true, content: { 'application/json': { schema, example } } },
    responses: { 200: obj(summary), ...errs },
  },
});

export function openapi(origin) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'rep.',
      version: '1',
      summary: 'Your own health data: activity, sleep, heart, body, workouts, and logging.',
      description: `The API the site itself uses, with a personal API key (Me, Settings, API and AI). A read key reads; a write key also logs. Units are metric, dates are YYYY-MM-DD in your time zone, times are ms since 1970. Every field of every answer: ${origin}/developers/api. The guide: ${origin}/developers.`,
      contact: { url: `${origin}/developers` },
    },
    servers: [{ url: origin }],
    security: [{ apiKey: [] }],
    tags: [{ name: 'Your data' }, { name: 'Workouts' }, { name: 'Logging', description: 'Needs a write key.' }],
    paths: {
      '/api/me': read('getMe', 'You and your settings', 'Username, time zone, units, goals, connected sources and their last sync.'),
      '/api/browse': read('listMetrics', 'Every metric with data', 'Every metric you have data for, by category, with its latest value and where it sits in its reference range. The ids are what /api/metric/{id} takes.'),
      '/api/metric/{id}': read('getMetric', 'One metric over a period', 'Stats (average, total, lowest, highest), the period before, a sentence reading it, the chart points (`chart.points`: date, value), the reference range and the entries, newest first.', [
        path('id', 'A metric id from listMetrics: steps, distance, active, cardio_week, calories, resting_hr, hrv, vo2max, sleep, sleep_score, sleep_stages, readiness, resilience, weight, body_fat, spo2, resp, skin_temp, water, food, mood, stress...'),
        q('range', { type: 'string', enum: ['day', 'week', 'month', '6m', 'year'], default: 'week' }, 'The period.'),
        q('end', DATE, 'The last day of the period (default today).'),
        q('before', { type: 'integer' }, 'Entries: the next page, older than this time (ms).'),
      ]),
      '/api/day': read('getDay', 'One day in full', 'Totals, the night before with its stages, heart rate through the day, workouts, what was logged, and the naps that ended that day.', [q('date', DATE, 'The day (default today).')]),
      '/api/naps': read('getNaps', 'Naps and what they say', 'Each nap (a sleep the device marked as one, never part of a night\'s numbers) over 7 to 365 days, with how many, how long, when, and the night after a nap against nights without, and the same in sentences.', [q('days', { type: 'integer', minimum: 7, maximum: 365, default: 30 }, 'How many days back.')]),
      '/api/data': read('getOverview', 'Day by day', 'Day by day for 7 to 90 days with your usual ranges, today so far, last night, readiness.', [q('days', { type: 'integer', minimum: 7, maximum: 90, default: 30 }, 'How many days.')]),
      '/api/trends': read('getTrends', 'Averages and patterns', 'Weeks, months, sleep regularity, weekday patterns, weight trend, relations between metrics.', [q('days', { type: 'integer', enum: [7, 30, 90, 180, 365], default: 30 }, 'How far back.')]),
      '/api/brief': read('getBrief', 'The morning brief', 'Last night, readiness and what stands out today, as the Today page leads with.'),
      '/api/export': read('exportAll', 'Everything', 'All of your data as one JSON document (or the daily table as CSV with format=csv).', [q('format', { type: 'string', enum: ['json', 'csv'] }, 'json (default) or csv.')]),
      '/api/workouts': read('listWorkouts', 'Workouts, newest first', 'Type, start and end, duration, distance, calories, heart rate, and sets in short; your training load by week.', [
        q('limit', { type: 'integer', minimum: 1, maximum: 100, default: 40 }, 'How many.'),
        q('before', { type: 'integer' }, 'Only those that started before this time (ms): the next page.'),
        q('kind', { type: 'string' }, 'One kind only: strength, run, walk, ride, or an exercise type such as YOGA (the reply\'s `kinds` lists those there are).'),
      ], 'Workouts'),
      '/api/workouts/{id}': {
        ...read('getWorkout', 'One workout', 'Every exercise and set, heart rate and zones, splits, route summary, records.', [path('id', 'A workout id.')], 'Workouts'),
        ...write('patch', 'editWorkout', 'Change a workout', 'Its title, type, times, notes (as the site edits them).', { type: 'object', additionalProperties: true }, { title: 'Evening run' }, 'Workouts'),
        delete: { operationId: 'deleteWorkout', summary: 'Delete a workout', tags: ['Workouts'], 'x-scope': 'write', parameters: [path('id', 'A workout id.')], responses: { 200: obj('Deleted'), ...errs } },
      },
      '/api/routines': read('listRoutines', 'Routines', 'Your strength routines and programmes.', [], 'Workouts'),
      '/api/best-times': read('getBestTimes', 'Best times', 'Best times for running, walking, cycling and swimming distances.', [], 'Workouts'),
      '/api/achievements': read('getAchievements', 'Medals and achievements', 'What you have earned and what is close.', [], 'Workouts'),
      '/api/entries': write('post', 'logEntry', 'Log an entry', 'One entry, as the Log sheet makes it. `kind` and its fields: water {ml}; food {kcal, protein, carbs, fat, name}; mood {moods, note}; stress {level 1-5, note}; symptom {symptoms, note}; glucose {mgdl}; bodytemp {celsius}; height {cm}; bodyfat {pct}; sleep {minutes, awake}; measure; period {days}. `at` (ms) for another time. 409 group_off when the kind\'s group is not switched on.', {
        type: 'object', required: ['kind'], additionalProperties: true,
        properties: { kind: { type: 'string', enum: ['water', 'food', 'mood', 'stress', 'symptom', 'glucose', 'bodytemp', 'height', 'bodyfat', 'sleep', 'measure', 'period', 'ovulation'] }, at: { type: 'integer', description: 'When (ms); default now.' } },
      }, { kind: 'water', ml: 330 }),
      '/api/entries/{id}': {
        patch: { operationId: 'editEntry', summary: 'Change an entry', tags: ['Logging'], 'x-scope': 'write', parameters: [path('id', 'An entry id (from a metric\'s entries).')], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } } }, responses: { 200: obj('Changed'), ...errs } },
        delete: { operationId: 'deleteEntry', summary: 'Delete an entry', tags: ['Logging'], 'x-scope': 'write', parameters: [path('id', 'An entry id.')], responses: { 200: obj('Deleted'), ...errs } },
      },
      '/api/weight': write('post', 'logWeight', 'Log a weigh-in', 'In kg; `at` optional (at most 30 days back). Sent to Google Health too when it is connected with the weight permission.', {
        type: 'object', required: ['kg'], properties: { kg: { type: 'number', minimum: 20, maximum: 400 }, at: { type: 'integer' }, note: { type: 'string', maxLength: 200 } },
      }, { kg: 74.2 }),
      '/api/sync': write('post', 'syncNow', 'Sync now', 'Fetch the newest from Google Health now. At most once a minute.', { type: 'object' }, {}),
    },
    components: {
      securitySchemes: { apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'hak_...', description: 'A personal API key from Me, Settings, API and AI.' } },
      responses: {
        Error: {
          description: 'An error: `error` is a sentence for a person, `code` a machine code (bad_request, bad_key, not_allowed, not_found, group_off, needs_google, rate_limited...).',
          content: { 'application/json': { schema: { type: 'object', required: ['error', 'code'], properties: { error: { type: 'string' }, code: { type: 'string' }, detail: {} } } } },
        },
      },
    },
  };
}
