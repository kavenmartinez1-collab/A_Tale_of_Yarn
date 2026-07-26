/**
 * Deterministic tests for shared village memory (src/game/npc/village-memory.ts).
 * Pure CPU — no GPU, no server.  Run: npx tsx scripts/test-village-memory.mts
 *
 * The behaviour under test is a social one, so the assertions are about what a
 * player would notice: that the farmer standing next to the one you attacked
 * knows about it, that the one across the village does not yet, that hearsay
 * reads differently from having watched it, and that news does not instantly
 * turn a whole settlement hostile.
 */

import {
  createVillageMemory, recordVillageEvent, witnessesNear, spreadVillageNews,
  newsFor, dispositionFromNews, EVENT_DISPOSITION, VILLAGE_LOG_MAX,
  type VillageMemory,
} from '../src/game/npc/village-memory';
import { buildNpcRelations } from '../src/game/npc/npc-prompt';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

// A four-person village: two civilian pairs plus two guards.
const NPCS = [
  { id: 'n0', name: 'Petra', role: 'farmer' as const },
  { id: 'n1', name: 'Nils',  role: 'farmer' as const },
  { id: 'n2', name: 'Runa',  role: 'merchant' as const },
  { id: 'n3', name: 'Gorm',  role: 'guard' as const },
  { id: 'n4', name: 'Sven',  role: 'guard' as const },
];
const RELATIONS = buildNpcRelations(NPCS);

const fresh = (): VillageMemory => createVillageMemory();

// ---------------------------------------------------------------------------
// 1. Witnessing — the user's actual complaint
// ---------------------------------------------------------------------------

{
  // Petra and Nils are standing together; Runa is across the village.
  const standing = [
    { id: 'n0', x: 0, z: 0 },
    { id: 'n1', x: 4, z: 1 },
    { id: 'n2', x: 90, z: 40 },
  ];
  const saw = witnessesNear(standing, 0, 0, 30);
  check('the NPC beside the victim witnesses it', saw.includes('n1'));
  check('the victim witnesses it', saw.includes('n0'));
  check('an NPC across the village does not witness it', !saw.includes('n2'));

  const mem = fresh();
  recordVillageEvent(mem, 'Ashford', {
    id: 'e1', t: 100, kind: 'attacked_npc',
    subjectId: 'n0', subjectName: 'Petra', witnessed: saw,
  });

  const nils = newsFor(mem, 'Ashford', 'n1');
  check('the bystander now knows about it', nils.length === 1);
  check('the bystander knows it FIRSTHAND', nils[0].firsthand);
  check('the bystander names the victim', nils[0].text.includes('Petra'),
    nils[0].text);
  check('firsthand is phrased as having seen it',
    nils[0].text.startsWith('You saw'), nils[0].text);

  const petra = newsFor(mem, 'Ashford', 'n0');
  check('the victim refers to themselves as "me"',
    petra[0].text.includes('attacked me'), petra[0].text);

  check('the distant NPC knows nothing yet',
    newsFor(mem, 'Ashford', 'n2').length === 0);
}

// ---------------------------------------------------------------------------
// 2. Spread — and the fact that it is not instant
// ---------------------------------------------------------------------------

{
  const mem = fresh();
  recordVillageEvent(mem, 'Ashford', {
    id: 'e1', t: 100, kind: 'killed_npc',
    subjectId: 'n0', subjectName: 'Petra', witnessed: ['n1'],
  });

  check('before any spread, only the witness knows',
    newsFor(mem, 'Ashford', 'n2').length === 0);

  spreadVillageNews(mem, 'Ashford', RELATIONS, 1);
  const reached = ['n0','n1','n2','n3','n4']
    .filter((id) => newsFor(mem, 'Ashford', id).length > 0);
  check('one pass spreads a killing to the witness\'s relations',
    reached.length > 1, `reached ${reached.join(',')}`);

  // Hearsay must read differently — this is what makes it feel like a village
  // rather than a broadcast.
  const heard = ['n0','n2','n3','n4']
    .map((id) => newsFor(mem, 'Ashford', id))
    .flat()
    .filter((l) => !l.firsthand);
  check('secondhand knowledge is phrased as hearsay',
    heard.length > 0 && heard.every((l) => l.text.startsWith('You have heard')),
    heard[0]?.text ?? 'none');
}

{
  // A routine trade is dear gossip: it should NOT be all over the village.
  const mem = fresh();
  recordVillageEvent(mem, 'Ashford', {
    id: 't1', t: 100, kind: 'traded',
    subjectId: 'n2', subjectName: 'Runa', witnessed: ['n2'],
  });
  spreadVillageNews(mem, 'Ashford', RELATIONS, 1);
  const knowers = ['n0','n1','n2','n3','n4']
    .filter((id) => newsFor(mem, 'Ashford', id).length > 0);
  check('a routine trade does not immediately reach everyone',
    knowers.length < 5, `reached ${knowers.join(',')}`);
}

// ---------------------------------------------------------------------------
// 3. Consequences — and the ratio that stops a village flipping at once
// ---------------------------------------------------------------------------

{
  const mem = fresh();
  recordVillageEvent(mem, 'Ashford', {
    id: 'e1', t: 100, kind: 'killed_npc',
    subjectId: 'n0', subjectName: 'Petra', witnessed: ['n1'],
  });

  const sawIt = dispositionFromNews(mem, 'Ashford', 'n1');
  check('a witness to a killing is severely affected',
    sawIt === EVENT_DISPOSITION.killed_npc, `${sawIt}`);

  spreadVillageNews(mem, 'Ashford', RELATIONS, 2);
  const heardIt = dispositionFromNews(mem, 'Ashford', 'n2');
  check('hearsay still costs the player something', heardIt < 0, `${heardIt}`);
  check('but hearsay costs far less than witnessing',
    Math.abs(heardIt) < Math.abs(sawIt) / 2, `heard ${heardIt} vs saw ${sawIt}`);
  // The concrete failure this guards against: one killing making every NPC in
  // the settlement instantly 'hateful' (below -60), which would end the game's
  // social layer in a single swing.
  check('hearsay alone does not make a bystander hateful', heardIt > -60,
    `${heardIt}`);

  // Good deeds must work the same way, or the system is only a punishment.
  const good = fresh();
  recordVillageEvent(good, 'Ashford', {
    id: 'g1', t: 100, kind: 'helped', subjectId: 'n0', subjectName: 'Petra',
    witnessed: ['n1'],
  });
  check('being seen to help improves opinion',
    dispositionFromNews(good, 'Ashford', 'n1') > 0);
}

// ---------------------------------------------------------------------------
// 4. Bookkeeping
// ---------------------------------------------------------------------------

{
  const mem = fresh();
  const a = recordVillageEvent(mem, 'Ashford',
    { id: 'dup', t: 1, kind: 'stole', witnessed: ['n1'] });
  const b = recordVillageEvent(mem, 'Ashford',
    { id: 'dup', t: 9, kind: 'stole', witnessed: ['n2'] });
  check('re-recording the same event id does not duplicate it', a === b);
  check('...and does not add the second caller\'s witnesses',
    !a.known.includes('n2'));

  for (let i = 0; i < VILLAGE_LOG_MAX + 10; i++) {
    recordVillageEvent(mem, 'Ashford',
      { id: `x${i}`, t: i, kind: 'traded', witnessed: ['n1'] });
  }
  check('the log is capped', mem['Ashford'].length === VILLAGE_LOG_MAX);
  check('the cap drops the OLDEST entries',
    mem['Ashford'][mem['Ashford'].length - 1].id === `x${VILLAGE_LOG_MAX + 9}`);

  check('an unknown settlement yields no news',
    newsFor(mem, 'Nowhere', 'n1').length === 0);
  check('an unknown settlement yields no disposition shift',
    dispositionFromNews(mem, 'Nowhere', 'n1') === 0);
  check('spreading in an unknown settlement is a no-op',
    spreadVillageNews(mem, 'Nowhere', RELATIONS, 1) === 0);
}

{
  // Firsthand outranks hearsay in the prompt ordering, regardless of age.
  const mem = fresh();
  recordVillageEvent(mem, 'Ashford',
    { id: 'old', t: 1, kind: 'attacked_npc', subjectName: 'Petra', witnessed: ['n1'] });
  recordVillageEvent(mem, 'Ashford',
    { id: 'new', t: 999, kind: 'stole', witnessed: ['n2'] });
  spreadVillageNews(mem, 'Ashford', RELATIONS, 3);
  const lines = newsFor(mem, 'Ashford', 'n1');
  check('what an NPC saw is listed before what it was told',
    lines.length >= 2 && lines[0].firsthand && !lines[1].firsthand,
    lines.map((l) => `${l.firsthand ? 'saw' : 'heard'}`).join(','));
}

console.log(`\nvillage-memory: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
