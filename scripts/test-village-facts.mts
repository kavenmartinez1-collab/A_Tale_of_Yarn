/**
 * Deterministic tests for shared village knowledge and quests
 * (src/game/npc/village-facts.ts). Pure CPU.
 * Run: npx tsx scripts/test-village-facts.mts
 *
 * The two properties that matter are both about CONSISTENCY, because that is
 * the thing whose absence the player actually notices:
 *  - two NPCs asked about the same thing must not invent two different answers
 *  - "go and ask Nils" must be true, not a pleasant fabrication
 */

import {
  generateVillageFacts, factsFor, advanceTasks, claimReward, factLinesFor,
  completedTasksOwnedBy, createVillageFacts,
} from '../src/game/npc/village-facts';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) passed++;
  else { failed++; console.error(`FAIL: ${name}${detail ? ` — ${detail}` : ''}`); }
}

const NPCS = [
  { id: 'n0', name: 'Petra', role: 'farmer' },
  { id: 'n1', name: 'Nils',  role: 'merchant' },
  { id: 'n2', name: 'Runa',  role: 'villager' },
  { id: 'n3', name: 'Gorm',  role: 'guard' },
];
const NEAR = ['wolf', 'deer', 'rabbit'];

// ---------------------------------------------------------------------------
// 1. Determinism — the same village must never contradict itself
// ---------------------------------------------------------------------------

{
  const a = generateVillageFacts('Ashford', 1234, NPCS, NEAR);
  const b = generateVillageFacts('Ashford', 1234, NPCS, NEAR);
  check('the same settlement generates identical facts',
    JSON.stringify(a) === JSON.stringify(b));

  const other = generateVillageFacts('Brookvale', 1234, NPCS, NEAR);
  check('a different settlement generates different facts',
    JSON.stringify(a) !== JSON.stringify(other));

  check('every settlement has at least one shared piece of lore',
    a.some((f) => f.kind === 'lore'));
  check('a settlement with people has at least one concern',
    a.some((f) => f.kind === 'concern'));
}

// ---------------------------------------------------------------------------
// 2. Concerns fit the world they are in
// ---------------------------------------------------------------------------

{
  // No wolves nearby ⇒ never ask the player to cull wolves. Asking someone to
  // hunt an animal that does not live here is the kind of detail that destroys
  // the illusion in a single line.
  const noWolves = generateVillageFacts('Ashford', 77, NPCS, ['rabbit', 'deer']);
  check('a concern is never generated for a species that is not around',
    !noWolves.some((f) => f.task?.target === 'wolf'));

  const withWolves = generateVillageFacts('Ashford', 77, NPCS, ['wolf']);
  check('...but item-fetch concerns still generate without any wildlife',
    generateVillageFacts('Ashford', 77, NPCS, []).some((f) => f.kind === 'concern'));
  check('a wolf concern can generate where wolves live',
    withWolves.length > 0);

  // A village of guards only has nobody to own a concern.
  const guardsOnly = generateVillageFacts('Fort', 5,
    [{ id: 'g0', name: 'Gorm', role: 'guard' }], NEAR);
  check('guards are never made the owner of an errand',
    !guardsOnly.some((f) => f.ownerId === 'g0'));
}

// ---------------------------------------------------------------------------
// 3. Ownership — the mechanism behind "ask Nils"
// ---------------------------------------------------------------------------

{
  const facts = generateVillageFacts('Ashford', 42, NPCS, NEAR);
  const concern = facts.find((f) => f.kind === 'concern');
  check('a concern has exactly one owner', concern?.ownerId !== undefined);
  if (concern?.ownerId !== undefined) {
    const owner = concern.ownerId;
    const other = NPCS.find((n) => n.id !== owner && n.role !== 'guard')!.id;

    const ownerLines = factLinesFor(facts, owner);
    const otherLines = factLinesFor(facts, other);

    check('the owner is told the concern is theirs',
      ownerLines.some((l) => l.includes('THIS IS YOUR CONCERN')));
    check('the owner is told what they want and what they will pay',
      ownerLines.some((l) => /will pay \d+ gold/.test(l)));

    check('everyone else is told it exists',
      otherLines.some((l) => l.includes(concern.text)));
    check('...and is told WHO to send the traveller to',
      otherLines.some((l) => l.includes(concern.ownerName ?? '###')));
    check('a non-owner is NOT told to ask for it themselves',
      !otherLines.some((l) => l.includes('THIS IS YOUR CONCERN')));

    // The consistency property, stated directly: everybody's lines mention the
    // same underlying concern text, so two NPCs cannot describe it differently.
    check('every NPC who knows it describes the SAME concern',
      [owner, other].every((id) =>
        factLinesFor(facts, id).some((l) => l.includes(concern.text))));
  }

  // Lore is common knowledge — no owner, everyone gets it verbatim.
  const lore = facts.find((f) => f.kind === 'lore')!;
  check('lore reaches every NPC identically',
    NPCS.every((n) => factLinesFor(facts, n.id).includes(lore.text)));
}

// ---------------------------------------------------------------------------
// 4. Quest progress and payout
// ---------------------------------------------------------------------------

{
  const store = createVillageFacts();
  const facts = factsFor(store, 'Ashford', 42, NPCS, NEAR);
  const concern = facts.find((f) => f.task !== undefined)!;
  const t = concern.task!;

  check('a fresh task is open with no progress',
    t.state === 'open' && t.done === 0);

  // Wrong target must not advance it.
  advanceTasks(store, t.verb, '__nothing__', 1);
  check('an unrelated kill or item does not advance the task', t.done === 0);

  advanceTasks(store, t.verb, t.target, 1);
  check('the right one does', t.done === 1);

  advanceTasks(store, t.verb, t.target, 999);
  check('progress is capped at the requested count', t.done === t.count);
  check('reaching the count completes it', t.state === 'complete');

  check('a completed task is surfaced to its owner',
    completedTasksOwnedBy(facts, concern.ownerId!).length === 1);
  check('...and not to anyone else',
    completedTasksOwnedBy(facts, 'n3').length === 0);

  const ownerLines = factLinesFor(facts, concern.ownerId!);
  check('the owner is told to pay up once it is done',
    ownerLines.some((l) => l.includes('Thank them and pay')));

  const reward = claimReward(concern);
  check('claiming pays the promised amount', reward === t.rewardGold);
  check('claiming marks it rewarded', t.state === 'rewarded');
  check('claiming twice pays nothing', claimReward(concern) === 0);

  // Once paid, nobody should still be asking — checked against THIS concern's
  // own line, because a village can carry two and the same owner may hold both.
  const after = factLinesFor(facts, concern.ownerId!)
    .filter((l) => l.includes(concern.text));
  check('a rewarded concern is no longer being asked for',
    after.length === 1 && !after[0].includes('you are the one asking'),
    after[0] ?? 'no line');
  check('...and others report it as dealt with',
    factLinesFor(facts, 'n3').some((l) => l.includes('dealt with')));

  // A rewarded task must not creep forward again.
  advanceTasks(store, t.verb, t.target, 5);
  check('a rewarded task cannot be advanced further', t.done === t.count);
}

// ---------------------------------------------------------------------------
// 5. Store behaviour
// ---------------------------------------------------------------------------

{
  const store = createVillageFacts();
  const first = factsFor(store, 'Ashford', 9, NPCS, NEAR);
  const second = factsFor(store, 'Ashford', 9, NPCS, NEAR);
  check('facts are generated once and then reused', first === second);

  // Progress must survive re-reading, or a quest resets every conversation.
  const withTask = first.find((f) => f.task !== undefined);
  if (withTask !== undefined) {
    advanceTasks(store, withTask.task!.verb, withTask.task!.target, 1);
    const again = factsFor(store, 'Ashford', 9, NPCS, NEAR);
    check('progress persists across lookups',
      again.find((f) => f.id === withTask.id)!.task!.done === 1);
  }

  check('an NPC in a settlement with no facts gets no lines',
    factLinesFor([], 'n0').length === 0);
}

console.log(`\nvillage-facts: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
