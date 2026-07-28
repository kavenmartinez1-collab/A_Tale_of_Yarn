/**
 * Two "the world disagrees with itself" fixes, measured.
 *
 *   node scripts/shelter-check.mjs [baseUrl]
 *
 * 1. RAIN INDOORS. The castle is ordinary world geometry, not an interior
 *    arena, so nothing weather-driven ever asked whether there was a roof
 *    overhead: rain fell through three storeys of keep. The fix keys on
 *    `CastleCollider.isRoofed` — a CEILING test, not a "inside the castle
 *    bounds" test — so the courtyard, which is inside the walls and open to
 *    the sky, must stay wet. That beat is the one that catches the wrong fix.
 *
 * 2. CREATURES ON THE DRAWN GROUND. Entity ground contact read the RAW
 *    generated heightfield while the renderer draws the CARVED one (roads
 *    graded in, up to 2.5 m of cut and fill). Animals therefore stood on land
 *    that is not there any more. Measured as |entity.y - carvedGround| for
 *    every creature near a road, which is the error the player sees as feet
 *    sunk into the tarmac or floating above it.
 *
 * `__gameDebug.heightAt` is the RAW field and `groundHeightAt` is the CARVED
 * one. Using the wrong one here has produced false bug reports twice, so both
 * are read by name and both are printed.
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:5173';
const OUT = 'scripts/shots/shelter';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--enable-unsafe-webgpu', '--use-angle=d3d11'],
});
const page = await browser.newPage({ viewport: { width: 1000, height: 560 } });

const errors = [];
page.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message.slice(0, 180)}`));

const findings = [];
const note = (severity, title, detail) => {
  findings.push({ severity, title, detail });
  process.stdout.write(`  ${severity === 'BUG' ? 'BUG ' : 'ok  '} ${title}\n`);
  if (detail) process.stdout.write(`       ${detail}\n`);
};

await page.routeWebSocket(/:5173\//, () => { /* swallow HMR */ });
await page.goto(`${BASE}/game.html?director=off&tod=0.42&weather=rain`,
  { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__gameReady === true, undefined, { timeout: 90_000 });
await page.waitForTimeout(3000);

const D = async (fn, arg) => {
  const alive = await page.evaluate(() => typeof window.__gameDebug === 'object');
  if (!alive) {
    process.stdout.write('\n!! RUN INVALID — page reloaded mid-run\n');
    await browser.close();
    process.exit(2);
  }
  return page.evaluate(fn, arg);
};

// ===========================================================================
process.stdout.write('=== 1. does rain stop at the roof (and only at the roof)? ===\n');
// ===========================================================================
const markers = await D(() => window.__gameDebug.castleMarkers());

/**
 * Roofed state and the rain level actually being handed to the renderer.
 *
 * `rainLevel` is read from the frame uniform the game builds, not inferred
 * from a screenshot: "it looks drier" is not a number, and the rain overlay is
 * a full-screen shader whose visible density at a given intensity depends on
 * where the camera is pointing.
 */
const readAt = async (marker) => {
  await D((m) => window.__gameDebug.castleTeleport(m), marker);
  await page.waitForTimeout(1400);   // the shelter blend eases over ~0.16 s
  return D(() => ({
    roofed: window.__gameDebug.castleRoofedHere(),
    rain: window.__gameDebug.frameRainLevel(),
    shelter: window.__gameDebug.shelterLevel(),
    pos: window.__gameDebug.playerPos(),
  }));
};

// Indoors: a hall with three storeys over it. Outdoors-but-inside-the-walls:
// the courtyard / front court, which is open to the sky.
const indoorMarkers = ['throne', 'L1hall', 'undercroftStairFoot']
  .filter((m) => markers.includes(m));
const openMarkers = ['frontCourt', 'wallDeckE', 'keepRoof']
  .filter((m) => markers.includes(m));

for (const m of indoorMarkers) {
  const r = await readAt(m);
  note(r.roofed && r.rain < 0.05 ? 'ok' : 'BUG',
    `${m}: under a roof, no rain drawn`,
    `roofed=${r.roofed} shelter=${r.shelter.toFixed(2)} rainLevel=${r.rain.toFixed(3)}`);
  writeFileSync(`${OUT}/in-${m}.png`, await page.screenshot());
}
for (const m of openMarkers) {
  const r = await readAt(m);
  // The wrong fix — keying on "inside the castle" rather than "under a
  // ceiling" — passes every indoor beat above and fails here.
  note(!r.roofed && r.rain > 0.9 ? 'ok' : 'BUG',
    `${m}: open to the sky, still raining`,
    `roofed=${r.roofed} shelter=${r.shelter.toFixed(2)} rainLevel=${r.rain.toFixed(3)}`);
  writeFileSync(`${OUT}/out-${m}.png`, await page.screenshot());
}

// The transition must RAMP, not cut.
if (indoorMarkers.length > 0 && openMarkers.length > 0) {
  await D((m) => window.__gameDebug.castleTeleport(m), indoorMarkers[0]);
  await page.waitForTimeout(1500);
  const trace = await page.evaluate(async (m) => {
    const g = window.__gameDebug;
    g.castleTeleport(m);
    const out = [];
    for (let i = 0; i < 40; i++) {
      out.push(g.frameRainLevel());
      await new Promise((r) => requestAnimationFrame(r));
    }
    return out;
  }, openMarkers[0]);
  const jumps = trace.slice(1).map((v, i) => Math.abs(v - trace[i]));
  const worst = Math.max(...jumps);
  note(worst < 0.5 ? 'ok' : 'BUG',
    'stepping out of the keep RAMPS the rain rather than cutting it',
    `largest single-frame change ${worst.toFixed(3)}`
    + ` (${trace[0].toFixed(2)} -> ${trace[trace.length - 1].toFixed(2)})`);
}

// ===========================================================================
process.stdout.write('\n=== 2. do creatures stand on the ground that is drawn? ===\n');
// ===========================================================================
{
  // FIND THE CUTTING, do not hope to wander onto one.
  //
  // The first version teleported to a village and measured whatever wildlife
  // happened to be near: 27 creatures, none of them standing anywhere the
  // ground had been carved by more than a centimetre, so it proved nothing and
  // said so. A road cutting is exactly "carved minus raw", and both fields are
  // exposed by name, so the disagreement can simply be searched for.
  await D(() => window.__gameDebug.teleportToNearestSettlement('village'));
  await page.waitForTimeout(9000);

  const spot = await D(() => {
    const g = window.__gameDebug;
    const p = g.playerPos();
    let best = null;
    for (let dx = -260; dx <= 260; dx += 4) {
      for (let dz = -260; dz <= 260; dz += 4) {
        const x = p[0] + dx;
        const z = p[2] + dz;
        const carved = g.groundHeightAt(x, z);
        if (carved < 1) continue;                       // not in the sea
        const carve = Math.abs(carved - g.heightAt(x, z));
        if (best === null || carve > best.carve) best = { x, z, carve, carved };
      }
    }
    return best;
  });
  process.stdout.write(`       deepest carve found nearby: ${spot.carve.toFixed(2)} m`
    + ` at ${spot.x.toFixed(0)}, ${spot.z.toFixed(0)}\n`);

  if (spot.carve < 0.3) {
    note('BUG', 'no road cutting deep enough to measure against near this village',
      `worst |carved - raw| ${spot.carve.toFixed(2)} m`);
  } else {
    await D(([x, z]) => window.__gameDebug.teleport(x, z), [spot.x, spot.z]);
    await page.waitForTimeout(6000);

    // Put creatures ON the cutting and let their own tick decide where their
    // feet go. Placement is at the RAW height on purpose — that is where the
    // old code would have left them, so anything that moves them onto the
    // carved surface is the tick doing its job rather than the probe's setup.
    const ids = await D(([x, z]) => {
      const g = window.__gameDebug;
      const out = [];
      for (let i = 0; i < 5; i++) {
        const ox = x + (i - 2) * 1.5;
        const id = g.placeEntity('deer', ox, g.heightAt(ox, z), z);
        if (id !== null) { g.holdEntity(id, true); out.push(id); }
      }
      return out;
    }, [spot.x, spot.z]);
    await page.waitForTimeout(2500);   // several ticks of ground contact

    const rows = await D((eids) => {
      const g = window.__gameDebug;
      return eids.map((id) => {
        const e = g.entities().find((q) => q.id === id);
        if (e === undefined) return null;
        return {
          y: e.y,
          carved: g.groundHeightAt(e.x, e.z),
          raw: g.heightAt(e.x, e.z),
        };
      }).filter((r) => r !== null);
    }, ids);
    await D((eids) => { for (const id of eids) window.__gameDebug.removeEntity(id); }, ids);

    if (rows.length === 0) {
      note('BUG', 'could not place creatures on the cutting');
    } else {
      const offCarved = rows.map((r) => Math.abs(r.y - r.carved));
      const offRaw = rows.map((r) => Math.abs(r.y - r.raw));
      const worstCarved = Math.max(...offCarved);
      const worstRaw = Math.max(...offRaw);
      const carve = Math.max(...rows.map((r) => Math.abs(r.carved - r.raw)));
      note(worstCarved < 0.2 && worstRaw > worstCarved ? 'ok' : 'BUG',
        'creatures settle onto the CARVED surface, the one the renderer draws',
        `${rows.length} deer on a ${carve.toFixed(2)} m cutting:`
        + ` worst |y - carved| ${worstCarved.toFixed(3)} m,`
        + ` worst |y - RAW| ${worstRaw.toFixed(3)} m`
        + ` (before the fix those two would be the other way round)`);
    }
  }
}

// ===========================================================================
process.stdout.write('\n=== 3. is a pitched tent a place you can actually be? ===\n');
// ===========================================================================
//
// "We can build tents but the character can't go inside." Three things were
// true and only one of them was a missing feature:
//
//   - A tent granted WARMTH by proximity and nothing else. Rain fell straight
//     through the canvas, because `stepShelter` only ever asked the castle.
//   - The small tents are 2.4 m across and 1.7 m at the ridge. There is barely
//     an inside to be in.
//   - Placement puts objects a fixed 2.5 m ahead of the camera, which from
//     inside a 2.4 m tent is always OUTSIDE it. Nothing rejected building in a
//     tent; the arithmetic just never let you.
//
// So: tents feed the same eased `shelter` value the castle does, the loom
// weaves a walk-in tent with a floor, and reach shortens indoors. All three are
// measured here on `frameRainLevel` — the number handed to the renderer — with
// an open-ground control beside each tent so a pass cannot come from the fix
// keying on proximity instead of on the volume.
{
  // FIND DRY, FLAT LAND — do not hope to land on some.
  //
  // The first version pitched at the spawn point and 40 m east of it, and 40 m
  // east of spawn is the sea: the walk-in tent was placed at y = -4.2 while the
  // player floated at -0.8, so "not sheltered" was the correct answer to a
  // question about a tent on the seabed. Two beats failed for a reason that had
  // nothing to do with tents. Same discipline as §2 — search for the site.
  await D(() => window.__gameDebug.teleportToNearestSettlement('village'));
  await page.waitForTimeout(9000);

  const site = await D(() => {
    const g = window.__gameDebug;
    const p = g.playerPos();
    const flatness = (x, z) => Math.max(
      Math.abs(g.groundHeightAt(x, z) - g.groundHeightAt(x + 3, z)),
      Math.abs(g.groundHeightAt(x, z) - g.groundHeightAt(x - 3, z)),
      Math.abs(g.groundHeightAt(x, z) - g.groundHeightAt(x, z + 3)),
      Math.abs(g.groundHeightAt(x, z) - g.groundHeightAt(x, z - 3)));
    let best = null;
    for (let dx = -150; dx <= 150; dx += 10) {
      for (let dz = -150; dz <= 150; dz += 10) {
        const x = Math.round(p[0] + dx);
        const z = Math.round(p[2] + dz);
        // Both the tent site and its 40 m neighbour must be dry and level, and
        // so must the control point between them.
        const hs = [[x, z], [x + 40, z], [x + 20, z + 20]]
          .map(([a, b]) => g.groundHeightAt(a, b));
        if (hs.some((h) => h < 3)) continue;
        const flat = Math.max(flatness(x, z), flatness(x + 40, z));
        if (best === null || flat < best.flat) best = { x, z, flat, h: hs[0] };
      }
    }
    return best;
  });

  if (site === null) {
    note('BUG', 'no dry level ground near this village to pitch a tent on',
      'the tent beats below would prove nothing');
  }
  await D(([x, z]) => window.__gameDebug.teleport(x, z), [site.x, site.z]);
  await page.waitForTimeout(3000);
  process.stdout.write(`       camp site ${site.x}, ${site.z}`
    + ` (ground ${site.h.toFixed(1)} m, worst slope ${site.flat.toFixed(2)} m/3 m)\n`);

  /** Stand at (x,z), let the blend settle, and read what is being drawn. */
  const standAt = async (x, z) => {
    await D(([px, pz]) => window.__gameDebug.teleport(px, pz), [x, z]);
    await page.waitForTimeout(1400);   // ~0.16 s ease, with slack
    return D(() => ({
      rain: window.__gameDebug.frameRainLevel(),
      shelter: window.__gameDebug.shelterLevel(),
      tent: window.__gameDebug.tentRoofedHere(),
      tier: window.__gameDebug.shelterTierHere(),
      temp: window.__gameDebug.vitals().temperature,
      pos: window.__gameDebug.playerPos(),
    }));
  };

  const base = await D(() => window.__gameDebug.playerPos());
  const bx = Math.round(base[0]);
  const bz = Math.round(base[2]);

  // Two tents 40 m apart so neither can shelter the other's control point.
  const placed = await D(([x, z]) => {
    const g = window.__gameDebug;
    return {
      small: g.placeTent(x, z, 3, 'small'),
      walkin: g.placeTent(x + 40, z, 3, 'walkin'),
    };
  }, [bx, bz]);
  note(typeof placed.small === 'string' && typeof placed.walkin === 'string'
    ? 'ok' : 'BUG', 'a small tent and a canvas tent pitch',
    `${placed.small} / ${placed.walkin}`);

  // --- The control: open ground, 12 m from either tent --------------------
  const open = await standAt(bx + 20, bz + 20);
  note(open.rain > 0.9 && !open.tent ? 'ok' : 'BUG',
    'open ground beside the camp stays wet (the control)',
    `rainLevel=${open.rain.toFixed(3)} shelter=${open.shelter.toFixed(2)}`
    + ` tentRoofed=${open.tent}`);

  // --- Beside the tent, but not under it ----------------------------------
  //
  // 2.0 m from the small tent's centre: inside the 3 m WARMTH radius, outside
  // the 1.2 m canvas. This is the beat that fails if the fix keyed on
  // proximity, which would have dried out a 6 m circle of open field.
  const beside = await standAt(bx + 2.0, bz);
  note(beside.rain > 0.9 && !beside.tent ? 'ok' : 'BUG',
    'standing BESIDE the tent is still standing in the rain',
    `2.0 m from the ridge: rainLevel=${beside.rain.toFixed(3)}`
    + ` tentRoofed=${beside.tent} (warmth radius is 3 m, canvas is 1.2 m)`);
  writeFileSync(`${OUT}/tent-beside.png`, await page.screenshot());

  // --- Under the small tent ------------------------------------------------
  const inSmall = await standAt(bx, bz);
  note(inSmall.tent && inSmall.rain < 0.05 ? 'ok' : 'BUG',
    'stepping under the small tent stops the rain',
    `rainLevel ${beside.rain.toFixed(3)} -> ${inSmall.rain.toFixed(3)},`
    + ` shelter=${inSmall.shelter.toFixed(2)} tentRoofed=${inSmall.tent}`);

  // --- Under the walk-in ---------------------------------------------------
  const inWalkin = await standAt(bx + 40, bz);
  note(inWalkin.tent && inWalkin.rain < 0.05 ? 'ok' : 'BUG',
    'the canvas tent shelters its whole floor',
    `rainLevel=${inWalkin.rain.toFixed(3)} shelter=${inWalkin.shelter.toFixed(2)}`);
  // A walk-in you cannot walk about in is not one. 1.4 m off-centre is still
  // inside its 2.2 m half-width and well outside the small tent's.
  const walkinEdge = await standAt(bx + 40 + 1.4, bz);
  note(walkinEdge.tent && walkinEdge.rain < 0.05 ? 'ok' : 'BUG',
    'and you can move about inside it without stepping into the weather',
    `1.4 m off centre: rainLevel=${walkinEdge.rain.toFixed(3)}`
    + ` (a small tent's canvas ends at 1.2 m)`);
  writeFileSync(`${OUT}/tent-inside.png`, await page.screenshot());

  // --- Warmth is still proximity, and still works -------------------------
  //
  // Measured at the INPUT to the warmth model, not at the world temperature.
  // World temperature is a clamped sum of biome, altitude, night and swimming,
  // and in a temperate village at midday it is 0.00 both inside and outside a
  // tent — a warmth bonus has nothing to lift. Reading `shelterTierHere` says
  // what the tent is actually contributing (vitals.ts TENT_WARMTH: 0, 0.5,
  // 0.8, 1.1) and cannot be washed out by the weather being pleasant.
  note(open.tier === 0 && inWalkin.tier === 3 ? 'ok' : 'BUG',
    'the tent feeds the warmth model, and only from inside its radius',
    `shelter tier ${open.tier} in the open -> ${inWalkin.tier} at the tent`
    + ` (warmth 0 -> 1.1); temperature ${open.temp.toFixed(2)} -> ${inWalkin.temp.toFixed(2)}`
    + ` — both 0.00 here means the biome is mild, not that the tent is inert`);
  note(beside.tier === 3 ? 'ok' : 'BUG',
    'and warmth stays PROXIMITY while the roof is VOLUME — the two differ',
    `2.0 m from the ridge: warmth tier ${beside.tier}, roofed ${beside.tent}`
    + ` (this is the pair that makes them separate tests)`);

  // --- The ramp, again: canvas must fade like masonry ---------------------
  {
    await D(([x, z]) => window.__gameDebug.teleport(x, z), [bx + 40, bz]);
    await page.waitForTimeout(1500);
    const trace = await page.evaluate(async ([x, z]) => {
      const g = window.__gameDebug;
      g.teleport(x, z);
      const out = [];
      for (let i = 0; i < 40; i++) {
        out.push(g.frameRainLevel());
        await new Promise((r) => requestAnimationFrame(r));
      }
      return out;
    }, [bx + 60, bz]);
    const jumps = trace.slice(1).map((v, i) => Math.abs(v - trace[i]));
    const worst = Math.max(...jumps);
    note(worst < 0.5 ? 'ok' : 'BUG',
      'stepping out of the tent RAMPS the rain rather than cutting it',
      `largest single-frame change ${worst.toFixed(3)}`
      + ` (${trace[0].toFixed(2)} -> ${trace[trace.length - 1].toFixed(2)})`);
  }

  // --- Building INSIDE the tent -------------------------------------------
  //
  // The user's explicit call: "we should be able to craft anything we want and
  // place it inside tents." Driven through the real left-click path, not the
  // debug placer — `placeFire` bypasses `placementTarget()` entirely, and
  // `placementTarget()` is the thing that was broken.
  {
    await D(([x, z]) => {
      const g = window.__gameDebug;
      g.teleport(x, z);
      g.giveItem('campfire_kit', 2);
      g.giveItem('logs', 4);
      g.giveItem('fire_starter', 1);
      g.equipItem('campfire_kit');
    }, [bx + 40, bz]);
    await page.waitForTimeout(1200);

    const before = await D(() => window.__gameDebug.fires().length);
    // `leftClick()` IS resolveLeftClick — the same function the mouse calls, so
    // this goes through the placeable dispatch and through `placementTarget()`,
    // which is the code that was broken. A real `page.mouse.click` cannot be
    // used: headless Chrome will not grant pointer lock, so the click lands on
    // the click-to-play overlay and never reaches the game.
    //
    // Repeated, because resolveLeftClick's FIRST gate is `attackT < 1` — a
    // swing still recovering swallows the call and returns, and a single click
    // that happens to land during a recovery reads as "placement is broken".
    for (let i = 0; i < 6; i++) {
      const n = await D(() => {
        window.__gameDebug.leftClick();
        return window.__gameDebug.fires().length;
      });
      if (n > before) break;
      await page.waitForTimeout(450);
    }
    await page.waitForTimeout(600);

    const after = await D(() => {
      const g = window.__gameDebug;
      const fires = g.fires();
      const tents = g.tents();
      const t = tents.find((q) => q.shape === 'walkin');
      const f = fires[fires.length - 1];
      return {
        count: fires.length,
        inside: t !== undefined && f !== undefined
          && Math.abs(f.x - t.x) <= 2.2 && Math.abs(f.z - t.z) <= 1.7,
        d: t !== undefined && f !== undefined
          ? Math.hypot(f.x - t.x, f.z - t.z) : -1,
      };
    });
    note(after.count > before && after.inside ? 'ok' : 'BUG',
      'a campfire placed from inside the canvas tent lands INSIDE it',
      `${before} -> ${after.count} fires, ${after.d.toFixed(2)} m from the tent centre`
      + ` (half-extents 2.2 x 1.7; reach outdoors is 2.5 m, which never fitted)`);

    // And it lights, warms and counts as a crafting station in there.
    const lit = await D(() => {
      const g = window.__gameDebug;
      const fires = g.fires();
      if (fires.length === 0) return null;
      const f = fires[fires.length - 1];
      g.teleport(f.x, f.z);
      return f;
    });
    await page.waitForTimeout(600);
    // Ignition is a LEFT CLICK holding a fire_starter, not the E key — E is
    // the campfire→forge upgrade. `tryIgniteFire` costs 1 log and needs the
    // fire within GATHER_REACH (2.5 m); the player was just teleported onto it.
    await D(() => { window.__gameDebug.equipItem('fire_starter'); });
    await page.waitForTimeout(400);
    for (let i = 0; i < 6; i++) {
      const fuel = await D(() => {
        window.__gameDebug.leftClick();
        return Math.max(0, ...window.__gameDebug.fires().map((f) => f.fuelS));
      });
      if (fuel > 0) break;
      await page.waitForTimeout(450);
    }
    await page.waitForTimeout(800);
    const station = await D(() => ({
      near: window.__gameDebug.nearCampfire(),
      roofed: window.__gameDebug.tentRoofedHere(),
      rain: window.__gameDebug.frameRainLevel(),
      fires: window.__gameDebug.fires().map((f) => f.fuelS),
    }));
    note(lit !== null && station.roofed ? 'ok' : 'BUG',
      'and standing at that hearth you are still under canvas',
      `tentRoofed=${station.roofed} rainLevel=${station.rain.toFixed(3)}`
      + (lit === null ? ' (no fire to stand at)'
        : ` at ${lit.x.toFixed(1)}, ${lit.z.toFixed(1)}`));
    note(station.near ? 'ok' : 'BUG',
      'a lit fire inside the tent is a crafting station like any other',
      `nearCampfire=${station.near} fuel=${JSON.stringify(station.fires)}`);
    writeFileSync(`${OUT}/tent-fire-inside.png`, await page.screenshot());
  }

  // --- The loom, the tier-3 station ---------------------------------------
  {
    const loomId = await D(([x, z]) => window.__gameDebug.placeLoom(x + 1, z, 0), [bx + 40, bz]);
    await page.waitForTimeout(800);
    const near = await D(() => ({
      near: window.__gameDebug.nearLoomDebug(),
      looms: window.__gameDebug.looms().length,
    }));
    note(typeof loomId === 'string' && near.near ? 'ok' : 'BUG',
      'a loom placed inside the tent is reachable as a station',
      `id=${loomId} nearLoom=${near.near} looms=${near.looms}`);
    writeFileSync(`${OUT}/tent-loom-inside.png`, await page.screenshot());
  }
}

const bugs = findings.filter((f) => f.severity === 'BUG');
process.stdout.write(`\n${bugs.length} bug(s), ${findings.length - bugs.length} ok\n`);
if (errors.length) process.stdout.write(`page errors: ${errors.slice(0, 4).join(' | ')}\n`);
await browser.close();
process.exit(bugs.length > 0 ? 1 : 0);
