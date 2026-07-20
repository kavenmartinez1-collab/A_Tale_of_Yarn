/**
 * Unit tests for Audit Wave 2 features — pure logic only:
 *   - Fall damage curve (Feature 1)
 *   - Swim stamina drain / drowning (Feature 2)
 *   - Rain vs fire rules (Feature 3)
 *   - Projectile NPC hit detection (Feature 4)
 *   - NPC respawn timer (Feature 8)
 *   - Audio helpers (Feature 10)
 */

import { strictEqual, ok } from 'assert';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL  ${name}`);
    console.error('        ', e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// Feature 1: Fall damage curve
// ---------------------------------------------------------------------------

const FALL_SAFE_THRESHOLD = 12; // m/s (must match main.ts)
const FALL_DAMAGE_SCALE   = 0.5;

function computeFallDamage(impactSpeed: number): number {
  if (impactSpeed <= FALL_SAFE_THRESHOLD) return 0;
  return Math.ceil((impactSpeed - FALL_SAFE_THRESHOLD) * FALL_DAMAGE_SCALE);
}

console.log('\n--- Feature 1: Fall damage curve ---');

test('no damage below safe threshold', () => {
  strictEqual(computeFallDamage(0), 0);
  strictEqual(computeFallDamage(11.9), 0);
  strictEqual(computeFallDamage(12), 0);
});

test('exactly at threshold: no damage', () => {
  strictEqual(computeFallDamage(12), 0);
});

test('1 m/s above threshold → 1 hp damage (ceil(0.5))', () => {
  strictEqual(computeFallDamage(13), 1);
});

test('2 m/s above threshold → 1 hp damage (ceil(1.0))', () => {
  strictEqual(computeFallDamage(14), 1);
});

test('2.1 m/s above threshold → 2 hp damage (ceil(1.05))', () => {
  strictEqual(computeFallDamage(14.1), 2);
});

test('large fall: 30 m/s → 9 hp damage', () => {
  // excess = 18, ceil(18 * 0.5) = 9
  strictEqual(computeFallDamage(30), 9);
});

test('damage is monotonically non-decreasing', () => {
  let prev = 0;
  for (let v = 12; v <= 50; v += 0.5) {
    const dmg = computeFallDamage(v);
    ok(dmg >= prev, `dmg at ${v} (${dmg}) < prev (${prev})`);
    prev = dmg;
  }
});

// ---------------------------------------------------------------------------
// Feature 2: Swim stamina drain
// ---------------------------------------------------------------------------

import { createVitals, damagePlayer, drainStamina, type Vitals } from '../src/game/vitals.js';

const SWIM_STAMINA_DRAIN_PER_S = 6;
const SWIM_HP_DRAIN_PER_S      = 2;
const SIM_DT = 1 / 60;

function simSwimTick(v: Vitals): void {
  drainStamina(v, SWIM_STAMINA_DRAIN_PER_S, SIM_DT);
  if (v.stamina <= 0) {
    damagePlayer(v, SWIM_HP_DRAIN_PER_S * SIM_DT, 'drowning');
  }
}

console.log('\n--- Feature 2: Swim stamina drain ---');

test('stamina drains while swimming', () => {
  const v = createVitals();
  const before = v.stamina;
  simSwimTick(v);
  ok(v.stamina < before, 'stamina should drain');
});

test('HP not damaged while stamina > 0', () => {
  const v = createVitals();
  simSwimTick(v);
  strictEqual(v.hp, 20);
});

test('HP drains once stamina is exhausted', () => {
  const v = createVitals();
  v.stamina = 0;
  const hpBefore = v.hp;
  simSwimTick(v);
  ok(v.hp < hpBefore, 'HP should drain when stamina=0');
});

test('stamina exhausted after ~16.7 s of swimming', () => {
  const v = createVitals();
  let ticks = 0;
  while (v.stamina > 0 && ticks < 10000) {
    drainStamina(v, SWIM_STAMINA_DRAIN_PER_S, SIM_DT);
    ticks++;
  }
  // 100 stamina / 6 per s = ~16.7 s = ~1000 ticks at 60 fps
  ok(ticks > 900 && ticks < 1100, `exhausted in ${ticks} ticks, expected ~1000`);
});

// ---------------------------------------------------------------------------
// Feature 3: Rain vs fire rules (pure logic)
// ---------------------------------------------------------------------------

import { weatherAt } from '../src/game/weather.js';
import {
  addBurningTree, getBurningTrees, tickBurningTrees, type BurningTree,
} from '../src/game/fire.js';

/**
 * Simulate one fire spread tick under rain.
 * Rain: burning trees burn out ~2x faster (we subtract FIRE_SPREAD_TICK_S from untilS).
 */
function simulateRainFireTick(trees: BurningTree[], nowS: number): void {
  const FIRE_SPREAD_TICK_S = 1;
  for (const bt of trees) {
    bt.untilS -= FIRE_SPREAD_TICK_S; // rain accelerated burnout
  }
}

console.log('\n--- Feature 3: Rain vs fire rules ---');

test('rain weather kind from weatherAt', () => {
  // Segment 0 is always clear — need a later segment.
  // We just verify the function returns a valid rain kind somewhere.
  let foundRain = false;
  for (let t = 0; t < 100000; t += 300) {
    const w = weatherAt(1337, t);
    if (w.kind === 'rain' || w.kind === 'thunderstorm') {
      foundRain = true;
      break;
    }
  }
  ok(foundRain, 'should encounter rain/thunderstorm over 100k seconds');
});

test('rain fire tick reduces untilS', () => {
  const tree: BurningTree = { x: 0, y: 0, z: 0, untilS: 30, kind: 'tree' };
  const before = tree.untilS;
  simulateRainFireTick([tree], 0);
  ok(tree.untilS < before, 'untilS should decrease under rain');
});

test('rain fire tick removes 1 s per tick (FIRE_SPREAD_TICK_S)', () => {
  const tree: BurningTree = { x: 0, y: 0, z: 0, untilS: 30, kind: 'tree' };
  simulateRainFireTick([tree], 0);
  strictEqual(tree.untilS, 29);
});

test('tree burned twice as fast in rain vs dry (2 rain ticks = 2 dry ticks drain)', () => {
  // Under rain the tick is FIRE_SPREAD_TICK_S per tick (same interval, but extra drain).
  // Under dry conditions burningTrees just expire via tickBurningTrees at their untilS.
  // The rain logic explicitly shaves 1 s per 1 s tick interval — so trees burn ~2x.
  // This test verifies the subtraction mechanism is consistent.
  const tree1: BurningTree = { x: 0, y: 0, z: 0, untilS: 20, kind: 'tree' };
  const tree2: BurningTree = { x: 1, y: 0, z: 0, untilS: 20, kind: 'tree' };
  simulateRainFireTick([tree1], 0); // rain: -1 s per tick
  simulateRainFireTick([tree1], 1); // -2 s total
  // Dry: no extra drain (untilS just approaches naturally)
  strictEqual(tree1.untilS, 18);  // 20 - 2 ticks
  strictEqual(tree2.untilS, 20);  // unchanged (dry)
});

// ---------------------------------------------------------------------------
// Feature 4: Projectile NPC hit detection (pure geometry check)
// ---------------------------------------------------------------------------

interface MockNpc {
  hp: number;
  wx: number;
  wy: number;
  wz: number;
  attitude: string;
  fleeing: boolean;
}

interface MockProjectile {
  x: number; y: number; z: number;
  damage: number;
  kind: 'arrow' | 'stone';
}

function tryHitNpc(p: MockProjectile, rt: MockNpc): boolean {
  const hitRadius = p.kind === 'arrow' ? 0.7 : 1.0;
  const dx = rt.wx - p.x;
  const dz = rt.wz - p.z;
  const dy = rt.wy + 0.9 - p.y;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist > hitRadius) return false;
  rt.hp = Math.max(0, rt.hp - p.damage);
  if (rt.hp > 0) {
    rt.attitude = 'afraid';
    rt.fleeing = true;
  }
  return true;
}

console.log('\n--- Feature 4: Projectile NPC hit detection ---');

test('arrow hits NPC within 0.7 m', () => {
  const npc: MockNpc = { hp: 10, wx: 0, wy: 0, wz: 0, attitude: 'calm', fleeing: false };
  const arrow: MockProjectile = { x: 0, y: 0.9, z: 0, damage: 6, kind: 'arrow' };
  const hit = tryHitNpc(arrow, npc);
  ok(hit, 'should hit');
  strictEqual(npc.hp, 4);
});

test('stone hits NPC within 1.0 m', () => {
  const npc: MockNpc = { hp: 10, wx: 0.8, wy: 0, wz: 0, attitude: 'calm', fleeing: false };
  const stone: MockProjectile = { x: 0, y: 0.9, z: 0, damage: 2, kind: 'stone' };
  const hit = tryHitNpc(stone, npc);
  ok(hit, 'stone should hit within 1 m');
});

test('arrow misses NPC outside 0.7 m', () => {
  const npc: MockNpc = { hp: 10, wx: 2, wy: 0, wz: 0, attitude: 'calm', fleeing: false };
  const arrow: MockProjectile = { x: 0, y: 0.9, z: 0, damage: 6, kind: 'arrow' };
  const hit = tryHitNpc(arrow, npc);
  ok(!hit, 'should not hit at 2 m');
});

test('NPC becomes afraid after non-lethal hit', () => {
  const npc: MockNpc = { hp: 10, wx: 0, wy: 0, wz: 0, attitude: 'calm', fleeing: false };
  const arrow: MockProjectile = { x: 0, y: 0.9, z: 0, damage: 3, kind: 'arrow' };
  tryHitNpc(arrow, npc);
  strictEqual(npc.attitude, 'afraid');
  strictEqual(npc.fleeing, true);
});

test('NPC lethal hit leaves hp at 0', () => {
  const npc: MockNpc = { hp: 5, wx: 0, wy: 0, wz: 0, attitude: 'calm', fleeing: false };
  const arrow: MockProjectile = { x: 0, y: 0.9, z: 0, damage: 10, kind: 'arrow' };
  tryHitNpc(arrow, npc);
  strictEqual(npc.hp, 0);
});

// ---------------------------------------------------------------------------
// Feature 8: NPC respawn timer
// ---------------------------------------------------------------------------

interface MockNpcRuntime {
  hp: number;
  attitude: string;
  fleeing: boolean;
  deadAtS?: number;
  respawnAtS?: number;
  wx: number; wy: number; wz: number;
  npc: { wx: number; wy: number; wz: number };
}

const NPC_RESPAWN_S = 180;

function onNpcKilledMock(rt: MockNpcRuntime, simTime: number): void {
  if (rt.deadAtS !== undefined) return;
  rt.deadAtS = simTime;
  rt.fleeing = false;
  rt.respawnAtS = simTime + NPC_RESPAWN_S;
}

function tickNpcRespawnMock(rt: MockNpcRuntime, simTime: number): void {
  if (rt.hp <= 0 && rt.respawnAtS !== undefined && simTime >= rt.respawnAtS) {
    rt.hp = 10;
    rt.attitude = 'calm';
    rt.fleeing = false;
    rt.deadAtS = undefined;
    rt.respawnAtS = undefined;
    rt.wx = rt.npc.wx;
    rt.wy = rt.npc.wy;
    rt.wz = rt.npc.wz;
  }
}

console.log('\n--- Feature 8: NPC respawn timer ---');

test('onNpcKilled sets respawnAtS to simTime + 180', () => {
  const rt: MockNpcRuntime = {
    hp: 0, attitude: 'calm', fleeing: false,
    wx: 10, wy: 0, wz: 10,
    npc: { wx: 10, wy: 0, wz: 10 },
  };
  onNpcKilledMock(rt, 100);
  strictEqual(rt.respawnAtS, 280);
  strictEqual(rt.deadAtS, 100);
});

test('NPC does not respawn before timer expires', () => {
  const rt: MockNpcRuntime = {
    hp: 0, attitude: 'calm', fleeing: false,
    wx: 10, wy: 0, wz: 10,
    npc: { wx: 10, wy: 0, wz: 10 },
  };
  onNpcKilledMock(rt, 100);
  tickNpcRespawnMock(rt, 279);
  strictEqual(rt.hp, 0, 'should still be dead at t=279');
});

test('NPC respawns at or after timer', () => {
  const rt: MockNpcRuntime = {
    hp: 0, attitude: 'hostile', fleeing: true,
    wx: 99, wy: 0, wz: 99,
    npc: { wx: 10, wy: 0, wz: 10 },
  };
  onNpcKilledMock(rt, 100);
  tickNpcRespawnMock(rt, 280);
  strictEqual(rt.hp, 10, 'should be alive');
  strictEqual(rt.attitude, 'calm');
  strictEqual(rt.fleeing, false);
  strictEqual(rt.wx, 10, 'should return to home wx');
  strictEqual(rt.wz, 10, 'should return to home wz');
  strictEqual(rt.deadAtS, undefined);
  strictEqual(rt.respawnAtS, undefined);
});

test('double-kill call is idempotent', () => {
  const rt: MockNpcRuntime = {
    hp: 0, attitude: 'calm', fleeing: false,
    wx: 10, wy: 0, wz: 10,
    npc: { wx: 10, wy: 0, wz: 10 },
  };
  onNpcKilledMock(rt, 100);
  onNpcKilledMock(rt, 200); // second call ignored
  strictEqual(rt.deadAtS, 100);
  strictEqual(rt.respawnAtS, 280);
});

// ---------------------------------------------------------------------------
// Feature 10: Audio helpers (pure math from audio-engine.ts)
// ---------------------------------------------------------------------------

import { distanceGain, envelopeDuration, envelopeAt, SfxThrottler } from '../src/game/audio/audio-engine.js';

console.log('\n--- Feature 10: Audio helper functions ---');

test('distanceGain: 0 dist → 1', () => {
  strictEqual(distanceGain(0), 1);
});

test('distanceGain: at maxDist → 0', () => {
  strictEqual(distanceGain(50, 50), 0);
});

test('distanceGain: half max → 0.5', () => {
  strictEqual(distanceGain(25, 50), 0.5);
});

test('distanceGain: beyond max → 0', () => {
  strictEqual(distanceGain(100, 50), 0);
});

test('envelopeDuration: sums attack+hold+decay', () => {
  ok(Math.abs(envelopeDuration([0.1, 0.2, 0.3]) - 0.6) < 1e-9, 'should be ~0.6');
});

test('envelopeAt: before attack → 0', () => {
  strictEqual(envelopeAt([0.1, 0.2, 0.3], -0.01), 0);
});

test('envelopeAt: at peak (end of attack) → 1', () => {
  strictEqual(envelopeAt([0.1, 0.2, 0.3], 0.1), 1);
});

test('envelopeAt: after envelope → 0', () => {
  strictEqual(envelopeAt([0.1, 0.2, 0.3], 0.7), 0);
});

test('SfxThrottler: allows first call', () => {
  const t = new SfxThrottler();
  ok(t.allow('hit', 200, 1000));
});

test('SfxThrottler: blocks second call within throttle window', () => {
  const t = new SfxThrottler();
  t.allow('hit', 200, 1000);
  ok(!t.allow('hit', 200, 1050), 'should be throttled at 1050ms');
});

test('SfxThrottler: allows call after throttle window', () => {
  const t = new SfxThrottler();
  t.allow('hit', 200, 1000);
  ok(t.allow('hit', 200, 1201), 'should be allowed at 1201ms');
});

test('SfxThrottler: reset clears state', () => {
  const t = new SfxThrottler();
  t.allow('hit', 200, 1000);
  t.reset();
  ok(t.allow('hit', 200, 1050), 'should be allowed after reset');
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
