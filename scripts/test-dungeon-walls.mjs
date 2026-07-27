/**
 * In-game verification that dungeon enemies cannot hit through walls, and that
 * they still hit when they can see you.
 *
 *   node scripts/test-dungeon-walls.mjs [outDir]
 *
 * Why this exists rather than only the unit suite: `scripts/test-dungeon-combat.mts`
 * proves the gating logic against a hand-built arena, but it cannot prove the
 * gate is WIRED — that `DungeonManager.tickEnemies` actually routes through it,
 * that the real layout's cells reach it, and that the origin subtraction is the
 * right way round. A grid indexed with the world-space position instead of the
 * grid-local one would pass every unit test in the file and block nothing at
 * all in the game.
 *
 * It checks:
 *   1. an aggro'd enemy in another room, inside its own attack reach, moves no HP
 *   2. the enemy is genuinely trying (its mode stays aggro, it is genuinely near)
 *   3. an enemy in the SAME room does move HP — the fix is not a mute button
 *   4. an end-to-end delve: HP timeline, kills, time, loot
 *
 * Hot-reload safety: three other agents are editing this tree and Vite will
 * reload the page under us. Every measurement re-checks a token stamped on
 * `window` after boot; if it is gone the page reloaded mid-run and the harness
 * ABORTS rather than reporting numbers gathered across two different builds.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const outDir = process.argv[2] || 'scripts/shots/dungeon-walls';
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 300)}`));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !t.includes('Failed to load resource')) {
    errors.push(`CONSOLE ${t.slice(0, 200)}`);
  }
});

let failures = 0;
const say = (ok, msg) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`);
};

const TOKEN = `probe-${Date.now().toString(36)}`;

async function abortReloaded(where, detail = '') {
  console.error(
    `\nABORT: the page reloaded during "${where}".${detail ? `\n  ${detail}` : ''}\n` +
    'Another agent saved a file and Vite hot-reloaded the game. Every number\n' +
    'after that point would mix two builds, so this run is discarded rather\n' +
    'than reported. Re-run when the tree is quiet.');
  await browser.close();
  process.exit(2);
}

/** Throw if the page reloaded since the token was stamped. */
async function assertNoReload(where) {
  let alive = false;
  try {
    alive = await page.evaluate((t) => window.__probeToken === t, TOKEN);
  } catch (err) {
    await abortReloaded(where, String(err).slice(0, 160));
  }
  if (!alive) await abortReloaded(where);
}

/**
 * `page.evaluate`, but a mid-flight navigation is treated as a discarded run
 * rather than as a stack trace. A reload while an `await`-ing evaluate is in
 * progress destroys the execution context and throws from inside the call, so
 * checking the token afterwards is too late.
 */
async function measure(where, fn) {
  try {
    return await page.evaluate(fn);
  } catch (err) {
    const msg = String(err);
    if (msg.includes('Execution context was destroyed')
        || msg.includes('Target closed')
        || msg.includes('Target page, context or browser has been closed')) {
      await abortReloaded(where, msg.slice(0, 160));
    }
    throw err;
  }
}

await page.goto('http://localhost:5173/game.html', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined,
  { timeout: 180_000 });
await page.evaluate((t) => { window.__probeToken = t; }, TOKEN);
console.log('game ready\n');

// ---------------------------------------------------------------------------
// Enter a dungeon
// ---------------------------------------------------------------------------

const entered = await measure('entering the dungeon', async () => {
  const d = window.__gameDebug;
  if (!d.teleportToNearestEntrance()) return { ok: false, why: 'no entrance found' };
  // The Director may still be dreaming up the spec; enterNearestDungeon goes
  // straight past that gate, but give the frame loop a beat either way.
  await new Promise((r) => setTimeout(r, 500));
  const name = d.nearestDungeonName();
  if (!d.enterNearestDungeon()) return { ok: false, why: 'enterNearestDungeon() refused' };
  await new Promise((r) => setTimeout(r, 500));
  return { ok: true, name, enemies: d.dungeonEntities().length };
});
say(entered.ok, `entered a dungeon: ${entered.name ?? entered.why} ` +
  `(${entered.enemies ?? 0} enemies)`);
if (!entered.ok) { await browser.close(); process.exit(1); }
await assertNoReload('entering the dungeon');

// ---------------------------------------------------------------------------
// 1. THROUGH A WALL — four probes around a cell that is known to hug one
//
// The problem with waiting for the case to occur naturally is that it depends
// on where the generator happened to put the rooms: in a crypt whose nearest
// neighbouring room is 11 m off, there is no adjacent pair to measure. So the
// case is CONSTRUCTED, on real dungeon geometry, at a spot whose geometry is
// guaranteed by the layout code.
//
// `decorate()` only ever puts the exit portal on a perimeter cell for which
// `wallDirOf` returned >= 0 — i.e. a cell with at least one SOLID neighbour —
// and the cell is in the entrance room, so at least one of its four neighbours
// is open floor. Standing there and pinning an enemy 2.0 m away in each of the
// four axis directions therefore MUST produce both answers: some directions
// cross a wall, at least one does not.
//
// The enemy is pinned by shrinking its room rect to its own cell, so it cannot
// walk around (or, with the room clamp being wall-agnostic, straight through)
// the wall while being measured. It can only stand and swing.
//
// This is the assertion that would have failed if the grid were indexed in
// world space instead of grid-local: every direction would have blocked.
// ---------------------------------------------------------------------------

const wall = await measure('the through-wall probes', async () => {
  const d = window.__gameDebug;
  const REACH = { goblin: 2.5, goblin_archer: 16, skeleton: 2.5, dread_king: 4.1 };
  d.teleportToExitPortal();
  await new Promise((r) => setTimeout(r, 300));
  const p = d.playerPos();

  const alive = d.dungeonEntities().filter((e) => e.mode !== 'dead');
  if (alive.length === 0) return { ok: false, why: 'nothing alive to test with' };
  // `dungeonEntities()` hands back the live array, so this is the real object
  // the tick loop steps — mutating it here is the whole point.
  const e = alive[0];
  const reach = REACH[e.species] ?? 2.5;
  const GAP = 2.0;   // two floor cells either side of one 1 m wall
  // Everything this probe mutates is put back afterwards. Leaving the subject
  // pinned to a 1x1 room with 9999 hp made the delve below target an
  // invincible boss forever and report 72 HP per kill — a harness artefact
  // that looked exactly like a balance disaster.
  const saved = {
    x: e.x, z: e.z, hp: e.hp, mode: e.mode,
    roomX: e.roomX, roomZ: e.roomZ, roomW: e.roomW, roomD: e.roomD,
  };

  const probes = [];
  for (const [dx, dz, name] of [[1, 0, '+x'], [-1, 0, '-x'], [0, 1, '+z'], [0, -1, '-z']]) {
    e.x = p[0] + dx * GAP;
    e.z = p[2] + dz * GAP;
    // Pin it: clamp range becomes [x, x] exactly, so it cannot move at all.
    e.roomX = e.x - 0.5; e.roomZ = e.z - 0.5; e.roomW = 1; e.roomD = 1;
    e.mode = 'aggro';
    e.stateTimer = 0;
    e.hp = 9999;                       // must not die mid-probe
    d.setVitals({ hp: 20, thirst: 100, stamina: 100, alive: true });
    await new Promise((r) => setTimeout(r, 2_600));
    const v = d.vitals();
    probes.push({
      dir: name, taken: Math.round((20 - v.hp) * 100) / 100, mode: e.mode,
      dist: Math.hypot(e.x - d.playerPos()[0], e.z - d.playerPos()[2]),
    });
  }
  Object.assign(e, saved);
  return { ok: true, species: e.species, reach, gap: GAP, probes };
});
await assertNoReload('the through-wall measurement');

if (!wall.ok) {
  console.log(`SKIP  through-wall probe: ${wall.why}`);
} else {
  const blocked = wall.probes.filter((x) => x.taken === 0);
  const landed = wall.probes.filter((x) => x.taken > 0);
  console.log(`  probes (a ${wall.species}, reach ${wall.reach} m, pinned ` +
    `${wall.gap} m away, 2.6 s each):`);
  for (const x of wall.probes) {
    console.log(`    ${x.dir}: took ${x.taken} HP  (dist ${x.dist.toFixed(2)} m, mode ${x.mode})`);
  }
  say(blocked.length > 0,
    `at least one direction is through a wall and dealt 0 HP ` +
    `(${blocked.map((x) => x.dir).join(',') || 'none'})`);
  say(landed.length > 0,
    `at least one direction is open floor and DID deal damage ` +
    `(${landed.map((x) => `${x.dir}:${x.taken}`).join(',') || 'none'}) — ` +
    'so the gate blocks walls, not attacking');
  say(wall.probes.every((x) => x.dist <= wall.reach + 0.01),
    `every probe was inside the species' own reach (${wall.gap} m <= ${wall.reach} m)`);
  say(wall.probes.every((x) => x.mode === 'aggro'),
    'the enemy stayed hostile through every probe, so the zeroes are blocked ' +
    'attacks and not a sleeping enemy');
}

// ---------------------------------------------------------------------------
// 2. POSITIVE CONTROL — same dungeon, same enemies, no wall
//
// Without this, a fix that simply stopped every enemy attacking would score a
// clean sweep above.
// ---------------------------------------------------------------------------

const open = await measure('the positive control', async () => {
  const d = window.__gameDebug;
  const alive = d.dungeonEntities().filter((e) => e.mode !== 'dead');
  if (alive.length === 0) return { ok: false, why: 'nothing left alive' };
  // Move the toughest hitter onto the player: same room by construction, so
  // line of sight is guaranteed and only the fix's own gate is in the way.
  const order = { dread_king: 0, skeleton: 1, goblin: 2, goblin_archer: 3 };
  alive.sort((a, b) => (order[a.species] ?? 9) - (order[b.species] ?? 9));
  const e = alive[0];
  const p = d.playerPos();
  const back = { x: e.x, z: e.z };
  e.x = p[0] + 1.0;
  e.z = p[2];
  e.mode = 'aggro';
  e.stateTimer = 0;
  d.setVitals({ hp: 20, thirst: 100, stamina: 100, alive: true });
  const hp0 = d.vitals().hp;
  await new Promise((r) => setTimeout(r, 3_500));
  const v = d.vitals();
  Object.assign(e, back);
  return { ok: true, hp0, hp1: v.hp, species: e.species, alive: v.alive };
});
await assertNoReload('the positive control');

if (!open.ok) {
  console.log(`SKIP  positive control: ${open.why}`);
} else {
  say(open.hp1 < open.hp0,
    `a ${open.species} standing 1 m away in the SAME room dealt ` +
    `${(open.hp0 - open.hp1).toFixed(1)} HP in 3.5 s (expected > 0) — ` +
    `hp ${open.hp0} -> ${open.hp1}`);
}

// ---------------------------------------------------------------------------
// 3. The grace window: 6 s of an adjacent attacker must not exceed the cap
// ---------------------------------------------------------------------------

if (open.ok) {
  const taken = open.hp0 - open.hp1;
  // 3.5 s at one blow per 0.8 s is at most 5 blows; the hardest hitter is 8.
  say(taken <= 5 * 8,
    `...and the grace window held the total to ${taken.toFixed(1)} HP over 3.5 s`);
}

// ---------------------------------------------------------------------------
// 4. End-to-end delve — kill everything, report the cost
// ---------------------------------------------------------------------------

// One evaluate PER ENEMY rather than one for the whole delve. A 40 s evaluate
// is 40 s of exposure to somebody else's file save, and losing the last enemy
// should not discard the twenty before it.
const delve = { total: 0, killed: 0, damage: 0, seconds: 0, potions: 0, arrows: 0 };
{
  const t0 = Date.now();
  delve.total = await measure('reading the roster', () => {
    const d = window.__gameDebug;
    d.setVitals({ hp: 20, thirst: 100, stamina: 100, alive: true });
    // Drain the starting quiver to zero, keeping the SLOT.
    //
    // The character begins with a full 99-arrow stack and `addTintreach` tops
    // an existing slot to its cap and discards the rest, so a boss drop into a
    // full quiver is invisible. Nulling the slot outright does not work either:
    // this character's pack is full (0 of 28 free), so `addTintreach` has
    // nowhere to put a new one and silently drops it. Draining to 0 keeps the
    // slot addressable and makes every arrow counted below come from the
    // corpse — and it is also the state the design actually cares about, since
    // the arrows are consumable now.
    const inv = d.inventory();
    let quiver = null;
    for (const area of ['pack', 'hotbar']) {
      const arr = inv[area] ?? [];
      for (let i = 0; i < arr.length; i++) {
        if (arr[i] && arr[i].id === 'arrow') { arr[i].count = 0; quiver = arr[i]; }
      }
    }
    if (quiver === null) {
      // No quiver at all: free one pack slot so the drop has somewhere to land.
      const arr = inv.pack ?? [];
      for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i]) { arr[i] = null; break; }
      }
    }
    return d.dungeonEntities().length;
  });
  for (let i = 0; i < 40; i++) {
    const step = await measure('the end-to-end delve', async () => {
      const d = window.__gameDebug;
      const alive = d.dungeonEntities().filter((e) => e.mode !== 'dead');
      if (alive.length === 0) return { done: true, damage: 0, killed: 0 };
      const p = d.playerPos();
      alive.sort((a, b) =>
        Math.hypot(a.x - p[0], a.z - p[2]) - Math.hypot(b.x - p[0], b.z - p[2]));
      const e = alive[0];
      // Drag it into melee: the harness has no movement hook, and what is being
      // measured is the cost of the fight, not the walk to it.
      e.x = p[0] + 1.2; e.z = p[2]; e.mode = 'aggro'; e.stateTimer = 0;
      let before = d.vitals().hp;
      let damage = 0;
      for (let swing = 0; swing < 80 && e.mode !== 'dead'; swing++) {
        await new Promise((r) => setTimeout(r, 60));
        d.attackEntity(e.id, 4);                     // sword
        const hp = d.vitals().hp;
        if (hp < before) damage += before - hp;
        before = hp;
        if (!d.vitals().alive || hp < 6) {
          // Stands in for drinking a potion. Dungeons now stock enough healing
          // to do this for real; what is being measured here is the damage.
          d.setVitals({ hp: 20, alive: true });
          before = 20;
        }
      }
      return { done: false, damage, killed: e.mode === 'dead' ? 1 : 0 };
    });
    delve.damage += step.damage;
    delve.killed += step.killed;
    if (step.done) break;
    await assertNoReload('the end-to-end delve');
  }
  delve.seconds = (Date.now() - t0) / 1000;
  const pack = await measure('reading the pack', () => {
    const inv = window.__gameDebug.inventory();
    const all = [...(inv.pack ?? []), ...(inv.hotbar ?? [])];
    const count = (id) => all.reduce(
      (a, s) => a + (s && s.id === id ? (s.count ?? 1) : 0), 0);
    return { arrows: count('arrow'), potions: count('healing_potion'),
      gold: count('gold_small') + count('gold_large'), bone: count('bone'),
      freePack: (inv.pack ?? []).filter((x) => x === null).length,
      packSize: (inv.pack ?? []).length,
      ids: all.filter(Boolean).map((x) => `${x.id}:${x.count}`).join(' ') };
  });
  delve.arrows = pack.arrows;
  delve.potions = pack.potions;
  console.log(`  pack after the delve: gold=${pack.gold} bone=${pack.bone} ` +
    `arrows=${pack.arrows} free slots=${pack.freePack}/${pack.packSize}`);
  console.log(`  contents: ${pack.ids}`);
}

say(delve.killed > 0,
  `delve: killed ${delve.killed}/${delve.total} in ${delve.seconds.toFixed(1)}s, ` +
  `took ${delve.damage.toFixed(1)} HP of damage ` +
  `(${(delve.damage / Math.max(1, delve.killed)).toFixed(1)} HP per kill)`);
say(delve.arrows > 0,
  `the boss's Tintreach arrows reached the pack: ${delve.arrows} ` +
  `(quiver emptied first, so every one came from the corpse)` +
  (delve.killed < delve.total ? ' — PARTIAL CLEAR' : ''));
say(delve.arrows >= 5 && delve.arrows <= 9,
  `...and the count is inside the designed 5-9 band (${delve.arrows})`);

await page.screenshot({ path: `${outDir}/dungeon-walls.png` });

if (errors.length > 0) {
  console.log(`\n${errors.length} page error(s):`);
  for (const e of errors.slice(0, 8)) console.log(`  ${e}`);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
