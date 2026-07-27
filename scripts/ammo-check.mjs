/**
 * Two quivers, one bow — does either of them go where the crosshair says?
 *
 *   node scripts/ammo-check.mjs [baseUrl]
 *
 * The bow now fires a BALLISTIC flint arrow or a HITSCAN Tintreach bolt, and
 * the reticle has to tell the truth about both — which are two different
 * truths, because only one of them falls. So every claim here is measured
 * against the game's own `aimTarget()` readout rather than against what the
 * probe intended to aim at:
 *
 *   1. RETICLE vs IMPACT at 5 / 20 / 50 m, for BOTH ammo types.
 *   2. The reticle reports 'far' when — and only when — the arc really does
 *      fall short. A tap draw cannot reach 50 m; a full draw can.
 *   3. REAL INPUT. A real mousedown/mouseup through the game's own listeners,
 *      not a debug hook: the debug path and the real path have diverged in
 *      this project before. The right stack must be the one that empties.
 *   4. The ammo choice is the player's: flint never silently upgrades itself
 *      to a rare boss drop.
 *
 * Aiming method, target placement and the in-page closest-approach sampler are
 * lifted from `bow-usability-check.mjs`, including the two mistakes recorded in
 * its header (the camera eye is not the player, and the demo spawn is in a
 * bowl). Targets are placed on the CARVED ground, because that is now what the
 * arrow's own floor test uses.
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

// Other agents edit this repo live; a vite HMR reload mid-run restarts the
// world and silently corrupts the measurement.
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

// --- find a lane flat enough to shoot 130 m --------------------------------
//
// 130 m rather than 58, because the reach test below needs an aim point BEYOND
// a tap draw's ballistic range. Max range is speed^2/g and MIN_DRAW_POWER is
// 0.35 — not zero — so an undrawn bow still leaves at 24.95 m/s and carries
// 63.5 m, while a full draw at 36 m/s carries 132 m. A 58 m lane cannot
// separate the two and the first version of this probe reported the reticle as
// broken because it assumed a 36.8 m tap range and aimed at 56 m.
const range = await D(() => {
  const h = window.__gameDebug.groundHeightAt;
  let best = null;
  for (let gx = -700; gx <= 700; gx += 40) {
    for (let gz = -700; gz <= 700; gz += 40) {
      const y0 = h(gx, gz);
      if (y0 < 3) continue;
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        const dx = Math.sin(a);
        const dz = -Math.cos(a);
        let rise = 0;
        let dev = 0;
        for (let d = 2; d <= 130; d += 2) {
          const dh = h(gx + dx * d, gz + dz * d) - y0;
          rise = Math.max(rise, dh);
          // ABSOLUTE deviation, not just rise. Scoring rises only rewards a
          // DOWNHILL lane, and a downhill lane has a crest: the first version
          // picked a slope that dropped 3.1 m over 12 m, put a deer at the
          // bottom of it, and recorded the arrow clipping the brow of the hill
          // as "the bow missed". The sight line clears a crest that the ARC
          // does not — the eye is 0.4 m above the muzzle and the arc sags
          // another 0.16 m at that range — so a lane has to be flat in both
          // directions before it can measure anything about aiming.
          dev = Math.max(dev, Math.abs(dh));
        }
        const score = dev + rise;
        if (best === null || score < best.score) {
          best = { x: gx, z: gz, dx, dz, a, rise, dev, score, y: y0 };
        }
      }
    }
  }
  return best;
});
process.stdout.write(`range (${range.x}, ${range.z}) y=${range.y.toFixed(1)},`
  + ` rises at most ${range.rise.toFixed(2)} m over 130 m`
  + ` (max |deviation| ${range.dev.toFixed(2)} m)\n\n`);

await D(([x, z]) => window.__gameDebug.teleport(x, z), [range.x, range.z]);
await page.waitForTimeout(2500);
await D(() => {
  window.__gameDebug.giveItem('composite_bow', 1);
  window.__gameDebug.giveItem('flint_arrow', 300);
  window.__gameDebug.giveItem('arrow', 300);
  window.__gameDebug.equipItem('composite_bow');
});
await page.waitForTimeout(400);

/**
 * Remove every wild creature near the lane.
 *
 * Not housekeeping — a correctness requirement. `resolveAim` names the first
 * CREATURE the ray passes, so a bear that wandered onto the range becomes the
 * mark: the probe asked for a 50 m aim point, the crosshair truthfully reported
 * 'Bear, 8.4 m', and the run scored the bow as broken three rows running. The
 * range has to be empty before it is a range.
 */
async function clearField() {
  await D(() => {
    const g = window.__gameDebug;
    const p = g.playerPos();
    for (const e of g.entities()) {
      if (Math.hypot(e.x - p[0], e.z - p[2]) < 180) g.removeEntity(e.id);
    }
  });
  await page.waitForTimeout(300);
}

async function aimAt(target) {
  for (let i = 0; i < 4; i++) {
    const eye = await D(() => window.__gameDebug.aimTarget().eye);
    const dx = target[0] - eye[0];
    const dy = target[1] - eye[1];
    const dz = target[2] - eye[2];
    const l = Math.hypot(dx, dy, dz) || 1;
    const pitch = Math.asin(Math.max(-1, Math.min(1, -dy / l)));
    const yaw = Math.atan2(-dx / l, -dz / l);
    await D(([y, p]) => window.__gameDebug.setCamera(y, p, 6), [yaw, pitch]);
  }
  return D(() => window.__gameDebug.aimTarget());
}

/**
 * Loose one arrow; return how close its PATH came to `mark`.
 *
 * Distance to the SEGMENT between consecutive samples, not to the samples.
 * That distinction is the whole measurement: the sampler runs once per
 * animation frame and a full-draw arrow covers 0.6 m per frame, so a
 * nearest-SAMPLE metric has a resolution floor of about 0.3 m and can read up
 * to 0.6 m of pure sampling error. The first version of this probe used
 * nearest-sample, reported 0.92 m for a shot that killed its target outright,
 * and scored the bow as broken. Interpolating removes the sampler from the
 * answer entirely.
 *
 * Also returns whether the shot CONNECTED, because that is the claim that
 * actually matters and it is not inferable from a distance alone.
 */
async function shootAndTrack(mark, power = 1, targetId = null) {
  await page.evaluate(([m, pw, tid]) => {
    const hpOf = () => {
      if (tid === null) return null;
      const k = window.__gameDebug.entities().find((q) => q.id === tid);
      return k === undefined ? 'gone' : k.hp;
    };
    window.__aimProbe = { best: Infinity, done: false, seen: false,
      hp0: hpOf(), hp1: null, step: 0 };
    window.__gameDebug.looseArrow(pw);
    let frames = 0;
    let prev = null;
    /** Distance from point `p` to segment ab. */
    const segDist = (a, b, p) => {
      const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
      const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
      const len2 = abx * abx + aby * aby + abz * abz;
      const t = len2 < 1e-9 ? 0
        : Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / len2));
      return Math.hypot(apx - abx * t, apy - aby * t, apz - abz * t);
    };
    const tick = () => {
      const ps = window.__gameDebug.projectiles()
        .filter((p) => p.kind === 'arrow' && p.team === 'player');
      const cur = ps.length > 0 ? [ps[0].x, ps[0].y, ps[0].z] : null;
      if (cur !== null) {
        const d = Math.hypot(cur[0] - m[0], cur[1] - m[1], cur[2] - m[2]);
        if (d < window.__aimProbe.best) window.__aimProbe.best = d;
        if (prev !== null) {
          const ds = segDist(prev, cur, m);
          if (ds < window.__aimProbe.best) window.__aimProbe.best = ds;
          window.__aimProbe.step = Math.max(window.__aimProbe.step,
            Math.hypot(cur[0] - prev[0], cur[1] - prev[1], cur[2] - prev[2]));
        }
        prev = cur;
        window.__aimProbe.seen = true;
      }
      frames++;
      const settled = ps.length > 0 && ps.every((p) => p.stuck);
      if (settled || (window.__aimProbe.seen && ps.length === 0) || frames > 400) {
        window.__aimProbe.hp1 = hpOf();
        window.__aimProbe.done = true;
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [mark, power, targetId]);
  await page.waitForFunction(() => window.__aimProbe?.done === true,
    undefined, { timeout: 20_000 });
  return page.evaluate(() => ({
    miss: window.__aimProbe.best,
    step: window.__aimProbe.step,
    hp0: window.__aimProbe.hp0,
    hp1: window.__aimProbe.hp1,
  }));
}

/** Stationary, unaware target `dist` down the lane, standing on carved ground. */
async function target(dist, species = 'deer') {
  const p = await D(() => window.__gameDebug.playerPos());
  const tx = p[0] + range.dx * dist;
  const tz = p[2] + range.dz * dist;
  const ty = await D(([x, z]) => window.__gameDebug.groundHeightAt(x, z), [tx, tz]);
  const id = await D(([s, x, y, z]) => window.__gameDebug.placeEntity(s, x, y, z),
    [species, tx, ty, tz]);
  await D((eid) => window.__gameDebug.holdEntity(eid, true), id);
  await page.waitForTimeout(200);
  const e = await D((eid) => {
    const k = window.__gameDebug.entities().find((q) => q.id === eid);
    return k ? { x: k.x, y: k.y, z: k.z, hp: k.hp } : null;
  }, id);
  return { id, e };
}

const cleanup = (id) => D((eid) => window.__gameDebug.removeEntity(eid), id);

// ===========================================================================
process.stdout.write('=== 1. does each arrow go where the crosshair says? ===\n');
// ===========================================================================
// RETICLE vs IMPACT is measured against BARE GROUND, not against a creature.
//
// An arrow stops the instant its hit test fires, which is anywhere within
// 0.8 * max(1, size) of the target's centre — so the closest approach it can
// ever record to a creature is bounded below by the hit radius, not by the aim
// error. Measured that way a perfect shot reads ~0.9 m off and looks broken,
// which is exactly what the previous version of this probe reported for three
// arrows that each killed their deer outright. Ground does not move, does not
// intercept early, and the arrow plants exactly where the arc meets it.
/**
 * Point the camera so the crosshair lands on bare ground at ~`want` metres.
 *
 * Pitch, not a world point. Aiming AT a ground point on flat terrain is
 * ill-conditioned — the ray is nearly parallel to the surface, so a hundredth
 * of a radian moves the intersection tens of metres, and asking for "the point
 * 20 m down the lane" got a crosshair reading 10.4 m. Sweeping pitch and
 * reading back the range THE GAME reports inverts the problem the stable way.
 */
async function markAtRange(want) {
  // DOWNWARD IS POSITIVE PITCH. forward() = [-sin(yaw)cos(p), -sin(p), -cos(yaw)cos(p)],
  // so a ray that descends needs sin(p) > 0. The first version swept negative,
  // i.e. into the sky, where every sample returns the 160 m open-sky fallback —
  // which is why it reported the same 143.7 m mark for a 5 m and a 50 m request.
  let far = 0.0005;   // shallow  -> distant
  let near = 1.0;     // steep    -> close
  let best = null;
  let bestPitch = 0.01;
  for (let i = 0; i < 22; i++) {
    const mid = (far + near) / 2;
    const a = await D(([yaw, pitch]) => {
      window.__gameDebug.setCamera(yaw, pitch, 6);
      return window.__gameDebug.aimTarget();
    }, [-range.a, mid]);
    if (best === null || Math.abs(a.dist - want) < Math.abs(best.dist - want)) {
      best = a;
      bestPitch = mid;
    }
    if (a.dist > want) far = mid; else near = mid;
  }
  // LEAVE THE CAMERA WHERE THE BEST SAMPLE WAS. `best` is the closest sample
  // across the whole bisection, but the loop leaves the camera at the LAST
  // sample's pitch — so the probe recorded one mark and then fired at a
  // different one, and reported a Tintreach bolt (which lands exactly on the
  // mark, always) as 20 m off.
  return D(([yaw, pitch]) => {
    window.__gameDebug.setCamera(yaw, pitch, 6);
    return window.__gameDebug.aimTarget();
  }, [-range.a, bestPitch]);
}

await clearField();
const table = { flint: [], tintreach: [] };
for (const ammo of ['flint', 'tintreach']) {
  await D((a) => window.__gameDebug.setAmmo(a), ammo);
  for (const want of [5, 20, 50]) {
    await clearField();
    await D(() => window.__gameDebug.clearProjectiles());
    const aim = await markAtRange(want);
    await D(() => window.__gameDebug.looseArrow(1));
    await page.waitForTimeout(2600);   // 50 m of flight plus settle
    const rest = await D(() => {
      const ps = window.__gameDebug.projectiles().filter((q) => q.team === 'player');
      return ps.length === 0 ? null : { p: [ps[0].x, ps[0].y, ps[0].z], stuck: ps[0].stuck };
    });
    const plant = rest === null ? null : Math.hypot(
      rest.p[0] - aim.point[0], rest.p[1] - aim.point[1], rest.p[2] - aim.point[2]);
    table[ammo].push({ want, reticle: aim.dist, plant, stuck: rest?.stuck ?? null, used: aim.ammo });
    await page.waitForTimeout(200);
  }
}
for (const ammo of ['flint', 'tintreach']) {
  for (const r of table[ammo]) {
    // 0.8 m is the arrow's own hit radius against a size-1 creature: inside
    // that, "where the reticle said" and "where the arrow landed" are the same
    // point as far as the game's own hit test is concerned.
    const ok = r.plant !== null && r.plant <= 0.8 && r.used === ammo && r.stuck === true;
    note(ok ? 'ok' : 'BUG',
      `${ammo}: reticle marked ${r.reticle.toFixed(1)} m (wanted ~${r.want}),`
      + ` arrow landed ${r.plant === null ? 'n/a' : `${r.plant.toFixed(2)} m`} from the mark`,
      `ammo spent=${r.used}, planted=${r.stuck}`);
  }
}

// ...and separately, the claim that actually matters: the thing the crosshair
// NAMED is the thing that loses hit points.
for (const ammo of ['flint', 'tintreach']) {
  await D((a) => window.__gameDebug.setAmmo(a), ammo);
  for (const dist of [5, 20, 50]) {
    await clearField();
    await D(() => window.__gameDebug.clearProjectiles());
    const t = await target(dist);
    if (t.e === null) { note('BUG', `${ammo} @ ${dist} m: target would not place`); continue; }
    const aim = await aimAt([t.e.x, t.e.y + 0.6, t.e.z]);
    const s = await shootAndTrack(aim.point, 1, t.id);
    const connected = s.hp1 === 'gone' || (typeof s.hp1 === 'number' && s.hp1 < s.hp0);
    note(connected && aim.isTarget ? 'ok' : 'BUG',
      `${ammo} @ ${dist} m: the named target takes the hit`,
      `reticle named "${aim.name}", hp ${s.hp0} -> ${s.hp1}`);
    await cleanup(t.id);
    await page.waitForTimeout(250);
  }
}

// ===========================================================================
process.stdout.write('\n=== 2. does the reticle admit when the arc falls short? ===\n');
// ===========================================================================
{
  await D((a) => window.__gameDebug.setAmmo(a), 'flint');
  // The band the test needs, derived rather than assumed. Max ballistic range
  // is speed^2/g, and MIN_DRAW_POWER is 0.35 — NOT zero — so an undrawn bow
  // leaves at 24.95 m/s and reaches 63.5 m, while a full draw at 36 m/s reaches
  // 132 m. The first version of this probe assumed 19 m/s and 36.8 m, aimed at
  // 56 m, and scored a perfectly honest reticle as a bug. So: find a mark
  // genuinely between the two, by sweeping the pitch until the ray lands there.
  const MARK_MIN = 70;
  const MARK_MAX = 125;
  let found = null;
  for (let p = 0.002; p <= 0.40 && found === null; p += 0.002) {
    const a = await D(([yaw, pitch]) => {
      window.__gameDebug.setCamera(yaw, pitch, 6);
      return window.__gameDebug.aimTarget();
    }, [-range.a, p]);
    if (!a.isTarget && a.dist >= MARK_MIN && a.dist <= MARK_MAX) found = a;
  }
  if (found === null) {
    note('BUG', 'could not find a mark between tap-draw and full-draw reach',
      `needed a ${MARK_MIN}-${MARK_MAX} m aim point on this terrain`);
  } else {
    const tap = await D(() => {
      window.__gameDebug.bowDrawTo(0);
      return window.__gameDebug.aimTarget();
    });
    const drawn = await D(() => {
      window.__gameDebug.bowDrawTo(1);
      return window.__gameDebug.aimTarget();
    });
    await D(() => window.__gameDebug.bowDrawTo(null));
    note(tap.reachable === false ? 'ok' : 'BUG',
      `undrawn bow at ${found.dist.toFixed(0)} m reports the arc falls short`,
      `reachable=${tap.reachable} at draw ${tap.drawPower.toFixed(2)}`);
    note(drawn.reachable === true ? 'ok' : 'BUG',
      `full draw at ${found.dist.toFixed(0)} m clears it`,
      `reachable=${drawn.reachable} at draw ${drawn.drawPower.toFixed(2)}`);

    // ...and it must NEVER refuse the shot.
    const cnt = (inv, id) => [...inv.pack, ...inv.hotbar]
      .filter((s) => s && s.id === id).reduce((a, s) => a + s.count, 0);
    const before = await D(() => window.__gameDebug.inventory());
    const fired = await D(() => window.__gameDebug.looseArrow(0));
    await page.waitForTimeout(500);
    const after = await D(() => window.__gameDebug.inventory());
    note(fired === true && cnt(before, 'flint_arrow') - cnt(after, 'flint_arrow') === 1
      ? 'ok' : 'BUG',
      'an out-of-range reticle still fires the shot',
      `fired=${fired}, flint ${cnt(before, 'flint_arrow')} -> ${cnt(after, 'flint_arrow')}`);

    // Tintreach never claims out of range: it has no arc.
    await D((a) => window.__gameDebug.setAmmo(a), 'tintreach');
    const tr = await D(() => {
      window.__gameDebug.bowDrawTo(0);
      const a = window.__gameDebug.aimTarget();
      window.__gameDebug.bowDrawTo(null);
      return a;
    });
    note(tr.reachable === true ? 'ok' : 'BUG',
      'Tintreach is never out of range — it is hitscan',
      `reachable=${tr.reachable} at ${tr.dist.toFixed(0)} m, undrawn`);
  }
}

// ===========================================================================
process.stdout.write('\n=== 3. real input: a real click kills and spends the right stack ===\n');
// ===========================================================================
{
  const cnt = (inv, id) => [...inv.pack, ...inv.hotbar]
    .filter((s) => s && s.id === id).reduce((a, s) => a + s.count, 0);

  /**
   * A real press-and-release through the game's own window listeners.
   *
   * The pointer-lock guard has to be satisfied for the whole hold, not just for
   * the press: `tickBow` cancels the draw the moment `pointerLockElement`
   * stops being the canvas, so restoring the descriptor before mouseup throws
   * the arrow away silently.
   *
   * The player is RE-AIMED mid-draw, which is both realistic and necessary:
   * drawing the bow eases the camera to first person over ~0.16 s, so an aim
   * taken before the press is an aim from a camera that no longer exists.
   */
  const realShot = async (aimPoint) => {
    await page.evaluate(() => {
      const canvas = document.getElementById('game-canvas');
      window.__origPLE = Object.getOwnPropertyDescriptor(
        Document.prototype, 'pointerLockElement');
      Object.defineProperty(document, 'pointerLockElement',
        { configurable: true, get: () => canvas });
      window.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true }));
    });
    await page.waitForTimeout(350);      // let the first-person blend settle
    await aimAt(aimPoint);               // aim while drawing, as a player would
    await page.waitForTimeout(350);      // BOW_DRAW_S is 0.55 s — full power
    // What the crosshair says at the INSTANT of release — the only reading that
    // can distinguish 'the bow shot badly' from 'the probe aimed badly'.
    const atRelease = await page.evaluate(() => {
      const a = window.__gameDebug.aimTarget();
      const d = window.__gameDebug.bowDraw();
      return { name: a.name, dist: a.dist, isTarget: a.isTarget, point: a.point,
        launch: a.launch, reachable: a.reachable, draw: d.t, drawing: d.drawing };
    });
    await page.evaluate(() => {
      window.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true }));
      if (window.__origPLE) {
        Object.defineProperty(document, 'pointerLockElement', window.__origPLE);
      }
    });
    await page.waitForTimeout(900);
    return atRelease;
  };

  for (const ammo of ['flint', 'tintreach']) {
    await D((a) => window.__gameDebug.setAmmo(a), ammo);
    const other = ammo === 'flint' ? 'arrow' : 'flint_arrow';
    const mine = ammo === 'flint' ? 'flint_arrow' : 'arrow';
    // A DEER, not a rabbit. A rabbit's aim point is 0.2 m off the ground, so
    // the crosshair ray meets the terrain before it reaches the animal and the
    // shot lands short — which reads as 'the bow missed' and is really 'the
    // probe aimed at the dirt'. A deer's chest is 0.6 m up and 8 hp dies to one
    // full-draw composite arrow (9).
    await clearField();
    const t = await target(12, 'deer');
    await D(() => window.__gameDebug.clearProjectiles());
    // BOW_REFIRE_S is 0.6 s and `tryStartBowDraw` silently swallows the click
    // inside it — which reads as 'the bow did not fire' with no arrow spent.
    await page.waitForTimeout(1200);
    const before = await D(() => window.__gameDebug.inventory());
    // Live position, not the one recorded at placement — a held animal can
    // still settle onto the ground over the first frames, and aiming at a
    // stale y is an aim error the probe would blame on the bow.
    const live = await D((eid) => {
      const k = window.__gameDebug.entities().find((q) => q.id === eid);
      return k ? [k.x, k.y, k.z] : null;
    }, t.id);
    const rel = await realShot([live[0], live[1] + 0.6, live[2]]);
    const land = await D((eid) => {
      const ps = window.__gameDebug.projectiles().filter((q) => q.team === 'player');
      const k = window.__gameDebug.entities().find((q) => q.id === eid);
      if (ps.length === 0) return null;
      return { arrow: [ps[0].x, ps[0].y, ps[0].z], stuck: ps[0].stuck, n: ps.length,
        dir: [ps[0].dx, ps[0].dy, ps[0].dz],
        player: window.__gameDebug.playerPos(),
        target: k ? [k.x, k.y, k.z] : null };
    }, t.id);
    const after = await D(() => window.__gameDebug.inventory());
    const dead = await D((eid) => {
      const k = window.__gameDebug.entities().find((q) => q.id === eid);
      return k === undefined ? 'gone' : k.mode;
    }, t.id);
    const spentMine = cnt(before, mine) - cnt(after, mine);
    const spentOther = cnt(before, other) - cnt(after, other);
    note(spentMine === 1 && spentOther === 0 && (dead === 'dead' || dead === 'gone')
      ? 'ok' : 'BUG',
      `real click with ${ammo} selected kills and spends ${mine}`,
      `${mine} -1=${spentMine}, ${other} spent=${spentOther}, target=${dead}`
      + ` | release: named=${rel.name} d=${rel.dist.toFixed(1)} draw=${rel.draw.toFixed(2)} launch=${JSON.stringify(rel.launch && rel.launch.map(v=>+v.toFixed(3)))}`
      + ` | arrow n=${land?.n} stuck=${land?.stuck} at ${land?.arrow.map(v=>+v.toFixed(1))} dir ${land?.dir.map(v=>+v.toFixed(2))} player ${land?.player.map(v=>+v.toFixed(1))} deer ${land?.target?.map(v=>+v.toFixed(1))}`
      + (land && land.target ? `, arrow landed ${Math.hypot(land.arrow[0]-land.target[0], land.arrow[2]-land.target[2]).toFixed(2)} m from it (dy ${(land.arrow[1]-land.target[1]).toFixed(2)})` : ''));
    await cleanup(t.id);
  }
}

// ===========================================================================
process.stdout.write('\n=== 4. the rare quiver is never spent by accident ===\n');
// ===========================================================================
{
  const cnt = (inv, id) => [...inv.pack, ...inv.hotbar]
    .filter((s) => s && s.id === id).reduce((a, s) => a + s.count, 0);
  // Empty the flint stack, keep Tintreach, select flint: the bow must refuse
  // rather than reach for the boss loot.
  await D(() => {
    const n = [...window.__gameDebug.inventory().pack,
      ...window.__gameDebug.inventory().hotbar]
      .filter((s) => s && s.id === 'flint_arrow').reduce((a, s) => a + s.count, 0);
    window.__gameDebug.takeItem('flint_arrow', n);
  });
  await D((a) => window.__gameDebug.setAmmo(a), 'flint');
  await page.waitForTimeout(200);
  const before = await D(() => window.__gameDebug.inventory());
  const fired = await D(() => window.__gameDebug.looseArrow(1));
  await page.waitForTimeout(400);
  const after = await D(() => window.__gameDebug.inventory());
  note(fired === false && cnt(before, 'arrow') === cnt(after, 'arrow') ? 'ok' : 'BUG',
    'flint selected + flint empty does NOT reach for Tintreach',
    `fired=${fired}, Tintreach ${cnt(before, 'arrow')} -> ${cnt(after, 'arrow')}`);

  // The reverse IS allowed: running out mid-fight falls back to the common one.
  await D(() => window.__gameDebug.giveItem('flint_arrow', 10));
  await D(() => {
    const inv = window.__gameDebug.inventory();
    const n = [...inv.pack, ...inv.hotbar]
      .filter((s) => s && s.id === 'arrow').reduce((a, s) => a + s.count, 0);
    window.__gameDebug.takeItem('arrow', n);
  });
  await D((a) => window.__gameDebug.setAmmo(a), 'tintreach');
  await page.waitForTimeout(200);
  const b2 = await D(() => window.__gameDebug.inventory());
  const f2 = await D(() => window.__gameDebug.looseArrow(1));
  await page.waitForTimeout(400);
  const a2 = await D(() => window.__gameDebug.inventory());
  note(f2 === true && cnt(b2, 'flint_arrow') - cnt(a2, 'flint_arrow') === 1 ? 'ok' : 'BUG',
    'Tintreach selected + Tintreach empty falls back to flint',
    `fired=${f2}, flint ${cnt(b2, 'flint_arrow')} -> ${cnt(a2, 'flint_arrow')}`);
}

// ===========================================================================
const bugs = findings.filter((f) => f.severity === 'BUG');
process.stdout.write(`\n${bugs.length} bug(s), ${findings.length - bugs.length} ok\n`);
if (errors.length) process.stdout.write(`page errors: ${errors.slice(0, 4).join(' | ')}\n`);
await browser.close();
process.exit(bugs.length > 0 ? 1 : 0);
