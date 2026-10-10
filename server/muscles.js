/* ============================================================
   health.ojee.net — which muscle group an exercise name belongs to.

   Hevy exports (and people typing) name exercises freely: "Bench
   Press (Barbell)", "Lat Pulldown (Cable)", "RDL". Strength totals
   are per group, so the name is read loosely. Order matters: the
   first rule that matches wins, and the specific ones come first
   ("leg curl" is legs before "curl" is arms). A name nothing matches
   is `other`, and the import says which ones those were.
   ============================================================ */

export const MUSCLES = ['chest', 'back', 'shoulders', 'arms', 'legs', 'core', 'other'];

const RULES = [
  ['legs', /squat|leg (press|curl|extension)|lunge|deadlift|rdl|hip (thrust|abduct|adduct)|glute|calf|hamstring|quad|step.?up|leg day|bulgarian|good morning|sled|box jump|hack/],
  ['core', /crunch|plank|sit.?up|ab (wheel|roll)|abs|\bab\b|leg raise|knee raise|russian twist|oblique|hollow|woodchop|pallof|dead bug|mountain climber|core/],
  ['chest', /bench|chest|pec|push.?up|fly|flye|dip(?!.*tricep)|crossover/],
  ['shoulders', /shoulder|overhead press|military press|\bohp\b|arnold|lateral raise|front raise|rear delt|face pull|upright row|shrug|delt|press \(dumbbell\)|seated press/],
  ['back', /row|pull.?up|chin.?up|pulldown|pull down|lat |lats|back extension|hyperextension|t.?bar|pullover|rack pull|reverse fly/],
  ['arms', /curl|tricep|bicep|skull|pushdown|push down|kickback|hammer|preacher|forearm|wrist|close.?grip/],
];

export function muscleOf(name) {
  const n = String(name || '').toLowerCase();
  for (const [group, re] of RULES) if (re.test(n)) return group;
  return 'other';
}
