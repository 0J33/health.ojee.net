# Google OAuth verification (Google Health API)

Project `ojee-health` in Google Cloud. Updated 12 November 2026.

## Where it stands

| Part | State |
|---|---|
| Branding | **Verified and published (12 Nov).** Was saved: App name "rep.", the current plate logo (512 px), home page `https://rep.ojee.net`, privacy `https://rep.ojee.net/privacy`, terms `https://rep.ojee.net/terms`, authorized domain `ojee.net`. "Verify branding" is still to be pressed: the session I used was signed out by Google before I could (see below). |
| Domain | `ojee.net` is verified in Search Console under the same Google account, as verification needs. |
| Home page | Says what the app does and links privacy, terms and guidelines, in plain HTML too (`web/index.html` noscript) for crawlers. |
| Privacy policy | Has the Limited Use statement (the "Google user data" section). The AI section now matches it: health data only ever goes to models whose providers keep nothing and train on nothing (`server/core/writer.js` and `server/zen.js` `BLOCKED`). |
| Scopes | Restricted (all Google Health scopes are). **Restricted scopes need a CASA security assessment** (below) as well as the review. |
| Data access | Trimmed to the 14 scopes the code uses, features and justifications saved (12 Nov). |
| Demo video | To record (script below), then submit in Verification Center. |
| User cap | 12 of 100 used. Until verified, at most 100 people can ever connect Google. Android users can use Health Connect instead, iPhone users Apple Health. |

## 1. Branding: done (12 Nov)

Verified and published: the consent screen now shows "rep.", the plate logo and the rep.ojee.net links.

## 2. Data access: done (12 Nov)

The unused scopes are removed (also `profile.readonly` and `profile.writeonly`, which were listed too), the
features are "Health & wellness" and "Health coaching", and both justifications below are filled in and saved.
What is left on this page: the YouTube link of the demo video, then Verification Center → submit.

For the record, the list as it was:

The console lists 19 scopes. The code (`server/core/google.js`) asks for these 14 plus `openid` and `email`.
**Remove every other one** in Data Access → Add or remove scopes. Asking for less is what the
reviewers check first.

Keep:
```
googlehealth.activity_and_fitness.readonly
googlehealth.health_metrics_and_measurements.readonly
googlehealth.sleep.readonly
googlehealth.settings.readonly
googlehealth.health_metrics_and_measurements.writeonly
googlehealth.activity_and_fitness.writeonly
googlehealth.nutrition.writeonly
googlehealth.mindfulness.writeonly
googlehealth.logged_symptoms.writeonly
googlehealth.reproductive_health.writeonly
googlehealth.sleep.writeonly
googlehealth.ecg.readonly
googlehealth.irn.readonly
googlehealth.location.readonly
```
Remove (not used anywhere):
```
googlehealth.settings.writeonly
googlehealth.nutrition.readonly
googlehealth.reproductive_health.readonly
googlehealth.logged_symptoms.readonly
googlehealth.mindfulness.readonly
```

## 3. "How will the scopes be used?" (paste, under 1,000 characters each)

**Restricted scopes:**

> rep. (https://rep.ojee.net) is a personal health and training log. The person connects their own Google Health account so rep. can show their own data back to them: activity_and_fitness.readonly and health_metrics_and_measurements.readonly for steps, active minutes, workouts, heart rate, HRV, SpO2, weight; sleep.readonly for nights and stages; ecg.readonly and irn.readonly only if they turn on "ECG and rhythm notices"; location.readonly only when they tap "Allow route maps" on a run, to draw its route. The write-only scopes save what they log in rep. (a weigh-in, a workout, water and food, mood, symptoms, cycle, a night of sleep) to their own Google Health, each asked only with its feature. Google has no narrower scopes for these. Data is shown only to the person, and to friends only as they choose. It is never sold, never used for ads, never used to train AI.

**Sensitive scope (settings.readonly):**

> rep. shows the person's paired devices (battery level and last sync) on its Connections page so they know when their tracker needs charging or has stopped syncing. Only settings.readonly is used, to read the device list; nothing is written.

**What features will you use?** Tick the person-facing health and fitness dashboard, data sync, and
reading and writing the user's own records. Do not tick ads, analytics, or "sell".

## 4. The demo video (YouTube, unlisted)

Google wants one video that shows the OAuth consent screen with the client ID visible, then each
scope in use. Record the screen of a desktop browser, 3–5 minutes, in English, at 1080p. Use a test
Google account that has some Fitbit or Pixel data, not your own.

1. Open `https://rep.ojee.net`, sign in to a test rep. account, and go to Me → Connections → Accounts → Google Health → Connect.
2. On Google's screen, **click the address bar** so the whole URL shows, and scroll it so
   `client_id=433225307414-…` can be read. Hold for 3 seconds.
3. Show the consent screen with the app name "rep." and every scope listed, then press Continue.
4. Back in rep., show what each scope gives:
   - Today: steps, active minutes, heart rate, sleep.
   - Sleep: stages.
   - Health → Heart: HRV and SpO2.
   - Health → Body: weight.
   - Connections → Google Health: paired devices with battery (settings.readonly).
   - Log a weigh-in and show "Saved to Google Health" (weight write).
   - Log a workout and show it saved (activity write).
   - Log water, a mood, a symptom, a period and a night of sleep, each after turning on its group (the write-only scopes).
   - Turn on ECG and rhythm notices, and show a reading (ecg, irn).
   - On a run, tap "Allow route maps" and show the route (location.readonly).
5. Show the Privacy page's "Google user data" section, and Me → Privacy, where the person chooses what friends see.

Upload it to YouTube as **Unlisted** and paste the link into Data Access.

## 5. CASA security assessment (restricted scopes)

After the review starts, Google emails to ask for a CASA (Cloud Application Security Assessment)
Tier 2 report. It has to be renewed every year.
- Pick an authorized lab from https://appdefensealliance.dev/casa. TAC Security is the usual
  low-cost one, with a self-scan tier.
- It scans `rep.ojee.net` and asks a questionnaire about storage, encryption, access and logging.
  Encryption at rest (RELEASE.md, "Recommended") helps here.
- Expect a few hundred US dollars and two to four weeks.

## Why I could not finish it in the console

I worked in a copy of your Chrome profile. Partway through, Google signed that copy out, probably
because it noticed the same session in a second browser. That may have signed your own Chrome out
of these two Google accounts as well. If so, sign in again; nothing else changed.
