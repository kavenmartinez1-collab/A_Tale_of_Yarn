/**
 * boss-portraits.mjs — photograph the Evil King and the black dragon in the
 * REAL renderer.
 *
 * Run:  npm run dev   (Vite on :5173)
 *       node scripts/boss-portraits.mjs [outDir]
 *
 * WHY THIS EXISTS ALONGSIDE THE OFFLINE PREVIEWER
 *
 * `scripts/mesh-preview.mts` renders the vertex array in-process in 30 ms and
 * is what the silhouette work was done against. It cannot show the one thing
 * this art direction is actually about: knit, felt and scale are baked on the
 * GPU with triplanar normal mapping, and the eyes and crown finials are
 * emissive. A boss made of black wool either reads as wool up close or the
 * whole exercise failed, and only this harness can tell you.
 *
 * THE TRAPS THIS FILE IS BUILT AROUND
 *
 *  - **Orbit yaw 0 is BEHIND the subject.** That is what had the creature
 *    harness shooting the back of the player's head for days. Mesh facing is
 *    `atan2(dx, -dz)`, so a subject at yaw 0 faces -Z and the camera at orbit
 *    0 sits at +Z. `VIEWS` below is in SUBJECT-RELATIVE degrees (0 = head-on)
 *    and `orbitOf` is the single line that converts, so it cannot drift.
 *  - **Yaw 90 hides a quadruped's length**, so the dragon gets three-quarter
 *    views either side of it and not just the flank.
 *  - **"1 drawn" is not proof of a subject.** Every shot is taken twice — once
 *    normally, once with the subject collapsed to a point — and the changed
 *    pixel fraction is reported. Below MIN_COVER, the image is not evidence.
 *  - **A grounded dragon furls its wings**, because spread is derived from
 *    `flapAmp` and the portrait mode holds animals at idle. The flight state is
 *    forced through `entityRenderer.flightOverride`, or the wingspan — the
 *    single biggest thing about this animal — never appears in a photograph.
 *  - **The rider is placed by the shipping arithmetic**, `kingRiderPlacement`,
 *    reimplemented here from its two exported constants. A harness that seats
 *    the King its own way photographs a rig nobody ships.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] || 'scripts/shots/boss';

/** Below this fraction of changed pixels the subject is missing or occluded. */
const MIN_COVER = 0.004;

// Framing scale, mirroring SPECIES_DEFS[sp].size.
const KING_SIZE = 2.5;
const DRAGON_SIZE = 4.4;

// From black-dragon-mesh.ts / king-mesh.ts. Duplicated deliberately — this is
// a .mjs harness and cannot import TypeScript; `scripts/test-boss-mesh.mts`
// asserts the real values, so a drift here shows up as a rider who is visibly
// not in the saddle rather than as a silent mismatch.
const SEAT_Y = DRAGON_SIZE * 1.02271;
const SEAT_Z = -0.14 * DRAGON_SIZE;
const KING_HIP_Y = KING_SIZE * 0.52;
const RIDER_Y = SEAT_Y - KING_HIP_Y - KING_SIZE * 0.012;

/** Subject-relative yaw (0 = head-on) to the game's orbit yaw, in radians. */
const orbitOf = (rel) => ((180 - rel) * Math.PI) / 180;

/** [name, subjectRelativeYawDeg, eyeRiseInSubjectHeights, distanceMultiplier] */
const VIEWS = [
  ['front', 0, 0.55, 1.00],
  ['tq', 38, 0.50, 1.00],
  ['side', 90, 0.25, 1.00],
  ['rear', 205, 0.55, 1.00],
  ['close', 14, 0.60, 0.40],   // the yarn: near enough to see stitches
  ['low', 26, 0, 0.85],        // from below — how you meet him; see `lowRise`
];

fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
let page = null;
async function freshPage() {
  if (page !== null) await page.close();
  page = await browser.newPage({ viewport: { width: 1100, height: 780 } });
  page.on('pageerror', (e) => console.error('  [pageerror]', e.message.slice(0, 240)));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('  [console]', m.text().slice(0, 240));
  });
  page.on('crash', () => console.error('  [page crashed]'));
  page.on('framenavigated', (f) => {
    if (f === page.mainFrame()) console.error('  [navigated]', f.url().slice(0, 120));
  });
  return page;
}

/** Changed-pixel fraction between two PNGs, via an offscreen canvas. */
async function coverage(aBuf, bBuf) {
  const p = await browser.newPage();
  const cover = await p.evaluate(async ([a, b]) => {
    const load = async (d) => createImageBitmap(
      await (await fetch(`data:image/png;base64,${d}`)).blob());
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const c = new OffscreenCanvas(ia.width, ia.height);
    const g = c.getContext('2d');
    g.drawImage(ia, 0, 0);
    const da = g.getImageData(0, 0, ia.width, ia.height).data;
    g.clearRect(0, 0, ia.width, ia.height);
    g.drawImage(ib, 0, 0);
    const db = g.getImageData(0, 0, ia.width, ia.height).data;
    let n = 0;
    for (let i = 0; i < da.length; i += 4) {
      if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1])
        + Math.abs(da[i + 2] - db[i + 2]) > 42) n++;
    }
    return n / (ia.width * ia.height);
  }, [aBuf.toString('base64'), bBuf.toString('base64')]);
  await p.close();
  return cover;
}

const pending = [];
const log = [];

/**
 * Set the studio up and spawn the subject(s).
 *
 * Runs entirely in the page. Returns the ids and the framing height, or null.
 */
async function setup(p, cfg) {
  return p.evaluate(async (c) => {
    const g = window.__gameDebug;
    const er = window.__entityRenderer;
    if (g === undefined) return null;

    // Flattest ground in a 25x25 grid around a known-open patch: a boss on a
    // slope stands at an angle to every reference line in the frame.
    let best = { x: 244, z: -304, dev: 1e9 };
    for (let ix = -12; ix <= 12; ix++) {
      for (let iz = -12; iz <= 12; iz++) {
        const x = 244 + ix * 9, z = -304 + iz * 9;
        const h = g.heightAt(x, z);
        if (h < 1) continue;
        let dev = 0;
        for (const [dx, dz] of [[6, 0], [-6, 0], [0, 6], [0, -6]]) {
          dev = Math.max(dev, Math.abs(g.heightAt(x + dx, z + dz) - h));
        }
        if (dev < best.dev) best = { x, z, dev };
      }
    }
    g.teleport(best.x, best.z);
    await new Promise((r) => setTimeout(r, 400));
    for (const e of g.entities()) g.killEntity(e.id);

    const mount = c.mounted || c.sp === 'black_dragon'
      ? g.spawnEntity('black_dragon', c.off, 0) : null;
    const king = c.mounted || c.sp === 'evil_king'
      ? g.spawnEntity('evil_king', c.off, 0) : null;
    if ((c.sp === 'black_dragon' && mount === null)
      || (c.sp === 'evil_king' && king === null)) return null;

    const primary = c.sp === 'black_dragon' ? mount : king;
    g.setPortraitSubject(c.mounted ? mount.id : primary.id);

    // Pin the facing by REDEFINING the property. A per-rAF write loses a race
    // with the game loop; this cannot.
    for (const e of [mount, king]) {
      if (e === null) continue;
      Object.defineProperty(e, 'yaw', { get: () => 0, set: () => {}, configurable: true });
    }
    // Same for the rider's POSITION, and for the same reason. The first
    // version wrote king.x/y/z from a requestAnimationFrame loop and the
    // entity manager's ground-snap overwrote y on its own tick — the shots
    // came back with the King standing on the grass in front of the dragon,
    // wings spread over his head, and every coverage number looked healthy.
    if (c.mounted && mount !== null && king !== null) {
      const defs = {
        x: () => mount.x - c.seatZ * Math.sin(mount.yaw),
        y: () => mount.y + c.riderY,
        z: () => mount.z + c.seatZ * Math.cos(mount.yaw),
      };
      for (const k of ['x', 'y', 'z']) {
        Object.defineProperty(king, k, { get: defs[k], set: () => {}, configurable: true });
      }
    }

    // Wings. Spread is derived from `flapAmp`, and portrait mode holds animals
    // at idle (flapAmp 0.30, which is below the 0.36 spread threshold), so a
    // photographed dragon furls unless the flight state is forced.
    if (er !== undefined && c.wings && mount !== null) {
      er.flightOverride = { id: mount.id, state: 'flap' };
    }
    // The seat. `AnimalPose.seat` is not an animation channel — see
    // `EntityRenderer.poseOverride` — so it is set the way the boss code will.
    if (er !== undefined && c.mounted && king !== null) {
      const kid = king.id;
      er.poseOverride = (id, pose) => {
        if (id !== kid) return;
        pose.seat = 1;
        pose.walkAmp = 0;
      };
    }

    window.__pinStop = false;
    window.__pin = () => {
      if (window.__pinStop) return;
      for (const e of [mount, king]) {
        if (e === null) continue;
        e.mode = 'idle';
        e.walkAmp = 0;
      }
      requestAnimationFrame(window.__pin);
    };
    window.__pin();
    return {
      mountId: mount === null ? null : mount.id,
      kingId: king === null ? null : king.id,
      subjectId: c.mounted ? mount.id : primary.id,
      dev: best.dev, x: best.x, z: best.z,
    };
  }, cfg);
}

/** Collapse an entity to a point (never kill it — the camera would snap back). */
async function subScale(p, id, v) {
  return p.evaluate(([sid, s]) => {
    const g = window.__gameDebug;
    if (g === undefined) return 'no-debug';
    const e = g.entities().find((x) => x.id === sid);
    if (e === undefined) return 'no-entity';
    e.scaleOverride = s;
    return 'ok';
  }, [id, v]);
}

async function shoot(label, cfg) {
  process.stdout.write(`${label.padEnd(16)}`);
  const p = await freshPage();
  await p.goto('http://localhost:5173/game.html?director=off&tod=0.52&weather=clear',
    { waitUntil: 'domcontentloaded' });
  await p.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 60_000 });
  await p.waitForTimeout(1400);

  const info = await setup(p, cfg);
  if (info === null) { console.log(' setup failed'); log.push({ label, failed: 'setup' }); return; }

  // Hide every overlay wholesale — naming ids misses runtime-created ones.
  await p.addStyleTag({ content: 'body > *:not(canvas){display:none!important}' });
  await p.waitForTimeout(1800);

  const marks = [];
  for (const [name, rel, rise0, dm] of VIEWS) {
    // The low view's eye rise is per subject. A negative rise on a subject
    // whose orbit target sits near the ground puts the camera UNDER the
    // terrain, and the shot comes back as a hillside with a crown poking over
    // it — which is what the first run of this file produced for the King.
    const rise = name === 'low' ? cfg.lowRise : rise0;
    const d = cfg.dist * dm;
    const pitch = Math.asin(Math.max(-0.85, Math.min(0.9, rise * cfg.h / d)));
    await p.evaluate((a) => window.__gameDebug.setCamera(a.yaw, a.pitch, a.d),
      { yaw: orbitOf(rel), pitch, d });
    await p.waitForTimeout(560);
    const shot = await p.screenshot();
    const hid = await subScale(p, info.subjectId, 0.0004);
    // On the mounted shot the RIDER is a second entity and has to shrink too,
    // or the "empty plate" still contains a King and the diff reads near zero.
    if (cfg.mounted) await subScale(p, info.kingId, 0.0004);
    await p.waitForTimeout(240);
    const empty = await p.screenshot();
    await subScale(p, info.subjectId, 1);
    if (cfg.mounted) await subScale(p, info.kingId, 1);
    await p.waitForTimeout(140);
    if (hid !== 'ok') process.stdout.write(` [${hid}!]`);
    const cover = await coverage(shot, empty);
    pending.push([path.join(outDir, `${label}-${name}.png`), shot]);
    marks.push(`${name} ${(cover * 100).toFixed(1)}%${cover < MIN_COVER ? '!' : ''}`);
    log.push({ label, view: name, rel, d: +d.toFixed(1), cover: +cover.toFixed(4) });
  }
  console.log(` d=${cfg.dist.toFixed(1)}m  ${marks.join('  ')}`);
}

try {
  await shoot('king', {
    sp: 'evil_king', off: 9, h: KING_SIZE * 1.30, dist: 11, wings: false, mounted: false,
    lowRise: 0.12,
  });
  await shoot('dragon', {
    sp: 'black_dragon', off: 26, h: DRAGON_SIZE * 1.9, dist: 34, wings: true, mounted: false,
    lowRise: -0.10,
  });
  await shoot('dragon-furled', {
    sp: 'black_dragon', off: 22, h: DRAGON_SIZE * 1.9, dist: 26, wings: false, mounted: false,
    lowRise: -0.10,
  });
  await shoot('mounted', {
    sp: 'black_dragon', off: 30, h: DRAGON_SIZE * 1.9, dist: 38, wings: true, mounted: true,
    lowRise: -0.28, riderY: RIDER_Y, seatZ: SEAT_Z,
  });
} catch (err) {
  console.error('run failed:', err.message);
}

await browser.close();
for (const [f, buf] of pending) fs.writeFileSync(f, buf);
fs.writeFileSync(path.join(outDir, 'session.json'), JSON.stringify(log, null, 1), 'utf-8');

const weak = log.filter((l) => l.cover !== undefined && l.cover < MIN_COVER)
  .map((l) => `${l.label}-${l.view}`)
  .concat(log.filter((l) => l.failed !== undefined).map((l) => `${l.label} (FAILED)`));
console.log(`\n${pending.length} shots -> ${outDir}`);
if (weak.length) {
  console.log(`SUBJECT MISSING OR OCCLUDED in: ${weak.join(', ')}`);
  console.log('Do not read those shots as evidence of anything.');
}
