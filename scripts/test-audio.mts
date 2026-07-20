/**
 * Tests for src/game/audio — procedural WebAudio engine.
 * Run: npx tsx scripts/test-audio.mts
 *
 * Pure CPU — no AudioContext (guarded). Validates:
 *   - Module imports cleanly under Node (no AudioContext touch)
 *   - Pure helpers: envelopeAt, envelopeDuration, distanceGain, jitterFreq
 *   - SfxThrottler logic
 *   - Every documented SFX name has a valid recipe
 *   - Recipe data integrity (durations, envelope shapes, throttle values)
 */

import {
  distanceGain,
  envelopeDuration,
  envelopeAt,
  jitterFreq,
  SfxThrottler,
  GameAudio,
} from '../src/game/audio/audio-engine';

import {
  SFX_NAMES,
  SFX_RECIPES,
  type SfxName,
  type SfxRecipe,
} from '../src/game/audio/sfx';

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
// 1. Module imports without touching AudioContext
// ---------------------------------------------------------------------------

check('audio-engine imports under Node', typeof GameAudio === 'function');
check('sfx module imports under Node', typeof SFX_RECIPES === 'object');
check('SFX_NAMES is a non-empty array', Array.isArray(SFX_NAMES) && SFX_NAMES.length > 0);

// Constructing GameAudio under Node should NOT throw (AudioContext guarded)
let constructOk = true;
try {
  const _audio = new GameAudio();
  // resume() should be a no-op without AudioContext
  _audio.resume();
} catch {
  constructOk = false;
}
check('GameAudio constructor + resume() safe under Node', constructOk);

// ---------------------------------------------------------------------------
// 2. distanceGain
// ---------------------------------------------------------------------------

check('distanceGain(0) == 1', distanceGain(0) === 1);
check('distanceGain(50) == 0', distanceGain(50) === 0);
check('distanceGain(25) == 0.5', Math.abs(distanceGain(25) - 0.5) < 1e-9);
check('distanceGain(-5) == 1 (clamped)', distanceGain(-5) === 1);
check('distanceGain(100) == 0 (beyond max)', distanceGain(100) === 0);
check('distanceGain(10, 20) == 0.5 (custom max)', Math.abs(distanceGain(10, 20) - 0.5) < 1e-9);
check('distanceGain monotonically decreasing',
  distanceGain(0) > distanceGain(10) &&
  distanceGain(10) > distanceGain(20) &&
  distanceGain(20) > distanceGain(40));

// ---------------------------------------------------------------------------
// 3. envelopeDuration
// ---------------------------------------------------------------------------

check('envelopeDuration([0.01, 0.05, 0.1]) == 0.16',
  Math.abs(envelopeDuration([0.01, 0.05, 0.1]) - 0.16) < 1e-9);
check('envelopeDuration([0, 0, 0]) == 0', envelopeDuration([0, 0, 0]) === 0);
check('envelopeDuration([1, 2, 3]) == 6', Math.abs(envelopeDuration([1, 2, 3]) - 6) < 1e-9);

// ---------------------------------------------------------------------------
// 4. envelopeAt
// ---------------------------------------------------------------------------

{
  const env: [number, number, number] = [0.1, 0.2, 0.3];
  const peak = 0.8;

  // Before start
  check('envelopeAt t<0 == 0', envelopeAt(env, -0.05, peak) === 0);

  // During attack (linear ramp)
  const midAttack = envelopeAt(env, 0.05, peak);
  check('envelopeAt mid-attack ~= peak/2',
    Math.abs(midAttack - peak * 0.5) < 1e-9);

  // During hold (constant peak)
  check('envelopeAt mid-hold == peak',
    Math.abs(envelopeAt(env, 0.2, peak) - peak) < 1e-9);

  // During decay (linear ramp down)
  const midDecay = envelopeAt(env, 0.3 + 0.15, peak); // halfway through decay
  check('envelopeAt mid-decay ~= peak/2',
    Math.abs(midDecay - peak * 0.5) < 1e-9);

  // After envelope
  check('envelopeAt after envelope == 0', envelopeAt(env, 1.0, peak) === 0);

  // Edge: at exact boundaries
  check('envelopeAt at attack end == peak',
    Math.abs(envelopeAt(env, 0.1, peak) - peak) < 1e-9);
  check('envelopeAt at hold end == peak',
    Math.abs(envelopeAt(env, 0.3, peak) - peak) < 1e-9);
  check('envelopeAt at decay end == 0',
    Math.abs(envelopeAt(env, 0.6, peak)) < 1e-9);
}

// ---------------------------------------------------------------------------
// 5. jitterFreq
// ---------------------------------------------------------------------------

{
  // With deterministic "rng" returning 0.5, jitter should be exactly 1.0x
  const freq = jitterFreq(440, () => 0.5);
  check('jitterFreq(440, ()=>0.5) == 440', Math.abs(freq - 440) < 1e-9);

  // rng=0 -> 0.9x
  const freqLow = jitterFreq(440, () => 0);
  check('jitterFreq(440, ()=>0) == 396', Math.abs(freqLow - 396) < 1e-9);

  // rng=1 -> 1.1x
  const freqHigh = jitterFreq(440, () => 1);
  check('jitterFreq(440, ()=>1) == 484', Math.abs(freqHigh - 484) < 1e-9);

  // Range check: 100 random values all within +-10%
  let allInRange = true;
  for (let i = 0; i < 100; i++) {
    const f = jitterFreq(1000, Math.random);
    if (f < 900 || f > 1100) { allInRange = false; break; }
  }
  check('jitterFreq always within +-10%', allInRange);
}

// ---------------------------------------------------------------------------
// 6. SfxThrottler
// ---------------------------------------------------------------------------

{
  const throttler = new SfxThrottler();

  // First call always allowed
  check('throttler: first call allowed',
    throttler.allow('test', 250, 1000));

  // Immediate repeat blocked
  check('throttler: immediate repeat blocked',
    !throttler.allow('test', 250, 1050));

  // After window passes, allowed again
  check('throttler: allowed after window',
    throttler.allow('test', 250, 1260));

  // Different names don't interfere
  check('throttler: different name allowed',
    throttler.allow('other', 250, 1050));

  // Exact boundary: at exactly throttleMs apart, should allow
  check('throttler: exact boundary allows',
    throttler.allow('boundary', 100, 2000) &&
    !throttler.allow('boundary', 100, 2099) &&
    throttler.allow('boundary', 100, 2100));

  // Reset clears state
  throttler.reset();
  check('throttler: reset clears state',
    throttler.allow('test', 250, 0));

  // Zero throttle: always allows
  check('throttler: zero throttle always allows',
    throttler.allow('zero', 0, 100) &&
    throttler.allow('zero', 0, 100));
}

// ---------------------------------------------------------------------------
// 7. Every documented SFX name has a recipe
// ---------------------------------------------------------------------------

{
  const expectedNames: SfxName[] = [
    'footstep_grass', 'footstep_stone', 'swing', 'hit', 'hurt',
    'pickup', 'craft', 'ui_click', 'chest_open', 'thunder',
    'splash', 'eat_drink', 'level_chime', 'growl', 'dragon_roar',
  ];

  for (const name of expectedNames) {
    const recipe = SFX_RECIPES[name];
    check(`recipe exists: ${name}`, recipe !== undefined);
    if (recipe) {
      check(`recipe '${name}' has matching name field`, recipe.name === name);
    }
  }

  // All SFX_NAMES entries have recipes
  for (const name of SFX_NAMES) {
    check(`SFX_NAMES entry '${name}' has recipe`, name in SFX_RECIPES);
  }

  // expectedNames matches SFX_NAMES exactly
  check('SFX_NAMES count == 15', SFX_NAMES.length === 15);
  check('all expected names are in SFX_NAMES',
    expectedNames.every(n => (SFX_NAMES as readonly string[]).includes(n)));
}

// ---------------------------------------------------------------------------
// 8. Recipe data integrity
// ---------------------------------------------------------------------------

{
  for (const name of SFX_NAMES) {
    const recipe: SfxRecipe = SFX_RECIPES[name];

    // Duration > 0
    check(`recipe '${name}' duration > 0`, recipe.duration > 0);

    // ThrottleMs >= 0
    check(`recipe '${name}' throttleMs >= 0`, recipe.throttleMs >= 0);

    // Has at least one layer (osc or noise)
    const hasLayers = (recipe.osc && recipe.osc.length > 0) ||
                      (recipe.noise && recipe.noise.length > 0);
    check(`recipe '${name}' has at least one layer`, !!hasLayers);

    // Validate osc layers
    if (recipe.osc) {
      for (let i = 0; i < recipe.osc.length; i++) {
        const layer = recipe.osc[i];
        check(`recipe '${name}' osc[${i}] freq > 0`, layer.freq > 0);
        check(`recipe '${name}' osc[${i}] envelope[0] >= 0`, layer.envelope[0] >= 0);
        check(`recipe '${name}' osc[${i}] envelope[1] >= 0`, layer.envelope[1] >= 0);
        check(`recipe '${name}' osc[${i}] envelope[2] > 0`, layer.envelope[2] > 0);
        if (layer.gain !== undefined) {
          check(`recipe '${name}' osc[${i}] gain in (0,1]`,
            layer.gain > 0 && layer.gain <= 1);
        }
        const validTypes = ['sine', 'square', 'sawtooth', 'triangle'];
        check(`recipe '${name}' osc[${i}] valid type`,
          validTypes.includes(layer.type));
      }
    }

    // Validate noise layers
    if (recipe.noise) {
      for (let i = 0; i < recipe.noise.length; i++) {
        const layer = recipe.noise[i];
        const validColors = ['white', 'brown', 'pink'];
        check(`recipe '${name}' noise[${i}] valid color`,
          validColors.includes(layer.color));
        check(`recipe '${name}' noise[${i}] envelope[0] >= 0`, layer.envelope[0] >= 0);
        check(`recipe '${name}' noise[${i}] envelope[1] >= 0`, layer.envelope[1] >= 0);
        check(`recipe '${name}' noise[${i}] envelope[2] > 0`, layer.envelope[2] > 0);
        if (layer.gain !== undefined) {
          check(`recipe '${name}' noise[${i}] gain in (0,1]`,
            layer.gain > 0 && layer.gain <= 1);
        }
      }
    }

    // Duration should be >= max envelope duration of all layers
    let maxEnvDur = 0;
    if (recipe.osc) {
      for (const l of recipe.osc) maxEnvDur = Math.max(maxEnvDur, envelopeDuration(l.envelope));
    }
    if (recipe.noise) {
      for (const l of recipe.noise) maxEnvDur = Math.max(maxEnvDur, envelopeDuration(l.envelope));
    }
    check(`recipe '${name}' duration >= max envelope`,
      recipe.duration >= maxEnvDur - 0.001);
  }
}

// ---------------------------------------------------------------------------
// 9. GameAudio API surface check (under Node — no actual audio)
// ---------------------------------------------------------------------------

{
  const audio = new GameAudio();

  // Volume
  audio.setVolume(0.8);
  check('setVolume(0.8) -> volume == 0.8', audio.volume === 0.8);

  audio.setVolume(-1);
  check('setVolume(-1) clamps to 0', audio.volume === 0);

  audio.setVolume(5);
  check('setVolume(5) clamps to 1', audio.volume === 1);

  // Muted
  audio.muted = true;
  check('muted setter works', audio.muted === true);
  audio.muted = false;
  check('muted unset works', audio.muted === false);

  // isActive should be false (no AudioContext under Node)
  check('isActive false under Node', !audio.isActive);

  // play() should not throw under Node (no-op when ctx is null)
  let playOk = true;
  try {
    audio.play('footstep_grass');
    audio.play('thunder', { intensity: 0.5, dist: 20 });
    audio.play('dragon_roar', { dist: 100 });
  } catch {
    playOk = false;
  }
  check('play() no-op under Node (no throw)', playOk);

  // setAmbience should not throw
  let ambienceOk = true;
  try {
    audio.setAmbience({ wind: 0.5, rain: 0.3, night: true, interior: false, fireNear: 0.8 });
  } catch {
    ambienceOk = false;
  }
  check('setAmbience() no-op under Node (no throw)', ambienceOk);

  // destroy should not throw
  let destroyOk = true;
  try {
    audio.destroy();
  } catch {
    destroyOk = false;
  }
  check('destroy() safe under Node', destroyOk);
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
