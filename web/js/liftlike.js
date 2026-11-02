/* What a weight lifted is like: everyday things and landmarks, by what
   they weigh, so a workout's volume (weight × reps over every set) and
   everything lifted so far can be said as "a polar bear" or "the Statue
   of Liberty". Weights are typical ones, rounded: they are for fun.

   SESSION: one workout's milestones, said as they are passed while
   logging. LIFETIME: everything lifted, said when a workout passes one. */

export const SESSION = [
  { kg: 100, a: 'a giant panda' },
  { kg: 250, a: 'a baby grand piano' },
  { kg: 500, a: 'a polar bear' },
  { kg: 750, a: 'a dairy cow' },
  { kg: 1_000, a: 'a giraffe' },
  { kg: 1_500, a: 'a family car' },
  { kg: 2_300, a: 'a white rhino' },
  { kg: 3_000, a: 'a pickup truck' },
  { kg: 4_500, a: 'an orca' },
  { kg: 6_000, a: 'an African elephant' },
  { kg: 8_000, a: 'a Tyrannosaurus rex' },
  { kg: 12_000, a: 'a city bus' },
  { kg: 15_000, a: 'a fire engine' },
  { kg: 20_000, a: 'a Black Hawk helicopter' },
  { kg: 30_000, a: 'a humpback whale' },
  { kg: 40_000, a: 'a fully loaded lorry' },
  { kg: 60_000, a: 'a battle tank' },
  { kg: 78_000, a: 'the Space Shuttle' },
  { kg: 150_000, a: 'a blue whale' },
];

export const LIFETIME = [
  { kg: 50_000, a: 'a fully loaded lorry' },
  { kg: 150_000, a: 'a blue whale' },
  { kg: 225_000, a: 'the Statue of Liberty' },
  { kg: 420_000, a: 'the International Space Station' },
  { kg: 600_000, a: 'an Airbus A380' },
  { kg: 1_000_000, a: 'a thousand tonnes: a freight train' },
  { kg: 2_900_000, a: 'a Saturn V rocket, fuelled' },
  { kg: 7_300_000, a: 'the Eiffel Tower\'s iron' },
  { kg: 14_000_000, a: 'the Golden Gate Bridge\'s steel' },
  { kg: 52_000_000, a: 'the Titanic' },
  { kg: 100_000_000, a: 'an aircraft carrier' },
];

/** The last milestone at or under `kg`, and the next one. */
export function stepOf(kg, ladder = SESSION) {
  let at = null;
  for (const m of ladder) if (kg >= m.kg) at = m;
  const next = ladder.find((m) => kg < m.kg) || null;
  return { at, next };
}

/** Milestones passed going from `a` to `b` (both kg), lowest first. */
export const passed = (a, b, ladder = SESSION) => ladder.filter((m) => a < m.kg && b >= m.kg);

/** "about 2 African elephants": a weight as so many of the biggest thing it holds whole. */
export function likeText(kg) {
  if (!(kg >= SESSION[0].kg)) return '';
  const { at } = stepOf(kg, SESSION);
  const n = Math.floor(kg / at.kg);
  if (n <= 1) return at.a;
  const noun = at.a.replace(/^(a|an|the) /, '');
  const many = /(ch|sh|s|x)$/.test(noun) ? `${noun}es` : noun.endsWith('y') && !/[aeiou]y$/.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`;
  return `${n} ${many}`;
}
