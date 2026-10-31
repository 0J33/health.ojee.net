# Data types

Every data type the Google Health API v4 has, what each one can be asked, and what
health.ojee.net does with it. This is the reference behind `server/core/google.js`
(scopes, writes), `server/core/parse.js` (replies to rows), `server/core/sync.js` (the
streams) and `server/core/entries.js` (what a person logs by hand).

## How this was derived

Two sources, and they do not always agree.

1. **The discovery document**, `health.googleapis.com/$discovery/rest?version=v4`,
   revision `20261007`. It gives the 42 members of the `DataPoint` union, their fields,
   the members of the `RollupDataPoint` and `DailyRollupDataPoint` unions, the filter
   grammar, and the scopes each *method* accepts. It does not say which scope opens which
   *type*, nor which types can be created.
2. **A read-only probe of the real API** on 2026-10-11, with the owner's account and the
   core scopes: one `list` and one `dailyRollUp` per type, and nothing written. Where the
   API refused a call it named the calls it does support (`"List is not supported for
   data type moods, but the following actions are supported: create, update,
   batchDelete"`), which settles several things the document leaves open.

Each cell below says where it comes from:

| mark | meaning |
|---|---|
| **P** | the probe saw it: the call answered 200 (with data, or accepted and empty), or was refused with that exact answer |
| **A** | this app has been using the call against the real API since before this work (weight and exercise writes, the existing streams) |
| **D** | the discovery document says so; the probe did not test it |
| **I** | inferred: not stated by the document and not verified. The reasoning is in the notes |

Where the probe and the document disagree the probe wins, and the cell says so.

The probe could not see everything. It held no optional scope, so the six types behind
them answered 403 to every call: what they return once granted is from the document.
Several types were accepted and empty for that account (no altitude, VO2 max, SpO2
samples, body fat, glucose or body temperature): their reply shapes are from the document.
Nothing was written, so every "create" that is not marked **A** is inferred.

## Scopes

The core set is asked for at connect. A group is asked for only when the person
switches it on (`/auth/google/start?groups=...`, incremental authorization).

| set | scopes (`https://www.googleapis.com/auth/googlehealth.` + ...) | opens |
|---|---|---|
| core | `activity_and_fitness.readonly`, `health_metrics_and_measurements.readonly`, `sleep.readonly`, `settings.readonly`, `health_metrics_and_measurements.writeonly`, `activity_and_fitness.writeonly` | activity, heart, body and sleep data; paired devices; writing weight, body fat, height, glucose, body temperature and workouts |
| `nutrition` | `nutrition.writeonly` | writing water and food logs, and reading back what this app wrote. There is no `nutrition.readonly` scope at all |
| `mindfulness` | `mindfulness.writeonly` | writing moods |
| `symptoms` | `logged_symptoms.writeonly` | writing symptoms |
| `cycle` | `reproductive_health.writeonly` | writing periods and ovulation tests |
| `ecg` | `ecg.readonly`, `irn.readonly` | reading ECG readings and irregular rhythm notices. There is no write scope |

Never asked for: `profile.*`, `location.readonly`, `sleep.writeonly`, `settings.writeonly`,
and the `.readonly` scopes of mindfulness, symptoms and reproductive health (the types
they would open cannot be listed, see below).

Which scope opens which type is **inferred** from the scope names and from what the
probe could read with the core set: every type it read sits under activity, metrics or
sleep, and the six it was refused sit under the scopes it did not hold. The split
between `activity_and_fitness` and `health_metrics_and_measurements` for the newer
types (VO2 max under activity; respiratory rate, zone thresholds and SpO2 samples under
metrics) is a judgement. It only decides which stream is skipped when a person declines
one of the two; a wrong guess is caught by the 403 handling in the sync, not by a failure.

## The 42 types

`filter` is the field a `list` filter uses (snake_case type name, as the API wants it).
`C/P/D` is create / patch / batchDelete. Units are the API's own.

### Activity

| type | kind | filter | list | rollUp | dailyRollUp | C/P/D | values | scope | what this app does |
|---|---|---|---|---|---|---|---|---|---|
| `steps` | interval | `steps.interval.start_time` | yes P | yes A | yes P | not verified; not used | `count` (int64); roll-up `countSum` | activity | synced: stream `steps`, dailyRollUp, into daily `steps` |
| `distance` | interval | `distance.interval.start_time` | yes P | yes D | yes P | not verified; not used | `millimeters` (int64); roll-up `millimetersSum` | activity | synced: stream `distance`, dailyRollUp, into `distance_m` (metres) |
| `active-zone-minutes` | interval | `active_zone_minutes.interval.start_time` | yes P | yes D | yes P | not verified; not used | `activeZoneMinutes`, `heartRateZone` (FAT_BURN, CARDIO, PEAK); roll-up `sumIn{FatBurn,Cardio,Peak}HeartZone` | activity | synced: stream `azm`, dailyRollUp, into `azm`, `azm_fat`, `azm_cardio`, `azm_peak` |
| `active-minutes` | interval | `active_minutes.interval.start_time` | yes P | yes D | yes P (14-day cap) | not verified; not used | `activeMinutesByActivityLevel[]` (LIGHT, MODERATE, VIGOROUS) | activity | synced: stream `activeMinutes`, dailyRollUp in 14-day calls, into `active_min` (moderate + vigorous) |
| `floors` | interval | (cannot be listed) | **no P** (document lists it as a type; the API answers "List is not supported ... reconcile, rollup, dailyRollup") | yes P | yes P | no P | `count`; roll-up `countSum` | activity | synced: stream `floors`, dailyRollUp, into `floors` |
| `altitude` | interval | `altitude.interval.start_time` | yes P (empty) | yes D | yes P (empty) | not verified; not used | `gainMillimeters` (a gain, not a height above sea); roll-up `gainMillimetersSum` | activity | synced: stream `altitude`, dailyRollUp, into `altitude_m` (metres climbed). The raw intervals are not read: the roll-up is the same number per day |
| `active-energy-burned` | interval | `active_energy_burned.interval.start_time` | yes P | yes D | yes P | not verified; not used | `kcal`; roll-up `kcalSum` | activity | synced: stream `kcalActive`, dailyRollUp, into `kcal_active` |
| `basal-energy-burned` | interval | `basal_energy_burned.interval.start_time` | yes P (empty) | no D | **no P** ("list, reconcile") | no P | `kcal` | activity | **skipped.** No roll-up exists and the probed account has no points. Resting energy is worked out instead: daily `kcal_basal` = `kcal` - `kcal_active`, never below zero, only for a day that has both. The app says it is calculated |
| `activity-level` | interval (the document calls it daily in one place; a `.date` filter is refused **P**) | `activity_level.interval.start_time` | yes P | yes D | **no P** (the document's union has it; the API answers "list, reconcile") | no P | `activityLevelType` (SEDENTARY, LIGHTLY_ACTIVE, MODERATELY_ACTIVE, VERY_ACTIVE) | activity | synced: stream `levels`, list, heavy. The intervals are summed here per civil day and level into `level_sedentary`, `level_light`, `level_moderate`, `level_very` (minutes) |
| `sedentary-period` | interval | `sedentary_period.interval.start_time` | yes P | yes D | yes P | not verified; not used | the interval itself; roll-up `durationSum` | activity | synced: stream `sedentary`, dailyRollUp, into `sedentary_min`. Raw intervals not read |
| `swim-lengths-data` | interval | `swim_lengths_data.interval.start_time` | yes P | yes D | yes P | not verified; not used | `strokeCount`, `swimStrokeType`; roll-up `strokeCountSum` | activity | synced: stream `swim`, dailyRollUp, into `swim_strokes`. Raw lengths not read |
| `time-in-heart-rate-zone` | interval | `time_in_heart_rate_zone.interval.start_time` | yes P | yes D | yes P | not verified; not used | `heartRateZoneType` (LIGHT, MODERATE, VIGOROUS, PEAK); roll-up `timeInHeartRateZones[].{heartRateZone,duration}` | activity | synced: stream `zones`, dailyRollUp, into `zone_light`, `zone_moderate`, `zone_vigorous`, `zone_peak` (minutes) |
| `daily-vo2-max` | daily | `daily_vo2_max.date` | yes P (empty) | no D | **no P** ("list, reconcile") | no P | `vo2Max` (ml/kg/min), `cardioFitnessLevel`, `estimated`, `vo2MaxCovariance` | activity (I) | synced: stream `vo2`, list, every 6 h, into `vo2max`; the newest level and "estimated" flag into meta `vo2` |
| `vo2-max` | sample | `vo2_max.sample_time.physical_time` | yes P (empty) | no D | no D | not verified; not used | `vo2Max`, `measurementMethod` | activity (I) | synced: stream `vo2Samples`, list, every 12 h, into sample kind `vo2`; stands in for daily `vo2max` only when the daily type gives nothing |
| `run-vo2-max` | sample | `run_vo2_max.sample_time.physical_time` | yes P (empty) | yes D | yes P (empty) | not verified; not used | `runVo2Max`; roll-up `rateAvg`, `rateMin`, `rateMax` | activity (I) | synced: stream `vo2Run`, dailyRollUp, every 12 h, into `vo2max_run` |
| `exercise` | session | `exercise.interval.civil_start_time` | yes A | no D | no D | yes A | type, name, `activeDuration`, `metricsSummary` (calories, zone minutes, heart rate, steps, distance, pace, `heartRateZoneDurations`) | activity (read and write) | synced: stream `exercise`, into the `exercise` table (now with zone minutes, moving time, pace, device). Written by the workouts feature |

### Heart, breathing, oxygen, temperature

| type | kind | filter | list | rollUp | dailyRollUp | C/P/D | values | scope | what this app does |
|---|---|---|---|---|---|---|---|---|---|
| `heart-rate` | sample | `heart_rate.sample_time.physical_time` | yes A | yes A | yes P (14-day cap) | not verified; not used | `beatsPerMinute`; roll-up `beatsPerMinute{Avg,Min,Max}` | metrics | synced twice. Stream `hr`: the last three hours of samples, for the live pulse (meta `hr`). Stream `hrDay`: dailyRollUp, heavy, into `hr_min`, `hr_max`, `hr_avg` |
| `daily-resting-heart-rate` | daily | `daily_resting_heart_rate.date` | yes A | no D | **no P** (the document says its roll-up returns a "personal range"; the API answers "list, reconcile") | no P | `beatsPerMinute`, calculation method | metrics | synced: stream `rhr`, list, into `rhr`. `rhr_lo` / `rhr_hi` were planned from the roll-up and are dropped: it does not exist |
| `daily-heart-rate-variability` | daily | `daily_heart_rate_variability.date` | yes A | no D | **no P** (same as above) | no P | `averageHeartRateVariabilityMilliseconds`, `deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds`, `entropy`, `nonRemHeartRateBeatsPerMinute` | metrics | synced: stream `hrv`, list, into `hrv`, `hrv_deep`, `hrv_entropy`, `hrv_nonrem_hr`. `hrv_lo` / `hrv_hi` dropped for the same reason |
| `heart-rate-variability` | sample | `heart_rate_variability.sample_time.physical_time` | yes P | no D | no D | not verified; not used | `rootMeanSquareOfSuccessiveDifferencesMilliseconds`, `standardDeviationMilliseconds`, `metadata.{high,low}FrequencyPower` | metrics | synced only as a stand-in: stream `hrvSamples`, list, heavy. Read only for a device that sends no daily HRV; the mean RMSSD of a night becomes `hrv`. With a daily value the samples add nothing and are never asked for |
| `daily-oxygen-saturation` | daily | `daily_oxygen_saturation.date` | yes A (empty for the probed account) | no D | no D | not verified; not used | `averagePercentage`, `lowerBoundPercentage`, `upperBoundPercentage`, `standardDeviationPercentage` | metrics | synced: stream `spo2`, list, into `spo2`, `spo2_lo`, `spo2_hi`, `spo2_sd` |
| `oxygen-saturation` | sample | `oxygen_saturation.sample_time.physical_time` | yes P (empty) | no D | **no P** ("list, reconcile") | no P | `percentage` | metrics | synced reduced: stream `spo2Samples`, list, heavy, every 6 h. Not stored point by point: per day the lowest reading (`spo2_min`) and the mean (`spo2_mean`); the mean stands in for `spo2` only when there is no daily value |
| `daily-sleep-temperature-derivations` | daily | `daily_sleep_temperature_derivations.date` | yes A | no D | no D | not verified; not used | `nightlyTemperatureCelsius`, `baselineTemperatureCelsius`, `relativeNightlyStddev30dCelsius` | metrics | synced: stream `temp`, list, into `temp`, `temp_base`, `temp_sd`, `temp_dev` |
| `daily-respiratory-rate` | daily | `daily_respiratory_rate.date` | yes P | no D | **no P** ("list, reconcile") | no P | `breathsPerMinute` | metrics (I) | synced: stream `resp`, list, every 3 h, into `resp` |
| `respiratory-rate-sleep-summary` | sample | `respiratory_rate_sleep_summary.sample_time.physical_time` | yes P | no D | no D | not verified; not used | `{full,deep,light,rem}SleepStats.{breathsPerMinute,signalToNoise,standardDeviation}` | metrics (I) | synced: stream `respSleep`, list, every 3 h, into `resp_deep`, `resp_light`, `resp_rem`; the whole-night value stands in for `resp` when there is no daily one |
| `daily-heart-rate-zones` | daily | `daily_heart_rate_zones.date` | yes P | no D | no D | not verified; not used | `heartRateZones[].{heartRateZoneType,minBeatsPerMinute,maxBeatsPerMinute}` | metrics (I) | synced: stream `hrZones`, list of the last week, once a day. Only the newest thresholds are kept, as meta `hrZones` |
| `electrocardiogram` | session | `electrocardiogram.interval.start_time` with `>=` only | 403 without the scope P; with it, D | no D | no D | no (no write scope) D | classification, `beatsPerMinuteAvg`, `leadNumber`, `samplingFrequencyHertz`, `waveformSamples[]` | `ecg.readonly` (group `ecg`) | synced when the group is on: stream `ecg`, list, heavy, every 6 h, into sample kind `ecg`. The waveform is counted, not kept |
| `irregular-rhythm-notification` | session | `irregular_rhythm_notification.interval.civil_start_time` | 403 without the scope P; with it, D | no D | no D | no (no write scope) D | `alertWindows[]` with their heart beats | `irn.readonly` (group `ecg`) | synced when the group is on: stream `irn`, list, every 6 h, into sample kind `irn` (the beats summarised: lowest, highest, mean) |

### Sleep

| type | kind | filter | list | rollUp | dailyRollUp | C/P/D | values | scope | what this app does |
|---|---|---|---|---|---|---|---|---|---|
| `sleep` | session | `sleep.interval.end_time` | yes A | no D | no D | not verified; not used (`sleep.writeonly` is never asked for) | stages, `shortAwakenings[]`, `summary` (minutes asleep, awake, in the period, to fall asleep, after waking, per stage), `metadata` | sleep | synced: stream `sleep`, into the `sleep` table (now with the count of short awakenings, minutes after waking, the stages status) and daily `sleep_min`, `sleep_period`, `sleep_awake`, `sleep_efficiency`, `sleep_deep`, `sleep_rem`, `sleep_light`. The list returns no civil times: the wake date comes from the end offset |

### Body and measurements

| type | kind | filter | list | rollUp | dailyRollUp | C/P/D | values | scope | what this app does |
|---|---|---|---|---|---|---|---|---|---|
| `weight` | sample | `weight.sample_time.physical_time` | yes A | yes D | yes P | create A; patch and delete I | `weightGrams`, `notes` | metrics (read and write) | synced: stream `weight`, into the `weight` table. Written by the weight form (unchanged) |
| `body-fat` | sample | `body_fat.sample_time.physical_time` | yes A (empty for the probed account) | yes D | yes P (empty) | I | `percentage` | metrics (read and write) | synced: stream `bodyfat`, list, into daily `body_fat` and sample kind `bodyfat`. Can be logged here (kind `bodyfat`) |
| `height` | sample | `height.sample_time.physical_time` | yes P | no D | no D | I | `heightMillimeters` (int64) | metrics (read and write) | synced: stream `height`, list, once a day; the first read asks from the year 2000, because a height is typed in once. Into sample kind `height` and daily `height_mm`. Can be logged here |
| `blood-glucose` | sample | `blood_glucose.sample_time.physical_time` | yes P (empty) | yes D | yes P (empty) | I | `bloodGlucoseMilligramsPerDeciliter`, timing, meal, specimen, source, `notes` | metrics (read and write) | synced: stream `glucose`, list, hourly, into sample kind `glucose` only (never `daily`). Can be logged here |
| `core-body-temperature` | sample | `core_body_temperature.sample_time.physical_time` | yes P (empty) | yes D | yes P (empty) | I | `temperatureCelsius`, `measurementLocation` | metrics (read and write) | synced: stream `bodytemp`, list, hourly, into sample kind `bodytemp` only. Can be logged here |

### Nutrition

| type | kind | filter | list | rollUp | dailyRollUp | C/P/D | values | scope | what this app does |
|---|---|---|---|---|---|---|---|---|---|
| `hydration-log` | session | `hydration_log.interval.civil_start_time` | 403 without the scope P; with it, own writes only D | yes D | 403 without the scope P; yes D | I | `amountConsumed.milliliters` | `nutrition.writeonly` (group `nutrition`) | written (kind `water`) and synced when the group is on: stream `water`, list, into sample kind `water`. The list can only return what this app wrote; if it is refused the stream is marked unavailable and the local rows remain the truth |
| `nutrition-log` | session | `nutrition_log.interval.civil_start_time` | as above | yes D | as above | I | `foodDisplayName`, `mealType`, `energy.kcal`, `totalFat.grams`, `totalCarbohydrate.grams`, `nutrients[]` | `nutrition.writeonly` (group `nutrition`) | written as an anonymous food (kind `food`) and synced when the group is on: stream `food`, into sample kind `food` |
| `food` | lookup | none | 403 P; the document says a write-only caller is refused even its own | no | no | not verified; not used | a food database entry | `nutrition.writeonly` | **skipped.** A lookup table, not personal data. Food is logged by name with its own numbers |
| `food-measurement-unit` | lookup | none | not probed; the same rule as `food` D | no | no | not verified; not used | a unit's display name | `nutrition.writeonly` | **skipped.** A lookup table |

### Write-only logs

The API cannot list these four whatever scope is held (**P**: "List is not supported
for data type moods, but the following actions are supported: create, update,
batchDelete"). So what a person logs in Google's own app can never be shown here, and
only the write scope is asked for.

| type | kind | filter | list | rollUp | dailyRollUp | C/P/D | values | scope | what this app does |
|---|---|---|---|---|---|---|---|---|---|
| `moods` | sample | (cannot be listed) | **no P** | no D | no D | yes P (named by the API; not exercised) | `moods[]`, `valences[]` | `mindfulness.writeonly` (group `mindfulness`) | **written only**: kind `mood`. Mirrored out to Google, kept here. A note stays on this site: the type has no notes field |
| `symptoms` | sample | (cannot be listed) | **no P** | no D | no D | yes P | `symptoms[]` | `logged_symptoms.writeonly` (group `symptoms`) | **written only**: kind `symptom`. A note stays on this site |
| `menstrual-period` | interval | (cannot be listed) | **no P** | no D | no D | yes P | the interval, `notes` | `reproductive_health.writeonly` (group `cycle`) | **written only**: kind `period`, whole days in the person's zone |
| `ovulation-test` | sample | (cannot be listed) | **no P** | no D | no D | yes P | `result` | `reproductive_health.writeonly` (group `cycle`) | **written only**: kind `ovulation` |

### Roll-up only

Not members of the `DataPoint` union: they exist only as roll-ups.

| type | kind | filter | list | rollUp | dailyRollUp | C/P/D | values | scope | what this app does |
|---|---|---|---|---|---|---|---|---|---|
| `total-calories` | roll-up of intervals | (cannot be listed) | **no P** ("rollup, dailyRollup") | yes A | yes P (14-day cap) | no P | `kcalSum` | activity | synced: stream `kcal`, dailyRollUp in 14-day calls, into `kcal`. Also rolled up over a workout's own period |
| `calories-in-heart-rate-zone` | roll-up of intervals | (cannot be listed) | **no P** ("rollup, dailyRollup") | yes P (named) | yes P (14-day cap) | no P | `caloriesInHeartRateZones[].{heartRateZone,kcal}` | activity | synced: stream `zoneKcal`, dailyRollUp, heavy, into `zkcal_light`, `zkcal_moderate`, `zkcal_vigorous`, `zkcal_peak` |

## Counts

Of the 42 types: **35 are synced** (8 of them can also be written from here: exercise,
weight, body fat, height, glucose, body temperature, water, food), **4 are written
only** (moods, symptoms, periods, ovulation tests) and **3 are skipped** (`food` and
`food-measurement-unit` are lookups; `basal-energy-burned` has no roll-up and is derived).
The two roll-up-only types are both synced.

## Notes on what is inferred

- **Creates.** Nothing was written during the probe. Weight and exercise writes are in
  production use. For body fat, height, glucose and body temperature the write is
  inferred from the `health_metrics_and_measurements.writeonly` scope and the document's
  "Required" markings on their fields; for water and food from the `nutrition.writeonly`
  scope, which exists for nothing else. If one is refused the entry is kept here, marked
  `failed`, and retried a few times; nothing a person typed is lost.
- **Names.** Only identifiable points have a `name` and can be patched or deleted. The
  document does not list which types are identifiable. The probe saw names on weight,
  height, sleep, exercise and the respiratory-rate summary. This app proposes its own id
  on create (`.../dataPoints/ojee-<kind>-<uuid>`, 4 to 63 lowercase letters, digits and
  hyphens, as the document allows), keeps the name the create returns when there is one,
  and asks again without a name if the proposal is refused. An entry that ends up with no
  name is `create_only`: later edits and deletes stay on this site and the person is told.
- **A water or food log has an interval.** The schema wants a session interval; the app
  sends one minute starting at the logged time. That a zero-length interval would be
  refused is a guess, and the one-minute choice avoids finding out.
- **Reading back own nutrition writes.** The document says a caller holding only a write
  scope can list what it wrote itself. That could not be checked without the scope. Both
  outcomes are handled: rows that come back land on the rows already here (same Google
  name, else same kind and instant); a refusal marks the stream unavailable for a day.
- **Which scope a newer type sits under.** See "Scopes".
- **"not verified; not used"** in the create column means just that: the document's
  create method names `steps` as its example parent, so some of these can probably be
  written, but this app has no reason to and the probe wrote nothing.

## How the sync uses this

- A **roll-up** stream asks `dailyRollUp` for 90 days in one call, or in 14-day calls for
  the four capped types. `google.dailyRollUp` does the splitting.
- A **heavy** stream (`hrDay`, `zoneKcal`, `levels`, `spo2Samples`, `hrvSamples`, `ecg`)
  reads the last 14 days first and one 14-day chunk further back on each later run, until
  90 days are covered. Its state carries `backTo`.
- A stream with **`everyMs`** is not asked on every 20-minute run.
- A **403**, or a **400 "... is not supported ..."**, marks that one stream `unavailable`
  with Google's message and the time. The run carries on and is not a failure; the
  stream is asked again a day later. A 429, a dead network or a lost grant end the run.
- A first sync of a full account with every group on costs **55** calls (measured against
  the stand-in Google in `tests/sync-streams.test.js`); a routine run 20 to 26.

## Where each number lands

`daily` (one number per civil date; never anything sensitive): `steps`, `distance_m`,
`azm`, `azm_fat`, `azm_cardio`, `azm_peak`, `active_min`, `kcal`, `kcal_active`,
`kcal_basal`, `floors`, `altitude_m`, `sedentary_min`, `swim_strokes`, `zone_light`,
`zone_moderate`, `zone_vigorous`, `zone_peak`, `zkcal_light`, `zkcal_moderate`,
`zkcal_vigorous`, `zkcal_peak`, `level_sedentary`, `level_light`, `level_moderate`,
`level_very`, `rhr`, `hrv`, `hrv_deep`, `hrv_entropy`, `hrv_nonrem_hr`, `hr_min`,
`hr_max`, `hr_avg`, `spo2`, `spo2_lo`, `spo2_hi`, `spo2_sd`, `spo2_min`, `spo2_mean`,
`temp`, `temp_base`, `temp_sd`, `temp_dev`, `resp`, `resp_deep`, `resp_light`,
`resp_rem`, `vo2max`, `vo2max_run`, `sleep_min`, `sleep_period`, `sleep_awake`,
`sleep_efficiency`, `sleep_deep`, `sleep_rem`, `sleep_light`, `body_fat`, `height_mm`;
from a Garmin read directly (below): `stress`, `stress_max`, `stress_rest`, `stress_low`,
`stress_medium`, `stress_high`, `bb_high`, `bb_low`, `bb_charged`, `bb_drained`,
`garmin_sleep_score`.

`sample` (one row per reading or event; `value` is the headline number):

| kind | value | data | from |
|---|---|---|---|
| `water` | ml | - | logged here, read back |
| `food` | kcal | `name`, `meal`, `protein`, `carbs`, `fat` (grams) | logged here, read back |
| `mood` | -1, 0, 1 (unpleasant, neutral, pleasant) or null | `moods[]`, `valence`, `note` | logged here |
| `symptom` | how many symptoms | `symptoms[]`, `note` | logged here |
| `period` | days | `start`, `end` (civil dates), `note`; `t` to `end` are midnight to midnight | logged here |
| `ovulation` | 1 a surge or positive, 0 negative, null indeterminate | `result` | logged here |
| `glucose` | mg/dL | `timing`, `meal`, `specimen`, `via`, `note` | Google, or logged here |
| `bodytemp` | degrees Celsius | `location` | Google, or logged here |
| `height` | mm | - | Google, or logged here |
| `bodyfat` | percent | - | Google, or logged here |
| `vo2` | ml/kg/min | `method` | Google |
| `ecg` | average bpm | `classification`, `durationSec`, `leads`, `samplingHz`, `samples` (a count), `model` | Google |
| `irn` | how many analysis windows | `positive`, `minBpm`, `maxBpm`, `avgBpm`, `model` | Google |
| `stress` | 1 to 5 (very calm to very stressed) | `note` | logged here (this app's own scale; Google has no stress type) |
| `hrhours` | the day's mean bpm | `hours[]` `{ start, end, min, max, avg }` | Garmin, one row a day |
| `bbday` | the day's last Body Battery | `points[]` `[t, level]`, a quarter-hour apart | Garmin, one row a day |

Water, food, mood, symptom, period, ovulation, ECG and rhythm notices belong to the
optional groups and are sensitive; glucose and body temperature come under the core
scope and are treated the same way. None of them is ever written to `daily`, which is
the table that publishing and summaries read.

meta: `hrZones` (the person's zone thresholds, newest), `vo2` (the newest daily VO2
max with Google's fitness level), `groups` (which optional groups are switched on).


## Garmin, read directly

Google Health has no stress type and no Body Battery, and a Garmin that reaches Google
through Health Connect loses HRV, blood oxygen and stress on the way. So a Garmin can also
be read directly, through **Garmin's Personal API** (opened 2026-10-21): the person makes a
key on their own Garmin Connect account (connect.garmin.com/app/settings/personalApiToken;
30, 90 or 180 days or a year; shown once) and pastes it in Connections. `server/garmin.js`
swaps it for a bearer token (`POST /personalapitoken-service/personal-api/personal-api-key/token`
with `Authorization: ApiKey <key>`; the answer is the token as text, a JWT whose `exp` is
read; no refresh token, the key is swapped again) and reads with
`Authorization: Bearer <token>` from `https://personal.connectapi.garmin.com`.
`server/garminsync.js` writes what it reads into the person's Garmin store
(`src/garmin.sqlite`), in the same tables and shapes as Google's sync, and the fold
(`core/merge.js`) puts it with Google's.

**What is verified and what is not.** The paths and parameters are from Garmin's own
example client (garmin-personal-api, Apache-2.0). The shapes of the answers are not
documented by Garmin; they are taken to be Garmin Connect's own, as the community project
python-garminconnect knows them, and **none of it has been tried against a real key**. Every
reader tolerates a missing or renamed field (a day it cannot read is skipped, never a
failed sync), and an answer shaped otherwise is logged by its keys only, never its values,
when `GARMIN_DEBUG=1`. All the field names are in one place, `FIELDS` in `server/garmin.js`:
that is what to adjust once a real key has been used. The stand-in that the demo and the
tests use (`fakeGarmin` in `server/fake-sources.js`) answers in the same assumed shapes.

| read | path | how often | field (first that exists) | becomes |
|---|---|---|---|---|
| daily summaries | `GET /usersummary-service/v2/dailysummaries?startDate&endDate` (assumed `{ data: [...] }` or a list) | each pass, the last week; then a week further back | `totalSteps` | daily `steps` |
| | | | `totalDistanceMeters` | `distance_m` |
| | | | `totalKilocalories`, `activeKilocalories`, `bmrKilocalories` | `kcal`, `kcal_active`, `kcal_basal` |
| | | | `floorsAscended` | `floors` (rounded) |
| | | | `moderateIntensityMinutes`, `vigorousIntensityMinutes` | `active_min` = moderate + vigorous; `azm` = moderate + 2 x vigorous (Garmin counts vigorous double, as Google's zone minutes count cardio and peak double) |
| | | | `restingHeartRate`, `minHeartRate`, `maxHeartRate` | `rhr`, `hr_min`, `hr_max` |
| | | | `averageStressLevel`, `maxStressLevel` (-1, -2 = not enough data: dropped) | `stress`, `stress_max` |
| | | | `restStressDuration`, `lowStressDuration`, `mediumStressDuration`, `highStressDuration` (seconds) | `stress_rest`, `stress_low`, `stress_medium`, `stress_high` (minutes) |
| | | | `bodyBatteryHighestValue`, `bodyBatteryLowestValue`, `bodyBatteryChargedValue`, `bodyBatteryDrainedValue` | `bb_high`, `bb_low`, `bb_charged`, `bb_drained` |
| | | | `averageSpo2`, `lowestSpo2` | `spo2`, `spo2_min` (the per-day read below wins) |
| | | | `sedentarySeconds` | `sedentary_min` |
| daily steps | `GET /usersummary-service/stats/steps/daily/{start}/{end}` | only when the summaries gave nothing | `totalSteps`, `totalDistance` | `steps`, `distance_m` |
| daily stress | `GET /usersummary-service/stats/stress/daily/{start}/{end}` | with the summaries | `values.overallStressLevel`, `values.{rest,low,medium,high}StressDuration` | `stress`, `stress_*` (wins over the summaries) |
| HRV | `GET /hrv-service/hrv/daily/{start}/{end}` | with the summaries | `hrvSummaries[].lastNightAvg` | `hrv` |
| Body Battery | `GET /wellness-service/wellness/bodyBattery/reports/daily?startDate&endDate` | with the summaries | `charged`, `drained`, `bodyBatteryValuesArray` (`[t, level]`, or `[t, status, level, version]` by `bodyBatteryValueDescriptorDTOList`) | `bb_charged`, `bb_drained`, `bb_high`/`bb_low` from the curve; sample `bbday` |
| weight | `GET /weight-service/weight/range/{start}/{end}?includeAll=true` | with the summaries | `dailyWeightSummaries[].allWeightMetrics[].{timestampGMT, weight (grams), bodyFat}` | a weigh-in (`source: "garmin"`), daily `body_fat` and a `bodyfat` sample |
| activities | `GET /activitylist-service/activities/search/activities?start&limit&startDate&endDate` | with the summaries (100 at most a call) | `activityId`, `activityName`, `activityType.typeKey`, `startTimeGMT`, `startTimeLocal`, `elapsedDuration`, `movingDuration`, `calories`, `averageHR`, `distance`, `steps`, `averageSpeed`, `hrTimeInZone_1..5` | an `exercise` row `garmin-<id>`: type mapped to Google's exercise types (else `WORKOUT`), zones 1+2 light, 3 moderate, 4 vigorous, 5 peak, pace for runs, walks and hikes. One deleted in Garmin Connect goes here too. No route: the FIT file is not read |
| sleep | `GET /sleep-service/sleep/dailySleep?date` | each pass, the last three days; then a week of days back | `dailySleepDTO.{calendarDate, sleepStartTimestampGMT, sleepEndTimestampGMT, *Local, sleepTimeSeconds, deep/light/rem/awakeSleepSeconds, awakeCount, averageRespirationValue, averageSpO2Value, lowestSpO2Value, sleepScores.overall.value}`, `sleepLevels[].{startGMT, endGMT, activityLevel}` (0 deep, 1 light, 2 REM, 3 awake), `restingHeartRate`, `avgOvernightHrv` | a `sleep` row `garmin-sleep-<start>` with stages; `resp`, `spo2`, `spo2_min`, `rhr`, `hrv` (when HRV gave none), `garmin_sleep_score` |
| heart rate | `GET /wellness-service/wellness/dailyHeartRate?date` | as sleep | `restingHeartRate`, `heartRateValues` `[[ms, bpm], ...]` | `rhr`, `hr_min`, `hr_max`, `hr_avg`; sample `hrhours` (the day by the hour); meta `hr` (newest pulse) and `hrDense` (20 or more readings a day: a watch) |
| blood oxygen | `GET /wellness-service/wellness/daily/spo2acclimation/{date}` | as sleep | `avgSleepSpO2` (else `averageSpO2`), `lowestSpO2` | `spo2`, `spo2_min` |
| profile | `GET /userprofile-service/userprofile/settings` | once, when a key is pasted | (nothing kept) | proves the token reads |

Not read: hydration (water is an optional group's, logged here), food logs, fitness age,
heart-rate zones, menstrual cycle, wellness activity summaries, activity details and FIT
files, the intraday stress curve (no path for it in the Personal API's list). Skin
temperature and VO2 max are not among the reads either; a Venu 2 has no skin temperature.

**Gently.** A pass is about forty calls, a second apart (`GARMIN_GAP_MS`). Ranged reads ask
28 days at most (what Connect's own stats endpoints take; the Personal API's limits are not
published). A 429 ends the pass and waits Garmin's `Retry-After`, or a quarter of an hour
doubling to six hours; a network or server error waits five minutes doubling to two hours. A
read answered 403, 404 or 400 is left alone for a day and the rest carry on. A 401 swaps the
key again once; a second, or a refused swap, means the key has expired or was deleted:
Garmin is let go of (the key deleted here), what it brought is kept, and the person is told
to paste a new one.

**History.** 30 days by default, 90 or 365 on request, a week a pass (so a year takes most
of a day on the 20-minute clock).

**Google and Garmin together.** Nothing is added up across the two: per day and per kind of
number the first source's number is used and the other fills what it lacks. Garmin first is
the default (a person who connects a Garmin wants its numbers); Google first is the other
choice (Connections, Garmin). Nights and workouts both recorded (overlapping by half) are
kept once, the first source's; weigh-ins within ten minutes and 200 g likewise. Stress and
Body Battery are Garmin's either way. Disconnecting Garmin keeps what it brought, or takes
away what only it had.
