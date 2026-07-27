/**
 * Can the player hit through a wall, and does a melee duel ever end?
 *
 *   node scripts/dungeon-combat-check.mjs [baseUrl]
 *
 * Four claims, and the first two are the same claim in two directions:
 *
 *   1. A SWING through a wall does nothing; the same swing through a doorway
 *      lands. The enemy side of this was gated long ago (dungeon-combat.ts);
 *      the player's 3.2 m melee was a distance and a facing dot with no
 *      geometry test at all.
 *   2. An ARROW stops on a wall; the same arrow through a doorway lands. Both
 *      teams' projectiles were integrated against a heightfield that reads
 *      -1e9 underground, so nothing ever stopped them. Tintreach is checked
 *      separately because it is hitscan and resolves through `resolveAim`
 *      rather than through the integrator.
 *   3. A melee duel with a dread_king CONCLUDES. It used to deadlock: a 1.2 m
 *      knockback punts him past the player's 3.2 m reach, and his own 4.1 m
 *      reach means he stops closing while still able to hit back.
 *   4. A mob-vs-mob corpse is still there a second later. It was stamped
 *      `deadAtS = 0` and culled on the frame it fell.
 *
 * POSITIONING. `teleport` is overworld-only and snaps to TERRAIN height; a
 * dungeon lives at y = -300 in a slot arena far below the world, so using it
 * here puts the player 300 m above the floor while distance readbacks in
 * dungeon-origin coordinates cheerfully report them next to the boss. That has
 * produced false "melee does no damage" results twice in this project. Use
 * `dungeonPlacePlayer`, and check `dungeonSolidAt` rather than eyeballing.
 */
import { chromium } from 'playwright';

const BASE = process.argv[2] ?? 'http://localhost:5173';

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 560 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 180)}`));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !t.includes('Failed to load resource')) {
    errors.push(`CONSOLE ${t.slice(0, 160)}`);
  }
});

const findings = [];
const note = (severity, title, detail) => {
  findings.push({ severity, title, detail });
  process.stdout.write(`  ${severity === 'BUG' ? 'BUG ' : 'ok  '} ${title}\n`);
  if (detail) process.stdout.write(`       ${detail}\n`);
};

await page.routeWebSocket(/:5173\//, () => { /* swallow HMR */ });
await page.goto(`${BASE}/game.html?director=off&tod=0.45&weather=clear`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 90_000 });
await page.waitForTimeout(2000);

const D = async (fn, arg) => {
  const alive = await page.evaluate(() => typeof window.__gameDebug === 'object');
  if (!alive) {
    process.stdout.write('\n!! RUN INVALID — page reloaded mid-run (__gameDebug gone)\n');
    await browser.close();
    process.exit(2);
  }
  return page.evaluate(fn, arg);
};

// --- get inside a populated dungeon ----------------------------------------
let entered = false;
// Prefer a dungeon holding MORE THAN ONE species: mob-vs-mob targeting is
// faction-based, and a room of goblins will stand and look at each other for
// ever, so a single-species delve cannot test the corpse-timer fix at all.
let fallback = false;
for (const [x, z] of [[240, -300], [600, 200], [-400, 500], [900, -700],
  [120, 820], [-900, -200], [400, 1100], [-150, -950], [1200, 400]]) {
  const ok = await D(([gx, gz]) => {
    const g = window.__gameDebug;
    g.teleport(gx, gz);
    if (!g.teleportToNearestEntrance()) return false;
    return g.enterNearestDungeon();
  }, [x, z]);
  await page.waitForTimeout(2500);
  const species = await D(() =>
    [...new Set((window.__gameDebug.dungeonEntities() ?? []).map((e) => e.species))]);
  if (ok && species.length > 1) { entered = true; break; }
  if (ok && species.length === 1 && !fallback) fallback = true;
}
if (!entered && fallback) {
  // Nothing mixed within reach — take a populated one and say so later.
  for (const [x, z] of [[240, -300], [600, 200], [-400, 500]]) {
    const ok = await D(([gx, gz]) => {
      const g = window.__gameDebug;
      g.teleport(gx, gz);
      if (!g.teleportToNearestEntrance()) return false;
      return g.enterNearestDungeon();
    }, [x, z]);
    await page.waitForTimeout(2500);
    const n = await D(() => (window.__gameDebug.dungeonEntities() ?? []).length);
    if (ok && n > 0) { entered = true; break; }
  }
}
if (!entered) { console.error('FAILED: could not enter a populated dungeon'); process.exit(2); }

const grid = await D(() => window.__gameDebug.dungeonGrid());
process.stdout.write(`inside a ${grid.w}x${grid.h} dungeon at`
  + ` ${grid.origin.map((v) => v.toFixed(0)).join(',')}\n\n`);

const cell = (cx, cz) =>
  (cx < 0 || cz < 0 || cx >= grid.w || cz >= grid.h) ? 0 : grid.cells[cz * grid.w + cx];

/**
 * Find a wall to shoot at: two open cells with exactly one solid cell between
 * them, plus a nearby open PAIR with clear line of sight for the control.
 */
/**
 * Two pairs of standable cells inside melee reach: one with a wall between
 * them, one without.
 *
 * Found by asking the GAME, not by pattern-matching the grid. The first
 * version looked for an axis-aligned "open, solid, open" triple and found
 * nothing at all — this dungeon is 344 open cells in a 128x128 grid and no two
 * rooms in it are separated by one or two cells, so the probe gave up without
 * testing anything. Blocked sight lines are mostly DIAGONAL here: a corridor
 * bending round the corner of a room. Enumerating every pair of open cells
 * within reach and asking `dungeonSeesFrom` finds those, and it uses the same
 * `cellLineOfSight` the melee gate itself uses, so the pair the probe picks is
 * by construction a pair the gate has an opinion about.
 *
 * Note the 1.5 m floor: `cellLineOfSight` ignores anything within 0.75 m of
 * either endpoint (a chest in a corner must stay reachable), so two points
 * closer than that always see each other and cannot test anything.
 */
const pairs = await D(() => {
  const g = window.__gameDebug;
  const grid = g.dungeonGrid();
  const cellsOpen = [];
  for (let cz = 0; cz < grid.h; cz++) {
    for (let cx = 0; cx < grid.w; cx++) {
      if (grid.cells[cz * grid.w + cx] !== 0) cellsOpen.push([cx + 0.5, cz + 0.5]);
    }
  }
  const ox = grid.origin[0];
  const oz = grid.origin[2];
  let blocked = null;
  let clear = null;
  for (let i = 0; i < cellsOpen.length && (blocked === null || clear === null); i++) {
    for (let j = i + 1; j < cellsOpen.length; j++) {
      const a = cellsOpen[i];
      const b = cellsOpen[j];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      // Inside the player's 3.2 m melee reach, and past the endpoint slack.
      if (d < 1.8 || d > 3.0) continue;
      const sees = g.dungeonSeesFrom(ox + a[0], oz + a[1], ox + b[0], oz + b[1]);
      if (!sees && blocked === null) blocked = { a, b, d };
      if (sees && clear === null) clear = { a, b, d };
      if (blocked !== null && clear !== null) break;
    }
  }
  return { blocked, clear, openCells: cellsOpen.length };
});

process.stdout.write(`grid: ${pairs.openCells} open cells;`
  + ` blocked pair ${JSON.stringify(pairs.blocked?.d?.toFixed(2) ?? null)} m,`
  + ` clear pair ${JSON.stringify(pairs.clear?.d?.toFixed(2) ?? null)} m\n\n`);
if (pairs.blocked === null || pairs.clear === null) {
  console.error('FAILED: this layout has no blocked/clear pair inside melee reach');
  process.exit(2);
}
const wall = pairs.blocked;
const open = pairs.clear;

/** Park one enemy at grid-local (lx, lz), pinned so the room clamp leaves it. */
async function placeEnemy(lx, lz, species = null) {
  return D(([x, z, sp, ox, oz]) => {
    const g = window.__gameDebug;
    const ents = g.dungeonEntities();
    const me = sp === null ? ents[0] : (ents.find((e) => e.species === sp) ?? ents[0]);
    if (me === undefined) return null;
    // Park everyone else far away so only the subject can be hit, and widen
    // their rooms or the clamp walks them straight back.
    for (const e of ents) {
      if (e === me) continue;
      e.roomX = ox + 400; e.roomZ = oz + 400; e.roomW = 60; e.roomD = 60;
      e.x = ox + 420; e.z = oz + 420; e.mode = 'idle'; e.stateTimer = 999;
    }
    // Widen the subject's own room rect around where we want it, or the very
    // next tick drags it home — that is a feature of dungeon rooms, and it is
    // why simply assigning a position does not stick.
    me.roomX = ox + x - 30; me.roomZ = oz + z - 30; me.roomW = 60; me.roomD = 60;
    me.x = ox + x; me.z = oz + z;
    me.mode = 'idle'; me.stateTimer = 999;
    return { id: me.id, species: me.species, hp: me.hp, x: me.x, z: me.z };
  }, [lx, lz, species, grid.origin[0], grid.origin[2]]);
}

const hpOf = (id) => D((eid) => {
  const e = window.__gameDebug.dungeonEntities().find((q) => q.id === eid);
  return e === undefined ? null : { hp: e.hp, mode: e.mode, x: e.x, z: e.z };
}, id);

/**
 * Face a world point and swing through the REAL left-click. Returns whether
 * the swing actually FIRED.
 *
 * `resolveLeftClick` opens with `if (attackT < 1) return` — a swing already in
 * progress swallows the click — and `freezeAttackT(1)` does not set `attackT`
 * directly: it sets an override that the SIM LOOP folds in on its next step.
 * So freezing and clicking in the same synchronous block clicks against the
 * old, still-recovering value, and roughly three swings in four vanished. The
 * probe reported "four swings through a wall do nothing" as a pass and "the
 * same swing with no wall lands" as a failure, from the same cause.
 *
 * Freeze, let a few frames pass, THEN click — and return the attackT
 * transition so a caller can tell a blocked swing from a swing that never
 * happened. That distinction is the whole point of the control case.
 */
async function swingAt(tx, tz) {
  await D(([x, z]) => {
    const g = window.__gameDebug;
    const p = g.playerPos();
    const want = Math.atan2(x - p[0], -(z - p[2]));
    // THE CAMERA, not the body. `resolveLeftClick` does
    // `controller.yaw = -orbitCam.yaw` before it hit-tests, so calling
    // `facePlayer` and then clicking turns the doll back to face the camera
    // and the facing dot fails against a target the probe was certain it was
    // pointing at. `facePlayer` is kept only so the pose is right in a capture.
    g.setCamera(-want, 0.08, 4);
    g.facePlayer(want);
    g.freezeAttackT(1);
  }, [tx, tz]);
  await page.waitForTimeout(120);          // let the sim apply the override
  const fired = await D(() => {
    // `__gameDebug.attackT()` is live; `__gameStats.attackT` is rebuilt on a
    // 500 ms timer and would report a stale value.
    const before = window.__gameDebug.attackT();
    window.__gameDebug.leftClick();
    return before;
  });
  await page.waitForTimeout(200);
  await D(() => window.__gameDebug.freezeAttackT(null));
  await page.waitForTimeout(500);          // attackT needs 0.5 s to recover
  return fired;
}

// ===========================================================================
process.stdout.write('=== 1. melee through a wall ===\n');
// ===========================================================================
{
  await D(() => {
    window.__gameDebug.giveItem('iron_sword', 1);
    window.__gameDebug.equipItem('iron_sword');
  });

  // THROUGH THE WALL: player and enemy 2 m apart with one solid cell between.
  await D(([lx, lz]) => window.__gameDebug.dungeonPlacePlayer(lx, lz), wall.a);
  const e1 = await placeEnemy(wall.b[0], wall.b[1]);
  await page.waitForTimeout(500);
  const sanity = await D(([ax, az, bx, bz, ox, oz, oy]) => ({
    sees: window.__gameDebug.dungeonSeesFrom(ox + ax, oz + az, ox + bx, oz + bz),
    // The dungeon FLOOR, not y=0. Interiors live at y = -300 in a slot arena
    // far below the world, so probing at 0 is probing hundreds of metres above
    // the ceiling — which `solidAt` correctly calls solid, and the instrument
    // check then failed on every layout.
    playerInRock: window.__gameDebug.dungeonSolidAt(ox + ax, oy + 0.5, oz + az),
  }), [wall.a[0], wall.a[1], wall.b[0], wall.b[1], grid.origin[0], grid.origin[2], grid.origin[1]]);
  const before1 = await hpOf(e1.id);
  const d1 = await D(([id]) => {
    const g = window.__gameDebug;
    const p = g.playerPos();
    const e = g.dungeonEntities().find((q) => q.id === id);
    return Math.hypot(e.x - p[0], e.z - p[2]);
  }, [e1.id]);
  let fired1 = 0;
  for (let i = 0; i < 4; i++) { if ((await swingAt(before1.x, before1.z)) >= 1) fired1++; }
  const after1 = await hpOf(e1.id);
  note(!sanity.sees && !sanity.playerInRock ? 'ok' : 'BUG',
    'instrument check: a wall really is between them, player not inside rock',
    `sees=${sanity.sees} playerInRock=${sanity.playerInRock} gap=${d1.toFixed(2)} m`);
  note(after1.hp === before1.hp && d1 < 3.2 && fired1 === 4 ? 'ok' : 'BUG',
    'four swings through a wall do nothing',
    `hp ${before1.hp} -> ${after1.hp} at ${d1.toFixed(2)} m (reach is 3.2 m),`
    + ` ${fired1}/4 swings actually fired`);

  // THROUGH OPEN AIR: same geometry, no wall.
  await D(([lx, lz]) => window.__gameDebug.dungeonPlacePlayer(lx, lz), open.a);
  const e2 = await placeEnemy(open.b[0], open.b[1]);
  await page.waitForTimeout(500);
  const before2 = await hpOf(e2.id);
  const p2 = await D(() => window.__gameDebug.playerPos());
  const gap2 = Math.hypot(before2.x - p2[0], before2.z - p2[2]);
  const sees2 = await D(([bx, bz]) => {
    const q = window.__gameDebug.playerPos();
    return window.__gameDebug.dungeonSeesFrom(q[0], q[2], bx, bz);
  }, [before2.x, before2.z]);
  const fired2 = await swingAt(before2.x, before2.z);
  const after2 = await hpOf(e2.id);
  note(after2.hp < before2.hp && fired2 >= 1 ? 'ok' : 'BUG',
    'the same swing with no wall lands',
    `hp ${before2.hp} -> ${after2.hp} at ${gap2.toFixed(2)} m, sees=${sees2}, attackT at click=${fired2}`);
}

// ===========================================================================
process.stdout.write('\n=== 2. arrows through a wall ===\n');
// ===========================================================================
{
  await D(() => {
    window.__gameDebug.giveItem('composite_bow', 1);
    window.__gameDebug.giveItem('flint_arrow', 60);
    window.__gameDebug.giveItem('arrow', 60);
    window.__gameDebug.equipItem('composite_bow');
  });

  const shoot = async (ammo, targetId) => {
    await D((a) => window.__gameDebug.setAmmo(a), ammo);
    const t = await hpOf(targetId);
    // Aim the CAMERA at the enemy's chest — the crosshair is the camera ray.
    for (let i = 0; i < 4; i++) {
      const eye = await D(() => window.__gameDebug.aimTarget().eye);
      const dx = t.x - eye[0], dy = (grid.origin[1] + 0.9) - eye[1], dz = t.z - eye[2];
      const l = Math.hypot(dx, dy, dz) || 1;
      await D(([y, p]) => window.__gameDebug.setCamera(y, p, 4),
        [Math.atan2(-dx / l, -dz / l), Math.asin(Math.max(-1, Math.min(1, -dy / l)))]);
    }
    const before = await hpOf(targetId);
    await D(() => window.__gameDebug.looseArrow(1));
    await page.waitForTimeout(900);
    const after = await hpOf(targetId);
    return { before: before.hp, after: after.hp };
  };

  // Through the wall.
  await D(([lx, lz]) => window.__gameDebug.dungeonPlacePlayer(lx, lz), wall.a);
  const e3 = await placeEnemy(wall.b[0], wall.b[1]);
  await page.waitForTimeout(500);
  for (const ammo of ['flint', 'tintreach']) {
    const r = await shoot(ammo, e3.id);
    note(r.after === r.before ? 'ok' : 'BUG',
      `a ${ammo} arrow does not pass through a wall`, `hp ${r.before} -> ${r.after}`);
  }
  // Arrows must also STOP rather than fly on for ever.
  const stuckInWall = await D(() => window.__gameDebug.projectiles()
    .filter((p) => p.team === 'player').every((p) => p.stuck));
  note(stuckInWall ? 'ok' : 'BUG', 'the blocked arrows planted rather than flying on');

  // Through open air.
  await D(([lx, lz]) => window.__gameDebug.dungeonPlacePlayer(lx, lz), open.a);
  const e4 = await placeEnemy(open.b[0], open.b[1]);
  await page.waitForTimeout(500);
  for (const ammo of ['flint', 'tintreach']) {
    const r = await shoot(ammo, e4.id);
    note(r.after < r.before ? 'ok' : 'BUG',
      `a ${ammo} arrow with no wall lands`, `hp ${r.before} -> ${r.after}`);
  }
}

// ===========================================================================
process.stdout.write('\n=== 3. does a dread_king duel ever end? ===\n');
// ===========================================================================
{
  await D(() => {
    window.__gameDebug.giveItem('iron_sword', 1);
    window.__gameDebug.equipItem('iron_sword');
  });
  // Look for a boss; if this dungeon has none, use the toughest thing in it.
  const roster = await D(() => window.__gameDebug.dungeonEntities()
    .map((e) => ({ id: e.id, species: e.species, hp: e.hp })));
  const boss = roster.find((r) => r.species === 'dread_king') ?? null;
  const subject = boss ?? roster.slice().sort((a, b) => b.hp - a.hp)[0];

  await D(([lx, lz]) => window.__gameDebug.dungeonPlacePlayer(lx, lz), open.a);
  const placed = await placeEnemy(open.b[0], open.b[1], subject.species);
  await D(() => window.__gameDebug.healPlayer());
  // Wake it up: this is a DUEL, not target practice.
  await D(([id]) => {
    const e = window.__gameDebug.dungeonEntities().find((q) => q.id === id);
    e.mode = 'aggro'; e.stateTimer = 0;
  }, [placed.id]);
  await page.waitForTimeout(400);

  let swings = 0;
  let stalled = 0;
  let lastHp = (await hpOf(placed.id)).hp;
  const dists = [];
  while (swings < 90) {
    const s = await hpOf(placed.id);
    if (s === null || s.mode === 'dead' || s.hp <= 0) break;
    const p = await D(() => window.__gameDebug.playerPos());
    const d = Math.hypot(s.x - p[0], s.z - p[2]);
    dists.push(d);
    // The player STANDS THEIR GROUND. Walking forward after every hit is what
    // a human would do and it would hide the stalemate completely — the whole
    // failure mode is that the target is punted out of reach and its own AI
    // will not close the gap it was pushed into.
    await swingAt(s.x, s.z);
    swings++;
    const now = await hpOf(placed.id);
    if (now !== null && now.hp === lastHp) stalled++; else stalled = 0;
    lastHp = now === null ? 0 : now.hp;
    if (stalled >= 12) break;
    // KEEP THE PLAYER ALIVE. The question is whether the FIGHT deadlocks, not
    // whether 20 HP survives a boss that hits for 8 — the first version of this
    // loop broke on death after ten swings and reported "does not conclude",
    // when in fact all ten swings had landed and the player had simply lost a
    // stand-still slugging match with a Dread King, which is correct.
    await D(() => window.__gameDebug.healPlayer());
  }
  const end = await hpOf(placed.id);
  const dead = end === null || end.mode === 'dead' || end.hp <= 0;
  const settle = dists.length > 4
    ? dists.slice(-4).reduce((a, b) => a + b, 0) / 4 : -1;
  note(dead ? 'ok' : 'BUG',
    `a stand-still duel with ${subject.species} concludes`,
    `${swings} swings, hp ${subject.hp} -> ${end === null ? 'gone' : end.hp},`
    + ` last-4 mean gap ${settle.toFixed(2)} m, stalled streak ${stalled}`);
}

// ===========================================================================
process.stdout.write('\n=== 4. mob-vs-mob corpses ===\n');
// ===========================================================================
{
  // Two enemies of DIFFERENT SPECIES nose to nose, one on 1 hp, and wait for
  // the tick's own `onAttackEntity` to resolve it. Species matters: mob-vs-mob
  // targeting is faction-based, and two goblins will stand and look at each
  // other for ever.
  //
  // The defect is not that the corpse is missing — it is that `deadAtS` was
  // stamped from `lastSimTime`, which only the PLAYER's damage paths ever
  // wrote. In a delve where the player had not yet killed anything it was still
  // 0, and `simTime - 0 > DEAD_SHOW_S` culls the body on the frame it falls.
  // So the assertion is on the stamp, and it is only meaningful when the player
  // has killed nothing yet in this dungeon.
  const setup = await D(() => {
    const g = window.__gameDebug;
    const alive = g.dungeonEntities().filter((e) => e.mode !== 'dead');
    let a = null;
    let b = null;
    for (const x of alive) {
      for (const y of alive) {
        if (x === y || x.species === y.species) continue;
        a = x; b = y; break;
      }
      if (a !== null) break;
    }
    if (a === null && alive.length >= 2) {
      // Every dungeon reachable from the probe's spawn list holds ONE species,
      // and one faction will not fight itself. Re-badge one of them: `species`
      // is a plain field on the live entity and `factionOf` reads it, so this
      // stages a genuine cross-faction fight through the real tick rather than
      // faking the kill. The mesh changes with it, which is cosmetic here.
      a = alive[0];
      b = alive[1];
      b.species = a.species === 'skeleton' ? 'goblin' : 'skeleton';
      b.hp = Math.min(b.hp, 1);
    }
    if (a === null) return { ran: false, reason: 'fewer than two live enemies' };
    b.hp = 1;
    b.mode = 'idle';
    a.roomX = b.x - 20; a.roomZ = b.z - 20; a.roomW = 40; a.roomD = 40;
    a.x = b.x + 1.2; a.z = b.z;
    a.mode = 'aggro'; a.stateTimer = 0;
    return { ran: true, aId: a.id, bId: b.id,
      a: a.species, b: b.species, simTime: g.simTime() };
  });

  if (!setup.ran) {
    note('BUG', 'could not stage a mob-vs-mob kill', setup.reason);
  } else {
    let res = null;
    for (let i = 0; i < 12 && (res === null || res.mode !== 'dead'); i++) {
      await page.waitForTimeout(1200);
      res = await D(([id]) => {
        const g = window.__gameDebug;
        const b = g.dungeonEntities().find((e) => e.id === id);
        return b === undefined ? null
          : { hp: b.hp, mode: b.mode, deadAtS: b.deadAtS ?? null, now: g.simTime() };
      }, [setup.bId]);
    }
    if (res === null || res.mode !== 'dead') {
      // Staging a real mob-vs-mob kill needs the AI to CHOOSE an entity target,
      // which no amount of setting `mode = 'aggro'` will do — that aims at the
      // player. Rather than choreograph the AI, pin the actual defect: the
      // stamp `_hurtEnemy` would write. It read `lastSimTime`, which was
      // written only by the player's damage paths, so in a delve where the
      // player has killed nothing it was 0 and every mob corpse was culled on
      // the frame it fell.
      const stamp = await D(() => ({
        stamp: window.__gameDebug.dungeonCorpseStampTime(),
        now: window.__gameDebug.simTime(),
      }));
      note(Math.abs(stamp.now - stamp.stamp) < 0.5 ? 'ok' : 'BUG',
        'the corpse timer a mob-vs-mob kill would stamp is the CURRENT sim time',
        `stamp=${stamp.stamp.toFixed(2)} simTime=${stamp.now.toFixed(2)}`
        + ` (0 would mean the body is culled on the frame it falls)`);
    } else {
      // The corpse must be visible for the loot window, i.e. `deadAtS` close to
      // now — NOT 0, which reads as "died at the start of the game".
      const fresh = res.deadAtS !== null && Math.abs(res.now - res.deadAtS) < 15;
      note(fresh ? 'ok' : 'BUG',
        `a ${setup.b} killed by a ${setup.a} leaves a corpse with a live timer`,
        `deadAtS=${res.deadAtS} simTime=${res.now.toFixed(1)}`);
    }
  }
}

const bugs = findings.filter((f) => f.severity === 'BUG');
process.stdout.write(`\n${bugs.length} bug(s), ${findings.length - bugs.length} ok\n`);
if (errors.length) process.stdout.write(`page errors: ${errors.slice(0, 4).join(' | ')}\n`);
await browser.close();
process.exit(bugs.length > 0 ? 1 : 0);
