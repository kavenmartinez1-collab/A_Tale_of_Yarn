/**
 * Deterministic tests for per-NPC persistent memory (Phase N1).
 * Pure CPU — no GPU, no DOM, no localStorage.
 * Run: npx tsx scripts/test-npc-memory.mts
 */

import {
  createMemoryRecord, getOrCreateMemory, addFact, adjustDisposition,
  dispositionTone, detectThreat, loadMemoryMap, MAX_FACTS, REFUSE_CHAT_BELOW,
  adjustRomance, romanceTone, marry, spouseKeyOf, detectFlirt,
  ROMANCE_ACCEPT_AT, FLIRT_ROMANCE_GAIN,
  detectFollowRequest, detectStayRequest, FOLLOW_TRUST_AT, isRepetitiveReply,
  detectHomeRequest,
  type MemoryMap,
} from '../src/game/npc/npc-memory';
import {
  buildNpcSystemPrompt, npcGenderFor, buildNpcRelations, npcQuirkFor,
  type NpcPersona,
} from '../src/game/npc/npc-prompt';
import { extractNpcAction, stripNpcJson } from '../src/game/npc/npc-trade';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Record creation / getOrCreate
// ---------------------------------------------------------------------------

{
  const rec = createMemoryRecord();
  check('fresh record: disposition 0', rec.disposition === 0);
  check('fresh record: not met', rec.met === false);
  check('fresh record: no facts', rec.facts.length === 0);

  const map: MemoryMap = {};
  const a = getOrCreateMemory(map, 'Ashstead::npc_1_0');
  const b = getOrCreateMemory(map, 'Ashstead::npc_1_0');
  check('getOrCreateMemory: same object on repeat', a === b);
  check('getOrCreateMemory: inserted into map', map['Ashstead::npc_1_0'] === a);
  getOrCreateMemory(map, 'Ashstead::npc_1_1');
  check('getOrCreateMemory: distinct keys distinct records',
    map['Ashstead::npc_1_0'] !== map['Ashstead::npc_1_1']);
}

// ---------------------------------------------------------------------------
// 2. addFact — dedupe, cap, ordering
// ---------------------------------------------------------------------------

{
  const rec = createMemoryRecord();
  addFact(rec, 'bought 3x hide from me');
  addFact(rec, 'threatened my wife');
  check('addFact: appends in order',
    rec.facts[0] === 'bought 3x hide from me' && rec.facts[1] === 'threatened my wife');

  addFact(rec, 'bought 3x hide from me'); // dupe → moves to newest
  check('addFact: dedupe keeps one copy', rec.facts.length === 2);
  check('addFact: dupe moves to newest', rec.facts[1] === 'bought 3x hide from me');

  for (let i = 0; i < 10; i++) addFact(rec, `fact ${i}`);
  check(`addFact: capped at ${MAX_FACTS}`, rec.facts.length === MAX_FACTS,
    `got ${rec.facts.length}`);
  check('addFact: newest survives the cap', rec.facts[MAX_FACTS - 1] === 'fact 9');
  check('addFact: oldest forgotten', !rec.facts.includes('bought 3x hide from me'));

  addFact(rec, '   ');
  check('addFact: blank fact ignored', rec.facts.length === MAX_FACTS);
}

// ---------------------------------------------------------------------------
// 3. adjustDisposition — clamping
// ---------------------------------------------------------------------------

{
  const rec = createMemoryRecord();
  adjustDisposition(rec, -40);
  check('adjustDisposition: shifts down', rec.disposition === -40);
  adjustDisposition(rec, -100);
  check('adjustDisposition: clamps at -100', rec.disposition === -100);
  adjustDisposition(rec, 300);
  check('adjustDisposition: clamps at +100', rec.disposition === 100);
}

// ---------------------------------------------------------------------------
// 4. dispositionTone buckets + refuse threshold
// ---------------------------------------------------------------------------

check('tone: 50 → friendly', dispositionTone(50) === 'friendly');
check('tone: 25 → friendly', dispositionTone(25) === 'friendly');
check('tone: 0 → neutral', dispositionTone(0) === 'neutral');
check('tone: -24 → neutral', dispositionTone(-24) === 'neutral');
check('tone: -25 → cold', dispositionTone(-25) === 'cold');
check('tone: -59 → cold', dispositionTone(-59) === 'cold');
check('tone: -60 → hateful', dispositionTone(-60) === 'hateful');
check('tone: -100 → hateful', dispositionTone(-100) === 'hateful');
check('refuse threshold is in the cold band', dispositionTone(REFUSE_CHAT_BELOW) === 'cold');

// ---------------------------------------------------------------------------
// 5. loadMemoryMap — node fallback (no localStorage)
// ---------------------------------------------------------------------------

check('loadMemoryMap: returns {} without localStorage',
  Object.keys(loadMemoryMap()).length === 0);

// ---------------------------------------------------------------------------
// 6. Prompt injection
// ---------------------------------------------------------------------------

{
  const base: NpcPersona = {
    role: 'farmer', name: 'Ysolde', settlement: 'Brightwick Ranch', playerBounty: 0,
  };
  const plain = buildNpcSystemPrompt(base);
  check('prompt: no memory section when persona has none',
    !plain.includes('You remember about this traveller'));

  const withMem: NpcPersona = {
    ...base,
    met: true,
    disposition: -30,
    memoryFacts: ['threatened my wife', 'bought 2x meat_cooked from me'],
  };
  const p = buildNpcSystemPrompt(withMem);
  check('prompt: met line injected', p.includes('spoken with this traveller before'));
  check('prompt: facts injected',
    p.includes('threatened my wife') && p.includes('bought 2x meat_cooked from me'));
  check('prompt: cold tone hint injected', p.includes('distrust this traveller'));

  const friendly = buildNpcSystemPrompt({ ...base, disposition: 40 });
  check('prompt: friendly tone hint injected', friendly.includes('like this traveller'));

  const neutral = buildNpcSystemPrompt({ ...base, disposition: 0, met: false });
  check('prompt: neutral adds no tone hint', neutral === plain);

  const hateful = buildNpcSystemPrompt({ ...base, disposition: -80 });
  check('prompt: hateful tone hint injected', hateful.includes('despise this traveller'));
}

// ---------------------------------------------------------------------------
// 7. detectThreat — keyword scan (Phase N2)
// ---------------------------------------------------------------------------

check('threat: "I will kill you"', detectThreat('I will kill you') === 'threat');
check('threat: "hand over your gold"', detectThreat('Hand over the gold!') === 'threat');
check('threat: "I will steal your wife"',
  detectThreat("I'm going to steal your wife") === 'threat');
check('threat: "burn this place down"',
  detectThreat('I should burn this place down') === 'threat');
check('insult: "you are an idiot"', detectThreat('you are an idiot') === 'insult');
check('insult: "pathetic coward"', detectThreat('pathetic coward') === 'insult');
check('no threat: "hello there"', detectThreat('hello there, nice weather') === null);
check('no threat: "buy 2 bread"', detectThreat('can I buy 2 bread?') === null);
check('threat is case-insensitive', detectThreat('I WILL KILL YOU') === 'threat');

// ---------------------------------------------------------------------------
// 8. extractNpcAction — balanced-brace scan (Phase N2)
// ---------------------------------------------------------------------------

{
  const a = extractNpcAction('How dare you!\n{"action":"hostile","reason":"threatened my wife"}');
  check('extract: hostile with reason',
    a !== null && a.action === 'hostile' && a.reason === 'threatened my wife');

  const b = extractNpcAction('Stay away!\n{"action":"afraid","reason":"player has a sword"}');
  check('extract: afraid', b !== null && b.action === 'afraid');

  const c = extractNpcAction('Good day.\n{"action":"end"}');
  check('extract: end without reason', c !== null && c.action === 'end' && c.reason === undefined);

  check('extract: plain text → null', extractNpcAction('Just a normal chat.') === null);
  check('extract: trade JSON → null',
    extractNpcAction('{"trade":{"give":{"id":"bread","count":1},"want":{"id":"gold_small","count":3}}}') === null);
  check('extract: invalid action value → null',
    extractNpcAction('{"action":"dance"}') === null);

  const d = extractNpcAction('{"action":"end"} then {"action":"hostile","reason":"x"}');
  check('extract: last action wins', d !== null && d.action === 'hostile');

  const e = extractNpcAction('Wrapped in prose {"action":"afraid"} more prose.');
  check('extract: prose-wrapped works', e !== null && e.action === 'afraid');
}

// ---------------------------------------------------------------------------
// 9. Prompt contains the consequence rules
// ---------------------------------------------------------------------------

{
  const p = buildNpcSystemPrompt({
    role: 'villager', name: 'Wren', settlement: 'Greenford', playerBounty: 0,
  });
  check('prompt: consequence rules present', p.includes('CONSEQUENCES:'));
  check('prompt: hostile action documented', p.includes('"action":"hostile"'));
  check('prompt: afraid action documented', p.includes('"action":"afraid"'));
  check('prompt: end action documented', p.includes('{"action":"end"}'));
  const g = buildNpcSystemPrompt({
    role: 'guard', name: 'Gorm', settlement: 'Ashstead', playerBounty: 0,
  });
  check('prompt: guards get consequence rules too', g.includes('CONSEQUENCES:'));
}

// ---------------------------------------------------------------------------
// 10. Romance — meter, marriage, tone buckets (Phase N6)
// ---------------------------------------------------------------------------

{
  const rec = createMemoryRecord();
  check('fresh record: romance 0', rec.romance === 0);
  check('fresh record: not spouse', rec.spouse === false);
  check('fresh record: no gift yet', rec.lastGiftMs === 0);

  adjustRomance(rec, 30);
  check('adjustRomance: +30', rec.romance === 30);
  adjustRomance(rec, 200);
  check('adjustRomance: clamps at 100', rec.romance === 100);
  adjustRomance(rec, -500);
  check('adjustRomance: clamps at 0', rec.romance === 0);

  check('romanceTone: stranger', romanceTone(0) === 'stranger');
  check('romanceTone: warming', romanceTone(15) === 'warming');
  check('romanceTone: smitten', romanceTone(40) === 'smitten');
  check('romanceTone: in_love at threshold', romanceTone(ROMANCE_ACCEPT_AT) === 'in_love');
  check('FLIRT_ROMANCE_GAIN reaches threshold in <= 8 flirts',
    FLIRT_ROMANCE_GAIN * 8 >= ROMANCE_ACCEPT_AT);
}

{
  const map: MemoryMap = {};
  const a = getOrCreateMemory(map, 'Ashstead::npc_1_0');
  const b = getOrCreateMemory(map, 'Greenholm::npc_2_1');
  a.romance = 80;
  check('spouseKeyOf: null when unmarried', spouseKeyOf(map) === null);

  marry(map, 'Ashstead::npc_1_0');
  check('marry: spouse flag set', a.spouse === true);
  check('marry: romance -> 100', a.romance === 100);
  check('marry: disposition boosted', a.disposition >= 40);
  check('spouseKeyOf: finds spouse', spouseKeyOf(map) === 'Ashstead::npc_1_0');

  // Remarrying clears the previous spouse (one spouse at a time).
  b.romance = 90;
  marry(map, 'Greenholm::npc_2_1');
  check('marry: previous spouse cleared', a.spouse === false);
  check('marry: new spouse set', b.spouse === true);
  check('spouseKeyOf: tracks new spouse', spouseKeyOf(map) === 'Greenholm::npc_2_1');
}

// ---------------------------------------------------------------------------
// 11. detectFlirt — proposals win over flirts
// ---------------------------------------------------------------------------

{
  check('flirt: compliment', detectFlirt('You look beautiful today') === 'flirt');
  check('flirt: love declaration', detectFlirt('I love you, truly') === 'flirt');
  check('flirt: case-insensitive', detectFlirt('YOUR SMILE is radiant') === 'flirt');
  check('proposal: marry me', detectFlirt('Will you marry me?') === 'proposal');
  check('proposal: be my wife', detectFlirt('Be my wife!') === 'proposal');
  check('proposal: wins over flirt words', detectFlirt('You are beautiful — marry me') === 'proposal');
  check('flirt: plain chat -> null', detectFlirt('What do you sell?') === null);
  check('flirt: threat is not romance', detectFlirt('I will kill you') === null);
}

// ---------------------------------------------------------------------------
// 12. npcGenderFor — deterministic, both genders present
// ---------------------------------------------------------------------------

{
  check('gender: Hilda female', npcGenderFor('Hilda') === 'female');
  check('gender: Ulric male', npcGenderFor('Ulric') === 'male');
  check('gender: Ysolde female', npcGenderFor('Ysolde') === 'female');
  check('gender: Sven male', npcGenderFor('Sven') === 'male');
  check('gender: unknown name falls back male', npcGenderFor('Zzyzx') === 'male');
}

// ---------------------------------------------------------------------------
// 13. Prompt contains romance rules / spouse card
// ---------------------------------------------------------------------------

{
  const p = buildNpcSystemPrompt({
    role: 'villager', name: 'Wren', settlement: 'Greenford', playerBounty: 0,
    gender: 'female', romance: 0,
  });
  check('prompt: gendered card', p.includes('a woman working as a villager'));
  check('prompt: romance rules present', p.includes('ROMANCE:'));
  check('prompt: charmed action documented', p.includes('{"action":"charmed"}'));
  check('prompt: accept_proposal documented', p.includes('{"action":"accept_proposal"}'));
  check('prompt: not-in-love hint', p.includes('you are NOT'));

  const inLove = buildNpcSystemPrompt({
    role: 'villager', name: 'Wren', settlement: 'Greenford', playerBounty: 0,
    gender: 'female', romance: ROMANCE_ACCEPT_AT,
  });
  check('prompt: in-love hint', inLove.includes('you ARE'));

  const wed = buildNpcSystemPrompt({
    role: 'farmer', name: 'Beren', settlement: 'Greenford', playerBounty: 0,
    gender: 'male', romance: 100, spouse: true,
  });
  check('prompt: spouse card', wed.includes('MARRIED'));
  check('prompt: spouse card has no proposal rules', !wed.includes('accept_proposal'));
}

// ---------------------------------------------------------------------------
// 14. extractNpcAction — romance kinds
// ---------------------------------------------------------------------------

{
  const a = extractNpcAction('Oh, you flatterer.\n{"action":"charmed"}');
  check('extract: charmed', a !== null && a.action === 'charmed');
  const b = extractNpcAction('Yes, a thousand times yes!\n{"action":"accept_proposal"}');
  check('extract: accept_proposal', b !== null && b.action === 'accept_proposal');
  const c = extractNpcAction('I... cannot. Not yet.\n{"action":"reject_proposal"}');
  check('extract: reject_proposal', c !== null && c.action === 'reject_proposal');
}

// ---------------------------------------------------------------------------
// 14b. stripNpcJson — control JSON hidden from the chat bubble
// ---------------------------------------------------------------------------

{
  check('strip: action removed',
    stripNpcJson('You flatter me.\n{"action":"charmed"}') === 'You flatter me.');
  check('strip: trade removed',
    stripNpcJson('Deal!\n{"trade":{"give":{"id":"bread","count":1},"want":{"id":"gold_small","count":3}}}') === 'Deal!');
  check('strip: prose braces kept',
    stripNpcJson('The {old} well is dry.') === 'The {old} well is dry.');
  check('strip: only-JSON reply becomes empty',
    stripNpcJson('{"action":"end"}') === '');
  check('strip: prose-wrapped action',
    stripNpcJson('Begone! {"action":"hostile","reason":"insulted me"} I mean it.') ===
      'Begone!  I mean it.');
  check('strip: plain text untouched',
    stripNpcJson('Fine weather today.') === 'Fine weather today.');
}

// ---------------------------------------------------------------------------
// 15. buildNpcRelations + roster/world-facts prompt injection
// ---------------------------------------------------------------------------

{
  // Hilda(f) + Ulric(m) → married; Ysolde(f) + Runa(f) → sisters;
  // Sven(m) leftover → old friend of Hilda; guards are comrades.
  const settlers = [
    { id: 'npc_9_0', name: 'Hilda',  role: 'farmer'   as const },
    { id: 'npc_9_1', name: 'Ulric',  role: 'villager' as const },
    { id: 'npc_9_2', name: 'Ysolde', role: 'merchant' as const },
    { id: 'npc_9_3', name: 'Runa',   role: 'villager' as const },
    { id: 'npc_9_4', name: 'Sven',   role: 'farmer'   as const },
    { id: 'npc_9_5', name: 'Gorm',   role: 'guard'    as const },
    { id: 'npc_9_6', name: 'Keld',   role: 'guard'    as const },
  ];
  const rel = buildNpcRelations(settlers);
  check('relations: mixed pair married (her side)',
    rel.get('npc_9_0')?.get('npc_9_1') === 'your husband');
  check('relations: mixed pair married (his side)',
    rel.get('npc_9_1')?.get('npc_9_0') === 'your wife');
  check('relations: same-gender pair are sisters',
    rel.get('npc_9_2')?.get('npc_9_3') === 'your sister' &&
    rel.get('npc_9_3')?.get('npc_9_2') === 'your sister');
  check('relations: leftover is an old friend',
    rel.get('npc_9_4')?.get('npc_9_0') === 'your old friend' &&
    rel.get('npc_9_0')?.get('npc_9_4') === 'your old friend');
  check('relations: guards are comrades',
    rel.get('npc_9_5')?.get('npc_9_6') === 'your fellow guard');
  check('relations: guard unrelated to civilians',
    rel.get('npc_9_5')?.get('npc_9_0') === undefined);

  // Same-name pair falls back to neighbours (no self-marriage weirdness).
  const twins = buildNpcRelations([
    { id: 'a', name: 'Wren', role: 'villager' as const },
    { id: 'b', name: 'Wren', role: 'villager' as const },
  ]);
  check('relations: same-name pair are neighbours',
    twins.get('a')?.get('b') === 'your neighbour');

  const p = buildNpcSystemPrompt({
    role: 'farmer', name: 'Hilda', settlement: 'Greenford', playerBounty: 0,
    gender: 'female',
    neighbors: [
      { name: 'Ulric', role: 'villager', relation: 'your husband' },
      { name: 'Gorm', role: 'guard', relation: '' },
    ],
    worldFacts: ['Greenford is a village.', '2 horses graze by the settlement stable.'],
  });
  check('prompt: roster header', p.includes('PEOPLE OF Greenford'));
  check('prompt: relation line', p.includes('Ulric, villager — your husband'));
  check('prompt: relationless line', p.includes('- Gorm, guard') &&
    !p.includes('Gorm, guard —'));
  check('prompt: world facts injected', p.includes('AROUND YOU') &&
    p.includes('2 horses graze by the settlement stable.'));

  const bare = buildNpcSystemPrompt({
    role: 'farmer', name: 'Hilda', settlement: 'Greenford', playerBounty: 0,
  });
  check('prompt: no roster/facts sections when absent',
    !bare.includes('PEOPLE OF') && !bare.includes('AROUND YOU:'));
}

// ---------------------------------------------------------------------------
// 16. Follow/stay (Phase N8) — detection, actions, prompt gate, quirks
// ---------------------------------------------------------------------------

{
  // Request detection
  check('follow: "follow me" detected', detectFollowRequest('Please follow me!'));
  check('follow: "come with me" detected',
    detectFollowRequest('Come with me, I want to show you something'));
  check('follow: plain chat not detected', !detectFollowRequest('Nice weather today.'));
  check('stay: "stay here" detected', detectStayRequest('You should stay here now'));
  check('stay: "stop following" detected', detectStayRequest('stop following me'));
  check('stay: plain chat not detected', !detectStayRequest('Tell me about Ashford.'));

  // Action extraction accepts the new kinds
  const f = extractNpcAction('Aye, lead on.\n{"action":"follow"}');
  check('extract: follow action', f !== null && f.action === 'follow');
  const st = extractNpcAction('Farewell then.\n{"action":"stay"}');
  check('extract: stay action', st !== null && st.action === 'stay');
  check('strip: follow json removed',
    stripNpcJson('Aye, lead on.\n{"action":"follow"}') === 'Aye, lead on.');

  // Prompt trust gate
  const trusted = buildNpcSystemPrompt({
    role: 'villager', name: 'Dara', settlement: 'Greenford', playerBounty: 0,
    disposition: FOLLOW_TRUST_AT,
  });
  check('prompt: trusted NPC offered follow json',
    trusted.includes('{"action":"follow"}'));
  const stranger = buildNpcSystemPrompt({
    role: 'villager', name: 'Dara', settlement: 'Greenford', playerBounty: 0,
    disposition: 0,
  });
  check('prompt: stranger told to refuse',
    stranger.includes('do NOT trust them enough yet') &&
    !stranger.includes('{"action":"follow"}'));
  const followingP = buildNpcSystemPrompt({
    role: 'villager', name: 'Dara', settlement: 'Greenford', playerBounty: 0,
    following: true,
  });
  check('prompt: following NPC offered stay json',
    followingP.includes('{"action":"stay"}') &&
    followingP.includes('currently walking with this traveller'));

  // Quirks: deterministic per id, varied across ids
  check('quirk: deterministic', npcQuirkFor('npc_1_0') === npcQuirkFor('npc_1_0'));
  const quirks = new Set<string>();
  for (let i = 0; i < 24; i++) quirks.add(npcQuirkFor(`npc_7_${i}`));
  check('quirk: >= 5 distinct over 24 ids', quirks.size >= 5, `got ${quirks.size}`);
  const quirked = buildNpcSystemPrompt({
    role: 'villager', name: 'Dara', settlement: 'Greenford', playerBounty: 0,
    quirk: 'you have a dry, understated wit',
  });
  check('prompt: quirk line injected',
    quirked.includes('Quirk: you have a dry, understated wit.'));
}

// ---------------------------------------------------------------------------
// 16b. Invite home (Phase N9) — detection, action, prompt variants
// ---------------------------------------------------------------------------

{
  // Request detection
  check('home: "can we go in" detected', detectHomeRequest('Can we go in? It is freezing.'));
  check('home: "out of the rain" detected',
    detectHomeRequest('Let us get out of the rain, please'));
  check('home: "your house" detected', detectHomeRequest('Show me your house sometime'));
  check('home: "talk in private" detected', detectHomeRequest('Could we talk in private?'));
  check('home: plain chat not detected', !detectHomeRequest('Nice weather today.'));
  check('home: trade chat not detected', !detectHomeRequest('How much for two iron ingots?'));

  // Action extraction + strip
  const inv = extractNpcAction('Come, warm yourself.\n{"action":"invite_home"}');
  check('extract: invite_home action', inv !== null && inv.action === 'invite_home');
  check('strip: invite_home json removed',
    stripNpcJson('Come, warm yourself.\n{"action":"invite_home"}') === 'Come, warm yourself.');

  // Prompt variants
  const trustedHome = buildNpcSystemPrompt({
    role: 'villager', name: 'Dara', settlement: 'Greenford', playerBounty: 0,
    disposition: FOLLOW_TRUST_AT,
  });
  check('prompt: trusted NPC offered invite_home json',
    trustedHome.includes('{"action":"invite_home"}'));
  const strangerHome = buildNpcSystemPrompt({
    role: 'villager', name: 'Dara', settlement: 'Greenford', playerBounty: 0,
    disposition: 0,
  });
  check('prompt: stranger refused entry',
    strangerHome.includes('do NOT trust this traveller enough') &&
    !strangerHome.includes('{"action":"invite_home"}'));
  const insideHome = buildNpcSystemPrompt({
    role: 'villager', name: 'Dara', settlement: 'Greenford', playerBounty: 0,
    insideHome: true,
  });
  check('prompt: insideHome warm host, no re-invite',
    insideHome.includes('inside your home right now') &&
    !insideHome.includes('{"action":"invite_home"}'));
  const guardHome = buildNpcSystemPrompt({
    role: 'guard', name: 'Aldric', settlement: 'Greenford', playerBounty: 0,
    disposition: 50,
  });
  check('prompt: guard never invites',
    guardHome.includes('never invite travellers into the guardhouse') &&
    !guardHome.includes('{"action":"invite_home"}'));
  // Spouse trusts regardless of disposition.
  const spouseHome = buildNpcSystemPrompt({
    role: 'villager', name: 'Dara', settlement: 'Greenford', playerBounty: 0,
    disposition: 0, spouse: true,
  });
  check('prompt: spouse offered invite_home json',
    spouseHome.includes('{"action":"invite_home"}'));
}

// ---------------------------------------------------------------------------
// 17. isRepetitiveReply — cross-turn parrot detection
// ---------------------------------------------------------------------------

{
  const prior = [
    'Welcome to my stall, traveller. Iron ingots, leather, and fine potions await.',
    'The roads are dangerous at night, mind the wolves.',
  ];
  check('repeat: exact match detected',
    isRepetitiveReply('Welcome to my stall, traveller. Iron ingots, leather, and fine potions await.', prior));
  check('repeat: punctuation/case-insensitive',
    isRepetitiveReply('welcome to my stall traveller — iron ingots, leather, and fine potions await!', prior));
  check('repeat: near-verbatim (small tail change) detected',
    isRepetitiveReply('Welcome to my stall, traveller. Iron ingots, leather, and fine potions for you.', prior));
  check('repeat: fresh reply passes',
    !isRepetitiveReply('Ah, back again? The potions sold out but I still have leather.', prior));
  check('repeat: short reply exempt', !isRepetitiveReply('Aye.', ['Aye.']));
  check('repeat: empty prior passes',
    !isRepetitiveReply('Anything at all can be said first.', []));
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
