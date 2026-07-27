/**
 * Does the Tintreach arrow actually do what it claims?
 *
 *   node scripts/tintreach-check.mjs [baseUrl]
 *
 * Five claims, five measurements. None of them is "it looks right":
 *
 *   1. INSTANTANEOUS. The projectile must be at the mark in the same animation
 *      frame the shot is fired, and the target must have lost hp before the
 *      next one. Sampled INSIDE the page — a Node round trip is 5-30 ms, which
 *      is one to two frames, so polling from here cannot tell "instant" from
 *      "fast" and would have scored a flying arrow as a hitscan.
 *   2. ACCURATE. The impact against the point the reticle marked, at 5/20/50 m.
 *   3. DARK. Mean scene luminance from real screenshots before, during and
 *      after the flash. "It looks darker" is not a number.
 *   4. AFFORDABLE. Frame time with the bolt burning against the same camera
 *      with nothing burning.
 *   5. UNIQUE. Every faucet in the game tried in-page against the live
 *      inventory, not against a reading of the source.
 *
 * Writes a filmstrip and the beauty shots to scripts/shots/tintreach/.
 */
import { chromium } from 'playwright';
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const OUT = 'scripts/shots/tintreach';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 200)}`));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error' && !t.includes('Failed to load resource')) {
    errors.push(`CONSOLE ${t.slice(0, 180)}`);
  }
});

const findings = [];
const note = (severity, title, detail) => {
  findings.push({ severity, title, detail });
  process.stdout.write(`  ${severity === 'BUG' ? 'BUG ' : 'ok  '} ${title}\n`);
  if (detail) process.stdout.write(`       ${detail}\n`);
};

await page.goto(`${BASE}/game.html?director=off&tod=0.45&weather=clear`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 90_000 });
await page.waitForTimeout(2000);

/** Every page call goes through here: a mid-run reload invalidates the run. */
const D = async (fn, arg) => {
  const alive = await page.evaluate(() => typeof window.__gameDebug === 'object');
  if (!alive) {
    process.stdout.write('\n!! RUN INVALID — page reloaded mid-run (__gameDebug gone)\n');
    await browser.close();
    process.exit(2);
  }
  return page.evaluate(fn, arg);
};

/** Mean relative luminance of an encoded image buffer, 0..255. */
async function meanLuma(buf) {
  const { data, info } = await sharp(buf).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let sum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += ch) {
    sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    n++;
  }
  return sum / n;
}

/**
 * A screencast, not a screenshot loop.
 *
 * `page.screenshot()` measured 300-360 ms per call on this machine, which is a
 * THIRD of the bolt's whole life. The first version of this file used it, saw
 * -14% at what it labelled "the strike", and was in fact photographing the
 * middle of the burn with the dip already two-thirds recovered. A CDP
 * screencast pushes a frame every time the page paints, with the compositor's
 * own timestamp, so the curve below is the real one.
 */
const cdp = await page.context().newCDPSession(page);
let castFrames = [];
let casting = false;
cdp.on('Page.screencastFrame', async (f) => {
  try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); }
  catch { /* cast already stopped */ }
  if (casting) {
    castFrames.push({ t: f.metadata.timestamp, buf: Buffer.from(f.data, 'base64') });
  }
});
async function startCast(width = 1280, quality = 92) {
  castFrames = [];
  casting = true;
  await cdp.send('Page.startScreencast',
    { format: 'jpeg', quality, maxWidth: width, maxHeight: 720, everyNthFrame: 1 });
}
async function stopCast() {
  casting = false;
  await cdp.send('Page.stopScreencast');
  const f = castFrames;
  castFrames = [];
  return f;
}

// ---------------------------------------------------------------------------
// Somewhere flat enough to shoot 50 m (same scan bow-usability-check uses).
// ---------------------------------------------------------------------------
const range = await D(() => {
  const h = window.__gameDebug.heightAt;
  let best = null;
  for (let gx = -600; gx <= 600; gx += 50) {
    for (let gz = -600; gz <= 600; gz += 50) {
      const y0 = h(gx, gz);
      if (y0 < 3) continue;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const dx = Math.sin(a);
        const dz = -Math.cos(a);
        let rise = 0;
        for (let d = 2; d <= 58; d += 2) rise = Math.max(rise, h(gx + dx * d, gz + dz * d) - y0);
        if (best === null || rise < best.rise) best = { x: gx, z: gz, dx, dz, a, rise, y: y0 };
      }
    }
  }
  return best;
});
process.stdout.write(`range: (${range.x}, ${range.z}) y=${range.y.toFixed(1)},`
  + ` rises ${range.rise.toFixed(2)} m over 58 m\n`);

await D(([x, z]) => window.__gameDebug.teleport(x, z), [range.x, range.z]);
await page.waitForTimeout(2500);
await D(() => {
  window.__gameDebug.giveItem('composite_bow', 1);
  window.__gameDebug.equipItem('composite_bow');
  // The bow has TWO quivers now — a common ballistic flint arrow and this,
  // the rare hitscan bolt — and it defaults to the common one. Without this
  // line the harness fires flint and then reports that Tintreach is neither
  // instantaneous nor blinding, which is true of flint and says nothing about
  // the weapon this file exists to measure.
  window.__gameDebug.setAmmo('tintreach');
});
await page.waitForTimeout(500);

/** Point the crosshair at a world point and return the game's own readout. */
async function aimAt(target) {
  for (let i = 0; i < 4; i++) {
    const eye = await D(() => window.__gameDebug.aimTarget().eye);
    const dx = target[0] - eye[0], dy = target[1] - eye[1], dz = target[2] - eye[2];
    const l = Math.hypot(dx, dy, dz) || 1;
    const pitch = Math.asin(Math.max(-1, Math.min(1, -dy / l)));
    const yaw = Math.atan2(-dx / l, -dz / l);
    await D(([y, p]) => window.__gameDebug.setCamera(y, p, 6), [yaw, pitch]);
  }
  return D(() => window.__gameDebug.aimTarget());
}

async function target(p, dist, species = 'deer') {
  const tx = p[0] + range.dx * dist;
  const tz = p[2] + range.dz * dist;
  const ty = await D(([x, z]) => window.__gameDebug.heightAt(x, z), [tx, tz]);
  const id = await D(([s, x, y, z]) => window.__gameDebug.placeEntity(s, x, y, z),
    [species, tx, ty, tz]);
  await D((eid) => window.__gameDebug.holdEntity(eid, true), id);
  await page.waitForTimeout(250);
  const e = await D((eid) => {
    const k = window.__gameDebug.entities().find((q) => q.id === eid);
    return k ? { x: k.x, y: k.y, z: k.z, hp: k.hp } : null;
  }, id);
  return { id, e };
}

// ===========================================================================
process.stdout.write('\n=== 1. instantaneous, and where the reticle points ===\n');
// ===========================================================================
{
  const p = await D(() => window.__gameDebug.playerPos());
  for (const dist of [5, 20, 50]) {
    const { id, e } = await target(p, dist);
    if (e === null) { note('BUG', `${dist} m: target vanished`, ''); continue; }
    const mark = [e.x, e.y + 0.6, e.z];
    const aim = await aimAt(mark);
    const aimErr = Math.hypot(aim.point[0] - mark[0], aim.point[1] - mark[1],
      aim.point[2] - mark[2]);

    // Fire and sample WITHOUT yielding: the projectile must already be at the
    // mark before control leaves this statement. Then one rAF for the hp.
    const shot = await page.evaluate(async ([m, eid]) => {
      const g = window.__gameDebug;
      const hp0 = g.entities().find((q) => q.id === eid)?.hp ?? -1;
      const t0 = performance.now();
      g.looseArrow(1);
      const ps = g.projectiles().filter((q) => q.kind === 'arrow' && q.team === 'player');
      let sameTick = Infinity;
      for (const q of ps) {
        sameTick = Math.min(sameTick,
          Math.hypot(q.x - m[0], q.y - m[1], q.z - m[2]));
      }
      const frames = [];
      await new Promise((res) => {
        let n = 0;
        const tick = () => {
          const hp = g.entities().find((q) => q.id === eid)?.hp ?? -1;
          frames.push(hp);
          if (++n >= 3) res(); else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return { hp0, sameTick, frames, ms: performance.now() - t0, n: ps.length };
    }, [aim.point, id]);

    const damagedAtFrame = shot.frames.findIndex((h) => h < shot.hp0 || h < 0);
    const ok = aimErr < 0.25 && shot.sameTick < 0.05 && damagedAtFrame === 0;
    note(ok ? 'ok' : 'BUG', `${dist} m: the bolt lands on the mark, this frame`,
      `reticle ${aimErr.toFixed(3)} m off the target centre;`
      + ` bolt ${shot.sameTick.toFixed(4)} m from the reticle point in the SAME tick;`
      + ` hp ${shot.hp0} -> [${shot.frames.join(', ')}] (damaged on frame ${damagedAtFrame})`);
    await D((eid) => window.__gameDebug.removeEntity(eid), id);
    await page.waitForTimeout(1400);
  }
}

// ===========================================================================
process.stdout.write('\n=== 2. shooting at nothing ===\n');
// ===========================================================================
{
  for (const [name, yaw, pitch] of [
    ['straight up at open sky', 0, -1.2],
    ['at the far horizon', 1.0, 0.0],
    ['at the ground under your feet', 0.4, 1.2],
  ]) {
    await D(([y, p]) => window.__gameDebug.setCamera(y, p, 6), [yaw, pitch]);
    await page.waitForTimeout(200);
    const r = await page.evaluate(() => {
      const g = window.__gameDebug;
      const before = g.projectileCount() + g.stuckProjectileCount();
      const fired = g.looseArrow(1);
      const after = g.projectileCount() + g.stuckProjectileCount();
      return { fired, before, after, aim: g.aimTarget().dist };
    });
    note(r.fired ? 'ok' : 'BUG', `you can loose ${name}`,
      `fired=${r.fired}, projectiles ${r.before} -> ${r.after},`
      + ` mark at ${r.aim.toFixed(0)} m`);
    await page.waitForTimeout(1300);
  }
}

// ===========================================================================
process.stdout.write('\n=== 3. does the world actually go dark? ===\n');
// ===========================================================================
let luma = null;
{
  // Something in frame: a bare field cannot show a scene dip.
  const p = await D(() => window.__gameDebug.playerPos());
  const { id } = await target(p, 26, 'dragon');
  await page.waitForTimeout(400);
  const e = await D((eid) => {
    const k = window.__gameDebug.entities().find((q) => q.id === eid);
    return k ? [k.x, k.y + 1.75, k.z] : null;
  }, id);
  if (e !== null) await aimAt(e);
  await page.waitForTimeout(800);

  await startCast();
  await page.waitForTimeout(450);             // ~25 frames of baseline
  const fireT = await page.evaluate(() => {
    window.__gameDebug.looseArrow(1);
    return performance.timeOrigin / 1000 + performance.now() / 1000;
  });
  await page.waitForTimeout(2200);            // the whole life, plus recovery
  const frames = await stopCast();

  const curve = [];
  for (const f of frames) curve.push({ dt: f.t - fireT, l: await meanLuma(f.buf) });
  const base = curve.filter((c) => c.dt < -0.05);
  const lBefore = base.reduce((a, c) => a + c.l, 0) / Math.max(1, base.length);
  const during = curve.filter((c) => c.dt >= 0 && c.dt < 0.12);
  const lDuring = during.length ? Math.min(...during.map((c) => c.l)) : NaN;
  const burn = curve.filter((c) => c.dt >= 0.12 && c.dt < 0.6);
  const lMid = burn.length ? burn.reduce((a, c) => a + c.l, 0) / burn.length : NaN;
  const tail = curve.filter((c) => c.dt > 1.5);
  const lAfter = tail.reduce((a, c) => a + c.l, 0) / Math.max(1, tail.length);
  const darkest = curve.filter((c) => c.dt >= 0)
    .reduce((a, c) => (c.l < a.l ? c : a), { l: 1e9, dt: 0 });

  // Every frame of the flash, so the strip can be looked at.
  let k = 0;
  for (const f of frames) {
    const dt = f.t - fireT;
    if (dt < -0.10 || dt > 1.35) continue;
    writeFileSync(`${OUT}/film-${String(k).padStart(2, '0')}`
      + `-t${Math.round(dt * 1000)}ms.jpg`, f.buf);
    k++;
  }
  luma = { lBefore, lDuring, lMid, lAfter, darkest, n: curve.length, saved: k };
  process.stdout.write(`       ${curve.filter((c) => c.dt > -0.2 && c.dt < 1.4)
    .map((c) => `${Math.round(c.dt * 1000)}:${c.l.toFixed(0)}`).join(' ')}\n`);

  const dropped = darkest.l < lBefore * 0.80;
  const recovered = Math.abs(lAfter - lBefore) < lBefore * 0.06;
  note(dropped ? 'ok' : 'BUG', 'the scene darkens while the bolt burns',
    `mean luminance ${lBefore.toFixed(1)} before ->`
    + ` ${darkest.l.toFixed(1)} at its darkest`
    + ` (${((darkest.l / lBefore - 1) * 100).toFixed(1)}%,`
    + ` ${Math.round(darkest.dt * 1000)} ms in) ->`
    + ` ${lMid.toFixed(1)} mid-burn -> ${lAfter.toFixed(1)} after`);
  note(recovered ? 'ok' : 'BUG', 'and it comes all the way back',
    `${((lAfter / lBefore - 1) * 100).toFixed(2)}% off the pre-shot frames`);
  note(k > 12 ? 'ok' : 'BUG', 'filmstrip captured',
    `${k} frames of the flash saved to ${OUT}/film-*.jpg`);
  await page.waitForTimeout(1200);
  await D((eid) => window.__gameDebug.removeEntity(eid), id);
}

// ===========================================================================
process.stdout.write('\n=== 4. what does it cost? ===\n');
// ===========================================================================
{
  const measure = async (fire) => page.evaluate(async (doFire) => {
    // Warm up, then time raw rAF deltas. Median, not mean: one GC pause in a
    // 60-sample window moves a mean by milliseconds and says nothing.
    const sample = async (n) => {
      const out = [];
      let last = performance.now();
      await new Promise((res) => {
        let k = 0;
        const tick = () => {
          const now = performance.now();
          out.push(now - last);
          last = now;
          if (++k >= n) res(); else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return out;
    };
    await sample(20);
    if (doFire) {
      // Keep a bolt alive for the whole window: LIFE_S is 1.1 s and 60 frames
      // is ~1 s, so one shot covers it, but re-firing guarantees it.
      window.__gameDebug.looseArrow(1);
      setTimeout(() => window.__gameDebug.looseArrow(1), 500);
    }
    const s = await sample(60);
    s.sort((a, b) => a - b);
    return { median: s[30], p95: s[57], max: s[59] };
  }, fire);

  const idle = await measure(false);
  await page.waitForTimeout(1500);
  const hot = await measure(true);
  await page.waitForTimeout(1500);
  const cost = hot.median - idle.median;
  note(cost < 2.0 ? 'ok' : 'BUG', 'the bolt is affordable',
    `frame median ${idle.median.toFixed(2)} ms idle -> ${hot.median.toFixed(2)} ms`
    + ` with a bolt burning (+${cost.toFixed(2)} ms);`
    + ` p95 ${idle.p95.toFixed(2)} -> ${hot.p95.toFixed(2)} ms`);
}

// ===========================================================================
process.stdout.write('\n=== 6. rare, finite, and still unbuyable ===\n');
// ===========================================================================
// This section used to prove "only one Tintreach quiver can ever exist in a
// save". That rule is gone: the arrows are rare, finite boss loot now, so they
// deplete and accumulate like any other item (see the header of tintreach.ts).
// What is still worth guarding is the other half — a shot must cost one, and
// the faucets that were closed stay closed (asserted in test-tintreach.mts,
// which can enumerate every recipe and trade catalogue directly).
{
  const r = await page.evaluate(() => {
    const g = window.__gameDebug;
    const inv = g.inventory();
    const slotsOf = () => [...inv.pack, ...inv.hotbar]
      .filter((s) => s && s.id === 'arrow');
    const before = slotsOf();
    const beforeCount = before.reduce((a, s) => a + s.count, 0);
    // Fifty-two grants, 851 arrows. Every one of them has to land somewhere.
    g.giveItem('arrow', 500);
    g.giveItem('arrow', 1);
    for (let i = 0; i < 50; i++) g.giveItem('arrow', 7);
    const after = slotsOf();
    return {
      beforeSlots: before.length,
      beforeCount,
      afterSlots: after.length,
      afterCount: after.reduce((a, s) => a + s.count, 0),
    };
  });
  // Past one stack and into a second slot is the whole point: the old chokepoint
  // pinned this at exactly 1 slot / 99 arrows no matter what you granted. The
  // total does NOT reach 851, because the starter kit leaves one free pack slot
  // and `addItem` refuses what will not fit — ordinary behaviour for every item
  // in the game, and not what this beat is about.
  note(r.afterSlots > r.beforeSlots && r.afterCount > 99 ? 'ok' : 'BUG',
    'boss drops accumulate past one stack instead of being swallowed',
    `${r.beforeCount} in ${r.beforeSlots} slot(s) -> ${r.afterCount} in`
    + ` ${r.afterSlots} after 52 grants (old rule pinned this at 99 in 1)`);

  // And a shot costs one. The old build put the loosed arrow straight back.
  const fired = await page.evaluate(() => {
    const g = window.__gameDebug;
    const start = g.countItem('arrow');
    let ok = 0;
    for (let i = 0; i < 5; i++) if (g.looseArrow(1)) ok++;
    return { ok, start, end: g.countItem('arrow') };
  });
  note(fired.ok === 5 && fired.start - fired.end === 5 ? 'ok' : 'BUG',
    'every shot spends an arrow',
    `${fired.ok}/5 shots fired; ${fired.start} -> ${fired.end}`
    + ` (spent ${fired.start - fired.end})`);

  const label = await page.evaluate(() => {
    const g = window.__gameDebug;
    const inv = g.inventory();
    const s = [...inv.pack, ...inv.hotbar].find((q) => q && q.id === 'arrow');
    return s ? s.id : null;
  });
  note(label === 'arrow' ? 'ok' : 'BUG', 'the item id is unchanged',
    `every existing ammo check still resolves: ${label}`);
}

// ===========================================================================
process.stdout.write('\n=== 7. beauty shots ===\n');
// ===========================================================================
{
  await page.waitForTimeout(2000);
  // Time of day comes from the URL (?tod=), so a run is one lighting condition;
  // run this file twice with different tod for a day/dusk pair.
  const shots = [
    ['50m', 50, 'deer'],
    ['sky', null, null],
  ];
  for (const [name, dist, species] of shots) {
    const p = await D(() => window.__gameDebug.playerPos());
    let id = null;
    if (dist !== null) {
      const t = await target(p, dist, species);
      id = t.id;
      await aimAt([t.e.x, t.e.y + 0.6, t.e.z]);
    } else {
      await D(() => window.__gameDebug.setCamera(0.6, -0.42, 6));
    }
    await page.waitForTimeout(600);
    await startCast(1280, 94);
    await page.waitForTimeout(250);
    const fireT = await page.evaluate(() => {
      window.__gameDebug.looseArrow(1);
      return performance.timeOrigin / 1000 + performance.now() / 1000;
    });
    await page.waitForTimeout(1300);
    const fs2 = await stopCast();
    // Three moments: the strike, mid-burn, and the ghost.
    for (const [tag, want] of [['a-strike', 0.075], ['b-burn', 0.25], ['c-ghost', 0.7]]) {
      let best = null;
      for (const f of fs2) {
        const d = Math.abs((f.t - fireT) - want);
        if (best === null || d < best.d) best = { d, f, dt: f.t - fireT };
      }
      if (best !== null) {
        writeFileSync(`${OUT}/beauty-${name}-${tag}`
          + `-t${Math.round(best.dt * 1000)}ms.jpg`, best.f.buf);
      }
    }
    if (id !== null) {
      await page.waitForTimeout(1500);
      await D((eid) => window.__gameDebug.removeEntity(eid), id);
    }
    await page.waitForTimeout(800);
  }

  // Side-on: fire, then swing the camera 75 degrees while the seam is still
  // burning. This is a real thing a player does — shoot, then look — and it is
  // the only view that shows the whole bolt at once rather than end-on.
  {
    const p = await D(() => window.__gameDebug.playerPos());
    const t = await target(p, 44, 'deer');
    if (t.e !== null) {
      await aimAt([t.e.x, t.e.y + 0.6, t.e.z]);
      await page.waitForTimeout(500);
      await startCast(1280, 94);
      await page.waitForTimeout(200);
      const fireT = await page.evaluate(() => {
        const g = window.__gameDebug;
        const before = g.aimTarget();
        g.looseArrow(1);
        // Swing off-axis immediately. The bolt is world-space and already
        // placed, so the camera can go anywhere.
        const yaw = Math.atan2(-before.dir[0], -before.dir[2]) + 1.30;
        g.setCamera(yaw, -0.06, 9);
        return performance.timeOrigin / 1000 + performance.now() / 1000;
      });
      await page.waitForTimeout(1100);
      const fs3 = await stopCast();
      for (const [tag, want] of [['a-strike', 0.075], ['b-burn', 0.22], ['c-ghost', 0.62]]) {
        let best = null;
        for (const f of fs3) {
          const d = Math.abs((f.t - fireT) - want);
          if (best === null || d < best.d) best = { d, f, dt: f.t - fireT };
        }
        if (best !== null) {
          writeFileSync(`${OUT}/beauty-side-${tag}`
            + `-t${Math.round(best.dt * 1000)}ms.jpg`, best.f.buf);
        }
      }
      await page.waitForTimeout(1200);
      await D((eid) => window.__gameDebug.removeEntity(eid), t.id);
    }
  }
  note('ok', 'beauty shots captured', `${OUT}/beauty-*.jpg`);
}

process.stdout.write('\n=== summary ===\n');
if (luma !== null) {
  process.stdout.write(`  luminance  before ${luma.lBefore.toFixed(2)}`
    + `  strike ${luma.lDuring.toFixed(2)}`
    + `  burn ${luma.lMid.toFixed(2)}`
    + `  after ${luma.lAfter.toFixed(2)}\n`);
}
const bugs = findings.filter((f) => f.severity === 'BUG');
for (const e of errors.slice(0, 8)) process.stdout.write(`  page error: ${e}\n`);
process.stdout.write(`${bugs.length} bugs across ${findings.length} checks\n`);
await browser.close();
process.exit(bugs.length === 0 ? 0 : 1);
