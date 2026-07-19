/**
 * Tests for src/game/effects.ts — pure timed-effects (buffs) model.
 * Run: npx tsx scripts/test-effects.mts
 *
 * Style matches test-vitals.mts: check() + summary + exit 1 on failure.
 */

import {
  EFFECTS_STORAGE_KEY,
  CLASS_DEFAULTS, EFFECT_TUNING,
  createEffects,
  applyItemEffects,
  stepEffects,
  effectWarmth, effectCooling, staminaRegenMult,
  serializeEffects, deserializeEffects,
  type EffectClass, type ActiveEffect, type EffectsState,
} from '../src/game/effects.js';

import { ITEM_DEFS } from '../src/game/items.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

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
// FNV-1a-32 (offset 0x811c9dc5, prime 0x01000193)
// ---------------------------------------------------------------------------

function fnv32a(str: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h  = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// ---------------------------------------------------------------------------
// 1. Module constants
// ---------------------------------------------------------------------------

check('EFFECTS_STORAGE_KEY', EFFECTS_STORAGE_KEY === 'artifex-effects:v1');

// CLASS_DEFAULTS covers all four effect classes
const CLASSES: EffectClass[] = ['heal', 'warm', 'cool', 'stamina'];
for (const cls of CLASSES) {
  check(`CLASS_DEFAULTS has entry for '${cls}'`, cls in CLASS_DEFAULTS);
  check(`CLASS_DEFAULTS[${cls}].durationS >= 0`, CLASS_DEFAULTS[cls].durationS >= 0);
  check(`CLASS_DEFAULTS[${cls}].magnitude >= 0`, CLASS_DEFAULTS[cls].magnitude >= 0);
}

// heal class must be instant (durationS === 0)
check('CLASS_DEFAULTS heal.durationS === 0', CLASS_DEFAULTS['heal'].durationS === 0);

// warm/cool/stamina must have positive duration
check('CLASS_DEFAULTS warm.durationS > 0',    CLASS_DEFAULTS['warm'].durationS > 0);
check('CLASS_DEFAULTS cool.durationS > 0',    CLASS_DEFAULTS['cool'].durationS > 0);
check('CLASS_DEFAULTS stamina.durationS > 0', CLASS_DEFAULTS['stamina'].durationS > 0);

// EFFECT_TUNING has entries for all effectClass items defined in items.ts
const effectClassItems = Object.keys(ITEM_DEFS).filter(
  id => (ITEM_DEFS as Record<string, { effectClass?: EffectClass }>)[id].effectClass !== undefined
);
check('items.ts has effectClass items', effectClassItems.length >= 4,
  `found: ${effectClassItems.join(', ')}`);
for (const id of effectClassItems) {
  check(`EFFECT_TUNING has entry for '${id}'`, id in EFFECT_TUNING);
}

// ---------------------------------------------------------------------------
// 2. createEffects defaults
// ---------------------------------------------------------------------------

{
  const s = createEffects();
  check('createEffects: effects is empty array', Array.isArray(s.effects) && s.effects.length === 0);
}

// ---------------------------------------------------------------------------
// 3. Query helpers on empty state
// ---------------------------------------------------------------------------

{
  const s = createEffects();
  check('effectWarmth empty === 0',     effectWarmth(s) === 0);
  check('effectCooling empty === 0',    effectCooling(s) === 0);
  check('staminaRegenMult empty === 1', staminaRegenMult(s) === 1);
}

// ---------------------------------------------------------------------------
// 4. Unknown / no-effectClass items ignored
// ---------------------------------------------------------------------------

{
  const s = createEffects();
  const hp = applyItemEffects(s, 'iron_sword', ITEM_DEFS);
  check('iron_sword (no effectClass) returns 0', hp === 0);
  check('iron_sword does not push effect',        s.effects.length === 0);

  const hp2 = applyItemEffects(s, 'totally_fake_item_xyz', ITEM_DEFS);
  check('unknown item returns 0',      hp2 === 0);
  check('unknown item no side effect', s.effects.length === 0);

  // Material with no effectClass
  const hp3 = applyItemEffects(s, 'logs', ITEM_DEFS);
  check('logs (no effectClass) returns 0', hp3 === 0);
  check('logs does not push effect',        s.effects.length === 0);
}

// ---------------------------------------------------------------------------
// 5. heal class — instant, not pushed to active list
// ---------------------------------------------------------------------------

{
  const s = createEffects();

  // healing_potion has effectClass 'heal'
  const hp = applyItemEffects(s, 'healing_potion', ITEM_DEFS);
  check('healing_potion returns instant heal magnitude', typeof hp === 'number');
  // magnitude 0 for heal (edible.heal already covers it)
  check('healing_potion instant heal magnitude === 0', hp === 0);
  check('healing_potion NOT pushed to active list',     s.effects.length === 0);

  // hearty_stew also has effectClass 'heal'
  const hp2 = applyItemEffects(s, 'hearty_stew', ITEM_DEFS);
  check('hearty_stew NOT pushed to active list', s.effects.length === 0);
  check('hearty_stew returns 0',                hp2 === 0);
}

// ---------------------------------------------------------------------------
// 6. warm class — pushed, warmth query active
// ---------------------------------------------------------------------------

{
  const s = createEffects();
  check('warmth before apply === 0', effectWarmth(s) === 0);

  applyItemEffects(s, 'warming_potion', ITEM_DEFS);
  check('warm effect pushed',              s.effects.length === 1);
  check('warm effect cls === warm',        s.effects[0].cls === 'warm');
  check('warm effect remainingS > 0',      s.effects[0].remainingS > 0);
  check('warm effect totalS > 0',          s.effects[0].totalS > 0);
  check('warm effect magnitude > 0',       s.effects[0].magnitude > 0);
  check('effectWarmth returns magnitude',  effectWarmth(s) === s.effects[0].magnitude);
  check('effectCooling still 0',           effectCooling(s) === 0);
  check('staminaRegenMult still 1',        staminaRegenMult(s) === 1);
}

// ---------------------------------------------------------------------------
// 7. cool class — pushed, cooling query active
// ---------------------------------------------------------------------------

{
  const s = createEffects();
  applyItemEffects(s, 'cooling_potion', ITEM_DEFS);
  check('cool effect pushed',              s.effects.length === 1);
  check('cool effect cls === cool',        s.effects[0].cls === 'cool');
  check('effectCooling returns magnitude', effectCooling(s) === s.effects[0].magnitude);
  check('effectWarmth still 0',            effectWarmth(s) === 0);
}

// ---------------------------------------------------------------------------
// 8. stamina class — pushed, staminaRegenMult query active
// ---------------------------------------------------------------------------

{
  const s = createEffects();
  applyItemEffects(s, 'stamina_potion', ITEM_DEFS);
  check('stamina effect pushed',              s.effects.length === 1);
  check('stamina effect cls === stamina',     s.effects[0].cls === 'stamina');
  const mult = staminaRegenMult(s);
  check('staminaRegenMult > 1 when active',   mult > 1,     `got ${mult}`);
  check('staminaRegenMult === 1 + magnitude', Math.abs(mult - (1 + s.effects[0].magnitude)) < 1e-12);
}

// ---------------------------------------------------------------------------
// 9. No stacking: same class applied twice stays one entry
// ---------------------------------------------------------------------------

{
  const s = createEffects();
  applyItemEffects(s, 'warming_potion', ITEM_DEFS);
  applyItemEffects(s, 'warming_potion', ITEM_DEFS);
  check('no stacking: still one entry after double-apply', s.effects.length === 1);
}

// ---------------------------------------------------------------------------
// 10. Refresh: re-applying same class resets duration
// ---------------------------------------------------------------------------

{
  const s = createEffects();
  applyItemEffects(s, 'warming_potion', ITEM_DEFS);
  const origTotal = s.effects[0].totalS;

  // Tick down 10 s
  stepEffects(s, 10);
  check('remainingS decremented after 10 s',
    Math.abs(s.effects[0].remainingS - (origTotal - 10)) < 1e-9);

  // Re-apply: duration should reset to tuning.durationS
  applyItemEffects(s, 'warming_potion', ITEM_DEFS);
  check('re-apply refreshes remainingS to totalS',
    Math.abs(s.effects[0].remainingS - origTotal) < 1e-9);
  check('still only one entry after refresh', s.effects.length === 1);
}

// ---------------------------------------------------------------------------
// 11. Strongest-wins: weaker re-apply does NOT lower magnitude
// ---------------------------------------------------------------------------

{
  // Construct a fake stronger effect manually, then try to overwrite with
  // a weaker one via a second apply.
  const s = createEffects();
  applyItemEffects(s, 'warming_potion', ITEM_DEFS);
  const originalMag = s.effects[0].magnitude;

  // Artificially inflate the magnitude to simulate a stronger first source
  s.effects[0].magnitude = originalMag + 1.0;
  const strongMag = s.effects[0].magnitude;

  // Apply warming_potion again (weaker magnitude)
  applyItemEffects(s, 'warming_potion', ITEM_DEFS);
  check('strongest magnitude kept on re-apply',
    s.effects[0].magnitude >= strongMag,
    `mag=${s.effects[0].magnitude}, expected >= ${strongMag}`);
  check('still one effect', s.effects.length === 1);
}

// ---------------------------------------------------------------------------
// 12. Strongest-wins: stronger re-apply DOES raise magnitude
// ---------------------------------------------------------------------------

{
  const s = createEffects();
  applyItemEffects(s, 'warming_potion', ITEM_DEFS);
  const weakMag = 0.1;
  s.effects[0].magnitude = weakMag;  // artificially weaken

  applyItemEffects(s, 'warming_potion', ITEM_DEFS);
  const tuningMag = EFFECT_TUNING['warming_potion']!.magnitude;
  check('stronger re-apply raises magnitude',
    s.effects[0].magnitude >= tuningMag,
    `mag=${s.effects[0].magnitude}, expected >= ${tuningMag}`);
}

// ---------------------------------------------------------------------------
// 13. Multiple classes coexist independently
// ---------------------------------------------------------------------------

{
  const s = createEffects();
  applyItemEffects(s, 'warming_potion', ITEM_DEFS);
  applyItemEffects(s, 'cooling_potion', ITEM_DEFS);
  applyItemEffects(s, 'stamina_potion', ITEM_DEFS);

  check('three classes coexist',    s.effects.length === 3);
  check('effectWarmth non-zero',    effectWarmth(s) > 0);
  check('effectCooling non-zero',   effectCooling(s) > 0);
  check('staminaRegenMult > 1',     staminaRegenMult(s) > 1);

  // Heal apply doesn't add entry
  applyItemEffects(s, 'healing_potion', ITEM_DEFS);
  check('heal does not add to three', s.effects.length === 3);
}

// ---------------------------------------------------------------------------
// 14. stepEffects — normal tick-down
// ---------------------------------------------------------------------------

{
  const s = createEffects();
  applyItemEffects(s, 'stamina_potion', ITEM_DEFS);
  const start = s.effects[0].remainingS;

  stepEffects(s, 1.0);
  check('step 1 s: remainingS decreased by 1',
    Math.abs(s.effects[0].remainingS - (start - 1.0)) < 1e-9,
    `got ${s.effects[0].remainingS}`);
  check('still alive after 1 s step', s.effects.length === 1);
}

// ---------------------------------------------------------------------------
// 15. stepEffects — expiry drops effect
// ---------------------------------------------------------------------------

{
  const s = createEffects();
  applyItemEffects(s, 'stamina_potion', ITEM_DEFS);
  const dur = s.effects[0].totalS;

  // Step just under full duration
  stepEffects(s, dur - 0.001);
  check('not expired just before duration', s.effects.length === 1,
    `remainingS=${s.effects[0].remainingS}`);

  // Step past expiry
  stepEffects(s, 0.01);
  check('expired and dropped after duration exceeded', s.effects.length === 0);

  // Query helpers return neutral after expiry
  check('effectWarmth 0 after expiry',    effectWarmth(s) === 0);
  check('staminaRegenMult 1 after expiry', staminaRegenMult(s) === 1);
}

// ---------------------------------------------------------------------------
// 16. stepEffects — multiple effects can expire independently
// ---------------------------------------------------------------------------

{
  const s = createEffects();
  applyItemEffects(s, 'warming_potion', ITEM_DEFS);   // 60 s
  applyItemEffects(s, 'stamina_potion', ITEM_DEFS);   // 45 s

  // Expire stamina but not warm
  const staminaDur = EFFECT_TUNING['stamina_potion']!.durationS;
  const warmDur    = EFFECT_TUNING['warming_potion']!.durationS;
  stepEffects(s, staminaDur + 0.1);

  check('stamina expired, warm still active', s.effects.length === 1,
    `effects: ${s.effects.map(e=>e.cls).join(',')}`);
  check('remaining effect is warm',           s.effects[0].cls === 'warm');
  check('effectWarmth still non-zero',        effectWarmth(s) > 0);
  check('staminaRegenMult back to 1',         staminaRegenMult(s) === 1);

  // Now expire warm too
  stepEffects(s, warmDur);
  check('warm expired, no effects left', s.effects.length === 0);
}

// ---------------------------------------------------------------------------
// 17. Exact effect values from ITEM_DEFS cross-check
// ---------------------------------------------------------------------------

// Verify items.ts effectClass assignments match our expectations
{
  const defs = ITEM_DEFS as Record<string, { effectClass?: EffectClass }>;
  check('healing_potion effectClass === heal',    defs['healing_potion']?.effectClass === 'heal');
  check('warming_potion effectClass === warm',    defs['warming_potion']?.effectClass === 'warm');
  check('cooling_potion effectClass === cool',    defs['cooling_potion']?.effectClass === 'cool');
  check('stamina_potion effectClass === stamina', defs['stamina_potion']?.effectClass === 'stamina');
  check('hearty_stew effectClass === heal',       defs['hearty_stew']?.effectClass === 'heal');
}

// ---------------------------------------------------------------------------
// 18. Serialize round-trip
// ---------------------------------------------------------------------------

{
  const s = createEffects();
  applyItemEffects(s, 'warming_potion', ITEM_DEFS);
  applyItemEffects(s, 'stamina_potion', ITEM_DEFS);
  stepEffects(s, 5.5);

  const json = serializeEffects(s);
  const restored = deserializeEffects(json);
  check('round-trip: not null',        restored !== null);
  check('round-trip: JSON matches',    JSON.stringify(restored) === JSON.stringify(s));
  check('round-trip: 2 effects',       restored !== null && restored.effects.length === 2);
}

// Empty state round-trip
{
  const s = createEffects();
  const json = serializeEffects(s);
  const restored = deserializeEffects(json);
  check('empty round-trip: not null',      restored !== null);
  check('empty round-trip: effects empty', restored !== null && restored.effects.length === 0);
}

// ---------------------------------------------------------------------------
// 19. deserializeEffects — rejects garbage
// ---------------------------------------------------------------------------

check('rejects malformed JSON',  deserializeEffects('{nope') === null);
check('rejects empty string',    deserializeEffects('') === null);
check('rejects null JSON',       deserializeEffects('null') === null);
check('rejects array top-level', deserializeEffects('[]') === null);
check('rejects missing v field', deserializeEffects('{"effects":[]}') === null);
check('rejects wrong version',   deserializeEffects('{"v":2,"effects":[]}') === null);
check('rejects missing effects', deserializeEffects('{"v":1}') === null);

// Bad effect entry: unknown cls
check('rejects unknown cls',
  deserializeEffects(JSON.stringify({
    v: 1,
    effects: [{ cls: 'poison', magnitude: 1, remainingS: 10, totalS: 10 }],
  })) === null);

// Bad effect entry: NaN magnitude
check('rejects NaN magnitude',
  deserializeEffects(JSON.stringify({
    v: 1,
    effects: [{ cls: 'warm', magnitude: NaN, remainingS: 10, totalS: 10 }],
  })) === null);

// Bad effect entry: negative remainingS
check('rejects negative remainingS',
  deserializeEffects(JSON.stringify({
    v: 1,
    effects: [{ cls: 'warm', magnitude: 0.5, remainingS: -1, totalS: 10 }],
  })) === null);

// Bad effect entry: non-object in array
check('rejects non-object in effects array',
  deserializeEffects(JSON.stringify({ v: 1, effects: [42] })) === null);

// ---------------------------------------------------------------------------
// 20. Deterministic multi-step simulation — FNV-1a-32 golden hash
//
// Scenario:
//   A. Apply warming_potion at t=0, stamina_potion at t=5.
//   B. Step 40 × (1/60) s — warming_potion active, stamina active.
//   C. Re-apply warming_potion (refresh) at t~0.67 s.
//   D. Apply cooling_potion at t~0.67 s.
//   E. Step 50 × (1/3) s — approaching stamina_potion expiry (45 s).
//   F. Apply stamina_potion again (refresh).
//   G. Step 100 × 0.5 s (50 s more) — warming/cooling still alive, stamina alive.
//   H. Collect snapshot of state as JSON trace string.
// ---------------------------------------------------------------------------

function runSimulation(): string {
  const s = createEffects();
  const trace: string[] = [];

  // A. Initial applies
  applyItemEffects(s, 'warming_potion', ITEM_DEFS);
  applyItemEffects(s, 'stamina_potion', ITEM_DEFS);

  // B. 40 steps × 1/60 s
  for (let i = 0; i < 40; i++) {
    stepEffects(s, 1 / 60);
  }
  trace.push(`B:w=${effectWarmth(s).toFixed(6)},c=${effectCooling(s).toFixed(6)},m=${staminaRegenMult(s).toFixed(6)}`);

  // C+D. Refresh warm, add cool
  applyItemEffects(s, 'warming_potion', ITEM_DEFS);
  applyItemEffects(s, 'cooling_potion', ITEM_DEFS);

  // E. 50 steps × 1/3 s (~16.67 s)
  for (let i = 0; i < 50; i++) {
    stepEffects(s, 1 / 3);
  }
  trace.push(`E:w=${effectWarmth(s).toFixed(6)},c=${effectCooling(s).toFixed(6)},m=${staminaRegenMult(s).toFixed(6)},n=${s.effects.length}`);

  // F. Refresh stamina
  applyItemEffects(s, 'stamina_potion', ITEM_DEFS);

  // G. 100 steps × 0.5 s (50 s)
  for (let i = 0; i < 100; i++) {
    stepEffects(s, 0.5);
  }
  trace.push(`G:w=${effectWarmth(s).toFixed(6)},c=${effectCooling(s).toFixed(6)},m=${staminaRegenMult(s).toFixed(6)},n=${s.effects.length}`);

  // Final state snapshot
  trace.push(JSON.stringify(s));
  return trace.join('|');
}

const simTrace = runSimulation();
const simHash  = fnv32a(simTrace);

// --- rebake: run once with GOLDEN_HASH = null to discover hash, then hard-code ---
const GOLDEN_HASH = 0x18d74601; // baked

check(
  `FNV-32 golden hash == 0x${GOLDEN_HASH.toString(16).padStart(8, '0')}`,
  simHash === GOLDEN_HASH,
  `got 0x${simHash.toString(16).padStart(8, '0')} — trace: ${simTrace}`,
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
