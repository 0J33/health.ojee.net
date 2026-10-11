/* Shared by the tests of "all the data": a person whose fake Google has
   granted some optional groups, and one entry of every kind with values
   that appear nowhere else (so a test can look for them where they must
   never be). */

import { pkce } from '../server/core/google.js';

/** Register a person, connect a persona with these groups granted and
    switched on, and sync once. */
export async function personWith(r, username, { persona = 'fitbit', groups = [], tz = 'Africa/Cairo', privacy = null } = {}) {
  const p = await r.person(username, { tz, privacy });
  r.parts.personaOf.set(p.id, persona);
  await r.app.worlds.hold(p.id, async (w) => {
    const pk = pkce();
    await w.google.exchange({ code: r.parts.issue(pk.challenge, r.parts.scopesFor(groups)), verifier: pk.verifier });
    if (groups.length) w.setGroups(groups);
    r.app.app.patchProfile(p.id, { googleState: 'ok' });
  });
  await r.app.syncUser(p.id);
  return p;
}

/** One entry per kind a person can log, each with a value or a word that
    nothing else in the app produces. `kind -> { body, marks }`: `marks`
    are the strings that give the entry away. */
export const SENTINELS = {
  water: { body: { ml: 3917.25 }, marks: ['3917.25'] },
  food: { body: { name: 'Zorblat stew', meal: 'DINNER', kcal: 7613.5, protein: 91.75 }, marks: ['Zorblat', '7613.5', '91.75'] },
  mood: { body: { moods: ['AWESTRUCK'], valence: 'UNPLEASANT', note: 'moodnote-qzx' }, marks: ['AWESTRUCK', 'awestruck', 'Awestruck', 'moodnote-qzx'] },
  symptom: { body: { symptoms: ['BURNING_MOUTH'], note: 'symptomnote-qzx' }, marks: ['BURNING_MOUTH', 'burning mouth', 'Burning mouth', 'symptomnote-qzx'] },
  period: { body: { note: 'periodnote-qzx' }, marks: ['periodnote-qzx'] },      // start and end are filled in by the test
  ovulation: { body: { result: 'ESTROGEN_SURGE' }, marks: ['ESTROGEN_SURGE', 'estrogen surge', 'Estrogen surge'] },
  glucose: { body: { mgdl: 613.25, timing: 'BEFORE_BED', note: 'gluconote-qzx' }, marks: ['613.25', 'gluconote-qzx'] },
  bodytemp: { body: { celsius: 41.73, location: 'URINARY_BLADDER' }, marks: ['41.73', 'URINARY_BLADDER', 'urinary bladder'] },
};
/** Rows no form can make (they are only ever read from Google), written
    straight into the store. */
export const SENTINEL_ROWS = [
  { kind: 'ecg', value: 147.31, data: { classification: 'SENTINEL_RHYTHM_QZX', durationSec: 30, leads: 1 }, marks: ['147.31', 'SENTINEL_RHYTHM_QZX', 'sentinel rhythm qzx', 'Sentinel rhythm qzx'] },
  { kind: 'irn', value: 3, data: { positive: true, minBpm: 43.19, maxBpm: 171.37, avgBpm: 99.99 }, marks: ['43.19', '171.37'] },
];
export const GROUP_OF = { water: 'nutrition', food: 'nutrition', mood: 'mindfulness', symptom: 'symptoms', period: 'cycle', ovulation: 'cycle', ecg: 'ecg', irn: 'ecg', glucose: null, bodytemp: null };
export const ALL_MARKS = [...Object.values(SENTINELS).flatMap((s) => s.marks), ...SENTINEL_ROWS.flatMap((s) => s.marks)];
