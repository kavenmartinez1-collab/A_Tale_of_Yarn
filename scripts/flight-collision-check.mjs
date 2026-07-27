/**
 * Can you fly a mount through the castle?
 *
 *   node scripts/flight-collision-check.mjs
 *
 * Above 4 m of altitude, mounted horizontal movement used to be a raw
 * `e.x += dx` with no collision query of any kind, and the only vertical rule
 * was the raw terrain heightfield — which knows nothing about the keep, the
 * curtain wall or the towers. So a dragon flew straight through Castle
 * Vhaeron.
 *
 * That altitude bypass is GONE. It existed because `slideXZ` never reads
 * `SolidBox.top`, which made every hut and haystack an infinitely tall prism —
 * routing flight through them would have stopped a dragon dead over every
 * village in the world. Settlement boxes are now read with the flier's own
 * altitude (settlement-collider.ts `flierMoveXZ` / `flierSupport`), so a wall
 * blocks at wall height and does nothing at all over its roofline.
 *
 * Every half is asserted here, because fixing one by breaking another is the
 * easy mistake:
 *
 *   - fly at the keep and you must NOT end up inside its masonry, measured
 *     against the castle's own solid volumes rather than by eye;
 *   - fly over open ground and you must be entirely unimpeded;
 *   - fly at a VILLAGE below the roofline and a wall must stop you;
 *   - fly at the same wall above it and you must sail over;
 *   - descend onto a roof and you must land on it, not sink into the street.
 *
 * The village beats are judged against `settlementSolidAt`, the collider's own
 * answer, and against the raw blocker boxes — not by looking at the screen.
 */
import { chromium } from 'playwright';

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 520 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 180)}`));

const findings = [];
const note = (severity, title, detail) => {
  findings.push({ severity, title, detail });
  process.stdout.write(`  ${severity === 'BUG' ? 'BUG ' : 'ok  '} ${title}\n`);
  if (detail) process.stdout.write(`       ${detail}\n`);
};

// Cut vite's HMR socket. Other agents edit this repo while harnesses run, and
// every save makes vite push a full-page reload — which restarts the world
// mid-flight and would score the beat against a fresh spawn.
await page.routeWebSocket(/:5173\//, () => { /* swallow HMR */ });

await page.goto('http://localhost:5173/game.html?director=off&tod=0.45&weather=clear',
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

const castle = await D(() => window.__gameDebug.castle());
const centre = await D(() => window.__gameDebug.castleMarkerPos('L1hall'));
process.stdout.write(`castle centre: ${centre.map((v) => v.toFixed(1)).join(', ')}\n`);

/**
 * Fly a mounted dragon on a heading for `secs`, holding Space to climb first.
 *
 * Drives the real key handlers, so this is the same code path a player's
 * W-and-Space is. Returns a trace of where the animal actually went.
 */
async function fly(startX, startZ, altitude, headingRad, secs) {
  // Put the player somewhere clear, then a dragon at their feet, and mount it.
  await D(([x, z]) => window.__gameDebug.teleport(x, z), [startX, startZ]);
  await page.waitForTimeout(1800);
  const p = await D(() => window.__gameDebug.playerPos());
  const id = await D(([q, alt]) => {
    const eid = window.__gameDebug.placeEntity('dragon', q[0], q[1] + alt, q[2]);
    return eid !== null && window.__gameDebug.mountEntity(eid) ? eid : null;
  }, [p, altitude]);
  if (id === null) return null;
  await page.waitForTimeout(300);

  // Face the heading, then hold W. Camera yaw drives mounted movement.
  await D((h) => window.__gameDebug.setCamera(h, 0.2, 8), headingRad);
  await page.keyboard.down('KeyW');
  const trace = [];
  const steps = Math.round(secs * 1000 / 120);
  for (let i = 0; i < steps; i++) {
    await page.waitForTimeout(120);
    const s = await D((eid) => {
      const e = window.__gameDebug.entities().find((k) => k.id === eid);
      const pl = window.__gameDebug.playerPos();
      return e ? { x: e.x, y: e.y, z: e.z, px: pl[0], py: pl[1], pz: pl[2] } : null;
    }, id);
    if (s !== null) trace.push(s);
  }
  await page.keyboard.up('KeyW');
  await D(() => window.__gameDebug.mounted() !== null && window.__gameDebug.leftClick());
  await page.keyboard.press('KeyE');   // dismount
  await page.waitForTimeout(300);
  await D((eid) => window.__gameDebug.killEntity(eid), id);
  await page.waitForTimeout(200);
  return trace;
}

/**
 * How deep inside castle masonry a point is, asked of the castle's own
 * collider rather than judged by eye. 0 means clear.
 */
async function insideCastle(pts, radius, height) {
  return D(([ps, r, h]) => ps.map((p) => {
    // Sample the body span the flier collider uses.
    const g = window.__gameDebug;
    return g.castleSolidAt(p[0], p[2], r, p[1], p[1] + h) ? 1 : 0;
  }), [pts, radius, height]);
}

// ---------------------------------------------------------------------------
process.stdout.write('\n=== 1. flying at the keep ===\n');
// ---------------------------------------------------------------------------
// Approach from four sides at courtyard/hall height, straight at the middle of
// the castle. Before the fix every one of these ended up inside the keep.
{
  for (const [name, deg, alt] of [
    ['from the south', 0, 12],
    ['from the north', 180, 12],
    ['from the east', 90, 20],
    ['from the west', 270, 20],
  ]) {
    const b = deg * Math.PI / 180;
    // Start 110 m out on that bearing.
    const sx = centre[0] + Math.sin(b) * 110;
    const sz = centre[2] + Math.cos(b) * 110;
    // Camera yaw that WALKS TOWARD the centre. Movement forward is
    // (-sin yaw, -cos yaw), so the heading is atan2(-(tx-px), -(tz-pz)) — the
    // sign that reads right walks you away, and the first run of this probe
    // flew two of the four approaches 300 m in the wrong direction.
    const a = Math.atan2(-(centre[0] - sx), -(centre[2] - sz));
    const trace = await fly(sx, sz, alt, a, 9);
    if (trace === null || trace.length === 0) {
      note('BUG', `${name}: could not fly`, 'placeEntity/mountEntity failed');
      continue;
    }
    const pts = trace.map((s) => [s.x, s.y, s.z]);
    const flags = await insideCastle(pts, 3.15, 5.2);   // dragon: size 3.5
    const inside = flags.reduce((n, v) => n + v, 0);
    const last = trace[trace.length - 1];
    const closed = Math.hypot(last.x - centre[0], last.z - centre[2]);
    // The rider must not be extruded either.
    const rpts = trace.map((s) => [s.px, s.py, s.pz]);
    const rflags = await insideCastle(rpts, 0.35, 1.7);
    const rIn = rflags.reduce((n, v) => n + v, 0);
    note(inside === 0 && rIn === 0 ? 'ok' : 'BUG', `${name}: stopped by the masonry`,
      `${trace.length} samples, ${inside} inside a solid, rider ${rIn} inside;`
      + ` closed to ${closed.toFixed(0)} m of the centre`);
  }
}

// ---------------------------------------------------------------------------
process.stdout.write('\n=== 2. open world flight is unimpeded ===\n');
// ---------------------------------------------------------------------------
// The regression that would matter most: routing flight through the settlement
// collider would stop a dragon dead over any village, because those blockers
// have no top. Fly a long straight line far from the castle and check the
// distance covered matches the mount's speed.
{
  const start = [244, -304];
  const trace = await fly(start[0], start[1], 30, 0, 8);
  if (trace === null || trace.length < 4) {
    note('BUG', 'open flight: could not fly', '');
  } else {
    const a = trace[0];
    const b = trace[trace.length - 1];
    const covered = Math.hypot(b.x - a.x, b.z - a.z);
    const secs = (trace.length - 1) * 0.12;
    const speed = covered / secs;
    // Dragon mountSpeed is 18 m/s; anything near it means nothing blocked.
    note(speed > 12 ? 'ok' : 'BUG', 'a flying mount crosses open ground freely',
      `${covered.toFixed(0)} m in ${secs.toFixed(1)} s = ${speed.toFixed(1)} m/s`
      + ' (dragon mountSpeed is 18)');
  }
}

// ---------------------------------------------------------------------------
process.stdout.write('\n=== 3. you can still fly over the castle ===\n');
// ---------------------------------------------------------------------------
// Being stopped by walls must not become a ceiling on the world. Well above
// the towers, the same approach has to sail straight over.
{
  const hz = centre[2] + 120;
  const trace = await fly(centre[0], hz, 70,
    Math.atan2(-(centre[0] - centre[0]), -(centre[2] - hz)), 9);
  if (trace === null || trace.length < 4) {
    note('BUG', 'high pass: could not fly', '');
  } else {
    const a = trace[0];
    const b = trace[trace.length - 1];
    const covered = Math.hypot(b.x - a.x, b.z - a.z);
    const pts = trace.map((s) => [s.x, s.y, s.z]);
    const flags = await insideCastle(pts, 3.15, 5.2);
    const inside = flags.reduce((n, v) => n + v, 0);
    const overCastle = trace.some((s) =>
      Math.hypot(s.x - centre[0], s.z - centre[2]) < 40);
    note(covered > 80 && inside === 0 ? 'ok' : 'BUG',
      'a high pass clears the towers',
      `covered ${covered.toFixed(0)} m, ${inside} samples inside a solid,`
      + ` passed over the castle: ${overCastle}`);
  }
}

// ---------------------------------------------------------------------------
process.stdout.write('\n=== 4. flying at a village ===\n');
// ---------------------------------------------------------------------------
// The half that did not exist before. A wall has to stop a flier at wall
// height and let it over at roof height, and a roof has to be somewhere you
// can put a dragon down. Everything is measured against the collider's own
// boxes: `settlementBlockers()` for the geometry, `settlementSolidAt` for the
// verdict.
{
  const site = await D(() => window.__gameDebug.teleportToNearestSettlement());
  await page.waitForTimeout(2500);
  // Biggest blocker within reach — a barn or a keep, not a haystack. Its own
  // box is the ground truth for every assertion below.
  const box = await D(() => {
    const bs = window.__gameDebug.settlementBlockers()
      .filter((b) => b.top - window.__gameDebug.heightAt(
        (b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2) > 3.5)
      .filter((b) => (b.x1 - b.x0) > 5 && (b.z1 - b.z0) > 5);
    if (bs.length === 0) return null;
    bs.sort((a, b) => b.top - a.top);
    const b = bs[0];
    return {
      x0: b.x0, z0: b.z0, x1: b.x1, z1: b.z1, top: b.top,
      cx: (b.x0 + b.x1) / 2, cz: (b.z0 + b.z1) / 2,
      ground: window.__gameDebug.heightAt((b.x0 + b.x1) / 2, (b.z0 + b.z1) / 2),
    };
  });
  if (box === null) {
    note('BUG', 'village: no building tall enough to test against',
      `settlement "${site}"`);
  } else {
    process.stdout.write(
      `  target building: ${(box.x1 - box.x0).toFixed(1)} x ${(box.z1 - box.z0).toFixed(1)} m,`
      + ` roof at y ${box.top.toFixed(1)}, ground ${box.ground.toFixed(1)}`
      + ` (${(box.top - box.ground).toFixed(1)} m tall)\n`);

    /** Fly straight at the building's centre from 45 m out at absolute `y`. */
    const runAt = async (absY, secs = 7) => {
      const sx = box.cx + 45;
      const sz = box.cz;
      const g0 = await D(([x, z]) => window.__gameDebug.heightAt(x, z), [sx, sz]);
      const a = Math.atan2(-(box.cx - sx), -(box.cz - sz));
      return { trace: await fly(sx, sz, absY - g0, a, secs), sx, sz };
    };

    // -- below the roofline: the wall stops you ----------------------------
    {
      const belowY = box.ground + (box.top - box.ground) * 0.55;
      const { trace, sx } = await runAt(belowY);
      if (trace === null || trace.length < 4) {
        note('BUG', 'village low pass: could not fly', '');
      } else {
        const flags = await D(([ps, r]) => ps.map((p) =>
          window.__gameDebug.settlementSolidAt(p[0], p[2], r, p[1]) ? 1 : 0),
        [trace.map((s) => [s.x, s.y, s.z]), 3.15]);
        const inside = flags.reduce((n, v) => n + v, 0);
        // Stopped means: never got past the near face by more than its own
        // radius, and never crossed to the far side of the box.
        const nearestX = Math.min(...trace.map((s) => s.x));
        const stopped = nearestX > box.x1 - 3.15;
        // ...and it did actually get there, or "stopped" is meaningless.
        const closed = sx - nearestX;
        note(inside === 0 && stopped && closed > 20 ? 'ok' : 'BUG',
          'below the roofline a wall stops a flier',
          `${trace.length} samples, ${inside} inside a solid;`
          + ` closed ${closed.toFixed(0)} m and halted at x ${nearestX.toFixed(1)}`
          + ` against a near face at ${box.x1.toFixed(1)}`);
      }
    }

    // -- above the roofline: the same wall does nothing --------------------
    {
      const { trace } = await runAt(box.top + 6);
      if (trace === null || trace.length < 4) {
        note('BUG', 'village high pass: could not fly', '');
      } else {
        const over = trace.filter((s) =>
          s.x > box.x0 && s.x < box.x1 && s.z > box.z0 && s.z < box.z1).length;
        const flags = await D(([ps, r]) => ps.map((p) =>
          window.__gameDebug.settlementSolidAt(p[0], p[2], r, p[1]) ? 1 : 0),
        [trace.map((s) => [s.x, s.y, s.z]), 3.15]);
        const inside = flags.reduce((n, v) => n + v, 0);
        const past = Math.min(...trace.map((s) => s.x)) < box.x0;
        note(over > 0 && past && inside === 0 ? 'ok' : 'BUG',
          'and above it the same wall does not',
          `${over} samples directly over the footprint, ${inside} inside a solid,`
          + ` crossed to the far side: ${past}`);
      }
    }

    // -- descend onto the roof --------------------------------------------
    {
      await D(([x, z]) => window.__gameDebug.teleport(x + 30, z), [box.cx, box.cz]);
      await page.waitForTimeout(1500);
      const id = await D(([x, y, z]) => {
        const eid = window.__gameDebug.placeEntity('dragon', x, y, z);
        return eid !== null && window.__gameDebug.mountEntity(eid) ? eid : null;
      }, [box.cx, box.top + 14, box.cz]);
      if (id === null) {
        note('BUG', 'roof landing: could not mount over the roof', '');
      } else {
        await page.waitForTimeout(400);
        await page.keyboard.down('KeyQ');           // descend
        await page.waitForTimeout(5000);
        await page.keyboard.up('KeyQ');
        await page.waitForTimeout(600);
        const rest = await D((eid) => {
          const e = window.__gameDebug.entities().find((k) => k.id === eid);
          const pl = window.__gameDebug.playerPos();
          return e ? { x: e.x, y: e.y, z: e.z, py: pl[1] } : null;
        }, id);
        const onRoof = rest !== null && Math.abs(rest.y - box.top) < 0.35;
        const notInStreet = rest !== null && rest.y > box.ground + 1;
        note(onRoof && notInStreet ? 'ok' : 'BUG',
          'a flier can land on a rooftop instead of sinking into it',
          rest === null ? 'mount vanished'
            : `settled at y ${rest.y.toFixed(2)} — roof ${box.top.toFixed(2)},`
              + ` street ${box.ground.toFixed(2)}; rider at ${rest.py.toFixed(2)}`);
        await D(() => window.__gameDebug.mounted() !== null && window.__gameDebug.leftClick());
        await page.keyboard.press('KeyE');
        await page.waitForTimeout(300);
        await D((eid) => window.__gameDebug.killEntity(eid), id);
      }
    }
  }
}

process.stdout.write('\n=== summary ===\n');
const bugs = findings.filter((f) => f.severity === 'BUG');
for (const e of errors.slice(0, 6)) process.stdout.write(`  page error: ${e}\n`);
process.stdout.write(`${bugs.length} bugs across ${findings.length} checks\n`);
await browser.close();
process.exit(bugs.length === 0 ? 0 : 1);
