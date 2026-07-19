/**
 * Tests for src/game/vitals.ts — pure vitals model.
 * Run: npx tsx scripts/test-vitals.mts
 *
 * Style matches test-inventory.mts: check() + summary + exit 1 on failure.
 */

import {
  MAX_HP, MAX_THIRST, MAX_STAMINA,
  THIRST_DRAIN_PER_S, TEMP_MIN, TEMP_MAX,
  CLIMB_SLOPE_DEG, CLIMB_DRAIN_PER_S, CLIMB_DRAIN_STAFF_PER_S,
  SPRINT_DRAIN_PER_S, STAMINA_REGEN_PER_S, STAMINA_REGEN_DELAY_S,
  TEMP_DAMAGE_THRESHOLD, TEMP_DAMAGE_PERIOD_S, THIRST_DAMAGE_PERIOD_S,
  VITALS_KEY,
  createVitals, temperatureAt, stepVitals,
  damagePlayer, healPlayer, drinkPlayer, drainStamina,
  serializeVitals, deserializeVitals,
  type Vitals, type TempInputs, type StepEnv,
} from '../src/game/vitals';

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
// Helpers
// ---------------------------------------------------------------------------

/** Fresh neutral environment (biome plains, sea level, day, no warmth). */
function neutralEnv(overrides: Partial<StepEnv> = {}): StepEnv {
  return {
    biomeOffset:  0,
    altitude:     0,
    night:        false,
    campfireNear: false,
    heldTorch:    false,
    tentTier:     0,
    armorWarmth:  0,
    swimming:     false,
    hot:          false,
    draining:     false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Creation defaults
// ---------------------------------------------------------------------------

{
  const v = createVitals();
  check('createVitals: hp == MAX_HP',      v.hp === MAX_HP);
  check('createVitals: thirst == MAX_THIRST', v.thirst === MAX_THIRST);
  check('createVitals: stamina == MAX_STAMINA', v.stamina === MAX_STAMINA);
  check('createVitals: temperature == 0',  v.temperature === 0);
  check('createVitals: alive == true',     v.alive === true);
  check('createVitals: deathCause == null', v.deathCause === null);
  check('createVitals: thirstTickAccum == 0', v.thirstTickAccum === 0);
  check('createVitals: tempTickAccum == 0',   v.tempTickAccum === 0);
  check('createVitals: sinceDrainS == 0',     v.sinceDrainS === 0);
}

// ---------------------------------------------------------------------------
// 2. Constants exported
// ---------------------------------------------------------------------------

check('MAX_HP == 20',           MAX_HP === 20);
check('MAX_THIRST == 100',      MAX_THIRST === 100);
check('MAX_STAMINA == 100',     MAX_STAMINA === 100);
check('THIRST_DRAIN_PER_S ≈ 0.02', Math.abs(THIRST_DRAIN_PER_S - 1.2 / 60) < 1e-10);
check('TEMP_MIN == -3',         TEMP_MIN === -3);
check('TEMP_MAX == 3',          TEMP_MAX === 3);
check('CLIMB_SLOPE_DEG == 42',  CLIMB_SLOPE_DEG === 42);
check('CLIMB_DRAIN_PER_S == 20',       CLIMB_DRAIN_PER_S === 20);
check('CLIMB_DRAIN_STAFF_PER_S == 14', CLIMB_DRAIN_STAFF_PER_S === 14);
check('SPRINT_DRAIN_PER_S == 15',      SPRINT_DRAIN_PER_S === 15);
check('STAMINA_REGEN_DELAY_S == 1.5',  STAMINA_REGEN_DELAY_S === 1.5);
check('TEMP_DAMAGE_THRESHOLD == 2.5',  TEMP_DAMAGE_THRESHOLD === 2.5);
check('TEMP_DAMAGE_PERIOD_S == 4',     TEMP_DAMAGE_PERIOD_S === 4);
check('THIRST_DAMAGE_PERIOD_S == 5',   THIRST_DAMAGE_PERIOD_S === 5);
check('VITALS_KEY', VITALS_KEY === 'artifex-vitals:v1');

// ---------------------------------------------------------------------------
// 3. temperatureAt — neutral produces 0
// ---------------------------------------------------------------------------

{
  const inp: TempInputs = {
    biomeOffset: 0, altitude: 0, night: false,
    campfireNear: false, heldTorch: false, tentTier: 0,
    armorWarmth: 0, swimming: false,
  };
  check('temperatureAt neutral == 0', temperatureAt(inp) === 0);
}

// ---------------------------------------------------------------------------
// 4. temperatureAt — individual contributions
// ---------------------------------------------------------------------------

// Night penalty
{
  const t = temperatureAt({
    biomeOffset: 0, altitude: 0, night: true,
    campfireNear: false, heldTorch: false, tentTier: 0,
    armorWarmth: 0, swimming: false,
  });
  check('night: temperature == -0.8', Math.abs(t - (-0.8)) < 1e-9, `got ${t}`);
}

// Altitude penalty: 120 m → (120−20)*−0.015 = −1.5
{
  const t = temperatureAt({
    biomeOffset: 0, altitude: 120, night: false,
    campfireNear: false, heldTorch: false, tentTier: 0,
    armorWarmth: 0, swimming: false,
  });
  check('altitude 120 m: temperature == -1.5', Math.abs(t - (-1.5)) < 1e-9, `got ${t}`);
}

// Altitude below 20 m: no penalty
{
  const t = temperatureAt({
    biomeOffset: 0, altitude: 10, night: false,
    campfireNear: false, heldTorch: false, tentTier: 0,
    armorWarmth: 0, swimming: false,
  });
  check('altitude 10 m: no penalty, temperature == 0', t === 0, `got ${t}`);
}

// Desert biome offset +1.5 (daytime desert)
{
  const t = temperatureAt({
    biomeOffset: 1.5, altitude: 0, night: false,
    campfireNear: false, heldTorch: false, tentTier: 0,
    armorWarmth: 0, swimming: false,
  });
  check('desert day biomeOffset +1.5: temperature == 1.5', Math.abs(t - 1.5) < 1e-9, `got ${t}`);
}

// Alpine biome −2, night, high altitude: env = -2 + -0.8 + -(200-20)*0.015 = -2 - 0.8 - 2.7 = -5.5, clamped to -3
{
  const t = temperatureAt({
    biomeOffset: -2, altitude: 200, night: true,
    campfireNear: false, heldTorch: false, tentTier: 0,
    armorWarmth: 0, swimming: false,
  });
  check('alpine night + altitude: clamped to -3', t === TEMP_MIN, `got ${t}`);
}

// Swimming penalty: -1.0 (cold lake, flat)
{
  const t = temperatureAt({
    biomeOffset: 0, altitude: 0, night: false,
    campfireNear: false, heldTorch: false, tentTier: 0,
    armorWarmth: 0, swimming: true,
  });
  check('swimming: temperature == -1.0', Math.abs(t - (-1.0)) < 1e-9, `got ${t}`);
}

// ---------------------------------------------------------------------------
// 5. temperatureAt — max-not-sum for warming sources
// ---------------------------------------------------------------------------

// Single campfire: env = -2, campfire = +1.2 → -2 + 1.2 = -0.8
{
  const t = temperatureAt({
    biomeOffset: -2, altitude: 0, night: false,
    campfireNear: true, heldTorch: false, tentTier: 0,
    armorWarmth: 0, swimming: false,
  });
  check('cold + campfire only: -0.8', Math.abs(t - (-0.8)) < 1e-9, `got ${t}`);
}

// Single torch: env = -2, torch = +0.3 → -2 + 0.3 = -1.7
{
  const t = temperatureAt({
    biomeOffset: -2, altitude: 0, night: false,
    campfireNear: false, heldTorch: true, tentTier: 0,
    armorWarmth: 0, swimming: false,
  });
  check('cold + torch only: -1.7', Math.abs(t - (-1.7)) < 1e-9, `got ${t}`);
}

// Campfire + torch together: strongest = 1.2, 2+ sources → +0.2 bonus → effective=1.4
// env = -2 → result = -2 + 1.4 = -0.6
{
  const t = temperatureAt({
    biomeOffset: -2, altitude: 0, night: false,
    campfireNear: true, heldTorch: true, tentTier: 0,
    armorWarmth: 0, swimming: false,
  });
  check('campfire+torch: max-not-sum, NOT additive 1.5', t !== -0.5, `additive result would be -0.5, got ${t}`);
  check('campfire+torch: strongest=1.2 + 0.2 bonus → effective=1.4 → -0.6', Math.abs(t - (-0.6)) < 1e-9, `got ${t}`);
}

// All four sources: campfire=1.2, torch=0.3, wool_tent=0.8, armorWarmth=0.4
// strongest = 1.2, 4 sources active → +0.2 → effective=1.4
// env=-2 → -2+1.4 = -0.6
{
  const t = temperatureAt({
    biomeOffset: -2, altitude: 0, night: false,
    campfireNear: true, heldTorch: true, tentTier: 2,
    armorWarmth: 0.4, swimming: false,
  });
  check('all 4 sources: max(1.2,0.3,0.8,0.4)=1.2 + 0.2 = 1.4 → -0.6', Math.abs(t - (-0.6)) < 1e-9, `got ${t}`);
}

// tent alone (hide tier 3 = 1.1, single source, no bonus)
// env=-2 → -2 + 1.1 = -0.9
{
  const t = temperatureAt({
    biomeOffset: -2, altitude: 0, night: false,
    campfireNear: false, heldTorch: false, tentTier: 3,
    armorWarmth: 0, swimming: false,
  });
  check('hide tent only: -0.9', Math.abs(t - (-0.9)) < 1e-9, `got ${t}`);
}

// tent + armorWarmth: hide=1.1, armor=0.9 → max=1.1, 2 sources → +0.2 → effective=1.3
// env=-2 → -0.7
{
  const t = temperatureAt({
    biomeOffset: -2, altitude: 0, night: false,
    campfireNear: false, heldTorch: false, tentTier: 3,
    armorWarmth: 0.9, swimming: false,
  });
  check('hide tent + armor (0.9): max=1.1 +0.2 → 1.3 → -0.7', Math.abs(t - (-0.7)) < 1e-9, `got ${t}`);
}

// coolingBonus reduces heat side
// desert +1.5, cooling 0.5 → 1.5 - 0.5 = 1.0
{
  const t = temperatureAt({
    biomeOffset: 1.5, altitude: 0, night: false,
    campfireNear: false, heldTorch: false, tentTier: 0,
    armorWarmth: 0, swimming: false, coolingBonus: 0.5,
  });
  check('coolingBonus on hot side: 1.5 - 0.5 = 1.0', Math.abs(t - 1.0) < 1e-9, `got ${t}`);
}

// ---------------------------------------------------------------------------
// 6. Thirst drain timing: 60 s → ~1.2 drop
// ---------------------------------------------------------------------------

{
  const v = createVitals();
  const env = neutralEnv();
  stepVitals(v, 60, env);
  const expected = MAX_THIRST - 1.2;
  check('thirst after 60 s ≈ 98.8',
    Math.abs(v.thirst - expected) < 0.0001,
    `got ${v.thirst}`);
}

// Hot ×2.5: 60 s → 3.0 drop
{
  const v = createVitals();
  const env = neutralEnv({ hot: true });
  stepVitals(v, 60, env);
  const expected = MAX_THIRST - 3.0;
  check('thirst after 60 s hot ≈ 97.0',
    Math.abs(v.thirst - expected) < 0.0001,
    `got ${v.thirst}`);
}

// ---------------------------------------------------------------------------
// 7. Zero-thirst damage cadence
// ---------------------------------------------------------------------------

{
  const v = createVitals();
  v.thirst = 0;  // force dry
  const env = neutralEnv();

  // 4.9 s: below 5 s threshold — no damage yet
  stepVitals(v, 4.9, env);
  check('no damage at 4.9 s with zero thirst', v.hp === MAX_HP, `hp=${v.hp}`);

  // 0.2 s more = 5.1 s total → 1 tick fired
  stepVitals(v, 0.2, env);
  check('1 hp damage at 5.1 s zero thirst', v.hp === MAX_HP - 1, `hp=${v.hp}`);

  // Another 5 s → second tick
  stepVitals(v, 5, env);
  check('2 hp damage at 10.1 s zero thirst', v.hp === MAX_HP - 2, `hp=${v.hp}`);
}

// ---------------------------------------------------------------------------
// 8. Temperature band damage
// ---------------------------------------------------------------------------

// Cold at -2.5 (exactly at threshold): damage fires
{
  const v = createVitals();
  // Create env that produces -2.5: biome -2.5, no other factors
  const env = neutralEnv({ biomeOffset: -2.5 });
  stepVitals(v, 4.1, env);  // just over one tick
  check('cold at -2.5: 1 hp damage after 4.1 s', v.hp === MAX_HP - 1,
    `hp=${v.hp}, temp=${v.temperature}`);
  check('deathCause not set (still alive)', v.alive && v.deathCause === null);
}

// Safe at -2.4 (just inside safe band): no damage
{
  const v = createVitals();
  const env = neutralEnv({ biomeOffset: -2.4 });
  stepVitals(v, 4.1, env);
  check('safe at -2.4: no damage at 4.1 s', v.hp === MAX_HP,
    `hp=${v.hp}, temp=${v.temperature}`);
}

// Heat at +2.5: damage fires with cause 'heat'
{
  const v = createVitals();
  const env = neutralEnv({ biomeOffset: 2.5 });
  stepVitals(v, 4.1, env);
  check('heat at +2.5: 1 hp damage after 4.1 s', v.hp === MAX_HP - 1,
    `hp=${v.hp}`);
}

// Cold cause set on death from cold
{
  const v = createVitals();
  v.hp = 1;
  v.tempTickAccum = 3.9;  // prime the accumulator
  const env = neutralEnv({ biomeOffset: -2.5 });
  stepVitals(v, 0.2, env);
  check('death from cold: deathCause == cold', v.deathCause === 'cold',
    `cause=${v.deathCause}`);
  check('death from cold: alive == false', !v.alive);
  check('death from cold: hp == 0', v.hp === 0);
}

// ---------------------------------------------------------------------------
// 9. damagePlayer
// ---------------------------------------------------------------------------

{
  const v = createVitals();
  damagePlayer(v, 5, 'fall');
  check('damagePlayer: hp reduced by 5', v.hp === MAX_HP - 5, `hp=${v.hp}`);
  check('still alive after 5 dmg', v.alive);
  check('no deathCause before death', v.deathCause === null);

  // Kill
  damagePlayer(v, 100, 'combat');
  check('damagePlayer: hp == 0 after overkill', v.hp === 0, `hp=${v.hp}`);
  check('alive == false after kill', !v.alive);
  check('deathCause == combat', v.deathCause === 'combat');

  // No negative hp
  check('hp never negative', v.hp >= 0);

  // Damage after death is a no-op
  damagePlayer(v, 999, 'drowning');
  check('damage after death is no-op: hp stays 0', v.hp === 0);
  check('deathCause stays combat after post-death hit', v.deathCause === 'combat');
}

// ---------------------------------------------------------------------------
// 10. healPlayer
// ---------------------------------------------------------------------------

{
  const v = createVitals();
  damagePlayer(v, 10, 'fall');
  healPlayer(v, 4);
  check('healPlayer: hp restored by 4', v.hp === MAX_HP - 6, `hp=${v.hp}`);

  // Clamp to MAX_HP
  healPlayer(v, 999);
  check('healPlayer: clamped to MAX_HP', v.hp === MAX_HP, `hp=${v.hp}`);

  // Heal after death is no-op
  const dead = createVitals();
  damagePlayer(dead, 99, 'combat');
  healPlayer(dead, 10);
  check('heal after death is no-op', dead.hp === 0);
}

// ---------------------------------------------------------------------------
// 11. drinkPlayer
// ---------------------------------------------------------------------------

{
  const v = createVitals();
  v.thirst = 50;
  drinkPlayer(v, 30);
  check('drinkPlayer: thirst restored by 30', v.thirst === 80, `thirst=${v.thirst}`);

  // Clamp to MAX_THIRST
  drinkPlayer(v, 999);
  check('drinkPlayer: clamped to MAX_THIRST', v.thirst === MAX_THIRST, `thirst=${v.thirst}`);
}

// ---------------------------------------------------------------------------
// 12. Stamina: drain → exhausted → delay → regen
// ---------------------------------------------------------------------------

{
  const v = createVitals();

  // Drain 50 units (5 s at 10/s)
  const ok = drainStamina(v, 10, 5);
  check('drainStamina returns true when not exhausted', ok);
  check('stamina after 5 s drain at 10/s = 50', Math.abs(v.stamina - 50) < 1e-9, `stamina=${v.stamina}`);
  check('sinceDrainS reset to 0 after drain', v.sinceDrainS === 0);

  // Drain to zero
  drainStamina(v, 10, 5);
  check('stamina at 0 after full drain', v.stamina === 0);

  // Further drain returns false (exhausted)
  const exhausted = drainStamina(v, 10, 1);
  check('drainStamina returns false when exhausted', !exhausted);

  // Regen: step 1.4 s (below delay) — no regen
  const env = neutralEnv({ draining: false });
  stepVitals(v, 1.4, env);
  check('no regen at 1.4 s (< 1.5 s delay)', v.stamina === 0, `stamina=${v.stamina}`);

  // Step another 0.2 s: 1.4+0.2=1.6 s total sinceDrain (regen fires for 0.1 s worth)
  // After 1.4 s step, sinceDrainS=1.4.
  // After 0.2 s step, sinceDrainS=1.6 >= 1.5, regen for 0.2 s = 12*0.2 = 2.4
  stepVitals(v, 0.2, env);
  check('stamina regens after 1.6 s delay (2.4 units)', Math.abs(v.stamina - 2.4) < 0.001, `stamina=${v.stamina}`);
}

// ---------------------------------------------------------------------------
// 13. Stamina: climb constants exported correctly
// ---------------------------------------------------------------------------

check('CLIMB_SLOPE_DEG exported', typeof CLIMB_SLOPE_DEG === 'number' && CLIMB_SLOPE_DEG === 42);
check('CLIMB_DRAIN_PER_S exported', CLIMB_DRAIN_PER_S === 20);
check('CLIMB_DRAIN_STAFF_PER_S exported', CLIMB_DRAIN_STAFF_PER_S === 14);
check('SPRINT_DRAIN_PER_S exported', SPRINT_DRAIN_PER_S === 15);
check('STAMINA_REGEN_DELAY_S exported', STAMINA_REGEN_DELAY_S === 1.5);

// ---------------------------------------------------------------------------
// 14. Determinism: identical call sequences → identical state
// ---------------------------------------------------------------------------

{
  function runSequence(): Vitals {
    const v = createVitals();
    const env = neutralEnv({ biomeOffset: -1.5, night: true, altitude: 50 });
    for (let i = 0; i < 100; i++) {
      stepVitals(v, 1 / 60, env);
    }
    damagePlayer(v, 3, 'fall');
    drinkPlayer(v, 20);
    drainStamina(v, SPRINT_DRAIN_PER_S, 2);
    stepVitals(v, 0.5, neutralEnv());
    healPlayer(v, 2);
    return v;
  }

  const r1 = runSequence();
  const r2 = runSequence();
  check('determinism: identical sequences produce identical state',
    JSON.stringify(r1) === JSON.stringify(r2));
}

// ---------------------------------------------------------------------------
// 15. Serialize round-trip
// ---------------------------------------------------------------------------

{
  const v = createVitals();
  damagePlayer(v, 7, 'animal');
  v.thirst = 42.5;
  v.stamina = 77;
  v.temperature = -1.3;
  v.sinceDrainS = 0.8;
  v.thirstTickAccum = 2.1;
  v.tempTickAccum = 1.5;

  const json = serializeVitals(v);
  const restored = deserializeVitals(json);
  check('round-trip: not null', restored !== null);
  check('round-trip: JSON matches', JSON.stringify(restored) === JSON.stringify(v));
}

// Dead player round-trip
{
  const dead = createVitals();
  damagePlayer(dead, 99, 'lightning');
  const json = serializeVitals(dead);
  const restored = deserializeVitals(json);
  check('dead player round-trip', restored !== null && !restored.alive && restored.deathCause === 'lightning');
}

// ---------------------------------------------------------------------------
// 16. deserializeVitals — rejects garbage
// ---------------------------------------------------------------------------

check('rejects malformed JSON', deserializeVitals('{nope') === null);
check('rejects empty string',   deserializeVitals('') === null);
check('rejects null JSON',      deserializeVitals('null') === null);
check('rejects array',          deserializeVitals('[]') === null);

// NaN hp
check('rejects NaN hp', deserializeVitals(JSON.stringify({ ...createVitals(), hp: NaN })) === null);

// hp > MAX_HP
check('rejects hp > MAX_HP', deserializeVitals(JSON.stringify({ ...createVitals(), hp: MAX_HP + 1 })) === null);

// hp < 0
check('rejects hp < 0', deserializeVitals(JSON.stringify({ ...createVitals(), hp: -1 })) === null);

// wrong type for alive
check('rejects alive as number', deserializeVitals(JSON.stringify({ ...createVitals(), alive: 1 })) === null);

// unknown deathCause
check('rejects unknown deathCause', deserializeVitals(JSON.stringify({ ...createVitals(), deathCause: 'explosion' })) === null);

// NaN thirst
check('rejects NaN thirst', deserializeVitals(JSON.stringify({ ...createVitals(), thirst: NaN })) === null);

// thirst > MAX_THIRST
check('rejects thirst > MAX_THIRST', deserializeVitals(JSON.stringify({ ...createVitals(), thirst: MAX_THIRST + 0.1 })) === null);

// temperature out of range
check('rejects temperature < TEMP_MIN', deserializeVitals(JSON.stringify({ ...createVitals(), temperature: -4 })) === null);
check('rejects temperature > TEMP_MAX', deserializeVitals(JSON.stringify({ ...createVitals(), temperature: 4 })) === null);

// stamina > MAX_STAMINA
check('rejects stamina > MAX_STAMINA', deserializeVitals(JSON.stringify({ ...createVitals(), stamina: 101 })) === null);

// Graceful fallback: missing accumulators are repaired to 0 (not rejected)
{
  const plain = {
    hp: 10, thirst: 50, stamina: 80, temperature: 0,
    alive: true, deathCause: null,
    // intentionally omit the three accumulators
  };
  const v = deserializeVitals(JSON.stringify(plain));
  check('missing accumulators default to 0', v !== null && v.thirstTickAccum === 0 && v.sinceDrainS === 0);
}

// ---------------------------------------------------------------------------
// 17. FNV-32 golden: scripted 600-step scenario
// ---------------------------------------------------------------------------

/**
 * FNV-32a over the JSON snapshot of the final state.
 * The scenario mixes: cold night alpine, hot desert, thirst drain, damage,
 * heal, drink, stamina drain + exhaustion + regen, temperature band damage.
 */
function fnv32a(str: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function runGoldenScenario(): Vitals {
  const v = createVitals();

  // Phase A: 200 steps cold alpine night (dt=1/60)
  const alpineNight: StepEnv = {
    biomeOffset: -2, altitude: 150, night: true,
    campfireNear: false, heldTorch: false, tentTier: 0,
    armorWarmth: 0, swimming: false, hot: false, draining: false,
  };
  for (let i = 0; i < 200; i++) {
    stepVitals(v, 1 / 60, alpineNight);
  }

  // Campfire safety: move to campfire for 60 steps
  const campfireSafe: StepEnv = {
    biomeOffset: -2, altitude: 150, night: true,
    campfireNear: true, heldTorch: false, tentTier: 0,
    armorWarmth: 0, swimming: false, hot: false, draining: false,
  };
  for (let i = 0; i < 60; i++) {
    stepVitals(v, 1 / 60, campfireSafe);
  }

  // Drink and heal
  drinkPlayer(v, 30);
  healPlayer(v, 4);

  // Phase B: 100 steps desert heat
  const desertDay: StepEnv = {
    biomeOffset: 1.5, altitude: 0, night: false,
    campfireNear: false, heldTorch: false, tentTier: 0,
    armorWarmth: 0, swimming: false, hot: true, draining: false,
  };
  for (let i = 0; i < 100; i++) {
    stepVitals(v, 1 / 60, desertDay);
  }

  // Phase C: sprint stamina drain (50 steps, draining=true)
  const sprintEnv: StepEnv = {
    biomeOffset: 0, altitude: 0, night: false,
    campfireNear: false, heldTorch: false, tentTier: 0,
    armorWarmth: 0, swimming: false, hot: false, draining: true,
  };
  for (let i = 0; i < 50; i++) {
    drainStamina(v, SPRINT_DRAIN_PER_S, 1 / 60);
    stepVitals(v, 1 / 60, sprintEnv);
  }

  // Phase D: recover stamina (60 steps neutral)
  const restEnv = neutralEnv();
  for (let i = 0; i < 60; i++) {
    stepVitals(v, 1 / 60, restEnv);
  }

  // Phase E: take damage from multiple causes, then heal
  damagePlayer(v, 3, 'combat');
  damagePlayer(v, 2, 'fall');
  healPlayer(v, 1);

  // Phase F: swim in cold water (80 steps)
  const swimCold: StepEnv = {
    biomeOffset: -1, altitude: 0, night: false,
    campfireNear: false, heldTorch: false, tentTier: 0,
    armorWarmth: 0, swimming: true, hot: false, draining: false,
  };
  for (let i = 0; i < 80; i++) {
    stepVitals(v, 1 / 60, swimCold);
  }

  // Phase G: tent + armorWarmth + torch (50 steps)
  const shelterEnv: StepEnv = {
    biomeOffset: -2, altitude: 50, night: true,
    campfireNear: false, heldTorch: true, tentTier: 2,
    armorWarmth: 0.6, swimming: false, hot: false, draining: false,
  };
  for (let i = 0; i < 50; i++) {
    stepVitals(v, 1 / 60, shelterEnv);
  }

  return v;
}

const goldenResult = runGoldenScenario();
const goldenJson   = JSON.stringify(goldenResult);
const goldenHash   = fnv32a(goldenJson);
const GOLDEN_HASH  = 0x6e4e8940; // baked

check(
  `FNV-32 golden hash == 0x${GOLDEN_HASH.toString(16).padStart(8, '0')}`,
  goldenHash === GOLDEN_HASH,
  `got 0x${goldenHash.toString(16).padStart(8, '0')} — json: ${goldenJson}`,
);

// ---------------------------------------------------------------------------
// 18. Defense reduction in damagePlayer
// ---------------------------------------------------------------------------

// Physical causes (combat / guard / animal) are reduced.
// Non-physical (fall / thirst / cold / heat / drowning / lightning) are NOT.

{
  // 0 defense: no reduction
  const v = createVitals();
  damagePlayer(v, 10, 'combat', 0);
  check('defense=0: no reduction (combat)', Math.abs(v.hp - (MAX_HP - 10)) < 1e-9, `hp=${v.hp}`);
}

{
  // 5 defense: 5*4% = 20% reduction → effective = 8 (combat)
  const v = createVitals();
  damagePlayer(v, 10, 'combat', 5);
  const expected = MAX_HP - 10 * 0.80;
  check('defense=5: 20% reduction (combat)', Math.abs(v.hp - expected) < 1e-6, `hp=${v.hp}`);
}

{
  // 10 defense: 10*4% = 40% reduction → effective = 6 (guard)
  const v = createVitals();
  damagePlayer(v, 10, 'guard', 10);
  const expected = MAX_HP - 10 * 0.60;
  check('defense=10: 40% reduction (guard)', Math.abs(v.hp - expected) < 1e-6, `hp=${v.hp}`);
}

{
  // 15 defense: 15*4% = 60% reduction (capped) → effective = 4 (animal)
  const v = createVitals();
  damagePlayer(v, 10, 'animal', 15);
  const expected = MAX_HP - 10 * 0.40;
  check('defense=15: 60% cap (animal)', Math.abs(v.hp - expected) < 1e-6, `hp=${v.hp}`);
}

{
  // 20 defense: still capped at 60% → effective = 4
  const v = createVitals();
  damagePlayer(v, 10, 'combat', 20);
  const expected = MAX_HP - 10 * 0.40;
  check('defense=20: still 60% cap', Math.abs(v.hp - expected) < 1e-6, `hp=${v.hp}`);
}

{
  // Environmental cause (fall): defense has no effect
  const v = createVitals();
  damagePlayer(v, 10, 'fall', 15);
  check('defense ignored for fall', Math.abs(v.hp - (MAX_HP - 10)) < 1e-9, `hp=${v.hp}`);
}

{
  // Environmental cause (thirst): defense has no effect
  const v = createVitals();
  damagePlayer(v, 5, 'thirst', 15);
  check('defense ignored for thirst', Math.abs(v.hp - (MAX_HP - 5)) < 1e-9, `hp=${v.hp}`);
}

{
  // Environmental cause (cold): defense has no effect
  const v = createVitals();
  damagePlayer(v, 5, 'cold', 15);
  check('defense ignored for cold', Math.abs(v.hp - (MAX_HP - 5)) < 1e-9, `hp=${v.hp}`);
}

{
  // Environmental cause (lightning): defense has no effect
  const v = createVitals();
  damagePlayer(v, 5, 'lightning', 15);
  check('defense ignored for lightning', Math.abs(v.hp - (MAX_HP - 5)) < 1e-9, `hp=${v.hp}`);
}

{
  // Defense still kills (very low hp) — no floor below 0
  const v = createVitals();
  v.hp = 1;
  damagePlayer(v, 100, 'combat', 5);
  check('defense does not prevent death', !v.alive && v.hp === 0);
}

{
  // Default param (no 4th arg): backward-compatible with existing callers
  const v = createVitals();
  damagePlayer(v, 6, 'animal');
  check('backward compat: no defense arg = no reduction', Math.abs(v.hp - (MAX_HP - 6)) < 1e-9, `hp=${v.hp}`);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
