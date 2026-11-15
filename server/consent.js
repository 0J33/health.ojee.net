/* ============================================================
   health.ojee.net — what a person agreed to, and when.

   Kept on the profile (`consent`, JSON), each as the time it was given, and
   `versions`: the policy version (POLICY_VERSION) each was given under:

     terms     the Terms and Privacy, and being 18 or older: at signup
               (people from before it are asked once, on their next visit)
     health    rep. processing their health data and syncing it with the
               services they connect: asked once, before anything is read
     sharing   what friends, circles and boards are shown, and that it can
               be changed per kind: asked once, before the first post
     ai        AI summaries: off until turned on, with the kinds of data the
               AI may read (`allow`); { at, allow } or null. Strava's data
               never goes to it (ai.js).

   Nothing here changes what a feature does: it records that the person
   was told, and the AI reads only what they allowed.
   ============================================================ */

export const CONSENT_KINDS = ['terms', 'health', 'sharing', 'ai'];

/** The version of the Terms and Privacy policy a consent was given under: the "Last updated" date
    of web/privacy.html and web/terms.html. Kept beside each consent (`versions`), so it can be shown
    which text a person agreed to (Egypt's PDPL asks for proof of consent). Change it with the pages. */
export const POLICY_VERSION = '2026-11-15';

/** The health consent's own version: from this date it names the transfer outside Egypt (Google,
    Strava, Cloudflare, an AI provider), which the PDPL asks to be agreed to explicitly. Anyone who
    agreed to an older text is asked again, once. */
export const HEALTH_CONSENT_VERSION = '2026-11-12';

/** A consent given now: its time, and the policy version beside it. */
export function withConsent(c, kind, at) {
  // Given again (asked again for a newer text): the time it was first given stays, the version is now's.
  return { ...c, [kind]: c[kind] || at, versions: { ...(c.versions || {}), [kind]: POLICY_VERSION } };
}

/** What the AI may read, kind by kind, as the AI sheet offers them. */
export const AI_KINDS = {
  activity: 'Activity: steps, active minutes, calories, distance, floors, climb, time sitting and swims',
  sleep: 'Sleep: times, stages, efficiency and scores',
  heart: 'Heart: resting heart rate, heart rate through the day, zone minutes, HRV, VO2 max, SpO2, breathing, skin temperature, stress and recovery',
  body: 'Weight',
  bodycomp: 'Body composition: body fat, muscle, water, bone and the rest your scale estimates, height, BMI and tape measurements',
  workouts: 'Workouts: kind, time, heart rate, sets and routes (never Strava\'s)',
  logged: 'What you log: stress and how you felt',
  notes: 'Your notes about yourself',
  // Sensitive (catalog.js): each off until the person turns it on, even when they turn AI on.
  nutrition: 'Food and water you log',
  mood: 'Mood you log',
  cycle: 'Cycle: periods and ovulation tests',
  symptoms: 'Symptoms you log',
  vitals: 'Blood glucose and body temperature',
  ecg: 'ECG readings and irregular rhythm notices from your watch',
};
/** The kinds that are sensitive health data: never ticked for the person, only by them. */
export const AI_SENSITIVE = ['nutrition', 'mood', 'cycle', 'symptoms', 'vitals', 'ecg'];

export function normAiAllow(allow) {
  const out = {};
  for (const k of Object.keys(AI_KINDS)) out[k] = !!(allow && allow[k] === true);
  return out;
}

/** The consents as the app reads them, and what is still to be asked. */
export function consentView(c = {}) {
  const ai = c.ai && typeof c.ai === 'object' ? { at: c.ai.at || null, allow: normAiAllow(c.ai.allow) } : null;
  return {
    terms: c.terms || null, health: c.health || null, sharing: c.sharing || null, ai,
    versions: c.versions || {}, policyVersion: POLICY_VERSION,
    aiKinds: AI_KINDS, aiSensitive: AI_SENSITIVE,
    // Asked on the next visit, in this order; sharing only once the person posts or joins a board (the page asks then).
    needs: ['terms', 'health'].filter((k) => !c[k] || (k === 'health' && !((c.versions?.health || '') >= HEALTH_CONSENT_VERSION))),
  };
}

/** May the AI read this kind of data for this person. */
export const aiAllows = (c, kind) => !!(c?.ai?.allow && c.ai.allow[kind] === true);
