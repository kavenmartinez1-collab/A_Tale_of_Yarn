/**
 * Is the bow usable?
 *
 *   node scripts/bow-usability-check.mjs
 *
 * Not "is the maths right" — `scripts/test-aim.mts` proves the geometry in
 * Node against the game's own projectile integrator. This drives the real game
 * and asks what a player would ask, in numbers:
 *
 *   1. Does the reticle tell the truth? Aim, read the crosshair, loose, and
 *      measure where the arrow actually passes, at 5 / 20 / 50 m.
 *   2. Can you hunt? A deer at 30 m, aimed straight at, over several shots.
 *   3. Can you shoot down a flying dragon? A hit RATE over a set of attempts,
 *      not one lucky arrow. This is the case the game could not do at all:
 *      5.7 degrees of upward aim made anything overhead unhittable.
 *   4. Can you shoot at nothing? The player must never be prevented from
 *      loosing because the game cannot see a target.
 *
 * ## Two ways this probe lied to itself before it worked
 *
 * **Aiming the camera is not `atan2` from the player.** The crosshair is the
 * ray from the camera EYE, ~6 m behind the player and moving whenever the
 * pitch changes, so pointing at a world point is a fixed point: guess, read
 * back the eye the game computed, re-derive, repeat.
 *
 * **The demo spawn is in a bowl.** Measured: the player stands at y=10.6 and
 * the raw terrain rises to 12.9 m within 12 m in every direction sampled. So
 * every long shot was fired into a ridge; the reticle correctly reported
 * "ground at 11 m", the arrow correctly hit it, and three successive versions
 * of this file recorded that as a bow bug. Two attempts to score a heading
 * from `heightAt` also failed, because a sight line drawn from the archer's
 * head clears rises that the real ray — starting a metre lower and 6 m further
 * back — does not. So the range is now FOUND by scanning terrain for somewhere
 * genuinely flat, and the lane is confirmed by asking the game's own
 * `aimTarget()` whether the shot reaches. Never model what the game will tell
 * you.
 */
import { chromium } from 'playwright';

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

// Cut vite's HMR socket. Other agents edit this repo while harnesses run, and
// every save makes vite push a full-page reload — which restarts the world
// mid-measurement. Stubbing the socket leaves `import.meta.hot` intact and
// simply means no update ever arrives; the reload guard below still catches
// everything else.
await page.routeWebSocket(/:5173\//, () => { /* swallow HMR */ });

const BASE = process.argv[2] ?? 'http://localhost:5173';
await page.goto(`${BASE}/game.html?director=off&tod=0.45&weather=clear`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 60_000 });
await page.waitForTimeout(1500);

const D = async (fn, arg) => {
  const alive = await page.evaluate(() => typeof window.__gameDebug === 'object');
  if (!alive) {
    process.stdout.write('\n!! RUN INVALID — page reloaded mid-run (__gameDebug gone)\n');
    await browser.close();
    process.exit(2);
  }
  return page.evaluate(fn, arg);
};

// ---------------------------------------------------------------------------
// Find somewhere flat enough to shoot 50 m, and go there.
// ---------------------------------------------------------------------------
const range = await D(() => {
  const h = window.__gameDebug.heightAt;
  let best = null;
  for (let gx = -600; gx <= 600; gx += 50) {
    for (let gz = -600; gz <= 600; gz += 50) {
      const y0 = h(gx, gz);
      if (y0 < 3) continue;                       // not in the sea
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const dx = Math.sin(a);
        const dz = -Math.cos(a);
        let rise = 0;
        for (let d = 2; d <= 58; d += 2) {
          rise = Math.max(rise, h(gx + dx * d, gz + dz * d) - y0);
        }
        if (best === null || rise < best.rise) best = { x: gx, z: gz, dx, dz, a, rise, y: y0 };
      }
    }
  }
  return best;
});
process.stdout.write(`range: (${range.x}, ${range.z}) y=${range.y.toFixed(1)},`
  + ` heading ${(range.a * 180 / Math.PI).toFixed(0)} deg,`
  + ` ground rises at most ${range.rise.toFixed(2)} m over 58 m\n`);

await D(([x, z]) => window.__gameDebug.teleport(x, z), [range.x, range.z]);
await page.waitForTimeout(2500);
await D(() => {
  window.__gameDebug.giveItem('composite_bow', 1);
  window.__gameDebug.giveItem('flint_arrow', 400);
  window.__gameDebug.giveItem('arrow', 400);
  window.__gameDebug.equipItem('composite_bow');
  // FLINT — the everyday, BALLISTIC arrow. This file measures whether the bow
  // is usable, and the bow's ordinary ammunition is the one that falls; the
  // rare hitscan bolt has its own harness (tintreach-check.mjs) and would make
  // every drop measurement here trivially zero.
  window.__gameDebug.setAmmo('flint');
});
await page.waitForTimeout(400);
const equipped = await D(() => {
  const inv = window.__gameDebug.inventory();
  return inv.hotbar[inv.selected]?.id ?? null;
});
process.stdout.write(`equipped: ${equipped}\n`);

/**
 * Point the camera so the crosshair ray passes through `target`, and return
 * the aim readout THE GAME reports — so every assertion below is against what
 * the player would be looking at, not against what the probe intended.
 */
async function aimAt(target) {
  for (let i = 0; i < 4; i++) {
    const eye = await D(() => window.__gameDebug.aimTarget().eye);
    const dx = target[0] - eye[0];
    const dy = target[1] - eye[1];
    const dz = target[2] - eye[2];
    const l = Math.hypot(dx, dy, dz) || 1;
    // forward() = [-sin(yaw)*cos(pitch), -sin(pitch), -cos(yaw)*cos(pitch)]
    const pitch = Math.asin(Math.max(-1, Math.min(1, -dy / l)));
    const yaw = Math.atan2(-dx / l, -dz / l);
    await D(([y, p]) => window.__gameDebug.setCamera(y, p, 6), [yaw, pitch]);
  }
  return D(() => window.__gameDebug.aimTarget());
}

/**
 * Loose one arrow and return the closest it ever came to `mark`.
 *
 * Sampled IN THE PAGE, once per animation frame. Polling this from Node costs
 * a round trip per sample, which at 36 m/s let the arrow move 0.4-1.1 m
 * between looks — so the "closest approach" it reported was a property of the
 * probe's latency, not of the shot. It read 0.65 m for arrows that killed the
 * target outright. One frame is also exactly the resolution the game's own
 * point-in-sphere hit test has, so this measures what the game sees.
 */
async function shootAndTrack(mark) {
  await page.evaluate((m) => {
    window.__aimProbe = { best: Infinity, done: false, seen: false };
    // Clear the pool first: arrows stay planted for 25 s, so without this the
    // tracker picks up a previous shot, decides everything has "settled" on
    // frame one, and reports that shot's distance instead of this one's.
    window.__gameDebug.clearProjectiles?.();
    window.__gameDebug.looseArrow(1);
    let frames = 0;
    let prev = null;
    /** Distance from point `p` to the segment ab. */
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
      for (const p of ps) {
        const d = Math.hypot(p.x - m[0], p.y - m[1], p.z - m[2]);
        if (d < window.__aimProbe.best) window.__aimProbe.best = d;
      }
      // ...and against the PATH between samples, not only the samples.
      //
      // This used to be nearest-sample, and the header's own note explained
      // away the resulting 0.7 m floor as a property of the simulation. That
      // was true while the bow fired a HITSCAN bolt that arrived in one frame.
      // Now that the everyday arrow flies again it advances up to 1.2 m per
      // sampled frame, and a nearest-sample metric measures the sampler rather
      // than the shot: it scored three arrows that each killed their target at
      // 20 m as misses. Interpolating removes the sampler from the answer.
      if (ps.length > 0) {
        const cur = [ps[0].x, ps[0].y, ps[0].z];
        if (prev !== null) {
          const ds = segDist(prev, cur, m);
          if (ds < window.__aimProbe.best) window.__aimProbe.best = ds;
        }
        prev = cur;
      }
      if (ps.length > 0) window.__aimProbe.seen = true;
      frames++;
      // Done when every arrow has planted, when the arrow vanished (killing
      // its anchor releases it), or on a hard frame cap.
      const settled = ps.length > 0 && ps.every((p) => p.stuck);
      if (settled || (window.__aimProbe.seen && ps.length === 0) || frames > 400) {
        window.__aimProbe.done = true;
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, mark);
  await page.waitForFunction(() => window.__aimProbe?.done === true,
    undefined, { timeout: 20_000 });
  return page.evaluate(() => window.__aimProbe.best);
}

/** Place a stationary, unaware target on the ground `dist` down the lane. */
async function target(p, dist, species = 'deer') {
  const tx = p[0] + range.dx * dist;
  const tz = p[2] + range.dz * dist;
  const ty = await D(([x, z]) => window.__gameDebug.heightAt(x, z), [tx, tz]);
  const id = await D(([s, x, y, z]) => window.__gameDebug.placeEntity(s, x, y, z),
    [species, tx, ty, tz]);
  // Held still: this measures AIM. Leading a bolting animal is a player skill
  // and deliberately not something the game solves for them.
  await D((eid) => window.__gameDebug.holdEntity(eid, true), id);
  await page.waitForTimeout(200);
  const e = await D((eid) => {
    const k = window.__gameDebug.entities().find((q) => q.id === eid);
    return k ? { x: k.x, y: k.y, z: k.z, hp: k.hp } : null;
  }, id);
  return { id, e };
}

const hpOf = (id) => D((eid) => {
  const k = window.__gameDebug.entities().find((q) => q.id === eid);
  return k ? { hp: k.hp, mode: k.mode } : { hp: -1, mode: 'gone' };
}, id);

// ---------------------------------------------------------------------------
process.stdout.write('\n=== 1. does the reticle tell the truth? ===\n');
// ---------------------------------------------------------------------------
// Tolerance is the arrow's own sampling: at 36 m/s one sim step is 0.6 m, so a
// shaft passing dead through a point is only ever observed within ~0.3 m of it.
//
// Run in BOTH views. First person moves the eye 6 m forward onto the player's
// head, and the whole reticle contract is that the crosshair is the
// `forward()` ray from whatever the eye currently is — so if that contract
// holds, these numbers must come out the same from either camera. Two weapons
// in this game have already shipped the bug of firing parallel to the camera
// instead of converging on the look point, and moving the eye is exactly the
// kind of change that reintroduces it.
{
  const p = await D(() => window.__gameDebug.playerPos());
  for (const [view, fp] of [['third person', false], ['first person', true]]) {
  await D((v) => window.__gameDebug.setFirstPerson(v), fp);
  await page.waitForTimeout(400);
  const cam = await D(() => window.__gameDebug.cameraState());
  note(
    (fp ? cam.firstPerson > 0.99 && cam.boom < 0.05 && !cam.playerDrawn
      : cam.firstPerson < 0.01 && cam.boom > 2.5 && cam.playerDrawn) ? 'ok' : 'BUG',
    `${view}: the camera is actually there`,
    `blend ${cam.firstPerson.toFixed(3)}, boom ${cam.boom.toFixed(2)} m,`
    + ` player ${cam.playerDrawn ? 'drawn' : 'hidden'}`);
  for (const dist of [5, 20, 50]) {
    const { id, e } = await target(p, dist);
    if (e === null) { note('BUG', `${dist} m: target vanished`, ''); continue; }
    const mark = [e.x, e.y + 0.6, e.z];              // deer size 1.2, body centre
    const aim = await aimAt(mark);
    const aimErr = Math.hypot(
      aim.point[0] - mark[0], aim.point[1] - mark[1], aim.point[2] - mark[2]);
    const miss = await shootAndTrack(aim.point);
    const after = await hpOf(id);
    const damaged = after.hp < e.hp || after.mode === 'gone' || after.mode === 'dead';
    // Three claims. The sharp one is `aimErr`: the reticle marks the target
    // itself, to a couple of centimetres. The decisive one is `damaged` — the
    // thing the crosshair named is the thing that lost hit points.
    //
    // `miss` is the loose one, and it is bounded by the TARGET, not by the
    // shot. An arrow stops the instant its hit test fires, which is anywhere
    // within `0.8 * max(1, size)` of the centre — 0.96 m for a deer — so the
    // closest a flown arrow can ever be OBSERVED to the mark is that radius.
    // The old 0.7 m bound was calibrated when the bow fired a hitscan bolt
    // that arrived exactly on the mark; now that the everyday arrow flies
    // again it reports ~0.92 m for shots that kill their deer outright, and
    // tightening it further would only be measuring the deer.
    //
    // For a measurement of the arc itself, unbounded by an intercepting
    // target, see `ammo-check.mjs`, which shoots at bare ground: 0.06-0.18 m
    // at 5/20/50 m.
    const DEER_HIT_RADIUS = 0.8 * Math.max(1, 1.2);
    const ok = aimErr < 0.25 && miss <= DEER_HIT_RADIUS && damaged;
    note(ok ? 'ok' : 'BUG',
      `${view}, ${dist} m: the arrow goes where the reticle points`,
      `reticle "${aim.name ?? '-'}" at ${aim.dist.toFixed(1)} m from the eye,`
      + ` ${aimErr.toFixed(2)} m off the target centre;`
      + ` arrow passed ${miss.toFixed(3)} m from the reticle point;`
      + ` hp ${e.hp} -> ${after.hp}`);
    await D((eid) => window.__gameDebug.removeEntity(eid), id);
    await page.waitForTimeout(250);
  }
  }
  await D(() => window.__gameDebug.setFirstPerson(null));
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------------------
process.stdout.write('\n=== 1b. the switch into first person ===\n');
// ---------------------------------------------------------------------------
// The transition is the part that can be jarring, and the part no still frame
// would catch. Sampled per animation frame in the page: what matters is that
// the eye travels a continuous path and that the view direction never turns,
// because the ONLY thing moving is the eye sliding along its own ray.
{
  await D(() => window.__gameDebug.setFirstPerson(false));
  await page.waitForTimeout(400);
  const trace = await page.evaluate(async () => {
    const g = window.__gameDebug;
    const out = [];
    g.setFirstPerson(true);
    await new Promise((res) => {
      let n = 0;
      const step = () => {
        const c = g.cameraState();
        out.push({ b: c.firstPerson, e: c.eye, f: c.forward, boom: c.boom });
        if (++n < 70) requestAnimationFrame(step); else res();
      };
      requestAnimationFrame(step);
    });
    return out;
  });
  let maxStep = 0;
  let maxTurn = 0;
  for (let i = 1; i < trace.length; i++) {
    const a = trace[i - 1], b = trace[i];
    maxStep = Math.max(maxStep, Math.hypot(
      b.e[0] - a.e[0], b.e[1] - a.e[1], b.e[2] - a.e[2]));
    const dot = a.f[0] * b.f[0] + a.f[1] * b.f[1] + a.f[2] * b.f[2];
    maxTurn = Math.max(maxTurn, Math.acos(Math.max(-1, Math.min(1, dot))));
  }
  const settled = trace.findIndex((t) => t.boom < 0.05);
  note(maxStep < 1.6 && settled > 3 ? 'ok' : 'BUG',
    'the camera glides in rather than cutting',
    `${settled} frames to arrive, biggest single-frame move ${maxStep.toFixed(3)} m`);
  note(maxTurn < 1e-6 ? 'ok' : 'BUG',
    'and the view direction never turns while it does',
    `worst frame-to-frame turn ${(maxTurn * 180 / Math.PI).toExponential(2)} deg`);
  await D(() => window.__gameDebug.setFirstPerson(null));
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------------------
process.stdout.write('\n=== 2. a deer at 30 m ===\n');
// ---------------------------------------------------------------------------
{
  const p = await D(() => window.__gameDebug.playerPos());
  let hits = 0;
  const SHOTS = 6;
  for (let i = 0; i < SHOTS; i++) {
    const { id, e } = await target(p, 30);
    if (e === null) { note('BUG', 'deer vanished before the shot', ''); continue; }
    const aim = await aimAt([e.x, e.y + 0.6, e.z]);
    await D(() => window.__gameDebug.looseArrow(1));
    await page.waitForTimeout(1500);
    const after = await hpOf(id);
    const hit = after.hp < e.hp || after.mode === 'gone' || after.mode === 'dead';
    if (hit) hits++;
    process.stdout.write(`       shot ${i + 1}: crosshair on "${aim.name ?? '-'}"`
      + ` -> hp ${e.hp} -> ${after.hp} ${hit ? 'HIT' : 'miss'}\n`);
    await D((eid) => window.__gameDebug.removeEntity(eid), id);
    await page.waitForTimeout(200);
  }
  note(hits >= SHOTS - 1 ? 'ok' : 'BUG', 'a deer at 30 m can be hunted',
    `${hits}/${SHOTS} aimed shots connected`);
}

// ---------------------------------------------------------------------------
process.stdout.write('\n=== 3. shooting a flying dragon ===\n');
// ---------------------------------------------------------------------------
// A live one at altitude under its own AI, so it is moving between the aim and
// the impact. Anything under 5.7 degrees of elevation would have been possible
// before; the interesting shots are the ones well above that.
{
  const p = await D(() => window.__gameDebug.playerPos());
  let hits = 0;
  let maxUp = 0;
  const SHOTS = 8;
  // A FRESH dragon per shot. Tintreach is a one-hit kill, so the first arrow
  // ends the target and the remaining seven were being fired at a corpse that
  // had already fallen — the harness scored 1/8 and called the bow broken when
  // the weapon was working perfectly. What this test measures is AIM over a set
  // of attempts, so each attempt needs something alive to aim at.
  let id = null;
  const spawnDragon = async () => {
    if (id !== null) await D((eid) => window.__gameDebug.removeEntity(eid), id);
    id = await D(([q, ux, uz]) => window.__gameDebug.placeEntity(
      'dragon', q[0] + ux * 26, q[1] + 20, q[2] + uz * 26), [p, range.dx, range.dz]);
    await page.waitForTimeout(700);
  };
  await spawnDragon();
  for (let i = 0; i < SHOTS; i++) {
    if (i > 0) await spawnDragon();
    const e = await D((eid) => {
      const k = window.__gameDebug.entities().find((q) => q.id === eid);
      return k ? { x: k.x, y: k.y, z: k.z, hp: k.hp } : null;
    }, id);
    if (e === null) { process.stdout.write('       dragon gone\n'); break; }
    const pl = await D(() => window.__gameDebug.playerPos());
    const up = Math.atan2(e.y - pl[1], Math.hypot(e.x - pl[0], e.z - pl[2])) * 180 / Math.PI;
    maxUp = Math.max(maxUp, up);
    const aim = await aimAt([e.x, e.y + 1.75, e.z]);       // dragon size 3.5
    await D(() => window.__gameDebug.looseArrow(1));
    await page.waitForTimeout(1300);
    const after = await hpOf(id);
    // A one-hit kill drives hp to 0 or below; `>= 0` would score a kill
    // as a miss. What counts is that the arrow LANDED.
    const hit = after.hp < e.hp || after.mode === 'gone' || after.mode === 'dead';
    if (hit) hits++;
    process.stdout.write(`       shot ${i + 1}: ${up.toFixed(0)} deg up,`
      + ` ${aim.dist.toFixed(0)} m, crosshair on "${aim.name ?? '-'}"`
      + ` -> hp ${e.hp} -> ${after.hp} ${hit ? 'HIT' : 'miss'}\n`);
    await page.waitForTimeout(200);
  }
  await D((eid) => window.__gameDebug.removeEntity(eid), id);
  note(hits >= SHOTS * 0.6 ? 'ok' : 'BUG', 'a flying dragon can be shot down',
    `${hits}/${SHOTS} arrows landed on a moving airborne target;`
    + ` steepest shot ${maxUp.toFixed(0)} deg up (old clamp allowed 5.7)`);
}

// ---------------------------------------------------------------------------
process.stdout.write('\n=== 4. shooting at nothing ===\n');
// ---------------------------------------------------------------------------
// "It is dumb to not let someone shoot the bow unless it is aimed at
// something." Straight up at empty sky, and out at a horizon that is beyond
// any arrow's ballistic reach. Both must produce an arrow.
{
  for (const [name, yaw, pitch] of [
    ['straight up at open sky', 0, -1.2],
    ['at the horizon, far out of range', 1.0, 0.0],
  ]) {
    await D(([y, p]) => window.__gameDebug.setCamera(y, p, 6), [yaw, pitch]);
    await page.waitForTimeout(150);
    const before = await D(() => window.__gameDebug.projectileCount());
    const fired = await D(() => window.__gameDebug.looseArrow(1));
    await page.waitForTimeout(150);
    const after = await D(() => window.__gameDebug.projectileCount());
    const aim = await D(() => window.__gameDebug.aimTarget());
    note(fired && after > before ? 'ok' : 'BUG', `you can loose ${name}`,
      `fired=${fired}, projectiles ${before} -> ${after},`
      + ` ballistic solution ${aim.launch === null ? 'none (it falls short)' : 'exists'}`);
    await page.waitForTimeout(700);
  }
}

// ---------------------------------------------------------------------------
process.stdout.write('\n=== 5. the reticle element ===\n');
// ---------------------------------------------------------------------------
{
  const r = await page.evaluate(() => {
    const el = document.getElementById('aim-reticle');
    if (el === null) return null;
    const cs = getComputedStyle(el);
    return {
      cls: el.className, opacity: cs.opacity, z: cs.zIndex, pe: cs.pointerEvents,
      label: document.getElementById('aim-reticle-label')?.textContent ?? '',
      arms: el.querySelectorAll('line').length,
      knots: el.querySelectorAll('circle').length,
    };
  });
  if (r === null) note('BUG', 'the reticle exists', 'no #aim-reticle in the DOM');
  else {
    note('ok', 'the reticle exists',
      `${r.arms} stitched arms + ${r.knots} knot, z=${r.z},`
      + ` class="${r.cls}", label="${r.label}"`);
    note(r.pe === 'none' ? 'ok' : 'BUG', 'it cannot steal pointer lock',
      `pointer-events: ${r.pe}`);
  }
  // And it must disappear when the bow is put away.
  await D(() => window.__gameDebug.equipItem('bronze_axe'));
  await page.waitForTimeout(400);
  const hidden = await page.evaluate(() =>
    getComputedStyle(document.getElementById('aim-reticle')).opacity);
  note(Number(hidden) < 0.05 ? 'ok' : 'BUG', 'it hides when the bow is put away',
    `opacity ${hidden} holding an axe`);
}

process.stdout.write('\n=== summary ===\n');
const bugs = findings.filter((f) => f.severity === 'BUG');
for (const e of errors.slice(0, 6)) process.stdout.write(`  page error: ${e}\n`);
process.stdout.write(`${bugs.length} bugs across ${findings.length} checks\n`);
await browser.close();
process.exit(bugs.length === 0 ? 0 : 1);
