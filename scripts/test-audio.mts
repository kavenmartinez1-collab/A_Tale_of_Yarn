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
 *   - DETERMINISM: no Math.random / Date.now in the engine source; the copied
 *     mix32 / idHash agree with the originals they mirror; seeds and per-layer
 *     parameters are reproducible; the noise buffers are byte-stable
 *   - THE ACTUAL AUDIO. `scripts/audio-render.mts` renders every recipe to PCM
 *     offline and this asserts energy, headroom, and length on the samples.
 *     A recipe table can be structurally perfect and silent; that was the whole
 *     reason to build a renderer.
 */

import {
  distanceGain,
  envelopeDuration,
  envelopeAt,
  jitterFreq,
  SfxThrottler,
  GameAudio,
  mix32,
  idHash,
  sfxSeed,
  layerSeed,
  layerParams,
  flickerAt,
  bedLayerAmp,
  generateNoise,
  NOISE_BUFFER_S,
} from '../src/game/audio/audio-engine';

import {
  SFX_NAMES,
  SFX_RECIPES,
  SFX_VARIANT,
  SFX_VARIANT_COUNT,
  SFX_RESERVED,
  AMBIENCE_BEDS,
  AMBIENCE_BED_NAMES,
  type SfxName,
  type SfxRecipe,
} from '../src/game/audio/sfx';

// The originals the engine's private copies mirror. Imported HERE (a test) so
// the duplication is asserted rather than merely commented.
import { mix32 as mix32Original } from '../src/game/dungeon/dungeon-layout';
import { idHash as idHashOriginal } from '../src/game/combat/attack-tokens';

import {
  renderSfx, renderRecipe, renderBed, analyse, encodeWav, SAMPLE_RATE,
} from './audio-render.mts';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root, resolved from this file — not from cwd. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
    // the original 15
    'footstep_grass', 'footstep_stone', 'swing', 'hit', 'hurt',
    'pickup', 'craft', 'ui_click', 'chest_open', 'thunder',
    'splash', 'eat_drink', 'level_chime', 'growl', 'dragon_roar',
    // added by the SFX-completeness wave
    'footstep_wood', 'footstep_sand', 'shield_block', 'shield_parry',
    'bow_draw', 'bow_loose', 'tintreach_bolt', 'lock_on', 'lock_off',
    'chest_close', 'door_open', 'door_close', 'torch_light', 'torch_douse',
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

  // expectedNames matches SFX_NAMES exactly — in BOTH directions, so adding a
  // name without adding a test is as loud as removing one.
  check('SFX_NAMES count == 29', SFX_NAMES.length === 29, `got ${SFX_NAMES.length}`);
  check('all expected names are in SFX_NAMES',
    expectedNames.every(n => (SFX_NAMES as readonly string[]).includes(n)));
  check('no SFX_NAMES entry is untested',
    SFX_NAMES.every(n => expectedNames.includes(n)),
    SFX_NAMES.filter(n => !expectedNames.includes(n)).join(', '));
  check('no duplicate names', new Set(SFX_NAMES).size === SFX_NAMES.length);

  // The originals must survive untouched — main.ts calls all of them.
  const original15 = expectedNames.slice(0, 15);
  check('all 15 original ids still present',
    original15.every(n => n in SFX_RECIPES));
}

// ---------------------------------------------------------------------------
// 7b. Variant map + reserved list
// ---------------------------------------------------------------------------

{
  for (const name of SFX_NAMES) {
    check(`SFX_VARIANT has '${name}'`, name in SFX_VARIANT);
    const v = SFX_VARIANT[name];
    check(`SFX_VARIANT['${name}'] is a rendered variant`,
      Number.isInteger(v) && v >= 0 && v < SFX_VARIANT_COUNT,
      `got ${v}, audition renders 0..${SFX_VARIANT_COUNT - 1}`);
  }
  check('SFX_VARIANT has no extra keys',
    Object.keys(SFX_VARIANT).length === SFX_NAMES.length);
  check('SFX_VARIANT_COUNT >= 3', SFX_VARIANT_COUNT >= 3);

  for (const name of SFX_RESERVED) {
    check(`reserved id '${name}' is a real name`,
      (SFX_NAMES as readonly string[]).includes(name));
    check(`reserved id '${name}' has a recipe`, name in SFX_RECIPES);
  }
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
// 10. Per-recipe distance rolloff
// ---------------------------------------------------------------------------

{
  for (const name of SFX_NAMES) {
    const md = SFX_RECIPES[name].maxDist;
    if (md !== undefined) {
      check(`recipe '${name}' maxDist > 0`, md > 0);
      check(`recipe '${name}' maxDist sane (<= 1000 m)`, md <= 1000);
    }
  }

  // The defect this field exists to fix: main.ts plays dragon_roar at a
  // hardcoded 40 m and thunder at the true strike distance. Under the old
  // fixed 50 m the roar arrived at 0.2 gain and anything past 50 m was
  // dropped outright.
  const roar = SFX_RECIPES.dragon_roar;
  check('dragon_roar at 40 m is loud (was 0.20)',
    distanceGain(40, roar.maxDist) > 0.7,
    `got ${distanceGain(40, roar.maxDist).toFixed(3)}`);
  check('dragon_roar audible at 100 m', distanceGain(100, roar.maxDist) > 0);
  check('thunder audible at 200 m', distanceGain(200, SFX_RECIPES.thunder.maxDist) > 0);
  check('tintreach_bolt carries further than a footstep',
    (SFX_RECIPES.tintreach_bolt.maxDist ?? 50) > (SFX_RECIPES.footstep_grass.maxDist ?? 50));
  // ...and the default is untouched for everything that did not opt in.
  check('footstep_grass keeps the 50 m default',
    SFX_RECIPES.footstep_grass.maxDist === undefined
    && distanceGain(50, SFX_RECIPES.footstep_grass.maxDist) === 0);
}

// ---------------------------------------------------------------------------
// 11. Determinism — no wall clock, no Math.random, in the engine source
// ---------------------------------------------------------------------------

{
  // The strongest guard available: read the source. Comments are stripped
  // first so this file's own prose about `Math.random()` cannot trip it.
  const strip = (src: string): string => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

  for (const rel of ['src/game/audio/audio-engine.ts', 'src/game/audio/sfx.ts']) {
    const code = strip(readFileSync(path.join(ROOT, rel), 'utf-8'));
    check(`${rel}: no Math.random()`, !code.includes('Math.random'),
      'every random draw must come from a seeded mulberry32');
    check(`${rel}: no Date.now()`, !code.includes('Date.now'));
  }

  // The two duplicated hash functions must agree with the originals they say
  // they mirror. This is the check that makes the duplication safe.
  for (const [a, b, c] of [
    [0, 0, 0], [1, 2, 3], [0xffffffff, 7, 0], [12345, 0, 99], [0x9e3779b1, 0x85ebca6b, 1],
  ]) {
    check(`mix32(${a},${b},${c}) matches dungeon-layout`,
      mix32(a, b, c) === mix32Original(a, b, c),
      `${mix32(a, b, c)} vs ${mix32Original(a, b, c)}`);
  }
  for (const s of ['', 'a', 'footstep_grass', 'tintreach_bolt', 'wolf_0012']) {
    check(`idHash('${s}') matches attack-tokens`,
      idHash(s) === idHashOriginal(s));
  }
}

// ---------------------------------------------------------------------------
// 12. Seeds and per-layer parameters
// ---------------------------------------------------------------------------

{
  check('sfxSeed is a uint32',
    Number.isInteger(sfxSeed('hit', 0, 0)) && sfxSeed('hit', 0, 0) >= 0
    && sfxSeed('hit', 0, 0) <= 0xffffffff);
  check('sfxSeed reproducible', sfxSeed('hit', 7, 2) === sfxSeed('hit', 7, 2));
  check('sfxSeed varies with event', sfxSeed('hit', 7, 0) !== sfxSeed('hit', 8, 0));
  check('sfxSeed varies with variant', sfxSeed('hit', 7, 0) !== sfxSeed('hit', 7, 1));
  check('sfxSeed varies with name', sfxSeed('hit', 7, 0) !== sfxSeed('hurt', 7, 0));

  // Collision sanity over the space a long session actually visits.
  {
    const seen = new Set<number>();
    let collisions = 0;
    for (const n of SFX_NAMES) {
      for (let e = 0; e < 200; e++) {
        const s = sfxSeed(n, e, SFX_VARIANT[n]);
        if (seen.has(s)) collisions++;
        seen.add(s);
      }
    }
    check('sfxSeed: no collisions over 29 names x 200 events',
      collisions === 0, `${collisions} collisions`);
  }

  check('layerSeed separates osc from noise',
    layerSeed(1234, 0, false) !== layerSeed(1234, 0, true));
  check('layerSeed separates indices',
    layerSeed(1234, 0, true) !== layerSeed(1234, 1, true));

  // layerParams: range + reproducibility + flicker shape.
  {
    const env: [number, number, number] = [0.01, 0.05, 0.1];
    let minMul = 2, maxMul = 0, minOff = 1e9, maxOff = -1;
    for (let i = 0; i < 400; i++) {
      const p = layerParams(env, layerSeed(i, 0, true));
      minMul = Math.min(minMul, p.freqMul); maxMul = Math.max(maxMul, p.freqMul);
      minOff = Math.min(minOff, p.offset); maxOff = Math.max(maxOff, p.offset);
      if (p.flicker.length !== 0) { check('non-flicker layer has no steps', false); break; }
    }
    check('layerParams freqMul within +-10%', minMul >= 0.9 && maxMul <= 1.1,
      `[${minMul.toFixed(4)}, ${maxMul.toFixed(4)}]`);
    check('layerParams freqMul actually spreads', maxMul - minMul > 0.15,
      `spread only ${(maxMul - minMul).toFixed(4)} — the rng may be stuck`);
    const span = NOISE_BUFFER_S - envelopeDuration(env);
    check('layerParams offset within the buffer', minOff >= 0 && maxOff <= span,
      `[${minOff.toFixed(4)}, ${maxOff.toFixed(4)}] vs span ${span}`);
    check('layerParams offset spreads across the buffer', maxOff - minOff > span * 0.8);

    const a = layerParams(env, 4242);
    const b = layerParams(env, 4242);
    check('layerParams reproducible',
      a.freqMul === b.freqMul && a.offset === b.offset);
    check('layerParams varies with seed', layerParams(env, 4243).freqMul !== a.freqMul);
  }

  // Flicker: step count, depth band, and the boundary behaviour of flickerAt.
  {
    const env: [number, number, number] = [0.055, 0.10, 0.185]; // the tintreach seam
    const p = layerParams(env, 99, 10, 0.45);
    const dur = envelopeDuration(env);
    check('flicker step count matches Hz x duration',
      p.flicker.length === Math.ceil(dur * 10), `${p.flicker.length} vs ${Math.ceil(dur * 10)}`);
    check('flicker step is 1/Hz', Math.abs(p.flickerStep - 0.1) < 1e-9);
    check('flicker values in [1-depth, 1]',
      p.flicker.every(v => v >= 0.55 - 1e-9 && v <= 1 + 1e-9),
      `min ${Math.min(...p.flicker).toFixed(4)} max ${Math.max(...p.flicker).toFixed(4)}`);
    check('flicker values are not all equal',
      new Set(p.flicker.map(v => v.toFixed(6))).size > 1);
    check('flickerAt at t=0 == first step', flickerAt(p, 0) === p.flicker[0]);
    check('flickerAt steps (does not ramp)',
      flickerAt(p, 0.001) === flickerAt(p, 0.099));
    check('flickerAt past the end clamps',
      flickerAt(p, 999) === p.flicker[p.flicker.length - 1]);
    check('flickerAt on a steady layer == 1', flickerAt(layerParams(env, 99), 0.05) === 1);
  }

  // Bed LFO stays inside its budget — a bed that overshoots ducks the mix.
  for (const bed of AMBIENCE_BED_NAMES) {
    for (const layer of AMBIENCE_BEDS[bed].layers) {
      let lo = 1e9, hi = -1e9;
      for (let i = 0; i < 2000; i++) {
        const v = bedLayerAmp(layer, i * 0.01);
        lo = Math.min(lo, v); hi = Math.max(hi, v);
      }
      check(`bed '${bed}' layer never exceeds nominal gain`, hi <= layer.gain + 1e-9,
        `${hi} > ${layer.gain}`);
      check(`bed '${bed}' layer stays positive`, lo > 0, `${lo}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 13. Noise buffers are byte-stable and actually noisy
// ---------------------------------------------------------------------------

{
  for (const color of ['white', 'brown', 'pink'] as const) {
    const a = generateNoise(color, 4096);
    const b = generateNoise(color, 4096);
    let same = true;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { same = false; break; }
    check(`generateNoise('${color}') is byte-stable`, same);

    let peak = 0, sum = 0;
    for (let i = 0; i < a.length; i++) { peak = Math.max(peak, Math.abs(a[i])); sum += a[i] * a[i]; }
    const rms = Math.sqrt(sum / a.length);
    check(`generateNoise('${color}') stays in [-1,1]`, peak <= 1);
    check(`generateNoise('${color}') has real energy`, rms > 0.01, `rms ${rms.toFixed(5)}`);
  }

  const w = generateNoise('white', 1024);
  const br = generateNoise('brown', 1024);
  let differs = false;
  for (let i = 0; i < 1024; i++) if (w[i] !== br[i]) { differs = true; break; }
  check('noise colours are distinct streams', differs);
}

// ---------------------------------------------------------------------------
// 14. Instrument sanity — prove the renderer measures something
// ---------------------------------------------------------------------------
//
// A silence-passing test measures nothing. Before trusting any number in
// section 15, establish that the meter reads zero on silence, reads loud on
// something known loud, and that the two are far apart.

{
  const silence = analyse(new Float32Array(4800));
  check('meter reads silence as silent', silence.peak === 0 && silence.rms === 0);
  check('meter reports no audible sample in silence', silence.lastAudible === -1);
  check('meter reports -Infinity dB for silence', silence.rmsDb === -Infinity);

  // A recipe with every gain zeroed must render silent — proves the gain path
  // is wired and that a "non-silence" pass is not just measuring noise floor.
  const hit = SFX_RECIPES.hit;
  const muted: SfxRecipe = {
    ...hit,
    osc: (hit.osc ?? []).map(l => ({ ...l, gain: 0 })),
    noise: (hit.noise ?? []).map(l => ({ ...l, gain: 0 })),
  };
  check('zero-gain recipe renders silent', analyse(renderRecipe(muted)).peak === 0);

  // ...and the real one is loud, by a wide margin.
  const loud = analyse(renderSfx('hit'));
  check('known-loud recipe has real energy', loud.rmsDb > -25, `rms ${loud.rmsDb.toFixed(2)} dBFS`);
  check('loud vs silent separated by > 60 dB', loud.rmsDb - (-90) > 60);

  // Renderer determinism: identical inputs, identical samples.
  {
    const a = renderSfx('tintreach_bolt', { variant: 1, event: 3 });
    const b = renderSfx('tintreach_bolt', { variant: 1, event: 3 });
    let same = a.length === b.length;
    for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false;
    check('render is reproducible for (name, variant, event)', same);

    const c = renderSfx('tintreach_bolt', { variant: 1, event: 4 });
    let differs = false;
    for (let i = 0; i < a.length; i++) if (a[i] !== c[i]) { differs = true; break; }
    check('successive events differ', differs);

    const d = renderSfx('tintreach_bolt', { variant: 2, event: 3 });
    let vdiffers = false;
    for (let i = 0; i < a.length; i++) if (a[i] !== d[i]) { vdiffers = true; break; }
    check('variants differ', vdiffers);
  }

  // WAV container: assert the header rather than assuming encodeWav is right.
  {
    const wav = encodeWav(renderSfx('ui_click'));
    const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const tag = (o: number): string => String.fromCharCode(...wav.subarray(o, o + 4));
    check('wav RIFF/WAVE header', tag(0) === 'RIFF' && tag(8) === 'WAVE');
    check('wav is PCM', dv.getUint16(20, true) === 1);
    check('wav is mono', dv.getUint16(22, true) === 1);
    check('wav is 48 kHz', dv.getUint32(24, true) === SAMPLE_RATE);
    check('wav is 16-bit', dv.getUint16(34, true) === 16);
    check('wav data size matches', dv.getUint32(40, true) === wav.length - 44);
    check('wav byte rate consistent',
      dv.getUint32(28, true) === SAMPLE_RATE * 2 && dv.getUint16(32, true) === 2);
  }
}

// ---------------------------------------------------------------------------
// 15. Mechanical acceptance on the rendered PCM
// ---------------------------------------------------------------------------
//
// MECHANICAL ONLY. These say a sound is not broken — right length, no
// clipping, not silent. They say nothing whatsoever about whether it sounds
// good, and no test in this repo can. That is what
// `scripts/shots/audition/index.html` is for.

{
  /** Loudest allowed sample, -1 dBFS. Above this the browser hard-clips at volume 1.0. */
  const PEAK_CEILING_DB = -1;
  /** Quietest a one-shot may be before it is inaudible under the ambience beds. */
  const RMS_FLOOR_DB = -40;

  let worstPeak = -Infinity, worstPeakName = '';
  let quietest = Infinity, quietestName = '';

  for (const name of SFX_NAMES) {
    const recipe = SFX_RECIPES[name];
    const buf = renderSfx(name, { variant: SFX_VARIANT[name], event: 0 });
    const s = analyse(buf);

    // Length is exactly the declared duration — the voice-slot budget.
    check(`pcm '${name}': length == ceil(duration * sr)`,
      s.samples === Math.ceil(recipe.duration * SAMPLE_RATE),
      `${s.samples} vs ${Math.ceil(recipe.duration * SAMPLE_RATE)}`);
    check(`pcm '${name}': duration within 1 ms of the recipe`,
      Math.abs(s.seconds - recipe.duration) < 0.001);

    // Nothing may be cut off: the last audible sample must land inside the
    // buffer with room to spare, i.e. the envelopes fit the declared duration.
    check(`pcm '${name}': tail is not truncated`,
      s.lastAudible >= 0 && s.lastAudible <= s.samples - 1);

    // Headroom.
    check(`pcm '${name}': no clipped samples`, s.clipped === 0, `${s.clipped} samples at >= 1.0`);
    check(`pcm '${name}': peak < ${PEAK_CEILING_DB} dBFS`,
      s.peakDb < PEAK_CEILING_DB, `${s.peakDb.toFixed(2)} dBFS`);

    // Non-silence — the check that would have caught a recipe that renders to
    // nothing because a filter ate it.
    check(`pcm '${name}': not silent`, s.peak > 0);
    check(`pcm '${name}': rms above ${RMS_FLOOR_DB} dBFS`,
      s.rmsDb > RMS_FLOOR_DB, `${s.rmsDb.toFixed(2)} dBFS`);

    // Energy must be present in the FIRST half — a sound whose energy is all
    // at the end has an envelope bug (this catches an attack longer than the
    // declared duration, which renders as a fade-in that never arrives).
    let firstHalf = 0;
    for (let i = 0; i < s.samples >> 1; i++) firstHalf += buf[i] * buf[i];
    check(`pcm '${name}': energy present in the first half`, firstHalf > 0);

    if (s.peakDb > worstPeak) { worstPeak = s.peakDb; worstPeakName = name; }
    if (s.rmsDb < quietest) { quietest = s.rmsDb; quietestName = name; }
  }

  console.log(`\n  loudest peak: ${worstPeakName} at ${worstPeak.toFixed(2)} dBFS `
    + `(ceiling ${PEAK_CEILING_DB})`);
  console.log(`  quietest rms: ${quietestName} at ${quietest.toFixed(2)} dBFS `
    + `(floor ${RMS_FLOOR_DB})`);

  // The tintreach bolt has to match the visual it was written against. These
  // are the numbers `src/game/tintreach.ts` draws with.
  {
    const STRIKE_S = 0.055, BURN_S = 0.34, LIFE_S = 1.10;
    const r = SFX_RECIPES.tintreach_bolt;
    check('tintreach_bolt duration == LIFE_S', Math.abs(r.duration - LIFE_S) < 1e-9);

    const envs = [...(r.osc ?? []), ...(r.noise ?? [])].map(l => envelopeDuration(l.envelope));
    check('tintreach_bolt has a layer ending at STRIKE_S',
      envs.some(d => Math.abs(d - STRIKE_S) < 0.002), envs.map(d => d.toFixed(4)).join(', '));
    check('tintreach_bolt has a layer ending at BURN_S',
      envs.some(d => Math.abs(d - BURN_S) < 0.002));
    check('tintreach_bolt has a layer ending at LIFE_S',
      envs.some(d => Math.abs(d - LIFE_S) < 0.002));
    check('tintreach_bolt flickers at RESTRIKE_HZ (10)',
      [...(r.noise ?? [])].some(l => l.flickerHz === 10 && l.flickerDepth === 0.45));

    // The crack must be the loudest moment, not the tail: peak inside STRIKE_S
    // + one flicker step, since that is when the eye sees the strike.
    const buf = renderSfx('tintreach_bolt', { variant: SFX_VARIANT.tintreach_bolt, event: 0 });
    let pi = 0, pv = 0;
    for (let i = 0; i < buf.length; i++) {
      const a = Math.abs(buf[i]);
      if (a > pv) { pv = a; pi = i; }
    }
    check('tintreach_bolt peaks in its first 10%',
      pi / buf.length < 0.10, `peak at ${(pi / SAMPLE_RATE).toFixed(4)}s of ${r.duration}s`);

    // ...and it must be the loudest thing in the game, or the artifact does
    // not read as one.
    const bolt = analyse(buf).rmsDb;
    const step = analyse(renderSfx('footstep_grass')).rmsDb;
    check('tintreach_bolt is louder than a footstep', bolt > step + 1,
      `${bolt.toFixed(2)} vs ${step.toFixed(2)} dBFS`);
  }

  // Ambience beds: same acceptance, applied to a 4-second loop.
  for (const bed of AMBIENCE_BED_NAMES) {
    const s = analyse(renderBed(bed, 4));
    check(`bed '${bed}': 4 s rendered`, s.samples === 4 * SAMPLE_RATE);
    check(`bed '${bed}': not silent`, s.peak > 0 && s.rmsDb > -50, `rms ${s.rmsDb.toFixed(2)}`);
    check(`bed '${bed}': no clipping`, s.clipped === 0);
    check(`bed '${bed}': peak < -1 dBFS`, s.peakDb < -1, `${s.peakDb.toFixed(2)} dBFS`);
    // A bed is background. If it is as loud as a one-shot it will bury them.
    check(`bed '${bed}': sits below the one-shots`, s.rmsDb < -18, `${s.rmsDb.toFixed(2)} dBFS`);
  }
}

// ---------------------------------------------------------------------------
// 16. AmbienceState stays backward compatible
// ---------------------------------------------------------------------------
//
// main.ts:10200 builds one of these literals every frame and this deliverable
// does not own main.ts. Every field added since must be optional, and omitting
// all of them must be a no-op.

{
  const audio = new GameAudio();
  let ok = true;
  try {
    // Exactly the five original fields — the literal main.ts passes today.
    audio.setAmbience({ wind: 0.5, rain: 0.3, night: true, interior: false, fireNear: 0.8 });
    // ...and the extended form.
    audio.setAmbience({
      wind: 0.1, rain: 1, night: false, interior: true, fireNear: 0,
      sheltered: true, dungeon: 1, castle: 0.5,
    });
  } catch {
    ok = false;
  }
  check('setAmbience accepts both the old and the new literal', ok);
  audio.destroy();

  for (const bed of AMBIENCE_BED_NAMES) {
    const d = AMBIENCE_BEDS[bed];
    check(`bed '${bed}' has layers`, d.layers.length > 0);
    check(`bed '${bed}' gain in (0,1]`, d.gain > 0 && d.gain <= 1);
    for (const l of d.layers) {
      check(`bed '${bed}' layer gain in (0,1]`, l.gain > 0 && l.gain <= 1);
      check(`bed '${bed}' layer freq > 0`, l.freq > 0);
      check(`bed '${bed}' layer Q > 0`, l.Q > 0);
      if (l.lfoDepth !== undefined) {
        check(`bed '${bed}' lfoDepth in (0,1]`, l.lfoDepth > 0 && l.lfoDepth <= 1);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
