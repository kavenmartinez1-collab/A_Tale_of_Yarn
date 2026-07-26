/**
 * Archery / mounted-combat capture harness.
 *
 *   node scripts/archery-shots.mjs [outDir]
 *
 * WHY THIS EXISTS. An arrow at 28 m/s crosses the frame in about six frames.
 * `shot.mjs` photographs a frozen camera and `playthrough.mjs` walks a route
 * pressing WASD — neither of them can be timed to a projectile, and neither
 * presses a mouse button (both are gated on pointer lock, which headless
 * Chrome will not grant). So this drives the game through `__gameDebug`:
 * `fireArrow` looses on an exact heading, `freezeBowAim` pins the draw pose,
 * and each shot is sampled every ~35 ms so the arrow is caught in the air.
 *
 * DISTRUST THE HARNESS. Every scene here also asserts, from the game's own
 * state, that what it photographed is what it claims: that projectiles were
 * actually in flight when the shutter opened, that the arrow moved between
 * frames, that the player is mounted when the scene says "mounted", that
 * damage landed on the mount and not the rider. A green PNG proves nothing —
 * a previous harness in this repo photographed the back of the player's head
 * for a whole session while reporting success.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] || 'scripts/shots/archery';
const BASE = 'http://localhost:5173/game.html';
const SPAWN = [244, -304]; // the flat demo ground the other harnesses use

fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(`${e}\n${e.stack ?? ''}`));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(`console: ${m.text()}`);
});

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const D = Math.PI / 180;

/** setCamera takes RADIANS (see shot.mjs); degrees here for readability. */
async function camera(yawDeg, pitchDeg, dist) {
  await page.evaluate(([y, p, d]) => window.__gameDebug.setCamera(y, p, d),
    [yawDeg * D, pitchDeg * D, dist]);
}

/**
 * Orbit so the camera LOOKS toward a world point instead of at whatever
 * absolute yaw happens to be convenient.
 *
 * OrbitCamera.forward is (-sin yaw, ., -cos yaw), so aiming at an offset
 * (dx, dz) from the player means yaw = atan2(-dx, -dz). Every "the harness
 * photographed the wrong thing" failure in this repo traces back to picking a
 * yaw by hand and assuming it pointed somewhere useful.
 */
async function lookToward(wx, wz, pitchDeg, dist) {
  const yaw = await page.evaluate(([tx, tz]) => {
    const p = window.__gameDebug.playerPos();
    return Math.atan2(-(tx - p[0]), -(tz - p[2]));
  }, [wx, wz]);
  await page.evaluate(([y, p, d]) => window.__gameDebug.setCamera(y, p, d),
    [yaw, pitchDeg * D, dist]);
}

async function boot(query) {
  await page.goto(`${BASE}?director=off&${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__gameReady === true, undefined,
    { timeout: 90000 });
  await page.waitForTimeout(1200);
  // Vitals persist to localStorage, so a previous run that ended on 3 hp comes
  // back on 3 hp and dies to the first swipe of the next scene. Reset first.
  await page.evaluate(([x, z]) => {
    window.__gameDebug.setVitals({ hp: 20, alive: true, hunger: 100, thirst: 100 });
    window.__gameDebug.teleport(x, z);
  }, SPAWN);
  await page.waitForTimeout(3500);
}

const shot = async (name) => {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
};

// ---------------------------------------------------------------------------
// Scene 1 — an arrow in flight, sampled across its whole trajectory
// ---------------------------------------------------------------------------
await boot('tod=0.55&weather=clear');
await page.evaluate(() => {
  window.__gameDebug.equipItem('composite_bow');
  for (const [dx, dz] of [[3, -14], [-2, -18], [6, -22]]) {
    window.__gameDebug.spawnEntity('deer', dx, dz);
  }
});
await camera(0, -4, 7);
await page.waitForTimeout(600);

{
  // NOTE ON TIMING. `window.__gameStats` is only refreshed on the HUD's ~2 Hz
  // tick, so reading projectile counts from it reports a state up to half a
  // second stale — the first run of this harness read 0-in-flight for every
  // frame of a shot that demonstrably flew and landed. Everything here reads
  // `__gameDebug.projectiles()`, which is the live pool.
  //
  // The shot is lofted (25 degrees) rather than flat, for the same reason:
  // a screenshot round-trip is ~150 ms, and a flat arrow is in the dirt inside
  // three of them. A lofted arrow hangs for ~3 s and can actually be filmed.
  //
  // CAMERA GEOMETRY MATTERS MORE THAN TIMING. The first version of this scene
  // fired the arrow along the camera's own forward axis, so every frame was
  // the back of the archer's head with the arrow already a dot on the horizon
  // — all six state assertions passed and not one photograph showed an arrow.
  // Camera yaw 0 looks down -Z (OrbitCamera.forward), so the shot is fired at
  // yaw 90 (+X): perpendicular, crossing the frame left to right.
  //
  // RE-FIRE, don't race the clock. A fixed burst of N screenshots assumes the
  // screenshots are faster than the arrow; on a loaded machine a round trip
  // grew from 150 ms to over a second and the whole burst landed after the
  // arrow already had. Instead, loose a fresh arrow whenever the sky is empty,
  // so there is always something in the air when the shutter opens.
  //
  // Close orbit, not a wide one. At distance 22 the arrow was genuinely there
  // and genuinely in frame and still only a few pixels across — "in flight"
  // is not the same as "legible". 7 m keeps the archer and the first stretch
  // of the arrow's path at a size a person can actually see.
  const frames = [];
  await camera(0, -6, 7);
  await page.waitForTimeout(300);
  for (let i = 0; i < 12; i++) {
    const state = await page.evaluate(() => {
      const dbg = window.__gameDebug;
      let ps = dbg.projectiles();
      if (ps.filter((q) => !q.stuck).length === 0) {
        dbg.fireArrow(90, 18, 0.45);
        ps = dbg.projectiles();
      }
      const cam = window.__gameStats.playerPos ?? [0, 0, 0];
      const live = ps.find((q) => !q.stuck) ?? null;
      return {
        inFlight: ps.filter((p) => !p.stuck).length,
        stuck: ps.filter((p) => p.stuck).length,
        p: live,
        // Distance from the player the camera is orbiting — a projectile
        // 200 m away is "in flight" and also not in the photograph.
        distFromPlayer: live
          ? Math.hypot(live.x - cam[0], live.z - cam[2]) : null,
      };
    });
    const file = await shot(`1-flight-${String(i).padStart(2, '0')}`);
    frames.push({ ...state, file });
  }
  const nearFrames = frames.filter((f) => f.distFromPlayer !== null
    && f.distFromPlayer < 20);
  record('the arrow was close enough to READ in several captured frames',
    nearFrames.length >= 3,
    `${nearFrames.length}/12 frames had the arrow inside 20 m of the camera`);

  const airborne = frames.filter((f) => f.inFlight > 0 && f.p !== null);
  record('an arrow exists in flight while frames are captured',
    airborne.length >= 3, `${airborne.length}/12 frames had a live projectile`);

  // Each capture may be a different arrow (see the re-fire note above), so
  // measure travel and drop WITHIN a shot: the largest spread and the largest
  // pitch change seen across consecutive frames of the same flight.
  let travelled = 0;
  let dyDrop = 0;
  let rose = false;
  for (let i = 1; i < airborne.length; i++) {
    const a = airborne[i - 1].p, b = airborne[i].p;
    const step = Math.hypot(b.x - a.x, b.z - a.z);
    if (step > 0 && step < 60) travelled = Math.max(travelled, step);
    if (a.dy - b.dy > dyDrop) dyDrop = a.dy - b.dy;
    if (b.y > a.y) rose = true;
  }
  record('the arrow actually travelled between frames', travelled > 2,
    `${travelled.toFixed(1)} m between consecutive frames`);
  record('the lofted arrow climbed (it is a real arc)',
    rose || airborne.some((f) => f.p.dy > 0.1));
  record('the shaft tips over as the arrow falls (gravity is visible)',
    dyDrop > 0.02 || airborne.some((f) => f.p.dy < -0.05),
    `largest per-frame pitch drop ${dyDrop.toFixed(3)}`);

  // A separate, short, downward shot for the LANDING assertion. The lofted one
  // above is for filming the arc; over ~100 m of range it can outlive
  // ARROW_MAX_AGE_S or clear a ridge, and "did it stick" deserves a test that
  // is about sticking rather than about the flight time of a long shot.
  // A tight close-up of the arrow leaving the bow — the single frame that
  // shows the shot has a physical cause and a physical object.
  await page.waitForTimeout(1500);
  await camera(0, -4, 5);
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__gameDebug.fireArrow(90, 8, 0.35));
  await shot('1-leaving-the-bow');
  await shot('1-leaving-the-bow-b');

  await page.waitForTimeout(1500);
  await camera(0, -10, 8);
  await page.evaluate(() => window.__gameDebug.fireArrow(90, -12, 1));
  await page.waitForTimeout(1200);
  const landed = await page.evaluate(() =>
    window.__gameDebug.projectiles().filter((p) => p.stuck && p.anchorId === null));
  record('a missed arrow plants in the ground and stays there',
    landed.length > 0, `${landed.length} planted`);
  record('the planted arrow kept the angle it arrived at',
    landed.length > 0 && landed[0].dy < 0,
    landed.length > 0 ? `dy=${landed[0].dy.toFixed(2)}` : '');
  // Frame the planted arrow. The orbit camera is anchored to the PLAYER, so
  // widening the orbit to reach a distant arrow just swings the eye backwards
  // (the first attempt put it out to sea and photographed the seabed). Move
  // the player to the arrow instead, then look at it from a few metres.
  const where = landed.length > 0 ? landed[0] : null;
  if (where !== null) {
    await page.evaluate((w) => window.__gameDebug.teleport(w.x + 3, w.z + 3), where);
    await page.waitForTimeout(900);
    // NOTE: OrbitCamera.forward has y = -sin(pitch), so POSITIVE pitch looks
    // DOWN. A planted arrow is at ankle height; the first attempt used the
    // negative pitch the other harnesses use for scenery and photographed the
    // sky above it.
    await lookToward(where.x, where.z, 26, 4);
    await page.waitForTimeout(500);
    const stillThere = await page.evaluate(() =>
      window.__gameDebug.projectiles().filter((p) => p.stuck && p.anchorId === null).length);
    record('the planted arrow survives the camera move (it is world state)',
      stillThere > 0, `${stillThere} still planted`);
  }
  await shot('1-landed');
}

// ---------------------------------------------------------------------------
// Scene 2 — the draw. Three poses at the same camera so they compare.
// ---------------------------------------------------------------------------
// Pin the doll's facing to -Z, then orbit around it. Without `facePlayer` the
// only way to change the view is to orbit, and while aiming the doll turns
// with the camera — every angle is the back of the archer's head.
await page.evaluate(() => window.__gameDebug.facePlayer(0));
await camera(0, 4, 3.0);
await page.waitForTimeout(300);
for (const [name, aim] of [['rest', 0], ['half', 0.5], ['full', 1]]) {
  await page.evaluate((a) => {
    window.__gameDebug.freezeBowAim(a);
    window.__gameDebug.facePlayer(0);
  }, aim);
  await page.waitForTimeout(260);
  await shot(`2-draw-${name}`);
}
{
  const aimState = await page.evaluate(() => window.__gameStats.bowAim);
  record('the draw pose is live in the render loop', aimState === 1,
    `bowAim=${aimState}`);
}
// The three views that actually show an archer: side-on (draw length), from
// the front (the bow's D and the arrow pointing at you), and three-quarter.
for (const [name, yaw] of [['profile', 90], ['front', 180], ['quarter', 135]]) {
  await page.evaluate(() => window.__gameDebug.facePlayer(0));
  await camera(yaw, 3, 2.8);
  await page.waitForTimeout(280);
  await shot(`2-draw-${name}`);
}
await page.evaluate(() => window.__gameDebug.freezeBowAim(null));

// ---------------------------------------------------------------------------
// Scene 3 — arrows stuck in an animal, riding it as it moves
// ---------------------------------------------------------------------------
{
  const before = await page.evaluate(() => {
    const dbg = window.__gameDebug;
    // Scene 1 fires a dozen arrows across this field and can kill the deer it
    // was set up with, so make sure a live one exists rather than silently
    // testing nothing.
    const e = dbg.entities().find((x) => x.species === 'deer' && x.mode !== 'dead')
      ?? dbg.spawnEntity('deer', 2, -6);
    if (!e) return null;
    // Bring the deer to a fixed spot in front of the player so the camera can
    // be aimed at it deterministically instead of hoping it wandered in view.
    const p = dbg.playerPos();
    e.x = p[0] + 1.5; e.z = p[2] - 6; e.y = dbg.heightAt(e.x, e.z);
    e.mode = 'idle';
    for (let i = 0; i < 3; i++) {
      dbg.injectProjectile(e.x + (i - 1) * 0.35, e.y + 0.8, e.z, 'arrow', 1);
    }
    return { id: e.id, x: e.x, z: e.z, hp: e.hp };
  });
  // Orbit the DEER, not the player. A deer six metres from a human bolts
  // (FLEE_TRIGGER_DIST is 12 m), so pointing the player's orbit camera at
  // where it used to be photographs empty grass — which is what the first
  // version of this scene did while its three assertions passed.
  // setPortraitSubject also holds animals at idle so it stays in frame.
  if (before !== null) {
    await page.evaluate((id) => window.__gameDebug.setPortraitSubject(id), before.id);
    await camera(45, 4, 3.2);
  }
  await page.waitForTimeout(600);
  const after = await page.evaluate((id) => {
    const e = window.__gameDebug.entities().find((x) => x.id === id);
    const ps = window.__gameDebug.projectiles();
    return {
      hp: e?.hp ?? null,
      anchored: ps.filter((p) => p.anchorId === id).length,
      stuck: ps.filter((p) => p.stuck).length,
    };
  }, before?.id);
  record('arrows lodge in the animal they hit',
    (after.anchored ?? 0) > 0, `${after.anchored} anchored to the deer`);
  record('the animal took the damage', before !== null && after.hp < before.hp,
    `${before?.hp} -> ${after.hp}`);
  await shot('3-stuck-in-deer');

  // Move the deer and confirm the arrows go with it.
  const rode = await page.evaluate((id) => {
    const ps0 = window.__gameDebug.projectiles().filter((p) => p.anchorId === id);
    const e = window.__gameDebug.entities().find((x) => x.id === id);
    if (!e || ps0.length === 0) return null;
    const before = { x: ps0[0].x, z: ps0[0].z };
    // Shove the deer; the arrows are anchored to it, not to the world.
    e.x += 6; e.z -= 4;
    return { before };
  }, before?.id);
  // followAnchors runs on the sim tick; under load a 200 ms wait was
  // occasionally too few frames and this read the pre-shove position.
  await page.waitForTimeout(700);
  const rodeAfter = await page.evaluate((id) =>
    window.__gameDebug.projectiles().filter((p) => p.anchorId === id)[0] ?? null,
  before?.id);
  record('stuck arrows travel with the animal',
    rode !== null && rodeAfter !== null
      && Math.hypot(rodeAfter.x - rode.before.x, rodeAfter.z - rode.before.z) > 3,
    rodeAfter ? `moved ${Math.hypot(rodeAfter.x - rode.before.x,
      rodeAfter.z - rode.before.z).toFixed(1)} m` : 'no anchored arrow left');
  await page.waitForTimeout(400);
  await shot('3-arrows-rode-along');
  await page.evaluate(() => window.__gameDebug.setPortraitSubject(null));
}

// ---------------------------------------------------------------------------
// Scene 4 — MOUNTED. Rider seat, mounted shot, and the targeting rules.
// ---------------------------------------------------------------------------
await boot('tod=0.55&weather=clear');
await page.evaluate(() => {
  window.__gameDebug.equipItem('composite_bow');
  window.__gameDebug.spawnEntity('dragon', 2, -2);
});
await camera(35, -10, 12);
await page.waitForTimeout(900);

// Mount the dragon: walk onto it and press E.
const mounted = await page.evaluate(async () => {
  const dbg = window.__gameDebug;
  const d = dbg.entities().find((e) => e.species === 'dragon');
  if (!d) return { ok: false, why: 'no dragon spawned' };
  // Put the dragon right next to the player so the 3 m mount reach applies.
  const p = dbg.playerPos();
  d.x = p[0] + 1.2; d.z = p[2]; d.y = dbg.heightAt(d.x, d.z);
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE', bubbles: true }));
  await new Promise((r) => setTimeout(r, 400));
  return { ok: dbg.mounted() !== null, id: dbg.mounted() };
});
record('the player is mounted on the dragon', mounted.ok, mounted.why ?? mounted.id);
await page.waitForTimeout(700);
await shot('4-mounted-seat');

{
  const st = await page.evaluate(() => ({
    mounted: window.__gameStats.mountedEntityId,
    mountHp: window.__gameStats.mountHp,
  }));
  record('the mount reports hit points (it is a body that can be hurt)',
    typeof st.mountHp === 'number', `hp=${st.mountHp}`);
}

// Mounted archery: the rider's own weapon, while F/G stay the mount's.
{
  const shotState = await page.evaluate(() => {
    const dbg = window.__gameDebug;
    const mountId = dbg.mounted();
    const mount = dbg.entities().find((e) => e.id === mountId) ?? null;
    const before = dbg.projectiles().filter((p) => !p.stuck).length;
    const arrowsBefore = dbg.inventory().hotbar
      .concat(dbg.inventory().pack)
      .filter((s) => s && s.id === 'arrow')
      .reduce((n, s) => n + s.count, 0);
    const fired = dbg.fireArrow(0, 25, 1);
    const after = dbg.projectiles().filter((p) => !p.stuck).length;
    const arrowsAfter = dbg.inventory().hotbar
      .concat(dbg.inventory().pack)
      .filter((s) => s && s.id === 'arrow')
      .reduce((n, s) => n + s.count, 0);
    return {
      fired, before, after, mountHp: mount?.hp ?? null, mountId,
      arrowsBefore, arrowsAfter,
    };
  });
  record('a mounted player can loose an arrow',
    shotState.fired && shotState.after > shotState.before,
    `in flight ${shotState.before} -> ${shotState.after}`);
  record('the mounted shot spent an arrow from the quiver',
    shotState.arrowsAfter === shotState.arrowsBefore - 1,
    `${shotState.arrowsBefore} -> ${shotState.arrowsAfter}`);
  await page.waitForTimeout(120);
  await shot('4-mounted-shot');
  await page.waitForTimeout(2500);
  const mountHpAfter = await page.evaluate((id) =>
    window.__gameDebug.entities().find((e) => e.id === id)?.hp ?? null,
  shotState.mountId);
  record('the mounted shot did not hit the player\'s own mount',
    mountHpAfter === shotState.mountHp,
    `mount hp ${shotState.mountHp} -> ${mountHpAfter}`);
}

// A melee swing from the saddle must also reach something on the ground —
// "the person can use weapons or arrows", not only the bow. This runs the
// REAL left-click resolver (`leftClick`), the same function the mouse calls,
// so it exercises the priority chain and the reach/height gates rather than a
// convenient shortcut past them.
{
  const melee = await page.evaluate(async () => {
    const dbg = window.__gameDebug;
    if (dbg.mounted() === null) return { ok: false, why: 'not mounted' };
    dbg.equipItem('iron_sword');
    const mountId = dbg.mounted();
    const mount = dbg.entities().find((e) => e.id === mountId);
    // Put a target right beside the mount and point the mount at it.
    const p = dbg.playerPos();
    const target = dbg.spawnEntity('deer', 0, 0);
    if (!target) return { ok: false, why: 'deer did not spawn' };
    const fx = Math.sin(mount.yaw), fz = -Math.cos(mount.yaw);
    target.x = p[0] + fx * 2.2;
    target.z = p[2] + fz * 2.2;
    target.y = dbg.heightAt(target.x, target.z);
    const hpBefore = target.hp;
    const mountBefore = mount?.hp ?? null;
    dbg.leftClick();
    await new Promise((r) => setTimeout(r, 250));
    const t = dbg.entities().find((e) => e.id === target.id);
    return {
      ok: true, hpBefore, hpAfter: t?.hp ?? null,
      mountBefore, mountAfter: dbg.entities().find((e) => e.id === mountId)?.hp ?? null,
    };
  });
  await shot('4-mounted-melee');
  if (!melee.ok) {
    record('mounted melee scene ran', false, melee.why);
  } else {
    record('a mounted melee swing reaches a target on the ground',
      melee.hpAfter !== null && melee.hpAfter < melee.hpBefore,
      `deer hp ${melee.hpBefore} -> ${melee.hpAfter}`);
    record('a mounted melee swing never damages the mount itself',
      melee.mountAfter === melee.mountBefore,
      `mount hp ${melee.mountBefore} -> ${melee.mountAfter}`);
  }
  await page.evaluate(() => window.__gameDebug.equipItem('composite_bow'));
}

// The same swing from 40 m up must reach nothing: height gates the rider's
// melee exactly as it gates a bear's.
{
  const high = await page.evaluate(async () => {
    const dbg = window.__gameDebug;
    const mountId = dbg.mounted();
    if (mountId === null) return { ok: false, why: 'not mounted' };
    dbg.equipItem('iron_sword');
    const mount = dbg.entities().find((e) => e.id === mountId);
    const p = dbg.playerPos();
    const target = dbg.spawnEntity('deer', 0, 0);
    if (!target) return { ok: false, why: 'deer did not spawn' };
    const fx = Math.sin(mount.yaw), fz = -Math.cos(mount.yaw);
    target.x = p[0] + fx * 2.2;
    target.z = p[2] + fz * 2.2;
    target.y = dbg.heightAt(target.x, target.z);
    const groundY = mount.y;
    mount.y = groundY + 40; // lift the dragon; the rider goes with it
    await new Promise((r) => setTimeout(r, 600));
    // Confirm the lift actually took before asserting anything about it —
    // tickMount owns the rider's Y and could have clamped it straight back.
    const riderY = dbg.playerPos()[1];
    const altitude = dbg.entities().find((e) => e.id === mountId).y - groundY;
    const hpBefore = target.hp;
    dbg.leftClick();
    await new Promise((r) => setTimeout(r, 250));
    const t = dbg.entities().find((e) => e.id === target.id);
    const after = t?.hp ?? null;
    mount.y = groundY;
    return {
      ok: true, hpBefore, hpAfter: after, altitude,
      riderY, targetY: target.y, attackT: dbg.attackT(),
    };
  });
  if (!high.ok) {
    record('airborne melee scene ran', false, high.why);
  } else {
    record('the airborne case really is airborne (precondition)',
      high.altitude > 30, `altitude ${high.altitude?.toFixed(1)} m, ` +
      `rider y ${high.riderY?.toFixed(1)}, target y ${high.targetY?.toFixed(1)}`);
    record('a rider 40 m up cannot melee the ground',
      high.hpAfter === high.hpBefore,
      `deer hp ${high.hpBefore} -> ${high.hpAfter} (attackT ${high.attackT?.toFixed(2)})`);
  }
  await page.evaluate(() => window.__gameDebug.equipItem('composite_bow'));
  await page.waitForTimeout(700);
}

// Draw pose from the saddle.
// Mounted, `facePlayer` is useless — tickMount rewrites the rider's yaw from
// the animal every tick. Derive the camera yaw from the MOUNT instead: the
// camera looks along (-sin cy, -cos cy) and the mount faces (sin my, -cos my),
// so cy = pi/2 - my puts the camera square on the rider's flank.
{
  await page.evaluate(() => window.__gameDebug.freezeBowAim(1));
  const mountYaw = await page.evaluate(() => {
    const id = window.__gameDebug.mounted();
    return window.__gameDebug.entities().find((e) => e.id === id)?.yaw ?? 0;
  });
  for (const [name, sign] of [['side', 1], ['other-side', -1]]) {
    await page.evaluate(([y, p, d]) => window.__gameDebug.setCamera(y, p, d),
      [sign * (Math.PI / 2) - mountYaw, 2 * D, 7]);
    await page.waitForTimeout(400);
    await shot(`4-mounted-draw-${name}`);
  }
  await page.evaluate(() => window.__gameDebug.freezeBowAim(null));
  // The seat on its own, from the same flank.
  await page.evaluate(([y, p, d]) => window.__gameDebug.setCamera(y, p, d),
    [(Math.PI / 2) - mountYaw, 2 * D, 7]);
  await page.waitForTimeout(400);
  await shot('4-mounted-seat-side');
}

// ---------------------------------------------------------------------------
// Scene 5 — a bear cannot maul a rider. It mauls the dragon.
// ---------------------------------------------------------------------------
{
  const outcome = await page.evaluate(async () => {
    const dbg = window.__gameDebug;
    const mountId = dbg.mounted();
    if (mountId === null) return { ok: false, why: 'not mounted' };
    dbg.setVitals({ hp: 20 });
    const p = dbg.playerPos();
    const bear = dbg.spawnEntity('bear', 2.0, 0);
    if (!bear) return { ok: false, why: 'bear did not spawn' };
    const mountBefore = dbg.entities().find((e) => e.id === mountId)?.hp ?? null;
    const hpBefore = dbg.vitals().hp;
    // Sit still long enough for the bear to close and swing several times.
    await new Promise((r) => setTimeout(r, 6000));
    const mountAfter = dbg.entities().find((e) => e.id === mountId)?.hp ?? null;
    return {
      ok: true,
      hpBefore, hpAfter: dbg.vitals().hp,
      mountBefore, mountAfter,
      stillMounted: dbg.mounted() !== null,
      bearMode: dbg.entities().find((e) => e.id === bear.id)?.mode ?? 'gone',
    };
  });
  await shot('5-bear-vs-mounted-rider');
  if (!outcome.ok) {
    record('bear-vs-rider scene ran', false, outcome.why);
  } else {
    record('the bear engaged', outcome.bearMode === 'aggro' || outcome.bearMode === 'dead',
      `bear mode=${outcome.bearMode}`);
    record('the RIDER took no melee damage from the bear',
      outcome.hpAfter >= outcome.hpBefore,
      `player hp ${outcome.hpBefore} -> ${outcome.hpAfter}`);
    record('the MOUNT took the damage instead',
      outcome.mountAfter !== null && outcome.mountAfter < outcome.mountBefore,
      `mount hp ${outcome.mountBefore} -> ${outcome.mountAfter}`);
  }
}

// ---------------------------------------------------------------------------
// Scene 6 — the same bear against an UNMOUNTED player still bites
// ---------------------------------------------------------------------------
{
  const outcome = await page.evaluate(async () => {
    const dbg = window.__gameDebug;
    // Dismount and reset.
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE', bubbles: true }));
    await new Promise((r) => setTimeout(r, 600));
    dbg.setVitals({ hp: 20 });
    const bear = dbg.spawnEntity('bear', 1.6, 0);
    if (!bear) return { ok: false, why: 'bear did not spawn' };
    const hpBefore = dbg.vitals().hp;
    // Long enough for two or three swipes, short enough that the player
    // survives — scene 7 needs a live player, and a death overlay is one of
    // the "black screens" this project has been fooled by before.
    await new Promise((r) => setTimeout(r, 3200));
    const hpAfter = dbg.vitals().hp;
    dbg.killEntity(bear.id);
    dbg.setVitals({ hp: 20 });
    return { ok: true, mounted: dbg.mounted(), hpBefore, hpAfter };
  });
  await shot('6-bear-vs-unmounted');
  if (!outcome.ok) {
    record('unmounted control scene ran', false, outcome.why);
  } else {
    record('the control case is genuinely unmounted', outcome.mounted === null);
    record('an UNMOUNTED player still takes melee normally',
      outcome.hpAfter < outcome.hpBefore,
      `player hp ${outcome.hpBefore} -> ${outcome.hpAfter}`);
  }
}

// ---------------------------------------------------------------------------
// Scene 7 — an owned mount defends its owner
//
// FRESH PAGE, deliberately: scene 6 ends with the player dead, and a dead
// player raises a full-screen death overlay AND stops the vitals/HUD updates.
// The first run of this harness photographed that overlay while reporting on
// pet behaviour it could no longer observe — exactly the failure mode the
// project notes warn about ("two black screens turned out to be a death
// overlay and an NPC chat panel").
// ---------------------------------------------------------------------------
await boot('tod=0.55&weather=clear');
await camera(35, -12, 14);
{
  const alive = await page.evaluate(() => {
    // Vitals persist across reloads, so a run that ended in a death would
    // reload straight back into the overlay. Top the player up first.
    window.__gameDebug.setVitals({ hp: 20, alive: true });
    return window.__gameDebug.vitals().alive;
  });
  record('scene 7 starts from a live player, not a death overlay', alive === true);
  const outcome = await page.evaluate(async () => {
    const dbg = window.__gameDebug;
    const ents = dbg.entities();
    const pet = ents.find((e) => e.owned === true && e.mode !== 'dead');
    if (!pet) return { ok: false, why: 'no owned animal in the world' };
    // Bring it to heel next to the player so the fight is in frame.
    const p = dbg.playerPos();
    pet.x = p[0] + 3; pet.z = p[2] + 1; pet.y = dbg.heightAt(pet.x, pet.z);
    pet.staying = false;
    const wolf = dbg.spawnEntity('wolf', 6, 2);
    if (!wolf) return { ok: false, why: 'wolf did not spawn' };
    const wolfHpBefore = wolf.hp;
    const modes = [];
    let sawWolfAggro = false;
    for (let i = 0; i < 50; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const cur = dbg.entities().find((e) => e.id === pet.id);
      if (cur) modes.push(cur.mode);
      const w0 = dbg.entities().find((e) => e.id === wolf.id);
      if (w0 && w0.mode === 'aggro') sawWolfAggro = true;
    }
    const w = dbg.entities().find((e) => e.id === wolf.id);
    return {
      ok: true,
      petSpecies: pet.species,
      sawWolfAggro,
      defended: modes.includes('defend'),
      modeHistogram: [...new Set(modes)].join(','),
      wolfHpBefore, wolfHpAfter: w?.hp ?? 0, wolfMode: w?.mode ?? 'gone',
    };
  });
  await shot('7-mount-defends-owner');
  if (!outcome.ok) {
    record('mount-defends-owner scene ran', false, outcome.why);
  } else {
    record('the wolf actually came after the player (precondition)',
      outcome.sawWolfAggro, `wolf ended ${outcome.wolfMode}`);
    record('the owned animal entered defend mode', outcome.defended,
      `pet=${outcome.petSpecies} modes seen: ${outcome.modeHistogram}`);
    record('the owned animal damaged the hostile',
      outcome.wolfHpAfter < outcome.wolfHpBefore || outcome.wolfMode === 'dead',
      `wolf hp ${outcome.wolfHpBefore} -> ${outcome.wolfHpAfter} (${outcome.wolfMode})`);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const stats = await page.evaluate(() => window.__gameStats);
console.log(`\nfps at end: ${stats.fps?.toFixed(1)}`);
console.log(`page errors: ${pageErrors.length}`);
for (const e of pageErrors.slice(0, 10)) console.log(`  ${e}`);

fs.writeFileSync(path.join(outDir, 'report.json'),
  JSON.stringify({ results, pageErrors, fps: stats.fps }, null, 2));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
console.log(`shots in ${outDir}`);

await browser.close();
process.exit(failed.length > 0 || pageErrors.length > 0 ? 1 : 0);
